# P3-04 八问 · B 线回答（阶段 3）

- 依据：C 线 `../lockfix-phase2/wt-c/CONTRACT.md` §9（只读参考，未改阶段 2 文件）；GPT 三项定夺 `~/workspace/qfremote/gpt-a16s2-lockfix-3items-ruling-20261119.md` §4.1。
- 工作区：`~/workspace/qfremote/a16-s2-20261118/phase-2-closeout/lockfix-phase3/wt-p3b`，分支 `a16s2-lockfix-p3-b`。
- 记录格式（裁决 §4.1）：每问含原始问题（原文）、B 线答案、C 线确认、冲突情况、源码定位、测试证据、审核结论。
- **C 线确认一栏本线留空，统一写“待 C 线确认”，由 P3-04 另线填。**
- 测试数字均为本轮沙箱实跑（Node v24.22.1），非转述；真机项一律 BLOCKED。

## #3 disarm 事件补 fields.lockId

- **原始问题（原文）：**“`disarm` 事件字段只有 `{by}`，无 `lockId`”——“请 B 线补 `fields.lockId`（与 arm 对称）。补齐前服务端用‘事件时间 ≥ 本次 arm 时间’窗口兜底（`lastEvents` 仅 10 条，误判窗口小但存在）”。
- **B 线答案：**已补。v2 `StatusReporter.recordDisarm(by, lockId)` 写事件 `{ts, ev:'disarm', fields:{by, lockId}}`，与 `recordArm` 的 `{by, armId, lockId}` 对称；缺 `lockId` 时直接抛错，不写一条无法对账的 disarm 事件。协调层 `disarm()` 成功后调 `recordDisarm`；本地密码解锁成功时先写 `unlock-ok` 再走 `disarm`，两事件同属一次解锁、共用同一 `lockId`。服务端对账：有 `lockId` 时优先按 `lockId` 匹配，不再依赖时间窗口。
- **C 线确认：**待 C 线确认。
- **冲突情况：**旧 Go `Engine.Disarm`（`privacy-lock-impl/src/internal/core/engine.go`）写 `disarm` 事件字段只有 `{by: by}`，无 `lockId`——与 C 的现状描述一致。旧 Go 绝不打补丁；v2 新组件补齐后，旧设备在退役前仍发无 `lockId` 事件，C 须保留时间窗口兜底作过渡；v2 设备上线后 C 应优先按 `lockId` 匹配。无契约冲突，只有新旧版本过渡差异。
- **源码定位：**`windows/lock-v2/status-report.js`（`recordDisarm`、`recordArm`）；`windows/lock-v2/lock-coordinator.js`（`disarm()` 成功分支、`unlockWithPassword()`）。提交：本分支 P3-B 提交（见 REPORT.md 附录）。
- **测试证据：**`windows/test/lock-v2-8q-test.js`：`#3-disarm-缺lockId抛错`、`#3-disarm-fields含lockId`、`#3-arm-fields含armId与lockId`、`C1-unlock-ok与disarm均含同一lockId`——实跑 PASS。负向：缺 `lockId` 抛错（不写事件）。
- **审核结论（自评）：**PASS（沙箱逻辑）。跨端对账待 C 线服务端按 `lockId` 匹配后联调复核。

## #4 unlock-ok 的 ts 为 ISO 时间且与 arm 时间可比

