'use strict';
/*
 * QFRemote 好友聊天页（三端同一套网页：网页版 / Windows 壳 / 安卓壳）
 * 内容只在本页内加解密；服务器对消息与记录只见密文。流程：
 *  登录（账号密码 → 服务端经控制通道验密 → 会话令牌）或控制台单点登录
 *  → 凭登录状态静默解锁聊天钥匙（O 线口径，顺序钉死：①登录状态托管
 *    副本 sessionCopy → ②设备包裹副本 → ③壳已存凭据经 qfShellUnlock
 *    递入（外部触发）→ 全失败才显示「聊天暂时无法打开」提示，页面上
 *    不存在任何输密码解锁的入口）。没有钥匙的账号在静默路径里当场
 *    生成身份钥匙+保险库钥匙并同批写入托管副本，从第一天起全静默。
 *  任一次成功解锁后，若账号尚无托管副本，立即在后台补写（静默迁移）。
 *  历史：从保险库取我的记录副本（密文）→ 本地解开 → 显示。换端自动加载。
 *  收发：发送端用会话钥匙加密；收到新消息解开后同时存进自己的保险库。
 *  删除：服务端删正本＋墓碑广播，本页收到墓碑即把对应消息从画面清掉。
 *  撤回：自己发的消息点「撤回」，双方都看不到，并留一条系统痕迹
 *  （您撤回了一条消息／对方撤回了一条消息）；与「删除整个对话」是两回事。
 */
const C = window.QFChatCrypto;
const $ = (id) => document.getElementById(id);
/* S-081（2026-11-15）：提示收敛为 toast——本页 4 处原生 alert 全改于此；
 * 与控制台 qf-ui.js toast 同口径（最多 3 条、4 秒、点按关闭、role=status）。
 * 文本走 textContent，不拼 HTML。confirm（撤回／删对话的二次确认）保留。 */
function toast(msg, type) {
  const box = $('toasts'); if (!box) return;
  while (box.children.length >= 3) box.removeChild(box.firstChild);
  const t = document.createElement('div');
  t.className = 'toast ' + (type || 'info'); t.textContent = msg;
  t.setAttribute('role', 'status');
  t.onclick = () => { t.classList.add('leaving'); setTimeout(() => t.remove(), 120); };
  box.appendChild(t);
  setTimeout(() => { t.classList.add('leaving'); setTimeout(() => t.remove(), 120); }, 4000);
}
const state = {
  token: '', user: '', password: '',
  priv: '', vaultKey: '', pubCache: {}, convKeyCache: {},
  currentWith: '', lastEventSeq: 0, rendered: new Set(),
  history: {}, // msgId -> {id, with, dir, at, text}
  traces: {}, // convKey -> [{msgId, by, at, msgAt}] 撤回痕迹（元数据，本机渲染用）
  pollTimer: null,
  locked: false, // 「记住此设备」恢复出的登录：令牌在、钥匙未解开
  pendingWith: '',
  shellDeviceKey: '', // 壳主进程经注入通道递入的设备密钥（只在内存，不落页面存储）
  deviceMeta: null, // 最近一次 keys/me 返回的设备副本清单（只有标识与时间，没有材料）
  hasSessionCopy: false, // 账号是否已有登录状态托管副本（keys/me 元数据，无材料）
  _view: '', // 当前逻辑视图（show 的入参，供窄宽切换时恢复单栏落点）
  _peers: [], // 最近一次列表数据（搜索过滤本地重渲染用，不再请求服务器）
  _convMeta: {} // with -> {lastAt,lastSeq,myRead}（会话列表时间/未读点的数据来源）
};

function api(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (state.token) headers['x-qfchat-token'] = state.token;
  return fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined }).then(async (r) => {
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.msg || ('HTTP ' + r.status));
    return j;
  });
}
// ---------- 双栏/单栏视图（2.3.0 L2 线，样图 d05/m05 定版） ----------
// 阈值：页面内宽 ≥900px 双栏（左列表 330px 常驻＋右会话区，CSS 同阈值），
// <900px 单栏「列表↔会话」切换（m05 口径）。切换只改显示、不重载页面、
// 不动 state.currentWith / 输入框草稿 / 解锁状态，跨阈值状态不丢。
// 双栏下点列表项只换右区会话（页内视图变化，无整页导航、无历史劫持）；
// 单栏下返回键清 currentWith 回列表。壳侧返回不依赖本页结构。
function isWide() {
  try { return window.matchMedia('(min-width: 900px)').matches; } catch (e) { return window.innerWidth >= 900; }
}
function show(view) {
  ['loginView', 'unavailableView'].forEach(v => $(v).classList.toggle('hidden', v !== view));
  const split = view === 'friendsView' || view === 'chatView';
  $('splitRoot').classList.toggle('hidden', !split);
  state._view = view;
  if (split) syncSplit();
  else { $('chatView').classList.remove('on'); document.body.classList.remove('dual'); document.body.classList.remove('in-chat'); }
  if (view !== 'loginView') $('logoutBtn').classList.remove('hidden');
}
function syncSplit() {
  if ($('splitRoot').classList.contains('hidden')) return;
  const wide = isWide();
  document.body.classList.toggle('dual', wide);
  const has = !!state.currentWith;
  const wantChat = has && state._view === 'chatView';
  document.body.classList.toggle('in-chat', !wide && wantChat);
  if (wide) {
    // 双栏：列表常驻；右区有选中会话显示会话、无选中显示占位（无返回动作）
    $('friendsView').classList.remove('hidden');
    $('chatPane').classList.remove('hidden');
    $('chatView').classList.toggle('on', has);
    $('chatEmpty').classList.toggle('hidden', has);
  } else {
    // 单栏：会话打开时只显示会话（返回键回列表），否则只显示列表
    $('friendsView').classList.toggle('hidden', wantChat);
    $('chatPane').classList.toggle('hidden', !wantChat);
    $('chatView').classList.toggle('on', wantChat);
    $('chatEmpty').classList.add('hidden');
  }
}
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function fmtTime(at) { const d = new Date(at); return d.getMonth() + 1 + '/' + d.getDate() + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); }

