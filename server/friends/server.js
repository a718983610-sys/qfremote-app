'use strict';
/*
 * QFRemote 好友服务（一期：好友关系＋设备共享编排，2026-10-24）
 * ================================================================
 * 定位（方案正本 ../friends-plan.md）：
 *  - 远控场景里好友的核心价值是「把我的设备组共享给好友远程协助」，
 *    流程按申请/同意制：加好友 → 组主单独选档共享 → 对方登录控制台即
 *    可见可用；取消共享/删好友/对方被冻结封禁，共享自动回收。
 *  - 关系与流程在本服务（自建小服务，与 register-svc 同款形态：独立
 *    Node 服务＋自己的状态文件＋systemd 单元＋独立 HTTPS 端口 8445）；
 *    权限执行全部走 MeshCentral 官方控制通道（addmeshuser），绝不直写
 *    MeshCentral 数据库。
 *  - 执行账号 qf-socialsvc：站点权只有「管理用户」一位（siteadmin=2），
 *    在用户登录好友页时被组主本人加进其设备组、只给组权 2
 *    （MANAGEUSERS 一位，不能看桌面、不能操作设备），此后由它执行
 *    授予/回收并全程记台账。它与站长号、qf-regsvc 同级保护：本服务
 *    写死拒绝以它们为操作者或操作目标（GUARD 名单）。
 *  - 登录：好友页用同一账号＋密码登录一次；服务以用户自己的凭据开
 *    控制通道验密（收到服务器下发的 userinfo 才算验真，基准见
 *    ../social-svc/chat/DESIGN.md 第三节），验过发自家会话令牌；
 *    密码只过内存，不落盘、不进日志。
 *  - 共享档位（permissions-plan.md）：只看 B=12584712（默认）／
 *    可操作 B2=12584456；全权 A 不开放给好友。授予/回收以服务端
 *    addmeshuser 的回执为准（源码实查：调用方须持组内 MANAGEUSERS
 *    位；B/B2 两档不含该位、不受「不得超过自己」的裁剪；非组管理员
 *    改不动组管理员的权限，组主天然安全）。
 *  - 防骚扰（adopt QFClash B-31，定性为保护被打扰方）：搜索限频
 *    30 次/小时＋落流水；申请日限 20 条；普通拒绝→申请人对该对象
 *    30 天冷却；拒绝时勾「不再接收」→永久方向性拦截；删好友→双方
 *    互得 30 天冷却。拦截只拦「被拦方→拦截方」这一个方向。
 *  - 封禁联动：服务每 60 秒以执行账号走官方 users 命令对账——被授予
 *    方账号消失（删号/封号）或被冻结（siteadmin 带 LOCKED 32 位）
 *    即回收授予给他的全部共享；账号消失者其好友关系/申请一并清掉。
 *    解冻不自动恢复共享（须组主重新发起，安全优先）。
 *  - 好友关系正本在本服务；每次变更同步导出 data/friends.json
 *    （{pairs:[[a,b],...]}），供二期聊天的好友闸口（friends-gate.js）
 *    读取——合并契约见 ../social-svc/README.md。
 *
 * 配置（QFFRD_CONFIG，默认 /opt/qfremote-friends/config.json）：
 *  { port, bind, tlsKey, tlsCert, svcUser, svcPass,
 *    mcUrl, stateFile, logFile, sharesLogFile, friendsFile }
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { createChatHandler, verifyMeshCentralPassword } = require('./chat/chat-server');
const { createLockBridge } = require('./lock-bridge');

const CONFIG_PATH = process.env.QFFRD_CONFIG || '/opt/qfremote-friends/config.json';
let _WebSocket = null;
function loadWebSocket() {
  if (_WebSocket) return _WebSocket;
  _WebSocket = require('ws'); // M-025: service-owned dependency, independent of MeshCentral upgrades
  return _WebSocket;
}

// ---------- 常量与口径 ----------
const RIGHTS_VIEW = 12584712;      // 模板 B 只看
const RIGHTS_OPERATE = 12584456;   // 模板 B2 可操作
const RIGHTS_SVC_IN_GROUP = 2;     // 执行账号在用户组里的组权（MANAGEUSERS）
const RIGHTS_GROUP_ADMIN = 4294967295;
const SITEADMIN_FULL = 4294967295;
const SITEADMIN_LOCKED_BIT = 32;   // SITERIGHT_LOCKED（mcdb freeze 的原生锁定）
const SESSION_TTL_MS = 12 * 3600 * 1000;
const REMEMBER_TTL_MS = 30 * 24 * 3600 * 1000; // 「记住此设备」：30 天
const SEARCH_LIMIT_PER_HOUR = 30;
const REQUEST_LIMIT_PER_DAY = 20;
const COOLDOWN_MS = 30 * 86400000;
const GUARD = new Set(['qf-regsvc', 'qf-socialsvc', 'qf-locksvc', 'qf-support', 'qf-official', 'admin', 'administrator', 'root', 'system']); // 具名系统账号集合：只挡自动化持有凭据的系统/服务人格与保留名；站长本人不在内（限制不约束本人，2026-10-26 修复：原名单字面含站长号、又漏了 qf-locksvc/qf-official）
function isGuardName(name) { return GUARD.has(String(name || '').toLowerCase()); }
// 冻结判定（与 ext 正本同口径，见 qfremote-ext/server.js 冻结谓词）：冻结＝
// siteadmin 带 LOCKED 32 位，但全权账号（SITEADMIN_FULL）源码豁免锁定、
// 天生冻不住——裸位判会把全权号误判冻结，好友侧各处一律走本谓词。
function isFrozenSiteadmin(siteadmin) { const v = siteadmin || 0; return v !== SITEADMIN_FULL && (v & SITEADMIN_LOCKED_BIT) !== 0; }
const OWNER_ACCOUNT = '718983610'; // 站长本人账号：限制只约束他人、不约束本人（2026-10-25 站长令，好友/聊天校验点对本人放行）
function isOwnerAccount(name) { return String(name || '').toLowerCase() === OWNER_ACCOUNT; }
function tierRights(tier) { return tier === 'operate' ? RIGHTS_OPERATE : RIGHTS_VIEW; }
// pkg3 #3（M-C 中组，DS-REVIEW §3.3）：MC 的 addmeshuser 回包同时含 success 与
// failed（如 {success:1, failed:1}）时，只看 success>0 会把部分失败当全成功
// 记台账。改为：须 success>0 且 failed 为 0/缺失；纯函数，放模块层供单测。
function execOk(res) { return !!(res && typeof res.success === 'number' && res.success > 0 && !res.failed); }
function tierName(rights) { return rights === RIGHTS_OPERATE ? 'operate' : 'view'; }
function norm(name) { return String(name || '').toLowerCase().trim(); }
function userIdOf(name) { return 'user//' + norm(name); }
// 与 mcdb.js / common.js 的 escapeFieldName 完全一致（组 links 的键要这样编码）
function escapeFieldName(name) {
  if ((name.indexOf(',') === -1) && (name.indexOf('%') === -1) && (name.indexOf('.') === -1) && (name.indexOf('$') === -1)) return name;
  return name.split('%').join('%25').split('.').join('%2E').split('$').join('%24').split(',').join('%2C');
}
function linkRights(links, key) {
  if (!links) return null;
  if (links[key] && typeof links[key].rights === 'number') return links[key].rights;
  const esc = escapeFieldName(key);
  if (links[esc] && typeof links[esc].rights === 'number') return links[esc].rights;
  return null;
}

// ---------- 上海时间（申请日限按自然日） ----------
function shanghaiDayKey(now) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
}

// ---------- 好友关系纯逻辑（可单测，见 test-logic.js） ----------
function newState() {
  return { sessions: {}, requests: [], friends: {}, blocks: {}, shares: [], onboarded: {}, searchWindows: {}, requestDays: {} };
}
function areFriends(state, a, b) {
  a = norm(a); b = norm(b);
  return !!(state.friends[a] && state.friends[a][b]);
}
function setFriends(state, a, b, since) {
  a = norm(a); b = norm(b);
  if (!state.friends[a]) state.friends[a] = {};
  if (!state.friends[b]) state.friends[b] = {};
  state.friends[a][b] = since; state.friends[b][a] = since;
}
function unsetFriends(state, a, b) {
  a = norm(a); b = norm(b);
  if (state.friends[a]) delete state.friends[a][b];
  if (state.friends[b]) delete state.friends[b][a];
}
function findRequest(state, from, to) {
  from = norm(from); to = norm(to);
  return state.requests.find(r => r.from === from && r.to === to) || null;
}
// blocks[from][to]：from 被禁止向 to 发申请（方向性拦截）
function getBlock(state, from, to, now) {
  const m = state.blocks[norm(from)];
  if (!m) return null;
  const blk = m[norm(to)];
  if (!blk) return null;
  if (blk.type === 'never') return blk;
  if (blk.type === 'cooldown' && now < blk.until) return blk;
  return null; // 冷却已过，视为无拦截（惰性过期）
}
function setBlock(state, from, to, blk) {
  from = norm(from); to = norm(to);
  if (!state.blocks[from]) state.blocks[from] = {};
  state.blocks[from][to] = blk;
}
// 计划一次申请：只做判定不落盘，返回 {type, ...}
function planRequest(state, from, to, now) {
  from = norm(from); to = norm(to);
  if (from === to) return { type: 'self' };
  if (areFriends(state, from, to)) return { type: 'already-friends' };
  const blk = getBlock(state, from, to, now);
  if (blk) return { type: 'blocked', block: blk };
  const mine = findRequest(state, from, to);
  if (mine) return { type: 'already-pending', request: mine };
  const reverse = findRequest(state, to, from);
  if (reverse) return { type: 'auto-accept', request: reverse };
  return { type: 'create' };
}
// 申请计数（日限）：返回今天已发条数；record=true 时记一笔
function requestQuota(state, user, now, record) {
  user = norm(user);
  const day = shanghaiDayKey(now);
  let rec = state.requestDays[user];
  if (!rec || rec.day !== day) { rec = state.requestDays[user] = { day, count: 0 }; }
  if (record) rec.count += 1;
  return rec.count;
}
// 搜索限频：返回本小时已搜次数；record=true 时记一笔
function searchQuota(state, user, now, record) {
  user = norm(user);
  const win = (state.searchWindows[user] || []).filter(t => now - t < 3600000);
  if (record) win.push(now);
  state.searchWindows[user] = win;
  return win.length;
}
// 删好友后要回收的共享（双向：两人之间全部 active 共享）
function sharesBetween(state, a, b) {
  a = norm(a); b = norm(b);
  return state.shares.filter(s => s.status === 'active' &&
    ((s.owner === a && s.grantee === b) || (s.owner === b && s.grantee === a)));
}
// 导出给聊天闸口的 pairs（无向对，去重排序）
function exportPairs(state) {
  const seen = new Set(); const pairs = [];
  for (const a of Object.keys(state.friends)) {
    for (const b of Object.keys(state.friends[a])) {
      const key = [a, b].sort().join('\n');
      if (!seen.has(key)) { seen.add(key); pairs.push([a, b].sort()); }
    }
  }
  pairs.sort((x, y) => (x[0] + '\n' + x[1]).localeCompare(y[0] + '\n' + y[1]));
  return pairs;
}

// ---------- MeshCentral 控制通道 ----------
// 以给定凭据开一条控制通道连接：认证成功服务器会主动下发 userinfo
// （meshuser.js 源码＋探针实测，见 chat/DESIGN.md 第三节）。收到
// userinfo 才算验真成功；错密码/账号不存在/被锁定都会被直接关连接。
function mcConnect(cfg, user, pass, timeoutMs) {
  return new Promise((resolve, reject) => {
    const WebSocket = loadWebSocket();
    const auth = Buffer.from(user).toString('base64') + ',' + Buffer.from(pass).toString('base64');
    const ws = new WebSocket(cfg.mcUrl || 'wss://127.0.0.1:8443/control.ashx', { rejectUnauthorized: false, headers: { 'x-meshauth': auth } });
    let done = false;
    const timer = setTimeout(() => finish(new Error('mc-connect-timeout')), timeoutMs || 10000);
    function finish(err, sess) { if (done) return; done = true; clearTimeout(timer); if (err) { try { ws.close(); } catch (e) {} reject(err); } else resolve(sess); }
    const sess = { ws, userinfo: null, waiters: [], send(obj) { ws.send(JSON.stringify(obj)); } };
    ws.on('message', (data) => {
      let m; try { m = JSON.parse(data.toString()); } catch (e) { return; }
      if (m && m.action === 'userinfo' && m.userinfo) {
        sess.userinfo = m.userinfo;
        finish(null, sess);
        return;
      }
      for (let i = 0; i < sess.waiters.length; i++) {
        if (sess.waiters[i].match(m)) { const w = sess.waiters.splice(i, 1)[0]; w.resolve(m); return; }
      }
    });
    ws.on('error', () => finish(new Error('mc-conn-error')));
    ws.on('close', () => finish(new Error('mc-auth-failed')));
  });
}
// —— 会话绑 IP 的转发修复（2.3.0 H 线，全服务统一口径）——
// MeshCentral 登录时把客户端 IP 写进 xid 会话（req.session.ip），之后每次
// 校验都拿「本次请求的 clientIp」与它比对（webserver.js 的 checkCookieIp，
// 默认 lax：同 /24 或双方都是私网/回环才算过）。各小服务是替用户拿 xid
// 去开控制通道的，本机 127.0.0.1 与公网登录 IP 既不同 /24、也不全是私网，
// 于是一律被判会话失效——此前所有「SSO 通过」实测都用服务器本机登录
// （登录 IP 也是 127.0.0.1，双方私网命中 lax），是假通过；真用户从家里
// 登录后好友/聊天/积分/隐私锁的免登全断，根因在此、与 close 秒拒无关。
// 修法：xid 的值本身是 Base64 的会话 JSON，里面就带着登录 IP。校验时把
// 它解出来，经 X-Forwarded-For 告诉 MeshCentral（本机在 trustedProxy
// 名单内，它认这个头还原 clientIp）——验的仍是服务器亲签的会话，签名
// 照查、IP 绑定照查，只是把「会话本来绑的 IP」如实带上。解不出时再退
// 请求来源 IP、最后无头原样一试，本机/内网口径不回退。
function sessionIpFromCookie(cookieHeader) {
  try {
    const jar = {};
    String(cookieHeader || '').split(';').forEach((p) => { const i = p.indexOf('='); if (i > 0) jar[p.slice(0, i).trim()] = p.slice(i + 1).trim(); });
    if (!jar.xid) return null;
    const obj = JSON.parse(Buffer.from(String(jar.xid), 'base64').toString('utf8'));
    const ip = obj && obj.ip;
    if (typeof ip === 'string' && ip.length <= 64 && /^[0-9a-fA-F.:%[\]]+$/.test(ip)) return ip;
  } catch (e) { /* 解不出就当没有，走后备候选 */ }
  return null;
}
function mcConnectCookieOnce(cfg, cookieHeader, timeoutMs, fwdIp) {
  return new Promise((resolve, reject) => {
    const WebSocket = loadWebSocket();
    const headers = { Cookie: cookieHeader, Origin: 'https://127.0.0.1:8443' };
    if (fwdIp) headers['X-Forwarded-For'] = fwdIp;
    const ws = new WebSocket(cfg.mcUrl || 'wss://127.0.0.1:8443/control.ashx', { rejectUnauthorized: false, headers });
    let done = false;
    const timer = setTimeout(() => finish(new Error('mc-connect-timeout')), timeoutMs || 10000);
    function finish(err, sess) { if (done) return; done = true; clearTimeout(timer); if (err) { try { ws.close(); } catch (e) {} reject(err); } else resolve(sess); }
    const sess = { ws, userinfo: null, waiters: [], send(obj) { ws.send(JSON.stringify(obj)); } };
    ws.on('message', (data) => {
      let m; try { m = JSON.parse(data.toString()); } catch (e) { return; }
      if (m && m.action === 'userinfo' && m.userinfo) {
        sess.userinfo = m.userinfo;
        finish(null, sess);
        return;
      }
      // 服务器对无效/伪造会话立刻回 action=close（实测 0.06 秒）：认这个信号
      // 秒拒，不再干等超时——这正是「验真超时」现象的根源修复（2026-10-25）。
      if (m && m.action === 'close') { finish(new Error('mc-session-rejected')); return; }
      for (let i = 0; i < sess.waiters.length; i++) {
        if (sess.waiters[i].match(m)) { const w = sess.waiters.splice(i, 1)[0]; w.resolve(m); return; }
      }
    });
    ws.on('error', () => finish(new Error('mc-conn-error')));
    ws.on('close', () => finish(new Error('mc-auth-failed')));
  });
}
// 以控制台网页会话 cookie 开控制通道（单点登录验真用）：浏览器登录控制台后
// 持有的 xid 会话同样被控制通道接受，认证成功一样会主动下发 userinfo；
// cookie 无效/过期则只有 error/close。与密码验真同源同判据，不是后门。
// 候选顺序：会话自带 IP → 调用方给的请求来源 IP（extraIps）→ 无转发原样。
// 被秒拒（close）才换下一个候选；超时不再叠试，免得把等待翻倍。
async function mcConnectCookie(cfg, cookieHeader, timeoutMs, extraIps) {
  const candidates = [];
  const sip = sessionIpFromCookie(cookieHeader);
  if (sip) candidates.push(sip);
  for (const ip of (extraIps || [])) { if (ip && !candidates.includes(ip)) candidates.push(ip); }
  candidates.push(null);
  let lastErr = new Error('mc-auth-failed');
  for (const ip of candidates) {
    try { return await mcConnectCookieOnce(cfg, cookieHeader, timeoutMs, ip); }
    catch (e) { lastErr = e; if (e && e.message === 'mc-connect-timeout') break; }
  }
  throw lastErr;
}
// 在已建立的会话上发一条命令，等回执（addmeshuser 回 responseid，
// users/meshes 回 tag —— 两个字段都设同一个值、任一命中即算回执）
function mcCall(sess, obj, timeoutMs) {
  return new Promise((resolve, reject) => {
    const rid = 'qffrd-' + crypto.randomBytes(6).toString('hex');
    obj.responseid = rid;
    obj.tag = rid;
    const w = { match: (m) => m && (m.responseid === rid || m.tag === rid), resolve: null };
    const timer = setTimeout(() => {
      const i = sess.waiters.indexOf(w);
      if (i >= 0) sess.waiters.splice(i, 1);
      reject(new Error('mc-call-timeout:' + obj.action));
    }, timeoutMs || 10000);
    w.resolve = (m) => { clearTimeout(timer); resolve(m); };
    sess.waiters.push(w);
    sess.send(obj);
  });
}
async function mcWith(cfg, user, pass, fn) {
  const sess = await mcConnect(cfg, user, pass);
  try { return await fn(sess); } finally { try { sess.ws.close(); } catch (e) {} }
}
// 以服务账号身份执行一条命令
function svcCall(cfg, obj) { return mcWith(cfg, cfg.svcUser, cfg.svcPass, (sess) => mcCall(sess, obj)); }

