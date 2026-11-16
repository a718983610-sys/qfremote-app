'use strict';
/*
 * QFRemote Windows 运行端 — RC-04 票据恢复层（3.0.0）
 * =====================================================
 * 依据：L1 票据规范 server/ext/lea/RC-04-RECONNECT-TICKET-SPEC.md
 * （规范 v1，2026-11-15）。本模块只实现规范 §1（票据形状校验）、
 * §2（有效期）、§5.1（申领／滚动续领／内存存储）、§5.2（恢复流程
 * 的客户端侧：凭票据 resume、失败分类）——不发明票据格式，不验
 * Ed25519 签名（签名核验在服务端核验时做，§3.2 第 2 步；设备端
 * 只认签名信封，§4 补充）。
 *
 * 存储口径（规范 §1.1）：票据只存内存（本模块闭包变量），永不写进
 * 可同步的配置文件（不进 qf-settings.json / 账号设置）、永不随诊断
 * 日志外发；日志只记 resume_id 前 8 位 hex 与 api_key_id
 * （describeForLog），绝不记票据全文与 ticket_signature。
 *
 * 生命周期：
 *   登录成功 → startSession()（新 session_id：sess- + 16 位 hex，
 *     §1）→ issue() 申领一张票据 → 到期前 60 秒滚动续领（§5.1；
 *     新票据到手即替换内存旧票据，旧票据作废是服务端 §3.1 的事，
 *     客户端只认最新一张）。
 *   掉线 → watchdog 的 onBeforeReconnect 调 attemptResume()：
 *     无可用票据时先试领一张，再凭票据 POST /resume；成功即消费
 *     （内存票据立即丢弃，单次性 §3.2），失败按 §5.2 分类——凭据类
 *     立即停（丢弃票据、不再试），纯网络错误保留票据、走原有点
 *     “连接”按钮的重连循环；端点 404（服务端 §7 后续项尚未实现）
 *     视为 unavailable，不丢票据、不停手，只走点击重连。
 *   登出／强制下线 → stopSession()：票据、session_id、续领定时器
 *     全部清掉（票据不跨账号、不跨登录会话复用）。
 *
 * 与重试策略的接线（reconnect-policy.js）：重试上限 5 次、间隔 ≥5 秒、
 * 退避 5s→10s→20s→30s 封顶、凭据类立即停——全部仍由 watchdog +
 * reconnect-policy.js 管；本模块只在每次重试点击前做一次票据恢复
 * 尝试并回报 verdict（proceed / stop），不自己数重试次数、不自己
 * 退避。票据恢复成功后桌面会话仍须点“连接”按钮重连（画面恢复由
 * 渲染层处理，规范 §7）；恢复成功后由调用方经 onRecovered 续领
 * 新票据。
 *
 * 输入短路（规范 §5.1/§5.2）：Electron 外壳不向页面注入鼠标/按键/
 * 剪贴板输入，唯一动作就是点“连接”按钮本身，故无输入队列可丢弃、
 * 无补发风险；本模块不缓存任何输入。
 *
 * 设备 id 归一（联调互操作，2026-11-15）：调用方可能传全形 node//…
 * （MeshCentral 原始 _id 等），服务端按规范 §1 只返裸形；申领请求发
 * 裸形、回票按裸形比对，全形与裸形视为同一设备（bareNodeId，与
 * devices.js／服务端 lea-core.js 同口径，只去一层 node// 前缀）。
 *
 * 规范含糊处（按字面做，见收尾报告，不悄悄改规范）：
 *   (a) §5.1 称续领“只留最新”，§3.1 第 3 条称同 session 最多 3 张、
 *       超了删最旧——客户端按 §3.1 理解：只认内存最新一张，不替
 *       服务端决定旧票据命运；
 *   (b) §1 称“同一 session_id 在票据过期/消费后不得凭另一张票据
 *       恢复”，§3.3/§5.1 又允许凭仍在效的 Key 重新签发——客户端
 *       按 §5.1 滚动续领（恢复成功后为同一 session_id 再领一张），
 *       若服务端拒绝签发，issue 失败即无票据、退回点击重连；
 *   (c) §5.2 建议重连“5 秒固定间隔，不做指数退避”，而 L3 已落地的
 *       reconnect-policy.js 为 5s→30s 退避——任务书定按已有策略
 *       接线，退避不变（最坏 5+10+20+30+30=95 秒仍在 300 秒票据
 *       窗口内）。
 */
