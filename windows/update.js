'use strict';
/*
 * QFRemote 软件内更新（v1.0.3 起）
 * ================================================================
 * 机制：向自家服务器取一份版本清单 release.json：
 *   { version, notes, url, sha256, size }
 * 清单里的 version 比本机新 -> 有更新；下载安装包到「下载」文件夹，
 * 边下边报进度，下完自动算 SHA256 与清单核对，对得上才允许打开安装，
 * 对不上立刻删文件。取不到清单一律安静失败，绝不弹错误框。
 *
 * 信任口径（不许放宽）：
 *   - 生产环境清单与安装包只认自家正式域名 app.qfremote.top 这一个 origin
 *     （Let's Encrypt 正规证书，Node 默认证书校验，不再关闭校验），
 *     清单里的 url 若指向别的主机，直接拒绝；
 *   - 完整性的最终兜底是安装包 SHA256 必须与清单一致（并核对大小）；
 *   - 测试覆盖开关 QFREMOTE_RELEASE_URL 存在时改认那个 origin（仅测试用，
 *     生产环境不要设置这个环境变量），见 README。
 *     QF-12（3.0.0 低组）：覆盖只许指向本机回环地址（127.0.0.1 /
 *     localhost / ::1，测试假服务器用）；非回环地址一律忽略、回落
 *     正式 origin——本机进程环境被控时更新链不再能被劫持到任意 origin。
 *   （2026-10-29 发版前审计 J-2 定案：更新链自直连自签源收口至正式域名源。）
 * H26（QF-13）：清单离线签名——release.json 带 Ed25519 签名
 *   signature={alg:'ed25519',key_id,sig}，sig 为规范串的签名（base64url）；
 *   规范串 = 去掉 signature 后、key 字典序递归排序的紧凑 JSON（与
 *   server/ext/make-release-json.js 同一份 spec，两处实现须一致）。
 *   取清单时验签：无签名／验签不过即抛错、拒绝更新（fail-closed）。
 *   发版时须用 --sign-key 签名（2.4.5 起的发布流程）；2.4.4 及更早的
 *   客户端没有验签代码，不受此约束——约束自带新代码的版本起生效。
 *   验签公钥内嵌（release-1）；仅测试用环境变量
 *   QFREMOTE_RELEASE_SIGN_PUBLIC_KEY（base64 SPKI）可覆盖，与
 *   QFREMOTE_RELEASE_URL 测试覆盖同款口径，生产环境不要设置。
 * D-02（3.0.0）：只验签名不够——签名 key_id 必须等于当前轮换代次
 *   （RELEASE_SIGN_KEY_ID，现行 release-1），不对即拒绝更新。
 *   key_id 由发版流程（make-release-json.js --check --expect-key-id）
 *   同步核对；轮换时两处同改。仅测试用环境变量
 *   QFREMOTE_RELEASE_SIGN_KEY_ID 可覆盖（与公钥覆盖同款口径）。
 * D-03（3.0.0，照抄 RustDesk updater.rs）：有活跃远程会话时不更新
 *   （自动检查跳过、下载拒绝、安装不拉起）；失败退避重试——会话中
 *   10 分钟、失败 30 分钟、计费连接 30 分钟（见 nextRetryDelayMs）。
 * D-05（3.0.0，照抄 draw.io＋VS Code）：更新策略跟着安装方式走——
 *   安装版（install-mode.txt=installed 或无标记的老版本）走安装包
 *   更新；便携版（install-mode.txt=portable）只提示＋下 ZIP，不静
 *   默装、不转安装版。设置总开关 settings.update.enabled（默认开，
 *   只关自动检查；手动检查仍可用）；集中管理环境变量
 *   QFREMOTE_DISABLE_UPDATE=1 关全部检查（含手动）。计费连接上自动
 *   检查暂停（VS Code PR #331701 同款口径），恢复不限流量后继续。
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const clientVersion = require('./client-version');

const PROD_ORIGIN = 'https://app.qfremote.top';
const PROD_RELEASE_URL = PROD_ORIGIN + '/release.json';
// 仅测试用：覆盖清单地址（同时该地址的 origin 成为本次运行唯一可信 origin）
// QF-12（3.0.0 低组）：只许指向本机回环地址（127.0.0.1 / localhost /
// ::1，测试假服务器用）；非回环地址一律忽略、回落正式 origin。旧版
// 任意 origin 都认：本机进程环境被控时更新链可被劫持到任意 origin。
// 生产环境不要设置这个环境变量。
function isLoopbackOrigin(raw) {
  try {
    const u = new URL(raw);
    // DS R1 观察：FQDN 尾点（localhost.）也是回环写法，先 strip 尾点再比。
    const h = u.hostname.toLowerCase().replace(/\.$/, '');
    return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1' || h.endsWith('.localhost');
  } catch (e) { return false; }
}
const OVERRIDE_URL = process.env.QFREMOTE_RELEASE_URL || '';
const OVERRIDE_OK = OVERRIDE_URL ? isLoopbackOrigin(OVERRIDE_URL) : false;
if (OVERRIDE_URL && !OVERRIDE_OK) console.error('QFREMOTE_RELEASE_URL 指向非回环地址，已忽略（仅测试可用回环地址覆盖）');
const RELEASE_URL = OVERRIDE_OK ? OVERRIDE_URL : PROD_RELEASE_URL;
const TRUSTED_ORIGIN = OVERRIDE_OK ? new URL(OVERRIDE_URL).origin : PROD_ORIGIN;
// H26：发版签名公钥（release-1，Ed25519 SPKI DER base64）。与
// server/ext/make-release-json.js 的 RELEASE_SIGN_PUBLIC_KEY_B64 同值；
// 轮换时两处同改。仅测试用环境变量可覆盖（见文件头）。
const RELEASE_SIGN_PUBLIC_KEY_B64 = 'MCowBQYDK2VwAyEAmGZlcEEV5U0J9ciAaA69WYkIfG/Og7arHBEuR+PTtnA=';
// D-02：当前签名密钥轮换代次。key_id 不对即拒绝更新（见 fetchManifest）。
// 轮换时与 make-release-json.js 的 RELEASE_SIGN_KEY_ID 同改。
const RELEASE_SIGN_KEY_ID = 'release-1';

function releaseVerifyKeyB64() {
  const ov = process.env.QFREMOTE_RELEASE_SIGN_PUBLIC_KEY || '';
  return ov || RELEASE_SIGN_PUBLIC_KEY_B64;
}

// D-02：期望的 key_id。仅测试用环境变量可覆盖（与公钥覆盖同款口径）。
function releaseExpectedKeyId() {
  const ov = process.env.QFREMOTE_RELEASE_SIGN_KEY_ID || '';
  return ov || RELEASE_SIGN_KEY_ID;
}

// D-05：安装方式判定。安装器写 install-mode.txt=installed，便携 ZIP 里
// 带 install-mode.txt=portable；无标记即老版本安装版（默认 installed）。
function detectInstallMode(appDir) {
  try {
    const v = fs.readFileSync(path.join(appDir, 'install-mode.txt'), 'utf8').trim().toLowerCase();
    if (v === 'portable' || v === 'installed') return v;
  } catch (e) { /* 无标记：老版本安装版 */ }
  return 'installed';
}

