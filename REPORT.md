# P3-06 完整回归报告：沙箱及隔离环境回归＋#9 改判复测＋契约 §6 勘误

- 执行线：锁 bug 修复阶段 3 · P3-06 完整回归执行人
- 时间：2026-11-19 06:3x–07:2x CST
- 分支：`a16s2-lockfix-p3-r6`，工作树 `lockfix-phase3/wt-p3f`，基线 `dc3231d`（P3-05 集成提交）
- 依据：GPT 三项定夺 `~/workspace/qfremote/gpt-a16s2-lockfix-3items-ruling-20261119.md`；`LOCK-PROTOCOL-CONTRACT.md` v2.0.0；VERIFY-P3E（协调人验盘，含 §3 R-7 口径裁决）／VERIFY-P304／VERIFY-P3C §4（M-1）
- 本报告每个数字均注明实跑（本轮实际执行有输出为证）或转述（引用他人已记录的结果，未经本轮复核）

## 结论先行

1. **#9 正式改判为 PASS**（本线拥有改判权，复测全过为前置——已满足）。依据见 §2：`test-lock-p3e.js` R9-1～R9-7 全过；P3-04 探针改指集成树、#9-C1 改为一致上报后，#9 八项（B1–B4、 C1–C4）全部 PASS；代码位置 `server/friends/lock-state.js:276-281`（`degradedFromStatus` 只在 LOCKED／LOCKING 下映射降级）＋ `:301`／`:311` 两处调用点均传对账后实际状态。
2. **契约 §6 勘误已执行**（VERIFY-P3E §3 裁决）：`CONTRACT.md:131` 一行，删“或 `version` 主版本 ≥ 2”／“主版本 < 2”两处判据，版本号仍为 v2.0.0（勘误，不升版）；R7 相关断言复核全过（§1）。
3. **回归全量实跑通过**：去重合计 **733 项全过**（P3-05 口径 698 项＋本线新增补测 `test-lock-p3f.js` 35 项）；另网页端门禁 `run.mjs` 5/5。唯一例外是 `ipc-sender-test.js` 的 3 项失败，与基线 `46e39f2` 完全相同、非回归（§4）。
4. **M-1 已修桥（本线定夺：修）**：修复前断言实证 FAIL——`applyCorrection` 失败时桥回 200 `UNLOCKED`、记录卡 UNLOCKING、假成功还被 `opStore` 缓存；修复后 F-B1 PASS，全部回归重跑全过。理由与改动见 §5。
5. **附带修复一项**（补测中发现、与 M-1 同一函数内）：`/lock/disable` 已报 Off 分支的幂等判定只认 `decision === 'to-unlocked'`，标准流程里前置读路径已凭强证据把记录翻成 UNLOCKED（decision `'confirmed'`）时会被误判 409；已放宽为 `'to-unlocked' 或 'confirmed'`＋强证据＋记录已是 UNLOCKED（弱证据／非 UNLOCKED 仍拒绝）。F-A2／F-A3 由此通过，全部回归重跑全过。理由与改动见 §5。
6. **不宣布锁 bug 已修好；隐私锁仍是 P0，3.0.0 维持 NO-GO。** `/lock/enable` 与 `/lock/update` 暂停原样在位，未解除；未碰 D39ABOL；旧 Go 二进制未打补丁、未改原文、未删除（SHA 与 P3-05 一致，§4）；根因无有效挂起 Dump 前仍维持未确认。
7. **注入样本 0 条**：本线执行期间未撞见疑似提示词注入（`wt-p3f` 内未新建 `injection-samples/`，因无样本可存）。

## §1 契约 §6 勘误（协调人已裁决，执行＋复核）

| 项 | 内容 |
|---|---|
| 改动 | `CONTRACT.md:131` 一行（`git diff` 仅此 1 行）：自称 v2 的设备判据由“status 含 `actual_state`，或 `version` 主版本 ≥ 2”改为“status 含 `actual_state`”；v1 设备由“无 `actual_state`、主版本 < 2”改为“无 `actual_state`”。行尾加括号注明“v2.0.0 勘误 2026-11-19，P3-06”与裁决依据（VERIFY-P3E §3） |
| 版本 | 仍为 v2.0.0，不升版（勘误） |
| 复核（实跑） | `test-lock-p3e.js` 35/35 全过，内含 R7-1～R7-4：v2 缺 revision→`to-recovery`／`revision-missing`；v2 带 revision→confirmed；v1 缺 revision（`version: '2.4.5'`）→仍跳过；v2 revision 非数字→判异常。另 P3F F-C1（旧 Go `version: '2.0.3'`、无 `actual_state`、无 revision，读路径不判 v2 缺 revision）、F-C2（v2 缺 revision → HTTP 级进 `RECOVERY_REQUIRED`）、F-C3（v2 revision 非数字 → `revision-missing`）全部 PASS |
| 全树残留检查（实跑） | `grep "主版本" CONTRACT.md`：仅勘误括号内引用被删措辞本身一处（记录删除内容），正文判据已无 version 口径 |

