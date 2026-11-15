# 跨端项安卓端说明（RC-04/RC-08/RC-09/RC-10，2026-11-15）

> 状态：RC-04 已按 L1 规范 v1（`server/ext/lea/RC-04-RECONNECT-TICKET-SPEC.md`）
> 改写、测试全绿；RC-08/09/10 线格式仍待 L5 规范，本轮不发明格式、不编造已对接。
> 服务端签发／核验端点已落地（`lea-routes.js:1030-1031`，issue/resume＋台账，
> 只存票据 SHA-256）；生产接线已于 2026-11-15 第 2 轮 #4 落地（见 §3.3 接线），
> §5.3 七场景端到端联调待 ECS 真机验。

| 项 | 安卓端落地（本轮） | 待规范 | 规范方 |
|---|---|---|---|
| RC-04 断线重连 | `lib/data/session/reconnect_policy.dart`：按规范 v1 全量实现（见下文逐条对照）；`lib/data/session/reconnect_wiring.dart`＋`lib/main.dart` 会话段已接生产路径（见 §3.3 接线） | §5.3 七场景端到端、onQueryUnknownJobs 真查询（待 #5 命令通道） | L1 服务端票据规范 v1（已出）；服务端端点已落地 `lea-routes.js:1030-1031` |
| RC-08 文件传输 | `lib/data/session/file_transfer.dart`：统一流抽象（进度/取消/暂停/续传）、64 KiB 分片器、分片数学与断点偏移、审计元数据模型（只记元数据，不记文件内容） | 分片线格式、服务端端点、审计落库字段 | L5 协议规范（未出） |
| RC-09 画质 | `lib/data/session/quality_tiers.dart`：四档＝编码参数组合（用户可改每档）、连续 2 次探测变差自动降一档、网络恢复不自动升档、服务端背压降档 | 编码参数服务端协商格式、弱网探测口径 | L5 设计确认（未出） |
| RC-10 录像 | `lib/data/session/session_recording.dart`：指令/事件流模型、三级粒度开关（默认不录）、授权判定（未授权打不开他人录像）、回放 seek 窗口 | 录制事件线格式、服务端存储端点、回放器协议 | L5 协议规范（未出） |

## RC-04 按规范 v1 实现的对应条款

- §1 票据格式：`ReconnectTicket` 10 字段全量；`fromJson` 严格校验——未知字段拒绝、
  缺 `ticket_signature` 拒绝、`expires_at - issued_at` 必须恰好 300、`resume_id`
  `resume-`+16 位 hex、`session_id` `sess-`+16 位 hex、epochs 与时间戳安全整数、
  id 字段 1..127 字节无控制字符；`canonicalString` 按 §1.2 口径生成（10 行 `\n`
  连接、无结尾换行，签名不进规范串）。
- §1.1 存储：`InMemoryReconnectTicketStore` 只存内存，不落盘、不进同步配置、
  不随诊断日志外发；日志只记 `resume_id` 前 8 位与 `api_key_id`（`logRef`）；
  同 `session_id` 只留最新一张（滚动续领旧票作废）。
- §2 有效期：TTL 300 秒写死，客户端不指定；`now > expires_at` 即过期；
  过期不续期，须重走完整登录或凭仍在效的 Key 重新签发。
- §3.3 端点：`ReconnectTransport`——`issueTicket` 调
  `POST /api/lea/v1/reconnect/issue`（body `{device_id, session_id}`）；
  `resume` 调 `POST /api/lea/v1/reconnect/resume`（body 为票据 JSON 全文，不走
  Bearer）；`HttpReconnectTransport` 为默认实现（走 `trustedHttpClient`，与
  `probe.dart` 同口径）；测试用 `ScriptedReconnectTransport` 假通道。
  **鉴权口径（第 2 轮 #4 接线定）**：应用内无 LEA API Key 明文，`bearerKey`
  已改默认 `''`；issue 走控制台会话 cookie 桥（`main.dart:842`
  `_consoleCookieHeader()` 从 WebView CookieManager 取控制台源 cookie，
  附 Cookie 头、不发 Authorization——服务端无 Bearer 时走 `consoleAuth`
  自动选该设备最新在用的 Key）；resume 不附 cookie。401/403 且码不在凭据
  码表时归网络类（只影响日志分类；issue 失败在管理器层一律 fail-open）。
