'use strict';
/*
 * RC-04 Windows 客户端层测试（断线重连两层之客户端层，3.0.0）：
 *  A. 策略单元（reconnect-policy.js）：最多 5 次、间隔 ≥5 秒、
 *     退避 5s→10s→20s→30s 封顶、凭据类/用户取消立即停、未分类
 *     只给 1 次试探、页面状态→失败种类映射、进度文案。
 *  B. 看护行为（watchdog.js＋假 webContents，无需 Electron）：
 *     断开后续点到顶即停并报 reconnect-failed；恢复 ok 后计数
 *     清零、下一轮重计；重连中落到登录页立即停并报
 *     reconnect-stopped；cancel() 立即停并报 reconnect-cancelled。
 *  C. 静态接线：main.js 看护配 maxAttempts: 5、工具栏状态行显示
 *     “第 N 次 / 共 5 次”＋取消按钮、qf-reconnect-cancel 通道在
 *     IPC 能力表内。
 * 注意：凭票据恢复原会话的那一层（服务端票据规范）由 L1 先出，
 * 规范未到之前不发明票据格式，本测试不覆盖票据恢复，见收尾报告。
 * 结果写 JSON 到 QFTEST_OUT，退出码 0=通过。
 */
const fs = require('fs');
const path = require('path');
const policy = require('../reconnect-policy');
const { createWatchdog, DETECT_JS, CLICK_JS } = require('../watchdog');

const OUT = process.env.QFTEST_OUT || '/tmp/qfr-rc04/rc04-result.json';
const result = { cases: {}, pass: false };
const ok = (name, cond, extra) => { result.cases[name] = Object.assign({ pass: !!cond }, extra || {}); };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- A 策略单元 ----------
ok('A1_defaults', policy.DEFAULT_MAX_ATTEMPTS === 5 && policy.DEFAULT_MIN_INTERVAL_MS === 5000 && policy.DEFAULT_BACKOFF_MAX_MS === 30000);
ok('A2_first_retry', (() => { const d = policy.decide(0, 'network'); return d.retry === true && d.delayMs === 5000; })());
ok('A3_max_stops', policy.decide(5, 'network').retry === false && policy.decide(5, 'network').reason === 'max-attempts');
ok('A4_credential_stops_immediately', policy.decide(0, 'credential').retry === false && policy.decide(0, 'credential').reason === 'credential-stop');
ok('A5_cancel_stops_immediately', policy.decide(0, 'cancelled').retry === false && policy.decide(0, 'cancelled').reason === 'user-cancelled');
ok('A6_unknown_single_probe', policy.decide(0, 'unknown').retry === true && policy.decide(1, 'unknown').retry === false);
ok('A7_backoff_ladder', policy.nextDelayMs(1) === 5000 && policy.nextDelayMs(2) === 10000 && policy.nextDelayMs(3) === 20000 && policy.nextDelayMs(4) === 30000 && policy.nextDelayMs(9) === 30000);
ok('A8_classify', policy.classifyPageState('login') === 'credential' && policy.classifyPageState('disconnected') === 'network' && policy.classifyPageState('partial') === 'unknown');
ok('A9_progress_text', policy.progressText(2, 5) === '正在重连（第 2 次 / 共 5 次）');

function fakeWc(stateFn, onClick) {
  return {
    isDestroyed: () => false,
    executeJavaScript: async (js) => {
      if (js === CLICK_JS) { onClick(); return true; }
      if (js === DETECT_JS) return stateFn();
      return 'unknown';
    }
  };
}

