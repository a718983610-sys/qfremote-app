# 崩溃上报接收端点契约（3.0.0）

> 定夺：匿名接收＋强防护（2026-11-15，助手与大肥鱼一致，shanedit 中转）。
> 拒绝的备选：强制鉴权（Bearer Key／控制台会话）——上传发生在下次启动，
> 用户未必已登录，会丢掉登录前／启动即崩溃这类最有价值的报告；可选鉴权
> （有会话时归属、无时匿名）——匿名分支仍须完整实现全部防护，额外只换
> 来低收益的归属能力，不值得。

## 端点

- `POST /api/lea/v1/crash-report`，`Content-Type: application/json`。
- 不要求鉴权：附带的 Cookie／Key（如有）一律忽略，永不记入日志与审计。
- 无列表／下载／查询接口：上报只进不出，站长在服务器上直接看文件。

## 请求体（JSON 对象，≤ 200KB，超限 413）

白名单字段，缺一不可（`exit_code` 可为 null／省略），未知字段一律 400：

| 字段 | 类型 | 约束 |
|---|---|---|
| `schema_version` | 整数 | 恒为 1 |
| `report_id` | 字符串 | UUID v4，每份报告随机生成，仅作幂等／去重，不是设备身份；入库前 toLowerCase 归一（大小写变体同算一份） |
| `app_version` | 字符串 | 1–64 字符 |
| `platform` | 字符串 | 1–32 字符，如 `win32` |
| `os_version` | 字符串 | 1–256 字符 |
| `arch` | 字符串 | 1–32 字符，如 `x64` |
| `crash_time` | 字符串 | 严格 ISO-8601（正则＋Date.parse 双重校验），合法；不得晚于现在 5 分钟以上、不得早于 90 天前 |
| `exception_type` | 字符串 | 1–128 字符，如 `uncaughtException` |
| `module` | 字符串 | 1–128 字符 |
| `exit_code` | 整数或 null | 可选 |
| `stack` | 字符串 | ≤ 128KB；落盘前脱敏（见下） |

报告只含技术信息。白名单之外一律拒绝——含疑似敏感名的字段
（password／token／cookie／secret 等）同样因不在白名单内被拒。
未知／缺失字段只回固定文案（`请求含未知字段。`／`请求缺少必填字段。`），
不回显字段名与字段值。

