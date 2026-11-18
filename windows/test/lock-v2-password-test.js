'use strict';
/*
 * 隐私锁 v2 一次性密码保管测试（B 线，沙箱实跑）：
 *  A. 验对通过且一次性作废（不可复用）；
 *  B. 错 5 次撤销；C. 过期撤销；D. 状态只暴露元数据，无盐/哈希外泄。
 * 结果写 JSON 到 QFTEST_OUT，退出码 0=通过。
 */
const fs = require('fs');
const path = require('path');
const { OneTimePasswordVault } = require('../lock-v2/password-vault');

const OUT = process.env.QFTEST_OUT || '/tmp/qfr200/lock-v2-password-result.json';
const result = { cases: {}, pass: false };
const ok = (name, cond, extra) => { result.cases[name] = Object.assign({ pass: !!cond }, extra || {}); };

(async () => {
  const v = new OneTimePasswordVault({ ttlMs: 60000, maxAttempts: 5 });
  ok('A0_empty', v.verify('x').code === 'NO_PASSWORD');
  let bad = false;
  try { v.set('abc'); } catch (e) { bad = e.code === 'BAD_PASSWORD'; }
  ok('A1_short_rejected', bad);
  v.set('pass1234');
  const st = v.status();
  ok('A2_status_no_secrets', st.set === true && !('hash' in st) && !('salt' in st) && !('password' in st));
  ok('A3_wrong_counts', v.verify('nope').code === 'WRONG_PASSWORD' && v.status().attempts === 1);
  const good = v.verify('pass1234');
  ok('A4_verify_ok', good.ok === true);
  ok('A5_one_time', v.verify('pass1234').code === 'REVOKED');

  const v2 = new OneTimePasswordVault({ ttlMs: 60000, maxAttempts: 5 });
  v2.set('pass1234');
  let last = null;
  for (let i = 0; i < 5; i++) last = v2.verify('wrong');
  ok('B1_five_wrong_revokes', last.code === 'REVOKED' && v2.status().revoked === true);

  const v3 = new OneTimePasswordVault({ ttlMs: 1, maxAttempts: 5 });
  v3.set('pass1234');
  await new Promise((r) => setTimeout(r, 10));
  ok('C1_expired', v3.verify('pass1234').code === 'EXPIRED');

  result.pass = Object.values(result.cases).every((c) => c.pass);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  console.log('lock-v2-password: ' + (result.pass ? 'PASS' : 'FAIL') + ' ' + Object.keys(result.cases).length + ' cases');
  process.exit(result.pass ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
