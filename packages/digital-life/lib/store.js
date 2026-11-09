/**
 * The data root: layout creation, atomic JSON, portrait read/create, and the
 * four-layer split (portrait / memory / credentials / runtime).
 */

import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  DEFAULT_DOMAINS,
  DEFAULT_OUTREACH,
  DEFAULT_SCHEDULE,
  DEFAULT_VOICE_MD,
  SCHEMA_VERSION,
  createManifest,
  defaultSoul,
  validateManifest,
  validateSoul
} from './schema.js'
import { machineName } from './paths.js'

/** Directories every data root carries. */
const LAYOUT = Object.freeze([
  'portrait',
  'portrait/channels',
  'portrait/domains',
  'portrait/interop',
  'memory',
  'memory/export',
  'credentials',
  'runtime',
  'logs'
])

/** @param {string} path - candidate file. @returns {Promise<boolean>} */
async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** Read and parse JSON; returns undefined when the file is missing. */
async function readJson(path) {
  try {
    const text = await readFile(path, 'utf8')
    return JSON.parse(text)
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return undefined
    throw error
  }
}

/** Write JSON atomically: temp file in the same directory, then rename. */
async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(tmp, path)
}

/** Write UTF-8 text atomically. */
async function writeText(path, text) {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  await writeFile(tmp, text, 'utf8')
  await rename(tmp, path)
}

/** @param {string} message - human text. @returns {Error} an error carrying an HTTP status. */
function fail(status, message) {
  const error = new Error(message)
  error.status = status
  return error
}

/**
 * Everything the Host half needs to read and write a soul on disk.
 */
export class LifeStore {
  /**
   * @param {string} root - absolute data root.
   */
  constructor(root) {
    this.root = root
    this.manifestPath = join(root, 'manifest.json')
    this.soulPath = join(root, 'portrait', 'soul.json')
    this.voicePath = join(root, 'portrait', 'voice.md')
    this.orderPath = join(root, 'runtime', 'order.json')
  }

  /** Create every directory the layout needs. Idempotent. */
  async ensureLayout() {
    for (const relative of LAYOUT) {
      await mkdir(join(this.root, relative), { recursive: true })
    }
  }

  /**
   * Read the on-disk phase. Never throws for a missing/unreadable portrait:
   * a broken portrait must surface as a blocked state, not as a crash loop.
   *
   * @returns {Promise<{
   *   phase: 'unborn' | 'alive' | 'broken',
   *   manifest?: object,
   *   soul?: object,
   *   problems: string[]
   * }>}
   */
  async read() {
    const manifest = await readJson(this.manifestPath)
    const soul = await readJson(this.soulPath)
    if (manifest === undefined && soul === undefined) {
      return { phase: 'unborn', problems: [] }
    }
    const problems = []
    if (manifest === undefined) problems.push('manifest.json 缺失')
    else problems.push(...validateManifest(manifest))
    if (soul === undefined) problems.push('portrait/soul.json 缺失')
    else problems.push(...validateSoul(soul))
    if (problems.length > 0) return { phase: 'broken', manifest, soul, problems }
    return { phase: 'alive', manifest, soul, problems: [] }
  }

  /**
   * Create a brand-new soul from the creation form.
   *
   * @param {{ name?: string, addresser?: string }} input - form values.
   * @returns {Promise<{ manifest: object, soul: object }>}
   */
  async create(input = {}) {
    const existing = await this.read()
    if (existing.phase !== 'unborn') {
      throw fail(409, `数据根里已经有档案（phase=${existing.phase}），不会覆盖。要重建请先手动清空 ${this.root}`)
    }
    const soul = defaultSoul(input)
    const manifest = createManifest({ name: soul.name, host: machineName() })

    await this.ensureLayout()
    await writeJson(this.manifestPath, manifest)
    await writeJson(this.soulPath, soul)
    await writeText(this.voicePath, DEFAULT_VOICE_MD)
    await writeJson(join(this.root, 'portrait', 'schedule.json'), DEFAULT_SCHEDULE)
    await writeJson(join(this.root, 'portrait', 'outreach.json'), DEFAULT_OUTREACH)
    for (const domain of DEFAULT_DOMAINS) {
      await writeJson(join(this.root, 'portrait', 'domains', `${domain.id}.json`), {
        schemaVersion: SCHEMA_VERSION,
        ...domain
      })
    }
    for (const channel of ['desktop', 'qq', 'bilibili']) {
      await writeJson(join(this.root, 'portrait', 'channels', `${channel}.json`), defaultChannel(channel))
    }
    await writeJson(join(this.root, 'portrait', 'interop', 'feed.json'), DEFAULT_FEED)
    await writeJson(join(this.root, 'portrait', 'interop', 'pat.json'), DEFAULT_PAT)
    await writeJson(join(this.root, 'portrait', 'llm.json'), DEFAULT_LLM)
    return { manifest, soul }
  }

