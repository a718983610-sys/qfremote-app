# C 线工作报告 — QFRemote 隐私锁 P0 修复（服务端状态对账＋远程解除锁定授权＋前端确认交互＋回归测试）

- 日期：2026-11-19 03:04–03:xx（Asia/Shanghai）
- 分支：`a16s2-lockfix-c`；基线：`049d876`（正式 RC 源码起点）
- 任务书：`~/workspace/qfremote/a16-s2-20261118/phase-2-closeout/lockfix-phase1/task-briefs/brief-c.md`
- 定夺：`~/workspace/qfremote/gpt-a16s2-lockbug-ruling-20261119.md`（2026-11-19 02:27）
- 契约：本工作区 `CONTRACT.md`（服务端侧 v1）
- 报告文件：`~/workspace/qfremote/a16-s2-20261118/phase-2-closeout/lockfix-phase2/wt-c/REPORT.md`

## 结论先行

- 服务端六态状态机＋幂等对账＋操作挑战＋操作编号＋冻结 revision＋可选登录密码重认证已实现，沙箱单测 58/58；两端前端独立弹窗已实现，DOM 测试 20/20、网页 jsdom 测试 1/1；回归全量 286 项断言全部通过（实跑，见 §5）。
- D39ABOL 当前分类 **`UNKNOWN` 待核查**：设备不可达，弱证据修正到 `UNLOCKED` 已实跑拒绝；修正**未执行**，须等笔记本回线、设备端确认并给出强证据后带操作编号执行（证据 `evidence/d39abol-eval-20261119.json`）。
- LOCK-SEC-01 审核结论：**旧实现“部分符合契约”**（鉴权与机主核对到位；新鲜性／幂等／重放防护缺失，定为中危缺口，非已利用漏洞）；**修后服务端＋两端前端均已补齐**，沙箱单测与 DOM 测试通过；剩余两项待确认（设备端信封去重书面确认、挑战／操作编号内存表重启失效），真机联调后复验（见 §3）。
- 阶段 1 暂停守卫原样保留（`lock-bridge.js:1024–1027`，实核在位）；未擅自解除暂停；未动生产服务；未碰笔记本、未开桥会话、未用浏览器。
- 本线工作期间**未遇到疑似提示词注入**（`evidence/injection-samples/README.md`）。

## 验收总表

| # | 验收项（任务书） | 结果 | 证据 |
|---|---|---|---|
| 1 | 服务端锁状态机（六态＋DEGRADED／FAILSAFE，记录字段齐全） | **PASS**（实跑） | `server/friends/lock-state.js`；单测 58/58（含 A 节 7 项） |
| 2 | 幂等对账与 D39ABOL 旧状态修正（带操作编号、保留原记录、不删状态文件） | **PASS**（实跑，修正未执行） | `evidence/d39abol-eval-20261119.json`；单测 D 节 6 项＋H 节 3 项 |
| 3 | LOCK-SEC-01 远程解除锁定授权审核（逐项结论） | **PASS**（代码实读＋沙箱测试；两项待真机复验） | §3；单测 F 节 6 项、桥烟囱 9/9 |
| 4 | 前端确认交互（独立弹窗、不受轮询重渲染影响、冻结 device_id／lock_id／revision、60 秒刷新测试） | **PASS**（实跑） | DOM 测试 20/20；网页 jsdom 测试 1/1 |
| 5 | 回归测试（锁全矩阵＋2.4.4 远控无回归） | **PASS**（实跑，沙箱级；真机远控回归待阶段 3／4） | §5，286 项全过 |
| 6 | `/lock/update` 暂停期处理与本地手动运行 `QFLockUI.exe` 边界的定夺建议 | **PASS**（建议已出，未改代码） | §6 |
| 7 | 协议契约 CONTRACT.md（与 B 线逐项对齐） | **PASS**（服务端侧 v1；B 线对齐待 B 线提交后复核） | `CONTRACT.md` §9 |
| 8 | 阶段 1 暂停守卫原样保留 | **PASS**（实核） | §7 |
| 9 | 设备端联调（待 B 线新组件） | **BLOCKED** | B 线新组件未就绪 |
| 10 | D39ABOL 真机复验（阶段 4，待笔记本回线） | **BLOCKED** | 笔记本未回线 |
| 11 | 网页端 Playwright E2E | **BLOCKED** | 沙箱无 Playwright（jsdom 测试已替补覆盖同规则） |
| 12 | B 线 CONTRACT.md 对齐 | **BLOCKED** | `wt-b` 截至 2026-11-19 03:xx 未见 CONTRACT.md |

