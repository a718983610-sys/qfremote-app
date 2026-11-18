# A 线报告：QFLockUI 挂起分析＋Windows 会话与显示适配验证

- 缺陷：LOCK-P0-01（QFLockUI 开锁后无响应）、LOCK-P0-05（真实熄屏能力及保护边界未验证，部分）、LOCK-P0-04（锁异常退出后远程输入通道失效，诊断部分）
- 日期：2026-11-19 03:xx CST
- 分支：`a16s2-lockfix-a`，基线 `049d876`（本线未改基线外任何树）
- 依据：任务书 `lockfix-phase1/task-briefs/brief-a.md`；定夺 `gpt-a16s2-lockbug-ruling-20261119.md` §2、§2.4、§5.1–5.2；阶段 1 报告 `lockfix-phase1/REPORT.md`
- 数字口径：**实跑**＝本轮实际执行并有输出为证；**转述**＝引用他人已记录结果，未经本轮复核；
  **源码实读**＝读了本轮指明的源码/脚本原文。转述数字一律标注，不得混充实跑。

## 结论先行

| 项 | 结论 |
|---|---|
| 根因判定 | **未确认（UNCONFIRMED）**——没有有效挂起 Dump，按定夺 §2.1 判定要求，5 条假设均不得升级为“确认根因”。见 §4。 |
| 最关键的分叉问题 | 事故机 D39ABOL 上装的到底是哪个版本？README 称 v2.0.2 已根治“上锁瞬间未响应”，而事故症状与 v2.0.1 及以前的旧毛病一字不差。若事故机跑的是 ≤2.0.1，事故可能只是旧版未升级；若跑的是 v2.0.3，则 v2.0.2 的根治不成立。二进制本身无版本资源、无 `2.0.3` 字面量，**只能以取证包里的 `device.json:componentVersion` 与 `status.json:version` 裁决**。在此之前，H1/H2 的初筛只能给“有条件”结论。 |
| 启动链与 IPC | **已定位（PASS，实跑+源码实读）**：4 个二进制 SHA 与 v2.0.3 发行包逐字节一致；完整启动链 8 跳已画出（§1），每跳的 SessionId/SID/Desktop 均有源码依据，D39ABOL 实测值待取证包（BLOCKED）。 |
| 5 条假设初筛 | **已完成（PASS）**：逐条见 §2。H1（IPC 阻塞）在 v2.0.2 设计上被堵死、但残留同步 Win32 面仍不能排除；H2（窗口/焦点/输入拦截）是目前最说得通的残留面；H3 需驱动事件；H4 作为挂起根因已被“黑屏曾可见”削弱、但仍需实测值；H5 弱。 |
| 受控复现方案 | **已交付（PASS）**：`repro/procdump-repro.ps1`（准备+监控+采集+停止条件）、`repro/collect-hang-evidence.ps1`、`repro/windbg-triage.md`（五分法判读）。腾讯 CVM 明确不得冒充最终显示验收设备。 |
| D39ABOL 取证包分析 | **BLOCKED**——笔记本桥连不上（阶段 1 报告 §3，两次开会话均失败，实跑）。本线未碰笔记本、未开桥会话、未用浏览器。证据到手后按 §5 的判定表执行。 |
| 会话/显示矩阵 | **已交付（PASS）**：`matrix/session-display-matrix.md`（8 种会话组合 + D39ABOL 适配要点 + 显示兼容必测组合），供 B 线用；其中 D39ABOL 硬件行是转述，须取证核实。 |
| 协议契约 | **已交付（PASS）**：`contract/ipc-session-evidence-contract.md`（管道/信封/状态文件/会话证据格式）。 |
| 自动化检查 | **53/53 PASS（实跑）**：`tests/session-ipc-checks.py`（SHA 清单、IPC 字段与超时常量、启动链关键行、阶段 1 锁记录复核）。 |

---

## §1 旧组件定位与完整启动链（PASS）

### 1.1 组件清单（实跑，SHA 见 `evidence/component-inventory.md`）

| 组件 | 大小 | SHA-256（前 16 位） | 身份 |
|---|---|---|---|
| `windows/privacy-lock/app/QFLockService.exe` | 7,898,112 B | `eae8784c58e2cdae…` | 服务宿主（Session 0，LocalSystem） |
| `windows/privacy-lock/app/QFLockUI.exe` | 3,702,784 B | `712a6d89f6ca2a939…` | 会话 UI（交互会话） |
| `windows/privacy-lock/app/qf-lockctl.exe` | 7,896,064 B | `cdc797a2ec0fcb50…` | 命令桥（生产只用 apply/status） |
| `windows/privacy-lock/app/qf-lockupdater.exe` | 3,017,728 B | `2fc4bb6d41f18a0c…` | 独立更新进程 |

