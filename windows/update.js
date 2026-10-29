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
function getBuffer(rawUrl, timeoutMs) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(rawUrl); } catch (e) { reject(new Error('更新清单地址不正确')); return; }
    if (!isTrustedUrl(rawUrl)) { reject(new Error('地址不在信任范围内')); return; }
    const lib = u.protocol === 'https:' ? https : http;
    // 2.3.2：清单 GET 带统一版本头（互联窗观察，见 client-version.js）
    const opts = { timeout: timeoutMs || 8000, headers: clientVersion.clientVersionHeaders() };
    const req = lib.get(u, opts, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        // 重定向也只许去可信 origin
        getBuffer(new URL(res.headers.location, u).toString(), timeoutMs).then(resolve, reject);
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

// 取清单并校验。返回 {version, notes, url(绝对地址), sha256, size} 或抛错（调用方安静处理）。
async function fetchManifest() {
  const buf = await getBuffer(RELEASE_URL, 8000);
  let m;
  try { m = JSON.parse(buf.toString('utf8')); } catch (e) { throw new Error('更新清单格式不正确'); }
  if (!m || typeof m.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(m.version)) throw new Error('更新清单缺少版本号');
  if (typeof m.url !== 'string' || !m.url) throw new Error('更新清单缺少下载地址');
  const absUrl = new URL(m.url, RELEASE_URL).toString();
  if (!isTrustedUrl(absUrl)) throw new Error('清单里的下载地址不在信任范围内');
  const sha = typeof m.sha256 === 'string' ? m.sha256.toLowerCase() : '';
  if (!/^[0-9a-f]{64}$/.test(sha)) throw new Error('更新清单缺少完整的 SHA256 校验码');
  return {
    version: m.version,
    notes: typeof m.notes === 'string' ? m.notes : '',
    url: absUrl,
    sha256: sha,
    size: typeof m.size === 'number' ? m.size : null
  };
}

// 检查更新：{available, manifest|null, error|null}
async function checkForUpdate(currentVersion) {
  try {
    const manifest = await fetchManifest();
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
// 防卡死两道闸（M2 线追加修复）：
//  ① 连接不活跃超时 15 秒（req timeout，现行）；
//  ② 总时长上限：按文件大小以约 25KB/s 的极慢网速兜底估算（最短 5 分钟、最长 30 分钟），
//     到点强制中断并抛明确错误——此前只有不活跃超时，对方慢速滴流时下载会无限期
//     停在「正在下载」且按钮禁用，用户无路可退（站长 2026-10-25 报的卡住感根源）。
//  ③ 响应中途 aborted 也明确失败，不让 pipe 悬空等 finish。
function downloadToFile(u, part, manifest, onProgress, opts2) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let deadline = null;
    let out = null;
    const done = (fn, v) => { if (settled) return; settled = true; if (deadline) clearTimeout(deadline); fn(v); };
    const ok = () => done(resolve);
    const fail = (e) => { try { if (out) out.destroy(); } catch (err) { /* ignore */ } done(reject, e instanceof Error ? e : new Error(String(e))); };
    const lib = u.protocol === 'https:' ? https : http;
    const opts = { timeout: 15000, headers: clientVersion.clientVersionHeaders() };
    const req = lib.get(u, opts, (res) => {
      if (res.statusCode !== 200) { res.resume(); fail(new Error('下载失败：HTTP ' + res.statusCode)); return; }
      const total = manifest.size || parseInt(res.headers['content-length'] || '0', 10) || null;
      const totalMs = (opts2 && opts2.totalTimeoutMs) || Math.min(1800000, Math.max(300000, total ? Math.round(total / (25 * 1024) * 1000) : 600000));
      deadline = setTimeout(() => { try { req.destroy(new Error('下载时间过长，已自动取消（网速太慢或连接异常）。请检查网络后重试。')); } catch (e) { fail(e); } }, totalMs);
      let received = 0;
      out = fs.createWriteStream(part);
      res.on('data', (chunk) => {
        received += chunk.length;
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

module.exports = { RELEASE_URL, TRUSTED_ORIGIN, PROD_RELEASE_URL, compareVersions, fetchManifest, checkForUpdate, downloadUpdate, sha256File };
