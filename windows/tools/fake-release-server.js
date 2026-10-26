'use strict';
/*
 * 更新自测用假清单服务器（仅本机回环，测试专用，勿部署）：
 *   GET /release.json -> { version: '9.9.9', notes, url: '/payload.exe', sha256, size }
 *   GET /payload.exe  -> FAKE_PAYLOAD 指向的真安装包（让强更页走真下载+真核对）
 * 环境变量：FAKE_PAYLOAD（安装包路径）、FAKE_PORT（默认 18080）、FAKE_VERSION（默认 9.9.9）
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
const manifest = JSON.stringify({
  version,
  notes: '自测假版本（9.9.9）：验证强制更新页、下载进度与 SHA256 核对。',
  url: '/payload.exe',
  sha256,
  size: buf.length
});

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
