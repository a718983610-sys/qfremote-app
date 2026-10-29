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

const DEFAULT_SWEEP_MS = 60000;
const DEFAULT_PIN_MS = 120000;

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
    if (v && typeof v === 'object' && v.items && typeof v.items === 'object') {
      store = v;
      // 老记录兼容：缺失 downloadedAt 按未下载处理。
      for (const it of Object.values(store.items)) {
        if (!Object.prototype.hasOwnProperty.call(it, 'downloadedAt')) it.downloadedAt = null;
        if (it.pendingDelete && !it.blob) delete it.pendingDelete;
      }
    }
  } catch (e) {}

  // 仅驻留内存：id -> { tokens: Set<{ timer }> }（门二 P2-02：每 pin 独立租约）
  // 服务重启后没有 in-flight 租约；pendingDelete 会由 sweep 自愈清理。
  const pins = new Map();

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

  function sweepIntervalMs() {
    try {
      const c = lic.readConfig() || {};
      const n = Number(c.fileSendSweepMs);
      return n > 0 ? n : DEFAULT_SWEEP_MS;
    } catch (e) {
      log({ ev: 'file-sweep-error', err: String(e && e.stack || e) });
      return DEFAULT_SWEEP_MS;
    }
  }

  function pinTimeoutMs() {
    try {
      const c = lic.readConfig() || {};
      const n = Number(c.fileSendPinLeaseMs);
      return n > 0 ? n : DEFAULT_PIN_MS;
    } catch (e) {
      return DEFAULT_PIN_MS;
    }
  }

  function isPinned(id) {
    const p = pins.get(id);
    return !!(p && p.tokens.size > 0);
  }

  function tryDeleteBlob(it) {
    if (!it || !it.blob) {
      if (it) delete it.pendingDelete;
      return;
    }
    if (isPinned(it.id)) {
      it.pendingDelete = true;
      return;
    }
    try { fs.unlinkSync(path.join(blobDir, it.blob)); } catch (e) {}
    it.blob = null;
    delete it.pendingDelete;
  }

  function cleanupPendingDelete(id) {
    const it = store.items[id];
    if (!it || !it.pendingDelete) return;
    if (isPinned(id)) return;
    delete it.pendingDelete;
    if (it.blob) {
      try { fs.unlinkSync(path.join(blobDir, it.blob)); } catch (e) {}
      it.blob = null;
    }
    save();
    log({ ev: 'file-blob-unlink', id: it.id, target: it.username || '-', reason: 'pin-released' });
  }


  function pinBlob(id) {
    let p = pins.get(id);
    if (!p) {
      p = { tokens: new Set() };
      pins.set(id, p);
    }
    const token = { timer: null };
    p.tokens.add(token);
    token.timer = setTimeout(() => {
      const cur = pins.get(id);
      if (!cur) return;
      cur.tokens.delete(token);
      log({ ev: 'file-pin-timeout', id, target: (store.items[id] && store.items[id].username) || '-' });
      if (cur.tokens.size === 0) {
        pins.delete(id);
        cleanupPendingDelete(id);
      }
    }, pinTimeoutMs());
    if (token.timer && typeof token.timer.unref === 'function') token.timer.unref();
    return token;
  }

  function releasePin(id, token) {
    const p = pins.get(id);
    if (!p || !token) return;
    if (!p.tokens.has(token)) return;
    if (token.timer) {
      clearTimeout(token.timer);
      token.timer = null;
    }
    p.tokens.delete(token);
    if (p.tokens.size === 0) {
      pins.delete(id);
      cleanupPendingDelete(id);
    }
  }


  function sweep(now) {
    let changed = false;

    // 到期边界：now >= expiresAt，满 24h 即到期。
    for (const it of Object.values(store.items)) {
      if (it.status === 'staged' && now >= it.expiresAt) {
        const pinned = isPinned(it.id);
        it.status = 'expired';
        if (it.blob) {
          if (pinned) {
            it.pendingDelete = true;
          } else {
            try { fs.unlinkSync(path.join(blobDir, it.blob)); } catch (e) {}
            it.blob = null;
            delete it.pendingDelete;
          }
        }
        changed = true;
        log({ ev: 'file-stage-expired', id: it.id, target: it.username, pinned });
      }
    }

    // 自愈：非 staged 的 blob 不应保留。
    // 典型场景：上一进程 pinned 记录落盘 pendingDelete 后重启，
    // 新进程 pin 表为空，应由 sweep 补删。
    for (const it of Object.values(store.items)) {
      if (it.status !== 'staged' && it.blob && !isPinned(it.id)) {
        try { fs.unlinkSync(path.join(blobDir, it.blob)); } catch (e) {}
        const reason = it.pendingDelete ? 'pending-restart' : it.status;
        it.blob = null;
        delete it.pendingDelete;
        changed = true;
        log({ ev: 'file-blob-unlink', id: it.id, target: it.username || '-', reason });
      }
    }

    if (changed) save();
  }

  function stage(username, input, now) {
    sweep(now);

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
      id: 'fs_' + crypto.randomBytes(8).toString('hex'),
      username,
      filename,
      size: buf.length,
      fromNode,
      toNode,
      status: 'staged',
      createdAt: now,
      expiresAt: now + lim.stageMs,
      deliveredAt: null,
      downloadedAt: null,
      blob: null,
    };
    it.blob = it.id + '.bin';
    try { fs.writeFileSync(path.join(blobDir, it.blob), buf, { mode: 0o600 }); } catch (e) { return { ok: false, code: 'IO', msg: '文件暂存失败，请稍后再试。' }; }
    store.items[it.id] = it;
    save();
    log({ ev: 'file-staged', id: it.id, target: username, size: it.size });
    return { ok: true, id: it.id, size: it.size, expiresAt: it.expiresAt };
  }

  function brief(it) {
    return {
      id: it.id,
      filename: it.filename,
      size: it.size,
      fromNode: it.fromNode,
      toNode: it.toNode,
      status: it.status,
      createdAt: it.createdAt,
      expiresAt: it.expiresAt,
      deliveredAt: it.deliveredAt,
      downloadedAt: it.downloadedAt || null,
    };
  }

  function inbox(username, toNode, now) {
    sweep(now);
    return Object.values(store.items)
      .filter((it) => it.username === username && it.status === 'staged' && (!toNode || it.toNode === toNode))
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(brief);
  }

  function sent(username, now) {
    sweep(now);
    return Object.values(store.items)
      .filter((it) => it.username === username)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 30)
      .map(brief);
  }

  function blobPathFor(username, id, now) {
    sweep(now);
    const it = store.items[id];
    if (!it || it.username !== username || it.status !== 'staged' || !it.blob) return null;

    const fp = path.join(blobDir, it.blob);
    if (!fs.existsSync(fp)) return null;

    if (!it.downloadedAt) {
      it.downloadedAt = now;
      save();
    }

    const pinToken = pinBlob(it.id);
    return {
      it,
      fp,
      release: function () {
        releasePin(it.id, pinToken);
      },
    };
  }

  function ack(username, id, now) {
    sweep(now);
    const it = store.items[id];
    if (!it || it.username !== username) return { ok: false, code: 'NOT_FOUND', msg: '记录不存在。' };

    if (it.status === 'delivered') return { ok: true, id: it.id, status: it.status };

    // 门二 Q1 裁定②：有效期内已下载成功者，ack 迟到也记 delivered。
    const downloaded = Number(it.downloadedAt);
    const expires = Number(it.expiresAt);
    const downloadedInTime =
      Number.isFinite(downloaded) &&
      Number.isFinite(expires) &&
      downloaded > 0 &&
      downloaded <= expires;

    function markDelivered(late) {
      it.status = 'delivered';
      it.deliveredAt = now;
      tryDeleteBlob(it);
      save();
      log({ ev: 'file-ack', id: it.id, target: username, late: late || undefined });
      return { ok: true, id: it.id, status: it.status };
    }

    if (it.status === 'expired') {
      if (!downloadedInTime) {
        return { ok: false, code: 'EXPIRED', msg: '文件已过期，无法回执。' };
      }
      return markDelivered(true);
    }

    if (it.status === 'staged') {
      if (now >= it.expiresAt) {
        // 防御性分支；正常入口 sweep 已经先翻为 expired。
        if (!downloadedInTime) {
          return { ok: false, code: 'EXPIRED', msg: '文件已过期，无法回执。' };
        }
        return markDelivered(true);
      }

      if (!it.downloadedAt) {
        return { ok: false, code: 'NOT_DOWNLOADED', msg: '该文件尚未下载，不能回执。' };
      }

      return markDelivered(false);
    }

    return { ok: false, code: 'NOT_FOUND', msg: '记录状态不正确。' };
  }

  const sweepTimer = setInterval(() => {
    try {
      sweep(Date.now());
    } catch (e) {
      log({ ev: 'file-sweep-error', err: String(e && e.stack || e) });
    }
  }, sweepIntervalMs());

  if (sweepTimer && typeof sweepTimer.unref === 'function') sweepTimer.unref();

  return { stage, inbox, sent, blobPathFor, ack, limits, sweep };
}

module.exports = { createFilesCore };
