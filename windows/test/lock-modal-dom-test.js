'use strict';
/*
 * C 线 · 关闭确认弹窗 jsdom 真 DOM 测试（沙箱实跑）
 * 依据：定夺 §4.4 验收——弹窗打开 60 秒、期间连续触发面板刷新，弹窗不能消失；
 * 重复确认不得产生第二次真实解锁操作；请求超时、设备掉线、锁状态变化时，
 * UI 与最终权威状态必须一致。
 *
 * 做法：jsdom 加载真实 windows/lock.html（runScripts），qfLock 用桩；
 * 面板刷新走页面暴露的 window.__lockPanelRefresh（即真实 load()）；
 * 60 秒用可控假时钟推进（页面内若有人重加自动取消定时器会被触发并导致失败）。
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

let pass = 0, fail = 0;
function t(name, cond, extra) {
  if (cond) { pass++; console.log('ok  -', name); }
  else { fail++; console.log('FAIL-', name, extra !== undefined ? JSON.stringify(extra) : ''); }
}

const html = fs.readFileSync(path.join(__dirname, '..', 'lock.html'), 'utf8');

const device = { id: 'pc-1', name: '本机', owner: true, locked: true, component: true, lockState: 'LOCKED', lockId: 'lock-1', revision: 3 };
let deviceRevision = 3;
let challengeSeq = 0;
const calls = { devices: 0, challenge: [], disable: [] };
let disableBehavior = 'ok'; // ok | stale-once | timeout
let staleUsed = false;

const qfLockStub = {
  onTheme: () => {},
  close: () => {},
  goLogin: () => {},
  openDevices: () => {},
  repair: async () => ({ ok: true, outcome: 'fixed' }),
  installComponent: async () => ({ ok: true }),
  devices: async () => {
    calls.devices++;
    return { ok: true, devices: [Object.assign({}, device, { revision: deviceRevision })] };
  },
  challenge: async (id, op, opId) => {
    challengeSeq++;
    calls.challenge.push({ id, op, opId, n: challengeSeq });
    return { ok: true, challenge: 'ch-' + challengeSeq, expiresAt: Date.now() + 5 * 60 * 1000, op, deviceId: id };
  },
  disable: async (id, opts) => {
    calls.disable.push({ id, opts: Object.assign({}, opts) });
    if (disableBehavior === 'timeout') return { ok: false, error: '暂时无法连接这台电脑，请确认设备在线后重试。' };
    // P3-03：未带登录密码的高风险解锁须升级认证；带了即放行（桩内只验有无，不验真密码）。
    if (disableBehavior === 'step-up' && !opts.loginPassword) {
      return { ok: false, code: 'step-up-required', error: '本次解锁风险较高，请重新输入登录密码完成验证后再试。' };
    }
    if (disableBehavior === 'stale-once' && !staleUsed) {
      staleUsed = true;
      return { ok: false, code: 'revision-stale', error: '设备状态已变化，请重新打开确认窗口核对后再提交。' };
    }
    return { ok: true, lockState: 'UNLOCKED', revision: deviceRevision + 1 };
  },
};

function tick(n) {
  let p = Promise.resolve();
  for (let i = 0; i < (n || 8); i++) p = p.then(() => new Promise((r) => setImmediate(r)));
  return p;
}

(async () => {
  // 假时钟：接管页面 setTimeout/setInterval，advance 推进并触发到期回调。
  let fakeNow = Date.now();
  const timers = new Map();
  let seq = 0;
  const dom = new JSDOM(html, {
    url: 'https://app.qfremote.top/lock.html',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window) {
      window.qfLock = qfLockStub;
      window.setTimeout = (fn, ms) => { const id = ++seq; timers.set(id, { fn, at: fakeNow + (ms || 0), iv: 0 }); return id; };
      window.clearTimeout = (id) => { timers.delete(id); };
      window.setInterval = (fn, ms) => { const id = ++seq; timers.set(id, { fn, at: fakeNow + (ms || 0), iv: ms || 0 }); return id; };
      window.clearInterval = (id) => { timers.delete(id); };
      window.__clockAdvance = (ms) => {
        fakeNow += ms;
        let guard = 0;
        for (;;) {
          const due = Array.from(timers.values()).filter((tm) => tm.at <= fakeNow).sort((a, b) => a.at - b.at);
          if (!due.length || guard++ > 1000) break;
          const tm = due[0];
          if (tm.iv) tm.at = fakeNow + tm.iv; else timers.delete(tm.id || 0);
          // 上面 delete 用 id：找到键再删
          for (const [k, v] of timers) { if (v === tm && !tm.iv) { timers.delete(k); break; } }
          tm.fn();
        }
      };
      window.__clockPending = () => timers.size;
    },
  });
  const { window } = dom;
  const doc = window.document;
  const q = (s) => doc.querySelector(s);
  const advance = (ms) => window.__clockAdvance(ms);

  await tick(10);

  // ---- 0. 初始渲染 ----
  t('M0 面板初始渲染出一台已锁定设备', doc.querySelectorAll('.dev').length === 1
    && doc.querySelector('.dstat').textContent === '已锁定');
  t('M0 弹窗初始隐藏且不在 #list 内（重渲染碰不到它）', q('#lockConfirmModal').hidden === true
    && !q('#list').contains(q('#lockConfirmModal')));
  t('M0 源码无自动取消定时器（无 setTimeout/setInterval 调用）', !/setTimeout\s*\(|setInterval\s*\(/.test(html));

  // ---- 1. 打开弹窗 ----
  const offBtn = Array.from(doc.querySelectorAll('button')).find((b) => b.textContent === '关闭隐私锁');
  t('M1 找到“关闭隐私锁”按钮', !!offBtn);
  offBtn.click();
  await tick(10);
  const modal = q('#lockConfirmModal');
  t('M2 点击后弹窗打开', modal.hidden === false);
  t('M3 弹窗冻结快照含设备名／lockId／版本 3', q('#lockConfirmState').textContent.includes('本机')
    && q('#lockConfirmState').textContent.includes('lock-1')
    && q('#lockConfirmState').textContent.includes('版本 3'));
  t('M4 打开时取了一次操作挑战', calls.challenge.length === 1 && calls.challenge[0].id === 'pc-1' && calls.challenge[0].op === 'disarm');
  t('M5 挑战取到后确认按钮可用', q('#lockConfirmGo').disabled === false && q('#lockConfirmGo').textContent === '确认关闭');

  // ---- 2. 60 秒存活：每 5 秒刷新一次面板，共 12 次 ----
  let survived = true;
  let stateText = q('#lockConfirmState').textContent;
  for (let i = 0; i < 12; i++) {
    advance(5000);
    window.__lockPanelRefresh();
    await tick(10);
    if (modal.hidden === true || q('#lockConfirmState').textContent !== stateText
      || q('#lockConfirmGo').disabled === true) { survived = false; break; }
  }
  t('M6 弹窗打开 60 秒、12 次面板刷新后仍在，快照不变、按钮仍可用', survived);
  t('M7 12 次刷新均重读了设备（面板真在轮询刷新）', calls.devices >= 13, { devicesCalls: calls.devices });

  // ---- 3. 重复提交只产生一次真实请求 ----
  const disableBefore = calls.disable.length;
  const goBtn = q('#lockConfirmGo');
  goBtn.click();
  goBtn.click(); // 提交中第二次点击
  await tick(10);
  t('M8 连续点两次确认只发一次 disable', calls.disable.length === disableBefore + 1, { disableCalls: calls.disable.length });
  const sent = calls.disable[calls.disable.length - 1];
  t('M9 提交载荷含挑战＋操作编号＋冻结 revision 3', sent.opts.challenge === 'ch-1'
    && typeof sent.opts.operationId === 'string' && sent.opts.operationId.length > 0
    && sent.opts.revision === 3);
  t('M9b 取挑战时带上了本次操作编号（挑战与操作编号绑定）', calls.challenge[0].opId === sent.opts.operationId);
  t('M10 成功后弹窗关闭、面板提示已关闭', modal.hidden === true && doc.getElementById('msg').textContent.includes('已关闭'));

  // ---- 4. revision-stale：弹窗不消失，刷新快照＋取新挑战后可重新确认 ----
  deviceRevision = 5;
  disableBehavior = 'stale-once';
  staleUsed = false;
  const offBtn2 = Array.from(doc.querySelectorAll('button')).find((b) => b.textContent === '关闭隐私锁');
  offBtn2.click();
  await tick(10);
  t('M11 再次打开弹窗（取第 2 次挑战）', modal.hidden === false && calls.challenge.length === 2);
  const chBefore = calls.challenge.length;
  const disBefore = calls.disable.length;
  q('#lockConfirmGo').click();
  await tick(12);
  t('M12 revision-stale 后弹窗不消失、显示准确错误', modal.hidden === false
    && q('#lockConfirmErr').textContent.includes('设备状态已变化'));
  t('M13 stale 后后台重取设备、取了新挑战、快照更新到版本 5', calls.challenge.length === chBefore + 1
    && q('#lockConfirmState').textContent.includes('版本 5'));
  const firstOp = calls.disable[disBefore].opts.operationId;
  q('#lockConfirmGo').click();
  await tick(12);
  t('M14 重新确认成功、弹窗关闭', modal.hidden === true);
  t('M15 重新确认用了新操作编号＋新 revision 5（旧快照未复用）', calls.disable.length === disBefore + 2
    && calls.disable[disBefore + 1].opts.revision === 5
    && calls.disable[disBefore + 1].opts.operationId !== firstOp);

  // ---- 5. 超时：弹窗不消失、不改写成未锁定 ----
  disableBehavior = 'timeout';
  deviceRevision = 5;
  const offBtn3 = Array.from(doc.querySelectorAll('button')).find((b) => b.textContent === '关闭隐私锁');
  offBtn3.click();
  await tick(10);
  const disBefore2 = calls.disable.length;
  q('#lockConfirmGo').click();
  await tick(10);
  t('M16 请求超时后弹窗仍在、显示超时错误、设备仍显示已锁定', modal.hidden === false
    && q('#lockConfirmErr').textContent.includes('暂时无法连接')
    && doc.querySelector('.dstat').textContent === '已锁定'
    && calls.disable.length === disBefore2 + 1);

  // ---- 5b. step-up-required：弹窗不消失，填登录密码后可重新确认（P3-03） ----
  const escPre = new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
  doc.dispatchEvent(escPre);
  await tick(4);
  t('M16b 超时弹窗可 Esc 关闭', modal.hidden === true);
  disableBehavior = 'step-up';
  deviceRevision = 5;
  const offBtn4 = Array.from(doc.querySelectorAll('button')).find((b) => b.textContent === '关闭隐私锁');
  offBtn4.click();
  await tick(10);
  t('M16c step-up 场景弹窗打开', modal.hidden === false);
  const disBefore3 = calls.disable.length;
  q('#lockConfirmGo').click();
  await tick(10);
  t('M16d 未带密码的高风险解锁被拒、弹窗仍在、提示升级认证', modal.hidden === false
    && q('#lockConfirmErr').textContent.includes('风险较高')
    && calls.disable.length === disBefore3 + 1);
  q('#lockConfirmLoginPw').value = 'correct-pw';
  q('#lockConfirmGo').click();
  await tick(10);
  t('M16e 填登录密码后重新确认成功、弹窗关闭', modal.hidden === true
    && calls.disable[calls.disable.length - 1].opts.loginPassword === 'correct-pw');

  // ---- 6. Esc 只关弹窗 ----
  const esc = new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
  doc.dispatchEvent(esc);
  await tick(4);
  t('M17 Esc 关闭弹窗', modal.hidden === true);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(' harness error:', e); process.exit(1); });
