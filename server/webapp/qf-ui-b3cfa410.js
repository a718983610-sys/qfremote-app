/* qf-ui.js — W-05 机械拆分（2026-11-15，全进 3.0）
 * 层：共享 UI 原语。Toast/Modal、状态盒/空态、好友角标、导航/抽屉、行组件。
 * 可依赖 qf-schema / qf-runtime；禁止依赖 app.js 的视图与启动代码（见 tests/lint-no-cycles.mjs）。
 * 加载顺序第 3 位。W-06 组件库在此文件基础上抽 components/。 */
'use strict';

/* G8-end */

/* ---------------- 提示层（恒在最上层，z=100000） ---------------- */
function toast(msg, type) {
  const box = $('#toasts'); if (!box) return;
  while (box.children.length >= 3) box.removeChild(box.firstChild); /* C §1.1：最多 3 条 */
  const t = document.createElement('div');
  t.className = 'toast ' + (type || 'info'); t.textContent = msg;
  t.setAttribute('role', 'status');
  t.onclick = () => { t.classList.add('leaving'); setTimeout(() => t.remove(), 120); };
  box.appendChild(t);
  setTimeout(() => { t.classList.add('leaving'); setTimeout(() => t.remove(), 120); }, 4000); /* C §1.1：时长 4s；B §3.1：退出 D1/E-Q */
}
/* ---------------- 弹窗层（z=90000，低于提示层） ---------------- */
let modalLastFocus = null;
function showModal(title, bodyHtml, buttons) {
  const root = $('#modalRoot');
  modalLastFocus = document.activeElement;
  root.innerHTML = `<div class="mask"><div class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}"><h3 tabindex="-1">${esc(title)}</h3><div class="mbody">${bodyHtml}</div><div class="mops"></div></div></div>`;
  const ops = $('.mops', root);
  (buttons || [{ label: '知道了' }]).forEach(b => {
    const btn = document.createElement('button');
    btn.className = 'btn' + (b.danger ? ' danger solid' : (b.primary ? '' : ' grey')); btn.textContent = b.label;
    btn.onclick = () => { if (b.onClick) b.onClick(); closeModal(); };
    ops.appendChild(btn);
  });
  const primary = ops.querySelector('.btn:not(.grey)') || ops.querySelector('.btn');
  if (primary) primary.focus(); /* C §1.2：主按钮默认焦点 */
  return root;
}
function closeModal() {
  const root = $('#modalRoot'); if (!root || !root.innerHTML) return;
  const m = root.querySelector('.modal');
  if (m) { m.classList.add('closing'); setTimeout(() => { root.innerHTML = ''; }, 130); /* B §3.1：退出 D2/E-X 130ms */
  } else root.innerHTML = '';
  if (modalLastFocus && document.contains(modalLastFocus)) { try { modalLastFocus.focus(); } catch (e) {} modalLastFocus = null; }
}
/* 弹窗焦点陷阱（C §1.1/§6：Tab 不逃逸，Esc 取消——Esc 见全局 keydown） */
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Tab') return;
  const modal = document.querySelector('#modalRoot .modal');
  if (!modal) return;
  const f = Array.from(modal.querySelectorAll('button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])')).filter(el => !el.disabled && el.offsetParent !== null);
  if (!f.length) return;
  const first = f[0], last = f[f.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});
function confirmModal(title, text, okLabel, onOk) {
  /* D-02（2026-11-15 深审阻断）：弹窗最终确认按钮取消通用 primary，改危险确认样式（实心红底浅色字）；页面入口仍保持非实心 danger，只有最终确认态加重。 */
  showModal(title, `<p>${esc(text)}</p>`, [{ label: '取消' }, { label: okLabel || '确认', danger: true, onClick: onOk }]);
}
function bindRetry(container, fn) { const b = $('[data-retry]', container); if (b) b.onclick = fn; }
/* C §2.1 空状态证据模块：只用真实已有数据——最近会话设备（localStorage qfLastSessionDevice）、
   许可（S.license）、设备列表（S.stats.devices）；无配对码接口、无 telemetry，故本机 ID 与 RTT 等一律显示 —，不编数字。 */
