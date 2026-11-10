'use strict';
/*
 * QFRemote 自动重新登录 + 登录页介入（v2.3.0 新增）
 * ================================================================
 * 语义（站长 2026-10-25 亲定）：
 *   用户勾过「记住此设备」后，除本人亲手点「退出账号」外，一切掉登录
 *   （关软件重开、崩溃、服务器重启、会话过期、断线恢复、服务端失效）
 *   都自动恢复已登录，不再输密码；勾过「记住账号密码」时，会话恢复不
 *   成立就用保险箱里的凭据（creds.js，系统加密落盘）静默登录。
 *
 * 分工与落点：
 *   1) 会话恢复（第一顺位）：控制台跑在 persist:qfremote 持久分区里，
 *      会话 cookie 由服务端下发 30 天有效期（服务端 sessionTime 口径），
 *      分区天然跨重启恢复；壳侧再补两件事——cookie 变更后及时刷盘
 *      （flushStore，防崩溃丢 cookie）、启动先探活会话是否还成立。
 *   2) 静默登录（第二顺位）：主进程直接向控制台提交登录表单（与登录页
 *      原生提交同字段：action/username/password），回程的会话 cookie 写
 *      回同一持久分区，然后再加载控制台——全程不经过登录页，不闪。
 *      只在有已存凭据、非手动退出、未连续失败时执行；失败立刻停手，
 *      绝不反复试密码（防把账号试到冻结/限流）。
 *   3) 登录页介入：控制台视图是远程页面，壳不给它挂 preload（不把桥
 *      暴露给远程内容），一律由主进程 executeJavaScript 注入，与既有
 *      看护（watchdog）同一手法。注入做四件事：补「记住账号密码」勾选
 *      （与服务端已有的「记住此设备」并列、互相独立）、按保险箱回填、
 *      在提交瞬间把本次输入暂存到页面 sessionStorage（主进程在登录
 *      成功后收走决定存不存保险箱，失败立刻丢弃）、盯手动退出与
 *      「用户亲手清空输入框」两个清除信号。
 *   4) 手动退出是唯一人工终止：主进程三路检测（会话请求拦截、页面
 *      导航、注入的点击标记），命中即清会话 cookie、清保险箱、清记住
 *      标记，回到登录页后不再自动登录，直到用户下一次亲手登录成功。
 *
 * 本模块纯逻辑与页面脚本分离：策略、收割决策、cookie 处理、静默登录
 * 请求都可在 Node 里单测；页面函数只做 DOM 操作，字符串化后注入。
 */
const http = require('http');
const https = require('https');
const clientVersion = require('./client-version');

// 页面 sessionStorage 键（注入与检测共用，改名要两处一起改——都在本文件）
const PENDING_KEY = 'qfShellPendingLogin';
const LOGOUT_KEY = 'qfShellManualLogout';
const CLEARED_KEY = 'qfShellFieldsCleared';
// ---------- 控制台固定源的证书校验 ----------
// 2.4.2 起控制台固定源迁至正式域名 app.qfremote.top（公共 CA 签发）：
// 静默登录与探活一律走系统默认证书校验，不再内置任何信任锚。历史上为
// 直连自签源（旧 IP:8443）内置的 MeshCentral 根证书信任锚已随该源退役
// 删除——继续保留会把域名请求误钉到错误 CA 上、握手必失败。
// args.caCert 仅供测试注入：须显式环境开关 QFREMOTE_TEST_CA=1 才生效，
// 生产进程从不开此开关、从不传参。
const CONSOLE_HOST = 'app.qfremote.top';
function applyConsoleTls(opts, u, a) {
  if (u.protocol !== 'https:') return;
  const ca = (a && a.caCert && process.env.QFREMOTE_TEST_CA === '1') ? a.caCert : null;
  if (ca) opts.ca = ca;
}



// ---------- 纯逻辑：地址与文案判定 ----------

function isLogoutUrl(raw) {
  try {
    const p = new URL(raw).pathname;
    return p === '/logout' || p.startsWith('/logout/');
  } catch (e) { return false; }
}

