'use strict';
/*
 * ipc-trust.js — F-08：Electron IPC sender 来源统一校验（GPT 第二轮审计 F-08，P2）
 * ============================================================================
 * 背景：此前 windows/main.js 里 59 处 ipcMain.handle/on 只认 channel 名、
 * 不认 sender。任意拿到 bridge 的渲染进程（控制台页 XSS、被导航到外站
 * 的视图、注入的 iframe）都能调 qf-gate-claim / qf-license-bind /
 * qf-admin-open / qf-win / qf-autolaunch-set 等敏感通道。修法：全部
 * IPC 注册改走 main.js 的 trustedHandle/trustedOn 包装器，逐条过本模块
 * 的 assertTrustedSender；通不过的一律 fail-closed（handle 侧抛错、
 * on 侧丢弃），绝不执行原 handler。
 *
 * 五项校验（任一不过即拒绝）：
 *   ① sender 存在且未销毁；
 *   ② senderFrame 是主框架（frame.parent 为 null），iframe 一律拒绝；
 *      senderFrame 缺失也拒绝（帧已销毁/导航竞态时为 null，fail-closed
 *      不算误杀活页面）；
 *   ③ sender URL 与该 channel 的能力表一致：
 *      - 本地页：file: 协议、host 为空，query/hash 去掉后经
 *        url.fileURLToPath 与 __dirname 下固定文件绝对路径逐字节比对
 *        （win32 大小写不敏感）；devices.html 只认精确 devices.html，
 *        devices2.html / devices.html/evil 之类一律拒绝；
 *      - 远程控制台页：https、端口为空或 443、无 userinfo、origin 必须
 *        在调用方传入的自家服务源精确集合内（CONSOLE/FRIENDS/CHAT/
 *        FORUM/extOrigin 等运行时 origin，不用 startsWith、不用通配）；
 *   ④ sender 是本应用现存窗口树里的 webContents（sender ID 对得上活
 *      窗口）：递归走 BaseWindow.getAllWindows() → 各窗口的 webContents
 *      与 contentView 子树，找得到才算；
 *   ⑤ 宿主窗口存活（!isDestroyed()）。
 * 未登记的 channel 一律拒绝；URL 解析失败、宿主窗口找不到也一律拒绝。
 *
 * 本模块不 require electron，可在纯 node 下单测（见 test/ipc-sender-test.js）。
 * 调用方（main.js）传入 ctx：
 *   { dirname, platform, trustedOrigins: () => Set<string>,
 *     allWindows: () => Array<window-like> }
 * trustedOrigins 用函数传入：product.json 刷新会改服务地址，校验时取最新值。
 */
const path = require('path');
const { fileURLToPath } = require('url');

/* 能力表：channel → 允许的 sender 规则（与各 preload 文件头的
 * CAPABILITIES 常量逐一对照；强制执行只认本表）。
 *   { file }   —— 壳内本地页，__dirname 下的固定文件；
 *   { origin: 'console' } —— 自家服务源的远程控制台页（console-preload.js）。
 * qf-update-get 与 qf-autolaunch-get/set 由 toolbar 与 about 两页共用，
 * 故列两条 file 规则；其余 channel 各只归属一个 sender。 */
