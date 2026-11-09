# dsh-digital-life · 交接文档

> ⚠️ **这是迁移时的历史快照，不是当前状态。**
> 当前状态看 `ARCHITECTURE.md`（实现依据 + 分期验收）与 `DECISIONS.md`（决策）；
> 2026-11-08 那次会话中断的复盘与修复记录在 `INCIDENT.md`。
> 下文 §5 的「待定问题」已全部回答，§6 的「下一步」也已走完（P0–P2.6 完成）。

> 本文件是从 `default-workspace` 会话（session-5a288a53）转入本工作区时的上下文快照。
> 新会话读这一份即可续上，不需要翻旧对话。

- 建立时间：2026-11-08
- 状态：**设计阶段，尚未写代码**
- 本工作区此前为空

---

## 1. 项目一句话

基于 DeepSeek Harness 的数字生命：**一套人设、多平台通道**；人设 / 记忆 / 配置全部本地文件化且可搬运；界面是暖光书房式控制台（参考 `deepseek-companion-wallpaper` 的界面风格，**不复用其视觉素材**）。

---

## 2. 原始需求（用户原话转写）

1. 所有的外部通道都维持同一套人设。
2. 所有的人设、记忆、配置都保存在本地且可插拔；导出这个文件后可在另外的设备上复现，即**项目运行只由配置文件控制，不由设备控制**。
3. 项目基于 DSH 运行，但操作风格不再是 DSH 页面，而是 `https://github.com/fjdsjd/deepseek-companion-wallpaper` 的界面风格。

---

## 3. 已决定的五个方向

| 维度 | 选定 | 含义 |
| --- | --- | --- |
| UI 档位 | **L2 侧栏独立工作台** | 在 DSH 插件里开一整页自定义 UI；会话流、审批、模型路由仍由宿主提供 |
| 凭据策略 | **不导出，新设备重新扫码** | 导出包只含人设/记忆/配置，token 与 cookie 永不落包 |
| MVP 通道 | **B站 / QQ / 桌面本体** | 桌面本体登录为首要验证通道 |
| 定位 | **独立的数字生命** | 有自己的作息，会主动开口，有社交关系 |
| 起点 | **从零自研，复用通道适配器与 bilibili-mcp** | 核心自己掌控，通道脏活复用已验证实现 |

---

## 4. 已得出的架构结论

### 4.1 她不能活在 UI 里（最重要）

侧栏工作台只在被打开时渲染。用户在外面、手机在 QQ 上找她、她该刷 B 站、该写日记——这些时候侧栏根本没开。

**所以 L2 只能是观察窗，不能是她的身体。她的「活着」必须在 Host 半（node 进程）常驻。**

```
┌─ Host 半（常驻，无 UI）───────────────┐
│  life 引擎   作息 / 心情 / 调度器       │
│  memory      soul.db（权威）            │
│  persona     portrait/                  │
│  channels/   bilibili · qq · desktop    │
│  scheduler   主动开口配额 / 安静时段     │
└──────────────┬───────────────────────┘
               │ webServer 路由 + 事件流
┌──────────────┴───────────────────────┐
│  Client 半 = 书房控制台（观察窗）        │
│  只读快照 + 少量操作（喂饭/摸头 = 发指令）│
└──────────────────────────────────────┘
```

### 4.2 「桌面本体」是一个 channel adapter，不是壁纸

它和 B 站、QQ 平级。桌面上摸头、喂饭、说话，走 `desktop` 通道，与 QQ 私聊进同一份记忆、同一个 soul。

好处：这是她唯一的主场——没有平台限流、没有风控、不用扫码。也让 L2 的 UI 有了正当性：不是一个好看的后台，而是真的在那儿和她相处。

### 4.3 单实例锁

数字生命多开就分裂成两个她。需要 `DSH_HOME` 文件锁，第二个实例直接拒绝启动，而不是静默跑两份。参考 `@lijian-ui/dsh-im-gateway` 的 `instance-lock.ts`。

### 4.4 凭据不出包 → 需要新的状态类型

换设备后人设和记忆都在，但 B 站 / QQ 未登录，而她记忆里写着「我在 B 站有个家」，会出现「她以为自己还在线」的错乱。

解法：导出包含**通道声明**（在哪些平台有家、叫什么名字），不含 token；启动时做**通道绑定检查**，未绑定的通道进入**失联态**，UI 可见，且她自己也「知道自己失联」。

### 4.5 外发动作必须能后悔

B 站评论、动态、QQ 群发言发出去收不回。数字生命 + 主动行为 = 一定会说错话。

所有外发必须走 **draft → dry-run → 确认 → 发出**，并带熔断（连续 N 次被拒就降级为只读）。这是长期活下去的前提，不是可选项。

### 4.6 别让 bilibili-mcp 的形状污染核心

定义窄的 `ChannelAdapter` 接口：`send` / `fetch` / `capabilities` / `health`。bilibili-mcp、OneBot(QQ)、desktop 都实现它。否则每加一个平台都要动核心。

### 4.7 配置分三层，不要一个包

| 层 | 内容 | 跨设备 |
| --- | --- | --- |
| `portrait` | 人设、记忆、日程、心情、偏好、通道策略 | 导出即复现 |
| `credentials` | 各平台 token/cookie、API key | 永不出包 |
| `runtime` | 帧率、窗口位置、显示器、本机路径、壁纸宿主 | 属于设备，不该被导出 |

只有严格分开，「运行只由配置控制」才是真的，否则只是把设备依赖挪进了文件。

### 4.8 记忆导出不要导向量

