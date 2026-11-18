# QFRemote 隐私锁 P0 修复 · B 线报告：新隐私锁组件＋安全失效恢复＋真实熄屏及远程输入隔离

- 日期：2026-11-19 03:0x–03:3x CST
- 任务书：`../lockfix-phase1/task-briefs/brief-b.md`
- 依据：GPT 锁 bug 定夺 `~/workspace/qfremote/gpt-a16s2-lockbug-ruling-20261119.md` §1/§3/§5/§6.2；阶段 1 报告 `../lockfix-phase1/REPORT.md`
- 缺陷：LOCK-P0-01（旧 QFLockUI 由新组件替代）、LOCK-P0-02（本地隐私与远程控制不可兼得）、LOCK-P0-04（锁异常退出后远程输入通道失效，输入侧修复）、LOCK-P0-05（真实熄屏能力及保护边界未验证）
- 分支：`a16s2-lockfix-b`，基线 `049d876`（正式 RC 源码起点；本线只改本分支内文件，未动基线之外的树，未碰 wt-a/wt-c）
- 本报告每个数字均注明实跑（本轮实际执行并有输出为证）或转述（引用他人已记录的结果，未经本轮复核）
- 阶段 1 暂停仍在：`/lock/enable` 回 503 维护文案，新组件通过验收前暂停不解除

## 结论先行

- 新组件实现：**已实施，沙箱单测全过**（见 §1；“已实施”≠“已验收”，真机项一律 BLOCKED）
- 协议契约：**已交付**（`CONTRACT.md`，§4.2 状态机一字不改；C 线服务端确认待回填，见 §5）
- 故障注入四项：**沙箱实跑全过**（组件崩溃、IPC 断开、断网、服务重启，见 §3）
- 真实熄屏：**实现已交付，硬件验收 BLOCKED**（D39ABOL 桥连不上，待回线后做；绝不提前写 PASS）
- 30 次开锁／长时间稳定性／本地键鼠／多屏 DPI／电源兼容：**全部 BLOCKED**（须真机）
- 旧 Go 二进制：**未打任何补丁**（只作诊断参考；新组件为重写实现）

## §1 交付物清单（实跑核对）

| 交付物 | 位置（本分支内） | 状态 |
|---|---|---|
| 协调层（Session 0） | `windows/lock-v2/lock-coordinator.js` | 已实施 |
| 状态机＋事务持久化 | `windows/lock-v2/lock-state.js` | 已实施 |
| 异步 IPC | `windows/lock-v2/lock-ipc.js` | 已实施 |
| 一次性密码保管 | `windows/lock-v2/password-vault.js` | 已实施 |
| 输入健康与恢复 | `windows/lock-v2/input-health.js` | 已实施 |
| 安全失效判定 | `windows/lock-v2/failsafe.js` | 已实施 |
| 真实熄屏调用 | `windows/lock-v2/display-power.js` + `display-power.ps1` | 已实施 |
| 会话内隐私显示组件 | `windows/lock-v2/session-agent.ps1` | 已实施（PS1 语法沙箱未验，见 §6） |
| 模块出口＋说明 | `windows/lock-v2/index.js`、`README.md` | 已实施 |
| 协议契约 | `CONTRACT.md`（工作区根目录） | 已交付 |
| 自动化用例（6 个文件） | `windows/test/lock-v2-*-test.js` | 沙箱实跑全过（§2） |
| 故障注入测试 | `windows/test/lock-v2-fault-injection-test.js` | 沙箱实跑全过（§3） |
| 构建 SHA | `windows/lock-v2/BUILD.json` | 已生成（§4） |
| 打包登记 | `windows/package.json` build.files 加 `lock-v2/**/*` | 已实施 |
| 本报告 | `REPORT.md`（工作区根目录） | 本文件 |
| 注入样本目录 | `evidence-b/injection-samples/README.md` | 0 条（本轮未撞见注入） |

控制台业务入口未动：`windows/lock.js`（`POST /lock/enable|disable|reset`）
与服务端 `op:'arm'/'disarm'` 信封契约一字未改；本线只新增设备端执行模块。

## §2 自动化用例实跑结果（实跑，沙箱 Node v24.22.1）

