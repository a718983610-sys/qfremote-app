# A 线组件定位清单（诊断用，绝不修补）

- 核对时间：2026-11-19 03:xx CST，本轮实跑
- 基线：`049d876`，分支 `a16s2-lockfix-a`，工作区 `wt-a`
- 结论：wt-a 内 4 个旧 Go 二进制与 `privacy-lock-impl/dist/pkg`（v2.0.3 发行包）逐字节一致；
  与 `QFLock-Component-v2.0.3.zip`（SHA 见下）内文件一致。源码 `privacy-lock-impl/src`
  的函数符号与二进制符号逐项对得上（`main.launchUIInSession`、`main.sessionID`、
  `display.(*FSM).*`、`ipcclient.(*Client).*`、`pipewin.*`），可作诊断依据。
  但二进制本身无版本资源、无 `2.0.3` 字面量，**D39ABOL 上实际装的是哪个版本，
  只能以取证包里的 `device.json:componentVersion` 与 `status.json:version` 为准**，
  在此之前不得断言事故机跑的是 v2.0.3。

## 1. 旧组件位置与 SHA-256（实跑）

| 组件 | 仓库路径（wt-a） | 大小 | SHA-256 |
|---|---|---|---|
| QFLockService.exe（服务，Session 0） | `windows/privacy-lock/app/QFLockService.exe` | 7,898,112 B | `eae8784c58e2cdae27fdf12758d6445a755685562ecbef814ac1f3137044206e` |
| QFLockUI.exe（会话 UI） | `windows/privacy-lock/app/QFLockUI.exe` | 3,702,784 B | `712a6d89f6ca2a93917aa0c7c506af7725ea83b957c0a119f6d0db84d6dbc84a` |
| qf-lockctl.exe（命令桥，生产只用 apply/status） | `windows/privacy-lock/app/qf-lockctl.exe` | 7,896,064 B | `cdc797a2ec0fcb50a6b5ed85047bea28caade3e78e7146deab204959f26596b4` |
| qf-lockupdater.exe（独立更新进程） | `windows/privacy-lock/app/qf-lockupdater.exe` | 3,017,728 B | `2fc4bb6d41f18a0c2f68564e4e3be56592d36a3eab4eb0e9c3d7c38453e07290` |

- Go 版本：4 个二进制均含 `go1.27.1`（实跑，`strings` 检出两处）；`go.mod` 亦为 `go 1.27.1`。
- PE：均为 PE32+ x86-64，Subsystem 3（console），无 VS_VERSIONINFO（实跑，pefile）。
  导入表只有 `kernel32.dll`（48 项），其余 Win32 调用全经 `golang.org/x/sys/windows`
  懒加载（`NewLazySystemDLL` + `NewProc`），静态导入表看不到会话/窗口调用——
  会话与窗口行为须以源码 + Dump 栈为准，不得只凭导入表下结论。
- 发行包：`QFLock-Component-v2.0.3.zip` SHA-256
  `f27c45061c6c0b86f6587f45ee953ecdeee20b299a234860036b62ae19d035be`，9,419,201 B，
  与 `dist/release-info.json` 一致（实跑）。

## 2. 安装后落盘位置（install.ps1，wt-a 版实读）

| 项目 | 值 |
|---|---|
| 安装目录 | `%ProgramFiles%\QFRemote\Lock`（4 个 exe + `device.json` + `dispatcher-pubkey.txt`） |
| 数据目录 | `%ProgramData%\QFRemote\Lock`（`state.dat`、`status.json`、`audit.log`、`svc.log`、`device-key.dat`、`inbox\`、`backup\`） |
| 服务名 | `QFLockSvc`，`sc.exe create … start= auto`，失败重启动作为 restart/5000 ×3 |
| 数据目录 ACL | 仅 SYSTEM + Administrators（`icacls /inheritance:r`） |
| device.json 字段 | `nodeId`、`ownerUsername`、`serverHost`、`serverPort`、`componentVersion="2.0.3"`、`installedAt` |

注意：wt-a 的 `install.ps1` 比 `dist/pkg/install.ps1` 新（含 2026-11-11 缺陷③修复：
落盘核验、sc.exe 终态核验、30 秒 Running 等待）；`README.md` 两边一致。
安装脚本的版本不等于二进制的版本——二进制版本仍以 device.json 为准。

## 3. 源码位置（只读诊断）

`~/workspace/qfremote/privacy-lock-impl/src`（不在本工作区、不在本分支，只读，不改）：

| 文件 | 作用 |
|---|---|
| `src/cmd/qflocksvc/main_windows.go` | 服务宿主：管道监听、看门狗、`launchUIInSession` |
| `src/cmd/qflockui/main_windows.go` | 会话 UI：窗口/钩子/消息循环/分步初始化 |
| `src/internal/core/{engine,ipc,store,status,audit}.go` | 状态机、IPC 协议、落盘、快照、审计 |
| `src/internal/pipewin/pipe_windows.go` | 命名管道层（服务端 SDDL + 客户端 DialTimeout） |
| `src/internal/ipcclient/ipcclient.go` | UI 侧单飞 + 硬超时管道客户端（2.0.2） |
| `src/internal/display/display.go` | 暗屏⇄唤醒 FSM（60 秒无物理输入再暗屏） |

源码与二进制的对应关系已用符号表核对（见 REPORT.md §1.3），不是凭文件名认领。
