'use strict';
/*
 * QFRemote 统一诊断事件（S-083 服务端落地；与 S-134 同方案 P2-05）
 * ================================================================
 * 统一事件结构（第三份审查 P2-05）：一次启动／登录／连接须能跨端追踪，
 * 但事件里严禁出现密码、完整 cookie、API Key、私钥与输入内容。
 *
 * 字段（全部可选，缺失填 null，不编造）：
 *   timestamp     ISO-8601（服务端生成，客户端传来的值只作参考）
 *   app_version   应用版本，如 '3.0.0'
 *   platform      'win32' | 'android' | 'web' | 'server'
 *   build_sha     构建 commit 短哈希
 *   trace_id      跨端追踪 id（请求头 X-QFR-Request-Id 或随机）
 *   session_id    会话 id——只存 SHA-256 前 16 位指纹，永不存原文
 *   stage         阶段，如 'startup' | 'login' | 'connect' | 'execute'
 *   error_code    稳定错误码，如 'QFR_RATE_LIMITED'，无错误为 null
 *   retry_attempt 重试次数（整数 ≥0）
 *   duration_ms   耗时毫秒（整数 ≥0）
 *   network_type  'wifi' | 'cellular' | 'ethernet' | 'unknown'
 *   renderer_state 渲染进程状态，如 'ok' | 'gone' | 'not-ready'
 *   device_state  设备状态，如 'online' | 'offline' | 'unknown'
 *
 * 红线（S-083/S-134 共用）：以下键一律丢弃，永不进事件、日志、审计：
 *   password / passwd / pwd / cookie / api_key / apikey / secret /
 *   private_key / privatekey / authorization / token（完整值）/
 *   input / content / plaintext / cipher（内容原文）。
 *   例外：key_id、key_prefix（脱敏前缀指纹）、trace_id、session 指纹
 *   可以进——它们是身份引用，不是秘密本身。
 * 本模块不读任何密钥文件、不发任何网络请求；纯函数，可单测。
 */
const crypto = require('crypto');

// 严禁进事件的键（小写比对；命中即整键丢弃，不留值、不留掩码占位以外的信息）。
// 唯一正本：server/ext/lea/forbidden-keys.js（U6；lea-core.js 回退路径共用同一份）。
const FORBIDDEN_KEYS = new Set(require('./lea/forbidden-keys').FORBIDDEN_KEYS);

// 允许进事件的键白名单（P2-05 字段＋审计常用身份引用）。白名单之外
// 的键一律丢弃——默认拒绝，未知字段不得借诊断通道外泄。
const ALLOWED_KEYS = new Set([
  'timestamp', 'app_version', 'platform', 'build_sha', 'trace_id',
  'request_id', 'session_id', 'stage', 'error_code', 'retry_attempt',
  'duration_ms', 'network_type', 'renderer_state', 'device_state',
  'ev', 'event', 'result', 'account_id', 'device_id', 'api_key_id',
  'key_prefix', 'binding_epoch', 'grant_epoch', 'command', 'job_id',
  'batch_id', 'report_id', 'bytes', 'ip', 'user', 'at', 'reason',
  'status', 'code', 'msg', 'note',
]);

const MAX_STRING_LEN = 512;

function sha256Hex(s) {
  return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
}

// session_id 脱敏：只留 SHA-256 前 16 位指纹；空值回 null。
function hashSessionId(sessionId) {
  if (sessionId === undefined || sessionId === null || sessionId === '') return null;
  return sha256Hex(sessionId).slice(0, 16);
}

// 清洗一个事件对象：白名单过滤＋禁键丢弃＋字符串截断＋类型归一。
// 返回新对象，不改入参；禁键与白名单外键静默丢弃（不记日志，防日志成泄漏通道）。
function scrubDiagnosticEvent(fields) {
  const out = {};
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return out;
  for (const k of Object.keys(fields)) {
    const lk = String(k).toLowerCase();
    if (FORBIDDEN_KEYS.has(lk)) continue;
    if (!ALLOWED_KEYS.has(lk)) continue;
    let v = fields[k];
    if (v === undefined) continue;
    if (v === null) { out[lk] = null; continue; }
    if (typeof v === 'string') {
      if (v.length > MAX_STRING_LEN) v = v.slice(0, MAX_STRING_LEN);
      out[lk] = v;
      continue;
    }
    if (typeof v === 'number' || typeof v === 'boolean') { out[lk] = v; continue; }
    // 其余类型（对象／数组）不进事件——诊断事件只含标量。
  }
  return out;
}

// 只做禁键过滤（审计等内部通道用）：丢弃 FORBIDDEN_KEYS 命中的键，
// 其余键原样保留——与 scrubDiagnosticEvent（白名单）不同，后者只用于
// 对外诊断事件；审计字段名各异，不能用白名单收。
function scrubForbiddenKeys(fields) {
  const out = {};
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return out;
  for (const k of Object.keys(fields)) {
    if (FORBIDDEN_KEYS.has(String(k).toLowerCase())) continue;
    out[k] = fields[k];
  }
  return out;
}

// 构造一个标准诊断事件：补 timestamp，session_id 指纹化，再过清洗。
function buildDiagnosticEvent(fields) {
  const base = Object.assign({}, fields || {});
  if (!base.timestamp) base.timestamp = new Date().toISOString();
  if (base.session_id !== undefined && base.session_id !== null && base.session_id !== '') {
    base.session_id = hashSessionId(base.session_id);
  }
  const ev = scrubDiagnosticEvent(base);
  if (!ev.timestamp) ev.timestamp = new Date().toISOString();
  return ev;
}

module.exports = {
  FORBIDDEN_KEYS,
  ALLOWED_KEYS,
  MAX_STRING_LEN,
  hashSessionId,
  scrubForbiddenKeys,
  scrubDiagnosticEvent,
  buildDiagnosticEvent,
};
