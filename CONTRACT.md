# QFRemote 隐私锁 · 服务端状态对账与远程解除锁定协议契约 v1（C 线）

- 版本：v1（2026-11-19）＋P3-01／P3-03 增补（2026-11-19，见 §7／§11；B/C 统一版本号待 P3-04 闭合 8 问后按兼容性审查确定，不机械改名）
- 依据：定夺 `~/workspace/qfremote/gpt-a16s2-lockbug-ruling-20261119.md` §4.2／§4.3／§4.4／§4.6；GPT 三项定夺 `~/workspace/qfremote/gpt-a16s2-lockfix-3items-ruling-20261119.md` §1（P3-01）／§3（P3-03）／§4；设备端契约 `~/workspace/qfremote/privacy-lock-impl/CONTRACT.md` v1（§2／§3／§6）。
- 实现：`server/friends/lock-state.js`（状态机＋对账＋修正＋挑战＋幂等）、`server/friends/lock-bridge.js`（HTTP 接线）；前端 `windows/lock.html`／`windows/lock.js`（Electron）、`server/webapp/app-*.js`（网页控制台）。
- 基线：`049d876`（正式 RC 源码起点）；分支 `a16s2-lockfix-c`。
- 状态：服务端侧 v1 已实现＋沙箱单测全过；与 B 线逐项对齐见 §9（B 线 CONTRACT.md 截至 2026-11-19 03:xx 在 `wt-b` 未见，待 B 线提交后复核）。

## §1 状态机

六态：`UNLOCKED / LOCKING / LOCKED / UNLOCKING / UNKNOWN / RECOVERY_REQUIRED`。

迁移表（`LOCK_TRANSITIONS`，`lock-state.js`）：

| 从 | 可到 |
|---|---|
| UNLOCKED | LOCKING, UNKNOWN, RECOVERY_REQUIRED |
| LOCKING | LOCKED, UNKNOWN, RECOVERY_REQUIRED |
| LOCKED | UNLOCKING, UNKNOWN, RECOVERY_REQUIRED |
| UNLOCKING | UNLOCKED, UNKNOWN, RECOVERY_REQUIRED |
| UNKNOWN | UNLOCKED, LOCKING, LOCKED, UNLOCKING, RECOVERY_REQUIRED |
| RECOVERY_REQUIRED | UNKNOWN, UNLOCKING |

硬规则：

- `LOCKED → UNLOCKED` 不许直达；强证据解锁必须走 `LOCKED → UNLOCKING → UNLOCKED` 两步，两步共用同一操作编号、都进审计（`reconcileRecord` 与 `applyCorrection` 均如此）。
- 读不到设备（超时／掉线／心跳过期）→ `UNKNOWN`，**永不判 `UNLOCKED`**。
- 设备报 `Off` 但无强证据且曾经锁定过 → `RECOVERY_REQUIRED`，不是 `UNLOCKED`。
- `degraded` 字段：`null | 'DEGRADED' | 'FAILSAFE'`，与六态正交。`captureExclusion='failed-degraded' | 'unknown'` 记 `DEGRADED`（防截取未完全生效／保护状态未知）；`'active' | 'not-locked'` 清除。降级设备不得当正常 `LOCKED` 展示（面板追加“（保护降级）”）。

## §2 记录字段

服务端锁记录（`createLockRecord`）字段：

| 字段 | 含义 |
|---|---|
| `lock_id` | 本次锁的唯一编号（arm 信封 id） |
| `device_id` | 设备 node id |
| `boot_id` | 设备本次启动标识（status.json v1 尚无，见 §9） |
| `session_id` | 设备会话 id（同上） |
| `sid` | Windows 会话 SID（同上） |
| `revision` | 服务端记录版本号，每次迁移／审计 +1 |
| `desired_state` | 期望态（机主最后一次有效操作的目标） |
| `actual_state` | 六态之一（对账后的实际态） |
| `last_heartbeat` | 最后一次有效设备心跳（优先取 status.updatedAt，见 §3） |
| `last_error` | 最后一次对账／操作错误原因 |
| `created_at` / `updated_at` | 记录创建／最后更新时间（修正永不改 `created_at`） |
| `degraded` | 降级标记（§1） |
| `history[]` | 审计：每次迁移／修正记 `{at, op_id, by, action, reason, from, to, revision}` |