## §1 服务端锁状态机（`server/friends/lock-state.js`，新增）

- 六态 `UNLOCKED / LOCKING / LOCKED / UNLOCKING / UNKNOWN / RECOVERY_REQUIRED`＋迁移表（`LOCKED→UNLOCKED` 不许直达，须经 `UNLOCKING` 两步）；`degraded`（`DEGRADED / FAILSAFE`）与六态正交。
- 记录字段齐全：`lock_id, device_id, boot_id, session_id, sid, revision, desired_state, actual_state, last_heartbeat, last_error`，另有 `created_at, updated_at, degraded, history[]`。
- 对账规则（`classifyDeviceStatus`／`reconcileRecord`）：
  - 读不到设备 → `UNKNOWN`，永不判 `UNLOCKED`；`updatedAt` 超 2 分钟未更新 → `UNKNOWN`（`stale-heartbeat`，与设备契约 §2 同口径）；心跳优先取 `status.updatedAt`。
  - 设备报 `Off` 无强证据且曾锁定 → `RECOVERY_REQUIRED`；强证据：`disarm` 事件、`unlock-ok` 事件（本地输密码解锁）、`boot_id` 变化、`boot-recovered` 事件（status.json v1 无 `boot_id` 时的过渡证明）。
  - `fault` 字段（`state-corrupt`）或 `state==='Fault'` → `RECOVERY_REQUIRED`；设备上报 `revision` 旧于服务端 → `RECOVERY_REQUIRED`；`captureExclusion=failed-degraded|unknown` 记 `degraded=DEGRADED`。
  - 无服务端记录时以设备自报建基线；读路径只在拿到新鲜 status 时并入记录（不翻 `UNKNOWN`，避免轮询抖动冲掉弹窗 `revision`）。
- 幂等修正（`applyCorrection`）：须 `op_id`＋理由；同一编号重复拒绝；离开曾锁定态去 `UNLOCKED` 须强证据；保留原记录、不删文件、不改 `created_at`；两步审计。
- 操作挑战：5 分钟、单次消费、绑定账号＋设备＋操作；先查表再判过期。操作编号：只缓存成功结果 24 小时，失败不缓存。
- 记录存储：内存＋可选文件持久化（原子 tmp＋rename；写盘失败只记日志；文件损坏保留内存表、不删文件）。
- 与设备端契约对齐（`privacy-lock-impl/CONTRACT.md` v1 实读）：`unlock-ok`／`boot-recovered` 事件、`updatedAt` 2 分钟规则、`fault` 字段、`captureExclusion` 均按设备契约实现；`disarm` 事件无 `lockId`、status.json 无 `boot_id/session_id/sid/revision` 四项已列入 CONTRACT.md §9 待 B 线确认（服务端已用时间窗口兜底）。

## §2 D39ABOL 对账评估（实跑）

脚本 `evidence/d39abol-eval.js`，输入阶段 1 保全的原始记录 `lockfix-phase1/evidence/lock-records-20261119.jsonl`（298 行，实测 SHA-256 `982b78274e390555f6d255fd215716f2310fe5def49d15b3d44b59da4b177db1`，与阶段 1 报告一致），输出 `evidence/d39abol-eval-20261119.json`（SHA-256 `aa9be9128d3d2fca2aafed2fe3a92626d933d3ae88cc54a6d6800a763716cc20`）：

