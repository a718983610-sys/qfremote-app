/* qf-runtime.js — W-05 机械拆分（2026-11-15，全进 3.0）
 * 层：服务层。主题服务、API 层、屏幕锁桥、文件发送、会话/登录态（S/Cache/BanLock）、心跳。
 * 可依赖 qf-schema；禁止依赖 qf-ui / app.js（见 tests/lint-no-cycles.mjs）。
 * 加载顺序第 2 位。Transport / QFStore / i18n / 渲染器等新服务后续叠加进本文件。 */
'use strict';


/* ---------------- G8 深色切换（2026-11-13 遗漏补齐） ----------------
   定位结论：网页控制台此前无任何深色入口——index.html 写死 light，
   app.js 全文无 dark/theme 写操作；深色 tokens 只在 CSS 里待命。
   口径：默认浅色不动；偏好只存本机 localStorage.qf-theme（'dark'|'light'，
   与首页 qfhome-theme / 聊天 qfchat-theme 同键名习惯），不上传服务端。
   唯一入口：我的页「账号与安全」卡片首行开关（该页自称「每项功能只有
   一个入口」）；Windows 壳内嵌的正是本控制台（main.js CONSOLE_URL），
   故壳内控制台同步可用。 */
const THEME_KEY = 'qf-theme';
function getTheme() { try { const v = localStorage.getItem(THEME_KEY); if (v === 'dark' || v === 'light') return v; return (window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light'; } catch (e) { return 'light'; } }/* 2026-11-14 站长明确：无存储偏好时跟随系统主题 */
function applyTheme(t) {
  const theme = t === 'dark' ? 'dark' : 'light';
  try { document.documentElement.setAttribute('data-theme', theme); } catch (e) {}
  try { document.querySelectorAll('.qf-switch').forEach(b => b.setAttribute('aria-checked', theme === 'dark' ? 'true' : 'false')); } catch (e) {}
  try { // W-01: theme-color 由 --bg token 写入，HTML 内不留色值字面量
    let m = document.querySelector('meta[name="theme-color"]');
    if (!m) { m = document.createElement('meta'); m.setAttribute('name', 'theme-color'); document.head.appendChild(m); }
    const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
    if (bg) m.setAttribute('content', bg);
  } catch (e) {}
  return theme;
}
function toggleTheme() {
  const next = getTheme() === 'dark' ? 'light' : 'dark';
  try { localStorage.setItem(THEME_KEY, next); } catch (e) {}
  return applyEffectiveTheme();
}
/* ---------------- P0-2 三端主题同步（2026-11-15） ----------------
   有效主题 = 壳手动选择 ＞ 本机偏好（localStorage.qf-theme）＞ 系统主题。
   - 系统主题：matchMedia('(prefers-color-scheme: dark)')，打开期间翻转实时跟随。
   - 壳手动选择：Electron 主进程推送（console-preload.js 转发为窗口事件
     'qf-theme-state'）或 Android 壳注入 JS 派发同一事件；detail 为
     {resolved: 'dark'|'blue', mode: 'system'|'blue'|'dark'}，其中 'blue'
     是浅色历史键名，不对应蓝色。纯浏览器下该事件永不触发。
   - 壳推送只作运行时生效，不写 localStorage；本机偏好仍只由“我的页”开关写。 */
let shellThemeMode = null; // 'system' | 'blue' | 'dark' | null（null = 未收到壳推送）
let shellThemeResolved = null; // 'dark' | 'blue' | null
function systemTheme() { try { return (window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light'; } catch (e) { return 'light'; } }
function applyEffectiveTheme() {
  let t;
  if (shellThemeMode === 'dark' || shellThemeMode === 'blue') t = shellThemeResolved === 'dark' ? 'dark' : 'light';
  else t = getTheme();
  const r = applyTheme(t);
  syncPfThemeControl();
  return r;
}
/* P0-2 遗留：双入口收敛（2026-11-15，站长已定按大肥鱼建议办）。
   壳内（window.qfLea 存在＝Electron 壳）工具栏三态为唯一手动入口：
   壳手动模式（dark/blue）下控制台“我的页”开关置只读＋显标注，
   壳切回跟随系统后恢复可用；纯浏览器无 qfLea，开关始终可用。
   最小改法：不新增写 IPC、不改 settings 结构、不动主题优先级逻辑；
   标注文案在 app.js 行模板里（qf-runtime.js 硬编码中文须守基线 43 条，零余量），
   这里只切 disabled/aria-disabled/hidden 三态。 */
function syncPfThemeControl() {
  let btn = null;
  try { btn = document.getElementById('pf-theme-toggle'); } catch (e) {}
  if (!btn) return;
  const inShell = (typeof window !== 'undefined' && window.qfLea) ? true : false;
  const shellManual = inShell && (shellThemeMode === 'dark' || shellThemeMode === 'blue');
  try { btn.disabled = !!shellManual; } catch (e) {}
  try { btn.setAttribute('aria-disabled', shellManual ? 'true' : 'false'); } catch (e) {}
  let note = null;
  try { note = document.getElementById('pf-theme-shell-note'); } catch (e) {}
  if (note) { try { note.hidden = !shellManual; } catch (e) {} }
}
function onShellTheme(resolved, mode) {
  if (resolved === 'dark' || resolved === 'blue') shellThemeResolved = resolved;
  if (mode === 'dark' || mode === 'blue' || mode === 'system') shellThemeMode = mode;
  return applyEffectiveTheme();
}
try {
  const _mq = window.matchMedia && matchMedia('(prefers-color-scheme: dark)');
  if (_mq) {
    const _h = () => { try { applyEffectiveTheme(); } catch (e) {} };
    if (_mq.addEventListener) _mq.addEventListener('change', _h);
    else if (_mq.addListener) _mq.addListener(_h);
  }
} catch (e) {}
try { window.addEventListener('qf-theme-state', (e) => { const d = (e && e.detail) || {}; onShellTheme(d.resolved, d.mode); }); } catch (e) {}
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
function apiErrText(r, fallback) {
  if (r && r.json && (r.json.error || r.json.msg)) return r.json.error || r.json.msg;
  return fallback || '服务暂时不可用，请稍后再试。';
}
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
    // X-04：上传 60 秒无进展即 abort（原无任何超时，弱网可无限挂起）。
    let lastProgressAt = Date.now();
    const stallTimer = setInterval(() => {
      if (Date.now() - lastProgressAt > 60000) { clearInterval(stallTimer); try { xhr.abort(); } catch (e) {} resolve({ status: 0, ok: false, json: null, text: '', networkError: true, stalled: true }); }
    }, 5000);
    xhr.upload.onprogress = (e) => { lastProgressAt = Date.now(); if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      clearInterval(stallTimer);
      let json = null; try { json = JSON.parse(xhr.responseText); } catch (e) {}
      resolve({ status: xhr.status, ok: xhr.status >= 200 && xhr.status < 300, json, text: xhr.responseText });
    };
    xhr.onerror = () => { clearInterval(stallTimer); resolve({ status: 0, ok: false, json: null, text: '', networkError: true }); };
    xhr.send(JSON.stringify(payload));
  });
}
async function downloadStagedFile(id, filename, onProgress) {
  // X-04：下载加 30 秒无进展超时（原裸 fetch 无超时、无进度、无断点）——
  // 失败文案带已收字节数，不再只说「下载失败」。
  const ctl = (typeof AbortController === 'function') ? new AbortController() : null;
  let timer = null;
  const armStall = () => { if (ctl) { if (timer) clearTimeout(timer); timer = setTimeout(() => { try { ctl.abort(); } catch (e) {} }, 30000); } };
  const disarm = () => { if (timer) { clearTimeout(timer); timer = null; } };
  let r;
  try {
    armStall();
    r = await fetch('/license/api/files/' + encodeURIComponent(id) + '/download', { credentials: 'include', signal: ctl ? ctl.signal : undefined });
  } catch (e) { disarm(); throw new Error('下载中断（已收 0 MB），请重试。'); }
  disarm();
  if (!r.ok) throw new Error('下载失败（服务返回 ' + r.status + '），请稍后再试。');
  const total = Number(r.headers.get('Content-Length') || 0);
  let blob;
  if (r.body && r.body.getReader) {
    const reader = r.body.getReader(); const chunks = []; let got = 0;
    try {
      for (;;) {
        armStall();
        const part = await reader.read();
        disarm();
        if (part.done) break;
        chunks.push(part.value); got += part.value.length;
        if (onProgress && total) onProgress(got / total);
      }
    } catch (e) {
      disarm();
      try { await reader.cancel(); } catch (e2) {}
      throw new Error('下载中断（已收 ' + (got / 1048576).toFixed(1) + ' MB），请重试。');
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
// P1-4a（2026-11-11）：手动登出的持久标记——登出状态必须活过页面重载。
// r5 真因：S._manualLogout 只在内存，登出中途页面一重载即丢；缓存仍在，
// 启动缓存路径按缓存复活壳、S.auth 回 'in'，表单 3 分钟不出（桩测已复现）。
// 本标记在 doLogout 确认的第一时间写 localStorage；仅凭据提交的新登录
// 成功（doLogin）才清；启动、showShell、checkSession 均认它。
const ManualLogout = {
  KEY: 'qf-console-manual-logout',
  set() { try { localStorage.setItem(this.KEY, '1'); } catch (e) {} },
  clear() { try { localStorage.removeItem(this.KEY); } catch (e) {} },
  is() { try { return localStorage.getItem(this.KEY) === '1'; } catch (e) { return false; } }
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
    try { QFHooks.chatResetAll(); } catch (e) { /* 聊天模块异常不得阻断呈现 */ }
    this.paint();
    this.startTimer();
  },

  toExpired(reason) {
    // X-01：锁屏/会话结束呈现前先拆会话帧（同 sessionDied 的理由）。
    try { QFHooks.teardownSession(); } catch (e) {}
    this.stopTimer();
    this.state = 'expired';
    this.reason = (reason === 'locked') ? 'locked' : 'died';
    S.auth = 'out'; S.license = null; S.points = null; S.isAdmin = false; // DS-R24 B3：已结束页不得残留管理后台入口
    try { Cache.clear(); } catch (e) {}
    try { QFHooks.invalidateNodeMap(); } catch (e) {} // W1-2：会话结束即清设备映射缓存，防换账号残留上一账号设备清单
    try { QFHooks.chatResetAll(); } catch (e) { /* 聊天模块异常不得阻断呈现 */ }
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
          if (manual && !changed) { try { QFHooks.toast('账号仍处于封禁状态。', 'warn'); } catch (e) {} }
          if (manual || changed) this.paint();
          return;
        }
        // 解封：退出锁定，按 checkSession 既有口径回填后回主壳
        this.exit();
        const probe = {};
        const ok = await checkSession(true, { noDied: true, probe, force: true }); // X-02：解封复查是用户可见的恢复动作，页面不可见也不跳过
        if (this.active()) return;            // 复查期间又被判封禁，保持锁定
        if (probe.gated) return;              // DS-R44：checkSession 已画设备门，禁止 showAuth 覆盖
        if (ok && S.auth === 'in') {
          location.hash = '#home';
          QFHooks.showShell();
          try { QFHooks.toast('账号状态已恢复正常，欢迎回来。', 'ok'); } catch (e) {}
        } else {
          QFHooks.showAuth('login', { notice: '请重新登录。' });
        }
        return;
      }
      if (me.status === 401 || me.status === 403) {
        this.toExpired('locked');
        return;
      }
      if (manual) { try { QFHooks.toast('暂时无法确认账号状态，请稍后再试。', 'warn'); } catch (e) {} }
    } catch (e) {
      if (manual) { try { QFHooks.toast('暂时无法确认账号状态，请稍后再试。', 'warn'); } catch (e2) {} }
    } finally {
      this.flight = false;
    }
  },

  paintStatusTool(box) {
    if (!box) return;
    box.innerHTML = '<div class="card mt-16"><h3>查询密钥（账号＋密码核验）</h3>'
      + '<div class="field"><label>账号</label><input id="bn-sq-user"></div>'
      + '<div class="field"><label>密码</label><input id="bn-sq-pass" type="password"></div>'
      + '<button class="btn block" id="bn-sq-btn">查询</button><div class="mt-12" id="bn-sq-out"></div></div>';
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
      if (st === 'locked') html += '<div class="note">事由：' + esc((d && (d.category || d.reason)) || '暂未提供，请联系官方客服核实') + '</div>';
      if (st === 'expired') html += '<button class="btn block" id="bn-relogin">重新登录</button>';
      else html += '<button class="btn block" id="bn-appeal">提交申诉</button>';
      html += '<div class="mt-10 text-center" id="bn-links">';
      if (st === 'expired') html += '<a class="txtlink cursor-pointer" id="bn-appeal-link">提交申诉</a> ';
      html += '<a class="txtlink cursor-pointer" id="bn-support">联系智能客服</a> ';
      html += '<a class="txtlink cursor-pointer" id="bn-status">查询密钥</a> ';
      if (st === 'locked') html += '<a class="txtlink cursor-pointer" id="bn-recheck">重新检查</a> ';
      if (S.isAdmin) html += '<a class="txtlink cursor-pointer" id="bn-admin">管理后台</a> ';
      html += '<a class="txtlink cursor-pointer" id="bn-logout">退出登录</a>';
      html += '</div><div class="mt-16" id="bn-tools"></div></div></div>';
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
        QFHooks.renderAppeal(box, { user: S.user || '' });
      };
      bind('bn-appeal', openAppeal);
      bind('bn-appeal-link', openAppeal);
      bind('bn-support', () => {
        if (!box) return;
        box.innerHTML = '';
        QFHooks.showSupportGuest(box);
      });
      bind('bn-status', () => { if (box) self.paintStatusTool(box); });
      bind('bn-recheck', () => { self.recheck(true); });
      bind('bn-admin', () => { location.href = '/admin'; });
      bind('bn-logout', () => { QFHooks.doLogout(); });
      bind('bn-relogin', () => {
        // P1-4e（2026-11-11）：exit() 万一抛错也不得吞掉表单——先清锁，
        // 无论成败都出登录表单。
        try { self.exit(); } catch (e) {}
        QFHooks.showAuth('login', { notice: '请重新登录。' });
      });
    } catch (e) {
      root.innerHTML = '<div class="authwrap"><div class="auth">'
        + '<h1>账号已被封禁</h1>'
        + '<div class="note err">当前账号暂时无法使用本控制台的各项功能。如需帮助，请提交申诉或联系智能客服。</div>'
        + '<button class="btn block" id="bn-logout">退出登录</button>'
        + '</div></div>';
      const lo = $('#bn-logout', root);
      if (lo) lo.onclick = () => { try { QFHooks.doLogout(); } catch (e2) {} };
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

/* api() 零侵入包装：所有调用自动过一遍信号采集 */
const apiInnerRaw = api;
api = async function (path, opts) {
  const res = await apiInnerRaw(path, opts);
  try { noteBanSignal(res, path); } catch (e) { /* 信号采集异常不得影响业务返回 */ }
  return res;
};
/* X-02：checkSession 单飞——240 秒定时器、60 秒心跳、BanLock 复查三路可并发，
   已在飞时直接复用同一份 promise，不再各开一条服务端 WS 校验；页面不可见时
   跳过本次校验（切回来由下一轮定时器补上），不在后台空打校验。 */
let checkFlight = null;
async function checkSession(silent, opts) {
  if (checkFlight) return checkFlight;
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden' && !(opts && opts.force)) return S.auth === 'in';
  checkFlight = QFHooks.checkSessionInner(silent, opts);
  try { return await checkFlight; }
  finally { checkFlight = null; }
}
/* 登录页偏好与账号保存（#39）：两个勾选框的状态跨登出、跨重启持久；
 * 「记住账号」勾选且登录成功才落盘账号（严-1：密码永不落盘，见 SavedCred），
 * 取消勾选再次登录即彻底清除。 */
const LoginPrefs = {
  load() { try { return JSON.parse(localStorage.getItem('qf-console-login-prefs') || 'null') || { rem: true, saveCred: false }; } catch (e) { return { rem: true, saveCred: false }; } },
  save(v) { try { localStorage.setItem('qf-console-login-prefs', JSON.stringify(v)); } catch (e) {} }
};
/* 严-1：只记账号、不存密码。登录是表单 POST（/qf-login）＋会话 cookie，
 * 本页不存在可替代密码的 token/刷新凭证机制，存 token 的方案无物可存；
 * 密码框每次留空由用户手输。旧版已落盘的 {u,p} 在 load() 时当场洗掉密码
 * 并改写回仅含账号的记录，不再留明文密码。 */
const SavedCred = {
  load() { try { const sc = JSON.parse(localStorage.getItem('qf-console-cred') || 'null'); if (!sc) return null; if (sc.p) { try { localStorage.setItem('qf-console-cred', JSON.stringify({ u: sc.u || '' })); } catch (e2) {} } return { u: sc.u || '' }; } catch (e) { return null; } },
  save(u) { try { localStorage.setItem('qf-console-cred', JSON.stringify({ u: u || '' })); } catch (e) {} },
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
      endsAt: obj.endsAt || null,
      category: typeof obj.category === 'string' ? obj.category.slice(0, 200) : ''
    };
  } catch (e) {
    // 数据缺失或损坏时也能画门，只是没有日期/类型可能偏封禁
    return { mode: 'banned', permanent: false, endsAt: null };
  }
}
async function heartbeat() {
  if (S.auth !== 'in') return;
  if (BanLock.active()) return;
  const gen = S.sessGen; // DS-R49：发起时捕获身份代数
  const r = await api('/points/api/heartbeat', { method: 'POST', json: { client: 'web-console-shadow' } });
  if (gen !== S.sessGen || S.auth !== 'in') return; // DS-R49＋DS-R24 B2：等待期间身份代数变化（含登出后快速重登）或已主动退出登录，迟到响应不再接管呈现、不写积分、不落强制下线（防误踢新会话）
  if (r.status === 200 && r.json) {
    if (r.json.forceLogout) { QFHooks.forceGate(r.json.gateCode || 'G1'); return; } // 批A-A5：按服务端下发 gateCode 落门，与 checkSession 同口径
    S.points = r.json; cacheSave();
    return;
  }
  if (r.status === 401) { QFHooks.sessionDied('heartbeat'); }
}
setInterval(heartbeat, 60000);                    // 在线计时/强制下线通道
setInterval(() => { if (S.auth === 'in' && !BanLock.active()) checkSession(true); }, 240000);
/* ============================================================
 * W-02/W-03/W-04/W-09/W-10/RC-04/RC-05（2026-11-15，全进 3.0）
 * 新增服务全部落在本文件（服务层），只依赖 qf-schema 与自身；
 * 应用壳（app.js）经 QFHooks / 直接调用接线；禁止引用 qf-ui / app.js。
 * ============================================================ */

/* ---------------- W-09：i18n ----------------
 * 文案进语言包（locales/zh-CN.json、locales/en.json），新代码用 t() 取文案。
 * 旧代码的硬编码中文保持原样（ grandfathered，基线见 tests/i18n-baseline.json，
 * lint 只许新代码零新增）。en 包拉取失败时回落中文，不报 key。 */
const QF_I18N_ZH = {
  'reconnect.attempt': '连接中断，正在重连（第 {n} 次 / 共 {max} 次）',
  'reconnect.cancel': '取消重连',
  'reconnect.restored': '已恢复连接',
  'reconnect.stoppedCredential': '凭据已失效，请重新登录。',
  'reconnect.exhausted': '重连失败，请点重试。',
  'reconnect.cancelled': '已取消自动重连，点重试可手动重连。',
  'relay.degraded': '中继全部不可用，已保留现有会话',
  'relay.unavailable': '中继服务暂不可用，请稍后重试',
  'quality.tier.smooth': '流畅',
  'quality.tier.balanced': '均衡',
  'quality.tier.clear': '清晰',
  'quality.tier.original': '原画',
  'quality.upgrade': '提升画质',
  'quality.upgraded': '已提升画质',
  'quality.atTop': '已是最高画质',
  'quality.notHealthy': '网络尚未持续健康 20 秒，暂不能升档',
  'quality.noHealthWindow': '健康样本不足，需要 20 秒健康样本',
  'quality.pingpong': '该档位近期反复升降，冷却中',
  'quality.autoDown': '网络较差，已自动降档',
  'files.resume': '断网后自动续传中…',
  'files.cancelled': '已取消发送',
  'files.corrupt': '校验失败，须重新发送',
  'files.auditTitle': '传输记录',
  'files.noAudit': '暂无传输记录',
  'files.auditCompleted': '完成',
  'files.auditFailed': '失败',
  'files.auditCancelled': '取消',
  'rec.title': '录像回放',
  'rec.noRecordings': '暂无录像',
  'rec.play': '播放',
  'rec.pause': '暂停',
  'rec.privacy': '本录像含操作记录',
  'rec.loading': '加载中…',
  'rec.interrupted': '录制已中断（服务端重启），本次录像不完整',
  'rec.policyOff': '当前会话不录制',
  'files.uploading': '正在上传（分片 {r}/{n}）…',
  'files.hashing': '正在计算校验值…',
  'files.checking': '正在校验拼装…'
};
let QF_I18N_TABLE = null;
let QF_I18N_LANG = 'zh-CN';
function t(key, vars) {
  let s = null;
  if (QF_I18N_TABLE && QF_I18N_TABLE[key] != null) s = QF_I18N_TABLE[key];
  else if (QF_I18N_ZH[key] != null) s = QF_I18N_ZH[key];
  else s = key;
  if (vars) { Object.keys(vars).forEach((k) => { s = String(s).split('{' + k + '}').join(String(vars[k])); }); }
  return s;
}
async function qfLoadLocale(lang) {
  const want = (lang === 'en') ? 'en' : 'zh-CN';
  try {
    const r = await fetch('locales/' + want + '.json', { credentials: 'include' });
    if (r && r.ok) { const j = await r.json(); QF_I18N_TABLE = j; QF_I18N_LANG = want; return true; }
  } catch (e) {}
  QF_I18N_TABLE = (want === 'en') ? null : QF_I18N_ZH;
  QF_I18N_LANG = 'zh-CN';
  return false;
}

/* ---------------- W-02：Transport 接口 ----------------
 * 抄 VS Code BrowserSocketFactory 思路：远程通道抽象成可替换的 transport，
 * connect/send/onMessage/重连/心跳收敛在这一层，UI 只订阅状态。
 * 注入点：opts.WebSocketCtor（测试用假 WS）、opts.scheduler（测试用手动时钟）。
 * 重连：固定间隔（默认 5s，RC-04 同款数字）、上限 5 次；耗尽后 state='failed'。
 * 断线期间的可靠发送先入队，重连成功后按序补发；易失发送不入队（见 QFBus）。 */
function QFTransport(url, opts) {
  opts = opts || {};
  const WS = opts.WebSocketCtor || (typeof WebSocket !== 'undefined' ? WebSocket : null);
  const sched = opts.scheduler || {
    setTimeout: (f, ms) => setTimeout(f, ms),
    clearTimeout: (id) => clearTimeout(id),
    now: () => Date.now()
  };
  const tr = {
    url: String(url || ''),
    state: 'idle', // idle | connecting | open | reconnecting | failed | closed
    autoReconnect: !!opts.autoReconnect,
    maxAttempts: (typeof opts.maxAttempts === 'number' ? opts.maxAttempts : 5),
    retryIntervalMs: (typeof opts.retryIntervalMs === 'number' ? opts.retryIntervalMs : 5000),
    attempts: 0,
    _ws: null, _timer: null, _queue: [], _handlers: [], _stateHandlers: [], _manualClose: false,
    onMessage(fn) { tr._handlers.push(fn); return () => { const i = tr._handlers.indexOf(fn); if (i >= 0) tr._handlers.splice(i, 1); }; },
    onState(fn) { tr._stateHandlers.push(fn); return () => { const i = tr._stateHandlers.indexOf(fn); if (i >= 0) tr._stateHandlers.splice(i, 1); }; },
    _setState(s) { tr.state = s; tr._stateHandlers.slice().forEach((f) => { try { f(s); } catch (e) {} }); },
    connect() {
      if (tr.state === 'open' || tr.state === 'connecting') return;
      if (!WS) { tr._setState('failed'); return; }
      tr._manualClose = false;
      tr._setState(tr.attempts > 0 ? 'reconnecting' : 'connecting');
      let ws;
      try { ws = new WS(tr.url); } catch (e) { tr._scheduleRetry(); return; }
      tr._ws = ws;
      ws.onopen = () => {
        tr.attempts = 0;
        tr._setState('open');
        tr._flush();
      };
      ws.onmessage = (ev) => {
        const data = ev && ev.data !== undefined ? ev.data : ev;
        tr._handlers.slice().forEach((f) => { try { f(data); } catch (e) {} });
      };
      ws.onerror = () => { /* onclose 统一处理重连，避免双算 */ };
      ws.onclose = () => {
        tr._ws = null;
        if (tr._manualClose) { tr._setState('closed'); return; }
        if (tr.autoReconnect) tr._scheduleRetry();
        else tr._setState('closed');
      };
    },
    _scheduleRetry() {
      if (tr.attempts >= tr.maxAttempts) { tr._setState('failed'); return; }
      tr.attempts++;
      tr._setState('reconnecting');
      tr._timer = sched.setTimeout(() => { tr._timer = null; tr.connect(); }, tr.retryIntervalMs);
    },
    _flush() {
      if (tr.state !== 'open' || !tr._ws) return;
      const q = tr._queue; tr._queue = [];
      q.forEach((s) => { try { tr._ws.send(s); } catch (e) { tr._queue.push(s); } });
    },
    send(data) {
      const s = (typeof data === 'string') ? data : JSON.stringify(data);
      if (tr.state === 'open' && tr._ws) { try { tr._ws.send(s); return 'sent'; } catch (e) {} }
      tr._queue.push(s);
      return 'queued';
    },
    queuedCount() { return tr._queue.length; },
    close() {
      tr._manualClose = true;
      if (tr._timer != null) { try { sched.clearTimeout(tr._timer); } catch (e) {} tr._timer = null; }
      if (tr._ws) { try { tr._ws.close(); } catch (e) {} tr._ws = null; }
      tr._setState('closed');
    }
  };
  return tr;
}

/* ---------------- W-02/W-03：频道式 pub/sub 总线 ----------------
 * 一条 WebSocket 分频道（device:{id}:status、chat:{id}、session:{id}:frame-meta、
 * presence:{id}，见 qf-schema.js 的 qfChannel）。服务端只广播，客户端按频道
 * 订阅/退订；断线重连后按频道重订阅并补一次快照（opts.onSnapshot(channels)）。
 * 双通道（抄 Excalidraw Portal）：可靠通道必达、可重放（带 msgId＋seq，断线
 * 入队、重连补发、收端按 msgId 去重）；易失通道可丢、100ms 节流、只留最新值。
 * 上行订阅消息默认不发（opts.sendSubscribe 为 true 时才发 {action:'subscribe'}，
 * 等服务端支持频道订阅后再开；当前 /control.ashx 仍是请求/应答式，见证据）。 */
function QFBus(transport, opts) {
  opts = opts || {};
  const sched = opts.scheduler || {
    setTimeout: (f, ms) => setTimeout(f, ms),
    clearTimeout: (id) => clearTimeout(id),
    now: () => Date.now()
  };
  const bus = {
    _subs: new Map(), // channel -> Set(fn)
    _seenMsgIds: new Set(),
    _seq: 0,
    _reliableQueue: [],
    _volatileLast: new Map(), // channel -> { data, at, pending, timer }
    subscribe(channel, fn) {
      if (!channel || typeof fn !== 'function') return () => {};
      if (!bus._subs.has(channel)) bus._subs.set(channel, new Set());
      bus._subs.get(channel).add(fn);
      return () => { bus.unsubscribe(channel, fn); };
    },
    unsubscribe(channel, fn) {
      const s = bus._subs.get(channel);
      if (!s) return;
      s.delete(fn);
      if (!s.size) bus._subs.delete(channel);
    },
    channels() { return Array.from(bus._subs.keys()); },
    _sendRaw(obj, isVolatile) {
      if (transport.state === 'open') { transport.send(obj); return 'sent'; }
      if (isVolatile) return 'dropped'; // 易失通道：断线即丢，不进可靠队列
      return 'queued';
    },
    publish(channel, data, o) {
      o = o || {};
      if (o.volatile) return bus._publishVolatile(channel, data);
      const msg = { channel, data, msgId: 'm-' + (++bus._seq) + '-' + sched.now(), seq: bus._seq };
      if (transport.state !== 'open') { bus._reliableQueue.push(msg); return 'queued'; }
      bus._sendRaw(msg);
      return 'sent';
    },
    _publishVolatile(channel, data) {
      const now = sched.now();
      const last = bus._volatileLast.get(channel);
      if (last && now - last.at < 100) {
        last.data = data; last.pending = true; // 只留最新，中间值丢弃
        if (!last.timer) {
          const wait = 100 - (now - last.at);
          last.timer = sched.setTimeout(() => {
            last.timer = null;
            if (last.pending) { last.pending = false; last.at = sched.now(); bus._sendRaw({ channel, data: last.data, volatile: true }, true); }
          }, wait);
        }
        return 'throttled';
      }
      bus._volatileLast.set(channel, { data, at: now, pending: false, timer: null });
      return bus._sendRaw({ channel, data, volatile: true }, true);
    },
    _flushReliable() {
      if (transport.state !== 'open') return;
      const q = bus._reliableQueue; bus._reliableQueue = [];
      q.forEach((m) => bus._sendRaw(m));
    },
    _onTransportMessage(raw) {
      let m = null;
      try { m = (typeof raw === 'string') ? JSON.parse(raw) : raw; } catch (e) { return; }
      if (!m || typeof m !== 'object' || !m.channel) return;
      if (m.msgId) {
        if (bus._seenMsgIds.has(m.msgId)) return; // 去重：重连补发不再复活
        bus._seenMsgIds.add(m.msgId);
        if (bus._seenMsgIds.size > 1000) { const first = bus._seenMsgIds.values().next().value; bus._seenMsgIds.delete(first); }
      }
      const subs = bus._subs.get(m.channel);
      if (!subs) return;
      subs.forEach((fn) => { try { fn(m.data, m); } catch (e) {} });
    },
    _onTransportOpen() {
      if (opts.sendSubscribe && bus.channels().length) {
        try { transport.send({ action: 'subscribe', channels: bus.channels() }); } catch (e) {}
      }
      bus._flushReliable();
      if (typeof opts.onSnapshot === 'function') {
        try { const r = opts.onSnapshot(bus.channels()); if (r && typeof r.catch === 'function') r.catch(() => {}); } catch (e) {}
      }
    }
  };
  transport.onMessage((raw) => bus._onTransportMessage(raw));
  transport.onState((s) => { if (s === 'open') bus._onTransportOpen(); });
  return bus;
}

/* ---------------- W-04：三层状态分域＋单一状态源 ----------------
 * 抄 tldraw 三层分域：docs（持久文档：设备列表、好友、聊天记录，须保存＋同步）、
 * session（会话态：当前路由、远程窗口位置，只留本实例）、presence（光标/在线
 * 状态/正在输入，只实时同步、永不落盘）。各页只读 store，不各自轮询。
 * docs 写操作带 version/versionNonce（见 reconcileRecords），并经 QFLocal 持久化
 * ＋跨标签页广播；presence 只放内存，setPresence 永不写盘。 */
const QFStore = {
  docs: { devices: [], friends: [], chat: {} },
  session: {},
  presence: {},
  _subs: [],
  subscribe(domain, key, fn) {
    const sub = { domain, key, fn };
    QFStore._subs.push(sub);
    return () => { const i = QFStore._subs.indexOf(sub); if (i >= 0) QFStore._subs.splice(i, 1); };
  },
  _emit(domain, key, value) {
    QFStore._subs.slice().forEach((s) => {
      if (s.domain === domain && (s.key === key || s.key === '*')) { try { s.fn(value, key); } catch (e) {} }
    });
  },
  setDoc(key, value, meta) {
    meta = meta || {};
    const prev = QFStore.docs[key];
    if (Array.isArray(value) && Array.isArray(prev) && value.length && value[0] && value[0].id !== undefined) {
      QFStore.docs[key] = reconcileRecords(prev, value, new Set());
    } else {
      QFStore.docs[key] = value;
    }
    QFStore._emit('docs', key, QFStore.docs[key]);
    const stamp = { value: QFStore.docs[key], updatedAt: (typeof meta.updatedAt === 'number' ? meta.updatedAt : Date.now()), tabId: QFLocal.tabId };
    try { const p = QFLocal.save('docs', key, stamp); if (p && typeof p.catch === 'function') p.catch(() => {}); } catch (e) {}
    try { QFLocal.broadcast('docs:' + key, stamp); } catch (e) {}
    return QFStore.docs[key];
  },
  seedDocs(obj) {
    if (!obj || typeof obj !== 'object') return;
    Object.keys(obj).forEach((k) => {
      if (k in QFStore.docs) { QFStore.docs[k] = obj[k]; QFStore._emit('docs', k, obj[k]); }
    });
  },
  setSession(key, value) { QFStore.session[key] = value; QFStore._emit('session', key, value); },
  setPresence(key, value) { QFStore.presence[key] = value; QFStore._emit('presence', key, value); }, // 永不落盘
  snapshot(domain) {
    const src = (domain === 'docs') ? QFStore.docs : (domain === 'session') ? QFStore.session : QFStore.presence;
    try { return JSON.parse(JSON.stringify(src)); } catch (e) { return src; }
  }
};

/* ---------------- W-10：本地优先 IndexedDB 持久化＋多标签页同步 ----------------
 * 抄 tldraw persistenceKey：登录态、设备列表快照、聊天草稿先写 IndexedDB，
 * 断网/刷新不丢，联网后再与服务端对账。库名 qfremote-web，表 docs/drafts/meta。
 * IndexedDB 不可用时回落内存＋localStorage 镜像（键 qf-idb-fallback:*），不断功能。
 * 多标签页：BroadcastChannel('qfremote-web')＋storage 事件双通道；新值以
 * qfIsNewer（updatedAt 大者胜，相等时 tabId 大者胜）判定，不互相覆盖。 */
const QFLocal = {
  DB: 'qfremote-web',
  VER: 1,
  tabId: 'tab-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36),
  _dbp: null, _mem: new Map(), _bc: null, _bcHandlers: [],
  open() {
    if (QFLocal._dbp) return QFLocal._dbp;
    QFLocal._dbp = new Promise((resolve) => {
      let idb = null;
      try { idb = (typeof window !== 'undefined' && window.indexedDB) ? window.indexedDB : (typeof indexedDB !== 'undefined' ? indexedDB : null); } catch (e) {}
      if (!idb) { resolve(null); return; }
      let rq;
      try { rq = idb.open(QFLocal.DB, QFLocal.VER); } catch (e) { resolve(null); return; }
      rq.onupgradeneeded = () => {
        try {
          const db = rq.result;
          if (!db.objectStoreNames.contains('docs')) db.createObjectStore('docs');
          if (!db.objectStoreNames.contains('drafts')) db.createObjectStore('drafts');
          if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
        } catch (e) {}
      };
      rq.onsuccess = () => resolve(rq.result);
      rq.onerror = () => resolve(null);
    });
    return QFLocal._dbp;
  },
  async save(store, key, value) {
    const db = await QFLocal.open();
    if (db) {
      return new Promise((resolve) => {
        try {
          const tx = db.transaction(store, 'readwrite');
          tx.objectStore(store).put(value, key);
          tx.oncomplete = () => resolve(true);
          tx.onerror = () => { QFLocal._mem.set(store + ':' + key, value); resolve(false); };
        } catch (e) { QFLocal._mem.set(store + ':' + key, value); resolve(false); }
      });
    }
    QFLocal._mem.set(store + ':' + key, value);
    try { localStorage.setItem('qf-idb-fallback:' + store + ':' + key, JSON.stringify(value)); } catch (e) {}
    return true;
  },
  async load(store, key) {
    const db = await QFLocal.open();
    if (db) {
      return new Promise((resolve) => {
        try {
          const tx = db.transaction(store, 'readonly');
          const rq = tx.objectStore(store).get(key);
          rq.onsuccess = () => resolve(rq.result !== undefined ? rq.result : null);
          rq.onerror = () => resolve(QFLocal._mem.has(store + ':' + key) ? QFLocal._mem.get(store + ':' + key) : null);
        } catch (e) { resolve(QFLocal._mem.has(store + ':' + key) ? QFLocal._mem.get(store + ':' + key) : null); }
      });
    }
    if (QFLocal._mem.has(store + ':' + key)) return QFLocal._mem.get(store + ':' + key);
    try {
      const s = localStorage.getItem('qf-idb-fallback:' + store + ':' + key);
      return s ? JSON.parse(s) : null;
    } catch (e) { return null; }
  },
  async del(store, key) {
    QFLocal._mem.delete(store + ':' + key);
    try { localStorage.removeItem('qf-idb-fallback:' + store + ':' + key); } catch (e) {}
    const db = await QFLocal.open();
    if (!db) return true;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(store, 'readwrite');
        tx.objectStore(store).delete(key);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      } catch (e) { resolve(false); }
    });
  },
  _ensureBC() {
    if (QFLocal._bc) return QFLocal._bc;
    try {
      if (typeof BroadcastChannel !== 'undefined') {
        QFLocal._bc = new BroadcastChannel('qfremote-web');
        QFLocal._bc.onmessage = (ev) => { QFLocal._deliver(ev && ev.data); };
      }
    } catch (e) { QFLocal._bc = null; }
    return QFLocal._bc;
  },
  _seenBc: null,
  _deliver(m) {
    if (!m || m.tabId === QFLocal.tabId) return;
    // 双通道（BroadcastChannel＋storage 事件）去重：同 type/tabId/at 只投递一次
    if (!QFLocal._seenBc) QFLocal._seenBc = new Set();
    const k = String(m.type) + '|' + String(m.tabId) + '|' + String(m.at);
    if (QFLocal._seenBc.has(k)) return;
    QFLocal._seenBc.add(k);
    if (QFLocal._seenBc.size > 200) { const first = QFLocal._seenBc.values().next().value; QFLocal._seenBc.delete(first); }
    QFLocal._bcHandlers.slice().forEach((f) => { try { f(m); } catch (e) {} });
  },
  broadcast(type, payload) {
    const msg = { type, payload, tabId: QFLocal.tabId, at: Date.now() };
    const bc = QFLocal._ensureBC();
    if (bc) { try { bc.postMessage(msg); } catch (e) {} }
    try { localStorage.setItem('qf-bc', JSON.stringify(msg)); } catch (e) {} // storage 事件兜底（同标签页不触发）
    return msg;
  },
  onBroadcast(fn) {
    QFLocal._ensureBC();
    QFLocal._bcHandlers.push(fn);
    if (typeof window !== 'undefined' && !QFLocal._storageHooked) {
      QFLocal._storageHooked = true;
      window.addEventListener('storage', (ev) => {
        if (ev.key !== 'qf-bc' || !ev.newValue) return;
        let m = null;
        try { m = JSON.parse(ev.newValue); } catch (e) { return; }
        QFLocal._deliver(m);
      });
    }
    return () => { const i = QFLocal._bcHandlers.indexOf(fn); if (i >= 0) QFLocal._bcHandlers.splice(i, 1); };
  }
};

