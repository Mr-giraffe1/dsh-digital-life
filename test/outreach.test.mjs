import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Memory } from '../packages/digital-life/lib/memory.js'
import { Life } from '../packages/digital-life/lib/life.js'
import { Outreach } from '../packages/digital-life/lib/outreach.js'
import { DEFAULT_OUTREACH, DEFAULT_SCHEDULE, DEFAULT_VOICE_MD, defaultSoul } from '../packages/digital-life/lib/schema.js'

const failures = []
function check(name, ok, detail = '') {
  if (!ok) failures.push(name)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
}

/** A local Date with fixed clock parts. */
function at(hour, minute = 0) {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0)
}

const dir = await mkdtemp(join(tmpdir(), 'dlife-out-'))
const memory = new Memory(join(dir, 'soul.db')).open()
const policy = { outreach: { ...DEFAULT_OUTREACH }, schedule: { ...DEFAULT_SCHEDULE } }
const life = new Life({ memory, policy })

const soul = defaultSoul({ name: '悠悠', addresser: '舅舅' })
const store = {
  readSoul: async () => soul,
  readVoice: async () => DEFAULT_VOICE_MD,
  readLlmConfig: async () => ({ provider: 'fake', model: 'fake-child' })
}

const spoken = []
const seenOptions = []
const fakeLlm = {
  listProviders: () => [{ id: 'fake', name: 'Fake' }],
  stream: async function* (options) {
    seenOptions.push(options)
    const lines = ['舅舅舅舅！我刚才画了一只小狗。', '你看你看，它的鼻子是这样的！']
    const text = spoken.length === 0 ? lines[0] : lines[spoken.length % lines.length]
    for (let i = 0; i < text.length; i += 4) {
      yield { type: 'text-delta', index: 0, text: text.slice(i, i + 4) }
    }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const outreach = new Outreach({ memory, store, life, policy, getLlm: () => fakeLlm })

// ---- gates -----------------------------------------------------------------
check('睡着时不开口', outreach.shouldSpeak(at(2, 0)).go === false, outreach.shouldSpeak(at(2, 0)).reason)
check('安静时段即使有配额也不说', outreach.shouldSpeak(at(23, 45)).go === false)
check('白天想说话', outreach.shouldSpeak(at(15, 0)).go === true, outreach.shouldSpeak(at(15, 0)).reason)

memory.todoAdd({ channel: 'desktop', text: '半夜的一条' })
check('有待办时不插嘴', outreach.shouldSpeak(at(15, 0)).go === false, outreach.shouldSpeak(at(15, 0)).reason)
memory.todoDrain()

// ---- one spontaneous line --------------------------------------------------
const first = await outreach.maybeSpeak({ now: at(15, 0) })
check('说出一句话', first.ok === true && first.spoke === true, JSON.stringify(first))
check('说的话像她', typeof first.text === 'string' && first.text.includes('小狗'), first.text)
check('主动开口也关掉思考', seenOptions[0]?.reasoningEffort === 'off', String(seenOptions[0]?.reasoningEffort))
check('主动开口的 prompt 带"不是舅舅在说话"', String(seenOptions[0]?.system).includes('不是舅舅在跟你说话'))
check('记为 proactive', memory.recent(1)[0].kind === 'proactive' && memory.recent(1)[0].direction === 'out')
check('花掉一次配额', life.quota(at(15, 0)).used === 1, JSON.stringify(life.quota(at(15, 0))))

// ---- cooldown --------------------------------------------------------------
const tooSoon = await outreach.maybeSpeak({ now: at(15, 10) })
check('十分钟内不重复开口', tooSoon.ok === true && tooSoon.spoke === false, tooSoon.reason)

// ---- ignored twice stops her ----------------------------------------------
const later = await outreach.maybeSpeak({ now: at(16, 0) })
check('冷却过了会说第二句', later.ok && later.spoke === true, JSON.stringify(later.reason ?? later.text))
check('两条都没人理，连击是 2', outreach.ignoreStreak() === 2, String(outreach.ignoreStreak()))
const stopped = await outreach.maybeSpeak({ now: at(17, 0) })
check('没人理就不说了', stopped.spoke === false && String(stopped.reason).includes('没人理'), stopped.reason)

// answering her resets the streak
memory.addEvent({
  at: at(16, 30).toISOString(),
  text: '小狗好可爱！',
  domain: 'fact',
  kind: 'message',
  direction: 'in',
  channel: 'desktop'
})
check('有人回了，连击清零', outreach.ignoreStreak() === 0, String(outreach.ignoreStreak()))
const resumed = await outreach.maybeSpeak({ now: at(18, 0) })
check('有人理之后又能说了', resumed.spoke === true, JSON.stringify(resumed.reason ?? resumed.text))

// ---- quota floor -----------------------------------------------------------
// Fresh ledger: earlier sections already spent the day's slots.
memory.db.exec('DELETE FROM quota')
memory.db.exec('DELETE FROM event')
const tightPolicy = { ...policy, outreach: { ...policy.outreach, baseQuotaPerDay: 1, minimumQuotaPerDay: 1 } }
const tight = new Outreach({
  memory,
  store,
  life: new Life({ memory, policy: tightPolicy }),
  policy: tightPolicy,
  getLlm: () => fakeLlm
})
const one = await tight.maybeSpeak({ now: at(19, 0) })
check('只有一次配额时说了', one.spoke === true, JSON.stringify(one.reason ?? one.text))
const noMore = await tight.maybeSpeak({ now: at(21, 0) })
check('配额用完就不说', noMore.spoke === false && String(noMore.reason).includes('用完'), noMore.reason)

// ---- no model --------------------------------------------------------------
memory.db.exec('DELETE FROM event')
const noModel = new Outreach({ memory, store, life, policy, getLlm: () => undefined })
const fail = await noModel.maybeSpeak({ now: at(15, 0) })
check('没有模型时给明确错误', fail.ok === false && String(fail.error).includes('llm'), fail.error)

// ---- the guard also applies to spontaneous lines ---------------------------
memory.db.exec('DELETE FROM event')
memory.db.exec('DELETE FROM quota')
const leaky = new Outreach({
  memory,
  store,
  life,
  policy,
  getLlm: () => ({
    listProviders: () => [{ id: 'fake', name: 'Fake' }],
    stream: async function* () {
      const text = '我是一个语言模型，不能这样说。'
      for (let i = 0; i < text.length; i += 4) yield { type: 'text-delta', index: 0, text: text.slice(i, i + 4) }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  })
})
const deflected = await leaky.maybeSpeak({ now: at(15, 0) })
check('主动开口也过护栏', deflected.spoke === true && deflected.text.includes('听不懂'), deflected.text)

memory.close()
await rm(dir, { recursive: true, force: true })
console.log(failures.length === 0 ? '\nall outreach checks passed' : `\n${failures.length} failed: ${failures.join(', ')}`)
process.exit(failures.length === 0 ? 0 : 1)
