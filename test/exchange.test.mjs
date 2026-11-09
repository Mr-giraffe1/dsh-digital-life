import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LifeStore } from '../packages/digital-life/lib/store.js'
import { Memory } from '../packages/digital-life/lib/memory.js'
import {
  buildArchive,
  compareFacts,
  factsToJsonl,
  importArchive,
  inspectArchive,
  replayPendingImport
} from '../packages/digital-life/lib/exchange.js'
import { zipRead, zipWrite } from '../packages/digital-life/lib/archive.js'

const failures = []
function check(name, ok, detail = '') {
  if (!ok) failures.push(name)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
}

const base = await mkdtemp(join(tmpdir(), 'dlife-x-'))
const rootA = join(base, 'A')
const rootB = join(base, 'B')
const rootC = join(base, 'C')

// ---- a soul with history ---------------------------------------------------
const storeA = new LifeStore(rootA)
await storeA.create({ name: '悠悠', addresser: '舅舅' })
const memoryA = new Memory(join(rootA, 'memory', 'soul.db')).open()
const yesterday = new Date(Date.now() - 86_400_000).toISOString()
memoryA.addEvent({ at: yesterday, text: '悠悠今天画了一个大太阳', domain: 'fact', kind: 'note', importance: 0.9 })
memoryA.addEvent({ at: yesterday, text: '舅舅给悠悠充了大米饭', domain: 'somatic', kind: 'fed', importance: 0.6 })
memoryA.addEvent({ at: yesterday, text: '今天学了新的舞蹈动作', domain: 'diary', kind: 'note', importance: 0.7 })
memoryA.addEvent({ at: yesterday, text: '在吗', domain: 'fact', kind: 'message', direction: 'in', channel: 'desktop', actorUid: 'uncle' })
memoryA.addEvent({ at: yesterday, text: '在呀！', domain: 'fact', kind: 'say', direction: 'out', channel: 'desktop', actorUid: 'self' })
memoryA.setMeta('feed.toppedUp', 55)
// credentials must never travel
await writeFile(join(rootA, 'credentials', 'deepseek.json'), '{"apiKey":"sk-secret"}\n', 'utf8')
await writeFile(join(rootA, 'runtime', 'state.json'), '{"panel":"x"}\n', 'utf8')

const factsA = factsToJsonl(memoryA)
check('导出前有 5 条事实', factsA.split('\n').length === 5, String(factsA.split('\n').length))

// ---- export ----------------------------------------------------------------
const built = await buildArchive({ store: storeA, memory: memoryA })
check('归档有字节数', built.buffer.length > 100, String(built.buffer.length))
check('报告的事实条数对', built.facts === 5, String(built.facts))

const names = [...zipRead(built.buffer).keys()]
check('归档里有 manifest', names.includes('manifest.json'), names.join(', '))
check('归档里有 fingerprint', names.includes('memory/fingerprint.json'))
check('归档里有 events.jsonl', names.includes('memory/events.jsonl'))
check('归档里有 soul.json', names.includes('portrait/soul.json'))
check('归档里有 voice.md', names.includes('portrait/voice.md'))
check('归档里有域声明', names.some((n) => n.startsWith('portrait/domains/')), names.filter((n) => n.includes('domains')).join(','))
check('凭据不在包里', names.every((n) => !n.startsWith('credentials/')), names.filter((n) => n.includes('credential')).join(','))
check('运行时不在包里', names.every((n) => !n.startsWith('runtime/')), names.filter((n) => n.includes('runtime')).join(','))
check('索引表不在包里', names.every((n) => !n.includes('soul.db') && !n.includes('fts')))

const inspected = inspectArchive(built.buffer)
check('检视出人设', inspected.soul.name === '悠悠')
check('检视出 5 条事实', inspected.events.length === 5, String(inspected.events.length))
check('检视出指纹', inspected.fingerprint.exchangeVersion === 1, JSON.stringify(inspected.fingerprint))

