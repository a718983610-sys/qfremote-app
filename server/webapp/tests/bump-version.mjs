// tests/bump-version.mjs — W-08：内容 hash 命名＋ASSETS.json＋改写 index.html。
// 用法：cd server/webapp/tests && node bump-version.mjs（发版时跑一次）
// 规则：文件名 base-<sha256 前 8 位>.ext；内容不变则文件名不变（幂等）；
// index.html 的 src/href 换成 hash 名、去掉 ?v= 查询串；favicon.ico 亦纳入
// （S-074：内容 hash 文件名，改内容即换名，旧 ?v= 查询串作废）。
// 旧 hash 文件改名即删（不留多版本）；ASSETS.json 为逻辑名→hash 名的唯一映射。
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEBAPP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const LOGICAL = ['qf-schema.js', 'qf-runtime.js', 'qf-ui.js', 'app.js', 'qf-tokens.css', 'app.css', 'session.css', 'favicon.ico'];

const hashOf = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 8);
const hashedName = (logical, hash) => {
  const i = logical.lastIndexOf('.');
  return logical.slice(0, i) + '-' + hash + logical.slice(i);
};

const prev = fs.existsSync(path.join(WEBAPP, 'ASSETS.json'))
  ? (JSON.parse(fs.readFileSync(path.join(WEBAPP, 'ASSETS.json'), 'utf8')).files || {})
  : {};
const files = {};
let index = fs.readFileSync(path.join(WEBAPP, 'index.html'), 'utf8');
for (const logical of LOGICAL) {
  const cur = prev[logical] && fs.existsSync(path.join(WEBAPP, prev[logical])) ? prev[logical] : logical;
  if (!fs.existsSync(path.join(WEBAPP, cur))) { console.log(`SKIP: ${logical}（${cur} 不存在）`); continue; }
  const buf = fs.readFileSync(path.join(WEBAPP, cur));
  const next = hashedName(logical, hashOf(buf));
  if (next !== cur) {
    fs.renameSync(path.join(WEBAPP, cur), path.join(WEBAPP, next));
    console.log(`rename ${cur} -> ${next}`);
  } else {
    console.log(`keep ${cur}`);
  }
  files[logical] = next;
  // 引用改写须同时匹配裸名与旧 hash 名：首次 bump 时 index.html 里是裸名，
  // 之后再改内容重命名时里面已是旧 hash 名，只匹配裸名会漏改、留断链。
  const dot = logical.lastIndexOf('.');
  const escBase = logical.slice(0, dot).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escExt = logical.slice(dot).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  index = index.replace(new RegExp(`(src|href)="${escBase}(-[0-9a-f]{8})?${escExt}(\\?[^"]*)?"`, 'g'), `$1="${next}"`);
}
fs.writeFileSync(path.join(WEBAPP, 'index.html'), index);
fs.writeFileSync(path.join(WEBAPP, 'ASSETS.json'),
  JSON.stringify({ generatedAt: new Date().toISOString(), files }, null, 2) + '\n');
console.log('ASSETS.json 已更新：', JSON.stringify(files));