- 4 个二进制与 `privacy-lock-impl/dist/pkg/app/` 逐字节一致（实跑），与
  `QFLock-Component-v2.0.3.zip`（SHA `f27c45061c6c0b86f6587f45ee953ecdeee20b299a234860036b62ae19d035be`，
  9,419,201 B，与 `dist/release-info.json` 一致，实跑）内文件一致。
- 4 个二进制均含 `go1.27.1`（实跑），`go.mod` 亦为 `go 1.27.1`；PE32+ x86-64，
  Subsystem 3，无 VS_VERSIONINFO（实跑，pefile）；导入表只有 `kernel32.dll`，
  其余 Win32 调用全经 `x/sys/windows` 懒加载——**静态导入表看不到会话/窗口调用**，
  须以源码 + Dump 栈为准。
- 源码 `privacy-lock-impl/src`（只读诊断，未改）：函数符号与二进制符号逐项对得上
  （`main.launchUIInSession`、`main.sessionID`、`display.(*FSM).*`、
  `ipcclient.(*Client).*`、`pipewin.*`），可作诊断依据。
- **版本身份缺口**：二进制内无 `2.0.3` 字面量、无版本资源；wt-a 的 `install.ps1`
  比发行包的 `install.ps1` 新（含 2026-11-11 缺陷③修复），但安装脚本版本 ≠ 二进制版本。
  D39ABOL 的实际版本以取证包 `device.json:componentVersion` / `status.json:version` 为准。

### 1.2 完整启动链（源码实读；D39ABOL 每跳实测值待取证，见 1.3 表）

```
[1] 控制台面板（Electron lock.html / lock-preload.js）
      │ main.js:5077 qf-lock-enable → lockBridge.enable(id, password)
      │   windows/lock.js: POST https://app.qfremote.top/lock/enable {id, password}
      ▼
[2] 服务端 friends lock-bridge.js  POST /lock/enable（942 行）
      │ 读 status.json（runcommands + Base64，20 秒超时）→ 验机主/别名 → 验公钥 pin
      │ → envelope.buildEnvelope(dispatcherKey, {op:'arm', nodeId, by, password})
      │ → deliverEnvelope：runcommands 写 inbox\<env.id>.json → 跑 qf-lockctl apply
      │ → reconcile：30 秒内轮询 status.json，须见 state=Locked + 审计 arm 事件（同一 armId）
      ▼  事故 arm 成功：2026-11-18T17:11:58.053Z（实跑复核，298 行锁记录）
[3] 设备 inbox  C:\ProgramData\QFRemote\Lock\inbox\<env.id>.json
      │ QFLockSvc 2 秒轮询 processInbox()，或 qf-lockctl apply 经管道发 {t:"apply"} 触发
      ▼
[4] QFLockSvc（Session 0，LocalSystem，服务名 QFLockSvc）
      │ core.Engine.ProcessEnvelope → 验 Ed25519 签名 → Engine.Arm()
      │   Arm 持 Engine.mu 做 Argon2 哈希（约 0.3–0.7 秒）→ state=Locked 落 state.dat
      │   → OnChange 回调写 status.json → watchdog（2 秒 tick）见 Locked
      ▼
[5] QFLockSvc watchdog → launchUIInSession(sid, "...\QFLockUI.exe")
      │ 对每个 WTSActive 且 ≠0 的会话：
      │   WTSQueryUserToken(sessionID) 取该会话用户 token
      │   → CreateProcessAsUser(token, ..., si.Desktop="winsta0\default")
      │   → QFLockUI 以会话用户身份在 WinSta0\Default 启动
      ▼
[6] QFLockUI（交互会话，SessionId=目标会话，SID=会话用户）
      │ init() LockOSThread 钉死 UI 线程 → 建隐藏黑窗（每屏一个，WS_POPUP，不带 WS_VISIBLE）
      │ → PostMessage WM_APP_INIT → 消息循环 GetMessage/DispatchMessage
      │ → runInitStep 分步：逐窗 SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE=0x11)
      │   → 装低级钩子 WH_KEYBOARD_LL(13)/WH_MOUSE_LL(14)（只观察，CallNextHookEx 放行）
      │   → 全部就绪才 ShowWindow → SetForegroundWindow → helloLoop（工作协程）
      │   → 定时器：status 轮询 1500 ms、topmost 维持 500 ms、暗屏 Tick 60 秒
      ▼
[7] IPC：QFLockUI ↔ QFLockSvc（命名管道，见 §1.4）
      │ hello（Session/Pid/Affinity 回报）→ 服务记 helloSeen + captureExclusion 进 status.json
      │ status 轮询 → 服务回 {state}；state 变 Off 即退出
      │ unlock/recover → 服务 Engine.HandleIPC → Argon2 校验 / 服务器验密
      ▼
[8] 本地呈现：暗屏（全黑、密码框收起）⇄ 物理输入唤醒（露出密码框）⇄ 60 秒无物理输入再暗屏
      远程注入输入（SendInput 合成，LLKHF_INJECTED 0x10 / LLMHF_INJECTED 0x01）不唤醒、不续命。
```

