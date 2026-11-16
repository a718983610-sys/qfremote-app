'use strict';
/*
 * QFRemote 连接看护（watchdog）——「断线不顾一切自动重连」的实现
 * ================================================================
 * 背景：MeshCentral 控制台里，远程桌面会话断开后，页面只显示一行
 * 「已断线」状态和一个「连接」按钮，原版要用户手动点。远程场景下
 * 人往往不在电脑旁，所以由应用外壳盯着这个状态、自动把按钮点掉。
 *
 * 判定逻辑（宁可慢一拍确认，也绝不在正常使用中乱触发）：
 *   1. 登录页豁免：页面上只要有可见的密码输入框，一律判定 'login'，
 *      看护不介入（会话还没建立，谈不上重连，也避免误点登录相关按钮）。
 *   2. 双标记同现才算断开：必须同时找到
 *        a) 文本恰好等于「已断线 / 已断开 / 未连接 / Disconnected」的可见叶子元素；
 *        b) 文本恰好等于「连接 / 重新连接 / Connect / Reconnect」的可见按钮。
 *      只有一个标记时判定 'partial'，不采取任何动作。
 *   3. 两次确认：连续两次轮询都判定 'disconnected' 才真正去点按钮，
 *      避开页面切换瞬间的残影。
 *   4. 点击前用同一套严格条件在页面里重新找一遍按钮，找不到就不点。
 *
 * 重试策略（RC-04 客户端层，3.0.0；FreeRDP 照抄）：
 *   - 轮询间隔 pollMs（默认 4 秒）；
 *   - 每次点击后进入冷却，冷却时长从 backoffStartMs（默认 5 秒）起
 *     每次翻倍，封顶 backoffMaxMs（默认 30 秒）：5s -> 10s -> 20s -> 30s -> 30s ...
 *   - 最多重试 maxAttempts 次（默认 5 次，见 reconnect-policy.js）：
 *     到顶即停手并报 'reconnect-failed'（带已试次数），等用户手动点
 *     连接；看护继续轮询，页面恢复 'ok' 后计数清零，下一轮断开重计；
 *   - 凭据类失败立即停：重连中一旦落到登录页（state==='login'），
 *     视为凭据/授权类失败，立即停手并报 'reconnect-stopped'，不刷屏；
 *   - 用户取消立即停：cancel() 后本轮断开不再自动点，报
 *     'reconnect-cancelled'；工具栏状态行显示“第 N 次 / 共 5 次”与
 *     取消按钮（见 main.js qf-conn-status 扩展 payload）。
 *   - 一旦检测恢复正常（'ok'），退避与确认计数全部清零；
 *   - 全程不弹任何对话框，状态只通过 onStatus 回调交给工具栏显示一行小字。
 *
 * 票据恢复层（RC-04 票据层，3.0.0；规范 RC-04-RECONNECT-TICKET-SPEC.md §5）：
 *   - 可选 onBeforeReconnect({ attempt, maxAttempts })：每次点击“连接”
 *     前调用（await），由调用方凭票据先试一次 resume；返回
 *     { stop: true, code } 时本轮立即停手、报 'reconnect-stopped'
 *    （附 reason=code，不再点按钮、不刷屏）；返回其它值或抛错时
 *     照常点击（票据层是加法：无票据／网络失败／服务端未实现端点
 *     时不阻塞原有点按钮重连）。钩子未传时行为与旧版完全一致。
 *   - 可选 onRecovered()：页面恢复 'ok' 且本轮曾进入重连时调用一次，
 *     调用方据此 Toast“已恢复连接”并为同一会话续领新票据。
 *   - 重试次数／退避／到顶仍由本模块 + reconnect-policy.js 管，票据层
 *     不自己数次数、不自己退避。
 *
 * 与整页加载失败的关系：整页都加载不出来时走 main.js 的断线友好页
 * （did-fail-load），不归本模块管；本模块只处理「页面在、会话断」。
 */

const reconnectPolicy = require('./reconnect-policy');

