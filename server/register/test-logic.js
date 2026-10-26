'use strict';
/*
 * 注册服务纯逻辑自测（不启服务、不连 MeshCentral）：
 * 上海日界/次日 0 点、失败累计到第 6 次触发封禁、封禁到期自动解除、
 * 跨日计数清零、账号规则（10:41：≥8 位、字母+数字都要有）、密码暂定规则（≥8 位）。
 * 跑法：node test-logic.js，退出码 0=全过。
 */
const S = require('./server');

const out = { cases: {}, pass: false };
const t = (name, cond) => { out.cases[name] = !!cond; };

// 时间：2026-10-24 10:00 北京时间 = 02:00 UTC
const nowUtc = Date.parse('2026-10-24T02:00:00Z');
t('daykey_is_shanghai_date', S.shanghaiDayKey(nowUtc) === '2026-10-24');
// 2026-10-24 23:30 北京时间 = 15:30 UTC，日界仍是 24 日；次日 0 点 = 24 日 16:00 UTC
t('daykey_late_evening', S.shanghaiDayKey(Date.parse('2026-10-24T15:30:00Z')) === '2026-10-24');
t('daykey_after_midnight_shanghai', S.shanghaiDayKey(Date.parse('2026-10-24T16:00:01Z')) === '2026-10-25');
const mid = S.nextShanghaiMidnightMs(nowUtc);
t('next_midnight_is_next_day_0000_plus08', mid === Date.parse('2026-10-25T00:00:00+08:00'));

// 封禁状态机
let rec = { day: S.shanghaiDayKey(nowUtc), fails: 0, bannedUntil: null };
for (let i = 0; i < 5; i++) {
  const r = S.applyFailure(rec, nowUtc);
  if (r.justBanned) { rec._earlyBan = true; }
}
t('no_ban_at_5_failures', !rec._earlyBan && rec.fails === 5 && !rec.bannedUntil);
const r6 = S.applyFailure(rec, nowUtc);
t('ban_triggers_on_6th_failure', r6.justBanned === true && rec.bannedUntil === mid);
t('banned_during_window', S.checkBan(rec, nowUtc + 3600000).banned === true);
const after = S.checkBan(rec, mid + 1000);
t('ban_auto_releases_next_day', after.banned === false && after.expired === true && rec.fails === 0 && rec.bannedUntil === null);
// 跨日：新的一天计数从零
let rec2 = { day: '2026-10-23', fails: 4, bannedUntil: null };
S.rollDay(rec2, nowUtc);
t('new_day_resets_counter', rec2.day === '2026-10-24' && rec2.fails === 0);

// 账号规则（2026-10-24 10:41 用户亲定）
t('username_ok', S.validateUsernameInput('ZhangSan88').ok === true && S.validateUsernameInput('ZhangSan88').name === 'zhangsan88');
t('username_too_short', S.validateUsernameInput('abc123').ok === false);
t('username_no_letter', S.validateUsernameInput('12345678').ok === false);
t('username_no_digit', S.validateUsernameInput('abcdefgh').ok === false);
t('username_symbol_rejected', S.validateUsernameInput('zhangsan_88').ok === false);
t('username_space_rejected', S.validateUsernameInput('zhang san88').ok === false);
t('username_too_long', S.validateUsernameInput('a1'.repeat(17)).ok === false);
// 密码暂定规则：最少 8 位
t('password_ok_letters_only', S.validatePasswordInput('abcdefgh', 'abcdefgh', 'x').ok === true);
t('password_ok_digits_only', S.validatePasswordInput('12345678', '12345678', 'x').ok === true);
t('password_mismatch', S.validatePasswordInput('abc12345', 'abc12346', 'x').ok === false);
t('password_too_short', S.validatePasswordInput('ab12', 'ab12', 'x').ok === false);

out.pass = Object.values(out.cases).every(Boolean);
console.log(JSON.stringify(out, null, 2));
process.exit(out.pass ? 0 : 1);
