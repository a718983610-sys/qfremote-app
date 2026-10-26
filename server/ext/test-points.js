'use strict';
/* 积分计时/格式化单元自测：node test-points.js（伪造时钟序列） */
const assert = require('assert');
const core = require('./points-core');

let passed = 0;
function ok(name, fn) { fn(); passed++; console.log('PASS ' + name); }

const T0 = Date.parse('2026-10-25T02:00:00Z'); // 上海 10:00

ok('首次心跳只立基准不计账，第二次起计', () => {
  const r = core.newRecord(T0);
  assert.strictEqual(core.applyHeartbeat(r, T0), 0);
  assert.strictEqual(core.applyHeartbeat(r, T0 + 30000), 30);
  assert.strictEqual(core.applyHeartbeat(r, T0 + 60000), 30);
  assert.strictEqual(r.totalSeconds, 60);
});

ok('并发双端同账号去重：交错心跳只按墙钟计一次', () => {
  const r = core.newRecord(T0);
  core.applyHeartbeat(r, T0);                    // A 端首跳
  core.applyHeartbeat(r, T0 + 5000);             // B 端 5 秒后首跳（同一账号记录）
  core.applyHeartbeat(r, T0 + 35000);            // A 端
  core.applyHeartbeat(r, T0 + 40000);            // B 端
  assert.strictEqual(r.totalSeconds, 40);        // 墙钟 40 秒，不是双倍 80
});

ok('单次 delta 上限 90 秒：间隔 120 秒只计 90', () => {
  const r = core.newRecord(T0);
  core.applyHeartbeat(r, T0);
  assert.strictEqual(core.applyHeartbeat(r, T0 + 120000), 90);
  assert.strictEqual(r.totalSeconds, 90);
});

ok('长间隔不补：间隔 181 秒计 0，之后恢复正常计账', () => {
  const r = core.newRecord(T0);
  core.applyHeartbeat(r, T0);
  core.applyHeartbeat(r, T0 + 30000);
  assert.strictEqual(core.applyHeartbeat(r, T0 + 30000 + 181000), 0);
  assert.strictEqual(r.totalSeconds, 30);
  assert.strictEqual(core.applyHeartbeat(r, T0 + 30000 + 181000 + 30000), 30);
  assert.strictEqual(r.totalSeconds, 60);
});

ok('心跳缺口（整段离线）不补：间隔 1 小时计 0', () => {
  const r = core.newRecord(T0);
  core.applyHeartbeat(r, T0);
  assert.strictEqual(core.applyHeartbeat(r, T0 + 3600000), 0);
  assert.strictEqual(r.totalSeconds, 0);
});

ok('时钟回拨/同刻重复计 0 且基准不倒退', () => {
  const r = core.newRecord(T0);
  core.applyHeartbeat(r, T0);
  core.applyHeartbeat(r, T0 + 30000);
  assert.strictEqual(core.applyHeartbeat(r, T0 + 10000), 0);
  assert.strictEqual(core.applyHeartbeat(r, T0 + 60000), 30);
  assert.strictEqual(r.totalSeconds, 60);
});

ok('积分换算：floor(总秒/7200)', () => {
  const r = core.newRecord(T0);
  r.totalSeconds = 7199; assert.strictEqual(core.computeMe('u', r, T0).points, 0);
  r.totalSeconds = 7200; assert.strictEqual(core.computeMe('u', r, T0).points, 1);
  r.totalSeconds = 7200 * 3 + 100; assert.strictEqual(core.computeMe('u', r, T0).points, 3);
});

ok('已用天数：首次记录当天记 1 天（上海日历）', () => {
  const r = core.newRecord(T0);
  assert.strictEqual(core.computeMe('u', r, T0).daysUsed, 1);
  assert.strictEqual(core.computeMe('u', r, T0 + 86400000).daysUsed, 2);
});

ok('文案格式：364 天纯天数 / 365 天进年 / 367 天 → 1年02天', () => {
  assert.strictEqual(core.formatDisplayText(0), '使用该软件已经0天');
  assert.strictEqual(core.formatDisplayText(364), '使用该软件已经364天');
  assert.strictEqual(core.formatDisplayText(365), '使用该软件已经1年00天');
  assert.strictEqual(core.formatDisplayText(367), '使用该软件已经1年02天');
  assert.strictEqual(core.formatDisplayText(365 * 2 + 5), '使用该软件已经2年05天');
});

ok('367 天全链路：firstDay 在 366 个日历日前 → daysUsed 367 → 文案 1年02天', () => {
  const r = core.newRecord(T0);
  r.firstDay = core.shanghaiDayKey(T0 - 366 * 86400000);
  const me = core.computeMe('u', r, T0);
  assert.strictEqual(me.daysUsed, 367);
  assert.strictEqual(me.displayText, '使用该软件已经1年02天');
});

ok('无记录用户 me 全零', () => {
  const me = core.computeMe('nobody', null, T0);
  assert.deepStrictEqual(me, { user: 'nobody', points: 0, totalSeconds: 0, daysUsed: 0, displayText: '使用该软件已经0天' });
});

console.log('全部通过：' + passed + ' 项');
