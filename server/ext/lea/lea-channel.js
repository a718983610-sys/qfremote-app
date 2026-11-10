'use strict';
/*
 * LEA 下发通道 · MeshCentral runcommands（DESIGN §3/§1.1）
 * ============================================================
 * 复用已验证的隐私锁通道形态（server/friends/lock-bridge.js）：
 *   svcCall({ action:'runcommands', nodeids:[nodeId], type:0,
 *             cmds:<单条命令字符串>, reply:true, runAsUser:0 })
 *   runAsUser:0 即 SYSTEM 身份；reply:true 服务器才回传 stdout。
 * 服务账号凭据只读既有部署配置（/opt/qfremote-lock/bridge-config.json
 * 的 svcUser/svcPass/mcUrl，与 presence 观测同款只读复用），不新增
 * 任何凭据；环境变量 QFR_LEA_SVC_USER / QFR_LEA_SVC_PASS /
 * QFR_LEA_MC_URL 可覆盖（部署时注入）。凭据永不进日志。
 * WebSocket 构造函数可注入（单测用假 WS，不真连 MeshCentral）。
 */
const fs = require('fs');
const crypto = require('crypto');

const SVC_WAIT_MS = 400;           // 就绪门（与 lock-bridge 同款）
const SVC_HANDSHAKE_MS = 5000;
const SVC_BACKOFF_MIN_MS = 1000;
const SVC_BACKOFF_MAX_MS = 30000;
const SVC_BACKOFF_AUTH_MAX_MS = 60000;
const DEFAULT_RUN_TIMEOUT_MS = 5000; // 下发 5s（DESIGN §3）
const BRIDGE_CFG_PATH = '/opt/qfremote-lock/bridge-config.json';

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function createLeaChannel(opts) {
  opts = opts || {};
  const log = typeof opts.log === 'function' ? opts.log : function () {};
  let WebSocketCtor = opts.WebSocketCtor || null;
  if (!WebSocketCtor) {
    try { WebSocketCtor = require('/opt/meshcentral/node_modules/ws'); }
    catch (e) { try { WebSocketCtor = require('ws'); } catch (e2) { WebSocketCtor = null; } }
  }
  const cfgPath = opts.configPath || process.env.QFR_LEA_BRIDGE_CFG || BRIDGE_CFG_PATH;
  let cfg = null; // { svcUser, svcPass, mcUrl }
  let cfgTried = false;
  function loadCfg() {
    if (cfgTried) return cfg;
    cfgTried = true;
    const envUser = process.env.QFR_LEA_SVC_USER;
    const envPass = process.env.QFR_LEA_SVC_PASS;
    const envUrl = process.env.QFR_LEA_MC_URL;
    if (envUser && envPass) {
      cfg = { svcUser: envUser, svcPass: envPass, mcUrl: envUrl || 'wss://127.0.0.1:8443' };
      return cfg;
    }
    try {
      const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      if (raw && raw.svcUser && raw.svcPass && raw.mcUrl) cfg = raw;
    } catch (e) { cfg = null; }
    if (!cfg) log({ ev: 'lea-channel-no-config', msg: 'no service-account config; LEA dispatch unavailable until deployed' });
    return cfg;
  }

  const svc = {
    ws: null, ready: false, connecting: false, seq: 0,
    pending: new Map(), waiters: [], failStreak: 0, downSince: 0,
    nextAttemptAt: 0, reconnectTimer: null, pendingReason: '',
  };

  function scheduleReconnect(reason) {
    const auth = /noauth|auth-failed|bad-credential/.test(String(reason || ''));
    const cap = auth ? SVC_BACKOFF_AUTH_MAX_MS : SVC_BACKOFF_MAX_MS;
    svc.failStreak += 1;
    const delay = Math.round(Math.min(SVC_BACKOFF_MIN_MS * Math.pow(2, Math.min(svc.failStreak - 1, 6)), cap) * (0.8 + Math.random() * 0.4));
    svc.nextAttemptAt = Date.now() + delay;
    if (svc.failStreak === 1) log({ ev: 'lea-channel-down', reason: String(reason || 'svc-down'), retryInMs: delay });
    if (!svc.reconnectTimer) {
      svc.reconnectTimer = setTimeout(() => { svc.reconnectTimer = null; svcConnect(); }, delay);
      if (svc.reconnectTimer && svc.reconnectTimer.unref) svc.reconnectTimer.unref();
    }
  }
  function notifyReady() {
    const w = svc.waiters.splice(0);
    for (const cb of w) { try { cb(); } catch (e) {} }
  }
  function svcConnect() {
    const c = loadCfg();
    if (!c) return;
    if (svc.ws || svc.connecting) return;
    if (!WebSocketCtor) { log({ ev: 'lea-channel-no-ws', msg: 'ws module unavailable' }); return; }
    if (Date.now() < svc.nextAttemptAt) {
      if (!svc.reconnectTimer) {
        svc.reconnectTimer = setTimeout(() => { svc.reconnectTimer = null; svcConnect(); }, Math.max(50, svc.nextAttemptAt - Date.now()));
        if (svc.reconnectTimer && svc.reconnectTimer.unref) svc.reconnectTimer.unref();
      }
      return;
    }
    svc.connecting = true;
    const xauth = Buffer.from(c.svcUser).toString('base64') + ',' + Buffer.from(c.svcPass).toString('base64');
    let ws;
    try {
      ws = new WebSocketCtor(String(c.mcUrl).replace(/\/$/, '') + '/control.ashx',
        { rejectUnauthorized: false, headers: { 'x-meshauth': xauth, Origin: 'https://127.0.0.1:8443' } });
    } catch (e) {
      svc.connecting = false;
      scheduleReconnect('svc-construct-failed');
      return;
    }
    svc.ws = ws;
    const handshakeTimer = setTimeout(() => {
      if (svc.ready) return;
      svc.pendingReason = 'svc-handshake-timeout';
      try { ws.close(); } catch (e) {}
    }, SVC_HANDSHAKE_MS);
    if (handshakeTimer && handshakeTimer.unref) handshakeTimer.unref();
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch (e) { return; }
      if (m && m.action === 'close') {
        const cause = String(m.cause || '') + (m.msg ? '/' + String(m.msg) : '');
        log({ ev: 'lea-channel-rejected', cause });
        svc.pendingReason = /noauth/.test(cause) ? 'noauth' : 'auth-failed';
        try { ws.close(); } catch (e) {}
        return;
      }
      if (m && m.action === 'userinfo') {
        const wasDown = svc.downSince;
        svc.ready = true; svc.connecting = false;
        svc.failStreak = 0; svc.downSince = 0; svc.nextAttemptAt = 0; svc.pendingReason = '';
        clearTimeout(handshakeTimer);
        log({ ev: 'lea-channel-ready', resumedAfterMs: wasDown ? Date.now() - wasDown : 0 });
        notifyReady();
        return;
      }
      if (m && m.responseid && svc.pending.has(m.responseid)) {
        const p = svc.pending.get(m.responseid);
        if (m.action === p.action || typeof m.result === 'string' || m.action === 'nodes') {
          svc.pending.delete(m.responseid);
          clearTimeout(p.timer);
          p.resolve(m);
        }
      }
    });
    ws.on('close', () => {
      clearTimeout(handshakeTimer);
      const reason = svc.pendingReason || (svc.ready ? 'svc-closed' : 'svc-closed-unready');
      svc.pendingReason = '';
      svc.ws = null; svc.connecting = false; svc.ready = false;
      for (const [, p] of svc.pending) { clearTimeout(p.timer); p.reject(new Error('svc-down')); }
      svc.pending.clear();
      scheduleReconnect(reason);
    });
    ws.on('error', () => { try { ws.close(); } catch (e) {} });
  }
  function svcEnsure(timeoutMs) {
    if (svc.ready && svc.ws) return Promise.resolve();
    const waitMs = Math.max(0, Math.min(timeoutMs == null ? SVC_WAIT_MS : timeoutMs, SVC_WAIT_MS));
    svcConnect();
    if (!waitMs) return Promise.reject(new Error('svc-down'));
    return new Promise((resolve, reject) => {
      const cb = () => { clearTimeout(t); resolve(); };
      const t = setTimeout(() => {
        const i = svc.waiters.indexOf(cb);
        if (i >= 0) svc.waiters.splice(i, 1);
        reject(new Error('svc-down'));
      }, waitMs);
      svc.waiters.push(cb);
    });
  }
  async function svcCall(obj, timeoutMs) {
    await svcEnsure(SVC_WAIT_MS);
    if (!svc.ws || !svc.ready) throw new Error('svc-down');
    const rid = 'lea-' + (++svc.seq) + '-' + crypto.randomBytes(3).toString('hex');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { svc.pending.delete(rid); reject(new Error('svc-timeout')); }, timeoutMs || 15000);
      svc.pending.set(rid, { resolve, reject, timer, action: obj.action });
      try { svc.ws.send(JSON.stringify(Object.assign({}, obj, { responseid: rid }))); }
      catch (e) { svc.pending.delete(rid); clearTimeout(timer); reject(new Error('svc-down')); }
    });
  }

  // 下发单条命令（与 lock-bridge.runCommand 同款形态）。
  async function runCommand(nodeId, cmd, timeoutMs) {
    const r = await svcCall({ action: 'runcommands', nodeids: [nodeId], type: 0, cmds: cmd, reply: true, runAsUser: 0 },
      timeoutMs || DEFAULT_RUN_TIMEOUT_MS);
    return (r && typeof r.result === 'string') ? r.result : '';
  }
  // 节点清单：供设备在线判定（conn 位）与 status 接口使用。
  async function listNodes(timeoutMs) {
    const r = await svcCall({ action: 'nodes' }, timeoutMs || 5000);
    if (!r || !r.nodes) return [];
    let arr = Array.isArray(r.nodes) ? r.nodes : Object.values(r.nodes);
    if (arr.some((v) => Array.isArray(v))) {
      const flat = [];
      for (const v of arr) { if (Array.isArray(v)) flat.push(...v); else if (v) flat.push(v); }
      arr = flat;
    }
    return arr;
  }
  async function nodeOnline(nodeId, timeoutMs) {
    try {
      const nodes = await listNodes(timeoutMs);
      const n = nodes.find((x) => x && (x._id === nodeId || x.nodeid === nodeId));
      if (!n) return false;
      // MeshCentral nodes 回包 conn 位：&1 = agent 在线（与 presence 判定同款）。
      if (typeof n.conn === 'number') return (n.conn & 1) === 1;
      return true; // 无 conn 字段时只认「在清单里」，不谎称离线
    } catch (e) { return null; } // 通道不可达 → 未知（调用方 fail-closed）
  }
  function status() {
    return { configured: !!loadCfg(), ready: !!(svc.ready && svc.ws), failStreak: svc.failStreak };
  }

  return { runCommand, listNodes, nodeOnline, status, svcCall, _test: { svc, loadCfg } };
}

module.exports = { createLeaChannel };
