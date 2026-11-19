# QFRemote 隐私锁协议契约（唯一版本化版本）

- **版本：v2.0.0**（定版，2026-11-19，P3-04 闭合 8 问后锁定）
- **前版：v1**（旧 Go 设备端组件＋C 线服务端 v1，`~/workspace/qfremote/privacy-lock-impl/CONTRACT.md` v1 与 `wt-p3c/CONTRACT.md` v1）
- **依据**：GPT 锁 bug 定夺 `~/workspace/qfremote/gpt-a16s2-lockbug-ruling-20261119.md` §4.2（六态与记录字段）／§4.3（D39ABOL 程序）／§4.4（二次确认）；GPT 三项定夺 `~/workspace/qfremote/gpt-a16s2-lockfix-3items-ruling-20261119.md` §1（双接口同步冻结）／§2（旧程序退役）／§3（分级认证）／§4.1（八问闭合）；B 线 `wt-p3b/CONTRACT.md` §10／§11 与 `wt-p3b/ANSWERS-8Q.md`；C 线 `wt-p3c/CONTRACT.md` §7／§8／§9／§11。
- **状态**：契约文本已锁定（P3-04，8 问 7 PASS／1 FAIL——#9 的 C 侧代码尚未按契约实现，见 §14）。**契约锁定 ≠ 代码已对齐 ≠ 锁 bug 已修好。** 隐私锁仍是 P0，3.0.0 维持 NO-GO；`/lock/enable` 与 `/lock/update` 暂停继续有效，解除只按裁决 §1.4 的统一受控流程。
- **适用范围**：设备端 v2 新组件（`windows/lock-v2/`）与服务端（`server/friends/lock-state.js`、`lock-bridge.js`）之间的锁协议；控制台（Electron＋网页）按本契约展示与确认。旧 Go 设备（v1）按 §11 过渡规则互通，不打补丁、按退役处理。

## 版本定版理由（v2.0.0，按实际兼容性审查定，非机械改名）

对照 v1 逐项判断是否破坏兼容：

| 变化 | v1 行为 | v2 行为 | 破坏线兼容？ |
|---|---|---|---|
| status.json 新增 `boot_id`／`session_id`／`sid`／`revision`／`actual_state`／`armedAt` | 无此字段 | 新增，v1 字段全保留 | 否（旧端忽略新增字段） |
| `disarm`／`unlock-ok` 事件加 `fields.lockId` | 只有 `{by}`／`nil` | 带 `lockId` | 否（服务端先比 lockId、不命中回落时间窗口） |
| `boot-recovered` 写入范围扩大 | 旧 Go 只在 fail-limit 重启时写 | v2 在 `boot_id` 变化且旧态 `LOCKED`／`LOCKING` 的重启恢复分支必写、只写一次 | 否（服务端只把它当带时间校验的强证据之一；旧设备无该事件时走兜底） |
| 信封去重拒绝点前移 | 旧 Go 二次进入 `Disarm`、因已 `Off` 无副作用 | v2 先查先拒（`E_ENVELOPE_REPLAY`），第二次连 `Disarm` 都不进 | 行为收紧，但**无副作用差**；错误码路径可观测 |
| `unknown` → `DEGRADED` 范围收窄 | C 一律记 `DEGRADED`（含空闲态） | 只限定在 `LOCKED`／`LOCKING` 下；`UNLOCKED` 空闲态不记降级 | 既有字段语义修正（修的是空闲态误报），非线格式变化 |
| v2 缺 `revision` 视为异常 | “有则校验、无则跳过” | 自称 v2 的设备缺 `revision` → `RECOVERY_REQUIRED`（`revision-missing`）；v1 设备仍跳过 | 否（仅约束自称 v2 的设备；v1 不受影响） |
| 转移表放宽为并集 | 各自较窄的表 | 只加边、不删边（相对两边已实现的代码） | 否；相对 C CONTRACT §1 文字表删 `RECOVERY_REQUIRED → UNLOCKING` 一条，但该边双端代码均未实现、无运行行为，属文档纠正 |
| `actual_state` 成为权威状态源 | 服务端只读 v1 `state`（`Locked`／`Off`／`Fault`） | v2 设备优先按 `actual_state` 分类，v1 回落 `state` 映射 | 线兼容（v1 设备无 `actual_state` 仍可互通），但**合规口径变了**：只读 v1 `state` 的服务端不再是“符合 v2 的实现” |

**定版结论：v2.0.0（major）。** 纯线兼容视角会判 1.1.0（v1 设备仍可互通，靠 §11 兜底），但本契约采纳 major 的实质理由有三：① `actual_state` 由“设备端补充字段”升格为**权威状态源**，状态判定口径被重新定义；② `revision` 由“有则校验”变为 v2 设备的**强制 conformance 项**（缺失即异常），自称 v2 却缺 `revision` 的设备不再是合格 v2 设备；③ `degraded` 字段的语义被收窄，`UNLOCKED` 空闲态的展示含义变了。合规口径变化即升 major。同时设备端 `buildStatus()` 已默认打 `version: '2.0.0'` 戳记，契约版本号须与设备戳记一致，不另立 1.1.0 造成双版本号。

## §1 锁状态机

六态（定夺 §4.2，一字不改）：`UNLOCKED`（已验证未锁定）、`LOCKING`（正在建立保护）、`LOCKED`（设备确认保护生效）、`UNLOCKING`（正在解除保护）、`UNKNOWN`（设备状态不可确认）、`RECOVERY_REQUIRED`（状态冲突／故障恢复中）。

另记降级原因：`degraded: null | 'DEGRADED' | 'FAILSAFE'`，与六态正交。**`LOCKED` + 降级非空时，对外有效状态一律报 `DEGRADED`／`FAILSAFE`，绝不能只报 `LOCKED`。** 只有 `LOCKED` 且无降级，才算真正受保护。

### 转移表（统一表，B 代码 ∪ C 代码）

