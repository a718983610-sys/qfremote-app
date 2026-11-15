# L3 后续小任务：Windows RC-04 票据恢复层收尾报告（2026-11-15）

- 执行线：L3 后续（RC-04 票据恢复层；D-06～D-10 与 RC-04 客户端层见 `windows/L3-CLOSING-REPORT-20261115.md`）
- 工作树：`~/workspace/qfremote/work-recovery241`，分支 `lea-local-agent`
- 依据：L1 票据规范 `server/ext/lea/RC-04-RECONNECT-TICKET-SPEC.md`（规范 v1，15,644 B）
- 状态：沙箱落地完成、测试全绿；真机验等 L7 安排
- 纪律：未提交、未推送、未部署、未翻 `release.json`；只改 `windows/` Electron 代码，未碰 `windows/installer.nsi`、`windows/lea/*`、`server/*`、`android-app/*`；未碰 QQGame 四 PID；未重启整机；未碰 MeshCentral 服务；未发 LEA Key、未授 dangerous、未动白名单

## 一、实现内容（对应规范条款）

### 1. 新模块 `windows/reconnect-ticket.js`（379 行，纯 Node，不依赖 Electron）
- **票据形状校验（规范 §1／§1.2）**：`validateTicket()`——10 字段齐全、类型正确、顶层未知字段拒绝；`account_id`/`device_id` 非空、1..127 字节、无控制字符；`api_key_id` 为 `k_`＋10 位小写字母数字（与 `lea-core.js` 的 `randId(10)`／`KEY_ID_ALPHABET=[a-z0-9]` 实查一致）；`binding_epoch`/`grant_epoch` 安全整数 ≥0；`resume_id`/`session_id` 合 `^(resume|sess)-[0-9a-f]{16}$`；`expires_at - issued_at` 恰好 300 秒；`ticket_signature` 标准 base64 且解出 64 字节（Ed25519 签名恒长）。不验签名本身——签名核验在服务端核验时做（§3.2 第 2 步）；设备端只认签名信封（§4 补充）。
- **存储（规范 §1.1）**：票据只存模块闭包内存，永不写进可同步的配置文件、不进 `qf-settings.json`／账号设置、不随诊断日志外发；日志只记 `resume_id` 前 8 位 hex 与 `api_key_id`（`describeForLog()`），绝不记票据全文与签名。静态断言 H10 覆盖（无写盘／`saveSettings`／`localStorage` 调用）。
- **申领（规范 §3.1／§3.3／§5.1）**：`issue()`——POST `/api/lea/v1/reconnect/issue`，body `{ device_id, session_id }`，经 `extRequest`（带控制台会话 cookie，§3.3 允许控制台会话鉴权）；`session_id` 由客户端在登录成功时生成（`sess-`＋16 位 hex，§1）。同设备签发最小间隔 5 秒（§3.1 第 3 条，`rate-limited` 兜底）；200 但形状非法／会话或设备不符时按 fail-closed 丢弃、不存。`ensureTicket()` 复用可用票据，不重复申领。
- **滚动续领（规范 §5.1）**：到期前 60 秒定时续领，新票据到手即替换内存旧票据；续领遇网络失败时 30 秒后重试一次（仍在到期前才有意义）；凭据类失败即丢票据、停滚，会话继续走点击重连。
- **恢复（规范 §3.2／§3.3／§5.2）**：`resume()`——POST `/api/lea/v1/reconnect/resume`，body 即票据 JSON 全文（不走 Bearer，票据本身就是 bearer）；成功（200＋`ok:true`＋`session_id` 与本会话一致）即消费——内存票据立即丢弃，永不重发；回包会话不符拒绝并丢票据。本地已过期（`now > expires_at`，§2）时不发请求，直接按 `QFR_TICKET_EXPIRED` 处理（§5.3-5，走完整登录）。
- **吊销／过期语义（规范 §4／§3.2）**：失败分类见 `reconnect-policy.js` 新增 `classifyTicketFailure()`（双通道：先认响应体 `code` 字段——服务端错误体为 `{ ok:false, code, msg }`，`lea-routes.js` 的 `fail()` 实查；再认 HTTP 状态）。7 个凭据码（`QFR_API_KEY_REVOKED`／`QFR_TICKET_REUSED`／`QFR_TICKET_EXPIRED`／`QFR_BINDING_CHANGED`／`QFR_GRANT_REVOKED`／`QFR_SCOPE_DENIED`／`QFR_LEA_NOT_BOUND`）一律凭据类：丢弃票据、立即停、不再试同一张票据；无名 401／403／409 按 fail-closed 归凭据类。纯网络错误（status 0 超时／断网、429、500／502／503）保留票据（未被消费），走原有点“连接”按钮的重连循环。404 归 `unavailable`——服务端 `/reconnect/*` 端点尚未实现（规范 §7 后续项，工作树内实查 `lea-routes.js` 无此两端点），票据未被消费、保留、不停手，只走点击重连。
- **登出（规范 §1.1／§4）**：`stopSession()` 清票据、清 `session_id`、清续领定时器——票据不跨账号、不跨登录会话复用。
- **输入短路（规范 §5.1／§5.2）**：Electron 外壳不向页面注入鼠标／按键／剪贴板输入，唯一动作就是点“连接”按钮本身，故无输入队列可丢弃、无补发风险；模块不缓存任何输入。

