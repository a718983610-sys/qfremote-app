'use strict';
/*
 * 凭据保险箱（creds.js）本地自检：
 *  A. 保存->读取往返一致；
 *  B. 落盘文件里找不到账号/密码明文，且格式为约定的 JSON 信封；
 *  C. 清除后读不到、文件不存在；
 *  D. 文件损坏 -> 当没有（返回 null，不抛）；
 *  E. 系统加密不可用 -> 保存被拒（NO_ENCRYPTION）且不落盘；
 *  F. 空账号/空密码被拒。
 * 用可逆假加密器模拟 safeStorage（Electron 本体不需要参与）。
 * 结果写 JSON 到 QFTEST_OUT，退出码 0=通过。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCredStore } = require('../creds');

const OUT = process.env.QFTEST_OUT || '/tmp/qfr230/creds-result.json';
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

(() => {
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qfr-creds-'));
    const file = path.join(dir, 'qf-creds.json');
    const U = 'testuser01';
    const P = 'TestPass2026!x';
    const store = createCredStore({ file, safeStorage: fakeSafeStorage(true) });

    ok('A0_empty_before_save', store.load() === null && store.has() === false);
    store.save(U, P);
    const got = store.load();
    ok('A_roundtrip', !!got && got.username === U && got.password === P, got ? { u: got.username } : null);

    const raw = fs.readFileSync(file, 'utf8');
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch (e) { /* ignore */ }
    ok('B_format', !!parsed && parsed.kind === 'qfremote-creds' && parsed.cipher === 'electron-safeStorage' && typeof parsed.data === 'string' && parsed.data.length > 10);
    ok('B_no_plaintext', !raw.includes(U) && !raw.includes(P) && !raw.includes(Buffer.from(P).toString('base64')));

    store.clear();
    ok('C_cleared', store.load() === null && !fs.existsSync(file));

    fs.writeFileSync(file, '{broken json');
    ok('D_corrupt_is_null', store.load() === null);
    fs.writeFileSync(file, JSON.stringify({ v: 1, kind: 'qfremote-creds', cipher: 'electron-safeStorage', data: 'AAAA' }));
    ok('D_undecryptable_is_null', store.load() === null);

    const file2 = path.join(dir, 'qf-creds2.json');
    const store2 = createCredStore({ file: file2, safeStorage: fakeSafeStorage(false) });
    let code = null;
    try { store2.save(U, P); } catch (e) { code = e.code; }
    ok('E_no_encryption_refused', code === 'NO_ENCRYPTION' && !fs.existsSync(file2), { code });

    let code2 = null;
    try { store.save('', P); } catch (e) { code2 = e.code; }
    let code3 = null;
    try { store.save(U, ''); } catch (e) { code3 = e.code; }
    ok('F_empty_rejected', code2 === 'EMPTY' && code3 === 'EMPTY', { code2, code3 });

    // 覆盖保存：新值替换旧值
    store.save('otheruser9', 'OtherPass999');
    const got2 = store.load();
    ok('G_overwrite', !!got2 && got2.username === 'otheruser9' && got2.password === 'OtherPass999');

    // 补-低（L-C）：clear() 失败须可感知——成功返 true；文件本就
    // 不存在也返 true（幂等，不抛）；真删不掉抛 CLEAR_FAIL 且文件仍在。
    ok('H_clear_returns_true', store.clear() === true && !fs.existsSync(file));
    ok('I_clear_missing_returns_true', store.clear() === true);
    const dirAsFile = path.join(dir, 'as-dir');
    fs.mkdirSync(dirAsFile);
    const storeD = createCredStore({ file: dirAsFile, safeStorage: fakeSafeStorage(true) });
    let jCode = null;
    try { storeD.clear(); } catch (e) { jCode = e.code; }
    ok('J_clear_fail_throws_CLEAR_FAIL', jCode === 'CLEAR_FAIL' && fs.existsSync(dirAsFile), { jCode });

    result.pass = Object.values(result.cases).every(c => c.pass);
  } catch (e) {
    result.fatal = e.message;
  } finally {
    try { fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(result, null, 2)); } catch (e) { /* ignore */ }
    console.log(JSON.stringify({ pass: result.pass, cases: result.cases, fatal: result.fatal || null }));
    process.exit(result.pass ? 0 : 1);
  }
})();
