# C 线工作报告 — 阶段 3 P3-01 /lock/update 暂停门禁 ＋ P3-03 分级重新认证契约

- 日期：2026-11-19 04:3x–05:xx（Asia/Shanghai）
- 分支：`a16s2-lockfix-p3-c`；基线：`46e39f2`（阶段 2 C 线提交）
- 任务书：`~/workspace/qfremote/a16-s2-20261118/phase-2-closeout/lockfix-phase3/task-briefs/brief-p3c.md`
- 定夺：`~/workspace/qfremote/gpt-a16s2-lockfix-3items-ruling-20261119.md`（2026-11-19 04:25 取回，思考 3m 51s），§1（P3-01）／§3（P3-03）／§4（阶段 3 衔接）
- 契约：本工作区 `CONTRACT.md`（服务端侧 v1＋P3-01／P3-03 增补，§7／§8／§9 补记／§11）
- 阶段 2 报告原文：`~/workspace/qfremote/a16-s2-20261118/phase-2-closeout/lockfix-phase2/wt-c/REPORT.md`（本文件只写阶段 3，不覆写阶段 2 结论）

## 结论先行

- **P3-01 十项验收全部 PASS（实跑）**：`/lock/update` 与 `/lock/enable` 同步冻结，无白名单例外；站长账号同样拒绝；重试／后台任务 0 副作用；未登录先 401 不泄露；只读诊断与安全恢复路径可用；重启后暂停仍有效（暂停写死在代码里）。
- **P3-03 十二项验收全部 PASS（实跑）**：正常所有者免输密码解锁；未登录／非机主拒绝；挑战过期／重放／跨设备／跨会话／错编号／revision 变化全部拒绝；增强保护与 UNKNOWN 记录必须升级认证、无密码／错密码不降级；并发双击恰一次真实操作；AI 会话借用 UI 挑战被拒、持独立授权可解锁、撤销后失效。
- **回归全量 363 项断言全部通过（实跑）**：阶段 2 的 286 项原样重跑全过（58＋66＋9＋18＋31＋12＋20＋25＋47），新增 P3C 71 项、DOM 测试新增 5 项、真桥测试新增 1 项；网页端一键门禁 `run.mjs` 5/5 通过。
- **本轮挖出并修掉一个阶段 2 真 bug**：`applyCorrection` 的 op-id 重放检查把同一操作的 `disarm:start` 迁移也算成修正，导致成功解锁后服务端记录永久卡在 `UNLOCKING`（响应却报 `UNLOCKED`）。已收紧为只认 `correction:` 动作，阶段 2 修正重放测试仍全过。详见 §4。
- **阶段 1 四行暂停守卫原样保留（逐字核实）**；未解除任何暂停；未开任何白名单；未碰 D39ABOL；未宣布锁已修好——隐私锁仍是 P0 阻断项，3.0.0 发版维持 NO-GO。
- **残留（诚实说明，不虚报）**：① HTTP 层无调用方类型信号，AI 授权的“自动化调用方必须出示授权”是契约＋审计要求，硬性防线是挑战 sessionKey 绑定；② 无独立 CSRF token（既有姿态，依赖 SameSite＋单次挑战）；③ 会话可信度无独立评分（桥内恒传 false，防护靠 sessionKey＋吊销）；④ 增强保护控制台开关 UI 未做，只有服务端契约＋运维文件登记口径。均已写入 CONTRACT.md §11。
- 本线工作期间**未遇到疑似提示词注入**（`evidence/injection-samples/` 沿用阶段 2 的 README，无新增样本）。

## 验收总表

