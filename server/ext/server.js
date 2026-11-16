'use strict';
/*
 * QFRemote 扩展服务（qfremote-ext，2.2.0 新服务，零改动旧文件）
 * ================================================================
 * 监听 127.0.0.1:8448（只经 nginx 本机反代对外），systemd 以 root 运行
 * （要调 systemctl / mcdb / appeal-admin）。数据只落在自家 data/ 目录。
 *
 * 两摊功能：
 *  1) 积分 /points/api：心跳计账（服务器时钟、账号级去重）＋ me 查询。
 *  2) 站长管理 /admin + /admin/api：仅站长账号（登录名是站长邮箱且
 *     siteadmin 全权）可用。冻结/解封/封号/重置密码走既有停服窗序列
 *     （串行队列：探活 → 停服 → mcdb → 交还属主 → 启服 → 探活），
 *     改名走 rename-account.sh --admin-override，申诉走 appeal-admin.js。
 *     重置密码的新密码只在本次响应里回显一次，不落日志、不落文件。
 *
 * 会话校验照好友服务现行做法（控制 WS 校验）：拿控制台会话 cookie
 * （xid / xid.sig）开一条到 MeshCentral 控制通道的 WS 连接，收到服务
 * 器下发的 userinfo 才算验真；本站不另存任何账号密码。
 * 另有一次性令牌：POST /points/api/sso-token（带有效控制台会话）发
 * 60 秒单次令牌，GET /admin/login?token= 换发本站会话 cookie
 * （qfr_ext，30 天，HttpOnly），供隧道源打开管理页时用。
 * /admin 与 /points/api 也直接接受手动附带的控制台 cookie（App 主
 * 进程就是这样调的）。
 *
 * WS 客户端由本服务 package.json/package-lock.json 声明，部署用 npm ci；
 * 不依赖 MeshCentral 的私有 node_modules 路径。
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { trustedClientIp, readRebindForm } = require('./request-context');
const { createProductionBootHandler } = require('./webapp-boot');
const { execFile } = require('child_process');
const pointsCore = require('./points-core');
const { adminPageHtml } = require('./page');
// ===== 许可核心（阶段 C-2）：单一数据源 /opt/qfremote-license/，本进程为唯一写者 =====
let _licCoreMod, _licPagesMod;
try { _licCoreMod = require('./license-core'); _licPagesMod = require('./license-pages'); }
catch (e) { _licCoreMod = require('../license-svc/license-core'); _licPagesMod = require('../license-svc/license-pages'); }
const { createLicenseCore, PLANS: LIC_PLANS, maskKey: licMaskKey } = _licCoreMod;
const { purchasePageHtml, statusPageHtml, rebindPageHtml, ordersPageHtml, welfarePageHtml } = _licPagesMod;
// ===== 2.3.1 新增服务端模块（#21 订单 / #22+#31 事件 / #25 文件发送） =====
let _ordersMod, _eventsMod, _filesMod;
try { _ordersMod = require('./orders-core'); _eventsMod = require('./events-core'); _filesMod = require('./files-core'); }
catch (e) { _ordersMod = require('../ext-svc/orders-core'); _eventsMod = require('../ext-svc/events-core'); _filesMod = require('../ext-svc/files-core'); }
const { createOrdersCore } = _ordersMod;
const { createEventsCore } = _eventsMod;
const { createFilesCore } = _filesMod;
let _homePageMod = null;
try { _homePageMod = require('./home-page'); } catch (e) { try { _homePageMod = require('../ext-svc/home-page'); } catch (e2) {} }
// 全站统一档案（昵称＋头像，2.3.2）：正本模块＋图像审核供给＋与论坛同一判定源
let _profileCoreMod = null, _profileImageMod = null, _profileReviewMod = null, _profileWordsFallback = null;
try { _profileCoreMod = require('./profile-core'); _profileImageMod = require('./profile-imagemod'); _profileReviewMod = require('./profile-review'); }
catch (e) { try { _profileCoreMod = require('../ext-svc/profile-core'); _profileImageMod = require('../ext-svc/profile-imagemod'); _profileReviewMod = require('../ext-svc/profile-review'); } catch (e2) {} }
try { _profileWordsFallback = require('./words-data.json'); } catch (e) { try { _profileWordsFallback = require('../ext-svc/words-data.json'); } catch (e2) {} }
const homePageHtml = _homePageMod ? _homePageMod.homePageHtml : null;
const LIC_DIR = process.env.QFLIC_DIR || '/opt/qfremote-license';
const lic = createLicenseCore({ dir: LIC_DIR });
const LIC_SECRET_FILE = path.join(LIC_DIR, 'internal.secret');
let LIC_SECRET = '';
try { LIC_SECRET = fs.readFileSync(LIC_SECRET_FILE, 'utf8').trim(); } catch (e) {}
if (!LIC_SECRET) {
  LIC_SECRET = crypto.randomBytes(32).toString('hex');
  try { fs.mkdirSync(LIC_DIR, { recursive: true }); fs.writeFileSync(LIC_SECRET_FILE, LIC_SECRET, { mode: 0o640 }); } catch (e) { log({ ev: 'lic-secret-error', err: String(e && e.message) }); }
}
let passmod = null;
try { passmod = require('/opt/meshcentral/node_modules/meshcentral/pass.js'); } catch (e) {}
function verifyAccountPassword(username, password) {
  return new Promise((resolve) => {
    if (!passmod || !password) return resolve(false);
    let user = null;
    try { user = findDbUser(loadDb(), username); } catch (e) {}
    if (!user || !user.salt || !user.hash) return resolve(false);
    try { passmod.hash(String(password), user.salt, (err, hash) => resolve(!err && hash === user.hash), null); }
    catch (e) { resolve(false); }
  });
}
function accountEmail(username) {
  try { const u = findDbUser(loadDb(), username); if (u && u.email) return String(u.email).toLowerCase(); } catch (e) {}
  return lic.getContact(username);
}
// 账号存在性（以控制台账号库为准；转赠发起校验受赠账号用，裁决批④）
function accountExists(username) {
  try { return !!findDbUser(loadDb(), username); } catch (e) { return false; }
}

// ---------- 配置（环境变量可覆盖，默认即生产路径） ----------
const BIND = process.env.QFEXT_BIND || '127.0.0.1';
const PORT = parseInt(process.env.QFEXT_PORT || '8448', 10);
const MC_URL = process.env.QFEXT_MC_URL || 'wss://127.0.0.1:8443/control.ashx';
const DATA_DIR = process.env.QFEXT_DATA_DIR || '/opt/qfremote-ext/data';
const POINTS_FILE = path.join(DATA_DIR, 'points.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const MC_DATA_DIR = process.env.QFEXT_MC_DATA_DIR || '/opt/meshcentral/meshcentral-data';
const DB_FILE = process.env.QFEXT_DB_FILE || path.join(MC_DATA_DIR, 'meshcentral.db');
const LEDGER_FILE = process.env.QFEXT_LEDGER_FILE || path.join(MC_DATA_DIR, 'qf-account-ledger.json');
const APPEALS_FILE = process.env.QFEXT_APPEALS_FILE || '/opt/qfremote-loginshim/data/appeals.json';
const APPEAL_ADMIN = process.env.QFEXT_APPEAL_ADMIN || '/opt/qfremote-loginshim/appeal-admin.js';
const MCDB = process.env.QFEXT_MCDB || '/opt/meshcentral/account-kit/mcdb.js';
const RENAME_SH = process.env.QFEXT_RENAME_SH || '/opt/meshcentral/account-kit/rename-account.sh';

const payOrders = createOrdersCore({ dir: LIC_DIR, lic, log });
const reviewEvents = createEventsCore({ dataDir: DATA_DIR, log, tokenPlainFile: process.env.QFEXT_ASSISTANT_TOKEN_FILE || '/opt/qfremote-ext/assistant-api-token.txt', ownerTokenPlainFile: process.env.QFEXT_OWNER_TOKEN_FILE || '/opt/qfremote-ext/owner-api-token.txt',
  // EV-1 兜底（verify-ev1-20261026 备补丁，DS 门一 2026-10-29 裁定部署）：order
  // 事件销账前置断言——订单须已带一审裁定标记 review1（与 instant-review
  // reconcile 的「一审已落定」标记同源同口径）；非 order 类型恒放行。
  // payOrders 已于上一行先行实例化，无时序问题。
  resolveGuard: (type, refId) => { if (type !== 'order') return true; const o = payOrders.getRaw(refId); return !!(o && o.review1); } });
// ===== LEA 本地代理（Stage 1 MVP，DESIGN.md §8）：A1 隔离——require/实例化失败一律降级为 null，ext 照常运行 =====
// server.js 只加本段实例化与下方路由注册行，不改既有逻辑。
let leaCore = null, leaChannel = null, leaRoutes = null;
try {
  const _leaCoreMod = require('./lea/lea-core');
  const _leaChannelMod = require('./lea/lea-channel');
  const _leaRoutesMod = require('./lea/lea-routes');
  leaCore = _leaCoreMod.createLeaCore({ dir: process.env.QFEXT_LEA_DIR || path.join(DATA_DIR, 'lea'), log, signingKeyFile: process.env.QFEXT_LEA_SIGNING_KEY_FILE || path.join(MC_DATA_DIR, 'lea-signing-key.b64') });
  leaChannel = _leaChannelMod.createLeaChannel({ log });
  leaRoutes = _leaRoutesMod.createLeaRoutes(leaCore, leaChannel, {
    sendJson, readJsonBody, log,
    verifyPassword: (u, p) => verifyAccountPassword(u, p),
    // T31：本站暂无 MFA 校验入口（全仓无 TOTP/MFA 实现；VERIFY-STAGE1 已列
    // 为已知未完成项），故显式声明 verifyMfa: null，不注入伪造的校验函数——
    // 恒真会虚构 MFA 校验、恒假会锁死 Key 生成／全部吊销，两者都不可接受。
    // lea-routes 未注入时只走密码二次确认（confirmMethod='password'，见
    // server/ext/lea/README.md 未完成项第 5 条）。MFA 上线后在此注入真实
    // 校验函数即可。
    verifyMfa: null,
    resolveConsoleAuth: (req) => validateConsoleCookie(req.headers.cookie || '', clientIpFromReq(req)),
    isSiteAdmin: (a) => isAdmin(a),
  });
  log({ ev: 'lea-mfa-unavailable', msg: 'no MFA verifier configured; LEA key operations use password-only confirmation' });
} catch (e) { log({ ev: 'lea-unavailable', err: String(e && e.message || e) }); }
// 订单一审秒审（主通道）：A1 隔离——require/实例化失败一律降级为 null，ext 照常运行，订单走人工链
let instantReview = null;
try {
  const _instantMod = require('./instant-review');
  instantReview = _instantMod.createInstantReview({ payOrders, reviewEvents, lic, log, licDir: LIC_DIR, extDir: process.env.QFEXT_DIR || '/opt/qfremote-ext' });
} catch (e) { log({ ev: 'instant-review-unavailable', err: String(e && e.message || e) }); }
// 付款截图订单号自动识别（提交前回填专用）：A1 隔离同秒审——require/实例化失败降级为 null，
// 识别端点恒回 found:false 静默回落手输；识别结果不落单、不参与审核裁定（设计：patrol-20261026/work/ocr-orderno-20261026/DESIGN.md）
let orderOcr = null;
try {
  const _ocrMod = require('./ocr-core');
  orderOcr = _ocrMod.createOrderOcr({ payOrders, log, extDir: process.env.QFEXT_DIR || '/opt/qfremote-ext' });
} catch (e) { log({ ev: 'order-ocr-unavailable', err: String(e && e.message || e) }); }

// ---------- 全站统一档案（昵称＋头像，2.3.2；设计 v232/profile-avatar-nickname/DESIGN.md） ----------
// 冻结判定与论坛同口径（冻结位＋站长精确豁免；全权账号源码豁免锁定）；
// 封禁判定读许可台账现行封禁。判定只在提交时用，展示面不拦。
function profileAccountStatus(username) {
  const login = String(username || '').toLowerCase();
  let frozen = false;
  try {
    const u = findDbUser(loadDb(), login);
    if (u) frozen = ((u.siteadmin || 0) !== SITEADMIN_FULL) && (((u.siteadmin || 0) & SITEADMIN_LOCKED_BIT) !== 0) && login !== ADMIN_EMAIL;
  } catch (e) {}
  let banned = false;
  try { banned = (lic.activeBansFor(login, Date.now()) || []).length > 0; } catch (e) {}
  return { frozen, banned };
}
// 图像审核供给：生产＝GLM 视觉（profile-imagemod）。试运行桩（stub-ok/
// stub-violate）须同时显式设 QFPROFILE_ALLOW_STUB=1 才生效（核对 #2 硬闸门：
// 单独残留 QFPROFILE_IMAGE_MOD 不再能打开免审通道）；桩生效时启动日志留痕。
const _profileStubOn = process.env.QFPROFILE_ALLOW_STUB === '1' && (process.env.QFPROFILE_IMAGE_MOD === 'stub-ok' || process.env.QFPROFILE_IMAGE_MOD === 'stub-violate');
if (process.env.QFPROFILE_IMAGE_MOD && !_profileStubOn) log({ ev: 'profile-image-mod-stub-ignored', value: String(process.env.QFPROFILE_IMAGE_MOD) });
if (_profileStubOn) log({ ev: 'profile-image-mod-STUB-ACTIVE', value: String(process.env.QFPROFILE_IMAGE_MOD), warn: '试运行桩生效中，禁止用于生产' });
const profileImageMod = (_profileStubOn && process.env.QFPROFILE_IMAGE_MOD === 'stub-ok') ? (async () => ({ usable: true }))
  : (_profileStubOn && process.env.QFPROFILE_IMAGE_MOD === 'stub-violate') ? (async () => ({ usable: false, category: '色情内容', rules: ['stub'] }))
  : (_profileImageMod ? _profileImageMod.createGlmImageModerator({}) : null);
// 路径段解码（核对 #8）：畸形编码回 null，调用方按 400/404 结构化处理，不抛 URIError
function decSeg(s) { try { return decodeURIComponent(s); } catch (e) { return null; } }
const profileCore = (_profileCoreMod && _profileReviewMod) ? _profileCoreMod.createProfileCore({
  dataDir: DATA_DIR, log, events: reviewEvents,
  reviewModule: _profileReviewMod,
  wordsFile: process.env.QFPROFILE_WORDS_FILE || '/opt/qfremote-forum/data/words.json',
  wordsFallback: _profileWordsFallback,
  accountStatus: profileAccountStatus,
  imageMod: profileImageMod,
}) : null;
const fileStage = createFilesCore({ dir: LIC_DIR, lic, log });
// L5 画面与传输（RC-03/07/08/09/10）：协议＋服务端模块。加载失败不
// 拖垮整服务——对应端点回 503（见下），启动日志留痕。
let l5 = null;
try {
  const relayMod = require('./relay-core');
  const idrMod = require('./idr-core');
  const qualityMod = require('./quality-core');
  const transferMod = require('./transfer-core');
  const recordingMod = require('./recording-core');
  const qualitySessions = new Map(); // sessionId -> quality session（每会话参数快照）
  const idrGate = idrMod.createIdrGate({ log });
  const transferCore = transferMod.createTransferCore({ dir: LIC_DIR, log, stageBuffer: fileStage.stageBuffer, limits: fileStage.limits });
  const recordingCore = recordingMod.createRecordingCore({ dir: LIC_DIR, log, readConfig: () => lic.readConfig() || {} });
  const l5SweepTimer = setInterval(() => {
    try { transferCore.sweep(Date.now()); } catch (e) { log({ ev: 'l5-transfer-sweep-error', err: String(e && e.message || e) }); }
    try { recordingCore.sweep(Date.now()); } catch (e) { log({ ev: 'l5-recording-sweep-error', err: String(e && e.message || e) }); }
  }, 60000);
  if (l5SweepTimer && typeof l5SweepTimer.unref === 'function') l5SweepTimer.unref();
  l5 = { relayMod, idrMod, qualityMod, transferMod, recordingMod, qualitySessions, idrGate, transferCore, recordingCore };
  log({ ev: 'l5-modules-loaded', items: ['RC-03', 'RC-07', 'RC-08', 'RC-09', 'RC-10'] });
} catch (e) {
  log({ ev: 'l5-modules-load-failed', err: String(e && e.stack || e) });
}
function l5Guard(res) {
  if (l5) return true;
  sendJson(res, 503, { ok: false, code: 'L5_UNAVAILABLE', msg: '画面与传输模块未加载。' });
  return false;
}
const EXT_ASSETS_DIR = process.env.QFEXT_ASSETS_DIR || '/opt/qfremote-ext/assets';

// ===== 互联窗观察（2.3.2 线 D，决策 #42）：只记录、不拒服 =====
// 客户端（2.3.2 起）在自家 API 请求上带 x-qf-client-version 头。本服务
// 在 /license/api/ 入口只做观察记录：带头才往独立只追加文件记一行
// {ts, username, version, path}；绝不写许可状态文件（单写者纪律不破——
// 本文件不是许可状态）、不改变任何接口行为与返回。username 只取已解析
// 出的会话身份，取不到记 null，绝不为记日志额外做校验或读请求体。
const CLIENT_VERSIONS_FILE = process.env.QFEXT_CLIENT_VERSIONS_FILE || path.join(LIC_DIR, 'client-versions.jsonl');
function recordClientVersion(req, p, username) {
  try {
    const v = req.headers['x-qf-client-version'];
    if (typeof v !== 'string' || !v.trim()) return;
    const line = JSON.stringify({ ts: new Date().toISOString(), username: username || null, version: v.trim().slice(0, 32), path: String(p || '') }) + '\n';
    fs.appendFileSync(CLIENT_VERSIONS_FILE, line, { mode: 0o600 });
  } catch (e) { try { log({ ev: 'client-version-log-error', err: String(e && e.message) }); } catch (e2) {} }
}

const ADMIN_EMAIL = '718983610';
const SITEADMIN_FULL = 4294967295;
const SITEADMIN_LOCKED_BIT = 32;
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000; // 本站会话 30 天
const SSO_TOKEN_TTL_MS = 60 * 1000;           // 一次性令牌 60 秒
const ACCOUNT_RE = /^[A-Za-z0-9@._+\-]{1,80}$/;

function log(obj) {
  try { console.log(JSON.stringify(Object.assign({ at: new Date().toISOString(), svc: 'qfremote-ext' }, obj))); } catch (e) {}
}

// ---------- WS 客户端（照好友服务 loadWebSocket 口径） ----------
let _WebSocket = null;
function loadWebSocket() {
  if (_WebSocket) return _WebSocket;
  _WebSocket = require('ws');
  return _WebSocket;
}

// ---------- 控制台会话校验（照好友服务 mcConnectCookie 同一机制） ----------
// 以控制台会话 cookie 开控制通道：认证成功服务器主动下发 userinfo，
// 收到才算验真；cookie 无效/过期/被冻结都会被直接关连接。
// 会话绑 IP 的转发修复与好友服务同口径（2.3.0 H 线，原理见好友服务
// server.js 的 sessionIpFromCookie 注释）：候选 = 会话自带 IP → 请求来源
// IP → 无转发原样，被秒拒才换下一个，超时不叠试。
function sessionIpFromCookie(cookieHeader) {
  try {
    const jar = {};
    String(cookieHeader || '').split(';').forEach((p) => { const i = p.indexOf('='); if (i > 0) jar[p.slice(0, i).trim()] = p.slice(i + 1).trim(); });
    if (!jar.xid) return null;
    const obj = JSON.parse(Buffer.from(String(jar.xid), 'base64').toString('utf8'));
    const ip = obj && obj.ip;
    if (typeof ip === 'string' && ip.length <= 64 && /^[0-9a-fA-F.:%[\]]+$/.test(ip)) return ip;
  } catch (e) { /* 解不出就走后备候选 */ }
  return null;
}
function mcConnectCookieOnce(cookieHeader, timeoutMs, fwdIp) {
  return new Promise((resolve, reject) => {
    let WebSocket;
    try { WebSocket = loadWebSocket(); } catch (e) { reject(new Error('ws-unavailable')); return; }
    const headers = { Cookie: cookieHeader, Origin: 'https://127.0.0.1:8443' };
    if (fwdIp) headers['X-Forwarded-For'] = fwdIp;
    const ws = new WebSocket(MC_URL, { rejectUnauthorized: false, headers });
    let done = false;
    const timer = setTimeout(() => finish(new Error('mc-connect-timeout')), timeoutMs || 8000);
    function finish(err, sess) { if (done) return; done = true; clearTimeout(timer); if (err) { try { ws.close(); } catch (e) {} reject(err); } else resolve(sess); }
    const sess = { ws, userinfo: null };
    ws.on('message', (data) => {
      let m; try { m = JSON.parse(data.toString()); } catch (e) { return; }
      if (m && m.action === 'userinfo' && m.userinfo) { sess.userinfo = m.userinfo; finish(null, sess); return; }
      // 服务器对无效/伪造会话立刻回 action=close（实测 0.06 秒）：认这个信号
      // 秒拒，不再干等超时——这正是「验真超时」现象的根源修复。
      if (m && m.action === 'close') finish(new Error('mc-session-rejected'));
    });
    ws.on('error', () => finish(new Error('mc-conn-error')));
    ws.on('close', () => finish(new Error('mc-auth-failed')));
  });
}
async function mcConnectCookie(cookieHeader, timeoutMs, extraIps) {
  const candidates = [];
  const sip = sessionIpFromCookie(cookieHeader);
  if (sip) candidates.push(sip);
  for (const ip of (extraIps || [])) { if (ip && !candidates.includes(ip)) candidates.push(ip); }
  candidates.push(null);
  let lastErr = new Error('mc-auth-failed');
  for (const ip of candidates) {
    try { return await mcConnectCookieOnce(cookieHeader, timeoutMs, ip); }
    catch (e) { lastErr = e; if (e && e.message === 'mc-connect-timeout') break; }
  }
  throw lastErr;
}
// M-026：只信本机代理覆写的边缘 IP；不信任客户端构造的 XFF。
function clientIpFromReq(req) {
  return trustedClientIp(req);
}

function parseCookies(req) {
  const out = {};
  String(req.headers.cookie || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = p.slice(i + 1).trim();
  });
  return out;
}

// 校验缓存：sha256(xid) -> {at, user, siteadmin}（30 秒，照好友服务口径，防心跳连打反复开通道）
// 最终机制（2026-10-25 定形，证据见 2.2.0 扩展线回报）：
//  控制 WS 校验为唯一判据——userinfo 到达即认；服务器对无效会话回的
//  action=close 消息同样立即判拒（旧代码不认它、干等超时，是「验真超时」
//  的根源）；真超时再重试一次防偶发。HTTP 侧无可用的会话预言机（定制
//  登录页使 GET / 恒回登录页、/terms 三态一致、userimage.ashx 双向 404、
//  会话签名密钥每启动随机生成不可本地验签），故不设 HTTP 备用路径；
//  结构修法（config 固定 sessionKey 后可本地验签）已上报总装裁定。
const validateCache = new Map();
// DS-R02-①（2026-10-26 修复批）：缓存键＝sha256(xid+'.'+xid.sig)，xid 由请求方任意构造，
// 原实现无容量上限且过期条目永不删除——未认证随机 xid 可无限涨内存，每次未命中还各打一次
// MeshCentral 校验连接（放大）。上限 5000 条（30 秒新鲜窗口内真实并发会话远不及此量级）；
// 写入前剪枝：先删过期（与读侧 30 秒新鲜判定同口径），仍超限按插入序淘汰最旧——被淘汰等价
// 从未缓存，下次验真走 MC 重查，不改变任何会话语义。mcForceClose/G1 吊销门仍是兜底。
const VALIDATE_CACHE_MAX = 5000;
function pruneValidateCache(now) {
  if (validateCache.size < VALIDATE_CACHE_MAX) return;
  for (const [k, v] of validateCache) { if (!v || now - v.at >= 30000) validateCache.delete(k); }
  while (validateCache.size >= VALIDATE_CACHE_MAX) {
    const oldest = validateCache.keys().next();
    if (oldest.done) break;
    validateCache.delete(oldest.value);
  }
}
// ---------- 已撤销 xid（17:29 领取后原主人网页会话即时失效） ----------
// 转赠领取落盘后，原主人当时已知的控制台 xid 哈希全部登记撤销（落盘，
// 有效期 30 天＝xid 最长寿命）：此后这些 xid 在本站一切接口验真直接拒，
// 与 MeshCentral 在线 WS 的 close 推送（executeClaimForceLogout 内）双路
// 落地。新登录产生的新 xid 不在撤销名单——而新登录本身会被许可门按
// G1 拦截，不会形成可用会话。
const REVOKED_XID_FILE = path.join(DATA_DIR, 'revoked-xid.json');
let revokedXids = {}; // sha256(xid.sig) -> {user, at, exp}
try { const v = JSON.parse(fs.readFileSync(REVOKED_XID_FILE, 'utf8')); if (v && typeof v === 'object') revokedXids = v; } catch (e) {}
function saveRevokedXids() {
  try {
    const now = Date.now();
    for (const k of Object.keys(revokedXids)) if (revokedXids[k].exp <= now) delete revokedXids[k];
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(REVOKED_XID_FILE + '.tmp', JSON.stringify(revokedXids), { mode: 0o600 });
    fs.renameSync(REVOKED_XID_FILE + '.tmp', REVOKED_XID_FILE);
  } catch (e) { log({ ev: 'revoked-xid-save-error', err: String(e && e.message) }); }
}
function revokeXidsForUser(user) {
  let n = 0;
  const now = Date.now();
  for (const [hash, hit] of validateCache.entries()) {
    if (hit && hit.user === user) { revokedXids[hash] = { user, at: now, exp: now + SESSION_TTL_MS }; validateCache.delete(hash); n += 1; }
  }
  if (n) saveRevokedXids();
  return n;
}
// DS-R02-③：单条会话靶向撤销（与 revokeXidsForUser 的账号级口径分开）：只登记该 xid 哈希
// ＋清其验真缓存，同账号其他会话不受影响。G1 验真门查 revokedXids 命中即拒，覆盖 ext 全部接口。
function revokeSingleXid(hash, user) {
  const now = Date.now();
  revokedXids[hash] = { user, at: now, exp: now + SESSION_TTL_MS };
  validateCache.delete(hash);
  saveRevokedXids();
  return 1;
}
// 经服务账号官方 WS 通道即时关闭某用户的全部在线会话：对目标做一轮
// 「置锁定 bit → 立即恢复原值」的 edituser——MeshCentral 在置锁定 bit 的
// 同一处理里向该用户全部 wssessions 下发 'close'（删会话＋关 WS，
// meshuser.js edituser 分支既有行为），恢复原值不改变其账号权限位。
// 站长/全权/服务账号与已锁定账号一律跳过（护栏同 guardCheck 口径）。
async function mcForceCloseUserSessions(username) {
  try {
    if (username === ADMIN_EMAIL) return { pushed: false, detail: 'skipped-guarded-admin' };
    let svcCfg = {};
    try { svcCfg = JSON.parse(fs.readFileSync('/opt/qfremote-register/config.json', 'utf8')); } catch (e) { return { pushed: false, detail: 'svc-config-unavailable' }; }
    const svcUser = svcCfg.svcUser || svcCfg.serviceUser, svcPass = svcCfg.svcPass || svcCfg.servicePass;
    if (!svcUser || !svcPass) return { pushed: false, detail: 'svc-creds-unavailable' };
    const WebSocket = loadWebSocket();
    const auth = Buffer.from(String(svcUser)).toString('base64') + ',' + Buffer.from(String(svcPass)).toString('base64');
    const sess = await new Promise((resolve, reject) => {
      const ws = new WebSocket(MC_URL, { rejectUnauthorized: false, headers: { 'x-meshauth': auth } });
      const t = setTimeout(() => { try { ws.close(); } catch (e) {} reject(new Error('timeout')); }, 8000);
      ws.on('message', (d) => { try { const m = JSON.parse(d.toString()); if (m.action === 'userinfo') { clearTimeout(t); resolve({ ws }); } } catch (e) {} });
      ws.on('error', () => { clearTimeout(t); reject(new Error('err')); });
      ws.on('close', () => { clearTimeout(t); reject(new Error('close')); });
    });
    const ws = sess.ws;
    const cmd = (command, pred) => new Promise((resolve) => {
      const t = setTimeout(() => resolve({ ok: false, error: 'timeout' }), 8000);
      const on = (d) => { try { const m = JSON.parse(d.toString()); if (pred(m)) { clearTimeout(t); try { ws.off('message', on); } catch (e) {} resolve({ ok: true, msg: m }); } } catch (e) {} };
      ws.on('message', on);
      try { ws.send(JSON.stringify(command)); } catch (e) { clearTimeout(t); resolve({ ok: false, error: 'send' }); }
    });
    try {
      const usersRes = await cmd({ action: 'users', responseid: 'qf-force-users' }, (m) => m.action === 'users' && Array.isArray(m.users));
      if (!usersRes.ok) return { pushed: false, detail: 'users-cmd-failed' };
      const u = usersRes.msg.users.find((x) => x.name && x.name.toLowerCase() === username);
      if (!u) return { pushed: false, detail: 'user-not-found' };
      const cur = u.siteadmin || 0;
      if (cur === SITEADMIN_FULL) return { pushed: false, detail: 'skipped-guarded-admin' };
      if (cur & SITEADMIN_LOCKED_BIT) return { pushed: true, detail: 'already-locked' };
      const lockRes = await cmd({ action: 'edituser', userid: u._id, siteadmin: (cur | SITEADMIN_LOCKED_BIT), responseid: 'qf-force-lock' }, (m) => m.responseid === 'qf-force-lock');
      if (!lockRes.ok) return { pushed: false, detail: 'lock-cmd-failed' };
      let unlockRes = await cmd({ action: 'edituser', userid: u._id, siteadmin: cur, responseid: 'qf-force-unlock' }, (m) => m.responseid === 'qf-force-unlock');
      if (!unlockRes.ok) unlockRes = await cmd({ action: 'edituser', userid: u._id, siteadmin: cur, responseid: 'qf-force-unlock2' }, (m) => m.responseid === 'qf-force-unlock2');
      return { pushed: true, detail: unlockRes.ok ? 'closed-and-restored' : 'closed-restore-unconfirmed' };
    } finally { try { ws.close(); } catch (e) {} }
  } catch (e) { return { pushed: false, detail: 'error:' + String((e && e.message) || e) }; }
}
// 在线改锁定 bit（免停服窗）：经服务账号 WS 直接 edituser 置/清 siteadmin
// 第 32 位，MeshCentral 进程内即时生效（登录校验读进程内用户对象），
// 不停服务、不掉任何人的远程会话。口径与 mcdb freeze/unfreeze 对齐：
// 全权账号不动 siteadmin（冻结态只记台账）；护栏同 guardCheck/
// adminGuardCheck。台账 history 由本进程按 mcdb 同形状补记
// （qf-account-ledger.json 只有 mcdb 与本服务写，MC 本体不用此文件）。
function noteLedgerLock(username, locking, by) {
  try {
    const ledger = loadLedger();
    const e = ledger.accounts[username] || (ledger.accounts[username] = { originalName: username, label: '', template: '', createdAt: null, renameCount: 0, history: [], deleted: false, provenance: 'no-ledger-entry' });
    e.frozen = locking;
    e.history = e.history || [];
    e.history.push({ ev: locking ? 'freeze' : 'unfreeze', at: new Date().toISOString(), by });
    const tmp = LEDGER_FILE + '.tmp-ext-note';
    fs.writeFileSync(tmp, JSON.stringify(ledger, null, 2));
    fs.renameSync(tmp, LEDGER_FILE);
    try { const pw = fs.readFileSync('/etc/passwd', 'utf8').split('\n').find((l) => l.startsWith('meshcentral:')); if (pw) { const f = pw.split(':'); fs.chownSync(LEDGER_FILE, Number(f[2]), Number(f[3])); } } catch (e) {}
    return { ok: true };
  } catch (e) { log({ ev: 'ledger-lock-note-error', target: username, err: String(e && e.message) }); return { ok: false, error: (e && e.code) || 'UNKNOWN' }; }
}
// 解封/解冻收尾写回：许可侧封禁全清后，把 qf-account-ledger 的残留
// 标记一并清掉——frozen 残留（全权账号在 licUnlockAccount 走
// guardCheck 早退、在线通道不写台账，残留 frozen=true 会让状态面
// 继续误报冻结，2026-10-26 站长本人误封案实证：解封后该标记未回
// 写）与 banned 旧旗（mcdb 时代标志，ext 内现已无写方、仅
// buildUsersList 读作显示与台账独有行门槛，许可台账无生效封禁时
// 它就是过期残留，不清则「已封禁」标签永不消失且无钮可解）。
// 仅当台账已有该账号条目且对应标记为 true 时才写，不新建条目、
// 不动其他字段；写形与 noteLedgerLock 一致（同 chown；tmp 后缀已按写方分离，D5-P3）。
function clearLedgerResidue(username, by, errBox) {
  try {
    const ledger = loadLedger();
    const e = ledger.accounts[username];
    if (!e) return false;
    let changed = false;
    e.history = e.history || [];
    if (e.frozen === true) { e.frozen = false; e.history.push({ ev: 'unfreeze', at: new Date().toISOString(), by }); changed = true; }
    if (e.banned === true) { e.banned = false; e.history.push({ ev: 'unban', at: new Date().toISOString(), by }); changed = true; }
    if (!changed) return false;
    const tmp = LEDGER_FILE + '.tmp-ext-clear';
    fs.writeFileSync(tmp, JSON.stringify(ledger, null, 2));
    fs.renameSync(tmp, LEDGER_FILE);
    try { const pw = fs.readFileSync('/etc/passwd', 'utf8').split('\n').find((l) => l.startsWith('meshcentral:')); if (pw) { const f = pw.split(':'); fs.chownSync(LEDGER_FILE, Number(f[2]), Number(f[3])); } } catch (e) {}
    return true;
  } catch (e) {
    // DS-R21：写盘/读盘失败与「无条目/无残留」必须可区分——经 errBox
    // 如实上抛，调用方不得再把故障误回成 404「账号不存在」。旧调用
    // 方不传 errBox 时行为不变（仍回 false）。errBox 只带错误码不带
    // 异常原文（DS 差量审 P3：fs 异常原文含服务器绝对路径，不许透
    // 传到前端回执，原文只进日志）。失败时不删自家 .tmp-ext-clear：该 tmp 后缀已与 noteLedgerLock 分离（D5-P3）
    // 分离后不存在误伤并发写盘之虞，保留便于诊断；残
    // 留 tmp 会被下一次写盘截断覆盖，无害（DS 差量审 D4）。
    log({ ev: 'ledger-residue-clear-error', target: username, err: String(e && e.message) });
    if (errBox) { errBox.failed = true; errBox.err = (e && e.code) || 'UNKNOWN'; }
    return false;
  }
}
async function liveSetLockBit(username, locking, opts) {
  opts = opts || {};
  try {
    const docs = loadDb(); const user = findDbUser(docs, username);
    if (!user) return { ok: false, detail: 'user-not-found' };
    const guard = opts.adminOverride ? adminGuardCheck(user, username) : guardCheck(user, username);
    if (guard) return { ok: false, detail: 'guarded' };
    const by = opts.adminOverride ? 'ext-live-override' : 'ext-live';
    if ((user.siteadmin || 0) === SITEADMIN_FULL) {
      const led = loadLedger(); const e0 = led.accounts[username];
      const frozenNow = !!(e0 && e0.frozen === true);
      if (locking === frozenNow) return { ok: true, detail: 'already-in-state' };
      const note = noteLedgerLock(username, locking, by);
      if (!note || !note.ok) return { ok: false, detail: 'ledger-write-failed' };
      return { ok: true, detail: 'ledger-only-fullrights' };
    }
    let svcCfg = {};
    try { svcCfg = JSON.parse(fs.readFileSync('/opt/qfremote-register/config.json', 'utf8')); } catch (e) { return { ok: false, detail: 'svc-config-unavailable' }; }
    const svcUser = svcCfg.svcUser || svcCfg.serviceUser, svcPass = svcCfg.svcPass || svcCfg.servicePass;
    if (!svcUser || !svcPass) return { ok: false, detail: 'svc-creds-unavailable' };
    const WebSocket = loadWebSocket();
    const auth = Buffer.from(String(svcUser)).toString('base64') + ',' + Buffer.from(String(svcPass)).toString('base64');
    const sess = await new Promise((resolve, reject) => {
      const ws = new WebSocket(MC_URL, { rejectUnauthorized: false, headers: { 'x-meshauth': auth } });
      const t = setTimeout(() => { try { ws.close(); } catch (e) {} reject(new Error('timeout')); }, 8000);
      ws.on('message', (d) => { try { const m = JSON.parse(d.toString()); if (m.action === 'userinfo') { clearTimeout(t); resolve({ ws }); } } catch (e) {} });
      ws.on('error', () => { clearTimeout(t); reject(new Error('err')); });
      ws.on('close', () => { clearTimeout(t); reject(new Error('close')); });
    });
    const ws = sess.ws;
    const cmd = (command, pred) => new Promise((resolve) => {
      const t = setTimeout(() => resolve({ ok: false, error: 'timeout' }), 8000);
      const on = (d) => { try { const m = JSON.parse(d.toString()); if (pred(m)) { clearTimeout(t); try { ws.off('message', on); } catch (e) {} resolve({ ok: true, msg: m }); } } catch (e) {} };
      ws.on('message', on);
      try { ws.send(JSON.stringify(command)); } catch (e) { clearTimeout(t); resolve({ ok: false, error: 'send' }); }
    });
    try {
      const usersRes = await cmd({ action: 'users', responseid: 'qf-livebit-users' }, (m) => m.action === 'users' && Array.isArray(m.users));
      if (!usersRes.ok) return { ok: false, detail: 'users-cmd-failed' };
      const u = usersRes.msg.users.find((x) => x.name && x.name.toLowerCase() === username);
      if (!u) return { ok: false, detail: 'user-not-found-ws' };
      const curWs = u.siteadmin || 0;
      if (curWs === SITEADMIN_FULL) return { ok: false, detail: 'fullrights-ws' };
      const target = locking ? (curWs | SITEADMIN_LOCKED_BIT) : (curWs & ~SITEADMIN_LOCKED_BIT);
      if (target === curWs) { noteLedgerLock(username, locking, by); return { ok: true, detail: 'already-in-state' }; }
      const r = await cmd({ action: 'edituser', userid: u._id, siteadmin: target, responseid: 'qf-livebit-set' }, (m) => m.responseid === 'qf-livebit-set');
      if (!r.ok) return { ok: false, detail: 'edituser-failed' };
      noteLedgerLock(username, locking, by);
      return { ok: true, detail: 'live-bit-set' };
    } finally { try { ws.close(); } catch (e) {} }
  } catch (e) { return { ok: false, detail: 'error:' + String((e && e.message) || e) }; }
}
// 锁定 bit 统一入口：先走在线通道（即时、无停服窗），失败才回落 mcdb
// 停服窗（既有 enqueueOp 串行队列与恢复兜底不变）。
async function setLockBit(username, locking, opts) {
  opts = opts || {};
  const live = await liveSetLockBit(username, locking, opts);
  if (live.ok) { log({ ev: 'lockbit-live', target: username, locking, detail: live.detail }); return { ok: true, msg: locking ? '已冻结（在线即时生效）。' : '已解冻（在线即时生效）。', via: 'live' }; }
  log({ ev: 'lockbit-live-fallback', target: username, locking, detail: live.detail });
  const out = await enqueueOp(() => runMcdbOp(locking ? 'freeze' : 'unfreeze', String(username).toLowerCase(), opts.adminOverride ? { adminOverride: true } : undefined));
  return Object.assign({}, out, { via: 'mcdb' });
}
// 领取成功后的强制下线执行（三路同步落地，结果只写服务日志与响应，
// 许可台账的完整事件已由许可核心在领取落盘时记下，不在此另起事件）：
async function executeClaimForceLogout(fromUser) {
  const summary = { target: fromUser, at: Date.now(), gateAfter: 'G1' };
  summary.revokedXids = revokeXidsForUser(fromUser);
  let cleared = 0;
  for (const h of Object.keys(sessions)) { if (sessions[h].user === fromUser) { delete sessions[h]; cleared += 1; } }
  if (cleared) saveSessions();
  summary.extSessionsCleared = cleared;
  summary.webPush = await mcForceCloseUserSessions(fromUser);
  summary.softwareSignal = 'forceLogout flag via login-check/device-report/points-heartbeat (transferOutGate)';
  log({ ev: 'transfer-force-logout', target: fromUser, revokedXids: summary.revokedXids, extSessionsCleared: cleared, webPush: summary.webPush });
  return summary;
}

