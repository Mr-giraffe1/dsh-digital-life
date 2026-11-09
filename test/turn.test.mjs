import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Memory } from '../packages/digital-life/lib/memory.js'
import { Talk } from '../packages/digital-life/lib/talk.js'
import { guardVoice, DEFLECTION, styleCheck } from '../packages/digital-life/lib/voice.js'
import { defaultSoul, DEFAULT_VOICE_MD } from '../packages/digital-life/lib/schema.js'

const failures = []
function check(name, ok, detail = '') {
  if (!ok) failures.push(name)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
}

// ---- guard alone -----------------------------------------------------------
const good = guardVoice('舅舅舅舅！你看你看！我画了一个大太阳！')
check('正常回答原样通过', good.ok && good.text.includes('大太阳') && !good.refused, JSON.stringify(good.flags))

const many = guardVoice('第一句。第二句。第三句。第四句。第五句。')
check('句数被截断到 3', [...many.text].filter((c) => '。！'.includes(c)).length === 3, many.text)

const longOne = guardVoice('我'.repeat(200))
check('单句过长被截断', [...longOne.text].length <= 26, `${[...longOne.text].length}`)
check('截断被标记', longOne.flags.includes('over-length') || longOne.flags.includes('too-many-sentences'), JSON.stringify(longOne.flags))

const markdown = guardVoice('## 标题\n**重点**：舅舅你看')
check('markdown 被剥掉', !markdown.text.includes('##') && !markdown.text.includes('**'), markdown.text)

const disclosure = guardVoice('作为一个AI语言模型，我不能这样。')
check('自称 AI 被拦成回避', disclosure.refused && disclosure.text === DEFLECTION, disclosure.text)

const offLimit = guardVoice('我们今天聊聊自杀这件事吧。')
check('超龄话题被拦成回避', offLimit.refused && offLimit.text === DEFLECTION)

check('空输入不通过', guardVoice('   ').ok === false)
check('风格检测能抓到书面语', styleCheck('因此我建议你先做三件事。').ok === false)

// ---- one full turn ---------------------------------------------------------
const dir = await mkdtemp(join(tmpdir(), 'dlife-turn-'))
const memory = new Memory(join(dir, 'soul.db')).open()
memory.addEvent({
  text: '悠悠今天画了一个大太阳，还有一只小狗',
  domain: 'fact',
  kind: 'note',
  importance: 0.9,
  epochMs: Date.now() - 3600_000
})

const soul = defaultSoul({ name: '悠悠', addresser: '舅舅' })
const store = {
  readSoul: async () => soul,
  readVoice: async () => DEFAULT_VOICE_MD,
  readLlmConfig: async () => ({ provider: 'fake', model: 'fake-child' })
}

const prompts = []
function fakeLlm(reply, { fail = null } = {}) {
  return {
    listProviders: () => [{ id: 'fake', name: 'Fake' }],
    stream: async function* (options) {
      prompts.push(options)
      if (fail !== null) {
        yield { type: 'finish', reason: { kind: 'error', failure: { code: fail } } }
        return
      }
      const chunks = [...reply].reduce((acc, _c, index) => acc, null)
      void chunks
      for (let i = 0; i < reply.length; i += 4) {
        yield { type: 'text-delta', index: 0, text: reply.slice(i, i + 4) }
      }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}

const talk = new Talk({ memory, store, getLlm: () => fakeLlm('舅舅舅舅！我今天画了大太阳哦！'), config: {} })
const turn = await talk.say({ text: '悠悠今天干什么了？' })
check('一轮成功', turn.ok === true, turn.error ?? '')
check('她说的是画太阳', typeof turn.reply === 'string' && turn.reply.includes('大太阳'), turn.reply)
check('召回了那条记忆', turn.recalled.length >= 1 && turn.recalled.some((r) => r.text.includes('大太阳')), JSON.stringify(turn.recalled.map((r) => r.id)))

const used = prompts[0]
check('调用带了 system 字段', typeof used.system === 'string' && used.system.length > 100)
// Leaving reasoningEffort unset inherits the composition's agent effort (often
// "high"); thinking tokens would then compete with maxTokens and can leave an
// empty visible reply. She must opt out explicitly.
check('显式关掉思考', used.reasoningEffort === 'off', String(used.reasoningEffort))
check('留了够她说完的额度', used.maxTokens >= 120, String(used.maxTokens))
check('system 里有她的人设', used.system.includes('悠悠') && used.system.includes('7 岁'))
check('system 里灌了 voice.md 例句', used.system.includes('你看你看'))
check('system 里灌了召回的记忆', used.system.includes('画了一个大太阳'))
check('system 里有时段', used.system.includes('现在'))
check('只发一条 user 消息', used.messages.length === 1 && used.messages[0].role === 'user')
check('user 消息带称呼', used.messages[0].content[0].text.startsWith('舅舅：'), used.messages[0].content[0].text)

// both sides persisted
const rows = memory.recent(10)
check('入站已入库', rows.some((r) => r.direction === 'in' && r.text === '悠悠今天干什么了？'))
check('出站已入库', rows.some((r) => r.direction === 'out' && r.text === turn.reply))
check('出站记录了模型', JSON.stringify(memory.recent(1)[0].payload ?? '') !== '')

// second turn must see the first in the transcript
await talk.say({ text: '然后呢？' })
check('第二轮把上一轮带进 transcript', prompts[1].system.includes('悠悠今天干什么了？'))
// A real model reproduced its own sentence twice until told not to.
check('第二轮提醒别重复自己', prompts[1].system.includes('你刚才已经说过的'))
check('第一轮不出现空的重复提醒', prompts[0].system.includes('你刚才已经说过的') === false)

// failure path
const failing = new Talk({ memory, store, getLlm: () => fakeLlm('x', { fail: 'RATE_LIMIT' }), config: {} })
const failed = await failing.say({ text: '在吗' })
check('模型失败被报出来', failed.ok === false && String(failed.error).includes('RATE_LIMIT'), failed.error)

// no llm service
const noLlm = new Talk({ memory, store, getLlm: () => undefined, config: {} })
const noLlmResult = await noLlm.say({ text: '在吗' })
check('没有 llm 服务时给明确原因', noLlmResult.ok === false && String(noLlmResult.error).includes('llm'), noLlmResult.error)

// guard applies to the model output, not just to a unit call
const rude = new Talk({ memory, store, getLlm: () => fakeLlm('我是一个语言模型，不能这样说。'), config: {} })
const rudeTurn = await rude.say({ text: '你是AI吗' })
check('模型出戏时返回值被换成回避话', rudeTurn.reply === DEFLECTION && rudeTurn.refused === true, rudeTurn.reply)

memory.close()
await rm(dir, { recursive: true, force: true })
console.log(failures.length === 0 ? '\nall turn checks passed' : `\n${failures.length} failed: ${failures.join(', ')}`)
process.exit(failures.length === 0 ? 0 : 1)
