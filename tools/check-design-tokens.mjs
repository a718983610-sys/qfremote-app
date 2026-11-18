// check-design-tokens.mjs — S-132 设计令牌 CI 校验（2026-11-18）。
// 用法（在仓库根执行）：node tools/check-design-tokens.mjs
// 检查四项，任一项失败即 exit 1：
//   1) tokens.json 符合 design-tokens/schema.json（结构，零外部依赖的手写校验）；
//   2) tokens.json 里没有任何 token 的 note 以 DIVERGENT 开头（分歧须由 S-132 定值）；
//   3) 基础对比度：主文字／次文字／链接对页面底、品牌字对品牌底，深浅两端均 ≥4.5:1（WCAG AA 正文）；
//   4) 禁色扫描：九个服务端页面＋网页端构建产物＋Windows 壳＋安卓 theme.dart 的代码（去注释后）
//      不得出现品牌蓝及蓝色系旧值（见 BANNED）。历史注释里提及旧值不算（去注释后扫描）。
// 注意：本脚本自身含禁色表，故不在扫描范围内；tokens.json 的 note 允许记载已废止的旧值
// （那是裁决记录），只校验 light／dark 字段值。
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOKENS = join(ROOT, 'design-tokens', 'tokens.json');
const SCHEMA = join(ROOT, 'design-tokens', 'schema.json');
let fail = 0;
const bad = (m) => { console.log(`FAIL: ${m}`); fail++; };
const ok = (m) => { console.log(`OK: ${m}`); };

// ---------- 1) Schema 结构校验（手写，与 schema.json 同口径） ----------
const tokens = JSON.parse(readFileSync(TOKENS, 'utf8'));
const schema = JSON.parse(readFileSync(SCHEMA, 'utf8'));
const HEX6 = /^#[0-9A-Fa-f]{6}$/;
const needTop = ['version', 'description', 'color', 'fontSize', 'spacing', 'radius', 'motion'];
for (const k of needTop) if (!(k in tokens)) bad(`tokens.json 缺顶层字段 ${k}`);
if (typeof tokens.version !== 'number' || tokens.version < 1) bad('version 须为 ≥1 的整数');
const needColors = ['brand', 'danger', 'info', 'lineDefault', 'link', 'linkUnderline', 'success', 'surface0', 'surface1', 'textPrimary', 'textSecondary', 'warning'];
for (const k of needColors) {
  const c = tokens.color && tokens.color[k];
  if (!c) { bad(`color 缺 ${k}`); continue; }
  for (const t of ['light', 'dark']) if (!HEX6.test(c[t] || '')) bad(`color.${k}.${t} 不是 6 位十六进制：${c[t]}`);
}
const needNums = { fontSize: ['fs11', 'fs12', 'fs13', 'fs14', 'fs15', 'fs16', 'fs18', 'fs20', 'fs22', 'fs24', 'fs26', 'fs29'], spacing: ['sp1', 'sp2', 'sp3', 'sp4', 'sp5', 'sp6', 'sp7', 'sp8', 'sp9', 'sp10'], radius: ['rCard', 'rPill', 'rSmall', 'radiusLg'], motion: ['d0Ms', 'd1Ms', 'd2Ms', 'd3Ms', 'd4Ms', 'd5Ms', 'd6Ms'] };
for (const [sec, keys] of Object.entries(needNums)) {
  for (const k of keys) if (typeof (tokens[sec] || {})[k] !== 'number') bad(`${sec} 缺数值 ${k}`);
}
if (tokens.version !== schema.properties.version.minimum && tokens.version < 2) bad('S-132 裁决后 version 须 ≥2');
if (!fail) ok('tokens.json 符合 schema.json 结构');

// ---------- 2) 无 DIVERGENT ----------
let div = 0;
for (const [k, v] of Object.entries(tokens.color || {})) {
  if (String(v.note || '').startsWith('DIVERGENT')) { bad(`color.${k} 仍有未裁决分歧：${v.note}`); div++; }
}
if (!div) ok('无 DIVERGENT 分歧 token');

// ---------- 3) 基础对比度（WCAG 相对亮度） ----------
function lum(hex) {
  const ch = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * ch((n >> 16) & 0xFF) + 0.7152 * ch((n >> 8) & 0xFF) + 0.0722 * ch(n & 0xFF);
}
function contrast(a, b) { const l1 = lum(a), l2 = lum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); }
const C = tokens.color;
const pairs = [
  ['textPrimary/surface0 light', C.textPrimary.light, C.surface0.light],
  ['textPrimary/surface0 dark', C.textPrimary.dark, C.surface0.dark],
  ['textSecondary/surface0 light', C.textSecondary.light, C.surface0.light],
  ['textSecondary/surface0 dark', C.textSecondary.dark, C.surface0.dark],
  ['link/surface0 light', C.link.light, C.surface0.light],
  ['link/surface0 dark', C.link.dark, C.surface0.dark],
  ['onBrand(white)/brand light', '#FFFFFF', C.brand.light],
  ['onBrand(black)/brand dark', '#000000', C.brand.dark],
];
for (const [name, a, b] of pairs) {
  const r = contrast(a, b);
  if (r < 4.5) bad(`对比度不足 ${name}：${r.toFixed(2)}:1（要求 ≥4.5:1）`);
  else console.log(`OK: 对比度 ${name} ${r.toFixed(2)}:1`);
}

