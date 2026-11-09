import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Memory } from '../packages/digital-life/lib/memory.js'
import { Life } from '../packages/digital-life/lib/life.js'
import { localDayOf, overshootMinutes, periodOf, precedingDays } from '../packages/digital-life/lib/clock.js'
import { DEFAULT_OUTREACH, DEFAULT_SCHEDULE } from '../packages/digital-life/lib/schema.js'

const failures = []
function check(name, ok, detail = '') {
  if (!ok) failures.push(name)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
}

/** A local Date with fixed clock parts. */
function at(hour, minute = 0, dayOffset = 0) {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset, hour, minute, 0, 0)
}

// ---- clock -----------------------------------------------------------------
check('午夜空闲时段是 late', periodOf(at(23, 40), DEFAULT_SCHEDULE) === 'late', periodOf(at(23, 40), DEFAULT_SCHEDULE))
check('凌晨是 quiet', periodOf(at(3, 0), DEFAULT_SCHEDULE) === 'quiet', periodOf(at(3, 0), DEFAULT_SCHEDULE))
check('下午是 awake', periodOf(at(15, 0), DEFAULT_SCHEDULE) === 'awake')
check('日界在 04:00：02:00 算前一天', localDayOf(at(2, 0), 4) === localDayOf(at(20, 0, -1), 4), `${localDayOf(at(2, 0), 4)} vs ${localDayOf(at(20, 0, -1), 4)}`)
check('远超睡前时间算出分钟数', overshootMinutes(at(1, 0), DEFAULT_SCHEDULE) === 90, String(overshootMinutes(at(1, 0), DEFAULT_SCHEDULE)))
check('醒着时超时为 0', overshootMinutes(at(15, 0), DEFAULT_SCHEDULE) === 0)
const days = precedingDays('2026-03-02', 3)
check('跨月往前推日期正确', days.join(',') === '2026-03-01,2026-02-28,2026-02-27', days.join(','))

// ---- engine ----------------------------------------------------------------
const dir = await mkdtemp(join(tmpdir(), 'dlife-life-'))
const memory = new Memory(join(dir, 'soul.db')).open()
const policy = { outreach: { ...DEFAULT_OUTREACH }, schedule: { ...DEFAULT_SCHEDULE } }
const life = new Life({ memory, policy })

check('白天来消息直接回答', life.onInbound({ now: at(15, 0), text: '在吗' }).action === 'answer')
check('白天不入待办', life.pending() === 0)

const quiet = life.onInbound({ now: at(23, 40), text: '睡了吗' })
check('睡后来消息进待办', quiet.action === 'queue' && quiet.pending === 1, JSON.stringify(quiet))
// Queueing means she is asleep: the message waits, so nothing keeps her up.
check('只是排队不算她熬夜', quiet.stayedUp === false)

life.onInbound({ now: at(23, 41), text: '在吗' })
life.onInbound({ now: at(23, 42), text: '喂' })
check('三条还没到阈值', life.pending() === 3)
const woke = life.onInbound({ now: at(23, 43), text: '悠悠' })
check('第四条叫醒她', woke.action === 'wake' && woke.pending === 4, JSON.stringify(woke))
const drained = life.drainQueue()
check('醒来后待办清空', life.pending() === 0 && drained.length === 4, String(drained.length))
check('摘要带上条数提示', Life.digest(drained).includes('睡着的时候'), Life.digest(drained).slice(0, 30))
check('单条摘要不加前缀', Life.digest([{ text: '就一句' }]) === '就一句')

// ---- late night + quota ----------------------------------------------------
const early = life.recordStayedUp(at(23, 40))
check('刚过点不算熬夜（宽限内）', early.recorded === false, String(early.lateMinutes))
const late1 = life.recordStayedUp(at(1, 0))
check('超过宽限记为熬夜', late1.recorded === true, String(late1.lateMinutes))
check('同一天不重复记', life.recordStayedUp(at(1, 30)).recorded === false)

const q0 = life.quota(at(15, 0))
check('首次熬夜次日配额减一', q0.cap === 2, `cap=${q0.cap} late=${q0.lateNights}`)

life.recordStayedUp(at(1, 0, -1))
life.recordStayedUp(at(1, 0, -2))
const q3 = life.quota(at(15, 0))
check('连续熬夜触底保底 1', q3.cap === 1, `cap=${q3.cap} late=${q3.lateNights}`)

check('配额能花掉', life.spend(at(15, 0)) === true)
check('花完就不能再花', life.spend(at(15, 0)) === false)
const qUsed = life.quota(at(15, 0))
check('用掉一格后剩 0', qUsed.used === 1 && qUsed.left === 0, JSON.stringify(qUsed))

// three clean nights must restore the base
const clean = new Life({ memory, policy })
memory.db.exec('DELETE FROM violation')
memory.db.exec('DELETE FROM quota')
check('清空熬夜记录后回满基础配额', clean.quota(at(15, 0)).cap === 3, String(clean.quota(at(15, 0)).cap))

memory.close()
await rm(dir, { recursive: true, force: true })
console.log(failures.length === 0 ? '\nall life checks passed' : `\n${failures.length} failed: ${failures.join(', ')}`)
process.exit(failures.length === 0 ? 0 : 1)
