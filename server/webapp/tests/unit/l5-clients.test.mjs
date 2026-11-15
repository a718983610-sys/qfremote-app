// tests/unit/l5-clients.test.mjs — L5 客户端协议（RC-03/07/08/09/10）单测。
// 覆盖：中继选路/白名单、FEC RS 编解码与块头校验、画质分类与档位拆分、
// 录像事件清洗/seek/JSONL 解析、IDR 请求器、FEC 接收器、画质探针、
// 文件分片流、录制控制、回放器。假 fetch/假文件/手动时钟，不碰真网络。
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadWebapp, ManualScheduler, plain } from './load-webapp.mjs';

const ctx = loadWebapp();
const Q = ctx.__qf;

function jsonRes(body, status) {
  return { status: status || 200, ok: (status || 200) < 300, json: async () => body, headers: { get: () => null }, text: async () => JSON.stringify(body) };
}
function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init) => {
    const method = (init && init.method) || 'GET';
    calls.push({ url, method, body: init && init.body ? JSON.parse(init.body) : undefined, headers: (init && init.headers) || {} });
    for (const [match, handler] of routes) {
      if (typeof match === 'string' && url === match) return handler(calls[calls.length - 1]);
      if (match instanceof RegExp && match.test(url)) return handler(calls[calls.length - 1]);
    }
    return jsonRes({ ok: false, code: 'NO_ROUTE' }, 404);
  };
  fn.calls = calls;
  return fn;
}
function fakeFile(bytes, name) {
  return {
    name: name || 'test.bin', size: bytes.length,
    slice: (start, end) => ({ arrayBuffer: async () => bytes.slice(start, end).buffer }),
    arrayBuffer: async () => bytes.slice().buffer,
  };
}
function makeShards(k, m, shardLen) {
  const data = [];
  for (let i = 0; i < k; i++) {
    const b = new Uint8Array(shardLen);
    for (let j = 0; j < shardLen; j++) b[j] = (i * 37 + j * 11 + 5) % 256;
    data.push(b);
  }
  const enc = Q.qfRsEncode(data, k, m);
  return { data, shards: enc.data.concat(enc.parity) };
}
function fecHeader(k, m, blockId, frameId) {
  return {
    fecVersion: 1, blockId, frameId, isKeyframe: false, frameStart: true, frameEnd: true,
    symbolIndex: 0, symbolCount: k + m, symbolLength: 16, lastSymbolPadding: 0, k, m,
  };
}

test('RC-07 pickRelay：tier→priority→id 排序，在途满跳过，三级耗尽降级', () => {
  const list = [
    { id: 'b', url: 'https://r2.example.com/r/', tier: 2, priority: 50 },
    { id: 'a', url: 'https://r1.example.com/r/', tier: 1, priority: 10 },
    { id: 'c', url: 'https://r1.example.com/r2/', tier: 1, priority: 90 },
    { id: 'd', url: 'https://r3.example.com/r/', tier: 1, priority: 90 },
  ];
  assert.equal(Q.qfPickRelay(list, []).relay.id, 'c'); // tier 1 内 priority 90，c<d 字典序
  assert.equal(Q.qfPickRelay(list, ['c']).relay.id, 'd');
  assert.equal(Q.qfPickRelay(list, ['c', 'd', 'a']).relay.id, 'b');
  assert.equal(Q.qfPickRelay(list, ['a', 'b', 'c', 'd']).degraded, true);
  assert.equal(Q.qfPickRelay(list, ['a', 'b', 'c', 'd']).reason, 'all-tiers-exhausted');
  // 在途满：tier 1 已满 8，跳到 tier 2（不算失败）
  const p = Q.qfPickRelay(list, [], { inFlightByTier: { 1: 8, 2: 0, 3: 0 } });
  assert.equal(p.relay.id, 'b');
  assert.equal(p.reason, 'primary');
  // 各级在途都满 → tier-inflight-full
  const p2 = Q.qfPickRelay(list, [], { inFlightByTier: { 1: 8, 2: 8, 3: 8 } });
  assert.equal(p2.degraded, true);
  assert.equal(p2.reason, 'tier-inflight-full');
});

test('RC-07 isAllowedRelay：origin＋路径前缀；伪造/异源/非 http/空列表拒绝', () => {
  const list = [{ id: 'p', url: 'https://app.qfremote.top/console-engine/', tier: 1, priority: 100 }];
  assert.equal(Q.qfIsAllowedRelay('https://app.qfremote.top/console-engine/?node=abc&qfm=frame', list), true);
  assert.equal(Q.qfIsAllowedRelay('https://app.qfremote.top/console-engine/', list), true);
  assert.equal(Q.qfIsAllowedRelay('https://app.qfremote.top/other/', list), false);
  assert.equal(Q.qfIsAllowedRelay('https://evil.example.com/console-engine/', list), false);
  assert.equal(Q.qfIsAllowedRelay('ftp://app.qfremote.top/console-engine/', list), false);
  assert.equal(Q.qfIsAllowedRelay('https://app.qfremote.top/console-engine/', []), false);
  assert.equal(Q.qfRelayListExpired([{ issuedAt: Date.now() - 601000, ttlSec: 600 }]), true);
  assert.equal(Q.qfRelayListExpired([{ issuedAt: Date.now(), ttlSec: 600 }]), false);
});