| # | 验收项 | 结果 | 证据 |
|---|---|---|---|
| P3-01 | /lock/update 暂停门禁（裁决 §1.4 十项） | **PASS 10/10**（实跑） | §1；`test-lock-p3c.js` P01-1～10＋audit／guard |
| P3-03 | 分级重新认证契约（裁决 §3.4 十二项） | **PASS 12/12**（实跑） | §2；`test-lock-p3c.js` P03-1～12（过期见 A2i 单元） |
| R1 | 阶段 2 回归（286 项） | **PASS**（实跑） | §5 |
| R2 | 网页端一键门禁 `run.mjs` 5 步 | **PASS**（实跑；acorn 在工作区内装好后全绿，见 §5） | §5 |
| R3 | CONTRACT.md 更新（P3-01＋P3-03＋§9 回填） | **PASS** | CONTRACT.md §7／§8／§9 补记／§11 |
| R4 | 阶段 1 暂停守卫原样保留 | **PASS**（逐字核实） | §3 |
| R5 | 阶段 2 真 bug 修复（applyCorrection 重放误判） | **PASS**（实跑，见 §4） | §4；`test-lock-state.js` 58/58 |
| B1 | D39ABOL 真机复验 | **BLOCKED**（未碰，待阶段 4） | — |
| B2 | B/C 契约 8 问闭合（P3-04） | **BLOCKED**（另线，见 CONTRACT.md §9） | — |
| B3 | 真机远控回归 | **BLOCKED**（待笔记本回线／腾讯机交互会话） | — |

## §1 P3-01 /lock/update 暂停门禁（裁决 §1.4 十项，逐项实跑）

测试载体：`server/friends/test-lock-p3c.js`（假 MeshCentral control 通道：本地 ws 服务端实现 userinfo／nodes／runcommands，设备 status.json 用 Base64 回传；disarm 信封投递＋apply 后翻 Off＋补 disarm 事件；副作用用 inbox 写入／apply 调用／版本号三计数断言）。

| # | 验收项（裁决 §1.4） | 结果 | 实跑证据 |
|---|---|---|---|
| 1 | 普通用户 enable 503，0 锁定副作用 | **PASS** | P01-1：503 原维护文案；inbox 0／apply 0／设备仍锁定 |
| 2 | 站长账号 enable 暂停期仍拒绝 | **PASS** | P01-2：站长账号（`isSiteAdmin=true`）同样 503，0 副作用 |
| 3 | 普通用户 update 503，0 更新副作用 | **PASS** | P01-3／3b：503＋`code: lock-remediation-paused`；inbox 0／apply 0／版本仍 2.4.5；空体同样 503（守卫先于参数校验） |
| 4 | 站长账号 update 暂停期仍拒绝 | **PASS** | P01-4：站长账号同样 503＋统一码，0 副作用 |
| 5 | 后台更新任务不得绕过暂停 | **PASS** | P01-5：update 重试两次＋静置 1.5 秒仍 0 副作用；全仓 grep：唯一能构造 update 信封并投递的路径就是桥内 `/lock/update` 分支，无独立后台任务／重试队列（重试只能以新 HTTP 请求重进 `handle()`，必撞守卫） |
| 6 | 旧请求／重试任务不能在暂停状态重新启动危险操作 | **PASS** | P01-6：enable／update 重试均 503，0 副作用 |
| 7 | 未授权请求不能因暂停机制泄露敏感信息或获得权限 | **PASS** | P01-7：未登录 update／enable → 401（不给 503 暂停信息、不泄露设备存在）；顺序为先鉴权＋封禁、后暂停（按原路由契约） |
| 8 | 只读诊断正常可用 | **PASS** | P01-8：`GET /lock/devices` → 200 一台机主设备 |
| 9 | 安全恢复操作经授权后可用 | **PASS** | P01-9a／9b：disable 缺挑战 → 409（不是 503）、reset 缺密码 → 400（不是 503），恢复路径未被冻结；P01-9c：受控修复占位 `POST /lock/repair` → 503 `lock-repair-not-available`、0 副作用（只留接口，不实现放行逻辑） |
| 10 | 服务重启后暂停策略仍有效 | **PASS** | P01-10：全新桥实例（新内存表，模拟重启）update／enable 仍 503；暂停是写死在代码里的常量守卫（`LOCK_REMEDIATION_PAUSE.enabled=true`），不是运行时开关 |

补充断言（同文件实跑）：暂停拒绝记结构化审计（`lock-remediation-paused op=<路径> account=<账号> code=lock-remediation-paused`，不含秘密）；阶段 1 四行守卫逐字一致（源码比对）；`deliverEnvelope` 第二道拦截在位（`arm`／`update` 信封到不了设备）。

