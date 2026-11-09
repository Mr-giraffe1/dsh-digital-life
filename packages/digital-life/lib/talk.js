/**
 * One conversational turn: what she hears, what she remembers, what she says.
 *
 * Order matters. The reply is guarded BEFORE it is persisted or shown, so the
 * panel can never display something the guard would have rejected — a token
 * stream straight to the browser would bypass exactly that.
 */

import { buildSystem, buildUserMessage } from './persona.js'
import { guardVoice, styleCheck } from './voice.js'
import { generate } from './generate.js'

/**
 * Her speaking apparatus.
 */
export class Talk {
  /**
   * @param {object} options - wiring.
   * @param {import('./memory.js').Memory} options.memory - open memory.
   * @param {import('./store.js').LifeStore} options.store - portrait reader.
   * @param {() => object | undefined} options.getLlm - resolves the `llm` service lazily.
   * @param {object} [options.config] - plugin config (fallback provider/model).
   */
  constructor({ memory, store, getLlm, config }) {
    this.memory = memory
    this.store = store
    this.getLlm = getLlm
    this.config = config ?? {}
    this.lastTurn = null
  }

  /**
   * Which provider/model to call: portrait, then plugin config, then the first
   * registered route.
   *
   * @returns {Promise<{ ok: boolean, provider?: string, model?: string, reason?: string }>}
   */
  async resolveModel() {
    const llm = this.getLlm()
    if (llm === undefined || llm === null || typeof llm.stream !== 'function') {
      return { ok: false, reason: '这个组合里没有 llm 服务（缺 @deepseek-ai/dsh-llm）' }
    }
    const portrait = await this.store.readLlmConfig()
    const configured = {
      provider: portrait?.provider ?? this.config.provider,
      model: portrait?.model ?? this.config.model
    }
    if (typeof configured.provider === 'string' && typeof configured.model === 'string') {
      return { ok: true, provider: configured.provider, model: configured.model }
    }
    let providers = []
    try {
      providers = typeof llm.listProviders === 'function' ? llm.listProviders() : []
    } catch {
      providers = []
    }
    const first = Array.isArray(providers) ? providers[0] : undefined
    const providerId = first?.id
    if (typeof providerId !== 'string') {
      return { ok: false, reason: '没有可用的模型提供方' }
    }
    return { ok: true, provider: providerId, model: configured.model ?? 'deepseek-flash' }
  }

  /**
   * Run one turn.
   *
   * @param {object} input - the turn.
   * @param {string} input.text - what was said to her.
   * @param {string} [input.channel] - 'desktop' | 'qq' | 'bilibili'.
   * @param {string} [input.actorUid] - internal uid of the speaker.
   * @param {string} [input.period] - 'awake' | 'quiet' | 'late'.
   * @returns {Promise<{ ok: boolean, reply?: string, recalled?: object[], flags?: string[], error?: string, ms?: number }>}
   */
  async say({ text, channel = 'desktop', actorUid = 'uncle', period = 'awake' }) {
    const started = Date.now()
    const said = String(text ?? '').trim()
    if (said === '') return { ok: false, error: '她没听见任何话' }
    if (this.memory.db === null) return { ok: false, error: '记忆还没打开' }

    const model = await this.resolveModel()
    if (!model.ok) return { ok: false, error: model.reason }

    const soul = await this.store.readSoul()
    const voiceMd = await this.store.readVoice()
    const recalled = this.memory.recall(said, { limit: 8 })
    const recent = this.memory.recent(8)
    const system = buildSystem({ soul, voiceMd, recalled, recent, period, now: new Date(), channel })

    this.memory.addEvent({
      domain: 'fact',
      kind: 'message',
      direction: 'in',
      text: said,
      channel,
      actorUid,
      importance: 0.6,
      payload: { provider: model.provider, model: model.model }
    })

    const llm = this.getLlm()
    const produced = await generate({
      llm,
      provider: model.provider,
      model: model.model,
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: buildUserMessage(said, soul?.relation?.address ?? '舅舅') }] }],
      temperature: 0.9,
      maxTokens: 220,
      reasoningEffort: 'off'
    })
    if (produced.ok !== true) {
      return { ok: false, error: produced.error, ms: Date.now() - started }
    }
    const raw = produced.text

    const guarded = guardVoice(raw, { maxChars: 90, maxSentences: 3, maxSentenceChars: 25 })
    if (!guarded.ok) {
      return { ok: false, error: '她说不出话（模型返回空）', ms: Date.now() - started }
    }
    const style = styleCheck(guarded.text)

    this.memory.addEvent({
      domain: 'fact',
      kind: 'say',
      direction: 'out',
      text: guarded.text,
      channel,
      actorUid: 'self',
      importance: 0.6,
      payload: {
        flags: guarded.flags,
        refused: guarded.refused,
        styleFlags: style.reasons,
        raw: raw.slice(0, 2000),
        provider: model.provider,
        model: model.model
      }
    })

    this.lastTurn = {
      at: new Date().toISOString(),
      provider: model.provider,
      model: model.model,
      recalled: recalled.map((item) => item.id),
      flags: guarded.flags,
      ms: Date.now() - started
    }

    return {
      ok: true,
      reply: guarded.text,
      recalled: recalled.map((item) => ({ id: item.id, at: item.at, text: item.text, domain: item.domain, score: Number(item.score.toFixed(4)) })),
      flags: guarded.flags,
      refused: guarded.refused,
      ms: this.lastTurn.ms
    }
  }
}
