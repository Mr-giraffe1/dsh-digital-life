# 2026-11-08 会话中断：复盘与修复

> 上一个会话在 19:30 左右中途断掉，工作停在「代码全绿、等一次重启做实机复验」这一步。
> 本文记录：断点在哪、为什么断、修了什么、怎么防止再犯。
> 结论先行：**代码没有坏，是工作区被一份 355 MB 的 vendor 解包污染，把上下文撑爆了。**

---

## 1. 断点

最后一次落盘的时间线（文件 mtime 是硬证据）：

| 时间 | 事件 |
| --- | --- |
| 19:29:52 | `lib/persona.js` 写完 |
| 19:30:10 | `test/turn.test.mjs` 写完 |
| 19:30:16 | `test/memory.test.mjs` 写完 |
| 19:30:23 | `test/run.mjs` 写完（把新套件挂进 runner） |
| 19:30:26 | 探针实例 `.scratch/host-test/home` 的 `instance.lock` 心跳停止 |
| 19:30:26 之后 | 工作区再无任何写入 |

也就是说：**代码写完、测试刚挂好、正在跑实机验证的那一刻，会话没了。**
后来补齐的 `doctor.json`、`archive.js`、`exchange.js` 测试都还在，说明断点不在写代码，而在跑起来验证的那一步。

## 2. 证据

**(a) 工作区里躺着一份 355 MB、12,967 个文件的 asar 解包。**

`F:\dsh-digital-life\.scratch\asar\` 是从 DSH 的 `app.asar` 解出来的 vendor 源码树
（`node_modules/**`，含 ffmpeg、libreoffice、sharp、sherpa-onnx 等二进制与全部客户端包）。
它被 `.gitignore` 挡在版本控制外，但**本会话的文件工具不看 `.gitignore`**：任何
`glob` / `grep` / 全工作区搜索都会扫过这 1.3 万个文件，命中结果还会被写进临时 spill 文件。

**(b) 断点前后的两次 turn 记了荒谬的 token 数。**

`C:\Users\70465\.dsh\.dshw-usage.json`（19:31 还有一个 `.before-recharge-fix.bak`，
说明这个记账文件后来被记账插件改写过，数值不能全信，但量级与时间点可用）：

| 时间 | tokens |
| --- | --- |
| 19:29:57 | 1,172,309 |
| **19:30:30** | **23,911,918** |

任何一次真实请求都不可能带 2390 万 token（上下文上限远小于此）。这个数字只能来自
**同一条上下文被反复重发**：工具结果 → 塞进上下文 → 再发 → 再塞。

**(c) 探针实例是「前台子进程」。**

`.scratch/host-test/home/digital-life/runtime/instance.lock` 里记着 `pid 13548`，
心跳正好停在 19:30:26。上一个会话为了验证 Host 半（不能热重载），起了一个带独立
`DSH_HOME` 的 DSH 实例；这类进程挂在会话的进程树上，会话一断，它跟着断，留下的锁文件
又让下一次启动被判「已被占用」。

## 3. 根因

一句话：**把 vendor 源码树解进了工作区**，于是

```
全工作区搜索 355 MB vendor 树
  → 结果灌进上下文
  → 上下文变大，下一轮再搜一次
  → 单轮 token 线性爆炸
  → 宿主在某一轮判定请求过大/超时，turn 中止
  → 会话结束，探针子进程成了孤儿，锁文件残留
```

这不是代码缺陷，是**工作区卫生问题**。`ARCHITECTURE.md §6` 早就写了「配置里不写绝对
路径」「把派生数据当权威是经典翻车点」，同一条道理在这里换了个面貌：**把可再生的
vendor 产物当工作区内容，也是把噪声当权威。**

## 4. 修了什么

| # | 修复 | 落点 |
| --- | --- | --- |
| 1 | 删掉工作区里的 355 MB asar 解包（`app.asar` 还在安装目录，随时可解） | 本工作区 |
| 2 | 解包脚本默认写到 `%TEMP%\dsh-asar`，并**拒绝**写进仓库 | `.scratch/extract-asar.py` |
| 3 | 新增隔离探针脚本：临时 `DSH_HOME` + 独立端口 + 自动创建她 + 跑 `--live` + 收尾 | `scripts/probe.ps1` |
| 4 | 探针脚本处理端口残留：`-Stop` 会扫端口顺手杀残留；启动前端口被占会直接报错并给解法 | `scripts/probe.ps1` |
| 5 | 实机复验跑通：真宿主 + 真 `node:sqlite` + SSE + 实例锁，11 项全过 | `test/http.test.mjs` |

## 5. 顺手修掉的三个真 bug（本轮才发现）

| 问题 | 症状 | 修法 |
| --- | --- | --- |
| `.ps1` 没有 UTF-8 BOM | `powershell -File install.ps1` 按 GBK 读文件，中文字符串把语法打断，报一堆 `Unexpected token` | 两个安装脚本改为 UTF-8 **带 BOM** |
| 用 `Get-Content` 默认编码读 patch 文件 | 工具侧跑的是 Windows PowerShell 5.1，默认按 ANSI(GBK) 解码；patch 里若有中文注释，读进来就是乱码，再写回去就把用户的注释洗坏了 | 读写统一 `-Encoding UTF8` |
| `cordis.patch.yml` 是 `[]` 时直接追加 | 新生成的 profile 的 patch 文件内容就是 `[]`，后面接 `- insert:` 得到非法 YAML，宿主启动即失败（实测报 `end of the stream or a document separator is expected`） | 空列表时**替换占位符**而不是追加 |
| junction 目标比较不看 NT 命名空间 | `Get-Item` 返回 `Global\F:\...`，与普通路径比较永远不等，第二次安装直接抛错 | 比较前剥掉 `\\?\Global\` / `Global\` 等前缀 |

## 6. 怎么复验（不动你正在用的 DSH）

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/probe.ps1
```

它会在 `%TEMP%` 下建一个一次性 `DSH_HOME`，从内置 `web` 模板生成 profile，把插件
link 进去，起宿主，创建她，跑完整测试（含 `--live`），然后拆掉。退出码就是测试结果。
想留着手动点：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/probe.ps1 -Keep -SkipTests
# 之后：$env:DSH_LIFE_URL='http://127.0.0.1:19399'; node test/run.mjs --live
# 收尾：powershell -NoProfile -ExecutionPolicy Bypass -File scripts/probe.ps1 -Stop
```

**一个已知的收尾怪癖**：在「被抓取的控制台」里（比如由别的程序 `| Out-String` 捕获输出时），
脚本可能在**测试已经全绿之后**停在收尾那一步。测试日志是独立的
（`<home>\probe-test.log`，末尾 `ALL SUITES PASSED` 就算过），这时补一条
`scripts/probe.ps1 -Stop` 收尾即可——它会顺带把占着端口的残留进程扫掉。

**局限**：一次性 `DSH_HOME` 没有 DeepSeek 登录，`say` 会返回
`ACCOUNT_SIGN_IN_REQUIRED`。真模型那一轮只能在你自己那个实例上验（重启 DSH 后）。

## 7. 三条留给下一次会话的规矩

1. **不要把 vendor 树解进工作区**。要读宿主源码就解到 `%TEMP%`，只把**结论**写进仓库。
2. **验证 Host 半用 `scripts/probe.ps1`**，不要在前台拉长命子进程；也别忘了它跑完会留下端口占用。
3. **看到单轮 token 数异常上涨就先停下**：多半是某个工具结果把上下文喂胖了，继续跑只会更糟。