存储：内存＋可选文件持久化（默认与 friends `stateFile` 同级的 `lock-records.json`；`cfg.stateFile` 缺失时回退 `/opt/qfremote-lock/lock-records.json`；`deps.lockRecordsPath=null` 即纯内存，单测用）。原子 tmp＋rename 写盘；写盘失败只记日志、不中断服务；文件缺失为空表，损坏保留内存表、不删文件。

## §3 对账规则（`reconcileRecord` / `classifyDeviceStatus`）

设备自报来源：`status.json`（`C:\ProgramData\QFRemote\Lock\status.json`，MeshCentral 文件通道 Download 取回；组件心跳每 30 秒刷新）。

- **心跳新鲜度**：`status.updatedAt` 超 2 分钟未更新（`HEARTBEAT_FRESH_MS=120000`，与设备契约 §2 同口径）→ 该次读取作废，分类 `UNKNOWN`（`stale-heartbeat`），不得当作实时状态。心跳时间取 `status.updatedAt`（可解析时），否则用读取时间。
- **故障态**：`status.state==='Fault'` 或 `status.fault` 字段出现（`state-corrupt`）→ `RECOVERY_REQUIRED`（`device-fault`）。
- **设备报 `Locked` 且 arm 事件匹配**：`LOCKED`（弱证据：无 arm 事件匹配时仍认 `LOCKED`，但不作为“确认已锁”的强证据；写路径成功另以信封 id 对账，见 §8）。
- **设备报 `Off`**：
  - 强证据解锁（任一）：① `disarm` 事件（`fields.lockId|id` 属于本次锁，或事件时间 ≥ 本次 `created_at`）；② `unlock-ok` 事件（本地输密码解锁，同 ① 的时间／归属判据）；③ `boot_id` 变化；④ `boot-recovered` 事件（重启后恢复，时间 ≥ 本次 `created_at`，在 status.json 补 `boot_id` 之前的过渡证明）。
  - 无强证据且服务端曾锁定（当前态或审计历史曾为 `LOCKED`）→ `RECOVERY_REQUIRED`（`off-without-proof`）。**D39ABOL 当前即此态。**
  - 服务端未曾锁定 → `UNLOCKED`（无需强证据）。
- **设备上报 `revision` 旧于服务端** → `RECOVERY_REQUIRED`（`revision-conflict`）；无 `revision` 字段时跳过此检查（status.json v1 尚无，见 §9）。
- **无服务端记录**：以设备自报建只读基线（`actual=desired=设备态`，`baseline-from-device`，弱证据）。
- **读路径**（`/lock/devices`）：只在拿到新鲜设备 status 时才并入记录；读不到不翻 `UNKNOWN`，避免轮询抖动冲掉进行中弹窗的 `revision`。写路径超时翻 `UNKNOWN` 由各写分支显式做。
- **事件格式兼容**：`lastEvents` 接受新 `{ts, ev, fields}` 与旧 `{time, type, fields}` 两种形态；只取最近 10 条。

## §4 幂等对账修正（`applyCorrection`）

- 须带 `op_id`（字符串，必填）＋ `reason`（必填）；同一 `op_id` 在同一记录的审计历史里出现过即拒绝（`op-id-replayed`），不产生第二次修正。
- 离开曾锁定态（当前态或历史曾为 `LOCKED`）去 `UNLOCKED`：须 `evidence==='strong'`，否则拒绝（`evidence-insufficient`）。弱证据（“桌面看起来恢复了”等）永远不够。
- 保留原记录：原值进 `history`，不删记录、不删文件、不改 `created_at`、`lock_id` 不变；`LOCKED→UNLOCKED` 走两步（revision +2，两步共用同一 `op_id`）。
- 目标态须在迁移表内，否则拒绝并说明。

