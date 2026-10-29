'use strict';
/*
 * QFRemote 扩展服务 · 全站统一档案（昵称＋头像）正本（2.3.2 新功能）
 * ================================================================
 * 口径：v232/profile-avatar-nickname/DESIGN.md（站长 2026-10-26 令，
 * 规则与 QFClash 一样；督导放行）。语义逐条对 QFClash profilemod.js /
 * profile.js / 迁移 0045：
 *  - 先审后生效：提交机审，通过即生效并留 approved 行；驳回只留
 *    rejected 行（大类＋规则键＋快照），旧值原样保留；被拦不处罚、
 *    不计任何违规梯度，与禁言/封号及其申诉体系完全隔离。
 *  - 昵称判定与论坛内容审核同一判定源（profile-review.js＝forum
 *    review.js 同源副本）、同一词库（热读论坛现行 words 文件）。
 *    拒绝只回违规大类，永不回命中词（hitRules 只存内部、永不外发）。
 *  - 头像：PNG/JPEG/WebP/GIF、≤200KB、严格 base64、魔数嗅探（排在
 *    大小校验之后）；图像审核走 deps.imageMod 供给（生产＝GLM 视觉，
 *    见 profile-imagemod.js）；无供给/异常 → fail-closed（不生效、
 *    不落 rejected 行、仅审计，用户回「系统繁忙，请稍后再试」）。
 *  - 删除头像/清除昵称：免审直生效、不留审核行。
 *  - 申诉：每行至多一次（说明 ≤200 字）→ 事件队列新类型 profile_mod
 *    双通道代审（助手接口＋站长后台共用本模块 decideAppeal 核心）；
 *    批准 → 原内容补生效；驳回须写明正式理由。
 *  - 版本化头像 URL：avatarUpdatedAt 秒级版本戳，max(当前秒, 旧戳+1)
 *    单调递增（QFClash F-02 口径）；版本对上 immutable、否则 no-store。
 *  - 默认昵称＝登录账号名计算回退（不落库）；默认头像＝客户端品牌占位
 *    （服务端无默认图，本模块只回 hasAvatar=false）。
 *
 * 存储（deps.dataDir 下，全走 tmp+rename 原子写、0600）：
 *  profiles.json    { users: { <账号名>: { nickname, avatarMime, avatarUpdatedAt, avatarSha, updatedAt } } }
 *    （avatarSha＝头像字节 sha256，DeepSeek 核对 F1 增补：启动对账识别「文件已换、台账未落」错位；
 *     审核行另增 baseNickname/baseAvatarUpdatedAt 申诉基线（F2）与 snapshotExpired 标记（F3），均内部字段不外发）
 *  profile-mod.json { seq, items: [审核行] }
 *  avatars/<账号名>.img        头像本体
 *  avatars-mod/<记录号>.img    驳回头像快照（结案/超期 30 天清理删字节，行保留）
 *  profile-config.json         { enabled:false } 才关停（回滚开关）
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const AVATAR_MAX_BYTES = 200 * 1024;
const AVATAR_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const NICKNAME_MAX = 20;
const APPEAL_NOTE_MAX = 200;
const SUBMIT_PER_DAY_DEFAULT = 20;
const SNAPSHOT_RETENTION_MS = 30 * 86400000;
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
// 账号名文件名安全集（与 ext ACCOUNT_RE 对齐；服务账号带 '-' 亦在内）
const NAME_RE = /^[A-Za-z0-9@._+\-]{1,80}$/;
// 存量导入键口径（J-9c，与脚本版 import-nicknames.js 的 ACCOUNT_KEY_RE/DENY_KEYS 逐字一致）
const IMPORT_KEY_RE = /^[a-z0-9@._+\-]{1,80}$/;
const IMPORT_DENY_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// ---------- 与 QFClash profile.js/util.js 同口径的小工具 ----------
function decodeB64(s) {
  if (typeof s !== 'string' || !s || s.length % 4 !== 0 || !B64_RE.test(s)) return null;
  try { return Buffer.from(s, 'base64'); } catch (e) { return null; }
}
function sniffImageMime(b) {
  if (!b || b.length < 3) return null;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 4 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  return null;
}
function shanghaiDayStartMs(nowMs) {
  const key = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(nowMs));
  return Date.parse(key + 'T00:00:00+08:00');
}

function createProfileCore(deps) {
  const dataDir = deps.dataDir;
  const log = deps.log || (() => {});
  const events = deps.events || null; // reviewEvents（enqueue/resolve）
  const R = deps.reviewModule; // profile-review.js（forum review.js 同源）
  const submitPerDay = deps.submitPerDay || SUBMIT_PER_DAY_DEFAULT;
  const accountStatus = deps.accountStatus || (() => ({ frozen: false, banned: false }));
  const imageModFn = deps.imageMod || null; // async ({bytes, mime}) => {usable, category?, rules?}
  const profilesFile = path.join(dataDir, 'profiles.json');
  const modFile = path.join(dataDir, 'profile-mod.json');
  const avatarsDir = path.join(dataDir, 'avatars');
  const modAvatarsDir = path.join(dataDir, 'avatars-mod');
  const configFile = path.join(dataDir, 'profile-config.json');
  const wordsFile = deps.wordsFile || null;
  const wordsFallback = deps.wordsFallback || null;
  try { fs.mkdirSync(avatarsDir, { recursive: true }); fs.mkdirSync(modAvatarsDir, { recursive: true }); } catch (e) {}

  // ---------- 开关（mtime 热读，缺省开启） ----------
  let cfgCache = { at: 0, mtime: 0, enabled: true };
  function enabled() {
    try {
      const st = fs.statSync(configFile);
      if (st.mtimeMs !== cfgCache.mtime) {
        const v = JSON.parse(fs.readFileSync(configFile, 'utf8'));
        cfgCache = { at: Date.now(), mtime: st.mtimeMs, enabled: !(v && v.enabled === false) };
      }
    } catch (e) { cfgCache.enabled = true; }
    return cfgCache.enabled;
  }

  // ---------- 台账读写（原子写，照 points.json 先例） ----------
  function loadJson(file, fallback) {
    // J-9b（发版前全量审立项）：损坏台账不许静默回落空档——下一次 save 会把
    // 损坏原件整文件覆盖、档案全丢。与 events-core/forum 隔离口径对齐：
    // ENOENT（首启无文件）才静默回落；解析失败/非对象一律先改名隔离
    // .corrupt-* 保全原字节并 log 留痕，再回落空档起步。
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); }
    catch (e) {
      if (e && e.code !== 'ENOENT') {
        // DS 必改（J-9b）：非 ENOENT 读失败同样不许留可写空档——尝试改名隔离，
        // 失败即 poison 拒写（无原字节可 copy，此路不走复制隔离）。
        const corrupt = file + '.corrupt-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
        try { fs.renameSync(file, corrupt); try { log({ ev: 'profile-store-corrupt-isolated', file, corrupt, mode: 'rename-after-read-error', err: String(e && e.message || e) }); } catch (e2) {} }
        catch (e2) { poisonedFiles.add(file); try { log({ ev: 'profile-store-poisoned', file, err: String(e && e.message || e) }); } catch (e3) {} }
      }
      return fallback;
    }
    try { const v = JSON.parse(raw); if (v && typeof v === 'object' && !Array.isArray(v)) return v; throw new Error('台账顶层不是对象'); } catch (e) {
      // DS 必改（J-9b）：rename 隔离失败不许就此回落可写空档——原件还在原地，
      // 后续 save 会把它整文件覆盖。先 rename、失败转 copyFileSync 复制隔离并
      // 校验字节一致；再失败则把该文件 poison，saveJson 对它拒写（fail-closed），
      // 损坏原件永不被覆盖，待人工处理。
      const corrupt = file + '.corrupt-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
      let mode = null;
      try { fs.renameSync(file, corrupt); mode = 'rename'; } catch (e2) {
        try {
          fs.copyFileSync(file, corrupt);
          if (fs.readFileSync(corrupt, 'utf8') === raw) mode = 'copy';
        } catch (e3) {}
      }
      if (mode) {
        try { log({ ev: 'profile-store-corrupt-isolated', file, corrupt, mode, err: String(e && e.message || e) }); } catch (e2) {}
        try { console.error(JSON.stringify({ ev: 'profile-store-corrupt-isolated', file, corrupt, mode })); } catch (e2) {}
      } else {
        poisonedFiles.add(file);
        try { log({ ev: 'profile-store-poisoned', file, err: String(e && e.message || e) }); } catch (e2) {}
        try { console.error(JSON.stringify({ ev: 'profile-store-poisoned', file })); } catch (e2) {}
      }
      return fallback;
    }
  }
  const poisonedFiles = new Set(); // J-9b：隔离彻底失败的台账——拒写防覆盖（DS 必改）
  function saveJson(file, obj) {
    if (poisonedFiles.has(file)) throw new Error('profile store poisoned (corrupt isolation failed): ' + file);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file + '.tmp', JSON.stringify(obj, null, 1), { mode: 0o600 });
    fs.renameSync(file + '.tmp', file);
  }
  let profiles = loadJson(profilesFile, { users: {} });
  if (!profiles.users) profiles.users = {};
  let mod = loadJson(modFile, { seq: 0, items: [] });
  if (!Array.isArray(mod.items)) mod.items = [];
  // ---------- 启动对账（F1 修复）：头像字节与台账戳/摘要对齐 ----------
  // applyAvatar 是「先换文件、后写台账」两次写：进程在两步之间被杀会留下
  // 文件已是新图、台账仍是旧戳——旧版本 URL 会命中 immutable 吐新图。
  // 台账里存头像字节 sha256，启动时逐个核对：对不上＝文件比台账新，
  // 以文件为准补登新戳＋新摘要；台账说有头像但文件已失＝按已删除收口。
  // 无摘要的存量记录首次启动只补登摘要作基线（无法追溯既往错位）。
  // 本段必须在 avatarPathOf 定义之后执行（见下方 setNicknameDirect 后）。
  function sha256Hex(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
  const saveProfiles = () => saveJson(profilesFile, profiles);
  const saveMod = () => saveJson(modFile, mod);

  // ---------- 词库（热读论坛现行 words 文件；读不到回落打包兜底） ----------
  // F8 修复：文件删除/损坏时必须真回落兜底词库，不许沿用上次编译结果；
  // 损坏文件的 mtime 记下来避免每次调用重解析，文件修好（mtime 变）再重读。
  let wordsCache = { mtime: -1, compiled: null };
  let fallbackCompiled = null;
  function getFallbackCompiled() {
    if (!fallbackCompiled) fallbackCompiled = R.compileWords(wordsFallback || { categories: {}, whitelistDomains: [] });
    return fallbackCompiled;
  }
  function compiledWords() {
    if (wordsFile) {
      let st = null;
      try { st = fs.statSync(wordsFile); } catch (e) { st = null; }
      if (!st) { wordsCache = { mtime: -1, compiled: null }; return getFallbackCompiled(); }
      if (st.mtimeMs === wordsCache.mtime) {
        return wordsCache.compiled || getFallbackCompiled();
      }
      try {
        const db = JSON.parse(fs.readFileSync(wordsFile, 'utf8'));
        wordsCache = { mtime: st.mtimeMs, compiled: R.compileWords(db) };
        return wordsCache.compiled;
      } catch (e) {
        wordsCache = { mtime: st.mtimeMs, compiled: null };
        return getFallbackCompiled();
      }
    }
    return getFallbackCompiled();
  }
  // 昵称判定：与论坛 handleSetNickname 同管线（tier B 回大类、tier C 归轻度敏感）
  function evaluateNickname(nick) {
    const r = R.reviewContent({ title: '', body: nick }, compiledWords(), {});
    if (r.tier === 'B') return { usable: false, category: R.CATEGORIES[r.category] || '违规内容', rules: [r.detail] };
    if (r.tier === 'C') return { usable: false, category: '轻度敏感内容', rules: [r.detail] };
    return { usable: true, category: null, rules: [] };
  }

  // ---------- 图像审核供给收口（照 QFClash moderateImage：回形不对/抛错＝不可用） ----------
  async function moderateImage(bytes, mime) {
    if (typeof imageModFn !== 'function') return { available: false };
    try {
      const r = await imageModFn({ bytes, mime });
      if (!r || typeof r.usable !== 'boolean') return { available: false };
      return { available: true, usable: r.usable, category: r.category || '违规内容', rules: Array.isArray(r.rules) ? r.rules.map(String) : [] };
    } catch (e) { return { available: false }; }
  }

  // ---------- 档案基本面 ----------
  const avatarPathOf = (username) => path.join(avatarsDir, username + '.img');
  function recOf(username) { return profiles.users[username] || null; }
  function ensureRec(username) {
    if (!profiles.users[username]) profiles.users[username] = { nickname: null, avatarMime: null, avatarUpdatedAt: null, updatedAt: 0 };
    return profiles.users[username];
  }
  function viewOf(username) {
    const on = enabled();
    const rec = on ? recOf(username) : null;
    const hasAvatar = !!(rec && rec.avatarMime && rec.avatarUpdatedAt);
    return {
      username,
      displayName: (rec && rec.nickname) ? rec.nickname : username, // 生效显示名（§5.2 正本字段名）
      nickname: rec ? (rec.nickname || null) : null,
      effectiveNickname: (rec && rec.nickname) ? rec.nickname : username,
      defaultNickname: username,
      hasAvatar,
      avatarMime: hasAvatar ? rec.avatarMime : null,
      avatarUpdatedAt: hasAvatar ? rec.avatarUpdatedAt : null,
      avatarUrl: hasAvatar ? '/profile/' + encodeURIComponent(username) + '/avatar?v=' + rec.avatarUpdatedAt : null,
    };
  }
  function readAvatar(username, version) {
    if (!enabled()) return null;
    const rec = recOf(username);
    if (!rec || !rec.avatarMime || !rec.avatarUpdatedAt) return null;
    let bytes = null;
    try { bytes = fs.readFileSync(avatarPathOf(username)); } catch (e) { return null; }
    const match = version !== null && version !== undefined && String(version) === String(rec.avatarUpdatedAt);
    return {
      bytes, mime: rec.avatarMime, updatedAt: rec.avatarUpdatedAt,
      cacheControl: match ? 'public, max-age=31536000, immutable' : 'no-store',
    };
  }
  // 落头像（内容或删除）：版本戳单调递增（秒，照 QFClash applyAvatarBytes）
  function applyAvatar(username, bytes, mime, nowMs) {
    const rec = ensureRec(username);
    const nowSec = Math.floor(nowMs / 1000);
    const stamp = Math.max(nowSec, (rec.avatarUpdatedAt || 0) + 1);
    if (bytes === null) {
      try { fs.unlinkSync(avatarPathOf(username)); } catch (e) {}
      rec.avatarMime = null;
      rec.avatarSha = null;
    } else {
      const tmp = avatarPathOf(username) + '.tmp';
      fs.writeFileSync(tmp, bytes, { mode: 0o600 });
      fs.renameSync(tmp, avatarPathOf(username));
      rec.avatarMime = mime;
      rec.avatarSha = sha256Hex(bytes); // F1：与字节同批落台账，启动对账据此识别错位
    }
    rec.avatarUpdatedAt = stamp;
    rec.updatedAt = nowMs;
    saveProfiles();
    return rec;
  }
  function setNicknameDirect(username, nickname, nowMs) {
    const rec = ensureRec(username);
    rec.nickname = nickname || null;
    rec.updatedAt = nowMs;
    saveProfiles();
    return rec;
  }
  // F1 启动对账本体（avatarPathOf 已定义，此处执行）
  (function healAvatarLedger() {
    let dirty = false;
    for (const name of Object.keys(profiles.users)) {
      const rec = profiles.users[name];
      if (!rec || !rec.avatarMime) continue;
      let bytes = null;
      try { bytes = fs.readFileSync(avatarPathOf(name)); } catch (e) { bytes = null; }
      if (!bytes) {
        rec.avatarMime = null; rec.avatarSha = null; dirty = true;
        log({ ev: 'profile-avatar-heal', username: name, why: 'file-missing-cleared' });
        continue;
      }
      const sha = sha256Hex(bytes);
      if (!rec.avatarSha) { rec.avatarSha = sha; dirty = true; continue; }
      if (rec.avatarSha !== sha) {
        const nowSec = Math.floor(Date.now() / 1000);
        rec.avatarUpdatedAt = Math.max(nowSec, (rec.avatarUpdatedAt || 0) + 1);
        rec.avatarSha = sha; dirty = true;
        log({ ev: 'profile-avatar-heal', username: name, why: 'bytes-ahead-of-ledger-restamped' });
      }
    }
    if (dirty) { try { saveJson(profilesFile, profiles); } catch (e) {} }
  })();

  // ---------- 提交（DESIGN §5.2；顺序照 QFClash submitProfileMod） ----------
  function err(status, code, msg) { return { status, json: { ok: false, code, msg } }; }
  // F4 修复：头像分支要 await 图像审核，日限若只在 await 前查台账行数，
  // 并发请求会一起穿过闸门。用在途计数同步预留名额，await 结束即释放。
  const inflightSubmits = new Map(); // username -> 在途头像提交数
  const inflightOf = (u) => inflightSubmits.get(u) || 0;
  function inflightReserve(u) { inflightSubmits.set(u, inflightOf(u) + 1); }
  function inflightRelease(u) { const n = inflightOf(u) - 1; if (n > 0) inflightSubmits.set(u, n); else inflightSubmits.delete(u); }
  // F6 修复：saveMod 落盘失败时先重试一次；仍失败由调用方回滚内存态并回 500，
  // 不许出现「内存已裁定/已落行、磁盘仍旧态」的劈叉。
  function saveModOrThrow() {
    try { saveMod(); } catch (e) { saveMod(); }
  }
  async function submit(username, body, nowMs) {
    if (!enabled()) return err(403, 'PROFILE_DISABLED', '个人资料功能暂时关闭。');
    const st = accountStatus(username) || {};
    if (st.frozen || st.banned) {
      const what = body && Object.prototype.hasOwnProperty.call(body, 'avatar') && !Object.prototype.hasOwnProperty.call(body, 'nickname') ? '头像' : '昵称';
      return err(403, 'ACCOUNT_RESTRICTED', '您的账号已被冻结或封禁，无法修改' + what + '。申诉请联系官方客服，或前往官网留言。');
    }
    const hasNickname = !!(body && Object.prototype.hasOwnProperty.call(body, 'nickname'));
    const hasAvatar = !!(body && Object.prototype.hasOwnProperty.call(body, 'avatar'));
    if (hasNickname === hasAvatar) return err(400, 'VALIDATION', '一次只能提交一项：昵称或头像');
    const dayStart = shanghaiDayStartMs(nowMs);
    const todayCount = mod.items.filter((x) => x.username === username && x.createdAt >= dayStart).length;
    if (todayCount >= submitPerDay) return err(429, 'PROFILE_MOD_DAILY_LIMIT', '今天提交太多次了，请明天再试');

    if (hasNickname) {
      const nick = String(body.nickname || '').trim();
      if (!nick) { // 清除昵称：免审直生效、不留行（本站论坛现行口径）
        setNicknameDirect(username, null, nowMs);
        return { status: 200, json: { ok: true, kind: 'nickname', applied: true, reviewId: null, category: null, cleared: true, profile: viewOf(username) } };
      }
      if ([...nick].length > NICKNAME_MAX) return err(400, 'VALIDATION', '昵称最多 ' + NICKNAME_MAX + ' 字');
      const verdict = evaluateNickname(nick);
      const row = {
        id: 'pm_' + (++mod.seq), username, kind: 'nickname',
        status: verdict.usable ? 'approved' : 'rejected',
        category: verdict.usable ? null : verdict.category,
        hitRules: verdict.rules, nicknameSnapshot: nick,
        snapshotFile: null, snapshotMime: null,
        appealStatus: 'none', appealNote: null, appealReviewer: null, appealReason: null,
        appealedAt: null, decidedAt: null, appliedAt: verdict.usable ? nowMs : null,
        createdAt: nowMs, updatedAt: nowMs,
      };
      // F6：先落档案再落审核行；行落盘失败则回滚档案并摘行，不留劈叉态
      const prevNick = recOf(username) ? recOf(username).nickname : null;
      if (verdict.usable) setNicknameDirect(username, nick, nowMs);
      mod.items.push(row);
      try { saveModOrThrow(); } catch (e) {
        mod.items.splice(mod.items.indexOf(row), 1);
        if (verdict.usable) { try { setNicknameDirect(username, prevNick, nowMs); } catch (e2) {} }
        log({ ev: 'profile-mod-persist-failed', username, kind: 'nickname' });
        return err(500, 'PROFILE_PERSIST_FAILED', '系统繁忙，请稍后再试');
      }
      const json = { ok: true, kind: 'nickname', applied: verdict.usable, reviewId: row.id, category: row.category, profile: viewOf(username) };
      if (!verdict.usable) json.msg = '这个昵称不能用：包含' + row.category + '，请换一个';
      return { status: 200, json };
    }

    // 头像分支
    if (body.avatar === null) { // 删除头像：免审直生效、不留行
      applyAvatar(username, null, null, nowMs);
      return { status: 200, json: { ok: true, kind: 'avatar', applied: true, reviewId: null, category: null, deleted: true, profile: viewOf(username) } };
    }
    const mime = String((body.avatar && body.avatar.mime) || '');
    if (!AVATAR_MIMES.has(mime)) return err(400, 'VALIDATION', '头像只支持 PNG、JPG、WebP 或 GIF 图片');
    const bytes = decodeB64(body.avatar && body.avatar.dataBase64);
    if (!bytes || bytes.length === 0) return err(400, 'VALIDATION', '头像数据不对，请重新选择图片');
    if (bytes.length > AVATAR_MAX_BYTES) return err(400, 'AVATAR_TOO_LARGE', '头像太大了，请先压缩到 200KB 以内再上传');
    if (sniffImageMime(bytes) !== mime) return err(400, 'VALIDATION', '头像内容与所选图片格式不一致，请重新选择图片');
    // F4：await 审核前同步预留日限名额（与台账已落行数合并计数）
    if (todayCount + inflightOf(username) >= submitPerDay) return err(429, 'PROFILE_MOD_DAILY_LIMIT', '今天提交太多次了，请明天再试');
    inflightReserve(username);
    let verdict;
    try { verdict = await moderateImage(bytes, mime); } finally { inflightRelease(username); }
    if (!verdict.available) { // fail-closed：不落行、不生效、仅审计
      log({ ev: 'profile-mod-review-error', username, kind: 'avatar', why: 'moderator-unavailable' });
      return err(400, 'PROFILE_MOD_UNAVAILABLE', '系统繁忙，请稍后再试');
    }
    const row = {
      id: 'pm_' + (++mod.seq), username, kind: 'avatar',
      status: verdict.usable ? 'approved' : 'rejected',
      category: verdict.usable ? null : verdict.category,
      hitRules: verdict.rules, nicknameSnapshot: null,
      snapshotFile: null, snapshotMime: null,
      appealStatus: 'none', appealNote: null, appealReviewer: null, appealReason: null,
      appealedAt: null, decidedAt: null, appliedAt: verdict.usable ? nowMs : null,
      createdAt: nowMs, updatedAt: nowMs,
    };
    if (!verdict.usable) { // 驳回才留快照字节（供代审/本人申诉查看）
      row.snapshotFile = row.id + '.img'; row.snapshotMime = mime;
      const tmp = path.join(modAvatarsDir, row.snapshotFile + '.tmp');
      fs.writeFileSync(tmp, bytes, { mode: 0o600 });
      fs.renameSync(tmp, path.join(modAvatarsDir, row.snapshotFile));
    }
    // F6：先生效再落行；行落盘失败回滚头像（含摘行、删快照），不留劈叉态
    let prevAvatarBytes = null, prevAvatarMime = null;
    if (verdict.usable) {
      const recBefore = recOf(username);
      if (recBefore && recBefore.avatarMime) {
        try { prevAvatarBytes = fs.readFileSync(avatarPathOf(username)); prevAvatarMime = recBefore.avatarMime; } catch (e) {}
      }
      applyAvatar(username, bytes, mime, nowMs);
    }
    mod.items.push(row);
    try { saveModOrThrow(); } catch (e) {
      mod.items.splice(mod.items.indexOf(row), 1);
      if (verdict.usable) {
        try {
          if (prevAvatarBytes) applyAvatar(username, prevAvatarBytes, prevAvatarMime, nowMs);
          else applyAvatar(username, null, null, nowMs);
        } catch (e2) {}
      }
      if (row.snapshotFile) { try { fs.unlinkSync(path.join(modAvatarsDir, row.snapshotFile)); } catch (e2) {} }
      log({ ev: 'profile-mod-persist-failed', username, kind: 'avatar' });
      return err(500, 'PROFILE_PERSIST_FAILED', '系统繁忙，请稍后再试');
    }
    return { status: 200, json: { ok: true, kind: 'avatar', applied: verdict.usable, reviewId: row.id, category: row.category, profile: viewOf(username) } };
  }

  // ---------- 本人记录 / 申诉 / 代审 ----------
  function reviewView(r) {
    return {
      id: r.id, kind: r.kind, status: r.status, category: r.category,
      nickname: r.kind === 'nickname' ? r.nicknameSnapshot : null,
      hasSnapshot: !!r.snapshotFile,
      appealStatus: r.appealStatus, appealReason: r.appealReason,
      appliedAt: r.appliedAt, decidedAt: r.decidedAt, createdAt: r.createdAt,
    };
  }
  function listRecords(username, limit) {
    return mod.items.filter((x) => x.username === username).slice(-Math.min(50, limit || 50)).reverse().map(reviewView);
  }
  function appeal(username, id, note, nowMs) {
    const row = mod.items.find((x) => x.id === id);
    if (!row || row.username !== username) return err(404, 'NOT_FOUND', '这条审核记录不存在');
    if (row.status !== 'rejected') return err(409, 'PROFILE_APPEAL_NOT_ALLOWED', '这条记录不能申诉');
    if (row.appealStatus !== 'none') return err(409, 'PROFILE_APPEAL_EXISTS', '这条记录已经申诉过了');
    // F3：头像快照已被超期清理的行不许再申诉（否则批准必因快照缺失失败、行永挂 pending）
    if (row.kind === 'avatar' && !row.snapshotFile) return err(409, 'PROFILE_SNAPSHOT_GONE', '申诉快照已过期清理，无法申诉，请重新提交');
    const text = String(note || '').trim();
    if ([...text].length > APPEAL_NOTE_MAX) return err(400, 'VALIDATION', '申诉说明最多 ' + APPEAL_NOTE_MAX + ' 字');
    // F2/S4：记下申诉时点的现行值作基线，批准补生效前比对（见 decideAppeal）
    const cur = recOf(username);
    // C3-04：与 F6 同口径收口——改行前快照六字段，落盘失败回滚内存态并回 500，不留内存/磁盘劈叉
    const prevAppeal = { baseNickname: row.baseNickname, baseAvatarUpdatedAt: row.baseAvatarUpdatedAt, appealStatus: row.appealStatus, appealNote: row.appealNote, appealedAt: row.appealedAt, updatedAt: row.updatedAt };
    row.baseNickname = cur ? (cur.nickname || null) : null;
    row.baseAvatarUpdatedAt = cur ? (cur.avatarUpdatedAt || null) : null;
    row.appealStatus = 'pending'; row.appealNote = text || null; row.appealedAt = nowMs; row.updatedAt = nowMs;
    try { saveModOrThrow(); } catch (e) {
      Object.assign(row, prevAppeal);
      log({ ev: 'profile-mod-persist-failed', username, recordId: row.id, kind: row.kind });
      return err(500, 'PROFILE_PERSIST_FAILED', '系统繁忙，请稍后再试');
    }
    if (events) events.enqueue('profile_mod', row.id, { username, kind: row.kind, category: row.category, recordId: row.id });
    log({ ev: 'profile-mod-appeal', username, recordId: row.id, kind: row.kind });
    return { status: 200, json: { ok: true, reviewId: row.id, appealStatus: 'pending' } };
  }
  function getRecordView(id) {
    const r = mod.items.find((x) => x.id === id);
    if (!r) return null;
    // 审核侧视图：昵称附原文供裁定（头像原文走快照端点取字节）
    return Object.assign(reviewView(r), { username: r.username, appealNote: r.appealNote, appealedAt: r.appealedAt, snapshotText: r.kind === 'nickname' ? (r.nicknameSnapshot || null) : null });
  }
  function pendingAppeals(limit) {
    return mod.items.filter((x) => x.appealStatus === 'pending')
      .sort((a, b) => (a.appealedAt - b.appealedAt) || (a.createdAt - b.createdAt))
      .slice(0, Math.min(50, limit || 50))
      .map((r) => Object.assign(reviewView(r), { username: r.username, appealNote: r.appealNote, appealedAt: r.appealedAt }));
  }
  function getSnapshot(id) {
    const row = mod.items.find((x) => x.id === id);
    if (!row || !row.snapshotFile) return null;
    try { return { bytes: fs.readFileSync(path.join(modAvatarsDir, row.snapshotFile)), mime: row.snapshotMime || 'application/octet-stream' }; }
    catch (e) { return null; }
  }
  // 代审核心（助手接口与站长后台共用一份，照 QFClash reviewProfileAppealCore）
  function decideAppeal(id, decision, reason, actor, nowMs) {
    const row = mod.items.find((x) => x.id === id);
    if (!row) return err(404, 'NOT_FOUND', '这条申诉不存在');
    if (row.appealStatus !== 'pending') return err(409, 'ALREADY_DECIDED', '这条申诉已经处理过了');
    if (decision === 'approve') {
      // F2/S4：申诉后现行值已被更新（本人改了新值/改名合并时目标自有值优先）→
      // 旧快照不许再覆盖，留行待裁定人改判驳回并说明。无基线的存量行不拦。
      const cur = recOf(row.username);
      if (row.kind === 'nickname' && row.baseNickname !== undefined && ((cur && cur.nickname) || null) !== (row.baseNickname || null)) {
        return err(409, 'PROFILE_APPEAL_SUPERSEDED', '该账号的昵称在申诉后已有新的变更，这条申诉不能再补生效，请驳回并说明原因');
      }
      if (row.kind === 'avatar' && row.baseAvatarUpdatedAt !== undefined && ((cur && cur.avatarUpdatedAt) || null) !== (row.baseAvatarUpdatedAt || null)) {
        return err(409, 'PROFILE_APPEAL_SUPERSEDED', '该账号的头像在申诉后已有新的变更，这条申诉不能再补生效，请驳回并说明原因');
      }
      // J-9a（发版前全量审立项＋DS 必改口径）：补生效先落档案、后落审核行，
      // 落行失败必须连档案一起退。DS 三点收紧：①头像旧字节备份必须成功，
      // 读不到即中止裁定、不许带残缺备份硬上；②回滚不许写回旧 avatarUpdatedAt
      // （会破坏版本戳单调递增、让旧 immutable URL 命中新内容）——业务态
      // （昵称/头像 mime/sha/字节）退回裁定前，版本戳用独立发号重新发放
      // （>补生效时发出的戳），并同步修正本行 baseAvatarUpdatedAt 防再裁被
      // SUPERSEDED 误拦（注：行落盘失败时磁盘上的 base 仍是旧值，重启后
      // 再裁会保守地被守卫拦下、需驳回说明，不产生错生效）；③回滚落盘
      // 失败不许吞——显式 log 告警并回 PROFILE_ROLLBACK_FAILED 与普通
      // 落盘失败区分，待人工对账。
      const prevRec = recOf(row.username) ? JSON.parse(JSON.stringify(recOf(row.username))) : null;
      let snap = null;
      if (row.kind === 'avatar') {
        snap = getSnapshot(row.id);
        if (!snap) return err(409, 'PROFILE_SNAPSHOT_GONE', '申诉快照已过期清理，无法补生效，请让用户重新提交');
      }
      let prevAvatarBytes = null;
      if (row.kind === 'avatar' && prevRec && prevRec.avatarMime) {
        try { prevAvatarBytes = fs.readFileSync(avatarPathOf(row.username)); }
        catch (e) {
          log({ ev: 'profile-mod-backup-failed', recordId: row.id, username: row.username, err: String(e && e.message || e) });
          return err(500, 'PROFILE_PERSIST_FAILED', '系统繁忙，请稍后再试');
        }
      }
      if (row.kind === 'nickname') {
        setNicknameDirect(row.username, row.nicknameSnapshot, nowMs);
      } else {
        applyAvatar(row.username, snap.bytes, snap.mime, nowMs);
      }
      const appliedStamp = row.kind === 'avatar' ? ((recOf(row.username) || {}).avatarUpdatedAt || 0) : null;
      row.appealStatus = 'approved'; row.appealReviewer = actor || null; row.appealReason = null;
      row.decidedAt = nowMs; row.appliedAt = nowMs; row.updatedAt = nowMs;
      // F6：落盘失败（含重试）→ 回滚内存裁定态，行保持 pending 可再裁，不劈叉
      try { saveModOrThrow(); } catch (e) {
        row.appealStatus = 'pending'; row.appealReviewer = null; row.decidedAt = null; row.appliedAt = null; row.updatedAt = nowMs;
        let rollbackFailed = false;
        try {
          if (row.kind === 'nickname') {
            if (prevRec) {
              const rec = ensureRec(row.username);
              rec.nickname = prevRec.nickname; rec.updatedAt = prevRec.updatedAt;
            } else { delete profiles.users[row.username]; }
            saveProfiles();
          } else {
            const stampNew = Math.max(Math.floor(nowMs / 1000), (appliedStamp || 0) + 1);
            const rec = prevRec ? JSON.parse(JSON.stringify(prevRec)) : { nickname: null, avatarMime: null, avatarUpdatedAt: null, avatarSha: null, updatedAt: 0 };
            if (prevAvatarBytes) {
              const tmp = avatarPathOf(row.username) + '.tmp';
              fs.writeFileSync(tmp, prevAvatarBytes, { mode: 0o600 });
              fs.renameSync(tmp, avatarPathOf(row.username));
            } else {
              try { fs.unlinkSync(avatarPathOf(row.username)); } catch (e2) {}
              rec.avatarMime = null; rec.avatarSha = null;
            }
            rec.avatarUpdatedAt = stampNew; // 独立发号：不退旧戳，单调递增不破
            rec.updatedAt = nowMs;
            profiles.users[row.username] = rec;
            row.baseAvatarUpdatedAt = stampNew; // 同步基线，再裁不被 SUPERSEDED 误拦
            saveProfiles();
          }
        } catch (e2) { rollbackFailed = true; }
        if (rollbackFailed) {
          log({ ev: 'profile-mod-rollback-FAILED', recordId: row.id, username: row.username, kind: row.kind });
          return err(500, 'PROFILE_ROLLBACK_FAILED', '系统繁忙，请稍后再试');
        }
        log({ ev: 'profile-mod-persist-failed', recordId: row.id, where: 'decideAppeal' });
        return err(500, 'PROFILE_PERSIST_FAILED', '系统繁忙，请稍后再试');
      }
      if (events) events.resolve('profile_mod', row.id, actor, 'appeal-approve');
      log({ ev: 'profile-mod-appeal-decided', recordId: row.id, decision, actor, username: row.username, kind: row.kind });
      return { status: 200, json: { ok: true, reviewId: row.id, appealStatus: 'approved', applied: true } };
    }
    if (decision === 'reject') {
      const r = String(reason || '').trim();
      if (!r) return err(400, 'VALIDATION', '驳回申诉要写明理由');
      row.appealStatus = 'rejected'; row.appealReviewer = actor || null; row.appealReason = r;
      row.decidedAt = nowMs; row.updatedAt = nowMs;
      try { saveModOrThrow(); } catch (e) {
        row.appealStatus = 'pending'; row.appealReviewer = null; row.appealReason = null; row.decidedAt = null; row.updatedAt = nowMs;
        log({ ev: 'profile-mod-persist-failed', recordId: row.id, where: 'decideAppeal-reject' });
        return err(500, 'PROFILE_PERSIST_FAILED', '系统繁忙，请稍后再试');
      }
      if (events) events.resolve('profile_mod', row.id, actor, 'appeal-reject');
      log({ ev: 'profile-mod-appeal-decided', recordId: row.id, decision, actor, username: row.username, kind: row.kind });
      return { status: 200, json: { ok: true, reviewId: row.id, appealStatus: 'rejected', applied: false } };
    }
    return err(400, 'VALIDATION', '审核结论不正确');
  }

  // ---------- 站长处置（只动 nickname/avatar 两字段，写审计由调用方 log 补记） ----------
  function adminReset(username, opts, nowMs) {
    const out = { ok: true, username, resetNickname: !!opts.resetNickname, resetAvatar: !!opts.resetAvatar };
    if (opts.resetNickname) setNicknameDirect(username, null, nowMs);
    if (opts.resetAvatar) applyAvatar(username, null, null, nowMs);
    log({ ev: 'profile-admin-reset', username, resetNickname: out.resetNickname, resetAvatar: out.resetAvatar });
    return out;
  }

  // ---------- 改名挂钩（DESIGN §5.8 必做）：档案键＋头像文件＋审核行跟随 ----------
  function migrateProfile(oldName, newName) {
    const out = { movedProfile: false, movedAvatar: false, modRows: 0, forumShadow: 'n/a' };
    if (!oldName || !newName || oldName === newName || !NAME_RE.test(newName)) return out;
    // F6：先迁审核行并落盘，再迁档案——中途崩溃时行已指向新名，申诉补生效只会
    // 在新名下建档收敛，绝不会把内容写回旧名、给日后同名新注册者留下残留档案。
    for (const row of mod.items) if (row.username === oldName) { row.username = newName; out.modRows += 1; }
    if (out.modRows) saveMod();
    const oldRec = profiles.users[oldName];
    const tgtBefore = profiles.users[newName];
    const tgtHadAvatar = !!(tgtBefore && tgtBefore.avatarMime);
    if (oldRec) {
      const tgt = profiles.users[newName];
      if (!tgt) { profiles.users[newName] = oldRec; }
      else { // 目标已有档案：只补目标缺的字段，不覆盖目标自有值
        if (!tgt.nickname && oldRec.nickname) tgt.nickname = oldRec.nickname;
        if (!tgt.avatarMime && oldRec.avatarMime) { tgt.avatarMime = oldRec.avatarMime; tgt.avatarUpdatedAt = oldRec.avatarUpdatedAt; tgt.avatarSha = oldRec.avatarSha || null; out.movedAvatar = true; }
      }
      delete profiles.users[oldName];
      out.movedProfile = true;
      saveProfiles();
    }
    const oldPath = avatarPathOf(oldName), newPath = avatarPathOf(newName);
    try {
      if (fs.existsSync(oldPath) && !fs.existsSync(newPath)) { fs.renameSync(oldPath, newPath); out.movedAvatar = true; }
      else if (fs.existsSync(oldPath) && fs.existsSync(newPath) && !tgtHadAvatar) {
        // F7：目标无档案头像但有孤儿文件——字段已按旧号补入，文件必须跟随字段，
        // 用旧号文件覆盖孤儿文件，禁止出现「字段是 A 的、字节是孤儿的」错配。
        fs.renameSync(oldPath, newPath); out.movedAvatar = true;
      } else if (fs.existsSync(oldPath) && fs.existsSync(newPath)) {
        // 目标自有头像优先：旧号文件删除，不留孤儿（防日后同名注册者误挂）
        try { fs.unlinkSync(oldPath); } catch (e) {}
      }
    } catch (e) { log({ ev: 'profile-migrate-avatar-error', oldName, newName, err: String(e && e.message) }); }
    log({ ev: 'profile-migrated', oldName, newName, movedProfile: out.movedProfile, movedAvatar: out.movedAvatar, modRows: out.modRows });
    return out;
  }

  // ---------- 存量导入（论坛影子昵称一次性导入，S2 脚本共用同一逻辑） ----------
  function importNicknames(forumProfiles) {
    // J-9c（发版前全量审立项）：与脚本版 import-nicknames.js 同口径，禁止漂移——
    // 账号键先 toLowerCase 归一（ext 全部查键路径均小写）、键白名单
    // （归一后小写集，与脚本 ACCOUNT_KEY_RE 一致）、__proto__/constructor/
    // prototype 原型键显式拒绝、读写一律 hasOwnProperty 语义，杜绝原型污染
    // 与记录静默丢失；被拒键进 skippedInvalid、归一映射进 normalized。
    const out = { imported: [], skippedExisting: [], skippedInvalid: [], normalized: {}, total: 0 };
    let migrated = false;
    for (const rawName of Object.keys(forumProfiles || {})) {
      const rawNick = forumProfiles[rawName] && forumProfiles[rawName].nickname;
      const nick = typeof rawNick === 'string' ? rawNick.trim() : '';
      if (!nick) continue;
      out.total += 1;
      const key = String(rawName).toLowerCase();
      if (IMPORT_DENY_KEYS.has(key) || !IMPORT_KEY_RE.test(key)) { out.skippedInvalid.push(rawName); continue; }
      if (key !== rawName) out.normalized[rawName] = key;
      // DS 必改（J-9c）：存量档案可能已有同名不同大小写的键——ext 全部查键
      // 路径均小写，记录留在大写键上等于不可达。先把存量键迁到归一键：
      // 小写键不存在→整条记录迁过去删旧键；两键都在→缺失字段（昵称/头像）
      // 由旧键合并进小写键后删旧键。迁移也算变更、须落盘（见下方 saveNeeded）。
      const legacyKey = Object.keys(profiles.users).find((k) => k !== key && k.toLowerCase() === key);
      if (legacyKey) {
        if (!Object.prototype.hasOwnProperty.call(profiles.users, key)) {
          profiles.users[key] = profiles.users[legacyKey];
        } else {
          const low = profiles.users[key], leg = profiles.users[legacyKey];
          if (low && leg && typeof low === 'object' && typeof leg === 'object') {
            if (!low.nickname && leg.nickname) low.nickname = leg.nickname;
            if (!low.avatarMime && leg.avatarMime) { low.avatarMime = leg.avatarMime; low.avatarUpdatedAt = leg.avatarUpdatedAt; low.avatarSha = leg.avatarSha || null; }
          }
        }
        delete profiles.users[legacyKey];
        out.normalized[legacyKey] = key;
        migrated = true;
      }
      const rec = Object.prototype.hasOwnProperty.call(profiles.users, key) ? profiles.users[key] : null;
      if (rec && rec.nickname) { out.skippedExisting.push(key); continue; }
      ensureRec(key).nickname = nick;
      profiles.users[key].updatedAt = Date.now();
      out.imported.push(key);
    }
    if (out.imported.length || migrated) saveProfiles();
    return out;
  }

  // ---------- 快照保留期清理（结案/超期 30 天删字节、行保留） ----------
  function cleanupSnapshots(nowMs) {
    let n = 0;
    for (const row of mod.items) {
      if (!row.snapshotFile) continue;
      const closedAt = row.appealStatus === 'approved' || row.appealStatus === 'rejected' ? (row.decidedAt || 0) : (row.appealStatus === 'none' ? row.createdAt : 0);
      if (closedAt && nowMs - closedAt > SNAPSHOT_RETENTION_MS) {
        try { fs.unlinkSync(path.join(modAvatarsDir, row.snapshotFile)); } catch (e) {}
        row.snapshotFile = null; row.snapshotExpired = true; n += 1; // F3：申诉入口据此拦下
      }
    }
    if (n) saveMod();
    return n;
  }

  return {
    enabled, viewOf, readAvatar,
    submit, listRecords, appeal, pendingAppeals, getRecordView, getSnapshot, decideAppeal,
    adminReset, migrateProfile, importNicknames, cleanupSnapshots,
    evaluateNickname,
    _files: { profilesFile, modFile, avatarsDir, modAvatarsDir },
  };
}

module.exports = {
  createProfileCore,
  AVATAR_MAX_BYTES, AVATAR_MIMES, NICKNAME_MAX, APPEAL_NOTE_MAX,
  decodeB64, sniffImageMime, shanghaiDayStartMs,
};
