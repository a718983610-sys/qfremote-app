const { app, BaseWindow, BrowserWindow, WebContentsView, session, ipcMain, screen, clipboard, shell, safeStorage, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const http = require('http');
const svcUrlsMod = require('./svc-urls');
const viewsMod = require('./views');
const { createWatchdog } = require('./watchdog');
const updater = require('./update');
const agentHeal = require('./agent-heal');
const installerLaunch = require('./installer-launch');
const lockBridgeMod = require('./lock');
const credsMod = require('./creds');
const autologinMod = require('./autologin');
const deviceKeyMod = require('./device-key');
const licenseMod = require('./license');
const deviceCodeMod = require('./device-code');
const devicesMod = require('./devices');
const clientVersion = require('./client-version');
let BUILD_INFO = { buildDate: '' };
try { BUILD_INFO = require('./build-info.json'); } catch (e) { /* 开发环境缺失时用空值，关于面板显示 — */ }

// 2.4.2 紧急修复：服务器换 IP 后，写死旧 IP 的直连源全灭（旧 IP 已被
// 云厂商收回）。控制台与好友/聊天一律改走正式域名 app.qfremote.top 的
// 同名聚合路径（nginx 按路径反代引擎/好友服务），不再写死任何 IP。
const CONSOLE_URL = 'https://app.qfremote.top/';
// 好友页/聊天页（独立小服务 qfremote-friends）：经域名聚合路径 /friends、
// /chat 到达（与网页版同一入口）。免登口径（2.3.0 H 线纠正）：此前「免密
// 直达不成立」的真因是控制台会话绑了登录 IP、服务端校验时没把会话自带
// IP 带上（详见服务端好友 server.js 的 sessionIpFromCookie 注释）；服务
// 端已修复，壳内凭控制台会话直达成立。product.json 的 friendsUrl 只作备选。
const FRIENDS_URL = 'https://app.qfremote.top/friends';
const CHAT_URL = 'https://app.qfremote.top/chat';
// 壳内会话深链基址：与网页版同一规范源（SPA 的 QF_CANON_ORIGIN 同值）——
// 域名根路径是网页控制台，会话深链（?node=&viewmode=）只在引擎规范源
// /console-engine/ 下成立，故会话视图单独用这一基址拼深链（devices.js）。
const SESSION_BASE_URL = 'https://app.qfremote.top/console-engine/';
let FRIENDS_FALLBACK_URL = '';
// 论坛/注册/管理/积分服务地址（v2.2.0 改运行时解析，见 svc-urls.js）：
// 启动时拉官网 product.json 的 web.* 更新下面这组变量，拉不到用上次缓存、
// 再兜底 svc-urls.js 里的写死值（正式 Web 基座 app.qfremote.top，friendsUrl 同为域名聚合路径）。
let FORUM_URL = svcUrlsMod.FALLBACKS.forumUrl;
let REGISTER_URL = svcUrlsMod.FALLBACKS.registerUrl;
let ADMIN_URL = svcUrlsMod.FALLBACKS.adminUrl;
let POINTS_URL = svcUrlsMod.FALLBACKS.pointsUrl;
const ALLOWED_HOST = 'app.qfremote.top';
// 自家源识别（导航归类/版本头/退出拦截共用）：只认正式域名。端口口径：
// https 默认端口——URL.port 在默认端口时为空串，显式写出时为 '443'，两者都认。
// 注：这组常量只作「是不是自家页面」的识别，不再作证书放行依据（见下方
// certificate-error 处理：正式域名是公共 CA 证书，不放行任何证书错误）。
const ALLOWED_PORTS = ['443', ''];
const TOOLBAR_HEIGHT = 48;
const PREVIEW = process.env.QFREMOTE_PREVIEW || ''; // '', 'main', 'offline', 'splash'
const PREVIEW_DIR = process.env.QFREMOTE_PREVIEW_DIR || '';
const PREVIEW_THEME = process.env.QFREMOTE_PREVIEW_THEME || ''; // 仅预览自检：强制主题 'blue' | 'dark'
// 仅预览自检：探活目标可经环境变量改指（与生产相同的探活代码、仅路由不同）；
// 生产环境恒用正式域名源（2026-10-29 审计 J-2 定案，见下方探活节口径）
const PROBE_URL = (PREVIEW && process.env.QFREMOTE_PROBE_URL) ? process.env.QFREMOTE_PROBE_URL : 'https://app.qfremote.top/release.json';
const BG_DEEP = '#f4f7fb'; // 窗口底色与新版令牌底色对齐（亮主题页面底 #F4F7FB；深色仍 #17181c）

app.setName('QFRemote');
// 2.3.2 互联窗第一步：把运行时版本注入统一版本头模块（各请求出口共用，
// 服务端本版只记录观察；见 client-version.js 文件头口径）。
try { clientVersion.setClientVersion(app.getVersion()); } catch (e) { /* 回落 package.json 版本 */ }
if (process.platform === 'win32') app.setAppUserModelId('com.qfremote.desktop');
if (process.getuid && process.getuid() === 0) {
  app.commandLine.appendSwitch('no-sandbox');
  app.commandLine.appendSwitch('disable-gpu');
}
if (PREVIEW && process.env.QFREMOTE_PREVIEW_USERDATA) {
  try { app.setPath('userData', process.env.QFREMOTE_PREVIEW_USERDATA); } catch (e) { /* ignore */ }
}

// 证书处理：2.4.2 起全部自家页面走正式域名（公共 CA 签发，证书链正常），
// 旧自签直连源已退役——任何证书错误一律拒绝，不放行（与浏览器同口径）。
app.on('certificate-error', (event, webContents, url, error, certificate, callback) => {
  callback(false);
});

// ---------- 单开：重复双击只唤起已有窗口 ----------
let gotSingleLock = true;
if (!PREVIEW) {
  gotSingleLock = app.requestSingleInstanceLock();
  if (!gotSingleLock) {
    app.quit();
  } else {
    app.on('second-instance', () => {
      if (forceWin && !forceWin.isDestroyed()) { forceWin.focus(); return; }
      if (splash && !splash.isDestroyed()) { splash.focus(); return; }
      if (win) {
        if (win.isMinimized()) win.restore();
        if (!win.isVisible()) win.show();
        win.focus();
      }
    });
  }
}

// ---------- 设置（自启、窗口位置、缩放、置顶共用一份） ----------
function settingsFile() { return path.join(app.getPath('userData'), 'qf-settings.json'); }
function loadSettings() {
  try { return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch (e) { return {}; }
}
let settings = loadSettings();
// 服务地址解析器：缓存进 qf-settings.svcUrls（经 saveSettings 落盘）
const svcUrls = svcUrlsMod.createSvcUrls({
  loadCache: () => settings.svcUrls || null,
  saveCache: (obj) => { settings.svcUrls = obj; saveSettings(); },
  clientVersion: () => clientVersion.getClientVersion()
});
function applySvcUrls() {
  const a = svcUrls.all();
  FORUM_URL = a.forumUrl;
  REGISTER_URL = a.registerUrl;
  ADMIN_URL = a.adminUrl;
  POINTS_URL = a.pointsUrl;
  FRIENDS_FALLBACK_URL = a.friendsUrl && a.friendsUrl !== FRIENDS_URL ? a.friendsUrl : '';
}
applySvcUrls();

// ---------- 自动重新登录 + 记住账号密码（v2.3.0，机制在 autologin.js / creds.js） ----------
// 记住标记（勾没勾「记住此设备」、是不是手动退出）存 qf-settings.auth；
// 账号密码只进保险箱（系统加密落盘），绝不进 settings、不进日志、不进诊断。
if (!settings.auth || typeof settings.auth !== 'object') settings.auth = {};
const credStore = credsMod.createCredStore({
  file: path.join(app.getPath('userData'), 'qf-creds.json'),
  safeStorage
});
// 聊天设备密钥保险箱（L 线）：与凭据保险箱相互独立——退出登录不清设备
// 密钥（退出不等于换设备）；系统加密不可用时 ensure() 返回 null，聊天
// 页自动回退其内置的 WebCrypto 设备密钥路径。
const deviceKeyStore = deviceKeyMod.createDeviceKeyStore({
  file: path.join(app.getPath('userData'), 'qf-device-key.json'),
  safeStorage
});
// 本机设备码（2.3.1 许可体系）：上报/绑定用的稳定标识，生成一次恒定
// 不变、退出登录不清（见 device-code.js 文件头口径）。
const deviceCodeStore = deviceCodeMod.createDeviceCodeStore({
  file: path.join(app.getPath('userData'), 'qf-device-code.json'),
  safeStorage
});
// ---------- 许可门状态（2.3.1 阶段 E，口径与安卓阶段 D 同源） ----------
// gateCredsMemory：本次登录的账号＋密码只留内存（不落盘），供拦截面
// 领取转赠时走 §7.5.3 无会话核验入口（用户不重复输密码）；手动退出
// 时清掉，强制下线/待审终止时由终止流程保存恢复（见 gateTerminateSession）。
let gateDecision = null;       // 当前拦截判定（license.js parseDecision 形），null=未拦截
let gateUsername = '';         // 拦截面「当前账号」展示
let gateForced = false;        // 当前拦截来自会话已被终止的路径（forceLogout/待审）
let gateCredsMemory = null;    // {username, password} 仅内存
let licenseCheckedSession = false; // 本会话已跑过许可门检查（契约 §3 时机：会话建立后一次）
let licenseCheckBusy = false;
let licenseErrorToastShown = false; // 接口全失败的诚实提示每会话只出一次
let browsingExt = false;       // 首页视图正以「壳内网页」模式展示购买/查询/申诉/客服（带返回栏）
let extReturnGate = false;     // 返回栏回去后是否回到拦截面
let extReturnRecheck = false;  // 返回后是否复查许可（购买返回照安卓口径复查）
const authPolicy = autologinMod.createAutoLoginPolicy({ maxAttempts: 2 });
let authProcessing = false;
let silentLoginInFlight = false;
let pendingVerify = null; // { at: number, source: 'startup' | 'page' }
let authNoticePending = false;
const PENDING_VERIFY_TTL_MS = 20000;

let pendingVerifyTimer = null;
function setPendingVerify(source) {
  pendingVerify = { at: Date.now(), source: source || 'page' };
  // 复检兜底（门三第 8 项）：若裁定这次静默登录的 did-finish-load 恰好落在
  // authProcessing 窗口被早退吞掉，3 秒后主动再裁定一次，防 pendingVerify 悬空。
  if (pendingVerifyTimer) clearTimeout(pendingVerifyTimer);
  let rechecks = 0;
  const recheck = () => {
    pendingVerifyTimer = null;
    if (!pendingVerify) return;
    if (authProcessing && rechecks < 5) {
      // 复检自己又撞上处理中：别白触发，重挂再等一轮（门三 #8-1）
      rechecks += 1;
      pendingVerifyTimer = setTimeout(recheck, 3000);
      return;
    }
    processAuthPage().catch(() => {});
  };
  pendingVerifyTimer = setTimeout(recheck, 3000);
}
function clearPendingVerify() {
  pendingVerify = null;
  if (pendingVerifyTimer) { clearTimeout(pendingVerifyTimer); pendingVerifyTimer = null; }
}
function isPendingVerifyFresh() {
  return !!pendingVerify && (Date.now() - pendingVerify.at) <= PENDING_VERIFY_TTL_MS;
}
// 振荡熔断（门三第 10 项签收条件，我方增补）：短时窗内反复落登录页，说明会话被
// 持续失效（服务端会话策略/多端互踢/会话过期），此时「成功清零」会让失败断路器
// 失效，故单独计数：超阈值停手并提示，计数打进主进程日志备查。
const OSC_WINDOW_MS = 10 * 60 * 1000;
const OSC_MAX_LANDINGS = 6;
let loginLandings = []; // 落登录页时刻（毫秒）
let oscTripped = false;
let oscNoticeShown = false;
function noteLoginLanding() {
  const now = Date.now();
  loginLandings = loginLandings.filter((t) => now - t <= OSC_WINDOW_MS);
  loginLandings.push(now);
  try { console.log('[auth] login landing x' + loginLandings.length); } catch (e) { /* ignore */ }
  if (loginLandings.length >= OSC_MAX_LANDINGS) oscTripped = true;
  return oscTripped;
}
function resetOscillation() {
  loginLandings = [];
  oscTripped = false;
  oscNoticeShown = false;
}
function safeLoad(wc, url) {
  try {
    const p = wc.loadURL(url);
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch (e) { /* ignore */ }
}
let pendingManualClear = false; // 已命中退出、等回到登录页时把会话 cookie 清干净
function authSession() { return session.fromPartition('persist:qfremote'); }
let cookieFlushTimer = null;
function flushConsoleCookies() {
  try {
    const p = authSession().cookies.flushStore();
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch (e) { /* ignore */ }
}
function scheduleCookieFlush() {
  clearTimeout(cookieFlushTimer);
  cookieFlushTimer = setTimeout(flushConsoleCookies, 600);
}
// 手动退出（唯一人工终止）：三路检测任一命中都走这里——立刻清保险箱与
// 记住标记，会话 cookie 在回到登录页时清干净（见 processAuthPage）。
function handleManualLogout() {
  viewMgr.noteLogout();
  settings.auth.manualLogout = true;
  settings.auth.rememberDevice = false;
  pendingManualClear = true;
  try { credStore.clear(); } catch (e) { /* ignore */ }
  saveSettings();
  // 子会话级联终止（好友/聊天/论坛/管理）＋保活视图回落到各自起始页；
  // 与「正式退出登录」共用同一条路径，不另造平行退出。
  terminateSubSessions().catch(() => {});
  reloadSocialViewsToStart();
  // 许可门复位（2.3.1）：手动退出后内存核验凭据清掉、拦截消解、检查
  // 标记复位，下次登录成功重新按 §3 时机跑门检查；首页视图回空白，
  // 不许残留上一个账号的页面（设备码不清，口径见 device-code.js）。
  gateCredsMemory = null;
  gateDecision = null;
  gateForced = false;
  gateUsername = '';
  licenseCheckedSession = false;
  licenseErrorToastShown = false;
  browsingExt = false;
  extReturnGate = false;
  extReturnRecheck = false;
  homePreloaded = false;
  if (gateView && !gateView.webContents.isDestroyed()) { try { gateView.setVisible(false); } catch (e) { /* ignore */ } }
  if (extBarView && !extBarView.webContents.isDestroyed()) { try { extBarView.setVisible(false); } catch (e) { /* ignore */ } }
  if (homeView && !homeView.webContents.isDestroyed()) {
    try { homeView.webContents.loadURL('about:blank'); viewMgr.markUnloaded('home'); } catch (e) { /* ignore */ }
  }
  // 收编视图复位（2.3.2）：会话真正断开卸载、设备页清掉上个账号的清单
  devicesLanded = false;
  sessionCtx = null;
  if (sessionView && !sessionView.webContents.isDestroyed()) {
    try { sessionView.webContents.loadURL('about:blank'); viewMgr.markUnloaded('session'); } catch (e) { /* ignore */ }
  }
  if (devicesView && !devicesView.webContents.isDestroyed()) {
    try { devicesView.webContents.send('qf-devices-reset'); } catch (e) { /* ignore */ }
  }
}
// 子服务会话级联终止：复用 H 线各服务自己的退出端点（服务端会话作废＋
// 落单点登录抑制标记），请求走 extRequest 的整罐 cookie 转发；5 秒内去重，
// 避免多路检测命中时重复打。失败一律安静忽略（本地凭据与标记已先清）。
let lastSubTerminateAt = 0;
async function terminateSubSessions() {
  const now = Date.now();
  if (now - lastSubTerminateAt < 5000) return;
  lastSubTerminateAt = now;
  const targets = [];
  try { targets.push(new URL(FRIENDS_URL).origin + '/api/friends/logout'); } catch (e) { /* ignore */ }
  if (FRIENDS_FALLBACK_URL) { try { targets.push(new URL(FRIENDS_FALLBACK_URL).origin + '/api/friends/logout'); } catch (e) { /* ignore */ } }
  try { targets.push(svcUrls.forumApi('logout')); } catch (e) { /* ignore */ }
  try { targets.push(svcUrls.adminApi('logout')); } catch (e) { /* ignore */ }
  await Promise.all(targets.map((u) => extRequest('POST', u, {}).catch(() => null)));
}
function reloadSocialViewsToStart() {
  const starts = { friends: FRIENDS_URL, chat: CHAT_URL, forum: FORUM_URL };
  for (const k of Object.keys(starts)) {
    const v = socialViews[k];
    if (v && !v.webContents.isDestroyed()) {
      try { v.webContents.loadURL(starts[k]); viewMgr.markUnloaded(k); } catch (e) { /* ignore */ }
    }
  }
}
async function silentLoginWithCreds(creds) {
  try {
    const r = await autologinMod.httpSilentLogin({
      baseUrl: CONSOLE_URL,
      username: creds.username,
      password: creds.password,
      timeoutMs: 8000,
      clientVersion: clientVersion.getClientVersion()
    });

    // 只有非空 xid 才继续；302/200 的页面形状不再作为成功依据。
    if (!r.ok) return false;

    if (r.setCookies && r.setCookies.length) {
      const applied = await autologinMod.applySetCookies(authSession(), r.setCookies, CONSOLE_URL);
      // 服务端下发了 cookie 却一条都没写进去 = 会话根本没落地，必须判失败，
      // 不能静默当成功（门三存疑 1/S4）。个别条目失败但有成功写入则照常往下走，
      // 最终由页面状态裁定。
      if (!applied) return false;
    }
    flushConsoleCookies();

    // 探活仅作诊断/快速路径，不参与成败裁定；最终由页面 DETECT_JS 确认。
    // 不 await，避免探活超时拖慢 reload。
    (async () => {
      try {
        const cookies = await authSession().cookies.get({ url: CONSOLE_URL });
        const header = cookies.map((c) => c.name + '=' + c.value).join('; ');
        if (header) {
          await autologinMod.httpProbeSession({
            baseUrl: CONSOLE_URL,
            cookieHeader: header,
            timeoutMs: 5000,
            clientVersion: clientVersion.getClientVersion()
          });
        }
      } catch (e) { /* ignore */ }
    })();

    return true;
  } catch (e) {
    return false;
  }
}
function showAuthNotice(wc, text) {
  if (!wc || wc.isDestroyed()) return;
  const noticeText = text || '自动登录没有成功，请手动输入密码登录；如果密码改过，请用新密码登录一次。';
  const js = "(function(){ if (document.getElementById('qfAuthNotice')) return false;" +
    " var d=document.createElement('div'); d.id='qfAuthNotice';" +
    " d.textContent=" + JSON.stringify(noticeText) + ";" +
    " d.style.cssText='box-sizing:border-box;width:280px;margin:0 auto 8px auto;border-radius:4px;padding:8px;background:#FFF3CD;color:#664d03;font-size:13px;text-align:left';" +
    " var m=document.getElementById('message1');" +
    " var p=(m&&m.parentNode)?m.parentNode:(document.querySelector('form')||document.body);" +
    " if(!p) return false;" +
    " if(m&&m.parentNode){p.insertBefore(d,m.nextSibling);}else{p.insertBefore(d,p.firstChild);}" +
    " return true; })()";
  wc.executeJavaScript(js, true).catch(() => {});
}
async function processAuthPage() {
  if (PREVIEW || authProcessing) return;
  if (!view || view.webContents.isDestroyed()) return;
  const wc = view.webContents;
  if (!isTargetUrl(wc.getURL())) return;

  authProcessing = true;
  try {
    let det = null;
    try { det = await wc.executeJavaScript(autologinMod.DETECT_JS, true); } catch (e) { return; }
    if (!det || wc.isDestroyed()) return;

    // 先裁定上一次静默登录的 pendingVerify。
    // 手动退出/用户清框优先，不能误判为假成功。
    if (pendingVerify) {
      if (det.state === 'console') {
        clearPendingVerify(); // console 分支马上 noteSuccess
      } else if (det.state === 'login') {
        if (det.manualLogout || settings.auth.manualLogout || det.fieldsCleared) {
          clearPendingVerify();
        } else if (isPendingVerifyFresh()) {
          clearPendingVerify();
          authPolicy.noteFailure();
          showAuthNotice(wc);
          authNoticePending = false;
        } else {
          clearPendingVerify();
        }
      } else {
        // token 页说明密码已被接受，只是还要二次验证；不要在这里判失败。
        clearPendingVerify();
      }
    }

    // 振荡监控：非人工信号下又落登录页就计数；超阈值熔断停手并提示（第 10 项）。
    if (det.state === 'login' && !det.manualLogout && !settings.auth.manualLogout && !det.fieldsCleared) {
      if (noteLoginLanding() && !oscNoticeShown) {
        oscNoticeShown = true;
        authPolicy.noteFailure();
        showAuthNotice(wc, '登录状态反复失效，已停止自动登录；请手动登录一次，若仍反复请检查账号是否在其他设备上同时使用。');
      }
    }

    if (det.state === 'console') {
      if (det.pending && det.pending.u && det.pending.p) {
        gateCredsMemory = { username: det.pending.u, password: det.pending.p };
      }
      if (det.pending) {
        const plan = autologinMod.planHarvest(det.pending, 'success');
        if (plan.save) {
          try { credStore.save(plan.save.username, plan.save.password); } catch (e) { /* ignore */ }
        } else if (plan.clearVault) {
          try { credStore.clear(); } catch (e) { /* ignore */ }
        }
        if (plan.rememberDevice !== null) settings.auth.rememberDevice = plan.rememberDevice;
        if (plan.clearManualLogout) settings.auth.manualLogout = false;
        saveSettings();
        try { await wc.executeJavaScript(autologinMod.CLEAR_PAGE_STATE_JS, true); } catch (e) { /* ignore */ }
      } else if (settings.auth.manualLogout) {
        settings.auth.manualLogout = false;
        saveSettings();
      }

      authPolicy.noteSuccess();
      // 振荡计数只在「页面真实提交进的控制台」才清零（det.pending 在场）；
      // 壳静默登录进控制台不留 pending、不得清零，否则交替振荡永远攒不满阈值（门三 D-1）。
      if (det.pending) resetOscillation();
      authNoticePending = false;
      viewMgr.noteLogin();
      schedulePreload();

      if (!devicesLanded) {
        devicesLanded = true;
        try { showView('devices'); } catch (e) { /* ignore */ }
      }

      runLicenseGateCheck().catch(() => {});
      flushConsoleCookies();
      try { await wc.executeJavaScript(autologinMod.GUARD_JS, true); } catch (e) { /* ignore */ }
    } else if (det.state === 'login') {
      if (authNoticePending) {
        authNoticePending = false;
        showAuthNotice(wc);
      }

      if (det.manualLogout && !settings.auth.manualLogout) {
        try { await Promise.resolve(handleManualLogout()); } catch (e) { /* ignore */ }
        gateCredsMemory = null;
      }

      if (settings.auth.manualLogout || pendingManualClear) {
        pendingManualClear = false;
        gateCredsMemory = null;
        try { await autologinMod.clearConsoleSession(authSession(), CONSOLE_URL); } catch (e) { /* ignore */ }
        flushConsoleCookies();
        try { await wc.executeJavaScript(autologinMod.CLEAR_PAGE_STATE_JS, true); } catch (e) { /* ignore */ }
      }

      if (det.fieldsCleared) {
        try { credStore.clear(); } catch (e) { /* ignore */ }
        gateCredsMemory = null;
        try { await wc.executeJavaScript(autologinMod.CLEAR_PAGE_STATE_JS, true); } catch (e) { /* ignore */ }
        det = Object.assign({}, det, { fieldsCleared: false, pending: null });
      }

      let failed = !!det.failedBanner;
      if (det.pending) {
        try { await wc.executeJavaScript(autologinMod.CLEAR_PAGE_STATE_JS, true); } catch (e) { /* ignore */ }
      }

      const creds = (!settings.auth.manualLogout && credStore.has()) ? credStore.load() : null;
      const decision = authPolicy.decide({
        pageState: 'login',
        hasCreds: !!creds,
        manualLogout: !!settings.auth.manualLogout,
        failedBanner: failed
      });

      if (decision.action === 'silent-login' && creds && !oscTripped) {
        if (silentLoginInFlight) return; // startup 正在登录，等它 reload；不要双发 POST
        silentLoginInFlight = true;
        authPolicy.noteAttempt();
        let okLogin = false;
        try {
          okLogin = await silentLoginWithCreds(creds);
        } finally {
          silentLoginInFlight = false;
        }

        if (okLogin) {
          setPendingVerify('page');
          safeLoad(wc, CONSOLE_URL);
          return;
        }

        authPolicy.noteFailure();
        showAuthNotice(wc);
      }

      const fresh = (!settings.auth.manualLogout && credStore.has()) ? credStore.load() : null;
      try {
        await wc.executeJavaScript(autologinMod.buildInjectScript({
          username: fresh ? fresh.username : null,
          password: fresh ? fresh.password : null,
          rememberPassword: !!fresh,
          rememberDevice: !!settings.auth.rememberDevice
        }), true);
      } catch (e) { /* ignore */ }
    }
    // token 页不介入：等用户完成验证，进控制台时自然收割
  } finally {
    authProcessing = false;
  }
}
async function startupAuthFlow() {
  try {
    if (settings.auth.manualLogout) return;

    let header = '';
    try {
      const cookies = await authSession().cookies.get({ url: CONSOLE_URL });
      header = cookies.map((c) => c.name + '=' + c.value).join('; ');
    } catch (e) { /* ignore */ }

    if (header) {
      const probe = await autologinMod.httpProbeSession({
        baseUrl: CONSOLE_URL,
        cookieHeader: header,
        timeoutMs: 5000,
        clientVersion: clientVersion.getClientVersion()
      });
      // 只作快速路径；即使假阳性，页面落登录页后 processAuthPage 仍会兜底。
      // 这里绝不 noteSuccess。
      if (probe.alive) return;
    }

    if (!credStore.has()) return;
    const creds = credStore.load();
    if (!creds) return;
    if (silentLoginInFlight) return;

    const decision = authPolicy.decide({
      pageState: 'login',
      hasCreds: true,
      manualLogout: false,
      failedBanner: false
    });
    if (decision.action !== 'silent-login') return;

    silentLoginInFlight = true;
    authPolicy.noteAttempt();
    let okLogin = false;
    try {
      okLogin = await silentLoginWithCreds(creds);
    } finally {
      silentLoginInFlight = false;
    }

    if (okLogin) {
      setPendingVerify('startup');
      // 若页面已经加载在目标地址上，主动重载一次让 pendingVerify 得到裁定；
      // 若尚未加载，后续首次 loadURL 会触发 processAuthPage。
      try {
        if (view && !view.webContents.isDestroyed()) {
          const cur = view.webContents.getURL();
          if (cur && isTargetUrl(cur)) safeLoad(view.webContents, CONSOLE_URL);
        }
      } catch (e) { /* ignore */ }
    } else {
      authPolicy.noteFailure();
      authNoticePending = true;
      try {
        if (view && !view.webContents.isDestroyed()) showAuthNotice(view.webContents);
      } catch (e) { /* ignore */ }
    }
  } catch (e) { /* ignore */ }
}
function saveSettings() {
  try {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(settings));
  } catch (e) { /* ignore */ }
}
function applyAutoLaunchDefault() {
  if (!app.isPackaged || PREVIEW) return;
  if (settings.autoLaunchConfigured !== true) {
    try { app.setLoginItemSettings({ openAtLogin: true }); } catch (e) { /* ignore */ }
    settings.autoLaunchConfigured = true;
    saveSettings();
  }
}

// ---------- 主题（亮蓝 / 深灰深色，工具栏与三页联动，选择持久化） ----------
function currentTheme() {
  if (PREVIEW_THEME === 'dark' || PREVIEW_THEME === 'blue') return PREVIEW_THEME;
  return settings.theme === 'dark' ? 'dark' : 'blue';
}
function themeBg() { return currentTheme() === 'dark' ? '#17181c' : BG_DEEP; }
function contentBg() { return currentTheme() === 'dark' ? '#22242a' : '#0d2f66'; }

let win = null;
let view = null;
let toolbarView = null;
let splash = null;
let mainShown = false;
let splashBornAt = 0;
let offlineActive = false;
let consoleLoaded = false;
let friendsFallbackTried = false;
// ---------- 持久视图（2.3.0 M 线同框集成，决策层在 views.js） ----------
// 好友/聊天/论坛各是一块保活的 WebContentsView，与控制台视图并存于
// 同一主窗：切换 = 显示/隐藏，不重载、不白屏；控制台视图的状态
// （滚动/已选设备/远程会话）切走再切回原样在位。预加载策略：登录
// 成功后才开始，空闲分批（好友→聊天→论坛，步间 1200ms），论坛在
// 创建时后台完成令牌交接；登录页出现前绝不创建，不拖慢冷启动。
const viewMgr = viewsMod.createViewManager();
const socialViews = { friends: null, chat: null, forum: null };
// 首页视图（2.3.1）：扩展源 /home 正本的保活视图，与社交视图同级并存；
// 兼作购买/查询/申诉/客服等自有网页的壳内打开落点（browsingExt 模式）。
let homeView = null;
let homePreloaded = false;
// ---------- 收编设备页与会话视图（2.3.2 收编 Windows 线） ----------
// devicesView：新版设备页（本地页，设计令牌与新版一致），登录后默认落点；
// sessionView：壳内会话视图，复用既有会话通道（控制台源深链），会话期间
// 盖住内容区，顶部配壳内会话栏（sessionBarView）；断开＝真正卸载会话页。
let devicesView = null;
let sessionView = null;
let sessionBarView = null;
const SESSION_BAR_HEIGHT = 40;
let sessionCtx = null;      // { nodeId, name, mode } 当前会话，null=无会话
let devicesLanded = false;   // 本次登录已自动落过设备页（每会话一次）
// 许可拦截面与壳内网页返回栏（2.3.1）：本地页视图，盖在内容区之上。
let gateView = null;
let extBarView = null;
const EXT_BAR_HEIGHT = 40;
let consoleSes = null;
let preloadTimer = null;
function urlCtx() {
  return { consoleUrl: CONSOLE_URL, friendsUrl: FRIENDS_URL, chatUrl: CHAT_URL, forumUrl: FORUM_URL, extUrl: svcUrls.homeUrl() };
}
function socialUrls() { return { friends: FRIENDS_URL, chat: CHAT_URL, forum: FORUM_URL, home: svcUrls.homeUrl() }; }
function activeKey() { return viewMgr.state().active; }
function activeWc() {
  if (browsingExt && homeView && !homeView.webContents.isDestroyed()) return homeView.webContents;
  const k = activeKey();
  if (k === 'console') return (view && !view.webContents.isDestroyed()) ? view.webContents : null;
  if (k === 'home') return (homeView && !homeView.webContents.isDestroyed()) ? homeView.webContents : null;
  if (k === 'devices') return (devicesView && !devicesView.webContents.isDestroyed()) ? devicesView.webContents : null;
  if (k === 'session') return (sessionView && !sessionView.webContents.isDestroyed()) ? sessionView.webContents : null;
  const v = socialViews[k];
  return (v && !v.webContents.isDestroyed()) ? v.webContents : null;
}
function broadcastViewState() {
  if (toolbarView && !toolbarView.webContents.isDestroyed()) {
    toolbarView.webContents.send('qf-view-state', activeKey());
  }
}
let failStreak = 0;
let watchdog = null;

function layout() {
  if (!win || !view || !toolbarView) return;
  const { width, height } = win.getContentBounds();
  toolbarView.setBounds({ x: 0, y: 0, width, height: TOOLBAR_HEIGHT });
  const rect = { x: 0, y: TOOLBAR_HEIGHT, width, height: Math.max(0, height - TOOLBAR_HEIGHT) };
  view.setBounds(rect);
  for (const k of Object.keys(socialViews)) {
    if (socialViews[k]) { try { socialViews[k].setBounds(rect); } catch (e) { /* ignore */ } }
  }
  // 首页视图：壳内网页模式下让出顶部返回栏的高度，其余时候占满内容区
  if (homeView) {
    const hr = browsingExt
      ? { x: 0, y: TOOLBAR_HEIGHT + EXT_BAR_HEIGHT, width, height: Math.max(0, height - TOOLBAR_HEIGHT - EXT_BAR_HEIGHT) }
      : rect;
    try { homeView.setBounds(hr); } catch (e) { /* ignore */ }
  }
  if (devicesView) { try { devicesView.setBounds(rect); } catch (e) { /* ignore */ } }
  if (sessionBarView) {
    try { sessionBarView.setBounds({ x: 0, y: TOOLBAR_HEIGHT, width, height: SESSION_BAR_HEIGHT }); } catch (e) { /* ignore */ }
  }
  if (sessionView) {
    const sr = { x: 0, y: TOOLBAR_HEIGHT + SESSION_BAR_HEIGHT, width, height: Math.max(0, height - TOOLBAR_HEIGHT - SESSION_BAR_HEIGHT) };
    try { sessionView.setBounds(sr); } catch (e) { /* ignore */ }
  }
  if (extBarView) {
    try { extBarView.setBounds({ x: 0, y: TOOLBAR_HEIGHT, width, height: EXT_BAR_HEIGHT }); } catch (e) { /* ignore */ }
  }
  if (gateView) { try { gateView.setBounds(rect); } catch (e) { /* ignore */ } }
}
function applyViewVisibility() {
  if (!win || !view) return;
  const k = activeKey();
  // 壳内网页模式（购买/查询/申诉/客服）：首页视图＋返回栏在最上，拦截面暂隐
  // 拦截面（gateDecision 在位）：盖住全部内容视图，工具栏（窗口控制）保留可用
  const showGate = !!gateDecision && !browsingExt;
  try { view.setVisible(!browsingExt && !showGate && k === 'console'); } catch (e) { /* ignore */ }
  for (const key of Object.keys(socialViews)) {
    if (socialViews[key]) { try { socialViews[key].setVisible(!browsingExt && !showGate && key === k); } catch (e) { /* ignore */ } }
  }
  if (homeView) { try { homeView.setVisible(browsingExt || (!showGate && k === 'home')); } catch (e) { /* ignore */ } }
  if (devicesView) { try { devicesView.setVisible(!browsingExt && !showGate && k === 'devices'); } catch (e) { /* ignore */ } }
  if (sessionView) { try { sessionView.setVisible(!browsingExt && !showGate && k === 'session'); } catch (e) { /* ignore */ } }
  if (sessionBarView) { try { sessionBarView.setVisible(!browsingExt && !showGate && k === 'session'); } catch (e) { /* ignore */ } }
  if (extBarView) { try { extBarView.setVisible(browsingExt); } catch (e) { /* ignore */ } }
  if (gateView) { try { gateView.setVisible(showGate); } catch (e) { /* ignore */ } }
}

function showMain() {
  if (mainShown || !win) return;
  mainShown = true;
  if (splash && !splash.isDestroyed()) splash.close();
  splash = null;
  win.show();
  win.focus();
}

function scheduleShowMain() {
  // 启动画面至少停留一小段，让「启动 -> 主窗」衔接平稳，不闪烁
  const wait = Math.max(0, 850 - (Date.now() - splashBornAt));
  setTimeout(showMain, wait);
}

function createSplash() {
  splashBornAt = Date.now();
  const splashSize = clampSizeToWorkArea(520, 360);
  splash = new BrowserWindow({
    width: splashSize.width,
    height: splashSize.height,
    frame: false,
    resizable: false,
    movable: false,
    center: true,
    show: true,
    backgroundColor: themeBg(),
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false }
  });
  splash.loadFile(path.join(__dirname, 'splash.html'), { query: { v: app.getVersion(), t: currentTheme() } });
  if (PREVIEW === 'splash') {
    splash.webContents.once('did-finish-load', () => setTimeout(captureSplashPreview, 700));
  }
}

function validBounds(b) {
  if (!b || typeof b.width !== 'number' || b.width < 900 || b.height < 600) return null;
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  const onScreen = screen.getAllDisplays().some(dsp => {
    const a = dsp.workArea;
    return cx >= a.x - 80 && cx <= a.x + a.width + 80 && cy >= a.y - 40 && cy <= a.y + a.height + 80;
  });
  return onScreen ? b : null;
}

// 窗口尺寸收口（2.3.0 适配）：任何窗口都不许比所在显示器的可用区更大——
// 小屏（800×600/720p）、高 DPI 缩放后可用区变小（如 720p@150% 只剩约
// 853×480 DIP）、窗口尺寸是从更大的屏幕存下来的，这三种情况都会把窗口
// 顶出屏幕。取不到显示器信息时原样返回，绝不因此打不开窗。
function clampSizeToWorkArea(width, height, refPoint) {
  try {
    const dsp = refPoint ? screen.getDisplayNearestPoint(refPoint) : screen.getPrimaryDisplay();
    const wa = dsp.workArea;
    return { width: Math.min(width, wa.width), height: Math.min(height, wa.height), workArea: wa };
  } catch (e) { return { width, height, workArea: null }; }
}

let saveBoundsTimer = null;
function persistBounds() {
  if (PREVIEW || !win) return;
  clearTimeout(saveBoundsTimer);
  saveBoundsTimer = setTimeout(() => {
    if (!win || win.isDestroyed()) return;
    settings.windowMaximized = win.isMaximized();
    if (!win.isMaximized() && !win.isFullScreen()) settings.windowBounds = win.getBounds();
    saveSettings();
  }, 400);
}

function isTargetUrl(raw) {
  try {
    const u = new URL(raw);
    return u.hostname === ALLOWED_HOST && ALLOWED_PORTS.includes(u.port);
  } catch (e) { return false; }
}

// ---------- 诊断计数（轻量持久计数，进既有设置存储，供「复制诊断信息」用） ----------
function bumpStat(key) {
  if (!settings.stats || typeof settings.stats !== 'object') settings.stats = {};
  settings.stats[key] = (settings.stats[key] || 0) + 1;
  saveSettings();
}

function showOfflinePage(rethemeOnly) {
  offlineActive = true;
  if (!rethemeOnly) { failStreak++; bumpStat('offlineCount'); }
  // 退避：5s -> 10s -> 20s -> 30s 封顶，由断线页倒计时自动再试，用户也可立即重试
  const delay = Math.min(5 * Math.pow(2, Math.max(0, failStreak - 1)), 30);
  view.webContents.loadFile(path.join(__dirname, 'offline.html'), {
    query: { u: CONSOLE_URL, d: String(delay), try: String(failStreak), t: currentTheme() }
  });
}

function attachViewEvents() {
  const wc = view.webContents;

  wc.setWindowOpenHandler(({ url }) => {
    const lt = licenseMod.licenseNavTarget(url, ALLOWED_HOST);
    if (lt) { openExtPage(lt).catch(() => {}); return { action: 'deny' }; }
    const wt = viewsMod.wrapperTarget(url);
    if (wt) { showView(wt); return { action: 'deny' }; }
    const k = viewsMod.classifyUrl(url, urlCtx());
    if (k && k !== 'console') { showView(k); return { action: 'deny' }; }
    if (isTargetUrl(url)) wc.loadURL(url);
    return { action: 'deny' };
  });
  // 登录页许可入口（16:37 定版）：服务端两行的相对 href 落在直连控制台
  // 源上不可用——拦截导航，改走扩展源壳内打开（与安卓接管点击同口径）。
  wc.on('will-navigate', (event, url) => {
    const lt = licenseMod.licenseNavTarget(url, ALLOWED_HOST);
    if (lt) { event.preventDefault(); openExtPage(lt).catch(() => {}); }
  });

  // 控制台页内点向好友/聊天/论坛的链接（控制台皮肤的「好友」入口等）：
  // 不把控制台视图导航走，改为切到对应的保活视图，控制台状态不丢。
  wc.on('will-navigate', (event, url) => {
    const wt = viewsMod.wrapperTarget(url);
    if (wt) { event.preventDefault(); showView(wt); return; }
    const k = viewsMod.classifyUrl(url, urlCtx());
    if (k && k !== 'console') { event.preventDefault(); showView(k); }
  });

  // 手动退出检测（第二路：页面导航）：跳向 /logout 即视为本人亲手退出
  wc.on('will-navigate', (event, url) => {
    if (autologinMod.isLogoutUrl(url)) handleManualLogout();
  });

  // 整页加载失败 -> 自家断线友好页（只拦主框架、只拦目标主机；
  // -3 是被新导航打断的正常中止，不算失败）
  wc.on('did-fail-load', (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return;
    if (!isTargetUrl(validatedURL)) return;
    // 好友页打不开且有备选地址时试一次备选（地址备选，不是免密承诺）
    if (validatedURL.startsWith(FRIENDS_URL) && FRIENDS_FALLBACK_URL && !friendsFallbackTried) {
      friendsFallbackTried = true;
      wc.loadURL(FRIENDS_FALLBACK_URL);
      return;
    }
    showOfflinePage();
  });

  wc.on('did-finish-load', () => {
    const url = wc.getURL();
    if (isTargetUrl(url)) {
      offlineActive = false;
      failStreak = 0;
      if (url.startsWith(CONSOLE_URL)) {
        consoleLoaded = true;
        friendsFallbackTried = false;
        checkAdminStatus();
      }
    }
    if (!mainShown && PREVIEW !== 'offline') scheduleShowMain();
    if (PREVIEW === 'offline' && url.startsWith('file:') && url.includes('offline.html')) {
      setTimeout(captureWindowPreview, 900);
    }
    // 自动重新登录/记住账号密码：每页加载完过一遍（函数内自判页面类型）
    processAuthPage().catch(() => {});
    // 聊天静默解锁：落在聊天页时过一遍（函数内自判地址与前置条件）
    maybeChatUnlock(url).catch(() => {});
  });
  // 聊天页保活期间的页内导航也重触发一次静默解锁（L 线补丁二.4）
  wc.on('did-navigate', () => {
    const u2 = wc.getURL();
    if (u2 && u2.startsWith(CHAT_URL_PREFIX)) maybeChatUnlock(u2, wc).catch(() => {});
  });
}

// ---------- 缩放（阶梯式，带百分比广播与持久化） ----------
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2.0;
function currentZoom() {
  const z = typeof settings.zoomFactor === 'number' ? settings.zoomFactor : 1;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
}
function broadcastZoom() {
  if (toolbarView) toolbarView.webContents.send('qf-zoom-state', Math.round(currentZoom() * 100));
}
function applyZoom() {
  if (!view) return;
  view.webContents.setZoomFactor(currentZoom());
  for (const k of Object.keys(socialViews)) {
    if (socialViews[k] && !socialViews[k].webContents.isDestroyed()) {
      try { socialViews[k].webContents.setZoomFactor(currentZoom()); } catch (e) { /* ignore */ }
    }
  }
  if (homeView && !homeView.webContents.isDestroyed()) {
    try { homeView.webContents.setZoomFactor(currentZoom()); } catch (e) { /* ignore */ }
  }
  if (devicesView && !devicesView.webContents.isDestroyed()) {
    try { devicesView.webContents.setZoomFactor(currentZoom()); } catch (e) { /* ignore */ }
  }
  if (sessionView && !sessionView.webContents.isDestroyed()) {
    try { sessionView.webContents.setZoomFactor(currentZoom()); } catch (e) { /* ignore */ }
  }
  broadcastZoom();
}
function zoomStep(action) {
  let z = currentZoom();
  if (action === 'in') z = Math.min(ZOOM_MAX, z * 1.1);
  else if (action === 'out') z = Math.max(ZOOM_MIN, z / 1.1);
  else if (action === 'reset') z = 1;
  settings.zoomFactor = Math.round(z * 1000) / 1000;
  saveSettings();
  applyZoom();
}

// ---------- 全屏 / 置顶 ----------
function broadcastFs() {
  if (toolbarView && win) toolbarView.webContents.send('qf-fs-state', win.isFullScreen());
}
function toggleFullscreen() {
  if (!win) return;
  win.setFullScreen(!win.isFullScreen());
}
function broadcastTop() {
  if (toolbarView && win) toolbarView.webContents.send('qf-top-state', win.isAlwaysOnTop());
}
function toggleTop() {
  if (!win) return;
  const next = !win.isAlwaysOnTop();
  win.setAlwaysOnTop(next);
  settings.alwaysOnTop = next;
  saveSettings();
  broadcastTop();
}

// 快捷键（v1.0.3 补全，挂在内容与工具栏两处，焦点在哪都管用）：
//   F5 刷新页面 / F9 截图 / F10 窗口置顶 / F11 全屏 / Ctrl+加/减/0 缩放
// 选键原则：避开控制台内页（MeshCentral 远程桌面）常用组合——不用 Ctrl+R（远程程序常用）、
// 不用 Ctrl+Shift+S（浏览器截图类占用）、不用 Alt 系（远程窗口菜单键）；F 键排成一列好记。
function attachShortcuts(wc) {
  wc.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F11') { toggleFullscreen(); event.preventDefault(); return; }
    if (input.key === 'F5') { const awc = activeWc(); if (awc) awc.reload(); event.preventDefault(); return; }
    if (input.key === 'F9') { doScreenshot(); event.preventDefault(); return; }
    if (input.key === 'F10') { toggleTop(); event.preventDefault(); return; }
    if (input.control || input.meta) {
      if (input.key === '=' || input.key === '+') { zoomStep('in'); event.preventDefault(); }
      else if (input.key === '-') { zoomStep('out'); event.preventDefault(); }
      else if (input.key === '0') { zoomStep('reset'); event.preventDefault(); }
    }
  });
}

