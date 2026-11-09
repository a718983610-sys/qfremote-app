'use strict';
/*
 * QFRemote 服务地址运行时解析（v2.2.0 新增）
 * ================================================================
 * 背景：论坛/注册等入口地址原先写死在 main.js 里，临时通道一换就成死链。
 * 本模块在启动时拉官网 product.json（正式域名，正经证书）：
 *   { web: { forumUrl, registerUrl, friendsUrl, adminUrl, pointsUrl } }
 * 解析优先级：product.json 最新值 > 上次成功缓存（qf-settings.svcUrls）> 写死兜底。
 * 拉不到一律安静退回缓存/兜底，绝不阻塞启动、绝不弹窗。
 * 只接受 https 地址；不合规的值直接丢弃走下一档。
 * 好友页口径：2.4.2 起 FRIENDS_URL 与本模块兜底同为正式域名聚合路径
 * /friends（旧 IP 直连源已随服务器换 IP 退役）；product.json 的 friendsUrl
 * 仍作运行时备选地址。免密直达已于 2.3.0 在服务端修通（会话绑 IP 的转发
 * 修复，见服务端好友 server.js 注释），壳侧凭控制台会话直达。
 */
const https = require('https');
const clientVersion = require('./client-version');

const PRODUCT_JSON_URL = 'https://qfremote.top/product.json';
// 正式 Web 基座。临时隧道地址不得作为生产兜底。
const PROD_WEB_BASE = 'https://app.qfremote.top';

// W-20：服务地址主机名白名单——只接受 qfremote.top 及其子域的 https 地址。
// product.json 被控或 DNS 劫持到仿冒站时，服务地址不得被指到任意 https 源
// （否则壳内会话 cookie 会被送到攻击者手里）。兜底值本身即白名单内。
function isAllowedSvcHost(v) {
  if (typeof v !== 'string' || !v) return false;
  let host = '';
  try { host = new URL(v).hostname.toLowerCase(); } catch (e) { return false; }
  return host === 'qfremote.top' || host.endsWith('.qfremote.top');
}

function isTrustedSvcUrl(v) {
  return isHttpsUrl(v) && isAllowedSvcHost(v);
}

const FALLBACKS = {
  forumUrl: PROD_WEB_BASE + '/forum',
  registerUrl: PROD_WEB_BASE + '/register',
  friendsUrl: PROD_WEB_BASE + '/friends', // 2.4.2：域名聚合路径（旧 IP 直连兜底退役）
  adminUrl: PROD_WEB_BASE + '/admin',
  pointsUrl: PROD_WEB_BASE + '/points'
};
const KEYS = Object.keys(FALLBACKS);

function isHttpsUrl(v) {
  if (typeof v !== 'string' || !v) return false;
  try { return new URL(v).protocol === 'https:'; } catch (e) { return false; }
}

function stripSlash(v) { return String(v).replace(/\/+$/, ''); }

// 从 product.json 原始对象里挑出合规的 web.* 地址（不合规的键直接丢弃）。
// W-20：只认 https 且主机在白名单内；被拒的地址经 onRejected 回调留痕
// （main.js 接 bootLog('svc-urls.rejected-host')，绝不写完整地址进日志？
// 地址本身即服务地址、无凭据，可记主机名；onRejected 只收主机名）。
function parseProductJson(json, onRejected) {
  const out = {};
  if (!json || typeof json !== 'object' || !json.web || typeof json.web !== 'object') return out;
  for (const k of KEYS) {
    const v = json.web[k];
    if (typeof v === 'string' && v && isHttpsUrl(v) && !isAllowedSvcHost(v)) {
      try { if (onRejected) onRejected(new URL(v).hostname); } catch (e) { /* ignore */ }
      continue;
    }
    if (isTrustedSvcUrl(v)) out[k] = stripSlash(v);
  }
  return out;
}

// 默认拉取实现（官网是正经证书，正常校验；超时 6 秒）
// 2.3.2：带统一版本头（见 client-version.js）；versionSource 可为字符串或函数。
function defaultFetchJson(url, versionSource) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 6000, headers: clientVersion.clientVersionHeaders(versionSource) }, (res) => {
      if (res.statusCode !== 200) { res.resume(); reject(new Error('HTTP ' + res.statusCode)); return; }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (e) { reject(new Error('更新清单格式不正确')); }
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('连接超时')));
    req.on('error', reject);
  });
}

