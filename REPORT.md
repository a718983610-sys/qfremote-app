# QFRemote 隐私锁修复 · 阶段 3 B 线报告：P3-02 旧程序退役与安全迁移 ＋ P3-04 八问 B 线回答

- 日期：2026-11-19 04:38–05:0x CST
- 任务书：`../lockfix-phase3/task-briefs/brief-p3b.md`
- 依据：GPT 三项定夺 `~/workspace/qfremote/gpt-a16s2-lockfix-3items-ruling-20261119.md`（2026-11-19 04:25 取回，思考 3m 51s），重点 §二（裁决②）、§四（阶段 3 衔接，八问）；C 线 CONTRACT §9（`../lockfix-phase2/wt-c/CONTRACT.md`，只读参考，未改阶段 2 文件）
- 分支：`a16s2-lockfix-p3-b`，基线 `5734d69`（阶段 2 B 线 HEAD；代码提交 `217506f`）
- 本报告每个数字均注明实跑（本轮实际执行并有输出为证）或转述（引用他人已记录的结果，未经本轮复核）
- 阶段 2 报告原文保留在 git 历史（`5734d69` 的 `REPORT.md`）；本文件只写阶段 3
- 隐私锁仍是 P0 阻断项，3.0.0 发版维持 NO-GO；**本线绝不宣布锁 bug 已修好**

## 结论先行

- P3-02 旧程序退役与安全迁移方案：**已交付为可执行逻辑＋测试**（`windows/lock-v2/legacy-retirement.js`，沙箱实跑 38/38）；真机执行一律 **BLOCKED**
- P3-04 八问：**8/8 已逐项回答**（`ANSWERS-8Q.md`），字段已真补进设备端实现与测试（沙箱实跑 38/38）；C 线确认一栏留空写“待 C 线确认”
- 回归：阶段 2 新测试 **76/76 实跑全过**，既有 `lock-test.js` **20/20 实跑全过**（见 §5 计数差异说明）；全部新／改 JS 文件 `node --check` 通过（实跑）
- 旧 Go 二进制：**未打任何补丁、未改动原文、未删除**（`git status` 实跑核对，见 §6）
- 真机步骤（安装／替换／回滚实测、D39ABOL 核查、熄屏硬件验收）：**全部 BLOCKED**，不在任何真机上安装或替换组件

## §1 交付物清单（实跑核对）

| 交付物 | 位置 | 状态 |
|---|---|---|
| status.json 上报器（#3/#4/#5/#6/#7/#9） | `windows/lock-v2/status-report.js` | 已实施 |
| 信封去重守卫（#8） | `windows/lock-v2/envelope-replay.js` | 已实施 |
| 旧程序退役与安全迁移引擎（P3-02） | `windows/lock-v2/legacy-retirement.js` | 已实施 |
| 状态机补字段（`sid`/`armed_at`） | `windows/lock-v2/lock-state.js`（改） | 已实施 |
| 协调层接线（事件写入／去重／boot 恢复／三身份字段） | `windows/lock-v2/lock-coordinator.js`（改） | 已实施 |
| 模块出口 | `windows/lock-v2/index.js`（改） | 已实施 |
| 八问测试 | `windows/test/lock-v2-8q-test.js` | 沙箱实跑 38/38 |
| 退役迁移测试 | `windows/test/lock-v2-retirement-test.js` | 沙箱实跑 38/38 |
| 八问逐项记录 | `ANSWERS-8Q.md` | 已交付（C 线确认待填） |
| 契约更新（§10/§11） | `CONTRACT.md`（改，仍标草案） | 已交付 |
| 构建 SHA | `windows/lock-v2/BUILD-P3B.json` | 已生成（§7） |
| 本报告 | `REPORT.md` | 本文件 |
| 注入样本目录 | `evidence-b/injection-samples/` | 0 条新增（本轮未撞见注入） |

## §2 P3-02 旧程序退役与安全迁移方案（裁决 §2）

### 暂停期清点（实跑核对）

