/**
 * `.dshlife` exchange: one file that carries a soul to another machine.
 *
 * What travels: manifest, the whole portrait/ tree, and the fact log as JSONL.
 * What never travels: credentials/, runtime/, and every derived index — the FTS
 * table and (later) vectors are rebuilt on import, because shipping derived data
 * as authoritative is how this kind of project loses data (ARCHITECTURE §11).
 */

import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { zipRead, zipWrite } from './archive.js'
import { SCHEMA_VERSION, validateSoul } from './schema.js'

/** Format version of the archive itself, separate from the portrait schema. */
export const EXCHANGE_VERSION = 1

/** Paths inside the archive that carry meaning. */
const ENTRY = {
  manifest: 'manifest.json',
  fingerprint: 'memory/fingerprint.json',
  events: 'memory/events.jsonl',
  portraitPrefix: 'portrait/'
}

/** Recursively list files under a directory as posix-style relative paths. */
async function walk(root, prefix = '') {
  const out = []
  let entries
  try {
    entries = await readdir(join(root, prefix), { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) out.push(...await walk(root, relative))
    else if (entry.isFile()) out.push(relative)
  }
  return out
}

/**
 * Turn a memory database into ordered JSONL facts.
 *
 * @param {import('./memory.js').Memory} memory - open memory.
 * @returns {string} JSONL body, one fact per line, ordered by id.
 */
export function factsToJsonl(memory) {
  const rows = memory.db.prepare(`SELECT id, at, epoch_ms, local_day, domain, kind, actor_uid, channel,
      direction, text, payload, importance, created_at FROM event ORDER BY id`).all()
  return rows
    .map((row) => JSON.stringify({
      at: row.at,
      domain: row.domain,
      kind: row.kind,
      actorUid: row.actor_uid ?? null,
      channel: row.channel ?? null,
      direction: row.direction ?? null,
      text: row.text ?? null,
      payload: safeParse(row.payload),
      importance: Number(row.importance ?? 0.5)
    }))
    .join('\n')
}

/** Parse a payload column without throwing. */
function safeParse(value) {
  try {
    return JSON.parse(value ?? '{}')
  } catch {
    return {}
  }
}

/**
 * Build the archive bytes for one soul.
 *
 * @param {object} options - inputs.
 * @param {import('./store.js').LifeStore} options.store - the data root.
 * @param {import('./memory.js').Memory | null} options.memory - open memory, or null.
 * @param {{ embeddingModelId?: string | null, dim?: number }} [options.embedding] - index fingerprint.
 * @returns {Promise<{ buffer: Buffer, facts: number, files: number }>}
 */
export async function buildArchive({ store, memory, embedding = {} }) {
  const manifest = JSON.parse(await readFile(store.manifestPath, 'utf8'))
  const events = memory === null ? '' : factsToJsonl(memory)
  const factCount = events === '' ? 0 : events.split('\n').length
  const entries = [
    { name: ENTRY.manifest, data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8') },
    {
      name: ENTRY.fingerprint,
      data: Buffer.from(`${JSON.stringify({
        exchangeVersion: EXCHANGE_VERSION,
        schemaVersion: SCHEMA_VERSION,
        embeddingModelId: embedding.embeddingModelId ?? null,
        dim: embedding.dim ?? 0,
        facts: factCount
      }, null, 2)}\n`, 'utf8')
    },
    { name: ENTRY.events, data: Buffer.from(events === '' ? '' : `${events}\n`, 'utf8') }
  ]
  const portraitRoot = join(store.root, 'portrait')
  const files = await walk(portraitRoot, '')
  for (const relative of files) {
    entries.push({
      name: `${ENTRY.portraitPrefix}${relative}`,
      data: await readFile(join(portraitRoot, relative))
    })
  }
  return { buffer: zipWrite(entries), facts: factCount, files: files.length }
}

/**
 * Parse an archive without writing anything. Used to validate before import.
 *
 * @param {Buffer} buffer - archive bytes.
 * @returns {{ manifest: object, soul: object, events: object[], portrait: Map<string, Buffer>, fingerprint: object }}
 */
export function inspectArchive(buffer) {
  const entries = zipRead(buffer)
  const manifestBytes = entries.get(ENTRY.manifest)
  if (manifestBytes === undefined) throw new Error('归档里没有 manifest.json')
  let manifest
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8'))
  } catch {
    throw new Error('manifest.json 不是合法 JSON')
  }
  if (manifest?.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`这份档案的 schemaVersion 是 ${JSON.stringify(manifest?.schemaVersion)}，本版本只认 ${SCHEMA_VERSION}。拒绝导入，原数据没有动。`)
  }
  const soulBytes = entries.get(`${ENTRY.portraitPrefix}soul.json`)
  if (soulBytes === undefined) throw new Error('归档里没有 portrait/soul.json')
  let soul
  try {
    soul = JSON.parse(soulBytes.toString('utf8'))
  } catch {
    throw new Error('portrait/soul.json 不是合法 JSON')
  }
  const problems = validateSoul(soul)
  if (problems.length > 0) throw new Error(`人设不合法：${problems.join('；')}`)

  const portrait = new Map()
  for (const [name, bytes] of entries) {
    if (name.startsWith(ENTRY.portraitPrefix)) portrait.set(name.slice(ENTRY.portraitPrefix.length), bytes)
  }

  const eventsText = entries.get(ENTRY.events)?.toString('utf8') ?? ''
  const events = []
  for (const line of eventsText.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      events.push(JSON.parse(trimmed))
    } catch {
      throw new Error(`events.jsonl 里有一行不是合法 JSON：${trimmed.slice(0, 60)}`)
    }
  }
  let fingerprint = {}
  const fp = entries.get(ENTRY.fingerprint)
  if (fp !== undefined) {
    try {
      fingerprint = JSON.parse(fp.toString('utf8'))
    } catch {
      fingerprint = {}
    }
  }
  return { manifest, soul, events, portrait, fingerprint }
}

