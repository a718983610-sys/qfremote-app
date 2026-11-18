# QFRemote 隐私锁 v2 · 协议契约（B 线设备端 × C 线服务端）

- 版本：v2.0.0（草案，待 C 线逐项对齐确认；阶段 3 P3-02/P3-04 已更新，见 §10/§11）
- 依据：GPT 锁 bug 定夺 `~/workspace/qfremote/gpt-a16s2-lockbug-ruling-20261119.md` §4.2（状态机一字不改）、§3（六条工程约束＋熄屏硬门）、§5（远程输入隔离与恢复）；GPT 三项定夺 `~/workspace/qfremote/gpt-a16s2-lockfix-3items-ruling-20261119.md` §2（旧程序退役）、§4.1（八问闭合）
- 设备端实现：`windows/lock-v2/`（本分支 `a16s2-lockfix-b`）
- 服务端实现：C 线（本文件只写设备端承诺与双方接口，服务端字段由 C 线落盘后回填确认）
- 控制台业务入口不变：`POST /lock/enable|disable|reset`；设备端信封 `op:'arm'/'disarm'` 不变（见 `server/friends/lock-envelope.js`，Ed25519 签名域不变）。
- 阶段 1 暂停仍在：`/lock/enable` 回 503 维护文案，新组件通过验收前不解除。

## §1 锁状态机（定夺 §4.2，一字不改）

| 状态 | 含义 |
|---|---|
| `UNLOCKED` | 已验证未锁定 |
| `LOCKING` | 正在建立保护 |
| `UNLOCKING` | 正在解除保护 |
| `LOCKED` | 设备确认保护生效 |
| `UNKNOWN` | 设备状态不可确认 |
| `RECOVERY_REQUIRED` | 状态冲突／故障恢复中 |

合法转移（设备端 `lock-state.js:TRANSITIONS` 强制执行，表外转移拒绝并记 `last_error`）：

- `UNLOCKED → LOCKING, UNKNOWN`
- `LOCKING → LOCKED, UNLOCKED, UNKNOWN, RECOVERY_REQUIRED`
- `LOCKED → UNLOCKING, UNKNOWN, RECOVERY_REQUIRED`
- `UNLOCKING → UNLOCKED, UNKNOWN, RECOVERY_REQUIRED`
- `UNKNOWN → UNLOCKED, LOCKED, LOCKING, RECOVERY_REQUIRED`
- `RECOVERY_REQUIRED → UNLOCKED, LOCKED, UNKNOWN, LOCKING`

另记降级原因：`degradation: null | { kind: 'DEGRADED' | 'FAILSAFE', reason, at }`。
**`LOCKED` + `degradation` 非空时，对外有效状态一律报 `DEGRADED`/`FAILSAFE`，
绝不能只报 `LOCKED`。** 只有 `LOCKED` 且无降级，才算真正受保护。

每次锁定记录字段（全量，缺一不可）：

| 字段 | 用途 |
|---|---|
| `lock_id` | 本次锁操作的唯一标识（`lock-<16 hex>`） |
| `device_id` | 目标设备 |
| `boot_id` | 区分重启前后的旧状态 |
| `session_id`、用户 SID | 确定被锁定的真实会话 |
| `revision` | 单调递增，防止旧响应覆盖新状态 |
| `desired_state` | 服务端希望设备达到的状态 |
| `actual_state` | 设备端确认的实际状态 |
| `last_heartbeat` | 确认状态证据的新鲜度 |
| `last_error` | 故障原因与恢复依据 |

裁决重申：服务端只能提出锁定意图，不能自行宣布锁已成功；客户端也不能只因
锁组件进程已启动就返回锁定成功。真正成功必须包括受保护会话、实际隐私保护
以及要求的远程能力验证。

## §2 设备端状态持久化（事务）

- 文件：`%ProgramData%\QFRemote\Lock\v2\lock-state.json` + 同目录 `lock-state.journal`（追加）。
- 写：临时文件 → fsync → 原子重命名 → journal 追加一行（含 `revision`、`actual_state`、`lock_id`）。
- `revision` 只在提交成功后递增；旧 `revision` 的 ACK/响应一律拒收（防重放）。
- 状态文件损坏时不猜、不自动清零：设备端报 `UNKNOWN`（`last_error.code='STATE_CORRUPT'`），
  由协调层重核；**绝不把损坏当成 `UNLOCKED`**。
