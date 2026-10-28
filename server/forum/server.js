'use strict';
/*
 * QFRemote 论坛服务（forum-svc，一期）
 * ================================================================
 * 定位：方案 forum-service-plan.md 二。独立小服务，与 register-svc 同款形态：
 * Node 内置模块为主、自有 JSON 数据、systemd 常驻、本机 8446 不开公网，
 * 经本机 nginx 反代挂临时通道 /forum 与 /api/forum。
 *
 * 账号与验密（与好友/聊天同一基准，不自建密码校验）：
 *  - 登录用 QFRemote 同一账号+密码；服务以用户本人凭据开 MeshCentral
 *    control.ashx 连接，**收到服务器主动下发的 userinfo 才算验真**
 *    （错密码也会先 open 再被踢，只看 open 会误判——chat 线探针存档口径）。
 *  - 密码只过内存，不落盘、不进日志。验真后发自家会话令牌（只存哈希）。
 *  - 单点登录（2.3.0 H 线）：已登录控制台的用户凭 xid 会话经同一控制通道
 *    验真直接进论坛（POST /api/forum/sso，网页与软件同口径）；软件壳跨源
 *    打开时走一次性令牌（POST /api/forum/sso-token → GET
 *    /api/forum/sso-login?token= 换本站会话，仿 ext 模式，60 秒单次）。
 *    手动退出论坛落 qfr_frm_out 标记，同一控制台会话内不再自动带回。
 *  - 账号状态（冻结=siteadmin 32 位 / 删号=列表缺失）每 5 分钟用服务账号
 *    经官方通道 users 命令对账；不直读、不直写 MeshCentral 库。
 *
 * 审核：发布瞬间机审三档（review.js），处置全程写 modlog.jsonl；
 * 禁言梯度 30 天累计驳回 ≥3→7 天、≥5→30 天、≥8→永久（只禁论坛）；
 * 频率闸门：10 帖/50 回每日、新号 1 小时禁发、新号 <7 天首帖待审。
 * 封禁联动：账号被冻结/删除 → 其内容自动不可见；解冻不自动恢复，
 * 站长在复核面手动 restore 才重新显示。
 *
 * 管理面（代审队列）：/api/forum/admin/*，凭 config.adminToken
 * （请求头 x-forum-admin）或站长会话访问；动作为 queue/review/restore/
 * delete/mute/words/sync，供站长页面与代审 cron 共用，全部留痕。
 *
 * 论坛补齐（2026-10-25 站长令：功能参照 QFClash 论坛，风格口径按本站）：
 *  - 作者删除自己的帖子/回复（软删，与管理删帖同源，留痕 authorSelf）；
 *  - 浏览计数同主体 6 小时去重；分享计数（同主体同帖 1 小时去重＋每小时
 *    总频控 20 次）；主列表支持 sort=hot（获赞优先，借 QFClash 营地内排序）；
 *  - 论坛昵称（profiles.nickname，过机审才生效，展示代替账号名，账号名
 *    仍是内部与管理口径）；站长作者带「官方」标记；公开作者页；
 *  - 「我的」补个人统计与回复所属帖标题；管理面加审核日志查询。
 *  未照搬：营地、外站精选、论坛积分与千赞奖励（理由见本线完工回报）。
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const R = require('./review.js');
const WORDS_SEED = require('./words-seed.js');

// ---- 站长 API 事件队列推送（#31：论坛待审统一入队 ext 事件簿；尽力而为，失败不拦业务） ----
let _licSecretCache = '';
function licInternalSecret() {
  if (_licSecretCache) return _licSecretCache;
  try { _licSecretCache = fs.readFileSync(process.env.QFLIC_SECRET_FILE || '/opt/qfremote-license/internal.secret', 'utf8').trim(); } catch (e) {}
  return _licSecretCache;
}
// DEV-18/G-02/G-03（DS 门二）：forum 改镜像直读优先（与 friends/chat 同源扁平表），
// ext 回源仅作镜像不可读时兜底；消除 syncAccounts 串行回源与写口 300 秒窗口。
const FORUM_MIRROR_FILE = process.env.QFLIC_MIRROR_FILE || '/opt/qfremote-friends/data/provider-mirror/license/status.json'; // DEV-20：与 license-core mirrorFile 默认值同源（原写 /opt/qfremote-license/status.json 不存在，L5b 抓获）
let _mirrorFCache = { mtimeMs: -1, size: -1, data: null };
let _mirrorFErrLogAt = 0;
function readMirrorF() {
  try {
    const st = fs.statSync(FORUM_MIRROR_FILE);
    if (_mirrorFCache.data && _mirrorFCache.mtimeMs === st.mtimeMs && _mirrorFCache.size === st.size) return _mirrorFCache.data;
    const data = JSON.parse(fs.readFileSync(FORUM_MIRROR_FILE, 'utf8'));
    _mirrorFCache = { mtimeMs: st.mtimeMs, size: st.size, data };
    return data;
  } catch (e) {
    const t = Date.now(); if (t - _mirrorFErrLogAt > 60000) { _mirrorFErrLogAt = t; try { console.error(JSON.stringify({ ev: 'ban-mirror-read-failed', svc: 'forum', err: String(e && e.message) })); } catch (e2) {} }
    return null;
  }
}
function mirrorRecF(m, u) {
  let rec = m ? m[u] : undefined;
  if (!rec && m && m.accounts && typeof m.accounts === 'object' && !Array.isArray(m.accounts)) rec = m.accounts[u];
  return rec;
}
// DEV-23/Q1：原两态 readBanLinkMirrorF 已无任何调用方（全仓 grep 仅定义行），删除以消除「两态仍被风控误用」的歧义；风控一律走 banLinkTriF/fetchBanLink。
try { if (fs.existsSync(FORUM_MIRROR_FILE) && !readMirrorF()) console.error(JSON.stringify({ ev: 'ban-mirror-unreadable', svc: 'forum', at: 'startup', file: FORUM_MIRROR_FILE })); } catch (e) {} // DEV-21/Q4(a)＋DEV-22/F5：启动自检；文件尚不存在（首装未生成）不报，存在但不可读才显形
function banLinkTriF(username) { // DEV-21：三态——true=镜像明示封禁；false=镜像明示未封禁；null=镜像不可读（未知，风控点不得当作未封禁）
  const u = String(username || '').trim().toLowerCase();
  if (!u) return null; // DEV-22/F3：空用户名＝未知，不得判「明示未封禁」
  const m = readMirrorF();
  if (!m) return null;
  const rec = mirrorRecF(m, u);
  if (!rec) return null; // DEV-23/#1：缺条目＝未知（可能写失败/滞后），不得冒充「明示未封禁」让写口门让位
  return rec.banLink === true;
}
function sweepBanLinkCacheF(now) { // G-09 同型
  if (banLinkCacheF.size <= 5000) return;
  for (const [k, v] of banLinkCacheF) { if (!v || now - v.at >= BANLINK_TTL_F) banLinkCacheF.delete(k); }
}
// ===== 封禁功能门（P5-010，DS 稿 §6.1；DEV-13：forum 无 postInternalJson，
// 按 pushReviewEvent 同式 raw http 新写 promise 版；失败回落缓存值）=====
const banLinkCacheF = new Map();
const BANLINK_TTL_F = 5000;
function fetchBanLink(username) {
  const u = String(username || '').trim().toLowerCase();
  if (!u) return Promise.resolve(false);
  const hit = banLinkCacheF.get(u);
  const now = Date.now();
  sweepBanLinkCacheF(now);
  if (hit && (now - hit.at) < BANLINK_TTL_F) return Promise.resolve(hit.val);
  const m = readMirrorF(); // DEV-18：镜像可读即以镜像为准（写盘同步于 applyBan/liftBan，无窗口）
  if (m) { const rec = mirrorRecF(m, u); const val = !!(rec && rec.banLink === true); banLinkCacheF.set(u, { val, at: now }); return Promise.resolve(val); }
  return new Promise((resolve) => {
    const fallback = () => { const v = hit ? hit.val : false; banLinkCacheF.set(u, { val: v, at: Date.now() }); resolve(v); }; // DEV-18/G-03：失败结果也短缓存，防 ext 不可达时逐请求满超时
    const secret = licInternalSecret();
    if (!secret) return fallback();
    const data = Buffer.from(JSON.stringify({ username: u }));
    const rq = http.request({ hostname: '127.0.0.1', port: 8448, path: '/internal/license/account-link', method: 'POST', timeout: 1500,
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length, 'x-qf-internal-secret': secret } }, (rs) => {
      let d = ''; rs.on('data', (c) => { d += c; }); rs.on('end', () => {
        try { const j = JSON.parse(d); const val = !!(j && j.banLink === true); banLinkCacheF.set(u, { val, at: Date.now() }); resolve(val); }
        catch (e) { fallback(); }
      });
    });
    rq.on('timeout', () => { try { rq.destroy(); } catch (e) {} fallback(); });
    rq.on('error', () => fallback());
    rq.write(data); rq.end();
  });
}
function pushReviewEvent(kind, id, summary) {
  try {
    const secret = licInternalSecret(); if (!secret) return;
    const data = Buffer.from(JSON.stringify({ type: 'forum', refId: kind + ':' + id, summary: summary || {} }));
    const rq = http.request({ hostname: '127.0.0.1', port: 8448, path: '/internal/events/push', method: 'POST', timeout: 800,
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length, 'x-qf-internal-secret': secret } }, (rs) => { rs.resume(); });
    rq.on('error', () => {}); rq.on('timeout', () => { try { rq.destroy(); } catch (e) {} });
    rq.write(data); rq.end();
  } catch (e) {}
}
function resolveReviewEvent(kind, id, actor, result) {
  try {
    const secret = licInternalSecret(); if (!secret) return;
    const data = Buffer.from(JSON.stringify({ type: 'forum', refId: kind + ':' + id, actor: actor || '', result: result || '' }));
    const rq = http.request({ hostname: '127.0.0.1', port: 8448, path: '/internal/events/resolve', method: 'POST', timeout: 800,
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length, 'x-qf-internal-secret': secret } }, (rs) => { rs.resume(); });
    rq.on('error', () => {}); rq.on('timeout', () => { try { rq.destroy(); } catch (e) {} });
    rq.write(data); rq.end();
  } catch (e) {}
}

const CONFIG_PATH = process.env.QFFORUM_CONFIG || '/opt/qfremote-forum/config.json';
let _WebSocket = null;
function loadWebSocket() {
  if (_WebSocket) return _WebSocket;
  try { _WebSocket = require('/opt/meshcentral/node_modules/ws'); }
  catch (e) { _WebSocket = require('ws'); }
  return _WebSocket;
}

const BOARDS = [
  { key: 'announcements', name: '公告', desc: '官方公告，仅官方可发帖' },
  { key: 'help', name: '使用求助', desc: '安装、连接、断线等问题' },
  { key: 'suggestions', name: '建议与反馈', desc: '涉及账号本人的事项请通过官网留言或官方客服处理，请勿公开讨论' },
  { key: 'general', name: '综合讨论', desc: '其他话题' }
];
const SITEADMIN_FULL = 4294967295;
// 同框集成（2.3.0 M 线）：论坛页要能被自家控制台同框嵌入——Windows 壳的
// 保活视图（顶层导航，不受 frame-ancestors 约束）与网页版控制台的包装页
// （iframe 子框，受约束）。页面响应统一带 frame-ancestors 白名单：仅
// 自家来源——'self'（论坛自身源，含隧道源同源控制台）、控制台直连源，
// 以及请求实际到达时的转发源（隧道轮换时自动跟随，不写死隧道域名）。
const FRAME_EXTRA_ORIGINS = ['https://54.248.9.192:8443', 'https://54.248.9.192:8445'];
function frameAncestorsOf(req) {
  const set = ["'self'"].concat(FRAME_EXTRA_ORIGINS);
  try {
    const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
    if (host) { const o = proto + '://' + host; if (!set.includes(o)) set.push(o); }
  } catch (e) { /* 取不到转发头时用固定白名单 */ }
  return set.join(' ');
}
function pageHeadersOf(req) {
  return { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': 'frame-ancestors ' + frameAncestorsOf(req) };
}
const SITERIGHT_LOCKED = 32;
const OWNER_ACCOUNT = '718983610';
const OFFICIAL_ACCOUNT = 'qf-official';
// 站长账号的 siteadmin 是全权值 4294967295，第 32 位（冻结位）天然为 1，
// 冻结判定必须对站长账号精确豁免，否则登录三入口与账号对账都会把他误判冻结。
// 与好友/聊天服务的站长豁免同口径：只认这一个账号，其他账号（含其他全权号）不豁免。
const isFrozen = (siteadmin, username) => (((siteadmin || 0) & SITERIGHT_LOCKED) !== 0) && String(username || '').toLowerCase() !== OWNER_ACCOUNT;

function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}
function saveJson(file, obj) {
  fs.writeFileSync(file + '.tmp', JSON.stringify(obj));
  fs.renameSync(file + '.tmp', file);
}
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const esc = (s) => String(s || '').slice(0, 300);
// MeshCentral 的 creation 是「秒」级时间戳（实测 1792814659 vs Date.now() 毫秒），
// 进本服务所有年龄计算前一律换算成毫秒。
const toMs = (t) => { if (!t) return null; const n = Number(t); return n < 1e12 ? n * 1000 : n; };

