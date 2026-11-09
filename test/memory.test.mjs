import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Memory, indexText, matchQuery } from '../packages/digital-life/lib/memory.js'

const failures = []
function check(name, ok, detail = '') {
  if (!ok) failures.push(name)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
}

// ---- text pipeline ---------------------------------------------------------
check('索引把中文按字切开', indexText('悠悠画了太阳') === '悠 悠 画 了 太 阳', indexText('悠悠画了太阳'))
check('索引去掉标点', indexText('真的吗！好的。') === '真 的 吗 好 的', indexText('真的吗！好的。'))
const q = matchQuery('太阳')
check('两字查询变成短语', q === '"太 阳"', q)
check('空查询返回空', matchQuery('   ') === '')
check('长查询带三字短语', matchQuery('大米饭好吃').includes('"大 米 饭"'), matchQuery('大米饭好吃').slice(0, 80))

// ---- open + facts ----------------------------------------------------------
const dir = await mkdtemp(join(tmpdir(), 'dlife-mem-'))
const file = join(dir, 'soul.db')
const memory = new Memory(file)
memory.open()
check('库文件已创建', (await stat(file)).isFile())

check('两个身份已就位', memory.db.prepare('SELECT COUNT(*) AS n FROM agent_identity').get().n === 2)
check('desktop 平台 ID 映射到 uncle', memory.db.prepare("SELECT uid FROM identity_link WHERE platform='desktop' AND platform_id='uncle'").get().uid === 'uncle')

const seed = [
  ['悠悠今天画了一个大太阳，还有一只小狗', 'fact', 0.8],
  ['舅舅给悠悠充值了，悠悠有大米饭吃了', 'somatic', 0.6],
  ['悠悠不喜欢打雷，晚上会害怕', 'fact', 0.9],
  ['舅舅你要是加班太晚，我就先睡了', 'fact', 0.6],
  ['今天在幼儿园学了新的舞蹈动作', 'diary', 0.7]
]
const dayAgo = Date.now() - 86_400_000
for (const [text, domain, importance] of seed) {
  memory.addEvent({ text, domain, kind: 'note', importance, epochMs: dayAgo })
}
check('写入了 5 条事实', memory.stats().total === 5, JSON.stringify(memory.stats()))

// ---- recall ----------------------------------------------------------------
const sun = memory.recall('太阳')
check('字面召回：太阳', sun.length === 1 && sun[0].text.includes('太阳'), JSON.stringify(sun.map((r) => r.text)))
const rice = memory.recall('大米饭')
check('三字词召回：大米饭', rice.length === 1 && rice[0].text.includes('大米饭'), JSON.stringify(rice.map((r) => r.text)))
const thunder = memory.recall('打雷')
check('两字词召回：打雷', thunder.length === 1 && thunder[0].text.includes('打雷'))
const sleep = memory.recall('睡')
check('单字召回：睡', sleep.length === 1 && sleep[0].text.includes('先睡'))
const none = memory.recall('量子力学')
check('无关查询不瞎召回', none.length === 0, JSON.stringify(none.map((r) => r.text)))
check('空查询不召回', memory.recall('   ').length === 0)

// importance must move the ranking
const strong = memory.addEvent({ text: '舅舅答应过要带悠悠去看大太阳', domain: 'fact', kind: 'note', importance: 1 })
const ranked = memory.recall('太阳')
check('重要度影响排序', ranked[0].id === strong.id, ranked.map((r) => `${r.id}:${r.score.toFixed(3)}`).join(' '))

// somatic weight 0.2 must push it below fact for the same term
const bodyHit = memory.recall('大米饭')
check('体感域权重生效', bodyHit[0].domain === 'somatic' && bodyHit[0].score > 0, String(bodyHit[0]?.score))

// duplicates must not flood recall
memory.addEvent({ text: '舅舅答应过要带悠悠去看大太阳', domain: 'fact', kind: 'message', importance: 0.7 })
const dedupedHits = memory.recall('大太阳')
const texts = dedupedHits.map((r) => r.text)
check('重复的话只算一条记忆', new Set(texts).size === texts.length, JSON.stringify(texts))

// ---- recent / transcript ---------------------------------------------------
const recent = memory.recent(3)
check('recent 返回最近 3 条且按时间正序', recent.length === 3 && recent[2].text.includes('大太阳'), recent.map((r) => r.id).join(','))
check('按域过滤', memory.recent(10, { domains: ['diary'] }).length === 1)

// ---- persistence -----------------------------------------------------------
memory.close()
const reopened = new Memory(file).open()
check('重开后事实还在', reopened.stats().total === 7, String(reopened.stats().total))
check('重开后索引还能召回', reopened.recall('舞蹈').length === 1)
reopened.setMeta('lastWokeAt', '2026-11-08')
check('meta 可读写', reopened.getMeta('lastWokeAt') === '2026-11-08')
reopened.close()

// ---- degraded mode: no FTS5 on the host build ------------------------------
const degradedFile = join(dir, 'degraded.db')
const degraded = new Memory(degradedFile)
degraded.open()
check('正常库报告 FTS 可用', degraded.fts === true)
degraded.addEvent({ text: '舅舅给悠悠充了大米饭', domain: 'somatic', kind: 'fed', importance: 0.6 })
degraded.addEvent({ text: '悠悠今天画了一个大太阳', domain: 'fact', kind: 'note', importance: 0.9 })

// Simulate a host whose SQLite has no FTS5: the index is gone, memory is not.
const degradedNoFts = new Memory(degradedFile)
degradedNoFts.open()
degradedNoFts.fts = false
degradedNoFts.ftsError = 'no such module: fts5'
degradedNoFts.addEvent({ text: '晚上打了雷，悠悠有点怕', domain: 'fact', kind: 'note', importance: 0.8 })
check('没有 FTS 也能写事实', degradedNoFts.stats().total === 3, String(degradedNoFts.stats().total))
const degradedHit = degradedNoFts.recall('打雷')
check('没有 FTS 也能召回', degradedHit.length === 1 && degradedHit[0].text.includes('雷'), JSON.stringify(degradedHit.map((r) => r.text)))
check('降级状态在 stats 里可见', degradedNoFts.stats().fts === false && degradedNoFts.stats().ftsError.includes('fts5'))
degraded.close()
degradedNoFts.close()

await rm(dir, { recursive: true, force: true })
console.log(failures.length === 0 ? '\nall memory checks passed' : `\n${failures.length} failed: ${failures.join(', ')}`)
process.exit(failures.length === 0 ? 0 : 1)
