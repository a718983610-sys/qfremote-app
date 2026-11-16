'use strict';
/*
 * RC-09 Windows 画质四档＋探针＋ACK＋背压测试（QF-QUALITY-1 规范 v1，3.0.0）：
 *  A. 档位表与 splitTierChange 与服务端 quality-core.js 一致。
 *  B. 探针校验：缺必填字段不发请求；lossSamples<50 仍发＋记降权；
 *     值域外仍发＋记降权；lossPct 原样上报（下行，不取平均）。
 *  C. 探针周期：正常 1s、弱网/切换后 10s 内 500ms、隐藏 5s。
 *  D. 降档端到端（真服务端 quality-core 作假服务端）：严重坏连续
 *     2 样本降档；hot 先行、reconfig 其后、needsIdr 发 IDR＋清旧参考
 *     帧、5s 内 ACK；fec 中间值 10% 映射待定、不发明 (k,m)。
 *  E. 执行失败：编码器拒绝重配 → 保持旧档位、不伪造 ACK。
 *  F. ACK 超时：只记日志、不重发；UNKNOWN_DECISION 不再重试同一 id。
 *  G. 手动升档：健康窗口 20s/≥5 样本升档成功；AT_TOP / NO_HEALTH_
 *     WINDOW / NOT_HEALTHY / PINGPONG_COOLDOWN（带 retryAfterMs）拒绝
 *     映射。
 *  H. 背压：L1/L2/L3 执行动作；仅自报堆积（hint-only）不擅自降档；
 *     L3 走受控 IDR（reason=loss）。
 *  I. 探针定时发送与升档入口提示。
 * 本测试的假服务端直接用服务端 quality-core.js 原模块（同一判定逻辑），
 * 客户端只走 HTTP 形状。结果写 JSON 到 QFTEST_OUT，退出码 0=通过。
 */
const fs = require('fs');
const path = require('path');
const qualityMod = require('../qf-quality');
const serverQuality = require('../../server/ext/quality-core');