function createWindow() {
  const saved = PREVIEW ? null : validBounds(settings.windowBounds);
  let bw = saved ? saved.width : 1280;
  let bh = saved ? saved.height : 820;
  let bx = saved ? saved.x : undefined;
  let by = saved ? saved.y : undefined;
  // 尺寸收进所在显示器的可用区、位置随之拉回区内：存档来自更大屏幕、
  // 或当前屏比默认尺寸还小时，窗口不再溢出屏幕（低于最小尺寸时以最小
  // 尺寸为准，那是无边框窗的硬下限，见 clamp 后 Math.max 一行）。
  try {
    const wa = (saved
      ? screen.getDisplayNearestPoint({ x: Math.round(saved.x + saved.width / 2), y: Math.round(saved.y + saved.height / 2) })
      : screen.getPrimaryDisplay()).workArea;
    bw = Math.max(900, Math.min(bw, wa.width));
    bh = Math.max(600, Math.min(bh, wa.height));
    if (bx !== undefined) bx = Math.min(Math.max(bx, wa.x), Math.max(wa.x, wa.x + wa.width - bw));
    if (by !== undefined) by = Math.min(Math.max(by, wa.y), Math.max(wa.y, wa.y + wa.height - bh));
  } catch (e) { /* 取不到显示器信息时按原尺寸/位置开窗 */ }
  win = new BaseWindow({
    width: bw,
    height: bh,
    x: bx,
    y: by,
    minWidth: 900,
    minHeight: 600,
    frame: false,
    title: 'QFRemote',
    backgroundColor: themeBg(),
    icon: path.join(__dirname, 'build', 'icon.png'),
    show: false
  });
  if (saved && settings.windowMaximized) win.maximize();
  if (!PREVIEW && settings.alwaysOnTop) win.setAlwaysOnTop(true);

  toolbarView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'toolbar-preload.js'),
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false
    }
  });
  toolbarView.webContents.loadFile(path.join(__dirname, 'toolbar.html'));
  toolbarView.webContents.on('did-finish-load', () => broadcastAdmin());
  win.contentView.addChildView(toolbarView);

  const ses = session.fromPartition('persist:qfremote');
  consoleSes = ses;
  // 会话 cookie 有变动就及时刷盘：崩溃/强退也不丢登录态（自动恢复第一顺位）
  try { ses.cookies.on('changed', () => scheduleCookieFlush()); } catch (e) { /* ignore */ }
  // 手动退出检测（第一路：会话请求拦截，/logout 请求一出就记下）
  if (PREVIEW !== 'offline') {
    try {
      ses.webRequest.onBeforeRequest({ urls: ['*://' + ALLOWED_HOST + '/logout*'] }, (details, cb) => {
        handleManualLogout();
        cb({});
      });
    } catch (e) { /* ignore */ }
  }
  // 2.3.2 版本头（网页侧出口）：控制台/好友/聊天/扩展页等经本会话发往
  // 自家服务的页面请求统一带 x-qf-client-version。只认自家主机与
  // svc-urls 解析出的自家服务源，绝不给第三方地址带头。
  try {
    ses.webRequest.onBeforeSendHeaders({ urls: ['https://*/*'] }, (details, cb) => {
      try {
        const u = new URL(details.url);
        let self = (u.hostname === ALLOWED_HOST);
        if (!self) {
          const origins = new Set();
          try { origins.add(new URL(svcUrls.extOrigin()).origin); } catch (e) { /* ignore */ }
          try { origins.add(new URL(svcUrls.get('pointsUrl')).origin); } catch (e) { /* ignore */ }
          try { origins.add(new URL(svcUrls.get('forumUrl')).origin); } catch (e) { /* ignore */ }
          try { origins.add(new URL(svcUrls.get('friendsUrl')).origin); } catch (e) { /* ignore */ }
          self = origins.has(u.origin);
        }
        if (self) {
          const h = Object.assign({}, details.requestHeaders);
          clientVersion.withClientVersion(h);
          cb({ requestHeaders: h });
          return;
        }
      } catch (e) { /* 解析失败照常放行、不带头 */ }
      cb({ requestHeaders: details.requestHeaders });
    });
  } catch (e) { /* ignore */ }
  // 仅预览自检用：本地拦截目标请求，人为制造整页加载失败，
  // 走真实的 did-fail-load -> 断线友好页路径出渲染图（生产环境无此逻辑）
  if (PREVIEW === 'offline') {
    ses.webRequest.onBeforeRequest({ urls: [CONSOLE_URL + '*'] }, (details, cb) => cb({ cancel: true }));
  }
  view = new WebContentsView({
    webPreferences: { session: ses, contextIsolation: true, sandbox: true, backgroundThrottling: false }
  });
  view.setBackgroundColor(contentBg()); // 内容还没画出来时先垫主题底色，杜绝白屏闪烁
  win.contentView.addChildView(view);

  attachViewEvents();
  attachShortcuts(view.webContents);
  attachShortcuts(toolbarView.webContents);
  applyZoom();

  win.on('resize', () => { layout(); persistBounds(); });
  win.on('move', persistBounds);
  win.on('maximize', persistBounds);
  win.on('unmaximize', persistBounds);
  win.on('enter-full-screen', broadcastFs);
  win.on('leave-full-screen', broadcastFs);
  win.on('close', () => {
    if (!PREVIEW && win && !win.isDestroyed()) {
      settings.windowMaximized = win.isMaximized();
      if (!win.isMaximized() && !win.isFullScreen()) settings.windowBounds = win.getBounds();
      saveSettings();
    }
  });
  win.on('closed', () => { win = null; view = null; toolbarView = null; socialViews.friends = null; socialViews.chat = null; socialViews.forum = null; homeView = null; gateView = null; extBarView = null; });

  if (PREVIEW === 'main' || PREVIEW === 'update') {
    view.webContents.loadFile(path.join(__dirname, 'loading.html'), { query: { t: currentTheme() } });
    win.show();
    mainShown = true;
    if (PREVIEW === 'update') {
      // 更新自测：等自动检查出结果 -> 开关于面板截图 -> 驱动点「下载更新」-> 下完核对后截图
      setTimeout(runUpdatePreviewFlow, 800);
    } else {
      let ready = 0;
      const onReady = () => { if (++ready >= 2) setTimeout(captureWindowPreview, 2600); }; // 等探活出结果再截，状态灯才是真实状态
      toolbarView.webContents.once('did-finish-load', onReady);
      view.webContents.once('did-finish-load', onReady);
      setTimeout(() => captureWindowPreview(), 6000); // 兜底
    }
  } else {
    if (PREVIEW !== 'offline') createSplash();
    else { win.show(); mainShown = true; }
    setTimeout(showMain, 15000); // 兜底：无论如何不把用户卡在启动画面
    setTimeout(() => { if (PREVIEW === 'offline') { captureWindowPreview(); } }, 25000);
    if (!PREVIEW) {
      // 先走启动恢复（探活持久会话/静默直提），再加载控制台，恢复不闪登录页
      startupAuthFlow().then(() => {
        if (view && !view.webContents.isDestroyed()) view.webContents.loadURL(CONSOLE_URL);
      }).catch(() => {
        if (view && !view.webContents.isDestroyed()) view.webContents.loadURL(CONSOLE_URL);
      });
    } else {
      view.webContents.loadURL(CONSOLE_URL);
    }
  }

  layout();
  startWatchdog();
  startProbeLoop();
  startPointsHeartbeat();
}

