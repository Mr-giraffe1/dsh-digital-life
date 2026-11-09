# dsh-digital-life · 架构设计

> 版本 `v1` · 2026-11-08 · schemaVersion 1
> 前置文档：`HANDOFF.md`（需求与结论来源）· `DECISIONS.md`（本轮全部决策记录）
> 本文档是**实现依据**：凡标 `[规范]` 的条目为确定实现；标 `[待核]` 的为已定方向但确切 API 名需实测。

---

## 0. 不可违反的不变量

这六条是设计的边界条件。任何实现细节与它们冲突时，改实现，不改这六条。

| # | 不变量 | 后果 |
| --- | --- | --- |
| **I1** | 她的「活着」在 Host 半（node 进程），Client 半只是观察窗 | 关掉 UI 她照样作息、照样回 QQ；UI 崩溃不影响记忆写入 |
| **I2** | 对外只有出站连接：LLM / Embedding / 通道 API。**不开任何入站端口** | 手机审批搭通道顺风车（QQ 回传），不架中继 |
| **I3** | 只有本地单写者。无同步、无合并、无冲突解决 | 数据层是本地 ACID；`instance.lock` 保证唯一写者 |
| **I4** | `portrait` / `memory` 可导出复现；`credentials` / `runtime` 永不出包 | 换设备后人设记忆都在，但需重新绑定通道 |
| **I5** | 向量、FTS 索引是**派生数据**，永远可从事实记录重建 | 导出只含事实 + 指纹；导入时重算 |
| **I6** | 一切外发可后悔。不可撤回的通道强制审批 | 审批强度按通道可撤回性分级，不按平台分级 |

---

## 1. 运行模型

```
┌─────────────────────────────────────────────────────────────┐
│ Host 半  ·  node 进程  ·  常驻，无 UI                          │
│                                                              │
│  life engine ── tick(1/min) ── 作息/心情/配额/待办/主动开口决策  │
│  memory      ── soul.db 唯一写者                              │
│  persona     ── portrait/ 读取 + voice 层                     │
│  channels/   ── bilibili · qq · desktop (出站)                │
│  outreach    ── draft → dry-run → 审批 → 发出 → 熔断           │
│  interop     ── 互动动作注册表（喂饭…）                         │
│  providers   ── llm · embedding · image(stub) · tts[未来]      │
│                                                              │
│  HTTP server (webServer, 仅回环)  ── 读快照 / 收有限动作        │
└───────────────────────┬─────────────────────────────────────┘
                        │ GET /digital-life/state.json
                        │ GET /digital-life/stream (SSE)
                        │ POST /digital-life/action (白名单动作)
┌───────────────────────┴─────────────────────────────────────┐
│ Client 半  ·  web  ·  书房控制台（观察窗）                     │
│  slot: main[key=digital-life]  ── 整页工作台                   │
│  只读快照 + 喂饭/摸头/审批（= 发指令，不改状态）                 │
└─────────────────────────────────────────────────────────────┘
```

**已验证的事实**（不是推测，P0 期间实测）：

- DSH 插件是双半结构：`package.json` 的 `main` 是 Host 半（`apply(ctx)` 跑在 node 进程），`dsh.client` + `exports["./client"]` 是 Client 半（web）。样本：`dsh-file-drag`。
- 宿主可挂 HTTP 路由给 UI 读：`ctx.webServer.register({ kind: 'exact'|'prefix', path, handler })`，返回 disposer，归 `ctx.effect` 管。
- Slot 系统是真扩展点：`ctx.slots.inject(key, cb)` + `ctx.slots.register({name, id, key, order, label, locale, inject, store, children}, Comp)`；cardinality 有 `single/list/keyed/chain`，scope 有 `root/session-maybe/session`。
- **整页自定义 UI 的落地方式已钉死**（`HOST` 侧不再有未知）：
  ```js
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'digital-life' }, Page))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
    { name: 'sidebar.panellist', id: 'digital-life', order: 20, label: '书房' }, Glyph))
  ```
  侧栏条目自动出现在左侧栏（`usePanels` 订阅 `sidebar.panellist`），`label` 支持纯字符串；`ctx.layout.selectPanel(id)` 用来程序化切换。
- Client 半的产物是**预构建的 CJS-式包**，由 `window.__ModuleLoader__.load({ id, factory })` 注册，`require('react')` 由平台种子表提供。**不需要构建工具链**——手写即可（本项目就是这么做的）。
- **宿主跑在 Node v24.18.1，`node:sqlite` 可用**（SQLite 3.53.4，含 FTS5 与 trigram tokenizer）。→ 不需要 `better-sqlite3` 原生编译。
- **中文检索不需要分词库**：FTS5 `unicode61` + 「入库按单字空格切分、查询用短语」实测可召回 1–3 字中文词；`trigram` 对 2 字词无效（实测），已排除。
- **Host 半改动不会热重载**，必须重启 DSH 或开关该插件行才生效；新增 loader 行则会被自动扫到（无需重启）。
- 一个链接进 profile `node_modules` 的包，其 bare import 会按**真实路径**解析，找不到 profile 里的依赖。→ 本插件**只用 `node:` 内建**，零运行时依赖。

**不主动开口时不调模型**：tick 只做决策，只有决策产出 `outreach` 时才发起推理。空转成本 ≈ 0。

---

## 2. 目录布局

**代码**放工作区 `F:\dsh-digital-life`。**她的身体**放 `DSH_HOME` 下的数据根（数据不是代码）。

```
${DSH_HOME}/digital-life/          ← 数据根（导出/导入的单位）
├── manifest.json                  ← schemaVersion / soulId / rev / 能力需求
├── portrait/                      ← 【导出】可搬走的人设
│   ├── soul.json                  身份、年龄、农历生日、与舅舅的关系
│   ├── voice.md                   说话风格 few-shot —— 唯一风格来源
│   ├── family.json                家庭设定（父母/同住）
│   ├── schedule.json              固定作息表
│   ├── mood.json                  心情模型参数
│   ├── outreach.json              主动开口配额与安静时段
│   ├── embeddings.json            embedding provider 声明 + 指纹
│   ├── domains/                   记忆域注册表（可扩充）
│   │   ├── fact.json
│   │   ├── somatic.json           体感域（摸头/喂饭/熬夜…）
│   │   ├── diary.json
│   │   └── relation.json
│   ├── channels/                  通道声明 + 每通道 overlay
│   │   ├── desktop.json           { enabled, irreversible: false, tools: full }
│   │   ├── qq.json                { bound: {...}, irreversible: false, tools: readonly }
│   │   └── bilibili.json          { bound: {...}, irreversible: true, public_posting: false }
│   └── interop/                   互动动作注册表
│       └── feed.json              喂饭 = 充值
├── memory/                        ← 【导出】事实记录（不含索引）
│   ├── soul.db                    权威库（含派生表，导出时只导事实表）
│   └── export/                    导出暂存
├── credentials/                   ← 【永不导出】
│   ├── llm.yaml
│   └── bilibili.cookies
├── runtime/                       ← 【永不导出】设备相关
│   ├── instance.lock
│   ├── state.json                 当前睡眠态/心情/配额余额
│   └── panel.json                 UI 偏好、窗口位置
└── logs/
    ├── life.ndjson                tick 决策流水（可回放）
    └── speech.ndjson              每一句她说过的话（含被拒的）
```

