'use strict';
/*
 * import-nicknames.js — 论坛存量昵称一次性导入 ext 统一档案（2.3.2 收编，见 DESIGN §5.8）
 * ================================================================
 * 用法：
 *   node import-nicknames.js [--dry-run] [--accounts=<账号清单>] <论坛 profiles.json 路径> <ext 数据目录>
 *   node import-nicknames.js [--dry-run] --forum=<path> --ext-dir=<dir> [--accounts=<path>]
 *
 * 逻辑：
 *  - 论坛 profiles.json 是以账号名为键的对象：{ <name>: { nickname, ... } }。
 *    只处理 nickname 非空（trim 后非空）的条目，空昵称跳过、不计入 total。
 *  - ext 台账在 <ext 数据目录>/profiles.json，结构：
 *    { users: { <name>: { nickname, avatarMime, avatarUpdatedAt, updatedAt } } }
 *  - 逐个导入：ext 无记录、或已有记录的 nickname 为空时才写入；
 *    ext 已有非空昵称的一律跳过并列入 skippedExisting（冲突以正本为准，
 *    绝不覆盖）。导入值均为已过论坛机审的历史值，不重审（DESIGN §5.8）。
 *  - 幂等：重复运行不会改动已导入值；且无新导入时根本不写文件。
 *  - 原子写：同目录 tmp + rename，文件权限 0600。
 *  - 输出（stdout，只输出这一份 JSON）：
 *    { imported, skippedExisting, total, skippedInvalid, skippedUnknown, normalized, warning? }
 *    total = 论坛侧非空昵称条目总数（= imported + skippedExisting 的基数口径）。
 *  - --dry-run：只报告不写文件、不建目录。
 *
 * DeepSeek 核对（PROFILE-EXT-FORUM）修复增补：
 *  - #11：ext 台账文件存在但解析失败/结构损坏 → 直接报错中止，绝不按空档
 *    继续写（曾实测整文件覆盖丢失他人档案）。论坛侧同口径（原已抛错）。
 *  - #12：账号名一律 toLowerCase 归一后再比对/落库（ext 全部查键路径均
 *    小写），归一映射进报告 normalized。
 *  - #19：键白名单（与 ext ACCOUNT_RE 同集）＋ __proto__/constructor/
 *    prototype 显式拒绝，读写 ext.users 一律 hasOwnProperty 语义，
 *    杜绝原型污染与记录静默丢失；被拒键进报告 skippedInvalid。
 *  - #15：可选 --accounts=<清单>（meshcentral.db 的 JSONL、JSON 数组或
 *    每行一名的文本）：不在现行账号清单内的键（已改名/已删号旧名）
 *    跳过并进报告 skippedUnknown；未提供清单时报告带 warning 明示未过滤。
 *  - #16：落盘前重读 ext 台账最新字节并在其上重演合并（写时以磁盘为准），
 *    关掉「读旧快照→整文件写回」的 lost update 窗口；运行窗口仍建议选在
 *    ext 停服或低峰时段（脚本会在报告 warning 里提醒）。
 */
const fs = require('fs');
const path = require('path');

const ACCOUNT_KEY_RE = /^[a-z0-9@._+\-]{1,80}$/;
const DENY_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function parseArgs(argv) {
  const out = { dryRun: false, positional: [], forum: '', extDir: '', accounts: '' };
  for (const a of argv) {
    if (a === '--dry-run') out.dryRun = true;
    else if (a.startsWith('--forum=')) out.forum = a.slice('--forum='.length);
    else if (a.startsWith('--ext-dir=')) out.extDir = a.slice('--ext-dir='.length);
    else if (a.startsWith('--accounts=')) out.accounts = a.slice('--accounts='.length);
    else out.positional.push(a);
  }
  if (!out.forum && out.positional[0]) out.forum = out.positional[0];
  if (!out.extDir && out.positional[1]) out.extDir = out.positional[1];
  return out;
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}

// ext 台账严格读：文件不存在＝空档起步；存在但坏＝抛错中止（#11）
function readExtStrict(extFile) {
  if (!fs.existsSync(extFile)) return { users: {} };
  let ext;
  try { ext = JSON.parse(fs.readFileSync(extFile, 'utf8')); }
  catch (e) { throw new Error('ext profiles.json 已损坏，拒绝导入（请先修复台账再导入）：' + extFile); }
  if (!ext || typeof ext !== 'object' || Array.isArray(ext)) {
    throw new Error('ext profiles.json 结构不正确，拒绝导入：' + extFile);
  }
  if (ext.users === undefined) ext.users = {};
  if (!ext.users || typeof ext.users !== 'object' || Array.isArray(ext.users)) {
    throw new Error('ext profiles.json 的 users 结构不正确，拒绝导入：' + extFile);
  }
  return ext;
}