// ---------- 设备密钥与设备包裹副本（2.3.0 L 线：设备静默解锁） ----------
// 语义：聊天身份私钥与保险库钥匙除密码包裹外，再用一把「只存在于本机
// 的设备密钥」包一份副本存于服务端（服务端只有密文）。打开聊天时会话
// 有效且本机持有对应设备密钥，即可静默解开，不再出现任何密码框。
// 设备密钥的保管分三路，优先级从高到低：
//   shell —— 壳主进程以系统加密（Windows DPAPI / Electron safeStorage）
//     保护设备密钥文件，经注入通道把密钥递入页面内存（见文末
//     qfShellDeviceUnlock / qfShellDeviceEnroll），页面不落盘保存；
//   web   —— 浏览器直开时用 WebCrypto 生成不可导出密钥，存入本机
//     IndexedDB，密钥原件无法被脚本读出，只能在本机参与加解密；
//   local —— 以上能力都不可用时的兜底：随机设备密钥存本机
//     localStorage（仍只在本设备，但保护级别较低，仅作兼容路径）。
// 每路有独立的设备标识（deviceId），服务端可并存多份副本、可单独撤销。
function deviceIdFor(kind) {
  const key = 'qfchat-device-id-' + kind;
  let id = null;
  try { id = localStorage.getItem(key); } catch (e) {}
  if (!id) {
    const bytes = new Uint8Array(16);
    if (window.crypto && crypto.getRandomValues) crypto.getRandomValues(bytes);
    else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    id = kind + '-' + Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
    try { localStorage.setItem(key, id); } catch (e) {}
  }
  return id;
}
function idbOpen() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) return reject(new Error('indexeddb-unavailable'));
    const rq = indexedDB.open('qfremote-chat', 1);
    rq.onupgradeneeded = () => { try { rq.result.createObjectStore('kv'); } catch (e) {} };
    rq.onsuccess = () => resolve(rq.result);
    rq.onerror = () => reject(rq.error);
  });
}
async function idbGet(key) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const rq = db.transaction('kv', 'readonly').objectStore('kv').get(key);
    rq.onsuccess = () => resolve(rq.result);
    rq.onerror = () => reject(rq.error);
  });
}
async function idbSet(key, val) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const rq = db.transaction('kv', 'readwrite').objectStore('kv').put(val, key);
    rq.onsuccess = () => resolve();
    rq.onerror = () => reject(rq.error);
  });
}
let _webKeyPromise = null;
function webDeviceKey(create) {
  if (!(window.crypto && crypto.subtle && window.indexedDB)) return Promise.resolve(null);
  if (!_webKeyPromise) {
    _webKeyPromise = (async () => {
      let k = null;
      try { k = await idbGet('deviceKey'); } catch (e) {}
      if (!k && create) {
        k = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
        try { await idbSet('deviceKey', k); } catch (e) { return null; }
      }
      return k || null;
    })().catch(() => null);
  }
  return _webKeyPromise;
}
async function webWrap(secretB64, key) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, C.decBytes(secretB64));
  return { kind: 'webcrypto-aesgcm-v1', iv: C.encBytes(new Uint8Array(iv)), cipher: C.encBytes(new Uint8Array(ct)) };
}
async function webUnwrap(blob, key) {
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: C.decBytes(blob.iv) }, key, C.decBytes(blob.cipher));
    return C.encBytes(new Uint8Array(pt));
  } catch (e) { return null; }
}
function localDeviceKey(create) {
  let k = null;
  try { k = localStorage.getItem('qfchat-device-key-v1'); } catch (e) {}
  if (!k && create) {
    k = C.newDeviceKey();
    try { localStorage.setItem('qfchat-device-key-v1', k); } catch (e) {}
  }
  return k;
}
// 为一份秘密原件构建指定路径的设备副本（失败返回 null，绝不阻断主流程）
async function buildDeviceCopyFor(kind, privB64, vaultB64) {
  try {
    if (kind === 'shell') {
      if (!state.shellDeviceKey) return null;
      return { deviceId: deviceIdFor('shell'), platform: 'shell', wrappedPriv: C.wrapWithKey(privB64, state.shellDeviceKey), wrappedVault: C.wrapWithKey(vaultB64, state.shellDeviceKey) };
    }
    if (kind === 'web') {
      const key = await webDeviceKey(true);
      if (!key) return null;
      const wp = await webWrap(privB64, key);
      const wv = await webWrap(vaultB64, key);
      return { deviceId: deviceIdFor('web'), platform: 'web', wrappedPriv: wp, wrappedVault: wv };
    }
    if (kind === 'local') {
      const k = localDeviceKey(true);
      if (!k) return null;
      return { deviceId: deviceIdFor('local'), platform: 'web', wrappedPriv: C.wrapWithKey(privB64, k), wrappedVault: C.wrapWithKey(vaultB64, k) };
    }
  } catch (e) { /* 设备副本是静默增强，失败不影响密码路径 */ }
  return null;
}
// 首次建钥匙时同批携带的那一份（壳路径优先，其次 WebCrypto，再兜底）
async function buildFirstDeviceCopy(privB64, vaultB64) {
  if (state.shellDeviceKey) { const c = await buildDeviceCopyFor('shell', privB64, vaultB64); if (c) return c; }
  const w = await buildDeviceCopyFor('web', privB64, vaultB64);
  if (w) return w;
  return buildDeviceCopyFor('local', privB64, vaultB64);
}
// 已解锁后在后台补写/更新本设备的副本（静默迁移：用户无感、失败不打扰）
async function enrollDeviceCopy() {
  if (!state.priv || !state.vaultKey || !state.token) return false;
  let any = false;
  const put = async (kind) => {
    const copy = await buildDeviceCopyFor(kind, state.priv, state.vaultKey);
    if (!copy) return false;
    try { await api('POST', '/chat/api/keys/device', copy); return true; } catch (e) { return false; }
  };
  if (state.shellDeviceKey) any = (await put('shell')) || any;
  const webOk = await put('web');
  any = webOk || any;
  if (!webOk) any = (await put('local')) || any;
  return any;
}
async function fetchDeviceCopy(deviceId) {
  try { return await api('GET', '/chat/api/keys/device/' + encodeURIComponent(deviceId)); } catch (e) { return null; }
}
// 用本机设备密钥尝试静默解开（任一路径成功即算）：不接触密码、不弹任何框
async function tryDeviceUnlock() {
  if (state.priv && state.vaultKey) return true;
  if (!state.token) return false;
  const adopt = (p, v) => { if (p === null || v === null || !p || !v) return false; state.priv = p; state.vaultKey = v; state.locked = false; return true; };
  try {
    if (state.shellDeviceKey) {
      const c = await fetchDeviceCopy(deviceIdFor('shell'));
      if (c && adopt(C.unwrapWithKey(c.wrappedPriv, state.shellDeviceKey), C.unwrapWithKey(c.wrappedVault, state.shellDeviceKey))) return true;
    }
  } catch (e) {}
  try {
    const key = await webDeviceKey(false);
    if (key) {
      const c = await fetchDeviceCopy(deviceIdFor('web'));
      if (c) { const p = await webUnwrap(c.wrappedPriv, key); const v = await webUnwrap(c.wrappedVault, key); if (adopt(p, v)) return true; }
    }
  } catch (e) {}
  try {
    const k = localDeviceKey(false);
    if (k) {
      const c = await fetchDeviceCopy(deviceIdFor('local'));
      if (c && adopt(C.unwrapWithKey(c.wrappedPriv, k), C.unwrapWithKey(c.wrappedVault, k))) return true;
    }
  } catch (e) {}
  return false;
}
// ---------- 登录状态托管副本（sessionCopy，O 线：静默解锁第一顺位） ----------
// 服务端为每个账号保管一份由服务端主密钥包裹的钥匙副本；凭本人有效
// 会话即可取回钥匙原件（仅在页面内存中持有），打开聊天零弹窗。
// 静默迁移：任一次成功解锁后，若账号尚无托管副本，立即经已认证通道
// 上交钥匙原件由服务端包裹落存，用户无感。
async function fetchSessionCopy() {
  if (!state.token) return false;
  try {
    const r = await api('GET', '/chat/api/keys/session-copy');
    if (r && r.priv && r.vault) {
      state.priv = r.priv; state.vaultKey = r.vault; state.locked = false; state.hasSessionCopy = true;
      return true;
    }
  } catch (e) { /* 无副本（404）或网络问题：走下一顺位 */ }
  return false;
}
async function uploadSessionCopy() {
  if (!state.priv || !state.vaultKey || !state.token) return false;
  try {
    await api('POST', '/chat/api/keys/session-copy', { priv: state.priv, vault: state.vaultKey });
    state.hasSessionCopy = true;
    return true;
  } catch (e) { return false; }
}
// 没有钥匙的账号：静默建钥匙（无需任何密码参与）——本地生成身份钥匙与
// 保险库钥匙，同批写入托管副本与一份设备副本；密码可得时另带密码包裹。
async function createKeysSilently(password) {
  const id = C.newIdentity();
  const vaultKey = C.newVaultKey();
  const device = await buildFirstDeviceCopy(id.privB64, vaultKey);
  const body = {
    pub: id.pubB64,
    sessionCopy: { priv: id.privB64, vault: vaultKey }
  };
  if (password) {
    body.wrappedPriv = C.wrapWithPassword(id.privB64, password);
    body.wrappedVault = C.wrapWithPassword(vaultKey, password);
  }
  if (device) body.device = device;
  await api('POST', '/chat/api/keys/setup', body);
  state.priv = id.privB64; state.vaultKey = vaultKey; state.hasSessionCopy = true; state.locked = false;
  return true;
}
// 静默解开后的统一收尾：刷新钥匙元数据、无托管副本时后台补写迁移、
// 载入历史、刷新列表、开始轮询、回到待开会话。
async function finishSilentUnlock() {
  state.locked = false;
  try {
    const r = await api('GET', '/chat/api/keys/me');
    state.deviceMeta = r.keys ? (r.keys.devices || []) : [];
    if (r.keys) state.hasSessionCopy = !!r.keys.hasSessionCopy;
  } catch (e) {}
  if (!state.hasSessionCopy) uploadSessionCopy().catch(() => {}); // 静默迁移：成功解锁后补写托管副本
  await loadHistory();
  await renderFriends();
  startPolling();
  const w = state.pendingWith; state.pendingWith = '';
  if (w) openConversation(w);
  // 解锁标志在取回钥匙的一刻即翻转，用户可能在本次收尾完成前已点开
  // 某个会话：尊重其已打开的会话并按已载入的历史重渲染，不把人弹回列表。
  else if (state.currentWith) { show('chatView'); renderMessages(); markRead(); }
  else show('friendsView');
}
// 静默解锁主序（钉死）：①托管副本 → ②设备副本 → ③无钥匙账号静默建
// 钥匙。壳已存凭据（第③类迁移源）由壳侧经 qfShellUnlock 外部触发，
// 不在本序内。全部失败返回 false，调用方显示不可用提示（无密码元素）。
async function attemptSilentUnlock() {
  if (state.priv && state.vaultKey) return true;
  if (await fetchSessionCopy()) { await finishSilentUnlock(); return true; }
  if (await tryDeviceUnlock()) { await finishSilentUnlock(); return true; }
  try {
    const r = await api('GET', '/chat/api/keys/me');
    state.deviceMeta = r.keys ? (r.keys.devices || []) : [];
    if (r.keys) state.hasSessionCopy = !!r.keys.hasSessionCopy;
    if (!r.keys) { await createKeysSilently(state.password || ''); await finishSilentUnlock(); return true; }
  } catch (e) { /* 建钥匙失败不冒充成功，落到不可用提示 */ }
  return false;
}