- **原始问题（原文）：**“`unlock-ok`（本地输密码解锁）认作强解锁证据”——“服务端已实现；**请 B 线确认** `unlock-ok` 事件的 `ts` 为 ISO 时间且与 arm 时间可比”。
- **B 线答案：**确认。v2 全部事件的 `ts` 均由 `StatusReporter` 统一生成：`new Date().toISOString()`（UTC，毫秒精度，`…T…:…:….000Z` 格式），`arm` 与 `unlock-ok` 同格式、同源时钟，可直接用 `Date.parse()` 比较（字符串本身也是同一格式，字典序即时间序）。`recordUnlockOk(lockId, by)` 另补 `fields.lockId`（旧 Go 的 `unlock-ok` 字段为 `nil`，无 `lockId`；v2 已补，见 #3 同款过渡口径）。调用点：协调层 `unlockWithPassword()` 密码验对后、先写 `unlock-ok` 再走 `disarm`。注意：`unlock-ok` 只证明“本次密码验对、本地解锁成功”，不单独证明远程已同步——远程对账仍以 `disarm_ack`＋`revision` 为准。
- **C 线确认：**待 C 线确认。
- **冲突情况：**无。旧 Go `AuditEvent.Ts` 为 `time.Time`（UTC，JSON 序列化为 RFC 3339），与 v2 的 ISO 格式可比；旧 Go `unlock-ok` 无 `lockId` 字段是版本差异（v2 已补），不影响 `ts` 可比性。
- **源码定位：**`windows/lock-v2/status-report.js`（`nowIso`、`recordUnlockOk`、`appendEvent`）；`windows/lock-v2/lock-coordinator.js`（`unlockWithPassword()`）。
- **测试证据：**`windows/test/lock-v2-8q-test.js`：`#4-ts均为ISO可解析`、`#4-unlock-ok晚于arm且可比`、`#4-unlock-ok-fields含lockId`、`C1-unlock-ok-ts晚于arm-ts`——实跑 PASS（递增时钟注入，`unlock-ok` 的 `ts` 严格晚于 `arm` 的 `ts`）。另有 `#4-秘密字段不进审计`（`password`/`pwHash`/`token` 类键一律丢弃，与旧 Go `audit.go forbiddenKey` 同口径）。
- **审核结论（自评）：**PASS（沙箱逻辑）。服务端按 `lockId`＋时间窗口双重对账待 C 线复核。

## #5 boot-recovered 在重启后恢复锁状态时必写

- **原始问题（原文）：**“`boot-recovered`（重启后恢复）作重启证明”——“服务端已实现；**请 B 线确认**该事件在重启后恢复锁状态时必写”。
- **B 线答案：**确认，但须按 v2 规则精确表述——**在 `recoverAfterRestart()` 走到“`boot_id` 变化且旧态为 `LOCKED`/`LOCKING`”的重启恢复分支时必写，且只写一次**。`StatusReporter.recordBootRecovered({bootId, previousLockId, previousState})` 写事件 `{ev:'boot-recovered', fields:{marker:'boot-changed', bootId, lockId, previousState}}`。不写的情况（有意）：同 `boot_id` 下的普通状态重核不写（那不是重启证明）；旧态为 `UNLOCKED` 的重启不写（无锁状态可恢复）；构造期仅检测到 `boot` 变化时不写（还没重核，不能先宣称恢复）。写后立即把 `machine.bootId` 更新为当前值并落盘，防止下次恢复重复写。
- **C 线确认：**待 C 线确认。
- **冲突情况：**有，必须明确选择统一契约。**旧 Go 与 C 的假设不符**：旧 Go `NewEngine`（`engine.go`）只在 `BootMarker == 'fail-limit-reboot'`（满 5 次失败触发的重启）时写 `boot-recovered`，普通重启后旧 `LOCKED` 待重核时不写。C 的 §9 #5 按“重启后恢复必写”实现，若以旧 Go 设备为准会长期等不到该事件。**统一契约采用 v2 规则**（本问答案）：重启恢复分支必写。旧 Go 不打补丁、按退役处理；过渡期 C 对旧设备仍用时间窗口＋`boot_id` 变化兜底，不得把“无 `boot-recovered`”当作“未重启”的唯一依据。
- **源码定位：**`windows/lock-v2/status-report.js`（`recordBootRecovered`）；`windows/lock-v2/lock-coordinator.js`（`recoverAfterRestart()` 的 `bootId` 变化分支，含更新 `machine.bootId` 防重复）。
- **测试证据：**`windows/test/lock-v2-8q-test.js`：`C3-重启恢复写boot-recovered`、`C3-重启后旧LOCKED置UNKNOWN不谎报`、`C3-重复恢复不再写boot-recovered`——实跑 PASS。负向：重复调用 `recoverAfterRestart()` 不再追加事件；旧态非 `LOCKED`/`LOCKING` 时不写（由分支条件保证，测试 C3 覆盖 LOCKED 情形）。
- **审核结论（自评）：**PASS（沙箱逻辑）。真机重启恢复待阶段 4（BLOCKED）；C 线须确认过渡期兜底口径。

## #6 status.json 补 boot_id / session_id / sid

