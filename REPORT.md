# P3-05 集成分支报告：合并 A/B/C ＋ 落实契约 §14 九项代码缺口

- 执行线：锁 bug 修复阶段 3 · P3-05 集成分支
- 时间：2026-11-19 05:59–06:2x CST
- 分支：`a16s2-lockfix-p3-int`，工作树 `lockfix-phase3/wt-p3e`
- 基线：`049d876`（分支 `a16s2-merge-20261119`）
- 依据：GPT 三项定夺 `~/workspace/qfremote/gpt-a16s2-lockfix-3items-ruling-20261119.md` §4.2；`LOCK-PROTOCOL-CONTRACT.md` v2.0.0（P3-04 锁定）；VERIFY-P3B／VERIFY-P3C／VERIFY-P304（协调人验盘，均已读）
- 本报告每个数字均注明实跑（本轮实际执行有输出为证）或转述（引用他人已记录的结果，未经本轮复核）

## 结论先行

1. **集成分支已建立并合入 A/B/C 三线**：合并提交 B `8c37d08`（源 `dcd576d`）、C `ca7cda4`（源 `a0d8416`）、A `7a4163a`（源 `f0a0888`）；§14 提交 `0152574`。集成后 `049d876..0152574` 共 63 文件、+7698/−69（实跑 `git diff --stat`）。
2. **任务书一处前提与 git 事实不符，已纠正并如实记录**：任务书称“049d876 已含 A/B/C 阶段 2 合并”，实际 `049d876` 只是三线的共同祖先——其两个父提交是 `4e35284`（TEST 隔离）与 `e290b71`（lea-login-retry），树内无 `windows/lock-v2/`、无 `server/friends/lock-state.js`、无 A 线文件（§1 证据）。A 线因此由本线显式合入（`7a4163a`），集成树才真正包含 A+B+C。
3. **契约 §14 九项代码缺口全部修完（代码层 PASS，本轮实跑）**：R-9／R-7／F-2／F-1／R-3／R-4／R-6／R-10／F-3，见 §3；新验收测试 `test-lock-p3e.js` **35/35**。**#9 不自行改判 PASS**——本线只记录“已修、待 P3-06 复测”，改判权在 P3-06。
4. **回归全量实跑通过**：沙箱断言去重合计 **698 项全过**（另网页端门禁 `run.mjs` 5/5）；唯一例外是 `ipc-sender-test.js` 的 3 项失败，与基线 `46e39f2` 完全相同、非回归（§4）。
5. **不宣布锁 bug 已修好；隐私锁仍是 P0，3.0.0 维持 NO-GO。** `/lock/enable` 与 `/lock/update` 暂停原样在位，未解除；未碰 D39ABOL；旧 Go 二进制未打补丁、未改原文、未删除；根因无有效挂起 Dump 前仍维持未确认。
6. **注入样本 0 条**：本线执行期间未撞见疑似提示词注入（`wt-p3e` 内未新建 `injection-samples/`，因无样本可存；P3-04／B／C 线的样本目录均只含 README）。
7. **一处实施口径偏差如实登记（§6①）**：R-7 的 v2 判定只按 `actual_state` 是否出现，不按契约 §6 另写的“version 主版本 ≥ 2”——旧 Go 组件版本号同为 2.x、无法区分，且 C 线自有 P3C 假设备 `version: '2.4.5'` 会被误判。请协调人裁决契约 §6 文字是否修订；代码行为本身符合契约意图（v2 设备恒带 `actual_state`）。

## §1 祖先核实与基线纠正（实跑）

