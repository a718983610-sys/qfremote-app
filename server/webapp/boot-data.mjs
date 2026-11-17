// boot-data.mjs — W-04 服务端首屏 boot data 注入（补 L4 客户端消费端）。
// 对标 Grafana boot data（pkg/services/frontend/index.go 在首屏下发配置＋用户
// 信息）与 Nextcloud @nextcloud/initial-state：服务端在 index.html 里一次性下发
// 用户/会话快照，客户端 qfApplyBootData()（qf-runtime.js）读 window.__QF_BOOT__
// 播种 QFStore，各页只读 store，不另开并行拉取。
//
// 本文件是纯服务端模块（Node ESM，零依赖），浏览器永不加载它：
//   qfBuildBootData(snapshot)    白名单清洗快照 → 可注入的 boot 对象（或 null）
//   qfBootDataHasSensitive(boot) 注入前自检：敏感键名残留即报出（maskedKey 除外）
//   qfBootDataScript(boot)       安全序列化为内联 <script>（防 </script> 逃逸）
//   qfRenderIndexHtml(html, boot) 把 index.html 的 <!-- QF_BOOT_DATA --> 占位
//                                替换为注入脚本；无 boot 时原样返回
//   createBootDataHandler(opts)  只处理 / 与 /index.html 的渲染处理器
//   createBootServer(opts)       参考实现：静态文件服务＋首屏注入（供测试与部署线参考）
//
// 快照来源（生产接线见 BOOT-DATA.md）：部署线提供 getSnapshot(req)，内部用已鉴权
// 会话取数（resolveAuth → buildHomeStats → buildStatusView），绝不信任客户端
// 传来的快照。本模块只做白名单清洗＋安全序列化，即使上游误传敏感值也不会进页面。
// 敏感值（LEA Key、票据明文、密码、token、session 等）绝不进 boot data。

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const QF_BOOT_VERSION = 1;

// index.html 里的注入占位（静态直出时只是无害注释，客户端走原有流程）。
export const QF_BOOT_PLACEHOLDER = '<!-- QF_BOOT_DATA -->';

// 注入上限：首屏快照只含必需数据，超量截断不报错、不静默膨胀。
export const QF_BOOT_MAX_DEVICES = 500;
export const QF_BOOT_MAX_PRESENCE = 500;

// 敏感键名扫描（注入前自检用）：命中即拒绝注入。maskedKey 是服务端已脱敏的
// 展示字段（buildStatusView 的 maskKey 产物），明确豁免。
export const QF_BOOT_SENSITIVE_KEY_RE =
  /(api[_-]?key|secret|passw|token|ticket|session|cookie|credential|private[_-]?key|auth)/i;

const LICENSE_FIELDS = new Set([
  'planName', 'displayStatus', 'statusNote', 'maskedKey',
  'hasKey', 'webEnabled', 'webBy', 'trialExpiresMs', 'keyExpiresMs',
  'keyPlan', 'keyLifecycle', 'keyDurationHours', 'remainText',
  'slots', 'everBanned', 'activeBan',
]);
const LICENSE_SLOTS_FIELDS = new Set(['pc', 'mobile', 'pcUsed', 'pcMax', 'mobileUsed', 'mobileMax']);
const LICENSE_BAN_FIELDS = new Set(['code', 'permanent', 'endsAt']);
const DEVICE_FIELDS = new Set([
  'id', 'name', 'os', 'group', 'nodeid',
  'online', 'onlineUnknown', 'stale',
  'lastAgentPong', 'lastAgentPongAgeMs', 'agentConnectedAt',
]);

