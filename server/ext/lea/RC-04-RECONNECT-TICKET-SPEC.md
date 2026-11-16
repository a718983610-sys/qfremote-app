# RC-04：LEA 断线重连票据（服务端规范）

- 状态：规范 v1（2026-11-15，L1 出；供 L3 Windows / L4 网页 / L6 安卓做客户端部分）。
- 来源：开源研究 remote-control REPORT §十二-4（FreeRDP `client_auto_reconnect_do()` + 28 字节 AutoReconnect Cookie；Remmina 重连循环）＋本仓库既有票据形态（绑定票据 v1、 自助绑定票据）。
- 范围：本规范只定**服务端票据**（格式、有效期、吊销语义、恢复流程的服务端侧契约）。客户端重连循环（重试次数／间隔／界面／输入短路）按本文 §5 实现；服务端签发／核验端点的**实现**是后续项（见 §7），不在本规范之外另行设计——实现时照 §3／§4 的函数签名做，不再做设计决策。

## 0. 与既有票据的关系（三张票据，不得混用）

| 票据 | 用途 | 有效期 | 一次性 | 规范串 |
|---|---|---|---|---|
| 绑定票据（binding ticket，v1，已实现） | 绑定确认：服务端→设备，证明“该设备已绑该账号、授权在效” | 24h（`TICKET_TTL_S`） | 否（同一租约 `lease_id` 可多次核验） | `qfr-lea-ticket-v1`（9 行） |
| 自助绑定票据（selfbind ticket，已实现） | C1 一键链接：SPA 签发、USH 持票据＋设备签名换 Key | 5 分钟 | 是（消费后即作废） | `qfr-lea-selfbind-v1` |
| **重连票据（reconnect ticket，本规范）** | 断线重连：已认证的调用方凭票据恢复原会话，不重走完整登录 | **300 秒**（§2） | **是**（只认一次） | `qfr-lea-reconnect-v1`（10 行，§1） |

三张票据的规范串域名行不同，签名不可跨票据复用；核验入口必须先验域名行，域名不对即拒绝，不做“长得像就当绑定票据”的回落。

## 1. 票据格式

重连票据是一行 JSON（服务端签发时返回，调用方原样回传），字段如下。全部字段都进签名（§1.2），缺一不可。

```json
{
  "account_id": "alice",
  "device_id": "test-device-1",
  "api_key_id": "k_xxxxxxxxxx",
  "binding_epoch": 3,
  "grant_epoch": 1,
  "resume_id": "resume-0123456789abcdef",
  "session_id": "sess-0123456789abcdef",
  "issued_at": 1790000000,
  "expires_at": 1790000300,
  "ticket_signature": "<Ed25519 签名，标准 base64>"
}
```

字段语义：

- `account_id` / `device_id`：裸形 id（去 `node//` 前缀，与绑定台账键同口径）。非空、1..127 字节、无控制字符（与既有 `checkIdField` 同规则）。
- `api_key_id`：签发时所凭 LEA Key 的 `key_id`（`k_` + 10 字符）。重连只恢复**该 Key 名下**的会话，不扩大授权。
- `binding_epoch` / `grant_epoch`：签发时刻的绑定代次与授权代次（取自 `admit()` 已验证的值，不得取调用方传来的值）。重连核验时必须与当前台账值**逐项相等**，不等即拒绝（换绑／重授权后旧票据永不复活，与 F-02 同款语义）。
- `resume_id`：服务端生成的单次恢复标识，格式 `resume-` + 16 位小写 hex（`crypto.randomBytes(8)`）。服务端台账只存其 SHA-256（见 §3），票据明文只在签发响应里出现一次。
- `session_id`：被恢复的会话标识。LEA 命令流的会话即“同一 (account, device, key) 下的一组 job”；`session_id` 由客户端在首次建立会话时生成（格式 `sess-` + 16 位小写 hex），服务端只做等值绑定，不解释其内部含义。同一张票据只能成功核验并消费一次，消费或过期后不得再用于任何恢复；同一 `session_id` 可在每次成功恢复后凭仍在效的 Key 且通过全量准入重新签发新票据，以支持同一登录会话的多次断线重连（RC-04 (b) 定夺 A，2026-11-15：助手与大肥鱼一致；单次性保护的是“一张票据只认一次”，不是“一个 session 一生只恢复一次”）。
- `issued_at` / `expires_at`：unix 秒。`expires_at - issued_at` 必须恰好等于 TTL（300，见 §2），不等即拒绝签发／核验。
- `ticket_signature`：Ed25519 签名（与绑定票据同一服务端签名密钥；签名能力关闭时拒绝签发，见 F-04 fail-closed 口径）。

### 1.1 传输与存储