const crypto = require('crypto');
const policy = require('./reconnect-policy');

const TICKET_TTL_S = 300; // 规范 §2：写死 300 秒，客户端不得指定 TTL
const ROLL_LEAD_S = 60; // 到期前 60 秒滚动续领
const MIN_ISSUE_INTERVAL_MS = 5000; // 规范 §3.1 第 3 条：同设备签发最小间隔 5 秒
const ROLL_RETRY_MS = 30000; // 滚动续领遇网络失败时的重试间隔
const ISSUE_PATH = '/api/lea/v1/reconnect/issue';
const RESUME_PATH = '/api/lea/v1/reconnect/resume';

// 规范 §1 票据字段（10 个，缺一不可；顶层未知字段一律拒绝）。
const TICKET_FIELDS = [
  'account_id', 'device_id', 'api_key_id', 'binding_epoch', 'grant_epoch',
  'resume_id', 'session_id', 'issued_at', 'expires_at', 'ticket_signature'
];
const ID_RE = /^[^\x00-\x1f\x7f]{1,127}$/; // §1：非空、1..127 字节、无控制字符（按字符计，ASCII id 等价）
const API_KEY_ID_RE = /^k_[a-z0-9]{10}$/; // lea-core.js：'k_' + randId(10)，字母表 [a-z0-9]
const RESUME_ID_RE = /^resume-[0-9a-f]{16}$/;
const SESSION_ID_RE = /^sess-[0-9a-f]{16}$/;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

