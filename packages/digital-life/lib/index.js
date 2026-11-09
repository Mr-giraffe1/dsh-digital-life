/**
 * Host half of dsh-digital-life.
 *
 * She lives here, in the node process: the studio panel is a window onto this,
 * not her body. Everything in this file keeps working with the panel closed.
 *
 * Verified DSH contracts this file relies on:
 *  - a plugin row exports `name` / `inject` / `apply(ctx, config)`;
 *  - `ctx.webServer.register({ kind: 'exact'|'prefix', path, handler })` returns
 *    a disposer and is owned by `ctx.effect`;
 *  - `ctx.effect(() => disposer, label)` ties cleanup to the plugin lifetime.
 */

import { hostname } from 'node:os'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { isAbsolutePath, isInside, machineName, resolveRoots } from './paths.js'
import { LifeStore } from './store.js'
import * as instanceLock from './lock.js'
import { SCHEMA_VERSION } from './schema.js'
import { Memory } from './memory.js'
import { Talk } from './talk.js'
import { Life } from './life.js'
import { Feed, readDeepSeekToppedUp } from './feed.js'
import { localDayOf, minuteOfDay, parseClock, periodOf } from './clock.js'
import { buildArchive, importArchive, replayPendingImport } from './exchange.js'
import { Outreach } from './outreach.js'
import { QqChannel } from './qq.js'
import { birthdayStatus as lunarBirthday } from './lunar.js'

/** Route table, all loopback-only. No inbound port is opened beyond DSH's own. */
const ROUTE_STATE = '/digital-life/state.json'
const ROUTE_STREAM = '/digital-life/stream'
const ROUTE_ACTION = '/digital-life/action'
const ROUTE_TRANSCRIPT = '/digital-life/transcript.json'
const ROUTE_EXPORT = '/digital-life/export.dshlife'
const ROUTE_DOCTOR = '/digital-life/doctor.json'
const ROUTE_QQ_EVENT = '/digital-life/qq/event'

/** Request bodies for these actions are tiny; anything larger is hostile. */
const MAX_BODY_BYTES = 64 * 1024

/** Is `node:sqlite` usable in this host? Probed once; reported in the snapshot. */
function probeSqlite() {
  try {
    const require = createRequire(import.meta.url)
    const sqlite = require('node:sqlite')
    return typeof sqlite?.DatabaseSync === 'function'
  } catch {
    return false
  }
}