// ===== 封禁功能门（P5-010，主稿＝DeepSeek 实现稿 §1，偏差见 ds-draft/ADOPTION.md DEV 表）=====

// 与许可核心 syncAccountLinkage 的 link==='banned' 判定逐字一致：
// 生效封禁中存在「永久」或 code∈{B6,B7,B9} → banLink。
const BAN_LINK_CODES = ['B6', 'B7', 'B9'];

function isBanLinkedName(username, now) {
  const u = String(username || '').trim().toLowerCase();
  if (!u) return false;
  try {
    const bans = lic.activeBansFor(u, now || Date.now());
    if (!bans || !bans.length) return false;
    return bans.some((b) => b.permanent) || bans.some((b) => BAN_LINK_CODES.includes(String(b.code || '').toUpperCase())); // DEV-18/G-10
  } catch (e) {
    // 失败开放：宁可漏挡也不能把全站挡死；必须留告警（DS 稿风险 6 口径）
    log({ ev: 'ban-link-eval-error', user: u, err: String(e && e.message) });
    return false;
  }
}

// MC 侧强制关闭（绕开 mcForceCloseUserSessions 三重早退）
// 不复用 mcForceCloseUserSessions 的原因（已核实）：它对 ADMIN_EMAIL 直接
// skipped-guarded-admin、对已锁位目标 already-locked 空转、对全权 skipped。
// 本函数只做一件事：让 MC 真的走一次 edituser → 触发 'close'。
// DEV-01：DS 稿附带的 noteLedgerLock 存根与调用不落——noteLedgerLock 是现行
// 真函数（三参、写台账），且 setLockBit 链内已调真函数留痕。
async function forceCloseSessionsByLockToggle(username) {
  const target = String(username || '').trim().toLowerCase();
  if (!target) return { ok: false, detail: 'empty-target' };

  let user = null;
  try { user = findDbUser(loadDb(), target); } catch (e) { return { ok: false, detail: 'db-unreadable' }; }
  if (!user) return { ok: false, detail: 'user-not-found' };

  const sa = user.siteadmin || 0;
  if (sa === SITEADMIN_FULL) {
    // MC 本体对全权号豁免 close（edituser 的 siteadmin!==0xFFFFFFFF 条件）。
    // 不假装成功，如实回 exempt，由功能门承担其余拦截。
    log({ ev: 'ban-enforce-mc-exempt', target, reason: 'siteadmin-full' });
    return { ok: false, exempt: true, detail: 'siteadmin-full-mc-exempt' };
  }

  const locked = (sa & SITEADMIN_LOCKED_BIT) !== 0;
  if (locked) {
    // 已置位再置一次是幂等的，不触发 close；先清再置强制触发一次
    const off = await setLockBit(target, false, { adminOverride: true });
    if (!off || !off.ok) return { ok: false, detail: 'unlock-step-failed' };
    let on = null;
    try { on = await setLockBit(target, true, { adminOverride: true }); }
    catch (e) { on = { ok: false, detail: 'exception:' + String(e && e.message) }; }
    if (!on || !on.ok) {
      // DS-R22（恢复 DS 原稿补偿，撤销 DEV-02）：清位已成功而重锁失败
      // 会把已封账号停在未锁定态——MC 本体登录不经功能门，封禁被绕
      // 过。补偿重试两次（短退避；setLockBit 每次都走 live→mcdb 全
      // 链，且 live 通道对已置位回 already-in-state，丢失响应造成的
      // 假失败也能被补偿识别为已锁定）。任一次成功即最终态锁定成立：
      // 补偿置位同样走 edituser，会话关闭照常触发，故如实回 ok 并标
      // compensated，不制造「会话关闭未确认」假警报（参 DEV-21/S-B）。
      log({ ev: 'ban-enforce-relock-compensate', target, firstDetail: on && on.detail });
      let back = null;
      for (const waitMs of [250, 1000]) {
        await new Promise((r) => setTimeout(r, waitMs));
        // DS 差量审 D1 加固：setLockBit 若以 throw 形式失败，视作一次
        // 失败继续下一次补偿，不许抛穿本函数绕过失败告警与失败关闭。
        try { back = await setLockBit(target, true, { adminOverride: true }); }
        catch (e) { back = { ok: false, detail: 'exception:' + String(e && e.message) }; }
        if (back && back.ok) break;
      }
      if (back && back.ok) return { ok: true, toggled: true, compensated: true };
      // 补偿穷尽仍失败＝失败关闭：如实回未锁定事实（relocked:false），
      // 高等级告警留痕，执行摘要 mc.ok=false 如实入日志与内网回执
      // （seal 回执的「会话关闭未确认」警告亦由 mc.ok 驱动）；绝不以
      // ok 假报、绝不静默放行——锁位须由后续封禁动作或人工补锁。
      log({ ev: 'ban-enforce-relock-failed', target, firstDetail: on && on.detail, lastDetail: back && back.detail });
      return { ok: false, detail: 'relock-step-failed', relocked: false };
    }
    return { ok: true, toggled: true };
  }

  const on = await setLockBit(target, true, { adminOverride: true });
  if (!on || !on.ok) return { ok: false, detail: 'lock-step-failed' };
  return { ok: true, toggled: false };
}

// 按用户串行锁（防清位/置位交错）
const userLocks = new Map();
function withUserLock(key, fn) {
  const prev = userLocks.get(key) || Promise.resolve();
  const run = prev.then(fn, fn);                    // 前序失败也继续
  const tail = run.then(() => {}, () => {});
  userLocks.set(key, tail);
  tail.then(() => { if (userLocks.get(key) === tail) userLocks.delete(key); }); // 防止 Map 无限增长
  return run;
}

// DEV-04：现行 postInternalJson 签名为 (urlStr, obj, timeoutMs)，此处按 DS 稿的
// (base, path, body, label) 调用形收口，内部拼接全址。
async function postInternalJsonSafe(base, path, body, label) {
  try {
    const r = await postInternalJson(String(base).replace(/\/$/, '') + path, body, 3000);
    return { ok: !!(r && r.ok === true), detail: r }; // DEV-18/G-12：无 ok 字段不得判成功（防 purge 假成功）
  } catch (e) {
    log({ ev: 'ban-enforce-notify-failed', svc: label, path, err: String(e && e.message) });
    return { ok: false, detail: String(e && e.message) };
  }
}

// 封禁落账联动。opts.skipMc：只跑 ①②④（licLockAccount 路径，MC 位已由
// setLockBit 处理）；opts.mcOnly：只跑 ③（冻结 B8 路径）。
async function executeBanEnforcement(username, source, opts) {
  opts = opts || {};
  const target = String(username || '').trim().toLowerCase();
  const summary = { target, source: source || 'unknown', at: Date.now() };
  if (!target) { summary.skipped = 'empty-target'; return summary; }

  // 站长本人：只跳过 ②（清 qfr_ext）。DEV-03：① 撤销 xid 照常执行——resolveAuth
  // 先认本站会话、后认 xid（:546），isAdmin 不问来源，保住 ② 即保住 /admin
  // 自解通道；① 是已定型判断 (a)「xid 撤销 + 功能门兜底」的本体（ADOPTION O2）。
  const ownerKept = (target === String(ADMIN_EMAIL || '').trim().toLowerCase());

  if (!opts.mcOnly) {
    // ① 撤销控制台 xid 哈希
    try { summary.revokedXids = revokeXidsForUser(target); }
    catch (e) { summary.revokedXids = 0; log({ ev: 'ban-enforce-xid-error', target, err: String(e && e.message) }); }

    // ② 清 qfr_ext 落盘会话（站长跳过：/admin 恢复通道依赖它）
    let cleared = 0;
    if (!ownerKept) {
      for (const h of Object.keys(sessions)) {
        const sx = sessions[h];
        if (sx && String(sx.user || '').trim().toLowerCase() === target) { delete sessions[h]; cleared += 1; }
      }
      if (cleared) {
        try { saveSessions(); } catch (e) { log({ ev: 'ban-enforce-save-error', target, err: String(e && e.message) }); }
      }
    } else {
      log({ ev: 'ban-enforce-owner-channel-kept', target, note: '保留 ext 会话，/admin 自解通道完整；xid 已照常撤销' });
    }
    summary.extSessionsCleared = cleared;
  }

  // ③ MeshCentral 会话强制关闭
  if (!opts.skipMc && !opts.mcOnly) {
    try { summary.mc = await withUserLock(target, () => forceCloseSessionsByLockToggle(target)); }
    catch (e) { summary.mc = { ok: false, detail: 'exception:' + String(e && e.message) }; log({ ev: 'ban-enforce-mc-error', target, err: String(e && e.message) }); }
  } else if (opts.mcOnly) {
    try { summary.mc = await withUserLock(target, () => forceCloseSessionsByLockToggle(target)); }
    catch (e) { summary.mc = { ok: false, detail: 'exception:' + String(e && e.message) }; log({ ev: 'ban-enforce-mc-error', target, err: String(e && e.message) }); }
  } else {
    summary.mc = { ok: true, skipped: true, detail: 'skipped-by-caller' }; // DEV-21/S-B：调用方已 setLockBit 关会话，ok:false 会让 admin /ban 恒报「会话关闭未确认」假警报
  }

  // ④ 通知下游清会话（失败只记日志，读侧门兜底）
  if (!opts.mcOnly) {
    summary.friends = await postInternalJsonSafe(SOCIAL_INTERNAL_BASE, '/internal/ban-purge',
      { username: target, source: summary.source }, 'friends');
    summary.forum = await postInternalJsonSafe(FORUM_INTERNAL_BASE, '/api/forum/internal/purge-sessions',
      { username: target, source: summary.source }, 'forum');
  }

  log({ ev: 'ban-enforce', target, source: summary.source, ownerKept,
        revokedXids: summary.revokedXids, extSessionsCleared: summary.extSessionsCleared,
        mc: summary.mc, friends: summary.friends && summary.friends.ok, forum: summary.forum && summary.forum.ok });
  return summary;
}

// /points/api/* 与 /home/api/*：各处理器验完 auth 后逐个加
function denyIfBanned(res, username) {
  if (!username) return false;
  if (!isBanLinkedName(username)) return false;
  sendJson(res, 403, { ok: false, code: 'ACCOUNT_BANNED', msg: '账号已被封禁。' });
  return true;
}

// 在途校验单飞表：cacheKey -> Promise<auth|null>。管理页首刷 8 个接口并行
// 到达时，同一 xid 原先各开一条 MC 控制 WS 校验（MC 挂起时 8 条连接各等
// 16 秒、还放大 MC 负载）；现共享同一份在途校验，语义不变（等值结果、
// 失败仍不缓存——X-06 口径不动），只省掉重复开通道。
const validateInflight = new Map();
async function validateConsoleCookie(cookieHeader, clientIpHint) {
  if (!cookieHeader) return null;
  // 只摘 xid / xid.sig（照好友服务 trySso 的拼法，不把其他 cookie 带给控制通道）
  const jar = {};
  String(cookieHeader).split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) jar[p.slice(0, i).trim()] = p.slice(i + 1).trim();
  });
  if (!jar.xid) return null;
  // 缓存键必须带签名：只按 xid 做键时，一个同 xid 无签名的请求会把无效
  // 结果缓存住、连带拒绝随后带签名的真请求（2026-10-25 验收实测踩中）。
  const key = crypto.createHash('sha256').update(String(jar.xid) + '.' + String(jar['xid.sig'] || '')).digest('hex');
  // 已撤销的 xid（17:29 领取后原主人会话）直接拒，不走缓存、不开通道
  const rv = revokedXids[key];
  if (rv && rv.exp > Date.now()) return null;
  const hit = validateCache.get(key);
  if (hit && Date.now() - hit.at < 30000) return hit.user ? { user: hit.user, siteadmin: hit.siteadmin } : null;
  const inflight = validateInflight.get(key);
  if (inflight) return inflight;
  const p = (async () => {
    const parts = ['xid=' + jar.xid];
    if (jar['xid.sig']) parts.push('xid.sig=' + jar['xid.sig']);
    const cookieStr = parts.join('; ');
    let out = null;
    let lastErrMsg = '';
    for (let attempt = 0; attempt < 2 && !out; attempt++) {
      let sess = null;
      try {
        sess = await mcConnectCookie(cookieStr, 8000, [clientIpHint]);
        const info = sess.userinfo || {};
        const user = String(info._id || '').replace(/^user\/[^/]*\//, '').toLowerCase();
        if (user) out = { user, siteadmin: info.siteadmin || 0 };
      } catch (e) {
        lastErrMsg = (e && e.message) || 'unknown';
        if (e && e.message === 'mc-session-rejected') break; // 明确拒绝不再重试
      } finally { if (sess) { try { sess.ws.close(); } catch (e) {} } }
    }
    pruneValidateCache(Date.now());
    // X-06 缓存口径（2.4.5 定版，三类失败分开处理）：
    //  成功 → 缓存 30 秒；明确拒绝（mc-session-rejected，真无效会话）→ 缓存 30 秒，防反复打 MC；
    //  网络类失败（mc-connect-timeout / mc-conn-error / mc-auth-failed 等）→ 一律不缓存，
    //  防一次服务端抖动放大成 30 秒全站 401（与 checkSession「网络异常不踢下线」口径对齐）。
    if (out) validateCache.set(key, { at: Date.now(), user: out.user, siteadmin: out.siteadmin });
    else if (lastErrMsg === 'mc-session-rejected') validateCache.set(key, { at: Date.now(), user: null, siteadmin: 0 });
    else log({ ev: 'validate-not-cached', reason: lastErrMsg || 'unknown' });
    return out;
  })().catch((e) => { log({ ev: 'validate-unexpected-error', err: String((e && e.message) || e) }); return null; });
  validateInflight.set(key, p);
  try { return await p; }
  finally { if (validateInflight.get(key) === p) validateInflight.delete(key); }
}

// ---------- 本站会话（qfr_ext，落盘，重启不丢） ----------
let sessions = {}; // sha256(token) -> {user, siteadmin, exp}
try { const v = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')); if (v && typeof v === 'object') sessions = v; } catch (e) {}
function saveSessions() {
  try {
    const now = Date.now();
    for (const k of Object.keys(sessions)) if (sessions[k].exp <= now) delete sessions[k];
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(SESSIONS_FILE + '.tmp', JSON.stringify(sessions), { mode: 0o600 });
    fs.renameSync(SESSIONS_FILE + '.tmp', SESSIONS_FILE);
  } catch (e) { log({ ev: 'sessions-save-error', err: String(e && e.message) }); }
}
// ---------- QFClash 内嵌登录记录（2.0.3 更新 3） ----------
// 登录垫片在带 qfr_src=qfclash 标记的 /qf-login 成功时经内网接口记一笔；
// 个人中心「登录设备」据此显示「在QFClash应用登录中」＋登录时间，下线时
// 标记 revoked 并经 mcForceCloseUserSessions 终止该账号控制台会话。
const QFCLASH_LOGINS_FILE = path.join(DATA_DIR, 'qfclash-logins.json');
let qfclashLogins = [];
try { const v = JSON.parse(fs.readFileSync(QFCLASH_LOGINS_FILE, 'utf8')); if (Array.isArray(v)) qfclashLogins = v; } catch (e) {}
function saveQfclashLogins() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(QFCLASH_LOGINS_FILE + '.tmp', JSON.stringify(qfclashLogins), { mode: 0o600 });
    fs.renameSync(QFCLASH_LOGINS_FILE + '.tmp', QFCLASH_LOGINS_FILE);
  } catch (e) { log({ ev: 'qfclash-logins-save-error', err: String(e && e.message) }); }
}
function noteQfclashLogin(user, ua, xidHash) {
  // DS-R02-③：记录该次登录的 xid 哈希（与 validateCache 键同构造 sha256(xid+'.'+xid.sig)，不存明文），
  // 使撤销可按条靶向；loginshim 未上报哈希的旧记录落 null，撤销时回落全账号口径（保持旧行为）。
  qfclashLogins.push({ id: crypto.randomBytes(8).toString('hex'), user, at: Date.now(), ua: String(ua || '').slice(0, 120), xidHash: /^[0-9a-f]{64}$/.test(String(xidHash || '')) ? String(xidHash) : null, revokedAt: 0 });
  const mine = qfclashLogins.filter((r) => r.user === user);
  if (mine.length > 20) {
    const drop = mine.slice(0, mine.length - 20).map((r) => r.id);
    qfclashLogins = qfclashLogins.filter((r) => !drop.includes(r.id));
  }
  saveQfclashLogins();
}
function issueSession(res, auth) {
  const tok = crypto.randomBytes(32).toString('hex');
  const hash = crypto.createHash('sha256').update(tok).digest('hex');
  sessions[hash] = { user: auth.user, siteadmin: auth.siteadmin, exp: Date.now() + SESSION_TTL_MS };
  saveSessions();
  // 新发本站会话时一并清掉「手动退出」标记（退出只终止当次，重新进入即恢复）。
  res.setHeader('Set-Cookie', [
    'qfr_ext=' + tok + '; Path=/; Max-Age=' + Math.floor(SESSION_TTL_MS / 1000) + '; HttpOnly; SameSite=Lax; Secure',
    'qfr_ext_out=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure'
  ]);
}
// —— 手动退出标记（2.3.0 退出语义统一）——
// 本站会话之外，本服务还接受控制台会话 cookie 直接鉴权（resolveAuth）：
// 手动退出后若不拦这一路，页面一刷新就又以站长身份进来了。标记值 =
// 当时控制台会话 xid 的哈希：同一控制台会话内生效；控制台重新登录换
// 新会话后自动失效；从软件里重新打开管理页（一次性令牌换会话）时清除。
function xidHashFromReq(req) {
  const jar = parseCookies(req);
  if (!jar.xid) return '';
  return crypto.createHash('sha256').update(String(jar.xid) + '.' + String(jar['xid.sig'] || '')).digest('hex');
}
function extSsoSuppressed(req) {
  const jar = parseCookies(req);
  if (!jar.qfr_ext_out) return false;
  if (!jar.xid) return true;
  return jar.qfr_ext_out === xidHashFromReq(req);
}
function destroySession(req, res) {
  const tok = parseCookies(req).qfr_ext;
  if (tok) {
    const hash = crypto.createHash('sha256').update(tok).digest('hex');
    if (sessions[hash]) { delete sessions[hash]; saveSessions(); }
  }
  res.setHeader('Set-Cookie', [
    'qfr_ext=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure',
    'qfr_ext_out=' + (xidHashFromReq(req) || '1') + '; Path=/; Max-Age=' + Math.floor(SESSION_TTL_MS / 1000) + '; HttpOnly; SameSite=Lax; Secure'
  ]);
}
function sessionAuth(req) {
  const tok = parseCookies(req).qfr_ext;
  if (!tok) return null;
  const hash = crypto.createHash('sha256').update(tok).digest('hex');
  const s = sessions[hash];
  if (!s) return null;
  if (Date.now() > s.exp) { delete sessions[hash]; saveSessions(); return null; }
  return { user: s.user, siteadmin: s.siteadmin };
}

// 一次性令牌（内存，60 秒，单次使用）
const ssoTokens = new Map(); // token -> {user, siteadmin, exp}

// 统一鉴权：先本站会话，再手动附带的控制台 cookie
async function resolveAuth(req) {
  const s = sessionAuth(req);
  if (s) return s;
  if (extSsoSuppressed(req)) return null; // 已手动退出：同一控制台会话内不再自动鉴权带回
  const cookieHeader = req.headers.cookie;
  if (cookieHeader && /(?:^|;\s*)xid=/.test(cookieHeader)) {
    return await validateConsoleCookie(cookieHeader, clientIpFromReq(req));
  }
  return null;
}

function isAdmin(auth) {
  return !!auth && auth.user === ADMIN_EMAIL && auth.siteadmin === SITEADMIN_FULL;
}

// ---------- 积分数据（data/points.json，原子写） ----------
let pointsData = { users: {} };
try { const v = JSON.parse(fs.readFileSync(POINTS_FILE, 'utf8')); if (v && v.users) pointsData = v; } catch (e) {}
function savePoints() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(POINTS_FILE + '.tmp', JSON.stringify(pointsData, null, 1), { mode: 0o600 });
  fs.renameSync(POINTS_FILE + '.tmp', POINTS_FILE);
}
// X-17：心跳写盘 5 秒合并窗口——同一进程 5 秒内多次心跳只落盘一次，其余的
// 记一次延时落盘（5 秒窗口一到即补写，不丢分）。只改落盘节奏，不改积分计算
// 口径。写盘失败时调用方在响应里带 persisted:false，前端下次心跳重带一次。
let pointsLastSaveMs = 0;
let pointsSaveTimer = null;
function savePointsSoon() {
  const now = Date.now();
  if (now - pointsLastSaveMs >= 5000) {
    savePoints();
    pointsLastSaveMs = now;
    return { saved: true, deferred: false };
  }
  if (!pointsSaveTimer) {
    const wait = 5000 - (now - pointsLastSaveMs);
    pointsSaveTimer = setTimeout(() => {
      pointsSaveTimer = null;
      try { savePoints(); pointsLastSaveMs = Date.now(); } catch (e) { log({ ev: 'points-save-error', err: String(e && e.message) }); }
    }, wait);
    if (pointsSaveTimer && pointsSaveTimer.unref) pointsSaveTimer.unref();
  }
  return { saved: false, deferred: true };
}