| 核查项 | 结果 |
|---|---|
| `git merge-base --is-ancestor 049d876 dcd576d` | 通过：049d876 是 B 阶段 3 提交的祖先 |
| `git merge-base --is-ancestor 049d876 a0d8416` | 通过：049d876 是 C 阶段 3 提交的祖先 |
| `git merge-base --is-ancestor 049d876 f0a0888` | 通过：049d876 是 A 阶段 2 提交的祖先 |
| 三线共同 merge-base | `049d876`（`git merge-base dcd576d a0d8416`／`dcd576d f0a0888`／`a0d8416 f0a0888` 均为 `049d876`） |
| `049d876` 的父提交 | `4e35284`（TEST 隔离 B1+B2）＋`e290b71`（lea-login-retry D-1），即 A16-S2 的两次合并，与锁修复三线无关 |
| `049d876` 树内是否含 B/C 阶段 2 | **否**：无 `windows/lock-v2/`、无 `server/friends/lock-state.js`；`git diff 049d876..dcd576d` 全为新增（29 文件 +3503/−0），`049d876..a0d8416` 28 文件 +3650/−68 |
| `049d876` 树内是否含 A 阶段 2 | **否**：`git diff 049d876..f0a0888` 8 文件 +876/−0（`REPORT.md`、`contract/`、`evidence/component-inventory.md`、`matrix/`、`repro/`、`tests/session-ipc-checks.py`） |
| 结论 | 任务书“049d876 已含 A/B/C 阶段 2 合并”不成立——049d876 是三线的分叉点，不是合并点。本线把 A/B/C 三线全部显式合入，集成树才真正包含三线（合并提交见 §2） |

## §2 合并逐项记录

### 合并提交

| 顺序 | 提交 | 内容 | 文件（vs 049d876） | 冲突 |
|---|---|---|---|---|
| 1 | `8c37d08` | 合并 B `dcd576d`（阶段 2 B＋P3-02＋P3-04 八问回答） | 29 文件、+3503/−0 | 0 处，Git 自动合并成功 |
| 2 | `ca7cda4` | 合并 C `a0d8416`（阶段 2 C＋P3-01＋P3-03） | 28 文件、+3650/−68 | 2 处，均为文档 add/add（见下） |
| 3 | `7a4163a` | 合并 A `f0a0888`（阶段 2 A 诊断＋证据） | 8 文件、+876/−0 | 1 处，文档 add/add（见下） |
| 4 | `0152574` | §14 九项修复＋测试（非合并提交） | 12 文件、+407/−22 | — |

### 冲突逐项处理（共 3 处，代码 0 冲突）

| # | 合并 | 文件 | 冲突点 | 选择 | 理由 |
|---|---|---|---|---|---|
| 1 | C `ca7cda4` | `CONTRACT.md` | B 草案 v2.0.0 vs C v1＋增补，同路径不同内容 | 采用统一契约 v2.0.0 全文（P3-04 锁定本），仅改 §14 F-1 行一处计数（“两行”→“三行”，见 §3 F-1） | 两边契约均已被统一契约取代（契约 §17）；B/C 原文保留在 git 历史（`dcd576d`／`a0d8416`）与各自工作树 |
| 2 | C `ca7cda4` | `REPORT.md` | B 阶段 3 报告 vs C 阶段 3 报告，同路径不同内容 | 先立占位 stub，本报告随最后提交覆盖 | 各线报告是过程记录不是产品代码；原文保留在历史与 `wt-p3b`／`wt-p3c` |
| 3 | A `7a4163a` | `REPORT.md` | A 阶段 2 报告 vs 占位 stub | 保留 stub（注明 A/B/C 报告位置） | 同上；A 报告原文在 `f0a0888` 与 `lockfix-phase2/wt-a/REPORT.md` |

逐文件检查表见 `MERGE-CHECKLIST.md`（62 项，含每文件来源、行数、契约对照；另 §4 A16-S2 核对）。

### `windows/test/lock-test.js` 对齐（任务书点名项）

- 基线 `049d876`：`ok(` 调用 20 处；B 树 `dcd576d`：20 处（B 未动该文件）；C 树 `a0d8416`：26 处（阶段 2 的 25 项＋新增 C6c）。
- 合并后集成树：**26 处，取 C 版**（`git diff` 在该文件上无冲突，C 的改动干净落入）。重跑：`pass: true`，26 个 case（§4）。
- 计数口径：沿用 VERIFY-P3B §5 的实测值 20（阶段 2 的 21 为误记），不沿用转述的 21。

### A16-S2 关键文件核对（合并前后逐项 diff，实跑 SHA）