// ---------------- MeshCentral 官方通道 ----------------
function mcConnect(mcUrl, user, pass) {
  return new Promise((resolve, reject) => {
    const WebSocket = loadWebSocket();
    const auth = Buffer.from(user).toString('base64') + ',' + Buffer.from(pass).toString('base64');
    let ws;
    try { ws = new WebSocket(mcUrl, { rejectUnauthorized: false, headers: { 'x-meshauth': auth } }); }
    catch (e) { return reject(e); }
    const timer = setTimeout(() => { try { ws.close(); } catch (e) {} reject(new Error('timeout')); }, 8000);
    ws.on('message', (data) => {
      let m; try { m = JSON.parse(data.toString()); } catch (e) { return; }
      if (m && m.action === 'userinfo' && m.userinfo) { clearTimeout(timer); resolve({ ws, userinfo: m.userinfo }); }
    });
    ws.on('error', () => { clearTimeout(timer); reject(new Error('conn-error')); });
    ws.on('close', () => { clearTimeout(timer); reject(new Error('closed')); });
  });
}
// —— 控制台会话验真（单点登录，2.3.0 H 线新增，与好友/聊天/扩展同口径）——
// 会话绑 IP 的转发修复原理见好友服务 server.js 的 sessionIpFromCookie
// 注释：候选 = 会话自带 IP → 请求来源 IP → 无转发原样，被秒拒才换下一个。
function sessionIpFromCookie(cookieHeader) {
  try {
    const jar = {};
    String(cookieHeader || '').split(';').forEach((p2) => { const i = p2.indexOf('='); if (i > 0) jar[p2.slice(0, i).trim()] = p2.slice(i + 1).trim(); });
    if (!jar.xid) return null;
    const obj = JSON.parse(Buffer.from(String(jar.xid), 'base64').toString('utf8'));
    const ip = obj && obj.ip;
    if (typeof ip === 'string' && ip.length <= 64 && /^[0-9a-fA-F.:%[\]]+$/.test(ip)) return ip;
  } catch (e) { /* 解不出就走后备候选 */ }
  return null;
}
function mcConnectCookieOnce(mcUrl, cookieHeader, fwdIp) {
  return new Promise((resolve, reject) => {
    const WebSocket = loadWebSocket();
    const headers = { Cookie: cookieHeader, Origin: 'https://127.0.0.1:8443' };
    if (fwdIp) headers['X-Forwarded-For'] = fwdIp;
    let ws;
    try { ws = new WebSocket(mcUrl, { rejectUnauthorized: false, headers }); }
    catch (e) { return reject(e); }
    const timer = setTimeout(() => { try { ws.close(); } catch (e) {} reject(new Error('timeout')); }, 8000);
    ws.on('message', (data) => {
      let m; try { m = JSON.parse(data.toString()); } catch (e) { return; }
      if (m && m.action === 'userinfo' && m.userinfo) { clearTimeout(timer); resolve({ ws, userinfo: m.userinfo }); return; }
      if (m && m.action === 'close') { clearTimeout(timer); reject(new Error('session-rejected')); }
    });
    ws.on('error', () => { clearTimeout(timer); reject(new Error('conn-error')); });
    ws.on('close', () => { clearTimeout(timer); reject(new Error('closed')); });
  });
}
async function verifyConsoleSession(mcUrl, cookieHeader, clientIpHint) {
  if (!cookieHeader || !/(^|;\s*)xid=/.test(cookieHeader)) return { ok: false };
  const parts = [];
  String(cookieHeader).split(';').forEach((s) => { const t = s.trim(); if (t.startsWith('xid=') || t.startsWith('xid.sig=')) parts.push(t); });
  const cookieStr = parts.join('; ');
  const candidates = [];
  const sip = sessionIpFromCookie(cookieStr);
  if (sip) candidates.push(sip);
  if (clientIpHint && !candidates.includes(clientIpHint)) candidates.push(clientIpHint);
  candidates.push(null);
  for (const ip of candidates) {
    try {
      const { ws, userinfo } = await mcConnectCookieOnce(mcUrl, cookieStr, ip);
      try { ws.close(); } catch (e) {}
      return { ok: true, userinfo };
    } catch (e) {
      if (e && e.message === 'timeout') break;
    }
  }
  return { ok: false };
}
// 以用户本人凭据验密：收到 userinfo = 验真成功
async function verifyPassword(mcUrl, username, password) {
  try {
    const { ws, userinfo } = await mcConnect(mcUrl, username, password);
    try { ws.close(); } catch (e) {}
    return { ok: true, userinfo };
  } catch (e) { return { ok: false }; }
}
// 以服务账号发一条控制命令并等带 responseid 的回执
function controlCommand(mcUrl, svcUser, svcPass, command) {
  return new Promise(async (resolve) => {
    let conn;
    try { conn = await mcConnect(mcUrl, svcUser, svcPass); }
    catch (e) { return resolve({ ok: false, error: 'auth-failed' }); }
    const { ws } = conn;
    const rid = command.responseid || 'qffrm';
    const timer = setTimeout(() => { try { ws.close(); } catch (e) {} resolve({ ok: false, error: 'timeout' }); }, 10000);
    ws.on('message', (data) => {
      let m; try { m = JSON.parse(data.toString()); } catch (e) { return; }
      if (m && m.action === command.action && (command.action === 'users' ? Array.isArray(m.users) : m.responseid === rid)) {
        clearTimeout(timer);
        try { ws.close(); } catch (e) {}
        resolve({ ok: true, msg: m });
      }
    });
    ws.on('close', () => { clearTimeout(timer); resolve({ ok: false, error: 'closed' }); });
    try { ws.send(JSON.stringify(command)); } catch (e) { clearTimeout(timer); resolve({ ok: false, error: 'send-failed' }); }
  });
}

