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
 *  - Ed25519 签名：若部署未提供真实私钥，本模块用进程内临时密钥对
 *    签名并明确标注 PLACEHOLDER（见 signingInfo），流程可跑通，
 *    但该签名不具备生产信任——LEA 客户端届时须配真实公钥验签。
 *    真实私钥接入点：opts.signingKeyFile（Base64 的 64 字节
 *    seed||pub，与 lock-envelope.loadDispatcherKey 同格式）
 *    或 opts.signingKeyPem（PEM）。
 *
 * 签名规范串 v1（S1/S2/S4 定稿）：
 *   唯一规范源见 ~/workspace/qfremote/local-agent/ds-review-stage2/
 *   CANONICAL-SIGNING-V1.md。信封与票据的规范串均为固定行数的
 *   \n 连接串（信封 16 行、票据 9 行），params 只签其规范 JSON
 *   的 SHA-256，C 端（windows/lea/lea_protocol.c）按同一规范实现，
 *   两端字节级一致。改规范须升 v2，不得悄悄改 v1。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------- 常量（DESIGN.md §3/§4/§6/§7/§11） ----------
const KEY_PREFIX = 'qfr_lea_';
const KEY_ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const ENVELOPE_TTL_S = 60;            // expires_at - issued_at ≤ 60s
const TICKET_TTL_S = 24 * 3600;       // 绑定票据有效期 24h（规范串 v1 口径）
const REPLAY_WINDOW_MS = 10 * 60 * 1000; // 服务端 nonce 去重表保留 ≥10 分钟
const TIMESTAMP_SKEW_S = 60;          // HTTP 头时间戳允许偏差（LEA 端 ±30s，服务端取 60s 上限）
const DISPATCH_TIMEOUT_MS = 5000;     // 下发 5s（DESIGN §3）
const SYNC_WAIT_MS = 5000;            // HTTP 同步等待默认 5s，超时 202 + job_id
const JOB_RETENTION_MS = 24 * 3600 * 1000; // 长任务结果保留 24h
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