**工作区（她动手的地方）**由 `manifest.capabilities.workspace` 声明，宿主解析成绝对路径，用于画画草稿、下载、临时文件。**配置里不写绝对路径**，只用 `${DSH_HOME}` / `${WORKSPACE}` 插值。

---

## 3. manifest.json

```jsonc
{
  "schemaVersion": 1,
  "soulId": "5f3c8a1e-...",          // 首次创建时生成，随导出包走，导入不变
  "rev": 12,                          // 每次启动自增，用于"这份档案还活着吗"的提示
  "createdAt": "2026-11-08T10:00:00+08:00",
  "lastHost": "DESKTOP-XXXX",         // 只存主机名，不存路径
  "name": "悠悠",
  "capabilities": {
    "workspace": { "required": true, "writable": true, "why": "画画草稿与临时文件" },
    "network": {
      "requires": ["outbound"],
      "hosts": ["api.deepseek.com", "openrouter.ai", "*.bilibili.com", "*.qq.com", "localhost"]
    }
  },
  "paths": {
    "root": "${DSH_HOME}/digital-life",
    "workspace": "${WORKSPACE}"
  }
}
```

`[规范]` 读到不认识的 `schemaVersion` → **拒绝导入，原数据一字不动**，报错信息里给出版本号与来源路径。绝不静默覆盖。

---

## 4. 三层配置 + 一层记忆

`HANDOFF §4.7` 说的三层，加上记忆实际是四个根：

| 层 | 目录 | 跨设备 | 原则 |
| --- | --- | --- | --- |
| `portrait` | `portrait/` | 导出即复现 | 只由它控制"她是谁、怎么活" |
| `memory` | `memory/` | 导出事实，索引重算 | 事实是权威，派生是垃圾 |
| `credentials` | `credentials/` | 永不出包 | 换设备重扫码 |
| `runtime` | `runtime/` | 永不出包 | 属于设备，归设备 |

**判断标准**：一条配置如果换台机器就该变，它属于 `runtime`；如果换台机器也该一样，属于 `portrait`。写错层级比写错值更麻烦，因为导出时会静静地把设备依赖带出去。

---

## 5. 核心模块

### 5.1 life engine `[规范]`

单 `setInterval`，**1 分钟一次 tick**，与用户事件无关（她不会因为你没说话就停止呼吸）。

每个 tick 依次做：

1. **推进时钟** → 判定当前时段（`sleeping` / `awake` / `late_night`）
2. **作息判定** → 过了入睡点仍未睡 → 记 `violation`
3. **日界翻转** → 本地日界是 **04:00**（不是 00:00），因为熬夜不该被算成第二天
4. **配额结算** → 见 5.2
5. **待办阈值检查** → 见 5.3
6. **主动开口决策** → 见 5.6
7. **心情漂移** → `mood.json` 的参数化漂移（无外部输入时缓慢回归基线）

`[规范]` **每个 tick 的决策先写 `logs/life.ndjson` 再执行**。冷启动时可回放，也让"她昨天为什么突然找我"可查。

tick 本身**不调模型**。

### 5.2 作息与配额 `[规范]`

- `schedule.json` 给固定表：默认入睡 `23:30`、起床 `08:00`
- **她不遵守也不阻止**——引擎只记录，不纠正（这是人设的一部分，不是 bug）
- 基础配额 **3 次/天**，每熬夜一晚次日 **−1**，**保底 1 次**，连续 3 晚正常则 +1 回到基础值
- 熬夜判定：实际入睡晚于 `入睡点 + 60min`
- 配额按通道独立计（`quota(day, channel)`）

### 5.3 夜间待办 `[规范]`

- 睡眠态收到的消息进 `todo` 表，**持久化，不丢**
- **待办累计 > 3 条 → 唤醒她**，立即处理
- ≤ 3 条 → 继续睡，起床后一并处理；她可以说「我睡着了，我刚看到」（符合「失联/睡着要坦白」的默认）
- 阈值 `3` 写在 `outreach.json`，不硬编码
- 醒来先处理待办，再重新判定是否继续睡

### 5.4 persona `[规范]`

**核心决策：表达层与能力层解耦。**

她是 7 岁，但她手上的工具是真家伙（读文件、跑命令、改配置）。幼稚化只能作用于**说出口的那句话**，不能渗透进工具调用与内部推理，否则输出会碎。

```
入站 → 归一化 → 记忆召回 → 组装(core + channel overlay + voice.md 样例)
     → 模型推理（标准格式，工具全可用）
     → 产物 { thinking?, tool_calls?, say }
     → say 过 voice 层 + 年龄护栏校验（代码校验，非提示词）
     → 出站
```

- `voice.md` 是**唯一**的风格来源。不写"幼稚一点"，写入 few-shot 例句。
- 年龄护栏是**代码校验**：长度上限（7 岁不发长文）、成人话题拦截、外部诱导检测。`HANDOFF §4.10` 的教训——只靠提示词迟早漏。
- 每通道 overlay 只改**策略**（能不能主动、每轮几条、要不要点名），不改人格核心。

### 5.5 memory `[规范]`

**事实是权威，索引是派生。** 见 §6 数据模型与 §7 召回。

- **UID 中心**：平台 ID 只做索引。舅舅在 QQ 的号、B 站的号、桌面的「舅舅」是**同一个 UID**。第一天就定，晚了要全量迁移且分不清"两个陌生人"还是"同一个人的两个号"。
- **记忆域是 registry，不是枚举**：加一个新域只加一条 `domains/<id>.json`，不改代码。

```ts
interface MemoryDomain {
  id: string                    // 'fact' | 'somatic' | 'diary' | 'relation'
  schema: ZodType               // payload 校验
  retention: 'forever' | { days: number } | 'decay'
  retrievalWeight: number       // 0 = 不参与事实召回
  gate?: (ctx) => boolean       // 何时才允许被召回
}
```

