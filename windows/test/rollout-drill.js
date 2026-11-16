'use strict';
/*
 * S-104：发版前灰度 channel 演练脚本（自动部分，6/9 项）。
 * 起本地 HTTP 服务发演练清单＋演练安装包，验证 windows/update.js 在
 * 灰度场景下的行为；不需真服务器、不碰正式密钥（每次现签临时密钥）。
 *
 * 自动覆盖：1 正常版、2 错 hash、3 错签名、4 低于 minUsable、5 新 signing
 * key（旧公钥验不过）、6 下载中断、9 回滚（不降级）。
 * 手动覆盖（脚本只登记、不判定）：7 磁盘满、8 安装失败——做法见
 * docs/release/staged-rollout-checklist.md，须发版窗口在演练机上实做。
 * 场景 5 后半（密钥轮换后新 key 放行）同样手动：须先更新客户端期望公钥
 * 再演，不在本脚本里换公钥。
 *
 * 结果写 JSON 到 QFTEST_OUT（默认 /tmp/qfr104/rollout-drill-result.json），
 * 退出码 0=自动项全过。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const OUT = process.env.QFTEST_OUT || '/tmp/qfr104/rollout-drill-result.json';
const result = { scenarios: {}, pass: false };

const payload = crypto.randomBytes(512 * 1024 + 123);
const payloadSha = crypto.createHash('sha256').update(payload).digest('hex');

const keyA = crypto.generateKeyPairSync('ed25519'); // 演练“当前”密钥
const keyB = crypto.generateKeyPairSync('ed25519'); // 演练“新”密钥（客户端不认）
let updater;
let ORIGIN = '';
let serveMode = 'signed'; // signed / unsigned / bad-sig / other-key
let manifest = {
  version: '9.9.9',
  notes: '灰度演练',
  url: '',
  sha256: payloadSha,
  size: payload.length
};

function signManifest(m, kp, keyId) {
  const d = Object.assign({}, m);
  const sig = crypto.sign(null, Buffer.from(updater.canonicalReleaseJson(d), 'utf8'), kp.privateKey);
  d.signature = { alg: 'ed25519', key_id: keyId || 'test', sig: sig.toString('base64url') };
  return d;
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/release.json')) {
    const send = () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (serveMode === 'unsigned') { res.end(JSON.stringify(manifest)); return; }
      if (serveMode === 'bad-sig') {
        const d = signManifest(manifest, keyA);
        d.signature = { alg: 'ed25519', key_id: 'test', sig: Buffer.alloc(64).toString('base64url') };
        res.end(JSON.stringify(d)); return;
      }
      if (serveMode === 'other-key') { res.end(JSON.stringify(signManifest(manifest, keyB))); return; }
      res.end(JSON.stringify(signManifest(manifest, keyA)));
    };
    send();
  } else if (req.url === '/QFRemote-Setup-v9.9.9.exe') {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': payload.length });
    res.end(payload);
  } else if (req.url === '/cut.exe') {
    // 下载中断：发一半就断 socket
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': payload.length });
    res.write(payload.subarray(0, Math.floor(payload.length / 2)));
    res.socket.destroy();
  } else { res.writeHead(404); res.end(); }
});

(async () => {
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
  } catch (e) {
    result.fatal = '演练服务器监听失败: ' + e.message;
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
    process.exit(1);
  }
  ORIGIN = 'http://127.0.0.1:' + server.address().port;
  process.env.QFREMOTE_RELEASE_URL = ORIGIN + '/release.json';
  process.env.QFREMOTE_RELEASE_SIGN_PUBLIC_KEY = keyA.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  process.env.QFREMOTE_RELEASE_SIGN_KEY_ID = 'test';
  updater = require('../update');
  manifest.url = ORIGIN + '/QFRemote-Setup-v9.9.9.exe';

  const destDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qfr-drill-'));
  try {
    // 1. 正常版
    serveMode = 'signed';
    manifest = Object.assign({}, manifest, { version: '9.9.9', url: ORIGIN + '/QFRemote-Setup-v9.9.9.exe', sha256: payloadSha, size: payload.length });
    delete manifest.minUsable;
    const c1 = await updater.checkForUpdate('1.0.3');
    const d1 = await updater.downloadUpdate(c1.manifest, destDir, () => {});
    const sha1 = await updater.sha256File(d1.file);
    result.scenarios['1_normal'] = { available: c1.available, shaOk: sha1 === payloadSha, pass: c1.available === true && sha1 === payloadSha && d1.size === payload.length };

    // 2. 错 hash
    manifest = Object.assign({}, manifest, { sha256: '0'.repeat(64) });
    let e2 = null;
    try { await updater.downloadUpdate(manifest, destDir, () => {}); } catch (e) { e2 = e.message; }
    result.scenarios['2_bad_hash'] = { error: e2, partLeft: fs.existsSync(path.join(destDir, 'QFRemote-Setup-v9.9.9.exe.part')), pass: !!e2 && e2.includes('SHA256') && !fs.existsSync(path.join(destDir, 'QFRemote-Setup-v9.9.9.exe.part')) };

    // 3. 错签名
    manifest = Object.assign({}, manifest, { sha256: payloadSha });
    serveMode = 'bad-sig';
    let e3 = null;
    try { await updater.fetchManifest(); } catch (e) { e3 = e.message; }
    serveMode = 'signed';
    result.scenarios['3_bad_signature'] = { error: e3, pass: !!e3 && e3.includes('签名') };

    // 4. 低于 minUsable：本机 1.0.3 < 强更线 9.9.9，必须强更
    manifest = Object.assign({}, manifest, { version: '9.9.9', minUsable: '9.9.9' });
    const m4 = await updater.fetchManifest();
    const force = m4.minUsable && updater.compareVersions('1.0.3', m4.minUsable) < 0;
    result.scenarios['4_below_minUsable'] = { minUsable: m4.minUsable, forceUpdate: force, pass: m4.minUsable === '9.9.9' && force === true };

    // 5. 新 signing key：另一把密钥签的清单，旧公钥验不过
    delete manifest.minUsable;
    serveMode = 'other-key';
    let e5 = null;
    try { await updater.fetchManifest(); } catch (e) { e5 = e.message; }
    serveMode = 'signed';
    result.scenarios['5_new_signing_key'] = { error: e5, pass: !!e5 && e5.includes('签名') };

    // 6. 下载中断：下到一半断开
    manifest = Object.assign({}, manifest, { url: ORIGIN + '/cut.exe', sha256: payloadSha, size: payload.length });
    let e6 = null;
    try { await updater.downloadUpdate(manifest, destDir, () => {}); } catch (e) { e6 = e.message; }
    result.scenarios['6_download_interrupted'] = { error: e6, partLeft: fs.existsSync(path.join(destDir, 'cut.exe.part')), pass: !!e6 && !fs.existsSync(path.join(destDir, 'cut.exe.part')) };

    // 9. 回滚：清单版本低于已装版本，不降级
    manifest = Object.assign({}, manifest, { version: '9.9.8', url: ORIGIN + '/QFRemote-Setup-v9.9.9.exe', sha256: payloadSha });
    const c9 = await updater.checkForUpdate('9.9.9');
    result.scenarios['9_rollback_no_downgrade'] = { available: c9.available, pass: c9.available === false };

    // 7/8 手动项：只登记
    result.scenarios['7_disk_full'] = { status: 'MANUAL', note: '须发版窗口在演练机上实做，见 staged-rollout-checklist.md' };
    result.scenarios['8_install_failure'] = { status: 'MANUAL', note: '须发版窗口在演练机上实做，见 staged-rollout-checklist.md' };

    result.pass = Object.values(result.scenarios)
      .filter((s) => s.status !== 'MANUAL')
      .every((s) => s.pass);
  } catch (e) {
    result.fatal = e.message;
  } finally {
    server.close();
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.pass ? 0 : 1);
  }
})();