// D-05：按安装方式＋设置给出的更新策略（纯函数，可单测）。
//   installed：自动检查（总开关可关）＋点按下载安装包＋重启安装；
//   portable：自动检查只为提示，下载只给 ZIP、永不静默装、不转安装版。
//   askBeforeDownload=true 时下载须经一次显式确认（主进程握手）。
function getUpdatePolicy(installMode, updateSettings) {
  const s = (updateSettings && typeof updateSettings === 'object') ? updateSettings : {};
  const enabled = s.enabled !== false;
  const askBeforeDownload = s.askBeforeDownload === true;
  if (installMode === 'portable') {
    return { installMode: 'portable', enabled, askBeforeDownload, autoCheck: enabled, autoDownload: false, downloadKind: 'portable-zip', installAction: 'manual' };
  }
  return { installMode: 'installed', enabled, askBeforeDownload, autoCheck: enabled, autoDownload: false, downloadKind: 'installer', installAction: 'restart' };
}

// D-03：失败退避间隔（照抄 RustDesk：有会话 10 分钟／失败 30 分钟）。
// 纯函数：{activeSession, metered, consecutiveFailures} -> 毫秒（0=不约）。
const UPDATE_RETRY_MS = { ACTIVE_SESSION: 10 * 60 * 1000, FAILURE: 30 * 60 * 1000, METERED: 30 * 60 * 1000 };
function nextRetryDelayMs(state) {
  const s = state || {};
  if (s.activeSession) return UPDATE_RETRY_MS.ACTIVE_SESSION;
  if (s.metered) return UPDATE_RETRY_MS.METERED;
  if ((s.consecutiveFailures || 0) > 0) return UPDATE_RETRY_MS.FAILURE;
  return 0;
}