## §5 授权与重放防护（LOCK-SEC-01，见 REPORT.md §3 逐项审核）

- **会话鉴权**：`qfr_frd` 会话优先，否则 `xid` 会话 cookie 经 `mcConnectCookie` 校验；未登录一律 401。`xid` 缓存 30 秒；封禁联动 purge 会清缓存。
- **机主核对（写路径强制）**：每次写操作都 fresh 实读 `status.json`，核对 `ownerUsername`（＋别名表＋设备 pin；pin 失配判非机主；公钥 pin 失配时 arm/reset 拒绝加密）。非机主 403；读不到设备回 503（`unreachable`），**不得回 403**（离线被误报成非机主会误导用户）。
- **封禁门**：鉴权后校验 `isBanLinked`，命中 403。
- **操作挑战**：`GET /lock/challenge?id=&op=disarm`，登录＋机主核对后签发；5 分钟有效、单次消费；绑定账号＋设备＋操作＋**锁实例 lock_id＋状态版本 revision＋操作编号 operationId＋已认证会话 sessionKey**（P3-03，§11）；日志不记挑战值。先查表再判过期（过期不误报为无效）；绑定失败不消费挑战。退出登录／会话撤销／封禁联动时未用挑战立即失效（`purgeUser`，登出分支亦联动）。
- **操作编号幂等**：`POST /lock/disable` 须带 `operationId`；只缓存**成功**结果 24 小时，失败不缓存、同一编号可重试；重复提交返回首次成功结果，不产生第二次真实操作。操作编号与挑战绑定（取挑战时由弹窗带上 `opId`，两端前端均已实现）。
- **分级重新认证**（P3-03，§11）：正常所有者免重复输密码；用户自选增强保护与高风险（锁记录 UNKNOWN／RECOVERY_REQUIRED 等）必须完成登录密码升级认证，否则拒绝、绝不降级；AI 代理解锁须独立授权（`POST /lock/agent-grant`），不得借用 UI 会话权限。
- **冻结 revision**：弹窗打开时冻结 `device_id / lockId / revision`；提交时服务端校验冻结 `revision`，不一致回 409 `revision-stale`（弹窗不消失，刷新快照＋取新挑战，等用户重新确认）。挑战本身也绑定签发时 revision，期间 revision 变化即挑战失效（同码 `revision-stale`）。
- **短时重新认证（可选）**：`disable` 可带 `loginPassword`，填了即走 `mcConnect` 真登录，独立限流 5 次／15 分钟；不填则走“会话＋挑战＋操作编号＋revision”四重校验。`reset` 已有登录密码真验证＋同款限流＋并发单飞。
- **信封**：Ed25519 签名；`disarm`／`update` TTL 30 分钟，`arm`／`reset` TTL 10 分钟；随机 nonce；设备端验签＋过期拒绝（`E_ENVELOPE_EXPIRED`／`E_ENVELOPE_REPLAY`，设备契约 §4）。
- **失败码**：新路径失败回 `{error, code}`（机器可读：`revision-stale`／`state-conflict`／`alreadyOff`／`challenge-invalid` 等）；旧路径保持只含 `error` 的原格式。

## §6 前端确认交互（定夺 §4.4）