test('RC-07 QFRelayClient：缓存＋TTL 过期重取，503 透传 L5_UNAVAILABLE，异源跳过', async () => {
  let n = 0;
  const now = Date.now();
  const fetchFn = fakeFetch([
    ['/license/api/relays', () => {
      n++;
      return jsonRes({ ok: true, relays: [
        { id: 'foreign', url: 'https://relay2.example.com/r/', tier: 1, priority: 200, ttlSec: 600, issuedAt: now },
        { id: 'qfremote-primary', url: 'https://example.test/console-engine/', tier: 1, priority: 100, ttlSec: 600, issuedAt: now },
      ] });
    }],
  ]);
  const c = Q.QFRelayClient({ fetchFn });
  const r1 = await c.fetchList();
  assert.equal(r1.ok, true);
  assert.equal(n, 1);
  await c.fetchList();
  assert.equal(n, 1); // 未过期用缓存
  const pick = c.pickFor(() => 'https://example.test/console-engine/?node=x&qfm=frame');
  assert.equal(pick.ok, true);
  assert.equal(pick.relay.id, 'qfremote-primary'); // 异源 tier-1（priority 更高）被跳过
  assert.deepEqual(Array.from(c.failedIds), ['foreign']);
  // 503 透传
  const c2 = Q.QFRelayClient({ fetchFn: fakeFetch([['/license/api/relays', () => jsonRes({ ok: false, code: 'L5_UNAVAILABLE' }, 503)]]) });
  const r2 = await c2.fetchList();
  assert.equal(r2.code, 'L5_UNAVAILABLE');
});

test('RC-03 FEC 块头校验：7 条非法条件逐条拒绝', () => {
  const good = fecHeader(10, 2, 1, 1);
  assert.equal(Q.qfValidateFecHeader(good).ok, true);
  const bad = [
    [{ ...good, fecVersion: 2 }, 'bad-version'],
    [{ ...good, m: 3 }, 'bad-m'],
    [{ ...good, k: 11 }, 'bad-k'],
    [{ ...good, symbolCount: 11 }, 'bad-symbol-count'],
    [{ ...good, symbolIndex: 12 }, 'bad-symbol-index'],
    [{ ...good, symbolLength: 0 }, 'bad-symbol-length'],
    [{ ...good, lastSymbolPadding: 16 }, 'bad-padding'],
  ];
  for (const [h, reason] of bad) {
    const v = Q.qfValidateFecHeader(h);
    assert.equal(v.ok, false, JSON.stringify(h));
    assert.equal(v.reason, reason);
  }
  // 校验宽松组合（k=10/m=1）头本身合法，但协议只许两档：映射函数不认
  assert.equal(Q.qfValidateFecHeader({ ...good, m: 1, symbolCount: 11 }).ok, true);
  assert.equal(Q.qfFecTierForRepairPercent(10), null); // balanced 10% 无映射
  assert.equal(Q.qfFecTierForRepairPercent(5), 'low');
  assert.equal(Q.qfFecTierForRepairPercent(20), 'high');
});

test('RC-03 RS 编解码：k=10/m=2 丢 2 可恢复，丢 3 不可恢复；k=20/m=1 丢 1 可恢复', () => {
  const { data, shards } = makeShards(10, 2, 16);
  const lengths = data.map((b) => b.length);
  const out0 = Q.qfRsDecode(shards, 10, 2, lengths);
  assert.equal(out0.length, 10);
  for (let i = 0; i < 10; i++) assert.deepEqual(plain(out0[i]), plain(data[i]));
  const lost2 = shards.slice();
  lost2[3] = null; lost2[7] = null;
  const out2 = Q.qfRsDecode(lost2, 10, 2, lengths);
  assert.notEqual(out2, null);
  for (let i = 0; i < 10; i++) assert.deepEqual(plain(out2[i]), plain(data[i]));
  const lost3 = shards.slice();
  lost3[1] = null; lost3[2] = null; lost3[3] = null;
  assert.equal(Q.qfRsDecode(lost3, 10, 2, lengths), null);
  // 校验分片也丢一个：1 数据丢＋1 校验丢 → 可用校验行不足
  const lostP = shards.slice();
  lostP[0] = null; lostP[10] = null;
  const outP = Q.qfRsDecode(lostP, 10, 2, lengths);
  assert.notEqual(outP, null); // 剩 1 行校验够解 1 个丢失
  const { data: d20, shards: s20 } = makeShards(20, 1, 8);
  const l20 = d20.map((b) => b.length);
  const lost1 = s20.slice(); lost1[19] = null;
  const out20 = Q.qfRsDecode(lost1, 20, 1, l20);
  assert.notEqual(out20, null);
  assert.deepEqual(plain(out20[19]), plain(d20[19]));
});