- arm 成功 **4 次**（2026-11-15T16:40:38.283Z、16:44:38.404Z、16:45:33.418Z、2026-11-18T17:11:58.053Z）；disarm 成功 **1 次**（2026-11-15T16:46:11.980Z）；最后一次 arm 之后 disarm 成功 **0 次**。
  - 注：初版脚本曾把 `disarm 成功` 也算进 `arm 成功`（子串匹配），计成 5 次；已修正为排除 `disarm` 后再计，4/1 与阶段 1 报告一致。
- 步骤 1（设备不可达）：`UNKNOWN`（`device-unreachable`）——不得定论未锁定。
- 步骤 2（弱证据修正到 `UNLOCKED`）**拒绝**（`evidence-insufficient`）——修正未执行。
- 步骤 3（设备报 `Off` 无证明）：`RECOVERY_REQUIRED`（`off-without-proof`）。
- 结论：服务端仍持有过期 `LOCKED`；修正须等笔记本回线、设备端确认无活跃锁并给出强证据后，带操作编号执行。

## §3 LOCK-SEC-01 审核结论（逐项）

审核方式：**代码实读**（本工作区 `lock-bridge.js`／`lock-envelope.js`，行号为本工作区当前行号）＋**沙箱单测**；未做生产探针（任务红线：不动生产服务）。

| # | 核查项 | 旧实现（基线 049d876） | 修后 | 结论 |
|---|---|---|---|---|
| 1 | 会话鉴权 | `qfr_frd` 会话优先，否则 `xid` cookie 经 `mcConnectCookie` 校验（`lock-bridge.js:763–782`）；未登录 401 | 不变 | **符合契约** |
| 2 | 机主核对 | 写路径 fresh 实读 `status.json` 的 `ownerUsername`＋别名＋设备 pin（`lock-bridge.js:792–847`）；非机主 403；读不到回 503 不回 403 | 不变 | **符合契约** |
| 3 | 封禁门 | 鉴权后校验 `isBanLinked`（`:963`），命中 403 | 不变 | **符合契约** |
| 4 | 新鲜性／重放防护（旧 `/lock/disable`） | 只有二次点击＋会话＋机主；无挑战、无操作编号、无 revision、无重新认证。重复点击与并发重放可导致两次真实投递（状态检查能挡顺序重放，挡不住并发双投递） | 挑战（5 分钟单次）＋operationId（24h 成功缓存）＋冻结 revision＋可选登录密码重认证；幂等重放先查 | **旧：部分符合契约（中危缺口，非已利用漏洞）；修后：符合契约** |
| 5 | 信封重放 | Ed25519 签名；disarm TTL 30 分钟、随机 nonce（`lock-envelope.js:101`） | 不变（服务端侧再加 operationId 去重） | **符合契约**；设备端重复信封必拒待 B 线书面确认（CONTRACT.md §9 #8） |
| 6 | 短时重新认证 | `/lock/reset` 已有登录密码真验证＋5 次／15 分钟限流＋并发单飞（`lock-bridge.js:121–162, 1221–1232`）；`/lock/disable` 无 | `disable` 新增可选 `loginPassword` 重认证（独立限流 5 次／15 分钟，`:1114–1128`）；不填则走四重校验 | **符合契约**（“不能仅依赖二次点击”已满足）；是否强制密码重认证为产品决策，建议维持可选（见下） |
| 7 | `xid` 会话缓存 | 30 秒（`:773`）；封禁联动 purge 会清缓存（`:1263–1269`） | 不变 | **已知残留，非本次引入**：会话撤销后最长 30 秒内仍可被认；封禁路径已联动清缓存，风险低 |
| 8 | TOFU 首见信任 | 机主 pin 首见信任（代码注释已明示，运维 pin 可覆盖） | 不变 | **已知残留边界**，非本次引入 |
| 9 | `/lock/update` 与 `/lock/reset` 授权 | update：机主＋签名信封＋版本／URL 白名单／SHA 预检；reset：机主＋登录密码真验证＋限流 | 不变 | **符合契约** |
| 10 | 挑战／操作编号存储 | — | 内存表（`lock-state.js` 内 `Map`） | **已知限制**：服务重启后旧 operationId／挑战失效；重启后同一编号可重新提交一次，但 revision 与设备状态仍会校验，第二次真实解锁仍须设备处于 `LOCKED` 且挑战有效。建议后续落盘或由部署方确认可接受 |

