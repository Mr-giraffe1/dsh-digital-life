/**
 * Opening her mouth without being asked.
 *
 * Ladders, gates and a breaker — in that order, and all of them before the
 * model is called, so an empty room costs nothing. The gate order matters:
 * sleeping first (cheapest), then whether anyone is waiting, then quota, then
 * the cooldown. Only the last three can be reached while she is awake.
 *
 * ARCHITECTURE §5.6: desktop is reversible and hers, so it needs no approval.
 * A channel marked `irreversible` (B 站公开) must instead land in `draft` and
 * wait — that path is wired but has no channel yet.
 */

import { buildSystem } from './persona.js'
import { guardVoice, styleCheck } from './voice.js'
import { generate } from './generate.js'

/** Extra instruction appended only for spontaneous turns. */
const SPONTANEOUS = `
## 这一次不是舅舅在跟你说话
你自己想跟他说句话。不要问"在吗"，不要问候天气。就说一件此刻你脑子里的事——
刚才想到的画、还没说完的舞、你觉得他可能会在意的小事。一两句就够。`

/**
 * Her initiative.
 */
export class Outreach {
  /**
   * @param {object} options - wiring.
   * @param {import('./memory.js').Memory} options.memory - open memory.
   * @param {import('./store.js').LifeStore} options.store - portrait reader.
   * @param {import('./life.js').Life} options.life - quota and period.
   * @param {{ outreach: object }} options.policy - portrait policy.
   * @param {() => object | undefined} options.getLlm - lazy `llm` service.
   * @param {string | null} [options.provider] - model route.
   * @param {string | null} [options.model] - model id.
   */
  constructor({ memory, store, life, policy, getLlm, provider = null, model = null }) {
    this.memory = memory
    this.store = store
    this.life = life
    this.policy = policy
    this.getLlm = getLlm
    this.provider = provider
    this.model = model
  }

  /**
   * Should she speak right now, and if not, why not?
   *
   * @param {Date} [now] - the instant.
   * @returns {{ go: boolean, reason: string, period?: string, left?: number }}
   */
  shouldSpeak(now = new Date()) {
    const outreach = this.policy?.outreach ?? {}
    const period = this.life.period(now)
    if (period !== 'awake') return { go: false, reason: `她在睡（${period}）`, period }

    const allowed = Array.isArray(outreach.channelsAllowed) ? outreach.channelsAllowed : ['desktop']
    if (!allowed.includes('desktop')) return { go: false, reason: '桌面通道没被允许主动开口', period }

    if (this.memory.todoPending() > 0) return { go: false, reason: '有待办在等她', period }

    const quota = this.life.quota(now)
    if (quota.left <= 0) return { go: false, reason: `今天的主动开口用完了（${quota.used}/${quota.cap}）`, period, left: 0 }

    const intervalMs = Number(outreach.proactiveIntervalMinutes ?? 45) * 60_000
    const last = this.lastSpokeAt()
    if (last !== null && now.getTime() - last < intervalMs) {
      const waitMin = Math.ceil((intervalMs - (now.getTime() - last)) / 60_000)
      return { go: false, reason: `刚说过话，还要等 ${waitMin} 分钟`, period, left: quota.left }
    }

    if (this.ignoreStreak() >= Number(outreach.ignoreStreakToStop ?? 2)) {
      return { go: false, reason: '她主动说了几次都没人理，今天先不说了', period }
    }
    return { go: true, reason: '想说话了', period, left: quota.left }
  }

  /** Timestamp of her last proactive line, or null. */
  lastSpokeAt() {
    const row = this.memory.db.prepare(`SELECT epoch_ms FROM event
      WHERE kind = 'proactive' AND direction = 'out' ORDER BY id DESC LIMIT 1`).get()
    return row === undefined ? null : Number(row.epoch_ms)
  }

