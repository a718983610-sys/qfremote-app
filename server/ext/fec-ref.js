'use strict';
/*
 * QFRemote 扩展服务 · L5 RC-03：FEC 参考实现（协议 QF-VIDEO-1）
 * ============================================================
 * 大肥鱼复核裁决（2026-11-15，原文 l5-evidence/ds-review-rc03-rc09-20261115.md）：
 * XOR k=8,n=2 不能保证任意 2 丢可还原（n=2 时非零校验列只有 3 种，
 * k≤3 才能两两不同），RC-03 初版不通过。改用 Reed-Solomon over
 * GF(256)：k=10,m=2（开销 20%，任意 2 丢可恢复）；低档 k=20,m=1
 * （开销 5%，任意 1 丢）。repairPercent 分母为 k（m/k）。
 *
 * 本模块是纯 JS 参考实现（无依赖），供 agent 侧（C）与各端解码器
 * 对照协议，不宣称已在 agent 内落地：
 *   - GF(256)（本原多项式 0x11d，生成元 2），查表实现。
 *   - 编码：Vandermonde 校验行（评估点 x=j+1，系数 x^i）；m∈{1,2}。
 *   - 解码：丢失分片已知位置（erasure），高斯消元解 m 元方程；
 *     丢失数 > m 或可用校验行不足时返回 null（不可恢复，触发受控 IDR）。
 *   - 块边界：每帧一个块，不得跨关键帧；尾块零填充并保留真实长度。
 *   - 块头：makeBlockHeader/validateBlockHeader（字段见 §七）。
 *
 * 注意：本实现只做协议参考与沙箱模拟，不进生产数据面（生产编码
 * 在 agent 侧，解码在各端）。CPU 基准见 test-l5-fec.js 输出。
 */
const GF_POLY = 0x11d;
const GF_GEN = 2;

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(function buildTables() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= GF_POLY;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}
function gfDiv(a, b) {
  if (b === 0) throw new Error('gf-div-zero');
  if (a === 0) return 0;
  return EXP[(LOG[a] - LOG[b] + 255) % 255];
}
function gfInv(a) {
  if (a === 0) throw new Error('gf-inv-zero');
  return EXP[255 - LOG[a]];
}
function gfPow(a, e) {
  if (e === 0) return 1;
  if (a === 0) return 0;
  return EXP[(LOG[a] * e) % 255];
}

// 校验行 j 的系数：coef[j][i] = (j+1)^i（Vandermonde）。
function parityCoef(j, i) { return gfPow(j + 1, i); }

function encodeShards(dataBuffers, k, m) {
  if (![1, 2].includes(m)) throw new Error('fec-m-range');
  if (!Array.isArray(dataBuffers) || dataBuffers.length !== k) throw new Error('fec-k-mismatch');
  const lengths = dataBuffers.map((b) => {
    if (!Buffer.isBuffer(b)) throw new Error('fec-not-buffer');
    return b.length;
  });
  const shardLen = Math.max.apply(null, lengths.concat([1]));
  const data = dataBuffers.map((b) => {
    if (b.length === shardLen) return Buffer.from(b);
    const p = Buffer.alloc(shardLen);
    b.copy(p);
    return p;
  });
  const parity = [];
  for (let j = 0; j < m; j++) {
    const p = Buffer.alloc(shardLen);
    for (let i = 0; i < k; i++) {
      const c = parityCoef(j, i);
      if (c === 0) continue;
      const d = data[i];
      if (c === 1) {
        for (let b = 0; b < shardLen; b++) p[b] ^= d[b];
      } else {
        for (let b = 0; b < shardLen; b++) p[b] ^= gfMul(c, d[b]);
      }
    }
    parity.push(p);
  }
  return { data, parity, shardLen, lengths };
}