function deviceEmptyHtml(title, sub) {
  let last = '—'; try { last = localStorage.getItem('qfLastSessionDevice') || '—'; } catch (e) {}
  const lic = S.license || {};
  const licTxt = lic.hasKey ? esc((lic.planName || '已激活') + (lic.maskedKey ? ' · ' + lic.maskedKey : '')) : '未激活';
  return `<div class="statebox ev-empty"><b>${esc(title)}</b><p>${esc(sub)}</p>
    <div class="ev-list">
      <div class="row"><span class="tile">${ic('monitor')}</span><span><b>最近会话设备</b><small>${esc(last)}</small></span></div>
      <div class="row"><span class="tile">${ic('key')}</span><span><b>本机 ID</b><small>—（无本机标识接口）</small></span></div>
      <div class="row"><span class="tile">${ic('shield')}</span><span><b>许可</b><small>${licTxt}</small></span></div>
    </div>
    <p class="ev-meta">设备由站长分配或好友共享；被控端安装并上线后会出现在这里。</p>
    <div class="ev-actions"><button class="btn sm" data-go="purchase">购买密钥</button><button class="btn sm ghost" data-go="devices">重新加载</button></div></div>`;
}
function netFail(container, retryFn) {
  container.innerHTML = stateBox('网络暂时不可用', '与服务器的连接出现问题，请检查网络后重新加载。您的登录状态不会因此丢失。', true);
  bindRetry(container, retryFn);
}
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
    `<div class="gtitle">功能</div>` + FUNC.map(i => navBtn(i, activeRoute, cls)).join('') + // r13：抽屉此前只渲染 MENU34，缺「功能」组 5 项（我的设备/聊天/智能客服/购买密钥/积分与福利），与桌面侧边栏不一致；补齐与侧边栏同序
    (S.isAdmin ? `<div class="gtitle">站长</div>` + navBtn({ icon: 'gear', label: '站长管理', route: 'admin' }, activeRoute, cls) : '') + websiteNavHtml(cls) +
    `<button class="${cls || 'nav'} nav-danger" data-nav="logout"><span class="logout-icon">${ic('logout')}</span><span>登出</span></button>`;
}
function renderNavs() {
  const a = S.route.name === 'device' ? 'devices' : (S.route.name === 'remote' ? 'devices' : S.route.name);
  $('#sidebar').innerHTML =
    `<div class="brand"><span class="mark"><svg viewBox="0 0 240 240" aria-hidden="true"><rect x="0" y="0" width="240" height="240" rx="56" style="fill:var(--mark-bg)"/><path d="M 197.2 130.9 A 78 78 0 1 1 161.3 53.9" fill="none" style="stroke:var(--mark-fg)" stroke-width="25" stroke-linecap="round"/><circle cx="190.1" cy="85.8" r="16" style="fill:var(--mark-fg)"/></svg></span><span><b>QFRemote</b><small>REMOTE CONTROL</small></span></div>` +
    `<button class="sideid" data-nav="profile"><span data-my-avatar="38">${myAvatarHtml(38)}</span><span class="sideidtx"><b data-my-nick>${esc(myEffectiveNickname())}</b><small>${esc(S.user || '')}</small></span></button>` +
    `<div class="gtitle">主菜单</div>` +
    MENU34.map(i => navBtn(i, a)).join('') +
    `<div class="gtitle">功能</div>` +
    FUNC.map(i => navBtn(i, a)).join('') +
    (S.isAdmin ? `<div class="gtitle">站长</div>` + navBtn({ icon: 'gear', label: '站长管理', route: 'admin' }, a) : '') +
    `<div class="sp"></div>` + websiteNavHtml('nav') +
    `<button class="nav nav-danger" data-nav="logout"><span class="logout-icon">${ic('logout')}</span><span>登出</span></button>` +
    `<div class="sidefoot">安全 · 便捷 · 远程连接</div>`;
  $('#drawer').innerHTML =
    `<div class="brand"><span class="mark"><svg viewBox="0 0 240 240" aria-hidden="true"><rect x="0" y="0" width="240" height="240" rx="56" style="fill:var(--mark-bg)"/><path d="M 197.2 130.9 A 78 78 0 1 1 161.3 53.9" fill="none" style="stroke:var(--mark-fg)" stroke-width="25" stroke-linecap="round"/><circle cx="190.1" cy="85.8" r="16" style="fill:var(--mark-fg)"/></svg></span><span><b>QFRemote</b><small>REMOTE CONTROL</small></span></div>` +
    `<button class="sideid" data-nav="profile"><span data-my-avatar="38">${myAvatarHtml(38)}</span><span class="sideidtx"><b data-my-nick>${esc(myEffectiveNickname())}</b><small>${esc(S.user || '')}</small></span></button>` +
    `<div class="gtitle">主菜单</div>` + menu34Html(a, 'nav');
  $('#acctMenu').innerHTML = MENU34.map(i =>
    `<a data-nav="${i.route}" class="${i.route === a ? 'on' : ''}">${ic(i.icon)}<span>${i.label}</span>${i.route === 'friends' ? frBdgHtml() : ''}</a>`).join('') +
    (S.isAdmin ? `<a data-nav="admin" class="${a === 'admin' ? 'on' : ''}">${ic('gear')}<span>站长管理</span></a>` : '') +
    `<a href="${QF_WEBSITE_URL}" target="_blank" rel="noopener">${ic('globe')}<span>官方网站</span></a>` +
    `<a data-nav="logout" class="red">${ic('logout')}<span>登出</span></a>`;
  $('#bnav').innerHTML = BTABS.map(i => navBtn(i, a, '')).join('');
  $('#acctChip').innerHTML = `<span data-my-avatar="34">${myAvatarHtml(34)}</span><b data-my-nick>${esc(myEffectiveNickname())}</b>${frBdgHtml()}`;
  refreshMyProfileLazy();
  document.querySelectorAll('[data-nav]').forEach(el => {
    el.addEventListener('click', () => {
      const r = el.getAttribute('data-nav');
      closeAcctMenu();
      if (r === 'logout') { if (el.closest('#drawer')) setDrawer(false); QFHooks.doLogout(); return; }
      QFHooks.navigate(r);   // 2026-11-13 站长改令（取代 2026-10-26「点项不收起」）：抽屉内点跳转项后自动收起
      if (el.closest('#drawer')) setDrawer(false);
    });
  });
  // 抽屉内「官方网站」外链（无 data-nav）：点后同样收起抽屉（2026-11-13 站长改令）
  document.querySelectorAll('#drawer a[href]').forEach(a => {
    a.addEventListener('click', () => setDrawer(false));
  });
}

