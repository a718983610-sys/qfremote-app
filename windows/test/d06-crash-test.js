'use strict';
/*
 * D-06 崩溃处理测试（OBS 全套照搬）：
 *  A. 哨兵：首次启动无残留；第二次启动见残留（上次非正常退出）；
 *     干净退出拆哨兵后再次启动无残留。
 *  B. 崩溃报告：写盘成功、单份 ≤150KB（超限截断并标注）、报告头含
 *     版本/系统版本/模块名；只留最近 10 份。
 *  C. 上传守门：未同意不上传；同意但无端点不上传（不发请求）；
 *     同意＋有端点＋有最新报告才放行上传。
 *  D. --safe-mode 参数判定。
 *  E. 静态接线：main.js 在未捕获异常/未处理拒绝时写崩溃报告；
 *     before-quit 拆哨兵；whenReady 有安全模式二选一 dialog；
 *     同意后 POST 到崩溃上报端点、2xx 才删本地报告、失败保留。
 *  F. 上报载荷构造：本地文本报告解析往返、载荷白名单字段、stack
 *     超 128KB 截断、解析失败返回 null、端点路径常量。
 * 结果写 JSON 到 QFTEST_OUT，退出码 0=通过。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crash = require('../crash-handler');

const OUT = process.env.QFTEST_OUT || '/tmp/qfr-d06/d06-result.json';
const result = { cases: {}, pass: false };
const ok = (name, cond, extra) => { result.cases[name] = Object.assign({ pass: !!cond }, extra || {}); };

function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'qfr-d06-')); }

// ---------- A 哨兵 ----------
{
  const dir = tmpdir();
  ok('A1_first_no_sentinel', crash.markStartup(dir) === false);
  ok('A2_second_sees_sentinel', crash.markStartup(dir) === true);
  ok('A3_clean_removes', crash.markCleanShutdown(dir) === true && crash.hasSentinel(dir) === false);
  ok('A4_after_clean_no_sentinel', crash.markStartup(dir) === false);
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------- B 崩溃报告 ----------
{
  const dir = tmpdir();
  const big = 'x'.repeat(200 * 1024);
  const r = crash.writeCrashReport(dir, { version: '3.0.0', kind: 'uncaughtException', module: 'main', stack: big });
  ok('B1_write_ok', r.ok === true && !!r.file && fs.existsSync(r.file));
  ok('B2_cap_150k', r.bytes <= crash.MAX_CRASH_REPORT_SIZE && r.truncated === true, { bytes: r.bytes, cap: crash.MAX_CRASH_REPORT_SIZE });
  const text = fs.readFileSync(r.file, 'utf8');
  ok('B3_header', text.includes('version: 3.0.0') && text.includes('module: main') && text.includes('kind: uncaughtException'));
  ok('B4_latest', crash.latestCrashReport(dir) && crash.latestCrashReport(dir).file === r.file);
  // 只留最近 10 份
  for (let i = 0; i < 12; i++) crash.writeCrashReport(dir, { version: '3.0.0', kind: 'crash', stack: 's' + i });
  ok('B5_prune_10', crash.listCrashReports(dir).length <= crash.MAX_KEPT_REPORTS, { count: crash.listCrashReports(dir).length });
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------- C 上传守门 ----------
{
  const dir = tmpdir();
  const rep = crash.writeCrashReport(dir, { version: '3.0.0', kind: 'crash', stack: 'boom' });
  const latest = crash.latestCrashReport(dir);
  ok('C1_no_consent_skip', crash.decideUpload({ consented: false, endpoint: 'https://x.invalid/crash', latest }).action === 'skip');
  ok('C2_undefined_consent_skip', crash.decideUpload({ endpoint: 'https://x.invalid/crash', latest }).action === 'skip');
  ok('C3_consent_no_endpoint_skip', crash.decideUpload({ consented: true, endpoint: '', latest }).reason === 'no-endpoint');
  ok('C4_consent_endpoint_report_upload', crash.decideUpload({ consented: true, endpoint: 'https://x.invalid/crash', latest }).action === 'upload');
  ok('C5_no_report_skip', crash.decideUpload({ consented: true, endpoint: 'https://x.invalid/crash', latest: null }).reason === 'no-report');
  void rep;
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------- D --safe-mode ----------
ok('D1_flag', crash.safeModeFromArgv(['electron', '.', '--safe-mode']) === true);
ok('D2_no_flag', crash.safeModeFromArgv(['electron', '.']) === false);

// ---------- E main.js 静态接线 ----------
{
  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  ok('E1_uncaught_writes_report', mainSrc.includes("writeCrashReport(app.getPath('userData'), { version: app.getVersion(), kind: 'uncaughtException'"));
  ok('E2_rejection_writes_report', mainSrc.includes("kind: 'unhandledRejection'"));
  ok('E3_before_quit_clears_sentinel', mainSrc.includes('markCleanShutdown'));
  ok('E4_startup_marks_sentinel', mainSrc.includes('markStartup'));
  ok('E5_safe_mode_choice', mainSrc.includes('安全模式启动') && mainSrc.includes('safeMode = true'));
  ok('E6_upload_consent_dialog', mainSrc.includes('crashUploadConsent') && mainSrc.includes('是否把最近一份崩溃报告发给我们'));
  ok('E7_safe_mode_skips_heal', mainSrc.includes("if (!safeMode) runStartupAgentHeal()"));
  ok('E8_safe_mode_skips_update_check', mainSrc.includes("if (!safeMode) runUpdateCheck(5000, { auto: true })"));
  ok('E9_safe_mode_skips_silent_login', mainSrc.includes("if (!safeMode) startupAuthFlow()"));
  ok('E10_safe_mode_skips_preload', mainSrc.includes("if (safeMode) return;") && mainSrc.includes('不预加载社交视图'));
  ok('E11_upload_posts_to_endpoint', mainSrc.includes('CRASH_REPORT_PATH') && mainSrc.includes("extRequest('POST', crashEndpoint, payload, { noCookie: true })")); // L-09（C-4）：崩溃上传不附会话 Cookie
  ok('E12_upload_ok_deletes_local', mainSrc.includes('crash.upload-ok') && mainSrc.includes('fs.unlinkSync(dec.file)'));
  ok('E13_upload_fail_keeps_local', mainSrc.includes('crash.upload-failed'));
}

// ---------- F 上报载荷构造（CRASH-REPORT-SPEC.md） ----------
{
  const dir = tmpdir();
  const written = crash.writeCrashReport(dir, { version: '3.0.0', kind: 'uncaughtException', module: 'main', stack: 'Error: boom\n    at foo (a.js:1:1)' });
  const text = fs.readFileSync(written.file, 'utf8');
  const parsed = crash.parseCrashReportText(text);
  ok('F1_parse_roundtrip', !!parsed && parsed.version === '3.0.0' && parsed.kind === 'uncaughtException' && parsed.module === 'main' && parsed.stack === 'Error: boom\n    at foo (a.js:1:1)' && !Number.isNaN(Date.parse(parsed.time)));
  ok('F2_parse_bad_returns_null', crash.parseCrashReportText('not a crash report') === null && crash.parseCrashReportText('') === null);
  const fixedUuid = '123e4567-e89b-42d3-a456-426614174000';
  const payload = crash.buildCrashUploadPayload(text, { randomUUID: () => fixedUuid, arch: 'x64' });
  ok('F3_payload_fields', !!payload && payload.schema_version === 1 && payload.report_id === fixedUuid && payload.app_version === '3.0.0' && payload.platform.startsWith(process.platform) && payload.arch === 'x64' && payload.exception_type === 'uncaughtException' && payload.exit_code === null && payload.stack === 'Error: boom\n    at foo (a.js:1:1)');
  ok('F4_payload_unparseable_null', crash.buildCrashUploadPayload('garbage', {}) === null);
  const bigText = crash.buildReportHeader({ version: '3.0.0', kind: 'crash', module: 'main' }) + 'z'.repeat(200 * 1024);
  const bigPayload = crash.buildCrashUploadPayload(bigText, { randomUUID: () => fixedUuid, arch: 'x64' });
  ok('F5_payload_stack_truncated_128k', !!bigPayload && Buffer.byteLength(bigPayload.stack, 'utf8') <= crash.CRASH_STACK_MAX_BYTES && bigPayload.stack.includes('[truncated to 128KB by client]'));
  ok('F6_endpoint_path', crash.CRASH_REPORT_PATH === '/api/lea/v1/crash-report');
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------- G C-4（S-092 客户端脱敏、L-09/L-10/L-11，2026-11-15） ----------
{
  const dir = tmpdir();
  // S-092：上传载荷构造时堆栈已脱敏。
  const written = crash.writeCrashReport(dir, { version: '3.0.0', kind: 'uncaughtException', module: 'main', stack: 'Error: x\n    at C:\\Users\\Wayne\\AppData\\Local\\QFRemote\\main.js:10:5\n    at /home/wayne/note.txt:3:1\n    at load token: abc123' });
  const text = fs.readFileSync(written.file, 'utf8');
  const payload = crash.buildCrashUploadPayload(text, { randomUUID: () => '123e4567-e89b-42d3-a456-426614174000', arch: 'x64' });
  ok('G1_payload_stack_scrubbed', !!payload && !payload.stack.includes('Wayne') && !payload.stack.includes('wayne')
    && payload.stack.includes('C:\\Users\\<redacted>') && payload.stack.includes('/home/<redacted>')
    && payload.stack.includes('token: <redacted>'));
  ok('G2_scrub_fn_exported', typeof crash.scrubCrashStack === 'function'
    && crash.scrubCrashStack('at C:/Users/Bob/x.js:1:1').includes('C:/Users/<redacted>'));
  // L-11：写报告即补立哨兵（启动前崩溃也能在下次启动触发上传流程）。
  ok('G3_write_report_sets_sentinel', crash.hasSentinel(dir) === true);
  crash.markCleanShutdown(dir);
  ok('G4_sentinel_cleared_after_clean', crash.hasSentinel(dir) === false);
  // L-10：渲染进程崩溃记报告（helper 已备；main.js 接线点见 E14）。
  const rec = crash.recordRendererCrash(dir, { reason: 'crashed', exitCode: 5, view: 'console', version: '3.0.0' });
  const recText = rec.ok ? fs.readFileSync(rec.file, 'utf8') : '';
  ok('G5_renderer_crash_reported', rec.ok === true && recText.includes('kind: renderProcessGone')
    && recText.includes('module: console') && recText.includes('reason: crashed') && recText.includes('exitCode: 5'));
  fs.rmSync(dir, { recursive: true, force: true });
}

const failed = Object.keys(result.cases).filter((k) => !result.cases[k].pass);
result.pass = failed.length === 0;
result.failed = failed;
try { fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(result, null, 2)); } catch (e) { /* ignore */ }
console.log(JSON.stringify({ pass: result.pass, failed }));
process.exit(result.pass ? 0 : 1);
