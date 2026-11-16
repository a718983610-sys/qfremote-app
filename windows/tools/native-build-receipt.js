#!/usr/bin/env node
'use strict';
// Each native build records exact compiler inputs and outputs after successful compilation.
// Packaging only verifies these receipts; it never regenerates them from stale binaries.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const root = path.resolve(__dirname, '..');
const components = Object.freeze({
  lea: { outputs: ['QFRLEA.exe', 'qf-lea-client.exe'], dirs: ['lea'] },
  ush: { outputs: ['QFUserHelper.exe'], dirs: ['ush', 'lea/ed25519'] },
  syshelper: { outputs: ['QFSysHelper.exe'], dirs: ['syshelper'] }
});
function hash(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function sourceFiles(componentRoot, inputs) {
  const files = [];
  for (const entry of fs.readdirSync(componentRoot, { withFileTypes: true })) {
    const file = path.join(componentRoot, entry.name);
    if (entry.isDirectory()) {
      if (!['test', 'node_modules', 'build', 'dist'].includes(entry.name)) files.push(...sourceFiles(file, inputs));
    } else if (/\.(c|h|sh|py|json)$/.test(entry.name) && entry.name !== 'build-receipt.json') files.push(file);
  }
  return files;
}
function inputsFor(name, base = root) {
  const cfg = components[name];
  if (!cfg) throw new Error('Unknown native component');
  const files = cfg.dirs.flatMap((d) => sourceFiles(path.join(base, d)));
  if (name === 'lea' || name === 'syshelper') files.push(path.join(base, 'qf-agent-heal.ps1'));
  return Object.fromEntries(files.sort().map((f) => [path.relative(base, f).split(path.sep).join('/'), hash(f)]));
}
function outputsFor(name, base = root) {
  return Object.fromEntries(components[name].outputs.map((f) => [f, hash(path.join(base, name, f))]));
}
function checkLeaMarkers(file) {
  const data = fs.readFileSync(file);
  for (const marker of ['QFRLEA_TEST_UNSIGNED_BUILD', 'QFRLEA_NO_PRODUCTION_PUBLIC_KEY']) {
    if (data.includes(Buffer.from(marker))) throw new Error(path.basename(file) + ': ' + marker);
  }
  if (!data.includes(Buffer.from('QFRLEA_PRODUCTION_SIGNED_BUILD'))) throw new Error(path.basename(file) + ': production marker missing');
}
function verify(name, base = root) {
  const file = path.join(base, name, 'build-receipt.json');
  let receipt;
  try { receipt = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw new Error(name + ': fresh native build receipt missing; rebuild before packaging'); }
  if (receipt.schema !== 1 || receipt.component !== name || JSON.stringify(receipt.inputs) !== JSON.stringify(inputsFor(name, base)) || JSON.stringify(receipt.outputs) !== JSON.stringify(outputsFor(name, base))) {
    throw new Error(name + ': native source/output differs from build receipt; rebuild before packaging');
  }
  if (name === 'lea') for (const f of components.lea.outputs) checkLeaMarkers(path.join(base, name, f));
  return true;
}
function record(name, base = root) {
  if (!components[name]) throw new Error('Unknown native component');
  if (name === 'lea') for (const f of components.lea.outputs) checkLeaMarkers(path.join(base, name, f));
  const doc = { schema: 1, component: name, inputs: inputsFor(name, base), outputs: outputsFor(name, base) };
  fs.writeFileSync(path.join(base, name, 'build-receipt.json'), JSON.stringify(doc, null, 2) + '\n');
}
if (require.main === module) {
  try {
    if (process.argv[2] === '--record') record(process.argv[3]);
    else for (const name of Object.keys(components)) { verify(name); console.log('native build receipt ok: ' + name); }
  } catch (e) { console.error('native-build: ' + e.message); process.exitCode = 1; }
}
module.exports = { verify, record, inputsFor, outputsFor, checkLeaMarkers };