test('RC-03 QFFecReceiver：0 缺失直出、2 缺失 RS 恢复、3 缺失触发 IDR、坏头丢弃', () => {
  const sched = new ManualScheduler();
  const frames = [];
  const unrec = [];
  const recv = Q.QFFecReceiver({
    scheduler: sched,
    onFrame: (bufs) => frames.push(bufs),
    onUnrecoverable: (frameId) => unrec.push(frameId),
  });
  recv.setNetwork(10, 5); // 窗口 10+5+33=48ms
  const { data, shards } = makeShards(10, 2, 16);
  // 块 1：齐发 → 直接渲染
  for (let i = 0; i < 12; i++) {
    const h = fecHeader(10, 2, 1, 101); h.symbolIndex = i;
    recv.ingest(h, shards[i]);
  }
  assert.equal(frames.length, 1);
  assert.deepEqual(plain(frames[0][0]), plain(data[0]));
  // 块 2：丢 2 片（3、7），窗口届满后 RS 恢复
  for (let i = 0; i < 12; i++) {
    if (i === 3 || i === 7) continue;
    const h = fecHeader(10, 2, 2, 102); h.symbolIndex = i;
    recv.ingest(h, shards[i]);
  }
  assert.equal(frames.length, 1); // 窗口内等迟到分片，不立即判定
  sched.advance(50);
  assert.equal(frames.length, 2);
  assert.deepEqual(plain(frames[1][7]), plain(data[7]));
  // 块 3：丢 3 片 → 不可恢复
  for (let i = 0; i < 12; i++) {
    if (i === 1 || i === 2 || i === 3) continue;
    const h = fecHeader(10, 2, 3, 103); h.symbolIndex = i;
    recv.ingest(h, shards[i]);
  }
  sched.advance(50);
  assert.deepEqual(unrec, [103]);
  // 坏头整块丢弃
  const bad = fecHeader(10, 2, 4, 104); bad.fecVersion = 9;
  const r = recv.ingest(bad, shards[0]);
  assert.equal(r.ok, false);
  assert.equal(recv.stats.droppedBadHeader, 1);
});

test('RC-03 QFFecReceiver：结算后迟到分片直接丢弃，不建僵尸块、不误报不可恢复（S-058）', () => {
  const sched = new ManualScheduler();
  const frames = [];
  const unrec = [];
  const recv = Q.QFFecReceiver({
    scheduler: sched,
    onFrame: (bufs) => frames.push(bufs),
    onUnrecoverable: (frameId) => unrec.push(frameId),
  });
  recv.setNetwork(10, 5); // 窗口 10+5+33=48ms
  const { data, shards } = makeShards(10, 2, 16);
  // 块 1 齐发 → 直接渲染并结算
  for (let i = 0; i < 12; i++) {
    const h = fecHeader(10, 2, 1, 101); h.symbolIndex = i;
    recv.ingest(h, shards[i]);
  }
  assert.equal(frames.length, 1);
  assert.deepEqual(plain(frames[0][0]), plain(data[0]));
  // 迟到的重复分片（分片重传/网络复制）：直接丢弃，不建新块
  const late = fecHeader(10, 2, 1, 101); late.symbolIndex = 3;
  const r = recv.ingest(late, shards[3]);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'LATE_SHARD');
  assert.equal(recv.stats.droppedLateShard, 1);
  sched.advance(100); // 僵尸块若存在，会在窗口届满后按缺失数误报
  assert.deepEqual(unrec, []);
  assert.equal(frames.length, 1);
});

test('RC-03 QFIdrRequester：seq 单调递增、coalesced 不补发、COOLDOWN 门、非法 reason 拒绝', async () => {
  const seen = [];
  const fetchFn = fakeFetch([
    ['/license/api/session/idr-request', (call) => {
      seen.push(call.body);
      if (call.body.seq === 1) return jsonRes({ ok: true, decision: 'forward', code: 'OK' });
      if (call.body.seq === 2) return jsonRes({ ok: true, decision: 'coalesced', code: 'COALESCED' });
      if (call.body.seq === 3) return jsonRes({ ok: false, decision: 'rejected', code: 'COOLDOWN', retryAfterMs: 10000 });
      return jsonRes({ ok: true, decision: 'forward', code: 'OK' });
    }],
  ]);
  const idr = Q.QFIdrRequester({ fetchFn });
  const r1 = await idr.request('sess-0123456789abcdef', 'agent-1', 'join');
  assert.equal(r1.decision, 'forward');
  assert.equal(idr.seq, 1);
  const r2 = await idr.request('sess-0123456789abcdef', 'agent-1', 'loss');
  assert.equal(r2.decision, 'coalesced');
  assert.equal(idr.seq, 2);
  const r3 = await idr.request('sess-0123456789abcdef', 'agent-1', 'loss');
  assert.equal(r3.code, 'COOLDOWN');
  const r4 = await idr.request('sess-0123456789abcdef', 'agent-1', 'loss');
  assert.equal(r4.code, 'COOLDOWN'); // 冷却期内不再发（seq 不再涨）
  assert.equal(idr.seq, 3);
  assert.equal(seen.length, 3);
  const bad = await idr.request('sess-0123456789abcdef', 'agent-1', 'bogus');
  assert.equal(bad.code, 'BAD_REASON');
});