/* ---------------- W-04：通知 ETag 条件轮询 ----------------
 * 抄 Nextcloud：先问服务端，再对状态接口做条件请求（304 即无变化），无变化
 * 时降频。/license/api/me 目前不一定回 ETag：有 ETag 即用 If-None-Match，
 * 无 ETag 则用关键字段指纹比对（activeBan/planName/displayStatus），指纹
 * 不变同样降频；变化时走 QFHooks.checkSessionInner 复核（已有 BanLock 逻辑
 * 接管，不在此处另起封禁判定）。只在已登录且页面可见时跑，底噪 120s 起。 */
const QFNotifier = {
  _timer: null, _etag: null, _fp: '', _intervalMs: 120000, _backoffMs: 300000,
  _inflight: false, _fetchFn: null,
  _fingerprint(j) {
    if (!j || typeof j !== 'object') return '';
    return JSON.stringify({ b: !!j.activeBan, p: j.planName || '', s: j.displayStatus || '', u: j.username || '' });
  },
  _schedule(ms) {
    QFNotifier.stop();
    try {
      QFNotifier._timer = setTimeout(() => { QFNotifier._timer = null; QFNotifier.pollOnce().catch(() => {}); }, ms);
    } catch (e) {}
  },
  start() { if (!QFNotifier._timer) QFNotifier._schedule(QFNotifier._intervalMs); },
  stop() { if (QFNotifier._timer != null) { try { clearTimeout(QFNotifier._timer); } catch (e) {} QFNotifier._timer = null; } },
  async pollOnce() {
    if (QFNotifier._inflight) return { status: 'busy' };
    /* F-07：未登录时也要排下一轮——旧写法直接 return，start() 只在 boot 调一次，
       用户先以未登录态打开页面、120 秒后首轮 poll 返回 skip，之后再登录（doLogin
       成功不重载页面），通知器永不再跑。 */
    if (S.auth !== 'in') { QFNotifier._schedule(QFNotifier._intervalMs); return { status: 'skip' }; }
    try { if (typeof document !== 'undefined' && document.visibilityState === 'hidden') { QFNotifier._schedule(QFNotifier._intervalMs); return { status: 'hidden' }; } } catch (e) {}
    QFNotifier._inflight = true;
    try {
      const headers = {};
      if (QFNotifier._etag) headers['If-None-Match'] = QFNotifier._etag;
      const fetchFn = QFNotifier._fetchFn || fetch;
      const r = await fetchFn('/license/api/me', { credentials: 'include', headers });
      if (r.status === 304) { QFNotifier._schedule(QFNotifier._backoffMs); return { status: 'not-modified' }; }
      if (r.status === 200) {
        let etag = null;
        try { etag = r.headers ? r.headers.get('ETag') : null; } catch (e) {}
        if (etag) QFNotifier._etag = etag;
        let j = null;
        try { j = await r.json(); } catch (e) {}
        const fp = QFNotifier._fingerprint(j);
        if (fp && fp === QFNotifier._fp) { QFNotifier._schedule(QFNotifier._backoffMs); return { status: 'unchanged' }; }
        QFNotifier._fp = fp;
        QFNotifier._schedule(QFNotifier._intervalMs);
        try { await QFHooks.checkSessionInner(true, { force: true }); } catch (e) {}
        return { status: 'changed' };
      }
      QFNotifier._schedule(QFNotifier._intervalMs);
      return { status: 'http-' + r.status };
    } catch (e) {
      QFNotifier._schedule(QFNotifier._intervalMs);
      return { status: 'error' };
    } finally { QFNotifier._inflight = false; }
  }
};

