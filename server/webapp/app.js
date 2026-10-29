'use strict';
/* QFRemote 新控制台（影子版）——单页壳同框切换。
   交互口径：《交互规格-QFClash移植.md》六项 + #32 登录落点/单一顶栏 + #34 主菜单次序。
   数据口径：只消费既有服务端接口；购买/订单走 N-1、积分/福利走 N-2（均已上线接真）。 */

/* ---------------- 图标 ---------------- */
const ICONS = {
  home: '<path d="M3 10.5L12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/>',
  monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>',
  users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.9"/><path d="M16 3.1a4 4 0 0 1 0 7.8"/>',
  chat: '<path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5c-1.5 0-3-.4-4.2-1.1L3 20l1.1-5.3A8.5 8.5 0 1 1 21 11.5z"/>',
  forum: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  headset: '<path d="M4 13a8 8 0 0 1 16 0"/><rect x="2" y="13" width="4" height="7" rx="2"/><rect x="18" y="13" width="4" height="7" rx="2"/><path d="M20 19a3 3 0 0 1-3 3h-3"/>',
  key: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="M11 12L21 2"/><path d="M16 7l3 3"/>',
  cart: '<circle cx="9" cy="21" r="1.6"/><circle cx="19" cy="21" r="1.6"/><path d="M2 3h3l2.6 12.5a2 2 0 0 0 2 1.5h8.7a2 2 0 0 0 2-1.6L22 7H6"/>',
  award: '<circle cx="12" cy="9" r="6"/><path d="M8.6 14L7 22l5-3 5 3-1.6-8"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-6.5 8-6.5s8 2.5 8 6.5"/>',
  shield: '<path d="M12 22s8-3.6 8-10V5l-8-3-8 3v7c0 6.4 8 10 8 10z"/><path d="M9 11.5l2 2 4-4.5"/>',
  gear: '<circle cx="12" cy="12" r="3.2"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1"/>',
  folder: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
  bell: '<path d="M18 8a6 6 0 1 0-12 0c0 7-3 8-3 8h18s-3-1-3-8"/><path d="M13.7 20a2 2 0 0 1-3.4 0"/>',
  chevR: '<path d="M9 6l6 6-6 6"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.9-6.6L21 8"/><path d="M21 3v5h-5"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c2.5 2.6 3.9 5.7 3.9 9s-1.4 6.4-3.9 9c-2.5-2.6-3.9-5.7-3.9-9S9.5 5.6 12 3z"/>',
  /* 会话融合视图补图（2.4.0，路径与冻结稿 preview 图标库同源同风格） */
  back: '<path d="M15 5l-7 7 7 7"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3M12 15h5"/>',
  expand: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  power: '<path d="M12 3v8M6.3 6.5a8 8 0 1 0 11.4 0"/>',
  phone: '<rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/>',
  keyboard: '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M6 14h.01M18 14h.01M9 14h6"/>',
  send: '<path d="M21 3L10 14M21 3l-7 18-4-7-7-4z"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  check: '<path d="M4 12.5l5 5L20 6.5"/>',
  mute: '<path d="M4 10v4h3l5 4V6l-5 4H4z"/><path d="M16 9l5 6M21 9l-5 6"/>'
};
const ic = n => `<svg class="ic" viewBox="0 0 24 24">${ICONS[n] || ''}</svg>`;
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = (s, r) => (r || document).querySelector(s);
const fmtDate = ms => { if (!ms) return '—'; const d = new Date(ms); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };

/* ---------------- 提示层（恒在最上层，z=100000） ---------------- */
function toast(msg, type) {
  const box = $('#toasts'); if (!box) return;
  const t = document.createElement('div');
  t.className = 'toast ' + (type || 'info'); t.textContent = msg;
  box.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; setTimeout(() => t.remove(), 320); }, 4200);
}
/* ---------------- 弹窗层（z=90000，低于提示层） ---------------- */
function showModal(title, bodyHtml, buttons) {
  const root = $('#modalRoot');
  root.innerHTML = `<div class="mask"><div class="modal"><h3>${esc(title)}</h3><div class="mbody">${bodyHtml}</div><div class="mops"></div></div></div>`;
  const ops = $('.mops', root);
  (buttons || [{ label: '知道了' }]).forEach(b => {
    const btn = document.createElement('button');
    btn.className = 'btn' + (b.primary ? '' : ' grey'); btn.textContent = b.label;
    btn.onclick = () => { if (b.onClick) b.onClick(); closeModal(); };
    ops.appendChild(btn);
  });
  return root;
}
function closeModal() { $('#modalRoot').innerHTML = ''; }
function confirmModal(title, text, okLabel, onOk) {
  showModal(title, `<p>${esc(text)}</p>`, [{ label: '取消' }, { label: okLabel || '确认', primary: true, onClick: onOk }]);
}

/* ---------------- 接口层：正式失败提示、超时兜底、失败按白名单重试一次 ---------------- */
/* 超时兜底（perf 线定版，与下述白名单融合）：单项默认上限见 API_TIMEOUT_MS，
   AbortController 到点中止并以 timeout 标记返回；调用方显式传 opts.retry 时
   以显式为准（lockApi 等既有调用点口径不改）。 */
/* 网络层自动重试白名单——只有「重复提交不会产生第二次业务效果」的请求才
   允许自动重发：
   · 全部 GET/HEAD：安全方法，服务端仅读；
   · POST /appeal/status：只读查询（服务端契约）；
   · POST /chat/api/vault：按 msgId 幂等（服务端契约：同 msgId 重复提交
     直接返回 {ok:true, dup:true} 不重复落账）；
   · POST /chat/api/read：按会话写 marks[我]=max(原值, uptoSeq)，单调幂等。
   其余一概不自动重发——尤其 POST /appeal：服务端按提交次数计数（永久
   封禁 2 次/其他 3 次），「已落库但响应丢失」时重发会白白消耗一次额度；
   POST /chat/api/send 会重复投递消息，同样不在白名单内。 */
const API_TIMEOUT_MS = 30000;   // 默认单项上限【施工偏差 D1：DS 稿 12000 → 30000；现行本无超时，截图上传等大 POST 弱网可合法超 12s，关键路径另有显式超时（lockApi 表等），抬高默认值只防回归】
const API_RETRY_DELAY_MS = 600; // 与原文案一致的退避间隔
const API_RETRY_SAFE = [
  ['POST', '/appeal/status'],
  ['POST', '/chat/api/vault'],
  ['POST', '/chat/api/read']
];
function apiRetrySafe(method, path) {
  const m = String(method || 'GET').toUpperCase();
  if (m === 'GET' || m === 'HEAD') return true;
  const p = String(path || '').split('?')[0];
  return API_RETRY_SAFE.some(x => x[0] === m && x[1] === p);
}
async function api(path, opts) {
  opts = opts || {};
  const method = (opts.method || 'GET').toUpperCase();
  const timeoutMs = (typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0) ? opts.timeoutMs : API_TIMEOUT_MS;
  // 只对幂等方法自动重试：写操作（启停锁/重置/更新）重试会导致重复投递信封（幂等防呆）
  const retryable = opts.retry !== undefined ? !!opts.retry : apiRetrySafe(method, path);
  const maxAttempts = retryable ? 2 : 1;
  let lastErr = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const init = { credentials: 'include', method, headers: {} };
    if (opts.json !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(opts.json); }
    if (opts.form) { init.headers['Content-Type'] = 'application/x-www-form-urlencoded'; init.body = new URLSearchParams(opts.form).toString(); }
    if (opts.headers) Object.assign(init.headers, opts.headers);
    const ctl = (typeof AbortController === 'function') ? new AbortController() : null;
    let timer = null;
    if (ctl) { init.signal = ctl.signal; timer = setTimeout(() => { try { ctl.abort(); } catch (e) {} }, timeoutMs); }
    try {
      const r = await fetch(path, init);
      const text = await r.text();
      let json = null; try { json = JSON.parse(text); } catch (e) { /* 非 JSON 响应按文本处理 */ }
      return { status: r.status, ok: r.ok, json, text };
    } catch (e) {
      lastErr = (e && e.name === 'AbortError') ? new Error('timeout') : e;
      if (attempt + 1 < maxAttempts) await new Promise(r2 => setTimeout(r2, API_RETRY_DELAY_MS));
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  return { status: 0, ok: false, json: null, text: '', networkError: lastErr, timeout: !!(lastErr && lastErr.message === 'timeout') };
}

function stateBox(title, text, retryFn) {
  return `<div class="card"><div class="statebox"><b>${esc(title)}</b><p>${esc(text)}</p>${retryFn ? '<button class="btn sm" data-retry="1">重新加载</button>' : ''}</div></div>`;
}
function bindRetry(container, fn) { const b = $('[data-retry]', container); if (b) b.onclick = fn; }
function netFail(container, retryFn) {
  container.innerHTML = stateBox('网络暂时不可用', '与服务器的连接出现问题，请检查网络后重新加载。您的登录状态不会因此丢失。', true);
  bindRetry(container, retryFn);
}
function apiErrText(r, fallback) {
  if (r && r.json && (r.json.error || r.json.msg)) return r.json.error || r.json.msg;
  return fallback || '服务暂时不可用，请稍后再试。';
}
function fmtSize(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
  return (n / 1073741824).toFixed(2) + ' GB';
}
/* 问候语按本机时段分段（原写死「下午好」，任何时段打开都错） */
function greetWord() {
  const h = new Date().getHours();
  if (h < 6) return '夜深了';
  if (h < 9) return '早上好';
  if (h < 12) return '上午好';
  if (h < 14) return '中午好';
  if (h < 18) return '下午好';
  return '晚上好';
}
function fmtRemain(expMs) {
  const ms = Number(expMs) - Date.now();
  if (!expMs || ms <= 0) return '已过期';
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return '剩余 ' + Math.max(mins, 1) + ' 分钟';
  const h = Math.floor(mins / 60), m = mins % 60;
  return '剩余 ' + h + ' 小时' + (m ? ' ' + m + ' 分钟' : '');
}

/* ---------------- 屏幕锁（隐私锁）桥：与软件端同一条 8445/lock 桥 ----------------
   契约照双壳正本（app-src/lock.js、安卓 LockClient）：同源路径 /lock/*，
   凭控制台会话（xid）鉴权，服务端按账号逐台核对机主；密码只在提交瞬间
   过桥，不存、不记。GET /lock/devices 回 [{id,name,owner,locked,component}]，
   其中 id 为 MeshCentral 节点 id；非机主设备由服务端直接过滤、不下发。 */
/* 超时口径对齐服务端语义：读路径 8s（服务端冷查 ≤3s，留推进余量）；
   写路径必须覆盖服务端对账窗口（RECONCILE 30s / UPDATE_RECONCILE 240s）+ 余量，
   否则客户端先超时、服务端还在对账，会出现「客户端说失败、服务端记成功」。 */
const LOCK_TIMEOUTS = { '/devices': 8000, '/enable': 45000, '/disable': 45000, '/reset': 45000, '/update': 260000 };
async function lockApi(method, route, body) {
  const timeoutMs = LOCK_TIMEOUTS[route] || 15000;
  const opts = { method, timeoutMs };
  if (body !== undefined) opts.json = body;
  opts.retry = (method === 'GET' || method === 'HEAD'); // 写路径不自动重试（防重复投递信封）
  return api('/lock' + route, opts);
}


function validateLockPw(pw) {
  if (typeof pw !== 'string' || pw.length < 4) return '密码至少 4 位，请检查后重试。';
  if (pw.length > 64) return '密码最多 64 位，请检查后重试。';
  return null;
}

/* ---------------- 设备节点标识（node id）----------------
   /home/api/stats 的设备只有名称/系统/分组/在线，不带节点 id（服务端口径）。
   节点 id 的真实来源有二：①/lock/devices（机主设备，id 即节点 id）；
   ②控制台引擎同源控制通道（/control.ashx，浏览器凭会话自动鉴权，与原生
   控制台同一通道）的 nodes 应答。两者都取不到的设备不冒充、不许发送。 */
/* ---------------- 设备节点标识（node id）----------------
   修 C3/C6（原 fetchNodeMap 串行：lockApi 6224ms + fetchControlNodes 618ms，且无单飞）：
   ① 快源＝/lock/devices（服务端已做缓存/单飞，命中 <1s），先返回、先可用；
   ② 慢源＝控制通道全量 nodes（补好友共享设备的 id），后台回填同一份缓存，不阻塞导航与面板首屏；
   ③ 全流程 single-flight；页内缓存 60s 有效（原随页生死且永不刷新）。 */
let nodeMapCache = null;
let nodeMapInflight = null;
let nodeMapSlowInflight = null;
const NODE_MAP_TTL_MS = 60000;
const CONTROL_PROBE_MS = 1500;      // 控制通道探测上限（原 6000，与慢源定位一致）
/* NAV_LOOKUP_BUDGET_MS（900ms 点按竞态预算）已随 2.4.0 会话直达删除：解析改走
   数据携带→缓存→服务端 resolve 端点的确定序，不再有超时回落老列表这条路。 */

function ensureNodeMap() {
  if (!nodeMapCache) nodeMapCache = { at: 0, byName: new Map(), byId: new Map(), lockDevices: [], lockStatus: 'ok', lockError: '' };
  return nodeMapCache;
}
function applyLockDevices(devices) {
  const nm = ensureNodeMap();
  const list = [];
  (devices || []).forEach(d => {
    const dev = { id: String(d.id || ''), name: String(d.name || ''), owner: !!d.owner, locked: !!d.locked, component: d.component !== false };
    if (!dev.id) return;
    list.push(dev);
    if (dev.name) nm.byName.set(dev.name, dev.id);
    nm.byId.set(dev.id, dev.name);
    nm.byId.set(bareNodeId(dev.id), dev.name);   /* 裸 id 键：邀请/深链等按裸 id 反查设备名 */
  });
  nm.lockDevices = list;
  nm.lockStatus = 'ok'; nm.lockError = '';
  nm.at = Date.now();
  return nm;
}
function applyControlNodes(grouped) {
  const nm = ensureNodeMap();
  Object.values(grouped || {}).forEach(arr => {
    (Array.isArray(arr) ? arr : []).forEach(n => {
      if (!n || !n._id) return;
      const id = String(n._id);
      const nmName = String(n.name || n.rname || '');
      if (nmName && !nm.byName.has(nmName)) nm.byName.set(nmName, id);
      if (!nm.byId.has(id)) nm.byId.set(id, nmName);
      if (!nm.byId.has(bareNodeId(id))) nm.byId.set(bareNodeId(id), nmName);
    });
  });
  // [gate2-delta N6] slow fill renews the TTL only when the lock leg is healthy; on failure backdate so retry happens in ~5s
  nm.at = (nm.lockStatus === 'ok') ? Date.now() : (Date.now() - (NODE_MAP_TTL_MS - 5000));
  return nm;
}
function fetchControlNodes(timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; try { ws.close(); } catch (e) {} resolve(v || {}); } };
    let ws;
    try {
      const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
      ws = new WebSocket(proto + location.host + '/control.ashx');
    } catch (e) { resolve({}); return; }
    const timer = setTimeout(() => finish({}), timeoutMs || CONTROL_PROBE_MS);
    ws.onopen = () => { try { ws.send(JSON.stringify({ action: 'nodes', responseid: 'qf-nodes-probe' })); } catch (e) { clearTimeout(timer); finish({}); } };
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m && m.responseid === 'qf-nodes-probe') { clearTimeout(timer); finish(m.nodes || {}); }
    };
    ws.onerror = () => { clearTimeout(timer); finish({}); };
    ws.onclose = () => { clearTimeout(timer); finish({}); };
  });
}
async function fetchNodeMap(opts) {
  const force = !!(opts && opts.force);
  if (nodeMapInflight) return nodeMapInflight;                 // single-flight
  const nm0 = ensureNodeMap();
  if (!force && nm0.at && (Date.now() - nm0.at) < NODE_MAP_TTL_MS) return nm0;
  nodeMapInflight = (async () => {
    let lockStatus = 'ok', lockError = '';
    try {
      const lr = await lockApi('GET', '/devices');
      if (lr.status === 200 && lr.json && Array.isArray(lr.json.devices)) {
        applyLockDevices(lr.json.devices);
      } else if (lr.status === 401) { lockStatus = 'needlogin'; lockError = apiErrText(lr, '登录状态已失效，请重新登录后再管理屏幕锁。'); }
      else if (lr.networkError) { lockStatus = 'unreachable'; lockError = '暂时连不上屏幕锁服务，请检查网络后重试。'; }
      else { lockStatus = 'unavailable'; lockError = apiErrText(lr, '屏幕锁服务暂未开通网页通道，暂时无法在此管理。请通过软件端管理该设备的屏幕锁。'); }
    } catch (e) { lockStatus = 'unreachable'; lockError = '暂时连不上屏幕锁服务，请检查网络后重试。'; }
    const nm = ensureNodeMap();
    nm.lockStatus = lockStatus; nm.lockError = lockError; nm.at = Date.now();
    // 慢源不阻塞：后台拉控制通道全量 nodes，回来只回填缓存（供后续导航/共享设备用）
    if (!nodeMapSlowInflight) {
      nodeMapSlowInflight = fetchControlNodes(CONTROL_PROBE_MS)
        .then((grouped) => { applyControlNodes(grouped); refreshDevRowIds(document); })
        .catch(() => {})
        .then(() => { nodeMapSlowInflight = null; });
    }
    return nm;
  })().then((v) => { nodeMapInflight = null; return v; },
            (e) => { nodeMapInflight = null; throw e; });
  return nodeMapInflight;
}
/* raceNodeId（点按 900ms 竞态解析）已随 2.4.0 会话直达整体删除：openSession 的
   解析序＝入口 data-nodeid 数据携带 → nodeIdFor 缓存 → ext /api/device/resolve
   兜底（见会话融合视图段），超时回落原生设备列表的路径不复存在。 */
function invalidateNodeMap() { nodeMapCache = null; }

/* ---------------- 设备间文件发送（N-3 端点组，会话鉴权） ---------------- */
const FILE_MAX_BYTES = 200 * 1024 * 1024;
function readFileBase64(file, onProgress) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
    reader.onerror = () => reject(new Error('文件读取失败，请重新选择文件后重试。'));
    reader.onload = () => {
      const s = String(reader.result || '');
      const i = s.indexOf(',');
      resolve(i >= 0 ? s.slice(i + 1) : s);
    };
    reader.readAsDataURL(file);
  });
}
function xhrSendFile(payload, onProgress) {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/license/api/files/send', true);
    xhr.withCredentials = true;
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      let json = null; try { json = JSON.parse(xhr.responseText); } catch (e) {}
      resolve({ status: xhr.status, ok: xhr.status >= 200 && xhr.status < 300, json, text: xhr.responseText });
    };
    xhr.onerror = () => resolve({ status: 0, ok: false, json: null, text: '', networkError: true });
    xhr.send(JSON.stringify(payload));
  });
}
async function downloadStagedFile(id, filename, onProgress) {
  const r = await fetch('/license/api/files/' + encodeURIComponent(id) + '/download', { credentials: 'include' });
  if (!r.ok) throw new Error('下载失败（服务返回 ' + r.status + '），请稍后再试。');
  const total = Number(r.headers.get('Content-Length') || 0);
  let blob;
  if (r.body && r.body.getReader) {
    const reader = r.body.getReader(); const chunks = []; let got = 0;
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      chunks.push(part.value); got += part.value.length;
      if (onProgress && total) onProgress(got / total);
    }
    blob = new Blob(chunks);
  } else { blob = await r.blob(); if (onProgress) onProgress(1); }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename || 'file';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return blob.size;
}

/* ---------------- 会话与本地缓存（进门不挡：先渲染、后校验） ---------------- */
const Cache = {
  load() { try { return JSON.parse(localStorage.getItem('qf-console-cache') || 'null'); } catch (e) { return null; } },
  save(v) { try { localStorage.setItem('qf-console-cache', JSON.stringify(v)); } catch (e) {} },
  clear() { try { localStorage.removeItem('qf-console-cache'); } catch (e) {} }
};
const S = {
  auth: 'unknown',           // unknown | in | out
  user: null, displayName: '', isAdmin: false,
  license: null, points: null, stats: null,
  route: { name: 'home', param: null },
  forumReady: false,
  sessGen: 0                 // DS-R49：会话身份代数（新登录/登出/强制下线/会话结束递增，在飞请求据此丢弃迟到响应）
};
function cacheSave() {
  if (S.auth !== 'in') return;
  Cache.save({ user: S.user, displayName: S.displayName, isAdmin: S.isAdmin, license: S.license, points: S.points, route: S.route, at: Date.now() });
}
/* ============================================================
 * 会话中途封禁锁定 / 会话已结束呈现（新增区块）
 * 仅本区块与下列修改点涉及本件，其余函数不动。
 * ============================================================ */
const BAN_LOCK_CHECK_MS = 30000;              // 锁定期 /me 复查周期
const BAN_SIGNAL_PARAM_ACCOUNT_PATHS = [      // 信号③排除：以参数指定目标账号的查询类接口
  '/license/api/status/query',
  '/license/api/status/reveal',
  '/license/api/verify-password'
];

const BanLock = {
  state: 'off',        // off | locked | expired
  reason: '',          // expired 来源：'locked'（锁定中会话被撤销）| 'died'（会话猝死）
  data: null,          // /me 的 activeBan 原样对象（code/permanent/endsAt/id），不打印 code
  timer: null,
  flight: false,       // 复查单飞
  suppress: false,     // 主动登出等场景下的抑制窗

  active() { return this.state === 'locked' || this.state === 'expired'; },

  enter(ban) {
    if (this.state === 'expired') return;
    if (this.state === 'locked') { if (ban) this.data = ban; return; }
    if (this.suppress) return;
    if (S.auth !== 'in') return;
    this.state = 'locked';
    this.reason = 'api';
    this.data = ban || null;
    try { if (typeof chatResetAll === 'function') chatResetAll(); } catch (e) { /* 聊天模块异常不得阻断呈现 */ }
    this.paint();
    this.startTimer();
  },

  toExpired(reason) {
    this.stopTimer();
    this.state = 'expired';
    this.reason = (reason === 'locked') ? 'locked' : 'died';
    S.auth = 'out'; S.license = null; S.points = null; S.isAdmin = false; // DS-R24 B3：已结束页不得残留管理后台入口
    try { Cache.clear(); } catch (e) {}
    try { invalidateNodeMap(); } catch (e) {} // W1-2：会话结束即清设备映射缓存，防换账号残留上一账号设备清单
    try { if (typeof chatResetAll === 'function') chatResetAll(); } catch (e) { /* 聊天模块异常不得阻断呈现 */ }
    this.paint();
  },

  exit() {
    this.stopTimer();
    this.state = 'off';
    this.reason = '';
    this.data = null;
    this.flight = false;
    this._lastPaintState = 'off';   // DS-R46：退出即作废上次绘制态，防旧表单节点被误保全
  },

  startTimer() {
    this.stopTimer();
    if (this.state !== 'locked') return;
    this.timer = setInterval(() => { try { this.recheck(false); } catch (e) {} }, BAN_LOCK_CHECK_MS);
  },

  stopTimer() {
    if (this.timer != null) {
      try { clearInterval(this.timer); } catch (e) {}
      this.timer = null;
    }
  },

  async recheck(manual) {
    if (this.state !== 'locked') return;
    if (this.flight) return;
    this.flight = true;
    try {
      const me = await api('/license/api/me');
      if (me.status === 200 && me.json && me.json.ok) {
        if (me.json.activeBan) {
          const nb = me.json.activeBan;
          const od = this.data || {};
          const changed = (!!od.permanent !== !!nb.permanent) || (String(od.endsAt || '') !== String(nb.endsAt || ''));
          this.data = nb;
          if (manual && !changed) { try { toast('账号仍处于封禁状态。', 'warn'); } catch (e) {} }
          if (manual || changed) this.paint();
          return;
        }
        // 解封：退出锁定，按 checkSession 既有口径回填后回主壳
        this.exit();
        const probe = {};
        const ok = await checkSession(true, { noDied: true, probe });
        if (this.active()) return;            // 复查期间又被判封禁，保持锁定
        if (probe.gated) return;              // DS-R44：checkSession 已画设备门，禁止 showAuth 覆盖
        if (ok && S.auth === 'in') {
          location.hash = '#home';
          showShell();
          try { toast('账号状态已恢复正常，欢迎回来。', 'ok'); } catch (e) {}
        } else {
          showAuth('login', { notice: '请重新登录。' });
        }
        return;
      }
      if (me.status === 401 || me.status === 403) {
        this.toExpired('locked');
        return;
      }
      if (manual) { try { toast('暂时无法确认账号状态，请稍后再试。', 'warn'); } catch (e) {} }
    } catch (e) {
      if (manual) { try { toast('暂时无法确认账号状态，请稍后再试。', 'warn'); } catch (e2) {} }
    } finally {
      this.flight = false;
    }
  },

  paintStatusTool(box) {
    if (!box) return;
    box.innerHTML = '<div class="card" style="margin-top:16px"><h3>查询密钥（账号＋密码核验）</h3>'
      + '<div class="field"><label>账号</label><input id="bn-sq-user"></div>'
      + '<div class="field"><label>密码</label><input id="bn-sq-pass" type="password"></div>'
      + '<button class="btn block" id="bn-sq-btn">查询</button><div id="bn-sq-out" style="margin-top:12px"></div></div>';
    const btn = $('#bn-sq-btn', box);
    if (!btn) return;
    btn.onclick = async () => {
      const r = await api('/license/api/status/query', {
        method: 'POST',
        json: { username: $('#bn-sq-user', box).value.trim(), password: $('#bn-sq-pass', box).value }
      });
      const out = $('#bn-sq-out', box);
      if (!out) return;
      out.innerHTML = r.json
        ? '<div class="note ' + (r.json.ok ? 'blue' : 'err') + '">'
          + esc(r.json.ok ? statusSummary(r.json) : (r.json.msg || '查询失败，请核对账号与密码。')) + '</div>'
        : stateBox('暂时无法查询', '服务暂时不可用，请稍后再试。', false);
    };
  },

  paint() {
    const root = (typeof $ === 'function') ? $('#authRoot') : document.getElementById('authRoot');
    if (!root) return;
    const shell = document.getElementById('shellRoot');
    if (shell) shell.hidden = true;
    root.hidden = false;
    var _bf = document.getElementById('bootFail'); if (_bf) _bf.style.display = 'none';   // W4-2 启动兜底隐藏（锁定界面显根路径同口径，门二观察项）
    try {
      const st = this.state;
      const d = this.data || null;
      const nm = esc(S.displayName || S.user || '');
      const isPerm = !!(d && d.permanent);
      let endsText = '';
      if (!isPerm && d && d.endsAt) {
        try { endsText = esc(String(fmtDate(d.endsAt) || '')); } catch (e) { endsText = ''; }
      }
      let title, body;
      if (st === 'expired') {
        title = '登录状态已结束';
        body = (this.reason === 'locked')
          ? '本账号的登录状态已被服务器结束。如您的账号处于封禁状态，重新登录后将显示封禁原因与申诉入口。'
          : '当前登录状态已失效，请重新登录后继续使用。';
      } else {
        title = '账号已被封禁';
        if (isPerm) body = '您的账号已被永久封禁，当前无法使用本控制台的各项功能。';
        else if (endsText) body = '您的账号已被封禁，预计于 ' + endsText + ' 解除，当前无法使用本控制台的各项功能。';
        else body = '您的账号当前处于封禁状态，暂时无法使用本控制台的各项功能。';
        body += '如您认为该处理存在疑问，可提交申诉或联系智能客服。';
      }

      let html = '<div class="authwrap"><div class="auth">';
      try {
        if (typeof brandBlock === 'function') {
          const b = brandBlock();
          if (typeof b === 'string') html += b;
        }
      } catch (e) { /* 品牌块异常不影响锁定呈现 */ }
      html += '<h1>' + esc(title) + '</h1>';
      if (nm) html += '<div class="psub">' + nm + '</div>';
      html += '<div class="note err">' + esc(body) + '</div>';
      if (st === 'locked') html += '<div class="note">事由：违反平台规则</div>';
      if (st === 'expired') html += '<button class="btn block" id="bn-relogin">重新登录</button>';
      else html += '<button class="btn block" id="bn-appeal">提交申诉</button>';
      html += '<div id="bn-links" style="margin-top:10px;text-align:center">';
      if (st === 'expired') html += '<a class="txtlink" id="bn-appeal-link" style="cursor:pointer">提交申诉</a> ';
      html += '<a class="txtlink" id="bn-support" style="cursor:pointer">联系智能客服</a> ';
      html += '<a class="txtlink" id="bn-status" style="cursor:pointer">查询密钥</a> ';
      if (st === 'locked') html += '<a class="txtlink" id="bn-recheck" style="cursor:pointer">重新检查</a> ';
      if (S.isAdmin) html += '<a class="txtlink" id="bn-admin" style="cursor:pointer">管理后台</a> ';
      html += '<a class="txtlink" id="bn-logout" style="cursor:pointer">退出登录</a>';
      html += '</div><div id="bn-tools" style="margin-top:16px"></div></div></div>';
      // DS-R46：自动复检重绘（locked→locked）时保全旧 #bn-tools 节点，
      // 正在填的申诉/客服/查钥表单与已绑定监听不丢；状态迁移（进入锁定/
      // 转已结束/退出后重入）不保全，照旧重置。上次绘制态由 _lastPaintState
      // 记录（paint 末尾回写、exit 清零），防退出后残留节点被误保全。
      const prevTools = (this._lastPaintState === 'locked' && this.state === 'locked') ? $('#bn-tools', root) : null;
      root.innerHTML = html;

      const self = this;
      let box = $('#bn-tools', root);
      if (prevTools && box && box.parentNode) { box.parentNode.replaceChild(prevTools, box); box = prevTools; }
      this._lastPaintState = this.state;
      const bind = (id, fn) => {
        const el = $('#' + id, root);
        if (!el) return;
        el.onclick = (ev) => { if (ev && ev.preventDefault) ev.preventDefault(); try { fn(); } catch (e) {} };
      };
      const openAppeal = () => {
        if (!box) return;
        box.innerHTML = '';
        if (typeof renderAppeal === 'function') renderAppeal(box, { user: S.user || '' });
      };
      bind('bn-appeal', openAppeal);
      bind('bn-appeal-link', openAppeal);
      bind('bn-support', () => {
        if (!box) return;
        box.innerHTML = '';
        if (typeof Views !== 'undefined' && Views && typeof Views.support === 'function') {
          Views.support(box, null, 0, { guest: true });
        }
      });
      bind('bn-status', () => { if (box) self.paintStatusTool(box); });
      bind('bn-recheck', () => { self.recheck(true); });
      bind('bn-admin', () => { location.href = '/admin'; });
      bind('bn-logout', () => { doLogout(); });
      bind('bn-relogin', () => {
        self.exit();
        showAuth('login', { notice: '请重新登录。' });
      });
    } catch (e) {
      root.innerHTML = '<div class="authwrap"><div class="auth">'
        + '<h1>账号已被封禁</h1>'
        + '<div class="note err">当前账号暂时无法使用本控制台的各项功能。如需帮助，请提交申诉或联系智能客服。</div>'
        + '<button class="btn block" id="bn-logout">退出登录</button>'
        + '</div></div>';
      const lo = $('#bn-logout', root);
      if (lo) lo.onclick = () => { try { doLogout(); } catch (e2) {} };
    }
  }
};

/* 信号采集：只报「当前会话」的封禁信号，不误踢 */
function noteBanSignal(res, path) {
  if (!res || typeof res !== 'object') return;
  if (S.auth !== 'in') return;                 // 未登录工具调用不得锁人（R1 守卫）
  if (BanLock.suppress) return;
  if (BanLock.active()) return;
  const j = res.json;
  if (!j || typeof j !== 'object') return;
  if (j.code !== 'ACCOUNT_BANNED') return;
  // DS-R45：参数化账号查询路径排除上移至 200/403 分流前共用——403 形
  // 同样是替别人查号被拒，不得误锁当前会话（原仅 200 分支有此排除）。
  const p = String(path || '').split('?')[0];
  if (BAN_SIGNAL_PARAM_ACCOUNT_PATHS.indexOf(p) >= 0) return;  // 参数化账号查询，防误踢
  if (res.status === 403) {                    // 信号①：ext 集中门 / denyIfBanned
    BanLock.enter(null);
    return;
  }
  if (res.status === 200 && j.ok === false) {  // 信号③：处理器自查发出的 200 形封禁拒绝
    BanLock.enter(null);
  }
}

/* 会话猝死统一落点（R5）：返回是否已接管呈现 */
function sessionDied(source) {
  S.sessGen++; // DS-R49：会话结束＝登出等价落点，递增代数使其余在飞旧响应作废
  if (BanLock.suppress) return false;
  if (BanLock.state === 'expired') return true;
  if (BanLock.state === 'locked') { BanLock.toExpired('locked'); return true; }
  BanLock.toExpired('died');
  return true;
}

/* api() 零侵入包装：所有调用自动过一遍信号采集 */
const apiInnerRaw = api;
api = async function (path, opts) {
  const res = await apiInnerRaw(path, opts);
  try { noteBanSignal(res, path); } catch (e) { /* 信号采集异常不得影响业务返回 */ }
  return res;
};

async function checkSession(silent, opts) {
  const o = opts || {};
  const probe = o.probe;
  if (probe) { try { probe.gated = false; } catch (e) {} }
  const gen = S.sessGen; // DS-R49：发起时捕获身份代数，响应回来时代数已变则整单丢弃
  const me = await api('/license/api/me');
  if (gen !== S.sessGen) return S.auth === 'in'; // DS-R49：旧代数迟到响应，不写状态、不作处置
  if (me.status === 200 && me.json && me.json.ok) {
    // 同一响应只走一条路：先 forceLogout（设备门），再 activeBan（封禁锁定）
    if (me.json.forceLogout) {
      if (probe) { try { probe.gated = true; } catch (e) {} }
      forceGate(me.json.gateCode || 'G1');
      return false;
    }
    const isNewAuth = S.auth !== 'in' || S.user !== me.json.username;
    const userSwitched = isNewAuth && !!S.user && S.user !== me.json.username; // DS-R07/S3：检出换账号（他标签切号落到本页）
    S.auth = 'in'; S.user = me.json.username; S.license = me.json;
    if (isNewAuth) S.sessGen++; // DS-R49：仅新建登录身份时递增；同账号周期校验不递增，防误伤在飞心跳
    if (userSwitched) { try { chatResetAll(); } catch (e) { /* 聊天模块异常不得阻断会话检查 */ } } // DS-R07/S3：身份一变立即清本页聊天态与轮询，不等下一次 chatApi（此处 S.user 已是新身份，重签绑定正确）
    const curGen = S.sessGen;
    if (me.json.activeBan) {
      S.displayName = S.displayName || me.json.username;
      BanLock.enter(me.json.activeBan);       // 信号②
      cacheSave();
      return true;
    }
    const st = await api('/home/api/stats');
    if (curGen !== S.sessGen) return S.auth === 'in'; // DS-R49：stats 在飞期间身份已变，旧回填不写入
    if (st.status === 200 && st.json && st.json.ok) { S.stats = st.json; S.displayName = st.json.displayName || me.json.username; S.isAdmin = !!st.json.isAdmin; }
    else { S.displayName = me.json.username; }
    cacheSave();
    return true;
  }
  if (me.status === 401 || me.status === 403) {
    const wasIn = S.auth === 'in';
    S.auth = 'out'; S.license = null; Cache.clear();
    if (wasIn) {
      if (!o.noDied) {
        const handled = sessionDied('session');   // 交给统一「会话已结束」落点
        if (!handled && !silent) toast('登录状态已失效，请重新登录。', 'warn');
      } else if (!silent) {
        toast('登录状态已失效，请重新登录。', 'warn');
      }
    }
    return false;
  }
  // 网络异常等：不把用户踢下线（手感规格：失败给正式提示、不崩页）
  if (!silent) toast('暂时无法确认登录状态，请稍后再试。', 'warn');
  return S.auth === 'in';
}
/* 登录页偏好与账密保存（#39）：两个勾选框的状态跨登出、跨重启持久；
 * 「记住账号密码」勾选且登录成功才落盘，取消勾选再次登录即彻底清除。 */
const LoginPrefs = {
  load() { try { return JSON.parse(localStorage.getItem('qf-console-login-prefs') || 'null') || { rem: true, saveCred: false }; } catch (e) { return { rem: true, saveCred: false }; } },
  save(v) { try { localStorage.setItem('qf-console-login-prefs', JSON.stringify(v)); } catch (e) {} }
};
const SavedCred = {
  load() { try { return JSON.parse(localStorage.getItem('qf-console-cred') || 'null'); } catch (e) { return null; } },
  save(u, p) { try { localStorage.setItem('qf-console-cred', JSON.stringify({ u, p })); } catch (e) {} },
  clear() { try { localStorage.removeItem('qf-console-cred'); } catch (e) {} }
};
function parseBanView(str) {
  try {
    let s = str.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    const obj = JSON.parse(atob(s));
    return {
      mode: obj.mode === 'frozen' ? 'frozen' : 'banned',
      permanent: !!obj.permanent,
      endsAt: obj.endsAt || null
    };
  } catch (e) {
    // 数据缺失或损坏时也能画门，只是没有日期/类型可能偏封禁
    return { mode: 'banned', permanent: false, endsAt: null };
  }
}

async function doLogin(username, password, remember) {
  // 登录一律走自家登录垫片 /qf-login（与原生登录页同口径）：垫片负责登录冻结、
  // 许可门与「记住此设备」——带 qfrememberdevice 字段时给会话 cookie 补 30 天
  // 有效期并种 qfrem 标记，不带则清标记。切勿直连 /login：会绕过垫片，
  // 「记住此设备」勾了也不生效（#39 定位结论）。
  // 登录 POST 的响应体是引擎整页（约 1.5MB），拿到响应头（Cookie 已下发）即取消下载，
  // 避免在慢网络上白等整页传输；成败以 /license/api/me 的会话校验为准。
  try {
    const fields = { username, password };
    if (remember) fields.qfrememberdevice = 'on'; // 垫片按原生勾选框口径认 'on' 值
    const resp = await fetch('/qf-login', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() });
    const loginResult = resp.headers.get('x-qf-login-result');
    if (resp.body) { try { await resp.body.cancel(); } catch (e) {} }
    // 2026-10-26 热修（冻结误报）：密码正确但账号被冻结（B1 当日冻结）时，
    // 垫片回冻结提示页并带 X-QF-Login-Result: frozen——此时根本没有会话
    // 可供 /me 校验，若继续走 /me 必 401 并被误报「账号或密码不正确」。
    // 直接回冻结信号，由登录页呈现冻结提示与申诉入口（与垫片冻结弹窗同口径）。
    if (loginResult === 'frozen') return { ok: false, frozen: true };
    // 2026-10-28 热修（封禁误报）：密码正确但账号被封禁（B6/B7/B9 或永久封禁）
    // 或非 B1 冻结（B8/B10）且 MC 锁定位在身时，垫片回封禁门信号与数据。
    // 直接回 banned，由登录页画门，不再误报密码错误。
    if (loginResult === 'banned') {
      const ban = parseBanView(resp.headers.get('x-qf-ban-view'));
      return { ok: false, banned: true, ban };
    }
    // W1-3 残面（2026-10-29）：密码已验过但账号处于锁定漂移态（垫片三查无
    // 活动封禁可确认）时，垫片回 X-QF-Login-Result: locked——呈现中性提示，
    // 不再误报「账号或密码不正确」，也不冒充封禁/冻结。
    if (loginResult === 'locked') return { ok: false, locked: true };
  } catch (e) { return { ok: false, msg: '网络暂时不可用，请检查网络后重试。' }; }
  // 会话校验偶发抖动时多等一轮再判，避免把非密码原因误报成密码错误
  // （2026-10-26 热修：垫片许可门吃会话曾让 /me 必 401 并被一律误报）。
  let me = await api('/license/api/me');
  if (!(me.status === 200 && me.json && me.json.ok)) { await new Promise(r => setTimeout(r, 600)); me = await api('/license/api/me'); }
  if (me.status === 200 && me.json && me.json.ok) {
    S.sessGen++; // DS-R49：主动登录成功即新身份代数，旧在飞响应作废
    S.auth = 'in'; S.user = me.json.username; S.license = me.json;
    const curGen = S.sessGen; // 批A-A1：捕获本次登录代数，stats 回填前比对（处方同 checkSession）
    const st = await api('/home/api/stats');
    if (curGen === S.sessGen && st.status === 200 && st.json && st.json.ok) { S.stats = st.json; S.displayName = st.json.displayName || S.user; S.isAdmin = !!st.json.isAdmin; }
    cacheSave();
    // 登录即上报一次积分心跳（与软件端口径一致；响应含强制下线信号时立即处理）
    heartbeat();
    return { ok: true };
  }
  if (me.status === 401 || me.status === 403) return { ok: false, msg: '账号或密码不正确，请核对后重试。' };
  return { ok: false, msg: '登录未完成，请稍后再试。' };
}
async function heartbeat() {
  if (S.auth !== 'in') return;
  if (BanLock.active()) return;
  const gen = S.sessGen; // DS-R49：发起时捕获身份代数
  const r = await api('/points/api/heartbeat', { method: 'POST', json: { client: 'web-console-shadow' } });
  if (gen !== S.sessGen || S.auth !== 'in') return; // DS-R49＋DS-R24 B2：等待期间身份代数变化（含登出后快速重登）或已主动退出登录，迟到响应不再接管呈现、不写积分、不落强制下线（防误踢新会话）
  if (r.status === 200 && r.json) {
    if (r.json.forceLogout) { forceGate(r.json.gateCode || 'G1'); return; } // 批A-A5：按服务端下发 gateCode 落门，与 checkSession 同口径
    S.points = r.json; cacheSave();
    return;
  }
  if (r.status === 401) { sessionDied('heartbeat'); }
}
setInterval(heartbeat, 60000);                    // 在线计时/强制下线通道
setInterval(() => { if (S.auth === 'in' && !BanLock.active()) checkSession(true); }, 240000); // 凭证静默续期校验
function forceGate(code) {
  S.sessGen++; // DS-R49：强制下线＝登出等价落点，递增代数使其余在飞旧响应作废
  BanLock.exit();
  S.auth = 'out'; Cache.clear();
  invalidateNodeMap(); // W1-2：强制下线即清设备映射缓存，防换账号残留
  try { if (typeof chatResetAll === 'function') chatResetAll(); } catch (e) { /* 聊天模块异常不得阻断登出 */ }
  showAuth('gate', { code: code || 'G1' });
  toast('本设备已被退出登录，请重新登录后在「我的 · 兑换 KEY」中处理激活。', 'warn');
}
async function doLogout() {
  confirmModal('退出登录', '退出后将清除本设备的登录状态与记住标记，再次使用需要重新登录。', '退出登录', async () => {
    BanLock.suppress = true;
    S.sessGen++; // DS-R49：登出即身份代数变化，旧在飞响应作废
    try {
      BanLock.exit();
      const lo = await api('/logout');
      // 批A-W1-6：结果要查——失败也照常本地登出（既定口径），仅 console.warn 留痕、用户无感（DS 门一裁定 (a)）。
      // 判失败只认网络失败/HTTP 错误：/logout 成功回的是页面而非 JSON，不能以 json.ok 判成败（偏差 DEV-1，送门二验收）。
      if (!lo || lo.networkError || lo.status === 0 || lo.status >= 400) console.warn('退出登录请求未成功，已按本地退出处理。', lo && lo.status);
    } finally {
      BanLock.suppress = false;
    }
    Cache.clear();
    invalidateNodeMap(); // W1-2：主动登出即清设备映射缓存，防换账号残留
    try { if (typeof chatResetAll === 'function') chatResetAll(); } catch (e) { /* 聊天模块异常不得阻断登出 */ }
    try { badgeEpoch++; badgeFlight = null; badgeLastFetch = 0; setFriendBadge(-1); } catch (e) { /* 角标重置异常不得阻断登出 */ }
    S.auth = 'out'; S.user = null; S.displayName = ''; S.isAdmin = false; S.license = null; S.points = null; S.stats = null; // 批A-W1-11：身份字段按 S 默认复位，防换账号残留
    showAuth('login', { notice: '您已退出登录。' });
  });
}

/* ---------------- 导航（#34：主菜单组严格次序，三容器同序） ---------------- */
const MENU34 = [
  { icon: 'home', label: '首页', route: 'home' },
  { icon: 'user', label: '我的账户', route: 'profile' },
  { icon: 'folder', label: '我的文件', route: 'files' },
  { icon: 'users', label: '好友', route: 'friends' },
  { icon: 'forum', label: '论坛', route: 'forum' }
];
const FUNC = [
  { icon: 'monitor', label: '我的设备', route: 'devices' },
  { icon: 'chat', label: '聊天', route: 'chat' },
  { icon: 'headset', label: '智能客服', route: 'support' },
  { icon: 'cart', label: '购买密钥', route: 'purchase' },
  { icon: 'award', label: '积分与福利', route: 'points' }
];
const BTABS = [
  { icon: 'home', label: '首页', route: 'home' },
  { icon: 'monitor', label: '设备', route: 'devices' },
  { icon: 'chat', label: '消息', route: 'chat' },
  { icon: 'user', label: '我的', route: 'profile' }
];
/* ===== P7-016 好友申请角标：模块级状态 ===== */
let friendReqCount = -1;   // -1 未知/隐藏；>=0 最近一次确认的待处理申请数
let badgeEpoch = 0;        // 角标数据代次，用于丢弃过期回包
let badgeFlight = null;    // 正在飞行中的请求（并发去重）
let badgeLastFetch = 0;    // 上次请求结束时间戳（节流）
const FR_BADGE_TTL = 20000;

/* 按当前 friendReqCount 生成角标 span，供 nav 模板复用 */
function frBdgHtml() {
  const n = friendReqCount;
  return n > 0 ? `<span class="fr-bdg">${n}</span>` : `<span class="fr-bdg" hidden></span>`;
}

/* 写入角标：先镜像确保，再同步全部 .fr-bdg */
function setFriendBadge(n) {
  friendReqCount = n;
  const burger = $('#burgerBtn');
  if (burger && !burger.querySelector('.fr-bdg')) {
    const sp = document.createElement('span');
    sp.className = 'fr-bdg onbtn';
    burger.appendChild(sp);
  }
  document.querySelectorAll('.fr-bdg').forEach(el => {
    if (friendReqCount > 0) { el.hidden = false; el.textContent = String(friendReqCount); }
    else { el.hidden = true; el.textContent = ''; }
  });
}

/* 拉取 /api/friends/me 并刷新角标；失败永不改角标 */
async function refreshFriendBadge(force) {
  if (badgeFlight) return;                                              // 并发去重（force 同样让位）
  if (!force && Date.now() - badgeLastFetch < FR_BADGE_TTL) return;     // 20s 节流
  if (S.auth !== 'in') { setFriendBadge(-1); return; }
  const flight = { epoch: badgeEpoch };
  badgeFlight = flight;
  try {
    const r = await api('/api/friends/me');
    if (r.status === 200 && r.json && Array.isArray(r.json.requestsIn)) {
      if (flight.epoch === badgeEpoch) setFriendBadge(r.json.requestsIn.length);  // epoch 不符丢弃
    }
  } catch (e) {
    /* 失败永不改角标：保留最近已知真值 */
  } finally {
    if (badgeFlight === flight) { badgeFlight = null; badgeLastFetch = Date.now(); }
  }
}

window.addEventListener('focus', () => { refreshFriendBadge(false).catch(() => {}); });

function navBtn(item, activeRoute, cls) {
  const base = cls === undefined ? 'nav' : cls;
  return `<button class="${base}${item.route === activeRoute ? ' on' : ''}" data-nav="${item.route}">${ic(item.icon)}<span>${item.label}</span>${item.route === 'friends' ? frBdgHtml() : ''}</button>`;
}
function menu34Html(activeRoute, cls) {
  return MENU34.map(i => navBtn(i, activeRoute, cls)).join('') +
    (S.isAdmin ? navBtn({ icon: 'gear', label: '站长管理', route: 'admin' }, activeRoute, cls) : '') + websiteNavHtml(cls) +
    `<button class="${cls || 'nav'} red" data-nav="logout">${ic('logout')}<span>登出</span></button>`;
}
function renderNavs() {
  const a = S.route.name === 'device' ? 'devices' : (S.route.name === 'remote' ? 'devices' : S.route.name);
  $('#sidebar').innerHTML =
    `<div class="brand"><span class="mark"><svg viewBox="0 0 240 240" aria-hidden="true"><path d="M 197.2 130.9 A 78 78 0 1 1 161.3 53.9" fill="none" stroke="#FFFFFF" stroke-width="25" stroke-linecap="round"/><circle cx="190.1" cy="85.8" r="16" fill="#FFFFFF"/></svg></span><span><b>QFRemote</b><small>REMOTE CONTROL</small></span></div>` +
    `<div class="gtitle">主菜单</div>` +
    MENU34.map(i => navBtn(i, a)).join('') +
    `<div class="gtitle">功能</div>` +
    FUNC.map(i => navBtn(i, a)).join('') +
    (S.isAdmin ? `<div class="gtitle">站长</div>` + navBtn({ icon: 'gear', label: '站长管理', route: 'admin' }, a) : '') +
    `<div class="sp"></div>` + websiteNavHtml('nav') +
    `<button class="nav red" data-nav="logout">${ic('logout')}<span>登出</span></button>` +
    `<div class="sidefoot">安全 · 便捷 · 远程连接</div>`;
  $('#drawer').innerHTML =
    `<div class="brand"><span class="mark"><svg viewBox="0 0 240 240" aria-hidden="true"><path d="M 197.2 130.9 A 78 78 0 1 1 161.3 53.9" fill="none" stroke="#FFFFFF" stroke-width="25" stroke-linecap="round"/><circle cx="190.1" cy="85.8" r="16" fill="#FFFFFF"/></svg></span><span><b>QFRemote</b><small>REMOTE CONTROL</small></span></div>` +
    `<div class="gtitle">主菜单</div>` + menu34Html(a, 'nav');
  $('#acctMenu').innerHTML = MENU34.map(i =>
    `<a data-nav="${i.route}" class="${i.route === a ? 'on' : ''}">${ic(i.icon)}<span>${i.label}</span>${i.route === 'friends' ? frBdgHtml() : ''}</a>`).join('') +
    (S.isAdmin ? `<a data-nav="admin" class="${a === 'admin' ? 'on' : ''}">${ic('gear')}<span>站长管理</span></a>` : '') +
    `<a href="${QF_WEBSITE_URL}" target="_blank" rel="noopener">${ic('globe')}<span>官方网站</span></a>` +
    `<a data-nav="logout" class="red">${ic('logout')}<span>登出</span></a>`;
  $('#bnav').innerHTML = BTABS.map(i => navBtn(i, a, '')).join('');
  $('#acctChip').innerHTML = `<span class="uava">${esc((S.displayName || 'U').slice(0, 1).toUpperCase())}</span><b>${esc(S.displayName || '')}</b>${frBdgHtml()}`;
  document.querySelectorAll('[data-nav]').forEach(el => {
    el.addEventListener('click', () => {
      const r = el.getAttribute('data-nav');
      closeAcctMenu();
      if (r === 'logout') { doLogout(); return; }
      navigate(r);   // 抽屉内点选只换背后视图，按 #35 规格不自动收起抽屉
    });
  });
}

/* ---------------- 抽屉（#35：只占一部分 / 点项不收起；点外收起 2026-10-26 站长改令：
   遮罩 #drawerScrim 承接抽屉外点击、只关抽屉，这一击不落到正文任何控件） ---------------- */
let drawerOpen = false;
function setDrawer(open) {
  drawerOpen = open;
  const d = $('#drawer');
  d.classList.toggle('open', open);
  d.setAttribute('aria-hidden', open ? 'false' : 'true');
  const sc = $('#drawerScrim');
  if (sc) { sc.classList.toggle('on', open); sc.setAttribute('aria-hidden', open ? 'false' : 'true'); }
}
function closeAcctMenu() { const m = $('#acctMenu'); if (m) m.classList.remove('open'); }
document.addEventListener('pointerdown', (e) => {
  // 落点在抽屉之外只做收起。正文区已被 #drawerScrim 遮罩盖住（层级低于抽屉、高于正文），
  // 点遮罩的这一击落在遮罩上、到不了正文控件（2026-10-26 站长改令，取代旧「点外收起不吞点击」）；
  // 顶栏在遮罩层之上，其控件点击照旧生效（并在此顺带收起抽屉），汉堡钮自理开关。
  if (drawerOpen && !e.target.closest('#drawer') && !e.target.closest('#burgerBtn')) setDrawer(false);
  const m = $('#acctMenu');
  if (m && m.classList.contains('open') && !e.target.closest('.acctwrap')) closeAcctMenu();
});
const drawerScrimEl = $('#drawerScrim');
if (drawerScrimEl) drawerScrimEl.addEventListener('click', () => setDrawer(false));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { setDrawer(false); closeAcctMenu(); closeModal(); } });

/* ---------------- 路由（同框切换，不整页刷新） ---------------- */
const Views = {};
let renderSeq = 0;
function navigate(name, param) {
  const target = '#' + name + (param ? '/' + encodeURIComponent(param) : '');
  if (location.hash === target) { render(); } else { location.hash = target; }
}
function parseRoute() {
  const h = (location.hash || '#home').slice(1);
  const [name, param] = h.split('/');
  let decodedParam = null;
  if (param) {
    try { decodedParam = decodeURIComponent(param); }
    catch (e) { decodedParam = null; } // 批A-W1-9：畸形编码按无参处理，不抛 URIError 中断渲染（DS 门一裁定）
  }
  return { name: name || 'home', param: decodedParam };
}
async function render() {
  if (BanLock.active()) return;   // 锁定 / 会话已结束呈现期间不得渲回主壳
  const seq = ++renderSeq;
  S.route = parseRoute();
  if (S.route.name !== 'session') teardownSession();   // 离开会话路由即拆会话（定时器/监听/预热收编框归位）
  else if (Sess.active && Sess.root && document.contains(Sess.root) && (S.route.param === Sess.name || S.route.param === Sess.nodeid)) return;   // 同会话重复渲染（返回链复位 URL 等）跳过，不重建
  if (S.route.name !== 'forum' && S.route.name !== 'post') { forumListMemo = null; forumMemoArmed = false; }
  if (S._chatStop) { try { S._chatStop(); } catch (e) {} S._chatStop = null; }
  renderNavs();
  const view = $('#view');
  const fn = Views[S.route.name] || Views.home;
  view.innerHTML = '';
  try { await fn(view, S.route.param, seq); }
  catch (e) { if (seq === renderSeq) view.innerHTML = stateBox('页面加载失败', '页面组件出现异常，请重新加载。', true), bindRetry(view, render); }
  window.scrollTo(0, 0);
  refreshFriendBadge(false).catch(() => {});
}
window.addEventListener('hashchange', render);

/* ---------------- 壳与未登录区切换 ---------------- */
function showShell() {
  if (BanLock.active()) return;   // 防止 showShell 掀掉锁定界面的 authRoot
  $('#authRoot').hidden = true;
  $('#shellRoot').hidden = false;
  var _bf = document.getElementById('bootFail'); if (_bf) _bf.style.display = 'none';   // W4-2 启动兜底隐藏（内联脚本被拦截时的双保险）
  if (!location.hash) location.hash = '#home';
  render();
  startSessionPreheat();   // 登录即预热引擎源（phase-0 E8 承重项，会话打开时收编加速）
}
function showAuth(kind, extra) {
  $('#shellRoot').hidden = true;
  const root = $('#authRoot');
  root.hidden = false;
  var _bf = document.getElementById('bootFail'); if (_bf) _bf.style.display = 'none';   // W4-2 启动兜底隐藏（内联脚本被拦截时的双保险）
  if (kind === 'register') return Views.register(root, extra);
  if (kind === 'gate') return Views.gate(root, extra);
  const lp = Views.login(root, extra);
  if (parseRoute().name === 'appeal') authTool(root, 'appeal');
  return lp;
}
function brandBlock() {
  return `<div class="brand"><span class="mark"><svg viewBox="0 0 240 240" aria-hidden="true"><defs><linearGradient id="qfgrad" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3F8CFF"/><stop offset="1" stop-color="#2470E0"/></linearGradient></defs><path d="M 197.2 130.9 A 78 78 0 1 1 161.3 53.9" fill="none" stroke="url(#qfgrad)" stroke-width="25" stroke-linecap="round"/><circle cx="190.1" cy="85.8" r="16" fill="#FF8A1E"/></svg></span><span><b style="font-size:19px">QFRemote</b><br><small style="color:var(--sub);letter-spacing:2.4px;font-size:8.5px">REMOTE CONTROL</small></span></div>`;
}

/* ================= 未登录区 ================= */
Views.login = function (root, extra) {
  extra = extra || {};
  root.innerHTML = `<div class="authwrap"><div class="auth">${brandBlock()}
    <h1>登录 QFRemote</h1><p class="psub">使用您的账号和密码登录</p>
    ${extra.notice ? `<div class="note blue">${esc(extra.notice)}</div>` : ''}
    <form id="loginForm">
      <div class="field"><label>账号</label><input id="li-user" autocomplete="username" placeholder="请输入账号"></div>
      <div class="field"><label>密码</label><input id="li-pass" type="password" autocomplete="current-password" placeholder="请输入密码"><p class="ferr" id="li-err" hidden></p></div>
      <label style="display:flex;gap:8px;align-items:center;font-size:13.5px;margin:4px 0 6px"><input type="checkbox" id="li-rem" style="accent-color:var(--brand);width:17px;height:17px">记住此设备（30 天内免登录）</label>
      <label style="display:flex;gap:8px;align-items:center;font-size:13.5px;margin:0 0 14px"><input type="checkbox" id="li-save" style="accent-color:var(--brand);width:17px;height:17px">记住账号密码（下次打开自动填充）</label>
      <button class="btn block" id="li-btn" type="submit">登录</button>
    </form>
    <div id="li-freeze" hidden></div>
    <div class="authlinks"><a data-act="go-register">注册新账号</a><a data-act="go-support">忘记密码 / 需要帮助</a></div>
    <div class="note blue">账号被冻结或封禁时，登录后将直接显示原因与申诉入口；试用或密钥到期时，将显示到期时间与购买、激活入口。</div>
    <div id="authTools"></div>
    <button class="kf" data-act="go-support" style="display:flex;align-items:center;gap:11px;border:1px solid var(--line);border-radius:14px;padding:12px 14px;background:#fff;font-weight:600;font-size:14.5px;margin-top:14px;width:100%;text-align:left;color:var(--tx)"><span class="tile" style="width:36px;height:36px;flex-basis:36px">${ic('headset')}</span>智能客服<small style="color:var(--sub);font-weight:400">未登录也可咨询</small><span class="chev" style="margin-left:auto;color:#B7C3D6">${ic('chevR')}</span></button>
    <button class="btn block black" style="margin-top:12px" data-act="go-purchase">购买密钥</button>
    <button class="txtlink" data-act="go-status">查询密钥</button>
    <button class="txtlink" data-act="go-rebind">申诉换绑设备</button>
    <div class="foot">勾选「记住此设备」后，登录状态将在本设备保留 30 天</div>
  </div></div>`;
  // #39：恢复两个勾选框的上次状态；存有账密时真回填（取消勾选并登录后不再回填）
  const prefs0 = LoginPrefs.load();
  $('#li-rem', root).checked = prefs0.rem !== false;
  $('#li-save', root).checked = !!prefs0.saveCred;
  if (prefs0.saveCred) { const sc = SavedCred.load(); if (sc) { $('#li-user', root).value = sc.u || ''; $('#li-pass', root).value = sc.p || ''; } }
  $('#loginForm', root).addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#li-btn', root); const err = $('#li-err', root); const fz = $('#li-freeze', root);
    btn.disabled = true; btn.textContent = '登录中…'; err.hidden = true; if (fz) { fz.hidden = true; fz.innerHTML = ''; }
    const uname = $('#li-user', root).value.trim();
    const remChecked = $('#li-rem', root).checked;
    const saveChecked = $('#li-save', root).checked;
    const r = await doLogin(uname, $('#li-pass', root).value, remChecked);
    if (r.ok) {
      LoginPrefs.save({ rem: remChecked, saveCred: saveChecked });
      if (saveChecked) SavedCred.save(uname, $('#li-pass', root).value); else SavedCred.clear();
    }
    btn.disabled = false; btn.textContent = '登录';
    if (r.ok) {
      const gate = gateFor(S.license);
      if (gate) { showAuth('gate', gate); return; }
      location.hash = '#home';           // #32：登录成功默认落点恒为新首页
      showShell();
      toast('登录成功，欢迎回来。', 'ok');
    } else if (r.frozen && fz) {
      // 账号冻结提示（与垫片冻结弹窗同口径）：写明原因＋申诉入口＋客服指引，
      // 不再让冻结被误显示成「账号或密码不正确」。
      fz.innerHTML = '<div class="note err">该账号今日密码输入错误已超过 5 次，今日不能再试。</div>'
        + '<button class="btn block" id="li-appeal" type="button" style="margin-top:10px">提交申诉</button>'
        + '<p class="hint" style="margin-top:8px">也可以先咨询<a href="#" id="li-fz-support">智能客服</a>，或在客服中申请转人工。</p>';
      fz.hidden = false;
      $('#li-appeal', root).onclick = () => { authTool(root, 'appeal', { user: uname }); const tb = $('#authTools', root); if (tb) tb.scrollIntoView({ block: 'nearest' }); };
      const sup = $('#li-fz-support', root);
      if (sup) sup.onclick = (ev) => { ev.preventDefault(); authTool(root, 'support'); };
    } else if (r.locked && fz) {
      // W1-3：锁定漂移态中性提示（不写封禁/冻结、不露内部原因），给申诉与客服入口。
      fz.innerHTML = '<div class="note err">该账号当前暂时无法登录。</div>'
        + '<div class="hint" style="margin-top:4px">可能是账号状态异常，请稍后再试。</div>'
        + '<button class="btn block" id="li-lock-appeal" type="button" style="margin-top:10px">提交申诉</button>'
        + '<p class="hint" style="margin-top:8px">也可以先咨询<a href="#" id="li-lock-support">智能客服</a>，或在客服中申请转人工。</p>';
      fz.hidden = false;
      $('#li-lock-appeal', root).onclick = () => { authTool(root, 'appeal', { user: uname }); const tb = $('#authTools', root); if (tb) tb.scrollIntoView({ block: 'nearest' }); };
      const lsup = $('#li-lock-support', root);
      if (lsup) lsup.onclick = (ev) => { ev.preventDefault(); authTool(root, 'support'); };
    } else if (r.banned && fz) {
      // 2026-10-28 热修（封禁误报）：账号被封禁或非 B1 冻结且密码正确时，
      // 直接画门：标题/状态/期限/事由/申诉/客服/查询密钥入口，不露原始 code。
      const b = r.ban || { mode: 'banned', permanent: false, endsAt: null };
      const dateStr = b.endsAt ? new Date(b.endsAt).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }) : '';
      const heading = b.mode === 'frozen' ? '账号已被冻结' : '账号已被封禁';
      let reason = b.mode === 'frozen'
        ? '您的账号已被冻结，当前无法使用本控制台的各项功能。'
        : (b.permanent
            ? '您的账号已被永久封禁，当前无法使用本控制台的各项功能。'
            : '您的账号已被封禁' + (dateStr ? '，预计于 ' + dateStr + ' 解除' : '') + '，当前无法使用本控制台的各项功能。');
      fz.innerHTML = '<div class="note err">' + heading + '</div>'
        + '<div class="note" style="margin-top:4px">' + reason + '</div>'
        + '<div class="hint" style="margin-top:4px">事由：违反平台规则</div>'
        + '<div class="hint" style="margin-top:8px">如您认为该处理存在疑问，可提交申诉或联系智能客服。</div>'
        + '<button class="btn block" id="li-ban-appeal" type="button" style="margin-top:10px">提交申诉</button>'
        + '<p class="hint" style="margin-top:8px">也可以先咨询<a href="#" id="li-ban-support">智能客服</a>，或在客服中申请转人工。'
        + ' <a href="#" id="li-ban-status">查询密钥</a></p>';
      fz.hidden = false;
      $('#li-ban-appeal', root).onclick = () => { authTool(root, 'appeal', { user: uname }); const tb = $('#authTools', root); if (tb) tb.scrollIntoView({ block: 'nearest' }); };
      const sup = $('#li-ban-support', root);
      if (sup) sup.onclick = (ev) => { ev.preventDefault(); authTool(root, 'support'); };
      const st = $('#li-ban-status', root);
      if (st) st.onclick = (ev) => { ev.preventDefault(); authTool(root, 'status', { user: uname }); };
    } else { err.textContent = r.msg; err.hidden = false; }
  });
  root.querySelectorAll('[data-act]').forEach(el => el.addEventListener('click', () => {
    const act = el.getAttribute('data-act');
    if (act === 'go-register') showAuth('register');
    if (act === 'go-support') authTool(root, 'support');
    if (act === 'go-purchase') authTool(root, 'purchase');
    if (act === 'go-status') authTool(root, 'status');
    if (act === 'go-rebind') authTool(root, 'rebind');
  }));
};
/* 登录页四入口的同卡工具区（全状态可达：客服/购买/查询/换绑均不要求先登录） */
function authTool(root, kind, opts) {
  const box = $('#authTools', root); if (!box) return;
  if (kind === 'support') { box.innerHTML = ''; Views.support(box, null, 0, { guest: true }); return; }
  if (kind === 'purchase') { box.innerHTML = ''; Views.purchase(box, null, 0, { guest: true }); return; }
  if (kind === 'status') {
    box.innerHTML = `<div class="card" style="margin-top:16px"><h3>查询密钥（账号＋密码核验）</h3>
      <div class="field"><label>账号</label><input id="sq-user"></div>
      <div class="field"><label>密码</label><input id="sq-pass" type="password"></div>
      <button class="btn block" id="sq-btn">查询</button><div id="sq-out" style="margin-top:12px"></div></div>`;
    $('#sq-btn', box).onclick = async () => {
      const r = await api('/license/api/status/query', { method: 'POST', json: { username: $('#sq-user', box).value.trim(), password: $('#sq-pass', box).value } });
      $('#sq-out', box).innerHTML = r.json ? `<div class="note ${r.json.ok ? 'blue' : 'err'}">${esc(r.json.ok ? statusSummary(r.json) : (r.json.msg || '查询失败，请核对账号与密码。'))}</div>` : stateBox('暂时无法查询', '服务暂时不可用，请稍后再试。', false);
    };
    return;
  }
  if (kind === 'rebind') {
    box.innerHTML = `<div class="card" style="margin-top:16px"><h3>申诉换绑设备</h3>
      <p style="color:var(--sub);font-size:13.5px;margin-bottom:12px">请在<b>新设备</b>上提交：填写账号与密码核验身份，并填写本机设备码。审核通过后，同类槽位的旧设备将被替换，换绑不会被名额已满拦截。</p>
      <div class="field"><label>账号</label><input id="rb-user"></div>
      <div class="field"><label>密码</label><input id="rb-pass" type="password"></div>
      <div class="field"><label>本机设备码</label><input id="rb-dc" placeholder="在新设备的软件端查看"></div>
      <div class="field"><label>设备类型</label><select id="rb-platform"><option value="pc">电脑</option><option value="mobile">手机</option></select></div>
      <div class="field"><label>情况说明</label><textarea id="rb-desc" rows="2" placeholder="例如：更换了新电脑"></textarea></div>
      <button class="btn block" id="rb-btn">提交换绑申诉</button><div id="rb-out" style="margin-top:12px"></div></div>`;
    $('#rb-btn', box).onclick = async () => {
      const r = await api('/license/api/rebind/submit', { method: 'POST', json: { username: $('#rb-user', box).value.trim(), password: $('#rb-pass', box).value, desc: $('#rb-desc', box).value, deviceCode: $('#rb-dc', box).value.trim(), platform: $('#rb-platform', box).value, channel: 'web' } });
      $('#rb-out', box).innerHTML = `<div class="note ${r.json && r.json.ok ? 'ok' : 'err'}">${esc(r.json ? (r.json.msg || (r.json.ok ? '已提交，审核进度可在登录后「我的」中查看。' : '提交失败，请核对信息。')) : '服务暂时不可用，请稍后再试。')}</div>`;
    };
  }
  if (kind === 'appeal') {
    box.innerHTML = '';
    renderAppeal(box, opts || {});
    return;
  }
}
function statusSummary(j) {
  /* P2-031：status/query 的状态字段嵌在 view 下（/me 才是平铺），两形状兼容取数 */
  const v = (j && j.view) || j || {};
  const parts = [];
  if (v.planName) parts.push('套餐：' + v.planName);
  if (v.maskedKey && v.maskedKey !== '—') parts.push('密钥：' + v.maskedKey);
  if (v.displayStatus) parts.push('状态：' + v.displayStatus);
  if (v.keyExpiresMs) parts.push('到期：' + fmtDate(v.keyExpiresMs));
  else if (v.remainText) parts.push('有效期：' + v.remainText);
  if (typeof v.webEnabled === 'boolean') parts.push('网页版：' + (v.webEnabled ? (v.webBy === 'trial' ? '已开通（试用期内）' : '已开通') : '未开通'));
  return parts.length ? parts.join(' · ') : '已查询到您的密钥状态。';
}
/* 拦截判定：返回 gate 描述或 null（放行进首页） */
function gateFor(me) {
  if (!me || !me.ok) return null;
  if (me.activeBan) return { code: 'BAN', me };
  const d = me.decision || {};
  if (d.allow === false) {
    if (d.code === 'G5' || /过期/.test(d.msg || '')) return { code: 'G5', me };
    if (d.code === 'G2') return { code: 'G2', me };
    if (d.code === 'G4') return { code: 'G4', me };
    if (d.code === 'G1') return null; // #46：未激活只限功能、不限登录——落未激活首页（顶部「尚未激活」条，激活/购买入口可用），与启动恢复会话的落点一致
    return d.code ? { code: d.code, me } : null;
  }
  return null;
}
Views.gate = function (root, extra) {
  extra = extra || {}; const me = extra.me || S.license || {};
  const conf = {
    G1: { t: '尚未激活', b: '本账号还没有激活密钥。在下方输入密钥即可激活；没有密钥可以先购买，或使用积分兑换的密钥。' },
    G2: { t: '试用已到期', b: '免费试用已经结束。激活有效付费密钥后，即可继续使用网页版；积分兑换、赠送等免费来源密钥不包含网页版权益，无法用于开通网页版。' },
    G4: { t: '网页版尚未开通', b: '网页版需要真实付费购买密钥开通（赠送、活动发放与积分兑换等免费来源密钥不含网页版权益）。您仍可在软件端继续使用，或购买付费密钥后回到网页版。' },
    G5: { t: '密钥已过期', b: '您的密钥已于 ' + fmtDate(me.keyExpiresMs) + ' 到期。重新购买或兑换新密钥后即可继续使用。' },
    BAN: { t: '账号已被封禁', b: '封禁事由类别：' + esc((me.activeBan && (me.activeBan.category || me.activeBan.reason)) || '违反平台规则') + '。如有异议，可以提交申诉，审核结果将在申诉进度中显示。' },
    FROZEN: { t: '账号已被冻结', b: '冻结期间暂时无法登录使用，到期后自动解冻；也可以提交申诉提前处理。' }
  }[extra.code] || { t: '暂时无法进入', b: '当前状态下暂时无法进入控制台，请按下方入口处理。' };
  root.innerHTML = `<div class="authwrap"><div class="auth">${brandBlock()}
    <h1>${esc(conf.t)}</h1><p class="psub">${esc(S.displayName || S.user || '')}</p>
    <div class="note ${extra.code === 'BAN' || extra.code === 'FROZEN' ? 'err' : 'blue'}">${conf.b}</div>
    ${(extra.code === 'BAN' || extra.code === 'FROZEN')
      ? `<button class="btn block" id="gt-appeal">提交申诉</button>`
      : `<div class="field"><label>输入激活密钥</label><input id="gt-key" placeholder="粘贴完整密钥串"></div>
         <button class="btn block" id="gt-claim">激活并进入</button>
         <button class="btn block black" style="margin-top:12px" id="gt-buy">购买密钥</button>`}
    <button class="txtlink" id="gt-support">联系智能客服</button>
    <button class="txtlink" id="gt-logout">退出登录</button>
    <div id="gt-tools"></div>
  </div></div>`;
  const claim = $('#gt-claim', root);
  if (claim) claim.onclick = async () => {
    const key = $('#gt-key', root).value.trim();
    if (!key) { toast('请先粘贴密钥。', 'warn'); return; }
    const r = await api('/license/api/transfer/claim', { method: 'POST', json: { key } });
    if (r.json && r.json.ok) { toast('激活成功。', 'ok'); if (await checkSession(true)) { location.hash = '#home'; showShell(); } }
    else toast((r.json && r.json.msg) || '激活失败，请核对密钥后重试。', 'err');
  };
  const buy = $('#gt-buy', root); if (buy) buy.onclick = () => { const b = $('#gt-tools', root); b.innerHTML = ''; Views.purchase(b, null, 0, { guest: S.auth !== 'in' }); };
  const ap = $('#gt-appeal', root);
  if (ap) ap.onclick = () => { const b = $('#gt-tools', root); b.innerHTML = ''; renderAppeal(b, { user: S.user || '' }); };
  $('#gt-support', root).onclick = () => { const b = $('#gt-tools', root); b.innerHTML = ''; Views.support(b, null, 0, { guest: true }); };
  $('#gt-logout', root).onclick = () => doLogout();
};
Views.register = function (root) {
  root.innerHTML = `<div class="authwrap"><div class="auth">${brandBlock()}
    <h1>注册新账号</h1><p class="psub">注册成功后自动开通 3 天免费试用（自注册时刻起满 72 小时）</p>
    <form id="regForm">
      <div class="field"><label>账号</label><input id="rg-user" placeholder="至少 8 位字母与数字组合"><p class="hint">账号注册后不可更改，请谨慎填写。</p></div>
      <div class="field"><label>设置密码</label><input id="rg-pass" type="password" placeholder="请输入密码"></div>
      <div class="field"><label>确认密码</label><input id="rg-pass2" type="password" placeholder="请再次输入密码"></div>
      <label style="display:flex;gap:8px;font-size:13.5px;margin-bottom:14px"><input type="checkbox" id="rg-agree" style="accent-color:var(--brand);width:17px;height:17px">我已阅读并同意《用户协议》与《隐私说明》</label>
      <div class="note err" id="rg-err" hidden></div>
      <button class="btn block" id="rg-btn" type="submit">注册并开通试用</button>
    </form>
    <div class="authlinks"><span>已有账号？</span><a data-act="back">返回登录</a></div>
    <div class="note warn">同一设备与同一网络地址只能注册一个账号。如提示已注册，请使用原账号登录，或通过申诉处理。</div>
  </div></div>`;
  $('[data-act="back"]', root).onclick = () => showAuth('login');
  $('#regForm', root).addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#rg-err', root); err.hidden = true;
    const u = $('#rg-user', root).value.trim(), p1 = $('#rg-pass', root).value, p2 = $('#rg-pass2', root).value;
    const fail = m => { err.textContent = m; err.hidden = false; };
    if (!/^(?=.*[A-Za-z])(?=.*\d)[A-Za-z\d]{8,}$/.test(u)) return fail('账号需为至少 8 位字母与数字组合。');
    if (!p1 || p1.length < 6) return fail('密码长度不足，请设置至少 6 位密码。');
    if (p1 !== p2) return fail('两次输入的密码不一致。');
    if (!$('#rg-agree', root).checked) return fail('请先阅读并同意《用户协议》与《隐私说明》。');
    const btn = $('#rg-btn', root); btn.disabled = true; btn.textContent = '注册中…';
    const r = await api('/api/register', { method: 'POST', json: { username: u, password: p1 } });
    btn.disabled = false; btn.textContent = '注册并开通试用';
    if (r.json && r.json.ok) { toast('注册成功，已开通 3 天免费试用，请登录。', 'ok'); showAuth('login', { notice: '注册成功，请使用新账号登录。' }); }
    else fail((r.json && r.json.msg) || '注册未成功，请稍后再试。');
  });
};

/* ================= 首页（登录落点，#32） ================= */
Views.home = async function (view) {
  const lic = S.license || {};
  const name = esc(S.displayName || S.user || '');
  view.innerHTML = `
    <h1 class="pt">首页</h1><p class="psub">${greetWord()}，${name}。这是您的 QFRemote 总览，点开即在当前页面切换，不再整页跳转。</p>
    <div id="homeLic">${lic.hasKey ? '' : '<div class="skel" style="height:46px"></div>'}</div>
    <div class="card"><h3>账户安全</h3><div id="homeSec"><div class="skel" style="height:52px"></div></div></div>
    <div class="card"><h3>我的设备</h3><div id="homeDev"><div class="skel" style="height:52px"></div></div></div>
    <div class="card"><h3>付费与激活</h3><div id="homePay"><div class="skel" style="height:52px"></div></div></div>`;
  // 许可条
  const licBox = $('#homeLic', view);
  if (lic.hasKey) {
    const trial = /试用/.test(lic.planName || '');
    const stateTxt = (lic.displayStatus && lic.displayStatus !== '正常') ? lic.displayStatus : (lic.keyLifecycle === 'unactivated' ? '未激活' : (lic.displayStatus || '正常'));
    // #49 首页入口显隐（以 /license/api/me 当前生效钥为准）：永久套餐双入口
    // 皆不显示；时效套餐已激活（keyExpiresMs 已落点）只留「购买叠加」；
    // 试用中与时效未激活（持有未激活钥）按未激活对待，双入口保留。
    const perm = lic.keyPlan === 'permanent' || /永久/.test(lic.planName || '');
    let entries;
    if (perm) entries = '';
    else if (!trial && lic.keyExpiresMs) entries = '<button class="btn sm ghost" data-go="purchase">购买叠加</button>';
    else entries = '<button class="btn sm" data-go="profile">输入密钥激活</button> <button class="btn sm ghost" data-go="purchase">购买密钥</button>';
    licBox.innerHTML = `<div class="note ${trial ? 'blue' : 'ok'}"><b>${esc(lic.planName || '已激活')}</b> · ${esc(stateTxt)}${lic.remainText ? ' · ' + esc(lic.remainText) : (lic.keyExpiresMs ? ' · 到期：' + fmtDate(lic.keyExpiresMs) : '')}${lic.webEnabled ? '' : ' · 网页版购买付费密钥后开通'}${entries ? `<span style="float:right">${entries}</span>` : ''}</div>`;
  } else {
    licBox.innerHTML = `<div class="note warn"><b>尚未激活</b>　输入密钥激活后即可使用全部功能；没有密钥可以购买，或用积分兑换。<span style="float:right"><button class="btn sm" data-go="profile">输入密钥激活</button> <button class="btn sm ghost" data-go="purchase">购买密钥</button></span></div>`;
  }
  // 账户安全
  // 预取：首页即预热 name→id 映射，避免用户点设备时才冷启（手机每次开页都是冷页）
  fetchNodeMap().catch(() => {});
  const sec = $('#homeSec', view);
  const last = S.stats && S.stats.lastLoginMs ? fmtDate(S.stats.lastLoginMs) : '—';
  sec.innerHTML =
    rowHtml('shield', '账号状态', (lic.displayStatus || '正常') + (lic.everBanned ? ' · 该密钥曾被封禁（已恢复）' : ''), 'profile') +
    rowHtml('lock', '更改密码', '在「我的 · 账号与安全」中修改', 'profile') +
    rowHtml('file', '最近登录', last + ' · 本设备', 'profile');
  // 设备
  const devBox = $('#homeDev', view);
  const devs = (S.stats && S.stats.devices) || [];
  devBox.innerHTML = devs.length ? devs.map(d => devRowHtml(d)).join('') + `<p style="margin-top:10px"><button class="btn sm ghost" data-go="devices">查看全部设备</button></p>`
    : `<div class="statebox"><b>暂无设备</b><p>设备由站长分配或好友共享给您；被控端安装并上线后会出现在这里。</p></div>`;
  // 付费与激活
  const pay = $('#homePay', view);
  const pts = S.points && (S.points.balance != null ? S.points.balance : (S.points.points != null ? S.points.points : null));
  pay.innerHTML =
    rowHtml('key', '我的密钥', lic.hasKey ? (esc(lic.planName || '') + ' · ' + esc(lic.maskedKey || '')) : '尚未激活', 'profile') +
    rowHtml('cart', '购买密钥', '1 日 2 元 / 7 日 6 元 / 30 日 9.9 元 / 永久 18 元', 'purchase') +
    rowHtml('monitor', '设备名额', `电脑 ${lic.slots ? lic.slots.pc : 0} / ${lic.slots && lic.slots.pcMax ? lic.slots.pcMax : 2} · 手机 ${lic.slots ? lic.slots.mobile : 0} / ${lic.slots && lic.slots.mobileMax ? lic.slots.mobileMax : 1} · 网页版${lic.webEnabled ? '已开通' : '购买付费密钥后开通'}`, 'profile') +
    rowHtml('award', '积分与福利', pts != null ? `当前积分 ${pts} 分 · 200 分兑换 1 日密钥 / 500 分兑换 7 日密钥` : '签到与在线计时赚积分，积分可兑换密钥', 'points');
  view.querySelectorAll('[data-go]').forEach(el => el.addEventListener('click', () => navigate(el.getAttribute('data-go'))));
  bindDevRows(view);
};
function rowHtml(icon, t, s, go, anchor) {
  return `<button class="row" ${go ? `data-go="${go}"` : ''}${anchor ? ` data-anchor="${anchor}"` : ''}><span class="tile">${ic(icon)}</span><span><b>${esc(t)}</b><small>${esc(s)}</small></span><span class="chev">${ic('chevR')}</span></button>`;
}
/* 说明行专用（无落点、无行级操作）：渲染为普通 div、无箭头，避免「带箭头的
   button 却无点击处理」的死钮外观（P2-036/037/038/039 同族清零口径）。行下方
   另有真实操作按钮的标签行也用本式，操作仍走各自按钮。 */
function rowInfoHtml(icon, t, s) {
  return `<div class="row"><span class="tile">${ic(icon)}</span><span><b>${esc(t)}</b><small>${esc(s)}</small></span></div>`;
}
function devRowHtml(d) {
  /* 2.4.0 数据携带解析：渲染时能查到节点 id 就直接盖进按钮（data-nodeid），
     点按零等待；查不到的由 refreshDevRowIds 在节点图落地后补盖，再兜底 resolve 端点。 */
  const nid = d.nodeid ? bareNodeId(d.nodeid) : nodeIdFor(d.name);
  const nidAttr = nid ? ` data-nodeid="${esc(nid)}"` : '';
  return `<div class="dev"><span class="devic">${ic('monitor')}</span><span><b>${esc(d.name)}</b><small>${esc(d.os || '')}${d.group ? ' · 分组：' + esc(d.group) : ''}</small></span><span class="pill ${d.online ? 'ok' : 'off'}">${d.online ? '在线' : '离线'}</span><span class="ops">${d.online ? `<button class="btn sm" data-remote="${esc(d.name)}"${nidAttr}>远程桌面</button><button class="btn sm ghost" data-files="${esc(d.name)}"${nidAttr}>文件管理</button>` : '<span class="pill off">设备离线时不可连接</span>'}<button class="btn sm grey" data-detail="${esc(d.name)}">详情</button></span></div>`;
}
/* 点按反馈：立即置忙＋一句可见文案（本稿唯一新增可见文案，7 字内）＋6s 兜底恢复。
   跳转类（远程桌面/终端）走 CANON 导航，页面会离开，无需回收；导航类（文件/详情）
   走 SPA 内部 navigate，反馈仅作防连点用。 */
function bindDevRows(view) {
  const tap = (el, fn, feedback) => {
    el.onclick = () => {
      if (el.dataset.busy === '1') return; // 防连点重复跳转
      el.dataset.busy = '1';
      let tip = null;
      if (feedback && el.tagName === 'BUTTON') {
        el.disabled = true;
        tip = document.createElement('span');
        tip.className = 'qftap';
        tip.textContent = '正在打开…';
        tip.style.marginLeft = '6px';
        tip.style.opacity = '0.75';
        el.appendChild(tip);
      }
      const release = () => {
        el.dataset.busy = '';
        if (el.tagName === 'BUTTON') el.disabled = false;
        if (tip && tip.parentNode) tip.parentNode.removeChild(tip);
      };
      setTimeout(release, 6000); // 兜底：跳转被拦/失败时恢复可点
      try {
        const r = fn();
        if (r && typeof r.catch === 'function') r.catch(release);
      } catch (e) { release(); }
    };
  };
  view.querySelectorAll('[data-remote]').forEach(el => tap(el, () => openSession('desktop', { name: el.getAttribute('data-remote'), nodeid: el.getAttribute('data-nodeid') }), true));
  view.querySelectorAll('[data-terminal]').forEach(el => tap(el, () => openSession('terminal', { name: el.getAttribute('data-terminal'), nodeid: el.getAttribute('data-nodeid') }), true));
  view.querySelectorAll('[data-files]').forEach(el => tap(el, () => openSession('files', { name: el.getAttribute('data-files'), nodeid: el.getAttribute('data-nodeid') }), true));
  view.querySelectorAll('[data-detail]').forEach(el => tap(el, () => navigate('device', el.getAttribute('data-detail')), false));
}

/* 引擎同源入口（CANON）：会话融合视图的 iframe 与预热框都挂在本站同源的
   /console-engine 反代路径下（2026-10-28 域名修复口径）。旧「点设备顶层跳原生页」
   动线已于 2.4.0 退役：深链只在框内使用（/?node=<裸 id>&viewmode=<11|12|13>
   &qfm=frame&hide=31，见会话融合视图段）；顶层打开仅保留为哨兵错误卡里用户
   主动触发的兼容模式。viewmode 10＝原生设备页，融合视图永不使用。 */
const QF_CANON_ORIGIN = location.origin + '/console-engine'; // 2026-10-28 域名修复：原写死裸 IP 8443 废止，改同源 /console-engine（nginx 同源反代到原生页），桌面会话全程留在当前域名
/* 官网入口（站长 2026-10-26 11:12 令补）：三容器登出上方独立行＋「我的」页独立行，
   不进 MENU34、不占 BTABS，#34 次序不动；新标签打开官网。 */
const QF_WEBSITE_URL = 'https://qfremote.top/'; // 2026-10-28 域名修复：官网已迁 qfremote.top，不再跳 GitHub Pages 临时站
const websiteNavHtml = (cls) => `<a class="${cls || 'nav'}" href="${QF_WEBSITE_URL}" target="_blank" rel="noopener">${ic('globe')}<span>官方网站</span></a>`;
/* 站长管理入口补齐（站长 2026-10-26 12:58 亲报「网页版找不到站长管理」）：该入口原仅在
   桌面侧边栏（#sidebar）渲染，≤760px 时侧边栏整体隐藏，抽屉/账户菜单/底部标签/「我的」页
   均无此入口，站长手机端无路可达。按官网入口同例补为逻辑同位：仅 S.isAdmin 时在抽屉、
   账户菜单与「我的」页各补一行（导航容器互为同位呈现，不构成 #20 重复入口）；不进
   MENU34、不占 BTABS，#34 次序不动；目标为 SPA 内站长管理页（route=admin），服务端
   /home/api/stats 的 isAdmin 判定（账号===ADMIN_EMAIL 且 siteadmin 全权）未动。 */
/* ================= 会话融合视图（2.4.0：会话直达＋旧页关闭＋会话 UI 大改版） =================
   定稿依据：redesign-v2 FREEZE（站长 2026-10-26 点头冻结）＋ DS-DESIGN 适配 A1–A10
   ＋ phase-0 更正证据（E6–E9）。形态：#/session 单 iframe 同源融合——八入口点设备
   直达会话，MeshCentral 原生设备列表/详情退出用户路径（前置翻牌随 2.4.0 组装执行）。
   深链（E7 实测）：引擎根 /?node=<裸 id>&viewmode=<11|12|13>&qfm=frame&hide=31，
   hide=31 位掩码隐引擎外壳；形态切换走框内 go(vm)（463ms 实测），换 src 会断控制
   通道、禁用作常态路径。父页双层守卫：框内注入 CSS 压制 go() 复现的子导航条，
   URL 规范化守卫把框内逃逸拉回 hide 形态。
   id 解析序（根除 900ms 竞态）：入口数据携带 data-nodeid → 页内节点缓存 →
   ext 只读端点 GET /api/device/resolve 兜底；全程不回落老列表。
   预热（E8 承重项）：登录后隐藏框预热引擎源，会话打开时同设备同形态直接收编。 */
const QF_SESSION_VM = { desktop: 11, terminal: 12, files: 13 };
const QF_SESSION_KIND = { 11: 'desktop', 12: 'terminal', 13: 'files' };
/* 发送到手机的会话邀请走 #25 暂存通道（服务端零改动，toNode 为不透明字符串键）：
   本版寻址＝账号级 ctrl 邮箱（ctrl:account），同账号任一实例在「我的文件·待接收」
   可领取并打开会话；实例级 ctrl:<instanceId> 精确寻址待壳端实例注册表立项后深化。
   本机实例 id 键名登记：localStorage.qfCtrlInstanceId（≥128bit 随机，防未来撞键）。 */
const QF_CTRL_MAILBOX = 'ctrl:account';
function ctrlInstanceId() {
  try {
    let v = localStorage.getItem('qfCtrlInstanceId');
    if (!v) {
      const a = new Uint8Array(16);
      (window.crypto || {}).getRandomValues ? crypto.getRandomValues(a) : a.forEach((_, i) => a[i] = Math.floor(Math.random() * 256));
      v = Array.from(a).map(x => x.toString(16).padStart(2, '0')).join('');
      localStorage.setItem('qfCtrlInstanceId', v);
    }
    return v;
  } catch (e) { return ''; }
}
function bareNodeId(id) { return String(id || '').replace(/^node\/\//, '').replace(/^node\//, ''); }
function nodeIdFor(name) {
  if (!name || !nodeMapCache || !nodeMapCache.byName) return '';
  return bareNodeId(nodeMapCache.byName.get(name) || '');
}
/* 节点图落地后把 id 盖进已渲染的设备行按钮（数据携带解析的第一级来源） */
function refreshDevRowIds(root) {
  if (!nodeMapCache) return;
  (root || document).querySelectorAll('[data-remote],[data-terminal],[data-files]').forEach(el => {
    const nm = el.getAttribute('data-remote') || el.getAttribute('data-terminal') || el.getAttribute('data-files');
    const id = nodeIdFor(nm);
    if (id) el.setAttribute('data-nodeid', id);
  });
}
async function resolveDeviceId(name) {
  const r = await api('/api/device/resolve?name=' + encodeURIComponent(name || ''));
  if (r.json && typeof r.json === 'object') return r.json;
  return { ok: false, code: 'TIMEOUT' };
}
function sessionDeepLink(nodeid, vm) {
  return QF_CANON_ORIGIN + '/?node=' + encodeURIComponent(bareNodeId(nodeid)) + '&viewmode=' + vm + '&qfm=frame&hide=31';
}

/* ---------- 预热（phase-0 E8：Chromium 节流冷启 18–39s，预热是承重项） ---------- */
const QF_PRE = { frame: null, nodeid: '', vm: 0, ready: false, t0: 0, warmMs: 0 };
function startSessionPreheat() {
  if (QF_PRE.frame) return;
  const f = document.createElement('iframe');
  f.className = 'qf-preheat'; f.id = 'qfPreheat'; f.setAttribute('aria-hidden', 'true'); f.tabIndex = -1;
  QF_PRE.t0 = performance.now(); QF_PRE.ready = false;
  f.onload = () => { QF_PRE.ready = true; QF_PRE.warmMs = Math.round(performance.now() - QF_PRE.t0); };
  f.src = QF_CANON_ORIGIN + '/?hide=31&qfm=warm';
  document.body.appendChild(f);
  QF_PRE.frame = f;
}
function upgradePreheat(nodeid, vm) {
  const id = bareNodeId(nodeid);
  /* DS P1-1 硬门禁：会话已升格（Sess.active）或框已非预热态时，设备页的晚到
     回调绝不对活动会话框执行 replace 导航（串设备/断连）。 */
  if (Sess.active || !QF_PRE.frame || !QF_PRE.frame.classList.contains('qf-preheat')) return;
  if (!id) return;
  if (QF_PRE.nodeid === id && QF_PRE.vm === vm) return;
  QF_PRE.nodeid = id; QF_PRE.vm = vm; QF_PRE.ready = false; QF_PRE.t0 = performance.now();
  QF_PRE.frame.onload = () => { QF_PRE.ready = true; QF_PRE.warmMs = Math.round(performance.now() - QF_PRE.t0); };
  try { QF_PRE.frame.contentWindow.location.replace(sessionDeepLink(id, vm)); } catch (e) { QF_PRE.frame.src = sessionDeepLink(id, vm); }
}

/* ---------- 会话运行态 ---------- */
const Sess = {
  active: false, gen: 0, root: null, frame: null, adopted: false,
  name: '', nodeid: '', kind: 'desktop', vm: 11, linkedVm: 0, pendingVm: 0, pendingGen: 0,
  state: 'idle', t0: 0, connectMs: 0, reloaded: false, guardN: 0, guardToastShown: false,
  discN: 0, blankSince: 0, timers: [], listeners: [], kbMode: 'auto', trapArmed: false,
};
let QF_SESS_CTX = null;
function sessOn(target, type, fn, opts) { target.addEventListener(type, fn, opts); Sess.listeners.push([target, type, fn, opts]); }
function teardownSession() {
  Sess.gen++;
  Sess.timers.forEach(t => { clearInterval(t); clearTimeout(t); });
  Sess.timers = [];
  Sess.listeners.forEach(([t, ty, fn, o]) => { try { t.removeEventListener(ty, fn, o); } catch (e) {} });
  Sess.listeners = [];
  if (Sess.frame && Sess.frame === QF_PRE.frame) {
    /* 升格框降格回预热位：只改类名/样式/id（不移动节点、不换 src），文档与连接保持，
       下次同设备打开即零加载收编；异设备由 buildSessionFrame 换 src 一次导航。 */
    const f = Sess.frame;
    f.classList.remove('qf-session-frame'); f.classList.add('qf-preheat');
    f.removeAttribute('style'); f.id = 'qfPreheat'; f.setAttribute('aria-hidden', 'true'); f.tabIndex = -1;
    const bd = document.getElementById('qfSessBackdrop'); if (bd) bd.remove();
  }
  Sess.active = false; Sess.trapArmed = false; Sess.root = null; Sess.frame = null; Sess.adopted = false; Sess.state = 'idle';
  Sess.pendingVm = 0;   // DS P2-1：待办形态不跨会话残留
}

/* 八入口唯一收敛点：kind ∈ desktop/terminal/files；ctx.name 必备，ctx.nodeid 为数据携带 id（可缺） */
function openSession(kind, ctx) {
  ctx = ctx || {};
  const name = ctx.name || '';
  const nodeid = bareNodeId(ctx.nodeid || '') || nodeIdFor(name);
  QF_SESS_CTX = { kind: QF_SESSION_VM[kind] ? kind : 'desktop', name, nodeid };
  try { sessionStorage.removeItem('qfSessClosed'); } catch (e) {}
  if (!name && !nodeid) { navigate('devices'); return; }
  /* 已在会话中再开会话（换设备/邀请打开等）：原地切换，不走 hash 导航——引擎框是
     联合历史的最新导航者时，顶层 hash 赋值会被浏览器回卷并派发 popstate，把导航
     吞回旧会话（影子 rig 实证，联合历史污染即 phase-0 条 12 的本体）。 */
  if (Sess.active && S.route && S.route.name === 'session') {
    const view = $('#view');
    try { history.replaceState(null, '', '#session/' + encodeURIComponent(name || nodeid)); } catch (e) {}
    if (view) { Views.session(view, name || nodeid); return; }
  }
  navigate('session', name || nodeid);
  /* 兜底：hash 导航若仍被联合历史吞掉（会话未在 350ms 内激活），replaceState 复位后直渲 */
  setTimeout(() => {
    if (!Sess.active && QF_SESS_CTX && QF_SESS_CTX.name === name && QF_SESS_CTX.nodeid === nodeid) {
      try { history.replaceState(null, '', '#session/' + encodeURIComponent(name || nodeid)); } catch (e) {}
      render();
    }
  }, 350);
}

function sessionMarkup(name, kind) {
  const capLive = capBridgeLive();
  const capRows = QF_CAP_DEFS.map(c => {
    const on = sessCapOn(c.key);
    return `<li><div class="sv-opt sv-opt--set"><span class="sv-opt__ic">${ic(c.icon)}</span><span class="sv-opt__tx"><span class="sv-opt__n">${esc(c.name)}</span><span class="sv-opt__d">${esc(c.desc)}</span></span><span class="sv-opt__s${capLive && on ? ' sv-opt__s--ok' : ''}">${capLive ? (on ? '已开启' : '已关闭') : '未接入'}</span><button class="sv-opt__k" data-cap="${c.key}" role="switch" aria-checked="${on ? 'true' : 'false'}" aria-label="${esc(c.name)}开关"></button></div></li>`;
  }).join('');
  return `<div class="qf-session-layer"><div class="viewer" id="qfViewer" data-morph="${kind}" data-fs="false">
    <header class="sv-bar"><div class="sv-bar__inner">
      <button class="sv-iconbtn" data-act="back" aria-label="返回">${ic('back')}</button>
      <div class="sv-bar__id">
        <span class="sv-title" id="qfTitle">${esc(name || '设备')}</span>
        <span class="sv-badge sv-badge--wait" id="qfBadge" role="status"><i class="sv-badge__dot"></i><span id="qfBadgeTxt">连接中</span></span>
      </div>
      <button class="sv-iconbtn" data-act="fullscreen" aria-label="全屏">${ic('expand')}</button>
      <button class="sv-iconbtn sv-iconbtn--line" data-act="disconnect" aria-label="断开连接">${ic('power')}</button>
    </div></header>
    <main class="sv-stage" id="qfStage">
      <div class="sv-wall" aria-hidden="true"><span class="sv-wall__tag">${ic('monitor')}远程画面</span></div>
      <div class="sv-canvas qf-frame-slot" id="qfFrameSlot" aria-hidden="true"></div>
      <div class="sv-connecting" id="qfConnecting">
        <p class="sv-connecting__t">正在建立会话…</p>
        <p class="sv-connecting__d" id="qfConnDev">目标设备：${esc(name || '')}</p>
        <div class="sv-progress"><div class="sv-progress__bar"></div></div>
      </div>
      <div class="sv-strip" id="qfStrip" hidden><span class="sv-strip__spin"></span><span class="sv-strip__txt" id="qfStripTxt">连接中断，正在自动重连（第 1 次）</span></div>
      <div class="sv-mask" id="qfMask" hidden><div class="sv-card">
        <h2 class="sv-card__t" id="qfMaskT">无法建立会话</h2>
        <p class="sv-card__d" id="qfMaskD"></p>
        <div id="qfMaskCands"></div>
        <div class="sv-card__acts">
          <button class="sv-btn sv-btn--primary" data-act="retry">重试</button>
          <button class="sv-btn" data-act="mask-back">返回设备详情</button>
          <button class="sv-btn" data-act="compat" id="qfCompatBtn" hidden>兼容模式打开</button>
        </div>
      </div></div>
    </main>
    <form class="sv-input" id="qfInput" hidden>
      <input class="sv-input__field" id="qfInputField" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="send" placeholder="输入命令，点发送或回车落到终端">
      <button class="sv-iconbtn" type="button" data-act="keyboard" id="qfKbBtn" aria-label="召唤键盘">${ic('keyboard')}</button>
      <button class="sv-iconbtn sv-iconbtn--brand" type="submit" aria-label="发送">${ic('send')}</button>
    </form>
    <footer class="sv-tools">
      <div class="sv-seg" role="tablist" aria-label="会话形态">
        <button class="sv-seg__btn" role="tab" aria-selected="${kind === 'desktop'}" data-morph="desktop">${ic('monitor')}<span>桌面</span></button>
        <button class="sv-seg__btn" role="tab" aria-selected="${kind === 'terminal'}" data-morph="terminal">${ic('terminal')}<span>终端</span></button>
        <button class="sv-seg__btn" role="tab" aria-selected="${kind === 'files'}" data-morph="files">${ic('folder')}<span>文件</span></button>
      </div>
      <div class="sv-acts">
        <button class="sv-iconbtn sv-iconbtn--line sv-actbtn" data-act="settings" aria-label="设定">${ic('gear')}<span class="sv-actbtn__lbl">设定</span></button>
        <button class="sv-iconbtn sv-iconbtn--line sv-actbtn" data-act="send-to-phone" aria-label="发送到手机">${ic('phone')}<span class="sv-actbtn__lbl">发送到手机</span></button>
      </div>
    </footer>
    <button class="sv-fsx" data-act="exit-fullscreen" aria-label="退出全屏">${ic('expand')}<span class="sv-fsx__tx">退出全屏</span></button>
    <div class="sv-scrim" id="qfScrimSend" data-open="false" hidden><div class="sv-sheet" role="dialog" aria-modal="true" aria-labelledby="qfSendTtl">
      <div class="sv-sheet__grab"></div>
      <div class="sv-sheet__h"><div class="sv-sheet__hd"><h3 class="sv-sheet__ttl" id="qfSendTtl">发送到手机</h3></div><button class="sv-sheet__x" data-close="qfScrimSend" aria-label="关闭">${ic('x')}</button></div>
      <div class="sv-sheet__b">
        <div id="qfSendList">
          <ul class="sv-opts"><li><button class="sv-opt" role="radio" aria-checked="true"><span class="sv-opt__ic">${ic('phone')}</span><span class="sv-opt__tx"><span class="sv-opt__n">我的手机</span><span class="sv-opt__d">本账号手机控制器，在「我的文件 · 待接收」领取后打开会话</span></span><span class="sv-opt__r"></span></button></li></ul>
          <div style="height:14px"></div>
          <button class="sv-btn sv-btn--primary" id="qfSendGo">发送</button>
        </div>
        <div id="qfSendSent" hidden>
          <div class="sv-sheet__ok"><span class="sv-sheet__ok-ic">${ic('check')}</span><p class="sv-sheet__ok-tx">已发送到你的手机，正在打开远程桌面</p></div>
          <div style="height:14px"></div>
          <button class="sv-btn sv-btn--primary" data-close="qfScrimSend">完成</button>
        </div>
        <div id="qfSendFail" hidden>
          <div class="sv-sheet__fail"><span class="sv-sheet__fail-ic">${ic('x')}</span><p class="sv-sheet__fail-tx" id="qfSendFailTxt">指令未能送达手机，请稍后重试。</p></div>
          <div class="sv-state-acts">
            <button class="sv-btn sv-btn--primary" id="qfSendRetry">重试</button>
            <button class="sv-btn" data-close="qfScrimSend">关闭</button>
          </div>
        </div>
      </div>
    </div></div>
    <div class="sv-scrim" id="qfScrimSettings" data-open="false" hidden><div class="sv-sheet" role="dialog" aria-modal="true" aria-labelledby="qfSetTtl">
      <div class="sv-sheet__grab"></div>
      <div class="sv-sheet__h"><div class="sv-sheet__hd"><h3 class="sv-sheet__ttl" id="qfSetTtl">设定</h3></div><button class="sv-sheet__x" data-close="qfScrimSettings" aria-label="关闭">${ic('x')}</button></div>
      <div class="sv-sheet__b">
        <p class="sv-sheet__lbl">终端键盘</p>
        <ul class="sv-opts">
          <li><button class="sv-opt" data-kbmode="auto" role="radio" aria-checked="${Sess.kbMode !== 'manual'}"><span class="sv-opt__ic">${ic('keyboard')}</span><span class="sv-opt__tx"><span class="sv-opt__n">自动弹出</span><span class="sv-opt__d">点输入行即唤起键盘</span></span><span class="sv-opt__r"></span></button></li>
          <li><button class="sv-opt" data-kbmode="manual" role="radio" aria-checked="${Sess.kbMode === 'manual'}"><span class="sv-opt__ic">${ic('keyboard')}</span><span class="sv-opt__tx"><span class="sv-opt__n">仅点按召唤</span><span class="sv-opt__d">点键盘按钮才唤起，输入行键盘钮实底常亮</span></span><span class="sv-opt__r"></span></button></li>
        </ul>
        <p class="sv-sheet__lbl">${capLive ? '会话能力（全部保留，按新样式重排）' : '会话能力（未接入，仅记录偏好）'}</p>
        <ul class="sv-opts">${capRows}</ul>
      </div>
    </div></div>
    <div class="sv-scrim" id="qfScrimConfirm" data-open="false" hidden><div class="sv-sheet" role="dialog" aria-modal="true" aria-labelledby="qfCfTtl">
      <div class="sv-sheet__grab"></div>
      <div class="sv-sheet__h"><div class="sv-sheet__hd"><h3 class="sv-sheet__ttl" id="qfCfTtl">断开连接？</h3><p class="sv-sheet__sub">会话将被结束，你可以随时从设备详情重新连接。</p></div></div>
      <div class="sv-sheet__f">
        <button class="sv-btn sv-btn--danger" id="qfDiscGo">断开并返回</button>
        <button class="sv-btn" data-close="qfScrimConfirm">继续会话</button>
      </div>
    </div></div>
  </div></div>`;
}

/* 设定 sheet 能力项（G4：原生能力一项不丢；驱动桥见 sessApplyCap） */
const QF_CAP_DEFS = [
  { key: 'lock', name: '键鼠锁定', desc: '锁定被控端本地键鼠', icon: 'lock', def: true },
  { key: 'mute', name: '静音', desc: '关闭会话声音', icon: 'mute', def: false },
  { key: 'bell', name: '通知', desc: '被控端通知转发', icon: 'bell', def: true },
  { key: 'lang', name: '语言（输入法）', desc: '远端输入法切换', icon: 'globe', def: true },
  { key: 'reg', name: '注册表', desc: '远程注册表编辑', icon: 'file', def: false },
  { key: 'apps', name: '软件管理', desc: '被控端软件列表与卸载', icon: 'folder', def: false },
  { key: 'events', name: '事件日志', desc: '被控端系统事件查看', icon: 'file', def: false },
];
function sessCaps() {
  try { return JSON.parse(localStorage.getItem('qfSessCaps') || '{}'); } catch (e) { return {}; }
}
function sessCapOn(key) {
  const c = sessCaps();
  if (typeof c[key] === 'boolean') return c[key];
  const d = QF_CAP_DEFS.find(x => x.key === key);
  return d ? d.def : false;
}
/* 能力驱动桥：优先引擎未来钩子 QFCap(key,on)；其次原生设定对话框控件（选择器映射
   待翻牌日按 phase-0 SELECTORS 纪律实捕后填 QF_CAP_NATIVE_MAP）；都不可用时仅记录
   本地偏好，状态字示「未接入」，不假报已生效（DS P1-2）。 */
const QF_CAP_NATIVE_MAP = {};
/* 桥接实况（静态判定）：映射表为空期间，能力行一律按「未接入，仅记录偏好」
   降级展示；开关点击时逐次以 sessApplyCap 的真实返回值决定状态字。 */
function capBridgeLive() { return Object.keys(QF_CAP_NATIVE_MAP).length > 0; }
function sessApplyCap(key, on) {
  try {
    const w = Sess.frame && Sess.frame.contentWindow;
    if (w && typeof w.QFCap === 'function') { w.QFCap(key, on); return true; }
    const doc = Sess.frame && Sess.frame.contentDocument;
    const sel = QF_CAP_NATIVE_MAP[key];
    if (doc && sel) { const el = doc.querySelector(sel); if (el) { el.click(); return true; } }
  } catch (e) {}
  return false;
}

/* ---------- 会话视图 ---------- */
Views.session = async function (view, param) {
  teardownSession();
  const gen = Sess.gen;
  const ctx = (QF_SESS_CTX && (QF_SESS_CTX.name === param || QF_SESS_CTX.nodeid === param)) ? QF_SESS_CTX : null;
  if (!ctx && param) {
    let closed = '';
    try { closed = sessionStorage.getItem('qfSessClosed') || ''; } catch (e) {}
    if (closed && closed === param) { try { sessionStorage.removeItem('qfSessClosed'); } catch (e) {} navigate('devices'); return; }
  }
  const kind = ctx ? ctx.kind : 'desktop';
  let name = ctx ? (ctx.name || '') : '';
  let nodeid = ctx ? bareNodeId(ctx.nodeid || '') : '';
  if (!ctx && param) {
    /* DS P2-3：无 ctx 直达/刷新时 param 可能是裸 nodeid（邀请打开的会话
       URL 规范化为 #session/<nodeid>）——先按 id 反查设备名（byId 映射，
       邀请行同款口径），命中即按 id 定址，不再无条件当设备名解析。 */
    const byIdName = (nodeMapCache && nodeMapCache.byId && nodeMapCache.byId.get(bareNodeId(param))) || '';
    if (byIdName) { nodeid = bareNodeId(param); name = byIdName; }
  }
  if (!name && param && param !== nodeid) name = param;
  if (!nodeid && name) nodeid = nodeIdFor(name);
  Sess.active = true; Sess.name = name; Sess.nodeid = nodeid; Sess.kind = kind; Sess.vm = QF_SESSION_VM[kind] || 11;
  try { Sess.kbMode = localStorage.getItem('qfKbMode') || 'auto'; } catch (e) { Sess.kbMode = 'auto'; }
  view.innerHTML = sessionMarkup(name, kind);
  const layerEl = view.querySelector('.qf-session-layer');
  if (layerEl) layerEl.classList.add('qf-ext');   // 会话框为 body 级升格框：层转透明让位（见 session.css 正式版补充 3）
  Sess.root = $('#qfViewer', view);
  wireSession(view);
  history.pushState({ qfSessTrap: 1 }, '', location.href);
  Sess.trapArmed = true;
  if (!nodeid && name) {
    const r = await resolveDeviceId(name).catch(() => ({ ok: false, code: 'TIMEOUT' }));
    if (gen !== Sess.gen || !Sess.active) return;
    if (r && r.ok && r.nodeid) { nodeid = bareNodeId(r.nodeid); Sess.nodeid = nodeid; if (r.name) { Sess.name = r.name; const t = $('#qfTitle', view); if (t) t.textContent = r.name; } }
    else if (r && r.code === 'NOT_FOUND' && !ctx && param && name === param) {
      /* DS P2-3 兜底：名称解析已确证无此设备名的深链 param 按裸 nodeid
         直达（映射未预热时 byId 反查未命中走此路），不再假报未找到。 */
      nodeid = bareNodeId(param); Sess.nodeid = nodeid;
    }
    else { if (r && r.nodeid) Sess.nodeid = bareNodeId(r.nodeid); showSessionMask(view, (r && r.code) || 'TIMEOUT', r); return; }   // DS P2-2：OFFLINE 等失败响应带 nodeid 时先落 Sess.nodeid，邀请不再必空
  }
  if (!nodeid) { showSessionMask(view, 'NOT_FOUND', null); return; }
  buildSessionFrame(view);
};

function sessionDeepLinkCurrent() { return sessionDeepLink(Sess.nodeid, Sess.vm); }
/* 框导航唯一通道：恒走框内 location.replace —— 框 src 赋值会在联合历史里新增条目，
   且当框的当前条目落后于顶层条目时，提交瞬间把顶层 URL 回卷到框上次导航时的位置
   （影子 rig 实证：会话中切换设备被打回旧会话），replace 只覆写框的当前条目、
   不新增、不回卷（phase-0 条 12「SPA 接管返回语义」的落地式）。 */
function frameNavigate(url) {
  const f = Sess.frame || QF_PRE.frame;
  if (!f) return;
  try { f.contentWindow.location.replace(url); return; } catch (e) {}
  try { f.src = url; } catch (e) {}
}

function buildSessionFrame(view) {
  Sess.pendingVm = 0;   // DS P2-1：新一轮构建起算，旧待办形态清零
  Sess.t0 = performance.now(); Sess.state = 'connecting'; Sess.reloaded = false; Sess.guardN = 0; Sess.discN = 0; Sess.blankSince = 0;
  /* 新一轮构建取代旧终态卡（如从候选列表点选进入）：先收卡，失败再由哨兵重新升卡 */
  const m0 = view.querySelector('#qfMask'); if (m0) m0.hidden = true; Sess.mask = null;
  /* 会话框恒为 body 级永驻框（预热框原地升格）：iframe 换父节点必被浏览器重载
     （影子 rig 微实测证实），故全程不移动节点——同设备同形态直接升格续用，
     异设备只换 src（一次正当导航）。层内 #qfFrameSlot 只作几何标尺。 */
  if (!QF_PRE.frame) startSessionPreheat();
  const f = QF_PRE.frame;
  Sess.linkedVm = Sess.vm;
  if (QF_PRE.nodeid !== Sess.nodeid || QF_PRE.vm !== Sess.vm) {
    QF_PRE.nodeid = Sess.nodeid; QF_PRE.vm = Sess.vm; QF_PRE.ready = false; QF_PRE.t0 = performance.now();
    f.onload = () => { QF_PRE.ready = true; QF_PRE.warmMs = Math.round(performance.now() - QF_PRE.t0); onFrameLoad(view); };
    Sess.frame = f;
    frameNavigate(sessionDeepLinkCurrent());
  } else {
    f.onload = () => onFrameLoad(view);
    onFrameLoad(view);
  }
  let bd = document.getElementById('qfSessBackdrop');
  if (!bd) { bd = document.createElement('div'); bd.id = 'qfSessBackdrop'; bd.className = 'qf-session-backdrop'; }
  if (bd.nextSibling !== f) f.parentNode.insertBefore(bd, f);
  f.classList.remove('qf-preheat'); f.classList.add('qf-session-frame');
  f.id = 'qfFrame'; f.title = '远程画面'; f.setAttribute('aria-label', '远程画面');
  f.removeAttribute('aria-hidden'); f.tabIndex = 0;
  Sess.frame = f; Sess.adopted = true;
  /* 顶层 URL 规范化：本会话路由应恒为当前会话（防引擎内部历史回卷，条 12） */
  try { const want = '#session/' + encodeURIComponent(Sess.name || Sess.nodeid); if (location.hash !== want) history.replaceState(null, '', want); } catch (e) {}
  syncSessionFrameGeometry();
  setTimeout(() => syncSessionFrameGeometry(), 80);
  startSentinel(view);
}
/* 会话框几何 = 层内标尺槽的视口矩形（槽带 .sv-canvas 类，几何与 DS 画布全等） */
function syncSessionFrameGeometry() {
  const f = Sess.frame, slot = document.getElementById('qfFrameSlot');
  if (!f || !slot || !slot.isConnected) return;
  const r = slot.getBoundingClientRect();
  f.style.left = r.left + 'px'; f.style.top = r.top + 'px';
  f.style.width = Math.max(0, Math.round(r.width)) + 'px'; f.style.height = Math.max(0, Math.round(r.height)) + 'px';
  try { const br = getComputedStyle(slot).borderRadius; if (br) f.style.borderRadius = br; } catch (e) {}
}

function onFrameLoad(view) {
  injectFrameGuard();
  if (Sess.pendingVm) {
    const pv = Sess.pendingVm, pg = Sess.pendingGen;
    Sess.pendingVm = 0;
    /* DS P2-1：消费时校验世代——待办形态须为当前会话世代登记者，
       跨会话/跨构建残留一律丢弃，不把下一会话切去旧形态。 */
    if (pv !== Sess.linkedVm && pg === Sess.gen) { Sess.linkedVm = pv; tryGo(pv); }
  }
}
function injectFrameGuard() {
  try {
    const doc = Sess.frame && Sess.frame.contentDocument;
    if (!doc || !doc.head || doc.getElementById('qfGuardStyle')) return;
    const st = doc.createElement('style');
    st.id = 'qfGuardStyle';
    st.textContent = '#masthead,#page_leftbar,#topbar,#footer{display:none!important}';
    doc.head.appendChild(st);
  } catch (e) {}
}
function tryGo(vm) {
  try {
    const w = Sess.frame && Sess.frame.contentWindow;
    if (w && typeof w.go === 'function') { w.go(vm); return true; }
  } catch (e) {}
  return false;
}

/* 哨兵：onload＋8 秒同源尺寸/结构观察＋一次自动重载＋三级错误卡（空白/被拒/无 id），
   兼容模式顶层打开为用户主动触发的第 3 级（DS-DESIGN 哨兵规格）。 */
function startSentinel(view) {
  let tickN = 0;
  const tick = () => {
    if (!Sess.active || !Sess.frame) return;
    tickN++;
    Sess.timers.push(setTimeout(tick, tickN < 12 ? 250 : 700));   // 前密后疏：连接建立期 250ms 密探（徽标时延），稳定后 700ms
    /* 顶层 URL 规范化守卫（条 12）：引擎内部历史若把顶层 URL 回卷到别处，
       以 replaceState 静默复位本会话路由（不触发渲染）；用户退出走 popstate
       链与 exitSession（Sess.active 先置假），不被本守卫打架。 */
    try { const want = '#session/' + encodeURIComponent(Sess.name || Sess.nodeid); if (location.hash !== want) history.replaceState(null, '', want); } catch (e) {}
    injectFrameGuard();
    /* URL 规范化守卫：框内逃逸（丢 qfm 标记）拉回 hide 形态，上限 3 次防循环 */
    try {
      const href = Sess.frame.contentWindow.location.href;
      if (href && href.indexOf('about:blank') !== 0 && href.indexOf('qfm=') < 0 && Sess.state !== 'failed' && Sess.guardN < 3) {
        Sess.guardN++;
        frameNavigate(sessionDeepLinkCurrent());
        if (!Sess.guardToastShown) { Sess.guardToastShown = true; toast('已回到会话界面。', 'info'); }
        return;
      }
    } catch (e) {}
    const p = probeFrame();
    const now = performance.now();
    if (p === 'reject') { Sess.state = 'failed'; showSessionMask(view, 'REJECT', null); return; }
    if (Sess.state === 'connecting') {
      if (p === 'connected') { setConnected(view); return; }
      if (now - Sess.t0 > 8000) {
        if (!Sess.reloaded) {
          Sess.reloaded = true; Sess.t0 = now;
          try { frameNavigate(sessionDeepLinkCurrent()); } catch (e) {}
        } else { Sess.state = 'failed'; showSessionMask(view, 'FAIL', null); return; }
      }
    } else if (Sess.state === 'connected') {
      if (p === 'lost') { setLost(view); return; }
      if (p === 'blank') {
        if (!Sess.blankSince) Sess.blankSince = now;
        else if (now - Sess.blankSince > 16000) { Sess.state = 'failed'; showSessionMask(view, 'FAIL', null); return; }
      } else Sess.blankSince = 0;
    } else if (Sess.state === 'lost') {
      if (p === 'connected') { setConnected(view); return; }
    }
  };
  Sess.timers.push(setTimeout(tick, 250));
}
function probeFrame() {
  let doc = null, w = null;
  try { w = Sess.frame.contentWindow; doc = Sess.frame.contentDocument; } catch (e) { return 'blank'; }
  if (!doc || !doc.body) return 'blank';
  /* 身份先行：框内当前文档必须是本会话目标设备的融合页——预热暖页（qfm=warm）
     本身也带桌面画布与 Connected 字样，帧导航未提交时误判「已连接」即假绿
     （影子 rig 重载荷实证）。非目标文档一律按绑定中处理。 */
  try {
    const href = String(w.location.href || '');
    if (href.indexOf('node=' + Sess.nodeid) < 0 || href.indexOf('qfm=frame') < 0) return 'binding';
  } catch (e) { return 'binding'; }
  try {
    if (/login/i.test(w.location.pathname || '') || doc.querySelector('#loginform, form[action*="login" i]')) return 'reject';
  } catch (e) {}
  const st = doc.querySelector('#deskstatus');
  const stTxt = st ? String(st.textContent || '') : '';
  if (/disconnect|not connected|断开|未连接/i.test(stTxt)) return 'lost';
  const desk = doc.querySelector('#Desk');
  /* 桌面形态的「已连接」须状态文本给出完整 Connected（Connecting 不算）且画布有尺寸：
     画布元素在文档刚提交时即带属性尺寸，仅凭画布判连会在引擎尚在加载时假绿（rig 实证） */
  if (Sess.vm === 11 && desk && desk.width > 10 && desk.height > 10 && (/^\s*connected\b/i.test(stTxt) || stTxt.indexOf('已连接') >= 0)) return 'connected';
  if (Sess.vm === 12) { const p12 = doc.querySelector('#p12'); if (p12 && p12.offsetParent !== null) return 'connected'; }
  if (Sess.vm === 13) { const p13 = doc.querySelector('#p13'); if (p13 && p13.offsetParent !== null) return 'connected'; }
  if (desk || doc.querySelector('#p11')) return 'binding';
  return 'blank';
}
function setBadge(view, kind, txt) {
  const b = $('#qfBadge', view); if (!b) return;
  b.className = 'sv-badge' + (kind ? ' sv-badge--' + kind : '');
  const t = $('#qfBadgeTxt', view); if (t) t.textContent = txt;
}
function setConnected(view) {
  Sess.state = 'connected';
  Sess.connectMs = Math.round(performance.now() - Sess.t0);
  const c = $('#qfConnecting', view); if (c) c.hidden = true;
  const s = $('#qfStrip', view); if (s) s.hidden = true;
  setBadge(view, '', '已连接');
  if (Sess.name) { try { localStorage.setItem('qfLastSessionDevice', Sess.name); } catch (e) {} }
}
function setLost(view) {
  Sess.state = 'lost';
  Sess.discN++;
  const s = $('#qfStrip', view); if (s) s.hidden = false;
  const t = $('#qfStripTxt', view); if (t) t.textContent = '连接中断，正在自动重连（第 ' + Sess.discN + ' 次）';
  setBadge(view, 'retry', '重连中');
}
function showSessionMask(view, code, r) {
  const m = $('#qfMask', view); if (!m) return;
  const T = $('#qfMaskT', view), D = $('#qfMaskD', view), cands = $('#qfMaskCands', view);
  const retry = view.querySelector('[data-act="retry"]'), back = view.querySelector('[data-act="mask-back"]'), compat = $('#qfCompatBtn', view);
  const cn = $('#qfConnecting', view); if (cn) cn.hidden = true;
  if (cands) cands.innerHTML = '';
  if (compat) compat.hidden = true;
  if (retry) retry.className = 'sv-btn sv-btn--primary';
  if (back) back.className = 'sv-btn';
  Sess.maskCode = code;
  if (code === 'REJECT') {
    T.textContent = '无法建立会话';
    D.textContent = '你没有这台设备的远程控制权限，请联系设备管理员为你开通。';
    if (back) back.className = 'sv-btn sv-btn--primary';
    if (retry) retry.className = 'sv-btn';
  } else if (code === 'OFFLINE') {
    T.textContent = '设备当前不在线';
    D.textContent = '设备离线时无法建立会话，请确认设备已开机并联网后重试。';
    if (back) back.className = 'sv-btn sv-btn--primary';
    if (retry) retry.className = 'sv-btn';
  } else if (code === 'AMBIGUOUS') {
    T.textContent = '找到多台同名设备';
    D.textContent = '请选择要连接的设备：';
    if (cands && r && Array.isArray(r.candidates)) {
      cands.innerHTML = r.candidates.map(c => `<button class="sv-btn" data-cand="${esc(c.nodeid)}" style="margin:4px 4px 0 0">${esc(c.name || c.nodeid)}${c.online ? '' : '（离线）'}</button>`).join('');
      cands.querySelectorAll('[data-cand]').forEach(b => b.onclick = () => {
        Sess.nodeid = bareNodeId(b.getAttribute('data-cand'));
        m.hidden = true;
        const cn2 = $('#qfConnecting', view); if (cn2) cn2.hidden = false;
        buildSessionFrame(view);
      });
    }
  } else if (code === 'NOT_FOUND') {
    T.textContent = '无法定位这台设备';
    D.textContent = '未能取得设备的连接标识，请稍后重试，或使用兼容模式打开。';
    if (compat) compat.hidden = false;
  } else { /* FAIL / TIMEOUT */
    T.textContent = '会话组件加载失败';
    D.textContent = '请检查网络后重试。';
    if (compat) compat.hidden = false;
  }
  m.hidden = false;
}

/* ---------- 会话内交互 ---------- */
function wireSession(view) {
  const root = Sess.root;
  const SCRIMS = ['qfScrimSend', 'qfScrimSettings', 'qfScrimConfirm'];
  const openSheet = (id) => SCRIMS.forEach(s => { const el = document.getElementById(s); if (!el) return; if (s === id) { el.hidden = false; void el.offsetWidth; el.dataset.open = 'true'; } else { el.dataset.open = 'false'; el.hidden = true; } });
  const closeSheet = (id) => { const el = document.getElementById(id); if (el) { el.dataset.open = 'false'; el.hidden = true; } };
  const closeAllSheets = () => SCRIMS.forEach(s => closeSheet(s));
  const anySheetOpen = () => SCRIMS.some(s => { const el = document.getElementById(s); return el && el.dataset.open === 'true'; });
  Sess._closeAllSheets = closeAllSheets; Sess._anySheetOpen = anySheetOpen;
  root.querySelectorAll('[data-close]').forEach(b => b.onclick = () => closeSheet(b.getAttribute('data-close')));
  root.querySelectorAll('.sv-seg__btn').forEach(b => b.onclick = () => setMorph(view, b.getAttribute('data-morph')));
  const act = (n) => root.querySelector('[data-act="' + n + '"]');
  act('settings').onclick = () => openSheet('qfScrimSettings');
  act('send-to-phone').onclick = () => { resetSendSheet(view); openSheet('qfScrimSend'); };
  act('fullscreen').onclick = () => setFs(view, root.dataset.fs !== 'true');
  act('exit-fullscreen').onclick = () => setFs(view, false);
  act('disconnect').onclick = () => openSheet('qfScrimConfirm');
  act('back').onclick = () => { if (!sessionBackChain(view)) exitSession(); };
  act('retry').onclick = () => retryFromMask(view);
  act('mask-back').onclick = () => exitSession();
  act('compat').onclick = () => {
    /* 兼容模式＝用户主动触发的顶层打开（哨兵第 3 级），离开融合视图、事后审计有记 */
    const url = Sess.nodeid ? sessionDeepLink(Sess.nodeid, Sess.vm).replace('&qfm=frame&hide=31', '') : QF_CANON_ORIGIN;
    location.assign(url);
  };
  $('#qfDiscGo', view).onclick = () => exitSession();
  wireSendSheet(view);
  /* 设定：终端键盘二选项（DS2 §1.3/§4.3；[data-kb="manual"] 机制，D-11） */
  root.querySelectorAll('[data-kbmode]').forEach(o => o.onclick = () => {
    Sess.kbMode = o.getAttribute('data-kbmode');
    try { localStorage.setItem('qfKbMode', Sess.kbMode); } catch (e) {}
    root.querySelectorAll('[data-kbmode]').forEach(x => x.setAttribute('aria-checked', x === o ? 'true' : 'false'));
    updateKbBtn(view);
  });
  updateKbBtn(view);
  /* 设定：能力开关（偏好持久化＋驱动桥尝试）。DS P1-2：先问驱动桥，
     sessApplyCap 返回 false（桥未接入）时状态字只示「未接入」——开关
     只记偏好，绝不置「已开启/已关闭」生效态、不丢弃 false 返回。 */
  root.querySelectorAll('[data-cap]').forEach(o => o.onclick = () => {
    const key = o.getAttribute('data-cap');
    const on = o.getAttribute('aria-checked') !== 'true';
    const applied = sessApplyCap(key, on);
    o.setAttribute('aria-checked', on ? 'true' : 'false');
    const c = sessCaps(); c[key] = on;
    try { localStorage.setItem('qfSessCaps', JSON.stringify(c)); } catch (e) {}
    const chip = o.parentElement.querySelector('.sv-opt__s');
    if (chip) {
      if (applied) { chip.textContent = on ? '已开启' : '已关闭'; chip.classList.toggle('sv-opt__s--ok', on); }
      else { chip.textContent = '未接入'; chip.classList.remove('sv-opt__s--ok'); }
    }
  });
  /* 终端输入行（bp-form 820 以下、终端形态显示；DS2 §4.3 软键盘 dvh 锁高在下方视口监听） */
  const form = $('#qfInput', view), field = $('#qfInputField', view);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = field.value;
    if (!v) return;
    /* DS P2-4：发送失败必须可见——不清空输入行、明示未送达，不静默吞。 */
    if (sendTermText(v + '\r')) field.value = '';
    else toast('未能送入终端（终端输入未就绪），内容已保留在输入行，连接稳定后请重试。', 'warn');
  });
  $('#qfKbBtn', view).onclick = () => { field.focus(); };
  field.addEventListener('focus', () => { if (Sess.kbMode === 'auto') updateKbBtn(view); });
  /* 返回链（A4 合并）：sheet → 全屏 → 断开确认 → 设备详情（确认已开时再退＝真退出）。
     浏览器返回先于本处理把 URL 改到上一条，链内消化时以 pushState 复位会话 URL
     （伴随的同会话渲染由 render 的活性守卫跳过）；链走完直接 exitSession 收尾。 */
  sessOn(window, 'popstate', () => {
    if (!Sess.active || !Sess.trapArmed) return;
    if (sessionBackChain(view)) {
      history.pushState({ qfSessTrap: 1 }, '', '#session/' + encodeURIComponent(Sess.name || Sess.nodeid));
    } else { Sess.trapArmed = false; exitSession(); }
  });
  sessOn(document, 'fullscreenchange', () => {
    if (!Sess.active) return;
    root.dataset.fs = document.fullscreenElement ? 'true' : 'false';
    setTimeout(() => syncSessionFrameGeometry(), 60);
  });
  sessOn(window, 'resize', () => syncSessionFrameGeometry());
  sessOn(document, 'keydown', (e) => {
    if (!Sess.active || e.key !== 'Escape') return;
    if (anySheetOpen()) { closeAllSheets(); return; }
    if (root.dataset.fs === 'true') setFs(view, false);
  });
  /* 软键盘弹出时以 visualViewport 高度锁定会话层（dvh 锁高，DS2 §4.3） */
  if (window.visualViewport) {
    const layer = view.querySelector('.qf-session-layer');
    const onVv = () => {
      if (!Sess.active || !layer) return;
      const vv = window.visualViewport;
      if (vv.height < window.innerHeight * 0.78) { layer.style.height = vv.height + 'px'; layer.style.top = vv.offsetTop + 'px'; }
      else { layer.style.height = ''; layer.style.top = ''; }
      syncSessionFrameGeometry();
    };
    sessOn(window.visualViewport, 'resize', onVv);
  }
  applyMorphChrome(view);
}
function sessionBackChain(view) {
  /* 返回 true＝链内消化（留在会话）；false＝链已走完（应退出到设备详情） */
  if (Sess._anySheetOpen && Sess._anySheetOpen()) {
    const c = document.getElementById('qfScrimConfirm');
    if (c && c.dataset.open === 'true') { Sess._closeAllSheets(); return false; }
    Sess._closeAllSheets(); return true;
  }
  if (Sess.root && Sess.root.dataset.fs === 'true') { setFs(view, false); return true; }
  const c = document.getElementById('qfScrimConfirm');
  if (c) { c.hidden = false; void c.offsetWidth; c.dataset.open = 'true'; }
  return true;
}
function retryFromMask(view) {
  const m = $('#qfMask', view); if (m) m.hidden = true;
  const cn = $('#qfConnecting', view); if (cn) cn.hidden = false;
  setBadge(view, 'wait', '连接中');
  if ((Sess.maskCode === 'NOT_FOUND' || Sess.maskCode === 'OFFLINE' || Sess.maskCode === 'TIMEOUT' || Sess.maskCode === 'AMBIGUOUS') && Sess.name && !Sess.nodeid) {
    const gen = Sess.gen;
    resolveDeviceId(Sess.name).then(r => {
      if (gen !== Sess.gen || !Sess.active) return;
      if (r && r.ok && r.nodeid) { Sess.nodeid = bareNodeId(r.nodeid); buildSessionFrame(view); }
      else showSessionMask(view, (r && r.code) || 'TIMEOUT', r);
    }).catch(() => { if (gen === Sess.gen) showSessionMask(view, 'TIMEOUT', null); });
    return;
  }
  if (Sess.frame && Sess.nodeid) { Sess.state = 'connecting'; Sess.t0 = performance.now(); Sess.reloaded = true; try { frameNavigate(sessionDeepLinkCurrent()); } catch (e) {} }
  else if (!Sess.frame && Sess.nodeid) buildSessionFrame(view);
}
function exitSession() {
  const name = Sess.name;
  teardownSession();
  QF_SESS_CTX = null;
  /* A4 收尾：当前条目 replaceState 为设备详情（不留会话条目）；历史里更深一层的
     旧会话条目以 sessionStorage 关闭标记拦截重开（Views.session 入口校验）。 */
  try { sessionStorage.setItem('qfSessClosed', name || ''); } catch (e) {}
  try { history.replaceState(null, '', name ? ('#device/' + encodeURIComponent(name)) : '#devices'); } catch (e) {}
  render();
  startSessionPreheat();
}
function setFs(view, on) {
  const root = Sess.root; if (!root) return;
  root.dataset.fs = on ? 'true' : 'false';
  setTimeout(() => syncSessionFrameGeometry(), 60);
  try {
    if (on) { const p = root.requestFullscreen && root.requestFullscreen(); if (p && p.catch) p.catch(() => {}); }
    else if (document.fullscreenElement) { const p = document.exitFullscreen(); if (p && p.catch) p.catch(() => {}); }
  } catch (e) {}
}
function applyMorphChrome(view) {
  const form = $('#qfInput', view);
  if (form) form.hidden = !(Sess.kind === 'terminal' && window.matchMedia && window.matchMedia('(max-width: 820px)').matches);
  if (Sess.kind === 'terminal' && Sess.kbMode === 'auto' && window.matchMedia && window.matchMedia('(max-width: 820px)').matches) {
    const f = $('#qfInputField', view); if (f) setTimeout(() => { try { f.focus({ preventScroll: true }); } catch (e) {} }, 350);
  }
}
function setMorph(view, kind) {
  if (!QF_SESSION_VM[kind] || kind === Sess.kind) return;
  Sess.kind = kind; Sess.vm = QF_SESSION_VM[kind];
  Sess.root.dataset.morph = kind;
  Sess.root.querySelectorAll('.sv-seg__btn').forEach(b => b.setAttribute('aria-selected', b.getAttribute('data-morph') === kind ? 'true' : 'false'));
  applyMorphChrome(view);
  syncSessionFrameGeometry();
  if (Sess.frame && Sess.linkedVm !== Sess.vm) {
    if (tryGo(Sess.vm)) { Sess.linkedVm = Sess.vm; }
    else if (Sess.state === 'connected' || Sess.state === 'lost') {
      /* go() 不可用（引擎未就绪/异版）：退化换链重建（会断连，非常态路径，仅兜底） */
      Sess.linkedVm = Sess.vm; Sess.state = 'connecting'; Sess.t0 = performance.now();
      const cn = $('#qfConnecting', view); if (cn) cn.hidden = false;
      setBadge(view, 'wait', '连接中');
      frameNavigate(sessionDeepLinkCurrent());
    } else { Sess.pendingVm = Sess.vm; Sess.pendingGen = Sess.gen; }
  }
}
function updateKbBtn(view) {
  const b = $('#qfKbBtn', view);
  if (b) b.classList.toggle('sv-iconbtn--brand', Sess.kbMode === 'manual');
}
/* 终端输入转发：只认框内终端真实输入元（insertText 且查其返回值）；
   引擎终端输入元选择器以翻牌日实捕为准（phase-0 SELECTORS 纪律）。
   DS P2-4/欠账③降级：无真实输入元命中即 return false，绝不向文档盲派
   键盘事件假报成功；失败由调用方明示（输入行保留内容＋提示）。 */
function sendTermText(text) {
  let doc = null;
  try { doc = Sess.frame.contentDocument; } catch (e) { return false; }
  if (!doc) return false;
  try {
    const ta = doc.querySelector('#p12 textarea, #p12 input[type="text"], textarea.xterm-helper-textarea, #termInput');
    if (!ta) return false;
    ta.focus();
    return !!doc.execCommand('insertText', false, text);
  } catch (e) { return false; }
}
/* 发送到手机（会话邀请）：四态 idle/picking/sending/sent/failed，失败文案照 DS2 §2.6 */
function resetSendSheet(view) {
  const l = $('#qfSendList', view), s = $('#qfSendSent', view), f = $('#qfSendFail', view);
  if (l) l.hidden = false; if (s) s.hidden = true; if (f) f.hidden = true;
  const go = $('#qfSendGo', view); if (go) { go.disabled = false; go.textContent = '发送'; }
}
function wireSendSheet(view) {
  const go = $('#qfSendGo', view); if (!go || go._qfWired) return; go._qfWired = true;
  go.onclick = async () => {
    if (!Sess.nodeid) {
      /* DS P2-2：nodeid 未解析（连接中/解析中/离线卡）时不发空邀请，
         提交处直接失败提示，不生成 qf-invite-.json 空载荷。 */
      const l = $('#qfSendList', view), f = $('#qfSendFail', view), ft = $('#qfSendFailTxt', view);
      if (ft) ft.textContent = '设备连接尚未就绪，暂时无法发送邀请，请等会话连接建立后再试。';
      if (l) l.hidden = true; if (f) f.hidden = false;
      return;
    }
    const ft0 = $('#qfSendFailTxt', view); if (ft0) ft0.textContent = '指令未能送达手机，请稍后重试。';
    go.disabled = true; go.textContent = '发送中…';
    const payload = JSON.stringify({ v: 1, kind: 'session', nodeid: Sess.nodeid, vm: Sess.vm, from: ctrlInstanceId(), at: Date.now() });
    let okSend = false;
    try {
      const r = await api('/license/api/files/send', { method: 'POST', json: { filename: 'qf-invite-' + Sess.nodeid + '.json', toNode: QF_CTRL_MAILBOX, fromNode: Sess.nodeid, contentBase64: btoa(payload) } });
      okSend = !!(r.json && r.json.ok);
    } catch (e) { okSend = false; }
    if (!Sess.active) return;
    if (okSend) {
      const l = $('#qfSendList', view), s = $('#qfSendSent', view);
      if (l) l.hidden = true; if (s) s.hidden = false;
    } else {
      const l = $('#qfSendList', view), f = $('#qfSendFail', view);
      if (l) l.hidden = true; if (f) f.hidden = false;
    }
  };
  const rt = $('#qfSendRetry', view); if (rt) rt.onclick = () => resetSendSheet(view);
}

/* ================= 设备 ================= */
Views.devices = async function (view, param, seq) {
  view.innerHTML = `<h1 class="pt">我的设备</h1><p class="psub">设备由站长分配或好友共享给您。在线设备可直接发起远程桌面、文件管理与远程终端。</p>
    <div class="tabs"><button class="on" data-tab="all">全部设备</button><button data-tab="mine">我的设备</button><button data-tab="shared">好友共享</button></div>
    <div id="devList"><div class="card"><div class="skel" style="height:52px"></div></div></div>
    <div class="note blue">可把文件发送到同账号的另一台设备（单文件上限 200 MB，离线暂存 24 小时）：在「我的文件」页选择「发送文件到其他设备」即可。</div>`;
  // 预取：进页面即并行拉节点映射（快源先回、慢源后台回填），不阻塞列表渲染；
  // 落地后把节点 id 盖进设备行（数据携带解析），并把上次会话设备升级为深链预热
  fetchNodeMap().then(() => {
    if (seq !== renderSeq || S.route.name !== 'devices') return;   // DS P1-1：晚到回调世代校验——已离开设备页/已重渲即整段丢弃，不升级预热框
    refreshDevRowIds(view);
    try { const last = localStorage.getItem('qfLastSessionDevice'); const id = last && nodeIdFor(last); if (id) upgradePreheat(id, 11); } catch (e) {}
  }).catch(() => {});
  const st = await api('/home/api/stats');
  if (st.status === 200 && st.json && st.json.ok) S.stats = st.json;
  const mine = (S.stats && S.stats.devices) || [];
  let shared = [];
  const fm = await api('/api/friends/me');
  if (fm.status === 200 && fm.json) shared = (fm.json.sharesIn || []).map(s => ({ name: s.meshName || '共享设备组', os: '好友共享 · ' + ((s.tier === 'operate' || s.tier === 'B2') ? '可操作' : '只看'), group: s.owner || '', online: false })); // 批A-A2：档位判法对齐好友页与服务端词表 operate/view
  const box = $('#devList', view);
  const paint = (tab) => {
    // 批A-A4：三页签分开渲染——'all' 合并我的与共享；共享行归属读映射字段 group（原误读 d.from 永不显示）
    const mineRows = mine.map(devRowHtml);
    const sharedRows = shared.map(d => devRowHtml({ name: d.name || d.device || '', os: d.os || '好友共享', group: d.group || '', online: !!d.online }));
    let rows, emptyHtml;
    if (tab === 'shared') {
      rows = sharedRows;
      emptyHtml = '<div class="statebox"><b>暂无好友共享的设备</b><p>好友把设备共享给您后，将显示在这里。</p></div>';
    } else if (tab === 'mine') {
      rows = mineRows;
      emptyHtml = '<div class="statebox"><b>暂无设备</b><p>设备上线后将显示在这里。</p></div>';
    } else {
      rows = mineRows.concat(sharedRows);
      emptyHtml = '<div class="statebox"><b>暂无设备</b><p>设备上线后，或好友将设备共享给您后，将显示在这里。</p></div>';
    }
    box.innerHTML = `<div class="card">${rows.length ? rows.join('') : emptyHtml}</div>`;
    bindDevRows(box);
  };
  paint('all');
  view.querySelectorAll('[data-tab]').forEach(el => el.onclick = () => {
    view.querySelectorAll('[data-tab]').forEach(x => x.classList.remove('on')); el.classList.add('on'); paint(el.getAttribute('data-tab'));
  });
};
Views.device = async function (view, name) {
  const devs = (S.stats && S.stats.devices) || [];
  const d = devs.find(x => x.name === name) || { name, os: '', group: '', online: false };
  view.innerHTML = `<h1 class="pt">设备详情 · ${esc(d.name)}</h1><p class="psub"><a data-back>← 返回我的设备</a></p>
    <div class="card"><div class="dev" style="border:none;padding:0"><span class="devic">${ic('monitor')}</span><span><b style="font-size:17px">${esc(d.name)}</b><small>${esc(d.os || '')} · ${d.online ? '在线' : '离线'}</small></span><span class="ops">${d.online ? `<button class="btn" data-remote="${esc(d.name)}">连接远程桌面</button>` : '<span class="pill off">设备离线时不可连接</span>'}</span></div></div>
    <div class="grid2"><div class="card"><h3>连接</h3>
      <button class="row" data-remote="${esc(d.name)}"><span class="tile">${ic('monitor')}</span><span><b>远程桌面</b><small>画面与键鼠控制</small></span><span class="chev">${ic('chevR')}</span></button><button class="row" data-files="${esc(d.name)}"><span class="tile">${ic('folder')}</span><span><b>文件管理</b><small>浏览、上传与下载被控端文件</small></span><span class="chev">${ic('chevR')}</span></button><button class="row" data-terminal="${esc(d.name)}"><span class="tile">${ic('file')}</span><span><b>远程终端</b><small>命令行会话</small></span><span class="chev">${ic('chevR')}</span></button>
      <p style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap"><button class="btn sm" data-remote="${esc(d.name)}">远程桌面</button><button class="btn sm ghost" data-files="${esc(d.name)}">文件管理</button><button class="btn sm grey" data-terminal="${esc(d.name)}">远程终端</button></p></div>
    <div class="card"><h3>设备信息</h3><table>
      <tr><th>系统</th><td>${esc(d.os || '—')}</td></tr><tr><th>分组</th><td>${esc(d.group || '默认分组')}</td></tr>
      <tr><th>状态</th><td>${d.online ? '在线' : '离线'}</td></tr><tr><th>共享状态</th><td>以好友页共享设置为准</td></tr><tr><th>屏幕锁</th><td>在本页下方「屏幕锁」面板中管理（仅设备所有者）</td></tr></table></div></div>
    <div class="card" id="lockCard"><h3>屏幕锁</h3><div id="lockBody"><div class="skel" style="height:52px"></div></div></div>
    <div class="card"><h3>共享与安全</h3>
      ${rowHtml('users', '共享给好友', '在好友页选择好友后共享此设备（只看 / 可操作两档）', 'friends')}
      <button class="row" id="goLockPanel"><span class="tile">${ic('lock')}</span><span><b>屏幕锁</b><small>开启后被控端屏幕熄灭，只保留密码输入框；在本页上方「屏幕锁」面板中管理</small></span><span class="chev">${ic('chevR')}</span></button>
    </div>`;
  $('[data-back]', view).onclick = () => navigate('devices');
  bindDevRows(view);
  view.querySelectorAll('[data-go]').forEach(el => el.addEventListener('click', () => navigate(el.getAttribute('data-go'))));
  const gl = $('#goLockPanel', view);
  if (gl) gl.onclick = () => { const c = $('#lockCard', view); if (c) c.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
  initLockPanel(view, d.name);
};
/* 屏幕锁面板（四态：未锁/已锁/未装组件/他人设备；三操作：arm/reset/disarm）。
   形态照安卓 LockPage 与电脑端 lock.html：未锁时点开关先在卡内展开设密码
   表单、提交成功才真正上锁；已锁时可关锁（二次确认）或用登录密码重设。 */
async function initLockPanel(view, deviceName) {
  const body = $('#lockBody', view); if (!body) return;
  let busy = false;
  const nm = await fetchNodeMap();
  if (!body.isConnected) return;
  if (nm.lockStatus === 'needlogin') {
    body.innerHTML = `<div class="statebox"><b>登录状态已失效</b><p>${esc(nm.lockError)}</p></div>`;
    return;
  }
  if (nm.lockStatus !== 'ok') {
    body.innerHTML = `<div class="statebox"><b>屏幕锁暂时不可用</b><p>${esc(nm.lockError)}</p><button class="btn sm" id="lk-retry">重新加载</button></div>`;
    const rb = $('#lk-retry', body); if (rb) rb.onclick = () => { invalidateNodeMap(); initLockPanel(view, deviceName); };
    return;
  }
  const dev = nm.lockDevices.find(x => x.name === deviceName);
  if (!dev) {
    // 他人设备（或未登记机主）：服务端不下发该设备，不显示任何开关。
    body.innerHTML = `<div class="note blue" style="margin:0">该设备不在您的屏幕锁管理范围内。仅设备所有者可管理其屏幕锁；好友共享给您的设备，请由设备所有者管理。</div>`;
    return;
  }
  if (!dev.component) {
    body.innerHTML = `<p style="margin-bottom:8px"><span class="pill warn">未安装组件</span></p><p style="color:var(--sub);font-size:13.5px">这台设备尚未安装屏幕锁组件，暂无法使用屏幕锁。</p>`;
    return;
  }
  const say = (html) => { const m = $('#lk-msg', body); if (m) m.innerHTML = html || ''; };
  const fail = (r, fb) => say(`<div class="note err" style="margin:10px 0 0">${esc(apiErrText(r, fb))}</div>`);
  const setBusy = (on, label) => {
    busy = on;
    body.querySelectorAll('button').forEach(b => { b.disabled = on; });
    if (on) say(`<p style="color:var(--sub);font-size:13.5px;margin-top:10px">${esc(label || '正在处理，请稍候…')}</p>`);
  };
  const refresh = () => { invalidateNodeMap(); initLockPanel(view, deviceName); };
  if (!dev.locked) {
    body.innerHTML = `
      <div class="dev" style="border:none;padding:4px 0 0"><span><b>当前状态</b><small>未锁定</small></span><span class="ops"><span class="pill off">未锁定</span><button class="btn sm" id="lk-arm-open">开启屏幕锁</button></span></div>
      <p style="color:var(--sub);font-size:13.5px;margin-top:8px">开启后，这台设备屏幕熄灭，只保留密码输入框，坐在设备前的人无法查看与操作；远程控制不受影响。</p>
      <div id="lk-arm-form" hidden>
        <div class="field"><label>设置本次密码（至少 4 位）</label><input id="lk-pw1" type="password" autocomplete="off"></div>
        <div class="field"><label>请再次输入</label><input id="lk-pw2" type="password" autocomplete="off"></div>
        <p style="color:var(--sub);font-size:12.5px;margin-bottom:12px">密码只用这一次：在设备本地解锁成功后自动作废，下次开启时重新设置。</p>
        <button class="btn block" id="lk-arm-go">打开屏幕锁</button>
      </div>
      <div id="lk-msg"></div>`;
    $('#lk-arm-open', body).onclick = () => {
      const f = $('#lk-arm-form', body); f.hidden = !f.hidden;
      if (!f.hidden) { const i = $('#lk-pw1', body); if (i) i.focus(); }
    };
    $('#lk-arm-go', body).onclick = async () => {
      if (busy) return;
      const pw = $('#lk-pw1', body).value, pw2 = $('#lk-pw2', body).value;
      const bad = validateLockPw(pw);
      if (bad) { say(`<div class="note err" style="margin:10px 0 0">${esc(bad)}</div>`); return; }
      if (pw !== pw2) { say('<div class="note err" style="margin:10px 0 0">两次输入的密码不一致，请检查后重试。</div>'); return; }
      setBusy(true, '正在开启屏幕锁，请稍候…');
      const r = await lockApi('POST', '/enable', { id: dev.id, password: pw });
      $('#lk-pw1', body).value = ''; $('#lk-pw2', body).value = '';
      if (r.json && r.json.ok) { toast('屏幕锁已开启。', 'ok'); refresh(); }
      else { setBusy(false); fail(r, '开启失败，请稍后再试。'); }
    };
    return;
  }
  // 已锁定：关锁（二次确认）＋忘记密码重设（保持锁定，只换密码）
  body.innerHTML = `
    <div class="dev" style="border:none;padding:4px 0 0"><span><b>当前状态</b><small>已锁定 · 远程控制不受影响</small></span><span class="ops"><span class="pill warn">已锁定</span></span></div>
    <p style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap"><button class="btn danger" id="lk-off">关闭屏幕锁</button><button class="btn grey" id="lk-reset-open">忘记密码？用登录密码重设</button></p>
    <div id="lk-reset-form" hidden style="margin-top:12px">
      <div class="field"><label>您的 QFRemote 登录密码</label><input id="lk-lp" type="password" autocomplete="current-password"></div>
      <div class="field"><label>新锁密码（至少 4 位）</label><input id="lk-np1" type="password" autocomplete="off"></div>
      <div class="field"><label>请再次输入新锁密码</label><input id="lk-np2" type="password" autocomplete="off"></div>
      <button class="btn block" id="lk-reset-go">重设密码（设备保持锁定）</button>
    </div>
    <div id="lk-msg"></div>`;
  let armed = false, armTimer = null;
  const offBtn = $('#lk-off', body);
  offBtn.onclick = async () => {
    if (busy) return;
    if (!armed) {
      armed = true; offBtn.textContent = '再次点击确认关闭（本次密码立即作废）';
      armTimer = setTimeout(() => { armed = false; offBtn.textContent = '关闭屏幕锁'; }, 3500);
      return;
    }
    clearTimeout(armTimer);
    setBusy(true, '正在关闭屏幕锁，请稍候…');
    const r = await lockApi('POST', '/disable', { id: dev.id });
    if (r.json && r.json.ok) { toast('屏幕锁已关闭，本次密码已作废。', 'ok'); refresh(); }
    else { setBusy(false); offBtn.textContent = '关闭屏幕锁'; armed = false; fail(r, '关闭失败，请稍后再试。'); }
  };
  $('#lk-reset-open', body).onclick = () => {
    const f = $('#lk-reset-form', body); f.hidden = !f.hidden;
    if (!f.hidden) { const i = $('#lk-lp', body); if (i) i.focus(); }
  };
  $('#lk-reset-go', body).onclick = async () => {
    if (busy) return;
    const lp = $('#lk-lp', body).value, np = $('#lk-np1', body).value, np2 = $('#lk-np2', body).value;
    if (!lp) { say('<div class="note err" style="margin:10px 0 0">请输入登录密码。</div>'); return; }
    const bad = validateLockPw(np);
    if (bad) { say(`<div class="note err" style="margin:10px 0 0">${esc(bad)}</div>`); return; }
    if (np !== np2) { say('<div class="note err" style="margin:10px 0 0">两次输入的密码不一致，请检查后重试。</div>'); return; }
    setBusy(true, '正在重设密码，请稍候…');
    const r = await lockApi('POST', '/reset', { id: dev.id, loginPassword: lp, newPassword: np });
    ['#lk-lp', '#lk-np1', '#lk-np2'].forEach(s => { const i = $(s, body); if (i) i.value = ''; });
    if (r.json && r.json.ok) { toast('密码已重设，设备保持锁定状态。', 'ok'); refresh(); }
    else { setBusy(false); fail(r, '重设失败，请稍后再试。'); }
  };
}
/* 发送文件卡（远程会话与「我的文件」共用同一真功能）：
   选本机文件 → 选同账号目标设备（以节点标识为准）→ 上传暂存 → 正式提示。
   opts: { fromName } 预选来源设备（远程会话上下文）。 */
function mountFileSend(container, opts) {
  opts = opts || {};
  container.innerHTML = `
    <div class="field"><label>选择文件（单文件上限 200 MB）</label><input type="file" class="fs-file"><div class="hint fs-chosen">尚未选择文件</div></div>
    <div class="grid2">
      <div class="field"><label>来源设备</label><select class="fs-from"></select></div>
      <div class="field"><label>目标设备</label><select class="fs-to"></select></div>
    </div>
    <div class="bar fs-barwrap" hidden><i class="fs-bar" style="width:0%"></i></div>
    <p class="fs-note" style="color:var(--sub);font-size:13px;margin:8px 0 12px"></p>
    <button class="btn fs-go">发送文件</button>
    <div class="fs-out" style="margin-top:12px"></div>`;
  const fileIn = $('.fs-file', container), fromSel = $('.fs-from', container), toSel = $('.fs-to', container);
  const barWrap = $('.fs-barwrap', container), bar = $('.fs-bar', container), note = $('.fs-note', container);
  const goBtn = $('.fs-go', container), out = $('.fs-out', container);
  /* P2-029：已选文件回显——选中即在卡内显示文件名（多选显示数量＋首名），清空回落提示文案 */
  const chosen = $('.fs-chosen', container);
  const syncChosen = () => {
    const fs = fileIn.files;
    if (!fs || !fs.length) { chosen.textContent = '尚未选择文件'; return; }
    chosen.textContent = fs.length > 1 ? '已选择 ' + fs.length + ' 个文件：' + fs[0].name + ' 等' : '已选择文件：' + fs[0].name;
  };
  fileIn.onchange = syncChosen;
  let nm = null, sending = false;
  (async () => {
    nm = await fetchNodeMap();
    const devs = (S.stats && S.stats.devices) || [];
    const usable = devs.filter(d => nm.byName.has(d.name));
    const optHtml = (list, ph) => (ph ? `<option value="">${ph}</option>` : '') + list.map(d => `<option value="${esc(nm.byName.get(d.name))}">${esc(d.name)}${d.online ? '' : '（离线，暂存待收）'}</option>`).join('');
    fromSel.innerHTML = `<option value="">本设备（网页端）</option>` + optHtml(usable);
    if (opts.fromName && nm.byName.has(opts.fromName)) fromSel.value = nm.byName.get(opts.fromName);
    // 目标列表排除来源设备（来源变更时同步重建），避免来源/目标同机被误判未选。
    const syncTo = () => {
      const fromId = fromSel.value || '';
      const prev = toSel.value;
      const list = usable.filter(d => nm.byName.get(d.name) !== fromId);
      toSel.innerHTML = list.length ? optHtml(list, '请选择目标设备') : '<option value="">暂无其他可接收的设备</option>';
      if (prev && list.some(d => nm.byName.get(d.name) === prev)) toSel.value = prev;
      /* P2-030：候选恰一项时默认选中唯一目标（多项不预选、维持点选） */
      else if (list.length === 1) toSel.value = nm.byName.get(list[0].name);
    };
    fromSel.onchange = syncTo;
    syncTo();
    if (!usable.length) {
      goBtn.disabled = true;
      note.textContent = devs.length ? '暂时无法取得您设备的节点标识，文件发送暂不可用；远程桌面与文件管理不受影响。' : '您的账号下暂无设备，设备上线后即可在此发送文件。';
    } else {
      note.textContent = '文件将暂存于服务器（最长 24 小时），目标设备在「我的文件 · 待接收」中下载后即完成送达。';
    }
  })();
  goBtn.onclick = async () => {
    if (sending) return;
    const f = fileIn.files && fileIn.files[0];
    out.innerHTML = '';
    if (!f) { out.innerHTML = '<div class="note warn" style="margin:0">请先选择要发送的文件。</div>'; return; }
    if (f.size > FILE_MAX_BYTES) { out.innerHTML = '<div class="note err" style="margin:0">该文件超过单文件上限（200 MB），无法发送。请选择更小的文件。</div>'; return; }
    const toOpt = toSel.options && toSel.selectedIndex >= 0 ? toSel.options[toSel.selectedIndex] : null;
    const toNode = toSel.value || (toOpt ? toOpt.value : '');
    if (!toNode) { out.innerHTML = '<div class="note warn" style="margin:0">请选择目标设备。</div>'; return; }
    if (fromSel.value && toNode === fromSel.value) { out.innerHTML = '<div class="note warn" style="margin:0">目标设备不能与来源设备相同，请选择另一台设备。</div>'; return; }
    sending = true; goBtn.disabled = true; barWrap.hidden = false; bar.style.width = '0%';
    try {
      note.textContent = '正在读取文件…';
      const b64 = await readFileBase64(f, p => { bar.style.width = Math.round(p * 40) + '%'; });
      note.textContent = '正在上传到服务器暂存…';
      const r = await xhrSendFile({ filename: f.name, toNode, fromNode: fromSel.value || undefined, contentBase64: b64 },
        p => { bar.style.width = (40 + Math.round(p * 60)) + '%'; });
      bar.style.width = '100%';
      if (r.json && r.json.ok) {
        const toName = (nm && nm.byId.get(toNode)) || '目标设备';
        out.innerHTML = `<div class="note ok" style="margin:0">文件已发送到「${esc(toName)}」的待接收列表，有效期至 ${esc(fmtDate(r.json.expiresAt))}。对方下载完成后，本页「我发出的」将显示已送达。</div>`;
        toast('文件已发送。', 'ok');
        fileIn.value = '';
        syncChosen();
        const cb = container.closest('#view') || document;
        const sentBox = $('#sentList', cb); if (sentBox) loadSentList(cb);
        const inboxBox = $('#inboxList', cb); if (inboxBox) loadInboxList(cb);
      } else {
        out.innerHTML = `<div class="note err" style="margin:0">${esc(apiErrText(r, '发送失败，请稍后再试。'))}</div>`;
      }
    } catch (e) {
      out.innerHTML = `<div class="note err" style="margin:0">${esc((e && e.message) || '发送失败，请稍后再试。')}</div>`;
    }
    note.textContent = '文件将暂存于服务器（最长 24 小时），目标设备在「我的文件 · 待接收」中下载后即完成送达。';
    sending = false; goBtn.disabled = false;
    setTimeout(() => { barWrap.hidden = true; }, 600);
  };
}
async function loadInboxList(root) {
  const box = $('#inboxList', root); if (!box) return;
  const nm = await fetchNodeMap();
  const devs = (S.stats && S.stats.devices) || [];
  const targets = devs.filter(d => nm.byName.has(d.name));
  let all = [];
  for (const d of targets) {
    const r = await api('/license/api/files/inbox?node=' + encodeURIComponent(nm.byName.get(d.name)));
    if (r.json && r.json.ok && Array.isArray(r.json.files)) all = all.concat(r.json.files.map(f => Object.assign({}, f, { _toName: d.name })));
  }
  /* 2.4.0 发送到手机：ctrl 账号邮箱一并汇总（会话邀请＋发到本机的文件，#25 通道） */
  const ctrlR = await api('/license/api/files/inbox?node=' + encodeURIComponent(QF_CTRL_MAILBOX));
  if (ctrlR.json && ctrlR.json.ok && Array.isArray(ctrlR.json.files)) all = all.concat(ctrlR.json.files.map(f => Object.assign({}, f, { _toName: '这台手机', _ctrl: true })));
  if (!targets.length && !all.length) { box.innerHTML = '<div class="statebox"><b>暂无可查询的设备</b><p>设备上线并取得节点标识后，待接收文件将显示在这里。</p></div>'; return; }
  if (!all.length) { box.innerHTML = '<div class="statebox"><b>暂无待接收文件</b><p>其他设备发送给您的文件将显示在这里（暂存 24 小时）。</p></div>'; return; }
  box.innerHTML = all.map(f => {
    const fromName = (f.fromNode && nm.byId.get(f.fromNode)) || (f.fromNode ? '其他设备' : '网页端');
    const inv = f._ctrl && /^qf-invite-([A-Za-z0-9_-]+)\.json$/.exec(f.filename || '');
    if (inv) {
      const targetName = nm.byId.get(inv[1]) || '远程设备';
      return `<div class="dev"><span class="devic">${ic('phone')}</span><span><b>会话邀请：${esc(targetName)}</b><small>来自 ${esc(fromName)} · 发送到这台手机 · ${esc(fmtRemain(f.expiresAt))}</small></span><span class="ops"><button class="btn sm" data-open-invite="${esc(f.id)}" data-inv-node="${esc(inv[1])}">打开会话</button></span></div>`;
    }
    return `<div class="dev"><span class="devic">${ic('file')}</span><span><b>${esc(f.filename)}</b><small>${esc(fmtSize(f.size))} · 来自 ${esc(fromName)} · 接收到 ${esc(f._toName)} · ${esc(fmtRemain(f.expiresAt))}</small></span><span class="ops"><button class="btn sm" data-dl="${esc(f.id)}" data-fn="${esc(f.filename)}">下载</button></span><div class="bar" data-dlbar="${esc(f.id)}" hidden style="flex-basis:100%"><i style="width:0%"></i></div></div>`;
  }).join('');
  box.querySelectorAll('[data-open-invite]').forEach(btn => btn.onclick = async () => {
    const id = btn.getAttribute('data-open-invite'), nodeid = bareNodeId(btn.getAttribute('data-inv-node') || '');
    btn.disabled = true; btn.textContent = '打开中…';
    await api('/license/api/files/' + encodeURIComponent(id) + '/ack', { method: 'POST', json: {} }).catch(() => {});
    openSession('desktop', { name: nm.byId.get(nodeid) || '', nodeid });
  });
  box.querySelectorAll('[data-dl]').forEach(btn => btn.onclick = async () => {
    const id = btn.getAttribute('data-dl'), fn = btn.getAttribute('data-fn');
    const barEl = box.querySelector('[data-dlbar="' + CSS.escape(id) + '"]');
    btn.disabled = true; btn.textContent = '下载中…';
    if (barEl) { barEl.hidden = false; }
    try {
      await downloadStagedFile(id, fn, p => { if (barEl) barEl.firstElementChild.style.width = Math.round(p * 100) + '%'; });
      const ack = await api('/license/api/files/' + encodeURIComponent(id) + '/ack', { method: 'POST', json: {} });
      if (ack.json && ack.json.ok) toast('文件已下载，送达回执已确认。', 'ok');
      else toast('文件已下载，但回执确认未成功，请稍后在待接收列表核对。', 'warn');
    } catch (e) {
      toast((e && e.message) || '下载失败，请稍后再试。', 'err');
      btn.disabled = false; btn.textContent = '下载';
      return;
    }
    loadInboxList(root);
    const sentBox = $('#sentList', root); if (sentBox) loadSentList(root);
  });
}
async function loadSentList(root) {
  const box = $('#sentList', root); if (!box) return;
  const nm = await fetchNodeMap();
  const r = await api('/license/api/files/sent');
  if (!(r.json && r.json.ok && Array.isArray(r.json.files))) { box.innerHTML = '<div class="statebox"><b>发出记录暂时不可用</b><p>请稍后重新加载。</p></div>'; return; }
  const files = r.json.files;
  if (!files.length) { box.innerHTML = '<div class="statebox"><b>暂无发出记录</b><p>您发送到其他设备的文件及送达状态将显示在这里。</p></div>'; return; }
  const stText = { staged: '待接收', delivered: '已送达', expired: '已过期' };
  box.innerHTML = files.map(f => {
    const toName = (f.toNode && f.toNode.indexOf('ctrl:') === 0) ? '这台手机' : ((f.toNode && nm.byId.get(f.toNode)) || '其他设备');
    const st = stText[f.status] || f.status || '';
    return `<div class="dev"><span class="devic">${ic('file')}</span><span><b>${esc(f.filename)}</b><small>${esc(fmtSize(f.size))} · 发送到 ${esc(toName)} · ${esc(fmtDate(f.createdAt))}${f.status === 'delivered' && f.deliveredAt ? ' · 送达于 ' + esc(fmtDate(f.deliveredAt)) : ''}</small></span><span class="ops"><span class="pill ${f.status === 'delivered' ? 'ok' : (f.status === 'expired' ? 'err' : 'warn')}">${esc(st)}</span></span></div>`;
  }).join('');
}
Views.files = async function (view, name) {
  const devs = (S.stats && S.stats.devices) || [];
  view.innerHTML = `<h1 class="pt">我的文件</h1><p class="psub">浏览单台设备的文件请进入设备详情或远程桌面；把文件发到同账号的另一台设备，可直接在本页发送与接收。</p>
    <div class="card"><h3>选择设备进入文件管理</h3><div id="fileDevs">${devs.length ? devs.map(devRowHtml).join('') : '<div class="statebox"><b>暂无设备</b><p>设备上线后可进入文件管理。</p></div>'}</div></div>
    <div class="card"><h3>发送到我的其他设备</h3><div id="fileSendBox"></div></div>
    <div class="card"><h3>待接收</h3><div id="inboxList"><div class="skel" style="height:52px"></div></div></div>
    <div class="card"><h3>我发出的</h3><div id="sentList"><div class="skel" style="height:52px"></div></div></div>`;
  bindDevRows(view);
  mountFileSend($('#fileSendBox', view));
  loadInboxList(view);
  loadSentList(view);
  if (name) toast('已定位设备：' + name + '，点「文件管理」进入。', 'info');
};
/* ================= 远程桌面（旧跳板路由，2.4.0 起改道会话融合视图） =================
   历史链接/菜单仍可落到 #/remote/<设备名>：不再顶层跳原生页，统一改道 openSession。 */
Views.remote = async function (view, name) {
  openSession('desktop', { name: name || '' });
};

/* ================= 好友 ================= */
let frPaintSeq = 0;   // 好友页 paint 代次，防止旧回包覆盖新渲染
Views.friends = async function (view) {
  view.innerHTML = `<h1 class="pt">好友</h1><p class="psub">添加好友后，可将自己的设备组共享给对方协助处理。官方客服为系统联系人，不可删除、不参与设备共享。</p>
    <div class="card"><h3>好友申请 <span class="fr-cnt" id="frReqCnt" hidden></span></h3><div id="frReqs"><div class="skel" style="height:52px"></div></div></div>
    <div class="grid2"><div class="card chatlist"><h3>好友列表</h3><div id="frList"><div class="skel" style="height:52px"></div></div>
      <div class="field" style="margin-top:16px"><label>添加好友（输入对方完整账号）</label><input id="fr-q" placeholder="对方账号"></div>
      <button class="btn sm" id="fr-add">发送好友申请</button> <span id="fr-msg" style="font-size:13px;color:var(--sub)"></span>
      <div id="frOutReq"></div></div>
    <div class="card"><h3>共享给我的设备组</h3><div id="frIn"><div class="skel" style="height:52px"></div></div>
      <h3 style="margin-top:18px">我共享出的</h3><div id="frOut"><div class="skel" style="height:40px"></div></div></div></div>`;
  ensureChatToken(false);
  const paint = async () => {
    const myPaint = ++frPaintSeq;
    // 失败分支（catch 与业务失败共用同一渲染，且都不碰角标）
    const failRender = () => {
      const l = $('#frList', view); if (l) l.innerHTML = '<div class="statebox"><b>好友服务暂时不可用</b><p>请稍后重新加载。</p></div>';
      const rq = $('#frReqs', view); if (rq) rq.innerHTML = '<div class="statebox"><b>好友申请暂时无法加载</b><p>请稍后重新加载。</p></div>';
      const c = $('#frReqCnt', view); if (c) { c.hidden = true; c.textContent = ''; }
      const o = $('#frOutReq', view); if (o) o.innerHTML = '';
      const i2 = $('#frIn', view); if (i2) i2.innerHTML = '';
      const u = $('#frOut', view); if (u) u.innerHTML = '';
    };
    try {
      const r = await api('/api/friends/me');
      if (myPaint !== frPaintSeq) return;                                // 过期回包直接丢弃
      if (r.status !== 200 || !r.json || !Array.isArray(r.json.requestsIn)) { failRender(); return; }
      const j = r.json;
      const reqN = j.requestsIn.length;

      // ---- 角标与标题计数 ----
      badgeEpoch++;
      setFriendBadge(reqN);
      const cnt = $('#frReqCnt', view);
      if (cnt) { if (reqN > 0) { cnt.hidden = false; cnt.textContent = String(reqN); } else { cnt.hidden = true; cnt.textContent = ''; } }

      // ---- 好友申请（独立整幅卡）----
      const reqBox = $('#frReqs', view);
      let rq = '';
      j.requestsIn.forEach(q => { rq += `<div class="row"><span class="tile">${ic('user')}</span><span><b>${esc(q.from)}</b><small>请求添加您为好友</small></span><span class="ops" style="margin-left:auto;display:flex;gap:8px"><button class="btn sm" data-acc="${esc(q.from)}">同意</button><button class="btn sm grey" data-rej="${esc(q.from)}">拒绝</button></span></div>`; });
      if (!reqN) rq = '<div class="statebox"><b>暂无待处理的好友申请</b><p>有新的好友申请时会显示在这里。</p></div>';
      reqBox.innerHTML = rq;
      reqBox.querySelectorAll('[data-acc]').forEach(b => b.onclick = async () => { const rr = await api('/api/friends/respond', { method: 'POST', json: { username: b.getAttribute('data-acc'), accept: true } }); if (rr.json && rr.json.ok) { toast((rr.json && rr.json.msg) || '已同意好友申请。', 'ok'); } else toast((rr.json && rr.json.msg) || '操作未成功，请稍后再试。', 'err'); paint(); });
      reqBox.querySelectorAll('[data-rej]').forEach(b => b.onclick = async () => { const rr = await api('/api/friends/respond', { method: 'POST', json: { username: b.getAttribute('data-rej'), accept: false } }); if (rr.json && rr.json.ok) { toast((rr.json && rr.json.msg) || '已拒绝好友申请。', 'info'); } else toast((rr.json && rr.json.msg) || '操作未成功，请稍后再试。', 'err'); paint(); });

      // ---- 好友列表（删去 requestsIn 段，其余逐字不变）----
      const list = $('#frList', view);
      let h = `<button class="row" data-support="1"><span class="tile">${ic('users')}</span><span><b>官方客服</b><small>智能客服与人工客服的统一入口</small></span><span class="tag">系统</span><span class="chev">${ic('chevR')}</span></button>`;
      (j.friends || []).forEach(f => { h += `<div class="row"><span class="tile">${ic('user')}</span><span><b>${esc(f.name)}</b><small>好友</small></span><span class="ops" style="margin-left:auto;display:flex;gap:8px"><button class="btn sm ghost" data-share="${esc(f.name)}">共享设备</button><button class="btn sm grey" data-del="${esc(f.name)}">删除</button></span></div>`; });
      if (!(j.friends || []).length) h += '<div class="statebox"><b>暂无好友</b><p>在下方输入对方完整账号发送申请。</p></div>';
      list.innerHTML = h;
      const sup = $('[data-support]', list); if (sup) sup.onclick = () => navigate('support');
      list.querySelectorAll('[data-del]').forEach(b => b.onclick = () => confirmModal('删除好友', '删除后将同时撤销双方的设备共享，确定删除 ' + b.getAttribute('data-del') + ' 吗？', '删除', async () => { const r = await api('/api/friends/remove', { method: 'POST', json: { username: b.getAttribute('data-del') } }); if (r.json && r.json.ok) { toast('已删除好友。', 'ok'); paint(); } else { toast((r.json && r.json.msg) || '删除好友未成功，请稍后再试。', 'err'); } })); // 批A-A3：查删除结果，失败如实提示且不刷新（DS 门一裁定）
      list.querySelectorAll('[data-share]').forEach(b => b.onclick = () => {
      const groups = (j.myGroups || []);
      const opts = groups.length ? groups.map(g => `<option value="${esc(g.meshid || g.id || g)}">${esc(g.name || g.meshName || g.meshid || g)}</option>`).join('') : '<option value="">（暂无可共享分组）</option>';
      showModal('共享设备给 ' + b.getAttribute('data-share'),
        `<div class="field"><label>设备组</label><select id="sh-g">${opts}</select></div>
         <div class="field"><label>共享档位</label><select id="sh-t"><option value="B">只看</option><option value="B2">可操作</option></select></div>
         <p style="font-size:13px;color:var(--sub)">共享方随时可撤销；完整控制档不提供共享。</p>`,
        [{ label: '取消' }, { label: '确认共享', primary: true, onClick: async () => {
          const r2 = await api('/api/friends/share', { method: 'POST', json: { username: b.getAttribute('data-share'), meshid: $('#sh-g').value, tier: $('#sh-t').value === 'B2' ? 'operate' : 'view' } });
          if (r2.json && r2.json.ok) { toast('已共享。', 'ok'); paint(); } else toast((r2.json && r2.json.msg) || '共享未成功，请稍后再试。', 'err');
        } }]);
    });

      // ---- 我发送的申请 ----
      const outBox = $('#frOutReq', view);
      outBox.innerHTML = (Array.isArray(j.requestsOut) && j.requestsOut.length)
        ? `<h3 style="margin-top:18px">我发送的申请</h3>` + j.requestsOut.map(o => `<div class="row"><span class="tile">${ic('user')}</span><span><b>${esc(o.to || '')}</b></span><span class="tag" style="margin-left:auto">等待对方同意</span></div>`).join('')
        : '';

      // ---- 共享给我的 / 我共享出的（逐字不变）----
      $('#frIn', view).innerHTML = (j.sharesIn || []).length ? j.sharesIn.map(s => rowInfoHtml('monitor', (s.meshName || '共享设备组') + '（来自 ' + (s.owner || '') + '）', ((s.tier === 'operate' || s.tier === 'B2') ? '可操作' : '只看'))).join('') : '<div class="statebox"><b>暂无共享给我的设备组</b><p>好友共享后将显示在这里。</p></div>';
      $('#frOut', view).innerHTML = (j.sharesOut || []).length ? j.sharesOut.map(s => `<div class="row"><span class="tile">${ic('monitor')}</span><span><b>${esc(s.meshName || '设备组')}</b><small>共享给 ${esc(s.grantee || '')} · ${(s.tier === 'operate' || s.tier === 'B2') ? '可操作' : '只看'}</small></span><span class="ops" style="margin-left:auto"><button class="btn sm grey" data-unshare="${esc(s.grantee || '')}|${esc(s.meshid || '')}">撤销</button></span></div>`).join('') : '<div class="statebox"><b>暂无共享出的设备组</b><p>在好友列表中点「共享设备」即可共享。</p></div>';
      view.querySelectorAll('[data-unshare]').forEach(b => b.onclick = async () => { const [g, m] = b.getAttribute('data-unshare').split('|'); const ru = await api('/api/friends/unshare', { method: 'POST', json: { username: g, meshid: m } }); if (ru.json && ru.json.ok) { toast('已撤销共享。', 'ok'); } else toast((ru.json && ru.json.msg) || '撤销未成功，请稍后再试。', 'err'); paint(); });
    } catch (e) {
      if (myPaint === frPaintSeq) failRender();
    }
  };
  $('#fr-add', view).onclick = async () => {
    const q = $('#fr-q', view).value.trim(); const msg = $('#fr-msg', view);
    if (!q) { msg.textContent = '请输入对方完整账号。'; return; }
    const s = await api('/api/friends/search', { method: 'POST', json: { username: q } });
    if (!(s.json && s.json.ok)) { msg.textContent = (s.json && s.json.msg) || '未找到该账号，请核对完整账号。'; return; }
    const r = await api('/api/friends/request', { method: 'POST', json: { username: q } });
    msg.textContent = (r.json && r.json.msg) || (r.json && r.json.ok ? '好友申请已发送。' : '发送未成功，请稍后再试。');
    if (r.json && r.json.ok) paint();
  };
  paint();
};

/* ---------------- 聊天令牌（控制台单点登录换票） ----------------
   聊天服务 /chat/api/* 只认 x-qfchat-token：凭控制台会话（xid）经
   POST /chat/api/sso 换取，服务端每次现签新票（有效期 12 小时、旧票
   并存不作废）。令牌只存内存、随控制台会话生死；接口回 401 时强制
   重换一次再重试，首次 401 的服务端原因不丢弃（重试仍失败时优先显
   示）。换票失败（手动退出聊天／账号不可用聊天／未登录控制台）把
   服务端原因原样交回调用方显示，不许用笼统文案掩盖。并发换票合并
   为一路；换票失败只清本路开始时那张旧票，不误清并发刚换好的新票。 */
let chatTok = '', chatTokAt = 0, chatTokGen = 0, chatTokFlight = null, chatTokUser = ''; // DS-R07/S3 补修：chatTokUser＝当前聊天票的签发身份
/* 登出 / 会话失效被踢时的聊天令牌复位：自增代号使任何在飞的换票请求作废，
   其迟到的成功响应绝不会再把上一个账号的令牌写回 chatTok（C-16）。 */
function qfChatTokenReset() {
  chatTok = ''; chatTokAt = 0; chatTokGen++; chatTokFlight = null; chatTokUser = '';
}
function ensureChatToken(force) {
  /* DS-R07/S3 补修：聊天票绑定签发身份——跨标签切号后本页 S.user 已是新账号而旧票未过期，
     入口先复位，强制以当前控制台会话重新换票，绝不让旧账号的票在本页继续用。 */
  if (chatTok && chatTokUser && S.user && chatTokUser !== S.user) qfChatTokenReset();
  if (!force && chatTok && (Date.now() - chatTokAt) < 11 * 3600 * 1000 && (!chatTokUser || !S.user || chatTokUser === S.user)) return Promise.resolve({ ok: true });
  /* 在飞换票一律合并（含 force）：并发 401 只换一次票，避免多个强制换票
     共享同一 gen0 时，后完成者被 gen 校验误判为「登录状态已变更」（N-1）。
     登出复位由 qfChatTokenReset 置空 flight＋自增 gen，迟到成功仍被丢弃。 */
  if (chatTokFlight) return chatTokFlight;
  const gen0 = chatTokGen;
  const mintUser = S.user || ''; // DS-R07/S3：签发目标身份——换票开始时捕获（sso 回执不含 user 字段，成功时以此记 chatTokUser）
  const flight = (async () => {
    const r = await api('/chat/api/sso', { method: 'POST', json: {} });
    if (r.status === 200 && r.json && r.json.ok && r.json.token) {
      /* 换票期间发生过登出/换账号：此票属于上一个账号，直接丢弃，绝不复活。 */
      if (chatTokGen !== gen0) return { ok: false, msg: '登录状态已变更，请重新打开聊天。' };
      chatTok = r.json.token; chatTokAt = Date.now(); chatTokGen++; chatTokUser = mintUser;
      return { ok: true };
    }
    if (chatTokGen === gen0) { chatTok = ''; chatTokAt = 0; }
    if (r.networkError) return { ok: false, network: true, msg: '网络连接失败，请检查网络后重试。' };
    return { ok: false, msg: (r.json && r.json.msg) || (r.status === 403 ? '该账号不能使用聊天功能。' : '聊天登录失败，请重新登录后再试。') };
  })();
  chatTokFlight = flight;
  const done = () => { if (chatTokFlight === flight) chatTokFlight = null; };
  flight.then(done, done);
  return flight;
}

async function chatApi(path, opts) {
  opts = opts || {};
  const method = String(opts.method || 'GET').toUpperCase();
  let t = await ensureChatToken(false);
  if (!t.ok) return { status: 0, ok: false, json: null, text: '', ssoError: t.msg, networkError: !!t.network };
  const call = () => api(path, Object.assign({}, opts, { headers: Object.assign({}, opts.headers || {}, { 'x-qfchat-token': chatTok }) }));
  let r = await call();
  /* 401：服务端未执行业务，换票后重发安全（含非幂等 POST）；
     200 但响应体非 JSON 时请求可能已被服务端执行，只对幂等白名单重发，
     否则 POST /chat/api/send 等会被二次投递。 */
  if (r.status === 401 || (r.status === 200 && !r.json && apiRetrySafe(method, path))) {
    const firstMsg = (r.json && (r.json.msg || r.json.error)) || '';
    t = await ensureChatToken(true);
    if (!t.ok) return { status: 0, ok: false, json: null, text: '', ssoError: t.msg, networkError: !!t.network };
    r = await call();
    // CS2-1 修复（DS 门一成稿，候选丙）：首次 401/非 JSON 的原因只作为顶层诊断
    // 字段 firstMsg 保留，绝不改写重试响应的 json——旧回填会把失败伪装成成功
    // （200 非 JSON 被造出 {msg} 而走成功分支）、污染成功载荷、错置真因。
    // 消费方 paintList/cq/apiErrText 只读 json，不读 firstMsg。
    if (firstMsg) r = Object.assign({}, r, { firstMsg });
  }
  return r;
}

/* ================= 聊天对话区（C2 收编二期·变基重建） =================
   对话区改为控制台原生组件，不再内嵌独立聊天页。加密与解锁机制与
   独立页完全一致（同一套 /chat/api/* 接口、同一份 crypto-core 加密
   核心、同一静默解锁主序：托管副本→设备副本→无钥匙静默建钥匙），
   本组件移植独立页已验证的客户端逻辑，仅把页面级 DOM 换成组件内
   元素、把登录/单点登录换成控制台既有的聊天令牌通道（chatApi）。
   服务器只见密文的性质不变；独立 /chat 页在本组件验收后按设计退役。 */
let chatLibsP = null;
function ensureChatLibs() {
  if (window.QFChatCrypto && window.sodium) return Promise.resolve();
  if (chatLibsP) return chatLibsP;
  const load = (src) => new Promise((res, rej) => {
    const s = document.createElement('script'); s.src = src;
    s.onload = res; s.onerror = () => rej(new Error('lib-load-failed'));
    document.head.appendChild(s);
  });
  chatLibsP = (async () => {
    await load('/chat/libsodium-sumo.js');
    await load('/chat/libsodium-wrappers.js');
    await load('/chat/crypto-core.js');
    await window.QFChatCrypto.ready();
  })();
  chatLibsP.catch(() => { chatLibsP = null; });
  return chatLibsP;
}
const CH = {
  priv: '', vaultKey: '', pubCache: {}, convKeyCache: {},
  currentWith: '', lastEventSeq: 0, rendered: new Set(),
  removedIds: new Set(),   // 已撤回/已删消息 id：防其 msg 事件迟到重处理时复活（见 chHandleEvent）
  history: {}, traces: {}, pollTimer: null, pollBusy: false,
  locked: false, pendingWith: '', shellDeviceKey: '',
  deviceMeta: [], hasSessionCopy: false, convMeta: {},
  /* C-04：全局轮询游标 lastEventSeq 只由 chPollOnce 实际消费事件后推进；
     已读一律按会话上报（服务端 /read 写 marks[我]=max(原值, uptoSeq)）。 */
  convSeenSeq: {},    // with -> 本端已消费到的该会话最大全局 seq（/read 上报用）
  lastOutSeq: {},     // with -> 我发出的最后一条消息 seq（仅用于「对方已读」显示）
  pendingEvents: [],  // 已取回但暂无法解密/写入的事件，下轮重放（上限 200）
  historyLoaded: false,
  gen: 0              // 账号态代号：登出/复位时自增，在飞异步据此丢弃迟到结果
};
let CHV = null; // { view, hooks } 当前挂载点
let chatBootSeq = 0; // 启动代次：挂载/卸载时自增，迟到的旧 boot 据此收手（N-4）
const chEl = (id) => CHV ? CHV.view.querySelector('#' + id) : null;
const CHC = () => window.QFChatCrypto;
async function cq(method, path, body) {
  const opts = { method };
  if (body !== undefined) opts.json = body;
  const r = await chatApi(path, opts);
  if (r.ssoError) throw new Error(r.ssoError);
  if (r.networkError) throw new Error('网络连接失败，请检查网络后重试。'); // CS2-2：接口自身网络失败走网络文案
  if (!r.json) throw new Error('聊天服务暂时不可用，请稍后再试。');
  if (!r.ok || r.json.ok === false) throw new Error(r.json.msg || ('HTTP ' + r.status));
  return r.json;
}
function chFmt(at) { const d = new Date(at); return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); }
const CH_AV = ['#3E6FB4', '#5B83B8', '#7A93B5', '#4E7396', '#6B8CAE'];
function chAvatarColor(name) { let h = 0; const s = String(name || '?'); for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return CH_AV[h % CH_AV.length]; }

/* ---------- 设备密钥与设备包裹副本（移植独立页，语义不变） ---------- */
function chDeviceIdFor(kind) {
  const key = 'qfchat-device-id-' + kind;
  let id = null;
  try { id = localStorage.getItem(key); } catch (e) {}
  if (!id) {
    const bytes = new Uint8Array(16);
    if (window.crypto && crypto.getRandomValues) crypto.getRandomValues(bytes);
    else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
    id = kind + '-' + Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
    try { localStorage.setItem(key, id); } catch (e) {}
  }
  return id;
}
function chIdbOpen() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) return reject(new Error('indexeddb-unavailable'));
    const rq = indexedDB.open('qfremote-chat', 1);
    rq.onupgradeneeded = () => { try { rq.result.createObjectStore('kv'); } catch (e) {} };
    rq.onsuccess = () => resolve(rq.result);
    rq.onerror = () => reject(rq.error);
  });
}
async function chIdbGet(key) {
  const db = await chIdbOpen();
  return new Promise((resolve, reject) => {
    const rq = db.transaction('kv', 'readonly').objectStore('kv').get(key);
    rq.onsuccess = () => resolve(rq.result);
    rq.onerror = () => reject(rq.error);
  });
}
async function chIdbSet(key, val) {
  const db = await chIdbOpen();
  return new Promise((resolve, reject) => {
    const rq = db.transaction('kv', 'readwrite').objectStore('kv').put(val, key);
    rq.onsuccess = () => resolve();
    rq.onerror = () => reject(rq.error);
  });
}
let _chWebKeyP = null;
function chWebDeviceKey(create) {
  if (!(window.crypto && crypto.subtle && window.indexedDB)) return Promise.resolve(null);
  if (!_chWebKeyP) {
    _chWebKeyP = (async () => {
      let k = null;
      try { k = await chIdbGet('deviceKey'); } catch (e) {}
      if (!k && create) {
        k = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
        try { await chIdbSet('deviceKey', k); } catch (e) { return null; }
      }
      return k || null;
    })().catch(() => null);
  }
  return _chWebKeyP;
}
async function chWebWrap(secretB64, key) {
  const C = CHC();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, C.decBytes(secretB64));
  return { kind: 'webcrypto-aesgcm-v1', iv: C.encBytes(new Uint8Array(iv)), cipher: C.encBytes(new Uint8Array(ct)) };
}
async function chWebUnwrap(blob, key) {
  const C = CHC();
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: C.decBytes(blob.iv) }, key, C.decBytes(blob.cipher));
    return C.encBytes(new Uint8Array(pt));
  } catch (e) { return null; }
}
function chLocalDeviceKey(create) {
  const C = CHC();
  let k = null;
  try { k = localStorage.getItem('qfchat-device-key-v1'); } catch (e) {}
  if (!k && create) {
    k = C.newDeviceKey();
    try { localStorage.setItem('qfchat-device-key-v1', k); } catch (e) {}
  }
  return k;
}
async function chBuildDeviceCopyFor(kind, privB64, vaultB64) {
  const C = CHC();
  try {
    if (kind === 'shell') {
      if (!CH.shellDeviceKey) return null;
      return { deviceId: chDeviceIdFor('shell'), platform: 'shell', wrappedPriv: C.wrapWithKey(privB64, CH.shellDeviceKey), wrappedVault: C.wrapWithKey(vaultB64, CH.shellDeviceKey) };
    }
    if (kind === 'web') {
      const key = await chWebDeviceKey(true);
      if (!key) return null;
      const wp = await chWebWrap(privB64, key);
      const wv = await chWebWrap(vaultB64, key);
      return { deviceId: chDeviceIdFor('web'), platform: 'web', wrappedPriv: wp, wrappedVault: wv };
    }
    if (kind === 'local') {
      const k = chLocalDeviceKey(true);
      if (!k) return null;
      return { deviceId: chDeviceIdFor('local'), platform: 'web', wrappedPriv: C.wrapWithKey(privB64, k), wrappedVault: C.wrapWithKey(vaultB64, k) };
    }
  } catch (e) { /* 设备副本是静默增强，失败不影响主流程 */ }
  return null;
}
async function chBuildFirstDeviceCopy(privB64, vaultB64) {
  if (CH.shellDeviceKey) { const c = await chBuildDeviceCopyFor('shell', privB64, vaultB64); if (c) return c; }
  const w = await chBuildDeviceCopyFor('web', privB64, vaultB64);
  if (w) return w;
  return chBuildDeviceCopyFor('local', privB64, vaultB64);
}
async function chEnrollDeviceCopy() {
  if (!CH.priv || !CH.vaultKey) return false;
  let any = false;
  const put = async (kind) => {
    const copy = await chBuildDeviceCopyFor(kind, CH.priv, CH.vaultKey);
    if (!copy) return false;
    try { await cq('POST', '/chat/api/keys/device', copy); return true; } catch (e) { return false; }
  };
  if (CH.shellDeviceKey) any = (await put('shell')) || any;
  const webOk = await put('web');
  any = webOk || any;
  if (!webOk) any = (await put('local')) || any;
  return any;
}
async function chFetchDeviceCopy(deviceId) {
  try { return await cq('GET', '/chat/api/keys/device/' + encodeURIComponent(deviceId)); } catch (e) { return null; }
}
async function chTryDeviceUnlock() {
  const C = CHC();
  if (CH.priv && CH.vaultKey) return true;
  const adopt = (p, v) => { if (!p || !v) return false; CH.priv = p; CH.vaultKey = v; CH.locked = false; return true; };
  try {
    if (CH.shellDeviceKey) {
      const c = await chFetchDeviceCopy(chDeviceIdFor('shell'));
      if (c && adopt(C.unwrapWithKey(c.wrappedPriv, CH.shellDeviceKey), C.unwrapWithKey(c.wrappedVault, CH.shellDeviceKey))) return true;
    }
  } catch (e) {}
  try {
    const key = await chWebDeviceKey(false);
    if (key) {
      const c = await chFetchDeviceCopy(chDeviceIdFor('web'));
      if (c) { const p = await chWebUnwrap(c.wrappedPriv, key); const v = await chWebUnwrap(c.wrappedVault, key); if (adopt(p, v)) return true; }
    }
  } catch (e) {}
  try {
    const k = chLocalDeviceKey(false);
    if (k) {
      const c = await chFetchDeviceCopy(chDeviceIdFor('local'));
      if (c && adopt(C.unwrapWithKey(c.wrappedPriv, k), C.unwrapWithKey(c.wrappedVault, k))) return true;
    }
  } catch (e) {}
  return false;
}

/* ---------- 登录状态托管副本与静默解锁（主序与独立页钉死一致） ---------- */
async function chFetchSessionCopy() {
  try {
    const r = await cq('GET', '/chat/api/keys/session-copy');
    if (r && r.priv && r.vault) { CH.priv = r.priv; CH.vaultKey = r.vault; CH.locked = false; CH.hasSessionCopy = true; return true; }
  } catch (e) { /* 无副本或网络问题：走下一顺位 */ }
  return false;
}
async function chUploadSessionCopy() {
  if (!CH.priv || !CH.vaultKey) return false;
  try { await cq('POST', '/chat/api/keys/session-copy', { priv: CH.priv, vault: CH.vaultKey }); CH.hasSessionCopy = true; return true; }
  catch (e) { return false; }
}
async function chCreateKeysSilently(password) {
  const C = CHC();
  const id = C.newIdentity();
  const vaultKey = C.newVaultKey();
  const device = await chBuildFirstDeviceCopy(id.privB64, vaultKey);
  const body = { pub: id.pubB64, sessionCopy: { priv: id.privB64, vault: vaultKey } };
  if (password) {
    body.wrappedPriv = C.wrapWithPassword(id.privB64, password);
    body.wrappedVault = C.wrapWithPassword(vaultKey, password);
  }
  if (device) body.device = device;
  await cq('POST', '/chat/api/keys/setup', body);
  CH.priv = id.privB64; CH.vaultKey = vaultKey; CH.hasSessionCopy = true; CH.locked = false;
  return true;
}
async function chFinishSilentUnlock() {
  const gen0 = CH.gen;
  CH.locked = false;
  chShowUnavail(false);
  try {
    const r = await cq('GET', '/chat/api/keys/me');
    if (gen0 !== CH.gen) return;         // 期间已登出/换账号：旧链就此终止（N-2）
    CH.deviceMeta = r.keys ? (r.keys.devices || []) : [];
    if (r.keys) CH.hasSessionCopy = !!r.keys.hasSessionCopy;
  } catch (e) { /* 设备清单元数据失败不影响本次解锁 */ }
  if (!CH.hasSessionCopy) chUploadSessionCopy().catch(() => {});
  /* 历史失败已在 chLoadHistory 内部可见化并给出重试入口，这里再兜一层，
     保证后续的轮询启动与会话恢复一定执行（C-05/C-07）。 */
  try { await chLoadHistory(); } catch (e) { /* 已在组件内提示 */ }
  if (gen0 !== CH.gen) return;           // 同上：旧账号链不得为新账号启轮询/开会话（N-2）
  chRefreshMeta().catch(() => {});
  chStartPolling();
  const w = CH.pendingWith || CH.currentWith;
  CH.pendingWith = '';
  if (w) chOpenConversation(w);
}
async function chAttemptSilentUnlock() {
  /* C-05：钥匙已在内存（离开再回聊天）时不得直接 return——必须走完 finish，
     重载历史、重启轮询、恢复会话；否则离开期间的新消息永不到达，
     首次历史加载失败后重进也永不重试。finish 可安全重入（chStartPolling
     有定时器在位守卫，监听注册不在此链上）。 */
  if (CH.priv && CH.vaultKey) { await chFinishSilentUnlock(); return true; }
  if (await chFetchSessionCopy()) { await chFinishSilentUnlock(); return true; }
  if (await chTryDeviceUnlock()) { await chFinishSilentUnlock(); return true; }
  try {
    const r = await cq('GET', '/chat/api/keys/me');
    CH.deviceMeta = r.keys ? (r.keys.devices || []) : [];
    if (r.keys) CH.hasSessionCopy = !!r.keys.hasSessionCopy;
    if (!r.keys) { await chCreateKeysSilently(''); await chFinishSilentUnlock(); return true; }
  } catch (e) { /* 建钥匙失败不冒充成功，落到不可用提示 */ }
  return false;
}

/* ---------- 历史（保险库） ---------- */
async function chPeerPub(user) {
  if (CH.pubCache[user]) return CH.pubCache[user];
  const gen0 = CH.gen;
  const r = await cq('GET', '/chat/api/keys/' + encodeURIComponent(user));
  /* 取钥期间发生登出/换账号时不得回写缓存：旧账号的公钥/派生钥一旦落进
     新账号缓存，该联系人后续全部消息都会用错钥封装（N-3）。 */
  if (gen0 === CH.gen) CH.pubCache[user] = r.pub;
  return r.pub;
}
async function chConvKey(withUser) {
  if (CH.convKeyCache[withUser]) return CH.convKeyCache[withUser];
  const gen0 = CH.gen;
  const pub = await chPeerPub(withUser);
  const k = CHC().conversationKey(CH.priv, pub);
  if (gen0 === CH.gen) CH.convKeyCache[withUser] = k;
  return k;
}
/* C-07：历史加载失败必须被捕获并对用户可见（错误条＋重试），且不得让
   finish/mount 链卡死。取数失败时不清空已有 history；成功时与本端已有
   条目按 id 合并（服务端版本优先）——chVaultAppend 存在「服务端未落账
   但本端已记」的条目，整体替换会把这类已投递消息弄丢且游标已过不再重投。
   错误条为 chMsgs 的同级元素：finish 后续的 chRenderMessages 只重绘
   chMsgs，放在消息区内的提示会被当场冲掉，同级错误条可存活。 */
function chShowHistoryError(msg, retryFn) {
  const box = chEl('chMsgs');
  if (!box || !box.parentElement) return;
  let bar = chEl('chHistErr');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'chHistErr';
    bar.className = 'note err';
    box.parentElement.insertBefore(bar, box);
  }
  bar.textContent = msg;
  if (retryFn) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn sm';
    b.textContent = '重新加载聊天记录';
    b.onclick = () => { chHideHistoryError(); retryFn(); };
    bar.appendChild(document.createTextNode(' '));
    bar.appendChild(b);
  }
}
function chHideHistoryError() {
  const b = chEl('chHistErr');
  if (b) b.remove();
}
async function chLoadHistory() {
  const gen0 = CH.gen;
  let r;
  try {
    r = await cq('GET', '/chat/api/vault');
  } catch (e) {
    if (gen0 !== CH.gen) return false;   // 已登出/换账号：旧账号的失败不落新账号界面（N-2）
    CH.historyLoaded = false;
    chShowHistoryError('聊天记录加载失败：' + (e && e.message ? e.message : '请稍后再试。'), () => {
      chLoadHistory().then(ok => { if (ok) { chRenderMessages(); chMarkRead(); } }).catch(() => {});
    });
    return false;
  }
  if (gen0 !== CH.gen) return false;     // 迟到响应不得回写新账号的 traces/history/UI（N-2）
  const C = CHC();
  const next = {};
  /* traces 与 history 同口径合并（B-3）：服务端版本优先，本端刚产生、
     服务端尚未落账的撤回留证按 msgId 补入，不得被整体替换清掉。 */
  const mergedTraces = r.traces || {};
  Object.keys(CH.traces).forEach(cv => {
    const remote = mergedTraces[cv] || (mergedTraces[cv] = []);
    const seen = new Set(remote.map(t => t.msgId));
    (CH.traces[cv] || []).forEach(t => { if (!seen.has(t.msgId)) remote.push(t); });
  });
  CH.traces = mergedTraces;
  (r.entries || []).forEach(e => {
    if (CH.removedIds.has(e.msgId)) return;   // 本端已知已撤回/已删，不复活
    let text = null;
    try { text = C.openVault(CH.vaultKey, e.nonce, e.cipher); } catch (err) { text = null; }
    if (text !== null) next[e.msgId] = { id: e.msgId, with: e.with, dir: e.dir, at: e.at, text };
  });
  /* 合并而非整体替换：本端已写出但服务端 vault 尚未落账的条目不能在重载
     时丢掉（其事件序号可能已被轮询越过，不会再作为事件回来）。 */
  Object.keys(CH.history).forEach(id => { if (!next[id] && !CH.removedIds.has(id)) next[id] = CH.history[id]; });
  CH.history = next;
  CH.historyLoaded = true;
  chHideHistoryError();
  return true;
}
async function chVaultAppend(msgId, withUser, dir, at, text) {
  if (CH.removedIds.has(msgId)) return;   // 纵深防御：已撤回/已删条目在任何入口都不写回保险库（CF-1 R-5）
  const gen0 = CH.gen;
  const sealed = CHC().sealVault(CH.vaultKey, text);
  try { await cq('POST', '/chat/api/vault', { msgId, with: withUser, dir, at, nonce: sealed.nonce, cipher: sealed.cipher }); } catch (e) { /* 下次打开会从传送通道补 */ }
  /* await 之后必须复核（B-1 TOCTOU）：在飞期间该条可能已被撤回/删除
     （removedIds 已登记），或发生登出/换账号（gen 已变）——两种情形都不得
     再写回本地 history（调用方随后还会据此把消息插回 DOM）。 */
  if (gen0 !== CH.gen || CH.removedIds.has(msgId)) return;
  CH.history[msgId] = { id: msgId, with: withUser, dir, at, text };
}
async function chRefreshMeta() {
  const gen0 = CH.gen;
  try {
    const c = await cq('GET', '/chat/api/conversations');
    if (gen0 !== CH.gen) return;   // 在飞期间已换账号：旧账号会话元数据不得落进新账号（D-4）
    const meta = {};
    (c.conversations || []).forEach(cv => { meta[cv.with] = { lastAt: cv.lastAt || 0, lastSeq: cv.lastSeq || 0, myRead: cv.myRead || 0 }; });
    CH.convMeta = meta;
  } catch (e) { /* 会话元数据失败不影响对话本身 */ }
  if (gen0 !== CH.gen) return;
  if (CHV && CHV.hooks && CHV.hooks.refreshList) CHV.hooks.refreshList();
}

/* ---------- 会话界面 ---------- */
function chShowUnavail(show) {
  const u = chEl('chUnavail'), m = chEl('chMsgs'), c = chEl('chComp');
  if (u) u.hidden = !show;
  if (m) m.style.display = show ? 'none' : '';
  if (c) c.style.display = show ? 'none' : '';
}
function chConvKeyOf(withUser) { return JSON.stringify([S.user || '', withUser].sort()); }
function chTracesFor(withUser) { return CH.traces[chConvKeyOf(withUser)] || []; }
function chAddTrace(conv, t) {
  const list = CH.traces[conv] = CH.traces[conv] || [];
  if (!list.some(x => x.msgId === t.msgId)) list.push(t);
}
function chAppendTraceDom(t) {
  const key = 'trace:' + t.msgId;
  if (CH.rendered.has(key)) return;
  CH.rendered.add(key);
  const div = document.createElement('div');
  div.className = 'cht-sys';
  div.id = 'cht-trace-' + t.msgId;
  div.textContent = t.by === (S.user || '') ? '您撤回了一条消息' : '对方撤回了一条消息';
  chEl('chMsgs').appendChild(div);
}
function chAppendMessageDom(m) {
  if (CH.rendered.has(m.id)) return;
  CH.rendered.add(m.id);
  const box = chEl('chMsgs'); if (!box) return;
  const div = document.createElement('div');
  div.className = 'cht-msg ' + (m.dir === 'out' ? 'me' : 'peer');
  div.id = 'cht-msg-' + m.id;
  const act = m.dir === 'out' ? '<span class="cht-recall" data-recall="' + m.id + '">撤回</span>' : '';
  div.innerHTML = '<div class="cht-bub">' + esc(m.text) + '</div><div class="cht-meta"><span>' + chFmt(m.at) + '</span>' + act + '</div>';
  const actEl = div.querySelector('[data-recall]');
  if (actEl) actEl.onclick = () => chRecallMessage(m.id);
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}
function chRenderMessages() {
  const box = chEl('chMsgs'); if (!box) return;
  box.innerHTML = '';
  CH.rendered = new Set();
  const msgs = Object.values(CH.history).filter(m => m.with === CH.currentWith).map(m => ({ at: m.at, msg: m }));
  const trs = chTracesFor(CH.currentWith).map(t => ({ at: t.msgAt != null ? t.msgAt : t.at, trace: t }));
  msgs.concat(trs).sort((a, b) => a.at - b.at).forEach(item => {
    if (item.msg) chAppendMessageDom(item.msg); else chAppendTraceDom(item.trace);
  });
  box.scrollTop = box.scrollHeight;
}
function chShowThreadPane() {
  if (CHV && CHV.hooks && CHV.hooks.showThread) CHV.hooks.showThread();
}
function chOpenConversation(withUser) {
  if (!withUser) return;
  if (CH.locked) {
    CH.pendingWith = withUser;
    chShowThreadPane();  // C-12：锁定态先切对话面，解锁完成/失败提示都落在对话面
    chAttemptSilentUnlock().then(ok => {
      if (!ok && CH.locked && CH.pendingWith === withUser) chShowUnavail(true);
    }).catch(() => { if (CH.locked) chShowUnavail(true); });
    return;
  }
  CH.currentWith = withUser;
  chShowThreadPane();    // C-12：一切打开会话的路径（含程序化打开）都切对话面
  const isSupport = withUser === 'qf-support';
  const title = chEl('chWith'); if (title) title.textContent = isSupport ? '官方客服' : withUser;
  const cav = chEl('chAvatar');
  if (cav) {
    if (isSupport) { cav.className = 'cht-av sys'; cav.textContent = '客'; cav.style.background = ''; }
    else { cav.className = 'cht-av'; cav.textContent = withUser.slice(0, 1); cav.style.background = chAvatarColor(withUser); }
  }
  const sub = chEl('chSub'); if (sub) sub.textContent = isSupport ? '已迁移至智能客服，本会话只读查看' : '内容经端到端加密';
  const banner = chEl('chBanner'); if (banner) banner.hidden = !isSupport;
  const input = chEl('chInput'), send = chEl('chSend');
  if (input) { input.disabled = isSupport; input.placeholder = isSupport ? '本会话保留只读，请从智能客服咨询' : '输入消息…'; }
  if (send) send.disabled = isSupport;
  const rd = chEl('chRead'); if (rd) rd.textContent = '';
  /* C-04：此处不再用 convMeta.lastSeq 提升全局游标 CH.lastEventSeq——那会把
     其他会话序号更低、尚未被 poll 消费的事件永久跳过（被跳消息不入保险库）。
     打开会话的已读改由 chMarkRead 按会话上报该会话的 lastSeq（见下）。 */
  chShowUnavail(false);
  chRenderMessages();
  chMarkRead().then(() => chRefreshMeta()).catch(() => {});
  if (CHV && CHV.hooks && CHV.hooks.markActive) CHV.hooks.markActive(withUser);
}
/* C-16：账号态复位总入口——登出（含会话失效被踢 forceGate）时由 BASE 调用。
   清理边界：
   · 清（账号态，与登录身份绑定）：priv/vaultKey（私钥与保险库钥匙）、
     pubCache/convKeyCache（他人公钥与派生会话钥）、history/traces/rendered
     （已解历史与撤回记录）、convMeta/convSeenSeq/lastOutSeq、currentWith/
     pendingWith/lastEventSeq、deviceMeta/hasSessionCopy（本账号的设备清单
     与副本标记）、shellDeviceKey（壳侧本次会话下发的设备钥匙材料）；
     chatTok 与在飞换票由 qfChatTokenReset 一并作废（BASE 补丁）。
   · 留（设备态）：本机设备 id（localStorage）与 IndexedDB 中的设备包裹
     副本、chDeviceIdFor 的钥匙材料——属「这台设备」的信任，不含账号身份
     信息；服务端按账号隔离存放，下一位登录者仍走自己的服务端数据，
     保留不构成跨账号泄漏，删之反而每次换账号都要重建设备副本。
   · CH.gen 自增：在飞的 poll/发送/换票迟到回调据此丢弃结果。 */
function chatResetAll() {
  CH.gen++;
  chStopPolling();
  chHideHistoryError();
  CH.priv = ''; CH.vaultKey = '';
  CH.pubCache = {}; CH.convKeyCache = {};
  CH.currentWith = ''; CH.lastEventSeq = 0; CH.pollBusy = false;   // 存疑-1：旧轮在飞标志不得带进新账号
  CH.rendered = new Set(); CH.removedIds = new Set();
  CH.history = {}; CH.traces = {};
  CH.locked = true; CH.pendingWith = '';
  CH.shellDeviceKey = '';
  CH.deviceMeta = []; CH.hasSessionCopy = false; CH.convMeta = {};
  CH.convSeenSeq = {}; CH.lastOutSeq = {}; CH.pendingEvents = [];
  CH.historyLoaded = false;
  CHV = null;
  if (typeof S !== 'undefined' && S) S._chatStop = null;
  if (typeof qfChatTokenReset === 'function') qfChatTokenReset();
}
function chLeaveConversation() {
  CH.currentWith = '';
  const title = chEl('chWith'); if (title) title.textContent = '选择左侧联系人开始聊天';
  const box = chEl('chMsgs');
  if (box) box.innerHTML = '<div class="statebox"><b>尚未选择会话</b><p>从左侧列表选择联系人即可查看对话。</p></div>';
  const input = chEl('chInput'); if (input) { input.disabled = true; input.placeholder = '输入消息…'; }
  const send = chEl('chSend'); if (send) send.disabled = true;
  if (CHV && CHV.hooks && CHV.hooks.markActive) CHV.hooks.markActive('');
}
async function chSendMessage() {
  /* C-06：进入时刻锁定目标会话快照——会话钥、收件方、本地记录与保险库
     归属全程以快照为准，await 之后绝不重读 CH.currentWith（用户在发送
     在飞期间切换会话时，旧写法会把按 A 会话钥封装的密文发给 B）。 */
  const target = CH.currentWith;
  if (!target || target === 'qf-support') return;
  const input = chEl('chInput'); if (!input) return;
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  const gen0 = CH.gen;
  try {
    const key = await chConvKey(target);
    if (gen0 !== CH.gen) return;   // 取钥期间已登出/换账号：不得用旧账号钥替新会话投递（N-3）
    const sealed = CHC().sealMessage(key, text);
    const r = await cq('POST', '/chat/api/send', { to: target, nonce: sealed.nonce, cipher: sealed.cipher });
    if (gen0 !== CH.gen) return;                    // 期间已登出/换账号：迟到结果不写任何状态
    const m = { id: r.id, with: target, dir: 'out', at: r.at, text };
    await chVaultAppend(r.id, target, 'out', r.at, text);
    /* C-04：不再用发送回执提升全局游标（会越过 poll 尚未消费的其他会话
       事件）；回执 seq 只记入本会话的已消费位与「对方已读」判定基准。 */
    if (Number(r.seq) > (CH.convSeenSeq[target] || 0)) CH.convSeenSeq[target] = Number(r.seq) || 0;
    CH.lastOutSeq[target] = Math.max(CH.lastOutSeq[target] || 0, Number(r.seq) || 0);
    if (CH.currentWith === target) { chAppendMessageDom(m); chMarkRead(); }
    chRefreshMeta().catch(() => {});
  } catch (e) { toast(e.message, 'err'); }
}
async function chRecallMessage(msgId) {
  confirmModal('撤回消息', '撤回后，您和对方都将看不到这条消息，只会留下一条撤回提示。软件之外的副本（如截图）无法撤回。确定撤回吗？', '撤回', async () => {
    try {
      const r = await cq('POST', '/chat/api/recall', { msgId });
      const m = CH.history[msgId];
      chRemoveMessageEverywhere(msgId);
      if (m) chAddTrace(chConvKeyOf(m.with), { msgId, by: S.user || '', at: r.at, msgAt: r.msgAt });
      if (CH.currentWith && (!m || m.with === CH.currentWith)) chRenderMessages();
      chRefreshMeta().catch(() => {});
    } catch (e) { toast(e.message, 'err'); }
  });
}
async function chDeleteConversation() {
  if (!CH.currentWith) return;
  const w = CH.currentWith;
  /* gen0 必须在打开确认框之前捕获（新-1）：确认框等待期间若发生登出/
     换账号，回调里再取到的已是新账号代次，守卫形同虚设——届时请求根本
     不许发，更不许删新账号的同名会话。 */
  const gen0 = CH.gen;
  confirmModal('删除整个对话', '确定删除与 ' + w + ' 的整个对话吗？删除后双方都将看不到。软件之外的副本（如截图）无法删除。', '删除', async () => {
    if (gen0 !== CH.gen) return;
    try {
      const r = await cq('POST', '/chat/api/delete-conversation', { with: w });
      if (gen0 !== CH.gen) return;   // 删除在飞期间已换账号：不得误删新账号同名会话数据（B-2）
      /* 逐个走 chRemoveMessageEverywhere：同时登记 removedIds，防该会话
         迟到的 msg 事件把已删条目写回保险库（CF-1 R-2）。 */
      Object.values(CH.history).filter(m => m.with === w).forEach(m => chRemoveMessageEverywhere(m.id));
      delete CH.traces[chConvKeyOf(w)];
      chRenderMessages();
      chRefreshMeta().catch(() => {});
      toast('已删除，共清除 ' + r.count + ' 条。', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  });
}
function chRemoveMessageEverywhere(msgId) {
  CH.removedIds.add(msgId);
  delete CH.history[msgId];
  const elx = chEl('cht-msg-' + msgId); if (elx) elx.remove();
  CH.rendered.delete(msgId);
}
async function chMarkRead(withUser) {
  const w = withUser || CH.currentWith;
  if (!w) return;
  /* C-04：已读只按会话上报——取「本端实际消费到的该会话 seq」与「该会话
     已知 lastSeq」的较大者，绝不借全局 poll 游标（旧写法把全局游标报作
     本会话已读位，会越过本会话尚未处理的消息）。服务端 /read 按会话写
     marks[我]=max(原值, uptoSeq)，只影响该会话未读数，不动 poll 游标。 */
  const seen = CH.convSeenSeq[w] || 0;
  const meta = CH.convMeta[w];
  const upto = Math.max(seen, (meta && meta.lastSeq) || 0);
  if (!(upto > 0)) return;
  try { await cq('POST', '/chat/api/read', { with: w, seq: upto }); } catch (e) {}
}
function chSeenTick(withUser, seq) {
  if (!withUser || !seq) return;
  if (seq > (CH.convSeenSeq[withUser] || 0)) CH.convSeenSeq[withUser] = seq;
}

/* ---------- 同步轮询（新消息＋墓碑＋已读） ---------- */
function chStartPolling() {
  if (CH.pollTimer) return;
  CH.pollTimer = setInterval(chPollOnce, 3000);
  chPollOnce();
}
function chStopPolling() {
  if (CH.pollTimer) { clearInterval(CH.pollTimer); CH.pollTimer = null; }
}
async function chPollOnce() {
  /* 在飞互斥（Q-4/B-1 竞态面）：setInterval 不等上一轮结束，慢请求下两轮
     重叠会同批事件双处理、并使「撤回处理与在飞写库交错」成为可能。
     忙时跳过本轮（3 秒后下一轮补上），事件序号不推进、无丢失。 */
  if (CH.pollBusy) return;
  const gen0 = CH.gen;
  CH.pollBusy = true;
  try { await chPollRound(); } catch (e) { /* 单轮异常吞掉，不外溢为未处理拒绝（存疑-2） */ }
  /* 复位必须认代次（新-4）：旧账号一轮的 finally 若无条件清位，会击穿
     新账号正在使用的互斥（chatResetAll 已先行清位让新账号首轮能启动，
     此处旧轮不得再碰）。 */
  finally { if (gen0 === CH.gen) CH.pollBusy = false; }
}
async function chPollRound() {
  if (!CHV) return;
  const gen0 = CH.gen;
  let r;
  try { r = await cq('GET', '/chat/api/poll?since=' + CH.lastEventSeq); } catch (e) { return; }
  if (gen0 !== CH.gen || !CHV) return;            // 期间登出/换账号：整批丢弃
  let sawNew = false;
  const fresh = (r.events || []).slice();
  /* C-04：游标只在本轮「实际取到并即将处理」的位置推进一次。单条处理失败
     不再靠游标原地不动来重试（那会被一条坏事件卡死整条流），而是进
     pendingEvents 下轮重放——消息不会因钥匙未就绪被永久跳过。 */
  for (const ev of fresh) if (ev.seq > CH.lastEventSeq) CH.lastEventSeq = ev.seq;
  const bucket = CH.pendingEvents.concat(fresh);
  CH.pendingEvents = [];
  for (const ev of bucket) {
    if (gen0 !== CH.gen) return;         // 批处理期间登出/换账号：余下事件整批作废（N-3）
    try {
      if (await chHandleEvent(ev)) sawNew = true;
    } catch (e) {
      /* 失败重放同样认代次（新-5）：事件在飞期间已换账号时，旧账号事件
         不得进新账号的 pendingEvents 被按新身份重放。 */
      if (gen0 === CH.gen) {
        CH.pendingEvents.push(ev);
        if (CH.pendingEvents.length > 200) CH.pendingEvents.shift();  // 上限防无限增长
      }
    }
  }
  if (sawNew) chRefreshMeta().catch(() => {});
  if (CH.currentWith) {
    const cv = JSON.stringify([S.user || '', CH.currentWith].sort());
    const marks = (r.read || {})[cv] || {};
    const rd = chEl('chRead');
    /* 「对方已读」以对端在本会话的已读位与我最后发出 seq 比较（旧写法拿
       全局游标比，C-04 删提升后必然失真）。 */
    const mine = CH.lastOutSeq[CH.currentWith] || 0;
    if (rd) rd.textContent = (mine > 0 && (marks[CH.currentWith] || 0) >= mine) ? '对方已读' : '';
  }
}
async function chHandleEvent(ev) {
  if (!ev) return false;
  if (ev.type === 'msg') {
    const m = ev.msg;
    if (!m || !m.id || !m.from || !m.to) return false;   // 异形事件按已消费跳过，不得抛错毒化 pending（新-3/存疑-D）
    const other = m.from === (S.user || '') ? m.to : m.from;
    /* 已撤回/已删的消息即使其 msg 事件迟到（游标未及）也不得再处理：
       本端 history 判重挡不住「已本地删除」的情形，此时重走解密＋入保险库
       会把服务端已清的保险库条目重新写回（服务端按 messages∪graveyard
       验 origin，墓地命中即放行），下次重载历史时消息复活（CF-1）。 */
    if (CH.history[m.id] || CH.removedIds.has(m.id)) { chSeenTick(other, ev.seq); return false; }
    const gen0 = CH.gen;
    const key = await chConvKey(other);              // 抛错 → 事件进 pending 下轮重试
    if (gen0 !== CH.gen) return false;               // 期间登出/换账号：不落新账号状态（N-3）
    const text = CHC().openMessage(key, m.nonce, m.cipher);
    if (text === null) { chSeenTick(other, ev.seq); return false; }   // 锁钥不匹配：与本端无关，视为已消费
    const dir = m.from === (S.user || '') ? 'out' : 'in';
    await chVaultAppend(m.id, other, dir, m.at, text);
    /* 调用侧闭环（新-2）：chVaultAppend 可能因 await 期间被撤回/换账号而
       落空（未写 history）——此时不得再推进已读、不得拿 undefined 渲染，
       否则既污染已读位又会抛错把事件毒化进 pending。 */
    if (gen0 !== CH.gen || CH.removedIds.has(m.id) || !CH.history[m.id]) return false;
    /* 已消费位只在真正处理完后推进：取钥失败进 pending 的事件不得先行
       计入已读并上报（N-5）。 */
    chSeenTick(other, ev.seq);
    if (dir === 'out') CH.lastOutSeq[other] = Math.max(CH.lastOutSeq[other] || 0, ev.seq);
    if (CH.currentWith === other) { chAppendMessageDom(CH.history[m.id]); chMarkRead(); }
    return true;
  }
  if (ev.type === 'tomb') {
    /* msgIds 形态防御（B-4）：字段缺失/异形时不得抛错——抛错会使事件
       进 pending 每轮重放、永不消费。 */
    (Array.isArray(ev.msgIds) ? ev.msgIds : []).forEach(id => chRemoveMessageEverywhere(id));
    return false;
  }
  if (ev.type === 'recall') {
    (Array.isArray(ev.msgIds) ? ev.msgIds : []).forEach(id => chRemoveMessageEverywhere(id));
    if (ev.trace) chAddTrace(ev.conv, ev.trace);
    /* 偏差留证（DEV-1）：DS 稿此处以 ev.conv（会话键字符串）记已消费位，
       与 convSeenSeq 按用户名索引的口径不符，落地改为按对端用户名记。 */
    const peer = Array.isArray(ev.parties) ? ev.parties.find(x => x !== (S.user || '')) : undefined;
    if (peer) chSeenTick(peer, ev.seq);
    if (CH.currentWith && CH.currentWith === peer) chRenderMessages();
    return false;
  }
  return false;
}

/* ---------- 组件挂载 ---------- */
function mountChatThread(view, hooks) {
  chStopPolling();
  CHV = { view, hooks: hooks || {} };
  S._chatStop = () => { chStopPolling(); CHV = null; chatBootSeq++; };
  const send = chEl('chSend'); if (send) send.onclick = chSendMessage;
  const input = chEl('chInput');
  if (input) input.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); chSendMessage(); } };
  const del = chEl('chDel'); if (del) del.onclick = chDeleteConversation;
  const ub = chEl('chUnavailBack');
  if (ub) ub.onclick = () => { chShowUnavail(false); if (CHV && CHV.hooks && CHV.hooks.backToList) CHV.hooks.backToList(); };
  /* C-07：启动链独立为 chBootChat 并全程兜底——任何一步失败都有可见
     提示与重试入口，不再出现未处理 rejection 后界面卡死的形态；
     重试只重跑 chBootChat，不重跑 mount（监听注册天然幂等亦不重复）。 */
  chatBootSeq++;
  chBootChat().catch(() => {
    const box = chEl('chMsgs');
    if (box) {
      box.innerHTML = stateBox('聊天暂时无法打开', '与服务器的连接出现问题，请检查网络后重新加载。', true);
      bindRetry(box, chBootChat);
    }
  });
}
async function chBootChat() {
  /* N-4：box 在 await 前捕获会过期——卸载重挂后 CHV 是新视图的对象，
     单靠 !CHV 拦不住旧 boot。各检查点以启动代次为准：代次变了（发生过
     卸载/重挂）即收手，失败提示与重试只写当前视图的节点。
     B-5：boot 自身入口即推进代次——重试连点时后起的 boot 自动作废先起
     的一个，同视图内也不会出现两个 boot 并发。 */
  const seq0 = ++chatBootSeq;
  const stale = () => (!CHV || seq0 !== chatBootSeq);
  const box = chEl('chMsgs');
  try { await ensureChatLibs(); }
  catch (e) {
    if (stale()) return;
    if (box) box.innerHTML = stateBox('聊天组件加载失败', '聊天加密组件未能加载，请检查网络后重新打开本页。', false);
    return;
  }
  let t;
  try { t = await ensureChatToken(false); }
  catch (e) { t = { ok: false, msg: '聊天登录失败，请稍后重试。' }; }
  if (stale()) return;
  if (!t || !t.ok) {
    if (t && t.network) { netFail(box, chBootChat); return; }
    if (box) {
      box.innerHTML = stateBox('聊天暂时不可用', (t && t.msg) || '聊天登录失败，请重新登录后再试。', true);
      bindRetry(box, chBootChat);
    }
    return;
  }
  CH.locked = !(CH.priv && CH.vaultKey);
  await chRefreshMeta();                       // 内部已吞错并刷新列表
  if (stale()) return;
  let ok = false;
  try { ok = await chAttemptSilentUnlock(); } catch (e) { ok = false; }
  if (stale()) return;
  if (!ok) {
    if (CH.locked) chShowUnavail(true);
    else chShowHistoryError('聊天记录加载失败，请检查网络后重试。', chBootChat);
  }
}

/* ---------- 软件壳静默解锁通道（与独立页同一组全局入口，语义不变） ---------- */
window.qfChatState = function () {
  let shellId = '', webId = '';
  try { shellId = chDeviceIdFor('shell'); webId = chDeviceIdFor('web'); } catch (e) {}
  const meta = CH.deviceMeta || [];
  return {
    hasToken: !!chatTok, user: S.user || '', locked: !!CH.locked, unlocked: !!(CH.priv && CH.vaultKey),
    shellDeviceId: shellId, webDeviceId: webId,
    hasShellDeviceCopy: meta.some(d => d.deviceId === shellId),
    hasWebDeviceCopy: meta.some(d => d.deviceId === webId),
    hasDeviceCopy: meta.length > 0,
    hasSessionCopy: !!CH.hasSessionCopy
  };
};
window.qfShellDeviceUnlock = async function (deviceKeyB64) {
  try {
    if (!chatTok || !deviceKeyB64) return false;
    await ensureChatLibs();
    CH.shellDeviceKey = String(deviceKeyB64);
    const ok = await chTryDeviceUnlock();
    if (!ok) return false;
    await chFinishSilentUnlock();
    return true;
  } catch (e) { return false; }
};
window.qfShellDeviceEnroll = async function (deviceKeyB64) {
  try {
    if (!deviceKeyB64 || !(CH.priv && CH.vaultKey)) return false;
    await ensureChatLibs();
    CH.shellDeviceKey = String(deviceKeyB64);
    return await chEnrollDeviceCopy();
  } catch (e) { return false; }
};
window.qfShellUnlock = async function (password) {
  try {
    if (!chatTok || !password) return false;
    await ensureChatLibs();
    const C = CHC();
    const r = await cq('GET', '/chat/api/keys/me');
    CH.deviceMeta = r.keys ? (r.keys.devices || []) : [];
    if (r.keys) CH.hasSessionCopy = !!r.keys.hasSessionCopy;
    if (!r.keys) {
      await chCreateKeysSilently(password);
    } else {
      const hasWraps = !!(r.keys.wrappedPriv && r.keys.wrappedVault);
      const priv = hasWraps ? C.unwrapWithPassword(r.keys.wrappedPriv, password) : null;
      const vaultKey = hasWraps ? C.unwrapWithPassword(r.keys.wrappedVault, password) : null;
      if (priv === null || vaultKey === null) {
        if (!(await chFetchSessionCopy())) return false;
        try {
          await cq('POST', '/chat/api/keys/rewrap', {
            wrappedPriv: C.wrapWithPassword(CH.priv, password),
            wrappedVault: C.wrapWithPassword(CH.vaultKey, password)
          });
        } catch (e) { /* 重新包装失败不影响本次已解开的状态 */ }
      } else {
        CH.priv = priv; CH.vaultKey = vaultKey;
      }
    }
    CH.locked = false;
    chEnrollDeviceCopy().catch(() => {});
    if (!CH.hasSessionCopy) chUploadSessionCopy().catch(() => {});
    await chFinishSilentUnlock();
    return true;
  } catch (e) { return false; }
};

/* ================= 聊天（会话列表与对话区均为控制台原生组件） ================= */
Views.chat = async function (view) {
  /* DS-R07/S3 补修：挂载前先同步当前控制台身份（他标签切号时本页 S.user 可能尚未更新），
     把「本页尚未检出切号」的旧票窗口压到近零；同步后若已被踢/锁定则不再挂载。 */
  await checkSession(true).catch(() => {});
  if (BanLock.active() || !S.auth) return;
  view.innerHTML = `<h1 class="pt">聊天</h1><p class="psub">好友聊天内容全程加密，钥匙由您的登录状态保管，登录了账号的设备可直接查看记录。左侧选联系人，右侧即对话，不再跳页。</p>
    <div class="grid2 chatwrap" style="grid-template-columns:1fr 1.6fr"><div class="card chatlist chatpane-list"><h3>会话</h3><div id="chList"><div class="skel" style="height:52px"></div></div></div>
    <div class="card chatpane-thread"><button class="btn sm grey chatback" id="ch-back" type="button">${ic('chevR')} 返回会话列表</button><h3>对话</h3>
    <div id="chThread">
      <div class="cht-head"><span class="cht-av" id="chAvatar"></span><div class="cht-hmain"><b id="chWith">选择左侧联系人开始聊天</b><div class="cht-sub" id="chSub"></div></div><span class="cht-read" id="chRead"></span></div>
      <div class="note warn" id="chBanner" hidden>官方客服已迁移至智能客服，本会话保留只读查看；如需咨询，请使用智能客服。</div>
      <div class="cht-unavail" id="chUnavail" hidden><div class="statebox"><b>聊天暂时无法打开</b><p>系统暂时无法凭您的登录状态打开聊天记录。聊天钥匙由您的登录状态保管，在已登录账号的设备上通常可直接查看记录。如多次尝试仍无法打开，请联系官方客服协助处理。</p><button class="btn sm grey" id="chUnavailBack" type="button">返回会话列表</button></div></div>
      <div class="cht-msgs" id="chMsgs"><div class="statebox"><b>尚未选择会话</b><p>从左侧列表选择联系人即可查看对话。</p></div></div>
      <div class="cht-comp" id="chComp"><textarea id="chInput" rows="2" placeholder="输入消息…" disabled></textarea><button class="btn" id="chSend" disabled>发送</button><button class="btn grey" id="chDel">删除对话</button></div>
    </div>
    <p style="color:var(--sub);font-size:12.5px;margin-top:8px">对话内容经端到端加密：密钥由登录状态保管，在本机静默解锁，不再有单独解锁页；修改或重置密码后，以前的聊天记录仍可正常打开。</p></div></div>`;
  const wrap = view.querySelector('.chatwrap');
  const box = $('#chList', view);
  const paintList = async () => {
    if (!view.isConnected) return;
    const r = await chatApi('/chat/api/friends');
    if (!view.isConnected) return;
    if (r.status === 200 && r.json) {
      const arr = (r.json.peers && r.json.peers.length) ? r.json.peers : (r.json.friends || r.json.list || (Array.isArray(r.json) ? r.json : []));
      const meta = CH.convMeta || {};
      box.innerHTML = arr.length ? arr.map(f => {
        const name = typeof f === 'string' ? f : (f.name || f.username || '');
        const isSys = typeof f !== 'string' && f.type === 'system';
        const label = isSys ? '官方客服' : name;
        const m = meta[name] || {};
        const unread = !!(m.lastSeq && m.lastSeq > (m.myRead || 0) && CH.currentWith !== name);
        return `<button class="row${CH.currentWith === name ? ' act' : ''}" data-peer="${esc(name)}"><span class="tile">${ic('user')}</span><span><b>${esc(label)}</b><small>${isSys ? '已迁移至智能客服，本会话只读查看' : (m.lastAt ? '最近消息 ' + fmtDate(m.lastAt) : '点此打开对话')}</small></span>${unread ? '<span class="cht-udot"></span>' : ''}<span class="chev">${ic('chevR')}</span></button>`;
      }).join('') : '<div class="statebox"><b>暂无会话</b><p>添加好友后即可开始聊天。</p></div>';
      box.querySelectorAll('[data-peer]').forEach(row => row.addEventListener('click', () => {
        const peer = row.getAttribute('data-peer');
        if (wrap) wrap.classList.add('showthread');
        chOpenConversation(peer);
      }));
    } else {
      const net = !!r.networkError; // CS2-2：接口自身网络失败走网络文案，不落兜底句（原兜底与标题重复）
      const title = net ? '网络暂时不可用' : '会话列表加载失败';
      const why = net ? '网络连接失败，请检查网络后重试。' : (r.ssoError || apiErrText(r, '会话列表加载失败，请稍后重试。'));
      box.innerHTML = `<div class="statebox"><b>${esc(title)}</b><p>${esc(why)}</p><p>对话区仍可正常使用。</p><button class="btn sm" id="ch-retry">重新加载</button></div>`;
      const rb = $('#ch-retry', view); if (rb) rb.onclick = () => paintList();
    }
  };
  /* P2-028 手机单栏分屏：点会话行进对话面、返回钮回列表（切换类仅 ≤820px CSS 生效）；
     C2 起行点击同时打开原生对话组件，返回时一并清当前会话 */
  const back = $('#ch-back', view);
  if (back) back.onclick = () => { if (wrap) wrap.classList.remove('showthread'); chLeaveConversation(); paintList(); };
  mountChatThread(view, {
    refreshList: () => { paintList(); },
    markActive: () => { paintList(); },
    backToList: () => { if (wrap) wrap.classList.remove('showthread'); chLeaveConversation(); paintList(); },
    showThread: () => { if (wrap) wrap.classList.add('showthread'); }
  });
  paintList();
};

/* ================= 论坛 ================= */
let forumBoard = null;
Views.forum = async function (view) {
  view.innerHTML = `<h1 class="pt">论坛</h1><p class="psub">使用求助、建议与反馈、官方公告。游客可浏览，登录后发帖；公告帖可评论。</p>
    <div class="tabs" id="foTabs"><div class="skel" style="height:34px;width:240px"></div></div>
    <div id="foPosts"><div class="card"><div class="skel" style="height:52px"></div></div></div>
    <div class="card"><h3>发布新帖</h3>
      <div class="field"><label>标题</label><input id="fo-title" placeholder="请输入标题"></div>
      <div class="field"><label>内容</label><textarea id="fo-body" rows="3" placeholder="请描述您的问题或建议"></textarea></div>
      <button class="btn sm" id="fo-pub">发布</button> <span id="fo-msg" style="font-size:13px;color:var(--sub)"></span></div>
    <div class="note warn">帖子与评论先审后发。被禁言时发帖区将直接显示禁言期限与原因。</div>`;
  const boardsR = await api('/api/forum/boards');
  const tabs = $('#foTabs', view);
  if (boardsR.status !== 200 || !boardsR.json) { tabs.innerHTML = ''; $('#foPosts', view).innerHTML = stateBox('论坛暂时不可用', '请稍后重新加载。', true); bindRetry(view, () => Views.forum(view)); return; }
  const boards = boardsR.json.boards || boardsR.json.list || [];
  if (!forumBoard && boards.length) forumBoard = boards[0].id || boards[0].key || boards[0].name;
  tabs.innerHTML = boards.map(b => `<button data-b="${esc(b.id || b.key || b.name)}" class="${(b.id || b.key || b.name) === forumBoard ? 'on' : ''}">${esc(b.name || b.title || b.id)}</button>`).join('');
  tabs.querySelectorAll('[data-b]').forEach(el => el.onclick = () => { forumBoard = el.getAttribute('data-b'); Views.forum(view); });
  const paintPosts = async () => {
    const box = $('#foPosts', view);
    const pr = await api('/api/forum/posts?board=' + encodeURIComponent(forumBoard || ''));
    const posts = (pr.json && (pr.json.posts || pr.json.list)) || [];
    box.innerHTML = `<div class="card"><h3>${esc(forumBoard || '帖子')}</h3>${posts.length ? posts.map(p => `<div class="row" data-pid="${esc(p.id || '')}"><span class="tile">${ic('forum')}</span><span><b>${esc(p.title || '')}</b><small>${esc(p.authorName || p.author || p.nickname || '')} · ${esc(p.createdAt ? fmtDate(p.createdAt) : (p.time || ''))} · ${p.replyCount != null ? p.replyCount + ' 条回复' : ''}</small></span>${p.board === 'announcements' ? '<span class="tag">公告</span>' : ''}</div>`).join('') : '<div class="statebox"><b>暂无帖子</b><p>来发布第一篇帖子吧。</p></div>'}</div>`;
    box.querySelectorAll('[data-pid]').forEach(el => el.onclick = () => { forumListMemo = { board: forumBoard, scrollY: window.scrollY }; forumMemoArmed = true; navigate('post', el.getAttribute('data-pid')); });
    if (forumMemoArmed && forumListMemo && forumListMemo.board === forumBoard) {
      const y = forumListMemo.scrollY; forumListMemo = null; forumMemoArmed = false;
      requestAnimationFrame(() => window.scrollTo(0, y));
    }
  };
  paintPosts();
  $('#fo-pub', view).onclick = async () => {
    const msg = $('#fo-msg', view);
    // 发帖前走一次性 SSO 换论坛会话（与现行口径一致）
    const so = await api('/api/forum/sso-token', { method: 'POST', json: {} });
    if (so.json && so.json.loginPath) await api(so.json.loginPath);
    const r = await forumFetch('/api/forum/posts', { method: 'POST', json: { board: forumBoard, title: $('#fo-title', view).value.trim(), body: $('#fo-body', view).value.trim() } });
    msg.textContent = (r.json && (r.json.msg || (r.json.ok ? '已提交，审核通过后显示。' : '发布未成功，请稍后再试。'))) || '发布未成功，请稍后再试。';
    if (r.json && r.json.ok) { $('#fo-title', view).value = ''; $('#fo-body', view).value = ''; paintPosts(); }
  };
};

/* ================= 论坛帖子详情（P2-037） ================= */
var forumListMemo = null;      // {board, scrollY}：帖行点击时写入，返回列表恢复一次
var forumMemoArmed = false;    // 武装标记：仅刚从详情返回的列表渲染可消费 memo
let postReloadSeq = 0;         // 详情整帖重拉序号（防乱序覆盖）

/* 论坛写操作单次请求助手：与 api() 同形、同 init，唯不自动重试——
   发帖/回帖非幂等，网络异常自动重试会重复落库（服务端无幂等键）。 */
async function forumFetch(path, opts) {
  opts = opts || {};
  const init = { credentials: 'include', method: opts.method || 'GET', headers: {} };
  if (opts.json !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(opts.json); }
  if (opts.headers) Object.assign(init.headers, opts.headers);
  try {
    const r = await fetch(path, init);
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch (e) { /* 非 JSON 响应按文本处理 */ }
    return { status: r.status, ok: r.ok, json, text };
  } catch (e) { return { status: 0, ok: false, json: null, text: '', networkError: e }; }
}

/* 论坛会话建立（与发帖流同一对调用）。返回：
   {state:'live', me} 已登录（me 含 muted/accountStatus）｜
   {state:'notice', msg} 只读提示（msg 为服务端原文，可为 null）｜
   {state:'open'} 网络不定态（显示侧 fail-open，终裁在提交回执）。
   onCookieReady 在 sso-login 落 cookie 后回调，详情 GET 须带会话先行。 */
async function forumEnsureSession(onCookieReady) {
  const done = () => { if (onCookieReady) onCookieReady(); };
  const so = await api('/api/forum/sso-token', { method: 'POST', json: {} });
  if (so.status === 0) { done(); return { state: 'open' }; }
  if (!so.json || !so.json.ok) {
    done();
    if (so.json && so.json.msg) return { state: 'notice', msg: so.json.msg };
    return { state: 'open' };
  }
  if (so.json.loginPath) await api(so.json.loginPath);
  done();
  const me = await api('/api/forum/me');
  if (me.status === 0) return { state: 'open' };
  if (me.json && me.json.user) return { state: 'live', me: me.json };
  return { state: 'notice', msg: null };
}

function pfStatusTags(x) {
  let s = '';
  if (x.status === 'pending') s += '<span class="tag pf-t-pend">待审核</span>';
  if (x.status === 'rejected') s += '<span class="tag pf-t-rej">已驳回' + (x.reviewCategory ? '：' + esc(x.reviewCategory) : '') + '</span>';
  if (x.banHidden) s += '<span class="tag pf-t-hid">暂不可见</span>';
  return s;
}
function pfAuthor(x) {
  return esc(x.authorName || x.author || '') + (x.authorOfficial ? ' <span class="tag pf-off">官方</span>' : '');
}

Views.post = async function (view, param, seq) {
  const id = String(param || '');
  view.innerHTML = `<div class="pf-backrow"><button class="btn ghost sm" id="pf-back">← 返回</button></div>
    <div id="pfPost"><div class="card"><div class="skel" style="height:52px"></div></div></div>
    <div id="pfReplies"></div>
    <div id="pfComposer"><div class="card"><div class="skel" style="height:40px"></div></div></div>`;
  const backBtn = $('#pf-back', view);
  if (backBtn) backBtn.onclick = () => { if (forumListMemo) forumBoard = forumListMemo.board; navigate('forum'); };
  const alive = () => seq === renderSeq && S.route.name === 'post' && S.route.param === id;
  if (!/^p\d+$/.test(id)) {
    $('#pfPost', view).innerHTML = stateBox('帖子不存在或不可见。', '请返回帖子列表查看其他帖子。', false);
    $('#pfComposer', view).innerHTML = '';
    return;
  }
  let sessState = null;
  let boardNames = null;
  const paintMain = (post, replies) => {
    const boardName = (boardNames && boardNames[post.board]) || post.board || '';
    $('#pfPost', view).innerHTML = `<div class="card"><h2 class="pf-title">${esc(post.title || '')} ${pfStatusTags(post)}</h2>
      <div class="pf-meta">${pfAuthor(post)} · ${esc(boardName)} · ${fmtDate(post.createdAt)} · 浏览 ${post.views || 0} · 回复 ${post.replyCount != null ? post.replyCount : (replies || []).length}</div>
      ${post.mine && post.status === 'pending' ? '<div class="note warn" style="margin-top:10px">本帖正在审核中，审核通过后其他用户可见。</div>' : ''}
      <div class="pf-body">${esc(post.body || '')}</div></div>`;
    const items = replies || [];
    $('#pfReplies', view).innerHTML = `<div class="card"><h3>回复（${items.length}）</h3>${items.length ? items.map(r => `<div class="pf-reply"><div class="pf-meta">${pfAuthor(r)} · ${fmtDate(r.createdAt)} ${pfStatusTags(r)}</div><div class="pf-rbody">${esc(r.body || '')}</div></div>`).join('') : '<div class="statebox"><b>暂无回复</b><p id="pf-empty-sub" hidden>来发表第一条回复吧。</p></div>'}</div>`;
  };
  const reloadPost = async () => {
    const my = ++postReloadSeq;
    const det = await api('/api/forum/posts/' + encodeURIComponent(id));
    if (my !== postReloadSeq || !alive() || det.status !== 200 || !det.json || !det.json.ok) return;
    paintMain(det.json.post, det.json.replies || []);
    const items = view.querySelectorAll('.pf-reply');
    if (items.length) items[items.length - 1].scrollIntoView({ block: 'nearest' });
  };
  const paintComposer = () => {
    const box = $('#pfComposer', view);
    const hint = $('#pf-empty-sub', view);
    const setHint = (on) => { if (hint) hint.hidden = !on; };
    const renderEditor = () => {
      box.innerHTML = `<div class="card"><h3>发表回复</h3>
        <div class="field"><textarea id="pf-text" rows="3" placeholder="请输入回复内容"></textarea><div class="hint">回复内容为 1 至 2000 字，提交后先审后发。</div></div>
        <button class="btn sm" id="pf-send">发表回复</button> <span id="pf-msg" style="font-size:13px"></span></div>`;
      const btn = $('#pf-send', view), ta = $('#pf-text', view), msg = $('#pf-msg', view);
      let sending = false;
      btn.onclick = async () => {
        if (sending) return;
        const body = (ta.value || '').trim();
        if (!body) { msg.textContent = '请填写回复内容，长度为 1 至 2000 字。'; msg.style.color = 'var(--err)'; return; }
        sending = true; btn.disabled = true; ta.disabled = true; msg.textContent = '';
        const fail = (text) => { msg.textContent = text; msg.style.color = 'var(--err)'; };
        try {
          let r = await forumFetch('/api/forum/posts/' + encodeURIComponent(id) + '/replies', { method: 'POST', json: { body } });
          if (r.status === 401) {
            // 无会话 401 发生在服务端落库之前（路由闸门），重交换后可安全单次重提
            const re = await forumEnsureSession();
            if (re.state === 'live') { sessState = re; r = await forumFetch('/api/forum/posts/' + encodeURIComponent(id) + '/replies', { method: 'POST', json: { body } }); }
            else { fail(re.state === 'notice' ? (re.msg || '登录后可回复。') : '网络暂时不可用，请稍后再试。'); return; }
          }
          if (r.status === 0) { fail('网络暂时不可用，请稍后再试。'); return; }
          const j = r.json || {};
          if (j.ok) { msg.textContent = j.msg || '回复成功。'; msg.style.color = 'var(--ok)'; ta.value = ''; reloadPost(); }
          else fail(j.msg || '提交未成功，请稍后再试。');
        } finally { sending = false; btn.disabled = false; ta.disabled = false; }
      };
    };
    if (!sessState || sessState.state === 'open') { renderEditor(); setHint(true); return; }
    if (sessState.state === 'notice') { box.innerHTML = `<div class="card"><div class="note warn" style="margin:0">${esc(sessState.msg || '登录后可回复。')}</div></div>`; setHint(false); return; }
    const me = sessState.me || {};
    // 状态呈现顺序与服务端门 runGatesAndReview 一致：账号冻结/封禁先于禁言（DS 实现稿偏离#1 采纳）
    if (me.accountStatus && me.accountStatus !== 'ok') {
      box.innerHTML = `<div class="card"><div class="note err" style="margin:0">您的账号已被冻结或封禁，无法发帖。申诉请联系官方客服，或前往官网留言。</div></div>`;
      setHint(false); return;
    }
    if (me.muted) {
      const until = me.muted.permanent ? '永久禁言' : fmtDate(me.muted.until);
      box.innerHTML = `<div class="card"><div class="note warn" style="margin:0">您已被论坛禁言（至 ${esc(until)}），仅限制论坛发言，账号与设备不受影响。申诉请联系官方客服，或前往官网留言。</div></div>`;
      setHint(false); return;
    }
    renderEditor(); setHint(true);
  };
  // 会话先行落 cookie，详情 GET 随即带会话发（作者可见自己的待审内容）
  let detResolve;
  const detP = new Promise(r => { detResolve = r; });
  const sessP = forumEnsureSession(() => { api('/api/forum/posts/' + encodeURIComponent(id)).then(detResolve); });
  const boardsP = api('/api/forum/boards');
  const det = await detP;
  if (!alive()) return;
  if (det.status === 0) {
    $('#pfPost', view).innerHTML = stateBox('网络暂时不可用', '与服务器的连接出现问题，请检查网络后重新加载。', true);
    bindRetry(view, () => Views.post(view, param, seq));
    $('#pfComposer', view).innerHTML = '';
    return;
  }
  if (det.status !== 200 || !det.json || !det.json.ok) {
    const is404 = det.status === 404;
    $('#pfPost', view).innerHTML = stateBox((det.json && det.json.msg) || '帖子不存在或不可见。', is404 ? '请返回帖子列表查看其他帖子。' : '请稍后重新加载。', !is404);
    if (!is404) bindRetry(view, () => Views.post(view, param, seq));
    $('#pfComposer', view).innerHTML = '';
    return;
  }
  const bres = await boardsP;
  if (bres.json && (bres.json.boards || bres.json.list)) {
    boardNames = {};
    (bres.json.boards || bres.json.list).forEach(b => { boardNames[b.key || b.id] = b.name || b.title || b.key || b.id; });
  }
  if (!alive()) return;
  paintMain(det.json.post, det.json.replies || []);
  sessState = await sessP;
  if (!alive()) return;
  paintComposer();
};

/* ================= 智能客服（AI 通道 + 知识库兜底 + 转人工） ================= */
Views.support = async function (view, _p, _s, opts) {
  opts = opts || {};
  view.innerHTML = `${opts.guest ? '' : '<h1 class="pt">智能客服</h1><p class="psub">先由智能客服自动回答；解决不了可转人工。未登录、账号被冻结或封禁时也可使用本页。</p>'}
    <div class="note blue">与智能客服的对话不使用端到端加密，内容仅用于客服处理。涉及账号状态时，客服只查询您本人的状态；办理类事项会先核验账号与密码，只核验、不登录。</div>
    <div class="card"><h3>智能客服 <span class="tag">AI 通道</span></h3>
    <div id="supMsgs"><div class="skel" style="height:40px"></div></div>
    <div id="supPicks" style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px"></div>
    <div style="display:flex;gap:8px"><input id="sup-in" style="flex:1;border:1px solid var(--line);border-radius:12px;padding:12px" placeholder="请输入您的问题…"><button class="btn" id="sup-send">发送</button><button class="btn ghost" id="sup-human">转人工</button></div>
    <p style="color:var(--sub);font-size:12.5px;margin-top:10px">AI 通道异常时自动切换为知识库问答，不会无响应。转人工后，处理进度在本页同一会话中显示。</p></div>`;
  const msgs = $('#supMsgs', view);
  let token = null;
  const addMsg = (who, text, mine) => {
    const d = document.createElement('div');
    d.className = 'msg' + (mine ? ' me' : '');
    d.innerHTML = mine ? `<div class="bub">${esc(text)}</div><span class="uava">${esc((S.displayName || '我').slice(0, 1))}</span>` : `<span class="uava">客</span><div class="bub">${esc(text)}<small>智能客服 · 自动回复</small></div>`;
    msgs.appendChild(d); d.scrollIntoView({ block: 'nearest' });
  };
  const setPicks = (picks) => {
    const box = $('#supPicks', view); box.innerHTML = '';
    (picks || []).forEach(p => {
      const b = document.createElement('button'); b.className = 'btn sm ghost';
      b.textContent = (p && (p.label || p.text)) || String(p);
      b.onclick = () => send(null, (p && (p.id || p.value)) || b.textContent);
      box.appendChild(b);
    });
  };
  const renderReplies = (replies) => {
    (replies || []).forEach(rp => {
      if (typeof rp === 'string') addMsg('cs', rp, false);
      else { if (rp.text) addMsg('cs', rp.text, false); if (rp.picks) setPicks(rp.picks); if (rp.options) setPicks(rp.options); if (rp.kind === 'verify-required' || (rp.follow && rp.follow.type === 'verify')) renderVerify(); }
    });
  };
  const renderVerify = () => {
    if ($('#sup-verify', view)) return;
    const d = document.createElement('div');
    d.id = 'sup-verify'; d.className = 'note warn';
    d.innerHTML = `查询账号状态前请核验身份（只核验、不登录）：<div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap"><input id="sv-u" placeholder="账号" style="flex:1;min-width:130px;border:1px solid var(--line);border-radius:10px;padding:9px"><input id="sv-p" type="password" placeholder="密码" style="flex:1;min-width:130px;border:1px solid var(--line);border-radius:10px;padding:9px"><button class="btn sm" id="sv-b">核验并查询</button></div>`;
    msgs.appendChild(d);
    $('#sv-b', d).onclick = async () => {
      const r = await api('/support/api/verify', { method: 'POST', json: { session: token, account: $('#sv-u', d).value.trim(), password: $('#sv-p', d).value } });
      const j = (r && r.json) || {};
      if (j.ok) {
        // 核对通过：撤表单并回读引擎随核验返回的状态答复（follow），与独立
        // 客服页同一口径；此前这里不读 follow、且把成功也误报「核验未通过」。
        d.remove();
        addMsg('cs', '身份核对已通过，下面按您的账号状态答复。', false);
        if (j.follow) renderReplies(j.follow);
      } else if (j.text) {
        d.remove();
        addMsg('cs', j.text, false);
      } else if (j.reason === 'unavailable') {
        addMsg('cs', '身份核对暂时不可用，无法查询账号状态。您可以先按通用指引处理，或回复「转人工」由人工协助。', false);
      } else if (j.reason === 'locked') {
        addMsg('cs', '核对次数过多，已暂时锁定，请一小时后再试；着急处理可回复「转人工」。', false);
      } else {
        addMsg('cs', '核验未通过，请核对账号与密码后重试。', false);
      }
    };
  };
  const send = async (text, pick) => {
    if (text) addMsg('me', text, true);
    const r = await api('/support/api/message', { method: 'POST', json: { session: token, text: text || undefined, pick: pick || undefined } });
    if (r.status === 200 && r.json && r.json.ok) renderReplies(r.json.replies);
    else addMsg('cs', (r.json && r.json.msg) || '客服暂时不可用，请稍后再试；也可以留下问题转人工处理。', false);
  };
  const sess = await api('/support/api/session', { method: 'POST', json: {} });
  msgs.innerHTML = '';
  if (sess.status === 200 && sess.json && sess.json.ok) {
    token = sess.json.session;
    const w = sess.json.welcome;
    addMsg('cs', typeof w === 'string' ? w : (w && w.text) || '您好，我是 QFRemote 智能客服。软件使用、密钥、积分、订单、换绑与申诉问题都可以问我；日常问题也可以聊。', false);
    if (w && w.picks) setPicks(w.picks);
  } else { addMsg('cs', '客服会话建立失败，请稍后重新进入本页。', false); }
  $('#sup-send', view).onclick = () => { const v = $('#sup-in', view).value.trim(); if (v) { $('#sup-in', view).value = ''; send(v); } };
  $('#sup-in', view).addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#sup-send', view).click(); });
  $('#sup-human', view).onclick = () => send('转人工');
};

/* ================= 购买与订单（N-1 截图审核付款，决策 #44 抽屉式 / #45 小字） ================= */
const PLANS = [
  { id: 'd1', name: '1 日套餐', price: 2, amt: '2', desc: '自激活起 24 小时有效' },
  { id: 'd7', name: '7 日套餐', price: 6, amt: '6', desc: '自激活起 168 小时有效' },
  { id: 'd30', name: '30 日套餐', price: 9.9, amt: '9.9', desc: '自激活起 720 小时有效' },
  { id: 'permanent', name: '永久套餐', price: 18, amt: '18', desc: '一次购买，终生免费更新' }
];
function fmtSecText(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  return Math.floor(s / 60) + ' 分 ' + (s % 60) + ' 秒';
}
function payCardUrl(method, amt) { return '/license/pay-cards/pay-' + method + '-' + amt + '.png'; }
function localPayCard(method, amt) { return 'assets/pay-' + method + '-' + amt + '.png'; }
function methodName(m) { return m === 'alipay' ? '支付宝' : '微信支付'; }
/* 收款码放大层（2026-10-26 站长令）：复用站内弹窗层——点任意处、关闭钮、ESC 均可收起；
   纯展示，不触碰订单状态与支付倒计时。支付方式由展开区顶部页签（[data-method]）切换
   （#47 定版结构），下方只独立展示选中方式的一张收款卡，放大热区（.qrzoom）与页签互不干扰。 */
function openQrZoom(o) {
  const amt = String(o.amt == null ? '' : o.amt);
  const fb = /^[0-9.]+$/.test(amt) ? localPayCard(o.method, amt) : '';
  const root = showModal(methodName(o.method), `
    <div class="qrzoom-box">
      <img class="qrzoom-img" src="${esc(o.url || fb)}" alt="${esc(methodName(o.method))}收款码"${fb ? ` onerror="this.onerror=null;this.src='${fb}'"` : ''}>
      <p class="qrzoom-meta">${esc(o.planName || '')} · ¥${esc(amt)}</p>
      <p class="qrzoom-tip">金额已由收款码锁定，无需修改。点击任意处关闭。</p>
    </div>`, [{ label: '关闭', primary: true }]);
  const mask = root.querySelector('.mask');
  if (mask) mask.addEventListener('click', () => closeModal());
}
/* 订单视图模型统一：只用 N-1 回的字段（id/plan/planName/amount/method/status/
   statusText/payDeadline/remainingSec/canCancel/canContinue/canSubmit/canDelete/
   createdAt/submittedAt/orderNo/keyId），不编造字段。 */
function orderPill(o) {
  const cls = (o.status === 'completed' || o.canViewKey) ? 'ok' : (o.status === 'pending_pay' ? 'warn' : (o.status === 'reviewing' ? 'brand' : (o.status === 'rejected' ? 'err' : 'off')));
  return `<span class="pill ${cls}">${esc(o.statusText || o.status || '')}</span>`;
}

Views.purchase = async function (view, param, _s, opts) {
  opts = opts || {};
  const guest = !!opts.guest || S.auth !== 'in';
  const hasPerm = !guest && S.license && /永久/.test(S.license.planName || '');
  // 叠加语境红字提示（站长 2026-10-26 亲令，文案终版逐字）：已激活时效套餐
  // （非试用、非永久、keyExpiresMs 已落点）才显示，位置＝「我的订单」按钮正下方。
  const stackNote = (!guest && !hasPerm && S.license && S.license.keyPlan !== 'permanent' && S.license.keyExpiresMs && !/试用/.test(S.license.planName || ''))
    ? '<p style="color:var(--err);font-size:13.5px;margin:0 0 14px">购买叠加的用户，购买后请到我的账户中兑换叠加套餐</p>' : '';
  let expanded = null;                 // 当前展开的套餐 id（单开）
  const byPlan = {};                   // planId -> { order, pay }
  const ensureOrderFlights = {};       // 批A-W3-F1：planId -> true（建单在飞守卫，防收起再展开重复建单）
  const guestMethod = {};              // 游客态各套餐选中的支付方式（页签切换仅换展示，无订单）
  let timer = null;
  const stopTimer = () => { if (timer) { clearInterval(timer); timer = null; } };

  view.innerHTML = `${opts.guest ? '' : '<h1 class="pt">购买密钥</h1><p class="psub">一个密钥可绑定两台电脑与一台手机；购买付费密钥后同时开通网页版。点开任一套餐即可在本页付款，付款后提交账单截图等待审核。</p>'}
    ${guest ? '' : '<p style="margin-bottom:14px"><button class="btn sm ghost" id="pur-orders">我的订单</button></p>'}
    ${stackNote}
    <div class="planlist" id="purList">${PLANS.map(p => {
      const dis = hasPerm && p.id === 'permanent';
      return `<div class="planitem" data-planitem="${p.id}">
        <button class="planhead" data-plan="${p.id}" aria-expanded="false" ${dis ? 'disabled' : ''}>
          <span><b>${esc(p.name)}</b><small>${dis ? '您已持有永久套餐，不可重复购买' : esc(p.desc)}</small></span>
          <span class="planprice">¥${esc(p.amt)}</span><span class="chev">${ic('chevR')}</span>
        </button>
        <div class="drawerpay" data-drawer="${p.id}" hidden></div>
      </div>`;
    }).join('')}</div>
    <div class="note blue" style="margin-top:16px">待支付订单保留 15 分钟，超时自动取消；可在「我的订单」中继续支付或手动取消。提交账单截图后订单进入审核，审核通过后可在「我的订单」查看并复制密钥，粘贴激活后即可使用。</div>`;
  const ordersBtn = $('#pur-orders', view);
  if (ordersBtn) ordersBtn.onclick = () => navigate('orders');

  function drawerEl(planId) { return view.querySelector('[data-drawer="' + planId + '"]'); }
  function paintHeads() {
    view.querySelectorAll('[data-planitem]').forEach(it => {
      const pid = it.getAttribute('data-planitem');
      it.classList.toggle('open', pid === expanded);
      const head = it.querySelector('[data-plan]');
      if (head) head.setAttribute('aria-expanded', pid === expanded ? 'true' : 'false');
      const dr = it.querySelector('[data-drawer]');
      if (dr) dr.hidden = pid !== expanded;
    });
  }
  function startTimer(planId, deadlineMs) {
    stopTimer();
    const tick = () => {
      const el = view.querySelector('[data-cd="' + planId + '"]');
      if (!el || !el.isConnected || expanded !== planId) { stopTimer(); return; }
      const left = Math.max(0, Math.floor((deadlineMs - Date.now()) / 1000));
      el.textContent = fmtSecText(left);
      if (left <= 0) stopTimer();
    };
    tick();
    timer = setInterval(tick, 1000);
  }

  function renderDrawer(planId) {
    const dr = drawerEl(planId); if (!dr) return;
    const plan = PLANS.find(x => x.id === planId);
    if (guest) {
      const gm = guestMethod[planId] || 'wechat';
      const gUrl = localPayCard(gm, plan.amt);
      dr.innerHTML = `
        <div class="paytabs"><button class="paytab ${gm === 'wechat' ? 'on' : ''}" data-gmethod="wechat">微信支付</button><button class="paytab ${gm === 'alipay' ? 'on' : ''}" data-gmethod="alipay">支付宝</button></div>
        <div class="paycard single"><div class="qrzoom" data-zoom="${gm}" data-zoomurl="${gUrl}"><img src="${gUrl}" alt="${esc(methodName(gm))}收款码"><p class="qrzoom-hint">点击二维码放大</p></div><p>¥${esc(plan.amt)} · 金额已由收款码锁定，无需修改</p></div>
        <div class="drawerops"><button class="btn" data-act="paid">支付成功</button><button class="btn grey" data-act="leave">取消</button></div>
        <div data-out></div>`;
      bindDrawerOps(planId);
      return;
    }
    const st = byPlan[planId];
    if (!st) { dr.innerHTML = '<div class="skel" style="height:60px"></div><p style="color:var(--sub);font-size:13.5px;margin-top:10px">正在创建订单…</p>'; return; }
    if (st.error) {
      dr.innerHTML = `<div class="note err" style="margin:0">${esc(st.error)}</div>
        <div class="drawerops"><button class="btn grey" data-act="leave">取消</button></div>`;
      bindDrawerOps(planId);
      return;
    }
    const o = st.order, pay = st.pay || {};
    const amt = String(o.amount != null ? o.amount : plan.amt);
    const curMethod = o.method || pay.method || 'wechat';
    const wxUrl = curMethod === 'wechat' ? (pay.cardUrl || payCardUrl('wechat', amt)) : (pay.otherCardUrl || payCardUrl('wechat', amt));
    const aliUrl = curMethod === 'alipay' ? (pay.cardUrl || payCardUrl('alipay', amt)) : (pay.otherCardUrl || payCardUrl('alipay', amt));
    const curUrl = curMethod === 'wechat' ? wxUrl : aliUrl;
    if (o.status === 'reviewing') {
      dr.innerHTML = `<div class="note ok" style="margin:0 0 10px">已提交，正在审核。审核通过后，可在「我的订单」查看并复制密钥，粘贴激活后即可使用。</div>
        <table><tr><th>本站订单</th><td>${esc(o.id)}</td></tr><tr><th>套餐</th><td>${esc(o.planName || plan.name)} · ¥${esc(amt)}</td></tr><tr><th>状态</th><td>${orderPill(o)}</td></tr></table>
        <div class="drawerops"><button class="btn grey" data-act="leave">收起</button><button class="btn sm ghost" data-act="orders">查看我的订单</button></div>`;
      bindDrawerOps(planId);
      return;
    }
    if (o.status !== 'pending_pay') {
      dr.innerHTML = `<div class="note blue" style="margin:0 0 10px">该订单当前状态：${esc(o.statusText || o.status)}。</div>
        <div class="drawerops"><button class="btn grey" data-act="leave">收起</button><button class="btn sm ghost" data-act="orders">查看我的订单</button></div>`;
      bindDrawerOps(planId);
      return;
    }
    const deadline = o.payDeadline || (Date.now() + (Number(o.remainingSec) || 0) * 1000);
    dr.innerHTML = `
      <p style="font-size:13.5px;color:var(--sub);margin-bottom:4px">本站订单：${esc(o.id)} · ${orderPill(o)} · 剩余支付时间：<b data-cd="${planId}">${fmtSecText(o.remainingSec)}</b></p>
      <p style="font-size:13.5px;color:var(--sub);margin-bottom:12px">请扫码付款 <b style="color:var(--navy)">¥${esc(amt)}</b>，金额已由收款码锁定，无需修改。在上方选择微信支付或支付宝，下方只显示对应的收款码；切换支付方式沿用原订单与剩余时间。点击二维码可放大查看。</p>
      <div class="paytabs"><button class="paytab ${curMethod === 'wechat' ? 'on' : ''}" data-method="wechat">微信支付</button><button class="paytab ${curMethod === 'alipay' ? 'on' : ''}" data-method="alipay">支付宝</button></div>
      <div class="paycard single"><div class="qrzoom" data-zoom="${curMethod}" data-zoomurl="${esc(curUrl)}"><img src="${esc(curUrl)}" alt="${esc(methodName(curMethod))}收款码" onerror="this.onerror=null;this.src='${localPayCard(curMethod, amt)}'"><p class="qrzoom-hint">点击二维码放大</p></div><p>¥${esc(amt)} · 当前支付方式：${esc(methodName(curMethod))}</p></div>
      <div class="drawerops"><button class="btn" data-act="paid">支付成功</button><button class="btn grey" data-act="leave">取消</button></div>
      <div data-out></div>
      <div data-submit hidden>
        <h3 style="color:var(--navy);margin:16px 0 6px">提交付款截图</h3>
        <p style="color:var(--sub);font-size:13.5px;margin-bottom:12px">请上传付款账单详情截图。<b style="color:var(--err)">截图必须露出完整订单号</b>，并填写截图中的订单号。一个订单号只能兑换一把密钥。</p>
        <img src="${esc(pay.exampleUrl || '/license/assets/pay-example.jpg')}" alt="账单详情截图示例" style="display:block;max-width:250px;width:100%;margin:0 auto 12px;border:1px solid var(--line);border-radius:10px" onerror="this.style.display='none'">
        <div class="field"><label>订单号</label><input data-ono maxlength="64" placeholder="请填写截图中的完整订单号"></div>
        <div class="field"><label>账单详情截图（JPG / PNG，不超过 12 MB）</label><input type="file" data-shot accept="image/jpeg,image/png"></div>
        <div data-ocr hidden style="margin:2px 0 10px"></div>
        <button class="btn block" data-act="submit">提交审核</button>
        <div data-subout style="margin-top:12px"></div>
      </div>`;
    bindDrawerOps(planId);
    startTimer(planId, deadline);
  }

  function bindDrawerOps(planId) {
    const dr = drawerEl(planId); if (!dr) return;
    // 截图订单号自动识别（选图即触发，仅回填、不拦提交；失败静默回落手输。文案 WEB-0398~0403）
    const ocrFileEl = dr.querySelector('[data-shot]');
    const ocrOnoEl = dr.querySelector('[data-ono]');
    const ocrBox = dr.querySelector('[data-ocr]');
    let ocrInvalidate = null; // 门一 S9：提交动作经此作废在飞识别（下方提交分支调用）
    if (ocrFileEl && ocrOnoEl && ocrBox && !guest) {
      let ocrSeq = 0;
      let ocrTimer = null;
      const OCR_TIMEOUT_MS = 14000; // 门一 D5：客户端本地超时（13–15s 档），超时置未认出文案并作废在飞响应
      const normOno = (s) => String(s == null ? '' : s).normalize('NFKC').replace(/\s+/g, ''); // 门一 S8：与服务端 A12 同口径（NFKC＋去空白）后再比较
      const ocrHint = (t) => { ocrBox.hidden = false; ocrBox.innerHTML = `<p style="font-size:13px;color:var(--sub);margin:0">${esc(t)}</p>`; };
      const ocrClearTimer = () => { if (ocrTimer) { clearTimeout(ocrTimer); ocrTimer = null; } };
      ocrInvalidate = () => { ocrSeq++; ocrClearTimer(); ocrBox.hidden = true; ocrBox.innerHTML = ''; };
      ocrFileEl.addEventListener('change', async () => {
        const my = ++ocrSeq;
        ocrClearTimer();
        const f = ocrFileEl.files ? ocrFileEl.files[0] : null;
        const st = byPlan[planId];
        if (!f || !st || !st.order) { ocrBox.hidden = true; ocrBox.innerHTML = ''; return; }
        ocrHint('正在识别订单号…');
        ocrTimer = setTimeout(() => {
          ocrTimer = null;
          if (my !== ocrSeq) return;
          ocrSeq++; // 本地超时作废在飞：迟到响应不得再回填
          ocrHint('未能识别订单号，请手动填写。');
        }, OCR_TIMEOUT_MS);
        let j = null;
        try {
          const b64 = await readFileBase64(f);
          const r = await api('/license/api/pay/orders/' + encodeURIComponent(st.order.id) + '/recognize', { method: 'POST', json: { imageBase64: b64 } });
          j = r && r.json ? r.json : null;
        } catch (e) { j = null; }
        if (my !== ocrSeq) return; // 已重选图/已提交/已超时，旧响应作废
        ocrClearTimer();
        if (j && j.ok === false && j.code === 'PAYLOAD_TOO_LARGE') {
          // 门一 D3：超限单独同句提示（与提交侧同文案），不走静默回落；其余 ok:false 码维持静默
          ocrHint(j.msg || '截图文件过大，请上传不超过 12 MB 的 JPG 或 PNG 图片。');
        } else if (j && j.ok && j.found && j.orderNo) {
          const cur = ocrOnoEl.value;
          if (!normOno(cur)) { ocrOnoEl.value = j.orderNo; ocrHint('已自动识别订单号，请核对无误后提交。'); }
          else if (normOno(cur) === j.orderNo) { ocrHint('识别结果与您填写的订单号一致。'); }
          else {
            ocrBox.hidden = false;
            ocrBox.innerHTML = `<p style="font-size:13px;color:var(--sub);margin:0 0 8px">您填写的订单号与识别结果不一致。</p><button type="button" class="btn sm ghost" data-ocruse>识别到订单号（尾号 ${esc(j.tail4 || String(j.orderNo).slice(-4))}），点击使用识别结果</button>`;
            const useBtn = ocrBox.querySelector('[data-ocruse]');
            if (useBtn) useBtn.onclick = () => { ocrOnoEl.value = j.orderNo; ocrHint('已自动识别订单号，请核对无误后提交。'); };
          }
        } else { ocrHint('未能识别订单号，请手动填写。'); }
      });
    }
    dr.querySelectorAll('[data-zoom]').forEach(z => {
      z.onclick = (e) => {
        e.stopPropagation(); // 放大热区与卡片切换热区分离：点码只放大，不触发支付方式切换
        const plan = PLANS.find(x => x.id === planId);
        const st = byPlan[planId];
        const amt = (!guest && st && st.order && st.order.amount != null) ? String(st.order.amount) : (plan ? plan.amt : '');
        openQrZoom({ method: z.getAttribute('data-zoom'), url: z.getAttribute('data-zoomurl'), planName: plan ? plan.name : '', amt });
      };
    });
    dr.querySelectorAll('[data-gmethod]').forEach(t => {
      t.onclick = () => { // 游客态页签：仅切换展示的收款卡，无订单、不走 continue
        const m = t.getAttribute('data-gmethod');
        if ((guestMethod[planId] || 'wechat') !== m) { guestMethod[planId] = m; renderDrawer(planId); }
      };
    });
    dr.querySelectorAll('[data-method]').forEach(tab => {
      tab.onclick = async () => {
        if (guest) return;
        const st = byPlan[planId]; if (!st || !st.order) return;
        const m = tab.getAttribute('data-method');
        if (m === st.order.method) return;
        const r = await api('/license/api/pay/orders/' + encodeURIComponent(st.order.id) + '/continue', { method: 'POST', json: { method: m } });
        if (r.json && r.json.ok && r.json.pay) { st.pay = r.json.pay; st.order = Object.assign({}, st.order, { method: r.json.pay.method, remainingSec: r.json.pay.remainingSec }); renderDrawer(planId); }
        else toast(apiErrText(r, '切换支付方式失败，请稍后再试。'), 'err');
      };
    });
    dr.querySelectorAll('[data-act]').forEach(el => {
      el.onclick = async () => {
        const act = el.getAttribute('data-act');
        const out = dr.querySelector('[data-out]');
        if (act === 'orders') { navigate('orders'); return; }
        if (act === 'leave') {
          expanded = null; stopTimer(); paintHeads();
          if (!guest) toast('订单已保留为待支付，请在 15 分钟内于「我的订单」继续支付或手动取消。', 'info');
          return;
        }
        if (act === 'paid') {
          if (guest || S.auth !== 'in') { if (out) out.innerHTML = '<div class="note warn" style="margin-top:12px">下单前请先登录；没有账号可以先注册（注册即开通 3 天免费试用）。</div>'; return; }
          const sub = dr.querySelector('[data-submit]');
          if (sub) { sub.hidden = false; sub.style.scrollMarginTop = '132px'; sub.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
          return;
        }
        if (act === 'submit') {
          if (ocrInvalidate) ocrInvalidate(); // 门一 S9：提交后在飞识别一律作废，迟到响应不得回填
          const subout = dr.querySelector('[data-subout]');
          const onoEl = dr.querySelector('[data-ono]');
          const fileEl = dr.querySelector('[data-shot]');
          const ono = onoEl ? onoEl.value.trim() : '';
          const f = fileEl && fileEl.files ? fileEl.files[0] : null;
          const fail = m => { if (subout) subout.innerHTML = `<div class="note err" style="margin:0">${esc(m)}</div>`; };
          if (!ono) return fail('请填写订单号。');
          if (!f) return fail('请选择账单详情截图。');
          if (f.size > 12 * 1024 * 1024) return fail('截图文件过大，请上传不超过 12 MB 的 JPG 或 PNG 图片。');
          el.disabled = true; el.textContent = '提交中…';
          try {
            const b64 = await readFileBase64(f);
            const st = byPlan[planId];
            const r = await api('/license/api/pay/orders/' + encodeURIComponent(st.order.id) + '/submit', { method: 'POST', json: { orderNo: ono, imageBase64: b64 } });
            el.disabled = false; el.textContent = '提交审核';
            if (r.json && r.json.ok) { st.order = r.json.order || Object.assign({}, st.order, { status: 'reviewing', statusText: '正在审核' }); stopTimer(); renderDrawer(planId); toast('已提交，正在审核。', 'ok'); }
            else fail(apiErrText(r, '提交失败，请稍后再试。'));
          } catch (e) { el.disabled = false; el.textContent = '提交审核'; fail('截图读取失败，请重新选择文件后重试。'); }
        }
      };
    });
  }

  async function ensureOrder(planId) {
    if (guest) { renderDrawer(planId); return; }
    if (byPlan[planId] && byPlan[planId].order) { renderDrawer(planId); return; }
    if (ensureOrderFlights[planId]) { renderDrawer(planId); return; } // 批A-W3-F1：在飞期间重复进入只渲染加载态，不二次建单
    renderDrawer(planId); // 加载态
    ensureOrderFlights[planId] = true;
    try {
      const r = await api('/license/api/pay/orders', { method: 'POST', json: { plan: planId, method: 'wechat' } });
      if (r.json && r.json.ok && r.json.order) byPlan[planId] = { order: r.json.order, pay: r.json.pay || null };
      else if (r.status === 401 || r.status === 403) byPlan[planId] = { error: '登录状态已失效，请重新登录后再购买。' };
      else byPlan[planId] = { error: apiErrText(r, '订单创建未成功，请稍后再试。') };
      if (expanded !== planId) return; // 用户已切换/收起，结果已缓存于 byPlan，重新展开直接用，不再重复建单
      renderDrawer(planId);
    } finally {
      delete ensureOrderFlights[planId];
    }
  }

  view.querySelectorAll('[data-plan]').forEach(el => {
    el.onclick = () => {
      const pid = el.getAttribute('data-plan');
      if (expanded === pid) { expanded = null; stopTimer(); paintHeads(); return; }
      expanded = pid; paintHeads();
      if (guest) renderDrawer(pid); else ensureOrder(pid);
    };
  });

  // 从「我的订单 · 继续支付」进入：param 为订单 id，先 continue 取支付数据再展开对应套餐
  if (param && !guest) {
    const r = await api('/license/api/pay/orders/' + encodeURIComponent(param) + '/continue', { method: 'POST', json: {} });
    if (r.json && r.json.ok && r.json.pay) {
      const pay = r.json.pay;
      const planId = pay.plan;
      if (planId && PLANS.some(p => p.id === planId)) {
        byPlan[planId] = { order: { id: pay.orderId, plan: pay.plan, planName: pay.planName, amount: pay.amount, method: pay.method, status: pay.status || 'pending_pay', statusText: '待支付', remainingSec: pay.remainingSec, payDeadline: Date.now() + (Number(pay.remainingSec) || 0) * 1000, canCancel: true, canContinue: true, canSubmit: true, canDelete: false }, pay };
        expanded = planId; paintHeads(); renderDrawer(planId);
      }
    } else if (r.json) toast(apiErrText(r, '该订单当前不能继续支付。'), 'warn');
    else toast('网络暂时不可用，请检查网络后重试。', 'err'); // 批A-W3-F3：网络失败（json 为空）不再静默
  }
};

Views.orders = async function (view) {
  view.innerHTML = `<h1 class="pt">我的订单</h1><p class="psub">待支付订单可在 15 分钟内继续支付，超时自动取消；待审核订单不可取消或删除；已取消、已完成与审核未通过订单可以删除（仅删除您的显示，后台台账保留）。</p>
    <div id="ordList"><div class="card"><div class="skel" style="height:52px"></div></div></div>`;
  const box = $('#ordList', view);
  const r = await api('/license/api/pay/orders');
  if (r.status === 401 || r.status === 403) {
    box.innerHTML = stateBox('登录状态已失效', '请重新登录后查看我的订单。', false);
    return;
  }
  if (r.networkError || !r.json) { netFail(box, () => Views.orders(view)); return; }
  if (!r.json.ok || !Array.isArray(r.json.orders)) {
    box.innerHTML = `<div class="card"><div class="statebox"><b>订单暂时无法加载</b><p>${esc(apiErrText(r, '请稍后重新加载。'))}</p><button class="btn sm" data-retry="1">重新加载</button></div></div>`;
    bindRetry(box, () => Views.orders(view));
    return;
  }
  const orders = r.json.orders;
  if (!orders.length) {
    box.innerHTML = `<div class="card"><div class="statebox"><b>暂无订单</b><p>购买密钥后，订单将显示在这里。</p><button class="btn sm" data-go="purchase">去购买密钥</button></div></div>`;
    const g = $('[data-go]', box); if (g) g.onclick = () => navigate('purchase');
    return;
  }
  box.innerHTML = orders.map(o => `
    <div class="card" data-order="${esc(o.id)}">
      <div class="dev" style="border:none;padding:0">
        <span><b>${esc(o.planName || o.plan || '')}</b><small>本站订单：${esc(o.id)} · ${esc(methodName(o.method))} · 下单时间：${o.createdAt ? fmtDate(o.createdAt) : '—'}${o.orderNo ? ' · 账单订单号：' + esc(o.orderNo) : ''}</small></span>
        <span class="ops"><b style="color:var(--navy)">¥${esc(String(o.amount))}</b> ${orderPill(o)}</span>
      </div>
      ${o.status === 'pending_pay' ? `<p style="color:var(--sub);font-size:13.5px;margin-top:10px">剩余支付时间：<b>${fmtSecText(o.remainingSec)}</b>（到期自动取消）</p>` : ''}
      ${o.status === 'reviewing' && !o.canViewKey ? '<p style="color:var(--sub);font-size:13.5px;margin-top:10px">正在审核，审核通过后可在此查看并复制密钥，粘贴激活后即可使用。待审核订单不可取消或删除。</p>' : ''}
      ${o.status === 'reviewing' && o.canViewKey && o.keyForm !== 'stacked' ? '<p style="color:var(--ok);font-size:13.5px;margin-top:10px">审核通过：密钥已发放到本账号。点下方「查看密钥」复制完整密钥，粘贴激活后开始使用；本站订单将在站长确认到账后转为已完成。</p>' : ''}
      ${o.status === 'reviewing' && o.canViewKey && o.keyForm === 'stacked' ? '<p style="color:var(--ok);font-size:13.5px;margin-top:10px">审核通过：本单为叠加购买，所购时长已并入你的密钥，无需再次激活；本站订单将在站长确认到账后转为已完成。</p>' : ''}
      ${o.status === 'completed' && o.keyForm !== 'stacked' ? '<p style="color:var(--ok);font-size:13.5px;margin-top:10px">已完成：密钥已发放到本账号，可在下方查看密钥，或在「我的」查看密钥状态。</p>' : ''}
      ${o.status === 'completed' && o.keyForm === 'stacked' ? '<p style="color:var(--ok);font-size:13.5px;margin-top:10px">已完成：本单为叠加购买，所购时长已并入你的密钥。可在下方查看既有密钥，或在「我的」查看密钥状态。</p>' : ''}
      ${o.canViewKey && o.keyForm === 'stacked' ? `<p style="color:var(--sub);font-size:13.5px;margin-top:10px">本单为叠加购买，时长已并入你的密钥${o.keyMasked ? '（' + esc(o.keyMasked) + '）' : ''}${o.keyActivated && o.keyExpiresMs ? '，并入后到期时间：' + esc(fmtDate(o.keyExpiresMs)) : ''}${o.keyActivated === false ? '，该密钥尚未激活，激活时累计时长一并起算' : ''}。</p>` : ''}
      ${o.status === 'cancelled' ? '<p style="color:var(--sub);font-size:13.5px;margin-top:10px">订单已取消。</p>' : ''}
      ${o.status === 'rejected' ? '<p style="color:var(--err);font-size:13.5px;margin-top:10px">审核未通过。如有疑问，请联系智能客服处理。</p>' : ''}
      <p style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">
        ${o.canContinue ? `<button class="btn sm" data-cont="${esc(o.id)}">继续支付</button>` : ''}
        ${o.canViewKey ? `<button class="btn sm" data-viewkey="${esc(o.id)}">查看密钥</button>` : ''}
        ${o.canCancel ? `<button class="btn sm grey" data-cancel="${esc(o.id)}">取消订单</button>` : ''}
        ${o.canDelete ? `<button class="btn sm danger" data-del="${esc(o.id)}">删除</button>` : ''}
      </p>
      ${o.canViewKey && o.keyStr && o.keyForm !== 'stacked' ? `<div id="ordkey-${esc(o.id)}" style="display:none"><div class="note ok" style="margin:0"><div style="font-size:13px;color:var(--sub);margin-bottom:6px">本单密钥（完整串）</div><b style="user-select:all;word-break:break-all;font-size:16px;letter-spacing:.5px">${esc(o.keyStr)}</b><p style="margin-top:10px"><button class="btn sm" data-copykey="${esc(o.id)}">复制密钥</button></p><p style="color:var(--sub);font-size:12.5px;margin-top:8px">复制后到登录激活提示或「兑换 KEY」处粘贴即可激活，激活后开始计时。</p></div></div>` : ''}
      ${o.canViewKey && o.keyStr && o.keyForm === 'stacked' ? `<div id="ordkey-${esc(o.id)}" style="display:none"><div class="note ok" style="margin:0"><div style="font-size:13px;color:var(--sub);margin-bottom:6px">既有密钥（完整串）</div><b style="user-select:all;word-break:break-all;font-size:16px;letter-spacing:.5px">${esc(o.keyStr)}</b><p style="margin-top:10px"><button class="btn sm" data-copykey="${esc(o.id)}">复制密钥</button></p>${o.keyActivated ? '<p style="color:var(--sub);font-size:12.5px;margin-top:8px">该密钥已激活，正在计时，无需再次粘贴激活。</p>' : '<p style="color:var(--sub);font-size:12.5px;margin-top:8px">该密钥尚未激活。复制后到登录激活提示或「兑换 KEY」处粘贴激活，本单时长已并入，激活时一并起算。</p>'}</div></div>` : ''}
    </div>`).join('');
  box.querySelectorAll('[data-viewkey]').forEach(el => el.onclick = () => {
    const id = el.getAttribute('data-viewkey');
    const d = document.getElementById('ordkey-' + id);
    if (!d) return;
    const show = d.style.display === 'none';
    d.style.display = show ? 'block' : 'none';
    el.textContent = show ? '收起密钥' : '查看密钥';
  });
  box.querySelectorAll('[data-copykey]').forEach(el => el.onclick = async () => {
    const o = orders.find(x => x.id === el.getAttribute('data-copykey'));
    if (!o || !o.keyStr) return;
    let okCopy = false;
    try { await navigator.clipboard.writeText(o.keyStr); okCopy = true; } catch (e) {}
    if (!okCopy) {
      const ta = document.createElement('textarea');
      ta.value = o.keyStr; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { okCopy = document.execCommand('copy'); } catch (e) {}
      ta.remove();
    }
    if (!okCopy) toast('复制失败，请展开密钥后长按手动复制。', 'warn');
    else if (o.keyForm === 'stacked' && o.keyActivated) toast('密钥已复制。该密钥已激活，无需再次粘贴激活。', 'ok');
    else toast('密钥已复制，去粘贴激活吧。', 'ok');
  });
  box.querySelectorAll('[data-cont]').forEach(el => el.onclick = () => navigate('purchase', el.getAttribute('data-cont')));
  box.querySelectorAll('[data-cancel]').forEach(el => el.onclick = () => {
    const id = el.getAttribute('data-cancel');
    confirmModal('取消订单', '确定取消该订单？取消后不能恢复，需要购买时请重新下单。', '取消订单', async () => {
      const rr = await api('/license/api/pay/orders/' + encodeURIComponent(id) + '/cancel', { method: 'POST', json: {} });
      if (rr.json && rr.json.ok) { toast('订单已取消。', 'ok'); Views.orders(view); }
      else toast(apiErrText(rr, '取消失败，请稍后再试。'), 'err');
    });
  });
  box.querySelectorAll('[data-del]').forEach(el => el.onclick = () => {
    const id = el.getAttribute('data-del');
    confirmModal('删除订单', '删除后该订单不再显示（后台台账保留）。确定删除？', '删除', async () => {
      const rr = await api('/license/api/pay/orders/' + encodeURIComponent(id) + '/delete', { method: 'POST', json: {} });
      if (rr.json && rr.json.ok) { toast('订单已删除。', 'ok'); Views.orders(view); }
      else toast(apiErrText(rr, '删除失败，请稍后再试。'), 'err');
    });
  });
};

/* ================= 积分与福利（N-2 签到 / 福利兑换 / 待兑换列表） =================
   字段口径以服务端实测为准（与 N-2 文档的差异已记入 PURCHASE-REPORT）：
   - /points/api/me：顶层 points/totalSeconds/displayText 来自 computeMe，
     earn 子对象含 balance/todayGranted/todayCap/checkinDone/usageSecToday/
     usageGrantedToday/deviceGrantedToday/nextPointInSec/ledger。
   - /points/api/checkin：成功回 {ok,balance,earn}（文档所列 todayGranted
     不在顶层、在 earn.todayGranted）；失败回 {ok:false,code,msg}。
   - /points/api/welfare：offers 项为 {plan,planName,cost}（文档写作 points，
     实测为 cost）；records 为扣分台账项 {at,kind,delta,balance,note}。 */
Views.points = async function (view) {
  view.innerHTML = `<h1 class="pt">积分与福利中心</h1><p class="psub">积分由服务器计时，每日上限 10 分，账号与设备任一达到上限当日不再计分。</p>
    <div id="ptsBody"><div class="card"><div class="skel" style="height:60px"></div></div></div>`;
  const box = $('#ptsBody', view);
  const [r, wr, kr] = [await api('/points/api/me'), await api('/points/api/welfare'), await api('/license/api/mykeys')];
  if (r.status === 401 || r.status === 403) { box.innerHTML = stateBox('登录状态已失效', '请重新登录后查看积分与福利。', false); return; }
  if (r.status !== 200 || !r.json || !r.json.ok) { box.innerHTML = stateBox('积分服务暂时不可用', '请稍后重新加载。', true); bindRetry(box, () => Views.points(view)); return; }
  const j = r.json; if (j.points != null) S.points = j;
  const earn = j.earn || {};
  const balance = earn.balance != null ? earn.balance : (j.points != null ? j.points : 0);
  const hours = j.totalSeconds != null ? (j.totalSeconds / 3600).toFixed(1) : '—';
  const checkinDone = !!earn.checkinDone;
  const todayGranted = earn.todayGranted != null ? earn.todayGranted : 0;
  const todayCap = earn.todayCap != null ? earn.todayCap : 10;
  const offers = (wr.json && wr.json.ok && Array.isArray(wr.json.offers) && wr.json.offers.length) ? wr.json.offers : [{ plan: 'd1', planName: 'QFRemote 1日套餐', cost: 200 }, { plan: 'd7', planName: 'QFRemote 7日套餐', cost: 500 }];
  const records = (wr.json && wr.json.ok && Array.isArray(wr.json.records)) ? wr.json.records : [];
  const mykeys = (kr.json && kr.json.ok && Array.isArray(kr.json.keys)) ? kr.json.keys : [];
  const pendingKeys = mykeys.filter(k => k.canRedeem || k.activated === false || k.lifecycle === 'unactivated');
  const offerCost = o => (o.cost != null ? o.cost : (o.points != null ? o.points : 0));
  const offerName = o => (o.planName || (o.plan === 'd7' ? '7 日密钥' : '1 日密钥'));
  box.innerHTML = `
    <div class="grid2"><div class="card"><h3>我的积分</h3><div class="stat"><div><b id="pt-balance">${esc(String(balance))}</b><span>当前积分</span></div><div><b>${esc(String(hours))}</b><span>累计在线（小时）</span></div><div><b>${esc(String(todayGranted))} / ${esc(String(todayCap))}</b><span>今日已得 / 上限</span></div></div>
      <p style="color:var(--sub);font-size:13px;margin-top:10px">${esc(j.displayText || '')}</p></div>
    <div class="card"><h3>赚取积分</h3>
      ${rowInfoHtml('award', '每日签到', checkinDone ? '今日已签到' : '每天签到得 1 分')}
      <div style="margin:-6px 0 10px 55px"><button class="btn sm" id="pt-sign" ${checkinDone ? 'disabled' : ''}>${checkinDone ? '今日已签到' : '签到'}</button></div>
      ${rowInfoHtml('refresh', '使用软件计时', '软件与服务器保持在线满 1 小时得 1 分' + (earn.nextPointInSec != null ? '（距下一分约 ' + Math.ceil(Number(earn.nextPointInSec) / 60) + ' 分钟）' : ''))}
      <div id="pt-out" style="margin-top:10px"></div>
    </div></div>
    <div class="card"><h3>福利中心 · 兑换密钥</h3>
      ${offers.map(o => `${rowInfoHtml('key', offerName(o), offerCost(o) + ' 分兑换 · 兑换后进入下方待兑换列表')}
      <div style="margin:-6px 0 10px 55px"><button class="btn sm ghost" data-redeem="${esc(o.plan)}" data-cost="${esc(String(offerCost(o)))}">兑换${o.plan === 'd7' ? ' 7 日' : ' 1 日'}密钥</button></div>`).join('')}
      <div class="note warn" style="margin-top:12px">积分兑换的密钥为免费来源，不开通网页版；兑换所得为未激活密钥，自兑换激活时刻起计时。</div>
      <div id="wf-out" style="margin-top:10px"></div></div>
    <div class="card"><h3>待兑换列表</h3><div id="pt-pending">
      ${pendingKeys.length ? pendingKeys.map(k => `<div class="row"><span class="tile">${ic('key')}</span><span><b>${esc(k.planName || '密钥')}</b><small>${esc(k.masked || '')} · 来源：${esc(k.sourceLabel || '')} · ${esc(k.expiresText || '未激活，激活后起算')}</small></span><span class="ops" style="margin-left:auto"><button class="btn sm" data-keyredeem="${esc(k.keyId)}">兑换并激活</button></span></div>`).join('') : '<div class="statebox"><b>暂无待兑换密钥</b><p>用积分兑换的密钥将显示在这里，兑换并激活后开始计时。</p></div>'}
    </div></div>
    <div class="card"><h3>兑换记录</h3>
      ${records.length ? '<table><tr><th>项目</th><th>积分变化</th><th>时间</th></tr>' + records.map(x => `<tr><td>${esc(x.note || '福利兑换')}</td><td>${esc(String(x.delta != null ? x.delta : ''))}</td><td>${x.at ? fmtDate(x.at) : ''}</td></tr>`).join('') + '</table>' : '<div class="statebox"><b>暂无兑换记录</b><p>在福利中心兑换密钥后，记录将显示在这里。</p></div>'}
    </div>`;
  const ptOut = $('#pt-out', box);
  const signBtn = $('#pt-sign', box);
  if (signBtn) signBtn.onclick = async () => {
    signBtn.disabled = true; signBtn.textContent = '签到中…';
    const rr = await api('/points/api/checkin', { method: 'POST', json: {} });
    if (rr.json && rr.json.ok) { toast('签到成功，+1 分。', 'ok'); Views.points(view); }
    else {
      signBtn.disabled = false; signBtn.textContent = '签到';
      if (ptOut) ptOut.innerHTML = `<div class="note ${rr.json && rr.json.code === 'ALREADY_CHECKED_IN' ? 'blue' : 'err'}" style="margin:0">${esc(apiErrText(rr, '签到失败，请稍后再试。'))}</div>`;
      if (rr.json && rr.json.code === 'ALREADY_CHECKED_IN') Views.points(view);
    }
  };
  box.querySelectorAll('[data-redeem]').forEach(b => {
    b.onclick = () => {
      const plan = b.getAttribute('data-redeem');
      const cost = b.getAttribute('data-cost');
      confirmModal('兑换密钥', '确认使用 ' + cost + ' 分兑换' + (plan === 'd7' ? ' 7 日' : ' 1 日') + '密钥？兑换后密钥进入待兑换列表。', '确认兑换', async () => {
        const rr = await api('/points/api/welfare/redeem', { method: 'POST', json: { plan } });
        const wfOut = $('#wf-out', box);
        if (rr.json && rr.json.ok) { toast(rr.json.msg || '兑换成功。', 'ok'); Views.points(view); }
        else if (wfOut) wfOut.innerHTML = `<div class="note err" style="margin:0">${esc(apiErrText(rr, '兑换失败，请稍后再试。'))}</div>`;
      });
    };
  });
  box.querySelectorAll('[data-keyredeem]').forEach(b => {
    b.onclick = async () => {
      const keyId = b.getAttribute('data-keyredeem');
      b.disabled = true; b.textContent = '兑换中…';
      const rr = await api('/license/api/redeem', { method: 'POST', json: { keyId } });
      if (rr.json && rr.json.ok) { toast(rr.json.msg || '兑换成功，密钥已激活。', 'ok'); await checkSession(true); Views.points(view); }
      else { b.disabled = false; b.textContent = '兑换并激活'; toast(apiErrText(rr, '兑换失败，请稍后再试。'), 'err'); }
    };
  });
};

/* ================= 我的（我的账户） ================= */
Views.profile = async function (view) {
  const lic = S.license || {};
  view.innerHTML = `<h1 class="pt">我的</h1><p class="psub">账号、密钥与安全设置集中在本页，每项功能只有一个入口。</p>
    <div class="card"><div class="dev" style="border:none;padding:0"><span class="uava" style="width:52px;height:52px;font-size:19px">${esc((S.displayName || 'U').slice(0, 1).toUpperCase())}</span><span><b style="font-size:17px">${esc(S.displayName || '')}</b><small style="display:block;color:var(--sub)">${esc(lic.displayStatus || '账号状态正常')}</small></span><span class="ops"><button class="btn sm ghost" id="pf-edit">编辑资料</button></span></div></div>
    <div class="card"><a class="row" href="${QF_WEBSITE_URL}" target="_blank" rel="noopener" style="text-decoration:none;color:inherit"><span class="tile">${ic('globe')}</span><span><b>官方网站</b><small>打开 QFRemote 官网（软件下载与版本公告）</small></span><span class="chev">${ic('chevR')}</span></a></div>
    ${S.isAdmin ? `<div class="card"><button class="row" id="pf-admin"><span class="tile">${ic('gear')}</span><span><b>站长管理</b><small>待办、审核与账号管理（仅站长账号可见）</small></span><span class="chev">${ic('chevR')}</span></button></div>` : ''}
    <div class="grid2">
    <div class="card"><h3>兑换 KEY</h3>
      <div class="field"><label>输入密钥</label><input id="pf-key" placeholder="粘贴完整密钥串"><p class="hint">他人出售的一手未激活密钥、转赠密钥、积分兑换密钥都在这里兑换；兑换即完成归属转移并激活。</p></div>
      <button class="btn block" id="pf-claim">兑换并激活</button><div id="pf-claim-out" style="margin-top:10px"></div>
      <h3 style="margin-top:20px">待领取的转赠</h3><div id="pf-transfers"><div class="skel" style="height:40px"></div></div></div>
    <div class="card"><h3>我的密钥（查询密钥）</h3><table>
      <tr><th>套餐</th><td>${esc(lic.planName || '尚未激活')}</td></tr>
      <tr><th>密钥</th><td><span id="pf-masked">${esc(lic.maskedKey || '—')}</span> <a id="pf-reveal" style="color:var(--brand);font-weight:600;cursor:pointer">查看完整密钥（输密码核验）</a></td></tr>
      <tr><th>状态</th><td>${esc(lic.displayStatus || '—')}${lic.remainText ? ' · ' + esc(lic.remainText) : (lic.keyExpiresMs ? ' · 到期：' + fmtDate(lic.keyExpiresMs) : '')}</td></tr>
      <tr><th>设备名额</th><td>电脑 ${lic.slots ? lic.slots.pc : 0} / ${lic.slots && lic.slots.pcMax ? lic.slots.pcMax : 2} · 手机 ${lic.slots ? lic.slots.mobile : 0} / ${lic.slots && lic.slots.mobileMax ? lic.slots.mobileMax : 1}</td></tr>
      <tr><th>网页版</th><td>${lic.webEnabled ? '已开通' : '购买付费密钥后开通'}</td></tr>
      ${lic.everBanned ? '<tr><th>标记</th><td>该密钥曾被封禁（申诉恢复后保留此标记，不影响使用）</td></tr>' : ''}
      </table>
      ${rowInfoHtml('key', '转赠密钥', '付费密钥可转赠一次；对方在查询密钥处复制密钥串后，登录时粘贴领取')}
      <div style="margin:-6px 0 10px 55px"><button class="btn sm ghost" id="pf-gift">发起转赠</button> <button class="btn sm grey" id="pf-gift-cancel">撤销待领取转赠</button></div>
      ${rowInfoHtml('refresh', '申诉换绑设备', '在新设备上提交，审核通过后替换同类旧设备')}
      <div style="margin:-6px 0 4px 55px"><button class="btn sm ghost" id="pf-rebind">提交换绑申诉</button></div>
    </div></div>
    <div class="card"><h3>账号与安全</h3><div id="pfSec">
      ${rowHtml('lock', '更改密码', '修改后其他设备需重新登录')}
      ${rowHtml('file', '查看以前的登录', '最近登录：' + (S.stats && S.stats.lastLoginMs ? fmtDate(S.stats.lastLoginMs) : '—'))}
      ${rowHtml('headset', '我的申诉与进度', '封禁申诉、换绑申诉都在这里查进度')}
      ${rowHtml('forum', '意见反馈', '提交后进入处理队列')}
      ${rowHtml('refresh', '检查更新', '查看当前版本与更新说明')}
      ${rowHtml('user', '退出登录', '')}
      ${rowHtml('user', '删除账户', '删除后数据按规则清除，此操作不可恢复')}
    </div></div>`;
  $('#pf-edit', view).onclick = () => showModal('编辑资料', '<p>昵称等资料的修改将随新控制台账户接口一并开通；当前显示名与登录账号一致。</p>', [{ label: '知道了' }]);
  if (S.isAdmin) { const pa = $('#pf-admin', view); if (pa) pa.onclick = () => navigate('admin'); }
  $('#pf-claim', view).onclick = async () => {
    const key = $('#pf-key', view).value.trim(); const out = $('#pf-claim-out', view);
    if (!key) { out.innerHTML = '<div class="note warn">请先粘贴密钥。</div>'; return; }
    const r = await api('/license/api/transfer/claim', { method: 'POST', json: { key } });
    if (r.json && r.json.ok) { out.innerHTML = '<div class="note ok">兑换成功，密钥已归属本账号并激活。</div>'; await checkSession(true); toast('兑换成功。', 'ok'); }
    else out.innerHTML = `<div class="note err">${esc((r.json && r.json.msg) || '兑换失败，请核对密钥后重试。')}</div>`;
  };
  // 待领取转赠
  const tr = await api('/license/api/transfers');
  const tbox = $('#pf-transfers', view);
  if (tr.status === 200 && tr.json) {
    const arr = tr.json.transfers || tr.json.incoming || (Array.isArray(tr.json) ? tr.json : []);
    const pend = arr.filter(t => (t.status || 'pending') === 'pending' || t.pending);
    tbox.innerHTML = pend.length ? pend.map(t => `<div class="row"><span class="tile">${ic('key')}</span><span><b>${esc(t.planName || '转赠密钥')}</b><small>来自 ${esc(t.from || t.giver || '')} · 在上方输入框粘贴密钥串即可领取</small></span></div>`).join('') : '<div class="statebox"><b>暂无待领取的转赠</b><p>收到转赠时，对方密钥串会显示在查询结果中，复制后在上方粘贴领取。</p></div>';
  } else tbox.innerHTML = '<div class="statebox"><b>转赠列表暂时不可用</b><p>请稍后重新加载本页。</p></div>';
  $('#pf-gift', view).onclick = () => {
    showModal('发起转赠', `<div class="field"><label>对方账号</label><input id="gf-to" placeholder="请输入对方完整账号"></div><p style="font-size:13px;color:var(--sub)">转赠发起后，密钥在对方领取前仍归您使用，您可随时撤销；对方领取的那一刻，您的全部会话将被退出登录。待领取有效期 3 天。</p>`,
      [{ label: '取消' }, { label: '发起转赠', primary: true, onClick: async () => {
        const to = $('#gf-to').value.trim();
        const tr = await api('/license/api/transfers');
        const tk = ((tr.json && tr.json.keys) || []).find(x => x.transferable);
        if (!tk) { toast('当前没有可转赠的密钥（仅付费密钥可转赠，每把密钥限转赠一次）。', 'err'); return; }
        const r = await api('/license/api/transfer/initiate', { method: 'POST', json: { toUsername: to, keyId: tk.keyId } });
        if (r.json && r.json.ok) toast('转赠已发起。', 'ok'); else toast((r.json && r.json.msg) || '发起失败，请核对对方账号。', 'err');
      } }]);
  };
  $('#pf-gift-cancel', view).onclick = async () => {
    const tr = await api('/license/api/transfers');
    const pend = ((tr.json && tr.json.outgoing) || []).find(t => t.status === 'pending');
    if (!pend) { toast('当前没有可撤销的转赠。', 'info'); return; }
    const r = await api('/license/api/transfer/cancel', { method: 'POST', json: { transferId: pend.id } });
    toast(r.json && r.json.ok ? '已撤销待领取转赠（不占用转赠次数）。' : ((r.json && r.json.msg) || '当前没有可撤销的转赠。'), r.json && r.json.ok ? 'ok' : 'info');
  };
  $('#pf-rebind', view).onclick = () => {
    showModal('申诉换绑设备', `<div class="field"><label>本机设备码</label><input id="rb2-dc" placeholder="在本机软件端查看"></div>
      <div class="field"><label>设备类型</label><select id="rb2-pf"><option value="pc">电脑</option><option value="mobile">手机</option></select></div>
      <div class="field"><label>账号密码（核验身份）</label><input id="rb2-pw" type="password"></div>
      <div class="field"><label>情况说明</label><textarea id="rb2-desc" rows="2"></textarea></div>`,
      [{ label: '取消' }, { label: '提交', primary: true, onClick: async () => {
        const r = await api('/license/api/rebind/submit', { method: 'POST', json: { username: S.user, password: $('#rb2-pw').value, desc: $('#rb2-desc').value, deviceCode: $('#rb2-dc').value.trim(), platform: $('#rb2-pf').value, channel: 'web' } });
        toast(r.json && r.json.ok ? '换绑申诉已提交，进度可在本页查看。' : ((r.json && r.json.msg) || '提交失败，请核对信息。'), r.json && r.json.ok ? 'ok' : 'err');
      } }]);
  };
  $('#pf-reveal', view).onclick = () => {
    showModal('查看完整密钥', `<div class="field"><label>请输入账号密码核验</label><input id="rv-pw" type="password"></div><div id="rv-out"></div>`,
      [{ label: '取消' }, { label: '核验', primary: true, onClick: async () => {
        const r = await api('/license/api/status/reveal', { method: 'POST', json: { username: S.user, password: $('#rv-pw').value } });
        if (r.json && r.json.ok && r.json.key) { $('#pf-masked', view).textContent = r.json.key; toast('已显示完整密钥。', 'ok'); }
        else toast((r.json && r.json.msg) || '核验失败。', 'err');
      } }]);
  };
  const secRows = $('#pfSec', view).querySelectorAll('.row');
  const acts = [
    () => toast('更改密码将在新控制台账户安全接口开通后在本页办理；当前可在软件端修改。', 'warn'),
    () => toast('登录记录以本页与首页显示的最近登录为准。', 'info'),
    () => navigate('appeal'),
    () => navigate('forum'),
    async () => { const r = await api('/release.json'); toast(r.json ? ('当前控制台版本信息：' + (r.json.version || r.json.latest || '已是最新')) : '暂时无法获取版本信息。', 'info'); },
    () => doLogout(),
    () => showModal('删除账户', '<p>删除账户为不可恢复操作。如需办理，请通过智能客服转人工提交申请，核验身份后按规则清除数据。</p>', [{ label: '知道了' }, { label: '联系客服', primary: true, onClick: () => navigate('support') }])
  ];
  secRows.forEach((row, i) => { if (acts[i]) row.onclick = acts[i]; });
};

/* ================= 申诉（C1 收编二期·变基重建） =================
   申诉改为控制台原生组件：提交与进度查询都在本组件内完成，不再打开
   独立页或弹窗内嵌页。服务端接口一字不动——仍按登录垫片的现行契约
   以表单方式提交（POST /appeal 提交、POST /appeal/status 查进度，
   均返回整页 HTML），组件解析返回页中的结果块（.ok/.err/.status）
   后在组件内原生呈现；核验口径不变：仅账号＋密码、失败不透露细节。
   独立 /appeal 页保留为无脚本环境与直达链接的兜底，不在本组件引用。 */
function extractAppealResult(pageHtml) {
  try {
    const doc = new DOMParser().parseFromString(String(pageHtml || ''), 'text/html');
    const ok = doc.querySelector('.ok');
    if (ok) return ok.outerHTML;
    const st = doc.querySelector('.status');
    if (st && st.parentElement) return st.parentElement.innerHTML;
    const err = doc.querySelector('.err');
    if (err) return err.outerHTML;
  } catch (e) { /* 解析失败按无结果处理，调用方给正式提示 */ }
  return '';
}
/* 申诉结果块白名单净化（C-01）：垫片返回整页 HTML，组件只取结果块再入 DOM，
   入 DOM 前一律经此净化——标签/属性白名单＋站内链接白名单，杜绝把组件安全
   寄托于垫片一侧的转义纪律：
   · 丢弃子树的高危标签（脚本/样式/框架/表单/媒体/foreign content）；
   · 非白名单标签拆壳保内容，避免信息静默丢失；
   · 仅保留 /appeal/status 与 /appeal/reset 两类站内链接，且强制 rel="noreferrer"；
   · 其余属性（on* 事件、style、id、data-*、src 等）一律不复制。 */
const APPEAL_OK_TAGS = new Set(['DIV', 'P', 'SPAN', 'B', 'STRONG', 'EM', 'I', 'U', 'SMALL', 'BR', 'HR',
  'UL', 'OL', 'LI', 'A', 'H3', 'H4', 'H5', 'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TH', 'TD', 'CODE', 'PRE']);
const APPEAL_DROP_TAGS = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'FRAME', 'FRAMESET', 'OBJECT', 'EMBED',
  'LINK', 'META', 'BASE', 'FORM', 'INPUT', 'BUTTON', 'TEXTAREA', 'SELECT', 'OPTION', 'SVG', 'MATH',
  'IMG', 'VIDEO', 'AUDIO', 'SOURCE', 'CANVAS', 'TEMPLATE', 'NOSCRIPT']);
function appealSafeHref(href) {
  const raw = String(href == null ? '' : href).trim();
  if (!raw || raw.charAt(0) !== '/') return '';          // 只认站内绝对路径（同时挡掉 javascript:/data:）
  if (raw.charAt(1) === '/' || raw.charAt(1) === '\\') return '';   // 挡协议相对 //evil.example
  if (/[\s\\]/.test(raw)) return '';                     // 挡空白 / 反斜杠变形
  const p = raw.split('?')[0].split('#')[0];
  if (p !== '/appeal/status' && p !== '/appeal/reset') return '';   // 只放行两类必要的站内链接
  return raw;
}
function appealSafeClass(v) {
  const s = String(v == null ? '' : v).trim();
  return /^[A-Za-z0-9_\- ]{1,120}$/.test(s) ? s : '';
}
function appealCopySafe(node, parent) {
  if (!node) return;
  if (node.nodeType === 3) { parent.appendChild(document.createTextNode(String(node.nodeValue || ''))); return; }
  if (node.nodeType !== 1) return;                       // 注释 / 处理指令一律丢弃
  const tag = node.tagName;
  if (APPEAL_DROP_TAGS.has(tag)) return;                 // 整个子树丢弃
  if (!APPEAL_OK_TAGS.has(tag)) {                        // 未知标签：拆壳保留安全子内容
    Array.prototype.slice.call(node.childNodes).forEach(n => appealCopySafe(n, parent));
    return;
  }
  if (tag === 'A') {
    const href = appealSafeHref(node.getAttribute('href'));
    if (!href) {                                         // 非法链接降级为纯文本内容
      Array.prototype.slice.call(node.childNodes).forEach(n => appealCopySafe(n, parent));
      return;
    }
    const a = document.createElement('a');
    a.setAttribute('href', href);
    a.setAttribute('rel', 'noreferrer');
    const cls = appealSafeClass(node.getAttribute('class'));
    if (cls) a.setAttribute('class', cls);
    Array.prototype.slice.call(node.childNodes).forEach(n => appealCopySafe(n, a));
    parent.appendChild(a);
    return;
  }
  const el = document.createElement(tag);
  const cls = appealSafeClass(node.getAttribute('class'));
  if (cls) el.setAttribute('class', cls);
  if (tag === 'TD' || tag === 'TH') {
    ['colspan', 'rowspan'].forEach(name => {
      const v = node.getAttribute(name);
      if (v && /^\d{1,3}$/.test(v)) el.setAttribute(name, v);
    });
  }
  Array.prototype.slice.call(node.childNodes).forEach(n => appealCopySafe(n, el));
  parent.appendChild(el);
}
function sanitizeAppealHtml(html) {
  const out = document.createElement('div');
  try {
    const tpl = document.createElement('template');
    tpl.innerHTML = String(html || '');
    Array.prototype.slice.call(tpl.content.childNodes).forEach(n => appealCopySafe(n, out));
  } catch (e) { return ''; }
  return out.innerHTML;
}
function renderAppeal(box, opts) {
  opts = opts || {};
  box.innerHTML = `<div class="card" style="margin-top:16px"><h3>账号申诉</h3>
    <p style="color:var(--sub);font-size:13.5px;margin-bottom:12px">账号被冻结或封禁时可在此提交申诉。身份核验仅使用账号与密码，核验不会登录账号；核验不通过时不会透露具体原因。申诉次数上限：永久封禁 2 次、其他情形 3 次（同一事项）。</p>
    <div class="tabs" style="margin-bottom:14px"><button type="button" class="on" id="ap-tab-new">提交申诉</button><button type="button" id="ap-tab-q">申诉进度</button></div>
    <div id="ap-new">
      <div class="field"><label>账号</label><input id="ap-user" autocomplete="username" placeholder="请输入账号"></div>
      <div class="field"><label>账号密码（仅用于核验身份）</label><input id="ap-pass" type="password" autocomplete="current-password" placeholder="请输入密码"></div>
      <div class="field"><label>联系邮箱</label><input id="ap-email" placeholder="用于接收处理结果通知"></div>
      <div class="field"><label>情况说明</label><textarea id="ap-desc" rows="3" placeholder="请说明账号被冻结或封禁的情况"></textarea></div>
      <div class="field"><label>新的证据或补充说明（再次申诉时必填，首次申诉可留空）</label><textarea id="ap-newev" rows="2"></textarea></div>
      <button class="btn block" id="ap-btn" type="button">提交申诉</button>
      <div id="ap-out" style="margin-top:12px"></div>
    </div>
    <div id="ap-q" hidden>
      <div class="field"><label>账号</label><input id="apq-user" placeholder="请输入账号"></div>
      <button class="btn block" id="apq-btn" type="button">查询进度</button>
      <div id="apq-out" style="margin-top:12px"></div>
    </div>
  </div>`;
  const tabNew = $('#ap-tab-new', box), tabQ = $('#ap-tab-q', box);
  const secNew = $('#ap-new', box), secQ = $('#ap-q', box);
  const showSec = (q) => {
    secNew.hidden = !!q; secQ.hidden = !q;
    tabNew.classList.toggle('on', !q); tabQ.classList.toggle('on', !!q);
    if (q) { const u = $('#ap-user', box).value.trim(); if (u && !$('#apq-user', box).value) $('#apq-user', box).value = u; }
  };
  tabNew.onclick = () => showSec(false);
  tabQ.onclick = () => showSec(true);
  if (opts.user) $('#ap-user', box).value = opts.user;
  const wireStatusLinks = (outBox) => {
    outBox.querySelectorAll('a[href^="/appeal/status"]').forEach(a => {
      a.addEventListener('click', (ev) => {
        ev.preventDefault();
        let u = '';
        try { u = new URL(a.getAttribute('href'), location.origin).searchParams.get('u') || ''; } catch (e) { /* 用已填账号兜底 */ }
        if (u) $('#apq-user', box).value = u;
        showSec(true);
        $('#apq-btn', box).click();
      });
    });
  };
  $('#ap-btn', box).onclick = async () => {
    const out = $('#ap-out', box);
    const user = $('#ap-user', box).value.trim();
    const pass = $('#ap-pass', box).value;
    const email = $('#ap-email', box).value.trim();
    const desc = $('#ap-desc', box).value.trim();
    const newev = $('#ap-newev', box).value.trim();
    if (!user || !pass || !email || !desc) { out.innerHTML = '<div class="note err">账号、密码、联系邮箱、情况说明均须填写。</div>'; return; }
    const btn = $('#ap-btn', box); btn.disabled = true; btn.textContent = '正在提交…';
    const r = await api('/appeal', { method: 'POST', form: { username: user, password: pass, email, desc, newev } });
    btn.disabled = false; btn.textContent = '提交申诉';
    if (r.networkError) {
      /* POST /appeal 非幂等且不自动重发（见 api() 白名单），网络中断时提交可能
         已被受理；提示先查进度再决定是否重提，避免白白消耗申诉次数。 */
      out.innerHTML = '<div class="note err">提交结果未知：网络中断，本次提交可能已被服务器受理。请先到「申诉进度」查询，确认未受理后再重新提交，以免消耗申诉次数。</div>';
      return;
    }
    const html = r.text ? extractAppealResult(r.text) : '';
    const safe = html ? sanitizeAppealHtml(html) : '';
    if (safe) { out.innerHTML = safe; wireStatusLinks(out); }
    /* 未能取得明确结果块（5xx/页面形态变化等）：提交可能已受理并计次，
       一律按「结果未知」引导先查进度，不提示直接重提（N-6，C-02 同口径）。 */
    else out.innerHTML = '<div class="note err">提交结果未知：未收到明确的提交结果，本次提交可能已被服务器受理。请先到「申诉进度」查询，确认未受理后再重新提交，以免消耗申诉次数。</div>';
  };
  $('#apq-btn', box).onclick = async () => {
    const out = $('#apq-out', box);
    const user = $('#apq-user', box).value.trim();
    if (!user) { out.innerHTML = '<div class="note err">请输入账号。</div>'; return; }
    const btn = $('#apq-btn', box); btn.disabled = true; btn.textContent = '正在查询…';
    const r = await api('/appeal/status', { method: 'POST', form: { username: user } });
    btn.disabled = false; btn.textContent = '查询进度';
    if (r.networkError) { out.innerHTML = '<div class="note err">查询未完成：网络中断，请检查网络后重试。</div>'; return; }
    const html = r.text ? extractAppealResult(r.text) : '';
    const safe = html ? sanitizeAppealHtml(html) : '';
    out.innerHTML = safe || '<div class="note err">未查询到该账号的申诉记录。</div>';
  };
  if (opts.openQuery) showSec(true);
}
Views.appeal = function (view) {
  view.innerHTML = `<h1 class="pt">申诉与进度</h1><p class="psub">账号被冻结或封禁时在此提交申诉，并可查询处理进度。身份核验仅使用账号与密码。</p><div id="apRoot"></div>`;
  renderAppeal($('#apRoot', view), { user: S.user || '' });
};

/* ================= 站长管理 ================= */
Views.admin = async function (view) {
  if (!S.isAdmin) {
    view.innerHTML = `<h1 class="pt">站长管理</h1><div class="card"><div class="statebox"><b>无权访问</b><p>本页仅站长账号可见。当前账号没有站长权限，相关入口不会出现在导航中。</p></div></div>`;
    return;
  }
  view.innerHTML = `<h1 class="pt">站长管理</h1><p class="psub">仅站长账号可见。本页汇总全部待办，不再分散到多个后台。</p><div id="admBody"><div class="card"><div class="skel" style="height:60px"></div></div></div>`;
  /* P2-022 修复：原接线按不存在的字段读数（overview.pendingOrders 等、appeals.appeals），
     且从未调用 /admin/api/assistant，导致统计恒显「—」、申诉恒空、API 卡误报未开通。
     现按服务端真实返回对齐：overview={keys,bans,orders,deviceReviews}、appeals={pending,recent}、
     assistant={token,counts,recentDone}、users={users}、orders={orders,enabled}。 */
  const [ov, ap, as, us, od] = [await api('/admin/api/license/overview'), await api('/admin/api/appeals'), await api('/admin/api/assistant'), await api('/admin/api/users'), await api('/admin/api/orders')];
  const box = $('#admBody', view);
  const oj = ov.json || {};
  const appeals = (ap.json && ap.json.pending) || [];
  const counts = (as.json && as.json.counts) || {};
  const tok = (as.json && as.json.token) || {};
  const recentDone = (as.json && as.json.recentDone) || [];
  const userCount = (us.json && us.json.users) ? us.json.users.length : 0;
  const orderList = (od.json && od.json.orders) || [];
  const pendReview = orderList.filter(x => x.status === 'reviewing').length;
  const dayStr = ts => new Date(ts).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' });
  const todayOrders = orderList.filter(x => x.createdAt && dayStr(x.createdAt) === dayStr(Date.now())).length;
  const pendAnomaly = (oj.deviceReviews || []).filter(x => x.status === 'pending').length;
  const tokText = tok.status === 'active' ? '已启用' : (tok.status === 'revoked' ? '已吊销' : '未生成');
  const cntNames = { order: '付款订单', appeal: '申诉', rebind: '换绑申请', device_review: '设备异常', forum: '论坛待审', support: '客服工单' };
  const cntLine = Object.keys(cntNames).map(k => cntNames[k] + ' ' + (counts[k] || 0)).join(' · ');
  const doneHtml = recentDone.slice(0, 5).map(e => `<div style="font-size:13px;color:var(--sub);margin-top:6px">${esc(cntNames[e.type] || e.type || '')} · ${esc(e.refId || '')} · ${esc(e.handledBy || '')} · ${esc(e.result || '')}${e.handledAt ? ' · ' + fmtDate(e.handledAt) : ''}</div>`).join('');
  box.innerHTML = `
    <div class="grid3">
      <div class="card"><h3>待处理</h3><div class="stat"><div><b>${esc(String(pendReview))}</b><span>新订单待一审</span></div><div><b>${esc(String(appeals.length))}</b><span>申诉待裁定</span></div><div><b>${esc(String(counts.support || 0))}</b><span>客服求助</span></div></div></div>
      <div class="card"><h3>今日概览</h3><div class="stat"><div><b>${esc(String(userCount))}</b><span>注册账号</span></div><div><b>${esc(String(todayOrders))}</b><span>今日订单</span></div><div><b>${esc(String(pendAnomaly))}</b><span>异常登录待复核</span></div></div></div>
      <div class="card"><h3>站长 API</h3><p style="color:var(--sub);font-size:13.5px">助手事件接口：新订单、新申诉、异常登录、客服求助、换绑与论坛待审统一入队，助手经接口先审，疑难上交站长。</p><div style="margin-top:10px;font-size:13.5px">令牌状态：<b>${esc(tokText)}</b>${tok.createdAt ? ' · 生成于 ' + fmtDate(tok.createdAt) : ''}${tok.lastUsedAt ? ' · 最近调用 ' + fmtDate(tok.lastUsedAt) : ' · 尚无调用'}</div><div style="font-size:13.5px;margin-top:6px">待处理：${esc(cntLine)}</div>${doneHtml}</div>
    </div>
    <div class="card"><h3>待办队列（申诉）</h3>${appeals.length ? '<table><tr><th>类型</th><th>账号</th><th>内容</th><th>时间</th></tr>' + appeals.slice(0, 10).map(a => `<tr data-go="__admin" data-anchor="appeals" style="cursor:pointer"><td><span class="tag">${esc(a.type === 'rebind' ? '换绑设备' : (a.type || '申诉'))}</span></td><td>${esc(a.username || a.user || '')}</td><td>${esc(a.desc || a.reason || '')}</td><td>${a.createdAt ? fmtDate(a.createdAt) : ''}</td></tr>`).join('') + '</table>' : '<div class="statebox"><b>暂无待办申诉</b><p>新的申诉、换绑与异常登录复核将汇总到这里，并同步进入站长 API 事件队列。</p></div>'}</div>
    <div class="grid2"><div class="card"><h3>账号管理</h3>
      ${rowHtml('users', '用户列表与搜索', '改名、改密、冻结、封禁（危险操作均需二次确认并留痕）', '__admin', 'users')}
      ${rowHtml('users', '创建账号', '站长手动开户：填账号与初始密码，创建即发 3 天试用', '__admin', 'create')}
      ${rowHtml('key', '发放密钥', '必须选择来源：付费 / 免费（决定网页版权益），无默认', '__admin', 'lic-user')}
      ${rowHtml('key', '生成密钥（不绑账号）', '生成不绑账号的密钥串，复制交付对方，首个兑换的账号即归属', '__admin', 'genkey')}
      ${rowHtml('shield', '封禁与冻结台账', '含设备封禁与异常登录复核', '__admin', 'lic-overview')}</div>
    <div class="card"><h3>内容与服务审核</h3>
      ${rowHtml('forum', '论坛审核', '待审帖子与评论、禁言管理（与论坛同一队列）', 'forum')}
      ${rowHtml('headset', '客服收件箱', '人工工单回复与关闭', 'support')}
      ${rowHtml('cart', '订单台账', '订单号全局唯一登记，一号一钥', '__admin', 'payOrders')}</div></div>
    <div class="note err">危险操作口径：封禁、回收密钥等操作执行前二次确认，执行后在台账留痕，界面可查。界面用词统一使用「封禁」。</div>`;
  box.querySelectorAll('[data-go]').forEach(el => el.addEventListener('click', () => { const g = el.getAttribute('data-go'); if (g === '__admin') { const an = el.getAttribute('data-anchor'); location.href = '/admin' + (an ? '#' + an : ''); } else { navigate(g); } }));
};

/* 走查/调试钩子（只暴露无副作用的界面动作） */
window.__qf = { toast, navigate, setDrawer: (o) => setDrawer(o), state: () => ({ auth: S.auth, route: S.route, user: S.user }) };

/* ================= 启动 ================= */
(function boot() {
  $('#burgerBtn').innerHTML = ic('menu');
  $('#bellBtn').innerHTML = ic('bell');
  $('#topSearch').innerHTML = ic('search') + '<input id="topSearchIn" placeholder="搜索功能或关键词…">';
  $('#burgerBtn').addEventListener('click', () => setDrawer(!drawerOpen));
  $('#bellBtn').addEventListener('click', () => toast('暂无新的通知。版本公告将在论坛官方公告中发布。', 'info'));
  $('#acctChip').addEventListener('click', () => $('#acctMenu').classList.toggle('open'));
  $('#topSearchIn').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const q = e.target.value.trim();
    const hit = MENU34.concat(FUNC).concat(S.isAdmin ? [{ icon: 'gear', label: '站长管理', route: 'admin' }] : []).find(i => i.label.includes(q) || q.includes(i.label));
    if (hit) navigate(hit.route); else toast('未找到相关功能，请从主菜单进入。', 'info');
  });
  const cache = Cache.load();
  if (cache && cache.user) {
    // 进门不挡：先按缓存渲染壳，校验在后台进行；冷进入恒落首页，不再恢复上次视图（2026-10-26 站长令）
    S.auth = 'in'; S.user = cache.user; S.displayName = cache.displayName || cache.user;
    S.isAdmin = !!cache.isAdmin; S.license = cache.license; S.points = cache.points;
    location.hash = '#home';
    showShell();
    checkSession(true, { noDied: true }).then(ok => {
      if (!ok) showAuth('login', { notice: '登录状态已失效，请重新登录。' });
      else render();
    });
  } else {
    checkSession(true).then(ok => { if (ok) { location.hash = '#home'; showShell(); } else showAuth('login'); });
  }
})();
