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

const { createResetPwLimiter, RESET_PW_MAX_FAILS, RESET_PW_LOCK_MS } = B._test;

// --- H28：/lock/reset 验登录密码限流 ---
// 可控时钟：每步推进 1 分钟，便于测窗口与锁期满释放。
let _now = 1000000000000;
const lim = createResetPwLimiter(() => _now);
const tick = (min) => { _now += min * 60000; };
t('H28 初始不限流', lim.check('alice').locked === false);
for (let i = 1; i <= 4; i++) { const r = lim.noteFail('alice'); tick(1); t('H28 第 ' + i + ' 次失败不限流（fails=' + r.fails + '）', r.locked === false && lim.check('alice').locked === false); }
const fifth = lim.noteFail('alice');
t('H28 第 5 次失败即上锁', fifth.locked === true && fifth.fails === RESET_PW_MAX_FAILS);
t('H28 锁内 check 返回 locked', lim.check('alice').locked === true && lim.check('alice').retryAfterSec > 0);
t('H28 锁内其他账号不受影响', lim.check('bob').locked === false);
t('H28 账号大小写不敏感（ALICE 同锁）', lim.check('ALICE').locked === true);
tick(14);
t('H28 锁期 14 分钟后仍锁', lim.check('alice').locked === true);
tick(2);
t('H28 锁期满（15 分钟）后自动释放', lim.check('alice').locked === false);
lim.noteFail('alice'); lim.noteFail('alice');
t('H28 释放后重新计数（2 次失败不限流）', lim.check('alice').locked === false);
lim.clear('alice');
t('H28 clear 清零（验密成功路径）', lim.check('alice').locked === false && lim.noteFail('alice').fails === 1);
// 窗口外失败不累积：首次失败 16 分钟后再失败，应从 1 重新计，
// 同窗口内再失败一次则计为 2（两次返回值分开断言，不只看最后一次）。
lim.clear('alice');
const winFirst = lim.noteFail('alice');
t('H28 窗口内首次失败 fails=1', winFirst.fails === 1 && winFirst.locked === false);
tick(16);
const winReset = lim.noteFail('alice');
t('H28 窗口外失败重新计数（新窗口首个为 1）', winReset.fails === 1 && winReset.locked === false && lim.check('alice').locked === false);
const winSecond = lim.noteFail('alice');
t('H28 新窗口内第 2 次失败计为 2', winSecond.fails === 2 && lim.check('alice').locked === false);
// 并发占位：同一账号同时只验一个密码（DS round 1）。
t('H28 tryBegin 首次占位成功', lim.tryBegin('carol') === true);
t('H28 tryBegin 并发同账号占位失败', lim.tryBegin('CAROL') === false);
t('H28 tryBegin 其他账号不受影响', lim.tryBegin('dave') === true);
lim.end('carol');
t('H28 end 释放占位后可再占位', lim.tryBegin('carol') === true);
lim.end('carol'); lim.end('dave');

// --- 空/坏输入不炸
t('status 为空时 findRejectedEvent=null、hasEvent=false', findRejectedEvent(null, ENV_ID) === null && hasEvent(null, 'arm', () => true) === false);
t('lastEvents 缺失时同上', findRejectedEvent({}, ENV_ID) === null && hasEvent({}, 'arm', () => true) === false);

