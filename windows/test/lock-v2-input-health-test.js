'use strict';
/*
 * 隐私锁 v2 输入健康测试（B 线，沙箱实跑）：
 *  A. operation_id 五段追踪：分开记“收到/执行成功/应用响应”，失败段定位；
 *  B. 健康探针：连续失败 1 次 degraded、2 次 failed；恢复后 healthy；
 *  C. 重核：会话/SID 不符绝不恢复输入；
 *  D. 只重建控制通道：重建函数被调、重核通过后才 healthy，不碰整桌断开。
 * 结果写 JSON 到 QFTEST_OUT，退出码 0=通过。
 */
const fs = require('fs');
const path = require('path');
const { InputOperationTrace, InputHealthMonitor, STAGES } = require('../lock-v2/input-health');

const OUT = process.env.QFTEST_OUT || '/tmp/qfr200/lock-v2-input-result.json';
const result = { cases: {}, pass: false };
const ok = (name, cond, extra) => { result.cases[name] = Object.assign({ pass: !!cond }, extra || {}); };

(async () => {
  // A
  const t = new InputOperationTrace(null, 'click');
  ok('A1_op_id_shape', /^op-[0-9a-f]{16}$/.test(t.operation_id), { operation_id: t.operation_id });
  ok('A2_five_stages', STAGES.length === 5);
  t.mark('ui_event', true).mark('signal_received', true).mark('ush_execute', true);
  t.mark('window_target', false, '点击未到达正确窗口');
  ok('A3_failed_stage_located', t.verdict === 'failed' && t.failedStage === 'window_target');
  const j = t.toJSON();
  ok('A4_trace_json', j.stages.window_target.ok === false && j.stages.ush_execute.ok === true);
  const t2 = new InputOperationTrace(null, 'hotkey');
  t2.mark('ui_event', true).mark('signal_received', true).mark('ush_execute', true)
    .mark('window_target', true).mark('video_feedback', true).finishOk();
  ok('A5_full_path_ok', t2.verdict === 'ok' && t2.done === true);

  // B
  let probeOk = true;
  const mon = new InputHealthMonitor({
    probe: async () => (probeOk ? { ok: true } : { ok: false, detail: 'USH 探针无响应' }),
    probeIntervalMs: 60000, failThreshold: 2
  });
  const r0 = await mon.probeOnce();
  ok('B1_healthy', r0.ok === true && mon.status === 'healthy');
  probeOk = false;
  const r1 = await mon.probeOnce();
  ok('B2_first_fail_degraded', r1.ok === false && mon.status === 'degraded', { status: mon.status });
  const r2 = await mon.probeOnce();
  ok('B3_second_fail_failed', r2.ok === false && mon.status === 'failed', { status: mon.status });
  const rep = mon.report();
  ok('B4_report_explicit', rep.input_status === 'failed' && /不可用/.test(rep.note));
  probeOk = true;
  const r3 = await mon.probeOnce();
  ok('B5_recover_healthy', r3.ok === true && mon.status === 'healthy');
  mon.stop();

  // C
  const mon2 = new InputHealthMonitor({});
  const bad = await mon2.reverifyAfterDisruption(
    async () => ({ ok: true, sessionId: 2, userSid: 'S-1-5-21-test' }),
    { sessionId: 1, userSid: 'S-1-5-21-test' });
  ok('C1_session_mismatch_no_recovery', bad.ok === false && bad.code === 'SESSION_MISMATCH' && mon2.status === 'failed');
  const good = await mon2.reverifyAfterDisruption(
    async () => ({ ok: true, sessionId: 1, userSid: 'S-1-5-21-test' }),
    { sessionId: 1, userSid: 'S-1-5-21-test' });
  ok('C2_match_recovery', good.ok === true && mon2.status === 'healthy');
  const noFn = await mon2.reverifyAfterDisruption(null, {});
  ok('C3_no_reverify_fn_failed', noFn.ok === false && noFn.code === 'NO_REVERIFY');
  mon2.stop();

  // D
  let rebuildCalls = 0;
  const mon3 = new InputHealthMonitor({});
  const rebuilt = await mon3.rebuildControlChannelOnly(
    async () => { rebuildCalls += 1; return { ok: true }; },
    async () => ({ ok: true, sessionId: 1, userSid: 'S-1-5-21-test' }),
    { sessionId: 1, userSid: 'S-1-5-21-test' });
  ok('D1_rebuild_channel_only', rebuilt.ok === true && rebuildCalls === 1 && mon3.status === 'healthy');
  const rebuiltFail = await mon3.rebuildControlChannelOnly(
    async () => ({ ok: false, detail: '控制通道重建失败' }),
    async () => ({ ok: true, sessionId: 1, userSid: 'S-1-5-21-test' }),
    { sessionId: 1, userSid: 'S-1-5-21-test' });
  ok('D2_rebuild_fail_reported', rebuiltFail.ok === false && rebuiltFail.code === 'REBUILD_FAILED' && mon3.status === 'failed');
  mon3.stop();

  result.pass = Object.values(result.cases).every((c) => c.pass);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  console.log('lock-v2-input: ' + (result.pass ? 'PASS' : 'FAIL') + ' ' + Object.keys(result.cases).length + ' cases');
  process.exit(result.pass ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