// shards：长度 k+m 的数组，Buffer 或 null（丢失）。lengths：k 个数据分片真实长度。
// 返回恢复后的 k 个数据 Buffer（按真实长度裁剪），不可恢复返回 null。
function decodeShards(shards, k, m, lengths) {
  if (![1, 2].includes(m)) throw new Error('fec-m-range');
  if (!Array.isArray(shards) || shards.length !== k + m) throw new Error('fec-shard-count');
  const missing = [];
  for (let i = 0; i < k; i++) if (!shards[i]) missing.push(i);
  if (missing.length === 0) {
    return shards.slice(0, k).map((b, i) => Buffer.from(b.subarray(0, lengths[i])));
  }
  if (missing.length > m) return null; // 丢失超校验能力：不可恢复
  const availParity = [];
  for (let j = 0; j < m; j++) if (shards[k + j]) availParity.push(j);
  if (availParity.length < missing.length) return null; // 可用校验行不足
  const t = missing.length;
  const shardLen = shards.find((s) => s) ? shards.find((s) => s).length : 0;
  // 方程：对每个可用校验行 j：sum_{i∈missing} coef[j][i]*D_i = P_j - sum_{i∉missing} coef[j][i]*D_i
  // 取前 t 个可用校验行，高斯消元解 t 元方程（逐字节并行：系数矩阵与字节无关）。
  const rows = availParity.slice(0, t);
  const mat = rows.map((j) => missing.map((i) => parityCoef(j, i)));
  // 增广列：每字节一个右端项——先对系数矩阵做消元得行变换记录，再逐字节应用。
  // m≤2 且 t≤2，直接手写求逆（通用高斯消元亦可，此处用消元求逆矩阵再应用）。
  const inv = gfInvertMatrix(mat);
  if (!inv) return null;
  const out = missing.map(() => Buffer.alloc(shardLen));
  for (let b = 0; b < shardLen; b++) {
    const rhs = rows.map((j) => {
      let v = shards[k + j][b];
      for (let i = 0; i < k; i++) {
        if (missing.includes(i)) continue;
        const c = parityCoef(j, i);
        if (c !== 0) v ^= gfMul(c, shards[i][b]);
      }
      return v;
    });
    for (let r = 0; r < t; r++) {
      let v = 0;
      for (let c = 0; c < t; c++) v ^= gfMul(inv[r][c], rhs[c]);
      out[r][b] = v;
    }
  }
  const result = shards.slice(0, k).map((s) => (s ? Buffer.from(s) : null));
  missing.forEach((idx, r) => { result[idx] = out[r].subarray(0, lengths[idx]); });
  return result.map((b, i) => Buffer.from(b.subarray(0, lengths[i])));
}

// GF(256) 方阵求逆（高斯-约当消元）；奇异返回 null。
function gfInvertMatrix(mat) {
  const n = mat.length;
  const a = mat.map((row, i) => row.concat(Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))));
  for (let col = 0; col < n; col++) {
    let pivot = -1;
    for (let r = col; r < n; r++) {
      if (a[r][col] !== 0) { pivot = r; break; }
    }
    if (pivot === -1) return null;
    if (pivot !== col) { const tmp = a[pivot]; a[pivot] = a[col]; a[col] = tmp; }
    const invPivot = gfInv(a[col][col]);
    for (let j = 0; j < 2 * n; j++) a[col][j] = gfMul(a[col][j], invPivot);
    for (let r = 0; r < n; r++) {
      if (r === col || a[r][col] === 0) continue;
      const factor = a[r][col];
      for (let j = 0; j < 2 * n; j++) a[r][j] ^= gfMul(factor, a[col][j]);
    }
  }
  return a.map((row) => row.slice(n));
}

// ---- 块头（QF-VIDEO-1）----
const FEC_VERSION = 1;
function makeBlockHeader(f) {
  return {
    fecVersion: FEC_VERSION,
    blockId: Number(f.blockId) >>> 0,
    frameId: Number(f.frameId) >>> 0,
    isKeyframe: !!f.isKeyframe,
    frameStart: !!f.frameStart,
    frameEnd: !!f.frameEnd,
    symbolIndex: Number(f.symbolIndex) >>> 0,
    symbolCount: Number(f.symbolCount) >>> 0,
    symbolLength: Number(f.symbolLength) >>> 0,
    lastSymbolPadding: Number(f.lastSymbolPadding) >>> 0,
    k: Number(f.k) >>> 0,
    m: Number(f.m) >>> 0,
  };
}
function validateBlockHeader(h) {
  if (!h || typeof h !== 'object') return false;
  if (h.fecVersion !== FEC_VERSION) return false;
  if (![1, 2].includes(h.m)) return false;
  if (!(h.k === 10 || h.k === 20)) return false; // 本协议只定两档
  if (h.symbolCount !== h.k + h.m) return false;
  if (h.symbolIndex >= h.symbolCount) return false;
  if (h.symbolLength <= 0) return false;
  if (h.lastSymbolPadding < 0 || h.lastSymbolPadding >= h.symbolLength) return false;
  return true;
}

// ---- 确定性丢包 trace 模拟（30fps 固定帧率，恢复时间同时报 ms 与帧数）----
// 交织（interleave）：把连续 G 个块的符号按轮询顺序交织发送，突发丢包
// 摊到多个块，每块最多丢 ceil(burstLen/G) 个符号；不交织时 burst>m
// 的突发会整块冲垮 m=2 的校验能力，只能走 IDR（见 test 注释）。
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Gilbert-Elliott 风格突发丢包生成器（按发送顺序调用）：平均丢包率
// avgLoss，突发长度 burstLen。返回 stateful 函数 () => boolean。
function burstLossGenerator(rng, avgLoss, burstLen) {
  let inBurst = 0;
  return function () {
    if (inBurst > 0) { inBurst--; return true; }
    if (rng() < avgLoss / burstLen) { inBurst = burstLen - 1; return true; }
    return false;
  };
}