function isPlainObject(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function cleanString(v, max) {
  if (typeof v !== 'string') return undefined;
  const s = v.trim().slice(0, max);
  return s === '' ? undefined : s;
}

function cleanNumber(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function cleanBool(v) {
  return typeof v === 'boolean' ? v : undefined;
}

// 只留白名单字段的浅拷贝（标量字段逐个清洗；嵌套对象走专用清洗）。
function pickFields(src, fields, cleaners) {
  const out = {};
  for (const k of fields) {
    if (!(k in src)) continue;
    const clean = cleaners[k];
    const v = clean ? clean(src[k]) : src[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

function cleanLicense(src) {
  if (!isPlainObject(src)) return undefined;
  const out = pickFields(src, LICENSE_FIELDS, {
    planName: (v) => cleanString(v, 128),
    displayStatus: (v) => cleanString(v, 64),
    statusNote: (v) => cleanString(v, 512),
    maskedKey: (v) => cleanString(v, 64),
    hasKey: cleanBool,
    webEnabled: cleanBool,
    webBy: (v) => (v === 'paid' || v === 'trial' ? v : undefined),
    trialExpiresMs: cleanNumber,
    keyExpiresMs: cleanNumber,
    keyPlan: (v) => cleanString(v, 64),
    keyLifecycle: (v) => cleanString(v, 64),
    keyDurationHours: cleanNumber,
    remainText: (v) => cleanString(v, 128),
    everBanned: cleanBool,
    slots: (v) => {
      if (!isPlainObject(v)) return undefined;
      const s = pickFields(v, LICENSE_SLOTS_FIELDS, {
        pc: cleanNumber, mobile: cleanNumber, pcUsed: cleanNumber,
        pcMax: cleanNumber, mobileUsed: cleanNumber, mobileMax: cleanNumber,
      });
      return Object.keys(s).length ? s : undefined;
    },
    activeBan: (v) => {
      if (!isPlainObject(v)) return undefined;
      const b = pickFields(v, LICENSE_BAN_FIELDS, {
        code: (x) => cleanString(x, 32),
        permanent: cleanBool,
        endsAt: cleanNumber,
      });
      return Object.keys(b).length ? b : undefined;
    },
  });
  return Object.keys(out).length ? out : undefined;
}

function cleanDevice(src) {
  if (!isPlainObject(src)) return undefined;
  const name = cleanString(src.name, 256);
  if (name === undefined) return undefined; // 无名设备首屏无意义，丢弃
  const out = pickFields(src, DEVICE_FIELDS, {
    id: (v) => (typeof v === 'string' ? cleanString(v, 128) : (typeof v === 'number' && Number.isFinite(v) ? v : undefined)),
    name: (v) => cleanString(v, 256),
    os: (v) => cleanString(v, 256),
    group: (v) => cleanString(v, 128),
    nodeid: (v) => cleanString(v, 256),
    online: cleanBool,
    onlineUnknown: cleanBool,
    stale: cleanBool,
    lastAgentPong: cleanNumber,
    lastAgentPongAgeMs: cleanNumber,
    agentConnectedAt: cleanNumber,
  });
  out.name = name;
  return out;
}

// presence 值是“键 → 标量快照”的自由形状（当前无视图逐字段消费，只进
// QFStore.presence 内存态）：只留标量字段，嵌套对象/数组一律丢弃，防夹带。
function cleanPresenceValue(src) {
  if (!isPlainObject(src)) return undefined;
  const out = {};
  for (const k of Object.keys(src).slice(0, 16)) {
    const v = src[k];
    if (typeof v === 'string') { const s = cleanString(v, 256); if (s !== undefined) out[k] = s; }
    else if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'boolean' || v === null) out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

/* 白名单清洗：只输出客户端消费端（qfApplyBootData）逐项读取的字段。
 * 顶层键与消费端一一对应：user / displayName / isAdmin / license / theme /
 * devices / presence，另加 v（格式版本，消费端忽略）。
 * 其余一律丢弃（apiKey、token、票据、密码、session、decision、forceLogout、
 * keyId 等即使上游误传也不会进页面）。无有效内容时返回 null（不注入）。
 * 返回值经 JSON 往返深拷贝，与上游快照对象脱钩。 */
export function qfBuildBootData(snapshot) {
  if (!isPlainObject(snapshot)) return null;
  const boot = { v: QF_BOOT_VERSION };
  const user = cleanString(snapshot.user, 128);
  if (user !== undefined) boot.user = user;
  const displayName = cleanString(snapshot.displayName, 128);
  if (displayName !== undefined) boot.displayName = displayName;
  if (typeof snapshot.isAdmin === 'boolean') boot.isAdmin = snapshot.isAdmin;
  const license = cleanLicense(snapshot.license);
  if (license !== undefined) boot.license = license;
  if (snapshot.theme === 'dark' || snapshot.theme === 'light') boot.theme = snapshot.theme;
  if (Array.isArray(snapshot.devices)) {
    const devices = [];
    for (const d of snapshot.devices.slice(0, QF_BOOT_MAX_DEVICES)) {
      const c = cleanDevice(d);
      if (c !== undefined) devices.push(c);
    }
    if (devices.length) boot.devices = devices;
  }
  if (isPlainObject(snapshot.presence)) {
    const presence = {};
    for (const k of Object.keys(snapshot.presence).slice(0, QF_BOOT_MAX_PRESENCE)) {
      const c = cleanPresenceValue(snapshot.presence[k]);
      if (c !== undefined) presence[k] = c;
    }
    if (Object.keys(presence).length) boot.presence = presence;
  }
  // 至少有一项首屏必需内容（用户、设备、许可）才注入；只有主题不注入。
  if (boot.user === undefined && boot.devices === undefined && boot.license === undefined) return null;
  try { return JSON.parse(JSON.stringify(boot)); } catch { return null; }
}

/* 注入前自检：递归扫键名，命中敏感模式即返回可疑路径（maskedKey 豁免）。
 * 正常白名单产物应返回 []；非空时调用方必须拒绝注入（fail-closed）。 */
export function qfBootDataHasSensitive(boot, prefix) {
  const bad = [];
  const walk = (v, p) => {
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, p + '[' + i + ']')); return; }
    if (!isPlainObject(v)) return;
    for (const k of Object.keys(v)) {
      const kp = p ? p + '.' + k : k;
      if (k !== 'maskedKey' && QF_BOOT_SENSITIVE_KEY_RE.test(k)) bad.push(kp);
      walk(v[k], kp);
    }
  };
  walk(boot, prefix || '');
  return bad;
}

/* 安全序列化：< > & 与 U+2028/2029 全部转义，注入脚本内永不出现字面
 * </script>，displayName 等含 HTML/JS 片段的用户内容也无法逃逸。 */
export function qfBootDataJson(boot) {
  return JSON.stringify(boot)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export function qfBootDataScript(boot) {
  return '<script>window.__QF_BOOT__ = ' + qfBootDataJson(boot) + ';</script>';
}

/* 渲染：有 boot 时把占位注释替换为注入脚本（只换第一处）；模板无占位时
 * 退到 </head> 前插入；再无则插到第一个 <script src 之前；最后才前置。
 * boot 为 null/非法时原样返回模板（字节一致），客户端走原有流程。 */
export function qfRenderIndexHtml(html, boot) {
  if (typeof html !== 'string') return html;
  if (!isPlainObject(boot)) return html;
  const script = qfBootDataScript(boot);
  if (html.includes(QF_BOOT_PLACEHOLDER)) {
    return html.replace(QF_BOOT_PLACEHOLDER, () => script);
  }
  const headClose = html.indexOf('</head>');
  if (headClose >= 0) return html.slice(0, headClose) + script + '\n' + html.slice(headClose);
  const firstScript = html.search(/<script[\s>]/i);
  if (firstScript >= 0) return html.slice(0, firstScript) + script + '\n' + html.slice(firstScript);
  return script + '\n' + html;
}

export function qfIsIndexPath(pathname) {
  return pathname === '/' || pathname === '/index.html';
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
};

/* 首屏渲染处理器：只认 GET/HEAD 的 / 与 /index.html，其余返回 false 交上游。
 * getSnapshot(req) 返回快照对象（可为 Promise）或 null（未登录/无快照）；
 * 快照获取抛错、清洗为空、自检命中敏感键时一律 fail-closed：原样出静态模板，
 * 绝不 500 挡壳、绝不带敏感值出页面。注入页强制 no-store＋Vary: Cookie。 */
export function createBootDataHandler(opts) {
  const o = opts || {};
  const webappDir = o.webappDir || path.dirname(fileURLToPath(import.meta.url));
  const getSnapshot = o.getSnapshot || (async () => null);
  const readTemplate = o.readTemplate || (() => fs.readFileSync(path.join(webappDir, 'index.html'), 'utf8'));
  const onError = typeof o.onError === 'function' ? o.onError : () => {};
  return async function bootDataHandler(req, res) {
    let pathname = '/';
    try { pathname = decodeURIComponent((req.url || '/').split('?')[0]); } catch { pathname = '/'; }
    if (!qfIsIndexPath(pathname)) return false;
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    let template;
    try { template = await readTemplate(); } catch (e) { onError(e); return false; }
    let snapshot = null;
    try { snapshot = await getSnapshot(req); } catch (e) { onError(e); snapshot = null; }
    let body = template;
    if (snapshot) {
      const boot = qfBuildBootData(snapshot);
      if (boot) {
        const bad = qfBootDataHasSensitive(boot);
        if (bad.length) { onError(new Error('boot data 自检命中敏感键：' + bad.join(','))); }
        else body = qfRenderIndexHtml(template, boot);
      }
    }
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      vary: 'Cookie',
    });
    res.end(req.method === 'HEAD' ? '' : body);
    return true;
  };
}

/* 参考实现（供测试与部署线参考）：静态文件服务＋首屏注入。
 * 非 index 路径按静态文件直出（防目录穿越）；index 路径走处理器。 */
export function createBootServer(opts) {
  const o = opts || {};
  const webappDir = o.webappDir || path.dirname(fileURLToPath(import.meta.url));
  const handler = createBootDataHandler(o);
  const server = http.createServer(async (req, res) => {
    try {
      if (await handler(req, res)) return;
    } catch { /* 处理器内已 fail-closed，此处只防未捕获异常漏到连接上 */ }
    let pathname = '/';
    try { pathname = decodeURIComponent((req.url || '/').split('?')[0]); } catch { pathname = '/'; }
    const file = path.join(webappDir, pathname === '/' ? 'index.html' : pathname);
    if (!file.startsWith(webappDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); res.end('not found'); return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    if (req.method === 'HEAD') { res.end(''); return; }
    fs.createReadStream(file).pipe(res);
  });
  return server;
}