function startWatchdog() {
  if (PREVIEW || watchdog) return;
  watchdog = createWatchdog(() => (view ? view.webContents : null), {
    enabled: () => !!view && !offlineActive,
    onStatus: (state) => {
      if (toolbarView) toolbarView.webContents.send('qf-conn-status', state);
    },
    onReconnect: () => bumpStat('watchdogReconnectCount'),
    log: (msg) => { if (process.env.QFREMOTE_DEBUG) console.log('[watchdog]', msg); }
  });
  watchdog.start();
}

// ---------- 服务器探活（工具栏状态灯与关于面板的数据来源） ----------
// 只做一件事：定时向自家正式域名源发一个不带任何凭据的 HTTPS GET，看它
// 回不回、回什么状态码。2026-10-29 发版前审计 J-2 定案：探活改走正式域名
// 源（app.qfremote.top 的 release.json，Let's Encrypt 正规证书、Node 默认
// 校验），不再对自签直连源关闭证书校验——探活不发送数据、不参与任何信任
// 决策；真正的控制台页面始终走外壳顶部的证书校验（只认 ALLOWED_HOST 的
// ALLOWED_PORTS 两个自家地址）。
let lastProbe = { state: 'checking', ok: null, at: null, detail: '尚未检测', ms: null };
let probeTimer = null;
let probeInFlight = false;
function broadcastProbe() {
  if (toolbarView && !toolbarView.webContents.isDestroyed()) {
    toolbarView.webContents.send('qf-probe-state', lastProbe);
  }
}
function runProbe() {
  if (probeInFlight) return Promise.resolve(lastProbe);
  probeInFlight = true;
  const prev = lastProbe;
  lastProbe = { state: 'checking', ok: prev.ok, at: prev.at, detail: '检测中…', ms: null };
  broadcastProbe();
  const started = Date.now();
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok, detail) => {
      if (done) return;
      done = true;
      probeInFlight = false;
      lastProbe = { state: ok ? 'ok' : 'bad', ok, at: new Date().toISOString(), detail, ms: Date.now() - started };
      broadcastProbe();
      resolve(lastProbe);
    };
    try {
      const req = https.get(PROBE_URL, { timeout: 6000, headers: clientVersion.clientVersionHeaders() }, (res) => {
        res.resume();
        finish(res.statusCode < 500, '服务器响应正常（HTTP ' + res.statusCode + '）');
      });
      req.on('timeout', () => req.destroy(new Error('连接超时')));
      req.on('error', (e) => finish(false, '无法连接：' + (e.code || e.message)));
    } catch (e) { finish(false, '无法连接：' + e.message); }
  });
}
function startProbeLoop() {
  if (probeTimer) return;
  runProbe();
  probeTimer = setInterval(runProbe, 60000);
}

