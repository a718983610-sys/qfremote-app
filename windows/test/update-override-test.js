'use strict';
/*
 * QF-12（3.0.0 低组）自检：QFREMOTE_RELEASE_URL 环境变量覆盖只许指向
 * 本机回环地址（测试假清单服务器用），非回环地址一律忽略、回落正式
 * origin。update.js 在 require 时读一次环境变量定死 RELEASE_URL /
 * TRUSTED_ORIGIN，同一进程内改不了——每种取值单独起一个 node 子进程
 * 探针验证。结果写 JSON 到 QFTEST_OUT，退出码 0=通过。
 * 运行：node test/update-override-test.js
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const OUT = process.env.QFTEST_OUT || '/tmp/qfr103/update-override-result.json';
const UPDATE_JS = path.resolve(__dirname, '..', 'update.js');
const PROD = 'https://app.qfremote.top/release.json';
const PROD_ORIGIN = 'https://app.qfremote.top';

const result = { cases: {}, pass: false };

function probe(overrideUrl) {
  const env = Object.assign({}, process.env);
  if (overrideUrl === null) delete env.QFREMOTE_RELEASE_URL;
  else env.QFREMOTE_RELEASE_URL = overrideUrl;
  const r = spawnSync(process.execPath, ['-e',
    'const u=require(' + JSON.stringify(UPDATE_JS) + ');' +
    'console.log(JSON.stringify({releaseUrl:u.RELEASE_URL,trustedOrigin:u.TRUSTED_ORIGIN}));',
  ], { env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error('探针子进程失败：' + (r.stderr || r.stdout));
  return JSON.parse(r.stdout.trim());
}

try {
  const noOverride = probe(null);
  result.cases.noOverride = { got: noOverride, pass: noOverride.releaseUrl === PROD && noOverride.trustedOrigin === PROD_ORIGIN };

  const loopback = probe('http://127.0.0.1:8977/release.json');
  result.cases.loopback127 = { got: loopback, pass: loopback.releaseUrl === 'http://127.0.0.1:8977/release.json' && loopback.trustedOrigin === 'http://127.0.0.1:8977' };

  const localhost = probe('http://localhost:8977/release.json');
  result.cases.loopbackLocalhost = { got: localhost, pass: localhost.releaseUrl === 'http://localhost:8977/release.json' && localhost.trustedOrigin === 'http://localhost:8977' };

  const localhostDot = probe('http://localhost.:8977/release.json');
  result.cases.loopbackLocalhostDot = { got: localhostDot, pass: localhostDot.releaseUrl === 'http://localhost.:8977/release.json' && localhostDot.trustedOrigin === 'http://localhost.:8977' };

  const v6 = probe('http://[::1]:8977/release.json');
  result.cases.loopbackV6 = { got: v6, pass: v6.releaseUrl === 'http://[::1]:8977/release.json' && v6.trustedOrigin === 'http://[::1]:8977' };

  const evil = probe('https://evil.example/release.json');
  result.cases.remoteIgnored = { got: evil, pass: evil.releaseUrl === PROD && evil.trustedOrigin === PROD_ORIGIN };

  const lan = probe('http://192.168.1.5:8977/release.json');
  result.cases.lanIgnored = { got: lan, pass: lan.releaseUrl === PROD && lan.trustedOrigin === PROD_ORIGIN };

  const suffix = probe('https://app.qfremote.top.evil.example/release.json');
  result.cases.suffixTrickIgnored = { got: suffix, pass: suffix.releaseUrl === PROD && suffix.trustedOrigin === PROD_ORIGIN };

  result.pass = Object.values(result.cases).every(c => c.pass);
} catch (e) {
  result.fatal = e.message;
} finally {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ pass: result.pass, cases: result.cases, fatal: result.fatal || null }));
  process.exit(result.pass ? 0 : 1);
}
