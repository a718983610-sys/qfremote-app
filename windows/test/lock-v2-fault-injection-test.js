'use strict';
/*
 * 隐私锁 v2 故障注入测试（B 线，沙箱实跑；会话组件用内存 IPC 假实现，
 * 只验协调层恢复逻辑，不冒充真机）：
 *  FI-1 组件崩溃：arm 成功后杀掉会话组件 → 心跳发现 → FAILSAFE，
 *       上报 failsafe 事件，绝不悄悄露桌面仍称受保护；
 *  FI-2 IPC 断开：管道断开后 onComponentLost → RECOVERY_REQUIRED + FAILSAFE；
 *  FI-3 断网：断网期间上报排队、锁状态不翻转；恢复后补发；
 *  FI-4 服务重启：同 boot_id 重启后重核一致恢复 LOCKED；boot_id 变了
 *       旧 LOCKED 不可信，进 UNKNOWN 待重核。
 * 恢复全程不要求用户断开重连、不要求退出账号、不要求重启电脑。
 * 结果写 JSON 到 QFTEST_OUT，退出码 0=通过。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AsyncIpcServer, MemoryTransport } = require('../lock-v2/lock-ipc');
const { LockCoordinator } = require('../lock-v2/lock-coordinator');

const OUT = process.env.QFTEST_OUT || '/tmp/qfr200/lock-v2-fault-result.json';
const result = { cases: {}, pass: false };
const ok = (name, cond, extra) => { result.cases[name] = Object.assign({ pass: !!cond }, extra || {}); };

const SID = 'S-1-5-21-test';

function makeFakeAgent(serverTransport, shared) {
  const s = shared || { locked: false, lockId: null };
  const server = new AsyncIpcServer(serverTransport, async (method, params) => {
    switch (method) {
      case 'ping': return { alive: true, locked: s.locked, lock_id: s.lockId, displayOff: s.locked, session_id: 1 };
      case 'arm': s.locked = true; s.lockId = params.lock_id; return { locked: true, lock_id: s.lockId, display_off: true, display_power_ok: true };
      case 'disarm': s.locked = false; s.lockId = null; return { locked: false };
      case 'status': return { locked: s.locked, lock_id: s.lockId, displayOff: s.locked, failsafe: false, session_id: 1 };
      case 'failsafe-lock': return { failsafe: true };
      default: throw new Error('unknown ' + method);
    }
  });
  return { server, getState: () => ({ locked: s.locked, lockId: s.lockId }) };
}

function makeSetup(stateDir, sharedAgentState) {
  const events = [];
  const spawned = [];
  const provider = {
    getInteractiveSession: async () => ({ sessionId: 1, userSid: SID, active: true }),
    spawnSessionAgent: async () => {
      const pair = MemoryTransport.pair();
      // 服务重启只重启协调层，会话组件（及其锁状态）在会话里活着：
      // 用共享的 agentState 模拟这一点。
      const agent = makeFakeAgent(pair[1], sharedAgentState);
      spawned.push({ clientTransport: pair[0], serverTransport: pair[1], agent });
      return pair[0];
    }
  };
  const coord = new LockCoordinator({
    deviceId: 'dev-test-1', bootId: 'boot-1', stateDir,
    sessionProvider: provider,
    displayPower: { setDisplayPower: async () => ({ ok: true, supported: true, action: 'on' }) },
    serverReport: async (ev) => { events.push(ev); },
    heartbeatIntervalMs: 60000, ackTimeoutMs: 2000
  });
  return { coord, events, provider, spawned };
}

(async () => {
  // FI-1 组件崩溃
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qfr-lockv2-fi1-'));
    const { coord, events, spawned } = makeSetup(dir);
    const r = await coord.arm({ password: 'pass1234', caller: 'owner' });
    ok('FI1a_armed', r.actual_state === 'LOCKED');
    // 杀掉会话组件（关掉服务端传输，模拟崩溃）。
    spawned[0].agent.server.close();
    const tick = await coord.heartbeatTick();
    ok('FI1b_crash_detected', coord.machine.actualState === 'RECOVERY_REQUIRED' &&
      coord.machine.degradation && coord.machine.degradation.kind === 'FAILSAFE',
      { state: coord.machine.actualState, tickOk: tick.ok });
    ok('FI1c_failsafe_reported', events.some((e) => e.type === 'failsafe' && e.effective_state === 'FAILSAFE'));
    ok('FI1d_not_claimed_locked', coord.snapshot().protected === false);
    coord.stop();
  }
  // FI-2 IPC 断开
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qfr-lockv2-fi2-'));
    const { coord, events, spawned } = makeSetup(dir);
    await coord.arm({ password: 'pass1234', caller: 'owner' });
    spawned[0].serverTransport.close(); // 管道断开
    const r = await coord.onComponentLost('IPC 断开（注入）');
    ok('FI2a_recovery_or_failsafe', r.ok === true &&
      (coord.machine.actualState === 'RECOVERY_REQUIRED'), { state: coord.machine.actualState });
    ok('FI2b_failsafe_event', events.some((e) => e.type === 'failsafe'));
    coord.stop();
  }
  // FI-3 断网
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qfr-lockv2-fi3-'));
    const { coord, events } = makeSetup(dir);
    await coord.arm({ password: 'pass1234', caller: 'owner' });
    const eventsBefore = events.length;
    await coord.setNetworkUp(false);
    await coord._report({ type: 'probe_while_offline' });
    ok('FI3a_queued_while_offline', coord.outbox.length === 1 && coord.machine.actualState === 'LOCKED',
      { outbox: coord.outbox.length, state: coord.machine.actualState });
    ok('FI3b_no_state_flip', coord.snapshot().protected === true);
    const flushed = await coord.setNetworkUp(true);
    ok('FI3c_flushed_on_restore', flushed === 1 && coord.outbox.length === 0 &&
      events.length === eventsBefore + 1, { flushed, events: events.length });
    coord.stop();
  }
  // FI-4 服务重启
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qfr-lockv2-fi4-'));
    const sharedAgentState = { locked: false, lockId: null };
    const s1 = makeSetup(dir, sharedAgentState);
    const r = await s1.coord.arm({ password: 'pass1234', caller: 'owner' });
    const lockId = r.lock_id;
    s1.coord.stop(); // 模拟服务停（进程退出不断网不断电）
    // 同 boot_id 重启：重核一致 → 恢复 LOCKED。
    const s2 = makeSetup(dir, sharedAgentState);
    const rec = await s2.coord.recoverAfterRestart();
    ok('FI4a_same_boot_reconciled', rec.ok === true && rec.actual_state === 'LOCKED' && rec.reconciled === true,
      { actual: rec.actual_state, reconciled: rec.reconciled });
    ok('FI4b_same_lock_id', s2.coord.machine.lockId === lockId);
    s2.coord.stop();
    // boot_id 变了：旧 LOCKED 不可信 → UNKNOWN，不谎报 LOCKED。
    const s3events = [];
    const s3provider = {
      getInteractiveSession: async () => ({ sessionId: 1, userSid: SID, active: true }),
      spawnSessionAgent: async () => { const pair = MemoryTransport.pair(); makeFakeAgent(pair[1]); return pair[0]; }
    };
    const s3 = new LockCoordinator({
      deviceId: 'dev-test-1', bootId: 'boot-2-NEW', stateDir: dir,
      sessionProvider: s3provider,
      displayPower: { setDisplayPower: async () => ({ ok: true }) },
      serverReport: async (ev) => { s3events.push(ev); },
      heartbeatIntervalMs: 60000, ackTimeoutMs: 2000
    });
    const rec3 = await s3.recoverAfterRestart();
    ok('FI4c_boot_changed_unknown', rec3.actual_state === 'UNKNOWN' || rec3.actual_state === 'RECOVERY_REQUIRED',
      { actual: rec3.actual_state });
    ok('FI4d_not_claimed_locked_after_reboot', s3.snapshot().protected === false);
    s3.stop();
  }

  result.pass = Object.values(result.cases).every((c) => c.pass);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  console.log('lock-v2-fault-injection: ' + (result.pass ? 'PASS' : 'FAIL') + ' ' + Object.keys(result.cases).length + ' cases');
  process.exit(result.pass ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
