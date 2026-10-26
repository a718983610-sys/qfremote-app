'use strict';
/*
 * 聊天设备静默解锁（L 线合入，总线收口补测）：
 *  A. planChatDevice 决策矩阵：manual-logout / no-token / enroll /
 *     already-enrolled / no-device-copy / device-unlock / not-locked。
 *  B. device-key store：ensure 生成->落盘无明文->往返一致；
 *     加密不可用时 ensure 返回 null 且不落盘。
 * 结果写 JSON 到 QFTEST_OUT，退出码 0=通过。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const autologin = require('../autologin');
const { createDeviceKeyStore } = require('../device-key');

const OUT = process.env.QFTEST_OUT || '/tmp/qfr230/device-unlock-result.json';
const result = { cases: {}, pass: false };
const ok = (name, cond, extra) => { result.cases[name] = Object.assign({ pass: !!cond }, extra || {}); };

function fakeSafeStorage(available) {
  const enc = (s) => Buffer.from('FAKE1:' + Buffer.from(s, 'utf8').toString('base64').split('').reverse().join(''), 'utf8');
  const dec = (b) => {
    const s = b.toString('utf8');
    if (!s.startsWith('FAKE1:')) throw new Error('bad cipher');
    return Buffer.from(s.slice(6).split('').reverse().join(''), 'base64').toString('utf8');
  };
  return { isEncryptionAvailable: () => available, encryptString: enc, decryptString: dec };
}

(function main() {
  const P = autologin.planChatDevice;
  ok('A1 manual-logout', P({ manualLogout: true, hasToken: true, locked: true, hasShellDeviceCopy: true }).action === 'none');
  ok('A2 no-token', P({ hasToken: false, locked: true, hasShellDeviceCopy: true }).reason === 'no-chat-session');
  ok('A3 enroll', P({ hasToken: true, unlocked: true, hasShellDeviceCopy: false }).action === 'device-enroll');
  ok('A4 already-enrolled', P({ hasToken: true, unlocked: true, hasShellDeviceCopy: true }).reason === 'already-enrolled');
  ok('A5 no-device-copy', P({ hasToken: true, locked: true, hasShellDeviceCopy: false }).reason === 'no-device-copy');
  ok('A6 device-unlock', P({ hasToken: true, locked: true, hasShellDeviceCopy: true }).action === 'device-unlock');
  ok('A7 not-locked', P({ hasToken: true, locked: false, unlocked: false }).reason === 'not-locked');
  const s1 = autologin.buildChatDeviceUnlockScript('a2V5');
  const s2 = autologin.buildChatDeviceEnrollScript('a2V5');
  ok('A8 scripts embed key + hook names', s1.includes('qfShellDeviceUnlock') && s1.includes('a2V5') && s2.includes('qfShellDeviceEnroll'));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qfdevkey-'));
  const file = path.join(dir, 'qf-device-key.json');
  const store = createDeviceKeyStore({ file, safeStorage: fakeSafeStorage(true) });
  const k1 = store.ensure();
  ok('B1 ensure returns base64 key', typeof k1 === 'string' && k1.length >= 40, { len: k1 && k1.length });
  const raw = fs.readFileSync(file, 'utf8');
  ok('B2 disk has no plaintext key', !raw.includes(k1));
  const store2 = createDeviceKeyStore({ file, safeStorage: fakeSafeStorage(true) });
  ok('B3 roundtrip same key', store2.ensure() === k1);
  const file2 = path.join(dir, 'qf-device-key2.json');
  const storeNo = createDeviceKeyStore({ file: file2, safeStorage: fakeSafeStorage(false) });
  ok('B4 no-encryption refuses', storeNo.ensure() === null && !fs.existsSync(file2));

  result.pass = Object.values(result.cases).every((c) => c.pass);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.pass ? 0 : 1);
})();