## §2 #9 改判复测（本线改判权，复测全过为前置）

### 改判结论：**#9 由 FAIL 改判为 PASS**

### 改判依据

| 证据 | 结果（实跑） |
|---|---|
| `test-lock-p3e.js` 全套（35/35） | R9-1～R9-7 全过：LOCKED＋unknown→DEGRADED、UNLOCKED＋unknown→null（原 #9-C2 FAIL 点）、UNLOCKED＋failed-degraded→null（原 #9-C3 FAIL 点）、LOCKING＋unknown→DEGRADED、LOCKED＋active→清除降级、LOCKED＋failed-degraded→DEGRADED、v2 一致上报 LOCKED＋unknown→DEGRADED（R9-7） |
| P3-04 探针改指集成树重跑（`/tmp/p3f-probe-8q.js`，5 处 require 改指 `wt-p3f`，#9-C1 改为一致上报） | **40 PASS／4 FAIL**；#9 八项（B1–B4、C1–C4）**全部 PASS**，其中 #9-C1（`state: 'Locked'`＋`actual_state: 'LOCKED'`＋`captureExclusion: 'unknown'`）实测 `degraded=DEGRADED`，#9-C2／C3 实测 `degraded=null`。探针原文在 `p3-04/`，本线未改；改指副本在 `/tmp`，不入库 |
| 代码位置 | `server/friends/lock-state.js:276-281`：`degradedFromStatus(status, actualState)`——`actualState !== 'LOCKED' && !== 'LOCKING'` 即返 null，只在 LOCKED／LOCKING 下映射 `unknown`／`failed-degraded` → `DEGRADED`；`:301`（出口统一刷新）与 `:311`（内层 `applyDegraded`）均传对账后实际状态 `next.actual_state`／`r.actual_state` |
| 探针 4 处 FAIL 的解释（全部为预期断言翻转，非回归） | T-C1（`RECOVERY_REQUIRED→LOCKING` 现合法，F-1 已修）、T-B1（`UNLOCKED→RECOVERY_REQUIRED` 现合法，F-1）、T-B2（`UNLOCKING→LOCKED` 现合法，F-1）、A-1（C 现按 `actual_state` 判 LOCKED，F-2 已修）。4 项均为探针断言写的是修复前旧行为，修复后断言翻转；探针其余 40 项（含 #7-C2 决策变为 `to-recovery`、#4-C3 仍 PASS、#6-C2 仍 PASS）均与预期一致 |

### §14 其余八项同步复测（无回归，实跑）

`test-lock-p3e.js` 35/35 覆盖全部：R-7（R7-1～R7-4）、F-2（F2-1～F2-6，含探针 A-1 原缺口）、F-1（F1-1～F1-6＋`lock-v2-state-test.js` E1–E4）、R-3（R3-1～R3-6）、R-4（R4-1～R4-3）、R-6（R6-1～R6-2）、R-10（R10-1 服务端侧＋Electron M0p＋网页横幅断言，见 §4）、F-3（契约文字：集成 `CONTRACT.md` §6 已是 v2 先查先拒，C 旧 §9 #8 描述无残留——本轮 `grep` 复核，集成树内无“状态检查（须 `Locked`）也会挡住第二次生效”字样）。

## §3 补测（`server/friends/test-lock-p3f.js`，新增，35/35 PASS，实跑）

做法：本地假 MeshCentral control 通道（ws 服务端，userinfo／nodes／runcommands 三语义，status.json Base64 回传；disarm 信封投递＋apply 后翻 Off＋补事件），全程实跑 `/lock/disable` 真分支；另有纯函数级断言。两台假设备：node-1＝v2（`actual_state`／`revision`／lockId 事件），node-2＝旧 Go（无 `actual_state`／无 revision／`version: '2.0.3'`／无 lockId 事件）。整文件约 50 秒（含 F-B2 实跑 30 秒对账窗口）。