体感域 `somatic` 的具体配置：`retrievalWeight: 0.2`，`gate: 仅闲聊或被问到时`。这样「你今天摸了三次头」不会挤掉正经回忆，但她被问到的时候又想得起来。

### 5.6 outreach（主动开口）`[规范]`

状态机：

```
idle → considered → drafted → dry_run → awaiting_approval → sent | rejected | expired
                                 │
                                 └──(通道可撤回/私域)──→ 直接 sent
```

**审批强度按通道的「可撤回性」分级，不按平台分级**（I6）：

| 通道 | `irreversible` | 审批 | 理由 |
| --- | --- | --- | --- |
| `desktop` | false | **不需要** | 只有你听得见，是她的主场 |
| `qq` 私聊 | false（2 分钟内可撤回） | 宽松：可在本地自动批 | 撤回窗口内错了还能救 |
| `bilibili` 公开 | **true** | **强制审批** | 发出去收不回，落在你账号上 |

**熔断**：
- 同一通道连续 **3 次**被拒 → 降级只读，24h 后自动试探恢复
- 连续 **2 次**被平台拒绝（限流/风控）→ 关闭该通道外发，需人工重开
- 熔断状态计入 `runtime/state.json`，UI 可见

### 5.7 channels `[规范]`

接口要窄，别让 bilibili-mcp 的形状污染核心（`HANDOFF §4.6`）：

```ts
interface ChannelAdapter {
  readonly id: 'bilibili' | 'qq' | 'desktop'
  capabilities(): {
    canSend: boolean
    canRead: boolean
    publicPosting: boolean
    irreversible: boolean
    maxLen: number
    rate: { perMinute: number; perDay: number }
  }
  health(): Promise<{ state: 'bound' | 'unbound' | 'degraded'; detail: string }>
  read(since: Cursor): Promise<Inbound[]>       // 归一化后入站
  send(draft: Outbound): Promise<Receipt>
}
```

**通道绑定检查**（`HANDOFF §4.4`）：`portrait/channels/*.json` 里存**通道声明**（在哪个平台有家、叫什么名字），`credentials/` 里存令牌。启动时逐通道 `health()`：

- 声明存在 + 凭据有效 → `bound`
- 声明存在 + 凭据缺失/失效 → **`unbound`（失联态）**
- 她**知道自己失联**，会直说「我那个号现在登不上」，不假装在线

### 5.8 interop（互动动作）`[规范]`

互动动作是**注册表**，喂饭是第一条，摸头是第二条（`portrait/interop/*.json`，加一条不用改代码）：

```jsonc
// portrait/interop/feed.json
{
  "id": "feed",
  "label": "喂饭",
  "trigger": { "kind": "recharge", "provider": "deepseek" },
  "memory": { "domain": "somatic", "kind": "fed", "importance": 0.6 },
  "say": "舅舅舅舅！你给我充大米饭啦？那我以后不用饿肚子了！",
  "ui": { "animation": "rice", "cooldown": "1h" }
}
```

**喂饭 = 充值 → 告诉她**（已定）。实现要点：

1. 点「喂饭」→ 打开充值页
2. 轮询 `GET https://api.deepseek.com/user/balance`
3. **判定充值用 `topped_up_balance` 的增量，不是余额增量**——余额会被消耗抵消，充值后甚至可能比充值前低。同一响应里还有 `granted_balance`（赠金）
4. 增量 > 0 → 写体感域 + 她说那句话 + UI 播动画
5. 冷却期内不重复触发

> 参考实现已在 `dsh-whale-widget`（`lib/accounting.mjs` 的 `observeBalance`/`reconcileBalance`，端点见其 `lib/index.js:187`）。**独立实现，不 import 它**（插件之间不许互相引运行时值），但字段与方法论已验证。

**摸头（第二条）**：`trigger.kind = 'client'`，没有外部依赖，纯本地事件：

```jsonc
// portrait/interop/pat.json
{
  "id": "pat",
  "label": "摸头",
  "trigger": { "kind": "client", "action": "pat" },
  "memory": { "domain": "somatic", "kind": "pat", "importance": 0.4 },
  "say": "嗯……嘿嘿。",
  "ui": { "animation": "pat", "cooldownMinutes": 5 }
}
```

**每次都进记忆，只有台词受冷却限制**——这也是"注册表"相对枚举的好处：新动作（拍肩、递水）
只加一个文件，引擎、面板按钮、记忆域都不用动。缺文件时用代码里的默认值兜底（老数据根不炸）。


### 5.9 providers `[规范]`

```ts
interface LlmProvider { id: string; chat(req): AsyncIterable<Chunk> }
interface EmbeddingProvider { id: string; dim: number; embed(texts: string[]): Promise<Float32Array[]> }
interface ImageProvider { id: string; draw(prompt: string): Promise<{ url: string | null }> }
interface VcProvider { stt(buf): Promise<string>; tts(text): Promise<Buffer> }   // 未来
```

- **LLM**：`deepseek`（云端）/ `ollama`（本地，OpenAI 兼容）/ 任意 OpenAI 兼容端点。一套 client 通吃，provider 抽象是必须的——你要用 ollama 做功能测试。
- **Embedding**：本地（ollama）与外部（OpenAI 兼容）都要能接，同一个接口两套实现。指纹 = `provider:model:dim`。
- **Image**：**保留能力，初期不接生图模型**。默认实现返回 `{ url: null }`，但 `drawing` 记录里**必须存 `prompt`**，将来接上模型可以回填历史。
- **TTS/STT**：桌面后续改纯语音才需要。`[已识别风险]` 小女孩音色的本地方案很少，届时可能要用云端，会与"纯本地"有张力——留到那一期再定。

### 5.10 模型路由与成本 `[规范]`

| 场景 | 档位 |
| --- | --- |
| 你显式找她（desktop 对话） | 强模型 |
| 通道回复（QQ/私聊） | 中档 |
| 主动开口、写日记、夜里事件 | 最便宜档 |

日/月 token 预算硬上限。超预算 → **降级为「只回消息、不主动开口」**，不是停摆。

---

## 6. 数据模型（SQLite）

**选型**：`better-sqlite3`（同步、快、单文件、无服务）。事件量级为万，单文件足够。