// ---------- 账号库只读解析（照 mcdb.js 的 loadDb 做法） ----------
function loadDb() {
  const docs = new Map();
  const lines = fs.readFileSync(DB_FILE, 'utf8').split('\n');
  for (const line of lines) {
    const s = line.trim();
    if (!s) continue;
    let doc;
    try { doc = JSON.parse(s); } catch (e) { continue; }
    if (!doc || typeof doc._id !== 'string') continue;
    if (doc.$$deleted) docs.delete(doc._id); else docs.set(doc._id, doc);
  }
  return docs;
}
function loadLedger() {
  try { const v = JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf8')); if (v && v.accounts) return v; } catch (e) {}
  return { accounts: {} };
}
// 许可台账口径的账号封禁态（与 license-core syncAccountLinkage 的 link
// 维同源）：有永封或 B6/B7/B9 → 封禁类；其余生效封禁 → 冻结类。账号
// 列表的状态标签与「解封账号／解冻」按钮以此为准，不再单看 mcdb 旧
// 标志（2026-10-26 站长亲报：许可封禁后列表无标记、无解封入口）。
function licBanStateOf(login) {
  try {
    const bans = lic.activeBansFor(login, Date.now());
    const licBanned = bans.some((b) => b.permanent || ['B6', 'B7', 'B9'].includes(b.code));
    return { activeBanCount: bans.length, licBanned, licFrozen: bans.length > 0 && !licBanned };
  } catch (e) { log({ ev: 'lic-ban-state-error', target: login, err: String(e && e.message) }); return { activeBanCount: 0, licBanned: false, licFrozen: false }; }
}
function buildUsersList() {
  const docs = loadDb();
  const ledger = loadLedger();
  const users = [];
  const seen = new Set();
  for (const d of docs.values()) {
    if (!d._id || !d._id.startsWith('user/')) continue;
    if (d.type && d.type !== 'user') continue;
    const login = d._id.replace(/^user\/[^/]*\//, '').toLowerCase();
    if (!login) continue;
    seen.add(login);
    const e = ledger.accounts[login] || {};
    const licSt = licBanStateOf(login);
    const pv = profileCore ? profileCore.viewOf(login) : { nickname: null, hasAvatar: false, avatarUpdatedAt: null };
    users.push({
      login,
      displayName: d.realname || d.name || '',
      siteadmin: d.siteadmin || 0,
      // 冻结 = siteadmin 第 32 位；全权账号被源码豁免锁定，天生冻不住，不标冻结
      frozen: (d.siteadmin || 0) !== SITEADMIN_FULL && ((d.siteadmin || 0) & SITEADMIN_LOCKED_BIT) !== 0,
      isOwner: login === ADMIN_EMAIL,
      label: e.label || '',
      template: e.template || '',
      renameCount: e.renameCount || 0,
      banned: e.banned === true,
      activeBanCount: licSt.activeBanCount,
      licBanned: licSt.licBanned,
      licFrozen: licSt.licFrozen,
      exists: true,
      // 统一档案（2.3.2）：生效昵称与头像版本，供站长页展示与处置
      nickname: pv.nickname || '',
      hasAvatar: !!pv.hasAvatar,
      avatarUpdatedAt: pv.avatarUpdatedAt || 0,
      // P6-GK3：「收回密钥」行内钮的置灰判定（名下在效钥数，含未激活）
      liveKeyCount: lic.activeKeys(login, Date.now()).length,
    });
  }
  // 台账里已封号/已删除、库里已无记录的账号也列出来（封禁状态才看得见）；
  // 入选口径须与解封可达性一致：仅许可侧有生效封禁、或仅剩 frozen 残留
  // 的独有行同样要进列表，否则按账号解封对它们没有入口。
  for (const key of Object.keys(ledger.accounts)) {
    const e = ledger.accounts[key] || {};
    if (seen.has(key)) continue;
    const licSt2 = licBanStateOf(key);
    if (!e.banned && !e.deleted && e.frozen !== true && licSt2.activeBanCount === 0) continue;
    users.push({
      login: key,
      displayName: e.label || '',
      siteadmin: 0,
      frozen: e.frozen === true,
      isOwner: key === ADMIN_EMAIL,
      label: e.label || '',
      template: e.template || '',
      renameCount: e.renameCount || 0,
      banned: e.banned === true,
      activeBanCount: licSt2.activeBanCount,
      licBanned: licSt2.licBanned,
      licFrozen: licSt2.licFrozen,
      exists: false,
      liveKeyCount: lic.activeKeys(key, Date.now()).length,
    });
  }
  users.sort((a, b) => (b.isOwner - a.isOwner) || (b.exists - a.exists) || a.login.localeCompare(b.login));
  return users;
}
function findDbUser(docs, name) {
  return docs.get('user//' + String(name).toLowerCase()) || null;
}
// 与 mcdb guardNotAdmin 同口径的预检（拒绝时不进停服窗，服务不受影响）
// 注意：guardCheck 同时被 licLockAccount/licUnlockAccount 等自动执法联动复用，
// 那条链的「护栏」口径不变——自动流程永远不碰站长/服务/全权账号。
// pkg3 #1（M-C 中组，DS-REVIEW §3.3）：拒绝名单须与 friends 侧 GUARD
// （server/friends/server.js）完全一致——此前只挡 qf-regsvc /
// qf-socialsvc，device_review violation 联动 licLockAccount 时可能误锁
// qf-locksvc / qf-support / qf-official 等服务账号。两份名单字面同步，
// 改一处须改另一处；站长本人（ADMIN_EMAIL）仍由首行单独挡。
const GUARD_NAMES = new Set(['qf-regsvc', 'qf-socialsvc', 'qf-locksvc', 'qf-support', 'qf-official', 'admin', 'administrator', 'root', 'system']);
function guardCheck(user, name) {
  const n = String(name).toLowerCase();
  if (n === ADMIN_EMAIL) return '拒绝：站长管理员账号永不触碰。';
  if (GUARD_NAMES.has(n)) return '拒绝：' + n + ' 是系统／服务账号，永不触碰。';
  if (user && user.siteadmin === SITEADMIN_FULL) return '拒绝：目标是全权管理员账号（siteadmin=4294967295），永不触碰。';
  return null;
}
// #38（2026-10-25 23:41 站长令）：站长后台人工操作专用预检。本函数只被
// /admin/api 的账号操作入口调用（调用点已先过 isAdmin，即操作人必为站长
// 本人）——站长对包括自己账号在内的任何普通账号都可操作，只剩两个真服
// 务账号（qf-regsvc / qf-socialsvc）继续拒绝：它们是程序运行身份，不是
// 「对站长设限」。mcdb 侧靠 --admin-override 同口径放行（服务号仍拒）。
function adminGuardCheck(user, name) {
  const n = String(name).toLowerCase();
  if (n === 'qf-regsvc') return '拒绝：qf-regsvc 是注册服务的专用服务账号，永不触碰。';
  if (n === 'qf-socialsvc') return '拒绝：qf-socialsvc 是好友服务的执行账号，永不触碰。';
  return null;
}

// ---------- 外部命令（全部 execFile 参数数组，无 shell 拼接） ----------
function runCmd(file, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs || 60000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || ''), err: err ? String(err.message || err) : '' });
    });
  });
}
function probe8443() {
  return new Promise((resolve) => {
    const req = https.get({ hostname: '127.0.0.1', port: 8443, path: '/', rejectUnauthorized: false, timeout: 3000 }, (r) => {
      r.resume();
      resolve(r.statusCode || 0);
    });
    req.on('timeout', () => { req.destroy(); resolve(0); });
    req.on('error', () => resolve(0));
  });
}
async function waitRecovered() {
  for (let i = 0; i < 30; i++) {
    const code = await probe8443();
    if (code === 200) return 200;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return await probe8443();
}
function lastLine(text) {
  const lines = String(text || '').split('\n').map((s) => s.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1] : '';
}

// ---------- 管理操作（串行队列，一次只跑一个停服窗） ----------
let opChain = Promise.resolve();
function enqueueOp(fn) {
  const run = opChain.then(fn, fn);
  opChain = run.then(() => {}, () => {});
  return run;
}

async function runMcdbOp(action, target, opts) {
  // action: freeze|unfreeze|ban|resetpass —— 既有规矩的停服窗序列
  // opts.adminOverride（#38）：仅站长后台人工操作入口可传，mcdb 收到
  // --admin-override 后放行站长/全权目标（服务账号仍拒）；自动执法联动
  // （licLockAccount 等）与保留期清除一律不传，口径不变。
  const probeBefore = await probe8443();
  let started = false;
  try {
    await runCmd('systemctl', ['stop', 'qfremote-healthcheck.timer'], 20000);
    await runCmd('systemctl', ['stop', 'meshcentral'], 60000);
    const mcdbArgs = [action, target];
    if (opts && opts.adminOverride) mcdbArgs.push('--admin-override');
    const r = await runCmd('sudo', ['-n', 'node', MCDB].concat(mcdbArgs), 90000);
    // 交还属主：数据目录下全部 *.db ＋ 台账（照包装脚本口径）
    try {
      const files = fs.readdirSync(MC_DATA_DIR).filter((f) => f.endsWith('.db')).map((f) => path.join(MC_DATA_DIR, f));
      if (fs.existsSync(LEDGER_FILE)) files.push(LEDGER_FILE);
      if (files.length) await runCmd('chown', ['meshcentral:meshcentral'].concat(files), 20000);
    } catch (e) { /* 交不回去不拦正事，mcdb 自己也会 chownBack */ }
    await runCmd('systemctl', ['start', 'meshcentral'], 60000);
    started = true;
    await runCmd('systemctl', ['start', 'qfremote-healthcheck.timer'], 20000);
    const probeAfter = await waitRecovered();
    if (r.code !== 0) {
      const msg = lastLine(r.stderr) || lastLine(r.stdout) || '操作未成功，请稍后再试。';
      log({ ev: 'admin-op', action, target, ok: false, code: r.code, probeBefore, probeAfter });
      return { ok: false, msg, probeBefore, probeAfter };
    }
    if (action === 'resetpass') {
      let newPassword = '';
      try { newPassword = JSON.parse(lastLine(r.stdout)).newPassword || ''; } catch (e) {}
      if (!newPassword) {
        log({ ev: 'admin-op', action, target, ok: false, code: 'nopass', probeBefore, probeAfter });
        return { ok: false, msg: '密码重置结果异常，请到服务器人工确认后再试。', probeBefore, probeAfter };
      }
      // 新密码只回显在本次响应里；日志只记动作/目标/成败
      log({ ev: 'admin-op', action, target, ok: true, probeBefore, probeAfter });
      return { ok: true, msg: '密码已重置，请将新密码转发给对方；对方登录后可自行修改。', newPassword, probeBefore, probeAfter };
    }
    const msg = lastLine(r.stdout) || '操作完成。';
    log({ ev: 'admin-op', action, target, ok: true, probeBefore, probeAfter });
    return { ok: true, msg, probeBefore, probeAfter };
  } finally {
    if (!started) {
      // 兜底：任何一步没走完都把服务拉回来
      await runCmd('systemctl', ['start', 'meshcentral'], 60000).catch(() => {});
      await runCmd('systemctl', ['start', 'qfremote-healthcheck.timer'], 20000).catch(() => {});
    }
  }
}

async function runRenameOp(oldName, newName) {
  const probeBefore = await probe8443();
  const r = await runCmd('/bin/bash', [RENAME_SH, oldName, newName, '--admin-override'], 150000);
  const probeAfter = await probe8443();
  if (r.code !== 0) {
    const msg = lastLine(r.stderr) || lastLine(r.stdout) || '改名未成功，请稍后再试。';
    log({ ev: 'admin-op', action: 'rename', target: oldName, ok: false, code: r.code, probeBefore, probeAfter });
    return { ok: false, msg, probeBefore, probeAfter };
  }
  log({ ev: 'admin-op', action: 'rename', target: oldName, ok: true, probeBefore, probeAfter });
  // 改名挂钩（2.3.2 §5.8 必做）：统一档案键＋头像文件＋审核行跟随迁移；
  // 迁移失败不回滚改名（账号本体已改），记显著日志并在回执里明示待人工补迁（核对 #14）。
  let profileMigNote = '';
  if (profileCore) {
    try {
      const mig = profileCore.migrateProfile(oldName, newName);
      log({ ev: 'profile-migrate-after-rename', oldName, newName, movedProfile: mig.movedProfile, movedAvatar: mig.movedAvatar, modRows: mig.modRows });
    } catch (e) { profileMigNote = '（注意：统一档案迁移失败，已记日志，请人工补迁该账号的昵称/头像档案）'; log({ ev: 'profile-migrate-PENDING-manual-fix', oldName, newName, err: String(e && e.message) }); }
  }
  return { ok: true, msg: '改名完成：' + oldName + ' 已改为 ' + newName + '，对方用新名字和原密码登录。' + profileMigNote, probeBefore, probeAfter };
}

// ---------- HTTP 工具 ----------
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
function sendHtml(res, code, html) {
  const body = Buffer.from(html, 'utf8');
  res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': body.length, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
  res.end(body);
}
const BODY_LIMIT_DEFAULT = 65536;
const BODY_LIMIT_SHOT = 17 * 1024 * 1024; // 付款截图提交：图片上限 12MB（DS-R03-① 口径，orders-core MAX_SHOT_BYTES 同步）→ base64 恰 16MB + JSON 包装，报文上限取 17MB 留头（2026-10-26 热修史：原 64KB 上限＋destroy 掐断是真机大图提交必挂的根因）
const BODY_LIMIT_FILE = 288 * 1024 * 1024; // 设备间文件发送（#25）：单文件上限 200MB、base64 约 267MB + JSON 包装；须 > 默认 64KB，否则请求体被吞、toNode 读空误报「请选择要发送到的设备。」（2026-10-26 巡查 P2-003 实锤）
function readJsonBody(req, maxBytes) {
  const limit = (typeof maxBytes === 'number' && maxBytes > 0) ? Math.floor(maxBytes) : BODY_LIMIT_DEFAULT;
  return new Promise((resolve) => {
    const chunks = [];
    let total = 0, tooLarge = false, done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    req.on('data', (c) => {
      total += c.length;
      if (total > limit) { tooLarge = true; return; } // 超限只停止累积、继续收完（drain），绝不销毁连接，保证能回明确 JSON 错误
      chunks.push(c);
    });
    req.on('end', () => {
      if (tooLarge) { try { log({ ev: 'body-too-large', limit, total, url: String(req.url || '').slice(0, 80) }); } catch (e) {} return finish({ __tooLarge: true }); }
      try { finish(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { finish({}); }
    });
    req.on('close', () => finish({}));
    req.on('error', () => finish({}));
  });
}
function forbiddenPage(res) {
  sendHtml(res, 403, '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>无法打开 · QFRemote</title>'
    + '<style>body{margin:0;font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;background:#F4F7FB;color:#1c2733}.wrap{max-width:430px;margin:0 auto;padding:40px 16px}.card{background:#fff;border:1px solid #DFE7F2;border-radius:14px;padding:24px 20px}h1{font-size:18px;color:#0B2B5B;margin:0 0 10px}p{font-size:14px;line-height:1.8;color:#43536a}</style></head>'
    + '<body><div class="wrap"><div class="card"><h1>本页面仅站长可打开</h1><p>请先使用站长账号登录 QFRemote，再从软件中打开站长管理页。普通账号没有此权限。</p></div></div></body></html>');
}

// ---------- 跨服务内网调用（论坛/客服裁定回写，#22/#31：复用对方既有裁定入口） ----------
function postInternalJson(urlStr, obj, timeoutMs) {
  return new Promise((resolve) => {
    let u; try { u = new URL(urlStr); } catch (e) { return resolve({ ok: false, code: 'BAD_URL' }); }
    const data = Buffer.from(JSON.stringify(obj || {}));
    const isHttps = u.protocol === 'https:';
    const rq = (isHttps ? https : http).request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', timeout: timeoutMs || 5000, rejectUnauthorized: false,
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length, 'x-qf-internal-secret': LIC_SECRET } }, (rs) => {
      let b = '';
      rs.on('data', (c) => {
        b += c;
        // S2 根修：超限时先给出明确答复再断开，避免调用方拿不到结果只能等到超时
        if (b.length > 200000) { resolve({ ok: false, code: 'TOO_BIG' }); try { rq.destroy(); } catch (e) {} }
      });
      rs.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch (e) { resolve({ ok: false, code: 'BAD_JSON', status: rs.statusCode }); } });
    });
    rq.on('timeout', () => { rq.destroy(); resolve({ ok: false, code: 'TIMEOUT' }); });
    rq.on('error', (e) => resolve({ ok: false, code: 'NET', msg: String(e && e.message) }));
    rq.write(data); rq.end();
  });
}
const FORUM_INTERNAL_BASE = process.env.QFEXT_FORUM_URL || 'http://127.0.0.1:8446';
const SOCIAL_INTERNAL_BASE = process.env.QFEXT_SOCIAL_URL || 'https://127.0.0.1:8445'; // 好友服务为本机自签 HTTPS（与 nginx proxy_ssl_verify off 同口径）
const REG_INTERNAL_BASE = process.env.QFEXT_REG_URL || 'https://127.0.0.1:8444'; // 注册服务为本机自签 HTTPS（站长创建账号内网口，同上口径）
const SHIM_INTERNAL_BASE = process.env.QFEXT_SHIM_URL || 'http://127.0.0.1:8450'; // loginshim 内网口（DS-R28 解封联动清本地冻结）

// DS-R28：通知 loginshim 清除本地登录页冻结。成功回
// { ok:true, wasFrozen }；失败/超时回 null，调用方按失败文案追加回执。
async function clearLoginFreeze(username) {
  const target = String(username || '').trim().toLowerCase();
  try {
    const r = await postInternalJson(SHIM_INTERNAL_BASE + '/internal/clear-freeze', { username: target }, 3000);
    if (r && r.ok === true) return { ok: true, wasFrozen: r.wasFrozen === true };
    log({ ev: 'login-freeze-clear-failed', target, code: r && r.code });
    return null;
  } catch (e) {
    log({ ev: 'login-freeze-clear-error', target, err: String(e && e.message) });
    return null;
  }
}

function loginFreezeReceiptNote(r) {
  if (r && r.ok) return '登录页当日冻结已同步解除。';
  return '登录页冻结仍需改密或次日重置。';
}

// ---- B 设计 4.2 探测引擎：refId 前缀强绑定（B1）、超时双保险（B2）、连续失败熔断（B2）----
const PROBE_REF_RE = /^(post|reply):/;
let probeFailStreak = 0;     // 连续「非 ok:true」答复计数
let probeBreakerUntil = 0;   // 熔断窗口截止时刻（毫秒）

// 外层兜底：无论被等待的 Promise 是否落地，到点最多等到 ms 毫秒（超时给 null，由调用方按失败处理）
function probeRace(p, ms) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; resolve(null); } }, Math.max(1, ms));
    Promise.resolve(p).then(
      (v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } },
      () => { if (!settled) { settled = true; clearTimeout(timer); resolve(null); } }
    );
  });
}

async function probeForumExistsGone(refId) {
  const rid = String(refId || '');
  if (!PROBE_REF_RE.test(rid)) return false;              // B1：无 post:/reply: 前缀一律不探测
  const kind = rid.startsWith('reply:') ? 'reply' : 'post';
  if (Date.now() < probeBreakerUntil) return false;       // B2：熔断窗口内直接放弃，不发请求
  const out = await probeRace(postInternalJson(FORUM_INTERNAL_BASE + '/api/forum/internal/exists', { kind, id: rid }, 1500), 2000);
  if (!out || out.ok !== true) {                          // 超时/传输失败/坏响应/服务异常：一律不销
    // 门二 F6：只有传输/超时/服务未就绪类（无答复或带 code）计入熔断；论坛业务性 ok:false（无 code，如 400 参数）是确定答复，不计
    if (!out || out.code) {
      probeFailStreak += 1;
      if (probeFailStreak >= 3) { probeBreakerUntil = Date.now() + 30000; probeFailStreak = 0; }
    }
    return false;
  }
  probeFailStreak = 0;
  return out.exists === false;                            // 双绑：ok===true 且 exists===false 才算「确定不存在」
}

// 挂点甲/乙共用：pending forum 事件内容已删则销账，返回 resolve 结果（null 表示未销账/非目标事件）
const probeInFlight = new Set(); // 门二 F5：在途探测去重（按 refId），防并发/连刷放大
async function autoCloseForumEvent(ev) {
  if (!ev || ev.status !== 'pending' || ev.type !== 'forum') return null;
  if (probeInFlight.has(ev.refId)) return null;
  probeInFlight.add(ev.refId);
  try {
    const gone = await probeForumExistsGone(ev.refId);
    if (!gone) return null;
    // 并发安全：resolve 只翻仍为 pending 的事件，第二个探测者拿到 null，不会重复写
    const rec = reviewEvents.resolve('forum', ev.refId, '系统（自动销账）', '内容已删除，自动销账');
    if (rec) log({ ev: 'assistant-event-auto-closed', reason: 'content-gone', refId: ev.refId, eventId: ev.id });
    return rec || null;
  } finally {
    probeInFlight.delete(ev.refId);
  }
}

// 挂点甲用：单页仅探测前 20 条 pending forum，并发≤4，单请求总预算 4000ms，超预算的剩余事件跳过
async function autoSweepForumEvents(events) {
  const targets = (Array.isArray(events) ? events : []).filter((e) => e && e.status === 'pending' && e.type === 'forum').slice(0, 20);
  if (!targets.length) return;
  const deadline = Date.now() + 4000;
  let cursor = 0;
  const worker = async () => {
    while (cursor < targets.length) {
      const remain = deadline - Date.now();
      if (remain <= 0) return;
      const ev = targets[cursor++];
      await probeRace(autoCloseForumEvent(ev), remain);   // 单条超出剩余预算即放弃等待（后台落地无害）
    }
  };
  const lanes = [];
  for (let i = 0; i < Math.min(4, targets.length); i += 1) lanes.push(worker());
  await Promise.all(lanes);
}

// ---------- 许可：内网鉴权 / 执法判定 / 申诉裁决（双通道同台账） ----------
function startOfNextDayMs(now) {
  const dk = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
  return Date.parse(dk + 'T00:00:00+08:00') + 86400000;
}
function isInternal(req) {
  const remote = (req.socket && req.socket.remoteAddress) || '';
  const loop = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
  return loop && LIC_SECRET && req.headers['x-qf-internal-secret'] === LIC_SECRET;
}
function licEnforce(cfg, username) { return !cfg.shadow || cfg.testUsers.includes(String(username || '').toLowerCase()); }
// 执法联动：被统一台账封禁/冻结的账号同步 mcdb 冻结（MeshCentral 层硬拦），
// 解封联动解冻。guardCheck 拒绝的对象（站长/服务账号）跳过 mcdb 层，许可门仍生效。
async function licLockAccount(username) {
  try {
    const docs = loadDb(); const user = findDbUser(docs, username);
    if (!user || guardCheck(user, username)) return { state: 'guarded' };
    if (((user.siteadmin || 0) & SITEADMIN_LOCKED_BIT) !== 0) {
      // 定型设计 A：此态只跑 ①②④（DEV-05；DS 稿在此跑全套，与设计 A 冲突从设计）。
      // MC 位此前置位时已触发 close，补跑会话联动即可。
      let enf = null;
      try { enf = await executeBanEnforcement(username, 'lic-lock-already', { skipMc: true }); }
      catch (e) { log({ ev: 'ban-enforce-error', target: username, source: 'lic-lock-already', err: String(e && e.message) }); }
      return { state: 'already-locked', enforce: enf };
    }

    const out = await setLockBit(String(username).toLowerCase(), true, {});
    if (!out || !out.ok) return { state: 'failed', detail: (out && out.msg) || '' };

    // 成功路径：setLockBit 已让 MC 关会话，只补 ①②④
    let enf = null;
    try { enf = await executeBanEnforcement(username, 'lic-lock', { skipMc: true }); }
    catch (e) { log({ ev: 'ban-enforce-error', target: username, source: 'lic-lock', err: String(e && e.message) }); }
    return { state: 'locked', via: out.via, enforce: enf };
  } catch (e) { log({ ev: 'lic-lock-error', target: username, err: String(e && e.message) }); return { state: 'failed', detail: String(e && e.message) }; }
}
// 返回值如实回显解锁结果（旧调用方忽略返回值不受影响）：解封类入口必须
// 据此组装提示，不许在解锁未成时宣称「已解封」（2026-10-26 站长亲报缺陷）。
async function licUnlockAccount(username) {
  try {
    if (lic.activeBansFor(username, Date.now()).length) return { state: 'still-banned' };
    const docs = loadDb(); const user = findDbUser(docs, username);
    // 封禁已全清的前提下，guarded（全权/服务账号）与 already-unlocked
    // 两条早退也必须把 qf-account-ledger 的 frozen 残留写回，否则状态
    // 面与许可面长期不一致（2026-10-26 站长本人误封案实证）。
    if (!user || guardCheck(user, username)) return { state: 'guarded', ledgerCleared: clearLedgerResidue(String(username).toLowerCase(), 'ext-lic-unlock') };
    if (((user.siteadmin || 0) & SITEADMIN_LOCKED_BIT) === 0) return { state: 'already-unlocked', ledgerCleared: clearLedgerResidue(String(username).toLowerCase(), 'ext-lic-unlock') };
    const out = await setLockBit(String(username).toLowerCase(), false, {});
    return out && out.ok ? { state: 'unlocked', via: out.via, ledgerCleared: clearLedgerResidue(String(username).toLowerCase(), 'ext-lic-unlock') } : { state: 'failed', detail: (out && out.msg) || '' };
  } catch (e) { log({ ev: 'lic-unlock-error', target: username, err: String(e && e.message) }); return { state: 'failed', detail: String(e && e.message) }; }
}
// 全量解封（解封口径统一）：解掉该账号全部生效中的封禁记录（永久含恢复
// 被回收密钥），供各解封入口共用——任一入口点「解封」即全解，不再出现
// 「解了一条、账号仍封禁」（2026-10-26 站长亲报缺陷根因）。
function liftAllActiveBans(username, actor) {
  const lifted = [];
  for (const b of lic.activeBansFor(username, Date.now())) { lic.liftBan(b, Date.now(), { by: actor, restoreKeys: true }); lifted.push(b.id); }
  return lifted;
}
// #38 站长改判预备（仅 decideAppeal 在「已裁定 + actor=owner + override」时调用）：
// 返回 'FRESH'＝申诉已重置为待审、由正常流程按本次结论重新裁决；返回
// {handled:true,...}＝改判已当场办结（调用方负责落盘/销账/联动锁定）；
// 返回 {code,msg}＝此情形不支持改判。助手通道永不走此路径。
function prepareAppealOverride(a, decision, reason, extra, now) {
  if (!Array.isArray(a.overrideHistory)) a.overrideHistory = [];
  const hist = { at: new Date(now).toISOString(), by: 'owner', prevStatus: a.status, prevDecision: a.decisionKind || null, newDecision: decision };
  if (a.type === 'rebind') {
    if (a.status === 'approved' && decision === 'reject') {
      // 已通过的换绑改判驳回：先把槽位换回旧设备（执行失败则不落改判）
      if (!reason) return { code: 'VALIDATION', msg: '改判驳回须写明原因。' };
      const oldHash = a.rebindExec && a.rebindExec.oldDeviceCode;
      if (!oldHash) return { code: 'OVERRIDE_NOT_APPLICABLE', msg: '原换绑记录缺少旧设备信息，无法回滚换绑。' };
      const exec = lic.executeRebindByHash({ username: String(a.username || '').toLowerCase(), platform: a.platform, newDeviceCodeHash: oldHash, appealId: a.id, actor: 'owner-override' }, now);
      if (!exec.ok) return { code: 'OVERRIDE_EXEC_FAILED', msg: '换绑回滚执行被拒：' + (exec.msg || '') };
      a.status = 'rejected'; a.reason = String(reason).slice(0, 500); a.decidedAt = new Date(now).toISOString(); a.decidedBy = 'owner'; a.decisionKind = 'override-reject';
      a.rebindExec = { slot: exec.slot, keyId: exec.keyId, oldDeviceCode: exec.oldDeviceCode || null, newDeviceCodeHash: exec.newDeviceCodeHash || oldHash, alreadyBound: !!exec.alreadyBound, at: now, rollback: true };
      a.overrideHistory.push(hist);
      return { handled: true, kind: 'rebind-rollback', msg: '改判完成：换绑已回滚到原设备，申诉改为驳回。' };
    }
    if (a.status === 'rejected') { a.status = 'pending'; a.overrideHistory.push(hist); return 'FRESH'; }
    return { code: 'OVERRIDE_NOT_APPLICABLE', msg: '该换绑申诉当前情形不支持此改判。' };
  }
  if (!a.banId && !a.reasonCode) return { code: 'OVERRIDE_NOT_APPLICABLE', msg: 'B1 冻结申诉走既有改密闭环，不支持在此改判。' };
  const oldBan = a.banId ? lic.getBan(a.banId) : null;
  if (!oldBan) return { code: 'OVERRIDE_NOT_APPLICABLE', msg: '原封禁记录不存在，改判无对象。' };
  if (oldBan.status === 'active') { a.status = 'pending'; a.overrideHistory.push(hist); return 'FRESH'; }
  // 原封禁已解除（原结论为通过/部分解除）：仅支持改判驳回＝按原剩余时长恢复封禁
  if (decision !== 'reject') return { code: 'OVERRIDE_NOT_APPLICABLE', msg: '原封禁已解除，此情形改判仅支持恢复封禁（结论＝驳回）。' };
  if (!reason) return { code: 'VALIDATION', msg: '改判驳回须写明原因。' };
  let newBan;
  if (oldBan.permanent) {
    newBan = lic.applyBan({ targetType: oldBan.targetType, target: oldBan.target, code: oldBan.code, permanent: true, actor: 'owner-override', evidence: 'appeal-override ' + a.id }, now);
  } else {
    const remaining = (oldBan.endsAt || 0) - (oldBan.liftedAt ? Number(oldBan.liftedAt) : now);
    if (!oldBan.endsAt || remaining <= 0) return { code: 'OVERRIDE_NOT_APPLICABLE', msg: '原封禁期限已经过，改判无对象。' };
    newBan = lic.applyBan({ targetType: oldBan.targetType, target: oldBan.target, code: oldBan.code, permanent: false, endsAt: now + remaining, actor: 'owner-override', evidence: 'appeal-override ' + a.id }, now);
  }
  if (!newBan || !newBan.id) return { code: 'OVERRIDE_EXEC_FAILED', msg: '恢复封禁未成功。' };
  a.banId = newBan.id; a.status = 'rejected'; a.reason = String(reason).slice(0, 500); a.decidedAt = new Date(now).toISOString(); a.decidedBy = 'owner'; a.decisionKind = 'override-reject';
  a.overrideHistory.push(hist);
  return { handled: true, kind: 'ban-restore', msg: '改判完成：封禁已恢复，申诉改为驳回。', lockUser: oldBan.targetType === 'account' };
}
// 申诉裁决（站长后台与助手代审共用同一入口，§6.4 防双判：非 pending 直接拒；
// #38 例外：站长本人带 override:true 可改判，见 prepareAppealOverride）
let appealDecideChain = Promise.resolve();
function decideAppealLocked(fn) { const run = appealDecideChain.then(fn, fn); appealDecideChain = run.then(() => {}, () => {}); return run; }
async function decideAppeal(appealId, decision, reason, actor, extra) {
  return decideAppealLocked(async () => {
    let data = { appeals: [] };
    try { const v = JSON.parse(fs.readFileSync(APPEALS_FILE, 'utf8')); if (v && Array.isArray(v.appeals)) { v.appeals = v.appeals.filter((x) => x && typeof x === 'object'); data = v; } } catch (e) {}
    const a = data.appeals.find((x) => x.id === appealId);
    if (!a) return { ok: false, code: 'NOT_FOUND', msg: '申诉不存在。' };
    const now = Date.now();
    if (a.status !== 'pending') {
      // #38：站长改判——仅 actor=owner 且请求显式带 override:true 才进入；
      // 其余一切调用（含助手接口）维持防双判原口径。
      if (actor === 'owner' && extra && extra.override === true) {
        const ov = prepareAppealOverride(a, decision, reason, extra, now);
        if (ov === 'FRESH') { /* 已重置待审，继续走下方正常裁决流程 */ }
        else if (ov && ov.handled) {
          try {
            const tmp = APPEALS_FILE + '.tmp-lic'; fs.writeFileSync(tmp, JSON.stringify(data, null, 1), { mode: 0o600 }); fs.renameSync(tmp, APPEALS_FILE);
            try { const st = fs.statSync(path.dirname(APPEALS_FILE)); fs.chownSync(APPEALS_FILE, st.uid, st.gid); } catch (e) {}
          } catch (e) { return { ok: false, code: 'IO', msg: '申诉结论落盘失败。' }; }
          if (ov.lockUser && a.username) await licLockAccount(String(a.username).toLowerCase());
          log({ ev: 'appeal-override', appealId: a.id, decision, actor, target: a.username, kind: ov.kind });
          reviewEvents.resolve('appeal', a.id, actor, 'override-' + decision);
          return { ok: true, msg: ov.msg, override: true };
        } else {
          return { ok: false, code: (ov && ov.code) || 'OVERRIDE_NOT_APPLICABLE', msg: (ov && ov.msg) || '该申诉当前情形不支持改判。' };
        }
      } else {
        return { ok: false, code: 'ALREADY_DECIDED', msg: '该申诉已由另一通道处理。', decidedStatus: a.status };
      }
    }
    const isB1 = a.type !== 'rebind' && !a.banId && !a.reasonCode; // DS-R02-②：与助手分流口径对齐，type 显式排除（现行换绑单恒带 reasonCode=REBIND 本已落空，此为防数据形状漂移的口径统一，零行为变更）
    if (isB1) return { ok: false, code: 'LEGACY_B1', msg: 'B1 冻结申诉走既有改密闭环（appeal-admin approve/reject）。' };
    // ===== 换绑申诉裁决（§11.9）：与封禁申诉同队列同台账、同一防双判；
    // 通过即同事务真实执行换绑（人工裁决补救通道，不随影子模式打折）。
    // 执行被拒（新设备码为封禁设备码等）时不落结论：回写审核备注留痕、
    // 申诉保持待审，裁决人可改判驳回或待情形变化后重试。 =====
    if (a.type === 'rebind') {
      if (decision === 'reject') {
        if (!reason) return { ok: false, code: 'VALIDATION', msg: '驳回须写明原因。' };
        a.status = 'rejected'; a.reason = String(reason).slice(0, 500); a.decidedAt = new Date(now).toISOString(); a.decidedBy = actor;
      } else if (decision === 'approve') {
        // 申诉台账存设备码哈希（与许可槽位同口径），执行走核心哈希入口。
        const exec = lic.executeRebindByHash({ username: String(a.username || '').toLowerCase(), platform: a.platform, newDeviceCodeHash: a.newDeviceCodeHash, appealId: a.id, actor }, now);
        if (!exec.ok) {
          a.executionNote = '执行被拒（' + (exec.code || 'ERROR') + '）：' + (exec.msg || '');
          a.executionAttempts = (Array.isArray(a.executionAttempts) ? a.executionAttempts : []).concat([{ at: now, by: actor, code: exec.code || 'ERROR' }]).slice(-10);
          try {
            const tmp2 = APPEALS_FILE + '.tmp-lic'; fs.writeFileSync(tmp2, JSON.stringify(data, null, 1), { mode: 0o600 }); fs.renameSync(tmp2, APPEALS_FILE);
            try { const st2 = fs.statSync(path.dirname(APPEALS_FILE)); fs.chownSync(APPEALS_FILE, st2.uid, st2.gid); } catch (e) {}
          } catch (e) {}
          log({ ev: 'rebind-exec-rejected', appealId: a.id, code: exec.code, actor, target: a.username });
          return { ok: false, code: exec.code || 'REBIND_EXEC_FAILED', msg: '换绑执行被拒：' + (exec.msg || '') + '审核备注已回写，申诉保持待审。' };
        }
        a.status = 'approved'; a.decidedAt = new Date(now).toISOString(); a.decidedBy = actor; a.decisionKind = 'approve';
        a.rebindExec = { slot: exec.slot, keyId: exec.keyId, oldDeviceCode: exec.oldDeviceCode || a.oldDeviceCode || null, newDeviceCodeHash: exec.newDeviceCodeHash || a.newDeviceCodeHash, alreadyBound: !!exec.alreadyBound, at: now };
        delete a.executionNote;
      } else return { ok: false, code: 'VALIDATION', msg: '换绑申诉结论只支持通过或驳回。' };
      try {
        const tmp = APPEALS_FILE + '.tmp-lic'; fs.writeFileSync(tmp, JSON.stringify(data, null, 1), { mode: 0o600 }); fs.renameSync(tmp, APPEALS_FILE);
        try { const st = fs.statSync(path.dirname(APPEALS_FILE)); fs.chownSync(APPEALS_FILE, st.uid, st.gid); } catch (e) {}
      } catch (e) { return { ok: false, code: 'IO', msg: '申诉结论落盘失败。' }; }
      log({ ev: 'appeal-decided', appealId: a.id, decision, actor, target: a.username, kind: 'rebind' });
      reviewEvents.resolve('rebind', a.id, actor, decision);
      return { ok: true, msg: decision === 'approve' ? '换绑已执行：同类旧设备已解绑、新设备已绑入。' : '换绑申诉已驳回。' };
    }
    if (decision === 'reject') {
      if (!reason) return { ok: false, code: 'VALIDATION', msg: '驳回须写明原因。' };
      a.status = 'rejected'; a.reason = String(reason).slice(0, 500); a.decidedAt = new Date(now).toISOString(); a.decidedBy = actor;
    } else if (decision === 'approve' || decision === 'partial' || decision === 'reduce') {
      a.status = 'approved'; a.decidedAt = new Date(now).toISOString(); a.decidedBy = actor;
      if (decision === 'reduce' && a.banId && extra && extra.newEndsAt) lic.adjustBanEnds(a.banId, Number(extra.newEndsAt), now);
      if ((decision === 'approve' || decision === 'partial') && a.banId) {
        const ban = lic.getBan(a.banId);
        if (ban && ban.status === 'active') lic.liftBan(ban, now, { by: actor, appealId: a.id, restoreKeys: decision === 'approve' });
        else if (ban && ban.status !== 'active') { /* 已到期/已解除：结论照常生效 */ }
      }
      a.decisionKind = decision;
    } else return { ok: false, code: 'VALIDATION', msg: '结论类型不正确。' };
    try {
      const tmp = APPEALS_FILE + '.tmp-lic'; fs.writeFileSync(tmp, JSON.stringify(data, null, 1), { mode: 0o600 }); fs.renameSync(tmp, APPEALS_FILE);
      try { const st = fs.statSync(path.dirname(APPEALS_FILE)); fs.chownSync(APPEALS_FILE, st.uid, st.gid); } catch (e) {}
    } catch (e) { return { ok: false, code: 'IO', msg: '申诉结论落盘失败。' }; }
    if (decision !== 'reject' && a.username) await licUnlockAccount(String(a.username).toLowerCase());
    log({ ev: 'appeal-decided', appealId: a.id, decision, actor, target: a.username });
    reviewEvents.resolve('appeal', a.id, actor, decision);
    return { ok: true, msg: '申诉结论已生效并回写台账。' };
  });
}
// 状态查询核验/验密限流（内存计数 + 审计留痕 R-06）
const licVerifyState = new Map(); // key -> {fails, lockedUntil}
function licVerifyHit(mapKey, ok) {
  const now = Date.now();
  let s = licVerifyState.get(mapKey);
  if (!s) { s = { fails: 0, lockedUntil: 0 }; licVerifyState.set(mapKey, s); }
  if (s.lockedUntil > now) return { locked: true, until: s.lockedUntil };
  if (ok) { s.fails = 0; return { locked: false }; }
  s.fails += 1;
  if (s.fails >= 5) { s.lockedUntil = now + 3600000; s.fails = 0; return { locked: true, until: s.lockedUntil }; }
  return { locked: false };
}
function licVerifyLocked(mapKey) {
  const s = licVerifyState.get(mapKey);
  return !!(s && s.lockedUntil > Date.now());
}

