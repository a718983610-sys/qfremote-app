'use strict';
/*
 * QFRemote 扩展服务 · 积分计时纯逻辑（可单测，无 IO、无第三方依赖）
 * ================================================================
 * 口径（2.2.0 任务书冻结）：
 *  - 服务器时钟计账：心跳 delta = now - lastBeat（账号级，全端共用一个
 *    lastBeat，所以同账号多端同时在线也只按墙钟计一次，不重复计）。
 *  - 单次 delta 上限 90 秒；间隔超过 180 秒不补（只更新 lastBeat 基准）。
 *  - 积分 points = floor(总秒数 / 7200)（2 小时 1 分）。
 *  - 已用天数 daysUsed = 首次记录日到今天的日历天数（Asia/Shanghai，
 *    当天记 1 天，含首尾）。
 *  - 展示文案 displayText：<365 天「使用该软件已经X天」；否则
 *    「使用该软件已经Y年ZZ天」（剩余天数补零两位，367 天 → 1年02天）。
 */

const MAX_DELTA_SEC = 90;   // 单次心跳最多计 90 秒
const MAX_GAP_SEC = 180;    // 间隔超过 180 秒不补计

function shanghaiDayKey(ms) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}

// 两个 'YYYY-MM-DD' 日历日之间相差几天（按 UTC 解析日期串，纯日历差）
function dayDiff(firstDay, day) {
  const a = Date.parse(firstDay + 'T00:00:00Z');
  const b = Date.parse(day + 'T00:00:00Z');
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.round((b - a) / 86400000);
}

function daysUsedFrom(firstDay, nowMs) {
  if (!firstDay) return 0;
  const d = dayDiff(firstDay, shanghaiDayKey(nowMs)) + 1; // 含首尾：当天记 1 天
  return d < 1 ? 1 : d;
}

function formatDisplayText(daysUsed) {
  const d = Math.max(0, Math.floor(daysUsed || 0));
  if (d < 365) return '使用该软件已经' + d + '天';
  const years = Math.floor(d / 365);
  const rest = d % 365;
  return '使用该软件已经' + years + '年' + String(rest).padStart(2, '0') + '天';
}

function newRecord(nowMs) {
  return { totalSeconds: 0, lastBeat: 0, firstDay: shanghaiDayKey(nowMs), createdAt: new Date(nowMs).toISOString(), lastClient: '' };
}

/*
 * 应用一次心跳（就地修改 rec），返回本次计入的秒数。
 * - 无 lastBeat（首次）：只立基准，不计账。
 * - delta <= 0（时钟回拨/同刻重复）：计 0，基准不动（防回拨刷分）。
 * - 0 < delta <= 180s：计入 min(delta, 90)。
 * - delta > 180s：计 0（不补），基准推进到 now。
 */
function applyHeartbeat(rec, nowMs) {
  if (!rec.firstDay) rec.firstDay = shanghaiDayKey(nowMs);
  if (!rec.lastBeat) { rec.lastBeat = nowMs; return 0; }
  const deltaSec = (nowMs - rec.lastBeat) / 1000;
  if (deltaSec <= 0) return 0;
  if (deltaSec > MAX_GAP_SEC) { rec.lastBeat = nowMs; return 0; }
  const add = Math.min(deltaSec, MAX_DELTA_SEC);
  rec.totalSeconds += add;
  rec.lastBeat = nowMs;
  return add;
}

function computeMe(user, rec, nowMs) {
  if (!rec) {
    return { user, points: 0, totalSeconds: 0, daysUsed: 0, displayText: formatDisplayText(0) };
  }
  const totalSeconds = Math.floor(rec.totalSeconds || 0);
  const daysUsed = daysUsedFrom(rec.firstDay, nowMs);
  return {
    user,
    // #23 起积分以余额账为准；未迁移记录回落旧口径（累计秒数/7200）展示。
    points: (rec.earn && rec.earn.balance != null) ? rec.earn.balance : Math.floor(totalSeconds / 7200),
    totalSeconds,
    daysUsed,
    displayText: formatDisplayText(daysUsed),
  };
}

/* ================================================================
 * 赚取账（站长 2026-10-25 #23 定版 + 23-补）：
 *  - 每日签到 1 分（每日一次）；使用软件每满 1 小时 1 分，计时以
 *    服务器心跳在线秒数为准（客户端改时间无效），不做闲置检测——
 *    保持在线即计（23-补撤销挂机排除）。
 *  - 每日总上限 10 分（签到＋使用合计），账号与设备双维度封顶：
 *    任一维度当日已发满 10 分，当日不再计分。
 *  - 余额可消费（福利中心兑换密钥）；旧口径存量积分按
 *    floor(累计秒数/7200) 一次性迁入余额，不清零。
 * 设备维度键：调用方传入的心跳设备键（服务端由设备上报回填的
 * 设备哈希；未知时以 'acct:<账号>' 兜底，账号封顶仍独立生效）。
 * ================================================================ */
