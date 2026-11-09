import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as lock from '../packages/digital-life/lib/lock.js'

const failures = []
function check(name, ok, detail = '') {
  if (!ok) failures.push(name)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
}

// ---- live HTTP: state + SSE -------------------------------------------------
// Point this at any running host: `DSH_LIFE_URL=http://127.0.0.1:19399`.
// scripts/probe.ps1 boots an isolated instance on another port so the suite can
// run without restarting the DSH you are actually using.
const BASE = (process.env.DSH_LIFE_URL ?? 'http://127.0.0.1:19387').replace(/\/+$/, '')

const state = await (await fetch(`${BASE}/digital-life/state.json`)).json()
check('state.json 是 alive', state.phase === 'alive', state.phase)
check('state.json 带她的名字', state.name === '悠悠', state.name)
check('state.json 报告 node:sqlite 可用', state.runtime.sqlite === true, String(state.runtime.sqlite))

const controller = new AbortController()
const timeout = setTimeout(() => controller.abort(), 6000)
let sseFrame = null
try {
  const response = await fetch(`${BASE}/digital-life/stream`, {
    signal: controller.signal,
    headers: { accept: 'text/event-stream' }
  })
  check('SSE 200 + text/event-stream', response.ok && String(response.headers.get('content-type')).includes('text/event-stream'), String(response.headers.get('content-type')))
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffered = ''
  while (buffered.indexOf('\n\n') === -1) {
    const { value, done } = await reader.read()
    if (done) break
    buffered += decoder.decode(value, { stream: true })
  }
  sseFrame = buffered
  await reader.cancel()
} catch (error) {
  check('SSE 可连接', false, String(error?.message ?? error))
} finally {
  clearTimeout(timeout)
}
check('SSE 首帧是 data: JSON', Boolean(sseFrame && sseFrame.startsWith('data: {')), String(sseFrame ?? '').slice(0, 40))
if (sseFrame && sseFrame.startsWith('data: ')) {
  const payload = JSON.parse(sseFrame.slice(6).split('\n')[0])
  check('SSE 首帧内容与 state.json 一致', payload.phase === 'alive' && payload.name === '悠悠', `${payload.phase}/${payload.name}`)
}

// ---- instance lock ---------------------------------------------------------
const dir = await mkdtemp(join(tmpdir(), 'dlife-lock-'))
const lockPath = join(dir, 'instance.lock')

const first = await lock.acquire(lockPath)
check('首次取锁成功', first.ok === true)

// A foreign live pid on the same host must block a second instance.
await writeFile(lockPath, JSON.stringify({
  pid: 4,
  hostname: (await import('node:os')).hostname(),
  startedAt: new Date().toISOString(),
  heartbeatAt: new Date().toISOString()
}))
const second = await lock.acquire(lockPath)
check('活着的 pid 会挡住第二个实例', second.ok === false && second.reason === 'held-by-live-process', JSON.stringify(second))

// A dead pid must be taken over.
await writeFile(lockPath, JSON.stringify({
  pid: 999999,
  hostname: (await import('node:os')).hostname(),
  startedAt: new Date(Date.now() - 3600_000).toISOString(),
  heartbeatAt: new Date(Date.now() - 3600_000).toISOString()
}))
const third = await lock.acquire(lockPath)
check('死掉的 pid 会被接管', third.ok === true, JSON.stringify(third))

const handle = lock.heartbeat(lockPath)
check('心跳返回可停止句柄', typeof handle.stop === 'function')
await handle.stop()

const { access } = await import('node:fs/promises')
let removed = false
try {
  await access(lockPath)
} catch {
  removed = true
}
check('停止心跳会删掉锁文件', removed)

console.log(failures.length === 0 ? '\nall http+lock checks passed' : `\n${failures.length} failed: ${failures.join(', ')}`)
process.exit(failures.length === 0 ? 0 : 1)