| 从 | 可到 |
|---|---|
| `UNLOCKED` | `LOCKING`、`UNKNOWN`、`RECOVERY_REQUIRED` |
| `LOCKING` | `LOCKED`、`UNLOCKED`、`UNKNOWN`、`RECOVERY_REQUIRED` |
| `LOCKED` | `UNLOCKING`、`UNKNOWN`、`RECOVERY_REQUIRED` |
| `UNLOCKING` | `UNLOCKED`、`LOCKED`、`UNKNOWN`、`RECOVERY_REQUIRED` |
| `UNKNOWN` | `UNLOCKED`、`LOCKING`、`LOCKED`、`UNLOCKING`、`RECOVERY_REQUIRED` |
| `RECOVERY_REQUIRED` | `UNLOCKED`、`LOCKED`、`UNKNOWN`、`LOCKING` |

硬规则：

- **`LOCKED → UNLOCKED` 不许直达。** 强证据解锁必须走 `LOCKED → UNLOCKING → UNLOCKED` 两步，两步共用同一操作编号、都进审计。
- 读不到设备（超时／掉线／心跳过期）→ `UNKNOWN`，**永不判 `UNLOCKED`**。
- 设备报 `Off` 但无强证据且曾经锁定过 → `RECOVERY_REQUIRED`，不是 `UNLOCKED`。
- 状态文件损坏时不猜、不自动清零：设备端报 `UNKNOWN`（`last_error.code='STATE_CORRUPT'`），由协调层重核；**绝不把损坏当成 `UNLOCKED`**。
- 转移表来源说明：原始定夺 §4.2 未给出转移表；本表是 B、C 两边已实现代码的并集（相对两边代码只加边、不删边）。与本表不符的旧文字（C CONTRACT §1 的 `LOCKING` 行漏 `UNLOCKED`、`RECOVERY_REQUIRED` 行错写为 `UNKNOWN`／`UNLOCKING`）以本表为准，P3-05 同步纠正文字。`RECOVERY_REQUIRED → UNLOCKING` 不纳入——双端代码均不许，且无真实调用路径。

## §2 锁记录字段（双端同一张表）

每次锁定记录至少含（定夺 §4.2 全量）：

| 字段 | 含义 | 来源 |
|---|---|---|
| `lock_id` | 本次锁操作的唯一标识（`lock-<16 hex>`；服务端 arm 信封 id） | 服务端签发，设备端回显 |
| `device_id` | 目标设备 | 服务端 |
| `boot_id` | 本次启动标识，区分重启前后的旧状态 | 设备端 status.json（v2） |
| `session_id` | 数字会话号（WTS 会话号） | 设备端 status.json（v2） |
| `sid` | **Windows 用户 SID**（与 `user_sid` 同值；不是会话号） | 设备端 status.json（v2） |
| `revision` | 单调递增，防止旧响应覆盖新状态；每次真实状态变更 +1，同态转移不 +1 | 双端各记各的，互相对账 |
| `desired_state` | 服务端希望设备达到的状态（服务端意图，不代表实际） | 服务端 |
| `actual_state` | 设备端确认的实际状态（六态之一） | 设备端确认＋服务端对账 |
| `last_heartbeat` | 确认状态证据的新鲜度（优先取 `status.updatedAt`） | 设备端上报 |
| `last_error` | 故障原因与恢复依据 | 双端 |
| `created_at`／`updated_at` | 记录创建／最后更新时间（修正永不改 `created_at`） | 服务端 |
| `degraded` | 降级标记（`null`／`DEGRADED`／`FAILSAFE`），见 §9 | 服务端按 §9 刷新 |
| `history[]` | 审计：每次迁移／修正记 `{at, op_id, by, action, reason, from, to, revision}`，永不删除 | 服务端 |

铁则：**服务端只能提出锁定意图，不能自行宣布锁已成功；客户端也不能只因锁组件进程已启动就返回锁定成功。** 真正成功必须包括受保护会话、实际隐私保护以及要求的远程能力验证。`desired_state` 只能由服务端意图设置，设备端 `actual_state` 不跟随它自动变。

## §3 status.json v2 字段表（B 的 §11＋C 的 §2 合并）

`StatusReporter.buildStatus()` 产出的 status.json v2。v1 字段全保留：

| 字段 | 语义 |
|---|---|
| `state` | v1 兼容：只有设备确认的 `LOCKED` 才报 `Locked`，其余报 `Off`（`LOCKING` 报 `Off` 是有意的：送达 ≠ 成功） |
| `actual_state` | 六态真相；**服务端对账必须优先读它，不读 `state`**（v1 设备无此字段时回落 `state` 映射，见 §4） |
| `version` | 组件版本，v2 设备为 `2.0.0`（契约版本号与设备戳记一致） |
| `boot_id`／`session_id`／`sid` | 本次启动标识／数字会话号／Windows 用户 SID（`sid` 与 `session_id` 不是同一个东西，不可互相替代） |
| `revision` | 每次真实状态变更 +1；同态转移不 +1；旧 `revision` 的 ACK 拒收（`ACK_STALE_REVISION`）；`setDesired` 不动 `revision` |
| `armedAt` | 最近一次进入 `LOCKED` 的 ISO 时间；离开 `LOCKED` 即清空 |
| `captureExclusion` | `active`／`failed-degraded`／`unknown`；只在会话组件回报时改写；非法值抛错，不静默落成 `unknown` |
| `lastEvents` | 最近 10 条 `{ts, ev, fields}`；`ts` 均为 ISO UTC（`toISOString()`，毫秒精度） |
| `nodeId`／`ownerUsername`／`devicePublicKey`／`updatedAt` | v1 原样保留 |
| `fault`／`failCount`／`lockoutUntil`／`armSource` | v1 原样保留 |

## §4 对账规则（服务端 `reconcileRecord`／`classifyDeviceStatus`）

设备自报来源：`status.json`（MeshCentral 文件通道取回；组件心跳每 30 秒刷新）。

