'use strict';
/*
 * profile-migrate.js — 统一档案改名迁移工具（2.3.2，DESIGN §5.8 兜底通道）
 * =====================================================================
 * 主通道是 ext /admin/api/rename 成功后的内建挂钩（profileCore.migrateProfile）。
 * 本工具供两种场景补迁：
 *   ① 站长在服务器上手跑 rename-account.sh 改的名（不经 ext 后台，
 *      rename-account.sh 尾部挂钩会调本工具；挂钩缺失/失败时手工补跑）；
 *   ② ext 日志出现 profile-migrate-after-rename-error 时的人工补迁。
 * 动作：ext 档案键＋头像文件＋审核行 username 迁移（核心 migrateProfile，
 * 目标已有档案时目标优先合并），外加论坛影子 profiles.json 的键迁移
 * （影子只作回退读，改名后旧键留着会让回退读到旧昵称，故一并搬）。
 * 幂等：重复跑无副作用（源键已不存在即全零报告）。
 *
 * 用法：
 *   node profile-migrate.js <旧账号名> <新账号名> [--ext-dir <ext数据目录>]
 *       [--forum-profiles <论坛 profiles.json 路径>] [--dry-run]
 * 环境变量兜底：QFPROFILE_EXT_DIR（默认 /opt/qfremote-ext/data）、
 *   QFPROFILE_FORUM_PROFILES（默认 /opt/qfremote-forum/data/profiles.json；
 *   文件不存在自动跳过论坛部分）。
 * profile-core 解析顺序：QFPROFILE_CORE → ./profile-core.js →
 *   ../ext/profile-core.js → /opt/qfremote-ext/profile-core.js。
 * 输出：stdout 一行 JSON 报告；退出码 0 成功（含无事可做），2 用法错，1 执行错。
 */
const fs = require('fs');
const path = require('path');

function loadCore() {
  const candidates = [
    process.env.QFPROFILE_CORE,
    path.join(__dirname, 'profile-core.js'),
    path.join(__dirname, '..', 'ext', 'profile-core.js'),
    '/opt/qfremote-ext/profile-core.js',
  ].filter(Boolean);
  for (const c of candidates) { try { return require(c); } catch (e) {} }
  throw new Error('profile-core.js not found (set QFPROFILE_CORE)');
}

function argVal(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : null;
}

function migrateForumShadow(file, oldName, newName, dryRun) {
  if (!fs.existsSync(file)) return { skipped: 'no-file' };
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  // 核对 D1：存在性判断而非真值判断——源值 falsy（null/''/0/false）也要迁移并删旧键，
  // 目标键只要存在（哪怕值为 falsy）即目标优先、绝不覆盖。
  if (!data || typeof data !== 'object' || !has(data, oldName)) return { moved: false };
  if (dryRun) return { moved: true, dryRun: true };
  if (!has(data, newName)) data[newName] = data[oldName]; // 目标优先，不覆盖
  delete data[oldName];
  // 核对 D2：保留原文件的权限与属主（曾因强制 0600＋sudo 跑迁移把 www-data 的
  // profiles.json 变成 root:600，原属主读文件被拒）。
  let st = null;
  try { st = fs.statSync(file); } catch (e) {}
  const tmp = file + '.tmp-migrate';
  fs.writeFileSync(tmp, JSON.stringify(data));
  if (st) {
    try { fs.chmodSync(tmp, st.mode & 0o777); } catch (e) {}
    try { fs.chownSync(tmp, st.uid, st.gid); } catch (e) { /* 非属主/非 root 跑时 chown 可能失败，属主不变故无碍 */ }
  }
  fs.renameSync(tmp, file);
  return { moved: true };
}

function main() {
  const args = process.argv.slice(2);
  const positional = args.filter((a) => !a.startsWith('--'));
  const oldName = String(positional[0] || '').toLowerCase();
  const newName = String(positional[1] || '').toLowerCase();
  const RE = /^[A-Za-z0-9@._+\-]{1,80}$/;
  if (!RE.test(oldName) || !RE.test(newName) || oldName === newName) {
    console.error('用法：node profile-migrate.js <旧账号名> <新账号名> [--ext-dir <dir>] [--forum-profiles <path>] [--dry-run]');
    process.exit(2);
  }
  const dryRun = args.includes('--dry-run');
  const extDir = argVal(args, '--ext-dir') || process.env.QFPROFILE_EXT_DIR || '/opt/qfremote-ext/data';
  const forumProfiles = argVal(args, '--forum-profiles') || process.env.QFPROFILE_FORUM_PROFILES || '/opt/qfremote-forum/data/profiles.json';
  const report = { oldName, newName, dryRun, extDir };

  if (dryRun) {
    // 只读预演：报源键是否存在，不实例化核心（避免写盘副作用）
    let profiles = {};
    try { profiles = JSON.parse(fs.readFileSync(path.join(extDir, 'profiles.json'), 'utf8')); } catch (e) {}
    report.extProfileExists = !!((profiles.users || {})[oldName] || profiles[oldName]);
    report.avatarFileExists = fs.existsSync(path.join(extDir, 'avatars', oldName + '.img'));
  } else {
    const { createProfileCore } = loadCore();
    const core = createProfileCore({
      dataDir: extDir,
      log: () => {},
      events: null,
      reviewModule: null, // 迁移不走审核路径，不需要词表判定
      wordsFile: null,
      wordsFallback: null,
      accountStatus: () => ({ frozen: false, banned: false }),
      imageMod: null,
    });
    report.ext = core.migrateProfile(oldName, newName);
  }
  report.forumShadow = migrateForumShadow(forumProfiles, oldName, newName, dryRun);
  console.log(JSON.stringify(report));
}

try { main(); } catch (e) { console.error('迁移失败：' + String(e && e.message)); process.exit(1); }