- 票据明文**只在签发响应里出现一次**；服务端台账只存 SHA-256（`resume_id` 的哈希＋元数据），永不存票据明文、永不进日志（只记 `resume_id` 前 8 位 hex 与 `api_key_id`）。
- 客户端须把票据存在内存（或等价的短期安全存储）里，不得写进可同步的配置文件、不得随诊断日志外发；票据被盗的损害被单次性＋300 秒有效期＋ epochs 绑定三重封顶（§4）。
- 票据 JSON 顶层未知字段一律拒绝（与信封 v2 同规则）；`ticket_signature` 缺失即拒绝。

### 1.2 规范串（签名原文）

10 行 `\n` 连接串，行尾 LF、无结尾换行；字段值禁 CR／LF／NUL 等控制字符：

```
qfr-lea-reconnect-v1
<account_id>
<device_id>
<api_key_id>
<binding_epoch>
<grant_epoch>
<resume_id>
<session_id>
<issued_at>
<expires_at>
```

- 整数一律最短十进制、无前导零、无符号位；`binding_epoch` / `grant_epoch` 须为安全整数（≥0，≤ 2^53-1）；`issued_at` / `expires_at` 须为安全整数。
- `resume_id` / `session_id` 须合 `^(resume| sess)-[0-9a-f]{16}$`（前缀＋16 位 hex）；`scopes` 不进重连票据——重连不改变授权范围，范围仍以 `api_key_id` 所指 Key 的 `scopes` 为准。
- 再改规范须升版本（域名行改为 `qfr-lea-reconnect-v2`），不得悄悄改 v1。

## 2. 有效期

- **TTL = 300 秒**（5 分钟）。定值理由：断线重连发生在掉线后数秒内（拔网／切 Wi-Fi／服务端重启）；300 秒覆盖“用户手动切网＋客户端退避重试”的最坏等待，仍短到票据被盗后可利用窗口有限。不得由客户端指定 TTL；服务端签发时写死 300。
- 核验时 `now > expires_at` 即过期（`QFR_TICKET_EXPIRED`）；`now < issued_at - 60`（时钟偏差超 60 秒）即拒绝（`QFR_TICKET_INVALID`）。
- 票据过期后不得对同一张票据续期、不得“刷新”——须重走完整登录，或凭仍在效的 Key 通过全量准入重新签发一张新的、独立签名的票据（见 §3.3）；重新签发是“签发新票”，不是延长旧票，旧票过期后永不可用。
- 与绑定票据（24h）不同：重连票据**不设续期窗口**；与自助票据（5 分钟）同 TTL 但用途不同，不得互换。

## 3. 服务端契约（签发／核验／消费）

实现时（后续项）在 `lea-core.js` 内按下述签名做（与 `issueSelfBindTicket` / `completeSelfBind` 同款台账形态：`reconnect-tickets.json`，只存 SHA-256＋元数据，原子写 0600）：

### 3.1 签发 `issueReconnectTicket({ accountId, deviceId, keyId, sessionId })`

前置（任一不满足即拒绝签发，不发票据）：

1. 调用方须持有效 LEA Key（Bearer 鉴权通过，`authenticate()` ok）或有效控制台会话；`keyId` 须等于鉴权 Key 的 `key_id`，不得代他人签发。
2. `admit({ key, deviceId, command: 'sys.ping' })` 须通过（绑定 ACTIVE、epochs 一致、授权在效、白名单在内）——签发时即做全量准入，不把失败留到核验时。
3. 签发新票时，同 `(account_id, device_id, session_id)` 的旧未消费票据即原子作废（只留最新一张；RC-04 (b) 定夺 A 的前提，实现见 `issueReconnectTicket`，作废用 `voided_at` 保留条目，核验遇 `voided_at` 即拒绝）。未消费未过期票据上限 3 张是防刷／存储控制，不是恢复次数控制；与旧票失效规则并存时，只有最新有效票可核验，旧票已作废的不计入有效票。恢复次数不设 session 一生上限。同设备签发最小间隔 5 秒（与自助票据同款速率限制）。
4. 签名能力须为 `real`（F-04）；否则拒绝签发。

签发动作：生成 `resume_id`（`resume-` + 8 字节随机 hex）；`issued_at = nowSec()`，`expires_at = issued_at + 300`；按 §1.2 签名；台账记 `{ sha256(ticket 明文) → { account_id, device_id, api_key_id, binding_epoch, grant_epoch, resume_id 哈希, session_id, expires_at, created_at, consumed_at: null } }`；审计 `lea-reconnect-issued`（只记 `api_key_id` 与 `resume_id` 前 8 位）；返回票据 JSON 全文（仅本次）。

