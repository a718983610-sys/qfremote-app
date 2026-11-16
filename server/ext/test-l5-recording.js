'use strict';
// L5 RC-10 自检：录像指令/事件流＋三级粒度＋默认不录（QF-REC-1）。
// 运行：node server/ext/test-l5-recording.js（无外部依赖，退出码 0=通过）。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRecordingCore, recordingPolicy, estimateVideoBytes } = require('./recording-core');

let passed = 0, failed = 0;
function t(name, cond, extra) {
  if (cond) { passed++; console.log('ok  -', name); }
  else { failed++; console.log('FAIL-', name, extra || ''); }
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qf-l5-rec-'));
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} });
let cfg = {};
const logs = [];
const rec = createRecordingCore({ dir, log: (e) => logs.push(e), readConfig: () => cfg });
const now = Date.now();

// 1) 默认不录；三级粒度判定
{
  t('default-off', rec.policy().mode === 'off');
  t('off-refuses-start', rec.startSession({ sessionId: 's-off', username: 'alice', deviceId: 'd1' }, now).code === 'POLICY_OFF');
  cfg = { recording: { mode: 'user', users: ['alice'] } };
  t('user-mode-alice-on', rec.shouldRecord({ username: 'alice' }) === true);
  t('user-mode-bob-off', rec.shouldRecord({ username: 'bob' }) === false);
  cfg = { recording: { mode: 'group', groups: ['g1'] } };
  t('group-mode-hit', rec.shouldRecord({ username: 'alice', groupId: 'g1' }) === true);
  t('group-mode-miss', rec.shouldRecord({ username: 'alice', groupId: 'g2' }) === false);
  cfg = { recording: { mode: 'device', devices: ['d9'] } };
  t('device-mode-hit', rec.shouldRecord({ username: 'alice', deviceId: 'd9' }) === true);
  t('device-mode-miss', rec.shouldRecord({ username: 'alice', deviceId: 'd1' }) === false);
  t('bad-mode-falls-back-off', recordingPolicy({ recording: { mode: 'everyone' } }).mode === 'off');
}
// 2) 录制会话：事件写入＋剪贴板只记元数据＋非法事件拒绝
{
  cfg = { recording: { mode: 'user', users: ['alice'] } };
  const st = rec.startSession({ sessionId: 's1', username: 'alice', deviceId: 'd1', groupId: 'g1', tier: 'balanced' }, now);
  t('start-ok', st.ok === true && st.sessionId === 's1', JSON.stringify(st));
  const e1 = rec.appendEvent('s1', { type: 'input', at: now + 100, kind: 'mouse', x: 100, y: 200 }, now);
  t('input-append-ok', e1.ok === true);
  const e2 = rec.appendEvent('s1', { type: 'clipboard', at: now + 200, bytes: 42, content: 'SECRET-PASSWORD-123' }, now);
  t('clipboard-append-ok', e2.ok === true);
  const raw = fs.readFileSync(path.join(dir, 'recordings', 's1.qfrec'), 'utf8');
  t('clipboard-content-never-stored', !raw.includes('SECRET-PASSWORD-123') && raw.includes('"bytes":42'), raw);
  t('bad-event-rejected', rec.appendEvent('s1', { type: 'video-frame', at: now }, now).ok === false);
  t('unknown-session-rejected', rec.appendEvent('sX', { type: 'input', at: now }, now).ok === false);
  const end = rec.endSession('s1', now + 5000);
  t('end-ok-with-index', end.ok === true && end.events === 4, JSON.stringify(end)); // start+input+clipboard+end
}
// 3) 10 分钟录像体积比视频小一个量级（模拟：60 input/s＋关键帧锚点）
{
  cfg = { recording: { mode: 'user', users: ['alice'] } };
  const st = rec.startSession({ sessionId: 's10', username: 'alice', deviceId: 'd1', tier: 'balanced' }, now);
  t('start-10min-ok', st.ok === true);
  const durMs = 10 * 60 * 1000;
  const fps = 30;
  let at = now;
  let frames = 0;
  for (let ms = 0; ms < durMs; ms += 1000 / 60) { // 每秒 60 个输入事件
    rec.appendEvent('s10', { type: 'input', at: now + ms, kind: ms % 2 ? 'mouse' : 'key', x: 500, y: 300, key: 'a' }, now);
  }
  for (let f = 0; f < (durMs / 1000) * fps; f++) { // 每帧一个 frame-marker（关键帧每 30 帧）
    rec.appendEvent('s10', { type: 'frame-marker', at: now + f * (1000 / fps), frameId: f, isKeyframe: f % 30 === 0 }, now);
    frames++;
  }
  const end = rec.endSession('s10', now + durMs);
  const recBytes = end.bytes;
  const videoBytes = estimateVideoBytes(600, 2500); // balanced 档 2500kbps × 600s
  const ratio = videoBytes / recBytes;
  console.log(`    [10min] 录像事件流 ${recBytes} 字节（${end.events} 事件）vs 同等视频 ${videoBytes} 字节，比值 ${ratio.toFixed(1)}x`);
  t('10min-recording-order-smaller', ratio >= 10, `ratio=${ratio.toFixed(1)}x`);
  t('10min-frames-marked', frames === 18000, 'frames=' + frames);
  // seek 索引：每 10s 一个锚点，600s → 约 60 个
  const idx = rec.readIndex('s10');
  t('seek-index-count', idx && idx.index.length >= 55 && idx.index.length <= 65, 'index=' + (idx && idx.index.length));
  t('seek-index-monotonic', idx && idx.index.every((e, i) => i === 0 || (e.t > idx.index[i - 1].t && e.byteOffset > idx.index[i - 1].byteOffset)));
}
// 4) 访问控制：本人可读，他人 403，不存在 404（不泄露存在性由调用方统一 404）
{
  const own = rec.canAccess('alice', 's10');
  t('owner-can-access', own.ok === true && own.meta.username === 'alice');
  const other = rec.canAccess('bob', 's10');
  t('other-forbidden', other.ok === false && other.code === 'FORBIDDEN');
  const missing = rec.canAccess('alice', 's-nope');
  t('missing-not-found', missing.ok === false && missing.code === 'NOT_FOUND');
  const list = rec.listRecordings('alice');
  t('list-own-only', list.length === 2 && list.every((r) => r.sessionId === 's1' || r.sessionId === 's10'), JSON.stringify(list.map((r) => r.sessionId)));
  t('list-other-empty', rec.listRecordings('bob').length === 0);
}
// 5) 过期清理
{
  cfg = { recording: { mode: 'user', users: ['alice'], retentionDays: 1 } };
  const old = rec.startSession({ sessionId: 's-old', username: 'alice', deviceId: 'd1' }, now - 2 * 86400000);
  rec.endSession('s-old', now - 2 * 86400000 + 1000);
  const swept = rec.sweep(now);
  t('sweep-expired', swept === 1 && !fs.existsSync(path.join(dir, 'recordings', 's-old.qfrec')), 'swept=' + swept);
  t('sweep-keeps-fresh', fs.existsSync(path.join(dir, 'recordings', 's10.qfrec')));
}