### 1.3 逐跳 SessionId / SID / Desktop（源码依据 vs 实测）

| 跳 | 进程 | SessionId | SID/身份 | Window Station / Desktop | 依据 |
|---|---|---|---|---|---|
| [2] | friends 服务 | —（东京服务器） | 服务账号 `qf-locksvc`（siteadmin=0 最小权限） | — | lock-bridge.js 实读 |
| [3] | runcommands 投递 | — | SYSTEM（`runAsUser: 0`） | — | lock-bridge.js:604 实读 |
| [4] | QFLockSvc | **0** | LocalSystem | 无交互桌面（服务会话） | main_windows.go：`svc.Run("QFLockSvc")`；install.ps1 实读 |
| [5] | launchUIInSession | 目标会话（WTSActive，≠0） | `WTSQueryUserToken(sessionID)` 取到的会话用户 token | `winsta0\default`（源码写死） | main_windows.go 实读 |
| [6] | QFLockUI | 目标会话（`ProcessIdToSessionId` 自报，hello 里带 `session`） | 会话用户（CreateProcessAsUser 的 token 用户） | WinSta0\Default（继承 si.Desktop） | main_windows.go 实读 |
| [7] | 管道对端 | 跨会话：服务 Session 0 ↔ UI 交互会话 | 管道 SDDL 允许 IU（交互登录用户）读写 | — | pipeSDDL 实读 |
| [8] | 锁窗口 | 同 [6] | 同 [6] | 每屏一个 `QFLockUIClass` 全屏置顶窗口（`WS_POPUP\|WS_EX_TOPMOST\|WS_EX_TOOLWINDOW`） | main_windows.go 实读 |

**D39ABOL 实测值：全部 BLOCKED**（进程 SessionId、父进程 PID、命令行、SID、输入桌面、窗口树，
须取证包：`hang-process/cim` + `qwinsta` + `whoami /user` + EnumWindows，见契约 §4）。

### 1.4 IPC 形态（源码实读 + 二进制核对）

- 管道：`\\.\pipe\QFLockSvc`，字节流，双工；服务端 `CreateNamedPipe`（255 实例，
  64 KiB 缓冲），SDDL `D:(A;;GA;;;SY)(A;;GA;;;BA)(A;;GRGW;;;IU)`。
- 帧：每行一条 JSON + `\n`；服务端每连接一个 goroutine，`bufio.Scanner`（上限 1 MiB）串行处理。
- 请求 5 类：`hello | status | apply | unlock | recover`；响应字段
  `ok/code/state/fault/failCount/waitSec/remaining/reboot`（`core/ipc.go` 实读）。
- 客户端（UI）：`internal/ipcclient`（2.0.2 新建）——**单飞 + 硬超时 + 自动复位**：
  UI 线程只做一次原子 CAS 抢占（抢不到丢弃，永不等待锁/I/O）；I/O 全在工作协程，
  串行于 `ioMu`；超时（status/unlock 10 秒、recover 30 秒、hello 6 秒、拨号 3 秒）
  后 `resetConn` 关连接打断阻塞读，**且 `resetConn` 不抢 `ioMu`**（否则超时本身死锁，
  有测试 `TestCallAsyncNeverBlocksOnStuckTransport` 守护，源码实读）。