  /**
   * Import a portrait directory into an empty data root. Refuses to overwrite.
   *
   * @param {string} sourceRoot - absolute path of a directory holding portrait/.
   * @returns {Promise<{ manifest: object, soul: object, previousHost?: string, sameSoul: boolean }>}
   */
  async importFrom(sourceRoot) {
    const existing = await this.read()
    if (existing.phase !== 'unborn') {
      throw fail(409, `数据根里已经有档案（phase=${existing.phase}），不会覆盖。要导入请先手动清空 ${this.root}`)
    }
    const sourcePortrait = join(sourceRoot, 'portrait')
    if (!(await exists(join(sourcePortrait, 'soul.json')))) {
      throw fail(400, `导入源里没有 portrait/soul.json：${sourceRoot}`)
    }
    const soulRaw = await readJson(join(sourcePortrait, 'soul.json'))
    const problems = validateSoul(soulRaw)
    if (problems.length > 0) throw fail(400, `导入源的人设不合法：${problems.join('；')}`)
    const sourceManifest = await readJson(join(sourceRoot, 'manifest.json'))
    const soulId = typeof sourceManifest?.soulId === 'string' ? sourceManifest.soulId : undefined

    await this.ensureLayout()
    await copyTree(sourcePortrait, join(this.root, 'portrait'))
    const manifest = createManifest({ name: soulRaw.name, soulId, host: machineName() })
    await writeJson(this.manifestPath, manifest)
    return {
      manifest,
      soul: soulRaw,
      previousHost: typeof sourceManifest?.lastHost === 'string' ? sourceManifest.lastHost : undefined,
      sameSoul: soulId !== undefined
    }
  }

  /** Bump rev at startup so a copy of this root is visibly "already running". */
  async touchManifest() {
    const manifest = await readJson(this.manifestPath)
    if (manifest === undefined) return undefined
    const next = {
      ...manifest,
      rev: Number.isInteger(manifest.rev) ? manifest.rev + 1 : 1,
      lastHost: machineName(),
      lastStartedAt: new Date().toISOString()
    }
    await writeJson(this.manifestPath, next)
    return next
  }

  /** Read the portrait's outreach/schedule config with defaults filled in. */
  async readPolicy() {
    const outreach = await readJson(join(this.root, 'portrait', 'outreach.json'))
    const schedule = await readJson(join(this.root, 'portrait', 'schedule.json'))
    return {
      outreach: { ...DEFAULT_OUTREACH, ...(outreach ?? {}) },
      schedule: { ...DEFAULT_SCHEDULE, ...(schedule ?? {}) }
    }
  }

  /** Read one interaction spec (portrait/interop/<id>.json). */
  async readInterop(id) {
    return readJson(join(this.root, 'portrait', 'interop', `${id}.json`))
  }

  /** Read one channel declaration (portrait/channels/<id>.json). */
  async readChannel(id) {
    return readJson(join(this.root, 'portrait', 'channels', `${id}.json`))
  }

  /** Read one credential body (credentials/<name>.json). Never exported. */
  async readCredential(name) {
    return readJson(join(this.root, 'credentials', `${name}.json`))
  }

  /** Read soul.json without validating (validation happens in read()). */
  async readSoul() {
    return readJson(this.soulPath)
  }

