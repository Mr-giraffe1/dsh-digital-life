import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Memory } from '../packages/digital-life/lib/memory.js'
import { Feed, parseBalance, readDeepSeekToppedUp } from '../packages/digital-life/lib/feed.js'

const failures = []
function check(name, ok, detail = '') {
  if (!ok) failures.push(name)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
}

// ---- balance parsing -------------------------------------------------------
const parsed = parseBalance({
  is_available: true,
  balance_infos: [{ currency: 'CNY', total_balance: '42.50', granted_balance: '2.50', topped_up_balance: '40.00' }]
})
check('解析出累计充值', parsed.toppedUp === 40, String(parsed.toppedUp))
check('解析出余额与赠金', parsed.total === 42.5 && parsed.granted === 2.5)
check('缺字段不臆造 0', parseBalance({ balance_infos: [{}] }).toppedUp === null)

// ---- HTTP reader, with a stubbed fetch ------------------------------------
let seenUrl = null
let seenAuth = null
const stubFetch = async (url, init) => {
  seenUrl = url
  seenAuth = init?.headers?.authorization
  return {
    ok: true,
    status: 200,
    json: async () => ({ balance_infos: [{ topped_up_balance: '40.00', total_balance: '42.50' }] })
  }
}
const read = await readDeepSeekToppedUp('sk-test', stubFetch)
check('读到累计充值', read.ok && read.toppedUp === 40, JSON.stringify(read))
check('打到正确的端点', seenUrl === 'https://api.deepseek.com/user/balance', String(seenUrl))
check('带 Bearer 头', seenAuth === 'Bearer sk-test', String(seenAuth))

const unauthorized = await readDeepSeekToppedUp('sk-bad', async () => ({ ok: false, status: 401, json: async () => ({}) }))
check('401 有明确错误', unauthorized.ok === false && unauthorized.status === 401, JSON.stringify(unauthorized))

const offline = await readDeepSeekToppedUp('sk-x', async () => {
  throw new Error('getaddrinfo ENOTFOUND')
})
check('网络失败不抛', offline.ok === false && String(offline.error).includes('ENOTFOUND'))

// ---- the interaction -------------------------------------------------------
const dir = await mkdtemp(join(tmpdir(), 'dlife-feed-'))
const dirForPortrait = join(dir, 'root')
const memory = new Memory(join(dir, 'soul.db')).open()

const store = {
  readInterop: async () => ({ say: '舅舅！大米饭！', memory: { importance: 0.6 } })
}

let balance = 40
const feed = new Feed({
  memory,
  store,
  readToppedUp: async () => balance
})

const first = await feed.check(new Date())
check('第一次只记基线，不说', first.ok && first.kind === 'baseline' && first.toppedUp === 40, JSON.stringify(first))

balance = 40
const same = await feed.check(new Date())
check('余额没变不触发', same.kind === 'unchanged', JSON.stringify(same))

balance = 55
const fed = await feed.check(new Date())
check('充值被认出来', fed.kind === 'recharged' && fed.delta === 15, JSON.stringify(fed))
check('她说了那句话', fed.said === '舅舅！大米饭！', fed.said)
check('体感域记了一条', memory.stats().domains.somatic === 1, JSON.stringify(memory.stats()))
const fedRow = memory.recent(1)[0]
check('事件类型是 fed', fedRow.kind === 'fed' && fedRow.domain === 'somatic')
const fedPayload = memory.db.prepare("SELECT payload FROM event WHERE kind = 'fed' ORDER BY id DESC LIMIT 1").get()
check('事件里存了增量', String(fedPayload?.payload).includes('15'), String(fedPayload?.payload).slice(0, 80))

const again = await feed.check(new Date())
check('同一笔充值不重复触发', again.kind === 'unchanged', JSON.stringify(again))

// spending money must NOT look like a recharge
balance = 41
const spent = await feed.check(new Date())
check('只花钱不算充值', spent.kind === 'unchanged' && spent.delta === 0, JSON.stringify(spent))

// a second visit after spending still works when real money arrives
balance = 61
const second = await feed.check(new Date())
check('第二次充值也认得出', second.kind === 'recharged' && second.delta === 20, JSON.stringify(second))

// missing credential
const noKey = new Feed({ memory, store, readToppedUp: async () => null })
const missing = await noKey.check(new Date())
check('拿不到余额时给 unavailable', missing.ok === false && missing.kind === 'unavailable', JSON.stringify(missing))

// recall must find the rice memory
const recalled = memory.recall('大米饭')
check('大米饭能被召回', recalled.length >= 1, JSON.stringify(recalled.map((r) => r.text)))

memory.close()
await rm(dir, { recursive: true, force: true })
void dirForPortrait
console.log(failures.length === 0 ? '\nall feed checks passed' : `\n${failures.length} failed: ${failures.join(', ')}`)
process.exit(failures.length === 0 ? 0 : 1)