// ---------- 扩展服务（积分 / 站长管理，v2.2.0） ----------
// 会话 cookie 取自控制台所在的 persist 会话分区（控制台页就跑在这个分区里）；
// 请求只发往 svc-urls 解析出的自家服务地址，失败一律安静忽略，不弹窗不打断。
function consoleSession() { return session.fromPartition('persist:qfremote'); }
async function getConsoleCookieHeader() {
  try {
    const cookies = await consoleSession().cookies.get({});
    return cookies.map(c => c.name + '=' + c.value).join('; ');
  } catch (e) { return ''; }
}
async function extRequest(method, urlStr, bodyObj, opts) {
  // opts.noCookie：不附会话 cookie（许可领取的无会话核验入口专用——体里
  // 带账号＋密码只核验不签发登录态，契约 §7.5.3；其余调用口径不变）。
  const cookie = (opts && opts.noCookie) ? '' : await getConsoleCookieHeader();
  return new Promise((resolve) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { resolve({ status: 0, json: null, text: '' }); return; }
    // 2026-10-29 审计 J-2 定案：本通道承载会话 Cookie 与密钥领取核验，只许
    // https 且走 Node 默认证书校验，不再关闭校验、不接受 http 目标。
    if (u.protocol !== 'https:') { resolve({ status: 0, json: null, text: '' }); return; }
    const lib = u.protocol === 'https:' ? https : http;
    const body = bodyObj ? JSON.stringify(bodyObj) : null;
    // 2.3.2：自家服务统一版本头（许可/积分/站长/论坛 SSO/子服务登出全走此出口）
    const headers = clientVersion.clientVersionHeaders();
    if (cookie) headers.Cookie = cookie;
    if (body) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(body); }
    const req = lib.request(u, { method, headers, timeout: 8000 }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (e) { /* ignore */ }
        resolve({ status: res.statusCode, json, text });
      });
      res.on('error', () => resolve({ status: 0, json: null, text: '' }));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve({ status: 0, json: null, text: '' }));
    if (body) req.write(body);
    req.end();
  });
}
// 积分心跳：每 60 秒一次，只在主窗口在、控制台已加载时发。
// 2.3.1：心跳响应带 forceLogout 信号（契约 §7.5.7，转赠领取后原主人
// 即时强制下线）时立即执行登出＋落 G1 拦截，不许延迟到下次冷启动。
let heartbeatTimer = null;
function startPointsHeartbeat() {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(async () => {
    try {
      if (!win || win.isDestroyed() || !view || view.webContents.isDestroyed()) return;
      if (!consoleLoaded || !isTargetUrl(view.webContents.getURL())) return;
      const r = await extRequest('POST', svcUrls.pointsApi('heartbeat'), { client: 'win' });
      if (r && r.json && r.json.forceLogout) {
        await handleForceLogoutSignal(typeof r.json.gateCode === 'string' && r.json.gateCode ? r.json.gateCode : 'G1');
      }
    } catch (e) { /* 安静忽略 */ }
  }, 60000);
}
function formatDaysUsed(d) {
  const days = Math.max(0, Math.floor(Number(d) || 0));
  if (days < 365) return days + ' 天';
  const y = Math.floor(days / 365);
  const rest = days - y * 365;
  return y + ' 年 ' + String(rest).padStart(2, '0') + ' 天';
}
// 关于页两行数据：GET <points>/api/me；取不到返回 null，页面显示「—」
async function fetchMyPoints() {
  const r = await extRequest('GET', svcUrls.pointsApi('me'), null);
  if (r.status !== 200 || !r.json) return null;
  const j = r.json;
  const points = (typeof j.points === 'number') ? j.points : (typeof j.score === 'number' ? j.score : null);
  let displayText = null;
  if (typeof j.displayText === 'string' && j.displayText) displayText = j.displayText;
  else if (typeof j.durationText === 'string' && j.durationText) displayText = j.durationText;
  else if (typeof j.daysUsed === 'number') displayText = formatDaysUsed(j.daysUsed);
  else if (typeof j.totalSeconds === 'number') displayText = formatDaysUsed(j.totalSeconds / 86400);
  if (points === null && displayText === null) return null;
  return { points, displayText };
}
ipcMain.handle('qf-points-me', async () => {
  try { return await fetchMyPoints(); } catch (e) { return null; }
});

