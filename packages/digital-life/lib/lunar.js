/**
 * Lunar birthday arithmetic — zero dependencies, no bundled 1900–2100 table.
 *
 * ARCHITECTURE.md §12 assumed a hand-copied lunar table. Node ships ICU with the
 * Chinese calendar (`u-ca-chinese`), so `Intl.DateTimeFormat` can do the
 * conversion exactly, without ~200 hand-typed constants that nobody can audit.
 * Only arithmetic + one formatter are used, so nothing here violates the
 * "node: builtins only" constraint.
 *
 * Two directions are needed:
 *   - lunar -> gregorian: ICU has no direct API, so we scan the candidate span
 *     one day at a time and match (lunar year, month, day). ~430 formatToParts
 *     calls, cached per rule, so it happens once per year at most.
 *   - gregorian -> lunar: one formatToParts call.
 *
 * Leap months: ICU reports a leap month with the same month number as the month
 * it repeats. Scanning forward and taking the first match therefore yields the
 * regular month, which is what a birthday means (a leap 九月 birthday is an
 * oddity in itself; celebrating in the regular month is the sane default).
 */

/** @type {Intl.DateTimeFormat | null} */
let formatter = null

function lunarFormatter() {
  if (formatter === null) {
    formatter = new Intl.DateTimeFormat('en-u-ca-chinese', {
      year: 'numeric',
      month: 'numeric',
      day: 'numeric'
    })
  }
  return formatter
}

/**
 * The lunar date a Gregorian instant falls on.
 *
 * @param {Date} date - any instant.
 * @returns {{ year: number, month: number, day: number }} lunar year and fields.
 */
export function gregorianToLunar(date) {
  const parts = lunarFormatter().formatToParts(date)
  let year = NaN
  let month = NaN
  let day = NaN
  for (const part of parts) {
    // ICU reports the Chinese calendar's year as `relatedYear`; some versions
    // use `year` instead, so accept both and let the check below catch garbage.
    if (part.type === 'relatedYear' || part.type === 'year') year = Number(part.value)
    if (part.type === 'month') month = Number(part.value)
    if (part.type === 'day') day = Number(part.value)
  }
  return { year, month, day }
}

/** @type {Map<string, string>} */
const birthdayCache = new Map()

function dayKey(date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * The Gregorian date of one lunar (year, month, day).
 *
 * @param {number} lunarYear - lunar year (the `relatedYear` ICU reports).
 * @param {number} month - lunar month, 1-based.
 * @param {number} day - lunar day, 1-based.
 * @returns {Date | null} midnight-local date, or null when it does not exist.
 */
export function lunarToGregorian(lunarYear, month, day) {
  const key = `${lunarYear}-${month}-${day}`
  const cached = birthdayCache.get(key)
  if (cached !== undefined) {
    const [year, month0, day0] = cached.split('-').map(Number)
    return new Date(year, month0 - 1, day0)
  }

  // A lunar year starts between late January and late February of the same
  // Gregorian year, and ends ~12 months later. Scanning from Jan 15 of `lunarYear`
  // through mid-March of `lunarYear + 1` covers every case including a leap
  // month at the very end of the year.
  const start = new Date(lunarYear, 0, 15)
  const end = new Date(lunarYear + 1, 2, 20)
  for (const cursor = new Date(start); cursor <= end; cursor.setDate(cursor.getDate() + 1)) {
    const lunar = gregorianToLunar(cursor)
    if (lunar.year !== lunarYear || lunar.month !== month || lunar.day !== day) continue
    const found = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate())
    birthdayCache.set(key, dayKey(found))
    return found
  }
  return null
}

/**
 * Her age right now, plus where the next birthday falls.
 *
 * `ageRule` is `portrait/soul.json`'s `ageRule`: `{ kind: 'lunar', month, day,
 * birthYear, grows }`. A rule that is missing or malformed yields `null`, so a
 * hand-edited soul.json degrades to "no birthday maths" instead of throwing.
 *
 * @param {object | null | undefined} ageRule - the rule from soul.json.
 * @param {Date} [now] - the instant.
 * @returns {null | { age: number, isBirthday: boolean, thisYear: string | null, next: string | null, daysUntil: number | null, rule: object }}
 */
export function birthdayStatus(ageRule, now = new Date()) {
  if (ageRule === null || typeof ageRule !== 'object') return null
  if (ageRule.kind !== 'lunar') return null
  const month = Number(ageRule.month)
  const day = Number(ageRule.day)
  const birthYear = Number(ageRule.birthYear)
  if (!Number.isInteger(month) || !Number.isInteger(day) || !Number.isInteger(birthYear)) return null
  if (month < 1 || month > 12 || day < 1 || day > 30) return null

  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const lunarNow = gregorianToLunar(today)
  const isBirthday = lunarNow.month === month && lunarNow.day === day

  // Compare lunar (month, day) pairs to decide whether this lunar year's
  // birthday has already happened — same year, so month major / day minor.
  const passed = lunarNow.month > month || (lunarNow.month === month && lunarNow.day > day)
  const age = ageRule.grows === false
    ? Number(ageRule.age ?? 0)
    : (lunarNow.year - birthYear - (passed || isBirthday ? 0 : 1))

  let thisYear = null
  if (isBirthday) {
    thisYear = dayKey(today)
  } else if (passed) {
    const date = lunarToGregorian(lunarNow.year, month, day)
    thisYear = date === null ? null : dayKey(date)
  }

  const nextLunarYear = isBirthday || passed ? lunarNow.year + 1 : lunarNow.year
  const nextDate = isBirthday ? null : lunarToGregorian(nextLunarYear, month, day)
  const next = nextDate === null ? null : dayKey(nextDate)
  const daysUntil = nextDate === null
    ? 0
    : Math.round((nextDate.getTime() - today.getTime()) / 86_400_000)

  return {
    age: Number.isFinite(age) ? age : 0,
    isBirthday,
    thisYear,
    next,
    daysUntil,
    rule: { kind: 'lunar', month, day, birthYear, grows: ageRule.grows !== false }
  }
}