- 16 个 A16-S2 文件（`git diff 9b06449..049d876 --name-only`）中 **14 个逐字节相同**（SHA 与基线一致）：`build-flavor.js`、`lea-login-retry.js`、`scripts/build-test-main.js`、`test-policy.js`、`test/lea-firstinstall-a1-test.js`、`test/lea-login-retry-test.js`、`test/mc-midgroup-test.js`、`test/permission-policy-test.js`、`test/r10-bootlog-fallback-test.js`、`test/test-mode-gates-test.js`、`test/test-policy-test.js`、`test/update-lea-backfill-test.js`、`tools/check-build-flavor.js`、`tools/check-electron-safety.js`。
- **2 个为预期改动**：
  - `windows/main.js`：仅 C 线两处——`qf-lock-disable` 加 `opts` 透传、`qf-lock-challenge` 新句柄；两处均保留 `IS_TEST ? testPolicy.testDenied(...)` 门禁（`testDenied` 出现次数 4 → 5，新增门禁 1 处，无门禁被删）。
  - `windows/package.json`：仅 B 线一行——打包清单加 `lock-v2/**/*`。
- 旧 Go 二进制：`git diff 049d876..HEAD` 在 `windows/privacy-lock/app/` 为空；四文件 SHA 与 VERIFY-P3B 一致：QFLockUI `712a6d89…dbc84a`、QFLockService `eae8784c…4206e`、qf-lockctl `cdc797a2…596b4`、qf-lockupdater `2fc4bb6d…07290`（实跑 `sha256sum`）。
- 暂停守卫：`lock-bridge.js:1083`（enable 503 原维护文案）与 `:1088`（update 503 `lock-remediation-paused`）原样在位，暂停审计（`:1077`）与 `/lock/repair` 占位（`:1092`）均在。

## §3 契约 §14 九项逐项验收（本轮实跑）