/**
 * Import an archive into an empty data root. Refuses to touch a live soul.
 *
 * @param {object} options - inputs.
 * @param {import('./store.js').LifeStore} options.store - destination root.
 * @param {Buffer} options.buffer - archive bytes.
 * @returns {Promise<{ soul: object, facts: number, previousHost: string | null, sameSoul: boolean }>}
 */
export async function importArchive({ store, buffer }) {
  const existing = await store.read()
  if (existing.phase !== 'unborn') {
    throw fail(409, `数据根里已经有档案（phase=${existing.phase}），不会覆盖。要导入请先清空 ${store.root}`)
  }
  const parsed = inspectArchive(buffer)

  await store.ensureLayout()
  for (const [relative, bytes] of parsed.portrait) {
    const target = join(store.root, 'portrait', ...relative.split('/'))
    await writeFile(target, bytes)
  }
  const manifest = {
    ...parsed.manifest,
    rev: 1,
    // An archive without a host marker must not become an invalid manifest.
    lastHost: typeof parsed.manifest.lastHost === 'string' ? parsed.manifest.lastHost : '',
    importedAt: new Date().toISOString()
  }
  await writeFile(store.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  // Facts are staged, then replayed once memory opens; a crash between the two
  // leaves the staging file behind instead of silently dropping her history.
  if (parsed.events.length > 0) {
    const staging = join(store.root, 'memory', 'pending-import.jsonl')
    await writeFile(staging, parsed.events.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8')
  }

  return {
    soul: parsed.soul,
    facts: parsed.events.length,
    previousHost: typeof parsed.manifest.lastHost === 'string' ? parsed.manifest.lastHost : null,
    sameSoul: typeof parsed.manifest.soulId === 'string'
  }
}

/**
 * Replay facts staged by {@link importArchive} into an open memory.
 *
 * @param {import('./store.js').LifeStore} store - the data root.
 * @param {import('./memory.js').Memory} memory - open memory.
 * @returns {Promise<number>} facts replayed.
 */
export async function replayPendingImport(store, memory) {
  const staging = join(store.root, 'memory', 'pending-import.jsonl')
  let text
  try {
    text = await readFile(staging, 'utf8')
  } catch {
    return 0
  }
  let count = 0
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    let row
    try {
      row = JSON.parse(trimmed)
    } catch {
      continue
    }
    memory.addEvent({
      at: row.at,
      domain: row.domain,
      kind: row.kind,
      actorUid: row.actorUid ?? null,
      channel: row.channel ?? null,
      direction: row.direction ?? null,
      text: row.text ?? null,
      payload: row.payload ?? {},
      importance: Number.isFinite(row.importance) ? row.importance : 0.5
    })
    count += 1
  }
  try {
    await (await import('node:fs/promises')).rm(staging, { force: true })
  } catch {
    /* staging cleanup is best effort */
  }
  return count
}

/** An error carrying an HTTP status. */
function fail(status, message) {
  const error = new Error(message)
  error.status = status
  return error
}

/**
 * Compare two fact logs for round-trip equality.
 *
 * @param {string} left - JSONL body.
 * @param {string} right - JSONL body.
 * @returns {{ equal: boolean, leftLines: number, rightLines: number }}
 */
export function compareFacts(left, right) {
  const normalise = (text) => text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => {
      const row = JSON.parse(line)
      // `id` and `created_at` are local bookkeeping; everything else must match.
      delete row.id
      delete row.createdAt
      return JSON.stringify(row, Object.keys(row).sort())
    })
  const a = normalise(left)
  const b = normalise(right)
  return { equal: a.length === b.length && a.every((line, index) => line === b[index]), leftLines: a.length, rightLines: b.length }
}

/** Export a soul to a file on disk. */
export async function exportToFile({ store, memory, filePath, embedding }) {
  const { buffer, facts, files } = await buildArchive({ store, memory, embedding })
  await writeFile(filePath, buffer)
  return { filePath, bytes: buffer.length, facts, files }
}

export { ENTRY as ARCHIVE_ENTRIES, posix }