  /** Read the voice spec — the only source of speaking style. */
  async readVoice() {
    try {
      return await readFile(this.voicePath, 'utf8')
    } catch (error) {
      if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return ''
      throw error
    }
  }

  /** Read the model route this soul wants to use. */
  async readLlmConfig() {
    return readJson(join(this.root, 'portrait', 'llm.json'))
  }

  /**
   * Make sure portrait/llm.json exists. A root created before that file was
   * introduced must heal itself instead of falling through to a guess.
   */
  async ensureLlmConfig() {
    const current = await this.readLlmConfig()
    if (current !== undefined) return current
    await writeJson(join(this.root, 'portrait', 'llm.json'), DEFAULT_LLM)
    return DEFAULT_LLM
  }

  /** Read every declared memory domain (a registry, not an enum). */
  async readDomains() {
    const dir = join(this.root, 'portrait', 'domains')
    let names
    try {
      names = await readdir(dir)
    } catch {
      return [...DEFAULT_DOMAINS]
    }
    const entries = []
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const body = await readJson(join(dir, name))
      if (body !== undefined && typeof body.id === 'string') entries.push(body)
    }
    return entries.length === 0 ? [...DEFAULT_DOMAINS] : entries
  }
}

/** Per-channel declaration written at creation time (no credentials). */
function defaultChannel(id) {
  const base = { schemaVersion: SCHEMA_VERSION, id, enabled: true }
  if (id === 'desktop') return { ...base, irreversible: false, tools: 'full', modality: 'text' }
  if (id === 'qq') {
    return {
      ...base,
      irreversible: false,
      tools: 'readonly',
      protocol: 'onebot11',
      // Fill these two in to bring QQ to life; the token lives in
      // credentials/onebot.json and never travels in an export.
      baseUrl: '',
      selfId: '',
      ownerId: '',
      allowGroups: false,
      requireMention: true
    }
  }
  return { ...base, irreversible: true, tools: 'none', publicPosting: false }
}

/**
 * Default model route. Provider `deepseek-account` matches this profile's
 * agent-default-model row; anything else can be set in portrait/llm.json, and
 * an ollama route is just a different provider id.
 */
const DEFAULT_LLM = Object.freeze({
  schemaVersion: SCHEMA_VERSION,
  provider: 'deepseek-account',
  model: 'deepseek-flash',
  temperature: 0.9,
  maxTokens: 220
})

/** 喂饭 = recharge. First entry of the interpolation registry. */
const DEFAULT_FEED = Object.freeze({  schemaVersion: SCHEMA_VERSION,
  id: 'feed',
  label: '喂饭',
  trigger: { kind: 'recharge', provider: 'deepseek', field: 'topped_up_balance' },
  memory: { domain: 'somatic', kind: 'fed', importance: 0.6 },
  say: '舅舅舅舅！你给我充大米饭啦？那我以后不用饿肚子了！',
  ui: {
    animation: 'rice',
    cooldownMinutes: 60,
    rechargeUrl: 'https://platform.deepseek.com/top_up',
    pollSeconds: 5,
    pollTries: 24
  }
})

/** 摸头 = a somatic event with no external trigger. Second registry entry. */
const DEFAULT_PAT = Object.freeze({
  schemaVersion: SCHEMA_VERSION,
  id: 'pat',
  label: '摸头',
  trigger: { kind: 'client', action: 'pat' },
  memory: { domain: 'somatic', kind: 'pat', importance: 0.4 },
  say: '嗯……嘿嘿。',
  ui: { animation: 'pat', cooldownMinutes: 5 }
})

/** Recursive copy used only by import. */
async function copyTree(from, to) {
  await mkdir(to, { recursive: true })
  const entries = await readdir(from, { withFileTypes: true })
  for (const entry of entries) {
    const source = join(from, entry.name)
    const target = join(to, entry.name)
    if (entry.isDirectory()) {
      await copyTree(source, target)
      continue
    }
    if (entry.isFile()) await writeFile(target, await readFile(source))
  }
}

export { exists, readJson, writeJson, writeText }
export { rm }