test('RC-09 画质分类与档位拆分：healthy/bad/severe 阈值、hot 与 reconfig 分离', () => {
  assert.equal(Q.qfQualityClassify({ rttMs: 100, lossPct: 0.5, jitterMs: 10 }), 'healthy');
  assert.equal(Q.qfQualityClassify({ rttMs: 100, lossPct: 0.5, jitterMs: 10, decodeLagMs: 200 }), 'neutral');
  assert.equal(Q.qfQualityClassify({ rttMs: 400, lossPct: 0.5, jitterMs: 10 }), 'bad');
  assert.equal(Q.qfQualityClassify({ rttMs: 100, lossPct: 6, jitterMs: 10 }), 'bad');
  assert.equal(Q.qfQualityClassify({ rttMs: 100, lossPct: 0.5, jitterMs: 60 }), 'bad');
  assert.equal(Q.qfQualityClassify({ rttMs: 900, lossPct: 0.5, jitterMs: 10 }), 'severe');
  assert.equal(Q.qfQualityClassify({ rttMs: 100, lossPct: 25, jitterMs: 10 }), 'severe');
  assert.equal(Q.qfQualityClassify({ rttMs: 100, lossPct: 0.5, jitterMs: 10, decodeLagMs: 600 }), 'severe');
  assert.equal(Q.qfQualityClassify({ rttMs: NaN, lossPct: 0.5, jitterMs: 10 }), 'unknown');
  assert.equal(Q.qfQualityClassify({}), 'unknown');
  const split = Q.qfSplitTierChange('clear', 'balanced');
  assert.deepEqual(plain(split.hot), { targetKbps: 2500, fecRepairPercent: 10 });
  assert.deepEqual(plain(split.reconfig), { resolutionScale: 0.75 });
  assert.equal(split.needsIdr, true);
  const split2 = Q.qfSplitTierChange('balanced', 'smooth');
  assert.deepEqual(plain(split2.hot), { targetKbps: 800, maxFps: 15, fecRepairPercent: 5 });
  assert.deepEqual(plain(split2.reconfig), { resolutionScale: 0.5 });
  const same = Q.qfSplitTierChange('balanced', 'balanced');
  assert.deepEqual(plain(same.hot), {});
  assert.equal(same.needsIdr, false);
});

test('RC-09 QFQualityProbe：降档决策执行 hot/reconfig＋ACK，手动升档拒绝码透传', async () => {
  const sched = new ManualScheduler();
  const acks = [];
  const changes = [];
  const fetchFn = fakeFetch([
    ['/license/api/session/probe', () => jsonRes({
      ok: true, tier: 'balanced',
      decision: { decision: 'downgrade-to', decisionId: 'qd_1', from: 'clear', to: 'balanced', hot: { targetKbps: 2500 }, reconfig: { resolutionScale: 0.75 }, mustAckByMs: sched.now() + 5000, needsIdr: true },
      backpressure: { level: null, action: null, note: 'none' },
    })],
    ['/license/api/session/quality/ack', (call) => { acks.push(call.body); return jsonRes({ ok: true, tier: 'balanced', kind: 'downgrade', rttMs: 12 }); }],
    ['/license/api/session/quality/upgrade', () => jsonRes({ ok: false, code: 'AT_TOP' })],
  ]);
  const probe = Q.QFQualityProbe({
    sessionId: 'sess-0123456789abcdef', agentId: 'agent-1', scheduler: sched, fetchFn,
    collect: () => ({ rttMs: 900, lossPct: 1, lossSamples: 120, jitterMs: 10 }),
    onTierChange: (from, to, split) => changes.push({ from, to, split: plain(split) }),
  });
  probe.tier = 'clear';
  const j = await probe.sendOnce();
  assert.equal(j.decision.decision, 'downgrade-to');
  assert.equal(probe.tier, 'balanced');
  assert.equal(changes.length, 1);
  assert.equal(changes[0].from, 'clear');
  assert.equal(changes[0].to, 'balanced');
  assert.equal(changes[0].split.needsIdr, true);
  assert.equal(acks.length, 1);
  assert.equal(acks[0].decisionId, 'qd_1');
  assert.equal(probe.pendingAck, null);
  const up = await probe.upgrade();
  assert.equal(up.code, 'AT_TOP');
});

test('RC-09 QFQualityProbe：ACK 网络失败清 pendingAck，后续档位决策可恢复（R-W14）', async () => {
  const sched = new ManualScheduler();
  const fetchFn = fakeFetch([
    ['/license/api/session/probe', () => {
      const n = fetchFn.calls.filter((c) => c.url === '/license/api/session/probe').length;
      if (n === 1) return jsonRes({
        ok: true, tier: 'balanced',
        decision: { decision: 'downgrade-to', decisionId: 'qd_1', from: 'clear', to: 'balanced', hot: { targetKbps: 2500 }, reconfig: { resolutionScale: 0.75 }, mustAckByMs: sched.now() + 5000, needsIdr: false },
      });
      return jsonRes({
        ok: true, tier: 'smooth',
        decision: { decision: 'downgrade-to', decisionId: 'qd_2', from: 'balanced', to: 'smooth', hot: { targetKbps: 800 }, reconfig: { resolutionScale: 0.5 }, mustAckByMs: sched.now() + 5000, needsIdr: false },
      });
    }],
    ['/license/api/session/quality/ack', (call) => {
      if (call.body.decisionId === 'qd_1') throw new Error('ack network down');
      return jsonRes({ ok: true, tier: 'smooth', kind: 'downgrade', rttMs: 12 });
    }],
  ]);
  const probe = Q.QFQualityProbe({
    sessionId: 'sess-0123456789abcdef', agentId: 'agent-1', scheduler: sched, fetchFn,
    collect: () => ({ rttMs: 900, lossPct: 1, lossSamples: 120, jitterMs: 10 }),
  });
  probe.tier = 'clear';
  await probe.sendOnce();
  assert.equal(probe.tier, 'balanced');
  assert.equal(probe.pendingAck, null); // ACK 网络失败已释放，不永久残留
  await probe.sendOnce();
  assert.equal(probe.tier, 'smooth'); // 后续决策不再被丢弃
  assert.equal(probe.pendingAck, null);
});