**总 verdict**：LOCK-SEC-01 —— 旧实现“部分符合契约”（鉴权与机主核对到位；新鲜性／幂等／重放防护缺失，定为中危缺口）；修后服务端＋两端前端均已补齐，沙箱单测与 DOM 测试通过。剩余待确认两项（#5 设备端信封去重、#10 内存表重启失效）须真机联调后复验。

**关于“是否强制登录密码重认证”的建议**：维持可选。理由：站长单人机主＋会话已强认证（`qfr_frd`／`xid`），再加挑战＋编号＋revision 四重校验已满足“不能仅依赖二次点击”；强制每次输密码会抬高日常操作门槛（用户最烦多动手）。若后续安全评审要求强制，改一行即可（把 `loginPassword` 从可选改必填）。决定权在协调人。

## §4 前端确认交互

- Electron（`windows/lock.html`／`lock.js`／`lock-preload.js`／`main.js`／`ipc-trust.js`）：删除旧“再次点击＋3.5 秒自动取消”确认态，改为独立弹窗（`body` 直接子节点，在 `#list / #stateBox` 之外，重渲染碰不到）；冻结快照＋挑战＋操作编号；取挑战后才启用确认按钮；提交中禁用；`revision-stale` 留弹窗刷新快照＋取新挑战；超时只显示准确错误；Esc 只关弹窗；成功路径先 `load()` 再写提示；新增纯逻辑模块 `windows/lock-confirm.js`（供 Node 单测）与测试钩子 `window.__lockPanelRefresh`。
- 网页控制台（`server/webapp/app-57927eee.js`）：同一缺陷也在网页端（旧 `armed + 3.5 秒 setTimeout`＋5 秒 partial 补拉＋`refresh()` 全量重渲染，确认态会被刷新销毁；旧代码调裸 `POST /lock/disable {id}`，新服务端会 409 拒掉）——已同规则修复：弹窗写进 `#modalRoot`（不用通用 `showModal`，它点任何按钮都会自动关弹窗）；模块级会话对象；无自动过期定时器；冻结快照＋挑战＋编号；`revision-stale` 留弹窗刷新；超时留弹窗；Esc 由全局 `keydown` 经 `closeModal()` 关闭；提交完成时先检查弹窗是否仍在。
- 两端均按权威 `lockState` 显示 pill；非 `LOCKED` 时不提供关锁入口，只显示说明与“重新加载”；`degraded` 时追加“（保护降级）”。

## §5 回归测试（全部实跑，沙箱）

环境：Node v24.22.1；jsdom 30.1.3（`/home/hatch/node_modules/jsdom`）；`ws` 可解析；Playwright 未安装。

| 套件 | 结果 | 覆盖 |
|---|---|---|
| `server/friends/test-lock-state.js`（新增） | **58 passed, 0 failed** | 状态机 A7、分类 B14（含新增 B10 unlock-ok、B11 boot-recovered、B12/B13 心跳过期、B14 fault 字段）、对账 C8（含 C7 降级、C8 心跳来源）、修正 D6、挑战 E、故障注入 F6（超时／掉线／状态变化／重复确认／并发重放／24h 过期）、存储 G3、D39ABOL 夹具 H3 |
| `server/friends/test-lock-bridge.js`（既有） | **66 passed, 0 failed** | 桥既有行为无回归 |
| `server/friends/test-lock-bridge-c.js`（新增 HTTP 烟囱） | **9 passed, 0 failed** | 未登录 401、暂停守卫 503、缺 operationId／缺挑战／伪造挑战 409、通道故障时 challenge 503 与 devices 200 空表 |
| `server/friends/test-lock-envelope.js`（既有） | **18 passed, 0 failed** | 信封签名／TTL／nonce |
| `server/friends/test-logic.js`（既有） | **31 过 / 0 挂** | 远控既有逻辑无回归（沙箱级） |
| `windows/test/lock-confirm-test.js`（新增） | **12 passed, 0 failed** | 弹窗纯逻辑 |
| `windows/test/lock-modal-dom-test.js`（新增 jsdom 真 DOM） | **20 passed, 0 failed** | 60 秒＋12 次面板刷新存活、重复提交一次、载荷四件套、revision-stale 刷新、超时留弹窗、Esc 关弹窗。测试中发现并已修复两处真问题：成功提示被 `load()` 清掉；stale 刷新成功后错误提示被清掉 |
| `windows/test/lock-test.js`（既有，按新契约更新） | **pass: true**（25 个 case） | Mock B5 挑战取值／重放／缺挑战／缺编号拒绝；真桥 C6 挑战取值与载荷断言、同一编号重发断言 |
| `server/webapp/tests/unit/` 全套（含新增 `lock-confirm-web.test.mjs`） | **47 passed, 0 failed** | 网页端既有 46 项＋锁确认弹窗 1 项（60 秒＋刷新存活、重复提交一次、stale 刷新、超时留弹窗、Esc 关弹窗；Esc 须推进 130ms 退出动画，测试已处理） |
| `server/webapp/tests/lint-versioned-assets.mjs` | **OK** | 8 个资产 hash 文件名与内容一致，index.html 零裸名引用 |