/* ---------------- 抽屉（#35：只占一部分；点项自动收起 2026-11-13 站长改令，取代 2026-10-26「点项不收起」：
   遮罩 #drawerScrim 承接抽屉外点击、只关抽屉，这一击不落到正文任何控件） ---------------- */
let drawerOpen = false;
let drawerLastFocus = null;
function setDrawer(open) {
  if (open && !drawerOpen) drawerLastFocus = document.activeElement;
  drawerOpen = open;
  document.body.classList.toggle('drawer-open', open); // 抽屉打开态挂载（2026-11-11：顶栏已常驻品牌蓝，本类仅保留作抽屉打开态兜底）
  const d = $('#drawer');
  d.classList.toggle('open', open);
  d.setAttribute('aria-hidden', open ? 'false' : 'true');
  const sc = $('#drawerScrim');
  if (sc) { sc.classList.toggle('on', open); sc.setAttribute('aria-hidden', open ? 'false' : 'true'); }
  if (open) { const f = d.querySelector('button,[href],input,[tabindex]:not([tabindex="-1"])'); if (f) f.focus(); /* C §1.1：打开后焦点进抽屉 */
  } else if (drawerLastFocus && document.contains(drawerLastFocus)) { try { drawerLastFocus.focus(); } catch (e) {} drawerLastFocus = null; } /* C §1.1：关闭后焦点回触发按钮 */
}
/* 抽屉焦点陷阱（C §1.1：Tab 只在抽屉内循环） */
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Tab' || !drawerOpen) return;
  const d = document.querySelector('#drawer'); if (!d) return;
  const f = Array.from(d.querySelectorAll('button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])')).filter(el => !el.disabled && el.offsetParent !== null);
  if (!f.length) return;
  const first = f[0], last = f[f.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});