- §5.1 申领／续领：`ReconnectController.issueOnSessionStart`——会话建立成功后
  立即申领存内存；`rollTicketIfNeeded`——票据过期而会话仍在时凭仍在效的 Key
  再领一张；`session_id` 由客户端首次建会话时生成（`generateSessionId`）。
  生产侧由 `lib/data/session/reconnect_wiring.dart` 的 `ReconnectSession`
  持有 controller＋内存票据库＋120 秒滚动续领定时器（＜TTL 300 秒）；
  `reconnect()` 成功后 best-effort 补领一张新票（定夺 A：允许消费后同 session
  再领新票，真正要保的是“一张票一次消费”）；申领／续领／补领失败全部
  fail-open 只记日志，不挡会话。
- §5.2 重试：`ReconnectPolicy`——上限 5 次、**固定 5 秒间隔**（不做指数退避）；
  7 类凭据失败（`QFR_API_KEY_REVOKED`／`QFR_TICKET_REUSED`／`QFR_TICKET_EXPIRED`／
  `QFR_BINDING_CHANGED`／`QFR_GRANT_REVOKED`／`QFR_SCOPE_DENIED`／`QFR_LEA_NOT_BOUND`）
  1 次即停，界面显示失败原因与“重新登录”入口；只有纯网络错误（超时／连接拒绝／
  DNS／502/503）才计入 5 次；界面“第 N 次／共 5 次”＋取消按钮；5 次耗尽后用户
  手动点“重试”才再来一轮（`retryManually`）；重连期间输入短路丢弃（不缓存、不补发）。
- §5.1/§5.2 恢复成功后：`ReconnectController.reconnect` 成功后依次调钩子——
  立即重做 RC-01 握手（`onHandshakeRedo`）→ 只查询原会话 UNKNOWN job 状态
  （`onQueryUnknownJobs`，不重执行）→ 清空已丢弃输入队列（`onClearDiscardedInput`）
  → Toast“已恢复连接”（`onRestored`）；resume 成功即消费本地票据（单次性），
  失败不消费。
- 未做／待真机：§5.3 七场景验收在 ECS 真机跑（见本文件末尾验收对照）；`onQueryUnknownJobs`
  本端暂无 LEA job 查询通道，接线时为明确标注的 no-op，待 #5 会话层接线后补真查询；
  中途断网（`_enterOffline` 离线卡＋探活 `_web?.reload()` 链）未接票据 resume，
  须 #5 的 LEA 命令通道才有意义，不冒充已覆盖 §5.3-1。

### §3.3 接线（第 2 轮 #4，2026-11-15，`lib/main.dart` 会话段）

- 触发：videoReady 时 `unawaited(_startReconnectSession())`（cookie 桥传输）；
  `_failSession` 尾部改走 `_runReconnectOrShowCard`——有在效票据先跑重连循环
  （成功或凭据失败都不再弹通用失败卡；网络耗尽才落回失败卡）。
- 浮层：根 Stack 在 `_offline` 浮层后加 `_reconnecting` 浮层（黑半透明罩＋白卡，
  “正在重连（第 N 次 / 共 5 次）”＋“取消重连”按钮，`onAttempt` 钩子供序号）。
- 凭据失败卡 `_showReconnectCredentialCard`：原因＋“重新登录”（`_manualLogoutFromMenu()`
  清干净后走服务端 /logout 回登录页）／“返回设备列表”（`_exitSessionToDevices()`）。
