'use strict';
/*
 * QFRemote 隐私锁 · 信封组包/签名（与组件 Go 验签逐字对齐，契约 CONTRACT.md 第 2 节）
 *
 * SigningBytes = Go json.Marshal(signingPayload)：
 *   字段顺序 v,id,op,nodeId,by,review(空略),issuedAt,expiresAt,pwEnc(空略),nonce
 *   时间 = Go time.Time 的 JSON 形式（RFC3339Nano，UTC，尾随零裁剪）
 *   字符串转义 = Go encoding/json（<>& 转 \u003c \u003e \u0026，控制字符常规转义）
 * 签名 = Ed25519(SigningBytes)，调度私钥文件为 Base64(64B 私钥 seed||pub)。
 * pwEnc = Base64(RSA-OAEP-SHA256(一次性密码明文))，公钥取自组件 status.json 的 devicePublicKey(SPKI PEM)。
 */
const crypto = require('crypto');

const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

function goTimeFormat(d) {
  const p2 = (n) => String(n).padStart(2, '0');
  let s = d.getUTCFullYear() + '-' + p2(d.getUTCMonth() + 1) + '-' + p2(d.getUTCDate()) +
    'T' + p2(d.getUTCHours()) + ':' + p2(d.getUTCMinutes()) + ':' + p2(d.getUTCSeconds());
  const ms = d.getUTCMilliseconds();
  if (ms !== 0) {
    let frac = String(ms).padStart(3, '0');
    while (frac.endsWith('0')) frac = frac.slice(0, -1);
    s += '.' + frac;
  }
  return s + 'Z';
}

// Go encoding/json 的字符串转义
function goJsonString(str) {
  let out = '"';
  for (const ch of String(str)) {
    const cp = ch.codePointAt(0);
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (ch === '<') out += '\\u003c';
    else if (ch === '>') out += '\\u003e';
    else if (ch === '&') out += '\\u0026';
    else if (cp === 0x2028) out += '\\u2028';
    else if (cp === 0x2029) out += '\\u2029';
    else if (cp < 0x20) out += '\\u' + cp.toString(16).padStart(4, '0');
    else out += ch;
  }
  return out + '"';
}

function signingBytes(env) {
  let s = '{"v":1';
  s += ',"id":' + goJsonString(env.id);
  s += ',"op":' + goJsonString(env.op);
  s += ',"nodeId":' + goJsonString(env.nodeId);
  s += ',"by":' + goJsonString(env.by);
  if (env.review) s += ',"review":' + goJsonString(env.review);
  s += ',"issuedAt":' + goJsonString(env.issuedAt);
  s += ',"expiresAt":' + goJsonString(env.expiresAt);
  if (env.pwEnc) s += ',"pwEnc":' + goJsonString(env.pwEnc);
  if (env.update) {
    // 与 Go 侧 signingPayload 的字段顺序逐字一致：update 在 pwEnc 后、nonce 前，
    // 内层顺序 version,url,sha256（Go 结构体声明序）。组件端有同字面量测试钉死。
    s += ',"update":{"version":' + goJsonString(env.update.version) +
      ',"url":' + goJsonString(env.update.url) +
      ',"sha256":' + goJsonString(env.update.sha256) + '}';
  }
  s += ',"nonce":' + goJsonString(env.nonce);
  return s + '}';
}

function loadDispatcherKey(keyFileContentBase64) {
  const raw = Buffer.from(String(keyFileContentBase64).trim(), 'base64');
  if (raw.length !== 64) throw new Error('调度私钥格式不对（应为 Base64 的 64 字节 Ed25519 私钥）');
  const der = Buffer.concat([ED25519_PKCS8_PREFIX, raw.subarray(0, 32)]);
  return crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
}

function dispatcherPublicBase64(keyFileContentBase64) {
  const raw = Buffer.from(String(keyFileContentBase64).trim(), 'base64');
  if (raw.length !== 64) throw new Error('调度私钥格式不对');
  return raw.subarray(32).toString('base64');
}

function encryptPassword(devicePublicKeyPem, password) {
  const ct = crypto.publicEncrypt(
    { key: devicePublicKeyPem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    Buffer.from(String(password), 'utf8')
  );
  return ct.toString('base64');
}

/*
 * 组一份信封并签名。
 * opts: { op:'arm'|'disarm'|'reset'|'update', nodeId, by, password?(arm/reset 必填),
 *         devicePublicKeyPem?(arm/reset 必填), review?, now?(Date), ttlMs?,
 *         update?{version,url,sha256}(update 必填) }
 * 返回完整信封对象（可直接 JSON.stringify 投递）。
 */
function buildEnvelope(dispatcherKeyObj, opts) {
  const now = opts.now || new Date();
  const ttl = opts.ttlMs != null ? opts.ttlMs : ((opts.op === 'disarm' || opts.op === 'update') ? 30 * 60 * 1000 : 10 * 60 * 1000);
  const env = {
    v: 1,
    id: 'env-' + crypto.randomBytes(8).toString('hex'),
    op: opts.op,
    nodeId: opts.nodeId,
    by: opts.by,
  };
  if (opts.review) env.review = opts.review;
  env.issuedAt = goTimeFormat(now);
  env.expiresAt = goTimeFormat(new Date(now.getTime() + ttl));
  if (opts.op === 'update') {
    const u = opts.update || {};
    if (typeof u.version !== 'string' || !u.version || typeof u.url !== 'string' || !u.url ||
        typeof u.sha256 !== 'string' || !/^[0-9a-fA-F]{64}$/.test(u.sha256)) {
      throw new Error('update 需要 version/url/sha256(64 位十六进制)');
    }
    env.update = { version: u.version, url: u.url, sha256: u.sha256 };
  }
  if (opts.op === 'arm' || opts.op === 'reset') {
    if (!opts.devicePublicKeyPem) throw new Error('arm/reset 需要设备公钥');
    if (typeof opts.password !== 'string' || opts.password.length === 0) throw new Error('arm/reset 需要一次性密码');
    env.pwEnc = encryptPassword(opts.devicePublicKeyPem, opts.password);
  }
  env.nonce = crypto.randomBytes(16).toString('base64');
  env.sig = crypto.sign(null, Buffer.from(signingBytes(env), 'utf8'), dispatcherKeyObj).toString('base64');
  return env;
}

// 与组件 Go 侧 CompareVersions 同规则：点分十进制，格式不对返回 null。
function compareVersions(a, b) {
  const pa = parseVer(a), pb = parseVer(b);
  if (!pa || !pb) return null;
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}
function parseVer(s) {
  if (typeof s !== 'string' || !s) return null;
  const out = [];
  for (const p of s.split('.')) {
    if (!/^\d+$/.test(p)) return null;
    out.push(parseInt(p, 10));
  }
  return out;
}

// 与组件 Go 侧 AllowedUpdateURL 同规则（桥侧预检，组件端还会再验一次）：
// 本站登记的服务器就是 54.248.9.192:8443，Go 侧两条规则（直连来源任意
// 路径 / 登记地址 + /dl/ 前缀）在此合并为一条：https + 该主机端口。
function allowedUpdateUrl(raw) {
  let u;
  try { u = new URL(raw); } catch (e) { return false; }
  if (u.protocol !== 'https:' || u.username || u.password) return false;
  return u.hostname === '54.248.9.192' && u.port === '8443';
}

module.exports = { buildEnvelope, loadDispatcherKey, dispatcherPublicBase64, signingBytes, goTimeFormat, goJsonString, encryptPassword, compareVersions, allowedUpdateUrl };