- `boot_id` 变化（重启）后，旧 `LOCKED`/`LOCKING` 不可直接信任，置 `UNKNOWN` 重核。

## §3 设备端 ↔ 会话内组件 IPC

- 传输：Windows 命名管道 `\\.\pipe\QFR-Lock-v2`（协调层服务端、会话组件客户端）。
- 帧：每行一条 JSON：`{ id, type: 'request'|'response'|'event', method, params, ok, result, error, at }`。
- 全部异步：硬超时默认 5s（上限 30s），支持取消；超时/取消后迟到的响应按未知 id 丢弃。
- 方法（会话组件侧实现，见 `session-agent.ps1`）：

| 方法 | 参数 | 返回（ACK 语义） |
|---|---|---|
| `ping` | — | `{ alive, locked, lock_id, displayOff, session_id }` |
| `arm` | `{ lock_id, session_id, user_sid }` | `{ locked: true, lock_id, display_off, display_power_ok }` |
| `disarm` | `{ lock_id }` | `{ locked: false }` |
| `wake` | — | `{ woken: true, submitted }`（仅本地物理输入触发；密码明文不回传） |
| `sleep-display` | — | `{ displayOff }` |
| `failsafe-lock` | `{ reason }` | `{ failsafe: true }`（调 Windows 原生 `LockWorkStation`） |
| `status` | — | `{ locked, lock_id, displayOff, failsafe, session_id }` |
| `shutdown` | — | `{ ok: true }` |

- 会话核验（每次 `arm` 前必做）：目标会话非 Session 0、为活动交互会话、
  `session_id` 与用户 SID 与请求一致；不符一律拒绝，不拉起组件。
- `arm` 的 ACK 条件：`locked === true` 且 `lock_id` 一致；无 ACK 时设备端
  回 `UNLOCKED`，不留 `LOCKING` 悬挂。

## §4 设备端 → 服务端上报事件

上报通道：现有 lock-bridge 信封通道复用（C 线落盘）；断网时设备端本地排队
（`outbox`），恢复后补发；**上报失败绝不改锁状态**。

| 事件 `type` | 关键字段 | 含义 |
|---|---|---|
| `lock_requested` | `lock_id, desired_state='LOCKED', revision` | 服务端意图已收，正在建立保护 |
| `lock_ack` | `lock_id, actual_state='LOCKED', effective_state, revision` | 设备确认保护生效 |
| `lock_failed` | `lock_id, error, code` | 建立保护失败（未锁上） |
| `disarm_ack` | `lock_id, actual_state='UNLOCKED', revision` | 已确认解除 |
| `disarm_idempotent` | `lock_id, actual_state='UNLOCKED', revision` | 已解锁时重复解除：幂等，不当故障 |
| `disarm_failed` | `lock_id, error` | 解除失败，进 `RECOVERY_REQUIRED` |
| `recovery_required` | `lock_id, reason, actual_state, revision` | 状态冲突／故障恢复中 |
| `recovery_reconciled` | `lock_id, actual_state='LOCKED', revision` | 重启后重核一致，恢复 LOCKED |
| `recovery_unknown` | `actual_state, revision` | 重启后状态仍不可确认 |
| `failsafe` | `lock_id, reason, effective_state='FAILSAFE', actual_state, revision, native_lock: { attempted, ok, error? }` | 已降级：原生锁屏兜底与否如实上报 |

心跳：协调层每 5s 向会话组件 `ping`，并向服务端报 `last_heartbeat`；
组件心跳超时 10s 且处于 `LOCKED`/`LOCKING` 时进 FAILSAFE（见 §7）。

## §5 远程输入健康报告（定夺 §5.2/§5.3）

- 输入健康与画面通道完全独立：画面时钟在走 ≠ 输入可用。
- 每次输入操作带 `operation_id`（`op-<16 hex>`），五段分开记：
  `ui_event`（Web 点击生成）→ `signal_received`（信令到达设备）→
  `ush_execute`（USH 队列/会话路由/注入调用）→ `window_target`
  （到达正确桌面与窗口）→ `video_feedback`（画面出现预期变化）。
  区分“收到指令”“系统 API 返回成功”“目标应用实际响应”三层。
- 输入状态 `input_status: healthy | degraded | failed | unknown`；
  `failed`/`degraded` 时控制台必须原样展示“远程输入不可用”，
  **不得继续显示 Connected**。
