'use strict';
/*
 * QFRemote Windows 运行端 — RC-03 解码端 FEC 还原＋块组装（3.0.0）
 * ================================================================
 * 依据：QF-VIDEO-1 客户端协议规范 v1（server/ext/QF-VIDEO-1-CLIENT-SPEC.md）
 * §1（分片格式）／§3（解码端行为）。RS 参数与块头校验与服务端
 * server/ext/fec-ref.js 的 encodeShards / decodeShards /
 * makeBlockHeader / validateBlockHeader 逐字节一致（本文件是该参考
 * 实现的客户端移植；测试用服务端原模块双向对拍）。
 *
 * 只定两档，不得自创第三档（规范 §1.1）：
 *   高保护 k=10/m=2（开销 20%，任意 2 丢可恢复，默认档）；
 *   低保护 k=20/m=1（开销 5%，任意 1 丢可恢复，低码率档 smooth）。
 * GF(256)，本原多项式 0x11d，生成元 2；校验行系数 Vandermonde：
 * 校验行 j 对数据分片 i 的系数为 (j+1)^i。
 *
 * 未定项（不编造，规范 §1.3 末尾／§4.2）：
 *   块头无线上传输的二进制打包格式未定义（字段顺序、字节序、块头
 *   是随每分片发送还是带外发送、走哪条通道）。本模块只处理逻辑层
 *   的 { header, data: Buffer } 分片对象，不发明二进制打包格式；
 *   线上格式须 agent 线定版后补进规范 v2，届时再接 pack/unpack。
 *   交织深度 G 不进块头，由收发双方按档位约定（约定值待 agent 线
 *   定版）；本模块按 blockId / symbolIndex 归位，与 G 无关——
 *   交织只影响发送顺序，不影响归位逻辑（minInterleaveDepth 按
 *   规范 §1.4 下限 G ≥ ceil(burstLen / 2) 提供纯函数）。
 *
 * 解码端行为（规范 §3）：
 *   1. 块头非法即整块丢弃，不尝试解码；
 *   2. 0 缺失直接渲染；1–2 缺失（按 m）走 RS 还原；超 m 或可用校验
 *      行不足判不可恢复；
 *   3. 不可恢复判定用超时窗口，不一丢即请求：窗口 = RTT + jitter +
 *      1 帧时长（30fps 下约 33ms）；窗口内等迟到分片，届满仍不可
 *      恢复才丢弃受影响帧并触发一次受控 IDR（reason=loss，由调用
 *      方经 qf-idr.js 发，须进 IDR 限流）；
 *   4. 还原后按 lastSymbolPadding 裁剪尾分片；还原出的帧须完整才
 *      渲染，半帧不得上屏；
 *   5. 每帧一个块，不得跨关键帧（同 blockId 分片 frameId 不一致即
 *      整块丢弃）。
 */
const FEC_VERSION = 1;
// 只许这两档（规范 §1.1；validateBlockHeader 本身接受 k=10/m=1 与
// k=20/m=2 的宽松组合——见规范 §4.1——客户端只许发这两档，不得利用
// 校验宽松发其他组合；FEC_TIERS 是客户端唯一允许的档位表）。
const FEC_TIERS = {
  high: { k: 10, m: 2, repairPercent: 20 },
  low: { k: 20, m: 1, repairPercent: 5 }
};
const ALLOWED_TIERS = [
  { k: 10, m: 2 },
  { k: 20, m: 1 }
];
function isAllowedTier(k, m) {
  return ALLOWED_TIERS.some((t) => t.k === k && t.m === m);
}

// QF-QUALITY-1 §6.1：档位表 fecRepairPercent 到 (k,m) 的映射。
// ≤5% 用 k=20/m=1，≥20% 用 k=10/m=2；中间值（10%/15%）映射待定，
// 不得自行发明第三种 (k,m) 组合。返回 { ok:true, tier } 或
// { ok:false, reason:'fec-repair-unmapped' }。
function fecTierForRepairPercent(pct) {
  const p = Number(pct);
  if (!Number.isFinite(p)) return { ok: false, reason: 'fec-repair-unmapped' };
  if (p <= 5) return { ok: true, tier: 'low', k: 20, m: 1 };
  if (p >= 20) return { ok: true, tier: 'high', k: 10, m: 2 };
  return { ok: false, reason: 'fec-repair-unmapped' };
}