function closeAcctMenu() { const m = $('#acctMenu'); if (m) m.classList.remove('open'); }
document.addEventListener('pointerdown', (e) => {
  // 落点在抽屉之外只做收起。正文区已被 #drawerScrim 遮罩盖住（层级低于抽屉、高于正文），
  // 点遮罩的这一击落在遮罩上、到不了正文控件（2026-10-26 站长改令，取代旧「点外收起不吞点击」）；
  // 顶栏在遮罩层之下／抽屉遮罩会压暗顶栏（z 值见 token：--z-top 60000 < --z-scrim 65000），其控件点击照旧生效（并在此顺带收起抽屉），汉堡钮自理开关。
  if (drawerOpen && !e.target.closest('#drawer') && !e.target.closest('#burgerBtn')) setDrawer(false);
  const m = $('#acctMenu');
  if (m && m.classList.contains('open') && !e.target.closest('.acctwrap')) closeAcctMenu();
});
const drawerScrimEl = $('#drawerScrim');
if (drawerScrimEl) drawerScrimEl.addEventListener('click', () => setDrawer(false));
/* MOBILE-FIX 2026-11-14（F-01）：行操作改为显式 data-action 绑定，
   不再按 querySelectorAll 下标绑定（深色模式开关行曾占第 0 位致全错位）。
   action 为可选第 6 参；不传则与原来逐字一致。 */
function rowHtml(icon, t, s, go, anchor, action) {
  return `<button class="row" ${go ? `data-go="${go}"` : ''}${anchor ? ` data-anchor="${anchor}"` : ''}${action ? ` data-action="${action}"` : ''}><span class="tile">${ic(icon)}</span><span><b>${esc(t)}</b><small>${esc(s)}</small></span><span class="chev">${ic('chevR')}</span></button>`;
}
/* 说明行专用（无落点、无行级操作）：渲染为普通 div、无箭头，避免「带箭头的
   button 却无点击处理」的死钮外观（P2-036/037/038/039 同族清零口径）。行下方
   另有真实操作按钮的标签行也用本式，操作仍走各自按钮。 */
function rowInfoHtml(icon, t, s) {
  return `<div class="row"><span class="tile">${ic(icon)}</span><span><b>${esc(t)}</b><small>${esc(s)}</small></span></div>`;
}
/* 行内操作版（排版深查批2）：操作按钮并入行内 .ops，不再用行下 margin 缩进 div；窄屏下 .ops 按 .row .ops 规则整行下移、对齐文字列。btnHtml 为结构安全的按钮/标签片段（不含用户数据）。 */
function rowActHtml(icon, t, s, btnHtml) {
  return `<div class="row"><span class="tile">${ic(icon)}</span><span><b>${esc(t)}</b><small>${esc(s)}</small></span><span class="ops">${btnHtml}</span></div>`;
}
/* ---- W-05 收敛：身份簇（头像/昵称/档案，纯 UI 渲染＋档案服务） ---- */

