'use strict';
/*
 * 隐私锁 v2 八问测试（B 线，阶段 3 P3-04；沙箱实跑）：
 *  #3 disarm 事件补 fields.lockId；#4 unlock-ok ts 为 ISO 且与 arm 可比；
 *  #5 boot-recovered 在重启恢复时必写（且只写一次）；
 *  #6 status.json 补 boot_id/session_id/sid；#7 revision 每次变更 +1；
 *  #8 重复 disarm 信封必拒；#9 captureExclusion 写入时机与 unknown 语义。
 * 结果写 JSON 到 QFTEST_OUT，退出码 0=通过。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AsyncIpcServer, MemoryTransport } = require('../lock-v2/lock-ipc');
const { LockCoordinator } = require('../lock-v2/lock-coordinator');
const { StatusReporter } = require('../lock-v2/status-report');
const { EnvelopeReplayGuard } = require('../lock-v2/envelope-replay');

const OUT = process.env.QFTEST_OUT || '/tmp/qfr200/lock-v2-8q-result.json';
const result = { cases: {}, pass: false };
const ok = (name, cond, extra) => { result.cases[name] = Object.assign({ pass: !!cond }, extra || {}); };

const SID = 'S-1-5-21-test';

// 递增时钟：每次调用前进 1 秒，保证 arm/unlock-ok 的 ts 可比且有序。
function makeClock(startMs) {
  let t = startMs;
  return () => { const d = new Date(t); t += 1000; return d; };
}

function makeFakeAgent(serverTransport, opts) {
  const o = opts || {};
  let locked = false; let lockId = null;
  const server = new AsyncIpcServer(serverTransport, async (method, params) => {
    switch (method) {
      case 'ping': return { alive: true, locked, lock_id: lockId, displayOff: locked, session_id: 1 };
      case 'arm':
        locked = true; lockId = params.lock_id;
        return { locked: true, lock_id: lockId, display_off: true, display_power_ok: true, capture_exclusion: o.captureExclusion };
      case 'disarm': locked = false; lockId = null; return { locked: false };
      case 'status': return { locked, lock_id: lockId, displayOff: locked, failsafe: false, session_id: 1 };
      case 'failsafe-lock': return { failsafe: true };
      default: throw new Error('unknown method ' + method);
    }
  });
  return { server };
}

function makeProvider() {
  const session = { sessionId: 1, userSid: SID, active: true };
  return {
    getInteractiveSession: async () => session,
    spawnSessionAgent: async () => {
      const pair = MemoryTransport.pair();
      makeFakeAgent(pair[1], {});
      return pair[0];
    }
  };
}

function makeCoordinator(dir, extra) {
  const o = extra || {};
  return new LockCoordinator(Object.assign({
    deviceId: 'dev-test-1', bootId: 'boot-1', stateDir: dir,
    sessionProvider: makeProvider(),
    displayPower: { setDisplayPower: async () => ({ ok: true }) },
    serverReport: async () => {},
    heartbeatIntervalMs: 60000, ackTimeoutMs: 2000
  }, o));
}

(async () => {
  // ---- #3：disarm 补 lockId ----
  {
    const r = new StatusReporter({ clock: makeClock(Date.parse('2026-11-19T04:00:00.000Z')) });
    let threw = false;
    try { r.recordDisarm('owner', ''); } catch (e) { threw = true; }
    ok('#3-disarm-缺lockId抛错', threw);
    const e = r.recordDisarm('owner@example.com', 'lock-abc');
    ok('#3-disarm-fields含lockId', e.ev === 'disarm' && e.fields.lockId === 'lock-abc' && e.fields.by === 'owner@example.com');
    const a = r.recordArm('lock-abc', 'owner@example.com');
    ok('#3-arm-fields含armId与lockId', a.fields.armId === 'lock-abc' && a.fields.lockId === 'lock-abc');
  }

  // ---- #4：unlock-ok ts 为 ISO 且与 arm 可比 ----
  {
    const r = new StatusReporter({ clock: makeClock(Date.parse('2026-11-19T04:00:00.000Z')) });
    const arm = r.recordArm('lock-1', 'owner');
    const un = r.recordUnlockOk('lock-1', 'local-unlock');
    const armMs = Date.parse(arm.ts);
    const unMs = Date.parse(un.ts);
    ok('#4-ts均为ISO可解析', Number.isFinite(armMs) && Number.isFinite(unMs) && /\.000Z$/.test(arm.ts) && un.ts.endsWith('Z'));
    ok('#4-unlock-ok晚于arm且可比', unMs > armMs);
    ok('#4-unlock-ok-fields含lockId', un.fields.lockId === 'lock-1');
    // 秘密键白名单：password/hash 类字段一律丢弃。
    r.appendEvent('arm', { lockId: 'lock-1', password: 'nope', pwHash: 'x', token: 'y' });
    const last = r.lastEvents()[r.lastEvents().length - 1];
    ok('#4-秘密字段不进审计', last.fields.password === undefined && last.fields.pwHash === undefined && last.fields.token === undefined && last.fields.lockId === 'lock-1');
  }

  // ---- lastEvents 只留最近 10 条 ----
  {
    const r = new StatusReporter({});
    for (let i = 0; i < 12; i++) r.appendEvent('arm', { lockId: 'lock-' + i });
    ok('#4-lastEvents只留10条', r.lastEvents().length === 10 && r.lastEvents()[0].fields.lockId === 'lock-2');
  }

  // ---- #6/#7：status.json 字段 ----
  {
    const r = new StatusReporter({ clock: makeClock(Date.parse('2026-11-19T04:00:00.000Z')) });
    const snap = { lock_id: 'lock-9', device_id: 'dev-1', boot_id: 'boot-7', session_id: 1, user_sid: SID, sid: SID, armed_at: null, revision: 5, actual_state: 'LOCKED', desired_state: 'LOCKED', last_heartbeat: null, last_error: null, degradation: null };
    const st = r.buildStatus(snap, { ownerUsername: 'owner', version: '2.0.0' });
    ok('#6-boot_id/session_id/sid齐全', st.boot_id === 'boot-7' && st.session_id === 1 && st.sid === SID);
    ok('#6-sid是用户SID不是会话号', st.sid === SID && st.session_id !== SID);
    ok('#7-revision原样写入', st.revision === 5);
    ok('#6-state映射LOCKED为Locked', st.state === 'Locked' && st.actual_state === 'LOCKED');
    const st2 = r.buildStatus(Object.assign({}, snap, { actual_state: 'LOCKING', revision: 6 }), {});
    ok('#6-state映射LOCKING为Off（送达≠成功）', st2.state === 'Off' && st2.actual_state === 'LOCKING');
    const st3 = r.buildStatus(Object.assign({}, snap, { actual_state: 'UNKNOWN', revision: 7 }), {});
    ok('#6-state映射UNKNOWN为Off', st3.state === 'Off');
  }

  // ---- #7：revision 每次真实变更 +1，同态不 +1 ----
  {
    const { LockStateMachine } = require('../lock-v2/lock-state');
    const m = new LockStateMachine({ deviceId: 'd', bootId: 'b' });
    const r0 = m.revision;
    m.transition('LOCKING', { reason: 't' });
    const r1 = m.revision;
    m.transition('LOCKING', { reason: 'same-state' });
    const r2 = m.revision;
    ok('#7-每次变更revision+1', r1 === r0 + 1);
    ok('#7-同态转移不升revision', r2 === r1);
  }

  // ---- #9：captureExclusion ----
  {
    const r = new StatusReporter({});
    ok('#9-初始unknown', r.captureExclusion === 'unknown');
    let threw = false;
    try { r.setCaptureExclusion('bogus'); } catch (e) { threw = true; }
    ok('#9-非法值抛错', threw);
    ok('#9-unknown下LOCKED判DEGRADED', r.degradedFor('LOCKED') === 'DEGRADED');
    ok('#9-unknown下UNLOCKED不判降级', r.degradedFor('UNLOCKED') === null);
    r.setCaptureExclusion('failed-degraded');
    ok('#9-failed-degraded判DEGRADED', r.degradedFor('LOCKED') === 'DEGRADED');
    r.setCaptureExclusion('active');
    ok('#9-active不降级', r.degradedFor('LOCKED') === null);
  }

  // ---- #8：信封去重守卫 ----
  {
    const g = new EnvelopeReplayGuard({});
    ok('#8-首次不重放', g.check('env-1').replay === false);
    g.remember('env-1');
    const chk = g.check('env-1');
    ok('#8-重复必拒', chk.replay === true && chk.code === 'E_ENVELOPE_REPLAY');
    ok('#8-未记过的id可执行', g.check('env-2').replay === false);
    for (let i = 0; i < 70; i++) g.remember('env-x' + i);
    ok('#8-上限64条滚动', g.count() === 64 && !g.has('env-1'));
  }

  // ---- 协调层贯通：arm → 本地密码解锁（unlock-ok＋disarm） ----
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qfr-lockv2-8q-'));
    const reporter = new StatusReporter({ clock: makeClock(Date.parse('2026-11-19T04:00:00.000Z')) });
    const coord = makeCoordinator(dir, { statusReporter: reporter });
    const armRes = await coord.arm({ password: 'pw-123456', caller: 'owner@example.com', lockId: 'lock-100' });
    ok('C1-arm成功', armRes.ok === true && armRes.actual_state === 'LOCKED');
    const un = await coord.unlockWithPassword('pw-123456');
    ok('C1-本地密码解锁成功', un.ok === true && un.actual_state === 'UNLOCKED');
    const evs = reporter.lastEvents();
    const unlockOk = evs.find((e) => e.ev === 'unlock-ok');
    const disarm = evs.find((e) => e.ev === 'disarm');
    const armEv = evs.find((e) => e.ev === 'arm');
    ok('C1-unlock-ok与disarm均含同一lockId', !!unlockOk && !!disarm && unlockOk.fields.lockId === 'lock-100' && disarm.fields.lockId === 'lock-100');
    ok('C1-unlock-ok-ts晚于arm-ts', !!armEv && !!unlockOk && Date.parse(unlockOk.ts) > Date.parse(armEv.ts));
    const st = coord.statusJson({ ownerUsername: 'owner' });
    ok('C1-statusJson含三身份字段', st.boot_id === 'boot-1' && st.session_id === 1 && st.sid === SID && typeof st.revision === 'number' && st.revision > 0);
    coord.stop();
  }

  // ---- 协调层贯通：重复 disarm 信封必拒 ----
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qfr-lockv2-8q-'));
    const reporter = new StatusReporter({});
    const guard = new EnvelopeReplayGuard({});
    const coord = makeCoordinator(dir, { statusReporter: reporter, envelopeReplay: guard });
    await coord.arm({ password: 'pw-123456', caller: 'owner@example.com', lockId: 'lock-200' });
    const revBefore = coord.machine.revision;
    const d1 = await coord.disarm({ caller: 'owner@example.com', envelopeId: 'env-disarm-1' });
    ok('C2-首次disarm成功', d1.ok === true && d1.actual_state === 'UNLOCKED');
    const revAfter = coord.machine.revision;
    let code = '';
    try { await coord.disarm({ caller: 'owner@example.com', envelopeId: 'env-disarm-1' }); } catch (e) { code = e.code; }
    ok('C2-重复信封拒E_ENVELOPE_REPLAY', code === 'E_ENVELOPE_REPLAY');
    ok('C2-重复信封不改状态不升revision', coord.machine.actualState === 'UNLOCKED' && coord.machine.revision === revAfter && revAfter > revBefore);
    ok('C2-重放记envelope-rejected事件', reporter.lastEvents().some((e) => e.ev === 'envelope-rejected' && e.fields.reason === 'replay' && e.fields.id === 'env-disarm-1'));
    coord.stop();
  }

  // ---- 协调层贯通：重启后 boot-recovered 必写且只写一次 ----
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qfr-lockv2-8q-'));
    const reporter = new StatusReporter({});
    const c1 = makeCoordinator(dir, { statusReporter: reporter });
    await c1.arm({ password: 'pw-123456', caller: 'owner@example.com', lockId: 'lock-300' });
    c1.stop();
    const c2 = makeCoordinator(dir, { statusReporter: reporter, bootId: 'boot-2' });
    const rec = await c2.recoverAfterRestart();
    const boots = reporter.lastEvents().filter((e) => e.ev === 'boot-recovered');
    ok('C3-重启恢复写boot-recovered', boots.length === 1 && boots[0].fields.bootId === 'boot-2' && boots[0].fields.previousState === 'LOCKED' && boots[0].fields.lockId === 'lock-300');
    ok('C3-重启后旧LOCKED置UNKNOWN不谎报', rec.actual_state === 'UNKNOWN');
    const rec2 = await c2.recoverAfterRestart();
    const boots2 = reporter.lastEvents().filter((e) => e.ev === 'boot-recovered');
    ok('C3-重复恢复不再写boot-recovered', boots2.length === 1 && rec2.actual_state === 'UNKNOWN');
    c2.stop();
  }

  result.pass = Object.values(result.cases).every((c) => c.pass === true);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.pass ? 0 : 1);
})().catch((e) => {
  result.error = e && e.stack || String(e);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  console.error(e);
  process.exit(1);
});