test('RC-09 QFQualityProbe：手动升档遇旧 ACK 未发完时不得回 ok:true（R-W2）', async () => {
  const sched = new ManualScheduler();
  const fetchFn = fakeFetch([
    ['/license/api/session/quality/upgrade', () => jsonRes({
      ok: true, decision: 'upgrade-to', decisionId: 'qd_9', from: 'smooth', to: 'balanced',
      hot: { targetKbps: 2500 }, reconfig: { resolutionScale: 0.75 }, mustAckByMs: sched.now() + 5000, needsIdr: false,
    })],
    ['/license/api/session/quality/ack', () => jsonRes({ ok: true, tier: 'balanced', kind: 'upgrade', rttMs: 10 })],
  ]);
  const probe = Q.QFQualityProbe({
    sessionId: 'sess-0123456789abcdef', agentId: 'agent-1', scheduler: sched, fetchFn,
    collect: () => ({ rttMs: 100, lossPct: 0.5, lossSamples: 120, jitterMs: 10 }),
  });
  probe.tier = 'smooth';
  probe.pendingAck = { decisionId: 'qd_0', mustAckByMs: sched.now() + 5000 }; // 模拟旧决策 ACK 未发完
  const blocked = await probe.upgrade();
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'PENDING_ACK');
  assert.equal(probe.tier, 'smooth'); // 未执行，不得采纳新档位
  probe.pendingAck = null; // 旧 ACK 发完
  const up = await probe.upgrade();
  assert.equal(up.ok, true);
  assert.equal(probe.tier, 'balanced');
  assert.equal(probe.pendingAck, null);
});

test('RC-09 QFQualityProbe：背压 L1 回调、缺必填字段仍发（服务端判 probe-incomplete）', async () => {
  const bps = [];
  const fetchFn = fakeFetch([
    ['/license/api/session/probe', () => jsonRes({
      ok: true, tier: 'balanced',
      decision: { decision: null, reason: 'hold' },
      backpressure: { level: 'L1', action: 'reduce-fps', note: 'sustained' },
    })],
  ]);
  const probe = Q.QFQualityProbe({
    sessionId: 'sess-0123456789abcdef', scheduler: new ManualScheduler(), fetchFn,
    collect: () => ({ rttMs: 120, lossPct: 0.5, lossSamples: 120, jitterMs: 12, pendingFrames: 40 }),
    onBackpressure: (level, action) => bps.push({ level, action }),
  });
  await probe.sendOnce();
  assert.deepEqual(bps, [{ level: 'L1', action: 'reduce-fps' }]);
  // 缺 rttMs：客户端不伪造，照常发（服务端回 probe-incomplete、不入库）
  const probe2 = Q.QFQualityProbe({
    sessionId: 'sess-0123456789abcdef', scheduler: new ManualScheduler(), fetchFn,
    collect: () => ({ lossPct: 0.5, jitterMs: 10 }),
  });
  const j2 = await probe2.sendOnce();
  assert.equal(j2.decision.reason, 'hold');
  assert.equal(fetchFn.calls[1].body.probe.rttMs, undefined);
});

test('RC-08 QFFileTransfer：init→分片→commit 全流程用服务端返回 chunkSize；缺片续传', async () => {
  const chunks = {};
  const fetchFn = fakeFetch([
    ['/license/api/files/stream/init', (call) => {
      assert.equal(call.body.sha256, 'a'.repeat(64));
      return jsonRes({ ok: true, transferId: 'tf_0123456789abcdef', chunkSize: 4, totalChunks: 3 });
    }],
    [/\/license\/api\/files\/stream\/[^/]+\/chunk$/, (call) => {
      chunks[call.body.index] = call.body.contentBase64;
      return jsonRes({ ok: true, received: Object.keys(chunks).length, totalChunks: 3 });
    }],
    ['/license/api/files/stream/tf_0123456789abcdef/commit', () => jsonRes({ ok: true, transferId: 'tf_0123456789abcdef', stagedId: 'fs_0123456789abcdef', size: 10, expiresAt: 1790000000000 })],
  ]);
  const tf = Q.QFFileTransfer({ fetchFn, sha256Fn: async () => 'a'.repeat(64) });
  const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  const progress = [];
  const r = await tf.upload(fakeFile(bytes, 't.bin'), 'nodeB', 'nodeA', (p) => progress.push(plain(p)));
  assert.equal(r.ok, true);
  assert.equal(r.stagedId, 'fs_0123456789abcdef');
  assert.equal(tf.state, 'staged');
  assert.equal(Object.keys(chunks).length, 3);
  // 分片内容为原文件字节直接切分（base64 解码后一致）
  const b0 = Buffer.from(chunks[0], 'base64');
  assert.deepEqual(Array.from(b0), [1, 2, 3, 4]);
  const b2 = Buffer.from(chunks[2], 'base64');
  assert.deepEqual(Array.from(b2), [9, 10]);
  assert.equal(progress[progress.length - 1].received, 3);
});

