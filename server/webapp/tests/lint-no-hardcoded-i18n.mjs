// lint-no-hardcoded-i18n.mjs — W-09：新代码硬编码中文归零。
// 规则：
//  1) locales/zh-CN.json 与 locales/en.json 的 key 必须一致；
//  2) 代码里 t('key') 的 key 必须在 zh-CN.json 中存在；
//  3) QF_I18N_ZH 内嵌表 key 必须与 zh-CN.json 一致；
//  4) qf-runtime.js / qf-ui.js 内含中文的字符串字面量数不得超过
//     tests/i18n-baseline.json 的基线（旧代码 grandfathered，只许减不许增）。
// 运行：node tests/lint-no-hardcoded-i18n.mjs
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assetFile } from './resolve-assets.mjs'; // W-08：文件名带 hash，逻辑名经 ASSETS.json 解析

const require = createRequire(import.meta.url);
const acorn = require('acorn');
const WEBAPP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TESTS = path.join(WEBAPP, 'tests');
const CJK = /[\u4e00-\u9fff]/;
let fail = 0;

const zh = JSON.parse(fs.readFileSync(path.join(WEBAPP, 'locales', 'zh-CN.json'), 'utf8'));
const en = JSON.parse(fs.readFileSync(path.join(WEBAPP, 'locales', 'en.json'), 'utf8'));
const zhKeys = Object.keys(zh).sort();
const enKeys = Object.keys(en).sort();
if (JSON.stringify(zhKeys) !== JSON.stringify(enKeys)) {
  console.log(`FAIL: locales key 不一致 zh-only=${zhKeys.filter((k) => !enKeys.includes(k))} en-only=${enKeys.filter((k) => !zhKeys.includes(k))}`);
  fail++;
} else {
  console.log(`OK: locales key 一致（${zhKeys.length} 个）`);
}

function countCjkLiterals(src) {
  const ast = acorn.parse(src, { ecmaVersion: 2022 });
  let n = 0;
  (function visit(node) {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'Literal' && typeof node.value === 'string' && CJK.test(node.value)) n++;
    if (node.type === 'TemplateLiteral') {
      node.quasis.forEach((q) => { if (CJK.test(q.value.cooked || '')) n++; });
    }
    for (const k of Object.keys(node)) {
      if (['type', 'start', 'end', 'loc'].includes(k)) continue;
      const v = node[k];
      if (Array.isArray(v)) v.forEach((c) => { if (c?.type) visit(c); });
      else if (v?.type) visit(v);
    }
  })(ast);
  return n;
}

function tKeys(src) {
  const keys = new Set();
  const ast = acorn.parse(src, { ecmaVersion: 2022 });
  (function visit(node) {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 't'
      && node.arguments[0] && node.arguments[0].type === 'Literal' && typeof node.arguments[0].value === 'string') {
      keys.add(node.arguments[0].value);
    }
    for (const k of Object.keys(node)) {
      if (['type', 'start', 'end', 'loc'].includes(k)) continue;
      const v = node[k];
      if (Array.isArray(v)) v.forEach((c) => { if (c?.type) visit(c); });
      else if (v?.type) visit(v);
    }
  })(ast);
  return keys;
}

const baseline = JSON.parse(fs.readFileSync(path.join(TESTS, 'i18n-baseline.json'), 'utf8'));
for (const f of ['qf-runtime.js', 'qf-ui.js']) {
  let src = fs.readFileSync(path.join(WEBAPP, assetFile(WEBAPP, f)), 'utf8');
  // QF_I18N_ZH 内嵌表是语言包的回落副本（受 key 一致性规则管），不计入硬编码中文
  src = src.replace(/const QF_I18N_ZH = \{[\s\S]*?\};/, 'const QF_I18N_ZH = {};');
  const n = countCjkLiterals(src);
  const base = baseline[f];
  if (n > base) { console.log(`FAIL: ${f} 中文字符串字面量 ${n} > 基线 ${base}（新代码须走 t()）`); fail++; }
  else console.log(`OK: ${f} 中文字符串字面量 ${n}（基线 ${base}）`);
  for (const k of tKeys(src)) {
    if (!(k in zh)) { console.log(`FAIL: ${f} 的 t('${k}') 不在 locales/zh-CN.json`); fail++; }
  }
}
// 内嵌中文表与语言包一致
const rtSrc = fs.readFileSync(path.join(WEBAPP, assetFile(WEBAPP, 'qf-runtime.js')), 'utf8');
const m = rtSrc.match(/const QF_I18N_ZH = \{([\s\S]*?)\};/);
if (m) {
  const embedded = [...m[1].matchAll(/'([^']+)':/g)].map((x) => x[1]).sort();
  if (JSON.stringify(embedded) !== JSON.stringify(zhKeys)) {
    console.log(`FAIL: QF_I18N_ZH key 与 zh-CN.json 不一致 embedded=${embedded} zh=${zhKeys}`);
    fail++;
  } else console.log('OK: QF_I18N_ZH 与 zh-CN.json key 一致');
} else { console.log('FAIL: 未找到 QF_I18N_ZH'); fail++; }

if (fail) { console.log(`lint-no-hardcoded-i18n FAIL: ${fail} 处违规`); process.exit(1); }
console.log('lint-no-hardcoded-i18n OK');
