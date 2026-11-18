# QFRemote 隐私锁 v2 · 新组件（B 线）

- 定夺：`~/workspace/qfremote/gpt-a16s2-lockbug-ruling-20261119.md` §1/§3/§5/§6.2
- 协议契约：工作区根目录 `CONTRACT.md`（与 C 线服务端逐项对齐）
- 旧 QFLockUI（无源码 Go 二进制）只作诊断参考，**绝不打补丁**；本目录是重写实现。
- 控制台业务入口不变：Web 面板 `POST /lock/enable|disable|reset` 契约不变，
  服务端仍走 `op:'arm'/'disarm'` 信封；本组件是设备端执行模块。
- 阶段 1 暂停仍在：`/lock/enable` 回 503 维护文案，新组件通过验收前不解除。

## 三层架构（定夺 §3 批准）

| 层 | 文件 | 运行位置 |
|---|---|---|
| QFRLEA 可信协调层 | `lock-coordinator.js` | Session 0：状态持久化、心跳、故障恢复监督；**不创建交互窗口** |
| 会话内隐私显示组件 | `session-agent.ps1` | 已核实的交互会话：锁桌面、密码界面、真实熄屏、原生锁屏兜底 |
| 远程控制与输入隔离组件 | `input-health.js` + USH（现有 `windows/ush/` SendInput 路径） | 输入健康探针、operation_id 五段追踪、只重建控制通道 |

支撑模块：`lock-state.js`（§4.2 状态机＋事务持久化）、`lock-ipc.js`
（异步 IPC＋硬超时＋取消）、`password-vault.js`（scrypt 哈希、过期、
撤销、5 次失败上限）、`display-power.js` + `display-power.ps1`
（真实 SC_MONITORPOWER 熄屏）、`failsafe.js`（FAILSAFE 判定）。

## 六条工程约束落点

1. Session 0 不建交互窗口：`lock-coordinator.js:_requireInteractiveSession`
   拒绝 session 0／非活动会话；`session-agent.ps1` 启动自检同样拒绝。
2. 事务写状态：`lock-state.js:LockStateStore`（tmp＋fsync＋rename＋journal）；
   ACK 才进 LOCKED（`applyAck` 验 lock_id＋单调 revision，防重放）。
3. UI 线程不无限期等 IPC：`lock-ipc.js` 全异步＋硬超时（默认 5s，上限 30s）
   ＋AbortSignal 取消；迟到响应按未知 id 丢弃。
4. 本地隔离不用 `BlockInput(TRUE)`：锁桌面隔离（`session-agent.ps1`
   CreateDesktop＋SwitchDesktop）；远程经 USH SendInput 在原桌面注入。
5. 钩子不作安全边界：LLKHF_INJECTED 只进健康报告作诊断线索。
6. 异常退出失败保护：`failsafe.js`＋`enterFailsafe`——原生锁屏兜底、
   撤销一次性密码、明确上报 FAILSAFE，绝不悄悄露桌面仍称受保护。

## 真实熄屏

锁定后 `display-power.ps1` 发 `SC_MONITORPOWER 2` 关闭真实本地显示输出；
本地物理输入唤醒（`SC_MONITORPOWER -1`）后只显示锁桌面密码框；
远程操作不唤醒本地显示器。**黑屏窗口不算熄屏。**
D39ABOL 硬件类别实测当前 BLOCKED（笔记本桥连不上），见 `REPORT.md`。

## 测试

沙箱可跑的部分在 `windows/test/lock-v2-*-test.js`（`node test/run-all.js`
自动发现），实跑结果见 `REPORT.md`。真机项（熄屏物理观察、本地键鼠、
30 次开锁、多屏/DPI/电源）一律标 BLOCKED，不提前写 PASS。

## 打包

本目录随 Windows 客户端打包（`windows/package.json` build.files 含
`lock-v2/**/*`）。构建产物 SHA 见 `BUILD.json`（提交时由 `sha256sum` 生成，
覆盖本目录全部源码与配套测试，不含 BUILD.json 自身）。
