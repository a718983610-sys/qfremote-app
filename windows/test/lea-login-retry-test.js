'use strict';
/*
 * V2a 登录通知自动重试（windows/lea-login-retry.js）单测：
 *  A. parseQwinstaSessionState：标准行／当前会话 '>'／USERNAME 为空／
 *     未知会话／空输出／本地化 STATE／ID 前导空格；
 *  B. 九行为：初发成功／WTSConnected 拒后等 WTSActive 重发成功（证明
 *     每次重取）／已活动仍拒即终局／断线不重发／会话态 unknown 终局／
 *     非暂态拒绝终局／证明缺失终局且不发包／最多 2 次补发／TTL 180 秒；
 *  C. 竞态 A：通用拒绝＋WTSConnected 才等；其余态（Idle 等）终局；
 *  D. 竞态 B：30 秒超时进 UNKNOWN_OUTCOME，先 confirmOutcome 确认，
 *     确认上即接受、确认不上即终局且不重发；无 confirm 依赖时直接终局；
 *  E. 单飞与取消：begin 取代旧事件／cancel 立即结算且不再发包／
 *     切换身份立即作废／markBindingFinalize／markBindingDone 记账；
 *  F. main.js 接线（文本断言）：require、retry.begin 接入、登出与
 *     before-quit 取消、package.json asar 清单、qwinsta 会话查询。
 * 结果写 JSON 到 QFTEST_OUT，退出码 0=通过。
 * 说明：本文件只验模块纯逻辑与 main.js 接线文本；WTS 状态变化与
 * 真实 IPC 拒绝只能在 Windows 真机上验收，沙箱结果不得写成真机通过。
 */
const fs = require('fs');
const path = require('path');

const OUT = process.env.QFTEST_OUT || '/tmp/qfr244/lea-login-retry-result.json';
const result = { cases: {}, pass: false };
const ok = (name, cond, extra) => { result.cases[name] = Object.assign({ pass: !!cond }, extra || {}); };

const SRC = path.join(__dirname, '..');
const retryMod = require('../lea-login-retry');
const { createLeaLoginRetry, parseQwinstaSessionState } = retryMod;

const CALLER = 'QFR_LEA_CALLER_NOT_ALLOWED';
const BASE_ID = { accountId: 'u1', deviceId: 'd1', windowsSessionId: 1, windowsUserSid: 'S-1-5-21-1', loginGeneration: 1 };

function withTimeout(p, ms, label) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout: ' + label)), ms))]);
}
async function waitForState(retry, want, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (retry.getState() === want) return true;
    await new Promise((r) => setTimeout(r, 5));
  }
  return retry.getState() === want;
}

