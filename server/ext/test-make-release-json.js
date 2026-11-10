'use strict';
// make-release-json.js 回归自检（3.0.0 低组 QF-15/QF-16，M-D 的 QF-14
// 口径一并覆盖）：生成器用子进程调 CLI，断言退出码与报错文案。
//   QF-16：流式 sha256（1MB 分块）与整文件一次哈希结果一致；
//   QF-15：--check 补 interop.minVersion——漂移／缺字段／缺段即失败，
//     --allow-min-usable 不豁免（与 QF-14 跨字段不一致同口径）；
//   回归：minUsable 有意不抬＋--allow-min-usable 仍通过；
//     android.minUsable 漂移仍失败（QF-14）。
// 运行：node server/ext/test-make-release-json.js（无外部依赖，退出码 0=通过）。
const { spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const GEN = path.resolve(__dirname, 'make-release-json.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qf-mrj-'));
const exe = path.join(dir, 'QFRemote-Setup-v3.0.0.exe');
const apk = path.join(dir, 'QFRemote-v3.0.0.apk');
fs.writeFileSync(exe, crypto.randomBytes(5 * 1024 * 1024 + 123));
fs.writeFileSync(apk, crypto.randomBytes(3 * 1024 * 1024 + 45));

let passed = 0, failed = 0;
function t(name, cond, extra) {
  if (cond) { passed++; console.log('ok  -', name); }
  else { failed++; console.log('FAIL-', name, extra || ''); }
}
function run(args) {
  return spawnSync(process.execPath, [GEN].concat(args), { encoding: 'utf8' });
}
function genDoc() {
  const docPath = path.join(dir, 'release.json');
  const r = run(['--exe', exe, '--apk', apk, '--version', '3.0.0', '--min-usable', '3.0.0', '--out', docPath]);
  if (r.status !== 0) throw new Error('生成失败：' + r.stderr);
  return { docPath, doc: JSON.parse(fs.readFileSync(docPath, 'utf8')) };
}
function check(docPath, extraArgs) {
  return run(['--check', docPath, exe, apk].concat(extraArgs || []));
}
let docSeq = 0;
function mutatedDoc(mutate) {
  const { docPath, doc } = genDoc();
  mutate(doc);
  // 每例独立文件：共用同一路径会被后一例覆盖（实测踩过）。
  const p = path.join(dir, 'release-' + (docSeq++) + '.json');
  fs.writeFileSync(p, JSON.stringify(doc, null, 2) + '\n');
  return p;
}

try {
  // 基线：生成＋自校验通过；--check 通过。
  const base = genDoc();
  t('QF-16：生成自校验通过（流式 sha256）', true);
  t('QF-15：基线 --check 通过', check(base.docPath).status === 0);
  // QF-16：流式哈希与整文件一次哈希一致（5MB+123B 随机文件）。
  const oneShot = crypto.createHash('sha256').update(fs.readFileSync(exe)).digest('hex');
  t('QF-16：流式 sha256 与整文件哈希一致', base.doc.sha256 === oneShot, 'doc=' + base.doc.sha256 + ' oneShot=' + oneShot);

  // QF-15：interop.minVersion 漂移即失败，报错点名 interop。
  const drift = mutatedDoc((d) => { d.interop.minVersion = '2.4.4'; });
  const rDrift = check(drift);
  t('QF-15：interop.minVersion 漂移即失败', rDrift.status === 1 && rDrift.stderr.includes('interop minVersion'), rDrift.stderr);

  // QF-15：interop.minVersion 缺失即失败（字段未填）。
  const noField = mutatedDoc((d) => { delete d.interop.minVersion; });
  const rNoField = check(noField);
  t('QF-15：interop minVersion 缺失即失败', rNoField.status === 1 && rNoField.stderr.includes('interop minVersion 缺失'), rNoField.stderr);

  // QF-15：interop 段缺失即失败。
  const noSeg = mutatedDoc((d) => { delete d.interop; });
  const rNoSeg = check(noSeg);
  t('QF-15：缺少 interop 段即失败', rNoSeg.status === 1 && rNoSeg.stderr.includes('缺少 interop 段'), rNoSeg.stderr);

  // QF-15：--allow-min-usable 不豁免 interop 漂移（不是“不抬”的决定）。
  const rDriftAllow = check(drift, ['--allow-min-usable']);
  t('QF-15：interop 漂移＋--allow-min-usable 仍失败', rDriftAllow.status === 1 && rDriftAllow.stderr.includes('interop minVersion'), rDriftAllow.stderr);

  // 回归：minUsable 有意不抬＋--allow-min-usable 仍通过（QF-17 口径）。
  const lowMin = mutatedDoc((d) => { d.minUsable = '2.4.4'; d.android.minUsable = '2.4.4'; });
  const rLowMin = check(lowMin, ['--allow-min-usable']);
  t('回归：minUsable 有意不抬＋--allow-min-usable 通过', rLowMin.status === 0, rLowMin.stderr);
  const rLowMinNoFlag = check(lowMin);
  t('回归：minUsable 有意不抬、不传标志仍失败', rLowMinNoFlag.status === 1, rLowMinNoFlag.stderr);

  // 回归：android.minUsable 漂移仍失败（QF-14）。
  const aDrift = mutatedDoc((d) => { d.android.minUsable = '2.4.4'; });
  const rADrift = check(aDrift);
  t('回归：android.minUsable 漂移即失败（QF-14）', rADrift.status === 1 && rADrift.stderr.includes('android minUsable'), rADrift.stderr);
} catch (e) {
  failed++;
  console.log('FAIL- 异常：' + e.message);
} finally {
  console.log(JSON.stringify({ pass: failed === 0, passed, failed }));
  process.exit(failed === 0 ? 0 : 1);
}
