// RC-04 网页客户端重连单测（规范 server/ext/lea/RC-04-RECONNECT-TICKET-SPEC.md）。
// 全部用假 fetch＋手动时钟；服务端端点尚未实现（规范 §7）时 404 走 legacy 路径。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadWebapp, ManualScheduler } from './load-webapp.mjs';

function ticket() {
  return {
    account_id: 'alice', device_id: 'dev-1', api_key_id: 'k_0123456789',
    binding_epoch: 3, grant_epoch: 1, resume_id: 'resume-0123456789abcdef',
    session_id: 'sess-0123456789abcdef', issued_at: 1790000000, expires_at: 1790000300,
    ticket_signature: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==',
  };
}

function setup(fetchImpl) {
  const sched = new ManualScheduler();
  const ctx = loadWebapp({});
  const qf = ctx.__qf;
  const rc = qf.QFReconnect({ deviceId: 'dev-1', sessionId: 'sess-0123456789abcdef', fetchFn: fetchImpl, scheduler: sched });
  return { sched, qf, rc };
}

test('RC-04 issue：服务端 404（端点未实现）→ endpointMissing，不伪造票据', async () => {
  const { rc } = setup(async () => ({ status: 404, json: null }));
  assert.equal(await rc.issue(), null);
  assert.equal(rc.endpointMissing, true);
  assert.equal(rc.ticket, null);
});

test('RC-04 issue：200 合法票据存内存；非法票据拒绝', async () => {
  const good = setup(async () => ({ status: 200, json: ticket() }));
  assert.deepEqual(good.rc.issue ? await good.rc.issue() : null, ticket());
  assert.equal(good.rc.ticket.session_id, 'sess-0123456789abcdef');
  const bad = setup(async () => ({ status: 200, json: { ...ticket(), expires_at: 1790000400 } }));
  assert.equal(await bad.rc.issue(), null); // TTL 不是 300
  assert.equal(bad.rc.lastError, 'QFR_TICKET_INVALID');
});

test('RC-04 resume 成功：200 ok → restored，票据单次消费后丢弃', async () => {
  const { sched, rc } = setup(async (path) => {
    if (path.includes('/issue')) return { status: 200, json: ticket() };
    return { status: 200, json: { ok: true, session_id: 'sess-0123456789abcdef', device_id: 'dev-1', binding_epoch: 3, grant_epoch: 1 } };
  });
  await rc.issue();
  let restored = false;
  rc.start({ onLegacyAttempt: () => false, onRestored: () => { restored = true; } });
  await new Promise((r) => setImmediate(r));
  assert.equal(restored, true);
  assert.equal(rc.state, 'restored');
  assert.equal(rc.ticket, null); // 消费后丢弃
  assert.equal(rc.inputBlocked, false);
  assert.equal(rc.attempts, 1);
});

test('RC-04 凭据失败立即停：吊销后 1 次即停，不刷屏', async () => {
  const { sched, rc } = setup(async (path) => {
    if (path.includes('/issue')) return { status: 200, json: ticket() };
    return { status: 401, json: { ok: false, code: 'QFR_API_KEY_REVOKED' } };
  });
  await rc.issue();
  let stopped = null;
  rc.start({ onLegacyAttempt: () => { throw new Error('凭据失败后不得再调 legacy'); }, onStop: (reason, code) => { stopped = { reason, code }; } });
  await new Promise((r) => setImmediate(r));
  assert.equal(rc.attempts, 1); // 1 次即停
  assert.deepEqual(stopped, { reason: 'credential', code: 'QFR_API_KEY_REVOKED' });
  assert.equal(rc.state, 'stopped');
  assert.equal(rc.inputBlocked, false);
  assert.equal(sched.pendingCount(), 0); // 无后续定时器
});

test('RC-04 凭据失败立即停：QFR_TICKET_INVALID 亦 1 次即停，不走 legacy', async () => {
  const { rc } = setup(async (path) => {
    if (path.includes('/issue')) return { status: 200, json: ticket() };
    return { status: 401, json: { ok: false, code: 'QFR_TICKET_INVALID' } };
  });
  await rc.issue();
  let stopped = null;
  rc.start({ onLegacyAttempt: () => { throw new Error('QFR_TICKET_INVALID 是凭据失败，不得再调 legacy'); }, onStop: (reason, code) => { stopped = { reason, code }; } });
  await new Promise((r) => setImmediate(r));
  assert.equal(rc.attempts, 1); // 1 次即停
  assert.deepEqual(stopped, { reason: 'credential', code: 'QFR_TICKET_INVALID' });
  assert.equal(rc.state, 'stopped');
});

test('RC-04 纯网络错误重试 5 次耗尽：每次间隔 5000ms，耗尽即停', async () => {
  const { sched, rc } = setup(async () => ({ status: 503, json: null }));
  const attempts = [];
  let stopped = null;
  rc.start({
    onLegacyAttempt: () => false,
    onAttempt: (n, max) => attempts.push([n, max]),
    onStop: (reason) => { stopped = reason; },
  });
  // 第 1 次立即执行，其余 4 次各由 5000ms 定时器驱动
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(attempts, [[1, 5]]);
  for (let i = 2; i <= 5; i++) {
    sched.advance(5000);
    await new Promise((r) => setImmediate(r));
    assert.equal(attempts.length, i);
    assert.equal(attempts[i - 1][0], i);
  }
  assert.equal(rc.attempts, 5);
  assert.equal(stopped, 'exhausted');
  assert.equal(rc.state, 'stopped');
  assert.equal(sched.pendingCount(), 0);
});

test('RC-04 取消即停：cancel 后不再重试；重连期间输入短路', async () => {
  const { sched, rc } = setup(async () => ({ status: 0, json: null, networkError: true }));
  let stopped = null;
  rc.start({ onLegacyAttempt: () => false, onStop: (reason) => { stopped = reason; } });
  assert.equal(rc.inputBlocked, true); // 重连期间输入短路丢弃
  await new Promise((r) => setImmediate(r));
  rc.cancel();
  assert.equal(stopped, 'cancelled');
  assert.equal(rc.inputBlocked, false);
  sched.advance(60000);
  await new Promise((r) => setImmediate(r));
  assert.equal(rc.attempts, 1); // 取消后不再推进
});

test('RC-04 无票据时走 legacy：5 次内 legacy 成功即恢复', async () => {
  const { sched, rc } = setup(async () => ({ status: 404, json: null }));
  await rc.issue(); // 端点未实现，无票据
  assert.equal(rc.ticket, null);
  let legacyCalls = 0;
  let restored = false;
  rc.start({
    onLegacyAttempt: () => { legacyCalls++; return legacyCalls >= 2; }, // 第 2 次 legacy 成功
    onLegacyOk: () => true, // legacy 成功＝会话已恢复（调用方判定）
    onRestored: () => { restored = true; },
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(restored, false);
  sched.advance(5000);
  await new Promise((r) => setImmediate(r));
  assert.equal(restored, true);
  assert.equal(rc.attempts, 2);
});
