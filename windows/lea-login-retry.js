'use strict';
/*
 * lea-login-retry.js — V2a 登录通知自动重试（GPT 2026-11-18 定夺问题 2）
 * ============================================================================
 * 依据：~/workspace/qfremote/gpt-a16s2-testmain-ruling-20261118.md §2
 * （2026-11-18 约 22:43 取回，思考 7m 41s；定夺前本模块根本不存在，
 * main.js 里 WTSActive／WTSConnected／powerMonitor 零命中，V2a 9 行为
 * 零实现——本文件就是从零实现它的模块）。
 *
 * 职责边界（定夺 §2.1／§2.4）：
 *  - 本模块只负责有限状态机、重试调度和取消；只重试“登录通知”阶段
 *   （session.login_changed 尚未被服务确认成功）；一旦 login_changed
 *    已确认成功，后续 rebind／keys.sync-revoked／binding.confirm 出错，
 *    不得回头再发完整登录通知——绑定确认由 main.js 在 onAccepted 之后
 *    单独推进（markBindingFinalize／markBindingDone 只做状态记账）。
 *  - 业务入口在 main.js（notifyLeaLogin）：取 login-proof、发内部命令、
 *    查会话状态、做绑定确认。本模块不决定登录账户或设备权限，不读
 *    cookie／密码／Key，不触碰生产服务或生产数据。
 *  - 登录证明（login-proof）只在单次尝试的局部变量里过一遍：每次合
 *    法重发都重新取证明，绝不复用；证明原文永不写入模块状态、永不记
 *    日志（logEvent 只收事件名与非敏感摘要）。
 *
 * 状态机（定夺 §2.4，另加 FAILED 一个实现侧终态，见下）：
 *    login-pending ──拒绝且符合暂态条件──▶ wait-wts-active
 *    login-pending ──接受─────────────────▶ login-accepted
 *    wait-wts-active ──变 WTSActive───────▶ login-pending（再发一次）
 *    login-accepted ──main.js 推进绑定────▶ binding-finalize ──▶ done
 *    任一态 ──TTL 耗尽───────────────────▶ expired
 *    任一态 ──身份变化／显式取消─────────▶ cancelled
 *    超时且状态查询无法确认─────────────▶ unknown-outcome
 *    非暂态硬失败（证明缺失／断线／WTSActive 下仍拒／未知会话态／
 *    重试耗尽等）──────────────────────▶ failed（实现侧终态）
 *  FAILED 不在定夺列出的终态里：定夺的 DONE／CANCELLED／EXPIRED／
 *  UNKNOWN_OUTCOME 覆盖重试生命周期，FAILED 只是“被非暂态错误终
 * 止”的记账态，onTerminalFailure 的 reason 才是判据。
 *
 * 竞态 A（定夺 §2.3）：服务端只回通用错误码 QFR_LEA_CALLER_NOT_ALLOWED，
 * 详细 session-not-active 只写受保护审计。本模块不能仅凭通用错误码
 * 决定重试，必须同时满足：本次调用来自已核验的主程序链路（由调用方
 * 保证，本模块只认注入的依赖）、本地实际会话为 WTSConnected、IPC 回
 * 通用调用方拒绝、账户／设备／Session／登录事件世代仍一致。进入等
 * 待时只记“caller-not-allowed-while-connected”，绝不武断记为“服务
 * 端已确认 session-not-active”——真正原因仍以 QFRLEA 内部审计为准。
 * 若实际原因是路径错误或 SID 错误，转 WTSActive 后仍会被拒：此时
 * 直接终局，不无限重试。
 * 竞态 B（定夺 §2.3）：单发 30 秒超时、服务可能已接收请求时，进
 * UNKNOWN_OUTCOME，先经 confirmOutcome（获授权的 lea.status 查询）
 * 确认结果；未能确认前不重发登录通知、不再次 rebind。
 *
 * 会话状态来源（定夺 §2.1）：正式 RC 优先用 Windows WTS API 读会话
 * 状态；本模块不内置读法——getSessionState 由 main.js 注入。main.js
 * 当前实现用 qwinsta 解析（parseQwinstaSessionState，本文件导出纯
 * 函数），只作客户端侧“等不等”的调度依据，绝不作为授权依据：每
 * 一次发送仍由 QFRLEA 服务端用 WTS API 独立鉴权。qwinsta 若不可用
 * 或解析失败，会话态即 unknown，本模块 fail-closed 不进等待。
 *
 * 本模块无 Electron 依赖，可在沙箱用 node 直接单测；真机行为
 * （WTS 状态变化、真实 IPC 拒绝）只能在 Windows 真机上验收，
 * 沙箱结果不得写成真机通过。
 */

