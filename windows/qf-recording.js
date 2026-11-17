'use strict';
/*
 * QFRemote Windows 运行端 — RC-10 录像事件流客户端（3.0.0）
 * ==========================================================
 * 依据：QF-REC-1 客户端协议规范 v1（server/ext/QF-REC-1-CLIENT-SPEC.md）
 * 全文。服务端实现见 server/ext/recording-core.js；路由见
 * server/ext/server.js（/license/api/recordings/*）。
 *
 * 格式：.qfrec 是 JSONL 事件流（不是视频），不存视频帧。客户端只发
 * 四种事件：input / clipboard / frame-marker / quality-change；
 * session-start / session-end 由服务端写，客户端不得发；seek-index
 * 是索引文件的概念，不要往 /event 发。
 *
 * 隐私红线（规范 §1.1／§4.1）：
 *   - clipboard 只记字节数（bytes），绝不记剪贴板内容——调用方即使
 *     传了 content 字段，本模块也在 sanitize 时丢弃；
 *   - input 的 key 只记按键名（截断至 32 字符），不记密码等输入内容；
 *   - 录像按账号隔离；index / download 无权限与不存在同一 HTTP 404，
 *     客户端不得把 404 区分解读为“存在但无权限”，不得反复重试。
 *
 * 策略（规范 §3.1）：默认不录（mode off）；策略未开启时 start 返回
 * POLICY_OFF，客户端收到后不得继续发事件，UI 须提示“当前会话不录制”。
 * 策略变更不由客户端发起（无改策略端点）。
 *
 * 中断语义（规范 §6.2）：录制会话只存在于服务端内存；服务端重启后
 * 内存丢失，此后 /event / /end 返回 NOT_FOUND（磁盘上的 .qfrec 还在，
 * 但续不上）。客户端收到 NOT_FOUND 后不得静默丢事件——提示“录制已
 * 中断（服务端重启），本次录像不完整”，并重新 start 一个新录制
 * （新 sessionId，由服务端生成 rec_…；客户端不复用旧 id）。
 *
 * 事件顺序：批量发时须保持 at 单调递增，不得倒序补发旧事件（索引锚点
 * 依赖 at 单调）。本模块在本地拦截 at < lastSentAt 的事件（不发网
 * 络请求、记日志），调用方不得绕过。
 *
 * 诚实边界（规范 §6.5）：事件实际捕获埋点（上游 mcrec.js 钩子或 agent
 * 侧事件上报）未实现——本模块只做协议就绪部分（start/event/end/
 * list/index/download＋回放器纯函数），不捕获真实输入/剪贴板/关键帧，
 * 不得宣称已实现真机录像。在埋点落地前，事件须由调用方（会话层）
 * 显式传入；无调用方传入时本模块不发任何事件、不伪造输入事件。
 * 回放器：列表/加载/seek/变速/边下边播按规范 §5 实现为纯函数；
 * 录像下载不支持 Range（与 QF-STREAM-1 不同），回放器须整文件下载
 * 后本地 seek，不得发 Range 请求。
 */
const crypto = require('crypto');
const RECORDINGS_BASE = '/license/api/recordings';
const EVENT_TYPES = ['session-start', 'input', 'clipboard', 'frame-marker', 'quality-change', 'session-end', 'seek-index'];
const CLIENT_EVENT_TYPES = ['input', 'clipboard', 'frame-marker', 'quality-change'];
const SEEK_INDEX_INTERVAL_MS = 10000;
const INTERRUPTED_MESSAGE = '录制已中断（服务端重启），本次录像不完整';
const NOT_FOUND_MESSAGE = '录像不存在或无权限查看';

// 事件白名单清洗（与服务端 sanitizeEvent 同款字段集，recording-core.js）。
// clipboard 的 content 字段一律丢弃（只记 bytes）；key 截断至 32 字符。
function sanitizeEvent(ev) {
  if (!ev || EVENT_TYPES.indexOf(ev.type) < 0) return null;
  const base = { type: ev.type, at: Number(ev.at) || Date.now() };
  if (ev.type === 'input') {
    base.kind = ['mouse', 'key', 'touch'].indexOf(ev.kind) >= 0 ? ev.kind : 'mouse';
    base.x = Number(ev.x) || 0;
    base.y = Number(ev.y) || 0;
    if (typeof ev.key === 'string') base.key = ev.key.slice(0, 32);
  } else if (ev.type === 'clipboard') {
    base.bytes = Math.max(0, Number(ev.bytes) || 0);
  } else if (ev.type === 'frame-marker') {
    base.frameId = Number(ev.frameId) || 0;
    base.isKeyframe = !!ev.isKeyframe;
  } else if (ev.type === 'quality-change') {
    base.from = String(ev.from || '').slice(0, 32);
    base.to = String(ev.to || '').slice(0, 32);
  } else if (ev.type === 'session-start') {
    base.tier = String(ev.tier || '');
    base.policyMode = String(ev.policyMode || '');
  }
  return base;
}