const FAILURE_PATTERNS = ['登录失败', '账号已被锁定', '已被锁定', '暂时限制', '安全验证未通过'];
function isLoginFailureText(text) {
  const t = String(text || '');
  return FAILURE_PATTERNS.some(p => t.includes(p));
}

// ---------- 纯逻辑：自动登录策略（防死循环、防反复试密码） ----------

function createAutoLoginPolicy(opts) {
  const maxAttempts = (opts && typeof opts.maxAttempts === 'number') ? opts.maxAttempts : 2;
  let attempts = 0;
  let stopped = null; // 'login-failed' 等停手机器原因，成功一次才解除
  return {
    decide(input) {
      const i = input || {};
      if (i.pageState !== 'login') return { action: 'none', reason: 'not-login-page' };
      if (i.manualLogout) return { action: 'none', reason: 'manual-logout' };
      if (i.failedBanner) { stopped = 'login-failed'; return { action: 'none', reason: 'login-failed' }; }
      if (stopped) return { action: 'none', reason: stopped };
      if (!i.hasCreds) return { action: 'none', reason: 'no-creds' };
      if (attempts >= maxAttempts) return { action: 'none', reason: 'attempts-exhausted' };
      return { action: 'silent-login' };
    },
    noteAttempt() { attempts++; },
    noteFailure() { stopped = 'login-failed'; },
    noteSuccess() { attempts = 0; stopped = null; },
    state() { return { attempts, stopped, maxAttempts }; }
  };
}

// ---------- 纯逻辑：登录提交收割决策 ----------
// pending 是注入脚本在提交瞬间暂存的 {src:'shell', u, p, rp, rd, auto}；
// 只有登录成功（已进控制台）才收割：勾了「记住账号密码」才存保险箱，
// 没勾视为明确关闭记住——清掉旧凭据；失败一律丢弃、什么都不动。
function planHarvest(pending, outcome) {
  const none = { save: null, clearVault: false, rememberDevice: null, clearManualLogout: false };
  if (!pending || pending.src !== 'shell') return none;
  if (outcome !== 'success') return none;
  return {
    save: (pending.rp && pending.u && pending.p) ? { username: pending.u, password: pending.p } : null,
    clearVault: !pending.rp,
    rememberDevice: !!pending.rd,
    clearManualLogout: true
  };
}

// ---------- cookie 处理（会话分区是唯一事实来源，不许回退） ----------

// 解析一条 Set-Cookie 为 Electron cookies.set 的入参（host-only 不写 domain）
function parseSetCookie(raw, requestUrl) {
  if (typeof raw !== 'string' || !raw) return null;
  const parts = raw.split(';');
  const first = parts.shift();
  const eq = first.indexOf('=');
  if (eq <= 0) return null;
  const out = {
    url: requestUrl,
    name: first.slice(0, eq).trim(),
    value: first.slice(eq + 1).trim()
  };
  let expiresAt = null;
  let maxAge = null;
  for (const attr of parts) {
    const aeq = attr.indexOf('=');
    const k = (aeq >= 0 ? attr.slice(0, aeq) : attr).trim().toLowerCase();
    const v = aeq >= 0 ? attr.slice(aeq + 1).trim() : '';
    if (k === 'expires') { const t = Date.parse(v); if (!Number.isNaN(t)) expiresAt = Math.floor(t / 1000); }
    else if (k === 'max-age') { const n = parseInt(v, 10); if (!Number.isNaN(n)) maxAge = n; }
    else if (k === 'path' && v) out.path = v;
    else if (k === 'domain' && v) out.domain = v.replace(/^\./, '');
    else if (k === 'secure') out.secure = true;
    else if (k === 'httponly') out.httpOnly = true;
  }
  if (maxAge !== null) out.expirationDate = Math.floor(Date.now() / 1000) + maxAge;
  else if (expiresAt !== null) out.expirationDate = expiresAt;
  return out;
}

