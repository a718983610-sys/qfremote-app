'use strict';
/*
 * 更新自测用假清单服务器（仅本机回环，测试专用，勿部署）：
 *   GET /release.json -> { version: '9.9.9', notes, url: '/payload.exe', sha256, size }
 *   GET /payload.exe  -> FAKE_PAYLOAD 指向的真安装包（让强更页走真下载+真核对）
 * 环境变量：FAKE_PAYLOAD、FAKE_SIGN_KEY（仅测试 Ed25519 PEM，必填）、
 * FAKE_PORT（默认 18080）、FAKE_VERSION（默认 9.9.9）。
 * 客户端同时配置回环 QFREMOTE_RELEASE_URL 与测试公钥覆盖；绝不跳过验签。
 */
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');

const payloadPath = process.env.FAKE_PAYLOAD;
if (!payloadPath) { console.error('FAKE_PAYLOAD required'); process.exit(2); }
const port = parseInt(process.env.FAKE_PORT || '18080', 10);
const version = process.env.FAKE_VERSION || '9.9.9';
const buf = fs.readFileSync(payloadPath);
const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
const keyPath = process.env.FAKE_SIGN_KEY;
if (!keyPath) { console.error('FAKE_SIGN_KEY required (test-only Ed25519 PEM)'); process.exit(2); }
const privateKey = crypto.createPrivateKey(fs.readFileSync(keyPath));
if (privateKey.asymmetricKeyType !== 'ed25519') { console.error('FAKE_SIGN_KEY must be Ed25519'); process.exit(2); }
const doc = {
  version,
  notes: '自测假版本（9.9.9）：验证强制更新页、下载进度与 SHA256 核对。',
  url: '/payload.exe',
  sha256,
  size: buf.length
};
// Reuse canonicalization, never import a production private key.
const { canonicalReleaseJson } = require('../update');
doc.signature = { alg: 'ed25519', key_id: process.env.FAKE_KEY_ID || 'release-1',
  sig: crypto.sign(null, Buffer.from(canonicalReleaseJson(doc)), privateKey).toString('base64url') };
const manifest = JSON.stringify(doc);

http.createServer((req, res) => {
  if (req.url === '/release.json') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(manifest);
  } else if (req.url === '/payload.exe') {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': buf.length });
    res.end(buf);
  } else {
    res.writeHead(404); res.end('not found');
  }
}).listen(port, '127.0.0.1', () => console.log('fake-release on 127.0.0.1:' + port + ' version=' + version + ' sha256=' + sha256 + ' size=' + buf.length));