// ---------- 首页使用统计（阶段 C-3）：全部真实数据，拿不到给 null ----------
// 设备与在线状态：借请求自带的控制台会话开控制通道发 nodes 请求
// （MeshCentral meshuser.js 的 nodes 动作回带 conn 位：&1＝代理在线），
// 这与网页控制台自身取设备列表是同一条真实路径，不是数据库猜测。
// R4 口径：会话验真/取数都走 mcConnectCookie 的候选 IP 链（xid 内登录
// IP 优先 → XFF 还原的请求 IP → 无转发），与既有小服务完全一致。
// ---------- 设备在线观测（W-10 / §4.2 第一步，不动 MC 本体） ----------
// 服务端原来回答「在线吗」的唯一依据是 agent 的 TCP 长连接位 conn&1；
// agent 假死但 TCP 未断时该位不翻转，服务端会持续谎报在线。本表记录的是
// 「服务端最后一次亲眼见到某节点在线的时间」（观测时间，不是 agent 心跳
// 时间）：每次 mcFetchNodes 成功拿到 nodes 回包就打戳。局限（须诚实说明）：
// conn 位为 1 的节点每次观测都会刷新 lastSeenOnlineMs，所以第一步只能解决
// 「conn 位已翻转但调用方还在用旧缓存」的 stale，不能解决「conn 位本身不
// 翻转」的假死——后者须 §4.2 第二步（持久观测 WS）才根治，2.4.5 未排进，
// 不得对外宣称「已解决假死」。
// 观测表按「账号|nodeid」分键： presence 只在调用方自己的可见回包里找节点，
// 找不到即 NOT_FOUND；跨账号的观测记录绝不用来回答另一账号的查询（防越权
// 泄露他人设备存在性）。
const PRESENCE_FRESH_MS = 120000;   // fresh：age ≤ 120 秒（预检放行）
const PRESENCE_STALE_MS = 300000;   // STALE：120–300 秒；OFFLINE：>300 秒或本次观测 conn=0
const presenceObs = new Map(); // '<user>|<nodeid>' -> {lastSeenOnlineMs, lastSeenOfflineMs}
function presenceObsKey(user, nodeid) { return String(user || '').toLowerCase() + '|' + normalizeNodeId(nodeid); }
function observeNodesForPresence(nodesByMesh, user, now) {
  now = now || Date.now();
  if (!nodesByMesh || typeof nodesByMesh !== 'object') return;
  for (const d of flattenMeshNodes(nodesByMesh)) {
    const k = presenceObsKey(user, d.nodeid);
    const e = presenceObs.get(k) || {};
    if (d.online) e.lastSeenOnlineMs = now;
    else { e.lastSeenOfflineMs = now; /* 保留上次 lastSeenOnlineMs，供算「最后在线是多久前」 */ }
    presenceObs.set(k, e);
  }
  // 剪枝：最后在线超过 1 小时的观测记录不再用于 STALE/UNKNOWN 判定，直接丢弃
  if (presenceObs.size > 2000) {
    for (const [k, v] of presenceObs) { if (!v || !v.lastSeenOnlineMs || now - v.lastSeenOnlineMs > 3600000) presenceObs.delete(k); }
  }
}
function presenceObsFor(user, nodeid) {
  const e = presenceObs.get(presenceObsKey(user, nodeid));
  if (!e || !e.lastSeenOnlineMs) return { lastAgentPong: null, lastAgentPongAgeMs: null };
  return { lastAgentPong: e.lastSeenOnlineMs, lastAgentPongAgeMs: Date.now() - e.lastSeenOnlineMs };
}
// 全局观测表（§4.2 第二步持久观测 WS 的写入目标）：nodeid -> {lastSeenOnlineMs, lastSeenOfflineMs}。
// 与按账号分的 presenceObs 不同，本表不分账号，因此只允许 resolvePresence 在
// 「节点已在调用方可见回包里」的前提下引用，绝不用于判定节点是否存在。
const presenceObsGlobal = new Map();
function observeNodesGlobal(nodesByMesh, now) {
  now = now || Date.now();
  if (!nodesByMesh || typeof nodesByMesh !== 'object') return;
  for (const d of flattenMeshNodes(nodesByMesh)) {
    const e = presenceObsGlobal.get(d.nodeid) || {};
    if (d.online) e.lastSeenOnlineMs = now;
    else e.lastSeenOfflineMs = now;
    presenceObsGlobal.set(d.nodeid, e);
  }
  if (presenceObsGlobal.size > 2000) {
    for (const [k, v] of presenceObsGlobal) { if (!v || !v.lastSeenOnlineMs || now - v.lastSeenOnlineMs > 3600000) presenceObsGlobal.delete(k); }
  }
}
// ---------- §4.2 第二步：持久观测 WS（默认关闭，须服务端显式开启） ----------
// 目的：把观测间隔从「有人问才观测」变成「一直观测」，使 conn 位翻转能在数秒
// 内被发现（第一步里翻转要等下一次有人问才知道）。做法与 lock-bridge 的 svc
// 持久通道同款：用同一份服务账号配置（/opt/qfremote-lock/bridge-config.json
// 的 svcUser/svcPass，只读，不新增任何凭据）开一条常驻 control.ashx WS，
// 就绪后立即发一次 nodes、此后每 30 秒轮询一次，收到的 nodes 推送也即时入表。
// 开启条件（缺一即保持关闭，不影响任何现有接口）：
//   环境变量 QFEXT_PRESENCE_OBSERVE=1，且桥配置文件存在且能读出 svcUser/svcPass。
// 诚实边界：持久观测同样只看 conn 位——若 MC 的 conn 位本身不翻转（真假死），
// 它也判不出 STALE；它只解决「翻转发现延迟」。上游节点字段取证（见 /tmp 下
// 的一次性脚本与回报）：`nodes` 回包是否带心跳类时间戳字段，须在服务端实测
// 后才能定论；agct 是连接建立时间不是心跳，不能用来判 stale。
// 安全：重连退避与 lock-bridge 同款（1s 起、×2、封顶 30s，凭据类封顶 60s）；
// 日志只写字段名清单与连接状态，绝不打印凭据、节点名、nodeid。
const PRESENCE_OBSERVE_ENABLED = process.env.QFEXT_PRESENCE_OBSERVE === '1';
const PRESENCE_OBSERVE_POLL_MS = 30000;
let presenceObserverLoggedFields = false;
const presenceObserver = { ws: null, ready: false, connecting: false, failStreak: 0, downSince: 0, nextAttemptAt: 0, timer: null, pollTimer: null, cfg: null };
function presenceObserverConfig() {
  if (presenceObserver.cfg !== undefined) return presenceObserver.cfg;
  presenceObserver.cfg = null;
  try {
    const raw = JSON.parse(fs.readFileSync('/opt/qfremote-lock/bridge-config.json', 'utf8'));
    if (raw && raw.svcUser && raw.svcPass && raw.mcUrl) presenceObserver.cfg = raw;
  } catch (e) { presenceObserver.cfg = null; }
  return presenceObserver.cfg;
}
function presenceObserverScheduleReconnect(reason) {
  const auth = /noauth|auth-failed|bad-credential/.test(String(reason || ''));
  const cap = auth ? 60000 : 30000;
  presenceObserver.failStreak += 1;
  const delay = Math.round(Math.min(1000 * Math.pow(2, Math.min(presenceObserver.failStreak - 1, 6)), cap) * (0.8 + Math.random() * 0.4));
  presenceObserver.nextAttemptAt = Date.now() + delay;
  if (presenceObserver.failStreak === 1) log({ ev: 'presence-observer-down', reason: String(reason || 'svc-down'), retryInMs: delay });
  if (!presenceObserver.timer) {
    presenceObserver.timer = setTimeout(() => { presenceObserver.timer = null; presenceObserverConnect(); }, delay);
    if (presenceObserver.timer && presenceObserver.timer.unref) presenceObserver.timer.unref();
  }
}
function presenceObserverPoll() {
  if (!presenceObserver.ws || !presenceObserver.ready) return;
  try { presenceObserver.ws.send(JSON.stringify({ action: 'nodes', responseid: 'qf-presence-' + Date.now() })); } catch (e) {}
}
function presenceObserverConnect() {
  if (!PRESENCE_OBSERVE_ENABLED) return;
  if (presenceObserver.ws || presenceObserver.connecting) return;
  const cfg = presenceObserverConfig();
  if (!cfg) { if (!presenceObserver.cfgLogged) { presenceObserver.cfgLogged = true; log({ ev: 'presence-observer-off', reason: 'no-service-config' }); } return; }
  if (Date.now() < presenceObserver.nextAttemptAt) {
    if (!presenceObserver.timer) {
      presenceObserver.timer = setTimeout(() => { presenceObserver.timer = null; presenceObserverConnect(); }, Math.max(50, presenceObserver.nextAttemptAt - Date.now()));
      if (presenceObserver.timer && presenceObserver.timer.unref) presenceObserver.timer.unref();
    }
    return;
  }
  presenceObserver.connecting = true;
  const xauth = Buffer.from(cfg.svcUser).toString('base64') + ',' + Buffer.from(cfg.svcPass).toString('base64');
  let ws;
  try {
    const WebSocket = loadWebSocket();
    ws = new WebSocket(String(cfg.mcUrl).replace(/\/$/, '') + '/control.ashx', { rejectUnauthorized: false, headers: { 'x-meshauth': xauth, Origin: 'https://127.0.0.1:8443' } });
  } catch (e) {
    presenceObserver.connecting = false;
    presenceObserverScheduleReconnect('construct-failed');
    return;
  }
  presenceObserver.ws = ws;
  const handshakeTimer = setTimeout(() => {
    if (presenceObserver.ready) return;
    try { ws.close(); } catch (e) {}
  }, 8000);
  if (handshakeTimer && handshakeTimer.unref) handshakeTimer.unref();
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch (e) { return; }
    if (m && m.action === 'close') {
      const cause = String(m.cause || '') + (m.msg ? '/' + String(m.msg) : '');
      log({ ev: 'presence-observer-rejected', cause });
      try { ws.close(); } catch (e) {}
      return;
    }
    if (m && m.action === 'userinfo') {
      const wasDown = presenceObserver.downSince;
      presenceObserver.ready = true; presenceObserver.connecting = false;
      presenceObserver.failStreak = 0; presenceObserver.downSince = 0; presenceObserver.nextAttemptAt = 0;
      clearTimeout(handshakeTimer);
      log({ ev: 'presence-observer-ready', resumedAfterMs: wasDown ? Date.now() - wasDown : 0 });
      presenceObserverPoll();
      if (!presenceObserver.pollTimer) {
        presenceObserver.pollTimer = setInterval(presenceObserverPoll, PRESENCE_OBSERVE_POLL_MS);
        if (presenceObserver.pollTimer && presenceObserver.pollTimer.unref) presenceObserver.pollTimer.unref();
      }
      return;
    }
    if (m && m.action === 'nodes' && m.nodes) {
      // 取证：第一次收到 nodes 时只记字段名清单（不记任何节点值），供核对
      // 回包是否带时间戳类字段（agct 除外是否还有 lastSeen/lastConnect 等）。
      if (!presenceObserverLoggedFields) {
        presenceObserverLoggedFields = true;
        try {
          const first = Object.values(m.nodes).flat().find((n) => n && typeof n === 'object');
          if (first) log({ ev: 'presence-nodes-fields', fields: Object.keys(first).sort() });
        } catch (e) {}
      }
      observeNodesGlobal(m.nodes, Date.now());
    }
  });
  ws.on('close', () => {
    clearTimeout(handshakeTimer);
    if (presenceObserver.downSince === 0) presenceObserver.downSince = Date.now();
    presenceObserver.ws = null; presenceObserver.connecting = false; presenceObserver.ready = false;
    presenceObserverScheduleReconnect(presenceObserver.ready ? 'svc-closed' : 'svc-closed-unready');
  });
  ws.on('error', () => { try { ws.close(); } catch (e) {} });
}
if (PRESENCE_OBSERVE_ENABLED && !process.env.QFEXT_NO_LISTEN) {
  // 随进程启动（延时 5 秒，避开启动期的建链竞争）；未开启时零开销、零行为变化。
  const _obsT = setTimeout(presenceObserverConnect, 5000);
  if (_obsT && _obsT.unref) _obsT.unref();
}
// 纯判定（无 IO，供路由与本地自测共用）：nodesByMesh 为 null＝取数失败/超时。
// code 枚举：ONLINE / STALE / OFFLINE / NOT_FOUND / TIMEOUT / UNKNOWN。
// NOT_FOUND 与 UNKNOWN 的区分：调用方可见回包里没有该节点，且本账号的观测表
// 里也没有它最近在线的记录 → NOT_FOUND（不存在或无权看，不泄露存在性）；
// 观测表里有它最近（≤120 秒）在线的记录、但本次回包里没了 → UNKNOWN（取数
// 未同步，不得说成离线）；120–300 秒前最后在线、本次回包里没了 → STALE。
function resolvePresence(nodesByMesh, nodeid, now, user) {
  now = now || Date.now();
  const id = normalizeNodeId(nodeid);
  if (!nodesByMesh) return { ok: true, code: 'TIMEOUT', nodeid: id, name: '', online: false, fresh: false, lastAgentPong: null, lastAgentPongAgeMs: null, agentConnectedAt: null, serverTime: now };
  const list = flattenMeshNodes(nodesByMesh);
  const hit = list.find((d) => d.nodeid === id);
  const obs = presenceObs.get(presenceObsKey(user, id));
  const last = obs && obs.lastSeenOnlineMs ? obs.lastSeenOnlineMs : null;
  const age = last != null ? now - last : null;
  // 全局持久观测（§4.2 第二步，见 presenceObserver；默认关闭）：只在节点确
  // 在调用方可见回包里、且本账号观测表无记录时，补一个「最后在线」时间窗，
  // 绝不用来改变 code、绝不用于回包里没有的节点（不泄露存在性）。
  let globalLast = null;
  if (hit && last == null) { const g = presenceObsGlobal.get(id); if (g && g.lastSeenOnlineMs) globalLast = g.lastSeenOnlineMs; }
  const effLast = last != null ? last : globalLast;
  const effAge = effLast != null ? now - effLast : null;
  const agct = hit ? (hit.agentConnectedAt || null) : null;
  if (hit) {
    if (hit.online) return { ok: true, code: 'ONLINE', nodeid: id, name: hit.name, online: true, fresh: true, lastAgentPong: effLast, lastAgentPongAgeMs: effAge, agentConnectedAt: agct, serverTime: now };
    return { ok: true, code: 'OFFLINE', nodeid: id, name: hit.name, online: false, fresh: false, lastAgentPong: effLast, lastAgentPongAgeMs: effAge, agentConnectedAt: agct, serverTime: now };
  }
  if (last != null && age != null && age > PRESENCE_FRESH_MS && age <= PRESENCE_STALE_MS) {
    return { ok: true, code: 'STALE', nodeid: id, name: '', online: false, fresh: false, lastAgentPong: last, lastAgentPongAgeMs: age, agentConnectedAt: null, serverTime: now };
  }
  if (last != null && age != null && age <= PRESENCE_FRESH_MS) {
    return { ok: true, code: 'UNKNOWN', nodeid: id, name: '', online: false, fresh: false, lastAgentPong: last, lastAgentPongAgeMs: age, agentConnectedAt: null, serverTime: now };
  }
  return { ok: true, code: 'NOT_FOUND', nodeid: id, name: '', online: false, fresh: false, lastAgentPong: last, lastAgentPongAgeMs: age, agentConnectedAt: null, serverTime: now };
}
function mcFetchNodesUncached(cookieHeader, clientIpHint) {
  return new Promise(async (resolve) => {
    const jar = {};
    String(cookieHeader || '').split(';').forEach((part) => { const i = part.indexOf('='); if (i > 0) jar[part.slice(0, i).trim()] = part.slice(i + 1).trim(); });
    if (!jar.xid) return resolve(null);
    const parts = ['xid=' + jar.xid]; if (jar['xid.sig']) parts.push('xid.sig=' + jar['xid.sig']);
    let sess = null;
    try { sess = await mcConnectCookie(parts.join('; '), 8000, [clientIpHint]); }
    catch (e) { return resolve(null); }
    const rid = 'qfhome' + Date.now();
    let done = false;
    const timer = setTimeout(() => finish(null), 8000);
    function finish(v) { if (done) return; done = true; clearTimeout(timer); try { sess.ws.close(); } catch (e) {} resolve(v); }
    sess.ws.on('message', (data) => {
      let m; try { m = JSON.parse(data.toString()); } catch (e) { return; }
      if (m && m.action === 'nodes' && m.responseid === rid) finish(m.nodes || {});
    });
    sess.ws.on('error', () => finish(null));
    sess.ws.on('close', () => finish(null));
    try { sess.ws.send(JSON.stringify({ action: 'nodes', responseid: rid })); } catch (e) { finish(null); }
  });
}
// X-05：nodes 取数 5 秒共享缓存＋单飞（键＝sha256(xid+'.'+xid.sig)，与验真
// 缓存同构造，不存明文）。设备在线态是秒级事件，5 秒陈旧可接受；写路径与
// presence 预检共用同一缓存，不得各搞一套。只缓存成功回包，失败（null）
// 不缓存，下次调用重新取数。
const NODES_CACHE_TTL_MS = 5000;
const NODES_CACHE_MAX = 200;
const nodesCache = new Map(); // key -> {at, nodes, promise}
function nodesCacheKey(cookieHeader) {
  const jar = {};
  String(cookieHeader || '').split(';').forEach((part) => { const i = part.indexOf('='); if (i > 0) jar[part.slice(0, i).trim()] = part.slice(i + 1).trim(); });
  return crypto.createHash('sha256').update(String(jar.xid || '') + '.' + String(jar['xid.sig'] || '')).digest('hex');
}
function mcFetchNodes(cookieHeader, clientIpHint, observerUser) {
  const key = nodesCacheKey(cookieHeader);
  const now = Date.now();
  const hit = nodesCache.get(key);
  if (hit && hit.nodes && now - hit.at < NODES_CACHE_TTL_MS) return Promise.resolve(hit.nodes);
  if (hit && hit.promise) return hit.promise;
  const p = mcFetchNodesUncached(cookieHeader, clientIpHint).then((nodes) => {
    if (nodes) {
      if (nodesCache.size >= NODES_CACHE_MAX) { const oldest = nodesCache.keys().next(); if (!oldest.done) nodesCache.delete(oldest.value); }
      nodesCache.set(key, { at: Date.now(), nodes, promise: null });
      if (observerUser) observeNodesForPresence(nodes, observerUser, Date.now());
    } else {
      nodesCache.delete(key);
    }
    return nodes;
  });
  nodesCache.set(key, { at: now, nodes: null, promise: p });
  return p;
}
// presence 预检的总预算：mcFetchNodes 内部是 8 秒鉴权＋8 秒 nodes 两段，
// 预检必须在 8 秒内给答案（B-2 硬指标），超时即回 TIMEOUT 码，不干等 16 秒。
// 注意：超时的那条底层 WS 仍会在后台跑完并关闭，不泄漏连接。
function mcFetchNodesBudgeted(cookieHeader, clientIpHint, observerUser, budgetMs) {
  return Promise.race([
    mcFetchNodes(cookieHeader, clientIpHint, observerUser),
    new Promise((resolve) => setTimeout(() => resolve(null), budgetMs || 8000)),
  ]);
}
const MC_FILES_DIR = process.env.QFEXT_MC_FILES_DIR || '/opt/meshcentral/meshcentral-files';
function userStorageBytes(username) {
  // MeshCentral 个人文件按 user/<域>/<账号> 目录存放；目录不存在＝无文件
  // 数据可统计，返回 null 让前端显示诚实空状态，绝不编造容量数字。
  try {
    const cands = [path.join(MC_FILES_DIR, 'user', '', username), path.join(MC_FILES_DIR, username)];
    for (const dir of cands) {
      if (!fs.existsSync(dir)) continue;
      let total = 0;
      const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const fp = path.join(d, e.name); if (e.isDirectory()) walk(fp); else { try { total += fs.statSync(fp).size; } catch (err) {} } } };
      walk(dir);
      return total;
    }
  } catch (e) {}
  return null;
}
async function buildHomeStats(req, auth) {
  const now = Date.now();
  const docs = (() => { try { return loadDb(); } catch (e) { return new Map(); } })();
  const userDoc = findDbUser(docs, auth.user);
  const meshNames = {};
  for (const d of docs.values()) if (d && d.type === 'mesh') meshNames[d._id] = d.name || '';
  const nodesByMesh = await mcFetchNodes(req.headers.cookie, clientIpFromReq(req), auth.user);
  let devices = null, groups = null, onlineCount = null;
  if (nodesByMesh) {
    devices = []; groups = []; let online = 0;
    for (const meshid of Object.keys(nodesByMesh)) {
      const gname = meshNames[meshid] || '';
      if (gname && !groups.includes(gname)) groups.push(gname);
      for (const n of (nodesByMesh[meshid] || [])) {
        const on = ((n.conn || 0) & 1) !== 0;
        if (on) online += 1;
        // W-10：online 位之外同时带新鲜度——lastAgentPong（服务端最后一次亲眼
        // 见到它在线）与 stale（conn 位仍为 1 但已超 120 秒未见在线；第一步里
        // 在线节点每次观测都会刷新，故 stale 在此恒为 false，字段先留给第二步
        // 持久观测用，前端据此不让点进 stale 设备）。
        const nid = normalizeNodeId(n._id);
        const obs = presenceObsFor(auth.user, nid);
        const stale = on && obs.lastAgentPongAgeMs != null && obs.lastAgentPongAgeMs > PRESENCE_FRESH_MS;
        // 只回名称/系统/分组/在线：不回 host/ip 等地址字段（公开面红线）
        devices.push({ name: n.name || n.rname || '', os: n.osdesc || '', group: gname, online: on, stale: !!stale, lastAgentPong: obs.lastAgentPong, lastAgentPongAgeMs: obs.lastAgentPongAgeMs, agentConnectedAt: (typeof n.agct === 'number' && n.agct > 0) ? n.agct : null });
      }
    }
    onlineCount = online;
  }
  // 最近登录：账号库 user 文档 login 字段（秒级，MeshCentral 登录时回写）
  const lastLoginMs = userDoc && userDoc.login ? Number(userDoc.login) * (Number(userDoc.login) < 1e12 ? 1000 : 1) : null;
  return {
    ok: true, user: auth.user,
    displayName: (userDoc && (userDoc.realname || userDoc.name)) || auth.user,
    isAdmin: isAdmin(auth),
    devices, groups, onlineCount,
    deviceCount: devices ? devices.length : null,
    storageBytes: userStorageBytes(auth.user),
    lastLoginMs,
  };
}

