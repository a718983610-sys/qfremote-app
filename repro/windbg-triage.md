# WinDbg 判读步骤：QFLockUI 挂起 Dump（LOCK-P0-01）
# 工具：WinDbg Preview（微软商店）或 WinDbg（Windows SDK），符号走微软公共符号服务器。
# 判读对象：一份 ProcDump `-ma -h` 抓的 QFLockUI 完整转储 + 同一时刻的 QFLockSvc 转储。
# 判定铁律：没有有效挂起 Dump 之前，任何假设不得升级为“确认根因”。

## 0. 开 Dump 前的完整性检查
- 文件非 0 字节；`!dumpdebug` / WinDbg 状态栏显示进程名 QFLockUI.exe、时间戳与挂起时刻吻合。
- 符号：`.sympath srv*C:\Symbols*https://msdl.microsoft.com/download/symbols` 后 `.reload /f`。
- Go 符号：二进制无 PDB，Go 函数名靠内嵌符号表——栈上应能看到 `qfremote/qflock/...`
  与 `main.*` 帧；若全是地址无名，先记“符号缺失”，不许猜帧。

## 1. 先看全景（每条都记输出，不跳步）
```
!analyze -v        # 挂起分类：FAULTING_THREAD、挂起时长、关键帧
~* k               # 全部线程栈：先数线程、找 UI 线程（带 user32!GetMessage/DispatchMessage 的那条）
!locks             # 关键段/互斥锁持有情况
!uniqstack         # 去重栈：看有几类等待
```

## 2. 五分法（定夺 §2.4）：按顺序排除，每项写“命中/未命中 + 帧证据”
### (a) 阻塞在管道 / 互斥锁 / 事件等待（H1）
- 命中信号：某线程栈顶是 `pipewin.(*Conn).Read` / `ReadFile` / `NtReadFile`、
  `ipcclient.(*Client).roundTrip`、`sync.Mutex.Lock` / `runtime.semacquire`、
  `WaitForSingleObject` / `NtWaitForSingleObject`，且对端 QFLockSvc 的 Dump 里
  `handlePipeConn` / `Engine.HandleIPC` 正卡在同一请求的 `VerifyPassword`（Argon2）
  或 `VerifyLogin`（meshverify 网络）上。
- 注意：v2.0.2 的 ipcclient 超时靠 `resetConn` 关连接打断阻塞读——若栈显示
  roundTrip 仍在等且已超 10 秒（status/unlock）或 30 秒（recover），说明超时
  机制未生效或等待不在读上，记为 H1 强信号；反之，若 UI 线程栈顶在
  `GetMessage` 空闲等待而工作协程无 roundTrip 帧，H1 不成立。
- 对照：`!handle` 看管道句柄状态；两端 Dump 时间戳差应 < 60 秒，否则记“非同时采集”。

### (b) UI 消息循环停止响应（H2）
- 命中信号：UI 线程（`runtime.LockOSThread` 钉死的那个，带窗口过程 `main.wndProcCb`）
  的栈停在 `SetWindowDisplayAffinity` / `SetWindowPos` / `CreateWindowExW` /
  `SetWindowsHookExW` / `EnumDisplayMonitors` 回调内超过 5 秒，或停在
  `SendMessageW` 等待另一线程回话；或 `GetMessageW` 根本不在任何线程栈上
  （消息循环已不在泵消息）。
- 辅助：`~* k` 里找 `main.runInitStep`（分步初始化中途卡住）、`main.tickTopmost`、
  `main.buildWindows`；`!analyze -v` 的 `BLOCKING_THREAD` 与之互证。

### (c) 图形驱动 / 绘制调用未返回（H3）
- 命中信号：栈顶在 `dwmapi.dll` / `gdi32.dll` / `d3d11.dll` / `dxgi.dll` /
  `win32u.dll!NtGdi*`，或 `SetWindowDisplayAffinity`（WDA_EXCLUDEFROMCAPTURE）
  内；同时事件日志里有同窗口的 DxgKrnl / Display 驱动恢复事件（1000/1001/1002
  或 System Display 事件）。
- 单有灰屏不是 H3 证据：Windows 给无响应窗口画的“幽灵窗”本身就是灰色，
  必须有驱动事件或驱动栈才算 H3 命中。

### (d) 目标会话 / 桌面权限不正确（H4）
- Dump 里直接看不到 SessionId——须对照采集清单：QFLockUI 的 SessionId、
  ParentProcessId（应为 QFLockSvc 的 PID）、命令行、token 用户 SID。
- 命中信号：SessionId = 0（跑在服务会话）、或与当前活动控制台会话不一致、
  或 `CreateProcessAsUser` 用的 token 不是该会话用户、或窗口站不是
  `WinSta0\Default`。若 UI 窗口曾在本机可见（黑屏/灰屏用户亲眼见到），
  H4 作为“挂起根因”即被削弱——窗口能显示，说明会话/桌面大体是对的；
  但仍须在报告里写明实测 SessionId/SID/Desktop，不得空着。

### (e) 其他资源 / 竞态（H5）
- 命中信号：`state.dat` 损坏（`Fault()=state-corrupt`）、`status.json` 写死循环、
  句柄/内存暴涨（`!handle` 计数、`!address -summary`）、Go 运行时死锁
  （`runtime.checkdead` / `fatal error: all goroutines are asleep - deadlock!`）。
- 若五项全未命中：写“Dump 未解释挂起”，列还缺什么（例如 ProcDump 触发时
  进程已退出、抓到的是 watchdog 重拉后的新进程），不许硬指一条。

## 3. 结论写法（写进 REPORT.md）
- 只有同时满足才升级为“确认根因”：① Dump 能打开且栈可读；② 命中上述某一项
  的具体帧；③ 同一时间段的 IPC/窗口/会话证据与之一致（例如 H1 须有对端栈或
  超时记录，H2 须有窗口树/挂起事件 1002，H4 须有 SessionId/SID 实测）。
- 其余假设逐条写“排除依据”或“仍无法判断 + 缺哪份证据”。
- 贴关键栈原文（脱敏：不含密码/令牌/密钥），并附 Dump 文件名 + SHA-256。

## 4. 常见误判
- `GetMessageW` 空闲等待 ≠ 挂起：UI 线程在 GetMessage 里睡是正常的，挂起看的是
  “在 wndProc/同步调用里回不来”或“根本没有线程在 GetMessage”。
- 工作协程在 `roundTrip` 里等读 ≠ UI 挂起：v2.0.2 里 I/O 不在 UI 线程，
  只有 UI 线程本身的栈才能定 UI 挂起。
- 灰屏 ≠ GPU 故障：先按 (b) 查消息循环，再按 (c) 查驱动。
