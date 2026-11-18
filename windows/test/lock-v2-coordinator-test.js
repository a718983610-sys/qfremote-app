'use strict';
/*
 * 隐私锁 v2 协调层测试（B 线，沙箱实跑；会话组件用内存 IPC 假实现，
 * 只验协调层协议逻辑，不冒充真机）：
 *  A. arm 全路径：会话核验 → IPC ACK → LOCKED，密码进 vault；
 *  B. arm 无 ACK 时回 UNLOCKED，不留 LOCKING 悬挂；
 *  C. Session 0 / 会话不符拒绝 arm；
 *  D. disarm 幂等（已解锁重复解除不当故障）与 revision 校验；
 *  E. 本地密码：错 4 次可重试，第 5 次撤销并进 FAILSAFE；
 *  F. display_power_ok=false 时 LOCKED 照常但报 DEGRADED。
 * 结果写 JSON 到 QFTEST_OUT，退出码 0=通过。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AsyncIpcServer, MemoryTransport } = require('../lock-v2/lock-ipc');
const { LockCoordinator } = require('../lock-v2/lock-coordinator');

const OUT = process.env.QFTEST_OUT || '/tmp/qfr200/lock-v2-coordinator-result.json';
const result = { cases: {}, pass: false };
const ok = (name, cond, extra) => { result.cases[name] = Object.assign({ pass: !!cond }, extra || {}); };

const SID = 'S-1-5-21-test';

// 假会话组件：内存 IPC 服务端，实现 CONTRACT §3 的方法子集。
function makeFakeAgent(serverTransport, opts) {
  const o = opts || {};
  let locked = false; let lockId = null;
  const server = new AsyncIpcServer(serverTransport, async (method, params) => {
    if (o.neverRespond) return new Promise(() => {});
    switch (method) {
      case 'ping': return { alive: true, locked, lock_id: lockId, displayOff: locked, session_id: 1 };
      case 'arm':
        if (params.session_id !== 1) { const e = new Error('session mismatch'); e.code = 'SESSION_MISMATCH'; throw e; }
        if (params.user_sid !== SID) { const e = new Error('sid mismatch'); e.code = 'SID_MISMATCH'; throw e; }
        locked = true; lockId = params.lock_id;
        return { locked: true, lock_id: lockId, display_off: true, display_power_ok: o.displayPowerOk !== false };
      case 'disarm': locked = false; lockId = null; return { locked: false };
      case 'status': return { locked, lock_id: lockId, displayOff: locked, failsafe: false, session_id: 1 };
      case 'failsafe-lock': return { failsafe: true };
      default: throw new Error('unknown method ' + method);
    }
  });
  return { server, getState: () => ({ locked, lockId }) };
}

function makeProvider(opts) {
  const o = opts || {};
  const session = o.session || { sessionId: 1, userSid: SID, active: true };
  const spawned = [];
  return {
    session,
    spawned,
    getInteractiveSession: async () => session,
    spawnSessionAgent: async () => {
      const pair = MemoryTransport.pair();
      const agent = makeFakeAgent(pair[1], o);
      spawned.push({ clientTransport: pair[0], serverTransport: pair[1], agent });
      return pair[0];
    }
  };
}

function makeCoordinator(opts) {
  const o = opts || {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qfr-lockv2-coord-'));
  const events = [];
  const provider = makeProvider(o.providerOpts || {});
  const coord = new LockCoordinator({
    deviceId: 'dev-test-1', bootId: 'boot-1', stateDir: dir,
    sessionProvider: provider,
    displayPower: { setDisplayPower: async () => ({ ok: true, supported: true, action: 'on' }) },
    serverReport: async (ev) => { events.push(ev); },
    heartbeatIntervalMs: 60000, ackTimeoutMs: o.ackTimeoutMs || 2000
  });
  return { coord, dir, events, provider };
}

(async () => {
  // A
  {
    const { coord, events } = makeCoordinator();
    const r = await coord.arm({ password: 'pass1234', caller: 'owner-718983610' });
    ok('A1_arm_locked', r.ok === true && r.actual_state === 'LOCKED' && !!r.lock_id, { lock_id: r.lock_id });
    ok('A2_snapshot_protected', coord.snapshot().protected === true && coord.snapshot().effective_state === 'LOCKED');
    ok('A3_ack_reported', events.some((e) => e.type === 'lock_ack' && e.actual_state === 'LOCKED'));
    ok('A4_vault_set', coord.vault.status().set === true && coord.vault.status().revoked === false);
    const d = await coord.disarm({ caller: 'owner-718983610', lockId: r.lock_id, revision: coord.machine.revision });
    ok('A5_disarm_unlocked', d.ok === true && d.actual_state === 'UNLOCKED');
    ok('A6_vault_revoked_after_disarm', coord.vault.status().revoked === true);
    coord.stop();
  }
  // B：会话组件永不响应 → arm 超时 → 回 UNLOCKED
  {
    const { coord } = makeCoordinator({ providerOpts: { neverRespond: true }, ackTimeoutMs: 200 });
    let code = '';
    try { await coord.arm({ password: 'pass1234', caller: 'owner' }); } catch (e) { code = e.code; }
    ok('B1_arm_timeout_fails', code === 'TIMEOUT', { code });
    ok('B2_no_hanging_locking', coord.machine.actualState === 'UNLOCKED', { state: coord.machine.actualState });
    coord.stop();
  }
  // C
  {
    const { coord } = makeCoordinator({ providerOpts: { session: { sessionId: 0, userSid: SID, active: true } } });
    let code = '';
    try { await coord.arm({ password: 'pass1234', caller: 'owner' }); } catch (e) { code = e.code; }
    ok('C1_session0_refused', code === 'SESSION_0_REFUSED' && coord.machine.actualState === 'UNLOCKED', { code });
    coord.stop();
    const { coord: coord2 } = makeCoordinator({ providerOpts: { session: { sessionId: 1, userSid: SID, active: false } } });
    let code2 = '';
    try { await coord2.arm({ password: 'pass1234', caller: 'owner' }); } catch (e) { code2 = e.code; }
    ok('C2_inactive_session_refused', code2 === 'SESSION_NOT_ACTIVE', { code: code2 });
    coord2.stop();
  }
  // D
  {
    const { coord, events } = makeCoordinator();
    const r = await coord.arm({ password: 'pass1234', caller: 'owner' });
    let stale = '';
    try { await coord.disarm({ caller: 'owner', lockId: r.lock_id, revision: 999 }); } catch (e) { stale = e.code; }
    ok('D1_stale_revision_rejected', stale === 'STALE_REVISION', { code: stale });
    const d = await coord.disarm({ caller: 'owner', lockId: r.lock_id, revision: coord.machine.revision });
    ok('D2_disarm_ok', d.ok === true && d.actual_state === 'UNLOCKED');
    const d2 = await coord.disarm({ caller: 'owner' });
    ok('D3_repeat_disarm_idempotent', d2.ok === true && d2.idempotent === true &&
      events.some((e) => e.type === 'disarm_idempotent'), { idempotent: d2.idempotent });
    coord.stop();
  }
  // E
  {
    const { coord, events } = makeCoordinator();
    await coord.arm({ password: 'pass1234', caller: 'owner' });
    let last = null;
    for (let i = 0; i < 4; i++) last = await coord.unlockWithPassword('wrong-pw');
    ok('E1_four_wrong_retryable', last.ok === false && last.code === 'WRONG_PASSWORD' && last.remaining === 1,
      { code: last.code, remaining: last.remaining });
    const fifth = await coord.unlockWithPassword('wrong-pw');
    ok('E2_fifth_revokes_failsafe', fifth.ok === false && fifth.code === 'REVOKED' && fifth.failsafe === true);
    ok('E3_failsafe_state', coord.machine.actualState === 'RECOVERY_REQUIRED' &&
      coord.machine.degradation && coord.machine.degradation.kind === 'FAILSAFE');
    ok('E4_failsafe_reported', events.some((e) => e.type === 'failsafe' && e.effective_state === 'FAILSAFE'));
    coord.stop();
  }
  // F
  {
    const { coord } = makeCoordinator({ providerOpts: { displayPowerOk: false } });
    const r = await coord.arm({ password: 'pass1234', caller: 'owner' });
    ok('F1_degraded_lock_reported', r.actual_state === 'LOCKED' && r.effective_state === 'DEGRADED',
      { effective: r.effective_state });
    ok('F2_not_claimed_protected', coord.snapshot().protected === false);
    coord.stop();
  }

  result.pass = Object.values(result.cases).every((c) => c.pass);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  console.log('lock-v2-coordinator: ' + (result.pass ? 'PASS' : 'FAIL') + ' ' + Object.keys(result.cases).length + ' cases');
  process.exit(result.pass ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