  /**
   * How many proactive lines in a row went unanswered. An "unanswered" line is
   * one with no inbound event after it since it was sent.
   */
  ignoreStreak() {
    const outbound = this.memory.db.prepare(`SELECT epoch_ms FROM event
      WHERE kind = 'proactive' AND direction = 'out' ORDER BY id DESC LIMIT 6`).all()
    let streak = 0
    for (const row of outbound) {
      const reply = this.memory.db.prepare(`SELECT COUNT(*) AS n FROM event
        WHERE direction = 'in' AND epoch_ms > ?`).get(Number(row.epoch_ms))
      if (Number(reply?.n ?? 0) > 0) break
      streak += 1
    }
    return streak
  }

  /**
   * Draft one spontaneous line. Nothing is written unless the guard is happy.
   *
   * @param {object} [options] - overrides.
   * @param {Date} [options.now] - the instant.
   * @returns {Promise<{ ok: boolean, spoke?: boolean, text?: string, reason?: string, flags?: string[], error?: string }>}
   */
  async maybeSpeak(options = {}) {
    const now = options.now ?? new Date()
    const gate = this.shouldSpeak(now)
    if (!gate.go) return { ok: true, spoke: false, reason: gate.reason }

    const llm = this.getLlm()
    if (llm === undefined || llm === null || typeof llm.stream !== 'function') {
      return { ok: false, error: '这个组合里没有 llm 服务' }
    }
    const route = this.provider !== null && this.model !== null
      ? { provider: this.provider, model: this.model }
      : await this.resolveRoute(llm)
    if (route === null) return { ok: false, error: '没有可用的模型提供方' }

    const soul = await this.store.readSoul()
    const voiceMd = await this.store.readVoice()
    const recalled = this.memory.recall(this.wakeWord(), { limit: 5 })
    const recent = this.memory.recent(6)
    const system = `${buildSystem({
      soul,
      voiceMd,
      recalled,
      recent,
      period: gate.period,
      now,
      channel: 'desktop'
    })}\n${SPONTANEOUS}`

    let raw = ''
    const produced = await generate({
      llm,
      provider: route.provider,
      model: route.model,
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: '（她这边没人说话）' }] }],
      temperature: 1,
      maxTokens: 160,
      reasoningEffort: 'off'
    })
    if (produced.ok !== true) return { ok: false, error: produced.error }
    raw = produced.text

    const guarded = guardVoice(raw, { maxChars: 70, maxSentences: 2, maxSentenceChars: 25 })
    if (!guarded.ok) return { ok: false, error: '她说不出话（模型返回空）' }

    this.memory.addEvent({
      at: now.toISOString(),
      domain: 'fact',
      kind: 'proactive',
      direction: 'out',
      channel: 'desktop',
      actorUid: 'self',
      text: guarded.text,
      importance: 0.5,
      payload: {
        spontaneous: true,
        flags: guarded.flags,
        styleFlags: styleCheck(guarded.text).reasons,
        raw: raw.slice(0, 2000),
        provider: route.provider,
        model: route.model
      }
    })
    this.life.spend(now)
    return { ok: true, spoke: true, text: guarded.text, flags: guarded.flags }
  }

  /** Words to search memory with when nothing was said to her. */
  wakeWord() {
    const recent = this.memory.recent(4)
    const last = [...recent].reverse().find((row) => typeof row.text === 'string' && row.text !== '')
    return last?.text ?? '画画 跳舞'
  }

  /** Fall back to whatever route the portrait declares, else the first one. */
  async resolveRoute(llm) {
    const portrait = await this.store.readLlmConfig()
    if (typeof portrait?.provider === 'string' && typeof portrait?.model === 'string') {
      return { provider: portrait.provider, model: portrait.model }
    }
    let providers = []
    try {
      providers = typeof llm.listProviders === 'function' ? llm.listProviders() : []
    } catch {
      providers = []
    }
    const first = Array.isArray(providers) ? providers[0] : undefined
    if (typeof first?.id !== 'string') return null
    return { provider: first.id, model: 'deepseek-flash' }
  }
}
