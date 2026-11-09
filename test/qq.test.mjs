import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OneBot, OneBotError, classifyEvent } from '../packages/digital-life/lib/onebot.js'
import { QqChannel } from '../packages/digital-life/lib/qq.js'
import { Memory } from '../packages/digital-life/lib/memory.js'
import { Talk } from '../packages/digital-life/lib/talk.js'
import { DEFAULT_VOICE_MD, defaultSoul } from '../packages/digital-life/lib/schema.js'

const failures = []
function check(name, ok, detail = '') {
  if (!ok) failures.push(name)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
}

// ---- event classification --------------------------------------------------
const privateText = classifyEvent({
  post_type: 'message',
  message_type: 'private',
  user_id: 10001,
  message: [{ type: 'text', data: { text: '悠悠在吗' } }],
  sender: { nickname: '舅舅' },
  message_id: 7
}, { selfId: 99999 })
check('私聊文本能解析', privateText.scope === 'private' && privateText.text === '悠悠在吗', JSON.stringify(privateText))
check('解析出昵称与消息 id', privateText.nickname === '舅舅' && privateText.messageId === '7')

const atMe = classifyEvent({
  post_type: 'message',
  message_type: 'group',
  group_id: 555,
  user_id: 10001,
  message: [
    { type: 'at', data: { qq: '99999' } },
    { type: 'text', data: { text: ' 悠悠说句话' } }
  ]
}, { selfId: 99999 })
check('群聊点名能识别', atMe.scope === 'group' && atMe.mentioned === true && atMe.text === '悠悠说句话', JSON.stringify(atMe))
check('群号被记下', atMe.groupId === '555')

const notMe = classifyEvent({
  post_type: 'message',
  message_type: 'group',
  group_id: 555,
  user_id: 10001,
  message: [{ type: 'at', data: { qq: '12345' } }, { type: 'text', data: { text: '在吗' } }]
}, { selfId: 99999 })
check('点别人不算点名', notMe.mentioned === false)

check('非消息事件不管', classifyEvent({ post_type: 'notice' }) === null)
check('自己的消息不管', classifyEvent({ post_type: 'message', message_type: 'private', user_id: 99999, message: 'x' }, { selfId: 99999 }) === null)
check('纯图片不算说话', classifyEvent({ post_type: 'message', message_type: 'private', user_id: 1, message: [{ type: 'image', data: {} }] }) === null)
check('CQ 码能剥掉', classifyEvent({
  post_type: 'message', message_type: 'private', user_id: 1, message: '[CQ:face,id=1]你好'
}, {}).text === '你好')

// ---- a fake protocol endpoint ---------------------------------------------
const calls = []
const server = createServer(async (req, res) => {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const body = chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8'))
  calls.push({ path: req.url, body, auth: req.headers.authorization })
  res.setHeader('content-type', 'application/json')
  if (req.url === '/get_login_info') {
    res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { user_id: 99999, nickname: '悠悠的号' } }))
    return
  }
  if (req.url === '/send_private_msg') {
    res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 42 } }))
    return
  }
  if (req.url === '/send_group_msg') {
    res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 43 } }))
    return
  }
  res.statusCode = 404
  res.end(JSON.stringify({ status: 'failed', retcode: 404, message: 'no such action' }))
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const baseUrl = `http://127.0.0.1:${server.address().port}`

const client = new OneBot({ baseUrl, token: 'secret' })
const health = await client.health()
check('探活拿到自己的号', health.state === 'bound' && health.selfId === '99999', JSON.stringify(health))
check('请求带了 Bearer token', calls[0].auth === 'Bearer secret', String(calls[0].auth))

await client.send({ scope: 'private', userId: '10001', text: '在呀' })
check('私聊发送路径正确', calls.at(-1).path === '/send_private_msg')
check('私聊 payload 用数字 user_id', calls.at(-1).body.user_id === 10001 && calls.at(-1).body.message === '在呀', JSON.stringify(calls.at(-1).body))

await client.send({ scope: 'group', groupId: '555', text: '我来啦' })
check('群聊发送路径正确', calls.at(-1).path === '/send_group_msg')
check('群聊 payload 用数字 group_id', calls.at(-1).body.group_id === 555, JSON.stringify(calls.at(-1).body))

let refused = null
try {
  await client.call('nope')
} catch (error) {
  refused = error
}
check('未知动作抛 OneBotError', refused instanceof OneBotError && refused.retcode === 404, String(refused?.message))

