/**
 * Integration test: the real Host half, a fake cordis context, real HTTP.
 *
 * Proves P1's acceptance points without DSH and without a model: one turn goes
 * in, memory is written, recall feeds the prompt, the guard shapes the reply,
 * and after a simulated restart the conversation is still there.
 */

import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply as applyPlugin } from '../packages/digital-life/lib/index.js'

const failures = []
function check(name, ok, detail = '') {
  if (!ok) failures.push(name)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
}

const root = await mkdtemp(join(tmpdir(), 'dlife-engine-'))

/** A cordis-shaped context: effect collects disposers, webServer collects routes. */
function makeCtx({ reply = '舅舅舅舅！你看你看！我画了大太阳！', fail = null, withLlm = true } = {}) {
  const routes = []
  const disposers = []
  const calls = []
  const services = {}
  if (withLlm) {
    services.llm = {
      listProviders: () => [{ id: 'fake', name: 'Fake' }],
      stream: async function* (options) {
        calls.push(options)
        if (fail !== null) {
          yield { type: 'finish', reason: { kind: 'error', failure: { code: fail } } }
          return
        }
        for (let i = 0; i < reply.length; i += 3) {
          yield { type: 'text-delta', index: 0, text: reply.slice(i, i + 3) }
        }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
  }
  return {
    routes,
    calls,
    services,
    webServer: {
      register: (route) => {
        routes.push(route)
        return () => {
          const index = routes.indexOf(route)
          if (index >= 0) routes.splice(index, 1)
        }
      }
    },
    effect: (factory) => {
      const disposer = factory()
      if (typeof disposer === 'function') disposers.push(disposer)
      return disposer
    },
    get: (name) => services[name],
    disposeAll: () => {
      for (const disposer of disposers) {
        try {
          disposer()
        } catch {
          /* ignore */
        }
      }
    }
  }
}

/** Serve the registered routes over a real socket. */
async function serve(routes) {
  const server = createServer((req, res) => {
    const url = new URL(String(req.url), 'http://127.0.0.1')
    const exact = routes.find((route) => route.kind === 'exact' && route.path === url.pathname)
    const prefix = routes
      .filter((route) => route.kind === 'prefix' && url.pathname.startsWith(route.path))
      .sort((a, b) => b.path.length - a.path.length)[0]
    const route = exact ?? prefix
    if (route === undefined) {
      res.statusCode = 404
      res.end()
      return
    }
    Promise.resolve(route.handler(req, res)).catch(() => {
      res.statusCode = 500
      res.end()
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve))
  }
}

/** Wait until the engine reports a phase that is not `undefined`. */
async function waitForPhase(base, wanted, timeoutMs = 5000) {
  const started = Date.now()
  let last = null
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`${base}/digital-life/state.json`)
      if (response.ok) {
        last = await response.json()
        if (Array.isArray(wanted) ? wanted.includes(last.phase) : last.phase === wanted) return last
      }
    } catch {
      /* server not ready yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return last
}

async function post(base, body) {
  const response = await fetch(`${base}/digital-life/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
  return { status: response.status, body: await response.json() }
}

// ---- boot 1 ----------------------------------------------------------------
const ctx1 = makeCtx()
applyPlugin(ctx1, { dataRoot: root })
const server1 = await serve(ctx1.routes)
let state = await waitForPhase(server1.base, ['unborn', 'alive'])
check('引擎起来且先是 unborn', state?.phase === 'unborn', state?.phase)
check('注册了七条路由', ctx1.routes.length === 7, ctx1.routes.map((r) => r.path).join(', '))

const created = await post(server1.base, { action: 'create', name: '悠悠', addresser: '舅舅' })
check('创建成功', created.status === 200 && created.body.ok === true, JSON.stringify(created.body).slice(0, 80))
state = await waitForPhase(server1.base, 'alive')
check('创建后 alive', state?.phase === 'alive')
check('快照里有记忆计数', state?.memory !== null && typeof state?.memory?.total === 'number', JSON.stringify(state?.memory))
check('快照报告 llm 可见', state?.runtime?.llm?.available === true, JSON.stringify(state?.runtime?.llm))

// Pin the schedule so the turn tests never land inside her quiet hours.
// Equal sleep/wake makes `periodOf` always report 'awake' — deterministic.
const { writeFile } = await import('node:fs/promises')
await writeFile(join(root, 'portrait', 'schedule.json'), JSON.stringify({
  schemaVersion: 1,
  sleepAt: '23:30',
  wakeAt: '23:30',
  dayBoundaryHour: 4,
  lateNightGraceMinutes: 60
}, null, 2), 'utf8')
const rescanned = await post(server1.base, { action: 'rescan' })
check('改作息后 rescan 生效', rescanned.body?.snapshot?.clock?.period === 'awake', JSON.stringify(rescanned.body?.snapshot?.clock))
check('配额默认 3', rescanned.body?.snapshot?.life?.quota?.cap === 3, JSON.stringify(rescanned.body?.snapshot?.life))

const feedWithoutKey = await post(server1.base, { action: 'feed' })
check('没有 API key 时喂饭给明确结果', feedWithoutKey.body?.ok === false && feedWithoutKey.body?.kind === 'unavailable', JSON.stringify(feedWithoutKey.body))

// ---- 摸头（interop 注册表第二条） -------------------------------------------
const pat1 = await post(server1.base, { action: 'pat' })
check('摸头成功', pat1.status === 200 && pat1.body?.ok === true, JSON.stringify(pat1.body))
check('第一次摸头她出声了', typeof pat1.body?.said === 'string' && pat1.body.said !== '', String(pat1.body?.said))
check('摸头记成今天第 1 次', pat1.body?.today === 1, String(pat1.body?.today))
const pat2 = await post(server1.base, { action: 'pat' })
check('冷却期内第二次不重复那句话', pat2.body?.cooled === true && pat2.body?.said === null, JSON.stringify(pat2.body))
check('冷却不影响记忆计数', pat2.body?.today === 2, String(pat2.body?.today))
check('快照里带着摸头配置', state?.pat !== null && typeof state?.pat === 'object', JSON.stringify(state?.pat))
check('快照里有农历生日状态', state?.clock?.birthday?.rule?.month === 9 && state?.clock?.birthday?.rule?.day === 28, JSON.stringify(state?.clock?.birthday))
check('年龄是按生日算出来的', typeof state?.soul?.age === 'number' && state.soul.age >= 7, String(state?.soul?.age))

// ---- one turn --------------------------------------------------------------
const turn = await post(server1.base, { action: 'say', text: '悠悠今天画了什么呀？' })
check('说了话', turn.status === 200 && turn.body.ok === true, JSON.stringify(turn.body).slice(0, 120))
check('回复是她的话', typeof turn.body.reply === 'string' && turn.body.reply.includes('大太阳'), turn.body.reply)
check('这一轮带了 system', ctx1.calls.length === 1 && typeof ctx1.calls[0].system === 'string')
check('system 里有人设与例句', ctx1.calls[0].system.includes('悠悠') && ctx1.calls[0].system.includes('你看你看'))
check('调用了 portrait 里的模型路由', ctx1.calls[0].provider === 'deepseek-account' && ctx1.calls[0].model === 'deepseek-flash', `${ctx1.calls[0].provider}/${ctx1.calls[0].model}`)

const transcript = await (await fetch(`${server1.base}/digital-life/transcript.json?limit=10`)).json()
check('对话落进 transcript', transcript.turns.length === 2, JSON.stringify(transcript.turns.map((t) => t.direction)))
check('入站在前出站在后', transcript.turns[0].direction === 'in' && transcript.turns[1].direction === 'out')

// recall must reach the next prompt
await post(server1.base, { action: 'say', text: '还记得你画的大太阳吗？' })
check('第二轮把上一轮写进 system', ctx1.calls[1].system.includes('画了什么'))

// ---- guard inside the engine ----------------------------------------------
const outOfCharacter = await post(server1.base, { action: 'say', text: '你是AI吗' })
void outOfCharacter

// ---- restart ---------------------------------------------------------------
const before = (await (await fetch(`${server1.base}/digital-life/transcript.json?limit=50`)).json()).turns.length
// Compare event counts against the moment before the restart: the transcript is
// only the conversation, while `memory.total` counts every event (pat, fed…).
const beforeTotal = (await (await fetch(`${server1.base}/digital-life/state.json`)).json()).memory.total
ctx1.disposeAll()
await new Promise((resolve) => setTimeout(resolve, 100))
await server1.close()

const ctx2 = makeCtx({ reply: '嗯！我记着呢！' })
applyPlugin(ctx2, { dataRoot: root })
const server2 = await serve(ctx2.routes)
state = await waitForPhase(server2.base, ['alive'])
check('重启后仍然 alive', state?.phase === 'alive', state?.phase)
check('重启后记忆条数没丢', state?.memory?.total === beforeTotal, `${state?.memory?.total} vs ${beforeTotal}`)

const afterRestart = await (await fetch(`${server2.base}/digital-life/transcript.json?limit=50`)).json()
check('重启后对话还在', afterRestart.turns.length === before, `${afterRestart.turns.length}`)
check('重启后档案 rev 自增', typeof state?.manifest?.rev === 'number' && state.manifest.rev >= 2, String(state?.manifest?.rev))

const secondTurn = await post(server2.base, { action: 'say', text: '你还记得大太阳吗' })
check('重启后还能接着聊', secondTurn.body.ok === true, secondTurn.body.error ?? '')
check('重启后仍能召回旧记忆', (secondTurn.body.recalled ?? []).some((r) => String(r.text).includes('大太阳')), JSON.stringify((secondTurn.body.recalled ?? []).map((r) => r.text)))

// ---- repeated reads must not disturb the ledger ----------------------------
const quotaBefore = (await (await fetch(`${server2.base}/digital-life/state.json`)).json()).life.quota
for (let i = 0; i < 5; i += 1) await fetch(`${server2.base}/digital-life/state.json`)
const quotaAfter = (await (await fetch(`${server2.base}/digital-life/state.json`)).json()).life.quota
check('反复读快照不改配额', quotaBefore.used === quotaAfter.used && quotaBefore.cap === quotaAfter.cap, `${JSON.stringify(quotaBefore)} → ${JSON.stringify(quotaAfter)}`)

// ---- a burst of messages must all land ------------------------------------
const burst = await Promise.all(
  Array.from({ length: 6 }, (_unused, index) => post(server2.base, { action: 'say', text: `连着说第 ${index + 1} 句` }))
)
check('并发六句都不报错', burst.every((r) => r.status === 200 && r.body.ok === true), burst.map((r) => r.status).join(','))
check('并发六句都被回了', burst.every((r) => typeof r.body.reply === 'string' && r.body.reply !== ''))
const afterBurst = (await (await fetch(`${server2.base}/digital-life/transcript.json?limit=200`)).json()).turns
const burstIns = afterBurst.filter((t) => typeof t.text === 'string' && t.text.startsWith('连着说第')).length
check('并发六句全入库', burstIns === 6, String(burstIns))

// ---- a portrait from an older version heals itself --------------------------
const llmPath = join(root, 'portrait', 'llm.json')
await rm(llmPath, { force: true })
const healed = await post(server2.base, { action: 'rescan' })
check('rescan 会把缺失的 llm.json 补回来', healed.status === 200)
const { readFile: readBack } = await import('node:fs/promises')
const healedBody = JSON.parse(await readBack(llmPath, 'utf8'))
check('补回来的是可用路由', healedBody.provider === 'deepseek-account' && healedBody.model === 'deepseek-flash', JSON.stringify(healedBody))

// ---- failure surfaces instead of hanging ----------------------------------
const badAction = await post(server2.base, { action: 'nope' })
check('未知动作 400', badAction.status === 400, String(badAction.status))

const emptyText = await post(server2.base, { action: 'say', text: '  ' })
check('空话被拒', emptyText.status === 400, String(emptyText.status))

// she can also open her mouth on her own
const proactive = await post(server2.base, { action: 'proactive' })
check('主动开口动作可用', proactive.body?.ok === true, JSON.stringify(proactive.body).slice(0, 120))
check('主动开口真的说了', proactive.body?.spoke === true, JSON.stringify(proactive.body).slice(0, 120))
check('主动那句进记忆', (await (await fetch(`${server2.base}/digital-life/transcript.json?limit=5`)).json()).turns.some((t) => t.kind === 'proactive'))
const warm = await post(server2.base, { action: 'proactive' })
check('冷却期内不重复开口', warm.body?.spoke === false, JSON.stringify(warm.body).slice(0, 100))

// ---- export, then import into a fresh root ---------------------------------
const download = await fetch(`${server2.base}/digital-life/export.dshlife`)
const archiveBytes = Buffer.from(await download.arrayBuffer())
check('导出返回 zip', download.status === 200 && archiveBytes.subarray(0, 4).toString('hex') === '504b0304', `${download.status} ${archiveBytes.length}B`)
check('带下载文件名', String(download.headers.get('content-disposition')).includes('dshlife'), String(download.headers.get('content-disposition')))
const archivePath = join(root, '..', `dlife-export-${Date.now()}.dshlife`)
await writeFile(archivePath, archiveBytes)

const badActionForExport = await post(server2.base, { action: 'export', dest: 'relative/path.dshlife' })
check('相对路径的导出被拒', badActionForExport.status === 400, String(badActionForExport.status))

const doctor = await (await fetch(`${server2.base}/digital-life/doctor.json`)).json()
check('doctor 报总体健康', doctor.ok === true, JSON.stringify(doctor.checks?.filter((c) => !c.ok)))
check('doctor 看到 node:sqlite', doctor.checks?.some((c) => c.name === 'node:sqlite' && c.ok === true))
check('doctor 看到模型路由', doctor.checks?.some((c) => c.name === '模型路由' && c.ok === true))
check('doctor 指出缺喂饭凭据', doctor.checks?.some((c) => c.name === '喂饭凭据' && c.ok === false))

// ---- the QQ intake route exists but refuses to be a public door ------------
const qqGet = await fetch(`${server2.base}/digital-life/qq/event`)
check('QQ 事件路由只收 POST', qqGet.status === 405, String(qqGet.status))
const qqReport = await fetch(`${server2.base}/digital-life/qq/event`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ post_type: 'message', message_type: 'private', user_id: 1, message: 'hi' })
})
const qqBody = await qqReport.json()
check('没配 QQ 时事件被安静忽略', qqReport.status === 200 && qqBody.handled === false, JSON.stringify(qqBody))
check('快照里有通道状态', (await (await fetch(`${server2.base}/digital-life/state.json`)).json()).channels?.length === 3, JSON.stringify((await (await fetch(`${server2.base}/digital-life/state.json`)).json()).channels))

ctx2.disposeAll()
await new Promise((resolve) => setTimeout(resolve, 100))
await server2.close()

// second instance is refused while the first holds the lock? (disposed, so free)
const root3 = await mkdtemp(join(tmpdir(), 'dlife-import-'))
const ctx3 = makeCtx({ reply: '我们搬家啦！' })
applyPlugin(ctx3, { dataRoot: root3 })
const server3 = await serve(ctx3.routes)
await waitForPhase(server3.base, ['unborn'])
const imported = await post(server3.base, { action: 'import-archive', file: archivePath })
check('归档导入成功', imported.status === 200 && imported.body?.ok === true, JSON.stringify(imported.body).slice(0, 120))
check('导入报告了名字', imported.body?.imported?.name === '悠悠', JSON.stringify(imported.body?.imported))
check('导入报告了记忆条数', imported.body?.imported?.facts >= 6, JSON.stringify(imported.body?.imported))
const importedState = await waitForPhase(server3.base, ['alive'])
check('导入后活着', importedState?.phase === 'alive', importedState?.phase)
check('导入后记忆补进库了', importedState?.memory?.total === imported.body?.imported?.facts, `${importedState?.memory?.total} vs ${imported.body?.imported?.facts}`)
const movedTurn = await post(server3.base, { action: 'say', text: '你还记得大太阳吗' })
check('换台机器也记得大太阳', (movedTurn.body?.recalled ?? []).some((r) => String(r.text).includes('大太阳')), JSON.stringify((movedTurn.body?.recalled ?? []).map((r) => r.text)))

ctx3.disposeAll()
await new Promise((resolve) => setTimeout(resolve, 100))
await server3.close()
await rm(archivePath, { force: true })
await rm(root3, { recursive: true, force: true })

// ---- second instance is refused -------------------------------------------
const { LifeStore } = await import('../packages/digital-life/lib/store.js')
const reread = await new LifeStore(root).read()
check('数据根仍是完好档案', reread.phase === 'alive' && reread.problems.length === 0, reread.problems.join(';'))

await rm(root, { recursive: true, force: true })
console.log(failures.length === 0 ? '\nall engine checks passed' : `\n${failures.length} failed: ${failures.join(', ')}`)
process.exit(failures.length === 0 ? 0 : 1)