const RETRY_TTL_MS = 180 * 1000;      // 定夺 §2.2 行为 5：TTL 180 秒
const MAX_RETRIES = 2;                // 定夺 §2.2 行为 4：最多 2 次补发
const ATTEMPT_TIMEOUT_MS = 30 * 1000; // 定夺 §2.2 行为 6：单发 30 秒兜底
const POLL_INTERVAL_MS = 5 * 1000;    // 会话监听有界轮询兜底间隔
const CALLER_NOT_ALLOWED = 'QFR_LEA_CALLER_NOT_ALLOWED';

const STATES = {
  IDLE: 'idle',
  LOGIN_PENDING: 'login-pending',
  WAIT_WTS_ACTIVE: 'wait-wts-active',
  LOGIN_ACCEPTED: 'login-accepted',
  BINDING_FINALIZE: 'binding-finalize',
  DONE: 'done',
  CANCELLED: 'cancelled',
  EXPIRED: 'expired',
  UNKNOWN_OUTCOME: 'unknown-outcome',
  FAILED: 'failed',
};

/* WTS_CONNECTSTATE_CLASS 名。'unknown' 表示查不到／未查到。 */
const SESSION_STATES = {
  ACTIVE: 'WTSActive',
  CONNECTED: 'WTSConnected',
  DISCONNECTED: 'WTSDisconnected',
  IDLE: 'WTSIdle',
  LISTEN: 'WTSListen',
  DOWN: 'WTSDown',
  INIT: 'WTSInit',
  RESET: 'WTSReset',
  UNKNOWN: 'unknown',
};

/* qwinsta 输出 STATE 列 → WTS_CONNECTSTATE_CLASS 名。qwinsta 的 STATE
 * 列在本地化 Windows 上仍是英文（WTS_CONNECTSTATE_CLASS 名），故按
 * 英文 token 匹配；其余一律 unknown。 */
const QWINSTA_STATE_MAP = {
  Active: 'WTSActive',
  Conn: 'WTSConnected',
  Disc: 'WTSDisconnected',
  Idle: 'WTSIdle',
  Listen: 'WTSListen',
  Down: 'WTSDown',
  Init: 'WTSInit',
  Reset: 'WTSReset',
};

/* 解析 qwinsta 输出，找指定 sessionId 的行并返回其会话态。
 * 纯函数。行形如（USERNAME 可能为空，当前会话行首可能带 '>'）：
 *   console           administrator             1  Active
 *   rdp-tcp#0         testuser                  2  Conn
 *   services                                    0  Disc
 * 定位法：先找已知 STATE token，再取其前一个纯数字 token 为 ID——
 * 不依赖列宽、不依赖 USERNAME 是否为空。找不到／ID 不合法／输出
 * 为空一律返回 { found:false, state:'unknown' }，永不抛错。 */
function parseQwinstaSessionState(output, sessionId) {
  const out = { found: false, sessionId: null, state: 'unknown', stateName: '' };
  try {
    const want = Number(sessionId);
    if (!Number.isSafeInteger(want) || want < 0) return out;
    out.sessionId = want;
    if (!output || typeof output !== 'string') return out;
    const lines = output.split(/\r?\n/);
    for (const line of lines) {
      if (!line || !line.trim()) continue;
      const toks = line.trim().split(/\s+/);
      if (toks.length < 3) continue;
      let si = -1;
      for (let i = 0; i < toks.length; i++) {
        if (Object.prototype.hasOwnProperty.call(QWINSTA_STATE_MAP, toks[i])) { si = i; break; }
      }
      if (si < 1) continue;
      if (!/^\d+$/.test(toks[si - 1])) continue;
      if (Number(toks[si - 1]) !== want) continue;
      out.found = true;
      out.stateName = toks[si];
      out.state = QWINSTA_STATE_MAP[toks[si]] || 'unknown';
      return out;
    }
    return out;
  } catch (e) { return out; }
}