const IPC_CAPABILITIES = {
  // toolbar.html（toolbar-preload.js）
  'qf-nav': [{ file: 'toolbar.html' }],
  'qf-lock-open': [{ file: 'toolbar.html' }],
  'qf-win': [{ file: 'toolbar.html' }],
  'qf-autolaunch-get': [{ file: 'toolbar.html' }, { file: 'about.html' }],
  'qf-autolaunch-set': [{ file: 'toolbar.html' }, { file: 'about.html' }],
  'qf-zoom': [{ file: 'toolbar.html' }],
  'qf-fs-toggle': [{ file: 'toolbar.html' }],
  'qf-top-toggle': [{ file: 'toolbar.html' }],
  'qf-version': [{ file: 'toolbar.html' }],
  'qf-ui-state': [{ file: 'toolbar.html' }],
  'qf-theme-toggle': [{ file: 'toolbar.html' }],
  'qf-overflow-menu': [{ file: 'toolbar.html' }],
  'qf-probe-get': [{ file: 'toolbar.html' }],
  'qf-screenshot': [{ file: 'toolbar.html' }],
  'qf-about-open': [{ file: 'toolbar.html' }],
  'qf-admin-open': [{ file: 'toolbar.html' }],
  'qf-update-get': [{ file: 'toolbar.html' }, { file: 'about.html' }],
  // RC-04：工具栏“取消重连”按钮（toolbar.html 状态行）
  'qf-reconnect-cancel': [{ file: 'toolbar.html' }],
  // about.html（about-preload.js）
  'qf-probe-now': [{ file: 'about.html' }],
  'qf-about-close': [{ file: 'about.html' }],
  'qf-update-check': [{ file: 'about.html' }],
  'qf-update-download': [{ file: 'about.html' }],
  'qf-update-open': [{ file: 'about.html' }],
  // D-05：更新总开关与“下载前先问”开关（about.html 设置区）。
  'qf-update-settings-get': [{ file: 'about.html' }],
  'qf-update-settings-set': [{ file: 'about.html' }],
  'qf-diagnostics-copy': [{ file: 'about.html' }],
  'qf-heal-retry': [{ file: 'about.html' }],
  'qf-open-register': [{ file: 'about.html' }],
  'qf-logout-request': [{ file: 'about.html' }],
  'qf-points-me': [{ file: 'about.html' }],
  'qf-license-me': [{ file: 'about.html' }],
  'qf-license-bind': [{ file: 'about.html' }],
  'qf-license-claim': [{ file: 'about.html' }],
  'qf-license-open': [{ file: 'about.html' }],
  // license-gate.html（license-gate-preload.js）
  'qf-gate-get': [{ file: 'license-gate.html' }],
  'qf-gate-claim': [{ file: 'license-gate.html' }],
  'qf-gate-open': [{ file: 'license-gate.html' }],
  'qf-gate-recheck': [{ file: 'license-gate.html' }],
  'qf-gate-logout': [{ file: 'license-gate.html' }],
  // devices.html（devices-preload.js）——只认精确 devices.html
  'qf-devices-list': [{ file: 'devices.html' }],
  'qf-devices-open': [{ file: 'devices.html' }],
  // ext-bar.html（ext-bar-preload.js）
  'qf-extbar-back': [{ file: 'ext-bar.html' }],
  // session-bar.html（session-bar-preload.js）
  'qf-sessionbar-back': [{ file: 'session-bar.html' }],
  // force-update.html（force-preload.js）
  'qf-force-get': [{ file: 'force-update.html' }],
  'qf-force-download': [{ file: 'force-update.html' }],
  'qf-force-open': [{ file: 'force-update.html' }],
  'qf-force-release': [{ file: 'force-update.html' }],
  // lock.html（lock-preload.js）
  'qf-lock-devices': [{ file: 'lock.html' }],
  'qf-lock-enable': [{ file: 'lock.html' }],
  'qf-lock-disable': [{ file: 'lock.html' }],
  'qf-lock-challenge': [{ file: 'lock.html' }], // C 线：关闭确认弹窗取短期操作挑战
  'qf-lock-reset': [{ file: 'lock.html' }],
  'qf-lock-close': [{ file: 'lock.html' }],
  'qf-lock-repair': [{ file: 'lock.html' }],
  'qf-lock-install-component': [{ file: 'lock.html' }],
  'qf-lock-go-login': [{ file: 'lock.html' }],
  'qf-lock-open-devices': [{ file: 'lock.html' }],
  'qf-lock-open-friends': [{ file: 'lock.html' }],
  // 自家服务源控制台页（console-preload.js，home/好友/聊天/论坛视图）
  'qf-lea-device-info': [{ origin: 'console' }],
  'qf-lea-selfbind-deliver': [{ origin: 'console' }],
  'qf-lea-ush-status': [{ origin: 'console' }],
  'qf-lea-selfbind-status': [{ origin: 'console' }],
  'qf-lea-selfbind-renew': [{ origin: 'console' }],
  'qf-lea-selfbind-clear': [{ origin: 'console' }],
  // S-021：LEA 本机状态查询（about 页诊断区读，只读）。
  'qf-lea-local-status': [{ file: 'about.html' }],
  // P0-2：控制台页初次加载同步主题（只读：mode＋resolved，无任何设置写操作）
  'qf-theme-state-get': [{ origin: 'console' }]
};