// ---------- 登录与钥匙 ----------
async function doLogin() {
  const username = $('lgUser').value.trim().toLowerCase();
  const password = $('lgPass').value;
  $('lgErr').textContent = '';
  if (!username || !password) { $('lgErr').textContent = '请填写账号和密码。'; return; }
  $('lgBtn').disabled = true;
  try {
    const remember = $('lgRemember').checked;
    const r = await api('POST', '/chat/api/login', { username, password, remember });
    state.token = r.token; state.user = r.user; state.password = password;
    // 「记住此设备」：把会话令牌存进本机浏览器（30 天）；钥匙仍只由密码解开，不存本机。
    if (remember) localStorage.setItem('qfchat-remember', JSON.stringify({ token: r.token, user: r.user }));
    else localStorage.removeItem('qfchat-remember');
    await unlockKeys(password);
    await enterFriends();
  } catch (e) { $('lgErr').textContent = e.message; }
  $('lgBtn').disabled = false;
}

async function unlockKeys(password) {
  const r = await api('GET', '/chat/api/keys/me');
  state.deviceMeta = r.keys ? (r.keys.devices || []) : [];
  if (r.keys) state.hasSessionCopy = !!r.keys.hasSessionCopy;
  if (!r.keys) {
    // 第一次用聊天：本地生成，密码包装后上存，同时同批登记设备包裹
    // 副本与登录状态托管副本，从第一天起全静默。
    await createKeysSilently(password);
    return;
  }
  const hasWraps = !!(r.keys.wrappedPriv && r.keys.wrappedVault);
  const priv = hasWraps ? C.unwrapWithPassword(r.keys.wrappedPriv, password) : null;
  const vaultKey = hasWraps ? C.unwrapWithPassword(r.keys.wrappedVault, password) : null;
  if (priv === null || vaultKey === null) {
    // 密码对不上钥匙包裹（密码已被修改/重置，或账号只有托管副本）时，
    // 不再要求用户输任何密码：按静默主序取回——①托管副本 → ②设备
    // 副本。任一成功即顺手用当前密码重新包装（密码路径一并恢复），
    // 并补齐托管副本；全部失败才落到不可用提示（登录本身已成功，会话
    // 令牌有效，只是聊天钥匙暂不可得）。
    if (await fetchSessionCopy() || await tryDeviceUnlock()) {
      try {
        await api('POST', '/chat/api/keys/rewrap', {
          wrappedPriv: C.wrapWithPassword(state.priv, password),
          wrappedVault: C.wrapWithPassword(state.vaultKey, password)
        });
      } catch (e) { /* 重新包装失败不影响本次已解开的状态 */ }
      if (!state.hasSessionCopy) uploadSessionCopy().catch(() => {});
      enrollDeviceCopy().catch(() => {});
      return;
    }
    state.locked = true;
    show('unavailableView');
    throw new Error('__unavailable__');
  }
  state.priv = priv; state.vaultKey = vaultKey;
  enrollDeviceCopy().catch(() => {}); // 密码可得时刻的静默迁移：后台补写设备副本
  if (!state.hasSessionCopy) uploadSessionCopy().catch(() => {}); // 同一时刻补写托管副本
}

