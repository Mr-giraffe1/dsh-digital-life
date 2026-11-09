import { mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LifeStore } from '../packages/digital-life/lib/store.js'

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
}

const base = await mkdtemp(join(tmpdir(), 'dlife-'))
const rootA = join(base, 'A')
const rootB = join(base, 'B')

// 1. fresh root is unborn
const a = new LifeStore(rootA)
let read = await a.read()
check('空数据根是 unborn', read.phase === 'unborn', read.phase)

// 2. create
const created = await a.create({ name: '悠悠', addresser: '舅舅' })
check('创建后得到人设', created.soul.name === '悠悠' && created.soul.relation.address === '舅舅')
check('soulId 是 uuid 形状', /^[0-9a-f-]{36}$/.test(created.manifest.soulId), created.manifest.soulId)

// 3. layout + files
const files = await readdir(rootA)
check('目录布局齐全', ['portrait', 'memory', 'credentials', 'runtime', 'logs'].every((d) => files.includes(d)), files.join(','))
const portraitFiles = await readdir(join(rootA, 'portrait'))
check('portrait 有 soul/voice/schedule/outreach',
  ['soul.json', 'voice.md', 'schedule.json', 'outreach.json', 'domains', 'channels', 'interop']
    .every((f) => portraitFiles.includes(f)), portraitFiles.join(','))

// 4. read back alive
read = await a.read()
check('回读是 alive 且无问题', read.phase === 'alive' && read.problems.length === 0, read.problems.join(';'))

// 5. rev bump
const touched = await a.touchManifest()
check('rev 自增', touched.rev === created.manifest.rev + 1, `rev=${touched.rev}`)

// 6. policy defaults
const policy = await a.readPolicy()
check('outreach 默认值合并', policy.outreach.baseQuotaPerDay === 3 && policy.outreach.wakeAfterPendingMessages === 3)
check('schedule 日界 4 点', policy.schedule.dayBoundaryHour === 4)

// 7. refuse overwrite
let refused = false
try {
  await a.create({ name: '别人' })
} catch (error) {
  refused = /不会覆盖/.test(String(error.message))
}
check('非空数据根拒绝覆盖', refused)

// 8. import into B
const b = new LifeStore(rootB)
const imported = await b.importFrom(rootA)
check('导入沿用同一 soulId', imported.sameSoul && imported.manifest.soulId === created.manifest.soulId)
check('导入保留了人设', imported.soul.name === '悠悠')
check('导入报告 previousHost', typeof imported.previousHost === 'string', imported.previousHost)
read = await b.read()
check('导入后可正常读取', read.phase === 'alive' && read.problems.length === 0, read.problems.join(';'))

// 9. refuse import over existing
let importRefused = false
try {
  await b.importFrom(rootA)
} catch (error) {
  importRefused = /不会覆盖/.test(String(error.message))
}
check('非空数据根拒绝导入', importRefused)

// 10. bad schema is refused, data untouched
const raw = JSON.parse(await (await import('node:fs/promises')).readFile(join(rootB, 'portrait', 'soul.json'), 'utf8'))
const { writeJson } = await import('../packages/digital-life/lib/store.js')
await writeJson(join(rootB, 'portrait', 'soul.json'), { ...raw, schemaVersion: 99 })
read = await b.read()
check('未知 schemaVersion 判为 broken', read.phase === 'broken' && read.problems.some((p) => p.includes('schemaVersion')), read.problems.join(';'))
const still = JSON.parse(await (await import('node:fs/promises')).readFile(join(rootB, 'portrait', 'soul.json'), 'utf8'))
check('坏档案没有被洗成默认值', still.name === '悠悠' && still.schemaVersion === 99)

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
console.log('roots:', rootA, rootB)
process.exit(failed.length === 0 ? 0 : 1)