实现位置：`server/friends/lock-state.js`（`LOCK_REMEDIATION_PAUSE` 常量＋`isLockRemediationPaused()`）；`server/friends/lock-bridge.js`（update 守卫、暂停审计、`deliverEnvelope` 第二道拦截、`/lock/repair` 占位）。enable 的 4 行守卫一字未动（响应保持 503＋原维护文案、无 code 字段——刻意保留以兼容既有客户端与测试）；update 用同一错误标识 `lock-remediation-paused`＋更新专用文案。

## §2 P3-03 分级重新认证契约（裁决 §3.4 十二项，逐项实跑）

| # | 验收项（裁决 §3.4） | 结果 | 实跑证据 |
|---|---|---|---|
| 1 | 正常所有者、有效可信会话：不重新输入登录密码完成授权解锁 | **PASS** | P03-1：200 `UNLOCKED`，恰一次真实操作（apply 1 次） |
| 2 | 未登录用户拒绝 | **PASS** | P03-2：401 |
| 3 | 非设备所有者且无授权拒绝 | **PASS** | P03-3：取挑战 403、提交伪造挑战 409 `challenge-invalid` |
| 4 | 挑战过期或重复使用拒绝 | **PASS** | P03-4：已消费挑战重放 → 409 `challenge-invalid`；过期见 A2i 单元（可控时钟推进 5 分钟＋1 毫秒 → `challenge-expired`） |
| 5 | 挑战绑定其他设备拒绝 | **PASS** | P03-5：409 `challenge-binding-mismatch` |
| 6 | revision 已变化：不执行旧请求，要求重新获取状态 | **PASS** | P03-6：挑战绑定的 revision 与当前记录不一致 → 409 `revision-stale`、设备仍锁定 |
| 7 | 用户开启增强保护：必须完成配置的升级认证 | **PASS** | P03-7a／7b／7c：未输密码 → 403 `step-up-required`；密码错误 → 403 `badLoginPw`；密码正确 → 200 解锁 |
| 8 | 会话撤销后重放挑战拒绝 | **PASS** | P03-8：`purgeUser('alice')` 后重放 → 409 `challenge-invalid`（退出登录／封禁联动同款入口；登出分支已联动 `lockBridge.purgeUser`） |
| 9 | 高风险操作无法完成升级认证不得降级为普通确认 | **PASS** | P03-9：P03-7a／7b／10a 均证实无密码／错密码皆拒绝 |
| 10 | UNKNOWN 锁状态不能通过正常解锁路径直接清状态 | **PASS** | P03-10a：正常路径 → 403 `step-up-required`，记录仍 UNKNOWN、设备仍锁定；P03-10b：升级认证通过＋设备强证据（disarm 事件）→ 200 解锁（非“输密码即清状态”） |
| 11 | 连续快速点击确认：实际操作最多执行一次、结果可查询 | **PASS** | P03-11：并发双击恰一次 200、恰一次真实操作（apply 增量 1、disarm 事件 1 条）；事后同编号提交 → 200 `replayed: true` |
| 12 | AI 代理无明确授权不允许借用用户界面权限直接解锁 | **PASS** | P03-12a：AI 会话（同一账号、另一会话 Cookie）借用 UI 会话挑战 → 409（挑战绑定会话）；12b：机主签发授权 200；12c：AI 会话持授权＋自己的挑战 → 200；12d：已撤销授权再用 → 409 `agent-grant-invalid`；12e：非机主签发授权 → 403 |

实现位置：`server/friends/lock-state.js`（挑战全绑定：`lockId／revision／operationId／sessionKey`；`classifyUnlockRisk` 三级分级；`createEnhancedAuthStore` 运维文件登记；`createAgentGrantStore` 单设备／仅 disarm／15 分钟单次／可撤销）；`server/friends/lock-bridge.js`（挑战签发／校验全绑定、风险门 `step-up-required`、AI 授权签发／撤销／验用端点、`purgeUser` 吊销联动）；`server/friends/server.js`（登出分支联动 `lockBridge.purgeUser`，3 行）；两端前端（取挑战带 `opId`，`step-up-required` 时弹窗不消失、提示输密码并聚焦密码栏）。