- 四个旧二进制 SHA（本树 `windows/privacy-lock/app/` 副本实测，`sha256sum`）：`QFLockService.exe eae8784c…4206e`、`QFLockUI.exe 712a6d89…dbc84a`、`qf-lockctl.exe cdc797a2…596b4`、`qf-lockupdater.exe 2fc4bb6d…07290`（全长见 `legacy-retirement.js` 的 `LEGACY_SHA256`；退役测试逐个比对实测值，38/38 中的 `P-四文件SHA与树内副本实测一致` PASS）。设备上已安装副本的 SHA 须真机重验，不符即按 `IDENTITY_MISMATCH` 拒绝——**本线未上真机核对，D39ABOL 的已装副本 SHA 未知，记 BLOCKED**。
- 启动入口 10 条（本树 grep 实测，见 `LEGACY_START_ENTRIES`）：安装器 SEC_LOCK、QFLockSvc 服务、`install.ps1`、`install-upgrade.ps1`、客户端自愈（`install-system-services.ps1`＋`main.js runStartupAgentHeal`）、`sys-helper install-lock`、`update` 信封＋`qf-lockupdater.exe`、卸载脚本、手动运行副本、Run 键／计划任务（本树内未发现，须真机扫描补入）。产品侧入口均被暂停覆盖（`/lock/enable` 503＋`/lock/update` 冻结，P3-01 由 C 线落实；本线只负责清单与覆盖方式，不改服务端）。
- 控制台提示文案：裁决 §2.2 原文一字不改写入实现与测试（`PAUSE_NOTICE`，测试与原文逐字比对 PASS）：“当前屏幕锁功能因兼容性故障暂停使用。请勿手动运行旧版 QFLockUI.exe。正常远程控制功能不受此项暂停影响。”**这是风险告知，不是安全控制的替代品**：它拦不住用户双击自己保存的旧 EXE 副本；手动运行入口的 coverage 明确标 `notice-only`，测试断言其文案含“仅控制台提示”。

### 接管期七步（可执行逻辑＋测试，沙箱验证）

`planMigration`（前置检查通过才生成计划）→ `executeMigration(ctx, ops)`，七步顺序：验身份 → 保全证据 → 查锁状态 → 清启动引用 → 签名新组件替换 → 按清单退役 → 验安装与回滚。关键纪律已写进代码：退役 = 移入证据隔离区（**非删除**），彻底删除须另行批准；新组件启动失败绝不静默回退旧程序（回滚只恢复旧服务配置与启动引用，不启动旧锁 UI；假 ops 的 `launchLegacyUi` 计次恒为 0，测试据此判 FAIL）；任一步失败即调 `ops.rollback` 后抛错。

### D39ABOL 前置检查（任一不满足即拒绝迁移）

`checkMigrationPreconditions` 共 13 项拒绝码（实跑逐项断言）：`NOT_APPROVED`、`BAD_SIGNATURE`、`BAD_HASH`、`D39ABOL_UNKNOWN`、`RECOVERY_REQUIRED`、`ACTIVE_PROTECTION`、`TRANSITION_IN_PROGRESS`、`EVIDENCE_NOT_PRESERVABLE`、`IDENTITY_MISMATCH`、`STATE_FILE_DAMAGED`、`DELETE_STATE_REFUSED`、`FORCE_UNLOCK_REFUSED`。D39ABOL 当前记录（裁决 §2.3）：锁状态 UNKNOWN，298 记录行，4 arm／1 disarm，最后一次 arm 后尚无 disarm 记录——**本线未改动该状态，未删状态文件，未在该笔记本上复现**。

### 验收测试（裁决 §2.4，逐项标结论）

| 验收项 | 结论 | 依据 |
|---|---|---|
| 正常安装后不存在产品自身调用旧 QFLockUI 的有效路径 | **PASS（沙箱逻辑）** | 迁移执行后运行路径无旧 EXE（`retire-legacy` 验收）＋入口清单清除断言；真机复核 BLOCKED |
| 升级、修复安装、卸载、失败回滚均不会意外启动旧锁程序 | **PASS（沙箱逻辑）** | 安装失败与验证失败两档注入：均回滚、`launchLegacyUiCalls==0`、后续步不再执行；卸载路径走隔离非删除＋审计记录（`-PurgeData` 明确禁用） |
| 安装失败时不会把设备留在无法远控、无法本地恢复的中间状态 | **PASS（沙箱逻辑）** | 失败即回滚（`rollbackOk==true` 断言）；真机中间态复核 BLOCKED |
| 旧版本残留和副本能被识别并给出明确提示（不夸称能禁止用户运行任意自有 EXE） | **PASS（沙箱逻辑）** | `scanLegacyCopies`：已知 SHA→隔离处理；同名不同 SHA→只提示、不自动退役；提示文案含“请勿手动运行” |
| UNKNOWN 状态下安装器不能擅自清理实际保护状态 | **PASS（沙箱逻辑）** | `D39ABOL_UNKNOWN`／`DELETE_STATE_REFUSED`／`FORCE_UNLOCK_REFUSED` 三项拒绝断言 |
| 原始故障证据仍能追溯 | **PASS（沙箱逻辑）** | 保全证据步要求副本 SHA 与原文逐个一致；旧二进制原文未动（§6） |
| 阶段 3 放行条件：退役方案有完整安装／回滚测试，不以“新 EXE 已存在”作为通过 | **PASS（沙箱逻辑）** | 38/38 含正常／失败／验证失败三档执行测试；真机执行 BLOCKED |