**合计 286 项断言，全部通过**（58+66+9+18+31+12+20+25+47；网页锁确认测试计在 47 内，不重复计）。

**真机远控回归**：沙箱既有回归集已跑；真机远控回归仍待阶段 3／阶段 4（笔记本回线后）。

**bump-version 附带修复**：`server/webapp/tests/bump-version.mjs` 运行后，除 app.js 改名外，还把 4 个入仓时 hash 名已与内容不同步的文件改名（`qf-runtime-b6fb335c.js → qf-runtime-68ae46b6.js`、`qf-tokens-baec8467.css → qf-tokens-dfccb65a.css`、`app-0bbb1bf4.css → app-9a9df23b.css`、`session-050b8ec5.css → session-7938edee.css`）。已逐文件核对：**内容逐字节一致，纯改名**；此前 lint（W-08）对这 4 个文件本就是 FAIL 状态，bump 是在修复存量违规。决定：**全留**（lint 现为 OK）。

## §6 暂停期定夺建议（未改代码，待协调人定夺）

### 6.1 `/lock/update`：建议与 `/lock/enable` 同步冻结

- 理由：update 会替换锁组件二进制——暂停的本意是“停住故障锁模块的一切变更”，放任自更新等于留了一条可绕过暂停、把旧组件换成未经新状态机验证的版本（甚至未知版本）的路径；且 update 对账窗口长达 240 秒、失败模式多（组件旧版 unknown-op、下载指纹），暂停期出问题难定位。
- 冻结方式：与 enable 同款 4 行守卫（`POST /lock/update → 503` 维护文案），解除与 enable 同步、由协调人决定。
- 影响：暂停期内锁组件无法远程升级（当前组件版本已可工作，暂停期本就不应升级）；不影响远控与 disable／reset／devices。
- 备选：若协调人认为组件热修复必须留口，应限定只允许站长账号＋指定版本号白名单，而非全开。
- 底线：如不冻结，至少要求更新后以新状态机重新对账并记录版本。

### 6.2 本地手动运行 `QFLockUI.exe`：服务端封不住，须设备侧管控

- 边界：本地手动运行旧程序不属产品激活路径——本地 SYSTEM／管理员可直接运行旧二进制，服务端封不住；服务端只能做到不为它签发新信封。
- 建议：① 设备端 B 线新组件安装时删除或重命名旧 `QFLockUI.exe` 并以新组件接管（须 B 线确认卸载／替换方案）；② 服务端对账层面：设备上报 `Locked` 但无对应服务端 `lock_id`（arm 事件不匹配）时，记录标弱证据＋面板显示“设备本地锁定（非经控制台开启）”并提供“远程解除”入口走同一挑战流程（本条为后续增强，本线未实现）；③ 暂停期内明确告知用户不要在笔记本上手动运行旧程序（会复现卡死）；④ 长远：设备端组件应以服务＋白名单进程方式管控锁程序启动（B 线架构事项）。