- 锁组件退出或会话切换后：重核输入状态（重验会话/SID/调用者身份），
  不符绝不恢复输入；必要时只重建控制通道（重新握手＋重核），
  不强制断开整个远程桌面。
- 禁止：放宽 LEA 身份准入、伪造父进程、跨会话注入。
- 低级键盘钩子的注入标志（`LLKHF_INJECTED`）只作诊断线索，不作信任证明。

## §6 密码与解锁

- 一次性密码只存 scrypt 盐+哈希（`password-vault.js`），明文永不落盘、不进日志。
- 默认有效期 10 分钟（与 arm 信封 TTL 对齐）、最多错 5 次；错满或过期立即撤销。
- 验对即作废，不可复用；远程解除后立即撤销。
- 解锁界面是 QFRemote 自有样式密码框（标题明确写 QFRemote 隐私锁），
  **不仿冒 Windows 登录界面**。
- 远程解除锁定须经现有账号授权体系；定夺 §4.4 的二次确认弹窗、短期操作挑战、
  幂等请求由 C 线前端实现，设备端配合 `revision` 校验（过期 `revision` 的
  disarm 拒绝，`STALE_REVISION`）与幂等 `disarm_idempotent` 响应。

## §7 故障恢复与 FAILSAFE

触发（任一成立）：会话组件退出、心跳超时 10s、IPC 断开且重连失败、
状态文件损坏、密码失败次数满、重启后旧 `LOCKED` 无法重核确认。

降级动作（顺序）：① 记 `degradation={ kind:'FAILSAFE', reason }`，
`actual_state` 进 `RECOVERY_REQUIRED`；② 撤销本次一次性密码；
③ 仍可用的会话组件调 Windows 原生 `LockWorkStation` 兜底；
④ 上报 `failsafe` 事件（含 `native_lock` 是否成功）；
⑤ 控制台显示“隐私保护已降级”，不得继续显示正常 `LOCKED`。

故障注入验收（B 线已实现，沙箱实跑，见 `REPORT.md`）：
组件崩溃、IPC 断开、断网、服务重启四项，恢复或降级流程自行完成，
不要求用户断开重连、不要求退出账号、不要求重启电脑。

## §8 真实熄屏（硬门）

- 锁定后本地物理显示器熄灭：`SendMessage(HWND_BROADCAST, WM_SYSCOMMAND, SC_MONITORPOWER, 2)`。
- 需本地解锁时经受控唤醒（`SC_MONITORPOWER -1`）才显示密码界面，
  唤醒过程绝不暴露被保护桌面；远程端继续显示桌面并允许授权操作。
- 远程操作不唤醒本地显示器；本地 60 秒无操作重新熄屏。
- **黑屏窗口不算熄屏。** 熄屏后捕获通道是否中断、远程是否持续唤醒本地显示器，
  以 D39ABOL 硬件类别真机实测为准（当前 BLOCKED）。
- 对确实无法提供完整能力的硬件/Windows 组合，报告“不支持完整隐私熄屏”，
  不改断言蒙混。

## §9 对齐状态（B 线设备端已落盘；C 线服务端待确认）

- [x] §1 状态机与转移表（设备端已实现，`lock-state.js`）
- [x] §2 事务持久化（设备端已实现）
- [x] §3 IPC 方法与帧格式（设备端已实现；命名管道真机联调待阶段 3）
- [x] §4 上报事件格式（设备端已实现；服务端接收落盘待 C 线）
- [x] §5 输入健康报告格式（设备端已实现；控制台展示待 C 线）
- [x] §6 密码规则（设备端已实现；二次确认弹窗与短期挑战待 C 线）
- [x] §7 FAILSAFE 流程（设备端已实现）
- [x] §8 熄屏调用（设备端已实现；硬件实测 BLOCKED）
- [x] §10 旧程序退役与安全迁移方案（设备端已实现为可执行逻辑＋测试；真机执行 BLOCKED）
- [x] §11 八问 B 线回答（`ANSWERS-8Q.md`，8/8 已答；C 线确认待回填）
- [ ] C 线服务端确认回填：上报接收端点、控制台降级文案、二次确认弹窗实现、八问 C 线确认栏

## §10 旧程序退役与安全迁移（P3-02，裁决 §2）