记忆不是文本，是原文 + BM25 索引 + 向量 + 衰减权重 + 关系阶段。向量是**派生数据**，换设备必须用同一 embedding 模型同一维度重算。

导出包只放事实记录 + `embeddingModelId` 指纹，启动时校验并重建索引。**把派生数据当权威数据导出，是这类项目最经典的翻车点。**

### 4.9 UID 中心的身份映射，第一天就定

QQ 的 A、B 站的 B、桌面的「我」是同一个人。记忆与关系的 key 必须是内部 UID，平台 ID 只做索引。这个决策晚做就要全量数据迁移，而且迁移时分不清「两个陌生人」还是「同一个人的两个号」。

### 4.10 persona = core + 每通道 overlay

同一个人格，在 QQ 群、B 站评论区、微信私聊、桌面里的正确行为完全不同。一份 prompt 打天下的结果是群里发长文、评论区刷屏。

分层：人格核心一套，通道策略（只听点名 / 群默认拒绝 / 每轮条数 / 主动发言开关）作为 overlay，且**策略写死在代码里，不靠提示词嘱咐**（`dsh-bili-scroll` 作者的实测教训：只靠提示词拦，迟早会漏）。

### 4.11 配置里不写绝对路径

DSH 生态大量使用 `cwd 必须是绝对路径`。写死 `D:\Users\...` 换机即废。

改为 `${DSH_HOME}` / `${WORKSPACE}` 插值 + `manifest.json` 里声明**能力需求**（需要一个可写 workspace），由宿主解析。

### 4.12 schemaVersion + round-trip 测试 + 拒绝覆盖

可搬运 = 会有多版本共存。至少要保证 `export → import → export` 字节级等价；读到不认识的 schema 时**拒绝覆盖**（宁可报错，也不要把用户数据洗成默认值）。

### 4.13 通道就是新的攻击面

群聊消息、B 站字幕与标题、评论区、文件名都能塞指令。

- 通道内容一律标为数据，不参与指令；
- 工具按通道分级（微信通道不该有删文件权）；
- **审批卡必须能在手机上批**，否则用户在外面时她什么都干不了；
- 白名单默认只放行本人。

### 4.14 版权：借风格，不借素材

`deepseek-companion-wallpaper` 的**代码是 MIT，但 PNG/GIF 等视觉素材明确不套用 MIT**（见其 `ASSETS.md`），字体为 SIL OFL。复刻布局与氛围可以，直接搬贴图会踩。

---

## 5. 待定问题（**已全部回答，见 `DECISIONS.md`**）

> 下方保留原始问题文本，仅作历史记录。答案、决策依据与落点全部记录在 `DECISIONS.md`；
> 由此得出的架构实现在 `ARCHITECTURE.md`。

1. **她「睡觉」时要真的停吗？** 24 小时跑会烧 token 和 GPU；彻底停则「半夜想找你」不可能。要「低功耗待机（只跑调度器不调模型）」还是「真停」？
2. **多设备是迁移还是同步？** 迁移（A 关机 B 接着活）简单；同步（两边都活）会有记忆库冲突，且同一账号两边同时操作会打架。
3. **desktop 通道的互动要不要进记忆？** 摸头 / 喂饭是纯客户端动画（不调模型），还是真的进记忆（「她记得你今天摸了三次头」）？后者更像活的，但会污染记忆检索。
4. **主动开口的默认配额？** 每天几次、安静时段、哪些通道允许主动。

---

## 6. 建议的下一步

1. **优先验证唯一的硬风险**：DSH 侧栏面板 slot 是否存在、API 形状是否支撑「Host 常驻 + Client 观察窗」。
   - 注意：DSH 安装在 `D:\Users\70465\AppData\Local\Programs\DeepSeek Harness\resources\app.asar`，是**打包的 asar 归档**，不是可读目录树，不能直接 grep。要么解包，要么从可用插件（`dsh-fish-soul` 的左侧栏「鱼」工作台）反推 API。
2. 定 `her/` 目录结构与 `manifest.json` schema。
3. 选一条通道做端到端（建议 B 站，因为 `bilibili-mcp` 现成）。

---

## 7. 参考项目

| 用途 | 链接 |
| --- | --- |
| 界面风格参考（Wallpaper Engine 交互壁纸，MIT 代码 / 素材另授权） | https://github.com/fjdsjd/deepseek-companion-wallpaper |
| B 站能力层（MIT，搜索/字幕/评论/发评论） | https://github.com/adoresever/bilibili-mcp |
| 最完整的「一人格多通道」实现，可参考其记忆与通道策略 | https://www.npmjs.com/package/dsh-fish-soul |
| 人设层与通道层解耦的范例 | https://www.npmjs.com/package/@hxql/dsh-persona-manager |
| 多 IM 通道网关（含实例互斥锁、审批桥、流式分片） | https://www.npmjs.com/package/@lijian-ui/dsh-im-gateway |
| 可移植人格标准（Soul Spec：soul.json / SOUL.md / IDENTITY.md…） | https://github.com/clawsouls/soulspec |
| 皮肤级改色实现（`theme.overrideTokens` + `body::before`，说明 L1 的能力边界） | https://www.npmjs.com/package/dsh-skin-alphacoders |

---

## 8. 环境事实

| 项 | 值 |
| --- | --- |
| `DSH_HOME` | `C:\Users\70465\.dsh` |
| profile | `desktop` |
| 本工作区路径 | `F:\dsh-digital-life` |
| 工作区注册表 | `C:\Users\70465\.dsh\storages\workspace.json` |
| DSH 安装位置 | `D:\Users\70465\AppData\Local\Programs\DeepSeek Harness\resources\app.asar`（打包归档） |