const GF_POLY = 0x11d;
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
  if (missing.length > m) return null;
  const availParity = [];
  for (let j = 0; j < m; j++) if (shards[k + j]) availParity.push(j);
  if (availParity.length < missing.length) return null;
  const t = missing.length;
  const shardLen = shards.find((s) => s) ? shards.find((s) => s).length : 0;
  const rows = availParity.slice(0, t);
  const mat = rows.map((j) => missing.map((i) => parityCoef(j, i)));
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

// ---- 块头（规范 §1.3，与服务端 makeBlockHeader / validateBlockHeader 一字一致） ----
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
    m: Number(f.m) >>> 0
  };
}
function validateBlockHeader(h) {
  if (!h || typeof h !== 'object') return false;
  if (h.fecVersion !== FEC_VERSION) return false;
  if (![1, 2].includes(h.m)) return false;
  if (!(h.k === 10 || h.k === 20)) return false;
  if (h.symbolCount !== h.k + h.m) return false;
  if (h.symbolIndex >= h.symbolCount) return false;
  if (h.symbolLength <= 0) return false;
  if (h.lastSymbolPadding < 0 || h.lastSymbolPadding >= h.symbolLength) return false;
  return true;
}

// 交织深度下限（规范 §1.4）：G ≥ ceil(burstLen / 2)（m=2 时每块至多丢 2 个）。
function minInterleaveDepth(burstLen) {
  const b = Math.max(0, Math.floor(Number(burstLen) || 0));
  return Math.ceil(b / 2);
}