let MyProfile = null;
function profileAvatarHtml(p, size) {
  size = size || 40;
  if (p && p.hasAvatar && p.avatarUrl) return `<img class="qf-avatar av-dyn" style="--av-size:${size}px" src="${esc(p.avatarUrl)}" alt="头像">`;
  return `<img class="qf-avatar qf-avatar-ph av-dyn" style="--av-size:${size}px" src="assets/avatar-placeholder.svg" alt="默认头像">`;
}
function myAvatarHtml(size) { return profileAvatarHtml(MyProfile, size); }
function myEffectiveNickname() { return (MyProfile && MyProfile.effectiveNickname) || S.displayName || S.user || ''; }
function paintIdentity() {
  document.querySelectorAll('[data-my-avatar]').forEach(el => { el.innerHTML = profileAvatarHtml(MyProfile, Number(el.getAttribute('data-my-avatar')) || 34); });
  document.querySelectorAll('[data-my-nick]').forEach(el => { el.textContent = myEffectiveNickname(); });
}
async function refreshMyProfile() {
  const r = await api('/profile/api/me');
  if (r.status === 200 && r.json && r.json.ok) {
    MyProfile = r.json; S.profile = r.json;
    if (r.json.effectiveNickname) S.displayName = r.json.effectiveNickname;
    if (r.json.username) S.user = r.json.username;
    paintIdentity();
    return MyProfile;
  }
  return null;
}
function refreshMyProfileLazy() {
  if (S.auth !== 'in' || MyProfile || refreshMyProfileLazy._p) return;
  refreshMyProfileLazy._p = true;
  refreshMyProfile().then(() => { refreshMyProfileLazy._p = false; }, () => { refreshMyProfileLazy._p = false; });
}
// 统一档案失效（核对 S1）：登出/被踢/会话失效/重新登录四处统一清，
// 防同页切号后身份区串上一账号的昵称与头像（lazy 守卫见 MyProfile 非空即拦）。
function clearMyProfile() { MyProfile = null; S.profile = null; }
/* 头像预处理（照 QFClash 网页版 prepareAvatar 定版移植）：≤200KB 且格式
   合规直传；超限 canvas 缩最长边 512px、先填白底再绘图（防透明 PNG 转
   黑底）、JPEG 质量 0.85 起每次 −0.15 递减至 ≤200KB（下限 0.4）；
   仍超限报「头像太大了，请先压缩到 200KB 以内再上传」。 */
async function prepareAvatar(file) {
  const MAX = AVATAR_MAX_BYTES;
  // 核对 D5：先看 file.size 再决定读法——合规小图才全量读入直传；超硬顶直接
  // 报定版文案不读；其余走 canvas 路径（object URL＋Image 本不需要先整文件读入）。
  if (typeof file.size === 'number') {
    if (avatarDirectOk(file.size, file.type)) { const buf = new Uint8Array(await file.arrayBuffer()); return { mime: file.type, dataBase64: b64OfBytes(buf) }; }
    if (file.size > AVATAR_HARD_MAX_BYTES) { const tooBig = new Error(AVATAR_TOO_LARGE_TEXT); tooBig.code = 'AVATAR_TOO_LARGE'; throw tooBig; }
  } else {
    const buf = new Uint8Array(await file.arrayBuffer());
    if (avatarDirectOk(buf.length, file.type)) return { mime: file.type, dataBase64: b64OfBytes(buf) };
  }
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const scale = Math.min(1, 512 / Math.max(img.width, img.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.width * scale)); canvas.height = Math.max(1, Math.round(img.height * scale));
    const actx = canvas.getContext('2d');
    actx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--paper').trim() || 'white'; actx.fillRect(0, 0, canvas.width, canvas.height);
    actx.drawImage(img, 0, 0, canvas.width, canvas.height);
    let q = 0.85, blob = null;
    while (q >= 0.4) {
      blob = await new Promise(res => { canvas.toBlob(res, 'image/jpeg', q); });
      if (blob && blob.size <= MAX) break;
      q = Math.round((q - 0.15) * 100) / 100;
    }
    if (!blob || blob.size > MAX) { const tooBig = new Error(AVATAR_TOO_LARGE_TEXT); tooBig.code = 'AVATAR_TOO_LARGE'; throw tooBig; }
    return { mime: 'image/jpeg', dataBase64: b64OfBytes(new Uint8Array(await blob.arrayBuffer())) };
  } finally { URL.revokeObjectURL(url); }
}
function fmtProfileTime(v) {
  if (v == null || v === '') return '';
  const n = Number(v);
  if (isFinite(n) && n > 0) return fmtDate(n < 1e12 ? n * 1000 : n);
  const d = new Date(v);
  return isNaN(d.getTime()) ? String(v) : fmtDate(d.getTime());
}
/* 「个人资料」卡（纯渲染函数：Views.profile 与本地 harness 共用同一份）。
   昵称与登录账号名分行分称（C1）：昵称行可编辑，登录名行恒带
   「登录账号名（不可修改，如需变更请联系官方客服）」。 */