// ---------- 许可全链（2.3.1 阶段 E，契约 §3/§7.5/§7.6，与安卓阶段 D 同口径） ----------
// 鉴权与积分同路：extRequest 转发控制台会话 cookie。所有接口失败一律
// 返回 null——调用方必须落诚实错误态，不许拿假数据冒充许可状态。
function licenseToast(text) {
  if (toolbarView && !toolbarView.webContents.isDestroyed()) {
    toolbarView.webContents.send('qf-shot-feedback', { ok: false, text });
  }
}
async function fetchLicenseMeRaw() {
  const r = await extRequest('GET', svcUrls.licenseApi('me'), null);
  if (!r || r.status !== 200 || !r.json) return null;
  return licenseMod.parseMe(r.json);
}
// 取 /me 并顺带执行其顶层 forceLogout 信号（§7.5.7 三通道之一）
async function fetchLicenseMe() {
  const me = await fetchLicenseMeRaw();
  if (me && me.forceLogout) await handleForceLogoutSignal(me.gateCode || 'G1');
  return me;
}
async function reportDevice() {
  const code = deviceCodeStore.ensure();
  if (!code) return null;
  const r = await extRequest('POST', svcUrls.licenseApi('device-report'), { deviceCode: code, platform: 'pc' });
  if (!r || r.status !== 200 || !r.json) return null;
  return licenseMod.parseDeviceReport(r.json);
}
async function bindLicenseKey(key) {
  const code = deviceCodeStore.ensure();
  if (!code) return null;
  const r = await extRequest('POST', svcUrls.licenseApi('bind'), { key: String(key).trim(), deviceCode: code, platform: 'pc' });
  if (!r) return null;
  return licenseMod.parseOpResult(r.json);
}
// 粘贴领取转赠密钥（契约 §7.5.3 唯一领取端点）：有本次登录的内存凭据
// （或保险箱凭据）时带账号＋密码走无会话核验入口（只核验不签发），
// 否则走已登录入口（会话 cookie）。凭据只进本次请求体，不落盘不进日志。
async function claimLicenseKey(key) {
  const creds = gateCredsMemory || (credStore.has() ? credStore.load() : null);
  let r = null;
  if (creds && creds.username && creds.password) {
    r = await extRequest('POST', svcUrls.licenseApi('transfer/claim'),
      { username: creds.username, password: creds.password, key: String(key).trim() }, { noCookie: true });
  } else {
    r = await extRequest('POST', svcUrls.licenseApi('transfer/claim'), { key: String(key).trim() });
  }
  if (!r) return null;
  return licenseMod.parseOpResult(r.json);
}
function currentGateUsername() {
  if (gateUsername) return gateUsername;
  if (gateCredsMemory && gateCredsMemory.username) return gateCredsMemory.username;
  const c = credStore.has() ? credStore.load() : null;
  return (c && c.username) || '';
}
function gateStatePayload() {
  const copy = (gateDecision && licenseMod.gateCopyFor(gateDecision)) || licenseMod.FALLBACK_GATE_COPY;
  return { username: currentGateUsername(), copy, guideText: licenseMod.TRANSFER_GUIDE_TEXT, decision: gateDecision };
}
function sendGateState() {
  if (gateView && !gateView.webContents.isDestroyed()) {
    gateView.webContents.send('qf-gate-state', gateStatePayload());
  }
}
function ensureGateView() {
  if (gateView && !gateView.webContents.isDestroyed()) return gateView;
  if (!win || win.isDestroyed() || !consoleSes) return null;
  gateView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'license-gate-preload.js'),
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false
    }
  });
  win.contentView.addChildView(gateView);
  gateView.webContents.loadFile(path.join(__dirname, 'license-gate.html'), { query: { t: currentTheme() } });
  gateView.webContents.on('did-finish-load', () => sendGateState());
  attachShortcuts(gateView.webContents);
  layout();
  applyViewVisibility();
  return gateView;
}
function showGate(decision, forced) {
  gateDecision = decision;
  gateForced = !!forced;
  ensureGateView();
  applyViewVisibility();
  layout();
  sendGateState();
  if (win && !win.isDestroyed()) { if (!win.isVisible()) win.show(); win.focus(); }
}
function hideGate() {
  gateDecision = null;
  gateForced = false;
  applyViewVisibility();
}
// 会话终止（强制下线/待审共用）：保存内存核验凭据 → 走既有手动退出
// machinery 清会话/保险箱/标记 → 恢复内存凭据 → 立即清控制台会话并回
// 登录页。不是用户手动退出，但同样停掉自动恢复，免得刚下线又被静默
// 登录拉回（与安卓 _noteManualLogout 后果同口径）。
async function gateTerminateSession() {
  const keep = gateCredsMemory || (credStore.has() ? credStore.load() : null);
  handleManualLogout();
  gateCredsMemory = keep;
  try { await autologinMod.clearConsoleSession(authSession(), CONSOLE_URL); } catch (e) { /* ignore */ }
  flushConsoleCookies();
  if (view && !view.webContents.isDestroyed()) {
    try { view.webContents.loadURL(CONSOLE_URL); } catch (e) { /* ignore */ }
  }
}
// forceLogout 即时执行（契约 §7.5.7）：立即登出本机会话并落 G1 拦截面，
// 不许延迟到下次冷启动。已在强制下线拦截态时不重复执行。
async function handleForceLogoutSignal(gateCode) {
  if (gateDecision && gateDecision.forceLogout) return;
  const code = (typeof gateCode === 'string' && gateCode) ? gateCode : 'G1';
  await gateTerminateSession();
  showGate({ allow: false, code, shadow: false, enforce: true, forceLogout: true, endsAtMs: null, trialExpiresMs: null, banCode: null }, true);
}
// 执行门裁决。返回 true＝已落拦截/登出态，调用方到此为止。
async function applyGateAction(action) {
  if (!action || action.kind === 'none') return false;
  if (action.kind === 'showGate') { showGate(action.decision, false); return true; }
  if (action.kind === 'deviceReview') {
    // §7.6：待审期间强制登出该设备会话＋落「设备异常登录」面
    await gateTerminateSession();
    showGate(action.decision || { allow: false, code: 'DEVICE_REVIEW', shadow: false, enforce: true, forceLogout: false, endsAtMs: null, trialExpiresMs: null, banCode: null }, true);
    return true;
  }
  if (action.kind === 'forceLogoutToGate') {
    await handleForceLogoutSignal(action.decision ? action.decision.code : 'G1');
    return true;
  }
  return false;
}
// 许可门检查（契约 §3 写死时机：控制台会话建立成功后立即执行，先于
// 任何设备连接动作）：上报设备码 → 读许可判定 → 按裁决落原生拦截面。
// 每会话只跑一次；接口失败不拦人，只给一次诚实提示（不许拿假状态冒充）。
async function runLicenseGateCheck() {
  if (licenseCheckedSession || licenseCheckBusy) return;
  licenseCheckedSession = true;
  licenseCheckBusy = true;
  try {
    const report = await reportDevice();
    if (report) {
      const action = licenseMod.resolveGateAction({
        decision: report.decision || (report.reviewPending
          ? { allow: false, code: 'DEVICE_REVIEW', shadow: false, enforce: false, forceLogout: false, endsAtMs: null, trialExpiresMs: null, banCode: null }
          : null),
        fromDeviceReport: true,
        reviewPending: report.reviewPending,
        // 待审与转赠门同走 forceLogout 字段：待审优先落 DEVICE_REVIEW 面
        forceLogoutSignal: report.deviceForceLogout && !report.reviewPending
      });
      if (await applyGateAction(action)) return;
    }
    const me = await fetchLicenseMeRaw();
    if (me) {
      if (me.username) gateUsername = me.username;
      const action = licenseMod.resolveGateAction({
        decision: me.decision,
        forceLogoutSignal: me.forceLogout,
        forceLogoutGateCode: me.gateCode
      });
      if (await applyGateAction(action)) return;
    }
    if (!report && !me && !licenseErrorToastShown) {
      licenseErrorToastShown = true;
      licenseToast('许可信息读取失败，请检查网络后重试。');
    }
  } catch (e) {
    // 许可检查本身失败不锁死使用：口径同上，只提示不拦截
    if (!licenseErrorToastShown) {
      licenseErrorToastShown = true;
      licenseToast('许可信息读取失败，请检查网络后重试。');
    }
  } finally {
    licenseCheckBusy = false;
  }
}
// 拦截面「重新检查」/购买返回后复查：判定放行（或影子只记录）即消解
// 拦截；仍是 enforce 的未允许判定则换上最新拦截面。
async function recheckLicense() {
  const me = await fetchLicenseMeRaw();
  if (!me) return { ok: false, error: '许可信息读取失败，请检查网络后重试。' };
  if (me.username) gateUsername = me.username;
  const action = licenseMod.resolveGateAction({
    decision: me.decision,
    forceLogoutSignal: me.forceLogout,
    forceLogoutGateCode: me.gateCode
  });
  if (action.kind === 'none') {
    hideGate();
    licenseCheckedSession = false;
    return { ok: true };
  }
  if (action.kind === 'showGate') { showGate(action.decision, false); return { ok: true }; }
  if (action.kind === 'forceLogoutToGate') {
    await handleForceLogoutSignal(action.decision ? action.decision.code : 'G1');
    return { ok: true };
  }
  return { ok: true };
}
// 领取成功后的落点（gate 与关于页共用）：会话已被终止的拦截（强制
// 下线/待审）→ 消解拦截并回登录页重新登录（新会话重新跑门检查）；
// 会话在位的拦截 → 复查 /me，放行即消解。
async function afterClaimSuccess() {
  if (gateForced) {
    hideGate();
    licenseCheckedSession = false;
    if (view && !view.webContents.isDestroyed()) {
      try { view.webContents.loadURL(CONSOLE_URL); } catch (e) { /* ignore */ }
    }
    try { showView('console'); } catch (e) { /* ignore */ }
    return;
  }
  if (gateDecision) await recheckLicense();
}
ipcMain.handle('qf-gate-get', () => gateStatePayload());
ipcMain.handle('qf-gate-claim', async (event, key) => {
  const input = String(key == null ? '' : key);
  if (!licenseMod.isKeyFormatValid(input)) {
    return { ok: false, display: licenseMod.claimDisplayText(input, null) };
  }
  const result = await claimLicenseKey(input.trim());
  const display = licenseMod.claimDisplayText(input, result);
  if (result && result.ok) await afterClaimSuccess();
  return { ok: !!(result && result.ok), display };
});
ipcMain.on('qf-gate-open', (event, target) => { openExtPage(target).catch(() => {}); });
ipcMain.handle('qf-gate-recheck', async () => {
  try { return await recheckLicense(); } catch (e) { return { ok: false, error: '许可信息读取失败，请检查网络后重试。' }; }
});
// 拦截面「退出账号」：与正式退出登录（qf-logout-request）同一段口径——
// 原生确认（同文案）-> 级联终止 -> handleManualLogout（内含许可门复位）
// -> 控制台回登录页；取消则什么都不发生。
ipcMain.handle('qf-gate-logout', async () => {
  const owner = (aboutWin && !aboutWin.isDestroyed()) ? aboutWin : win;
  let r = null;
  try {
    r = await dialog.showMessageBox(owner, {
      type: 'question', title: 'QFRemote',
      message: '退出后将清除本机保存的登录信息，下次使用需重新登录。是否继续？',
      buttons: ['退出登录', '取消'], defaultId: 1, cancelId: 1, noLink: true
    });
  } catch (e) { /* ignore */ }
  if (!r || r.response !== 0) return { ok: false, cancelled: true };
  await terminateSubSessions().catch(() => {});
  handleManualLogout();
  try { if (view && !view.webContents.isDestroyed()) view.webContents.loadURL(CONSOLE_URL + 'logout'); } catch (e) { /* ignore */ }
  try { showView('console'); } catch (e) { /* ignore */ }
  try { if (aboutWin && !aboutWin.isDestroyed()) aboutWin.close(); } catch (e) { /* ignore */ }
  return { ok: true };
});
// 关于页「付费与激活」区（与 /license/api/me 同源数据；取不到回 null，
// 页面显示诚实错误态，不填假状态）
ipcMain.handle('qf-license-me', async () => {
  try {
    const me = await fetchLicenseMe();
    if (!me) return null;
    const now = Date.now();
    return Object.assign({}, me, {
      trialText: licenseMod.trialBarText(me, now),
      remainText: licenseMod.licenseRemainText(me, now),
      entryMode: licenseMod.licenseEntryMode(me)
    });
  } catch (e) { return null; }
});
ipcMain.handle('qf-license-bind', async (event, key) => {
  const input = String(key == null ? '' : key);
  if (!licenseMod.isKeyFormatValid(input)) return { ok: false, display: '密钥格式不正确，请检查后重新输入。' };
  const result = await bindLicenseKey(input.trim());
  if (!result) return { ok: false, display: '网络异常，请稍后再试。' };
  return { ok: result.ok, display: result.msg ? result.msg : (result.ok ? '绑定成功。' : '绑定未成功，请核对后重试。') };
});
ipcMain.handle('qf-license-claim', async (event, key) => {
  const input = String(key == null ? '' : key);
  if (!licenseMod.isKeyFormatValid(input)) {
    return { ok: false, display: licenseMod.claimDisplayText(input, null) };
  }
  const result = await claimLicenseKey(input.trim());
  const display = licenseMod.claimDisplayText(input, result);
  if (result && result.ok) await afterClaimSuccess();
  return { ok: !!(result && result.ok), display };
});
ipcMain.on('qf-license-open', (event, target) => {
  openExtPage(target).catch(() => {});
  if (aboutWin && !aboutWin.isDestroyed()) aboutWin.close();
});
// 站长判定：/points/api/me 有用户 + /admin/api/users 回 200 才算站长（以扩展服务为准）
let isAdminUser = false;
let lastAdminCheckAt = 0;
function broadcastAdmin() {
  if (toolbarView && !toolbarView.webContents.isDestroyed()) {
    toolbarView.webContents.send('qf-admin-state', isAdminUser);
  }
}
async function checkAdminStatus() {
  const now = Date.now();
  if (now - lastAdminCheckAt < 30000) return;
  lastAdminCheckAt = now;
  try {
    const me = await extRequest('GET', svcUrls.pointsApi('me'), null);
    let admin = false;
    if (me.status === 200 && me.json && (me.json.user || me.json.username || me.json.account)) {
      const users = await extRequest('GET', svcUrls.adminApi('users'), null);
      admin = users.status === 200;
    }
    if (admin !== isAdminUser) { isAdminUser = admin; }
    broadcastAdmin();
  } catch (e) { /* 安静忽略 */ }
}
ipcMain.on('qf-admin-open', async () => {
  if (!view || view.webContents.isDestroyed()) return;
  showView('console');
  try {
    const r = await extRequest('POST', svcUrls.pointsApi('sso-token'), {});
    const token = r.json && (r.json.token || r.json.ssoToken);
    if (r.status === 200 && token) { view.webContents.loadURL(svcUrls.adminLoginUrl(token)); return; }
  } catch (e) { /* 落到直开管理页 */ }
  view.webContents.loadURL(ADMIN_URL);
});

// ---------- 持久视图：创建 / 加载 / 切换 / 预加载（2.3.0 M 线） ----------
// 归类切换落点（2.3.2 收编）：社交/首页视图里指向控制台源的链接，已登录
// 时落新版设备页——原生控制台的用户可见内容就是设备列表，其收编替代
// 即设备页，不许把原生页从壳里翻出来；未登录时照旧落控制台（登录引导）。
function showClassified(k, fromKey) {
  if (k === 'console' && viewMgr.state().loggedIn) { showView('devices'); return; }
  showView(k);
}

function createSocialView(key) {
  if (socialViews[key] || !win || !consoleSes) return socialViews[key];
  const v = new WebContentsView({
    webPreferences: { session: consoleSes, contextIsolation: true, sandbox: true, backgroundThrottling: false }
  });
  v.setBackgroundColor(contentBg()); // 未加载完先垫主题底色，不露白屏
  win.contentView.addChildView(v);
  socialViews[key] = v;
  viewMgr.markCreated(key);
  const wc = v.webContents;
  wc.setWindowOpenHandler(({ url }) => {
    const k = viewsMod.classifyUrl(url, urlCtx());
    if (k && k !== key) showClassified(k, key);
    else if (k === key) wc.loadURL(url);
    return { action: 'deny' };
  });
  // 视图内跨页链接（好友页顶栏的「聊天/论坛」、论坛页顶栏的「好友/聊天」等）：
  // 归到别的视图就切视图，不把当前视图导航走，各页状态各自保活。
  wc.on('will-navigate', (event, url) => {
    if (viewsMod.isForumSsoTransit(url, urlCtx())) return; // 论坛令牌中转是自家首载流程，放行
    const wt = viewsMod.wrapperTarget(url);
    if (wt && wt !== key) { event.preventDefault(); showView(wt); return; }
    const k = viewsMod.classifyUrl(url, urlCtx());
    if (k && k !== key) { event.preventDefault(); showClassified(k, key); }
  });
  wc.on('did-navigate', (event, url) => viewMgr.noteNavigate(key, url));
  wc.on('did-finish-load', () => {
    viewMgr.markLoaded(key);
    const url = wc.getURL();
    if (key === 'chat') maybeChatUnlock(url, wc).catch(() => {});
  });
  wc.on('did-fail-load', (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return;
    viewMgr.markUnloaded(key);
    // 好友页打不开且有备选地址时试一次备选（与原单视图口径一致）
    if (key === 'friends' && validatedURL.startsWith(FRIENDS_URL) && FRIENDS_FALLBACK_URL && !friendsFallbackTried) {
      friendsFallbackTried = true;
      wc.loadURL(FRIENDS_FALLBACK_URL);
    }
  });
  attachShortcuts(wc);
  try { wc.setZoomFactor(currentZoom()); } catch (e) { /* ignore */ }
  layout();
  applyViewVisibility();
  return v;
}

// ---------- 首页视图与壳内网页（2.3.1 阶段 E） ----------
// 把控制台会话 cookie 移植到扩展服务源：电脑端登录发生在直连控制台，
// cookie 只在直连源上；扩展服务（新首页/购买/许可页）与积分同口径认
// xid——先把同一组 cookie 种到扩展源，视图打开这些页时即同源带上，
// 不再被要求二次登录（与安卓 _transplantSessionToExt 同手法同名单）。
async function transplantSessionToExt() {
  try {
    const origin = svcUrls.extOrigin();
    if (!origin) return;
    const cookies = await authSession().cookies.get({ url: CONSOLE_URL });
    for (const c of cookies) {
      if (['xid', 'xid.sig', 'qfrem'].indexOf(c.name) < 0 || !c.value) continue;
      const detail = { url: origin + '/', name: c.name, value: c.value, path: '/' };
      if (c.expirationDate) detail.expirationDate = c.expirationDate;
      try { await authSession().cookies.set(detail); } catch (e) { /* ignore */ }
    }
  } catch (e) { /* 移植失败不挡路：页面打开后由服务端自行走登录/核验 */ }
}

function createHomeView() {
  if (homeView || !win || !consoleSes) return homeView;
  const v = new WebContentsView({
    webPreferences: { session: consoleSes, contextIsolation: true, sandbox: true, backgroundThrottling: false }
  });
  v.setBackgroundColor(contentBg());
  win.contentView.addChildView(v);
  homeView = v;
  viewMgr.markCreated('home');
  const wc = v.webContents;
  wc.setWindowOpenHandler(({ url }) => {
    const lt = licenseMod.licenseNavTarget(url, ALLOWED_HOST);
    if (lt) { openExtPage(lt).catch(() => {}); return { action: 'deny' }; }
    const k = viewsMod.classifyUrl(url, urlCtx());
    if (k && k !== 'home') showClassified(k, 'home');
    else if (k === 'home') wc.loadURL(url);
    return { action: 'deny' };
  });
  wc.on('will-navigate', (event, url) => {
    if (viewsMod.isForumSsoTransit(url, urlCtx())) return;
    const wt = viewsMod.wrapperTarget(url);
    if (wt && wt !== 'home') { event.preventDefault(); showView(wt); return; }
    const k = viewsMod.classifyUrl(url, urlCtx());
    if (k && k !== 'home') { event.preventDefault(); showClassified(k, 'home'); }
  });
  wc.on('did-navigate', (event, url) => viewMgr.noteNavigate('home', url));
  wc.on('did-finish-load', () => viewMgr.markLoaded('home'));
  wc.on('did-fail-load', (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return;
    viewMgr.markUnloaded('home');
  });
  attachShortcuts(wc);
  try { wc.setZoomFactor(currentZoom()); } catch (e) { /* ignore */ }
  layout();
  applyViewVisibility();
  return v;
}

async function loadHomeView(url) {
  const v = homeView;
  if (!v || v.webContents.isDestroyed()) return;
  await transplantSessionToExt();
  if (!v.webContents.isDestroyed()) {
    try { v.webContents.loadURL(url || svcUrls.homeUrl()); } catch (e) { /* ignore */ }
  }
}

function ensureExtBarView(title) {
  if (extBarView && !extBarView.webContents.isDestroyed()) {
    extBarView.webContents.send('qf-extbar-state', { title });
    return extBarView;
  }
  if (!win || win.isDestroyed()) return null;
  extBarView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'ext-bar-preload.js'),
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false
    }
  });
  win.contentView.addChildView(extBarView);
  extBarView.webContents.loadFile(path.join(__dirname, 'ext-bar.html'), { query: { t: currentTheme(), title } });
  layout();
  return extBarView;
}

// 壳内打开自有网页（购买/查询/申诉/客服）：首页视图承载＋顶部原生返回
// 栏（与安卓 ShellWebPage 同口径），不整页外跳、不跳系统浏览器。
// 返回落点：有拦截面时回拦截面（购买返回顺带复查许可），否则回控制台。
const EXT_PAGE_DEFS = {
  purchase: () => ({ title: '购买密钥', url: svcUrls.purchaseUrl() }),
  status: () => ({ title: '查询密钥', url: svcUrls.licenseStatusUrl() }),
  // 换绑申诉（§11.9）：打开表单时由壳自动带入本机设备码，用户不手填
  rebind: () => ({ title: '申诉换绑设备', url: svcUrls.rebindUrl() + '?dc=' + encodeURIComponent(deviceCodeStore.ensure() || '') + '&platform=pc&ch=windows' }),
  appeal: () => ({ title: '提交申诉', url: svcUrls.appealUrl() + (gateUsername ? '?u=' + encodeURIComponent(gateUsername) : '') }),
  support: () => ({ title: '智能客服', url: svcUrls.supportUrl() })
};
async function openExtPage(target) {
  const def = EXT_PAGE_DEFS[target];
  if (!def) return;
  if (!win || win.isDestroyed()) return;
  if (!homeView) createHomeView();
  if (!homeView) return;
  extReturnGate = !!gateDecision;
  extReturnRecheck = target === 'purchase';
  browsingExt = true;
  ensureExtBarView(def().title);
  applyViewVisibility();
  layout();
  await loadHomeView(def().url);
  if (win && !win.isDestroyed()) { if (!win.isVisible()) win.show(); win.focus(); }
}
ipcMain.on('qf-extbar-back', async () => {
  const toGate = extReturnGate && !!gateDecision;
  const recheck = extReturnRecheck;
  browsingExt = false;
  extReturnGate = false;
  extReturnRecheck = false;
  applyViewVisibility();
  layout();
  if (toGate) {
    sendGateState();
    if (recheck) { try { await recheckLicense(); } catch (e) { /* ignore */ } }
  }
});