- **心跳新鲜度**：`status.updatedAt` 超 2 分钟未更新（`HEARTBEAT_FRESH_MS=120000`）→ 该次读取作废，分类 `UNKNOWN`（`stale-heartbeat`），不得当作实时状态。
- **状态源优先级（v2 新增，P3-05 实现）**：status 含 `actual_state` 时优先按 `actual_state` 分类；无 `actual_state` 的 v1 设备回落 v1 `state` 映射（`Locked`→`LOCKED`、`Off`→`UNLOCKED`（须证据规则）、`Fault`→`RECOVERY_REQUIRED`）。`actual_state` 是设备自报，仍须结合事件证据定证据等级，不能只凭它宣布强证据。
- **故障态**：`status.state==='Fault'` 或 `status.fault` 字段出现 → `RECOVERY_REQUIRED`（`device-fault`）。
- **设备报 `Locked` 且 arm 事件匹配**：`LOCKED`（有与本记录 `lock_id` 匹配的 arm 事件即强证据；无则仍信设备自报，但标 weak——服务端不得据此宣布“验证通过”）。
- **设备报 `Off`**：强证据解锁（任一）：① `disarm` 事件（见 §5）；② `unlock-ok` 事件（本地输密码解锁，同 ① 的判据）；③ `boot_id` 变化；④ `boot-recovered` 事件（时间 ≥ 本次 `created_at`）。无强证据且服务端曾锁定（当前态或审计历史曾为 `LOCKED`）→ `RECOVERY_REQUIRED`（`off-without-proof`）；服务端未曾锁定 → `UNLOCKED`（无需强证据）。**D39ABOL 当前即 `off-without-proof` 态。**
- **revision 冲突**：设备上报带 `revision` 且旧于服务端 → `RECOVERY_REQUIRED`（`revision-conflict`）。
- **无服务端记录**：以设备自报建只读基线（`actual=desired=设备态`，`baseline-from-device`，弱证据）。
- **读路径**：只在拿到新鲜设备 status 时才并入记录；读不到不翻 `UNKNOWN`，避免轮询抖动冲掉进行中弹窗的 `revision`。写路径超时翻 `UNKNOWN` 由各写分支显式做。
- **事件格式兼容**：`lastEvents` 接受新 `{ts, ev, fields}` 与旧 `{time, type, fields}` 两种形态；只取最近 10 条。

## §5 事件对账（8 问 #3／#4／#5 的统一口径）

### disarm 事件（#3）

- v2 设备 `disarm` 事件必须带 `fields.lockId`（与 `arm` 的 `armId` 对称）；缺 `lockId` 时设备端直接抛错，不写一条无法对账的 disarm 事件。
- 服务端匹配顺序：**有 `lockId` 时优先按 `lockId` 匹配**（兼容旧 `id` 键）；不命中才回落时间窗口（事件时间 ≥ 本次 `created_at`）。
- 桥的实时 disable 等待谓词须与对账模块同口径（P3-05 对齐；当前桥谓词只用时间窗口，见 §14 R-3）。

### unlock-ok 事件（#4）

- `unlock-ok`（本地输密码解锁）认作强解锁证据。`ts` 须为 ISO UTC（`toISOString()`），与 `arm` 的 `ts` 同格式、同源时钟，可直接 `Date.parse()` 比较。
- v2 的 `unlock-ok` 须带 `fields.lockId`；对账优先按 `lockId`，旧设备回落时间窗口。**无 `fields` 的旧事件也须过时间窗口校验**（`ts ≥ 本次 created_at`），不得无条件认作强证据（P3-05 收紧；当前 C 代码对无 `fields` 的 `unlock-ok` 不论时间一律认，见 §14 R-4）。
- `unlock-ok` 只证明“本次密码验对、本地解锁成功”，不单独证明远程已同步——远程对账仍以 `disarm_ack`＋`revision` 为准。

### boot-recovered 事件（#5）

- **v2 规则**：`recoverAfterRestart()` 走到“`boot_id` 变化且旧态为 `LOCKED`／`LOCKING`”的重启恢复分支时**必写，且只写一次**；写后立即把 `machine.bootId` 更新为当前值并落盘。**不写的情况（有意）**：同 `boot_id` 下的普通状态重核不写；旧态为 `UNLOCKED` 的重启不写；构造期仅检测到 `boot` 变化时不写。
- 事件形：`{ev:'boot-recovered', fields:{marker:'boot-changed', bootId, lockId, previousState}}`。
- 服务端接受两路重启证明：`boot_id` 变化，或 `boot-recovered` 事件且时间 ≥ 本次 `created_at`。
- **过渡期旧设备兜底（#5 冲突统一）**：旧 Go 只在 fail-limit 重启时写 `boot-recovered`，普通重启后不写；C 对旧设备保留时间窗口＋`boot_id` 兜底，**不得把“无 `boot-recovered`”当作“未重启”的唯一依据**。旧 Go 不打补丁、按退役处理。

## §6 revision 与幂等（8 问 #7／#8 的统一口径）

### revision（#7）

- 设备端：每次真实状态变更 `revision + 1`（或取 ACK 传入的更大值）；同态转移不 +1；旧 `revision` 的 ACK 一律拒收（`ACK_STALE_REVISION`）；`setDesired` 不动 `revision`；`buildStatus()` 原样写进 status.json。
- 服务端：设备上报 `revision` 旧于服务端记录 → `RECOVERY_REQUIRED`（`revision-conflict`）；挑战绑定签发时 `revision`，期间变化即挑战失效（桥映射 `revision-stale`，409）；disable 提交校验冻结 `revision`，不一致回 409 `revision-stale`。
- **v2 缺 `revision` 视为异常（P3-04 定夺，B 的建议，本线采纳）**：自称 v2 的设备（status 含 `actual_state`）上报缺 `revision` 或 `revision` 非数字时，服务端视为异常，进 `RECOVERY_REQUIRED`（`revision-missing`），不静默跳过。**v1 设备（无 `actual_state`）仍按“无则跳过”处理。** 该规则 C 代码待 P3-05 实现（见 §14 R-7）。（v2.0.0 勘误 2026-11-19，P3-06：删“或 `version` 主版本 ≥ 2”／“主版本 < 2”判据，见 VERIFY-P3E §3 裁决——旧 Go `ComponentVersion` 同为 2.x，version 判据无法区分 v1 Go 与 v2；仅以 `actual_state` 是否出现为准。）

