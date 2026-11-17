'use strict';
/*
 * QFRemote 扩展服务 · L5 RC-08：文件传输统一流抽象＋分片（协议 QF-STREAM-1）
 * ========================================================================
 * 来源：Guacamole stream/file 抽象＋blob 分片（只学“分片＋流抽象”
 * 思路，不抄 6048 字节分片值）；HopToDesk log_file_transfer()
 * （每次传输记一条审计，只记元数据，不记文件内容）。
 *
 * 现状（files-core.js）：同账号设备间文件发送是整文件 base64 一次性
 * 上传 → 服务端暂存 24h → 目标端下载＋ack；无分片、无断点续传、
 * 无传输审计。本模块是加法层，不改 files-core 的 stage/inbox/ack/
 * sweep 语义，只复用它的暂存（经新加的 stageBuffer 入口）：
 *
 *   流接口（init → chunk* → commit → download → ack，取消 cancel）：
 *   - init：元数据（文件名/大小/SHA-256/分片大小/目标节点），返回
 *     transferId＋分片表；分片默认 1MB（可配 64KB～4MB）。
 *   - putChunk：按序号写分片（乱序可达），断网后 resume-query 取缺片。
 *   - commit：齐片后按序拼装＋SHA-256 校验，通过才进 file-stage
 *     暂存（复用 24h 暂存、收件箱、ack、sweep）；校验失败整单作废。
 *   - download：复用既有下载端点；本模块只出 parseRange（Range
 *     分片下载，206＋Content-Range）。
 *   - cancel：清分片＋记一条 cancelled 审计。
 *   - 进度回调、取消、断网重连语义由三端按本接口实现，保证一致。
 *
 * 审计（每次传输恰一条）：
 *   - 追加式审计文件 transfer-audit.jsonl（与 events.json 审核队列
 *     分离；只记元数据：transferId/username/文件名/大小/对端节点/
 *     分片数/结果/起止时间，不记文件内容）。
 *   - exactly-once：终态事件（commit 成功/失败、cancel、过期）首次
 *     落审计时以 transferId 去重（内存 Set＋启动时扫审计文件重建）；
 *     init/chunk 不记审计。
 *   - 审计查询只返回本人记录（调用方鉴权后按 username 过滤）。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_CHUNK_SIZE = 1024 * 1024; // 1MB
const MIN_CHUNK_SIZE = 64 * 1024;
const MAX_CHUNK_SIZE = 4 * 1024 * 1024;

function createTransferCore(deps) {
  const dir = deps.dir;
  const log = deps.log || (() => {});
  const stageBuffer = deps.stageBuffer; // files-core.stageBuffer
  const limits = deps.limits || (() => ({ maxBytes: 200 * 1024 * 1024, stageMs: 24 * 3600000 }));
  const chunkRoot = path.join(dir, 'transfer-chunks');
  const auditFile = path.join(dir, 'transfer-audit.jsonl');
  try { fs.mkdirSync(chunkRoot, { recursive: true, mode: 0o700 }); } catch (e) {}

  // 启动时扫审计文件重建已审计集合（exactly-once 跨重启）。
  const audited = new Set();
  try {
    const raw = fs.readFileSync(auditFile, 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try { const e = JSON.parse(line); if (e && e.transferId) audited.add(e.transferId); } catch (ignored) {}
    }
  } catch (e) { if (e && e.code !== 'ENOENT') log({ ev: 'transfer-audit-load-error', err: String(e && e.message || e) }); }

  function manifestPath(id) { return path.join(chunkRoot, id + '.json'); }
  function chunkDir(id) { return path.join(chunkRoot, id); }
  function readManifest(id) {
    try { return JSON.parse(fs.readFileSync(manifestPath(id), 'utf8')); } catch (e) { return null; }
  }
  function writeManifest(m) {
    const tmp = manifestPath(m.transferId) + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(m), { mode: 0o600 });
    fs.renameSync(tmp, manifestPath(m.transferId));
  }
  function cleanup(id) {
    try { fs.rmSync(chunkDir(id), { recursive: true, force: true }); } catch (e) {}
    try { fs.unlinkSync(manifestPath(id)); } catch (e) {}
  }
  function auditOnce(m, result, extra) {
    if (audited.has(m.transferId)) return false;
    audited.add(m.transferId);
    const entry = Object.assign({
      transferId: m.transferId, username: m.username, filename: m.filename,
      size: m.size, sha256: m.sha256, fromNode: m.fromNode, toNode: m.toNode,
      chunks: m.totalChunks, result, startedAt: m.createdAt, endedAt: Date.now(),
    }, extra || {});
    try { fs.appendFileSync(auditFile, JSON.stringify(entry) + '\n', { mode: 0o600 }); } catch (e) {
      log({ ev: 'transfer-audit-write-error', transferId: m.transferId, err: String(e && e.message || e) });
    }
    return true;
  }

  function init(username, meta, now) {
    const lim = limits();
    const filename = String((meta && meta.filename) || '').slice(0, 200).replace(/[/\\]/g, '_') || 'file';
    const toNode = String((meta && meta.toNode) || '').slice(0, 200);
    const fromNode = String((meta && meta.fromNode) || '').slice(0, 200);
    const size = Number(meta && meta.size);
    const sha256 = String((meta && meta.sha256) || '').toLowerCase();
    let chunkSize = Number(meta && meta.chunkSize) || DEFAULT_CHUNK_SIZE;
    if (!toNode) return { ok: false, code: 'VALIDATION', msg: '请选择要发送到的设备。' };
    if (fromNode && toNode === fromNode) return { ok: false, code: 'VALIDATION', msg: '目标设备与来源设备相同，请选择另一台设备。' };
    if (!Number.isFinite(size) || size <= 0) return { ok: false, code: 'VALIDATION', msg: '文件大小不正确。' };
    if (size > lim.maxBytes) return { ok: false, code: 'TOO_LARGE', msg: '文件超过单文件上限。' };
    if (!/^[0-9a-f]{64}$/.test(sha256)) return { ok: false, code: 'VALIDATION', msg: '缺少 SHA-256 校验值。' };
    chunkSize = Math.max(MIN_CHUNK_SIZE, Math.min(MAX_CHUNK_SIZE, chunkSize));
    const totalChunks = Math.ceil(size / chunkSize);
    const m = {
      transferId: 'tf_' + crypto.randomBytes(8).toString('hex'),
      username, filename, size, sha256, chunkSize, totalChunks,
      toNode, fromNode, status: 'uploading', createdAt: now, updatedAt: now,
      received: {},
    };
    try {
      fs.mkdirSync(chunkDir(m.transferId), { recursive: true, mode: 0o700 });
      writeManifest(m);
    } catch (e) {
      return { ok: false, code: 'IO', msg: '传输初始化失败。' };
    }
    return { ok: true, transferId: m.transferId, chunkSize, totalChunks };
  }

  function putChunk(username, transferId, index, buf, now) {
    const m = readManifest(transferId);
    if (!m || m.username !== username) return { ok: false, code: 'NOT_FOUND', msg: '传输不存在。' };
    if (m.status !== 'uploading') return { ok: false, code: 'STATE', msg: '传输不在上传态。' };
    if (!Number.isInteger(index) || index < 0 || index >= m.totalChunks) return { ok: false, code: 'VALIDATION', msg: '分片序号越界。' };
    if (!Buffer.isBuffer(buf) || !buf.length) return { ok: false, code: 'VALIDATION', msg: '分片内容为空。' };
    const expectLen = index === m.totalChunks - 1 ? (m.size - index * m.chunkSize) : m.chunkSize;
    if (buf.length !== expectLen) return { ok: false, code: 'VALIDATION', msg: '分片长度不符（期望 ' + expectLen + ' 字节）。' };
    try {
      fs.writeFileSync(path.join(chunkDir(transferId), index + '.part'), buf, { mode: 0o600 });
    } catch (e) {
      return { ok: false, code: 'IO', msg: '分片写入失败。' };
    }
    m.received[String(index)] = true;
    m.updatedAt = now;
    writeManifest(m);
    return { ok: true, received: Object.keys(m.received).length, totalChunks: m.totalChunks };
  }

  function missingChunks(username, transferId) {
    const m = readManifest(transferId);
    if (!m || m.username !== username) return { ok: false, code: 'NOT_FOUND', msg: '传输不存在。' };
    const missing = [];
    for (let i = 0; i < m.totalChunks; i++) if (!m.received[String(i)]) missing.push(i);
    return { ok: true, transferId, status: m.status, received: Object.keys(m.received).length, totalChunks: m.totalChunks, missing };
  }

  function commit(username, transferId, now) {
    const m = readManifest(transferId);
    if (!m || m.username !== username) return { ok: false, code: 'NOT_FOUND', msg: '传输不存在。' };
    if (m.status !== 'uploading') return { ok: false, code: 'STATE', msg: '传输不在上传态。' };
    const missing = [];
    for (let i = 0; i < m.totalChunks; i++) if (!m.received[String(i)]) missing.push(i);
    if (missing.length) return { ok: false, code: 'INCOMPLETE', msg: '分片未齐。', missing };
    const parts = [];
    try {
      for (let i = 0; i < m.totalChunks; i++) {
        parts.push(fs.readFileSync(path.join(chunkDir(transferId), i + '.part')));
      }
    } catch (e) {
      auditOnce(m, 'failed', { reason: 'chunk-read-error' });
      cleanup(transferId);
      return { ok: false, code: 'IO', msg: '分片读取失败，传输已作废。' };
    }
    const buf = Buffer.concat(parts);
    if (buf.length !== m.size) {
      auditOnce(m, 'failed', { reason: 'size-mismatch' });
      cleanup(transferId);
      return { ok: false, code: 'CORRUPT', msg: '拼装后大小不符，传输已作废。' };
    }
    const hash = crypto.createHash('sha256').update(buf).digest('hex');
    if (hash !== m.sha256) {
      auditOnce(m, 'failed', { reason: 'sha-mismatch' });
      cleanup(transferId);
      return { ok: false, code: 'CORRUPT', msg: 'SHA-256 校验失败，传输已作废。' };
    }
    const staged = stageBuffer(username, { filename: m.filename, toNode: m.toNode, fromNode: m.fromNode, buf }, now);
    if (!staged.ok) {
      auditOnce(m, 'failed', { reason: 'stage-' + (staged.code || 'IO') });
      cleanup(transferId);
      return { ok: false, code: staged.code || 'IO', msg: staged.msg || '暂存失败。' };
    }
    auditOnce(m, 'completed', { stagedId: staged.id });
    cleanup(transferId);
    return { ok: true, transferId, stagedId: staged.id, size: m.size, expiresAt: staged.expiresAt };
  }

  function cancel(username, transferId, now) {
    const m = readManifest(transferId);
    if (!m || m.username !== username) return { ok: false, code: 'NOT_FOUND', msg: '传输不存在。' };
    if (m.status === 'uploading') {
      auditOnce(m, 'cancelled', {});
      cleanup(transferId);
      return { ok: true, transferId, status: 'cancelled' };
    }
    return { ok: false, code: 'STATE', msg: '传输不在上传态。' };
  }

  // 过期未完成的上传：记一条 failed（stale）审计＋清理。
  function sweep(now) {
    const lim = limits();
    let swept = 0;
    let names = [];
    try { names = fs.readdirSync(chunkRoot); } catch (e) { return 0; }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const id = name.slice(0, -5);
      const m = readManifest(id);
      if (!m || m.status !== 'uploading') continue;
      if (now - m.updatedAt < lim.stageMs) continue;
      auditOnce(m, 'failed', { reason: 'stale' });
      cleanup(id);
      swept += 1;
    }
    return swept;
  }

  function listAudit(username, limit) {
    const out = [];
    try {
      const raw = fs.readFileSync(auditFile, 'utf8');
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try { const e = JSON.parse(line); if (e && e.username === username) out.push(e); } catch (ignored) {}
      }
    } catch (e) { if (e && e.code !== 'ENOENT') log({ ev: 'transfer-audit-read-error', err: String(e && e.message || e) }); }
    return out.slice(-(Math.max(1, Math.min(200, Number(limit) || 50))));
  }

  function countAudit(username, transferId) {
    return listAudit(username, 200).filter((e) => e.transferId === transferId).length;
  }

  return { init, putChunk, missingChunks, commit, cancel, sweep, listAudit, countAudit, auditFile };
}

// Range 解析（下载分片续传）：返回 { start, end }（闭区间）或 null。
function parseRange(rangeHeader, size) {
  if (typeof rangeHeader !== 'string') return null;
  const m = rangeHeader.match(/^bytes=(\d*)-(\d*)$/);
  if (!m) return null;
  let start = m[1] === '' ? null : Number(m[1]);
  let end = m[2] === '' ? null : Number(m[2]);
  if (start === null && end === null) return null;
  if (start === null) { // 后缀：最后 end 字节
    if (end <= 0) return null;
    start = Math.max(0, size - end);
    end = size - 1;
  } else {
    if (start >= size) return null;
    if (end === null || end >= size) end = size - 1;
    if (end < start) return null;
  }
  return { start, end };
}

module.exports = { createTransferCore, parseRange, DEFAULT_CHUNK_SIZE };
