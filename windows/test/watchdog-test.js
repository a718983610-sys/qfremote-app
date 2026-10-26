'use strict';
/*
 * 看护逻辑本地模拟测试（不需要真服务器）：
 *  A. 断开页：出现「已断线 + 连接按钮」-> 看护应自动点一次，恢复后应停手；
 *  B. 登录页：有可见密码框时，即使页面里有同样的诱饵文字/按钮，也绝不能点。
 * 结果写 JSON 到环境变量 QFTEST_OUT 指定的文件，退出码 0=通过。
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const { createWatchdog } = require('../watchdog');

if (process.getuid && process.getuid() === 0) {
  app.commandLine.appendSwitch('no-sandbox');
  app.commandLine.appendSwitch('disable-gpu');
}

const OUT = process.env.QFTEST_OUT || '/tmp/qfr101/watchdog-result.json';
const result = { phaseA: {}, phaseB: {}, statusEvents: [], logs: [], pass: false };

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 800, height: 600, show: false });
  const watchdog = createWatchdog(() => win.webContents, {
    pollMs: 250,
    confirmScans: 2,
    backoffStartMs: 400,
    backoffMaxMs: 800,
    onStatus: (s) => result.statusEvents.push(s),
    log: (m) => result.logs.push(m)
  });

  // ---- 阶段 A：断开 -> 自动重连 -> 恢复后停手 ----
  await win.loadFile(path.join(__dirname, 'fixture-session.html'));
  watchdog.start();
  let recovered = false;
  for (let i = 0; i < 40; i++) {
    await sleep(300);
    const clicks = await win.webContents.executeJavaScript('window.__clicks');
    if (clicks >= 1 && result.statusEvents.includes('ok')) { recovered = true; break; }
  }
  const clicksAfterRecover = await win.webContents.executeJavaScript('window.__clicks');
  await sleep(2500); // 恢复后再观察一段时间，确认不会重复乱点
  const clicksLater = await win.webContents.executeJavaScript('window.__clicks');
  result.phaseA = { recovered, clicksAfterRecover, clicksLater, expectExactlyOneClick: clicksLater === 1 };

  // ---- 阶段 B：登录页豁免 ----
  const eventsBefore = result.statusEvents.length;
  await win.loadFile(path.join(__dirname, 'fixture-login.html'));
  await sleep(3000);
  const loginClicks = await win.webContents.executeJavaScript('window.__clicks');
  const newEvents = result.statusEvents.slice(eventsBefore);
  result.phaseB = { loginClicks, newStatusEvents: newEvents, expectZeroClicks: loginClicks === 0 };

  watchdog.stop();
  result.pass = !!(result.phaseA.recovered && result.phaseA.expectExactlyOneClick && result.phaseB.expectZeroClicks);
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ pass: result.pass, phaseA: result.phaseA, phaseB: result.phaseB }));
  app.exit(result.pass ? 0 : 1);
});