/* 测试脚手架：可脚本化的会话态队列／身份序列／发送脚本／证明序列。 */
function makeHarness(cfg) {
  const c = cfg || {};
  const stateQueue = Array.isArray(c.states) ? c.states.slice() : null;
  let stateVar = c.state || 'WTSConnected';
  let stateCalls = 0;
  const identitySeq = Array.isArray(c.identities) ? c.identities.slice() : null;
  let identityCalls = 0;
  const sendScript = Array.isArray(c.sends) ? c.sends.slice() : null;
  const proofSeq = Array.isArray(c.proofs) ? c.proofs.slice() : ['proof-1', 'proof-2', 'proof-3'];
  const calls = { sends: [], proofs: [], states: [], identities: [], confirms: [] };
  let proofIdx = 0;
  let sendIdx = 0;
  const deps = {
    getSessionState: async () => {
      stateCalls++;
      let st;
      if (stateQueue) { st = stateQueue.length ? stateQueue.shift() : stateQueueDefault(); }
      else st = stateVar;
      calls.states.push(st);
      return { sessionId: 1, state: st, stateName: st.replace(/^WTS/, ''), source: 'qwinsta' };
      function stateQueueDefault() { return stateQueue.length ? stateQueue[0] : 'WTSConnected'; }
    },
    getCurrentIdentity: async () => {
      identityCalls++;
      let id;
      if (identitySeq) { id = identitySeq.length > 1 ? identitySeq.shift() : identitySeq[0]; }
      else id = Object.assign({}, BASE_ID, c.identityOverride || {});
      calls.identities.push(Object.assign({}, id));
      return Object.assign({}, id);
    },
    fetchLoginProof: async () => {
      if (c.proofFail) return { ok: false, reason: c.proofFail };
      const p = proofSeq[Math.min(proofIdx++, proofSeq.length - 1)];
      calls.proofs.push(p);
      return { ok: true, proof: p };
    },
    sendLoginAttempt: async (args) => {
      calls.sends.push({ proof: args.loginProof, attempt: args.attempt });
      if (c.sendThrows) throw new Error('spawn-fail');
      if (c.sendHang) return new Promise(() => { /* 永不 resolve，等单发超时 */ });
      if (sendScript) {
        const s = sendScript.length ? sendScript.shift() : sendScriptDefault();
        return s;
        function sendScriptDefault() { return { ok: false, code: CALLER }; }
      }
      if (c.sendOk) return { ok: true, result: { binding_epoch: 7 } };
      return { ok: false, code: CALLER };
    },
    confirmOutcome: c.noConfirm ? undefined : async (args) => {
      calls.confirms.push({ attemptStartedAtUnix: args.attemptStartedAtUnix, deviceId: args.deviceId });
      if (c.confirmOk) return { confirmed: true };
      return { confirmed: false, reason: c.confirmReason || 'last-result-not-ok' };
    },
    onAccepted: () => { calls.accepted = true; },
    onTerminalFailure: (info) => { calls.terminal = info; },
    logEvent: () => { /* 不记日志内容 */ },
  };
  const opts = {
    pollIntervalMs: c.pollIntervalMs || 10,
    attemptTimeoutMs: c.attemptTimeoutMs || 500,
    ttlMs: c.ttlMs || 60000,
    maxRetries: (typeof c.maxRetries === 'number') ? c.maxRetries : 2,
  };
  const retry = createLeaLoginRetry(deps, opts);
  return {
    retry: retry, deps: deps, calls: calls,
    setState: (s) => { stateVar = s; },
    getStateCalls: () => stateCalls,
    getIdentityCalls: () => identityCalls,
    begin: (id) => retry.begin(id || Object.assign({}, BASE_ID)),
  };
}