| 编号 | 内容 | 结论 |
|---|---|---|
| F-00 | 假通道就绪：GET /lock/devices → 200 两台机主设备 | PASS |
| F-A1 | 跨端集成：v2 disarm 事件（含 lockId）走完整 `/lock/disable` → 200 UNLOCKED，记录落 UNLOCKED，inbox 1 次、apply 1 次 | PASS |
| F-A2 | 跨端集成：v2 unlock-ok 事件 → 200 alreadyUnlocked、0 信封投递 | PASS |
| F-A3 | 跨端集成：v2 boot-recovered 事件 → 200 alreadyUnlocked、0 信封投递 | PASS |
| F-A4 | 服务端 operationId 去重：同 opId＋新挑战重提交 → 200 replayed、无第二次投递 | PASS |
| F-A5 | 设备端信封去重：同一信封 id 第二次 check → replay＋`E_ENVELOPE_REPLAY`，64 条滚动 | PASS |
| F-A6 | 旧 Go 设备无 lockId 事件走时间窗口兜底 → 200 UNLOCKED | PASS |
| F-A7 | 混跑不串扰：node-1 解锁不碰 node-2 记录，两台各自独立落 UNLOCKED | PASS |
| F-B1（M-1） | applyCorrection 失败时桥不报成功：预置同 opId 修正审计 → 409 state-conflict、记录仍 UNLOCKING、op 未缓存 | PASS（修复后；修复前实证 FAIL，见 §5） |
| F-B1b | applyCorrection 单元：重放／弱证据／未知态均 ok:false，强证据正常修正 ok:true | PASS |
| F-B2 | 失败注入·超时：设备不响应 → 504、记录 UNKNOWN、op 未缓存（实跑 30 秒窗口） | PASS |
| F-B3 | 失败注入·拒绝：设备拒收信封 → 409、记录 RECOVERY_REQUIRED、op 未缓存 | PASS |
| F-B4 | 失败注入·revision 冲突：提交 revision 与服务端不一致 → 409 revision-stale | PASS |
| F-B5 | 失败注入·挑战过期（单元级，注入时钟）：5 分钟后 → challenge-expired | PASS |
| F-B6 | 失败注入·挑战重放：消费过的挑战再提交 → 409 challenge-invalid | PASS |
| F-B7 | 失败注入·会话撤销后重放：purgeUser 后旧挑战提交 → 409 | PASS |
| F-C1 | 旧新兼容：旧 Go（version 2.0.3、无 actual_state、无 revision）读路径不判 v2 缺 revision | PASS |
| F-C2 | 旧新兼容：v2 缺 revision → HTTP 级进 RECOVERY_REQUIRED | PASS |
| F-C3 | 旧新兼容：v2 revision 非数字 → revision-missing（单元级） | PASS |
| F-C4 | 旧新兼容：旧设备 status 永远不带 actual_state（version 2.x 不是 v2 判据） | PASS |
| F-D1 | 暂停守卫：普通用户 enable → 503、0 副作用 | PASS |
| F-D2 | 暂停守卫：普通用户 update → 503 lock-remediation-paused、0 副作用 | PASS |
| F-D3 | 暂停守卫：站长账号 enable/update 暂停期仍拒绝（无白名单例外） | PASS |
| F-D4 | 暂停守卫：重试 update/enable＋静置 1.5 秒仍 0 副作用（无后台任务偷跑） | PASS |
| F-D5 | 暂停守卫：重启（新桥实例）后 enable/update 仍 503，锁记录从文件重载一致 | PASS |
| F-D6 | 暂停守卫：只读诊断 GET /lock/devices 正常可用（200） | PASS |
| F-E1 | 鉴权负向：未登录 enable/disable → 401 | PASS |
| F-E2 | 鉴权负向：非机主取挑战 403、设备列表为空、持机主挑战提交仍 409 | PASS |
| F-E3 | 鉴权负向：伪造挑战 → 409 challenge-invalid | PASS |
| F-E4 | 鉴权负向：跨设备挑战 → 409 | PASS |
| F-E5 | 鉴权负向：跨会话提交 → 409 | PASS |
| F-E6 | 鉴权负向：错操作编号 → 409 | PASS |
| F-E7 | 鉴权负向：revision 变化后旧挑战提交 → 409 revision-stale | PASS |
| F-E8 | 鉴权负向：增强保护缺登录密码 → 403 step-up-required；带正确密码 → 200 | PASS |
| F-E9 | 鉴权负向：UNKNOWN 正常路径不直接清状态——缺密码 403、有密码仍 409、记录永不落 UNLOCKED | PASS |

