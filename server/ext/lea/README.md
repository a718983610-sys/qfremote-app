# LEA 服务端 API ＋ 安装器集成（Stage 1 MVP）

依据：`~/workspace/qfremote/local-agent/DESIGN.md`（§3/§4/§6/§7/§8/§9/§10/§11）。
工作区：`~/workspace/qfremote/work-recovery241`，分支 `lea-local-agent`。
不碰 main / v220 / recovery-241，不翻 release.json，不部署，不动生产。

## 文件清单

| 文件 | 说明 |
|---|---|
| `server/ext/lea/lea-core.js` | 纯逻辑核心：Key 生成/吊销/换号失效、授权、绑定、准入七项校验、防重放/幂等、Ed25519 信封签名（占位）、Job、审计 |
| `server/ext/lea/lea-channel.js` | MeshCentral control 通道客户端：`runcommands`（type:0，runAsUser:0，reply:true），复用 lock-bridge 的 svc 模式与服务账号配置 |
| `server/ext/lea/lea-routes.js` | HTTP 路由：`/api/lea/v1/*` 全部端点 |
| `server/ext/lea/test/test-lea.js` | 单测（Node 无依赖）：`node test/test-lea.js` |
| `server/ext/server.js` | 只加 23 行：LEA 实例化（A1 隔离，失败降级为 null）＋ `/api/lea/v1/` 路由注册行；既有逻辑零改动 |
| `windows/install-lea.ps1` | LEA 安装脚本：服务/ACL/USH 计划任务/版本绑定/自检/重试 3 次/回滚 |
| `windows/install-system-services.ps1` | 只加可选 `-LeaDir` 参数＋LEA 步骤（失败不阻塞，exit 码不变） |
| `windows/installer.nsi` | 新增 `SEC_LEA`（SectionIn RO）＋卸载段停/删 QFRLEA 与 USH 计划任务；打包画像未动 |

## API（DESIGN §8.1）

- `POST /api/lea/v1/execute` 单条；`POST /api/lea/v1/batches` 批量；
  `GET /api/lea/v1/jobs/{job_id}`；`POST /api/lea/v1/jobs/{job_id}/cancel`；
  `GET /api/lea/v1/devices/{device_id}/status`
- Key 管理（控制台会话＋密码二次确认）：`POST /api/lea/v1/keys` 生成（明文只返回一次）、
  `GET /api/lea/v1/keys` 列表（只显 key_id/前缀/时间/状态）、
  `POST /api/lea/v1/keys/{key_id}/revoke`、`POST /api/lea/v1/keys/revoke-all`
- `POST /api/lea/v1/grants` 站长授予/撤销 `muse.execute`
- `POST /api/lea/v1/devices/{device_id}/rebind` 换绑（旧 Key 标记 `revoked_by_rebind` 立即失效）

请求头：`Authorization: Bearer <API Key>`、`X-QFR-Request-Id`、`X-QFR-Timestamp`、
`X-QFR-Nonce`、`Idempotency-Key`。认证失败：无 Key/假 Key/已吊销 → `401 QFR_API_KEY_REVOKED`；
设备不一致或 scope 不足 → `403 QFR_SCOPE_DENIED`；重放 → `401 QFR_REPLAY_DETECTED`；
未绑定 → `403 QFR_LEA_NOT_BOUND`；绑定确认中 → `409 QFR_LEA_BINDING_PENDING`（仅此码可 1s 后重试一次）；
授权撤销 → `403 QFR_GRANT_REVOKED`；绑定代次变 → `409 QFR_BINDING_CHANGED`。

## 关键实现口径

- **Key**：`qfr_lea_`＋32 字节随机数 base64url；`key_id` 为 `k_`＋10 字符；
  服务端只存 salt＋SHA-256 哈希，不存明文；审计/日志只记 key_id 与前缀脱敏。
- **签名（占位，明确标注）**：未配真实私钥时用进程内临时 Ed25519 密钥对签名，
  启动即记 `lea-signing-placeholder` 日志，`signingInfo().mode === 'placeholder-ephemeral'`。
  真实私钥接入：`createLeaCore({ signingKeyFile })`（Base64 的 64 字节 seed||pub，
  与 lock-envelope 同格式）或 `signingKeyPem`。LEA 客户端验签须配真实公钥后才可信。
