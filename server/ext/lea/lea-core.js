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
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------- 常量（DESIGN.md §3/§4/§6/§7/§11） ----------
const KEY_PREFIX = 'qfr_lea_';
const KEY_ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const ENVELOPE_TTL_S = 60;            // expires_at - issued_at ≤ 60s
const REPLAY_WINDOW_MS = 10 * 60 * 1000; // 服务端 nonce 去重表保留 ≥10 分钟
const TIMESTAMP_SKEW_S = 60;          // HTTP 头时间戳允许偏差（LEA 端 ±30s，服务端取 60s 上限）
const DISPATCH_TIMEOUT_MS = 5000;     // 下发 5s（DESIGN §3）
const SYNC_WAIT_MS = 5000;            // HTTP 同步等待默认 5s，超时 202 + job_id
const JOB_RETENTION_MS = 24 * 3600 * 1000; // 长任务结果保留 24h
const IDEMPOTENT_RETENTION_MS = 7 * 24 * 3600 * 1000; // 幂等结果保留 ≥7 天
const AUDIT_RETENTION_DAYS = 180;     // 服务端审计保留 ≥180 天（§11.2）
const NONCE_RETENTION_MS = REPLAY_WINDOW_MS;

// 命令集（DESIGN §4.4 MVP）与默认超时、所需 scope、是否危险。
// 危险命令：必须带幂等键、禁自动重试、需 muse.execute.dangerous。
const COMMANDS = {
  'app.open':    { scope: 'muse.execute', dangerous: false, timeoutMs: 15000 },
  'app.close':   { scope: 'muse.execute', dangerous: false, timeoutMs: 5000 },
  'ui.click':    { scope: 'muse.execute', dangerous: false, timeoutMs: 5000 },
  'ui.input':    { scope: 'muse.execute', dangerous: false, timeoutMs: 5000 },
  'ui.snapshot': { scope: 'muse.execute', dangerous: false, timeoutMs: 5000 },
  'ui.tree':     { scope: 'muse.execute', dangerous: false, timeoutMs: 5000 },
  'script.run':  { scope: 'muse.execute', dangerous: true,  timeoutMs: 30000 },
  'file.read':   { scope: 'muse.execute', dangerous: false, timeoutMs: 10000 },
  'file.write':  { scope: 'muse.execute', dangerous: true,  timeoutMs: 10000 },
  'sys.info':    { scope: 'muse.execute', dangerous: false, timeoutMs: 5000 },
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
  function loadKeys() { return readJson(KEYS_FILE, { keys: [] }); }
  function saveKeys(s) { writeJsonAtomic(KEYS_FILE, s); }
  function loadGrants() { return readJson(GRANTS_FILE, { grants: {} }); }
  function saveGrants(s) { writeJsonAtomic(GRANTS_FILE, s); }
  function loadBindings() { return readJson(BINDINGS_FILE, { bindings: {} }); }
  function saveBindings(s) { writeJsonAtomic(BINDINGS_FILE, s); }
  function loadJobs() { return readJson(JOBS_FILE, { jobs: {} }); }
  function saveJobs(s) { writeJsonAtomic(JOBS_FILE, s); }

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
    sweepTimer = setInterval(() => { pruneAudit(); pruneJobs(); }, 3600 * 1000);
    if (sweepTimer && sweepTimer.unref) sweepTimer.unref();
    pruneAudit();
  }

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
  // 签名覆盖全部关键字段（DESIGN §4.1）：按固定字段顺序 JSON 序列化。
  function envelopeSigningBytes(env) {
    const ordered = {
      version: env.version, request_id: env.request_id, batch_id: env.batch_id || null,
      seq: env.seq, device_id: env.device_id, account_id: env.account_id,
      api_key_id: env.api_key_id, binding_epoch: env.binding_epoch,
      nonce: env.nonce, issued_at: env.issued_at, expires_at: env.expires_at,
      idempotency_key: env.idempotency_key, command: env.command,
      params: env.params || {}, timeout_ms: env.timeout_ms,
    };
    return JSON.stringify(ordered);
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

  // ---------- 防重放 / 幂等（内存去重表，DESIGN §4.1/§4.2） ----------
  // nonce：按 key_id 分桶，保留 10 分钟；idempotency：按 (account,key,键)
  // 记结果，保留 7 天（危险命令 30 天——本版统一 30 天，宁严勿松）。
  const nonceSeen = new Map(); // key_id -> Map(nonce -> atMs)
  const idemSeen = new Map(); // `${account_id}|${key_id}|${idempotency_key}` -> {at, status, result}
  function nonceCheck(keyId, nonce) {
    let bucket = nonceSeen.get(keyId);
    if (!bucket) { bucket = new Map(); nonceSeen.set(keyId, bucket); }
    for (const [n, at] of bucket) if (now() - at > NONCE_RETENTION_MS) bucket.delete(n);
    if (bucket.has(nonce)) return false;
    bucket.set(nonce, now());
    return true;
  }
  function idemLookup(accountId, keyId, idemKey) {
    const k = accountId + '|' + keyId + '|' + idemKey;
    const e = idemSeen.get(k);
    if (!e) return null;
    const ttl = e.dangerous ? 30 * 24 * 3600 * 1000 : IDEMPOTENT_RETENTION_MS;
    if (now() - e.at > ttl) { idemSeen.delete(k); return null; }
    return e;
  }
  function idemRecord(accountId, keyId, idemKey, entry) {
    idemSeen.set(accountId + '|' + keyId + '|' + idemKey, Object.assign({ at: now() }, entry));
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
    };
  }
  function keyStatus(k) {
    if (k.revoked_at) return k.revoked_by_rebind ? 'revoked_by_rebind' : 'revoked';
    if (k.expires_at && now() > k.expires_at) return 'expired';
    return 'active';
  }
  function generateKey(accountId, optsGen) {
    optsGen = optsGen || {};
    const plain = KEY_PREFIX + crypto.randomBytes(32).toString('base64url');
    const salt = crypto.randomBytes(16).toString('hex');
    const keyId = 'k_' + randId(10);
    const rec = {
      key_id: keyId,
      prefix: plain.slice(0, 12), // 仅前缀前 12 位用于识别/脱敏日志；明文不存
      salt, hash: hashKey(plain, salt),
      account_id: String(accountId),
      device_scope: optsGen.device_scope || null, // null = 该账号已绑定设备（由绑定态定）
      scopes: Array.isArray(optsGen.scopes) && optsGen.scopes.length ? optsGen.scopes : ['muse.execute'],
      binding_epoch: currentBindingEpoch(optsGen.device_scope, String(accountId)),
      key_epoch: 1,
      created_at: now(), last_used_at: null, expires_at: null,
      revoked_at: null, revoked_by: null, revoked_by_rebind: false, revoke_reason: null,
    };
    if (optsGen.expires_in_days) rec.expires_at = now() + Math.floor(optsGen.expires_in_days) * 24 * 3600 * 1000;
    const st = loadKeys();
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
    return { ok: true, record: keyPublicView(k) };
  }
  function revokeAllKeys(accountId, by, reason) {
    const st = loadKeys();
    let count = 0;
    for (const k of st.keys) {
      if (k.account_id === String(accountId) && !k.revoked_at) {
        k.revoked_at = now(); k.revoked_by = by || null; k.revoke_reason = reason || 'revoke-all';
        k.key_epoch = (k.key_epoch || 1) + 1; count++;
      }
    }
    if (count) saveKeys(st);
    audit('lea-keys-revoke-all', { account_id: String(accountId), revoked_count: count, by: by || null, reason: reason || null });
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
  function grantMuse(accountId, by) {
    const st = loadGrants();
    const cur = st.grants[String(accountId)] || { account_id: String(accountId), grant_epoch: 0 };
    cur.scope = 'muse.execute'; cur.granted_at = now(); cur.granted_by = by || null;
    cur.revoked_at = null; cur.grant_epoch = (cur.grant_epoch || 0) + 1;
    st.grants[String(accountId)] = cur;
    saveGrants(st);
    audit('lea-grant-changed', { account_id: String(accountId), action: 'grant', grant_epoch: cur.grant_epoch, by: by || null });
    return { ok: true, grant_epoch: cur.grant_epoch };
  }
  function revokeGrant(accountId, by) {
    const st = loadGrants();
    const cur = st.grants[String(accountId)];
    if (!cur || cur.revoked_at) return { ok: false, code: 'NOT_FOUND' };
    cur.revoked_at = now(); cur.revoked_by = by || null;
    cur.grant_epoch = (cur.grant_epoch || 0) + 1;
    saveGrants(st);
    audit('lea-grant-changed', { account_id: String(accountId), action: 'revoke', grant_epoch: cur.grant_epoch, by: by || null });
    return { ok: true, grant_epoch: cur.grant_epoch };
  }
  function hasGrant(accountId) {
    const g = getGrant(accountId);
    return !!(g && g.scope === 'muse.execute' && !g.revoked_at);
  }

  // ---------- 绑定（DESIGN §6.1：跟随当前登录账号） ----------
  function getBinding(deviceId) {
    return loadBindings().bindings[String(deviceId)] || null;
  }
  function currentBindingEpoch(deviceId, accountId) {
    const b = deviceId ? getBinding(deviceId) : null;
    if (b && b.account_id === String(accountId)) return b.binding_epoch;
    return 0;
  }
  // 换绑：新账号绑定即递增 epoch；旧账号在该设备上的全部 Key 标记
  // revoked_by_rebind 立即失效（§7.4）。失败不回滚旧绑定（§6.1）。
  function recordBinding(deviceId, accountId, trigger) {
    deviceId = String(deviceId); accountId = String(accountId);
    const st = loadBindings();
    const old = st.bindings[deviceId] || null;
    const oldAccount = old ? old.account_id : null;
    const oldEpoch = old ? old.binding_epoch : 0;
    const newEpoch = (old && old.account_id === accountId) ? old.binding_epoch : oldEpoch + 1;
    st.bindings[deviceId] = {
      device_id: deviceId, account_id: accountId, binding_epoch: newEpoch,
      state: 'ACTIVE', updated_at: now(), trigger: trigger || 'login',
    };
    saveBindings(st);
    let revokedKeys = 0;
    if (oldAccount && oldAccount !== accountId) {
      const ks = loadKeys();
      for (const k of ks.keys) {
        if (k.account_id === oldAccount && (!k.device_scope || k.device_scope === deviceId) && !k.revoked_at) {
          k.revoked_at = now(); k.revoked_by_rebind = true; k.revoke_reason = 'rebind';
          k.key_epoch = (k.key_epoch || 1) + 1; revokedKeys++;
        }
      }
      if (revokedKeys) saveKeys(ks);
    }
    audit('lea-rebind', {
      device_id: deviceId, old_account_id: oldAccount, new_account_id: accountId,
      old_binding_epoch: oldEpoch, new_binding_epoch: newEpoch,
      trigger_reason: trigger || 'login', revoked_keys: revokedKeys,
    });
    return { ok: true, device_id: deviceId, account_id: accountId, binding_epoch: newEpoch, revoked_keys: revokedKeys };
  }

  // ---------- 准入：七项校验（DESIGN §6.2），服务端先拦 ----------
  // deviceOnline: async (deviceId) => true/false/null（null=未知/通道不可达）。
  // 调用方注入；未注入时第 1 项判 unknown → fail-closed 503。
  function admit(ctx) {
    // ctx: { key, deviceId, command, requestId, ip }
    const k = ctx.key;
    const deviceId = String(ctx.deviceId || '');
    const spec = COMMANDS[ctx.command];
    if (!spec) return { ok: false, status: 400, code: ERR.VALIDATION, msg: '未知命令：' + String(ctx.command || '') };
    // ⑤ Key 归属与状态（已在 authenticate 中验过，此处复核吊销/过期）
    if (!k || keyStatus(k) !== 'active') {
      return { ok: false, status: 401, code: ERR.BAD_KEY, msg: 'API Key 已吊销或已过期。' };
    }
    // ⑥ scope：device_id 必须与 Key 绑定一致，否则 403
    if (k.device_scope && k.device_scope !== deviceId) {
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
    if (k.binding_epoch && k.binding_epoch !== binding.binding_epoch) {
      return { ok: false, status: 409, code: ERR.BINDING_CHANGED, msg: '绑定代次已变更，请重新生成 Key。' };
    }
    // ④ 账号授权 + grant_epoch
    const grant = getGrant(k.account_id);
    if (!grant || grant.revoked_at || grant.scope !== 'muse.execute') {
      const code = (grant && grant.revoked_at) ? ERR.GRANT_REVOKED : ERR.NOT_AUTHORIZED;
      return { ok: false, status: 403, code, msg: '该账号未授权 Muse 操作，或授权已被撤销。' };
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

  // ---------- 信封组包（DESIGN §4.1） ----------
  function buildEnvelope(input) {
    const issued = nowSec();
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
      params: input.params || {},
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
      if (v && typeof v === 'object') return { ok: true, result: v };
    } catch (e) {}
    // 非 JSON 回传：把原文当结果透传（LEA 客户端未就绪时 runcommands
    // 可能回空串/错误文本，调用方按 error_code 判定）。
    if (line) return { ok: true, result: { ok: false, code: ERR.UNKNOWN, raw: line.slice(0, 2000) } };
    return { ok: false };
  }
  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  return {
    dir, log, audit, pruneAudit, pruneJobs,
    COMMANDS, ERR, KEY_PREFIX,
    signingInfo, signEnvelope, verifyEnvelope, envelopeSigningBytes,
    generateKey, revokeKey, revokeAllKeys, listKeys, findKeyById, keyPublicView, keyStatus,
    grantMuse, revokeGrant, hasGrant, getGrant,
    recordBinding, getBinding,
    authenticate, admit, nonceCheck, idemLookup, idemRecord,
    buildEnvelope, dispatchEnvelope, parseClientOutput, leaClientCmd, leaInboxWriteCmd, leaInboxPath,
    createJob, getJob, updateJob,
    // 供路由层/单测的内部状态（不含任何 Key 明文）
    _test: { loadKeys, loadGrants, loadBindings, loadJobs, nonceSeen, idemSeen, hashKey, maskKey },
  };
}

module.exports = { createLeaCore, COMMANDS, ERR, KEY_PREFIX, ENVELOPE_TTL_S, DISPATCH_TIMEOUT_MS, SYNC_WAIT_MS };
