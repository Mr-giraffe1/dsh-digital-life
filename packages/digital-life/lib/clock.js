/**
 * Her clock. One definition, used by the route layer, the life engine and tests.
 *
 * The day boundary is 04:00 local, not midnight: staying up late is not
 * "tomorrow", and it must not silently reset her proactive quota.
 */

/** Parse 'HH:MM' into minutes since midnight; null when malformed. */
export function parseClock(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? ''))
  if (match === null) return null
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) return null
  return hours * 60 + minutes
}

/** Minutes since local midnight. */
export function minuteOfDay(date) {
  return date.getHours() * 60 + date.getMinutes()
}

/**
 * The local day key, with an arbitrary hour as the boundary.
 *
 * @param {Date} date - the instant.
 * @param {number} [boundaryHour] - hour the day starts, default 4.
 * @returns {string} 'YYYY-MM-DD'
 */
export function localDayOf(date, boundaryHour = 4) {
  const shifted = new Date(date.getTime() - boundaryHour * 3600_000)
  const year = shifted.getFullYear()
  const month = String(shifted.getMonth() + 1).padStart(2, '0')
  const day = String(shifted.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * Which part of her day it is.
 *
 * @param {Date} date - the instant.
 * @param {{ sleepAt?: string, wakeAt?: string }} [schedule] - her fixed table.
 * @returns {'awake' | 'quiet' | 'late'} quiet = after bedtime, late = after midnight.
 */
export function periodOf(date, schedule = {}) {
  const sleep = parseClock(schedule?.sleepAt ?? '23:30') ?? 23 * 60 + 30
  const wake = parseClock(schedule?.wakeAt ?? '08:00') ?? 8 * 60
  const minute = minuteOfDay(date)
  const inQuietHours = sleep > wake ? minute >= sleep || minute < wake : minute >= sleep && minute < wake
  if (!inQuietHours) return 'awake'
  return minute >= sleep ? 'late' : 'quiet'
}

/**
 * How far past her bedtime it is, in minutes; 0 while it is not.
 *
 * @param {Date} date - the instant.
 * @param {{ sleepAt?: string }} [schedule] - her fixed table.
 * @returns {number} minutes past bedtime, or 0.
 */
export function overshootMinutes(date, schedule = {}) {
  if (periodOf(date, schedule) === 'awake') return 0
  const sleep = parseClock(schedule?.sleepAt ?? '23:30') ?? 23 * 60 + 30
  const minute = minuteOfDay(date)
  return minute >= sleep ? minute - sleep : 24 * 60 - sleep + minute
}

/** Local day keys for the `count` days before `localDay` (newest first). */
export function precedingDays(localDay, count) {
  const [year, month, day] = localDay.split('-').map(Number)
  const keys = []
  for (let i = 1; i <= count; i += 1) {
    const date = new Date(year, month - 1, day - i)
    keys.push(localDayOf(new Date(date.getTime() + 12 * 3600_000), 0))
  }
  return keys
}
