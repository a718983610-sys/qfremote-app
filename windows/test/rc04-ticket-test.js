'use strict';
/*
 * RC-04 Windows 票据恢复层测试（L1 票据规范 v1，3.0.0）：
 *  A. 票据形状校验（validateTicket，规范 §1/§1.2）：有效票据通过；
 *     未知字段/缺签名/TTL≠300/格式错/epochs 非法/签名长度错一律拒绝。
 *  B. 失败分类（reconnect-policy.js，规范 §5.2/§3.2/§4）：7 个凭据码
 *     立即停；404=端点未实现；0/429/500/502/503=网络；无名 401/403/
 *     409 按 fail-closed 归凭据类。
 *  C. 申领（issue，规范 §3.1/§5.1）：成功存内存票据＋续领定时；
 *     404/凭据失败不存票；200 但形状非法不存；5 秒内重复申领限流；
 *     ensureTicket 复用可用票据。
 *  D. 恢复（resume，规范 §3.2/§4/§5.2）：成功即消费（内存票据丢弃，
 *     body 原样即票据全文）；凭据类 8 码一律丢票据、立即停；本地过期
 *     不发请求；网络/404 保留票据；无票据不发请求；回包 session 不符
 *     拒绝。
 *  E. 滚动续领（规范 §5.1）：到期前 60 秒定时；触发后换新票据；
 *     stopSession 清票据＋会话＋定时器。
 *  F. attemptResume（watchdog 钩子入口）：无票据先领后恢；领票凭据
 *     失败即停、不发 resume；网络失败保留票据。
 *  G. 看护接线（watchdog.js）：钩子报停 → 0 点击＋reconnect-stopped
 *     附 reason；钩子放行/抛错 → 照常点击；恢复后 onRecovered 调用。
 *  H. 静态接线：main.js 票据存储创建＋登录申领＋登出清票据＋看护
 *     钩子；package.json 打包清单；工具栏停手原因文案；构建检查 0 违规。
 *  I. 全形／裸形设备 id 归一（联调互操作）：调用方传全形 node//…、
 *     服务端按规范 §1 只返裸形时，issue 必须按裸形比对通过；全形
 *     issue→resume 全流程通过；真不符仍拒绝。
 * 服务端 /reconnect/* 端点尚未实现（规范 §7），本测试用假 request
 * 注入，不发真实网络请求。结果写 JSON 到 QFTEST_OUT，退出码 0=通过。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const policy = require('../reconnect-policy');
const ticketMod = require('../reconnect-ticket');
const { createWatchdog, DETECT_JS, CLICK_JS } = require('../watchdog');
const { runChecks } = require('../tools/check-electron-safety');

const OUT = process.env.QFTEST_OUT || '/tmp/qfr-rc04-ticket/rc04-ticket-result.json';
const result = { cases: {}, pass: false };
const ok = (name, cond, extra) => { result.cases[name] = Object.assign({ pass: !!cond }, extra || {}); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SIG64 = Buffer.alloc(64, 7).toString('base64'); // 64 字节 Ed25519 签名
function validTicket(over) {
  return Object.assign({
    account_id: 'alice',
    device_id: 'test-device-1',
    api_key_id: 'k_abcdefghij',
    binding_epoch: 3,
    grant_epoch: 1,
    resume_id: 'resume-0123456789abcdef',
    session_id: 'sess-0123456789abcdef',
    issued_at: 1790000000,
    expires_at: 1790000300,
    ticket_signature: SIG64
  }, over || {});
}

// 可控时钟＋假定时器＋假 request 的 store 工厂。
function makeStore(fake, now) {
  const timers = [];
  const timer = {
    setTimeout: (fn, ms) => { const id = timers.length; timers.push({ fn, ms, cleared: false }); return id; },
    clearTimeout: (id) => { if (timers[id]) timers[id].cleared = true; }
  };
  const calls = [];
  const request = async (method, url, body) => {
    calls.push({ method, url, body });
    return fake(method, url, body);
  };
  const store = ticketMod.createReconnectTicketStore({
    baseUrl: 'https://app.qfremote.top',
    request,
    nowSec: () => now.sec,
    nowMs: () => now.ms,
    randomBytes: (n) => Buffer.alloc(n, 0xab),
    log: () => {},
    timer
  });
  return { store, calls, timers, timer };
}

(async () => {
  // ---------- A 票据形状 ----------
  ok('A1_valid', ticketMod.validateTicket(validTicket()).ok === true);
  ok('A2_unknown_field', ticketMod.validateTicket(validTicket({ extra: 1 })).ok === false);
  ok('A3_missing_signature', (() => { const t = validTicket(); delete t.ticket_signature; return ticketMod.validateTicket(t).ok === false; })());
  ok('A4_bad_ttl', ticketMod.validateTicket(validTicket({ expires_at: 1790000299 })).ok === false);
  ok('A5_bad_resume_id', ticketMod.validateTicket(validTicket({ resume_id: 'resume-XYZ' })).ok === false);
  ok('A6_bad_session_id', ticketMod.validateTicket(validTicket({ session_id: 'sess-0123456789abcde' })).ok === false);
  ok('A7_bad_api_key_id', ticketMod.validateTicket(validTicket({ api_key_id: 'k_ABCDE' })).ok === false &&
    ticketMod.validateTicket(validTicket({ api_key_id: 'k_abcdefghi' })).ok === false);
  ok('A8_bad_epochs', ticketMod.validateTicket(validTicket({ binding_epoch: -1 })).ok === false &&
    ticketMod.validateTicket(validTicket({ grant_epoch: 1.5 })).ok === false);
  ok('A9_control_char_id', ticketMod.validateTicket(validTicket({ account_id: 'a\nb' })).ok === false);
  ok('A10_bad_signature_length', ticketMod.validateTicket(validTicket({ ticket_signature: Buffer.alloc(32, 1).toString('base64') })).ok === false);
  ok('A11_not_object', ticketMod.validateTicket(null).ok === false && ticketMod.validateTicket('x').ok === false);
  ok('A12_missing_field', (() => { const t = validTicket(); delete t.grant_epoch; return ticketMod.validateTicket(t).ok === false; })());

  // ---------- B 失败分类 ----------
  ok('B1_credential_codes', policy.TICKET_CREDENTIAL_CODES.length === 8 &&
    ['QFR_API_KEY_REVOKED', 'QFR_TICKET_REUSED', 'QFR_TICKET_EXPIRED', 'QFR_TICKET_INVALID', 'QFR_BINDING_CHANGED',
     'QFR_GRANT_REVOKED', 'QFR_SCOPE_DENIED', 'QFR_LEA_NOT_BOUND'].every((c) =>
      policy.classifyTicketFailure(401, c) === 'credential' && policy.isCredentialTicketCode(c)));
  ok('B6_ticket-invalid_400_credential', policy.classifyTicketFailure(400, 'QFR_TICKET_INVALID') === 'credential');
  ok('B2_404_unavailable', policy.classifyTicketFailure(404, '') === 'unavailable');
  ok('B3_network', [0, 429, 500, 502, 503].every((s) => policy.classifyTicketFailure(s, '') === 'network'));
  ok('B4_anon_401_403_409_credential', [401, 403, 409].every((s) => policy.classifyTicketFailure(s, '') === 'credential'));
  ok('B5_other_unknown', policy.classifyTicketFailure(400, '') === 'unknown' && policy.classifyTicketFailure(418, 'QFR_WEIRD') === 'unknown');

  // ---------- C 申领 ----------
  {
    const now = { sec: 1790000000, ms: 1790000000000 };
    const { store, calls, timers } = makeStore(() => ({ status: 200, json: validTicket({ session_id: store.getSessionId() }) }), now);
    store.startSession();
    const sid = store.getSessionId();
    const r = await store.issue({ deviceId: 'test-device-1' });
    ok('C1_issue_ok_stores_ticket', r.ok === true && store.hasUsableTicket() === true &&
      store.getTicketInfo().apiKeyId === 'k_abcdefghij' && store.getTicketInfo().resumePrefix === '01234567' &&
      store.getTicketInfo().sessionId === sid, { sessionId: sid });
    ok('C2_issue_request_shape', calls.length === 1 && calls[0].method === 'POST' &&
      calls[0].url === 'https://app.qfremote.top/api/lea/v1/reconnect/issue' &&
      calls[0].body.device_id === 'test-device-1' && calls[0].body.session_id === sid);
    ok('C3_describe_no_secret', (() => { const d = store.describeForLog(); return d.indexOf(SIG64) < 0 && d.indexOf('resume=01234567') >= 0 && d.indexOf('key=k_abcdefghij') >= 0; })());
    ok('C4_roll_scheduled_60s_before_expiry', timers.length === 1 && timers[0].ms === 240000 && store.msUntilRoll() === 240000, { ms: timers.length ? timers[0].ms : -1 });
    const r2 = await store.ensureTicket({ deviceId: 'test-device-1' });
    ok('C5_ensure_reuses_ticket', r2.ok === true && r2.reused === true && calls.length === 1);
  }
  {
    const now = { sec: 1790000000, ms: 1790000000000 };
    const { store, calls } = makeStore(() => ({ status: 404, json: null, text: 'not found' }), now);
    store.startSession();
    const r = await store.issue({ deviceId: 'test-device-1' });
    ok('C6_issue_404_unavailable_no_ticket', r.ok === false && r.kind === 'unavailable' && store.hasUsableTicket() === false && calls.length === 1);
  }
  {
    const now = { sec: 1790000000, ms: 1790000000000 };
    const { store } = makeStore(() => ({ status: 401, json: { ok: false, code: 'QFR_API_KEY_REVOKED', msg: 'revoked' } }), now);
    store.startSession();
    const r = await store.issue({ deviceId: 'test-device-1' });
    ok('C7_issue_credential_no_ticket', r.ok === false && r.kind === 'credential' && r.code === 'QFR_API_KEY_REVOKED' && store.hasUsableTicket() === false);
  }
  {
    const now = { sec: 1790000000, ms: 1790000000000 };
    const { store } = makeStore(() => ({ status: 200, json: validTicket({ expires_at: 1790000299 }) }), now);
    store.startSession();
    const r = await store.issue({ deviceId: 'test-device-1' });
    ok('C8_issue_200_invalid_ticket_rejected', r.ok === false && r.kind === 'credential' && r.code === 'QFR_TICKET_INVALID' && store.hasUsableTicket() === false);
  }
  {
    const now = { sec: 1790000000, ms: 1790000000000 };
    const { store, calls } = makeStore(() => ({ status: 200, json: validTicket({ session_id: store.getSessionId() }) }), now);
    store.startSession();
    const r1 = await store.issue({ deviceId: 'test-device-1' });
    const r2 = await store.issue({ deviceId: 'test-device-1' });
    ok('C9_issue_rate_limited_5s', r1.ok === true && r2.ok === false && r2.kind === 'rate-limited' && calls.length === 1);
  }
  {
    // F-WIN-08：issue() 网络失败不消耗 5 秒签发窗口——失败后立即再
    // issue() 不得被挡成 rate-limited（服务端根本没收到请求）。
    const now = { sec: 1790000000, ms: 1790000000000 };
    const { store, calls } = makeStore(() => { throw new Error('net down'); }, now);
    store.startSession();
    const r1 = await store.issue({ deviceId: 'test-device-1' });
    const r2 = await store.issue({ deviceId: 'test-device-1' });
    ok('C11_issue_network_no_window_consumed', r1.ok === false && r1.kind === 'network' && r2.ok === false && r2.kind === 'network' && calls.length === 2);
  }
  {
    const now = { sec: 1790000000, ms: 1790000000000 };
    const { store, calls } = makeStore(() => ({ status: 200, json: validTicket() }), now);
    const r = await store.issue({ deviceId: 'test-device-1' });
    ok('C10_issue_without_session', r.ok === false && r.kind === 'no-session' && calls.length === 0);
  }

  // ---------- D 恢复 ----------
  {
    // D1：成功即消费——body 原样即票据全文，成功后内存票据丢弃。
    const now = { sec: 1790000000, ms: 1790000000000 };
    const m = makeStore((method, url, body) => {
      if (url.endsWith('/reconnect/issue')) return { status: 200, json: validTicket({ session_id: m.store.getSessionId() }) };
      return { status: 200, json: { ok: true, session_id: m.store.getSessionId(), device_id: 'test-device-1', binding_epoch: 3, grant_epoch: 1 } };
    }, now);
    m.store.startSession();
    const rIssue = await m.store.issue({ deviceId: 'test-device-1' });
    const resumeCallBefore = m.calls.length;
    const r = await m.store.resume();
    const resumeCall = m.calls[resumeCallBefore];
    ok('D1_resume_ok_consumes_ticket', rIssue.ok === true && r.ok === true && r.sessionId === m.store.getSessionId() &&
      m.store.hasUsableTicket() === false && resumeCall && resumeCall.url.endsWith('/reconnect/resume') &&
      JSON.stringify(resumeCall.body) === JSON.stringify(validTicket({ session_id: m.store.getSessionId() })));
  }
  {
    // D2：7 个凭据码一律丢票据、立即停。
    const codes = policy.TICKET_CREDENTIAL_CODES;
    let allOk = true;
    for (const code of codes) {
      const now = { sec: 1790000000, ms: 1790000000000 };
      const m = makeStore((method, url) => {
        if (url.endsWith('/reconnect/issue')) return { status: 200, json: validTicket({ session_id: m.store.getSessionId() }) };
        return { status: code === 'QFR_API_KEY_REVOKED' ? 401 : code === 'QFR_BINDING_CHANGED' ? 409 : 403, json: { ok: false, code, msg: code } };
      }, now);
      m.store.startSession();
      await m.store.issue({ deviceId: 'test-device-1' });
      const r = await m.store.resume();
      if (!(r.ok === false && r.kind === 'credential' && r.code === code && m.store.hasUsableTicket() === false)) allOk = false;
    }
    ok('D2_resume_credential_codes_stop_and_drop', allOk === true, { codes: codes.length });
  }
  {
    // D3：本地已过期——不发请求，直接按 EXPIRED。
    const now = { sec: 1790000000, ms: 1790000000000 };
    const m = makeStore((method, url) => {
      if (url.endsWith('/reconnect/issue')) return { status: 200, json: validTicket({ session_id: m.store.getSessionId() }) };
      return { status: 200, json: { ok: true, session_id: m.store.getSessionId() } };
    }, now);
    m.store.startSession();
    await m.store.issue({ deviceId: 'test-device-1' });
    const callsBefore = m.calls.length;
    now.sec = 1790000301; // expires_at + 1
    const r = await m.store.resume();
    ok('D3_local_expired_no_request', r.ok === false && r.kind === 'credential' && r.code === 'QFR_TICKET_EXPIRED' &&
      m.calls.length === callsBefore && m.store.hasUsableTicket() === false);
  }
  {
    // D4/D5/D6：网络/404 保留票据；无票据不发请求。
    const now = { sec: 1790000000, ms: 1790000000000 };
    const m4 = makeStore((method, url) => {
      if (url.endsWith('/reconnect/issue')) return { status: 200, json: validTicket({ session_id: m4.store.getSessionId() }) };
      return { status: 502, json: null, text: '' };
    }, now);
    m4.store.startSession();
    await m4.store.issue({ deviceId: 'test-device-1' });
    const r4 = await m4.store.resume();
    ok('D4_resume_network_keeps_ticket', r4.ok === false && r4.kind === 'network' && m4.store.hasUsableTicket() === true);
    const m5 = makeStore((method, url) => {
      if (url.endsWith('/reconnect/issue')) return { status: 200, json: validTicket({ session_id: m5.store.getSessionId() }) };
      return { status: 404, json: null, text: '' };
    }, now);
    m5.store.startSession();
    await m5.store.issue({ deviceId: 'test-device-1' });
    const r5 = await m5.store.resume();
    ok('D5_resume_404_keeps_ticket', r5.ok === false && r5.kind === 'unavailable' && m5.store.hasUsableTicket() === true);
    const m6 = makeStore(() => ({ status: 200, json: {} }), now);
    m6.store.startSession();
    const r6 = await m6.store.resume();
    ok('D6_resume_no_ticket_no_request', r6.ok === false && r6.kind === 'no-ticket' && m6.calls.length === 0);
  }
  {
    // D7：回包 session 不符拒绝并丢票据。
    const now = { sec: 1790000000, ms: 1790000000000 };
    const m = makeStore((method, url) => {
      if (url.endsWith('/reconnect/issue')) return { status: 200, json: validTicket({ session_id: m.store.getSessionId() }) };
      return { status: 200, json: { ok: true, session_id: 'sess-ffffffffffffffff', device_id: 'test-device-1' } };
    }, now);
    m.store.startSession();
    await m.store.issue({ deviceId: 'test-device-1' });
    const r = await m.store.resume();
    ok('D7_resume_session_mismatch_rejected', r.ok === false && r.kind === 'credential' && r.code === 'QFR_TICKET_INVALID' && m.store.hasUsableTicket() === false);
  }

  // ---------- E 滚动续领 ----------
  {
    const now = { sec: 1790000000, ms: 1790000000000 };
    let issueCount = 0;
    const m = makeStore((method, url) => {
      if (url.endsWith('/reconnect/issue')) {
        issueCount++;
        return { status: 200, json: validTicket({ session_id: m.store.getSessionId(), resume_id: issueCount === 1 ? 'resume-0123456789abcdef' : 'resume-fedcba9876543210' }) };
      }
      return { status: 200, json: { ok: true, session_id: m.store.getSessionId() } };
    }, now);
    m.store.startSession();
    await m.store.issue({ deviceId: 'test-device-1' });
    const firstPrefix = m.store.getTicketInfo().resumePrefix;
    now.sec = 1790000006; now.ms = 1790000006000; // 距到期 294 秒，续领窗口已可领（>5 秒间隔）
    await m.timers[0].fn(); // 触发滚动续领
    ok('E1_roll_replaces_ticket', issueCount === 2 && m.store.getTicketInfo().resumePrefix === 'fedcba98' && firstPrefix === '01234567');
    ok('E2_roll_reschedules', m.timers.length === 2 && m.timers[1].ms === 234000, { timers: m.timers.length, ms1: m.timers[1] ? m.timers[1].ms : -1 });
    const timerId = m.timers[1];
    m.store.stopSession('logout');
    ok('E3_stop_clears_all', m.store.hasUsableTicket() === false && m.store.getSessionId() === null && timerId.cleared === true);
  }

  // ---------- F attemptResume ----------
  {
    const now = { sec: 1790000000, ms: 1790000000000 };
    const m = makeStore((method, url) => {
      if (url.endsWith('/reconnect/issue')) return { status: 200, json: validTicket({ session_id: m.store.getSessionId() }) };
      return { status: 200, json: { ok: true, session_id: m.store.getSessionId(), device_id: 'test-device-1', binding_epoch: 3, grant_epoch: 1 } };
    }, now);
    m.store.startSession();
    const r = await m.store.attemptResume({ deviceId: 'test-device-1' });
    ok('F1_attempt_issue_then_resume_ok', r.ok === true && m.calls.length === 2 && m.store.hasUsableTicket() === false);
  }
  {
    const now = { sec: 1790000000, ms: 1790000000000 };
    const m = makeStore((method, url) => {
      if (url.endsWith('/reconnect/issue')) return { status: 401, json: { ok: false, code: 'QFR_API_KEY_REVOKED', msg: '' } };
      return { status: 200, json: { ok: true, session_id: 'sess-0000000000000000' } };
    }, now);
    m.store.startSession();
    const r = await m.store.attemptResume({ deviceId: 'test-device-1' });
    ok('F2_attempt_issue_credential_stops_no_resume', r.ok === false && r.kind === 'credential' && r.code === 'QFR_API_KEY_REVOKED' &&
      m.calls.length === 1 && m.calls[0].url.endsWith('/reconnect/issue'));
  }
  {
    const now = { sec: 1790000000, ms: 1790000000000 };
    const m = makeStore((method, url) => {
      if (url.endsWith('/reconnect/issue')) return { status: 200, json: validTicket({ session_id: m.store.getSessionId() }) };
      return { status: 0, json: null, text: '' };
    }, now);
    m.store.startSession();
    await m.store.issue({ deviceId: 'test-device-1' });
    const r = await m.store.attemptResume({ deviceId: 'test-device-1' });
    ok('F3_attempt_resume_network_keeps_ticket', r.ok === false && r.kind === 'network' && m.store.hasUsableTicket() === true);
  }

  // ---------- G 看护接线 ----------
  function fakeWc(stateFn, onClick) {
    return {
      isDestroyed: () => false,
      executeJavaScript: async (js) => {
        if (js === CLICK_JS) { onClick(); return true; }
        if (js === DETECT_JS) return stateFn();
        return 'unknown';
      }
    };
  }
  {
    let state = 'disconnected';
    let clicks = 0;
    const events = [];
    const wd = createWatchdog(() => fakeWc(() => state, () => { clicks++; }), {
      pollMs: 50, confirmScans: 1, backoffStartMs: 50, backoffMaxMs: 100,
      maxAttempts: 5, onStatus: (s, info) => events.push(info && info.reason ? s + ':' + info.reason : s), log: () => {},
      onBeforeReconnect: async () => ({ stop: true, code: 'QFR_API_KEY_REVOKED' })
    });
    wd.start();
    await sleep(1500);
    wd.stop();
    ok('G1_ticket_credential_stops_no_click', clicks === 0 && events.some((e) => e === 'reconnect-stopped:QFR_API_KEY_REVOKED'), { clicks, events });
  }
  {
    let state = 'disconnected';
    let clicks = 0;
    const wd = createWatchdog(() => fakeWc(() => state, () => { clicks++; }), {
      pollMs: 50, confirmScans: 1, backoffStartMs: 50, backoffMaxMs: 100,
      maxAttempts: 5, onStatus: () => {}, log: () => {},
      onBeforeReconnect: async () => ({ proceed: true, resumed: true })
    });
    wd.start();
    await sleep(1200);
    wd.stop();
    ok('G2_ticket_resume_proceeds_to_click', clicks >= 1, { clicks });
  }
  {
    let state = 'disconnected';
    let clicks = 0;
    let recovered = 0;
    const wd = createWatchdog(() => fakeWc(() => state, () => { clicks++; }), {
      pollMs: 50, confirmScans: 1, backoffStartMs: 50, backoffMaxMs: 100,
      maxAttempts: 5, onStatus: () => {}, log: () => {},
      onBeforeReconnect: async () => { throw new Error('hook boom'); },
      onRecovered: () => { recovered++; }
    });
    wd.start();
    await sleep(1200);
    state = 'ok';
    await sleep(600);
    wd.stop();
    ok('G3_hook_throw_still_clicks_and_recovered_fires', clicks >= 1 && recovered === 1, { clicks, recovered });
  }

  // ---------- H 静态接线 ----------
  {
    const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    ok('H1_main_requires_ticket_module', mainSrc.includes("require('./reconnect-ticket')"));
    ok('H2_main_watchdog_hooks', mainSrc.includes('onBeforeReconnect') && mainSrc.includes('onRecovered') &&
      mainSrc.includes('ticketResumeBeforeReconnect') && mainSrc.includes('ticketRecoveredToastAndReissue'));
    ok('H3_main_login_issues_ticket', mainSrc.includes('refreshReconnectTicketAfterLogin()'));
    ok('H4_main_logout_clears_ticket', mainSrc.includes("reconnectTicketStore.stopSession('logout')"));
    ok('H5_main_stopped_carries_reason', mainSrc.includes("broadcastConnStatus(state, info)"));
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    ok('H6_package_build_files', Array.isArray(pkg.build.files) && pkg.build.files.includes('reconnect-ticket.js'));
    const toolbarSrc = fs.readFileSync(path.join(__dirname, '..', 'toolbar.html'), 'utf8');
    ok('H7_toolbar_reason_text', toolbarSrc.includes('ticketStopReasonText') &&
      ['QFR_API_KEY_REVOKED', 'QFR_TICKET_REUSED', 'QFR_TICKET_EXPIRED', 'QFR_BINDING_CHANGED',
       'QFR_GRANT_REVOKED', 'QFR_SCOPE_DENIED', 'QFR_LEA_NOT_BOUND'].every((c) => toolbarSrc.includes(c)));
    const watchdogSrc = fs.readFileSync(path.join(__dirname, '..', 'watchdog.js'), 'utf8');
    ok('H8_watchdog_ticket_hooks', watchdogSrc.includes('onBeforeReconnect') && watchdogSrc.includes('onRecovered') &&
      watchdogSrc.includes("opts.onStatus('reconnect-stopped'"));
    const violations = runChecks(path.join(__dirname, '..'));
    ok('H9_build_check_zero_violations', violations.length === 0, { violations: violations.slice(0, 3) });
    const ticketSrc = fs.readFileSync(path.join(__dirname, '..', 'reconnect-ticket.js'), 'utf8');
    ok('H10_ticket_never_persisted', !/writeFileSync|appendFileSync|saveSettings|localStorage/.test(ticketSrc) &&
      ticketSrc.includes('只存内存'));
  }

  // ---------- I 全形／裸形设备 id 归一 ----------
  {
    // I1：全形 id 申领成功——服务端（假 request）返裸形票据；未修复前
    //   此处误判 session-or-device-mismatch 丢票（联调一次性脚本实证
    //   的失败形态：{ ok:false, kind:'credential',
    //   code:'QFR_TICKET_INVALID', reason:'session-or-device-mismatch' }）。
    const now = { sec: 1790000000, ms: 1790000000000 };
    const { store, calls } = makeStore(() => ({ status: 200, json: validTicket({ session_id: store.getSessionId() }) }), now);
    store.startSession();
    const r = await store.issue({ deviceId: 'node//test-device-1' });
    ok('I1_issue_fullform_ok', r.ok === true && store.hasUsableTicket() === true, { kind: r.kind, code: r.code, reason: r.reason });
    ok('I2_issue_fullform_sends_bare', calls.length === 1 && calls[0].body.device_id === 'test-device-1');
  }
  {
    // I3：全形 id 走 issue→resume 全流程通过，成功即消费（票据丢弃）。
    const now = { sec: 1790000000, ms: 1790000000000 };
    const m = makeStore((method, url, body) => {
      if (url.endsWith('/reconnect/issue')) return { status: 200, json: validTicket({ session_id: m.store.getSessionId() }) };
      return { status: 200, json: { ok: true, session_id: m.store.getSessionId(), device_id: 'test-device-1', binding_epoch: 3, grant_epoch: 1 } };
    }, now);
    m.store.startSession();
    const rIssue = await m.store.issue({ deviceId: 'node//test-device-1' });
    const r = await m.store.resume();
    ok('I3_fullform_issue_resume_flow_ok', rIssue.ok === true && r.ok === true && m.store.hasUsableTicket() === false && m.calls.length === 2);
  }
  {
    // I4：真不符仍拒绝——全形 other-device 与裸形 test-device-1 不是同一设备。
    const now = { sec: 1790000000, ms: 1790000000000 };
    const { store } = makeStore(() => ({ status: 200, json: validTicket({ session_id: store.getSessionId() }) }), now);
    store.startSession();
    const r = await store.issue({ deviceId: 'node//other-device' });
    ok('I4_real_mismatch_still_rejected', r.ok === false && r.kind === 'credential' && r.code === 'QFR_TICKET_INVALID' &&
      r.reason === 'session-or-device-mismatch' && store.hasUsableTicket() === false);
  }
  {
    // I5：bareNodeId 归一单元——只去一层 node// 前缀，裸形／空／非串兜底。
    ok('I5_bareNodeId', typeof ticketMod.bareNodeId === 'function' &&
      ticketMod.bareNodeId('node//a//b') === 'a//b' && ticketMod.bareNodeId('plain') === 'plain' &&
      ticketMod.bareNodeId('') === '' && ticketMod.bareNodeId(null) === '' && ticketMod.bareNodeId('node//') === '');
  }

  const failed = Object.keys(result.cases).filter((k) => !result.cases[k].pass);
  result.pass = failed.length === 0;
  result.failed = failed;
  try { fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(result, null, 2)); } catch (e) { /* ignore */ }
  console.log(JSON.stringify({ pass: result.pass, failed }));
  process.exit(result.pass ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
