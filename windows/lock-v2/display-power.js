'use strict';
/*
 * QFRemote 隐私锁 v2 · 真实熄屏调用（B 线）
 * ================================================================
 * 定夺 §3 熄屏硬门：软件绘制全黑窗口 ≠ 真实熄屏。本模块只做一件事：
 * 在 Windows 真机上调用 display-power.ps1，用 Win32
 * SendMessage(HWND_BROADCAST, WM_SYSCOMMAND, SC_MONITORPOWER, 2)
 * 关闭真实本地显示输出；唤醒用 SC_MONITORPOWER -1。
 *
 * 关键纪律：
 *  - 非 Windows 平台一律返回 { supported:false }，绝不假装熄屏成功；
 *  - 远程输入绝不触发本地唤醒（唤醒只由会话内组件的本地输入探测触发，
 *    见 session-agent.ps1）；远程操作期间本地保持熄灭；
 *  - 熄屏后捕获通道是否中断、远程是否持续唤醒本地显示器，是真机验收项
 *    （D39ABOL 硬件类别，当前 BLOCKED，见 REPORT.md），本模块不预判结果；
 *  - powercfg /requests 可查持续阻止熄屏的请求，熄屏失败时一并上报。
 */
const { spawn } = require('child_process');
const path = require('path');

const SCRIPT = path.join(__dirname, 'display-power.ps1');

function isWindows() { return process.platform === 'win32'; }

// action: 'off' | 'on' | 'query-requests'
// 仅 Windows 真机执行；其余平台返回 supported:false（调用方必须按不支持处理）。
function setDisplayPower(action, opts) {
  const o = opts || {};
  const timeoutMs = o.timeoutMs || 15000;
  if (!isWindows()) {
    return Promise.resolve({ ok: false, supported: false, action, reason: '非 Windows 平台，无真实显示电源调用' });
  }
  return new Promise((resolve) => {
    const ps = spawn('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-Action', action
    ], { windowsHide: true, timeout: timeoutMs });
    let out = '', err = '';
    ps.stdout.on('data', (d) => { out += d.toString(); });
    ps.stderr.on('data', (d) => { err += d.toString(); });
    const done = (result) => resolve(result);
    ps.on('error', (e) => done({ ok: false, supported: true, action, reason: '启动 PowerShell 失败: ' + e.message }));
    ps.on('close', (code) => {
      let parsed = null;
      try { parsed = JSON.parse(out.trim()); } catch (e) { /* 非 JSON 输出按失败计 */ }
      if (code === 0 && parsed && parsed.ok) done({ ok: true, supported: true, action, detail: parsed });
      else done({ ok: false, supported: true, action, reason: (parsed && parsed.error) || err.trim() || ('退出码 ' + code), raw: out.trim().slice(0, 500) });
    });
    setTimeout(() => { try { ps.kill(); } catch (e) { /* ignore */ } }, timeoutMs + 1000);
  });
}

module.exports = { isWindows, setDisplayPower, SCRIPT };
