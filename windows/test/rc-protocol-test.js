'use strict';
/*
 * L3 协议客户端聚合层测试（qf-protocol.js，3.0.0）：
 *  A. bindSession：登记 sessionId/agentId 到 idr/quality；参数不全
 *     拒绝；getBound 回显。
 *  B. 交叉接线：探针触发降档 → IDR（reason=quality-change）＋清旧
 *     参考帧；档位变化向录制中的会话上报 quality-change 事件。
 *  C. unbindSession：停探针、尝试结束录制（best-effort）、清绑定；
 *     登出/关会话后各客户端不再持有会话。
 *  D. 聚合出口完备：fec/idr/relay/transfer/quality/recording 六件
 *     齐全，transfer/relay 初始态 idle/未降级。
 * 本测试用假 request（探针走服务端 quality-core 原模块），不发真实
 * 网络请求。结果写 JSON 到 QFTEST_OUT，退出码 0=通过。
 */
const fs = require('fs');
const path = require('path');
const protocolMod = require('../qf-protocol');
const serverQuality = require('../../server/ext/quality-core');

const OUT = process.env.QFTEST_OUT || '/tmp/qfr-rc-protocol/rc-protocol-result.json';
const result = { cases: {}, pass: false };
const ok = (name, cond, extra) => { result.cases[name] = Object.assign({ pass: !!cond }, extra || {}); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  let now = 1790000000000;
  const clock = { now: () => now, add: (ms) => { now += ms; } };
  const timers = [];
  const timer = {
    setTimeout: (fn, ms) => { const id = timers.length; timers.push({ fn, ms, cleared: false }); return id; },
    clearTimeout: (id) => { if (timers[id]) timers[id].cleared = true; }
  };
  const calls = [];
  const qSessions = new Map();
  // F-WIN-02 竞态用例：延迟 /end 落定，模拟“解绑中重绑”。
  let deferEnd = false;
  let endDeferred = null;
  let endResponse = null;
  const request = async (method, url, body) => {
    calls.push({ method, url, body });
    const u = new URL(url);
    const p = u.pathname;
    if (method === 'POST' && p === '/license/api/session/idr-request') {
      return { status: 200, json: { ok: true, decision: 'forward', code: 'OK', msg: '放行。' } };
    }
    if (method === 'POST' && p === '/license/api/session/probe') {
      let qs = qSessions.get(body.sessionId);
      if (!qs) { qs = serverQuality.createQualitySession({ log: () => {}, initialTier: 'balanced' }); qSessions.set(body.sessionId, qs); }
      const out = qs.ingestProbe(body.probe || {}, clock.now());
      const bp = qs.backpressure(body.probe || {}, body.serverSignal || null, clock.now());
      return { status: 200, json: { ok: true, tier: qs.tier(), decision: out, backpressure: bp } };
    }
    if (method === 'POST' && p === '/license/api/recordings/start') {
      return { status: 200, json: { ok: true, sessionId: body.sessionId || 'rec_0000000000000001' } };
    }
    if (method === 'POST' && /\/license\/api\/recordings\/[^/]+\/event$/.test(p)) {
      return { status: 200, json: { ok: true, events: 2 } };
    }
    if (method === 'POST' && /\/license\/api\/recordings\/[^/]+\/end$/.test(p)) {
      if (deferEnd) {
        return new Promise((resolve) => { endDeferred = () => resolve(endResponse || { status: 200, json: { ok: true, sessionId: 'sess-0123456789abcdef', events: 2, bytes: 100, index: [] } }); });
      }
      return { status: 200, json: { ok: true, sessionId: 'sess-0123456789abcdef', events: 2, bytes: 100, index: [] } };
    }
    return { status: 404, json: { ok: false, code: 'NOT_FOUND' } };
  };
  const requestRaw = async () => ({ status: 404, headers: {}, body: Buffer.alloc(0) });

  const proto = protocolMod.createQfProtocolClients({
    request, requestRaw, baseUrl: 'https://app.qfremote.top', log: () => {}, nowMs: clock.now, timer
  });

  // ---------- A. bind ----------
  ok('A1_exports-complete', !!proto.fec && !!proto.idr && !!proto.relay && !!proto.transfer && !!proto.quality && !!proto.recording);
  const bad = proto.bindSession({ sessionId: '', agentId: '' });
  ok('A2_bind-bad-args', bad.ok === false && proto.getBound() === null);
  const bound = proto.bindSession({ sessionId: 'sess-0123456789abcdef', agentId: 'agent-1', deviceId: 'd1', groupId: 'g1' });
  ok('A3_bind-ok', bound.ok === true && JSON.stringify(proto.getBound()) === JSON.stringify({ sessionId: 'sess-0123456789abcdef', agentId: 'agent-1' }));
  ok('A4_idr-bound', proto.idr.getSessionId() === 'sess-0123456789abcdef' && proto.idr.getAgentId() === 'agent-1');
  ok('A5_quality-bound', proto.quality.getSessionId() === 'sess-0123456789abcdef');

  // ---------- B. 交叉接线 ----------
  const recStart = await proto.recording.start({ sessionId: 'sess-0123456789abcdef', deviceId: 'd1', groupId: 'g1', tier: 'balanced' });
  ok('B0_recording-started', recStart.ok === true);
  const severe = { rttMs: 900, lossPct: 25, lossSamples: 120, jitterMs: 60, decodeLagMs: 100, pendingFrames: 2 };
  await proto.quality.submitProbe(severe);
  clock.add(1000);
  const r2 = await proto.quality.submitProbe(severe);
  await sleep(10); // onTierChange 的录制事件是 best-effort 异步
  ok('B1_downgrade-via-aggregator', r2.decision && r2.decision.decision === 'downgrade-to' && proto.quality.getTier() === 'smooth');
  const idrCall = calls.find((c) => c.url.indexOf('/idr-request') >= 0);
  ok('B2_idr-quality-change_sent', !!idrCall && idrCall.body.reason === 'quality-change' && idrCall.body.sessionId === 'sess-0123456789abcdef' && idrCall.body.agentId === 'agent-1');
  const recEventCall = calls.find((c) => c.url.indexOf('/recordings/') >= 0 && c.url.indexOf('/event') >= 0);
  ok('B3_quality-change-event_recorded', !!recEventCall && recEventCall.body.event.type === 'quality-change' && recEventCall.body.event.from === 'balanced' && recEventCall.body.event.to === 'smooth');

  // ---------- C. unbind ----------
  proto.quality.startProbing(() => ({ rttMs: 100, lossPct: 0.2, lossSamples: 120, jitterMs: 10 }));
  ok('C1_probing-started', proto.quality.getUiState().probing === true);
  const endCallsBefore = calls.filter((c) => c.url.indexOf('/end') >= 0).length;
  proto.unbindSession('session-close');
  await sleep(10);
  ok('C2_probing-stopped', proto.quality.getUiState().probing === false);
  ok('C3_recording-end-attempted', calls.filter((c) => c.url.indexOf('/end') >= 0).length === endCallsBefore + 1);
  ok('C4_bound-cleared', proto.getBound() === null && proto.idr.getSessionId() === '' && proto.quality.getSessionId() === '');
  ok('C5_recording-unbound', proto.recording.getState() === 'idle');

  // ---------- C6/C7/C8. F-WIN-02：解绑中重绑，旧 end() 落定不得清新会话 ----------
  // 延迟 /end：unbind 后、旧 end() 落定前重绑并 start 新录制。
  deferEnd = true;
  endResponse = { status: 200, json: { ok: true, sessionId: 'sess-0123456789abcdef', events: 2, bytes: 100, index: [] } };
  // C6：旧录制进行中 → 解绑 → 立即重绑＋start 新录制 → 旧 end() 才落定。
  proto.bindSession({ sessionId: 'sess-0123456789abcdef', agentId: 'agent-1', deviceId: 'd1', groupId: 'g1' });
  const oldStart = await proto.recording.start({ sessionId: 'sess-0123456789abcdef', deviceId: 'd1', groupId: 'g1', tier: 'balanced' });
  ok('C6_setup-old-recording', oldStart.ok === true && proto.recording.getState() === 'recording');
  proto.unbindSession('session-close');
  await sleep(10); // 旧 end() 已发出、尚未落定
  const newBound = proto.bindSession({ sessionId: 'sess-fedcba9876543210', agentId: 'agent-2', deviceId: 'd2', groupId: 'g2' });
  const newStart = await proto.recording.start({ sessionId: 'sess-fedcba9876543210', deviceId: 'd2', groupId: 'g2', tier: 'balanced' });
  ok('C6_new-recording-started', newBound.ok === true && newStart.ok === true && proto.recording.getState() === 'recording' && proto.recording.getSessionId() === 'sess-fedcba9876543210');
  endDeferred(); // 旧 end() 此时落定（200）
  await sleep(10);
  ok('C6_old-end-keeps-new-recording', proto.recording.getState() === 'recording' && proto.recording.getSessionId() === 'sess-fedcba9876543210');
  ok('C6_new-bound-intact', JSON.stringify(proto.getBound()) === JSON.stringify({ sessionId: 'sess-fedcba9876543210', agentId: 'agent-2' }));

  // C7：解绑后只重绑、不 start，旧 end() 落定后新绑定应为 idle 待启动
  //（旧 end() 的 ended 写与 .then() 的 unbind 仍须正常清理本届）。
  proto.unbindSession('session-close');
  await sleep(10);
  proto.bindSession({ sessionId: 'sess-1111111111111111', agentId: 'agent-3', deviceId: 'd3', groupId: 'g3' });
  endDeferred();
  await sleep(10);
  ok('C7_rebind-without-start-idle', proto.recording.getState() === 'idle' && proto.recording.getSessionId() === '');
  ok('C7_new-bound-intact', JSON.stringify(proto.getBound()) === JSON.stringify({ sessionId: 'sess-1111111111111111', agentId: 'agent-3' }));

  // C8：旧 end() 以 404（NOT_FOUND，中断）落定，同样不得碰新会话。
  proto.bindSession({ sessionId: 'sess-2222222222222222', agentId: 'agent-4', deviceId: 'd4', groupId: 'g4' });
  const s8 = await proto.recording.start({ sessionId: 'sess-2222222222222222', deviceId: 'd4', groupId: 'g4', tier: 'balanced' });
  ok('C8_setup-new-recording', s8.ok === true && proto.recording.getState() === 'recording');
  endResponse = { status: 404, json: { ok: false, code: 'NOT_FOUND' } };
  proto.unbindSession('session-close');
  await sleep(10);
  proto.bindSession({ sessionId: 'sess-3333333333333333', agentId: 'agent-5', deviceId: 'd5', groupId: 'g5' });
  const s8b = await proto.recording.start({ sessionId: 'sess-3333333333333333', deviceId: 'd5', groupId: 'g5', tier: 'balanced' });
  ok('C8_new-recording-started', s8b.ok === true && proto.recording.getSessionId() === 'sess-3333333333333333');
  endDeferred();
  await sleep(10);
  ok('C8_old-404-keeps-new-recording', proto.recording.getState() === 'recording' && proto.recording.getSessionId() === 'sess-3333333333333333');
  deferEnd = false;

  // ---------- D. 初始态 ----------
  ok('D1_transfer-idle', proto.transfer.getUiState().state === 'idle');
  ok('D2_relay-no-list-yet', proto.relay.getList() === null && proto.relay.getUiState().degraded === true);

  const failed = Object.keys(result.cases).filter((k) => !result.cases[k].pass);
  result.pass = failed.length === 0;
  try { fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(result, null, 2)); } catch (e) { /* ignore */ }
  console.log(JSON.stringify({ pass: result.pass, failed }));
  process.exit(result.pass ? 0 : 1);
})().catch((e) => {
  console.error(e && e.stack || e);
  process.exit(1);
});