function hasControlChars(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

// 设备 id 归一（与 windows/devices.js bareNodeId、服务端 lea-core.js
// bareNodeId 同口径）：只去一层 `node//` 前缀；非字符串返回 ''。
// 规范 §1 票据 device_id 只用裸形；调用方可能传全形（MeshCentral 原始
// _id、模型 d.fullId、console-preload deviceInfo 的 node//… 形），全形
// 与裸形视为同一设备：申领请求发裸形、回票比对按裸形比。
function bareNodeId(id) {
  const s = typeof id === 'string' ? id : '';
  return s.replace(/^node\/\//, '');
}

// 票据形状校验（规范 §1／§1.2，纯函数）。只做形状：字段齐全、类型正确、
// 未知字段拒绝、格式与 TTL 恰好 300 秒。签名本身不验（服务端核验）。
// 返回 { ok: true } 或 { ok: false, reason }。
function validateTicket(t) {
  if (!t || typeof t !== 'object' || Array.isArray(t)) return { ok: false, reason: 'not-object' };
  const keys = Object.keys(t);
  for (const k of keys) {
    if (TICKET_FIELDS.indexOf(k) < 0) return { ok: false, reason: 'unknown-field:' + k };
  }
  for (const f of TICKET_FIELDS) {
    if (t[f] === undefined || t[f] === null) return { ok: false, reason: 'missing:' + f };
  }
  if (typeof t.account_id !== 'string' || Buffer.byteLength(t.account_id, 'utf8') < 1 ||
      Buffer.byteLength(t.account_id, 'utf8') > 127 || hasControlChars(t.account_id)) {
    return { ok: false, reason: 'bad-account_id' };
  }
  if (typeof t.device_id !== 'string' || Buffer.byteLength(t.device_id, 'utf8') < 1 ||
      Buffer.byteLength(t.device_id, 'utf8') > 127 || hasControlChars(t.device_id)) {
    return { ok: false, reason: 'bad-device_id' };
  }
  if (typeof t.api_key_id !== 'string' || !API_KEY_ID_RE.test(t.api_key_id)) {
    return { ok: false, reason: 'bad-api_key_id' };
  }
  if (!Number.isSafeInteger(t.binding_epoch) || t.binding_epoch < 0) return { ok: false, reason: 'bad-binding_epoch' };
  if (!Number.isSafeInteger(t.grant_epoch) || t.grant_epoch < 0) return { ok: false, reason: 'bad-grant_epoch' };
  if (typeof t.resume_id !== 'string' || !RESUME_ID_RE.test(t.resume_id)) return { ok: false, reason: 'bad-resume_id' };
  if (typeof t.session_id !== 'string' || !SESSION_ID_RE.test(t.session_id)) return { ok: false, reason: 'bad-session_id' };
  if (!Number.isSafeInteger(t.issued_at) || !Number.isSafeInteger(t.expires_at)) return { ok: false, reason: 'bad-time' };
  if (t.expires_at - t.issued_at !== TICKET_TTL_S) return { ok: false, reason: 'bad-ttl' };
  if (typeof t.ticket_signature !== 'string' || !t.ticket_signature ||
      !BASE64_RE.test(t.ticket_signature)) {
    return { ok: false, reason: 'bad-signature' };
  }
  let sigBytes = null;
  try { sigBytes = Buffer.from(t.ticket_signature, 'base64'); } catch (e) { sigBytes = null; }
  // Ed25519 签名恒为 64 字节；base64 解不出 64 字节即不是合法票据签名。
  if (!sigBytes || sigBytes.length !== 64) return { ok: false, reason: 'bad-signature-length' };
  return { ok: true };
}

function newSessionId(randomBytes) {
  return 'sess-' + Buffer.from(randomBytes(8)).toString('hex');
}

// 服务端错误体 { ok:false, code, msg }（lea-routes.js fail()）取码。
function errorCodeOf(json) {
  if (json && typeof json.code === 'string' && json.code) return json.code;
  return '';
}

function createReconnectTicketStore(opts) {
  const o = opts || {};
  // request(method, url, bodyObj) -> Promise<{ status, json, text }>。
  // main.js 传入 extRequest 的包装（带控制台会话 cookie，见 §3.3：
  // /issue 接受 Bearer Key 或有效控制台会话；/resume 以票据本身为
  // bearer，body 即票据 JSON 全文）。
  if (typeof o.request !== 'function') throw new Error('reconnect-ticket: request 注入缺失');
  if (typeof o.baseUrl !== 'string' || !o.baseUrl) throw new Error('reconnect-ticket: baseUrl 缺失');
  const request = o.request;
  const baseUrl = String(o.baseUrl).replace(/\/+$/, '');
  const nowSec = typeof o.nowSec === 'function' ? o.nowSec : () => Math.floor(Date.now() / 1000);
  const nowMs = typeof o.nowMs === 'function' ? o.nowMs : Date.now;
  const randomBytes = typeof o.randomBytes === 'function' ? o.randomBytes : crypto.randomBytes;
  const log = typeof o.log === 'function' ? o.log : () => {};
  const timer = o.timer || { setTimeout: setTimeout, clearTimeout: clearTimeout };

  let ticket = null; // 内存唯一持有处，永不落盘、不进日志
  let sessionId = null;
  let deviceId = null;
  let rollTimer = null;
  let lastIssueAtMs = 0;
  let issuing = false;

  function clearRollTimer() {
    if (rollTimer !== null) {
      try { timer.clearTimeout(rollTimer); } catch (e) { /* ignore */ }
      rollTimer = null;
    }
  }

  function dropTicket(reason) {
    ticket = null;
    clearRollTimer();
    if (reason) log('ticket.drop ' + reason);
  }

  // 续领定时：到期前 ROLL_LEAD_S 秒；已进入窗口则尽快（仍受 5 秒最小间隔约束）。
  function msUntilRoll() {
    if (!ticket) return -1;
    return Math.max(0, (ticket.expires_at - ROLL_LEAD_S - nowSec()) * 1000);
  }

  function scheduleRoll() {
    clearRollTimer();
    if (!ticket || !deviceId) return;
    const ms = msUntilRoll();
    rollTimer = timer.setTimeout(() => {
      rollTimer = null;
      rollIssue().catch(() => {});
    }, ms);
    if (rollTimer && typeof rollTimer.unref === 'function') { try { rollTimer.unref(); } catch (e) { /* ignore */ } }
  }

  // 滚动续领：失败凭据类 → 丢票据、停滚（会话继续走点击重连）；
  // 网络失败 → 30 秒后重试一次（仍在到期前才有意义，否则停滚）。
  async function rollIssue() {
    if (!ticket || !deviceId) return { ok: false, kind: 'no-ticket' };
    const r = await issue({ deviceId });
    if (r.ok) return r;
    if (r.kind === 'network' || r.kind === 'unavailable' || r.kind === 'unknown') {
      if (ticket && (ticket.expires_at - nowSec()) > ROLL_LEAD_S + 5) {
        rollTimer = timer.setTimeout(() => { rollTimer = null; rollIssue().catch(() => {}); }, ROLL_RETRY_MS);
        if (rollTimer && typeof rollTimer.unref === 'function') { try { rollTimer.unref(); } catch (e) { /* ignore */ } }
      }
    }
    return r;
  }

  function startSession() {
    dropTicket('new-session');
    sessionId = newSessionId(randomBytes);
    deviceId = null;
    lastIssueAtMs = 0;
    return sessionId;
  }

  function stopSession(reason) {
    dropTicket(reason || 'session-end');
    sessionId = null;
    deviceId = null;
    lastIssueAtMs = 0;
  }

  function hasUsableTicket() {
    return !!ticket && nowSec() <= ticket.expires_at;
  }

  function getTicketInfo() {
    if (!ticket) return null;
    return {
      sessionId: ticket.session_id,
      deviceId: ticket.device_id,
      apiKeyId: ticket.api_key_id,
      resumePrefix: String(ticket.resume_id).slice(7, 15), // 前 8 位 hex，供日志
      issuedAt: ticket.issued_at,
      expiresAt: ticket.expires_at
    };
  }

  // 可进日志的安全描述：只有 resume_id 前 8 位与 api_key_id，永无票据全文/签名。
  function describeForLog() {
    const info = getTicketInfo();
    if (!info) return 'no-ticket';
    return 'resume=' + info.resumePrefix + ' key=' + info.apiKeyId + ' exp=' + info.expiresAt;
  }

  async function issue(args) {
    const a = args || {};
    const did = typeof a.deviceId === 'string' ? a.deviceId : deviceId;
    if (!sessionId) return { ok: false, kind: 'no-session' };
    if (!did) return { ok: false, kind: 'bad-args' };
    // 裸形归一：全形 node//… 与裸形视为同一设备（规范 §1 票据只用裸形；
    // 服务端 issueReconnectTicket 同样先 bareNodeId 再签发，故请求体发
    // 裸形、回票按裸形比——全形传入不再误判 session-or-device-mismatch）。
    const bareDid = bareNodeId(did);
    if (!bareDid) return { ok: false, kind: 'bad-args' };
    if (issuing) return { ok: false, kind: 'busy' };
    const nowMsVal = nowMs();
    if (nowMsVal - lastIssueAtMs < MIN_ISSUE_INTERVAL_MS) return { ok: false, kind: 'rate-limited' };
    issuing = true;
    try {
      // F-WIN-08（2026-11-15）：签发窗口只在服务端收到请求后才消耗。
      // 旧代码在请求发出前即置位，网络失败后 5 秒内再 issue() 会被挡
      // 一次（服务端根本没收到、没签发）。收到任何响应后再记时间戳。
      deviceId = bareDid;
      let res;
      try {
        res = await request('POST', baseUrl + ISSUE_PATH, { device_id: bareDid, session_id: sessionId });
      } catch (e) {
        return { ok: false, kind: 'network' };
      }
      lastIssueAtMs = nowMs();
      const status = (res && typeof res.status === 'number') ? res.status : 0;
      const json = (res && res.json) || null;
      if (status === 200 && json) {
        const v = validateTicket(json);
        if (!v.ok) {
          // 200 但票据形状非法：按 fail-closed 丢弃，不存、不认。
          dropTicket('issue-invalid-ticket:' + v.reason);
          log('ticket.issue-invalid ' + v.reason);
          return { ok: false, kind: 'credential', code: 'QFR_TICKET_INVALID', reason: v.reason };
        }
        if (json.session_id !== sessionId || bareNodeId(json.device_id) !== bareDid) {
          dropTicket('issue-mismatch');
          return { ok: false, kind: 'credential', code: 'QFR_TICKET_INVALID', reason: 'session-or-device-mismatch' };
        }
        ticket = json;
        scheduleRoll();
        log('ticket.issued ' + describeForLog());
        return { ok: true, kind: 'ok', info: getTicketInfo() };
      }
      const kind = policy.classifyTicketFailure(status, errorCodeOf(json));
      const code = errorCodeOf(json);
      if (kind === 'credential') dropTicket('issue-credential:' + (code || status));
      return { ok: false, kind, code: code || undefined, status };
    } finally {
      issuing = false;
    }
  }

  async function ensureTicket(args) {
    if (hasUsableTicket()) return { ok: true, kind: 'ok', reused: true, info: getTicketInfo() };
    return issue(args);
  }

  async function resume() {
    if (!ticket) return { ok: false, kind: 'no-ticket' };
    if (nowSec() > ticket.expires_at) {
      // 本地已过期（§2：now > expires_at 即过期）：不发请求，直接按
      // QFR_TICKET_EXPIRED 走完整登录（§5.3-5），票据丢弃。
      dropTicket('resume-local-expired');
      return { ok: false, kind: 'credential', code: 'QFR_TICKET_EXPIRED', local: true };
    }
    const sending = ticket;
    let res;
    try {
      // body 即票据 JSON 全文（§3.3：不走 Bearer，票据本身就是 bearer）。
      res = await request('POST', baseUrl + RESUME_PATH, sending);
    } catch (e) {
      return { ok: false, kind: 'network' };
    }
    const status = (res && typeof res.status === 'number') ? res.status : 0;
    const json = (res && res.json) || null;
    if (status === 200 && json && json.ok === true) {
      if (typeof json.session_id !== 'string' || json.session_id !== sessionId) {
        dropTicket('resume-session-mismatch');
        return { ok: false, kind: 'credential', code: 'QFR_TICKET_INVALID', reason: 'session-mismatch' };
      }
      // 单次性（§3.2）：服务端已消费，内存票据立即丢弃，永不重发。
      const out = {
        ok: true, kind: 'ok',
        sessionId: json.session_id, deviceId: json.device_id,
        bindingEpoch: json.binding_epoch, grantEpoch: json.grant_epoch
      };
      dropTicket('resume-consumed');
      log('ticket.resumed session=' + out.sessionId);
      return out;
    }
    const kind = policy.classifyTicketFailure(status, errorCodeOf(json));
    const code = errorCodeOf(json);
    if (kind === 'credential') {
      // 终态失败（过期/已消费/epochs 不等/吊销）：重试同样失败（§3.2），
      // 丢弃票据，调用方立即停手、不再试。
      dropTicket('resume-credential:' + (code || status));
    }
    // network / unavailable / unknown：票据未被消费，保留给下一次尝试。
    return { ok: false, kind, code: code || undefined, status };
  }

  // watchdog onBeforeReconnect 的一次调用：无可用票据时先试领一张
  // （console 会话仍在时可领），再凭票据恢复。返回 outcome：
  //   { ok:true } —— 恢复成功，调用方继续点“连接”按钮；
  //   { ok:false, kind:'credential', code } —— 凭据类，调用方立即停；
  //   { ok:false, kind } —— 其余（no-ticket/network/unavailable/
  //   unknown/rate-limited/busy），调用方走原有点按钮重连，不停手。
  async function attemptResume(args) {
    const a = args || {};
    if (!hasUsableTicket()) {
      const ensured = await ensureTicket({ deviceId: a.deviceId });
      if (!ensured.ok) {
        if (ensured.kind === 'credential') return { ok: false, kind: 'credential', code: ensured.code };
        return { ok: false, kind: ensured.kind, code: ensured.code };
      }
    }
    return resume();
  }

  return {
    startSession,
    stopSession,
    getSessionId: () => sessionId,
    hasUsableTicket,
    getTicketInfo,
    describeForLog,
    issue,
    ensureTicket,
    resume,
    attemptResume,
    msUntilRoll
  };
}

module.exports = {
  TICKET_TTL_S,
  ROLL_LEAD_S,
  MIN_ISSUE_INTERVAL_MS,
  ISSUE_PATH,
  RESUME_PATH,
  TICKET_FIELDS,
  bareNodeId,
  validateTicket,
  newSessionId,
  createReconnectTicketStore
};