- 停止：`_exitSessionToDevices` 与 `_clearAuthState` 调 `_stopReconnectSession()`
  （退出登录即作废票据，换账号后旧票据绝不能复用）；重试 preflight 不调 `stop()`。
  `_clearAuthState` 同时补第 1 轮 #7 遗留 `await _bgTier?.cancelPeriodicSync()`。
- `onHandshakeRedo`→`_retrySession()`（重走 preflight 全链路，带 `identical` 世代守卫）；
  `onClearDiscardedInput` 为 no-op（浮层盖住 WebView 即输入短路，本端无 Dart 侧输入队列）。
- 测试：`test/data/session/reconnect_wiring_test.dart` 10 项＋`rc_android_test.dart`
  新增 TICKET_REUSED 1 项，目标 38/38 全过；报告见 `evidence-deep-review-20261115/WIRING-R2-RC04.md`。

## RC-03/07/08/09/10 按 L5 协议规范 v1 补实现（2026-11-15，L6 后续）

规范：`server/ext/QF-VIDEO-1-CLIENT-SPEC.md`、`QF-RELAY-1-CLIENT-SPEC.md`、
`QF-STREAM-1-CLIENT-SPEC.md`、`QF-QUALITY-1-CLIENT-SPEC.md`、
`QF-REC-1-CLIENT-SPEC.md`（每份末尾“各端待实现清单”安卓一节）。
新文件（只在 `lib/data/session/` 与 `test/data/session/`，不改旧文件）：

| 项 | 新文件 | 按规范实现的内容 |
|---|---|---|
| RC-03 FEC | `fec_decoder.dart` | GF(256) 0x11d／Vandermonde 校验行 `(j+1)^i`，与 `fec-ref.js` 同款编解码；只定 k=10/m=2 与 k=20/m=1 两档；块头 12 字段校验（服务端口径）＋档位受支持判定（k=10/m=1 等宽松组合判不受支持）；尾分片零填充裁剪；交织深度下限 `ceil(burstLen/m)`；收包归位＋超时窗口 `RTT+jitter+1 帧` 才判不可恢复；已完成块的迟到冗余片直接忽略（实测抓到的缺陷，见报告） |
| RC-03 IDR | `idr_client.dart` | `POST /license/api/session/idr-request`；seq 从 1 单调递增、每次消费 1 个（合并也消费）；三 reason（loss/join/quality-change）＋合并窗口；coalesced/rejected 不补发、不换 reason 重发、UI 不报错；REPLAY 用新 seq 重试一次；`forward` 只表示服务端允许，转发给 agent 的通道未实现（`agentNotified` 恒 false） |
| RC-07 中继 | `relay_selector.dart` | `GET /license/api/relays`；宣告解析（去重、上限 32、tier→priority→id 排序、过期 `issuedAt+ttlSec*1000`）；本地 `isAllowedRelay`（origin＋路径前缀，空列表拒绝）与 `pickRelay`（在途上限 8/级，满则跳过不算失败）；失败进 failedIds 回退；伪造中继拒绝拨号＋提示＋只记 URL/时间的日志、不进 failedIds；降级态（只保留已建会话＋文件暂存，不新开桌面会话）＋手动重试；退后台清在途计数 |
| RC-08 文件流 | `stream_transfer.dart` | init/chunk/missing/commit/cancel/inbox/sent/audit/download(Range)/ack 全端点；默认 1MB、钳制 64KB～4MB、**用服务端返回的 chunkSize 切分**；本地 SHA-256；断点续传＝`GET …/missing`（无字面 `/resume`）；commit INCOMPLETE 回 uploading 补传，CORRUPT 整单作废须重新 init；cancel 只在 uploading 态；Range 非法时 200 全文件回落按全文件处理；审计 `chunks`=totalChunks |
| RC-09 画质 | `quality_client.dart` | 档位表与服务端 `DEFAULT_TIER_TABLE` 一字一致；hot/reconfig 拆分；探针发送（缺必填本地判 probe-incomplete 不发网；值域外记降权；lossPct 指下行丢包）；周期 1s／弱网或切换后 10s 内 500ms／隐藏 5s；决策执行（先 hot 后 reconfig，needsIdr 时发 IDR＋清旧参考帧）；ACK 5s 内，超时只记日志不重发，UNKNOWN_DECISION 不重试；执行失败不伪造 ACK、保持旧档位；手动升档拒绝码与文案；背压 L1/L2/L3，hint-only 不擅自降档 |
| RC-10 录像 | `recording_client.dart` | start/event/end/list/index/download；事件白名单清洗（非法 kind 按 mouse、key 截断 32、剪贴板只记 bytes、无 content 字段）；POLICY_OFF 不录不发；at 单调递增、倒序丢弃；退后台暂停、恢复后按 at 续发；服务端重启 NOT_FOUND 提示中断并重开新录制；seek（t≤T 最后锚点，含重建索引首锚点差异）；回放（整文件下载、不支持 Range、边下边播只播完整行、变速 0.5x/1x/2x、隐私提示）；访问控制只认本人，站长无直通，404 不泄露存在性 |