async function applySetCookies(ses, rawList, requestUrl) {
  if (!ses || !ses.cookies || !Array.isArray(rawList)) return 0;
  let n = 0;
  for (const raw of rawList) {
    const detail = parseSetCookie(raw, requestUrl);
    if (!detail) continue;
    try { await ses.cookies.set(detail); n++; } catch (e) { /* 单条失败不影响其余 */ }
  }
  return n;
}

// 清掉某主机名下的全部 cookie（手动退出用：xid/xid.sig/qfrem 一个不留）
async function clearConsoleSession(ses, originUrl) {
  if (!ses || !ses.cookies) return 0;
  const host = new URL(originUrl).hostname;
  const all = await ses.cookies.get({});
  let removed = 0;
  for (const c of all) {
    const d = String(c.domain || '').replace(/^\./, '');
    if (d !== host) continue;
    try {
      await ses.cookies.remove('https://' + host + (c.path || '/'), c.name);
      removed++;
    } catch (e) { /* ignore */ }
  }
  return removed;
}

// ---------- 静默登录（主进程直提，与登录页原生提交同字段） ----------
// baseUrl 为控制台根地址（https://app.qfremote.top/）；初步成功判据只有一个：
// 回程下发非空 xid 会话 cookie（响应形状不作数，最终由页面状态裁定）。
// 失败/异常都回 {ok:false}，不抛。
function httpSilentLogin(args) {
  const a = args || {};
  const timeoutMs = a.timeoutMs || 8000;
  return new Promise((resolve) => {
    let u;
    try { u = new URL(a.baseUrl); } catch (e) { resolve({ ok: false, status: 0, setCookies: [], error: '地址不对' }); return; }

    const body = new URLSearchParams({
      action: 'login',
      username: String(a.username || ''),
      password: String(a.password || ''),
      urlargs: ''
    }).toString();

    const lib = u.protocol === 'https:' ? https : http;
    let opts;
    try {
      opts = {
        method: 'POST',
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        // 保留 query，避免 CONSOLE_URL 带路由参数时打错路径
        path: (u.pathname || '/') + (u.search || ''),
        headers: clientVersion.withClientVersion({
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body)
        }, a.clientVersion),
        timeout: timeoutMs
      };
    } catch (e) {
      resolve({ ok: false, status: 0, setCookies: [], error: (e && e.message) || '请求构造失败' });
      return;
    }
    applyConsoleTls(opts, u, a);

    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };

    try {
      const req = lib.request(opts, (res) => {
        const rawSetCookies = res.headers['set-cookie'];
        const setCookies = Array.isArray(rawSetCookies)
          ? rawSetCookies
          : (rawSetCookies ? [rawSetCookies] : []);
        const status = res.statusCode || 0;
        const location = res.headers.location || null;
        const chunks = [];
        let size = 0;

        res.on('data', (c) => {
          size += c.length;
          if (size < 2 * 1024 * 1024) chunks.push(c);
        });

        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          // 只有下发非空 xid 才算“凭据被接受”。302/200 的页面形状不再作数。
          const hasXid = setCookies.some((sc) => {
            const m = /^\s*xid=([^;]*)/.exec(String(sc));
            return !!(m && m[1]);
          });
          const ok = hasXid && status >= 200 && status < 400;
          finish({
            ok,
            status,
            setCookies,
            location,
            isLoginPage: text.includes('loginpanelform'),
            error: ok ? null : (hasXid ? '登录响应异常' : '登录未成功')
          });
        });

        res.on('error', () => finish({ ok: false, status: status || 0, setCookies, error: '无法连接服务器' }));
      });

      req.on('timeout', () => req.destroy(new Error('连接超时')));
      req.on('error', (e) => finish({ ok: false, status: 0, setCookies: [], error: (e && e.message) || '无法连接服务器' }));
      req.write(body);
      req.end();
    } catch (e) {
      finish({ ok: false, status: 0, setCookies: [], error: e.message });
    }
  });
}
function httpProbeSession(args) {
  const a = args || {};
  const timeoutMs = a.timeoutMs || 6000;
  const loginMarker = a.loginMarker || 'loginpanelform';
  const consoleMarkers = Array.isArray(a.consoleMarkers) ? a.consoleMarkers.filter(Boolean) : [];
  const minBodyBytes = typeof a.minBodyBytes === 'number' ? a.minBodyBytes : 256;

  return new Promise((resolve) => {
    let u;
    try { u = new URL(a.baseUrl); } catch (e) { resolve({ alive: false, status: 0, error: '地址不对' }); return; }

    const lib = u.protocol === 'https:' ? https : http;
    let opts;
    try {
      opts = {
        method: 'GET',
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: (u.pathname || '/') + (u.search || ''),
        headers: clientVersion.clientVersionHeaders(a.clientVersion),
        timeout: timeoutMs
      };
      if (a.cookieHeader) {
        opts.headers = Object.assign({}, opts.headers, { Cookie: a.cookieHeader });
      }
    } catch (e) {
      resolve({ alive: false, status: 0, error: (e && e.message) || '请求构造失败' });
      return;
    }
    applyConsoleTls(opts, u, a);

    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };

    try {
      const req = lib.request(opts, (res) => {
        const status = res.statusCode || 0;
        const location = res.headers.location || null;
        const chunks = [];
        let size = 0;

        res.on('data', (c) => {
          size += c.length;
          if (size < 2 * 1024 * 1024) chunks.push(c);
        });

        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          const bodyBytes = Buffer.byteLength(text, 'utf8');
          const is2xx = status >= 200 && status < 300;
          const isLoginPage = text.includes(loginMarker);

          // 硬条件：2xx、无 Location、非登录页、响应体不是空壳。
          let alive = is2xx && !location && !isLoginPage && bodyBytes >= minBodyBytes;

          // 若调用方给了控制台正向标记，必须命中；没有正向标记时本探活只是弱信号，
          // 绝不能作为最终成功裁定（最终由 processAuthPage 的 DETECT_JS 裁定）。
          if (alive && consoleMarkers.length) {
            alive = consoleMarkers.some((m) => text.includes(m));
          }

          finish({ alive, status, location, isLoginPage, bodyBytes });
        });

        res.on('error', () => finish({ alive: false, status: status || 0, error: '读取响应失败' }));
      });

      req.on('timeout', () => req.destroy(new Error('连接超时')));
      req.on('error', () => finish({ alive: false, status: 0 }));
      req.end();
    } catch (e) {
      finish({ alive: false, status: 0, error: e.message });
    }
  });
}
// 登录页注入：补勾选、回填、暂存提交、清框与退出信号。opts={username,password,rememberPassword,rememberDevice}
function pageInject(opts) {
  var PENDING = 'qfShellPendingLogin';
  var CLEARED = 'qfShellFieldsCleared';
  function vis(el) {
    if (!el) return false;
    var s = window.getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden';
  }
  var u = document.getElementById('username');
  var p = document.getElementById('password');
  var form = document.getElementById('loginpanelform');
  if (!u || !p || !form) return { ok: false, reason: 'no-login-form' };
  var devBox = document.getElementById('qfRememberDevice');

  // 1) 补「记住账号密码」勾选：与「记住此设备」并列、互相独立
  var pwBox = document.getElementById('qfRememberPassword');
  if (!pwBox) {
    var row = null;
    if (devBox) { var n = devBox; while (n && n.tagName !== 'TR') n = n.parentElement; row = n; }
    if (!row) { var n2 = p; while (n2 && n2.tagName !== 'TR') n2 = n2.parentElement; row = n2; }
    if (row && row.parentNode) {
      var tr = document.createElement('tr');
      tr.id = 'qfRememberPasswordRow';
      var td = document.createElement('td');
      var label = document.createElement('label');
      label.style.cssText = 'box-sizing:border-box;width:280px;display:block;text-align:left;font-size:13px;padding:6px 2px 0 2px;cursor:pointer';
      var input = document.createElement('input');
      input.id = 'qfRememberPassword';
      input.name = 'qfrememberpassword';
      input.type = 'checkbox';
      input.style.cssText = 'vertical-align:-2px;margin-right:6px';
      label.appendChild(input);
      label.appendChild(document.createTextNode('记住账号密码'));
      td.appendChild(label);
      tr.appendChild(td);
      row.parentNode.insertBefore(tr, row.nextSibling);
      pwBox = input;
    }
  }
  if (pwBox && opts.rememberPassword) pwBox.checked = true;
  if (devBox && opts.rememberDevice) devBox.checked = true;

  // 2) 回填（只在有已存凭据时；派发事件让页面自带的校验跟上）
  // 回填基线挂 window 上：同页重复注入时以最新一次为准，清框检测读它
  var filledU = '', filledP = '';
  if (opts.username && opts.password) {
    window.__qfShellFilling = true;
    u.value = opts.username;
    p.value = opts.password;
    filledU = opts.username; filledP = opts.password;
    window.__qfShellFilled = { u: filledU, p: filledP };
    ['input', 'change'].forEach(function (t) {
      u.dispatchEvent(new Event(t, { bubbles: true }));
      p.dispatchEvent(new Event(t, { bubbles: true }));
    });
    window.__qfShellFilling = false;
  }

  // 2.5) 登录页许可入口（2.3.1 阶段 E，16:37 定版）：登录/注册区最后一行
  // 「购买密钥」黑底白字、其下「查询密钥」蓝色无边框文字链。服务端登录页
  // 模板已有同 id 的两行（qfBuyKeyRow/qfQueryKeyRow）时不重复注入——其
  // 相对 href（/purchase、/license/status）落在直连控制台源上不可用，
  // 由主进程 will-navigate 拦截改走扩展源壳内打开（与安卓登录桥接管
  // 点击同口径，不改样式不改位置）；页面没有这两行时才补注入同位同式
  // 的两行，href 同为上述路径、同样走主进程拦截。
  if (!document.getElementById('qfBuyKeyRow') && !document.getElementById('qfQueryKeyRow') &&
      !document.getElementById('qfLicenseRows')) {
    var panel = document.getElementById('loginpanel');
    if (panel) {
      var lbox = document.createElement('div');
      lbox.id = 'qfLicenseRows';
      lbox.style.cssText = 'box-sizing:border-box;width:280px;margin:14px auto 2px auto';
      var buyA = document.createElement('a');
      buyA.id = 'qfBuyKeyRowShell';
      buyA.href = '/purchase';
      buyA.textContent = '购买密钥';
      buyA.style.cssText = 'display:block;text-align:center;background:#111;color:#fff;border:0;border-radius:9px;padding:11px 0;font-size:15px;text-decoration:none;cursor:pointer';
      var queryA = document.createElement('a');
      queryA.id = 'qfQueryKeyRowShell';
      queryA.href = '/license/status';
      queryA.textContent = '查询密钥';
      queryA.style.cssText = 'display:block;text-align:center;color:#2470E0;font-size:14px;padding:10px 0 2px 0;text-decoration:none;background:none;border:0;cursor:pointer';
      var rebindA = document.createElement('a');
      rebindA.id = 'qfRebindRowShell';
      rebindA.href = '/license/rebind';
      rebindA.textContent = '申诉换绑设备';
      rebindA.style.cssText = 'display:block;text-align:center;color:#2470E0;font-size:14px;padding:4px 0 2px 0;text-decoration:none;background:none;border:0;cursor:pointer';
      lbox.appendChild(buyA);
      lbox.appendChild(queryA);
      lbox.appendChild(rebindA);
      panel.appendChild(lbox);
    }
  }
  // 服务端模板已有「申诉换绑设备」行（qfRebindRow）时：其 href 是临时通道
  // 绝对地址，壳内点击改走控制台源相对路径，由主进程 will-navigate 拦截
  // 改开扩展源换绑页并自动带入本机设备码（§11.9 须由新设备本人提交）。
  var srvRebind = document.getElementById('qfRebindRow');
  if (srvRebind && !srvRebind.dataset.qfWired) {
    srvRebind.dataset.qfWired = '1';
    var rbLink = srvRebind.querySelector('a') || srvRebind;
    rbLink.addEventListener('click', function (e) {
      e.preventDefault();
      window.location.href = '/license/rebind';
    });
  }

  // 3) 钩子只装一次
  if (!window.__qfShellHooks) {
    window.__qfShellHooks = true;
    var stash = function () {
      var uu = document.getElementById('username');
      var pp = document.getElementById('password');
      var rp = document.getElementById('qfRememberPassword');
      var rd = document.getElementById('qfRememberDevice');
      try {
        if (uu && pp && uu.value && pp.value) {
          sessionStorage.setItem(PENDING, JSON.stringify({
            src: 'shell', u: uu.value, p: pp.value,
            rp: !!(rp && rp.checked), rd: !!(rd && rd.checked),
            auto: false, ts: Date.now()
          }));
        } else {
          sessionStorage.removeItem(PENDING);
        }
      } catch (e) { /* ignore */ }
    };
    document.addEventListener('click', function (e) {
      if (e.target && e.target.id === 'loginButton') stash();
    }, true);
    form.addEventListener('submit', stash);
    // 用户亲手清空已回填的输入框 -> 清除信号（主进程据此清保险箱）
    var onInput = function (e) {
      if (window.__qfShellFilling) return;
      try {
        var base = window.__qfShellFilled || { u: '', p: '' };
        var uu = document.getElementById('username');
        var pp = document.getElementById('password');
        if ((base.u && uu && uu.value === '') || (base.p && pp && pp.value === '')) {
          sessionStorage.setItem(CLEARED, '1');
        }
      } catch (err) { /* ignore */ }
    };
    u.addEventListener('input', onInput);
    p.addEventListener('input', onInput);
  }
  return { ok: true, pwBox: !!pwBox, filled: !!filledP, loginVisible: vis(document.getElementById('loginpanel')) };
}

