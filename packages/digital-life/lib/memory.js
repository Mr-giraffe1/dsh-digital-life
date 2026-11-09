/**
 * Her memory: one SQLite file, facts are authoritative, every index is derived.
 *
 * Chinese retrieval without a segmenter: the FTS index stores text with one
 * space between every character, and queries are phrases over those characters.
 * FTS5's unicode61 tokenizer treats a whole CJK run as one token, and trigram
 * cannot match two-character words — both measured in P0.
 */

import { DatabaseSync } from 'node:sqlite'

/** Strip whitespace, punctuation and symbols, lowercase, then split into chars. */
function charsOf(text) {
  return [...String(text ?? '')
    .toLowerCase()
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, '')
  ]
}

/**
 * The searchable form of a text: one space between every character.
 *
 * @param {string} text - raw text.
 * @returns {string} e.g. "悠悠画了太阳" -> "悠 悠 画 了 太 阳"
 */
export function indexText(text) {
  return charsOf(text).join(' ')
}

/**
 * Build an FTS5 MATCH expression: OR of 2- and 3-character phrases.
 *
 * @param {string} text - the query text.
 * @returns {string} MATCH expression, or '' when nothing searchable remains.
 */
export function matchQuery(text) {
  const chars = charsOf(text)
  if (chars.length === 0) return ''
  const phrases = new Set()
  if (chars.length === 1) phrases.add(chars[0])
  for (let i = 0; i + 1 < chars.length; i += 1) phrases.add(chars.slice(i, i + 2).join(''))
  if (chars.length >= 3) {
    for (let i = 0; i + 2 < chars.length && phrases.size < 40; i += 1) {
      phrases.add(chars.slice(i, i + 3).join(''))
    }
  }
  return [...phrases]
    .slice(0, 40)
    .map((phrase) => `"${[...phrase].join(' ')}"`)
    .join(' OR ')
}