旧文件关系（不改旧文件、不改旧测试，避免口径混用）：
- `file_transfer.dart`（64 KiB Guacamole 口径）与 `stream_transfer.dart`（QF-STREAM-1 1MB 口径）并存，不得混用 chunkSize。
- `quality_tiers.dart`（本地 2 次变差降档、balanced 2000kbps/24fps 近似）与 `quality_client.dart`（服务端判定为准、balanced 2500kbps/30fps）并存；服务端决策到达时以服务端为准。
- `session_recording.dart` 的旧回放授权 helper（曾允许站长打开他人录像，与 QF-REC-1 §4.1“站长无直通”冲突）已于 2026-11-15 按 C-04 裁决删除；服务端录像访问判定唯一入口是 `recording_client.dart` 的 `canAccessRecording`（只认本人，空 owner 拒绝，fail-closed）。

测试：`test/data/session/rc03_rc07_rc08_rc09_rc10_test.dart`，37 项全绿；
全量 `flutter test` 499 通过（原 462＋37）；`flutter analyze` 新文件 0 问题，
全仓仅剩 2 条既有 info（`test/ui/win_android_fix_test.dart` 的 deprecated alpha，
非本次文件）。服务端 L5 自检脚本复跑：fec 27、idr 18、relay 16、transfer 37、
quality 26、recording 39，全部 0 失败（recording 实测 39 项，规范 §8 写的 28 项
与实测不符，以实测为准）。

未做／缺口（见 L6 收尾报告）：块头线上传输二进制打包格式未定义（QF-VIDEO-1 §1.3
未定项）；服务端“转发给 agent 强制出 IDR”通道未实现；tier-2/3 真实中继主机
不存在；fecRepairPercent 10%/15% 映射待定；serverSignal 无服务端实测来源；
mcrec.js 录像捕获埋点未实现（本轮只做协议就绪）；纯 Dart FEC 未走原生，
大帧解码上生产路径前须原生接管；真机验（5% 丢包自愈、弱网不断连、四档切换、
100MB 传输、录像体积比）等 L7 安排。

## 验收对照（沙箱已验 / 真机待验）

- RC-04：生产接线已落地（第 2 轮 #4，2026-11-15，目标 38/38＋analyze 0 issue）；拔网/重启/切 Wi-Fi 不断会话、吊销后 1 次即停——**待 ECS 真机**（L7，§5.3 七场景）。
- RC-08：100MB 三端行为一致、每次传输恰一条审计——**待 ECS 真机**（L7）。
- RC-09：弱网不卡死不断连、四档切换即时生效——**待 ECS 弱网场景**（L7）。
- RC-10：10 分钟录像体积比视频小一个量级、seek/变速、未授权打不开他人录像——**待 ECS**（L7）。
- 客户端纯逻辑（重试停规则、分片数学、降档状态机、录制开关）已由
  `test/data/session/rc_android_test.dart` 覆盖，见收尾报告。