**补测小计：35/35 PASS，0 FAIL，0 BLOCKED。**

## §4 完整回归总表（全部本轮实跑，Node v24.22.1）

| 套件 | 结果 | 备注 |
|---|---|---|
| A 诊断 `tests/session-ipc-checks.py` | **53/53 PASS** | 与阶段 2 一致 |
| B `lock-v2-state-test.js` | **18 cases PASS** | 阶段 2 的 14 项＋P3-05 F-1 新增 E1–E4 |
| B `lock-v2-ipc-test.js` | **7 PASS** | |
| B `lock-v2-input-health-test.js` | **15 PASS** | |
| B `lock-v2-password-test.js` | **8 PASS** | 终端输出被展示层脱敏为 `<redacted>`；以 exit 0＋`ok(` 8 处为准 |
| B `lock-v2-coordinator-test.js` | **19 PASS** | |
| B `lock-v2-fault-injection-test.js` | **13 PASS** | |
| B 小计（阶段 2 新测试） | **80/80** | |
| B `lock-v2-8q-test.js` | **38 cases，pass: true** | |
| B `lock-v2-retirement-test.js` | **38 cases，pass: true** | |
| 既有 `windows/test/lock-test.js` | **26 cases，pass: true** | C 版（含 C6c） |
| C `server/friends/test-lock-state.js` | **59 passed，0 failed** | 原 58＋A4b 新增 1 |
| C `server/friends/test-lock-bridge.js` | **66 passed，0 failed** | |
| C `server/friends/test-lock-bridge-c.js` | **9 passed，0 failed** | |
| C `server/friends/test-lock-envelope.js` | **18 passed，0 failed** | |
| C `server/friends/test-logic.js` | **31 过／0 挂** | |
| C `server/friends/test-lock-p3c.js` | **71 passed，0 failed** | P3-01 十项＋P3-03 十二项未受本线改动影响 |
| C `server/friends/test-lock-p3e.js`（P3-05 新增） | **35 passed，0 failed** | §14 九项逐项断言（含 R9-1～R9-7） |
| C `server/friends/test-lock-p3f.js`（本线新增） | **35 passed，0 failed** | §3 补测 |
| C 服务端小计 | **324** | 59+66+9+18+31+71+35+35 |
| Electron `windows/test/lock-confirm-test.js` | **12 passed，0 failed** | |
| Electron `windows/test/lock-modal-dom-test.js` | **26 passed，0 failed** | 含 M0p（R-10 DOM 断言） |
| 网页 `server/webapp/tests/unit/` 全套 | **47 passed，0 failed** | 含 `lock-confirm-web.test.mjs` 的 R-10 横幅断言 |
| 网页 `server/webapp/tests/run.mjs` | **5/5 PASS** | 首轮 2 步 FAIL 仅因本工作树缺 `acorn`（环境缺件，与 P3-05 同款；按 C 线做法在 `tests/node_modules/` 内 `npm install --no-save acorn` 后 5/5 全绿；该目录 gitignored，未入库） |
| A16-S2 `windows/test/lea-login-retry-test.js` | **50/50 PASS**（`pass: true`，`failed: []`，`ok(` 50 处） | |
| A16-S2 `windows/test/test-mode-gates-test.js` | **39 cases，pass: true** | |
| **去重合计** | **733 项断言全过**（53+80+38+38+26+324+12+26+47+50+39；`lock-test.js` 26 只计一次；另 `run.mjs` 5 步全过） | P3-05 口径 698＋本线补测 35 |
| `node --check` | **通过**：`lock-bridge.js`、`test-lock-p3f.js`、`lock-state.js`、B `lock-state.js`、`lock-modal-dom-test.js`、`app-7005a01d.js`、`test-lock-p3e.js`、`test-lock-state.js` | 全部新／改 JS 文件 |
| 静态 grep 审计 | **通过**：暂停守卫在位（enable 503／update 503 `lock-remediation-paused`／投递层 arm/update 拦截）；`windows/main.js` 的 `testDenied` 仍为 5 处（IS_TEST 门禁未动）；锁日志不含挑战／密码／授权原文（`log('lock', …)` 逐条 grep：挑战签发只记 op 与 5 分钟有效期，失败只记 `fin.reason` 与状态） | |
| 旧 Go 二进制未动 | `git diff dc3231d -- windows/privacy-lock/app/` 为空；四文件 SHA 与 P3-05 一致：QFLockUI `712a6d89…dbc84a`、QFLockService `eae8784c…4206e`、qf-lockctl `cdc797a2…596b4`、qf-lockupdater `2fc4bb6d…07290` | |
| `windows/test/ipc-sender-test.js` | **3 项失败，与基线相同，非回归**：`E1_registered_36_29`、`E2_registered_total_65`、`E6_table_65_keys`（VERIFY-P3C 已证实基线 `46e39f2` 同款失败；本线未碰 `windows/main.js` 的 IPC 注册） | |