| 编号 | 修复内容与位置 | 测试证据（正／负向） | 结论 |
|---|---|---|---|
| R-9（#9 FAIL） | `server/friends/lock-state.js`：`degradedFromStatus(status, actualState)` 接实际状态入参，只在 `LOCKED`／`LOCKING` 下映射 `unknown`／`failed-degraded` → `DEGRADED`；`reconcileRecord` 出口与内层 `applyDegraded` 均传对账后实际状态 | `test-lock-p3e.js` R9-1～R9-7：LOCKED＋unknown→DEGRADED、LOCKING＋unknown→DEGRADED、LOCKED＋active→null、UNLOCKED＋unknown→null（原 #9-C2 FAIL 点）、UNLOCKED＋failed-degraded→null（原 #9-C3 FAIL 点）、v2 一致上报 LOCKED＋unknown→DEGRADED | **PASS（代码层；#9 改判待 P3-06 复测，本线不自行改判）** |
| R-7 | 同文件：`isV2Status`＋`reconcileRecordInner` 增加 `revision-missing` 分支——v2 缺 `revision` 或非数字 → `RECOVERY_REQUIRED`；v1 仍跳过；心跳过期（>2 分钟）时不由本条改判（走 stale-heartbeat → UNKNOWN） | P3E R7-1～R7-4：v2 缺 revision→`to-recovery`／`revision-missing`；v2 带 revision→confirmed；v1 缺 revision（`version: '2.4.5'`）→仍跳过；v2 revision 为字符串→判异常 | **PASS（代码层）**，口径偏差见 §6① |
| F-2 | 同文件：`preferredActualState`＋`classifyDeviceStatus` 优先读 v2 `actual_state`（LOCKING／UNLOCKING／UNKNOWN／RECOVERY_REQUIRED 直接按自报分类；LOCKED／UNLOCKED 落入原 Locked／Off 分支）；无记录基线同样优先读；证据等级仍按事件定 | P3E F2-1～F2-6：探针 A-1 原缺口（`state: Off`＋`actual_state: LOCKED` → LOCKED）现通过；反向（`Locked`＋`UNLOCKED`＋disarm 强证据 → UNLOCKED）；v1 回落不变 | **PASS（代码层）** |
| F-1 | B `windows/lock-v2/lock-state.js` 补 3 边（`UNLOCKED → RECOVERY_REQUIRED`、`UNLOCKING → LOCKED`、`UNKNOWN → UNLOCKING`）；C `server/friends/lock-state.js` 补 1 边（`RECOVERY_REQUIRED → LOCKING`）；`RECOVERY_REQUIRED → UNLOCKING` 不纳入 | P3E F1-1～F1-6＋`lock-v2-state-test.js` 新增 E1–E4：四条新边合法、直达仍禁；`test-lock-state.js` A4 按并集表更新＋A4b 负向（`RECOVERY_REQUIRED → UNLOCKING` 仍非法） | **PASS（代码层）** |
| R-3 | `server/friends/lock-bridge.js`：新增 `disarmWaitPredicate(lockId, since)`（lockId 优先、不命中回落时间窗口、无 lockId 也无可解析时间一律不放行），disable 分支改用它（原谓词只用时间窗口且 `!ev.time` 使无时间戳事件也放行）；经 `_test` 导出可测 | P3E R3-1～R3-6：lockId 匹配放行（事件时间早于窗口也放行）、旧 lockId＋旧时间不放行（负向）、无时间戳事件不放行（负向）、窗口内时间兜底保留、未 Off 不放行、仅 `ts` 的 v2 事件放行 | **PASS（代码层）** |
| R-4 | `server/friends/lock-state.js`：`unlock-ok` 分支 `if (!ev.fields) return true;` 改为时间窗口校验（`ts ≥ 本次 created_at`）；注释同步改写（旧注释“时间窗口是唯一判据”与代码自相矛盾，现代码与注释一致） | P3E R4-1～R4-3：无 fields＋陈旧 unlock-ok 不作强证据（负向）、窗口内作强证据、无时间戳不作强证据（负向） | **PASS（代码层）** |
| R-6 | 同文件：身份字段（`boot_id`／`session_id`／`sid`）回填从 `confirmed` 分支移到 `reconcileRecord` 出口统一做；`confirmed` 分支的旧回填行已删 | P3E R6-1～R6-2：`to-unlocked` 两步路径同样回填三字段（旧分支漏填处）、已有字段不被覆盖（负向） | **PASS（代码层）** |
| R-10 | Electron `windows/lock.html` 增加 `#lockPauseNotice` 横幅（PAUSE_NOTICE 原文＋样式）；网页 `server/webapp/app-7005a01d.js` 的 `initLockPanel` 开头插入 `#lk-pause-note`（`#lockCard` 层、`#lockBody` 之外，重建不被洗掉）；`bump-version.mjs` 已跑（`app-417c329f.js` → `app-7005a01d.js`，ASSETS.json＋index.html 同步） | Electron `lock-modal-dom-test.js` 新增 M0p（DOM 文案逐字断言）；网页 `lock-confirm-web.test.mjs` 增加横幅文案断言＋重建后仍只一份的断言；P3E R10-1（B 侧常量与裁决原文一字不改） | **PASS（代码层；DOM 断言待 P3-06 复核）** |
| F-3 | 集成 `CONTRACT.md` 即统一契约 v2.0.0：§6 已写 v2 先查先拒（`E_ENVELOPE_REPLAY`）；C 旧 CONTRACT §9 #8 的旧 Go 拒绝点描述在集成树内已被替换，无残留 | 读码核实：集成 `CONTRACT.md` §6“重复 `disarm` 信封必拒…先查先拒”在位；`git diff` 显示集成 `CONTRACT.md` 与 P3-04 锁定本仅差 §14 F-1 行一处计数 | **PASS（文字层）** |
| 计数纠正 | VERIFY-P304 §4 的“三行”纠正已落实：集成 `CONTRACT.md` §1 表为并集表——`LOCKING` 行含 `UNLOCKED`、`UNLOCKING` 行含 `LOCKED`、`RECOVERY_REQUIRED` 行＝`UNLOCKED`／`LOCKED`／`UNKNOWN`／`LOCKING`；§14 F-1 行“两行须纠正”已改为“三行须纠正（P3-05 纠正：…）” | `diff p3-04/LOCK-PROTOCOL-CONTRACT.md CONTRACT.md` 仅 1 行不同（即该行）；P3E F1-1～F1-6 覆盖三行对应的边 | **PASS** |

