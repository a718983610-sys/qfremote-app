'use strict';
/*
 * QFR 本地代理（LEA）服务端核心 · Stage 1 MVP
 * ============================================================
 * 依据：~/workspace/qfremote/local-agent/DESIGN.md
 *   §4 命令协议（信封/幂等/超时）、§6 绑定与准入（七项校验）、
 *   §7 API 密钥模型、§8 API 模型、§11 日志审计。
 * 参照：许可密钥（server/ext/license-core.js 的 key 台账/吊销语义）、
 *   助手/owner 令牌（server/ext/events-core.js：只存 SHA-256、
 *   timingSafeEqual 比对、吊销立即失效）、隐私锁信封
 *   （server/friends/lock-envelope.js：Ed25519 签名布局）。
 *
 * 本模块是纯逻辑层：不直接碰 HTTP、不直接连 MeshCentral。
 * 下发通道由调用方以 opts.channel 注入（见 lea-channel.js），
 * 单测可注入 mock 通道，不真连 MeshCentral。
 *
 * 安全红线（本模块内硬编码，不依赖调用方自觉）：
 *  - API Key 明文只在生成瞬间存在于内存，永不落盘、永不进日志；
 *    台账只存 salt + SHA-256( salt || 明文 )；
 *  - 审计只记 key_id 与 key 前缀，不记明文、不记完整 Key；
 *  - Ed25519 签名（F-04，2026-11-14，生产 fail-closed）：真实私钥
 *    是唯一生产签名方式。接入点：opts.signingKeyFile（Base64 的 64
 *    字节 seed||pub，与 lock-envelope.loadDispatcherKey 同格式）
 *    或 opts.signingKeyPem（PEM）。已配置但加载失败时 createLeaCore
 *    直接抛错，LEA 签名能力拒绝启动（不静默回退临时密钥）；
 *    未配置时 signing 模式为 disabled，signEnvelope／票据签名直接
 *    拒，下发门（dispatchEnvelopeInner）非 real 一律拒绝并记审计。
 *    进程内临时密钥只允许测试显式开启（opts.allowEphemeralSigning
 *    === true，mode='placeholder-ephemeral'），生产永不启用；
 *    即使显式开启，下发门仍只放行 mode='real'。启动日志以
 *    signing_mode 明确记录当前模式（见 signingInfo），公钥只记
 *    SHA-256 指纹，不记密钥内容。
 *
 * 签名规范串 v2（F-02，2026-11-14；信封升 v2，票据仍为 v1）：
 *   唯一规范源见 windows/lea/CANONICAL-SIGNING-V2.md（信封部分），
 *   票据部分仍见 ds-review-stage2/CANONICAL-SIGNING-V1.md §3。
 *   信封与票据的规范串均为固定行数的 \n 连接串（信封 20 行、票据
 *   9 行），params 只签其规范 JSON 的 SHA-256，C 端
 *   （windows/lea/lea_protocol.c）按同一规范实现，两端字节级一致。
 *   v1 信封不再接受（无回落、无版本协商）。再改规范须升 v3，
 *   不得悄悄改 v2。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
// S-083：统一诊断事件禁键过滤（server/ext/qf-diagnostics.js）。
// 加载失败时退化为本地同名实现（审计永不因模块缺失而停摆）。
let scrubForbiddenKeys;
try {
  scrubForbiddenKeys = require('../qf-diagnostics').scrubForbiddenKeys;
} catch (e) {
  const _FORBIDDEN = new Set(['password', 'passwd', 'pwd', 'cookie', 'cookies', 'api_key', 'apikey', 'api-key', 'secret', 'private_key', 'privatekey', 'private-key', 'authorization', 'token', 'access_token', 'refresh_token', 'id_token', 'input', 'content', 'plaintext', 'plain_text', 'cipher', 'ciphertext', 'sessioncopy', 'session_copy', 'wrappedpriv', 'wrappedvault']);
  scrubForbiddenKeys = (fields) => {
    const out = {};
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return out;
    for (const k of Object.keys(fields)) { if (!_FORBIDDEN.has(String(k).toLowerCase())) out[k] = fields[k]; }
    return out;
  };
}

// ---------- 常量（DESIGN.md §3/§4/§6/§7/§11） ----------
const KEY_PREFIX = 'qfr_lea_';
const KEY_ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const ENVELOPE_TTL_S = 60;            // expires_at - issued_at ≤ 60s
// F-02：信封 JSON 顶层允许的全部字段（v2）。envelopeSigningBytes 拒绝
// 在此集合之外的任何字段，与 C 端 lea_parse_envelope 顶层键白名单
// （另含 trace_id，服务端不签发、设备端只接收）同规则。
const ENVELOPE_FIELDS = new Set([
  'version', 'request_id', 'batch_id', 'seq', 'device_id', 'account_id',
  'api_key_id', 'binding_epoch', 'grant_epoch', 'nonce', 'issued_at',
  'expires_at', 'idempotency_key', 'command', 'params', 'timeout_ms',
  'job_id', 'mode', 'deadline_ms', 'signature',
]);
const TICKET_TTL_S = 24 * 3600;       // 绑定票据有效期 24h（规范串 v1 口径）
const REPLAY_WINDOW_MS = 10 * 60 * 1000; // 服务端 nonce 去重表保留 ≥10 分钟
const TIMESTAMP_SKEW_S = 60;          // HTTP 头时间戳允许偏差（LEA 端 ±30s，服务端取 60s 上限）
const DISPATCH_TIMEOUT_MS = 8000;     // B1：下发 8s（客户端 ACK 2s＋结果 6s＝8s 上限；
// 须 ≥ 客户端最坏 8s，客户端才能在通道杀进程前回 timeout JSON。
// 边界竞态：ACK 恰在 2s 到达时客户端 timeout JSON 在 ~8.05s 才出，
// 通道 8s 杀进程可能抢先一步；此时下发走通道超时分支，job 仍进
// UNKNOWN→sweeper 10s 转 TIMED_OUT，终态一致，不影响 B1 验收。）
const SYNC_WAIT_MS = 5000;            // HTTP 同步等待默认 5s，超时 202 + job_id
// ---------- C1：自助绑定（PLAN.md §2 C1） ----------
// 自助绑定票据：SPA（已登录会话）签发、USH 持票据＋设备签名换 Key。
// 票据本身是一次性 bearer，但 complete 另须设备 P-256 签名（D3 TOFU），
// 票据被盗无设备私钥也完不成。Key 默认 90 天，续期窗口 7 天。
const SELFBIND_TICKET_PREFIX = 'sbt_';
const SELFBIND_TICKET_TTL_S = 300;    // 票据有效期 5 分钟（一次点击流程内够用）
const SELFBIND_KEY_DAYS = 90;         // 自助 Key 默认有效期 90 天
const SELFBIND_RENEW_WINDOW_MS = 7 * 24 * 3600 * 1000; // 到期前 7 天内可续期
const SELFBIND_RENEW_DAYS = 90;       // 续期延长 90 天（自续期时算起）
const SELFBIND_MAX_TICKETS = 5;       // 每（账号，设备）未消费未过期票据上限
const SELFBIND_ISSUE_MIN_INTERVAL_MS = 5000; // 同设备签发最小间隔 5 秒
const SELFBIND_CANONICAL_V1 = 'qfr-lea-selfbind-v1'; // 自助绑定规范串版本（与信封 v1 隔离）
const SELFBIND_RENEW_SKEW_S = 60;     // 续期时间戳允许偏差 60 秒
// RC-04：断线重连票据（server/ext/lea/RC-04-RECONNECT-TICKET-SPEC.md）。
// TTL 写死 300 秒；签发新票时同 (account, device, session) 旧未消费票据
// 即原子作废（只留最新，规范 §3.1 第 3 条；RC-04 (b) 定夺 A）；同设备
// 签发最小间隔 5 秒；作废条目过期前保留、由 prune 清理。
const RECONNECT_TICKET_TTL_S = 300;
const RECONNECT_CANONICAL_V1 = 'qfr-lea-reconnect-v1';
const RECONNECT_ISSUE_MIN_INTERVAL_MS = 5000;
// ---------- 卸载注销（2026-11-14 站长亲定）：卸载时一起删服务端记录 ----------
// 只删设备登记（node 记录，由路由层经通道删）＋本设备绑定；付费 LEA 密钥、
// 其他设备绑定、账号、grant、审计一律不动。规范串与自助绑定同款隔离版本。
const DEREGISTER_CANONICAL_V1 = 'qfr-lea-deregister-v1';
const DEREGISTER_SKEW_S = 300;        // 注销时间戳允许偏差 300 秒（固定契约）
const JOB_RETENTION_MS = 24 * 3600 * 1000; // 长任务结果保留 24h
// B1：UNKNOWN 超 10 秒判 TIMED_OUT（sweepB1Jobs 2 秒定时推进）。
const B1_JOB_UNKNOWN_TIMEOUT_MS = 10 * 1000;
// B1：每节点在途名额（在队＋在执行合计上限 8，与 LEA 端队列准入一致）。
const B1_INFLIGHT_MAX = 8;
// B1：sweepB1Jobs 定时（2 秒）。
const B1_SWEEP_MS = 2000;
// B1：连续 2 次下发超时即标 DEGRADED，进健康探测。
const B1_HEALTH_FAILS = 2;
const JOB_STALE_MS = 15 * 60 * 1000; // H14：job 失联阈值——RUNNING/UNKNOWN/PENDING
// 超 15 分钟无更新即视为失联。边界论证（DS 复查要求硬核证明）：服务端每步
// 只等 dispatchEnvelope（timeoutMs 固定 5000），普通命令最多 2 次尝试、
// 危险命令 1 次，故单批最坏 wall time ≈ 50 步 × 2 × 5s = 500s＋每步
// admit/组包毫秒级开销 < 600s，严格 < 900s（15 分钟），边距约 300s。
// 注意命令表的 timeout_ms（如 app.open 60s）是 LEA 设备侧执行上限，
// 服务端不等它——5s 下发超时即转 UNKNOWN，不计入本阈值。
const IDEMPOTENT_RETENTION_MS = 7 * 24 * 3600 * 1000; // 幂等结果保留 ≥7 天
const AUDIT_RETENTION_DAYS = 180;     // 服务端审计保留 ≥180 天（§11.2）
const NONCE_RETENTION_MS = REPLAY_WINDOW_MS;

// 命令集（DESIGN §4.4 MVP）与默认超时、所需 scope、是否危险、分级。
// 危险命令：必须带幂等键、禁自动重试、需 muse.execute.dangerous。
// B1 分级 tier：0=内联短 lane（sys.*，不进队列）；1=普通同步 lane；
// 2=长／危险（script.run、file.write——与 C 端 lea_command_spec_t 的
// tier 逐项一致：C 端 tier 2 含义是“长／危险”，不是“异步”）。
// tier 只决定 deadline_ms 上限（L0/L1=8s，L2=120s）；mode（sync/async）
// 不由 tier 定，只由命令定——只有真正长命令 script.run 走 async，
// file.write 虽是 tier 2（危险）仍走 sync（短命令，调用方等同步结果）。
// tier 决定信封 mode（L2=async）与 deadline_ms 上限（L0/L1=8s，L2=120s），
// 与 C 端 lea_command_tier／lea_job_deadline_ms 逐项一致。
const COMMANDS = {
  'app.open':    { scope: 'muse.execute', dangerous: false, timeoutMs: 15000, maxTimeoutMs: 60000, tier: 1 },
  'app.close':   { scope: 'muse.execute', dangerous: false, timeoutMs: 5000, maxTimeoutMs: 15000, tier: 1 },
  'ui.click':    { scope: 'muse.execute', dangerous: false, timeoutMs: 5000, maxTimeoutMs: 15000, tier: 1 },
  'ui.input':    { scope: 'muse.execute', dangerous: false, timeoutMs: 5000, maxTimeoutMs: 15000, tier: 1 },
  'ui.snapshot': { scope: 'muse.execute', dangerous: false, timeoutMs: 5000, maxTimeoutMs: 15000, tier: 1 },
  'ui.tree':     { scope: 'muse.execute', dangerous: false, timeoutMs: 5000, maxTimeoutMs: 15000, tier: 1 },
  'script.run':  { scope: 'muse.execute', dangerous: true,  timeoutMs: 30000, maxTimeoutMs: 300000, tier: 2 },
  'file.read':   { scope: 'muse.execute', dangerous: false, timeoutMs: 10000, maxTimeoutMs: 30000, tier: 1 },
  'file.write':  { scope: 'muse.execute', dangerous: true,  timeoutMs: 10000, maxTimeoutMs: 60000, tier: 2 },
  'sys.info':    { scope: 'muse.execute', dangerous: false, timeoutMs: 5000, maxTimeoutMs: 5000, tier: 0 },
  'sys.ping':    { scope: 'muse.execute', dangerous: false, timeoutMs: 5000, maxTimeoutMs: 8000, tier: 0 },
  'sys.reset':   { scope: 'muse.execute', dangerous: false, timeoutMs: 5000, maxTimeoutMs: 8000, tier: 0 },
  // RC-01：握手命令（tier 0 内联；见 buildHandshakeEnvelope／ensureHandshake）。
  // params 带两项签名参数（server_pubkey_fp＋protocol_version），
  // binding_epoch／grant_epoch 已是信封顶层签名覆盖字段。
  'sys.handshake': { scope: 'muse.execute', dangerous: false, timeoutMs: 5000, maxTimeoutMs: 8000, tier: 0 },
};
const DANGEROUS_SCOPE = 'muse.execute.dangerous';

// 错误码（DESIGN §4.5；HTTP 状态与之一一对应，见 lea-routes.js）
const ERR = {
  BAD_KEY: 'QFR_API_KEY_REVOKED', // 401：Key 不存在/已吊销/已过期（含换绑吊销）
  SCOPE_DENIED: 'QFR_SCOPE_DENIED', // 403：device_id 与 Key 绑定不一致，或 scope 不足
  NOT_AUTHORIZED: 'QFR_MUSE_NOT_AUTHORIZED', // 403：账号无 muse.execute 授权
  NOT_BOUND: 'QFR_LEA_NOT_BOUND', // 403：设备未绑定
  BINDING_PENDING: 'QFR_LEA_BINDING_PENDING', // 409：绑定确认中，仅此码可 1s 后重试一次
  BINDING_CHANGED: 'QFR_BINDING_CHANGED', // 409：binding_epoch 不匹配
  GRANT_REVOKED: 'QFR_GRANT_REVOKED', // 403：授权已被撤销
  REPLAY: 'QFR_REPLAY_DETECTED', // 401：nonce 重放 / 时间戳超窗
  DUPLICATE: 'QFR_LEA_DUPLICATE_IN_PROGRESS', // 409：同一幂等键正在执行
  UNKNOWN: 'QFR_LEA_EXECUTION_UNKNOWN', // 202/200：执行结果未知，须人工/快照确认
  IDEMPOTENT_MISMATCH: 'QFR_LEA_IDEMPOTENT_MISMATCH', // 409：同一幂等键已绑定另一请求内容（FIX1：键＋指纹共同决定复用）
  NOT_INSTALLED: 'QFR_LEA_NOT_INSTALLED', // 503：设备未装 LEA 或通道不可达
  NOT_WHITELISTED: 'QFR_DEVICE_NOT_WHITELISTED', // 403：设备不在白名单（H04，DESIGN §6.2 第 ② 项）
  QUEUE_FULL: 'QFR_QUEUE_FULL', // 503：队列满（本版服务端不排队，仅透传 LEA 端此码）
  HANDSHAKE_REQUIRED: 'QFR_LEA_HANDSHAKE_REQUIRED', // 403：设备端握手未完成（RC-01），业务命令拒绝投递
  VALIDATION: 'VALIDATION', // 400
};

function sha256Hex(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }
function safeEqualHex(a, b) {
  try {
    const ba = Buffer.from(String(a), 'hex');
    const bb = Buffer.from(String(b), 'hex');
    return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
  } catch (e) { return false; }
}
function randId(n, alphabet) {
  const alpha = alphabet || KEY_ID_ALPHABET;
  const buf = crypto.randomBytes(n);
  let s = '';
  for (let i = 0; i < n; i++) s += alpha[buf[i] % alpha.length];
  return s;
}
function maskKey(prefix) {
  // 日志脱敏：只记 key_id 与前缀前 8 位/后 4 位（DESIGN §7.3），不记明文。
  // T04：此处入参恒为前缀指纹（16 位 hex，见 generateKey／loadKeys 迁移），
  // 8+4 位指纹只用于识别，无 Key 明文可逆；旧版 12 位明文前缀已不再落盘。
  if (typeof prefix !== 'string' || !prefix) return '';
  return prefix.slice(0, 8) + '…' + prefix.slice(-4);
}

function createLeaCore(opts) {
  opts = opts || {};
  const dir = opts.dir || path.join(process.cwd(), 'lea-data');
  const log = typeof opts.log === 'function' ? opts.log : function () {};
  const nowFn = typeof opts.now === 'function' ? opts.now : Date.now;
  const now = () => nowFn();
  const nowSec = () => Math.floor(now() / 1000);

  const KEYS_FILE = path.join(dir, 'keys.json');
  const GRANTS_FILE = path.join(dir, 'grants.json');
  const BINDINGS_FILE = path.join(dir, 'bindings.json');
  const JOBS_FILE = path.join(dir, 'jobs.json');
  // H11：防重放 nonce 与幂等去重表落盘（重启不丢；此前纯内存 Map，
  // 重启后危险命令可重复执行）。
  const NONCE_FILE = path.join(dir, 'nonce-seen.json');
  const IDEM_FILE = path.join(dir, 'idem-seen.json');
  // H21：本机吊销表推送台账（revocations.json）——按设备记录待推送的
  // 吊销 key_id 全集（C 端 state/revoked_keys.txt 的服务端镜像）。
  const REVOCATIONS_FILE = path.join(dir, 'revocations.json');
  // C1：自助绑定票据台账（selfbind-tickets.json）——只存票据 SHA-256
  // ＋元数据，票据明文只在 issue 响应里出现一次，永不落盘。
  const SELFBIND_TICKETS_FILE = path.join(dir, 'selfbind-tickets.json');
  // RC-04：重连票据台账（reconnect-tickets.json）——只存票据 SHA-256
  // ＋元数据（resume_id 只存哈希），票据明文只在 issue 响应里出现一次，
  // 永不落盘、永不进日志（日志只记 resume_id 前 8 位 hex 与 api_key_id）。
  const RECONNECT_TICKETS_FILE = path.join(dir, 'reconnect-tickets.json');
  // 卸载注销墓碑（deregistered.json）：已注销设备的 {account_id,
  // device_pubkey, deregistered_at, binding_epoch}。绑定条目本身已删，
  // 墓碑只为让“已注销过也返回成功（幂等）”仍能验签——重复注销须凭
  // 同一把设备私钥签名，验签不过仍拒绝，不留存在性预言口子；不存
  // 任何 Key 明文／哈希／grant，重新绑定时由 recordBinding 清掉。
  const DEREGISTERED_FILE = path.join(dir, 'deregistered.json');

  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}

  // ---------- 原子 JSON 台账读写（与 license-core 同款 tmp+rename） ----------
  function readJson(file, fallback) {
    try {
      const v = JSON.parse(fs.readFileSync(file, 'utf8'));
      return (v && typeof v === 'object') ? v : fallback;
    } catch (e) { return fallback; }
  }
  function writeJsonAtomic(file, value) {
    const tmp = file + '.tmp-' + process.pid + '-' + randId(6);
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
    try { fs.chmodSync(file, 0o600); } catch (e) {}
  }
  // T13（非问题）：全部台账读写均为同步 fs 调用，单 Node 进程内不可能交错；
  // 生产只在 server/ext/server.js 起一个实例，无 cluster／worker 多进程
  // 共享同一目录，故不引入文件锁。见 group-lb-pkg2-low-CHANGELOG.md。
  function loadKeys() {
    const st = readJson(KEYS_FILE, { keys: [] });
    // T04 一次迁移：旧记录的 prefix 若仍是 12 位明文前缀（'qfr_lea_' +
    // 4 位随机字符），读到即改写为 SHA-256 指纹（16 位 hex）并落盘；之后
    // prefix 恒为指纹，不再有明文前缀落盘。指纹为 hex 字符，不可能以
    // 'qfr_lea_' 开头，故迁移只发生一次，不会误判已迁移的记录。
    let migrated = false;
    for (const k of st.keys || []) {
      if (k && typeof k.prefix === 'string' && k.prefix.startsWith(KEY_PREFIX)) {
        k.prefix = sha256Hex(k.prefix).slice(0, 16);
        migrated = true;
      }
    }
    if (migrated) { try { saveKeys(st); } catch (e) { log({ ev: 'lea-keys-migration-failed', err: String(e && e.message) }); } }
    return st;
  }
  function saveKeys(s) { writeJsonAtomic(KEYS_FILE, s); }
  function loadGrants() { return readJson(GRANTS_FILE, { grants: {} }); }
  function saveGrants(s) { writeJsonAtomic(GRANTS_FILE, s); }
  function loadBindings() { return readJson(BINDINGS_FILE, { bindings: {} }); }
  function saveBindings(s) { writeJsonAtomic(BINDINGS_FILE, s); }
  function loadJobs() { return readJson(JOBS_FILE, { jobs: {} }); }
  function saveJobs(s) { writeJsonAtomic(JOBS_FILE, s); }
  function loadRevocations() { return readJson(REVOCATIONS_FILE, { devices: {} }); }
  function saveRevocations(s) { writeJsonAtomic(REVOCATIONS_FILE, s); }
  function loadSelfBindTickets() { return readJson(SELFBIND_TICKETS_FILE, { tickets: {} }); }
  function saveSelfBindTickets(s) { writeJsonAtomic(SELFBIND_TICKETS_FILE, s); }
  function loadReconnectTickets() { return readJson(RECONNECT_TICKETS_FILE, { tickets: {} }); }
  function saveReconnectTickets(s) { writeJsonAtomic(RECONNECT_TICKETS_FILE, s); }
  function loadDeregistered() { return readJson(DEREGISTERED_FILE, { devices: {} }); }
  function saveDeregistered(s) { writeJsonAtomic(DEREGISTERED_FILE, s); }

  // ---------- 崩溃上报接收（CRASH-REPORT-SPEC.md；匿名接收＋强防护） ----------
  // 报告只含技术信息（版本号／系统版本／模块／堆栈），不含账号／密码／
  // 令牌／cookie／聊天／屏幕内容；上传发生在下次启动、用户未必已登录，
  // 故端点不要求鉴权，防滥用靠形状校验＋限流（路由层）＋存储封顶。
  // 存储：<dir>/crash-reports/<report_id>.json，0600，tmp+rename 原子写；
  // 文件名即 report_id（UUID），由服务端校验后才用，永不信任路径。
  const CRASH_REPORTS_DIR = path.join(dir, 'crash-reports');
  const CRASH_BODY_MAX_BYTES = 200 * 1024;   // 请求体硬上限 200KB
  const CRASH_STACK_MAX_BYTES = 128 * 1024;  // stack 字段上限 128KB
  const CRASH_MAX_FILES = 5000;              // 落盘份数封顶（先到先轮转删最旧）
  const CRASH_MAX_TOTAL_BYTES = 1024 * 1024 * 1024; // 落盘总量封顶 1GB
  // 磁盘剩余不足拒收（CRASH-REPORT-SPEC.md）：低于 100MB 绝对值、或低于
  // 总量 10% 时拒收。注意不用固定 2GB——小文件系统（如测试用的 512MB
  // tmpfs）剩余空间本身就不到 2GB，固定值会把所有上报都拒掉。
  const CRASH_REPORT_FIELDS = {
    schema_version: 'int', report_id: 'uuid', app_version: 'str', platform: 'str',
    os_version: 'str', arch: 'str', crash_time: 'iso', exception_type: 'str',
    module: 'str', exit_code: 'int-or-null', stack: 'str',
  };
  const CRASH_SHORT_MAX = { app_version: 64, platform: 32, os_version: 256, arch: 32, exception_type: 128, module: 128 };
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  // L-02：严格 ISO-8601（Date.parse 另接受 "Nov 15 2026" 等非 ISO 写法，
  // 须正则＋Date.parse 双重校验才放行）。
  const ISO_8601_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
  // S-092 堆栈脱敏（与 windows/crash-handler.js scrubCrashStack 同口径，
  // 服务端再洗一次作纵深防御）：用户目录前缀掩码＋疑似凭据形态掩码，
  // 只留相对路径与行号。注意：只改 stack 字段，不动其它字段。
  function scrubCrashStack(stack) {
    if (typeof stack !== 'string' || !stack) return stack;
    let s = stack;
    // Windows 用户目录：C:\Users\<名>\ / C:/Users/<名>/
    s = s.replace(/([A-Za-z]:[\\/]Users[\\/])[^\\/:\n\r"']+/gi, '$1<redacted>');
    // POSIX 用户目录：/home/<名>/ / /Users/<名>/
    s = s.replace(/(\/(?:home|Users)\/)[^\/:\n\r"']+/g, '$1<redacted>');
    // UNC 用户目录：\\<host>\Users\<名>\
    s = s.replace(/(\\\\[^\\:\n\r"']+\\Users\\)[^\\:\n\r"']+/gi, '$1<redacted>');
    // 疑似凭据形态：key/token/password/secret 后跟的赋值内容掩码。
    s = s.replace(/((?:api[_-]?key|password|passwd|secret|token)\s*[:=]\s*['"]?)[^\s'";,}]+/gi, '$1<redacted>');
    return s;
  }
  // 校验崩溃报告体。返回 null=通过，否则返回错误原因（只记稳定文案，
  // 绝不回显请求体内容）。白名单字段之外一律拒绝——含疑似敏感名的字段
  // （password/token/cookie/secret 等）同样因不在白名单内被拒。
  function validateCrashReport(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return 'body 须为 JSON 对象。';
    for (const k of Object.keys(body)) {
      // L-01：未知字段只回固定文案，不回显字段名（超长字段名可致响应膨胀）。
      if (!Object.prototype.hasOwnProperty.call(CRASH_REPORT_FIELDS, k)) return '请求含未知字段。';
    }
    for (const k of Object.keys(CRASH_REPORT_FIELDS)) {
      const kind = CRASH_REPORT_FIELDS[k];
      const v = body[k];
      if (kind === 'int-or-null') {
        if (v !== null && v !== undefined && !Number.isSafeInteger(v)) return k + ' 须为整数或 null。';
        continue;
      }
      // L-01：缺失字段只回固定文案，不回显字段名。
      if (v === undefined || v === null) return '请求缺少必填字段。';
      if (kind === 'int') {
        if (!Number.isSafeInteger(v)) return k + ' 须为整数。';
        if (k === 'schema_version' && v !== 1) return 'schema_version 只支持 1。';
        continue;
      }
      if (kind === 'uuid') {
        // L-03：入库前 toLowerCase 归一（Linux 文件名大小写敏感，
        // 同一 UUID 大小写变体此前会落成两个文件）。
        if (typeof v !== 'string' || !UUID_RE.test(v)) return 'report_id 须为 UUID v4。';
        body.report_id = v.toLowerCase();
        continue;
      }
      if (kind === 'iso') {
        if (typeof v !== 'string') return k + ' 须为 ISO 时间字符串。';
        // L-02：严格 ISO 正则＋Date.parse 双重校验。
        if (!ISO_8601_RE.test(v)) return k + ' 须为 ISO-8601 时间字符串。';
        const t = Date.parse(v);
        if (Number.isNaN(t)) return k + ' 不是合法时间。';
        if (t > now() + 5 * 60 * 1000) return k + ' 不得晚于现在 5 分钟以上。';
        if (t < now() - 90 * 24 * 3600 * 1000) return k + ' 不得早于 90 天前。';
        continue;
      }
      if (typeof v !== 'string') return k + ' 须为字符串。';
      if (k === 'stack') {
        if (Buffer.byteLength(v, 'utf8') > CRASH_STACK_MAX_BYTES) return 'stack 超过 128KB 上限。';
      } else if (CRASH_SHORT_MAX[k] && Buffer.byteLength(v, 'utf8') > CRASH_SHORT_MAX[k]) {
        return k + ' 超过长度上限。';
      } else if (v.length === 0) {
        return k + ' 不得为空。';
      }
    }
    return null;
  }
  // 落盘一份已校验的崩溃报告。返回 { duplicate } 或抛错（err.code：
  // QFR_CRASH_STORAGE_FULL=磁盘满/剩余不足，QFR_CRASH_STORAGE_ERROR=写失败）。
  // 幂等：同一 report_id 已落盘时直接返回 duplicate，不重写。先写盘、后
  // 轮转清理（总量／份数封顶，删最旧）；磁盘剩余不足时拒绝写入，绝不半写。
  function storeCrashReport(report) {
    // L-03 纵深：路由层已归一，此处再归一一次（直接调本函数时同样生效）。
    const reportId = String(report.report_id || '').toLowerCase();
    try { fs.mkdirSync(CRASH_REPORTS_DIR, { recursive: true }); } catch (e) {}
    const file = path.join(CRASH_REPORTS_DIR, reportId + '.json');
    if (fs.existsSync(file)) return { duplicate: true, bytes: 0 };
    let freeBytes = null, totalBytes = null;
    try {
      const st = fs.statfsSync(CRASH_REPORTS_DIR);
      // L-06：bfree 含 root 保留块会高估可用空间，改 bavail（普通用户实际可用）。
      freeBytes = (typeof st.bavail === 'number' ? st.bavail : st.bfree) * st.bsize;
      totalBytes = st.blocks * st.bsize;
    } catch (e) { freeBytes = null; totalBytes = null; }
    if (freeBytes !== null && (freeBytes < 100 * 1024 * 1024 ||
        (totalBytes !== null && freeBytes < totalBytes * 0.1))) {
      const e = new Error('磁盘剩余空间不足，拒绝接收崩溃报告。');
      e.code = 'QFR_CRASH_STORAGE_FULL'; throw e;
    }
    // S-092：落盘前对 stack 脱敏（用户名／家目录／盘符路径掩码）。
    const stored = Object.assign({}, report, { report_id: reportId, stack: scrubCrashStack(report.stack), received_at: new Date(now()).toISOString() });
    const data = Buffer.from(JSON.stringify(stored), 'utf8');
    const tmp = file + '.tmp-' + process.pid + '-' + randId(6);
    try {
      fs.writeFileSync(tmp, data, { mode: 0o600, flag: 'wx' });
      // L-04：existsSync 检查与写盘非原子，并发同 id 可双双 stored:true。
      // 改用 link(2) 原子建链：目标已存在即 EEXIST，判 duplicate；成功后再删 tmp。
      try {
        fs.linkSync(tmp, file);
      } catch (linkErr) {
        if (linkErr && linkErr.code === 'EEXIST') {
          try { fs.unlinkSync(tmp); } catch (e2) {}
          return { duplicate: true, bytes: 0 };
        }
        // 极少数文件系统不支持硬链接时退回 rename（窗口极小：tmp 名唯一，
        // 且写前已判不存在；rename 仍可能覆盖并发写入，属可接受降级）。
        fs.renameSync(tmp, file);
      }
      try { fs.unlinkSync(tmp); } catch (e) {}
      try { fs.chmodSync(file, 0o600); } catch (e) {}
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch (e2) {}
      if (e && e.code === 'QFR_CRASH_STORAGE_FULL') throw e;
      const e2 = new Error('崩溃报告落盘失败。');
      e2.code = 'QFR_CRASH_STORAGE_ERROR'; throw e2;
    }
    pruneCrashReports();
    return { duplicate: false, bytes: data.length };
  }
  function pruneCrashReports() {
    try {
      const names = fs.readdirSync(CRASH_REPORTS_DIR).filter((n) => n.endsWith('.json'));
      const entries = names.map((n) => {
        let st = null;
        try { st = fs.statSync(path.join(CRASH_REPORTS_DIR, n)); } catch (e) { st = null; }
        return { n, size: st ? st.size : 0, mtimeMs: st ? st.mtimeMs : 0 };
      }).sort((a, b) => a.mtimeMs - b.mtimeMs);
      let total = entries.reduce((s, e) => s + e.size, 0);
      while ((entries.length > CRASH_MAX_FILES || total > CRASH_MAX_TOTAL_BYTES) && entries.length) {
        const oldest = entries.shift();
        try { fs.unlinkSync(path.join(CRASH_REPORTS_DIR, oldest.n)); total -= oldest.size; } catch (e) {}
      }
      // L-07：writeFileSync(tmp) 与 rename/link 之间进程崩溃会留孤儿
      // <id>.json.tmp-<pid>-<rand>；此前 prune 只处理 *.json，孤儿不被清理
      // 也不计入 1GB 封顶。超期（1 小时）孤儿一并清掉。
      const tmpCutoff = now() - 3600 * 1000;
      for (const n of fs.readdirSync(CRASH_REPORTS_DIR)) {
        if (!/\.json\.tmp-\d+-/.test(n)) continue;
        try {
          const st = fs.statSync(path.join(CRASH_REPORTS_DIR, n));
          if (st.mtimeMs < tmpCutoff) fs.unlinkSync(path.join(CRASH_REPORTS_DIR, n));
        } catch (e) { /* 清理失败不影响已收下的报告 */ }
      }
    } catch (e) { /* 清理失败不影响已收下的报告 */ }
  }

  // ---------- 审计（JSONL 按天，§11.2；保留 ≥180 天，定期清扫） ----------
  function auditFileName(d) {
    const p2 = (n) => String(n).padStart(2, '0');
    return 'audit-' + d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + '.jsonl';
  }
  function audit(ev, fields) {
    // S-083：审计字段过禁键过滤（密码／cookie／Key 明文等永不入审计；
    // 字段名各异故只做禁键过滤，不做白名单）。写失败返回 null（L-08：
    // 调用方据此决定是否 503；此前一律返回 rec，写失败也被当成功）。
    const rec = Object.assign({
      ts: new Date(now()).toISOString(), ev,
      // 审计字段（§11.2）：trace_id/request_id/batch_id/account_id/
      // device_id/api_key_id/binding_epoch/command/error_code/...
      // api_key 明文永不入审计，只记 key_id 与前缀脱敏。
    }, scrubForbiddenKeys(fields || {}));
    try {
      fs.appendFileSync(path.join(dir, auditFileName(new Date(now()))),
        JSON.stringify(rec) + '\n', { mode: 0o600 });
    } catch (e) {
      try { log({ ev: 'lea-audit-write-failed', err: String(e && e.message) }); } catch (e2) {}
      return null;
    }
    return rec;
  }
  function pruneAudit() {
    // 删 180 天前的审计文件；失败只记日志，不影响主流程。
    try {
      const cutoff = now() - AUDIT_RETENTION_DAYS * 24 * 3600 * 1000;
      for (const f of fs.readdirSync(dir)) {
        if (!/^audit-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)) continue;
        const fp = path.join(dir, f);
        try { if (fs.statSync(fp).mtimeMs < cutoff) fs.unlinkSync(fp); } catch (e) {}
      }
    } catch (e) {}
  }
  let sweepTimer = null;
  if (opts.enableSweeps !== false) {
    sweepTimer = setInterval(() => { pruneAudit(); pruneJobs(); sweepStaleJobs(); }, 3600 * 1000);
    if (sweepTimer && sweepTimer.unref) sweepTimer.unref();
    pruneAudit();
  }
  // 启动即推进一次：上轮进程崩溃／重启残留的失联 job 不等下一小时整点。
  sweepStaleJobs();

  // ---------- B1：in-flight 名额与通道健康 ----------
  // in-flight：每节点当前下发中的 dispatchEnvelope 调用数（runcommands
  // 在途），上限 B1_INFLIGHT_MAX（8，与 LEA 端队列准入一致）。dispatch
  // 返回（成功／失败／超时）即释放——名额只约束“下发中”，不约束设备
  // 侧已入队仍在执行的 job（那是 LEA 端队列的事）。
  const inflightByNode = new Map(); // device_id -> count
  function inflightAcquire(deviceId) {
    const n = inflightByNode.get(deviceId) || 0;
    if (n >= B1_INFLIGHT_MAX) return false;
    inflightByNode.set(deviceId, n + 1);
    return true;
  }
  function inflightRelease(deviceId) {
    const n = (inflightByNode.get(deviceId) || 0) - 1;
    if (n <= 0) inflightByNode.delete(deviceId);
    else inflightByNode.set(deviceId, n);
  }
  // 健康：每节点连续下发超时计数与状态（OK／DEGRADED／RECOVERING）。
  // 连续 B1_HEALTH_FAILS（2）次下发超时即标 DEGRADED；下次下发前先
  // sys.ping 探测，失败进 RECOVERING（sys.reset＋sys.ping 验证），
  // 验证通过才恢复业务；验证失败即拒绝本次下发（NOT_INSTALLED）。
  // 注意：服务端 reset 只是第二层——LEA 端看门狗（QFRLEA）才是第一层
  // 自愈（杀活动 job＋清队）；reset 信封走 sys.reset 内联，不进 LEA
  // 队列，不会被堵住的命令挡在后面。
  const healthByNode = new Map(); // device_id -> { fails, state }
  function healthGet(deviceId) {
    let h = healthByNode.get(deviceId);
    if (!h) { h = { fails: 0, state: 'OK' }; healthByNode.set(deviceId, h); }
    return h;
  }
  function healthNoteSuccess(deviceId) {
    const h = healthGet(deviceId);
    h.fails = 0; h.state = 'OK';
  }
  function healthNoteTimeout(deviceId) {
    const h = healthGet(deviceId);
    h.fails += 1;
    if (h.fails >= B1_HEALTH_FAILS) h.state = 'DEGRADED';
    return h;
  }
  // B1 推进器（2 秒定时）：UNKNOWN／DISPATCH_TIMEOUT 超 B1_JOB_UNKNOWN_TIMEOUT_MS
  // （10 秒）即判 TIMED_OUT（结果未知→超时终态；调用方须快照确认，
  // 勿直接重试危险操作）。与 sweepStaleJobs（1 小时／15 分钟失联阈值）并存：
  // sweepB1Jobs 管“下发超时后 UNKNOWN／DISPATCH_TIMEOUT 的快速终态”，
  // sweepStaleJobs 管“长时间失联的兜底推进”。DISPATCH_TIMEOUT 也须推进——
  // 否则该态 job 与幂等 RUNNING 会永久卡住（sweepStaleJobs 只认
  // RUNNING／UNKNOWN／PENDING，不认 DISPATCH_TIMEOUT）。
  function sweepB1Jobs() {
    try {
      const st = loadJobs();
      let dirty = false;
      for (const [id, j] of Object.entries(st.jobs)) {
        if (!j || (j.status !== 'UNKNOWN' && j.status !== 'DISPATCH_TIMEOUT')) continue;
        if (now() - (j.updated_at || j.created_at || 0) <= B1_JOB_UNKNOWN_TIMEOUT_MS) continue;
        j.status = 'TIMED_OUT'; j.error_code = 'QFR_LEA_TIMEOUT'; j.updated_at = now(); dirty = true;
        if (j.idempotency_key && j.account_id && j.api_key_id) {
          const ns = j.batch_id ? IDEM_NS.BATCH : IDEM_NS.EXEC;
          const prev = idemLookup(j.account_id, j.api_key_id, j.idempotency_key, ns);
          if (prev && prev.status === 'RUNNING') {
            idemRecord(j.account_id, j.api_key_id, j.idempotency_key,
              Object.assign({}, prev, { status: 'UNKNOWN' }), ns);
          }
        }
        audit('lea-job-b1-timeout', {
          job_id: id, account_id: j.account_id || null, device_id: j.device_id || null,
          api_key_id: j.api_key_id || null, idempotency_key: j.idempotency_key || null,
        });
      }
      if (dirty) saveJobs(st);
      return true;
    } catch (e) { return false; }
  }
  let sweepB1Timer = null;
  if (opts.enableSweeps !== false) {
    sweepB1Timer = setInterval(() => { try { sweepB1Jobs(); } catch (e) {} }, B1_SWEEP_MS);
    if (sweepB1Timer && sweepB1Timer.unref) sweepB1Timer.unref();
  }

  // ---------- Ed25519 签名（DESIGN §4.1；F-04 fail-closed） ----------
  // 生产唯一签名方式是真实私钥（mode='real'）。已配置但加载失败 →
  // 抛错，createLeaCore 拒绝启动签名能力（不静默回退临时密钥）；
  // 未配置 → mode='disabled'，签名函数直接拒；临时密钥只允许测试
  // 显式开启（opts.allowEphemeralSigning === true），且即使开启，
  // 下发门仍只放行 mode='real'。完整移除回退逻辑排 3.0.1 评估。
  const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
  let signing = { mode: 'disabled', privateKey: null, publicKeyBase64: null };
  // 公钥指纹（SHA-256 前 16 位 hex）：日志／核对只用指纹，不记密钥内容。
  function signingPublicKeyFingerprint() {
    if (!signing.publicKeyBase64) return null;
    return crypto.createHash('sha256').update(signing.publicKeyBase64).digest('hex').slice(0, 16);
  }
  function loadSigningKey() {
    const configured = !!(opts.signingKeyFile || opts.signingKeyPem);
    if (configured) {
      try {
        if (opts.signingKeyFile) {
          const raw = Buffer.from(String(fs.readFileSync(opts.signingKeyFile, 'utf8')).trim(), 'base64');
          if (raw.length !== 64) throw new Error('LEA signing key must be base64 of 64 bytes (seed||pub)');
          const der = Buffer.concat([ED25519_PKCS8_PREFIX, raw.subarray(0, 32)]);
          const priv = crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
          signing = { mode: 'real', privateKey: priv, publicKeyBase64: raw.subarray(32).toString('base64') };
          log({ ev: 'lea-signing-real-key-loaded', signing_mode: 'real', public_key_fingerprint: signingPublicKeyFingerprint() });
          return;
        }
        if (opts.signingKeyPem) {
          const priv = crypto.createPrivateKey(opts.signingKeyPem);
          const pubDer = crypto.createPublicKey(priv).export({ format: 'der', type: 'spki' });
          signing = { mode: 'real', privateKey: priv, publicKeyBase64: pubDer.slice(-32).toString('base64') };
          log({ ev: 'lea-signing-real-key-loaded', signing_mode: 'real', public_key_fingerprint: signingPublicKeyFingerprint() });
          return;
        }
      } catch (e) {
        // F-04：已配置但加载失败是生产 fail-closed 项——记审计后抛错，
        // 拒绝启动 LEA 签名能力；绝不静默落入临时密钥。
        log({ ev: 'lea-signing-key-load-failed', signing_mode: 'failed', err: String(e && e.message) });
        throw new Error('LEA signing key configured but failed to load; refusing to start LEA signing capability: ' + String(e && e.message));
      }
    }
    if (opts.allowEphemeralSigning === true) {
      // 测试显式开启的临时密钥（TEST ONLY）：重启即换，真实客户端无法
      // 验签；下发门仍只放行 mode='real'。生产调用方永不传此选项。
      const kp = crypto.generateKeyPairSync('ed25519');
      const pubJwk = kp.publicKey.export({ format: 'jwk' });
      signing = { mode: 'placeholder-ephemeral', privateKey: kp.privateKey, publicKeyBase64: pubJwk.x };
      log({ ev: 'lea-signing-placeholder', signing_mode: 'placeholder-ephemeral', msg: 'TEST ONLY: using ephemeral in-process Ed25519 key; signatures are NOT verifiable by LEA clients across restarts and dispatch is refused (mode != real). Configure signingKeyFile before production use.' });
      return;
    }
    signing = { mode: 'disabled', privateKey: null, publicKeyBase64: null };
    log({ ev: 'lea-signing-disabled', signing_mode: 'disabled', msg: 'No LEA signing key configured: LEA signing disabled; envelope/ticket signing and dispatch are refused. Configure signingKeyFile before production use.' });
  }
  loadSigningKey();
  // 启动日志明确记录 signing_mode（F-04 最小门禁）。
  log({ ev: 'lea-signing-mode', signing_mode: signing.mode, public_key_fingerprint: signingPublicKeyFingerprint() });
  function signingInfo() {
    return { mode: signing.mode, publicKeyBase64: signing.publicKeyBase64 };
  }
  // ---------- 规范串 v2（信封）／v1（票据）：stable JSON / 字段校验 ----------
  // 信封规范见 CANONICAL-SIGNING-V2.md §2，票据规范见 CANONICAL-SIGNING-V1.md §3。
  // 整数索引键：符合 ^(0|[1-9]\d*)$ 且数值 ≤ 4294967294（2^32-2）。
  // 规范键序：整数索引键在前按数值升序，其余键在后按字典序升序——与
  // JSON.stringify 的属性输出顺序一致，故归一化后线上 JSON 的 params
  // 子串恒等于 stable JSON（整数样式键也不例外；旧版只用 .sort() 会错）。
  function isIntegerIndexKey(k) {
    if (!/^(0|[1-9]\d*)$/.test(k)) return false;
    return Number(k) <= 4294967294;
  }
  function canonicalKeyOrder(keys) {
    const ints = [], rest = [];
    for (const k of keys) (isIntegerIndexKey(k) ? ints : rest).push(k);
    ints.sort((a, b) => Number(a) - Number(b));
    rest.sort();
    return ints.concat(rest);
  }
  // stableStringify：键按规范键序、递归、无空白；标量与 JSON.stringify 一致。
  // 遇非 JSON 安全值（函数／Symbol／undefined／自有 toJSON 函数）即抛错，
  // 不做静默过滤——否则签名哈希会与线上 JSON.stringify 实际输出脱钩（§2.1）。
  function stableStringify(v) {
    if (v === null || typeof v !== 'object') {
      if (typeof v === 'function' || typeof v === 'symbol' || v === undefined) {
        throw new Error('LEA params value not JSON-safe');
      }
      return JSON.stringify(v);
    }
    if (Object.prototype.hasOwnProperty.call(v, 'toJSON') && typeof v.toJSON === 'function') {
      throw new Error('LEA params value not JSON-safe: toJSON');
    }
    if (Array.isArray(v)) {
      return '[' + v.map((e) => {
        const s = stableStringify(e);
        return s === undefined ? 'null' : s;
      }).join(',') + ']';
    }
    const keys = canonicalKeyOrder(Object.keys(v)).filter((k) => {
      const x = v[k];
      if (typeof x === 'function' || typeof x === 'symbol' || x === undefined) {
        throw new Error('LEA params value not JSON-safe');
      }
      return true;
    });
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
  }
  // normalizeParams：params 深拷贝并把全部对象键排成规范键序，使线上 JSON 的
  // params 子串就是 stable JSON（C 端对 params_raw 原文算哈希才能对上）。
  // 用 defineProperty 写入：普通赋值会把 "__proto__" 键吞成原型而丢失。
  // 非 JSON 安全值（函数／Symbol／undefined／非普通对象如 Date／自有 toJSON
  // 函数）即抛错：JSON.stringify 会调用 toJSON 改写线上子串，静默过滤会
  // 让签名哈希与线上字节脱钩。
  function normalizeParams(v) {
    if (v === null || typeof v !== 'object') {
      if (typeof v === 'function' || typeof v === 'symbol' || v === undefined) {
        throw new Error('LEA params value not JSON-safe');
      }
      return v;
    }
    if (Object.prototype.hasOwnProperty.call(v, 'toJSON') && typeof v.toJSON === 'function') {
      throw new Error('LEA params value not JSON-safe: toJSON');
    }
    if (Array.isArray(v)) return v.map(normalizeParams);
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) {
      throw new Error('LEA params value not JSON-safe: non-plain object');
    }
    const o = {};
    for (const k of canonicalKeyOrder(Object.keys(v))) {
      Object.defineProperty(o, k, {
        value: normalizeParams(v[k]), enumerable: true, writable: true, configurable: true,
      });
    }
    return o;
  }
  // 规范串字符串字段规则：须为字符串，不得含控制字符（含 \n \r）与 DEL。
  function checkCanonicalString(v, name) {
    if (typeof v !== 'string' || /[\x00-\x1F\x7F]/.test(v)) {
      throw new Error('LEA canonical field invalid: ' + name);
    }
  }
  // token 规则（与 C lea_validate_token 一致）：[A-Za-z0-9_-]，8..128。
  // 长度按 UTF-8 字节计（token 字符集为 ASCII，与字符数相同）。
  function checkToken(v, name) {
    if (typeof v !== 'string' || Buffer.byteLength(v, 'utf8') < 8 || Buffer.byteLength(v, 'utf8') > 128 || /[^A-Za-z0-9_-]/.test(v)) {
      throw new Error('LEA canonical field invalid: ' + name);
    }
  }
  // id 字段规则（与 C lea_validate_id_field 一致）：非空、1..127 字节，无控制字符。
  // 长度按 UTF-8 字节计（JS .length 是 UTF-16 码元数，100 个汉字为 100 码元但 300 字节）。
  function checkIdField(v, name) {
    if (typeof v !== 'string' || Buffer.byteLength(v, 'utf8') < 1 || Buffer.byteLength(v, 'utf8') > 127 || /[\x00-\x1F\x7F]/.test(v)) {
      throw new Error('LEA canonical field invalid: ' + name);
    }
  }
  // 有效超时（与 C lea_effective_timeout_ms 对齐，但非法即抛错）：
  // 缺失（=== undefined）→ 命令默认值；显式存在但非法（null、非整数、
  // <1、>命令上限）→ 抛错，不回退默认。null 不是缺失。
  function effectiveTimeoutMs(env) {
    const spec = COMMANDS[env.command];
    if (!spec) throw new Error('LEA canonical field invalid: command');
    if (env.timeout_ms === undefined) return spec.timeoutMs;
    if (!Number.isInteger(env.timeout_ms) || env.timeout_ms < 1 || env.timeout_ms > spec.maxTimeoutMs) {
      throw new Error('LEA canonical field invalid: timeout_ms');
    }
    return env.timeout_ms;
  }
  // 签名覆盖全部关键字段（DESIGN §4.1；规范串 v2，见 CANONICAL-SIGNING-V2.md §2）：
  // 20 行 \n 连接串（v1 的 19 行＋binding_epoch 之后一行 grant_epoch），
  // params 只签 stable JSON 的 SHA-256，timeout 取有效超时。
  // F-02：grant_epoch 为无符号整数，上限 2^53-1（JS 安全整数界，
  // 与 C 端解析上限一致，见规范 §2.1）；最短十进制、无前导零、
  // 无符号位——JS 侧由安全整数＋≥0 保证，C 侧由严格切片解析保证。
  // 规范串行数固定：每一行都必须存在（B1 缺省值与 C 端解析缺省一致，
  // job_id 缺省 ''、mode 缺省 ''、deadline_ms 缺省 0）；规范串签信封
  // 原文值，不是派生值（C 端运行时 job_id 缺省即 request_id、deadline
  // 缺省即分级默认值，那是运行时的回退，不是签名值）。
  // 行尾：LF 连接、无结尾换行；字段值禁 CR／LF／NUL 等控制字符
  // （checkToken／checkIdField／checkCanonicalString 已拦）。
  function envelopeSigningBytes(env) {
    if (env.version !== 2) throw new Error('LEA canonical field invalid: version');
    // 未知字段一律拒绝（与 C 端 lea_parse_envelope 顶层键白名单同规则）：
    // 规范串只覆盖已知字段，多余字段不得悄悄带过签名。
    for (const k of Object.keys(env || {})) {
      if (!ENVELOPE_FIELDS.has(k)) throw new Error('LEA canonical field invalid: ' + k);
    }
    checkToken(env.request_id, 'request_id');
    checkToken(env.nonce, 'nonce');
    checkToken(env.idempotency_key, 'idempotency_key');
    checkIdField(env.device_id, 'device_id');
    checkIdField(env.account_id, 'account_id');
    checkIdField(env.api_key_id, 'api_key_id');
    if (env.batch_id != null) {
      if (typeof env.batch_id !== 'string') throw new Error('LEA canonical field invalid: batch_id');
      if (env.batch_id !== '') checkIdField(env.batch_id, 'batch_id');
    }
    checkCanonicalString(env.command, 'command');
    if (!COMMANDS[env.command]) throw new Error('LEA canonical field invalid: command');
    // 整数字段须为安全整数：超 2^53 的值在 JS 内已失真，String() 结果与
    // C 端 long long 解析值不一致，不得签名。
    if (!Number.isSafeInteger(env.seq) || env.seq < 1) throw new Error('LEA canonical field invalid: seq');
    for (const [name, v] of [['binding_epoch', env.binding_epoch], ['issued_at', env.issued_at], ['expires_at', env.expires_at]]) {
      if (!Number.isSafeInteger(v)) throw new Error('LEA canonical field invalid: ' + name);
    }
    // F-02：grant_epoch 必填、无符号安全整数（缺失／负数／超 2^53-1 即拒签，
    // 不得缺省为 0 后签名——0 只在字段显式为 0 时才是合法表示）。
    if (!Number.isSafeInteger(env.grant_epoch) || env.grant_epoch < 0) {
      throw new Error('LEA canonical field invalid: grant_epoch');
    }
    // B1：新字段校验（缺省即不校验，与 C 端解析缺省一致）。
    if (env.job_id != null && env.job_id !== '') checkToken(env.job_id, 'job_id');
    if (env.mode != null && env.mode !== '') {
      if (env.mode !== 'sync' && env.mode !== 'async') throw new Error('LEA canonical field invalid: mode');
    }
    if (env.deadline_ms != null) {
      if (!Number.isSafeInteger(env.deadline_ms) || env.deadline_ms < 1 || env.deadline_ms > 120000) {
        throw new Error('LEA canonical field invalid: deadline_ms');
      }
    }
    const paramsHash = sha256Hex(stableStringify(env.params || {}));
    return [
      'qfr-lea-envelope-v2',
      String(env.version),
      String(env.request_id),
      env.batch_id || '',
      String(env.seq),
      String(env.device_id),
      String(env.account_id),
      String(env.api_key_id),
      String(env.binding_epoch),
      String(env.grant_epoch),
      String(env.nonce),
      String(env.issued_at),
      String(env.expires_at),
      String(env.idempotency_key),
      String(env.command),
      paramsHash,
      String(effectiveTimeoutMs(env)),
      String(env.job_id || ''),
      String(env.mode || ''),
      String(env.deadline_ms != null ? env.deadline_ms : 0),
    ].join('\n');
  }
  function signEnvelope(env) {
    // F-04：签名能力关闭（disabled）时直接拒，不签无密钥信封。
    if (signing.mode === 'disabled' || !signing.privateKey) throw new Error('LEA signing disabled: no signing key configured (signing_mode=' + signing.mode + ')');
    const sig = crypto.sign(null, Buffer.from(envelopeSigningBytes(env), 'utf8'), signing.privateKey);
    return Object.assign({}, env, { signature: sig.toString('base64') });
  }
  function verifyEnvelope(env, publicKeyBase64) {
    try {
      if (!env || !env.signature) return false;
      const pubJwk = { kty: 'OKP', crv: 'Ed25519', x: publicKeyBase64 || signing.publicKeyBase64 };
      const pub = crypto.createPublicKey({ key: pubJwk, format: 'jwk' });
      return crypto.verify(null, Buffer.from(envelopeSigningBytes(env), 'utf8'), pub,
        Buffer.from(String(env.signature), 'base64'));
    } catch (e) { return false; }
  }

  // ---------- 绑定票据签名 v1（S2；规范串见 CANONICAL-SIGNING-V1.md §3） ----------
  // scope 数组 → 规范字符串：去重＋字典序升序＋逗号连接、无空格。
  function canonicalScopesString(scopes) {
    if (typeof scopes === 'string') return scopes;
    const toks = (Array.isArray(scopes) ? scopes : []).map(String).filter(Boolean);
    toks.sort();
    return [...new Set(toks)].join(',');
  }
  // 规范 scopes 字符串格式：空或逗号连接的 token，严格升序、无空格、无空 token、无重复。
  function validateScopesString(s) {
    if (s === '') return true;
    if (/[^A-Za-z0-9_.,-]/.test(s)) return false;
    const toks = s.split(',');
    for (let i = 0; i < toks.length; i++) {
      if (!toks[i]) return false;
      if (i > 0 && toks[i] <= toks[i - 1]) return false;
    }
    return true;
  }
  // 票据规范串 v1：9 行 \n 连接串，覆盖全部授权字段（grant／scopes／lease_id）。
  // 严格规则：scopes 必须是规范字符串（非字符串一律拒绝，数组只在签发入口
  // 归一化）；grant_muse_execute 严格 0/1，不得 truthy 归一化——否则线上的
  // 2 会被归一化为 1 入串，签名无法绑定线上的实际值。scopes 整串上限 256
  // UTF-8 字节（v1 定，与 C 端票据解析缓冲一致）；lease_id 非空时合 id 规则。
  function ticketSigningBytes(t) {
    checkIdField(t.account_id, 'account_id');
    checkIdField(t.device_id, 'device_id');
    if (typeof t.scopes !== 'string') throw new Error('LEA ticket scopes not canonical');
    checkCanonicalString(t.scopes, 'scopes');
    if (!validateScopesString(t.scopes)) throw new Error('LEA ticket scopes not canonical');
    if (Buffer.byteLength(t.scopes, 'utf8') > 256) throw new Error('LEA ticket scopes too long');
    const leaseId = t.lease_id == null ? '' : t.lease_id;
    checkCanonicalString(leaseId, 'lease_id');
    if (leaseId !== '') checkIdField(leaseId, 'lease_id');
    if (t.grant_muse_execute !== 0 && t.grant_muse_execute !== 1) {
      throw new Error('LEA ticket field invalid: grant_muse_execute');
    }
    for (const [name, v] of [['binding_epoch', t.binding_epoch], ['grant_epoch', t.grant_epoch], ['expires_at', t.expires_at]]) {
      if (!Number.isSafeInteger(v)) throw new Error('LEA ticket field invalid: ' + name);
    }
    return [
      'qfr-lea-ticket-v1',
      String(t.account_id),
      String(t.device_id),
      String(t.binding_epoch),
      String(t.grant_epoch),
      String(t.grant_muse_execute),
      t.scopes,
      leaseId,
      String(t.expires_at),
    ].join('\n');
  }
  function signTicket(ticket) {
    // F-04：签名能力关闭（disabled）时直接拒，不签无密钥票据。
    if (signing.mode === 'disabled' || !signing.privateKey) throw new Error('LEA signing disabled: no signing key configured (signing_mode=' + signing.mode + ')');
    const sig = crypto.sign(null, Buffer.from(ticketSigningBytes(ticket), 'utf8'), signing.privateKey);
    return Object.assign({}, ticket, { ticket_signature: sig.toString('base64') });
  }
  function verifyTicket(ticket, publicKeyBase64) {
    try {
      if (!ticket || !ticket.ticket_signature) return false;
      const pubJwk = { kty: 'OKP', crv: 'Ed25519', x: publicKeyBase64 || signing.publicKeyBase64 };
      const pub = crypto.createPublicKey({ key: pubJwk, format: 'jwk' });
      return crypto.verify(null, Buffer.from(ticketSigningBytes(ticket), 'utf8'), pub,
        Buffer.from(String(ticket.ticket_signature), 'base64'));
    } catch (e) { return false; }
  }
  // 签发绑定票据：与信封同一 Ed25519 密钥。调用方须原样转发票据全部字段。
  // 签发入口归一化：scopes 数组 → 规范字符串；grant → 0/1；leaseId 只有
  // 缺省（== null）时自动生成，显式传入（含空串）时须合 lease-＋16 hex
  // 格式，不合格式拒绝签发，不得静默改发新租约。
  function issueBindingTicket(input) {
    const leaseId = input.leaseId == null
      ? ('lease-' + crypto.randomBytes(8).toString('hex'))
      : input.leaseId;
    if (typeof leaseId !== 'string' || !/^lease-[0-9a-f]{16}$/.test(leaseId)) {
      throw new Error('LEA ticket lease_id invalid');
    }
    const ticket = {
      account_id: String(input.accountId),
      device_id: String(input.deviceId),
      binding_epoch: input.bindingEpoch,
      grant_epoch: input.grantEpoch,
      grant_muse_execute: input.grantMuseExecute ? 1 : 0,
      scopes: canonicalScopesString(input.scopes || []),
      lease_id: leaseId,
      expires_at: input.expiresAt,
    };
    return signTicket(ticket);
  }

  // ---------- 防重放 / 幂等（内存去重表，DESIGN §4.1/§4.2） ----------
  // nonce：按 key_id 分桶，保留 10 分钟；idempotency：按 (account,key,键)
  // 记结果，保留 7 天（危险命令 30 天——本版统一 30 天，宁严勿松）。
  // H11：两表落盘持久化（nonce-seen.json / idem-seen.json，原子写），
  // 启动时加载未过期的条目，重启后防重放与幂等去重不丢。
  const nonceSeen = new Map(); // key_id -> Map(nonce -> atMs)
  const idemSeen = new Map(); // `${account_id}|${key_id}|${idempotency_key}` -> {at, status, result}
  // DS 复查建议（H11 写放大）：nonce 与 idem 分开落盘——nonceCheck 只写
  // nonce 文件、idemRecord 只写 idem 文件，不再每次变更全量重写两份。
  // 仍是每次变更即持久化（重启不丢）；更大规模下可再改追加写＋定期压实。
  function persistNonce() {
    try {
      const n = {};
      for (const [keyId, bucket] of nonceSeen) {
        const b = {};
        for (const [nonce, at] of bucket) if (now() - at <= NONCE_RETENTION_MS) b[nonce] = at;
        if (Object.keys(b).length) n[keyId] = b;
      }
      writeJsonAtomic(NONCE_FILE, n);
    } catch (e) { log({ ev: 'lea-nonce-persist-failed', err: String(e && e.message) }); }
  }
  function persistIdem() {
    try {
      const d = {};
      for (const [k, e] of idemSeen) {
        const ttl = e.dangerous ? 30 * 24 * 3600 * 1000 : IDEMPOTENT_RETENTION_MS;
        if (typeof e.at === 'number' && now() - e.at <= ttl) d[k] = e;
      }
      writeJsonAtomic(IDEM_FILE, d);
    } catch (e) { log({ ev: 'lea-idem-persist-failed', err: String(e && e.message) }); }
  }
  function persistReplay() { persistNonce(); persistIdem(); }
  function loadPersistedReplay() {
    try {
      const n = readJson(NONCE_FILE, null);
      if (n && typeof n === 'object') {
        for (const [keyId, bucket] of Object.entries(n)) {
          if (!bucket || typeof bucket !== 'object') continue;
          const m = new Map();
          for (const [nonce, at] of Object.entries(bucket)) {
            if (typeof at === 'number' && now() - at <= NONCE_RETENTION_MS) m.set(nonce, at);
          }
          if (m.size) nonceSeen.set(keyId, m);
        }
      }
    } catch (e) {}
    try {
      const d = readJson(IDEM_FILE, null);
      if (d && typeof d === 'object') {
        for (const [k, e] of Object.entries(d)) {
          if (!e || typeof e !== 'object') continue;
          const ttl = e.dangerous ? 30 * 24 * 3600 * 1000 : IDEMPOTENT_RETENTION_MS;
          if (typeof e.at === 'number' && now() - e.at <= ttl) idemSeen.set(k, e);
        }
      }
    } catch (e) {}
  }
  loadPersistedReplay();
  function nonceCheck(keyId, nonce) {
    let bucket = nonceSeen.get(keyId);
    if (!bucket) { bucket = new Map(); nonceSeen.set(keyId, bucket); }
    for (const [n, at] of bucket) if (now() - at > NONCE_RETENTION_MS) bucket.delete(n);
    if (bucket.has(nonce)) return false;
    bucket.set(nonce, now());
    persistNonce();
    return true;
  }
  // DC-A-4：幂等命名空间——单条 exec／批量 batch／批量步 step 三类调用
  // 共用一张 idemSeen 表时，单条键 "X-1" 会与批量 "X" 的第 1 步撞槽，
  // 批量级 "X" 也会与单条 "X" 撞槽：一方缓存结果会被另一方误认复用，
  // 导致“该执行的不执行／返回别人的结果”。内部键加命名空间隔离。
  // 读时兼容旧版无命名空间条目（升级前已落盘的 idem-seen.json 仍为
  // account|key|idem 形态，命名空间查找不到时回落旧键；旧条目最多
  // 保留 7 天（危险 30 天），过期后自然消失）。
  const IDEM_NS = { EXEC: 'exec', BATCH: 'batch', STEP: 'step' };
  function idemMapKey(accountId, keyId, idemKey, ns) {
    return (ns ? ns + '|' : '') + accountId + '|' + keyId + '|' + idemKey;
  }
  function idemLookup(accountId, keyId, idemKey, ns) {
    const k = idemMapKey(accountId, keyId, idemKey, ns);
    let e = idemSeen.get(k);
    if (!e && ns) {
      // DC-A-4 升级兼容：旧版无命名空间条目首次被带命名空间查到时，就地迁移到命名空间键下
      // （旧键删除、落盘一次），之后读写一律走命名空间键；旧条目最多保留 7 天／危险 30 天。
      // 已知不可复原的边界（DS round 1 确认）：旧条目本身不带命名空间信息，若同一 idemKey
      // 在升级前曾跨命名空间复用过（正是 DC-A-4 修的旧 bug 形态），本次迁移会把它归到首次查到
      // 它的那个命名空间下——该误归只影响升级前已存在且未过期的旧条目，升级后所有写入都带
      // 命名空间，此情形不再产生；相对旧版“所有命名空间共用同一槽位”，迁移只缩小不扩大串扰面。
      const legacyKey = idemMapKey(accountId, keyId, idemKey, '');
      e = idemSeen.get(legacyKey);
      if (e) { idemSeen.delete(legacyKey); idemSeen.set(k, e); persistIdem(); }
    }
    if (!e) return null;
    const ttl = e.dangerous ? 30 * 24 * 3600 * 1000 : IDEMPOTENT_RETENTION_MS;
    if (now() - e.at > ttl) {
      idemSeen.delete(k);
      if (ns) idemSeen.delete(idemMapKey(accountId, keyId, idemKey, ''));
      persistIdem(); return null;
    }
    return e;
  }
  function idemRecord(accountId, keyId, idemKey, entry, ns) {
    idemSeen.set(idemMapKey(accountId, keyId, idemKey, ns), Object.assign({ at: now() }, entry));
    persistIdem();
  }

  // 节点 id 归一：MeshCentral 节点 _id 为 node// 前缀全形，客户端
  // （windows/devices.js bareNodeId）与绑定台账只认裸 id；凡是拿调用方
  // 送来的 id 去比全形 _id／白名单／device_scope／台账键的地方，比对前
  // 必须统一去前缀，否则裸 id 永远匹配不上全形（r5 rebind 404 的潜伏
  // 问题；白名单是同款：白名单文件存全形，execute 调用方送裸 id，
  // 直接比对即报 NOT_WHITELISTED）。lea-channel.js 有同款
  // bareNodeId／nodeMatchesId，两处逻辑须保持一致。
  function bareNodeId(id) {
    const s = String(id || '');
    return s.startsWith('node//') ? s.slice(6) : s;
  }

  // ---------- 设备白名单（DESIGN §6.2 第 ② 项，H04） ----------
  // 来源（按优先）：opts.whitelist（数组，单测／调用方注入）→
  // whitelist.json（数据目录，{"devices": ["node//..."]}，每次 admit 重读，
  // 改文件即生效，无须重启）。两者都未配置时 fail-closed：无设备在白名单，
  // 全部准入拒绝。发版口径（DESIGN §14 #2 选 A）：白名单只开站长设备；
  // 其他用户装接入口开放时把设备 id 追加进本文件。
  const WHITELIST_FILE = path.join(dir, 'whitelist.json');
  function loadWhitelist() {
    if (Array.isArray(opts.whitelist)) return opts.whitelist.map(String);
    try {
      const v = JSON.parse(fs.readFileSync(WHITELIST_FILE, 'utf8'));
      if (v && Array.isArray(v.devices)) return v.devices.map(String);
    } catch (e) {}
    return null; // 未配置
  }
  function isWhitelisted(deviceId) {
    const wl = loadWhitelist();
    if (!wl) return false;
    const want = bareNodeId(deviceId);
    if (!want) return false; // 空／退化 id（''／'node//'）永不命中，防空白名单条目误放行
    return wl.some((w) => bareNodeId(w) === want);
  }

  // ---------- API Key（DESIGN §7） ----------
  function hashKey(plain, saltHex) {
    return sha256Hex(saltHex + ':' + plain);
  }
  function findKeyByPlain(plain) {
    // 候选 Key 逐条用 salt 重算哈希 + timingSafeEqual（参照助手令牌校验）。
    const st = loadKeys();
    for (const k of st.keys) {
      if (!k || !k.hash || !k.salt) continue;
      if (safeEqualHex(hashKey(plain, k.salt), k.hash)) return k;
    }
    return null;
  }
  function findKeyById(keyId) {
    return loadKeys().keys.find((k) => k && k.key_id === keyId) || null;
  }
  function keyPublicView(k) {
    // 列表只显 key_id / 前缀、创建时间、最后使用、状态，不显明文（§7.2）。
    // C1：补设备名／平台／自助标记／最后在线（供三端 Key 行展示）。
    let lastSeenAt = null;
    try {
      const b = k && k.device_scope ? getBinding(k.device_scope) : null;
      if (b && Number.isSafeInteger(b.last_seen_at)) lastSeenAt = b.last_seen_at;
    } catch (e) { /* ignore：列表不因 last_seen 读失败而整体失败 */ }
    return {
      key_id: k.key_id, prefix: maskKey(k.prefix),
      account_id: k.account_id, device_scope: k.device_scope,
      scopes: k.scopes, status: keyStatus(k),
      created_at: k.created_at, last_used_at: k.last_used_at || null,
      expires_at: k.expires_at || null, binding_epoch: k.binding_epoch,
      grant_epoch: (k.grant_epoch || 0),
      device_name: k.device_name || null, platform: k.platform || null,
      self_bind: !!k.self_bind, last_seen_at: lastSeenAt,
    };
  }
  function keyStatus(k) {
    if (k.revoked_at) return k.revoked_by_rebind ? 'revoked_by_rebind' : 'revoked';
    if (k.expires_at && now() > k.expires_at) return 'expired';
    return 'active';
  }
  function generateKey(accountId, optsGen) {
    optsGen = optsGen || {};
    // H06：生成 Key 须已有 muse.execute 授权；dangerous scope 须站长另授
    // dangerous 授权，不许自助选。抛带 code 的错，路由层转 403（core 层
    // 也拦，防路由层漏检）。无授权账号生成 Key 一律拒绝，不留“先建 Key
    // 后授权”的窗口。
    if (!hasGrant(accountId)) {
      const e = new Error('LEA key generation requires muse.execute grant');
      e.code = 'QFR_MUSE_NOT_AUTHORIZED'; throw e;
    }
    const wantScopes = Array.isArray(optsGen.scopes) && optsGen.scopes.length ? optsGen.scopes : ['muse.execute'];
    if (wantScopes.includes(DANGEROUS_SCOPE) && !hasDangerousGrant(accountId)) {
      const e = new Error('LEA dangerous scope requires station-admin approval');
      e.code = 'QFR_SCOPE_DENIED'; throw e;
    }
    // DC-A-1：device_scope 为空时不得再发 binding_epoch 0 的死钥——
    // 控制台 UI 生成 Key 从不传 device_id，此前发出的 Key 表面 active、
    // 准入恒 409（H22 要求 epoch 与绑定一致，0 永不对上）。无 device_scope
    // 时：该账号恰绑 1 台即自动取该台（epoch 与 scope 一并落定）；0 台
    // 即尚未绑定、须先登录绑定；多台须调用方明示 device_id。
    let deviceScope = optsGen.device_scope || null;
    if (!deviceScope) {
      const bound = devicesForAccount(String(accountId));
      if (bound.length === 1) deviceScope = bound[0];
      else {
        const e = new Error(bound.length === 0
          ? 'LEA key generation requires a bound device: account has no bound device yet'
          : 'LEA key generation requires device_id: account has ' + bound.length + ' bound devices');
        e.code = 'QFR_DEVICE_SCOPE_REQUIRED';
        e.reason = bound.length === 0 ? 'no-device' : 'multi-device';
        throw e;
      }
    }
    const plain = KEY_PREFIX + crypto.randomBytes(32).toString('base64url');
    const salt = crypto.randomBytes(16).toString('hex');
    const st = loadKeys();
    // T10：key_id 碰撞时重新生成再入库（randId(10) 约 51.7 bit 熵，碰撞
    // 几乎不可能，但无检查时一旦碰撞，查找/吊销会命中首条记录）。
    let keyId = 'k_' + randId(10);
    while (st.keys.some((k) => k && k.key_id === keyId)) keyId = 'k_' + randId(10);
    const rec = {
      key_id: keyId,
      // T04：prefix 不再存 12 位明文前缀，只存其 SHA-256 指纹前 16 位 hex
      // （识别／脱敏显示用，见 maskKey；明文只在生成时返回一次，不落盘）。
      prefix: sha256Hex(plain.slice(0, 12)).slice(0, 16),
      salt, hash: hashKey(plain, salt),
      account_id: String(accountId),
      device_scope: deviceScope, // DC-A-1：恒有值（显式传参或恰绑 1 台自动取），不再发 device_scope=null 的死钥
      scopes: wantScopes,
      binding_epoch: currentBindingEpoch(deviceScope, String(accountId)),
      // T07/D1：Key 盖上生成时账号授权的 grant_epoch；admit 比对，授权撤销
      // 后重授予 epoch 已变，旧 Key 永不复活（须发新 Key）。H06 已保证生成
      // 时必有在效授权，故此处 grant_epoch 恒 ≥1。
      grant_epoch: currentGrantEpoch(String(accountId)),
      key_epoch: 1,
      created_at: now(), last_used_at: null, expires_at: null,
      revoked_at: null, revoked_by: null, revoked_by_rebind: false, revoke_reason: null,
      // C1：自助绑定带设备名／平台／自助标记（供三端 Key 行展示；控制台
      // 生成的 Key 这三项为空，不影响既有记录）。
      device_name: (optsGen.device_name && String(optsGen.device_name)) || null,
      platform: (optsGen.platform && String(optsGen.platform)) || null,
      self_bind: !!optsGen.self_bind,
    };
    if (optsGen.expires_in_days) rec.expires_at = now() + Math.floor(optsGen.expires_in_days) * 24 * 3600 * 1000;
    st.keys.push(rec);
    saveKeys(st);
    audit('lea-key-generated', {
      account_id: rec.account_id, device_id: rec.device_scope || null,
      api_key_id: rec.key_id, key_prefix: maskKey(rec.prefix),
      ip: optsGen.ip || null, user_agent: optsGen.userAgent || null,
      confirm_method: optsGen.confirmMethod || 'password',
    });
    // 仅生成时返回明文一次（§7.3）；调用方有责任只展示一次、不落日志。
    return { key: plain, record: keyPublicView(rec) };
  }
  function revokeKey(keyId, by, reason) {
    const st = loadKeys();
    const k = st.keys.find((x) => x && x.key_id === keyId);
    if (!k) return { ok: false, code: 'NOT_FOUND' };
    if (k.revoked_at) return { ok: true, already: true, record: keyPublicView(k) };
    k.revoked_at = now(); k.revoked_by = by || null; k.revoke_reason = reason || null;
    k.key_epoch = (k.key_epoch || 1) + 1; // 吊销后递增 key_epoch，缓存立即失效
    saveKeys(st);
    audit('lea-key-revoked', { account_id: k.account_id, device_id: k.device_scope || null, api_key_id: k.key_id, key_prefix: maskKey(k.prefix), by: by || null, reason: reason || null });
    // RC-02：吊销即踢——在途下发作废＋服务端 job 取消（设备端踢出由路由层
    // 经 kickRevokedSessions 做，见 lea-routes.js）。
    markInflightRevoked([k.key_id]);
    cancelJobsForKeys([k.key_id], reason || 'key-revoked');
    // RC-04 §4：吊销即作废该 Key 名下未消费的重连票据（核验第 6 步实时
    // 状态失败优先报 QFR_API_KEY_REVOKED；实时状态万一全通过，voided_at
    // 仍兜底拒绝）。
    try { voidReconnectTickets({ keyIds: [k.key_id] }, 'key-revoked'); } catch (e) {}
    // H21：记入本机吊销推送台账（有设备域只推该设备，无设备域推该账号全部已绑设备）。
    try {
      const devs = k.device_scope ? [k.device_scope] : devicesForAccount(k.account_id);
      recordRevocations(devs, [k.key_id], 'key-revoked');
    } catch (e) {}
    return { ok: true, record: keyPublicView(k), revoked_key_ids: [k.key_id] };
  }
  function revokeAllKeys(accountId, by, reason) {
    const st = loadKeys();
    let count = 0;
    const revokedIds = [];
    for (const k of st.keys) {
      if (k.account_id === String(accountId) && !k.revoked_at) {
        k.revoked_at = now(); k.revoked_by = by || null; k.revoke_reason = reason || 'revoke-all';
        k.key_epoch = (k.key_epoch || 1) + 1; count++; revokedIds.push(k.key_id);
      }
    }
    if (count) saveKeys(st);
    audit('lea-keys-revoke-all', { account_id: String(accountId), revoked_count: count, by: by || null, reason: reason || null });
    // RC-02：吊销即踢（在途作废＋job 取消；设备端踢出由路由层 kick）。
    markInflightRevoked(revokedIds);
    cancelJobsForKeys(revokedIds, reason || 'revoke-all');
    // RC-04 §4：吊销即作废这些 Key 名下未消费的重连票据。
    try { if (revokedIds.length) voidReconnectTickets({ keyIds: revokedIds }, 'revoke-all'); } catch (e) {}
    // H21：记入本机吊销推送台账（该账号全部已绑设备）。
    try { recordRevocations(devicesForAccount(accountId), revokedIds, 'revoke-all'); } catch (e) {}
    return { ok: true, revoked_count: count, revoked_key_ids: revokedIds };
  }
  function listKeys(accountId) {
    return loadKeys().keys
      .filter((k) => k.account_id === String(accountId))
      .map(keyPublicView)
      .sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
  }
  function touchKeyLastUsed(k) {
    try {
      const st = loadKeys();
      const rec = st.keys.find((x) => x && x.key_id === k.key_id);
      if (rec) { rec.last_used_at = now(); saveKeys(st); }
    } catch (e) {}
  }

  // ---------- C1：自助绑定（PLAN.md §2 C1；桌面一键链接本机助手） ----------
  // 流程：SPA（已登录会话）调 issue 拿一次性票据 → 主进程经本地 IPC 交
  // USH → USH 用设备 P-256 密钥签名调 complete 换 Key，明文只进 USH。
  // 票据台账只存 SHA-256＋元数据；complete 验票据（一次性／未过期／
  // device＋account＋nonce 一致）＋验设备签名（TOFU，见 D3）；通过即
  // 生成 90 天 Key（self_bind 标记）＋自助建 grant（D4），明文仅本次
  // 响应返回一次（调用方＝USH，有责任只存 DPAPI、不落日志）。
  function pruneSelfBindTickets(st) {
    // 清已消费／已过期票据（调用方写盘前先清，台账不无限膨胀）。
    let dirty = false;
    for (const [h, tk] of Object.entries(st.tickets || {})) {
      if (!tk || tk.consumed_at || (tk.expires_at && nowSec() > tk.expires_at)) {
        delete st.tickets[h]; dirty = true;
      }
    }
    return dirty;
  }
  function issueSelfBindTicket(accountId, deviceId, optsIssue) {
    optsIssue = optsIssue || {};
    accountId = String(accountId || '');
    deviceId = bareNodeId(String(deviceId || ''));
    const deviceName = String(optsIssue.device_name || '').slice(0, 64);
    const platform = String(optsIssue.platform || '').slice(0, 32);
    const nonce = String(optsIssue.nonce || '');
    if (!accountId) { const e = new Error('account_id required'); e.code = 'QFR_VALIDATION'; throw e; }
    if (!deviceId) { const e = new Error('device_id required'); e.code = 'QFR_VALIDATION'; throw e; }
    if (!nonce || nonce.length < 8 || nonce.length > 128 || /[^A-Za-z0-9_-]/.test(nonce)) {
      const e = new Error('nonce must be 8..128 chars [A-Za-z0-9_-]'); e.code = 'QFR_VALIDATION'; throw e;
    }
    if (platform && !/^[A-Za-z0-9_-]{1,32}$/.test(platform)) {
      const e = new Error('platform invalid'); e.code = 'QFR_VALIDATION'; throw e;
    }
    // 设备须已绑定到该账号且 ACTIVE（登录时 rebind 已建立；未绑定／绑他人
    // 即拒绝，不在此处新建绑定——绑定归属是安全边界，不由 issue 越权）。
    const binding = getBinding(deviceId);
    if (!binding || binding.state !== 'ACTIVE' || binding.account_id !== accountId) {
      const e = new Error('device is not bound to this account');
      e.code = 'QFR_LEA_NOT_BOUND'; throw e;
    }
    const st = loadSelfBindTickets();
    pruneSelfBindTickets(st);
    // 速率限制：同设备 5 秒内不重复签发；每（账号，设备）未消费票据 ≤5，
    // 超了删最旧的（用户连点只留最新几张，旧票据自然过期作废）。
    const mine = Object.entries(st.tickets || {})
      .filter(([, tk]) => tk && tk.account_id === accountId && tk.device_id === deviceId)
      .sort((a, b) => (a[1].created_at || 0) - (b[1].created_at || 0));
    if (mine.length && now() - (mine[mine.length - 1][1].created_at || 0) < SELFBIND_ISSUE_MIN_INTERVAL_MS) {
      const e = new Error('issue too frequent, retry in a few seconds');
      e.code = 'QFR_RATE_LIMITED'; throw e;
    }
    while (mine.length >= SELFBIND_MAX_TICKETS) {
      const oldest = mine.shift();
      delete st.tickets[oldest[0]];
    }
    const ticket = SELFBIND_TICKET_PREFIX + crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.randomBytes(16).toString('base64url');
    const expiresAt = nowSec() + SELFBIND_TICKET_TTL_S;
    st.tickets[sha256Hex(ticket)] = {
      account_id: accountId, device_id: deviceId,
      device_name: deviceName || null, platform: platform || null,
      nonce, challenge, expires_at: expiresAt,
      created_at: now(), consumed_at: null,
    };
    saveSelfBindTickets(st);
    audit('lea-selfbind-issued', {
      account_id: accountId, device_id: deviceId,
      device_name: deviceName || null, platform: platform || null,
      ticket_hash: sha256Hex(ticket).slice(0, 16), expires_at: expiresAt,
    });
    return { ticket, challenge, expires_at: expiresAt, ttl_s: SELFBIND_TICKET_TTL_S };
  }
  // 自助完成规范串 v1（与信封 v1 隔离，独立版本）：
  //   qfr-lea-selfbind-v1\n<account_id>\n<device_id>\n<ticket>\n<challenge>
  //   \n<nonce>\n<device_pubkey_b64>\n<expires_at>
  // device_id 一律用裸形（去 node// 前缀），与绑定台账键一致——
  // 服务端在 complete/renew 里先 bareNodeId 归一化再验签，客户端
  // （USH／SPA 桥）签名时也必须先归一化为裸形，否则验签必失败。
  // device_pubkey_b64：65 字节未压缩 P-256 点（0x04||X||Y）的 base64。
  // 签名：设备私钥对规范串 UTF-8 的 SHA-256 做 ECDSA P-256 签名，
  // 以 IEEE P1363 格式（r||s，64 字节）base64 传回。
  function selfBindCompleteSigningBytes(o) {
    return [
      SELFBIND_CANONICAL_V1,
      String(o.account_id), String(o.device_id), String(o.ticket),
      String(o.challenge), String(o.nonce), String(o.device_pubkey),
      String(o.expires_at),
    ].join('\n');
  }
  // ECDSA P-256 签名格式转换：USH（NCryptSignHash）与规范串用 IEEE
  // P1363 原始格式（r||s，64 字节）；Node 的 crypto.sign/verify 在
  // 本机 Node 24.22.1 上不接受 options 对象（第 4 个参数会被当成回
  // 调，dsaEncoding 无法用），故手动在 DER 与 P1363 之间转换。
  function ecdsaP1363ToDer(raw) {
    if (!Buffer.isBuffer(raw) || raw.length !== 64) return null;
    const intPart = (b) => {
      let i = 0; while (i < b.length - 1 && b[i] === 0) i++;
      let v = b.subarray(i);
      if (v[0] & 0x80) v = Buffer.concat([Buffer.from([0]), v]);
      return v;
    };
    const r = intPart(raw.subarray(0, 32));
    const s = intPart(raw.subarray(32, 64));
    const body = Buffer.concat([Buffer.from([0x02, r.length]), r, Buffer.from([0x02, s.length]), s]);
    return Buffer.concat([Buffer.from([0x30, body.length]), body]);
  }
  function ecdsaDerToP1363(der) {
    try {
      if (!Buffer.isBuffer(der) || der.length < 8 || der[0] !== 0x30) return null;
      let off = 2;
      if (der[1] & 0x80) { const n = der[1] & 0x7f; if (n > 2) return null; off = 2 + n; }
      if (der[off] !== 0x02) return null;
      const rLen = der[off + 1]; const r = der.subarray(off + 2, off + 2 + rLen);
      off = off + 2 + rLen;
      if (der[off] !== 0x02) return null;
      const sLen = der[off + 1]; const s = der.subarray(off + 2, off + 2 + sLen);
      const pad32 = (b) => {
        let v = b; while (v.length > 1 && v[0] === 0) v = v.subarray(1);
        if (v.length > 32) return null;
        const out = Buffer.alloc(32); v.copy(out, 32 - v.length); return out;
      };
      const rp = pad32(r); const sp = pad32(s);
      if (!rp || !sp) return null;
      return Buffer.concat([rp, sp]);
    } catch (e) { return null; }
  }
  function selfBindParseDevicePubkey(b64) {
    // 只认 65 字节未压缩点（首字节 0x04）；返回 {x, y}（base64url），
    // 格式不对即 null。公钥本身公开，不涉密。
    try {
      const raw = Buffer.from(String(b64 || ''), 'base64');
      if (raw.length !== 65 || raw[0] !== 0x04) return null;
      return {
        x: raw.subarray(1, 33).toString('base64url'),
        y: raw.subarray(33, 65).toString('base64url'),
      };
    } catch (e) { return null; }
  }
  function selfBindVerifySignature(o) {
    // o: {account_id, device_id, ticket, challenge, nonce, device_pubkey,
    //     expires_at, signature}。验签失败返回 false，不抛错。
    try {
      const pt = selfBindParseDevicePubkey(o.device_pubkey);
      if (!pt) return false;
      const pub = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: pt.x, y: pt.y }, format: 'jwk' });
      const sig = Buffer.from(String(o.signature || ''), 'base64');
      if (sig.length !== 64) return false;
      const der = ecdsaP1363ToDer(sig);
      if (!der) return false;
      return crypto.verify('sha256', Buffer.from(selfBindCompleteSigningBytes(o), 'utf8'), pub, der);
    } catch (e) { return false; }
  }
  function completeSelfBind(input) {
    const ticket = String(input.ticket || '');
    const accountId = String(input.account_id || '');
    const deviceId = bareNodeId(String(input.device_id || ''));
    const nonce = String(input.nonce || '');
    const devicePubkey = String(input.device_pubkey || '');
    const signature = String(input.signature || '');
    if (!ticket.startsWith(SELFBIND_TICKET_PREFIX)) {
      const e = new Error('ticket format invalid'); e.code = 'QFR_VALIDATION'; throw e;
    }
    const st = loadSelfBindTickets();
    const tk = st.tickets[sha256Hex(ticket)];
    if (!tk) { const e = new Error('ticket not found or expired'); e.code = 'QFR_TICKET_INVALID'; throw e; }
    if (tk.consumed_at) { const e = new Error('ticket already used'); e.code = 'QFR_TICKET_REUSED'; throw e; }
    if (now() > tk.expires_at * 1000) { const e = new Error('ticket expired'); e.code = 'QFR_TICKET_EXPIRED'; throw e; }
    if (tk.account_id !== accountId || tk.device_id !== deviceId || tk.nonce !== nonce) {
      const e = new Error('ticket does not match account/device/nonce'); e.code = 'QFR_TICKET_MISMATCH'; throw e;
    }
    // 验设备签名（规范串用服务端存量 challenge／expires_at，不用客户端
    // 传来的值——客户端传来的 challenge 若被改，签名即对不上存量串）。
    const okSig = selfBindVerifySignature({
      account_id: accountId, device_id: deviceId, ticket, challenge: tk.challenge,
      nonce, device_pubkey: devicePubkey, expires_at: tk.expires_at, signature,
    });
    if (!okSig) { const e = new Error('device signature invalid'); e.code = 'QFR_DEVICE_SIGNATURE_INVALID'; throw e; }
    // 一次性消费：先标记再生成 Key（生成抛错也不回滚消费——票据已用过，
    // 调用方须重新 issue；防票据重放窗口）。
    tk.consumed_at = now();
    saveSelfBindTickets(st);
    // TOFU：设备公钥存到绑定记录（续期按此验签；换设备密钥须重新链接）。
    try {
      const bs = loadBindings();
      const b = bs.bindings[deviceId];
      if (b) { b.device_pubkey = devicePubkey; b.device_name = tk.device_name || b.device_name || null; b.platform = tk.platform || b.platform || null; saveBindings(bs); }
    } catch (e) {}
    // D4：自助建 grant（无授权时；不含 dangerous）。用户点「链接这台电脑」
    // 即明示同意助手控制本机，属该意图的授权动作；站长仍可经 /grants 撤销。
    if (!hasGrant(accountId)) {
      grantMuse(accountId, accountId, {});
      audit('lea-selfbind-grant', { account_id: accountId, device_id: deviceId, action: 'grant', by: 'self-bind' });
    }
    // 生成 90 天自助 Key（device_scope＝本设备；binding_epoch 取当前绑定）。
    const out = generateKey(accountId, {
      device_scope: deviceId, scopes: ['muse.execute'],
      expires_in_days: SELFBIND_KEY_DAYS,
      device_name: tk.device_name, platform: tk.platform, self_bind: true,
      confirmMethod: 'self-bind',
    });
    audit('lea-selfbind-completed', {
      account_id: accountId, device_id: deviceId,
      api_key_id: out.record.key_id, key_prefix: maskKey(out.record.prefix),
      binding_epoch: out.record.binding_epoch, expires_at: out.record.expires_at,
    });
    // 明文仅本次响应返回一次（调用方＝USH，有责任只存 DPAPI、不落日志）。
    return { key: out.key, record: out.record, binding_epoch: out.record.binding_epoch };
  }
  // 续期规范串 v1：
  //   qfr-lea-selfbind-renew-v1\n<account_id>\n<device_id>\n<key_id>\n<nonce>\n<timestamp>
  // 验签用绑定记录存量设备公钥（TOFU）；timestamp 须在 ±60 秒内；
  // nonce 按 key_id 去重（复用 nonceCheck，防重放）。
  function selfBindRenewSigningBytes(o) {
    return [
      SELFBIND_CANONICAL_V1 + '-renew',
      String(o.account_id), String(o.device_id), String(o.key_id),
      String(o.nonce), String(o.timestamp),
    ].join('\n');
  }
  function renewSelfBindKey(input) {
    const keyId = String(input.key_id || '');
    const deviceId = bareNodeId(String(input.device_id || ''));
    const nonce = String(input.nonce || '');
    const timestamp = Number(input.timestamp);
    const signature = String(input.signature || '');
    const rec = findKeyById(keyId);
    if (!rec) { const e = new Error('key not found'); e.code = 'QFR_VALIDATION'; throw e; }
    const accountId = rec.account_id;
    if (!rec.self_bind) { const e = new Error('only self-bind keys can renew here'); e.code = 'QFR_SCOPE_DENIED'; throw e; }
    if (keyStatus(rec) !== 'active') { const e = new Error('key is not active'); e.code = 'QFR_API_KEY_REVOKED'; throw e; }
    if (bareNodeId(rec.device_scope || '') !== deviceId) { const e = new Error('key/device mismatch'); e.code = 'QFR_SCOPE_DENIED'; throw e; }
    if (!Number.isSafeInteger(timestamp) || Math.abs(nowSec() - timestamp) > SELFBIND_RENEW_SKEW_S) {
      const e = new Error('timestamp out of window'); e.code = 'QFR_REPLAY_DETECTED'; throw e;
    }
    if (!nonce || nonce.length < 8 || nonce.length > 128 || /[^A-Za-z0-9_-]/.test(nonce)) {
      const e = new Error('nonce invalid'); e.code = 'QFR_VALIDATION'; throw e;
    }
    // 注意：续期 nonce 不在此处再做 nonceCheck——路由层 Bearer 鉴权
    // （authenticate）已对同一 header nonce 做过去重，重复调用会误判
    // 重放。重放防护由两层构成：① Bearer 层的 nonce 去重（同一 nonce
    // 的完整请求第二次必被 authenticate 拦）；② 设备签名把 nonce＋
    // timestamp 一并入串，换 nonce／换时间戳签名即失效。
    const binding = getBinding(deviceId);
    if (!binding || binding.state !== 'ACTIVE' || binding.account_id !== accountId || !binding.device_pubkey) {
      const e = new Error('device binding or device key missing'); e.code = 'QFR_LEA_NOT_BOUND'; throw e;
    }
    if (!hasGrant(accountId)) { const e = new Error('grant revoked'); e.code = 'QFR_GRANT_REVOKED'; throw e; }
    // 验设备签名（存量公钥）。
    let okSig = false;
    try {
      const pt = selfBindParseDevicePubkey(binding.device_pubkey);
      if (pt) {
        const pub = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: pt.x, y: pt.y }, format: 'jwk' });
        const sig = Buffer.from(signature, 'base64');
        if (sig.length === 64) {
          const der = ecdsaP1363ToDer(sig);
          if (der) {
            okSig = crypto.verify('sha256', Buffer.from(selfBindRenewSigningBytes({
              account_id: accountId, device_id: deviceId, key_id: keyId, nonce, timestamp,
            }), 'utf8'), pub, der);
          }
        }
      }
    } catch (e) { okSig = false; }
    if (!okSig) { const e = new Error('device signature invalid'); e.code = 'QFR_DEVICE_SIGNATURE_INVALID'; throw e; }
    // 仅到期前 7 天内可续期（过早续期即 409，带当前有效期；已过期须重新链接）。
    if (!rec.expires_at || now() > rec.expires_at) { const e = new Error('key expired, relink required'); e.code = 'QFR_API_KEY_REVOKED'; throw e; }
    if (rec.expires_at - now() > SELFBIND_RENEW_WINDOW_MS) {
      const e = new Error('not within renewal window');
      e.code = 'QFR_NOT_RENEWABLE'; e.renewable_at = rec.expires_at - SELFBIND_RENEW_WINDOW_MS; throw e;
    }
    const st = loadKeys();
    const target = st.keys.find((x) => x && x.key_id === keyId);
    if (!target) { const e = new Error('key not found'); e.code = 'QFR_VALIDATION'; throw e; }
    target.expires_at = now() + SELFBIND_RENEW_DAYS * 24 * 3600 * 1000;
    saveKeys(st);
    audit('lea-selfbind-renewed', {
      account_id: accountId, device_id: deviceId, api_key_id: keyId,
      key_prefix: maskKey(target.prefix), expires_at: target.expires_at,
    });
    return { ok: true, record: keyPublicView(target) };
  }
  // 自助绑定状态（SPA 轮询；不含任何凭据）。
  function selfBindStatus(accountId, deviceId) {
    accountId = String(accountId || '');
    deviceId = bareNodeId(String(deviceId || ''));
    const binding = getBinding(deviceId);
    if (!binding || binding.account_id !== accountId) {
      return { status: 'none', device_id: deviceId, account_id: accountId, binding_state: binding ? binding.state : 'UNBOUND' };
    }
    const all = loadKeys().keys
      .filter((k) => k && k.account_id === accountId && k.self_bind && bareNodeId(k.device_scope || '') === deviceId)
      .sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
    // 优先在效的；无在效时，已吊销的最新一张即报 revoked（SPA 据此
    // 清本机凭据）；既无在效又无吊销，取最新一张的状态（expired 等）。
    const k = all.find((x) => !x.revoked_at && keyStatus(x) === 'active')
      || all.find((x) => x.revoked_at)
      || all[0] || null;
    if (!k) {
      return { status: 'pending', device_id: deviceId, account_id: accountId, binding_state: binding.state,
        device_name: binding.device_name || null, platform: binding.platform || null,
        binding_epoch: binding.binding_epoch, last_seen_at: binding.last_seen_at || null };
    }
    return { status: keyStatus(k) === 'active' ? 'active' : keyStatus(k),
      device_id: deviceId, account_id: accountId, binding_state: binding.state,
      device_name: k.device_name || binding.device_name || null, platform: k.platform || binding.platform || null,
      key_id: k.key_id, key_prefix: maskKey(k.prefix), expires_at: k.expires_at || null,
      binding_epoch: binding.binding_epoch, last_seen_at: binding.last_seen_at || null };
  }
  // 自助 Key 吊销（无密码二次确认，只限 self_bind Key；控制台 Key 仍走
  // 原密码路径）。调用方须是控制台会话（路由层验），且 Key 归属该账号。
  function revokeSelfBindKey(accountId, keyId) {
    const rec = findKeyById(String(keyId || ''));
    if (!rec || rec.account_id !== String(accountId)) return { ok: false, code: 'NOT_FOUND' };
    if (!rec.self_bind) return { ok: false, code: 'QFR_SCOPE_DENIED', reason: 'not-self-bind-key' };
    return revokeKey(rec.key_id, accountId, 'self-bind-revoke');
  }
  function revokeAllSelfBindKeys(accountId) {
    const st = loadKeys();
    let count = 0;
    const revokedIds = [];
    for (const k of st.keys) {
      if (k.account_id === String(accountId) && k.self_bind && !k.revoked_at) {
        k.revoked_at = now(); k.revoked_by = accountId; k.revoke_reason = 'self-bind-revoke-all';
        k.key_epoch = (k.key_epoch || 1) + 1; count++; revokedIds.push(k.key_id);
      }
    }
    if (count) saveKeys(st);
    audit('lea-selfbind-keys-revoke-all', { account_id: String(accountId), revoked_count: count, by: accountId });
    // RC-02：吊销即踢（在途作废＋job 取消；设备端踢出由路由层 kick）。
    markInflightRevoked(revokedIds);
    cancelJobsForKeys(revokedIds, 'self-bind-revoke-all');
    // RC-04 §4：吊销即作废这些 Key 名下未消费的重连票据。
    try { if (revokedIds.length) voidReconnectTickets({ keyIds: revokedIds }, 'self-bind-revoke-all'); } catch (e) {}
    try { recordRevocations(devicesForAccount(accountId), revokedIds, 'self-bind-revoke-all'); } catch (e) {}
    return { ok: true, revoked_count: count, revoked_key_ids: revokedIds };
  }

  // ---------- RC-04：断线重连票据（规范 RC-04-RECONNECT-TICKET-SPEC.md） ----------
  // 票据 10 字段（规范 §1），规范串 qfr-lea-reconnect-v1（§1.2），TTL 写死
  // 300 秒（§2），单次消费（§3.2），吊销语义 7 码（§4）。
  // 规范含糊处（按字面做，见收尾报告）：
  //   (a) §5.1“只留最新”vs 旧 §3.1“同 session 最多 3 张、超了删最旧”——
  //       已按 RC-04 (b) 定夺 A 统一：签发时原子作废同 session 旧未消费
  //       票据（只留最新一张，见 issueReconnectTicket 前置 3）；3 张上
  //       限已废止（旧实现删最旧，现改为作废，见规范 §3.1 第 3 条）。
  //       成功消费后仍作废同 session 其余未消费票据（大肥鱼复核 R-2：
  //       关掉旧票 300 秒内仍可恢复同一会话的窗口）。
  //   (b) 旧 §1“同一 session_id 在票据过期／消费后不得凭另一张票据
  //       恢复”已按 RC-04 (b) 定夺 A 改写（2026-11-15）：单次性保护的
  //       是“一张票据只认一次”，同一 session 消费／过期后仍可凭仍在
  //       效的 Key 重新签发新票据恢复（L3 恢复成功后即为同 session 再
  //       领）；新票据须凭仍在效的 Key 重新签发（§3.1 前置 admit 全量
  //       准入），旧票据消费后即作废（consumed_at 非空）。
  //   (c) §5.2“5 秒固定间隔，不做指数退避”——服务端不管客户端重试
  //       间隔；L3 已落地的 5s→30s 退避最坏 95 秒仍在 300 秒窗口内，
  //       服务端不另作限制。
  //   (d) §3.3“resume 成功……由服务端当即完成握手重建”——服务端只做
  //       票据核验＋返回 epochs（resume 不下发 sys.handshake：设备
  //       可能离线，下发必失败；握手在下一次业务下发时由
  //       ensureHandshake 按核验返回的 epochs 重建）。画面恢复由各端
  //       渲染层处理（规范 §7）。
  //   (e) §4 作废方式“删条目或置 consumed_at＝吊销时刻”——实现取第三
  //       种：置 voided_at 保留条目，核验时实时状态失败优先报具体码，
  //       实时状态全通过但 voided_at 非空仍拒绝（QFR_TICKET_INVALID，
  //       大肥鱼复核 R-1：voided_at 须 fail-closed 兜底——未来新增只作废
  //       票据、不改 Key／绑定／授权的作废原因时，实时状态拦不住）。
  //       删条目会丢码（变 INVALID），置 consumed_at 会错报 REUSED。
  function reconnectTicketSigningBytes(t) {
    checkIdField(t.account_id, 'account_id');
    checkIdField(t.device_id, 'device_id');
    checkIdField(t.api_key_id, 'api_key_id');
    if (!/^k_[a-z0-9]{10}$/.test(t.api_key_id)) throw new Error('LEA reconnect ticket field invalid: api_key_id');
    if (!/^resume-[0-9a-f]{16}$/.test(t.resume_id)) throw new Error('LEA reconnect ticket field invalid: resume_id');
    if (!/^sess-[0-9a-f]{16}$/.test(t.session_id)) throw new Error('LEA reconnect ticket field invalid: session_id');
    for (const [name, v] of [['binding_epoch', t.binding_epoch], ['grant_epoch', t.grant_epoch], ['issued_at', t.issued_at], ['expires_at', t.expires_at]]) {
      if (!Number.isSafeInteger(v) || v < 0) throw new Error('LEA reconnect ticket field invalid: ' + name);
    }
    // 注意：ticket_signature 不进规范串、也不在此校验——签发时签名尚不
    // 存在（signReconnectTicket 先算串再签名）；核验侧由形状检查（§3.2
    // 第 1 步）与 verifyReconnectTicketSignature 把关。
    return [
      RECONNECT_CANONICAL_V1,
      String(t.account_id),
      String(t.device_id),
      String(t.api_key_id),
      String(t.binding_epoch),
      String(t.grant_epoch),
      String(t.resume_id),
      String(t.session_id),
      String(t.issued_at),
      String(t.expires_at),
    ].join('\n');
  }
  // 票据 JSON 的规范序列化（固定字段顺序）：台账键与验签输入均以此为准，
  // 客户端字段顺序不同也不影响查表（核验时先按字段重建，不按原文哈希）。
  function reconnectTicketCanonicalJson(t) {
    return JSON.stringify({
      account_id: t.account_id, device_id: t.device_id, api_key_id: t.api_key_id,
      binding_epoch: t.binding_epoch, grant_epoch: t.grant_epoch,
      resume_id: t.resume_id, session_id: t.session_id,
      issued_at: t.issued_at, expires_at: t.expires_at,
      ticket_signature: t.ticket_signature,
    });
  }
  function signReconnectTicket(ticket) {
    // F-04：签名能力须为 real（规范 §3.1 第 4 条）；disabled／
    // placeholder-ephemeral 一律拒绝签发，不得签不可验票据。
    if (signing.mode !== 'real' || !signing.privateKey) {
      const e = new Error('LEA reconnect ticket signing requires real signing key (signing_mode=' + signing.mode + ')');
      e.code = 'QFR_SIGNING_NOT_REAL'; throw e;
    }
    const sig = crypto.sign(null, Buffer.from(reconnectTicketSigningBytes(ticket), 'utf8'), signing.privateKey);
    return Object.assign({}, ticket, { ticket_signature: sig.toString('base64') });
  }
  function verifyReconnectTicketSignature(ticket) {
    try {
      if (!ticket || !ticket.ticket_signature) return false;
      if (!signing.publicKeyBase64) return false;
      const pubJwk = { kty: 'OKP', crv: 'Ed25519', x: signing.publicKeyBase64 };
      const pub = crypto.createPublicKey({ key: pubJwk, format: 'jwk' });
      return crypto.verify(null, Buffer.from(reconnectTicketSigningBytes(ticket), 'utf8'), pub,
        Buffer.from(String(ticket.ticket_signature), 'base64'));
    } catch (e) { return false; }
  }
  function pruneReconnectTickets(st) {
    // 清已过期票据（调用方写盘前先清，台账不无限膨胀；票据最长存活
    // 300 秒，过期即清即够）。
    // 注意：已消费／已作废条目在过期前必须保留——消费后 300 秒内重放
    // 核验须报 QFR_TICKET_REUSED（§3.2 第 4 步），作废后未过期核验须
    // 走到第 6 步报吊销码（见 (e)）；提前删会错报 QFR_TICKET_INVALID。
    let dirty = false;
    for (const [h, tk] of Object.entries(st.tickets || {})) {
      if (!tk) { delete st.tickets[h]; dirty = true; continue; }
      if (tk.expires_at && nowSec() > tk.expires_at) { delete st.tickets[h]; dirty = true; }
    }
    return dirty;
  }
  // 作废未消费票据（RC-04 §4）：按 Key 或按设备。只置 voided_at 保留条目
  // （见 (e)），核验时实时状态失败优先报具体码、实时状态全通过但
  // voided_at 非空仍拒绝（R-复核：voided_at fail-closed 兜底）；prune
  // 时随过期一并清理。返回作废张数。只记 key_id／device_id／张数，
  // 不记票据内容。
  function voidReconnectTickets(filter, reason) {
    const st = loadReconnectTickets();
    let count = 0;
    const keyIds = filter && Array.isArray(filter.keyIds) ? filter.keyIds : null;
    const deviceId = filter && filter.deviceId ? bareNodeId(String(filter.deviceId)) : null;
    const accountId = filter && filter.accountId ? String(filter.accountId) : null;
    for (const tk of Object.values(st.tickets || {})) {
      if (!tk || tk.consumed_at || tk.voided_at) continue;
      const byKey = keyIds && keyIds.indexOf(tk.api_key_id) >= 0;
      const byDevice = deviceId && bareNodeId(tk.device_id) === deviceId;
      const byAccount = accountId && tk.account_id === accountId;
      if (byKey || byDevice || byAccount) { tk.voided_at = now(); count++; }
    }
    if (count) {
      saveReconnectTickets(st);
      audit('lea-reconnect-voided', {
        reason: reason || null, voided_count: count,
        api_key_ids: keyIds || null, device_id: deviceId, account_id: accountId,
      });
    }
    return { ok: true, voided_count: count };
  }
  // 签发（规范 §3.1）。input: { accountId, deviceId, keyId, sessionId }，
  // 其中 keyId 须等于鉴权 Key 的 key_id（路由层传入 auth.key.key_id，
  // 不得代他人签发）。epochs 取 admit() 已验证的值，不取调用方传值。
  function issueReconnectTicket(input, optsIssue) {
    const accountId = String((input && input.accountId) || '');
    const deviceId = bareNodeId(String((input && input.deviceId) || ''));
    const keyId = String((input && input.keyId) || '');
    const sessionId = String((input && input.sessionId) || '');
    if (!accountId) { const e = new Error('account_id required'); e.code = 'QFR_VALIDATION'; throw e; }
    if (!deviceId) { const e = new Error('device_id required'); e.code = 'QFR_VALIDATION'; throw e; }
    if (!/^k_[a-z0-9]{10}$/.test(keyId)) { const e = new Error('key_id invalid'); e.code = 'QFR_VALIDATION'; throw e; }
    if (!/^sess-[0-9a-f]{16}$/.test(sessionId)) { const e = new Error('session_id must be sess- + 16 hex'); e.code = 'QFR_VALIDATION'; throw e; }
    try { checkIdField(accountId, 'account_id'); checkIdField(deviceId, 'device_id'); }
    catch (e) { const ve = new Error(e.message); ve.code = 'QFR_VALIDATION'; throw ve; }
    const key = findKeyById(keyId);
    if (!key || key.account_id !== accountId) {
      const e = new Error('key not found or not owned by account'); e.code = 'QFR_API_KEY_REVOKED'; throw e;
    }
    if (keyStatus(key) !== 'active') {
      const e = new Error('API Key revoked or expired'); e.code = 'QFR_API_KEY_REVOKED'; throw e;
    }
    // 前置 2：全量准入（sys.ping 准入：绑定 ACTIVE、epochs 一致、授权在效、
    // 白名单在内）。失败码／状态原样透传（admit 的 status＋code）。
    const adm = admit({ key, deviceId, command: 'sys.ping' });
    if (!adm.ok) {
      const e = new Error(adm.msg || 'admit failed'); e.code = adm.code; e.status = adm.status; throw e;
    }
    if (signing.mode !== 'real' || !signing.privateKey) {
      const e = new Error('LEA reconnect ticket signing requires real signing key (signing_mode=' + signing.mode + ')');
      e.code = 'QFR_SIGNING_NOT_REAL'; throw e;
    }
    const st = loadReconnectTickets();
    pruneReconnectTickets(st);
    // 前置 3：同设备 5 秒内不重复签发；签发新票时同 (account, device,
    // session) 的旧未消费票据即原子作废（规范 §5.1“只留最新”；RC-04
    // (b) 定夺 A 的前提）。作废用 voided_at 保留条目（与 voidReconnectTickets
    // ／消费时作废同款语义），核验遇 voided_at 即拒绝；过期后由 prune
    // 清理，不提前删条目（删条目会丢吊销码，见 pruneReconnectTickets
    // 注释）。堆积由 5 秒限流＋300 秒过期清理封顶，不再另设张数上限。
    const live = (tk) => tk && !tk.consumed_at && !tk.voided_at && !(tk.expires_at && nowSec() > tk.expires_at);
    const devMine = Object.entries(st.tickets || {})
      .filter(([, tk]) => live(tk) && tk.account_id === accountId && tk.device_id === deviceId)
      .sort((a, b) => (a[1].created_at || 0) - (b[1].created_at || 0));
    if (devMine.length && now() - (devMine[devMine.length - 1][1].created_at || 0) < RECONNECT_ISSUE_MIN_INTERVAL_MS) {
      const e = new Error('issue too frequent, retry in a few seconds');
      e.code = 'QFR_RATE_LIMITED'; throw e;
    }
    const mine = devMine.filter(([, tk]) => tk.session_id === sessionId);
    for (const [, tk] of mine) tk.voided_at = now();
    const resumeId = 'resume-' + crypto.randomBytes(8).toString('hex');
    const issuedAt = nowSec();
    const ticket = signReconnectTicket({
      account_id: accountId, device_id: deviceId, api_key_id: keyId,
      binding_epoch: adm.binding.binding_epoch, grant_epoch: adm.grant.grant_epoch,
      resume_id: resumeId, session_id: sessionId,
      issued_at: issuedAt, expires_at: issuedAt + RECONNECT_TICKET_TTL_S,
    });
    st.tickets[sha256Hex(reconnectTicketCanonicalJson(ticket))] = {
      account_id: accountId, device_id: deviceId, api_key_id: keyId,
      binding_epoch: ticket.binding_epoch, grant_epoch: ticket.grant_epoch,
      resume_id_hash: sha256Hex(resumeId), session_id: sessionId,
      issued_at: issuedAt, expires_at: ticket.expires_at,
      created_at: now(), consumed_at: null, voided_at: null,
    };
    saveReconnectTickets(st);
    audit('lea-reconnect-issued', {
      account_id: accountId, device_id: deviceId, api_key_id: keyId,
      // R-复核 (h)：记下 Key 是怎么选出来的（Bearer 直传／控制台自动取
      // 最新），多 Key 并存时审计可查，不静默。
      key_selection: (optsIssue && optsIssue.keySelection) || null,
      resume_prefix: resumeId.slice(7, 15), session_id: sessionId,
      binding_epoch: ticket.binding_epoch, grant_epoch: ticket.grant_epoch,
      expires_at: ticket.expires_at,
    });
    return ticket;
  }
  // 核验＋消费（规范 §3.2；原子：验过即消费）。顺序即规范顺序，任一步
  // 失败即拒绝且不消费（失败不消耗单次机会）；过期／已消费／epochs
  // 不等是终态失败，重试同样失败。返回 { ok, account_id, device_id,
  // api_key_id, session_id, binding_epoch, grant_epoch }。
  function verifyReconnectTicket(ticket) {
    const bad = (code, msg) => { const e = new Error(msg); e.code = code; throw e; };
    // 1. 形状：对象、10 字段齐全、类型正确、未知字段拒绝、签名存在。
    const FIELDS = ['account_id', 'device_id', 'api_key_id', 'binding_epoch', 'grant_epoch', 'resume_id', 'session_id', 'issued_at', 'expires_at', 'ticket_signature'];
    if (!ticket || typeof ticket !== 'object' || Array.isArray(ticket)) bad('QFR_TICKET_INVALID', 'ticket must be an object');
    for (const k of Object.keys(ticket)) {
      if (FIELDS.indexOf(k) < 0) bad('QFR_TICKET_INVALID', 'unknown ticket field: ' + k);
    }
    for (const f of FIELDS) {
      if (ticket[f] === undefined || ticket[f] === null) bad('QFR_TICKET_INVALID', 'missing ticket field: ' + f);
    }
    if (typeof ticket.account_id !== 'string' || typeof ticket.device_id !== 'string' ||
        typeof ticket.api_key_id !== 'string' || typeof ticket.resume_id !== 'string' ||
        typeof ticket.session_id !== 'string' || typeof ticket.ticket_signature !== 'string' ||
        !Number.isSafeInteger(ticket.binding_epoch) || !Number.isSafeInteger(ticket.grant_epoch) ||
        !Number.isSafeInteger(ticket.issued_at) || !Number.isSafeInteger(ticket.expires_at)) {
      bad('QFR_TICKET_INVALID', 'ticket field type invalid');
    }
    try {
      checkIdField(ticket.account_id, 'account_id'); checkIdField(ticket.device_id, 'device_id');
      checkIdField(ticket.api_key_id, 'api_key_id');
    } catch (e) { bad('QFR_TICKET_INVALID', 'ticket id field invalid'); }
    if (!/^k_[a-z0-9]{10}$/.test(ticket.api_key_id)) bad('QFR_TICKET_INVALID', 'api_key_id invalid');
    if (!/^resume-[0-9a-f]{16}$/.test(ticket.resume_id)) bad('QFR_TICKET_INVALID', 'resume_id invalid');
    if (!/^sess-[0-9a-f]{16}$/.test(ticket.session_id)) bad('QFR_TICKET_INVALID', 'session_id invalid');
    if (ticket.binding_epoch < 0 || ticket.grant_epoch < 0 || ticket.issued_at < 0 || ticket.expires_at < 0) {
      bad('QFR_TICKET_INVALID', 'ticket numeric field invalid');
    }
    if (ticket.expires_at - ticket.issued_at !== RECONNECT_TICKET_TTL_S) {
      bad('QFR_TICKET_INVALID', 'ticket TTL must be exactly 300');
    }
    // 2. 签名：按 §1.2 重建规范串，Ed25519 验签。
    if (!verifyReconnectTicketSignature(ticket)) bad('QFR_TICKET_INVALID', 'ticket signature invalid');
    // 3. 台账：按票据 SHA-256 查表；查无即不是本服务端签发的（或台账已清）。
    const st = loadReconnectTickets();
    const h = sha256Hex(reconnectTicketCanonicalJson(ticket));
    const tk = st.tickets[h];
    if (!tk) {
      // R-复核 (g)：台账已清（过期清理删条目）时，已过期票据仍报 EXPIRED
      // 而非 INVALID——过期与否只看票据自身时间（签名已验过，伪造票据
      // 到不了此步）；未过期仍报 INVALID。
      if (nowSec() > ticket.expires_at) bad('QFR_TICKET_EXPIRED', 'ticket expired');
      bad('QFR_TICKET_INVALID', 'ticket not issued by this server');
    }
    // 台账条目须与票据逐项一致（防哈希碰撞／条目被改后仍放行）。
    if (tk.account_id !== ticket.account_id || tk.device_id !== bareNodeId(ticket.device_id) ||
        tk.api_key_id !== ticket.api_key_id || tk.session_id !== ticket.session_id ||
        tk.binding_epoch !== ticket.binding_epoch || tk.grant_epoch !== ticket.grant_epoch ||
        tk.resume_id_hash !== sha256Hex(ticket.resume_id) ||
        tk.issued_at !== ticket.issued_at || tk.expires_at !== ticket.expires_at) {
      bad('QFR_TICKET_INVALID', 'ticket does not match ledger entry');
    }
    // 4. 单次性：已消费 → 重放拒绝（QFR_TICKET_REUSED）。
    if (tk.consumed_at) bad('QFR_TICKET_REUSED', 'ticket already used');
    // 5. 有效期：过期 → QFR_TICKET_EXPIRED；时钟偏差超 60 秒 → INVALID。
    if (nowSec() > tk.expires_at) bad('QFR_TICKET_EXPIRED', 'ticket expired');
    if (nowSec() < ticket.issued_at - 60) bad('QFR_TICKET_INVALID', 'ticket issued_at too far in future');
    // 6. 吊销语义（§4）：Key 须 active；绑定须 ACTIVE 且账号／epoch 一致；
    // 授权须在效且 grant_epoch 一致。实时状态失败优先报具体码；实时状态
    // 全通过但 voided_at 非空仍拒绝（R-复核 (e)：voided_at fail-closed
    // 兜底，防未来只作废票据、不改 Key／绑定／授权的作废原因被放行）。
    const key = findKeyById(ticket.api_key_id);
    if (!key || keyStatus(key) !== 'active') bad('QFR_API_KEY_REVOKED', 'API Key revoked or expired');
    const binding = getBinding(ticket.device_id);
    if (!binding || binding.state !== 'ACTIVE' || binding.account_id !== ticket.account_id ||
        binding.binding_epoch !== ticket.binding_epoch) {
      bad('QFR_BINDING_CHANGED', 'binding changed');
    }
    const grant = getGrant(ticket.account_id);
    if (!grant || grant.revoked_at || grant.scope !== 'muse.execute' || grant.grant_epoch !== ticket.grant_epoch) {
      bad('QFR_GRANT_REVOKED', 'grant revoked');
    }
    if (tk.voided_at) bad('QFR_TICKET_INVALID', 'ticket voided');
    // 7. 消费：先写 consumed_at 落盘，再返回（生成／落盘抛错也不回滚消费，
    // 与 completeSelfBind 同款口径——票据已用过，调用方须重新签发）。
    // 原子性（R-复核）：本函数全程同步、无 await——单 Node 进程事件循环
    // 内读-改-写不可能交错（与 nonce／idem／selfbind 台账同款 T13 口径；
    // 生产只起一个实例，无多进程共享同一目录）。并发 resume 只会有一
    // 个看到 consumed_at 为空。
    tk.consumed_at = now();
    // R-复核 (a)：成功消费后，作废同 (account, device, session) 其余未消
    // 费票据——旧票 300 秒内仍可恢复同一会话的窗口就此关闭。L3 内存只持
    // 最新一张，恢复成功后即重新签发新票，不受影响。
    for (const other of Object.values(st.tickets || {})) {
      if (other && other !== tk && !other.consumed_at && !other.voided_at &&
          other.account_id === ticket.account_id && bareNodeId(other.device_id) === bareNodeId(ticket.device_id) &&
          other.session_id === ticket.session_id) other.voided_at = now();
    }
    saveReconnectTickets(st);
    audit('lea-reconnect-consumed', {
      account_id: ticket.account_id, device_id: ticket.device_id, api_key_id: ticket.api_key_id,
      resume_prefix: String(ticket.resume_id).slice(7, 15), session_id: ticket.session_id,
      binding_epoch: ticket.binding_epoch, grant_epoch: ticket.grant_epoch,
    });
    return {
      ok: true, account_id: ticket.account_id, device_id: bareNodeId(ticket.device_id),
      api_key_id: ticket.api_key_id, session_id: ticket.session_id,
      binding_epoch: ticket.binding_epoch, grant_epoch: ticket.grant_epoch,
    };
  }

  // ---------- 卸载注销（固定契约；2026-11-14 站长亲定） ----------
  // 规范串 v1：
  //   qfr-lea-deregister-v1\n<account_id>\n<device_id>\n<nonce>\n<timestamp>
  // device_id 一律裸形；签名：设备 P-256 私钥对规范串 UTF-8 的 SHA-256
  // 做 ECDSA 签名，IEEE P1363 格式（r||s，64 字节）base64；验签复用
  // selfBindParseDevicePubkey／ecdsaP1363ToDer，不另写一套验签。
  function deregisterSigningBytes(o) {
    return [
      DEREGISTER_CANONICAL_V1,
      String(o.account_id), String(o.device_id),
      String(o.nonce), String(o.timestamp),
    ].join('\n');
  }
  function deregisterVerifySignature(o, devicePubkeyB64) {
    // o: {account_id, device_id, nonce, timestamp, signature}。验签失败
    // 返回 false，不抛错（与 selfBindVerifySignature 同款）。
    try {
      const pt = selfBindParseDevicePubkey(devicePubkeyB64);
      if (!pt) return false;
      const pub = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: pt.x, y: pt.y }, format: 'jwk' });
      const sig = Buffer.from(String(o.signature || ''), 'base64');
      if (sig.length !== 64) return false;
      const der = ecdsaP1363ToDer(sig);
      if (!der) return false;
      return crypto.verify('sha256', Buffer.from(deregisterSigningBytes(o), 'utf8'), pub, der);
    } catch (e) { return false; }
  }
  function deregisterDevice(input) {
    const accountId = String(input.account_id || '');
    const deviceId = bareNodeId(String(input.device_id || ''));
    const nonce = String(input.nonce || '');
    const timestamp = Number(input.timestamp);
    const signature = String(input.signature || '');
    if (!accountId || !deviceId) { const e = new Error('account_id/device_id required'); e.code = 'QFR_VALIDATION'; throw e; }
    if (!nonce || nonce.length < 16 || nonce.length > 128 || /[^A-Za-z0-9_-]/.test(nonce)) {
      const e = new Error('nonce must be 16..128 chars [A-Za-z0-9_-] (base64url of >=16 random bytes)'); e.code = 'QFR_VALIDATION'; throw e;
    }
    if (!Number.isSafeInteger(timestamp) || Math.abs(nowSec() - timestamp) > DEREGISTER_SKEW_S) {
      const e = new Error('timestamp out of window'); e.code = 'QFR_REPLAY_DETECTED'; throw e;
    }
    // 重放防护：nonce 按设备分桶去重（复用 nonceCheck，落盘 10 分钟）；
    // 先消费 nonce 再验签——验签失败的尝试也消耗该 nonce，防签名预言机
    // 拿同一 nonce 反复试签；客户端每次尝试须用新 nonce（固定契约）。
    if (!nonceCheck('deregister:' + deviceId, nonce)) {
      const e = new Error('nonce replay detected'); e.code = 'QFR_REPLAY_DETECTED'; throw e;
    }
    // 验签公钥来源：① 在效绑定（ACTIVE＋账号一致＋已存设备公钥）；
    // ② 注销墓碑（已注销过，凭同一把设备私钥验签后幂等成功）。
    // 两者皆无／账号不一致／无公钥时一律报签名无效，不区分“从未绑定”
    // 与“绑他人／已注销”，不留存在性预言口子。
    const binding = getBinding(deviceId);
    let pubkey = null;
    let already = false;
    let bindingEpoch = 0;
    if (binding && binding.state === 'ACTIVE' && binding.account_id === accountId && binding.device_pubkey) {
      pubkey = binding.device_pubkey; bindingEpoch = binding.binding_epoch || 0;
    } else {
      const tomb = (loadDeregistered().devices || {})[deviceId] || null;
      if (tomb && tomb.account_id === accountId && tomb.device_pubkey) {
        pubkey = tomb.device_pubkey; already = true; bindingEpoch = tomb.binding_epoch || 0;
      }
    }
    if (!pubkey) { const e = new Error('device signature invalid'); e.code = 'QFR_DEVICE_SIGNATURE_INVALID'; throw e; }
    const okSig = deregisterVerifySignature({ account_id: accountId, device_id: deviceId, nonce, timestamp, signature }, pubkey);
    if (!okSig) { const e = new Error('device signature invalid'); e.code = 'QFR_DEVICE_SIGNATURE_INVALID'; throw e; }
    if (!already) {
      // 删绑定条目＋该设备的自助绑定票据；Keys／grants／吊销表／jobs／
      // 幂等表一律不动（付费 LEA 密钥是账号级资产，绝不删）。
      const bs = loadBindings();
      delete bs.bindings[deviceId];
      saveBindings(bs);
      const tkSt = loadSelfBindTickets();
      let tkDirty = false;
      for (const [h, tk] of Object.entries(tkSt.tickets || {})) {
        if (tk && tk.device_id === deviceId) { delete tkSt.tickets[h]; tkDirty = true; }
      }
      if (tkDirty) saveSelfBindTickets(tkSt);
      // RC-04 §4：注销即作废该设备未消费的重连票据（绑定已删，核验第 6 步
      // 仍以实时绑定状态判定报 QFR_BINDING_CHANGED）。
      try { voidReconnectTickets({ deviceId }, 'deregister'); } catch (e) {}
      // 立墓碑：重复注销凭同一把设备私钥验签后幂等成功。
      const dg = loadDeregistered();
      dg.devices[deviceId] = { account_id: accountId, device_pubkey: pubkey, deregistered_at: now(), binding_epoch: bindingEpoch };
      saveDeregistered(dg);
    }
    audit('lea-deregistered', { account_id: accountId, device_id: deviceId, binding_epoch: bindingEpoch, already });
    return { ok: true, already, device_id: deviceId, account_id: accountId, binding_epoch: bindingEpoch };
  }
  // 设备最后在线（下发成功／在线查询时 touch；60 秒节流，不写放大）。
  function touchDeviceSeen(deviceId) {
    try {
      const id = bareNodeId(String(deviceId || ''));
      if (!id) return;
      const st = loadBindings();
      const b = st.bindings[id];
      if (!b) return;
      if (b.last_seen_at && now() - b.last_seen_at < 60 * 1000) return;
      b.last_seen_at = now();
      saveBindings(st);
    } catch (e) {}
  }

  // ---------- 授权（DESIGN §6.2：站长授予 muse.execute，存服务端授权表） ----------
  function getGrant(accountId) {
    const g = loadGrants().grants[String(accountId)];
    return g || null;
  }
  function grantMuse(accountId, by, optsGrant) {
    const st = loadGrants();
    const isFirst = !st.grants[String(accountId)];
    const cur = st.grants[String(accountId)] || { account_id: String(accountId), grant_epoch: 0 };
    const wasRevoked = !!cur.revoked_at;
    cur.scope = 'muse.execute'; cur.granted_at = now(); cur.granted_by = by || null;
    cur.revoked_at = null;
    // T07/D1：grant_epoch 只在“首次授予／撤销后重授予”这两个代次跃迁时递增；
    // 在效授权上重复 grant 不动 epoch（否则每次点“授予”都会废掉全部在用 Key）。
    // Key 生成时盖上当时 epoch（见 generateKey），admit 比对——撤销后重授予
    // epoch 已变，旧 Key 永不复活。
    if (isFirst || wasRevoked) cur.grant_epoch = (cur.grant_epoch || 0) + 1;
    // H06 dangerous 授权：仅站长经 /grants 显式授予（optsGrant.dangerous
    // === true）；重授未带该标志时保留既有值（不静默收回），显式 false
    // 则收回。撤销授权时一并失效（见 revokeGrant）。
    if (optsGrant && optsGrant.dangerous === true) cur.dangerous = true;
    else if (optsGrant && optsGrant.dangerous === false) cur.dangerous = false;
    st.grants[String(accountId)] = cur;
    saveGrants(st);
    audit('lea-grant-changed', { account_id: String(accountId), action: 'grant', grant_epoch: cur.grant_epoch, dangerous: !!cur.dangerous, by: by || null });
    return { ok: true, grant_epoch: cur.grant_epoch, dangerous: !!cur.dangerous };
  }
  function revokeGrant(accountId, by) {
    const st = loadGrants();
    const cur = st.grants[String(accountId)];
    if (!cur || cur.revoked_at) return { ok: false, code: 'NOT_FOUND' };
    cur.revoked_at = now(); cur.revoked_by = by || null;
    cur.dangerous = false; // H06：撤销授权时 dangerous 授权一并失效，重授须站长重新显式授予
    cur.grant_epoch = (cur.grant_epoch || 0) + 1;
    saveGrants(st);
    audit('lea-grant-changed', { account_id: String(accountId), action: 'revoke', grant_epoch: cur.grant_epoch, by: by || null });
    // T07/D1：授权撤销即连带吊销该账号在用 Key——admit 的 grant_epoch 比对
    // 是第一层（旧 Key 因 epoch 不符永不复活）；同时把这些 key_id 记入本机
    // 吊销推送台账（H21），让本机第二层也拒掉它们。keys.json 里的记录本身
    // 不改 revoked_at（admit 仍按授权撤销报 QFR_GRANT_REVOKED，保持既有
    // 错误码契约）；Key 的实际效力以 admit 为准。
    // RC-02：授权撤销同样踢会话（在途作废＋job 取消；设备端踢出由路由层 kick）。
    let revokedIds = [];
    try {
      const activeIds = loadKeys().keys
        .filter((k) => k && k.account_id === String(accountId) && !k.revoked_at)
        .map((k) => k.key_id);
      revokedIds = activeIds;
      if (activeIds.length) recordRevocations(devicesForAccount(accountId), activeIds, 'grant-revoked');
      markInflightRevoked(activeIds);
      cancelJobsForKeys(activeIds, 'grant-revoked');
      // RC-04 §4：授权撤销即作废该账号在用 Key 名下未消费的重连票据
      // （核验第 6 步仍以实时 grant_epoch 判定报 QFR_GRANT_REVOKED）。
      try { if (activeIds.length) voidReconnectTickets({ keyIds: activeIds }, 'grant-revoked'); } catch (e) {}
    } catch (e) {}
    return { ok: true, grant_epoch: cur.grant_epoch, revoked_key_ids: revokedIds };
  }
  function hasGrant(accountId) {
    const g = getGrant(accountId);
    return !!(g && g.scope === 'muse.execute' && !g.revoked_at);
  }
  // H06：dangerous 授权是否在效（站长显式授予且未撤销）。
  function hasDangerousGrant(accountId) {
    const g = getGrant(accountId);
    return !!(g && g.scope === 'muse.execute' && !g.revoked_at && g.dangerous === true);
  }

  // ---------- 绑定（DESIGN §6.1：跟随当前登录账号） ----------
  function getBinding(deviceId) {
    return loadBindings().bindings[bareNodeId(deviceId)] || null;
  }
  function currentBindingEpoch(deviceId, accountId) {
    const b = deviceId ? getBinding(deviceId) : null;
    if (b && b.account_id === String(accountId)) return b.binding_epoch;
    return 0;
  }
  // T07：生成 Key 时盖上的授权代次（无授权记录时为 0）。
  function currentGrantEpoch(accountId) {
    const g = getGrant(accountId);
    return g ? (g.grant_epoch || 0) : 0;
  }
  // 换绑：新账号绑定即递增 epoch；旧账号在该设备上的全部 Key 标记
  // revoked_by_rebind 立即失效（§7.4）。失败不回滚旧绑定（§6.1）。
  // optsBind.bindingEpoch（H07）：主程序 hook 在 login_changed 响应里拿到
  // LEA 的 PENDING epoch 后经 rebind 传回；LEA 侧登出会先升 epoch（旧
  // epoch 作废），服务端同账号换绑不升 epoch，两端会漂移。服务端只许
  // epoch 向前（取 max），永不倒退——向前只会使旧 Key 失效，不会复活
  // 旧绑定；调用方须先过路由层的归属／可见性校验（H05）才能传此值。
  function recordBinding(deviceId, accountId, trigger, optsBind) {
    // 归一：台账键一律存裸形，全形入账也不另起一条（否则同一设备在台账
    // 里出现两条目、旧绑定 Key 不被新一次换绑吊销）。
    deviceId = bareNodeId(String(deviceId)); accountId = String(accountId);
    const st = loadBindings();
    const old = st.bindings[deviceId] || null;
    const oldAccount = old ? old.account_id : null;
    const oldEpoch = old ? old.binding_epoch : 0;
    let newEpoch = (old && old.account_id === accountId) ? old.binding_epoch : oldEpoch + 1;
    const clientEpoch = optsBind && optsBind.bindingEpoch;
    if (Number.isSafeInteger(clientEpoch) && clientEpoch > newEpoch) newEpoch = clientEpoch;
    st.bindings[deviceId] = {
      device_id: deviceId, account_id: accountId, binding_epoch: newEpoch,
      state: 'ACTIVE', updated_at: now(), trigger: trigger || 'login',
    };
    saveBindings(st);
    // 重新绑定即复活：清掉该设备的注销墓碑（旧公钥不得再用于验签；
    // 在效绑定优先于墓碑，此处清掉只为不留过期墓碑）。
    try {
      const dg = loadDeregistered();
      if (dg.devices && dg.devices[deviceId]) { delete dg.devices[deviceId]; saveDeregistered(dg); }
    } catch (e) {}
    let revokedKeys = 0;
    const revokedKeyIds = [];
    if (oldAccount && oldAccount !== accountId) {
      const ks = loadKeys();
      for (const k of ks.keys) {
        if (k.account_id === oldAccount && (!k.device_scope || bareNodeId(k.device_scope) === deviceId) && !k.revoked_at) {
          k.revoked_at = now(); k.revoked_by_rebind = true; k.revoke_reason = 'rebind';
          k.key_epoch = (k.key_epoch || 1) + 1; revokedKeys++; revokedKeyIds.push(k.key_id);
        }
      }
      if (revokedKeys) saveKeys(ks);
      // RC-02：换绑吊销旧 Key 即踢其在途下发与服务端 job（设备端踢出由
      // 路由层对换绑响应调 kick；旧 Key 的本机吊销表由 H21 推送＋客户端
      // keys.sync-revoked 同步）。
      markInflightRevoked(revokedKeyIds);
      cancelJobsForKeys(revokedKeyIds, 'rebind');
      // H21：换绑吊销的 Key 同步记入本机吊销推送台账。
      try { recordRevocations([deviceId], revokedKeyIds, 'rebind'); } catch (e) {}
      // RC-04 §4：换绑即作废被吊销旧 Key 名下未消费的重连票据。
      try { if (revokedKeyIds.length) voidReconnectTickets({ keyIds: revokedKeyIds }, 'rebind'); } catch (e) {}
    }
    // RC-04 §4：绑定代次变了（换账号／同账号 epoch 前进），该设备未消费
    // 的重连票据一并作废——核验第 6 步仍以实时 binding_epoch 判定报
    // QFR_BINDING_CHANGED。代次未变（同账号重复绑定）不作废。
    if (newEpoch !== oldEpoch) {
      try { voidReconnectTickets({ deviceId }, 'binding-epoch-changed'); } catch (e) {}
    }
    audit('lea-rebind', {
      device_id: deviceId, old_account_id: oldAccount, new_account_id: accountId,
      old_binding_epoch: oldEpoch, new_binding_epoch: newEpoch,
      client_binding_epoch: Number.isSafeInteger(clientEpoch) ? clientEpoch : null,
      trigger_reason: trigger || 'login', revoked_keys: revokedKeys,
    });
    // 签发绑定票据（S2：服务端此前无签发票据的代码，C 端 binding.confirm
    // 永远收不到合法票据）。票据 scopes 为账号级授权 scope（v1 口径，
    // 见 CANONICAL-SIGNING-V1.md §7：危险 scope 为 Key 级，此处无 Key 上下文）。
    const grant = getGrant(accountId);
    const ticket = issueBindingTicket({
      accountId, deviceId,
      bindingEpoch: newEpoch,
      grantEpoch: grant ? grant.grant_epoch : 0,
      grantMuseExecute: hasGrant(accountId) ? 1 : 0,
      scopes: hasGrant(accountId) ? ['muse.execute'] : [],
      expiresAt: nowSec() + TICKET_TTL_S,
    });
    audit('lea-ticket-issued', {
      device_id: deviceId, account_id: accountId, binding_epoch: newEpoch,
      grant_epoch: ticket.grant_epoch, grant_muse_execute: ticket.grant_muse_execute,
      lease_id: ticket.lease_id,
    });
    return { ok: true, device_id: deviceId, account_id: accountId, binding_epoch: newEpoch, revoked_keys: revokedKeys, revoked_key_ids: revokedKeyIds, ticket };
  }

  // ---------- 本机吊销表推送（H21） ----------
  // 问题：吊销只改服务端 keys.json，没有任何向 LEA 本机写吊销的路径；
  // C 端 key_is_revoked 读本机 %ProgramData%\QFR\LEA\state\revoked_keys.txt
  // （每行一个 key_id），此前没有任何写入方，该文件永远为空，第二层准入
  // 名存实亡。正常路径下 admit 每次实时查吊销，是有效控制；这里补的是
  // 设计的第二层，不是替代 admit。
  // 机制：revocations.json 按设备记待推送的吊销 key_id 全集（只增不减）；
  // 每设备带单调 generation（每次台账变更 +1，见 recordRevocations），
  // H21 推送与 rebind 回包都携带它；C 侧持久化已接受的最大 generation，
  // 陈旧推送拒绝写盘（见 leaRevocationsWriteCmd 的世代门与 C 侧
  // lea_revoked_merge_with_generation），根治 merge 最终重读通过后陈旧
  // H21 落地的那一瞬窗口（#1 版本化）。
  // dispatchEnvelope 下发前先经 runcommands 把全集写到本机（写成功才记
  // pushed_epoch；写失败留待下次下发重试）。设备离线收不到推送时吊销照
  // 样在服务端被 admit 拦住，本机表 stale 的最坏情况有 admit 兜底。
  // 推送走 runcommands 通道（服务端→MeshCentral agent，SYSTEM 身份写文件，
  // 与下发信封同一信任通道）；文件内容只有 key_id（非秘密），无敏感信息。
  function devicesForAccount(accountId) {
    const out = [];
    try {
      const bs = loadBindings().bindings || {};
      for (const [deviceId, b] of Object.entries(bs)) {
        if (b && b.account_id === String(accountId)) out.push(deviceId);
      }
    } catch (e) {}
    return out.sort();
  }
  // #1 版本化：generation 是 revocations.json 里每设备单调递增的世代，
  // 每次吊销台账变更即 +1（与旧字段 revocation_epoch 同值，后者保留为
  // 别名供旧客户端／旧测试读取）。H21 推送与 rebind 回包都携带它；C 侧
  // 持久化已接受的最大 generation，陈旧推送（generation 更小）拒绝写盘。
  // 旧台账文件可能只有 revocation_epoch（无 generation），读时取两者
  // 最大值归一，不把缺失当 0 回退。锁死：revocation_epoch 是 generation
  // 的只读别名，禁止单独写——两处写点（recordRevocations、
  // markRevocationsPushed）必须同时写两字段且同值，否则别名即分叉。
  function revocGeneration(cur) {
    const g = cur && Number.isSafeInteger(cur.generation) ? cur.generation : 0;
    const e = cur && Number.isSafeInteger(cur.revocation_epoch) ? cur.revocation_epoch : 0;
    return Math.max(g, e, 0);
  }
  function revocPushed(cur) {
    const g = cur && Number.isSafeInteger(cur.pushed_generation) ? cur.pushed_generation : 0;
    const e = cur && Number.isSafeInteger(cur.pushed_epoch) ? cur.pushed_epoch : 0;
    return Math.max(g, e, 0);
  }
  // 不回退（进程内高水位）：一旦某个 generation 被发给过客户端，就不得
  // 再往下发——即使 revocations.json 被旧备份覆盖回滚，已发出的值也不
  // 回退（否则本机可能重新接受陈旧推送）。持久化台账本身只增不减，
  // 重启后以台账为准。
  const revocIssuedGen = {};
  function recordRevocations(deviceIds, keyIds, reason) {
    const ids = [...new Set((keyIds || []).filter((x) => typeof x === 'string' && x))].sort();
    // 归一：吊销表键一律存裸形，与绑定台账同口径。
    const devs = [...new Set((deviceIds || []).filter((x) => typeof x === 'string' && x).map(bareNodeId))].filter(Boolean).sort();
    if (!ids.length || !devs.length) return [];
    const st = loadRevocations();
    st.devices = st.devices || {};
    let changed = false;
    for (const d of devs) {
      const cur = st.devices[d] || { revoked_key_ids: [], revocation_epoch: 0, pushed_epoch: 0, updated_at: 0 };
      const merged = [...new Set([...(cur.revoked_key_ids || []), ...ids])].sort();
      if (merged.length !== (cur.revoked_key_ids || []).length) {
        const gen = revocGeneration(cur) + 1;
        st.devices[d] = { revoked_key_ids: merged, generation: gen, revocation_epoch: gen, pushed_generation: revocPushed(cur), pushed_epoch: revocPushed(cur), updated_at: now() };
        changed = true;
      }
    }
    if (changed) {
      saveRevocations(st);
      audit('lea-revocation-recorded', { device_ids: devs, key_ids: ids, reason: reason || null });
    }
    return devs;
  }
  function getRevocations(deviceId) {
    const id = bareNodeId(deviceId); // 归一：查表按裸形，返回的 device_id 仍回显调用方原样
    const cur = (loadRevocations().devices || {})[id];
    if (!cur) return { device_id: String(deviceId), revoked_key_ids: [], generation: 0, revocation_epoch: 0, pushed_generation: 0, pushed_epoch: 0, updated_at: 0 };
    const gen = Math.max(revocGeneration(cur), revocIssuedGen[id] || 0);
    revocIssuedGen[id] = gen;
    const pushed = revocPushed(cur);
    return { device_id: String(deviceId), revoked_key_ids: [...(cur.revoked_key_ids || [])], generation: gen, revocation_epoch: gen, pushed_generation: pushed, pushed_epoch: pushed, updated_at: cur.updated_at || 0 };
  }
  function markRevocationsPushed(deviceId, generation) {
    try {
      const st = loadRevocations();
      const cur = st.devices[bareNodeId(deviceId)];
      if (!cur) return;
      // 只在 generation 与当前台账一致时才追上：陈旧推送（其 generation
      // 已落后于当前台账）即使写盘命令返回成功，也不得误标已同步。
      if (revocGeneration(cur) === generation) { cur.pushed_generation = generation; cur.pushed_epoch = generation; saveRevocations(st); }
    } catch (e) {}
  }
  // 下发前把本机吊销表同步到最新全集（best-effort：写失败不拦本次命令，
  // admit 已放行且是第一层控制）。全量写：文件内容即全集——超长时宁可
  // 跳过也不发残集（残集会让本机误以为部分 Key 未吊销）。
  const LEA_REVOKED_PATH = 'C:\\ProgramData\\QFR\\LEA\\state\\revoked_keys.txt';
  const REVOCATION_SYNC_B64_LIMIT = 4000; // 约 230 个 key_id；超了等下次（admit 兜底）
  // H21 推送写命令（带 generation 门）：PowerShell 先读本机世代文件
  // revoked_keys.gen（已接受的最大 generation，不存在即 0）；incoming
  // generation 更小即陈旧推送，直接退出不写盘（返回成功——无事可做；
  // 服务端 pushed_epoch 只在 generation 与当前台账一致时才追上，见
  // markRevocationsPushed，故陈旧推送不会误标已同步）。世代文件损坏
  // （非纯数字）即抛错不写盘（fail-closed；下次下发重试，admit 仍是
  // 第一层控制）。X-01（大肥鱼复核后收紧）：.gen 缺失时分两种情形——
  //   ① 无历史（binding.dat 不存在且表缺失／空表，首次安装）：写表＋
  //      写 .gen，初始化；
  //   ② 有历史（binding.dat 存在或表非空，旧版快照／表被删）：只写表、
  //      跳过写 .gen——服务端恢复的是表内容（服务端全集权威、只增不减），
  //      世代仍须管理员在设备上跑 QFRLEA.exe --migrate-revoked 显式授
  //      予；设备在显式迁移前保持 DEGRADED（C 侧运行期检查：snap==-1
  //      即 ERROR，与启动口径一致）。旧口径“表非空即抛错不写盘”会把
  //      有历史＋表缺失的设备卡死（表回不来、工具又拒绝缺失文件），故
  //      改为写表跳 .gen。写顺序：先写世代文件、再写 revoked_keys.txt——
  //      中途失败时世代超前于表是安全方向（陈旧推送被拦，新表由下次
  //      重推补齐）；反过来（表超前于世代）会留一个陈旧推送可覆盖新表
  //      的窗口。世代文件用 tmp+rename 写（与 C 侧同范式），不断电写半
  //      截；tmp 名带 $PID，防两路并发推送撞同名。
  // generation 必传：缺失／非安全整数／负数即抛错，绝不发无版本直写。
  function leaRevocationsWriteCmd(b64, generation) {
    if (typeof b64 !== 'string' || !b64) throw new Error('leaRevocationsWriteCmd: b64 required');
    if (!Number.isSafeInteger(generation) || generation < 0) throw new Error('leaRevocationsWriteCmd: generation required');
    const genFile = LEA_REVOKED_PATH.replace(/\.txt$/i, '.gen');
    const bindFile = LEA_REVOKED_PATH.replace(/revoked_keys\.txt$/i, 'binding.dat');
    return 'powershell -NoProfile -NonInteractive -Command "$genFile=\'' + genFile + '\'; $txtFile=\'' + LEA_REVOKED_PATH + '\'; $bindFile=\'' + bindFile + '\'; $incoming=' + generation + '; $cur=0; if (Test-Path -LiteralPath $genFile) { $raw=[IO.File]::ReadAllText($genFile).Trim(); if ($raw -match \'^[0-9]+$\') { $cur=[int64]$raw } else { throw \'revoked generation file corrupt\' } }; $hasHistory=(Test-Path -LiteralPath $bindFile) -or ((Test-Path -LiteralPath $txtFile) -and (Get-Item -LiteralPath $txtFile).Length -gt 0); $skipGen=(-not (Test-Path -LiteralPath $genFile)) -and $hasHistory; if ($incoming -lt $cur) { exit 0 }; if (-not $skipGen) { $tmpGen=$genFile + \'.\' + $PID + \'.tmp\'; [IO.File]::WriteAllText($tmpGen, [string]$incoming); Remove-Item -LiteralPath $genFile -ErrorAction SilentlyContinue; [IO.File]::Move($tmpGen, $genFile) }; [IO.File]::WriteAllBytes($txtFile,[Convert]::FromBase64String(\'' + b64 + '\'))"';
  }
  async function syncRevocations(channel, deviceId) {
    if (!channel || typeof channel.runCommand !== 'function') return { synced: false, reason: 'no-channel' };
    let snap;
    try { snap = getRevocations(deviceId); } catch (e) { return { synced: false, reason: 'read-failed' }; }
    if (!snap.revoked_key_ids.length) return { synced: true, reason: 'empty' };
    if ((snap.pushed_generation || 0) >= (snap.generation || 0)) return { synced: true, reason: 'already-synced', generation: snap.generation };
    const text = snap.revoked_key_ids.join('\n') + '\n';
    const b64 = Buffer.from(text, 'utf8').toString('base64');
    if (b64.length > REVOCATION_SYNC_B64_LIMIT) {
      log({ ev: 'lea-revocation-sync-skipped', device_id: deviceId, reason: 'oversize', generation: snap.generation, revocation_epoch: snap.revocation_epoch });
      return { synced: false, reason: 'oversize', generation: snap.generation };
    }
    try {
      await channel.runCommand(deviceId, leaRevocationsWriteCmd(b64, snap.generation), 15000);
    } catch (e) {
      log({ ev: 'lea-revocation-sync-failed', device_id: deviceId, generation: snap.generation, revocation_epoch: snap.revocation_epoch, err: String(e && e.message) });
      return { synced: false, reason: 'write-failed', generation: snap.generation };
    }
    markRevocationsPushed(deviceId, snap.generation);
    return { synced: true, reason: 'pushed', generation: snap.generation };
  }

  // ---------- RC-02：吊销即踢在线会话 ----------
  // 吊销的即时效力分三层（admit 实时拦新命令是第零层，本节是其余三层）：
  //   ① 在途下发：dispatchEnvelope 登记的 request_id（inflightDispatches）
  //      在吊销时标 revoked，返回时结果作废（不回执行结果）；
  //   ② 服务端 job：该 Key 名下 PENDING/RUNNING/UNKNOWN 的 job 即改为
  //      CANCELLED（error_code QFR_API_KEY_REVOKED），幂等 RUNNING 记
  //      UNKNOWN（与 sweepStaleJobs 同款，不卡重试——反正 admit 会拦）；
  //   ③ 设备端：经通道向设备推吊销全集（syncRevocations）＋发内部踢出
  //      命令（qf-lea-client.exe --internal-b64 <base64>，见 leaKeyRevokedCmd），
  //      设备收到后把该 Key 的排队命令清掉、活动 job 强杀（见 QFRLEA.c
  //      lea.key_revoked）。三层均为 best-effort 且有界：kick 总预算
  //      KICK_TOTAL_BUDGET_MS（5000，RC-02 验收），超时／离线不阻断吊销
  //      本身（吊销已落盘 keys.json，admit 即时生效）。
  const KICK_TOTAL_BUDGET_MS = 5000;
  const KICK_PER_DEVICE_MS = 4000;
  const inflightDispatches = new Map(); // request_id -> { key_id, device_id, revoked }
  function markInflightRevoked(keyIds) {
    const set = new Set((keyIds || []).filter(Boolean));
    if (!set.size) return 0;
    let n = 0;
    for (const e of inflightDispatches.values()) {
      if (e && set.has(e.key_id) && !e.revoked) { e.revoked = true; n++; }
    }
    return n;
  }
  function cancelJobsForKeys(keyIds, reason) {
    const set = new Set((keyIds || []).filter(Boolean));
    if (!set.size) return { cancelled: 0, job_ids: [] };
    let cancelled = 0;
    const jobIds = [];
    try {
      const st = loadJobs();
      for (const [id, j] of Object.entries(st.jobs)) {
        if (!j || !set.has(j.api_key_id)) continue;
        if (j.status !== 'PENDING' && j.status !== 'RUNNING' && j.status !== 'UNKNOWN') continue;
        j.status = 'CANCELLED'; j.error_code = ERR.BAD_KEY; j.updated_at = now();
        cancelled++; jobIds.push(id);
        if (j.idempotency_key && j.account_id && j.api_key_id) {
          const ns = j.batch_id ? IDEM_NS.BATCH : IDEM_NS.EXEC;
          const prev = idemLookup(j.account_id, j.api_key_id, j.idempotency_key, ns);
          if (prev && prev.status === 'RUNNING') {
            idemRecord(j.account_id, j.api_key_id, j.idempotency_key,
              Object.assign({}, prev, { status: 'UNKNOWN' }), ns);
          }
        }
        audit('lea-job-cancelled-revoked', { job_id: id, account_id: j.account_id || null, device_id: j.device_id || null, api_key_id: j.api_key_id || null, reason: reason || 'key-revoked' });
      }
      if (cancelled) saveJobs(st);
    } catch (e) {}
    return { cancelled, job_ids: jobIds };
  }
  // 踢出命令（runcommands 字符串）：qf-lea-client.exe --internal-b64 <base64>。
  // base64 字母表对 cmd.exe 安全（dispatch <b64> 同款形态）；不用 --internal
  // 裸 JSON（JSON 内双引号会被 cmd.exe 截断）。设备端收到后：先把 key_ids
  // 并集合并进本机吊销表，再清掉该 Key 的排队命令、强杀活动 job（见 QFRLEA.c）。
  function leaKeyRevokedCmd(keyIds) {
    const ids = [...new Set((keyIds || []).filter((x) => typeof x === 'string' && x))].sort();
    if (!ids.length) throw new Error('leaKeyRevokedCmd: keyIds required');
    const json = JSON.stringify({ cmd: 'lea.key_revoked', key_ids: ids });
    const b64 = Buffer.from(json, 'utf8').toString('base64');
    return LEA_CLIENT_EXE + ' --internal-b64 ' + b64;
  }
  async function kickRevokedSessions(channel, optsKick) {
    const o = optsKick || {};
    const keyIds = [...new Set((o.keyIds || []).filter(Boolean))].sort();
    let deviceIds = [...new Set((o.deviceIds || []).filter(Boolean).map(bareNodeId))].filter(Boolean).sort();
    if (!deviceIds.length && o.accountId && typeof devicesForAccount === 'function') {
      try { deviceIds = devicesForAccount(o.accountId) || []; } catch (e) { deviceIds = []; }
    }
    const started = Date.now();
    const budgetMs = Number.isSafeInteger(o.timeoutMs) && o.timeoutMs > 0 ? o.timeoutMs : KICK_TOTAL_BUDGET_MS;
    const deadline = started + budgetMs;
    // 预算竞速：syncRevocations 内部 runCommand 超时 15 秒，直接等会拖垮
    // 5 秒预算；race 到期即停等（底层调用继续跑，不可取消，但不阻塞返回）。
    const timeoutRace = (p, ms) => Promise.race([p, sleep(Math.max(0, ms)).then(() => { throw new Error('kick-timeout'); })]);
    // ①② 在途＋job（不依赖通道，立即做；revoke 函数内已做过一次，此处
    // 再做是幂等的——已取消的 job 不会重复计数）。
    const inflight = markInflightRevoked(keyIds);
    const jobs = cancelJobsForKeys(keyIds, o.reason || 'key-revoked');
    const devices = [];
    // ③ 设备端：逐台推吊销全集＋发踢出命令；超预算即停（余下设备等下次下发前 H21 重推）。
    for (const d of deviceIds) {
      if (Date.now() >= deadline) { devices.push({ device_id: d, push: 'skipped-budget', kick: 'skipped-budget', ms: 0 }); continue; }
      const t0 = Date.now();
      let push = 'skipped-no-channel', kick = 'skipped-no-channel';
      if (channel && typeof channel.runCommand === 'function') {
        try {
          const s = await timeoutRace(syncRevocations(channel, d), deadline - Date.now());
          push = s && s.synced ? 'ok' : ('failed:' + (s.reason || 'unknown'));
        } catch (e) { push = 'failed:' + String(e && e.message).slice(0, 80); }
        if (Date.now() < deadline) {
          try {
            const remain = Math.max(0, Math.min(KICK_PER_DEVICE_MS, deadline - Date.now()));
            const out = await channel.runCommand(d, leaKeyRevokedCmd(keyIds), remain);
            kick = (typeof out === 'string' && out.includes('"ok":true')) ? 'ok' : 'unexpected-output';
          } catch (e) { kick = 'failed:' + String(e && e.message).slice(0, 80); }
        } else { kick = 'skipped-budget'; }
      }
      devices.push({ device_id: d, push, kick, ms: Date.now() - t0 });
    }
    const elapsedMs = Date.now() - started;
    audit('lea-key-revoked-kick', { key_ids: keyIds, device_ids: deviceIds, inflight_revoked: inflight, jobs_cancelled: jobs.cancelled, devices, elapsed_ms: elapsedMs, within_5s: elapsedMs <= 5000, reason: o.reason || 'key-revoked' });
    return { ok: true, key_ids: keyIds, device_ids: deviceIds, inflight_revoked: inflight, jobs_cancelled: jobs.cancelled, cancelled_job_ids: jobs.job_ids, devices, elapsed_ms: elapsedMs, within_5s: elapsedMs <= 5000 };
  }

  // ---------- 准入：七项校验（DESIGN §6.2），服务端先拦 ----------
  // deviceOnline: async (deviceId) => true/false/null（null=未知/通道不可达）。
  // 调用方注入；未注入时第 1 项判 unknown → fail-closed 503。
  function admit(ctx) {
    // ctx: { key, deviceId, command, requestId, ip }
    const k = ctx.key;
    // 归一：调用方可能送全形或裸形 id，准入各门一律按裸形比对。
    const deviceId = bareNodeId(String(ctx.deviceId || ''));
    const spec = COMMANDS[ctx.command];
    if (!spec) return { ok: false, status: 400, code: ERR.VALIDATION, msg: '未知命令：' + String(ctx.command || '') };
    // ⑤ Key 归属与状态（已在 authenticate 中验过，此处复核吊销/过期）
    if (!k || keyStatus(k) !== 'active') {
      return { ok: false, status: 401, code: ERR.BAD_KEY, msg: 'API Key 已吊销或已过期。' };
    }
    // ② 白名单（H04；DESIGN §6.2 第 ② 项）：设备须在白名单内。顺序上
    // ⑤ 先于 ②是故意的——先验 Key 有效，避免用白名单有无给无效 Key
    // 做存在性预言；② 仍在 ③④⑥ 之前。
    if (!isWhitelisted(deviceId)) {
      return { ok: false, status: 403, code: ERR.NOT_WHITELISTED, msg: '设备不在 Muse 操作白名单内。' };
    }
    // ⑥ scope：device_id 必须与 Key 绑定一致，否则 403（归一后比对：
    // Key 的 device_scope 可能为全形——控制台生成时按原样存入）。
    if (k.device_scope && bareNodeId(k.device_scope) !== deviceId) {
      return { ok: false, status: 403, code: ERR.SCOPE_DENIED, msg: '该 Key 不能操作此设备。' };
    }
    if (!k.scopes.includes(spec.scope) && !k.scopes.includes('muse.execute')) {
      return { ok: false, status: 403, code: ERR.SCOPE_DENIED, msg: '该 Key 没有此操作的授权范围。' };
    }
    if (spec.dangerous && !k.scopes.includes(DANGEROUS_SCOPE)) {
      return { ok: false, status: 403, code: ERR.SCOPE_DENIED, msg: '危险操作需要 muse.execute.dangerous 范围。' };
    }
    // ③ 绑定：当前绑定账号必须与 Key 账号一致，epoch 必须匹配
    const binding = deviceId ? getBinding(deviceId) : null;
    if (!binding || binding.state !== 'ACTIVE') {
      const code = (binding && binding.state === 'PENDING') ? ERR.BINDING_PENDING : ERR.NOT_BOUND;
      const status = code === ERR.BINDING_PENDING ? 409 : 403;
      return { ok: false, status, code, msg: code === ERR.BINDING_PENDING ? '设备绑定确认中，请 1 秒后重试一次。' : '设备未绑定当前账号。' };
    }
    if (binding.account_id !== k.account_id) {
      return { ok: false, status: 409, code: ERR.BINDING_CHANGED, msg: '设备已换绑到其他账号，本次 Key 不再适用。' };
    }
    // H22：epoch 校验不跳过 0——binding_epoch 恒 ≥1（recordBinding 从 1 起），
    // 0 即“绑定前／无设备域生成的 Key”，必须按不匹配拒绝并重新生成。
    if ((k.binding_epoch || 0) !== binding.binding_epoch) {
      return { ok: false, status: 409, code: ERR.BINDING_CHANGED, msg: '绑定代次已变更，请重新生成 Key。' };
    }
    // ④ 账号授权 + grant_epoch
    const grant = getGrant(k.account_id);
    if (!grant || grant.revoked_at || grant.scope !== 'muse.execute') {
      const code = (grant && grant.revoked_at) ? ERR.GRANT_REVOKED : ERR.NOT_AUTHORIZED;
      return { ok: false, status: 403, code, msg: '该账号未授权 Muse 操作，或授权已被撤销。' };
    }
    // T07/D1：Key 绑定生成时的 grant_epoch；授权撤销／重授予都会递增
    // grant_epoch，旧 Key 的 epoch 再也对不上，永不复活。重授予后须发新 Key。
    if ((k.grant_epoch || 0) !== grant.grant_epoch) {
      return { ok: false, status: 403, code: ERR.GRANT_REVOKED, msg: '授权代次已变更，请重新生成 Key。' };
    }
    return { ok: true, binding, grant };
  }

  // ---------- 认证：Bearer Key + 防重放（DESIGN §8.1） ----------
  // headers: { authorization, 'x-qfr-request-id', 'x-qfr-timestamp', 'x-qfr-nonce' }
  // 返回 { ok, key } 或 { ok:false, status, code, msg }。
  function authenticate(headers, optsAuth) {
    optsAuth = optsAuth || {};
    const authz = String((headers && (headers.authorization || headers.Authorization)) || '');
    const m = authz.match(/^Bearer\s+(.+)$/i);
    if (!m) return { ok: false, status: 401, code: 'QFR_UNAUTHORIZED', msg: '缺少 Bearer API Key。' };
    const plain = m[1].trim();
    if (!plain.startsWith(KEY_PREFIX)) return { ok: false, status: 401, code: ERR.BAD_KEY, msg: 'API Key 格式不正确。' };
    const key = findKeyByPlain(plain);
    if (!key) return { ok: false, status: 401, code: ERR.BAD_KEY, msg: 'API Key 无效或已吊销。' };
    if (keyStatus(key) !== 'active') {
      return { ok: false, status: 401, code: ERR.BAD_KEY, msg: 'API Key 已吊销或已过期。' };
    }
    // 防重放：时间戳 + nonce（§4.1/§8.1）。时间窗 |now - ts| ≤ 60s。
    const tsRaw = headers && (headers['x-qfr-timestamp'] || headers['X-QFR-Timestamp']);
    const nonce = headers && (headers['x-qfr-nonce'] || headers['X-QFR-Nonce']);
    if (optsAuth.requireReplayHeaders !== false) {
      const ts = Number(tsRaw);
      if (!tsRaw || !Number.isFinite(ts)) {
        return { ok: false, status: 401, code: ERR.REPLAY, msg: '缺少 X-QFR-Timestamp。' };
      }
      if (Math.abs(nowSec() - ts) > TIMESTAMP_SKEW_S) {
        return { ok: false, status: 401, code: ERR.REPLAY, msg: '请求时间戳超出允许窗口。' };
      }
      if (!nonce || typeof nonce !== 'string' || nonce.length < 8) {
        return { ok: false, status: 401, code: ERR.REPLAY, msg: '缺少 X-QFR-Nonce。' };
      }
      if (!nonceCheck(key.key_id, nonce)) {
        audit('lea-replay-detected', { api_key_id: key.key_id, key_prefix: maskKey(key.prefix), account_id: key.account_id, nonce: String(nonce).slice(0, 16) });
        return { ok: false, status: 401, code: ERR.REPLAY, msg: '检测到重放请求。' };
      }
    }
    touchKeyLastUsed(key);
    return { ok: true, key };
  }

  // ---------- 信封组包（DESIGN §4.1；规范串 v2） ----------
  function buildEnvelope(input) {
    const issued = nowSec();
    // params 必须是 JSON 对象（顶层数组／标量即拒绝）：C 端只接受 JSON 对象
    // params_raw，JS 可签、C 拒收的信封不得产生。
    if (input.params != null && (typeof input.params !== 'object' || Array.isArray(input.params))) {
      throw new Error('LEA envelope params must be an object');
    }
    // F-02：grantEpoch 必填（来源：admit() 返回的 grant.grant_epoch，
    // admit 已验证它等于 Key 的 grant_epoch）。缺失／非安全整数／负数
    // 即抛错不发信封，不得缺省为 0 后签名。
    if (!Number.isSafeInteger(input.grantEpoch) || input.grantEpoch < 0) {
      throw new Error('LEA envelope grant_epoch missing or invalid');
    }
    // B1：分级派生 job_id／mode／deadline_ms（与 C 端 lea_command_tier／
    // lea_job_deadline_ms 逐项一致；显式传入时照传入值，校验在规范串层）。
    const spec = COMMANDS[input.command];
    const tier = spec ? (spec.tier || 1) : 1;
    const tierCap = tier === 2 ? 120000 : 8000;
    const effTimeout = input.timeoutMs !== undefined ? input.timeoutMs : (spec ? spec.timeoutMs : 5000);
    const env = {
      version: 2,
      request_id: input.requestId,
      batch_id: input.batchId || null,
      seq: input.seq || 1,
      device_id: String(input.deviceId),
      account_id: String(input.accountId),
      api_key_id: input.keyId,
      binding_epoch: input.bindingEpoch,
      grant_epoch: input.grantEpoch,
      nonce: crypto.randomBytes(16).toString('base64url'),
      issued_at: issued,
      expires_at: issued + ENVELOPE_TTL_S,
      idempotency_key: input.idempotencyKey,
      command: input.command,
      // params 归一化为键已排序的深拷贝：签名与线上传输用同一份对象，
      // 线上 params 子串即 stable JSON，C 端对原文算哈希才能对上（§2.1）。
      params: normalizeParams(input.params || {}),
      timeout_ms: input.timeoutMs,
      job_id: input.jobId || input.requestId,
      mode: input.mode || (input.command === 'script.run' ? 'async' : 'sync'),
      deadline_ms: input.deadlineMs !== undefined ? input.deadlineMs : Math.min(effTimeout, tierCap),
    };
    return signEnvelope(env);
  }

  // ---------- RC-01：LEA 握手（签名参数＋版本绑定） ----------
  // 握手是设备端接受任何业务命令的前置条件（RustDesk key_exchange 同款
  // 思路：签名过的参数——服务端公钥指纹＋协议版本＋授权世代——三项一致
  // 才接受；验签未完成不投递任何命令）。
  // 形态：复用 v2 信封（不升 v3——信封字段不变），命令为 sys.handshake
  // （tier 0 内联），params 带两项签名参数：
  //   server_pubkey_fp：服务端 Ed25519 公钥的 SHA-256 指纹前 16 位 hex
  //     （与 signingPublicKeyFingerprint 同定义：对 base64 公钥文本算
  //     SHA-256；设备端 lea_server_pubkey_fingerprint 按同一定义算）；
  //   protocol_version：2（须等于 LEA_PROTOCOL_VERSION）。
  // binding_epoch／grant_epoch 已是信封顶层签名覆盖字段，不再进 params。
  // 服务端缓存：每设备只在 (fp, binding_epoch, grant_epoch) 不变时视为
  // 已握手；任一变化即重新握手。设备重启丢握手态时，服务端凭设备回的
  // QFR_LEA_HANDSHAKE_REQUIRED 重新握手一次再重试（见 dispatchEnvelope）。
  const HANDSHAKE_PROTOCOL_VERSION = 2;
  const handshakeByDevice = new Map(); // bare device_id -> { fp, grantEpoch, bindingEpoch, at }
  function handshakeState(deviceId) {
    const s = handshakeByDevice.get(bareNodeId(String(deviceId || '')));
    return s ? Object.assign({}, s) : null;
  }
  function invalidateHandshake(deviceId) {
    handshakeByDevice.delete(bareNodeId(String(deviceId || '')));
  }
  function buildHandshakeEnvelope(input) {
    const fp = signingPublicKeyFingerprint();
    if (!fp) throw new Error('LEA handshake requires a configured signing key (no public key fingerprint)');
    return buildEnvelope({
      requestId: 'hs-' + randId(12), batchId: null, seq: 1,
      deviceId: input.deviceId, accountId: input.accountId, keyId: input.keyId,
      bindingEpoch: input.bindingEpoch, grantEpoch: input.grantEpoch,
      idempotencyKey: 'hs-' + randId(12),
      command: 'sys.handshake',
      params: { server_pubkey_fp: fp, protocol_version: HANDSHAKE_PROTOCOL_VERSION },
      timeoutMs: 5000,
    });
  }
  async function ensureHandshake(channel, env) {
    // env 为本次业务信封（须含 device_id／account_id／api_key_id／
    // binding_epoch／grant_epoch）。sys.handshake 自身不走本函数。
    const deviceId = bareNodeId(String(env.device_id || ''));
    const fp = signingPublicKeyFingerprint();
    // F-04 形态保留：签名能力未就绪（disabled／临时密钥）时不走握手，
    // 由调用方沿用既有“下发门”拒绝形态（signingBlocked＋审计）。
    if (!fp || signing.mode !== 'real') return { ok: false, reason: 'signing-not-real' };
    const cached = handshakeByDevice.get(deviceId);
    if (cached && cached.fp === fp && cached.grantEpoch === env.grant_epoch && cached.bindingEpoch === env.binding_epoch) {
      return { ok: true, cached: true };
    }
    if (!channel || typeof channel.runCommand !== 'function') return { ok: false, reason: 'no-channel' };
    let hsEnv;
    try {
      hsEnv = buildHandshakeEnvelope({
        deviceId: env.device_id, accountId: env.account_id, keyId: env.api_key_id,
        bindingEpoch: env.binding_epoch, grantEpoch: env.grant_epoch,
      });
    } catch (e) { return { ok: false, reason: 'build-failed', error: e }; }
    let r;
    try {
      // 直调内层（不走 dispatchEnvelope 外层——避免健康预检／in-flight
      // 递归；握手本身是 5 秒短命令，失败即本次下发拒绝）。
      r = await dispatchEnvelopeInner(channel, hsEnv, { timeoutMs: 5000 });
    } catch (e) { return { ok: false, reason: 'dispatch-threw', error: e }; }
    if (r && r.ok) {
      handshakeByDevice.set(deviceId, { fp, grantEpoch: env.grant_epoch, bindingEpoch: env.binding_epoch, at: now() });
      audit('lea-handshake-completed', { device_id: env.device_id, account_id: env.account_id, api_key_id: env.api_key_id, binding_epoch: env.binding_epoch, grant_epoch: env.grant_epoch });
      return { ok: true, cached: false };
    }
    const code = (r && r.clientResult && r.clientResult.code) || (r && r.error && String(r.error.message)) || 'unknown';
    log({ ev: 'lea-handshake-failed', device_id: env.device_id, command: env.command, reason: code });
    return { ok: false, reason: 'device-rejected', code };
  }

  // ---------- Job（长任务，DESIGN §4.3） ----------
  function createJob(fields) {
    const st = loadJobs();
    const job = Object.assign({
      job_id: 'job_' + randId(16), status: 'PENDING',
      created_at: now(), updated_at: now(), result: null, error_code: null,
    }, fields || {});
    st.jobs[job.job_id] = job;
    saveJobs(st);
    return job;
  }
  function getJob(jobId) {
    const st = loadJobs();
    return st.jobs[String(jobId)] || null;
  }
  function updateJob(jobId, patch) {
    const st = loadJobs();
    const j = st.jobs[String(jobId)];
    if (!j) return null;
    Object.assign(j, patch, { updated_at: now() });
    saveJobs(st);
    return j;
  }
  function pruneJobs() {
    try {
      const st = loadJobs();
      let dirty = false;
      for (const [id, j] of Object.entries(st.jobs)) {
        if (j && (j.status === 'SUCCEEDED' || j.status === 'FAILED' || j.status === 'CANCELLED' || j.status === 'UNKNOWN')
          && now() - (j.updated_at || j.created_at || 0) > JOB_RETENTION_MS) { delete st.jobs[id]; dirty = true; }
      }
      if (dirty) saveJobs(st);
    } catch (e) {}
  }

  // H14：job 推进器——下发超时后 job 置 UNKNOWN、幂等记 RUNNING，此前无
  // 任何推进路径，同幂等键重试会被 DUPLICATE_IN_PROGRESS 卡 7 天（危险
  // 30 天）。失联 job（RUNNING/UNKNOWN/PENDING 超 JOB_STALE_MS 无更新，
  // 含上轮进程崩溃／重启残留）推进为 UNKNOWN（结果未知，不得谎称成功／
  // 失败），幂等键同步转 UNKNOWN：重试不再被长期卡住（UNKNOWN 不拦重放，
  // 路由层只拦 RUNNING），同时保留“结果未知、须快照确认”的语义。
  function sweepStaleJobs() {
    try {
      const st = loadJobs();
      let dirty = false;
      for (const [id, j] of Object.entries(st.jobs)) {
        if (!j || (j.status !== 'RUNNING' && j.status !== 'UNKNOWN' && j.status !== 'PENDING')) continue;
        if (now() - (j.updated_at || j.created_at || 0) <= JOB_STALE_MS) continue;
        j.status = 'UNKNOWN'; j.error_code = ERR.UNKNOWN; j.updated_at = now(); dirty = true;
        if (j.idempotency_key && j.account_id && j.api_key_id) {
          // DC-A-4：失联 job 的幂等键按类型取命名空间（批量 job 带 batch_id，
          // 单条 job 没有），与写入侧一致，否则推进写不到同一槽。
          const ns = j.batch_id ? IDEM_NS.BATCH : IDEM_NS.EXEC;
          const prev = idemLookup(j.account_id, j.api_key_id, j.idempotency_key, ns);
          if (prev && prev.status === 'RUNNING') {
            idemRecord(j.account_id, j.api_key_id, j.idempotency_key,
              Object.assign({}, prev, { status: 'UNKNOWN' }), ns);
          }
        }
        audit('lea-job-stale', {
          job_id: id, account_id: j.account_id || null, device_id: j.device_id || null,
          api_key_id: j.api_key_id || null, idempotency_key: j.idempotency_key || null,
        });
      }
      if (dirty) saveJobs(st);
      return true;
    } catch (e) { return false; }
  }

  // ---------- 下发（经注入的 channel.runCommand；DESIGN §3） ----------
  // channel 契约：{ runCommand(nodeId, cmd, timeoutMs) -> stdout string,
  //   listNodes() -> [{id/nodeid, online}] }。缺 channel 时返回 NOT_INSTALLED。
  // 同步预算 SYNC_WAIT_MS；超时则建 job 返回 202（结果 UNKNOWN，须查 job）。
  // 下发失败（通道异常）按幂等键重试 1 次；危险命令不自动重试。
  //
  // 下发动词统一（S3，2026-11-10，DESIGN §3；两端同一方案，见
  // windows/lea/qf-lea-client.c 头注释）：
  //   小信封：qf-lea-client.exe dispatch <base64 信封>
  //     客户端 Base64 解码后发往管道。Base64 字母表对 runcommands／
  //     cmd.exe 安全；裸 JSON 含 `"` 且 params 可含用户输入的 shell
  //     元字符（& % " ^ | < >），故不走裸 JSON argv。
  //   大信封（b64 > 6000）：先 powershell 写
  //     C:\ProgramData\QFR\LEA\inbox\<request_id>.json（原始 JSON），
  //     再 qf-lea-client.exe apply "<inbox 全路径>"。
  //   旧服务端曾发 `apply <裸文件名>`，客户端会把 `apply` 当信封原文
  //   发往管道；现 apply 一律带全路径（客户端也兼容裸文件名）。
  const LEA_CLIENT_EXE = '"C:\\Program Files\\QFR\\LEA\\qf-lea-client.exe"';
  const LEA_INBOX_DIR = 'C:\\ProgramData\\QFR\\LEA\\inbox';
  function leaInboxPath(fileName) { return LEA_INBOX_DIR + '\\' + fileName; }
  function leaClientCmd(envelopeB64) {
    // 小信封直接传参（dispatch <base64>，客户端实测可解——见
    // test/test-lea-realclient.js 对真客户端跑通）。
    return LEA_CLIENT_EXE + ' dispatch ' + envelopeB64;
  }
  function leaInboxWriteCmd(fileName, b64) {
    // 复用隐私锁 psWriteInbox 同款 Base64 写文件（lock-bridge.js）。
    return 'powershell -NoProfile -NonInteractive -Command "[IO.File]::WriteAllBytes(\'' + leaInboxPath(fileName) + '\',[Convert]::FromBase64String(\'' + b64 + '\'))"';
  }
  const ENVELOPE_INLINE_LIMIT = 6000; // 信封 base64 超此长改两步写 inbox
  // r9：重试须换全新信封——同一信封重发必被 LEA 幂等／重放层以
  // QFR_REPLAY_DETECTED 拒绝（r8 实证：tree/click 重试档 audit 全为
  // REPLAY_DETECTED，duration 0），旧“原样重发一次”重试永无成功可能。
  // 仅单条信封可重试：批量步重发同 seq 会撞 batch-seq 单调性（seq<=
  // last_seq 即判重放），故 batch_id 非空时不重试。危险命令不重试
  // （调用方 maxAttempts 已为 1，此处再守一道）。
  // 新信封：request_id 加 '-r2' 后缀、新 nonce、新签名（buildEnvelope
  // 重签）；idempotency_key 保持不变——DS 跟进复核纠正：轮换幂等键
  // 等于发起了新请求，首试若已执行会被重复执行；复用同一幂等键时，
  // 首试已执行则 LEA 直接回幂等缓存（replayed-cached），不重复执行；
  // 首试未达 LEA 则正常执行。重放检查认（request_id，nonce），新
  // request_id＋新 nonce 可过重放关。request_id 加后缀超 128 字符
  // 即不重试。
  function freshRetryEnvelope(env) {
    if (!env || env.batch_id) return null;
    if (typeof env.request_id !== 'string' || typeof env.idempotency_key !== 'string') return null;
    if (env.request_id.length + 3 > 128) return null;
    try {
      return buildEnvelope({
        requestId: env.request_id + '-r2', batchId: null, seq: 1,
        deviceId: env.device_id, accountId: env.account_id, keyId: env.api_key_id,
        bindingEpoch: env.binding_epoch, grantEpoch: env.grant_epoch,
        idempotencyKey: env.idempotency_key,
        command: env.command, params: env.params || {}, timeoutMs: env.timeout_ms,
      });
    } catch (e) { return null; }
  }
  // B1 健康探测（DEGRADED 时下发前调用）：sys.ping 探测→失败则 sys.reset
  // ＋sys.ping 验证。直接调 channel.runCommand（不走 dispatchEnvelope，
  // 避免递归进健康检查）。探测信封用 buildEnvelope 新签（fresh requestId／
  // idempotencyKey，同 device／account／binding）。
  async function probeNodeHealth(channel, env) {
    const mkEnv = (command) => buildEnvelope({
      requestId: 'ping-' + randId(12), batchId: null, seq: 1,
      deviceId: env.device_id, accountId: env.account_id, keyId: env.api_key_id,
      bindingEpoch: env.binding_epoch, grantEpoch: env.grant_epoch,
      idempotencyKey: 'probe-' + randId(12),
      command, params: {}, timeoutMs: 5000,
    });
    const runOne = async (command) => {
      try {
        const e = mkEnv(command);
        const b64 = Buffer.from(JSON.stringify(e), 'utf8').toString('base64');
        const out = await channel.runCommand(e.device_id, leaClientCmd(b64), DISPATCH_TIMEOUT_MS);
        const p = parseClientOutput(out);
        return !!(p.ok && p.result);
      } catch (err) { return false; }
    };
    if (await runOne('sys.ping')) return true;
    // ping 失败：进 RECOVERING，sys.reset 后再 ping 验证。
    const h = healthGet(env.device_id);
    h.state = 'RECOVERING';
    try { await runOne('sys.reset'); } catch (e) {}
    if (await runOne('sys.ping')) { h.fails = 0; h.state = 'OK'; return true; }
    return false;
  }

  // B1 外层：健康预检＋in-flight 名额＋超时计数（内层只管单次下发）。
  async function dispatchEnvelope(channel, env, optsD) {
    // RC-01：握手门——业务命令下发前须先完成握手（sys.handshake 自身除外）。
    // 握手失败即拒绝本次下发（不投递任何命令），调用方按 503 处理。
    if (env.command !== 'sys.handshake') {
      let hs;
      try { hs = await ensureHandshake(channel, env); } catch (e) { hs = { ok: false, reason: 'threw' }; }
      if (!hs.ok) {
        // F-04：签名能力未就绪时沿用既有“下发门”拒绝形态（signingBlocked＋
        // lea-dispatch-signing-blocked 审计），不改成 handshakeBlocked。
        if (hs.reason === 'signing-not-real') {
          log({ ev: 'lea-dispatch-signing-blocked', device_id: env.device_id, command: env.command, signing_mode: signing.mode });
          return { ok: false, error: new Error('lea-signing-not-real'), attempts: 0, signingBlocked: true };
        }
        return { ok: false, error: new Error('lea-handshake-failed: ' + (hs.reason || 'unknown')), handshakeBlocked: true, attempts: 0 };
      }
    }
    // 健康预检：DEGRADED 时先探测；sys.ping／sys.reset 本身是恢复命令，不预检。
    const h = healthGet(env.device_id);
    if (h.state !== 'OK' && env.command !== 'sys.ping' && env.command !== 'sys.reset') {
      let okProbe = false;
      try { okProbe = await probeNodeHealth(channel, env); } catch (e) { okProbe = false; }
      if (!okProbe) {
        return { ok: false, error: new Error('node-degraded-probe-failed'), notInstalled: true, attempts: 0 };
      }
      healthNoteSuccess(env.device_id);
    }
    // RC-02：在途下发登记（dispatchEnvelopeInner 单次下发）。同一 request_id
    // 在途时 Key 被吊销，即把本次结果作废（不回执行结果，调用方须快照确认）。
    // queueFull 时直接返回，不登记。
    async function runOnce(e) {
      if (!inflightAcquire(e.device_id)) {
        return { ok: false, error: new Error('inflight-full'), queueFull: true, attempts: 0 };
      }
      const entry = { key_id: e.api_key_id, device_id: e.device_id, revoked: false };
      inflightDispatches.set(e.request_id, entry);
      let out;
      try { out = await dispatchEnvelopeInner(channel, e, optsD); }
      finally { inflightDispatches.delete(e.request_id); inflightRelease(e.device_id); }
      if (out && out.ok && entry.revoked) {
        out = { ok: false, error: new Error('lea-key-revoked-during-dispatch'), revokedDuringDispatch: true, attempts: out.attempts || 0 };
      }
      return out;
    }
    let r = await runOnce(env);
    // RC-01：设备丢了握手态（重启）→ 重新握手一次，再用全新信封重试一次。
    // 批量步（batch_id 非空）换不出新信封时不重试，原错返回。
    if (r && !r.ok && r.clientResult && r.clientResult.code === ERR.HANDSHAKE_REQUIRED && env.command !== 'sys.handshake') {
      invalidateHandshake(env.device_id);
      let hs2 = null;
      try { hs2 = await ensureHandshake(channel, env); } catch (e) { hs2 = null; }
      if (hs2 && hs2.ok) {
        const fresh = freshRetryEnvelope(env);
        if (fresh) r = await runOnce(fresh);
      }
    }
    // C1：下发成功即记设备最后在线（60 秒节流，见 touchDeviceSeen）。
    if (r && r.ok) { try { touchDeviceSeen(env.device_id); } catch (e) {} }
    // 超时计数：下发超时（通道超时／客户端 timeout JSON 终态）记一次；
    // 成功即清零。accepted（异步接纳）不记超时（命令已入队，结果未到
    // 不是通道故障）。
    if (r && r.timeout) healthNoteTimeout(env.device_id);
    else if (r && r.ok) healthNoteSuccess(env.device_id);
    else if (r && r.clientResult && r.clientResult.code === 'QFR_LEA_TIMEOUT') healthNoteTimeout(env.device_id);
    return r;
  }

  async function dispatchEnvelopeInner(channel, env, optsD) {
    optsD = optsD || {};
    // F-04 下发门：非 real 签名模式一律拒绝下发并记审计（disabled 与
    // placeholder-ephemeral 均拦；临时密钥签的信封永不离站）。
    if (signing.mode !== 'real') {
      log({ ev: 'lea-dispatch-signing-blocked', device_id: env.device_id, command: env.command, signing_mode: signing.mode });
      return { ok: false, error: new Error('lea-signing-not-real'), attempts: 0, signingBlocked: true };
    }
    const spec = COMMANDS[env.command] || { dangerous: false };
    // H21＋F-01 分级门：下发前先把本机吊销表推到最新全集。同步成功／
    // 本就已同步／无吊销时一切照常；同步失败时：
    //   - 危险命令（spec.dangerous）禁止下发，返回 revocation-sync-failed
    //     （不重试——重试同一信封会撞重放，调用方须持新信封显式重试）；
    //   - 非危险命令与 sys.ping／sys.info（只读）／sys.reset（恢复命令）
    //     继续下发：服务端 admit 仍是第一层实时控制（Key 吊销实时查），
    //     设备端三态吊销检查同样覆盖 sys.* 内联路径。sys.reset 允许过门
    //     的理由：它是 B1 通道自愈的指定恢复命令、无执行载荷、且 COMMANDS
    //     里它本就不是 dangerous；把它拦在门外会让通道自愈无法恢复。
    // 不做端到端吊销世代 ACK 门（后续项，F-01 不扩大范围）。
    // 危险命令被门拦时记一条可审计日志（lea-revocation-sync-blocked）。
    let sync = null;
    try { sync = await syncRevocations(channel, env.device_id); } catch (e) { log({ ev: 'lea-revocation-sync-failed', device_id: env.device_id, err: String(e && e.message) }); sync = { synced: false, reason: 'sync-threw' }; }
    if (sync && !sync.synced && spec.dangerous) {
      log({ ev: 'lea-revocation-sync-blocked', device_id: env.device_id, command: env.command, generation: (sync && sync.generation) || null, reason: sync.reason || null });
      return { ok: false, error: new Error('revocation-sync-failed'), attempts: 0, revocationSyncBlocked: true };
    }
    // R5（Q7 审阅第 7 点前置①）：同步失败但放行 sys.reset 时记一条
    // 降级放行事件（lea-revocation-sync-degraded-allow，带 command／
    // generation／reason）。只加事件，不改分级门逻辑、不改 sys.reset 行为。
    if (sync && !sync.synced && env.command === 'sys.reset') {
      log({ ev: 'lea-revocation-sync-degraded-allow', device_id: env.device_id, command: env.command, generation: (sync && sync.generation) || null, reason: sync.reason || null });
    }
    const timeoutMs = optsD.timeoutMs || DISPATCH_TIMEOUT_MS;
    let attempts = 0;
    const maxAttempts = spec.dangerous ? 1 : 2; // 危险命令禁自动重试
    let lastErr = null;
    let retryable = false; // 本轮失败是否可重试（见下）
    let curEnv = env;
    while (attempts < maxAttempts) {
      attempts++;
      retryable = false;
      try {
        const b64 = Buffer.from(JSON.stringify(curEnv), 'utf8').toString('base64');
        let out;
        if (b64.length <= ENVELOPE_INLINE_LIMIT) {
          out = await channel.runCommand(curEnv.device_id, leaClientCmd(b64), timeoutMs);
        } else {
          const fn = curEnv.request_id.replace(/[^A-Za-z0-9_-]/g, '_') + '.json';
          await channel.runCommand(curEnv.device_id, leaInboxWriteCmd(fn, b64), timeoutMs);
          out = await channel.runCommand(curEnv.device_id,
            LEA_CLIENT_EXE + ' apply "' + leaInboxPath(fn) + '"', timeoutMs);
        }
        // 回传：stdout 应含客户端 JSON 行；解析失败（无 JSON 行）即视为
        // 回传失败（DS 复核：状态未知，不自动重试，见下）。
        const parsed = parseClientOutput(out);
        if (parsed.ok) return { ok: true, result: parsed.result, attempts, raw: out, accepted: parsed.accepted || undefined };
        // B1：只有 ACK（异步已接纳，或结果行被截断／客户端在 ACK 后被杀）：
        // 命令已入 LEA 队列，结果未知，不重试（重试会重复执行），走 job 异步。
        // mode=async 时是预期内的异步接纳；mode=sync 时是结果丢失，按 UNKNOWN 处理。
        if (parsed.acceptedOnly) {
          return { ok: false, accepted: true, asyncExpected: curEnv.mode === 'async', acceptedResult: parsed.accepted, error: new Error('accepted-no-result'), attempts };
        }
        // r9：客户端已回包且执行失败（ok:false）是终态，不是回传故障：
        // 不重试（同信封重试撞 REPLAY_DETECTED，新信封重试则会把一次已
        // 失败的执行再跑一遍），把真实错误带回调用方透传。
        if (parsed.clientResult) {
          return { ok: false, error: new Error('client:' + String(parsed.clientResult.code || 'failed')), clientResult: parsed.clientResult, attempts };
        }
        lastErr = new Error('bad-client-output');
        // DS v4-pro 复核（r9）：回包无 JSON 行时是否已执行未知——重试会
        // 把可能已执行过的命令再跑一遍（ui.click/ui.input 重复执行），
        // 破坏幂等。故解析失败不自动重试，由调用方持新幂等键显式重试。
      } catch (e) {
        lastErr = e;
        if (e && /timeout/i.test(String(e.message || ''))) {
          // 下发超时：不再重试，交由 job 异步（结果 UNKNOWN）。
          return { ok: false, timeout: true, error: e, attempts };
        }
        // 传输层异常（未收到回包，如 svc-down）：命令大概率未执行，可换
        // 新信封重试一次。
        retryable = true;
      }
      // r9：重试须换全新信封（freshRetryEnvelope），原样重发必被判重放。
      // 换不出新信封（批量步／token 已满长）或本轮失败不可重试即停：
      // 此处必须 break——否则 while 条件会让同一信封再跑一次。
      if (attempts >= maxAttempts || !retryable) break;
      const fresh = freshRetryEnvelope(curEnv);
      if (!fresh) break;
      curEnv = fresh;
      await sleep(200);
    }
    return { ok: false, error: lastErr, attempts };
  }
  function parseClientOutput(out) {
    if (typeof out !== 'string') return { ok: false };
    // r9：runcommands 回包是整段控制台 transcript（banner＋回显的命令
    // 行＋客户端 JSON 行＋尾部 "C:\...>exit" 提示行），旧实现只取最后
    // 一非空行——恒为提示行，JSON.parse 恒败，API 下发四条全 502
    // bad-client-output（r8 实证：LEA 侧 click 78ms 已成功执行，服务端
    // 仍判下发失败；手动派发能通，只因人眼从 transcript 里挑出了 JSON 行）。
    // 修法：逐行扫描，取首个能解析为含布尔 ok 字段的 JSON 对象行。
    // B1 两行协议：客户端先回 ACK 行（code QFR_LEA_ACCEPTED，ok:true），
    // 再回结果行。ACK 不是终态：跳过它，取下一 JSON 行当结果；只有 ACK
    // 无结果行时回 accepted（异步已接纳／结果未到，调用方按 job 异步处理，
    // 不把 ACK 当成功结果——否则一次 ui.click 会被谎报已执行）。
    const lines = out.split(/\r?\n/);
    let ack = null;
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line[0] !== '{') continue;
      let v;
      try { v = JSON.parse(line); } catch (e) { continue; }
      if (!v || typeof v !== 'object' || Array.isArray(v) || typeof v.ok !== 'boolean') continue;
      if (v.code === 'QFR_LEA_ACCEPTED') { ack = v; continue; }
      // H15：只认 ok===true 为成功；ok===false 是客户端终态失败，把真实
      // 错误带回（不再谎报 bad-client-output），由 dispatchEnvelope 不重
      // 试、handleExecute 按客户端 code 透传。
      if (v.ok === true) return { ok: true, result: v, accepted: ack || undefined };
      return { ok: false, clientResult: v, accepted: ack || undefined };
    }
    // 只有 ACK（异步已接纳，或结果行被截断／客户端在 ACK 后被杀）：
    // 不是成功也不是失败，调用方按“已接纳、结果未知”走 job 异步。
    if (ack) return { ok: false, accepted: ack, acceptedOnly: true };
    return { ok: false };
  }
  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  return {
    dir, log, audit, pruneAudit, pruneJobs,
    COMMANDS, ERR, KEY_PREFIX, IDEM_NS,
    DISPATCH_TIMEOUT_MS, SYNC_WAIT_MS,
    B1_JOB_UNKNOWN_TIMEOUT_MS, B1_INFLIGHT_MAX, B1_SWEEP_MS, B1_HEALTH_FAILS,
    signingInfo, signingPublicKeyFingerprint, signEnvelope, verifyEnvelope, envelopeSigningBytes,
    // RC-01：握手（签名参数＋版本绑定）
    HANDSHAKE_PROTOCOL_VERSION, buildHandshakeEnvelope, ensureHandshake, handshakeState, invalidateHandshake,
    ticketSigningBytes, signTicket, verifyTicket, issueBindingTicket,
    generateKey, revokeKey, revokeAllKeys, listKeys, findKeyById, keyPublicView, keyStatus, maskKey,
    // C1：自助绑定（issue/complete/renew/status/自助吊销/最后在线）
    issueSelfBindTicket, completeSelfBind, renewSelfBindKey, selfBindStatus,
    revokeSelfBindKey, revokeAllSelfBindKeys, touchDeviceSeen,
    // RC-04：断线重连票据（issue/verify+消费/作废）
    issueReconnectTicket, verifyReconnectTicket, voidReconnectTickets,
    reconnectTicketSigningBytes, signReconnectTicket, verifyReconnectTicketSignature,
    RECONNECT_TICKET_TTL_S,
    // 崩溃上报接收（CRASH-REPORT-SPEC.md）：匿名接收＋强防护
    validateCrashReport, storeCrashReport, scrubCrashStack,
    CRASH_BODY_MAX_BYTES, CRASH_STACK_MAX_BYTES, CRASH_MAX_FILES, CRASH_MAX_TOTAL_BYTES,
    // 卸载注销（2026-11-14）：删绑定＋自助票据，Key／grant 不动
    deregisterDevice, deregisterSigningBytes,
    selfBindCompleteSigningBytes, selfBindRenewSigningBytes, selfBindParseDevicePubkey, selfBindVerifySignature,
    ecdsaP1363ToDer, ecdsaDerToP1363,
    SELFBIND_TICKET_TTL_S, SELFBIND_KEY_DAYS, SELFBIND_RENEW_WINDOW_MS, SELFBIND_RENEW_DAYS,
    grantMuse, revokeGrant, hasGrant, hasDangerousGrant, getGrant, isWhitelisted, bareNodeId,
    recordBinding, getBinding, devicesForAccount,
    authenticate, admit, nonceCheck, idemLookup, idemRecord,
    buildEnvelope, dispatchEnvelope, parseClientOutput, leaClientCmd, leaInboxWriteCmd, leaInboxPath,
    // RC-02：吊销即踢在线会话
    KICK_TOTAL_BUDGET_MS, markInflightRevoked, cancelJobsForKeys, leaKeyRevokedCmd, kickRevokedSessions,
    createJob, getJob, updateJob, sweepStaleJobs, sweepB1Jobs,
    // B1：供路由层／单测的健康与名额状态（不含任何 Key 明文）
    healthGet, healthNoteSuccess, healthNoteTimeout, inflightAcquire, inflightRelease,
    probeNodeHealth,
    getRevocations, syncRevocations, leaRevocationsWriteCmd,
    // 供路由层/单测的内部状态（不含任何 Key 明文）
    _test: { loadKeys, loadGrants, loadBindings, loadJobs, loadRevocations, loadDeregistered, loadReconnectTickets, nonceSeen, idemSeen, hashKey, maskKey, stableStringify, normalizeParams },
  };
}

module.exports = { createLeaCore, COMMANDS, ERR, KEY_PREFIX, ENVELOPE_TTL_S, TICKET_TTL_S, DISPATCH_TIMEOUT_MS, SYNC_WAIT_MS, B1_JOB_UNKNOWN_TIMEOUT_MS, B1_INFLIGHT_MAX, B1_SWEEP_MS, B1_HEALTH_FAILS };