async function loadForumView() {
  const v = socialViews.forum;
  if (!v || v.webContents.isDestroyed()) return;
  try {
    const r = await extRequest('POST', svcUrls.forumApi('sso-token'), {});
    const token = r.json && r.json.token;
    if (r.status === 200 && token) { v.webContents.loadURL(svcUrls.forumSsoLoginUrl(token)); return; }
  } catch (e) { /* 落到直开论坛页 */ }
  if (!v.webContents.isDestroyed()) v.webContents.loadURL(FORUM_URL);
}

// 切视图：唯一的切换入口。已加载的视图切入时零导航（views.js 的
// loadPlan 保证），论坛首载/重登后的令牌交接在后台完成。
function showView(key) {
  if (!viewMgr.state().views[key]) return;
  // 用户主动切视图即退出「壳内网页」模式（返回栏口径由返回键走完）
  if (browsingExt) { browsingExt = false; extReturnGate = false; extReturnRecheck = false; }
  if (key === 'devices') {
    createDevicesView();
    viewMgr.switchTo('devices');
    applyViewVisibility();
    layout();
    broadcastViewState();
    return;
  }
  if (key === 'session') return; // 会话视图只经 openSession 进入，不作普通切换目标
  if (key === 'home') {
    const plan = viewMgr.loadPlan('home', socialUrls());
    if (plan.action === 'create-and-load') {
      createHomeView();
      loadHomeView(plan.url).catch(() => {});
    }
    viewMgr.switchTo('home');
    applyViewVisibility();
    layout();
    broadcastViewState();
    return;
  }
  const plan = viewMgr.loadPlan(key, socialUrls());
  if (plan.action === 'create-and-load') {
    createSocialView(key);
    const v = socialViews[key];
    if (v && !v.webContents.isDestroyed()) {
      if (key === 'forum') loadForumView().catch(() => {});
      else v.webContents.loadURL(plan.url);
    }
  } else if (plan.action === 'wait' && key === 'forum' && !viewMgr.state().views.forum.loaded) {
    // 已创建但首载未完成（多为预加载进行中）：不重复发导航，保持等待
  }
  viewMgr.switchTo(key);
  applyViewVisibility();
  layout();
  broadcastViewState();
}

// ---------- 收编设备页与会话视图实现（2.3.2 收编 Windows 线） ----------
// 设备页是本地页（新版设计令牌），与社交视图同级保活、切入零重载；
// 它经所在分区会话直连控制通道读设备清单（单点登录的既有会话，不产生
// 第二次登录）。会话视图复用既有会话通道：控制台源深链（抢修定版形态）
// 装进壳内独立视图，顶配壳内会话栏；断开＝卸载会话页（relay 真断）。
function createDevicesView() {
  if (devicesView || !win || !consoleSes) return devicesView;
  const v = new WebContentsView({
    webPreferences: {
      session: consoleSes,
      preload: path.join(__dirname, 'devices-preload.js'),
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false
    }
  });
  v.setBackgroundColor(themeBg());
  win.contentView.addChildView(v);
  devicesView = v;
  viewMgr.markCreated('devices');
  const wc = v.webContents;
  wc.setWindowOpenHandler(() => ({ action: 'deny' })); // 本地页不许开新窗
  wc.on('will-navigate', (event, url) => {
    if (!String(url).startsWith('file:')) event.preventDefault(); // 本地页不许被导航走
  });
  wc.on('did-navigate', (event, url) => viewMgr.noteNavigate('devices', url));
  wc.on('did-finish-load', () => viewMgr.markLoaded('devices'));
  attachShortcuts(wc);
  try { wc.setZoomFactor(currentZoom()); } catch (e) { /* ignore */ }
  wc.loadFile(path.join(__dirname, 'devices.html'), { query: { t: currentTheme() } });
  layout();
  applyViewVisibility();
  return v;
}

function createSessionView() {
  if (sessionView || !win || !consoleSes) return sessionView;
  const v = new WebContentsView({
    webPreferences: { session: consoleSes, contextIsolation: true, sandbox: true, backgroundThrottling: false }
  });
  v.setBackgroundColor(contentBg());
  win.contentView.addChildView(v);
  sessionView = v;
  viewMgr.markCreated('session');
  const wc = v.webContents;
  wc.setWindowOpenHandler(({ url }) => {
    if (isTargetUrl(url)) wc.loadURL(url); // 只许自家源在会话视图内打开
    return { action: 'deny' };
  });
  wc.on('will-navigate', (event, url) => {
    if (url === 'about:blank') return; // 断开卸载是自家动作
    if (!isTargetUrl(url)) event.preventDefault(); // 会话页不许导航去外站/旧入口
  });
  wc.on('did-navigate', (event, url) => viewMgr.noteNavigate('session', url));
  wc.on('did-finish-load', () => viewMgr.markLoaded('session'));
  wc.on('did-fail-load', (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return;
    viewMgr.markUnloaded('session');
  });
  attachShortcuts(wc);
  try { wc.setZoomFactor(currentZoom()); } catch (e) { /* ignore */ }
  layout();
  applyViewVisibility();
  return v;
}

function ensureSessionBarView(title, modeLabel) {
  if (sessionBarView && !sessionBarView.webContents.isDestroyed()) {
    sessionBarView.webContents.send('qf-sessionbar-state', { title, mode: modeLabel });
    return sessionBarView;
  }
  if (!win || win.isDestroyed()) return null;
  sessionBarView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'session-bar-preload.js'),
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false
    }
  });
  win.contentView.addChildView(sessionBarView);
  sessionBarView.webContents.loadFile(path.join(__dirname, 'session-bar.html'), {
    query: { t: currentTheme(), title: title || '', mode: modeLabel || '' }
  });
  layout();
  return sessionBarView;
}

// 打开会话：设备页「连接/文件管理/终端」统一入口。地址由 devices.js
// 生成（裸 id＋viewmode，永不生成 gotonode 冷链）；会话只在本视图内
// 打开，不整页跳、不新开窗口。
function openSession(nodeId, name, mode) {
  if (!win || win.isDestroyed()) return;
  const url = devicesMod.sessionUrl(SESSION_BASE_URL, nodeId, mode);
  if (!url) return;
  if (browsingExt) { browsingExt = false; extReturnGate = false; extReturnRecheck = false; }
  sessionCtx = { nodeId: devicesMod.bareNodeId(nodeId), name: String(name || ''), mode };
  createSessionView();
  ensureSessionBarView(sessionCtx.name || '远程会话', devicesMod.MODE_LABELS[mode] || '');
  viewMgr.switchTo('session');
  applyViewVisibility();
  layout();
  broadcastViewState();
  if (sessionView && !sessionView.webContents.isDestroyed()) {
    try { sessionView.webContents.loadURL(url); } catch (e) { /* ignore */ }
  }
  if (!win.isVisible()) win.show();
  win.focus();
}

// 断开会话并返回：卸载会话页（relay 随页关闭真正断开），回设备页。
function closeSession() {
  sessionCtx = null;
  if (sessionView && !sessionView.webContents.isDestroyed()) {
    try { sessionView.webContents.loadURL('about:blank'); } catch (e) { /* ignore */ }
  }
  viewMgr.markUnloaded('session');
  if (viewMgr.state().loggedIn) showView('devices');
  else showView('console');
}

// 设备清单：探针在控制台视图的同源上下文里执行（自带登录会话，与网页
// 版控制台发探针同一条路），应答回主进程归一后下发设备页。本地页直连
// WS 带不上会话 cookie 会被服务端以 noauth 关闭（真环境实测），故不走
// 页面直连。视图不在/未登录/探针失败一律如实回 ok:false，设备页给重
// 试态，绝不冒充空列表。
async function fetchDevicesModel() {
  if (!view || view.webContents.isDestroyed()) return { ok: false, reason: 'no-console-view' };
  if (!viewMgr.state().loggedIn) return { ok: false, reason: 'not-logged-in' };
  let wsUrl = '';
  try {
    const u = new URL(CONSOLE_URL);
    wsUrl = (u.protocol === 'https:' ? 'wss://' : 'ws://') + u.host + devicesMod.CONTROL_WS_PATH;
  } catch (e) { return { ok: false, reason: 'bad-console-url' }; }
  let raw = null;
  try {
    raw = await view.webContents.executeJavaScript(devicesMod.buildProbeCall(wsUrl, 6000), true);
  } catch (e) { return { ok: false, reason: 'probe-exec-failed' }; }
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'probe-timeout' };
  return { ok: true, model: devicesMod.normalizeNodes(raw.nodes, raw.meshes) };
}
ipcMain.handle('qf-devices-list', () => fetchDevicesModel());
ipcMain.on('qf-devices-open', (event, payload) => {
  if (!payload || !payload.nodeId) return;
  openSession(payload.nodeId, payload.name, payload.mode);
});
ipcMain.on('qf-sessionbar-back', () => closeSession());

// 预加载：登录成功后空闲分批创建（步间 1200ms），只建不切，
// 用户点击时多半已是加载完成的登录态页面。
function schedulePreload() {
  if (PREVIEW || preloadTimer) return;
  const step = () => {
    preloadTimer = null;
    if (!win || win.isDestroyed()) return;
    const key = viewMgr.nextPreload();
    if (!key) {
      // 社交视图预加载收尾后单独预加载首页视图（2.3.1）：创建前要先做
      // 会话 cookie 移植（跨源），故不进 views.js 的社交调度序列。
      if (!homePreloaded) {
        homePreloaded = true;
        createHomeView();
        loadHomeView().catch(() => {});
      }
      return;
    }
    createSocialView(key);
    const v = socialViews[key];
    if (v && !v.webContents.isDestroyed()) {
      if (key === 'forum') loadForumView().catch(() => {});
      else v.webContents.loadURL(socialUrls()[key]);
    }
    preloadTimer = setTimeout(step, 1200);
  };
  preloadTimer = setTimeout(step, 1200);
}

// ---------- 论坛入口令牌交接（2.3.0 H 线） ----------
// 论坛在隧道源、控制台在直连源，跨源时控制台 cookie 不跟随，照管理页
// 的模式交接：主进程拿分区里的控制台会话向论坛换一次性令牌（60 秒
// 单次），再让视图打开换发地址落论坛本站会话，全程不出现第二次登录。
// 换不到令牌（没登录/已手动退出论坛）就直开论坛页：同源场景页面自己
// 会再试单点登录，实在不行才落到论坛自己的登录框（独立网页口径）。
async function openForum() { showView('forum'); }

// ---------- 聊天静默解锁（2.3.0 H 线） ----------
// 聊天页（与好友同在域名聚合源）加载完后轮询页面状态：单点登录已落定且钥匙
// 还锁着、保险箱里有记住的登录密码、非手动退出 → 把密码递进页面调
// qfShellUnlock 静默解开。页面已无解锁框：没记住密码或解不开即停手，
// 页面显示不可用提示。只试一轮，不重试。
const CHAT_URL_PREFIX = FRIENDS_URL.replace(/\/friends$/, '/chat');
let chatUnlockBusy = false;
async function maybeChatUnlock(url, wcOverride) {
  if (PREVIEW || chatUnlockBusy) return;
  if (!url || !url.startsWith(CHAT_URL_PREFIX)) return;
  if (settings.auth.manualLogout) return;
  // 凭据只决定「密码路径」是否可用，不再整体早退；设备路径独立判断（L 线）
  const creds = credStore.has() ? credStore.load() : null;
  const wc = wcOverride || (view && !view.webContents.isDestroyed() ? view.webContents : null);
  if (!wc || wc.isDestroyed()) return;
  chatUnlockBusy = true;
  try {
    for (let i = 0; i < 40; i++) {
      if (wc.isDestroyed() || !wc.getURL().startsWith(CHAT_URL_PREFIX)) return;
      let st = null;
      try { st = await wc.executeJavaScript("typeof window.qfChatState === 'function' ? window.qfChatState() : null", true); } catch (e) { /* 页面未就绪 */ }
      if (st) {
        // —— 设备静默解锁（L 线）：与密码路径并行、互不依赖，置于密码路径之前 ——
        const devDecision = autologinMod.planChatDevice({
          manualLogout: false, hasToken: !!st.hasToken,
          locked: !!st.locked, unlocked: !!st.unlocked,
          hasShellDeviceCopy: !!st.hasShellDeviceCopy
        });
        if (devDecision.action === 'device-unlock' || devDecision.action === 'device-enroll') {
          const keyB64 = deviceKeyStore.ensure();
          if (keyB64) {
            try {
              await wc.executeJavaScript(devDecision.action === 'device-unlock'
                ? autologinMod.buildChatDeviceUnlockScript(keyB64)
                : autologinMod.buildChatDeviceEnrollScript(keyB64), true);
            } catch (e) { /* ignore */ }
            if (devDecision.action === 'device-unlock') return; // 已递入，等页面自行进入会话
            // enroll 为后台动作，递入后继续本轮既有逻辑即可
          }
        }
        const decision = autologinMod.planChatUnlock({
          hasCreds: !!creds, manualLogout: false,
          hasToken: !!st.hasToken, locked: !!st.locked, unlocked: !!st.unlocked
        });
        if (decision.action === 'silent-unlock') {
          try { await wc.executeJavaScript(autologinMod.buildChatUnlockScript(creds.password), true); } catch (e) { /* ignore */ }
          return;
        }
        if (decision.reason === 'already-unlocked') return;
        // no-chat-session / not-locked：等单点登录落定后再判，继续轮询
      }
      await new Promise(r => setTimeout(r, 250));
    }
  } finally { chatUnlockBusy = false; }
}

// ---------- 关于窗口（单例，按当前主题打开） ----------
let aboutWin = null;
function openAbout() {
  if (aboutWin && !aboutWin.isDestroyed()) { aboutWin.focus(); return; }
  const aboutSize = clampSizeToWorkArea(480, 780);
  aboutWin = new BrowserWindow({
    width: aboutSize.width,
    height: aboutSize.height,
    frame: false,
    resizable: false,
    center: true,
    title: '关于 QFRemote',
    backgroundColor: themeBg(),
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'about-preload.js'),
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false
    }
  });
  aboutWin.loadFile(path.join(__dirname, 'about.html'), {
    query: { v: app.getVersion(), d: BUILD_INFO.buildDate || '—', u: CONSOLE_URL, t: currentTheme() }
  });
  aboutWin.on('closed', () => { aboutWin = null; });
}

// ---------- 预览截图（开发自检用，产物由外部脚本拼版） ----------
let captured = false;
async function captureWindowPreview() {
  if (captured || !PREVIEW_DIR) return;
  captured = true;
  try {
    const t = await toolbarView.webContents.capturePage();
    fs.writeFileSync(path.join(PREVIEW_DIR, '_pv_toolbar.png'), t.toPNG());
    const c = await view.webContents.capturePage();
    fs.writeFileSync(path.join(PREVIEW_DIR, '_pv_content.png'), c.toPNG());
  } catch (e) { /* ignore */ }
  app.exit(0);
}
// 更新自测流程（仅 QFREMOTE_PREVIEW=update 时走，配合 QFREMOTE_RELEASE_URL 假清单）：
// 轮询等自动检查出「有新版」-> 打开关于面板，先截一轮（徽标+关于）->
// 在关于页点「下载更新」按钮走真实下载路径 -> 轮询到 phase=downloaded 再截一轮 -> 退出。
async function captureAboutPreview(name) {
  if (!PREVIEW_DIR || !aboutWin || aboutWin.isDestroyed()) return;
  try {
    const img = await aboutWin.webContents.capturePage();
    fs.writeFileSync(path.join(PREVIEW_DIR, name), img.toPNG());
  } catch (e) { /* ignore */ }
}
async function captureToolbarContent(namePrefix) {
  if (!PREVIEW_DIR) return;
  try {
    const t = await toolbarView.webContents.capturePage();
    fs.writeFileSync(path.join(PREVIEW_DIR, namePrefix + '_toolbar.png'), t.toPNG());
    const c = await view.webContents.capturePage();
    fs.writeFileSync(path.join(PREVIEW_DIR, namePrefix + '_content.png'), c.toPNG());
  } catch (e) { /* ignore */ }
}
async function runUpdatePreviewFlow() {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  try {
    for (let i = 0; i < 60 && updateState.phase !== 'available'; i++) await sleep(500);
    openAbout();
    await sleep(1500);
    await captureToolbarContent('_pv_upd1');
    await captureAboutPreview('_pv_about1.png');
    if (aboutWin && !aboutWin.isDestroyed()) {
      await aboutWin.webContents.executeJavaScript("document.getElementById('dlUpdate').click()");
    }
    // 演练专用（QFREMOTE_PREVIEW_PROGRESS_SHOTS=1）：下载途中定时截关于窗，留进度推进证据
    let progN = 0;
    for (let i = 0; i < 240 && updateState.phase !== 'downloaded' && updateState.phase !== 'download-failed'; i++) {
      await sleep(500);
      if (process.env.QFREMOTE_PREVIEW_PROGRESS_SHOTS === '1' && i % 8 === 4 && progN < 6) { progN++; await captureAboutPreview('_pv_about_prog' + progN + '.png'); }
    }
    await sleep(800);
    await captureToolbarContent('_pv_upd2');
    await captureAboutPreview('_pv_about2.png');
    // 演练专用（QFREMOTE_PREVIEW_UPDATE_INSTALL=1）：继续点「安装更新并重启」走完交接
    if (process.env.QFREMOTE_PREVIEW_UPDATE_INSTALL === '1' && updateState.phase === 'downloaded' && aboutWin && !aboutWin.isDestroyed()) {
      await aboutWin.webContents.executeJavaScript("document.getElementById('openInst').click()");
      await sleep(3000); // 安装拉起后主进程会自行 app.quit；走到这里说明未退出，结果照写
    }
    try {
      fs.writeFileSync(path.join(PREVIEW_DIR, '_pv_update_result.json'), JSON.stringify({
        phase: updateState.phase,
        availableVersion: updateState.manifest ? updateState.manifest.version : null,
        download: updateState.download,
        error: updateState.error
      }, null, 2));
    } catch (e) { /* ignore */ }
  } catch (e) { /* ignore */ }
  app.exit(0);
}