- **原始问题（原文）：**“`boot_id`／`session_id`／`sid`：status.json v1 无此三字段”——“**新增需求，请 B 线在 status.json 补** `boot_id`（本次启动标识）、`session_id`、`sid`（Windows 会话 SID）；补齐前服务端以事件时间窗口对账，`boot_id` 变化证明暂不可用”。
- **B 线答案：**已补。v2 `status.json`（`StatusReporter.buildStatus()`）字段：`boot_id`（本次启动标识，协调层 `bootId`）、`session_id`（数字会话号，如 `1`）、`sid`（Windows 用户 SID 字符串，如 `S-1-5-21-…`，与 `user_sid` 同值）。**`session_id` 与 `sid` 不是同一个东西，不可互相替代**：前者是会话编号（`WTS` 会话号），后者是用户安全标识符。`session_id`/`sid` 的值取自 arm 时已核验的交互会话（`_connectSessionAgent` 把 `session.sessionId`/`session.userSid` 写进状态机；此前 arm 成功后 `session_id` 仍为 `null`，是本轮 8Q 测试 C1 抓获并已修复的真问题）。`boot_id` 在重启后由 `recoverAfterRestart()` 更新。v1 字段全保留（`state`/`version`/`nodeId`/`ownerUsername`/`devicePublicKey`/`captureExclusion`/`updatedAt`/`lastEvents`），另加 `actual_state`（六态真相）与 `armedAt`。
- **C 线确认：**待 C 线确认。
- **冲突情况：**无实质冲突，需澄清一处定义：C 的 `sid` 指“Windows 会话 SID”，B 按“用户 SID（`userSid`）”实现——会话编号另有 `session_id` 承载，两者并列后无歧义。C 的服务端记录已有 `boot_id`/`session_id`/`sid` 三字段位（C CONTRACT §2），v2 补齐后即可对上；补齐前 C 用时间窗口兜底的口径不变。
- **源码定位：**`windows/lock-v2/status-report.js`（`buildStatus`）；`windows/lock-v2/lock-state.js`（`snapshot()` 含 `sid`/`armed_at`，`LockStateStore.load` 恢复 `armed_at`）；`windows/lock-v2/lock-coordinator.js`（`_connectSessionAgent` 写会话身份，`statusJson()`）。
- **测试证据：**`windows/test/lock-v2-8q-test.js`：`#6-boot_id/session_id/sid齐全`、`#6-sid是用户SID不是会话号`、`C1-statusJson含三身份字段`——实跑 PASS（C1 一度 FAIL，修掉 `session_id` 为 null 的真问题后通过，见 REPORT.md §4）。
- **审核结论（自评）：**PASS（沙箱逻辑）。真机 `boot_id` 生成方式（重启后是否变化）待阶段 4 核对。

## #7 status.revision（每次状态变更 +1）

- **原始问题（原文）：**“`status.revision`（每次状态变更 +1）”——“status.json v1 无此字段；服务端按‘有则校验、无则跳过’实现；**请 B 线确认是否补**”。
- **B 线答案：**确认补，且**阶段 2 即已补，本次是把它写进 status.json**。`LockStateMachine.transition()`：每次真实状态变更 `revision + 1`（或取 ACK 传入的更大值）；同态转移（状态不变）不 `+1`——幂等重放不算一次新状态；旧 `revision` 的 ACK 一律拒收（`ACK_STALE_REVISION`）。`buildStatus()` 把 `revision` 原样写入 status.json，不另设计数器。`setDesired` 不动 `revision`（欲求状态不是实际状态变更）。
- **C 线确认：**待 C 线确认。
- **冲突情况：**无。补充一点供 C 线复核时定夺：v2 设备恒带 `revision` 后，C 的“无则跳过”只应留给旧 v1 设备；v2 设备若上报无 `revision`，应视为异常（建议 C 在 P3-04 复核时明确，不由 B 线单方改服务端）。
- **源码定位：**`windows/lock-v2/lock-state.js`（`transition()`、`applyAck()`）；`windows/lock-v2/status-report.js`（`buildStatus` 的 `revision` 字段）。
- **测试证据：**`windows/test/lock-v2-8q-test.js`：`#7-每次变更revision+1`、`#7-同态转移不升revision`、`#7-revision原样写入`——实跑 PASS。协调层 `STALE_REVISION` 拒绝旧 `revision` 的 disarm 已由阶段 2 测试覆盖（`lock-v2-coordinator-test.js` D 组）。
- **审核结论（自评）：**PASS（沙箱逻辑）。

## #8 重复 disarm 信封必拒

