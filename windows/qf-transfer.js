'use strict';
/*
 * QFRemote Windows 运行端 — RC-08 文件传输客户端（3.0.0）
 * ========================================================
 * 依据：QF-STREAM-1 客户端协议规范 v1（server/ext/QF-STREAM-1-CLIENT-SPEC.md）
 * 全文。服务端实现见 server/ext/transfer-core.js（流状态机＋分片落盘＋
 * 审计 exactly-once）与 server/ext/files-core.js（stage/inbox/ack，
 * 行为未改）；路由见 server/ext/server.js（/license/api/files/stream/*、
 * /license/api/files/audit、下载 Range 分支）。
 *
 * 流程（规范 §1）：init → chunk（0..N-1，可乱序、可重发）→ commit →
 * staged；断网/中断 → missing 查缺片 → 补传缺片 → commit；取消 cancel
 * （仅 uploading 态）；对端 inbox → download（可 Range 续传）→ ack。
 * 审计每次传输恰一条（init/chunk 不记审计），客户端只展示、不伪造。
 *
 * 关键语义（错一点即整单作废，须逐字遵守）：
 *   - 客户端须用 init 返回的 chunkSize 切分，不得用自己请求的值
 *     （服务端钳制到 64KB～4MB，默认 1MB）；
 *   - 没有字面 /resume 端点：断点续传 = GET …/missing（规范 §5.1），
 *     本模块不发任何 /resume 请求；
 *   - commit 返回 INCOMPLETE 是唯一可继续的状态（补传缺片后再 commit）；
 *     CORRUPT / IO 后整单作废，分片已清，该 transferId 不能再用，须
 *     重新 init 一个新传输（重传同一文件须重新算 SHA-256、重新上传
 *     全部分片）；
 *   - cancel 仅 uploading 态可取消；commit 成功后没有取消端点（已暂存
 *     的文件靠 24h 到期自动清），commit 提交中须禁点取消与重复提交；
 *   - 下载用 stagedId（fs_…），不是 transferId（tf_…）；Range 非法时
 *     服务端回落为 200 全文件（不返回 416）——客户端收到 200 时须按
 *     全文件处理，不得当作区间响应拼装；
 *   - 审计的 chunks 字段是 totalChunks（总数），不是已收分片数。
 *
 * 本模块只处理协议与状态机：上传入参是内存 Buffer（文件从磁盘读入由
 * 调用方负责——主进程 dialog/ fs 在调用层，模块本身不碰磁盘、不碰
 * Electron dialog）；下载出参是 Buffer（落盘由调用方负责）。下载走
 * 注入的 requestRaw（返回 { status, headers, body: Buffer }），因为
 * extRequest 只回 utf8 文本、二进制会损坏。
 */
const crypto = require('crypto');
const STREAM_BASE = '/license/api/files/stream';
const FILES_BASE = '/license/api/files';
const DEFAULT_CHUNK_SIZE = 1024 * 1024; // 1MB（服务端默认值，规范 §2.1）
const SHA256_RE = /^[0-9a-f]{64}$/;
const TRANSFER_STATES = ['idle', 'uploading', 'interrupted', 'committing', 'staged', 'cancelled', 'failed'];
const UI_MESSAGES = {
  CORRUPT: '校验失败，须重新发送',
  INCOMPLETE: '分片未齐，正在补传缺片',
  TOO_LARGE: '文件超过单文件上限',
  VALIDATION: '请求参数不正确',
  NOT_FOUND: '传输不存在或不是本人发起',
  STATE: '传输不在上传态',
  IO: '服务端写入失败，传输已作废'
};