const DAILY_CAP = 10;
function blankDayBucket() { return { granted: 0, usageSec: 0, usageGranted: 0, devices: {} }; }
function blankDevBucket() { return { granted: 0, usageSec: 0, usageGranted: 0 }; }
function ensureEarn(rec, nowMs) {
  if (!rec.earn || typeof rec.earn !== 'object') rec.earn = { balance: null, checkinDay: '', days: {}, ledger: [] };
  const e = rec.earn;
  if (e.balance == null) { e.balance = Math.floor((rec.totalSeconds || 0) / 7200); e.migratedAt = nowMs; }
  if (!e.days || typeof e.days !== 'object') e.days = {};
  if (!Array.isArray(e.ledger)) e.ledger = [];
  const today = shanghaiDayKey(nowMs);
  const yest = shanghaiDayKey(nowMs - 86400000);
  for (const k of Object.keys(e.days)) if (k !== today && k !== yest) delete e.days[k];
  if (!e.days[today]) e.days[today] = blankDayBucket();
  return e;
}
function devBucketOf(day, deviceKey, sharedDevices, dayKeyStr) {
  // 设备维度必须跨账号汇总：服务端传入共享设备桶（pointsData.deviceDays，
  // 按设备键存当日计数、跨日自动重置）；无共享桶时回落账号内桶（单测/兼容）。
  if (sharedDevices && typeof sharedDevices === 'object') {
    const k = deviceKey || 'acct';
    let b = sharedDevices[k];
    if (!b || b.day !== dayKeyStr) { b = blankDevBucket(); b.day = dayKeyStr; sharedDevices[k] = b; }
    return b;
  }
  const k = deviceKey || 'acct';
  if (!day.devices[k]) day.devices[k] = blankDevBucket();
  return day.devices[k];
}
function pushLedger(e, entry) {
  e.ledger.push(entry);
  if (e.ledger.length > 200) e.ledger = e.ledger.slice(-200);
}
function grantOne(rec, e, day, dev, kind, nowMs) {
  e.balance += 1; day.granted += 1; dev.granted += 1;
  pushLedger(e, { at: nowMs, kind, delta: 1, balance: e.balance });
}
// 心跳计入在线秒数后调用：账号/设备两桶同步累计，每满 1 小时发 1 分（双封顶拦截）
function earnHeartbeat(rec, deviceKey, addedSec, nowMs, sharedDevices) {
  if (!rec || !(addedSec > 0)) return { grantedNow: 0 };
  const e = ensureEarn(rec, nowMs);
  const dayKeyStr = shanghaiDayKey(nowMs);
  const day = e.days[dayKeyStr];
  const dev = devBucketOf(day, deviceKey, sharedDevices, dayKeyStr);
  day.usageSec += addedSec; dev.usageSec += addedSec;
  let grantedNow = 0;
  while (Math.floor(day.usageSec / 3600) > day.usageGranted) {
    if (day.granted >= DAILY_CAP || dev.granted >= DAILY_CAP) break; // 到顶当日不再计分
    day.usageGranted += 1; dev.usageGranted += 1;
    grantOne(rec, e, day, dev, 'usage', nowMs);
    grantedNow += 1;
  }
  return { grantedNow };
}
function earnCheckin(rec, deviceKey, nowMs, sharedDevices) {
  const e = ensureEarn(rec, nowMs);
  const today = shanghaiDayKey(nowMs);
  if (e.checkinDay === today) return { ok: false, code: 'ALREADY_CHECKED_IN', msg: '今日已签到。' };
  const day = e.days[today];
  const dev = devBucketOf(day, deviceKey, sharedDevices, today);
  if (day.granted >= DAILY_CAP || dev.granted >= DAILY_CAP) return { ok: false, code: 'DAILY_CAP', msg: '今日积分已达上限（10 分），签到积分明日再领。' };
  e.checkinDay = today;
  grantOne(rec, e, day, dev, 'checkin', nowMs);
  return { ok: true, balance: e.balance };
}
function earnSpend(rec, amount, note, nowMs) {
  const e = ensureEarn(rec, nowMs);
  const amt = Math.floor(Number(amount) || 0);
  if (amt <= 0) return { ok: false, code: 'VALIDATION' };
  if (e.balance < amt) return { ok: false, code: 'INSUFFICIENT', msg: '积分不足。', balance: e.balance };
  e.balance -= amt;
  pushLedger(e, { at: nowMs, kind: 'spend', delta: -amt, balance: e.balance, note: String(note || '').slice(0, 80) });
  return { ok: true, balance: e.balance };
}
function earnView(rec, deviceKey, nowMs, sharedDevices) {
  const e = ensureEarn(rec, nowMs);
  const today = shanghaiDayKey(nowMs);
  const day = e.days[today];
  const dev = devBucketOf(day, deviceKey, sharedDevices, today);
  return {
    balance: e.balance,
    todayGranted: day.granted, todayCap: DAILY_CAP,
    checkinDone: e.checkinDay === today,
    usageSecToday: Math.floor(day.usageSec), usageGrantedToday: day.usageGranted,
    deviceGrantedToday: dev.granted,
    nextPointInSec: Math.max(0, 3600 - (Math.floor(day.usageSec) % 3600)),
    ledger: e.ledger.slice(-30).reverse(),
  };
}

module.exports = { MAX_DELTA_SEC, MAX_GAP_SEC, shanghaiDayKey, dayDiff, daysUsedFrom, formatDisplayText, newRecord, applyHeartbeat, computeMe, DAILY_CAP, ensureEarn, earnHeartbeat, earnCheckin, earnSpend, earnView };