脱敏（S-092，客户端＋服务端双洗）：`stack` 在客户端构造载荷时与
服务端落盘前各洗一次——Windows 用户目录（`C:\Users\<名>\` 等）、
POSIX 用户目录（`/home/<名>/`、`/Users/<名>/`）、UNC 用户目录与
疑似凭据形态（`token: …`／`password=…` 等）一律掩码为 `<redacted>`，
只留相对路径与行号。用户名常为真实姓名拼音，掩码后同意文案
“不含账号、密码、聊天与屏幕内容”才属实。

## 限流（内存计数，单 Node 进程；重启即清零）

- 每 IP 5 份／小时、20 份／天；全局 1000 份／天。
- 超限 429 `QFR_RATE_LIMITED`＋`Retry-After` 秒数。
- 客户端 IP 口径（S-091，2026-11-15 修 N-02）：只信可信反代层注入的
  真实 IP，不直接信任客户端自报 XFF 首段——socket 须为回环才认代理头；
  优先 `CF-Connecting-IP`（Cloudflare 边缘覆写注入），其次取 XFF 自
  末段起第一个非回环段（nginx 追加的是 127.0.0.1，倒数第二个非回环段
  即边缘所见的真实 IP）；非回环直连一律用 socket IP，XFF 全忽略。
  旧口径“`x-forwarded-for` 首段优先”作废（首段可伪造、可定向耗尽他人额度）。
- 全局 1000 份／天只计通过校验的请求：非法请求（400）走独立桶
  （每 IP 20 份／小时，不计全局），不再能定向耗尽他人／全局额度。
- 日切时清旧条目；限流 Map 超 10000 条时删最旧。

## 存储

- 目录 `<lea-data>/crash-reports/`，文件 `<report_id>.json`，0600，
  tmp 写＋link(2) 原子建链（目标已存在即判 duplicate；极少数不支持
  硬链接的文件系统退回 rename）；文件名即校验过的 `report_id`，永不信任路径。
- 封顶：最多 5000 份或 1GB 总量，先到先轮转删最旧；超期（1 小时）
  `.tmp-*` 孤儿随落盘清理。
- 磁盘剩余低于 100MB、或低于总量 10% 时拒收（503），绝不半写。
  （与大肥鱼建议的“2GB”有偏差：固定 2GB 会把小文件系统——如测试用的
  512MB tmpfs——上的全部上报拒掉；100MB 绝对值＋10% 相对值仍守住底线。
  剩余空间按 `bavail`（普通用户实际可用）计，不用含 root 保留块的 `bfree`。）
- 同一 `report_id` 已落盘时返回 200 `{ ok: true, duplicate: true }`，不重写。
- 审计：`lea-crash-report` 事件进 JSONL（只记 request_id／IP／report_id／
  字节数／结果码，不记报告正文）。

## 响应

- 成功：200 `{ ok: true, report_id, stored: true }`（去重时 `stored: false, duplicate: true`）。
- 失败只回稳定错误码，不回显请求体／堆栈／字段值：
  - 400 `VALIDATION`（形状／字段错误）；413 `QFR_CRASH_TOO_LARGE`；
  - 415 `QFR_CRASH_UNSUPPORTED_MEDIA`；429 `QFR_RATE_LIMITED`；
  - 503 `QFR_CRASH_STORAGE_FULL`／`QFR_CRASH_STORAGE_ERROR`／
    `QFR_CRASH_AUDIT_FAILED`（审计写失败）。
- 审计先于 200 返回：审计写失败回 503（报告已落盘，客户端重试将按
  去重回 200，不丢数据）。此前措辞“未落盘＋未审计前绝不回 2xx”为顺序
  要求，现以 503 落实——审计失败不再只记日志、仍回 200。
- 超大请求体先 drain 后 413（与 `readJsonBody` 共用实现，L-12 已评估：
  内存有界（超限即停累积），改共用实现会波及 17MB 付款截图与 288MB
  文件发送路径，故保留 drain、不改共享实现）。

## 客户端行为（windows/crash-handler.js＋main.js）

- 只有用户勾选同意才传，只传最新一份（`decideUpload` 守门不变）。
- 本地文本报告经 `parseCrashReportText`／`buildCrashUploadPayload` 转成
  上表 JSON；解析失败不上传、保留本地文件；stack 超 128KB 截断并标注；
  构造载荷时先脱敏（S-092）。
- 上传不阻塞启动（fire-and-forget）；只有 2xx 才删本地报告，其它状态／
  超时一律保留本地文件，不重试、不伪装成功；报告最终随本地 10 份轮转清理。
- 上传不附控制台会话 Cookie（`extRequest(..., { noCookie: true })`，L-09；
  端点匿名接收，服务端忽略 Cookie、不记日志）。
- 渲染进程崩溃由 `recordRendererCrash` 记本地报告（L-10，helper 已备；
  main.js `handleRenderProcessGone` 接线待落点——C-1 正在改该函数，
  本线不碰 main.js 该处）；极早启动期崩溃（L-11）由 `writeCrashReport`
  写报告时补立哨兵兜底，下次启动走残留哨兵＋同意上传流程。
- 与大肥鱼建议的“同一报告最多 3 次自动尝试”之偏差（有意）：启动时
  fire-and-forget 单次尝试，避免 8 秒超时×多次重试拖慢启动；失败的报告
  留在本地，留待下次异常启动再试、或随轮转清理，永不静默删除。

## 实现位置

- 服务端：`server/ext/lea/lea-core.js`（`validateCrashReport`／
  `storeCrashReport`）＋`server/ext/lea/lea-routes.js`
  （`handleCrashReport`＋限流＋分发）。
- 客户端：`windows/crash-handler.js`（解析／构造载荷）＋`windows/main.js`
  （接线：真实端点＋fire-and-forget 上传＋2xx 删本地文件）。
- 测试：`server/ext/lea/test/test-lea.js`（§12）＋
  `windows/test/d06-crash-test.js`（§F）。