### 2. `windows/reconnect-policy.js`（只加分类，不改既有策略）
- 新增 `TICKET_CREDENTIAL_CODES`（7 码冻结）、`isCredentialTicketCode()`、`classifyTicketFailure()`。既有策略一字未动：最多 5 次、间隔 ≥5 秒、退避 5s→10s→20s→30s 封顶、凭据类立即停、未分类只给 1 次试探（见 §四-(c) 的退避口径说明）。

### 3. `windows/watchdog.js`（两个可选钩子，未传时行为与旧版完全一致）
- `onBeforeReconnect({ attempt, maxAttempts })`：每次点击“连接”前 await 调用；回报 `{ stop:true, code }` 时本轮立即停手、报 `reconnect-stopped`（附 `reason=code`），不再点按钮、不刷屏；其余回报（成功／无票据／网络失败／端点未实现）或钩子抛错时照常点击——票据层是加法，不阻塞原有点按钮重连。
- `onRecovered()`：页面恢复 `ok` 且本轮曾进入重连时调用一次（调用方 Toast＋续领新票据）。重试次数／退避／到顶仍由看护＋策略模块管，票据层不自己数次数、不自己退避。

### 4. `windows/main.js` 接线
- `reconnectTicketStore`：`baseUrl` 为控制台域名，`request` 走 `extRequest`（带控制台会话 cookie、只许 https、白名单主机——与既有许可／积分通道同口径），`log` 走 `bootLog`（只记安全描述）。
- 登录成功分支（`notifyLeaLogin` 同处）：`refreshReconnectTicketAfterLogin()`——无会话 id 时先 `startSession()`，`resolveOwnNodeId()` 取本机设备 id（取不到即跳过，不编假 id 上报），`ensureTicket()` 申领；全程 best-effort，不阻塞登录，失败只记 bootLog。
- 登出 funnel（`handleManualLogout`，强制下线经 `gateTerminateSession` 同样走此函数）：`reconnectTicketStore.stopSession('logout')`。
- `startWatchdog`：`onBeforeReconnect` → `ticketResumeBeforeReconnect()`（已有可用票据时直接 resume，不为领票多做一次设备模型探针；无票据时先试领一张再 resume；凭据类即停，其余继续点按钮）、`onRecovered` → `ticketRecoveredToastAndReissue()`（工具栏 Toast“已恢复连接”，规范 §5.2；并为同一会话续领新票据）、`onStatus` 改为 `(state, info)` 转发（`broadcastConnStatus(state, info)`，`reconnect-stopped` 的 reason 进工具栏 payload）。
- 恢复后重连成功时旧票据的处理：resume 成功时旧票据已在 `resume()` 内丢弃；纯点击恢复时复用旧票据；`onRecovered` 统一续领一张保覆盖。

### 5. `windows/toolbar.html`＋打包清单
- 工具栏 `reconnect-stopped` 文案：有 `reason` 码时显示具体原因（7 码中文映射：密钥已吊销／票据已使用／票据已过期／设备已换绑／授权已撤销／权限不足／设备未绑定），无 reason 时沿用旧文案“登录失效”，均附“请重新登录”入口（规范 §5.2）。
- `windows/package.json` 的 `build.files` 加 `reconnect-ticket.js`；`windows/tools/check-electron-safety.js` 的主进程侧模块白名单加 `reconnect-ticket.js`（D-09 检查）。

## 二、测试证据（沙箱，2026-11-15）

