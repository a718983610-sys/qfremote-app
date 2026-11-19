'use strict';
/*
 * C 线 · 关闭确认弹窗纯逻辑单测（沙箱实跑，不依赖 DOM/Electron）
 * 依据：定夺 §4.4（独立弹窗、冻结快照、挑战＋幂等、提交中禁用、
 * 超时／掉线／状态变化时 UI 与权威状态一致）。
 */
const C = require('../lock-confirm');

let pass = 0, fail = 0;
function t(name, cond, extra) {
  if (cond) { pass++; console.log('ok  -', name); }
  else { fail++; console.log('FAIL-', name, extra !== undefined ? JSON.stringify(extra) : ''); }
}

const NOW = Date.parse('2026-11-19T03:05:00+08:00');
function sess(over) {
  return C.createConfirmSession(Object.assign({
    deviceId: 'node-1', lockId: 'lock-1', revision: 3,
    challenge: 'ch-abc', expiresAt: NOW + 5 * 60 * 1000, operationId: 'op-1',
  }, over || {}));
}

t('A1 缺字段建不出会话', C.createConfirmSession({ deviceId: 'node-1' }) === null);
t('A2 正常建会话为 open 态且冻结快照', (() => {
  const s = sess();
  return s && s.state === 'open' && s.deviceId === 'node-1' && s.lockId === 'lock-1' && s.revision === 3
    && s.challenge === 'ch-abc' && s.operationId === 'op-1';
})());
t('A3 首次提交通过，载荷含冻结四件套', (() => {
  const r = C.submit(sess(), NOW);
  return r.ok && r.payload.id === 'node-1' && r.payload.challenge === 'ch-abc'
    && r.payload.operationId === 'op-1' && r.payload.revision === 3;
})());
t('A4 重复提交被拒（提交中按钮禁用对应逻辑）', (() => {
  const s = sess();
  const r1 = C.submit(s, NOW);
  const r2 = C.submit(s, NOW);
  return r1.ok === true && r2.ok === false && r2.reason === 'already-submitted' && s.state === 'submitting';
})());
t('A5 挑战过期提交被拒', (() => {
  const s = sess();
  return C.submit(s, NOW + 5 * 60 * 1000).ok === false
    && C.submit(s, NOW + 5 * 60 * 1000).reason === 'challenge-expired';
})());
t('A6 成功 resolve 后为 done', (() => {
  const s = sess();
  C.submit(s, NOW);
  C.resolve(s, { ok: true, lockState: 'UNLOCKED', revision: 4 });
  return s.state === 'done' && s.result.lockState === 'UNLOCKED';
})());
t('A7 失败 resolve 后留在 error 态、保留错误与 code', (() => {
  const s = sess();
  C.submit(s, NOW);
  C.resolve(s, { ok: false, code: 'revision-stale', error: '设备状态已变化。' });
  return s.state === 'error' && s.errorCode === 'revision-stale' && s.error === '设备状态已变化。';
})());
t('A8 超时失败 resolve 后同样留在 error 态（不改写成未锁定）', (() => {
  const s = sess();
  C.submit(s, NOW);
  C.resolve(s, { ok: false, error: '暂时无法连接这台电脑。' });
  return s.state === 'error' && s.error === '暂时无法连接这台电脑。';
})());
t('A9 revision-stale 后刷新快照：弹窗不关、revision 更新、须重新取挑战', (() => {
  const s = sess();
  C.submit(s, NOW);
  C.resolve(s, { ok: false, code: 'revision-stale', error: '设备状态已变化。' });
  C.refreshFrozen(s, { lockId: 'lock-1', revision: 5 });
  const blocked = C.submit(s, NOW);
  return s.state === 'needs-challenge' && s.revision === 5 && blocked.ok === false;
})());
t('A10 重新取挑战后可再次提交（新挑战＋新 revision）', (() => {
  const s = sess();
  C.submit(s, NOW);
  C.resolve(s, { ok: false, code: 'revision-stale', error: '设备状态已变化。' });
  C.refreshFrozen(s, { lockId: 'lock-1', revision: 5 });
  C.attachChallenge(s, 'ch-new', NOW + 5 * 60 * 1000);
  const r = C.submit(s, NOW);
  return r.ok === true && r.payload.challenge === 'ch-new' && r.payload.revision === 5;
})());
t('A11 取消后为 done 且不再接受提交', (() => {
  const s = sess();
  C.cancel(s);
  return s.state === 'done' && C.submit(s, NOW).ok === false;
})());
t('A12 60 秒无自动取消：会话无任何定时器字段，open 态只由显式动作离开', (() => {
  const s = sess();
  // 构造后不做任何动作，open 态保持；模块内无 setTimeout（静态断言：源码不含它）。
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'lock-confirm.js'), 'utf8');
  return s.state === 'open' && !/setTimeout|setInterval/.test(src);
})());

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
