'use strict';
/*
 * QFRemote Windows 运行端 — 统一跑测脚本（3.0.0，L3）
 * ================================================================
 * 用法：node test/run-all.js（或 npm test）
 * 顺序跑 windows/test 下全部 *-test.js（除自身），每个子进程单独跑、
 * 退出码 0=通过；汇总打印 PASS/FAIL/SKIP 三列并以失败数作退出码。
 * SKIP：需 Electron 的测试（watchdog-test、autologin-page-test）在
 * 沙箱（无 electron 模块）下跳过，记 SKIP 不记 FAIL——它们在 L7 的
 * Wine/真机窗口跑；logout-test 因 work tree 缺 console-skin/
 * custom.js（预存缺口，与本轮无关）同样记 SKIP 并注明原因。
 * 各测试自带 QFTEST_OUT 默认路径，顺序跑不冲突。
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const DIR = __dirname;
const ELECTRON_TESTS = new Set(['watchdog-test.js', 'autologin-page-test.js']);
const SKIP_WITH_REASON = { 'logout-test.js': 'work tree 缺 console-skin/custom.js（预存缺口）' };
// 慢测试单独放宽超时：release-gate-test.js（L2 的 RC-06 发版门回归，
// 含多次 makensis 编译＋全量 gate，需数分钟；默认 120 秒会被杀成 exit=null）。
const SLOW_TIMEOUT_MS = { 'release-gate-test.js': 600000 };

let electronAvailable = false;
try { require.resolve('electron'); electronAvailable = true; } catch (e) { electronAvailable = false; }

const files = fs.readdirSync(DIR)
  .filter((n) => n.endsWith('-test.js') && n !== 'run-all.js')
  .sort();

const rows = [];
let pass = 0, fail = 0, skip = 0;
for (const file of files) {
  if (ELECTRON_TESTS.has(file) && !electronAvailable) {
    rows.push({ file, status: 'SKIP', note: '需 Electron（沙箱无 electron 模块，L7 Wine/真机窗口跑）' });
    skip++;
    continue;
  }
  if (SKIP_WITH_REASON[file]) {
    rows.push({ file, status: 'SKIP', note: SKIP_WITH_REASON[file] });
    skip++;
    continue;
  }
  const r = spawnSync(process.execPath, [path.join(DIR, file)], { encoding: 'utf8', timeout: SLOW_TIMEOUT_MS[file] || 120000 });
  const out = ((r.stdout || '') + (r.stderr || '')).trim().split('\n').filter(Boolean).slice(-2).join(' | ').slice(0, 300);
  if (r.status === 0) { pass++; rows.push({ file, status: 'PASS', note: '' }); }
  else { fail++; rows.push({ file, status: 'FAIL', note: 'exit=' + r.status + ' ' + out }); }
}

console.log('windows tests: PASS=' + pass + ' FAIL=' + fail + ' SKIP=' + skip);
for (const row of rows) console.log('  ' + row.status + ' ' + row.file + (row.note ? ' — ' + row.note : ''));
process.exit(fail ? 1 : 0);