/** Write one JSON response. */
function sendJson(res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

/** Read a bounded JSON body; null past the ceiling or on a parse failure. */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.byteLength
    if (size > MAX_BODY_BYTES) {
      req.resume()
      return null
    }
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks, size).toString('utf8')
  if (text.trim() === '') return {}
  try {
    const parsed = JSON.parse(text)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** Is the TCP peer loopback? */
function isLoopback(req) {
  const address = req.socket?.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/**
 * Cross-site guard for the write route. Reads stay open: they only ever expose
 * her own state to a loopback peer.
 */
function writeAllowed(req) {
  if (!isLoopback(req)) return false
  const origin = req.headers?.origin
  if (typeof origin !== 'string' || origin === '' || origin === 'null') return true
  try {
    const parsed = new URL(origin)
    if (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost') return true
    return parsed.host === req.headers.host
  } catch {
    return false
  }
}

/**
 * The resident engine: phase, clock, and the snapshot the panel reads.
 */
class DigitalLife {
  /**
   * @param {object} context - the cordis context.
   * @param {object | undefined} config - plugin config.
   */
  constructor(context, config) {
    this.ctx = context
    this.config = config ?? {}
    const roots = resolveRoots(this.config)
    this.dshHome = roots.dshHome
    this.dataRoot = roots.dataRoot
    this.store = new LifeStore(this.dataRoot)
    this.lockPath = join(this.dataRoot, 'runtime', 'instance.lock')

    this.phase = 'unborn'
    this.problems = []
    this.manifest = null
    this.soul = null
    this.policy = null
    this.birthdayCache = null
    this.blockedReason = null
    this.sqlite = probeSqlite()
    this.startedAt = new Date().toISOString()
    this.lastHost = machineName()
    this.streams = new Set()
    this.lock = null
    this.timer = null
    this.memory = null
    this.talk = null
    this.life = null
    this.feed = null
    this.feedConfig = null
    this.patConfig = null
    this.outreach = null
    this.llmConfig = null
    this.ticking = false
    this.qq = null
  }

  /** Bring the data root up: layout, lock, phase, clock. */
  async start() {
    await this.store.ensureLayout()
    const claim = await instanceLock.acquire(this.lockPath)
    if (claim.ok) {
      this.lock = instanceLock.heartbeat(this.lockPath)
    } else {
      this.phase = 'blocked'
      this.blockedReason = claim.reason === 'held-by-live-process'
        ? `已经有一个她在这台机器上跑着了（pid ${claim.holder?.pid}，${claim.holder?.startedAt}）。多开会变成两个她。`
        : `数据根正被另一台机器上运行的她持有（${claim.holder?.hostname}）。如果那台机器已经关了，删掉 ${this.lockPath} 再重启。`
    }
    await this.refresh({ bumpRev: claim.ok })
    this.timer = setInterval(() => {
      void this.tick()
    }, 30_000)
    if (typeof this.timer.unref === 'function') this.timer.unref()
  }

  /** Re-read the portrait from disk and rebuild the snapshot. */
  async refresh({ bumpRev = false } = {}) {
    const read = await this.store.read()
    this.problems = read.problems
    if (this.phase !== 'blocked') this.phase = read.phase
    this.soul = read.soul ?? null
    this.manifest = read.manifest ?? null
    if (this.phase === 'alive') {
      if (bumpRev) {
        try {
          this.manifest = await this.store.touchManifest()
        } catch (error) {
          this.problems = [...this.problems, `manifest 回写失败：${String(error?.message ?? error)}`]
        }
      }
      try {
        this.policy = await this.store.readPolicy()
      } catch (error) {
        this.policy = null
        this.problems = [...this.problems, `策略读取失败：${String(error?.message ?? error)}`]
      }
      try {
        this.feedConfig = (await this.store.readInterop('feed'))?.ui ?? null
      } catch {
        this.feedConfig = null
      }
      try {
        this.patConfig = (await this.store.readInterop('pat'))?.ui ?? null
      } catch {
        this.patConfig = null
      }
      try {
        // Heals a root created before portrait/llm.json existed.
        this.llmConfig = await this.store.ensureLlmConfig()
      } catch {
        this.llmConfig = null
      }
    } else {
      this.policy = null
    }
    await this.syncMemory()
    this.broadcast()
  }

  /**
   * Open memory when she is alive, close it when she is not.
   *
   * The database file lives in `memory/`, which is exportable: facts only, and
   * the FTS index inside it is rebuilt from facts on import, never shipped.
   */
  async syncMemory() {
    if (this.phase === 'alive' && this.memory === null) {
      try {
        const memory = new Memory(join(this.dataRoot, 'memory', 'soul.db')).open()
        memory.setDomainConfig(await this.store.readDomains())
        this.memory = memory
        const replayed = await replayPendingImport(this.store, memory)
        if (replayed > 0) this.problems = [...this.problems, `从导入包补进了 ${replayed} 条记忆`]
        this.talk = new Talk({
          memory,
          store: this.store,
          getLlm: () => {
            try {
              return typeof this.ctx.get === 'function' ? this.ctx.get('llm') : undefined
            } catch {
              return undefined
            }
          },
          config: this.config
        })
        this.life = new Life({ memory, policy: this.policy ?? { outreach: {}, schedule: {} } })
        this.qq = new QqChannel({
          store: this.store,
          talk: this.talk,
          emit: (event, payload) => this.emit(event, payload)
        })
        await this.qq.load()
        this.outreach = new Outreach({
          memory,
          store: this.store,
          life: this.life,
          policy: this.policy ?? { outreach: {} },
          getLlm: () => {
            try {
              return typeof this.ctx.get === 'function' ? this.ctx.get('llm') : undefined
            } catch {
              return undefined
            }
          }
        })
        this.feed = new Feed({
          memory,
          store: this.store,
          readToppedUp: async () => {
            const credential = await this.store.readCredential('deepseek')
            const apiKey = credential?.apiKey ?? process.env.DEEPSEEK_API_KEY
            if (typeof apiKey !== 'string' || apiKey.trim() === '') return null
            const result = await readDeepSeekToppedUp(apiKey.trim())
            return result.ok && Number.isFinite(result.toppedUp) ? result.toppedUp : null
          }
        })
      } catch (error) {
        this.problems = [...this.problems, `记忆打不开：${String(error?.message ?? error)}`]
      }
      return
    }
    if (this.phase !== 'alive' && this.memory !== null) {
      this.memory.close()
      this.memory = null
      this.talk = null
      this.life = null
      this.feed = null
      this.outreach = null
      this.qq = null
    }
    if (this.phase === 'alive' && this.life !== null && this.policy !== null) {
      this.life.setPolicy(this.policy)
      if (this.outreach !== null) this.outreach.policy = this.policy
    }
  }

  /** Periodic tick: recompute the clock, detect a portrait appearing, and let her talk. */
  async tick() {
    if (this.ticking) return
    this.ticking = true
    try {
      const before = this.clockSnapshot()
      const watchPhase = this.phase
      const read = await this.store.read()
      if (watchPhase === 'unborn' && read.phase !== 'unborn') {
        await this.refresh()
        return
      }
      const after = this.clockSnapshot()
      if (before.localDay !== after.localDay || before.period !== after.period) this.broadcast()
      await this.outreachTick()
    } finally {
      this.ticking = false
    }
  }

  /**
   * Give her a chance to open her mouth right now, and report the decision.
   *
   * @param {Date} [now] - the instant, for tests.
   */
  async outreachNow(now = new Date()) {
    if (this.phase !== 'alive' || this.outreach === null) {
      return { ok: false, error: '她还没出生，或者记忆没打开' }
    }
    const result = await this.outreach.maybeSpeak({ now })
    if (result.ok === true && result.spoke === true) {
      this.emit('speech', {
        text: result.text,
        proactive: true,
        flags: result.flags ?? [],
        at: new Date().toISOString()
      })
      this.broadcast()
    }
    return result
  }

  /**
   * The tick's version: never throws, never blocks the clock.
   */
  async outreachTick() {
    if (this.phase !== 'alive' || this.outreach === null) return
    try {
      await this.outreachNow()
    } catch (error) {
      console.warn('[digital-life] 主动开口失败', error)
    }
  }

  /**
   * Which model routes are reachable. Read lazily through the service registry
   * (never a hard inject) so a composition without @deepseek-ai/dsh-llm still
   * shows her portrait instead of failing to load.
   */
  llmSnapshot() {
    try {
      const llm = typeof this.ctx.get === 'function' ? this.ctx.get('llm') : undefined
      if (llm === undefined || llm === null) return { available: false, providers: [] }
      const providers = typeof llm.listProviders === 'function' ? llm.listProviders() : []
      return {
        available: true,
        providers: Array.isArray(providers)
          ? providers.map((provider) => ({
              provider: provider?.id ?? provider?.provider ?? String(provider),
              models: Array.isArray(provider?.models) ? provider.models.length : undefined
            }))
          : []
      }
    } catch (error) {
      return { available: false, providers: [], error: String(error?.message ?? error) }
    }
  }

  /**
   * The shared secret the protocol endpoint must present on the event route,
   * or null when none is configured. Never sent anywhere; only compared.
   */
  qqToken() {
    const token = this.qq?.credentials?.token
    return typeof token === 'string' && token !== '' ? token : null
  }

  /** Channel health, in one list. */
  channelsSnapshot() {    const list = [{ id: 'desktop', state: 'bound', detail: '面板与桌面通道始终可用' }]
    list.push(this.qq === null
      ? { id: 'qq', state: 'unbound', detail: '没打开' }
      : { id: 'qq', state: this.qq.state.state, detail: this.qq.state.detail })
    list.push({ id: 'bilibili', state: 'unbound', detail: 'P4 才接，且默认只读' })
    return list
  }

  /**
   * Take one protocol-endpoint event. Called by the loopback route only.
   *
   * @param {any} update - OneBot event body.
   */
  async channelEvent(update) {
    if (this.phase !== 'alive' || this.qq === null) return { handled: false, reason: '她还没出生，或者记忆没打开' }
    const result = await this.qq.handleEvent(update)
    if (result.handled === true) this.broadcast()
    return result
  }

  /** Bedtime, quota and the overnight queue, as one block. */
  lifeSnapshot() {
    if (this.life === null) return null
    const quota = this.life.quota()
    return {
      period: this.life.period(),
      localDay: quota.localDay,
      quota,
      pending: this.life.pending(),
      lateNights: quota.lateNights
    }
  }

  /** Clock projection used by the snapshot. */
  clockSnapshot() {
    const now = new Date()
    const schedule = this.policy?.schedule ?? {}
    const boundary = Number.isInteger(schedule.dayBoundaryHour) ? schedule.dayBoundaryHour : 4
    return {
      now: now.toISOString(),
      localDay: localDayOf(now, boundary),
      period: periodOf(now, schedule),
      sleepAt: schedule.sleepAt ?? '23:30',
      wakeAt: schedule.wakeAt ?? '08:00',
      birthday: this.birthdayStatus()
    }
  }

  /**
   * Where her lunar birthday stands right now.
   *
   * Cached per local day: the snapshot is rebuilt on every SSE frame, and the
   * conversion scans the calendar.
   */
  birthdayStatus() {
    const rule = this.soul?.ageRule ?? null
    if (rule === null) return null
    const today = new Date().toDateString()
    if (this.birthdayCache !== null && this.birthdayCache.day === today && this.birthdayCache.rule === rule) {
      return this.birthdayCache.value
    }
    const value = lunarBirthday(rule)
    this.birthdayCache = { day: today, rule, value }
    return value
  }

  /** The only thing the panel is allowed to read. */
  snapshot() {
    const soul = this.soul
    const manifest = this.manifest
    return {
      ok: true,
      schemaVersion: SCHEMA_VERSION,
      phase: this.phase,
      blockedReason: this.blockedReason,
      problems: this.problems,
      name: soul?.name ?? manifest?.name ?? null,
      manifest: manifest === null
        ? null
        : {
            soulId: manifest.soulId,
            rev: manifest.rev,
            lastHost: manifest.lastHost,
            createdAt: manifest.createdAt
          },
      soul: soul === null
        ? null
        : {
            name: soul.name,
            // Her age is a function of the calendar, not a number frozen in a
            // file: N7 says she grows. A malformed rule falls back to soul.age.
            age: this.birthdayStatus()?.age ?? soul.age,
            grade: soul.grade ?? null,
            gender: soul.gender ?? null,
            relation: soul.relation ?? null,
            birthday: soul.ageRule ?? null,
            likes: soul.likes ?? [],
            fears: soul.fears ?? [],
            catchphrases: soul.catchphrases ?? [],
            family: soul.family ?? null
          },
      runtime: {
        node: process.version,
        sqlite: this.sqlite,
        pid: process.pid,
        hostname: hostname(),
        dataRoot: this.dataRoot,
        dshHome: this.dshHome,
        startedAt: this.startedAt,
        llm: this.llmSnapshot()
      },
      clock: this.clockSnapshot(),
      quota: this.policy === null
        ? null
        : {
            base: this.policy.outreach.baseQuotaPerDay,
            minimum: this.policy.outreach.minimumQuotaPerDay,
            channelsAllowed: this.policy.outreach.channelsAllowed,
            quietHours: this.policy.outreach.quietHours,
            wakeAfterPendingMessages: this.policy.outreach.wakeAfterPendingMessages
          },
      memory: this.memory === null ? null : this.memory.stats(),
      life: this.lifeSnapshot(),
      channels: this.channelsSnapshot(),
      feed: this.feedConfig,
      pat: this.patConfig,
      lastTurn: this.talk === null ? null : this.talk.lastTurn,
      pending: { todo: 0, drafts: 0 }
    }
  }

  /** Push the snapshot to every open SSE client. */
  broadcast() {
    if (this.streams.size === 0) return
    const payload = `data: ${JSON.stringify(this.snapshot())}\n\n`
    for (const res of this.streams) {
      try {
        res.write(payload)
      } catch {
        this.streams.delete(res)
      }
    }
  }

  /** Push a named event (speech, guard rejection) to every open SSE client. */
  emit(event, payload) {
    if (this.streams.size === 0) return
    const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`
    for (const res of this.streams) {
      try {
        res.write(frame)
      } catch {
        this.streams.delete(res)
      }
    }
  }

  /**
   * Run one whitelisted action. Actions are instructions to her, not state edits:
   * the Host validates and performs the write.
   *
   * @param {string} kind - action name.
   * @param {Record<string, unknown>} payload - action body.
   */
  async dispatch(kind, payload) {
    if (kind === 'create') {
      const created = await this.store.create({
        name: typeof payload.name === 'string' ? payload.name : undefined,
        addresser: typeof payload.addresser === 'string' ? payload.addresser : undefined
      })
      this.phase = 'alive'
      await this.refresh({ bumpRev: true })
      return { ok: true, created: { name: created.soul.name }, snapshot: this.snapshot() }
    }
    if (kind === 'import') {
      const source = typeof payload.sourceRoot === 'string' ? payload.sourceRoot.trim() : ''
      if (!isAbsolutePath(source)) throw badRequest('sourceRoot 必须是绝对路径')
      if (isInside(this.dataRoot, source)) throw badRequest('导入源不能在数据根内部')
      const imported = await this.store.importFrom(source)
      this.phase = 'alive'
      await this.refresh({ bumpRev: true })
      return {
        ok: true,
        imported: { name: imported.soul.name, sameSoul: imported.sameSoul },
        notice: imported.sameSoul
          ? `这份档案上次在 ${imported.previousHost ?? '另一台机器'} 上运行过。如果那边还在跑，你会得到两个她。`
          : null,
        snapshot: this.snapshot()
      }
    }
    if (kind === 'rescan') {
      await this.refresh()
      return { ok: true, snapshot: this.snapshot() }
    }
    if (kind === 'say') {
      return await this.speak(payload)
    }
    if (kind === 'feed') {
      return await this.feedCheck()
    }
    if (kind === 'pat') {
      return await this.pat()
    }
    if (kind === 'export') {
      return await this.exportTo(typeof payload.dest === 'string' ? payload.dest : '')
    }
    if (kind === 'import-archive') {
      return await this.importArchiveFrom(typeof payload.file === 'string' ? payload.file : '')
    }
    if (kind === 'proactive') {
      return await this.outreachNow()
    }
    if (kind === 'channels-refresh') {
      if (this.qq !== null) await this.qq.checkHealth()
      this.broadcast()
      return { ok: true, channels: this.channelsSnapshot() }
    }
    throw badRequest(`未知动作：${kind}`)
  }

  /**
   * Write a `.dshlife` file.
   *
   * @param {string} dest - absolute destination path.
   */
  async exportTo(dest) {
    if (this.phase !== 'alive') throw badRequest('她还没出生，没有可导出的东西')
    const target = dest.trim() === ''
      ? join(this.dataRoot, 'memory', 'export', `${this.soul?.name ?? 'soul'}-${Date.now()}.dshlife`)
      : resolve(dest.trim())
    if (!isAbsolutePath(target)) throw badRequest('dest 必须是绝对路径')
    if (isInside(this.dataRoot, target) === false && this.config?.allowExportAnywhere !== true) {
      // keep exports inside the data root unless explicitly allowed
      throw badRequest(`导出路径必须在数据根内部，或者把 allowExportAnywhere 打开：${this.dataRoot}`)
    }
    const result = await this.exportArchive(target)
    this.recordExport(result)
    return result
  }

  /** Build and write the archive; shared by the action and the download route. */
  async exportArchive(target) {
    const { buffer, facts, files } = await buildArchive({ store: this.store, memory: this.memory })
    await writeFile(target, buffer)
    return { ok: true, file: target, bytes: buffer.length, facts, files }
  }

  /** Keep a small record of exports so she can be asked about it later. */
  recordExport(result) {
    if (this.memory === null) return
    this.memory.addEvent({
      domain: 'relation',
      kind: 'export',
      direction: 'out',
      channel: 'desktop',
      actorUid: 'self',
      text: `把自己打包了一份（${result.facts} 条记忆）`,
      importance: 0.5,
      payload: { file: result.file, bytes: result.bytes }
    })
  }

  /**
   * Import a `.dshlife` file into this (empty) data root.
   *
   * @param {string} file - absolute path.
   */
  async importArchiveFrom(file) {
    const source = file.trim() === '' ? '' : resolve(file.trim())
    if (!isAbsolutePath(source)) throw badRequest('file 必须是绝对路径')
    const buffer = await readFile(source)
    const imported = await importArchive({ store: this.store, buffer })
    this.phase = 'alive'
    await this.refresh({ bumpRev: true })
    return {
      ok: true,
      imported: { name: imported.soul.name, facts: imported.facts },
      notice: imported.previousHost === null
        ? null
        : `这份档案上次在 ${imported.previousHost} 上运行过。如果那边还在跑，你会得到两个她。`,
      snapshot: this.snapshot()
    }
  }

  /** Check whether rice arrived, and let her say her line. */
  async feedCheck() {
    if (this.phase !== 'alive' || this.feed === null) throw badRequest('她还没出生，或者记忆没打开')
    const result = await this.feed.check(new Date())
    if (result.kind === 'recharged') {
      this.emit('fed', { delta: result.delta, text: result.said })
      this.broadcast()
    }
    return result
  }

  /**
   * Pat her head.
   *
   * DECISIONS A3: interaction actions are a registry (`portrait/interop/*.json`),
   * not an enum in the code, so this reads its own spec — domain, kind, the line
   * she says, and the cooldown — and falls back to sane defaults when the file is
   * missing (an older data root created before `pat.json` existed).
   *
   * Every pat is remembered; only the *line* is throttled. "She remembers you
   * patted her three times today" is the point of putting it in memory at all.
   *
   * @returns {Promise<{ ok: boolean, said: string | null, today: number, cooled: boolean }>}
   */
  async pat() {
    if (this.phase !== 'alive' || this.memory === null) throw badRequest('她还没出生，或者记忆没打开')
    const spec = await this.store.readInterop('pat').catch(() => undefined)
    const memorySpec = spec?.memory ?? {}
    const domain = typeof memorySpec.domain === 'string' ? memorySpec.domain : 'somatic'
    const kind = typeof memorySpec.kind === 'string' ? memorySpec.kind : 'pat'
    const importance = Number.isFinite(memorySpec.importance) ? memorySpec.importance : 0.4
    const cooldownMinutes = Number(spec?.ui?.cooldownMinutes ?? 5)

    const now = new Date()
    const today = now.toDateString()
    const history = this.memory.recent(200, { domains: [domain] })
      .filter((row) => row.kind === kind)
    const todayCount = history.filter((row) => new Date(row.at).toDateString() === today).length
    const lastAt = history.length === 0 ? 0 : Date.parse(history[history.length - 1].at)
    const cooled = cooldownMinutes > 0 && Number.isFinite(lastAt) && (now.getTime() - lastAt) < cooldownMinutes * 60_000

    this.memory.addEvent({
      domain,
      kind,
      direction: 'in',
      channel: 'desktop',
      actorUid: 'uncle',
      at: now.toISOString(),
      text: '舅舅摸了摸悠悠的头',
      importance,
      payload: { action: 'pat', nthToday: todayCount + 1 }
    })

    const said = cooled ? null : (typeof spec?.say === 'string' && spec.say.trim() !== '' ? spec.say : '嗯……嘿嘿。')
    if (said !== null) this.emit('pat', { text: said, today: todayCount + 1 })
    this.broadcast()
    return { ok: true, said, today: todayCount + 1, cooled }
  }

  /**
   * One conversational turn from the desktop channel.
   *
   * @param {Record<string, unknown>} payload - `{ text, channel? }`.
   */
  async speak(payload) {
    const text = typeof payload.text === 'string' ? payload.text.trim() : ''
    if (text === '') throw badRequest('要说话总得有点内容')
    if (this.phase !== 'alive' || this.talk === null) throw badRequest('她还没出生，或者记忆没打开')
    const channel = typeof payload.channel === 'string' ? payload.channel : 'desktop'
    const now = new Date()

    // Bedtime decides the shape of the turn: answer, hold it, or wake her up.
    const decision = this.life === null
      ? { action: 'answer', pending: 0, period: this.clockSnapshot().period, stayedUp: false }
      : this.life.onInbound({ now, channel, text })
    if (decision.stayedUp && this.life !== null) {
      const late = this.life.recordStayedUp(now)
      if (late.recorded) this.emit('late-night', { minutes: late.lateMinutes, localDay: late.localDay })
    }
    if (decision.action === 'queue') {
      this.emit('queued', { text, pending: decision.pending, period: decision.period })
      this.broadcast()
      return {
        ok: true,
        queued: true,
        pending: decision.pending,
        period: decision.period,
        note: `她睡着了。这条进了待办（现在 ${decision.pending} 条），超过阈值会叫醒她。`
      }
    }
    let message = text
    if (decision.action === 'wake' && this.life !== null) {
      const rows = this.life.drainQueue()
      const digest = Life.digest(rows)
      if (digest !== '') message = digest
      this.emit('woke', { pending: rows.length })
    }

    this.emit('listening', { text, at: new Date().toISOString() })
    const result = await this.talk.say({
      text: message,
      channel,
      actorUid: 'uncle',
      period: decision.period
    })
    if (!result.ok) {
      this.emit('speech-failed', { text, error: result.error })
      this.broadcast()
      return { ok: false, error: result.error, ms: result.ms }
    }
    this.emit('speech', {
      text: result.reply,
      flags: result.flags,
      refused: result.refused === true,
      recalled: result.recalled ?? [],
      ms: result.ms,
      at: new Date().toISOString()
    })
    this.broadcast()
    return result
  }

  /**
   * Transcript for the panel, newest last.
   *
   * This is the *conversation*, not the whole event log: a pat or a recharge is
   * a life event that she can recall ("你昨天摸了我三次头"), but rendering it as
   * a chat turn would put words in the uncle's mouth that he never typed. Those
   * show up as panel notes and feed stream events instead.
   */
  transcript(limit) {
    if (this.memory === null) return []
    // Read wider than `limit`, because the conversation is a subset of the log:
    // filtering after a narrow read would let a burst of pats starve the thread.
    const rows = this.memory.recent(Math.max(limit * 4, 80))
    return rows
      .filter((row) => row.kind === 'message' || row.kind === 'say' || row.kind === 'proactive')
      .slice(-limit)
      .map((row) => ({
        id: row.id,
        at: row.at,
        direction: row.direction,
        kind: row.kind,
        text: row.text ?? ''
      }))
  }

  /**
   * Everything that has to be true for her to work, checked in one place.
   *
   * `severity: 'optional'` checks are reported but never make her unhealthy —
   * a missing wallet key blocks 喂饭, not talking.
   *
   * @returns {Promise<{ ok: boolean, checks: Array<{ name: string, ok: boolean, detail: string, severity: string, hint?: string }> }>}
   */
  async doctor() {
    const checks = []
    const add = (name, ok, detail, hint, severity = 'required') => checks.push({ name, ok, detail, severity, hint })

    add('node', true, process.version)
    add('node:sqlite', this.sqlite, this.sqlite ? '可用' : '不可用', this.sqlite ? undefined : '宿主 Node 版本太老，P1 的记忆用不了')

    const read = await this.store.read()
    add('数据根', read.phase !== 'unborn', `${this.dataRoot} (${read.phase})`, read.phase === 'unborn' ? '还没有档案，去面板点「创建」' : undefined)
    add('人设校验', read.problems.length === 0, read.problems.length === 0 ? '通过' : read.problems.join('；'))

    add('实例独占', this.phase !== 'blocked', this.blockedReason ?? '这个进程持有锁')

    add('档案来源', true, `上次在 ${this.manifest?.lastHost === '' || this.manifest?.lastHost === undefined ? '未知机器' : this.manifest.lastHost} 运行`)

    add('模型路由', this.llmConfig !== null && this.llmConfig !== undefined,
      this.llmConfig === null || this.llmConfig === undefined ? '没有 portrait/llm.json' : `${this.llmConfig.provider} / ${this.llmConfig.model}`)

    const llm = this.llmSnapshot()
    add('llm 服务', llm.available, llm.available ? `${llm.providers.length} 个提供方` : '这个组合里没有 llm 服务', llm.available ? undefined : '确认 @deepseek-ai/dsh-llm 与一个提供方已加载')

    add('记忆', this.memory !== null, this.memory === null ? '没打开' : `${this.memory.stats().total} 条事实`, this.memory === null ? '看她是否出生、以及上面的 node:sqlite' : undefined)
    add('全文检索', this.memory !== null && this.memory.fts === true,
      this.memory === null ? '（记忆没开）' : this.memory.fts ? 'FTS5 可用' : `FTS5 不可用：${this.memory.ftsError ?? '未知'}`,
      this.memory !== null && this.memory.fts !== true ? '降级为最近事实的字面扫描，记性会差一些但能说话' : undefined,
      'optional')

    add('作息', this.policy !== null, this.policy === null ? '没读到' : `${this.policy.schedule.sleepAt}–${this.policy.schedule.wakeAt}，日界 ${this.policy.schedule.dayBoundaryHour} 点`)

    const credential = await this.store.readCredential('deepseek').catch(() => undefined)
    const hasKey = (typeof credential?.apiKey === 'string' && credential.apiKey !== '') || Boolean(process.env.DEEPSEEK_API_KEY)
    add('喂饭凭据', hasKey, hasKey ? '有' : '没有', hasKey ? undefined : '想让她收到大米饭，需要 credentials/deepseek.json 的 apiKey', 'optional')

    add('通道', true, '目前只有 desktop（QQ / B 站在 P3 / P4）', undefined, 'optional')
    add('入站端口', true, '只注册回环路由，没有对外监听')

    return { ok: checks.filter((check) => check.severity === 'required').every((check) => check.ok), checks }
  }

  /** Stop the clock, close streams, release the lock and the database. */
  async close() {
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
    if (this.memory !== null) {
      this.memory.close()
      this.memory = null
      this.talk = null
      this.life = null
      this.feed = null
    }
    for (const res of this.streams) {
      try {
        res.end()
      } catch {
        /* already gone */
      }
    }
    this.streams.clear()
    if (this.lock !== null) await this.lock.stop()
    this.lock = null
  }
}

/** A 400-carrying error. */
function badRequest(message) {
  const error = new Error(message)
  error.status = 400
  return error
}

/** Cordis function-plugin name. */
export const name = 'digital-life'

/** The route carrier; the panels are browser-side. */
export const inject = ['webServer']

/**
 * Register the resident engine and its three routes.
 *
 * @param {object} ctx - cordis context.
 * @param {object | undefined} config - plugin config.
 */
export function apply(ctx, config) {
  const life = new DigitalLife(ctx, config)

  ctx.effect(() => {
    void life.start().catch((error) => {
      console.warn('[digital-life] 启动失败', error)
      life.phase = 'broken'
      life.problems = [...life.problems, `启动失败：${String(error?.message ?? error)}`]
    })
    return () => {
      void life.close()
    }
  }, 'digital-life: engine')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE_STATE,
    handler: async (req, res) => {
      if (req.method !== 'GET') {
        res.statusCode = 405
        res.setHeader('allow', 'GET')
        res.end()
        return
      }
      if (!isLoopback(req)) {
        sendJson(res, 403, { ok: false, error: 'loopback-only' })
        return
      }
      sendJson(res, 200, life.snapshot())
    }
  }), `digital-life: GET ${ROUTE_STATE}`)

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE_STREAM,
    handler: async (req, res) => {
      if (req.method !== 'GET') {
        res.statusCode = 405
        res.setHeader('allow', 'GET')
        res.end()
        return
      }
      if (!isLoopback(req)) {
        sendJson(res, 403, { ok: false, error: 'loopback-only' })
        return
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no'
      })
      res.write(`data: ${JSON.stringify(life.snapshot())}\n\n`)
      life.streams.add(res)
      const ping = setInterval(() => {
        try {
          res.write(': ping\n\n')
        } catch {
          clearInterval(ping)
        }
      }, 25_000)
      if (typeof ping.unref === 'function') ping.unref()
      req.on('close', () => {
        clearInterval(ping)
        life.streams.delete(res)
      })
    }
  }), `digital-life: GET ${ROUTE_STREAM}`)

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE_ACTION,
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        res.statusCode = 405
        res.setHeader('allow', 'POST')
        res.end()
        return
      }
      if (!writeAllowed(req)) {
        sendJson(res, 403, { ok: false, error: 'forbidden-origin' })
        return
      }
      const contentType = String(req.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase()
      if (contentType !== 'application/json') {
        sendJson(res, 415, { ok: false, error: 'content-type must be application/json' })
        return
      }
      const body = await readJsonBody(req)
      if (body === null) {
        sendJson(res, 400, { ok: false, error: 'bad-json-body' })
        return
      }
      const kind = typeof body.action === 'string' ? body.action : ''
      try {
        sendJson(res, 200, await life.dispatch(kind, body))
      } catch (error) {
        const status = Number.isInteger(error?.status) ? error.status : 500
        if (status >= 500) console.warn('[digital-life] 动作失败', error)
        sendJson(res, status, { ok: false, error: String(error?.message ?? error) })
      }
    }
  }), `digital-life: POST ${ROUTE_ACTION}`)

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE_TRANSCRIPT,
    handler: async (req, res) => {
      if (req.method !== 'GET') {
        res.statusCode = 405
        res.setHeader('allow', 'GET')
        res.end()
        return
      }
      if (!isLoopback(req)) {
        sendJson(res, 403, { ok: false, error: 'loopback-only' })
        return
      }
      const limit = Number(new URL(String(req.url), 'http://localhost').searchParams.get('limit') ?? '30')
      const bounded = Number.isFinite(limit) ? Math.min(200, Math.max(1, Math.trunc(limit))) : 30
      sendJson(res, 200, { ok: true, turns: life.transcript(bounded) })
    }
  }), `digital-life: GET ${ROUTE_TRANSCRIPT}`)

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE_EXPORT,
    handler: async (req, res) => {
      if (req.method !== 'GET') {
        res.statusCode = 405
        res.setHeader('allow', 'GET')
        res.end()
        return
      }
      if (!isLoopback(req)) {
        sendJson(res, 403, { ok: false, error: 'loopback-only' })
        return
      }
      if (life.phase !== 'alive') {
        sendJson(res, 409, { ok: false, error: '她还没出生，没有可导出的东西' })
        return
      }
      try {
        const { buffer, facts } = await buildArchive({ store: life.store, memory: life.memory })
        life.recordExport({ facts, file: '(download)', bytes: buffer.length })
        const stamp = new Date().toISOString().slice(0, 10)
        const name = `${life.soul?.name ?? 'soul'}-${stamp}.dshlife`
        res.statusCode = 200
        res.setHeader('content-type', 'application/zip')
        res.setHeader('content-disposition', `attachment; filename="soul-${stamp}.dshlife"; filename*=UTF-8''${encodeURIComponent(name)}`)
        res.setHeader('content-length', String(buffer.length))
        res.setHeader('cache-control', 'no-store')
        res.end(buffer)
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
      }
    }
  }), `digital-life: GET ${ROUTE_EXPORT}`)

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE_DOCTOR,
    handler: async (req, res) => {
      if (req.method !== 'GET') {
        res.statusCode = 405
        res.setHeader('allow', 'GET')
        res.end()
        return
      }
      if (!isLoopback(req)) {
        sendJson(res, 403, { ok: false, error: 'loopback-only' })
        return
      }
      try {
        sendJson(res, 200, await life.doctor())
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
      }
    }
  }), `digital-life: GET ${ROUTE_DOCTOR}`)

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE_QQ_EVENT,
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        res.statusCode = 405
        res.setHeader('allow', 'POST')
        res.end()
        return
      }
      // This route exists for the LOCAL protocol endpoint to report events.
      // It is not an inbound door: loopback only, and it never exposes her to
      // a network peer. Invariant I2 still holds — no new listener, no public surface.
      if (!isLoopback(req)) {
        sendJson(res, 403, { ok: false, error: 'loopback-only' })
        return
      }
      const expected = life.qqToken()
      if (expected !== null) {
        const given = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')
        if (given !== expected) {
          sendJson(res, 401, { ok: false, error: 'bad-channel-token' })
          return
        }
      }
      const body = await readJsonBody(req)
      if (body === null) {
        sendJson(res, 400, { ok: false, error: 'bad-json-body' })
        return
      }
      try {
        sendJson(res, 200, await life.channelEvent(body))
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
      }
    }
  }), `digital-life: POST ${ROUTE_QQ_EVENT}`)
}