// 控制台页守卫：盯手动退出点击，留下标记（退出后跳登录页，主进程在那边读到）
function pageGuard() {
  if (window.__qfShellGuard) return { ok: true, already: true };
  window.__qfShellGuard = true;
  document.addEventListener('click', function (e) {
    var n = e.target;
    var hops = 0;
    while (n && hops < 6) {
      var href = (n.getAttribute && n.getAttribute('href')) || '';
      var id = n.id || '';
      var text = (n.textContent || '').trim();
      if (href.indexOf('logout') >= 0 || id === 'logoutMenuOption' ||
          ((id === 'logoutControl' || (n.closest && n.closest('#logoutControl'))) && (text.indexOf('退出') >= 0 || /logout/i.test(text)))) {
        try { sessionStorage.setItem('qfShellManualLogout', '1'); } catch (err) { /* ignore */ }
        return;
      }
      n = n.parentElement;
      hops++;
    }
  }, true);
  return { ok: true };
}

// 页面状态检测：主进程每次加载完都跑一遍，据此走收割/恢复/注入
function pageDetect() {
  function vis(el) {
    if (!el) return false;
    var s = window.getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden') return false;
    var r = el.getBoundingClientRect();
    return r.width > 0 || r.height > 0;
  }
  var out = { state: 'other', failedBanner: false, failureText: '', manualLogout: false, fieldsCleared: false, pending: null, username: '' };
  try { out.manualLogout = sessionStorage.getItem('qfShellManualLogout') === '1'; } catch (e) { /* ignore */ }
  try { out.fieldsCleared = sessionStorage.getItem('qfShellFieldsCleared') === '1'; } catch (e) { /* ignore */ }
  try {
    var raw = sessionStorage.getItem('qfShellPendingLogin');
    if (raw) out.pending = JSON.parse(raw);
  } catch (e) { /* ignore */ }
  var form = document.getElementById('loginpanelform');
  if (form) {
    var tokenPanel = document.getElementById('tokenpanel');
    var waitPanel = document.getElementById('waitpushpanel');
    if ((tokenPanel && vis(tokenPanel)) || (waitPanel && vis(waitPanel))) { out.state = 'token'; return out; }
    out.state = 'login';
    var msg = document.getElementById('message1');
    var text = msg ? (msg.textContent || '') : '';
    var pats = ['登录失败', '账号已被锁定', '已被锁定', '暂时限制', '安全验证未通过'];
    for (var i = 0; i < pats.length; i++) {
      if (text.indexOf(pats[i]) >= 0) { out.failedBanner = true; out.failureText = text.trim().slice(0, 120); break; }
    }
    return out;
  }
  if (document.getElementById('logoutControl') || document.getElementById('masthead') ||
      document.getElementById('topMenu') || document.getElementById('page_leftbar')) {
    out.state = 'console';
    return out;
  }
  // QFR 自家控制台（webapp，CONSOLE_URL）：原生 MC 标记一律没有——
  // 登录页是 #loginForm（#li-user/#li-pass，位于 #authRoot 内），控制台是
  // #shellRoot（非 hidden）。（3.0.0 首启触发器根因：本函数只认原生 MC 标记，
  // webapp 上登录成功后恒回 'other'，processAuthPage 的 console 分支永不跑，
  // maybeInstallSystemServices 永不触发。）
  var qfAuth = document.getElementById('authRoot');
  var qfShell = document.getElementById('shellRoot');
  if (document.getElementById('loginForm') && qfAuth && !qfAuth.hidden) {
    out.state = 'login';
    var qfErr = document.getElementById('li-err');
    if (qfErr && !qfErr.hidden) {
      var qfText = (qfErr.textContent || '').trim();
      if (qfText) { out.failedBanner = true; out.failureText = qfText.slice(0, 120); }
    }
    return out;
  }
  if (qfShell && !qfShell.hidden) {
    out.state = 'console';
    // 用户名：webapp 会话变量 S.user 为准（doLogin 成功时即写），DOM 兜底。
    try {
      if (typeof S !== 'undefined' && S && S.user) out.username = String(S.user);
    } catch (e) { /* ignore */ }
    if (!out.username) {
      try {
        var qfSmall = document.querySelector('.sideidtx small');
        if (qfSmall && qfSmall.textContent) out.username = qfSmall.textContent.trim();
      } catch (e) { /* ignore */ }
    }
    if (!out.username) {
      try {
        var qfLi = document.getElementById('li-user');
        if (qfLi && qfLi.value) out.username = String(qfLi.value).trim();
      } catch (e) { /* ignore */ }
    }
    return out;
  }
  return out;
}

