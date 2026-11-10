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
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const clientVersion = require('./client-version');

const PROD_ORIGIN = 'https://app.qfremote.top';
const PROD_RELEASE_URL = PROD_ORIGIN + '/release.json';
// 仅测试用：覆盖清单地址（同时该地址的 origin 成为本次运行唯一可信 origin）
const OVERRIDE_URL = process.env.QFREMOTE_RELEASE_URL || '';
const RELEASE_URL = OVERRIDE_URL || PROD_RELEASE_URL;
const TRUSTED_ORIGIN = OVERRIDE_URL ? new URL(OVERRIDE_URL).origin : PROD_ORIGIN;
// H26：发版签名公钥（release-1，Ed25519 SPKI DER base64）。与
// server/ext/make-release-json.js 的 RELEASE_SIGN_PUBLIC_KEY_B64 同值；
// 轮换时两处同改。仅测试用环境变量可覆盖（见文件头）。
const RELEASE_SIGN_PUBLIC_KEY_B64 = 'MCowBQYDK2VwAyEAmGZlcEEV5U0J9ciAaA69WYkIfG/Og7arHBEuR+PTtnA=';

function releaseVerifyKeyB64() {
  const ov = process.env.QFREMOTE_RELEASE_SIGN_PUBLIC_KEY || '';
  return ov || RELEASE_SIGN_PUBLIC_KEY_B64;
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
  if (!sig || typeof sig !== 'object') return { ok: false, reason: '缺少 signature 字段' };
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
  const vr = verifyReleaseSignature(m);
  if (!vr.ok) throw new Error('更新清单签名无效（' + vr.reason + '），拒绝更新');
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
    signatureVerified: true
  };
}

// 检查更新：{available, manifest|null, error|null}
// W-26：timeoutMs 可透传（启动后自动检查用 5s、关于面板手动检查用 8s）。
async function checkForUpdate(currentVersion, timeoutMs) {
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
  if (!isTrustedUrl(manifest.url)) throw new Error('下载地址不在信任范围内');
  const u = new URL(manifest.url);
  const name = path.basename(u.pathname).replace(/[^\w.\- ]/g, '_') || 'QFRemote-Setup.exe';
  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, name);
  const part = dest + '.part';
  try {
    await downloadToFile(u, part, manifest, onProgress, opts || {});
  } catch (e) {
    try { fs.unlinkSync(part); } catch (err) { /* ignore */ }
    throw e;
  }
  try {
    const st = fs.statSync(part);
    if (manifest.size && st.size !== manifest.size) throw new Error('文件大小与清单不一致');
    const digest = await sha256File(part);
    if (digest.toLowerCase() !== manifest.sha256.toLowerCase()) throw new Error('SHA256 校验码不一致');
    fs.renameSync(part, dest);
    return { file: dest, sha256: digest, size: st.size };
  } catch (e) {
    try { fs.unlinkSync(part); } catch (err) { /* ignore */ }
    try { if (fs.existsSync(dest)) fs.unlinkSync(dest); } catch (err) { /* ignore */ }
    if (e.message === '文件大小与清单不一致') throw new Error('下载不完整（文件大小与清单不一致），已删除，请重新下载。');
    if (e.message === 'SHA256 校验码不一致') throw new Error('完整性核对未通过（SHA256 校验码不一致），已删除该文件，请重新下载。');
    throw e;
  }
}

module.exports = { RELEASE_URL, TRUSTED_ORIGIN, PROD_RELEASE_URL, compareVersions, fetchManifest, checkForUpdate, downloadUpdate, sha256File, setHealReport, canonicalReleaseJson, verifyReleaseSignature, RELEASE_SIGN_PUBLIC_KEY_B64 };