// lossFn(blockIdx, symbolIdx, ctx) → true 表示该符号丢失。
// frames：[{ isKeyframe, dataBytes }]；k/m 按档位；返回逐帧结果。
// opts：{ fps=30, shardLen=64, interleave=1, streamLossFn }——
//   streamLossFn 存在时按交织发送顺序调用（突发模型用），否则按块内
//   lossFn 逐符号判定。
function simulateFrames(frames, k, m, lossFn, opts) {
  const o = opts || {};
  const fps = o.fps || 30;
  const frameMs = 1000 / fps;
  const interleave = Math.max(1, o.interleave || 1);
  const totalSyms = k + m;
  // 先算每块的收包情况
  const lostSet = new Set(); // "blockIdx:symbolIdx"
  if (typeof o.streamLossFn === 'function') {
    // 按交织发送顺序遍历所有符号，突发按发送顺序产生
    const nBlocks = frames.length;
    for (let g0 = 0; g0 < nBlocks; g0 += interleave) {
      const group = [];
      for (let g = 0; g < interleave && g0 + g < nBlocks; g++) group.push(g0 + g);
      for (let si = 0; si < totalSyms; si++) {
        for (const bi of group) {
          if (o.streamLossFn()) lostSet.add(bi + ':' + si);
        }
      }
    }
  }
  const results = [];
  let idrRequests = 0;
  let lossStartMs = null;
  let recoveredAtMs = null;
  frames.forEach((fr, fi) => {
    const shardLen = o.shardLen || 64;
    // 把帧数据切成 k 个数据分片（尾分片可能短，零填充）
    const total = Math.max(fr.dataBytes, k);
    const per = Math.ceil(total / k);
    const data = [];
    for (let i = 0; i < k; i++) {
      const len = Math.min(per, total - i * per);
      data.push(Buffer.alloc(Math.max(len, 1), (fi * 7 + i) & 0xff));
    }
    const enc = encodeShards(data, k, m);
    const all = enc.data.concat(enc.parity);
    const recv = all.map((s, si) => {
      if (lostSet.size > 0) return lostSet.has(fi + ':' + si) ? null : s;
      return lossFn(fi, si, { isKeyframe: fr.isKeyframe, blockCount: k + m }) ? null : s;
    });
    const missingCount = recv.filter((s) => !s).length;
    const dec = decodeShards(recv, k, m, enc.lengths);
    const decodable = !!dec && dec.every((b, i) => b.equals(data[i].subarray(0, enc.lengths[i])));
    const frameMsNow = fi * frameMs;
    if (missingCount > 0 && lossStartMs === null) lossStartMs = frameMsNow;
    if (!decodable) {
      idrRequests += 1; // 不可恢复 → 一次受控 idr-request（进 IDR 限流，见 idr-core）
      if (recoveredAtMs === null && lossStartMs !== null) recoveredAtMs = null; // 仍未恢复
    } else if (recoveredAtMs === null && lossStartMs !== null) {
      recoveredAtMs = frameMsNow;
    }
    results.push({
      frame: fi, isKeyframe: !!fr.isKeyframe, missingCount, decodable,
      singleLoss: missingCount === 1, doubleLoss: missingCount === 2,
      doubleRecovered: missingCount === 2 && decodable,
    });
  });
  const decodableFrames = results.filter((r) => r.decodable).length;
  const single = results.filter((r) => r.singleLoss);
  const dbl = results.filter((r) => r.doubleLoss);
  const recoveryFrames = (lossStartMs !== null && recoveredAtMs !== null)
    ? Math.round((recoveredAtMs - lossStartMs) / frameMs) : null;
  return {
    results, totalFrames: frames.length, decodableFrames,
    singleLossTotal: single.length, singleRecovered: single.filter((r) => r.decodable).length,
    doubleLossTotal: dbl.length, doubleRecovered: dbl.filter((r) => r.decodable).length,
    idrRequests,
    recoveryMs: (lossStartMs !== null && recoveredAtMs !== null) ? (recoveredAtMs - lossStartMs) : null,
    recoveryFrames,
  };
}

module.exports = {
  gfMul, gfDiv, gfInv, encodeShards, decodeShards, gfInvertMatrix,
  makeBlockHeader, validateBlockHeader, FEC_VERSION,
  mulberry32, burstLossGenerator, simulateFrames,
};