- 服务端处理：`HandleIPC` 在连接 goroutine 内串行；`unlock` 的 Argon2 校验在
  `Engine.mu` 锁内完成（约 0.3–0.7 秒），`recover` 的服务器验密（最长约 17 秒）
  不持锁；同一连接上的后续请求会被串行挡住，UI 侧靠单飞丢弃消化。
- **桥侧超时表现**：服务端 `/lock/enable|disable` 发出信封后 30 秒对账
  （`RECONCILE_MS=30000`，lock-bridge.js:46 实读），超时回 504；读 `status.json`
  的 runcommands 单次超时 20 秒。事故当晚 01:20–01:27 两次关锁失败在服务端
  无成功记录（阶段 1 报告 §2，实跑复核：298 行记录中 disarm 成功仅 1 条，
  为 2026-11-15T16:46:11.980Z；11-18 17:22–17:25 的 4 条别名命中是面板轮询的
  读路径，不是关锁成功）。

---

## §2 五条假设逐条初筛（PASS，源码+事故现象对照；均未升级为确认）

> 初筛方法：以 v2.0.3 源码（与事故机二进制逐字节一致的发行包对应的源码）为准，
> 对照事故现象逐条判“支持/反对/无法判断”。**源码只能证“设计上堵没堵死”，
> 不能证“事故当时跑没跑这段代码”**——版本分叉（§4）未解之前，初筛结论都是有条件的。

### H1 IPC 阻塞 / 死锁（定夺排序第 1）——**有条件反对（设计上），无法判断（事故当时）**

- 支持点：症状（开锁后输入停顿、黑→灰屏、远程点按无反应）与“UI 线程同步等待后停泵消息”相符；
  旧版（≤2.0.1）确有此毛病：`asyncRequest` 在 UI 线程抢 `pipeMu`，工作协程持同一把锁做
  最长 3 秒拨号 + 无期限阻塞读，1.5 秒一次的状态轮询撞上在途请求即堵死窗口过程
  （main_windows.go 文件头自述，源码实读）。
- 反对点（v2.0.2 已改）：现行 `ipcclient` 把 UI 线程的等待全部拿掉（CAS 抢占、I/O 在工作协程、
  硬超时 + `resetConn` 不抢 `ioMu`）；`pendingMu` 只保护指针交换、不跨 I/O；
  `helloLoop` 在工作协程；`GetMessage` 循环本身不碰管道。按现行代码，IPC 不可能直接堵 UI 线程。
- 残留口子：① 服务端 `Engine.mu` 在 `Arm`/`UnlockAttempt` 全程持有（含 Argon2），
  若 Arm 与 UI 的 hello/status 在同一时刻到达，服务侧会排队——但 UI 侧是异步的，
  至多丢几个轮询，不会挂 UI；② `handlePipeConn` 每连接串行，若 `recover` 验密
  （最长约 17 秒）占住 UI 的唯一连接，后续 status 全被串行挡住——同样只丢轮询，
  不挂 UI；③ `roundTrip` 的 `ReadBytes('\n')` 依赖 `resetConn` 关连接打断，
  若关闭路径本身失效（例如句柄已坏），工作协程会泄漏——但仍不碰 UI 线程。
- **还缺什么**：挂起 Dump 里 UI 线程栈（有无 `ipcclient.roundTrip`/`pipewin.Read` 帧）、
  对端 QFLockSvc Dump（`handlePipeConn`/`HandleIPC` 是否卡在同一请求）、
  `svc.log`/`audit.log` 里 hello 是否到达（`helloSeen` 真值）。
- 初筛结论：**若事故机是 v2.0.3，H1 作为“UI 挂起的直接原因”不成立**（设计已堵死）；
  **若事故机是 ≤2.0.1，H1 就是最可能的根因**（旧毛病原样复现）。版本裁决见 §4。

### H2 全屏锁窗口 / 焦点 / 输入拦截缺陷（排序第 2）——**支持为残留首要嫌疑（v2.0.3 下）**