// 6) 写路径按用户鉴权（2026-11-15 补；QF-REC-1 §6-1 缺口修复）
//    路由层 /event 与 /end 在调 appendEvent/endSession 之前先调 canAccess；
//    非本人与不存在同一 HTTP 404（路由把 !acc.ok 统一成 404 NOT_FOUND，
//    与 index/download 同口径，不泄露存在性）。沙箱无 MeshCentral 控制台
//    会话，路由 HTTP 本身无法直测，此处验三件事：(a) 守卫谓词——进行中
//    会话对他人 FORBIDDEN、对本人放行；(b) 他人“调 /end”被守卫挡下后
//    会话仍活着（本人仍可追加、仍可正常结束）；(c) 源码回归守卫——
//    server.js 里 /event 与 /end 处理块内确含 canAccess 且位于
//    appendEvent/endSession 之前，并带 404 NOT_FOUND 拒绝。真机 HTTP 验等 L7。
{
  cfg = { recording: { mode: 'user', users: ['alice'] } };
  const st = rec.startSession({ sessionId: 's-live', username: 'alice', deviceId: 'd1', groupId: 'g1', tier: 'balanced' }, now);
  t('live-start-ok', st.ok === true, JSON.stringify(st));
  const otherEv = rec.canAccess('bob', 's-live');
  t('live-other-event-forbidden', otherEv.ok === false && otherEv.code === 'FORBIDDEN', JSON.stringify(otherEv));
  const ownEv = rec.canAccess('alice', 's-live');
  t('live-owner-event-allowed', ownEv.ok === true, JSON.stringify(ownEv));
  const eOwn = rec.appendEvent('s-live', { type: 'input', at: now + 100, kind: 'mouse', x: 10, y: 20 }, now);
  t('live-owner-append-ok', eOwn.ok === true, JSON.stringify(eOwn));
  // 他人调 /end：守卫谓词 FORBIDDEN → 路由 404 且不调 endSession，会话仍活
  const otherEnd = rec.canAccess('bob', 's-live');
  t('live-other-end-forbidden', otherEnd.ok === false && otherEnd.code === 'FORBIDDEN', JSON.stringify(otherEnd));
  const stillAlive = rec.appendEvent('s-live', { type: 'input', at: now + 200, kind: 'mouse', x: 11, y: 21 }, now);
  t('live-session-survives-other-end', stillAlive.ok === true, JSON.stringify(stillAlive));
  // 本人正常结束
  const ownEnd = rec.canAccess('alice', 's-live');
  t('live-owner-end-allowed', ownEnd.ok === true, JSON.stringify(ownEnd));
  const end = rec.endSession('s-live', now + 5000);
  t('live-owner-end-ok', end.ok === true && end.events === 4, JSON.stringify(end)); // session-start + 2 input + session-end
  // 路由拒绝语义坍缩：FORBIDDEN 与 NOT_FOUND 在路由层同一 404（!acc.ok 即 404）
  const routeStatus = (acc) => (acc.ok ? 200 : 404);
  t('route-collapses-forbidden-and-missing', routeStatus(rec.canAccess('bob', 's-live')) === 404 && routeStatus(rec.canAccess('alice', 's-nope')) === 404);
  // 源码回归守卫：/event 与 /end 处理块内 canAccess 先于写操作，且带 404 NOT_FOUND
  const serverSrc = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  const evBlock = serverSrc.slice(serverSrc.indexOf('const recEventM'), serverSrc.indexOf('const recEndM'));
  const endBlock = serverSrc.slice(serverSrc.indexOf('const recEndM'), serverSrc.indexOf("if (req.method === 'GET' && p === '/license/api/recordings')"));
  const guard404 = "sendJson(res, 404, { ok: false, code: 'NOT_FOUND', msg: '录像不存在。' })";
  t('route-event-guard-in-source', evBlock.includes('canAccess(auth.user') && evBlock.indexOf('canAccess(auth.user') < evBlock.indexOf('appendEvent') && evBlock.includes(guard404), evBlock.slice(0, 200));
  t('route-end-guard-in-source', endBlock.includes('canAccess(auth.user') && endBlock.indexOf('canAccess(auth.user') < endBlock.indexOf('endSession') && endBlock.includes(guard404), endBlock.slice(0, 200));
}

console.log(`\nRC-10 recording: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