### 信封去重与操作编号（#8）

- **重复 `disarm` 信封必拒，不执行任何副作用，不改状态，不升 `revision`。** v2 拒绝点：**先查先拒**——`EnvelopeReplayGuard.check` 在一切副作用之前查，重复 id 直接抛 `E_ENVELOPE_REPLAY`，并写 `envelope-rejected{reason:'replay'}` 事件。
- 只有执行成功后才记信封 id；失败的信封不记 id，同一 id 可重试（不算重放）。已处理 id 上限 64 条滚动（与旧 Go `ProcessedEnvelopeIDs` 同口径）。
- 状态机第二道防线：已 `UNLOCKED` 时的 disarm 返回幂等 `disarm_idempotent`，不当故障、不改状态。
- 服务端：操作编号只缓存**成功**结果 24 小时，失败不缓存、同一编号可重试；重复提交返回首次成功结果。操作挑战 5 分钟有效、单次消费，验过即删表。
- 效果一致性口径：旧 Go 第二次仍进 `Disarm` 但无副作用；v2 先查先拒。C 不应依赖设备端拒绝点，只依赖“无重复副作用”这一结果。

### 幂等重放归属鉴权（LOCK-SEC-P3-REPLAY，GPT opStore 定夺 §2，2026-11-19）

- **顺序不变**：`/lock/disable` 内 `opStore.lookup` 仍在挑战校验之前（保留离线重放能力）；但 lookup 只做内部查询，此时不向调用方返回缓存内容或存在性信息。缓存 HIT 时先做独立归属鉴权，通过才返回历史结果；MISS 时走原有挑战校验＋设备机主核对与执行流程。
- **缓存记录绑定可信主体信封**：`{ account_id, device_id, lock_id, operation_type, request_fingerprint, revision, completed_at }`。身份字段只取服务端认证与已验证请求／服务端记录，绝不取客户端原文；`operationId` 仅作识别，不作授权凭证。成功入库时两处写入点（已确认解锁幂等分支／正常成功分支）均带信封。无信封的旧记录（legacy）一律不得直接返回原始成功结果；无法证明归属时拒绝重放内容（可走正常流程重新验证），不猜测所属用户。
- **请求指纹**：`disarm|<device_id>|<lock_id>`（纯函数 `fingerprintDisableRequest`）。不含 revision（重放带冻结旧 revision）与登录密码 presence（重试可省略密码）。
- **每次缓存命中重新确认当前权限（六项）**：①当前登录账号有效且有权查看；②记录账号与当前账号一致；③当前账号仍拥有设备有效归属或明确授权；④请求的 device_id、lock_id、操作类型与缓存记录一致；⑤request_fingerprint 一致；⑥封禁／权限撤销／设备转移后旧编号失效。
- **归属权威**：服务端独立权威设备绑定台账（K1 机制，`<lea 数据目录>/lea/bindings.json`，每次查询重读、无进程内缓存）。归属判断不依赖设备在线；台账不可用（读不到／解析失败／注入查询抛错）时 fail-closed——永不无鉴权返回缓存结果，按 MISS 继续走正常流程。台账里无此设备绑定亦拒绝重放。
- **拒绝策略**：非机主命中（旧记录／账号不符／无绑定／非机主／绑定非 ACTIVE／台账不可用）一律按 MISS 继续（挑战校验 → 设备机主核对），响应与真实 MISS 逐字节一致（同为 409 `challenge-required`，不含 lockState／revision／replayed），不泄露编号是否存在。同一编号用于不同请求参数（换设备／换锁实例／换操作类型／指纹不符）时，机主可见 409 `operation-conflict`（仅机主可达本分支：账号与归属检查已先排除非机主，故不构成存在性预言机）。
- **边界**：历史结果不等于当前锁状态——重放只返回历史结果原文（`{ok, replayed: true, lockState, revision, completed_at}`），不写锁记录、不覆盖服务端当前状态；`completed_at` 为新增附加字段（旧客户端忽略未知字段可兼容，P03-11 只断言子集字段）。并发重放不产生第二次操作：同一编号同一账号两次并发只有一次实际执行，第二次等待或读最终结果；首次尚在执行不得返回伪造已成功；同一编号不同请求参数拒绝冲突。
- **回归门**：SEC-01～SEC-12（见 `server/friends/test-lock-opstore-b.js`）12/12 PASS 方可放行；另重跑 P03-11、disable 首次执行与挑战校验、设备离线重放与超时、B/C 协议契约及前端状态更新、受本次修改影响的全部沙箱回归。

### 幂等对账修正（`applyCorrection`）

- 须带 `op_id`（必填）＋ `reason`（必填）；同一 `op_id` 在同一记录的修正审计（`action` 以 `correction:` 开头）里出现过即拒绝（`op-id-replayed`），不产生第二次修正。
- 离开曾锁定态去 `UNLOCKED`：须 `evidence==='strong'`，否则拒绝（`evidence-insufficient`）。弱证据永远不够。
- 保留原记录：原值进 `history`，不删记录、不删文件、不改 `created_at`，`lock_id` 不变；`LOCKED→UNLOCKED` 走两步（revision +2，两步共用同一 `op_id`）。目标态须在转移表内，否则拒绝并说明。

## §7 暂停守卫（G1，裁决 §1）

策略名 `LOCK_REMEDIATION_PAUSE`；统一错误标识 `lock-remediation-paused`；暂停是**写死在代码里的常量守卫，不是运行时开关**——服务重启、进程重建、配置重载都不能清除它。

