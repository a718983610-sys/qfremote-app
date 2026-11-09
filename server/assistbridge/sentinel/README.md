# 哨兵真机件包（0g 夹具实验用，scratch）

来源：Step 0 原型 `step0-20261030/scratch/sentinel-prototype/SentinelPrototype.cs` 的原样拷贝，
仅一处改动——`Convert.ToHexString`（.NET 5+ API）换成 `BitConverter.ToString(...).Replace("-","")`，
使之能被 Windows 自带 .NET Framework csc.exe 编译；哈希链语义不变（链内自洽即可，首条 prevHash
为 sha256(空串) 的大写十六进制形态）。FEASIBILITY.md 的未证四项正是本包要在夹具上实证的。

## 构建与安装（夹具上，console 会话，管理员 PowerShell 或普通 PS 均可，装任务时需管理员）

```
build.bat            → 产出 QFBridgeSentinel.exe（用 %WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe，免 SDK、免联网）
powershell -ExecutionPolicy Bypass -File install.ps1
```

install.ps1 做三件事：拷贝 exe 到 `%LOCALAPPDATA%\QFRemoteSentinel\`；注册计划任务
`QFBridgeSentinel`（当前交互用户、登录触发、**最高权限**——本地 kill 的停服务一腿需要提权，
且托盘必须活在 console 会话，故不用服务账号）；立即启动任务，托盘应出现「QFRemote 助手桥哨兵（待机）」。

## 实验挂钩（exp-0g-sentinel.js 依赖以下约定，勿改）

| 项 | 值 |
|---|---|
| 状态文件 | `%LOCALAPPDATA%\QFRemoteSentinel\session-state.txt`，内容 `active <sessionId>` / `idle`，哨兵 500 ms 轮询 |
| kill 记录 | 同目录 `kill-log.jsonl`（append-only，prevHash 链） |
| 本地标志 | 同目录 `LOCAL-DISABLED`（kill 后落盘） |
| 热键 | Ctrl+Alt+F12（原型定值）；托盘右键菜单首项「断开助手会话」与之等价 |
| kill 策略序 | ①停 `MeshAgent` 服务（WaitForStatus 2 s）→ ②杀 MeshAgent/meshagent 进程 → 落标志+记录+气泡 |

## 已知限制（实验判读时注意）

- 气泡通知（ShowBalloonTip）在新版 Windows 上可能以 toast 形态呈现，托盘区帧证据以实际渲染为准。
- 热键经 KVM 注入是否触发 RegisterHotKey 是本实验的待证项之一（注入走 SendInput 路径，
  理论可达；exp-0g 先试热键、失败自动转托盘菜单路径，两路结果分别记录，不互相顶替）。
- 停服务时延受夹具负载与防护软件影响，这正是要量的数；若 `MeshAgent` 服务名不符
  （agent 版本差异），进程一腿仍可达，记录 method 字段会如实区分。

## 卸载

先跑 exp-0g 的 recover 阶段把 kill-log 截图存证，再 `powershell -ExecutionPolicy Bypass -File uninstall.ps1`
（删任务、杀进程、删目录——含本地 kill 记录，需要留档先自行拷贝）。