### 新测试 `windows/test/rc04-ticket-test.js`：53 项全绿
命令：`cd windows && node test/rc04-ticket-test.js` → `{"pass":true,"failed":[]}`（exit 0）。结果 JSON：`/tmp/qfr-rc04-ticket/rc04-ticket-result.json`（53 cases，`failed: []`）。
分组：A 票据形状 12 项（有效通过；未知字段／缺签名／TTL≠300／resume／session／Key id 格式错／epochs 非法／控制字符／签名长度错／非对象／缺字段一律拒绝）；B 失败分类 5 项（7 码凭据类、404 unavailable、0／429／500／502／503 网络、无名 401／403／409 fail-closed 凭据类、其余 unknown）；C 申领 10 项（成功存票据＋续领定时 240000ms＋`describeForLog` 无签名明文、请求形状、404 不存票、凭据失败不存票、200 非法票据不存、5 秒限流、无会话不发请求）；D 恢复 7 项（成功即消费且 resume body 与票据全文逐字节一致、7 码逐个验证丢票据＋立即停、本地过期零请求、网络／404 保留票据、无票据零请求、回包会话不符拒绝）；E 滚动续领 3 项（触发后续领换新票据、重排定时、登出清票据＋会话＋定时器）；F `attemptResume` 3 项（无票据先领后恢成功、领票凭据失败即停且零 resume 请求、resume 网络失败保留票据）；G 看护接线 3 项（钩子报停 → 0 点击＋`reconnect-stopped:QFR_API_KEY_REVOKED`、钩子放行 → 照常点击、钩子抛错 → 照常点击且恢复后 `onRecovered` 恰好 1 次）；H 静态接线 10 项（main.js 接线 5 项、打包清单、工具栏 7 码文案、看护钩子、构建检查 0 违规、票据永不落盘断言）。
服务端 `/reconnect/*` 端点尚未实现，故本测试用假 `request` 注入（可控时钟＋假定时器），不发真实网络请求——端点实现后须以真服务端复测（见 §三）。

### 既有测试无回归
- `node test/rc04-reconnect-test.js` → `{"pass":true,"failed":[]}`（旧 RC-04 客户端层 25 项，策略＋看护行为＋静态接线全绿）。
- `node tools/check-electron-safety.js` → `check-electron-safety: PASS (0 violations)`。
- `node --check`：`reconnect-ticket.js`、`reconnect-policy.js`、`watchdog.js`、`main.js`、`test/rc04-ticket-test.js` 全部通过。
- 全量 `npm test`（`windows/test/run-all.js`，约 252 秒）：`windows tests: PASS=36 FAIL=3 SKIP=3`（共 42 项；L3 基线为 PASS=31 FAIL=7 SKIP=3，共 41 项——本轮新增 1 项全绿；L2 已修好其 4 项 key_id 失败，故 FAIL 由 7 降至 3）。
  - 剩余 FAIL=3 全部是 L3 收尾报告已记的基线预存失败，与本轮无关：`agent-heal-test.js`（不稳定失败）、`devices-test.js`（E4_tokens、J6_render_clears_count）、`license-test.js`（pass:false）。
  - SKIP=3 不变：`watchdog-test.js`、`autologin-page-test.js`（需 Electron，沙箱无模块，L7 Wine／真机窗口跑）、`logout-test.js`（work tree 缺 `console-skin/custom.js`，预存缺口）。

## 三、待真机验清单（L7 安排；B1 须复验）
1. **拔网 10 秒再插／服务端重启／切 Wi-Fi 不断会话**（规范 §5.3-1～3）：须服务端 `/reconnect/*` 端点先实现（规范 §7 第 1 项，另线），否则客户端只能走点击重连、票据层静默 404——端点实现后重测，核对 bootLog `ticket.resume-ok` 与工具栏 Toast“已恢复连接”。
2. **凭据被吊销后重连 1 次即停**（规范 §5.3-4）：吊销 Key 后断线，看护须 0 次多余点击、工具栏显示“重连已停（密钥已吊销），请重新登录”；核对 bootLog `ticket.resume-credential-stop QFR_API_KEY_REVOKED`。
3. **票据过期（等 300 秒）后掉线**（规范 §5.3-5）：重连失败报 `QFR_TICKET_EXPIRED`，走完整登录恢复；核对本地过期分支零 resume 请求（沙箱已覆盖逻辑，真机核对端到端表现）。
4. **票据重放**（规范 §5.3-6）：同一张票据恢复两次，第二次报 `QFR_TICKET_REUSED`——第二次恢复须真服务端核验，沙箱假服务端无法覆盖。
5. **换绑后旧票据恢复**（规范 §5.3-7）：报 `QFR_BINDING_CHANGED`，1 次即停。
6. **B1 通道自愈复验**（SCOPE §三-9）：票据层落地后 B1 须复验——恢复流程改动（resume＋握手重建）可能影响通道自愈，本线只做了沙箱接线，真机复验由 L7 安排。
7. **滚动续领真机表现**：会话持续 5 分钟以上时，到期前 60 秒续领须无感发生（bootLog `ticket.issued` 两行、间隔约 240 秒），且不打断正在进行的远程会话。