- 暂停范围：`POST /lock/enable`（阶段 1 四行守卫，响应保持原样：503＋原维护文案，无 code 字段——刻意保留以兼容既有客户端与测试）、`POST /lock/update`（503＋`code: lock-remediation-paused`＋更新专用文案）。**无白名单例外**：站长账号、API 调用者一律拒绝。
- 间接入口：本仓库内无独立的锁更新后台任务／重试队列（全仓 grep 核实：唯一能构造 update 信封并投递的路径就是桥内 `/lock/update` 分支；重试只能以新的 HTTP 请求重进 `handle()`，必撞守卫）。第二道拦截在 `deliverEnvelope()`：`arm`／`update` 信封在暂停期直接抛错，到不了设备。
- 顺序：鉴权＋封禁在先、暂停在后——未登录先 401，不因暂停机制向未授权请求泄露设备存在与否；已登录的拒绝记结构化审计（不含秘密）。
- 挂起事务：暂停是部署时即生效的代码守卫，不存在“暂停生效瞬间正在执行”的跨部署队列；请求内对账循环只在投递成功后运行，暂停期投递永不发生，故无半安装状态。
- 例外（继续可用，保留原有鉴权与审计）：只读状态查询及诊断取证（`GET /lock/devices`、`GET /lock/owner-check`）；已有的紧急停止和受控安全恢复（`/lock/disable`、`/lock/reset` 走正常校验，不被暂停拦截）；经实际设备状态核实的安全解锁；专用的受控修复／回滚流程——以 `POST /lock/repair` **占位**实现（未启用前一律 503 `lock-repair-not-available`，不实现放行逻辑；正式路径须另行实现组件签名、版本与哈希核验、严格授权、审计、回滚方案与明确目标设备范围）。
- 解除规则：与 enable 同步解除，只在阶段 3 集成、阶段 4 真机验收、独立放行审核完成后按统一受控流程解除，任何单线不得自行解禁。

## §8 API 契约

| 接口 | 契约 |
|---|---|
| `GET /lock/challenge?id=&op=disarm[&opId=]` | 须登录＋机主核对；签发前经读路径对账建／取锁记录；回 `{ok, challenge, expiresAt, op, deviceId, lockId, revision}`；`opId` 有则绑定；日志不记挑战值 |
| `GET /lock/devices` | 返回 `lockState, lockId, revision, lastHeartbeat, degraded`；旧字段 `locked, component, version` 不变 |
| `POST /lock/disable` | 顺序：①幂等重放先查（LOCK-SEC-P3-REPLAY：HIT 须先过独立归属鉴权——记录账号／K1 绑定台账／设备／锁实例／操作类型／指纹六项重确认；未通过按 MISS 继续，不泄露 HIT/MISS 差异；同一编号不同参数机主可见 409 `operation-conflict`；旧记录无信封不直接返回原文）；②校验操作挑战（缺／伪造／过期／错绑均 409，带 `code`；revision 绑定不一致映射为 `revision-stale`）；③AI 授权（出示 `agentGrantId` 时另验，单次、15 分钟、单设备、仅 disarm，失败 409 `agent-grant-*`）；④设备实读＋机主核对；⑤校验冻结 `revision`（不一致 409 `revision-stale`）；⑥分级重新认证（§10）；⑦设备已报 `Off` 且有强证据 → 幂等成功；无证明 → 409 `state-conflict`；无记录时仍回 409 `alreadyOff`；⑧成功：记录落 `UNLOCKED`（两步审计），缓存成功结果（带可信主体信封，供重放鉴权）；超时：记录翻 `UNKNOWN`，不缓存，可重试；拒绝：记录进 `RECOVERY_REQUIRED`。成功审计含 `risk／stepUp／agentGrant／op`（不含秘密） |
| `POST /lock/enable` | 行为不变（暂停守卫在前，503 原维护文案）；成功路径加记录落盘 |
| `POST /lock/reset` | 成功后加审计＋`revision+1`（不改状态，用于让进行中的确认重新校验） |
| `POST /lock/update` | 同步冻结：一律 503 `lock-remediation-paused`，0 更新副作用（§7） |
| `POST /lock/repair` | 受控修复发布路径占位：未启用前一律 503 `lock-repair-not-available`；不实现放行逻辑，绝不经此放开通用 `/lock/update` |
| `POST /lock/agent-grant` | 须登录＋机主核对；签发 AI 解锁授权，单设备、仅 disarm、15 分钟内单次有效；回 `{ok, grantId, deviceId, op, expiresAt}`；日志不记 grantId 原文 |
| `POST /lock/agent-grant/revoke` | 须登录；仅本人可撤销自己的授权；回 `{ok, revoked}`（不存在／非本人亦回 `revoked: false`，不泄露授权存在与否） |

错误码（新路径）：`challenge-invalid`（缺／伪造／过期／错绑）、`challenge-revision-mismatch`（内部原因，桥映射为 `revision-stale`）、`revision-stale`、`state-conflict`、`alreadyOff`、`operation-required`、`operation-conflict`（同一操作编号用于不同请求参数，LOCK-SEC-P3-REPLAY）；`step-up-required`（高风险／增强保护缺升级认证，403）；`agent-grant-invalid`／`agent-grant-expired`／`agent-grant-binding-mismatch`（409）；`lock-remediation-paused`（503，enable／update）；`lock-repair-not-available`（503，受控修复占位）；`revision-missing`（v2 缺 revision，见 §6，P3-05 实现后生效）；设备不可达 503 `unreachable`；未登录 401；非机主 403；封禁 403。

## §9 captureExclusion 与降级（8 问 #9 的统一口径）

