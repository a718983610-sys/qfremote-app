'use strict';
/*
 * C 线 · 网页端关闭确认弹窗 jsdom 测试（沙箱实跑，不依赖 Playwright／真机）
 * 依据：定夺 §4.4 验收——弹窗打开 60 秒、期间连续触发面板刷新，弹窗不能消失；
 * 重复确认不得产生第二次真实解锁操作；请求超时、设备掉线、锁状态变化时，
 * UI 与最终权威状态必须一致。
 *
 * 做法：jsdom 加载真实 index.html＋四脚本（qf-schema／qf-runtime／qf-ui／
 * app，按 ASSETS.json 解析 hash 名），window.fetch 打桩（/lock/* 走
 * C 线新契约，其余一律 401 未登录，boot 停在登录页）；直接调
 * window.initLockPanel(view, '本机')；面板刷新走真实 refresh 路径
 * （initLockPanel 重调）；60 秒用可控假时钟推进。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { assetFile } from '../resolve-assets.mjs';

const WEBAPP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function tick(n) {
  let p = Promise.resolve();
  for (let i = 0; i < (n || 10); i++) p = p.then(() => new Promise((r) => setImmediate(r)));
  return p;
}

async function loadPage() {
  const indexHtml = fs.readFileSync(path.join(WEBAPP, 'index.html'), 'utf8');
  let deviceRevision = 3;
  let challengeSeq = 0;
  const calls = { devices: 0, challenge: [], disable: [] };
  const behavior = { disable: 'ok' }; // ok | stale-once | timeout
  let staleUsed = false;

  let fakeNow = Date.now();
  const timers = new Map();
  let seq = 0;

  const dom = new JSDOM(indexHtml, {
    url: 'https://app.qfremote.top/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window) {
      // 可控假时钟：页面 setTimeout/setInterval 全部接管（60 秒推进用）。
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
          if (tm.iv) tm.at = fakeNow + tm.iv;
          else { for (const [k, v] of timers) { if (v === tm) { timers.delete(k); break; } } }
          tm.fn();
        }
      };
      // fetch 打桩：/lock/* 走新契约，其余一律 401（boot 停在登录页）。
      window.fetch = async (url, init) => {
        const u = String(url);
        const method = (init && init.method) || 'GET';
        const json = (status, obj) => ({ status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(obj) });
        if (u.startsWith('/lock/devices')) {
          calls.devices++;
          return json(200, { devices: [{ id: 'node-1', name: '本机', owner: true, locked: true, component: true, lockState: 'LOCKED', lockId: 'lock-1', revision: deviceRevision }] });
        }
        if (u.startsWith('/lock/challenge')) {
          challengeSeq++;
          calls.challenge.push({ url: u, n: challengeSeq });
          return json(200, { ok: true, challenge: 'ch-' + challengeSeq, expiresAt: Date.now() + 5 * 60 * 1000, op: 'disarm', deviceId: 'node-1' });
        }
        if (u === '/lock/disable' && method === 'POST') {
          const body = JSON.parse((init && init.body) || '{}');
          calls.disable.push(body);
          if (behavior.disable === 'timeout') return json(504, { error: '暂时无法连接这台电脑，请确认设备在线后重试。' });
          if (behavior.disable === 'stale-once' && !staleUsed) {
            staleUsed = true;
            return json(409, { error: '设备状态已变化，请重新打开确认窗口核对后再提交。', code: 'revision-stale' });
          }
          // P3-03：未带登录密码的高风险解锁须升级认证；带了即放行。
          if (behavior.disable === 'step-up' && !body.loginPassword) {
            return json(409, { error: '本次解锁风险较高，请重新输入登录密码完成验证后再试。', code: 'step-up-required' });
          }
          return json(200, { ok: true, lockState: 'UNLOCKED', revision: deviceRevision + 1 });
        }
        if (u.startsWith('/lock/')) return json(200, { ok: true });
        return json(401, { error: '未登录' });
      };
      window.WebSocket = class { constructor() { this.readyState = 3; } close() {} send() {} addEventListener() {} };
    },
  });
  const { window } = dom;
  // 按真实加载顺序注入四脚本（boot 在 app.js 末尾立即执行，停在登录页）。
  for (const logical of ['qf-schema.js', 'qf-runtime.js', 'qf-ui.js', 'app.js']) {
    const file = assetFile(WEBAPP, logical);
    const code = fs.readFileSync(path.join(WEBAPP, file), 'utf8');
    const el = window.document.createElement('script');
    el.textContent = code;
    window.document.head.appendChild(el);
    await tick(4);
  }
  await tick(10);
  return {
    window, dom, calls, behavior,
    setRevision(v) { deviceRevision = v; },
    resetStale() { staleUsed = false; },
    advance: (ms) => window.__clockAdvance(ms),
  };
}

test('网页端关闭确认弹窗：60 秒＋刷新存活、重复提交一次、stale 刷新、超时留弹窗', async () => {
  const pg = await loadPage();
  const { window } = pg;
  const doc = window.document;
  assert.equal(typeof window.initLockPanel, 'function', 'bundle 须暴露 initLockPanel');

  // 构造设备视图（与 Views.device 渲染的锁卡同结构）。
  const view = doc.createElement('div');
  view.innerHTML = '<div class="card" id="lockCard"><h3>屏幕锁</h3><div id="lockBody"></div></div>';
  doc.body.appendChild(view);

  await window.initLockPanel(view, '本机');
  await tick(12);
  const offBtn = doc.querySelector('#lk-off');
  assert.ok(offBtn, '已锁定设备应有关闭按钮');
  assert.match(doc.querySelector('#lockBody').textContent, /已锁定/);

  // 1. 打开弹窗
  offBtn.click();
  await tick(12);
  let modal = doc.querySelector('#modalRoot .modal');
  assert.ok(modal, '点击后弹窗应打开（#modalRoot 内）');
  assert.match(doc.querySelector('#lk-cf-state').textContent, /本机/);
  assert.match(doc.querySelector('#lk-cf-state').textContent, /lock-1/);
  assert.match(doc.querySelector('#lk-cf-state').textContent, /版本 3/);
  assert.equal(pg.calls.challenge.length, 1, '打开时取一次操作挑战');
  assert.equal(doc.querySelector('#lk-cf-go').disabled, false, '挑战取到后确认按钮可用');
  assert.equal(doc.querySelector('#lk-cf-go').textContent, '确认关闭');

  // 2. 60 秒存活：每 5 秒重调 initLockPanel（模拟面板刷新／补拉）
  const stateText = doc.querySelector('#lk-cf-state').textContent;
  for (let i = 0; i < 12; i++) {
    pg.advance(5000);
    await window.initLockPanel(view, '本机');
    await tick(10);
    modal = doc.querySelector('#modalRoot .modal');
    assert.ok(modal, `第 ${i + 1} 次刷新后弹窗仍在`);
    assert.equal(doc.querySelector('#lk-cf-state').textContent, stateText, '快照 60 秒内不变');
    assert.equal(doc.querySelector('#lk-cf-go').disabled, false, '确认按钮仍可用');
  }

  // 3. 重复提交只产生一次真实请求
  const disBefore = pg.calls.disable.length;
  const goBtn = doc.querySelector('#lk-cf-go');
  goBtn.click();
  goBtn.click();
  await tick(12);
  assert.equal(pg.calls.disable.length, disBefore + 1, '连续点两次确认只发一次 disable');
  const sent = pg.calls.disable[pg.calls.disable.length - 1];
  assert.equal(sent.challenge, 'ch-1');
  assert.equal(typeof sent.operationId, 'string');
  assert.ok(sent.operationId.length > 0);
  assert.equal(sent.revision, 3);
  assert.equal(new URL(pg.calls.challenge[0].url, 'https://app.qfremote.top').searchParams.get('opId'), sent.operationId, '取挑战时带上本次操作编号（挑战与操作编号绑定）');
  assert.equal(doc.querySelector('#modalRoot .modal'), null, '成功后弹窗关闭');
  assert.match(doc.body.textContent, /屏幕锁已关闭/, '成功后 toast 提示');

  // 4. revision-stale：弹窗不消失，刷新快照＋取新挑战后可重新确认
  pg.setRevision(5);
  pg.behavior.disable = 'stale-once';
  pg.resetStale();
  await window.initLockPanel(view, '本机');
  await tick(12);
  doc.querySelector('#lk-off').click();
  await tick(12);
  assert.ok(doc.querySelector('#modalRoot .modal'), '再次打开弹窗');
  const chBefore = pg.calls.challenge.length;
  const disBefore2 = pg.calls.disable.length;
  doc.querySelector('#lk-cf-go').click();
  await tick(16);
  assert.ok(doc.querySelector('#modalRoot .modal'), 'stale 后弹窗不消失');
  assert.match(doc.querySelector('#lk-cf-err').textContent, /设备状态已变化/);
  assert.equal(pg.calls.challenge.length, chBefore + 1, 'stale 后取了新挑战');
  assert.match(doc.querySelector('#lk-cf-state').textContent, /版本 5/, '快照更新到版本 5');
  const firstOp = pg.calls.disable[disBefore2].operationId;
  doc.querySelector('#lk-cf-go').click();
  await tick(16);
  assert.equal(doc.querySelector('#modalRoot .modal'), null, '重新确认成功后弹窗关闭');
  assert.equal(pg.calls.disable.length, disBefore2 + 2, '重新确认又发一次 disable');
  assert.equal(pg.calls.disable[disBefore2 + 1].revision, 5, '重新确认用新 revision');
  assert.notEqual(pg.calls.disable[disBefore2 + 1].operationId, firstOp, '重新确认用新操作编号');

  // 5. 超时：弹窗不消失、不改写成未锁定
  pg.behavior.disable = 'timeout';
  await window.initLockPanel(view, '本机');
  await tick(12);
  doc.querySelector('#lk-off').click();
  await tick(12);
  const disBefore3 = pg.calls.disable.length;
  doc.querySelector('#lk-cf-go').click();
  await tick(12);
  assert.ok(doc.querySelector('#modalRoot .modal'), '超时后弹窗仍在');
  assert.match(doc.querySelector('#lk-cf-err').textContent, /暂时无法连接/);
  assert.match(doc.querySelector('#lockBody').textContent, /已锁定/, '面板仍显示已锁定');
  assert.equal(pg.calls.disable.length, disBefore3 + 1);

  // 5b. step-up-required：弹窗不消失，填登录密码后可重新确认（P3-03）
  pg.behavior.disable = 'step-up';
  const disBefore4 = pg.calls.disable.length;
  doc.querySelector('#lk-cf-go').click();
  await tick(12);
  assert.ok(doc.querySelector('#modalRoot .modal'), 'step-up 拒绝后弹窗仍在');
  assert.match(doc.querySelector('#lk-cf-err').textContent, /风险较高/);
  assert.equal(pg.calls.disable.length, disBefore4 + 1);
  doc.querySelector('#lk-cf-pw').value = 'correct-pw';
  doc.querySelector('#lk-cf-go').click();
  await tick(12);
  assert.equal(doc.querySelector('#modalRoot .modal'), null, '填登录密码后重新确认成功、弹窗关闭');
  assert.equal(pg.calls.disable[pg.calls.disable.length - 1].loginPassword, 'correct-pw');

  // 6. Esc 关闭弹窗（全局 keydown → closeModal；退出动画 130ms，假时钟须推进）
  doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  pg.advance(200);
  await tick(6);
  assert.equal(doc.querySelector('#modalRoot .modal'), null, 'Esc 关闭弹窗');
});