/* ---------------- RC-04：网页客户端断线重连（按 L1 规范 v1） ----------------
 * 规范：server/ext/lea/RC-04-RECONNECT-TICKET-SPEC.md（L1 出，2026-11-15）。
 * 两层：①协议层票据——会话建立成功后立即申领重连票据（POST
 * /api/lea/v1/reconnect/issue），只存内存；②客户端层重试循环——上限 5 次、
 * 间隔 ≥5 秒（固定 5 秒，不做指数退避，防拖过票据 300 秒窗口）、界面显示
 * “第 N 次／共 5 次”与取消按钮；重连期间输入短路丢弃（inputBlocked）。
 * 凭据/授权类失败（QFR_API_KEY_REVOKED 等 8 码，见 qfIsCredentialFailure）
 * 立即停重试；只有纯网络错误（超时/连接拒绝/502/503）才继续。5 次耗尽即停，
 * 界面给手动重试入口。服务端端点已在工作树实现（server/ext/lea/
 * lea-routes.js 的 handleReconnectIssue / handleReconnectResume，规范 §7），
 * 部署的服务端未加载该端点时 issue/resume 回 404，本模块记
 * endpointMissing 并走 legacy 重连路径，不发明票据格式、不伪造成功。 */
function QFReconnect(opts) {
  opts = opts || {};
  const fetchFn = opts.fetchFn || api;
  const sched = opts.scheduler || {
    setTimeout: (f, ms) => setTimeout(f, ms),
    clearTimeout: (id) => clearTimeout(id),
    now: () => Date.now()
  };
  const rc = {
    deviceId: String(opts.deviceId || ''),
    sessionId: String(opts.sessionId || qfNewSessionId()),
    ticket: null,
    endpointMissing: false,
    state: 'idle', // idle | reconnecting | restored | stopped
    attempts: 0,
    maxAttempts: 5,
    intervalMs: 5000,
    inputBlocked: false,
    lastError: '',
    stopReason: '',
    _timer: null,
    _stopped: false,
    _handlers: {},
    _codeOf(r) {
      if (!r) return '';
      if (r.json && typeof r.json === 'object') return String(r.json.code || r.json.error || '');
      return '';
    },
    async issue() {
      let r;
      try {
        r = await fetchFn('/api/lea/v1/reconnect/issue', { method: 'POST', json: { device_id: rc.deviceId, session_id: rc.sessionId } });
      } catch (e) { return null; }
      if (!r) return null;
      if (r.status === 404) { rc.endpointMissing = true; rc.ticket = null; return null; }
      if (r.status === 200 && r.json) {
        const v = validateReconnectTicket(r.json);
        if (v.ok) { rc.ticket = r.json; rc.endpointMissing = false; return rc.ticket; }
        rc.lastError = 'QFR_TICKET_INVALID';
        return null;
      }
      const code = rc._codeOf(r);
      if (qfIsCredentialFailure(code)) rc.lastError = code;
      return null;
    },
    async resume() {
      if (!rc.ticket) return { ok: false, code: 'QFR_TICKET_INVALID', reason: 'no-ticket' };
      let r;
      try {
        r = await fetchFn('/api/lea/v1/reconnect/resume', { method: 'POST', json: rc.ticket });
      } catch (e) {
        return { ok: false, code: 'NETWORK', network: true };
      }
      if (!r) return { ok: false, code: 'NETWORK', network: true };
      if (r.status === 200 && r.json && r.json.ok) {
        rc.ticket = null; // 单次性：验过即消费，客户端同样丢弃
        return { ok: true };
      }
      if (r.status === 404) { rc.endpointMissing = true; return { ok: false, code: 'QFR_TICKET_INVALID', reason: 'endpoint-missing', endpointMissing: true }; }
      const code = rc._codeOf(r) || ('HTTP_' + r.status);
      const network = (r.status === 0 || r.status === 502 || r.status === 503 || !!r.networkError);
      return { ok: false, code, credential: qfIsCredentialFailure(code), network };
    },
    start(handlers) {
      rc._handlers = handlers || {};
      rc._stopped = false;
      rc.state = 'reconnecting';
      rc.inputBlocked = true; // 重连期间所有输入事件短路丢弃，不缓存、不补发
      rc.attempts = 0;
      rc._tick();
      return rc;
    },
    async _tick() {
      if (rc._stopped) return;
      rc.attempts++;
      try { if (typeof rc._handlers.onAttempt === 'function') rc._handlers.onAttempt(rc.attempts, rc.maxAttempts); } catch (e) {}
      let restored = false;
      if (rc.ticket) {
        const res = await rc.resume();
        if (rc._stopped) return;
        if (res.ok) restored = true;
        else if (res.credential) { rc.stop('credential', res.code); return; }
        else if (res.endpointMissing) { rc.ticket = null; /* 端点未实现：落到 legacy 路径 */ }
        // 纯网络失败：继续走 legacy 尝试（同一计次内不另算一次）
      }
      if (!restored) {
        let legacyOk = false;
        try {
          const v = (typeof rc._handlers.onLegacyAttempt === 'function') ? rc._handlers.onLegacyAttempt() : false;
          legacyOk = (v && typeof v.then === 'function') ? await v : !!v;
        } catch (e) { legacyOk = false; }
        if (rc._stopped) return;
        if (legacyOk && typeof rc._handlers.onLegacyOk === 'function') {
          let done = false;
          try { done = !!rc._handlers.onLegacyOk(); } catch (e) {}
          if (done) restored = true;
        }
      }
      if (restored) { rc._restored(); return; }
      if (rc.attempts >= rc.maxAttempts) { rc.stop('exhausted', ''); return; }
      rc._timer = sched.setTimeout(() => { rc._timer = null; rc._tick(); }, rc.intervalMs);
    },
    _restored() {
      rc.state = 'restored';
      rc.inputBlocked = false;
      try { if (typeof rc._handlers.onRestored === 'function') rc._handlers.onRestored(); } catch (e) {}
    },
    stop(reason, code) {
      if (rc._timer != null) { try { sched.clearTimeout(rc._timer); } catch (e) {} rc._timer = null; }
      rc._stopped = true;
      rc.state = 'stopped';
      rc.inputBlocked = false;
      rc.stopReason = String(reason || '');
      if (code) rc.lastError = String(code);
      try { if (typeof rc._handlers.onStop === 'function') rc._handlers.onStop(rc.stopReason, rc.lastError); } catch (e) {}
      return rc;
    },
    cancel() { return rc.stop('cancelled', ''); }
  };
  return rc;
}