实现：`windows/lock-v2/legacy-retirement.js`（纯逻辑＋注入式 ops；沙箱实跑，真机执行 BLOCKED）。

- 暂停期：四个旧二进制 SHA 已清点（`LEGACY_SHA256`，与本树 `windows/privacy-lock/app/` 副本实测一致）；启动入口 10 条已清单化（安装器 SEC_LOCK、QFLockSvc 服务、`install.ps1`、`install-upgrade.ps1`、客户端自愈、`sys-helper install-lock`、`update` 信封、卸载脚本、手动运行副本、Run 键／计划任务——本树内未发现，须真机扫描补入）；产品侧入口均被暂停覆盖（`/lock/enable` 503＋`/lock/update` 冻结）。
- 控制台提示文案（裁决原文，一字不改）：「当前屏幕锁功能因兼容性故障暂停使用。请勿手动运行旧版 QFLockUI.exe。正常远程控制功能不受此项暂停影响。」——风险告知，不是安全控制的替代品；拦不住用户双击自有副本。
- 接管期七步（`planMigration`）：验身份 → 保全证据 → 查锁状态 → 清启动引用 → 签名新组件替换 → 按清单退役 → 验安装与回滚。退役 = 移入证据隔离区（**非删除**），彻底删除须另行批准；新组件启动失败绝不静默回退旧程序；任一步失败即回滚。
- 前置检查（`checkMigrationPreconditions`，任一不满足即拒绝）：新组件未过集成审核、签名／哈希未过、锁状态 UNKNOWN（D39ABOL）或 RECOVERY_REQUIRED、存在未处理活动保护、转移中、证据不可保存、身份不符、状态文件损坏、要求删状态文件、要求强行改 UNLOCKED。
- D39ABOL：UNKNOWN 保持不变；不删状态文件；不因锁 UI 进程曾被关闭推断已解锁；不通过安装新组件强行覆盖未知状态；不在该笔记本上再次主动启动旧锁程序测试。设备重新上线后先只读核查与安全恢复，再讨论迁移。

## §11 status.json v2 字段（P3-04 八问决议，待 C 线确认）

`StatusReporter.buildStatus()` 产出的 status.json v2（v1 字段全保留）：

| 字段 | 来源与语义 |
|---|---|
| `state` | v1 兼容：只有设备确认的 `LOCKED` 才报 `Locked`，其余报 `Off`（`LOCKING` 报 `Off` 是有意的：送达 ≠ 成功） |
| `actual_state` | 六态真相；服务端对账必须优先读它，不读 `state` |
| `boot_id` / `session_id` / `sid` | 本次启动标识／数字会话号／Windows 用户 SID（`sid` 与 `session_id` 不是同一个东西） |
| `revision` | 每次真实状态变更 +1；同态转移不 +1；旧 `revision` 的 ACK 拒收 |
| `armedAt` | 最近一次进入 `LOCKED` 的 ISO 时间；离开 `LOCKED` 即清空 |
| `captureExclusion` | `active` / `failed-degraded` / `unknown`；只在会话组件回报时改写；`LOCKED` 下非 `active` 按 `DEGRADED` 对待 |
| `lastEvents` | 最近 10 条 `{ts, ev, fields}`；`ts` 均为 ISO UTC |
| `disarm` 事件 | `fields` 必含 `lockId`（与 `arm` 的 `armId` 对称） |
| `unlock-ok` 事件 | `ts` 为 ISO UTC，与 `arm` 可比；`fields` 含 `lockId` |
| `boot-recovered` 事件 | `recoverAfterRestart()` 在 `boot_id` 变化且旧态为 `LOCKED`/`LOCKING` 时必写，且只写一次 |
| 信封去重 | 重复 `disarm` 信封必拒（`E_ENVELOPE_REPLAY`），不执行副作用；只有成功后才记信封 id |

冲突记录（统一契约以 v2 为准，详见 `ANSWERS-8Q.md`）：#5 旧 Go 只在 fail-limit 重启时写 `boot-recovered`，与 C 的“重启恢复必写”假设不符——过渡期 C 对旧设备保留时间窗口兜底；#3/#4 旧 Go 的 `disarm`/`unlock-ok` 无 `lockId`，v2 已补，过渡期同上；#9 `unknown` 的降级映射限定在 `LOCKED`/`LOCKING` 下。
