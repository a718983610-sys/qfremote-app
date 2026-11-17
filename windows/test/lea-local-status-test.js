'use strict';
/*
 * lea-local-status-test.js — S-021：LEA 本机状态查询（Electron 侧）。
 * 覆盖 windows/lea-status.js 的解析层（parseLeaStatusResponse /
 * buildLeaStatusRequest）＋ main.js / ipc-trust.js 的静态接线：
 *  A. 请求构造：buildLeaStatusRequest 返 { cmd: 'lea.status' }；
 *  B. 完整响应归一化（全部字段）；
 *  C. ok:false 时仍归一化结果字段、ok 透传 false；
 *  D. 脏数据（null／字符串／数组／缺 result）一律默认态、不抛错；
 *  E. 类型错（paused 为字符串、时间为字符串）按默认处理；
 *  F. 多余字段忽略；unicode 账号保留；
 *  G. 静态接线：main.js 注册 qf-lea-local-status 且经 leaNotifyInternalAsync
 *     问 lea.status；ipc-trust.js 能力表把该通道归到 about.html。
 * 结果写 JSON 到 QFTEST_OUT，退出码 0=通过。
 */
const fs = require('fs');
const path = require('path');
const leaStatus = require('../lea-status');
const trust = require('../ipc-trust');

const OUT = process.env.QFTEST_OUT || '/tmp/qfr-lea-local/lea-local-status-result.json';
const result = { cases: {}, pass: false };
const ok = (name, cond, extra) => { result.cases[name] = Object.assign({ pass: !!cond }, extra || {}); };
const SRC = path.join(__dirname, '..');

function fullResp() {
  return {
    ok: true, code: 'done', request_id: 'req-1', retryable: false, detail: '',
    result: {
      paused: true, dangerous_consented: true, dangerous_consented_at: 1700000001,
      revoked_all: false, revoked_at: 0, account_id: 'alice', device_id: 'node-1',
      last_command: 'ui.click', last_result: 'ok', last_command_at: 1700000002
    }
  };
}

// ---------- A. 请求构造 ----------
{
  const req = leaStatus.buildLeaStatusRequest();
  ok('A1_request_cmd', req && req.cmd === 'lea.status' && Object.keys(req).length === 1);
}

// ---------- B. 完整响应归一化 ----------
{
  const p = leaStatus.parseLeaStatusResponse(fullResp());
  ok('B1_full_fields', p.ok === true && p.code === 'done' && p.paused === true &&
    p.dangerous_consented === true && p.dangerous_consented_at === 1700000001 &&
    p.revoked_all === false && p.revoked_at === 0 && p.account_id === 'alice' &&
    p.device_id === 'node-1' && p.last_command === 'ui.click' &&
    p.last_result === 'ok' && p.last_command_at === 1700000002);
  // 裸 result 对象（无 build_resp 外壳）同样归一化。
  const p2 = leaStatus.parseLeaStatusResponse(fullResp().result);
  ok('B2_bare_result_object', p2.paused === true && p2.account_id === 'alice' &&
    p2.last_command === 'ui.click');
}

// ---------- C. ok:false ----------
{
  const r = fullResp();
  r.ok = false; r.code = 'QFR_LEA_PAUSED';
  const p = leaStatus.parseLeaStatusResponse(r);
  ok('C1_error_passthrough', p.ok === false && p.code === 'QFR_LEA_PAUSED' &&
    p.paused === true && p.account_id === 'alice');
}

// ---------- D. 脏数据默认态、不抛错 ----------
{
  let threw = false;
  let p1, p2, p3, p4;
  try {
    p1 = leaStatus.parseLeaStatusResponse(null);
    p2 = leaStatus.parseLeaStatusResponse('garbage');
    p3 = leaStatus.parseLeaStatusResponse([1, 2, 3]);
    p4 = leaStatus.parseLeaStatusResponse({ ok: true });
  } catch (e) { threw = true; }
  ok('D1_dirty_defaults', !threw && p1 && p1.ok === false && p1.paused === false &&
    p1.account_id === '' && p2 && p2.last_command === '' &&
    p3 && p3.device_id === '' && p4 && p4.paused === false && p4.ok === true);
  // result:null 时同样默认态、不抛错。
  const p5 = leaStatus.parseLeaStatusResponse({ ok: true, result: null });
  ok('D2_null_result_defaults', p5 && p5.ok === true && p5.paused === false && p5.account_id === '');
}

// ---------- E. 类型错按默认 ----------
{
  const r = fullResp();
  r.result.paused = 'yes';
  r.result.last_command_at = 'soon';
  r.result.account_id = 12345;
  const p = leaStatus.parseLeaStatusResponse(r);
  ok('E1_wrong_types_default', p.paused === false && p.last_command_at === 0 &&
    p.account_id === '' && p.dangerous_consented === true);
}

// ---------- F. 多余字段忽略、unicode 保留 ----------
{
  const r = fullResp();
  r.result.evil = 'x';
  r.result.account_id = 'alice\u4e2d\u6587';
  r.extra_top = { nested: true };
  const p = leaStatus.parseLeaStatusResponse(r);
  ok('F1_extra_ignored_unicode_kept', p.evil === undefined && p.extra_top === undefined &&
    p.account_id === 'alice\u4e2d\u6587');
}

// ---------- G. 静态接线 ----------
{
  const mainSrc = fs.readFileSync(path.join(SRC, 'main.js'), 'utf8');
  ok('G1_main_registers_channel', /trustedHandle\('qf-lea-local-status'/.test(mainSrc));
  ok('G2_main_uses_local_pipe', mainSrc.includes("leaNotifyInternalAsync(leaStatus.buildLeaStatusRequest(), 10000)"));
  ok('G3_main_requires_lea_status', /require\('\.\/lea-status'\)/.test(mainSrc));
  ok('G4_capability_about', trust.IPC_CAPABILITIES['qf-lea-local-status'] &&
    trust.IPC_CAPABILITIES['qf-lea-local-status'].length === 1 &&
    trust.IPC_CAPABILITIES['qf-lea-local-status'][0].file === 'about.html');
  // about.html 主框架 sender 应放行；toolbar.html 同通道应拒绝。
  const s = { isDestroyed: () => false, getURL: () => '' };
  const mkCtx = () => ({ dirname: '/home/x/windows', platform: 'posix',
    trustedOrigins: () => new Set(['https://app.qfremote.top']),
    allWindows: () => [{ webContents: null,
      contentView: { children: [{ webContents: s }] }, isDestroyed: () => false }] });
  const mkEvent = (url) => ({ sender: s,
    senderFrame: { parent: null, url, isDestroyed: () => false } });
  ok('G5_about_allowed_toolbar_denied',
    trust.assertTrustedSender(mkEvent('file:///home/x/windows/about.html'), 'qf-lea-local-status', mkCtx()) === true &&
    trust.assertTrustedSender(mkEvent('file:///home/x/windows/toolbar.html'), 'qf-lea-local-status', mkCtx()) === false);
}

result.pass = Object.values(result.cases).every((c) => c.pass);
try { fs.mkdirSync(path.dirname(OUT), { recursive: true }); } catch (e) { /* ignore */ }
try { fs.writeFileSync(OUT, JSON.stringify(result, null, 2)); } catch (e) { /* ignore */ }
console.log(JSON.stringify({ pass: result.pass, failed: Object.keys(result.cases).filter((k) => !result.cases[k].pass) }));
process.exit(result.pass ? 0 : 1);