// ---- 块组装器（接收侧归位＋超时窗口判定，规范 §3 第 1–4 条） ----
// receiveShard(header, data: Buffer) → { ok, outcome }：
//   'complete'（0 缺失直接成帧）/ 'recovered'（窗口届满时 RS 还原成帧）/
//   'waiting'（缺片，等迟到分片）/ 'dropped-invalid-header' /
//   'dropped-frame-mismatch' / 'duplicate'（重复分片，覆盖不计两次）。
// checkTimeouts(nowMs, rttMs, jitterMs)：窗口 = rttMs + jitterMs + frameMs；
//   届满仍缺片：缺片 ≤ m 且校验行够 → 还原成帧；否则丢弃该帧并经
//   onUnrecoverable({ blockId, frameId, missingCount, k, m }) 回调一次
//   （调用方据此发一次受控 IDR，reason=loss；同一帧只回调一次）。
// 帧数据只在完整时交出（onFrame 收到的是按真实长度裁剪后的 k 个数据
// 分片拼成的完整帧 Buffer），半帧不上屏。
function createBlockAssembler(opts) {
  const o = opts || {};
  const k = o.k;
  const m = o.m;
  if (!isAllowedTier(k, m)) throw new Error('qf-fec: 只许 k=10/m=2 或 k=20/m=1 两档');
  const frameMs = Number.isFinite(Number(o.frameMs)) && Number(o.frameMs) > 0 ? Number(o.frameMs) : 1000 / 30;
  const maxBlocks = Number.isFinite(Number(o.maxBlocks)) && Number(o.maxBlocks) > 0 ? Math.floor(Number(o.maxBlocks)) : 8;
  const nowMs = typeof o.nowMs === 'function' ? o.nowMs : Date.now;
  const onFrame = typeof o.onFrame === 'function' ? o.onFrame : () => {};
  const onUnrecoverable = typeof o.onUnrecoverable === 'function' ? o.onUnrecoverable : () => {};
  const log = typeof o.log === 'function' ? o.log : () => {};
  const blocks = new Map(); // blockId -> { header(first), frameId, shards[], firstSeenMs, resolved }
  const stats = { received: 0, complete: 0, recovered: 0, unrecoverable: 0, droppedInvalid: 0, droppedMismatch: 0, evicted: 0 };

  function lengthsFor(header) {
    const lens = [];
    for (let i = 0; i < header.k; i++) {
      lens.push(i === header.k - 1 ? header.symbolLength - header.lastSymbolPadding : header.symbolLength);
    }
    return lens;
  }
  function tryEmit(blockId, block, recovered) {
    const dec = decodeShards(block.shards.slice(), block.k, block.m, lengthsFor(block.header));
    blocks.delete(blockId);
    if (!dec) {
      // 走到这里说明校验行不足（理论上 checkTimeouts 已拦下）；按不可恢复计。
      stats.unrecoverable += 1;
      onUnrecoverable({ blockId, frameId: block.frameId, missingCount: block.shards.filter((s) => !s).length, k: block.k, m: block.m });
      return { ok: false, outcome: 'unrecoverable' };
    }
    const frame = Buffer.concat(dec);
    if (recovered) stats.recovered += 1; else stats.complete += 1;
    onFrame({ blockId, frameId: block.frameId, isKeyframe: block.header.isKeyframe, frame, recovered: !!recovered });
    return { ok: true, outcome: recovered ? 'recovered' : 'complete' };
  }

  function receiveShard(header, data) {
    if (!validateBlockHeader(header)) {
      stats.droppedInvalid += 1;
      log('fec.drop-invalid-header block=' + header.blockId);
      return { ok: false, outcome: 'dropped-invalid-header' };
    }
    if (header.k !== k || header.m !== m) {
      // 档位切换只在关键帧/块边界生效（规范 §1.2）；组装器只认建实例时
      // 的档位，跨档位分片不混进同一块——调用方须在档位切换时新建组装器。
      stats.droppedMismatch += 1;
      return { ok: false, outcome: 'dropped-tier-mismatch' };
    }
    if (!Buffer.isBuffer(data) || data.length !== header.symbolLength) {
      stats.droppedInvalid += 1;
      return { ok: false, outcome: 'dropped-invalid-header' };
    }
    stats.received += 1;
    const blockId = header.blockId;
    let block = blocks.get(blockId);
    if (!block) {
      if (blocks.size >= maxBlocks) {
        // 最旧未完成块让位：帧已被后续帧 supersede，只计数、不触发 IDR。
        const oldest = blocks.keys().next().value;
        blocks.delete(oldest);
        stats.evicted += 1;
      }
      block = {
        header, frameId: header.frameId, k: header.k, m: header.m,
        shards: new Array(header.k + header.m).fill(null),
        firstSeenMs: nowMs()
      };
      blocks.set(blockId, block);
    }
    if (block.frameId !== header.frameId) {
      // 每帧一个块，不得跨关键帧（规范 §1.2）：同块不同帧即整块丢弃。
      blocks.delete(blockId);
      stats.droppedMismatch += 1;
      log('fec.drop-frame-mismatch block=' + blockId);
      return { ok: false, outcome: 'dropped-frame-mismatch' };
    }
    const duplicate = !!block.shards[header.symbolIndex];
    block.shards[header.symbolIndex] = Buffer.from(data);
    if (duplicate) return { ok: true, outcome: 'duplicate' };
    const missing = block.shards.filter((s) => !s).length;
    if (missing === 0) return tryEmit(blockId, block, false);
    return { ok: true, outcome: 'waiting', missing };
  }

  function checkTimeouts(now, rttMs, jitterMs) {
    const nowVal = Number(now) || nowMs();
    const rtt = Math.max(0, Number(rttMs) || 0);
    const jit = Math.max(0, Number(jitterMs) || 0);
    const windowMs = rtt + jit + frameMs;
    const out = [];
    for (const [blockId, block] of Array.from(blocks.entries())) {
      if (nowVal - block.firstSeenMs < windowMs) continue;
      const missingIdx = [];
      block.shards.forEach((s, i) => { if (!s && i < block.k) missingIdx.push(i); });
      const availParity = block.shards.slice(block.k).filter(Boolean).length;
      if (missingIdx.length > 0 && missingIdx.length <= block.m && availParity >= missingIdx.length) {
        out.push(tryEmit(blockId, block, true));
      } else if (missingIdx.length === 0) {
        out.push(tryEmit(blockId, block, false));
      } else {
        blocks.delete(blockId);
        stats.unrecoverable += 1;
        const info = { blockId, frameId: block.frameId, missingCount: missingIdx.length, k: block.k, m: block.m };
        onUnrecoverable(info);
        out.push({ ok: false, outcome: 'unrecoverable', info });
      }
    }
    return out;
  }

  return {
    receiveShard,
    checkTimeouts,
    pendingBlocks: () => blocks.size,
    stats: () => Object.assign({}, stats),
    tier: () => ({ k, m })
  };
}

module.exports = {
  FEC_VERSION,
  FEC_TIERS,
  ALLOWED_TIERS,
  isAllowedTier,
  fecTierForRepairPercent,
  gfMul, gfDiv, gfInv,
  encodeShards,
  decodeShards,
  makeBlockHeader,
  validateBlockHeader,
  minInterleaveDepth,
  createBlockAssembler
};