- 支持点：① 分步初始化的最后一步是同步 Win32 调用链：
  `SetWindowDisplayAffinity`（逐窗）→ `ShowWindow` → `SetForegroundWindow` →
  `SetFocus`，全在 UI 线程的 `wndProc`（WM_APP_INIT）里执行；任一步在个别系统上
  卡住超过 5 秒，Windows 即判该线程的窗口“未响应”——v2.0.2 的注释称“慢的只是
  隐藏窗口的初始化，没有可见窗口在等消息”，但**窗口一旦在某一步之间已被显示，
  后续步骤的卡顿就是可见窗口的卡顿**；② `tickTopmost` 每 500 ms 对全部窗口调
  `SetWindowPos(HWND_TOPMOST)`，`timerPoll` 每 1500 ms 投 status——都是 UI 线程
  的同步调用；③ `buildWindows` 的 `EnumDisplayMonitors` 回调与 17 个控件的
  `CreateWindowEx` + `SendMessage(WM_SETFONT)` 全挤在消息循环启动之前（建窗期），
  任一步慢都会推迟首次 `GetMessage`，只是当时窗口尚未显示、挂起对话框无从谈起；
  ④ 低级钩子回调（`kbHookCb`/`msHookCb`）跑在 UI 线程：钩子只观察、调
  `CallNextHookEx` 放行，但**回调本身在 UI 线程执行——UI 线程若已卡住，钩子
  回调排队，系统级低级钩子链会被拖慢**（见 H2 与 LOCK-P0-04 的关联，§2.6）。
- 反对点：`SetWindowDisplayAffinity`/`SetWindowPos`/`ShowWindow` 正常情况下都是
  毫秒级返回；`installHooks` 失败有降级（`PinAwake`，控件常显）；`subclassEnter`
  的 EDIT 子类化失败时回落 `DefWindowProc`，不挂起。
- **还缺什么**：挂起 Dump 的 UI 线程栈（是否停在 `runInitStep`/`tickTopmost`/
  `SetWindowDisplayAffinity`/`SetWindowPos` 内）、窗口树（`QFLockUIClass` 句柄、
  可见性、Z-order）、Application 事件 1002（挂起）与 1000/1001。
- 初筛结论：**v2.0.3 下最说得通的残留面**；但同样须 Dump 才能定论。

### H3 显示 / GPU / 绘制冲突（排序第 3）——**无法判断**

- 支持点：黑→灰屏切换涉及窗口合成；`SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)`
  是按屏逐个设置的 DWM 行为，与捕获路径（QFRemote 远控抓屏）同处显示栈；
  若某屏的 affinity 调用在驱动/DWM 侧卡住，症状与 H2 无法从现象上区分。
- 反对点：灰屏更可能是 Windows 给无响应窗口画的“幽灵窗”（ghost window），
  不是 GPU 故障的特有表现；远程画面时钟仍在走（定夺 §5.1），说明捕获通道本身未死。
- **还缺什么**：System 日志 Display/nvlddmkm/amdkmdap/igfx/WHEA/Kernel-Power 事件
  （01:00–01:40 窗口）、Dump 栈顶是否在 `dwmapi/gdi32/d3d11/dxgi/win32u!NtGdi*`、
  D39ABOL 的 GPU/驱动型号（取证包 `dxdiag` 或设备管理器清单）。
- 初筛结论：**无法判断**；单有灰屏不得记为 H3 证据。

### H4 Session / SID / Desktop 错配（排序第 4）——**作为挂起根因：反对（弱）；作为待核项：仍须实测**

- 支持点（理论上）：LEA 在 Session 0，锁 UI 必须在交互会话；`launchUIInSession`
  依赖 `WTSQueryUserToken` + `CreateProcessAsUser` + 写死的 `winsta0\default`，
  任一环节错（会话非活动、token 失效、桌面不是 Default）都会导致 UI 不可见或错会话。
- 反对点（现象上）：**用户亲眼见到了黑屏→灰屏**，说明 QFLockUI 的窗口确实建在了
  当前可见的交互桌面上——会话/桌面大体是对的；若完全错配，应是“什么都没出现”，
  而不是“出现了然后卡死”。管道 SDDL 允许 IU 读写，hello 能否到达是另一回事，
  与挂起无直接因果。
- **还缺什么**：QFLockUI 实测 SessionId、ParentProcessId（应为 QFLockSvc PID）、
  命令行、运行用户 SID、当前输入桌面（`GetInputDesktop`）、`qwinsta` 全表。
  缺这些，H4 只能写“现象上削弱、数值上未核”。
- 初筛结论：**不是挂起的首要解释**，但启动链的逐跳实测值仍是必补证据。

### H5 竞态 / 状态文件损坏 / 资源泄漏 / 版本兼容（排序第 5）——**弱；与 LOCK-P0-03 相关，不解释挂起**