// 页面内状态检测脚本：返回 'login' | 'disconnected' | 'partial' | 'ok'
const DETECT_JS = `(function () {
  function visible(el) {
    if (!el) return false;
    var r = el.getBoundingClientRect();
    if (!r || r.width === 0 || r.height === 0) return false;
    var s = window.getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
  }
  var pw = document.querySelector('input[type="password"]');
  if (pw && visible(pw)) return 'login';
  var STATUS = ['已断线', '已断开', '未连接', 'Disconnected', 'Not connected'];
  var BTNS = ['连接', '重新连接', 'Connect', 'Reconnect'];
  var statusHit = false, btnHit = false;
  var texts = document.querySelectorAll('div, span, td, li, label, p');
  for (var i = 0; i < texts.length; i++) {
    var el = texts[i];
    if (el.children.length !== 0) continue;
    var t = (el.textContent || '').trim();
    if (STATUS.indexOf(t) >= 0 && visible(el)) { statusHit = true; break; }
  }
  var btns = document.querySelectorAll('button, a, input[type="button"], input[type="submit"]');
  for (var j = 0; j < btns.length; j++) {
    var b = btns[j];
    var bt = ((b.textContent || b.value || '') + '').trim();
    if (BTNS.indexOf(bt) >= 0 && visible(b)) { btnHit = true; break; }
  }
  if (statusHit && btnHit) return 'disconnected';
  if (statusHit || btnHit) return 'partial';
  return 'ok';
})()`;

// 页面内点击脚本：用与检测完全相同的严格条件重新定位按钮再点，点到返回 true
const CLICK_JS = `(function () {
  function visible(el) {
    if (!el) return false;
    var r = el.getBoundingClientRect();
    if (!r || r.width === 0 || r.height === 0) return false;
    var s = window.getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
  }
  var BTNS = ['连接', '重新连接', 'Connect', 'Reconnect'];
  var btns = document.querySelectorAll('button, a, input[type="button"], input[type="submit"]');
  for (var j = 0; j < btns.length; j++) {
    var b = btns[j];
    var bt = ((b.textContent || b.value || '') + '').trim();
    if (BTNS.indexOf(bt) >= 0 && visible(b)) { b.click(); return true; }
  }
  return false;
})()`;