附带修掉的前端真问题：Electron 真实路径里 `qfLock.disable` 的 catch 会丢掉 `e.code`，导致 `revision-stale`／`step-up-required` 分支在真实路径走不到（阶段 2 DOM 测试用桩返回对象才走得到）。`windows/lock.html` 的 catch 已改为保留 `code`（只改这一行）。

## §3 阶段 1 暂停守卫原样保留（实核）

- `git diff` 确认阶段 1 四行守卫一字未动（见 §1 P01-guard 源码逐字比对测试）；`POST /lock/enable` 响应保持 503＋原维护文案。
- 暂停审计只记日志、不改判；update 守卫与 repair 占位、agent-grant 端点均在守卫之后、共享写路径之前，不触及 enable 分支。

## §4 本轮挖出的阶段 2 真 bug 与修复（applyCorrection 重放误判）

- **现象（首轮测试 68/71，三项失败）**：P03-4／P03-11／P03-12c 在提交时报 `revision-stale`，而 P03-1 同流程通过。逐项实查发现：成功解锁后服务端记录停在 `UNLOCKING`（响应却报 `UNLOCKED`），后续读路径对账把它翻回 `LOCKED`（revision＋1），再提交即 revision 不一致。
- **根因**：`applyCorrection` 的 op-id 重放检查认所有同 `op_id` 的审计条目；`/lock/disable` 正常流程先以同一 `operationId` 记一条 `disarm:start` 迁移（LOCKED→UNLOCKING），成功后再以同一编号调 `applyCorrection` 落 UNLOCKED——旧检查把前者误判为“修正已执行”而拒绝（`op-id-replayed`），记录永久卡在 `UNLOCKING`。阶段 2 单测没抓到，因为它只测了“修正重放拒绝”，没测“disable 成功后记录终态”。
- **修复**：重放检查只认 `correction:` 开头的修正动作（`lock-state.js`，仅修正动作由 `applyCorrection` 产生）。阶段 2 修正重放测试仍全过（`test-lock-state.js` 58/58，D／H 节在内）；修复后记录正确落 `UNLOCKED`（revision＋2，两步审计），重跑 P3C 71/71。
- **影响面**：只改重放判定条件，不改迁移表、不改证据规则；D39ABOL 修正重放仍被拒绝（同款 `correction:` 动作）。

## §5 回归测试（全部实跑，沙箱）

环境：Node v24.22.1；jsdom（`/home/hatch/node_modules/jsdom`）；`ws` 可解析；Playwright 未安装（E2E 仍 BLOCKED，同阶段 2）。

| 套件 | 结果 | 覆盖 |
|---|---|---|
| `server/friends/test-lock-state.js` | **58 passed, 0 failed** | 阶段 2 原样（含 D／H 节修正重放） |
| `server/friends/test-lock-bridge.js` | **66 passed, 0 failed** | 桥既有行为无回归 |
| `server/friends/test-lock-bridge-c.js` | **9 passed, 0 failed** | HTTP 烟囱（暂停守卫 503 原文仍断言通过） |
| `server/friends/test-lock-envelope.js` | **18 passed, 0 failed** | 信封签名／TTL／nonce |
| `server/friends/test-logic.js` | **31 过 / 0 挂** | 远控既有逻辑无回归 |
| `server/friends/test-lock-p3c.js`（新增） | **71 passed, 0 failed** | A 节 34 项单元（暂停／挑战全绑定／风险分级／增强保护／AI 授权）＋B 节 37 项 HTTP（P3-01 十项＋P3-03 十二项＋守卫／审计／重启） |
| `windows/test/lock-confirm-test.js` | **12 passed, 0 failed** | 弹窗纯逻辑 |
| `windows/test/lock-modal-dom-test.js` | **25 passed, 0 failed** | 阶段 2 的 20 项＋新增 M9b（取挑战带操作编号）＋M16b～M16e（step-up 弹窗行为） |
| `windows/test/lock-test.js` | **pass: true（26 个 case）** | 阶段 2 的 25 个 case＋新增 C6c（真桥取挑战带 opId） |
| `server/webapp/tests/unit/` 全套 | **47 passed, 0 failed** | 阶段 2 的 46 项＋锁确认弹窗 1 项（内含新增 opId 绑定与 step-up 断言） |
| `server/webapp/tests/run.mjs` | **5/5 PASS** | lint-no-colors／lint-no-cycles／lint-no-hardcoded-i18n／lint-versioned-assets／unit |
| `windows/test/device-unlock-test.js` | **pass: true** | 设备解锁既有回归（顺带跑） |
| `windows/test/client-version-test.js` | **pass: true** | 客户端版本既有回归（顺带跑） |

