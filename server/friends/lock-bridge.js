'use strict';
/*
 * QFRemote 隐私锁桥（契约 CONTRACT.md / line-b-shell-seam.md）
 * 挂在 friends 服务(8445) 内，新增 /lock/* 路由，不改好友/聊天既有行为。
 *
 * 鉴权：与好友同一套——优先 qfr_frd 会话；否则用 MeshCentral 的 xid 会话 cookie
 *       经 control 通道校验（强度等同好友 SSO；本桥不签发 qfr_frd 会话）。
 *       注意：站长账号被好友侧的 GUARD 名单挡在门外，但隐私锁的机主恰恰是站长，
 *       所以本桥的 xid 校验不套用好友的 GUARD/管理员拒绝规则，改由逐设备机主核对把关。
 * 机主：请求账号 == 组件 status.json 里登记的 ownerUsername（大小写不敏感），
 *       只认这一条（status 读不到即判非机主，写操作本来也要求先读到 status）。
 * 投递：调度 Ed25519 签名信封 → 经投递服务账号 qf-locksvc 的 control 通道
 *       用 runcommands 把信封写进设备 inbox → 触发 qf-lockctl apply →
 *       轮询 status.json 对账（30 秒超时）。status 读取同样走 runcommands+Base64 回传。
 *       （本机部署的 meshrelay 文件通道实测无法配对，证据见交接记录；
 *         信封格式/签名/对账语义与契约完全一致，仅字节搬运通道不同。）
 */
const fs = require('fs');
const crypto = require('crypto');
let WebSocket;
try { WebSocket = require('/opt/meshcentral/node_modules/ws'); } catch (e) { WebSocket = require('ws'); }
const envelope = require('./lock-envelope');

const ERR = {
  login: '请先登录。',
  notOwner: '仅设备所有者可管理这台电脑的隐私锁。',
  unreachable: '暂时无法连接这台电脑，请确认设备在线后重试。',
  alreadyLocked: '这台电脑已处于锁定状态。',
  alreadyOff: '隐私锁尚未开启。',
  fault: '这台电脑的隐私锁出现异常，请在本机处理或联系管理员。',
  noDevice: '未找到这台设备。',
  badPw: '密码长度须为 4 至 64 位。',
  badLoginPw: '登录密码不正确，请检查后重试。',
  rejected: '这台电脑拒绝了本次操作，请稍后重试。',
  notReady: '隐私锁服务尚未就绪，请稍后重试。',
  badReq: '请求内容不正确，请重试。',
  badUpdate: '更新参数不正确（版本号/下载地址/文件指纹）。',
  notNewer: '目标版本不比这台电脑现在的组件版本高。',
  componentOld: '这台电脑的锁组件版本太旧，不支持远程更新，请先人工升级组件。',
  updateTimeout: '更新超时：这台电脑还没回报新版本号，请稍后查看组件版本确认结果。',
};
const RECONCILE_MS = 30000;
const UPDATE_RECONCILE_MS = 240000; // 下载+替换+重启服务+回滚余量
const STATUS_TTL_MS = 10000;