- **下发**：小信封（base64 ≤6000 字符）一次 `runcommands` 直传
  `"C:\Program Files\QFR\LEA\qf-lea-client.exe" dispatch <base64>`（客户端
  Base64 解码后发往管道；动词统一 S3，2026-11-10，DESIGN §3）；
  大信封两步写 `%ProgramData%\QFR\LEA\inbox\<request_id>.json` 再
  `apply "<inbox 全路径>"`（复用隐私锁 Base64 写文件模式）。下发超时 5s；普通命令失败按幂等键重试 1 次，
  危险命令禁自动重试；同步等待 5s 超时返回 `202`＋`job_id`（结果 `UNKNOWN`，须查 job/快照确认，勿直接重试危险操作）。
  不走裸 JSON argv：裸 JSON 含 `"` 且 params 可含用户输入的 shell 元字符，经 runcommands／cmd.exe 有截断或注入风险。
- **幂等/防重放**：服务端记每 Key 的 nonce（10 分钟）与幂等键结果（7 天，危险 30 天）；
  时间窗 `expires_at - issued_at = 60s`，HTTP 时间戳偏差 ≤60s。
- **准入白名单（H04，DESIGN §6.2 第 ② 项）**：`admit()` 在 Key 有效检查后、
  scope 检查前查白名单，不在白名单 → 403 `QFR_DEVICE_NOT_WHITELISTED`。
  来源优先 `createLeaCore({ whitelist: [...] })` → 数据目录 `whitelist.json`
  （`{"devices": ["node//..."]}`，每次 admit 重读，改文件即生效）；两者都
  未配置时 fail-closed。发版口径 DESIGN §14 #2 选 A：白名单只开站长设备。
- **换绑归属校验（H05）**：`rebind` 在原“只能绑自己或站长”检查后加三项——
  ① 可选注入 `deps.listVisibleDeviceIds(auth)`（该账号在 MeshCentral 可见的
  设备清单；注入时强制校验，不在清单内 → 403＋审计 `lea-rebind-denied/not-visible`；
  未注入时走 ②③）；② `channel.listNodes()` 须含该设备，否则 404（不透露归属）；
  通道不可达时存在性校验跳过、归属校验照常；③ 当前已绑定他人账号且请求方
  非站长 → 403＋审计 `lea-rebind-denied/bound-to-other`。`server.js` 尚未注入
  `listVisibleDeviceIds`（可选 dep，留待接入）。
- **Key 生成门（H06）**：`generateKey` 要求已有 `muse.execute` 授权，否则
  抛 `QFR_MUSE_NOT_AUTHORIZED`（路由层转 403）；`muse.execute.dangerous`
  scope 须站长另授 dangerous 授权，否则抛 `QFR_SCOPE_DENIED`（路由层转
  403）；`POST /grants` 可由站长显式授／收 dangerous（`dangerous: true/false`，
  未带保留既有值）；撤销授权时 dangerous 一并失效，重授须站长重新显式授予。
- **epoch 协调（H07）**：`recordBinding` 接受 `opts.bindingEpoch`（客户端
  PENDING epoch），只许向前取 max，永不倒退；主程序 `windows/main.js`
  登录成功调 `notifyLeaLogin()` 发 `session.login_changed`，从响应
  `result.binding_epoch` 取 epoch 后调 rebind 取票据、发 `binding.confirm`；
  登出调 `notifyLeaLogout()` 发 `session.logout`。同账号重登服务端同样
  不升 epoch（与 C 端一致）。admit 要求绑定 state==='ACTIVE'（PENDING 报
  `BINDING_PENDING`）；服务端侧同账号重绑直接置 ACTIVE、epoch 不变，故
  服务端侧旧 Key 无中断窗口；PENDING 只存在于 C 端本地（login_changed 后
  至 binding.confirm 前），其间本地不执行，confirm 后恢复 ACTIVE，旧 Key
  无须重新生成（DS 第二轮 #8，单测锁死）。
  `grants.json` / `bindings.json` / `jobs.json`（0600，原子 tmp+rename）与
  `audit-YYYY-MM-DD.jsonl`（保留 ≥180 天，模块内每小时清扫一次）。
- **通道凭据**：只读既有 `/opt/qfremote-lock/bridge-config.json` 的 svcUser/svcPass/mcUrl
  （与 presence 观测同款只读复用），或环境变量 `QFR_LEA_SVC_USER` / `QFR_LEA_SVC_PASS` /
  `QFR_LEA_MC_URL` 覆盖；无配置时下发 fail-closed 503，不谎称在线。
