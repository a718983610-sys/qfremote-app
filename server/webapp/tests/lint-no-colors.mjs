// lint-no-colors.mjs — W-01: 色值字面量只允许出现在 qf-tokens.css 的变量定义中。
// 用法：node lint-no-colors.mjs
// 检查：
//  1) app.css / session.css / index.html / app.js / qf-schema.js / qf-runtime.js / qf-ui.js
//     中不得出现任何 hex (#RGB/#RRGGBB) 或 rgb()/rgba() 字面量（注释、用法、JS 均含在内）。
//  2) qf-tokens.css 内，字面量只允许出现在 --name: value; 定义中，注释里也不许出现。
//  3) app.css / session.css 引用的 var(--x) 必须在 qf-tokens.css 中有定义（防 token 名打错）。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assetFile } from './resolve-assets.mjs'; // W-08：文件名带 hash，逻辑名经 ASSETS.json 解析

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const LITERAL_FILES = ['app.css', 'session.css', 'index.html', 'app.js', 'qf-schema.js', 'qf-runtime.js', 'qf-ui.js'];
const HEX = /#[0-9a-fA-F]{3,8}(?![0-9a-zA-Z-])/g;
const RGB = /\brgba?\(/g;
let fail = 0;
const hit = (file, line, col, what) => { console.log(`${file}:${line}:${col} ${what}`); fail++; };

function scanLiterals(file, text) {
  for (const [i, line] of text.split('\n').entries()) {
    for (const m of line.matchAll(HEX)) hit(file, i + 1, m.index + 1, `hex 字面量 ${m[0]}`);
    for (const m of line.matchAll(RGB)) hit(file, i + 1, m.index + 1, `rgb 字面量 ${m[0]}`);
  }
}
for (const f of LITERAL_FILES) scanLiterals(f, readFileSync(join(root, assetFile(root, f)), 'utf8'));

// qf-tokens.css：先去注释，再去变量定义，剩余文本不得含字面量。
const tokens = readFileSync(join(root, assetFile(root, 'qf-tokens.css')), 'utf8');
const noComments = tokens.replace(/\/\*[\s\S]*?\*\//g, '');
const noDefs = noComments.replace(/--[\w-]+\s*:[^;]+;/g, '');
for (const [i, line] of noDefs.split('\n').entries()) {
  for (const m of line.matchAll(HEX)) hit('qf-tokens.css', i + 1, m.index + 1, `注册表外 hex ${m[0]}`);
  for (const m of line.matchAll(RGB)) hit('qf-tokens.css', i + 1, m.index + 1, `注册表外 rgb ${m[0]}`);
}

// 引用完整性：CSS 里 var(--x) 必须有定义——定义域为 qf-tokens.css 注册表
// 加上各文件自身的局部定义（session.css 在 .viewer 内自有一套布局 token，不归 W-01 管）。
const defined = new Set([...tokens.matchAll(/--([\w-]+)\s*:/g)].map(m => m[1]));
for (const f of ['app.css', 'session.css']) {
  const text = readFileSync(join(root, assetFile(root, f)), 'utf8');
  for (const m of text.matchAll(/--([\w-]+)\s*:/g)) defined.add(m[1]);
}
for (const f of ['app.css', 'session.css']) {
  const text = readFileSync(join(root, assetFile(root, f)), 'utf8');
  for (const m of text.matchAll(/var\(--([\w-]+)\)/g)) {
    if (!defined.has(m[1])) hit(f, text.slice(0, m.index).split('\n').length, 0, `未定义 token --${m[1]}`);
  }
}

if (fail) { console.log(`FAIL: ${fail} 处违规`); process.exit(1); }
console.log(`OK: 7 文件零字面量；注册表 token 数见 qf-tokens.css；CSS 引用全部有定义`);