// ---------- 主服务 ----------
function main() {
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const PAGE = fs.readFileSync(path.join(__dirname, 'friends.html'), 'utf8');
  // 网页同框包装页（2.3.0 M2 线）：直连源控制台受上游 CSP 限制
  // （frame-src/connect-src 只许同源），包装页改由本服务（8445，同主机
  // 无此限制）托管一份，与控制台皮肤里的正本同文（部署时一并同步）。
  let WRAP_PAGE = null;
  try { WRAP_PAGE = fs.readFileSync(path.join(__dirname, 'qf-wrap.html'), 'utf8'); } catch (e) { /* 缺文件时该路由 404，不拦主服务 */ }
  let BRIDGE_PAGE = null;
  try { BRIDGE_PAGE = fs.readFileSync(path.join(__dirname, 'logout-bridge.html'), 'utf8'); } catch (e) { /* 同上 */ }
  const stateFile = cfg.stateFile, logFile = cfg.logFile, sharesLogFile = cfg.sharesLogFile, friendsFile = cfg.friendsFile;
  // ===== 封禁功能门（P5-010，主稿 DS 稿 §3.1，偏差 DEV-10/DEV-11）=====
  // DEV-10：镜像路径由 stateFile 同级 provider-mirror 推导（status-providers.js 同法）。
  const MIRROR_FILE = path.join(path.dirname(stateFile), 'provider-mirror', 'license', 'status.json');

  let _mirrorCache = { mtimeMs: -1, size: -1, data: null };
  function readMirror() {
    try {
      const st = fs.statSync(MIRROR_FILE);
      if (st.mtimeMs === _mirrorCache.mtimeMs && st.size === _mirrorCache.size && _mirrorCache.data) return _mirrorCache.data; // DEV-21/S-D：键加 size（与 chat/forum 统一）
      const data = JSON.parse(fs.readFileSync(MIRROR_FILE, 'utf8'));
      _mirrorCache = { mtimeMs: st.mtimeMs, size: st.size, data };
      return data;
    } catch (e) { // DEV-18/G-04：失败必须可见（60 秒节流），不再静默 false
      const t = Date.now(); if (t - _mirrorErrLogAt > 60000) { _mirrorErrLogAt = t; try { log({ ev: 'ban-mirror-read-failed', err: String(e && e.message) }); } catch (e2) {} }
      return null; }
  }

  let _mirrorErrLogAt = 0;
  function mirrorBanLink(username) {
    const u = String(username || '').trim().toLowerCase();
    if (!u) return false;
    const m = readMirror();
    if (!m) return false;
    let rec = m[u]; // DEV-18/G-08：扁平优先、包裹兜底（原三元在登录名恰为 accounts 时误判）
    if (!rec && m.accounts && typeof m.accounts === 'object' && !Array.isArray(m.accounts)) rec = m.accounts[u];
    return !!(rec && rec.banLink === true);
  }

  // 内存缓存 5s（DS 稿口径）：ban 事件后镜像即时刷新，5s 上限只是防读盘风暴
  const BANLINK_TTL_MS = 5000;
  const _banLinkCache = new Map();

  function purgeBanLinkCache(username) {
    if (username) _banLinkCache.delete(String(username).trim().toLowerCase());
    else _banLinkCache.clear();
  }
  function sweepBanLinkCache(now) { // DEV-18/G-09：原 Map 只增不删，超阈值清过期项
    if (_banLinkCache.size <= 5000) return;
    for (const [k, v] of _banLinkCache) { if (!v || now - v.at >= BANLINK_TTL_MS) _banLinkCache.delete(k); }
  }

  function isBanLinked(username) {
    const u = String(username || '').trim().toLowerCase();
    if (!u) return false;
    const hit = _banLinkCache.get(u);
    const now = Date.now();
    sweepBanLinkCache(now);
    if (hit && (now - hit.at) < BANLINK_TTL_MS) return hit.val;
    const val = mirrorBanLink(u);
    _banLinkCache.set(u, { val, at: now });
    return val;
  }

  // DEV-11：friends 本体无 postInternalJson，此回源助手按本服务既有内网
  // 验密式样新写（secret 文件同源、x-qf-internal-secret 头、1.5s 超时）。
  function callExtAccountLink(username) {
    return new Promise((resolve) => {
      let secret = '';
      try { secret = fs.readFileSync(process.env.QFLIC_SECRET_FILE || '/opt/qfremote-license/internal.secret', 'utf8').trim(); } catch (e) {}
      if (!secret) return resolve(null);
      const payload = JSON.stringify({ username });
      const rq = http.request({ hostname: '127.0.0.1', port: 8448, path: '/internal/license/account-link', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'x-qf-internal-secret': secret }, timeout: 1500 },
        (rs) => { let d = ''; rs.on('data', (c) => { d += c; }); rs.on('end', () => { try { const j = JSON.parse(d); resolve(j && typeof j.banLink === 'boolean' ? j.banLink : null); } catch (e) { resolve(null); } }); });
      rq.on('timeout', () => { try { rq.destroy(); } catch (e) {} resolve(null); });
      rq.on('error', () => resolve(null));
      rq.write(payload); rq.end();
    });
  }

  // 异步版：镜像未命中时向 ext 回源一次，结果回填缓存
  async function isBanLinkedAsync(username) {
    const u = String(username || '').trim().toLowerCase();
    if (!u) return false;
    if (isBanLinked(u)) return true;
    const hit = _banLinkCache.get(u);
    if (hit && hit.val) return true;
    try {
      const r = await callExtAccountLink(u);
      if (typeof r === 'boolean') { _banLinkCache.set(u, { val: r, at: Date.now() }); return r; }
    } catch (e) {}
    return false;
  }

  // 二期聊天合入同一进程：共用 8445 与 MeshCentral 验密通道，好友闸口直接
  // 读本服务维护的 friends.json；不另开聊天端口、不另起平行服务。
  const chatHandler = createChatHandler({
    mcUrl: cfg.mcUrl,
    friendsFile,
    dataFile: cfg.chatDataFile || '/opt/qfremote-friends/data/chat-data.json',
    logFile: cfg.chatLogFile || '/opt/qfremote-friends/logs/chat.log',
    supportFaqFile: cfg.supportFaqFile || path.join(__dirname, 'chat', 'support-faq.json')
  });

  // ---- 智能客服（2.3.0 N 线集成；模块在 support/，口径见 support/INTEGRATION.md）----
  // 数据目录落在服务状态文件同级的 data/support：现行 systemd 单元的
  // ReadWritePaths 只放行 data 与 logs，模块自带的 support/data 在沙箱下不可写。
  const supportDataDir = cfg.supportDataDir || path.join(path.dirname(stateFile), 'support');
  const { createStore: createSupportStore } = require('./support/support-store');
  const { createEngine: createSupportEngine } = require('./support/support');
  const { createFileProviders } = require('./support/status-providers');
  const { createSupportRouter } = require('./support/http-router');
  const supportStore = createSupportStore(supportDataDir);
  const supportProviders = createFileProviders({
    loginshimDataDir: cfg.supportLoginshimDataDir || '/opt/qfremote-loginshim/data',
    extDataDir: cfg.supportExtDataDir || '/opt/qfremote-ext/data',
    ledgerFile: cfg.supportLedgerFile || '/opt/meshcentral/meshcentral-data/qf-account-ledger.json',
    contactsFile: cfg.supportContactsFile || path.join(path.dirname(stateFile), 'contacts.json'),
    // 身份核对验密（裁决批③：账号＋密码）：与聊天开锁同链——经控制台
    // 控制通道验密；连接类失败报不可用（不计核对失败次数），认证拒绝
    // 才是核对不通过。
    verifyPasswordFn: async (username, password) => {
      const v = await verifyMeshCentralPassword(cfg.mcUrl || 'wss://127.0.0.1:8443/control.ashx', username, password);
      if (v && v.ok) return { available: true, ok: true };
      if (v && (v.why === 'auth-rejected' || v.why === 'closed')) return { available: true, ok: false };
      return { available: false };
    }
  });
  // 站长 API 事件推送（#31：新工单入 ext 统一事件队列；尽力而为，失败不拦工单）
  function pushSupportEvent(ticket) {
    try {
      const secret = fs.readFileSync(process.env.QFLIC_SECRET_FILE || '/opt/qfremote-license/internal.secret', 'utf8').trim();
      const data = Buffer.from(JSON.stringify({ type: 'support', refId: ticket.id, summary: { user: ticket.user || ticket.verifiedAccount || null, anon: !!ticket.anon, desc: String(ticket.description || '').slice(0, 60) } }));
      const rq = http.request({ hostname: '127.0.0.1', port: 8448, path: '/internal/events/push', method: 'POST', timeout: 800,
        headers: { 'Content-Type': 'application/json', 'Content-Length': data.length, 'x-qf-internal-secret': secret } }, (rs) => { rs.resume(); });
      rq.on('error', () => {}); rq.on('timeout', () => { try { rq.destroy(); } catch (e) {} });
      rq.write(data); rq.end();
    } catch (e) {}
  }
  const supportEngine = createSupportEngine({ store: supportStore, providers: supportProviders, handoffPerDay: 5, onTicketCreated: (t) => { try { pushSupportEvent(t); } catch (e) {} },
    // #27 AI 大脑：配置与密钥均在服务器文件（ai-config.json 开关/模型链，
    // glm-api-key.txt 密钥 600），通道异常自动降级知识库（ai-channel 内建）。
    aiConfigPath: '/opt/qfremote-ext/ai-config.json', aiKeyPath: '/opt/qfremote-ext/glm-api-key.txt' });
  const SUPPORT_PAGE = fs.readFileSync(path.join(__dirname, 'support', 'support-page.html'), 'utf8');
  // authenticate 接法：先走本服务现行会话链（qfr_frd 会话 → 控制台单点登录
  // trySso，含 H 线会话绑 IP 还原），结果挂在 req 上供客服路由读取；路由本身
  // 不另建登录。站长判定：会话用户为站长账号本人（其会话只可能经密码验真
  // 或控制台单点登录签发，两条链均已核过该账号的管理员身份）。
  async function resolveSupportAuth(req, res) {
    let me = sessionUser(req);
    if (!me) me = await trySso(req, res);
    req.qfSupportUser = me || null;
    req.qfSupportAdmin = !!me && isOwnerAccount(me);
    return me;
  }
  const supportRouter = createSupportRouter({
    engine: supportEngine, store: supportStore,
    authenticate: async (req) => req.qfSupportUser || null,
    authenticateAdmin: async (req) => !!req.qfSupportAdmin
  });

  let state = newState();
  try {
    const loaded = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    state = Object.assign(newState(), loaded);
  } catch (e) { /* 首次运行 */ }
  function saveState() {
    fs.writeFileSync(stateFile + '.tmp', JSON.stringify(state));
    fs.renameSync(stateFile + '.tmp', stateFile);
  }
  function log(obj) {
    const line = JSON.stringify(Object.assign({ at: new Date().toISOString() }, obj)) + '\n';
    try { fs.appendFileSync(logFile, line); } catch (e) { /* 日志写不了不拦正事 */ }
  }
  function shareLog(obj) {
    const line = JSON.stringify(Object.assign({ at: new Date().toISOString() }, obj)) + '\n';
    try { fs.appendFileSync(sharesLogFile, line); } catch (e) {}
    log(obj);
  }
  function writeFriendsGateFile() {
    try {
      fs.writeFileSync(friendsFile + '.tmp', JSON.stringify({ pairs: exportPairs(state) }, null, 2));
      fs.renameSync(friendsFile + '.tmp', friendsFile);
    } catch (e) { log({ ev: 'gatefile-error', err: String(e && e.message) }); }
  }

  // ---- 账号目录（经官方 users 命令，30 秒缓存）----
  let usersCache = { at: 0, map: null };
  async function listUsers(force) {
    const now = Date.now();
    if (!force && usersCache.map && now - usersCache.at < 5000) return usersCache.map;
    const res = await svcCall(cfg, { action: 'users' });
    const map = new Map();
    for (const u of (res.users || [])) {
      // 键用登录名（从 _id 拆：user/<域>/<登录名>，本站域为空）：显示名可能与
      // 登录名不同（如站长显示名 Wayne、登录名是邮箱），按显示名建键会查不到。
      const login = String(u._id || '').replace(/^user\/[^/]*\//, '').toLowerCase();
      if (!login) continue;
      map.set(login, { id: u._id, name: login, siteadmin: u.siteadmin || 0, links: u.links || {} });
    }
    usersCache = { at: now, map };
    return map;
  }
  async function findUser(name) {
    const key = norm(name);
    let map = await listUsers(false);
    if (!map.has(key)) map = await listUsers(true); // 缓存未命中就强制刷新一次，防新注册账号被旧快照挡住
    return map.get(key) || null;
  }
  // ---- 共享执行（以执行账号身份走 addmeshuser）----
  async function execAddShare(meshid, granteeName, rights) {
    const res = await svcCall(cfg, { action: 'addmeshuser', meshid, userids: [norm(granteeName)], meshadmin: rights });
    return res; // {result:'Added user X', success, failed}
  }
  async function execRemoveShare(meshid, granteeName) {
    const res = await svcCall(cfg, { action: 'addmeshuser', meshid, userids: [norm(granteeName)], meshadmin: 0, remove: true });
    return res;
  }
  // pkg3 #3：execOk 已提至模块层（见 tierRights 下方），此处不再重复定义；
  // handleShare / revokeShare / 对账仍共用同一 execOk。
  // 回收一条共享（执行＋落台账）。reason: unfriend/owner-revoke/grantee-frozen/grantee-gone/admin-revoke
  // H23：执行失败（异常或返回值 success<=0）不置 revoked——共享保持 active，
  // 下次 reconcile/重试时自动再收；成功才置 revoked。返回 {ok, exec}。
  async function revokeShare(share, reason) {
    let execResult = null;
    let ok = false;
    try {
      const res = await execRemoveShare(share.meshid, share.grantee);
      execResult = res && res.result;
      ok = execOk(res);
    } catch (e) { execResult = 'exec-error:' + (e && e.message); ok = false; }
    if (!ok) {
      share.revokeAttempts = (share.revokeAttempts || 0) + 1;
      share.revokeError = execResult;
      share.lastRevokeAttemptAt = new Date().toISOString();
      shareLog({ ev: 'share.revoke-failed', owner: share.owner, grantee: share.grantee, mesh: share.meshName, rights: share.rights, reason, exec: execResult, attempts: share.revokeAttempts });
      return { ok: false, exec: execResult };
    }
    share.status = 'revoked';
    share.revokedAt = new Date().toISOString();
    share.revokeReason = reason;
    shareLog({ ev: 'share.revoke', owner: share.owner, grantee: share.grantee, mesh: share.meshName, rights: share.rights, reason, exec: execResult });
    return { ok: true, exec: execResult };
  }

  // ---- 对账：冻结/封禁（账号消失）联动回收＋关系清理 ----
  let reconciling = false;
  async function reconcile() {
    if (reconciling) return;
    reconciling = true;
    try {
      const users = await listUsers();
      const now = Date.now();
      let changed = false;
      // 参与者集合：好友/申请/共享里出现过的账号
      const participants = new Set();
      for (const a of Object.keys(state.friends)) { participants.add(a); for (const b of Object.keys(state.friends[a])) participants.add(b); }
      for (const r of state.requests) { participants.add(r.from); participants.add(r.to); }
      for (const s of state.shares) { participants.add(s.owner); participants.add(s.grantee); }
      for (const name of participants) {
        if (isGuardName(name) || isOwnerAccount(name)) continue;
        const u = users.get(name);
        if (!u) {
          // 账号消失（删号/封号）：回收授予给他的共享，清掉他的关系与申请
          for (const s of state.shares) {
            if (s.status === 'active' && s.grantee === name) await revokeShare(s, 'grantee-gone');
            else if (s.status === 'active' && s.owner === name) await revokeShare(s, 'owner-gone');
          }
          for (const other of Object.keys(state.friends[name] || {})) unsetFriends(state, name, other);
          delete state.friends[name];
          state.requests = state.requests.filter(r => r.from !== name && r.to !== name);
          log({ ev: 'prune-gone-user', user: name });
          changed = true;
        } else if (isFrozenSiteadmin(u.siteadmin)) {
          // 被冻结：回收授予给他的全部共享（解冻不自动恢复）
          for (const s of state.shares) {
            if (s.status === 'active' && s.grantee === name) { await revokeShare(s, 'grantee-frozen'); changed = true; }
          }
          // 冻结者发出的待处理申请一并撤掉（他本人也登不进来处理）
          const before = state.requests.length;
          state.requests = state.requests.filter(r => r.from !== name);
          if (state.requests.length !== before) { log({ ev: 'prune-frozen-requests', user: name }); changed = true; }
        }
      }
      // 智能客服数据随账号消失一并清除（INTEGRATION 待补项在此接线）：清
      // 会话/工单两表中属于已消失账号的记录，以及 jsonl 留痕中可归属到该
      // 账号的行（不可归属的行保留）；不依赖好友参与者集合，从未加过好友
      // 的账号被删/被封同样覆盖。存活集合为空时存储层自动跳过（异常保护）。
      try {
        const purged = supportStore.purgeAccountsNotIn(new Set(users.keys()));
        if (purged && (purged.sessions || purged.tickets || purged.messageLines || purged.unhitLines)) log({ ev: 'support-purge-gone', sessions: purged.sessions, tickets: purged.tickets, messageLines: purged.messageLines, unhitLines: purged.unhitLines });
      } catch (e) { log({ ev: 'support-purge-error', err: String(e && e.message) }); }
      if (changed) { saveState(); writeFriendsGateFile(); }
    } catch (e) {
      log({ ev: 'reconcile-error', err: String(e && e.message) });
    } finally { reconciling = false; }
  }

  // ---- 会话 ----
  function sessionUser(req) {
    const cookies = parseCookies(req);
    const tok = cookies.qfr_frd;
    if (!tok) return null;
    const hash = crypto.createHash('sha256').update(tok).digest('hex');
    const s = state.sessions[hash];
    if (!s) return null;
    if (Date.now() > s.exp) { delete state.sessions[hash]; saveState(); return null; }
    // SSO 绑定（2.3.0 M2 线）：凭控制台单点登录签发的会话绑当时的控制台
    // 会话（xid 哈希）。控制台退出后浏览器里的 xid 被清掉、或换了账号
    // 重新登录（xid 变了），本会话即刻作废——网页端退出登录的级联终止
    // 靠这条绑定兜底（控制台页受上游 CSP 限制，跨源退出请求发不出去）。
    // 密码登录签发的会话不绑（bind 为空），独立打开好友页输密码的用法
    // 与「记住此设备」口径完全不受影响；旧会话无 bind 字段同样不绑。
    if (s.bind) {
      const cur = xidHash(cookies);
      if (!cur || cur !== s.bind) { delete state.sessions[hash]; saveState(); return null; }
    }
    return s.user;
  }
  function issueSession(res, user, remember, bind) {
    const ttlMs = remember ? REMEMBER_TTL_MS : SESSION_TTL_MS;
    const tok = crypto.randomBytes(32).toString('hex');
    const hash = crypto.createHash('sha256').update(tok).digest('hex');
    state.sessions[hash] = { user, exp: Date.now() + ttlMs, bind: bind || null };
    saveState();
    // 每次成功登录（密码登录或单点登录）都清掉「手动退出」标记：退出只终止
    // 当次，重新登录后恢复正常自动登录口径。
    res.setHeader('Set-Cookie', [
      'qfr_frd=' + tok + '; Path=/; Max-Age=' + Math.floor(ttlMs / 1000) + '; SameSite=Lax; Secure; HttpOnly',
      'qfr_frd_out=; Path=/; Max-Age=0; SameSite=Lax; Secure; HttpOnly'
    ]);
  }
  // —— 手动退出标记（2.3.0 退出语义统一）——
  // 手动退出是唯一的人工终止：退出后，即使控制台会话还有效，也不再靠单点
  // 登录自动把人带回来。标记值 = 当时控制台会话 xid 的哈希：同一控制台
  // 会话内一直生效；控制台重新登录换了新会话（xid 变了）即自动失效，
  // 或用户在本页重新输账号密码登录（issueSession 清标记）。
  function xidHash(cookies) {
    if (!cookies.xid) return '';
    return crypto.createHash('sha256').update(String(cookies.xid) + '.' + String(cookies['xid.sig'] || '')).digest('hex');
  }
  function ssoSuppressed(cookies) {
    const mark = cookies.qfr_frd_out;
    if (!mark) return false;
    if (!cookies.xid) return true;
    return mark === xidHash(cookies);
  }

  function parseCookies(req) {
    const out = {};
    String(req.headers.cookie || '').split(';').forEach(p => {
      const i = p.indexOf('=');
      if (i > 0) out[p.slice(0, i).trim()] = p.slice(i + 1).trim();
    });
    return out;
  }
  function clientIp(req) {
    const remote = String((req.socket && req.socket.remoteAddress) || '');
    const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
    const forwarded = String((req.headers && req.headers['cf-connecting-ip']) || '').trim();
    // M-026: only our loopback proxy may supply this validated single-IP header.
    if (loopback && require('net').isIP(forwarded)) return forwarded;
    return remote.replace(/^::ffff:/, '');
  }
  function sendJson(res, code, obj) {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(obj));
  }
  function readBody(req) {
    return new Promise((resolve) => {
      let body = '';
      req.on('data', c => { body += c; if (body.length > 16384) req.destroy(); });
      req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch (e) { resolve({}); } });
      req.on('close', () => resolve({}));
    });
  }

  // ---- 开通：把执行账号加进「我当组主的每个设备组」，只给组权 2 ----
  // 密码登录与控制台单点登录共用：都以登录者本人的会话执行，口径完全一致。
  async function runOnboard(sess, info, user) {
    const onboarded = [];
    try {
      const meshesRes = await mcCall(sess, { action: 'meshes' });
      const myId = info._id;
      for (const mesh of (meshesRes.meshes || [])) {
        if (!mesh || !mesh._id) continue;
        const myRights = linkRights(mesh.links, myId);
        if (myRights !== RIGHTS_GROUP_ADMIN) continue; // 只处理我是组主的组
        const svcRights = linkRights(mesh.links, userIdOf(cfg.svcUser));
        if (svcRights !== RIGHTS_SVC_IN_GROUP) {
          const r = await mcCall(sess, { action: 'addmeshuser', meshid: mesh._id, userids: [cfg.svcUser], meshadmin: RIGHTS_SVC_IN_GROUP });
          log({ ev: 'onboard', user, mesh: mesh.name, result: r && r.result });
        }
        onboarded.push({ meshid: mesh._id, name: mesh.name || '' });
      }
    } catch (e) { log({ ev: 'onboard-error', user, err: String(e && e.message) }); }
    state.onboarded[user] = onboarded;
    saveState();
    return onboarded;
  }

  // ---- 控制台单点登录：浏览器已登录控制台时，凭其会话 cookie 验真 ----
  // 通过后照常开通并签发本服务会话：好友页对已登录控制台的用户不再出现
  // 第二次登录；拒绝口径与密码登录一致（保护账号、站长全权号不用好友）。
  const ssoCache = new Map(); // sha256(xid) -> {at, user|null}，30 秒短缓存，防接口连打时反复开通道
  async function trySso(req, res) {
    const cookies = parseCookies(req);
    if (!cookies.xid) return null;
    if (ssoSuppressed(cookies)) return null; // 本控制台会话内已手动退出好友：不再自动带回
    const key = crypto.createHash('sha256').update(String(cookies.xid) + '.' + String(cookies['xid.sig'] || '')).digest('hex'); // 键带签名：防无签名请求把无效结果缓存住、连带拒绝真请求（2026-10-25 实测）
    const hit = ssoCache.get(key);
    if (hit && Date.now() - hit.at < 30000) {
      if (!hit.user) return null;
      issueSession(res, hit.user, false, key);
      return hit.user;
    }
    const ip = clientIp(req);
    let sess = null;
    try {
      const parts = ['xid=' + cookies.xid];
      if (cookies['xid.sig']) parts.push('xid.sig=' + cookies['xid.sig']);
      sess = await mcConnectCookie(cfg, parts.join('; '), 6000, [clientIp(req)]);
      const info = sess.userinfo || {};
      const user = String(info._id || '').replace(/^user\/[^/]*\//, '').toLowerCase();
      if (!user || (isGuardName(user) && !isOwnerAccount(user)) || ((info.siteadmin || 0) === SITEADMIN_FULL && !isOwnerAccount(user))) {
        ssoCache.set(key, { at: Date.now(), user: null });
        log({ ev: 'sso-refused', user: user || '?', ip });
        return null;
      }
      await runOnboard(sess, info, user);
      ssoCache.set(key, { at: Date.now(), user });
      issueSession(res, user, false, key);
      log({ ev: 'sso-login', user, ip });
      reconcile().catch(() => {});
      return user;
    } catch (e) {
      ssoCache.set(key, { at: Date.now(), user: null });
      return null;
    } finally { if (sess) { try { sess.ws.close(); } catch (e) {} } }
  }

  // ---- 登录（验密＋开通执行账号进组）----
  async function handleLogin(req, res) {
    const data = await readBody(req);
    const user = norm(data.username);
    const pass = String(data.password || '');
    const ip = clientIp(req);
    if (!user || !pass) return sendJson(res, 400, { ok: false, msg: '请填写账号和密码。' });
    if (isGuardName(user) && !isOwnerAccount(user)) { log({ ev: 'login-guard-refused', user, ip }); return sendJson(res, 403, { ok: false, msg: '该账号不能使用好友功能。' }); }
    let sess;
    try {
      sess = await mcConnect(cfg, user, pass);
    } catch (e) {
      log({ ev: 'login-fail', user, ip });
      return sendJson(res, 401, { ok: false, msg: '账号或密码不正确，或账号已被冻结，请检查后重试。' });
    }
    try {
      const info = sess.userinfo || {};
      if ((info.siteadmin || 0) === SITEADMIN_FULL && !isOwnerAccount(user)) { try { sess.ws.close(); } catch (e) {} log({ ev: 'login-admin-refused', user, ip }); return sendJson(res, 403, { ok: false, msg: '该账号不能使用好友功能。' }); }
      if (await isBanLinkedAsync(user)) { log({ ev: 'login-banlinked', user, ip }); return sendJson(res, 403, { ok: false, code: 'ACCOUNT_BANNED', msg: '该账号已被封禁。如果你认为封错了，可以在登录页提交申诉。' }); }
      const onboarded = await runOnboard(sess, info, user);
      log({ ev: 'login', user, ip, groups: onboarded.length });
      issueSession(res, user, data.remember === true);
      reconcile().catch(() => {});
      return sendJson(res, 200, { ok: true, user, groups: onboarded });
    } finally { try { sess.ws.close(); } catch (e) {} }
  }

  // ---- /me 视图 ----
  async function buildMe(me) {
    const users = await listUsers().catch(() => new Map());
    const alive = (name) => { const u = users.get(name); return !!u && !isFrozenSiteadmin(u.siteadmin); };
    const friends = [];
    for (const name of Object.keys(state.friends[me] || {})) {
      if (!alive(name)) continue; // 被冻结/已消失的好友不在各端列表出现（方案口径）
      friends.push({ name, since: state.friends[me][name] });
    }
    friends.sort((a, b) => a.name.localeCompare(b.name));
    const requestsIn = state.requests.filter(r => r.to === me && alive(r.from)).map(r => ({ from: r.from, at: r.at }));
    const requestsOut = state.requests.filter(r => r.from === me).map(r => ({ to: r.to, at: r.at }));
    const sharesOut = state.shares.filter(s => s.status === 'active' && s.owner === me)
      .map(s => ({ grantee: s.grantee, meshid: s.meshid, meshName: s.meshName, tier: s.tier, rights: s.rights, grantedAt: s.grantedAt }));
    const sharesIn = state.shares.filter(s => s.status === 'active' && s.grantee === me)
      .map(s => ({ owner: s.owner, meshid: s.meshid, meshName: s.meshName, tier: s.tier, rights: s.rights, grantedAt: s.grantedAt }));
    const records = state.shares.filter(s => s.owner === me || s.grantee === me).slice(-50).reverse()
      .map(s => ({ owner: s.owner, grantee: s.grantee, meshName: s.meshName, tier: s.tier, rights: s.rights, status: s.status, grantedAt: s.grantedAt, revokedAt: s.revokedAt || null, revokeReason: s.revokeReason || null }));
    return { user: me, friends, requestsIn, requestsOut, myGroups: state.onboarded[me] || [], sharesOut, sharesIn, records };
  }

  // ---- 搜索（只许账号名精确）----
  async function handleSearch(req, res, me) {
    const data = await readBody(req);
    const target = norm(data.username);
    const now = Date.now();
    const used = searchQuota(state, me, now, true);
    saveState();
    if (used > SEARCH_LIMIT_PER_HOUR) { log({ ev: 'search-ratelimited', user: me }); return sendJson(res, 429, { ok: false, msg: '搜索过于频繁，请稍后再试。' }); }
    if (!target || isGuardName(target)) { log({ ev: 'search', user: me, target, found: false }); return sendJson(res, 200, { ok: true, found: false }); }
    const u = await findUser(target);
    const found = !!u;
    log({ ev: 'search', user: me, target, found });
    if (!found) return sendJson(res, 200, { ok: true, found: false });
    let relation = 'none';
    if (target === me) relation = 'self';
    else if (areFriends(state, me, target)) relation = 'friend';
    else if (findRequest(state, me, target)) relation = 'pending-out';
    else if (findRequest(state, target, me)) relation = 'pending-in';
    return sendJson(res, 200, { ok: true, found: true, name: target, relation });
  }

  // ---- 发申请 ----
  async function handleRequest(req, res, me) {
    const data = await readBody(req);
    const target = norm(data.username);
    const now = Date.now();
    if (!target || target === me) return sendJson(res, 400, { ok: false, msg: '不能添加自己为好友。' });
    if (isGuardName(target)) return sendJson(res, 404, { ok: false, msg: '未找到该账号。' });
    const u = await findUser(target);
    if (!u) return sendJson(res, 404, { ok: false, msg: '未找到该账号，请确认账号名完整无误。' });
    const plan = planRequest(state, me, target, now);
    if (plan.type === 'already-friends') return sendJson(res, 200, { ok: true, msg: '对方已是您的好友。' });
    if (plan.type === 'already-pending') return sendJson(res, 200, { ok: true, msg: '申请已发送，等待对方同意。' });
    if (plan.type === 'blocked') {
      log({ ev: 'request-blocked', user: me, target, blockType: plan.block.type });
      return sendJson(res, 403, { ok: false, msg: '暂时不能向对方发送好友申请。' });
    }
    if (requestQuota(state, me, now, false) >= REQUEST_LIMIT_PER_DAY) {
      return sendJson(res, 429, { ok: false, msg: '今日发送的好友申请已达上限，请明日再试。' });
    }
    requestQuota(state, me, now, true);
    if (plan.type === 'auto-accept') {
      // 对方先申请过我 → 直接成好友
      state.requests = state.requests.filter(r => r !== plan.request);
      setFriends(state, me, target, now);
      saveState(); writeFriendsGateFile();
      log({ ev: 'friend-autoaccept', user: me, target });
      return sendJson(res, 200, { ok: true, msg: '对方此前也向您发送过申请，双方已成为好友。' });
    }
    state.requests.push({ id: crypto.randomBytes(8).toString('hex'), from: me, to: target, at: now });
    saveState();
    log({ ev: 'request', user: me, target });
    return sendJson(res, 200, { ok: true, msg: '申请已发送，等待对方同意。' });
  }

  // ---- 处理申请（同意/拒绝）----
  async function handleRespond(req, res, me) {
    const data = await readBody(req);
    const from = norm(data.username);
    const now = Date.now();
    const rq = findRequest(state, from, me);
    if (!rq) return sendJson(res, 404, { ok: false, msg: '该申请已不存在。' });
    state.requests = state.requests.filter(r => r !== rq);
    if (data.accept) {
      setFriends(state, from, me, now);
      saveState(); writeFriendsGateFile();
      log({ ev: 'friend-accept', user: me, target: from });
      return sendJson(res, 200, { ok: true, msg: '双方已成为好友。' });
    }
    // 拒绝：写方向性拦截（普通拒绝 30 天冷却；勾「不再接收」永久）
    if (data.never) setBlock(state, from, me, { type: 'never', at: now });
    else setBlock(state, from, me, { type: 'cooldown', until: now + COOLDOWN_MS, at: now });
    saveState();
    log({ ev: 'friend-reject', user: me, target: from, never: !!data.never });
    return sendJson(res, 200, { ok: true, msg: '已拒绝该申请。' });
  }

  // ---- 删好友（双向回收共享＋双向冷却）----
  async function handleRemove(req, res, me) {
    const data = await readBody(req);
    const target = norm(data.username);
    const now = Date.now();
    if (!areFriends(state, me, target)) return sendJson(res, 404, { ok: false, msg: '对方不是您的好友。' });
    const mine = sharesBetween(state, me, target);
    for (const s of mine) await revokeShare(s, 'unfriend');
    unsetFriends(state, me, target);
    setBlock(state, me, target, { type: 'cooldown', until: now + COOLDOWN_MS, at: now });
    setBlock(state, target, me, { type: 'cooldown', until: now + COOLDOWN_MS, at: now });
    saveState(); writeFriendsGateFile();
    log({ ev: 'unfriend', user: me, target, sharesRevoked: mine.length });
    return sendJson(res, 200, { ok: true, msg: '已删除好友，双方之间的共享已全部收回。' });
  }

  // ---- 发起共享 ----
  async function handleShare(req, res, me) {
    const data = await readBody(req);
    const target = norm(data.username);
    const tier = data.tier === 'operate' ? 'operate' : 'view';
    const rights = tierRights(tier);
    if (!areFriends(state, me, target)) return sendJson(res, 403, { ok: false, msg: '须先成为好友，才能共享。' });
    const tu = await findUser(target);
    if (!tu || isFrozenSiteadmin(tu.siteadmin)) return sendJson(res, 404, { ok: false, msg: '对方账号当前不可用，无法共享。' });
    let groups = state.onboarded[me] || [];
    if (data.meshid) groups = groups.filter(g => g.meshid === data.meshid);
    if (groups.length === 0) return sendJson(res, 400, { ok: false, msg: '您名下暂无可共享的设备组，请先将设备加入设备组后重试。' });
    const done = [];
    for (const g of groups) {
      const r = await execAddShare(g.meshid, target, rights);
      if (!execOk(r)) {
        log({ ev: 'share-grant-failed', user: me, target, mesh: g.name, result: r && r.result });
        return sendJson(res, 502, { ok: false, msg: '共享未成功（' + (r && r.result ? r.result : '服务器未响应') + '），请稍后重试；如仍不成功，请联系站长。', done });
      }
      const existing = state.shares.find(s => s.status === 'active' && s.owner === me && s.grantee === target && s.meshid === g.meshid);
      if (existing) { existing.rights = rights; existing.tier = tier; existing.grantedAt = new Date().toISOString(); }
      else state.shares.push({ id: crypto.randomBytes(8).toString('hex'), owner: me, grantee: target, meshid: g.meshid, meshName: g.name, rights, tier, status: 'active', grantedAt: new Date().toISOString(), revokedAt: null, revokeReason: null });
      shareLog({ ev: 'share.grant', owner: me, grantee: target, mesh: g.name, rights, tier, via: cfg.svcUser, result: r.result });
      done.push(g.name);
    }
    saveState();
    return sendJson(res, 200, { ok: true, msg: '已共享（' + (tier === 'operate' ? '能操作' : '只看') + '）：' + done.join('、'), done });
  }

  // ---- 取消共享 ----
  async function handleUnshare(req, res, me) {
    const data = await readBody(req);
    const target = norm(data.username);
    let list = state.shares.filter(s => s.status === 'active' && s.owner === me && s.grantee === target);
    if (data.meshid) list = list.filter(s => s.meshid === data.meshid);
    if (list.length === 0) return sendJson(res, 404, { ok: false, msg: '该共享已不在生效中。' });
    const results = [];
    for (const s of list) results.push(await revokeShare(s, 'owner-revoke'));
    saveState();
    const failed = results.filter(r => !r.ok).length;
    log({ ev: 'unshare', user: me, target, count: list.length, failed });
    if (failed > 0) {
      // H23：执行失败的共享保持 active（下次可重试），不宣称对方已无法查看。
      return sendJson(res, 502, { ok: false, msg: '共享收回失败（' + failed + '/' + list.length + ' 条），对方可能仍可查看，请稍后重试。' });
    }
    return sendJson(res, 200, { ok: true, msg: '共享已收回，对方无法再通过该共享查看您的电脑。' });
  }

  // ---- HTTP 入口 ----
  // 隐私锁桥（新增路由 /lock/*；鉴权与机主核对都在桥内，见 lock-bridge.js）
  const lockBridge = createLockBridge({
    cfg,
    log: (tag, msg) => log({ ev: 'lock', msg: String(tag) + ': ' + String(msg == null ? '' : msg) }),
    sessionUser,
    mcConnect,
    mcConnectCookie,
    bridgeCfgPath: '/opt/qfremote-lock/bridge-config.json',
    isBanLinked,
    isSiteAdmin: isOwnerAccount, // W-16：/lock/owner-check 只站长可用（站长账号 718983610）
  });
  // 论坛公开基址（直连源同框重定向用）：以官网 product.json 的 web.forumUrl
  // 为唯一准（临时通道轮换由既有巡检同步该文件），内存缓存 10 分钟，
  // 拉取失败时沿用最近一次成功值；从未成功则返回空串，调用方回退好友页。
  let forumBaseCache = { url: '', at: 0 };
  function forumPublicBase() {
    const now = Date.now();
    if (forumBaseCache.url && now - forumBaseCache.at < 600000) return Promise.resolve(forumBaseCache.url);
    return new Promise((resolve) => {
      try {
        const rq = https.get('https://qfremote.top/product.json', { timeout: 8000 }, (r) => {
          let d = '';
          r.on('data', c => { d += c; if (d.length > 262144) rq.destroy(); });
          r.on('end', () => {
            try {
              const j = JSON.parse(d);
              const fu = j && j.web && j.web.forumUrl;
              if (fu) forumBaseCache = { url: String(fu).replace(/\/forum\/?$/, ''), at: now };
            } catch (e) { /* 解析失败沿用缓存 */ }
            resolve(forumBaseCache.url);
          });
        });
        rq.on('error', () => resolve(forumBaseCache.url));
        rq.on('timeout', () => { rq.destroy(); resolve(forumBaseCache.url); });
      } catch (e) { resolve(forumBaseCache.url); }
    });
  }

  const server = https.createServer({ key: fs.readFileSync(cfg.tlsKey), cert: fs.readFileSync(cfg.tlsCert) }, async (req, res) => {
    try {
      const u = new URL(req.url, 'https://localhost');
      const p = u.pathname;
      if (p === '/chat' || p.startsWith('/chat/')) return await chatHandler(req, res);
      // 站长 API 内网裁定（#22/#31：助手接口经 ext 转发；与回复台同一 store 操作口径）
      // 封禁联动 purge（P5-010，DS 稿 §3.5）：ext executeBanEnforcement ④ 调用
      if (req.method === 'POST' && p === '/internal/ban-purge') {
        let secret = ''; try { secret = fs.readFileSync(process.env.QFLIC_SECRET_FILE || '/opt/qfremote-license/internal.secret', 'utf8').trim(); } catch (e) {}
        if (!secret || req.headers['x-qf-internal-secret'] !== secret) { res.writeHead(403, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, code: 'INTERNAL_AUTH' })); }
        const body = await readBody(req);
        const target = String(body.username || '').trim().toLowerCase();
        if (!target) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, code: 'VALIDATION' })); }
        let frd = 0;
        for (const h of Object.keys(state.sessions)) {
          const sx = state.sessions[h];
          if (sx && String(sx.user || '').trim().toLowerCase() === target) { delete state.sessions[h]; frd += 1; }
        }
        if (frd) saveState();
        let chat = 0; try { if (typeof chatHandler.purgeUserSessions === 'function') chat = chatHandler.purgeUserSessions(target); } catch (e) {}
        let lock = 0; try { if (typeof lockBridge.purgeUser === 'function') lock = lockBridge.purgeUser(target); } catch (e) {}
        purgeBanLinkCache(target);
        log({ ev: 'ban-purge', user: target, source: String(body.source || ''), frd, chat, lock });
        res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true, cleared: { frd, chat, lock } }));
      }
      // 封禁缓存失效（P5-010 DEV-18，DS 门二 Q2 附带项）：ext 在 lift 清位后调用，只清 banLink 缓存、不动会话
      if (req.method === 'POST' && p === '/internal/ban-cache-flush') {
        let secret = ''; try { secret = fs.readFileSync(process.env.QFLIC_SECRET_FILE || '/opt/qfremote-license/internal.secret', 'utf8').trim(); } catch (e) {}
        if (!secret || req.headers['x-qf-internal-secret'] !== secret) { res.writeHead(403, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, code: 'INTERNAL_AUTH' })); }
        const body = await readBody(req);
        const target = String(body.username || '').trim().toLowerCase();
        if (!target) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, code: 'VALIDATION' })); }
        purgeBanLinkCache(target);
        res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true }));
      }
      if (req.method === 'POST' && p === '/internal/support/decide') {
        let secret = ''; try { secret = fs.readFileSync(process.env.QFLIC_SECRET_FILE || '/opt/qfremote-license/internal.secret', 'utf8').trim(); } catch (e) {}
        if (!secret || req.headers['x-qf-internal-secret'] !== secret) { res.writeHead(403, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, code: 'INTERNAL_AUTH' })); }
        const body = await readBody(req);
        const t = supportStore.getTicket(String(body.ticketId || ''));
        if (!t) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, msg: '工单不存在。' })); }
        if (body.action === 'reply') {
          const text = String(body.text || '').trim();
          if (!text) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, msg: '回复内容不能为空。' })); }
          if (t.status !== 'open') { res.writeHead(409, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, msg: '工单已关闭。' })); }
          t.messages.push({ role: 'agent', name: '人工客服', text, ts: Date.now() });
          t.updatedAt = Date.now(); supportStore.putTicket(t);
          res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true }));
        }
        if (body.action === 'close') {
          t.status = 'closed'; t.updatedAt = Date.now(); supportStore.putTicket(t);
          const sess = supportStore.getSession(t.sessionId);
          if (sess && sess.ticketId === t.id) { sess.ticketId = null; supportStore.putSession(sess); }
          res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true }));
        }
        res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, msg: 'action 须为 reply 或 close。' }));
      }
      if (p === '/support' || p.startsWith('/support/')) {
        await resolveSupportAuth(req, res);
        if (req.method === 'GET' && (p === '/support' || p === '/support/')) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
          res.end(SUPPORT_PAGE);
          return;
        }
        if (await supportRouter(req, res)) return;
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('not found');
        return;
      }
      if (req.method === 'GET' && (p === '/' || p === '/friends')) {
        if (!sessionUser(req)) { await trySso(req, res); } // 已登录控制台 → 先单点登录发会话，页面打开即已登录
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
        res.end(PAGE);
        return;
      }
      if (req.method === 'GET' && p === '/health') return sendJson(res, 200, { ok: true });
      if (req.method === 'GET' && p === '/qf-wrap.html') {
        if (!WRAP_PAGE) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('not found'); }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
        return res.end(WRAP_PAGE);
      }
      if (req.method === 'GET' && p === '/logout-bridge.html') {
        if (!BRIDGE_PAGE) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('not found'); }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
        return res.end(BRIDGE_PAGE);
      }
      // 论坛令牌重定向（2026-10-25 网页端同框修复）：直连 IP 控制台的内嵌
      // 面板里，论坛框先导航到本端点；本端点按既有口径向内网论坛服务换一
      // 次性令牌（整份 Cookie 转发，验真/冻结/退出抑制全在论坛服务判定），
      // 再 302 到论坛公开源的 sso-login 换本站会话并落到 /forum。全程导航
      // 完成，控制台页面不发跨源请求；任何失败回退好友页（其自身有登录态
      // 提示），不签发任何凭据、不放宽任何口径。
      if (req.method === 'GET' && p === '/api/friends/forum-sso-redirect') {
        const cookies = parseCookies(req);
        const back = () => { try { res.writeHead(302, { Location: '/friends', 'Cache-Control': 'no-store' }); res.end(); } catch (e) {} };
        if (!cookies.xid) { back(); return; }
        const body = '{}';
        const tok = await new Promise((resolve) => {
          const fwd = http.request({ hostname: '127.0.0.1', port: 8446, path: '/api/forum/sso-token', method: 'POST', timeout: 8000,
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Cookie: String(req.headers.cookie || ''), 'X-Forwarded-For': clientIp(req) } }, (fr) => {
            let d = '';
            fr.on('data', c => { d += c; if (d.length > 65536) fwd.destroy(); });
            fr.on('end', () => { try { const j = JSON.parse(d); resolve((fr.statusCode === 200 && j && j.ok && j.token) ? String(j.token) : null); } catch (e) { resolve(null); } });
          });
          fwd.on('timeout', () => fwd.destroy());
          fwd.on('error', () => resolve(null));
          fwd.write(body);
          fwd.end();
        });
        if (!tok) { back(); return; }
        const base = await forumPublicBase();
        if (!base) { back(); return; }
        try { res.writeHead(302, { Location: base + '/api/forum/sso-login?token=' + encodeURIComponent(tok), 'Cache-Control': 'no-store' }); res.end(); } catch (e) {}
        return;
      }
      // 论坛令牌中转（2.3.0 M2 线）：直连源包装页与论坛不同源，且浏览器
      // 不会把控制台会话（xid，按主机携带）发去论坛源；包装页把请求发到
      // 本服务（同主机，xid 随请求到达），由本服务把整份 Cookie 原样转发
      // 给内网论坛服务的 sso-token（与软件壳 extRequest 同口径）。验真、
      // 冻结与退出抑制判定全在论坛服务，本端点不签发任何凭据、不放宽
      // 任何口径；无 xid 直接 401，不转发。
      if (req.method === 'POST' && p === '/api/friends/forum-sso-token') {
        const cookies = parseCookies(req);
        if (!cookies.xid) return sendJson(res, 401, { ok: false, msg: '未登录控制台。' });
        const body = '{}';
        const fwd = http.request({ hostname: '127.0.0.1', port: 8446, path: '/api/forum/sso-token', method: 'POST', timeout: 8000,
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Cookie: String(req.headers.cookie || ''), 'X-Forwarded-For': clientIp(req) } }, (fr) => {
          let d = '';
          fr.on('data', c => { d += c; if (d.length > 65536) fwd.destroy(); });
          fr.on('end', () => { res.writeHead(fr.statusCode || 502, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(d); });
        });
        fwd.on('timeout', () => fwd.destroy());
        fwd.on('error', () => { try { sendJson(res, 502, { ok: false, msg: '论坛服务暂时不可用，请稍后再试。' }); } catch (e) {} });
        fwd.write(body);
        fwd.end();
        return;
      }
      if (p === '/lock' || p.startsWith('/lock/')) return await lockBridge.handle(req, res);
      if (req.method === 'POST' && p === '/api/friends/login') return await handleLogin(req, res);
      // 以下接口都要会话（无本服务会话时，先试控制台单点登录）
      let me = sessionUser(req);
      if (!me) me = await trySso(req, res);
      if (!me) return sendJson(res, 401, { ok: false, msg: '请先登录。' });
      if (req.method === 'POST' && p === '/api/friends/logout') {
        const cookies = parseCookies(req);
        const tok = cookies.qfr_frd;
        if (tok) { delete state.sessions[crypto.createHash('sha256').update(tok).digest('hex')]; saveState(); }
        // 手动退出：服务端会话作废 + 浏览器里的会话 cookie 一并清掉 +
        // 落「手动退出」标记，防单点登录在同一控制台会话内自动带回。
        const mark = xidHash(cookies);
        res.setHeader('Set-Cookie', [
          'qfr_frd=; Path=/; Max-Age=0; SameSite=Lax; Secure; HttpOnly',
          'qfr_frd_out=' + (mark || '1') + '; Path=/; Max-Age=' + Math.floor(REMEMBER_TTL_MS / 1000) + '; SameSite=Lax; Secure; HttpOnly'
        ]);
        log({ ev: 'logout', user: me });
        return sendJson(res, 200, { ok: true });
      }
      // 封禁门（P5-010，DS 稿 §3.2）：qfr_frd 已签发会话的每请求判定。客服域
      // （/support/*）与登录/退出在前面已分派，不到此处，天然豁免（定型豁免面）。
      if (me && isBanLinked(me)) {
        try {
          const ck = parseCookies(req);
          if (ck.qfr_frd) { const sid = crypto.createHash('sha256').update(ck.qfr_frd).digest('hex'); if (Object.prototype.hasOwnProperty.call(state.sessions, sid)) { delete state.sessions[sid]; saveState(); } }
        } catch (e) {}
        log({ ev: 'ban-gate-deny', user: me, path: p });
        return sendJson(res, 403, { ok: false, code: 'ACCOUNT_BANNED', msg: '该账号已被封禁。如果你认为封错了，可以在登录页提交申诉。' });
      }
      if (req.method === 'GET' && p === '/api/friends/me') return sendJson(res, 200, Object.assign({ ok: true }, await buildMe(me)));
      if (req.method === 'POST' && p === '/api/friends/search') return await handleSearch(req, res, me);
      if (req.method === 'POST' && p === '/api/friends/request') return await handleRequest(req, res, me);
      if (req.method === 'POST' && p === '/api/friends/respond') return await handleRespond(req, res, me);
      if (req.method === 'POST' && p === '/api/friends/remove') return await handleRemove(req, res, me);
      if (req.method === 'POST' && p === '/api/friends/share') return await handleShare(req, res, me);
      if (req.method === 'POST' && p === '/api/friends/unshare') return await handleUnshare(req, res, me);
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found');
    } catch (e) {
      try { sendJson(res, 500, { ok: false, msg: '服务器暂时出现问题，请稍后再试。' }); } catch (e2) {}
      log({ ev: 'handler-error', err: String(e && e.message) });
    }
  });
  server.listen(cfg.port || 8445, cfg.bind || '0.0.0.0', () => {
    console.log('qfremote-friends listening on ' + (cfg.bind || '0.0.0.0') + ':' + (cfg.port || 8445));
  });
  writeFriendsGateFile();
  reconcile().catch(() => {});
  const timer = setInterval(() => { reconcile().catch(() => {}); }, 60000);
  if (timer.unref) timer.unref();
}

if (require.main === module) main();
module.exports = { newState, areFriends, setFriends, unsetFriends, findRequest, getBlock, setBlock, planRequest, requestQuota, searchQuota, sharesBetween, exportPairs, tierRights, execOk, isGuardName, GUARD, isFrozenSiteadmin, RIGHTS_VIEW, RIGHTS_OPERATE, COOLDOWN_MS };