/* ---------------- S-075：连接状态机（纯逻辑，可单测） ----------------
 * 状态：CONNECTING → TRANSPORT_READY → REMOTE_AUTHENTICATED →
 *   VIDEO_FIRST_FRAME → INPUT_READY → HEALTHY。
 * 信号来自 app.js 哨兵每 tick 的 probeFrame() 结果与引擎对象在位情况：
 *  - 'binding'：帧已加载目标文档，传输通道就绪（TRANSPORT_READY）。
 *  - 'videopending'/'connected'：deskstatus 已出 Connected 文本，远端已认证
 *    （REMOTE_AUTHENTICATED）；'connected' 另含画布有尺寸（VIDEO_FIRST_FRAME）。
 *  - 引擎桌面/终端/文件会话对象在位且 currentNode 是本台（input 通道前提），
 *    且 'connected' 再稳定一个观测周期 → INPUT_READY → HEALTHY。
 * 每段有独立 timeout 与诊断码（与 app.js W-02 阶段阶梯同预算、同码）：
 *  CONNECTING 8s / TRANSPORT_READY 12s / REMOTE_AUTHENTICATED 15s /
 *  VIDEO_FIRST_FRAME 25s / INPUT_READY 20s（新码 TIMEOUT_INPUT_READY）。
 * 状态机只做转移与超时判定，不碰 DOM、不碰网络：超时落点仍走 app.js 的
 * failStage/showSessionMask；只有 HEALTHY 才许 setConnected 显「已连接」
 * （video 首帧＋input 通道双达标，不假绿）。 */
const QF_SESSION_SM_STATES = ['CONNECTING', 'TRANSPORT_READY', 'REMOTE_AUTHENTICATED', 'VIDEO_FIRST_FRAME', 'INPUT_READY', 'HEALTHY'];
const QF_SESSION_SM_TIMEOUTS = { CONNECTING: 8000, TRANSPORT_READY: 12000, REMOTE_AUTHENTICATED: 15000, VIDEO_FIRST_FRAME: 25000, INPUT_READY: 20000 };
const QF_SESSION_SM_CODES = { CONNECTING: 'TIMEOUT_IFRAME_LOAD', TRANSPORT_READY: 'TIMEOUT_IFRAME_LOAD', REMOTE_AUTHENTICATED: 'TIMEOUT_WEBAPP_READY', VIDEO_FIRST_FRAME: 'TIMEOUT_PEER_CONNECTING', INPUT_READY: 'TIMEOUT_INPUT_READY' };
/* app.js 阶段名映射（failStage/showSessionMask 用）：SM 态 → 会话 stage 名。 */
const QF_SESSION_SM_STAGE_NAMES = { CONNECTING: 'iframe-attach', TRANSPORT_READY: 'iframe-load', REMOTE_AUTHENTICATED: 'webapp-ready', VIDEO_FIRST_FRAME: 'peer-connecting', INPUT_READY: 'input-ready', HEALTHY: 'video-ready' };
function QFSessionSM(opts) {
  opts = opts || {};
  const sm = {
    state: 'CONNECTING',
    enteredAt: (typeof opts.now === 'number' ? opts.now : 0),
    _stableConnected: 0, // 'connected' 连续观测次数（INPUT_READY→HEALTHY 须 ≥2）
    _move(next, nowMs) { sm.state = next; sm.enteredAt = nowMs; sm._stableConnected = 0; },
    reset(nowMs) { sm.state = 'CONNECTING'; sm.enteredAt = nowMs; sm._stableConnected = 0; return sm; },
    /* observe(probe, engine, nowMs)：probe 是 probeFrame() 返回值；
     * engine = { inputReady }（引擎会话对象在位且 currentNode 是本台）。
     * 返回 { healthy: true } 或 null（无事）。 */
    observe(probe, engine, nowMs) {
      const now = (typeof nowMs === 'number' ? nowMs : 0);
      const inputReady = !!(engine && engine.inputReady);
      if (sm.state === 'HEALTHY') return { healthy: true };
      // 强信号可连跳：'connected' 本身即含传输就绪＋远端认证＋首帧三重证据。
      if (probe === 'connected') {
        if (sm.state === 'CONNECTING' || sm.state === 'TRANSPORT_READY' || sm.state === 'REMOTE_AUTHENTICATED' || sm.state === 'VIDEO_FIRST_FRAME') sm._move('VIDEO_FIRST_FRAME', now);
        if (sm.state === 'VIDEO_FIRST_FRAME' && inputReady) sm._move('INPUT_READY', now);
        if (sm.state === 'INPUT_READY') {
          sm._stableConnected++;
          if (sm._stableConnected >= 2) { sm._move('HEALTHY', now); return { healthy: true }; }
        }
        return null;
      }
      if (probe === 'videopending') {
        if (sm.state === 'CONNECTING') sm._move('TRANSPORT_READY', now);
        if (sm.state === 'TRANSPORT_READY') sm._move('REMOTE_AUTHENTICATED', now);
        return null;
      }
      if (probe === 'binding') {
        if (sm.state === 'CONNECTING') sm._move('TRANSPORT_READY', now);
        return null;
      }
      return null; // 'blank'/'lost'/'reject'：不前进，超时与终态由哨兵现有逻辑处理
    },
    /* checkTimeout(nowMs)：本段超时即回 { failed: { code, state } }，否则 null。 */
    checkTimeout(nowMs) {
      if (sm.state === 'HEALTHY') return null;
      const budget = QF_SESSION_SM_TIMEOUTS[sm.state];
      if (typeof budget !== 'number') return null;
      if (nowMs - sm.enteredAt > budget) return { failed: { code: QF_SESSION_SM_CODES[sm.state], state: sm.state } };
      return null;
    }
  };
  return sm;
}

/* ---------------- RC-05：网页端渲染（抄 noVNC） ----------------
 * 后备缓冲＋脏矩形＋绘制队列：所有绘制先落一块隐藏后备 Canvas，present 时
 * 只把脏区贴到可见 Canvas；脏矩形合并（并集超 60% 面积即坍为全屏）；绘制任
 * 务排队保证顺序。画面本身仍在上游 MeshCentral iframe 内渲染（L5 设计确认：
 * 采集/编码/中继/网页桌面渲染全在树外），本渲染器是网页端自有的绘制层，
 * 供会话覆盖层/回放器等自绘面使用，不谎称已接管引擎帧。
 * 鼠标 17ms 节流（抄 noVNC MOUSE_MOVE_DELAY=17）：高频 mousemove 只记最后
 * 位置，每 17ms 最多发一次（QFMouseThrottle）。 */