- **独立弹窗**：删除旧“再次点击＋3.5 秒自动取消”确认态；弹窗为 `body` 直接子节点（Electron）／`#modalRoot` 应用级弹窗层（网页），在列表／视图重渲染范围之外；**无自动过期定时器**。
- **冻结快照**：打开时冻结 `device_id / lockId / revision`＋操作挑战＋操作编号；取挑战后才启用确认按钮；提交中按钮禁用；重复点击不产生第二次真实请求。
- **60 秒刷新测试**：弹窗在 60 秒＋12 次面板刷新后仍存活（DOM 单测实跑）；轮询重渲染不得销毁进行中的确认。
- **revision-stale**：弹窗不消失，显示错误，后台重取设备刷新冻结快照＋取新挑战，保留“状态已变化，已更新为最新状态，请核对后重新确认。”提醒，等用户重新确认。
- **超时／掉线／拒绝**：留在弹窗内显示准确错误，**不改写成“未锁定”**。
- **Esc**：只关弹窗，不关整个窗口。
- **成功路径**：先刷新设备列表再写“已关闭”提示（不被 `load()` 清掉）。

## §7 暂停守卫（阶段 1，LOCK-P0；P3-01 同步冻结，GPT 三项定夺 §1）

`server/friends/lock-bridge.js` 内以下 4 行原样保留，不得绕过或删除：

```
// LOCK-P0 pause (2026-11-19, GPT lock-bug ruling s1.1): new privacy-lock activations paused for maintenance.
// Only /lock/enable is stopped; /lock/disable, /lock/reset, /lock/devices and normal remote control are unaffected.
// Rollback: delete this block, then restart qfremote-friends.service.
if (req.method === 'POST' && p === '/lock/enable') { fail(res, 503, '隐私锁功能正在维护，暂时无法开启新的锁定。已锁定的设备仍可正常关闭。'); return true; }
```

擅自解除暂停不允许；解除只在阶段 3 集成、阶段 4 真机安全验收以及独立放行审核完成后，由协调人按统一受控流程决定。`/lock/enable` 成功路径的记录落盘（`lock_id`＝本次信封 id）只在解除暂停后生效。

### P3-01：`/lock/update` 与 `/lock/enable` 同步冻结（2026-11-19 落实）

- 策略名 `LOCK_REMEDIATION_PAUSE`（`lock-state.js`，`isLockRemediationPaused()`）；统一错误标识 `lock-remediation-paused`；暂停是**写死在代码里的常量守卫，不是运行时开关**——服务重启、进程重建、配置重载都不能清除它。
- 暂停范围：`POST /lock/enable`（阶段 1 四行守卫，响应保持原样：503＋原维护文案，无 code 字段——刻意保留以兼容既有客户端与测试）、`POST /lock/update`（新增守卫，503＋`code: lock-remediation-paused`＋更新专用文案）。**无白名单例外**：站长账号、API 调用者一律拒绝。
- 间接入口：本仓库内**无独立的锁更新后台任务／重试队列**（全仓 grep 核实：唯一能构造 update 信封并投递的路径就是桥内 `/lock/update` 分支；重试只能以新的 HTTP 请求重进 `handle()`，必撞守卫）。第二道拦截在 `deliverEnvelope()`：`arm`／`update` 信封在暂停期直接抛错到不了设备。
- 顺序：鉴权＋封禁在先、暂停在后——未登录先 401，不因暂停机制向未授权请求泄露设备存在与否；已登录的拒绝记结构化审计（`lock-remediation-paused op=<路径> account=<账号> code=lock-remediation-paused`，不含秘密）。
- 挂起事务：暂停是部署时即生效的代码守卫，不存在“暂停生效瞬间正在执行”的跨部署队列；请求内对账循环只在投递成功后运行，暂停期投递永不发生，故无半安装状态。
- 例外（继续可用，保留原有鉴权与审计）：只读状态查询及诊断取证（`GET /lock/devices`、`GET /lock/owner-check`）；已有的紧急停止和受控安全恢复（`/lock/disable`、`/lock/reset` 走正常校验，不被暂停拦截）；经实际设备状态核实的安全解锁；专用的受控修复／回滚流程——以 `POST /lock/repair` **占位**实现（未启用前一律 503 `lock-repair-not-available`，不实现放行逻辑；正式路径须另行实现组件签名、版本与哈希核验、严格授权、审计、回滚方案与明确目标设备范围）。
- 解除规则：与 enable 同步解除，只在阶段 3 集成、阶段 4 真机验收、独立放行审核完成后按统一受控流程解除，任何单线不得自行解禁。

