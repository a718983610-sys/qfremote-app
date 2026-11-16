'use strict';
/*
 * RC-03 Windows 解码端 FEC＋IDR 测试（QF-VIDEO-1 规范 v1，3.0.0）：
 *  A. RS 编解码与服务端 fec-ref.js 双向对拍（逐字节一致）：服务端
 *     编码→本模块解码、本模块编码→服务端解码；k=10/m=2 双丢恢复、
 *     k=20/m=1 单丢恢复、超 m 不可恢复、校验行不足不可恢复、尾分片
 *     零填充裁剪。
 *  B. 块头校验（与服务端 validateBlockHeader 一字一致）：12 字段、
 *     7 类非法一律拒绝；k=10/m=1 等宽松组合校验通过但客户端档位表
 *     只许两档（isAllowedTier 拒绝）。
 *  C. fecRepairPercent 映射（QF-QUALITY-1 §6.1）：≤5%→low、≥20%→
 *     high、10%/15% 待定不发明第三档。
 *  D. 块组装器：0 缺失直接成帧、迟到分片窗口内到达恢复、窗口届满
 *     缺片≤m 还原、缺片>m 不可恢复＋恰好一次 IDR 回调、块头非法整块
 *     丢弃、同块不同帧丢弃、半帧不上屏、交织深度下限。
 *  E. IDR 发送器：seq 从 1 单调递增（放行/合并/拒绝都消费）、三
 *     reason、coalesced 不补发、COOLDOWN 本地短路＋retryAfterMs、
 *     REPLAY 不原样重发、NO_SESSION/NOT_BOUND/BAD_REASON 不重试、
 *     网络失败下次触发可再试、join 只发一次、同 reason 本地合并窗口。
 *  F. 静态接线：main.js 含 qf-protocol 创建＋会话绑定/解绑；package.json
 *     打包清单含新模块；构建检查 0 违规。
 * 服务端“转发给 agent 强制出 IDR”通道未实现（规范 §4.3），本测试只
 * 验准入决策返回，不验 agent 侧出关键帧。结果写 JSON 到 QFTEST_OUT，
 * 退出码 0=通过。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const fec = require('../qf-fec');
const idrMod = require('../qf-idr');
const serverFec = require('../../server/ext/fec-ref');
const { runChecks } = require('../tools/check-electron-safety');

const OUT = process.env.QFTEST_OUT || '/tmp/qfr-rc03-video/rc03-video-result.json';
const result = { cases: {}, pass: false };
const ok = (name, cond, extra) => { if (Object.prototype.hasOwnProperty.call(result.cases, name)) throw new Error('duplicate case name: ' + name); result.cases[name] = Object.assign({ pass: !!cond }, extra || {}); };

function makeFrameData(k, shardLen, seed) {
  const data = [];
  for (let i = 0; i < k; i++) {
    const b = Buffer.alloc(shardLen, 0);
    for (let j = 0; j < shardLen; j++) b[j] = (seed + i * 7 + j) & 0xff;
    data.push(b);
  }
  return data;
}

(async () => {
  // ---------- A. RS 双向对拍 ----------
  {
    const data = makeFrameData(10, 64, 3);
    const encSrv = serverFec.encodeShards(data, 10, 2);
    const allSrv = encSrv.data.concat(encSrv.parity);
    const recv = allSrv.slice();
    recv[2] = null; recv[7] = null; // 双丢
    const decMine = fec.decodeShards(recv, 10, 2, encSrv.lengths);
    ok('A1_srv-encode_mine-decode_double-loss', !!decMine && decMine.every((b, i) => b.equals(data[i])));
    const encMine = fec.encodeShards(data, 10, 2);
    const allMine = encMine.data.concat(encMine.parity);
    const recv2 = allMine.slice();
    recv2[0] = null; recv2[9] = null; // 双数据丢、校验行齐全
    const decSrv = serverFec.decodeShards(recv2, 10, 2, encMine.lengths);
    ok('A2_mine-encode_srv-decode_double-loss', !!decSrv && decSrv.every((b, i) => b.equals(data[i])));
    const recv3 = allSrv.slice();
    recv3[1] = null; recv3[4] = null; recv3[8] = null; // 3 丢 > m=2
    ok('A3_triple-loss_unrecoverable_null', fec.decodeShards(recv3, 10, 2, encSrv.lengths) === null);
    const recv4 = allSrv.slice();
    recv4[3] = null; recv4[5] = null; recv4[10] = null; recv4[11] = null; // 2 数据丢＋校验全丢
    ok('A4_parity-insufficient_null', fec.decodeShards(recv4, 10, 2, encSrv.lengths) === null);
    // k=20/m=1：单丢恢复、双丢不可恢复。
    const d20 = makeFrameData(20, 32, 11);
    const e20 = serverFec.encodeShards(d20, 20, 1);
    const a20 = e20.data.concat(e20.parity);
    const r20 = a20.slice(); r20[19] = null;
    const dec20 = fec.decodeShards(r20, 20, 1, e20.lengths);
    ok('A5_k20m1_single-loss_recovered', !!dec20 && dec20.every((b, i) => b.equals(d20[i])));
    const r20b = a20.slice(); r20b[0] = null; r20b[1] = null;
    ok('A6_k20m1_double-loss_null', fec.decodeShards(r20b, 20, 1, e20.lengths) === null);
    // 尾分片零填充裁剪：最后一片短 5 字节。
    const short = makeFrameData(10, 16, 5);
    short[9] = short[9].subarray(0, 11);
    const eShort = fec.encodeShards(short, 10, 2);
    const decShort = serverFec.decodeShards(eShort.data.concat(eShort.parity), 10, 2, eShort.lengths);
    ok('A7_last-shard-padding_trimmed', !!decShort && decShort[9].length === 11 && decShort[9].equals(short[9]));
    // 0 缺失直接返回裁剪后数据。
    const dec0 = fec.decodeShards(allSrv.slice(), 10, 2, encSrv.lengths);
    ok('A8_zero-loss_passthrough', !!dec0 && dec0.every((b, i) => b.equals(data[i])));
    // GF 基本运算与服务端一致（抽查）。
    ok('A9_gf-mul_matches_server', fec.gfMul(0x53, 0xca) === serverFec.gfMul(0x53, 0xca));
  }

  // ---------- B. 块头校验 ----------
  {
    const good = fec.makeBlockHeader({ blockId: 7, frameId: 3, isKeyframe: true, frameStart: true, frameEnd: true, symbolIndex: 0, symbolCount: 12, symbolLength: 1024, lastSymbolPadding: 0, k: 10, m: 2 });
    ok('B1_valid-header', fec.validateBlockHeader(good) === true && good.fecVersion === 1);
    const bad = (over) => fec.validateBlockHeader(Object.assign({}, good, over));
    ok('B2_version', bad({ fecVersion: 2 }) === false);
    ok('B3_m-range', bad({ m: 3, symbolCount: 13 }) === false);
    ok('B4_k-range', bad({ k: 15, symbolCount: 17 }) === false);
    ok('B5_symbolCount', bad({ symbolCount: 11 }) === false);
    ok('B6_symbolIndex', bad({ symbolIndex: 12 }) === false);
    ok('B7_symbolLength', bad({ symbolLength: 0 }) === false);
    ok('B8_padding', bad({ lastSymbolPadding: 1024 }) === false);
    ok('B9_null-header', fec.validateBlockHeader(null) === false);
    // 校验宽松组合通过校验，但客户端档位表只许两档。
    ok('B10_loose-combo_validates_but_not_allowed', bad({ k: 10, m: 1, symbolCount: 11 }) === true && fec.isAllowedTier(10, 1) === false);
    ok('B11_allowed-tiers_only-two', fec.isAllowedTier(10, 2) === true && fec.isAllowedTier(20, 1) === true && fec.isAllowedTier(20, 2) === false);
  }

  // ---------- C. fecRepairPercent 映射 ----------
  {
    ok('C1_pct5_low', fec.fecTierForRepairPercent(5).ok === true && fec.fecTierForRepairPercent(5).tier === 'low');
    ok('C2_pct20_high', fec.fecTierForRepairPercent(20).ok === true && fec.fecTierForRepairPercent(20).tier === 'high');
    ok('C3_pct10_unmapped', fec.fecTierForRepairPercent(10).ok === false && fec.fecTierForRepairPercent(10).reason === 'fec-repair-unmapped');
    ok('C4_pct15_unmapped', fec.fecTierForRepairPercent(15).ok === false);
    ok('C5_pct0_low', fec.fecTierForRepairPercent(0).tier === 'low');
    ok('C6_pctNaN_unmapped', fec.fecTierForRepairPercent(NaN).ok === false);
  }

  // ---------- D. 块组装器 ----------
  {
    const frameData = makeFrameData(10, 64, 9);
    const enc = serverFec.encodeShards(frameData, 10, 2);
    const all = enc.data.concat(enc.parity);
    const headerFor = (si) => fec.makeBlockHeader({ blockId: 100, frameId: 50, isKeyframe: false, frameStart: si === 0, frameEnd: si === 11, symbolIndex: si, symbolCount: 12, symbolLength: 64, lastSymbolPadding: 0, k: 10, m: 2 });
    let now = 1000000;
    const frames = [];
    const unrec = [];
    const asm = fec.createBlockAssembler({
      k: 10, m: 2, frameMs: 33, nowMs: () => now,
      onFrame: (f) => frames.push(f),
      onUnrecoverable: (info) => unrec.push(info),
      log: () => {}
    });
    // 0 缺失直接成帧。
    for (let si = 0; si < 12; si++) asm.receiveShard(headerFor(si), all[si]);
    ok('D1_zero-loss_frame_complete', frames.length === 1 && frames[0].frame.equals(Buffer.concat(frameData)) && frames[0].recovered === false);
    // 1 丢：窗口内等迟到分片，届满还原。
    const asm2 = fec.createBlockAssembler({
      k: 10, m: 2, frameMs: 33, nowMs: () => now,
      onFrame: (f) => frames.push(f), onUnrecoverable: (info) => unrec.push(info), log: () => {}
    });
    const h2 = (si, blockId) => fec.makeBlockHeader({ blockId, frameId: 51, isKeyframe: false, frameStart: si === 0, frameEnd: si === 11, symbolIndex: si, symbolCount: 12, symbolLength: 64, lastSymbolPadding: 0, k: 10, m: 2 });
    for (let si = 0; si < 12; si++) { if (si !== 4) asm2.receiveShard(h2(si, 101), all[si]); }
    ok('D2_one-loss_waiting_no-frame-yet', frames.length === 1 && asm2.pendingBlocks() === 1);
    now += 10; // 窗口 = rtt 20 + jitter 5 + 33 = 58ms，未满
    asm2.checkTimeouts(now, 20, 5);
    ok('D3_window-not-expired_no-emit', frames.length === 1 && unrec.length === 0);
    now += 60; // 届满：1 丢 ≤ m，还原
    asm2.checkTimeouts(now, 20, 5);
    ok('D4_window-expired_recovered', frames.length === 2 && frames[1].recovered === true && frames[1].frame.equals(Buffer.concat(frameData)));
    // 3 丢：不可恢复，恰好一次回调。
    const asm3 = fec.createBlockAssembler({
      k: 10, m: 2, frameMs: 33, nowMs: () => now,
      onFrame: (f) => frames.push(f), onUnrecoverable: (info) => unrec.push(info), log: () => {}
    });
    const before = unrec.length;
    for (let si = 0; si < 12; si++) { if (si !== 1 && si !== 2 && si !== 3) asm3.receiveShard(h2(si, 102), all[si]); }
    now += 100;
    asm3.checkTimeouts(now, 20, 5);
    ok('D5_three-loss_unrecoverable_once', unrec.length === before + 1 && unrec[unrec.length - 1].missingCount === 3 && frames.length === 2);
    now += 100;
    asm3.checkTimeouts(now, 20, 5);
    ok('D6_unrecoverable_not-repeated', unrec.length === before + 1);
    // 块头非法整块丢弃。
    const asm4 = fec.createBlockAssembler({ k: 10, m: 2, nowMs: () => now, onFrame: (f) => frames.push(f), onUnrecoverable: (i) => unrec.push(i), log: () => {} });
    const r4 = asm4.receiveShard(fec.makeBlockHeader({ blockId: 103, frameId: 52, symbolIndex: 0, symbolCount: 12, symbolLength: 64, lastSymbolPadding: 0, k: 10, m: 3 }), all[0]);
    ok('D7_invalid-header_dropped', r4.outcome === 'dropped-invalid-header' && asm4.pendingBlocks() === 0);
    // 同块不同帧丢弃。
    const asm5 = fec.createBlockAssembler({ k: 10, m: 2, nowMs: () => now, onFrame: (f) => frames.push(f), onUnrecoverable: (i) => unrec.push(i), log: () => {} });
    asm5.receiveShard(h2(0, 104), all[0]);
    const r5 = asm5.receiveShard(fec.makeBlockHeader({ blockId: 104, frameId: 99, symbolIndex: 1, symbolCount: 12, symbolLength: 64, lastSymbolPadding: 0, k: 10, m: 2 }), all[1]);
    ok('D8_frame-mismatch_dropped', r5.outcome === 'dropped-frame-mismatch' && asm5.pendingBlocks() === 0);
    // 重复分片不重复计数。
    const asm6 = fec.createBlockAssembler({ k: 10, m: 2, nowMs: () => now, onFrame: (f) => frames.push(f), onUnrecoverable: (i) => unrec.push(i), log: () => {} });
    asm6.receiveShard(h2(0, 105), all[0]);
    const r6 = asm6.receiveShard(h2(0, 105), all[0]);
    ok('D9_duplicate_shard', r6.outcome === 'duplicate' && asm6.pendingBlocks() === 1);
    // 交织深度下限。
    ok('D10_interleave-depth', fec.minInterleaveDepth(5) === 3 && fec.minInterleaveDepth(10) === 5 && fec.minInterleaveDepth(0) === 0);
    // 非法档位建组装器即抛错。
    let threw = false;
    try { fec.createBlockAssembler({ k: 10, m: 1 }); } catch (e) { threw = true; }
    ok('D11_bad-tier-throws', threw === true);
  }

  // ---------- E. IDR 发送器 ----------
  {
    const mkSender = (fake) => {
      const calls = [];
      let now = 2000000;
      const request = async (method, url, body) => { calls.push({ method, url, body }); return fake(body, calls.length); };
      const sender = idrMod.createIdrSender({ request, baseUrl: 'https://app.qfremote.top', sessionId: 'sess-0123456789abcdef', agentId: 'agent-1', nowMs: () => now, log: () => {} });
      return { sender, calls, setNow: (v) => { now = v; }, getNow: () => now };
    };
    const fwd = () => ({ status: 200, json: { ok: true, decision: 'forward', code: 'OK', msg: '放行。' } });
    // seq 从 1 单调递增。
    {
      const { sender, calls } = mkSender(fwd);
      await sender.sendLoss();
      await sender.sendLoss(); // 本地合并窗口 1s 内 → 短路，不发请求
      ok('E1_seq-starts-at-1', calls.length === 1 && calls[0].body.seq === 1 && calls[0].body.reason === 'loss');
    }
    {
      const { sender, calls, setNow, getNow } = mkSender(fwd);
      await sender.sendLoss();
      setNow(getNow() + 1500);
      await sender.sendLoss();
      ok('E2_seq-increments', calls.length === 2 && calls[1].body.seq === 2);
    }
    // coalesced 不补发、不换 reason。
    {
      let n = 0;
      const { sender, calls, setNow, getNow } = mkSender(() => {
        n += 1;
        return n === 1
          ? { status: 200, json: { ok: true, decision: 'coalesced', code: 'COALESCED', msg: '同 reason 合并窗口内，已合并。' } }
          : fwd();
      });
      const r1 = await sender.sendLoss();
      setNow(getNow() + 1500);
      const r2 = await sender.sendLoss();
      ok('E3_coalesced_ok-no-resend', r1.ok === true && r1.decision === 'coalesced' && r2.ok === true && calls.length === 2 && calls[1].body.seq === 2);
    }
    // COOLDOWN：本地短路，retryAfterMs 过去后恢复。
    {
      const { sender, calls, setNow, getNow } = mkSender((body) => {
        if (calls.length === 1) return { status: 200, json: { ok: false, decision: 'rejected', code: 'COOLDOWN', msg: '连续超限冷却中。', retryAfterMs: 10000 } };
        return fwd();
      });
      const r1 = await sender.sendLoss();
      const r2 = await sender.sendLoss(); // 冷却期内：不发网络
      ok('E4_cooldown_short-circuit', r1.ok === false && r1.code === 'COOLDOWN' && r2.kind === 'cooldown' && r2.retryAfterMs === 10000 && calls.length === 1);
      setNow(getNow() + 10001);
      const r3 = await sender.sendLoss();
      ok('E5_cooldown-expired_resumes', r3.ok === true && calls.length === 2);
    }
    // REPLAY：不原样重发，下次触发用新 seq。
    {
      const { sender, calls, setNow, getNow } = mkSender((body) => {
        if (calls.length === 1) return { status: 200, json: { ok: false, decision: 'rejected', code: 'REPLAY', msg: 'seq 非单调递增。' } };
        return fwd();
      });
      const r1 = await sender.sendLoss();
      setNow(getNow() + 1500);
      const r2 = await sender.sendLoss();
      ok('E6_replay_no-immediate-resend', r1.ok === false && r1.code === 'REPLAY' && r2.ok === true && calls[1].body.seq === 2);
    }
    // NO_SESSION / NOT_BOUND / BAD_REASON 不重试。
    for (const code of ['NO_SESSION', 'NOT_BOUND']) {
      const { sender } = mkSender(() => ({ status: 200, json: { ok: false, decision: 'rejected', code, msg: 'x' } }));
      const r = await sender.sendLoss();
      ok('E7_' + code + '_not-retryable', r.ok === false && r.code === code && r.retryableNextTrigger === false);
    }
    {
      const { sender } = mkSender(fwd);
      const r = await sender.send('bogus');
      ok('E8_bad-reason_local', r.ok === false && r.kind === 'bad-reason' && r.retryableNextTrigger === false);
    }
    // 网络失败：下次触发可再试。
    {
      const { sender, calls, setNow, getNow } = mkSender(() => { throw new Error('net down'); });
      const r = await sender.sendLoss();
      ok('E9_network_retryable', r.ok === false && r.kind === 'network' && r.retryableNextTrigger === true && calls.length === 1);
    }
    // join 只发一次。
    {
      const { sender, calls, setNow, getNow } = mkSender(fwd);
      const r1 = await sender.sendJoin();
      setNow(getNow() + 1500);
      const r2 = await sender.sendJoin();
      ok('E10_join-once', r1.ok === true && r2.kind === 'join-already-sent' && calls.length === 1);
    }
    // join 宽限：绑定后 10s 内可发，超宽限首次发 join 直接短路（F-WIN-07）。
    {
      const { sender, calls } = mkSender(fwd);
      sender.bind({ sessionId: 'sess-0123456789abcdef', agentId: 'agent-1' });
      const r1 = await sender.sendJoin();
      ok('E11_join-within-window', r1.ok === true && calls.length === 1);
    }
    {
      const { sender, calls, setNow, getNow } = mkSender(fwd);
      sender.bind({ sessionId: 'sess-0123456789abcdef', agentId: 'agent-1' });
      setNow(getNow() + 10001);
      const r1 = await sender.sendJoin();
      ok('E12_join-window-expired', r1.ok === false && r1.kind === 'join-window-expired' && r1.code === 'JOIN_WINDOW_EXPIRED' && r1.retryableNextTrigger === false && calls.length === 0);
    }
    // R-W1：join 网络失败不锁死——回滚 joinSent，下次触发可再试（有界重试）。
    {
      let n = 0;
      const { sender, calls, setNow, getNow } = mkSender(() => {
        n += 1;
        if (n === 1) throw new Error('net down');
        return fwd();
      });
      const r1 = await sender.sendJoin();
      ok('E13_join-network-failure_retryable', r1.ok === false && r1.kind === 'network' && r1.retryableNextTrigger === true && sender.joinSent() === false);
      setNow(getNow() + 1500); // 过 1s 本地合并窗口
      const r2 = await sender.sendJoin();
      ok('E13_join-network-failure_retry-succeeds', r2.ok === true && r2.kind === 'forward' && calls.length === 2 && sender.joinSent() === true);
    }
    // R-W1：无服务端决策（非 200／无 json）同样回滚 joinSent。
    {
      let n = 0;
      const { sender, calls, setNow, getNow } = mkSender(() => {
        n += 1;
        if (n === 1) return { status: 500, json: null };
        return fwd();
      });
      const r1 = await sender.sendJoin();
      ok('E14_join-no-decision_retryable', r1.ok === false && r1.kind === 'unknown' && r1.retryableNextTrigger === true && sender.joinSent() === false);
      setNow(getNow() + 1500);
      const r2 = await sender.sendJoin();
      ok('E14_join-no-decision_retry-succeeds', r2.ok === true && calls.length === 2 && sender.joinSent() === true);
    }
    // quality-change：2s 本地合并窗口内短路。
    {
      const { sender, calls, setNow, getNow } = mkSender(fwd);
      await sender.sendQualityChange();
      setNow(getNow() + 1000);
      const r2 = await sender.sendQualityChange();
      setNow(getNow() + 1500);
      const r3 = await sender.sendQualityChange();
      ok('E15_quality-change_coalesce-window', calls.length === 2 && r2.kind === 'local-coalesced' && r3.ok === true);
    }
    // 无会话/无 agent 不发请求。
    {
      const calls = [];
      const sender = idrMod.createIdrSender({ request: async (m, u, b) => { calls.push(b); return fwd(); }, baseUrl: 'https://app.qfremote.top', sessionId: '', agentId: 'agent-1', log: () => {} });
      const r = await sender.sendLoss();
      ok('E16_no-session_no-request', r.kind === 'no-session' && calls.length === 0);
    }
    // 503 L5_UNAVAILABLE。
    {
      const { sender } = mkSender(() => ({ status: 503, json: { ok: false, code: 'L5_UNAVAILABLE' } }));
      const r = await sender.sendLoss();
      ok('E17_l5-unavailable', r.kind === 'unavailable' && r.retryableNextTrigger === true);
    }
    // bind 重置 seq。
    {
      const { sender, calls, setNow, getNow } = mkSender(fwd);
      await sender.sendLoss();
      sender.bind({ sessionId: 'sess-aaaaaaaaaaaaaaaa', agentId: 'agent-2' });
      setNow(getNow() + 1500);
      await sender.sendLoss();
      ok('E18_bind_resets-seq', calls[1].body.seq === 1 && calls[1].body.sessionId === 'sess-aaaaaaaaaaaaaaaa');
    }
  }

  // ---------- F. 静态接线 ----------
  {
    const mainText = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    ok('F1_main-requires-qf-protocol', mainText.includes("require('./qf-protocol')"));
    ok('F2_main-binds-on-openSession', mainText.includes('qfProtocol.bindSession'));
    ok('F3_main-unbinds-on-closeSession', mainText.includes("qfProtocol.unbindSession('session-close')"));
    ok('F4_main-unbinds-on-logout', mainText.includes("qfProtocol.unbindSession('logout')"));
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    const files = pkg.build.files || [];
    ok('F5_pkg-build-files', ['qf-fec.js', 'qf-idr.js', 'qf-relay.js', 'qf-transfer.js', 'qf-quality.js', 'qf-recording.js', 'qf-protocol.js'].every((f) => files.indexOf(f) >= 0));
    const violations = runChecks(path.join(__dirname, '..'));
    ok('F6_build-check-zero-violations', violations.length === 0, { violations: violations.slice(0, 5) });
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