- 支持点：`state.dat` 损坏会进 `Fault` 态；`watchdog` 在 UI 被杀后 2 秒内重拉
  （`helloSeen` 为真时无退避），重拉—再挂—再杀可刷 `FailCount`（满 5 次触发重启）；
  `status.json` 是 tmp+rename 原子写，写坏只会读到旧快照，不会挂 UI。
- 反对点：`Fault` 态时 watchdog 根本不拉 UI（只在 `Locked` 时拉）——UI 出现了，
  说明当时状态是 `Locked` 不是 `Fault`；`Arm`/`UnlockAttempt` 持 `Engine.mu`
  做 Argon2 是毫秒级，不构成 UI 挂起；资源泄漏须多次开锁才显形，事故是首次开锁。
- **还缺什么**：`state.dat`/`status.json` 的 SHA 与内容、`audit.log` 的
  `ui-killed`/`ui-launch-failed`/`tamper-*` 序列、`svc.log`。
- 初筛结论：**不解释本次挂起**；但它是 LOCK-P0-03（服务端/设备端失真）的候选，
  归 C 线对账时复用本节证据清单。

### 2.6 附：LOCK-P0-04（远程点按失效）的诊断分流

- 定夺 §5.1 已定性为连带故障、须分开核查。本线补充源码级分流：
  ① QFLockUI 的低级钩子**不拦截**（只观察 + `CallNextHookEx` 放行），所以“UI 活着时
  远程点按失效”不能直接归罪于钩子拦截；② 但钩子回调跑在 UI 线程——**UI 线程
  挂起时，钩子回调排队，系统低级钩子链会被拖慢，注入输入（SendInput）同样走
  LL 钩子链**，这是 H1/H2 → LOCK-P0-04 的一条可信传导链（须 Dump + 输入日志证实）；
  ③ **UI 被杀后点按仍失效、断开重连后恢复**，这一点 UI 解释不了（钩子随进程消失），
  指向 USH/输入执行组件的残留状态或会话路由问题——归 B 线输入隔离修复时实测，
  本线只记分流，不下结论。
- 另记一处**待核异常**：按源码，UI 被系统弹窗“关闭程序”杀掉后，watchdog 应在
  2 秒内重拉 QFLockUI（`helloSeen` 为真时无退避，只记 `ui-killed` 一次 Tamper）；
  但事故叙述是桌面恢复约 35 秒、断开重连后点按恢复，未提 UI 被重拉后再次黑屏。
  可能的解释有三：(a) 重拉失败（须 `audit.log` 的 `ui-launch-failed` 证实）；
  (b) 重拉的新 UI 未再挂起（非确定性竞态）；(c) 叙述省略了重拉过程。
  **以 `audit.log`/`svc.log` 的 `ui-killed` 后续序列为准，不得猜**。

---

## §3 受控复现环境方案（PASS）

- 程序文件：`repro/procdump-repro.ps1`（准备 → 监控 → 开锁 → 同步采集 → 收尾 → 停止条件）、
  `repro/collect-hang-evidence.ps1`（挂起时一键只读快照）、`repro/windbg-triage.md`（五分法判读步骤）。
- 环境门：① 独立 Windows 测试机（不是站长笔记本、不是生产机），本地控制台有人登录的
  交互会话（WTSActive，WinSta0\Default 可见）；② 已装锁组件，先抄
  `device.json:componentVersion` 与 `status.json:version`（版本不一致时结论只对该版本有效）；
  ③ 第二条救援通道已验证“杀掉 QFLockUI 后桌面能恢复”；④ ProcDump 取自微软官方
  Sysinternals，版本与 SHA-256 在运行时实测填表；⑤ 协调人已知时间窗口。
- **腾讯 CVM 明确排除在最终显示验收之外**：只有终端、无合格交互用户会话，
  OrcaTerm 本身在会话 0，V6 已实证从 OrcaTerm 跑确定性失败；CVM 至多做不碰显示的
  服务端/管道协议检查，不得冒充显示验收设备。VM（Hyper-V 增强会话/GPU 直通）可作
  功能复现，但显示/GPU 结论（H3）仍须物理机（同类硬件）复核。
- ProcDump：`.\procdump64.exe -accepteula -ma -h -w QFLockUI.exe C:\QF-Lock-Dumps`
  （-ma 完整转储；-h 窗口无响应即转储；-w 等待进程出现）。先挂 ProcDump 再开锁，
  顺序不可反。Dump 目录限权 SYSTEM+Administrators，预留 ≥1 GB。