// ---------- 好友与会话 ----------
async function enterFriends() {
  show('friendsView');
  await loadHistory();
  await renderFriends();
  await loadSupportFaq();
  startPolling();
}

// 「记住此设备」恢复：本机存有令牌时先验令牌，进好友列表，随后凭登录
// 状态静默解锁（托管副本→设备副本）；全失败时点会话显示不可用提示。
async function tryRestore() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem('qfchat-remember') || 'null'); } catch (e) {}
  if (!saved || !saved.token || !saved.user) return;
  state.token = saved.token; state.user = saved.user;
  try {
    await api('GET', '/chat/api/friends');
  } catch (e) {
    localStorage.removeItem('qfchat-remember');
    state.token = ''; state.user = '';
    show('loginView');
    return;
  }
  state.locked = true;
  show('friendsView');
  await renderFriends();
  await loadSupportFaq();
  attemptSilentUnlock().catch(() => {}); // 本设备有设备副本则静默解开，用户无感
}

// 控制台单点登录：浏览器已登录控制台时，服务端凭其会话 cookie 换发聊天令牌。
// 成功后凭登录状态静默解锁（托管副本→设备副本→无钥匙静默建钥匙），
// 不出现任何密码框；全部失败时保留锁定态，点开会话时显示不可用提示。
// 失败（没登录控制台）就安静退回账号密码登录页（无登录态的裸访问口径）。
async function trySso() {
  let r;
  try { r = await api('POST', '/chat/api/sso', {}); } catch (e) { return; }
  if (!r || !r.ok || !r.token || !r.user) return;
  state.token = r.token; state.user = r.user;
  state.locked = true;
  show('friendsView');
  await renderFriends();
  await loadSupportFaq();
  attemptSilentUnlock().catch(() => {});
}

async function loadSupportFaq() {
  // 静态 FAQ 展示已下线（2.3.0 智能客服集成）：5 条内容已并入智能客服知识库，
  // 聊天列表改放智能客服入口卡片（chat.html 的 supportEntryCard）。本函数保留
  // 仅为兼容既有调用点，不再请求、不再渲染任何静态问答。
}
// 品牌占位头像（2.3.2 统一档案，DESIGN §三 A9／§四 C3 定版）：深蓝圆盘
// #4B4B55＋白色断环＋橙点 #FF8A1E，几何照 assets/avatar-placeholder.svg
// 2026-11-15 P0-2 遗留：占位圆盘由深蓝改为中性灰，与 --deep 新值一致；
// 控制台共用文件 server/webapp/assets/avatar-placeholder.svg 仍是旧蓝，本轮不动（另议）。
//（与安卓 QfAvatarPlaceholder 同参）。无真头像、或真头像加载失败时一律
// 用它，不再用哈希色＋账号名首字。身份键仍是账号名，displayName 只作显示。
const AV_PLACEHOLDER_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="50" fill="#4B4B55"/><path d="M 68.65 73.50 A 30 30 0 1 1 78.81 41.62" fill="none" stroke="#FFFFFF" stroke-width="7.5" stroke-linecap="round"/><circle cx="73.4" cy="26.6" r="8.5" fill="#FF8A1E"/></svg>';
const AV_PLACEHOLDER_URI = 'data:image/svg+xml;utf8,' + encodeURIComponent(AV_PLACEHOLDER_SVG);
function qfAvatarImgError(img) { img.onerror = null; img.src = AV_PLACEHOLDER_URI; }
function peerViewOf(name) { return (state._peers || []).find(x => x.name === name) || null; }
// 头像 <img>：有真头像走同源代理 /chat/api/avatar/<账号名>?v=<avatarUpdatedAt>
//（同源、会话 cookie 可达，字节由服务端经 ext 内网端点回源）；无则品牌占位。
function avatarImgHtml(name, view) {
  const v = view || peerViewOf(name);
  if (v && v.hasAvatar && v.avatarUpdatedAt) {
    return '<img src="/chat/api/avatar/' + encodeURIComponent(name) + '?v=' + encodeURIComponent(v.avatarUpdatedAt) + '" alt="" onerror="qfAvatarImgError(this)">';
  }
  return '<img src="' + AV_PLACEHOLDER_URI + '" alt="">';
}
async function renderFriends() {
  const r = await api('GET', '/chat/api/friends');
  const peers = r.peers || r.friends.map(n => ({ name: n, type: 'user' }));
  // 会话补集：客服号与普通用户的关系是虚拟常驻关系、不落 pairs；客服端登录后
  // 要能从这里点开曾给它发过消息的用户。普通用户删好友后保留的历史会话同理。
  // convMeta 同时带每会话的 lastSeq/myRead（服务端既有字段），供未读点判定。
  const convMeta = {};
  try {
    const c = await api('GET', '/chat/api/conversations');
    (c.conversations || []).forEach(conv => {
      convMeta[conv.with] = { lastAt: conv.lastAt || 0, lastSeq: conv.lastSeq || 0, myRead: conv.myRead || 0 };
      const exPeer = peers.find(p => p.name === conv.with);
      if (exPeer) { // 会话侧档案显示字段补缺（好友侧已有值时以好友侧为准）
        if (exPeer.displayName === undefined && conv.displayName !== undefined) exPeer.displayName = conv.displayName;
        if (exPeer.hasAvatar === undefined && conv.hasAvatar !== undefined) exPeer.hasAvatar = conv.hasAvatar;
        if (exPeer.avatarUpdatedAt === undefined && conv.avatarUpdatedAt !== undefined) exPeer.avatarUpdatedAt = conv.avatarUpdatedAt;
      } else {
        peers.push({ name: conv.with, type: conv.type || 'user', displayName: conv.displayName, hasAvatar: conv.hasAvatar, avatarUpdatedAt: conv.avatarUpdatedAt });
      }
    });
  } catch (e) { /* 会话补集失败不影响好友清单 */ }
  peers.sort((a, b) => ((a.type === 'system' ? 0 : 1) - (b.type === 'system' ? 0 : 1)) || a.name.localeCompare(b.name));
  state._peers = peers;
  state._convMeta = convMeta;
  renderFriendRows();
}
// 列表行渲染（d05 双栏行式：头像＋名称/官方标＋末条预览＋时间/未读点）。
// 预览只能取本机已解密的历史（服务器只有密文、给不出预览）：未解锁或无
// 历史时不显示预览行，客服行回落 d05 的副标题文案。搜索过滤只重渲染行、
// 不发请求，输入框焦点与会话草稿都不受影响。
function lastPreview(name) {
  let best = null;
  Object.values(state.history || {}).forEach(m => { if (m.with === name && (!best || m.at > best.at)) best = m; });
  return best ? String(best.text || '').replace(/\s+/g, ' ') : '';
}
function renderFriendRows() {
  const peers = state._peers || [];
  const meta = state._convMeta || {};
  const q = (($('convSearch') && $('convSearch').value) || '').trim().toLowerCase();
  const list = $('friendList');
  if (!list) return;
  list.innerHTML = '';
  $('noFriends').style.display = peers.some(p => p.type === 'user') ? 'none' : 'block';
  let shown = 0;
  peers.forEach(p => {
    const isSys = p.type === 'system';
    const label = isSys ? '官方客服' : (p.displayName || p.name);
    if (q && !(p.name.toLowerCase().includes(q) || label.toLowerCase().includes(q) || String(p.displayName || '').toLowerCase().includes(q))) return;
    shown++;
    const m = meta[p.name] || {};
    const unread = !!(m.lastSeq && m.lastSeq > (m.myRead || 0) && state.currentWith !== p.name);
    const preview = lastPreview(p.name);
    const av = isSys
      ? '<div class="avatar sys">客</div>'
      : '<div class="avatar">' + avatarImgHtml(p.name, p) + '</div>';
    const tag = isSys ? '<span class="tag org">官方</span>' : '';
    const ss = preview
      ? '<div class="ss">' + esc(preview) + '</div>'
      : (isSys ? '<div class="ss">已迁移至智能客服，本会话只读查看</div>' : '');
    const side = (m.lastAt ? '<span class="tm">' + esc(fmtTime(m.lastAt)) + '</span>' : (isSys ? '' : '<span class="tm">聊天 ›</span>'))
      + (unread ? '<span class="udot"></span>' : '');
    const div = document.createElement('div');
    div.className = 'friend' + (state.currentWith === p.name ? ' act' : '');
    div.setAttribute('data-with', p.name);
    div.innerHTML = av + '<div class="fmain"><div class="frow1"><span class="nm">' + esc(label) + '</span>' + tag + '</div>' + ss + '</div><div class="fside">' + side + '</div>';
    div.onclick = () => openConversation(p.name);
    list.appendChild(div);
  });
  const nm = $('noMatch');
  if (nm) nm.classList.toggle('hidden', !(q && shown === 0 && peers.length > 0));
}
async function peerPub(user) {
  if (state.pubCache[user]) return state.pubCache[user];
  const r = await api('GET', '/chat/api/keys/' + encodeURIComponent(user));
  state.pubCache[user] = r.pub;
  return r.pub;
}
async function convKey(withUser) {
  if (state.convKeyCache[withUser]) return state.convKeyCache[withUser];
  const pub = await peerPub(withUser);
  const k = C.conversationKey(state.priv, pub);
  state.convKeyCache[withUser] = k;
  return k;
}