- **原始问题（原文）：**“信封去重：设备端收到重复 `disarm` 信封是否重复执行副作用”——“设备契约 §4 有 `E_ENVELOPE_REPLAY`；**请 B 线书面确认**重复信封必拒。服务端侧已加 operationId 去重，信封级重放即使到达设备，状态检查（须 `Locked`）也会挡住第二次生效”。
- **B 线答案：**书面确认：**重复信封必拒，不执行任何副作用，不改状态，不升 `revision`**。v2 实现两道防线：① 信封级：`EnvelopeReplayGuard`（`check` 先查 → `remember` 只在成功后记），重复 id 直接抛 `E_ENVELOPE_REPLAY`，并写 `envelope-rejected{reason:'replay'}` 事件；已处理 id 上限 64 条滚动（与旧 Go `ProcessedEnvelopeIDs` 同口径）；失败的信封不记 id，同一 id 可重试（不算重放）。② 状态机级：已 `UNLOCKED` 时的 disarm 返回幂等 `disarm_idempotent`，不当故障、不改状态。协调层 `disarm(opts.envelopeId)` 在一切副作用之前先查守卫。
- **C 线确认：**待 C 线确认。
- **冲突情况：**最终效果一致，拒绝点不同，统一契约以 v2 为准。旧 Go `ProcessEnvelope` 也是重放先查、成功后才记（`remember()` 只在 `r.OK` 时调用），但注意一个细节：旧 Go 的 `Disarm` 在已 `Off` 时返回 `CodeAlreadyInState`（`OK=false`），故第一次“已解锁的 disarm”不记 id；第二次相同信封会再次进入 `Disarm`，仍因已 `Off` 而无副作用。v2 改为“先查先拒”，第二次连 `Disarm` 都不进。两种做法都不产生重复副作用，但 v2 的拒绝更早、审计更明确（`envelope-rejected` 事件可查）。C 不应依赖设备端拒绝点，只依赖“无重复副作用”这一结果。
- **源码定位：**`windows/lock-v2/envelope-replay.js`（`EnvelopeReplayGuard`，`CODE_REPLAY='E_ENVELOPE_REPLAY'`）；`windows/lock-v2/lock-coordinator.js`（`disarm()` 开头的去重检查与成功后 `remember`）；旧 Go 对照：`privacy-lock-impl/src/internal/core/envelope.go`（`ProcessEnvelope`，只读参考，未改）。
- **测试证据：**`windows/test/lock-v2-8q-test.js`：`#8-首次不重放`、`#8-重复必拒`、`#8-未记过的id可执行`、`#8-上限64条滚动`、`C2-首次disarm成功`、`C2-重复信封拒E_ENVELOPE_REPLAY`、`C2-重复信封不改状态不升revision`、`C2-重放记envelope-rejected事件`——实跑 PASS。负向：重复信封抛错且 `revision` 不变；失败不记 id（守卫只在 `remember()` 时记，协调层只在成功分支调用）。
- **审核结论（自评）：**PASS（沙箱逻辑）。服务端 operationId 去重与设备端信封去重的双端一致性待 P3-06 联调。

## #9 captureExclusion 的写入时机与 unknown 语义

- **原始问题（原文）：**“`captureExclusion=failed-degraded` 时面板提示‘保护降级’”——“服务端已下发 `degraded` 字段，两端面板已显示；**请 B 线确认**该字段的写入时机与 `unknown` 的语义”。
- **B 线答案：**确认，分两点。① **写入时机**：`captureExclusion` 的值只在会话组件回报时改写（旧 Go：`qflocksvc handlePipeConn` 的 `hello` 请求带 `Affinity` → `SetCaptureExclusion` → 写盘；v2：`StatusReporter.setCaptureExclusion()`，由协调层在 arm 的 ACK 带 `capture_exclusion` 时调用，或由会话组件 hello 时调用）；每次 `buildStatus()` 写盘时取当前值，不由 `arm`/`disarm` 顺带改写；非法值直接抛错，不静默落成 `unknown`。② **`unknown` 语义**：`unknown` = “尚未证实防截取生效”，不是“已生效”，也不是“已失效”。`LOCKED`/`LOCKING` 下 `captureExclusion` 非 `active`（`failed-degraded` 或 `unknown`）一律按 `DEGRADED` 对待（与 C 线 CONTRACT §1“`failed-degraded`|`unknown` 记 `DEGRADED`”一致）；未锁定（`UNLOCKED`）时不记降级——没有保护，就没有什么可降级。对外有效状态：`LOCKED`＋降级时报 `DEGRADED`/`FAILSAFE`，绝不只报 `LOCKED`（`LockStateMachine.effectiveState()` 已实现）。
- **C 线确认：**待 C 线确认。
- **冲突情况：**无实质冲突，口径收窄一处：C 的 §1 把 `unknown` 一律记 `DEGRADED`，B 确认该映射，但限定在 `LOCKED`/`LOCKING` 下；`UNLOCKED` 空闲态的 `unknown` 只是“尚未评估”，不产生降级标记。服务端按 `degraded` 字段展示“（保护降级）”时，应以设备端的 `effective_state` 为准，不自行把空闲态的 `unknown` 展开成降级。
- **源码定位：**`windows/lock-v2/status-report.js`（`setCaptureExclusion`、`degradedFor`、`buildStatus`）；`windows/lock-v2/lock-coordinator.js`（`setCaptureExclusion()`、`arm()` 的 ACK 处理）；`windows/lock-v2/lock-state.js`（`effectiveState()`、`markDegraded()`）；旧 Go 对照：`privacy-lock-impl/src/internal/core/engine.go`（默认 `"unknown"`，`SetCaptureExclusion`）、`status.go`（`Snapshot` 原样写出）。
- **测试证据：**`windows/test/lock-v2-8q-test.js`：`#9-初始unknown`、`#9-非法值抛错`、`#9-unknown下LOCKED判DEGRADED`、`#9-unknown下UNLOCKED不判降级`、`#9-failed-degraded判DEGRADED`、`#9-active不降级`——实跑 PASS。阶段 2 已有 `display_power_ok=false` 时记 `DEGRADED` 的协调层测试（`lock-v2-coordinator-test.js` F 组）。
- **审核结论（自评）：**PASS（沙箱逻辑）。真机上 `captureExclusion` 的实际回报值（会话组件是否真能测防截取）待阶段 4（BLOCKED）。