function profileCardHtml(p) {
  p = p || {};
  const eff = p.effectiveNickname || p.nickname || p.username || '';
  const def = p.defaultNickname || p.username || '';
  return `<div class="card" id="pfProfileCard"><h3>个人资料</h3>
    <div class="profile-head">
      <span class="pf-names"><b id="pfEffNick">${esc(eff)}</b>
      <small id="pfDefaultNick">默认昵称：${esc(def)}</small>
      <small>未设置昵称时显示默认昵称（即登录账号名）。</small></span></div>
    <div class="profile-login"><span>登录账号名（不可修改，如需变更请联系官方客服）</span><b id="pfLoginName">${esc(p.username || '')}</b></div>
    <div class="field"><label for="pfNick">昵称 <span class="pf-count"><span id="pfNickCount">0</span> / 20</span></label>
      <input id="pfNick" maxlength="20" value="${esc(p.nickname || '')}" placeholder="请输入昵称" autocomplete="off">
      <p class="hint">昵称最多 20 字；提交后经审核，通过即生效。</p></div>
    <div id="pfNickOut"></div>
    <div class="pf-ops"><button class="btn sm" id="pf-nick-save">保存昵称</button><button class="btn sm grey" id="pf-nick-clear">清除昵称</button></div>
    <div class="field mt-18"><label for="pfAvatarFile">头像</label>
      <input id="pfAvatarFile" type="file" accept="image/png,image/jpeg,image/webp,image/gif" class="filepick">
      <label for="pfAvatarFile" class="btn sm ghost">选择图片</label><span id="pfAvatarName" class="filepick-name">尚未选择图片</span>
      <p class="hint">头像只支持 PNG、JPG、WebP 或 GIF 图片，大小不超过 200KB；超出时将先在本地压缩再上传。</p></div>
    <div id="pfAvatarOut"></div>
    <div class="pf-ops"><button class="btn sm" id="pf-avatar-upload">上传头像</button><button class="btn sm grey" id="pf-avatar-del">删除头像</button></div>
    <h3 class="mt-22">审核记录</h3><div id="pfRecords"><div class="skel sk-h40"></div></div>
  </div>`;
}
function profileRecordsHtml(records) {
  const list = (Array.isArray(records) ? records : []).slice(0, 50);
  if (!list.length) return '<div class="statebox"><b>暂无审核记录</b><p>修改昵称或头像后，审核结果会显示在这里。</p></div>';
  const kindLabel = k => k === 'avatar' ? '头像' : (k === 'nickname' ? '昵称' : String(k || '资料'));
  const statusLabel = s => ({ approved: '已通过', rejected: '未通过', pending: '审核中', appealed: '已申诉', appeal_approved: '申诉通过', appeal_rejected: '申诉未通过' }[s] || String(s || ''));
  return list.map(r => {
    const canAppeal = r.status === 'rejected' && !r.appealed && !r.appeal && !r.appealStatus;
    return `<div class="pfrec"><span class="tag">${esc(kindLabel(r.kind))}</span><span class="pfrec-main"><b>${esc(statusLabel(r.status))}</b>${r.category ? `<small>包含${esc(r.category)}</small>` : ''}</span><span class="pfrec-time">${esc(fmtProfileTime(r.createdAt != null ? r.createdAt : r.created_at))}</span>${canAppeal ? `<button class="btn sm ghost" data-appeal="${esc(r.id)}">申诉</button>` : ''}</div>`;
  }).join('');
}
/* ============================================================
 * W-06：内部组件库＋布局骨架统一（2026-11-15，全进 3.0）
 * 对标 Nextcloud @nextcloud/vue（NcAppNavigation＋NcAppContent）/
 * Supabase 三层组件（layouts/interfaces/ui）/ Cal.com packages/ui。
 * 规矩（成文版见 server/webapp/components/COMPONENTS.md）：
 *  · 新 UI 一律从 QFComponents 取，禁止各页各写一套导航/弹窗/按钮；
 *  · 组件只收 props、不读全局 S、不直接调 api（数据由调用方传入）；
 *  · 文案由调用方传（或走 t()），组件内不写硬编码中文；
 *  · 颜色只用 token（CSS 变量），组件内不写色值。
 * ============================================================ */