function eqFold(a, b) { return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase(); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/* ---------- lastEvents 对账读取（组件实际键 ev/ts 为准，兼容旧 type/time） ---------- */
// 组件 Go 侧审计事件写 {ts, ev, fields}（privacy-lock-impl audit.go 的 AuditEvent）；
// 桥旧代码按 {time, type} 读，导致 arm/disarm/reset 的拒绝事件对账读不到
// （线 B 报告 §8）。统一先归一化：以 ev/ts 为准、缺失时回落 type/time，并把
// 两套键都补齐，这样既有 pred（读 ev.time）与新代码（读 ev.ev/ev.ts）都成立。
function eventName(ev) { return ev ? (ev.ev || ev.type) : undefined; }
function eventTime(ev) { return ev ? (ev.ts || ev.time) : undefined; }
function normalizeEvent(ev) {
  if (!ev || typeof ev !== 'object') return ev;
  const name = eventName(ev);
  const time = eventTime(ev);
  if (ev.ev === name && ev.type === name && ev.ts === time && ev.time === time) return ev;
  return Object.assign({}, ev, { ev: name, type: name, ts: time, time: time });
}
function findRejectedEvent(status, envId) {
  if (!status || !Array.isArray(status.lastEvents)) return null;
  for (const raw of status.lastEvents) {
    const ev = normalizeEvent(raw);
    if (ev && ev.type === 'envelope-rejected' && ev.fields && ev.fields.id === envId) return ev.fields.reason || '';
  }
  return null;
}
function hasEvent(status, type, pred) {
  if (!status || !Array.isArray(status.lastEvents)) return false;
  return status.lastEvents.some((raw) => { const ev = normalizeEvent(raw); return ev && ev.type === type && pred(ev); });
}

function createLockBridge(deps) {
  const cfg = deps.cfg;
  const log = typeof deps.log === 'function' ? deps.log : function () {};
  let bridgeCfg = null;
  let dispatcherKey = null;
  try {
    bridgeCfg = JSON.parse(fs.readFileSync(deps.bridgeCfgPath || '/opt/qfremote-lock/bridge-config.json', 'utf8'));
    dispatcherKey = envelope.loadDispatcherKey(fs.readFileSync(bridgeCfg.keyFile, 'utf8'));
  } catch (e) {
    log('lock', '桥配置/调度密钥加载失败，/lock 暂不可用：' + e.message);
    bridgeCfg = null;
  }

  /* ---------- 投递服务账号的 control 通道（持久连接，断线重连） ---------- */
  const svc = { ws: null, ready: false, pending: new Map(), seq: 0, waiters: [] };
  let nodeCache = { at: 0, nodes: [] };

  function svcNotifyReady() {
    const w = svc.waiters.splice(0);
    for (const fn of w) { try { fn(); } catch (e) {} }
  }
  function svcConnect() {
    if (svc.ws) return;
    const xauth = Buffer.from(bridgeCfg.svcUser).toString('base64') + ',' + Buffer.from(bridgeCfg.svcPass).toString('base64');
    let ws;
    try {
      ws = new WebSocket(bridgeCfg.mcUrl + '/control.ashx', { rejectUnauthorized: false, headers: { 'x-meshauth': xauth, Origin: 'https://127.0.0.1:8443' } });
    } catch (e) { setTimeout(svcConnect, 3000); return; }
    svc.ws = ws;
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch (e) { return; }
      if (m.action === 'userinfo') { svc.ready = true; svcNotifyReady(); }
      if (m.action === 'nodes') updateNodeCache(m.nodes);
      if (m.responseid && svc.pending.has(m.responseid)) {
        const p = svc.pending.get(m.responseid);
        if (m.action === p.action || typeof m.result === 'string' || m.action === 'nodes' || m.action === 'users') {
          svc.pending.delete(m.responseid);
          clearTimeout(p.timer);
          p.resolve(m);
        }
      }
    });
    ws.on('close', () => {
      svc.ws = null; svc.ready = false;
      for (const [, p] of svc.pending) { clearTimeout(p.timer); p.reject(new Error('svc-down')); }
      svc.pending.clear();
      setTimeout(svcConnect, 3000);
    });
    ws.on('error', () => { try { ws.close(); } catch (e) {} });
  }
  function svcEnsure(timeoutMs) {
    if (svc.ready && svc.ws) return Promise.resolve();
    svcConnect();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('svc-down')), timeoutMs || 6000);
      svc.waiters.push(() => { clearTimeout(t); resolve(); });
    });
  }
  async function svcCall(obj, timeoutMs) {
    await svcEnsure(6000);
    const rid = 'lb-' + (++svc.seq) + '-' + crypto.randomBytes(3).toString('hex');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { svc.pending.delete(rid); reject(new Error('svc-timeout')); }, timeoutMs || 15000);
      svc.pending.set(rid, { resolve, reject, timer, action: obj.action });
      try { svc.ws.send(JSON.stringify(Object.assign({}, obj, { responseid: rid }))); }
      catch (e) { svc.pending.delete(rid); clearTimeout(timer); reject(new Error('svc-down')); }
    });
  }

  function updateNodeCache(nodes) {
    if (!nodes) return;
    let arr = Array.isArray(nodes) ? nodes : Object.values(nodes);
    if (arr.some((v) => Array.isArray(v))) { // 服务器按设备组分组下发 { meshid: [node,...] }，摊平
      const flat = [];
      for (const v of arr) { if (Array.isArray(v)) flat.push(...v); else if (v) flat.push(v); }
      arr = flat;
    }
    if (arr.length || nodeCache.nodes.length === 0) nodeCache = { at: Date.now(), nodes: arr };
  }
  async function listNodes() {
    try {
      const r = await svcCall({ action: 'nodes' }, 10000);
      if (r && r.nodes) { updateNodeCache(r.nodes); return nodeCache.nodes; }
    } catch (e) { /* 用缓存兜底 */ }
    return nodeCache.nodes;
  }
  // 注：机主判定只认组件 status.json 的登记名（见 isOwner），不查 users 列表——
  // qf-locksvc 保持 siteadmin=0 最小权限，'users' 命令对它本就返回空。

  /* ---------- 设备 status 读取 / 信封投递（runcommands 通道） ---------- */
  const statusCache = new Map();
  const PS_READ_STATUS = 'powershell -NoProfile -NonInteractive -Command "[Console]::Out.Write([Convert]::ToBase64String([IO.File]::ReadAllBytes(\'C:\\ProgramData\\QFRemote\\Lock\\status.json\')))"';
  function psWriteInbox(fileName, b64) {
    return 'powershell -NoProfile -NonInteractive -Command "[IO.File]::WriteAllBytes(\'C:\\ProgramData\\QFRemote\\Lock\\inbox\\' + fileName + '\',[Convert]::FromBase64String(\'' + b64 + '\'))"';
  }
  const CMD_APPLY = '"C:\\Program Files\\QFRemote\\Lock\\qf-lockctl.exe" apply';

  async function runCommand(nodeId, cmd) {
    // 与 meshctrl 完全同款：cmds 是单个字符串，且必须带 reply:true 服务器才回传输出
    const r = await svcCall({ action: 'runcommands', nodeids: [nodeId], type: 0, cmds: cmd, reply: true, runAsUser: 0 }, 20000);
    return (r && typeof r.result === 'string') ? r.result : '';
  }
  async function readStatus(nodeId, fresh) {
    const c = statusCache.get(nodeId);
    if (!fresh && c && (Date.now() - c.at) < STATUS_TTL_MS) return c.status;
    let status = null;
    try {
      const out = await runCommand(nodeId, PS_READ_STATUS);
      const m = out.replace(/\s+/g, '').match(/[A-Za-z0-9+/=]{80,}/);
      if (m) {
        const parsed = JSON.parse(Buffer.from(m[0], 'base64').toString('utf8'));
        if (parsed && typeof parsed.state === 'string') status = parsed;
      }
    } catch (e) { status = null; }
    statusCache.set(nodeId, { at: Date.now(), status });
    return status;
  }
  async function deliverEnvelope(nodeId, env) {
    const b64 = Buffer.from(JSON.stringify(env), 'utf8').toString('base64');
    await runCommand(nodeId, psWriteInbox(env.id + '.json', b64));
    try { await runCommand(nodeId, CMD_APPLY); } catch (e) { /* 组件有 inbox 轮询兜底 */ }
  }

  // findRejectedEvent / hasEvent 已提到模块作用域（对账读取统一归一化 ev/ts，见文件上方）。

  /* ---------- 鉴权 ---------- */
  const xidCache = new Map();
  function parseCookies(req) {
    const out = {};
    const raw = (req.headers && req.headers.cookie) || '';
    for (const part of raw.split(';')) {
      const i = part.indexOf('=');
      if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
    }
    return out;
  }
  async function authUser(req) {
    try {
      const s = deps.sessionUser(req);
      if (s) return s;
    } catch (e) {}
    const cookies = parseCookies(req);
    if (!cookies.xid) return null;
    const cookieHeader = req.headers.cookie || '';
    const key = crypto.createHash('sha256').update(cookieHeader).digest('hex');
    const cached = xidCache.get(key);
    if (cached && (Date.now() - cached.at) < 30000) return cached.user;
    try {
      const sess = await deps.mcConnectCookie(cfg, cookieHeader);
      if (!sess || !sess.userinfo || !sess.userinfo._id) return null;
      let uid = String(sess.userinfo._id);
      const parts = uid.split('/');
      if (parts.length === 3 && parts[0] === 'user') uid = parts[2];
      uid = uid.toLowerCase();
      try { if (sess.ws) sess.ws.close(); } catch (e) {}
      xidCache.set(key, { user: uid, at: Date.now() });
      return uid;
    } catch (e) { return null; }
  }

  /* ---------- 机主判定 ---------- */
  // 只认组件登记机主：status.json 的 ownerUsername 与请求账号大小写不敏感相等。
  // status 读不到或没登记名 → 一律判非机主（保守；写操作本来也要求先读到 status）。
  function isOwner(me, node, status) {
    return !!(status && status.ownerUsername && eqFold(status.ownerUsername, me));
  }

  /* ---------- HTTP 小工具 ---------- */
  function sendJson(res, code, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  }
  function fail(res, code, text) { sendJson(res, code, { error: text }); }
  function readJsonBody(req) {
    return new Promise((resolve) => {
      let data = '';
      req.on('data', (c) => { data += c; if (data.length > 65536) { try { req.destroy(); } catch (e) {} resolve(null); } });
      req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch (e) { resolve(null); } });
      req.on('error', () => resolve(null));
    });
  }

  async function getDeviceOrFail(res, id, me) {
    const nodes = await listNodes();
    const node = nodes.find((n) => n && n._id === id);
    if (!node) { fail(res, 404, ERR.noDevice); return null; }
    const status = await readStatus(node._id, true);
    if (!isOwner(me, node, status)) { fail(res, 403, ERR.notOwner); return null; }
    return { node, status };
  }

  async function reconcile(nodeId, env, checkFn) {
    const deadline = Date.now() + RECONCILE_MS;
    while (Date.now() < deadline) {
      await sleep(2000);
      const st = await readStatus(nodeId, true);
      if (!st) continue;
      const rej = findRejectedEvent(st, env.id);
      if (rej != null) return { ok: false, reason: rej };
      if (checkFn(st)) return { ok: true };
    }
    return { ok: false, reason: 'timeout' };
  }

  // update 专用对账：周期更长（下载+停启服务），对账凭据只有一个——
  // status.json 的 version 变成目标版本。组件拒绝（含旧组件的
  // unknown-op / bad-signature）从 lastEvents 里读：事件名键兼容
  // 组件 Go 侧的 `ev` 与桥旧代码用的 `type` 两种形态。
  async function reconcileUpdate(nodeId, env, targetVersion) {
    const deadline = Date.now() + UPDATE_RECONCILE_MS;
    while (Date.now() < deadline) {
      await sleep(3000);
      const st = await readStatus(nodeId, true);
      if (!st) continue;
      if (Array.isArray(st.lastEvents)) {
        for (const raw of st.lastEvents) {
          const ev = normalizeEvent(raw);
          if (!ev || !ev.fields || ev.fields.id !== env.id) continue;
          const name = ev.type;
          if (name === 'envelope-rejected') return { ok: false, reason: ev.fields.reason || '' };
          if (name === 'update-rejected' || name === 'update-launch-failed') {
            return { ok: false, reason: ev.fields.reason || name };
          }
        }
      }
      if (st.version === targetVersion) return { ok: true };
    }
    return { ok: false, reason: 'timeout' };
  }

  /* ---------- 路由 ---------- */
  async function handle(req, res) {
    const u = new URL(req.url, 'http://x');
    const p = u.pathname;
    if (!bridgeCfg) { fail(res, 503, ERR.notReady); return true; }
    const me = await authUser(req);
    if (!me) { fail(res, 401, ERR.login); return true; }
    try {
      if (req.method === 'GET' && p === '/lock/devices') {
        const nodes = await listNodes();
        const devices = [];
        for (const node of nodes) {
          if (!node || !node._id) continue;
          const status = await readStatus(node._id, false);
          if (!isOwner(me, node, status)) continue;
          devices.push({
            id: node._id,
            name: node.name || '',
            owner: true,
            locked: status ? status.state === 'Locked' : false,
            component: !!status,
            version: status ? (status.version || null) : null,
          });
        }
        sendJson(res, 200, { devices });
        return true;
      }
      if (req.method === 'POST' && (p === '/lock/enable' || p === '/lock/disable' || p === '/lock/reset' || p === '/lock/update')) {
        const body = await readJsonBody(req);
        if (!body || typeof body.id !== 'string') { fail(res, 400, ERR.badReq); return true; }
        const got = await getDeviceOrFail(res, body.id, me);
        if (!got) return true;
        const { node, status } = got;
        if (!status) { fail(res, 503, ERR.unreachable); return true; }
        if (status.state === 'Fault') { fail(res, 409, ERR.fault); return true; }

        if (p === '/lock/enable') {
          if (typeof body.password !== 'string' || body.password.length < 4 || body.password.length > 64) { fail(res, 400, ERR.badPw); return true; }
          if (status.state === 'Locked') { fail(res, 409, ERR.alreadyLocked); return true; }
          if (!status.devicePublicKey) { fail(res, 409, ERR.fault); return true; }
          const env = envelope.buildEnvelope(dispatcherKey, { op: 'arm', nodeId: node._id, by: me, password: body.password, devicePublicKeyPem: status.devicePublicKey });
          await deliverEnvelope(node._id, env);
          const r = await reconcile(node._id, env, (st) => st.state === 'Locked' && hasEvent(st, 'arm', (ev) => ev.fields && ev.fields.armId === env.id));
          if (!r.ok) { fail(res, r.reason === 'timeout' ? 504 : 409, r.reason === 'timeout' ? ERR.unreachable : ERR.rejected); return true; }
          log('lock', 'arm 成功：' + node.name + ' by ' + me);
          sendJson(res, 200, { ok: true });
          return true;
        }
        if (p === '/lock/disable') {
          if (status.state !== 'Locked') { fail(res, 409, ERR.alreadyOff); return true; }
          const env = envelope.buildEnvelope(dispatcherKey, { op: 'disarm', nodeId: node._id, by: me });
          await deliverEnvelope(node._id, env);
          const since = Date.parse(env.issuedAt) - 5000;
          const r = await reconcile(node._id, env, (st) => st.state === 'Off' && hasEvent(st, 'disarm', (ev) => !ev.time || Date.parse(ev.time) >= since));
          if (!r.ok) { fail(res, r.reason === 'timeout' ? 504 : 409, r.reason === 'timeout' ? ERR.unreachable : ERR.rejected); return true; }
          log('lock', 'disarm 成功：' + node.name + ' by ' + me);
          sendJson(res, 200, { ok: true });
          return true;
        }
        if (p === '/lock/update') {
          // 组件签名自更新（2.0.3 起）：信封带 {version,url,sha256}，
          // 组件端还会再验版本门/白名单/下载指纹，这里只做快速预检。
          const u = body.update || body;
          if (typeof u.version !== 'string' || typeof u.url !== 'string' ||
              typeof u.sha256 !== 'string' || !/^[0-9a-fA-F]{64}$/.test(u.sha256) ||
              !envelope.allowedUpdateUrl(u.url)) { fail(res, 400, ERR.badUpdate); return true; }
          if (!status.version) { fail(res, 409, ERR.notReady); return true; }
          const cmp = envelope.compareVersions(u.version, status.version);
          if (cmp === null) { fail(res, 400, ERR.badUpdate); return true; }
          if (cmp <= 0) { fail(res, 409, ERR.notNewer); return true; }
          const env = envelope.buildEnvelope(dispatcherKey, { op: 'update', nodeId: node._id, by: me, update: { version: u.version, url: u.url, sha256: u.sha256 } });
          await deliverEnvelope(node._id, env);
          const r = await reconcileUpdate(node._id, env, u.version);
          if (!r.ok) {
            if (r.reason === 'unknown-op' || r.reason === 'bad-signature') { fail(res, 409, ERR.componentOld); return true; }
            if (r.reason === 'timeout') { fail(res, 504, ERR.updateTimeout); return true; }
            fail(res, 409, ERR.rejected); return true;
          }
          log('lock', 'update 成功：' + node.name + ' -> ' + u.version + ' by ' + me);
          sendJson(res, 200, { ok: true, version: u.version });
          return true;
        }
        // /lock/reset（恢复路径一：验登录密码后远程重置一次性密码，契约第 6 节）
        if (typeof body.loginPassword !== 'string' || !body.loginPassword) { fail(res, 400, ERR.badReq); return true; }
        if (typeof body.newPassword !== 'string' || body.newPassword.length < 4 || body.newPassword.length > 64) { fail(res, 400, ERR.badPw); return true; }
        if (status.state !== 'Locked') { fail(res, 409, ERR.alreadyOff); return true; }
        let verified = false;
        try {
          const sess = await deps.mcConnect(cfg, me, body.loginPassword);
          verified = true;
          try { if (sess && sess.ws) sess.ws.close(); } catch (e) {}
        } catch (e) { verified = false; }
        if (!verified) { fail(res, 403, ERR.badLoginPw); return true; }
        if (!status.devicePublicKey) { fail(res, 409, ERR.fault); return true; }
        const env = envelope.buildEnvelope(dispatcherKey, { op: 'reset', nodeId: node._id, by: me, password: body.newPassword, devicePublicKeyPem: status.devicePublicKey });
        await deliverEnvelope(node._id, env);
        const r = await reconcile(node._id, env, (st) => st.state === 'Locked' && hasEvent(st, 'remote-reset', (ev) => ev.fields && ev.fields.id === env.id));
        if (!r.ok) { fail(res, r.reason === 'timeout' ? 504 : 409, r.reason === 'timeout' ? ERR.unreachable : ERR.rejected); return true; }
        log('lock', 'remote-reset 成功：' + node.name + ' by ' + me);
        sendJson(res, 200, { ok: true });
        return true;
      }
      fail(res, 404, '接口不存在。');
      return true;
    } catch (e) {
      log('lock', '处理异常：' + (e && e.message));
      if (!res.headersSent) fail(res, 503, ERR.unreachable);
      return true;
    }
  }

  if (bridgeCfg) svcConnect();
  return { handle };
}

module.exports = { createLockBridge, _test: { eventName, eventTime, normalizeEvent, findRejectedEvent, hasEvent } };