(async function main() {
try {
  // ---- A. parseQwinstaSessionState ----
  const QW = ' SESSIONNAME       USERNAME                 ID  STATE   TYPE        DEVICE\r\n' +
    ' console           administrator             1  Active\r\n' +
    '>rdp-tcp#0         testuser                  2  Conn\r\n' +
    ' services                                    0  Disc\r\n' +
    ' rdp-tcp#1                                   3  Idle\r\n';
  ok('A1-active', (() => { const r = parseQwinstaSessionState(QW, 1); return r.found === true && r.state === 'WTSActive' && r.stateName === 'Active'; })());
  ok('A2-connected-marker', (() => { const r = parseQwinstaSessionState(QW, 2); return r.found === true && r.state === 'WTSConnected'; })());
  ok('A3-disconnected-empty-user', (() => { const r = parseQwinstaSessionState(QW, 0); return r.found === true && r.state === 'WTSDisconnected'; })());
  ok('A4-idle-empty-user', (() => { const r = parseQwinstaSessionState(QW, 3); return r.found === true && r.state === 'WTSIdle'; })());
  ok('A5-unknown-session', (() => { const r = parseQwinstaSessionState(QW, 9); return r.found === false && r.state === 'unknown'; })());
  ok('A6-empty-output', (() => { const r = parseQwinstaSessionState('', 1); return r.found === false && r.state === 'unknown'; })());
  ok('A7-null-output', (() => { const r = parseQwinstaSessionState(null, 1); return r.found === false && r.state === 'unknown'; })());
  ok('A8-localized-state-unknown', (() => {
    const out = ' console           administrator             1  Aktiv\r\n';
    const r = parseQwinstaSessionState(out, 1);
    return r.found === false && r.state === 'unknown'; // 未知 STATE token 不认作会话行
  })());
  ok('A9-id-not-first-number', (() => {
    // USERNAME 为纯数字也不应误认：STATE 前一个 token 才是 ID。
    const out = ' rdp-tcp#5         12345                     5  Conn\r\n';
    const r = parseQwinstaSessionState(out, 5);
    return r.found === true && r.state === 'WTSConnected';
  })());

  // ---- B1. 初发成功：1 次尝试、0 补发、接受后绑定记账 ----
  {
    const h = makeHarness({ sendOk: true });
    const out = await withTimeout(h.begin(), 5000, 'B1');
    ok('B1-first-try-accepted', out.accepted === true && out.attempts === 1 && out.retriesUsed === 0 &&
      out.result && out.result.binding_epoch === 7 && h.retry.getState() === 'login-accepted');
    ok('B1-binding-finalize', h.retry.markBindingFinalize() === true && h.retry.getState() === 'binding-finalize');
    ok('B1-binding-done', h.retry.markBindingDone() === true && h.retry.getState() === 'done');
    ok('B1-binding-guard-twice', h.retry.markBindingDone() === false && h.retry.markBindingFinalize() === false);
    ok('B1-proof-once', h.calls.proofs.length === 1 && h.calls.proofs[0] === 'proof-1');
  }

  // ---- B2. WTSConnected 拒 → 等 WTSActive → 重发成功，证明每次重取 ----
  {
    const h = makeHarness({
      states: ['WTSConnected', 'WTSActive'],
      sends: [{ ok: false, code: CALLER }, { ok: true, result: { binding_epoch: 7 } }],
    });
    const p = h.begin();
    await withTimeout(waitForState(h.retry, 'wait-wts-active', 2000).then((v) => { if (!v) throw new Error('never waited'); }), 5000, 'B2-wait');
    h.setState('WTSActive');
    const out = await withTimeout(p, 5000, 'B2');
    ok('B2-retry-accepted', out.accepted === true && out.attempts === 2 && out.retriesUsed === 1);
    ok('B2-proof-fresh-each-attempt', h.calls.proofs.length === 2 && h.calls.proofs[0] === 'proof-1' && h.calls.proofs[1] === 'proof-2');
    ok('B2-send-proofs-match', h.calls.sends.length === 2 && h.calls.sends[0].proof === 'proof-1' && h.calls.sends[1].proof === 'proof-2');
  }

  // ---- B3. 已活动仍拒 → 终局，不再重发 ----
  {
    const h = makeHarness({ states: ['WTSActive'] });
    const out = await withTimeout(h.begin(), 5000, 'B3');
    ok('B3-active-refused-terminal', out.accepted === false && out.reason === 'caller-not-allowed-while-active' &&
      out.state === 'failed' && out.attempts === 1 && h.calls.sends.length === 1);
  }

  // ---- B4. WTSDisconnected 拒 → 终局，不重发 ----
  {
    const h = makeHarness({ states: ['WTSDisconnected'] });
    const out = await withTimeout(h.begin(), 5000, 'B4');
    ok('B4-disconnected-no-retry', out.accepted === false && out.reason === 'session-disconnected' && h.calls.sends.length === 1);
  }

  // ---- B5. 会话态 unknown → 终局（fail-closed，不进等待） ----
  {
    const h = makeHarness({ states: ['unknown'] });
    const out = await withTimeout(h.begin(), 5000, 'B5');
    ok('B5-unknown-state-terminal', out.accepted === false && out.reason === 'session-state-unknown' && h.calls.sends.length === 1);
  }

  // ---- B6. 非暂态拒绝（证明缺失码）→ 终局 ----
  {
    const h = makeHarness({ sends: [{ ok: false, code: 'QFR_LEA_LOGIN_PROOF_MISSING' }] });
    const out = await withTimeout(h.begin(), 5000, 'B6');
    ok('B6-nontransient-terminal', out.accepted === false && out.reason === 'QFR_LEA_LOGIN_PROOF_MISSING' && out.attempts === 1);
  }

  // ---- B7. 取证明失败 → 终局，且一次包都没发 ----
  {
    const h = makeHarness({ proofFail: 'login-proof-unavailable' });
    const out = await withTimeout(h.begin(), 5000, 'B7');
    ok('B7-proof-missing-terminal', out.accepted === false && out.reason === 'login-proof-unavailable' && h.calls.sends.length === 0);
  }

  // ---- B8. 最多 2 次补发：3 次尝试后耗尽 ----
  {
    const h = makeHarness({ states: ['WTSConnected', 'WTSActive', 'WTSConnected', 'WTSActive', 'WTSConnected'] });
    const out = await withTimeout(h.begin(), 5000, 'B8');
    ok('B8-max-retries', out.accepted === false && out.reason === 'retries-exhausted' &&
      out.attempts === 3 && out.retriesUsed === 2 && h.calls.sends.length === 3);
  }

  // ---- B9. TTL 耗尽 → EXPIRED，过期事件绝不提交 ----
  {
    const h = makeHarness({ ttlMs: 200, states: ['WTSConnected'] });
    const out = await withTimeout(h.begin(), 5000, 'B9');
    ok('B9-ttl-expired', out.accepted === false && out.reason === 'ttl-expired' && out.state === 'expired' &&
      out.attempts === 1 && h.calls.sends.length === 1);
  }

  // ---- C. 竞态 A：其余会话态（Idle）拒 → 终局，不进等待 ----
  {
    const h = makeHarness({ states: ['WTSIdle'] });
    const out = await withTimeout(h.begin(), 5000, 'C1');
    ok('C1-idle-refused-terminal', out.accepted === false && out.reason === 'session-state-not-connected' && h.calls.sends.length === 1);
  }

  // ---- D1. 竞态 B：超时＋确认不上 → UNKNOWN_OUTCOME，不重发 ----
  {
    const h = makeHarness({ sendHang: true, attemptTimeoutMs: 100, confirmOk: false });
    const out = await withTimeout(h.begin(), 5000, 'D1');
    ok('D1-timeout-unconfirmed', out.accepted === false && out.reason === 'unknown-outcome' && out.state === 'unknown-outcome' &&
      h.calls.sends.length === 1 && h.calls.confirms.length === 1);
  }

  // ---- D2. 竞态 B：超时＋确认上 → 接受（result 为空，绑定留 PENDING 由调用方处理） ----
  {
    const h = makeHarness({ sendHang: true, attemptTimeoutMs: 100, confirmOk: true });
    const out = await withTimeout(h.begin(), 5000, 'D2');
    ok('D2-timeout-confirmed-accepted', out.accepted === true && out.confirmedViaStatus === true && out.result === null && h.calls.sends.length === 1);
  }

  // ---- D3. 无 confirm 依赖时超时即直接终局 ----
  {
    const h = makeHarness({ sendHang: true, attemptTimeoutMs: 100, noConfirm: true });
    const out = await withTimeout(h.begin(), 5000, 'D3');
    ok('D3-no-confirm-hook', out.accepted === false && out.reason === 'unknown-outcome' && h.calls.confirms.length === 0);
  }

  // ---- E1. 等待中 cancel → 立即结算，不再发包 ----
  {
    const h = makeHarness({ states: ['WTSConnected'] });
    const p = h.begin();
    await withTimeout(waitForState(h.retry, 'wait-wts-active', 2000).then((v) => { if (!v) throw new Error('never waited'); }), 5000, 'E1-wait');
    const cancelled = h.retry.cancel('identity-changed');
    const out = await withTimeout(p, 5000, 'E1');
    ok('E1-cancel-settles', cancelled === true && out.accepted === false && out.cancelled === true &&
      out.reason === 'identity-changed' && out.state === 'cancelled' && h.calls.sends.length === 1);
    ok('E1-cancel-twice-noop', h.retry.cancel('identity-changed') === false);
  }

  // ---- E2. 等待中身份变 → 立即作废 ----
  {
    const h = makeHarness({
      states: ['WTSConnected'],
      identities: [Object.assign({}, BASE_ID), Object.assign({}, BASE_ID), Object.assign({}, BASE_ID, { accountId: 'u2' })],
    });
    const out = await withTimeout(h.begin(), 5000, 'E2');
    ok('E2-identity-change-void', out.accepted === false && out.reason === 'identity-changed' && out.state === 'cancelled');
  }

  // ---- E3. 新 begin 取代旧事件：旧事件静默退出、不再发包 ----
  {
    const h = makeHarness({
      states: ['WTSConnected', 'WTSActive'],
      sends: [{ ok: false, code: CALLER }, { ok: true, result: { binding_epoch: 7 } }],
    });
    const p1 = h.begin();
    await withTimeout(waitForState(h.retry, 'wait-wts-active', 2000).then((v) => { if (!v) throw new Error('never waited'); }), 5000, 'E3-wait');
    const id2 = Object.assign({}, BASE_ID, { accountId: 'u2', loginGeneration: 2 });
    // 新登录开始后，“当前身份”即新账号（与 main.js 的 currentGateUsername 同步）。
    h.deps.getCurrentIdentity = async () => Object.assign({}, id2);
    const p2 = h.begin(id2);
    const out1 = await withTimeout(p1, 5000, 'E3-old');
    const out2 = await withTimeout(p2, 5000, 'E3-new');
    ok('E3-supersede-old', out1.accepted === false && out1.cancelled === true && out1.reason === 'superseded');
    ok('E3-supersede-new', out2.accepted === true && out2.attempts === 1);
    ok('E3-old-no-extra-send', h.calls.sends.length === 2); // 旧事件 1 次＋新事件 1 次
  }

  // ---- E4. 发送抛错 → 终局（不重试） ----
  {
    const h = makeHarness({ sendThrows: true });
    const out = await withTimeout(h.begin(), 5000, 'E4');
    ok('E4-send-throw-terminal', out.accepted === false && out.reason === 'throw' && out.attempts === 1);
  }

  // ---- E5. 会话查询抛错 → unknown → 终局 ----
  {
    const h = makeHarness({});
    h.deps.getSessionState = async () => { throw new Error('qwinsta-missing'); };
    const retry2 = createLeaLoginRetry(h.deps, { pollIntervalMs: 10, attemptTimeoutMs: 500, ttlMs: 60000, maxRetries: 2 });
    const out = await withTimeout(retry2.begin(Object.assign({}, BASE_ID)), 5000, 'E5');
    ok('E5-session-query-throw', out.accepted === false && out.reason === 'session-state-unknown');
  }

  // ---- E6. 常量与接口：定夺值 ----
  ok('E6-constants', retryMod.RETRY_TTL_MS === 180000 && retryMod.MAX_RETRIES === 2 &&
    retryMod.ATTEMPT_TIMEOUT_MS === 30000 && retryMod.POLL_INTERVAL_MS === 5000);
  ok('E6-exports', typeof createLeaLoginRetry === 'function' && typeof parseQwinstaSessionState === 'function');

  // ---- F. main.js 接线（文本断言） ----
  const mainSrc = fs.readFileSync(path.join(SRC, 'main.js'), 'utf8');
  ok('F1-require', mainSrc.includes("require('./lea-login-retry')"));
  ok('F2-notify-uses-retry', /async function notifyLeaLogin\(account\)/.test(mainSrc) &&
    mainSrc.includes('createLeaLoginRetryFor') && mainSrc.includes('retry.begin({') &&
    mainSrc.includes('markBindingFinalize') && mainSrc.includes('markBindingDone'));
  ok('F3-logout-cancels', /function handleManualLogout\(\)/.test(mainSrc) &&
    mainSrc.includes("leaLoginRetryInstance.cancel('identity-changed')"));
  ok('F4-before-quit-cancels', /app\.on\('before-quit'/.test(mainSrc) &&
    mainSrc.includes("leaLoginRetryInstance.cancel('identity-changed')"));
  ok('F5-package-asar', (() => {
    const pkg = JSON.parse(fs.readFileSync(path.join(SRC, 'package.json'), 'utf8'));
    return Array.isArray(pkg.build && pkg.build.files) && pkg.build.files.includes('lea-login-retry.js');
  })());
  ok('F6-qwinsta-session-query', mainSrc.includes('parseQwinstaSessionState') && mainSrc.includes('qwinsta.exe') &&
    mainSrc.includes('GetCurrentProcess().SessionId'));
  ok('F7-proof-refetch-per-attempt', mainSrc.includes('fetchLeaLoginProofFor') &&
    mainSrc.includes('fetchLoginProof: () => fetchLeaLoginProofFor(deviceId)') &&
    !mainSrc.includes('loginProofCache') && // 证明不进任何模块外缓存
    mainSrc.includes('sendLoginAttempt'));
  ok('F8-confirm-hook', mainSrc.includes('confirmLeaLoginOutcomeFor') &&
    mainSrc.includes("last_command !== 'session.login_changed'") &&
    mainSrc.includes("last_result !== 'ok'"));
  ok('F9-single-flight-guard', mainSrc.includes("reason: 'already-in-flight'"));
  ok('F10-no-powershell-pipe-send', !/powershell.*session\.login_changed/i.test(mainSrc) &&
    !/session\.login_changed.*powershell/i.test(mainSrc));
} catch (e) {
  result.error = String((e && e.stack) || e);
}

result.pass = Object.values(result.cases).every((c) => c.pass) && !result.error;
try { fs.mkdirSync(path.dirname(OUT), { recursive: true }); } catch (e) { /* ignore */ }
try { fs.writeFileSync(OUT, JSON.stringify(result, null, 2)); } catch (e) { /* ignore */ }
console.log(JSON.stringify({ pass: result.pass, failed: Object.keys(result.cases).filter((k) => !result.cases[k].pass) }));
process.exit(result.pass ? 0 : 1);
})();