## §4 回归与验证（全部本轮实跑，Node v24.22.1）

| 套件 | 结果 | 备注 |
|---|---|---|
| A 诊断 `tests/session-ipc-checks.py` | **53/53 PASS** | 与阶段 2 一致 |
| B `lock-v2-state-test.js` | **18 cases PASS** | 阶段 2 的 14 项＋P3-05 F-1 新增 E1–E4 |
| B `lock-v2-ipc-test.js` | **7 PASS** | |
| B `lock-v2-input-health-test.js` | **15 PASS** | |
| B `lock-v2-password-test.js` | **8 PASS** | 终端输出被展示层脱敏为 `<redacted>`（见 VERIFY-P3B §6 同款说明）；以 exit 0＋`ok(` 8 处为准 |
| B `lock-v2-coordinator-test.js` | **19 PASS** | |
| B `lock-v2-fault-injection-test.js` | **13 PASS** | |
| B 小计（阶段 2 新测试） | **80/80** | 原 76＋新增 4 |
| B `lock-v2-8q-test.js` | **38 cases，pass: true** | |
| B `lock-v2-retirement-test.js` | **38 cases，pass: true** | |
| 既有 `windows/test/lock-test.js` | **26 cases，pass: true** | C 版（含 C6c）；B/C 两树已对齐，见 §2 |
| C `server/friends/test-lock-state.js` | **59 passed，0 failed** | 原 58＋A4b 新增 1 |
| C `server/friends/test-lock-bridge.js` | **66 passed，0 failed** | |
| C `server/friends/test-lock-bridge-c.js` | **9 passed，0 failed** | |
| C `server/friends/test-lock-envelope.js` | **18 passed，0 failed** | |
| C `server/friends/test-logic.js` | **31 过／0 挂** | |
| C `server/friends/test-lock-p3c.js` | **71 passed，0 failed** | P3-01 十项＋P3-03 十二项未受 §14 改动影响 |
| C `server/friends/test-lock-p3e.js`（新增） | **35 passed，0 failed** | §14 九项逐项断言（§3） |
| C 服务端小计 | **289** | 59+66+9+18+31+71+35 |
| Electron `windows/test/lock-confirm-test.js` | **12 passed，0 failed** | |
| Electron `windows/test/lock-modal-dom-test.js` | **26 passed，0 failed** | 原 25＋M0p（R-10 DOM 断言） |
| 网页 `server/webapp/tests/unit/` 全套 | **47 passed，0 failed** | 含 `lock-confirm-web.test.mjs` 的 R-10 横幅断言 |
| 网页 `server/webapp/tests/run.mjs` | **5/5 PASS** | 首轮 2 步 FAIL 仅因本工作树缺 `acorn`（环境缺件，与 C 线同款；按 C 线做法在 `tests/node_modules/` 内 `npm install --no-save acorn` 后 5/5 全绿；该目录 gitignored，未入库） |
| A16-S2 `windows/test/lea-login-retry-test.js` | **50/50 PASS**（`pass: true`，`failed: []`，`ok(` 50 处） | C 的 `main.js` 改动未损 TEST 门禁 |
| A16-S2 `windows/test/test-mode-gates-test.js` | **39 cases，pass: true** | |
| 顺带 `windows/test/device-unlock-test.js` | **pass: true** | |
| 顺带 `windows/test/client-version-test.js` | **pass: true** | |
| **去重合计** | **698 项断言全过**（53+80+38+38+26+289+12+26+47+50+39；`lock-test.js` 26 只计一次；另 `run.mjs` 5 步全过） | |
| `node --check` | **通过**：`lock-state.js`、`lock-bridge.js`、`test-lock-p3e.js`、`test-lock-state.js`、B `lock-state.js`、`lock-v2-state-test.js`、`lock-modal-dom-test.js`、`app-7005a01d.js` | |
| `windows/test/ipc-sender-test.js` | **3 项失败，与基线相同，非回归**：`E1_registered_36_29`、`E2_registered_total_65`、`E6_table_65_keys`（VERIFY-P3C 已证实基线 `46e39f2` 同款失败；本线未碰 `windows/main.js` 的 IPC 注册） | |
| P3-04 探针改指集成树重跑（`/tmp/p3e-probe-8q.js`，仅改 4 处 require 路径） | **39 PASS／5 FAIL**；5 处 FAIL 全部可解释（见 §6②），其中 #9-C2／#9-C3 由 FAIL 翻为 PASS（R-9 修复的独立证据） | 探针原文在 `p3-04/`，本线未改；改指副本在 `/tmp`，不入库 |