test('RC-08 QFFileTransfer：网络中断后 missing 查缺片续传，不重传已收分片', async () => {
  const sent = [];
  let chunkCalls = 0;
  const fetchFn = fakeFetch([
    ['/license/api/files/stream/init', () => jsonRes({ ok: true, transferId: 'tf_aaaaaaaaaaaaaaaa', chunkSize: 4, totalChunks: 3 })],
    [/\/license\/api\/files\/stream\/[^/]+\/chunk$/, (call) => {
      chunkCalls++;
      sent.push(call.body.index);
      return jsonRes({ ok: true, received: sent.filter((v, i, a) => a.indexOf(v) === i).length, totalChunks: 3 });
    }],
    ['/license/api/files/stream/tf_aaaaaaaaaaaaaaaa/missing', () => jsonRes({ ok: true, transferId: 'tf_aaaaaaaaaaaaaaaa', status: 'uploading', received: 1, totalChunks: 3, missing: [1, 2] })],
    ['/license/api/files/stream/tf_aaaaaaaaaaaaaaaa/commit', () => jsonRes({ ok: true, transferId: 'tf_aaaaaaaaaaaaaaaa', stagedId: 'fs_aaaaaaaaaaaaaaaa', size: 10, expiresAt: 1790000000000 })],
  ]);
  // fakeFetch 的 NETWORK_ERROR 是对象而非抛错：_post 会把它当 JSON 体返回；
  // 这里用抛错模拟断网：改写 chunk 路由为抛错一次。
  const tf = Q.QFFileTransfer({ fetchFn, sha256Fn: async () => 'b'.repeat(64) });
  // 覆盖 fetchFn：第二片抛错，missing 后补传
  let n = 0;
  const flaky = async (url, init) => {
    if (url.includes('/chunk')) {
      n++;
      if (n === 2) throw new Error('net down');
    }
    return fetchFn(url, init);
  };
  const tf2 = Q.QFFileTransfer({ fetchFn: flaky, sha256Fn: async () => 'b'.repeat(64) });
  const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  const r = await tf2.upload(fakeFile(bytes, 't.bin'), 'nodeB', undefined, null);
  assert.equal(r.ok, true);
  assert.equal(tf2.state, 'staged');
  // 已收分片 0 未重传（chunk 调用：0、1(抛错)、1补、2补 = 4 次 fetch，其中 1 次抛错）
  assert.equal(n, 4);
});

test('RC-08 QFFileTransfer：commit 返回 CORRUPT 整单作废；INCOMPLETE 只补缺片', async () => {
  const fetchFn = fakeFetch([
    ['/license/api/files/stream/init', () => jsonRes({ ok: true, transferId: 'tf_cccccccccccccccc', chunkSize: 10, totalChunks: 1 })],
    [/\/license\/api\/files\/stream\/[^/]+\/chunk$/, () => jsonRes({ ok: true, received: 1, totalChunks: 1 })],
    ['/license/api/files/stream/tf_cccccccccccccccc/commit', () => jsonRes({ ok: false, code: 'CORRUPT', msg: 'sha mismatch' })],
  ]);
  const tf = Q.QFFileTransfer({ fetchFn, sha256Fn: async () => 'c'.repeat(64) });
  const r = await tf.upload(fakeFile(new Uint8Array([1, 2, 3]), 'x.bin'), 'nodeB', undefined, null);
  assert.equal(r.code, 'CORRUPT');
  assert.equal(tf.state, 'failed');
  // INCOMPLETE（S-061）：第一次 commit 缺片 [0]，补传后第二次 commit 成功 → 整单成功
  let commitCalls = 0; let chunk0Calls = 0;
  const fetchFn2 = fakeFetch([
    ['/license/api/files/stream/init', () => jsonRes({ ok: true, transferId: 'tf_dddddddddddddddd', chunkSize: 10, totalChunks: 1 })],
    [/\/license\/api\/files\/stream\/[^/]+\/chunk$/, (call) => { if (call.body.index === 0) chunk0Calls++; return jsonRes({ ok: true, received: 1, totalChunks: 1 }); }],
    ['/license/api/files/stream/tf_dddddddddddddddd/commit', () => {
      commitCalls++;
      if (commitCalls === 1) return jsonRes({ ok: false, code: 'INCOMPLETE', missing: [0] });
      return jsonRes({ ok: true, transferId: 'tf_dddddddddddddddd', stagedId: 'fs_dddddddddddddddd', size: 3, expiresAt: 1790000000000 });
    }],
  ]);
  const tf2 = Q.QFFileTransfer({ fetchFn: fetchFn2, sha256Fn: async () => 'd'.repeat(64) });
  const r2 = await tf2.upload(fakeFile(new Uint8Array([1, 2, 3]), 'x.bin'), 'nodeB', undefined, null);
  assert.equal(r2.ok, true);
  assert.equal(r2.stagedId, 'fs_dddddddddddddddd');
  assert.equal(tf2.state, 'staged');
  assert.equal(commitCalls, 2);
  assert.equal(chunk0Calls, 2); // 初传 1 次＋补传 1 次，只补缺片
  // INCOMPLETE 两次（补传后仍缺片）：判发送失败，不无限循环
  const fetchFn3 = fakeFetch([
    ['/license/api/files/stream/init', () => jsonRes({ ok: true, transferId: 'tf_eeeeeeeeeeeeeeee', chunkSize: 10, totalChunks: 1 })],
    [/\/license\/api\/files\/stream\/[^/]+\/chunk$/, () => jsonRes({ ok: true, received: 1, totalChunks: 1 })],
    ['/license/api/files/stream/tf_eeeeeeeeeeeeeeee/commit', () => jsonRes({ ok: false, code: 'INCOMPLETE', missing: [0] })],
  ]);
  const tf3 = Q.QFFileTransfer({ fetchFn: fetchFn3, sha256Fn: async () => 'e'.repeat(64) });
  const r3 = await tf3.upload(fakeFile(new Uint8Array([1, 2, 3]), 'x.bin'), 'nodeB', undefined, null);
  assert.equal(r3.code, 'INCOMPLETE');
  assert.deepEqual(r3.missing, [0]);
  assert.equal(tf3.state, 'failed');
});