**合计 363 项断言，全部通过**（58+66+9+18+31+71+12+25+26+47；网页锁确认测试计在 47 内，不重复计）。

**acorn**：阶段 2 因沙箱缺 acorn 有 2 步 FAIL；本轮按任务书在工作区内 `npm install --no-save acorn`（`server/webapp/tests/node_modules/`，gitignored，不入库），重跑后 5/5 全绿。`bump-version.mjs` 已跑：`app-57927eee.js → app-417c329f.js`（内容仅为本次两处改动：取挑战带 opId、step-up 分支；其余文件 keep），`ASSETS.json` 与 `index.html` 已同步。

**首轮失败与修复**：`test-lock-p3c.js` 首轮 68/71（P03-4／P03-11／P03-12c 失败），根因为 §4 的真 bug＋测试侧 15 秒状态缓存旧快照（测试改用 `?force=1` 取新鲜状态，与前端“重新加载”同款）；修复＋重跑后 71/71。另：`windows/test/ipc-sender-test.js` 在本线与**基线 46e39f2 均失败**（E1／E2／E6：IPC 注册计数 36／29／65 不符，基线已存在，与本线改动无关——本线未碰 `windows/main.js` 与 IPC 注册；已用临时 worktree 在基线复核），记为基线既有失败，非回归。

**真机远控回归**：沙箱既有回归集已跑；真机远控回归仍待阶段 3／阶段 4（笔记本回线／腾讯机交互会话后）。

## §6 改动清单（分支 `a16s2-lockfix-p3-c` 上的提交）

- `server/friends/lock-state.js`：`LOCK_REMEDIATION_PAUSE` 常量；挑战全绑定＋吊销；`classifyUnlockRisk`；`createEnhancedAuthStore`；`createAgentGrantStore`；`applyCorrection` 重放检查收紧（§4）。
- `server/friends/lock-bridge.js`：`/lock/update` 暂停守卫＋暂停审计；`deliverEnvelope` 第二道拦截；`/lock/repair` 占位；挑战签发／校验全绑定；风险门与升级认证；AI 授权签发／撤销／验用；`purgeUser` 吊销联动；`_stores` 测试接缝。
- `server/friends/server.js`：登出分支联动 `lockBridge.purgeUser`（3 行）。
- `server/friends/test-lock-p3c.js`（新增，71 项）。
- `windows/lock.js`：`challenge(id, op, operationId)` 取挑战带操作编号。
- `windows/lock.html`：两次取挑战传操作编号；`step-up-required` 分支；catch 保留 `e.code`（§2 附带修复）。
- `windows/test/lock-modal-dom-test.js`／`windows/test/lock-test.js`：新增断言（M9b／M16b～e／C6c）。
- `server/webapp/app-417c329f.js`（由 `app-57927eee.js` 改名而来，内容仅两处改动）＋`ASSETS.json`＋`index.html`（bump-version 同步）；`server/webapp/tests/unit/lock-confirm-web.test.mjs`（opId 与 step-up 断言）。
- `CONTRACT.md`：§7（P3-01）、§8（新接口与错误码）、§9 补记（C 侧三项回填）、§11（P3-03 分级认证契约）。
- 注入样本：无新增（`evidence/injection-samples/` 沿用阶段 2 的 README）。

## §7 未做与待办（不虚报）

- D39ABOL：未碰状态与文件，仍 UNKNOWN；修正未执行。
- B/C 契约 8 问闭合（P3-04）：另线，本线只做了 C 侧回填（§9 补记）。
- 真机联调／阶段 4：待交互会话与笔记本回线；本轮全部为沙箱实跑，假通道代替真机（已在表中注明）。
- 锁 bug 本身未宣布修好；根因仍未确认；发版维持 NO-GO。