## §7 暂停守卫核验（实核）

`server/friends/lock-bridge.js:1024–1027`，4 行原样在位（3 行注释＋1 行代码），与阶段 1 暂停文件逐字一致（本轮早先已用 diff 核对）：

```
 // LOCK-P0 pause (2026-11-19, GPT lock-bug ruling s1.1): new privacy-lock activations paused for maintenance.
 // Only /lock/enable is stopped; /lock/disable, /lock/reset, /lock/devices and normal remote control are unaffected.
 // Rollback: delete this block, then restart qfremote-friends.service.
 if (req.method === 'POST' && p === '/lock/enable') { fail(res, 503, '隐私锁功能正在维护，暂时无法开启新的锁定。已锁定的设备仍可正常关闭。'); return true; }
```

桥烟囱测试（`test-lock-bridge-c.js`）覆盖暂停守卫 503 实跑通过。未擅自解除暂停；未动生产服务。

## §8 构建 SHA（SHA-256，本工作区改动／新增文件）

```
38f850977bc01b17886af7fa86897dd1a2f2e7dd27974ff3d407aeff64eca91f  server/friends/lock-state.js
d7ecbfa16b119bbf3587d58a55fdfdd1293f99cd6e263daff2c073545e253840  server/friends/lock-bridge.js
c8afbfd2d35560df5c571a4d1fe466a5af0ca9c7e1fa8ca8b8f6475af3fa3a07  server/friends/test-lock-state.js
84dfc2408bf905283643bd0a150a1a4c018c73b43d50fec2311d6dc772ac9f9b  server/friends/test-lock-bridge-c.js
57927eeef2dda00e77f44373a01da2b012fc4dafadc142a18695aab9d2266aa2  server/webapp/app-57927eee.js
43cf78a610c166afa34117f0ee3b526758fd6445e0612af7565431bf1b91de46  server/webapp/ASSETS.json
731e14bd32f90d4c147bb96a10383223dda5e634e2bd9cae2f41ccd1ec130de1  server/webapp/index.html
bda9129475b7b7bc4af469e63651fb615d9b31d08ac7c8654cada5e4134271e5  server/webapp/tests/unit/lock-confirm-web.test.mjs
4bae3cdf5326f490c87c73985b557ded7dd9c900efba370f493b7038ba294fbc  windows/lock.html
04df3bb6c8324a79f589ce21e9095f79c8c473c0ccc35604ce24f0474ce67ffc  windows/lock.js
4974879a65d74504be596c8053ea0344bd4dddfa814126d693f6c00d3a8ba5f3  windows/lock-preload.js
ed9e715ee8b9afc83c124cff52936334f2eabe2ba36aae29feeb7aaac1f72ea6  windows/main.js
95af1eda6ccec06782b7f5a391b95b7835203bbca0ff4a4f129dead7c778d9d0  windows/ipc-trust.js
a911a974c8690dac94a1520811e3a341ec04c310c81c7279273d2961721801e7  windows/lock-confirm.js
0c761f94edc47c6d141dac8dbf05022979ad9fdbed6a04fcbe46a03436ca4264  windows/test/lock-confirm-test.js
141ec3312737d113fa92740ada758224622a822f83d2386e59c9331fc9f828c  windows/test/lock-modal-dom-test.js
400f7f444791f77825683b4f50b9b8e7adb142bd36ed70db99f8ae77e590be8f  windows/test/lock-test.js
d2315445cdde890f7b6b35cbdd5647bcba6c5fdfe24f104d68239872179fe10d  evidence/d39abol-eval.js
aa9be9128d3d2fca2aafed2fe3a92626d933d3ae88cc54a6d6800a763716cc20  evidence/d39abol-eval-20261119.json
026d409fdf065a99f088915c28b8f1ba903842dc200f31aa4e052f18549c4ad8  CONTRACT.md
33aeb18ec11801f4c534725620af0a4fbf1945430eceeedacc4e869985c97ee5  evidence/injection-samples/README.md
```