/* 本地 file: URL 与固定文件绝对路径比对。query/hash 由 URL 解析天然
 * 剥离；percent 编码、盘符、UNC 一律走 fileURLToPath，不手写 decode
 *（手写 decode 会漏 %2F/%5C、双重编码、点段、非法 %）。平台相关比较
 * 用 path.win32 / path.posix，不依赖宿主平台；win32 下盘符前多余的
 * '/'（posix 侧 fileURLToPath 对 file:///C:/ 的产物）先剥掉，大小写
 * 不敏感。 */
function fileUrlMatchesPath(senderUrl, expectedAbsPath, platform) {
  let u;
  try { u = new URL(String(senderUrl)); } catch (e) { return false; }
  if (u.protocol !== 'file:') return false;
  if (u.host) return false; // file://host/...（UNC/远程文件）一律拒绝
  let actual;
  try { actual = fileURLToPath(u); } catch (e) { return false; }
  const isWin = platform === 'win32';
  if (isWin && /^\/[A-Za-z]:\//.test(actual)) actual = actual.slice(1);
  const pmod = isWin ? path.win32 : path.posix;
  const norm = (p) => {
    let n = pmod.normalize(p);
    if (isWin) n = n.toLowerCase();
    return n;
  };
  try { return norm(actual) === norm(pmod.resolve(expectedAbsPath)); } catch (e) { return false; }
}

/* 远程控制台 sender：https、端口为空或 443、无 userinfo、origin 必须在
 * 精确集合内（不用 startsWith、不用通配、不用主机后缀匹配）。 */
function isTrustedConsoleOrigin(senderUrl, trustedOrigins) {
  let u;
  try { u = new URL(String(senderUrl)); } catch (e) { return false; }
  if (u.protocol !== 'https:') return false;
  if (u.port !== '' && u.port !== '443') return false;
  if (u.username || u.password) return false;
  let set = null;
  try { set = (trustedOrigins instanceof Set) ? trustedOrigins : new Set(trustedOrigins || []); } catch (e) { return false; }
  return set.has(u.origin);
}

/* 在窗口树里找 sender 的宿主窗口：各窗口的 webContents 本身，或其
 * contentView 子树里某 WebContentsView 的 webContents。找不到返回 null。
 * allWindows 由调用方给（生产：BaseWindow.getAllWindows()；单测：mock）。 */
function findHostWindow(sender, allWindows) {
  if (!sender || !Array.isArray(allWindows)) return null;
  const contains = (node) => {
    if (!node || typeof node !== 'object') return false;
    try { if (node.webContents === sender) return true; } catch (e) { /* ignore */ }
    let kids = null;
    try { kids = node.contentView && node.contentView.children; } catch (e) { kids = null; }
    if (Array.isArray(kids)) {
      for (const k of kids) { if (contains(k)) return true; }
    }
    return false;
  };
  for (const w of allWindows) {
    try { if (contains(w)) return w; } catch (e) { /* ignore */ }
  }
  return null;
}

/* 统一校验：五项全过才返回 true，其余一律 false（fail-closed）。
 * ctx：{ dirname, platform, trustedOrigins: () => Set, allWindows: () => [] } */
function assertTrustedSender(event, channel, ctx) {
  try {
    if (!event || typeof event !== 'object') return false;
    const sender = event.sender;
    if (!sender || typeof sender !== 'object') return false;
    try { if (typeof sender.isDestroyed === 'function' && sender.isDestroyed()) return false; } catch (e) { return false; }
    const frame = event.senderFrame;
    if (!frame || typeof frame !== 'object') return false;
    try {
      if (frame.parent) return false; // 只要主框架，iframe 一律拒绝
      if (typeof frame.isDestroyed === 'function' && frame.isDestroyed()) return false;
    } catch (e) { return false; }
    const rules = IPC_CAPABILITIES[channel];
    if (!rules || !Array.isArray(rules) || rules.length === 0) return false; // 未登记的 channel 一律拒绝
    const c = ctx || {};
    let host = null;
    try {
      const wins = (typeof c.allWindows === 'function') ? c.allWindows() : [];
      host = findHostWindow(sender, wins);
    } catch (e) { return false; }
    if (!host) return false;
    try { if (typeof host.isDestroyed === 'function' && host.isDestroyed()) return false; } catch (e) { return false; }
    let url = '';
    try { url = (frame.url && String(frame.url)) || ''; } catch (e) { url = ''; }
    if (!url) {
      try { url = (typeof sender.getURL === 'function') ? String(sender.getURL() || '') : ''; } catch (e) { url = ''; }
    }
    if (!url) return false;
    const dirname = c.dirname || '';
    const platform = c.platform || process.platform;
    const origins = (typeof c.trustedOrigins === 'function') ? c.trustedOrigins() : c.trustedOrigins;
    // 平台相关路径拼接必须用对应平台的 path（win32 下 __dirname 是反斜杠；
    // 宿主若是 posix，path.resolve 会把反斜杠当普通字符拼错）。
    const pmod = (platform === 'win32') ? path.win32 : path.posix;
    for (const rule of rules) {
      if (!rule || typeof rule !== 'object') continue;
      if (rule.file) {
        if (dirname && fileUrlMatchesPath(url, pmod.resolve(dirname, rule.file), platform)) return true;
      } else if (rule.origin === 'console') {
        if (isTrustedConsoleOrigin(url, origins)) return true;
      }
    }
    return false;
  } catch (e) { return false; }
}

/* S-020（第三份 P2-06）：assertTrustedIpcSender 是 assertTrustedSender
 * 的同名入口（清单点名的函数名）：校验 webContents id（sender 在活窗口
 * 树内）、frame URL（固定 file:// 资源或受控本地 scheme）、main frame、
 * 允许的 view（能力表）、调用能力（channel 登记）。参数校验见下。 */
const assertTrustedIpcSender = assertTrustedSender;

/* ---------- S-020：IPC 参数校验（类型／长度／枚举／路径／数字范围） ----------
 * sender 校验只认“谁在调”，不管“调了什么”：高危 IPC 另须过本层。
 * validateIpcArgs(channel, args) -> { ok, reason }；无 spec 的 channel
 * 只走 sender 校验（ok:true），不凭空加限；spec 内任一不过即 fail-closed。
 * 校验器只做形状检查（不碰业务）：字符串须为 string 且长度有界、枚举须
 * 在白名单内、数字须为有限数且在范围内、对象只认白名单键、路径类参数
 * 禁 .. 与绝对路径外泄（openExtPage 的 target 另有 EXT_PAGE_DEFS 白名单）。
 * 密钥类参数（qf-*-bind/claim）只验长度与类型，格式另由 license.js 验。 */
function isStr(v, max, min) {
  return typeof v === 'string' && v.length >= (min || 0) && v.length <= max;
}
function isInt(v, min, max) {
  return Number.isSafeInteger(v) && v >= min && v <= max;
}
function isEnum(v, list) { return typeof v === 'string' && list.indexOf(v) >= 0; }
function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
function noExtraKeys(o, keys) {
  return Object.keys(o).every((k) => keys.indexOf(k) >= 0);
}
const IPC_ARG_SPECS = {
  // 密钥：字符串 ≤512（格式另由 licenseMod.isKeyFormatValid 验）。
  'qf-gate-claim': (a) => a.length === 1 && isStr(a[0], 512),
  'qf-license-bind': (a) => a.length === 1 && isStr(a[0], 512),
  'qf-license-claim': (a) => a.length === 1 && isStr(a[0], 512),
  // 自助绑定交付：对象，票据／挑战／账号／设备／nonce 均为有界字符串，
  // expires_at 为正安全整数；多余键拒绝（防夹带）。
  'qf-lea-selfbind-deliver': (a) => a.length === 1 && isObj(a[0]) &&
    isStr(a[0].ticket, 2048, 1) && isStr(a[0].challenge, 2048, 1) &&
    isStr(a[0].account_id, 128, 1) && isStr(a[0].device_id, 128, 1) &&
    isStr(a[0].nonce, 256, 1) && isInt(a[0].expires_at, 1, 4102444800) &&
    noExtraKeys(a[0], ['ticket', 'challenge', 'account_id', 'device_id', 'nonce', 'expires_at', 'device_name', 'platform', 'server_base']),
  'qf-lea-selfbind-renew': (a) => a.length === 1 && isStr(a[0], 128, 1),
  // 更新设置：只认两个布尔键。
  'qf-update-settings-set': (a) => a.length === 1 && isObj(a[0]) &&
    noExtraKeys(a[0], ['enabled', 'askBeforeDownload']) &&
    (a[0].enabled === undefined || typeof a[0].enabled === 'boolean') &&
    (a[0].askBeforeDownload === undefined || typeof a[0].askBeforeDownload === 'boolean'),
  'qf-autolaunch-set': (a) => a.length === 1 && typeof a[0] === 'boolean',
  // 窗口／导航／缩放：枚举动作，非法动作不得进 switch 缺省分支。
  'qf-win': (a) => a.length === 1 && isEnum(a[0], ['min', 'max', 'close']),
  'qf-nav': (a) => a.length === 1 && isEnum(a[0], ['back', 'forward', 'refresh', 'home', 'friends', 'chat', 'forum', 'home-page', 'register']),
  'qf-zoom': (a) => a.length === 1 && isEnum(a[0], ['in', 'out', 'reset']),
  // 设备页打开会话：nodeId 必填有界串，name/mode 可选有界串。
  'qf-devices-open': (a) => a.length === 1 && isObj(a[0]) && isStr(a[0].nodeId, 128, 1) &&
    (a[0].name === undefined || isStr(a[0].name, 128)) &&
    (a[0].mode === undefined || isStr(a[0].mode, 32)) &&
    noExtraKeys(a[0], ['nodeId', 'name', 'mode']),
  // 溢出菜单：items 为 ≤20 个有界串，x/y 为有限坐标。
  'qf-overflow-menu': (a) => a.length === 1 && isObj(a[0]) &&
    Array.isArray(a[0].items) && a[0].items.length <= 20 &&
    a[0].items.every((s) => isStr(s, 64, 1)) &&
    Number.isFinite(a[0].x) && Number.isFinite(a[0].y) &&
    Math.abs(a[0].x) <= 10000 && Math.abs(a[0].y) <= 10000 &&
    noExtraKeys(a[0], ['items', 'x', 'y']),
  // 隐私锁：id 有界串，密码 1..512 字符（不记日志、不回显，见 lock.js）。
  'qf-lock-enable': (a) => a.length === 2 && isStr(a[0], 128) && isStr(a[1], 512, 1),
  'qf-lock-disable': (a) => a.length === 1 && isStr(a[0], 128),
  'qf-lock-reset': (a) => a.length === 3 && isStr(a[0], 128) && isStr(a[1], 512, 1) && isStr(a[2], 512, 1),
  // 壳内扩展页：target 须为 EXT_PAGE_DEFS 的键（有界串；未知 target 由
  // openExtPage 再挡一道，此处只拦超长／非字符串）。
  'qf-gate-open': (a) => a.length === 1 && isStr(a[0], 64, 1),
  'qf-license-open': (a) => a.length === 1 && isStr(a[0], 64, 1),
  // 更新下载：无参或单个对象参数。
  'qf-update-download': (a) => a.length === 0 || (a.length === 1 && isObj(a[0]))
};
function validateIpcArgs(channel, args) {
  const spec = IPC_ARG_SPECS[channel];
  if (!spec) return { ok: true, reason: 'no-spec' };
  const a = Array.isArray(args) ? args : [];
  let ok = false;
  try { ok = spec(a) === true; } catch (e) { ok = false; }
  return ok ? { ok: true, reason: '' } : { ok: false, reason: 'bad-args:' + String(channel) };
}

module.exports = { IPC_CAPABILITIES, assertTrustedSender, assertTrustedIpcSender, validateIpcArgs, IPC_ARG_SPECS, fileUrlMatchesPath, isTrustedConsoleOrigin, findHostWindow };
