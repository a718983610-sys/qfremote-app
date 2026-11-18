# P3-05 合并检查表（集成分支 a16s2-lockfix-p3-int）

- 基线：`049d876`（分支 `a16s2-merge-20261119`）。合并提交：B `8c37d08`（源 `dcd576d`）、C `ca7cda4`（源 `a0d8416`）、A `7a4163a`（源 `f0a0888`）；§14 提交 `0152574`。
- 行数口径：`git diff --numstat 049d876..0152574`（含 §14 改动；改名文件按新名计）。来源列：A＝阶段 2 A 线、 B＝B 线阶段 2＋阶段 3、 C＝C 线阶段 2＋阶段 3。
- 契约对照以 `LOCK-PROTOCOL-CONTRACT.md` v2.0.0（集成 `CONTRACT.md`）为准；“—”表示该文件不承载契约条文（证据／脚本／清单类）。

## §1 逐文件检查表（62 项，049d876 → 0152574）

| 文件 | 来源 | 行数（+ / -） | 契约对照 |
|---|---|---|---|
| `ANSWERS-8Q.md` | B | +87 / -0 | B 线八问回答；统一契约已锁定，C 确认栏由 P3-04 闭合 |
| `CONTRACT.md` | BC | +288 / -0 | 已替换为统一契约 v2.0.0 全文（P3-04）；§1 为并集表；§14 F-1 行“两行”已纠为“三行” |
| `REPORT.md` | ABC | +5 / -0 | P3-05 报告（本线最终版随最后提交覆盖合并占位） |
| `contract/ipc-session-evidence-contract.md` | A | +73 / -0 | — |
| `evidence-b/injection-samples/README.md` | B | +6 / -0 | — |
| `evidence/component-inventory.md` | A | +58 / -0 | — |
| `evidence/d39abol-eval-20261119.json` | C | +33 / -0 | — |
| `evidence/d39abol-eval.js` | C | +63 / -0 | — |
| `evidence/injection-samples/README.md` | C | +5 / -0 | — |
| `matrix/session-display-matrix.md` | A | +51 / -0 | — |
| `repro/collect-hang-evidence.ps1` | A | +56 / -0 | — |
| `repro/procdump-repro.ps1` | A | +91 / -0 | — |
| `repro/windbg-triage.md` | A | +78 / -0 | — |
| `server/friends/lock-bridge.js` | C | +364 / -14 | 契约 §7 暂停守卫在位（enable/update 503）；§5 R-3 已对齐 lockId 优先；§8 API 契约 |
| `server/friends/lock-state.js` | C | +813 / -0 | 契约 §1 并集表／§4 actual_state 优先／§5 事件对账／§6 revision／§9 降级收窄；§14 九项已修（见 REPORT） |
| `server/friends/server.js` | C | +4 / -0 | 登出联动 purgeUser（§10）；无契约偏离 |
| `server/friends/test-lock-bridge-c.js` | C | +127 / -0 | HTTP 烟囱；暂停守卫 503 原文断言 |
| `server/friends/test-lock-p3c.js` | C | +555 / -0 | P3-01 十项＋P3-03 十二项；71/71 |
| `server/friends/test-lock-state.js` | C | +280 / -0 | §1／§4／§5／§6 单元断言；A4 已按并集表更新＋A4b 负向 |
| `server/webapp/ASSETS.json` | C | +6 / -6 | bump-version 同步；lint-versioned-assets 通过 |
| `server/webapp/app-417c329f.js` | C | 改名；C 线约 210 行改动＋P3-05 插入 14 行 | 改名 → app-7005a01d.js（内容同 C 线＋P3-05 R-10 横幅）；ASSETS/index 已同步 |
| `server/webapp/app-9a9df23b.css` | C | 改名（内容 0 行改动） | 改名（内容同 C 线） |
| `server/webapp/index.html` | C | +5 / -5 | 引用新 hash 名；lint-versioned-assets 通过 |
| `server/webapp/qf-runtime-68ae46b6.js` | C | 改名（内容 0 行改动） | 改名（内容同 C 线） |
| `server/webapp/qf-tokens-dfccb65a.css` | C | 改名（内容 0 行改动） | 改名（内容同 C 线） |
| `server/webapp/session-7938edee.css` | C | 改名（内容 0 行改动） | 改名（内容同 C 线） |
| `server/webapp/tests/unit/lock-confirm-web.test.mjs` | C | +239 / -0 | §10 弹窗断言＋P3-05 R-10 横幅断言 |
| `tests/session-ipc-checks.py` | A | +123 / -0 | — |
| `windows/ipc-trust.js` | C | +1 / -0 | qf-lock-challenge 能力登记（§8）；IS_TEST 门禁不变 |
| `windows/lock-confirm.js` | C | +105 / -0 | 弹窗纯逻辑；§10 二次确认 |
| `windows/lock-preload.js` | C | +3 / -2 | qfLock 桥接；无契约偏离 |
| `windows/lock-v2/BUILD-P3B.json` | B | +20 / -0 | B 线构建指纹（历史记录） |
| `windows/lock-v2/BUILD.json` | B | +29 / -0 | 阶段 2 构建指纹（历史记录） |
| `windows/lock-v2/README.md` | B | +54 / -0 | v2 组件说明 |
| `windows/lock-v2/display-power.js` | B | +52 / -0 | §16 真实熄屏（沙箱逻辑；真机待阶段 4） |
| `windows/lock-v2/display-power.ps1` | B | +48 / -0 | §16 熄屏脚本（同上） |
| `windows/lock-v2/envelope-replay.js` | B | +54 / -0 | §6 先查先拒 E_ENVELOPE_REPLAY |
| `windows/lock-v2/failsafe.js` | B | +44 / -0 | §9 FAILSAFE 降级动作 |
| `windows/lock-v2/index.js` | B | +17 / -0 | v2 模块出口 |
| `windows/lock-v2/input-health.js` | B | +202 / -0 | §16 输入健康隔离 |
| `windows/lock-v2/legacy-retirement.js` | B | +172 / -0 | §12 退役（隔离非删除）＋PAUSE_NOTICE 原文 |
| `windows/lock-v2/lock-coordinator.js` | B | +450 / -0 | §2／§5／§6 协调层（事件写入／去重／boot 恢复／三身份） |
| `windows/lock-v2/lock-ipc.js` | B | +149 / -0 | 命名管道 IPC（沙箱逻辑；联调待 P3-06） |
| `windows/lock-v2/lock-state.js` | B | +235 / -0 | §1 并集表（B 补 3 边已修）／§3 status.json v2 |
| `windows/lock-v2/password-vault.js` | B | +108 / -0 | §15 一次性密码（scrypt，10 分钟／5 次） |
| `windows/lock-v2/session-agent.ps1` | B | +223 / -0 | 会话组件（§3 boot_id／session_id／sid 来源） |
| `windows/lock-v2/status-report.js` | B | +188 / -0 | §3 status.json v2（actual_state／revision／三身份） |
| `windows/lock.html` | C | +215 / -15 | §10 弹窗＋P3-05 R-10 横幅；catch 保留 e.code |
| `windows/lock.js` | C | +56 / -7 | 取挑战带 opId（§10）；无契约偏离 |
| `windows/main.js` | C | +2 / -1 | qf-lock-challenge 句柄＋IS_TEST 门禁完整（A16-S2 未损） |
| `windows/package.json` | B | +1 / -0 | 打包清单加 lock-v2/**/*（B 线） |
| `windows/test/lock-confirm-test.js` | C | +93 / -0 | §10 弹窗纯逻辑 12 项 |
| `windows/test/lock-modal-dom-test.js` | C | +225 / -0 | §10 DOM 断言＋P3-05 R-10 M0p |
| `windows/test/lock-test.js` | C | +39 / -5 | 既有 20 项＋C 阶段 2 的 5 项＋C6c＝26 项 |
| `windows/test/lock-v2-8q-test.js` | B | +230 / -0 | 八问 38 项 |
| `windows/test/lock-v2-coordinator-test.js` | B | +159 / -0 | 协调层 19 项 |
| `windows/test/lock-v2-fault-injection-test.js` | B | +150 / -0 | 故障注入 13 项 |
| `windows/test/lock-v2-input-health-test.js` | B | +87 / -0 | 输入健康 15 项 |
| `windows/test/lock-v2-ipc-test.js` | B | +90 / -0 | IPC 7 项 |
| `windows/test/lock-v2-password-test.js` | B | +46 / -0 | 密码 8 项 |
| `windows/test/lock-v2-retirement-test.js` | B | +199 / -0 | 退役 38 项 |
| `windows/test/lock-v2-state-test.js` | B | +89 / -0 | 状态机 18 项（P3-05 F-1 加 E1–E4） |

