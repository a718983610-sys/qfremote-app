'use strict';
// pkg3 #1（M-C 中组）：ext 侧 guardCheck 拒绝名单须与 friends 侧 GUARD
// （server/friends/server.js）完全一致——自动执法联动 licLockAccount 时
// 不得误锁 qf-locksvc / qf-support / qf-official 等服务账号。
// 运行前置与 test-presence.js 相同：QFEXT_NO_LISTEN=1（不监听端口）、
// QFEXT_DATA_DIR 指临时目录。
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qfext-guardcheck-'));
process.env.QFEXT_NO_LISTEN = '1';
process.env.QFEXT_DATA_DIR = path.join(tmp, 'data');
process.env.QFEXT_DB_FILE = path.join(tmp, 'no-such.db');
process.env.QFEXT_LEDGER_FILE = path.join(tmp, 'no-ledger.json');

const S = require('./server');
const F = require('../friends/server.js');

let passed = 0, failed = 0;
function t(name, cond) {
  if (cond) { passed++; console.log('ok  -', name); }
  else { failed++; console.log('FAIL-', name); }
}

// 两份名单逐项一致：friends GUARD 里的每一项，ext guardCheck 都须拒绝。
const guardNames = Array.from(F.GUARD);
t('friends GUARD 非空（名单源）', guardNames.length === 9);
for (const n of guardNames) {
  t('guardCheck 拒绝 friends GUARD 成员 ' + n, !!S.guardCheck(null, n));
  t('guardCheck 拒绝大写 ' + n.toUpperCase(), !!S.guardCheck(null, n.toUpperCase()));
}
// 站长本人与全权账号仍挡（既有口径不变）。
t('guardCheck 拒绝站长账号', !!S.guardCheck(null, '718983610'));
t('guardCheck 拒绝全权账号（siteadmin=4294967295）', !!S.guardCheck({ siteadmin: 4294967295 }, 'someone'));
// 普通账号放行；adminGuardCheck（站长人工专用）口径不动，只挡两个真服务账号。
t('guardCheck 放行普通账号', S.guardCheck({ siteadmin: 0 }, 'alice') === null);
t('adminGuardCheck 仍只挡 qf-regsvc/qf-socialsvc', !!S.adminGuardCheck(null, 'qf-regsvc') && !!S.adminGuardCheck(null, 'qf-socialsvc') && S.adminGuardCheck(null, 'qf-locksvc') === null);

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