function newRecordingSessionId() {
  return 'rec_' + crypto.randomBytes(8).toString('hex');
}

function createRecordingClient(opts) {
  const o = opts || {};
  if (typeof o.request !== 'function') throw new Error('qf-recording: request 注入缺失');
  if (typeof o.requestRaw !== 'function') throw new Error('qf-recording: requestRaw 注入缺失（录像下载须回原始字节）');
  if (typeof o.baseUrl !== 'string' || !o.baseUrl) throw new Error('qf-recording: baseUrl 缺失');
  const request = o.request;
  const requestRaw = o.requestRaw;
  const baseUrl = String(o.baseUrl).replace(/\/+$/, '');
  const nowMs = typeof o.nowMs === 'function' ? o.nowMs : Date.now;
  const log = typeof o.log === 'function' ? o.log : () => {};

  let sessionId = ''; // 当前录制会话 id（服务端 start 返回/生成）
  let deviceId = typeof o.deviceId === 'string' ? o.deviceId : '';
  let groupId = typeof o.groupId === 'string' ? o.groupId : '';
  let tier = typeof o.tier === 'string' ? o.tier : 'balanced';
  let state = 'idle'; // idle | recording | interrupted | ended | policy-off
  let eventsSent = 0;
  let lastSentAt = 0;
  let lastIndex = null;

  function errorCodeOf(json) {
    if (json && typeof json.code === 'string' && json.code) return json.code;
    return '';
  }

  // 开始录制：sessionId 建议传桌面会话的 sessionId 以便关联；不传时
  // 服务端生成 rec_＋16 位 hex。POLICY_OFF 时不录制、不发事件。
  async function start(args) {
    const a = args || {};
    const sid = typeof a.sessionId === 'string' && a.sessionId ? a.sessionId : undefined;
    const did = typeof a.deviceId === 'string' ? a.deviceId : deviceId;
    const gid = typeof a.groupId === 'string' ? a.groupId : groupId;
    const tr = typeof a.tier === 'string' ? a.tier : tier;
    let res;
    try {
      res = await request('POST', baseUrl + RECORDINGS_BASE + '/start',
        { sessionId: sid, deviceId: did, groupId: gid, tier: tr });
    } catch (e) {
      return { ok: false, kind: 'network' };
    }
    const status = (res && typeof res.status === 'number') ? res.status : 0;
    const json = (res && res.json) || null;
    if (status === 503 && json && json.code === 'L5_UNAVAILABLE') return { ok: false, kind: 'unavailable', code: 'L5_UNAVAILABLE' };
    if (status === 200 && json && json.ok === true) {
      sessionId = String(json.sessionId || '');
      deviceId = did;
      groupId = gid;
      tier = tr;
      state = 'recording';
      eventsSent = 0;
      lastSentAt = 0;
      lastIndex = null;
      log('recording.started session=' + sessionId);
      return { ok: true, sessionId };
    }
    const code = errorCodeOf(json);
    if (code === 'POLICY_OFF') {
      state = 'policy-off';
      return { ok: false, kind: 'policy-off', code, message: '当前会话不录制' };
    }
    return { ok: false, kind: 'rejected', code };
  }

  // 上报一个事件。只发四种客户端事件；session-start / session-end /
  // seek-index 由服务端写，客户端发了也只剩 type/at、无意义——本地拒
  // 绝，不发网络请求。at 须单调递增，倒序事件本地丢弃。
  async function reportEvent(ev) {
    if (state !== 'recording' || !sessionId) {
      return { ok: false, kind: state === 'policy-off' ? 'policy-off' : 'not-recording' };
    }
    if (!ev || CLIENT_EVENT_TYPES.indexOf(ev.type) < 0) {
      return { ok: false, kind: 'client-forbidden', message: '客户端只发 input/clipboard/frame-marker/quality-change 四种事件' };
    }
    const clean = sanitizeEvent(ev);
    if (!clean) return { ok: false, kind: 'validation' };
    if (!Number.isFinite(Number(ev.at))) clean.at = nowMs();
    if (clean.at < lastSentAt) {
      log('recording.drop-out-of-order at=' + clean.at + ' last=' + lastSentAt);
      return { ok: false, kind: 'out-of-order', dropped: true };
    }
    let res;
    try {
      res = await request('POST', baseUrl + RECORDINGS_BASE + '/' + encodeURIComponent(sessionId) + '/event', { event: clean });
    } catch (e) {
      return { ok: false, kind: 'network' };
    }
    const status = (res && typeof res.status === 'number') ? res.status : 0;
    const json = (res && res.json) || null;
    if (status === 404 || (json && errorCodeOf(json) === 'NOT_FOUND')) {
      // 服务端重启 → 内存会话丢失：本次录像不完整，不得静默丢事件。
      state = 'interrupted';
      return { ok: false, kind: 'interrupted', code: 'NOT_FOUND', message: INTERRUPTED_MESSAGE };
    }
    if (status === 200 && json && json.ok === true) {
      lastSentAt = clean.at;
      eventsSent = Number(json.events) || eventsSent + 1;
      return { ok: true, events: eventsSent };
    }
    return { ok: false, kind: 'rejected', code: errorCodeOf(json) };
  }

  // 结束录制：服务端追加 session-end 再写 .qfrec.idx。
  async function end() {
    if (state === 'ended') return { ok: false, kind: 'already-ended' };
    if (!sessionId) return { ok: false, kind: 'not-recording' };
    const sid = sessionId;
    let res;
    try {
      res = await request('POST', baseUrl + RECORDINGS_BASE + '/' + encodeURIComponent(sid) + '/end', {});
    } catch (e) {
      return { ok: false, kind: 'network' };
    }
    const status = (res && typeof res.status === 'number') ? res.status : 0;
    const json = (res && res.json) || null;
    if (status === 404 || (json && errorCodeOf(json) === 'NOT_FOUND')) {
      // 落定时守卫（F-WIN-02）：只有本次 end() 的会话仍是当前会话时才
      // 写 state='interrupted'；解绑后已重绑并 start 新录制时不碰新会话。
      if (sessionId === sid) state = 'interrupted';
      return { ok: false, kind: 'interrupted', code: 'NOT_FOUND', message: INTERRUPTED_MESSAGE };
    }
    if (status === 200 && json && json.ok === true) {
      const out = { ok: true, sessionId: sid, events: Number(json.events) || 0, bytes: Number(json.bytes) || 0, index: Array.isArray(json.index) ? json.index.slice() : null };
      // 落定时守卫（F-WIN-02）：只有本次 end() 的会话仍是当前会话时才
      // 写 state='ended' 并清 sessionId；已重绑并 start 新录制时不碰
      // 新会话（否则旧 end() 落定会把新会话状态写成 ended、清掉新 sid）。
      if (sessionId === sid) {
        state = 'ended';
        lastIndex = out.index;
        sessionId = '';
      }
      return out;
    }
    return { ok: false, kind: 'rejected', code: errorCodeOf(json) };
  }

  // 中断后重开：重新 start 一个新录制（新 sessionId，由服务端生成
  // rec_…；不复用旧 id）。调用方须先向用户提示中断。
  async function restartAfterInterrupt(args) {
    const a = args || {};
    sessionId = '';
    state = 'idle';
    return start({ deviceId: a.deviceId, groupId: a.groupId, tier: a.tier });
  }

  async function list() {
    let res;
    try {
      res = await request('GET', baseUrl + RECORDINGS_BASE, null);
    } catch (e) { return { ok: false, kind: 'network' }; }
    const json = (res && res.json) || null;
    if (res && res.status === 200 && json && json.ok === true) {
      return { ok: true, recordings: Array.isArray(json.recordings) ? json.recordings : [] };
    }
    return { ok: false, kind: 'rejected', code: errorCodeOf(json) };
  }

  async function getIndex(recordingId) {
    if (!recordingId) return { ok: false, kind: 'validation' };
    let res;
    try {
      res = await request('GET', baseUrl + RECORDINGS_BASE + '/' + encodeURIComponent(String(recordingId)) + '/index', null);
    } catch (e) { return { ok: false, kind: 'network' }; }
    const status = (res && typeof res.status === 'number') ? res.status : 0;
    const json = (res && res.json) || null;
    if (status === 404) {
      // 无权限与不存在同一响应，不得区分解读、不得反复重试。
      return { ok: false, kind: 'not-found', code: 'NOT_FOUND', message: NOT_FOUND_MESSAGE };
    }
    if (status === 200 && json && json.ok === true && json.index) {
      return { ok: true, index: json.index, rebuilt: !!json.index.rebuilt };
    }
    return { ok: false, kind: 'rejected', code: errorCodeOf(json) };
  }

  // 下载录像文件：整文件下载，不支持 Range——不得发 Range 请求。
  async function download(recordingId) {
    if (!recordingId) return { ok: false, kind: 'validation' };
    let res;
    try {
      res = await requestRaw('GET', baseUrl + RECORDINGS_BASE + '/' + encodeURIComponent(String(recordingId)) + '/download', {});
    } catch (e) { return { ok: false, kind: 'network' }; }
    const status = (res && typeof res.status === 'number') ? res.status : 0;
    const body = (res && Buffer.isBuffer(res.body)) ? res.body : Buffer.alloc(0);
    if (status === 404) {
      return { ok: false, kind: 'not-found', code: 'NOT_FOUND', message: NOT_FOUND_MESSAGE };
    }
    if (status === 200) return { ok: true, body, bytes: body.length };
    return { ok: false, kind: 'rejected', status };
  }

  function bind(ctx) {
    if (ctx && typeof ctx.deviceId === 'string') deviceId = ctx.deviceId;
    if (ctx && typeof ctx.groupId === 'string') groupId = ctx.groupId;
    if (ctx && typeof ctx.tier === 'string') tier = ctx.tier;
  }
  function unbind() {
    sessionId = '';
    state = 'idle';
    eventsSent = 0;
    lastSentAt = 0;
    lastIndex = null;
  }

  function getUiState() {
    return {
      state,
      sessionId,
      eventsSent,
      message: state === 'policy-off' ? '当前会话不录制'
        : state === 'interrupted' ? INTERRUPTED_MESSAGE
          : state === 'recording' ? '正在录制（事件流，不存视频帧）'
            : '',
      canRestart: state === 'interrupted' || state === 'ended',
      canReport: state === 'recording',
      privacyNote: '本录像含操作记录'
    };
  }

  return {
    start,
    reportEvent,
    end,
    restartAfterInterrupt,
    list,
    getIndex,
    download,
    bind,
    unbind,
    getUiState,
    getSessionId: () => sessionId,
    getState: () => state,
    getEventsSent: () => eventsSent
  };
}