另有 4 个纯改名文件（内容与旧文件逐字节一致，见 §5）：`server/webapp/app-9a9df23b.css`、`qf-runtime-68ae46b6.js`、`qf-tokens-dfccb65a.css`、`session-7938edee.css`（及已删旧名文件）。

`node --check` 全部通过：`lock-state.js`、`lock-bridge.js`、`lock.js`、`app-57927eee.js`。

## §9 交付物清单

| 交付物 | 路径 |
|---|---|
| 服务端状态机＋对账＋修正＋挑战＋幂等（新增） | `server/friends/lock-state.js` |
| 桥接线（暂停守卫保留＋challenge＋disable 新流程＋devices 扩展） | `server/friends/lock-bridge.js` |
| 状态机单测（新增，58 项） | `server/friends/test-lock-state.js` |
| 桥 HTTP 烟囱（新增，9 项） | `server/friends/test-lock-bridge-c.js` |
| Electron 前端（弹窗＋冻结快照＋挑战） | `windows/lock.html`、`windows/lock.js`、`windows/lock-preload.js`、`windows/main.js`、`windows/ipc-trust.js`、`windows/lock-confirm.js`（新增） |
| Electron 测试（新增 DOM 20 项＋逻辑 12 项；既有 lock-test 已更新） | `windows/test/lock-modal-dom-test.js`、`windows/test/lock-confirm-test.js`、`windows/test/lock-test.js` |
| 网页控制台前端（弹窗＋冻结快照） | `server/webapp/app-57927eee.js`（由 `app-f908d484.js` 改名而来）、`server/webapp/ASSETS.json`、`server/webapp/index.html` |
| 网页 jsdom 测试（新增） | `server/webapp/tests/unit/lock-confirm-web.test.mjs` |
| 协议契约（服务端侧 v1） | `CONTRACT.md` |
| D39ABOL 对账评估脚本＋输出 | `evidence/d39abol-eval.js`、`evidence/d39abol-eval-20261119.json` |
| 注入样本目录（零样本，README 说明） | `evidence/injection-samples/README.md` |
| 本报告 | `REPORT.md` |

提交：分支 `a16s2-lockfix-c`，提交号见最终回复（本报告写定后提交）。

## §10 未完成／BLOCKED 清单

1. 设备端联调 BLOCKED（待 B 线新组件就绪；CONTRACT.md §9 列了 11 项对齐点，其中 #3 disarm 事件补 `fields.lockId`、#6 补 `boot_id/session_id/sid`、#7 `status.revision`、#8 信封去重书面确认待 B 线答复）。
2. D39ABOL 设备端确认 BLOCKED（待笔记本回线；当前分类 `UNKNOWN`，修正未执行）。
3. 阶段 4 真机复验 BLOCKED（待笔记本回线）。
4. 网页端 Playwright E2E BLOCKED（沙箱无 Playwright；jsdom 测试已替补覆盖同规则）。
5. B 线 CONTRACT.md 对齐 BLOCKED（`wt-b` 未见，待 B 线提交后复核）。
6. `/lock/update` 是否同步冻结、本地手动运行 `QFLockUI.exe` 的边界：只写了定夺建议（§6），未改代码，待协调人定夺。
7. LOCK-SEC-01 剩余两项待确认（§3 #5 设备端信封去重、#10 内存表重启失效），真机联调后复验。
8. 2.4.4 真机远控回归待阶段 3／4。

## 附录：数字来源说明

- 本报告所有数字均为**实跑**（本轮沙箱实测），除以下转述项（已标注）：
  - 阶段 1 事实（暂停执行、记录保全、两次桥会话失败、D39ABOL node id）——转述自阶段 1 报告 `lockfix-phase1/REPORT.md`（阶段 1 实跑；本轮对记录文件重新实跑核对，计数一致）。
  - 定夺内容——转述自 `gpt-a16s2-lockbug-ruling-20261119.md`。
  - 设备端契约字段——转述自 `privacy-lock-impl/CONTRACT.md` v1（本轮实读原文）。
- “已实施”与“已验收”严格区分：沙箱单测／DOM 测试通过记为“已实现＋沙箱验证通过”，设备端联调与真机复验记为 BLOCKED，不写成已验收。