## §5 本线代码改动（两处，均在 `server/friends/lock-bridge.js`）与定夺

### ① M-1：applyCorrection 失败时桥不报成功（本线定夺：修）

- **修复前实证（FAIL，本轮实跑）**：补测 F-B1 在修复前跑出 `status: 200, json: {ok: true, lockState: 'UNLOCKED', revision: 2}`，而服务端记录实际仍为 `UNLOCKING`，且假成功已被 `opStore` 缓存（`lookup(op-m1)` 非空）——同一编号重试永远返回假成功。单元级 F-B1b 同时证实 `applyCorrection` 本身正确返回 `ok: false`（`op-id-replayed`），掩盖发生在桥的响应层。
- **修的理由**：① VERIFY-P3C §4 明确定夺 P3-06 须补此断言，断言证实的是真实掩盖性 bug，不是测试吹毛求疵；② 影响真实：控制台会误以为设备已解锁而停止跟进，记录却卡在 UNLOCKING，且缓存的假成功使重试无法自愈；③ 改动极小（一个分支，6 行有效代码），不碰暂停守卫、状态机、挑战与认证语义；④ 已用全部回归重跑验证（P3C 71／P3E 35／P3F 35 全过）。
- **改动**：`/lock/disable` 成功分支末尾，`applyCorrection` 返回后先判 `fin.ok`：失败且当前记录不是 `UNLOCKED` 时记日志（含 `fin.reason`，不含挑战／密码原文）并回 409 `state-conflict`、不缓存操作编号（可重试）；记录若已是 `UNLOCKED`（此前修正已落地，幂等）仍报成功。失败路径不产生任何设备副作用（信封早已投递、对账已过，只是不谎报结果）。
- **修复后**：F-B1 PASS（409 state-conflict、记录仍 UNLOCKING、op 未缓存）；F-B1b 单元 PASS。

### ② `/lock/disable` 已报 Off 分支幂等判定补全（补测中发现，同函数内，顺手修）

- **问题**：标准流程（读设备→取挑战→提交）里，前置 `GET /lock/devices` 或取挑战时的 `reconcileFromRead` 已凭强证据（unlock-ok／boot-recovered 事件）把记录翻成 UNLOCKED（decision `'confirmed'`），提交时旧条件只认 `decision === 'to-unlocked'`，会把已确认解锁误判为 409 `alreadyOff`。F-A2／F-A3 初版即因此 FAIL（409 alreadyOff）。
- **改动**：幂等条件放宽为 `(decision === 'to-unlocked' || decision === 'confirmed') && evidence === 'strong' && record.actual_state === 'UNLOCKED'`。弱证据或非 UNLOCKED 记录仍走原拒绝路径（不放宽：从未锁定过的设备＋弱证据仍 409 alreadyOff；无证明的 Off 上报仍进 `to-recovery`→409 state-conflict）。
- **验证**：F-A2／F-A3 PASS；P3C 71／P3E 35／全部回归重跑全过，无既有测试钉死旧行为（`grep alreadyOff` 在三套既有测试中 0 命中）。

### 改动范围汇总

| 文件 | 改动 |
|---|---|
| `CONTRACT.md` | §6 勘误 1 行（§1） |
| `server/friends/lock-bridge.js` | ＋17／−1：M-1 分支（§5①）＋幂等判定补全（§5②），均在 `/lock/disable` 分支内 |
| `server/friends/test-lock-p3f.js` | 新增（35 项补测，§3） |