// ---------- 历史（保险库） ----------
async function loadHistory() {
  /* S-051：保险库分页拉取（每页 100 条，cursor 循环直至 hasMore=false）；
   * 不传 limit 的全量拉取在记录多时会超限，traces 取首页即可。 */
  const entries = [];
  let traces = null;
  let cursor = '';
  let guard = 0;
  while (guard++ < 50) {
    const r = await api('GET', '/chat/api/vault?limit=100' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''));
    (r.entries || []).forEach(e => entries.push(e));
    if (traces === null) traces = r.traces || {};
    if (!r.hasMore || !r.nextCursor) break;
    cursor = r.nextCursor;
  }
  state.history = {};
  state.traces = traces || {};
  entries.forEach(e => {
    const text = C.openVault(state.vaultKey, e.nonce, e.cipher);
    if (text !== null) state.history[e.msgId] = { id: e.msgId, with: e.with, dir: e.dir, at: e.at, text };
  });
}
async function vaultAppend(msgId, withUser, dir, at, text) {
  const sealed = C.sealVault(state.vaultKey, text);
  try { await api('POST', '/chat/api/vault', { msgId, with: withUser, dir, at, nonce: sealed.nonce, cipher: sealed.cipher }); } catch (e) { /* 下次打开会从传送通道补 */ }
  state.history[msgId] = { id: msgId, with: withUser, dir, at, text };
}

// ---------- 会话界面 ----------
function openConversation(withUser) {
  if (state.locked) {
    // 先按静默主序尝试（托管副本→设备副本，含壳侧递入设备密钥的短暂
    // 窗口）：成功直接进入会话；全部失败显示不可用提示——页面上没有
    // 任何输密码解锁的入口。
    state.pendingWith = withUser;
    attemptSilentUnlock().then(ok => {
      if (!ok && state.locked && state.pendingWith === withUser) show('unavailableView');
    }).catch(() => { if (state.locked) show('unavailableView'); });
    return;
  }
  state.currentWith = withUser;
  $('chatWith').textContent = withUser === 'qf-support' ? '官方客服' : ((peerViewOf(withUser) || {}).displayName || withUser);
  // 会话头头像与副标题（d05 头部式样；窄宽下由 CSS 隐藏，不改 m05 口径）
  const cav = $('chatAvatar');
  if (cav) {
    if (withUser === 'qf-support') { cav.className = 'avatar sys chat-av'; cav.textContent = '客'; cav.style.background = ''; }
    else { cav.className = 'avatar chat-av'; cav.textContent = ''; cav.style.background = ''; cav.innerHTML = avatarImgHtml(withUser); }
  }
  const csub = $('chatSub');
  if (csub) csub.textContent = withUser === 'qf-support' ? '已迁移至智能客服，本会话只读查看' : '';
  // 常驻列表的当前会话高亮（页内 class 切换，非导航；单栏下列表隐藏时无副作用）
  document.querySelectorAll('#friendList .friend').forEach(el => el.classList.toggle('act', el.getAttribute('data-with') === withUser));
  $('supportBanner').classList.toggle('hidden', withUser !== 'qf-support');
  // 原官方客服加密会话只读保留：历史可看，输入与发送禁用（服务端同步拒发）。
  const isSupportConv = withUser === 'qf-support';
  $('msgInput').disabled = isSupportConv;
  $('sendBtn').disabled = isSupportConv;
  $('msgInput').placeholder = isSupportConv ? '本会话保留只读，请从好友页顶部进入智能客服' : '输入消息…';
  $('readState').textContent = '';
  show('chatView');
  renderMessages();
  markRead();
}
// ---------- 撤回痕迹 ----------
function convKeyOf(withUser) { return JSON.stringify([state.user, withUser].sort()); }
function tracesFor(withUser) { return state.traces[convKeyOf(withUser)] || []; }
function addTrace(conv, t) {
  const list = state.traces[conv] = state.traces[conv] || [];
  if (!list.some(x => x.msgId === t.msgId)) list.push(t);
}
function appendTraceDom(t) {
  const key = 'trace:' + t.msgId;
  if (state.rendered.has(key)) return;
  state.rendered.add(key);
  const div = document.createElement('div');
  div.className = 'sysmsg';
  div.id = 'trace-' + t.msgId;
  div.textContent = t.by === state.user ? '您撤回了一条消息' : '对方撤回了一条消息';
  $('msgs').appendChild(div);
}

