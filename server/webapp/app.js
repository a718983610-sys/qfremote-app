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
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c2.5 2.6 3.9 5.7 3.9 9s-1.4 6.4-3.9 9c-2.5-2.6-3.9-5.7-3.9-9S9.5 5.6 12 3z"/>'
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

/* ---------------- 接口层：正式失败提示、失败自动重试一次 ---------------- */
async function api(path, opts) {
  opts = opts || {};
  const init = { credentials: 'include', method: opts.method || 'GET', headers: {} };
  if (opts.json !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(opts.json); }
  if (opts.form) { init.headers['Content-Type'] = 'application/x-www-form-urlencoded'; init.body = new URLSearchParams(opts.form).toString(); }
  if (opts.headers) Object.assign(init.headers, opts.headers);
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(path, init);
      const text = await r.text();
      let json = null; try { json = JSON.parse(text); } catch (e) { /* 非 JSON 响应按文本处理 */ }
      return { status: r.status, ok: r.ok, json, text };
    } catch (e) { lastErr = e; await new Promise(r2 => setTimeout(r2, 600)); }
  }
  return { status: 0, ok: false, json: null, text: '', networkError: lastErr };
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
async function lockApi(method, route, body) {
  return api('/lock' + route, body !== undefined ? { method, json: body } : { method });
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
let nodeMapCache = null;
function fetchControlNodes(timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; try { ws.close(); } catch (e) {} resolve(v || {}); } };
    let ws;
    try {
      const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
      ws = new WebSocket(proto + location.host + '/control.ashx');
    } catch (e) { resolve({}); return; }
    const timer = setTimeout(() => finish({}), timeoutMs || 6000);
    ws.onopen = () => { try { ws.send(JSON.stringify({ action: 'nodes', responseid: 'qf-nodes-probe' })); } catch (e) { clearTimeout(timer); finish({}); } };
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m && m.responseid === 'qf-nodes-probe') { clearTimeout(timer); finish(m.nodes || {}); }
    };
    ws.onerror = () => { clearTimeout(timer); finish({}); };
    ws.onclose = () => { clearTimeout(timer); finish({}); };
  });
}
async function fetchNodeMap() {
  if (nodeMapCache) return nodeMapCache;
  const byName = new Map(), byId = new Map(), lockDevices = [];
  let lockStatus = 'ok', lockError = '';
  const lr = await lockApi('GET', '/devices');
  if (lr.status === 200 && lr.json && Array.isArray(lr.json.devices)) {
    lr.json.devices.forEach(d => {
      const dev = { id: String(d.id || ''), name: String(d.name || ''), owner: !!d.owner, locked: !!d.locked, component: d.component !== false };
      if (!dev.id) return;
      lockDevices.push(dev);
      if (dev.name) byName.set(dev.name, dev.id);
      byId.set(dev.id, dev.name);
    });
  } else if (lr.status === 401) { lockStatus = 'needlogin'; lockError = apiErrText(lr, '登录状态已失效，请重新登录后再管理屏幕锁。'); }
  else if (lr.networkError) { lockStatus = 'unreachable'; lockError = '暂时连不上屏幕锁服务，请检查网络后重试。'; }
  else { lockStatus = 'unavailable'; lockError = apiErrText(lr, '屏幕锁服务暂未开通网页通道，暂时无法在此管理。请通过软件端管理该设备的屏幕锁。'); }
  // 控制通道补充全部可见设备（含好友共享）的节点 id；失败不拦锁面板。
  try {
    const grouped = await fetchControlNodes(6000);
    Object.values(grouped || {}).forEach(arr => {
      (Array.isArray(arr) ? arr : []).forEach(n => {
        if (!n || !n._id) return;
        const nm = String(n.name || n.rname || '');
        if (nm && !byName.has(nm)) byName.set(nm, String(n._id));
        if (!byId.has(String(n._id))) byId.set(String(n._id), nm);
      });
    });
  } catch (e) { /* 控制通道不可用时以锁桥清单为准 */ }
  nodeMapCache = { byName, byId, lockDevices, lockStatus, lockError };
  return nodeMapCache;
}
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
  forumReady: false
};
function cacheSave() {
  if (S.auth !== 'in') return;
  Cache.save({ user: S.user, displayName: S.displayName, isAdmin: S.isAdmin, license: S.license, points: S.points, route: S.route, at: Date.now() });
}
async function checkSession(silent) {
  const me = await api('/license/api/me');
  if (me.status === 200 && me.json && me.json.ok) {
    S.auth = 'in'; S.user = me.json.username; S.license = me.json;
    const st = await api('/home/api/stats');
    if (st.status === 200 && st.json && st.json.ok) { S.stats = st.json; S.displayName = st.json.displayName || me.json.username; S.isAdmin = !!st.json.isAdmin; }
    else { S.displayName = me.json.username; }
    cacheSave();
    return true;
  }
  if (me.status === 401 || me.status === 403) {
    const wasIn = S.auth === 'in';
    S.auth = 'out'; S.license = null; Cache.clear();
    if (wasIn && !silent) toast('登录状态已失效，请重新登录。', 'warn');
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
  } catch (e) { return { ok: false, msg: '网络暂时不可用，请检查网络后重试。' }; }
  // 会话校验偶发抖动时多等一轮再判，避免把非密码原因误报成密码错误
  // （2026-10-26 热修：垫片许可门吃会话曾让 /me 必 401 并被一律误报）。
  let me = await api('/license/api/me');
  if (!(me.status === 200 && me.json && me.json.ok)) { await new Promise(r => setTimeout(r, 600)); me = await api('/license/api/me'); }
  if (me.status === 200 && me.json && me.json.ok) {
    S.auth = 'in'; S.user = me.json.username; S.license = me.json;
    const st = await api('/home/api/stats');
    if (st.status === 200 && st.json && st.json.ok) { S.stats = st.json; S.displayName = st.json.displayName || S.user; S.isAdmin = !!st.json.isAdmin; }
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
  const r = await api('/points/api/heartbeat', { method: 'POST', json: { client: 'web-console-shadow' } });
  if (r.status === 200 && r.json) {
    if (r.json.forceLogout) { forceGate('G1'); return; }
    S.points = r.json; cacheSave();
  }
}
setInterval(heartbeat, 60000);                    // 在线计时/强制下线通道
setInterval(() => { if (S.auth === 'in') checkSession(true); }, 240000); // 凭证静默续期校验
function forceGate(code) {
  S.auth = 'out'; Cache.clear();
  showAuth('gate', { code: code || 'G1' });
  toast('本设备已被退出登录，请重新登录后在「我的 · 兑换 KEY」中处理激活。', 'warn');
}
async function doLogout() {
  confirmModal('退出登录', '退出后将清除本设备的登录状态与记住标记，再次使用需要重新登录。', '退出登录', async () => {
    await api('/logout'); Cache.clear();
    S.auth = 'out'; S.license = null; S.points = null;
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
function navBtn(item, activeRoute, cls) {
  const base = cls === undefined ? 'nav' : cls;
  return `<button class="${base}${item.route === activeRoute ? ' on' : ''}" data-nav="${item.route}">${ic(item.icon)}<span>${item.label}</span></button>`;
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
    `<a data-nav="${i.route}" class="${i.route === a ? 'on' : ''}">${ic(i.icon)}<span>${i.label}</span></a>`).join('') +
    (S.isAdmin ? `<a data-nav="admin" class="${a === 'admin' ? 'on' : ''}">${ic('gear')}<span>站长管理</span></a>` : '') +
    `<a href="${QF_WEBSITE_URL}" target="_blank" rel="noopener">${ic('globe')}<span>官方网站</span></a>` +
    `<a data-nav="logout" class="red">${ic('logout')}<span>登出</span></a>`;
  $('#bnav').innerHTML = BTABS.map(i => navBtn(i, a, '')).join('');
  $('#acctChip').innerHTML = `<span class="uava">${esc((S.displayName || 'U').slice(0, 1).toUpperCase())}</span><b>${esc(S.displayName || '')}</b>`;
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
  return { name: name || 'home', param: param ? decodeURIComponent(param) : null };
}
async function render() {
  const seq = ++renderSeq;
  S.route = parseRoute();
  renderNavs();
  const view = $('#view');
  const fn = Views[S.route.name] || Views.home;
  view.innerHTML = '';
  try { await fn(view, S.route.param, seq); }
  catch (e) { if (seq === renderSeq) view.innerHTML = stateBox('页面加载失败', '页面组件出现异常，请重新加载。', true), bindRetry(view, render); }
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', render);

/* ---------------- 壳与未登录区切换 ---------------- */
function showShell() {
  $('#authRoot').hidden = true;
  $('#shellRoot').hidden = false;
  if (!location.hash) location.hash = '#home';
  render();
}
function showAuth(kind, extra) {
  $('#shellRoot').hidden = true;
  const root = $('#authRoot');
  root.hidden = false;
  if (kind === 'register') return Views.register(root, extra);
  if (kind === 'gate') return Views.gate(root, extra);
  return Views.login(root, extra);
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
      $('#li-appeal', root).onclick = () => showModal('提交申诉', '<div class="framebox"><iframe src="/appeal?u=' + encodeURIComponent(uname) + '" title="申诉"></iframe></div>', [{ label: '关闭' }]);
      const sup = $('#li-fz-support', root);
      if (sup) sup.onclick = (ev) => { ev.preventDefault(); authTool(root, 'support'); };
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
function authTool(root, kind) {
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
  if (typeof v.webEnabled === 'boolean') parts.push('网页版：' + (v.webEnabled ? '已开通' : '未开通'));
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
    G2: { t: '试用已到期', b: '免费试用已经结束。输入付费密钥或兑换密钥后即可继续使用。' },
    G4: { t: '网页版尚未开通', b: '网页版需要付费密钥开通（试用与免费来源密钥不含网页版权益）。您仍可在软件端继续使用，或购买付费密钥后回到网页版。' },
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
  if (ap) ap.onclick = () => showModal('提交申诉', '<div class="framebox"><iframe src="/appeal" title="申诉"></iframe></div>', [{ label: '关闭' }]);
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
  const sec = $('#homeSec', view);
  const last = S.stats && S.stats.lastLoginMs ? fmtDate(S.stats.lastLoginMs) : '—';
  sec.innerHTML =
    rowHtml('shield', '账号状态', (lic.displayStatus || '正常') + (lic.everBanned ? ' · 该密钥曾被封禁（已恢复）' : '')) +
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
function devRowHtml(d) {
  return `<div class="dev"><span class="devic">${ic('monitor')}</span><span><b>${esc(d.name)}</b><small>${esc(d.os || '')}${d.group ? ' · 分组：' + esc(d.group) : ''}</small></span><span class="pill ${d.online ? 'ok' : 'off'}">${d.online ? '在线' : '离线'}</span><span class="ops">${d.online ? `<button class="btn sm" data-remote="${esc(d.name)}">远程桌面</button><button class="btn sm ghost" data-files="${esc(d.name)}">文件管理</button>` : '<span class="pill off">设备离线时不可连接</span>'}<button class="btn sm grey" data-detail="${esc(d.name)}">详情</button></span></div>`;
}
function bindDevRows(view) {
  view.querySelectorAll('[data-remote]').forEach(el => el.onclick = () => openNativeDesktop(el.getAttribute('data-remote')));
  view.querySelectorAll('[data-terminal]').forEach(el => el.onclick = () => openNativeTerminal(el.getAttribute('data-terminal')));
  view.querySelectorAll('[data-files]').forEach(el => el.onclick = () => navigate('files', el.getAttribute('data-files')));
  view.querySelectorAll('[data-detail]').forEach(el => el.onclick = () => navigate('device', el.getAttribute('data-detail')));
}

/* 原生直达（丙案＋站长 2026-10-26 裁定）：点设备→顶层直达该设备的 MeshCentral
   原生视图（CANON＝直连源），停用 iframe 挂载与自研远控页二次选设备。
   深链格式经基线实测（2026-10-26，含应用源码互证）：主应用自带的新标签页链接
   形态 /?node=<裸节点 id>&viewmode=<页签> 冷启 5 秒内即绑定设备数据；
   viewmode 10=设备页 / 11=桌面页签 / 12=终端页签。gotonode 冷启在本构建不绑定
   （gotoStartViewPage 守卫丢弃），不用。 */
const QF_CANON_ORIGIN = 'https://54.248.9.192:8443';
/* 官网入口（站长 2026-10-26 11:12 令补）：三容器登出上方独立行＋「我的」页独立行，
   不进 MENU34、不占 BTABS，#34 次序不动；新标签打开官网。 */
const QF_WEBSITE_URL = 'https://a718983610-sys.github.io/qfremote-website/';
const websiteNavHtml = (cls) => `<a class="${cls || 'nav'}" href="${QF_WEBSITE_URL}" target="_blank" rel="noopener">${ic('globe')}<span>官方网站</span></a>`;
/* 站长管理入口补齐（站长 2026-10-26 12:58 亲报「网页版找不到站长管理」）：该入口原仅在
   桌面侧边栏（#sidebar）渲染，≤760px 时侧边栏整体隐藏，抽屉/账户菜单/底部标签/「我的」页
   均无此入口，站长手机端无路可达。按官网入口同例补为逻辑同位：仅 S.isAdmin 时在抽屉、
   账户菜单与「我的」页各补一行（导航容器互为同位呈现，不构成 #20 重复入口）；不进
   MENU34、不占 BTABS，#34 次序不动；目标为 SPA 内站长管理页（route=admin），服务端
   /home/api/stats 的 isAdmin 判定（账号===ADMIN_EMAIL 且 siteadmin 全权）未动。 */
async function openNativeDevice(name, viewmode) {
  let id = '';
  try {
    const nm = await fetchNodeMap();
    if (name && nm.byName.has(name)) id = String(nm.byName.get(name) || '').replace(/^node\/\//, '');
  } catch (e) { /* 取不到节点标识时退回原生设备列表，仍为原生流程 */ }
  let vm = viewmode;
  /* 手机形态（服务端按 UA 下发独立的手机版原生应用，543KB）：其实测冷启 vm11/vm12
     渲染空白、vm10 设备页冷启正常绑定，故小屏落 vm10 设备页（原生页内含桌面/
     终端/Web-VNC 入口）；桌面形态维持 vm11/vm12 一步直达。此为手机版应用自身
     冷启缺陷的绕行，桌面口径不受影响（2026-10-26 抢修实测）。 */
  if (window.matchMedia && window.matchMedia('(max-width: 820px)').matches) vm = 10;
  const url = id ? (QF_CANON_ORIGIN + '/?node=' + encodeURIComponent(id) + '&viewmode=' + vm) : (QF_CANON_ORIGIN + '/');
  location.assign(url);
}
function openNativeDesktop(name) { return openNativeDevice(name, 11); }
function openNativeTerminal(name) { return openNativeDevice(name, 12); }

/* ================= 设备 ================= */
Views.devices = async function (view) {
  view.innerHTML = `<h1 class="pt">我的设备</h1><p class="psub">设备由站长分配或好友共享给您。在线设备可直接发起远程桌面、文件管理与远程终端。</p>
    <div class="tabs"><button class="on" data-tab="all">全部设备</button><button data-tab="mine">我的设备</button><button data-tab="shared">好友共享</button></div>
    <div id="devList"><div class="card"><div class="skel" style="height:52px"></div></div></div>
    <div class="note blue">可把文件发送到同账号的另一台设备（单文件上限 200 MB，离线暂存 24 小时）：在「我的文件」页选择「发送文件到其他设备」即可。</div>`;
  const st = await api('/home/api/stats');
  if (st.status === 200 && st.json && st.json.ok) S.stats = st.json;
  const mine = (S.stats && S.stats.devices) || [];
  let shared = [];
  const fm = await api('/api/friends/me');
  if (fm.status === 200 && fm.json) shared = (fm.json.sharesIn || []).map(s => ({ name: s.meshName || '共享设备组', os: '好友共享 · ' + (s.tier === 'B2' ? '可操作' : '只看'), group: s.owner || '', online: false }));
  const box = $('#devList', view);
  const paint = (tab) => {
    if (tab === 'shared') {
      box.innerHTML = `<div class="card">${shared.length ? shared.map(d => devRowHtml({ name: d.name || d.device || '', os: d.os || '好友共享', group: d.from || '', online: !!d.online })).join('') : '<div class="statebox"><b>暂无好友共享的设备</b><p>好友把设备共享给您后，将显示在这里。</p></div>'}</div>`;
    } else {
      box.innerHTML = `<div class="card">${mine.length ? mine.map(devRowHtml).join('') : '<div class="statebox"><b>暂无设备</b><p>设备上线后将显示在这里。</p></div>'}</div>`;
    }
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
      ${rowHtml('monitor', '远程桌面', '画面与键鼠控制')}${rowHtml('folder', '文件管理', '浏览、上传与下载被控端文件')}${rowHtml('file', '远程终端', '命令行会话')}
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
  if (!targets.length) { box.innerHTML = '<div class="statebox"><b>暂无可查询的设备</b><p>设备上线并取得节点标识后，待接收文件将显示在这里。</p></div>'; return; }
  let all = [];
  for (const d of targets) {
    const r = await api('/license/api/files/inbox?node=' + encodeURIComponent(nm.byName.get(d.name)));
    if (r.json && r.json.ok && Array.isArray(r.json.files)) all = all.concat(r.json.files.map(f => Object.assign({}, f, { _toName: d.name })));
  }
  if (!all.length) { box.innerHTML = '<div class="statebox"><b>暂无待接收文件</b><p>其他设备发送给您的文件将显示在这里（暂存 24 小时）。</p></div>'; return; }
  box.innerHTML = all.map(f => {
    const fromName = (f.fromNode && nm.byId.get(f.fromNode)) || (f.fromNode ? '其他设备' : '网页端');
    return `<div class="dev"><span class="devic">${ic('file')}</span><span><b>${esc(f.filename)}</b><small>${esc(fmtSize(f.size))} · 来自 ${esc(fromName)} · 接收到 ${esc(f._toName)} · ${esc(fmtRemain(f.expiresAt))}</small></span><span class="ops"><button class="btn sm" data-dl="${esc(f.id)}" data-fn="${esc(f.filename)}">下载</button></span><div class="bar" data-dlbar="${esc(f.id)}" hidden style="flex-basis:100%"><i style="width:0%"></i></div></div>`;
  }).join('');
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
    const toName = (f.toNode && nm.byId.get(f.toNode)) || '其他设备';
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
/* ================= 远程桌面（原生直达跳板） =================
   站长 2026-10-26 裁定＋丙案：回归 MeshCentral 原生概念——点设备直接进桌面。
   本视图不再承载任何界面：进入即顶层跳转到该设备的原生桌面视图。 */
Views.remote = async function (view, name) {
  view.innerHTML = `<div class="statebox"><b>正在打开远程桌面</b><p>正在进入${name ? '「' + esc(name) + '」' : '设备'}的远程桌面…</p></div>`;
  openNativeDesktop(name || '');
};

/* ================= 好友 ================= */
Views.friends = async function (view) {
  view.innerHTML = `<h1 class="pt">好友</h1><p class="psub">添加好友后，可将自己的设备组共享给对方协助处理。官方客服为系统联系人，不可删除、不参与设备共享。</p>
    <div class="grid2"><div class="card chatlist"><h3>好友列表</h3><div id="frList"><div class="skel" style="height:52px"></div></div>
      <div class="field" style="margin-top:16px"><label>添加好友（输入对方完整账号）</label><input id="fr-q" placeholder="对方账号"></div>
      <button class="btn sm" id="fr-add">发送好友申请</button> <span id="fr-msg" style="font-size:13px;color:var(--sub)"></span></div>
    <div class="card"><h3>共享给我的设备组</h3><div id="frIn"><div class="skel" style="height:52px"></div></div>
      <h3 style="margin-top:18px">我共享出的</h3><div id="frOut"><div class="skel" style="height:40px"></div></div></div></div>`;
  ensureChatToken(false);
  const paint = async () => {
    const r = await api('/api/friends/me');
    if (r.status !== 200 || !r.json) { $('#frList', view).innerHTML = '<div class="statebox"><b>好友服务暂时不可用</b><p>请稍后重新加载。</p></div>'; return; }
    const j = r.json;
    const list = $('#frList', view);
    let h = `<button class="row" data-support="1"><span class="tile">${ic('users')}</span><span><b>官方客服</b><small>智能客服与人工客服的统一入口</small></span><span class="tag">系统</span><span class="chev">${ic('chevR')}</span></button>`;
    (j.requestsIn || []).forEach(q => { h += `<div class="row"><span class="tile">${ic('user')}</span><span><b>${esc(q.from)}</b><small>请求添加您为好友</small></span><span class="ops" style="margin-left:auto;display:flex;gap:8px"><button class="btn sm" data-acc="${esc(q.from)}">同意</button><button class="btn sm grey" data-rej="${esc(q.from)}">拒绝</button></span></div>`; });
    (j.friends || []).forEach(f => { h += `<div class="row"><span class="tile">${ic('user')}</span><span><b>${esc(f.name)}</b><small>好友</small></span><span class="ops" style="margin-left:auto;display:flex;gap:8px"><button class="btn sm ghost" data-share="${esc(f.name)}">共享设备</button><button class="btn sm grey" data-del="${esc(f.name)}">删除</button></span></div>`; });
    if (!(j.friends || []).length) h += '<div class="statebox"><b>暂无好友</b><p>在下方输入对方完整账号发送申请。</p></div>';
    list.innerHTML = h;
    const sup = $('[data-support]', list); if (sup) sup.onclick = () => navigate('support');
    list.querySelectorAll('[data-acc]').forEach(b => b.onclick = async () => { const rr = await api('/api/friends/respond', { method: 'POST', json: { username: b.getAttribute('data-acc'), accept: true } }); if (rr.json && rr.json.ok) { toast((rr.json && rr.json.msg) || '已同意好友申请。', 'ok'); } else toast((rr.json && rr.json.msg) || '操作未成功，请稍后再试。', 'err'); paint(); });
    list.querySelectorAll('[data-rej]').forEach(b => b.onclick = async () => { const rr = await api('/api/friends/respond', { method: 'POST', json: { username: b.getAttribute('data-rej'), accept: false } }); if (rr.json && rr.json.ok) { toast((rr.json && rr.json.msg) || '已拒绝好友申请。', 'info'); } else toast((rr.json && rr.json.msg) || '操作未成功，请稍后再试。', 'err'); paint(); });
    list.querySelectorAll('[data-del]').forEach(b => b.onclick = () => confirmModal('删除好友', '删除后将同时撤销双方的设备共享，确定删除 ' + b.getAttribute('data-del') + ' 吗？', '删除', async () => { await api('/api/friends/remove', { method: 'POST', json: { username: b.getAttribute('data-del') } }); toast('已删除好友。', 'ok'); paint(); }));
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
    $('#frIn', view).innerHTML = (j.sharesIn || []).length ? j.sharesIn.map(s => rowHtml('monitor', (s.meshName || '共享设备组') + '（来自 ' + (s.owner || '') + '）', ((s.tier === 'operate' || s.tier === 'B2') ? '可操作' : '只看'), '')).join('') : '<div class="statebox"><b>暂无共享给我的设备组</b><p>好友共享后将显示在这里。</p></div>';
    $('#frOut', view).innerHTML = (j.sharesOut || []).length ? j.sharesOut.map(s => `<div class="row"><span class="tile">${ic('monitor')}</span><span><b>${esc(s.meshName || '设备组')}</b><small>共享给 ${esc(s.grantee || '')} · ${(s.tier === 'operate' || s.tier === 'B2') ? '可操作' : '只看'}</small></span><span class="ops" style="margin-left:auto"><button class="btn sm grey" data-unshare="${esc(s.grantee || '')}|${esc(s.meshid || '')}">撤销</button></span></div>`).join('') : '<div class="statebox"><b>暂无共享出的设备组</b><p>在好友列表中点「共享设备」即可共享。</p></div>';
    view.querySelectorAll('[data-unshare]').forEach(b => b.onclick = async () => { const [g, m] = b.getAttribute('data-unshare').split('|'); const ru = await api('/api/friends/unshare', { method: 'POST', json: { username: g, meshid: m } }); if (ru.json && ru.json.ok) { toast('已撤销共享。', 'ok'); } else toast((ru.json && ru.json.msg) || '撤销未成功，请稍后再试。', 'err'); paint(); });
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
let chatTok = '', chatTokAt = 0, chatTokGen = 0, chatTokFlight = null;
function ensureChatToken(force) {
  if (!force && chatTok && (Date.now() - chatTokAt) < 11 * 3600 * 1000) return Promise.resolve({ ok: true });
  if (!force && chatTokFlight) return chatTokFlight;
  const gen0 = chatTokGen;
  const flight = (async () => {
    const r = await api('/chat/api/sso', { method: 'POST', json: {} });
    if (r.status === 200 && r.json && r.json.ok && r.json.token) { chatTok = r.json.token; chatTokAt = Date.now(); chatTokGen++; return { ok: true }; }
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
  let t = await ensureChatToken(false);
  if (!t.ok) return { status: 0, ok: false, json: null, text: '', ssoError: t.msg, networkError: !!t.network };
  const call = () => api(path, Object.assign({}, opts, { headers: Object.assign({}, opts.headers || {}, { 'x-qfchat-token': chatTok }) }));
  let r = await call();
  if (r.status === 401 || (r.status === 200 && !r.json)) {
    const firstMsg = (r.json && (r.json.msg || r.json.error)) || '';
    t = await ensureChatToken(true);
    if (!t.ok) return { status: 0, ok: false, json: null, text: '', ssoError: t.msg, networkError: !!t.network };
    r = await call();
    if (firstMsg && !(r.json && (r.json.msg || r.json.error))) r = Object.assign({}, r, { json: Object.assign({}, r.json || {}, { msg: firstMsg }) });
  }
  return r;
}

/* ================= 聊天（会话列表原生；对话区挂载聊天通道，端到端加密不变） ================= */
Views.chat = async function (view) {
  view.innerHTML = `<h1 class="pt">聊天</h1><p class="psub">好友聊天内容全程加密，钥匙由您的登录状态保管，登录了账号的设备可直接查看记录。左侧选联系人，右侧即对话，不再跳页。</p>
    <div class="grid2 chatwrap" style="grid-template-columns:1fr 1.6fr"><div class="card chatlist chatpane-list"><h3>会话</h3><div id="chList"><div class="skel" style="height:52px"></div></div></div>
    <div class="card chatpane-thread"><button class="btn sm grey chatback" id="ch-back" type="button">${ic('chevR')} 返回会话列表</button><h3>对话</h3><div class="framebox"><iframe id="ch-frame" src="/chat" title="聊天"></iframe></div>
    <p style="color:var(--sub);font-size:12.5px;margin-top:8px">对话区为聊天加密通道：密钥由登录状态保管，在本机静默解锁，不再有单独解锁页；修改或重置密码后，以前的聊天记录仍可正常打开。</p></div></div>`;
  const r = await chatApi('/chat/api/friends');
  const box = $('#chList', view);
  if (r.status === 200 && r.json) {
    const arr = (r.json.peers && r.json.peers.length) ? r.json.peers : (r.json.friends || r.json.list || (Array.isArray(r.json) ? r.json : []));
    box.innerHTML = arr.length ? arr.map(f => rowHtml('user', (typeof f === 'string' ? f : (f.name || f.username || '')), '点右侧对话区开始聊天', '')).join('') : '<div class="statebox"><b>暂无会话</b><p>添加好友后即可开始聊天。</p></div>';
  } else {
    const why = r.ssoError || apiErrText(r, '会话列表加载失败，请稍后重试。');
    box.innerHTML = `<div class="statebox"><b>会话列表加载失败</b><p>${esc(why)}</p><p>对话区仍可正常使用。</p><button class="btn sm" id="ch-retry">重新加载</button></div>`;
    const rb = $('#ch-retry', view); if (rb) rb.onclick = () => Views.chat(view);
  }
  /* P2-028 手机单栏分屏：点会话行进对话面、返回钮回列表（切换类仅 ≤820px CSS 生效） */
  const wrap = view.querySelector('.chatwrap');
  if (wrap) {
    box.querySelectorAll('.row').forEach(row => row.addEventListener('click', () => wrap.classList.add('showthread')));
    const back = $('#ch-back', view); if (back) back.onclick = () => wrap.classList.remove('showthread');
  }
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
    box.innerHTML = `<div class="card"><h3>${esc(forumBoard || '帖子')}</h3>${posts.length ? posts.map(p => `<div class="row"><span class="tile">${ic('forum')}</span><span><b>${esc(p.title || '')}</b><small>${esc(p.author || p.nickname || '')} · ${esc(p.createdAt ? fmtDate(p.createdAt) : (p.time || ''))} · ${p.replies != null ? p.replies + ' 条回复' : ''}</small></span>${p.official ? '<span class="tag">公告</span>' : ''}</div>`).join('') : '<div class="statebox"><b>暂无帖子</b><p>来发布第一篇帖子吧。</p></div>'}</div>`;
  };
  paintPosts();
  $('#fo-pub', view).onclick = async () => {
    const msg = $('#fo-msg', view);
    // 发帖前走一次性 SSO 换论坛会话（与现行口径一致）
    const so = await api('/api/forum/sso-token', { method: 'POST', json: {} });
    if (so.json && so.json.loginPath) await api(so.json.loginPath);
    const r = await api('/api/forum/posts', { method: 'POST', json: { board: forumBoard, title: $('#fo-title', view).value.trim(), body: $('#fo-body', view).value.trim() } });
    msg.textContent = (r.json && (r.json.msg || (r.json.ok ? '已提交，审核通过后显示。' : '发布未成功，请稍后再试。'))) || '发布未成功，请稍后再试。';
    if (r.json && r.json.ok) { $('#fo-title', view).value = ''; $('#fo-body', view).value = ''; paintPosts(); }
  };
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
        <div class="field"><label>账单详情截图（JPG / PNG，不超过 8 MB）</label><input type="file" data-shot accept="image/jpeg,image/png"></div>
        <button class="btn block" data-act="submit">提交审核</button>
        <div data-subout style="margin-top:12px"></div>
      </div>`;
    bindDrawerOps(planId);
    startTimer(planId, deadline);
  }

  function bindDrawerOps(planId) {
    const dr = drawerEl(planId); if (!dr) return;
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
          if (sub) { sub.hidden = false; sub.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
          return;
        }
        if (act === 'submit') {
          const subout = dr.querySelector('[data-subout]');
          const onoEl = dr.querySelector('[data-ono]');
          const fileEl = dr.querySelector('[data-shot]');
          const ono = onoEl ? onoEl.value.trim() : '';
          const f = fileEl && fileEl.files ? fileEl.files[0] : null;
          const fail = m => { if (subout) subout.innerHTML = `<div class="note err" style="margin:0">${esc(m)}</div>`; };
          if (!ono) return fail('请填写订单号。');
          if (!f) return fail('请选择账单详情截图。');
          if (f.size > 8 * 1024 * 1024) return fail('截图文件过大，请上传不超过 8 MB 的 JPG 或 PNG 图片。');
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
    renderDrawer(planId); // 加载态
    const plan = PLANS.find(x => x.id === planId);
    const r = await api('/license/api/pay/orders', { method: 'POST', json: { plan: planId, method: 'wechat' } });
    if (expanded !== planId) return; // 用户已切换/收起，订单已在服务端建好，可在我的订单继续
    if (r.json && r.json.ok && r.json.order) byPlan[planId] = { order: r.json.order, pay: r.json.pay || null };
    else if (r.status === 401 || r.status === 403) byPlan[planId] = { error: '登录状态已失效，请重新登录后再购买。' };
    else byPlan[planId] = { error: apiErrText(r, '订单创建未成功，请稍后再试。') };
    renderDrawer(planId);
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
      ${rowHtml('award', '每日签到', checkinDone ? '今日已签到' : '每天签到得 1 分')}
      <div style="margin:-6px 0 10px 55px"><button class="btn sm" id="pt-sign" ${checkinDone ? 'disabled' : ''}>${checkinDone ? '今日已签到' : '签到'}</button></div>
      ${rowHtml('refresh', '使用软件计时', '软件与服务器保持在线满 1 小时得 1 分' + (earn.nextPointInSec != null ? '（距下一分约 ' + Math.ceil(Number(earn.nextPointInSec) / 60) + ' 分钟）' : ''))}
      <div id="pt-out" style="margin-top:10px"></div>
    </div></div>
    <div class="card"><h3>福利中心 · 兑换密钥</h3>
      ${offers.map(o => `${rowHtml('key', offerName(o), offerCost(o) + ' 分兑换 · 兑换后进入下方待兑换列表')}
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
      ${rowHtml('key', '转赠密钥', '付费密钥可转赠一次；对方在查询密钥处复制密钥串后，登录时粘贴领取')}
      <div style="margin:-6px 0 10px 55px"><button class="btn sm ghost" id="pf-gift">发起转赠</button> <button class="btn sm grey" id="pf-gift-cancel">撤销待领取转赠</button></div>
      ${rowHtml('refresh', '申诉换绑设备', '在新设备上提交，审核通过后替换同类旧设备')}
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
    () => showModal('我的申诉与进度', '<div class="framebox"><iframe src="/appeal" title="申诉" style="height:480px"></iframe></div>', [{ label: '关闭' }]),
    () => navigate('forum'),
    async () => { const r = await api('/release.json'); toast(r.json ? ('当前控制台版本信息：' + (r.json.version || r.json.latest || '已是最新')) : '暂时无法获取版本信息。', 'info'); },
    () => doLogout(),
    () => showModal('删除账户', '<p>删除账户为不可恢复操作。如需办理，请通过智能客服转人工提交申请，核验身份后按规则清除数据。</p>', [{ label: '知道了' }, { label: '联系客服', primary: true, onClick: () => navigate('support') }])
  ];
  secRows.forEach((row, i) => { if (acts[i]) row.onclick = acts[i]; });
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
      ${rowHtml('key', '发放密钥', '必须选择来源：付费 / 免费（决定网页版权益），无默认', '__admin', 'lic-user')}
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
    checkSession(true).then(ok => {
      if (!ok) showAuth('login', { notice: '登录状态已失效，请重新登录。' });
      else render();
    });
  } else {
    checkSession(true).then(ok => { if (ok) { location.hash = '#home'; showShell(); } else showAuth('login'); });
  }
})();
