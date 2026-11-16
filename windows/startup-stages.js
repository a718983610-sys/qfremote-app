'use strict';
/*
 * QFRemote Windows 运行端 — 分阶段初始化（D-08，3.0.0）
 * ================================================================
 * 来源：VS Code 工作台四阶段初始化（BlockStartup / BlockRestore /
 * AfterRestored / Eventually，最后一档启动后 2–5 秒才跑）、Joplin
 * 离线优先（启动不依赖网络）、Clash Verge Rev（核心服务/托盘/
 * 热键/更新检查并行起，窗口先出来再补初始化；初始化中途出错也
 * 要尽力把窗口拉起来并显示错误，而不是静默退掉）。
 * 阶段划分（main.js whenReady 按此顺序执行，见 runStartupStages）：
 *   stage1 window   —— 只做“窗口出现”：建主窗＋启动画面，不发
 *                      任何网络请求，不等任何异步初始化；
 *   stage2 essential—— 窗口出现后才做：启动更新门（带超时，超时/
 *                      出错即放行进主窗，绝不卡启动）、控制台首载；
 *   stage3 deferred —— 启动后 2–5 秒才跑：服务地址刷新、探活、
 *                      软件内更新检查、agent 自愈、积分心跳、社交
 *                      视图预加载；每步独立 try/catch＋超时，某步
 *                      失败只记日志，不影响窗口与其它步骤。
 * 本模块只提供“带超时的阶段执行器＋阶段表”两个纯构件，main.js
 * 负责把真实步骤挂进来；单测断言阶段顺序、超时放行、单步失败
 * 不拖垮整条链。
 */
const STAGES = Object.freeze([
  { name: 'window', network: false, note: '只建窗口，不发网络请求' },
  { name: 'essential', network: true, note: '更新门（带超时）＋控制台首载' },
  { name: 'deferred', network: true, note: '启动后 2–5 秒：探活/更新检查/自愈/心跳/预加载' }
]);

// 带超时的单步执行：fn 超时或抛错都返回 { ok:false }，不抛到调用方。
// timeoutMs<=0 表示不限时（只包抛错）。
function runStep(fn, timeoutMs, log) {
  const say = log || (() => {});
  let p;
  try {
    p = Promise.resolve().then(fn);
  } catch (e) {
    return Promise.resolve({ ok: false, error: String((e && e.message) || e), timedOut: false });
  }
  if (!timeoutMs || timeoutMs <= 0) {
    return p.then(
      (v) => ({ ok: true, value: v }),
      (e) => ({ ok: false, error: String((e && e.message) || e), timedOut: false })
    );
  }
  let timer = null;
  const timeoutP = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, error: 'timeout after ' + timeoutMs + 'ms', timedOut: true }), timeoutMs);
  });
  return Promise.race([
    p.then(
      (v) => ({ ok: true, value: v }),
      (e) => ({ ok: false, error: String((e && e.message) || e), timedOut: false })
    ),
    timeoutP
  ]).then((r) => { if (timer) clearTimeout(timer); if (!r.ok) say('startup-step.failed ' + r.error); return r; });
}

// 顺序跑一组步骤：某步失败只记日志、继续下一步；返回每步结果。
async function runStages(steps, opts) {
  const o = opts || {};
  const log = o.log || (() => {});
  const results = [];
  for (const s of steps) {
    const r = await runStep(s.fn, s.timeoutMs || 0, log);
    results.push({ name: s.name, ok: r.ok, timedOut: !!r.timedOut, error: r.error || null });
    if (!r.ok) log('startup-stage.failed name=' + s.name + ' error=' + (r.error || ''));
  }
  return results;
}

// 阶段名合法性校验（main.js 静态测试用）：只许 STAGES 表里的名字。
function isKnownStage(name) {
  return STAGES.some((s) => s.name === name);
}

module.exports = { STAGES, runStep, runStages, isKnownStage };