// D-05：是否在按流量计费的连接上。Windows 用 WinRT NetworkInformation
// 查当前连接的 NetworkCostType（Fixed/Variable 即计费）；非 Windows 一
// 律 false。查不到（离线/无 WinRT）按不限流量处理——更新检查本身会失败，
// 不由这里多拦一道。结果缓存 5 分钟。仅测试用环境变量
// QFREMOTE_METERED_TEST=1/0 可强制（与公钥覆盖同款口径）。
let meteredCache = { at: 0, value: false };
function isMeteredConnection() {
  const ov = process.env.QFREMOTE_METERED_TEST || '';
  if (ov === '1') return Promise.resolve(true);
  if (ov === '0') return Promise.resolve(false);
  if (process.platform !== 'win32') return Promise.resolve(false);
  if (Date.now() - meteredCache.at < 5 * 60 * 1000) return Promise.resolve(meteredCache.value);
  return new Promise((resolve) => {
    const ps = 'try { $p = [Windows.Networking.Connectivity.NetworkInformation, Windows.Networking.Connectivity, ContentType=WindowsRuntime]::GetInternetConnectionProfile(); if ($null -eq $p) { exit 2 }; $c = $p.GetConnectionCost(); if ($c.NetworkCostType -eq "Fixed" -or $c.NetworkCostType -eq "Variable") { exit 1 } else { exit 0 } } catch { exit 2 }';
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 10000 }, (err) => {
      // exit 1=计费，0=不限流量，2=查不到（按不限流量处理）。
      const metered = !!(err && typeof err.code === 'number' && err.code === 1);
      meteredCache = { at: Date.now(), value: metered };
      resolve(metered);
    });
  });
}

function canonicalReleaseJson(doc) {
  // H26 规范串（与 make-release-json.js 同 spec）：去 signature、key 字典序递归排序、紧凑 JSON。
  function sort(v) {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === 'object') {
      const o = {};
      Object.keys(v).sort().forEach((k) => { o[k] = sort(v[k]); });
      return o;
    }
    return v;
  }
  const d = Object.assign({}, doc);
  delete d.signature;
  return JSON.stringify(sort(d));
}

// H26：验 release.json 签名。返回 { ok, reason }；ok=false 时调用方拒绝更新。
function verifyReleaseSignature(doc) {
  const sig = doc && doc.signature;
  // r11③：缺签名单独给机器码 missing-signature——fetchManifest 的兼容
  // 垫片按码识别，不依赖 reason 文案（文案一改垫片就失效）。
  if (!sig || typeof sig !== 'object') return { ok: false, reason: '缺少 signature 字段', code: 'missing-signature' };
  if (sig.alg !== 'ed25519') return { ok: false, reason: '未知签名算法：' + String(sig.alg) };
  if (typeof sig.sig !== 'string' || !/^[A-Za-z0-9_-]+$/.test(sig.sig)) return { ok: false, reason: 'sig 不是 base64url' };
  let pub;
  try { pub = crypto.createPublicKey({ key: Buffer.from(releaseVerifyKeyB64(), 'base64'), format: 'der', type: 'spki' }); } catch (e) { return { ok: false, reason: '验签公钥无法加载' }; }
  let ok = false;
  try { ok = crypto.verify(null, Buffer.from(canonicalReleaseJson(doc), 'utf8'), pub, Buffer.from(sig.sig, 'base64url')); } catch (e) { ok = false; }
  return ok ? { ok: true, key_id: sig.key_id || null } : { ok: false, reason: '签名与文档内容不符' };
}