const QFComponents = {
  _reg: new Map(),
  register(name, def) {
    if (!name || !def || typeof def.render !== 'function') return false;
    QFComponents._reg.set(name, def);
    return true;
  },
  render(name, props) {
    const def = QFComponents._reg.get(name);
    if (!def) return '';
    try { return def.render(props || {}); } catch (e) {
      console.warn('QFComponents render failed:', String(name)); // no props: they may contain user data
      return '<div role="status" data-qf-error="' + esc(String(name)) + '"></div>';
    }
  },
  list() { return Array.from(QFComponents._reg.keys()).sort(); },
  meta(name) { const d = QFComponents._reg.get(name); return d ? (d.meta || {}) : null; }
};

/* 按钮：.btn 体系唯一入口（primary/grey/ghost/danger，sm 尺寸）。
 * S-057：attrs 不再原样拼进 HTML——只放行白名单属性名（data-* / aria-* /
 * type / title / disabled），其余一律丢弃（含 on* 事件处理器、style、
 * href、formaction 等）；属性值一律 esc() 转义。现行无生产调用点传
 * 用户数据，属潜在风险收口；调用方仍可传字符串或 {名: 值} 对象。 */
function qfSanitizeButtonAttrs(attrs) {
  const pairs = [];
  const push = (name, value) => {
    if (typeof name !== 'string') return;
    const n = name.trim().toLowerCase();
    const ok = n === 'type' || n === 'title' || n === 'disabled' ||
      n.indexOf('data-') === 0 || n.indexOf('aria-') === 0;
    if (!ok) return; // 白名单外（含 on* / style / href / formaction）直接丢弃
    if (n === 'disabled') { pairs.push('disabled'); return; }
    pairs.push(n + '="' + esc(value == null ? '' : String(value)) + '"');
  };
  if (attrs && typeof attrs === 'object') {
    Object.keys(attrs).forEach((k) => push(k, attrs[k]));
  } else if (typeof attrs === 'string' && attrs.trim()) {
    // 形如：data-go="x" aria-label='y' disabled / type=button（引号可单/双/无）
    const re = /([A-Za-z_:][\w:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`>/=]+)))?/g;
    let m;
    while ((m = re.exec(attrs)) !== null) push(m[1], m[2] != null ? m[2] : (m[3] != null ? m[3] : (m[4] != null ? m[4] : '')));
  }
  return pairs.join(' ');
}
QFComponents.register('button', {
  meta: { layer: 'ui', a11y: 'label is the accessible name; icon-only buttons need ariaLabel' },
  render(p) {
    const kind = (p.kind === 'grey' || p.kind === 'ghost' || p.kind === 'danger') ? ' ' + p.kind : '';
    const size = p.size === 'sm' ? ' sm' : '';
    const label = esc(p.label || '');
    const icon = p.icon ? ic(p.icon) : '';
    const aria = p.ariaLabel ? ` aria-label="${esc(p.ariaLabel)}"` : '';
    const attrs = qfSanitizeButtonAttrs(p.attrs);
    const loading = p.loading === true;
    const busy = loading ? ' disabled aria-busy="true"' : '';
    const spinner = loading ? '<span class="btn-loader" aria-hidden="true"></span>' : '';
    return `<button class="btn${kind}${size}${loading ? ' is-loading' : ''}"${aria}${attrs ? ' ' + attrs : ''}${busy}>${spinner}${icon}${label}</button>`;
  }
});

/* 空态：.statebox 唯一入口（标题＋说明＋可选操作）。 */
QFComponents.register('empty-state', {
  meta: { layer: 'ui', a11y: 'title in <b>, actions keyboard-reachable' },
  render(p) {
    const actions = (p.actions || []).map((a) =>
      `<button class="btn sm${a.kind === 'ghost' ? ' ghost' : ''}" data-go="${esc(a.go || '')}">${esc(a.label || '')}</button>`).join('');
    return `<div class="statebox"><b>${esc(p.title || '')}</b><p>${esc(p.sub || '')}</p>${actions ? `<div class="ev-actions">${actions}</div>` : ''}</div>`;
  }
});

/* 数据卡（Grafana Stat 式小面板）：设备总览页的指标单元。 */
QFComponents.register('stat-card', {
  meta: { layer: 'ui', a11y: 'value in <b>, unit in <small>' },
  render(p) {
    return `<div class="card"><div class="stat"><span class="tile">${ic(p.icon || 'monitor')}</span><span><b>${esc(p.value || '')}</b><small>${esc(p.label || '')}${p.sub ? ' · ' + esc(p.sub) : ''}</small></span></div></div>`;
  }
});

/* 重连条（RC-04）：次数文案＋取消按钮，文案走 t()（W-09）。 */
QFComponents.register('reconnect-strip', {
  meta: { layer: 'ui', a11y: 'role=status announces reconnect progress' },
  render(p) {
    const n = Number(p.attempt) || 0, max = Number(p.max) || 5;
    const txt = (p.state === 'cancelled')
      ? t('reconnect.cancelled')
      : t('reconnect.attempt', { n, max });
    const cancel = (p.state === 'cancelled') ? '' : `<button class="sv-btn sm" data-act="reconnect-cancel">${esc(t('reconnect.cancel'))}</button>`;
    return `<div class="sv-strip" role="status"><span class="sv-strip__spin"></span><span class="sv-strip__txt">${esc(txt)}</span>${cancel}</div>`;
  }
});

/* 布局骨架：AppShell（NcAppNavigation＋NcAppContent 同款）。
 * index.html 里的静态壳就是本骨架的实例化；本函数返回同一结构，
 * 供 Storybook/画廊在隔离环境渲染骨架，不复制第二套壳。 */
function appShellHtml() {
  // 骨架即 index.html 里的静态壳：有 live DOM 时直接取它的结构（文案随壳走，
  // 本函数不复制第二份文案）；无 DOM 时返回无文案的结构占位。
  try {
    const shell = document.getElementById('shellRoot');
    if (shell) return shell.innerHTML;
  } catch (e) {}
  return '<div class="app"><aside class="side"></aside><div class="main"><div class="top"></div><main id="view"></main></div></div><aside class="drawer"></aside><nav class="bnav"></nav>';
}
QFComponents.register('app-shell', {
  meta: { layer: 'layouts', a11y: 'drawer role=dialog, navigation focus target with local status announcements' },
  render() { return appShellHtml(); }
});