function QFMouseThrottle(opts) {
  opts = opts || {};
  const intervalMs = (typeof opts.intervalMs === 'number' ? opts.intervalMs : 17);
  const sched = opts.scheduler || null;
  const now = sched ? (() => sched.now()) : (() => Date.now());
  const setT = sched ? ((f, ms) => sched.setTimeout(f, ms)) : ((f, ms) => setTimeout(f, ms));
  const clearT = sched ? ((id) => sched.clearTimeout(id)) : ((id) => clearTimeout(id));
  const send = (typeof opts.send === 'function') ? opts.send : (() => {});
  const th = {
    intervalMs,
    lastSentAt: 0, lastX: 0, lastY: 0, pending: false,
    sent: 0, dropped: 0, _timer: null,
    record(x, y) {
      th.lastX = x; th.lastY = y;
      if (now() - th.lastSentAt >= intervalMs) { th._flush(); return 'sent'; }
      th.dropped++;
      if (!th.pending) {
        th.pending = true;
        const wait = intervalMs - (now() - th.lastSentAt);
        th._timer = setT(() => { th._timer = null; th._flush(); }, Math.max(0, wait));
      }
      return 'throttled';
    },
    _flush() {
      if (th._timer != null) { try { clearT(th._timer); } catch (e) {} th._timer = null; }
      th.pending = false;
      th.lastSentAt = now();
      th.sent++;
      try { send(th.lastX, th.lastY); } catch (e) {}
    },
    reset() { if (th._timer != null) { try { clearT(th._timer); } catch (e) {} th._timer = null; } th.lastSentAt = 0; th.pending = false; th.sent = 0; th.dropped = 0; }
  };
  return th;
}
function QFRemoteRenderer(visible, opts) {
  opts = opts || {};
  const createCanvas = opts.createCanvas || (() => document.createElement('canvas'));
  const back = createCanvas();
  const r = {
    width: 0, height: 0,
    _dirty: [], // {x,y,w,h}
    _queue: [],
    stats: { queuedOps: 0, flushedOps: 0, presentedRects: 0, presentedArea: 0, collapsedFull: 0 },
    resize(w, h) {
      r.width = w; r.height = h;
      back.width = w; back.height = h;
      if (visible) { visible.width = w; visible.height = h; }
      r._dirty = [];
      return r;
    },
    _ctx() { return back.getContext('2d'); },
    _mark(x, y, w, h) {
      x = Math.max(0, Math.floor(x)); y = Math.max(0, Math.floor(y));
      w = Math.min(r.width - x, Math.ceil(w)); h = Math.min(r.height - y, Math.ceil(h));
      if (w <= 0 || h <= 0) return;
      let rect = { x, y, w, h };
      const rest = [];
      r._dirty.forEach((d) => {
        const overlap = !(rect.x + rect.w <= d.x || d.x + d.w <= rect.x || rect.y + rect.h <= d.y || d.y + d.h <= rect.y);
        const touch = (rect.x + rect.w === d.x || d.x + d.w === rect.x || rect.y + rect.h === d.y || d.y + d.h === rect.y);
        if (overlap || touch) {
          const x0 = Math.min(rect.x, d.x), y0 = Math.min(rect.y, d.y);
          const x1 = Math.max(rect.x + rect.w, d.x + d.w), y1 = Math.max(rect.y + rect.h, d.y + d.h);
          rect = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
        } else rest.push(d);
      });
      rest.push(rect);
      r._dirty = rest;
      const area = r._dirty.reduce((a, d) => a + d.w * d.h, 0);
      if (r.width > 0 && r.height > 0 && area > 0.6 * r.width * r.height) {
        r._dirty = [{ x: 0, y: 0, w: r.width, h: r.height }];
        r.stats.collapsedFull++;
      }
    },
    blit(src, sx, sy, w, h, dx, dy) { r._queue.push({ kind: 'blit', src, sx, sy, w, h, dx, dy }); r.stats.queuedOps++; r._mark(dx, dy, w, h); return r; },
    fillRect(x, y, w, h, color) { r._queue.push({ kind: 'fill', x, y, w, h, color }); r.stats.queuedOps++; r._mark(x, y, w, h); return r; },
    flush() {
      const ctx = r._ctx();
      let n = 0;
      while (r._queue.length) {
        const op = r._queue.shift();
        n++;
        try {
          if (op.kind === 'blit') { ctx.drawImage(op.src, op.sx, op.sy, op.w, op.h, op.dx, op.dy, op.w, op.h); }
          else if (op.kind === 'fill') { if (op.color) ctx.fillStyle = op.color; ctx.fillRect(op.x, op.y, op.w, op.h); }
        } catch (e) {}
      }
      r.stats.flushedOps += n;
      return n;
    },
    present() {
      r.flush();
      const rects = r._dirty.slice();
      r._dirty = [];
      let area = 0;
      if (visible && rects.length) {
        const vctx = visible.getContext('2d');
        rects.forEach((d) => {
          try { vctx.drawImage(back, d.x, d.y, d.w, d.h, d.x, d.y, d.w, d.h); } catch (e) {}
          area += d.w * d.h;
        });
      }
      r.stats.presentedRects += rects.length;
      r.stats.presentedArea += area;
      return { rects: rects.length, area };
    },
    dirtyCount() { return r._dirty.length; }
  };
  return r;
}

/* ---------------- W-04：首屏 boot data 消费 ----------------
 * 服务端在 index.html 里一次性下发用户、设备列表、在线状态、主题偏好
 * （window.__QF_BOOT__，抄 Grafana boot data＋Nextcloud initial-state），
 * 前端不再多轮请求才渲染。注入点在服务端渲染 index.html 的一侧（nginx 静
 * 态根目录 /opt/qfremote-webapp，目前为纯静态文件，注入须由发版/部署线加
 * 渲染步；本函数是客户端消费端，无注入时返回 null、原有缓存＋校验流程不变）。
 * 只播种 store 与 S 的展示字段，不改 S.auth（登录态仍由 checkSession 校验）。 */
function qfApplyBootData() {
  let b = null;
  try { b = (typeof window !== 'undefined' && window.__QF_BOOT__) || null; } catch (e) {}
  if (!b || typeof b !== 'object') return null;
  try {
    if (b.user) {
      S.user = b.user;
      if (b.displayName) S.displayName = b.displayName;
      if (typeof b.isAdmin === 'boolean') S.isAdmin = b.isAdmin;
    }
    if (b.license) S.license = b.license;
    if (b.theme === 'dark' || b.theme === 'light') applyTheme(b.theme);
    if (Array.isArray(b.devices)) QFStore.seedDocs({ devices: b.devices });
    if (b.presence && typeof b.presence === 'object') {
      Object.keys(b.presence).forEach((k) => QFStore.setPresence(k, b.presence[k]));
    }
  } catch (e) {}
  return b;
}

/* ================= L5 客户端服务（RC-03/RC-07/RC-08/RC-09/RC-10） ================
 * 依据 server/ext/ 下五份 QF-*-1-CLIENT-SPEC.md v1。所有服务只用注入的
 * fetchFn（默认全局 fetch，credentials:include 走控制台会话鉴权），
 * 未加载 L5 模块时服务端回 503 { code:'L5_UNAVAILABLE' }，如实透传、不编造。
 * 服务只返回码与数据，不写中文文案（W-09 lint：本文件中文字符串字面量
 * 只许减不许增）；界面文案由调用方经 t() 取语言包。 */

/* ---- RC-07 QF-RELAY-1：宣告列表＋三级回退客户端 ---- */
function QFRelayClient(opts) {
  const o = opts || {};
  const sched = o.scheduler || { setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (t) => clearTimeout(t), now: () => Date.now() };
  const fetchFn = o.fetchFn || (typeof fetch !== 'undefined' ? fetch : null);
  const client = {
    list: null, fetchedAt: 0, failedIds: new Set(), inFlightByTier: { 1: 0, 2: 0, 3: 0 },
    diag: [], // 本地诊断日志：只记 URL 与时间，不记密钥/会话口令（规范 §3）
    _diag(url) {
      client.diag.push({ at: sched.now(), url: String(url || '') });
      if (client.diag.length > 50) client.diag.shift();
    },
    /* 取宣告列表：未过期即用缓存；过期重取。返回 { ok, relays } 或 { ok:false, code }。 */
    async fetchList(force) {
      if (!force && client.list && !qfRelayListExpired(client.list, sched.now())) return { ok: true, relays: client.list };
      if (!fetchFn) return { ok: false, code: 'NO_FETCH' };
      let res;
      try { res = await fetchFn('/license/api/relays', { credentials: 'include' }); }
      catch (e) { return { ok: false, code: 'NETWORK_ERROR' }; }
      if (!res) return { ok: false, code: 'NETWORK_ERROR' };
      if (res.status === 503) return { ok: false, code: 'L5_UNAVAILABLE' };
      let j = null;
      try { j = await res.json(); } catch (e) { return { ok: false, code: 'BAD_RESPONSE' }; }
      if (!j || j.ok !== true || !Array.isArray(j.relays)) return { ok: false, code: 'BAD_RESPONSE' };
      client.list = j.relays;
      client.fetchedAt = sched.now();
      return { ok: true, relays: client.list };
    },
    /* 按宣告列表选址：循环 pick → 校验待拨 URL → 同源检查；伪造/异源地址
     * 拒绝拨号（记诊断日志、不发任何建连包），该条记 failedIds 再选下一条；
     * 三级耗尽返回 degraded。dialUrlFor(entry) 返回该条中继对应的待拨完整 URL。 */
    pickFor(dialUrlFor) {
      if (!client.list || !client.list.length) return { ok: false, code: 'NO_RELAYS', degraded: true, reason: 'all-tiers-exhausted' };
      const inFlight = { 1: client.inFlightByTier[1], 2: client.inFlightByTier[2], 3: client.inFlightByTier[3] };
      for (let n = 0; n < QF_RELAY_MAX_RELAYS + 1; n++) {
        const pick = qfPickRelay(client.list, Array.from(client.failedIds), { inFlightByTier: inFlight });
        if (!pick.relay) return { ok: false, code: 'DEGRADED', degraded: true, reason: pick.reason };
        const entry = pick.relay;
        const dialUrl = (typeof dialUrlFor === 'function') ? dialUrlFor(entry) : null;
        // 伪造中继（待拨 URL 不在宣告列表内）拒绝拨号：记诊断、不发包，
        // 该条记失败后继续选下一条列表内中继（规范 §3.4）。
        if (!dialUrl || !qfIsAllowedRelay(dialUrl, client.list)) {
          client._diag(dialUrl);
          client.failedIds.add(String(entry.id));
          continue;
        }
        // 网页端 iframe 挂同源 /console-engine/：异源中继无法在同源框内复用
        // 控制台会话，视为该条不可用，继续选下一条（不算拨号失败，不发包）。
        const entryOrigin = qfRelayNormalizeUrl(entry.url);
        const dialOrigin = qfRelayNormalizeUrl(dialUrl);
        if (!entryOrigin || !dialOrigin || entryOrigin.origin !== dialOrigin.origin) {
          client.failedIds.add(String(entry.id));
          continue;
        }
        client.inFlightByTier[entry.tier] = (client.inFlightByTier[entry.tier] || 0) + 1;
        return { ok: true, relay: entry, tier: entry.tier, reason: pick.reason, dialUrl };
      }
      return { ok: false, code: 'DEGRADED', degraded: true, reason: 'all-tiers-exhausted' };
    },
    /* 建连结果回填：在途计数 -1；失败则 id 进 failedIds（同一会话内不再试）。 */
    settle(relay, ok) {
      if (!relay) return;
      const tier = relay.tier;
      if (client.inFlightByTier[tier] > 0) client.inFlightByTier[tier]--;
      if (!ok) client.failedIds.add(String(relay.id));
    },
    /* 降级态重试入口：清空 failedIds、重新取宣告列表（规范 §2.3）。 */
    async retry() {
      client.failedIds.clear();
      client.inFlightByTier = { 1: 0, 2: 0, 3: 0 };
      return client.fetchList(true);
    },
  };
  return client;
}

/* ---- RC-03 QF-VIDEO-1：IDR 请求发送器 ---- */
const QF_IDR_REASONS = ['loss', 'join', 'quality-change'];
function QFIdrRequester(opts) {
  const o = opts || {};
  const fetchFn = o.fetchFn || (typeof fetch !== 'undefined' ? fetch : null);
  const nowFn = (o.scheduler && o.scheduler.now) || (() => Date.now());
  const req = {
    seq: 0, // 每会话从 1 单调递增；每次发送加 1（放行/合并/拒绝都消费 seq，规范 §2.4）
    cooldownUntil: 0, // COOLDOWN 响应带的 retryAfterMs 落地：冷却结束前不再发
    bindAt: 0, // 首次绑定时刻（join 宽限：绑定后 10s 内首次 join 不占令牌桶）
    _lastReason: '',
    /* 发一次 IDR 请求。返回 { decision, code, retryAfterMs }；
     * coalesced/rejected 后调用方不得补发、不换 reason 重发（规范 §3.6）；
     * 网络错误返回 { decision:'network-error', code:'NETWORK_ERROR' }。 */
    async request(sessionId, agentId, reason) {
      if (QF_IDR_REASONS.indexOf(reason) < 0) return { decision: 'rejected', code: 'BAD_REASON' };
      if (!sessionId || !agentId) return { decision: 'rejected', code: 'NO_SESSION' };
      const now = nowFn();
      if (req.cooldownUntil > now) return { decision: 'rejected', code: 'COOLDOWN', retryAfterMs: req.cooldownUntil - now };
      if (!fetchFn) return { decision: 'network-error', code: 'NETWORK_ERROR' };
      req.seq += 1;
      let res;
      try {
        res = await fetchFn('/license/api/session/idr-request', {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId, agentId, seq: req.seq, reason }),
        });
      } catch (e) { return { decision: 'network-error', code: 'NETWORK_ERROR' }; }
      if (!res) return { decision: 'network-error', code: 'NETWORK_ERROR' };
      if (res.status === 503) return { decision: 'rejected', code: 'L5_UNAVAILABLE' };
      let j = null;
      try { j = await res.json(); } catch (e) { return { decision: 'network-error', code: 'BAD_RESPONSE' }; }
      if (!j || typeof j !== 'object') return { decision: 'network-error', code: 'BAD_RESPONSE' };
      if (j.decision === 'forward' && !req.bindAt) req.bindAt = now;
      if (j.code === 'COOLDOWN' && Number.isFinite(Number(j.retryAfterMs))) {
        req.cooldownUntil = now + Number(j.retryAfterMs);
      }
      // REPLAY：本地 seq 已是单调递增（每次发送加 1）；多观看端共用同一
      // sessionId 时须由会话主持端统一发号（规范 §2.4），单观看端不会命中。
      return { decision: j.decision || 'rejected', code: j.code || '', retryAfterMs: j.retryAfterMs };
    },
  };
  return req;
}

