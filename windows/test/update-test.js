'use strict';
/*
 * 软件内更新模块本地自检（不需要真服务器）：
 *  起一个本地 HTTP 服务发假清单 + 假安装包，验证 update.js 的：
 *  A. 清单版本更高 -> 判定有更新；
 *  B. 下载带进度、下完 SHA256 核对通过、文件落盘；
 *  C. 清单 SHA256 写错 -> 下载被拒、坏文件被删干净；
 *  D. 清单版本不更高 -> 判定无更新；
 *  E. 清单里的下载地址指向别的 origin -> 直接拒绝（信任口径）。
 * 结果写 JSON 到 QFTEST_OUT，退出码 0=通过。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PORT = 8977;
const ORIGIN = 'http://127.0.0.1:' + PORT;
process.env.QFREMOTE_RELEASE_URL = ORIGIN + '/release.json';
const updater = require('../update');

const OUT = process.env.QFTEST_OUT || '/tmp/qfr103/update-result.json';
const result = { cases: {}, pass: false };

const payload = crypto.randomBytes(2 * 1024 * 1024 + 12345);
const payloadSha = crypto.createHash('sha256').update(payload).digest('hex');
let manifest = {
  version: '9.9.9',
  notes: '测试更新说明',
  url: ORIGIN + '/QFRemote-Setup-v9.9.9.exe',
  sha256: payloadSha,
  size: payload.length
};

const server = http.createServer((req, res) => {
  if (req.url === '/release.json') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(manifest));
  } else if (req.url === '/QFRemote-Setup-v9.9.9.exe') {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': payload.length });
    // 分片慢发，让进度回调能多次触发
    let off = 0;
    const timer = setInterval(() => {
      const chunk = payload.subarray(off, off + 65536);
      off += chunk.length;
      if (chunk.length === 0) { clearInterval(timer); res.end(); return; }
      res.write(chunk);
    }, 5);
  } else if (req.url === '/drip.exe') {
    // 慢速滴流：每 200ms 发 1 字节，永远发不完——专测「总时长上限」防卡死
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': payload.length });
    res.write(payload.subarray(0, 1024));
    const t = setInterval(() => { try { res.write(Buffer.from([65])); } catch (e) { clearInterval(t); } }, 200);
    req.on('close', () => clearInterval(t));
  } else if (req.url === '/stall.exe') {
    // 只回头不回身：专测不活跃超时
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': payload.length });
    req.on('close', () => { try { res.end(); } catch (e) { /* ignore */ } });
  } else { res.writeHead(404); res.end(); }
});

(async () => {
  await new Promise(r => server.listen(PORT, '127.0.0.1', r));
  const destDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qfr-upd-'));
  try {
    // A
    const a = await updater.checkForUpdate('1.0.3');
    result.cases.A_available = { available: a.available, version: a.manifest && a.manifest.version, pass: a.available === true && a.manifest.version === '9.9.9' };

    // B
    const progresses = [];
    const b = await updater.downloadUpdate(a.manifest, destDir, p => progresses.push(p));
    const landed = fs.existsSync(b.file);
    const landedSha = landed ? await updater.sha256File(b.file) : null;
    result.cases.B_download = {
      file: b.file, landed, shaOk: landedSha === payloadSha, sizeOk: b.size === payload.length,
      progressEvents: progresses.length, lastPercent: progresses.length ? progresses[progresses.length - 1].percent : null,
      pass: landed && landedSha === payloadSha && b.size === payload.length && progresses.length > 1
    };

    // C
    manifest = Object.assign({}, manifest, { sha256: '0'.repeat(64) });
    let cErr = null;
    try { await updater.downloadUpdate(manifest, destDir, () => {}); } catch (e) { cErr = e.message; }
    const badLeft = fs.existsSync(path.join(destDir, 'QFRemote-Setup-v9.9.9.exe.part'));
    result.cases.C_badSha = { error: cErr, partLeft: badLeft, pass: !!cErr && cErr.includes('SHA256') && !badLeft };

    // D
    manifest = Object.assign({}, manifest, { version: '1.0.0', sha256: payloadSha });
    const d = await updater.checkForUpdate('1.0.3');
    result.cases.D_notNewer = { available: d.available, pass: d.available === false };

    // E
    manifest = Object.assign({}, manifest, { version: '9.9.9', url: 'http://127.0.0.1:9999/evil.exe' });
    let eErr = null;
    try { await updater.fetchManifest(); } catch (e) { eErr = e.message; }
    result.cases.E_untrustedUrl = { error: eErr, pass: !!eErr };

    // F：慢速滴流 -> 总时长上限到点强制失败（M2 防卡死修复），不许无限期挂住
    manifest = Object.assign({}, manifest, { version: '9.9.9', url: ORIGIN + '/drip.exe', sha256: payloadSha });
    let fErr = null; const fT0 = Date.now();
    try { await updater.downloadUpdate(manifest, destDir, () => {}, { totalTimeoutMs: 1500 }); } catch (e) { fErr = e.message; }
    const fMs = Date.now() - fT0;
    result.cases.F_dripDeadline = { error: fErr, ms: fMs, pass: !!fErr && fErr.includes('下载时间过长') && fMs < 8000 && !fs.existsSync(path.join(destDir, 'drip.exe.part')) };

    // G：只回头无数据 -> 不活跃超时 15 秒明确失败（给 25 秒宽限判读）
    manifest = Object.assign({}, manifest, { url: ORIGIN + '/stall.exe' });
    let gErr = null; const gT0 = Date.now();
    try { await updater.downloadUpdate(manifest, destDir, () => {}); } catch (e) { gErr = e.message; }
    const gMs = Date.now() - gT0;
    result.cases.G_stallTimeout = { error: gErr, ms: gMs, pass: !!gErr && gErr.includes('下载超时') && gMs >= 12000 && gMs < 30000 };

    result.pass = Object.values(result.cases).every(c => c.pass);
  } catch (e) {
    result.fatal = e.message;
  } finally {
    server.close();
    fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ pass: result.pass, cases: result.cases, fatal: result.fatal || null }));
    process.exit(result.pass ? 0 : 1);
  }
})();