(async () => {
  // ---------- B1 到顶即停 ----------
  {
    let state = 'disconnected';
    let clicks = 0;
    const events = [];
    const wd = createWatchdog(() => fakeWc(() => state, () => { clicks++; }), {
      pollMs: 50, confirmScans: 1, backoffStartMs: 50, backoffMaxMs: 100,
      maxAttempts: 2, onStatus: (s) => events.push(s), log: () => {}
    });
    wd.start();
    await sleep(2500);
    wd.stop();
    ok('B1_clicks_capped_at_max', clicks === 2, { clicks });
    ok('B2_reports_failed', events.includes('reconnect-failed'), { events });
    ok('B3_attempt_info', wd.getAttemptInfo().attempt === 2 && wd.getAttemptInfo().stopped === true);
  }

  // ---------- B2 恢复后清零、下一轮重计 ----------
  {
    let state = 'disconnected';
    let clicks = 0;
    const wd = createWatchdog(() => fakeWc(() => state, () => { clicks++; }), {
      pollMs: 50, confirmScans: 1, backoffStartMs: 50, backoffMaxMs: 100,
      maxAttempts: 5, onStatus: () => {}, log: () => {}
    });
    wd.start();
    await sleep(1200);
    const clicksFirstRound = clicks;
    state = 'ok';
    await sleep(600);
    ok('B4_ok_resets', wd.getAttemptInfo().attempt === 0 && wd.getAttemptInfo().stopped === false, { clicksFirstRound });
    state = 'disconnected';
    await sleep(1200);
    wd.stop();
    ok('B5_second_round_retries_again', clicks > clicksFirstRound, { clicks, clicksFirstRound });
  }

  // ---------- B3 凭据类立即停 ----------
  {
    let state = 'disconnected';
    let clicks = 0;
    const events = [];
    const wd = createWatchdog(() => fakeWc(() => state, () => { clicks++; }), {
      pollMs: 50, confirmScans: 1, backoffStartMs: 50, backoffMaxMs: 100,
      maxAttempts: 5, onStatus: (s) => events.push(s), log: () => {}
    });
    wd.start();
    await sleep(1200); // 先点一次，进入重连中
    const clicksBeforeLogin = clicks;
    state = 'login'; // 落到登录页＝凭据/授权类失败
    await sleep(1200);
    wd.stop();
    ok('B6_credential_stops', clicks === clicksBeforeLogin, { clicks, clicksBeforeLogin });
    ok('B7_reports_stopped', events.includes('reconnect-stopped'), { events });
  }

  // ---------- B4 用户取消立即停 ----------
  {
    let state = 'disconnected';
    let clicks = 0;
    const events = [];
    const wd = createWatchdog(() => fakeWc(() => state, () => { clicks++; }), {
      pollMs: 50, confirmScans: 1, backoffStartMs: 50, backoffMaxMs: 100,
      maxAttempts: 5, onStatus: (s) => events.push(s), log: () => {}
    });
    wd.start();
    await sleep(1200);
    const clicksBeforeCancel = clicks;
    wd.cancel();
    await sleep(1200);
    wd.stop();
    ok('B8_cancel_stops', clicks === clicksBeforeCancel, { clicks, clicksBeforeCancel });
    ok('B9_reports_cancelled', events.includes('reconnect-cancelled'), { events });
  }

  // ---------- C 静态接线 ----------
  {
    const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    ok('C1_watchdog_max_attempts', mainSrc.includes('maxAttempts: 5'));
    ok('C2_cancel_ipc', mainSrc.includes("trustedOn('qf-reconnect-cancel'") && mainSrc.includes('watchdog.cancel()'));
    ok('C3_status_payload', mainSrc.includes('broadcastConnStatus'));
    const trustSrc = fs.readFileSync(path.join(__dirname, '..', 'ipc-trust.js'), 'utf8');
    ok('C4_capability_table', trustSrc.includes("'qf-reconnect-cancel': [{ file: 'toolbar.html' }]"));
    const toolbarSrc = fs.readFileSync(path.join(__dirname, '..', 'toolbar.html'), 'utf8');
    ok('C5_toolbar_progress', toolbarSrc.includes('正在重连（第') && toolbarSrc.includes('/ 共 '));
    ok('C6_toolbar_cancel_button', toolbarSrc.includes('statusCancel') && toolbarSrc.includes('cancelReconnect'));
    const preloadSrc = fs.readFileSync(path.join(__dirname, '..', 'toolbar-preload.js'), 'utf8');
    ok('C7_preload_cancel_bridge', preloadSrc.includes('cancelReconnect') && preloadSrc.includes("'qf-reconnect-cancel'"));
  }

  const failed = Object.keys(result.cases).filter((k) => !result.cases[k].pass);
  result.pass = failed.length === 0;
  result.failed = failed;
  try { fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(result, null, 2)); } catch (e) { /* ignore */ }
  console.log(JSON.stringify({ pass: result.pass, failed }));
  process.exit(result.pass ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