// 账号清单：JSONL（meshcentral.db，取 user 记录的 name）/ JSON 数组 / 每行一名
function loadAccounts(file) {
  const text = fs.readFileSync(file, 'utf8');
  const names = new Set();
  const addName = (n) => { if (typeof n === 'string' && n.trim()) names.add(n.trim().toLowerCase()); };
  const trimmed = text.trim();
  if (trimmed.startsWith('[')) {
    const arr = JSON.parse(trimmed);
    if (Array.isArray(arr)) arr.forEach((x) => addName(typeof x === 'string' ? x : x && x.name));
    return names;
  }
  let jsonlHits = 0;
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    if (s.startsWith('{')) {
      try {
        const rec = JSON.parse(s);
        if (rec && (rec.type === 'user' || (typeof rec._id === 'string' && rec._id.startsWith('user//')))) { addName(rec.name); jsonlHits++; continue; }
      } catch (e) { /* 落到纯文本行处理 */ }
    }
    addName(s);
  }
  return names;
}

function importNicknames(forumProfilesPath, extDataDir, opts) {
  const dryRun = !!(opts && opts.dryRun);
  const accounts = (opts && opts.accounts) || null; // Set<小写账号名> 或 null
  const forumProfiles = readJson(forumProfilesPath, null);
  if (!forumProfiles || typeof forumProfiles !== 'object' || Array.isArray(forumProfiles)) {
    throw new Error('论坛 profiles.json 读取失败或结构不正确：' + forumProfilesPath);
  }
  const extFile = path.join(extDataDir, 'profiles.json');
  const now = Date.now();

  // ---- 计划阶段：归一＋校验＋存在性过滤（#12/#19/#15） ----
  const plan = []; // { key, nick }
  const skippedInvalid = [];
  const skippedUnknown = [];
  const normalized = {};
  let total = 0;
  for (const rawName of Object.keys(forumProfiles).sort()) {
    const rec = forumProfiles[rawName];
    const nick = rec && typeof rec.nickname === 'string' ? rec.nickname.trim() : '';
    if (!nick) continue; // 空昵称不导入、不计 total
    total++;
    const key = rawName.toLowerCase();
    if (DENY_KEYS.has(key) || !ACCOUNT_KEY_RE.test(key)) { skippedInvalid.push(rawName); continue; }
    if (key !== rawName) normalized[rawName] = key;
    if (accounts && !accounts.has(key)) { skippedUnknown.push(rawName); continue; }
    plan.push({ key, nick });
  }

  // ---- 应用阶段：在给定台账对象上重演合并（正本非空昵称永不覆盖） ----
  function applyOn(ext) {
    const imported = [];
    const skippedExisting = [];
    for (const { key, nick } of plan) {
      const cur = hasOwn(ext.users, key) ? ext.users[key] : undefined;
      if (cur && typeof cur === 'object' && typeof cur.nickname === 'string' && cur.nickname.trim()) {
        skippedExisting.push(key); // 正本已有非空昵称：跳过，绝不覆盖
        continue;
      }
      if (cur && typeof cur === 'object') {
        cur.nickname = nick;
        if (cur.avatarMime === undefined) cur.avatarMime = null;
        if (cur.avatarUpdatedAt === undefined) cur.avatarUpdatedAt = null;
        if (cur.avatarSha === undefined) cur.avatarSha = null;
        cur.updatedAt = now;
      } else {
        ext.users[key] = { nickname: nick, avatarMime: null, avatarUpdatedAt: null, avatarSha: null, updatedAt: now };
      }
      imported.push(key);
    }
    return { imported, skippedExisting };
  }

  const report = { imported: [], skippedExisting: [], total, skippedInvalid, skippedUnknown, normalized };
  if (!accounts) report.warning = '未提供 --accounts 现行账号清单：已改名/已删号的旧名无法排除，请人工核对导入结果';
  if (dryRun) {
    const ext0 = readExtStrict(extFile);
    const r = applyOn(ext0);
    report.imported = r.imported; report.skippedExisting = r.skippedExisting;
    return report;
  }
  if (plan.length) {
    // #16：落盘前重读台账最新字节并在其上重演合并，避免旧快照整文件写回
    const extFresh = readExtStrict(extFile);
    const r = applyOn(extFresh);
    report.imported = r.imported; report.skippedExisting = r.skippedExisting;
    if (r.imported.length) {
      fs.mkdirSync(extDataDir, { recursive: true });
      const tmp = extFile + '.tmp-' + process.pid;
      fs.writeFileSync(tmp, JSON.stringify(extFresh, null, 2) + '\n', { mode: 0o600 });
      fs.chmodSync(tmp, 0o600);
      fs.renameSync(tmp, extFile);
      try { fs.chmodSync(extFile, 0o600); } catch (e) { /* rename 后权限已由 tmp 决定，此步仅兜底 */ }
    }
  }
  return report;
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.forum || !args.extDir) {
    console.error('用法：node import-nicknames.js [--dry-run] [--accounts=<账号清单>] <论坛 profiles.json 路径> <ext 数据目录>');
    process.exit(2);
  }
  try {
    const accounts = args.accounts ? loadAccounts(args.accounts) : null;
    const report = importNicknames(args.forum, args.extDir, { dryRun: args.dryRun, accounts });
    console.log(JSON.stringify(report));
  } catch (e) {
    console.error('导入失败：' + (e && e.message ? e.message : e));
    process.exit(1);
  }
}

module.exports = { importNicknames, parseArgs, loadAccounts };