- **安装器**：`SEC_LEA` 用 `File /nonfatal /r` 打包 `lea/` 与 `ush/` 产物
  （另一线交付；未到货时只警告、安装包仍可编译，见单测外验证）；
  服务安装在应用首次登录后一次 UAC 内由 `install-lea.ps1` 完成；
  失败重试 3 次（5s/15s/45s），仍失败标记 `%ProgramData%\QFR\LEA\LEA_DEGRADED`、
  写日志与 `install-report.json`，不阻塞主程序；回滚保留上一版于
  `...\LEA\rollback\<version>\`（`install-lea.ps1 -Rollback <版本>`）。

## 单测结果

`node server/ext/lea/test/test-lea.js`：**248/248 通过**（2026-11-10 干净基线 ad506e2＋本补丁实跑，与主树一致。含 H07 第二轮 rebind 票据九字段断言与第三轮同账号重登契约断言）。
覆盖：Key 生成格式/只存哈希/列表脱敏、认证拒绝各码、换号失效、吊销/一键吊销、
授权撤销、签名验签占位、**规范串 v1（信封 16 行／票据 9 行、定稿向量与 C 端字节一致、
params 归一化（整数键数值序＋`__proto__` 保留）、篡改矩阵、票据签发与 rebind 路由返回票据、
严格校验（timeout／seq／grant／scopes／lease）、固定密钥跨实例验签、批量 `-` 连接与
幂等键 400、JSON 安全值（toJSON／函数／Date 拒签）、UTF-8 字节长度、scopes 256 上限、
显式空 leaseId 拒签、批量后缀留长与非对象 params 400、安全整数、路由 timeout 显式非法 400）**、幂等去重、防重放、
runcommands 下发构造（mock 通道）、路由层 execute/batches/jobs 全流程、审计不含 Key 明文、
**H21 吊销推送（台账／下发前同步／失败不拦下发／已同步不重复写）、H22 绑定 epoch 不跳过 0
（绑定前 Key 绑定后 409）、T07 授权代次（撤销后旧 Key 403／重授予后不复活／新 Key 可用／
重复 grant 不递增）**。
另验：`node --check` 通过全部新文件与 `server/ext/server.js`；
ext 服务带 LEA 加载正常（`QFEXT_NO_LISTEN=1` 启动，placeholder 警告符合设计）；
既有 `server/ext/test-points.js` 11/11 通过；SEC_LEA 的 NSIS 语法经 makensis 3.09
最小 harness 编译通过。H19：SEC_LEA 关键产物已改 fatal（缺失即出包错，不出残包）；
`lea/version.txt` 由 `build.sh` 每次构建重写。
**兼容性：规范串 v1 与旧串完全不兼容，旧串验签失败是预期行为，不设版本协商、不设 v0 回落；
LEA 尚未随任何正式版发布（现行版 2.4.4 无 LEA），服务端与 LEA 随同一版本升级，
不存在滚动混用；发版说明须写死“必须同时升级两端”。**

S3 真客户端单测（2026-11-10 新增，不计入上行 mock 单测）：
`node server/ext/lea/test/test-lea-realclient.js`：**16/16 通过**（沙箱实跑，
mingw 现编真 `qf-lea-client.exe`＋管道替身 `windows/lea/test/pipe_server.c`，
wine64 下执行；断言管道收到的原文 == 原信封 JSON，含 dispatch／apply 两路与
坏 base64／缺参／缺文件三例 fail-closed）。缺 mingw／wine64 时 SKIP 退出 0。

## 吊销与密钥代次（H21/H22/T07，2026-11-10）

- **T07（D1）**：Key 绑 `grant_epoch`。`generateKey` 生成时盖上当前授权代次；
  `admit` 比对 `(k.grant_epoch||0) !== grant.grant_epoch` → 403 `QFR_GRANT_REVOKED`。
  撤销授权（`revokeGrant`）递增 `grant_epoch`，旧 Key 立即失效；撤销后重授予
  再递增一次，旧 Key 仍拒绝（不复活），须发新 Key。在效授权上重复 grant 不动
  epoch（否则每次点“授予”都会废掉全部在用 Key）。
- **H22**：绑定 epoch 校验不跳过 0——`(k.binding_epoch||0) !== binding.binding_epoch`
  即拒绝；绑定前生成的 Key 绑定后按 `QFR_BINDING_CHANGED` 409 拒绝。
- **H21**：服务端吊销推送。`revokeKey`／`revokeAllKeys`／`revokeGrant`／换绑
  （`recordBinding`）把吊销的 key_id 记入 `revocations.json` 台账（按设备，
  集合只增不减）；下次 `dispatchEnvelope` 下发前，`syncRevocations` 经
  runcommands 用 powershell 把全集写进本机 `C:\ProgramData\QFR\LEA\state\revoked_keys.txt`
  （每行一个 key_id），成功才记 `pushed_epoch`；同步失败不拦本次下发，下次重试。
  全集超长（Base64 > 4000，约 230 个 key_id）时跳过不发残集。admit 的授权代次
  比对是第一层控制，本地吊销表是第二层。只读路由
  `GET /api/lea/v1/devices/:deviceId/revocations`。

## 未完成 / 须真机或服务端联调验证（不许谎称已验）

1. **真实 Ed25519 私钥未接入**：当前为占位临时签名。部署前须在服务端配
   `signingKeyFile`（或 `signingKeyPem`），并把公钥交给 LEA 客户端验签；否则
   LEA 客户端无法信任信封。须服务端实测。
2. **真机下发未验**：mock 通道只证明了 `runcommands` 调用构造正确。
   须阿里 ECS（47.98.169.87）实测：服务账号通道建链、LEA 客户端接信封、
   命名管道、回传 stdout、超时/202 异步路径。
3. **LEA 客户端/USH 未到货**：`windows/lea/`、`windows/ush/` 由另一线负责，
   本线未动（2026-11-10 04:22–04:27 另一线已在同一工作树内交付了
   `lea/*.c` 源码与 `ush/QFUserHelper.exe`，本线只读核对、未改动）。
   客户端 `qf-lea-client.exe` 另一线已出包（2026-11-10 当日），SEC_LEA
   对其已改 fatal（H19）。
4. **H07/H25 主程序钩子未在真机验**：`windows/main.js` 的 `notifyLeaLogin`／
   `notifyLeaLogout`／`syncLockOwner` 只有 `node --check` 语法通过，无单测
   （Electron 主进程）。须真机实测：登录后 LEA 绑定进 ACTIVE、换号后旧 Key
   失效且新绑定建立、登出后 UNBOUND、锁 `device.json` 的 ownerUsername
   跟随新账号；另须 `server.js` 注入 `listVisibleDeviceIds`（H05 可选 dep，
   未注入时只做存在性＋归属校验）。
   文件名已按另一线实际产物对齐：服务本体 `QFRLEA.exe`、USH `QFUserHelper.exe`；
   客户端 `qf-lea-client.exe` 已到货，`SEC_LEA` 对其已改 fatal（H19）。
4. **安装脚本未在 Windows 上跑过**：两份 PS1 仅做了括号平衡检查与人工复核，
   沙箱无 PowerShell，未做语法解析；须 Windows 真机跑 `install-lea.ps1` 全程
   （服务创建/ACL/计划任务/自检/回滚）与 `install-system-services.ps1` 联调。
   完整 `installer.nsi` 编译亦未在沙箱跑通：`Nsis7z` 插件未在沙箱暂存，
   在 `Nsis7z::Extract` 处停下（部署打包环境的既有前置条件，与本线无关）；
   SEC_LEA 本身的 NSIS 语法已用最小 harness 编译通过。
5. **MFA 未接**：Key 生成的二次确认目前只走密码（`verifyPassword`）。
   本站暂无 MFA 校验入口；若 MFA 上线，须把 `verifyMfa` 注入 `lea-routes` 的 deps。
6. **main.js 白名单已覆盖 `install-lea.ps1`（H20，已解决）**：`maybeInstallSystemServices`
   拉起前按 `whitelist.json`（5 件）验 `install-lea.ps1` 的 SHA-256，路径取
   helperExe 旁的 `LEA/install-lea.ps1`（与将被执行的那一份一致）；白名单加载
   异常即 fail-closed；`install-system-services.ps1` 的 LEA 段执行前再按
   `-LeaScriptHash` 对一次（双重门）。`install-lea.ps1` 本身在拷文件前验三件
   载荷的 SHA-256（H17）。
7. **绑定事件源未接线**：`recordBinding` 目前只由 Key 生成时与
   `POST /devices/{id}/rebind` 手动触发；主程序登录成功/换号时自动通知 LEA
   换绑（DESIGN §6.1 的命名管道事件）由主程序线接线，届时调同一 `recordBinding`。
   服务端也未接 MeshCentral 登录事件推送（DESIGN §6.1 ②，30s 轮询兜底亦未实现）。
8. **设备在线判定依赖 `nodes` 的 conn 位**：与 presence 判定同款局限——agent 假死
   但 TCP 未断时 conn 位不翻转，会误判在线（2.4.5 已知局限，非本线引入）。
9. **多进程/多副本说明**：nonce 与幂等去重表在内存（单进程 ext 服务假设下成立）；
   若 ext 服务多副本部署，须改共享存储，否则重放判定有窗口。
10. **三端 UI 入口未做**：按任务分工，三端“设置 → 安全 → API 密钥”入口由各端线另做；
    本线只提供服务端接口。
11. **安装上报**：`install-lea.ps1` 的服务端上报目前只写本地 `install-report.json`，
    仅当环境变量 `QFR_LEA_REPORT_URL` 有值时才 POST；服务端尚无对应的上报接收端点。