function buildInjectScript(opts) {
  const o = {
    username: (opts && opts.username) || null,
    password: (opts && opts.password) || null,
    rememberPassword: !!(opts && opts.rememberPassword),
    rememberDevice: !!(opts && opts.rememberDevice)
  };
  return '(' + pageInject.toString() + ')(' + JSON.stringify(o) + ')';
}

const DETECT_JS = '(' + pageDetect.toString() + ')()';
const GUARD_JS = '(' + pageGuard.toString() + ')()';
const CLEAR_PAGE_STATE_JS = '(function(){try{sessionStorage.removeItem(' +
  JSON.stringify(PENDING_KEY) + ');sessionStorage.removeItem(' + JSON.stringify(LOGOUT_KEY) +
  ');sessionStorage.removeItem(' + JSON.stringify(CLEARED_KEY) + ');}catch(e){}return true;})()';

// ---------- 聊天静默解锁（2.3.0 H 线） ----------
// 聊天页经控制台单点登录拿到令牌后，聊天记录还锁在「用登录密码包装的
// 钥匙」里。站长口径：勾过「记住账号密码」→ 用保险箱里的登录密码静默
// 解开，不许再弹框要密码；没勾 → 页面已无解锁框，解不开即停手，页面
// 显示不可用提示。这里只做决策与注入脚本，真正的解开动作在聊天
// 页的 window.qfShellUnlock（chat-client.js）里完成。
function planChatUnlock(input) {
  const i = input || {};
  if (!i.hasCreds) return { action: 'none', reason: 'no-creds' };
  if (i.manualLogout) return { action: 'none', reason: 'manual-logout' };
  if (!i.hasToken) return { action: 'none', reason: 'no-chat-session' };
  if (i.unlocked) return { action: 'none', reason: 'already-unlocked' };
  if (!i.locked) return { action: 'none', reason: 'not-locked' };
  return { action: 'silent-unlock' };
}
// 页面脚本：调一次聊天页的 qfShellUnlock（等待与决策在主进程侧完成，
// 见 main.js 的 maybeChatUnlock＋planChatUnlock）。同页只试一次，解不开
// 不重试（防拿旧密码反复撞钥匙）。
function pageChatUnlock(password) {
  if (window.__qfShellUnlockTried) return 'already';
  window.__qfShellUnlockTried = true;
  if (typeof window.qfShellUnlock !== 'function') return 'no-hook';
  window.qfShellUnlock(password);
  return 'called';
}
function buildChatUnlockScript(password) {
  return '(' + pageChatUnlock.toString() + ')(' + JSON.stringify(String(password || '')) + ')';
}

