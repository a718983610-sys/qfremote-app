'use strict';
/*
 * QFRemote 扩展服务 · 同账号设备间文件发送（站长 2026-10-25 #25 定版）
 * ================================================================
 * 远程会话文件区选文件 →「发送到我的其他设备」→ 选同账号目标设备：
 * 源端上传至本站暂存，目标端领取下载；目标离线则暂存待其上线，
 * 暂存 24 小时到期自动清理。仅同账号设备之间（记录按账号隔离、
 * 收发两端都必须以该账号会话访问，结构上不存在跨账号路径）。
 * 单文件上限默认 200MB（config.json fileSendMaxMb 可调），暂存
 * 时长默认 24 小时（fileSendStageHours 可调）。
 *
 * 本模块为服务端端点组（蓝图 N-3）：暂存/收件箱/下载/回执/清理。
 * 目标设备以 MeshCentral 节点 id 标识（发送方从本人设备列表选）。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function createFilesCore(deps) {
  const dir = deps.dir; // LIC_DIR
  const lic = deps.lic;
  const log = deps.log || (() => {});
  const file = path.join(dir, 'file-stage.json');
  const blobDir = path.join(dir, 'file-stage-blobs');
  try { fs.mkdirSync(blobDir, { recursive: true, mode: 0o700 }); } catch (e) {}

  let store = { items: {} };
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (v && typeof v === 'object' && v.items) store = v;
  } catch (e) {}
  function save() {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(store, null, 1), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }
  function limits() {
    const c = lic.readConfig() || {};
    return {
      maxBytes: (Number(c.fileSendMaxMb) > 0 ? Number(c.fileSendMaxMb) : 200) * 1024 * 1024,
      stageMs: (Number(c.fileSendStageHours) > 0 ? Number(c.fileSendStageHours) : 24) * 3600000,
    };
  }
  function sweep(now) {
    let changed = false;
    for (const it of Object.values(store.items)) {
      if (it.status === 'staged' && now > it.expiresAt) {
        try { fs.unlinkSync(path.join(blobDir, it.blob)); } catch (e) {}
        it.status = 'expired'; it.blob = null; changed = true;
        log({ ev: 'file-stage-expired', id: it.id, target: it.username });
      }
    }
    if (changed) save();
  }
  function stage(username, input, now) {
    const lim = limits();
    const filename = String((input && input.filename) || '').slice(0, 200).replace(/[/\\]/g, '_') || 'file';
    const toNode = String((input && input.toNode) || '').slice(0, 200);
    const fromNode = String((input && input.fromNode) || '').slice(0, 200);
    if (!toNode) return { ok: false, code: 'VALIDATION', msg: '请选择要发送到的设备。' };
    if (fromNode && toNode === fromNode) return { ok: false, code: 'VALIDATION', msg: '目标设备与来源设备相同，请选择另一台设备。' };
    const b64 = String((input && input.contentBase64) || '');
    if (!b64) return { ok: false, code: 'VALIDATION', msg: '文件内容为空。' };
    let buf;
    try { buf = Buffer.from(b64, 'base64'); } catch (e) { buf = null; }
    if (!buf || !buf.length) return { ok: false, code: 'VALIDATION', msg: '文件内容不正确。' };
    if (buf.length > lim.maxBytes) return { ok: false, code: 'TOO_LARGE', msg: '文件超过单文件上限（' + Math.floor(lim.maxBytes / 1048576) + ' MB）。' };
    const it = {
      id: 'fs_' + crypto.randomBytes(8).toString('hex'), username,
      filename, size: buf.length, fromNode, toNode,
      status: 'staged', createdAt: now, expiresAt: now + lim.stageMs, deliveredAt: null,
      blob: null,
    };
    it.blob = it.id + '.bin';
    try { fs.writeFileSync(path.join(blobDir, it.blob), buf, { mode: 0o600 }); } catch (e) { return { ok: false, code: 'IO', msg: '文件暂存失败，请稍后再试。' }; }
    store.items[it.id] = it; save();
    log({ ev: 'file-staged', id: it.id, target: username, size: it.size });
    return { ok: true, id: it.id, size: it.size, expiresAt: it.expiresAt };
  }
  function brief(it) {
    return { id: it.id, filename: it.filename, size: it.size, fromNode: it.fromNode, toNode: it.toNode, status: it.status, createdAt: it.createdAt, expiresAt: it.expiresAt, deliveredAt: it.deliveredAt };
  }
  function inbox(username, toNode, now) {
    sweep(now);
    return Object.values(store.items)
      .filter((it) => it.username === username && it.status === 'staged' && (!toNode || it.toNode === toNode))
      .sort((a, b) => a.createdAt - b.createdAt).map(brief);
  }
  function sent(username, now) {
    sweep(now);
    return Object.values(store.items)
      .filter((it) => it.username === username)
      .sort((a, b) => b.createdAt - a.createdAt).slice(0, 30).map(brief);
  }
  function blobPathFor(username, id, now) {
    sweep(now);
    const it = store.items[id];
    if (!it || it.username !== username || it.status !== 'staged' || !it.blob) return null;
    return { it, fp: path.join(blobDir, it.blob) };
  }
  function ack(username, id, now) {
    const it = store.items[id];
    if (!it || it.username !== username) return { ok: false, code: 'NOT_FOUND', msg: '记录不存在。' };
    if (it.status === 'staged') {
      try { fs.unlinkSync(path.join(blobDir, it.blob)); } catch (e) {}
      it.status = 'delivered'; it.blob = null; it.deliveredAt = now; save();
    }
    return { ok: true, id: it.id, status: it.status };
  }
  return { stage, inbox, sent, blobPathFor, ack, limits, sweep };
}

module.exports = { createFilesCore };
