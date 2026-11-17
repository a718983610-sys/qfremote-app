// tests/lint-versioned-assets.mjs — W-08 发版门 lint。
// 检查：① 每个 hash 文件名内嵌 hash 与内容 sha256 前 8 位一致；
// ② index.html 引用全部 hash 名、对裸逻辑名 0 引用、无 ?v= 查询串；
// ③ ASSETS.json 含全部 8 个逻辑名、目标文件存在；④ 裸名文件已不在盘上。
// 用法：node lint-versioned-assets.mjs
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEBAPP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOGICAL = ['qf-schema.js', 'qf-runtime.js', 'qf-ui.js', 'app.js', 'qf-tokens.css', 'app.css', 'session.css', 'favicon.ico'];
let fail = 0;

const assetsPath = path.join(WEBAPP, 'ASSETS.json');
if (!fs.existsSync(assetsPath)) {
  console.log('FAIL: ASSETS.json 缺失，先跑 node tests/bump-version.mjs');
  process.exit(1);
}
const files = JSON.parse(fs.readFileSync(assetsPath, 'utf8')).files || {};
for (const logical of LOGICAL) {
  const hashed = files[logical];
  if (!hashed) { console.log(`FAIL: ASSETS.json 缺 ${logical}`); fail++; continue; }
  if (!fs.existsSync(path.join(WEBAPP, hashed))) { console.log(`FAIL: ${hashed} 不存在`); fail++; continue; }
  const hash = createHash('sha256').update(fs.readFileSync(path.join(WEBAPP, hashed))).digest('hex').slice(0, 8);
  const m = hashed.match(/-([0-9a-f]{8})\.[a-z]+$/);
  if (!m || m[1] !== hash) { console.log(`FAIL: ${hashed} 内嵌 hash 与内容不符（内容 hash ${hash}）`); fail++; }
  if (fs.existsSync(path.join(WEBAPP, logical))) { console.log(`FAIL: 裸名文件 ${logical} 仍在盘上`); fail++; }
}
const index = fs.readFileSync(path.join(WEBAPP, 'index.html'), 'utf8');
for (const logical of LOGICAL) {
  const esc = logical.replace('.', '\\.');
  if (new RegExp(`(src|href)="${esc}(\\?[^"]*)?"`).test(index)) { console.log(`FAIL: index.html 仍引用裸名 ${logical}`); fail++; }
  const hashed = files[logical];
  if (hashed && !index.includes(`"${hashed}"`)) { console.log(`FAIL: index.html 未引用 ${hashed}`); fail++; }
}
if (/\?v=/.test(index)) { console.log('FAIL: index.html 仍有 ?v= 查询串 bust（S-074：favicon 亦已改内容 hash 名，?v= 全面作废）'); fail++; }

if (fail) { console.log(`lint-versioned-assets FAIL: ${fail} 处违规`); process.exit(1); }
console.log(`OK: ${LOGICAL.length} 个资产 hash 文件名与内容一致，index.html 零裸名引用`);