// ---- 回放器纯函数（规范 §5：列表/加载/seek/变速/边下边播） ----
// parseQfrec：JSONL 解析；下载未完成时按已下载字节边界切行，半行不播。
function parseQfrec(input) {
  const text = Buffer.isBuffer(input) ? input.toString('utf8') : String(input || '');
  const lines = text.split('\n');
  const complete = text.endsWith('\n') || text === '' ? lines : lines.slice(0, -1);
  const events = [];
  for (const line of complete) {
    if (!line) continue;
    try { const ev = JSON.parse(line); if (ev && typeof ev.type === 'string') events.push(ev); } catch (e) { /* ignore */ }
  }
  const partialBytes = text === '' ? 0 : Buffer.byteLength(text.endsWith('\n') ? '' : lines[lines.length - 1]);
  return { events, completeLines: events.length, partialBytes, complete: text.endsWith('\n') };
}
// seekAnchor：取 t ≤ T 的最后一个锚点；无锚点时从头（byteOffset 0）读。
function seekAnchor(index, targetMs) {
  const anchors = Array.isArray(index) ? index : [];
  let best = null;
  for (const a of anchors) {
    if (Number(a.t) <= Number(targetMs)) best = a;
    else break;
  }
  if (!best) return { t: 0, byteOffset: 0 };
  return { t: Number(best.t), byteOffset: Number(best.byteOffset) };
}
// 变速播放间隔：按 at 差值缩放（至少 0.5x / 1x / 2x）。
function playbackDelayMs(prevAt, nextAt, speed) {
  const s = Number(speed) > 0 ? Number(speed) : 1;
  return Math.max(0, (Number(nextAt) - Number(prevAt)) / s);
}

module.exports = {
  RECORDINGS_BASE,
  EVENT_TYPES,
  CLIENT_EVENT_TYPES,
  SEEK_INDEX_INTERVAL_MS,
  INTERRUPTED_MESSAGE,
  NOT_FOUND_MESSAGE,
  sanitizeEvent,
  newRecordingSessionId,
  createRecordingClient,
  parseQfrec,
  seekAnchor,
  playbackDelayMs
};
