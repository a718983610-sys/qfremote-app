'use strict';
/*
 * 2.0.1 更新链专项自检（在 update-test.js 通用用例之外，专验本版口径）：
 *  本地 HTTP 假清单服务器发 version=2.0.1 的清单 + 假安装包，验证：
 *  A. 以 2.0.0 检查 -> 有 2.0.1 更新（发布线把清单从 2.0.0 升到 2.0.1 的场景）；
 *  B. 以 2.0.1 检查 -> 无更新；
 *  C. 下载 2.0.1 包：进度回调、SHA256 核对通过、文件落盘；
 *  D. 清单 SHA256 写错 -> 拒绝且坏包自删，报错文案为现行文案；
 *  E. 清单大小写错 -> 拒绝且坏包自删，报错文案为现行文案。
 * 结果写 JSON 到 QFTEST_OUT，退出码 0=通过。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PORT = 8979;
const ORIGIN = 'http://127.0.0.1:' + PORT;
process.env.QFREMOTE_RELEASE_URL = ORIGIN + '/release.json';
// H26：假清单现签——每次服务时用临时 Ed25519 密钥签名（验签公钥经测试覆盖传入）。
const _signKp = crypto.generateKeyPairSync('ed25519');
process.env.QFREMOTE_RELEASE_SIGN_PUBLIC_KEY = _signKp.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
const updater = require('../update');
function signManifest(m) {
  const d = Object.assign({}, m);
  const sig = crypto.sign(null, Buffer.from(updater.canonicalReleaseJson(d), 'utf8'), _signKp.privateKey);
  // D-02：客户端强制核对 key_id（生产值 release-1），假签名须用同一值。
  d.signature = { alg: 'ed25519', key_id: 'release-1', sig: sig.toString('base64url') };
  return d;
}

const OUT = process.env.QFTEST_OUT || '/tmp/qfr201/update-chain-result.json';
const result = { cases: {}, pass: false };

const payload = crypto.randomBytes(1024 * 1024 + 777);
const payloadSha = crypto.createHash('sha256').update(payload).digest('hex');
let manifest = {
  version: '2.0.1',
  notes: 'QFRemote 2.0.1',
  url: ORIGIN + '/QFRemote-Setup-v2.0.1.exe',
  sha256: payloadSha,
  size: payload.length
};

const server = http.createServer((req, res) => {
  if (req.url === '/release.json') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(signManifest(manifest)));
  } else if (req.url === '/QFRemote-Setup-v2.0.1.exe') {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': payload.length });
    res.end(payload);
  } else { res.writeHead(404); res.end(); }
});

(async () => {
  await new Promise(r => server.listen(PORT, '127.0.0.1', r));
  const destDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qfr-chain-'));
  try {
    const a = await updater.checkForUpdate('2.0.0');
    result.cases.A_from_200_available = { pass: a.available === true && a.manifest.version === '2.0.1', available: a.available, version: a.manifest && a.manifest.version };

    const b = await updater.checkForUpdate('2.0.1');
    result.cases.B_at_201_none = { pass: b.available === false, available: b.available };

    let progressHits = 0;
    const dl = await updater.downloadUpdate(a.manifest, destDir, () => { progressHits++; });
    const landed = fs.existsSync(dl.file) && fs.statSync(dl.file).size === payload.length && dl.sha256 === payloadSha;
    result.cases.C_download_verify = { pass: landed && progressHits > 0, file: path.basename(dl.file), progressHits };

    manifest = Object.assign({}, manifest, { sha256: '0'.repeat(64) });
    const badManifest = await updater.fetchManifest();
    let dErr = '';
    try { await updater.downloadUpdate(badManifest, destDir, () => {}); } catch (e) { dErr = e.message; }
    const dGone = !fs.existsSync(path.join(destDir, 'QFRemote-Setup-v2.0.1.exe.part'));
    result.cases.D_bad_sha_rejected = {
      pass: dErr === '完整性核对未通过（SHA256 校验码不一致），已删除该文件，请重新下载。' && dGone,
      error: dErr, partGone: dGone
    };

    manifest = Object.assign({}, manifest, { sha256: payloadSha, size: payload.length + 5 });
    const sizeManifest = await updater.fetchManifest();
    let eErr = '';
    try { await updater.downloadUpdate(sizeManifest, destDir, () => {}); } catch (e) { eErr = e.message; }
    result.cases.E_bad_size_rejected = {
      pass: eErr === '下载不完整（文件大小与清单不一致），已删除，请重新下载。',
      error: eErr
    };
  } catch (e) {
    result.fatal = e.message;
  } finally {
    server.close();
  }
  result.pass = Object.values(result.cases).every(c => c.pass);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.pass ? 0 : 1);
})();