function renderMessages() {
  const box = $('msgs');
  /* S-050：重绘前记是否贴底，仅贴底时重绘后滚底（打开会话时框为空即贴底，照常见底）。 */
  const atBottom = isAtBottom(box);
  box.innerHTML = '';
  state.rendered = new Set();
  const msgs = Object.values(state.history).filter(m => m.with === state.currentWith)
    .map(m => ({ at: m.at, msg: m }));
  const trs = tracesFor(state.currentWith).map(t => ({ at: t.msgAt != null ? t.msgAt : t.at, trace: t }));
  msgs.concat(trs).sort((a, b) => a.at - b.at).forEach(item => {
    if (item.msg) appendMessageDom(item.msg); else appendTraceDom(item.trace);
  });
  if (atBottom) box.scrollTop = box.scrollHeight;
}
/* S-050：贴底判定（24px 容差，抵渲染取整与字体差异）。 */
function isAtBottom(box) {
  if (!box) return true;
  return box.scrollHeight - box.scrollTop - box.clientHeight <= 24;
}
function appendMessageDom(m) {
  if (state.rendered.has(m.id)) return;
  state.rendered.add(m.id);
  const box = $('msgs');
  const div = document.createElement('div');
  div.className = 'msg ' + (m.dir === 'out' ? 'me' : 'peer');
  div.id = 'msg-' + m.id;
  // 只有自己发的消息带操作，叫「撤回」；对方的消息不给删除入口（与「删除整个对话」严格区分）
  const act = m.dir === 'out' ? '<span class="del" data-recall="' + m.id + '">撤回</span>' : '';
  div.innerHTML = '<div>' + esc(m.text) + '</div><div class="meta"><span>' + fmtTime(m.at) + '</span>' + act + '</div>';
  const actEl = div.querySelector('[data-recall]');
  if (actEl) actEl.onclick = () => recallMessage(m.id);
  /* S-050：追加前记是否贴底，仅贴底时滚底；上翻看历史不抢滚动。 */
  const atBottom = isAtBottom(box);
  box.appendChild(div);
  if (atBottom) box.scrollTop = box.scrollHeight;
}
/* S-054：客户端消息 ID（cm-＋32 位小写 hex，每次发送生成一个，永不复用；
 * 本页不加载 qf-runtime.js，与 qf-schema.js 的 qfNewClientMessageId 同格式；
 * 服务端存索引＋按 id 查询由 C-4 的 S-086 落地，契约字段名 clientMessageId）。 */
function newClientMessageId() {
  let hex = '';
  try {
    const b = new Uint8Array(16);
    if (window.crypto && crypto.getRandomValues) { crypto.getRandomValues(b); hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(''); }
  } catch (e) {}
  if (!hex) { for (let i = 0; i < 32; i++) hex += Math.floor(Math.random() * 16).toString(16); }
  return 'cm-' + hex;
}
async function sendMessage() {
  if (state.currentWith === 'qf-support') return; // 只读会话：不发送（服务端亦拒发）
  const input = $('msgInput');
  const text = input.value.trim();
  if (!text || !state.currentWith) return;
  input.value = '';
  try {
    const key = await convKey(state.currentWith);
    const sealed = C.sealMessage(key, text);
    const clientMessageId = newClientMessageId(); // S-054：随消息提交
    const r = await api('POST', '/chat/api/send', { to: state.currentWith, nonce: sealed.nonce, cipher: sealed.cipher, clientMessageId });
    const m = { id: r.id, with: state.currentWith, dir: 'out', at: r.at, text, clientMessageId };
    await vaultAppend(r.id, state.currentWith, 'out', r.at, text);
    state.lastEventSeq = Math.max(state.lastEventSeq, r.seq);
    if (state.currentWith) appendMessageDom(m);
    markRead();
    renderFriends().catch(() => {}); // 双栏列表常驻：同步刷新该会话的预览与时间
  } catch (e) { toast(e.message, 'error'); }
}
async function recallMessage(msgId) {
  if (!confirm('撤回后，您和对方都将看不到这条消息，只会留下一条撤回提示。\n软件之外的副本（如截图）无法撤回。确定撤回吗？')) return;
  try {
    const r = await api('POST', '/chat/api/recall', { msgId });
    const m = state.history[msgId];
    removeMessageEverywhere(msgId);
    if (m) addTrace(convKeyOf(m.with), { msgId, by: state.user, at: r.at, msgAt: r.msgAt });
    if (state.currentWith && (!m || m.with === state.currentWith)) renderMessages();
    renderFriends().catch(() => {}); // 撤回的若是末条，列表预览同步回落
  } catch (e) { toast(e.message, 'error'); }
}
async function deleteConversation() {
  if (!state.currentWith) return;
  if (!confirm('确定删除与 ' + state.currentWith + ' 的整个对话吗？删除后双方都将看不到。\n软件之外的副本（如截图）无法删除。')) return;
  try {
    const r = await api('POST', '/chat/api/delete-conversation', { with: state.currentWith });
    Object.values(state.history).filter(m => m.with === state.currentWith).forEach(m => delete state.history[m.id]);
    delete state.traces[convKeyOf(state.currentWith)];
    renderMessages();
    renderFriends().catch(() => {}); // 整删后列表预览/时间同步清空
    toast('已删除，共清除 ' + r.count + ' 条。');
  } catch (e) { toast(e.message, 'error'); }
}
function removeMessageEverywhere(msgId) {
  delete state.history[msgId];
  const el = $('msg-' + msgId);
  if (el) el.remove();
  state.rendered.delete(msgId);
}
async function markRead() {
  if (!state.currentWith) return;
  try { await api('POST', '/chat/api/read', { with: state.currentWith, seq: state.lastEventSeq }); } catch (e) {}
}

// ---------- 同步轮询（新消息＋墓碑＋已读） ----------
function startPolling() {
  if (state.pollTimer) return;
  state.pollTimer = setInterval(pollOnce, 3000);
  pollOnce();
}
/* S-048/S-053：gap 补齐——按 seq 从 /chat/api/catchup 拉回错过的消息密文，
 * 解密后写入保险库与历史（已删 id 直接清历史），最多 10 页，单条失败不卡整批。 */