## §8 API 契约

| 接口 | 变化 |
|---|---|
| `GET /lock/challenge?id=&op=disarm[&opId=]` | **P3-03 扩展**。须登录＋机主核对；签发前经读路径对账建／取锁记录；回 `{ok, challenge, expiresAt, op, deviceId, lockId, revision}`；`opId`（弹窗打开时生成的操作编号）有则绑定；日志不记挑战值。 |
| `GET /lock/devices` | 扩展返回 `lockState, lockId, revision, lastHeartbeat, degraded`；旧字段 `locked, component, version` 不变。 |
| `POST /lock/disable` | **新流程**（顺序重要）：①幂等重放先查（命中直接返首次成功结果）；②校验操作挑战（缺／伪造／过期／错绑均 409，带 `code`；revision 绑定不一致映射为 `revision-stale`）；③AI 授权（出示 `agentGrantId` 时另验，单次、15 分钟、单设备、仅 disarm，失败 409 `agent-grant-*`）；④设备实读＋机主核对；⑤校验冻结 `revision`（不一致 409 `revision-stale`）；⑥**分级重新认证**（§11）：normal 免输密码；enhanced／high 无登录密码即 403 `step-up-required`，有则验密（独立限流 5 次／15 分钟）；⑦设备已报 `Off` 且有强证据 → 幂等成功；无证明 → 409 `state-conflict`；无记录时仍回 409 `alreadyOff`；⑧成功：记录落 `UNLOCKED`（两步审计），缓存成功结果；超时：记录翻 `UNKNOWN`，不缓存，可重试；拒绝：记录进 `RECOVERY_REQUIRED`。成功审计含 `risk=<等级> stepUp=<yes/no> agentGrant=<yes/no>`（不含秘密）。 |
| `POST /lock/enable` | 行为不变（暂停守卫在前，503 原维护文案）；成功路径加记录落盘。 |
| `POST /lock/reset` | 成功后加审计＋`revision+1`（`appendAudit`，不改状态，用于让进行中的确认重新校验）。 |
| `POST /lock/update` | **P3-01 已同步冻结**：一律 503 `lock-remediation-paused`，0 更新副作用（§7）。 |
| `POST /lock/repair` | **P3-01 新增占位**：受控修复发布路径未启用，一律 503 `lock-repair-not-available`；不实现放行逻辑，绝不经此放开通用 `/lock/update`。 |
| `POST /lock/agent-grant` | **P3-03 新增**。须登录＋机主核对；签发 AI 解锁授权，单设备、仅 disarm、15 分钟内单次有效；回 `{ok, grantId, deviceId, op, expiresAt}`；日志不记 grantId 原文。 |
| `POST /lock/agent-grant/revoke` | **P3-03 新增**。须登录；仅本人可撤销自己的授权；回 `{ok, revoked}`（不存在／非本人亦回 `revoked: false`，不泄露授权存在与否）。 |

错误码（新路径）：`challenge-invalid`（缺／伪造／过期／错绑）、`challenge-revision-mismatch`（内部原因，桥映射为 `revision-stale`）、`revision-stale`、`state-conflict`、`alreadyOff`、`operation-required`；`step-up-required`（高风险／增强保护缺升级认证，403）；`agent-grant-invalid`／`agent-grant-expired`／`agent-grant-binding-mismatch`（409）；`lock-remediation-paused`（503，enable／update）；`lock-repair-not-available`（503，受控修复占位）；设备不可达 503 `unreachable`；未登录 401；非机主 403；封禁 403。

## §9 与 B 线（设备端新组件）逐项对齐

设备端契约正本：`~/workspace/qfremote/privacy-lock-impl/CONTRACT.md` v1。以下逐项状态（2026-11-19 03:xx 核查）：