const deadClient = new OneBot({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 500 })
const deadHealth = await deadClient.health()
check('连不上时 health 报 unbound 而不是抛', deadHealth.state === 'unbound', deadHealth.detail)

// ---- the channel -----------------------------------------------------------
const dir = await mkdtemp(join(tmpdir(), 'dlife-qq-'))
const memory = new Memory(join(dir, 'soul.db')).open()
const soul = defaultSoul({ name: '悠悠', addresser: '舅舅' })
const store = {
  readChannel: async () => ({ enabled: true, baseUrl, ownerId: '10001', selfId: '99999', allowGroups: false, requireMention: true }),
  readCredential: async () => ({ token: 'secret' }),
  readSoul: async () => soul,
  readVoice: async () => DEFAULT_VOICE_MD,
  readLlmConfig: async () => ({ provider: 'fake', model: 'fake-child' })
}
const llm = {
  listProviders: () => [{ id: 'fake', name: 'Fake' }],
  stream: async function* () {
    const text = '在呀舅舅！我刚在画画。'
    for (let i = 0; i < text.length; i += 4) yield { type: 'text-delta', index: 0, text: text.slice(i, i + 4) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
const talk = new Talk({ memory, store, getLlm: () => llm, config: {} })
const events = []
const qq = new QqChannel({ store, talk, emit: (event, payload) => events.push({ event, payload }) })
await qq.load()
check('健康检查把状态置为 bound', (await qq.checkHealth()).state === 'bound')

const before = calls.length
const handled = await qq.handleEvent({
  post_type: 'message',
  message_type: 'private',
  user_id: 10001,
  message: [{ type: 'text', data: { text: '在干嘛' } }],
  sender: { nickname: '舅舅' }
})
check('私聊被处理', handled.handled === true && handled.replied === true, JSON.stringify(handled))
check('真的发了出去', calls.length === before + 1 && calls.at(-1).path === '/send_private_msg', String(calls.at(-1)?.path))
check('发的是她的话', calls.at(-1).body.message.includes('画画'), calls.at(-1).body.message)
check('她的话进了记忆', memory.recent(2).some((row) => row.direction === 'out' && row.channel === 'qq'), JSON.stringify(memory.recent(2).map((r) => r.channel)))

const stranger = await qq.handleEvent({
  post_type: 'message', message_type: 'private', user_id: 20002, message: [{ type: 'text', data: { text: '你好呀' } }]
})
check('陌生人她不理', stranger.handled === false && String(stranger.reason).includes('舅舅'), JSON.stringify(stranger))

const groupNoAt = await qq.handleEvent({
  post_type: 'message', message_type: 'group', group_id: 555, user_id: 10001,
  message: [{ type: 'text', data: { text: '今天天气不错' } }]
})
check('群里没点名不搭话', groupNoAt.handled === false, JSON.stringify(groupNoAt))

const groupAt = await qq.handleEvent({
  post_type: 'message', message_type: 'group', group_id: 555, user_id: 10001,
  message: [{ type: 'at', data: { qq: '99999' } }, { type: 'text', data: { text: ' 悠悠你来说说' } }]
})
check('群聊默认关闭，即使点名也不说', groupAt.handled === false && String(groupAt.reason).includes('群聊'), JSON.stringify(groupAt))

// enable groups explicitly
const groupQq = new QqChannel({
  store: { ...store, readChannel: async () => ({ enabled: true, baseUrl, ownerId: '10001', selfId: '99999', allowGroups: true, requireMention: true }) },
  talk,
  emit: (event, payload) => events.push({ event, payload })
})
await groupQq.load()
const groupOk = await groupQq.handleEvent({
  post_type: 'message', message_type: 'group', group_id: 555, user_id: 10001,
  message: [{ type: 'at', data: { qq: '99999' } }, { type: 'text', data: { text: ' 悠悠你来说说' } }]
})
check('打开群聊后点名会回答', groupOk.handled === true && groupOk.replied === true, JSON.stringify(groupOk))
check('回答走群消息接口', calls.at(-1).path === '/send_group_msg', String(calls.at(-1)?.path))

memory.close()
await new Promise((resolve) => server.close(resolve))
await rm(dir, { recursive: true, force: true })
console.log(failures.length === 0 ? '\nall qq checks passed' : `\n${failures.length} failed: ${failures.join(', ')}`)
process.exit(failures.length === 0 ? 0 : 1)