## §3 P3-04 八问 B 线回答（裁决 §4.1）

全文见 `ANSWERS-8Q.md`；每问含原始问题（原文引用）、B 线答案、C 线确认（留空“待 C 线确认”）、冲突情况、源码定位、测试证据、审核结论（自评）。摘要：

| 问 | 答案要点 | 自评 |
|---|---|---|
| #3 `disarm` 补 `fields.lockId` | 已补（`recordDisarm`，缺 `lockId` 抛错）；与 `arm` 的 `armId` 对称 | PASS（沙箱） |
| #4 `unlock-ok` 的 `ts` 为 ISO 且与 arm 可比 | 确认；全部事件 `ts` 同为 `toISOString()`（UTC 毫秒），`unlock-ok` 另补 `fields.lockId` | PASS（沙箱） |
| #5 `boot-recovered` 重启恢复时必写 | 确认（v2 规则：`boot_id` 变化＋旧态 `LOCKED`/`LOCKING` 时 `recoverAfterRestart()` 必写，且只写一次） | PASS（沙箱） |
| #6 补 `boot_id`/`session_id`/`sid` | 已补进 status.json v2；`sid`（用户 SID）≠ `session_id`（数字会话号） | PASS（沙箱） |
| #7 `status.revision` 每次变更 +1 | 确认补；阶段 2 即已实现，本次写进 status.json；同态转移不 +1 | PASS（沙箱） |
| #8 重复 `disarm` 信封必拒 | 书面确认；信封级先查先拒（`E_ENVELOPE_REPLAY`）＋状态机幂等双防线 | PASS（沙箱） |
| #9 `captureExclusion` 写入时机与 `unknown` 语义 | 确认；只在会话组件回报时改写；`unknown`=尚未证实生效，`LOCKED` 下非 `active` 按 `DEGRADED` | PASS（沙箱） |
| #10 旧 `QFLockUI.exe` 删除／替换方案 | 与 P3-02 同一份方案；“删除”纠正为“隔离＋另行批准才删” | PASS（沙箱） |

**必须向 P3-04 协调人报告的冲突（已在 `ANSWERS-8Q.md` 逐项写明，统一契约以 v2 为准）：**

1. **#5 与旧 Go 不符**：旧 Go 只在 `BootMarker=='fail-limit-reboot'` 时写 `boot-recovered`（`engine.go NewEngine`），普通重启后旧 `LOCKED` 待重核时不写；C 的 §9 #5 按“重启恢复必写”实现。统一契约采用 v2 规则；过渡期 C 对旧设备保留时间窗口兜底，不得把“无 `boot-recovered`”当作“未重启”的唯一依据。
2. **#3/#4 旧 Go 无 `lockId`**：旧 Go 的 `disarm`（只有 `{by}`）、`unlock-ok`（字段 `nil`）均无 `lockId`；v2 已补。过渡期 C 对旧设备保留时间窗口兜底，v2 设备优先按 `lockId` 匹配。
3. **#8 拒绝点不同**：旧 Go 第一次“已解锁的 disarm”因 `OK=false` 不记信封 id，第二次仍进 `Disarm` 但无副作用；v2 改为先查先拒。最终效果一致（无重复副作用），审计更明确。
4. **#9 口径收窄**：C 的 `unknown`→`DEGRADED` 映射，B 限定在 `LOCKED`/`LOCKING` 下；`UNLOCKED` 空闲态的 `unknown` 只是“尚未评估”，不产生降级标记。

## §4 本轮抓获并修复的真问题（实跑）

