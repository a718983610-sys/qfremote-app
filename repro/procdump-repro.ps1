# 受控复现程序：QFLockUI 挂起（LOCK-P0-01）
# 用途：在带合格交互用户会话的独立 Windows 测试环境上复现 2026-11-19 事故，
#      用 ProcDump 抓挂起时刻的完整转储。只做诊断，不修补旧二进制。
# 执行身份：测试机本地管理员。执行前通读全部停止条件。
# 腾讯 CVM 只有终端、没有合格交互会话，不得冒充最终显示验收设备（见 §0）。

# §0 环境门（缺一不可，缺一项即停，不许将就开锁）
#  1. 独立测试机（不是站长笔记本、不是生产机），本地控制台有人登录的交互会话，
#     会话状态 WTSActive，桌面 WinSta0\Default 可见。
#  2. 已装 v2.0.3 锁组件（device.json:componentVersion 与 status.json:version 先抄下；
#     若与事故机版本不一致，复现结论只对“该版本”有效，必须在报告里写明）。
#  3. 有第二条救援通道（MeshCentral/QFRemote 远控 + 本地管理员能进控制台），
#     且已验证“杀掉 QFLockUI 后桌面能恢复”。
#  4. ProcDump 已从微软官方 Sysinternals 取到（见 §1），Dump 目录已建好并限权。
#  5. 已通知协调人本轮复现的时间窗口；站长笔记本不参与本轮。

# §1 准备（管理员 PowerShell，一次）
$dumpRoot = 'C:\QF-Lock-Dumps'
New-Item -ItemType Directory -Force -Path $dumpRoot | Out-Null
# 目录只留 SYSTEM + Administrators（Dump 含内存，可能含凭据材料，禁公开上传）
icacls $dumpRoot /inheritance:r /grant:r 'SYSTEM:(OI)(CI)F' 'Administrators:(OI)(CI)F'
# ProcDump：从 https://learn.microsoft.com/sysinternals/downloads/procdump 取 procdump64.exe，
# 放进 $dumpRoot，记下版本与 SHA-256（运行时实测填表，禁止事后补编）：
#   .\procdump64.exe -accepteula   # 首次只接受 EULA，不监控
#   Get-FileHash .\procdump64.exe -Algorithm SHA256
# 磁盘：预留至少 1 GB 空闲（QFLockUI 全 Dump 约为工作集大小，另备 lock-bridge 对端 Dump）。
#   Get-PSDrive C | Select-Object Free
# 基线快照（开锁前，先记下正常态）：
#   Get-Process QFLockUI,QFLockSvc -ErrorAction SilentlyContinue | Select-Object Id,ProcessName,SessionId,CPU,WorkingSet64,Responding,Path | Export-Csv "$dumpRoot\baseline-process.csv" -NoTypeInformation
#   Get-Service QFLockSvc | Select-Object Name,Status,StartType | Export-Csv "$dumpRoot\baseline-service.csv" -NoTypeInformation
#   Get-Content "$env:ProgramData\QFRemote\Lock\status.json" | Out-File "$dumpRoot\baseline-status.json"
#   query session

# §2 监控启动（先挂 ProcDump，再开锁；顺序不可反）
#   另开一个管理员 PowerShell 窗口执行（它会等待 QFLockUI 出现并监控无响应）：
#   cd $dumpRoot
#   .\procdump64.exe -accepteula -ma -h -w QFLockUI.exe C:\QF-Lock-Dumps
#   参数含义：-ma 完整转储；-h 检测到窗口无响应（>5 秒不泵消息）即转储；-w 等待进程出现。
#   注意：-h 只在“有窗口且无响应”时触发；若 QFLockUI 根本起不来或无窗口，ProcDump
#   不会转储，改走 §3 手动 -ma 抓快照（并在报告里写明触发方式不同）。

# §3 开锁（走产品路径，与事故一致）
#   在控制台面板点隐私锁“开启”并设一次性密码；记下点击时刻（精确到秒，UTC+8）。
#   预期正常现象：本机黑屏、密码框收起；动实体键鼠才亮出密码框。
#   事故现象：黑屏→灰屏、无密码框、Windows 弹“QFLockUI.exe 未响应”。