test('RC-08 QFFileTransfer：下载 Range 续传（200 回落按全文件处理）与审计', async () => {
  const fetchFn = async (url, init) => {
    if (url.includes('/download')) {
      const range = init && init.headers && init.headers.Range;
      if (range === 'bytes=3-') {
        return { status: 206, ok: true, headers: { get: (k) => (k === 'Content-Length' ? '2' : null) }, arrayBuffer: async () => new Uint8Array([4, 5]).buffer };
      }
      return { status: 200, ok: true, headers: { get: (k) => (k === 'Content-Length' ? '5' : null) }, arrayBuffer: async () => new Uint8Array([1, 2, 3, 4, 5]).buffer };
    }
    if (url.includes('/audit')) return jsonRes({ ok: true, audit: [{ transferId: 'tf_x', result: 'completed' }] });
    return jsonRes({ ok: false, code: 'NO_ROUTE' }, 404);
  };
  const tf = Q.QFFileTransfer({ fetchFn });
  const dl = await tf.download('fs_0123456789abcdef', null);
  assert.equal(dl.ok, true);
  assert.equal(dl.size, 5);
  const audit = await tf.listAudit(10);
  assert.equal(audit.audit.length, 1);
  assert.equal(audit.audit[0].result, 'completed');
});

test('RC-10 录像事件清洗：clipboard 只记 bytes、key 截断、非法 kind 回落 mouse', () => {
  const clip = Q.qfRecSanitizeEvent({ type: 'clipboard', at: 1000, bytes: 42, content: 'SECRET-password' });
  assert.deepEqual(plain(clip), { type: 'clipboard', at: 1000, bytes: 42 });
  assert.equal(JSON.stringify(clip).includes('SECRET'), false);
  const key = Q.qfRecSanitizeEvent({ type: 'input', at: 1001, kind: 'key', key: 'p'.repeat(40) });
  assert.equal(key.key.length, 32);
  const bad = Q.qfRecSanitizeEvent({ type: 'input', at: 1002, kind: 'swipe', x: 'bad' });
  assert.equal(bad.kind, 'mouse');
  assert.equal(bad.x, 0);
  assert.equal(Q.qfRecSanitizeEvent({ type: 'video-frame', at: 1003 }), null);
  const fm = Q.qfRecSanitizeEvent({ type: 'frame-marker', at: 1004, frameId: 77, isKeyframe: true });
  assert.deepEqual(plain(fm), { type: 'frame-marker', at: 1004, frameId: 77, isKeyframe: true });
});

test('RC-10 seek 锚点与 JSONL 解析：半行不消费、非法行跳过', () => {
  const index = [{ t: 1000, byteOffset: 10 }, { t: 11000, byteOffset: 100 }, { t: 21000, byteOffset: 200 }];
  assert.equal(Q.qfRecSeekAnchor(index, 15000).t, 11000);
  assert.equal(Q.qfRecSeekAnchor(index, 500), null);
  assert.equal(Q.qfRecSeekAnchor(index, 21000).t, 21000);
  assert.equal(Q.qfRecSeekAnchor([], 15000), null);
  const text = '{"type":"input","at":1000,"kind":"mouse","x":1,"y":2}\n{"bad json\n{"type":"input","at":2000,"kind":"mouse","x":3,"y":4}\n{"type":"input","at":3000,"kind":"mouse","x":5,"y":6}';
  const p = Q.qfRecParseJsonl(text, 0);
  assert.equal(p.events.length, 2);
  assert.equal(p.skipped, 1);
  assert.equal(p.events[1].at, 2000);
  assert.equal(text.slice(p.consumedBytes), '{"type":"input","at":3000,"kind":"mouse","x":5,"y":6}');
});