### 3.2 核验＋消费 `verifyReconnectTicket(ticket)`（原子：验过即消费）

按顺序，任一步失败即拒绝且**不消费**（失败不消耗单次机会，调用方可持同一张票据重试核验——但过期／已消费／ epochs 不等是终态失败，重试同样失败）：

1. 形状：顶层字段齐全、类型正确、未知字段拒绝；`ticket_signature` 存在。
2. 签名：按 §1.2 重建规范串，Ed25519 验签；失败 → `QFR_TICKET_INVALID`。
3. 台账：按票据 SHA-256 查表；查无 → `QFR_TICKET_INVALID`（票据不是本服务端签发的，或台账已清）。
4. 单次性：`consumed_at` 非空 → `QFR_TICKET_REUSED`（重放／二次恢复一律此码）。
5. 有效期：`now > expires_at` → `QFR_TICKET_EXPIRED`；`expires_at - issued_at !== 300` → `QFR_TICKET_INVALID`。
6. 吊销语义（§4）：Key 状态须为 `active`（已吊销／已过期 → `QFR_API_KEY_REVOKED`）；绑定须 ACTIVE 且 `account_id` 一致、 `binding_epoch` 相等（不等 → `QFR_BINDING_CHANGED`）；授权须在效且 `grant_epoch` 相等（不等 → `QFR_GRANT_REVOKED`）。
7. 消费：先写 `consumed_at = now()` 落盘，再返回 `{ ok: true, account_id, device_id, api_key_id, session_id, binding_epoch, grant_epoch }`；审计 `lea-reconnect-consumed`。

核验通过后，调用方（服务端路由层）按恢复流程 §5.2 办理：重做 RC-01 握手（新 `sys.handshake` 信封，epochs 取核验返回值），不重走完整登录；原会话 UNKNOWN 状态的 job 只做状态查询，不重执行。

### 3.3 端点（供 L3/L4/L6 调用；实现时挂在 `lea-routes.js`）

- `POST /api/lea/v1/reconnect/issue`：Bearer Key 鉴权；body `{ device_id, session_id }`；成功 200 返回票据 JSON 全文；失败按 §3.1 的码（401 / 403 / 409）。
- `POST /api/lea/v1/reconnect/resume`：body 为票据 JSON 全文（不走 Bearer——票据本身就是 bearer；但须同时满足 §5.2 的“凭据类失败立即停”）；成功 200 返回 `{ ok: true, session_id, device_id, binding_epoch, grant_epoch }` 并由服务端当即完成握手重建；失败按 §3.2 的码。
- 两端点都不返回 Key 明文、不返回票据之外的任何秘密。

## 4. 吊销语义（票据失效的全部情形）

重连票据在以下任一情形下失效，核验一律拒绝（码见 §3.2）。**吊销即失效是即时的**：以下状态变化发生后，尚未消费的票据下一次核验即失败，不设宽限期。

| 失效原因 | 判定点 | 错误码 |
|---|---|---|
| LEA Key 被吊销（单张／全部／自助／换绑连带） | 核验时查 `keyStatus() !== 'active'` | `QFR_API_KEY_REVOKED`（401） |
| LEA Key 过期 | 同上 | `QFR_API_KEY_REVOKED`（401） |
| 授权被撤销后重授予（`grant_epoch` 变了） | 核验时 `grant_epoch` 不等 | `QFR_GRANT_REVOKED`（403） |
| 设备换绑（`binding_epoch` 变了／账号变了） | 核验时绑定不等 | `QFR_BINDING_CHANGED`（409） |
| 票据已消费（只认一次） | `consumed_at` 非空 | `QFR_TICKET_REUSED`（401） |
| 票据过期（> 300 秒） | `now > expires_at` | `QFR_TICKET_EXPIRED`（401） |
| 票据不是本服务端签发的／签名不对 | 验签／查表失败 | `QFR_TICKET_INVALID`（401） |

补充：

- RC-02（吊销即踢在线会话）与本票据联动：Key 吊销时，除取消服务端 job 与向设备发踢出指令外，服务端同时把该 Key 名下**未消费的重连票据全部标记作废**（台账删条目或置 `consumed_at`＝吊销时刻并记审计 `lea-reconnect-voided`）。设备离线时票据作废仍在服务端生效——设备重连必经服务端核验，离线设备拿不到恢复。
- 卸载注销（deregister）后：绑定已删，核验第 6 步绑定不等即拒绝；该设备未消费票据随绑定清理一并作废。
- 票据不设“吊销列表”下发到设备：核验只在服务端做；设备端只认签名信封（RC-01 握手），不认重连票据原文。设备端收到过期／伪造票据的唯一正确反应是拒绝握手重建并记审计。

## 5. 客户端恢复流程（L3/L4/L6 实现契约）