- **8Q 测试 C1 初跑 FAIL**：`coord.statusJson()` 的 `session_id` 为 `null`——`arm()` 成功后状态机从未写入已核验的会话身份（阶段 2 遗留）。已修复：在 `_connectSessionAgent`（arm 与重启重核共用入口）把 `session.sessionId`／`session.userSid` 写进状态机；修复后 8Q 测试 38/38 全过，阶段 2 回归 76/76 不受影响。教训：`status.json` 的身份字段不能只靠构造参数，必须在会话核验通过后写。

## §5 回归与语法检查（实跑，Node v24.22.1）

| 测试 | 用例数 | 结果 |
|---|---|---|
| `lock-v2-8q-test.js`（新增） | 38 | **PASS 38 / FAIL 0** |
| `lock-v2-retirement-test.js`（新增） | 38 | **PASS 38 / FAIL 0** |
| `lock-v2-state-test.js`（阶段 2） | 14 | **PASS** |
| `lock-v2-ipc-test.js`（阶段 2） | 7 | **PASS** |
| `lock-v2-input-health-test.js`（阶段 2） | 15 | **PASS** |
| `lock-v2-password-test.js`（阶段 2） | 8 | **PASS** |
| `lock-v2-coordinator-test.js`（阶段 2） | 19 | **PASS** |
| `lock-v2-fault-injection-test.js`（阶段 2） | 13 | **PASS** |
| 阶段 2 新测试合计 | **76** | **PASS 76 / FAIL 0** |
| `lock-test.js`（既有） | 20 | **PASS 20 / FAIL 0** |

- 计数差异说明（实跑）：本轮 `lock-test.js` 的结果 JSON 含 20 个用例键，退出码 0；阶段 2 报告记为 21。差异原因未深究（本文件 `ok()` 调用共 20 处），此处按本轮实跑记 20/20，不沿用转述的 21。
- `node --check`：`windows/lock-v2/` 全部 JS（含新增 3 个与改动 3 个）＋两个新测试文件，实跑全部通过。
- 未跑项：`node test/run-all.js` 全量未跑（与阶段 2 同款原因，内含 release-gate 等长耗时项，与本线无关）；两份 `.ps1` 未改动，仍按阶段 2 结论（沙箱无 PowerShell，未做语法机验）。

## §6 未完成事项与限制条件（BLOCKED 清单）

1. 真机安装／替换／回滚实测 BLOCKED（本线不在任何真机上安装或替换组件；迁移引擎只提供注入式 ops，真实 ops 由阶段 4 提供）。
2. D39ABOL 核查 BLOCKED：设备上已装旧二进制的 SHA、实际启动入口、锁状态文件内容均未在真机上核对；UNKNOWN 保持不变。
3. 腾讯 CVM／D39ABOL 上的新组件联调 BLOCKED：命名管道真机联调、熄屏硬件验收、`captureExclusion` 真实回报值、`boot_id` 重启后变化方式，均待阶段 4。
4. C 线服务端对账 BLOCKED（待 P3-04 另线）：`lockId` 优先匹配、`boot-recovered` 过渡期兜底、`revision` 缺失处理、控制台降级文案——`ANSWERS-8Q.md` 的 C 线确认栏 8/8 留空。
5. 旧 Go 二进制未动：`git status` 实跑核对，本轮只改 `CONTRACT.md`、`windows/lock-v2/index.js`、`lock-coordinator.js`、`lock-state.js`，只新增 `ANSWERS-8Q.md`、`windows/lock-v2/{status-report,envelope-replay,legacy-retirement}.js`、`windows/test/lock-v2-{8q,retirement}-test.js`、`windows/lock-v2/BUILD-P3B.json`、`REPORT.md`；`windows/privacy-lock/app/` 四个旧 EXE 无任何改动；阶段 2 目录未碰。
6. 本线未撞见疑似提示词注入：`evidence-b/injection-samples/` 无新增条目。

## §7 构建 SHA（实跑）

- 包 SHA-256（10 个本轮文件哈希串联哈希）：`9efe19ad4fdc031630a405c6741f7f6a51457265f9c3eda477b0464f41381723`
- 明细见 `windows/lock-v2/BUILD-P3B.json`（逐文件 SHA-256）。
- 基线 `5734d69`；本线无编译产物（Node 源码组件，随客户端打包，不单独编二进制）。

## 附录：提交与复核

- 分支：`a16s2-lockfix-p3-b`；提交信息写清范围与验证结果；提交后 `git show --stat` 复核（提交号见父代理收到的最终回报，本报告撰写时尚未提交）。
- 回滚：本分支未动生产服务、未动基线文件、未动阶段 2 目录；废弃本分支即回滚。