function compareVersions(a, b) {
  const pa = String(a).split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

function isTrustedUrl(raw) {
  try { return new URL(raw).origin === TRUSTED_ORIGIN; } catch (e) { return false; }
}

// 带超时的 GET（证书走 Node 默认校验，见文件头信任口径）
// W-19：重定向最多 5 跳，循环重定向直接拒绝（此前无限递归可致永不返回）。
function getBuffer(rawUrl, timeoutMs, redirects) {
  const hops = redirects || 0;
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(rawUrl); } catch (e) { reject(new Error('更新清单地址不正确')); return; }
    if (!isTrustedUrl(rawUrl)) { reject(new Error('地址不在信任范围内')); return; }
    if (hops > 5) { reject(new Error('重定向次数过多')); return; }
    const lib = u.protocol === 'https:' ? https : http;
    // 2.3.2：清单 GET 带统一版本头（互联窗观察，见 client-version.js）
    const opts = { timeout: timeoutMs || 8000, headers: clientVersion.clientVersionHeaders() };
    const req = lib.get(u, opts, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        // 重定向也只许去可信 origin
        getBuffer(new URL(res.headers.location, u).toString(), timeoutMs, hops + 1).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) { res.resume(); reject(new Error('HTTP ' + res.statusCode)); return; }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('连接超时')));
    req.on('error', reject);
  });
}

// 自愈结果回带（2.4.4）：客户端启动自愈（agent-heal.js）有结果后，
// 下次取清单时在 URL 后带 ?heal=<结果>（白名单取值，无个人信息），
// 清单仍是静态文件、服务端只在 Caddy 访问日志里留痕；取失败不重试、
// 不影响更新。成功取到后清掉（一次结果只带一次）。
let healReport = null;
function setHealReport(outcome) {
  // 2.4.5：分类码含连字符（如 dns-fail），字符集放宽到 [a-z0-9_-]。
  healReport = (typeof outcome === 'string' && /^[a-z0-9_-]+$/.test(outcome)) ? outcome : null;
}

