'use strict';
/*
 * RC-08 Windows 文件传输客户端测试（QF-STREAM-1 规范 v1，3.0.0）：
 *  A. SHA-256 与分片切分：已知向量、末片长度、服务端返回 chunkSize
 *     为准（请求 8MB 被钳制到 4MB 后按 4MB 切分）。
 *  B. init 校验：文件名/大小/SHA/toNode/fromNode==toNode 本地
 *     VALIDATION，不发请求。
 *  C. chunk 上传：分片长度不符本地拒绝、空分片拒绝、越界拒绝、乱序
 *     可达（先传 2 再传 0）、重复上传覆盖（已收计数不变）。
 *  D. 断点续传：missing 查缺片（没有字面 /resume 端点——全程断言
 *     无 /resume 请求）、中断后只补缺片、已收分片不重传。
 *  E. commit：INCOMPLETE 补传再 commit 成功；CORRUPT 整单作废、
 *     transferId 不能再用、重新 init 新单重传；commit 提交中禁点
 *     取消与重复提交。
 *  F. cancel：仅 uploading 态可取消；staged 后无取消端点。
 *  G. 下载：Range 206 续传拼装、非法 Range 回落 200 按全文件处理、
 *     stagedId（fs_…）不是 transferId（tf_…）、404 过期。
 *  H. inbox/sent/ack/audit：audit limit 钳制 1..200、默认 50。
 *  I. UI 状态机快照：进度、canCancel/canCommit/canResume、
 *     CORRUPT 文案“校验失败，须重新发送”、无“重试提交”。
 * 本测试用内存假服务端（按 transfer-core.js 同款规则实现），不发
 * 真实网络请求；100MB 端到端真机验等 L7。结果写 JSON 到 QFTEST_OUT，
 * 退出码 0=通过。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const transferMod = require('../qf-transfer');

const OUT = process.env.QFTEST_OUT || '/tmp/qfr-rc08-transfer/rc08-transfer-result.json';
const result = { cases: {}, pass: false };
const ok = (name, cond, extra) => { if (Object.prototype.hasOwnProperty.call(result.cases, name)) throw new Error('duplicate case name: ' + name); result.cases[name] = Object.assign({ pass: !!cond }, extra || {}); };

// 内存假服务端（按 transfer-core.js 规则：钳制、长度校验、拼装 SHA 校验）。
// opts.dropChunkIndex：该序号分片服务端假装收下（回 ok）实则丢弃，
// 用于复现“静默丢片 → 3 轮补传后仍 INCOMPLETE”的终态（F-WIN-04）。
function makeFakeServer(opts) {
  const dropChunkIndex = opts && Number.isInteger(opts.dropChunkIndex) ? opts.dropChunkIndex : -1;
  const transfers = new Map();
  const staged = new Map();
  let tfSeq = 0;
  let fsSeq = 0;
  const calls = [];
  const clamp = (v) => Math.max(64 * 1024, Math.min(4 * 1024 * 1024, v || 1024 * 1024));
  const handleJson = async (method, url, body) => {
    calls.push({ method, url, body });
    const u = new URL(url);
    const p = u.pathname;
    if (method === 'POST' && p === '/license/api/files/stream/init') {
      const chunkSize = clamp(Number(body.chunkSize));
      const id = 'tf_' + String(++tfSeq).padStart(16, '0');
      transfers.set(id, { filename: body.filename, size: body.size, sha256: body.sha256, chunkSize, totalChunks: Math.ceil(body.size / chunkSize), received: new Map(), status: 'uploading' });
      return { status: 200, json: { ok: true, transferId: id, chunkSize, totalChunks: Math.ceil(body.size / chunkSize) } };
    }
    const chunkM = p.match(/^\/license\/api\/files\/stream\/([^/]+)\/chunk$/);
    if (method === 'POST' && chunkM) {
      const t = transfers.get(chunkM[1]);
      if (!t || t.status !== 'uploading') return { status: 200, json: { ok: false, code: t ? 'STATE' : 'NOT_FOUND' } };
      const buf = Buffer.from(String(body.contentBase64 || ''), 'base64');
      const expectLen = body.index === t.totalChunks - 1 ? (t.size - body.index * t.chunkSize) : t.chunkSize;
      if (!buf.length || buf.length !== expectLen) return { status: 200, json: { ok: false, code: 'VALIDATION', msg: '分片长度不符（期望 ' + expectLen + ' 字节）。' } };
      if (body.index === dropChunkIndex) return { status: 200, json: { ok: true, received: t.received.size, totalChunks: t.totalChunks } };
      t.received.set(body.index, buf);
      return { status: 200, json: { ok: true, received: t.received.size, totalChunks: t.totalChunks } };
    }
    const missM = p.match(/^\/license\/api\/files\/stream\/([^/]+)\/missing$/);
    if (method === 'GET' && missM) {
      const t = transfers.get(missM[1]);
      if (!t) return { status: 200, json: { ok: false, code: 'NOT_FOUND' } };
      const missing = [];
      for (let i = 0; i < t.totalChunks; i++) if (!t.received.has(i)) missing.push(i);
      return { status: 200, json: { ok: true, transferId: missM[1], status: t.status, received: t.received.size, totalChunks: t.totalChunks, missing } };
    }
    const commitM = p.match(/^\/license\/api\/files\/stream\/([^/]+)\/commit$/);
    if (method === 'POST' && commitM) {
      const t = transfers.get(commitM[1]);
      if (!t) return { status: 200, json: { ok: false, code: 'NOT_FOUND' } };
      if (t.status !== 'uploading') return { status: 200, json: { ok: false, code: 'STATE' } };
      const missing = [];
      for (let i = 0; i < t.totalChunks; i++) if (!t.received.has(i)) missing.push(i);
      if (missing.length) return { status: 200, json: { ok: false, code: 'INCOMPLETE', msg: '分片未齐。', missing } };
      const buf = Buffer.concat(Array.from({ length: t.totalChunks }, (_, i) => t.received.get(i)));
      const hash = crypto.createHash('sha256').update(buf).digest('hex');
      if (buf.length !== t.size || hash !== t.sha256) {
        transfers.delete(commitM[1]);
        return { status: 200, json: { ok: false, code: 'CORRUPT', msg: 'SHA-256 校验失败，传输已作废。' } };
      }
      const stagedId = 'fs_' + String(++fsSeq).padStart(16, '0');
      staged.set(stagedId, { buf, filename: t.filename, expiresAt: Date.now() + 24 * 3600 * 1000 });
      transfers.delete(commitM[1]);
      return { status: 200, json: { ok: true, transferId: commitM[1], stagedId, size: t.size, expiresAt: Date.now() + 24 * 3600 * 1000 } };
    }
    const cancelM = p.match(/^\/license\/api\/files\/stream\/([^/]+)\/cancel$/);
    if (method === 'POST' && cancelM) {
      const t = transfers.get(cancelM[1]);
      if (!t) return { status: 200, json: { ok: false, code: 'NOT_FOUND' } };
      if (t.status !== 'uploading') return { status: 200, json: { ok: false, code: 'STATE' } };
      transfers.delete(cancelM[1]);
      return { status: 200, json: { ok: true, transferId: cancelM[1], status: 'cancelled' } };
    }
    if (method === 'GET' && p === '/license/api/files/audit') {
      return { status: 200, json: { ok: true, audit: [] } };
    }
    if (method === 'GET' && p === '/license/api/files/inbox') {
      return { status: 200, json: { ok: true, files: [{ id: 'fs_0000000000000001', filename: 'a.txt', size: 10, fromNode: 'n1', toNode: 'n2', status: 'staged', createdAt: 1, expiresAt: Date.now() + 3600000 }], limits: { maxBytes: 200 * 1024 * 1024, stageMs: 86400000 } } };
    }
    if (method === 'GET' && p === '/license/api/files/sent') {
      return { status: 200, json: { ok: true, files: [] } };
    }
    const ackM = p.match(/^\/license\/api\/files\/([^/]+)\/ack$/);
    if (method === 'POST' && ackM) {
      return { status: 200, json: { ok: true, id: ackM[1] } };
    }
    return { status: 404, json: { ok: false, code: 'NOT_FOUND' } };
  };
  const handleRaw = async (method, url, headers) => {
    calls.push({ method, url, headers, raw: true });
    const u = new URL(url);
    const dlM = u.pathname.match(/^\/license\/api\/files\/([^/]+)\/download$/);
    if (method === 'GET' && dlM) {
      const s = staged.get(dlM[1]);
      if (!s) return { status: 404, headers: {}, body: Buffer.alloc(0) };
      const range = headers && headers.Range;
      if (typeof range === 'string') {
        const m = range.match(/^bytes=(\d*)-(\d*)$/);
        if (m) {
          let start = m[1] === '' ? null : Number(m[1]);
          let end = m[2] === '' ? null : Number(m[2]);
          let okRange = true;
          if (start === null && end === null) okRange = false;
          else if (start === null) { if (end <= 0) okRange = false; else { start = Math.max(0, s.buf.length - end); end = s.buf.length - 1; } }
          else { if (start >= s.buf.length) okRange = false; else { if (end === null || end >= s.buf.length) end = s.buf.length - 1; if (end < start) okRange = false; } }
          if (okRange) {
            const slice = s.buf.subarray(start, end + 1);
            return { status: 206, headers: { 'content-range': 'bytes ' + start + '-' + end + '/' + s.buf.length, 'content-length': String(slice.length) }, body: Buffer.from(slice) };
          }
        }
      }
      return { status: 200, headers: { 'content-length': String(s.buf.length) }, body: Buffer.from(s.buf) };
    }
    return { status: 404, headers: {}, body: Buffer.alloc(0) };
  };
  return { handleJson, handleRaw, calls, transfers, staged };
}

function makeClient(srv) {
  return transferMod.createFileTransferClient({
    request: srv.handleJson,
    requestRaw: srv.handleRaw,
    baseUrl: 'https://app.qfremote.top',
    log: () => {}
  });
}
function makeBuffer(size, seed) {
  const b = Buffer.alloc(size);
  for (let i = 0; i < size; i++) b[i] = (seed + i) & 0xff;
  return b;
}

(async () => {
  // ---------- A. SHA-256 与分片 ----------
  ok('A1_sha256-known-vector', transferMod.sha256Hex(Buffer.from('abc')) === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  ok('A2_totalChunks', transferMod.totalChunksFor(2500000, 1048576) === 3 && transferMod.totalChunksFor(1048576, 1048576) === 1);
  ok('A3_expectedChunkLength', transferMod.expectedChunkLength(2, 3, 2500000, 1048576) === 2500000 - 2 * 1048576 && transferMod.expectedChunkLength(0, 3, 2500000, 1048576) === 1048576);
  {
    const srv = makeFakeServer();
    const client = makeClient(srv);
    const buf = makeBuffer(9 * 1024 * 1024, 1);
    const r = await client.startUpload({ filename: 'big.bin', size: buf.length, sha256: transferMod.sha256Hex(buf), chunkSize: 8 * 1024 * 1024, toNode: 'nodeB' });
    ok('A4_server-chunkSize-wins', r.ok === true && r.chunkSize === 4 * 1024 * 1024 && r.totalChunks === 3);
    const up = await client.uploadBuffer(buf);
    ok('A5_upload-by-returned-chunkSize', up.ok === true && up.received === 3);
  }

  // ---------- B. init 本地校验 ----------
  {
    const srv = makeFakeServer();
    const client = makeClient(srv);
    const buf = makeBuffer(100, 2);
    const sha = transferMod.sha256Hex(buf);
    const before = srv.calls.length;
    ok('B1_no-filename', (await client.startUpload({ filename: '', size: 100, sha256: sha, toNode: 'n2' })).code === 'VALIDATION');
    ok('B2_bad-size', (await client.startUpload({ filename: 'a', size: 0, sha256: sha, toNode: 'n2' })).code === 'VALIDATION');
    ok('B3_bad-sha', (await client.startUpload({ filename: 'a', size: 100, sha256: 'xyz', toNode: 'n2' })).code === 'VALIDATION');
    ok('B4_no-toNode', (await client.startUpload({ filename: 'a', size: 100, sha256: sha, toNode: '' })).code === 'VALIDATION');
    ok('B5_same-node', (await client.startUpload({ filename: 'a', size: 100, sha256: sha, toNode: 'n1', fromNode: 'n1' })).code === 'VALIDATION');
    ok('B6_no-request-on-validation', srv.calls.length === before);
  }

  // ---------- C. chunk 上传 ----------
  {
    const srv = makeFakeServer();
    const client = makeClient(srv);
    const buf = makeBuffer(2500000, 3);
    await client.startUpload({ filename: 'f.bin', size: buf.length, sha256: transferMod.sha256Hex(buf), toNode: 'nodeB' });
    const rBadLen = await client.uploadChunk(0, Buffer.alloc(10));
    ok('C1_wrong-length_local-validation', rBadLen.ok === false && rBadLen.code === 'VALIDATION' && rBadLen.expectedLength === 1048576);
    const rEmpty = await client.uploadChunk(0, Buffer.alloc(0));
    ok('C2_empty-chunk', rEmpty.ok === false && rEmpty.code === 'VALIDATION');
    const rOob = await client.uploadChunk(3, Buffer.alloc(10));
    ok('C3_index-out-of-range', rOob.ok === false && rOob.code === 'VALIDATION');
    // 乱序：先传 2 再传 0；重复传 0 覆盖，已收计数不变。
    const r2 = await client.uploadChunk(2, buf.subarray(2 * 1048576));
    const r0 = await client.uploadChunk(0, buf.subarray(0, 1048576));
    const r0dup = await client.uploadChunk(0, buf.subarray(0, 1048576));
    ok('C4_out-of-order_ok', r2.ok === true && r0.ok === true && r0dup.ok === true && r0dup.received === 2);
  }

  // ---------- D. 断点续传 ----------
  {
    const srv = makeFakeServer();
    const client = makeClient(srv);
    const buf = makeBuffer(2500000, 4);
    const init = await client.startUpload({ filename: 'f.bin', size: buf.length, sha256: transferMod.sha256Hex(buf), toNode: 'nodeB' });
    await client.uploadChunk(0, buf.subarray(0, 1048576));
    await client.uploadChunk(2, buf.subarray(2 * 1048576));
    const q = await client.queryMissing();
    ok('D1_missing_lists-gap', q.ok === true && JSON.stringify(q.missing) === '[1]' && q.received === 2);
    // 模拟断网中断后 resume：只补缺片 1，不重传 0/2。
    const chunkCallsBefore = srv.calls.filter((c) => c.url.indexOf('/chunk') >= 0).length;
    const resumed = await client.resumeUpload(buf);
    const chunkCallsAfter = srv.calls.filter((c) => c.url.indexOf('/chunk') >= 0).length;
    ok('D2_resume_only-missing', resumed.ok === true && chunkCallsAfter - chunkCallsBefore === 1);
    const done = await client.commit();
    ok('D3_commit-after-resume', done.ok === true && done.stagedId.indexOf('fs_') === 0);
    ok('D4_no-resume-endpoint', srv.calls.every((c) => c.url.indexOf('/resume') < 0));
    ok('D5_transferId-format', init.transferId.indexOf('tf_') === 0);
  }

  // ---------- E. commit ----------
  {
    // INCOMPLETE → 补传 → 成功（completeUpload 一站式）。
    const srv = makeFakeServer();
    const client = makeClient(srv);
    const buf = makeBuffer(2500000, 5);
    await client.startUpload({ filename: 'f.bin', size: buf.length, sha256: transferMod.sha256Hex(buf), toNode: 'nodeB' });
    await client.uploadChunk(0, buf.subarray(0, 1048576));
    const c1 = await client.commit();
    ok('E1_incomplete', c1.ok === false && c1.code === 'INCOMPLETE' && JSON.stringify(c1.missing) === '[1,2]');
    const ui1 = client.getUiState();
    ok('E2_incomplete_stays-uploading', ui1.state === 'uploading' && ui1.canResume === false && ui1.canCommit === true);
    const done = await client.completeUpload(buf);
    ok('E3_completeUpload_recovers', done.ok === true && done.stagedId.indexOf('fs_') === 0);
    const c2 = await client.commit();
    ok('E4_double-commit_blocked', c2.ok === false && c2.kind === 'already-committed');
  }
  {
    // CORRUPT：整单作废，旧 transferId 不能再用，重新 init 新单。
    const srv = makeFakeServer();
    const client = makeClient(srv);
    const buf = makeBuffer(1500000, 6);
    const init = await client.startUpload({ filename: 'f.bin', size: buf.length, sha256: transferMod.sha256Hex(buf), toNode: 'nodeB' });
    const tampered = Buffer.from(buf);
    tampered[10] ^= 0xff;
    await client.uploadChunk(0, tampered.subarray(0, 1048576));
    await client.uploadChunk(1, tampered.subarray(1048576));
    const c = await client.commit();
    ok('E5_corrupt_terminal', c.ok === false && c.code === 'CORRUPT' && c.needReinit === true);
    const ui = client.getUiState();
    ok('E6_corrupt_ui', ui.state === 'failed' && ui.message === '校验失败，须重新发送' && ui.canReupload === true && ui.canRetryCommit === false);
    const cAgain = await client.commit();
    ok('E7_corrupt-no-recommit', cAgain.ok === false && cAgain.kind === 'state');
    const init2 = await client.startUpload({ filename: 'f.bin', size: buf.length, sha256: transferMod.sha256Hex(buf), toNode: 'nodeB' });
    ok('E8_reinit-new-transferId', init2.ok === true && init2.transferId !== init.transferId);
    const done = await client.completeUpload(buf);
    ok('E9_reupload-succeeds', done.ok === true);
  }
  {
    // F-WIN-04：服务端静默丢片 → 3 轮补传后仍 INCOMPLETE，终态 missing
    // 必须是服务端最后一次报告的缺失序号数组，不得是本地已收“个数”。
    const srv = makeFakeServer({ dropChunkIndex: 1 });
    const client = makeClient(srv);
    const buf = makeBuffer(2500000, 7);
    await client.startUpload({ filename: 'f.bin', size: buf.length, sha256: transferMod.sha256Hex(buf), toNode: 'nodeB' });
    const done = await client.completeUpload(buf);
    ok('E10_terminal-incomplete_missing-is-array', done.ok === false && done.code === 'INCOMPLETE' && Array.isArray(done.missing) && JSON.stringify(done.missing) === '[1]');
  }
  {
    // commit 提交中：cancel 与重复 commit 都被禁。
    const srv = makeFakeServer();
    let commitCalls = 0;
    const delayedRequest = async (method, url, body) => {
      if (url.indexOf('/commit') >= 0) {
        commitCalls += 1;
        await new Promise((r) => setTimeout(r, 50));
      }
      return srv.handleJson(method, url, body);
    };
    const client = transferMod.createFileTransferClient({ request: delayedRequest, requestRaw: srv.handleRaw, baseUrl: 'https://app.qfremote.top', log: () => {} });
    const buf = makeBuffer(100, 7);
    await client.startUpload({ filename: 's.bin', size: buf.length, sha256: transferMod.sha256Hex(buf), toNode: 'nodeB' });
    await client.uploadBuffer(buf);
    const p = client.commit();
    const cancelDuring = await client.cancel();
    const commitDuring = await client.commit();
    const done = await p;
    ok('E11_commit-busy_blocks-cancel-and-recommit', cancelDuring.ok === false && cancelDuring.kind === 'busy' && commitDuring.ok === false && commitDuring.kind === 'busy' && done.ok === true && commitCalls === 1);
  }

  // ---------- F. cancel ----------
  {
    const srv = makeFakeServer();
    const client = makeClient(srv);
    const buf = makeBuffer(2500000, 8);
    await client.startUpload({ filename: 'f.bin', size: buf.length, sha256: transferMod.sha256Hex(buf), toNode: 'nodeB' });
    await client.uploadChunk(0, buf.subarray(0, 1048576));
    const c = await client.cancel();
    ok('F1_cancel-uploading', c.ok === true && c.status === 'cancelled' && client.getUiState().state === 'cancelled');
    const c2 = await client.cancel();
    ok('F2_cancel-terminal_noop', c2.ok === false);
  }
  {
    const srv = makeFakeServer();
    const client = makeClient(srv);
    const buf = makeBuffer(100, 9);
    await client.startUpload({ filename: 's.bin', size: buf.length, sha256: transferMod.sha256Hex(buf), toNode: 'nodeB' });
    await client.completeUpload(buf);
    const c = await client.cancel();
    ok('F3_cancel-after-staged_refused', c.ok === false && c.kind === 'state');
  }

  // ---------- G. 下载 ----------
  {
    const srv = makeFakeServer();
    const client = makeClient(srv);
    const buf = makeBuffer(3000000, 10);
    await client.startUpload({ filename: 'f.bin', size: buf.length, sha256: transferMod.sha256Hex(buf), toNode: 'nodeB' });
    const done = await client.completeUpload(buf);
    const stagedId = done.stagedId;
    // 整文件下载。
    const full = await client.downloadResumable(stagedId, null);
    ok('G1_download-full', full.ok === true && full.body.equals(buf) && full.fromRange === false && full.complete === true);
    // Range 续传：已有前 1MB，补后 2MB。
    const prefix = buf.subarray(0, 1048576);
    const resumed = await client.downloadResumable(stagedId, Buffer.from(prefix));
    ok('G2_download-range-resume', resumed.ok === true && resumed.fromRange === true && resumed.body.equals(buf) && resumed.complete === true);
    // 非法 Range（start >= size）→ 服务端回落 200 全文件，客户端按全文件处理。
    const bad = await client.downloadResumable(stagedId, Buffer.alloc(99999999, 0));
    ok('G3_bad-range_falls-back-to-full', bad.ok === true && bad.fromRange === false && bad.fullFileFallback === true && bad.body.equals(buf));
    // 不存在/过期 → 404。
    const missing = await client.downloadResumable('fs_9999999999999999', null);
    ok('G4_download-404', missing.ok === false && missing.code === 'NOT_FOUND');
    // 下载用 stagedId：请求 URL 含 fs_ id、不含 tf_ id（G4 的 404 用了
    // 另一个 fs_ id，故只断言全部含 fs_、全不含 /tf_）。
    const dlCalls = srv.calls.filter((c) => c.raw);
    ok('G5_download-uses-stagedId', dlCalls.length > 0 && dlCalls.every((c) => c.url.indexOf('fs_') >= 0 && c.url.indexOf('/tf_') < 0));
  }

  // ---------- H. inbox/sent/ack/audit ----------
  {
    const srv = makeFakeServer();
    const client = makeClient(srv);
    const inbox = await client.listInbox('nodeB');
    ok('H1_inbox', inbox.ok === true && inbox.files.length === 1 && inbox.files[0].id === 'fs_0000000000000001');
    ok('H2_file-not-expired', transferMod.createFileTransferClient && client.isFileExpired(inbox.files[0]) === false);
    ok('H3_file-expired', client.isFileExpired({ expiresAt: Date.now() - 1000 }) === true);
    const sent = await client.listSent();
    ok('H4_sent', sent.ok === true && Array.isArray(sent.files));
    const ack = await client.ackFile('fs_0000000000000001');
    ok('H5_ack', ack.ok === true);
    await client.listAudit(500);
    await client.listAudit(0);
    const auditCalls = srv.calls.filter((c) => c.url.indexOf('/audit') >= 0);
    ok('H6_audit-limit-clamped', auditCalls[0].url.indexOf('limit=200') >= 0 && auditCalls[1].url.indexOf('limit=50') >= 0);
  }

  // ---------- I. UI 状态机快照 ----------
  {
    const srv = makeFakeServer();
    const client = makeClient(srv);
    const buf = makeBuffer(2500000, 11);
    const ui0 = client.getUiState();
    ok('I1_idle-ui', ui0.state === 'idle' && ui0.canCancel === false && ui0.canCommit === false);
    await client.startUpload({ filename: 'f.bin', size: buf.length, sha256: transferMod.sha256Hex(buf), toNode: 'nodeB' });
    await client.uploadChunk(0, buf.subarray(0, 1048576));
    const ui1 = client.getUiState();
    ok('I2_uploading-ui', ui1.state === 'uploading' && ui1.received === 1 && ui1.totalChunks === 3 && ui1.bytesSent === 1048576 && ui1.percent === 33 && ui1.canCancel === true && ui1.canCommit === true);
    // 网络中断 → interrupted，可续传。
    const srv2 = makeFakeServer();
    let failOnce = true;
    const flaky = async (method, url, body) => {
      if (failOnce && url.indexOf('/chunk') >= 0) { failOnce = false; throw new Error('net down'); }
      return srv2.handleJson(method, url, body);
    };
    const client2 = transferMod.createFileTransferClient({ request: flaky, requestRaw: srv2.handleRaw, baseUrl: 'https://app.qfremote.top', log: () => {} });
    await client2.startUpload({ filename: 'f.bin', size: buf.length, sha256: transferMod.sha256Hex(buf), toNode: 'nodeB' });
    const rNet = await client2.uploadChunk(0, buf.subarray(0, 1048576));
    const ui2 = client2.getUiState();
    ok('I3_interrupted-ui', rNet.kind === 'network' && ui2.state === 'interrupted' && ui2.canResume === true && ui2.message === '连接中断，可断点续传');
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