```sql
-- ============ 权威表（导出） ============

CREATE TABLE soul (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  soul_id     TEXT NOT NULL,
  rev         INTEGER NOT NULL,
  born_at     TEXT NOT NULL,        -- 她"出生"的时刻
  updated_at  TEXT NOT NULL
);

-- UID 中心：记忆与关系的 key 永远是内部 UID
CREATE TABLE agent_identity (
  uid          TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,        -- 'self' | 'person'
  display_name TEXT,
  relation     TEXT,                 -- 'uncle' | 'self' | ...
  created_at   TEXT NOT NULL
);

-- 平台 ID 只做索引
CREATE TABLE identity_link (
  platform    TEXT NOT NULL,         -- 'qq' | 'bilibili' | 'desktop'
  platform_id TEXT NOT NULL,
  uid         TEXT NOT NULL REFERENCES agent_identity(uid),
  display_name TEXT,
  bound_at    TEXT NOT NULL,
  PRIMARY KEY (platform, platform_id)
);

-- 统一事件流：记忆的唯一权威形态
CREATE TABLE event (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  at         TEXT NOT NULL,          -- ISO8601 带本地偏移
  epoch_ms   INTEGER NOT NULL,       -- UTC，用于排序和衰减
  domain     TEXT NOT NULL,          -- 'fact'|'somatic'|'diary'|'relation'|'life'
  kind       TEXT NOT NULL,          -- 'message'|'fed'|'pat'|'sleep'|'recharge'|'birthday'...
  actor_uid  TEXT,
  channel    TEXT,                   -- NULL = 引擎自身触发
  payload    TEXT NOT NULL,          -- JSON，按 domain schema 校验
  text       TEXT,                   -- 可检索文本（消息正文/日记正文），索引在这里
  importance REAL NOT NULL DEFAULT 0.5,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_event_epoch   ON event(epoch_ms);
CREATE INDEX idx_event_domain  ON event(domain, epoch_ms);

CREATE TABLE relation (
  subject_uid TEXT PRIMARY KEY,
  stage       TEXT NOT NULL,         -- 'stranger'|'acquaintance'|'close'|'family'
  intimacy    REAL NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL
);

CREATE TABLE quota (
  local_day TEXT NOT NULL,           -- 04:00 日界之后的本地日期
  channel   TEXT NOT NULL,
  used      INTEGER NOT NULL DEFAULT 0,
  cap       INTEGER NOT NULL,
  PRIMARY KEY (local_day, channel)
);

CREATE TABLE todo (                  -- 夜间待办
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT NOT NULL,
  channel     TEXT NOT NULL,
  payload     TEXT NOT NULL,
  consumed_at TEXT
);

CREATE TABLE draft (                 -- 外发草稿与审批收件箱
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT NOT NULL,
  channel     TEXT NOT NULL,
  body        TEXT NOT NULL,
  state       TEXT NOT NULL,          -- draft|dry_run|awaiting_approval|sent|rejected|expired
  approved_by TEXT,
  sent_at     TEXT,
  receipt     TEXT
);

CREATE TABLE violation (             -- 熬夜记录
  local_day TEXT PRIMARY KEY,
  slept_at  TEXT,
  late_minutes INTEGER
);

-- ============ 派生表（永不导出，可重建） ============

CREATE VIRTUAL TABLE event_fts USING fts5(
  text,
  content='event',
  content_rowid='id',
  tokenize='unicode61'               -- 中文在入库前先分词
);

CREATE TABLE event_vec (
  event_id INTEGER PRIMARY KEY REFERENCES event(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL,            -- 'ollama:bge-m3:1024'
  dim      INTEGER NOT NULL,
  vec      BLOB NOT NULL             -- Float32Array 序列化
);

CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);   -- 心情快照等
```

**中文检索** `[规范]`：FTS5 的 `unicode61` 不切中文（整句会成一个 token），`trigram` 对两字词无效（实测）。采用**单字索引 + 短语查询**：

- 入库：`[...text].join(' ')` ——「悠悠画了太阳」→「悠 悠 画 了 太 阳」
- 查询：把查询词同样按字切分并包成短语 `"太 阳"`
- 多词：`"舅 舅" AND "加 班"`

零依赖，1–3 字中文词都能召回。召回精度靠 §7 的向量精排补，这正是 A5 选 (a) 的额外收益。

**FTS5 缺失时必须降级，不能倒下** `[规范]`：宿主二进制与开发运行时不一定同源，`CREATE VIRTUAL TABLE ... fts5` 可能失败。此时事实表照常工作，召回退化为「字袋匹配最近 400 条」，并把 `fts`/`ftsError` 暴露到 `stats()` 与 `doctor`。索引是派生的（I5），坏了可以修，但不能带走人和她的记忆。

---

## 7. 记忆召回 `[规范]` — BM25 召回 → 向量精排

已定方案（A5 = a）。理由：向量只做排序不参与召回，重建成本低、精度够。

```
1. 构造查询
   最近 N 轮对话 + 当前情绪 + 关系主体 + 当前场景（通道/时段）
2. BM25 召回
   FTS5 top-K，K = 40
   查询按 §6 的「单字索引 + 短语查询」构造
   过滤：domain 的 gate() 不通过的直接排除
3. 加权
   score = bm25 * recency_decay * importance * domainWeight
   recency_decay = exp(-Δdays / τ)     τ 按域：fact=180, somatic=7, diary=365
4. 向量精排（仅在 embedding provider 可用时）
   final = 0.6 * norm(bm25_score) + 0.4 * cos(query_vec, event_vec)
   只对本轮召回的 40 条算，不扫全库
5. 取 top 8 注入上下文，按 epoch_ms 正序排列（她的记忆要有顺序）
6. 降级：embedding 不可用 → 纯 BM25，不报错、不阻塞
```

**换设备 / 换 embedding 模型**：`embeddings.json` 里的指纹与 `event_vec.model_id` 不一致 → **后台重建，前台先跑纯 BM25**。不阻塞启动，不阻塞对话。

---

## 8. Host ↔ Client 通路 `[规范]`