| # | 项 | 状态 |
|---|---|---|
| 1 | status.json v1 字段：`state`（`Off`／`Locked`）、`version`、`nodeId`／`ownerUsername`、`failCount`、`lockoutUntil`、`armedAt`／`armSource`、`captureExclusion`、`devicePublicKey`、`fault`、`lastEvents`（最近 10 条 `{ts, ev, fields}`）、`updatedAt` | 已确认（设备契约 §2），服务端按此实现 |
| 2 | `arm` 事件 `fields.armId`＝信封 id；对账以 armId 匹配为准 | 已确认（设备契约 §3），服务端已实现 |
| 3 | `disarm` 事件字段只有 `{by}`，无 `lockId` | 已确认现状；**请 B 线补 `fields.lockId`**（与 arm 对称）。补齐前服务端用“事件时间 ≥ 本次 arm 时间”窗口兜底（`lastEvents` 仅 10 条，误判窗口小但存在） |
| 4 | `unlock-ok`（本地输密码解锁）认作强解锁证据 | 服务端已实现；**请 B 线确认** `unlock-ok` 事件的 `ts` 为 ISO 时间且与 arm 时间可比 |
| 5 | `boot-recovered`（重启后恢复）作重启证明 | 服务端已实现；**请 B 线确认**该事件在重启后恢复锁状态时必写 |
| 6 | `boot_id`／`session_id`／`sid`：status.json v1 无此三字段 | **新增需求，请 B 线在 status.json 补** `boot_id`（本次启动标识）、`session_id`、`sid`（Windows 会话 SID）；补齐前服务端以事件时间窗口对账，`boot_id` 变化证明暂不可用 |
| 7 | `status.revision`（每次状态变更 +1） | status.json v1 无此字段；服务端按“有则校验、无则跳过”实现；**请 B 线确认是否补** |
| 8 | 信封去重：设备端收到重复 `disarm` 信封是否重复执行副作用 | 设备契约 §4 有 `E_ENVELOPE_REPLAY`；**请 B 线书面确认**重复信封必拒。服务端侧已加 operationId 去重，信封级重放即使到达设备，状态检查（须 `Locked`）也会挡住第二次生效 |
| 9 | `captureExclusion=failed-degraded` 时面板提示“保护降级” | 服务端已下发 `degraded` 字段，两端面板已显示；**请 B 线确认**该字段的写入时机与 `unknown` 的语义 |
| 10 | 旧 `QFLockUI.exe` 本地手动运行路径 | 服务端封不住（见 REPORT.md §6）；**请 B 线确认**新组件安装时删除／替换旧程序的方案 |
| 11 | B 线 CONTRACT.md | `wt-b` 目录截至 2026-11-19 03:xx 未见；本文件为服务端侧 v1，B 线提交后逐项复核 |

### §9 补记（C 侧已实现回填，P3-03；8 问本身待 P3-04 由 B 线先答、C 线复核）

- **上报接收端点**：设备端不直接 POST 上报；服务端接收点是 `lock-bridge.js` 的 `readStatus()`——经 MeshCentral runcommands 通道下发 `PS_READ_STATUS`，取回 `status.json` 的 Base64 回包（`extractStatusPayload` 逐候选解码验 `{state}`）；写路径一律 fresh 实读，读路径走预算并发＋分级 TTL。收到的上报进入 `reconcileRecord`／`reconcileFromRead` 对账（§3），再进 `GET /lock/devices` 下发。信封投递走同一通道反向（`deliverEnvelope` 写 inbox＋`qf-lockctl apply`）。
- **控制台降级文案**：`degraded` 由服务端 `reconcileRecord` 按 `captureExclusion` 刷新（`failed-degraded`／`unknown` → `DEGRADED`），经 `GET /lock/devices` 下发；两端面板在状态文案后追加“（保护降级）”——Electron `windows/lock.html` 的 `lockStateText()`、网页 `server/webapp/app-*.js` 的 `webLockStateText()`；降级设备不得当正常 `LOCKED` 展示（§1）。
- **二次确认弹窗实现**：Electron `windows/lock.html`（`#lockConfirmModal`，`body` 直接子节点，在列表／视图重渲染范围之外，无自动过期定时器）与网页 `#modalRoot` 应用级弹窗层；打开时冻结 `device_id／lockId／revision`＋操作挑战＋操作编号，取挑战后才启用确认按钮，提交中禁用；`revision-stale` 留弹窗刷新快照＋取新挑战；超时／掉线只显示准确错误；Esc 只关弹窗；P3-03 新增 `step-up-required` 分支——弹窗不消失，提示在密码栏输入登录密码后重新确认，并聚焦密码栏。

