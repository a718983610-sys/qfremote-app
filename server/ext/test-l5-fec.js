'use strict';
// L5 RC-03 自检：RS over GF(256) FEC 参考实现（QF-VIDEO-1，大肥鱼复核修订版）。
// 运行：node server/ext/test-l5-fec.js（无外部依赖，退出码 0=通过）。
const crypto = require('crypto');
const {
  encodeShards, decodeShards, makeBlockHeader, validateBlockHeader,
  mulberry32, burstLossGenerator, simulateFrames,
} = require('./fec-ref');

let passed = 0, failed = 0;
function t(name, cond, extra) {
  if (cond) { passed++; console.log('ok  -', name); }
  else { failed++; console.log('FAIL-', name, extra || ''); }
}
function randBufs(k, len, rng) {
  return Array.from({ length: k }, () => {
    const b = Buffer.alloc(len);
    for (let i = 0; i < len; i++) b[i] = Math.floor(rng() * 256);
    return b;
  });
}
function eqBufs(a, b) { return a.length === b.length && a.every((x, i) => x.equals(b[i])); }

// 1) 属性测试：随机数据＋随机 erasure（k=10,m=2：任意 ≤2 丢可恢复；3 丢不可恢复）
{
  const rng = mulberry32(20261115);
  let ok2 = true, ok1 = true, ok3 = true;
  for (let trial = 0; trial < 60; trial++) {
    const k = 10, m = 2, len = 32;
    const data = randBufs(k, len, rng);
    const enc = encodeShards(data, k, m);
    const all = enc.data.concat(enc.parity);
    // 随机丢 2 个（含 2 数据 / 1 数据+1 校验 / 2 校验）
    const idx = new Set();
    while (idx.size < 2) idx.add(Math.floor(rng() * (k + m)));
    const recv = all.map((s, i) => (idx.has(i) ? null : s));
    const dec = decodeShards(recv, k, m, enc.lengths);
    if (!dec || !eqBufs(dec, data)) ok2 = false;
    // 随机丢 1 个
    const j = Math.floor(rng() * (k + m));
    const recv1 = all.map((s, i) => (i === j ? null : s));
    const dec1 = decodeShards(recv1, k, m, enc.lengths);
    if (!dec1 || !eqBufs(dec1, data)) ok1 = false;
    // 丢 3 个数据分片 → 必须不可恢复（返回 null）
    const idx3 = new Set();
    while (idx3.size < 3) idx3.add(Math.floor(rng() * k));
    const recv3 = all.map((s, i) => (idx3.has(i) ? null : s));
    if (decodeShards(recv3, k, m, enc.lengths) !== null) ok3 = false;
  }
  t('rs-k10m2-arbitrary-2-loss-recoverable', ok2);
  t('rs-k10m2-arbitrary-1-loss-recoverable', ok1);
  t('rs-k10m2-3-data-loss-unrecoverable', ok3);
}
// 2) 低档 k=20,m=1：任意 1 丢可恢复，2 数据丢不可恢复
{
  const rng = mulberry32(77);
  const k = 20, m = 1, len = 16;
  const data = randBufs(k, len, rng);
  const enc = encodeShards(data, k, m);
  const all = enc.data.concat(enc.parity);
  let ok1 = true;
  for (let trial = 0; trial < 30; trial++) {
    const j = Math.floor(rng() * (k + m));
    const recv = all.map((s, i) => (i === j ? null : s));
    const dec = decodeShards(recv, k, m, enc.lengths);
    if (!dec || !eqBufs(dec, data)) ok1 = false;
  }
  t('rs-k20m1-arbitrary-1-loss-recoverable', ok1);
  const recv2 = all.map((s, i) => (i === 3 || i === 7 ? null : s));
  t('rs-k20m1-2-data-loss-unrecoverable', decodeShards(recv2, k, m, enc.lengths) === null);
}
// 3) 尾块：长度不等的分片（零填充＋真实长度裁剪）
{
  const data = [Buffer.from('hello'), Buffer.from('world!world!'), Buffer.from('x')];
  const enc = encodeShards(data.concat(Array(7).fill(Buffer.from('pad'))), 10, 2);
  const all = enc.data.concat(enc.parity);
  const recv = all.map((s, i) => (i === 2 ? null : s)); // 丢最短的分片
  const dec = decodeShards(recv, 10, 2, enc.lengths);
  t('rs-tail-block-uneven-lengths', !!dec && dec[0].equals(data[0]) && dec[1].equals(data[1]) && dec[2].equals(data[2]));
}
// 4) 块头校验
{
  const h = makeBlockHeader({ blockId: 5, frameId: 9, isKeyframe: true, frameStart: true, frameEnd: true, symbolIndex: 0, symbolCount: 12, symbolLength: 1024, lastSymbolPadding: 13, k: 10, m: 2 });
  t('block-header-valid', validateBlockHeader(h) === true);
  t('block-header-bad-version', validateBlockHeader(Object.assign({}, h, { fecVersion: 99 })) === false);
  t('block-header-bad-k', validateBlockHeader(Object.assign({}, h, { k: 8, symbolCount: 10 })) === false);
  t('block-header-bad-count', validateBlockHeader(Object.assign({}, h, { symbolCount: 11 })) === false);
  t('block-header-bad-padding', validateBlockHeader(Object.assign({}, h, { lastSymbolPadding: 1024 })) === false);
}
// 5) 确定性丢包 trace（30fps，300 帧，约 10 秒；每帧 1 个块）
// 帧数据量：关键帧 120KB、普通帧 24KB（模拟值，仅用于 trace 结构）
function makeFrames(n) {
  return Array.from({ length: n }, (_, i) => ({ isKeyframe: i % 30 === 0, dataBytes: i % 30 === 0 ? 120 * 1024 : 24 * 1024 }));
}
function report(name, sim) {
  console.log(`    [trace ${name}] 总帧=${sim.totalFrames} 可解码=${sim.decodableFrames} 单丢=${sim.singleRecovered}/${sim.singleLossTotal} 双丢=${sim.doubleRecovered}/${sim.doubleLossTotal} IDR请求=${sim.idrRequests} 恢复=${sim.recoveryMs}ms/${sim.recoveryFrames}帧`);
  return sim;
}
{
  const frames = makeFrames(300);
  // (a) 均匀 5% 独立丢包
  const rngA = mulberry32(1);
  const simA = report('uniform-5pct', simulateFrames(frames, 10, 2, () => rngA() < 0.05));
  t('trace-uniform5-decodable-rate-high', simA.decodableFrames / simA.totalFrames >= 0.98, `decodable=${simA.decodableFrames}/300`);
  t('trace-uniform5-single-recovered-all', simA.singleRecovered === simA.singleLossTotal);
  t('trace-uniform5-double-recovered-all', simA.doubleRecovered === simA.doubleLossTotal);
  // (b) Gilbert-Elliott 突发：平均 5%，burst 长度 1/2/5/10
  // 不交织时 burst>m 会整块冲垮校验（只记观察值）；交织深度 4 时
  // 突发摊到 4 块，每块最多丢 ceil(burst/4) 个符号，m=2 可覆盖。
  for (const burstLen of [1, 2, 5, 10]) {
    const rngB = mulberry32(100 + burstLen);
    const simB = report(`burst-len${burstLen}-no-interleave`, simulateFrames(frames, 10, 2, null, {
      streamLossFn: burstLossGenerator(rngB, 0.05, burstLen),
    }));
    if (burstLen <= 2) {
      t(`trace-burst${burstLen}-decodable-rate`, simB.decodableFrames / simB.totalFrames >= 0.90, `decodable=${simB.decodableFrames}/300 idr=${simB.idrRequests}`);
    } else {
      // 长突发无交织：如实记录（IDR 兜底恢复，下一帧可解码即自愈 ≤2 帧）
      console.log(`    [note] burst${burstLen} 无交织：可解码 ${simB.decodableFrames}/300，IDR ${simB.idrRequests} 次，恢复 ${simB.recoveryFrames} 帧——属设计内预期（m=2 扛不住同块 ${burstLen} 连丢），须交织或 IDR 兜底`);
      t(`trace-burst${burstLen}-no-interleave-honest`, simB.decodableFrames / simB.totalFrames >= 0.80, `decodable=${simB.decodableFrames}/300`);
    }
    // 设计规则：交织深度 D 只 bound 单个孤立突发（每块最多丢 2 个
    // 符号）；突发按泊松分布会成簇落点（实测 burst10+交织8 仍有
    // ~6% 帧丢 ≥3 符号），成簇部分不在 FEC 能力内，走 IDR 兜底，
    // 自愈以恢复帧数计（实测 ≤4 帧）。阈值按诚实数值定，不凑数。
    const depthFor = { 1: 1, 2: 1, 5: 4, 10: 8 };
    const depth = depthFor[burstLen];
    const rngI = mulberry32(300 + burstLen);
    const simI = report(`burst-len${burstLen}-interleave${depth}`, simulateFrames(frames, 10, 2, null, {
      interleave: depth, streamLossFn: burstLossGenerator(rngI, 0.05, burstLen),
    }));
    const rateOk = burstLen <= 5
      ? simI.decodableFrames / simI.totalFrames >= 0.97
      : simI.decodableFrames / simI.totalFrames >= 0.93;
    t(`trace-burst${burstLen}-interleave${depth}-rate`, rateOk, `decodable=${simI.decodableFrames}/300 idr=${simI.idrRequests}`);
    if (burstLen === 10) {
      t('trace-burst10-idr-heal-within-4-frames', simI.recoveryFrames !== null && simI.recoveryFrames <= 4, `recovery=${simI.recoveryFrames}帧`);
    }
  }
  // (c) 关键帧丢：每 30 帧的关键帧全部符号丢 2 个
  const simC = report('keyframe-2loss', simulateFrames(frames, 10, 2, (fi, si, ctx) => ctx.isKeyframe && (si === 0 || si === 1)));
  t('trace-keyframe-2loss-recovered', simC.decodableFrames === simC.totalFrames && simC.doubleRecovered === simC.doubleLossTotal, `decodable=${simC.decodableFrames}/300`);
  // (d) 连续 2 丢固定位置（每帧丢符号 3、4）
  const simD = report('fixed-double-loss', simulateFrames(frames, 10, 2, (fi, si) => si === 3 || si === 4));
  t('trace-fixed-double-loss-recovered', simD.decodableFrames === simD.totalFrames, `decodable=${simD.decodableFrames}/300`);
  // (e) 块头丢（符号 0 丢）＋ 乱序/重复不影响（解码按序号取，不依赖到达顺序——本模拟不建模到达顺序，记为结构说明）
  const simE = report('header-symbol-loss', simulateFrames(frames, 10, 2, (fi, si) => si === 0));
  t('trace-header-symbol-loss-recovered', simE.decodableFrames === simE.totalFrames, `decodable=${simE.decodableFrames}/300`);
}
// 6) CPU 基准（参考实现可承受性）：1KB 分片、k=10/m=2，编解码 100 块
{
  const rng = mulberry32(9);
  const data = randBufs(10, 1024, rng);
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 100; i++) {
    const enc = encodeShards(data, 10, 2);
    const recv = enc.data.concat(enc.parity).map((s, si) => (si === 2 || si === 11 ? null : s));
    decodeShards(recv, 10, 2, enc.lengths);
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(`    [bench] 100 块 × (k=10,m=2,1KB分片) 编解码合计 ${ms.toFixed(1)}ms，平均 ${(ms / 100).toFixed(2)}ms/块`);
  t('bench-rs-per-block-under-5ms', ms / 100 < 5, `${(ms / 100).toFixed(2)}ms/块`);
}

console.log(`\nRC-03 FEC: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