// ---------- 聊天设备静默解锁（2.3.0 L 线） ----------
// 决策：页面已登录（hasToken）、仍锁定、且服务端存有本机「壳路径」设备
// 包裹副本时，用设备密钥静默解开；页面已解锁但尚无壳路径副本时，把
// 设备密钥递入页面在后台补写一份。与密码路径互不依赖：没勾记住账号
// 密码（无 creds）时本路径照常工作，这正是本线的核心场景。
function planChatDevice(input) {
  const i = input || {};
  if (i.manualLogout) return { action: 'none', reason: 'manual-logout' };
  if (!i.hasToken) return { action: 'none', reason: 'no-chat-session' };
  if (i.unlocked) {
    return i.hasShellDeviceCopy ? { action: 'none', reason: 'already-enrolled' } : { action: 'device-enroll' };
  }
  if (!i.locked) return { action: 'none', reason: 'not-locked' };
  if (!i.hasShellDeviceCopy) return { action: 'none', reason: 'no-device-copy' };
  return { action: 'device-unlock' };
}
// 页面脚本：每条路径在同一页面存活期内只递入一次（页面保活时不反复
// 递密钥）；解不开不重试。enroll 与 unlock 用独立标记，互不阻塞。
function pageChatDeviceUnlock(deviceKeyB64) {
  if (window.__qfShellDeviceUnlockTried) return 'already';
  window.__qfShellDeviceUnlockTried = true;
  if (typeof window.qfShellDeviceUnlock !== 'function') return 'no-hook';
  window.qfShellDeviceUnlock(deviceKeyB64);
  return 'called';
}
function pageChatDeviceEnroll(deviceKeyB64) {
  if (window.__qfShellDeviceEnrollTried) return 'already';
  window.__qfShellDeviceEnrollTried = true;
  if (typeof window.qfShellDeviceEnroll !== 'function') return 'no-hook';
  window.qfShellDeviceEnroll(deviceKeyB64);
  return 'called';
}
function buildChatDeviceUnlockScript(keyB64) {
  return '(' + pageChatDeviceUnlock.toString() + ')(' + JSON.stringify(String(keyB64 || '')) + ')';
}
function buildChatDeviceEnrollScript(keyB64) {
  return '(' + pageChatDeviceEnroll.toString() + ')(' + JSON.stringify(String(keyB64 || '')) + ')';
}

module.exports = {
  PENDING_KEY, LOGOUT_KEY, CLEARED_KEY,
  CONSOLE_HOST,
  isLogoutUrl, isLoginFailureText, FAILURE_PATTERNS,
  createAutoLoginPolicy, planHarvest, planChatUnlock,
  parseSetCookie, applySetCookies, clearConsoleSession,
  httpSilentLogin, httpProbeSession,
  buildInjectScript, buildChatUnlockScript, DETECT_JS, GUARD_JS, CLEAR_PAGE_STATE_JS,
  planChatDevice, buildChatDeviceUnlockScript, buildChatDeviceEnrollScript,
  _pageInject: pageInject, _pageDetect: pageDetect, _pageGuard: pageGuard, _pageChatUnlock: pageChatUnlock,
  _pageChatDeviceUnlock: pageChatDeviceUnlock, _pageChatDeviceEnroll: pageChatDeviceEnroll
};