## §11 分级重新认证契约（P3-03，GPT 三项定夺 §3）

### 三类解锁场景

| 场景 | 认证要求 | 实现位置 |
|---|---|---|
| 已登录、权限有效、风险正常的设备所有者 | 服务端权限校验＋挑战＋revision＋明确确认，**无需每次重新输密码** | `lock-bridge.js` disable 链；`classifyUnlockRisk` → `normal` |
| 用户自行开启增强保护选项 | 在原有校验上增加登录密码升级认证（走 `mcConnect` 真登录，独立限流 5 次／15 分钟） | 登记文件 `/opt/qfremote-lock/enhanced-auth.json`（`{"accounts": [...]}`，运维维护；缺失＝无人开启，损坏＝保留上次好表）；`createEnhancedAuthStore`；`classifyUnlockRisk` → `enhanced` |
| 身份异常、权限变化、状态冲突或高风险远程解锁 | **必须升级认证或进入受控恢复流程**，无密码／密码错误一律拒绝，绝不降级为普通确认 | `classifyUnlockRisk` → `high`（当前可判定信号：锁记录 `UNKNOWN`／`RECOVERY_REQUIRED`）；`step-up-required`（403） |

### 请求链约束（逐项实现位置）

- 有效账号会话＋服务端设备归属与权限校验：`authUser`（`qfr_frd`／`xid`）→封禁门→`getDeviceOrFail`（fresh 实读 `status.json` 机主核对＋pin）；所有者与解锁权限由服务端权威记录判断，不信前端传来的角色字段（前端不传角色）。
- 服务端生成一次性操作挑战：`createChallengeStore`，5 分钟有效、单次消费、防重放；绑定 `account_id／device_id／lock_id／revision／操作类型／operationId／已认证会话 sessionKey`，不得跨账号／跨设备／跨锁实例／跨 revision／跨操作／跨会话复用；绑定失败不消费挑战；revision 不一致单独报 `challenge-revision-mismatch`（桥映射为 `revision-stale`，前端刷新快照）。
- 会话绑定：`sessionKey`＝请求 Cookie 头的 SHA-256（只存哈希、不记原文）；`qfr_frd` 签发／退出／`xid` 变化都会改变指纹，旧挑战即失效。
- 退出登录／会话撤销／权限变化后未使用挑战必须失效：`purgeUser()` 吊销该账号未用挑战与 AI 授权；`server/friends/server.js` 登出分支联动调用 `lockBridge.purgeUser(me)`；封禁联动（`/internal/ban-purge`）同款入口。权限变化另由每次提交时的 fresh 机主核对与 revision 校验兜底。
- 幂等操作编号与挑战绑定：弹窗打开时生成 `operationId`，取挑战时经 `opId` 参数带上、服务端绑定；提交时编号不符即拒绝。
- 登录密码绝不由 QFLockUI 或控制台自定义窗口采集、记录或传递：升级认证只走已有可信账号认证体系——弹窗密码栏经 `mcConnect` 真登录验证（`loginPassword` 只进内存、不记日志、不落盘）；QFLockUI 不参与。
- Web 会话 CSRF、Cookie、安全来源与重放防护：现状——`qfr_frd` 会话 Cookie 为 `HttpOnly＋SameSite=Lax＋Secure`（`server/friends/server.js` `issueSession`）；锁路由无独立 CSRF token，跨站防护依赖 SameSite＋单次挑战＋revision＋操作编号；重放防护由挑战单次消费＋操作编号成功缓存＋信封 nonce／TTL 承担。**残留**：无独立 CSRF token 是既有姿态，本线未新增；如安全评审要求，须另线加。
- 远程解锁可审计记录（不含秘密）：成功／拒绝审计含 `risk／stepUp／agentGrant／op`（`lock-bridge.js` disable 成功与拒绝日志）；日志绝不含密码、临时验证码、挑战值、grantId 原文。
- 连续快速点击：提交中按钮禁用＋操作编号幂等＋挑战单次消费，实际操作最多执行一次，结果可凭同一编号查询（`replayed: true`）。