function sha256Hex(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new Error('qf-transfer: sha256 入参须为 Buffer');
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

// 分片期望长度（规范 §2.2）：非末片 = chunkSize，末片 = size - index*chunkSize。
function expectedChunkLength(index, totalChunks, size, chunkSize) {
  if (index === totalChunks - 1) return size - index * chunkSize;
  return chunkSize;
}
function totalChunksFor(size, chunkSize) {
  return Math.ceil(size / chunkSize);
}
// Range 请求头（QF-STREAM-1 §2.6；服务端 parseRange 语义）。
function buildRangeHeader(start, end) {
  if (Number.isFinite(end)) return 'bytes=' + start + '-' + end;
  return 'bytes=' + start + '-';
}
// 服务端 Content-Range 解析：'bytes start-end/size'。
function parseContentRange(header) {
  if (typeof header !== 'string') return null;
  const m = header.match(/^bytes\s+(\d+)-(\d+)\/(\d+)$/);
  if (!m) return null;
  return { start: Number(m[1]), end: Number(m[2]), size: Number(m[3]) };
}

function createFileTransferClient(opts) {
  const o = opts || {};
  if (typeof o.request !== 'function') throw new Error('qf-transfer: request 注入缺失');
  if (typeof o.requestRaw !== 'function') throw new Error('qf-transfer: requestRaw 注入缺失（下载须回原始字节）');
  if (typeof o.baseUrl !== 'string' || !o.baseUrl) throw new Error('qf-transfer: baseUrl 缺失');
  const request = o.request;
  const requestRaw = o.requestRaw;
  const baseUrl = String(o.baseUrl).replace(/\/+$/, '');
  const nowMs = typeof o.nowMs === 'function' ? o.nowMs : Date.now;
  const log = typeof o.log === 'function' ? o.log : () => {};

  // 单次上传会话（内存态；transferId 与分片收讫集只活在内存里，
  // 不落盘——断网重连后凭 transferId 调 missing 续传，进程重启后
  // 须重新 init，旧 transferId 续不上，见收尾报告）。
  let up = null; // { transferId, filename, size, sha256, chunkSize, totalChunks, toNode, fromNode, received:Set, state, stagedId, expiresAt, lastCode, startedAt }
  let cancelledFlag = false;

  function newUploadState() {
    return {
      transferId: '', filename: '', size: 0, sha256: '', chunkSize: DEFAULT_CHUNK_SIZE,
      totalChunks: 0, toNode: '', fromNode: '', received: new Set(),
      state: 'idle', stagedId: '', expiresAt: 0, lastCode: '', startedAt: 0
    };
  }
  function resetUpload() { up = newUploadState(); cancelledFlag = false; }
  resetUpload();

  function errorCodeOf(json) {
    if (json && typeof json.code === 'string' && json.code) return json.code;
    return '';
  }
  function failResult(kind, code, extra) {
    return Object.assign({ ok: false, kind, code: code || '' }, extra || {});
  }

  // ---- 上传：init ----
  async function startUpload(meta) {
    const m = meta || {};
    const filename = String(m.filename || '');
    const size = Number(m.size);
    const sha256 = String(m.sha256 || '').toLowerCase();
    const toNode = String(m.toNode || '');
    const fromNode = String(m.fromNode || '');
    // 客户端先校验（与服务端 init 同款 VALIDATION，不合格不发请求）。
    if (!filename) return failResult('validation', 'VALIDATION');
    if (!Number.isFinite(size) || size <= 0) return failResult('validation', 'VALIDATION');
    if (!SHA256_RE.test(sha256)) return failResult('validation', 'VALIDATION');
    if (!toNode) return failResult('validation', 'VALIDATION');
    if (fromNode && fromNode === toNode) return failResult('validation', 'VALIDATION');
    resetUpload();
    let res;
    try {
      res = await request('POST', baseUrl + STREAM_BASE + '/init', {
        filename, size, sha256,
        chunkSize: Number(m.chunkSize) || DEFAULT_CHUNK_SIZE,
        toNode, fromNode: fromNode || undefined
      });
    } catch (e) {
      return failResult('network', '');
    }
    const status = (res && typeof res.status === 'number') ? res.status : 0;
    const json = (res && res.json) || null;
    if (status === 503 && json && json.code === 'L5_UNAVAILABLE') return failResult('unavailable', 'L5_UNAVAILABLE');
    if (status !== 200 || !json || json.ok !== true || !json.transferId) {
      return failResult('rejected', errorCodeOf(json));
    }
    // 关键：用服务端返回的 chunkSize 切分（可能已被钳制），不用请求值。
    up.transferId = String(json.transferId);
    up.filename = filename;
    up.size = size;
    up.sha256 = sha256;
    up.chunkSize = Number(json.chunkSize) || DEFAULT_CHUNK_SIZE;
    up.totalChunks = Number(json.totalChunks) || totalChunksFor(size, up.chunkSize);
    up.toNode = toNode;
    up.fromNode = fromNode;
    up.state = 'uploading';
    up.startedAt = nowMs();
    log('transfer.init id=' + up.transferId + ' chunks=' + up.totalChunks + ' chunkSize=' + up.chunkSize);
    return { ok: true, transferId: up.transferId, chunkSize: up.chunkSize, totalChunks: up.totalChunks };
  }

  // ---- 上传：单个分片 ----
  async function uploadChunk(index, buffer) {
    if (!up.transferId || up.state !== 'uploading') return failResult('state', 'STATE');
    if (!Number.isInteger(index) || index < 0 || index >= up.totalChunks) return failResult('validation', 'VALIDATION');
    if (!Buffer.isBuffer(buffer) || !buffer.length) return failResult('validation', 'VALIDATION');
    const expectLen = expectedChunkLength(index, up.totalChunks, up.size, up.chunkSize);
    if (buffer.length !== expectLen) {
      return failResult('validation', 'VALIDATION', { expectedLength: expectLen, actualLength: buffer.length });
    }
    let res;
    try {
      res = await request('POST', baseUrl + STREAM_BASE + '/' + encodeURIComponent(up.transferId) + '/chunk',
        { index, contentBase64: buffer.toString('base64') });
    } catch (e) {
      up.state = 'interrupted';
      return failResult('network', '', { state: 'interrupted' });
    }
    const status = (res && typeof res.status === 'number') ? res.status : 0;
    const json = (res && res.json) || null;
    if (status !== 200 || !json || json.ok !== true) {
      const code = errorCodeOf(json);
      if (code === 'STATE' || code === 'NOT_FOUND') { up.state = 'failed'; up.lastCode = code; }
      return failResult(code === 'VALIDATION' ? 'validation' : 'rejected', code);
    }
    up.received.add(index);
    return { ok: true, received: Number(json.received) || up.received.size, totalChunks: up.totalChunks };
  }

  // ---- 上传：顺序传完全部缺片（onProgress 可选回调 { received, totalChunks, bytesSent, bytesTotal }） ----
  async function uploadBuffer(buffer, onProgress) {
    if (!up.transferId || (up.state !== 'uploading' && up.state !== 'interrupted')) {
      return failResult('state', 'STATE');
    }
    if (!Buffer.isBuffer(buffer) || buffer.length !== up.size) return failResult('validation', 'VALIDATION');
    if (up.state === 'interrupted') up.state = 'uploading';
    cancelledFlag = false;
    for (let i = 0; i < up.totalChunks; i++) {
      if (cancelledFlag) return failResult('cancelled', '', { state: up.state });
      if (up.received.has(i)) continue; // 已收分片不重传（断点续传只补缺片）
      const start = i * up.chunkSize;
      const end = Math.min(up.size, start + up.chunkSize);
      const r = await uploadChunk(i, buffer.subarray(start, end));
      if (!r.ok) {
        if (r.kind === 'network') return failResult('interrupted', '', { state: 'interrupted', failedIndex: i });
        return r;
      }
      if (typeof onProgress === 'function') {
        try {
          onProgress({ received: up.received.size, totalChunks: up.totalChunks, bytesSent: bytesSent(), bytesTotal: up.size });
        } catch (e) { /* ignore */ }
      }
    }
    return { ok: true, received: up.received.size, totalChunks: up.totalChunks };
  }

  // ---- 断点续传：GET …/missing（没有字面 /resume 端点，规范 §5.1） ----
  async function queryMissing() {
    if (!up.transferId) return failResult('state', 'STATE');
    let res;
    try {
      res = await request('GET', baseUrl + STREAM_BASE + '/' + encodeURIComponent(up.transferId) + '/missing', null);
    } catch (e) {
      return failResult('network', '');
    }
    const status = (res && typeof res.status === 'number') ? res.status : 0;
    const json = (res && res.json) || null;
    if (status !== 200 || !json || json.ok !== true) return failResult('rejected', errorCodeOf(json));
    const missing = Array.isArray(json.missing) ? json.missing.slice() : [];
    // 服务端 missing 是升序缺失序号；本地收讫集以服务端为准同步。
    const received = new Set();
    for (let i = 0; i < up.totalChunks; i++) if (missing.indexOf(i) < 0) received.add(i);
    up.received = received;
    return { ok: true, transferId: up.transferId, status: json.status || up.state, received: received.size, totalChunks: up.totalChunks, missing };
  }

  // 断网后恢复：查缺片 → 只补缺片 → 回到 uploading 态。
  async function resumeUpload(buffer, onProgress) {
    const q = await queryMissing();
    if (!q.ok) {
      if (q.code === 'NOT_FOUND') { up.state = 'failed'; up.lastCode = 'NOT_FOUND'; }
      return q;
    }
    if (up.state === 'interrupted' || up.state === 'uploading') up.state = 'uploading';
    return uploadBuffer(buffer, onProgress);
  }

  // ---- commit：拼装＋校验＋暂存 ----
  async function commit() {
    if (!up.transferId) return failResult('state', 'STATE');
    if (up.state === 'staged') return failResult('already-committed', 'STATE');
    if (up.state === 'committing') return failResult('busy', 'STATE');
    if (up.state !== 'uploading') return failResult('state', 'STATE');
    up.state = 'committing';
    let res;
    try {
      res = await request('POST', baseUrl + STREAM_BASE + '/' + encodeURIComponent(up.transferId) + '/commit', {});
    } catch (e) {
      up.state = 'uploading';
      return failResult('network', '', { state: 'uploading' });
    }
    const status = (res && typeof res.status === 'number') ? res.status : 0;
    const json = (res && res.json) || null;
    if (status === 200 && json && json.ok === true) {
      up.state = 'staged';
      up.stagedId = String(json.stagedId || '');
      up.expiresAt = Number(json.expiresAt) || 0;
      log('transfer.committed id=' + up.transferId + ' staged=' + up.stagedId);
      return { ok: true, transferId: up.transferId, stagedId: up.stagedId, size: Number(json.size) || up.size, expiresAt: up.expiresAt };
    }
    const code = errorCodeOf(json);
    if (code === 'INCOMPLETE') {
      // 唯一可继续的状态：回 uploading，补传缺片后再 commit。
      up.state = 'uploading';
      return failResult('incomplete', 'INCOMPLETE', { missing: Array.isArray(json.missing) ? json.missing.slice() : [] });
    }
    // CORRUPT / IO：整单作废，transferId 不能再用（规范 §2.4）。
    up.state = 'failed';
    up.lastCode = code || 'IO';
    return failResult('terminal', code || 'IO', { needReinit: true, message: UI_MESSAGES[code] || UI_MESSAGES.IO });
  }

  // 一站式完成：补传缺片 → commit；INCOMPLETE 时最多再补两轮。
  async function completeUpload(buffer, onProgress) {
    const upRes = await uploadBuffer(buffer, onProgress);
    if (!upRes.ok) return upRes;
    // F-WIN-04（2026-11-15）：终态返回服务端最后一次 commit 报告的
    // 缺失序号数组（与 commit() 的 INCOMPLETE 分支同型）。不得返回
    // 本地已收分片“个数”（旧代码错在 Array.from(up.received).length，
    // 调用方按数组处理时 .length 巧合成立、indexOf／迭代会错），也
    // 不得用本地收讫集现算——服务端静默丢片时本地收讫集会误以为已齐。
    let lastMissing = [];
    for (let round = 0; round < 3; round++) {
      const c = await commit();
      if (c.ok) return c;
      if (c.kind !== 'incomplete') return c;
      lastMissing = Array.isArray(c.missing) ? c.missing.slice() : [];
      const q = await queryMissing();
      if (!q.ok) return q;
      const again = await uploadBuffer(buffer, onProgress);
      if (!again.ok) return again;
    }
    return failResult('incomplete', 'INCOMPLETE', { missing: lastMissing });
  }

  // ---- cancel：仅 uploading 态；commit 提交中禁点取消 ----
  async function cancel() {
    if (!up.transferId) return failResult('state', 'STATE');
    if (up.state === 'committing') return failResult('busy', 'STATE', { message: '提交中，无法取消' });
    if (up.state !== 'uploading' && up.state !== 'interrupted') {
      return failResult('state', 'STATE', { message: up.state === 'staged' ? '已暂存的文件没有取消端点，靠到期自动清' : '传输不在上传态' });
    }
    cancelledFlag = true;
    let res;
    try {
      res = await request('POST', baseUrl + STREAM_BASE + '/' + encodeURIComponent(up.transferId) + '/cancel', {});
    } catch (e) {
      cancelledFlag = false;
      return failResult('network', '');
    }
    const status = (res && typeof res.status === 'number') ? res.status : 0;
    const json = (res && res.json) || null;
    if (status === 200 && json && json.ok === true) {
      up.state = 'cancelled';
      return { ok: true, transferId: up.transferId, status: 'cancelled' };
    }
    cancelledFlag = false;
    return failResult('rejected', errorCodeOf(json));
  }

  function bytesSent() {
    if (!up.totalChunks) return 0;
    let n = 0;
    for (const i of up.received) {
      n += expectedChunkLength(i, up.totalChunks, up.size, up.chunkSize);
    }
    return n;
  }

  // ---- 对端：inbox / sent / ack / audit ----
  async function listInbox(node) {
    let res;
    try {
      res = await request('GET', baseUrl + FILES_BASE + '/inbox?node=' + encodeURIComponent(String(node || '')), null);
    } catch (e) { return failResult('network', ''); }
    const json = (res && res.json) || null;
    if (res && res.status === 200 && json && json.ok === true) {
      return { ok: true, files: Array.isArray(json.files) ? json.files : [], limits: json.limits || null };
    }
    return failResult('rejected', errorCodeOf(json));
  }
  async function listSent() {
    let res;
    try {
      res = await request('GET', baseUrl + FILES_BASE + '/sent', null);
    } catch (e) { return failResult('network', ''); }
    const json = (res && res.json) || null;
    if (res && res.status === 200 && json && json.ok === true) {
      return { ok: true, files: Array.isArray(json.files) ? json.files : [] };
    }
    return failResult('rejected', errorCodeOf(json));
  }
  async function ackFile(stagedId) {
    if (!stagedId) return failResult('validation', 'VALIDATION');
    let res;
    try {
      res = await request('POST', baseUrl + FILES_BASE + '/' + encodeURIComponent(String(stagedId)) + '/ack', {});
    } catch (e) { return failResult('network', ''); }
    const json = (res && res.json) || null;
    if (res && res.status === 200 && json && json.ok === true) return { ok: true, acked: json };
    return failResult('rejected', errorCodeOf(json));
  }
  async function listAudit(limit) {
    const lim = Math.max(1, Math.min(200, Number(limit) || 50));
    let res;
    try {
      res = await request('GET', baseUrl + FILES_BASE + '/audit?limit=' + lim, null);
    } catch (e) { return failResult('network', ''); }
    const json = (res && res.json) || null;
    if (res && res.status === 200 && json && json.ok === true) {
      return { ok: true, audit: Array.isArray(json.audit) ? json.audit : [] };
    }
    return failResult('rejected', errorCodeOf(json));
  }

  // ---- 对端下载：Range 续传（stagedId，不是 transferId） ----
  // downloadResumable(stagedId, existing: Buffer|null)：existing 为已下载
  // 的前缀字节（可为空）；带 Range 请求后续区间。收到 206 按区间拼装；
  // 收到 200 按全文件处理（服务端非法 Range 回落，不返回 416）——此时
  // 丢弃已下载前缀、返回整文件（调用方以返回的 body 为准重写落盘）。
  async function downloadResumable(stagedId, existing, onProgress) {
    if (!stagedId) return failResult('validation', 'VALIDATION');
    const have = Buffer.isBuffer(existing) ? existing : Buffer.alloc(0);
    const headers = {};
    if (have.length > 0) headers.Range = buildRangeHeader(have.length);
    let res;
    try {
      res = await requestRaw('GET', baseUrl + FILES_BASE + '/' + encodeURIComponent(String(stagedId)) + '/download', headers);
    } catch (e) {
      return failResult('network', '');
    }
    const status = (res && typeof res.status === 'number') ? res.status : 0;
    const body = (res && Buffer.isBuffer(res.body)) ? res.body : Buffer.alloc(0);
    const resHeaders = (res && res.headers) || {};
    if (status === 404) return failResult('not-found', 'NOT_FOUND', { message: '文件不存在或已过期' });
    if (status === 206) {
      const cr = parseContentRange(resHeaders['content-range'] || resHeaders['Content-Range']);
      if (!cr || cr.start !== have.length || body.length !== cr.end - cr.start + 1) {
        return failResult('range-mismatch', 'VALIDATION', { message: '区间响应与请求不符，未拼装' });
      }
      const out = Buffer.concat([have, body]);
      if (typeof onProgress === 'function') { try { onProgress({ received: out.length, total: cr.size }); } catch (e) { /* ignore */ } }
      return { ok: true, body: out, totalSize: cr.size, complete: out.length >= cr.size, fromRange: true };
    }
    if (status === 200) {
      // 无 Range 或服务端回落：整文件（Content-Length 即全文件长）。
      const total = Number(resHeaders['content-length'] || resHeaders['Content-Length']) || body.length;
      if (typeof onProgress === 'function') { try { onProgress({ received: body.length, total }); } catch (e) { /* ignore */ } }
      return { ok: true, body, totalSize: total, complete: body.length >= total, fromRange: false, fullFileFallback: have.length > 0 };
    }
    return failResult('rejected', '', { status });
  }

  // 收件箱文件是否过期（过期置灰不可下载，规范 §4）。
  function isFileExpired(file, now) {
    if (!file || !Number.isFinite(Number(file.expiresAt))) return false;
    return (Number(now) || nowMs()) >= Number(file.expiresAt);
  }

  // UI 状态机快照（规范 §4）：上传进度按分片数＋字节；取消只在
  // uploading 态可用；commit 提交中禁点取消与重复提交；CORRUPT 时
  // 给“重新发送”入口（= 重新 init），不给“重试提交”。
  function getUiState() {
    const percent = up.totalChunks ? Math.round((up.received.size / up.totalChunks) * 100) : 0;
    return {
      state: up.state,
      transferId: up.transferId,
      filename: up.filename,
      received: up.received.size,
      totalChunks: up.totalChunks,
      bytesSent: bytesSent(),
      bytesTotal: up.size,
      percent,
      canCancel: up.state === 'uploading' || up.state === 'interrupted',
      canCommit: up.state === 'uploading',
      canResume: up.state === 'interrupted',
      canReupload: up.state === 'failed' || up.state === 'cancelled',
      canRetryCommit: false, // CORRUPT 后没有“重试提交”，只有重新发送
      stagedId: up.stagedId,
      expiresAt: up.expiresAt,
      expiresInMs: up.expiresAt ? Math.max(0, up.expiresAt - nowMs()) : 0,
      lastCode: up.lastCode,
      message: up.state === 'failed' && up.lastCode === 'CORRUPT'
        ? UI_MESSAGES.CORRUPT
        : up.state === 'failed' && UI_MESSAGES[up.lastCode]
          ? UI_MESSAGES[up.lastCode]
          : up.state === 'staged' ? '已暂存，对端可在收件箱下载'
            : up.state === 'interrupted' ? '连接中断，可断点续传'
              : ''
    };
  }

  return {
    startUpload,
    uploadChunk,
    uploadBuffer,
    queryMissing,
    resumeUpload,
    commit,
    completeUpload,
    cancel,
    listInbox,
    listSent,
    ackFile,
    listAudit,
    downloadResumable,
    isFileExpired,
    getUiState,
    getUploadState: () => Object.assign({}, up, { received: new Set(up.received) }),
    resetUpload
  };
}

module.exports = {
  STREAM_BASE,
  FILES_BASE,
  DEFAULT_CHUNK_SIZE,
  TRANSFER_STATES,
  UI_MESSAGES,
  sha256Hex,
  expectedChunkLength,
  totalChunksFor,
  buildRangeHeader,
  parseContentRange,
  createFileTransferClient
};