function isFn(v) { return typeof v === 'function'; }
function normStr(v) { return (v === undefined || v === null) ? '' : String(v); }
function normNum(v) { return (typeof v === 'number' && Number.isSafeInteger(v)) ? v : null; }

/* begin() 的身份快照与当前身份比对：账号／设备／会话／SID／世代
 * 任一不同即作废。null 与 null 视为相等（会话／SID 尚未查到时）。 */
function identityEqual(a, b) {
  if (!a || !b) return false;
  return normStr(a.accountId) === normStr(b.accountId)
    && normStr(a.deviceId) === normStr(b.deviceId)
    && normNum(a.windowsSessionId) === normNum(b.windowsSessionId)
    && normStr(a.windowsUserSid) === normStr(b.windowsUserSid)
    && normNum(a.loginGeneration) === normNum(b.loginGeneration);
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/*
 * createLeaLoginRetry(deps, opts)
 * deps（缺一不可，缺失即抛 TypeError——构造时 fail-fast，不静默）：
 *  - getSessionState() -> Promise<{ sessionId, state, stateName, source }>
 *      state 取 SESSION_STATES 之一；查不到即 'unknown'。
 *  - getCurrentIdentity() -> Promise<{ accountId, deviceId,
 *      windowsSessionId, windowsUserSid, loginGeneration }>
 *  - fetchLoginProof() -> Promise<{ ok:true, proof:string }
 *      | { ok:false, reason:string }>（每次尝试都重新取新鲜证明）
 *  - sendLoginAttempt({ loginProof, accountId, deviceId, attempt })
 *      -> Promise<{ ok:true, result? } | { ok:false, code?, reason?,
 *      timeout?:boolean }>（一次发送；超时由调用方按
 *      ATTEMPT_TIMEOUT_MS 兜底，返回 { ok:false, reason:'timeout',
 *      timeout:true }；永不抛错——抛错按 { ok:false, reason:'throw' } 计）
 *  - confirmOutcome({ attemptStartedAtUnix, accountId, deviceId })
 *      -> Promise<{ confirmed:boolean, reason? }>（可选；用于竞态 B，
 *      获授权的 lea.status 查询。未提供时超时即直接终局。）
 *  - onAccepted(info) / onTerminalFailure(info)（可选回调）
 *  - logEvent(event, detail)（可选；detail 绝不含 login-proof 原文）
 * opts（测试注入；不传即用定夺值）：
 *  - ttlMs / maxRetries / attemptTimeoutMs / pollIntervalMs
 *  - now() / sleep(ms)（默认 Date.now／setTimeout）
 */
function createLeaLoginRetry(deps, opts) {
  const o = opts || {};
  if (!deps || typeof deps !== 'object') throw new TypeError('lea-login-retry: deps required');
  for (const k of ['getSessionState', 'getCurrentIdentity', 'fetchLoginProof', 'sendLoginAttempt']) {
    if (!isFn(deps[k])) throw new TypeError('lea-login-retry: missing dep ' + k);
  }
  const ttlMs = (typeof o.ttlMs === 'number' && o.ttlMs > 0) ? o.ttlMs : RETRY_TTL_MS;
  const maxRetries = (typeof o.maxRetries === 'number' && o.maxRetries >= 0) ? Math.floor(o.maxRetries) : MAX_RETRIES;
  const attemptTimeoutMs = (typeof o.attemptTimeoutMs === 'number' && o.attemptTimeoutMs > 0) ? o.attemptTimeoutMs : ATTEMPT_TIMEOUT_MS;
  const pollIntervalMs = (typeof o.pollIntervalMs === 'number' && o.pollIntervalMs > 0) ? o.pollIntervalMs : POLL_INTERVAL_MS;
  const now = isFn(o.now) ? o.now : Date.now;
  const sleep = isFn(o.sleep) ? o.sleep : defaultSleep;
  const logEvent = isFn(deps.logEvent) ? deps.logEvent : function () { /* no-op */ };
  const onAccepted = isFn(deps.onAccepted) ? deps.onAccepted : function () { /* no-op */ };
  const onTerminalFailure = isFn(deps.onTerminalFailure) ? deps.onTerminalFailure : function () { /* no-op */ };

  let state = STATES.IDLE;
  let identity = null;
  let createdAt = 0;
  let attempts = 0;     // 已发出的尝试次数（含初发）
  let retriesUsed = 0;   // 已用的补发次数
  let cancelled = false;
  let cancelReason = '';
  let outcomeResolve = null;
  let runToken = 0;      // 事件代次：新 begin 递增，旧事件循环见代次不符即
  // 静默退出（不结算、不发包）。没有它，supersede 后旧循环会在新
  // begin 已重置 cancelled 标志后继续跑，造成重复发送。
  let pendingDelay = null; // { timer, resolve }：等待可被 cancel 唤醒

  function log(ev, detail) {
    try { logEvent(ev, detail || {}); } catch (e) { /* 日志失败不影响重试 */ }
  }
  function ttlExpired() { return (now() - createdAt) >= ttlMs; }
  function ttlRemainingMs() { return Math.max(0, ttlMs - (now() - createdAt)); }

  /* 可被 cancel() 唤醒的等待。cancel 时清 timer 并立即 resolve。 */
  function delay(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => { pendingDelay = null; resolve(); }, ms);
      pendingDelay = { timer, resolve: () => { clearTimeout(timer); pendingDelay = null; resolve(); } };
    });
  }
  function wakeDelay() {
    if (pendingDelay) { try { pendingDelay.resolve(); } catch (e) { /* ignore */ } }
  }

  async function safeGetSessionState() {
    try {
      const st = await deps.getSessionState();
      if (!st || typeof st !== 'object') return null;
      return { sessionId: normNum(st.sessionId), state: normStr(st.state) || 'unknown', stateName: normStr(st.stateName), source: normStr(st.source) };
    } catch (e) { return null; }
  }
  async function safeGetIdentity() {
    try {
      const id = await deps.getCurrentIdentity();
      if (!id || typeof id !== 'object') return null;
      return {
        accountId: normStr(id.accountId), deviceId: normStr(id.deviceId),
        windowsSessionId: normNum(id.windowsSessionId), windowsUserSid: normStr(id.windowsUserSid),
        loginGeneration: normNum(id.loginGeneration),
      };
    } catch (e) { return null; }
  }
  async function safeFetchProof() {
    try {
      const p = await deps.fetchLoginProof();
      if (!p || typeof p !== 'object') return { ok: false, reason: 'bad-proof-response' };
      if (p.ok === true && typeof p.proof === 'string' && p.proof) return { ok: true, proof: p.proof };
      return { ok: false, reason: normStr(p.reason) || 'login-proof-unavailable' };
    } catch (e) { return { ok: false, reason: 'login-proof-throw' }; }
  }
  async function safeSend(args) {
    try {
      const r = await deps.sendLoginAttempt(args);
      if (!r || typeof r !== 'object') return { ok: false, reason: 'bad-send-response' };
      return r;
    } catch (e) { return { ok: false, reason: 'throw' }; }
  }
  async function safeConfirmOutcome(args) {
    try {
      if (!isFn(deps.confirmOutcome)) return { confirmed: false, reason: 'no-confirm-hook' };
      const c = await deps.confirmOutcome(args);
      if (!c || typeof c !== 'object') return { confirmed: false, reason: 'bad-confirm-response' };
      return { confirmed: c.confirmed === true, reason: normStr(c.reason) };
    } catch (e) { return { confirmed: false, reason: 'confirm-throw' }; }
  }

  function settleOutcome(outcome) {
    if (outcomeResolve) {
      const r = outcomeResolve;
      outcomeResolve = null;
      try { r(outcome); } catch (e) { /* ignore */ }
    }
  }
  /* 终局：置终态、调 onTerminalFailure、解 begin 的 Promise。 */
  function finishTerminal(reason, endState, extra) {
    state = endState;
    const info = Object.assign({ accepted: false, reason: reason, state: endState, attempts: attempts, retriesUsed: retriesUsed }, extra || {});
    log('terminal', { reason: reason, state: endState, attempts: attempts, retriesUsed: retriesUsed });
    try { onTerminalFailure(info); } catch (e) { /* ignore */ }
    settleOutcome(info);
    return info;
  }
  function finishAccepted(result, extra) {
    state = STATES.LOGIN_ACCEPTED;
    const info = Object.assign({ accepted: true, result: result || null, attempts: attempts, retriesUsed: retriesUsed }, extra || {});
    log('accepted', { attempts: attempts, retriesUsed: retriesUsed });
    try { onAccepted(info); } catch (e) { /* ignore */ }
    settleOutcome(info);
    return info;
  }

  /* 一次发送：取新鲜证明 → 发 → 分类。返回 'retry'（须继续循环）、
   * 'wait'（进入等待）、'abandoned'（已被新事件取代，静默退出）或
   * 终局 info（已 settle）。proof 只活在局部变量。 */
  async function doAttempt(myToken) {
    if (myToken !== runToken) return 'abandoned';
    if (cancelled) return finishTerminal(cancelReason || 'cancelled', STATES.CANCELLED, { cancelled: true });
    if (ttlExpired()) return finishTerminal('ttl-expired', STATES.EXPIRED);
    const idNow = await safeGetIdentity();
    if (myToken !== runToken) return 'abandoned';
    if (idNow && !identityEqual(idNow, identity)) {
      return finishTerminal('identity-changed', STATES.CANCELLED, { cancelled: true });
    }
    const proofRes = await safeFetchProof();
    if (myToken !== runToken) return 'abandoned';
    if (!proofRes.ok) {
      /* 定夺 §2.2 行为 8：证明缺失是非暂态错误，终止，不重试。 */
      return finishTerminal(proofRes.reason, STATES.FAILED);
    }
    const loginProof = proofRes.proof; // 局部变量：本次尝试用完即丢
    const attemptNo = attempts + 1;
    const attemptStartedAtUnix = Math.floor(now() / 1000);
    attempts = attemptNo;
    log('attempt', { attempt: attemptNo, retriesUsed: retriesUsed, ttlRemainingMs: ttlRemainingMs() });
    /* 单发兜底：调用方自身也有 30 秒超时；此处再 race 一道，后到的
     * 迟回包直接丢弃（settled 守门），不无限等待、不无限派生。 */
    let settled = false;
    const sendP = safeSend({ loginProof: loginProof, accountId: identity.accountId, deviceId: identity.deviceId, attempt: attemptNo })
      .then((r) => { if (!settled) { settled = true; return r; } return { ok: false, reason: 'late-result-ignored', ignored: true }; });
    const timeoutP = sleep(attemptTimeoutMs).then(() => { if (!settled) { settled = true; return { ok: false, reason: 'timeout', timeout: true }; } return { ok: false, reason: 'late-result-ignored', ignored: true }; });
    const res = await Promise.race([sendP, timeoutP]);
    if (myToken !== runToken) return 'abandoned';
    if (res.ignored) return finishTerminal('attempt-race-error', STATES.FAILED);
    if (res.timeout === true || res.reason === 'timeout') {
      /* 竞态 B：服务可能已接收请求。先确认，未确认前绝不重发。 */
      log('attempt-timeout', { attempt: attemptNo });
      state = STATES.UNKNOWN_OUTCOME;
      const conf = await safeConfirmOutcome({ attemptStartedAtUnix: attemptStartedAtUnix, accountId: identity.accountId, deviceId: identity.deviceId });
      if (myToken !== runToken) return 'abandoned';
      if (conf.confirmed === true) {
        log('unknown-outcome-confirmed', { attempt: attemptNo });
        return finishAccepted(null, { confirmedViaStatus: true });
      }
      return finishTerminal('unknown-outcome', STATES.UNKNOWN_OUTCOME, { confirmReason: conf.reason || '' });
    }
    if (res.ok === true) {
      return finishAccepted(res.result || null, { confirmedViaStatus: false });
    }
    /* 拒绝分类。 */
    const code = normStr(res.code) || normStr(res.reason);
    if (code === CALLER_NOT_ALLOWED) {
      /* 竞态 A 严格条件：本地实际会话须为 WTSConnected，且身份仍一致。
       * 注意：此处只记 caller-not-allowed-while-connected，绝不记
       * “服务端已确认 session-not-active”。 */
      const st = await safeGetSessionState();
      const idNow2 = await safeGetIdentity();
      if (myToken !== runToken) return 'abandoned';
      if (idNow2 && !identityEqual(idNow2, identity)) {
        return finishTerminal('identity-changed', STATES.CANCELLED, { cancelled: true });
      }
      if (!st || st.state === 'unknown') {
        return finishTerminal('session-state-unknown', STATES.FAILED, { sessionState: 'unknown' });
      }
      if (st.state === SESSION_STATES.DISCONNECTED) {
        /* 定夺 §2.2 行为 8：WTSDisconnected 不重发。 */
        return finishTerminal('session-disconnected', STATES.FAILED, { sessionState: st.state });
      }
      if (st.state === SESSION_STATES.ACTIVE) {
        /* 已在活动会话仍被拒：路径／SID 等非会话原因，再发也会被拒。 */
        return finishTerminal('caller-not-allowed-while-active', STATES.FAILED, { sessionState: st.state });
      }
      if (st.state === SESSION_STATES.CONNECTED) {
        if (retriesUsed >= maxRetries) {
          return finishTerminal('retries-exhausted', STATES.FAILED, { sessionState: st.state });
        }
        log('wait-wts-active', { retriesUsed: retriesUsed, sessionState: st.state, ttlRemainingMs: ttlRemainingMs() });
        return 'wait';
      }
      /* 其余会话态（Idle／Listen／Down／Init／Reset）：不是可等待暂态。 */
      return finishTerminal('session-state-not-connected', STATES.FAILED, { sessionState: st.state, sessionStateName: st.stateName });
    }
    /* 其余拒绝（信封错／证明缺失／权限拒绝等）一律非暂态，终止。 */
    return finishTerminal(code || 'notify-failed', STATES.FAILED);
  }

  /* 有界等待：轮询会话态直到 WTSActive／断线／身份变／TTL 耗尽／取消。
   * 返回 'retry'（变活动，再发一次）、'abandoned'（被取代）或终局 info。 */
  async function doWait(myToken) {
    state = STATES.WAIT_WTS_ACTIVE;
    for (;;) {
      await delay(pollIntervalMs);
      if (myToken !== runToken) return 'abandoned';
      if (cancelled) return finishTerminal(cancelReason || 'cancelled', STATES.CANCELLED, { cancelled: true });
      if (ttlExpired()) return finishTerminal('ttl-expired', STATES.EXPIRED);
      const idNow = await safeGetIdentity();
      if (myToken !== runToken) return 'abandoned';
      if (idNow && !identityEqual(idNow, identity)) {
        return finishTerminal('identity-changed', STATES.CANCELLED, { cancelled: true });
      }
      const st = await safeGetSessionState();
      if (myToken !== runToken) return 'abandoned';
      if (!st || st.state === 'unknown') continue; // 查不到就继续等到 TTL
      if (st.state === SESSION_STATES.ACTIVE) {
        retriesUsed++;
        log('session-active-retry', { retriesUsed: retriesUsed, ttlRemainingMs: ttlRemainingMs() });
        return 'retry';
      }
      if (st.state === SESSION_STATES.DISCONNECTED) {
        return finishTerminal('session-disconnected', STATES.FAILED, { sessionState: st.state });
      }
      /* WTSConnected 或其他非活动态：继续等（TTL 兜底）。 */
    }
  }

  async function run(myToken) {
    for (;;) {
      if (myToken !== runToken) return 'abandoned';
      const r = await doAttempt(myToken);
      if (r === 'wait') {
        const w = await doWait(myToken);
        if (w === 'retry') continue;
        return w;
      }
      return r;
    }
  }

  const api = {
    /* 开始一次登录重试事件。同一实例同时只跑一个事件：新 begin 会
     * 先以 superseded 取消在途事件（单飞）。返回 Promise<Outcome>，
     * 事件终局时 resolve：{ accepted:true, result?, attempts,
     * retriesUsed, confirmedViaStatus? } 或 { accepted:false, reason,
     * state, attempts, retriesUsed }。 */
    begin: function (id) {
      if (!id || typeof id !== 'object') throw new TypeError('lea-login-retry: begin identity required');
      if (state === STATES.LOGIN_PENDING || state === STATES.WAIT_WTS_ACTIVE ||
          state === STATES.LOGIN_ACCEPTED || state === STATES.BINDING_FINALIZE) {
        api.cancel('superseded');
      }
      identity = {
        accountId: normStr(id.accountId), deviceId: normStr(id.deviceId),
        windowsSessionId: normNum(id.windowsSessionId), windowsUserSid: normStr(id.windowsUserSid),
        loginGeneration: normNum(id.loginGeneration),
      };
      createdAt = now();
      attempts = 0;
      retriesUsed = 0;
      cancelled = false;
      cancelReason = '';
      state = STATES.LOGIN_PENDING;
      const myToken = ++runToken;
      log('begin', { accountId: identity.accountId, deviceId: identity.deviceId, sessionId: identity.windowsSessionId, generation: identity.loginGeneration });
      const p = new Promise((resolve) => { outcomeResolve = resolve; });
      /* run() 在后台推进；begin 的 Promise 只在终局时 settle。
       * 'abandoned' 是旧事件被取代后的静默退出，outcome 已由 cancel
       * 结算，此处不再结算。 */
      run(myToken).catch((e) => {
        if (myToken === runToken && state !== STATES.DONE && state !== STATES.CANCELLED && state !== STATES.EXPIRED &&
            state !== STATES.UNKNOWN_OUTCOME && state !== STATES.FAILED) {
          finishTerminal('retry-loop-throw', STATES.FAILED);
        }
      });
      return p;
    },
    /* 切换账户／退出登录／窗口退出时取消在途事件。已终局时无操作。
     * cancel 立即把在途事件的 begin Promise 以
     * { accepted:false, cancelled:true } 结算（旧循环随后见代次不符
     * 静默退出，不再发包）。 */
    cancel: function (reason) {
      const r = (typeof reason === 'string' && reason) ? reason : 'cancelled';
      if (state === STATES.DONE || state === STATES.CANCELLED || state === STATES.EXPIRED ||
          state === STATES.UNKNOWN_OUTCOME || state === STATES.FAILED || state === STATES.IDLE) {
        return false;
      }
      cancelled = true;
      cancelReason = r;
      state = STATES.CANCELLED;
      wakeDelay();
      log('cancel', { reason: r });
      const info = { accepted: false, reason: r, state: STATES.CANCELLED, attempts: attempts, retriesUsed: retriesUsed, cancelled: true };
      try { onTerminalFailure(info); } catch (e) { /* ignore */ }
      settleOutcome(info);
      return true;
    },
    /* 绑定确认阶段记账：只允许 LOGIN_ACCEPTED → BINDING_FINALIZE。
     * 绑定确认失败也不得回头重发登录通知（调用方只取消／记账）。 */
    markBindingFinalize: function () {
      if (state !== STATES.LOGIN_ACCEPTED) return false;
      state = STATES.BINDING_FINALIZE;
      log('binding-finalize', {});
      return true;
    },
    markBindingDone: function () {
      if (state !== STATES.BINDING_FINALIZE) return false;
      state = STATES.DONE;
      log('binding-done', {});
      return true;
    },
    getState: function () { return state; },
    getInfo: function () {
      return {
        state: state, attempts: attempts, retriesUsed: retriesUsed,
        createdAt: createdAt, ttlMs: ttlMs, maxRetries: maxRetries,
        accountId: identity ? identity.accountId : '',
        deviceId: identity ? identity.deviceId : '',
      };
    },
  };
  return api;
}

module.exports = {
  createLeaLoginRetry: createLeaLoginRetry,
  parseQwinstaSessionState: parseQwinstaSessionState,
  RETRY_TTL_MS: RETRY_TTL_MS,
  MAX_RETRIES: MAX_RETRIES,
  ATTEMPT_TIMEOUT_MS: ATTEMPT_TIMEOUT_MS,
  POLL_INTERVAL_MS: POLL_INTERVAL_MS,
  SESSION_STATES: SESSION_STATES,
  STATES: STATES,
};
