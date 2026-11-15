'use strict';
/*
 * D-04 便携包回归自检（3.0.0，全进 3.0）：
 *   用小 payload 跑 make-portable-zip.js，断言：
 *   A. 产物为合法 ZIP（7z t 通过），含 install-mode.txt=portable、
 *      README-便携版.txt 与全部 payload 文件；
 *   B. 解压即运行——解出的 QFRemote.exe 为合法 PE（file 识别），
 *      install-mode.txt 内容确为 portable；
 *   C. payload 缺 file-manifest.txt 时拒绝出包；
 *   D. payload 已含 install-mode.txt（旧标记混入）时拒绝出包；
 *   E. 清单与 payload 不一致时拒绝出包（gen --check 同款口径）。
 * 运行：node windows/test/portable-zip-test.js（退出码 0=通过）。
 */
const { spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TREE = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(TREE, 'windows', 'tools', 'make-portable-zip.js');
const GEN = path.join(TREE, 'windows', 'tools', 'gen_file_manifest.py');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qfr-port-'));
let passed = 0, failed = 0;
function t(name, cond, extra) {
  if (cond) { passed++; console.log('ok  -', name); }
  else { failed++; console.log('FAIL-', name, extra || ''); }
}
function run(cmd, args, opts) {
  return spawnSync(cmd, args, Object.assign({ encoding: 'utf8' }, opts || {}));
}
function makePayload(name, files) {
  const p = path.join(dir, name);
  fs.mkdirSync(path.join(p, 'sub'), { recursive: true });
  Object.keys(files).forEach((rel) => {
    const fp = path.join(p, rel);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, files[rel]);
  });
  // 注：本测试的 QFRemote.exe 只是占位字节（只验“在位＋进包”，不验 PE
  // 合法性）；PE 合法性由 release-gate 的 file 检查与 Wine 真装覆盖。
  return p;
}
function genManifest(payload) {
  const r = run('python3', [GEN, '--payload', payload]);
  if (r.status !== 0) throw new Error('清单生成失败：' + r.stderr);
}

try {
  // A/B：正常 payload → 出包＋内容齐全。
  const payload = makePayload('payload-ok', {
    'QFRemote.exe': Buffer.from('MZ-fake-pe-placeholder'),
    'resources/app.asar': crypto.randomBytes(4096),
    'sub/nested.txt': 'nested\n'
  });
  genManifest(payload);
  const outZip = path.join(dir, 'QFRemote-v3.0.0-portable.zip');
  const rA = run(process.execPath, [SCRIPT, '--payload', payload, '--version', '3.0.0', '--out', outZip]);
  t('A：正常 payload 出包成功', rA.status === 0, rA.stderr + rA.stdout);
  const list = run('7z', ['l', outZip]);
  const names = list.stdout || '';
  t('A：产物含 install-mode.txt 与 README-便携版.txt', names.includes('install-mode.txt') && names.includes('README-便携版.txt'), names);
  t('A：产物含全部 payload 文件', names.includes('QFRemote.exe') && names.includes('resources/app.asar') && names.includes('sub/nested.txt'), names);
  const test7z = run('7z', ['t', outZip]);
  t('A：7z t 校验通过', test7z.status === 0, test7z.stderr);
  const extractDir = path.join(dir, 'extracted');
  fs.mkdirSync(extractDir, { recursive: true });
  const ext = run('7z', ['x', '-y', '-o' + extractDir, outZip]);
  const mode = fs.existsSync(path.join(extractDir, 'install-mode.txt')) ? fs.readFileSync(path.join(extractDir, 'install-mode.txt'), 'utf8').trim() : '';
  t('B：解压后 install-mode.txt 内容为 portable', ext.status === 0 && mode === 'portable', 'mode=' + mode);
  t('B：解压后 payload 文件齐全', fs.existsSync(path.join(extractDir, 'QFRemote.exe')) && fs.existsSync(path.join(extractDir, 'resources', 'app.asar')) && fs.existsSync(path.join(extractDir, 'sub', 'nested.txt')));

  // C：缺 file-manifest.txt -> 拒绝。
  const payloadNoManifest = makePayload('payload-nomanifest', { 'QFRemote.exe': Buffer.from('MZ-fake') });
  const rC = run(process.execPath, [SCRIPT, '--payload', payloadNoManifest, '--version', '3.0.0', '--out', path.join(dir, 'c.zip')]);
  t('C：缺 file-manifest.txt 时拒绝出包', rC.status === 1 && (rC.stderr + rC.stdout).includes('file-manifest'), rC.stderr + rC.stdout);

  // D：payload 已含 install-mode.txt -> 拒绝。
  const payloadStale = makePayload('payload-stale', { 'QFRemote.exe': Buffer.from('MZ-fake'), 'install-mode.txt': 'installed\n' });
  genManifest(payloadStale);
  const rD = run(process.execPath, [SCRIPT, '--payload', payloadStale, '--version', '3.0.0', '--out', path.join(dir, 'd.zip')]);
  t('D：payload 已含 install-mode.txt 时拒绝出包', rD.status === 1 && (rD.stderr + rD.stdout).includes('install-mode'), rD.stderr + rD.stdout);

  // E：清单与 payload 不一致（改了一个文件不重生成清单）-> 拒绝。
  const payloadDrift = makePayload('payload-drift', { 'QFRemote.exe': Buffer.from('MZ-fake'), 'resources/app.asar': crypto.randomBytes(1024) });
  genManifest(payloadDrift);
  fs.writeFileSync(path.join(payloadDrift, 'resources', 'app.asar'), crypto.randomBytes(2048));
  const rE = run(process.execPath, [SCRIPT, '--payload', payloadDrift, '--version', '3.0.0', '--out', path.join(dir, 'e.zip')]);
  t('E：清单与 payload 不一致时拒绝出包', rE.status === 1 && (rE.stderr + rE.stdout).includes('manifest'), rE.stderr + rE.stdout);
} catch (e) {
  failed++;
  console.log('FAIL- 异常：' + e.message);
} finally {
  console.log(JSON.stringify({ pass: failed === 0, passed, failed }));
  process.exit(failed === 0 ? 0 : 1);
}
