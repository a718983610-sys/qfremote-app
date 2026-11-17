// W-05/W-07 发版门 lint：分层单向依赖检查（Grafana madge 的轻量等价物，无构建也可跑）。
// 层顺序：qf-schema → qf-runtime → qf-ui → app.js；只允许引用同层或更早层的顶层标识，
// 反向引用即循环依赖（跨经典脚本表现为加载时 TDZ / 运行时未定义），非零退出。
// 运行：node tests/lint-no-cycles.mjs
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assetFile } from './resolve-assets.mjs'; // W-08：文件名带 hash，逻辑名经 ASSETS.json 解析

const require = createRequire(import.meta.url);
const acorn = require('acorn');
const WEBAPP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LAYERS = [
  { file: 'qf-schema.js', name: 'schema' },
  { file: 'qf-runtime.js', name: 'runtime' },
  { file: 'qf-ui.js', name: 'ui' },
  { file: 'app.js', name: 'app' },
];
const GLOBALS = new Set(('window document navigator localStorage sessionStorage console JSON Math Date Promise ' +
  'setTimeout clearTimeout setInterval clearInterval fetch XMLHttpRequest FormData FileReader Blob URL ' +
  'location history performance requestAnimationFrame cancelAnimationFrame matchMedia getComputedStyle ' +
  'Image indexedDB BroadcastChannel crypto btoa atob parseInt parseFloat isNaN isFinite ' +
  'encodeURIComponent decodeURIComponent Error TypeError RangeError SyntaxError Object Array String ' +
  'Number Boolean Symbol Map Set WeakMap WeakSet RegExp Intl queueMicrotask MutationObserver ' +
  'ResizeObserver IntersectionObserver CustomEvent Event AbortController TextEncoder TextDecoder ' +
  'WebSocket EventSource Notification Worker MessageChannel BigInt Proxy Reflect undefined NaN Infinity ' +
  'globalThis self top parent frames').split(' '));

function declaredNames(src) {
  const ast = acorn.parse(src, { ecmaVersion: 2022 });
  const names = new Set();
  for (const st of ast.body) {
    if (st.type === 'FunctionDeclaration' && st.id) names.add(st.id.name);
    if (st.type === 'ClassDeclaration' && st.id) names.add(st.id.name);
    if (st.type === 'VariableDeclaration') {
      for (const d of st.declarations) {
        if (d.id.type === 'Identifier') names.add(d.id.name);
        if (d.id.type === 'ObjectPattern') d.id.properties.forEach((p) => { if (p.value?.type === 'Identifier') names.add(p.value.name); });
      }
    }
  }
  return names;
}
function referencedNames(src) {
  const ast = acorn.parse(src, { ecmaVersion: 2022 });
  const refs = new Map(); // name -> first line
  (function visit(n, parent) {
    if (!n || typeof n.type !== 'string') return;
    if (n.type === 'Identifier') {
      let isRef = true;
      if (parent) {
        if (parent.type === 'MemberExpression' && parent.property === n && !parent.computed) isRef = false;
        else if ((parent.type === 'Property' || parent.type === 'PropertyDefinition') && parent.key === n && !parent.computed) isRef = false;
        else if (parent.type === 'VariableDeclarator' && parent.id === n) isRef = false;
        else if ((parent.type === 'FunctionDeclaration' || parent.type === 'FunctionExpression') && parent.id === n) isRef = false;
        else if (parent.type === 'LabeledStatement' && parent.label === n) isRef = false;
        else if (parent.type === 'BreakStatement' || parent.type === 'ContinueStatement') isRef = false;
        else if (parent.type === 'CatchClause' && parent.param === n) isRef = false;
        else if ((parent.type === 'FunctionDeclaration' || parent.type === 'FunctionExpression' || parent.type === 'ArrowFunctionExpression') && parent.params?.includes(n)) isRef = false;
      }
      if (isRef && !refs.has(n.name)) refs.set(n.name, n.loc?.start.line);
      return;
    }
    for (const k of Object.keys(n)) {
      if (['type', 'start', 'end', 'loc'].includes(k)) continue;
      const v = n[k];
      if (Array.isArray(v)) v.forEach((c) => { if (c?.type) visit(c, n); });
      else if (v?.type) visit(v, n);
    }
  })(ast, null);
  return refs;
}

const layers = LAYERS.map((l) => ({ ...l, src: fs.readFileSync(path.join(WEBAPP, assetFile(WEBAPP, l.file)), 'utf8') }));
layers.forEach((l) => { l.declared = declaredNames(l.src); l.refs = referencedNames(l.src); });
// 跨文件重名顶层声明（经典脚本下会直接 SyntaxError）
const owner = new Map();
let fail = 0;
layers.forEach((l, i) => {
  for (const n of l.declared) {
    if (owner.has(n)) { console.log(`DUPLICATE: ${n} declared in both ${owner.get(n)} and ${l.file}`); fail++; }
    else owner.set(n, l.file);
  }
});
// 反向引用检查
layers.forEach((l, i) => {
  for (const [name, line] of l.refs) {
    if (GLOBALS.has(name) || l.declared.has(name)) continue;
    const later = layers.findIndex((x, j) => j > i && x.declared.has(name));
    if (later !== -1) {
      console.log(`CYCLE: ${l.file}:${line} references '${name}' declared in later layer ${layers[later].file}`);
      fail++;
    }
  }
});
console.log(fail === 0
  ? `lint-no-cycles OK: ${layers.map((l) => `${l.file}(${l.declared.size} decls)`).join(' → ')}，无反向引用、无重名声明`
  : `lint-no-cycles FAIL: ${fail} problems`);
process.exit(fail === 0 ? 0 : 1);