async function catchUp() {
  let since = state.lastEventSeq;
  let guard = 0;
  while (guard++ < 10) {
    let r;
    try { r = await api('GET', '/chat/api/catchup?since=' + since + '&limit=100'); } catch (e) { return; }
    if (!r || !r.ok) return;
    (r.deletedIds || []).forEach(id => removeMessageEverywhere(id));
    for (const m of (r.messages || [])) {
      if (!m || !m.id || state.history[m.id]) continue;
      const other = m.from === state.user ? m.to : m.from;
      try {
        const key = await convKey(other);
        const text = C.openMessage(key, m.nonce, m.cipher);
        if (text === null) continue;
        const dir = m.from === state.user ? 'out' : 'in';
        await vaultAppend(m.id, other, dir, m.at, text);
        if (state.currentWith === other) appendMessageDom(state.history[m.id]);
      } catch (e) { /* 单条失败不卡整批补齐 */ }
    }
    if (typeof r.nextSince === 'number') since = Math.max(since, r.nextSince);
    if (!r.hasMore) break;
  }
}
async function pollOnce() {
  if (!state.token) return;
  let r;
  try { r = await api('GET', '/chat/api/poll?since=' + state.lastEventSeq); } catch (e) { return; }
  let sawNewMessage = false;
  /* S-048/S-053：gap=true 说明本轮事件不完整（长离线期间 inbox 已剪枝）——
     先走 catchup 按 seq 补回错过的消息密文，再把游标推到 maxSeq，不得静默跳号。 */
  if (r.gap && typeof r.maxSeq === 'number') {
    try { await catchUp(); } catch (e) { /* 下轮再试 */ }
    if (r.maxSeq > state.lastEventSeq) state.lastEventSeq = r.maxSeq;
    sawNewMessage = true;
  }
  /* S-048/S-053：hasMore 时翻页取完本轮事件，再统一处理。 */
  const events = (r.events || []).slice();
  let pageGuard = 0;
  while (r.hasMore && pageGuard++ < 10) {
    try { r = await api('GET', '/chat/api/poll?since=' + (typeof r.nextSince === 'number' ? r.nextSince : state.lastEventSeq)); } catch (e) { break; }
    events.push(...(r.events || []));
  }
  for (const ev of events) {
    state.lastEventSeq = Math.max(state.lastEventSeq, ev.seq);
    if (ev.type === 'msg') {
      const m = ev.msg;
      const other = m.from === state.user ? m.to : m.from;
      if (state.history[m.id]) continue;
      try {
        const key = await convKey(other);
        const text = C.openMessage(key, m.nonce, m.cipher);
        if (text === null) continue;
        const dir = m.from === state.user ? 'out' : 'in';
        await vaultAppend(m.id, other, dir, m.at, text);
        sawNewMessage = true;
        if (state.currentWith === other) { appendMessageDom(state.history[m.id]); markRead(); }
      } catch (e) { /* 对方钥匙还没就绪等下轮 */ }
    } else if (ev.type === 'tomb') {
      ev.msgIds.forEach(id => removeMessageEverywhere(id));
    } else if (ev.type === 'recall') {
      ev.msgIds.forEach(id => removeMessageEverywhere(id));
      if (ev.trace) addTrace(ev.conv, ev.trace);
      const peer = ev.parties && ev.parties.find(x => x !== state.user);
      if (state.currentWith && state.currentWith === peer) renderMessages();
    }
  }
  // 双栏下列表常驻，新消息须刷新其他会话的预览/未读点；单栏下列表隐藏时
  // 预更新其 DOM 也无副作用（草稿在会话区输入框、不在列表内，不受影响）。
  if (sawNewMessage) renderFriends().catch(() => {});
  // 已读状态（对方读到哪）
  if (state.currentWith) {
    const cv = JSON.stringify([state.user, state.currentWith].sort());
    const marks = (r.read || {})[cv] || {};
    $('readState').textContent = (marks[state.currentWith] || 0) >= state.lastEventSeq && state.lastEventSeq > 0 ? '对方已读' : '';
  }
}

// ---------- 软件壳静默解锁（2.3.0 H 线；O 线列为静默主序第③类迁移源） ----------
// 软件里勾过「记住账号密码」时，壳主进程把保险箱里的登录密码经页面脚本
// 通道递进来调这个函数，用它静静解开聊天加密。页面上已不存在任何解锁
// 框，本函数只是已存凭据的递入通道：凭据解开后按静默迁移口径补写托
// 管副本与设备副本，此后不再需要凭据本身。密码只在内存里过一遍；密码
// 对不上包裹时改走托管副本取回，再不行返回 false，壳就此停手，绝不
// 反复试。
window.qfChatState = function () {
  let shellId = '', webId = '';
  try { shellId = deviceIdFor('shell'); webId = deviceIdFor('web'); } catch (e) {}
  const meta = state.deviceMeta || [];
  return {
    hasToken: !!state.token, user: state.user || '', locked: !!state.locked, unlocked: !!(state.priv && state.vaultKey),
    // 设备副本接线状态（壳主进程据此决定递入设备密钥的时机；页面长期
    // 保活时本函数可随时调用，不假设页面重新加载）
    shellDeviceId: shellId, webDeviceId: webId,
    hasShellDeviceCopy: meta.some(d => d.deviceId === shellId),
    hasWebDeviceCopy: meta.some(d => d.deviceId === webId),
    hasDeviceCopy: meta.length > 0,
    hasSessionCopy: !!state.hasSessionCopy
  };
};
// 壳侧设备密钥递入（2.3.0 L 线）：壳主进程以系统加密保护的设备密钥经
// 注入通道递入页面内存，本函数用它尝试解开本设备的设备包裹副本。
// 页面长期保活时可于任意时刻调用（登录态落定后、视图恢复显示后均可），
// 成功后按统一收尾进入会话；失败返回 false，壳侧就此停手、不反复试。
window.qfShellDeviceUnlock = async function (deviceKeyB64) {
  try {
    if (!state.token || !deviceKeyB64) return false;
    await C.ready();
    state.shellDeviceKey = String(deviceKeyB64);
    const ok = await tryDeviceUnlock();
    if (!ok) return false;
    await finishSilentUnlock();
    return true;
  } catch (e) { return false; }
};
// 壳侧设备副本补写：页面已通过其他路径解锁后，壳递入设备密钥，页面
// 在后台为壳路径登记一份设备包裹副本，此后壳内可走设备静默解锁。
window.qfShellDeviceEnroll = async function (deviceKeyB64) {
  try {
    if (!deviceKeyB64 || !(state.priv && state.vaultKey)) return false;
    await C.ready();
    state.shellDeviceKey = String(deviceKeyB64);
    return await enrollDeviceCopy();
  } catch (e) { return false; }
};
window.qfShellUnlock = async function (password) {
  try {
    if (!state.token || !password) return false;
    await C.ready();
    const r = await api('GET', '/chat/api/keys/me');
    state.deviceMeta = r.keys ? (r.keys.devices || []) : [];
    if (r.keys) state.hasSessionCopy = !!r.keys.hasSessionCopy;
    if (!r.keys) {
      // 还没设过聊天钥匙：与第一次用密码登录时完全同路——本地生成钥匙、
      // 用这个密码包装后上存，并同批写入托管副本，记录从此可解。
      await createKeysSilently(password);
    } else {
      const hasWraps = !!(r.keys.wrappedPriv && r.keys.wrappedVault);
      const priv = hasWraps ? C.unwrapWithPassword(r.keys.wrappedPriv, password) : null;
      const vaultKey = hasWraps ? C.unwrapWithPassword(r.keys.wrappedVault, password) : null;
      if (priv === null || vaultKey === null) {
        // 密码对不上包裹（已改密等）：改走托管副本取回；取回成功同样
        // 算本通道完成。再不行才返回 false 停手，不重试、不弹任何框。
        if (!(await fetchSessionCopy())) return false;
        try {
          await api('POST', '/chat/api/keys/rewrap', {
            wrappedPriv: C.wrapWithPassword(state.priv, password),
            wrappedVault: C.wrapWithPassword(state.vaultKey, password)
          });
        } catch (e) { /* 重新包装失败不影响本次已解开的状态 */ }
      } else {
        state.priv = priv; state.vaultKey = vaultKey;
      }
    }
    state.password = password;
    state.locked = false;
    enrollDeviceCopy().catch(() => {}); // 凭据解锁成功时刻的静默迁移：后台补写设备副本
    if (!state.hasSessionCopy) uploadSessionCopy().catch(() => {}); // 同一时刻补写托管副本
    await finishSilentUnlock();
    return true;
  } catch (e) { return false; }
};