- **写入时机**：`captureExclusion` 的值**只在会话组件回报时改写**（v2：协调层在 arm 的 ACK 带 `capture_exclusion` 时调用 `setCaptureExclusion()`，或由会话组件 hello 时调用）；每次 `buildStatus()` 写盘时取当前值，**不由 `arm`／`disarm` 顺带改写**；非法值直接抛错，不静默落成 `unknown`。初始值 `unknown`（会话组件未回报前）。
- **`unknown` 语义**：`unknown` = “尚未证实防截取生效”，不是“已生效”，也不是“已失效”。
- **降级映射（收窄后的统一规则）**：`LOCKED`／`LOCKING` 下 `captureExclusion` 非 `active`（`failed-degraded` 或 `unknown`）一律按 `DEGRADED` 对待；**`UNLOCKED` 空闲态不记降级**——没有保护，就没有什么可降级；`UNLOCKED` 下的 `failed-degraded` 同样不记降级。服务端按 `degraded` 字段展示“（保护降级）”时，应以设备端的 `effective_state` 为准，不自行把空闲态的 `unknown` 展开成降级。
- 对外有效状态：`LOCKED`＋降级时报 `DEGRADED`／`FAILSAFE`，绝不只报 `LOCKED`（设备端 `effectiveState()`；服务端 `degraded` 字段经 `GET /lock/devices` 下发，两端面板在状态文案后追加“（保护降级）”）。
- 设备端降级动作（FAILSAFE）：会话组件退出、心跳超时 10s、IPC 断开且重连失败、状态文件损坏、密码失败次数满、重启后旧 `LOCKED` 无法重核确认时，记 `degradation={kind:'FAILSAFE', reason}`，`actual_state` 进 `RECOVERY_REQUIRED`，撤销本次一次性密码，仍可用的会话组件调 Windows 原生 `LockWorkStation` 兜底，上报 `failsafe` 事件（含 `native_lock` 是否成功），控制台显示“隐私保护已降级”，不得继续显示正常 `LOCKED`。

## §10 分级重新认证（裁决 §3）

### 三类解锁场景

| 场景 | 认证要求 |
|---|---|
| 已登录、权限有效、风险正常的设备所有者 | 服务端权限校验＋挑战＋revision＋明确确认，**无需每次重新输密码** |
| 用户自行开启增强保护选项 | 在原有校验上增加登录密码升级认证（走 `mcConnect` 真登录，独立限流 5 次／15 分钟） |
| 身份异常、权限变化、状态冲突或高风险远程解锁 | **必须升级认证或进入受控恢复流程**，无密码／密码错误一律拒绝，绝不降级为普通确认 |

必须触发强化验证的典型情形：账号会话可信度不足、设备归属校验不通过、发生敏感权限变化、会话疑似被盗用，以及针对 `UNKNOWN`／`RECOVERY_REQUIRED` 的恢复请求。当前可判定的 high 信号：服务端锁记录为 `UNKNOWN` 或 `RECOVERY_REQUIRED`。

### 请求链约束

- 有效账号会话＋服务端设备归属与权限校验；所有者与解锁权限由服务端权威记录判断，不信前端传来的角色字段。
- 服务端生成一次性操作挑战：5 分钟有效、单次消费、防重放；绑定 `account_id`／`device_id`／`lock_id`／`revision`／操作类型／`operationId`／已认证会话（`sessionKey`＝请求 Cookie 头的 SHA-256，只存哈希），不得跨账号／跨设备／跨锁实例／跨 revision／跨操作／跨会话复用；绑定失败不消费挑战；revision 不一致单独报 `challenge-revision-mismatch`（桥映射为 `revision-stale`）。
- 退出登录／会话撤销／权限变化后未使用挑战必须失效（`purgeUser` 吊销该账号未用挑战与 AI 授权；登出分支联动）。
- 幂等操作编号与挑战绑定：弹窗打开时生成 `operationId`，取挑战时经 `opId` 参数带上、服务端绑定；提交时编号不符即拒绝。
- 登录密码绝不由 QFLockUI 或控制台自定义窗口采集、记录或传递：升级认证只走已有可信账号认证体系——弹窗密码栏经 `mcConnect` 真登录验证（`loginPassword` 只进内存、不记日志、不落盘）；QFLockUI 不参与。
- Web 会话 CSRF、Cookie、安全来源与重放防护：现状——`qfr_frd` 会话 Cookie 为 `HttpOnly＋SameSite=Lax＋Secure`；锁路由无独立 CSRF token，跨站防护依赖 SameSite＋单次挑战＋revision＋操作编号；重放防护由挑战单次消费＋操作编号成功缓存＋信封 nonce／TTL 承担。**残留**：无独立 CSRF token 是既有姿态；如安全评审要求，须另线加。
- 远程解锁可审计记录（不含秘密）：成功／拒绝审计含 `risk／stepUp／agentGrant／op`；日志绝不含密码、临时验证码、挑战值、grantId 原文。
- 连续快速点击：提交中按钮禁用＋操作编号幂等＋挑战单次消费，实际操作最多执行一次，结果可凭同一编号查询（`replayed: true`）。
- **特别：对 UNKNOWN 设备，不能因为用户重新输入了登录密码就直接改成 UNLOCKED。** 重新认证只证明操作者身份，不证明设备实际锁状态。恢复仍需状态核查和安全操作证据（`disarm` 事件／`boot_id` 变化／`boot-recovered`）。

### AI 直控与 dangerous 权限的自动化请求

- 不得因网页用户选择“免重复输密码”就自动授予代理解锁权限：UI 会话权限与 AI 授权分离，自动化调用方须出示独立授权——`POST /lock/agent-grant`（机主签发，单设备、仅 disarm、15 分钟内单次有效、可撤销）＋提交时 `agentGrantId` 另验；`purgeUser` 按账号吊销。
- **残留（诚实说明）**：当前 HTTP 层没有调用方类型信号，服务端无法从请求本身区分“用户本人”与“AI 代理”；硬性防线是挑战的 `sessionKey` 绑定（UI 会话签发的挑战换个会话即失效）＋授权机制的独立凭证与审计；调用方类型识别须 P3-05／P3-06 在集成层补齐。
- 会话可信度信号残留：`classifyUnlockRisk` 接受 `sessionTrustLow` 输入，但桥当前鉴权层只返回账号名、无独立会话可信度评分，故桥内恒传 false；“会话疑似被盗用”的实际防护由挑战 sessionKey 绑定＋purgeUser 吊销承担。独立会话可信度评分须另线在鉴权层补齐。

### 二次确认弹窗