// ---------- 设备解析（网页 SPA 点设备进会话的服务端兜底，根除 name→nodeid 竞态） ----------
// 只读解析：按设备名精确查 nodeid。nodeid 在 MeshCentral 里有 node//、node/
// 两种带前缀写法与裸 id 写法，对外一律归一为裸 id，免得调用方再猜格式。
function normalizeNodeId(raw) {
  return String(raw || '').replace(/^node\/\//, '').replace(/^node\//, '');
}
// 分组 nodes（{ meshid: [node, ...] }）摊平成一维列表；同一 nodeid 只留一条，
// 防同一设备在多分组重复出现时被误判成同名多台。
function flattenMeshNodes(nodesByMesh) {
  const out = [];
  const seen = new Set();
  if (!nodesByMesh || typeof nodesByMesh !== 'object') return out;
  for (const meshid of Object.keys(nodesByMesh)) {
    for (const n of (nodesByMesh[meshid] || [])) {
      if (!n) continue;
      const nodeid = normalizeNodeId(n._id);
      if (!nodeid || seen.has(nodeid)) continue;
      seen.add(nodeid);
      out.push({ nodeid, name: n.name || n.rname || '', rname: n.rname || '', online: ((n.conn || 0) & 1) !== 0,
        // agct（上游 1.1.36 起节点自带字段，毫秒 epoch）：agent 本次连接建立时间，
        // 不是心跳时间——健康常连设备的 agct 也会很旧，故只作诊断参考，绝不用于
        // fresh/stale 判定；live 取证（/tmp 下的一次性脚本，见回报）须先确认
        // `nodes` 回包里是否带该字段。
        agentConnectedAt: (typeof n.agct === 'number' && n.agct > 0) ? n.agct : null });
    }
  }
  return out;
}
// 纯判定（无 IO，供路由与本地自测共用）：nodesByMesh 为 null＝取数失败/超时。
// 同名多台绝不默默选一个，一律回 AMBIGUOUS 带候选清单让调用方处理。
function resolveDeviceByName(nodesByMesh, queryName) {
  if (!nodesByMesh) return { ok: false, code: 'TIMEOUT', msg: '设备列表暂时取不到，请稍后再试。' };
  const q = String(queryName || '');
  const hits = flattenMeshNodes(nodesByMesh).filter((d) => d.name === q || (d.rname && d.rname === q));
  if (!hits.length) return { ok: false, code: 'NOT_FOUND', msg: '没有找到这个名称的设备。' };
  if (hits.length > 1) {
    return { ok: false, code: 'AMBIGUOUS', msg: '找到多个同名设备，无法确定要连接哪一台。', candidates: hits.map((d) => ({ nodeid: d.nodeid, name: d.name, online: d.online })) };
  }
  const one = hits[0];
  if (!one.online) return { ok: false, code: 'OFFLINE', nodeid: one.nodeid, name: one.name, msg: '这台设备当前不在线。' };
  return { ok: true, nodeid: one.nodeid, name: one.name, online: true };
}

// M-031: deployment must route its SPA upstream to this renderer, with the
// webapp template/module directory installed alongside its versioned assets.
const webappDir = process.env.QFR_WEBAPP_DIR || (fs.existsSync('/opt/qfremote-webapp/boot-data.mjs')
  ? '/opt/qfremote-webapp' : path.resolve(__dirname, '../webapp'));
const handleWebappIndex = createProductionBootHandler({ webappDir, resolveAuth, buildHomeStats, license: lic, log });

// ---------- 路由 ----------
const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://localhost');
    const p = u.pathname;

    if ((p === '/' || p === '/index.html') && await handleWebappIndex(req, res)) return;

    if (req.method === 'GET' && p === '/health') return sendJson(res, 200, { ok: true });

    // ===== 站长 API · 事件内网推送（各服务把新待审事项推进统一事件队列，#22/#31） =====
    if (p.startsWith('/internal/events/')) {
      if (!isInternal(req)) return sendJson(res, 403, { ok: false, code: 'INTERNAL_AUTH' });
      const body = await readJsonBody(req);
      if (req.method === 'POST' && p === '/internal/events/push') {
        const ev = reviewEvents.enqueue(String(body.type || ''), String(body.refId || ''), (body.summary && typeof body.summary === 'object') ? body.summary : {});
        if (!ev) return sendJson(res, 400, { ok: false, code: 'VALIDATION' });
        return sendJson(res, 200, { ok: true, eventId: ev.id });
      }
      if (req.method === 'POST' && p === '/internal/events/resolve') {
        // EV-1 附带收口：内网销账通道合法用途仅 forum 自家裁定回写，非 forum
        // 类型（含 body 非对象/缺 type）一律拒绝。
        if (!body || typeof body !== 'object' || String(body.type || '') !== 'forum') return sendJson(res, 409, { ok: false, code: 'INTERNAL_RESOLVE_TYPE' });
        const ev = reviewEvents.resolve(String(body.type || ''), String(body.refId || ''), String(body.actor || ''), String(body.result || ''));
        return sendJson(res, 200, { ok: true, found: !!ev });
      }
      return sendJson(res, 404, { ok: false, code: 'NOT_FOUND' });
    }

    // ===== 站长 API · 助手接口（令牌鉴权，#22/#31） =====
    // 只读游标接口供助手侧秒级轮询：本服务无全局 IP 限流，nginx 亦不
    // 对 /assistant-api/ 挂 limit_req，不会被高频轮询误伤（定版口径）。
    if (p.startsWith('/assistant-api/')) {
      // DS-R26-① 双头优先级（登记销项）：x-assistant-token 头优先，Bearer 仅在头缺失时参与；刻意 fail-closed——错头不穿透 Bearer，避免双凭据混叠。
      const tok = String(req.headers['x-assistant-token'] || (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || '');
      const tokenRole = reviewEvents.verifyTokenRole(tok);
      if (!tokenRole) return sendJson(res, 401, { ok: false, code: 'TOKEN_INVALID', msg: '助手令牌无效或已吊销。' });
      const nowA = Date.now();
      if (req.method === 'GET' && p === '/assistant-api/events') {
        const evStatus = u.searchParams.get('status') || '';
        const out = reviewEvents.list(u.searchParams.get('after') || 0, { type: u.searchParams.get('type') || '', status: evStatus, limit: u.searchParams.get('limit') || 50 });
        // 挂点甲（B 设计 4.2/B5）：拉取即校验，本页 pending forum 内容已删则销账；nextCursor 沿用 list 原值不跳号
        await autoSweepForumEvents(out.events);
        if (evStatus === 'pending' && Array.isArray(out.events)) out.events = out.events.filter((e) => e && e.status === 'pending');
        return sendJson(res, 200, Object.assign({ ok: true }, out));
      }
      const evDetailM = p.match(/^\/assistant-api\/events\/(\d+)$/);
      if (req.method === 'GET' && evDetailM) {
        let ev = reviewEvents.getById(Number(evDetailM[1]));
        if (!ev) return sendJson(res, 404, { ok: false, code: 'NOT_FOUND' });
        // 挂点乙（B 设计 4.2）：详情拉取即校验，销账则以更新后的事件返回
        if (ev.status === 'pending' && ev.type === 'forum') {
          const closed = await autoCloseForumEvent(ev);
          if (closed) ev = reviewEvents.getById(ev.id) || closed;
        }
        const detail = { ok: true, event: ev };
        if (ev.type === 'order') {
          const o = payOrders.getRaw(ev.refId);
          if (o) { detail.order = payOrders.view(o, nowA); detail.order.username = o.username; detail.reviewHints = payOrders.reviewHints(o); detail.screenshotUrl = '/assistant-api/orders/' + o.id + '/screenshot'; }
        } else if (ev.type === 'appeal' || ev.type === 'rebind') {
          try { const v = JSON.parse(fs.readFileSync(APPEALS_FILE, 'utf8')); const a = (v.appeals || []).find((x) => x.id === ev.refId); if (a) detail.appeal = { id: a.id, type: a.type || 'ban', username: a.username || a.key, reasonCode: a.reasonCode, desc: a.desc, status: a.status, platform: a.platform || null, createdAt: a.createdAt, images: Array.isArray(a.images) ? a.images.length : 0 }; } catch (e) {}
        } else if (ev.type === 'device_review') {
          const r = (lic.state().deviceReviews || []).find((x) => x.id === ev.refId);
          if (r) detail.review = { id: r.id, accounts: r.accounts, platform: r.platform, status: r.status, createdAt: r.createdAt, evidence: r.evidence };
        } else if (ev.type === 'profile_mod') {
          if (profileCore) detail.profileMod = profileCore.getRecordView(ev.refId);
        }
        return sendJson(res, 200, detail);
      }
      if (req.method === 'GET' && p === '/assistant-api/orders/pending') {
        // #21 一审即时触达：按提交序号游标增量拉取待一审单（提交→可见 ≤10 秒目标）
        const out = payOrders.pendingReview(u.searchParams.get('after') || 0, u.searchParams.get('limit') || 50);
        return sendJson(res, 200, Object.assign({ ok: true }, out));
      }
      const shotM = p.match(/^\/assistant-api\/orders\/([^/]+)\/screenshot$/);
      if (req.method === 'GET' && shotM) {
        const o = payOrders.getRaw(decodeURIComponent(shotM[1]));
        const fp = o ? payOrders.shotPath(o) : null;
        if (!o || !fp || !fs.existsSync(fp)) return sendJson(res, 404, { ok: false, code: 'NOT_FOUND' });
        const buf = fs.readFileSync(fp);
        res.writeHead(200, { 'Content-Type': o.shotType || 'image/jpeg', 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
        return res.end(buf);
      }
      // 资料申诉快照：助手核验被驳回的昵称/头像原文（头像按审核时快照 MIME 回）
      const pmShotM = p.match(/^\/assistant-api\/profile-mod\/([^/]+)\/snapshot$/);
      if (req.method === 'GET' && pmShotM) {
        const snapId = decSeg(pmShotM[1]);
        const snap = (profileCore && snapId !== null) ? profileCore.getSnapshot(snapId) : null;
        if (!snap) return sendJson(res, 404, { ok: false, code: 'NOT_FOUND' });
        res.writeHead(200, { 'Content-Type': snap.mime, 'Content-Length': snap.bytes.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        return res.end(snap.bytes);
      }
      if (req.method === 'POST' && p === '/assistant-api/decide') {
        // 裁定回写：全部复用既有双通道裁定入口，执行者按令牌角色留痕（助手接口／站长接口），不另起平行逻辑
        const body = await readJsonBody(req);
        const type = String(body.type || ''); const refId = String(body.refId || '');
        const action = String(body.action || '');
        const ACTOR = tokenRole === 'owner' ? '站长接口' : '助手接口';
        if (type === 'profile_mod') {
          // 资料申诉：裁定即补生效并销账（decideAppeal 内部完成），本层不重复 resolve；
          // 执行者留痕沿当刻令牌角色口径（助手接口／站长接口）。
          if (!profileCore) return sendJson(res, 500, { ok: false, msg: '个人资料功能模块未加载。' });
          if (action !== 'approve' && action !== 'reject') return sendJson(res, 400, { ok: false, code: 'VALIDATION' });
          const outPm = profileCore.decideAppeal(refId, action, String(body.reason || ''), ACTOR, nowA);
          log({ ev: 'assistant-decide', type, refId, action, ok: outPm.status === 200 });
          return sendJson(res, outPm.status, outPm.json);
        }
        if (type === 'order') {
          const o = payOrders.getRaw(refId);
          if (!o) return sendJson(res, 404, { ok: false, code: 'NOT_FOUND' });
          if (o.stage !== 1 && tokenRole !== 'owner') return sendJson(res, 409, { ok: false, code: 'OWNER_STAGE', msg: '该订单已过一审，二审（到账核对）由站长处理。' });
          if (action !== 'approve' && action !== 'reject' && action !== 'fake') return sendJson(res, 400, { ok: false, code: 'VALIDATION' });
          // #37：助手一审可判假（action=fake）——orders-core 一审判假分支直接
          // 驳回关单、不封号不到二审，并累计当日判假计数/入口冻结。
          // 阶段守卫（与站长后台同款）：调用方声明 stage 时强制核对，不符
          // 即 409 零变更；未声明时沿旧口径（助手外部调用兼容）。
          const wantStageA = Number(body.stage);
          const hooksA = (wantStageA === 1 || wantStageA === 2) ? { expectStage: wantStageA } : {};
          const out = payOrders.decide(refId, action, ACTOR, nowA, hooksA);
          if (out.ok) {
            if (out.stage === 1) reviewEvents.resolve('order', refId, ACTOR, 'review1-' + action);
            // owner 通道 stage2 判假：核心已封禁＋回收钥，补 MC 锁定位联动（与后台口径齐；stage1 判假不补，守 #37）
            // DS 门二 P1-01：联动加异常边界——核心裁定已落账，联动失败只记日志待补锁，绝不让 decide 响应 500/悬挂。
            if (tokenRole === 'owner' && out.fake && out.stage === 2) {
              try { await licLockAccount(o.username); }
              catch (e) { log({ ev: 'owner-stage2-fake-locklink-failed', refId, user: o.username, err: String(e && e.message || e) }); }
            }
          }
          log({ ev: tokenRole === 'owner' ? 'owner-decide' : 'assistant-decide', type, refId, action, actor: ACTOR, role: tokenRole, ok: !!out.ok });
          return sendJson(res, out.ok ? 200 : 409, out);
        }
        if (type === 'appeal' || type === 'rebind') {
          if (action !== 'approve' && action !== 'reject') return sendJson(res, 400, { ok: false, code: 'VALIDATION' });
          // B1 冻结申诉走既有 appeal-admin 改密闭环（与站长后台同一路径），其余走统一台账裁决
          let ap = null;
          try { const v = JSON.parse(fs.readFileSync(APPEALS_FILE, 'utf8')); ap = (v.appeals || []).find((x) => x.id === refId) || null; } catch (e) {}
          if (ap && !ap.banId && !ap.reasonCode && ap.type !== 'rebind') {
            if (ap.status !== 'pending') return sendJson(res, 409, { ok: false, code: 'ALREADY_DECIDED', msg: '该申诉已处理。' });
            const uname = String(ap.username || ap.key || '');
            let args;
            if (action === 'approve') args = [APPEAL_ADMIN, 'approve', uname];
            else {
              const reason = String(body.reason || '').trim();
              if (!reason) return sendJson(res, 400, { ok: false, code: 'VALIDATION', msg: '驳回须写明原因。' });
              args = [APPEAL_ADMIN, 'reject', uname, reason.slice(0, 500)];
            }
            const r = await runCmd('node', args, 30000);
            const okB1 = r.code === 0;
            if (okB1) reviewEvents.resolve('appeal', refId, ACTOR, 'b1-' + action);
            log({ ev: tokenRole === 'owner' ? 'owner-decide' : 'assistant-decide', type, refId, action, actor: ACTOR, role: tokenRole, ok: okB1, via: 'appeal-admin' });
            return sendJson(res, okB1 ? 200 : 409, { ok: okB1, msg: okB1 ? '申诉结论已生效（B1 改密闭环）。' : (lastLine(r.stderr) || '处理未成功。') });
          }
          const out = await decideAppeal(refId, action, String(body.reason || ''), ACTOR, body);
          log({ ev: tokenRole === 'owner' ? 'owner-decide' : 'assistant-decide', type, refId, action, actor: ACTOR, role: tokenRole, ok: !!out.ok });
          return sendJson(res, out.ok ? 200 : 409, out); // 事件销账在 decideAppeal 内完成
        }
        if (type === 'device_review') {
          const dec = action === 'release' ? 'dismissed' : (action === 'violation' ? 'violation' : (action === 'escalate' ? 'escalate' : ''));
          if (!dec) return sendJson(res, 400, { ok: false, code: 'VALIDATION', msg: 'action 须为 release / violation / escalate。' });
          const out = lic.decideDeviceReview(refId, dec, ACTOR, nowA);
          if (out.ok && out.violation) { for (const t of out.accounts || []) await licLockAccount(t); }
          if (out.ok && dec !== 'escalate') reviewEvents.resolve('device_review', refId, ACTOR, dec);
          log({ ev: tokenRole === 'owner' ? 'owner-decide' : 'assistant-decide', type, refId, action, actor: ACTOR, role: tokenRole, ok: !!out.ok });
          return sendJson(res, out.ok ? 200 : 409, out);
        }
        if (type === 'forum') {
          // kind 缺省时从 refId 前缀推导（事件 refId 形如 post:p12 / reply:r34，自带类型）：
          // 否则回复类裁定会被论坛内网口默认按 post 查库、误报「内容不存在」（P8 巡查 F-003）。
          const kindFromRef = refId.startsWith('reply:') ? 'reply' : (refId.startsWith('post:') ? 'post' : '');
          const kindUsed = String(body.kind || '') || kindFromRef;
          const out = await postInternalJson(FORUM_INTERNAL_BASE + '/api/forum/internal/review', { kind: kindUsed, id: refId, action, actor: ACTOR }, 8000);
          if (out && out.ok) reviewEvents.resolve('forum', refId, ACTOR, action);
          // 挂点丙（B 设计 4.2/B1/B6）：论坛权威查实「内容不存在。」（无传输 code）且 kind 双绑一致 → 自动销账。
          // 内容已由 review 服务端查库确认，此处直接 resolve，不再补探 exists；resolve 返回 null 说明已被他人销账/非 pending，落回原路径。
          let autoClosed = false;
          if (out && out.ok === false && !out.code && out.msg === '内容不存在。' && kindUsed === kindFromRef && /^(post|reply):/.test(String(refId || ''))) {
            const rec = reviewEvents.resolve('forum', refId, '系统（自动销账）', '内容已删除，自动销账');
            if (rec) {
              autoClosed = true;
              log({ ev: 'assistant-event-auto-closed', reason: 'content-gone', refId, eventId: rec.id });
            }
          }
          log({ ev: tokenRole === 'owner' ? 'owner-decide' : 'assistant-decide', type, refId, action, actor: ACTOR, role: tokenRole, ok: !!(out && out.ok), autoClosed });
          if (autoClosed) return sendJson(res, 200, { ok: true, autoClosed: true, code: 'CONTENT_GONE', msg: '内容已删除，事件已自动销账。' });
          return sendJson(res, out && out.ok ? 200 : 409, out || { ok: false });
        }
        if (type === 'support') {
          const out = await postInternalJson(SOCIAL_INTERNAL_BASE + '/internal/support/decide', { ticketId: refId, action, text: String(body.text || ''), actor: ACTOR }, 8000);
          if (out && out.ok && action === 'close') reviewEvents.resolve('support', refId, ACTOR, 'closed');
          else if (out && out.ok) reviewEvents.resolve('support', refId, ACTOR, 'replied'); // 回复即视为已处理一轮；工单未关可由新消息再入队
          log({ ev: tokenRole === 'owner' ? 'owner-decide' : 'assistant-decide', type, refId, action, actor: ACTOR, role: tokenRole, ok: !!(out && out.ok) });
          return sendJson(res, out && out.ok ? 200 : 409, out || { ok: false });
        }
        return sendJson(res, 400, { ok: false, code: 'VALIDATION', msg: 'type 不正确。' });
      }
      return sendJson(res, 404, { ok: false, code: 'NOT_FOUND' });
    }

    // ===== 许可内网接口（仅回环 + 密钥文件鉴权；loginshim/register/代审调用） =====
    if (p.startsWith('/internal/license/')) {
      if (!isInternal(req)) return sendJson(res, 403, { ok: false, code: 'INTERNAL_AUTH' });
      const body = await readJsonBody(req);
      const now = Date.now();
      const cfg = lic.readConfig();
      if (req.method === 'POST' && p === '/internal/license/login-check') {
        const username = String(body.username || '').trim().toLowerCase();
        if (!username) return sendJson(res, 400, { ok: false, code: 'VALIDATION' });
        const d = lic.evaluate(username, now, { channel: body.channel === 'web' ? 'web' : (body.channel === 'qfclash' ? 'qfclash' : 'software'), deviceCode: body.deviceCode || null, platform: body.platform || null });
        d.enforce = licEnforce(cfg, username);
        if (!d.allow && cfg.shadow && !d.enforce) lic.shadowLog({ ev: 'gate-would-block', username, code: d.code, channel: body.channel || 'software' });
        if (!d.allow) lic.save();
        return sendJson(res, 200, Object.assign({ ok: true }, d));
      }
      if (req.method === 'POST' && p === '/internal/license/qfclash-login-note') {
        const username = String(body.username || '').trim().toLowerCase();
        if (!username) return sendJson(res, 400, { ok: false, code: 'VALIDATION' });
        noteQfclashLogin(username, body.ua || '', body.xidHash || null);
        log({ ev: 'qfclash-login-note', target: username });
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === 'POST' && p === '/internal/license/ban-event') {
        const username = String(body.username || '').trim().toLowerCase();
        if (!username) return sendJson(res, 400, { ok: false, code: 'VALIDATION' });
        if (body.action === 'apply') {
          const code = String(body.code || 'B1').toUpperCase(); // DEV-18/G-10
          const exist = lic.activeBansFor(username, now).find((b) => String(b.code || '').toUpperCase() === code); // DEV-21：与 lift 口径统一归一
          if (!exist) {
            const endsAt = startOfNextDayMs(now);
            lic.applyBan({ targetType: 'account', target: username, code, permanent: false, endsAt, actor: String(body.actor || 'loginshim') }, now);
          }
          // 幂等：即使台账已有该 code（上次 enforcement 可能失败），也补跑一次
          if (BAN_LINK_CODES.includes(code)) {
            try { await executeBanEnforcement(username, 'ban-event:' + code); }
            catch (e) { log({ ev: 'ban-enforce-error', target: username, source: 'ban-event', err: String(e && e.message) }); }
          }
          return sendJson(res, 200, { ok: true });
        }
        if (body.action === 'lift') {
          // DEV-18/G-06：原实现不校验 code、过滤集为空也回 ok:true（静默未解封）。
          if (!body.code) return sendJson(res, 400, { ok: false, code: 'VALIDATION' });
          const code = String(body.code).toUpperCase();
          const r = await withUserLock(username, async () => {
            const matched = lic.activeBansFor(username, now).filter((b) => String(b.code || '').toUpperCase() === code);
            for (const b of matched) lic.liftBan(b, now, { by: String(body.actor || 'loginshim') });
            let mcUnlock = null;
            // DEV-18/G-01(F-01，DS 门二 Q2)：本条 lift 后活动封禁全空（B8/B1 同台账，全集为空即无其它置位来源）
            // 才清 MC bit；只走 live 通道，失败不回落 mcdb（自动路径回落＝停服），如实降级回报＋告警留痕。
            if (matched.length && lic.activeBansFor(username, now).length === 0) {
              try {
                const lr = await liveSetLockBit(username, false);
                if (lr && lr.ok) mcUnlock = { ok: true };
                else if (lr && lr.detail === 'guarded') mcUnlock = { ok: true, skipped: 'guarded' };
                else { mcUnlock = { ok: false, detail: (lr && lr.detail) || 'unknown' }; log({ ev: 'lock-clear-failed', target: username, source: 'ban-event-lift', detail: mcUnlock }); }
              } catch (e) { mcUnlock = { ok: false, detail: String(e && e.message) }; log({ ev: 'lock-clear-failed', target: username, source: 'ban-event-lift', detail: mcUnlock }); }
              // 下游 banLink 缓存失效（只清缓存、不动会话）：把 R9 的 5 秒窗口降为仅 purge 失败时
              postInternalJsonSafe(SOCIAL_INTERNAL_BASE, '/internal/ban-cache-flush', { username }, 'friends-flush'); // DEV-21：原实参错位（完整路径塞进 base），flush 从未通（DS 差量 #2）
              postInternalJsonSafe(FORUM_INTERNAL_BASE, '/api/forum/internal/ban-cache-flush', { username }, 'forum-flush'); // DEV-21：同上，且 forum 路径带 /api/forum 前缀（与 purge 同式）
            }
            return { matched: matched.length, mcUnlock };
          });
          return sendJson(res, 200, { ok: true, lifted: r.matched, noop: r.matched === 0, mcUnlockOk: r.mcUnlock ? r.mcUnlock.ok : null });
        }
        return sendJson(res, 400, { ok: false, code: 'VALIDATION' });
      }
      if (req.method === 'POST' && p === '/internal/license/account-link') {
        const username = String(body.username || '').trim().toLowerCase();
        if (!username) return sendJson(res, 400, { ok: false, code: 'VALIDATION' });
        const bans = lic.activeBansFor(username, now);
        const hasPerm = bans.some((b) => b.permanent);
        const hasHard = bans.some((b) => BAN_LINK_CODES.includes(String(b.code || '').toUpperCase())); // DEV-21
        const link = (hasPerm || hasHard) ? 'banned' : (bans.length ? 'frozen' : 'normal');
        const pick = bans.find((b) => b.permanent)
          || bans.find((b) => BAN_LINK_CODES.includes(String(b.code || '').toUpperCase())) || bans[0] || null; // DEV-21
        const activeBan = pick
          ? { code: String(pick.code || '').toUpperCase(), permanent: !!pick.permanent, endsAt: (typeof pick.endsAt === 'number' ? pick.endsAt : null) } // DEV-21：输出亦归一
          : null;
        return sendJson(res, 200, { ok: true, banLink: link === 'banned', link, activeBan });
      }
      if (req.method === 'POST' && p === '/internal/license/appeal-check') {
        const username = String(body.username || '').trim().toLowerCase();
        const bans = lic.activeBansFor(username, now);
        const b = bans.find((x) => x.permanent) || bans[0] || null;
        return sendJson(res, 200, { ok: true, hasActiveBan: !!b, ban: b ? { id: b.id, code: b.code, permanent: !!b.permanent, endsAt: b.endsAt } : null });
      }
      if (req.method === 'POST' && p === '/internal/license/device-review-decide') {
        const out = lic.decideDeviceReview(String(body.reviewId || ''), String(body.decision || ''), String(body.actor || 'assistant'), now);
        if (out.ok && out.violation) { for (const t of out.accounts || []) await licLockAccount(t); }
        if (out.ok && (out.dismissed || out.violation)) reviewEvents.resolve('device_review', String(body.reviewId || ''), String(body.actor || 'assistant'), String(body.decision || ''));
        return sendJson(res, out.ok ? 200 : 409, out);
      }
      if (req.method === 'GET' && p === '/internal/license/device-reviews') {
        const st = lic.state();
        const list = st.deviceReviews.slice(-50).map((r) => ({ id: r.id, accounts: r.accounts, platform: r.platform, status: r.status, escalated: !!r.escalated, createdAt: r.createdAt, deviceHashShort: String(r.deviceHash).slice(0, 12), decidedBy: r.decidedBy || null, decision: r.decision || null }));
        return sendJson(res, 200, { ok: true, reviews: list });
      }
      if (req.method === 'POST' && p === '/internal/license/appeal-decide') {
        const out = await decideAppeal(String(body.appealId || ''), String(body.decision || ''), String(body.reason || ''), String(body.actor || 'assistant'), body);
        return sendJson(res, out.ok ? 200 : 409, out);
      }
      if (req.method === 'POST' && p === '/internal/license/register-check') {
        return sendJson(res, 200, Object.assign({ ok: true }, lic.registerCheck(String(body.deviceHash || ''), String(body.ip || ''), now)));
      }
      if (req.method === 'POST' && p === '/internal/license/register-success') {
        const username = String(body.username || '').trim().toLowerCase();
        if (!username) return sendJson(res, 400, { ok: false, code: 'VALIDATION' });
        lic.registerSuccess(username, String(body.deviceHash || ''), String(body.ip || ''), now);
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === 'POST' && p === '/internal/license/issue') {
        // 内网发码（代审/协调工具与测试用；与站长后台同一口径：来源必选无默认）
        const username = String(body.username || '').trim().toLowerCase();
        const plan = String(body.plan || '');
        if (!LIC_PLANS[plan]) return sendJson(res, 400, { ok: false, code: 'VALIDATION', msg: '套餐不正确。' });
        if (body.source !== 'paid' && body.source !== 'free') return sendJson(res, 400, { ok: false, code: 'SOURCE_REQUIRED', msg: '必须选择密钥来源。' });
        const docs = loadDb();
        if (!findDbUser(docs, username)) return sendJson(res, 404, { ok: false, msg: '账号不存在。' });
        let orderId = null;
        if (body.source === 'paid') { const o = lic.createOrder(username, plan, now); o.status = 'paid'; o.channel = 'admin-paid-record'; o.paidAt = now; lic.save(); orderId = o.id; }
        if (body.source === 'paid') {
          const g = lic.grantPurchase(username, plan, body.source, now, { actor: 'internal', orderId });
          if (g.alreadyPermanent) return sendJson(res, 400, { ok: false, code: 'ALREADY_PERMANENT' });
          return sendJson(res, 200, { ok: true, keyId: g.key.id, maskedKey: licMaskKey(g.key.str), swapped: !!g.swapped, stacked: !!g.stacked });
        }
        const rec = lic.issueKey(username, plan, body.source, now, { actor: 'internal', orderId });
        return sendJson(res, 200, { ok: true, keyId: rec.id, maskedKey: licMaskKey(rec.str) });
      }
      if (req.method === 'POST' && p === '/internal/license/test-set-trial') {
        if (!lic.readConfig().testHooks) return sendJson(res, 404, { ok: false, code: 'NOT_FOUND' });
        const username = String(body.username || '').trim().toLowerCase();
        const st = lic.state();
        if (!st.accounts[username] || !st.accounts[username].trial) return sendJson(res, 400, { ok: false, msg: '无试用记录。' });
        st.accounts[username].trial.expiresMs = Number(body.expiresMs);
        lic.save();
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === 'POST' && p === '/internal/license/test-set-key-expiry') {
        if (!lic.readConfig().testHooks) return sendJson(res, 404, { ok: false, code: 'NOT_FOUND' });
        const st = lic.state();
        const k = st.keys[String(body.keyId || '')];
        if (!k) return sendJson(res, 400, { ok: false, msg: '密钥不存在。' });
        if (!Number.isFinite(Number(body.expiresBaseMs))) return sendJson(res, 400, { ok: false, code: 'VALIDATION', msg: 'expiresBaseMs 须为毫秒时间戳。' });
        k.expiresBaseMs = Number(body.expiresBaseMs); k.pausedAccumMs = 0; k.pauseStartMs = null; if (k.timing === 'paused') k.timing = 'active';
        lic.save();
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === 'POST' && p === '/internal/license/set-contact') {
        const username = String(body.username || '').trim().toLowerCase();
        if (!username || !body.email) return sendJson(res, 400, { ok: false, code: 'VALIDATION' });
        lic.setContact(username, String(body.email).trim().toLowerCase(), now);
        return sendJson(res, 200, { ok: true });
      }
      // 账号＋密码核验（内网版，裁决批③）：供 loginshim 申诉提交等站内
      // 服务核验身份，只回 ok 与否；失败口径与公开核验面一致（不存在的
      // 账号同样回 false，不透露账号是否存在）。
      if (req.method === 'POST' && p === '/internal/license/verify-password') {
        const username = String(body.username || '').trim().toLowerCase();
        const okPw = !!(username && await verifyAccountPassword(username, String(body.password || '')));
        lic.audit({ ev: 'verify-password-internal', username, ok: okPw });
        return sendJson(res, 200, { ok: okPw });
      }
      if (req.method === 'GET' && p === '/internal/license/overview') {
        const st = lic.state();
        const masked = Object.values(st.keys).map((k) => ({ id: k.id, username: k.username, plan: k.plan, source: k.source, masked: licMaskKey(k.str), lifecycle: k.lifecycle, link: k.link, timing: k.timing, everBanned: !!k.everBanned, createdAt: k.createdAt }));
        return sendJson(res, 200, { ok: true, mirrorPublish: lic.mirrorStats(), config: cfg, keys: masked, bans: st.bans.slice(-30), orders: Object.values(st.orders).slice(-30), shadowEvents: st.shadowEvents.slice(-30), accounts: st.accounts });
      }
      return sendJson(res, 404, { ok: false, code: 'NOT_FOUND' });
    }

    // ===== 许可公开页 =====
    // ===== 全站统一档案（昵称＋头像，2.3.2；正本在本服务，forum/social 只读消费） =====
    if (p === '/profile' || p.startsWith('/profile/') || p.startsWith('/internal/profile/')) {
      if (!profileCore) return sendJson(res, 500, { ok: false, msg: '个人资料功能模块未加载。' });
      if (p.startsWith('/internal/profile/')) {
        if (!isInternal(req)) return sendJson(res, 403, { ok: false, code: 'INTERNAL_AUTH' });
        const oneM = p.match(/^\/internal\/profile\/([^/]+)$/);
        if (req.method === 'GET' && oneM && oneM[1] !== 'view') {
          const name = (decSeg(oneM[1]) || '').toLowerCase();
          if (!ACCOUNT_RE.test(name)) return sendJson(res, 400, { ok: false, code: 'VALIDATION' });
          return sendJson(res, 200, Object.assign({ ok: true }, profileCore.viewOf(name)));
        }
        if (req.method === 'GET' && p === '/internal/profile/view') {
          const names = String(u.searchParams.get('usernames') || '').split(',').map((s) => s.trim().toLowerCase()).filter((s) => ACCOUNT_RE.test(s)).slice(0, 50);
          const views = {}; for (const n of names) views[n] = profileCore.viewOf(n);
          return sendJson(res, 200, { ok: true, views });
        }
        // 头像字节内网出口（§5.2 补项，S4 审计路线 C）：供 social 侧同源代理给聊天页
        const avInM = p.match(/^\/internal\/profile\/([^/]+)\/avatar$/);
        if (req.method === 'GET' && avInM) {
          const name = (decSeg(avInM[1]) || '').toLowerCase();
          if (!ACCOUNT_RE.test(name)) return sendJson(res, 400, { ok: false, code: 'VALIDATION' });
          const got = profileCore.readAvatar(name, u.searchParams.get('v'));
          if (!got) return sendJson(res, 404, { ok: false, code: 'NOT_FOUND' });
          res.writeHead(200, { 'Content-Type': got.mime, 'Content-Length': got.bytes.length, 'Cache-Control': got.cacheControl, 'X-Content-Type-Options': 'nosniff' });
          return res.end(got.bytes);
        }
        return sendJson(res, 404, { ok: false, code: 'NOT_FOUND' });
      }
      // 头像字节（登录态；本人与他人同口径，版本化缓存照 A8 定版）
      const avM = p.match(/^\/profile\/([^/]+)\/avatar$/);
      if (req.method === 'GET' && (p === '/profile/avatar' || avM)) {
        const auth = await resolveAuth(req);
        if (!auth) return sendJson(res, 401, { ok: false, code: 'UNAUTHORIZED', msg: '登录已过期，请重新登录后再试。' });
        const name = p === '/profile/avatar' ? String(auth.user).toLowerCase() : (decSeg(avM[1]) || '').toLowerCase();
        // 核对 #9：公开段与 internal/论坛代理同口径补 ACCOUNT_RE（纵深一致，readAvatar 本有台账双门）
        if (avM && !ACCOUNT_RE.test(name)) return sendJson(res, 400, { ok: false, code: 'VALIDATION' });
        const got = profileCore.readAvatar(name, u.searchParams.get('v'));
        if (!got) return sendJson(res, 404, { ok: false, code: 'NOT_FOUND' });
        res.writeHead(200, { 'Content-Type': got.mime, 'Content-Length': got.bytes.length, 'Cache-Control': got.cacheControl, 'X-Content-Type-Options': 'nosniff' });
        return res.end(got.bytes);
      }
      const auth = await resolveAuth(req);
      if (!auth) return sendJson(res, 401, { ok: false, code: 'UNAUTHORIZED', msg: '登录已过期，请重新登录后再试。' });
      const me = String(auth.user).toLowerCase();
      if (req.method === 'GET' && p === '/profile/api/me') return sendJson(res, 200, Object.assign({ ok: true }, profileCore.viewOf(me)));
      if (req.method === 'GET' && p === '/profile/api/view') {
        const names = String(u.searchParams.get('usernames') || '').split(',').map((s) => s.trim().toLowerCase()).filter((s) => ACCOUNT_RE.test(s)).slice(0, 50);
        const views = {}; for (const n of names) views[n] = profileCore.viewOf(n);
        return sendJson(res, 200, { ok: true, views });
      }
      if (req.method === 'POST' && p === '/profile/mod/submit') {
        const body = await readJsonBody(req, 512 * 1024); // 头像 200KB 的 base64 约 273KB＋JSON 包装
        const out = await profileCore.submit(me, body, Date.now());
        return sendJson(res, out.status, out.json);
      }
      if (req.method === 'GET' && p === '/profile/mod/records') return sendJson(res, 200, { ok: true, records: profileCore.listRecords(me, Number(u.searchParams.get('limit')) || 50) });
      const apM = p.match(/^\/profile\/mod\/([^/]+)\/appeal$/);
      if (req.method === 'POST' && apM) {
        const body = await readJsonBody(req);
        const apId = decSeg(apM[1]);
        if (apId === null) return sendJson(res, 400, { ok: false, code: 'VALIDATION' });
        const out = profileCore.appeal(me, apId, body.note, Date.now());
        return sendJson(res, out.status, out.json);
      }
      return sendJson(res, 404, { ok: false, code: 'NOT_FOUND' });
    }

    if (req.method === 'GET' && p === '/purchase') {
      const auth = await resolveAuth(req);
      if (!auth) { res.writeHead(302, { Location: '/?return=/purchase', 'Cache-Control': 'no-store' }); return res.end(); }
      return sendHtml(res, 200, purchasePageHtml({ payEnabled: lic.readConfig().payEnabled, shotPayEnabled: payOrders.enabled() && licEnforce(lic.readConfig(), auth.user) }));
    }
    if (req.method === 'GET' && p === '/license/orders') {
      const auth = await resolveAuth(req);
      if (!auth) { res.writeHead(302, { Location: '/?return=/license/orders', 'Cache-Control': 'no-store' }); return res.end(); }
      if (!ordersPageHtml) return sendJson(res, 500, { ok: false, msg: '订单页模块未加载。' });
      return sendHtml(res, 200, ordersPageHtml());
    }
    // 品牌付款卡与示例图（#21 资产：pay-cards 终版 8 张＋示例图 v5，部署于 EXT_ASSETS_DIR）
    const cardM = p.match(/^\/license\/pay-cards\/(pay-(?:wechat|alipay)-(?:2|6|9\.9|18)\.png)$/);
    if (req.method === 'GET' && cardM) {
      const fp = path.join(EXT_ASSETS_DIR, 'pay-cards', cardM[1]);
      if (!fs.existsSync(fp)) return sendJson(res, 404, { ok: false, code: 'NOT_FOUND' });
      const buf = fs.readFileSync(fp);
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': buf.length, 'Cache-Control': 'public, max-age=86400' });
      return res.end(buf);
    }
    if (req.method === 'GET' && p === '/license/assets/pay-example.jpg') {
      const fp = path.join(EXT_ASSETS_DIR, 'pay-example.jpg');
      if (!fs.existsSync(fp)) return sendJson(res, 404, { ok: false, code: 'NOT_FOUND' });
      const buf = fs.readFileSync(fp);
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': buf.length, 'Cache-Control': 'public, max-age=86400' });
      return res.end(buf);
    }
    if (req.method === 'GET' && p === '/license/status') return sendHtml(res, 200, statusPageHtml());
    if (req.method === 'GET' && p === '/license/rebind') {
      if (!rebindPageHtml) return sendJson(res, 500, { ok: false, msg: '换绑申诉页模块未加载。' });
      return sendHtml(res, 200, rebindPageHtml({ deviceCode: u.searchParams.get('dc') || '', platform: u.searchParams.get('platform') || '', channel: u.searchParams.get('ch') || 'web' }));
    }
    if (req.method === 'POST' && p === '/license/rebind') {
      if (!rebindPageHtml) return sendJson(res, 503, { ok: false, code: 'UNAVAILABLE', msg: '换绑申诉页暂不可用。' });
      const form = await readRebindForm(req);
      if (form.status !== 200) return sendJson(res, form.status, { ok: false, code: form.code });
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Referrer-Policy', 'no-referrer');
      return sendHtml(res, 200, rebindPageHtml(form.value));
    }

    // ===== 许可公开接口（控制台会话鉴权） =====
    if (p.startsWith('/license/api/')) {
      const now = Date.now();
      // DS 稿 §1.8 路径白名单（状态读 + 申诉换绑提交为救济/状态面）
      const BAN_GATE_ALLOW = new Set(['/license/api/me', '/license/api/rebind/submit']);
      // 互联窗观察入口：本站会话身份此刻可同步取到就先记（同一请求只记
      // 一行，req._cvLogged 标记）；控制台会话身份在下方 resolveAuth
      // 解析后补记。无头请求不记、行为不变。
      if (req.headers['x-qf-client-version']) {
        const _sa = sessionAuth(req);
        if (_sa && _sa.user) { recordClientVersion(req, p, _sa.user); req._cvLogged = true; }
      }
      // 状态查询核验（裁决批③：全站统一账号＋密码，废止账号＋注册邮箱
      // 路径——本站注册不采邮箱、无邮箱验证码）。失败统一提示不透露账号
      // 是否存在，5 次失败锁核验 1 小时、审计留痕，口径与 reveal 一致。
      if (req.method === 'POST' && p === '/license/api/status/query') {
        const body = await readJsonBody(req);
        const username = String(body.username || '').trim().toLowerCase();
        const ip = clientIpFromReq(req);
        const lockKey = 'q:' + username + ':' + ip;
        if (licVerifyLocked(lockKey)) { lic.audit({ ev: 'status-query', username, ok: false, why: 'locked', ip }); return sendJson(res, 200, { ok: false, code: 'VERIFY_LOCKED', msg: '查询失败次数过多，请 1 小时后再试。' }); }
        const ok = !!(username && await verifyAccountPassword(username, String(body.password || '')));
        lic.audit({ ev: 'status-query', username, ok, ip });
        if (!ok) { licVerifyHit(lockKey, false); return sendJson(res, 200, { ok: false, code: 'VERIFY_FAILED', msg: '信息不一致，无法查询。' }); }
        licVerifyHit(lockKey, true);
        const view = lic.buildStatusView(username, now);
        let appeals = [];
        try { const v = JSON.parse(fs.readFileSync(APPEALS_FILE, 'utf8')); appeals = (v.appeals || []).filter((a) => a && String(a.key || a.username || '').toLowerCase() === username).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).map((a) => ({ id: a.id, status: a.status, statusText: ({ pending: '处理中', approved: '已通过', rejected: '已驳回', done: '已通过' })[a.status] || a.status, reasonCode: a.reasonCode || (a.banId ? '' : 'B1'), type: a.type || '', desc: a.desc || '', reason: a.reason || '', createdAt: a.createdAt })); } catch (e) {}
        // 购买记录进度（#21：查询密钥处可看审核进度）＋积分兑换记录（#23：密钥查询处可见）
        const payOrdersMine = payOrders.listUser(username, now).slice(0, 5).map((o) => ({ planName: o.planName, amount: o.amount, statusText: o.statusText, createdAt: o.createdAt }));
        let redemptions = [];
        try { const prec = pointsData.users[username]; if (prec && prec.earn && Array.isArray(prec.earn.ledger)) redemptions = prec.earn.ledger.filter((x) => x.kind === 'spend' && String(x.note || '').indexOf('福利兑换') === 0).slice(-10).reverse(); } catch (e) {}
        return sendJson(res, 200, { ok: true, view, appeals, payOrders: payOrdersMine, redemptions });
      }
      if (req.method === 'POST' && p === '/license/api/status/reveal') {
        const body = await readJsonBody(req);
        const username = String(body.username || '').trim().toLowerCase();
        const ip = clientIpFromReq(req);
        const lockKey = 'r:' + username + ':' + ip;
        if (licVerifyLocked(lockKey)) { lic.audit({ ev: 'status-reveal', username, ok: false, why: 'locked', ip }); return sendJson(res, 200, { ok: false, code: 'VERIFY_LOCKED', msg: '查看失败次数过多，请 1 小时后再试。' }); }
        const okPw = await verifyAccountPassword(username, String(body.password || ''));
        lic.audit({ ev: 'status-reveal', username, ok: okPw, ip });
        if (!okPw) { licVerifyHit(lockKey, false); return sendJson(res, 200, { ok: false, code: 'VERIFY_FAILED', msg: '密码不正确，无法查看。' }); }
        licVerifyHit(lockKey, true);
        const view = lic.buildStatusView(username, now);
        const st = lic.state();
        const rec = view.keyId ? st.keys[view.keyId] : null;
        if (!rec) return sendJson(res, 200, { ok: false, code: 'NOT_FOUND', msg: '该账号尚未购买密钥。' });
        return sendJson(res, 200, { ok: true, key: rec.str });
      }
      // 账号＋密码核验（裁决批③统一核验面）：只回 ok 与否，不回任何账号
      // 资料；供智能客服等站内服务在服务端调用（本人状态查询前核验），
      // 失败锁定与审计口径同 reveal（独立 'v:' 计数、5 次锁 1 小时）。
      if (req.method === 'POST' && p === '/license/api/verify-password') {
        const body = await readJsonBody(req);
        const username = String(body.username || '').trim().toLowerCase();
        const ip = clientIpFromReq(req);
        const lockKey = 'v:' + username + ':' + ip;
        if (licVerifyLocked(lockKey)) { lic.audit({ ev: 'verify-password', username, ok: false, why: 'locked', ip }); return sendJson(res, 200, { ok: false, code: 'VERIFY_LOCKED', msg: '核验失败次数过多，请 1 小时后再试。' }); }
        const okPw = !!(username && await verifyAccountPassword(username, String(body.password || '')));
        lic.audit({ ev: 'verify-password', username, ok: okPw, ip });
        if (!okPw) { licVerifyHit(lockKey, false); return sendJson(res, 200, { ok: false, code: 'VERIFY_FAILED', msg: '信息不一致，无法核验。' }); }
        licVerifyHit(lockKey, true);
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === 'POST' && p === '/license/api/pay/sim-callback') {
        const cfg2 = lic.readConfig();
        if (!cfg2.simPayEnabled) return sendJson(res, 404, { ok: false, code: 'SIM_DISABLED' });
        const body = await readJsonBody(req);
        let simSecret = '';
        try { simSecret = fs.readFileSync(path.join(LIC_DIR, 'sim.secret'), 'utf8').trim(); } catch (e) {}
        const expect = simSecret ? crypto.createHmac('sha256', simSecret).update(String(body.orderId || '') + ':' + String(body.amount || '')).digest('hex') : '';
        if (!expect || body.sign !== expect) return sendJson(res, 400, { ok: false, code: 'BADSIGN', msg: '验签失败。' });
        const out = lic.simPayCallback(String(body.orderId || ''), body.amount, now);
        return sendJson(res, out.ok ? 200 : 400, out);
      }
      // ===== 待领取转赠查看（17:23 定版，撤换 17:03 双通道点接受）：受赠人
      // 在状态查询侧凭账号＋密码核验（只核验、不签发登录态）查看待领取转赠
      // 并看到完整密钥串、复制；核验后仅开放「查看完整串」这一只读动作，
      // 不再有点接受/拒绝——领取只能凭串到拦截页/付费与激活区粘贴完成
      // （POST /license/api/transfer/claim）。旧 transfer-accept/reject
      // 端点保留路径回 ENDPOINT_REPLACED，防止旧页面误以为领取成功。
      if (req.method === 'POST' && p.startsWith('/license/api/status/transfer')) {
        const body = await readJsonBody(req);
        const username = String(body.username || '').trim().toLowerCase();
        const ip = clientIpFromReq(req);
        const lockKey = 't:' + username + ':' + ip;
        if (licVerifyLocked(lockKey)) { lic.audit({ ev: 'status-transfer-auth', username, ok: false, why: 'locked', ip }); return sendJson(res, 200, { ok: false, code: 'VERIFY_LOCKED', msg: '核验失败次数过多，请 1 小时后再试。' }); }
        const okPw = await verifyAccountPassword(username, String(body.password || ''));
        lic.audit({ ev: 'status-transfer-auth', username, ok: okPw, ip });
        if (!okPw) { licVerifyHit(lockKey, false); return sendJson(res, 200, { ok: false, code: 'VERIFY_FAILED', msg: '信息不一致，无法查询。' }); }
        licVerifyHit(lockKey, true);
        if (p === '/license/api/status/transfers') {
          // 核验通过后回完整串（密钥原文红线的既定例外：仅本人、本次响应、不落日志）
          const list = lic.listClaimableTransfers(username, now);
          return sendJson(res, 200, { ok: true, transfers: list });
        }
        if (p === '/license/api/status/transfer-accept' || p === '/license/api/status/transfer-reject') {
          return sendJson(res, 200, { ok: false, code: 'ENDPOINT_REPLACED', msg: '领取方式已变更：请复制完整密钥串，到登录拦截页或「付费与激活」区粘贴领取。' });
        }
        return sendJson(res, 404, { ok: false, code: 'NOT_FOUND' });
      }
      // ===== 密钥串领取（17:23 定版，同一校验端点，双入口共用） =====
      // 入口一（已登录）：控制台会话鉴权，claimant＝会话账号，体 {key}。
      // 入口二（拦截页 G1/G2/G5）：无会话，体 {username,password,key}，
      // 密码只核验不签发登录态（口径同状态查询核验，带失败锁定与审计）。
      // 两入口最终都走 lic.claimByKeyString 同一校验：串须命中「正待领取、
      // 收赠方＝当前账号、未过期未撤销」的转赠单。
      // ===== 封禁门（P5-010，DS 稿 §1.8）：密码核验类豁免端点
      //   /license/api/status/query、/status/reveal、/verify-password、
      //   /status/transfer*、/sim-callback
      // 在上方分派中已 return，天然在本门之前、豁免。本门覆盖其余全部
      // /license/api/ 处理器（本块内以下分派）。DEV-06：本链无共享已解析
      // 会话变量（各处理器各自 resolveAuth），门在此自带一次解析。
      if (!BAN_GATE_ALLOW.has(p)) {
        const _ga = await resolveAuth(req).catch(() => null);
        const gateUser = _ga && _ga.user;
        if (gateUser && isBanLinkedName(gateUser)) {
          return sendJson(res, 403, { ok: false, code: 'ACCOUNT_BANNED', msg: '账号已被封禁，仅可使用客服与申诉。' });
        }
      }
      if (req.method === 'POST' && p === '/license/api/transfer/claim') {
        const body = await readJsonBody(req);
        const keyStr = String(body.key || body.keyStr || '');
        let claimant = null;
        const sessAuth = await resolveAuth(req).catch(() => null);
        if (!req._cvLogged && sessAuth && sessAuth.user) { recordClientVersion(req, p, sessAuth.user); req._cvLogged = true; }
        if (sessAuth && sessAuth.user) {
          claimant = sessAuth.user;
          // 带了 username 时须与会话账号一致，防串号领取
          const bu = String(body.username || '').trim().toLowerCase();
          if (bu && bu !== claimant) return sendJson(res, 200, { ok: false, code: 'KEY_INVALID', msg: '密钥无效，请核对后重试。' });
        } else if (body.username && body.password) {
          const username = String(body.username || '').trim().toLowerCase();
          const ip = clientIpFromReq(req);
          const lockKey = 'c:' + username + ':' + ip;
          if (licVerifyLocked(lockKey)) { lic.audit({ ev: 'transfer-claim-auth', username, ok: false, why: 'locked', ip }); return sendJson(res, 200, { ok: false, code: 'VERIFY_LOCKED', msg: '核验失败次数过多，请 1 小时后再试。' }); }
          const okPw = await verifyAccountPassword(username, String(body.password || ''));
          lic.audit({ ev: 'transfer-claim-auth', username, ok: okPw, ip });
          if (!okPw) { licVerifyHit(lockKey, false); return sendJson(res, 200, { ok: false, code: 'VERIFY_FAILED', msg: '信息不一致，无法领取。' }); }
          licVerifyHit(lockKey, true);
          claimant = username;
        }
        if (!claimant) return sendJson(res, 401, { ok: false, code: 'UNAUTHORIZED', msg: '登录已过期，请重新登录后再试。' });
        const out = lic.claimByKeyString(claimant, keyStr, now);
        lic.audit({ ev: 'transfer-claim', username: claimant, ok: !!out.ok, code: out.code || 'OK' });
        if (out.ok) {
          log({ ev: 'transfer-claimed', target: claimant, keyId: out.keyId });
          // 同一时点强制原主人下线（17:29）：网页在线 WS 关闭＋已知 xid 撤销
          // ＋本站会话清除同步执行；软件端经 forceLogout 标志通道即刻下线、
          // 后续登录按 G1 拦截。执行摘要随响应回，不另起许可台账事件。
          // 边界（阶段 F 深查修复）：原主人名下仍有其他有效密钥时，其权益
          // 未终止，不执行强制下线（判定与 forceLogoutState 同一口径）；
          // 此时响应文案也不宣称已下线。
          let fl = null;
          const gateAfterClaim = lic.forceLogoutState ? lic.forceLogoutState(out.from, Date.now()) : null;
          if (gateAfterClaim) {
            try { fl = await executeClaimForceLogout(out.from); } catch (e) { log({ ev: 'transfer-force-logout-error', target: out.from, err: String((e && e.message) || e) }); }
            return sendJson(res, 200, Object.assign({}, out, { forceLogoutExec: fl, msg: '领取成功，密钥已转入您的账号，原主人一侧该密钥已失效，其在线会话已强制下线。登录后在软件端重新绑定即可使用。' }));
          }
          return sendJson(res, 200, Object.assign({}, out, { forceLogoutExec: { skipped: 'sender-retains-other-valid-key' }, msg: '领取成功，密钥已转入您的账号，原主人一侧该密钥已失效。登录后在软件端重新绑定即可使用。' }));
        }
        return sendJson(res, 200, out);
      }
      // ===== 换绑申诉提交（§11.9，无会话：账号＋密码只核验不签发登录态，
      // 口径同状态查询核验——失败统一提示、5 次失败锁核验 1 小时、审计留痕）。
      // 须带新设备码（壳自动带入，用户不手填）：缺码直接拒并给正式指引。
      // 校验分离：本路径只走 lic.rebindEligibilityByHash 替换资格判定，
      // 严禁经过普通绑定的槽满校验——同类槽位已占用是换绑的前提。 =====
      if (req.method === 'POST' && p === '/license/api/rebind/submit') {
        const body = await readJsonBody(req);
        const username = String(body.username || '').trim().toLowerCase();
        const deviceCode = String(body.deviceCode || '').trim();
        const platform = body.platform === 'mobile' ? 'mobile' : (body.platform === 'pc' ? 'pc' : '');
        const channel = ['android', 'windows', 'web'].includes(body.channel) ? body.channel : 'web';
        if (!deviceCode || !platform) {
          lic.audit({ ev: 'rebind-submit', username, ok: false, why: 'no-device-code' });
          return sendJson(res, 200, { ok: false, code: 'DEVICE_CODE_REQUIRED', msg: '请在新设备的 QFRemote 软件内提交换绑申诉。' });
        }
        if (!username || !body.password) return sendJson(res, 200, { ok: false, code: 'VERIFY_FAILED', msg: '信息不一致，无法提交。' });
        const ip = clientIpFromReq(req);
        const lockKey = 'rb:' + username + ':' + ip;
        if (licVerifyLocked(lockKey)) { lic.audit({ ev: 'rebind-submit', username, ok: false, why: 'locked', ip }); return sendJson(res, 200, { ok: false, code: 'VERIFY_LOCKED', msg: '核验失败次数过多，请 1 小时后再试。' }); }
        const okPw = await verifyAccountPassword(username, String(body.password || ''));
        lic.audit({ ev: 'rebind-submit', username, ok: okPw, ip });
        if (!okPw) { licVerifyHit(lockKey, false); return sendJson(res, 200, { ok: false, code: 'VERIFY_FAILED', msg: '信息不一致，无法提交。' }); }
        licVerifyHit(lockKey, true);
        const elig = lic.rebindEligibilityByHash(username, crypto.createHash('sha256').update(deviceCode).digest('hex'), platform, now);
        if (!elig.ok) return sendJson(res, 200, { ok: false, code: elig.code, msg: elig.msg });
        // 防重复：同账号同类槽位已有一笔待审换绑时不受理第二笔（不同类可独立提交）
        let data = { appeals: [] };
        try { const v = JSON.parse(fs.readFileSync(APPEALS_FILE, 'utf8')); if (v && Array.isArray(v.appeals)) { v.appeals = v.appeals.filter((x) => x && typeof x === 'object'); data = v; } } catch (e) {}
        const exist = data.appeals.find((x) => x.type === 'rebind' && x.status === 'pending' && String(x.key || x.username || '').toLowerCase() === username && x.platform === platform);
        if (exist) return sendJson(res, 200, { ok: false, code: 'REBIND_PENDING', appealId: exist.id, msg: '该类设备已有一笔换绑申诉正在审核中，无需重复提交。申诉编号：' + exist.id + '，请凭编号在申诉进度页查询。' });
        const appeal = {
          id: crypto.randomBytes(4).toString('hex'),
          type: 'rebind', reasonCode: 'REBIND',
          username, key: username, email: accountEmail(username) || '',
          desc: String(body.desc || '').slice(0, 500),
          platform, slotType: platform, channel,
          keyId: elig.keyId,
          oldDeviceCode: elig.oldDeviceCode, newDeviceCodeHash: elig.newDeviceCodeHash,
          status: 'pending', createdAt: now,
        };
        data.appeals.push(appeal);
        try {
          const tmp = APPEALS_FILE + '.tmp-lic'; fs.writeFileSync(tmp, JSON.stringify(data, null, 1), { mode: 0o600 }); fs.renameSync(tmp, APPEALS_FILE);
          try { const st = fs.statSync(path.dirname(APPEALS_FILE)); fs.chownSync(APPEALS_FILE, st.uid, st.gid); } catch (e) {}
        } catch (e) { return sendJson(res, 500, { ok: false, code: 'IO', msg: '提交失败，请稍后再试。' }); }
        lic.audit({ ev: 'rebind-submitted', username, ok: true, appealId: appeal.id, platform });
        log({ ev: 'rebind-submitted', appealId: appeal.id, target: username, platform, channel });
        reviewEvents.enqueue('rebind', appeal.id, { username, platform });
        return sendJson(res, 200, { ok: true, appealId: appeal.id, msg: '换绑申诉已提交，申诉编号：' + appeal.id + '，请保存编号。申诉已进入人工审核队列，处理结果将在申诉进度页更新。' });
      }
      // 其余 /license/api/* 须控制台会话
      const auth = await resolveAuth(req);
      if (!req._cvLogged) recordClientVersion(req, p, auth ? auth.user : null);
      if (!auth) return sendJson(res, 401, { ok: false, code: 'UNAUTHORIZED', msg: '登录已过期，请重新登录后再试。' });
      if (req.method === 'GET' && p === '/license/api/me') {
        const fls2 = lic.forceLogoutState ? lic.forceLogoutState(auth.user, now) : null;
        // enforce 与内网 login-check 同口径补填（阶段 D 缺口修复）：enforce＝
        // 非影子模式，或影子模式下该账号在 testUsers 名单内；影子模式下
        // 名单外账号的拟拦截判定照常记入影子事件册（与 login-check 一致）。
        const cfgMe = lic.readConfig();
        const decisionMe = lic.evaluate(auth.user, now, { channel: 'software' });
        decisionMe.enforce = licEnforce(cfgMe, auth.user);
        if (!decisionMe.allow && cfgMe.shadow && !decisionMe.enforce) lic.shadowLog({ ev: 'gate-would-block', username: auth.user, code: decisionMe.code, channel: 'software' });
        if (!decisionMe.allow) lic.save();
        return sendJson(res, 200, Object.assign({ ok: true }, lic.buildStatusView(auth.user, now), { decision: decisionMe }, fls2 ? { forceLogout: true, gateCode: 'G1' } : {}));
      }
      if (req.method === 'GET' && p === '/license/api/qfclash-access') {
        // QFClash 内嵌渠道准入（2.0.3 更新 3）：按 qfclash 渠道判许可——
        // 有效密钥/试用在期放行进控制台，未激活/过期回 G 类码供客户端
        // 自动打开购买页；不判槽位、不记绑定（evaluate 内已隔离）。
        const cfgQc = lic.readConfig();
        const decisionQc = lic.evaluate(auth.user, now, { channel: 'qfclash' });
        decisionQc.enforce = licEnforce(cfgQc, auth.user);
        if (!decisionQc.allow && cfgQc.shadow && !decisionQc.enforce) lic.shadowLog({ ev: 'gate-would-block', username: auth.user, code: decisionQc.code, channel: 'qfclash' });
        if (!decisionQc.allow) lic.save();
        const viewQc = lic.buildStatusView(auth.user, now);
        return sendJson(res, 200, { ok: true, allow: decisionQc.allow, code: decisionQc.code, msgCode: decisionQc.msgCode || null, keyExpiresMs: decisionQc.keyExpiresMs || null, trialExpiresMs: decisionQc.trialExpiresMs || null, planName: viewQc.planName, displayStatus: viewQc.displayStatus, webEnabled: viewQc.webEnabled });
      }
      if (req.method === 'POST' && p === '/license/api/device-report') {
        const body = await readJsonBody(req);
        const deviceCode = String(body.deviceCode || '').trim();
        const platform = body.platform === 'mobile' ? 'mobile' : 'pc';
        if (!deviceCode) return sendJson(res, 400, { ok: false, code: 'VALIDATION', msg: '缺少设备码。' });
        const r = lic.reportDevice(auth.user, deviceCode, platform, now);
        // #31：设备异常待审进统一事件队列（同单只挂一条，enqueue 内去重）
        if (r.reviewId && r.reviewPending) reviewEvents.enqueue('device_review', r.reviewId, { accounts: r.accounts, platform });
        // #23：回填账号最近上报设备（积分设备维度封顶的设备键）
        if (r.deviceHash) { pointsData.devices = pointsData.devices || {}; if (pointsData.devices[auth.user] !== r.deviceHash) { pointsData.devices[auth.user] = r.deviceHash; try { savePoints(); } catch (e) {} } }
        // B6 新规（16:53）：待审期间只拦不封；forceLogout 供壳侧强制登出该设备会话
        const d = lic.evaluate(auth.user, now, { channel: 'software', deviceCode, platform });
        // enforce 与内网 login-check 同口径补填（阶段 D 缺口修复，口径同 /license/api/me）
        const cfgDr = lic.readConfig();
        d.enforce = licEnforce(cfgDr, auth.user);
        if (!d.allow && cfgDr.shadow && !d.enforce) lic.shadowLog({ ev: 'gate-would-block', username: auth.user, code: d.code, channel: 'software' });
        if (!d.allow) lic.save();
        return sendJson(res, 200, { ok: true, device: r, decision: d });
      }
      if (req.method === 'POST' && p === '/license/api/bind') {
        const body = await readJsonBody(req);
        const deviceCode = String(body.deviceCode || '').trim();
        const platform = body.platform === 'mobile' ? 'mobile' : 'pc';
        if (!deviceCode) return sendJson(res, 400, { ok: false, code: 'VALIDATION', msg: '缺少设备码。' });
        const out = lic.bindKey(auth.user, String(body.key || ''), deviceCode, platform, now);
        // 影子纯净（阶段 F 深查修复）：只有犯次真实落盘执法（offenseApplied，
        // 即非影子或名单内账号且已写入统一台账封禁）才联动 mcdb 冻结；
        // 影子拟处置不得真冻结控制台账号。
        if (out.offense && out.offenseApplied) await licLockAccount(auth.user);
        return sendJson(res, out.ok ? 200 : 200, out);
      }
      if (req.method === 'POST' && p === '/license/api/transfer/initiate') {
        const body = await readJsonBody(req);
        // 裁决批④：发起转赠先校验受赠账号存在，不存在即拦截，不建待领取单
        const toUser = String(body.toUsername || '').trim().toLowerCase();
        if (!toUser || !accountExists(toUser)) return sendJson(res, 200, { ok: false, code: 'RECIPIENT_NOT_FOUND', msg: '受赠账号不存在，请核对账号后重试。' });
        const out = lic.initiateTransfer(auth.user, String(body.keyId || ''), toUser, now);
        return sendJson(res, 200, out);
      }
      if (req.method === 'POST' && p === '/license/api/transfer/reject') {
        // 17:23 撤换：拒绝动作已取消（不领取即不领取，转出方可撤销）
        return sendJson(res, 200, { ok: false, code: 'ENDPOINT_REPLACED', msg: '领取方式已变更：转赠不再设拒绝，不领取即可；如需处理请联系转出方撤销。' });
      }
      if (req.method === 'POST' && p === '/license/api/transfer/cancel') {
        // 转出方撤销待接受转赠（站长 17:11 定版）：随时可撤、不计次，
        // 撤销后同一把钥可再次发起转赠。
        const body = await readJsonBody(req);
        const out = lic.cancelTransfer(auth.user, String(body.transferId || ''), now);
        if (out.ok) log({ ev: 'transfer-cancelled', target: auth.user, transferId: String(body.transferId || '') });
        return sendJson(res, 200, out);
      }
      if (req.method === 'POST' && p === '/license/api/transfer/confirm') {
        // 17:23 撤换：点接受已取消，唯一领取路径为 POST /license/api/transfer/claim（粘贴密钥串）
        return sendJson(res, 200, { ok: false, code: 'ENDPOINT_REPLACED', msg: '领取方式已变更：请复制完整密钥串，粘贴到激活密钥输入框领取。' });
      }
      if (req.method === 'GET' && p === '/license/api/transfers') {
        // incoming 只含待接受（密钥过期终结的单不出现，17:14 定版）；
        // outgoing 含我发起的全部近单与终结状态/事由，供转出方看撤销入口与结果。
        const lists = lic.listTransfers(auth.user, now);
        const mine = lic.accountKeys(auth.user).map((k) => ({ keyId: k.id, planName: k.planName, masked: licMaskKey(k.str), transferredOnce: !!k.transferredOnce, transferable: k.source === 'paid' && !k.transferredOnce && (k.lifecycle === 'unactivated' || k.lifecycle === 'activated') }));
        return sendJson(res, 200, { ok: true, incoming: lists.incoming, outgoing: lists.outgoing, keys: mine });
      }
      if (req.method === 'POST' && p === '/license/api/order') {
        const body = await readJsonBody(req);
        const cfg3 = lic.readConfig();
        try {
          const order = lic.createOrder(auth.user, String(body.plan || ''), now);
          return sendJson(res, 200, { ok: true, orderId: order.id, amount: order.amount, status: order.status, payUnavailable: !cfg3.payEnabled });
        } catch (e) { return sendJson(res, 400, { ok: false, code: 'VALIDATION', msg: '套餐不正确。' }); }
      }
      // ===== 截图审核付款 · 用户侧订单接口组（蓝图 N-1，#21/21-补4） =====
      if (req.method === 'POST' && p === '/license/api/pay/orders') {
        const body = await readJsonBody(req);
        const out = payOrders.createOrder(auth.user, String(body.plan || ''), String(body.method || ''), now);
        if (!out.ok) return sendJson(res, 200, out);
        return sendJson(res, 200, { ok: true, order: out.order, pay: payOrders.payViewData(payOrders.getRaw(out.order.id), now), reused: !!out.reused });
      }
      if (req.method === 'GET' && p === '/license/api/pay/orders') {
        return sendJson(res, 200, { ok: true, orders: payOrders.listUser(auth.user, now) });
      }
      const paySubM = p.match(/^\/license\/api\/pay\/orders\/([^/]+)\/(continue|cancel|delete|submit|recognize)$/);
      if (req.method === 'POST' && paySubM) {
        const oid = decodeURIComponent(paySubM[1]); const act = paySubM[2];
        const body = await readJsonBody(req, (act === 'submit' || act === 'recognize') ? BODY_LIMIT_SHOT : undefined);
        if (body && body.__tooLarge) { log({ ev: act === 'recognize' ? 'pay-ocr' : 'pay-order-submit-failed', orderId: oid, target: auth.user, code: 'PAYLOAD_TOO_LARGE' }); return sendJson(res, 200, { ok: false, code: 'PAYLOAD_TOO_LARGE', msg: '截图文件过大，请上传不超过 12 MB 的 JPG 或 PNG 图片。' }); }
        if (act === 'recognize') {
          // 提交前识别订单号回填：仅回填、不落单、不裁定；模块降级/异常时恒回 found:false 静默回落手输
          if (!orderOcr) return sendJson(res, 200, { ok: true, found: false });
          const out = await orderOcr.recognize(auth.user, oid, body ? body.imageBase64 : '', now);
          return sendJson(res, 200, out);
        }
        if (act === 'continue') { const out = payOrders.switchMethod(auth.user, oid, body.method ? String(body.method) : '', now); return sendJson(res, 200, out); }
        if (act === 'cancel') return sendJson(res, 200, payOrders.cancelOrder(auth.user, oid, now));
        if (act === 'delete') return sendJson(res, 200, payOrders.deleteOrder(auth.user, oid, now));
        if (act === 'submit') {
          const out = payOrders.submitShot(auth.user, oid, { orderNo: body.orderNo, imageBase64: body.imageBase64 }, now);
          if (out.ok) reviewEvents.enqueue('order', oid, { username: auth.user, planName: out.order.planName, amount: out.order.amount, orderNo: String(body.orderNo || '') });
          if (out.ok && instantReview) { const _ir = instantReview, _oid = oid; setImmediate(() => { try { const p = _ir.tryReview(_oid); if (p && typeof p.catch === 'function') p.catch((e) => { try { log({ ev: 'instant-trigger-error', orderId: _oid, err: String(e && e.message || e) }); } catch (e2) {} }); } catch (e) { try { log({ ev: 'instant-trigger-error', orderId: _oid, err: String(e && e.message || e) }); } catch (e2) {} } }); } // 门二 D1/D10：响应先行、异步触发、promise 挂 catch
          else log({ ev: 'pay-order-submit-failed', orderId: oid, target: auth.user, code: out.code || 'UNKNOWN' });
          return sendJson(res, 200, out);
        }
      }
      // ===== 我的密钥 / 兑换KEY（#24：与转赠粘贴领取、登录激活弹窗共用同一兑换逻辑） =====
      if (req.method === 'GET' && p === '/license/api/mykeys') {
        const st = lic.state();
        const mine = lic.accountKeys(auth.user).map((k) => ({
          keyId: k.id, masked: licMaskKey(k.str), planName: k.planName,
          source: k.source, sourceLabel: k.source === 'paid' ? '付费购买' : (k.sourceNote || '免费发放'),
          lifecycle: k.lifecycle, activated: k.lifecycle !== 'unactivated',
          expiresText: k.lifecycle === 'unactivated' ? (lic.remainTextForKey ? lic.remainTextForKey(k, now) : '未激活，激活后起算') : (k.expiresBaseMs ? ('到期：' + new Date(lic.effectiveExpiry(k, now)).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' })) : '长期有效'),
          canRedeem: k.lifecycle === 'unactivated',
          createdAt: k.createdAt,
        })).sort((a, b) => b.createdAt - a.createdAt);
        return sendJson(res, 200, { ok: true, keys: mine });
      }
      if (req.method === 'POST' && p === '/license/api/redeem') {
        // 统一兑换入口：他人密钥（转赠待领取/未激活转售）走 claimByKeyString
        // 同一事务；本人未激活密钥（福利兑换等）走同一激活口径（激活起算）。
        // 本人密钥可凭 keyId 一键兑换（待兑换列表，串不下发到列表页）。
        const body = await readJsonBody(req);
        const keyStr = String(body.key || '').trim().toUpperCase();
        const st = lic.state();
        let rec = keyStr ? (Object.values(st.keys).find((k) => k.str === keyStr) || null) : null;
        if (!rec && body.keyId) { const byId = st.keys[String(body.keyId)]; if (byId && byId.username === auth.user) rec = byId; }
        if (!keyStr && !rec) return sendJson(res, 200, { ok: false, code: 'VALIDATION', msg: '请输入 QFRemote 激活密钥。' });
        if (rec && rec.username === auth.user) {
          if (lic.activeBansFor(auth.user, now).length) return sendJson(res, 200, { ok: false, code: 'ACCOUNT_BANNED', msg: '您的账号当前处于封禁或冻结状态，无法兑换密钥。请先处理账号状态或提交申诉。' });
          if (rec.lifecycle === 'expired') return sendJson(res, 200, { ok: false, code: 'KEY_EXPIRED', msg: lic.expiredText(rec, now), expiredAt: rec.expiresBaseMs ? lic.effectiveExpiry(rec, now) : null });
          if (rec.lifecycle !== 'unactivated') return sendJson(res, 200, { ok: false, code: 'ALREADY_ACTIVE', msg: '该密钥已在您的账号上生效，无需重复兑换。' });
          lic.activateKey(rec, now); lic.save();
          lic.audit({ ev: 'key-redeem-own', username: auth.user, ok: true, keyId: rec.id });
          log({ ev: 'key-redeemed-own', target: auth.user, keyId: rec.id });
          return sendJson(res, 200, { ok: true, keyId: rec.id, planName: rec.planName, msg: '兑换成功，密钥已激活并开始计时。' });
        }
        const out = lic.claimByKeyString(auth.user, keyStr, now);
        lic.audit({ ev: 'key-redeem', username: auth.user, ok: !!out.ok, code: out.code || 'OK' });
        if (out.ok && out.from) {
          const gate = lic.forceLogoutState ? lic.forceLogoutState(out.from, Date.now()) : null;
          if (gate) { try { await executeClaimForceLogout(out.from); } catch (e) { log({ ev: 'redeem-force-logout-error', target: out.from, err: String((e && e.message) || e) }); } }
        }
        return sendJson(res, 200, out);
      }
      // ===== 同账号设备间文件发送（#25 / 蓝图 N-3，服务端端点组） =====
      if (req.method === 'POST' && p === '/license/api/files/send') {
        const body = await readJsonBody(req, BODY_LIMIT_FILE);
        if (body.__tooLarge) return sendJson(res, 200, { ok: false, code: 'TOO_LARGE', msg: '文件超过单文件上限（200 MB），无法发送。' });
        const out = fileStage.stage(auth.user, { filename: body.filename, toNode: body.toNode, fromNode: body.fromNode, contentBase64: body.contentBase64 }, now);
        return sendJson(res, 200, out);
      }
      if (req.method === 'GET' && p === '/license/api/files/inbox') {
        return sendJson(res, 200, { ok: true, files: fileStage.inbox(auth.user, String(u.searchParams.get('node') || ''), now), limits: fileStage.limits() });
      }
      if (req.method === 'GET' && p === '/license/api/files/sent') {
        return sendJson(res, 200, { ok: true, files: fileStage.sent(auth.user, now) });
      }
      const fileDlM = p.match(/^\/license\/api\/files\/([^/]+)\/download$/);
      if (req.method === 'GET' && fileDlM) {
        const got = fileStage.blobPathFor(auth.user, decodeURIComponent(fileDlM[1]), now);
        try {
          if (!got || !fs.existsSync(got.fp)) return sendJson(res, 404, { ok: false, code: 'NOT_FOUND', msg: '文件不存在或已过期。' });
          const buf = fs.readFileSync(got.fp);
          // L5 RC-08（QF-STREAM-1）：Range 分片续传；无 Range 头时行为与旧版一致。
          let range = null;
          if (l5 && typeof req.headers.range === 'string') {
            try { range = l5.transferMod.parseRange(req.headers.range, buf.length); } catch (e) { range = null; }
          }
          if (range) {
            const slice = buf.subarray(range.start, range.end + 1);
            res.writeHead(206, { 'Content-Type': 'application/octet-stream', 'Content-Length': slice.length, 'Content-Range': 'bytes ' + range.start + '-' + range.end + '/' + buf.length, 'Accept-Ranges': 'bytes', 'Content-Disposition': 'attachment; filename="' + encodeURIComponent(got.it.filename) + '"', 'Cache-Control': 'no-store' });
            return res.end(slice);
          }
          res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': buf.length, 'Accept-Ranges': 'bytes', 'Content-Disposition': 'attachment; filename="' + encodeURIComponent(got.it.filename) + '"', 'Cache-Control': 'no-store' });
          return res.end(buf);
        } finally {
          if (got) got.release();
        }
      }
      const fileAckM = p.match(/^\/license\/api\/files\/([^/]+)\/ack$/);
      if (req.method === 'POST' && fileAckM) {
        return sendJson(res, 200, fileStage.ack(auth.user, decodeURIComponent(fileAckM[1]), now));
      }
      // ===== L5 画面与传输（RC-03/07/08/09/10，协议见 L5-DESIGN-CONFIRMATION.md）=====
      // RC-07：服务端宣告中继白名单（GET /license/api/relays）
      if (req.method === 'GET' && p === '/license/api/relays') {
        if (!l5Guard(res)) return;
        const host = String(req.headers['x-forwarded-host'] || req.headers.host || '');
        const origin = host ? 'https://' + host : '';
        return sendJson(res, 200, { ok: true, relays: l5.relayMod.announceRelays(lic.readConfig() || {}, origin) });
      }
      // RC-09：探针上报＋降档决策＋背压（POST /license/api/session/probe）
      if (req.method === 'POST' && p === '/license/api/session/probe') {
        if (!l5Guard(res)) return;
        const body = await readJsonBody(req);
        const sessionId = String(body.sessionId || '');
        if (!sessionId) return sendJson(res, 200, { ok: false, code: 'VALIDATION', msg: '缺少 sessionId。' });
        let qs = l5.qualitySessions.get(sessionId);
        if (!qs) {
          qs = l5.qualityMod.createQualitySession({ log, initialTier: String(body.tier || ''), tierTable: (lic.readConfig() || {}).qualityTiers });
          l5.qualitySessions.set(sessionId, qs);
        }
        const out = qs.ingestProbe(body.probe || {}, now);
        const bp = qs.backpressure(body.probe || {}, body.serverSignal || null, now);
        qs.sweepAcks(now);
        return sendJson(res, 200, { ok: true, tier: qs.tier(), decision: out, backpressure: bp });
      }
      // RC-09：手动升档 / 档位决策 ACK
      if (req.method === 'POST' && p === '/license/api/session/quality/upgrade') {
        if (!l5Guard(res)) return;
        const body = await readJsonBody(req);
        const qs = l5.qualitySessions.get(String(body.sessionId || ''));
        if (!qs) return sendJson(res, 200, { ok: false, code: 'NOT_FOUND', msg: '会话不存在（须先上报探针）。' });
        return sendJson(res, 200, qs.requestUpgrade(now));
      }
      if (req.method === 'POST' && p === '/license/api/session/quality/ack') {
        if (!l5Guard(res)) return;
        const body = await readJsonBody(req);
        const qs = l5.qualitySessions.get(String(body.sessionId || ''));
        if (!qs) return sendJson(res, 200, { ok: false, code: 'NOT_FOUND', msg: '会话不存在。' });
        return sendJson(res, 200, qs.ack(String(body.decisionId || ''), now));
      }
      // RC-03：IDR 请求准入（POST /license/api/session/idr-request）
      // 绑定说明：首次见到的 sessionId 按“先到先得”绑定到当前用户＋
      // body.agentId，此后只认该绑定（防客户端指定任意 sessionId）；
      // 权威绑定（agent 侧注册）待 agent 通道落地后以 LEA/控制通道为准。
      if (req.method === 'POST' && p === '/license/api/session/idr-request') {
        if (!l5Guard(res)) return;
        const body = await readJsonBody(req);
        const sessionId = String(body.sessionId || '');
        const agentId = String(body.agentId || '');
        if (!sessionId || !agentId) return sendJson(res, 200, { ok: false, code: 'VALIDATION', msg: '缺少 sessionId/agentId。' });
        l5.idrGate.bind(sessionId, auth.user, agentId, now);
        const out = l5.idrGate.request({ sessionId, userId: auth.user, agentId, seq: Number(body.seq), reason: String(body.reason || ''), nowMs: now });
        return sendJson(res, 200, Object.assign({ ok: out.decision === 'forward' || out.decision === 'coalesced' }, out));
      }
      // RC-08：分片文件流（QF-STREAM-1）
      if (req.method === 'POST' && p === '/license/api/files/stream/init') {
        if (!l5Guard(res)) return;
        const body = await readJsonBody(req);
        return sendJson(res, 200, l5.transferCore.init(auth.user, body, now));
      }
      const streamChunkM = p.match(/^\/license\/api\/files\/stream\/([^/]+)\/chunk$/);
      if (req.method === 'POST' && streamChunkM) {
        if (!l5Guard(res)) return;
        const body = await readJsonBody(req, BODY_LIMIT_FILE);
        if (body.__tooLarge) return sendJson(res, 200, { ok: false, code: 'TOO_LARGE', msg: '分片过大。' });
        let buf = null;
        try { buf = Buffer.from(String(body.contentBase64 || ''), 'base64'); } catch (e) { buf = null; }
        if (!buf) return sendJson(res, 200, { ok: false, code: 'VALIDATION', msg: '分片内容不正确。' });
        return sendJson(res, 200, l5.transferCore.putChunk(auth.user, decodeURIComponent(streamChunkM[1]), Number(body.index), buf, now));
      }
      const streamMissingM = p.match(/^\/license\/api\/files\/stream\/([^/]+)\/missing$/);
      if (req.method === 'GET' && streamMissingM) {
        if (!l5Guard(res)) return;
        return sendJson(res, 200, l5.transferCore.missingChunks(auth.user, decodeURIComponent(streamMissingM[1])));
      }
      const streamCommitM = p.match(/^\/license\/api\/files\/stream\/([^/]+)\/commit$/);
      if (req.method === 'POST' && streamCommitM) {
        if (!l5Guard(res)) return;
        return sendJson(res, 200, l5.transferCore.commit(auth.user, decodeURIComponent(streamCommitM[1]), now));
      }
      const streamCancelM = p.match(/^\/license\/api\/files\/stream\/([^/]+)\/cancel$/);
      if (req.method === 'POST' && streamCancelM) {
        if (!l5Guard(res)) return;
        return sendJson(res, 200, l5.transferCore.cancel(auth.user, decodeURIComponent(streamCancelM[1]), now));
      }
      // RC-08：传输审计（只返回本人记录）
      if (req.method === 'GET' && p === '/license/api/files/audit') {
        if (!l5Guard(res)) return;
        return sendJson(res, 200, { ok: true, audit: l5.transferCore.listAudit(auth.user, Number(u.searchParams.get('limit')) || 50) });
      }
      // RC-10：录像（QF-REC-1；默认不录，策略见 config.json recording）
      if (req.method === 'POST' && p === '/license/api/recordings/start') {
        if (!l5Guard(res)) return;
        const body = await readJsonBody(req);
        return sendJson(res, 200, l5.recordingCore.startSession({ sessionId: body.sessionId, username: auth.user, deviceId: body.deviceId, groupId: body.groupId, tier: body.tier }, now));
      }
      const recEventM = p.match(/^\/license\/api\/recordings\/([^/]+)\/event$/);
      if (req.method === 'POST' && recEventM) {
        if (!l5Guard(res)) return;
        const id = decodeURIComponent(recEventM[1]);
        // QF-REC-1 鉴权补齐（2026-11-15）：写路径与 index/download 同口径——
        // 只许本人（canAccess）；无权限与不存在同一 HTTP 404，不泄露录制会话存在性。
        // 检查放在读请求体之前：未授权请求不解析、不落盘。
        const acc = l5.recordingCore.canAccess(auth.user, id);
        if (!acc.ok) return sendJson(res, 404, { ok: false, code: 'NOT_FOUND', msg: '录像不存在。' });
        const body = await readJsonBody(req);
        return sendJson(res, 200, l5.recordingCore.appendEvent(id, body.event || {}, now));
      }
      const recEndM = p.match(/^\/license\/api\/recordings\/([^/]+)\/end$/);
      if (req.method === 'POST' && recEndM) {
        if (!l5Guard(res)) return;
        const id = decodeURIComponent(recEndM[1]);
        const acc = l5.recordingCore.canAccess(auth.user, id);
        if (!acc.ok) return sendJson(res, 404, { ok: false, code: 'NOT_FOUND', msg: '录像不存在。' });
        return sendJson(res, 200, l5.recordingCore.endSession(id, now));
      }
      if (req.method === 'GET' && p === '/license/api/recordings') {
        if (!l5Guard(res)) return;
        return sendJson(res, 200, { ok: true, recordings: l5.recordingCore.listRecordings(auth.user) });
      }
      const recIndexM = p.match(/^\/license\/api\/recordings\/([^/]+)\/index$/);
      if (req.method === 'GET' && recIndexM) {
        if (!l5Guard(res)) return;
        const id = decodeURIComponent(recIndexM[1]);
        const acc = l5.recordingCore.canAccess(auth.user, id);
        if (!acc.ok) return sendJson(res, 404, { ok: false, code: 'NOT_FOUND', msg: '录像不存在。' });
        return sendJson(res, 200, { ok: true, index: l5.recordingCore.readIndex(id) });
      }
      const recDlM = p.match(/^\/license\/api\/recordings\/([^/]+)\/download$/);
      if (req.method === 'GET' && recDlM) {
        if (!l5Guard(res)) return;
        const id = decodeURIComponent(recDlM[1]);
        const acc = l5.recordingCore.canAccess(auth.user, id);
        if (!acc.ok) return sendJson(res, 404, { ok: false, code: 'NOT_FOUND', msg: '录像不存在。' });
        const fp = l5.recordingCore.filePath(id);
        if (!fs.existsSync(fp)) return sendJson(res, 404, { ok: false, code: 'NOT_FOUND', msg: '录像不存在。' });
        const buf = fs.readFileSync(fp);
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': buf.length, 'Content-Disposition': 'attachment; filename="' + encodeURIComponent(id + '.qfrec') + '"', 'Cache-Control': 'no-store' });
        return res.end(buf);
      }
      return sendJson(res, 404, { ok: false, code: 'NOT_FOUND', msg: '该接口不存在。' });
    }

    // ===== 新版首页（阶段 C-3，三端共用正本的网页落点）=====
    // 页面本体在 home-page.js；数据全走同源接口：/license/api/me、
    // /license/api/transfers、/points/api/me 与下面的 /home/api/stats。
    if (req.method === 'GET' && p === '/home') {
      const auth = await resolveAuth(req);
      if (!auth) { res.writeHead(302, { Location: '/?return=/home', 'Cache-Control': 'no-store' }); return res.end(); }
      if (!homePageHtml) return sendJson(res, 500, { ok: false, msg: '首页模块未加载。' });
      return sendHtml(res, 200, homePageHtml());
    }
    if (req.method === 'GET' && p === '/home/api/stats') {
      const auth = await resolveAuth(req);
      if (!auth) return sendJson(res, 401, { ok: false, code: 'UNAUTHORIZED', msg: '登录已过期，请重新登录后再试。' });
      if (denyIfBanned(res, auth.user)) return;
      const out = await buildHomeStats(req, auth);
      return sendJson(res, 200, out);
    }
    // ===== 设备解析兜底：GET /api/device/resolve?name=<设备名> =====
    // 网页 SPA 点设备进远程会话时，本地 name→nodeid 解析偶发竞态降级；
    // 本端点在服务端用同一条真实取数路径（mcFetchNodes）复查一遍回裸
    // nodeid。只读、无副作用、不写任何状态。业务结果一律 200 回包、
    // 由 ok/code 表达（未登录 401、缺 name 400 除外），与 /home/api 同口径。
    if (req.method === 'GET' && p === '/api/device/resolve') {
      const auth = await resolveAuth(req);
      if (!auth) return sendJson(res, 401, { ok: false, code: 'UNAUTHORIZED', msg: '登录已过期，请重新登录后再试。' });
      if (denyIfBanned(res, auth.user)) return;
      const qname = u.searchParams.get('name');
      if (!qname || !String(qname).trim()) return sendJson(res, 400, { ok: false, code: 'VALIDATION', msg: '请提供要查找的设备名称。' });
      const nodesByMesh = await mcFetchNodes(req.headers.cookie, clientIpFromReq(req), auth.user);
      return sendJson(res, 200, resolveDeviceByName(nodesByMesh, String(qname).trim()));   // DS P2-6：校验已 trim、匹配亦须 trim 后统一口径（原传原串致带空格名 NOT_FOUND）
    }
    // ===== 设备在线预检（W-11，2.4.5 新增）：GET /api/device/presence?nodeid=<裸 nodeid> =====
    // 唯一判官口径，三端共用：会话预检（W-01）、重试复查（W-12）、自愈判官都问
    // 同一个接口。方法 GET（纯读查询）、入参 nodeid（meshid 是设备组 id，定不
    // 了一台设备，故不用 DS 原提议的 POST /home/api/agent-presence {meshid}）。
    // 鉴权 resolveAuth＋denyIfBanned（与 /api/device/resolve 同款）；未登录 401；
    // 封禁 403 ACCOUNT_BANNED。出参 200、ok 恒 true，业务结果由 code 表达。
    // 越权隔离靠 MC 自身可见范围：只在调用方可见的 nodes 回包里找，找不到即
    // NOT_FOUND，不区分「不存在」与「无权看」。取数复用 mcFetchNodes 的 5 秒
    // 共享缓存＋单飞（X-05），不得每次新开 WS；总预算 8 秒，超时回 TIMEOUT。
    if (req.method === 'GET' && p === '/api/device/presence') {
      const auth = await resolveAuth(req);
      if (!auth) return sendJson(res, 401, { ok: false, code: 'UNAUTHORIZED', msg: '登录已过期，请重新登录后再试。' });
      if (denyIfBanned(res, auth.user)) return;
      const qid = u.searchParams.get('nodeid');
      if (!qid || !String(qid).trim()) return sendJson(res, 400, { ok: false, code: 'VALIDATION', msg: '请提供要查询的设备标识。' });
      const nodesByMesh = await mcFetchNodesBudgeted(req.headers.cookie, clientIpFromReq(req), auth.user, 8000);
      return sendJson(res, 200, resolvePresence(nodesByMesh, String(qid).trim(), Date.now(), auth.user));
    }
    if (req.method === 'GET' && p === '/home/api/login-devices') {
      const auth = await resolveAuth(req);
      if (!auth) return sendJson(res, 401, { ok: false, code: 'UNAUTHORIZED', msg: '登录已过期，请重新登录后再试。' });
      if (denyIfBanned(res, auth.user)) return;
      const devices = qfclashLogins
        .filter((r) => r.user === auth.user && !r.revokedAt)
        .sort((a, b) => b.at - a.at)
        .map((r) => ({ id: r.id, source: 'qfclash', label: '在QFClash应用登录中', loginAt: r.at }));
      return sendJson(res, 200, { ok: true, devices });
    }
    if (req.method === 'POST' && p === '/home/api/login-devices/revoke') {
      const auth = await resolveAuth(req);
      if (!auth) return sendJson(res, 401, { ok: false, code: 'UNAUTHORIZED', msg: '登录已过期，请重新登录后再试。' });
      if (denyIfBanned(res, auth.user)) return;
      const body = await readJsonBody(req);
      const rec = qfclashLogins.find((r) => r.id === String(body.id || '') && r.user === auth.user && !r.revokedAt);
      if (!rec) return sendJson(res, 404, { ok: false, code: 'NOT_FOUND', msg: '这条登录记录不存在或已下线。' });
      rec.revokedAt = Date.now();
      saveQfclashLogins();
      // DS-R02-③（2026-10-26 修复批）：按渠道隔离撤销面——本路由是 QFClash 登录记录的
      // 「下线这一条」，有该次登录的 xid 哈希时只撤这一条会话（登记撤销＋清验真缓存，
      // 本站一切验真接口即时拒）。边界：MeshCentral 控制通道无「按会话关闭」原语
      // （其会话按用户聚合、关会话原语即账号级），故 MC 侧在线连接不在本路由处理——
      // 该 xid 已被登记撤销且有效期与 xid 同寿（30 天），残余连接随 xid 自然到期消亡；
      // 需要连 MC 在线会话一并清的场景走转赠认领的账号级强制下线（定版语义，另有其路）。
      // 无哈希的历史记录回落旧口径（全账号双路），行为与修复前一致。
      if (rec.xidHash) {
        revokeSingleXid(rec.xidHash, auth.user);
        log({ ev: 'qfclash-login-revoke', target: auth.user, id: rec.id, mode: 'targeted', revokedXids: 1, closed: 0 });
      } else {
        const revoked = revokeXidsForUser(auth.user);
        const closed = await mcForceCloseUserSessions(auth.user).catch(() => null);
        log({ ev: 'qfclash-login-revoke', target: auth.user, id: rec.id, mode: 'legacy-account-wide', revokedXids: revoked, closed: closed ? 1 : 0 });
      }
      return sendJson(res, 200, { ok: true });
    }

    // ===== 一次性令牌（双挂路由，总装裁定 2026-10-25：安卓用 /admin/api/sso-token，原 brief 用 /points/api/sso-token，同一处理、都回 {token}） =====
    if (req.method === 'POST' && (p === '/points/api/sso-token' || p === '/admin/api/sso-token')) {
      const auth = await resolveAuth(req);
      if (!auth) return sendJson(res, 401, { error: '登录已过期，请重新登录后再试。' });
      if (auth.user !== ADMIN_EMAIL && denyIfBanned(res, auth.user)) return;
      const token = crypto.randomBytes(32).toString('hex');
      ssoTokens.set(token, { user: auth.user, siteadmin: auth.siteadmin, exp: Date.now() + SSO_TOKEN_TTL_MS });
      return sendJson(res, 200, { ok: true, token, expiresIn: 60, loginPath: '/admin/login?token=' + token });
    }
    // ===== 积分 =====
    if (req.method === 'POST' && p === '/points/api/heartbeat') {
      const auth = await resolveAuth(req);
      if (!auth) return sendJson(res, 401, { error: '请先登录后再使用。' });
      if (denyIfBanned(res, auth.user)) return;
      const body = await readJsonBody(req);
      const now = Date.now();
      let rec = pointsData.users[auth.user];
      if (!rec) { rec = pointsCore.newRecord(now); pointsData.users[auth.user] = rec; }
      const addedSec = pointsCore.applyHeartbeat(rec, now);
      if (body && typeof body.client === 'string' && body.client) rec.lastClient = body.client.slice(0, 40);
      rec.lastBeatAt = new Date(now).toISOString();
      // #23 赚分：服务器在线秒数计分（不做闲置检测，23-补），账号＋设备双封顶
      const devKey = (pointsData.devices && pointsData.devices[auth.user]) || ('acct:' + auth.user);
      const earnOut = pointsCore.earnHeartbeat(rec, devKey, addedSec, now, (pointsData.deviceDays = pointsData.deviceDays || {}));
      let pointsPersisted = true;
      try { savePointsSoon(); } catch (e) { pointsPersisted = false; log({ ev: 'points-save-error', err: String(e && e.message) }); }
      // 17:29：软件壳在线期间的强制下线信号走既有心跳通道下发——壳收到
      // forceLogout:true 须立即登出本机会话并回 G1 拦截页（契约 §7.5.7）。
      const fls = lic.forceLogoutState ? lic.forceLogoutState(auth.user, now) : null;
      return sendJson(res, 200, Object.assign({ ok: true }, pointsCore.computeMe(auth.user, rec, now), { earn: pointsCore.earnView(rec, devKey, now, pointsData.deviceDays), earnedNow: earnOut.grantedNow }, pointsPersisted ? {} : { persisted: false }, fls ? { forceLogout: true, gateCode: 'G1' } : {}));
    }
    if (req.method === 'GET' && p === '/points/api/me') {
      const auth = await resolveAuth(req);
      if (!auth) return sendJson(res, 401, { error: '请先登录后再使用。' });
      if (denyIfBanned(res, auth.user)) return;
      // 无心跳记录时先建档再计算：首次打开积分页即显示「已经 1 天」，不再出现 0 天（F 线 ⑥，总线收口落地）
      let meRec = pointsData.users[auth.user];
      if (!meRec) {
        meRec = pointsCore.newRecord(Date.now());
        pointsData.users[auth.user] = meRec;
        try { savePoints(); } catch (e) { log({ ev: 'points-save-error', err: String(e && e.message) }); }
      }
      const devKey = (pointsData.devices && pointsData.devices[auth.user]) || ('acct:' + auth.user);
      return sendJson(res, 200, Object.assign({ ok: true }, pointsCore.computeMe(auth.user, meRec, Date.now()), { earn: pointsCore.earnView(meRec, devKey, Date.now(), pointsData.deviceDays) }));
    }
    // ===== 赚取积分：每日签到（#23） =====
    if (req.method === 'POST' && p === '/points/api/checkin') {
      const auth = await resolveAuth(req);
      if (!auth) return sendJson(res, 401, { error: '请先登录后再使用。' });
      if (denyIfBanned(res, auth.user)) return;
      const now = Date.now();
      let rec = pointsData.users[auth.user];
      if (!rec) { rec = pointsCore.newRecord(now); pointsData.users[auth.user] = rec; }
      const devKey = (pointsData.devices && pointsData.devices[auth.user]) || ('acct:' + auth.user);
      const out = pointsCore.earnCheckin(rec, devKey, now, (pointsData.deviceDays = pointsData.deviceDays || {}));
      try { savePoints(); } catch (e) { log({ ev: 'points-save-error', err: String(e && e.message) }); }
      log({ ev: 'points-checkin', target: auth.user, ok: !!out.ok });
      return sendJson(res, 200, Object.assign({}, out, { earn: pointsCore.earnView(rec, devKey, now, pointsData.deviceDays) }));
    }
    // ===== 福利中心（#23/#24）：兑换密钥入本人「待兑换」列表，兑换动作在兑换KEY页完成激活 =====
    if (req.method === 'GET' && p === '/points/api/welfare') {
      const auth = await resolveAuth(req);
      if (!auth) return sendJson(res, 401, { error: '请先登录后再使用。' });
      if (denyIfBanned(res, auth.user)) return;
      const now = Date.now();
      let rec = pointsData.users[auth.user];
      if (!rec) { rec = pointsCore.newRecord(now); pointsData.users[auth.user] = rec; try { savePoints(); } catch (e) {} }
      const ev2 = pointsCore.ensureEarn(rec, now);
      const records = ev2.ledger.filter((x) => x.kind === 'spend').slice(-20).reverse();
      return sendJson(res, 200, { ok: true, balance: ev2.balance, offers: [{ plan: 'd1', planName: 'QFRemote 1日套餐', cost: 200 }, { plan: 'd7', planName: 'QFRemote 7日套餐', cost: 500 }], records });
    }
    if (req.method === 'POST' && p === '/points/api/welfare/redeem') {
      const auth = await resolveAuth(req);
      if (!auth) return sendJson(res, 401, { error: '请先登录后再使用。' });
      if (denyIfBanned(res, auth.user)) return;
      const body = await readJsonBody(req);
      const plan = String(body.plan || '');
      const cost = plan === 'd1' ? 200 : (plan === 'd7' ? 500 : 0);
      if (!cost) return sendJson(res, 200, { ok: false, code: 'VALIDATION', msg: '兑换档位不正确。' });
      const now = Date.now();
      let rec = pointsData.users[auth.user];
      if (!rec) { rec = pointsCore.newRecord(now); pointsData.users[auth.user] = rec; }
      const spend = pointsCore.earnSpend(rec, cost, '福利兑换 ' + LIC_PLANS[plan].name, now);
      if (!spend.ok) return sendJson(res, 200, { ok: false, code: spend.code, msg: spend.msg || '兑换失败。', balance: spend.balance });
      const key = lic.issueKey(auth.user, plan, 'points', now, { actor: 'points-welfare' }); // DS-R01 B3：积分兑换独立来源，不再冒用 free（sourceNote 旁注保留与存量同字）
      const stK = lic.state(); if (stK.keys[key.id]) { stK.keys[key.id].sourceNote = '积分兑换（免费）'; lic.save(); }
      try { savePoints(); } catch (e) { log({ ev: 'points-save-error', err: String(e && e.message) }); }
      log({ ev: 'welfare-redeemed', target: auth.user, plan, keyId: key.id, cost });
      return sendJson(res, 200, { ok: true, keyId: key.id, maskedKey: licMaskKey(key.str), planName: key.planName, balance: spend.balance, msg: '兑换成功，密钥已进入您的「待兑换」列表，在「兑换KEY」页一键兑换即可激活。' });
    }
    if (req.method === 'GET' && p === '/points/welfare') {
      const auth = await resolveAuth(req);
      if (!auth) { res.writeHead(302, { Location: '/?return=/points/welfare', 'Cache-Control': 'no-store' }); return res.end(); }
      return sendHtml(res, 200, welfarePageHtml());
    }

    // ===== 一次性令牌换本站会话 =====
    if (req.method === 'GET' && p === '/admin/login') {
      const token = u.searchParams.get('token') || '';
      const entry = ssoTokens.get(token);
      if (entry) ssoTokens.delete(token); // 单次使用：取到即作废
      if (!entry || Date.now() > entry.exp) {
        return sendHtml(res, 401, '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>链接已失效 · QFRemote</title></head><body style="font-family:sans-serif;background:#F4F7FB"><div style="max-width:430px;margin:40px auto;background:#fff;border:1px solid #DFE7F2;border-radius:14px;padding:24px 20px"><h1 style="font-size:18px;color:#0B2B5B">这个入口链接已经失效</h1><p style="line-height:1.8;color:#43536a">入口链接只能用一次，而且只有一分钟有效。请回到 QFRemote 软件里重新打开站长管理页。</p></div></body></html>');
      }
      issueSession(res, entry);
      res.writeHead(302, { Location: '/admin', 'Cache-Control': 'no-store' });
      return res.end();
    }

    // ===== 手动退出（2.3.0 新增）：作废本站会话 + 清 cookie + 落退出标记 =====
    // 不要求先过站长鉴权：拿着本站会话或控制台会话来退出都照单全收，
    // 退出后同一控制台会话内刷新管理页不会再自动以站长身份进来。
    if (req.method === 'POST' && p === '/admin/api/logout') {
      destroySession(req, res);
      log({ ev: 'admin-logout' });
      return sendJson(res, 200, { ok: true, msg: '已退出站长管理。' });
    }
    if (req.method === 'GET' && p === '/admin/logout') {
      destroySession(req, res);
      log({ ev: 'admin-logout' });
      return sendHtml(res, 200, '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>已退出 · QFRemote</title>'
        + '<style>body{margin:0;font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;background:#F4F7FB;color:#1c2733}.wrap{max-width:430px;margin:0 auto;padding:40px 16px}.card{background:#fff;border:1px solid #DFE7F2;border-radius:14px;padding:24px 20px}h1{font-size:18px;color:#0B2B5B;margin:0 0 10px}p{font-size:14px;line-height:1.8;color:#43536a}a{color:#2470E0}</style></head>'
        + '<body><div class="wrap"><div class="card"><h1>已退出站长管理</h1><p>本次登录已经结束。需要再进来时，请回到 QFRemote 软件里重新打开站长管理页。</p><p><a href="/">返回控制台</a></p></div></div></body></html>');
    }

    // ===== 站长管理（页面 + 接口）=====
    if (p === '/admin' || p.startsWith('/admin/api')) {
      const auth = await resolveAuth(req);
      if (!isAdmin(auth)) {
        log({ ev: 'admin-denied', user: auth ? auth.user : null, path: p });
        if (p === '/admin') return forbiddenPage(res);
        return sendJson(res, 403, { ok: false, msg: '只有站长账号可以进行这个操作。' });
      }
      if (req.method === 'GET' && p === '/admin') return sendHtml(res, 200, adminPageHtml());
      if (req.method === 'GET' && p === '/admin/api/me') return sendJson(res, 200, { ok: true, user: auth.user });
      if (req.method === 'GET' && p === '/admin/api/users') {
        try { return sendJson(res, 200, { ok: true, users: buildUsersList() }); }
        catch (e) { log({ ev: 'users-list-error', err: String(e && e.message) }); return sendJson(res, 500, { ok: false, msg: '账号列表暂时无法读取，请稍后再试。' }); }
      }
      // ===== 站长创建账号（站长 2026-10-26 15:18 令）=====
      // 经注册服务内网口复用现行开户链（校验/建号/3 天试用与自助注册同一条链），
      // 本服务不另写建号逻辑；格式/唯一性/密码强度的权威校验在注册服务单点，
      // 此处只做边界形状预检防巨包。完成性核对：回执丢失/超时/REG 侧失败后，
      // 先查 MC 库与许可态再定成败——刚建成（creation 180 秒内）补完许可按成功
      // 改判，非新鲜的既存号改判重名，无号才报未完成（建成不报失败）。
      if (req.method === 'POST' && p === '/admin/api/users/create') {
        const body = await readJsonBody(req);
        if (body.__tooLarge) return sendJson(res, 400, { ok: false, msg: '填写内容过长，请检查后重试。' });
        const username = String(body.username || '');
        const password = String(body.password || '');
        const displayName = body.displayName == null ? '' : String(body.displayName);
        if (!username || username.length > 80 || !password || password.length > 256 || displayName.length > 64) {
          return sendJson(res, 400, { ok: false, msg: '填写不完整或过长，请检查后重试。' });
        }
        const completeLic = (name) => {
          let acct = lic.state().accounts[name];
          if (!acct || !acct.trial || !acct.trialKeyId) {
            lic.registerSuccess(name, '', '', Date.now());
            log({ ev: 'admin-create-lic-repair', target: name, by: auth.user });
            acct = lic.state().accounts[name];
          }
          return acct;
        };
        const okOut = (name, late) => {
          const acct = completeLic(name);
          // 试用未真落账（如许可侧存量账号无 trial）绝不回「已发试用」：如实标
          // trialOk=false，页面据此改口径（门二 D2）。
          const trialOk = !!(acct && acct.trial && acct.trialKeyId);
          if (!trialOk) log({ ev: 'admin-create-lic-incomplete', target: name, by: auth.user });
          log({ ev: 'admin-create-account', target: name, by: auth.user, ok: true, late: !!late, trialOk });
          return sendJson(res, 200, { ok: true, username: name, trialOk, trialExpiresMs: trialOk ? acct.trial.expiresMs : null });
        };
        // 超时显式 20000：REG 最坏处理（建号等待 ≤10s＋许可回写 ≤5s）约 15s，
        // 沿用调用器默认 5000 会把已建成误判成失败（门一 D1）。
        const out = await postInternalJson(REG_INTERNAL_BASE + '/internal/admin-create', { username, password, displayName, operator: auth.user }, 20000);
        if (out && out.ok === true && out.username) return okOut(String(out.username), false);
        const BIZ = ['USERNAME_FORMAT', 'USERNAME_RESERVED', 'USERNAME_TAKEN', 'PASSWORD_WEAK', 'DISPLAYNAME_INVALID', 'USER_LIMIT', 'INTERNAL_AUTH'];
        if (out && out.ok === false && BIZ.includes(out.code)) {
          log({ ev: 'admin-create-account', target: username.trim().toLowerCase(), by: auth.user, ok: false, code: out.code });
          return sendJson(res, 200, { ok: false, code: out.code, msg: out.msg || '创建未成功，请稍后再试。' });
        }
        const lookup = username.trim().toLowerCase();
        let mcUser = null, dbErr = false;
        try { mcUser = findDbUser(loadDb(), lookup); } catch (e) { dbErr = true; }
        if (dbErr) {
          // 读库抖动不静默吞：留痕＋短暂重试一次，仍失败才按无号走（门二 D1）
          log({ ev: 'admin-create-check-dberror', target: lookup, by: auth.user });
          await new Promise((r) => setTimeout(r, 400));
          try { mcUser = findDbUser(loadDb(), lookup); } catch (e) {}
        }
        if (mcUser) {
          const fresh = mcUser.creation && (Date.now() / 1000 - mcUser.creation) < 180;
          if (fresh) return okOut(lookup, true);
          log({ ev: 'admin-create-account', target: lookup, by: auth.user, ok: false, code: 'USERNAME_TAKEN' });
          return sendJson(res, 200, { ok: false, code: 'USERNAME_TAKEN', msg: '该账号已被注册' });
        }
        log({ ev: 'admin-create-account', target: lookup, by: auth.user, ok: false, code: (out && out.code) || (out && out.ok === false ? 'CREATE_FAILED' : 'NO_RESPONSE') });
        if (out && out.ok === false && out.code === 'CREATE_FAILED' && out.msg) return sendJson(res, 200, { ok: false, code: 'CREATE_FAILED', msg: out.msg });
        return sendJson(res, 200, { ok: false, msg: '创建服务暂时不可用，本次创建未完成，请稍后再试。' });
      }
      if (req.method === 'GET' && p === '/admin/api/appeals') {
        let data = { appeals: [] };
        try { const v = JSON.parse(fs.readFileSync(APPEALS_FILE, 'utf8')); if (v && Array.isArray(v.appeals)) data = v; } catch (e) {}
        const pick = (a) => ({ id: a.id, username: a.username, email: a.email || '', desc: a.desc || '', freezeDay: a.freezeDay || '', status: a.status, createdAt: a.createdAt, decidedAt: a.decidedAt || null, reason: a.reason || '', reasonCode: a.reasonCode || '', banId: a.banId || '', decidedBy: a.decidedBy || '', type: a.type || '', platform: a.platform || '', channel: a.channel || '', oldDeviceCode: a.oldDeviceCode || '', newDeviceCodeHash: a.newDeviceCodeHash || '', executionNote: a.executionNote || '', rebindExec: a.rebindExec || null });
        const pending = data.appeals.filter((a) => a.status === 'pending').sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).map(pick);
        const recent = data.appeals.filter((a) => a.status !== 'pending').sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 20).map(pick);
        return sendJson(res, 200, { ok: true, pending, recent });
      }
      // ===== 许可：站长发码（来源必选、无默认；paid 决定网页权益，口径对齐 §11.5） =====
      if (req.method === 'POST' && p === '/admin/api/license/issue') {
        const body = await readJsonBody(req);
        const username = String(body.username || '').trim().toLowerCase();
        const plan = String(body.plan || '');
        if (!ACCOUNT_RE.test(username)) return sendJson(res, 400, { ok: false, msg: '账号格式不正确，请检查后重试。' });
        if (!LIC_PLANS[plan]) return sendJson(res, 400, { ok: false, code: 'VALIDATION', msg: '套餐不正确。' });
        if (body.source !== 'paid' && body.source !== 'free') return sendJson(res, 400, { ok: false, code: 'SOURCE_REQUIRED', msg: '必须选择密钥来源（付费购买入账 / 免费发放），不设默认。' });
        const docs = loadDb();
        if (!findDbUser(docs, username)) return sendJson(res, 404, { ok: false, msg: '账号不存在：' + username });
        let orderId = null;
        if (body.source === 'paid') { const o = lic.createOrder(username, plan, Date.now()); o.status = 'paid'; o.channel = 'admin-paid-record'; o.paidAt = Date.now(); lic.save(); orderId = o.id; }
        // 付费入账一律走 grantPurchase（试用换卡/按天叠加/永久不可叠加＋作废按天，口径一处）
        if (body.source === 'paid') {
          const g = lic.grantPurchase(username, plan, body.source, Date.now(), { actor: auth.user, orderId });
          if (g.alreadyPermanent) return sendJson(res, 400, { ok: false, code: 'ALREADY_PERMANENT', msg: '该账号已持有永久套餐，不可重复发放/购买永久档。' });
          const rec2 = g.key;
          log({ ev: 'license-issue', target: username, plan, source: body.source, keyId: rec2.id });
          return sendJson(res, 200, { ok: true, msg: '密钥已发放到 ' + username + '（' + rec2.planName + '，来源：付费购买入账）。', keyId: rec2.id, maskedKey: licMaskKey(rec2.str) });
        }
        const rec = lic.issueKey(username, plan, body.source, Date.now(), { actor: auth.user, orderId });
        log({ ev: 'license-issue', target: username, plan, source: body.source, keyId: rec.id });
        return sendJson(res, 200, { ok: true, msg: '密钥已发放到 ' + username + '（' + rec.planName + '，来源：' + (body.source === 'paid' ? '付费购买入账' : (body.source === 'points' ? '积分兑换' : '免费发放')) + '）。', keyId: rec.id, maskedKey: licMaskKey(rec.str) });
      }
      // ===== 许可：站长生成不绑账号钥串（站长 2026-10-26 13:54 令）=====
      // 与「给账号发放」分开：生成钥不绑任何账号，入许可台账为未激活，
      // 首个经 /license/api/redeem 或 transfer/claim 粘贴兑换的账号即归属。
      // 套餐仅四档付费档（试用档不生成）；来源必选、无默认，口径同发钥。
      if (req.method === 'POST' && p === '/admin/api/license/generate') {
        const body = await readJsonBody(req);
        const plan = String(body.plan || '');
        if (!LIC_PLANS[plan] || plan === 'trial') return sendJson(res, 400, { ok: false, code: 'VALIDATION', msg: '套餐不正确：生成密钥仅支持 1 日、7 日、30 日与永久四档。' });
        if (body.source !== 'paid' && body.source !== 'free') return sendJson(res, 400, { ok: false, code: 'SOURCE_REQUIRED', msg: '必须选择密钥来源（付费购买入账 / 免费发放），不设默认。' });
        const rec = lic.generateUnboundKey(plan, body.source, Date.now(), { actor: auth.user });
        log({ ev: 'license-generate', plan, source: body.source, keyId: rec.id, by: auth.user });
        return sendJson(res, 200, { ok: true, msg: '已生成 ' + rec.planName + ' 密钥（来源：' + (body.source === 'paid' ? '付费购买入账' : '免费发放') + '），尚未绑定任何账号。', keyId: rec.id, keyStr: rec.str, planName: rec.planName, source: body.source });
      }
      if (req.method === 'GET' && p === '/admin/api/license/generated') {
        return sendJson(res, 200, { ok: true, records: lic.listGeneratedKeys(30) });
      }
      // 生成钥作废（P6-GK2）：仅未认领的生成钥可作废，已认领/已作废由
      // license-core 侧统一拒绝（NOT_VOIDABLE/ALREADY_VOIDED）。
      if (req.method === 'POST' && p === '/admin/api/license/void-generated') {
        const body = await readJsonBody(req);
        const r = lic.voidGeneratedKey(String(body.keyId || ''), Date.now(), { actor: auth.user });
        if (!r.ok) return sendJson(res, 400, { ok: false, code: r.code, msg: r.msg });
        log({ ev: 'license-generate-void', keyId: r.keyId, by: auth.user });
        return sendJson(res, 200, { ok: true, msg: '该生成密钥已作废，串永不再用。', keyId: r.keyId });
      }
      // 账号密钥收回（P6-GK3，站长 2026-10-26 14:53 令）：「账号列表」
      // 行内「收回密钥」——preview 只读列名下全部密钥供确认框逐把呈现；
      // reclaim 执行收回（license-core reclaimAccountKeys，revokedReason
      // =admin-reclaim，不可恢复、不建封禁、不停服、账号仍可登录）。
      // 护栏与 /admin/api 账号操作链同款（存在性＋adminGuardCheck）。
      if (req.method === 'POST' && p === '/admin/api/license/reclaim-preview') {
        const body = await readJsonBody(req);
        const username = String(body.username || '').trim().toLowerCase();
        if (!ACCOUNT_RE.test(username)) return sendJson(res, 400, { ok: false, msg: '账号格式不正确，请检查后重试。' });
        const docs = loadDb();
        const user = findDbUser(docs, username);
        if (!user) return sendJson(res, 404, { ok: false, msg: '账号不存在：' + username });
        const guard = adminGuardCheck(user, username);
        if (guard) return sendJson(res, 400, { ok: false, msg: guard });
        const now = Date.now();
        lic.lazyExpireKeys(username, now); // 与收回本体同口径先落到期，reclaimable 判定才与在效一致（门二 #3 整改）
        lic.expireDeadPausedKeys(username, now); // 暂停态死钥同批落账（门二复核 S1 整改）
        const statusText = { unactivated: '未激活', activated: '已激活', expired: '已过期', revoked: '已收回' };
        const slotPc = (k) => (k.slots && Array.isArray(k.slots.pc) ? k.slots.pc.filter(Boolean).length : (k.slots && k.slots.pc ? 1 : 0));
        const raw = lic.accountKeys(username).slice().sort((a, b) => {
          const la = (a.lifecycle === 'unactivated' || a.lifecycle === 'activated') ? 0 : 1;
          const lb = (b.lifecycle === 'unactivated' || b.lifecycle === 'activated') ? 0 : 1;
          return la - lb || (b.createdAt - a.createdAt);
        });
        const keys = raw.map((k) => ({
          keyId: k.id, masked: licMaskKey(k.str), plan: k.plan, planName: k.planName,
          source: k.source, sourceNote: k.sourceNote || null, lifecycle: k.lifecycle, statusText: statusText[k.lifecycle] || k.lifecycle,
          expiresMs: k.expiresBaseMs ? lic.effectiveExpiry(k, now) : null,
          remainText: lic.remainTextForKey(k, now),
          slots: { pc: slotPc(k), mobile: k.slots && k.slots.mobile ? 1 : 0 },
          reclaimable: k.lifecycle === 'unactivated' || k.lifecycle === 'activated',
        }));
        return sendJson(res, 200, { ok: true, username, liveCount: keys.filter((k) => k.reclaimable).length, keys });
      }
      if (req.method === 'POST' && p === '/admin/api/license/reclaim') {
        const body = await readJsonBody(req);
        const username = String(body.username || '').trim().toLowerCase();
        if (!ACCOUNT_RE.test(username)) return sendJson(res, 400, { ok: false, msg: '账号格式不正确，请检查后重试。' });
        const docs = loadDb();
        const user = findDbUser(docs, username);
        if (!user) return sendJson(res, 404, { ok: false, msg: '账号不存在：' + username });
        const guard = adminGuardCheck(user, username);
        if (guard) return sendJson(res, 400, { ok: false, msg: guard });
        const r = lic.reclaimAccountKeys(username, Date.now(), { actor: auth.user });
        if (!r.ok) return sendJson(res, 400, { ok: false, code: r.code, msg: r.msg });
        log({ ev: 'admin-reclaim-keys', target: username, keyIds: r.reclaimed.map((x) => x.keyId), by: auth.user });
        // 回执带释放名额数：与台账 key-admin-reclaimed 的 releasedSlots 同源
        // （同为逐钥 releasedSlots 之和，C-05 口径），站长在回执即可核对。
        const relTot = r.reclaimed.reduce((a, x) => ({ pc: a.pc + ((x.releasedSlots && x.releasedSlots.pc) || 0), mobile: a.mobile + ((x.releasedSlots && x.releasedSlots.mobile) || 0) }), { pc: 0, mobile: 0 });
        return sendJson(res, 200, { ok: true, msg: '已收回「' + username + '」名下的 ' + r.reclaimed.length + ' 把密钥，立即失效，账号回到未激活状态。释放设备名额：电脑 ' + relTot.pc + ' · 手机 ' + relTot.mobile + '。', reclaimed: r.reclaimed });
      }
      if (req.method === 'POST' && p === '/admin/api/license/review-decide') {
        const body = await readJsonBody(req);
        // #38：站长改判（override:true）——已裁定的设备异常记录可反向改判，
        // 联动同步执行（改判违规→锁定账号；改判不成立→解封并恢复密钥）。
        if (body.override === true) {
          const out = lic.overrideDeviceReview(String(body.reviewId || ''), String(body.decision || ''), 'owner', Date.now());
          if (out.ok && out.violation) { for (const t of out.accounts || []) await licLockAccount(t); }
          if (out.ok && out.dismissed) { for (const t of out.accounts || []) await licUnlockAccount(t); }
          log({ ev: 'admin-review-override', reviewId: body.reviewId, decision: body.decision, ok: !!out.ok });
          return sendJson(res, out.ok ? 200 : 409, out);
        }
        const out = lic.decideDeviceReview(String(body.reviewId || ''), String(body.decision || ''), 'owner', Date.now());
        if (out.ok && out.violation) { for (const t of out.accounts || []) await licLockAccount(t); }
        return sendJson(res, out.ok ? 200 : 409, out);
      }
      // #38 解封缺口补齐：站长可对台账内任意一条生效中的封禁直接解封
      // （此前 B7/B9/B6/B10 封禁只能等申诉裁决解除）。恢复密钥口径与申诉
      // 通过一致（liftBan 只恢复与该封禁绑定的回收密钥）。
      if (req.method === 'POST' && p === '/admin/api/license/unban') {
        const body = await readJsonBody(req);
        const ban = lic.getBan(String(body.banId || ''));
        if (!ban) return sendJson(res, 404, { ok: false, code: 'NOT_FOUND', msg: '封禁记录不存在。' });
        if (ban.status !== 'active') return sendJson(res, 409, { ok: false, code: 'BAD_STATE', msg: '该封禁当前不是生效状态，无需解封。' });
        // DS-R28：lift 前快照（含本条）：同账号有 B1 生效时，解封后联动
        // 清 loginshim 本地冻结；仅 B9 等其余封禁不触发（防误清）。
        let hadLoginFreezeBan = false;
        if (ban.targetType === 'account') {
          hadLoginFreezeBan = lic.activeBansFor(ban.target, Date.now()).some((b) => String(b.code || '').toUpperCase() === 'B1');
        }
        lic.liftBan(ban, Date.now(), { by: auth.user, restoreKeys: true });
        let extraLifted = [];
        let unlock = null;
        let freezeClear = null;
        if (ban.targetType === 'account') {
          extraLifted = liftAllActiveBans(ban.target, auth.user);
          if (hadLoginFreezeBan) freezeClear = await clearLoginFreeze(ban.target);
          unlock = await licUnlockAccount(ban.target);
        }
        log({ ev: 'admin-unban', banId: ban.id, target: ban.target, by: auth.user, extraLifted, unlock: unlock && unlock.state, loginFreezeCleared: !!(freezeClear && freezeClear.ok) });
        let msg = '已解封：' + ban.target + '，共解除 ' + (1 + extraLifted.length) + ' 条生效中的封禁（关联回收密钥已按规恢复）。';
        if (unlock && unlock.state === 'failed') msg += '注意：账号解锁未成功（' + (unlock.detail || '原因未明') + '），请稍后重试解封。';
        else if (unlock && unlock.state === 'still-banned') msg += '注意：该账号仍有其他生效中的封禁，尚未完全解封。';
        if (hadLoginFreezeBan) msg += loginFreezeReceiptNote(freezeClear);
        return sendJson(res, 200, { ok: true, msg });
      }
      // 账号列表「解封账号」（与「封禁」同排）：按账号一次全清——解掉该
      // 账号全部生效中的封禁（永久含恢复被回收密钥）＋联动解锁＋台账
      // 残留写回，回执明写实际解除条数（2026-10-26 站长亲令：解封须
      // 与封禁同排同位，被封账号在列表里必须有可用解封入口）。
      if (req.method === 'POST' && p === '/admin/api/license/unban-account') {
        const body = await readJsonBody(req);
        const username = String(body.username || '').trim().toLowerCase();
        if (!ACCOUNT_RE.test(username)) return sendJson(res, 400, { ok: false, code: 'VALIDATION', msg: '账号格式不正确，请检查后重试。' });
        const docs = loadDb();
        const user = findDbUser(docs, username);
        const bansBefore = lic.activeBansFor(username, Date.now());
        const before = bansBefore.length;
        // DS-R28：解封前快照，只认 B1 为登录页冻结联动触发条件。
        const hadLoginFreezeBan = bansBefore.some((b) => String(b.code || '').toUpperCase() === 'B1');
        if (!user) {
          // 台账独有行（账号库已无此人、许可/账号台账仍有记录）：许可层
          // 全清＋残留写回仍可办，不让列表行的解封钮点出 404 死钮。
          if (before > 0) {
            const liftedG = liftAllActiveBans(username, auth.user);
            let freezeClearG = null;
            if (hadLoginFreezeBan) freezeClearG = await clearLoginFreeze(username);
            const residueG = clearLedgerResidue(username, 'ext-lic-unlock');
            const remainingG = lic.activeBansFor(username, Date.now()).length;
            log({ ev: 'admin-unban-account', target: username, by: auth.user, lifted: liftedG, ghost: true, ledgerCleared: residueG, loginFreezeCleared: !!(freezeClearG && freezeClearG.ok) });
            let msgG = '已解封：' + username + '，共解除 ' + liftedG.length + ' 条生效中的封禁（关联回收密钥已按规恢复；该账号已不在账号库，仅清许可台账与残留标记）。';
            if (remainingG > 0) msgG += '注意：仍有 ' + remainingG + ' 条封禁未解除，请重试。';
            if (hadLoginFreezeBan) msgG += loginFreezeReceiptNote(freezeClearG);
            return sendJson(res, 200, { ok: true, liftedCount: liftedG.length, msg: msgG });
          }
          const residueErr = {};
          if (clearLedgerResidue(username, 'ext-lic-unlock', residueErr)) return sendJson(res, 200, { ok: true, liftedCount: 0, msg: '已清除「' + username + '」的台账残留标记（该账号已不在账号库，没有生效中的封禁）。' });
          // DS-R21：清除失败（写盘异常）如实回 500，不许伪装成 404。
          if (residueErr.failed) {
            const why = { ENOSPC: '磁盘空间不足', EACCES: '台账文件权限不足', EPERM: '台账文件权限不足', ENOENT: '台账文件不存在', ENOTDIR: '台账路径异常' }[residueErr.err] || '写盘异常';
            return sendJson(res, 500, { ok: false, code: 'LEDGER_CLEAR_FAILED', msg: '台账残留清除失败（' + why + '），请稍后重试：' + username });
          }
          return sendJson(res, 404, { ok: false, code: 'NOT_FOUND', msg: '账号不存在：' + username });
        }
        const guard = adminGuardCheck(user, username);
        if (guard) return sendJson(res, 400, { ok: false, msg: guard });
        const lifted = liftAllActiveBans(username, auth.user);
        let freezeClear = null;
        if (hadLoginFreezeBan) freezeClear = await clearLoginFreeze(username);
        const unlock = await licUnlockAccount(username);
        const remaining = lic.activeBansFor(username, Date.now()).length;
        log({ ev: 'admin-unban-account', target: username, by: auth.user, lifted, unlock: unlock && unlock.state, ledgerCleared: !!(unlock && unlock.ledgerCleared), loginFreezeCleared: !!(freezeClear && freezeClear.ok) });
        if (!lifted.length && before === 0 && !(unlock && unlock.state === 'unlocked')) {
          // 解锁真失败（如账号仍被 bit 锁定且解锁通道失败）必须如实报
          // 失败，不许落进「没有封禁」的安慰回执把失败盖住。
          if (unlock && unlock.state === 'failed') return sendJson(res, 400, { ok: false, liftedCount: 0, msg: '账号解锁未成功（' + (unlock.detail || '原因未明') + '），请稍后重试解封：' + username });
          // 「本来就没有」与「清了残留」分开回执，不拿前者盖住后者。
          if (unlock && unlock.ledgerCleared) return sendJson(res, 200, { ok: true, liftedCount: 0, msg: '已清除「' + username + '」的台账残留标记（该账号当前没有生效中的封禁）。' });
          return sendJson(res, 200, { ok: true, liftedCount: 0, msg: '该账号当前没有生效中的封禁：' + username });
        }
        // 如实回执（DS-R21）：解除数、剩余数、解锁状态三项独立成句——
        // 「仍有封禁未解除」与「解锁未成功」可以并存，两条警告不许互
        // 吞（原 else if 在 remaining>0 时把解锁失败整条丢弃）；before
        // >0 却一条未解时禁止「没有生效中的封禁记录」的假文案（与事
        // 实相反），改如实报未完成。
        let msg;
        if (lifted.length) {
          msg = '已解封：' + username + '，共解除 ' + lifted.length + ' 条生效中的封禁（关联回收密钥已按规恢复）。';
        } else if (before > 0) {
          msg = '解封未完成：' + username + '，本次未解除任何封禁（操作前有 ' + before + ' 条生效中的封禁）。';
        } else {
          msg = '已解封：' + username + '（该账号没有生效中的封禁记录）。';
        }
        if (remaining > 0) msg += '注意：仍有 ' + remaining + ' 条封禁未解除，请重试。';
        if (unlock && unlock.state === 'failed') msg += '注意：账号解锁未成功（' + (unlock.detail || '原因未明') + '），请稍后重试解封。';
        else if (unlock && unlock.state === 'still-banned') msg += '注意：该账号仍有其他生效中的封禁，尚未完全解封。';
        if (hadLoginFreezeBan) msg += loginFreezeReceiptNote(freezeClear);
        return sendJson(res, 200, { ok: true, liftedCount: lifted.length, msg });
      }
      if (req.method === 'GET' && p === '/admin/api/license/overview') {
        const st = lic.state();
        const banActiveByTarget = {};
        for (const b of st.bans) { if (b.status === 'active') { const tk = b.targetType + '|' + b.target; banActiveByTarget[tk] = (banActiveByTarget[tk] || 0) + 1; } }
        return sendJson(res, 200, { ok: true, config: lic.readConfig(), keys: Object.values(st.keys).map((k) => ({ id: k.id, username: k.username, unbound: !!k.unbound, planName: k.planName, source: k.source, sourceNote: k.sourceNote || null, masked: licMaskKey(k.str), lifecycle: k.lifecycle, link: k.link, timing: k.timing, everBanned: !!k.everBanned, transferredOnce: !!k.transferredOnce })), bans: st.bans, banActiveByTarget, orders: Object.values(st.orders).slice(-30), deviceReviews: (st.deviceReviews || []).slice(-20) });
      }
      // ===== 截图付款订单审核（#21：站长侧含二审到账核对；一审亦可在此处理） =====
      if (req.method === 'GET' && p === '/admin/api/orders') {
        return sendJson(res, 200, { ok: true, orders: payOrders.listRecent(80), enabled: payOrders.enabled() });
      }
      if (req.method === 'POST' && p === '/admin/api/orders/decide') {
        const body = await readJsonBody(req);
        const o = payOrders.getRaw(String(body.orderId || ''));
        if (!o) return sendJson(res, 404, { ok: false, code: 'NOT_FOUND', msg: '订单不存在。' });
        const decision = String(body.decision || '');
        // 阶段守卫（2026-11-13 实测：本站此前不传 expectStage，重复点「一审
        // 通过」会走到 stage=2 分支直接二审结案，绕过到账核对。现强制要求
        // 调用方声明所见阶段，与订单当前阶段不一致即 409 零变更拒绝）。
        const wantStage = Number(body.stage);
        if (wantStage !== 1 && wantStage !== 2) return sendJson(res, 400, { ok: false, code: 'VALIDATION', msg: '缺少订单阶段参数，请刷新页面重试。' });
        const out = payOrders.decide(o.id, decision, '站长', Date.now(), { expectStage: wantStage });
        if (out.ok) {
          if (out.stage === 1) reviewEvents.resolve('order', o.id, '站长', 'review1-' + decision);
          if (out.fake) { await licLockAccount(o.username); }
        }
        log({ ev: 'admin-order-decide', orderId: o.id, decision, ok: !!out.ok });
        return sendJson(res, out.ok ? 200 : 409, out);
      }
      // #38 站长改判重审：未发钥、未经二审的驳回订单可放回一审队列重审
      if (req.method === 'POST' && p === '/admin/api/orders/reopen') {
        const body = await readJsonBody(req);
        const out = payOrders.reopenForOwner(String(body.orderId || ''), '站长', Date.now());
        if (out.ok) reviewEvents.enqueue('order', String(body.orderId || ''), { reopened: true });
        log({ ev: 'admin-order-reopen', orderId: body.orderId, ok: !!out.ok });
        return sendJson(res, out.ok ? 200 : 409, out);
      }
      const adminShotM = p.match(/^\/admin\/api\/orders\/([^/]+)\/screenshot$/);
      if (req.method === 'GET' && adminShotM) {
        const o = payOrders.getRaw(decodeURIComponent(adminShotM[1]));
        const fp = o ? payOrders.shotPath(o) : null;
        if (!o || !fp || !fs.existsSync(fp)) return sendJson(res, 404, { ok: false, code: 'NOT_FOUND' });
        const buf = fs.readFileSync(fp);
        res.writeHead(200, { 'Content-Type': o.shotType || 'image/jpeg', 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
        return res.end(buf);
      }
      // ===== 站长 API 管理（#22/#31：令牌＋事件计数＋已处理日志） =====
      if (req.method === 'GET' && p === '/admin/api/assistant') {
        return sendJson(res, 200, { ok: true, token: reviewEvents.tokenStatus(), counts: reviewEvents.counts(), recentDone: reviewEvents.recentDone(20) });
      }
      if (req.method === 'POST' && p === '/admin/api/assistant/token') {
        const body = await readJsonBody(req);
        const action = String(body.action || '');
        const roleRaw = body.role == null ? 'assistant' : String(body.role).trim();
        if (roleRaw !== 'assistant' && roleRaw !== 'owner') return sendJson(res, 400, { ok: false, code: 'VALIDATION', msg: 'role 参数不合法。' });
        const tokRole = roleRaw; // DS-R26 P3-1：role 白名单化，非法值显式拒绝、不再静默落 assistant
        if (action === 'generate' || action === 'reset') { const out = tokRole === 'owner' ? reviewEvents.generateOwnerToken() : reviewEvents.generateToken(); log({ ev: 'admin-api-token', action, role: tokRole }); return sendJson(res, 200, out); }
        if (action === 'revoke') { const out = tokRole === 'owner' ? reviewEvents.revokeOwnerToken() : reviewEvents.revokeToken(); log({ ev: 'admin-api-token', action, role: tokRole }); return sendJson(res, 200, out); }
        return sendJson(res, 400, { ok: false, code: 'VALIDATION', msg: 'action 须为 generate / reset / revoke。' });
      }
      if (req.method === 'POST' && (p === '/admin/api/appeals/approve' || p === '/admin/api/appeals/reject')) {
        const body = await readJsonBody(req);
        const username = String(body.username || '').trim();
        if (!ACCOUNT_RE.test(username)) return sendJson(res, 400, { ok: false, msg: '账号格式不正确，请检查后重试。' });
        const isApprove = p.endsWith('/approve');
        // 统一申诉（带 banId/reasonCode）：走许可台账裁决（防双判），不走 B1 改密闭环
        if (body.appealId) {
          const out = await decideAppeal(String(body.appealId), isApprove ? String(body.decision || 'approve') : 'reject', String(body.reason || ''), 'owner', body);
          return sendJson(res, out.ok ? 200 : 409, out);
        }
        let args;
        if (isApprove) args = [APPEAL_ADMIN, 'approve', username];
        else {
          const reason = String(body.reason || '').trim();
          if (!reason) return sendJson(res, 400, { ok: false, msg: '驳回申诉须写明原因。' });
          args = [APPEAL_ADMIN, 'reject', username, reason.slice(0, 500)];
        }
        const r = await runCmd('node', args, 30000);
        if (r.code === 0) {
          let note = isApprove ? '申诉已通过，对方可设置新密码。' : '申诉已驳回。';
          try { const j = JSON.parse(lastLine(r.stdout)); if (j && j.note) note = j.note; } catch (e) {}
          log({ ev: 'appeal-decision', action: isApprove ? 'approve' : 'reject', target: username, ok: true });
          return sendJson(res, 200, { ok: true, msg: note });
        }
        const msg = lastLine(r.stderr) || '处理未成功，请稍后再试。';
        log({ ev: 'appeal-decision', action: isApprove ? 'approve' : 'reject', target: username, ok: false, code: r.code });
        return sendJson(res, 200, { ok: false, msg });
      }
      if (req.method === 'POST' && ['/admin/api/freeze', '/admin/api/unfreeze', '/admin/api/ban', '/admin/api/resetpass', '/admin/api/rename'].includes(p)) {
        const body = await readJsonBody(req);
        const username = String(body.username || '').trim();
        if (!ACCOUNT_RE.test(username)) return sendJson(res, 400, { ok: false, msg: '账号格式不正确，请检查后重试。' });
        const action = p.replace('/admin/api/', '');
        if (action === 'rename') {
          const newName = String(body.newName || '').trim();
          if (!ACCOUNT_RE.test(newName)) return sendJson(res, 400, { ok: false, msg: '新账号名格式不正确，请检查后重试。' });
          const docs = loadDb();
          const user = findDbUser(docs, username);
          if (!user) return sendJson(res, 404, { ok: false, msg: '账号不存在：' + username });
          const guard = adminGuardCheck(user, username); // #38：站长后台口径
          if (guard) return sendJson(res, 400, { ok: false, msg: guard });
          const out = await enqueueOp(() => runRenameOp(username.toLowerCase(), newName.toLowerCase()));
          return sendJson(res, out.ok ? 200 : 400, out);
        }
        // 预检（不进停服窗）：账号存在性 + 护栏 + 幂等状态。#38：站长后台
        // 用 adminGuardCheck（仅服务账号拒绝），自动联动仍用 guardCheck。
        const docs = loadDb();
        const user = findDbUser(docs, username);
        if (!user) return sendJson(res, 404, { ok: false, msg: '账号不存在：' + username });
        const guard = adminGuardCheck(user, username);
        if (guard) return sendJson(res, 400, { ok: false, msg: guard });
        // 冻结态口径：全权账号 siteadmin 全位为 1、按 bit 判读恒为已冻
        // 结（P5-007：冻结预检误判空转、B8 永不落账），改读
        // qf-account-ledger 的 frozen 标记；普通账号读锁定 bit。
        const ledEntry = (loadLedger().accounts || {})[username.toLowerCase()];
        const isFrozen = (user.siteadmin || 0) === SITEADMIN_FULL
          ? !!(ledEntry && ledEntry.frozen === true)
          : (((user.siteadmin || 0) & SITEADMIN_LOCKED_BIT) !== 0);
        if (action === 'freeze' && isFrozen) return sendJson(res, 200, { ok: true, msg: '账号已是冻结状态，未重复操作：' + username });
        // 解冻放行条件：冻结态在位，或许可台账有生效封禁（B1 等许可-only
        // 封禁不置 MC bit，旧预检会误判「未冻结」把解封挡在门外）。
        if (action === 'unfreeze' && !isFrozen && lic.activeBansFor(username.toLowerCase(), Date.now()).length === 0) return sendJson(res, 200, { ok: true, msg: '账号未冻结，未操作：' + username });
        // 【C-2 重点变更】B9 人工封号改「封禁」（#30 用词定版，原内部称谓「封存」）：不再删号。封禁＝mcdb 冻结（禁用）
        // ＋统一台账永久封禁（B9，数据保留、可申诉）；旧 mcdb ban（删除）下线。
        if (action === 'ban' && lic.activeBansFor(username.toLowerCase(), Date.now()).some((b) => b.code === 'B9' && b.permanent)) {
          return sendJson(res, 200, { ok: true, msg: '账号已是封禁状态，未重复操作：' + username });
        }
        if (action === 'ban') {
          const out2 = await setLockBit(username.toLowerCase(), true, { adminOverride: true });
          if (!out2.ok) return sendJson(res, 400, out2);
          lic.applyBan({ targetType: 'account', target: username.toLowerCase(), code: 'B9', permanent: true, actor: auth.user, evidence: 'admin-seal' }, Date.now());
          const enf = await executeBanEnforcement(username, 'admin-seal', { skipMc: true }); // DEV-18/G-07：setLockBit 已置位＋关会话，再跑 ③ 只会制造清位窗口（§1.5 已驳回同型）
          log({ ev: 'admin-seal', target: username, enforce: enf });
          let sealMsg = '已封禁：' + username + '（禁用＋数据保留＋可申诉，未删除）';
          const mcConfirmed = enf && enf.mc && (enf.mc.ok || enf.mc.exempt);
          if (!mcConfirmed) sealMsg += '（注意：MeshCentral 会话关闭未确认，详见服务日志）';
          return sendJson(res, 200, { ok: true, msg: sealMsg, probeBefore: out2.probeBefore, probeAfter: out2.probeAfter, enforce: enf });
        }
        // DS-R28：解冻前快照，仅在确有 B1 生效时于解冻成功后联动清冻结。
        let unfreezeHadLoginFreezeBan = false;
        if (action === 'unfreeze') {
          unfreezeHadLoginFreezeBan = lic.activeBansFor(username.toLowerCase(), Date.now()).some((b) => String(b.code || '').toUpperCase() === 'B1');
        }
        const out = action === 'resetpass'
          ? await enqueueOp(() => runMcdbOp('resetpass', username.toLowerCase(), { adminOverride: true }))
          : await setLockBit(username.toLowerCase(), action === 'freeze', { adminOverride: true });
        if (out.ok && action === 'freeze') {
          lic.applyBan({ targetType: 'account', target: username.toLowerCase(), code: 'B8', permanent: false, endsAt: null, actor: auth.user, evidence: 'admin-freeze' }, Date.now());
          // 冻结不扩大口径：只补 MC 侧关闭，不清 ext/friends/forum 会话（DS 稿自相矛盾 3 修正）
          try { await executeBanEnforcement(username, 'admin-freeze', { mcOnly: true }); }
          catch (e) { log({ ev: 'ban-enforce-error', target: username, source: 'admin-freeze', err: String(e && e.message) }); }
          // 成功回执必须明写账号（2026-10-26 站长亲报：点了封禁/冻结没
          // 有成功反馈、无从确认是否生效）；out 其余字段（mcdb 探针
          // 等）原样保留，只覆写 msg。
          return sendJson(res, 200, Object.assign({}, out, { ok: true, msg: '已冻结：' + username + (out.via === 'live' ? '（在线即时生效）' : '') + '。', via: out.via }));
        }
        let unfreezeLifted = [];
        if (out.ok && action === 'unfreeze') {
          unfreezeLifted = liftAllActiveBans(username.toLowerCase(), auth.user);
        }
        let unfreezeFreezeMsg = '';
        if (out.ok && action === 'unfreeze' && unfreezeHadLoginFreezeBan) {
          unfreezeFreezeMsg = loginFreezeReceiptNote(await clearLoginFreeze(username.toLowerCase()));
        }
        if (out.ok && action === 'unfreeze' && unfreezeLifted.length) {
          const remainingU = lic.activeBansFor(username.toLowerCase(), Date.now()).length;
          return sendJson(res, 200, Object.assign({}, out, { msg: (remainingU > 0
            ? '已解冻：' + username + '，并解除 ' + unfreezeLifted.length + ' 条生效中的封禁；注意：仍有 ' + remainingU + ' 条封禁未解除，请重试。'
            : '已解冻：' + username + '，并解除 ' + unfreezeLifted.length + ' 条生效中的封禁（含永久封禁），账号恢复正常。') + unfreezeFreezeMsg }));
        }
        if (out.ok && action === 'unfreeze') {
          return sendJson(res, 200, Object.assign({}, out, { msg: '已解冻：' + username + '。' + unfreezeFreezeMsg }));
        }
        return sendJson(res, out.ok ? 200 : 400, out);
      }
      // ===== 统一档案站长面（2.3.2）：重置昵称/头像、资料申诉裁定、驳回快照 =====
      if (req.method === 'POST' && p === '/admin/api/profile-reset') {
        if (!profileCore) return sendJson(res, 500, { ok: false, msg: '个人资料功能模块未加载。' });
        const body = await readJsonBody(req);
        const username = String(body.username || '').trim().toLowerCase();
        if (!ACCOUNT_RE.test(username)) return sendJson(res, 400, { ok: false, msg: '账号格式不正确，请检查后重试。' });
        if (!body.resetNickname && !body.resetAvatar) return sendJson(res, 400, { ok: false, msg: '未选择要重置的内容。' });
        profileCore.adminReset(username, { resetNickname: !!body.resetNickname, resetAvatar: !!body.resetAvatar }, Date.now());
        log({ ev: 'admin-profile-reset', target: username, by: auth.user, resetNickname: !!body.resetNickname, resetAvatar: !!body.resetAvatar });
        const parts = []; if (body.resetNickname) parts.push('昵称'); if (body.resetAvatar) parts.push('头像');
        return sendJson(res, 200, { ok: true, msg: '已重置' + parts.join('与') + '：' + username });
      }
      if (req.method === 'GET' && p === '/admin/api/profile-appeals') {
        if (!profileCore) return sendJson(res, 500, { ok: false, msg: '个人资料功能模块未加载。' });
        return sendJson(res, 200, { ok: true, appeals: profileCore.pendingAppeals(50) });
      }
      if (req.method === 'POST' && p === '/admin/api/profile-appeals/decide') {
        if (!profileCore) return sendJson(res, 500, { ok: false, msg: '个人资料功能模块未加载。' });
        const body = await readJsonBody(req);
        const out = profileCore.decideAppeal(String(body.id || ''), String(body.action || ''), String(body.reason || ''), 'owner', Date.now());
        return sendJson(res, out.status, out.json);
      }
      const admSnapM = p.match(/^\/admin\/api\/profile-mod\/([^/]+)\/snapshot$/);
      if (req.method === 'GET' && admSnapM) {
        const admSnapId = decSeg(admSnapM[1]);
        const snap = (profileCore && admSnapId !== null) ? profileCore.getSnapshot(admSnapId) : null;
        if (!snap) return sendJson(res, 404, { ok: false, code: 'NOT_FOUND' });
        res.writeHead(200, { 'Content-Type': snap.mime, 'Content-Length': snap.bytes.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        return res.end(snap.bytes);
      }
      return sendJson(res, 404, { ok: false, msg: '该接口不存在。' });
    }

    // ===== LEA 本地代理 API（Stage 1 MVP，DESIGN.md §8.1）：只加路由注册行，不改既有逻辑 =====
    if (p.startsWith('/api/lea/v1/')) {
      if (!leaRoutes) return sendJson(res, 503, { ok: false, code: 'LEA_UNAVAILABLE', msg: 'LEA 服务端模块未加载。' });
      await leaRoutes.handle(req, res);
      return;
    }

    return sendJson(res, 404, { ok: false, msg: '该页面不存在。' });
  } catch (e) {
    log({ ev: 'handler-error', err: String(e && e.message) });
    try { sendJson(res, 500, { ok: false, msg: '服务器暂时出现问题，请稍后再试。' }); } catch (e2) {}
  }
});

// 封禁保留期清除任务（16:53 裁决）：B9/永封封禁满 1 年、无在审申诉 → 数据清除
// （mcdb ban 删除动作仅在此清除路径使用）并回写台账。每 6 小时扫一次。
async function sealPurgeSweep() {
  try {
    let appeals = [];
    try { appeals = JSON.parse(fs.readFileSync(APPEALS_FILE, 'utf8')).appeals || []; } catch (e) {}
    const pendingFor = (u) => appeals.some((a) => a && a.status === 'pending' && String(a.key || a.username || '').toLowerCase() === u);
    const expired = lic.sealedExpired(Date.now(), pendingFor);
    for (const ban of expired) {
      const cfg = lic.readConfig();
      if (cfg.shadow && !cfg.testUsers.includes(ban.target)) { log({ ev: 'seal-purge-shadow-skip', target: ban.target }); continue; }
      const out = await enqueueOp(() => runMcdbOp('ban', ban.target));
      if (out.ok) { lic.markPurged(ban, Date.now()); log({ ev: 'seal-purged', target: ban.target, banId: ban.id }); }
      else log({ ev: 'seal-purge-failed', target: ban.target, banId: ban.id });
    }
  } catch (e) { log({ ev: 'seal-purge-error', err: String(e && e.message) }); }
}
if (!process.env.QFEXT_NO_LISTEN) { setInterval(sealPurgeSweep, 6 * 3600000); setTimeout(sealPurgeSweep, 60000); }
// 资料申诉快照字节到期清理（结案 30 天，行保留，2.3.2 §5.4）
function profileSnapshotSweep() { try { if (profileCore) profileCore.cleanupSnapshots(Date.now()); } catch (e) { log({ ev: 'profile-snapshot-sweep-error', err: String(e && e.message) }); } }
if (!process.env.QFEXT_NO_LISTEN) { const _profileSweepT = setInterval(profileSnapshotSweep, 24 * 3600000); if (_profileSweepT && _profileSweepT.unref) _profileSweepT.unref(); setTimeout(profileSnapshotSweep, 120000); }

if (!process.env.QFEXT_NO_LISTEN) {
  server.listen(PORT, BIND, () => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    log({ ev: 'listening', bind: BIND, port: PORT });
    console.log('qfremote-ext listening on ' + BIND + ':' + PORT);
  });
}

// 供本地单测使用（生产路径不依赖）
module.exports = { buildUsersList, guardCheck, adminGuardCheck, decideAppeal, validateConsoleCookie, loadDb, ACCOUNT_RE, validateCache, pruneValidateCache, revokeSingleXid, noteQfclashLogin, qfclashLogins: () => qfclashLogins, revokedXids: () => revokedXids, normalizeNodeId, flattenMeshNodes, resolveDeviceByName, resolvePresence, observeNodesForPresence, presenceObsFor, PRESENCE_FRESH_MS, PRESENCE_STALE_MS, savePointsSoon };