## #10 旧 QFLockUI.exe 本地手动运行路径

- **原始问题（原文）：**“旧 `QFLockUI.exe` 本地手动运行路径”——“服务端封不住（见 REPORT.md §6）；**请 B 线确认**新组件安装时删除／替换旧程序的方案”。
- **B 线答案：**与工作内容 1（P3-02）同一份方案，见 `windows/lock-v2/legacy-retirement.js` 与本工作区 `REPORT.md` §2。纠正一处措辞：**“删除”改为“隔离＋另行批准才删”**——裁决不批准在取证／状态确认前直接删除旧 EXE，本线退役步骤是把旧 EXE **移入证据隔离区**（复制＋哈希复核，运行路径下不再有旧 EXE），彻底删除须另行批准，不在本迁移内执行。暂停期：清点四个旧二进制 SHA 与 10 条启动入口，产品侧入口均被暂停覆盖（`/lock/enable` 503＋`/lock/update` 冻结，P3-01）；控制台提示文案用裁决原文，一字不改。接管期：仅当新组件通过阶段 3 集成审核且设备满足安全迁移前置条件，才按七步计划执行（验身份 → 保全证据 → 查锁状态 → 清启动引用 → 签名新组件替换 → 按清单退役 → 验安装与回滚）。D39ABOL 前置检查任一不满足即拒绝迁移（UNKNOWN、删状态文件、强行改 UNLOCKED、证据不可保存、身份不符等 13 项拒绝码，见 `checkMigrationPreconditions`）。手动运行自有副本在技术上无法禁止——提示文案是风险告知，不是安全控制的替代品；残留扫描只识别与提示，不夸称能禁。
- **C 线确认：**待 C 线确认。
- **冲突情况：**无。C 的“服务端封不住”与 B 的“提示＋退役”一致；“删除／替换”的原文措辞按裁决 §2.2 收窄为“隔离（非删除）＋签名替换”，已在答案中明确。
- **源码定位：**`windows/lock-v2/legacy-retirement.js`（`LEGACY_SHA256`、`PAUSE_NOTICE`、`LEGACY_START_ENTRIES`、`checkMigrationPreconditions`、`planMigration`、`executeMigration`、`scanLegacyCopies`）。
- **测试证据：**`windows/test/lock-v2-retirement-test.js` 38/38 实跑 PASS（暂停文案原文比对、四文件 SHA 与树内副本实测一致、入口清单、前置检查 13 项拒绝、七步计划顺序、正常迁移全过、安装失败与验证失败均回滚且不启动旧锁 UI、残留扫描已知／未知副本区分）。真机安装／替换／回滚一律 BLOCKED（不在任何真机上安装或替换组件）。
- **审核结论（自评）：**PASS（沙箱逻辑）。真机迁移待阶段 4；G2 硬门（迁移、回滚、UNKNOWN 保护、证据保全均有验证）在沙箱侧已闭合，真机侧仍 BLOCKED。