/* ---- RC-03 QF-VIDEO-1：解码端 FEC 接收器 ----
 * 收包归位（blockId/symbolIndex）→ 块头校验 → 超时窗口判定（RTT+jitter+1 帧，
 * 30fps 下 1 帧约 33ms；窗口内等迟到分片，不一丢即请求）→ 0 缺失直接渲染、
 * 1..m 缺失走 RS 还原、超 m 判不可恢复并触发一次受控 IDR（reason=loss）。
 * 注意：线上传输的二进制打包格式待 agent 线定版（规范 §1.3 未定项），本
 * 接收器以逻辑分片（header 对象＋Uint8Array）为入口；真实分片到达通道
 * （上游帧流）在树外，待捕获埋点落地后接线，不得自创打包格式。 */
function QFFecReceiver(opts) {
  const o = opts || {};
  const sched = o.scheduler || { setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (t) => clearTimeout(t), now: () => Date.now() };
  const onFrame = typeof o.onFrame === 'function' ? o.onFrame : function () {};
  const onUnrecoverable = typeof o.onUnrecoverable === 'function' ? o.onUnrecoverable : function () {};
  const frameMs = 33; // 30fps 下 1 帧时长
  const recv = {
    blocks: new Map(), // blockId -> { header, shards: Map(symbolIndex->Uint8Array), timer, firstAt }
    settled: new Map(), // S-058：已结算块 id -> 结算时刻（ms）。结算后迟到的分片直接
    // 丢弃，不建新块——否则僵尸块在窗口届满后按缺失数误报 onUnrecoverable
    // （已交付帧重复告警，可能触发多余 IDR）。条目按时间剪除， horizon
    // 内 blockId 不复用是本机制的前提（分片到达通道定版后复核）。
    rttMs: 0, jitterMs: 0,
    stats: { frames: 0, recovered: 0, unrecoverable: 0, droppedBadHeader: 0, droppedLateShard: 0 },
    setNetwork(rttMs, jitterMs) { recv.rttMs = rttMs || 0; recv.jitterMs = jitterMs || 0; },
    /* 判定窗口：RTT + jitter + 1 帧时长（规范 §3.3）。 */
    windowMs() { return (recv.rttMs || 0) + (recv.jitterMs || 0) + frameMs; },
    /* 已结算块保留 horizon：窗口 2 倍与 10 秒取大，过期条目在 ingest 时剪除。 */
    _settledHorizonMs() { return Math.max(10000, recv.windowMs() * 2); },
    _pruneSettled(now) {
      const horizon = recv._settledHorizonMs();
      if (recv.settled.size <= 512) return;
      for (const [id, at] of recv.settled) { if (now - at > horizon) recv.settled.delete(id); }
    },
    /* 入口：header 为块头对象（规范 §1.3 字段），bytes 为本分片字节。 */
    ingest(header, bytes) {
      const v = qfValidateFecHeader(header);
      if (!v.ok) { recv.stats.droppedBadHeader++; return { ok: false, code: 'BAD_HEADER', reason: v.reason }; }
      if (!(bytes instanceof Uint8Array)) return { ok: false, code: 'BAD_SHARD' };
      const k = header.k, m = header.m;
      if (recv.settled.has(header.blockId)) {
        // S-058：该块已结算（已交付或已判不可恢复），迟到分片直接丢弃。
        recv.stats.droppedLateShard++;
        recv._pruneSettled(sched.now());
        return { ok: false, code: 'LATE_SHARD', reason: 'settled' };
      }
      let blk = recv.blocks.get(header.blockId);
      if (!blk) {
        blk = { header, shards: new Map(), timer: null, firstAt: sched.now() };
        recv.blocks.set(header.blockId, blk);
        // 窗口届满仍未齐：按当时缺失数判定（等迟到分片，不一丢即请求）。
        blk.timer = sched.setTimeout(() => { recv._settle(header.blockId, true); }, recv.windowMs());
      }
      blk.shards.set(header.symbolIndex, bytes);
      if (blk.shards.size >= header.symbolCount) recv._settle(header.blockId, false);
      return { ok: true };
    },
    _settle(blockId, timedOut) {
      const blk = recv.blocks.get(blockId);
      if (!blk) return;
      if (blk.timer) { sched.clearTimeout(blk.timer); blk.timer = null; }
      recv.blocks.delete(blockId);
      recv.settled.set(blockId, sched.now()); // S-058：结算即登记，此后同 id 分片一律丢弃
      recv._pruneSettled(sched.now());
      const h = blk.header, k = h.k, m = h.m;
      const shards = [];
      for (let i = 0; i < k + m; i++) shards.push(blk.shards.get(i) || null);
      const missing = shards.slice(0, k).filter((s) => !s).length;
      const lengths = [];
      for (let i = 0; i < k; i++) lengths.push(i === k - 1 ? h.symbolLength - h.lastSymbolPadding : h.symbolLength);
      if (missing === 0) {
        recv.stats.frames++;
        onFrame(shards.slice(0, k).map((b, i) => b.slice(0, lengths[i])), h);
        return;
      }
      if (missing > m) {
        recv.stats.unrecoverable++;
        onUnrecoverable(h.frameId, h);
        return;
      }
      let recovered = null;
      try { recovered = qfRsDecode(shards, k, m, lengths); } catch (e) { recovered = null; }
      if (!recovered) {
        recv.stats.unrecoverable++;
        onUnrecoverable(h.frameId, h);
        return;
      }
      recv.stats.frames++;
      recv.stats.recovered++;
      onFrame(recovered, h);
    },
    /* 关键帧到达后清旧参考帧（规范 §3.7）：丢弃此前未结算的旧块。 */
    resetOnKeyframe() {
      recv.blocks.forEach((blk) => { if (blk.timer) sched.clearTimeout(blk.timer); });
      recv.blocks.clear();
    },
    stop() { recv.resetOnKeyframe(); },
  };
  return recv;
}

/* ---- RC-09 QF-QUALITY-1：画质探针＋档位执行＋ACK ---- */
function QFQualityProbe(opts) {
  const o = opts || {};
  const sched = o.scheduler || {
    setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (t) => clearTimeout(t),
    setInterval: (f, ms) => setInterval(f, ms), clearInterval: (t) => clearInterval(t),
    now: () => Date.now(),
  };
  const fetchFn = o.fetchFn || (typeof fetch !== 'undefined' ? fetch : null);
  const collect = typeof o.collect === 'function' ? o.collect : function () { return null; };
  const onTierChange = typeof o.onTierChange === 'function' ? o.onTierChange : function () {};
  const onBackpressure = typeof o.onBackpressure === 'function' ? o.onBackpressure : function () {};
  const idr = o.idr || null; // QFIdrRequester：needsIdr 时发 reason=quality-change
  const probe = {
    sessionId: o.sessionId || '', tier: QF_QUALITY_DEFAULT_TIER,
    timer: null, running: false, hidden: false,
    lastProbeAt: 0, lastBadAt: 0, tierChangedAt: 0,
    pendingAck: null, // { decisionId, mustAckByMs }：须先发掉旧 ACK，不得堆积
    samples: [], // 最近 RTT 样本（抖动用）
    _window: [], // 1s 窗口内探针尝试 { at, ok }（lossPct/lossSamples 用）
    _rtts: [], // 最近 10 次探针往返时延（抖动用）
    _lastRttMs: null, // 上次探针往返实测
    _jitter() {
      const a = probe._rtts || [];
      if (a.length < 2) return 0;
      const mean = a.reduce((s, v) => s + v, 0) / a.length;
      const sd = Math.sqrt(a.reduce((s, v) => s + (v - mean) * (v - mean), 0) / a.length);
      return sd;
    },
    /* 探针周期（规范 §2.3）：正常 1s；弱网或档位切换后 10s 内 500ms；页面隐藏 5s。 */
    intervalMs() {
      if (probe.hidden) return 5000;
      if (probe.lastBadAt && sched.now() - probe.lastBadAt < 10000) return 500;
      if (probe.tierChangedAt && sched.now() - probe.tierChangedAt < 10000) return 500;
      return 1000;
    },
    start() {
      if (probe.running || !probe.sessionId) return;
      probe.running = true;
      const loop = () => {
        if (!probe.running) return;
        probe.timer = sched.setTimeout(() => {
          probe.sendOnce().catch(() => {});
          loop();
        }, probe.intervalMs());
      };
      probe.sendOnce().catch(() => {});
      loop();
      if (typeof document !== 'undefined' && document.addEventListener && !probe._visHooked) {
        probe._visHooked = true;
        probe._visFn = () => {
          probe.hidden = !!document.hidden;
          if (!probe.hidden) probe.sendOnce().catch(() => {}); // 恢复后补一次即时探针
        };
        document.addEventListener('visibilitychange', probe._visFn);
      }
    },
    stop() {
      probe.running = false;
      if (probe.timer) { sched.clearTimeout(probe.timer); probe.timer = null; }
      if (probe._visFn && typeof document !== 'undefined' && document.removeEventListener) {
        try { document.removeEventListener('visibilitychange', probe._visFn); } catch (e) {}
        probe._visFn = null; probe._visHooked = false;
      }
    },
    /* 发一次探针。collect() 返回本地观测值 { decodeLagMs?, pendingFrames?,
     * frameCorrupt?, rttMs?, lossPct?, jitterMs? }；RTT/丢包/抖动默认用本次
     * 探针调用自身的往返实测（上次往返时延、近 10 次抖动、1s 窗口内失败占比），
     * collect() 能提供更准的观测值时优先用它的。缺必填字段时服务端回
     * probe-incomplete（样本不入库），客户端不伪造数值。 */
    async sendOnce() {
      if (!fetchFn || !probe.sessionId) return null;
      const sample = collect() || {};
      // 客户端侧先校验值域（规范 §6.5：不得依赖服务端清洗）。
      const body = { sessionId: probe.sessionId, tier: probe.tier, probe: {} };
      const p = body.probe;
      // 1s 窗口内的探针尝试（lossSamples 须声明窗口与包数；网页端探针约 1/s，
      // 样本数小，服务端按 §2.3 记降权日志，客户端如实上报、不编大数）。
      const nowMs = sched.now();
      probe._window = (probe._window || []).filter((w) => nowMs - w.at < 1000);
      const failsInWindow = probe._window.filter((w) => !w.ok).length;
      const totalInWindow = probe._window.length;
      if (Number.isFinite(Number(sample.rttMs))) p.rttMs = Math.max(0, Math.min(10000, Number(sample.rttMs)));
      else if (probe._lastRttMs != null) p.rttMs = probe._lastRttMs;
      if (Number.isFinite(Number(sample.lossPct))) p.lossPct = Math.max(0, Math.min(100, Number(sample.lossPct)));
      else if (totalInWindow > 0) p.lossPct = Math.round((failsInWindow / totalInWindow) * 1000) / 10;
      if (Number.isFinite(Number(sample.lossSamples))) p.lossSamples = Math.max(0, Math.floor(Number(sample.lossSamples)));
      else p.lossSamples = totalInWindow;
      if (Number.isFinite(Number(sample.jitterMs))) p.jitterMs = Math.max(0, Math.min(5000, Number(sample.jitterMs)));
      else if (probe._rtts && probe._rtts.length > 1) p.jitterMs = Math.round(probe._jitter());
      if (Number.isFinite(Number(sample.decodeLagMs))) p.decodeLagMs = Math.max(0, Math.min(10000, Number(sample.decodeLagMs)));
      if (Number.isFinite(Number(sample.pendingFrames))) p.pendingFrames = Math.max(0, Math.min(10000, Math.floor(Number(sample.pendingFrames))));
      if (sample.frameCorrupt === true) p.frameCorrupt = true;
      if (Number.isFinite(Number(sample.serverQueueBytes))) p.serverQueueBytes = Math.max(0, Math.min(64 * 1024 * 1024, Number(sample.serverQueueBytes)));
      probe.lastProbeAt = nowMs;
      const cls = qfQualityClassify(p);
      if (cls === 'bad' || cls === 'severe') probe.lastBadAt = nowMs;
      const t0 = sched.now();
      let res;
      try {
        res = await fetchFn('/license/api/session/probe', {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      } catch (e) {
        probe._window.push({ at: sched.now(), ok: false });
        return { ok: false, code: 'NETWORK_ERROR' };
      }
      const dt = sched.now() - t0; // 本次探针往返实测，供下次探针的 rttMs/jitterMs 用
      probe._lastRttMs = dt;
      probe._rtts = (probe._rtts || []).concat([dt]).slice(-10);
      probe._window.push({ at: sched.now(), ok: !!res && res.status !== 0 });
      if (!res) return { ok: false, code: 'NETWORK_ERROR' };
      if (res.status === 503) return { ok: false, code: 'L5_UNAVAILABLE' };
      let j = null;
      try { j = await res.json(); } catch (e) { return { ok: false, code: 'BAD_RESPONSE' }; }
      if (!j || typeof j !== 'object') return { ok: false, code: 'BAD_RESPONSE' };
      if (j.backpressure && j.backpressure.level) {
        try { onBackpressure(j.backpressure.level, j.backpressure.action, j.backpressure); } catch (e) {}
      }
      const d = j.decision;
      if (d && d.decision === 'downgrade-to') {
        // 决策自带 from/to：先执行决策（from 取决策值），再以响应 tier 为准；
        // 不可在决策前用 j.tier 覆盖 probe.tier，否则 from 丢失。
        await probe._applyDecision(d, 'downgrade');
      } else if (typeof j.tier === 'string' && QF_QUALITY_TIER_TABLE[j.tier]) {
        probe.tier = j.tier;
      }
      return j;
    },
    /* 执行降档/升档决策（规范 §4.3）：先 hot 再 reconfig；needsIdr 时发 IDR
     * （reason=quality-change）并清旧参考帧（由 onTierChange 回调执行）；
     * 执行后须在 mustAckByMs 前 ACK；执行失败时不伪造 ACK、保持旧档位。
     * 返回执行结果（R-W2）：{ ok:true } 表决策已执行；{ ok:false, code }
     * 表决策被丢弃（PENDING_ACK/BAD_DECISION/BAD_TIER），调用方不得
     * 把“服务端回了 ok”当成“执行成功”。 */
    async _applyDecision(d, kind) {
      if (!d || !d.decisionId) return { ok: false, code: 'BAD_DECISION' };
      if (probe.pendingAck) return { ok: false, code: 'PENDING_ACK' }; // 旧决策 ACK 未发完，不堆积新决策
      const from = (d.from && QF_QUALITY_TIER_TABLE[d.from]) ? d.from : probe.tier;
      const to = d.to || '';
      if (!QF_QUALITY_TIER_TABLE[to]) return { ok: false, code: 'BAD_TIER' };
      const split = qfSplitTierChange(from, to);
      probe.tier = to;
      probe.tierChangedAt = sched.now();
      probe.pendingAck = { decisionId: d.decisionId, mustAckByMs: d.mustAckByMs || (sched.now() + 5000) };
      try { onTierChange(from, to, split, d); } catch (e) {}
      if (split.needsIdr && idr) {
        try { await idr.request(probe.sessionId, probe._agentId || '', 'quality-change'); } catch (e) {}
      }
      await probe.ack(d.decisionId);
      return { ok: true, tier: to, from };
    },
    /* ACK（规范 §4.4）：须在 mustAckByMs 前到达；UNKNOWN_DECISION 不得重试。 */
    async ack(decisionId) {
      if (!fetchFn || !probe.sessionId || !decisionId) return { ok: false, code: 'VALIDATION' };
      if (probe.pendingAck && probe.pendingAck.mustAckByMs < sched.now()) {
        probe.pendingAck = null; // 超时只记日志、不重发（规范 §6.4）
        return { ok: false, code: 'ACK_TIMEOUT' };
      }
      let res;
      try {
        res = await fetchFn('/license/api/session/quality/ack', {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: probe.sessionId, decisionId }),
        });
      } catch (e) {
        // R-W14（2026-11-15）：ACK 网络失败即释放 pendingAck，否则本会话
        // 后续全部档位决策永久被 _applyDecision 丢弃、画质自适应静默失效。
        if (probe.pendingAck && probe.pendingAck.decisionId === decisionId) probe.pendingAck = null;
        return { ok: false, code: 'NETWORK_ERROR' };
      }
      if (probe.pendingAck && probe.pendingAck.decisionId === decisionId) probe.pendingAck = null;
      if (!res) return { ok: false, code: 'NETWORK_ERROR' };
      if (res.status === 503) return { ok: false, code: 'L5_UNAVAILABLE' };
      let j = null;
      try { j = await res.json(); } catch (e) { return { ok: false, code: 'BAD_RESPONSE' }; }
      return j || { ok: false, code: 'BAD_RESPONSE' };
    },
    /* 手动升档（规范 §4.2）：一次只升一档；拒绝码原样返回，调用方展示原因。 */
    async upgrade() {
      if (!fetchFn || !probe.sessionId) return { ok: false, code: 'VALIDATION' };
      let res;
      try {
        res = await fetchFn('/license/api/session/quality/upgrade', {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: probe.sessionId }),
        });
      } catch (e) { return { ok: false, code: 'NETWORK_ERROR' }; }
      if (!res) return { ok: false, code: 'NETWORK_ERROR' };
      if (res.status === 503) return { ok: false, code: 'L5_UNAVAILABLE' };
      let j = null;
      try { j = await res.json(); } catch (e) { return { ok: false, code: 'BAD_RESPONSE' }; }
      if (j && j.ok && j.decision === 'upgrade-to') {
        // R-W2（2026-11-15）：决策未真正执行时不得回 ok:true——调用方凭 ok
        // 弹“已提升画质”；执行被丢弃时回明确复合状态，不伪造成功。
        const applied = await probe._applyDecision(j, 'upgrade');
        if (!applied || !applied.ok) return { ok: false, code: (applied && applied.code) || 'DECISION_NOT_APPLIED', decision: j.decision, decisionId: j.decisionId, tier: probe.tier };
      }
      return j || { ok: false, code: 'BAD_RESPONSE' };
    },
  };
  probe._agentId = o.agentId || '';
  return probe;
}