/** Default per-domain decay and weight; portrait/domains may override. */
const DOMAIN_DEFAULTS = Object.freeze({
  fact: { decayDays: 180, retrievalWeight: 1 },
  somatic: { decayDays: 7, retrievalWeight: 0.2 },
  diary: { decayDays: 365, retrievalWeight: 0.7 },
  relation: { decayDays: 365, retrievalWeight: 0.9 }
})

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_identity (
  uid          TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  display_name TEXT,
  relation     TEXT,
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS identity_link (
  platform     TEXT NOT NULL,
  platform_id  TEXT NOT NULL,
  uid          TEXT NOT NULL REFERENCES agent_identity(uid),
  display_name TEXT,
  bound_at     TEXT NOT NULL,
  PRIMARY KEY (platform, platform_id)
);

CREATE TABLE IF NOT EXISTS event (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  at           TEXT NOT NULL,
  epoch_ms     INTEGER NOT NULL,
  local_day    TEXT NOT NULL,
  domain       TEXT NOT NULL,
  kind         TEXT NOT NULL,
  actor_uid    TEXT,
  channel      TEXT,
  direction    TEXT,
  text         TEXT,
  payload      TEXT NOT NULL,
  importance   REAL NOT NULL DEFAULT 0.5,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_event_epoch ON event(epoch_ms);
CREATE INDEX IF NOT EXISTS idx_event_day ON event(local_day, domain);

CREATE TABLE IF NOT EXISTS relation (
  subject_uid TEXT PRIMARY KEY,
  stage       TEXT NOT NULL,
  intimacy    REAL NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS quota (
  local_day TEXT NOT NULL,
  channel   TEXT NOT NULL,
  used      INTEGER NOT NULL DEFAULT 0,
  cap       INTEGER NOT NULL,
  PRIMARY KEY (local_day, channel)
);

CREATE TABLE IF NOT EXISTS todo (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT NOT NULL,
  channel     TEXT NOT NULL,
  payload     TEXT NOT NULL,
  consumed_at TEXT
);

CREATE TABLE IF NOT EXISTS draft (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT NOT NULL,
  channel     TEXT NOT NULL,
  body        TEXT NOT NULL,
  state       TEXT NOT NULL,
  approved_by TEXT,
  sent_at     TEXT,
  receipt     TEXT
);

CREATE TABLE IF NOT EXISTS violation (
  local_day    TEXT PRIMARY KEY,
  slept_at     TEXT,
  late_minutes INTEGER
);
`

/**
 * One open memory file.
 */
export class Memory {
  /**
   * @param {string} file - absolute path to soul.db.
   * @param {{ localDay?: (date: Date) => string }} [options] - clock injection for tests.
   */
  constructor(file, options = {}) {
    this.file = file
    this.localDay = options.localDay ?? (() => {
      const now = new Date()
      return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    })
    this.db = null
    this.fts = false
    this.ftsError = null
    this.domainConfig = { ...DOMAIN_DEFAULTS }
  }

  /** Create tables and seed the two identities. Idempotent. */
  open() {
    if (this.db !== null) return this
    this.db = new DatabaseSync(this.file)
    // FTS5 is bundled in Node's SQLite, but the host runs a different binary
    // from this dev runtime. Never let a missing extension take her down: she
    // only loses ranked recall, not her memory or her voice.
    this.db.exec(SCHEMA)
    try {
      this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS event_fts USING fts5(body, content='')`)
      this.fts = true
      this.ftsError = null
    } catch (error) {
      this.fts = false
      this.ftsError = String(error?.message ?? error)
    }
    this.ensureIdentity({ uid: 'self', kind: 'self', displayName: '悠悠' })
    this.ensureIdentity({ uid: 'uncle', kind: 'person', displayName: '舅舅', relation: 'uncle' })
    this.linkIdentity({ platform: 'desktop', platformId: 'uncle', uid: 'uncle', displayName: '舅舅' })
    this.db.prepare('INSERT OR IGNORE INTO relation(subject_uid, stage, intimacy, updated_at) VALUES (?, ?, ?, ?)')
      .run('uncle', 'family', 0.8, new Date().toISOString())
    return this
  }

  /** Close the file. Safe to call twice. */
  close() {
    if (this.db === null) return
    try {
      this.db.close()
    } finally {
      this.db = null
    }
  }

  /** Override per-domain decay/weight from portrait/domains/*.json. */
  setDomainConfig(entries) {
    for (const entry of entries ?? []) {
      if (typeof entry?.id !== 'string') continue
      this.domainConfig[entry.id] = {
        decayDays: Number.isFinite(entry.decayDays) ? entry.decayDays : 180,
        retrievalWeight: Number.isFinite(entry.retrievalWeight) ? entry.retrievalWeight : 1
      }
    }
  }

  /** Insert an identity row if absent. */
  ensureIdentity({ uid, kind, displayName, relation }) {
    this.db.prepare(`INSERT INTO agent_identity(uid, kind, display_name, relation, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(uid) DO UPDATE SET display_name = excluded.display_name`)
      .run(uid, kind, displayName ?? null, relation ?? null, new Date().toISOString())
  }

  /** Map one platform id to an internal uid. */
  linkIdentity({ platform, platformId, uid, displayName }) {
    this.db.prepare(`INSERT INTO identity_link(platform, platform_id, uid, display_name, bound_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(platform, platform_id) DO UPDATE SET uid = excluded.uid`)
      .run(platform, platformId, uid, displayName ?? null, new Date().toISOString())
  }

  /**
   * Record one fact. The only write path into memory.
   *
   * @param {object} spec - event fields.
   * @returns {{ id: number, at: string }}
   */
  addEvent(spec) {
    const now = new Date()
    const at = spec.at ?? now.toISOString()
    const epochMs = spec.epochMs ?? Date.parse(at)
    const text = typeof spec.text === 'string' && spec.text.trim() !== '' ? spec.text : null
    const info = this.db.prepare(`INSERT INTO event
      (at, epoch_ms, local_day, domain, kind, actor_uid, channel, direction, text, payload, importance, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        at,
        Number.isFinite(epochMs) ? epochMs : now.getTime(),
        this.localDay(now),
        spec.domain ?? 'fact',
        spec.kind ?? 'note',
        spec.actorUid ?? null,
        spec.channel ?? null,
        spec.direction ?? null,
        text,
        JSON.stringify(spec.payload ?? {}),
        Number.isFinite(spec.importance) ? spec.importance : 0.5,
        now.toISOString()
      )
    const id = Number(info.lastInsertRowid)
    if (text !== null && this.fts) {
      this.db.prepare('INSERT INTO event_fts(rowid, body) VALUES (?, ?)').run(id, indexText(text))
    }
    return { id, at }
  }

  /** Most recent events, newest last (ready to render as a transcript). */
  recent(limit = 20, { domains = null } = {}) {
    const clause = domains === null ? '' : `WHERE domain IN (${domains.map(() => '?').join(',')})`
    const rows = this.db.prepare(`SELECT id, at, epoch_ms, domain, kind, actor_uid, channel, direction, text, importance
      FROM event ${clause} ORDER BY epoch_ms DESC, id DESC LIMIT ?`)
      .all(...(domains === null ? [] : domains), limit)
    return rows.reverse()
  }

  /** Counts per domain, for the panel. */
  stats() {
    const rows = this.db.prepare('SELECT domain, COUNT(*) AS n FROM event GROUP BY domain').all()
    const total = this.db.prepare('SELECT COUNT(*) AS n FROM event').get()
    return {
      total: Number(total?.n ?? 0),
      domains: Object.fromEntries(rows.map((r) => [r.domain, Number(r.n)])),
      fts: this.fts,
      ftsError: this.ftsError
    }
  }

  /**
   * BM25 recall, then the weighted re-rank from ARCHITECTURE §7.
   * Vector re-ranking is P2's job; this is the recall + stats half.
   *
   * Without FTS5 (an unexpected host build) recall degrades to a bounded LIKE
   * scan over recent facts, so she still remembers the obvious things.
   *
   * @param {string} queryText - what to search for.
   * @param {{ limit?: number, candidates?: number, nowMs?: number }} [options]
   * @returns {Array<object>} best first.
   */
  recall(queryText, options = {}) {
    const limit = options.limit ?? 8
    const candidates = options.candidates ?? 40
    const nowMs = options.nowMs ?? Date.now()
    const match = matchQuery(queryText)
    if (match === '') return []

    let rows
    if (this.fts) {
      try {
        rows = this.db.prepare(`SELECT e.id, e.at, e.epoch_ms, e.domain, e.kind, e.text, e.importance,
            bm25(event_fts) AS rank
          FROM event_fts JOIN event e ON e.id = event_fts.rowid
          WHERE event_fts MATCH ?
          ORDER BY rank
          LIMIT ?`).all(match, candidates)
      } catch {
        return []
      }
    } else {
      // Degraded recall: every character of the query must appear in the fact.
      // Looser than BM25, but it keeps "她记得" working without FTS5.
      const wanted = [...new Set(charsOf(queryText))]
      if (wanted.length === 0) return []
      const recent = this.db.prepare(`SELECT id, at, epoch_ms, domain, kind, text, importance
        FROM event WHERE text IS NOT NULL ORDER BY epoch_ms DESC LIMIT ?`).all(400)
      rows = recent
        .filter((row) => {
          const haystack = charsOf(row.text).join('')
          return wanted.every((char) => haystack.includes(char))
        })
        .slice(0, candidates)
        .map((row) => ({ ...row, rank: -1 }))
    }

    const scored = rows.map((row) => {
      const config = this.domainConfig[row.domain] ?? DOMAIN_DEFAULTS.fact
      const ageDays = Math.max(0, (nowMs - Number(row.epoch_ms)) / 86_400_000)
      const decay = Math.exp(-ageDays / Math.max(1, config.decayDays))
      const score = (-Number(row.rank) || 0) * decay * Number(row.importance ?? 0.5) * config.retrievalWeight
      return { ...row, score }
    })
    scored.sort((a, b) => b.score - a.score)
    // The same sentence said twice is one memory, not two: repeating a prompt
    // must not flood her context with duplicates.
    const seen = new Set()
    const unique = []
    for (const row of scored) {
      const key = charsOf(row.text ?? '').join('')
      if (key === '' || seen.has(key)) continue
      seen.add(key)
      unique.push(row)
      if (unique.length >= limit) break
    }
    return unique
  }

  /** Read a meta value. */
  getMeta(key) {
    const row = this.db.prepare('SELECT v FROM meta WHERE k = ?').get(key)
    return row === undefined ? undefined : row.v
  }

  /** Write a meta value. */
  setMeta(key, value) {
    this.db.prepare('INSERT INTO meta(k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
      .run(key, String(value))
  }

  // ---- quota ledger --------------------------------------------------------

  /** Read the quota row for one local day and channel. */
  quotaGet(localDay, channel) {
    const row = this.db.prepare('SELECT used, cap FROM quota WHERE local_day = ? AND channel = ?').get(localDay, channel)
    return row === undefined ? null : { used: Number(row.used), cap: Number(row.cap) }
  }

  /** Overwrite the quota row (cap recomputed every tick, used preserved). */
  quotaSet(localDay, channel, used, cap) {
    this.db.prepare(`INSERT INTO quota(local_day, channel, used, cap) VALUES (?, ?, ?, ?)
      ON CONFLICT(local_day, channel) DO UPDATE SET used = excluded.used, cap = excluded.cap`)
      .run(localDay, channel, used, cap)
  }

  /** Spend one unit of the proactive quota; false when exhausted. */
  quotaSpend(localDay, channel) {
    const row = this.quotaGet(localDay, channel)
    if (row === null) return false
    if (row.used >= row.cap) return false
    this.quotaSet(localDay, channel, row.used + 1, row.cap)
    return true
  }

  // ---- overnight todo queue ------------------------------------------------

  /** Remember something that arrived while she was asleep. */
  todoAdd({ at, channel, text, actorUid }) {
    const info = this.db.prepare('INSERT INTO todo(at, channel, payload, consumed_at) VALUES (?, ?, ?, NULL)')
      .run(at ?? new Date().toISOString(), channel, JSON.stringify({ text, actorUid: actorUid ?? 'uncle' }))
    return Number(info.lastInsertRowid)
  }

  /** How many messages are waiting for her. */
  todoPending() {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM todo WHERE consumed_at IS NULL').get()
    return Number(row?.n ?? 0)
  }

  /** Take everything pending, oldest first, and mark it consumed. */
  todoDrain() {
    const rows = this.db.prepare('SELECT id, at, channel, payload FROM todo WHERE consumed_at IS NULL ORDER BY id')
      .all()
    const now = new Date().toISOString()
    const mark = this.db.prepare('UPDATE todo SET consumed_at = ? WHERE id = ?')
    for (const row of rows) mark.run(now, row.id)
    return rows.map((row) => {
      let payload = {}
      try {
        payload = JSON.parse(row.payload)
      } catch {
        payload = {}
      }
      return { id: row.id, at: row.at, channel: row.channel, text: payload.text ?? '' }
    })
  }

  // ---- late nights ---------------------------------------------------------

  /** Record that she was still up past her bedtime on that local day. */
  markLateNight(localDay, sleptAt, lateMinutes) {
    this.db.prepare(`INSERT INTO violation(local_day, slept_at, late_minutes) VALUES (?, ?, ?)
      ON CONFLICT(local_day) DO UPDATE SET slept_at = excluded.slept_at, late_minutes = excluded.late_minutes`)
      .run(localDay, sleptAt ?? null, Number.isFinite(lateMinutes) ? lateMinutes : 0)
  }

  /** Late-night rows for the trailing window, newest first. */
  recentLateNights(sinceLocalDay) {
    return this.db.prepare('SELECT local_day, late_minutes FROM violation WHERE local_day >= ? ORDER BY local_day DESC')
      .all(sinceLocalDay)
      .map((row) => ({ localDay: row.local_day, lateMinutes: Number(row.late_minutes ?? 0) }))
  }

  /** How many times she spoke on her own initiative that day (any channel). */
  countProactive(localDay) {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM event
      WHERE local_day = ? AND direction = 'out' AND kind = 'proactive'`).get(localDay)
    return Number(row?.n ?? 0)
  }
}
