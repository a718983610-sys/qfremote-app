'use strict';
// test-policy 单测（A16-S2 TEST 隔离）。纯 Node，不 require electron。
// 由 windows/test/run-all.js 自动发现（每文件单独子进程，exit 0 为通过）。
const assert = require('node:assert');
const tp = require('../test-policy');

let passed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('PASS ' + name); }
  catch (e) { console.error('FAIL ' + name + ': ' + (e && e.message || String(e))); process.exitCode = 1; }
}
const CLIENT_SHA = 'aa'.repeat(32);
const fakeFs = {
  existsSync: () => true,
  realpathSync: (p) => p,
  sha256File: () => CLIENT_SHA
};

// 1. 仓内默认值是生产（build-flavor.js 未被改写）。
t('production-defaults', () => {
  assert.strictEqual(tp.buildFlavor(), 'production');
  assert.strictEqual(tp.isTestBuild(), false);
  assert.strictEqual(tp.consolePartition(), 'persist:qfremote');
  assert.strictEqual(tp.bootLogFileName(), 'qfremote-boot.log');
  assert.strictEqual(tp.appUserModelId(), 'com.qfremote.desktop');
  assert.strictEqual(tp.testDenied('x').ok, false);
  assert.strictEqual(tp.testDenied('x').reason, 'test-mode-denied');
});

// 2. TEST 身份常量（与 A+ TEST 二进制一致）。
t('test-constants', () => {
  assert.strictEqual(tp.testExePath(), 'C:\\QFRLEA-TEST\\QFRemote.exe');
  assert.strictEqual(tp.testClientExePath(), 'C:\\QFRLEA-TEST\\LEA\\qf-lea-client.exe');
  assert.strictEqual(tp.testServiceName(), 'QFRLEA-TEST');
  assert.strictEqual(tp.testPipeName(), '\\\\.\\pipe\\QFR\\LEA-TEST\\v1');
  assert.strictEqual(tp.testDataLeaf(), 'LEA-TEST');
  assert.strictEqual(tp.testRegKey(), 'HKLM\\SOFTWARE\\QFR\\LEA-TEST');
  assert.strictEqual(tp.TEST_PARTITION, 'persist:qfremote-test');
});

// 3. validateTestEnvironment：全绿。
t('validate-ok', () => {
  const r = tp.validateTestEnvironment('C:\\QFRLEA-TEST\\QFRemote.exe',
    Object.assign({}, fakeFs, { expectedClientSha: CLIENT_SHA }));
  assert.strictEqual(r.ok, true, JSON.stringify(r.failures));
  assert.deepStrictEqual(r.failures, []);
});

// 4. 运行文件不是 TEST 主程序 → 拒绝。
t('validate-wrong-exe', () => {
  const r = tp.validateTestEnvironment('C:\\Users\\Administrator\\AppData\\Local\\Programs\\QFRemote\\QFRemote.exe',
    Object.assign({}, fakeFs, { expectedClientSha: CLIENT_SHA }));
  assert.strictEqual(r.ok, false);
  assert.ok(r.failures.some((f) => f.startsWith('test-exe-path-mismatch')), JSON.stringify(r.failures));
});

// 5. 重解析点（realpath 与期望不一致）→ 拒绝。
t('validate-reparse', () => {
  const fns = Object.assign({}, fakeFs, {
    expectedClientSha: CLIENT_SHA,
    realpathSync: (p) => (p === 'C:\\QFRLEA-TEST\\QFRemote.exe' ? 'C:\\QFRLEA-TEST\\link-target\\QFRemote.exe' : p)
  });
  const r = tp.validateTestEnvironment('C:\\QFRLEA-TEST\\QFRemote.exe', fns);
  assert.strictEqual(r.ok, false);
  assert.ok(r.failures.some((f) => f.startsWith('test-exe-reparse')), JSON.stringify(r.failures));
});

// 6. TEST 客户端缺失 → 拒绝。
t('validate-client-missing', () => {
  const fns = Object.assign({}, fakeFs, {
    expectedClientSha: CLIENT_SHA,
    existsSync: (p) => p !== 'C:\\QFRLEA-TEST\\LEA\\qf-lea-client.exe'
  });
  const r = tp.validateTestEnvironment('C:\\QFRLEA-TEST\\QFRemote.exe', fns);
  assert.strictEqual(r.ok, false);
  assert.ok(r.failures.some((f) => f.startsWith('test-client-missing')), JSON.stringify(r.failures));
});

// 7. TEST 客户端 SHA 不符 → 拒绝。
t('validate-client-sha-mismatch', () => {
  const fns = Object.assign({}, fakeFs, {
    expectedClientSha: CLIENT_SHA,
    sha256File: () => 'bb'.repeat(32)
  });
  const r = tp.validateTestEnvironment('C:\\QFRLEA-TEST\\QFRemote.exe', fns);
  assert.strictEqual(r.ok, false);
  assert.ok(r.failures.some((f) => f.startsWith('test-client-sha-mismatch')), JSON.stringify(r.failures));
});

// 8. 未配置期望 SHA → 拒绝（不静默放行）。
t('validate-client-sha-unconfigured', () => {
  const fns = Object.assign({}, fakeFs, { expectedClientSha: '' });
  const r = tp.validateTestEnvironment('C:\\QFRLEA-TEST\\QFRemote.exe', fns);
  assert.strictEqual(r.ok, false);
  assert.ok(r.failures.some((f) => f.startsWith('test-client-sha-unconfigured')), JSON.stringify(r.failures));
});

// 9. testClientShaOk：一致 true、不一致 false。
t('test-client-sha-ok', () => {
  assert.strictEqual(tp.testClientShaOk({ sha256File: () => CLIENT_SHA, expectedClientSha: CLIENT_SHA }), true);
  assert.strictEqual(tp.testClientShaOk({ sha256File: () => 'cc'.repeat(32), expectedClientSha: CLIENT_SHA }), false);
  assert.strictEqual(tp.testClientShaOk({ sha256File: () => CLIENT_SHA, expectedClientSha: '' }), false);
});

console.log('test-policy-test: ' + passed + ' PASS');