// 取清单并校验。返回 {version, notes, url(绝对地址), sha256, size} 或抛错（调用方安静处理）。
// W-26：healReport 只在清单解析成功后清掉；解析失败保留待下次回带。
async function fetchManifest(timeoutMs) {
  const fetchUrl = healReport ? RELEASE_URL + '?heal=' + encodeURIComponent(healReport) : RELEASE_URL;
  const buf = await getBuffer(fetchUrl, timeoutMs || 8000);
  let m;
  try { m = JSON.parse(buf.toString('utf8')); } catch (e) { throw new Error('更新清单格式不正确'); }
  healReport = null;
  if (!m || typeof m.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(m.version)) throw new Error('更新清单缺少版本号');
  if (typeof m.url !== 'string' || !m.url) throw new Error('更新清单缺少下载地址');
  const absUrl = new URL(m.url, RELEASE_URL).toString();
  if (!isTrustedUrl(absUrl)) throw new Error('清单里的下载地址不在信任范围内');
  const sha = typeof m.sha256 === 'string' ? m.sha256.toLowerCase() : '';
  if (!/^[0-9a-f]{64}$/.test(sha)) throw new Error('更新清单缺少完整的 SHA256 校验码');
  // H26：清单签名必验——无签名／验签不过即拒绝更新（fail-closed）。
  // 2.4.5 起发版流程用 --sign-key 签名；签发方漏签时客户端宁可不更新。
  // r11③ 例外（有界兼容垫片）：线上现行清单是 H26 之前发布的 2.4.4，
  // 本来就没有 signature 字段——它不是被篡改，是发版时签名机制还不
  // 存在。仅当“缺签名、且版本号 ≤2.4.4（最后一个发版前版本）”时放
  // 行，并记 signatureVerified:false；版本号更新、或签名在场但验不
  // 过，仍一律拒绝。放行的唯一后果是“不提供比 2.4.4 更新的版本”，
  // 与清单未签名时能做的事相同；下载仍须 SHA256＋size＋可信 origin
  // 三重核对。服务端正确修复是重发已签名的 release.json（见 REPORT），
  // 该垫片在服务端清单带签名后即可删除（日落条件：线上清单含有效签名）。
  const vr = verifyReleaseSignature(m);
  let signatureVerified = true;
  if (!vr.ok) {
    const missingSig = vr.code === 'missing-signature';
    const preSigning = compareVersions(m.version, '2.4.4') <= 0;
    if (!(missingSig && preSigning)) throw new Error('更新清单签名无效（' + vr.reason + '），拒绝更新');
    signatureVerified = false;
  } else if (vr.key_id !== releaseExpectedKeyId()) {
    // D-02：签名本身有效、但 key_id 不是当前轮换代次——拒绝更新。
    // （如旧密钥签发的新清单、或轮换后发版方漏换 key_id。）
    throw new Error('更新清单签名 key_id 不符（' + String(vr.key_id) + '，期望 ' + releaseExpectedKeyId() + '），拒绝更新');
  }
  // D-04：便携版下载信息（可选段；发版时 make-release-json.js --zip 写入）。
  // 有该段时逐项校验（可信 origin＋SHA256＋size），缺一即拒绝整份清单。
  let portable = null;
  if (m.portable && typeof m.portable === 'object') {
    const pUrl = typeof m.portable.url === 'string' ? new URL(m.portable.url, RELEASE_URL).toString() : '';
    if (!isTrustedUrl(pUrl)) throw new Error('清单里便携版下载地址不在信任范围内');
    const pSha = typeof m.portable.sha256 === 'string' ? m.portable.sha256.toLowerCase() : '';
    if (!/^[0-9a-f]{64}$/.test(pSha)) throw new Error('清单里便携版缺少完整的 SHA256 校验码');
    if (typeof m.portable.size !== 'number' || !Number.isFinite(m.portable.size) || m.portable.size <= 0) throw new Error('清单里便携版缺少有效的文件大小');
    portable = { url: pUrl, sha256: pSha, size: m.portable.size };
  }
  // 强更线 minUsable（2026-11-07 站长令）：清单可选字段，本机版本低于它即触发
  // 启动强制更新（见 main.js startupUpdateGate）；缺失/格式不合规按无强更线处理。
  const minUsable = (typeof m.minUsable === 'string' && /^\d+\.\d+\.\d+$/.test(m.minUsable)) ? m.minUsable : null;
  return {
    version: m.version,
    notes: typeof m.notes === 'string' ? m.notes : '',
    url: absUrl,
    sha256: sha,
    size: typeof m.size === 'number' ? m.size : null,
    minUsable,
    signatureVerified,
    portable
  };
}

// 检查更新：{available, manifest|null, error|null, skipped?}
// D-03/D-05：opts={manual, hasActiveSession(bool|fn), updateEnabled, metered}。
//   自动检查（manual=false）：总开关关／会话中／计费连接时跳过，返 skipped
//   （'disabled'/'active-session'/'metered'），不记错误；手动检查跳过会话与
//   计费两道门（用户当面点的，只查清单、不下载）；集中管理环境变量
//   QFREMOTE_DISABLE_UPDATE=1 关全部检查（含手动）。
// W-26：timeoutMs 可透传（启动后自动检查用 5s、关于面板手动检查用 8s）。
async function checkForUpdate(currentVersion, timeoutMs, opts) {
  const o = opts || {};
  if (process.env.QFREMOTE_DISABLE_UPDATE === '1') return { available: false, manifest: null, error: null, skipped: 'disabled' };
  if (o.updateEnabled === false && !o.manual) return { available: false, manifest: null, error: null, skipped: 'disabled' };
  const manual = !!o.manual;
  const hasActiveSession = typeof o.hasActiveSession === 'function' ? !!o.hasActiveSession() : !!o.hasActiveSession;
  if (hasActiveSession && !manual) return { available: false, manifest: null, error: null, skipped: 'active-session' };
  let metered = null;
  if (typeof o.metered === 'boolean') metered = o.metered;
  else if (!manual) metered = await isMeteredConnection();
  if (metered && !manual) return { available: false, manifest: null, error: null, skipped: 'metered' };
  try {
    const manifest = await fetchManifest(timeoutMs);
    return { available: compareVersions(manifest.version, currentVersion) > 0, manifest, error: null };
  } catch (e) {
    return { available: false, manifest: null, error: e.message };
  }
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(file);
    s.on('data', d => h.update(d));
    s.on('end', () => resolve(h.digest('hex')));
    s.on('error', reject);
  });
}