function createWatchdog(getWebContents, options) {
  const opts = Object.assign({
    pollMs: 4000,
    confirmScans: 2,
    backoffStartMs: 5000,
    backoffMaxMs: 30000,
    maxAttempts: reconnectPolicy.DEFAULT_MAX_ATTEMPTS,
    onAttempt: () => {},
    enabled: () => true,
    onStatus: () => {},
    log: () => {}
  }, options || {});

  let stopped = false;
  let timer = null;
  let confirmCount = 0;
  let backoffMs = opts.backoffStartMs;
  let nextAttemptAt = 0;
  let reconnecting = false;
  let attemptCount = 0; // 本轮断开已试次数（RC-04：到顶即停）
  let episodeStopped = false; // 本轮已停手（到顶/凭据类/用户取消）
  let userCancelled = false;

  function reportAttempt() {
    try { opts.onAttempt({ attempt: attemptCount, maxAttempts: opts.maxAttempts, reconnecting }); } catch (e) { /* ignore */ }
  }

  function schedule(ms) {
    if (stopped) return;
    clearTimeout(timer);
    timer = setTimeout(tick, ms);
  }

  function setReconnecting(v) {
    if (reconnecting === v) return;
    reconnecting = v;
    try { opts.onStatus(v ? 'reconnecting' : 'ok'); } catch (e) { /* ignore */ }
  }

  async function tick() {
    if (stopped) return;
    let wc = null;
    try { wc = getWebContents(); } catch (e) { wc = null; }
    if (!wc || wc.isDestroyed() || !opts.enabled()) { schedule(opts.pollMs); return; }

    let state = 'unknown';
    try {
      state = await wc.executeJavaScript(DETECT_JS, true);
    } catch (e) {
      state = 'unknown'; // 页面正在跳转/重载：这一拍跳过，下一拍再看
    }
    if (stopped) return;
    opts.log('detect=' + state);

    if (state === 'disconnected') {
      confirmCount++;
      const now = Date.now();
      if (confirmCount >= opts.confirmScans && now >= nextAttemptAt && !episodeStopped) {
        // RC-04：先问策略能不能再试（凭据类/到顶/取消一律停）。
        const decision = reconnectPolicy.decide(attemptCount, 'network', {
          maxAttempts: opts.maxAttempts,
          minIntervalMs: opts.backoffStartMs,
          backoffMaxMs: opts.backoffMaxMs
        });
        if (!decision.retry) {
          episodeStopped = true;
          setReconnecting(false);
          try { opts.onStatus('reconnect-failed'); } catch (e) { /* ignore */ }
          opts.log('reconnect max-attempts reached (' + attemptCount + '/' + opts.maxAttempts + ')');
          confirmCount = 0;
          schedule(opts.pollMs);
          return;
        }
        setReconnecting(true);
        // RC-04 票据层：点击前先凭票据试一次 resume。钩子回报 stop
        // （凭据类：吊销/过期/重放/换绑/授权撤销）即本轮立即停手、
        // 报 reconnect-stopped（附 reason=错误码），不再点按钮；
        // 其余回报（成功／无票据／网络失败／端点未实现）或钩子抛错
        // 时照常点击——票据层不阻塞原有点按钮重连。
        if (typeof opts.onBeforeReconnect === 'function') {
          let verdict = null;
          try { verdict = await opts.onBeforeReconnect({ attempt: attemptCount + 1, maxAttempts: opts.maxAttempts }); } catch (e) { verdict = null; }
          if (stopped) return;
          if (verdict && verdict.stop) {
            episodeStopped = true;
            setReconnecting(false);
            try { opts.onStatus('reconnect-stopped', { reason: verdict.code || verdict.reason || 'credential' }); } catch (e) { /* ignore */ }
            opts.log('reconnect stopped: ticket ' + (verdict.code || verdict.reason || 'credential'));
            confirmCount = 0;
            schedule(opts.pollMs);
            return;
          }
        }
        let clicked = false;
        try { clicked = await wc.executeJavaScript(CLICK_JS, true); } catch (e) { clicked = false; }
        opts.log('reconnect click -> ' + clicked);
        if (clicked && typeof opts.onReconnect === 'function') {
          try { opts.onReconnect(); } catch (e) { /* ignore */ }
        }
        attemptCount++;
        reportAttempt();
        nextAttemptAt = Date.now() + decision.delayMs;
        backoffMs = Math.min(backoffMs * 2, opts.backoffMaxMs);
        confirmCount = 0;
      }
      schedule(opts.pollMs);
      return;
    }

    if (state === 'ok') {
      // 恢复正常：退避、确认计数、重试计数全部清零
      const wasReconnecting = reconnecting || attemptCount > 0;
      confirmCount = 0;
      backoffMs = opts.backoffStartMs;
      nextAttemptAt = 0;
      attemptCount = 0;
      episodeStopped = false;
      userCancelled = false;
      setReconnecting(false);
      // RC-04 票据层：本轮曾进入重连才报恢复（调用方 Toast＋续领新票据）。
      if (wasReconnecting && typeof opts.onRecovered === 'function') {
        try { opts.onRecovered(); } catch (e) { /* ignore */ }
      }
    } else {
      // login / partial / unknown：不动作，只把断开确认计数清掉，避免跨状态攒确认数
      confirmCount = 0;
      // RC-04：重连中落到登录页 = 凭据/授权类失败，立即停手，不刷屏。
      if (state === 'login' && (reconnecting || attemptCount > 0) && !episodeStopped) {
        episodeStopped = true;
        setReconnecting(false);
        try { opts.onStatus('reconnect-stopped'); } catch (e) { /* ignore */ }
        opts.log('reconnect stopped: landed on login page (credential)');
      }
    }
    schedule(opts.pollMs);
  }

  function cancel() {
    // 用户取消：本轮断开不再自动点。下一轮新断开（ok 后再断）重计。
    userCancelled = true;
    episodeStopped = true;
    setReconnecting(false);
    try { opts.onStatus('reconnect-cancelled'); } catch (e) { /* ignore */ }
  }

  return {
    start() { if (!stopped && !timer) schedule(800); },
    stop() { stopped = true; clearTimeout(timer); timer = null; },
    isReconnecting() { return reconnecting; },
    cancel,
    getAttemptInfo() { return { attempt: attemptCount, maxAttempts: opts.maxAttempts, stopped: episodeStopped, cancelled: userCancelled }; }
  };
}

module.exports = { createWatchdog, DETECT_JS, CLICK_JS };
