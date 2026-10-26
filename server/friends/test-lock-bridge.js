'use strict';
// 隐私锁桥 lastEvents 对账读取回归（线 B 报告 §8 的既有 bug）：
// 组件 Go 侧 status.json 的 lastEvents 写 {ts, ev, fields}，桥旧代码按
// {time, type} 读 → arm/disarm/reset 的拒绝事件读不到。本测试钉死：
// 以 ev/ts 为准、兼容旧 type/time，两套键都能正确映射对账结果。
const B = require('./lock-bridge');
const { findRejectedEvent, hasEvent, normalizeEvent } = B._test;
let pass = 0, fail = 0;
function t(name, cond) { if (cond) { pass++; console.log('ok  -', name); } else { fail++; console.log('FAIL-', name); } }

const ENV_ID = 'env-test-1';

// --- 拒绝事件：组件实际格式（ev/ts 键）必须能被桥读到并映射出 reason
const statusGo = {
  state: 'Off',
  lastEvents: [
    { ts: '2026-10-26T00:00:01Z', ev: 'envelope-rejected', fields: { id: 'other-env', reason: 'expired' } },
    { ts: '2026-10-26T00:00:02Z', ev: 'envelope-rejected', fields: { id: ENV_ID, reason: 'bad-signature' } },
  ],
};
t('拒绝事件(ev/ts 键)能读到且 reason 映射正确', findRejectedEvent(statusGo, ENV_ID) === 'bad-signature');
t('拒绝事件只认本信封 id', findRejectedEvent(statusGo, 'no-such-env') === null);
t('拒绝事件(ev/ts 键、无 reason)映射为空串而非 null', findRejectedEvent({ lastEvents: [{ ts: '2026-10-26T00:00:03Z', ev: 'envelope-rejected', fields: { id: ENV_ID } }] }, ENV_ID) === '');

// --- 拒绝事件：旧格式（type/time 键）继续兼容
const statusLegacy = {
  lastEvents: [
    { time: '2026-10-26T00:00:02Z', type: 'envelope-rejected', fields: { id: ENV_ID, reason: 'unknown-op' } },
  ],
};
t('拒绝事件(type/time 旧键)仍能读到', findRejectedEvent(statusLegacy, ENV_ID) === 'unknown-op');

// --- 成功事件对账：arm / remote-reset（ev 键 + fields 比对，与桥内调用同款 pred）
const statusArm = { lastEvents: [{ ts: '2026-10-26T00:01:00Z', ev: 'arm', fields: { armId: ENV_ID } }] };
t('arm 事件(ev 键)对账命中', hasEvent(statusArm, 'arm', (ev) => ev.fields && ev.fields.armId === ENV_ID) === true);
t('arm 事件 armId 不符不对账', hasEvent(statusArm, 'arm', (ev) => ev.fields && ev.fields.armId === 'other') === false);
const statusReset = { lastEvents: [{ ts: '2026-10-26T00:02:00Z', ev: 'remote-reset', fields: { id: ENV_ID } }] };
t('remote-reset 事件(ev 键)对账命中', hasEvent(statusReset, 'remote-reset', (ev) => ev.fields && ev.fields.id === ENV_ID) === true);

// --- disarm 时间对账：桥内 pred 读 ev.time，事件只有 ts 时归一化后必须成立
const since = Date.parse('2026-10-26T00:03:00Z') - 5000;
const statusDisarmNew = { lastEvents: [{ ts: '2026-10-26T00:03:10Z', ev: 'disarm', fields: {} }] };
t('disarm 事件(只有 ts)经归一化后时间 pred 成立', hasEvent(statusDisarmNew, 'disarm', (ev) => !ev.time || Date.parse(ev.time) >= since) === true);
const statusDisarmOld = { lastEvents: [{ ts: '2026-10-26T00:01:00Z', ev: 'disarm', fields: {} }] };
t('disarm 事件早于 since 不算本次对账', hasEvent(statusDisarmOld, 'disarm', (ev) => !ev.time || Date.parse(ev.time) >= since) === false);
const statusDisarmLegacy = { lastEvents: [{ time: '2026-10-26T00:03:10Z', type: 'disarm', fields: {} }] };
t('disarm 事件(type/time 旧键)仍对账', hasEvent(statusDisarmLegacy, 'disarm', (ev) => !ev.time || Date.parse(ev.time) >= since) === true);

// --- 归一化本身：两套键都补齐、原对象不被改写
const raw = { ts: '2026-10-26T00:00:02Z', ev: 'arm', fields: { armId: 'x' } };
const norm = normalizeEvent(raw);
t('normalizeEvent 补齐 type/time 且保留 ev/ts/fields', norm.type === 'arm' && norm.time === raw.ts && norm.ev === 'arm' && norm.ts === raw.ts && norm.fields.armId === 'x');
t('normalizeEvent 不改写原对象', raw.type === undefined && raw.time === undefined);

// --- 空/坏输入不炸
t('status 为空时 findRejectedEvent=null、hasEvent=false', findRejectedEvent(null, ENV_ID) === null && hasEvent(null, 'arm', () => true) === false);
t('lastEvents 缺失时同上', findRejectedEvent({}, ENV_ID) === null && hasEvent({}, 'arm', () => true) === false);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