test('RC-10 QFRecording：POLICY_OFF 不录制；倒序事件丢弃；NOT_FOUND 记 interrupted', async () => {
  const events = [];
  const fetchFn = fakeFetch([
    ['/license/api/recordings/start', () => jsonRes({ ok: false, code: 'POLICY_OFF', msg: 'off' })],
  ]);
  const rec = Q.QFRecording({ fetchFn });
  const r = await rec.start('node1', 'g1', 'balanced');
  assert.equal(r.code, 'POLICY_OFF');
  assert.equal(rec.state, 'off');
  assert.equal((await rec.sendEvent({ type: 'input', at: 1000, kind: 'mouse', x: 1, y: 2 })).code, 'NOT_RECORDING');
  // 正常录制
  const fetchFn2 = fakeFetch([
    ['/license/api/recordings/start', () => jsonRes({ ok: true, sessionId: 'rec_0123456789abcdef' })],
    [/\/license\/api\/recordings\/[^/]+\/event$/, (call) => { events.push(call.body.event); return jsonRes({ ok: true, events: events.length }); }],
    [/\/license\/api\/recordings\/[^/]+\/end$/, () => jsonRes({ ok: true, sessionId: 'rec_x', events: 2, bytes: 100, index: [] })],
  ]);
  const rec2 = Q.QFRecording({ fetchFn: fetchFn2 });
  const s2 = await rec2.start('node1', 'g1', 'balanced');
  assert.equal(s2.ok, true);
  assert.match(rec2.sessionId, /^rec_[0-9a-f]{16}$/);
  assert.equal((await rec2.sendEvent({ type: 'input', at: 1000, kind: 'mouse', x: 10, y: 20 })).ok, true);
  const ooo = await rec2.sendEvent({ type: 'input', at: 999, kind: 'mouse', x: 11, y: 21 });
  assert.equal(ooo.code, 'OUT_OF_ORDER'); // 倒序丢弃，不补发
  assert.equal(rec2.droppedOutOfOrder, 1);
  assert.equal((await rec2.sendEvent({ type: 'clipboard', at: 2000, bytes: 8, content: 'SECRET' })).ok, true);
  assert.equal(events.length, 2);
  assert.equal('content' in events[1], false);
  const end = await rec2.end();
  assert.equal(end.ok, true);
  assert.equal(rec2.state, 'ended');
});

test('RC-10 QFRecPlayer：按 at 顺序播放、变速、seek 用锚点快进', async () => {
  const sched = new ManualScheduler();
  const seen = [];
  const player = Q.QFRecPlayer({ scheduler: sched, onEvent: (ev) => seen.push(ev) });
  const text = [
    '{"type":"input","at":1000,"kind":"mouse","x":10,"y":20}',
    '{"type":"input","at":1100,"kind":"mouse","x":30,"y":40}',
    '{"type":"quality-change","at":1200,"from":"clear","to":"balanced"}',
    '{"type":"input","at":1300,"kind":"mouse","x":50,"y":60}',
    '{"type":"frame-marker","at":1400,"frameId":7,"isKeyframe":true}',
  ].join('\n') + '\n';
  const index = [{ t: 1000, byteOffset: 56 }, { t: 1200, byteOffset: 179 }]; // 行边界实测：L1 末 56、L3 末 179
  const loaded = player.load(text, { index });
  assert.equal(loaded.events, 5);
  assert.equal(player.durationMs(), 400);
  assert.equal(player.setSpeed(2), true);
  assert.equal(player.setSpeed(3), false);
  assert.equal(player.play(), true);
  sched.advance(1000); // 2x 变速：400ms 内容 200ms 播完
  assert.equal(seen.length, 5);
  assert.equal(seen[4].type, 'frame-marker');
  assert.equal(player.state().cursor.x, 50);
  assert.equal(player.state().tier, 'balanced');
  // seek 到 200ms 处：锚点 t=1000（byteOffset 54，行边界）命中，从锚点后读事件快进
  const player2 = Q.QFRecPlayer({ scheduler: new ManualScheduler(), onEvent: () => {} });
  player2.load(text, { index: [{ t: 1000, byteOffset: 56 }] });
  const sk = player2.seek(200);
  assert.equal(sk.anchor, 1000);
  assert.equal(sk.playheadMs, 1200);
  assert.equal(sk.applied, 2); // 1100 光标＋1200 档位变化
  assert.equal(player2.state().cursor.x, 30);
  assert.equal(player2.state().tier, 'balanced');
  assert.equal(player2.state().nextIdx, 3);
  // 锚点语义：seek 到 350ms 处取 t=1200 锚点（byteOffset 175），锚点前事件不重读
  const player2b = Q.QFRecPlayer({ scheduler: new ManualScheduler(), onEvent: () => {} });
  player2b.load(text, { index });
  const sk2 = player2b.seek(350);
  assert.equal(sk2.anchor, 1200);
  assert.equal(sk2.applied, 1); // 仅 1300 光标；1200 的档位变化在锚点行内，不重读
  assert.equal(player2b.state().cursor.x, 50);
  assert.equal(player2b.state().nextIdx, 4);
  // 边下边播：半行不解析
  const player3 = Q.QFRecPlayer({ scheduler: new ManualScheduler(), onEvent: () => {} });
  player3.load('{"type":"input","at":1000,"kind":"mouse","x":1,"y":1}\n', null);
  const ap = player3.appendText('{"type":"input","at":1000,"kind":"mouse","x":1,"y":1}\n{"type":"input","at":2000,"kind":"mouse","x":2,"y":2');
  assert.equal(ap.added, 0); // 半行未完成
  const ap2 = player3.appendText('{"type":"input","at":1000,"kind":"mouse","x":1,"y":1}\n{"type":"input","at":2000,"kind":"mouse","x":2,"y":2}\n');
  assert.equal(ap2.added, 1);
});