| 测试文件 | 用例数 | 结果 |
|---|---|---|
| `lock-v2-state-test.js`（状态机/事务/降级口径） | 14 | **PASS** |
| `lock-v2-ipc-test.js`（超时/取消/迟到丢弃/坏帧） | 7 | **PASS** |
| `lock-v2-input-health-test.js`（五段追踪/探针/重核/只重建控制通道） | 15 | **PASS** |
| `lock-v2-password-test.js`（一次性/5 次撤销/过期/无秘密外泄） | 8 | **PASS** |
| `lock-v2-coordinator-test.js`（arm 全路径/无 ACK 回退/Session 0 拒绝/幂等/密码 FAILSAFE/降级上报） | 19 | **PASS** |
| `lock-v2-fault-injection-test.js`（四项注入，见 §3） | 13 | **PASS** |
| 合计 | **76** | **PASS 76 / FAIL 0** |

回归：既有 `windows/test/lock-test.js`（隐私锁桥）实跑仍 PASS（21 用例）；
全部新 JS 文件 `node --check` 通过（实跑）。沙箱无 PowerShell，
两份 `.ps1` 未做语法机验（见 §6 第 3 项）；`node test/run-all.js` 全量
未跑（内含 release-gate 等长耗时项，与本线无关，见 §6 第 4 项）。

## §3 故障注入测试实跑结果（实跑，内存 IPC 假组件，只验协调层恢复逻辑）

| 注入项 | 过程 | 结果 |
|---|---|---|
| FI-1 组件崩溃 | arm 成功后杀会话组件 → 心跳发现 → FAILSAFE 上报，`RECOVERY_REQUIRED`，不再谎称 LOCKED | **PASS**（4 用例） |
| FI-2 IPC 断开 | 管道断开后 `onComponentLost` → `RECOVERY_REQUIRED` + FAILSAFE 事件 | **PASS**（2 用例） |
| FI-3 断网 | 断网期间上报排队（outbox=1）、锁状态保持 LOCKED 不翻转；恢复后补发 1 条 | **PASS**（3 用例） |
| FI-4 服务重启 | 同 boot_id 重启后重核一致恢复 LOCKED（同一 lock_id）；boot_id 变化后旧 LOCKED 进 UNKNOWN，不谎报 | **PASS**（4 用例） |

恢复全程不要求用户断开重连、不要求退出账号、不要求重启电脑（代码路径如此；
真机复核待阶段 4）。

## §4 六条工程约束自核（实跑代码＋测试为准，非真机验收）

| 约束 | 落点 | 自核 |
|---|---|---|
| 1. Session 0 不建交互窗口 | 协调层 `_requireInteractiveSession` 拒 session 0／非活动会话（测试 C1/C2）；`session-agent.ps1` 启动自检同样拒绝 | PASS（沙箱逻辑） |
| 2. 事务写状态；送达≠成功 | `LockStateStore`（tmp＋fsync＋rename＋journal）；`applyAck` 验 lock_id＋单调 revision；无 ACK 回 UNLOCKED（测试 B1/B2/A1） | PASS（沙箱逻辑） |
| 3. UI 线程不无限期等 IPC | 全异步＋硬超时（默认 5s，上限 30s）＋AbortSignal 取消；迟到响应丢弃（测试 B1/C1/C2） | PASS（沙箱逻辑） |
| 4. 不用全局 `BlockInput(TRUE)` | 本地隔离靠锁桌面（CreateDesktop＋SwitchDesktop）；远程经 USH SendInput 原桌面注入；代码库 grep 无 `BlockInput` 调用 | PASS（代码核查，实跑 grep） |
| 5. 钩子不作安全边界 | LLKHF_INJECTED 只进健康报告作诊断线索；无任何以钩子作信任判定的代码 | PASS（代码核查） |
| 6. 异常退出失败保护 | `enterFailsafe`：记 FAILSAFE＋撤销密码＋原生锁屏兜底＋明确上报（测试 E2–E4、FI-1/FI-2） | PASS（沙箱逻辑） |

附加约束：解锁界面为 QFRemote 自有样式密码框，不仿冒 Windows 登录；
一次性密码只存 scrypt 盐+哈希，明文永不落盘（测试 A2：状态无盐/哈希外泄）。

## §5 验收矩阵逐项（定夺 §6.2 相关行）