/*
 * createSvcUrls({ fetchJson, loadCache, saveCache })
 *  - fetchJson(url) -> Promise<object>（可注入假实现做单测）
 *  - loadCache() -> object|undefined（读 qf-settings.svcUrls）
 *  - saveCache(obj)（写回 qf-settings.svcUrls，失败忽略）
 */
function createSvcUrls(opts) {
  const o = opts || {};
  // opts.clientVersion：版本头来源（字符串或 () => string），缺省走全局当前版本
  const fetchJson = o.fetchJson || ((url) => defaultFetchJson(url, o.clientVersion));
  const loadCache = o.loadCache || (() => null);
  const saveCache = o.saveCache || (() => {});
  const onRejected = o.onRejected || null;
  let resolved = Object.assign({}, FALLBACKS);
  // 先用缓存垫底（进程刚起来、还没拉到新值时也有上次的好地址可用）。
  // W-20：缓存里的地址也要过白名单，中毒缓存不得复活。
  try {
    const c = loadCache();
    if (c && typeof c === 'object') {
      for (const k of KEYS) if (isTrustedSvcUrl(c[k])) resolved[k] = stripSlash(c[k]);
    }
  } catch (e) { /* ignore */ }

  async function refresh() {
    try {
      const json = await fetchJson(PRODUCT_JSON_URL);
      const fresh = parseProductJson(json, onRejected);
      if (Object.keys(fresh).length) {
        resolved = Object.assign({}, resolved, fresh);
        // W-20：落盘前再校验一次白名单（resolved 含兜底，兜底本身在白名单内）。
        const safe = {};
        for (const k of KEYS) if (isTrustedSvcUrl(resolved[k])) safe[k] = resolved[k];
        try { saveCache(Object.assign({}, safe)); } catch (e) { /* ignore */ }
      }
      return { ok: Object.keys(fresh).length > 0, resolved: Object.assign({}, resolved) };
    } catch (e) {
      return { ok: false, resolved: Object.assign({}, resolved), error: e.message };
    }
  }

  function get(key) { return resolved[key]; }
  function all() { return Object.assign({}, resolved); }
  // 接口地址拼接：pointsUrl/adminUrl 是服务基址，接口在 <基址>/api/<name>
  function pointsApi(name) { return resolved.pointsUrl + '/api/' + String(name).replace(/^\/+/, ''); }
  function adminApi(name) { return resolved.adminUrl + '/api/' + String(name).replace(/^\/+/, ''); }
  function adminLoginUrl(token) {
    return resolved.adminUrl + '/login?token=' + encodeURIComponent(token || '');
  }
  // 论坛接口地址：forumUrl 形如 <通道基址>/forum，接口在其同级 /api/forum/* 下
  function forumApi(name) {
    const base = resolved.forumUrl.replace(/\/forum\/?$/, '');
    return base + '/api/forum/' + String(name).replace(/^\/+/, '');
  }
  function forumSsoLoginUrl(token) {
    return forumApi('sso-login') + '?token=' + encodeURIComponent(token || '');
  }

  // 扩展服务同源收口（2.3.1 阶段 E，与安卓 SvcUrls 同口径）：许可接口、
  // 新首页、购买页、状态查询页、申诉页、智能客服都挂在扩展服务同一源下
  // （经 nginx 同源 /license/*、/purchase、/home 等），与积分同源——取
  // pointsUrl 的 origin，不另设地址来源；pointsUrl 刷新后自动跟随。
  function extOrigin() {
    try { return new URL(resolved.pointsUrl).origin; } catch (e) { return ''; }
  }
  function homeUrl() { return extOrigin() + '/home'; }
  function purchaseUrl() { return extOrigin() + '/purchase'; }
  function licenseStatusUrl() { return extOrigin() + '/license/status'; }
  function rebindUrl() { return extOrigin() + '/license/rebind'; }
  function appealUrl() { return extOrigin() + '/appeal'; }
  function supportUrl() { return extOrigin() + '/support'; }
  // 许可接口基址（/license 前缀下 /api/*；name 可含斜杠，如 transfer/claim）
  function licenseApi(name) { return extOrigin() + '/license/api/' + String(name).replace(/^\/+/, ''); }

  return { refresh, get, all, pointsApi, adminApi, adminLoginUrl, forumApi, forumSsoLoginUrl, extOrigin, homeUrl, purchaseUrl, licenseStatusUrl, rebindUrl, appealUrl, supportUrl, licenseApi };
}

module.exports = { createSvcUrls, parseProductJson, isHttpsUrl, isAllowedSvcHost, isTrustedSvcUrl, PRODUCT_JSON_URL, FALLBACKS };