async function captureSplashPreview() {
  if (captured || !PREVIEW_DIR || !splash) return;
  captured = true;
  try {
    const img = await splash.webContents.capturePage();
    fs.writeFileSync(path.join(PREVIEW_DIR, '_pv_splash.png'), img.toPNG());
  } catch (e) { /* ignore */ }
  app.exit(0);
}

// ---------- 工具栏 IPC ----------
ipcMain.on('qf-nav', (event, action) => {
  if (!view) return;
  const wc = activeWc() || view.webContents;
  switch (action) {
    case 'back': if (wc.canGoBack()) wc.goBack(); break;
    case 'forward': if (wc.canGoForward()) wc.goForward(); break;
    case 'refresh': wc.reload(); break;
    // 主页 = 回设备列表（控制台视图）：在别的视图时只切回、状态在位；
    // 已在控制台时保持原口径，重新加载控制台首页。
    case 'home':
      // 主页＝回设备列表（2.3.2 收编）：会话中先断开回列表；已登录落
      // 新版设备页；未登录维持控制台原口径（登录引导面在控制台视图）。
      if (activeKey() === 'session') closeSession();
      else if (viewMgr.state().loggedIn) showView('devices');
      else if (activeKey() !== 'console') showView('console');
      else view.webContents.loadURL(CONSOLE_URL);
      break;
    case 'friends': showView('friends'); break;
    case 'chat': showView('chat'); break;
    case 'forum': showView('forum'); break;
    case 'home-page': showView('home'); break;
    case 'register': showView('console'); view.webContents.loadURL(REGISTER_URL); break;
  }
});

ipcMain.on('qf-win', (event, action) => {
  if (!win) return;
  if (action === 'min') win.minimize();
  else if (action === 'max') { win.isMaximized() ? win.unmaximize() : win.maximize(); }
  else if (action === 'close') win.close();
});

ipcMain.handle('qf-autolaunch-get', () => {
  try { return app.getLoginItemSettings().openAtLogin; } catch (e) { return false; }
});
ipcMain.on('qf-autolaunch-set', (event, on) => {
  try { app.setLoginItemSettings({ openAtLogin: !!on }); } catch (e) { /* ignore */ }
});

ipcMain.handle('qf-version', () => app.getVersion());
ipcMain.handle('qf-ui-state', () => ({
  zoomPercent: Math.round(currentZoom() * 100),
  fullScreen: win ? win.isFullScreen() : false,
  alwaysOnTop: win ? win.isAlwaysOnTop() : false,
  theme: currentTheme(),
  probe: lastProbe
}));
ipcMain.on('qf-zoom', (event, action) => zoomStep(action));
ipcMain.on('qf-fs-toggle', () => toggleFullscreen());
ipcMain.on('qf-top-toggle', () => toggleTop());

// ---------- 主题切换 ----------
ipcMain.on('qf-theme-toggle', () => {
  const next = currentTheme() === 'dark' ? 'blue' : 'dark';
  settings.theme = next;
  saveSettings();
  if (win && !win.isDestroyed()) win.setBackgroundColor(themeBg());
  if (view) view.setBackgroundColor(contentBg());
  for (const k of Object.keys(socialViews)) {
    if (socialViews[k]) { try { socialViews[k].setBackgroundColor(contentBg()); } catch (e) { /* ignore */ } }
  }
  if (toolbarView) toolbarView.webContents.send('qf-theme-state', next);
  if (aboutWin && !aboutWin.isDestroyed()) aboutWin.webContents.send('qf-theme-state', next);
  if (lockWin && !lockWin.isDestroyed()) lockWin.webContents.send('qf-theme-state', next);
  if (homeView && !homeView.webContents.isDestroyed()) { try { homeView.setBackgroundColor(contentBg()); } catch (e) { /* ignore */ } }
  if (gateView && !gateView.webContents.isDestroyed()) gateView.webContents.send('qf-theme-state', next);
  if (devicesView && !devicesView.webContents.isDestroyed()) devicesView.webContents.send('qf-theme-state', next);
  if (sessionBarView && !sessionBarView.webContents.isDestroyed()) sessionBarView.webContents.send('qf-theme-state', next);
  if (sessionView) { try { sessionView.setBackgroundColor(contentBg()); } catch (e) { /* ignore */ } }
  if (extBarView && !extBarView.webContents.isDestroyed()) extBarView.webContents.send('qf-theme-state', next);
  // 正停在断线页的话，立刻按新主题重画（不增加失败计数）
  if (offlineActive && view) showOfflinePage(true);
});

// ---------- 探活 ----------
ipcMain.handle('qf-probe-get', () => lastProbe);
ipcMain.handle('qf-probe-now', async () => runProbe());

// ---------- 一键截图：当前控制台画面存到下载文件夹（工具栏按钮与 F9 共用） ----------
async function doScreenshot() {
  const feedback = (ok, text) => {
    if (toolbarView && !toolbarView.webContents.isDestroyed()) {
      toolbarView.webContents.send('qf-shot-feedback', { ok, text });
    }
  };
  const awc = activeWc();
  if (!awc) { feedback(false, '截图失败：页面未就绪，请稍后再试。'); return; }
  try {
    const img = await awc.capturePage();
    if (img.isEmpty()) { feedback(false, '截图失败：画面为空，请稍后再试。'); return; }
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const name = 'QFRemote-' + now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate()) +
      '-' + pad(now.getHours()) + pad(now.getMinutes()) + pad(now.getSeconds()) + '.png';
    fs.writeFileSync(path.join(app.getPath('downloads'), name), img.toPNG());
    feedback(true, '截图已保存到下载文件夹：' + name);
  } catch (e) {
    feedback(false, '截图失败：' + e.message);
  }
}
ipcMain.on('qf-screenshot', () => doScreenshot());

// ---------- 软件内更新（v1.0.3，机制在 update.js） ----------
// 启动自动查一次 + 关于面板手动查；失败一律安静（只记状态，不弹任何框）。
// v1.0.4 更新政策（用户 09:43 亲定）：运行中发现新版只提醒不强制——工具栏徽标
// + 关于面板说明，一次会话只提醒一次；待更新状态落盘进 qf-settings（退出也留着）；
// 下次启动先过一道「启动门」（见文件下方 startupUpdateGate）：待更还在且能连上
// 服务器 -> 先出强制更新页再进控制台；连不上 -> 放行，强制只在启动那一下执行。
let updateState = { phase: 'idle', available: false, checkedAt: null, manifest: null, error: null, download: null };
let updateChecking = false;
let updateDownloading = false;
// 待更新落盘：只存清单要点 + 发现时的本机版本，够启动门复核与强更页展示用
function persistPendingUpdate(manifest) {
  if (!manifest || !manifest.version) return;
  settings.pendingUpdate = {
    version: manifest.version,
    notes: manifest.notes || '',
    url: manifest.url,
    sha256: manifest.sha256,
    size: manifest.size,
    fromVersion: app.getVersion(),
    foundAt: new Date().toISOString()
  };
  saveSettings();
}
function clearPendingUpdate() {
  if (settings.pendingUpdate) { delete settings.pendingUpdate; saveSettings(); }
}
// 待更版本已不比本机新（典型场景：新版装好了）-> 自动清除标记
function dropStalePending() {
  const p = settings.pendingUpdate;
  if (p && p.version && updater.compareVersions(p.version, app.getVersion()) <= 0) clearPendingUpdate();
}
// 启动时若已有落盘待更，先把它摆进更新状态：工具栏徽标与关于说明立刻有数，
// 不等本会话第一次检查（离线打开软件时也提醒得到）。
function seedUpdateStateFromPending() {
  const p = settings.pendingUpdate;
  if (p && p.version && updater.compareVersions(p.version, app.getVersion()) > 0) {
    updateState = {
      phase: 'available', available: true, checkedAt: p.foundAt || null,
      manifest: { version: p.version, notes: p.notes || '', url: p.url, sha256: p.sha256, size: p.size },
      error: null, download: null
    };
  }
}
function broadcastUpdate() {
  if (toolbarView && !toolbarView.webContents.isDestroyed()) {
    toolbarView.webContents.send('qf-update-state', updateState);
  }
  if (aboutWin && !aboutWin.isDestroyed()) {
    aboutWin.webContents.send('qf-update-state', updateState);
  }
}
async function runUpdateCheck() {
  if (updateChecking) return updateState;
  updateChecking = true;
  updateState = Object.assign({}, updateState, { phase: 'checking', error: null });
  broadcastUpdate();
  const r = await updater.checkForUpdate(app.getVersion());
  updateChecking = false;
  updateState = {
    phase: r.error ? 'error' : (r.available ? 'available' : 'latest'),
    available: r.available,
    checkedAt: new Date().toISOString(),
    manifest: r.manifest,
    error: r.error,
    download: updateState.download
  };
  // 落盘口径：查到有新版就记下待更；查实已是最新（没报错且不比本机新）就把过期待更清掉。
  // 本会话内查到新版也只落盘 + 提醒，绝不在运行中转强制——强制只在启动门执行。
  if (r.available && r.manifest) persistPendingUpdate(r.manifest);
  else if (!r.error) dropStalePending();
  broadcastUpdate();
  return updateState;
}
ipcMain.handle('qf-update-get', () => updateState);
ipcMain.handle('qf-update-check', async () => runUpdateCheck());
ipcMain.on('qf-update-download', async () => {
  if (updateDownloading || !updateState.manifest) return;
  updateDownloading = true;
  // 下载中显式置 downloading 阶段并广播：关于窗据此禁用按钮、显示进度条与百分比，
  // 不再只靠 progress 事件刷文本（无事件间隙时界面像卡住）。
  updateState = Object.assign({}, updateState, { phase: 'downloading', error: null, percent: 0 });
  broadcastUpdate();
  const sendProgress = (p) => {
    updateState = Object.assign({}, updateState, { percent: p.percent });
    if (aboutWin && !aboutWin.isDestroyed()) aboutWin.webContents.send('qf-update-progress', p);
  };
  try {
    const r = await updater.downloadUpdate(updateState.manifest, app.getPath('downloads'), sendProgress);
    updateState = Object.assign({}, updateState, {
      phase: 'downloaded',
      download: { file: r.file, name: path.basename(r.file), sha256: r.sha256, size: r.size }
    });
  } catch (e) {
    updateState = Object.assign({}, updateState, { phase: 'download-failed', error: e.message });
  }
  updateDownloading = false;
  broadcastUpdate();
});
// 软件内更新拉起安装包（软更新与强更共用这一条路，v2.3.0）：
// 静默直装回当前文件夹——不弹向导、不出现目录页（站长 2026-10-25 10:16 口径，
// 细节见 installer-launch.js 文件头）。只有网页下载的安装包双击时才走向导。
function launchDownloadedInstaller(file) {
  return installerLaunch.launchInstallerSilent(file, { execPath: process.execPath });
}
ipcMain.on('qf-update-open', () => {
  if (!updateState.download || !updateState.download.file) return;
  let launched = null;
  try { launched = launchDownloadedInstaller(updateState.download.file); } catch (e) { launched = null; }
  if (!launched) return;
  // 静默安装要替换本应用文件，应用不退会锁文件：先给用户一句话，再同强更口径退出交接。
  updateState = Object.assign({}, updateState, { phase: 'installing' });
  broadcastUpdate();
  setTimeout(() => app.quit(), 800);
});

// ---------- v1.0.4 启动强制更新门 ----------
// 规矩（用户 09:43 亲定）：强制只在「退出后重新进入」这一下发生。
// 启动流程（只判一次）：先清过期待更（新版装好了的）-> 还剩待更 -> 取一次清单：
//   - 取不到（断网/服务器没回应）-> 放行进软件，待更留着，本次启动不再转强制；
//   - 取到了但清单已不比本机新 -> 清掉待更，放行；
//   - 取到了且确实有新版 -> 先出强制更新页，进不了控制台。
// 强更页：没有关闭、没有跳过；下载带进度、下完验 SHA256，验过点「安装更新并重启」
// 静默装回当前文件夹（不弹向导），交接给安装程序后本应用退出——是交接，不是闪退。装完的新版首启会在上面第一步
// 把待更标记自动清掉。
let forceWin = null;
let forceState = { manifest: null, phase: 'ready', percent: null, error: null, download: null };
let forceDownloading = false;
function sendForceState() {
  if (forceWin && !forceWin.isDestroyed()) forceWin.webContents.send('qf-force-state', forceState);
}
function openForceWindow(manifest) {
  forceState = { manifest, phase: 'ready', percent: null, error: null, download: null };
  const forceSize = clampSizeToWorkArea(560, 660);
  forceWin = new BrowserWindow({
    width: forceSize.width,
    height: forceSize.height,
    frame: false,
    resizable: false,
    center: true,
    title: 'QFRemote 更新',
    backgroundColor: themeBg(),
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'force-preload.js'),
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false
    }
  });
  forceWin.loadFile(path.join(__dirname, 'force-update.html'), {
    query: {
      from: app.getVersion(), to: manifest.version,
      notes: manifest.notes || '', size: manifest.size ? String(manifest.size) : '',
      t: currentTheme()
    }
  });
  forceWin.on('closed', () => { forceWin = null; });
  if (PREVIEW === 'force') {
    forceWin.webContents.once('did-finish-load', () => setTimeout(runForcePreviewFlow, 600));
  }
}
ipcMain.handle('qf-force-get', () => forceState);
ipcMain.on('qf-force-download', async () => {
  if (forceDownloading || !forceState.manifest) return;
  forceDownloading = true;
  forceState = Object.assign({}, forceState, { phase: 'downloading', error: null, percent: 0 });
  sendForceState();
  try {
    const r = await updater.downloadUpdate(forceState.manifest, app.getPath('downloads'), (p) => {
      forceState.percent = p.percent;
      if (forceWin && !forceWin.isDestroyed()) forceWin.webContents.send('qf-force-progress', p);
    });
    forceState = Object.assign({}, forceState, {
      phase: 'downloaded',
      download: { file: r.file, name: path.basename(r.file), sha256: r.sha256, size: r.size }
    });
  } catch (e) {
    forceState = Object.assign({}, forceState, { phase: 'failed', error: e.message });
  }
  forceDownloading = false;
  sendForceState();
});
ipcMain.on('qf-force-open', () => {
  if (forceState.download && forceState.download.file) {
    let launched = null;
    try { launched = launchDownloadedInstaller(forceState.download.file); } catch (e) { launched = null; }
    if (!launched) return;
    forceState = Object.assign({}, forceState, { phase: 'installing' });
    sendForceState();
    // 安装程序接手后本应用退出，为的是让安装顺利替换文件——交接，不是闪退
    setTimeout(() => app.quit(), 800);
  }
});
// 强更失败放行（M2 线追加，站长 2026-10-25 13:06 令）：强更下载失败时用户可点
// 「先进入软件」——关掉强更窗、按正常流程建主窗口，不许把人锁死在更新窗里。
// pendingUpdate 不清（下次启动仍走启动门再提醒），本会话不再重复拦截。
ipcMain.on('qf-force-release', () => {
  if (forceDownloading) return;
  const w = forceWin;
  forceState = { manifest: null, phase: 'ready', percent: null, error: null, download: null };
  if (w && !w.isDestroyed()) w.close();
  if (!win) createWindow();
});
// 启动门：返回 true 表示强更页已接管（不要再建主窗口）
async function startupUpdateGate() {
  dropStalePending(); // 新版装好后首启：待更版本已 <= 本机版本，自动清除
  let manifest = null;
  try {
    // 有落盘待更：按原口径给足 8 秒取清单裁决；无待更时只为核强更线短探 2.5 秒，
    // 断网启动不被长等拖住（取不到照样放行，符合「启动离线先放行」）。
    manifest = await updater.fetchManifest(settings.pendingUpdate ? 8000 : 2500);
  } catch (e) { return false; } // 连不上：放行
  if (updater.compareVersions(manifest.version, app.getVersion()) <= 0) {
    clearPendingUpdate();
    return false;
  }
  // 强更线（2026-11-07 站长令）：清单 minUsable 高于本机版本时，即使没有落盘
  // 待更，本次启动也强制更新——旧版自愈不再依赖「先开一次落盘、再开一次强更」。
  const belowMinUsable = !!(manifest.minUsable &&
    updater.compareVersions(app.getVersion(), manifest.minUsable) < 0);
  if (!settings.pendingUpdate && !belowMinUsable) return false;
  persistPendingUpdate(manifest); // 以服务器最新清单刷新待更（说明/地址/校验以清单为准）
  openForceWindow(manifest);
  return true;
}
// ---------- 本机 agent 自愈 · 启动兜底（2.4.4） ----------
// 2.4.3 只在安装器装后段做自愈；站长笔记本上升 2.4.3 后仍离线，
// 且 %TEMP% 里没有 qf-agent-heal.log——PS1 根本没被拉起执行，
// 安装器预检悄悄跳过。启动兜底是第二道防线：每次启动异步自检，
// 发现地址过期／服务停着／文件比进程新时提权修复（弹一次 UAC），
// 失败留痕（本地日志＋更新检查回带）＋人话提示，不拦启动、不报错码。
async function runStartupAgentHeal() {
  if (process.platform !== 'win32') return;
  try {
    const state = await agentHeal.checkAgentState();
    if (state.action === 'none') return;
    const now = new Date();
    // 进行中守卫：安装器刚拉起 PS1（120 秒内有启动行且无 RESULT）时，
    // 别跟着再弹一次 UAC；等下次启动再看结果。
    if (agentHeal.isHealInProgress(agentHeal.readHealLogText(), now)) {
      agentHeal.appendHealLog('startup check: heal already in progress, skip');
      return;
    }
    const st = (settings.agentHeal && typeof settings.agentHeal === 'object') ? settings.agentHeal : {};
    if (!agentHeal.shouldAttempt(st, now, app.getVersion())) return;
    // 记一次尝试（同日计数；换版本或隔天清零）
    const today = now.toDateString();
    const lastDay = st.lastAttemptISO ? new Date(st.lastAttemptISO).toDateString() : null;
    const attemptsToday = (lastDay === today) ? (st.attemptsToday || 0) + 1 : 1;
    settings.agentHeal = {
      lastAttemptISO: now.toISOString(),
      attemptsToday,
      lastOutcome: st.lastOutcome || null,
      lastVersion: app.getVersion(),
      consecutiveFailures: st.consecutiveFailures || 0
    };
    saveSettings();
    agentHeal.appendHealLog('startup check: action=' + state.action + ' msh=' + (state.msh.path || 'not-found') + ' service=' + (state.service.status || 'missing'));
    const ps1 = agentHeal.resolveHealScriptPath({
      resourcesPath: (process.resourcesPath || ''),
      dirname: __dirname,
      tempDir: os.tmpdir()
    });
    if (!ps1) {
      agentHeal.appendHealLog('heal script not found, outcome=unknown');
      recordHealOutcome('unknown');
      return;
    }
    const res = await agentHeal.runHealElevated(ps1, {});
    const outcome = (res && res.outcome) || 'unknown';
    const prev = settings.agentHeal || {};
    const okOutcomes = ['fixed', 'already_correct', 'service_started', 'restarted_stale_config', 'no_agent'];
    settings.agentHeal = Object.assign({}, prev, {
      lastOutcome: outcome,
      consecutiveFailures: okOutcomes.includes(outcome) ? 0 : (prev.consecutiveFailures || 0) + 1
    });
    saveSettings();
    agentHeal.appendHealLog('outcome=' + outcome);
    recordHealOutcome(outcome);
  } catch (e) { /* 安静失败：自愈绝不影响启动 */ }
}