- 独立弹窗：`body` 直接子节点（Electron）／`#modalRoot` 应用级弹窗层（网页），在列表／视图重渲染范围之外；**无自动过期定时器**。
- 冻结快照：打开时冻结 `device_id`／`lockId`／`revision`＋操作挑战＋操作编号；取挑战后才启用确认按钮；提交中按钮禁用；重复点击不产生第二次真实请求。
- 60 秒刷新测试：弹窗在 60 秒＋12 次面板刷新后仍存活；轮询重渲染不得销毁进行中的确认。
- `revision-stale`：弹窗不消失，显示错误，后台重取设备刷新冻结快照＋取新挑战，保留“状态已变化，已更新为最新状态，请核对后重新确认。”提醒，等用户重新确认。
- 超时／掉线／拒绝：留在弹窗内显示准确错误，**不改写成“未锁定”**。
- Esc：只关弹窗，不关整个窗口。
- `step-up-required` 分支：弹窗不消失，提示在密码栏输入登录密码后重新确认，并聚焦密码栏。
- 成功路径：先刷新设备列表再写“已关闭”提示（不被 `load()` 清掉）。

## §11 过渡期旧设备兜底规则（v1 设备互通矩阵）

旧 Go 设备绝不打补丁，按退役处理；过渡期内服务端按以下规则与旧设备互通：

| v2 能力 | 旧设备现状 | 服务端过渡做法 |
|---|---|---|
| `disarm`／`unlock-ok` 带 `lockId` | 无 `lockId`（`disarm` 只有 `{by}`，`unlock-ok` 字段为 `nil`） | 时间窗口兜底（事件时间 ≥ 本次 `created_at`；`lastEvents` 仅 10 条，误判窗口小但存在） |
| `boot-recovered` 重启恢复必写 | 只在 fail-limit 重启时写 | 时间窗口＋`boot_id` 变化兜底；不得把“无 `boot-recovered`”当作“未重启”的唯一依据 |
| status.json 带 `boot_id`／`session_id`／`sid` | v1 无此三字段 | 以事件时间窗口对账，`boot_id` 变化证明暂不可用 |
| status.json 带 `revision` | v1 无此字段 | “无则跳过”——**仅限 v1 设备**；v2 设备缺 `revision` 按 §6 视为异常 |
| status.json 带 `actual_state` | v1 无此字段 | 回落 v1 `state` 映射（§4） |
| 信封去重先查先拒 | 二次进 `Disarm`、因已 `Off` 无副作用 | 服务端只依赖“无重复副作用”这一结果，不依赖拒绝点 |
| `captureExclusion` 降级限定 | 旧 Go 默认 `"unknown"` | 按 §9 收窄规则：只在 `LOCKED`／`LOCKING` 下记降级；旧设备 `UNLOCKED` 空闲态的 `unknown` 不记降级 |

过渡期结束条件：旧设备退役完成（§12）后，时间窗口兜底方可移除；移除须另行定夺，不得由单线自行去掉。

## §12 旧程序退役与安全迁移（8 问 #10 的统一口径，裁决 §2）

- **措辞定死：“隔离＋另行批准才删”，不用“删除”。** 退役 = 把旧 EXE **移入证据隔离区**（复制＋哈希复核，运行路径下不再有旧 EXE）；彻底删除须另行批准，不在本迁移内执行。
- 暂停期：四个旧二进制 SHA 已清点（`LEGACY_SHA256`：QFLockUI `712a6d89…`、QFLockService `eae8784c…`、qf-lockctl `cdc797a2…`、qf-lockupdater `2fc4bb6d…`）；启动入口 10 条已清单化；产品侧入口均被暂停覆盖（`/lock/enable` 503＋`/lock/update` 冻结）。
- 控制台提示文案（裁决原文，一字不改）：「当前屏幕锁功能因兼容性故障暂停使用。请勿手动运行旧版 QFLockUI.exe。正常远程控制功能不受此项暂停影响。」——**风险告知，不是安全控制的替代品**；拦不住用户双击自有副本。两端控制台暂停期横幅须出示该文案（P3-05 接线，当前 C 侧尚未接线，见 §14 R-10）。
- 接管期七步：验身份 → 保全证据 → 查锁状态 → 清启动引用 → 签名新组件替换 → 按清单退役 → 验安装与回滚。仅当新组件通过阶段 3 集成审核且设备满足安全迁移前置条件，才执行。
- 前置检查（任一不满足即拒绝）：新组件未过集成审核、签名／哈希未过、锁状态 UNKNOWN（D39ABOL）或 RECOVERY_REQUIRED、存在未处理活动保护、转移中、证据不可保存、身份不符、状态文件损坏、要求删状态文件、要求强行改 UNLOCKED。
- **手动运行自有副本技术上无法禁止**；残留扫描只识别与提示（已知 SHA 残留／SHA 不符的疑似副本区分），不夸称能禁。新组件启动失败绝不静默回退旧程序；不允许把旧二进制改名后继续作为正常程序加载。

## §13 D39ABOL 冻结（裁决 §2.3／§4.3）

- 当前记录：锁状态 `UNKNOWN`，298 记录行，4 arm／1 disarm，最后一次 arm 后尚无 disarm 记录；计数只说明日志状态，不能单独证明实际设备仍处于锁定。
- **不批准**自动将 `UNKNOWN` 改为 `UNLOCKED`；**不批准**删除其锁状态文件；**不批准**因为锁 UI 进程曾被关闭就推断已经彻底解锁；**不批准**通过安装新组件强行覆盖未知状态；**不批准**在这台笔记本上再次主动启动旧锁程序测试。
- 设备重新上线后，先进行只读核查和必要的安全恢复，再讨论正式迁移。修正执行须等设备端确认无活跃锁并给出强证据（`disarm`／`unlock-ok` 事件或 `boot_id` 变化／`boot-recovered`）后，带操作编号走 `applyCorrection`。
- 根因无有效挂起 Dump 前仍维持未确认；旧 Go 二进制绝不打补丁。

## §14 契约与代码的差异清单（P3-05 必须闭合，P3-06 复测）