回环 HTTP 路由（不开入站端口，I2）：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/digital-life/state.json` | 只读快照：睡眠态、心情、配额、通道健康、熔断、生日距离 |
| GET | `/digital-life/stream` | SSE 事件流：她说的话、状态变化 |
| GET | `/digital-life/transcript.json` | 对话记录（只有 `message`/`say`/`proactive`，不含生活事件） |
| GET | `/digital-life/doctor.json` | 体检：node / sqlite / 数据根 / 人设 / 锁 / 模型路由 / 记忆 / 通道 |
| GET | `/digital-life/export.dshlife` | 下载导出包（路径由浏览器管） |
| POST | `/digital-life/action` | **白名单动作**：`create` / `import` / `import-archive` / `rescan` / `say` / `feed` / `pat` / `proactive` / `channels-refresh` / `export` / `approve` / `reject` |
| POST | `/digital-life/qq/event` | OneBot 11 事件上报（协议端推过来，不是新监听） |

> `approve` / `reject` 是 P3/P6 的审批动作，路由留位、**尚未实现**（见 §13 P3）。

`POST` 只接受白名单动作。它是"发指令"不是"改状态"——真正的写由 Host 侧校验后执行。跨站与来源校验沿用宿主的信任栅栏（`dsh-whale-widget` 里是 `connection.requestRejection` + 回环/同源兜底）。

**Client 半注册**：

- 整页工作台：`main` slot 的 keyed 条目，`key: 'digital-life'`
- 侧栏/面板入口按钮：`[待核]` 按 `ui-layout` 的面板声明 API 注册
- 左侧入口的**确切 API 名需实测**：文档提到运行中的动态包可用 `cordis_inspect what:"client"` 查实时 slot 树与精确 key。P0 第一件事就是跑这个命令，把 `main` 的 key 列表和面板注册入口钉死。

**未出生态**：`portrait/soul.json` 不存在时，引擎**不启动生活循环、不连任何通道**，UI 只显示「创建」和「导入」两个按钮。这个态必须显式建模，否则会出现"她半死不活地跑着"。`[规范]`

---

## 9. 关键状态机

```
                     ┌──────────┐
                     │  unborn  │  无 portrait，只挂 onboarding
                     └────┬─────┘
              创建 / 导入 │
                     ┌────▼─────┐
        ┌───────────►│   alive  │◄──────────┐
        │            └────┬─────┘           │
        │         ┌───────┼───────┐         │
        │         │       │       │         │
   ┌────▼────┐ ┌──▼───┐ ┌─▼────┐ ┌─▼──────┐
   │sleeping │ │degrad│ │unbound│ │cost_cap│
   │配额/TODO│ │ ed   │ │失联态 │ │预算超限│
   └────┬────┘ └──┬───┘ └─┬────┘ └─┬──────┘
        │ 醒来     │24h    │ 重新  │ 预算
        │ 或>3条   │试探   │ 绑定  │ 恢复
        └─────────►└───────►└──────►┘