- 挂起时同步采集（关闭 QFLockUI 之前）：QFLockUI Dump + 同一时刻 QFLockSvc Dump、
  线程等待链、窗口树、会话 ID、IPC 请求与响应时间、远程输入日志、事件日志、
  `status.json`/`svc.log`/`audit.log` 原样复制、CrashDumps/WER、`powercfg /requests`。
  采集清单与停止条件全文见 `repro/procdump-repro.ps1` §4–§6。
- 停止条件（任一即停）：设备不可恢复；救援通道失效；须越权绕过会话安全机制；
  同一轮内 watchdog 重拉后第二次挂起（防 FailCount 刷到 5 次触发重启）；
  ProcDump 连续两次未触发（改手动 `-ma` 快照，不许为等触发反复开锁）。
  停止后先恢复桌面与远控，再写报告。站长笔记本的复现只在阶段 4、且有同款救援通道时才批。

---

## §4 根因结论：未确认 + 证据不足清单（BLOCKED 待取证包）

- **根因结论：未确认。**没有有效挂起 Dump，按定夺 §2.1 判定要求，5 条假设均不得升级为“确认根因”。
- **版本分叉是第一待解问题**（见结论先行）：取证包到手后第一件事就是读
  `device.json:componentVersion` 与 `status.json:version`。
  - 若 ≤2.0.1：H1（旧 pipeMu 死锁）即为最可能根因，复现应在同版本上做，B 线重写仍须覆盖该路径。
  - 若 =2.0.3：H1 作为直接原因基本排除，主攻 H2（分步初始化/同步 Win32 调用）+ H3（驱动/DWM），
    并须解释“v2.0.2 根治为何未生效”（是根治有漏，还是事故走了另一条路）。
- **证据不足清单（取证包到手后逐项勾销）**：

| # | 缺的证据 | 用来裁决 | 来源 |
|---|---|---|---|
| E1 | D39ABOL `device.json` + `status.json`（内容 + SHA-256） | 版本分叉、状态机现值、captureExclusion | 取证脚本 `SUMMARY.csv` |
| E2 | 01:00–01:40 Application 事件 1000/1001/1002 | 挂起事件、进程名、PID、Report ID | 取证脚本 |
| E3 | 同窗口 System Display 驱动事件 | H3 命中/排除 | 取证脚本 |
| E4 | `%LOCALAPPDATA%\CrashDumps` + WER ReportArchive（01:00–01:40） | 已有转储？无则走受控复现 | 取证脚本 |
| E5 | QFLockUI/QFLockSvc 进程信息（SessionId/父 PID/命令行/SID/Responding） | H4 实测值、启动链逐跳核对 | 取证脚本 |
| E6 | `C:\ProgramData\QFR` 清单 + `svc.log` + `audit.log`（全文） | hello 是否到达、ui-killed/重拉序列、FailCount | 取证脚本 §2.3/§4.3 扩展 |
| E7 | 受控复现的 QFLockUI 完整 Dump（ProcDump `-ma -h`）+ 同一时刻 QFLockSvc Dump | 五分法判读（`repro/windbg-triage.md`） | 复现方案 §3 |
| E8 | 挂起期间的窗口树 + 远程输入日志（同一 operation_id 串联） | H2 命中、LOCK-P0-04 分流 | 复现方案 §4 |
| E9 | D39ABOL 硬件实测（OS Build、GPU/驱动、内屏/DPI、电源态） | 矩阵 §2 的转述值核实 | `winver`/注册表/`dxdiag` |

- **证据到手后的判定表**（按 `repro/windbg-triage.md` 五分法执行）：
  命中 (a) 管道/锁等待 + 对端栈一致 → H1 确认；命中 (b) 消息循环内同步调用 → H2 确认；
  命中 (c) 驱动栈 + 驱动事件 → H3 确认；命中 (d) SessionId=0/错会话/错 SID → H4 确认；
  命中 (e) 状态损坏/资源暴涨/Go 死锁 → H5 确认。五项全未命中 → 写“Dump 未解释挂起”，
  列还缺什么，不许硬指一条。其余假设逐条写排除依据。

---

## §5 会话与显示适配验证矩阵（PASS，供 B 线用）

- 文件：`matrix/session-display-matrix.md`。8 种会话组合：唯一合法落点是
  S1（活动控制台会话 + WinSta0\Default + WTSQueryUserToken 用户）；S2（Session 0 建窗）、
  S3（非活动会话）、S5（Winlogon 桌面）、S6（SID 与登记机主不符）、S7（会话切换中）
  必须拒绝；S4（RDP）、S8（多用户并存）有条件允许、须真机实测。