# §4 挂起时同步采集（在 ProcDump 转储的同时、关闭 QFLockUI 之前，逐项跑）
#   以下命令全部只读，不改状态文件、不删日志；输出进 $dumpRoot，文件名带时间戳。
$stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')
#   4.1 进程与会话（SessionId / SID / 响应态）
#   Get-Process QFLockUI -ErrorAction SilentlyContinue | Select-Object Id,ProcessName,StartTime,SessionId,CPU,WorkingSet64,Responding,Path | Export-Csv "$dumpRoot\hang-process-$stamp.csv" -NoTypeInformation
#   Get-CimInstance Win32_Process -Filter "Name='QFLockUI.exe'" | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine,SessionId | Export-Csv "$dumpRoot\hang-cim-$stamp.csv" -NoTypeInformation
#   Get-CimInstance Win32_Process -Filter "Name='QFLockService.exe'" | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine,SessionId | Export-Csv "$dumpRoot\hang-svc-cim-$stamp.csv" -NoTypeInformation
#   (Get-Process QFLockUI).SessionId  # 与 (Get-Process QFLockUI).StartTime 一并抄下
#   query session / qwinsta
#   4.2 窗口树（挂起窗口的句柄/类名/可见性；PowerShell 原生无 EnumWindows，
#        用 tasklist /v + 下面 C# 内联编译的 EnumWindows 小工具，二选一，取不到就写明缺失）
#   tasklist /v /fi "IMAGENAME eq QFLockUI.exe"
#   4.3 服务端对端：lock-bridge 对端不是本机进程——对端是 QFLockSvc（同机）。
#        服务进程 Dump（与 UI Dump 同一时刻抓，供 WinDbg 对照 IPC 两端）：
#   .\procdump64.exe -accepteula -ma (Get-Process QFLockService).Id "$dumpRoot\QFLockSvc-$stamp.dmp"
#   4.4 线程等待链（ProcDump 抓不到等待链时用 Process Explorer 的线程页截图，
#        或管理员 PowerShell：Get-Process QFLockUI | Select-Object Threads ——
#        只能给计数，判读仍以 Dump 栈为准；拿不到等待链不许编一个）
#   4.5 IPC 证据：管道状态与最近请求（只读）
#   [System.IO.Directory]::GetFiles("$env:ProgramData\QFRemote\Lock", '*', 'AllDirectories') | ForEach-Object { Get-Item $_ | Select-Object FullName,Length,LastWriteTime } | Export-Csv "$dumpRoot\hang-qfr-inventory-$stamp.csv" -NoTypeInformation
#   Get-Content "$env:ProgramData\QFRemote\Lock\status.json"
#   Get-Content "$env:ProgramData\QFRemote\Lock\svc.log" -Tail 50
#   Get-Content "$env:ProgramData\QFRemote\Lock\audit.log" -Tail 50
#   4.6 事件日志（与定夺 §2.2 同窗口：事故时刻前后各 30 分钟）
#   Get-WinEvent -FilterHashtable @{ LogName='Application'; StartTime=(Get-Date).AddMinutes(-30); EndTime=(Get-Date).AddMinutes(5); Id=1000,1001,1002 } -ErrorAction SilentlyContinue | Export-Csv "$dumpRoot\hang-app-events-$stamp.csv" -NoTypeInformation
#   Get-WinEvent -FilterHashtable @{ LogName='System'; StartTime=(Get-Date).AddMinutes(-30); EndTime=(Get-Date).AddMinutes(5) } -ErrorAction SilentlyContinue | Where-Object { $_.ProviderName -match 'Display|nvlddmkm|amdkmdap|igfx|WHEA|Kernel-Power' } | Export-Csv "$dumpRoot\hang-sys-display-$stamp.csv" -NoTypeInformation
#   4.7 远程输入证据（LOCK-P0-04 对照）：在挂起期间从远控端点一次桌面空白处，
#        记下操作时刻与“画面变/不变、点击生效/不生效”；不要连续狂点。
#   4.8 锁进程的命令行与父进程（对照启动链）
#   Get-CimInstance Win32_Process -Filter "Name='QFLockUI.exe'" | Select-Object ParentProcessId,CommandLine

# §5 收尾（取到 Dump 后才允许）
#   1. 先确认 Dump 文件已生成且非 0 字节：Get-Item "$dumpRoot\*.dmp" | Select-Object Name,Length,LastWriteTime
#   2. 再经系统“未响应”弹窗点“关闭程序”（与事故同款操作），或 Stop-Process -Id <QFLockUI pid>。
#   3. 观察：桌面是否恢复（记秒数）；watchdog 是否 2 秒内重拉 QFLockUI（Get-Process 再查一次；
#      若重拉后再次挂起，立即停轮，不许反复杀—拉循环刷 FailCount，见停止条件）。
#   4. 全部文件算 SHA-256 记入采集清单（SUMMARY.csv），原件留测试机，副本再传回。

# §6 停止条件（任一成立即停本轮，写明触发项，不许“再试一次”）
#   S1. 复现导致设备不可恢复（桌面杀不掉 UI、控制台进不去、重启后仍黑屏）。
#   S2. 救援通道失效（远控断开且重连不上、MeshCentral 节点离线）。
#   S3. 须越权绕过 Windows 会话安全机制（例如往别的用户会话注入、提权拿别人 token）。
#   S4. 同一轮内 QFLockUI 被 watchdog 重拉后第二次挂起（防 FailCount 刷到 5 次触发重启）。
#   S5. ProcDump 连续两次未触发（进程无窗口 / 秒退），改走手动 -ma 快照，不许为等触发反复开锁。
#   停止后：先恢复桌面与远控，再写报告；站长笔记本的复现只在阶段 4、且有同款救援通道时才批。
