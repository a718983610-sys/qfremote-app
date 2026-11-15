'use strict';
// L5 RC-08 自检：统一流抽象＋分片＋每次传输恰一条审计（QF-STREAM-1）。
// 运行：node server/ext/test-l5-transfer.js（无外部依赖，退出码 0=通过）。
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { createFilesCore } = require('./files-core');
const { createTransferCore, parseRange } = require('./transfer-core');

let passed = 0, failed = 0;
function t(name, cond, extra) {
  if (cond) { passed++; console.log('ok  -', name); }
  else { failed++; console.log('FAIL-', name, extra || ''); }
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qf-l5-transfer-'));
// /tmp 是 512MB tmpfs：退出时清掉本轮全部暂存（含 100MB 用例），不留垃圾占满。
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} });
const lic = { readConfig: () => ({ fileSendMaxMb: 200, fileSendStageHours: 24 }) };
const logs = [];
const fileStage = createFilesCore({ dir, lic, log: (e) => logs.push(e) });
const tc = createTransferCore({ dir, log: (e) => logs.push(e), stageBuffer: fileStage.stageBuffer, limits: fileStage.limits });
const now = Date.now();
function sha(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

// 1) init 校验
{
  const bad1 = tc.init('alice', { filename: 'a.bin', size: 100, sha256: sha(Buffer.from('x')) }, now);
  t('init-requires-toNode', bad1.ok === false && bad1.code === 'VALIDATION');
  const bad2 = tc.init('alice', { filename: 'a.bin', toNode: 'n1', size: 100, sha256: 'zzzz' }, now);
  t('init-requires-sha256', bad2.ok === false && bad2.code === 'VALIDATION');
  const bad3 = tc.init('alice', { filename: 'a.bin', toNode: 'n1', fromNode: 'n1', size: 100, sha256: sha(Buffer.from('x')) }, now);
  t('init-rejects-same-node', bad3.ok === false);
}
// 2) 分片上传（乱序）＋缺片查询＋commit＋收件箱可见
{
  const data = crypto.randomBytes(100 * 1024 + 123);
  const init = tc.init('alice', { filename: '乱序.bin', toNode: 'nodeB', fromNode: 'nodeA', size: data.length, sha256: sha(data), chunkSize: 64 * 1024 }, now);
  t('init-ok', init.ok === true && init.totalChunks === 2, JSON.stringify(init));
  const cs = init.chunkSize;
  // 乱序：1,0
  for (const i of [1, 0]) {
    const chunk = data.subarray(i * cs, Math.min(data.length, (i + 1) * cs));
    const r = tc.putChunk('alice', init.transferId, i, chunk, now + i);
    t('putChunk-' + i, r.ok === true && r.received === [1, 0].indexOf(i) + 1, JSON.stringify(r));
  }
  const miss = tc.missingChunks('alice', init.transferId);
  t('missing-empty-after-full', miss.ok === true && miss.missing.length === 0, JSON.stringify(miss));
  const c = tc.commit('alice', init.transferId, now + 1000);
  t('commit-ok', c.ok === true && c.stagedId, JSON.stringify(c));
  const inbox = fileStage.inbox('alice', 'nodeB', now + 1000);
  t('staged-visible-in-inbox', inbox.length === 1 && inbox[0].filename === '乱序.bin' && inbox[0].size === data.length, JSON.stringify(inbox.map((x) => x.filename)));
  t('audit-exactly-one-completed', tc.countAudit('alice', init.transferId) === 1, 'count=' + tc.countAudit('alice', init.transferId));
  const audit = tc.listAudit('alice', 10).find((e) => e.transferId === init.transferId);
  t('audit-completed-fields', audit && audit.result === 'completed' && audit.size === data.length && audit.toNode === 'nodeB' && !('content' in audit), JSON.stringify(audit));
  // 重复 commit 不产生第二条审计
  const c2 = tc.commit('alice', init.transferId, now + 2000);
  t('recommit-rejected', c2.ok === false);
  t('audit-still-one-after-recommit', tc.countAudit('alice', init.transferId) === 1);
}
// 3) 缺片 commit 拒绝；断点续传补齐后成功
{
  const data = crypto.randomBytes(200 * 1024);
  const init = tc.init('alice', { filename: 'resume.bin', toNode: 'nodeB', size: data.length, sha256: sha(data), chunkSize: 64 * 1024 }, now);
  t('resume-init-4-chunks', init.ok === true && init.totalChunks === 4, JSON.stringify(init));
  const cs = init.chunkSize;
  tc.putChunk('alice', init.transferId, 0, data.subarray(0, cs), now);
  tc.putChunk('alice', init.transferId, 2, data.subarray(2 * cs, 3 * cs), now);
  const miss = tc.missingChunks('alice', init.transferId);
  t('resume-missing-lists-gap', miss.missing.join(',') === '1,3', JSON.stringify(miss.missing));
  const c1 = tc.commit('alice', init.transferId, now);
  t('commit-incomplete-rejected', c1.ok === false && c1.code === 'INCOMPLETE');
  tc.putChunk('alice', init.transferId, 1, data.subarray(cs, 2 * cs), now);
  tc.putChunk('alice', init.transferId, 3, data.subarray(3 * cs), now);
  const c2 = tc.commit('alice', init.transferId, now + 100);
  t('resume-commit-ok', c2.ok === true, JSON.stringify(c2));
  t('audit-exactly-one-after-resume', tc.countAudit('alice', init.transferId) === 1);
}
// 4) SHA-256 校验失败 → 整单作废＋恰一条 failed 审计
{
  const data = crypto.randomBytes(10 * 1024);
  const init = tc.init('alice', { filename: 'bad.bin', toNode: 'nodeB', size: data.length, sha256: sha(Buffer.from('different-content')), chunkSize: 16 * 1024 }, now);
  tc.putChunk('alice', init.transferId, 0, data, now);
  const c = tc.commit('alice', init.transferId, now);
  t('commit-sha-mismatch', c.ok === false && c.code === 'CORRUPT', JSON.stringify(c));
  t('audit-exactly-one-failed', tc.countAudit('alice', init.transferId) === 1
    && tc.listAudit('alice', 50).find((e) => e.transferId === init.transferId).result === 'failed');
}
// 5) 取消 → 恰一条 cancelled 审计；他人看不到审计
{
  const data = crypto.randomBytes(1024);
  const init = tc.init('alice', { filename: 'cancel.bin', toNode: 'nodeB', size: data.length, sha256: sha(data), chunkSize: 16 * 1024 }, now);
  tc.putChunk('alice', init.transferId, 0, data, now);
  const r = tc.cancel('alice', init.transferId, now);
  t('cancel-ok', r.ok === true && r.status === 'cancelled', JSON.stringify(r));
  t('audit-exactly-one-cancelled', tc.countAudit('alice', init.transferId) === 1
    && tc.listAudit('alice', 50).find((e) => e.transferId === init.transferId).result === 'cancelled');
  t('audit-isolated-per-user', tc.listAudit('bob', 50).length === 0);
  t('putChunk-after-cancel-rejected', tc.putChunk('alice', init.transferId, 0, data, now).ok === false);
}
// 6) 分片越界/长度不符拒绝
{
  const data = crypto.randomBytes(1024);
  const init = tc.init('alice', { filename: 'edge.bin', toNode: 'nodeB', size: data.length, sha256: sha(data), chunkSize: 16 * 1024 }, now);
  t('putChunk-oob-rejected', tc.putChunk('alice', init.transferId, 5, data, now).ok === false);
  t('putChunk-wrong-len-rejected', tc.putChunk('alice', init.transferId, 0, Buffer.alloc(10), now).ok === false);
  tc.cancel('alice', init.transferId, now);
}
// 7) Range 解析
{
  t('range-normal', JSON.stringify(parseRange('bytes=0-99', 1000)) === JSON.stringify({ start: 0, end: 99 }));
  t('range-open-end', JSON.stringify(parseRange('bytes=900-', 1000)) === JSON.stringify({ start: 900, end: 999 }));
  t('range-suffix', JSON.stringify(parseRange('bytes=-200', 1000)) === JSON.stringify({ start: 800, end: 999 }));
  t('range-beyond-size', parseRange('bytes=1000-2000', 1000) === null);
  t('range-bad', parseRange('items=0-99', 1000) === null && parseRange(null, 1000) === null);
}
// 8) 100MB 端到端（1MB 分片 × 100）：分片上传＋拼装＋SHA-256＋暂存＋审计
{
  const size = 100 * 1024 * 1024;
  const data = crypto.randomBytes(size);
  const t0 = Date.now();
  const init = tc.init('alice', { filename: '100mb.bin', toNode: 'nodeB', fromNode: 'nodeA', size, sha256: sha(data), chunkSize: 1024 * 1024 }, now);
  t('100mb-init-100-chunks', init.ok === true && init.totalChunks === 100, JSON.stringify(init));
  let okPut = true;
  for (let i = 0; i < 100; i++) {
    const r = tc.putChunk('alice', init.transferId, i, data.subarray(i * 1024 * 1024, (i + 1) * 1024 * 1024), now + i);
    if (!r.ok) { okPut = false; break; }
  }
  t('100mb-100-chunks-put', okPut);
  const c = tc.commit('alice', init.transferId, now + 5000);
  t('100mb-commit-ok', c.ok === true && c.size === size, JSON.stringify(c));
  const got = fileStage.blobPathFor('alice', c.stagedId, now + 5000);
  const same = got && fs.readFileSync(got.fp).equals(data);
  if (got) got.release();
  t('100mb-staged-bytes-identical', same === true);
  t('100mb-audit-exactly-one', tc.countAudit('alice', init.transferId) === 1);
  console.log(`    [100mb] 端到端耗时 ${Date.now() - t0}ms（含 100MB 随机数生成＋分片＋拼装＋SHA-256）`);
}
// 9) 审计文件行数 == 完成传输数（全局 exactly-once 复核）
{
  const lines = fs.readFileSync(tc.auditFile, 'utf8').split('\n').filter((l) => l.trim()).length;
  const ids = new Set(fs.readFileSync(tc.auditFile, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l).transferId));
  t('audit-file-no-duplicate-ids', lines === ids.size, `lines=${lines} unique=${ids.size}`);
  console.log(`    [audit] 审计文件 ${lines} 行，${ids.size} 个唯一 transferId`);
}

console.log(`\nRC-08 transfer: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
