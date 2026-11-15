// tests/unit/session-sm.test.mjs — S-075 连接状态机（QFSessionSM）单测。
// 纯逻辑：手动时钟＋手工信号，不碰 DOM、不碰网络。
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadWebapp } from './load-webapp.mjs';

const ctx = loadWebapp();
const Q = ctx.__qf;

// 跨 vm 沙箱：状态机返回的对象带沙箱 realm 原型，deepEqual 会误判；逐字段断言。
function assertFailed(got, code, state) {
  assert.equal(got && got.failed && got.failed.code, code);
  assert.equal(got && got.failed && got.failed.state, state);
}
function assertHealthy(got) {
  assert.equal(got && got.healthy, true);
}

test('S-075 正常路径：binding→videopending→connected 两次 → HEALTHY', () => {
  const sm = Q.QFSessionSM({ now: 0 });
  assert.equal(sm.state, 'CONNECTING');
  assert.equal(sm.observe('blank', {}, 100), null);
  assert.equal(sm.state, 'CONNECTING');
  sm.observe('binding', {}, 200);
  assert.equal(sm.state, 'TRANSPORT_READY');
  sm.observe('videopending', {}, 300);
  assert.equal(sm.state, 'REMOTE_AUTHENTICATED');
  // 首个 connected：跳到 VIDEO_FIRST_FRAME，有 input 通道即进 INPUT_READY（第 1 次观测）
  assert.equal(sm.observe('connected', { inputReady: true }, 400), null);
  assert.equal(sm.state, 'INPUT_READY');
  // 第二个 connected：稳定一个周期 → HEALTHY
  assertHealthy(sm.observe('connected', { inputReady: true }, 500));
  assert.equal(sm.state, 'HEALTHY');
  assert.equal(sm.checkTimeout(999999), null);
});

test('S-075 无 input 通道时停在 VIDEO_FIRST_FRAME，不假绿', () => {
  const sm = Q.QFSessionSM({ now: 0 });
  sm.observe('connected', { inputReady: false }, 100);
  assert.equal(sm.state, 'VIDEO_FIRST_FRAME');
  assert.equal(sm.observe('connected', { inputReady: false }, 200), null);
  assert.equal(sm.state, 'VIDEO_FIRST_FRAME');
  // 通道就位后：INPUT_READY（第 1 次）→ 再一次 connected 才 HEALTHY
  sm.observe('connected', { inputReady: true }, 300);
  assert.equal(sm.state, 'INPUT_READY');
  assertHealthy(sm.observe('connected', { inputReady: true }, 400));
});

test('S-075 每段独立 timeout 与诊断码', () => {
  const cases = [
    ['CONNECTING', 8001, 'TIMEOUT_IFRAME_LOAD'],
    ['TRANSPORT_READY', 12001, 'TIMEOUT_IFRAME_LOAD'],
    ['REMOTE_AUTHENTICATED', 15001, 'TIMEOUT_WEBAPP_READY'],
    ['VIDEO_FIRST_FRAME', 25001, 'TIMEOUT_PEER_CONNECTING'],
    ['INPUT_READY', 20001, 'TIMEOUT_INPUT_READY'],
  ];
  for (const [state, overMs, code] of cases) {
    const sm = Q.QFSessionSM({ now: 0 });
    sm.state = state; sm.enteredAt = 0;
    assert.equal(sm.checkTimeout(overMs - 1), null, state + ' 预算内不应超时');
    assertFailed(sm.checkTimeout(overMs), code, state);
  }
  // 转移即重置本段计时
  const sm = Q.QFSessionSM({ now: 0 });
  sm.observe('binding', {}, 7900); // CONNECTING 末尾才转移
  assert.equal(sm.state, 'TRANSPORT_READY');
  assert.equal(sm.checkTimeout(7900 + 12000), null);
  assertFailed(sm.checkTimeout(7900 + 12001), 'TIMEOUT_IFRAME_LOAD', 'TRANSPORT_READY');
});

test('S-075 reset 回到 CONNECTING；阶段名映射覆盖 input-ready', () => {
  const sm = Q.QFSessionSM({ now: 0 });
  sm.observe('connected', { inputReady: true }, 100);
  sm.observe('connected', { inputReady: true }, 200);
  assert.equal(sm.state, 'HEALTHY');
  sm.reset(5000);
  assert.equal(sm.state, 'CONNECTING');
  assert.equal(sm.enteredAt, 5000);
  assert.equal(Q.QF_SESSION_SM_STAGE_NAMES.INPUT_READY, 'input-ready');
  assert.equal(Q.QF_SESSION_SM_STAGE_NAMES.HEALTHY, 'video-ready');
  assert.equal(Q.QF_SESSION_SM_STATES.join(','), 'CONNECTING,TRANSPORT_READY,REMOTE_AUTHENTICATED,VIDEO_FIRST_FRAME,INPUT_READY,HEALTHY'); // 跨 vm 沙箱：join 比对，deepEqual 会被 realm 原型绊住
});