## §2 合并冲突逐项（共 3 处，均为文档 add/add，代码 0 冲突）

| # | 合并 | 文件 | 冲突点 | 选择 | 理由 |
|---|---|---|---|---|---|
| 1 | C `ca7cda4` | `CONTRACT.md` | B 草案 v2.0.0 vs C v1＋增补，同路径不同内容 | 采用统一契约 v2.0.0 全文（P3-04 锁定本），仅改 §14 F-1 行一处计数 | 两边契约均已被统一契约取代（契约 §17）；B/C 原文保留在 git 历史（`dcd576d`／`a0d8416`）与各自工作树 |
| 2 | C `ca7cda4` | `REPORT.md` | B 阶段 3 报告 vs C 阶段 3 报告，同路径不同内容 | 先立占位 stub，P3-05 最终报告随最后提交覆盖 | 各线报告是过程记录不是产品代码；原文保留在历史与 `wt-p3b`／`wt-p3c` |
| 3 | A `7a4163a` | `REPORT.md` | A 阶段 2 报告 vs 占位 stub | 保留 stub（注明 A/B/C 报告位置） | 同上；A 报告原文在 `f0a0888` 与 `lockfix-phase2/wt-a/REPORT.md` |

## §3 契约逐项复核（合并后对照 v2.0.0）