- D39ABOL 硬件行是**转述**（Win11 家庭版 26H2 / 26300，内屏）：D3 证据文件里未找到
  OS Build 实测行，须取证包以 `winver`/注册表实测为准，不得沿用转述值。
- 显示兼容必测：内屏/外屏/多屏、DPI 100/125/150%、插电/电池/合盖、锁屏/注销/RDP 连接-断开；
  熄屏硬门（物理观察发光停止 + 远端持续正常）是定夺 §3 的独立验收项，B 线逐项真机实测后才标 PASS。

---

## §6 验收逐项（PASS / FAIL / BLOCKED）

| 验收项 | 结果 | 依据 |
|---|---|---|
| 旧组件定位（路径 + SHA-256） | **PASS**（实跑） | §1.1；`evidence/component-inventory.md`；自动化检查 4/4 SHA 一致 |
| 完整启动链（逐跳 SessionId/SID/Desktop） | **PASS（源码依据）/ BLOCKED（D39ABOL 实测值）** | §1.2–1.3；D39ABOL 每跳实测值待取证包 |
| IPC 形态（管道名/协议/超时/桥侧表现） | **PASS**（实跑+源码实读） | §1.4；`contract/ipc-session-evidence-contract.md` |
| 5 条假设逐条初筛（支持/反对/无法判断 + 各缺什么证据） | **PASS** | §2；结论均为有条件初筛，未升级为确认 |
| 受控复现环境方案（ProcDump/采集清单/WinDbg/停止条件） | **PASS** | §3；`repro/` 三件；CVM 不得冒充显示验收设备已写明 |
| 根因判定（有效 Dump + IPC/窗口/会话证据） | **BLOCKED**（未确认） | §4；取证包未到手，复现未跑 |
| 会话/显示适配验证矩阵（供 B 线） | **PASS** | §5；`matrix/session-display-matrix.md` |
| 协议契约（IPC/会话/状态证据格式） | **PASS** | `contract/ipc-session-evidence-contract.md` |
| 自动化用例（会话解析/IPC 超时/复现流程检查） | **PASS**（实跑 53/53） | `tests/session-ipc-checks.py`，退出码 0 |
| 故障注入测试方案（挂起检测、Dump 采集） | **PASS**（方案已交付，未执行） | `repro/procdump-repro.ps1` §4–§6；执行待复现环境 |
| 构建 SHA | **PASS**（实跑） | 发行 zip `f27c4506…`；4 个 exe SHA 见 §1.1 |
| 不修补旧 Go 二进制 / 不用 Wine 或静态检查代替真机 | **PASS** | 本线只做诊断；未改任何二进制；未跑 Wine；静态分析只作初筛，结论写明须 Dump |
| 不动生产服务 / 不碰 D39ABOL 状态文件 | **PASS** | 本线未连生产服务、未碰笔记本、未开桥会话、未用浏览器 |

## §7 未确认事项（转交协调人）

1. D39ABOL 取证包未到手（E1–E6，§4 清单）；到手后本线按 §4 判定表做根因判定，须另出一份补记。
2. 版本分叉未解：事故机是 ≤2.0.1 还是 2.0.3，直接决定 H1 是否成立（§2、§4）。
3. watchdog 重拉异常未解：UI 被杀后是否 2 秒内重拉、有无再次挂起，以 `audit.log` 为准（§2.6）。
4. LOCK-P0-04 的 UI 解释只覆盖“UI 活着时”，UI 死后仍失效的部分归 B 线输入隔离实测。
5. D39ABOL 硬件（OS Build/GPU/驱动）为转述，矩阵 §2 的值须取证核实后才能作 B 线验收依据。
6. 本线未撞见疑似提示词注入（`injection-samples/` 无需建档）；如后续轮次撞见，按铁律先存原文再拒绝。

## 交卷物清单

- 本报告：`REPORT.md`
- 组件清单：`evidence/component-inventory.md`
- 复现程序：`repro/procdump-repro.ps1`、`repro/collect-hang-evidence.ps1`、`repro/windbg-triage.md`
- 矩阵：`matrix/session-display-matrix.md`
- 契约：`contract/ipc-session-evidence-contract.md`
- 自动化检查：`tests/session-ipc-checks.py`（实跑 53/53 PASS，退出码 0）
