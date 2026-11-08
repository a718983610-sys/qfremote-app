'use strict';
/*
 * 2.4.4 更新链专项自检（在 update-test.js 通用用例之外，专验本版口径）：
 *  本地 HTTP 假清单服务器发 version=2.4.4、minUsable=2.4.4 的清单 + 假安装包，验证：
 *  A. 以 2.4.3 检查 -> 有 2.4.4 更新，清单 minUsable=2.4.4，
 *     且 compareVersions('2.4.3','2.4.4')<0（启动强更门接管的条件）；
 *  B. 以 2.4.4 检查 -> 无更新；
 *  C. 以 2.4.2 检查 -> 也有 2.4.4 更新（强更覆盖全部低于 minUsable 的旧版）；
 *  D. 下载 2.4.4 包：进度回调、SHA256 核对通过、文件落盘；
 *  E. 自愈结果回带：setHealReport('fixed') 后取清单，请求带 ?heal=fixed；
 *     再取一次，不带（用一次即清）；
 *  F. 回带白名单：非法取值不带上（不把任意串打进访问日志）。
 * 结果写 JSON 到 QFTEST_OUT，退出码 0=通过。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PORT = 8981;
const ORIGIN = 'http://127.0.0.1:' + PORT;
process.env.QFREMOTE_RELEASE_URL = ORIGIN + '/release.json';
const updater = require('../update');

const OUT = process.env.QFTEST_OUT || '/tmp/qfr244/update-chain-result.json';
const result = { cases: {}, pass: false };

const payload = crypto.randomBytes(1024 * 1024 + 777);
const payloadSha = crypto.createHash('sha256').update(payload).digest('hex');
const manifest = {
  version: '2.4.4',
  minUsable: '2.4.4',
  notes: 'QFRemote 2.4.4',
  url: ORIGIN + '/QFRemote-Setup-v2.4.4.exe',
  sha256: payloadSha,
  size: payload.length
};

const seenUrls = [];
const server = http.createServer((req, res) => {
  if (req.url.startsWith('/release.json')) {
    seenUrls.push(req.url);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(manifest));
  } else if (req.url === '/QFRemote-Setup-v2.4.4.exe') {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': payload.length });
    res.end(payload);
  } else { res.writeHead(404); res.end(); }
});

(async () => {
  await new Promise(r => server.listen(PORT, '127.0.0.1', r));
  const destDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qfr-chain244-'));
  try {
    const a = await updater.checkForUpdate('2.4.3');
    result.cases.A_from_243_available = {
      pass: a.available === true && a.manifest.version === '2.4.4' &&
        a.manifest.minUsable === '2.4.4' &&
        updater.compareVersions('2.4.3', a.manifest.minUsable) < 0,
      available: a.available, version: a.manifest && a.manifest.version,
      minUsable: a.manifest && a.manifest.minUsable
    };

    const b = await updater.checkForUpdate('2.4.4');
    result.cases.B_at_244_none = { pass: b.available === false, available: b.available };

    const c = await updater.checkForUpdate('2.4.2');
    result.cases.C_from_242_available = {
      pass: c.available === true && c.manifest.minUsable === '2.4.4' &&
        updater.compareVersions('2.4.2', c.manifest.minUsable) < 0,
      available: c.available
    };

    let progressHits = 0;
    const dl = await updater.downloadUpdate(a.manifest, destDir, () => { progressHits++; });
    const landed = fs.existsSync(dl.file) && fs.statSync(dl.file).size === payload.length && dl.sha256 === payloadSha;
    result.cases.D_download_verify = { pass: landed && progressHits > 0, file: path.basename(dl.file), progressHits };

    // E：回带一次
    seenUrls.length = 0;
    updater.setHealReport('fixed');
    await updater.fetchManifest();
    const firstUrl = seenUrls[seenUrls.length - 1] || '';
    await updater.fetchManifest();
    const secondUrl = seenUrls[seenUrls.length - 1] || '';
    result.cases.E_heal_carry_once = {
      pass: firstUrl === '/release.json?heal=fixed' && secondUrl === '/release.json',
      firstUrl, secondUrl
    };

    // F：非法取值不带上
    seenUrls.length = 0;
    updater.setHealReport('FIXED! DROP TABLE');
    await updater.fetchManifest();
    const badUrl = seenUrls[seenUrls.length - 1] || '';
    result.cases.F_heal_whitelist = { pass: badUrl === '/release.json', url: badUrl };

    result.pass = Object.values(result.cases).every(c => c.pass);
  } catch (e) {
    result.fatal = e.message;
  } finally {
    server.close();
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ pass: result.pass, cases: result.cases, fatal: result.fatal || null }));
    process.exit(result.pass ? 0 : 1);
  }
})();