### 5.1 两层

- **协议层（票据）**：客户端在会话建立成功后立即向服务端申领一张重连票据（`POST /api/lea/v1/reconnect/issue`），存在内存里；票据过期（300 秒）而会话仍在时，凭仍在效的 Key 再领一张（滚动续领，旧票据作废——新票据签发时同 `session_id` 的旧未消费票据即失效，见 §3.1 第 3 条的“只留最新”语义：实现时签发新票据即把同 `session_id` 的旧票据标记作废）。滚动续领与恢复后重领都是“签发新票”，不是延长旧票；恢复成功后客户端可为同一 `session_id` 再领新票，以支持同一登录会话的多次断线重连，恢复次数不设 session 一生上限（RC-04 (b) 定夺 A）。
- **客户端层（重试循环）**：掉线后按 §5.2 重试；重连期间所有输入事件（鼠标／按键／剪贴板）短路丢弃，不缓存、不补发（防止重连后输入风暴误操作）。

### 5.2 重试规则（照抄 FreeRDP/Remmina，数字写死，不得自行放宽）

| 规则 | 值 |
|---|---|
| 重试上限 | **5 次**（默认；不得无上限重试） |
| 重试间隔 | **≥ 5 秒**（每次间隔不得小于 5 秒；建议 5 秒固定间隔，不做指数退避——退避会拖过票据 300 秒窗口） |
| 界面 | 每次重试显示“第 N 次／共 5 次”与**取消按钮**；取消即停止，不再自动重连 |
| 凭据／授权类失败 | **立即停止重试**（`QFR_API_KEY_REVOKED` / `QFR_TICKET_REUSED` / `QFR_TICKET_EXPIRED` / `QFR_BINDING_CHANGED` / `QFR_GRANT_REVOKED` / `QFR_SCOPE_DENIED` / `QFR_LEA_NOT_BOUND`）：反复试错只会更快锁号／刷屏；界面显示失败原因与“重新登录”入口，不自动再试 |
| 纯网络错误才继续 | 超时／连接拒绝／DNS 失败／服务端 502/503（通道不可达）才计入 5 次重试；5 次耗尽即停，界面给“重试”按钮（用户手动点才再来一轮） |
| 重连成功后 | 立即重做 RC-01 握手（新 `sys.handshake`）；查询原会话 UNKNOWN job 的状态（只查，不重执行）；恢复前清空已丢弃的输入队列；界面 Toast“已恢复连接” |

### 5.3 验收场景（L3/L4/L6 各自测，ECS 真机）

1. 拔网线 10 秒再插：会话不断、不用重新输密码，5 次内恢复。
2. 服务端重启：同上。
3. 切 Wi-Fi：同上。
4. 凭据被吊销后重连：**1 次即停**，不刷屏，界面显示吊销原因。
5. 票据过期（等 300 秒）后掉线：重连失败报 `QFR_TICKET_EXPIRED`，走完整登录恢复。
6. 票据重放（同一张票据恢复两次）：第二次报 `QFR_TICKET_REUSED`。
7. 换绑后旧票据恢复：报 `QFR_BINDING_CHANGED`。

## 6. 安全边界（与 RC-01 / RC-02 的接口）

- 重连票据**不是**命令授权：持票据只能恢复会话（握手重建＋状态查询），不能直接下发业务命令；业务命令仍须走完整信封（RC-01 握手完成＋Ed25519 信封签名＋`admit()` 七项校验）。
- 票据签发须 `admit()` 通过；签发本身不产生新的授权范围。
- 票据与 RC-01 握手的关系：恢复流程的第一步就是一次新的 `sys.handshake`（epochs 取核验返回值）；握手未完成前设备端不接受任何业务命令（RC-01 门）。
- 票据与 RC-02 的关系：吊销即作废未消费票据（§4），吊销后重连 1 次即停（§5.2）。

## 7. 未做／后续项（诚实记录）

1. 服务端签发／核验端点的实现（`lea-core.js` 的 `issueReconnectTicket` / `verifyReconnectTicket`＋`reconnect-tickets.json` 台账，`lea-routes.js` 的 `/reconnect/issue` 与 `/reconnect/resume`）——按本规范 §3 做，另派线或随 RC-04 客户端线一起落地；实现后补 JS 单测（签发／核验／单次性／过期／epochs 不等／吊销作废，阴性全覆盖）。
2. 三端客户端重连循环（L3/L4/L6）：按 §5 实现，验收场景 §5.3 在 ECS 真机跑。
3. 本规范不涉及画面重连（RC-03 的 FEC／关键帧）与中继选路（RC-07）；网络层重连只恢复 LEA 命令会话，画面恢复由各端渲染层另行处理。