// 流式下载到 part 文件，边下边回调进度；任何失败由调用方删 part。
// 防卡死三道闸（M2 线追加修复，2.4.5 W-18 改为「无进度超时」）：
//  ① 连接不活跃超时 15 秒（req timeout，现行）；
//  ② 无进度超时 60 秒：收到数据就重置计时器——下载一直在推进时不再被掐；
//  ③ 总时长上限 90 分钟（122MB 在 25KB/s 下约 83 分钟可完成；此前 30 分钟
//     上限让慢网用户永远下不完）。deadline 在请求发出时即设，不等响应头。
//  ④ 响应中途 aborted 也明确失败，不让 pipe 悬空等 finish。
function downloadToFile(u, part, manifest, onProgress, opts2) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let deadline = null;
    let idleTimer = null;
    let out = null;
    const done = (fn, v) => { if (settled) return; settled = true; if (deadline) clearTimeout(deadline); if (idleTimer) clearTimeout(idleTimer); fn(v); };
    const ok = () => done(resolve);
    const fail = (e) => { try { if (out) out.destroy(); } catch (err) { /* ignore */ } done(reject, e instanceof Error ? e : new Error(String(e))); };
    const lib = u.protocol === 'https:' ? https : http;
    const opts = { timeout: 15000, headers: clientVersion.clientVersionHeaders() };
    const totalMs = (opts2 && opts2.totalTimeoutMs) || 5400000; // 90 分钟
    const idleMs = (opts2 && opts2.idleTimeoutMs) || 60000; // 60 秒无进度
    const armIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        try { req.destroy(); } catch (e) { /* ignore */ }
        fail(new Error('下载停滞（60 秒无进度），已自动取消。请检查网络后重试。'));
      }, idleMs);
    };
    // 总时长 deadline 在请求发出时即设（此前只在收到响应头后才设）。
    deadline = setTimeout(() => {
      try { req.destroy(); } catch (e) { /* ignore */ }
      fail(new Error('下载时间过长，已自动取消（网速太慢或连接异常）。请检查网络后重试。'));
    }, totalMs);
    const req = lib.get(u, opts, (res) => {
      if (res.statusCode !== 200) { res.resume(); fail(new Error('下载失败：HTTP ' + res.statusCode)); return; }
      const total = manifest.size || parseInt(res.headers['content-length'] || '0', 10) || null;
      let received = 0;
      out = fs.createWriteStream(part);
      armIdle();
      res.on('data', (chunk) => {
        received += chunk.length;
        armIdle();
        if (onProgress) onProgress({ received, total, percent: total ? Math.min(100, Math.floor(received / total * 100)) : null });
      });
      res.pipe(out);
      out.on('finish', () => out.close(() => ok()));
      out.on('error', fail);
      res.on('error', fail);
      res.on('aborted', () => fail(new Error('下载被中断（网络异常），请重试。')));
    });
    req.on('timeout', () => req.destroy(new Error('下载超时（连接长时间无响应），请检查网络后重试。')));
    req.on('error', fail);
  });
}

