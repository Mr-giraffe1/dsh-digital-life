/**
 * The life engine: bedtime, quota, overnight queue, late-night penalty.
 *
 * Two rules drive everything here, both from DECISIONS.md:
 *  - the schedule is fixed, but she is allowed to break it — the engine records
 *    that instead of preventing it;
 *  - breaking it costs quota rather than zeroing it.
 */

import { localDayOf, overshootMinutes, periodOf, precedingDays } from './clock.js'

/** Channels allowed to carry proactive speech. */
const PROACTIVE_CHANNEL = 'desktop'

/**
 * Bedtime, quota and the overnight queue for one soul.
 */
export class Life {
  /**
   * @param {object} options - wiring.
   * @param {import('./memory.js').Memory} options.memory - open memory.
   * @param {{ outreach: object, schedule: object }} options.policy - portrait policy.
   */
  constructor({ memory, policy }) {
    this.memory = memory
    this.policy = policy
  }

  /** Swap policy after a rescan without rebuilding the engine. */
  setPolicy(policy) {
    this.policy = policy
  }

  /** Local day key at the configured boundary. */
  dayKey(now = new Date()) {
    return localDayOf(now, this.policy?.schedule?.dayBoundaryHour ?? 4)
  }

  /** Which part of her day it is right now. */
  period(now = new Date()) {
    return periodOf(now, this.policy?.schedule ?? {})
  }

  /**
   * Quota for one day: base minus one per late night in the trailing window,
   * never below the floor, back to base once the window is clean.
   *
   * @param {Date} [now] - the instant.
   * @returns {{ localDay: string, base: number, cap: number, used: number, left: number, lateNights: number }}
   */
  quota(now = new Date()) {
    const outreach = this.policy?.outreach ?? {}
    const base = Number(outreach.baseQuotaPerDay ?? 3)
    const floor = Number(outreach.minimumQuotaPerDay ?? 1)
    const windowDays = Number(outreach.nightsToRecoverQuota ?? 3)
    const localDay = this.dayKey(now)
    const since = precedingDays(localDay, windowDays).at(-1) ?? localDay
    const lateNights = this.memory.recentLateNights(since).length
    const cap = Math.max(floor, base - Math.min(base - floor, lateNights))
    const row = this.memory.quotaGet(localDay, PROACTIVE_CHANNEL)
    const used = row === null ? 0 : row.used
    const clamped = Math.min(used, cap)
    // Only touch the ledger when the cap actually changed something; snapshot()
    // is called on every broadcast and must not write on every read.
    if (row === null || row.used !== clamped || row.cap !== cap) {
      this.memory.quotaSet(localDay, PROACTIVE_CHANNEL, clamped, cap)
    }
    return { localDay, base, cap, used: clamped, left: Math.max(0, cap - clamped), lateNights }
  }

  /** Spend one proactive slot; false when there is none left. */
  spend(now = new Date()) {
    const { localDay, left } = this.quota(now)
    if (left <= 0) return false
    return this.memory.quotaSpend(localDay, PROACTIVE_CHANNEL)
  }

  /**
   * What to do with something that just arrived.
   *
   * @param {object} input - the inbound message.
   * @param {Date} [input.now] - arrival time.
   * @param {string} [input.channel] - where it came from.
   * @param {string} input.text - what it said.
   * @returns {{ action: 'answer' | 'queue' | 'wake', pending: number, period: string, stayedUp: boolean }}
   */
  onInbound({ now = new Date(), channel = 'desktop', text }) {
    const period = this.period(now)
    if (period === 'awake') {
      return { action: 'answer', pending: 0, period, stayedUp: false }
    }
    const threshold = Number(this.policy?.outreach?.wakeAfterPendingMessages ?? 3)
    this.memory.todoAdd({ at: now.toISOString(), channel, text, actorUid: 'uncle' })
    const pending = this.memory.todoPending()
    if (pending > threshold) {
      return { action: 'wake', pending, period, stayedUp: true }
    }
    return { action: 'queue', pending, period, stayedUp: false }
  }

  /**
   * Record that she really was awake past bedtime, which costs tomorrow a slot.
   *
   * @param {Date} [now] - the instant she was seen awake.
   * @returns {{ recorded: boolean, lateMinutes: number, localDay: string }}
   */
  recordStayedUp(now = new Date()) {
    const lateMinutes = overshootMinutes(now, this.policy?.schedule ?? {})
    if (lateMinutes <= 0) return { recorded: false, lateMinutes: 0, localDay: this.dayKey(now) }
    const grace = Number(this.policy?.schedule?.lateNightGraceMinutes ?? 60)
    const localDay = this.dayKey(now)
    if (lateMinutes < grace) return { recorded: false, lateMinutes, localDay }
    const already = this.memory.recentLateNights(localDay).some((row) => row.localDay === localDay)
    if (already) return { recorded: false, lateMinutes, localDay }
    this.memory.markLateNight(localDay, now.toISOString(), lateMinutes)
    return { recorded: true, lateMinutes, localDay }
  }

  /** Everything that piled up overnight, and mark it read. */
  drainQueue() {
    return this.memory.todoDrain()
  }

  /** How many messages are still waiting. */
  pending() {
    return this.memory.todoPending()
  }

  /**
   * The overnight digest handed to her as one message when she wakes.
   *
   * @param {Array<{ at: string, text: string }>} rows - drained rows.
   * @returns {string} a single message body, or '' when there is nothing.
   */
  static digest(rows) {
    const usable = (rows ?? []).filter((row) => typeof row.text === 'string' && row.text.trim() !== '')
    if (usable.length === 0) return ''
    if (usable.length === 1) return usable[0].text
    return `（睡着的时候你发了好几条）${usable.map((row) => row.text).join(' / ')}`
  }
}
