'use strict';
// 隐私锁信封 JS 侧自测：update 信封的签名布局必须与组件 Go 侧逐字一致。
// 钉死字面量与 Go 测试 TestUpdateSigningBytesLayout 同一份（改一处必改两处）。
const crypto = require('crypto');
const E = require('./lock-envelope');
let pass = 0, fail = 0;
function t(name, cond) { if (cond) { pass++; console.log('ok  -', name); } else { fail++; console.log('FAIL-', name); } }

const SHA = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

// 测试用假 IP（TEST-NET-1 段 203.0.113.0/24，RFC 5737 文档专用，绝非生产地址）：
// 旧生产 IP 已退役，测试里的旧地址一律用它代替；
// 「旧 IP 拒」断言测的是「非域名/IP 直连地址一律拒」，不依赖具体旧 IP 值。
const TEST_OLD_URL = 'https://203.0.113.1:8443';

// 1) signingBytes 字面量（update）
const envFixed = {
  v: 1, id: 'env-fixed', op: 'update', nodeId: 'node//x', by: 'owner@example.com',
  issuedAt: '2026-10-26T00:00:00Z', expiresAt: '2026-10-26T00:30:00Z',
  update: { version: '2.0.3', url: TEST_OLD_URL + '/dl/x.zip', sha256: SHA },
  nonce: 'bm9uY2U=',
};
const want = '{"v":1,"id":"env-fixed","op":"update","nodeId":"node//x","by":"owner@example.com","issuedAt":"2026-10-26T00:00:00Z","expiresAt":"2026-10-26T00:30:00Z","update":{"version":"2.0.3","url":"' + TEST_OLD_URL + '/dl/x.zip","sha256":"' + SHA + '"},"nonce":"bm9uY2U="}';
t('update signingBytes 与 Go 侧逐字一致', E.signingBytes(envFixed) === want);

// 2) 旧 arm 布局不变（无 update 段）
const armFixed = {
  v: 1, id: 'env-fixed', op: 'arm', nodeId: 'node//x', by: 'owner@example.com',
  issuedAt: '2026-10-26T00:00:00Z', expiresAt: '2026-10-26T00:30:00Z', pwEnc: 'AA==', nonce: 'bm9uY2U=',
};
const wantArm = '{"v":1,"id":"env-fixed","op":"arm","nodeId":"node//x","by":"owner@example.com","issuedAt":"2026-10-26T00:00:00Z","expiresAt":"2026-10-26T00:30:00Z","pwEnc":"AA==","nonce":"bm9uY2U="}';
t('arm signingBytes 布局不变', E.signingBytes(armFixed) === wantArm);

// 3) buildEnvelope(update)：组包+签名可验、TTL 30 分钟、字段齐
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const seed = privateKey.export({ format: 'jwk' }).d; // base64url seed
const seedBuf = Buffer.from(seed, 'base64url');
const keyFileContent = Buffer.concat([seedBuf, Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url')]).toString('base64');
const keyObj = E.loadDispatcherKey(keyFileContent);
const now = new Date('2026-10-26T00:00:00Z');
const env = E.buildEnvelope(keyObj, { op: 'update', nodeId: 'node//x', by: 'owner@example.com', update: { version: '2.0.3', url: TEST_OLD_URL + '/QFLock-Component-v2.0.3.zip', sha256: SHA }, now });
t('update 信封字段齐', env.op === 'update' && env.update.version === '2.0.3' && env.update.sha256 === SHA);
t('update 信封 TTL 30 分钟', env.expiresAt === '2026-10-26T00:30:00Z');
const ok = crypto.verify(null, Buffer.from(E.signingBytes(env), 'utf8'), publicKey, Buffer.from(env.sig, 'base64'));
t('update 信封签名可验', ok);
const tampered = Object.assign({}, env, { update: { version: '2.0.3', url: TEST_OLD_URL + '/evil.zip', sha256: SHA } });
const ok2 = crypto.verify(null, Buffer.from(E.signingBytes(tampered), 'utf8'), publicKey, Buffer.from(env.sig, 'base64'));
t('篡改 url 后签名失效', !ok2);

// 4) buildEnvelope(update) 参数不全直接抛错
let threw = false;
try { E.buildEnvelope(keyObj, { op: 'update', nodeId: 'n', by: 'b', update: { version: '2.0.3', url: TEST_OLD_URL + '/x.zip', sha256: 'zz' } }); } catch (e) { threw = true; }
t('sha256 格式不对抛错', threw);

// 5) 版本比较与 URL 白名单
t('compareVersions 2.0.10>2.0.9', E.compareVersions('2.0.10', '2.0.9') === 1);
t('compareVersions 同版本=0', E.compareVersions('2.0.3', '2.0.3') === 0);
t('compareVersions 格式坏=null', E.compareVersions('2.x', '2.0.3') === null);
t('白名单：自家域名根路径', E.allowedUpdateUrl('https://app.qfremote.top/QFLock-Component-v2.0.3.zip') === true);
t('白名单：自家域名 /dl/', E.allowedUpdateUrl('https://app.qfremote.top/dl/x.zip') === true);
t('白名单：显式 443', E.allowedUpdateUrl('https://app.qfremote.top:443/dl/x.zip') === true);
t('白名单：http 拒', E.allowedUpdateUrl('http://app.qfremote.top/x.zip') === false);
t('白名单：旧直连端口拒', E.allowedUpdateUrl('https://app.qfremote.top:8443/x.zip') === false);
t('白名单：旧 IP 拒', E.allowedUpdateUrl(TEST_OLD_URL + '/dl/x.zip') === false);
t('白名单：外站拒', E.allowedUpdateUrl('https://evil.example.com/x.zip') === false);
t('白名单：userinfo 拒', E.allowedUpdateUrl('https://u@app.qfremote.top/x.zip') === false);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
