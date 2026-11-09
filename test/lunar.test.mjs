/**
 * Lunar birthday maths. Pure functions, no DSH, no disk.
 *
 * Dates are local-time midnights; the conversion uses the ICU Chinese calendar
 * the same way the engine does, so these assertions double as a check that the
 * host's Node still ships `u-ca-chinese`.
 */

import { birthdayStatus, gregorianToLunar, lunarToGregorian } from '../packages/digital-life/lib/lunar.js'

const failures = []
function check(name, ok, detail = '') {
  if (!ok) failures.push(name)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
}

function ymd(date) {
  if (date === null) return 'null'
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

// ---- gregorian -> lunar ----------------------------------------------------
const spring = gregorianToLunar(new Date(2026, 1, 17)) // 正月初一
check('2026-02-17 是正月初一', spring.year === 2026 && spring.month === 1 && spring.day === 1, JSON.stringify(spring))

const autumn = gregorianToLunar(new Date(2026, 10, 8))
check('2026-11-08 是九月三十', autumn.year === 2026 && autumn.month === 9 && autumn.day === 30, JSON.stringify(autumn))

const jan = gregorianToLunar(new Date(2026, 0, 1))
check('元旦仍在上一个农历年', jan.year === 2025 && jan.month === 11, JSON.stringify(jan))

// ---- lunar -> gregorian ----------------------------------------------------
check('2026 农历九月廿八 = 2026-11-06', ymd(lunarToGregorian(2026, 9, 28)) === '2026-11-06', ymd(lunarToGregorian(2026, 9, 28)))
check('2026 正月初一 = 2026-02-17', ymd(lunarToGregorian(2026, 1, 1)) === '2026-02-17', ymd(lunarToGregorian(2026, 1, 1)))
check('不存在的农历日返回 null', lunarToGregorian(2026, 9, 31) === null)

// Round-trip a handful of dates through both directions.
let roundTrips = 0
for (const [year, month, day] of [[2026, 1, 1], [2026, 5, 5], [2026, 9, 28], [2026, 12, 1], [2025, 6, 15]]) {
  const date = lunarToGregorian(year, month, day)
  const back = date === null ? null : gregorianToLunar(date)
  if (back && back.year === year && back.month === month && back.day === day) roundTrips += 1
}
check('农历 → 公历 → 农历 往返一致（5 个日期）', roundTrips === 5, String(roundTrips))

// ---- birthday / age --------------------------------------------------------
const rule = { kind: 'lunar', month: 9, day: 28, birthYear: 2019, grows: true }

const onDay = birthdayStatus(rule, new Date(2026, 10, 6))
check('生日当天被认出来', onDay !== null && onDay.isBirthday === true)
check('生日当天 7 岁', onDay !== null && onDay.age === 7, String(onDay?.age))
check('生日当天 thisYear 是今天', onDay !== null && onDay.thisYear === '2026-11-06', String(onDay?.thisYear))
check('生日当天没有“下一个生日”距离', onDay !== null && onDay.daysUntil === 0, String(onDay?.daysUntil))

const before = birthdayStatus(rule, new Date(2026, 10, 5))
check('生日前一天还是 6 岁', before !== null && before.age === 6, String(before?.age))
check('生日前一天倒计时 1 天', before !== null && before.daysUntil === 1, String(before?.daysUntil))
check('生日前一天的 next 是明天', before !== null && before.next === '2026-11-06', String(before?.next))

const after = birthdayStatus(rule, new Date(2026, 10, 20))
check('生日过后是 7 岁', after !== null && after.age === 7, String(after?.age))
check('生日过后的 next 落在明年（1–400 天）', after !== null && after.daysUntil > 30 && after.daysUntil < 400, String(after?.daysUntil))
check('生日过后的 next 仍是农历九月廿八', after !== null && after.next !== null && gregorianToLunar(new Date(after.next + 'T00:00:00')).day === 28, String(after?.next))

const nextYear = birthdayStatus(rule, new Date(2027, 9, 1))
check('跨到下一农历年还能算出年龄', nextYear !== null && nextYear.age === 7, String(nextYear?.age))

check('不长的孩子年龄固定', birthdayStatus({ ...rule, grows: false, age: 7 }, new Date(2026, 10, 20))?.age === 7)
check('规则缺失时返回 null', birthdayStatus(null) === null)
check('非农历规则返回 null', birthdayStatus({ kind: 'solar', month: 1, day: 1 }) === null)
check('月日越界返回 null', birthdayStatus({ kind: 'lunar', month: 13, day: 1, birthYear: 2019 }) === null)
check('缺 birthYear 返回 null', birthdayStatus({ kind: 'lunar', month: 9, day: 28 }) === null)

// She is 7 today (2026-11-08, lunar 九月三十): the birthday just passed.
const now = birthdayStatus(rule, new Date(2026, 10, 8))
check('今天（2026-11-08）她 7 岁', now !== null && now.age === 7, String(now?.age))
check('今天不是生日', now !== null && now.isBirthday === false)

console.log(failures.length === 0 ? '\nall lunar checks passed' : `\n${failures.length} failed: ${failures.join(', ')}`)
process.exit(failures.length === 0 ? 0 : 1)
