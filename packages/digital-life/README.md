# dsh-digital-life

DSH 上的数字生命：一套人设、多平台通道。人设 / 记忆 / 配置全部本地文件化且可搬运。

**宿主半常驻，面板只是观察窗。** 关掉书房面板，她照样按作息活着。

## 安装到 profile

```powershell
# 需要能写 DSH_HOME
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install.ps1
```

做了两件事，都可还原（`scripts/uninstall.ps1`）：

1. `<profile>/node_modules/dsh-digital-life` → 本仓库 `packages/digital-life` 的目录链接
2. 在 `<profile>/cordis.patch.yml` 写一条 loader 行（先备份为 `cordis.patch.yml.before-digital-life`）

profile 是**探测**出来的，不是写死的：`-Profile` > `-DshHome` 下的 `profiles/desktop`、`profiles/web`
> 环境变量 `DSH_PROFILE_DIR` > 「只有一个 profile 就用它」。profile 还没有
`cordis.patch.yml` 时会新建；文件内容是空的 `[]` 时替换占位符而不是追加
（`[]` 后面接 `- insert:` 是非法 YAML，宿主会直接起不来）。

装好后 DSH 会自动扫到新行；左侧栏出现「书房」。**改 Host 半的代码必须重启 DSH 或开关该插件行**，改 Client 半刷新页面即可。

## 她的身体在哪儿

```
${DSH_HOME}/digital-life/          # 默认 C:\Users\<you>\.dsh\digital-life
├── manifest.json                   schemaVersion / soulId / rev / lastHost / 能力需求
├── portrait/                       人设（可导出）
│   ├── soul.json                   身份、年龄、农历生日、与舅舅的关系
│   ├── voice.md                    说话风格 few-shot —— 唯一风格来源
│   ├── schedule.json               固定作息表（她可以不遵守）
│   ├── outreach.json               主动开口配额、安静时段、夜间唤醒阈值
│   ├── domains/*.json              记忆域注册表（可扩充）
│   ├── channels/*.json             通道声明与策略（不含凭据）
│   └── interop/*.json              互动动作注册表：feed.json（喂饭）/ pat.json（摸头）
├── memory/                         事实记录（可导出，索引是派生数据）
├── credentials/                    永不出包
├── runtime/                        实例锁、设备相关状态，永不出包
└── logs/
```

## 面板

- 左侧栏「书房」图标 → 整页工作台
- 未出生时只有「创建」「导入」两个入口
- 出生后显示她是谁、她的进程、她的时钟（04:00 日界）、配额与待办
- **年龄和生日是算出来的**：农历九月廿八（ICU 的 `u-ca-chinese`），快照里带 `clock.birthday`
  的 `{ isBirthday, next, daysUntil }`，到日子她会长大一岁
- 「跟她说话」：回车发送，回复经护栏后以完整句子出现
- 「喂饭」：打开充值页并轮询 `topped_up_balance`，真到账才让她说话
- 「摸头」：每次都进体感域记忆（她记得今天被摸了几次），那句「嗯……嘿嘿。」有 5 分钟冷却
- 「把她打包带走」：下载一个 `.dshlife`（人设 + 记忆，不含凭据）；导入在未出生界面里选文件或目录

所有读写走回环 HTTP：`GET /digital-life/state.json`、`GET /digital-life/stream`（SSE）、`GET /digital-life/transcript.json`、`GET /digital-life/doctor.json`、`GET /digital-life/export.dshlife`、`POST /digital-life/action`（白名单动作：`create` / `import` / `import-archive` / `rescan` / `say` / `feed` / `pat` / `proactive` / `channels-refresh` / `export`）。**不开入站端口。**

## 搬家

`.dshlife` 是一个真 zip，可以随便用归档工具打开检查：

```
manifest.json             schemaVersion / soulId / rev / lastHost
portrait/**               人设全量
memory/events.jsonl       事实记录，一行一条
memory/fingerprint.json   exchangeVersion / schemaVersion / embeddingModelId / facts
```

**不含** `credentials/`、`runtime/`、`soul.db`、任何索引。导入时索引重建，凭据需要在新设备重新配。导入不覆盖已有档案；不认识 `schemaVersion` 的包会被拒绝，且目标目录一个字节都不写。

## 喂饭需要的凭据

喂饭只看充值累计额，需要一把能查余额的 key：

```jsonc
// credentials/deepseek.json  （永不导出）
{ "apiKey": "sk-..." }
```

没有它时喂饭返回 `unavailable`，不会静默失败；面板会提示缺 key。也可以用环境变量 `DEEPSEEK_API_KEY`。

## 接 QQ（OneBot 11）

1. 起一个协议端（NapCat / Lagrange），开 HTTP API，记下地址（例如 `http://127.0.0.1:3000`）
2. 填 `portrait/channels/qq.json`：

```jsonc
{
  "enabled": true,
  "baseUrl": "http://127.0.0.1:3000",
  "ownerId": "你的QQ号",      // 只有这个号的话会被回答
  "selfId": "她的QQ号",       // 用来判断群里有没有点名
  "allowGroups": false,        // 群聊默认不答
  "requireMention": true
}
```

3. 如果协议端要 token，放 `credentials/onebot.json`：`{ "token": "..." }`
4. 让协议端把事件上报到 `http://127.0.0.1:19387/digital-life/qq/event`（`message` 类事件即可）

**不开入站端口**：这条路由挂在 DSH 已有的回环服务器上，不是新监听。配了 token 时，上报要带 `Authorization: Bearer <token>`。

群聊即使开了 `allowGroups`，也只在被 @ 时才说话——一个 7 岁人设在群里主动开腔是 §4.10 明确要避免的事。

## 开发

```powershell
node test/run.mjs          # 13 套离线测试，不需要 DSH
node test/run.mjs --live   # 追加 HTTP/SSE/实例锁，需要一个正在跑的宿主
```

Host 半不能热重载，所以「改了代码要验证」只能起新进程。别为此重启你正在用的 DSH：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/probe.ps1
```

它在 `%TEMP%` 建一次性 `DSH_HOME`、从内置 `web` 模板生成 profile、link 插件、起宿主、
创建她、跑完整测试再拆掉；退出码就是结果。`-Keep -SkipTests` 留着手动点，
`-Stop` 收尾（并顺手清掉残留端口）。一次性宿主没有 DeepSeek 登录，真模型那一轮仍需在
你自己实例上验。

设计文档在仓库根目录：`ARCHITECTURE.md`（实现依据）、`DECISIONS.md`（决策记录）、
`HANDOFF.md`（原始需求快照）、`INCIDENT.md`（2026-11-08 会话中断复盘）。

## 零依赖

只用 `node:` 内建。不是洁癖：包以链接方式进 profile，Node 按真实路径解析 bare import，profile 里的依赖一个都看不见。要引入依赖就得把包复制进去，那样会丢掉「改代码即生效」的开发循环。
