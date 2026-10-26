'use strict';
/*
 * QFRemote 许可核心（阶段 C-2，2.3.1 付费密钥体系）
 * ================================================================
 * 单一数据源、单写者：许可/密钥/封禁/订单/设备映射/注册成功台账只存
 * /opt/qfremote-license/ 一处，唯一写者＝扩展服务进程内的本模块。
 * loginshim / register-svc 只经 127.0.0.1 内网接口（密钥文件鉴权）读写。
 *
 * 密钥记录三维拆分（整改表 R-04）：
 *  lifecycle 生命周期维：unactivated | activated | expired | revoked
 *  link      账号联动维：normal | frozen | banned（只随账号状态变）
 *  timing    计时维（按天专属）：none | active | paused | exhausted
 * 暂停计时纯事件驱动（R-05 秒级）：进入暂停落盘 pauseStartMs，退出时把
 * 暂停时长累计进 pausedAccumMs；无任何人工拨动入口。
 * 密钥串全局唯一（R-01）：state.keyStrHashes 保存全部历史串的 sha256，
 * 生成冲突自动重试；退役串永久留档、永不再生成。
 * 密钥原文只存于 state.json（0600）；日志/镜像一律掩码。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PLANS = {
  trial: { id: 'trial', name: 'QFRemote 试用套餐', price: 0, days: 3 },
  permanent: { id: 'permanent', name: 'QFRemote 永久套餐', price: 18, days: null },
  d30: { id: 'd30', name: 'QFRemote 30日套餐', price: 9.9, days: 30 },
  d7: { id: 'd7', name: 'QFRemote 7日套餐', price: 6, days: 7 },
  d1: { id: 'd1', name: 'QFRemote 1日套餐', price: 2, days: 1 },
};
const KEY_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // 大写字母+数字，去易混字符
const OWNER_EMAIL = 'a718983610@gmail.com';

function dayKey(ms) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}
function startOfDayMs(dk) { return Date.parse(dk + 'T00:00:00+08:00'); }
function fmtShanghai(ms) {
  if (!ms) return '';
  try { return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: 'numeric', day: 'numeric' }).format(new Date(ms)); }
  catch (e) { return ''; }
}
// 用户面日期（X 年 X 月 X 日，与 loginshim/双壳口径一致）
function fmtDateCn(ms) {
  if (!ms) return '';
  try { return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: 'long', day: 'numeric' }).format(new Date(ms)); }
  catch (e) { return ''; }
}
function maskKey(str) {
  if (!str) return '—';
  const parts = String(str).split('-');
  if (parts.length !== 5) return '•••••';
  return parts[0] + '-•••••-•••••-•••••-' + parts[4];
}
function sha(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }

// ---------- 设备槽位（站长 2026-10-25 21:03 决策 #26 改定：一密钥可绑
// 两台电脑＋一部手机，原为一台电脑） ----------
// 存储形状：slots.pc＝设备码哈希数组（数组顺序＝绑定顺序，最早绑的在前），
// slots.mobile＝单值哈希|null。旧存量 state.json 中 pc 为字符串/null，
// 加载时由 migrateSlots 无损迁移（字符串→单元素数组、null→空数组）。
const SLOT_CAPS = { pc: 2, mobile: 1 };
function emptySlots() { return { pc: [], mobile: null }; }
function slotList(k, slot) {
  if (!k || !k.slots) return [];
  const v = k.slots[slot];
  if (Array.isArray(v)) return v.filter(Boolean);
  return v ? [v] : [];
}
function slotHas(k, slot, hash) { return !!hash && slotList(k, slot).includes(hash); }
function slotCount(k, slot) { return slotList(k, slot).length; }
function slotAnyBound(k) { return slotCount(k, 'pc') > 0 || slotCount(k, 'mobile') > 0; }
function migrateSlots(k) {
  if (!k || typeof k !== 'object') return false;
  if (!k.slots || typeof k.slots !== 'object') { k.slots = emptySlots(); return true; }
  let changed = false;
  const pc = k.slots.pc;
  if (!Array.isArray(pc)) { k.slots.pc = pc ? [pc] : []; changed = true; }
  else { const f = pc.filter(Boolean); if (f.length !== pc.length) { k.slots.pc = f; changed = true; } }
  if (Array.isArray(k.slots.mobile)) { k.slots.mobile = k.slots.mobile[0] || null; changed = true; }
  if (k.slots.mobile === undefined) { k.slots.mobile = null; changed = true; }
  return changed;
}
function slotAdd(k, slot, hash) {
  migrateSlots(k);
  if (slot === 'mobile') { k.slots.mobile = hash; return; }
  if (!k.slots.pc.includes(hash)) k.slots.pc.push(hash);
}
// 换绑替换（#26 红线）：同类槽位中最早绑定的那台被替换，新设备追加到
// 绑定顺序末尾；mobile 单值直接替换。返回被替换设备的哈希。
function slotReplaceEarliest(k, slot, hash) {
  migrateSlots(k);
  if (slot === 'mobile') { const old = k.slots.mobile; k.slots.mobile = hash; return old; }
  const old = k.slots.pc.length ? k.slots.pc[0] : null;
  k.slots.pc = k.slots.pc.slice(1); k.slots.pc.push(hash);
  return old;
}

function defaultState() {
  return {
    version: 1,
    accounts: {},      // username -> {username, createdAt, legacy, trial:{startDay, expiresMs}|null, contactEmail}
    keys: {},          // keyId -> key record
    keyStrHashes: {},  // sha256(full string) -> keyId（全部历史串，含退役）
    bans: [],          // 统一封禁台账（只追加状态回写，不删）
    orders: {},        // orderId -> order
    grantsByOrder: {}, // orderId -> 发钥幂等记录（FIX-B1-4：与发放同表同 save 落盘，重试按此查重回原钥）
    deviceAccounts: {},// deviceCodeHash -> {accounts:[], banned:false, platform}
    regLedger: { byDevice: {}, byIp: {} }, // deviceHash/ip -> {username, at}
    bindAbuse: {},     // username -> {attempts:[ms], offenses:n}
    deviceReviews: [], // B6 设备异常待审记录（16:53 裁决：不即时永封，进审核队列）
    transfers: [],     // 密钥转赠记录（每把仅一次）
    shadowEvents: [],  // 影子模式拟处置记录（最多留 500 条）
    audit: [],         // 状态查询/验密审计（R-06，最多留 1000 条）
  };
}

function createLicenseCore(opts) {
  const dir = (opts && opts.dir) || '/opt/qfremote-license';
  const stateFile = path.join(dir, 'state.json');
  const configFile = path.join(dir, 'config.json');
  const bansLog = path.join(dir, 'bans.jsonl');
  const mailQueue = path.join(dir, 'mail-queue.jsonl');
  const mirrorFile = (opts && opts.mirrorFile) || '/opt/qfremote-friends/data/provider-mirror/license/status.json';
  let state = defaultState();
  try { const v = JSON.parse(fs.readFileSync(stateFile, 'utf8')); if (v && v.version === 1) state = Object.assign(defaultState(), v); } catch (e) {}
  // #26 存量迁移：旧 state.json 里 slots.pc 为单值字符串/null 的记录，
  // 加载时无损迁为数组（已绑设备一个不丢），下次 save() 即以新形状落盘。
  for (const k of Object.values(state.keys)) migrateSlots(k);

  function readConfig() {
    const dflt = { shadow: true, testUsers: [], payEnabled: false, simPayEnabled: false, b10WindowMs: 600000, b10Threshold: 3, transferTtlMs: 72 * 3600000 };
    try { return Object.assign(dflt, JSON.parse(fs.readFileSync(configFile, 'utf8'))); } catch (e) { return dflt; }
  }
  function save() {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = stateFile + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 1), { mode: 0o600 });
    fs.renameSync(tmp, stateFile);
    writeMirror();
  }
  function appendLine(file, obj) { try { fs.appendFileSync(file, JSON.stringify(obj) + '\n', { mode: 0o600 }); } catch (e) {} }
  // 客服只读镜像：掩码级公开状态（无密钥原文、无判定细节）
  function writeMirror() {
    try {
      const out = {};
      for (const u of Object.keys(state.accounts)) {
        const v = buildStatusView(u, Date.now());
        out[u] = { displayStatus: v.displayStatus, planName: v.planName, maskedKey: v.maskedKey, trialExpiresMs: v.trialExpiresMs, keyExpiresMs: v.keyExpiresMs, webEnabled: v.webEnabled, everBanned: v.everBanned, activeBanCode: v.activeBan ? v.activeBan.code : null };
      }
      fs.mkdirSync(path.dirname(mirrorFile), { recursive: true });
      const tmp = mirrorFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(out), { mode: 0o640 });
      fs.renameSync(tmp, mirrorFile);
      try { const pw = fs.readFileSync('/etc/passwd', 'utf8').split('\n').find((l) => l.startsWith('qffriends:')); if (pw) { const f = pw.split(':'); fs.chownSync(mirrorFile, Number(f[2]), Number(f[3])); } } catch (e) {}
    } catch (e) {}
  }
  function queueOwnerMail(subject, bodyObj) {
    appendLine(mailQueue, { at: new Date().toISOString(), to: OWNER_EMAIL, subject, body: bodyObj, status: 'queued' });
  }
  function shadowLog(ev) {
    state.shadowEvents.push(Object.assign({ at: Date.now() }, ev));
    if (state.shadowEvents.length > 500) state.shadowEvents = state.shadowEvents.slice(-500);
  }
  function enforceFor(cfg, usernames) {
    if (!cfg.shadow) return true;
    return usernames.every((u) => cfg.testUsers.includes(u));
  }

  // ---------- 账号与试用 ----------
  function ensureAccount(username, now, meta) {
    let a = state.accounts[username];
    if (!a) {
      a = { username, createdAt: now, legacy: !(meta && meta.fromRegister), trial: null, contactEmail: (meta && meta.email) || null };
      if (meta && meta.fromRegister) {
        // 计时口径（站长 16:53 裁决）：试用＝注册时刻起满 72 小时（自然日口径作废）
        a.trial = { startAt: now, expiresMs: now + 72 * 3600000 };
      }
      state.accounts[username] = a;
    }
    return a;
  }
  function accountKeys(username) { return Object.values(state.keys).filter((k) => k.username === username); }
  function activeKeys(username, now) {
    return accountKeys(username).filter((k) => (k.lifecycle === 'unactivated' || k.lifecycle === 'activated') && effectiveExpiry(k, now) > now);
  }
  function effectiveExpiry(k, now) {
    if (!k.expiresBaseMs) return Infinity;
    let exp = k.expiresBaseMs + (k.pausedAccumMs || 0);
    if (k.timing === 'paused' && k.pauseStartMs) exp += (now - k.pauseStartMs);
    return exp;
  }
  // 激活（裁决批⑥）：生命周期转 activated；仅首次激活（activatedAt 为空）
  // 才落计时起点——到期点＝激活时刻＋（套餐天数＋叠加未起算天数 extraDays）
  // ×24 小时。已激活过的密钥（转赠领取后回未激活再绑定等）activatedAt
  // 已在，沿原到期点续行，剩余时效不重置（17:04 口径不变）。
  function activateKey(k, now) {
    if (k.lifecycle === 'unactivated') k.lifecycle = 'activated';
    if (k.activatedAt == null) {
      k.activatedAt = now;
      const plan = PLANS[k.plan];
      if (plan && plan.days) {
        const days = plan.days + (k.extraDays || 0);
        k.extraDays = 0;
        k.expiresBaseMs = now + days * 86400000;
        k.timing = 'active';
      }
    }
  }
  // 「密钥已过期」提示带到期日期（裁决批①）：G5/L14 与粘贴领取过期分支共用
  function expiredText(k, now) {
    const exp = k && k.expiresBaseMs ? effectiveExpiry(k, now) : null;
    return exp ? ('密钥已过期，已于 ' + fmtDateCn(exp) + ' 到期。') : '密钥已过期。';
  }
  // 未起算密钥的剩余秒数（全额：套餐天数＋未起算叠加天数），回收/作废留档用
  function unstartedRemainingSec(k) {
    const plan = PLANS[k.plan];
    return (((plan && plan.days) || 0) + (k.extraDays || 0)) * 86400;
  }
  // 主密钥选择（裁决批⑤）：永久优先，其次剩余时长最长（未激活未起算＝
  // Infinity 视为最长），再按创建时间新者优先。供状态视图与 /me 展示。
  function primaryKeyOf(keys, now) {
    const live = keys.filter((k) => k.lifecycle === 'unactivated' || k.lifecycle === 'activated');
    const pool = live.length ? live : keys;
    return pool.slice().sort((a, b) => {
      const pa = a.plan === 'permanent' ? 1 : 0, pb = b.plan === 'permanent' ? 1 : 0;
      if (pa !== pb) return pb - pa;
      const ea = effectiveExpiry(a, now), eb = effectiveExpiry(b, now);
      if (ea !== eb) return eb - ea;
      return b.createdAt - a.createdAt;
    })[0] || null;
  }

  // ---------- 封禁台账 ----------
  function activeBansFor(username, now) {
    return state.bans.filter((b) => b.status === 'active' && b.targetType === 'account' && b.target === username && (!b.endsAt || b.endsAt > now));
  }
  function activeDeviceBan(deviceCodeHash, now) {
    return state.bans.find((b) => b.status === 'active' && b.targetType === 'device' && b.target === deviceCodeHash && (!b.endsAt || b.endsAt > now)) || null;
  }
  function expireBans(now) {
    let changed = false;
    for (const b of state.bans) {
      if (b.status === 'active' && b.endsAt && b.endsAt <= now) { b.status = 'expired'; b.liftedAt = now; b.liftedBy = 'auto-expire'; changed = true; }
    }
    if (changed) for (const u of Object.keys(state.accounts)) syncAccountLinkage(u, now);
    return changed;
  }
  // 联动：link 维 + 暂停计时（纯事件/到期驱动，无人工入口）
  function syncAccountLinkage(username, now) {
    const bans = activeBansFor(username, now);
    const hasPerm = bans.some((b) => b.permanent);
    const hasTimed = bans.some((b) => !b.permanent);
    const link = hasPerm || bans.some((b) => ['B6', 'B7', 'B9'].includes(b.code)) ? 'banned' : (bans.length ? 'frozen' : 'normal');
    for (const k of accountKeys(username)) {
      if (k.lifecycle === 'expired' || k.lifecycle === 'revoked') continue;
      k.link = hasPerm ? 'banned' : link;
      if (k.expiresBaseMs) {
        if (hasTimed && !hasPerm && k.timing === 'active') { k.timing = 'paused'; k.pauseStartMs = now; }
        else if (!hasTimed && k.timing === 'paused') { k.pausedAccumMs = (k.pausedAccumMs || 0) + (now - (k.pauseStartMs || now)); k.pauseStartMs = null; k.timing = 'active'; }
      }
    }
  }
  function applyBan(input, now) {
    // input: {targetType, target, code, permanent, days, actor, evidence}
    const ban = {
      id: 'ban_' + crypto.randomBytes(6).toString('hex'),
      targetType: input.targetType, target: input.target, code: input.code,
      permanent: !!input.permanent,
      startsAt: now, endsAt: input.permanent ? null : (input.endsAt !== undefined ? input.endsAt : (input.days ? now + input.days * 86400000 : null)),
      status: 'active', actor: input.actor || 'system', evidence: String(input.evidence || '').slice(0, 300),
      appealId: null, liftedAt: null, liftedBy: null,
    };
    state.bans.push(ban);
    appendLine(bansLog, { ev: 'ban-applied', id: ban.id, targetType: ban.targetType, target: ban.targetType === 'device' ? ban.target.slice(0, 12) : ban.target, code: ban.code, permanent: ban.permanent, endsAt: ban.endsAt, actor: ban.actor, at: now });
    if (ban.targetType === 'account') {
      if (ban.permanent) {
        // 永封即时回收按天密钥（存封禁前剩余秒数，申诉恢复用，R-02/R-05）。
        // 裁决批⑥后未激活密钥无到期点（长期有效）同样须回收：剩余按全额
        // （套餐天数＋未起算叠加）计，并标记回收时未激活，恢复时还原为
        // 未激活未起算状态，不因恢复动作起算计时。
        for (const k of accountKeys(ban.target)) {
          if (k.plan !== 'permanent' && (k.lifecycle === 'unactivated' || k.lifecycle === 'activated')) {
            k.remainingSecAtRecycle = k.expiresBaseMs
              ? Math.max(0, Math.floor((effectiveExpiry(k, now) - now) / 1000))
              : unstartedRemainingSec(k);
            k.recycledWhileUnactivated = (k.activatedAt == null);
            k.lifecycle = 'revoked'; k.revokedReason = 'permaban'; k.revokedBanId = ban.id; k.timing = 'exhausted';
          }
        }
      }
      syncAccountLinkage(ban.target, now);
    } else if (ban.targetType === 'device') {
      const d = state.deviceAccounts[ban.target]; if (d) d.banned = true;
    }
    queueOwnerMail('QFRemote 封禁通知 ' + ban.code, { banId: ban.id, code: ban.code, targetType: ban.targetType, permanent: ban.permanent, endsAt: ban.endsAt, actor: ban.actor });
    save();
    return ban;
  }
  function liftBan(ban, now, opts) {
    opts = opts || {};
    ban.status = 'lifted'; ban.liftedAt = now; ban.liftedBy = opts.by || 'system';
    if (ban.appealId == null && opts.appealId) ban.appealId = opts.appealId;
    appendLine(bansLog, { ev: 'ban-lifted', id: ban.id, by: ban.liftedBy, appealId: opts.appealId || null, at: now });
    if (ban.targetType === 'device') { const d = state.deviceAccounts[ban.target]; if (d && !activeDeviceBan(ban.target, now)) d.banned = false; }
    if (ban.targetType === 'account') {
      if (ban.permanent && opts.restoreKeys) {
        // R-02：仅恢复因「该次」永封回收的密钥，逐项校验回收原因与对应封禁；
        // 'payment-fraud'（订单判假回收，revokedBanId 同为本笔封禁）申诉推翻
        // 判假时同路径恢复——判假是封禁结论的一部分，结论被推翻回收即失去依据。
        for (const k of accountKeys(ban.target)) {
          if (k.lifecycle === 'revoked' && (k.revokedReason === 'permaban' || k.revokedReason === 'payment-fraud') && k.revokedBanId === ban.id) {
            if (k.recycledWhileUnactivated) {
              // 回收时未激活未起算：恢复原状，不落到期点、不起算（裁决批⑥）
              k.lifecycle = 'unactivated'; k.expiresBaseMs = null; k.timing = 'none'; k.pausedAccumMs = 0; k.pauseStartMs = null;
            } else {
              // 恢复口径（F-2 新增范围修复）：以「回收时是否已激活」为准
              // （recycledWhileUnactivated=false 即回收前已激活），不按槽位
              // 推断——#24 一键兑换激活的密钥可以已激活但尚未绑任何设备，
              // 按槽位推断会把它误降为未激活却带着在跑的到期点，状态自相矛盾。
              k.lifecycle = 'activated';
              if (k.expiresBaseMs) { k.expiresBaseMs = now + (k.remainingSecAtRecycle || 0) * 1000; k.pausedAccumMs = 0; k.pauseStartMs = null; k.timing = 'active'; }
            }
            k.everBanned = true; k.revokedReason = null; k.revokedBanId = null; k.recycledWhileUnactivated = false;
          }
        }
      }
      syncAccountLinkage(ban.target, now);
    }
    save();
  }

  // ---------- 密钥 ----------
  function genKeyString() {
    for (let attempt = 0; attempt < 20; attempt++) {
      const parts = [];
      for (let s = 0; s < 5; s++) { let p = ''; for (let i = 0; i < 5; i++) p += KEY_ALPHABET[crypto.randomInt(KEY_ALPHABET.length)]; parts.push(p); }
      const str = parts.join('-');
      if (!state.keyStrHashes[sha(str)]) return str; // R-01：冲突自动重试
    }
    throw new Error('key-gen-collision');
  }
  function issueKey(username, planId, source, now, meta) {
    const plan = PLANS[planId]; if (!plan) throw new Error('bad-plan');
    if (source !== 'paid' && source !== 'free') throw new Error('source-required');
    ensureAccount(username, now, {});
    const str = genKeyString();
    const rec = {
      id: 'key_' + crypto.randomBytes(6).toString('hex'), str, username, plan: planId, planName: plan.name,
      source, createdAt: now,
      lifecycle: 'unactivated', link: 'normal', timing: 'none',
      // 计时自激活起算（站长 2026-10-25 19:46 裁决批⑥，覆盖 16:53 的购买
      // 起算）：发码时不落到期点，未激活不过期（长期有效）；首次激活时由
      // activateKey 按套餐天数＋extraDays 落 expiresBaseMs、自激活时刻起
      // 算满 N×24 小时。已激活密钥的既有计时/暂停/叠加口径不变。
      expiresBaseMs: null, activatedAt: null, extraDays: 0,
      pausedAccumMs: 0, pauseStartMs: null, remainingSecAtRecycle: null,
      slots: { pc: [], mobile: null }, everBanned: false, transferredOnce: false, // #26：pc 哈希数组（容量 2）、mobile 单值（容量 1）
      orderId: (meta && meta.orderId) || null, issuedBy: (meta && meta.actor) || 'system',
      revokedReason: null, revokedBanId: null,
    };
    state.keys[rec.id] = rec; state.keyStrHashes[sha(str)] = rec.id;
    // 重新获得密钥：转赠领取后的原主人 G1 门标记与强制下线指令一并解除（17:29）
    const acct2 = state.accounts[username];
    if (acct2 && acct2.transferOutGate) delete acct2.transferOutGate;
    syncAccountLinkage(username, now);
    save();
    return rec;
  }
  function lazyExpireKeys(username, now) {
    let changed = false;
    for (const k of accountKeys(username)) {
      if ((k.lifecycle === 'unactivated' || k.lifecycle === 'activated') && k.expiresBaseMs && k.timing !== 'paused' && effectiveExpiry(k, now) <= now) {
        k.lifecycle = 'expired'; k.timing = 'exhausted'; changed = true;
        appendLine(bansLog, { ev: 'key-expired', keyId: k.id, username, at: now });
      }
    }
    if (changed) save();
  }

  // ---------- 许可判定（登录门） ----------
  function evaluate(username, now, ctx) {
    ctx = ctx || {};
    const cfg = readConfig();
    expireBans(now); lazyExpireKeys(username, now);
    ensureAccount(username, now, {});
    const acct = state.accounts[username];
    const bans = activeBansFor(username, now);
    const deviceHash = ctx.deviceCode ? sha(ctx.deviceCode) : null;
    const devBan = deviceHash ? activeDeviceBan(deviceHash, now) : null;
    const base = { username, shadow: cfg.shadow, enforce: enforceFor(cfg, [username]) };
    if (devBan && ctx.channel === 'software') return Object.assign(base, { allow: false, code: 'DEVICE_BANNED', banId: devBan.id, msgCode: 'L3' });
    if (deviceHash && ctx.channel === 'software' && state.deviceReviews.some((r) => r.deviceHash === deviceHash && r.status === 'pending')) {
      return Object.assign(base, { allow: false, code: 'DEVICE_REVIEW', msgCode: 'L3R', note: 'device-review-pending' });
    }
    if (bans.length) {
      const perm = bans.find((b) => b.permanent);
      if (perm) return Object.assign(base, { allow: false, code: 'BAN_PERM', banId: perm.id, banCode: perm.code, msgCode: perm.code === 'B6' ? 'L2' : 'L4' });
      const b = bans[0];
      return Object.assign(base, { allow: false, code: 'BAN_UNTIL', banId: b.id, banCode: b.code, endsAt: b.endsAt, msgCode: b.code === 'B10' ? 'L12' : 'L5' });
    }
    const keys = activeKeys(username, now);
    const hasAnyKey = accountKeys(username).length > 0;
    const expiredDaily = accountKeys(username).some((k) => k.lifecycle === 'expired' && k.plan !== 'trial');
    // G5 附带最近到期点，供三端拦截面渲染「已于 X 到期」（裁决批①）
    const g5ExpiryMs = (() => { const xs = accountKeys(username).filter((k) => k.lifecycle === 'expired' && k.plan !== 'trial' && k.expiresBaseMs); return xs.length ? Math.max.apply(null, xs.map((k) => effectiveExpiry(k, now))) : null; })();
    const expiredTrial = accountKeys(username).some((k) => k.lifecycle === 'expired' && k.plan === 'trial');
    // 转赠领取后原主人回 G1（站长 2026-10-25 17:29 定版）：名下已无有效密钥、
    // 无其他按天过期钥（那是 G5）、试用也不在有效期内时，一律按未激活 G1
    // 拦截并带 forceLogout 标志——不再落 G2/G4。标记在领取落盘时置位
    // （transferOutGate），账号重新获得有效密钥（发码/购买）时清除。
    if (!keys.length && acct.transferOutGate && !expiredDaily && !(acct.trial && acct.trial.expiresMs > now)) {
      return Object.assign(base, { allow: false, code: 'G1', msgCode: 'L9', forceLogout: true, transferOutGate: true });
    }
    if (ctx.channel === 'web') {
      const paidValid = keys.some((k) => k.source === 'paid');
      if (paidValid) return Object.assign(base, { allow: true, code: 'OK' });
      if (expiredDaily && !keys.length) return Object.assign(base, { allow: false, code: 'G5', msgCode: 'L14', keyExpiresMs: g5ExpiryMs });
      // 存量老用户（无试用、无任何密钥记录）在网页端同样走 G1（设计稿 G1 拦截面含网页版）；
      // 试用/免费来源持钥者走 G4。
      if (!hasAnyKey && !acct.trial) return Object.assign(base, { allow: false, code: 'G1', msgCode: 'L9' });
      return Object.assign(base, { allow: false, code: 'G4', msgCode: 'L13' });
    }
    // QFClash 内嵌渠道（QFClash 2.0.3 更新 3）：与 software 同口径判许可
    // （有效密钥或试用在期即放行），但永不带 deviceCode——不判槽位、
    // 不记设备绑定、不触发设备类风控；封禁台账在上方已先判。
    if (ctx.channel === 'qfclash') {
      if (keys.length) return Object.assign(base, { allow: true, code: 'OK' });
      if (acct.trial && acct.trial.expiresMs > now) return Object.assign(base, { allow: true, code: 'OK', trial: true, trialExpiresMs: acct.trial.expiresMs });
      if (expiredDaily) return Object.assign(base, { allow: false, code: 'G5', msgCode: 'L14', keyExpiresMs: g5ExpiryMs });
      if (expiredTrial || (acct.trial && acct.trial.expiresMs <= now)) return Object.assign(base, { allow: false, code: 'G2', msgCode: 'L8', trialExpiresMs: acct.trial ? acct.trial.expiresMs : null });
      return Object.assign(base, { allow: false, code: 'G1', msgCode: 'L9' });
    }
    // software 渠道
    if (keys.length) {
      if (ctx.deviceCode && ctx.platform) {
        const mine = keys.find((k) => slotHas(k, ctx.platform, deviceHash));
        // #26：名额按容量判——该类槽位全部绑满才算 G3（pc 满 2 台、mobile 满 1 台）
        const slotFull = keys.some((k) => slotCount(k, ctx.platform) >= (SLOT_CAPS[ctx.platform] || 1));
        if (!mine && slotFull) return Object.assign(base, { allow: false, code: 'G3', msgCode: 'L10' });
      }
      return Object.assign(base, { allow: true, code: 'OK' });
    }
    if (acct.trial && acct.trial.expiresMs > now) return Object.assign(base, { allow: true, code: 'OK', trial: true, trialExpiresMs: acct.trial.expiresMs });
    // 付费钥过期优先判 G5（已付费用户），无付费钥过期才落 G2——两状态严格区分（17:01 定版）
    if (expiredDaily) return Object.assign(base, { allow: false, code: 'G5', msgCode: 'L14', keyExpiresMs: g5ExpiryMs });
    if (expiredTrial || (acct.trial && acct.trial.expiresMs <= now)) return Object.assign(base, { allow: false, code: 'G2', msgCode: 'L8', trialExpiresMs: acct.trial ? acct.trial.expiresMs : null });
    return Object.assign(base, { allow: false, code: 'G1', msgCode: 'L9' });
  }

  // ---------- 设备上报 / B6（16:53 裁决：废止即时永封，改待审） ----------
  // 一设备出现第二个账号：不自动封禁。生成「设备异常待审记录」进审核队列，
  // 裁决前该设备码暂停新登录（只拦不封，提示「设备异常登录」），并要求壳侧
  // 强制登出该设备上的相关会话（响应 forceLogout 标记）。裁决「违规成立」
  // 才执行两账号永封＋封设备码；「不成立」关闭记录不留封禁；拿不准标转站长。
  function reportDevice(username, deviceCode, platform, now) {
    ensureAccount(username, now, {});
    const dh = sha(deviceCode);
    let d = state.deviceAccounts[dh];
    if (!d) { d = state.deviceAccounts[dh] = { accounts: [], banned: false, platform, reviewedPairs: [] }; }
    if (!d.accounts.includes(username)) d.accounts.push(username);
    let review = null;
    if (d.accounts.length >= 2 && !d.banned) {
      const pairKey = d.accounts.slice().sort().join('|');
      const open = state.deviceReviews.find((r) => r.deviceHash === dh && r.status === 'pending');
      if (!open && !(d.reviewedPairs || []).includes(pairKey)) {
        review = {
          id: 'drev_' + crypto.randomBytes(6).toString('hex'), deviceHash: dh, platform,
          accounts: d.accounts.slice(), status: 'pending', escalated: false,
          createdAt: now, decidedAt: null, decidedBy: null, decision: null,
          evidence: 'same-device-multi-account',
        };
        state.deviceReviews.push(review);
        queueOwnerMail('QFRemote 设备异常待审 ' + review.id, { reviewId: review.id, accounts: review.accounts, platform });
        appendLine(bansLog, { ev: 'device-review-created', id: review.id, device: dh.slice(0, 12), accounts: review.accounts, at: now });
      } else if (open) review = open;
    }
    save();
    const suspended = !!(state.deviceReviews.find((r) => r.deviceHash === dh && r.status === 'pending'));
    // 17:29：转赠领取后原主人的软件会话同样走 forceLogout 通道下线
    const gateForce = !!forceLogoutState(username, now);
    return { deviceHash: dh, accounts: d.accounts.length, banned: !!d.banned, reviewPending: suspended, reviewId: review ? review.id : null, forceLogout: suspended || gateForce, transferOutGate: gateForce };
  }
  // 转赠领取后原主人的强制下线状态（17:29）：标记在领取落盘瞬间置于转出方
  // 账号（transferOutGate），且其名下确无有效密钥、无在期试用时生效；账号
  // 重新获得有效密钥即自动失效（issueKey 清除标记）。供 evaluate /
  // reportDevice / 扩展服务（心跳与会话撤销）同一口径查询。
  function forceLogoutState(username, now) {
    const acct = state.accounts[username];
    if (!acct || !acct.transferOutGate) return null;
    if (activeKeys(username, now).length) return null;
    if (acct.trial && acct.trial.expiresMs > now) return null;
    return { active: true, since: acct.transferOutGate.at, transferId: acct.transferOutGate.transferId, keyId: acct.transferOutGate.keyId, gateAfter: 'G1' };
  }
  function decideDeviceReview(reviewId, decision, actor, now) {
    const r = state.deviceReviews.find((x) => x.id === reviewId);
    if (!r) return { ok: false, code: 'NOT_FOUND' };
    if (r.status !== 'pending') return { ok: false, code: 'ALREADY_DECIDED', status: r.status };
    if (decision === 'escalate') { r.escalated = true; save(); return { ok: true, escalated: true }; }
    if (decision === 'dismissed') {
      r.status = 'closed'; r.decision = 'dismissed'; r.decidedAt = now; r.decidedBy = actor;
      const d = state.deviceAccounts[r.deviceHash];
      if (d) { d.reviewedPairs = d.reviewedPairs || []; const pk = r.accounts.slice().sort().join('|'); if (!d.reviewedPairs.includes(pk)) d.reviewedPairs.push(pk); }
      appendLine(bansLog, { ev: 'device-review-dismissed', id: r.id, by: actor, at: now });
      save();
      return { ok: true, dismissed: true };
    }
    if (decision === 'violation') {
      r.status = 'closed'; r.decision = 'violation'; r.decidedAt = now; r.decidedBy = actor;
      for (const t of r.accounts) applyBan({ targetType: 'account', target: t, code: 'B6', permanent: true, actor: 'review-' + actor, evidence: 'device-review-' + r.id }, now);
      applyBan({ targetType: 'device', target: r.deviceHash, code: 'B6', permanent: true, actor: 'review-' + actor, evidence: 'device-review-' + r.id }, now);
      appendLine(bansLog, { ev: 'device-review-violation', id: r.id, by: actor, at: now });
      save();
      return { ok: true, violation: true, accounts: r.accounts };
    }
    return { ok: false, code: 'VALIDATION' };
  }
  // #38 站长改判（仅站长后台 actor='owner' 带 override 调用；助手接口永不
  // 走此路径）：已裁定的设备异常记录可反向改判。违规→不成立：解除本记录
  // 产生的全部生效封禁（账号封禁 restoreKeys 恢复被回收密钥、设备封禁同
  // 步解除），并把涉事账号对记入 reviewedPairs 防同对重复建单；不成立→
  // 违规：按 decideDeviceReview 违规口径补上封禁（evidence 同为
  // 'device-review-<id>'，保证再改判时能精确定位解除）。改判全程留痕
  // （overrideHistory），原结论不销毁。
  function overrideDeviceReview(reviewId, decision, actor, now) {
    const r = state.deviceReviews.find((x) => x.id === reviewId);
    if (!r) return { ok: false, code: 'NOT_FOUND' };
    if (decision !== 'violation' && decision !== 'dismissed') return { ok: false, code: 'VALIDATION' };
    if (r.status === 'pending') return decideDeviceReview(reviewId, decision, actor, now);
    if (r.decision === decision) return { ok: false, code: 'OVERRIDE_SAME_DECISION', msg: '改判结论与原结论相同，无需改判。' };
    if (!Array.isArray(r.overrideHistory)) r.overrideHistory = [];
    const hist = { at: now, by: actor, from: r.decision, to: decision };
    if (r.decision === 'violation' && decision === 'dismissed') {
      const ev = 'device-review-' + r.id;
      for (const b of state.bans.filter((x) => x.status === 'active' && x.evidence === ev)) {
        liftBan(b, now, { by: actor, restoreKeys: true });
      }
      r.decision = 'dismissed'; r.decidedAt = now; r.decidedBy = actor;
      r.overrideHistory.push(hist);
      const d = state.deviceAccounts[r.deviceHash];
      if (d) { d.reviewedPairs = d.reviewedPairs || []; const pk = r.accounts.slice().sort().join('|'); if (!d.reviewedPairs.includes(pk)) d.reviewedPairs.push(pk); }
      appendLine(bansLog, { ev: 'device-review-override-dismissed', id: r.id, by: actor, at: now });
      save();
      return { ok: true, dismissed: true, accounts: r.accounts, override: true };
    }
    if (r.decision === 'dismissed' && decision === 'violation') {
      for (const t of r.accounts) applyBan({ targetType: 'account', target: t, code: 'B6', permanent: true, actor: 'review-override-' + actor, evidence: 'device-review-' + r.id }, now);
      applyBan({ targetType: 'device', target: r.deviceHash, code: 'B6', permanent: true, actor: 'review-override-' + actor, evidence: 'device-review-' + r.id }, now);
      r.decision = 'violation'; r.decidedAt = now; r.decidedBy = actor;
      r.overrideHistory.push(hist);
      const d = state.deviceAccounts[r.deviceHash];
      if (d && Array.isArray(d.reviewedPairs)) { const pk = r.accounts.slice().sort().join('|'); d.reviewedPairs = d.reviewedPairs.filter((x) => x !== pk); }
      appendLine(bansLog, { ev: 'device-review-override-violation', id: r.id, by: actor, at: now });
      save();
      return { ok: true, violation: true, accounts: r.accounts, override: true };
    }
    return { ok: false, code: 'OVERRIDE_NOT_APPLICABLE', msg: '该记录当前情形不支持改判。' };
  }

  // ---------- 绑定 / B10 ----------
  function bindKey(username, keyStr, deviceCode, platform, now) {
    const cfg = readConfig();
    ensureAccount(username, now, {});
    const dh = sha(deviceCode);
    const rec = Object.values(state.keys).find((k) => k.str === String(keyStr || '').trim().toUpperCase());
    const fail = (code, msg) => {
      // 计犯：窗口内失败次数达阈值记一次犯（单次只提示、不计犯）
      const ab = state.bindAbuse[username] || (state.bindAbuse[username] = { attempts: [], offenseTimes: [], offenses: 0 });
      if (!Array.isArray(ab.offenseTimes)) ab.offenseTimes = [];
      ab.attempts = ab.attempts.filter((t) => now - t < cfg.b10WindowMs);
      ab.attempts.push(now);
      let offense = null;
      let offenseApplied = false;
      if (ab.attempts.length >= cfg.b10Threshold) {
        ab.attempts = [];
        // P13 结案（站长 16:59）：一年窗口——以最近一次犯次为锚，相邻犯次间隔
        // 满一年即断链清零、重新起算；一年内再犯沿链累计升级。每次犯次存时间戳。
        const YEAR = 365 * 86400000;
        let eff = 1;
        for (let i = ab.offenseTimes.length - 1; i >= 0; i--) {
          const prev = ab.offenseTimes[i];
          const newer = i === ab.offenseTimes.length - 1 ? now : ab.offenseTimes[i + 1];
          if (newer - prev < YEAR) eff += 1; else break;
        }
        offense = eff;
        const banInput = offense === 1 ? { code: 'B10', permanent: false, endsAt: now + 1 * 86400000 }
          : offense === 2 ? { code: 'B10', permanent: false, endsAt: now + 7 * 86400000 }
          : { code: 'B10', permanent: true };
        // 影子纯净（阶段 F 深查修复）：影子/名单外只记拟处置（shadowLog），
        // 犯次台账（offenseTimes/offenses）只在真实执法时落盘——否则影子期
        // 的拟犯次会污染一年窗口梯度，关影子后被追溯计犯。
        if (enforceFor(cfg, [username])) {
          ab.offenseTimes.push(now);
          ab.offenses = eff; // 有效犯次（梯度判定口径），历史时间戳全量留档
          offenseApplied = true;
          applyBan(Object.assign({ targetType: 'account', target: username, actor: 'risk-b10', evidence: 'bind-abuse-offense-' + offense }, banInput), now);
        }
        else { shadowLog({ ev: 'b10-would-offense', username, offense }); }
      }
      save();
      return { ok: false, code, msg, offense, offenseApplied };
    };
    if (!rec || rec.username !== username) return fail('KEY_INVALID', '密钥无效或不属于该账号，请核对后重试。');
    if (rec.lifecycle === 'expired') return { ok: false, code: 'G5', msg: expiredText(rec, now) + '请购买新密钥。', expiredAt: rec.expiresBaseMs ? effectiveExpiry(rec, now) : null };
    if (rec.lifecycle === 'revoked') return { ok: false, code: 'KEY_REVOKED', msg: '该密钥已作废，无法绑定。' };
    const slot = platform === 'mobile' ? 'mobile' : 'pc';
    migrateSlots(rec);
    if (slotHas(rec, slot, dh)) return { ok: true, already: true, slot }; // 本设备重复确认不算失败
    if (slotCount(rec, slot) >= SLOT_CAPS[slot]) return fail('KEY_BOUND', '该密钥已被绑定，无法再次绑定。一枚密钥仅可绑定两台电脑与一部手机；如需在其他设备使用，请购买新密钥。异常绑定行为将按《用户协议》相关约定处理。');
    slotAdd(rec, slot, dh);
    activateKey(rec, now); // 首次绑定即激活：未起算密钥自此刻起算（裁决批⑥）
    save();
    return { ok: true, slot };
  }

  // ---------- 换绑设备申诉（站长 2026-10-25 17:37 提出、18:39 确认定版，设计稿 §11.9） ----------
  // 【校验分离硬规矩（18:39 定版，验收级）】换绑是同类别槽位替换：同类槽位
  // 已占用正是换绑的前提。本节的提交资格与审核执行是独立的替换路径，
  // 严禁复用普通绑定 bindKey 的「槽满即拒」校验，严禁以「绑定数额已满」
  // 拦截换绑的提交、审核与生效。普通超额新增绑定仍走 bindKey 原路径，
  // 其 KEY_BOUND/G3 口径一字不变。
  // 槽位存储口径：slots 内保存的是设备码的 sha256 哈希（与 deviceAccounts、
  // 设备封禁台账同一口径），换绑台账中的「旧设备码/新设备码」均以此哈希落盘。
  function rebindKeyFor(username, platform, now) {
    // 目标密钥：有效密钥中优先选同类槽位已被占用的那把（换绑对象），
    // 否则取状态视图同口径的主密钥（最新创建的有效密钥）。
    const act = activeKeys(username, now);
    if (!act.length) return null;
    return act.find((k) => slotCount(k, platform) > 0) || act.slice().sort((a, b) => b.createdAt - a.createdAt)[0];
  }
  function rebindEligibility(username, deviceCode, platform, now) {
    return rebindEligibilityByHash(username, sha(String(deviceCode || '')), platform, now);
  }
  function rebindEligibilityByHash(username, dh, platform, now) {
    // 提交端资格（与执行端 executeRebind 同一判定，提交时先拦、执行时复核）：
    // 无有效密钥 / 同类槽位为空 → 不入换绑队列，引导走普通绑定；
    // 新设备已绑在本账号同槽 → 按「已绑定」收口，不产生重复绑定。
    ensureAccount(username, now, {});
    lazyExpireKeys(username, now);
    const slot = platform === 'mobile' ? 'mobile' : 'pc';
    const key = rebindKeyFor(username, slot, now);
    if (!key) return { ok: false, code: 'NO_VALID_KEY', msg: '该账号暂无有效密钥，无法换绑。请先购买密钥，再按普通方式绑定设备。' };
    // #26：pc 槽位为容量 2 的数组——非空即可换绑；新设备已在同类已绑列表
    // 内（含两台中的任一台）按 ALREADY_BOUND 收口；oldDeviceCode 记将
    // 被替换的那台＝同类槽位中最早绑定的（数组首元素）。
    const boundList = slotList(key, slot);
    if (!boundList.length) return { ok: false, code: 'SLOT_EMPTY', keyId: key.id, msg: '该类设备槽位尚未绑定设备，无需换绑。请登录后按普通方式绑定本设备。' };
    if (boundList.includes(dh)) return { ok: false, code: 'ALREADY_BOUND', keyId: key.id, slot, oldDeviceCode: dh, newDeviceCodeHash: dh, msg: '本设备已绑定在您的账号上，无需换绑，可直接登录使用。' };
    return { ok: true, keyId: key.id, planName: key.planName, slot, oldDeviceCode: boundList[0], newDeviceCodeHash: dh };
  }
  function executeRebind(input, now) {
    const deviceCode = String((input && input.deviceCode) || '');
    if (!deviceCode) return { ok: false, code: 'VALIDATION', msg: '换绑执行参数不完整。' };
    return executeRebindByHash({ username: input.username, platform: input.platform, newDeviceCodeHash: sha(deviceCode), appealId: input.appealId, actor: input.actor }, now);
  }
  function executeRebindByHash(input, now) {
    // 审核通过的执行动作（人工裁决的补救通道：即时真实执行，不随影子模式
    // 打折）。单事务落盘：同类旧设备解绑 → 新设备绑入 → 台账事件 → 通知
    // 入队，四步同在本函数内完成、只 save() 一次，中途不经过任何容量校验。
    // 申诉台账只存设备码哈希（与槽位/封禁台账同口径），故执行走哈希入口。
    const username = String((input && input.username) || '').toLowerCase();
    const slot = (input && input.platform) === 'mobile' ? 'mobile' : 'pc';
    const dhIn = String((input && input.newDeviceCodeHash) || '');
    if (!username || !dhIn) return { ok: false, code: 'VALIDATION', msg: '换绑执行参数不完整。' };
    const elig = rebindEligibilityByHash(username, dhIn, slot, now);
    if (!elig.ok) {
      if (elig.code === 'ALREADY_BOUND') {
        // 已绑定收口：不产生重复绑定，台账留一条收口记录即视为执行完成
        appendLine(bansLog, { ev: 'rebind-already-bound', appealId: input.appealId || null, username, slot, keyId: elig.keyId || null, at: now });
        return { ok: true, alreadyBound: true, keyId: elig.keyId || null, slot };
      }
      return elig;
    }
    const dh = elig.newDeviceCodeHash;
    // 执行校验：新设备码为封禁设备码 → 拒绝执行（回写审核备注由裁决层完成）
    if (activeDeviceBan(dh, now)) return { ok: false, code: 'DEVICE_BANNED', msg: '新设备已被限制登录，换绑未执行。' };
    const key = state.keys[elig.keyId];
    // #26 红线：换绑是同类替换，严禁被容量拦截——pc 两台绑满时走这里
    // 替换最早绑定的那台（slotReplaceEarliest），不经过 bindKey 容量校验。
    const oldHash = slotReplaceEarliest(key, slot, dh);
    activateKey(key, now); // 换绑执行同样构成激活（裁决批⑥）
    appendLine(bansLog, { ev: 'rebind-executed', appealId: input.appealId || null, username, keyId: key.id, slot, oldDeviceCode: oldHash, newDeviceCodeHash: dh, actor: input.actor || 'appeal-review', at: now });
    queueOwnerMail('QFRemote 换绑申诉已通过 ' + (input.appealId || ''), { appealId: input.appealId || null, username, slot, keyId: key.id, actor: input.actor || 'appeal-review' });
    save();
    return { ok: true, keyId: key.id, slot, oldDeviceCode: oldHash, newDeviceCodeHash: dh };
  }

  // ---------- 注册门 ----------
  function registerCheck(deviceHash, ip, now) {
    if (deviceHash && state.regLedger.byDevice[deviceHash]) return { allow: false, reason: 'device' };
    if (ip && state.regLedger.byIp[ip]) return { allow: false, reason: 'ip' };
    return { allow: true };
  }
  function registerSuccess(username, deviceHash, ip, now) {
    if (deviceHash) state.regLedger.byDevice[deviceHash] = { username, at: now };
    if (ip) state.regLedger.byIp[ip] = { username, at: now };
    ensureAccount(username, now, { fromRegister: true });
    // 定版（站长 17:01）：注册成功即自动发放试用密钥并入账——同 5×5 格式与
    // 全局唯一规则，来源「免费发放」，状态「已激活」，到期＝注册时刻＋72 小时，
    // 与试用计时、注册台账在同一落账链里完成（幂等：已有试用钥不重发）。
    const acct = state.accounts[username];
    if (!acct.trialKeyId) {
      const tk = issueKey(username, 'trial', 'free', now, { actor: 'register' });
      tk.lifecycle = 'activated';
      tk.activatedAt = now; tk.timing = 'active'; // 试用钥发放即已激活起算（裁决批⑥衔接：试用不起算点另定为注册时刻，照旧）
      tk.expiresBaseMs = acct.trial ? acct.trial.expiresMs : now + 72 * 3600000;
      acct.trialKeyId = tk.id;
      save();
    }
    save();
    return state.accounts[username];
  }

  // ---------- 订单 / 支付 ----------
  function createOrder(username, planId, now) {
    const plan = PLANS[planId]; if (!plan) throw new Error('bad-plan');
    ensureAccount(username, now, {});
    const order = { id: 'ord_' + crypto.randomBytes(8).toString('hex'), username, plan: planId, amount: plan.price, status: 'pending_payment', createdAt: now, keyId: null, channel: 'web' };
    state.orders[order.id] = order; save();
    return order;
  }
  function simPayCallback(orderId, amount, now) {
    const order = state.orders[orderId];
    if (!order) return { ok: false, code: 'NOT_FOUND' };
    if (order.status === 'paid' && order.keyId) return { ok: true, duplicated: true }; // 幂等：同单只发一次
    if (Number(amount) !== order.amount) { order.status = 'exception'; save(); return { ok: false, code: 'AMOUNT_MISMATCH' }; }
    const g = grantPurchase(order.username, order.plan, 'paid', now, { orderId: order.id, actor: 'sim-pay' });
    if (g.alreadyPermanent) { order.status = 'exception'; order.note = 'already-permanent'; save(); return { ok: false, code: 'ALREADY_PERMANENT', msg: '该账号已持有永久套餐，不可重复购买。' }; }
    order.status = 'paid'; order.paidAt = now; order.keyId = g.key.id; save();
    return { ok: true, duplicated: false, stacked: !!g.stacked, swapped: !!g.swapped, keyId: g.key.id, maskedKey: maskKey(g.key.str) };
  }

  // ---------- 购买发放（16:53 裁决：按天续购叠加、永久不可叠加） ----------
  // 【FIX-B1-4 幂等包装（DS-B1-4：发钥与 orders 落盘非原子）】
  // 发放记录 grantsByOrder 与发放同表（license state）、由发放自身的 save()
  // 落盘。orders 侧落盘失败或进程崩溃后同 orderId 重试时：先查记录回原钥；
  // 记录未及补写时按归属戳恢复（发钥钥的 orderId 戳／叠加钥的
  // lastGrantOrderId 戳，均随发放自身的 save 落盘）。alreadyPermanent 不是
  // 发放（零变更），不落记录，以免挡住站长事后处置后的正当重试。
  function grantPurchase(username, planId, source, now, meta) {
    const plan = PLANS[planId]; if (!plan) throw new Error('bad-plan');
    if (planId === 'trial') throw new Error('bad-plan');
    const orderId = (meta && meta.orderId) || null;
    if (orderId) {
      const gbo = state.grantsByOrder || (state.grantsByOrder = {});
      const rec = gbo[orderId];
      if (rec) {
        // 记录在：先核对归属与套餐——不一致＝orderId 冲突（状态损坏或未来
        // 调用方误用），失败关闭并留审计，绝不把他人/他档的发放当本单结果
        // 回（门一 F5 残余防线；现行全部调用点的 orderId 均由服务端生成、
        // 全局唯一，正常路径不可达此分支）。
        if (rec.username !== username || rec.plan !== planId) {
          appendLine(bansLog, { ev: 'grant-record-conflict', orderId, recUsername: rec.username, recPlan: rec.plan, username, plan: planId, at: now });
          throw new Error('grant-order-conflict');
        }
        const key = rec.keyId ? state.keys[rec.keyId] : null;
        if (key) {
          // 已发放钥其后被人工回收（永封/判假回收）：不把撤销钥当发放成功
          // 返回，失败关闭留人工对账（门一 F3）；封禁解除按 R-02 恢复原钥后，
          // 同单重试自动重新命中返回，语义自洽。
          if (key.lifecycle === 'revoked') {
            appendLine(bansLog, { ev: 'grant-hit-revoked-key', orderId, keyId: key.id, username, revokedReason: key.revokedReason || null, at: now });
            throw new Error('grant-key-revoked');
          }
          return { key, stacked: !!rec.stacked, swapped: !!rec.swapped, voidedDaily: !!rec.voidedDaily, newExpiresMs: rec.newExpiresMs != null ? rec.newExpiresMs : null, duplicated: true };
        }
        // 记录在而钥不在：状态损坏级异常——留审计后落恢复查找；恢复亦无果
        // 时失败关闭（门一 F4），禁止回落正常发放造成二次发放。
        appendLine(bansLog, { ev: 'grant-record-key-missing', orderId, keyId: rec.keyId || null, username, at: now });
      }
      // 崩溃恢复：上一 attempt 发放已落盘、记录未及补写——按归属戳找回原钥
      // （叠加路径查逐单戳记 grantStamps，单字段 lastGrantOrderId 仅作兼容兜底）
      const issued = Object.values(state.keys).find((k) => k.username === username && k.orderId === orderId);
      const stackedKey = issued ? null : Object.values(state.keys).find((k) => k.username === username && ((k.grantStamps && k.grantStamps[orderId]) || k.lastGrantOrderId === orderId));
      const found = issued || stackedKey;
      if (found) {
        if (found.plan !== planId) {
          appendLine(bansLog, { ev: 'grant-record-conflict', orderId, keyId: found.id, recPlan: found.plan, username, plan: planId, at: now });
          throw new Error('grant-order-conflict');
        }
        if (found.lifecycle === 'revoked') {
          appendLine(bansLog, { ev: 'grant-hit-revoked-key', orderId, keyId: found.id, username, revokedReason: found.revokedReason || null, via: 'recovery', at: now });
          throw new Error('grant-key-revoked');
        }
        const wasSwap = issued ? completeSwapRemainder(username, found, now) : false;
        gbo[orderId] = { keyId: found.id, username, plan: planId, source, at: now, stacked: !!stackedKey, swapped: wasSwap, voidedDaily: false, newExpiresMs: null, recovered: true };
        save();
        appendLine(bansLog, { ev: 'grant-recovered', orderId, keyId: found.id, username, via: issued ? 'key-orderId' : 'grantStamps', at: now });
        return { key: found, stacked: !!stackedKey, swapped: wasSwap, voidedDaily: false, newExpiresMs: null, duplicated: true, recovered: true };
      }
      if (rec) throw new Error('grant-record-key-missing');
    }
    const g = grantPurchaseInner(username, planId, source, now, meta);
    if (orderId && g && g.key && !g.alreadyPermanent) {
      const gbo = state.grantsByOrder || (state.grantsByOrder = {});
      gbo[orderId] = { keyId: g.key.id, username, plan: planId, source, at: now, stacked: !!g.stacked, swapped: !!g.swapped, voidedDaily: !!g.voidedDaily, newExpiresMs: g.newExpiresMs != null ? g.newExpiresMs : null };
      save();
    }
    return g;
  }
  // 换卡半途补完：换卡分支「试用退役＋新钥」由 issueKey 的 save 同表落盘，
  // 槽位承继/激活在其后的第二次 save；崩溃落在两次 save 之间时新钥在册但
  // 槽位未承继、激活未定。配对必须精确（门二 P1）：只有换卡首 save 落盘的
  // 链接戳 convertedByOrderId 与本钥 orderId 相同，才证明本钥系该试用钥的
  // 换卡产物；「账号有过换卡史」不构成证明——续费全新发钥（旧付费钥过期
  // 后再购）在记录落盘失败后走恢复时，误取历史试用钥会把待激活新钥提前
  // 激活（计时起点错位）并把老设备槽位越权带入新钥。无戳的历史残留
  // （B1-4 之前换卡未落链接戳）仅在不可能误认时才补完：候选唯一、且本钥
  // 是该账号唯一的付费钥（不存在更早的换卡产物）——续费误判场景必有旧
  // 付费钥在册，天然被此条排除。激活判定与原分支同口径——槽位非空或原
  // 试用已激活（wasActivated 快照随首 save 落盘；无快照的残留按注册契约
  // 「试用发放即已激活」取 true），补齐原实现漏掉的「试用已激活但零槽位」
  // 情形。落盘由恢复分支的记录 save 一并完成。
  function completeSwapRemainder(username, nk, now) {
    const trials = accountKeys(username).filter((k) => k.plan === 'trial' && k.lifecycle === 'revoked' && k.revokedReason === 'trial-converted');
    if (!trials.length) return false;
    let trialKey = trials.find((k) => k.convertedByOrderId && nk.orderId && k.convertedByOrderId === nk.orderId) || null;
    if (!trialKey) {
      const residue = trials.filter((k) => !k.convertedByOrderId);
      const otherPaid = accountKeys(username).filter((k) => k.plan !== 'trial' && k.id !== nk.id);
      if (residue.length === 1 && otherPaid.length === 0) trialKey = residue[0];
      if (!trialKey) return false;
    }
    const wasActivated = trialKey.convertedWasActivated != null ? !!trialKey.convertedWasActivated : true;
    if (!slotAnyBound(nk)) {
      const inherited = { pc: slotList(trialKey, 'pc').slice(), mobile: trialKey.slots.mobile || null };
      if (inherited.pc.length || inherited.mobile) {
        nk.slots = inherited;
        appendLine(bansLog, { ev: 'trial-card-swapped', oldKeyId: trialKey.id, newKeyId: nk.id, username, inheritedSlots: { pc: slotCount(trialKey, 'pc'), mobile: slotCount(trialKey, 'mobile') }, at: now, recovered: true });
      }
    }
    if (slotAnyBound(nk) || wasActivated) activateKey(nk, now);
    return true;
  }
  function grantPurchaseInner(username, planId, source, now, meta) {
    const plan = PLANS[planId]; if (!plan) throw new Error('bad-plan');
    if (planId === 'trial') throw new Error('bad-plan');
    const orderId = (meta && meta.orderId) || null;
    ensureAccount(username, now, {});
    lazyExpireKeys(username, now);
    // 门二 P2：自此以下各分支都会在落盘前改写共享 state（换卡先改试用钥、
    // 永久先作废按天钥、发钥先入表），任一步抛错（save 写盘失败等）若不回
    // 滚，半成品会留在进程单例里、被后续无关 save 整表落盘（试用已退役+
    // 裸钥在册，而订单侧已回滚、幂等记录未落）。故先整表快照，抛错即整表
    // 还原、字面零变更；已落盘部分（issueKey 的 save 先行成功而后续步抛
    // 错）由重试时的幂等记录/归属戳恢复收束，与内存还原不冲突。
    const snapshot = JSON.parse(JSON.stringify(state));
    try {
      return grantPurchaseInnerExec(username, planId, source, now, meta, plan, orderId);
    } catch (e) {
      state = snapshot;
      throw e;
    }
  }
  function grantPurchaseInnerExec(username, planId, source, now, meta, plan, orderId) {
    // 试用→付费换卡（站长 17:02 定版）：持有有效试用密钥时购任一付费档，整卡
    // 换新——原试用钥退役留档（revokedReason=trial-converted，串永不再用），
    // 新钥自动承继试用钥已占槽位（记台账），来源记付费、网页权益随之开通。
    const trialKey = activeKeys(username, now).find((k) => k.plan === 'trial');
    if (trialKey && source === 'paid') {
      migrateSlots(trialKey);
      const inherited = { pc: slotList(trialKey, 'pc').slice(), mobile: trialKey.slots.mobile || null }; // #26：pc 承继整个哈希数组（最多 2 台）
      const wasActivated = trialKey.lifecycle === 'activated';
      trialKey.lifecycle = 'revoked'; trialKey.revokedReason = 'trial-converted'; trialKey.timing = 'exhausted';
      // 门一 F2：换卡链接与激活快照在 issueKey 之前落位，随其首个 save 一并
      // 落盘——崩溃恢复据此精确配对并还原 wasActivated，不再靠内存变量。
      trialKey.convertedByOrderId = orderId; trialKey.convertedWasActivated = wasActivated;
      const nk = issueKey(username, planId, source, now, meta);
      nk.slots = inherited;
      // 承继槽位/原试用已激活 → 新卡发放即激活，自此刻起算（裁决批⑥衔接）
      if (slotAnyBound(nk) || wasActivated) activateKey(nk, now);
      appendLine(bansLog, { ev: 'trial-card-swapped', oldKeyId: trialKey.id, newKeyId: nk.id, username, inheritedSlots: { pc: slotCount(trialKey, 'pc'), mobile: slotCount(trialKey, 'mobile') }, at: now });
      save();
      return { key: nk, swapped: true };
    }
    if (planId === 'permanent') {
      const hasPerm = accountKeys(username).some((k) => k.plan === 'permanent' && (k.lifecycle === 'unactivated' || k.lifecycle === 'activated'));
      if (hasPerm) return { alreadyPermanent: true, key: null };
      // 定版（站长 16:59）：购永久时名下按天密钥剩余时效作废（事由「升级永久」），以永久为准
      for (const k of accountKeys(username)) {
        if (k.plan !== 'permanent' && (k.lifecycle === 'unactivated' || k.lifecycle === 'activated')) {
          // 作废留档（§11.8 定版）：作废时点＋作废前剩余秒数一并留档备查；
          // 未激活未起算密钥按全额计（裁决批⑥衔接）
          const remainSec = k.expiresBaseMs
            ? Math.max(0, Math.floor((effectiveExpiry(k, now) - now) / 1000))
            : unstartedRemainingSec(k);
          k.lifecycle = 'revoked'; k.revokedReason = 'upgrade-permanent'; k.timing = 'exhausted'; k.voidedRemainingSec = remainSec;
          appendLine(bansLog, { ev: 'key-voided-upgrade-permanent', keyId: k.id, username, remainingSec: remainSec, at: now });
        }
      }
      return { key: issueKey(username, planId, source, now, meta), stacked: false, voidedDaily: true };
    }
    // 按天：在期同账号已有有效按天密钥 → 时长叠加顺延。已激活的顺延到期点
    // （到期点 += N×24h）；未激活未起算的（裁决批⑥）无到期点可延，改为
    // 累计未起算天数 extraDays，激活时一并起算，总时长不变。
    const activeDaily = activeKeys(username, now).filter((k) => k.plan !== 'permanent' && k.plan !== 'trial').sort((a, b) => effectiveExpiry(b, now) - effectiveExpiry(a, now))[0];
    if (activeDaily) {
      if (activeDaily.expiresBaseMs) {
        activeDaily.expiresBaseMs += plan.days * 86400000;
        if (orderId) { activeDaily.lastGrantOrderId = orderId; const gs = activeDaily.grantStamps || (activeDaily.grantStamps = {}); gs[orderId] = now; } // FIX-B1-4：叠加归属戳，随本次 save 落盘供崩溃恢复查找；门一 F1：另存逐单戳记 grantStamps——单字段会被同钥后续发放覆盖，逐单戳记不会
        if (source === 'paid' && activeDaily.source !== 'paid') { /* 来源不改标（§11.4 写死）：叠加只延时，不改旧钥来源 */ }
        save();
        return { key: activeDaily, stacked: true, newExpiresMs: effectiveExpiry(activeDaily, now) };
      }
      activeDaily.extraDays = (activeDaily.extraDays || 0) + plan.days;
      if (orderId) { activeDaily.lastGrantOrderId = orderId; const gs = activeDaily.grantStamps || (activeDaily.grantStamps = {}); gs[orderId] = now; } // FIX-B1-4：叠加归属戳，随本次 save 落盘供崩溃恢复查找；门一 F1：另存逐单戳记 grantStamps——单字段会被同钥后续发放覆盖，逐单戳记不会
      save();
      return { key: activeDaily, stacked: true, newExpiresMs: null, pendingActivation: true };
    }
    return { key: issueKey(username, planId, source, now, meta), stacked: false };
  }

  // ---------- 密钥转赠（16:53 裁决：可转赠、每把仅一次） ----------
  // 【领取机制撤换（站长 2026-10-25 17:23 定版，覆盖 17:03 双通道点接受）】
  //  不再有点接受/拒绝按钮。受赠人在登录页「查询密钥」凭账号＋密码核验
  //  （只核验不签发登录态）后，在状态查询页看到待领取密钥的完整串并复制；
  //  再在登录拦截页（G1/G2/G5）或已登录的「付费与激活」区把串粘贴到
  //  「请输入 QFRemote 激活密钥」输入框提交，校验通过即完成领取：归属
  //  转移＋回未激活＋槽位清空＋transferredOnce 在领取落盘瞬间才置位。
  //  校验写死：提交的串必须命中「正待领取、收赠方＝当前账号、未过期
  //  未撤销」的转赠单才算成功；串不符/非本人转赠单一律统一拒绝、不透露
  //  他人信息。原 confirmTransfer/rejectTransfer 仅作历史兼容保留，公开
  //  接口层已撤换为 claimByKeyString，不得再经新 UI/新端点调用。
  // 【待接受期口径（站长 2026-10-25 17:11 定版，17:23 映射保留）】
  //  1) 待领取期间密钥仍归原主人：initiate 不动密钥（绑定不解、槽位不动、
  //     生命周期/计时/网页权益照常），原主人照常使用；
  //  2) 领取瞬间才转移：claim 落盘那一刻才改归属＋回未激活＋槽位清空，
  //     且 transferredOnce 只在转移完成时置位；
  //  3) 原主人随时可撤销待领取转赠且不计次：撤销/超时/密钥过期三种
  //     终结都不消耗「每把仅一次」（「拒绝」动作随点接受一并取消，
  //     不领取即不领取）；
  //  4) 待领取挂满期限自动取消：期限为服务端可调参数 transferTtlMs
  //     （config.json，默认 72 小时＝3 天），终结记台账。
  // 【待领取期内密钥到期（站长 2026-10-25 17:14 定版，17:23 衔接）】付费
  //  按天钥在待领取期内到期 → 该转赠自动终结，事由单独记「密钥过期」
  //  （endReason='key-expired'，与 cancelled/timeout 分开统计）；受赠方待
  //  领取列表不再出现该条，其再提交该串领取时回「密钥已过期」。
  // 终结事由 endReason 枚举：cancelled（转出方撤销）｜rejected（受赠方拒绝）
  //  ｜timeout（挂满期限）｜key-expired（待接受期内密钥到期）。旧记录无此
  //  字段时按 status 映射展示（expired→timeout、rejected→rejected）。
  function transferTtlMs() {
    const v = Number(readConfig().transferTtlMs);
    return v > 0 ? v : 72 * 3600000;
  }
  function endTransfer(t, status, reason, now) {
    t.status = status; t.endReason = reason; t.decidedAt = now;
    appendLine(bansLog, { ev: 'transfer-ended', id: t.id, keyId: t.keyId, from: t.from, to: t.to, status, reason, at: now });
  }
  function expireTransfers(now) {
    let changed = false;
    for (const t of state.transfers) {
      if (t.status !== 'pending') continue;
      const k = state.keys[t.keyId];
      // 先判密钥到期（事由优先于超时：钥已死则单无意义，17:14 定版）
      if (k && ((k.lifecycle === 'expired' || k.lifecycle === 'revoked') || (k.expiresBaseMs && effectiveExpiry(k, now) <= now))) {
        if (k.lifecycle === 'unactivated' || k.lifecycle === 'activated') { k.lifecycle = 'expired'; k.timing = 'exhausted'; }
        endTransfer(t, 'key-expired', 'key-expired', now); changed = true; continue;
      }
      if (now - t.createdAt > transferTtlMs()) { endTransfer(t, 'expired', 'timeout', now); changed = true; }
    }
    if (changed) save();
  }
  // @deprecated 17:23 撤换：拒绝动作已取消，公开接口不再调用；保留仅为历史记录兼容
  function rejectTransfer(username, transferId, now) {
    expireTransfers(now);
    const t = state.transfers.find((x) => x.id === transferId);
    if (!t) return { ok: false, code: 'NOT_FOUND', msg: '转赠记录不存在或已处理。' };
    if (t.status === 'key-expired') return { ok: false, code: 'KEY_EXPIRED', msg: '密钥已过期。' };
    if (t.status !== 'pending') return { ok: false, code: 'NOT_FOUND', msg: '转赠记录不存在或已处理。' };
    if (t.to !== username) return { ok: false, code: 'NOT_RECIPIENT', msg: '只有受赠账号可以拒绝。' };
    endTransfer(t, 'rejected', 'rejected', now); save();
    return { ok: true, rejected: true };
  }
  function cancelTransfer(username, transferId, now) {
    expireTransfers(now);
    const t = state.transfers.find((x) => x.id === transferId);
    if (!t) return { ok: false, code: 'NOT_FOUND', msg: '转赠记录不存在或已处理。' };
    if (t.status === 'key-expired') return { ok: false, code: 'KEY_EXPIRED', msg: '密钥已过期，该转赠已自动结束。' };
    if (t.status !== 'pending') return { ok: false, code: 'NOT_FOUND', msg: '转赠记录不存在或已处理。' };
    if (t.from !== username) return { ok: false, code: 'NOT_SENDER', msg: '只有转出账号可以撤销。' };
    // 撤销不计次：不置 transferredOnce，同一把钥可再次发起转赠（17:11 定版）
    endTransfer(t, 'cancelled', 'cancelled', now); save();
    return { ok: true, cancelled: true };
  }
  function initiateTransfer(username, keyId, toUsername, now) {
    expireTransfers(now);
    const k = state.keys[keyId];
    if (!k || k.username !== username) return { ok: false, code: 'NOT_FOUND', msg: '密钥不存在或不属于该账号。' };
    // 裁决批②（发起侧）：赠方账号处于封禁/冻结状态时不得发起转赠（硬拒）
    if (activeBansFor(username, now).length) return { ok: false, code: 'ACCOUNT_BANNED', msg: '账号当前处于封禁或冻结状态，无法发起转赠。' };
    // 定版（站长 17:04）：只有付费来源密钥可转赠；试用及其它免费发放来源一律硬拒
    if (k.source !== 'paid') return { ok: false, code: 'FREE_NOT_TRANSFERABLE', msg: '免费获得的密钥不能转赠，仅付费购买的密钥可转赠。' };
    if (k.transferredOnce) return { ok: false, code: 'TRANSFER_USED', msg: '该密钥已转赠过一次，不能再次转赠。' };
    if (k.lifecycle === 'expired' || k.lifecycle === 'revoked') return { ok: false, code: 'KEY_DEAD', msg: '该密钥已失效，不能转赠。' };
    if (state.transfers.some((t) => t.keyId === keyId && t.status === 'pending')) return { ok: false, code: 'TRANSFER_PENDING', msg: '该密钥已有一笔待确认的转赠。' };
    const t = { id: 'tr_' + crypto.randomBytes(6).toString('hex'), keyId, from: username, to: String(toUsername || '').toLowerCase(), status: 'pending', createdAt: now, decidedAt: null };
    state.transfers.push(t); save();
    return { ok: true, transfer: t };
  }
  // @deprecated 17:23 撤换：点接受已取消，领取唯一路径为 claimByKeyString；保留仅为历史兼容
  function confirmTransfer(username, transferId, now) {
    expireTransfers(now);
    const t = state.transfers.find((x) => x.id === transferId);
    if (!t) return { ok: false, code: 'NOT_FOUND', msg: '转赠记录不存在或已处理。' };
    // 17:14 定版：待接受期内钥已到期终结的单，再尝试接受回「密钥已过期」
    if (t.status === 'key-expired') return { ok: false, code: 'KEY_EXPIRED', msg: '密钥已过期。' };
    if (t.status !== 'pending') return { ok: false, code: 'NOT_FOUND', msg: '转赠记录不存在或已处理。' };
    if (t.to !== username) return { ok: false, code: 'NOT_RECIPIENT', msg: '只有受赠账号可以确认。' };
    const k = state.keys[t.keyId];
    if (!k || k.username !== t.from) return { ok: false, code: 'NOT_FOUND', msg: '转赠记录不存在或已处理。' };
    if (k.transferredOnce) return { ok: false, code: 'TRANSFER_USED', msg: '该密钥已转赠过一次。' };
    if (k.lifecycle === 'expired' || k.lifecycle === 'revoked' || (k.expiresBaseMs && effectiveExpiry(k, now) <= now)) return { ok: false, code: 'KEY_EXPIRED', msg: '密钥已过期。' };
    // 接受瞬间才转移（17:11 定版）：此刻才改归属、回未激活、清空槽位、置已转赠标记
    k.username = username; k.transferredOnce = true; k.slots = { pc: [], mobile: null }; // #26：槽位清空＝pc 空数组＋mobile 空值
    if (k.lifecycle === 'activated') k.lifecycle = 'unactivated';
    t.status = 'done'; t.endReason = 'accepted'; t.decidedAt = now;
    ensureAccount(username, now, {});
    const sAcct = ensureAccount(t.from, now, {}); sAcct.transferOutGate = { at: now, transferId: t.id, keyId: k.id, to: username };
    appendLine(bansLog, { ev: 'key-transferred', keyId: k.id, from: t.from, to: username, at: now });
    save();
    return { ok: true, keyId: k.id, maskedKey: maskKey(k.str) };
  }
  // ---------- 密钥串领取（17:23 定版，唯一领取路径） ----------
  function claimByKeyString(username, keyStr, now) {
    expireTransfers(now);
    const norm = String(keyStr || '').trim().toUpperCase();
    if (!norm) return { ok: false, code: 'VALIDATION', msg: '请输入 QFRemote 激活密钥。' };
    // 裁决批②（领取侧硬拒之一）：接收方账号处于封禁/冻结状态时不能领取，
    // 不进入任何后续校验（封禁先走申诉，口径不变）。
    if (activeBansFor(username, now).length) return { ok: false, code: 'ACCOUNT_BANNED', msg: '您的账号当前处于封禁或冻结状态，无法领取密钥。请先处理账号状态或提交申诉。' };
    let k = null;
    const hid = state.keyStrHashes[sha(norm)];
    if (hid && state.keys[hid]) k = state.keys[hid];
    if (!k) k = Object.values(state.keys).find((x) => x.str === norm) || null;
    // 串不存在：统一拒绝，不透露任何他人信息
    if (!k) return { ok: false, code: 'KEY_INVALID', msg: '密钥无效，请核对后重试。' };
    const mine = state.transfers.filter((t) => t.keyId === k.id);
    const pending = mine.find((t) => t.to === username && t.status === 'pending');
    const keyDeadExpired = k.lifecycle === 'expired' || (k.expiresBaseMs && effectiveExpiry(k, now) <= now);
    const keyDeadRevoked = k.lifecycle === 'revoked';
    if (!pending) {
      // 本人的单已因密钥到期终结：按 17:14/17:23 定版回「密钥已过期」（带到期日期，裁决批①）
      if (mine.some((t) => t.to === username && t.status === 'key-expired') || keyDeadExpired) {
        return { ok: false, code: 'KEY_EXPIRED', msg: expiredText(k, now), expiredAt: k.expiresBaseMs ? effectiveExpiry(k, now) : null };
      }
      if (mine.some((t) => t.to === username && t.status === 'expired')) {
        return { ok: false, code: 'TRANSFER_EXPIRED', msg: '该转赠已超过领取期限，请联系对方重新发起。' };
      }
      // —— 本人未激活密钥粘贴激活（#48，站长 2026-10-26 定版）——
      // 购钥一审发放后钥即归属买家本人（未激活）；买家在登录拦截页或
      // 领取入口粘贴本人钥时，与 /license/api/redeem 本人口径一致：
      // 直接激活起算，绝不能以「密钥无效」误拒本人。条件写死：归属
      // 本人＋未激活＋该钥无任何待领取转赠单（有单时仍走下方转赠领
      // 取校验，防口径串扰）；本人钥已生效的回 ALREADY_ACTIVE。
      if (k.username === username && k.lifecycle === 'unactivated'
        && !state.transfers.some((t) => t.keyId === k.id && t.status === 'pending')) {
        ensureAccount(username, now, {});
        activateKey(k, now); // 粘贴即激活：自此刻起算满 N×24 小时
        appendLine(bansLog, { ev: 'key-claim-own-activated', keyId: k.id, username, via: 'key-string-claim', at: now });
        save();
        return { ok: true, keyId: k.id, maskedKey: maskKey(k.str), planName: k.planName, own: true, msg: '激活成功，密钥已开始计时。' };
      }
      if (k.username === username && k.lifecycle === 'activated') {
        return { ok: false, code: 'ALREADY_ACTIVE', msg: '该密钥已在您的账号上生效，无需重复领取。' };
      }
      // —— 未激活密钥转售赎回（裁决批⑦）——
      // 未激活（从未激活起算）付费密钥的转手不走转赠通道：持有字符串者
      // 粘贴提交即完成转手——归属转到粘贴者、此刻激活起算；不置
      // transferredOnce（不消耗转赠次数），原持有者一侧同时失效并按
      // 17:29 同口径置强制下线门（其无其他有效密钥时）。条件写死：
      // 从未激活＋付费来源＋未转赠过＋该钥无任何待领取转赠单（有单则
      // 只能由单上受赠人领取，防字符串外泄抢领他人待领取转赠）。
      const resaleOk = k.lifecycle === 'unactivated' && k.activatedAt == null && k.source === 'paid' && !k.transferredOnce
        && k.username !== username
        && !state.transfers.some((t) => t.keyId === k.id && t.status === 'pending');
      if (resaleOk) {
        const fromUser = k.username;
        ensureAccount(username, now, {});
        const sAcct = ensureAccount(fromUser, now, {});
        sAcct.transferOutGate = { at: now, transferId: null, keyId: k.id, to: username, via: 'resale' };
        k.username = username;
        activateKey(k, now); // 粘贴即激活：自此刻起算满 N×24 小时
        appendLine(bansLog, {
          ev: 'key-resale-redeemed', keyId: k.id, from: fromUser, to: username, via: 'key-string-resale', at: now,
          forceLogout: {
            target: fromUser, gateAfter: 'G1', noGrace: true,
            sessions: [
              { channel: 'web', action: 'close-ws-and-revoke-xid', via: 'meshcentral-close-event+ext-revoked-xid' },
              { channel: 'software-pc', action: 'force-logout', via: 'forceLogout-flag (device-report/login-check/heartbeat)' },
              { channel: 'software-mobile', action: 'force-logout', via: 'forceLogout-flag (device-report/login-check/heartbeat)' },
            ],
          },
        });
        save();
        return { ok: true, keyId: k.id, maskedKey: maskKey(k.str), planName: k.planName, from: fromUser, resale: true, forceLogout: { target: fromUser, gateAfter: 'G1' }, msg: '激活成功，密钥已转入您的账号并开始计时。' };
      }
      // 串不符/非本人转赠单/已撤销已完成：一律同一提示，不透露他人信息
      return { ok: false, code: 'KEY_INVALID', msg: '密钥无效，请核对后重试。' };
    }
    if (keyDeadExpired) {
      // expireTransfers 理应已终结此单；双保险：当场终结并回过期提示（带到期日期，裁决批①）
      if (k.lifecycle === 'unactivated' || k.lifecycle === 'activated') { k.lifecycle = 'expired'; k.timing = 'exhausted'; }
      endTransfer(pending, 'key-expired', 'key-expired', now); save();
      return { ok: false, code: 'KEY_EXPIRED', msg: expiredText(k, now), expiredAt: k.expiresBaseMs ? effectiveExpiry(k, now) : null };
    }
    if (keyDeadRevoked) return { ok: false, code: 'KEY_INVALID', msg: '密钥无效，请核对后重试。' };
    if (k.transferredOnce) return { ok: false, code: 'TRANSFER_USED', msg: '该密钥已转赠过一次，不能再次领取。' };
    if (k.username !== pending.from) return { ok: false, code: 'KEY_INVALID', msg: '密钥无效，请核对后重试。' };
    // 裁决批②（领取侧硬拒之二）：赠方账号处于封禁/冻结状态时，其名下
    // 待领取转赠一律领不了（单保留，赠方状态解除后可继续领取）。
    if (activeBansFor(pending.from, now).length) return { ok: false, code: 'SENDER_BANNED', msg: '转出账号当前状态异常，该密钥暂时无法领取。' };
    // 领取瞬间才转移（17:11/17:23）：此刻才改归属、回未激活、清空槽位、置已转赠标记
    const fromUser = pending.from;
    k.username = username; k.transferredOnce = true; k.slots = { pc: [], mobile: null }; // #26：槽位清空＝pc 空数组＋mobile 空值
    if (k.lifecycle === 'activated') k.lifecycle = 'unactivated';
    pending.status = 'done'; pending.endReason = 'accepted'; pending.decidedAt = now; pending.claimMethod = 'key-string';
    ensureAccount(username, now, {});
    // 同一时点：原主人强制下线＋回 G1（站长 2026-10-25 17:29 定版）。在转出方
    // 账号置 transferOutGate 标记：evaluate 即刻按 G1＋forceLogout 判定、
    // reportDevice/心跳的 forceLogout 通道即刻对软件会话生效；网页会话的
    // 在线 WS 关闭与本站会话撤销由扩展服务在领取响应内同步执行（其结果
    // 回写本指令的执行记录，不另起台账事件）。
    const senderAcct = ensureAccount(fromUser, now, {});
    senderAcct.transferOutGate = { at: now, transferId: pending.id, keyId: k.id, to: username };
    // 台账只记一条完整事件：领取完成＋原主人会话强制登出清单（17:29 第 3 条）
    appendLine(bansLog, {
      ev: 'transfer-claim-completed', transferId: pending.id, keyId: k.id, from: fromUser, to: username, via: 'key-string-claim', at: now,
      forceLogout: {
        target: fromUser, gateAfter: 'G1', noGrace: true,
        sessions: [
          { channel: 'web', action: 'close-ws-and-revoke-xid', via: 'meshcentral-close-event+ext-revoked-xid' },
          { channel: 'software-pc', action: 'force-logout', via: 'forceLogout-flag (device-report/login-check/heartbeat)' },
          { channel: 'software-mobile', action: 'force-logout', via: 'forceLogout-flag (device-report/login-check/heartbeat)' },
        ],
      },
    });
    save();
    return { ok: true, keyId: k.id, maskedKey: maskKey(k.str), planName: k.planName, from: fromUser, forceLogout: { target: fromUser, gateAfter: 'G1' } };
  }
  // 待领取清单（完整串版）：仅供状态查询页在账号＋密码核验通过后调用——
  // 这是密钥原文红线的既定例外（仅回本人、本次响应、不落日志，口径同
  // §6 验密看全串）。控制台会话侧的 listTransfers 仍只回掩码，不得混用。
  function listClaimableTransfers(username, now) {
    expireTransfers(now);
    const ttl = transferTtlMs();
    return state.transfers.filter((t) => t.to === username && t.status === 'pending').map((t) => {
      const k = state.keys[t.keyId];
      if (!k) return null;
      return {
        id: t.id, keyId: t.keyId, from: t.from, planName: k.planName, keyStr: k.str, masked: maskKey(k.str),
        createdAt: t.createdAt, expiresAt: t.createdAt + ttl,
        keyExpiresMs: k.expiresBaseMs ? effectiveExpiry(k, now) : null,
        source: k.source, everBanned: !!k.everBanned,
      };
    }).filter(Boolean);
  }

  // 转赠列表视图（收到的待领取＋我发起的含终结状态；密钥过期终结的单不进
  // 受赠方待领取列表——buildStatusView/接口层按 status==='pending' 过滤即可，
  // 这里统一给出带状态与事由的清单供三端同口径展示；本视图只回掩码）
  function listTransfers(username, now) {
    expireTransfers(now);
    const ttl = transferTtlMs();
    const brief = (t) => {
      const k = state.keys[t.keyId];
      return {
        id: t.id, keyId: t.keyId, from: t.from, to: t.to, status: t.status,
        endReason: t.endReason || (t.status === 'expired' ? 'timeout' : (t.status === 'rejected' ? 'rejected' : (t.status === 'done' ? 'accepted' : null))),
        createdAt: t.createdAt, decidedAt: t.decidedAt || null,
        expiresAt: t.status === 'pending' ? t.createdAt + ttl : null,
        planName: k ? k.planName : '', masked: k ? maskKey(k.str) : '',
        keyExpiresMs: k && k.expiresBaseMs ? effectiveExpiry(k, now) : null,
      };
    };
    return {
      incoming: state.transfers.filter((t) => t.to === username && t.status === 'pending').map(brief),
      outgoing: state.transfers.filter((t) => t.from === username).sort((a, b) => b.createdAt - a.createdAt).slice(0, 20).map(brief),
    };
  }

  // ---------- 封禁保留期（16:53 裁决：B9/永封封禁保留 1 年后清除） ----------
  const SEAL_RETENTION_MS = 365 * 86400000;
  function sealedExpired(now, hasPendingAppeal) {
    const out = [];
    for (const b of state.bans) {
      if (b.status !== 'active' || !b.permanent || b.targetType !== 'account') continue;
      if (!['B9', 'B6', 'B7', 'B10'].includes(b.code)) continue;
      if (now - b.startsAt < SEAL_RETENTION_MS) continue;
      if (b.purgedAt) continue;
      if (hasPendingAppeal && hasPendingAppeal(b.target)) continue;
      out.push(b);
    }
    return out;
  }
  function markPurged(ban, now) {
    ban.purgedAt = now; ban.status = 'purged';
    appendLine(bansLog, { ev: 'sealed-purged', banId: ban.id, target: ban.target, at: now });
    save();
  }

  // 「剩余时长」统一文案（2026-10-26 显示普查定版）：未激活限时钥必须显示
  // 未激活＋自激活起 N 小时，绝不许落「长期有效」；已激活限时钥返回 null，
  // 由端上按 keyExpiresMs 实时折算（保证倒计时新鲜）；已激活永久＝长期有效。
  function remainTextForKey(k, now) {
    if (!k) return null;
    const plan = PLANS[k.plan];
    if (k.lifecycle === 'unactivated') {
      return plan && plan.days ? ('未激活（自激活起 ' + plan.days * 24 + ' 小时有效）') : '未激活（激活后长期有效）';
    }
    if (k.lifecycle === 'activated') return k.expiresBaseMs ? null : '长期有效';
    if (k.lifecycle === 'expired') return '已过期';
    if (k.lifecycle === 'revoked') return '已收回';
    return null;
  }

  // ---------- 状态视图（§10） ----------
  function buildStatusView(username, now) {
    expireBans(now); lazyExpireKeys(username, now);
    const acct = state.accounts[username];
    const keys = accountKeys(username);
    const primary = primaryKeyOf(keys, now); // 裁决批⑤：永久优先＞剩余最长＞最新
    const bans = activeBansFor(username, now);
    const perm = bans.find((b) => b.permanent);
    const timed = bans[0];
    let displayStatus = '正常', statusNote = '';
    if (perm) { displayStatus = '已封禁'; statusNote = '原因类别：' + perm.code + (perm.endsAt ? '' : '（永久）') + '。如对处理结果有异议，可提交申诉。'; }
    else if (timed) {
      const days = timed.endsAt ? Math.max(1, Math.round((timed.endsAt - startOfDayMs(dayKey(now))) / 86400000)) : 0;
      const isFreezeCode = ['B1', 'B8', 'B10'].includes(timed.code) && !timed.permanent;
      displayStatus = isFreezeCode ? '已冻结' : ('已封禁（' + days + '天）');
      statusNote = '到期时间：' + fmtShanghai(timed.endsAt) + '。如对处理结果有异议，可提交申诉。';
    } else {
      const ev = evaluate(username, now, { channel: 'software' });
      if (ev.code === 'G1') { displayStatus = '未激活'; statusNote = '软件已升级为一次性付费版本，购买密钥激活后即可使用。'; }
      else if (ev.code === 'G2') { displayStatus = '试用已到期'; statusNote = '3 天免费试用已到期，购买密钥后即可继续使用。'; }
      else if (ev.code === 'G5') { displayStatus = '密钥已过期'; const exp = primary && primary.expiresBaseMs ? effectiveExpiry(primary, now) : null; statusNote = (exp ? '密钥已于 ' + fmtDateCn(exp) + ' 到期并收回，' : '密钥已到期并收回，') + '购买新密钥后即可继续使用。'; }
    }
    const validPaid = activeKeys(username, now).some((k) => k.source === 'paid');
    return {
      username, projectName: 'QFRemote',
      planName: primary ? primary.planName : 'QFRemote 试用套餐', // 16:56 命名口径：无密钥账号套餐名一律此名
      maskedKey: primary ? maskKey(primary.str) : '—',
      keyCreatedAt: primary ? primary.createdAt : null,
      displayStatus, statusNote,
      // #26 名额形状：新增 pcUsed/pcMax/mobileUsed/mobileMax；旧 pc/mobile
      // 数字字段（＝已用数量）保留，兼容三端按旧形状的渲染（见回报兼容结论）
      slots: primary
        ? { pc: slotCount(primary, 'pc'), mobile: slotCount(primary, 'mobile'), pcUsed: slotCount(primary, 'pc'), pcMax: SLOT_CAPS.pc, mobileUsed: slotCount(primary, 'mobile'), mobileMax: SLOT_CAPS.mobile }
        : { pc: 0, mobile: 0, pcUsed: 0, pcMax: SLOT_CAPS.pc, mobileUsed: 0, mobileMax: SLOT_CAPS.mobile },
      everBanned: !!(primary && primary.everBanned),
      webEnabled: validPaid,
      trialExpiresMs: acct && acct.trial ? acct.trial.expiresMs : null,
      keyExpiresMs: primary && primary.expiresBaseMs ? effectiveExpiry(primary, now) : null,
      activeBan: bans.length ? { code: bans[0].code, permanent: !!bans[0].permanent, endsAt: bans[0].endsAt, id: bans[0].id } : null,
      hasKey: !!primary, keyId: primary ? primary.id : null,
      // 显示普查补字段（2026-10-26）：主钥生命周期/套餐/来源/时长小时数与
      // 服务端统一剩余时长文案——端上不得再凭 keyExpiresMs 是否为空猜永久。
      keyLifecycle: primary ? primary.lifecycle : null,
      keyPlan: primary ? primary.plan : null,
      keySource: primary ? primary.source : null,
      keyDurationHours: primary && PLANS[primary.plan] && PLANS[primary.plan].days ? PLANS[primary.plan].days * 24 : null,
      remainText: remainTextForKey(primary, now),
    };
  }

  function audit(ev) { state.audit.push(Object.assign({ at: Date.now() }, ev)); if (state.audit.length > 1000) state.audit = state.audit.slice(-1000); save(); }

  return {
    PLANS, readConfig, save, ensureAccount, accountKeys, activeKeys, effectiveExpiry,
    activeBansFor, activeDeviceBan, applyBan, liftBan, expireBans, syncAccountLinkage,
    issueKey, evaluate, reportDevice, bindKey, registerCheck, registerSuccess,
    createOrder, simPayCallback, buildStatusView, audit, maskKey, state: () => state,
    grantPurchase, initiateTransfer, confirmTransfer, rejectTransfer, cancelTransfer, listTransfers, expireTransfers, transferTtlMs, claimByKeyString, listClaimableTransfers, forceLogoutState, decideDeviceReview, overrideDeviceReview, sealedExpired, markPurged,
    activateKey, primaryKeyOf, expiredText, remainTextForKey,
    rebindEligibility, rebindEligibilityByHash, executeRebind, executeRebindByHash,
    shadowLog,
    getBan: (id) => state.bans.find((b) => b.id === id) || null,
    adjustBanEnds: (id, endsAt, now) => { const b = state.bans.find((x) => x.id === id); if (b && b.status === 'active') { b.endsAt = endsAt; save(); } return b || null; },
    setContact: (username, email, now) => { ensureAccount(username, now, {}); state.accounts[username].contactEmail = email; save(); },
    getContact: (username) => (state.accounts[username] && state.accounts[username].contactEmail) || null,
    _file: stateFile,
  };
}

module.exports = { createLicenseCore, PLANS, maskKey, dayKey, startOfDayMs, fmtShanghai, sha };