## 四、规范含糊处（按字面做，未悄悄改规范）
- (a) **“只留最新” vs “最多 3 张”**：§5.1 称续领“只留最新”，§3.1 第 3 条称同 `session_id` 最多 3 张、超了删最旧。客户端按 §3.1 理解：内存只认最新一张，不替服务端决定旧票据命运；服务端实现时以 §3.1 为准。
- (b) **消费后同 `session_id` 能否再领**：§1 称“同一 `session_id` 在票据过期／消费后不得凭另一张票据恢复”，§3.3／§5.1 又允许凭仍在效的 Key 重新签发。客户端按 §5.1 滚动续领（恢复成功后为同一 `session_id` 再领一张）；若服务端拒绝签发，issue 失败即无票据、退回点击重连。服务端实现时须明确此语义（建议：消费／过期后同 `session_id` 的新票据只许在会话仍活时签发，会话已结束则拒绝）。
- (c) **重连间隔：固定 5 秒 vs 指数退避**：§5.2 建议“5 秒固定间隔，不做指数退避”，而 L3 已落地的 `reconnect-policy.js` 为 5s→10s→20s→30s 退避。本任务书定按已有策略接线，退避不变——最坏等待 5+10+20+30+30=95 秒仍在 300 秒票据窗口内，票据不会因退避过期；若 L1 坚持固定 5 秒，改策略模块一行即可。
- (d) **票据恢复与桌面画面重连的关系**：规范 §7 明言网络层重连只恢复 LEA 命令会话，画面恢复由各端渲染层另行处理。本线据此实现：resume 成功后仍须点“连接”按钮恢复桌面会话；resume 成功不等同于画面已恢复，工具栏 Toast“已恢复连接”在页面恢复 `ok` 后才发（`onRecovered`），不在 resume 成功瞬间发，避免画面未回先报恢复。
- (e) **`api_key_id` 字符集**：规范只写 `k_`＋10 字符，未定字符集；客户端按服务端实查 `lea-core.js` 的 `[a-z0-9]` 校验（`KEY_ID_ALPHABET`），与既有 Key 生成一致。
- (f) **服务端端点未实现**：工作树内实查 `lea-routes.js` 尚无 `/reconnect/issue` 与 `/reconnect/resume`（规范 §7 第 1 项后续项）。客户端对此做了显式降级（404 → `unavailable`，不丢票据、不停手、不报错），但在端点实现前，票据层在真机上实际不生效——真机验收（§三）须在端点实现后重做，不得以沙箱假服务端结果代替。

## 五、改动清单（本线）
新增：
- `windows/reconnect-ticket.js`（票据恢复层）
- `windows/test/rc04-ticket-test.js`（53 项）
- 本报告 `windows/L3-RC04-TICKET-CLOSING-REPORT-20261115.md`

修改：
- `windows/reconnect-policy.js`（加票据失败分类 3 个导出，既有策略未动）
- `windows/watchdog.js`（加 `onBeforeReconnect`／`onRecovered` 可选钩子）
- `windows/main.js`（票据存储创建、登录申领、登出清票据、看护钩子接线、`onStatus` 转发 reason、恢复 Toast）
- `windows/toolbar.html`（停手原因文案 7 码映射）
- `windows/package.json`（`build.files` 加 `reconnect-ticket.js`）
- `windows/tools/check-electron-safety.js`（主进程侧白名单加 `reconnect-ticket.js`）

未碰（硬线）：`windows/installer.nsi`、`windows/lea/*`、`server/*`、`android-app/*`、`release.json`。工作树内另有他线未提交 WIP（含 `server/ext/lea/*`、`windows/lea/*`、`installer.nsi` 等），开工前即已存在，非本线改动。