// ---------- 4) 禁色扫描（去注释后，裸 6 位 hex 子串＋rgba 前缀） ----------
// 只禁“在任何位置都算错”的品牌蓝系；#111113／#F5F5F7 等中性灰不在此表，
// 它们只在特定 token 槽位才算错，由 generate.dart --check 的变量绑定比对覆盖。
const BANNED_HEX = ['2470E0', '3F8CFF', '1B5CC4', '0D3170', '0B2B5B', '081F47', '142B51', '1450B4', '2E7CD6', '3D7BD6', '7FB8F5', '7FB0FF', 'EAF1FD', 'E3EEFC', 'EAF0F8', 'F2F7FF', 'F4F8FF', 'F7FAFE', 'EDF3FD', 'EAF3FE', 'BFD8F5', 'BFD6F6', 'B9CBEF', 'C5DAFE', 'D7E1F2', 'DFE7F2', 'EEF3FB', 'E8F1FE', 'F4F7FB', 'C9D6E8', 'B7C3D6', 'C3CFE0', '9DB8DC', '8FA9CC', 'BFD3F2', 'D6E4F8', 'DCE7F7', '5F7EA6', '1C2A44', '1A2436', '2E4A73',
  // 2026-11-18 收口实测补入：近白蓝 tint 与蓝灰（九文件＋增量文件里实际出现的旧值）。
  'EDF1F7', 'FBFDFF', 'F7FBFF', 'EDF2F9', 'EFF3F9', 'E9EEF6', 'F7FAFF', 'FBFCFE', 'ECEFF3', '93A5BE',
  '5F7089', '5B6B7D', '43536A', '1C2733', '2C3E55', '1D2B3A', '3A4152', '243B5E', '16345F', '10294D',
  '3A4150', '2B3038', '22262E', '171B23', '10141C', '12161D', '0D1420', '1F2D47', '333B48', '262B34',
  '6B7A90', '9AA7BC', '77839A', '8494AC', '93A3B8', '5B7BA5', 'B9C6D8', '7A93B5', '6B8CAE', '5B83B8',
  '5A6B84', '4E7396', '3E6FB4', 'A9C6F5', 'E8ECF4', 'CFDCEE'];
const BANNED_RGBA = ['rgba(36,112,224', 'rgba(8,31,71', 'rgba(9,38,84', 'rgba(13,49,112', 'rgba(15,35,70', 'rgba(16,42,80', 'rgba(10,40,90', 'rgba(63,140,255', 'rgba(20,90,220'];
const SCAN_FILES = [
  'server/register/register.html',
  'server/ext/license-pages.js',
  'server/ext/home-page.js',
  'server/friends/friends.html',
  'server/forum/forum.html',
  'server/friends/support/support-page.html',
  'server/friends/qf-wrap.html',
  'server/friends/chat/chat.html',
  'server/meshcentral/public/scripts/custom.js',
  'server/ext/server.js',
  'server/webapp/qf-tokens-generated.css',
  'server/webapp/index.html',
  'android-app/lib/ui/theme.dart',
  'android-app/lib/ui/generated_tokens.dart',
  'windows/console-preload.js',
  'windows/toolbar-preload.js',
  'windows/main.js',
  'windows/shared.css',
];
// webapp 哈希产物：按 ASSETS.json 解析逻辑名。
let webappHashes = [];
try {
  const assets = JSON.parse(readFileSync(join(ROOT, 'server/webapp/ASSETS.json'), 'utf8'));
  const files = assets.files || assets;
  for (const [logical, hashed] of Object.entries(files)) {
    if (/^(app|session|qf-tokens|qf-runtime|qf-ui|qf-schema)\.(css|js)$/.test(logical)) webappHashes.push(`server/webapp/${hashed}`);
  }
} catch { /* ASSETS.json 不可读时跳过哈希产物 */ }
function stripComments(text) {
  return text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}
let hits = 0;
for (const rel of [...SCAN_FILES, ...webappHashes]) {
  const p = join(ROOT, rel);
  if (!existsSync(p)) { console.log(`SKIP: ${rel} 不存在`); continue; }
  const text = stripComments(readFileSync(p, 'utf8'));
  const low = text.toLowerCase();
  for (const h of BANNED_HEX) {
    let idx = low.indexOf(h.toLowerCase());
    while (idx !== -1) {
      const line = text.slice(0, idx).split('\n').length;
      bad(`${rel}:${line} 禁色 #${h}`);
      hits++;
      idx = low.indexOf(h.toLowerCase(), idx + 1);
    }
  }
  for (const r of BANNED_RGBA) {
    const norm = low.replace(/\s+/g, '');
    const needle = r.toLowerCase().replace(/\s+/g, '');
    let idx = norm.indexOf(needle);
    while (idx !== -1) {
      bad(`${rel} 禁色 ${r}…`);
      hits++;
      idx = norm.indexOf(needle, idx + 1);
    }
  }
}
if (!hits) ok('禁色扫描：0 命中');

if (fail) { console.log(`FAIL: 共 ${fail} 项`); process.exit(1); }
console.log('OK: 设计令牌校验全部通过');