// 命令集（DESIGN §4.4 MVP）与默认超时、所需 scope、是否危险。
// 危险命令：必须带幂等键、禁自动重试、需 muse.execute.dangerous。
const COMMANDS = {
  'app.open':    { scope: 'muse.execute', dangerous: false, timeoutMs: 15000, maxTimeoutMs: 60000 },
  'app.close':   { scope: 'muse.execute', dangerous: false, timeoutMs: 5000, maxTimeoutMs: 15000 },
  'ui.click':    { scope: 'muse.execute', dangerous: false, timeoutMs: 5000, maxTimeoutMs: 15000 },
  'ui.input':    { scope: 'muse.execute', dangerous: false, timeoutMs: 5000, maxTimeoutMs: 15000 },
  'ui.snapshot': { scope: 'muse.execute', dangerous: false, timeoutMs: 5000, maxTimeoutMs: 15000 },
  'ui.tree':     { scope: 'muse.execute', dangerous: false, timeoutMs: 5000, maxTimeoutMs: 15000 },
  'script.run':  { scope: 'muse.execute', dangerous: true,  timeoutMs: 30000, maxTimeoutMs: 300000 },
  'file.read':   { scope: 'muse.execute', dangerous: false, timeoutMs: 10000, maxTimeoutMs: 30000 },
  'file.write':  { scope: 'muse.execute', dangerous: true,  timeoutMs: 10000, maxTimeoutMs: 60000 },
  'sys.info':    { scope: 'muse.execute', dangerous: false, timeoutMs: 5000, maxTimeoutMs: 5000 },
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
  NOT_INSTALLED: 'QFR_LEA_NOT_INSTALLED', // 503：设备未装 LEA 或通道不可达
  NOT_WHITELISTED: 'QFR_DEVICE_NOT_WHITELISTED', // 403：设备不在白名单（H04，DESIGN §6.2 第 ② 项）
  QUEUE_FULL: 'QFR_QUEUE_FULL', // 503：队列满（本版服务端不排队，仅透传 LEA 端此码）
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

  // ---------- 审计（JSONL 按天，§11.2；保留 ≥180 天，定期清扫） ----------
  function auditFileName(d) {
    const p2 = (n) => String(n).padStart(2, '0');
    return 'audit-' + d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + '.jsonl';
  }
  function audit(ev, fields) {
    const rec = Object.assign({
      ts: new Date(now()).toISOString(), ev,
      // 审计字段（§11.2）：trace_id/request_id/batch_id/account_id/
      // device_id/api_key_id/binding_epoch/command/error_code/...
      // api_key 明文永不入审计，只记 key_id 与前缀脱敏。
    }, fields || {});
    try {
      fs.appendFileSync(path.join(dir, auditFileName(new Date(now()))),
        JSON.stringify(rec) + '\n', { mode: 0o600 });
    } catch (e) { log({ ev: 'lea-audit-write-failed', err: String(e && e.message) }); }
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

  // ---------- Ed25519 签名（DESIGN §4.1） ----------
  // PLACEHOLDER（占位实现，明确标注）：未配真实私钥时用进程内临时密钥对
  // 签名，重启即换，LEA 客户端无法跨进程验签——仅用于跑通流程。
  // 真实私钥接入后 mode='real'，签名方可被 LEA 客户端以服务端公钥验签。
  const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
  let signing = { mode: 'placeholder-ephemeral', privateKey: null, publicKeyBase64: null };
  function loadSigningKey() {
    try {
      if (opts.signingKeyFile) {
        const raw = Buffer.from(String(fs.readFileSync(opts.signingKeyFile, 'utf8')).trim(), 'base64');
        if (raw.length !== 64) throw new Error('LEA signing key must be base64 of 64 bytes (seed||pub)');
        const der = Buffer.concat([ED25519_PKCS8_PREFIX, raw.subarray(0, 32)]);
        const priv = crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
        signing = { mode: 'real', privateKey: priv, publicKeyBase64: raw.subarray(32).toString('base64') };
        log({ ev: 'lea-signing-real-key-loaded' });
        return;
      }
      if (opts.signingKeyPem) {
        const priv = crypto.createPrivateKey(opts.signingKeyPem);
        const pubDer = crypto.createPublicKey(priv).export({ format: 'der', type: 'spki' });
        signing = { mode: 'real', privateKey: priv, publicKeyBase64: pubDer.slice(-32).toString('base64') };
        log({ ev: 'lea-signing-real-key-loaded' });
        return;
      }
    } catch (e) {
      log({ ev: 'lea-signing-key-load-failed', err: String(e && e.message) });
    }
    const kp = crypto.generateKeyPairSync('ed25519');
    const pubJwk = kp.publicKey.export({ format: 'jwk' });
    signing = { mode: 'placeholder-ephemeral', privateKey: kp.privateKey, publicKeyBase64: pubJwk.x };
    log({ ev: 'lea-signing-placeholder', msg: 'NO REAL LEA SIGNING KEY CONFIGURED: using ephemeral in-process Ed25519 key; signatures are NOT verifiable by LEA clients across restarts. Configure signingKeyFile before production use.' });
  }
  loadSigningKey();
  function signingInfo() {
    return { mode: signing.mode, publicKeyBase64: signing.publicKeyBase64 };
  }
  // ---------- 规范串 v1：stable JSON / 字段校验（见 CANONICAL-SIGNING-V1.md） ----------
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
  // 签名覆盖全部关键字段（DESIGN §4.1；规范串 v1，见 CANONICAL-SIGNING-V1.md §2）：
  // 16 行 \n 连接串，params 只签 stable JSON 的 SHA-256，timeout 取有效超时。
  function envelopeSigningBytes(env) {
    if (env.version !== 1) throw new Error('LEA canonical field invalid: version');
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
    const paramsHash = sha256Hex(stableStringify(env.params || {}));
    return [
      'qfr-lea-envelope-v1',
      String(env.version),
      String(env.request_id),
      env.batch_id || '',
      String(env.seq),
      String(env.device_id),
      String(env.account_id),
      String(env.api_key_id),
      String(env.binding_epoch),
      String(env.nonce),
      String(env.issued_at),
      String(env.expires_at),
      String(env.idempotency_key),
      String(env.command),
      paramsHash,
      String(effectiveTimeoutMs(env)),
    ].join('\n');
  }
  function signEnvelope(env) {
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
    return {
      key_id: k.key_id, prefix: maskKey(k.prefix),
      account_id: k.account_id, device_scope: k.device_scope,
      scopes: k.scopes, status: keyStatus(k),
      created_at: k.created_at, last_used_at: k.last_used_at || null,
      expires_at: k.expires_at || null, binding_epoch: k.binding_epoch,
      grant_epoch: (k.grant_epoch || 0),
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
    // H21：记入本机吊销推送台账（有设备域只推该设备，无设备域推该账号全部已绑设备）。
    try {
      const devs = k.device_scope ? [k.device_scope] : devicesForAccount(k.account_id);
      recordRevocations(devs, [k.key_id], 'key-revoked');
    } catch (e) {}
    return { ok: true, record: keyPublicView(k) };
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
    // H21：记入本机吊销推送台账（该账号全部已绑设备）。
    try { recordRevocations(devicesForAccount(accountId), revokedIds, 'revoke-all'); } catch (e) {}
    return { ok: true, revoked_count: count };
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
    try {
      const activeIds = loadKeys().keys
        .filter((k) => k && k.account_id === String(accountId) && !k.revoked_at)
        .map((k) => k.key_id);
      if (activeIds.length) recordRevocations(devicesForAccount(accountId), activeIds, 'grant-revoked');
    } catch (e) {}
    return { ok: true, grant_epoch: cur.grant_epoch };
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
      // H21：换绑吊销的 Key 同步记入本机吊销推送台账。
      try { recordRevocations([deviceId], revokedKeyIds, 'rebind'); } catch (e) {}
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
  // 第一层控制）。写顺序：先写世代文件、再写 revoked_keys.txt——中途
  // 失败时世代超前于表是安全方向（陈旧推送被拦，新表由下次重推补齐）；
  // 反过来（表超前于世代）会留一个陈旧推送可覆盖新表的窗口。世代文件
  // 用 tmp+rename 写（与 C 侧同范式），不断电写半截；tmp 名带 $PID，
  // 防两路并发推送撞同名。
  // generation 必传：缺失／非安全整数／负数即抛错，绝不发无版本直写。
  function leaRevocationsWriteCmd(b64, generation) {
    if (typeof b64 !== 'string' || !b64) throw new Error('leaRevocationsWriteCmd: b64 required');
    if (!Number.isSafeInteger(generation) || generation < 0) throw new Error('leaRevocationsWriteCmd: generation required');
    const genFile = LEA_REVOKED_PATH.replace(/\.txt$/i, '.gen');
    return 'powershell -NoProfile -NonInteractive -Command "$genFile=\'' + genFile + '\'; $txtFile=\'' + LEA_REVOKED_PATH + '\'; $incoming=' + generation + '; $cur=0; if (Test-Path -LiteralPath $genFile) { $raw=[IO.File]::ReadAllText($genFile).Trim(); if ($raw -match \'^[0-9]+$\') { $cur=[int64]$raw } else { throw \'revoked generation file corrupt\' } }; if ($incoming -lt $cur) { exit 0 }; $tmpGen=$genFile + \'.\' + $PID + \'.tmp\'; [IO.File]::WriteAllText($tmpGen, [string]$incoming); Remove-Item -LiteralPath $genFile -ErrorAction SilentlyContinue; [IO.File]::Move($tmpGen, $genFile); [IO.File]::WriteAllBytes($txtFile,[Convert]::FromBase64String(\'' + b64 + '\'))"';
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
      return { synced: false, reason: 'oversize' };
    }
    try {
      await channel.runCommand(deviceId, leaRevocationsWriteCmd(b64, snap.generation), 15000);
    } catch (e) {
      log({ ev: 'lea-revocation-sync-failed', device_id: deviceId, generation: snap.generation, revocation_epoch: snap.revocation_epoch, err: String(e && e.message) });
      return { synced: false, reason: 'write-failed' };
    }
    markRevocationsPushed(deviceId, snap.generation);
    return { synced: true, reason: 'pushed', generation: snap.generation };
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

  // ---------- 信封组包（DESIGN §4.1；规范串 v1） ----------
  function buildEnvelope(input) {
    const issued = nowSec();
    // params 必须是 JSON 对象（顶层数组／标量即拒绝）：C 端只接受 JSON 对象
    // params_raw，JS 可签、C 拒收的信封不得产生。
    if (input.params != null && (typeof input.params !== 'object' || Array.isArray(input.params))) {
      throw new Error('LEA envelope params must be an object');
    }
    const env = {
      version: 1,
      request_id: input.requestId,
      batch_id: input.batchId || null,
      seq: input.seq || 1,
      device_id: String(input.deviceId),
      account_id: String(input.accountId),
      api_key_id: input.keyId,
      binding_epoch: input.bindingEpoch,
      nonce: crypto.randomBytes(16).toString('base64url'),
      issued_at: issued,
      expires_at: issued + ENVELOPE_TTL_S,
      idempotency_key: input.idempotencyKey,
      command: input.command,
      // params 归一化为键已排序的深拷贝：签名与线上传输用同一份对象，
      // 线上 params 子串即 stable JSON，C 端对原文算哈希才能对上（§2.1）。
      params: normalizeParams(input.params || {}),
      timeout_ms: input.timeoutMs,
    };
    return signEnvelope(env);
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
  async function dispatchEnvelope(channel, env, optsD) {
    optsD = optsD || {};
    // H21：下发前先把本机吊销表推到最新全集（best-effort，不拦本次命令；
    // 同步失败只记日志，下次下发重试；admit 是第一层控制）。
    try { await syncRevocations(channel, env.device_id); } catch (e) { log({ ev: 'lea-revocation-sync-failed', device_id: env.device_id, err: String(e && e.message) }); }
    const spec = COMMANDS[env.command] || { dangerous: false };
    const b64 = Buffer.from(JSON.stringify(env), 'utf8').toString('base64');
    const timeoutMs = optsD.timeoutMs || DISPATCH_TIMEOUT_MS;
    let attempts = 0;
    const maxAttempts = spec.dangerous ? 1 : 2; // 危险命令禁自动重试
    let lastErr = null;
    while (attempts < maxAttempts) {
      attempts++;
      try {
        let out;
        if (b64.length <= ENVELOPE_INLINE_LIMIT) {
          out = await channel.runCommand(env.device_id, leaClientCmd(b64), timeoutMs);
        } else {
          const fn = env.request_id.replace(/[^A-Za-z0-9_-]/g, '_') + '.json';
          await channel.runCommand(env.device_id, leaInboxWriteCmd(fn, b64), timeoutMs);
          out = await channel.runCommand(env.device_id,
            LEA_CLIENT_EXE + ' apply "' + leaInboxPath(fn) + '"', timeoutMs);
        }
        // 回传：stdout 应为一行 JSON；解析失败即视为回传失败，重试 2 次内
        // 仍失败则按 UNKNOWN 返回（不谎称成功，见 dispatch 内 timeout 分支）。
        const parsed = parseClientOutput(out);
        if (parsed.ok) return { ok: true, result: parsed.result, attempts, raw: out };
        lastErr = new Error('bad-client-output');
      } catch (e) {
        lastErr = e;
        if (e && /timeout/i.test(String(e.message || ''))) {
          // 下发超时：不再重试，交由 job 异步（结果 UNKNOWN）。
          return { ok: false, timeout: true, error: e, attempts };
        }
      }
      if (attempts < maxAttempts) await sleep(200);
    }
    return { ok: false, error: lastErr, attempts };
  }
  function parseClientOutput(out) {
    if (typeof out !== 'string') return { ok: false };
    const line = out.trim().split(/\r?\n/).map((s) => s.trim()).filter(Boolean).pop() || '';
    try {
      const v = JSON.parse(line);
      // H15：严格判成功——只认顶层 ok===true 的 JSON 对象。{ok:false}、
      // 非对象、非 JSON 文本一律判失败：此前任意 JSON 对象（含 {ok:false}）
      // 都当成功，handleExecute 随之把 job 记 SUCCEEDED 且顶层回 ok:true。
      if (v && typeof v === 'object' && !Array.isArray(v) && v.ok === true) {
        return { ok: true, result: v };
      }
    } catch (e) {}
    return { ok: false };
  }
  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  return {
    dir, log, audit, pruneAudit, pruneJobs,
    COMMANDS, ERR, KEY_PREFIX, IDEM_NS,
    signingInfo, signEnvelope, verifyEnvelope, envelopeSigningBytes,
    ticketSigningBytes, signTicket, verifyTicket, issueBindingTicket,
    generateKey, revokeKey, revokeAllKeys, listKeys, findKeyById, keyPublicView, keyStatus, maskKey,
    grantMuse, revokeGrant, hasGrant, hasDangerousGrant, getGrant, isWhitelisted, bareNodeId,
    recordBinding, getBinding,
    authenticate, admit, nonceCheck, idemLookup, idemRecord,
    buildEnvelope, dispatchEnvelope, parseClientOutput, leaClientCmd, leaInboxWriteCmd, leaInboxPath,
    createJob, getJob, updateJob, sweepStaleJobs,
    getRevocations, syncRevocations, leaRevocationsWriteCmd,
    // 供路由层/单测的内部状态（不含任何 Key 明文）
    _test: { loadKeys, loadGrants, loadBindings, loadJobs, loadRevocations, nonceSeen, idemSeen, hashKey, maskKey, stableStringify, normalizeParams },
  };
}

module.exports = { createLeaCore, COMMANDS, ERR, KEY_PREFIX, ENVELOPE_TTL_S, TICKET_TTL_S, DISPATCH_TIMEOUT_MS, SYNC_WAIT_MS };