## §6 观察与提醒（不阻塞本轮收口，请协调人定夺）

1. **假设备建模教训（已在本线测试内纠正）**：真实 v2 设备 disarm 走两步（`lock-coordinator.js:254` transition UNLOCKING ＋ `:259` applyAck UNLOCKED），revision 共 +2，与服务端 `applyCorrection` 的两步 +2 对齐；假设备初版只 +1，导致下次读触发 `revision-conflict`（F-A7 初版 FAIL 的根因，产品代码无责）。本地解锁（unlock-ok／boot-recovered）同样按两步 +2 建模。以后写 v2 假设备须按此口径，否则会误报 revision 冲突。
2. **opStore 幂等重放在机主核对之前返回（既有设计，本线未改）**：补测 F-E2 重构时发现——已成功的操作编号重提交时，桥在 `getDeviceOrFail` 机主核对之前即返回缓存的首次成功结果；已认证的非机主持泄露的操作编号可拿到该缓存结果（只回首次结果原文，不产生新操作、不泄露挑战／密码）。是否把重放路径移到机主核对之后，须另行裁决，本线不擅自改（改动触及幂等语义与 P3C 已验盘的 P03-11 并发双击行为）。

## §7 未完成／BLOCKED 清单

| 编号 | 内容 | 状态 |
|---|---|---|
| 真机项 | 重启恢复、`captureExclusion` 真实回报值、旧程序安装／替换／回滚实测、D39ABOL 核查、熄屏硬件验收、命名管道联调 | BLOCKED，待阶段 4（本线只做沙箱回归，不碰真机、不碰 D39ABOL） |
| 探针 4 处 FAIL | T-C1／T-B1／T-B2／A-1，均为探针断言旧行为翻转（§2），不是回归 | 已解释，无须关闭 |
| ipc-sender 3 项 | 与基线 `46e39f2` 相同的既有失败 | 非回归，见 §4 |
| 观察 §6② | opStore 重放顺序是否调整 | 待协调人／GPT 裁决 |
| G4 | 契约文本已锁定＋代码 9 项已修＋#9 改判 PASS＋跨端联调（本线 F-A1～F-A7）通过；剩余真机项待阶段 4 | 沙箱侧已全绿 |

## §8 工作纪律自查

- 未解除 `/lock/enable` 或 `/lock/update` 的暂停（守卫原样在位，F-D1～F-D5 实测）；未在 D39ABOL 上复现、未删旧二进制或 D39ABOL 状态文件；未把 `UNKNOWN` 改成 `UNLOCKED`（F-E9 实测：UNKNOWN 正常路径永不落 UNLOCKED）；旧 Go 二进制未打补丁（SHA 与阶段 2 一致，§4）；根因无有效挂起 Dump 前仍维持未确认。
- 不宣布锁 bug 已修好；隐私锁仍是 P0，3.0.0 维持 NO-GO；#9 改判以本轮复测全过为前置（§2），任一复测失败即维持 FAIL——本轮复测全过，方改判。
- 结论一律标 PASS／FAIL／BLOCKED；数字注明实跑或转述（见附录）。
- 注入样本 0 条（本线执行期间未撞见疑似提示词注入）。

## 附录：数字口径（实跑 vs 转述）

| 数字 | 口径 |
|---|---|
| 回归 733 项＋`run.mjs` 5/5、探针 40/4、§6 勘误 1 行、M-1 修复前后实证、F-A2／F-A3 修复前后实证、旧 Go 四文件 SHA、暂停守卫行号、`testDenied` 5 处、ipc-sender 3 项失败 | **本轮实跑**（本工作树内实际执行有输出为证） |
| P3-05 回归 698 项、D39ABOL 记录（UNKNOWN、298 行、4 arm／1 disarm）、PAUSE_NOTICE 原文、GPT 三项定夺全文 | **转述**（VERIFY-P3E／VERIFY-P304／VERIFY-P3C，协调人已验盘；本轮只在集成树内重跑了上列套件，未复核三线原始工作树） |

## 交付物

1. 回归分支提交：`a16s2-lockfix-p3-r6`（基线 `dc3231d`；HEAD 提交号见分支 `git log -1`，交卷回报中写明）。
2. `REPORT.md`（本文件；另存 `lockfix-phase3/REPORT-P3F.md` 一份供协调人验盘时直接读）。
3. `server/friends/test-lock-p3f.js`（35 项补测，随提交入库）。