本契约是目标；以下代码尚未按契约实现，P3-05 修代码、P3-06 补断言后方为“代码已对齐”。在闭合前，**#9 保持 FAIL，G4 未全绿**。

| 编号 | 契约要求 | 代码现状 | 归属 |
|---|---|---|---|
| R-9（#9 FAIL） | §9：降级映射只在 `LOCKED`／`LOCKING` 下 | C `degradedFromStatus` 不看实际状态，`UNLOCKED + unknown` 仍记 `DEGRADED`（探针 #9-C2／C3 实测） | P3-05 修、P3-06 验 |
| R-7 | §6：v2 缺 `revision` → `RECOVERY_REQUIRED`（`revision-missing`） | C 当前直接跳过（探针 #7-C2 实测 decision=`confirmed`） | P3-05 修、P3-06 验 |
| F-2 | §4：v2 优先读 `actual_state`，v1 回落 `state` | C `classifyDeviceStatus` 只读 v1 `state`（探针 A-1 实测） | P3-05 修、P3-06 验 |
| F-1 | §1：转移表并集 | B 缺 3 条边（`UNLOCKED → RECOVERY_REQUIRED`、`UNLOCKING → LOCKED`、`UNKNOWN → UNLOCKING`）；C 缺 1 条边（`RECOVERY_REQUIRED → LOCKING`）；C CONTRACT §1 文字表三行须纠正（P3-05 纠正：LOCKING 行漏 UNLOCKED、UNLOCKING 行漏 LOCKED、RECOVERY_REQUIRED 行错写；见 VERIFY-P304 §4） | P3-05 修 |
| R-3 | §5：桥 disable 等待谓词与对账模块同口径（lockId 优先） | 桥 `:1273` 只用时间窗口（`!ev.time` 即通过）；enable 谓词 `:1172` 已按 `armId` | P3-05 修、P3-06 验 |
| R-4 | §5：无 `fields` 的 `unlock-ok` 也须过时间窗口 | C 当前不论时间一律认（`if (!ev.fields) return true`） | P3-05 修 |
| R-6 | §2／§4：身份字段回填在对账出口统一做 | 目前只在 `confirmed` 分支回填 | P3-05 修 |
| R-10 | §12：两端控制台暂停期横幅出示 PAUSE_NOTICE 原文 | C 三处控制台文件 grep 出现 0 次 | P3-05 修、P3-06 验 |
| F-3 | §6：信封去重以 v2 先查先拒为准 | C CONTRACT §9 #8 文字仍写旧 Go 拒绝点 | P3-05 同步改文字 |
| M-1 | 桥掩盖性问题（VERIFY-P3C §4）：`applyCorrection` 失败时桥仍回 200 `UNLOCKED` | 只记录、不由本线修 | P3-06 补断言：失败时桥必须不报成功 |

## §15 密码与解锁（设备端规则，定夺 §4.2／§6）

- 一次性密码只存 scrypt 盐+哈希，明文永不落盘、不进日志。默认有效期 10 分钟（与 arm 信封 TTL 对齐）、最多错 5 次；错满或过期立即撤销。验对即作废，不可复用；远程解除后立即撤销。
- 解锁界面是 QFRemote 自有样式密码框（标题明确写 QFRemote 隐私锁），**不仿冒 Windows 登录界面**。
- 远程解除锁定须经现有账号授权体系；二次确认弹窗、短期操作挑战、幂等请求由 §8／§10 落实，设备端配合 `revision` 校验（过期 `revision` 的 disarm 拒绝，`STALE_REVISION`）与幂等 `disarm_idempotent` 响应。

## §16 远程输入健康与熄屏（定夺 §5／熄屏硬门，契约收录、不属 8 问）

- 输入健康与画面通道完全独立：画面时钟在走 ≠ 输入可用。每次输入操作带 `operation_id`，五段分开记（`ui_event` → `signal_received` → `ush_execute` → `window_target` → `video_feedback`）。`input_status: healthy | degraded | failed | unknown`；`failed`／`degraded` 时控制台必须原样展示“远程输入不可用”，**不得继续显示 Connected**。
- 锁组件退出或会话切换后：重核输入状态（重验会话／SID／调用者身份），不符绝不恢复输入；必要时只重建控制通道（重新握手＋重核），不强制断开整个远程桌面。禁止：放宽 LEA 身份准入、伪造父进程、跨会话注入。低级键盘钩子的注入标志只作诊断线索，不作信任证明。
- 真实熄屏（硬门）：锁定后本地物理显示器熄灭（`SC_MONITORPOWER, 2`）；需本地解锁时经受控唤醒才显示密码界面，唤醒过程绝不暴露被保护桌面；远程操作不唤醒本地显示器；本地 60 秒无操作重新熄屏。**黑屏窗口不算熄屏。** 熄屏后捕获通道是否中断、远程是否持续唤醒本地显示器，以 D39ABOL 硬件类别真机实测为准（当前 BLOCKED）。对确实无法提供完整能力的硬件／Windows 组合，报告“不支持完整隐私熄屏”，不改断言蒙混。

## §17 契约变更规则

- 本契约是唯一版本化锁协议契约；B 的 `wt-p3b/CONTRACT.md`（v2.0.0 草案）与 C 的 `wt-p3c/CONTRACT.md`（v1＋P3-01／P3-03 增补）中与本契约不符处，以本契约为准，P3-05 同步纠正两边文字。
- 契约版本号变更须按本文件开头的兼容性审查逐项判断并写明理由，不得机械改名。字段、状态、转移表、拒绝码的任何变更都须先改契约、再改代码、再补测试，不允许单方修改字段后另一方继续按旧协议运行。
- 本契约不改变以下硬线：暂停未解除前 `/lock/enable` 与 `/lock/update` 绝不放行；D39ABOL 的 `UNKNOWN` 不经强证据不改；旧 Go 二进制绝不打补丁；根因无有效挂起 Dump 前仍维持未确认；不宣布锁 bug 已修好；3.0.0 维持 NO-GO。