| 契约节 | 复核结果 |
|---|---|
| §1 转移表（并集） | **PASS**：B 代码补 3 边、C 代码补 1 边后，双端 `TRANSITIONS` 均等于并集表；`RECOVERY_REQUIRED → UNLOCKING` 双端均无；`LOCKED → UNLOCKED` 直达双端均禁（P3E F1-1～F1-6 断言）。集成 `CONTRACT.md` §1 即并集表；C 旧文字表的三行错误（LOCKING 漏 UNLOCKED、UNLOCKING 漏 LOCKED、RECOVERY_REQUIRED 错写）已由替换纠正 |
| §3 status.json v2 | **PASS**：B `buildStatus` 字段全（`actual_state`／`revision`／三身份／`armedAt`）；8Q 测试 38/38 |
| §4 对账（actual_state 优先） | **PASS**：C `classifyDeviceStatus` 优先读 `actual_state`，v1 回落 `state`（P3E F2-1～F2-6）；心跳过期仍先判 UNKNOWN |
| §5 事件对账 | **PASS**：disarm／unlock-ok 均 lockId 优先＋时间窗口兜底；桥 disable 谓词已同口径（P3E R3-1～R3-6）；无 fields unlock-ok 须过窗口（P3E R4-1～R4-3） |
| §6 revision 与幂等 | **PASS**：v2 缺 revision → `RECOVERY_REQUIRED`（`revision-missing`），v1 跳过（P3E R7-1～R7-4）；信封先查先拒（B `EnvelopeReplayGuard`＋集成契约 §6） |
| §7 暂停守卫 | **PASS**：enable／update 守卫原样在位（`lock-bridge.js:1083／1088`），无白名单例外；P3C 71/71 仍过 |
| §8 API 契约 | **PASS**：挑战／disable／agent-grant 链路未动，P3C 71/71 仍过 |
| §9 降级收窄 | **PASS（本线实测，待 P3-06 改判 #9）**：`degradedFromStatus` 只在 LOCKED／LOCKING 下映射（P3E R9-1～R9-7）；#9-C2／C3 原 FAIL 点现 PASS |
| §10 分级认证 | **PASS**：P3C 71/71 仍过；无改动 |
| §11 过渡期兜底 | **PASS**：时间窗口＋`boot_id` 兜底保留；旧 Go 未打补丁 |
| §12 退役 | **PASS**：措辞“隔离＋另行批准才删”；四文件 SHA 与阶段 2 一致；退役测试 38/38 |
| §13 D39ABOL 冻结 | **PASS**：未碰 D39ABOL；UNKNOWN 未改；无复现、无删除 |
| §14 差异清单 | 9 项代码缺口已修（R-9／R-7／F-2／F-1／R-3／R-4／R-6／R-10／F-3），见 REPORT.md §3；M-1 只记录，不由本线修 |
| §15／§16 | **PASS（沙箱逻辑）**：密码 8/8、输入健康 15/15、熄屏逻辑在位；真机待阶段 4 |

## §4 A16-S2 关键文件核对（合并前后逐项 diff）

16 个 A16-S2 文件（`git diff 9b06449..049d876 --name-only`）中 14 个逐字节相同；2 个为预期改动：

| 文件 | 结果 | 说明 |
|---|---|---|
| `windows/build-flavor.js`、`windows/lea-login-retry.js`、`windows/scripts/build-test-main.js`、`windows/test-policy.js`、`windows/test/lea-firstinstall-a1-test.js`、`windows/test/lea-login-retry-test.js`、`windows/test/mc-midgroup-test.js`、`windows/test/permission-policy-test.js`、`windows/test/r10-bootlog-fallback-test.js`、`windows/test/test-mode-gates-test.js`、`windows/test/test-policy-test.js`、`windows/test/update-lea-backfill-test.js`、`windows/tools/check-build-flavor.js`、`windows/tools/check-electron-safety.js` | **SAME**（SHA 与基线一致） | 未动 |
| `windows/main.js` | **DIFF（预期）** | 仅 C 线两处：`qf-lock-disable` 加 `opts` 透传、`qf-lock-challenge` 新句柄；两处均保留 `IS_TEST ? testPolicy.testDenied(...)` 门禁；`testDenied` 出现次数 4 → 5（新增门禁 1 处） |
| `windows/package.json` | **DIFF（预期）** | 仅 B 线一行：打包清单加 `lock-v2/**/*` |
| `windows/privacy-lock/app/` 四个旧 EXE | **SAME** | SHA 与 VERIFY-P3B 一致（见 REPORT.md §5）；`git diff 049d876..HEAD` 在该目录为空 |

## §5 P3-05 自有文件（不在合并表内，随 §14／交付提交）

| 文件 | 说明 |
|---|---|
| `server/friends/test-lock-p3e.js` | §14 验收测试 35/35（新增，随 `0152574`） |
| `windows/lock-v2/BUILD-P3E.json` | 构建 SHA：62 文件逐个 SHA＋包 SHA（方法见文件内 `method` 字段，可复算） |
| `REPORT.md` | P3-05 报告（本线最终版，随最后提交覆盖合并占位） |
| `MERGE-CHECKLIST.md` | 本文件 |