### AI 直控与 dangerous 权限的自动化请求

- 不得因网页用户选择“免重复输密码”就自动授予代理解锁权限：UI 会话权限与 AI 授权分离，自动化调用方须出示独立授权——`POST /lock/agent-grant`（机主签发，单设备、仅 disarm、15 分钟内单次有效、可撤销）＋提交时 `agentGrantId` 另验；`POST /lock/agent-grant/revoke`（仅本人可撤销自己的授权）；`purgeUser` 按账号吊销。
- **残留（诚实说明）**：当前 HTTP 层没有调用方类型信号，服务端无法从请求本身区分“用户本人”与“AI 代理”；硬性防线是挑战的 `sessionKey` 绑定（UI 会话签发的挑战换个会话即失效，P03-12a 实测）＋授权机制的独立凭证与审计；调用方类型识别须 P3-04／P3-06 在集成层补齐（调用方认证），本线不虚报已实现。
- 特别：对 UNKNOWN 设备，不能因用户重新输入登录密码就直接改成 UNLOCKED——重新认证只证明操作者身份，不证明设备实际锁状态；放行仍须设备侧强证据对账（`disarm` 事件／`boot_id` 变化／`boot-recovered`），见 §3／§10。

### 会话可信度信号残留

- `classifyUnlockRisk` 接受 `sessionTrustLow` 输入，但桥当前鉴权层只返回账号名、无独立会话可信度评分，故桥内恒传 false；“会话疑似被盗用”的实际防护由挑战 sessionKey 绑定＋purgeUser 吊销承担。独立会话可信度评分（如设备指纹／异地登录）须另线在鉴权层补齐，本线不虚构信号。

## §10 D39ABOL 旧状态修正程序（定夺 §4.3，当前状态）

1. 服务端原件保全（阶段 1 已完成，实跑）：`lock-records-20261119.jsonl` 298 行，SHA-256 `982b78274e390555f6d255fd215716f2310fe5def49d15b3d44b59da4b177db1`；arm 成功 4 次（2026-11-15 ×3，2026-11-18 ×1），disarm 成功 1 次（2026-11-15），最后一次 arm 之后 0 次 disarm。
2. 设备端确认：**BLOCKED**（待笔记本回线；阶段 1 两次桥会话均 opening→idle 死亡）。
3. 当前分类：**`UNKNOWN` 待核查**（设备不可达）；弱证据修正到 `UNLOCKED` 已实跑拒绝（`evidence-insufficient`）；设备报 `Off` 无证明时定 `RECOVERY_REQUIRED`。证据：`evidence/d39abol-eval-20261119.json`。
4. 修正执行：**未执行**。须等笔记本回线、设备端确认无活跃锁并给出强证据（`disarm`／`unlock-ok` 事件或 `boot_id` 变化／`boot-recovered`）后，带操作编号走 `applyCorrection`。
5. 真机复验：阶段 4（待笔记本回线）。