/* ---- RC-08 QF-STREAM-1：统一文件流客户端 ----
 * 流程：init（本地算 SHA-256）→ chunk（按服务端返回的 chunkSize 切分，
 * File.slice 流式读，不整文件进内存）→ commit → staged；断网后 missing
 * 查缺片续传（不从头重传）；cancel 仅 uploading 态；CORRUPT 整单作废，
 * 须重新 init（规范 §2.4）。下载用 Range 续传，收到 200 按全文件处理。
 * 已知局限（S-060）：SHA-256 本身须整文件读一次——WebCrypto 无流式接口，
 * sha256Hex() 对 file.arrayBuffer() 全量读入后一次 digest；200MB 上限文件
 * 在低端设备上有内存压力，属已知局限，不在本处修。分片上传仍走 slice 流式读。 */
function QFFileTransfer(opts) {
  const o = opts || {};
  const fetchFn = o.fetchFn || (typeof fetch !== 'undefined' ? fetch : null);
  const sha256Fn = o.sha256Fn || null; // 测试注入；默认用 crypto.subtle
  const tf = {
    state: 'idle', transferId: '', stagedId: '', filename: '', size: 0,
    chunkSize: 1048576, totalChunks: 0, received: 0, sentBytes: 0,
    cancelled: false, lastCode: '',
    /* 整文件 SHA-256（64 位小写 hex）。非安全上下文无 crypto.subtle 时报错。 */
    async sha256Hex(file) {
      if (sha256Fn) return sha256Fn(file);
      if (typeof crypto === 'undefined' || !crypto.subtle) throw new Error('no-subtle-crypto');
      const buf = await file.arrayBuffer();
      const digest = await crypto.subtle.digest('SHA-256', buf);
      return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
    },
    async _post(path, body) {
      if (!fetchFn) return { ok: false, code: 'NETWORK_ERROR' };
      let res;
      try {
        res = await fetchFn(path, {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (e) { return { ok: false, code: 'NETWORK_ERROR' }; }
      if (!res) return { ok: false, code: 'NETWORK_ERROR' };
      if (res.status === 503) return { ok: false, code: 'L5_UNAVAILABLE' };
      try { return await res.json(); } catch (e) { return { ok: false, code: 'BAD_RESPONSE' }; }
    },
    async _get(path) {
      if (!fetchFn) return { ok: false, code: 'NETWORK_ERROR' };
      let res;
      try { res = await fetchFn(path, { credentials: 'include' }); }
      catch (e) { return { ok: false, code: 'NETWORK_ERROR' }; }
      if (!res) return { ok: false, code: 'NETWORK_ERROR' };
      if (res.status === 503) return { ok: false, code: 'L5_UNAVAILABLE' };
      if (res.status === 404) return { ok: false, code: 'NOT_FOUND', status: 404 };
      try { return await res.json(); } catch (e) { return { ok: false, code: 'BAD_RESPONSE' }; }
    },
    /* 上传主流程。onProgress({ received, totalChunks, sentBytes, size, state })。
     * 中断后自动调 missing 续传一次（不断网重传已收分片）；CORRUPT 终态。 */
    async upload(file, toNode, fromNode, onProgress) {
      if (!file || !toNode) return { ok: false, code: 'VALIDATION' };
      if (tf.state === 'uploading') return { ok: false, code: 'STATE' };
      tf.state = 'init'; tf.cancelled = false; tf.lastCode = '';
      tf._file = file; tf._commitRetried = false; // S-061：commit 补传需原文件；只记本单引用，终态即清
      tf.filename = file.name || 'file'; tf.size = file.size || 0;
      const emit = () => { try { if (onProgress) onProgress({ received: tf.received, totalChunks: tf.totalChunks, sentBytes: tf.sentBytes, size: tf.size, state: tf.state }); } catch (e) {} };
      let sha = '';
      try { sha = await tf.sha256Hex(file); } catch (e) { tf.state = 'failed'; tf.lastCode = 'SHA_ERROR'; tf._file = null; return { ok: false, code: 'SHA_ERROR' }; }
      const init = await tf._post('/license/api/files/stream/init', {
        filename: tf.filename, size: tf.size, sha256: sha, toNode, fromNode: fromNode || undefined,
      });
      if (!init || !init.ok) { tf.state = 'failed'; tf.lastCode = (init && init.code) || 'NETWORK_ERROR'; tf._file = null; return init || { ok: false, code: 'NETWORK_ERROR' }; }
      // 客户端须用返回的 chunkSize 切分，不得用自己请求的值（规范 §2.1）。
      tf.transferId = init.transferId;
      tf.chunkSize = Number(init.chunkSize) > 0 ? Number(init.chunkSize) : 1048576;
      tf.totalChunks = Number(init.totalChunks) || Math.ceil(tf.size / tf.chunkSize);
      tf.state = 'uploading'; tf.received = 0; tf.sentBytes = 0;
      emit();
      const sendChunk = (index) => tf._sendChunk(index, emit);
      for (let i = 0; i < tf.totalChunks; i++) {
        if (tf.cancelled) { tf.state = 'cancelled'; tf._file = null; return { ok: false, code: 'CANCELLED' }; }
        const r = await sendChunk(i);
        if (!r || !r.ok) {
          // 断网/中断：missing 查缺片续传（规范 §4），不从头重传已收分片。
          if (r && (r.code === 'NETWORK_ERROR' || r.code === 'BAD_RESPONSE')) {
            tf.state = 'interrupted'; emit();
            const miss = await tf._get('/license/api/files/stream/' + encodeURIComponent(tf.transferId) + '/missing');
            if (miss && miss.ok && Array.isArray(miss.missing)) {
              tf.state = 'uploading';
              for (const idx of miss.missing) {
                if (tf.cancelled) { tf.state = 'cancelled'; tf._file = null; return { ok: false, code: 'CANCELLED' }; }
                const rr = await sendChunk(idx);
                if (!rr || !rr.ok) { tf.state = 'failed'; tf.lastCode = (rr && rr.code) || 'NETWORK_ERROR'; tf._file = null; return rr || { ok: false, code: 'NETWORK_ERROR' }; }
              }
              break;
            }
          }
          tf.state = 'failed'; tf.lastCode = (r && r.code) || 'NETWORK_ERROR';
          tf._file = null;
          return r || { ok: false, code: 'NETWORK_ERROR' };
        }
      }
      const out = await tf.commit(emit);
      tf._file = null; // 终态清文件引用，不长期持有
      return out;
    },
    /* 单片发送（upload 与 commit 补传共用）：按服务端 chunkSize 切片上传。 */
    async _sendChunk(index, emit) {
      const file = tf._file;
      if (!file || !tf.transferId) return { ok: false, code: 'VALIDATION' };
      const start = index * tf.chunkSize;
      const end = Math.min(start + tf.chunkSize, tf.size);
      const slice = file.slice(start, end);
      const buf = await slice.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let b64 = '';
      for (let i = 0; i < bytes.length; i += 0x8000) {
        b64 += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      }
      b64 = btoa(b64);
      const r = await tf._post('/license/api/files/stream/' + encodeURIComponent(tf.transferId) + '/chunk', { index, contentBase64: b64 });
      if (r && r.ok) { tf.received = Number(r.received) || tf.received + 1; tf.sentBytes = end; if (emit) emit(); }
      return r;
    },
    /* commit：缺片回 INCOMPLETE 时按 r.missing 补传缺片后再 commit 一次
     * （S-061：服务端重启/淘汰致已 ack 分片丢失本可恢复，旧写法直接判发送
     * 失败）；补传后仍 INCOMPLETE 才判失败；CORRUPT 整单作废。 */
    async commit(emit) {
      if (!tf.transferId) return { ok: false, code: 'VALIDATION' };
      tf.state = 'committing';
      if (emit) emit();
      const r = await tf._post('/license/api/files/stream/' + encodeURIComponent(tf.transferId) + '/commit', {});
      if (r && r.ok) {
        tf.state = 'staged'; tf.stagedId = r.stagedId || ''; tf.lastCode = '';
        if (emit) emit();
        return { ok: true, transferId: tf.transferId, stagedId: tf.stagedId, size: r.size, expiresAt: r.expiresAt };
      }
      if (r && r.code === 'INCOMPLETE' && Array.isArray(r.missing)) {
        if (tf._commitRetried || !tf._file) {
          // 已补传过一轮仍缺片（或无原文件可补传）：判发送失败。
          tf.state = 'failed'; tf.lastCode = 'INCOMPLETE';
          return { ok: false, code: 'INCOMPLETE', missing: r.missing, transferId: tf.transferId };
        }
        tf._commitRetried = true;
        tf.state = 'uploading';
        if (emit) emit();
        for (const idx of r.missing) {
          if (tf.cancelled) { tf.state = 'cancelled'; return { ok: false, code: 'CANCELLED' }; }
          const rr = await tf._sendChunk(idx, emit);
          if (!rr || !rr.ok) { tf.state = 'failed'; tf.lastCode = (rr && rr.code) || 'NETWORK_ERROR'; return rr || { ok: false, code: 'NETWORK_ERROR' }; }
        }
        return tf.commit(emit); // 补传完再 commit 一次（_commitRetried 已置位，不会无限循环）
      }
      tf.state = 'failed'; tf.lastCode = (r && r.code) || 'NETWORK_ERROR';
      return r || { ok: false, code: 'NETWORK_ERROR' };
    },
    /* 取消：仅 uploading 态可取消；commit 后无取消端点（规范 §2.5）。 */
    async cancel() {
      if (tf.state !== 'uploading' && tf.state !== 'interrupted') return { ok: false, code: 'STATE' };
      tf.cancelled = true;
      const r = await tf._post('/license/api/files/stream/' + encodeURIComponent(tf.transferId) + '/cancel', {});
      if (r && r.ok) tf.state = 'cancelled';
      return r || { ok: false, code: 'NETWORK_ERROR' };
    },
    async missing() {
      if (!tf.transferId) return { ok: false, code: 'VALIDATION' };
      return tf._get('/license/api/files/stream/' + encodeURIComponent(tf.transferId) + '/missing');
    },
    /* 下载：无 Range 全文件；中途断网后用 Range 续传；服务端回 200 时按全文件
     * 处理（规范 §2.6：非法 Range 回落 200，不返回 416）。返回 Blob。 */
    async download(stagedId, onProgress) {
      if (!stagedId || !fetchFn) return { ok: false, code: 'VALIDATION' };
      const url = '/license/api/files/' + encodeURIComponent(stagedId) + '/download';
      let received = 0;
      const chunks = [];
      let attempt = 0;
      while (attempt < 2) {
        attempt++;
        let res;
        try {
          const headers = received > 0 ? { Range: 'bytes=' + received + '-' } : {};
          res = await fetchFn(url, { credentials: 'include', headers });
        } catch (e) {
          if (received > 0) continue; // 断网续传再试一次
          return { ok: false, code: 'NETWORK_ERROR' };
        }
        if (!res) return { ok: false, code: 'NETWORK_ERROR' };
        if (res.status === 404) return { ok: false, code: 'NOT_FOUND' };
        if (res.status === 503) return { ok: false, code: 'L5_UNAVAILABLE' };
        if (res.status === 206) {
          // 区间响应：继续拼装
        } else if (res.status === 200) {
          if (received > 0) { received = 0; chunks.length = 0; } // 回落全文件，丢弃已收区间
        } else {
          return { ok: false, code: 'BAD_RESPONSE', status: res.status };
        }
        const total = Number(res.headers && res.headers.get ? res.headers.get('Content-Length') : 0) || 0;
        try {
          const reader = res.body && res.body.getReader ? res.body.getReader() : null;
          if (!reader) {
            const buf = await res.arrayBuffer();
            chunks.push(new Uint8Array(buf)); received += buf.byteLength;
          } else {
            for (;;) {
              const part = await reader.read();
              if (part.done) break;
              chunks.push(part.value); received += part.value.length;
              try { if (onProgress) onProgress({ received, total: total + (res.status === 206 ? received : 0) }); } catch (e) {}
            }
          }
        } catch (e) {
          if (attempt < 2 && received > 0) continue; // 读流中断，Range 续传
          return { ok: false, code: 'NETWORK_ERROR' };
        }
        break;
      }
      const blob = new Blob(chunks, { type: 'application/octet-stream' });
      return { ok: true, blob, size: received };
    },
    async listInbox(node) {
      if (!node) return { ok: false, code: 'VALIDATION' };
      return tf._get('/license/api/files/inbox?node=' + encodeURIComponent(node));
    },
    async listSent() { return tf._get('/license/api/files/sent'); },
    async ack(stagedId) {
      if (!stagedId) return { ok: false, code: 'VALIDATION' };
      return tf._post('/license/api/files/' + encodeURIComponent(stagedId) + '/ack', {});
    },
    async listAudit(limit) {
      const n = Number(limit) > 0 ? Math.min(200, Math.floor(Number(limit))) : 50;
      return tf._get('/license/api/files/audit?limit=' + n);
    },
  };
  return tf;
}

/* ---- RC-10 QF-REC-1：录制控制客户端 ----
 * start → event（只发 input/clipboard/frame-marker/quality-change 四种，
 * clipboard 只发 bytes）→ end。POLICY_OFF 时不录制、不发事件。
 * 注意 §6.1 安全缺口：/event 与 /end 路由目前只要求控制台会话、不调
 * canAccess；客户端不得利用，sessionId 一律用不可猜的 rec_＋16 hex
 * （不用可猜的自定义值）；§6.2：服务端重启后内存会话丢失，/event 返回
 * NOT_FOUND 时提示录制已中断并重新 start（新 sessionId），不得静默丢事件。 */
function QFRecording(opts) {
  const o = opts || {};
  const fetchFn = o.fetchFn || (typeof fetch !== 'undefined' ? fetch : null);
  const rec = {
    sessionId: '', state: 'idle', // idle | recording | off | interrupted | ended
    lastAt: 0, droppedOutOfOrder: 0, eventsSent: 0,
    newRecordingId() {
      let hex = '';
      try {
        const b = new Uint8Array(8);
        if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
          crypto.getRandomValues(b);
          hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
        }
      } catch (e) {}
      if (!hex) { for (let i = 0; i < 16; i++) hex += Math.floor(Math.random() * 16).toString(16); }
      return 'rec_' + hex;
    },
    async _post(path, body) {
      if (!fetchFn) return { ok: false, code: 'NETWORK_ERROR' };
      let res;
      try {
        res = await fetchFn(path, {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (e) { return { ok: false, code: 'NETWORK_ERROR' }; }
      if (!res) return { ok: false, code: 'NETWORK_ERROR' };
      if (res.status === 503) return { ok: false, code: 'L5_UNAVAILABLE' };
      try { return await res.json(); } catch (e) { return { ok: false, code: 'BAD_RESPONSE' }; }
    },
    async start(deviceId, groupId, tier, sessionId) {
      // sessionId 建议传桌面会话 id 以便关联（规范 §2.1）；须是不可猜的
      // 随机值（规范 §6.1），桌面会话 id（sess-＋16 hex，crypto 随机）满足；
      // 不传或格式不对时生成 rec_＋16 hex。
      rec.sessionId = (typeof sessionId === 'string' && /^(sess|rec)-[0-9a-f]{16}$/.test(sessionId)) ? sessionId : rec.newRecordingId();
      rec.lastAt = 0; rec.droppedOutOfOrder = 0; rec.eventsSent = 0;
      const r = await rec._post('/license/api/recordings/start', {
        sessionId: rec.sessionId, deviceId: deviceId || '', groupId: groupId || '', tier: tier || QF_QUALITY_DEFAULT_TIER,
      });
      if (r && r.ok) { rec.state = 'recording'; return { ok: true, sessionId: rec.sessionId }; }
      if (r && r.code === 'POLICY_OFF') { rec.state = 'off'; return { ok: false, code: 'POLICY_OFF' }; }
      rec.state = 'idle';
      return r || { ok: false, code: 'NETWORK_ERROR' };
    },
    /* 发一个事件：先白名单清洗；at 须单调递增，倒序事件丢弃（不补发旧事件）。 */
    async sendEvent(ev) {
      if (rec.state !== 'recording' || !rec.sessionId) return { ok: false, code: 'NOT_RECORDING' };
      const clean = qfRecSanitizeEvent(ev);
      if (!clean) return { ok: false, code: 'VALIDATION' };
      if (clean.at < rec.lastAt) { rec.droppedOutOfOrder++; return { ok: false, code: 'OUT_OF_ORDER' }; }
      rec.lastAt = clean.at;
      const r = await rec._post('/license/api/recordings/' + encodeURIComponent(rec.sessionId) + '/event', { event: clean });
      if (r && r.ok) { rec.eventsSent++; return r; }
      if (r && r.code === 'NOT_FOUND') {
        rec.state = 'interrupted'; // 服务端重启致内存会话丢失（规范 §6.2）
        return { ok: false, code: 'INTERRUPTED' };
      }
      return r || { ok: false, code: 'NETWORK_ERROR' };
    },
    async end() {
      if (!rec.sessionId || rec.state === 'ended') return { ok: false, code: 'VALIDATION' };
      const r = await rec._post('/license/api/recordings/' + encodeURIComponent(rec.sessionId) + '/end', {});
      if (r && r.ok) rec.state = 'ended';
      return r || { ok: false, code: 'NETWORK_ERROR' };
    },
    async list() {
      if (!fetchFn) return { ok: false, code: 'NETWORK_ERROR' };
      let res;
      try { res = await fetchFn('/license/api/recordings', { credentials: 'include' }); }
      catch (e) { return { ok: false, code: 'NETWORK_ERROR' }; }
      if (!res) return { ok: false, code: 'NETWORK_ERROR' };
      if (res.status === 503) return { ok: false, code: 'L5_UNAVAILABLE' };
      try { return await res.json(); } catch (e) { return { ok: false, code: 'BAD_RESPONSE' }; }
    },
    async getIndex(sessionId) {
      if (!sessionId || !fetchFn) return { ok: false, code: 'VALIDATION' };
      let res;
      try { res = await fetchFn('/license/api/recordings/' + encodeURIComponent(sessionId) + '/index', { credentials: 'include' }); }
      catch (e) { return { ok: false, code: 'NETWORK_ERROR' }; }
      if (!res) return { ok: false, code: 'NETWORK_ERROR' };
      if (res.status === 404) return { ok: false, code: 'NOT_FOUND' }; // 无权限与不存在同一响应，不区分解读（规范 §4.2）
      if (res.status === 503) return { ok: false, code: 'L5_UNAVAILABLE' };
      try { return await res.json(); } catch (e) { return { ok: false, code: 'BAD_RESPONSE' }; }
    },
    async downloadBytes(sessionId) {
      if (!sessionId || !fetchFn) return { ok: false, code: 'VALIDATION' };
      let res;
      try { res = await fetchFn('/license/api/recordings/' + encodeURIComponent(sessionId) + '/download', { credentials: 'include' }); }
      catch (e) { return { ok: false, code: 'NETWORK_ERROR' }; }
      if (!res) return { ok: false, code: 'NETWORK_ERROR' };
      if (res.status === 404) return { ok: false, code: 'NOT_FOUND' };
      if (res.status === 503) return { ok: false, code: 'L5_UNAVAILABLE' };
      if (!res.ok) return { ok: false, code: 'BAD_RESPONSE', status: res.status };
      const text = await res.text(); // 录像下载不支持 Range（规范 §2.6），整文件下载
      return { ok: true, text };
    },
  };
  return rec;
}

/* ---- RC-10 QF-REC-1：回放器 ----
 * 按事件 at 时间戳顺序重放事件流（光标轨迹＋档位标记），不是视频画面。
 * seek 用索引锚点（t ≤ T 的最后锚点，从 byteOffset 起往后读、快进重放到 T，
 * 10s 粒度内准确，不逐行从头扫）；变速 0.5x/1x/2x（按 at 差值缩放间隔）；
 * 边下边播：只解析完整行（半行不播）。 */
function QFRecPlayer(opts) {
  const o = opts || {};
  const sched = o.scheduler || { setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (t) => clearTimeout(t), now: () => Date.now() };
  const onEvent = typeof o.onEvent === 'function' ? o.onEvent : function () {};
  const SPEEDS = [0.5, 1, 2];
  const player = {
    events: [], index: null, text: '', consumedBytes: 0,
    playing: false, speed: 1, cursor: { x: 0, y: 0 }, tier: '',
    startAt: 0, endAt: 0, playheadMs: 0, nextIdx: 0, timer: null, startedWall: 0,
    /* 整文件加载：先取索引，再下载全文。 */
    load(text, index) {
      player.text = typeof text === 'string' ? text : '';
      player.index = (index && Array.isArray(index.index)) ? index.index : null;
      const parsed = qfRecParseJsonl(player.text, 0);
      player.events = parsed.events;
      player.consumedBytes = parsed.consumedBytes;
      player._resetClock();
      return { events: player.events.length, skipped: parsed.skipped };
    },
    /* 边下边播：追加已下载文本，只解析新增完整行。 */
    appendText(text) {
      if (typeof text !== 'string') return { added: 0 };
      player.text = text;
      const parsed = qfRecParseJsonl(player.text, player.consumedBytes);
      player.consumedBytes = parsed.consumedBytes;
      const before = player.events.length;
      player.events = player.events.concat(parsed.events);
      if (player.events.length && player.endAt < player.events[player.events.length - 1].at) {
        player.endAt = player.events[player.events.length - 1].at;
      }
      return { added: player.events.length - before, skipped: parsed.skipped };
    },
    _resetClock() {
      if (player.events.length) {
        player.startAt = player.events[0].at;
        player.endAt = player.events[player.events.length - 1].at;
      } else { player.startAt = 0; player.endAt = 0; }
      player.playheadMs = player.startAt;
      player.nextIdx = 0;
      player.cursor = { x: 0, y: 0 };
      player.tier = '';
    },
    durationMs() { return Math.max(0, player.endAt - player.startAt); },
    setSpeed(x) {
      if (SPEEDS.indexOf(x) < 0) return false;
      player.speed = x;
      if (player.playing) { player.pause(); player.play(); }
      return true;
    },
    /* seek：取 t ≤ T 的最后锚点，从 byteOffset 起往后读事件、快进重放到 T。
     * 锚点前事件不重扫（10s 粒度近似）；nextIdx 对齐到全量事件表。 */
    seek(tMs) {
      const target = player.startAt + Math.max(0, Math.min(player.durationMs(), tMs));
      let fromByte = 0;
      const anchor = qfRecSeekAnchor(player.index, target);
      if (anchor && Number.isFinite(Number(anchor.byteOffset))) fromByte = Number(anchor.byteOffset);
      const wasPlaying = player.playing;
      if (wasPlaying) player.pause();
      player.playheadMs = target;
      // 从锚点偏移处往后读事件、快进应用到 T。
      const parsed = qfRecParseJsonl(player.text, fromByte);
      let applied = 0;
      for (const ev of parsed.events) {
        if (ev.at <= target) { player._apply(ev); applied++; }
        else break;
      }
      let idx = 0;
      for (let i = 0; i < player.events.length; i++) {
        if (player.events[i].at <= target) idx = i + 1;
        else break;
      }
      player.nextIdx = idx;
      if (wasPlaying) player.play();
      return { playheadMs: player.playheadMs, anchor: anchor ? anchor.t : null, applied };
    },
    _apply(ev) {
      if (!ev || typeof ev !== 'object') return;
      if (ev.type === 'input' && ev.kind === 'mouse') player.cursor = { x: Number(ev.x) || 0, y: Number(ev.y) || 0 };
      if (ev.type === 'quality-change' && typeof ev.to === 'string') player.tier = ev.to;
      try { onEvent(ev, player.playheadMs); } catch (e) {}
    },
    play() {
      if (player.playing || !player.events.length) return false;
      if (player.nextIdx >= player.events.length) { player.nextIdx = 0; player.playheadMs = player.startAt; player.cursor = { x: 0, y: 0 }; }
      player.playing = true;
      player.startedWall = sched.now();
      const step = () => {
        if (!player.playing) return;
        if (player.nextIdx >= player.events.length) { player.playing = false; player.timer = null; return; }
        const ev = player.events[player.nextIdx];
        const delay = Math.max(0, (ev.at - player.playheadMs) / player.speed);
        player.timer = sched.setTimeout(() => {
          if (!player.playing) return;
          player.playheadMs = ev.at;
          player.nextIdx++;
          player._apply(ev);
          step();
        }, delay);
      };
      step();
      return true;
    },
    pause() {
      player.playing = false;
      if (player.timer) { sched.clearTimeout(player.timer); player.timer = null; }
    },
    state() {
      return {
        playing: player.playing, speed: player.speed,
        playheadMs: player.playheadMs, durationMs: player.durationMs(),
        cursor: { x: player.cursor.x, y: player.cursor.y }, tier: player.tier,
        events: player.events.length, nextIdx: player.nextIdx,
      };
    },
  };
  return player;
}