// ---- import into B ---------------------------------------------------------
const storeB = new LifeStore(rootB)
const imported = await importArchive({ store: storeB, buffer: built.buffer })
check('导入报告事实数', imported.facts === 5, String(imported.facts))
check('导入报告同一 soulId', imported.sameSoul === true)

const readB = await storeB.read()
check('导入后人设完好', readB.phase === 'alive' && readB.problems.length === 0, readB.problems.join(';'))

const memoryB = new Memory(join(rootB, 'memory', 'soul.db')).open()
const replayed = await replayPendingImport(storeB, memoryB)
check('补进了 5 条记忆', replayed === 5, String(replayed))
check('补完就删掉暂存文件', (await readdir(join(rootB, 'memory'))).includes('pending-import.jsonl') === false)

// ---- round-trip equality ---------------------------------------------------
const compare = compareFacts(factsA, factsToJsonl(memoryB))
check('导入后事实逐行等价', compare.equal, `${compare.leftLines} vs ${compare.rightLines}`)

// 再次导出必须字节级稳定（除 manifest 的 rev/importedAt）
const rebuilt = await buildArchive({ store: storeB, memory: memoryB })
const second = compareFacts(
  zipRead(built.buffer).get('memory/events.jsonl').toString('utf8'),
  zipRead(rebuilt.buffer).get('memory/events.jsonl').toString('utf8')
)
check('export → import → export 事实一致', second.equal, `${second.leftLines} vs ${second.rightLines}`)

// her memory still retrieves after the move
check('搬完还能召回大太阳', memoryB.recall('太阳').length === 1, JSON.stringify(memoryB.recall('太阳').map((r) => r.text)))

// ---- refusals --------------------------------------------------------------
let refusedOverwrite = false
try {
  await importArchive({ store: storeB, buffer: built.buffer })
} catch (error) {
  refusedOverwrite = /不会覆盖/.test(String(error.message))
}
check('不覆盖已有档案', refusedOverwrite)

const patched = new Map(zipRead(built.buffer))
const manifest = JSON.parse(patched.get('manifest.json').toString('utf8'))
patched.set('manifest.json', Buffer.from(JSON.stringify({ ...manifest, schemaVersion: 99 }), 'utf8'))
const badVersion = zipWrite([...patched].map(([name, data]) => ({ name, data })))

const storeC = new LifeStore(rootC)
let refusedVersion = false
try {
  await importArchive({ store: storeC, buffer: badVersion })
} catch (error) {
  refusedVersion = /schemaVersion/.test(String(error.message))
}
check('未知 schemaVersion 被拒', refusedVersion)
const readC = await storeC.read()
check('被拒后 C 仍是空的（一个字节都没写）', readC.phase === 'unborn', readC.phase)

let refusedTruncated = false
try {
  inspectArchive(built.buffer.subarray(0, 60))
} catch {
  refusedTruncated = true
}
check('截断包被拒', refusedTruncated)

// ---- a manifest with no host marker must still import cleanly ---------------
const rootD = join(base, 'D')
const noHost = new Map(zipRead(built.buffer))
const hostless = JSON.parse(noHost.get('manifest.json').toString('utf8'))
delete hostless.lastHost
noHost.set('manifest.json', Buffer.from(JSON.stringify(hostless), 'utf8'))
const hostlessArchive = zipWrite([...noHost].map(([name, data]) => ({ name, data })))

const storeD = new LifeStore(rootD)
await importArchive({ store: storeD, buffer: hostlessArchive })
const readD = await storeD.read()
check('没有 lastHost 的包也能导入', readD.phase === 'alive', `${readD.phase} ${readD.problems.join(';')}`)
check('导入后 lastHost 是空串而不是 null', readD.manifest.lastHost === '', JSON.stringify(readD.manifest.lastHost))

memoryA.close()
memoryB.close()
await rm(base, { recursive: true, force: true })
console.log(failures.length === 0 ? '\nall exchange checks passed' : `\n${failures.length} failed: ${failures.join(', ')}`)
process.exit(failures.length === 0 ? 0 : 1)