// ---------------- 主服务 ----------------
function main() {
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const dataDir = cfg.dataDir, logFile = cfg.logFile;
  // 官网留言自家通道（分家后独立，见 feedback.js）：与论坛业务无关，仅同进程承载
  const feedback = require('./feedback.js').createFeedback({ dataDir, logDir: path.dirname(logFile) });
  const PAGE = fs.readFileSync(path.join(__dirname, 'forum.html'), 'utf8');
  const files = {
    posts: path.join(dataDir, 'posts.json'),
    replies: path.join(dataDir, 'replies.json'),
    profiles: path.join(dataDir, 'profiles.json'),
    sessions: path.join(dataDir, 'sessions.json'),
    words: path.join(dataDir, 'words.json'),
    views: path.join(dataDir, 'views.json'),
    shares: path.join(dataDir, 'shares.json')
  };
  let postsDb = loadJson(files.posts, { seq: 0, items: {} });
  let repliesDb = loadJson(files.replies, { seq: 0, items: {} });
  let profiles = loadJson(files.profiles, {});
  let sessions = loadJson(files.sessions, {});
  let wordsDb = loadJson(files.words, null);
  if (!wordsDb) { wordsDb = JSON.parse(JSON.stringify(WORDS_SEED)); saveJson(files.words, wordsDb); }

  // B 设计 4.1/S1 就绪闸：posts/replies 两库文件独立 read+parse 成功才为真，闸假时每次调用先懒重试。
  // 单独 parse 而不用 loadJson（loadJson 失败会给默认值、无法判定成功）；结构不含 items 同样视为未就绪，
  // 防止坏文件被当成空库导致 exists 全量 false → 误销账。
  let forumDbReady = false;
  let forumDbCheckAt = 0;
  function checkForumDbReady() {
    if (forumDbReady) return true;
    const nowCk = Date.now();
    if (nowCk - forumDbCheckAt < 1000) return false; // 门二 F4：未就绪重试节流，避免每次请求都同步重读两库
    forumDbCheckAt = nowCk;
    try {
      const p = JSON.parse(fs.readFileSync(files.posts, 'utf8'));
      const r = JSON.parse(fs.readFileSync(files.replies, 'utf8'));
      if (p && p.items && typeof p.items === 'object' && !Array.isArray(p.items) && r && r.items && typeof r.items === 'object' && !Array.isArray(r.items)) forumDbReady = true;
    } catch (e) { /* 未就绪：保持假，下次 exists 调用再试 */ }
    return forumDbReady;
  }
  checkForumDbReady();
  let compiled = R.compileWords(wordsDb);
  // 补齐新增账本：浏览去重 {postId:{actorHash:ms}}、分享账本 {byPost:{postId:{actorHash:ms}}, byActor:{actorHash:[ms]}}
  let viewsDb = loadJson(files.views, {});
  let sharesDb = loadJson(files.shares, { byPost: {}, byActor: {} });
  if (!sharesDb.byPost) sharesDb.byPost = {};
  if (!sharesDb.byActor) sharesDb.byActor = {};
  for (const it of Object.values(postsDb.items)) { if (typeof it.shares !== 'number') it.shares = 0; }

  const savePosts = () => saveJson(files.posts, postsDb);
  const saveReplies = () => saveJson(files.replies, repliesDb);
  const saveProfiles = () => saveJson(files.profiles, profiles);
  const saveSessions = () => saveJson(files.sessions, sessions);
  const saveViews = () => saveJson(files.views, viewsDb);
  const saveShares = () => saveJson(files.shares, sharesDb);
  function modlog(obj) {
    const line = JSON.stringify(Object.assign({ at: new Date().toISOString() }, obj)) + '\n';
    try { fs.appendFileSync(logFile, line); } catch (e) { /* 日志写不了不拦正事 */ }
  }
  function profileOf(name) {
    if (!profiles[name]) profiles[name] = { accountCreatedAt: null, accountStatus: 'ok', accountBad: false, banHiddenOutstanding: false, mute: { until: null, permanent: false }, rejectEvents: [], firstDone: false };
    return profiles[name];
  }
  const isMuted = (p, now) => !!(p && (p.mute.permanent || (p.mute.until && p.mute.until > now)));
  // ---- 补齐共用小工具（计数主体/显示名/官方标记）----
  const VIEW_DEDUPE_MS = 6 * 3600 * 1000;   // 同主体同帖 6 小时内只计一次浏览（QFClash 同口径）
  const SHARE_DEDUPE_MS = 3600 * 1000;      // 同主体同帖 1 小时内分享只计一次
  const SHARE_HOURLY_CAP = 20;              // 同主体每小时最多计 20 次分享（QFClash 同口径）
  const actorKeyOf = (req, sess) => sha256(sess && sess.user ? 'u:' + sess.user : 'g:' + clientIp(req));
  const displayNameOf = (name) => { const p = profiles[name]; return (p && p.nickname) ? p.nickname : name; };
  // 「官方」徽标只认两个账号：站长本人与官方发布号 qf-official（站长 2026-10-25 15:25 令），其余任何账号不认。
  const isOfficialAuthor = (name) => { const n = String(name || '').toLowerCase(); return n === OWNER_ACCOUNT || n === OFFICIAL_ACCOUNT; };
  function applyRejection(name, now) {
    const p = profileOf(name);
    p.rejectEvents.push(now);
    p.rejectEvents = p.rejectEvents.filter(t => now - t < 30 * 86400000);
    const n = p.rejectEvents.length;
    if (n >= 8) { p.mute.permanent = true; p.mute.until = null; }
    else if (n >= 5) p.mute.until = Math.max(p.mute.until || 0, now + 30 * 86400000);
    else if (n >= 3) p.mute.until = Math.max(p.mute.until || 0, now + 7 * 86400000);
    saveProfiles();
    return { count30d: n, mute: p.mute };
  }
  // firstDone 统一重算（P8 K-04 甲案口径，2026-10-26 主会话裁定）：作者名下已有
  // 「已公开」submission 且当前无「待审」submission 时，才视为新号首审完成（置真）；
  // 仍有待审件、或全部被驳无一公开时保持假。只置真不回置（存量回置走订正脚本、
  // 另行批准）；已删除件不计入（与管理队列 adminQueue 的口径一致）。检查点只设在
  // adminReview 裁定落定后一处，approve/reject 两路都触发——驳回最后一件待审件
  // 同样可能使条件成立（如次帖已先通过、首帖最后被驳）。直读 profiles 不经
  // profileOf：裁定路径无建档语义，避免给无档作者凭空建档。
  function recomputeFirstDone(name) {
    const p = profiles[name];
    if (!p || p.firstDone) return;
    let hasPublished = false, hasPending = false;
    for (const db of [postsDb, repliesDb]) {
      for (const it of Object.values(db.items)) {
        if (it.author !== name || it.deleted) continue;
        if (it.status === 'published') hasPublished = true;
        else if (it.status === 'pending') hasPending = true;
      }
    }
    if (hasPublished && !hasPending) { p.firstDone = true; saveProfiles(); }
  }

  // ---- 账号对账（官方通道 users） ----
  let lastUsers = null; // Map name -> {siteadmin, creation, _id}
  let _syncRunning = false;
  async function syncAccounts(actor) {
    if (_syncRunning) return { ok: false, skipped: 'running' }; // DEV-18/G-03：防定时器与手动触发重叠
    _syncRunning = true;
    try { return await syncAccountsImpl(actor); } finally { _syncRunning = false; }
  }
  async function syncAccountsImpl(actor) {
    const res = await controlCommand(cfg.mcUrl, cfg.svcUser, cfg.svcPass, { action: 'users', responseid: 'qffrm-users' });
    if (!res.ok) { modlog({ actor: actor || 'system', action: 'sync-failed', detail: res.error }); return { ok: false, error: res.error }; }
    const map = new Map();
    for (const u of res.msg.users || []) {
      // 对账键必须是「登录名」：MeshCentral 用户对象的 name 是显示名（可与登录名不同，
      // 如站长号 name 为 Wayne），登录名只在 _id（user//<登录名>）里。用 name 构图会把
      // 显示名≠登录名的账号永远误判为 gone（2026-10-25 站长号实撞，已修复）。
      const idStr = String(u._id || '');
      const login = idStr.startsWith('user//') ? idStr.slice('user//'.length) : String(u.name || '');
      const nm = login.toLowerCase();
      if (nm && nm !== '~') map.set(nm, { siteadmin: u.siteadmin || 0, creation: u.creation || null, _id: u._id });
    }
    lastUsers = map;
    const now = Date.now();
    let hidden = 0, episodes = 0;
    const names = new Set([...Object.keys(profiles), ...Object.values(postsDb.items).map(p => p.author), ...Object.values(repliesDb.items).map(r => r.author)]);
    for (const name of names) {
      if (!name) continue;
      const p = profileOf(name);
      const u = map.get(name);
      if (u && u.creation) p.accountCreatedAt = toMs(u.creation);
      const banLinked = await fetchBanLink(name);
      const bad = banLinked ? 'banned' : (!u ? 'gone' : (isFrozen(u.siteadmin, name) ? 'frozen' : null));
      if (bad && !p.accountBad) {
        // 进入异常集：其内容自动不可见（不删，解冻不自动恢复）
        p.accountBad = true; p.accountStatus = bad; episodes++;
        for (const it of Object.values(postsDb.items)) if (it.author === name && !it.deleted && !it.banHidden) { it.banHidden = true; hidden++; }
        for (const it of Object.values(repliesDb.items)) if (it.author === name && !it.deleted && !it.banHidden) { it.banHidden = true; hidden++; }
        p.banHiddenOutstanding = true;
        modlog({ actor: 'system', action: 'ban-hide', author: name, detail: bad, hidden });
      } else if (bad) {
        p.accountStatus = bad;
      } else if (!bad && p.accountBad) {
        p.accountBad = false; p.accountStatus = 'ok';
        // 名下已无任何被隐藏内容时，「待恢复」标记与事实不符，一并清掉；
        // 仍有隐藏内容的保持标记不动，继续等站长手动恢复（原语义不变）。
        const stillHidden = Object.values(postsDb.items).some(it => it.author === name && it.banHidden) || Object.values(repliesDb.items).some(it => it.author === name && it.banHidden);
        if (!stillHidden) p.banHiddenOutstanding = false;
        modlog({ actor: 'system', action: 'unban-no-autorestore', author: name, detail: '内容保持不可见，等站长手动恢复' });
      } else {
        p.accountStatus = 'ok';
      }
    }
    savePosts(); saveReplies(); saveProfiles();
    return { ok: true, users: map.size, hidden, episodes };
  }

  // ---- 会话 ----
  function sessionOf(req) {
    const cookies = {};
    String(req.headers.cookie || '').split(';').forEach(p2 => { const i = p2.indexOf('='); if (i > 0) cookies[p2.slice(0, i).trim()] = p2.slice(i + 1).trim(); });
    const tok = cookies.qfr_frm;
    if (!tok) return null;
    const s = sessions[sha256(tok)];
    if (!s || s.exp <= Date.now()) return null;
    return { user: s.user, isAdmin: !!s.isAdmin, accountCreatedAt: s.accountCreatedAt || null };
  }
  function isAdminReq(req) {
    if (cfg.adminToken && req.headers['x-forum-admin'] === cfg.adminToken) return { via: 'token', reviewer: String(req.headers['x-forum-reviewer'] || 'admin-token').slice(0, 40) };
    const s = sessionOf(req);
    if (s && s.isAdmin) return { via: 'session', reviewer: 'webmaster' };
    return null;
  }
  // ---- 单点登录（2.3.0 H 线）：凭控制台会话直接进论坛，不再输第二次密码 ----
  // 手动退出标记与好友/聊天/扩展同口径：退出论坛后，同一控制台会话内不再
  // 自动带回；标记值 = 当时 xid 的哈希，控制台重新登录换新会话后自动失效，
  // 或在论坛重新输账号密码登录时清除。
  const ssoTokens = new Map(); // token -> {user, isAdmin, accountCreatedAt, exp}（60 秒单次）
  function parseCookiesOf(req) {
    const cookies = {};
    String(req.headers.cookie || '').split(';').forEach(p2 => { const i = p2.indexOf('='); if (i > 0) cookies[p2.slice(0, i).trim()] = p2.slice(i + 1).trim(); });
    return cookies;
  }
  function xidHashOf(req) {
    const c = parseCookiesOf(req);
    if (!c.xid) return '';
    return sha256(String(c.xid) + '.' + String(c['xid.sig'] || ''));
  }
  function ssoSuppressed(req) {
    const c = parseCookiesOf(req);
    if (!c.qfr_frm_out) return false;
    if (!c.xid) return true;
    return c.qfr_frm_out === xidHashOf(req);
  }
  function issueForumSession(res, username, ui, remember) {
    const now = Date.now();
    const ttlMs = remember === true ? 30 * 24 * 3600 * 1000 : (cfg.sessionTtlMs || 43200000);
    const tok = crypto.randomBytes(32).toString('hex');
    const isAdmin = (ui.siteadmin || 0) === SITEADMIN_FULL;
    sessions[sha256(tok)] = { user: username, isAdmin, accountCreatedAt: toMs(ui.creation), exp: now + ttlMs };
    saveSessions();
    const p = profileOf(username);
    if (ui.creation) p.accountCreatedAt = toMs(ui.creation);
    saveProfiles();
    // 会话 cookie 用 SameSite=None; Secure（2.3.0 M2 线）：论坛要被自家
    // 控制台包装页以跨站 iframe 嵌入，Lax 的 Set-Cookie 在第三方上下文
    // 里会被浏览器丢弃、静默登录落不了盘；写接口全是 JSON POST，跨站
    // 伪造靠 CORS 预检挡住。本地明文调试（cookieSecure=false）退回 Lax。
    res.setHeader('Set-Cookie', [
      'qfr_frm=' + tok + '; Path=/; Max-Age=' + Math.floor(ttlMs / 1000) + '; HttpOnly' + (cfg.cookieSecure === false ? '; SameSite=Lax' : '; SameSite=None; Secure'),
      'qfr_frm_out=; Path=/; Max-Age=0; HttpOnly'
    ]);
    return { isAdmin };
  }
  async function handleSso(req, res) {
    if (ssoSuppressed(req)) return sendJson(res, 401, { ok: false, msg: '您已手动退出论坛，请重新输入账号和密码登录。' });
    const v = await verifyConsoleSession(cfg.mcUrl, String(req.headers.cookie || ''), clientIp(req));
    if (!v.ok) return sendJson(res, 401, { ok: false, msg: '未登录控制台。' });
    const ui = v.userinfo || {};
    const username = String(ui._id || '').replace(/^user\/[^/]*\//, '').toLowerCase();
    if (!username) return sendJson(res, 401, { ok: false, msg: '未登录控制台。' });
    if (await fetchBanLink(username)) return sendJson(res, 403, { ok: false, msg: '该账号已被封禁，请联系站长申诉。' });
    if (isFrozen(ui.siteadmin, username)) return sendJson(res, 403, { ok: false, msg: '该账号已被冻结，请联系站长。' });
    const issued = issueForumSession(res, username, ui, false);
    modlog({ actor: 'system', action: 'sso-login', author: username });
    // issueForumSession 已 setHeader(Set-Cookie)，这里手动写头保留它
    const body = JSON.stringify({ ok: true, user: username, isAdmin: issued.isAdmin });
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(body);
  }
  async function handleSsoToken(req, res) {
    const cors = ssoCorsHeaders(req);
    if (ssoSuppressed(req)) return sendJson(res, 401, { ok: false, msg: '您已手动退出论坛，请重新登录后再试。' }, cors);
    const v = await verifyConsoleSession(cfg.mcUrl, String(req.headers.cookie || ''), clientIp(req));
    if (!v.ok) return sendJson(res, 401, { ok: false, msg: '登录已过期，请重新登录后再试。' }, cors);
    const ui = v.userinfo || {};
    const username = String(ui._id || '').replace(/^user\/[^/]*\//, '').toLowerCase();
    if (!username) return sendJson(res, 401, { ok: false, msg: '登录已过期，请重新登录后再试。' }, cors);
    if (await fetchBanLink(username)) return sendJson(res, 403, { ok: false, msg: '该账号已被封禁，请联系站长申诉。' }, cors);
    if (isFrozen(ui.siteadmin, username)) return sendJson(res, 403, { ok: false, msg: '该账号已被冻结，请联系站长。' }, cors);
    const token = crypto.randomBytes(32).toString('hex');
    ssoTokens.set(token, { user: username, isAdmin: (ui.siteadmin || 0) === SITEADMIN_FULL, accountCreatedAt: toMs(ui.creation), exp: Date.now() + 60000 });
    return sendJson(res, 200, { ok: true, token, expiresIn: 60, loginPath: '/api/forum/sso-login?token=' + token }, cors);
  }
  async function handleSsoLogin(req, res, u) { // DEV-18/S-05：兑换时复验 banLink（原仅签发时验，purge 失败时 60 秒内令牌可换出会话）
    const token = u.searchParams.get('token') || '';
    const entry = ssoTokens.get(token);
    if (entry) ssoTokens.delete(token); // 单次使用：取到即作废
    if (!entry || Date.now() > entry.exp) {
      res.writeHead(401, pageHeadersOf(req));
      return res.end('<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>链接已失效 · QFRemote</title></head><body style="font-family:sans-serif;background:#F4F7FB"><div style="max-width:430px;margin:40px auto;background:#fff;border:1px solid #DFE7F2;border-radius:14px;padding:24px 20px"><h1 style="font-size:18px;color:#0B2B5B">这个入口链接已经失效</h1><p style="line-height:1.8;color:#43536a">入口链接仅可使用一次，有效期一分钟。请返回 QFRemote 软件重新打开论坛。</p></div></body></html>');
    }
    if (await fetchBanLink(entry.user)) {
      res.writeHead(403, pageHeadersOf(req));
      return res.end('<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>账号已被封禁 · QFRemote</title></head><body style="font-family:sans-serif;background:#F4F7FB"><div style="max-width:430px;margin:40px auto;background:#fff;border:1px solid #DFE7F2;border-radius:14px;padding:24px 20px"><h1 style="font-size:18px;color:#0B2B5B">该账号已被封禁</h1><p style="line-height:1.8;color:#43536a">封禁期间除客服与申诉外，其他功能不可用。如需申诉，请联系官方客服。</p></div></body></html>');
    }
    issueForumSession(res, entry.user, { siteadmin: entry.isAdmin ? SITEADMIN_FULL : 0, creation: entry.accountCreatedAt ? Math.floor(entry.accountCreatedAt / 1000) : null }, false);
    modlog({ actor: 'system', action: 'sso-login-token', author: entry.user });
    res.writeHead(302, { Location: '/forum', 'Cache-Control': 'no-store', 'Content-Security-Policy': 'frame-ancestors ' + frameAncestorsOf(req) });
    return res.end();
  }

  // ---- 可见性 ----
  function postVisible(it, sess) {
    if (it.deleted) return false;
    if (sess && sess.isAdmin) return true;
    if (sess && sess.user === it.author) return true;
    return it.status === 'published' && !it.banHidden;
  }
  function replyVisible(it, sess) { return postVisible(it, sess); }
  function publicPost(it, sess) {
    const mine = !!(sess && sess.user === it.author);
    return {
      id: it.id, board: it.board, author: it.author, authorName: displayNameOf(it.author), authorOfficial: isOfficialAuthor(it.author), title: it.title, body: it.body,
      status: it.status, reviewCategory: it.status === 'published' ? null : it.reviewCategory,
      createdAt: it.createdAt, views: it.views, likes: it.likes.length, liked: !!(sess && it.likes.includes(sess.user)), shares: it.shares || 0,
      replyCount: Object.values(repliesDb.items).filter(r => r.postId === it.id && !r.deleted && (r.status === 'published' && !r.banHidden || (sess && (sess.isAdmin || sess.user === r.author)))).length,
      reports: sess && sess.isAdmin ? it.reports.length : undefined,
      banHidden: it.banHidden || undefined, mine
    };
  }
  function publicReply(it, sess) {
    return { id: it.id, postId: it.postId, author: it.author, authorName: displayNameOf(it.author), authorOfficial: isOfficialAuthor(it.author), body: it.body, status: it.status, reviewCategory: it.status === 'published' ? null : it.reviewCategory, createdAt: it.createdAt, banHidden: it.banHidden || undefined, reports: sess && sess.isAdmin ? it.reports.length : undefined, mine: !!(sess && sess.user === it.author) };
  }

  // ---- 登录限速（防经论坛口爆破，也护住 MeshCentral 的登录锁定桶） ----
  const loginFails = {}; // key ip|user -> [ms]
  function loginLimited(key, now) {
    const arr = (loginFails[key] || []).filter(t => now - t < 3600000);
    loginFails[key] = arr;
    return arr.length >= 10;
  }

  function sendJson(res, code, obj, extraHeaders) {
    res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, extraHeaders || {}));
    res.end(JSON.stringify(obj));
  }
  // ---- 跨源取令牌（2.3.0 M2 线，直连源论坛同框免登补洞）----
  // 直连 IP 控制台的包装页与论坛不同源：包装页先跨源取一次性令牌
  // （POST /api/forum/sso-token），再让论坛 iframe 走 sso-login 换本站
  // 会话。CORS 只放行自家来源：控制台直连源（8443/8445，见
  // FRAME_EXTRA_ORIGINS）＋请求实际到达时的转发源（隧道源，轮换跟随）
  // ＋论坛自身源；其余 Origin 一律不给放行头（浏览器自然拦下读取，
  // 预检直接 403）。放行只解决「浏览器准许跨源读响应」，验真仍走
  // handleSsoToken 原有的控制台会话校验，口径不放宽。
  function ssoCorsOriginOf(req) {
    const origin = String(req.headers.origin || '');
    if (!origin) return '';
    const allowed = new Set(FRAME_EXTRA_ORIGINS);
    try {
      const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
      const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
      if (host) allowed.add(proto + '://' + host);
    } catch (e) { /* 取不到转发头时用固定白名单 */ }
    return allowed.has(origin) ? origin : '';
  }
  function ssoCorsHeaders(req) {
    const o = ssoCorsOriginOf(req);
    if (!o) return null;
    return { 'Access-Control-Allow-Origin': o, 'Access-Control-Allow-Credentials': 'true', 'Vary': 'Origin' };
  }
  function readBody(req) {
    return new Promise((resolve) => {
      let b = '';
      req.on('data', c => { b += c; if (b.length > 65536) req.destroy(); });
      req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch (e) { resolve({}); } });
      req.on('close', () => resolve({}));
    });
  }
  function clientIp(req) {
    const remote = req.socket.remoteAddress || '';
    if ((remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1') && req.headers['x-forwarded-for']) {
      return String(req.headers['x-forwarded-for']).split(',')[0].trim();
    }
    return remote.replace(/^::ffff:/, '');
  }

  // ---- 发帖/回复共用流水线 ----
  function recentCounts(author, now) {
    const day = R.shanghaiDayKey(now);
    const mine = [...Object.values(postsDb.items), ...Object.values(repliesDb.items)].filter(x => x.author === author);
    const postsToday = Object.values(postsDb.items).filter(x => x.author === author && R.shanghaiDayKey(x.createdAt) === day).length;
    const repliesToday = Object.values(repliesDb.items).filter(x => x.author === author && R.shanghaiDayKey(x.createdAt) === day).length;
    const sameContent = mine.filter(x => now - x.createdAt < 86400000);
    return { postsToday, repliesToday, sameContent };
  }
  function reviewCtxFor(author, title, body, now) {
    const { sameContent } = recentCounts(author, now);
    const hash = sha256(R.normalizeText(title + '\n' + body));
    const titleHash = sha256(R.normalizeText(title || ''));
    return {
      recentSameContent: sameContent.filter(x => x.contentHash === hash).length,
      sameContentWithinHour: sameContent.filter(x => x.contentHash === hash && now - x.createdAt < 3600000).length,
      recentSameTitle: sameContent.filter(x => x.titleHash === titleHash && title).length
    };
  }
  // 返回 {blocked:{code,msg}} 或 {status, review}
  function runGatesAndReview(sess, kind, title, body, now) {
    const p = profileOf(sess.user);
    if (p.accountStatus && p.accountStatus !== 'ok' && !(p.accountStatus === 'banned' && banLinkTriF(sess.user) === false)) { // DEV-21：让位仅当镜像可读且明示未封禁；不可读（null）维持拦截
      // DEV-19/G-02 解封侧：'banned' 是周期 sync 维护的滞后状态，镜像（写盘同步于 lift）说已解封时以镜像为准，不等下一轮 sync
      return { blocked: { code: 403, msg: '您的账号已被冻结或封禁，无法发帖。申诉请联系官方客服，或前往官网留言。' } };
    }
    if (banLinkTriF(sess.user) === true) { // DEV-18/G-02＋DEV-21 三态：不依赖周期 sync 的 accountStatus，封禁即时生效、解封即时恢复
      return { blocked: { code: 403, msg: '您的账号已被冻结或封禁，无法发帖。申诉请联系官方客服，或前往官网留言。' } };
    }
    if (isMuted(p, now)) {
      const until = p.mute.permanent ? '永久禁言' : ('禁言到 ' + new Date(p.mute.until).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }));
      return { blocked: { code: 403, msg: '您已被论坛禁言（至 ' + until + '），仅限制论坛发言，账号与设备不受影响。申诉请联系官方客服，或前往官网留言。' } };
    }
    const { postsToday, repliesToday } = recentCounts(sess.user, now);
    const gate = R.gateCheck({ now, accountCreatedAt: sess.accountCreatedAt || p.accountCreatedAt, kind, postsToday, repliesToday });
    if (!gate.ok) return { blocked: { code: gate.reason === 'too-new' ? 403 : 429, msg: gate.msg } };
    const review = R.reviewContent({ title, body }, compiled, reviewCtxFor(sess.user, title, body, now));
    let status = review.tier === 'A' ? 'published' : (review.tier === 'B' ? 'rejected' : 'pending');
    let category = review.category;
    if (review.tier === 'A' && R.needsFirstPostReview({ now, accountCreatedAt: sess.accountCreatedAt || p.accountCreatedAt, isFirstSubmission: !p.firstDone })) {
      status = 'pending'; category = 'mild';
      review.detail = (review.detail || '') + '+new-first';
    }
    return { status, review, category };
  }

  async function handleLogin(req, res) {
    const now = Date.now();
    const ip = clientIp(req);
    const data = await readBody(req);
    const username = String(data.username || '').toLowerCase().trim();
    const password = String(data.password || '');
    if (!username || !password) return sendJson(res, 400, { ok: false, msg: '请填写账号和密码。' });
    const key = ip + '|' + username;
    if (loginLimited(key, now)) return sendJson(res, 429, { ok: false, msg: '登录失败次数过多，请 1 小时后再试。' });
    const v = await verifyPassword(cfg.mcUrl, username, password);
    if (!v.ok) {
      (loginFails[key] = loginFails[key] || []).push(now);
      modlog({ actor: 'system', action: 'login-fail', author: username, detail: ip });
      return sendJson(res, 401, { ok: false, msg: '账号或密码不正确，请核对后重试。' });
    }
    const ui = v.userinfo || {};
    if (await fetchBanLink(username)) return sendJson(res, 403, { ok: false, msg: '该账号已被封禁，请联系站长申诉。' });
    if (isFrozen(ui.siteadmin, username)) return sendJson(res, 403, { ok: false, msg: '该账号已被冻结，请联系站长。' });
    const ttlMs = data.remember === true ? 30 * 24 * 3600 * 1000 : (cfg.sessionTtlMs || 43200000); // 「记住此设备」：30 天
    const tok = crypto.randomBytes(32).toString('hex');
    const isAdmin = (ui.siteadmin || 0) === SITEADMIN_FULL;
    sessions[sha256(tok)] = { user: username, isAdmin, accountCreatedAt: toMs(ui.creation), exp: now + ttlMs };
    saveSessions();
    const p = profileOf(username);
    if (ui.creation) p.accountCreatedAt = toMs(ui.creation);
    saveProfiles();
    modlog({ actor: 'system', action: 'login-ok', author: username });
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
      // 重新输账号密码登录 = 明确重新进入，一并清掉手动退出标记
      'Set-Cookie': ['qfr_frm=' + tok + '; Path=/; Max-Age=' + Math.floor(ttlMs / 1000) + '; HttpOnly' + (cfg.cookieSecure === false ? '; SameSite=Lax' : '; SameSite=None; Secure'),
        'qfr_frm_out=; Path=/; Max-Age=0; HttpOnly']
    });
    res.end(JSON.stringify({ ok: true, user: username, isAdmin }));
  }

  async function handleCreatePost(req, res, sess) {
    const now = Date.now();
    const data = await readBody(req);
    const board = String(data.board || '');
    const title = String(data.title || '').trim();
    const body = String(data.body || '').trim();
    if (!BOARDS.some(b => b.key === board)) return sendJson(res, 400, { ok: false, msg: '所选板块不存在。' });
    if (board === 'announcements' && !sess.isAdmin && sess.user !== OFFICIAL_ACCOUNT) return sendJson(res, 403, { ok: false, msg: '公告板块仅官方可发帖。' });
    if (!title || title.length > 80) return sendJson(res, 400, { ok: false, msg: '请填写标题，长度为 1 至 80 字。' });
    if (!body || body.length > 5000) return sendJson(res, 400, { ok: false, msg: '请填写正文，长度为 1 至 5000 字。' });
    const out = runGatesAndReview(sess, 'post', title, body, now);
    if (out.blocked) return sendJson(res, out.blocked.code, { ok: false, msg: out.blocked.msg });
    const id = 'p' + (++postsDb.seq);
    const post = {
      id, board, author: sess.user, title, body, status: out.status,
      reviewCategory: out.status === 'published' ? null : out.category, reviewDetail: out.review.detail,
      createdAt: now, views: 0, likes: [], reports: [], banHidden: false, deleted: false,
      contentHash: sha256(R.normalizeText(title + '\n' + body)), titleHash: sha256(R.normalizeText(title))
    };
    postsDb.items[id] = post;
    // firstDone（新号首审完成标记）只许在 submission 实际公开时置真：落库即置真会让
    // 首帖尚在待审/已被驳回期间，同号后续帖绕过新号人工把关直发公开（P8 K-04）。
    // 待审件经人工裁定通过的，在 adminReview 的 approve 分支置真。
    const p = profileOf(sess.user); if (out.status === 'published') p.firstDone = true;
    savePosts(); saveProfiles();
    if (out.status === 'pending') pushReviewEvent('post', id, { kind: 'post', author: sess.user, board, title: String(title).slice(0, 40) });
    modlog({ actor: out.status === 'rejected' ? 'machine' : 'user', action: 'post-' + out.status, targetType: 'post', targetId: id, author: sess.user, category: out.category, detail: out.review.detail, snapshot: esc(title + ' ' + body) });
    if (out.status === 'rejected') {
      const m = applyRejection(sess.user, now);
      return sendJson(res, 200, { ok: false, rejected: true, msg: '本帖未通过审核：内容涉及' + (R.CATEGORIES[out.category] || '违规内容') + '。判定有误可申诉：请联系官方客服，或前往官网留言。', muteCount30d: m.count30d });
    }
    if (out.status === 'pending') return sendJson(res, 200, { ok: true, pending: true, id, msg: '已提交，审核通过后将显示，您可在「我的帖子」中查看状态。' });
    return sendJson(res, 200, { ok: true, id, msg: '发布成功。' });
  }

  async function handleCreateReply(req, res, sess, postId) {
    const now = Date.now();
    const post = postsDb.items[postId];
    if (!post || !postVisible(post, sess)) return sendJson(res, 404, { ok: false, msg: '帖子不存在或不可见。' });
    const data = await readBody(req);
    const body = String(data.body || '').trim();
    if (!body || body.length > 2000) return sendJson(res, 400, { ok: false, msg: '请填写回复内容，长度为 1 至 2000 字。' });
    const out = runGatesAndReview(sess, 'reply', '', body, now);
    if (out.blocked) return sendJson(res, out.blocked.code, { ok: false, msg: out.blocked.msg });
    const id = 'r' + (++repliesDb.seq);
    const reply = {
      id, postId, author: sess.user, body, status: out.status,
      reviewCategory: out.status === 'published' ? null : out.category, reviewDetail: out.review.detail,
      createdAt: now, reports: [], banHidden: false, deleted: false,
      contentHash: sha256(R.normalizeText(body)), titleHash: ''
    };
    repliesDb.items[id] = reply;
    // firstDone 置真时机同发帖路径（P8 K-04）：回复同样计入 submission，仅实际公开才置真。
    const p = profileOf(sess.user); if (out.status === 'published') p.firstDone = true;
    saveReplies(); saveProfiles();
    if (out.status === 'pending') pushReviewEvent('reply', id, { kind: 'reply', author: sess.user, postId });
    modlog({ actor: out.status === 'rejected' ? 'machine' : 'user', action: 'reply-' + out.status, targetType: 'reply', targetId: id, author: sess.user, category: out.category, detail: out.review.detail, snapshot: esc(body) });
    if (out.status === 'rejected') {
      const m = applyRejection(sess.user, now);
      return sendJson(res, 200, { ok: false, rejected: true, msg: '本回复未通过审核：内容涉及' + (R.CATEGORIES[out.category] || '违规内容') + '。判定有误可申诉：请联系官方客服，或前往官网留言。', muteCount30d: m.count30d });
    }
    if (out.status === 'pending') return sendJson(res, 200, { ok: true, pending: true, id, msg: '已提交，审核通过后将显示。' });
    return sendJson(res, 200, { ok: true, id, msg: '回复成功。' });
  }

  function handleReport(req, res, sess) {
    return readBody(req).then(data => {
      const type = data.type === 'reply' ? 'reply' : 'post';
      const db = type === 'post' ? postsDb : repliesDb;
      const it = db.items[String(data.id || '')];
      if (!it || it.deleted) return sendJson(res, 404, { ok: false, msg: '内容不存在。' });
      if (it.author === sess.user) return sendJson(res, 400, { ok: false, msg: '不能举报自己。' });
      if (it.reports.includes(sess.user)) return sendJson(res, 200, { ok: true, msg: '您已举报过该内容。' });
      it.reports.push(sess.user);
      let escalated = false;
      if (it.reports.length >= 2 && it.status === 'published') {
        it.status = 'pending'; it.reviewCategory = 'mild'; it.reviewDetail = 'reports>=2';
        escalated = true;
      }
      if (type === 'post') savePosts(); else saveReplies();
      if (escalated) pushReviewEvent(type, it.id, { kind: type, author: it.author, via: 'reports>=2' });
      modlog({ actor: 'user', action: escalated ? 'report-escalate' : 'report', targetType: type, targetId: it.id, author: it.author, detail: 'by ' + sess.user + ' count=' + it.reports.length });
      return sendJson(res, 200, { ok: true, msg: escalated ? '举报已收到，该内容已转入复核，暂时不公开显示。' : '举报已收到，感谢您的反馈。' });
    });
  }

  // ---- 补齐：作者删自己的内容（软删，与管理删帖同源；非作者一律按不存在处理，不泄露） ----
  function handleDeleteOwn(req, res, sess, type, id) {
    const db = type === 'post' ? postsDb : repliesDb;
    const it = db.items[String(id || '')];
    if (!it || it.deleted || it.author !== sess.user) return sendJson(res, 404, { ok: false, msg: '内容不存在。' });
    it.deleted = true; it.title = ''; it.body = '';
    if (type === 'post') savePosts(); else saveReplies();
    modlog({ actor: 'user', action: 'delete-own', targetType: type, targetId: it.id, author: sess.user, detail: 'authorSelf' });
    return sendJson(res, 200, { ok: true, msg: '已删除。' });
  }

  // ---- 补齐：分享计数（游客可计；同主体同帖 1 小时去重，同主体每小时总计至多 20 次） ----
  function handleShare(req, res, sess, postId) {
    const post = postsDb.items[postId];
    if (!post || !postVisible(post, sess)) return sendJson(res, 404, { ok: false, msg: '帖子不存在或不可见。' });
    const now = Date.now();
    const actor = actorKeyOf(req, sess);
    const byPost = sharesDb.byPost[post.id] || (sharesDb.byPost[post.id] = {});
    for (const k of Object.keys(byPost)) if (now - byPost[k] > SHARE_DEDUPE_MS) delete byPost[k];
    const recent = (sharesDb.byActor[actor] || []).filter(t => now - t < SHARE_DEDUPE_MS);
    sharesDb.byActor[actor] = recent;
    let counted = false;
    if ((!byPost[actor] || now - byPost[actor] > SHARE_DEDUPE_MS) && recent.length < SHARE_HOURLY_CAP) {
      byPost[actor] = now; recent.push(now);
      post.shares = (post.shares || 0) + 1;
      counted = true;
      savePosts();
      modlog({ actor: 'user', action: 'share', targetType: 'post', targetId: post.id, author: post.author, detail: 'by ' + (sess ? sess.user : 'guest') });
    }
    saveShares();
    return sendJson(res, 200, { ok: true, shares: post.shares || 0, counted });
  }

  // ---- 补齐：论坛昵称（过机审才生效；命中硬规则或轻度敏感一律请更换，不进人工队列） ----
  async function handleSetNickname(req, res, sess) {
    const data = await readBody(req);
    const nick = String(data.nickname || '').trim();
    const p = profileOf(sess.user);
    if (p.accountStatus && p.accountStatus !== 'ok' && !(p.accountStatus === 'banned' && banLinkTriF(sess.user) === false)) return sendJson(res, 403, { ok: false, msg: '您的账号已被冻结或封禁，无法修改昵称。申诉请联系官方客服，或前往官网留言。' }); // DEV-19＋DEV-21 三态：'banned' 仅在镜像可读且明示未封禁时让位
    if (banLinkTriF(sess.user) === true) return sendJson(res, 403, { ok: false, msg: '您的账号已被冻结或封禁，无法修改昵称。申诉请联系官方客服，或前往官网留言。' }); // DEV-22/F1：镜像即时封禁第二道门（与发帖门同序，补 DEV-18 遗漏）
    if (!nick) { p.nickname = ''; saveProfiles(); modlog({ actor: 'user', action: 'nickname-clear', author: sess.user }); return sendJson(res, 200, { ok: true, nickname: '', msg: '已恢复为账号名显示。' }); }
    if ([...nick].length > 20) return sendJson(res, 400, { ok: false, msg: '昵称长度不得超过 20 个字。' });
    const review = R.reviewContent({ title: '', body: nick }, compiled, {});
    if (review.tier === 'B') return sendJson(res, 400, { ok: false, msg: '该昵称未通过审核：内容涉及' + (R.CATEGORIES[review.category] || '违规内容') + '，请更换后重试。' });
    if (review.tier === 'C') return sendJson(res, 400, { ok: false, msg: '该昵称含有敏感内容，请更换后重试。' });
    p.nickname = nick;
    saveProfiles();
    modlog({ actor: 'user', action: 'nickname-set', author: sess.user, detail: esc(nick) });
    return sendJson(res, 200, { ok: true, nickname: nick, msg: '昵称已更新。' });
  }

  // ---- 补齐：公开作者页（只展示已发布内容与汇总统计） ----
  function handleUserPage(req, res, sess, rawName, u) {
    const name = String(rawName || '').toLowerCase();
    const mine = Object.values(postsDb.items).filter(x => x.author === name && !x.deleted);
    const published = mine.filter(x => x.status === 'published' && !x.banHidden).sort((a, b) => b.createdAt - a.createdAt);
    if (!mine.length && !profiles[name]) return sendJson(res, 404, { ok: false, msg: '该用户不存在。' });
    const myReplies = Object.values(repliesDb.items).filter(x => x.author === name && !x.deleted && x.status === 'published' && !x.banHidden);
    const page = Math.max(1, parseInt(u.searchParams.get('page') || '1', 10));
    const stats = {
      posts: published.length,
      replies: myReplies.length,
      likesReceived: published.reduce((s, x) => s + x.likes.length, 0),
      viewsReceived: published.reduce((s, x) => s + (x.views || 0), 0)
    };
    const p = profiles[name] || {};
    return sendJson(res, 200, {
      ok: true,
      user: { account: name, name: displayNameOf(name), official: isOfficialAuthor(name), joinedAt: p.accountCreatedAt || null, stats },
      total: published.length, page,
      posts: published.slice((page - 1) * 20, page * 20).map(x => publicPost(x, sess))
    });
  }

  // ---- 补齐：管理面审核日志查询（读日志尾部，最新在前，分页） ----
  function adminModlog(req, res, u) {
    const page = Math.max(1, parseInt(u.searchParams.get('page') || '1', 10));
    const pageSize = Math.min(200, Math.max(1, parseInt(u.searchParams.get('pageSize') || '50', 10)));
    let entries = [];
    try {
      const st = fs.statSync(logFile);
      const readSize = Math.min(st.size, 4 * 1024 * 1024);
      const fd = fs.openSync(logFile, 'r');
      const buf = Buffer.alloc(readSize);
      fs.readSync(fd, buf, 0, readSize, st.size - readSize);
      fs.closeSync(fd);
      const lines = buf.toString('utf8').split('\n').filter(Boolean);
      if (st.size > readSize && lines.length) lines.shift(); // 尾部截断的首行可能不完整，丢弃
      entries = lines.map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean).reverse();
    } catch (e) { /* 日志文件尚不存在时按空处理 */ }
    return sendJson(res, 200, { ok: true, total: entries.length, page, pageSize, entries: entries.slice((page - 1) * pageSize, page * pageSize) });
  }

  // ---- 管理面（代审队列） ----
  function adminQueue(res) {
    const pendingPosts = Object.values(postsDb.items).filter(x => !x.deleted && x.status === 'pending');
    const pendingReplies = Object.values(repliesDb.items).filter(x => !x.deleted && x.status === 'pending');
    const hidden = [...Object.values(postsDb.items), ...Object.values(repliesDb.items)].filter(x => !x.deleted && x.banHidden);
    const muted = Object.entries(profiles).filter(([, p]) => isMuted(p, Date.now())).map(([name, p]) => ({ user: name, permanent: p.mute.permanent, until: p.mute.until, rejects30d: p.rejectEvents.filter(t => Date.now() - t < 30 * 86400000).length }));
    return sendJson(res, 200, {
      ok: true,
      pendingPosts: pendingPosts.map(x => ({ ...publicPost(x, { isAdmin: true }), body: x.body, reviewDetail: x.reviewDetail, reports: x.reports.length })),
      pendingReplies: pendingReplies.map(x => ({ ...publicReply(x, { isAdmin: true }), reviewDetail: x.reviewDetail, reports: x.reports.length })),
      banHidden: hidden.map(x => ({ type: x.title !== undefined ? 'post' : 'reply', id: x.id, author: x.author, title: x.title || undefined, body: x.body })),
      muted
    });
  }
  async function adminReview(req, res, adm, preData) {
    const data = preData || await readBody(req);
    const type = data.type === 'reply' ? 'reply' : 'post';
    const db = type === 'post' ? postsDb : repliesDb;
    const it = db.items[String(data.id || '')];
    if (!it || it.deleted) return sendJson(res, 404, { ok: false, msg: '内容不存在。' });
    const now = Date.now();
    if (data.decision === 'approve') {
      it.status = 'published'; it.reviewCategory = null;
      modlog({ actor: adm.reviewer, action: 'review-approve', targetType: type, targetId: it.id, author: it.author, snapshot: esc((it.title || '') + ' ' + it.body) });
    } else if (data.decision === 'reject') {
      it.status = 'rejected'; it.reviewCategory = data.category && R.CATEGORIES[data.category] ? data.category : (it.reviewCategory || 'spam');
      const m = applyRejection(it.author, now);
      modlog({ actor: adm.reviewer, action: 'review-reject', targetType: type, targetId: it.id, author: it.author, category: it.reviewCategory, detail: 'muteCount30d=' + m.count30d, snapshot: esc((it.title || '') + ' ' + it.body) });
    } else return sendJson(res, 400, { ok: false, msg: 'decision 只许 approve 或 reject。' });
    if (type === 'post') savePosts(); else saveReplies();
    // 裁定落定后统一重算作者 firstDone（甲案口径，函数注记见 recomputeFirstDone）：
    // 先落内容状态、后落档案，approve/reject 两路都到这一处。
    recomputeFirstDone(it.author);
    resolveReviewEvent(type, it.id, adm.reviewer, data.decision);
    return sendJson(res, 200, { ok: true, status: it.status });
  }
  async function adminAction(req, res, adm, action) {
    const data = await readBody(req);
    const now = Date.now();
    if (action === 'mute') {
      const p = profileOf(String(data.username || '').toLowerCase());
      if (data.mode === 'clear') { p.mute = { until: null, permanent: false }; }
      else if (data.mode === 'permanent') { p.mute.permanent = true; p.mute.until = null; }
      else { p.mute.until = now + (parseInt(data.days, 10) || 7) * 86400000; p.mute.permanent = false; }
      saveProfiles();
      modlog({ actor: adm.reviewer, action: 'mute-' + data.mode, author: String(data.username || '').toLowerCase(), detail: JSON.stringify(p.mute) });
      return sendJson(res, 200, { ok: true, mute: p.mute });
    }
    const type = data.type === 'reply' ? 'reply' : 'post';
    const db = type === 'post' ? postsDb : repliesDb;
    const it = db.items[String(data.id || '')];
    if (!it) return sendJson(res, 404, { ok: false, msg: '内容不存在。' });
    if (action === 'restore') {
      it.banHidden = false;
      // 恢复后该作者名下已无任何隐藏内容时，「待恢复」标记一并清掉，与事实对齐；
      // 仍有隐藏内容的保持标记不动（原语义不变）。
      const stillHidden = Object.values(postsDb.items).some(x => x.author === it.author && x.banHidden) || Object.values(repliesDb.items).some(x => x.author === it.author && x.banHidden);
      if (!stillHidden && profiles[it.author]) { profiles[it.author].banHiddenOutstanding = false; saveProfiles(); }
      modlog({ actor: adm.reviewer, action: 'restore', targetType: type, targetId: it.id, author: it.author });
    } else if (action === 'delete') {
      it.deleted = true; it.title = ''; it.body = '';
      modlog({ actor: adm.reviewer, action: 'delete', targetType: type, targetId: it.id, author: it.author });
    }
    if (type === 'post') savePosts(); else saveReplies();
    return sendJson(res, 200, { ok: true });
  }
  async function adminWords(req, res, adm) {
    const data = await readBody(req);
    if (data.action === 'add' || data.action === 'remove') {
      const cat = String(data.category || '');
      if (!wordsDb.categories[cat]) return sendJson(res, 400, { ok: false, msg: '分类不存在。' });
      const w = String(data.word || '').trim();
      if (!w) return sendJson(res, 400, { ok: false, msg: '词不能为空。' });
      const arr = wordsDb.categories[cat].words;
      if (data.action === 'add' && !arr.includes(w)) arr.push(w);
      if (data.action === 'remove') wordsDb.categories[cat].words = arr.filter(x => x !== w);
      saveJson(files.words, wordsDb);
      compiled = R.compileWords(wordsDb);
      modlog({ actor: adm.reviewer, action: 'words-' + data.action, detail: cat + ':' + w });
      return sendJson(res, 200, { ok: true });
    }
    return sendJson(res, 200, { ok: true, categories: Object.fromEntries(Object.entries(wordsDb.categories).map(([k, v]) => [k, { level: v.level, count: v.words.length, words: v.words }])), whitelistDomains: wordsDb.whitelistDomains });
  }

  // 退出处置（POST /logout 与 GET /logout-nav 共用）：作废本站会话 +
  // 落手动退出标记（同一控制台会话内不再靠单点登录自动带回）。
  function doLogout(req) {
    const cookies = parseCookiesOf(req);
    if (cookies.qfr_frm) { delete sessions[sha256(cookies.qfr_frm)]; saveSessions(); }
    const mark = xidHashOf(req);
    return ['qfr_frm=; Path=/; Max-Age=0; HttpOnly', 'qfr_frm_out=' + (mark || '1') + '; Path=/; Max-Age=2592000; SameSite=Lax; HttpOnly' + (cfg.cookieSecure === false ? '' : '; Secure')];
  }

  // ---- HTTP 路由 ----
  const server = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url, 'http://localhost');
      const pn = u.pathname;
      if (req.method === 'GET' && (pn === '/' || pn === '/forum')) {
        res.writeHead(200, pageHeadersOf(req));
        return res.end(PAGE);
      }
      if (req.method === 'GET' && pn === '/health') return sendJson(res, 200, { ok: true });
      if (pn === '/api/feedback') {
        if (req.method === 'OPTIONS') return feedback.handleOptions(req, res);
        if (req.method === 'POST') return feedback.handlePost(req, res);
        res.writeHead(405); return res.end('method not allowed');
      }
      if (!pn.startsWith('/api/forum')) { res.writeHead(404); return res.end('not found'); }
      const sub = pn.slice('/api/forum'.length) || '/';
      const sess = sessionOf(req);

      if (req.method === 'POST' && sub === '/login') return handleLogin(req, res);
      if (req.method === 'POST' && sub === '/sso') return handleSso(req, res);
      if (req.method === 'OPTIONS' && sub === '/sso-token') {
        const o = ssoCorsOriginOf(req);
        if (!o) { res.writeHead(403, { 'Cache-Control': 'no-store' }); return res.end(); }
        res.writeHead(204, {
          'Access-Control-Allow-Origin': o,
          'Access-Control-Allow-Credentials': 'true',
          'Access-Control-Allow-Methods': 'POST',
          'Access-Control-Allow-Headers': 'content-type',
          'Access-Control-Max-Age': '600',
          'Vary': 'Origin',
          'Cache-Control': 'no-store'
        });
        return res.end();
      }
      if (req.method === 'POST' && sub === '/sso-token') return handleSsoToken(req, res);
      if (req.method === 'GET' && sub === '/sso-login') return handleSsoLogin(req, res, u);
      if (req.method === 'POST' && sub === '/logout') {
        const sc = doLogout(req);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Set-Cookie': sc });
        return res.end(JSON.stringify({ ok: true }));
      }
      if (req.method === 'GET' && sub === '/logout-nav') {
        // 导航型退出（2.3.0 M2 线退出桥）：顶层导航能带上本站会话
        // cookie（SameSite=Lax 只放行顶层 GET），供直连源网页退出时由
        // 退出桥弹窗逐站跳过终止会话；处置与 POST /logout 完全一致。
        // next 只许回到自家来源（控制台直连源/好友服务源/隧道源），
        // 防开放重定向，其余一律回论坛首页。
        const sc = doLogout(req);
        let next = String(u.searchParams.get('next') || '');
        const okPrefixes = FRAME_EXTRA_ORIGINS.map(o => o + '/');
        try {
          const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
          const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
          if (host) okPrefixes.push(proto + '://' + host + '/');
        } catch (e) { /* ignore */ }
        if (!okPrefixes.some(pfx => next.startsWith(pfx))) next = '/forum';
        res.writeHead(302, { Location: next, 'Set-Cookie': sc, 'Cache-Control': 'no-store', 'Content-Security-Policy': 'frame-ancestors ' + frameAncestorsOf(req) });
        return res.end();
      }
      if (req.method === 'GET' && sub === '/me') {
        if (!sess) return sendJson(res, 200, { ok: true, user: null });
        const p = profileOf(sess.user);
        return sendJson(res, 200, { ok: true, user: sess.user, isAdmin: sess.isAdmin, nickname: p.nickname || '', displayName: displayNameOf(sess.user), official: isOfficialAuthor(sess.user), muted: isMuted(p, Date.now()) ? { permanent: p.mute.permanent, until: p.mute.until } : null, accountStatus: p.accountStatus });
      }
      if (req.method === 'GET' && sub === '/boards') {
        const counts = {};
        for (const b of BOARDS) counts[b.key] = Object.values(postsDb.items).filter(x => x.board === b.key && postVisible(x, sess)).length;
        return sendJson(res, 200, { ok: true, boards: BOARDS.map(b => ({ ...b, count: counts[b.key] })) });
      }
      if (req.method === 'GET' && sub === '/posts') {
        const board = String(u.searchParams.get('board') || 'general');
        const page = Math.max(1, parseInt(u.searchParams.get('page') || '1', 10));
        const list = Object.values(postsDb.items).filter(x => x.board === board && postVisible(x, sess));
        if (u.searchParams.get('sort') === 'hot') {
          // 热门排序：获赞优先，其次回复数，其次新帖（借 QFClash 营地内 hot 口径）
          const rc = {};
          for (const r of Object.values(repliesDb.items)) if (!r.deleted && r.status === 'published' && !r.banHidden) rc[r.postId] = (rc[r.postId] || 0) + 1;
          list.sort((a, b) => (b.likes.length - a.likes.length) || ((rc[b.id] || 0) - (rc[a.id] || 0)) || (b.createdAt - a.createdAt));
        } else {
          list.sort((a, b) => b.createdAt - a.createdAt);
        }
        return sendJson(res, 200, { ok: true, total: list.length, page, posts: list.slice((page - 1) * 20, page * 20).map(x => publicPost(x, sess)) });
      }
      const detailMatch = pn.match(/^\/api\/forum\/posts\/(p\d+)$/);
      if (req.method === 'GET' && detailMatch) {
        const post = postsDb.items[detailMatch[1]];
        if (!post || !postVisible(post, sess)) return sendJson(res, 404, { ok: false, msg: '帖子不存在或不可见。' });
        // 浏览计次：仅已发布帖；作者本人不计；同一主体 6 小时内只计一次（参照 QFClash 浏览去重口径）
        if (post.status === 'published' && (!sess || sess.user !== post.author)) {
          const nowV = Date.now();
          const actor = actorKeyOf(req, sess);
          const seen = viewsDb[post.id] || (viewsDb[post.id] = {});
          for (const k of Object.keys(seen)) if (nowV - seen[k] > VIEW_DEDUPE_MS) delete seen[k];
          if (!seen[actor] || nowV - seen[actor] > VIEW_DEDUPE_MS) { seen[actor] = nowV; post.views++; savePosts(); saveViews(); }
        }
        const replies = Object.values(repliesDb.items).filter(r => r.postId === post.id && replyVisible(r, sess)).sort((a, b) => a.createdAt - b.createdAt);
        return sendJson(res, 200, { ok: true, post: publicPost(post, sess), replies: replies.map(r => publicReply(r, sess)) });
      }
      // 补齐：分享计数与公开作者页（游客可用，置于登录闸门之前）
      const shareMatch = pn.match(/^\/api\/forum\/posts\/(p\d+)\/share$/);
      if (req.method === 'POST' && shareMatch) return handleShare(req, res, sess, shareMatch[1]);
      const userMatch = pn.match(/^\/api\/forum\/users\/([^/]+)$/);
      if (req.method === 'GET' && userMatch) return handleUserPage(req, res, sess, decodeURIComponent(userMatch[1]), u);
      // 以下：用户接口必须有会话；管理接口走 isAdminReq 单独判；
      // /internal/* 走内网密钥自检（#22/#31 助手裁定转发），同样豁免会话闸门
      if (!sess && !sub.startsWith('/admin') && !sub.startsWith('/internal')) {
        return sendJson(res, 401, { ok: false, msg: '请先登录后再操作。' });
      }
      if (req.method === 'POST' && sub === '/posts') return handleCreatePost(req, res, sess);
      const replyMatch = pn.match(/^\/api\/forum\/posts\/(p\d+)\/replies$/);
      if (req.method === 'POST' && replyMatch) return handleCreateReply(req, res, sess, replyMatch[1]);
      const likeMatch = pn.match(/^\/api\/forum\/posts\/(p\d+)\/like$/);
      if (req.method === 'POST' && likeMatch) {
        const post = postsDb.items[likeMatch[1]];
        if (!post || !postVisible(post, sess)) return sendJson(res, 404, { ok: false, msg: '帖子不存在或不可见。' });
        const i = post.likes.indexOf(sess.user);
        if (i >= 0) post.likes.splice(i, 1); else post.likes.push(sess.user);
        savePosts();
        return sendJson(res, 200, { ok: true, likes: post.likes.length, liked: i < 0 });
      }
      if (req.method === 'POST' && sub === '/report') return handleReport(req, res, sess);
      // 补齐：删自己的帖子/回复、设置昵称
      const delPostMatch = pn.match(/^\/api\/forum\/posts\/(p\d+)\/delete-own$/);
      if (req.method === 'POST' && delPostMatch) return handleDeleteOwn(req, res, sess, 'post', delPostMatch[1]);
      const delReplyMatch = pn.match(/^\/api\/forum\/replies\/(r\d+)\/delete-own$/);
      if (req.method === 'POST' && delReplyMatch) return handleDeleteOwn(req, res, sess, 'reply', delReplyMatch[1]);
      if (req.method === 'POST' && sub === '/profile') return handleSetNickname(req, res, sess);
      if (req.method === 'GET' && sub === '/my') {
        const page = Math.max(1, parseInt(u.searchParams.get('page') || '1', 10));
        const allMyPosts = Object.values(postsDb.items).filter(x => x.author === sess.user && !x.deleted).sort((a, b) => b.createdAt - a.createdAt);
        const allMyReplies = Object.values(repliesDb.items).filter(x => x.author === sess.user && !x.deleted).sort((a, b) => b.createdAt - a.createdAt);
        const stats = {
          posts: allMyPosts.length,
          replies: allMyReplies.length,
          likesReceived: allMyPosts.reduce((s, x) => s + x.likes.length, 0),
          viewsReceived: allMyPosts.reduce((s, x) => s + (x.views || 0), 0)
        };
        const myPosts = allMyPosts.slice((page - 1) * 20, page * 20).map(x => publicPost(x, sess));
        const myReplies = allMyReplies.slice((page - 1) * 20, page * 20).map(x => {
          const pub = publicReply(x, sess);
          const parent = postsDb.items[x.postId];
          pub.postId = x.postId;
          pub.postTitle = parent && !parent.deleted ? parent.title : '';
          pub.postGone = !parent || !!parent.deleted;
          return pub;
        });
        return sendJson(res, 200, { ok: true, stats, totalPosts: allMyPosts.length, totalReplies: allMyReplies.length, page, posts: myPosts, replies: myReplies });
      }
      // 站长 API 内网裁定（#22/#31：助手接口经 ext 转发，复用 adminReview 同一裁定逻辑与台账）
      if (req.method === 'POST' && sub === '/internal/purge-sessions') {
        const secret = licInternalSecret();
        if (!secret || req.headers['x-qf-internal-secret'] !== secret) return sendJson(res, 403, { ok: false, msg: '内部鉴权失败。' });
        const data = await readBody(req);
        const target = String(data.username || '').trim().toLowerCase();
        if (!target) return sendJson(res, 400, { ok: false, msg: '参数不完整。' });
        let nSes = 0;
        for (const h of Object.keys(sessions)) {
          const sx = sessions[h];
          if (sx && String(sx.user || '').trim().toLowerCase() === target) { delete sessions[h]; nSes += 1; }
        }
        if (nSes) saveSessions();
        let nSso = 0;
        for (const [k2, v2] of ssoTokens) { // DEV-14：ssoTokens 为 Map，DS 稿 Object.keys 写法无效
          if (v2 && String(v2.user || '').trim().toLowerCase() === target) { ssoTokens.delete(k2); nSso += 1; }
        }
        banLinkCacheF.delete(target);
        const pT = profiles[target]; // DEV-18/G-02：purge 到达即置封禁态，写口门不等下一轮 sync
        if (pT) { pT.accountBad = true; pT.accountStatus = 'banned'; saveProfiles(); }
        modlog({ actor: 'system', action: 'ban-purge-sessions', author: target, detail: 'ses=' + nSes + ',sso=' + nSso });
        return sendJson(res, 200, { ok: true, cleared: { sessions: nSes, sso: nSso } });
      }
      if (req.method === 'POST' && sub === '/internal/ban-cache-flush') {
        const secret = licInternalSecret();
        if (!secret || req.headers['x-qf-internal-secret'] !== secret) return sendJson(res, 403, { ok: false, msg: '内部鉴权失败。' });
        const data = await readBody(req);
        const target = String(data.username || '').trim().toLowerCase();
        if (!target) return sendJson(res, 400, { ok: false, msg: '参数不完整。' });
        banLinkCacheF.delete(target); // DEV-18：只清缓存不动会话（lift 侧调用）
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === 'POST' && sub === '/internal/review') {
        const secret = licInternalSecret();
        if (!secret || req.headers['x-qf-internal-secret'] !== secret) return sendJson(res, 403, { ok: false, msg: '内部鉴权失败。' });
        // 门二复审闭环：与 exists 同闸——库未就绪时不许给出「内容不存在」类裁定，防 ext 挂点丙在坏库/空库冷启动时误销账
        if (!checkForumDbReady()) return sendJson(res, 503, { ok: false, code: 'DB_NOT_READY' });
        const data = await readBody(req);
        const kind = data.kind === 'reply' ? 'reply' : 'post';
        const rawRef = String(data.id || '');
        const idOnly = rawRef.includes(':') ? rawRef.split(':').slice(1).join(':') : rawRef;
        const decision = data.action === 'approve' ? 'approve' : (data.action === 'reject' ? 'reject' : '');
        if (!decision || !idOnly) return sendJson(res, 400, { ok: false, msg: '参数不正确。' });
        return adminReview(req, res, { reviewer: String(data.actor || '助手接口') }, { type: kind, id: idOnly, decision, category: data.category });
      }
      // 内部只读存在性探测（B 设计 4.1）：供 ext 自动销账判据，与 adminReview 不存在判据同义，只读、不写 modlog。
      if (req.method === 'POST' && sub === '/internal/exists') {
        const secret = licInternalSecret();
        if (!secret || req.headers['x-qf-internal-secret'] !== secret) return sendJson(res, 403, { ok: false, msg: '内部鉴权失败。' });
        if (!checkForumDbReady()) return sendJson(res, 503, { ok: false, code: 'DB_NOT_READY' });
        const data = await readBody(req);
        const kind = String(data.kind || '');
        if (kind !== 'post' && kind !== 'reply') return sendJson(res, 400, { ok: false, msg: '参数不正确。' });
        const rawRef = String(data.id || '');
        const idOnly = rawRef.includes(':') ? rawRef.split(':').slice(1).join(':') : rawRef;
        if (!idOnly) return sendJson(res, 400, { ok: false, msg: '参数不正确。' });
        // 门二 F2：id 前缀与 kind 必须一致，错位查询一律拒绝，防查错库误判不存在
        if (rawRef.startsWith('reply:') && kind !== 'reply') return sendJson(res, 400, { ok: false, msg: '参数不正确。' });
        if (rawRef.startsWith('post:') && kind !== 'post') return sendJson(res, 400, { ok: false, msg: '参数不正确。' });
        const db = kind === 'reply' ? repliesDb : postsDb;
        // 门二 F1：内存库未就绪/结构异常/空库一律按未就绪答复，绝不以空库判「不存在」
        if (!db || !db.items || typeof db.items !== 'object' || Array.isArray(db.items) || Object.keys(db.items).length === 0) return sendJson(res, 503, { ok: false, code: 'DB_NOT_READY' });
        const it = Object.prototype.hasOwnProperty.call(db.items, String(idOnly)) ? db.items[String(idOnly)] : null;
        return sendJson(res, 200, { ok: true, exists: !!it && !it.deleted });
      }
      // 管理面
      if (sub.startsWith('/admin')) {
        const adm = isAdminReq(req);
        if (!adm) return sendJson(res, 401, { ok: false, msg: '需要站长身份。' });
        if (req.method === 'GET' && sub === '/admin/queue') return adminQueue(res);
        if (req.method === 'POST' && sub === '/admin/review') return adminReview(req, res, adm);
        if (req.method === 'POST' && sub === '/admin/restore') return adminAction(req, res, adm, 'restore');
        if (req.method === 'POST' && sub === '/admin/delete') return adminAction(req, res, adm, 'delete');
        if (req.method === 'POST' && sub === '/admin/mute') return adminAction(req, res, adm, 'mute');
        if ((req.method === 'GET' || req.method === 'POST') && sub === '/admin/words') return adminWords(req, res, adm);
        if (req.method === 'GET' && sub === '/admin/modlog') return adminModlog(req, res, u);
        if (req.method === 'POST' && sub === '/admin/sync') { const r = await syncAccounts(adm.reviewer); return sendJson(res, r.ok ? 200 : 502, r); }
        return sendJson(res, 404, { ok: false, msg: '管理接口不存在。' });
      }
      return sendJson(res, 404, { ok: false, msg: '接口不存在。' });
    } catch (e) {
      try { sendJson(res, 500, { ok: false, msg: '服务器暂时出现问题，请稍后再试。' }); } catch (e2) {}
    }
  });
  server.listen(cfg.port || 8446, cfg.bind || '127.0.0.1', () => {
    console.log('qfremote-forum listening on ' + (cfg.bind || '127.0.0.1') + ':' + (cfg.port || 8446));
  });
  // 启动对账一次 + 每 5 分钟
  syncAccounts('system').then(r => console.log('initial sync:', JSON.stringify(r)));
  setInterval(() => { syncAccounts('system').catch(() => {}); }, cfg.syncIntervalMs || 300000);
}

if (require.main === module) main();
module.exports = { BOARDS, verifyConsoleSession, sessionIpFromCookie };
