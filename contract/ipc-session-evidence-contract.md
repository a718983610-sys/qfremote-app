# 协议契约：IPC / 会话 / 状态证据格式（供 B、C 线复用）
# 来源：旧组件源码实读（core/ipc.go、status.go、store.go、pipewin、ipcclient、
# lock-bridge.js、lock-envelope.js）。旧契约只作诊断与兼容对照，新契约由 B、C 线定稿。

## 1. 本机 IPC：命名管道（UI/ctl ↔ QFLockSvc）
- 管道名：`\\.\pipe\QFLockSvc`（实测：三二进制 + 服务源码一致）
- 服务端监听：`pipewin.Listen(pipePath, SDDL)`，SDDL =
  `D:(A;;GA;;;SY)(A;;GA;;;BA)(A;;GRGW;;;IU)`（SYSTEM/管理员全权，交互登录用户读写）
- 帧格式：每行一条 JSON + `\n`；服务端用 `bufio.Scanner`（缓冲上限 1 MiB）逐行读，
  逐行回一条 JSON + `\n`。密码只在管道内传输，两端都不许落日志。
- 请求（`core.IPCRequest`）：
  ```json
  {"t":"hello","session":1,"pid":1234,"affinity":"active"}
  {"t":"status"}
  {"t":"apply"}
  {"t":"unlock","password":"<本次密码>"}
  {"t":"recover","username":"<账号>","loginPassword":"<登录密码>","newPassword":"<新密码>"}
  ```
  `t` 取值：`hello | status | apply | unlock | recover`。`hello` 由 UI 在拉起后
  发（最多 20 次、每次 6 秒超时、间隔 500 ms）；`apply` 由服务先处理 inbox 再回状态。
- 响应（`core.IPCResponse`）：
  ```json
  {"ok":true,"code":"ok","state":"Locked","fault":"","failCount":0,"waitSec":0,"remaining":0,"reboot":false}
  ```
  `state` 旧值只有 `Off` / `Locked`；`code` 见 `core` 代码常量
  （`ok` / `bad-password` / `wait` / `no-password-set` / `bad-credentials` /
  `not-owner` / `server-unreachable` / `rebooting` / `envelope-invalid` 等）。
- 超时（旧 UI，实值）：拨号 3 秒；status/unlock 10 秒；recover 30 秒；hello 6 秒。
  单飞：同一时刻至多一条请求在途，忙时新请求直接丢弃（状态轮询可丢，操作不连发）。
  超时后关连接复位，下次请求重新拨号。`resetConn` 不抢 `ioMu`（否则超时本身死锁）。
- 服务端处理：每条管道连接一个 goroutine 串行处理；`unlock` 的 Argon2 校验
  （约 0.3–0.7 秒）与 `recover` 的服务器验密（最长约 17 秒）都在该连接的处理
  循环内完成——UI 侧是异步的，但同一连接上的后续请求会被串行挡住，
  靠单飞丢弃消化。`Engine.mu` 在 `Arm`/`UnlockAttempt` 全程持有（含 Argon2），
  服务端其他连接的 IPC 在此期间同样排队（毫秒级，通常无感；`recover` 验密
  期间不持锁）。

## 2. 服务端 → 设备：签名信封（lock-bridge.js → inbox）
- 投递：`runcommands`（`qf-locksvc` 账号，`runAsUser: 0`）先写
  `C:\ProgramData\QFRemote\Lock\inbox\<env.id>.json`（Base64），再跑
  `"C:\Program Files\QFRemote\Lock\qf-lockctl.exe" apply`；组件另有 2 秒 inbox 轮询兜底。
- 信封：`op:'arm' | 'disarm' | 'reset' | 'update'`，Ed25519 签名，含 `id`（armId）、
  `nodeId`、`by`、`issuedAt`；arm 含一次性密码（用设备公钥加密，pin 失配拒发）。
- 对账：`POST /lock/enable|disable` 发出后 30 秒（`RECONCILE_MS=30000`）内轮询
  `status.json`（`runcommands` + Base64 回传，读超时 20 秒），须见到
  `state` 翻转 + 审计事件（含同一 `armId`/`disarm`）才记成功；否则 504/409。
  事故 arm：`2026-11-18T17:11:58.053Z arm 成功：DESKTOP-D39ABOL by 718983610`（实跑复核）。

## 3. 设备端状态文件（`%ProgramData%\QFRemote\Lock\`，仅 SYSTEM+Administrators 可读）
| 文件 | 内容 | 备注 |
|---|---|---|
| `state.dat` | 持久化状态机（`state` Off/Locked、`pwHash`、`failCount`、`lockoutUntil`、`armId`、`bootMarker`） | DPAPI 保护；损坏 → `Fault()=state-corrupt` |
| `status.json` | 快照（`component`、`version`（= device.json 的 componentVersion）、`state`、`fault`、`failCount`、`armedAt`、`ownerUsername`、`nodeId`、`devicePublicKey`、`captureExclusion`（active/failed-degraded）、`updatedAt`、`lastEvents`（近 10 条审计）） | 原子写（tmp + rename）；控制端经 MeshCentral 文件通道读；30 秒心跳刷新 |
| `audit.log` | 审计事件 `{ts, ev, fields}`（arm/disarm/unlock-ok/unlock-fail/ui-killed/ui-launch-failed/tamper-* 等） | 服务端对账读的就是它归一化后的事件 |
| `svc.log` | 服务宿主级错误（无秘密） | 管道监听失败、setup 失败记这里 |
| `device-key.dat` | 设备密钥（DPAPI 保护） | 信封验签/解密用 |
| `inbox\*.json` | 待处理信封 | 处理完即删；残留即“信封未处理”证据 |

## 4. 会话证据格式（取证/复现时每份必含）
- 进程：`Get-Process QFLockUI | Id, StartTime, SessionId, Responding, Path` +
  `Get-CimInstance Win32_Process | ProcessId, ParentProcessId, ExecutablePath, CommandLine, SessionId`
- 会话：`qwinsta` / `query session` 全表（SessionId、用户名、状态 WTSActive/Disconnected）。
- SID：`whoami /user`（当前用户）+ `Get-Process -IncludeUserName`（UI 进程的运行用户，
  须管理员）；或 `wmic process where name='QFLockUI.exe' get ExecutablePath,SessionId` 辅证。
- 桌面：`Get-Process QFLockUI` 的 SessionId + 当前输入桌面判定
  （`GetInputDesktop` 须代码测，PowerShell 无原生命令——取不到就写“未测”，不许编）。
- 窗口：类名 `QFLockUIClass`、句柄、可见性、Z-order（须 EnumWindows 实测；取不到写缺失）。
- 时间：全部用 UTC+8 标注，Dump/事件/日志三方时间戳对齐到同一挂起时刻。

## 5. 证据充分性门（B/C 线复用）
- “确认根因”：有效挂起 Dump（WinDbg 可读栈）+ 同一时间段 IPC/窗口/会话证据，
  二者指向同一假设（见 `repro/windbg-triage.md` 五分法）。
- “未确认”：缺任一即写未确认，并列“还缺什么”清单，不许降格写“基本确认”。