## §5 构建 SHA（实跑复算）

- 文件：`windows/lock-v2/BUILD-P3E.json`（随最后提交交付）。
- 范围：`049d876..0152574` 间全部 62 个差异文件（除交付文档 `REPORT.md`／`MERGE-CHECKLIST.md`／`BUILD-P3E.json` 本身，B 线先例同样排除 `REPORT.md`）。
- 包 SHA-256：`7a93b39786fcf50e69c70680faae4f4fcc10e232110f311dba9480c5185a4bde`
- 串联方法（写在文件内 `method` 字段，可复算）：文件按路径排序；逐文件取内容 SHA-256 hex；把 62 个 hex 串按所列顺序直接拼接（无分隔符）；对拼接结果再取 SHA-256 hex。本轮已用独立脚本重算：包 SHA 一致，62 个逐文件 SHA 零不符。
- 指纹对应提交：`0152574`（§14 提交）；分支 `a16s2-lockfix-p3-int`。最后提交（交付文档 3 件）不改变该指纹覆盖的文件集。

## §6 未完成／BLOCKED 清单与如实记录

| 编号 | 内容 | 状态 |
|---|---|---|
| #9 改判 | R-9 代码已修、P3E R9-1～R9-7 全过，但 **#9 仍为 FAIL，直到 P3-06 复测通过才改判**。本线不自行改判 | 待 P3-06 |
| ① R-7 口径偏差 | 契约 §6 写“自称 v2 的设备（status 含 `actual_state`，或 `version` 主版本 ≥ 2）缺 `revision` → 异常”。本实现**只用 `actual_state` 是否出现**判定 v2，不用 version 判据。证据：旧 Go 组件的 `ComponentVersion` 同为 2.x（`privacy-lock-impl/src/internal/core/update.go` 目标版本如 `"2.0.3"`；`status.go:35` 写 `Version: e.cfg.ComponentVersion`），主版本 ≥ 2 无法区分 v1 Go 与 v2；C 线自有 P3C 假设备 `status.version` 为应用版本 `'2.4.5'`，按字面判据会被误判 v2、缺 revision 即进恢复态，直接破坏已验盘的 P3C 71 项（推演确认，未实际跑该变体：P3C 假设备 `version: '2.4.5'` 且无 `revision`、无 `actual_state`，字面规则下 `reconcileFromRead` 会把 arm 后的读取判为 `revision-missing`，P03-1 等用例即失败；规则本身已被旧 Go 版本号证伪，故不采纳）。v2 设备恒带 `actual_state`（契约 §3），只用该标志仍满足契约意图。请协调人裁决契约 §6 文字是否修订（建议改为“以 `actual_state` 是否出现为准”） | 待协调人裁决；代码已按实际口径实现并经 R7-3 负向断言锁定 |
| ② P3-04 探针 5 处 FAIL 的解释 | 改指集成树重跑 39 PASS／5 FAIL。5 处均为**探针断言写的是旧行为**，不是本线回归：T-C1／T-B1／T-B2（探针断言新边“当前不许”，修完后合法故断言翻转）、A-1（探针断言 C 按 v1 `state` 判 `RECOVERY_REQUIRED`，F-2 修完后判 `LOCKED`，故翻转）、#9-C1（探针的 `statusV2` 默认 `actual_state: 'UNLOCKED'`、却传 `state: 'Locked'`，自相矛盾的上报；F-2 下 `actual_state` 胜出、无强证据故进 `RECOVERY_REQUIRED`——真实 v2 设备不会这样上报，`state` 由 `actual_state` 派生；一致上报时 R9-7 已证实 LOCKED＋unknown→DEGRADED）。其余 39 项（含 #9-C2／C3 翻为 PASS、#7-C2 决策变为 `to-recovery`、#4-C3 仍 PASS——该用例的 unlock-ok 时间戳在窗口内，R-4 收紧后仍为强证据）均与预期一致。P3-04 探针原文未改；P3-06 如重跑该探针，须把 `#9-C1` 的 status 改为一致上报（或直接采信本线 R9-7） | 待 P3-06 知悉 |
| M-1 | 桥掩盖性问题（VERIFY-P3C §4）：`applyCorrection` 失败时桥仍回 200 `UNLOCKED`。**只记录，不由本线修**；P3-06 须补“失败时桥必须不报成功”断言 | 待 P3-06 |
| 联调 | 跨端联调（v2 设备实报事件走完整 `/lock/disable` 链路、命名管道联调） | BLOCKED，待 P3-06 |
| 真机 | 重启恢复、`captureExclusion` 真实回报值、旧程序安装／替换／回滚实测、D39ABOL 核查、熄屏硬件验收 | BLOCKED，待阶段 4 |
| G4 | 契约文本已锁定＋代码 9 项已修；#9 改判与联调待 P3-06，G4 未全绿 | 待 P3-06 |