| 验收项 | 结论 | 依据 |
|---|---|---|
| 开锁稳定性：30 次连续锁定／解锁，0 卡死、0 异常退出 | **BLOCKED** | 须真机；沙箱只跑过单次 arm/disarm 循环 |
| 长时间稳定性：持续锁定＋远程操作压力，0 输入死锁 | **BLOCKED** | 须真机 |
| 本地熄屏：物理观察屏幕确实停止发光 | **BLOCKED** | D39ABOL 桥连不上；实现已交付（SC_MONITORPOWER），未实测 |
| 本地隐私：无桌面、通知、缩略图泄露 | **BLOCKED** | 须真机 |
| 本地输入：真实物理键鼠、触控不能操作受保护桌面 | **BLOCKED** | 须真机（锁桌面隔离逻辑已实现，未实测） |
| 远程画面：熄屏期间仍连续查看授权桌面，无持续黑屏／灰屏 | **BLOCKED** | 须真机（熄屏后捕获通道是否中断未知） |
| 远程输入：点击、双击、拖动、键盘、组合键均正常 | **BLOCKED** | 须真机（五段追踪＋健康探针逻辑已实现，未实测） |
| 显示兼容：内屏、外屏、多屏、DPI 缩放 | **BLOCKED** | 须真机 |
| 电源兼容：插电、电池、息屏、唤醒、合盖 | **BLOCKED** | 须真机 |
| 会话安全：锁屏、注销、RDP 连接／断开、多用户、非活动会话不越权 | **BLOCKED** | 须真机（会话核验逻辑已实现，未实测） |
| 状态一致：服务端、设备端、控制台不持续矛盾 | **BLOCKED** | 待 C 线服务端落盘＋阶段 3 联调 |
| 异常恢复：组件崩溃、IPC 断开、断网、服务重启后安全恢复或明确降级 | **PASS（沙箱逻辑）** | §3 四项注入实跑全过；**真机复核仍 BLOCKED** |
| 权限安全：未授权用户无法远程解除锁定，无重放／竞态绕过 | **BLOCKED** | 待 C 线（LOCK-SEC-01 审核）＋阶段 3 负向测试 |
| 二次确认：刷新不破坏弹窗，重复操作幂等 | **BLOCKED** | 设备端幂等已实现（测试 D3）；弹窗待 C 线 |
| 版本回归：2.4.4 正常远控及 3.0 其他模块无回归 | **BLOCKED** | 待阶段 3 全量回归 |

## §6 未完成事项与限制条件

1. D39ABOL 硬件类别真实熄屏验证 BLOCKED（笔记本桥连不上，阶段 1 报告 §3 同款原因；本线未碰笔记本、未开桥会话、未用浏览器）。
2. 全部真机验收项（§5 的 BLOCKED 行）待阶段 4 在保留救援通道的前提下复验。
3. 两份 `.ps1`（`session-agent.ps1`、`display-power.ps1`）沙箱无 PowerShell，未做语法机验；已逐行人工复核，待 Windows 环境 `powershell -NoProfile -File` 语法检查＋真机联调。
4. `node test/run-all.js` 全量未跑（内含 release-gate 长耗时项）；本线 6 个新测试＋既有 `lock-test.js` 已单独实跑全过。
5. C 线服务端待确认：上报接收端点、控制台降级文案、二次确认弹窗与短期挑战实现（CONTRACT.md §9 清单）；双方对齐前状态一致项保持 BLOCKED。
6. 命名管道真机联调（协调层 ↔ 会话组件）待阶段 3；沙箱只验了内存传输上的同帧格式协议。
7. `disarm` 后切回被保护桌面的恢复步骤在 `session-agent.ps1` 内已注明由协调层按会话恢复（不猜默认桌面名），待真机联调时最后确认。

## §7 构建 SHA（实跑）

- 包 SHA-256（11 个组件文件＋6 个测试文件的哈希串联哈希）：`c6d098f99bfe5db646cedd21c5ab6fb2f64ba3b4707a029e8a9bbd0598c11a59`
- 明细见 `windows/lock-v2/BUILD.json`（逐文件 SHA-256）。
- 基线 `049d876`；本线无编译产物（Node＋PowerShell 源码组件，随客户端打包，不单独编二进制）。

## 附录：提交与复核

- 提交号：（见最终回复；本报告提交后以 `git log a16s2-lockfix-b` 为准）
- 复核命令：`git show --stat HEAD`（文件清单）、`node windows/test/lock-v2-state-test.js` 等 6 个测试逐个实跑。
- 回滚：本分支未动生产服务、未动基线文件；废弃本分支即回滚。