// ---------- 主题（P0-2：与控制台统一来源；聊天页不再私自存 qfchat-theme） ----------
// 有效主题 = 壳手动选择 ＞ 控制台共用偏好（localStorage['qf-theme']）＞ 系统主题。
// 壳推送经窗口事件 'qf-theme-state'（Electron 由 console-preload.js 转发主进程推送，
// Android 由壳注入 JS 派发）；detail 为 {resolved: 'dark'|'light', mode: 'system'|'light'|'dark'}，
// 旧 'blue' 为浅色历史键名，读兼容归一化为 'light'。纯浏览器下该事件永不触发，走偏好/系统两层。
// 壳推送只作运行时生效，不写 localStorage。
let chatShellMode = null; // 'system' | 'light' | 'dark' | null（null = 未收到壳推送）
let chatShellResolved = null; // 'dark' | 'light' | null
function chatSystemTheme() { try { return (window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light'; } catch (e) { return 'light'; } }
function chatStoredTheme() { try { const v = localStorage.getItem('qf-theme'); return (v === 'dark' || v === 'light') ? v : null; } catch (e) { return null; } }
function chatApplyEffectiveTheme() {
  let t;
  if (chatShellMode === 'dark' || chatShellMode === 'light') t = chatShellResolved === 'dark' ? 'dark' : 'light';
  else t = chatStoredTheme() || chatSystemTheme();
  document.body.classList.toggle('dark', t === 'dark');
  return t;
}
function chatOnShellTheme(resolved, mode) {
  if (resolved === 'blue') resolved = 'light'; // 旧壳读兼容
  if (mode === 'blue') mode = 'light';
  if (resolved === 'dark' || resolved === 'light') chatShellResolved = resolved;
  if (mode !== 'dark' && mode !== 'light' && mode !== 'system') {
    // 无 mode 的推送不改 mode、不重落主题：旧 Windows console-preload 的
    // 'qf-theme-state' 通道只带 resolved、mode 恒为 null（cb(t, null)），
    // 旧代码照常重落，会把壳手动深色一次闪回本机偏好/系统浅色；同一次
    // 广播的 'qf-theme-mode' 随后会带 mode 纠正（P0-2 实测，2026-11-17）。
    // A10（2026-11-18）已修 console-preload 不再发无 mode 推送，本分支
    // 保留作旧壳防御。
    try { return document.body.classList.contains('dark') ? 'dark' : 'light'; } catch (e) { return 'light'; }
  }
  chatShellMode = mode;
  return chatApplyEffectiveTheme();
}
try { window.addEventListener('qf-theme-state', (e) => { const d = (e && e.detail) || {}; chatOnShellTheme(d.resolved, d.mode); }); } catch (e) {}
try {
  const _mq = window.matchMedia && matchMedia('(prefers-color-scheme: dark)');
  if (_mq) {
    const _h = () => { try { chatApplyEffectiveTheme(); } catch (e) {} };
    if (_mq.addEventListener) _mq.addEventListener('change', _h);
    else if (_mq.addListener) _mq.addListener(_h);
  }
} catch (e) {}

// ---------- 入口 ----------
window.addEventListener('DOMContentLoaded', async () => {
  chatApplyEffectiveTheme();
  try { localStorage.removeItem('qfchat-theme'); } catch (e) {} // P0-2：旧私自键一次清掉，之后只用控制台共用键 qf-theme
  try { if (window.qfLea && typeof window.qfLea.onTheme === 'function') { window.qfLea.onTheme((resolved, mode) => chatOnShellTheme(resolved, mode)); } } catch (e) {}
  try { if (window.qfLea && typeof window.qfLea.getThemeState === 'function') { window.qfLea.getThemeState().then((s) => { if (s) chatOnShellTheme(s.resolved, s.mode); }).catch(() => {}); } } catch (e) {}
  $('logoutBtn').onclick = async () => {
    try { await api('POST', '/chat/api/logout'); } catch (e) {}
    localStorage.removeItem('qfchat-remember');
    location.reload();
  };
  $('lgBtn').onclick = async () => { await C.ready(); doLogin().catch(e => { if (e.message !== '__unavailable__') $('lgErr').textContent = e.message; }); };
  $('lgPass').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('lgBtn').click(); });
  const unavailBack = $('unavailBackBtn');
  if (unavailBack) unavailBack.onclick = () => { show('friendsView'); renderFriends().catch(() => {}); };
  $('backBtn').onclick = () => { state.currentWith = ''; show('friendsView'); renderFriends(); };
  const cs = $('convSearch');
  if (cs) cs.addEventListener('input', () => renderFriendRows());
  // 窗口宽度跨 900px 阈值时只重排双栏/单栏显示：不重载、不重拉数据，
  // 已打开会话、未发草稿（输入框 DOM 不动）、解锁状态全部保留。
  let rzTimer = null;
  window.addEventListener('resize', () => {
    if (rzTimer) clearTimeout(rzTimer);
    rzTimer = setTimeout(() => { if (!$('splitRoot').classList.contains('hidden')) syncSplit(); }, 80);
  });
  $('sendBtn').onclick = sendMessage;
  $('msgInput').addEventListener('keydown', (e) => { if (e.isComposing || e.keyCode === 229) return; if (e.key === 'Enter') sendMessage(); }); // S-052：组合输入（IME）中不发送
  $('delConvBtn').onclick = deleteConversation;
  await C.ready();
  await tryRestore();
  if (!state.token) { await trySso(); if (!state.token) show('loginView'); }
});