const OUT = process.env.QFTEST_OUT || '/tmp/qfr-rc09-quality/rc09-quality-result.json';
const result = { cases: {}, pass: false };
const ok = (name, cond, extra) => { result.cases[name] = Object.assign({ pass: !!cond }, extra || {}); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 可控时钟＋可控定时器。
function makeClock(startMs) {
  let now = startMs;
  return { now: () => now, set: (v) => { now = v; }, add: (ms) => { now += ms; } };
}
function makeTimer() {
  const timers = [];
  const timer = {
    setTimeout: (fn, ms) => { const id = timers.length; timers.push({ fn, ms, cleared: false }); return id; },
    clearTimeout: (id) => { if (timers[id]) timers[id].cleared = true; }
  };
  return { timer, timers, fire: (id) => { if (timers[id] && !timers[id].cleared) timers[id].fn(); } };
}

// 假服务端：直接用服务端 quality-core 原模块。
function makeFakeServer(clock) {
  const sessions = new Map();
  const calls = [];
  const request = async (method, url, body) => {
    calls.push({ method, url, body });
    const u = new URL(url);
    const p = u.pathname;
    if (method === 'POST' && p === '/license/api/session/probe') {
      let qs = sessions.get(body.sessionId);
      if (!qs) {
        qs = serverQuality.createQualitySession({ log: () => {}, initialTier: String(body.tier || ''), tierTable: undefined });
        sessions.set(body.sessionId, qs);
      }
      const out = qs.ingestProbe(body.probe || {}, clock.now());
      const bp = qs.backpressure(body.probe || {}, body.serverSignal || null, clock.now());
      qs.sweepAcks(clock.now());
      return { status: 200, json: { ok: true, tier: qs.tier(), decision: out, backpressure: bp } };
    }
    if (method === 'POST' && p === '/license/api/session/quality/upgrade') {
      const qs = sessions.get(String(body.sessionId || ''));
      if (!qs) return { status: 200, json: { ok: false, code: 'NOT_FOUND' } };
      return { status: 200, json: qs.requestUpgrade(clock.now()) };
    }
    if (method === 'POST' && p === '/license/api/session/quality/ack') {
      const qs = sessions.get(String(body.sessionId || ''));
      if (!qs) return { status: 200, json: { ok: false, code: 'NOT_FOUND' } };
      return { status: 200, json: qs.ack(String(body.decisionId || ''), clock.now()) };
    }
    return { status: 404, json: { ok: false, code: 'NOT_FOUND' } };
  };
  return { request, calls, sessions };
}

function healthyProbe() { return { rttMs: 100, lossPct: 0.2, lossSamples: 120, jitterMs: 10, decodeLagMs: 40, pendingFrames: 2 }; }
function severeProbe() { return { rttMs: 900, lossPct: 25, lossSamples: 120, jitterMs: 60, decodeLagMs: 100, pendingFrames: 2 }; }

(async () => {
  // ---------- A. 档位表与拆分 ----------
  {
    ok('A1_tier-table_matches-server', JSON.stringify(qualityMod.DEFAULT_TIER_TABLE) === JSON.stringify(serverQuality.DEFAULT_TIER_TABLE));
    ok('A2_tiers', JSON.stringify(qualityMod.TIERS) === JSON.stringify(serverQuality.TIERS) && qualityMod.DEFAULT_TIER === serverQuality.DEFAULT_TIER);
    const split = qualityMod.splitTierChange(serverQuality.DEFAULT_TIER_TABLE.clear, serverQuality.DEFAULT_TIER_TABLE.balanced);
    const srvSplit = serverQuality.splitTierChange(serverQuality.DEFAULT_TIER_TABLE.clear, serverQuality.DEFAULT_TIER_TABLE.balanced);
    ok('A3_splitTierChange_matches-server', JSON.stringify(split) === JSON.stringify(srvSplit) && split.hot.targetKbps === 2500 && split.reconfig.resolutionScale === 0.75);
    ok('A4_thresholds', qualityMod.BAD.rttMs === 300 && qualityMod.SEVERE.lossPct === 20 && qualityMod.HEALTHY.rttMs === 150);
  }

  // ---------- B. 探针校验 ----------
  {
    const clock = makeClock(1790000000000);
    const srv = makeFakeServer(clock);
    const logs = [];
    const client = qualityMod.createQualityClient({ request: srv.request, baseUrl: 'https://app.qfremote.top', sessionId: 'sess-0123456789abcdef', initialTier: 'balanced', log: (m) => logs.push(m), nowMs: clock.now });
    // F-WIN-05：初始档 balanced 的 fecRepairPercent=10 无映射，初始化
    // 回落 'high' 时即记日志，不只在收到 hot 参数时才记。
    ok('B0_init-fec-unmapped-logged', logs.some((l) => l.indexOf('fec-repair-unmapped init tier=balanced pct=10') >= 0));
    const before = srv.calls.length;
    const r1 = await client.submitProbe({ lossPct: 0.5, jitterMs: 10 });
    ok('B1_missing-rtt_not-sent', r1.ok === false && r1.kind === 'probe-incomplete' && srv.calls.length === before);
    const r2 = await client.submitProbe({ rttMs: 100, lossPct: 0.5, lossSamples: 20, jitterMs: 10 });
    ok('B2_lossSamples-under-50_sent-downweighted', r2.ok === true && logs.some((l) => l.indexOf('lossSamples<50') >= 0));
    const r3 = await client.submitProbe({ rttMs: 99999, lossPct: 0.5, lossSamples: 120, jitterMs: 10 });
    ok('B3_out-of-range_sent-downweighted', r3.ok === true && logs.some((l) => l.indexOf('rttMs') >= 0));
    const lastProbeBody = srv.calls[srv.calls.length - 1].body;
    ok('B4_lossPct-passthrough', lastProbeBody.probe.lossPct === 0.5 && lastProbeBody.probe.rttMs === 99999);
    ok('B5_no-secrets-in-probe', JSON.stringify(lastProbeBody).indexOf('signature') < 0 && JSON.stringify(lastProbeBody).indexOf('grant') < 0);
  }

  // ---------- C. 探针周期 ----------
  {
    ok('C1_intervals', qualityMod.probeIntervalMs({}) === 1000 && qualityMod.probeIntervalMs({ weak: true }) === 500 && qualityMod.probeIntervalMs({ hidden: true }) === 5000 && qualityMod.probeIntervalMs({ hidden: true, weak: true }) === 5000);
    const clock = makeClock(1790000000000);
    const srv = makeFakeServer(clock);
    const client = qualityMod.createQualityClient({ request: srv.request, baseUrl: 'https://app.qfremote.top', sessionId: 'sess-0123456789abcdef', initialTier: 'balanced', log: () => {}, nowMs: clock.now });
    ok('C2_initial-interval_normal', client.currentIntervalMs() === 1000);
  }

  // ---------- D. 降档端到端 ----------
  {
    const clock = makeClock(1790000000000);
    const srv = makeFakeServer(clock);
    const logs = [];
    const applyOrder = [];
    const idrCalls = [];
    let cleared = 0;
    const client = qualityMod.createQualityClient({
      request: srv.request, baseUrl: 'https://app.qfremote.top', sessionId: 'sess-0123456789abcdef',
      initialTier: 'clear', log: (m) => logs.push(m), nowMs: clock.now,
      idrSender: { sendQualityChange: async () => { idrCalls.push('quality-change'); return { ok: true }; }, sendLoss: async () => { idrCalls.push('loss'); return { ok: true }; } },
      applyParams: (kind, params) => { applyOrder.push(kind + ':' + Object.keys(params).join(',')); return true; },
      onClearReferenceFrames: () => { cleared += 1; }
    });
    const r1 = await client.submitProbe(severeProbe());
    ok('D1_first-severe_hold', r1.ok === true && (!r1.decision || r1.decision.decision === null) && client.getTier() === 'clear');
    clock.add(1000);
    const r2 = await client.submitProbe(severeProbe());
    ok('D2_second-severe_downgrade', r2.ok === true && r2.decision && r2.decision.decision === 'downgrade-to' && r2.decision.from === 'clear' && r2.decision.to === 'balanced');
    ok('D3_hot-before-reconfig', applyOrder[0].indexOf('hot:') === 0 && applyOrder[1].indexOf('reconfig:') === 0);
    ok('D4_hot-values', applyOrder[0].indexOf('targetKbps') >= 0);
    ok('D5_idr-and-clear-ref', idrCalls.join(',') === 'quality-change' && cleared === 1);
    ok('D6_ack-sent', r2.executed && r2.executed.ok === true && r2.executed.ack && r2.executed.ack.ok === true && r2.executed.ack.kind === 'downgrade');
    ok('D7_tier-now-balanced', client.getTier() === 'balanced' && client.getUiState().pendingAck === null);
    ok('D8_fec-10pct-unmapped-kept', logs.some((l) => l.indexOf('fec-repair-unmapped') >= 0) && client.getAppliedFecTier() === 'high');
    // 再降一档到 smooth：注意服务端 severeStreak 在降档后不清零，下一个
    // 严重样本（距上次降档已 4s ≥ 3s 最小间隔）即再次降档。
    clock.add(4000);
    const r3 = await client.submitProbe(severeProbe());
    ok('D9_downgrade-to-smooth', r3.decision && r3.decision.to === 'smooth' && client.getTier() === 'smooth');
    ok('D10_fec-5pct-mapped-low', client.getAppliedFecTier() === 'low');
    // 已在 smooth：不再降，会话保持。
    clock.add(4000);
    await client.submitProbe(severeProbe());
    clock.add(1000);
    const r4 = await client.submitProbe(severeProbe());
    ok('D11_smooth-floor_holds', (!r4.decision || r4.decision.decision === null) && client.getTier() === 'smooth');
  }

  // ---------- E. 执行失败不伪造 ACK ----------
  {
    const clock = makeClock(1790000000000);
    const srv = makeFakeServer(clock);
    let ackCalls = 0;
    const reqCount = async (method, url, body) => {
      if (url.indexOf('/ack') >= 0) ackCalls += 1;
      return srv.request(method, url, body);
    };
    const client = qualityMod.createQualityClient({
      request: reqCount, baseUrl: 'https://app.qfremote.top', sessionId: 'sess-0123456789abcdef',
      initialTier: 'clear', log: () => {}, nowMs: clock.now,
      applyParams: (kind) => kind !== 'reconfig' // reconfig 拒绝
    });
    await client.submitProbe(severeProbe());
    clock.add(1000);
    const r = await client.submitProbe(severeProbe());
    ok('E1_apply-failed_no-ack', r.decision && r.decision.decision === 'downgrade-to' && r.executed && r.executed.ok === false && r.executed.kind === 'apply-failed');
    ok('E2_apply-failed_old-tier-kept', client.getTier() === 'clear' && ackCalls === 0 && client.getUiState().pendingAck === null);
  }

  // ---------- F. ACK 超时与未知决策 ----------
  {
    const clock = makeClock(1790000000000);
    const srv = makeFakeServer(clock);
    const t = makeTimer();
    const logs = [];
    let ackCalls = 0;
    const reqTimeout = async (method, url, body) => {
      if (url.indexOf('/ack') >= 0) { ackCalls += 1; throw new Error('ack net down'); }
      return srv.request(method, url, body);
    };
    const client = qualityMod.createQualityClient({
      request: reqTimeout, baseUrl: 'https://app.qfremote.top', sessionId: 'sess-0123456789abcdef',
      initialTier: 'clear', log: (m) => logs.push(m), nowMs: clock.now, timer: t.timer,
      idrSender: { sendQualityChange: async () => ({ ok: true }), sendLoss: async () => ({ ok: true }) }
    });
    await client.submitProbe(severeProbe());
    clock.add(1000);
    const r = await client.submitProbe(severeProbe());
    ok('F1_ack-network-fail_pending-kept', r.executed && r.executed.ack && r.executed.ack.kind === 'network' && client.getUiState().pendingAck !== null);
    // 超时（mustAckByMs = 决策时刻 + 5000）：只记日志、不重发。
    const ackTimerId = t.timers.length - 1;
    clock.add(6000);
    t.fire(ackTimerId);
    ok('F2_ack-timeout_logged-no-resend', logs.some((l) => l.indexOf('quality.ack-timeout') >= 0) && ackCalls === 1 && client.getUiState().pendingAck === null);
    // UNKNOWN_DECISION：同一 id 不再重试。
    const client2 = qualityMod.createQualityClient({ request: srv.request, baseUrl: 'https://app.qfremote.top', sessionId: 'sess-0123456789abcdef', initialTier: 'balanced', log: () => {}, nowMs: clock.now });
    const a1 = await client2.sendAck('qd_999');
    const ackCountBefore = srv.calls.filter((c) => c.url.indexOf('/ack') >= 0).length;
    const a2 = await client2.sendAck('qd_999');
    const ackCountAfter = srv.calls.filter((c) => c.url.indexOf('/ack') >= 0).length;
    ok('F3_unknown-decision_no-retry', a1.ok === false && a1.code === 'UNKNOWN_DECISION' && a2.ok === false && ackCountAfter === ackCountBefore);
  }

  // ---------- G. 手动升档 ----------
  {
    // 健康窗口：5 个健康样本、20s 内 → 升档成功。
    const clock = makeClock(1790000000000);
    const srv = makeFakeServer(clock);
    const client = qualityMod.createQualityClient({
      request: srv.request, baseUrl: 'https://app.qfremote.top', sessionId: 'sess-0123456789abcdef',
      initialTier: 'balanced', log: () => {}, nowMs: clock.now,
      idrSender: { sendQualityChange: async () => ({ ok: true }), sendLoss: async () => ({ ok: true }) }
    });
    for (let i = 0; i < 5; i++) { await client.submitProbe(healthyProbe()); clock.add(4000); }
    const up = await client.requestUpgrade();
    ok('G1_upgrade-healthy-window', up.ok === true && up.tier === 'clear' && up.executed && up.executed.ok === true);
    // AT_TOP。
    const up2 = await client.requestUpgrade(); // clear → original
    ok('G2_upgrade-to-original', up2.ok === true && up2.tier === 'original');
    const up3 = await client.requestUpgrade();
    ok('G3_at-top', up3.ok === false && up3.code === 'AT_TOP' && up3.message === '已是最高档');
    // NO_HEALTH_WINDOW：新会话未探针即升档。
    const clock2 = makeClock(1790000000000);
    const srv2 = makeFakeServer(clock2);
    const client2 = qualityMod.createQualityClient({ request: srv2.request, baseUrl: 'https://app.qfremote.top', sessionId: 'sess-aaaaaaaaaaaaaaaa', initialTier: 'balanced', log: () => {}, nowMs: clock2.now });
    await client2.submitProbe(healthyProbe()); // 只有 1 个样本，且会话不存在→NOT_FOUND？先探针建会话
    const up4 = await client2.requestUpgrade();
    ok('G4_no-health-window', up4.ok === false && (up4.code === 'NO_HEALTH_WINDOW' || up4.code === 'NOT_FOUND'));
    // NOT_HEALTHY：健康样本后混入坏样本。
    const clock3 = makeClock(1790000000000);
    const srv3 = makeFakeServer(clock3);
    const client3 = qualityMod.createQualityClient({ request: srv3.request, baseUrl: 'https://app.qfremote.top', sessionId: 'sess-bbbbbbbbbbbbbbbb', initialTier: 'balanced', log: () => {}, nowMs: clock3.now });
    for (let i = 0; i < 4; i++) { await client3.submitProbe(healthyProbe()); clock3.add(4000); }
    await client3.submitProbe({ rttMs: 500, lossPct: 8, lossSamples: 120, jitterMs: 80 });
    const up5 = await client3.requestUpgrade();
    ok('G5_not-healthy', up5.ok === false && up5.code === 'NOT_HEALTHY');
    // PINGPONG_COOLDOWN 拒绝映射（桩响应直给）。
    const client4 = qualityMod.createQualityClient({
      request: async () => ({ status: 200, json: { ok: false, code: 'PINGPONG_COOLDOWN', msg: '该档近期反复升降，冷却中。', retryAfterMs: 45000 } }),
      baseUrl: 'https://app.qfremote.top', sessionId: 'sess-cccccccccccccccc', initialTier: 'balanced', log: () => {}, nowMs: clock3.now
    });
    const up6 = await client4.requestUpgrade();
    ok('G6_pingpong-cooldown', up6.ok === false && up6.code === 'PINGPONG_COOLDOWN' && up6.retryAfterMs === 45000 && up6.message.indexOf('反复升降') >= 0);
    // 未上报探针的会话升档 → NOT_FOUND。
    const clock5 = makeClock(1790000000000);
    const srv5 = makeFakeServer(clock5);
    const client5 = qualityMod.createQualityClient({ request: srv5.request, baseUrl: 'https://app.qfremote.top', sessionId: 'sess-dddddddddddddddd', initialTier: 'balanced', log: () => {}, nowMs: clock5.now });
    const up7 = await client5.requestUpgrade();
    ok('G7_upgrade-before-probe_not-found', up7.ok === false && up7.code === 'NOT_FOUND');
    // G8（S-016／R-W2）：服务端放行升档、本地执行失败时，requestUpgrade
    // 不得顶层 ok:true 藏失败——须回 ok:false＋kind=apply-failed，且档位不变。
    const client6 = qualityMod.createQualityClient({
      request: srv5.request, baseUrl: 'https://app.qfremote.top', sessionId: 'sess-dddddddddddddddd',
      initialTier: 'balanced', log: () => {}, nowMs: clock5.now,
      applyParams: () => false // 全部应用都拒绝
    });
    for (let i = 0; i < 5; i++) { await client6.submitProbe(healthyProbe()); clock5.add(4000); }
    const up8 = await client6.requestUpgrade();
    ok('G8_upgrade-apply-failed_not-ok', up8.ok === false && up8.kind === 'apply-failed' && up8.executed && up8.executed.ok === false && client6.getTier() === 'balanced');
  }

  // ---------- H. 背压 ----------
  {
    const clock = makeClock(1790000000000);
    const srv = makeFakeServer(clock);
    const logs = [];
    const applied = [];
    const idrCalls = [];
    const client = qualityMod.createQualityClient({
      request: srv.request, baseUrl: 'https://app.qfremote.top', sessionId: 'sess-0123456789abcdef',
      initialTier: 'balanced', log: (m) => logs.push(m), nowMs: clock.now,
      idrSender: { sendQualityChange: async () => ({ ok: true }), sendLoss: async () => { idrCalls.push('loss'); return { ok: true }; } },
      applyParams: (kind, params) => { applied.push({ kind, params }); return true; }
    });
    // 仅自报堆积（1 样本、无服务端信号）：hint-only，不触发。
    const h1 = await client.submitProbe({ rttMs: 100, lossPct: 0.2, lossSamples: 120, jitterMs: 10, pendingFrames: 40 });
    ok('H1_hint-only_no-action', h1.backpressure && h1.backpressure.level === null && h1.backpressureExecuted && h1.backpressureExecuted.kind === 'none' && applied.length === 0 && idrCalls.length === 0);
    // 连续 3 样本堆积 → L1 reduce-fps。
    clock.add(1000);
    await client.submitProbe({ rttMs: 100, lossPct: 0.2, lossSamples: 120, jitterMs: 10, pendingFrames: 40 });
    clock.add(1000);
    const h3 = await client.submitProbe({ rttMs: 100, lossPct: 0.2, lossSamples: 120, jitterMs: 10, pendingFrames: 40 });
    ok('H2_sustained_L1', h3.backpressure && h3.backpressure.level === 'L1' && h3.backpressure.action === 'reduce-fps' && applied.some((a) => a.params.action === 'reduce-fps'));
    // 服务端队列高＋客户端堆积 → L2。
    clock.add(1000);
    const h4 = await client.submitProbe({ rttMs: 100, lossPct: 0.2, lossSamples: 120, jitterMs: 10, pendingFrames: 40 }, { queueBytes: 600 * 1024, sendBlockedMs: 0 });
    ok('H3_server-plus-client_L2', h4.backpressure && h4.backpressure.level === 'L2' && h4.backpressureExecuted && h4.backpressureExecuted.kind === 'L2');
    // frameCorrupt＋服务端队列高 → L3（丢弃到关键帧＋受控 IDR）。
    clock.add(1000);
    const h5 = await client.submitProbe({ rttMs: 100, lossPct: 0.2, lossSamples: 120, jitterMs: 10, pendingFrames: 40, frameCorrupt: true }, { queueBytes: 600 * 1024, sendBlockedMs: 0 });
    ok('H4_corrupt_L3_idr-loss', h5.backpressure && h5.backpressure.level === 'L3' && h5.backpressureExecuted && h5.backpressureExecuted.kind === 'L3' && idrCalls.join(',') === 'loss');
  }

  // ---------- I. 探针定时发送与升档入口提示 ----------
  {
    const clock = makeClock(1790000000000);
    const srv = makeFakeServer(clock);
    const t = makeTimer();
    const client = qualityMod.createQualityClient({ request: srv.request, baseUrl: 'https://app.qfremote.top', sessionId: 'sess-0123456789abcdef', initialTier: 'balanced', log: () => {}, nowMs: clock.now, timer: t.timer });
    const probeCount = () => srv.calls.filter((c) => c.url.indexOf('/probe') >= 0).length;
    client.startProbing(() => healthyProbe());
    ok('I1_first-tick-1000ms', t.timers.length === 1 && t.timers[0].ms === 1000 && probeCount() === 0);
    t.fire(0);
    await sleep(10);
    ok('I2_tick-sends-probe', probeCount() === 1);
    // 隐藏 → 5s。
    client.setHidden(true);
    ok('I3_hidden-interval-5000', client.currentIntervalMs() === 5000);
    client.setHidden(false);
    // 升档入口提示。
    const hint1 = client.canRequestUpgrade();
    ok('I4_can-upgrade-healthy', hint1.can === true);
    await client.submitProbe({ rttMs: 500, lossPct: 8, lossSamples: 120, jitterMs: 80 });
    const hint2 = client.canRequestUpgrade();
    ok('I5_cannot-upgrade-unhealthy', hint2.can === false);
    client.stopProbing();
    ok('I6_stopProbing_clears', client.getUiState().probing === false);
  }

  const failed = Object.keys(result.cases).filter((k) => !result.cases[k].pass);
  result.pass = failed.length === 0;
  try { fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(result, null, 2)); } catch (e) { /* ignore */ }
  console.log(JSON.stringify({ pass: result.pass, failed }));
  process.exit(result.pass ? 0 : 1);
})().catch((e) => {
  console.error(e && e.stack || e);
  process.exit(1);
});