// --- pkg3 #6：设备 pin（机主＋公钥指纹服务端 pin） ---
const { createDevicePinStore, fingerprintPublicKey } = B._test;
const KEY_A = '-----BEGIN PUBLIC KEY-----\nAAAACgAAAAB\n-----END PUBLIC KEY-----';
const KEY_B = '-----BEGIN PUBLIC KEY-----\nBBBBDgAAAAC\n-----END PUBLIC KEY-----';
const FP_A = fingerprintPublicKey(KEY_A);
t('pin 指纹：同钥不同换行折指纹一致', fingerprintPublicKey(KEY_A.replace(/\n/g, ' ')) === FP_A && /^[0-9a-f]{64}$/.test(FP_A));
t('pin 指纹：CRLF／尾换行／多余空白不影响指纹（去全部空白）', fingerprintPublicKey(KEY_A.replace(/\n/g, '\r\n') + '\n\n') === FP_A && fingerprintPublicKey('  ' + KEY_A + '  ') === FP_A);
t('pin 指纹：空/缺公钥为 null', fingerprintPublicKey('') === null && fingerprintPublicKey(null) === null && fingerprintPublicKey('   ') === null);
t('pin 指纹：不同公钥指纹不同', fingerprintPublicKey(KEY_B) !== FP_A);
const noFile = () => { throw new Error('ENOENT'); };
// TOFU：首见记下，之后一致 ok、换机主／换钥失配
const tofu = createDevicePinStore({ statFile: noFile, readFile: noFile });
const stAliceA = { ownerUsername: 'alice', devicePublicKey: KEY_A, state: 'Off' };
t('pin TOFU 首见为 no-pin', tofu.check('node-1', stAliceA).state === 'no-pin');
t('pin TOFU 再见一致为 ok', tofu.check('node-1', stAliceA).state === 'ok');
t('pin TOFU 机主被改为 bob 即 owner-mismatch', tofu.check('node-1', { ownerUsername: 'bob', devicePublicKey: KEY_A, state: 'Off' }).state === 'owner-mismatch');
t('pin TOFU 公钥被换即 key-mismatch', tofu.check('node-1', { ownerUsername: 'alice', devicePublicKey: KEY_B, state: 'Off' }).state === 'key-mismatch');
t('pin TOFU 机主大小写不敏感', tofu.check('node-1', { ownerUsername: 'ALICE', devicePublicKey: KEY_A, state: 'Off' }).state === 'ok');
t('pin TOFU 缺字段不 pin 不判', tofu.check('node-2', { ownerUsername: 'carol', state: 'Off' }).state === 'no-pin' && tofu.check('node-2', { ownerUsername: 'carol', state: 'Off' }).state === 'no-pin');
t('pin TOFU status 为空为 no-pin', tofu.check('node-1', null).state === 'no-pin');
// 运维 pin 表：权威，优先于首次所见；只 pin 填了的项
let _pinNow = 1000000000000;
let _pinMtime = 1000;
let _pinContent = JSON.stringify({ pins: { 'node-9': { owner: 'alice', publicKeySha256: FP_A } } });
const ops = createDevicePinStore({
  statFile: () => ({ mtimeMs: _pinMtime }), readFile: () => _pinContent, now: () => _pinNow,
});
t('pin 运维表一致为 ok', ops.check('node-9', stAliceA).state === 'ok');
t('pin 运维表机主不符为 owner-mismatch', ops.check('node-9', { ownerUsername: 'mallory', devicePublicKey: KEY_A, state: 'Off' }).state === 'owner-mismatch');
t('pin 运维表公钥不符为 key-mismatch', ops.check('node-9', { ownerUsername: 'alice', devicePublicKey: KEY_B, state: 'Off' }).state === 'key-mismatch');
t('pin 运维表无此台为 no-pin（不挡未登记设备）', ops.check('node-10', stAliceA).state === 'no-pin');
// 别名感知：登记名为曾用名时仍认机主（ownerMatches 注入）
const aliasOps = createDevicePinStore({
  statFile: () => ({ mtimeMs: 1000 }),
  readFile: () => JSON.stringify({ pins: { 'node-9': { owner: 'alice', publicKeySha256: FP_A } } }),
  ownerMatches: (recorded, owner) => recorded.toLowerCase() === owner.toLowerCase() || (recorded === 'oldname' && owner === 'alice'),
});
t('pin 别名：登记曾用名仍认机主', aliasOps.check('node-9', { ownerUsername: 'oldname', devicePublicKey: KEY_A, state: 'Off' }).state === 'ok');
// 损坏的运维表：保留上次好表，不抛错
_pinNow += 60000; _pinMtime = 2000; _pinContent = '{bad json';
t('pin 运维表损坏后仍用上次好表', ops.check('node-9', stAliceA).state === 'ok');
_pinNow += 60000; _pinMtime = 3000; _pinContent = JSON.stringify({ pins: { 'node-9': { owner: 'bob', publicKeySha256: FP_A } } });
t('pin 运维表更新后新表生效', ops.check('node-9', stAliceA).state === 'owner-mismatch');
// 首次加载即损坏（无上次好表）：不抛错，走 no-pin＋TOFU，不误判失配
const badFirst = createDevicePinStore({
  statFile: () => ({ mtimeMs: 1000 }), readFile: () => '{bad json', now: () => 1000000000000,
});
t('pin 首次加载即损坏不抛错、走 no-pin', badFirst.check('node-77', stAliceA).state === 'no-pin');
t('pin 首次损坏后 TOFU 仍可 pin 并比对', badFirst.check('node-77', stAliceA).state === 'ok'
  && badFirst.check('node-77', { ownerUsername: 'alice', devicePublicKey: KEY_B, state: 'Off' }).state === 'key-mismatch');
// 首次 pin 审计日志：首见记一条（机主哈希＋指纹前缀），不得静默信任；
// pin 建立后伪造机主／公钥一律拒绝（TOFU 防的是“登记后篡改”，首见信任
// 本身是 TOFU 固有边界，见 lock-bridge.js 工厂注释）。
const firstLogs = [];
const logged = createDevicePinStore({ statFile: noFile, readFile: noFile, log: (tag, msg) => firstLogs.push(tag + ':' + msg) });
t('pin 首次登记记审计日志', logged.check('node-55', stAliceA).state === 'no-pin' && firstLogs.length === 1 && firstLogs[0].startsWith('device-pin-first:'));
t('pin 首次日志不记明文账号与完整指纹', !firstLogs[0].includes('alice') && !firstLogs[0].includes(FP_A));
t('pin 再见一致不再重复记首次日志', logged.check('node-55', stAliceA).state === 'ok' && firstLogs.length === 1);
t('pin 登记后伪造机主被拒', logged.check('node-55', { ownerUsername: 'mallory', devicePublicKey: KEY_A, state: 'Off' }).state === 'owner-mismatch');
t('pin 登记后伪造公钥被拒', logged.check('node-55', { ownerUsername: 'alice', devicePublicKey: KEY_B, state: 'Off' }).state === 'key-mismatch');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