// 自愈结果处理：白名单内的结果走更新检查回带（下次取清单时 ?heal=，
// 进 Caddy 访问日志，服务端可查）；失败时人话提示（成功／无需修复
// 不打扰；UAC 被拒第 2 次连续失败起才提示，避免一次被拒就反复弹窗）。
function recordHealOutcome(outcome) {
  try {
    if (agentHeal.REPORTABLE.includes(outcome)) {
      updater.setHealReport(outcome);
      updater.fetchManifest(8000).catch(() => {});
    }
  } catch (e) { /* ignore */ }
  const msg = agentHeal.healOutcomeMessage(outcome);
  if (!msg) return;
  const st = settings.agentHeal || {};
  if (outcome === 'denied' && (st.consecutiveFailures || 0) < 2) return;
  showHealFailure(msg);
}

async function showHealFailure(msg) {
  try {
    const owner = (win && !win.isDestroyed()) ? win : undefined;
    await dialog.showMessageBox(owner, {
      type: 'warning', title: 'QFRemote', message: msg,
      buttons: ['知道了'], defaultId: 0, noLink: true
    });
  } catch (e) { /* ignore */ }
}

// 强更页自测（仅 QFREMOTE_PREVIEW=force）：截强更页 -> 点「立即更新」走真下载 ->
// 等核对结果 -> 再截一轮 -> 把阶段结果与「下载完待更仍在」的断言写 JSON -> 退出。
async function runForcePreviewFlow() {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const out = { mode: 'force', gated: !!forceWin, fromVersion: app.getVersion() };
  try {
    if (forceWin && !forceWin.isDestroyed()) {
      out.toVersion = forceState.manifest ? forceState.manifest.version : null;
      await sleep(900);
      const img1 = await forceWin.webContents.capturePage();
      if (PREVIEW_DIR) fs.writeFileSync(path.join(PREVIEW_DIR, '_pv_force1.png'), img1.toPNG());
      await forceWin.webContents.executeJavaScript("document.getElementById('forceBtn').click()");
      let fProgN = 0;
      for (let i = 0; i < 240 && forceState.phase !== 'downloaded' && forceState.phase !== 'failed'; i++) {
        await sleep(500);
        if (process.env.QFREMOTE_PREVIEW_PROGRESS_SHOTS === '1' && i % 8 === 4 && fProgN < 6 && forceWin && !forceWin.isDestroyed()) {
          fProgN++;
          try { const pim = await forceWin.webContents.capturePage(); if (PREVIEW_DIR) fs.writeFileSync(path.join(PREVIEW_DIR, '_pv_force_prog' + fProgN + '.png'), pim.toPNG()); } catch (e) { /* ignore */ }
        }
      }
      out.phase = forceState.phase;
      out.download = forceState.download || null;
      out.error = forceState.error || null;
      await sleep(600);
      const img2 = await forceWin.webContents.capturePage();
      if (PREVIEW_DIR) fs.writeFileSync(path.join(PREVIEW_DIR, '_pv_force2.png'), img2.toPNG());
      const fresh = loadSettings();
      out.pendingAfterDownload = fresh.pendingUpdate || null; // 下载完不清，装完新版首启才清
      // 演练专用（QFREMOTE_PREVIEW_FORCE_RELEASE=1）：失败态点「先进入软件」验放行回路
      if (process.env.QFREMOTE_PREVIEW_FORCE_RELEASE === '1' && forceState.phase === 'failed') {
        await forceWin.webContents.executeJavaScript("document.getElementById('releaseBtn').click()");
        for (let i = 0; i < 20 && !win; i++) await sleep(500);
        out.releasedToMain = !!win;
        out.forceClosed = !forceWin;
        await sleep(1500);
        await captureToolbarContent('_pv_release');
      }
    }
  } catch (e) { out.fatal = e.message; }
  try {
    if (PREVIEW_DIR) fs.writeFileSync(path.join(PREVIEW_DIR, '_pv_force_result.json'), JSON.stringify(out, null, 2));
  } catch (e) { /* ignore */ }
  app.exit(0);
}

// ---------- 诊断信息一键复制（内容严禁含任何账号密码，拼完在此一处可查） ----------
function buildDiagnostics() {
  const p = lastProbe;
  const probeText = !p || !p.at
    ? '还没有检测结果'
    : (p.ok ? '可达' : '不可达') + '（' + new Date(p.at).toLocaleString('zh-CN', { hour12: false }) + '，' + p.detail + (p.ms != null ? '，用时 ' + p.ms + ' 毫秒' : '') + '）';
  const st = (settings.stats && typeof settings.stats === 'object') ? settings.stats : {};
  const lines = [
    'QFRemote 诊断信息',
    '软件版本：v' + app.getVersion(),
    '构建日期：' + (BUILD_INFO.buildDate || '—'),
    '系统版本：' + os.version() + '（' + process.platform + ' ' + os.arch() + '，内核 ' + os.release() + '）',
    '服务器连通性检测：' + probeText,
    '整页断线次数：' + (st.offlineCount || 0) + ' 次',
    '自动重连次数：' + (st.watchdogReconnectCount || 0) + ' 次',
    '记住账号密码：' + (credStore.has() ? '已开启（本机加密保存）' : '未开启')
  ];
  return lines.join('\n');
}
ipcMain.handle('qf-diagnostics-copy', () => {
  const text = buildDiagnostics();
  clipboard.writeText(text);
  return text;
});

// ---------- 隐私锁窗口（v2.0.0，单例，桥与接缝见 lock.js） ----------
// 口径写死：手动开关、默认关、开锁必须先设密码、非机主不显示开关（服务端判
// owner、面板只呈现）。壳不存任何密码，密码只在提交瞬间过桥。
const lockBridge = lockBridgeMod.createLockBridge(
  () => session.fromPartition('persist:qfremote'),
  { mock: PREVIEW === 'lock' || process.env.QFREMOTE_LOCK_MOCK === '1', clientVersion: () => clientVersion.getClientVersion() }
);
let lockWin = null;
function openLockWindow() {
  if (lockWin && !lockWin.isDestroyed()) { lockWin.focus(); return; }
  const lockSize = clampSizeToWorkArea(520, 760);
  lockWin = new BrowserWindow({
    width: lockSize.width,
    height: lockSize.height,
    frame: false,
    resizable: false,
    center: true,
    title: 'QFRemote 隐私锁',
    backgroundColor: themeBg(),
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'lock-preload.js'),
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false
    }
  });
  lockWin.loadFile(path.join(__dirname, 'lock.html'), {
    query: { t: currentTheme() }
  });
  lockWin.on('closed', () => { lockWin = null; });
  if (PREVIEW === 'lock') {
    lockWin.webContents.once('did-finish-load', () => setTimeout(captureLockPreview, 1600));
  }
}
async function captureLockPreview() {
  try {
    if (PREVIEW_DIR && lockWin && !lockWin.isDestroyed()) {
      const img = await lockWin.webContents.capturePage();
      fs.writeFileSync(path.join(PREVIEW_DIR, '_pv_lock.png'), img.toPNG());
    }
  } catch (e) { /* ignore */ }
  app.exit(0);
}
async function lockCall(fn) {
  try { return Object.assign({ ok: true }, await fn()); }
  catch (e) { return { ok: false, code: (e && e.code) || null, error: (e && e.message) || '操作失败，请稍后再试。' }; }
}
ipcMain.handle('qf-lock-devices', async () => {
  try {
    const devices = await lockBridge.listDevices();
    return { ok: true, devices };
  } catch (e) {
    return { ok: false, code: (e && e.code) || null, error: (e && e.message) || '暂时无法连接隐私锁服务，请检查网络后重试。' };
  }
});
ipcMain.handle('qf-lock-enable', (e, id, password) => lockCall(() => lockBridge.enable(id, password)));
ipcMain.handle('qf-lock-disable', (e, id) => lockCall(() => lockBridge.disable(id)));
ipcMain.handle('qf-lock-reset', (e, id, loginPassword, newPassword) => lockCall(() => lockBridge.reset(id, loginPassword, newPassword)));
ipcMain.on('qf-lock-open', () => openLockWindow());
ipcMain.on('qf-lock-close', (event) => {
  const w = BrowserWindow.fromWebContents(event.sender);
  if (w) w.close();
});
ipcMain.on('qf-lock-open-friends', () => {
  showView('friends');
  if (lockWin && !lockWin.isDestroyed()) lockWin.close();
  if (win && !win.isDestroyed()) { win.show(); win.focus(); }
});

// ---------- 关于 ----------
ipcMain.on('qf-about-open', () => openAbout());
// 注册入口同框（2.3.1 阶段 E，阶段 A 点名修正）：关于窗的注册入口不再
// 打开外部浏览器，改与工具栏注册同口径——回主窗控制台视图内打开注册页。
ipcMain.on('qf-open-register', () => {
  try { showView('console'); } catch (e) { /* ignore */ }
  try { if (view && !view.webContents.isDestroyed()) view.webContents.loadURL(REGISTER_URL); } catch (e) { /* ignore */ }
  try { if (win && !win.isDestroyed()) { if (!win.isVisible()) win.show(); win.focus(); } } catch (e) { /* ignore */ }
});
ipcMain.on('qf-about-close', (event) => {
  const w = BrowserWindow.fromWebContents(event.sender);
  if (w) w.close();
});
// 正式「退出登录」（v2.3.0）：「我的」页入口 -> 原生确认 -> 级联终止各子
// 会话 -> 走既有手动退出 machinery（清保险箱/标记）-> 控制台回登录页。
// 许可拦截面的退出按钮（qf-gate-logout）走同一段口径（确认文案、级联
// 终止、handleManualLogout、回登录页逐项一致，不另造平行退出）。
ipcMain.handle('qf-logout-request', async () => {
  const owner = (aboutWin && !aboutWin.isDestroyed()) ? aboutWin : win;
  let r = null;
  try {
    r = await dialog.showMessageBox(owner, {
      type: 'question', title: 'QFRemote',
      message: '退出后将清除本机保存的登录信息，下次使用需重新登录。是否继续？',
      buttons: ['退出登录', '取消'], defaultId: 1, cancelId: 1, noLink: true
    });
  } catch (e) { /* ignore */ }
  if (!r || r.response !== 0) return { ok: false, cancelled: true };
  await terminateSubSessions().catch(() => {});
  handleManualLogout();
  try { if (view && !view.webContents.isDestroyed()) view.webContents.loadURL(CONSOLE_URL + 'logout'); } catch (e) { /* ignore */ }
  try { showView('console'); } catch (e) { /* ignore */ }
  try { if (aboutWin && !aboutWin.isDestroyed()) aboutWin.close(); } catch (e) { /* ignore */ }
  return { ok: true };
});

app.whenReady().then(async () => {
  if (!gotSingleLock) return;
  try {
    app.setAboutPanelOptions({
      applicationName: 'QFRemote',
      applicationVersion: app.getVersion(),
      version: app.getVersion(),
      copyright: 'QFRemote'
    });
  } catch (e) { /* ignore */ }
  applyAutoLaunchDefault();
  if (PREVIEW === 'splash') { createSplash(); return; }
  seedUpdateStateFromPending();
  svcUrls.refresh().then(() => applySvcUrls()).catch(() => {});
  if (PREVIEW === 'lock') {
    // 自测专用：只开隐私锁面板（mock 桥），截图后退出，不建主窗口
    openLockWindow();
    setTimeout(captureLockPreview, 6000); // 兜底
    return;
  }
  if (PREVIEW === 'force') {
    // 自测专用：只跑启动门。门放行（无待更/断网）时也留一份结果再退出。
    const gated = await startupUpdateGate();
    if (!gated) {
      try {
        if (PREVIEW_DIR) {
          fs.writeFileSync(path.join(PREVIEW_DIR, '_pv_force_result.json'), JSON.stringify({
            mode: 'force', gated: false, fromVersion: app.getVersion(),
            pendingAfterGate: loadSettings().pendingUpdate || null
          }, null, 2));
        }
      } catch (e) { /* ignore */ }
      app.exit(0);
    }
    return;
  }
  if (!PREVIEW) {
    // 正常启动：先过启动更新门，被强更页接管就不建主窗口
    const gated = await startupUpdateGate();
    if (gated) return;
  }
  createWindow();
  // 软件内更新：启动后自动查一次（失败安静无提示，见 update.js 文件头）
  setTimeout(() => { runUpdateCheck().catch(() => {}); }, 2000);
  // 本机 agent 自愈兜底（2.4.4）：启动后异步自检 .msh，发现地址过期
  // 即提权修复（弹一次 UAC），不拦启动、不影响更新检查。
  // 延迟 5 秒（原 3 秒）：给安装器刚拉完的自愈留出写入日志的时间，
  // 让进行中守卫（120 秒）能看到启动行，避免双弹 UAC。
  setTimeout(() => { runStartupAgentHeal().catch(() => {}); }, 5000);
});

app.on('before-quit', () => flushConsoleCookies());

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (!win && gotSingleLock) createWindow();
});