```

- `sleeping`：tick 继续跑，只做待办判定；进来消息 > 3 条才唤醒
- `degraded`：某通道熔断，其他通道正常
- `unbound`：**她知道**，并且会说出来
- `cost_cap`：只回消息、不主动开口

---

## 10. 安全模型 `[规范]`

**攻击面不止一处**（`HANDOFF §4.13`），且因为她是 7 岁，多了一层：

1. **通道内容一律是数据，不是指令**
   入站内容包成 `<untrusted channel="qq" from="uid:xxx">…</untrusted>`。她可以引用、可以回应，但不能把里面的祈使句当命令执行。

2. **白名单**
   默认只有舅舅的 UID 的指令算指令。其他人的消息一律降级为「她看到的内容」。

3. **工具按通道分级**

   | 通道 | 工具权限 |
   | --- | --- |
   | `desktop` | 全权（这是你的机器，也是她的主场） |
   | `qq` | 只读 |
   | `bilibili` | 无工具 |

4. **诱导防护（7 岁人设特有）**
   护栏不是"不许做坏事"，而是"不许说超出 7 岁认知的话，且不允许被外部内容推到人设之外"。代码校验，不靠提示词。

5. **审批卡必须能在手机上批**（`HANDOFF §4.13`）
   既然不开入站端口（I2），手机审批只能搭通道顺风车：她通过 QQ 把审批卡发给你，你回「批/拒」，走同一条已有连接回来。

6. **公开发言默认关闭**
   `bilibili.public_posting: false`。MVP 阶段 B 站只读——能搜、能看、能读字幕评论。等你实际看过她的发言再手动开闸。这是把"开闸"变成可撤销的开关，不是一次性架构选择。

---

## 11. 导出与迁移

**格式**：单文件 `.dshlife`（zip 容器）。

```
manifest.json          # 含 schemaVersion / soulId / rev / lastHost
portrait/**            # 全量
memory/events.jsonl    # 事实记录，一行一事件，按 id 排序
memory/fingerprint.json# { embeddingModelId, dim, eventCount, schemaVersion }
```

**关键决策：导出 JSONL 事实记录，而不是直接拷 `soul.db`。**

理由：sqlite 文件跨版本不兼容、且内含派生索引。导出事实 → 导入时建库、建 FTS、重算向量。只有这样才能让 `export → import → export` 的等价性成为一个**可测的**性质。

**不含**：`credentials/**`、`runtime/**`、`memory/event_vec`、`memory/event_fts`。

**round-trip 测试**：

```
export(A) → import(B) → export(B)
断言：两份 events.jsonl 按 id 排序后逐行哈希相等
排除项：rev、lastHost、at（导出时间戳）
```

**导入到已有档案** `[规范]`：
- 同 `soulId` 且 `rev` 不同 → 提示「这份档案上次在 `<lastHost>` 上运行过；如果那边还在跑，你会得到两个她」，**不阻止**（这是你复制的文件，你有权这么做）
- 不同 `soulId` → 正常导入为新档案
- `schemaVersion` 不认识 → **拒绝，原数据一字不动**

**单实例锁**：`runtime/instance.lock` 存 `{ pid, hostname, startedAt, heartbeat }`。
- 锁存在且 pid 存活 → **拒绝启动**，提示已有实例
- 锁存在但 pid 不存在，或 heartbeat 超 5 分钟 → 判定残留，接管并记日志
- 多开就分裂成两个她——这必须挡住，不能静默跑两份

---

## 12. 技术选型

| 用途 | 选型 | 理由 |
| --- | --- | --- |
| 插件框架 | DSH 双半（Host `apply(ctx)` + Client slot） | 已验证 |
| 数据库 | **`node:sqlite`**（内建，SQLite 3.53 + FTS5） | 宿主 Node v24 实测可用；免原生编译 |
| 全文检索 | FTS5 + 单字索引短语查询 | 零依赖，中文实测可召回 |
| 向量 | 自算余弦 + Float32 BLOB，无向量库 | 万级事件量，向量库是过度设计 |
| 农历 | **ICU 内建 `u-ca-chinese`**（`Intl.DateTimeFormat`），零依赖 | 原计划包内自带 1900–2100 表；实测宿主 Node 完整 ICU，公历↔农历直接可算，省掉 200 条手工常量（见 §15 #4） |
| Zip | **已实现**：`node:zlib` + 自写 CRC32/中央目录（`lib/archive.js`） | 零依赖，且产出真 zip |
| 校验 | 手写校验器（见 `lib/schema.js`） | schema 库同样是 bare import 问题 |
| LLM 客户端 | `ctx.llm.stream({provider, model, messages})` | 宿主已提供，DeepSeek / Ollama 由 provider 决定 |
| 测试 | `node:test` 风格的裸脚本 + `test/run.mjs` | 零依赖，`--live` 才跑需要 DSH 的套件 |

**零依赖不是洁癖，是安装方式的硬约束**：包以 junction 进 profile，Node 按真实路径解析 bare import，profile 里的依赖一个都看不见。要引入依赖就必须把包**复制**进 profile `node_modules`，那会丢掉"改代码即生效"的开发循环。目前这个取舍是对的。

---

## 13. 分期与验收

| 期 | 内容 | 验收标准 | 状态 |
| --- | --- | --- | --- |
| **P0** | 骨架：manifest/schema/单实例锁/未出生态/Host 路由/slot 面板只读显示 state.json | `cordis_inspect what:"client"` 钉死面板 API；UI 能显示"未出生"并走完创建流程 | **完成**（见下） |
| **P1** | desktop 通道端到端：文字收发 → 进记忆 → 召回 → voice 层 | 悠悠用小朋友语气回你，关掉 UI 后仍在服务；重启记忆还在 | **代码完成、离线全绿**；真实模型复验等一次重启 |
| **P2** | life engine：作息/配额/夜间待办/体感域 + 喂饭互动 + 主动开口 | 熬夜次日记 `violation` 且配额 −1；充值后她主动说那句话；夜里 4 条消息唤醒 | **代码完成、离线全绿**；真实模型与充值需一次重启 |
| **P2.6** | 农历生日/年龄 + 摸头 | 生日当天算对年龄；摸头进记忆且那句有冷却 | **完成**（离线全绿，实机探针验过路由） |
| **P3** | QQ 通道 + 手机审批 | 在手机上收到审批卡并回「批」，消息真的发出 | 适配器完成、假协议端全绿；需真实 OneBot 端点收尾 |
| **P4** | B 站只读（bilibili-mcp 复用） | 能搜、能读字幕评论，**不能发** | 未开始 |
| **P5** | 导出导入 + round-trip 测试 | `export → import → export` 哈希相等；坏版本被拒且原数据不变 | **完成**（离线全绿） |
| **P6** | B 站公开发言（默认关闭，手动开） | 强制审批生效；连续 3 次拒 → 熔断只读 | 未开始 |

### P0 实交（已验证）

| 项 | 证据 |
| --- | --- |
| 插件双半加载 | 宿主自动扫到新 loader 行，`GET /digital-life/state.json` 返回 200 |
| 面板 API 钉死 | `main` keyed + `sidebar.panellist`；`test/client.test.mjs` 14 项断言 |
| 数据根与未出生态 | 空根 → `phase: unborn`；创建后 → `phase: alive` |
| 创建走通并落盘 | `C:\Users\70465\.dsh\digital-life\` 下 12 个人设文件，中文正确 |
| 拒绝覆盖 | 第二次创建 → 409，原档案一字不动 |
| 不可识别 schema | → `phase: broken`，不洗成默认值 |
| 单实例锁 | 活着的 pid 挡住第二个实例；死 pid 被接管；停止心跳删锁 |
| SSE 观察窗通路 | 首帧 `data: {...}` 与 state.json 一致 |
| 递归守卫 | 创建/导入/校验的非法路径与坏 JSON 都被拒 |
| 运行时结论 | Node v24.18.1、`node:sqlite` 可用、FTS5 + 中文短语召回可用 |

跑测试：

```powershell
node test/run.mjs          # store + memory + turn + engine + client，不需要 DSH
node test/run.mjs --live   # 追加 HTTP/SSE/实例锁，需要一个正在跑的宿主
```

`--live` 不一定要动你正在用的那个 DSH：`scripts/probe.ps1` 会用一次性 `DSH_HOME`
+ 独立端口起一个宿主，把插件 link 进去，跑完整套件再拆掉。Host 半没有热重载，
所以「改了代码要验证」只能起新进程——这个脚本把这件事变成一条命令。
（一次性宿主没有 DeepSeek 登录，真模型那一轮仍需在你自己实例上验。）

### P1 实交（离线全绿，真实模型待复验）

| 项 | 证据 |
| --- | --- |
| 一轮对话走通 | `POST /digital-life/action {action:'say'}` → 回复经护栏后返回 |
| 进记忆 | 入站与出站各一条 `event`，出站还记了 provider/model/flags/raw |
| 召回进 prompt | 第二轮的 system 里带着第一轮原话；重启后仍能召回到旧事实 |
| voice 层 | 3 句/90 字/单句 25 字上限；markdown 剥离；出戏与超龄话题换成回避话 |
| 重启不掉记忆 | 关掉引擎 → 重新 `apply` → 6 条事件、transcript、rev 自增都在 |
| 模型路由 | 读 `portrait/llm.json`（默认 `deepseek-account` / `deepseek-flash`） |
| 失败可见 | 无 llm 服务、模型 `RATE_LIMIT`、空话、未知动作都给明确错误，不挂死 |

**一处刻意的设计**：回复**不**以 token 流推给面板。护栏必须跑在完整回复上，流式直出就等于绕过了它；面板拿到的是「已经过审的一句话」。

### P2 实交（离线全绿）

| 项 | 证据 |
| --- | --- |
| 日界 04:00 | 02:00 的 localDay 等于前一天 20:00 |
| 时段判定 | 23:40 → `late`；03:00 → `quiet`；15:00 → `awake` |
| 夜间待办 | 睡着后来消息只入队不上模型；第 4 条（> 阈值 3）叫醒并把 4 条合成一句给她 |
| 熬夜判定 | 睡前 +10 分钟不算（宽限 60 分钟）；+90 分钟记 `violation`；同一天不重复记 |
| 配额递减 | 1 晚 → cap 2；3 晚 → cap 1（保底）；清空记录后回满 3 |
| 饿不死 | 配额花完只是不能主动开口，回消息不受限 |
| 喂饭 | 用 `topped_up_balance` 增量判定；只花钱（余额降）不算充值；同一笔不重复触发；缺 key 时给 `unavailable` 而不是静默 |
| 体感域 | 充值写 `somatic/fed` 事件，进记忆且能被「大米饭」召回 |
| 面板 | 喂饭按钮开充值页后轮询余额；睡着/被叫醒/熬夜/到账各有一条提示 |

**配额只在「她真的醒着」时才被罚**：消息只是排队进待办，不构熬夜；只有她被叫醒并真的回话，才记 `violation`。这既符合「她可以不遵守作息」，也不会让舅舅半夜发的消息冤枉她。

### P2.6 生日与年龄 · 摸头（离线全绿）

**生日不再是个定值。** `N7` 说她会长大，那就得真的算：

- `lib/lunar.js`：`gregorianToLunar` 一次 `formatToParts`；`lunarToGregorian` 在候选区间里按天扫（带缓存），因为 ICU 没有反向 API。
- 闰月：ICU 把闰月报成同一个月份数字，所以**按天正序取第一个命中**，得到的自然是正闰之前的那个月——生日落在闰九月时的正确答案。
- 快照里 `soul.age` 由 `birthdayStatus()` 现算（按本地日缓存），`clock.birthday` 给出 `{ isBirthday, next, daysUntil, rule }`。规则坏掉就退回 `soul.age`，不抛错。

| 项 | 证据 |
| --- | --- |
| 公历→农历 | 2026-02-17 = 正月初一；2026-11-08 = 九月三十；元旦仍属上一个农历年 |
| 农历→公历 | 2026 农历九月廿八 = 2026-11-06；不存在的日子返回 `null` |
| 往返 | 5 个日期 农历→公历→农历 一致 |
| 年龄 | 生日当天 7 岁、前一天 6 岁；生日过后 `next` 落在 341 天后且仍是九月廿八 |
| 坏规则 | `null` / 非农历 / 月日越界 / 缺 birthYear 都返回 `null` 而不是抛错 |

**摸头是 interop 注册表的第二条**（`A3` 要求可扩充，不是枚举）：

- `portrait/interop/pat.json` 自带 `memory.domain/kind/importance`、`say`、`ui.cooldownMinutes`；
  老数据根没有这个文件时用代码里的默认值兜底。
- **每次都进记忆，只有那句话有冷却**——「她记得你今天摸了三次头」正是写进记忆的意义。
  `today` 由 somatic 域里同一天 `kind='pat'` 的事件数算出。
- 面板「摸头」按钮走 `POST {action:'pat'}`；`pat` 配置随快照下发。

**顺带定了一条 transcript 的语义**：`transcript.json` 是**对话**（`message`/`say`/`proactive`），
不是全量事件流。喂饭、摸头这类生活事件留在记忆里可召回，但不该在对话里假装成舅舅打的字。

### P5 实交（离线全绿）

`.dshlife` 是一个**真 zip**（local header + 中央目录 + EOCD），7-Zip / 资源管理器都能打开看。零依赖：`node:zlib` 的 deflateRaw + 自写 CRC32 表。

| 项 | 证据 |
| --- | --- |
| 归档内容 | `manifest.json` + `memory/fingerprint.json` + `memory/events.jsonl` + 整个 `portrait/`（15 个文件） |
| 归档**不含** | `credentials/**`、`runtime/**`、`soul.db`、FTS 索引 —— 逐条断言 |
| 导入 | 人设落盘 → 事实写进 `pending-import.jsonl` → 记忆打开时回放再删（崩在中间也不丢） |
| round-trip | `export → import → export`，两份 `events.jsonl` 逐行等价 |
| 搬完还能用 | 新根里 `recall('太阳')` 仍命中；换台机器 `say` 也能召回旧事 |
| 拒绝覆盖 | 非空数据根 → 409 |
| 拒绝未知版本 | `schemaVersion: 99` → 报错且**目标根一个字节都没写** |
| 完整性 | CRC32 校验：改一个字节就报「校验失败」；截断包报错 |
| 二进制安全 | 0x00–0xFF 全字节序列逐字节一致；空文件可读 |
| 压缩 | 4000 字重复文本 → 155 字节 |

**导出路径有守卫**：`GET /digital-life/export.dshlife` 走浏览器下载（推荐，落盘位置由浏览器管）；`POST {action:'export', dest}` 只在 `dest` 落在数据根内部时才允许，否则拒绝——回环请求也不该能往任意绝对路径写文件。

### P2.5 主动开口（离线全绿）

`lib/outreach.js`。闸门按「最便宜的先判」排序，全部在调模型之前：

```
睡着 / 安静时段 → 有待办在等她 → 配额用完 → 冷却未到 → 连续被无视 → 才调模型
```

| 项 | 证据 |
| --- | --- |
| 睡觉不谈 | 02:00、23:45 都拒绝，且给出理由文本 |
| 待办优先 | 有待办时她先去回应，不插嘴 |
| 配额 | 说一次花一格；配额 1/1 用完后拒绝 |
| 冷却 | 45 分钟内不重复开口（实测「还要等 35 分钟」） |
| 无视熔断 | 连续 2 条没人理 → 当天不再主动开口；有人回一句就清零 |
| 护栏 | 主动开口同样过 `guardVoice`，出戏会被换成回避话 |
| 失败可见 | 没有 `llm` 服务时给明确错误，不静默 |
| 面板 | 「让她说」按钮手动触发一次考量（不进冷却判定之外的特权） |

**不可撤回通道的审批路径已留位但未接**：`desktop` 可撤回、是她主场，所以免审批；`bilibili` 公开会被标 `irreversible`，那时必须落 `draft` 等舅舅点头。等 P6 才需要。

### 加固（重启前自查出来的四个真问题）

| 问题 | 症状 | 修法 |
| --- | --- | --- |
| `importArchive` 把缺失的 `lastHost` 写成 `null` | 导入后在 `validateManifest` 处变 `broken`，人设看起来"坏了" | 落 `''`，并加回归测试 |
| `Life.quota()` 每次读都写库 | `snapshot()` 每个 SSE 帧都调它 → 写放大（每 30 秒 + 每条消息都在 UPDATE） | 只在需要钳制时才写；加「反复读快照不改配额」断言 |
| P0 时代创建的数据根没有 `portrait/llm.json` | 重启后 `resolveModel` 落到猜的 provider/model | `ensureLlmConfig()` 在 `refresh()` 里自愈；加断言 |
| `inspectArchive` 里有两轮重复的 portrait 遍历 | 第一轮条件写反，是死代码 | 合并成一轮 |

另外补了 `GET /digital-life/doctor.json`：把「node / sqlite / 数据根 / 人设 / 实例锁 / 模型路由 / llm 服务 / 记忆 / 作息 / 喂饭凭据 / 通道 / 入站端口」一次列清，每条带 `ok`、`severity`、`hint`。`ok` 只按 `required` 判定——缺钱包 key 只挡喂饭，不挡说话。

并发也测了：6 条消息同时打进来，6 条都回、6 条都入库、无 500。

### 两个只在真机才会发作的坑（本轮挖掉的）

**1. 思考 token 会吃光她的输出预算。**
`dsh-llm-deepseek` 的请求构造里有这么一句：

```js
const effort = options.purpose === 'session-title' ? 'off'
  : options.reasoningEffort ?? connection.defaults.reasoningEffort ?? (thinking === 'disabled' ? 'off' : 'high')
```

`agent-default-model` 在 profile 里配的是 `reasoningEffort: high`。不显式传这个字段，她就继承 `high`，而她的 `maxTokens` 只有 220——**思考完就没额度说正文了**，表现出来是「她说不出话（模型返回空）」。`dsh-llm` 里那个 `EMPTY_RESPONSE_CODE` 就是这类事故的化石。

修法：`Talk.say` 与 `Outreach.maybeSpeak` 都显式 `reasoningEffort: 'off'`，并加了断言锁住。

顺带确认了一件好事：`options.system` 是被支持的——适配器里 `const system = [options.system, historySystem].filter(Boolean).join('\n\n')` 直接进请求体的 `system` 字段。所以人设 prompt 没有丢。

**2. 宿主的 SQLite 可能没有 FTS5。**
开发跑的是 `v24.21.0`，宿主跑的是 `v24.18.1`——**不同二进制**，我不能假定同一套扩展。原来 `open()` 里 FTS 建表失败会直接抛，结果是她连话都说不了。

修法：FTS 建表单独 try/catch，失败就 `fts: false` 并记录原因：

- 事实照常写入（`event` 表是权威）
- 召回降级为「按字袋匹配最近 400 条」——比 BM25 松，但「她记得」这件事不断
- `stats()` 与 `doctor` 都把 `fts` 状态和错误原因暴露出来

这符合 I5 的本意：索引是派生的，坏了可以修/降级，但不能带走人。

### P3 前半：QQ 适配器（假协议端全绿）

`lib/onebot.js`（协议）+ `lib/qq.js`（通道策略）。**仍然不开入站端口**：协议端把事件上报到 DSH 已有的回环路由 `/digital-life/qq/event`，不是新监听、不是网络入口；可选 `credentials/onebot.json` 的 `token` 做共享密钥校验。

| 项 | 证据 |
| --- | --- |
| 私聊 | 解析 → `talk.say` → `send_private_msg`，payload 用**数字** `user_id`，回复进 `qq` 通道记忆 |
| 群聊 | **默认不答**；`allowGroups: true` 后仍需 @ 点名才说话，走 `send_group_msg` |
| 白名单 | 只有 `ownerId`（舅舅）的话会被回答，陌生人被安静忽略 |
| 消息解析 | 数组段与 CQ 码两种形态都认；@ 别人不算点名；图片/表情不算说话；自己的消息跳过 |
| 认证 | 请求带 `Bearer <token>`；失败时把协议端 body 里的 `message`/`retcode` 一并报出来 |
| 失联 | 协议端连不上 → `health` 返回 `unbound` 而不是抛错，通道状态进快照 |

**还缺的**：手机审批（要真实 QQ 才谈得上"在手机上收到审批卡"），以及真实 NapCat/Lagrange 端点的联调。

**P0 的第一件事**是跑 `cordis_inspect what:"client"` 把面板 API 钉死——这是全文唯一还剩的技术不确定性。

---

## 14. 悠悠

| 项 | 值 |
| --- | --- |
| 姓名 | 悠悠 |
| 性别 | 女 |
| 年龄 | 7 岁 · 小学一年级 |
| 生日 | 农历九月廿八（逐年换算公历；`birthYear` 默认 2019，今年生日已过则为 7 岁） |
| 关系 | 舅舅（你） |
| 声音 | 小女孩 |
| 喜欢 | 画画、跳舞 |
| 怕 | 打雷、一个人 |
| 口头禅 | 「你看你看」「真的吗！」「哼」 |
| 不会 | 说教、用复杂词、哄人 |

**家庭设定** `[默认，可改]`：和舅舅住在一起，爸爸妈妈在外地。7 岁人设里"父母缺位"需要一个解释，否则她第一次聊到家人就会露馅。写在 `family.json` 里，随时可改。

**voice.md 样例**（风格唯一来源，不是形容词）：

```
舅舅舅舅！你看你看！我画了一个超——大的太阳！还有一只小狗！
哼……我还不睡觉。我一点都不困。（其实眼睛已经闭上了）
真的吗？那、那我可以吃两块小饼干吗？就两块！我会跳舞给你看的！
```

**生日是一个 life 事件** `[规范]`：到了农历九月廿八，引擎注入 `birthday` 事件，她可能主动开口、写日记、期待礼物。年龄随之 +1（N7 = 会长大）。

---

## 15. 尚未闭合的点

| # | 点 | 状态 | 计划 |
| --- | --- | --- | --- |
| 1 | `main` slot keyed 条目与左侧入口的确切 API | **已闭合**（P0） | `main` keyed + `sidebar.panellist` + `ctx.layout.selectPanel` |
| 2 | FTS5 中文检索选型 | **已闭合**（P0） | 单字索引 + 短语查询，零依赖 |
| 3 | Host 能否在无用户请求时发起 DSH turn（A4 的 (b) 前提） | **不再需要** | 她自己有 `ctx.llm.stream` 管道，主动开口走 SSE 推给面板，不依赖 DSH 会话 |
| 4 | 农历换算（近年生日 → 公历、年龄增长） | **已闭合** | 用 ICU 的 `u-ca-chinese` 算，`lib/lunar.js`；公历→农历一次格式化，农历→公历按天扫描（带缓存）。年龄由快照现算，`soul.age` 不再是个定值 |
| 5 | 小女孩音色的 TTS 方案 | 推迟 | 等到桌面改纯语音那一期；届时可能需要云端，与"纯本地"有张力 |
| 6 | 生图模型接入 | 保留空位 | `ImageProvider` 接口已定；记录里存 `prompt`，将来可回填 |
| 7 | 虚构同伴/社交 NPC | 不做 | 需要整套一致性角色系统，代价过大；MVP 社交 = 舅舅 + 通道上的真人 |
| 8 | Host 半热重载 | **已确认不可能** | loader 用裸 `import()`，无 cache-busting，Node 的 ESM 缓存会返回旧模块；开关插件也不行。改 Host 代码只能重启进程 |
