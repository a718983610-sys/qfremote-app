'use strict';
/*
 * QFRemote 扩展服务 · L5 RC-10：录像做成指令/事件流（协议 QF-REC-1）
 * ================================================================
 * 来源：Guacamole libguac/recording.h（录像存画面指令＋鼠标/按键/
 * 剪贴板事件；guacenc 离线转视频；guaclog 审按键；JS SessionRecording.js
 * 回放器支持 seek、变速、边下边播）＋ MeshCentral mcrec.js 三级粒度
 * 开关（只对选定用户/用户组/设备组录制）＋ HopToDesk
 * policy_forces_recording()（服务端策略强制录制）。
 *
 * 本模块是服务端录制策略＋存储＋索引＋访问控制（.qfrec 格式）：
 *   - 格式：JSONL 事件流（.qfrec），不是视频——session-start（会话
 *     元数据＋档位＋录制策略）→ input（鼠标/按键）/clipboard（只记
 *     元数据：字节数，绝不记内容）/frame-marker（关键帧锚点）/
 *     quality-change → session-end。回放索引：每 10s 一个 seek-index
 *    （时间戳＋字节偏移），支持 seek/变速（回放器由 L4 在 W-05 后做，
 *     本线只出索引＋读取 API）。
 *   - 三级粒度开关：config.json recording.policy = off（默认）/
 *     user（指定用户）/ group（指定设备组）/ device（指定设备）；
 *     服务端在会话建立时判定本会话是否录制；默认不录，须双方知情
 *     或站长明确授权才开；策略变更记审计（经注入的 log 回调）。
 *   - 访问控制：录像按账号隔离；读取只许本人；未授权返回 403 且
 *     不泄露存在性（调用方统一按 404 处理）；录像含按键与剪贴板即
 *     含敏感信息，文件 0600；站长侧查看不另开后门，须走既有审核/
 *     授权流程（本模块不给站长直通）。
 *   - 体积目标：10 分钟录像比同等视频小一个量级（沙箱以模拟事件
 *     流实测，见 test-l5-recording.js）。
 *
 * 不做的事：不做 mp4 转码（REPORT §十二-10：先只做录制＋回放最小
 * 闭环）；事件流的实际捕获埋点在上游 mcrec.js 钩子（树外，须另派
 * 线），本模块只定格式＋做服务端侧。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const EVENT_TYPES = ['session-start', 'input', 'clipboard', 'frame-marker', 'quality-change', 'session-end', 'seek-index'];
const SEEK_INDEX_INTERVAL_MS = 10000;
const DEFAULT_RETENTION_DAYS = 30;

function recordingPolicy(config) {
  const r = (config && config.recording) || {};
  const mode = ['off', 'user', 'group', 'device'].includes(r.mode) ? r.mode : 'off';
  return {
    mode,
    users: Array.isArray(r.users) ? r.users.map(String) : [],
    groups: Array.isArray(r.groups) ? r.groups.map(String) : [],
    devices: Array.isArray(r.devices) ? r.devices.map(String) : [],
    retentionDays: Number(r.retentionDays) > 0 ? Number(r.retentionDays) : DEFAULT_RETENTION_DAYS,
  };
}

function shouldRecord(policy, ctx) {
  if (policy.mode === 'off') return false;
  if (policy.mode === 'user') return policy.users.includes(String(ctx.username || ''));
  if (policy.mode === 'group') return policy.groups.includes(String(ctx.groupId || ''));
  if (policy.mode === 'device') return policy.devices.includes(String(ctx.deviceId || ''));
  return false;
}

function createRecordingCore(deps) {
  const dir = deps.dir;
  const log = deps.log || (() => {});
  const readConfig = deps.readConfig || (() => ({}));
  const recDir = path.join(dir, 'recordings');
  try { fs.mkdirSync(recDir, { recursive: true, mode: 0o700 }); } catch (e) {}

  const sessions = new Map(); // sessionId -> { meta, bytes, events, lastIndexAt, index: [] }

  function recPath(sessionId) { return path.join(recDir, sessionId + '.qfrec'); }
  function idxPath(sessionId) { return path.join(recDir, sessionId + '.qfrec.idx'); }
  function metaPath(sessionId) { return path.join(recDir, sessionId + '.meta.json'); }

  function policy() { return recordingPolicy(readConfig()); }

  function startSession(meta, now) {
    const p = policy();
    const ctx = { username: meta.username, groupId: meta.groupId, deviceId: meta.deviceId };
    if (!shouldRecord(p, ctx)) return { ok: false, code: 'POLICY_OFF', msg: '录制策略未开启（默认不录）。' };
    const sessionId = String(meta.sessionId || ('rec_' + crypto.randomBytes(8).toString('hex')));
    const full = {
      sessionId, username: String(meta.username || ''), deviceId: String(meta.deviceId || ''),
      groupId: String(meta.groupId || ''), tier: String(meta.tier || 'balanced'),
      policyMode: p.mode, startedAt: now,
    };
    try {
      fs.writeFileSync(metaPath(sessionId), JSON.stringify(full), { mode: 0o600 });
      fs.writeFileSync(recPath(sessionId), '', { mode: 0o600 });
    } catch (e) {
      return { ok: false, code: 'IO', msg: '录像文件创建失败。' };
    }
    sessions.set(sessionId, { meta: full, bytes: 0, events: 0, lastIndexAt: now, index: [] });
    appendEvent(sessionId, { type: 'session-start', at: now, tier: full.tier, policyMode: p.mode }, now);
    log({ ev: 'recording-started', sessionId, username: full.username, deviceId: full.deviceId, policyMode: p.mode });
    return { ok: true, sessionId };
  }

  // 剪贴板事件只记元数据（字节数），绝不记内容；其他事件只许白名单字段。
  function sanitizeEvent(ev) {
    if (!ev || !EVENT_TYPES.includes(ev.type)) return null;
    const base = { type: ev.type, at: Number(ev.at) || Date.now() };
    if (ev.type === 'input') {
      base.kind = ['mouse', 'key', 'touch'].includes(ev.kind) ? ev.kind : 'mouse';
      base.x = Number(ev.x) || 0;
      base.y = Number(ev.y) || 0;
      if (typeof ev.key === 'string') base.key = ev.key.slice(0, 32); // 按键名（如 Enter），非密码内容
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

  function appendEvent(sessionId, ev, now) {
    const st = sessions.get(sessionId);
    if (!st) return { ok: false, code: 'NOT_FOUND', msg: '录制会话不存在。' };
    const clean = sanitizeEvent(ev);
    if (!clean) return { ok: false, code: 'VALIDATION', msg: '事件类型非法。' };
    const line = JSON.stringify(clean) + '\n';
    try {
      fs.appendFileSync(recPath(sessionId), line, { mode: 0o600 });
    } catch (e) {
      return { ok: false, code: 'IO', msg: '录像写入失败。' };
    }
    st.bytes += Buffer.byteLength(line);
    st.events += 1;
    // seek 索引：每 10s 一个锚点（时间戳＋字节偏移）
    if (clean.at - st.lastIndexAt >= SEEK_INDEX_INTERVAL_MS) {
      st.index.push({ t: clean.at, byteOffset: st.bytes });
      st.lastIndexAt = clean.at;
    }
    return { ok: true, events: st.events };
  }

  function endSession(sessionId, now) {
    const st = sessions.get(sessionId);
    if (!st) return { ok: false, code: 'NOT_FOUND', msg: '录制会话不存在。' };
    appendEvent(sessionId, { type: 'session-end', at: now }, now);
    const index = st.index.slice();
    try {
      fs.writeFileSync(idxPath(sessionId), JSON.stringify({ sessionId, index, events: st.events, bytes: st.bytes, endedAt: now }), { mode: 0o600 });
    } catch (e) {
      return { ok: false, code: 'IO', msg: '索引写入失败。' };
    }
    sessions.delete(sessionId);
    log({ ev: 'recording-ended', sessionId, events: st.events, bytes: st.bytes });
    return { ok: true, sessionId, events: st.events, bytes: st.bytes, index };
  }

  function readMeta(sessionId) {
    try { return JSON.parse(fs.readFileSync(metaPath(sessionId), 'utf8')); } catch (e) { return null; }
  }

  // 访问控制：只许本人；站长无直通（须走既有审核/授权流程）。
  function canAccess(username, sessionId) {
    const meta = readMeta(sessionId);
    if (!meta) return { ok: false, code: 'NOT_FOUND' };
    if (meta.username !== String(username || '')) return { ok: false, code: 'FORBIDDEN' };
    return { ok: true, meta };
  }

  function readIndex(sessionId) {
    try {
      const idx = JSON.parse(fs.readFileSync(idxPath(sessionId), 'utf8'));
      if (idx && Array.isArray(idx.index)) return idx;
    } catch (e) {}
    // 无索引文件时现扫 .qfrec 重建（按 10s 锚点）。
    try {
      const raw = fs.readFileSync(recPath(sessionId));
      const lines = raw.toString('utf8').split('\n');
      const index = [];
      let offset = 0;
      let lastT = null;
      for (const line of lines) {
        if (!line) { offset += 1; continue; }
        let ev = null;
        try { ev = JSON.parse(line); } catch (ignored) {}
        if (ev && typeof ev.at === 'number') {
          if (lastT === null || ev.at - lastT >= SEEK_INDEX_INTERVAL_MS) {
            index.push({ t: ev.at, byteOffset: offset });
            lastT = ev.at;
          }
        }
        offset += Buffer.byteLength(line) + 1;
      }
      return { sessionId, index, events: lines.filter(Boolean).length, bytes: raw.length, rebuilt: true };
    } catch (e) {
      return null;
    }
  }

  function listRecordings(username) {
    let names = [];
    try { names = fs.readdirSync(recDir); } catch (e) { return []; }
    const out = [];
    for (const name of names) {
      if (!name.endsWith('.meta.json')) continue;
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(recDir, name), 'utf8'));
        if (meta && meta.username === username) {
          let bytes = 0;
          try { bytes = fs.statSync(recPath(meta.sessionId)).size; } catch (ignored) {}
          out.push({ sessionId: meta.sessionId, deviceId: meta.deviceId, tier: meta.tier, startedAt: meta.startedAt, bytes });
        }
      } catch (ignored) {}
    }
    return out.sort((a, b) => b.startedAt - a.startedAt);
  }

  // 过期清理：超 retentionDays 的录像＋索引＋元数据一并删。
  function sweep(now) {
    const p = policy();
    const maxAge = p.retentionDays * 86400000;
    let swept = 0;
    let names = [];
    try { names = fs.readdirSync(recDir); } catch (e) { return 0; }
    for (const name of names) {
      if (!name.endsWith('.meta.json')) continue;
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(recDir, name), 'utf8'));
        if (!meta || !meta.sessionId) continue;
        if (now - meta.startedAt < maxAge) continue;
        for (const f of [recPath(meta.sessionId), idxPath(meta.sessionId), metaPath(meta.sessionId)]) {
          try { fs.unlinkSync(f); } catch (ignored) {}
        }
        swept += 1;
      } catch (ignored) {}
    }
    return swept;
  }

  return { policy, shouldRecord: (ctx) => shouldRecord(policy(), ctx), startSession, appendEvent, endSession, canAccess, readIndex, listRecordings, sweep, readMeta, filePath: recPath };
}

// 体积估算：同等视频体积（码率 kbps × 时长）vs 事件流实测体积。
function estimateVideoBytes(durationSec, bitrateKbps) {
  return Math.round((durationSec * bitrateKbps * 1000) / 8);
}

module.exports = { createRecordingCore, recordingPolicy, shouldRecord, estimateVideoBytes, EVENT_TYPES, SEEK_INDEX_INTERVAL_MS };
