'use strict';
/*
 * RC-10 Windows 录像事件流客户端测试（QF-REC-1 规范 v1，3.0.0）：
 *  A. 事件白名单清洗：clipboard 只记 bytes（content 丢弃）、key 截断
 *     32 字符、kind 非法值按 mouse 计、非法事件类型拒绝。
 *  B. start：POLICY_OFF 时不录制、不发事件；策略命中时开始；不传
 *     sessionId 时服务端生成 rec_ id。
 *  C. reportEvent：客户端只发四种事件（session-start/session-end/
 *     seek-index 本地拒绝、不发请求）；at 单调递增、倒序事件本地丢弃；
 *     剪贴板内容永不外发。
 *  D. end：结束返回索引；结束后不再上报。
 *  E. 服务端重启中断：内存会话丢失 → /event NOT_FOUND → 提示中断、
 *     不静默丢事件；重开新录制（新 sessionId，不复用旧 id）。
 *  F. list/index/download：本人列表、他人录像 index/download 同一
 *     404（不泄露存在性、不反复重试）；下载不支持 Range（永不发
 *     Range 请求）。
 *  G. 回放器纯函数：parseQfrec 半行不播、seekAnchor 取 t≤T 最后锚点、
 *     变速缩放。
 *  H. UI 状态快照：policy-off / interrupted 文案、隐私提示。
 * 本测试的假服务端直接用服务端 recording-core.js 原模块（同一存储、
 * 索引、访问控制逻辑），“重启”用同目录新实例模拟内存丢失。结果写
 * JSON 到 QFTEST_OUT，退出码 0=通过。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const recordingMod = require('../qf-recording');
const serverRecording = require('../../server/ext/recording-core');

const OUT = process.env.QFTEST_OUT || '/tmp/qfr-rc10-recording/rc10-recording-result.json';
const result = { cases: {}, pass: false };
const ok = (name, cond, extra) => { result.cases[name] = Object.assign({ pass: !!cond }, extra || {}); };

function makeCore(dir, mode, users) {
  return serverRecording.createRecordingCore({
    dir,
    log: () => {},
    readConfig: () => ({ recording: { mode, users: users || [], groups: [], devices: [], retentionDays: 30 } })
  });
}

// 假服务端：按 server.js recordings 路由同款顺序（先 canAccess 再读写）。
function makeFakeServer(core) {
  const calls = [];
  const rawCalls = [];
  const request = async (method, url, body) => {
    calls.push({ method, url, body });
    const u = new URL(url);
    const p = u.pathname;
    if (method === 'POST' && p === '/license/api/recordings/start') {
      return { status: 200, json: core.startSession({ sessionId: body.sessionId, username: 'alice', deviceId: body.deviceId, groupId: body.groupId, tier: body.tier }, Date.now()) };
    }
    const evM = p.match(/^\/license\/api\/recordings\/([^/]+)\/event$/);
    if (method === 'POST' && evM) {
      const id = decodeURIComponent(evM[1]);
      const acc = core.canAccess('alice', id);
      if (!acc.ok) return { status: 404, json: { ok: false, code: 'NOT_FOUND', msg: '录像不存在。' } };
      return { status: 200, json: core.appendEvent(id, (body && body.event) || {}, Date.now()) };
    }
    const endM = p.match(/^\/license\/api\/recordings\/([^/]+)\/end$/);
    if (method === 'POST' && endM) {
      const id = decodeURIComponent(endM[1]);
      const acc = core.canAccess('alice', id);
      if (!acc.ok) return { status: 404, json: { ok: false, code: 'NOT_FOUND', msg: '录像不存在。' } };
      return { status: 200, json: core.endSession(id, Date.now()) };
    }
    if (method === 'GET' && p === '/license/api/recordings') {
      return { status: 200, json: { ok: true, recordings: core.listRecordings('alice') } };
    }
    const idxM = p.match(/^\/license\/api\/recordings\/([^/]+)\/index$/);
    if (method === 'GET' && idxM) {
      const id = decodeURIComponent(idxM[1]);
      const acc = core.canAccess('alice', id);
      if (!acc.ok) return { status: 404, json: { ok: false, code: 'NOT_FOUND', msg: '录像不存在。' } };
      return { status: 200, json: { ok: true, index: core.readIndex(id) } };
    }
    return { status: 404, json: { ok: false, code: 'NOT_FOUND' } };
  };
  const requestRaw = async (method, url, headers) => {
    rawCalls.push({ method, url, headers });
    const u = new URL(url);
    const dlM = u.pathname.match(/^\/license\/api\/recordings\/([^/]+)\/download$/);
    if (method === 'GET' && dlM) {
      const id = decodeURIComponent(dlM[1]);
      const acc = core.canAccess('alice', id);
      if (!acc.ok) return { status: 404, headers: {}, body: Buffer.alloc(0) };
      const fp = core.filePath(id);
      if (!fs.existsSync(fp)) return { status: 404, headers: {}, body: Buffer.alloc(0) };
      return { status: 200, headers: { 'content-length': String(fs.statSync(fp).size) }, body: fs.readFileSync(fp) };
    }
    return { status: 404, headers: {}, body: Buffer.alloc(0) };
  };
  return { request, requestRaw, calls, rawCalls };
}

function makeClient(srv) {
  return recordingMod.createRecordingClient({
    request: srv.request, requestRaw: srv.requestRaw,
    baseUrl: 'https://app.qfremote.top', log: () => {}
  });
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qfr-rc10-'));
  try {
    // ---------- A. 事件白名单清洗 ----------
    {
      const clip = recordingMod.sanitizeEvent({ type: 'clipboard', at: 1790000000100, bytes: 128, content: 'SECRET-password-123' });
      ok('A1_clipboard_content-dropped', clip && clip.bytes === 128 && !('content' in clip) && JSON.stringify(clip).indexOf('SECRET') < 0);
      const key = recordingMod.sanitizeEvent({ type: 'input', at: 1, kind: 'key', x: 10, y: 20, key: 'a'.repeat(64) });
      ok('A2_key-truncated-32', key && key.key.length === 32);
      const badKind = recordingMod.sanitizeEvent({ type: 'input', at: 1, kind: 'swipe', x: 1, y: 2 });
      ok('A3_bad-kind-falls-back-mouse', badKind && badKind.kind === 'mouse');
      const fm = recordingMod.sanitizeEvent({ type: 'frame-marker', at: 1, frameId: 42, isKeyframe: true });
      ok('A4_frame-marker', fm && fm.frameId === 42 && fm.isKeyframe === true);
      const qc = recordingMod.sanitizeEvent({ type: 'quality-change', at: 1, from: 'clear', to: 'balanced' });
      ok('A5_quality-change', qc && qc.from === 'clear' && qc.to === 'balanced');
      ok('A6_illegal-type_null', recordingMod.sanitizeEvent({ type: 'video-frame', at: 1 }) === null);
      ok('A7_missing-coords_default-0', (() => { const e = recordingMod.sanitizeEvent({ type: 'input', at: 1, kind: 'mouse' }); return e && e.x === 0 && e.y === 0; })());
      ok('A8_seek-index-not-client-event', recordingMod.CLIENT_EVENT_TYPES.indexOf('seek-index') < 0 && recordingMod.CLIENT_EVENT_TYPES.length === 4);
    }

    // ---------- B. start ----------
    const coreOff = makeCore(dir, 'off', []);
    const srvOff = makeFakeServer(coreOff);
    const clientOff = makeClient(srvOff);
    {
      const r = await clientOff.start({ sessionId: 'sess-0123456789abcdef', deviceId: 'd1', groupId: 'g1', tier: 'balanced' });
      ok('B1_policy-off', r.ok === false && r.code === 'POLICY_OFF' && r.message === '当前会话不录制');
      const ui = clientOff.getUiState();
      ok('B2_policy-off_ui', ui.state === 'policy-off' && ui.message === '当前会话不录制' && ui.canReport === false);
      const ev = await clientOff.reportEvent({ type: 'input', at: 1790000000100, kind: 'mouse', x: 1, y: 2 });
      ok('B3_policy-off_no-events', ev.ok === false && ev.kind === 'policy-off' && srvOff.calls.filter((c) => c.url.indexOf('/event') >= 0).length === 0);
    }

    const core = makeCore(dir, 'user', ['alice']);
    const srv = makeFakeServer(core);
    const client = makeClient(srv);
    let recId = '';
    {
      const r = await client.start({ sessionId: 'sess-0123456789abcdef', deviceId: 'd1', groupId: 'g1', tier: 'balanced' });
      ok('B4_start-ok', r.ok === true && r.sessionId === 'sess-0123456789abcdef');
      recId = r.sessionId;
      ok('B5_recording-ui', client.getUiState().state === 'recording' && client.getUiState().canReport === true);
      // 不传 sessionId：服务端生成 rec_ id。
      const client2 = makeClient(srv);
      const r2 = await client2.start({ deviceId: 'd1', groupId: 'g1', tier: 'balanced' });
      ok('B6_server-generates-rec-id', r2.ok === true && r2.sessionId.indexOf('rec_') === 0);
      await client2.end();
    }

    // ---------- C. reportEvent ----------
    {
      const before = srv.calls.length;
      const bad1 = await client.reportEvent({ type: 'session-start', at: 1790000000100, tier: 'balanced' });
      const bad2 = await client.reportEvent({ type: 'session-end', at: 1790000000100 });
      const bad3 = await client.reportEvent({ type: 'seek-index', at: 1790000000100 });
      ok('C1_server-events_client-forbidden', bad1.kind === 'client-forbidden' && bad2.kind === 'client-forbidden' && bad3.kind === 'client-forbidden' && srv.calls.length === before);
      const e1 = await client.reportEvent({ type: 'input', at: 1790000000100, kind: 'mouse', x: 100, y: 200 });
      const e2 = await client.reportEvent({ type: 'clipboard', at: 1790000000200, bytes: 64, content: 'SECRET-should-never-leave' });
      const e3 = await client.reportEvent({ type: 'frame-marker', at: 1790000000300, frameId: 7, isKeyframe: true });
      const e4 = await client.reportEvent({ type: 'quality-change', at: 1790000000400, from: 'clear', to: 'balanced' });
      ok('C2_four-events_ok', e1.ok === true && e2.ok === true && e3.ok === true && e4.ok === true && e4.events === 5);
      const clipCall = srv.calls.filter((c) => c.url.indexOf('/event') >= 0).find((c) => c.body && c.body.event && c.body.event.type === 'clipboard');
      ok('C3_clipboard-content-never-sent', !!clipCall && !('content' in clipCall.body.event) && JSON.stringify(srv.calls).indexOf('SECRET-should-never-leave') < 0);
      // 倒序事件本地丢弃、不发请求。
      const callsBefore = srv.calls.length;
      const old = await client.reportEvent({ type: 'input', at: 1790000000050, kind: 'mouse', x: 1, y: 1 });
      ok('C4_out-of-order_dropped-locally', old.ok === false && old.kind === 'out-of-order' && old.dropped === true && srv.calls.length === callsBefore);
      // 同一 at 允许（单调不减）。
      const same = await client.reportEvent({ type: 'input', at: 1790000000400, kind: 'mouse', x: 5, y: 5 });
      ok('C5_same-at_allowed', same.ok === true);
    }

    // ---------- D. end ----------
    {
      const r = await client.end();
      ok('D1_end-ok', r.ok === true && r.sessionId === recId && r.events === 7 && Array.isArray(r.index));
      ok('D2_ended-ui', client.getUiState().state === 'ended' && client.getUiState().canRestart === true);
      const again = await client.end();
      ok('D3_end-twice_blocked', again.ok === false && again.kind === 'already-ended');
      const ev = await client.reportEvent({ type: 'input', at: 1790000000500, kind: 'mouse', x: 1, y: 1 });
      ok('D4_report-after-end_blocked', ev.ok === false && ev.kind === 'not-recording');
    }

    // ---------- E. 服务端重启中断 ----------
    {
      // 路由层：重启后（同目录新 core 实例，内存 sessions 为空，磁盘
      // .qfrec 还在）拿旧 sessionId 发事件 → NOT_FOUND。
      const client3 = makeClient(srv);
      const started = await client3.start({ sessionId: 'sess-eeeeeeeeeeeeeeee', deviceId: 'd1', groupId: 'g1', tier: 'balanced' });
      ok('E0_restart-test-start', started.ok === true);
      await client3.reportEvent({ type: 'input', at: 1790000000100, kind: 'mouse', x: 1, y: 1 });
      const core2 = makeCore(dir, 'user', ['alice']);
      const srv2 = makeFakeServer(core2);
      const raw = await srv2.request('POST', 'https://app.qfremote.top/license/api/recordings/sess-eeeeeeeeeeeeeeee/event', { event: { type: 'input', at: 1790000000200, kind: 'mouse', x: 2, y: 2 } });
      ok('E1_restart_event-not-found', raw.status === 200 && raw.json && raw.json.code === 'NOT_FOUND');
      // 客户端分支：start 成功、随后 /event 回 NOT_FOUND → interrupted＋提示。
      const clientI = recordingMod.createRecordingClient({
        request: async (method, url, body) => {
          if (url.indexOf('/start') >= 0) return srv.request(method, url, body);
          return { status: 404, json: { ok: false, code: 'NOT_FOUND', msg: '录像不存在。' } };
        },
        requestRaw: srv.requestRaw, baseUrl: 'https://app.qfremote.top', log: () => {}
      });
      const si = await clientI.start({ sessionId: 'sess-3333333333333333', deviceId: 'd1', groupId: 'g1', tier: 'balanced' });
      ok('E2_interrupted-setup', si.ok === true);
      const evI = await clientI.reportEvent({ type: 'input', at: 1790000000100, kind: 'mouse', x: 1, y: 1 });
      ok('E3_interrupted_message', evI.ok === false && evI.kind === 'interrupted' && evI.message === recordingMod.INTERRUPTED_MESSAGE);
      const uiI = clientI.getUiState();
      ok('E4_interrupted_ui', uiI.state === 'interrupted' && uiI.message === recordingMod.INTERRUPTED_MESSAGE && uiI.canRestart === true);
      const re = await clientI.restartAfterInterrupt({ deviceId: 'd1', groupId: 'g1', tier: 'balanced' });
      ok('E5_restart-new-sessionId', re.ok === true && re.sessionId.indexOf('rec_') === 0 && re.sessionId !== 'sess-3333333333333333' && clientI.getState() === 'recording');
      await clientI.end();
    }

    // ---------- F. list/index/download ----------
    {
      const list = await client.list();
      ok('F1_list-own-only', list.ok === true && list.recordings.length >= 1 && list.recordings.every((r) => r.sessionId));
      // 他人录像：经另一个 core 实例（users 含 bob）以 bob 身份建一个。
      const coreBob = makeCore(dir, 'user', ['bob']);
      const bobStart = coreBob.startSession({ sessionId: 'sess-bobbbbbbbbbbbbbb', username: 'bob', deviceId: 'd9', groupId: 'g9', tier: 'balanced' }, Date.now());
      ok('F2_bob-recording-created', bobStart.ok === true);
      const idxBob = await client.getIndex('sess-bobbbbbbbbbbbbbb');
      ok('F3_others-index-404-same-response', idxBob.ok === false && idxBob.code === 'NOT_FOUND' && idxBob.message === recordingMod.NOT_FOUND_MESSAGE);
      const dlBob = await client.download('sess-bobbbbbbbbbbbbbb');
      ok('F4_others-download-404', dlBob.ok === false && dlBob.code === 'NOT_FOUND');
      const idxMissing = await client.getIndex('sess-0000000000000000');
      ok('F5_missing-index-404', idxMissing.ok === false && idxMissing.code === 'NOT_FOUND');
      // 本人录像下载：整文件、无 Range 头。
      const dl = await client.download(recId);
      ok('F6_download-full', dl.ok === true && dl.bytes > 0 && dl.body.indexOf('session-start') >= 0);
      const dlCall = srv.rawCalls.find((c) => c.url.indexOf(recId) >= 0);
      ok('F7_download-no-range-header', !!dlCall && !('Range' in (dlCall.headers || {})) && !('range' in (dlCall.headers || {})));
      const idx = await client.getIndex(recId);
      ok('F8_index-ok', idx.ok === true && idx.index && Array.isArray(idx.index.index));
    }

    // ---------- G. 回放器纯函数 ----------
    {
      const text = '{"type":"session-start","at":1000,"tier":"balanced"}\n{"type":"input","at":2000,"kind":"mouse","x":1,"y":2}\n{"type":"input","at":3000,"kind":"mouse","x":3,"y":4}';
      const parsed = recordingMod.parseQfrec(text);
      ok('G1_parse-partial-line_excluded', parsed.events.length === 2 && parsed.complete === false && parsed.partialBytes > 0);
      const parsedFull = recordingMod.parseQfrec(text + '\n');
      ok('G2_parse-full', parsedFull.events.length === 3 && parsedFull.complete === true);
      const index = [{ t: 1000, byteOffset: 10 }, { t: 11000, byteOffset: 200 }, { t: 21000, byteOffset: 400 }];
      ok('G3_seek-anchor', JSON.stringify(recordingMod.seekAnchor(index, 15000)) === JSON.stringify({ t: 11000, byteOffset: 200 }));
      ok('G4_seek-before-first', JSON.stringify(recordingMod.seekAnchor(index, 500)) === JSON.stringify({ t: 0, byteOffset: 0 }));
      ok('G5_seek-exact', recordingMod.seekAnchor(index, 21000).byteOffset === 400);
      ok('G6_playback-speed', recordingMod.playbackDelayMs(1000, 3000, 2) === 1000 && recordingMod.playbackDelayMs(1000, 3000, 0.5) === 4000 && recordingMod.playbackDelayMs(1000, 3000, 1) === 2000);
    }

    // ---------- H. UI 状态快照 ----------
    {
      const c = makeClient(srv);
      const ui0 = c.getUiState();
      ok('H1_idle-ui', ui0.state === 'idle' && ui0.privacyNote === '本录像含操作记录');
      await c.start({ sessionId: 'sess-4444444444444444', deviceId: 'd1', groupId: 'g1', tier: 'balanced' });
      const ui1 = c.getUiState();
      ok('H2_recording-ui', ui1.state === 'recording' && ui1.message.indexOf('事件流') >= 0);
      await c.end();
    }
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
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