## §7 工作纪律自查

- 未解除 `/lock/enable` 或 `/lock/update` 的暂停（守卫原样在位，§2）；未在 D39ABOL 上复现、未删旧二进制或 D39ABOL 状态文件；未把 `UNKNOWN` 改成 `UNLOCKED`；旧 Go 二进制未打补丁（SHA 与阶段 2 一致，§2）；根因无有效挂起 Dump 前仍维持未确认。
- 不宣布锁 bug 已修好；隐私锁仍是 P0，3.0.0 维持 NO-GO；#9 不自行改判 PASS。
- 结论一律标 PASS／FAIL／BLOCKED；数字注明实跑或转述（见附录）。
- 注入样本 0 条（本线执行期间未撞见疑似提示词注入）。

## 附录：数字口径（实跑 vs 转述）

| 数字 | 口径 |
|---|---|
| 祖先核实、合并提交号、冲突 3 处、`lock-test.js` 26、A16-S2 16 文件 SHA、旧 Go 四文件 SHA、暂停守卫行号、§14 九项修复、回归 698 项＋`run.mjs` 5/5、探针改指重跑 39/5、BUILD-P3E 包 SHA | **本轮实跑**（本工作树内实际执行有输出为证） |
| B 提交 `dcd576d`、C 提交 `a0d8416`、B 76/76、C 363 项、P3-04 探针原文 42/2、D39ABOL 记录（UNKNOWN、298 行、4 arm／1 disarm）、PAUSE_NOTICE 原文 | **转述**（VERIFY-P3B／VERIFY-P3C／VERIFY-P304，协调人已验盘；本轮只在集成树内重跑了上列套件，未复核三线原始工作树） |
| 阶段 2 的 21（`lock-test.js`） | 转述误记，已按实跑 20 纠正（VERIFY-P3B §5）；集成树内 C 版为 26 |

## 交付物

1. 集成分支提交：B `8c37d08`、C `ca7cda4`、A `7a4163a`、§14 `0152574`（分支 `a16s2-lockfix-p3-int`，工作树 `lockfix-phase3/wt-p3e`）。
2. `REPORT.md`（本文件）。
3. `MERGE-CHECKLIST.md`（62 项逐文件检查表＋冲突逐项＋契约复核＋A16-S2 核对）。
4. `windows/lock-v2/BUILD-P3E.json`（62 文件逐个 SHA＋包 SHA `7a93b397…`，方法可复算）。