// 下载安装包到 destDir：回调 onProgress({received, total, percent})；
// 下完自动核对大小（清单给了才核）与 SHA256：对不上删文件并抛错。
async function downloadUpdate(manifest, destDir, onProgress, opts) {
  // 空值守卫：调用方传了 null／缺 url 的清单时，以前在这里读 manifest.url
  // 直接抛 TypeError（client-version-test 既有 fatal 即源于此：清单验签
  // 不过时 checkForUpdate 返 manifest:null）。清单无效一律明言拒绝，
  // 不读空值、不静默。sha256 同理（后文调 manifest.sha256.toLowerCase()）。
  if (!manifest || typeof manifest !== 'object') throw new Error('更新清单为空，无法下载');
  if (typeof manifest.url !== 'string' || !manifest.url) throw new Error('更新清单缺少下载地址，无法下载');
  if (typeof manifest.sha256 !== 'string' || !manifest.sha256) throw new Error('更新清单缺少 SHA256 校验码，无法下载');
  // D-03：会话中不下载（主进程下载入口另有同一道门，这里是纵深防御）。
  // D-04：kind='portable' 时下清单 portable 段的 ZIP（便携版只提示＋下 ZIP）。
  const o = opts || {};
  if (o.hasActiveSession) throw new Error('有进行中的远程会话，暂不下载更新');
  let src = manifest;
  if (o.kind === 'portable') {
    if (!manifest.portable || typeof manifest.portable !== 'object') throw new Error('更新清单无便携版下载地址');
    src = manifest.portable;
  }
  if (typeof src.url !== 'string' || !src.url) throw new Error('下载地址缺失，无法下载');
  if (typeof src.sha256 !== 'string' || !src.sha256) throw new Error('下载缺少 SHA256 校验码，无法下载');
  if (!isTrustedUrl(src.url)) throw new Error('下载地址不在信任范围内');
  const u = new URL(src.url);
  const name = path.basename(u.pathname).replace(/[^\w.\- ]/g, '_') || 'QFRemote-Setup.exe';
  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, name);
  const part = dest + '.part';
  try {
    await downloadToFile(u, part, src, onProgress, opts || {});
  } catch (e) {
    try { fs.unlinkSync(part); } catch (err) { /* ignore */ }
    throw e;
  }
  try {
    const st = fs.statSync(part);
    // QF-11（3.0.0 低组）：清单 size 必填——缺失／非正数即拒绝，不再
    // “给了才核、缺了只凭 SHA-256”。SHA-256 本可兜底内容完整性，但缺
    // size 时“文件多大才算下完”无锚点，且与安卓口径（清单 size 必填，
    // 见 manifest.dart H-3）不一致；发版口径 release.json 必带 size，
    // 缺失即清单不完整。核对失败一律删文件（见下 catch）。
    if (typeof src.size !== 'number' || !Number.isFinite(src.size) || src.size <= 0) throw new Error('更新清单缺少有效的文件大小（size 必填）');
    if (st.size !== src.size) throw new Error('文件大小与清单不一致');
    const digest = await sha256File(part);
    if (digest.toLowerCase() !== src.sha256.toLowerCase()) throw new Error('SHA256 校验码不一致');
    fs.renameSync(part, dest);
    return { file: dest, sha256: digest, size: st.size };
  } catch (e) {
    try { fs.unlinkSync(part); } catch (err) { /* ignore */ }
    try { if (fs.existsSync(dest)) fs.unlinkSync(dest); } catch (err) { /* ignore */ }
    if (e.message === '更新清单缺少有效的文件大小（size 必填）') throw new Error('更新清单不完整（缺少文件大小），已删除，请重新下载。');
    if (e.message === '文件大小与清单不一致') throw new Error('下载不完整（文件大小与清单不一致），已删除，请重新下载。');
    if (e.message === 'SHA256 校验码不一致') throw new Error('完整性核对未通过（SHA256 校验码不一致），已删除该文件，请重新下载。');
    throw e;
  }
}

module.exports = { RELEASE_URL, TRUSTED_ORIGIN, PROD_RELEASE_URL, compareVersions, fetchManifest, checkForUpdate, downloadUpdate, sha256File, setHealReport, canonicalReleaseJson, verifyReleaseSignature, RELEASE_SIGN_PUBLIC_KEY_B64, RELEASE_SIGN_KEY_ID, releaseExpectedKeyId, detectInstallMode, getUpdatePolicy, isMeteredConnection, nextRetryDelayMs, UPDATE_RETRY_MS };
