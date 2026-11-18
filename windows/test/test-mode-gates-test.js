'use strict';
/*
 * TEST 模式门禁测试（A16-S2，GPT 2026-11-18 三问定夺 §5.2，审核 B1 返工）。
 * ==================================================================
 * 目的：补审核报告指出的缺口——此前没有任何测试在 IS_TEST=true 下
 * 断言 main.js 的 TEST 门禁行为（只有 test-policy 模块单测与生产模式
 * vm 测试）。本文件逐个断言审核报告 §3 的 21 处门禁在 TEST 下拒绝／
 * 走 TEST 分支，另含 B2 的 qf-force-download、经已加门禁函数覆盖的
 * 三处手动入口、启动校验拒绝路径，以及一处反向对照（同一处理函数在
 * IS_TEST=false 沙箱里确实会调生产下载，证明断言非空）。
 *
 * 手段：从 main.js 原文按配对括号抽取门禁函数与 IPC 处理函数真实文本
 * （字符串／注释／正则感知的括号扫描，不复制逻辑），在 vm 沙箱里跑
 * （IS_TEST: true）；生产触碰面一律用“记录＋抛错”的桩——门禁漏了就
 * 当场抛错失败；TEST 专用分支用可配置的假 fs／spawnSync／testPolicy
 * 桩走通。结果写 JSON 到 QFTEST_OUT，退出码 0=通过。
 * 由 windows/test/run-all.js 自动发现（每文件单独子进程）。
 *
 * 组别：
 *  G01–G21：审核报告 §3 的 21 处门禁（B2 的 qf-force-download 单列）。
 *  T01–T03：经已加门禁函数覆盖的手动入口（qf-lock-repair／
 *    qf-lock-install-component／qf-heal-retry）。
 *  V00–V06：启动校验（真实 test-policy 模块，注入假 fs）。
 *  N01：反向对照（IS_TEST=false 时同一处理函数确实调生产下载）。
 * 真机部分（TEST 主程序在腾讯机启动、V1–V8、V2a-S1/S2）不在沙箱覆盖，
 * 见证据目录待真机验收清单。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const vm = require('vm');
const tp = require('../test-policy');

const OUT = process.env.QFTEST_OUT || '/tmp/qfr300/test-mode-gates-result.json';
const result = { cases: {}, pass: false };
const ok = (name, cond, extra) => { result.cases[name] = Object.assign({ pass: !!cond }, extra || {}); };

const MAIN_SRC = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

const TEST_LEA_DIR = 'C:\\QFRLEA-TEST\\LEA';
const TEST_CLIENT_EXE = 'C:\\QFRLEA-TEST\\LEA\\qf-lea-client.exe';
const TEST_EXE = 'C:\\QFRLEA-TEST\\QFRemote.exe';
// 生产路径标记（posix 连接后的形态）：TEST 路径绝不含这些子串。
const PROD_PATH_MARKERS = ['/QFR/LEA/', '/QFRemote/Lock/'];
const PROD_REG_KEY = 'HKLM\\SOFTWARE\\QFR\\LEA';

// ---- 括号配对扫描（识别字符串／注释／正则，避免括号误计） ----
function isRegexStart(src, slashIdx) {
  // '/' 是正则起首还是除法：看上一个非空白字符／关键字。
  let j = slashIdx - 1;
  while (j >= 0 && /\s/.test(src[j])) j--;
  if (j < 0) return true;
  const prev = src[j];
  if ('(,=:[!&|?{};'.includes(prev)) return true;
  const m = src.slice(0, j + 1).match(/(return|typeof|case|delete|void|in|of|new|instanceof|do|else)\s*$/);
  return !!m;
}
function scanBalanced(src, openIdx, openCh, closeCh) {
  // 从 openIdx 处的开括号开始扫描，返回与之配对的闭括号下标。
  let depth = 0;
  let state = 'code';
  let i = openIdx;
  while (i < src.length) {
    const ch = src[i];
    const nx = src[i + 1] || '';
    if (state === 'code') {
      if (ch === "'") state = 'sq';
      else if (ch === '"') state = 'dq';
      else if (ch === '`') state = 'tpl';
      else if (ch === '/' && nx === '/') { state = 'lc'; i++; }
      else if (ch === '/' && nx === '*') { state = 'bc'; i++; }
      else if (ch === '/' && isRegexStart(src, i)) {
        // 跳过正则字面量（含字符类与转义），再跳过标志位。
        i++;
        let inClass = false;
        while (i < src.length) {
          const c = src[i];
          if (c === '\\') { i += 2; continue; }
          if (c === '[') inClass = true;
          else if (c === ']') inClass = false;
          else if (c === '/' && !inClass) break;
          else if (c === '\n') break; // 非法正则，兜底退出
          i++;
        }
        i++;
        while (i < src.length && /[a-z]/i.test(src[i])) i++;
        continue;
      }
      else if (ch === openCh) depth++;
      else if (ch === closeCh) { depth--; if (depth === 0) return i; }
    } else if (state === 'sq') {
      if (ch === '\\') i++;
      else if (ch === "'") state = 'code';
      else if (ch === '\n') state = 'code'; // 兜底
    } else if (state === 'dq') {
      if (ch === '\\') i++;
      else if (ch === '"') state = 'code';
      else if (ch === '\n') state = 'code'; // 兜底
    } else if (state === 'tpl') {
      if (ch === '\\') i++;
      else if (ch === '`') state = 'code';
      else if (ch === '$' && nx === '{') throw new Error('template ${} not supported in scanner');
    } else if (state === 'lc') {
      if (ch === '\n') state = 'code';
    } else if (state === 'bc') {
      if (ch === '*' && nx === '/') { state = 'code'; i++; }
    }
    i++;
  }
  throw new Error('unbalanced ' + openCh + closeCh + ' from ' + openIdx);
}
function extractFunction(src, name) {
  const re = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(');
  const m = re.exec(src);
  if (!m) throw new Error('function not found: ' + name);
  const open = src.indexOf('{', m.index);
  const close = scanBalanced(src, open, '{', '}');
  return src.slice(m.index, close + 1);
}
function extractIpc(src, kind, channel) {
  // 取 trustedHandle/trustedOn('channel', ...) 整条调用语句（供沙箱捕获回调）。
  const marker = kind + "('" + channel + "',";
  const start = src.indexOf(marker);
  if (start < 0) throw new Error('IPC handler not found: ' + kind + ' ' + channel);
  const open = src.indexOf('(', start);
  const close = scanBalanced(src, open, '(', ')');
  return src.slice(start, close + 1) + ';';
}

// ---- TEST 沙箱：IS_TEST=true，生产触碰面一律记录＋抛错 ----
function makeCtx(opts) {
  const o = Object.assign({
    isTest: true,
    clientShaOk: true,
    present: [],          // fs.existsSync 为真的路径集合（与代码同一 path.join 算法拼）
    fileContent: {},      // fs.readFileSync 内容映射
    testIsolationValidated: false,
    updateState: null,
    forceState: null,
    includeFns: [],
    includeIpc: [],       // [[kind, channel], ...]
    spyFnNames: [],       // 用抛错桩替换的函数名（须不在 includeFns 内）
    requireChildProcess: true,
    updaterDownloadImpl: null, // N01 反向对照用：downloadUpdate 的记录型实现
  }, opts || {});
  const calls = [];
  const bootLogs = [];
  const handlers = {};
  // calls 存原始参数（不断言时只取长度／名字；写结果 JSON 时只放原始类型 extra）。
  const rec = (name) => (...args) => { calls.push({ name, args }); };
  const boom = (name) => (...args) => {
    calls.push({ name, args });
    throw new Error('PROD-TOUCH: ' + name + ' must not be called in TEST mode');
  };
  const present = new Set(o.present);
  const testPolicyStub = {
    testDenied: (a) => ({ ok: false, reason: 'test-mode-denied', action: a || '' }),
    testLeaDir: () => TEST_LEA_DIR,
    testDataLeaf: () => 'LEA-TEST',
    testServiceName: () => 'QFRLEA-TEST',
    testClientExePath: () => TEST_CLIENT_EXE,
    testClientShaOk: () => !!o.clientShaOk,
    testRegKey: () => 'HKLM\\SOFTWARE\\QFR\\LEA-TEST',
  };
  const fakeFs = {
    existsSync: (p) => { calls.push({ name: 'fs.existsSync', args: [String(p)] }); return present.has(p); },
    readFileSync: (p, enc) => {
      calls.push({ name: 'fs.readFileSync', args: [String(p)] });
      if (Object.prototype.hasOwnProperty.call(o.fileContent, p)) {
        const b = o.fileContent[p];
        return enc ? String(b) : Buffer.from(String(b));
      }
      throw new Error('ENOENT: ' + p);
    },
    writeFileSync: boom('fs.writeFileSync'),
  };
  const spawnSync = (...args) => {
    calls.push({ name: 'child_process.spawnSync', args });
    const a = args[1] || [];
    if (a.indexOf('QFRLEA') >= 0) throw new Error('PROD-TOUCH: spawnSync called with production service QFRLEA');
    if (a[0] === 'query' && a[1] === 'QFRLEA-TEST') return { status: 0, stdout: 'STATE              : 4  RUNNING\r\n' };
    if (a[0] === 'query' && typeof a[1] === 'string' && a[1].indexOf('HKLM') === 0) return { status: 0, stdout: '' };
    return { status: 1, stdout: '' };
  };
  const downloadUpdate = o.updaterDownloadImpl
    ? (...args) => { calls.push({ name: 'updater.downloadUpdate', args }); return o.updaterDownloadImpl(...args); }
    : boom('updater.downloadUpdate');
  const sb = {
    __dirname: path.join(os.tmpdir(), 'qfr-testmode-gates'),
    IS_TEST: o.isTest,
    PREVIEW: '',
    process: { platform: 'win32', env: { ProgramFiles: 'C:\\Program Files', ProgramData: 'C:\\ProgramData' }, execPath: TEST_EXE, resourcesPath: '' },
    app: {
      isPackaged: false,
      getVersion: () => '3.0.0',
      getPath: (n) => (n === 'downloads' ? 'C:\\Users\\test\\Downloads' : ''),
      setLoginItemSettings: boom('app.setLoginItemSettings'),
      getLoginItemSettings: boom('app.getLoginItemSettings'),
    },
    settings: { autoLaunchConfigured: false },
    bootLog: (tag, detail) => { bootLogs.push(String(tag) + (detail ? ':' + String(detail) : '')); },
    saveSettings: rec('saveSettings'),
    setTimeout, clearTimeout,
    console,
    Buffer,
    path,
    os,
    fs: fakeFs,
    testPolicy: testPolicyStub,
    sysPrograms: require('../sys-programs'),
    sysHelper: { COMMANDS: [], callHelper: boom('sysHelper.callHelper'), loadWhitelist: boom('sysHelper.loadWhitelist'), verifyFileHash: boom('sysHelper.verifyFileHash') },
    agentHeal: { isHealInProgress: boom('agentHeal.isHealInProgress'), readHealLogText: boom('agentHeal.readHealLogText'), appendHealLog: boom('agentHeal.appendHealLog'), resolveHealScriptPath: boom('agentHeal.resolveHealScriptPath'), shouldAttempt: boom('agentHeal.shouldAttempt') },
    updater: {
      checkForUpdate: boom('updater.checkForUpdate'),
      downloadUpdate,
      fetchManifest: boom('updater.fetchManifest'),
      getUpdatePolicy: boom('updater.getUpdatePolicy'),
      compareVersions: boom('updater.compareVersions'),
      nextRetryDelayMs: boom('updater.nextRetryDelayMs'),
    },
    installerLaunch: { launchInstallerSilent: boom('installerLaunch.launchInstallerSilent') },
    lockBridge: { listDevices: boom('lockBridge.listDevices'), enable: boom('lockBridge.enable'), disable: boom('lockBridge.disable'), reset: boom('lockBridge.reset') },
    lockCall: boom('lockCall'),
    shell: { showItemInFolder: boom('shell.showItemInFolder') },
    hasActiveSession: boom('hasActiveSession'),
    updateSettings: boom('updateSettings'),
    broadcastUpdate: rec('broadcastUpdate'),
    sendForceState: rec('sendForceState'),
    resolveOwnNodeId: boom('resolveOwnNodeId'),
    extRequest: boom('extRequest'),
    leaNotifyInternal: boom('leaNotifyInternal'),
    leaPayloadPath: boom('leaPayloadPath'),
    leaPayloadSignature: boom('leaPayloadSignature'),
    openForceWindow: boom('openForceWindow'),
    releaseForceWindow: boom('releaseForceWindow'),
    quitForInstaller: boom('quitForInstaller'),
    showView: boom('showView'),
    openLockWindow: boom('openLockWindow'),
    currentGateUsername: boom('currentGateUsername'),
    persistPendingUpdate: boom('persistPendingUpdate'),
    dropStalePending: boom('dropStalePending'),
    scheduleAutoUpdateCheck: boom('scheduleAutoUpdateCheck'),
    clearPendingUpdate: boom('clearPendingUpdate'),
    dialog: { showMessageBox: boom('dialog.showMessageBox') },
    trustedHandle: (name, fn) => { handlers[name] = fn; },
    trustedOn: (name, fn) => { handlers[name] = fn; },
    require: (name) => {
      calls.push({ name: 'require', args: [name] });
      if (name === 'child_process') {
        if (!o.requireChildProcess) throw new Error('PROD-TOUCH: require(child_process) must not happen in TEST mode');
        return { spawnSync, spawn: boom('child_process.spawn') };
      }
      if (name === 'crypto') return crypto;
      throw new Error('unexpected require: ' + name);
    },
    // 模块级变量（main.js 里为 let／const；沙箱里以全局属性承载）。
    testIsolationValidated: o.testIsolationValidated,
    leaLastNotifiedAccount: '',
    updateState: o.updateState || { phase: 'latest', available: false, checkedAt: '', manifest: null, error: null, download: null },
    updateChecking: false,
    forceSnoozed: false,
    updateFailures: 0,
    forceState: o.forceState || { manifest: null, phase: 'ready', percent: null, error: null, download: null },
    forceDownloading: false,
    updateDownloading: false,
    systemServicesInstallTried: false,
    leaRepairRunning: false,
    updateInstallMode: 'installed',
    win: null, aboutWin: null, forceWin: null, lockWin: null,
    __calls: calls,
    __bootLogs: bootLogs,
    __handlers: handlers,
  };
  // 生产侧辅助函数（本线不抽取）：TEST 下绝不该被调到，全部必抛桩。
  for (const n of ['leaHealthCheck', 'leaRegistryValue', 'leaServiceState', 'scheduleLeaBackfillRecheck', 'showLeaRepairFailure', 'showHealFailure', 'waitInstallResult', 'unpackedAppPath', 'preferUnpackedPath']) {
    if (!o.includeFns.includes(n)) sb[n] = boom(n);
  }
  for (const n of o.spyFnNames) sb[n] = boom(n);
  const ctx = vm.createContext(sb);
  const fns = o.includeFns.map((n) => extractFunction(MAIN_SRC, n)).join('\n');
  if (fns) vm.runInContext('"use strict";\n' + fns, ctx);
  for (const [kind, channel] of o.includeIpc) {
    vm.runInContext('"use strict";\n' + extractIpc(MAIN_SRC, kind, channel), ctx);
  }
  return { sb, ctx, calls, bootLogs, handlers };
}

const hasCall = (calls, name) => calls.some((c) => c.name === name);
const calledWith = (calls, name, pred) => calls.some((c) => c.name === name && pred(c.args));
const prodPathTouched = (calls) => calls.some((c) =>
  (c.name === 'fs.existsSync' || c.name === 'fs.readFileSync') &&
  PROD_PATH_MARKERS.some((m) => c.args[0] && c.args[0].includes(m)));
const prodServiceTouched = (calls) => calls.some((c) =>
  c.name === 'child_process.spawnSync' &&
  c.args.some((a) => a === 'QFRLEA' || a === PROD_REG_KEY));
const testFiles = () => [
  path.join(TEST_LEA_DIR, 'QFRLEA.exe'),
  path.join(TEST_LEA_DIR, 'qf-lea-client.exe'),
  path.join(TEST_LEA_DIR, 'version.json'),
];
const testVersionJson = () => {
  const m = {};
  m[path.join(TEST_LEA_DIR, 'version.json')] = '{"version":"0.1.0"}';
  return m;
};

(async () => {
  try {
    // ---- G01：applyAutoLaunchDefault —— TEST 下不注册自启动 ----
    {
      const { sb, ctx, calls } = makeCtx({ includeFns: ['applyAutoLaunchDefault'] });
      const r = await vm.runInContext('applyAutoLaunchDefault()', ctx);
      ok('G01_applyAutoLaunchDefault_denied', r === undefined &&
        !hasCall(calls, 'app.setLoginItemSettings') &&
        !hasCall(calls, 'saveSettings') &&
        sb.settings.autoLaunchConfigured === false);
    }

    // ---- G02/G03：qf-autolaunch-get/set ----
    {
      const { ctx, calls, handlers } = makeCtx({
        includeIpc: [['trustedHandle', 'qf-autolaunch-get'], ['trustedOn', 'qf-autolaunch-set']],
      });
      const rGet = await handlers['qf-autolaunch-get']();
      ok('G02_qf_autolaunch_get_false', rGet === false && !hasCall(calls, 'app.getLoginItemSettings'));
      const rSet = await handlers['qf-autolaunch-set'](null, true);
      ok('G03_qf_autolaunch_set_noop', rSet === undefined && !hasCall(calls, 'app.setLoginItemSettings'));
    }

    // ---- G04：runUpdateCheck —— TEST 下直接返回当前 updateState，不取清单 ----
    {
      const seed = { phase: 'latest', available: false, checkedAt: '2026-11-19T00:00:00.000Z', manifest: null, error: null, download: null };
      const { sb, ctx, calls } = makeCtx({ includeFns: ['runUpdateCheck'], updateState: seed });
      const r = await vm.runInContext('runUpdateCheck(8000)', ctx);
      ok('G04_runUpdateCheck_returns_state', r === sb.updateState && r.phase === 'latest' &&
        !hasCall(calls, 'updater.checkForUpdate') &&
        !hasCall(calls, 'broadcastUpdate') && sb.updateChecking === false);
    }

    // ---- G05/G07/B2：更新下载／打开／强制下载 —— manifest 已就位时仍被门禁拦下 ----
    {
      const { sb, ctx, calls, handlers } = makeCtx({
        includeIpc: [['trustedOn', 'qf-update-download'], ['trustedOn', 'qf-update-open'], ['trustedOn', 'qf-force-download']],
        updateState: { phase: 'available', available: true, checkedAt: '', manifest: { version: '9.9.9', url: 'https://example.invalid/x' }, error: null, download: { file: 'C:\\x\\setup.exe' } },
        forceState: { manifest: { version: '9.9.9', url: 'https://example.invalid/x' }, phase: 'ready', percent: null, error: null, download: null },
      });
      const rDl = await handlers['qf-update-download'](null, {});
      ok('G05_qf_update_download_noop', rDl === undefined &&
        !hasCall(calls, 'updater.downloadUpdate') && sb.updateDownloading === false);
      const rOpen = await handlers['qf-update-open']();
      ok('G07_qf_update_open_noop', rOpen === undefined &&
        !hasCall(calls, 'shell.showItemInFolder') && !hasCall(calls, 'hasActiveSession'));
      const rForce = await handlers['qf-force-download']();
      ok('B2_qf_force_download_noop', rForce === undefined &&
        !hasCall(calls, 'updater.downloadUpdate') &&
        sb.forceDownloading === false && sb.forceState.phase === 'ready');
    }

    // ---- G06：launchDownloadedInstaller —— TEST 下返 false，不拉安装器 ----
    {
      const { ctx, calls } = makeCtx({ includeFns: ['launchDownloadedInstaller'] });
      const r = await vm.runInContext("launchDownloadedInstaller('C:\\\\x\\\\setup.exe')", ctx);
      ok('G06_launchDownloadedInstaller_false', r === false &&
        !hasCall(calls, 'installerLaunch.launchInstallerSilent'));
    }

    // ---- G08：startupUpdateGate —— TEST 下记 test-skip 返 false，不取清单 ----
    {
      const { ctx, calls, bootLogs } = makeCtx({ includeFns: ['startupUpdateGate'] });
      const r = await vm.runInContext('startupUpdateGate()', ctx);
      ok('G08_startupUpdateGate_false', r === false &&
        bootLogs.indexOf('startupUpdateGate.test-skip') >= 0 &&
        !hasCall(calls, 'updater.fetchManifest') &&
        !hasCall(calls, 'openForceWindow') &&
        !hasCall(calls, 'dropStalePending'));
    }

    // ---- G09：runStartupAgentHeal —— TEST 下返 skipped/test-mode-denied ----
    {
      const { ctx, calls } = makeCtx({ includeFns: ['runStartupAgentHeal'] });
      const r = await vm.runInContext('runStartupAgentHeal({ manual: true })', ctx);
      ok('G09_runStartupAgentHeal_denied',
        r && r.outcome === 'skipped' && r.code === 'test-mode-denied' && r.rounds === 0 &&
        !hasCall(calls, 'sysHelper.callHelper'));
    }

    // ---- G10：lockServiceInstalled —— 生产 device.json 在场也返 false，且零 fs 探针 ----
    {
      const prodDevice = path.join('C:\\Program Files', 'QFRemote', 'Lock', 'device.json');
      const { ctx, calls } = makeCtx({
        includeFns: ['lockServiceInstalled'],
        present: [prodDevice, path.join(os.tmpdir(), 'qfr-testmode-gates', 'privacy-lock', 'device.json')],
      });
      const r = await vm.runInContext('lockServiceInstalled()', ctx);
      ok('G10_lockServiceInstalled_false', r === false &&
        !calls.some((c) => c.name === 'fs.existsSync'));
    }

    // ---- G11：leaServiceInstalled —— TEST 分支（健康／无生产回退／SHA 不符） ----
    {
      // G11a：TEST 三件＋SHA 对＋服务 RUNNING → true；只查 TEST 服务，不碰生产。
      const { ctx, calls } = makeCtx({
        includeFns: ['leaServiceInstalled', 'testLeaServiceInstalled'],
        present: testFiles(),
      });
      const r = await vm.runInContext('leaServiceInstalled(true)', ctx);
      ok('G11a_leaServiceInstalled_test_healthy', r === true &&
        calledWith(calls, 'child_process.spawnSync', (a) => a[1] && a[1].indexOf('QFRLEA-TEST') >= 0) &&
        !prodPathTouched(calls) && !prodServiceTouched(calls));
    }
    {
      // G11b：只有生产三件在场 → false（不回退生产路径），且 spawnSync 一次未调。
      const { ctx, calls } = makeCtx({
        includeFns: ['leaServiceInstalled', 'testLeaServiceInstalled'],
        present: [
          path.join('C:\\Program Files', 'QFR', 'LEA', 'QFRLEA.exe'),
          path.join('C:\\Program Files', 'QFR', 'LEA', 'qf-lea-client.exe'),
          path.join('C:\\Program Files', 'QFR', 'LEA', 'version.json'),
        ],
      });
      const r = await vm.runInContext('leaServiceInstalled(true)', ctx);
      ok('G11b_leaServiceInstalled_no_prod_fallback', r === false &&
        !hasCall(calls, 'child_process.spawnSync') && !prodPathTouched(calls));
    }
    {
      // G11c：TEST 三件在场但 SHA 不符 → false。
      const { ctx, calls } = makeCtx({
        includeFns: ['leaServiceInstalled', 'testLeaServiceInstalled'],
        present: testFiles(),
        clientShaOk: false,
      });
      const r = await vm.runInContext('leaServiceInstalled(true)', ctx);
      ok('G11c_leaServiceInstalled_sha_mismatch', r === false && !prodServiceTouched(calls));
    }

    // ---- G12：repairLeaService —— TEST 下返 test-mode-denied，不调 helper ----
    {
      const { ctx, calls, bootLogs } = makeCtx({ includeFns: ['repairLeaService'] });
      const r = await vm.runInContext('repairLeaService()', ctx);
      ok('G12_repairLeaService_denied',
        r && r.ok === false && r.reason === 'test-mode-denied' &&
        bootLogs.some((t) => t.indexOf('lea-repair.test-denied') === 0) &&
        !hasCall(calls, 'sysHelper.callHelper') && !hasCall(calls, 'leaPayloadPath'));
    }

    // ---- G13：maybeCheckLeaHealth —— TEST 健康检查（健康／不健康只记日志，永不修复） ----
    {
      const baseFns = ['maybeCheckLeaHealth', 'testLeaHealthCheck', 'testLeaRegistryValue', 'testLeaServiceState', 'testLeaServiceInstalled'];
      // G13a：TEST 健康 → { ok: true, reason: 'healthy' }。
      const healthy = makeCtx({
        includeFns: baseFns,
        spyFnNames: ['repairLeaService', 'leaHealthCheck'],
        present: testFiles(),
        fileContent: testVersionJson(),
      });
      const rA = await vm.runInContext('maybeCheckLeaHealth()', healthy.ctx);
      ok('G13a_maybeCheckLeaHealth_healthy',
        rA && rA.ok === true && rA.reason === 'healthy' &&
        healthy.bootLogs.some((t) => t.indexOf('test-lea-health.ok') === 0) &&
        !hasCall(healthy.calls, 'repairLeaService') &&
        !hasCall(healthy.calls, 'leaHealthCheck') &&
        !prodPathTouched(healthy.calls) && !prodServiceTouched(healthy.calls));
      // G13b：TEST 三件缺失 → 不健康只记日志，reason 为 test-unhealthy-no-repair，修复一次未调。
      const unhealthy = makeCtx({
        includeFns: baseFns,
        spyFnNames: ['repairLeaService', 'leaHealthCheck'],
        present: [],
        fileContent: {},
      });
      const rB = await vm.runInContext('maybeCheckLeaHealth()', unhealthy.ctx);
      ok('G13b_maybeCheckLeaHealth_unhealthy_no_repair',
        rB && rB.ok === false && rB.reason === 'test-unhealthy-no-repair' &&
        unhealthy.bootLogs.some((t) => t.indexOf('test-lea-health.unhealthy') === 0) &&
        !hasCall(unhealthy.calls, 'repairLeaService') &&
        !hasCall(unhealthy.calls, 'leaHealthCheck'));
    }

    // ---- G14：leaClientExePath —— 只认 SHA 核验的 TEST 客户端，绝不回退 ----
    {
      // G14a：TEST 客户端在场＋SHA 对 → 返回 TEST 路径。
      const a = makeCtx({ includeFns: ['leaClientExePath'], present: [TEST_CLIENT_EXE] });
      const rA = await vm.runInContext('leaClientExePath()', a.ctx);
      ok('G14a_leaClientExePath_test_client', rA === TEST_CLIENT_EXE);
      // G14b：SHA 不符 → null。
      const b = makeCtx({ includeFns: ['leaClientExePath'], present: [TEST_CLIENT_EXE], clientShaOk: false });
      const rB = await vm.runInContext('leaClientExePath()', b.ctx);
      ok('G14b_leaClientExePath_sha_bad_null', rB === null);
      // G14c：TEST 客户端缺失 → null。
      const c = makeCtx({ includeFns: ['leaClientExePath'], present: [] });
      const rC = await vm.runInContext('leaClientExePath()', c.ctx);
      ok('G14c_leaClientExePath_missing_null', rC === null);
      // G14d：只有生产客户端在场 → null；且 existsSync 只查过 TEST 路径，未探生产候选。
      const d = makeCtx({
        includeFns: ['leaClientExePath'],
        present: [path.join('C:\\Program Files', 'QFR', 'LEA', 'qf-lea-client.exe')],
      });
      const rD = await vm.runInContext('leaClientExePath()', d.ctx);
      const probed = d.calls.filter((x) => x.name === 'fs.existsSync').map((x) => x.args[0]);
      ok('G14d_leaClientExePath_no_prod_fallback', rD === null &&
        probed.length === 1 && probed[0] === TEST_CLIENT_EXE);
    }

    // ---- G15：notifyLeaLogin —— 未通过启动校验时拒绝，零外部调用 ----
    {
      const { ctx, calls, bootLogs } = makeCtx({
        includeFns: ['notifyLeaLogin'],
        testIsolationValidated: false,
      });
      const r = await vm.runInContext("notifyLeaLogin('718983610')", ctx);
      ok('G15_notifyLeaLogin_not_validated',
        r && r.ok === false && r.reason === 'test-isolation-not-validated' &&
        bootLogs.some((t) => t.indexOf('lea.login-notify-test-denied') === 0) &&
        !hasCall(calls, 'resolveOwnNodeId') &&
        !hasCall(calls, 'extRequest') &&
        !hasCall(calls, 'leaNotifyInternal') &&
        !hasCall(calls, 'require'));
    }

    // ---- G16：syncLockOwner —— TEST 下返 test-mode-denied，不写锁文件 ----
    {
      const { ctx, calls } = makeCtx({ includeFns: ['syncLockOwner'] });
      const r = await vm.runInContext("syncLockOwner('someone')", ctx);
      ok('G16_syncLockOwner_denied',
        r && r.ok === false && r.reason === 'test-mode-denied' &&
        !hasCall(calls, 'fs.writeFileSync') &&
        !calledWith(calls, 'require', (a) => a[0] === 'child_process'));
    }

    // ---- G17：maybeInstallSystemServices —— TEST 下返 test-mode-denied，不装服务 ----
    {
      const { sb, ctx, calls, bootLogs } = makeCtx({ includeFns: ['maybeInstallSystemServices'] });
      const r = await vm.runInContext('maybeInstallSystemServices(false)', ctx);
      ok('G17_maybeInstallSystemServices_denied',
        r && r.ok === false && r.reason === 'test-mode-denied' &&
        bootLogs.some((t) => t.indexOf('system-services.test-skip') === 0) &&
        !hasCall(calls, 'saveSettings') &&
        !hasCall(calls, 'leaPayloadSignature') &&
        sb.systemServicesInstallTried === false);
    }

    // ---- G18–G21：锁 IPC —— TEST 下一律 testDenied，不调 lockBridge ----
    {
      const { ctx, calls, handlers } = makeCtx({
        includeIpc: [
          ['trustedHandle', 'qf-lock-devices'],
          ['trustedHandle', 'qf-lock-enable'],
          ['trustedHandle', 'qf-lock-disable'],
          ['trustedHandle', 'qf-lock-reset'],
        ],
      });
      const rDevices = await handlers['qf-lock-devices']();
      ok('G18_qf_lock_devices_denied',
        rDevices && rDevices.ok === false && rDevices.reason === 'test-mode-denied' && rDevices.action === 'qf-lock-devices' &&
        !hasCall(calls, 'lockBridge.listDevices'));
      const rEnable = await handlers['qf-lock-enable'](null, 'dev1', 'pw');
      ok('G19_qf_lock_enable_denied',
        rEnable && rEnable.ok === false && rEnable.reason === 'test-mode-denied' && rEnable.action === 'qf-lock-enable' &&
        !hasCall(calls, 'lockBridge.enable') && !hasCall(calls, 'lockCall'));
      const rDisable = await handlers['qf-lock-disable'](null, 'dev1');
      ok('G20_qf_lock_disable_denied',
        rDisable && rDisable.ok === false && rDisable.reason === 'test-mode-denied' && rDisable.action === 'qf-lock-disable' &&
        !hasCall(calls, 'lockBridge.disable') && !hasCall(calls, 'lockCall'));
      const rReset = await handlers['qf-lock-reset'](null, 'dev1', 'old', 'new');
      ok('G21_qf_lock_reset_denied',
        rReset && rReset.ok === false && rReset.reason === 'test-mode-denied' && rReset.action === 'qf-lock-reset' &&
        !hasCall(calls, 'lockBridge.reset') && !hasCall(calls, 'lockCall'));
    }

    // ---- T01–T03：经已加门禁函数覆盖的手动入口 ----
    {
      const { ctx, handlers } = makeCtx({
        includeFns: ['runStartupAgentHeal', 'maybeInstallSystemServices'],
        includeIpc: [
          ['trustedHandle', 'qf-lock-repair'],
          ['trustedHandle', 'qf-lock-install-component'],
          ['trustedHandle', 'qf-heal-retry'],
        ],
      });
      const rRepair = await handlers['qf-lock-repair']();
      ok('T01_qf_lock_repair_denied',
        rRepair && rRepair.ok === true && rRepair.outcome === 'skipped' && rRepair.code === 'test-mode-denied');
      const rInstall = await handlers['qf-lock-install-component']();
      ok('T02_qf_lock_install_component_denied',
        rInstall && rInstall.ok === false && rInstall.reason === 'test-mode-denied');
      const rHeal = await handlers['qf-heal-retry']();
      ok('T03_qf_heal_retry_denied',
        rHeal && rHeal.ok === true && rHeal.outcome === 'skipped' && rHeal.code === 'test-mode-denied');
    }

    // ---- V00–V06：启动校验拒绝路径（真实 test-policy 模块，注入假 fs） ----
    {
      const CLIENT_SHA = 'aa'.repeat(32);
      const fakeFs = {
        existsSync: () => true,
        realpathSync: (p) => p,
        sha256File: () => CLIENT_SHA,
      };
      const base = Object.assign({}, fakeFs, { expectedClientSha: CLIENT_SHA });
      const rOk = tp.validateTestEnvironment(TEST_EXE, base);
      ok('V00_validate_ok', rOk.ok === true && rOk.failures.length === 0);
      const rExe = tp.validateTestEnvironment('C:\\Users\\Administrator\\AppData\\Local\\Programs\\QFRemote\\QFRemote.exe', base);
      ok('V01_validate_wrong_exe', rExe.ok === false && rExe.failures.some((f) => f.indexOf('test-exe-path-mismatch') === 0));
      const rReparse = tp.validateTestEnvironment(TEST_EXE, Object.assign({}, base, {
        realpathSync: (p) => (p === TEST_EXE ? 'C:\\QFRLEA-TEST\\link-target\\QFRemote.exe' : p),
      }));
      ok('V02_validate_reparse', rReparse.ok === false && rReparse.failures.some((f) => f.indexOf('test-exe-reparse') === 0));
      const rMissing = tp.validateTestEnvironment(TEST_EXE, Object.assign({}, base, {
        existsSync: (p) => p !== TEST_CLIENT_EXE,
      }));
      ok('V03_validate_client_missing', rMissing.ok === false && rMissing.failures.some((f) => f.indexOf('test-client-missing') === 0));
      const rSha = tp.validateTestEnvironment(TEST_EXE, Object.assign({}, base, {
        sha256File: () => 'bb'.repeat(32),
      }));
      ok('V04_validate_client_sha_mismatch', rSha.ok === false && rSha.failures.some((f) => f.indexOf('test-client-sha-mismatch') === 0));
      const rUnconf = tp.validateTestEnvironment(TEST_EXE, Object.assign({}, base, { expectedClientSha: '' }));
      ok('V05_validate_sha_unconfigured', rUnconf.ok === false && rUnconf.failures.some((f) => f.indexOf('test-client-sha-unconfigured') === 0));
      const rDir = tp.validateTestEnvironment(TEST_EXE, Object.assign({}, base, {
        existsSync: (p) => p !== TEST_LEA_DIR,
      }));
      ok('V06_validate_lea_dir_missing', rDir.ok === false && rDir.failures.some((f) => f.indexOf('test-lea-dir-missing') === 0));
    }

    // ---- N01：反向对照 —— 同一 qf-force-download 处理函数在 IS_TEST=false 时确实调生产下载 ----
    {
      const { sb, ctx, calls, handlers } = makeCtx({
        isTest: false,
        includeIpc: [['trustedOn', 'qf-force-download']],
        forceState: { manifest: { version: '9.9.9', url: 'https://example.invalid/x' }, phase: 'ready', percent: null, error: null, download: null },
        updaterDownloadImpl: () => ({ file: 'C:\\dl\\setup.exe', name: 'setup.exe', sha256: 'aabb', size: 123 }),
      });
      const r = await handlers['qf-force-download']();
      ok('N01_negative_control_force_download_prod', r === undefined &&
        hasCall(calls, 'updater.downloadUpdate') &&
        sb.forceState.phase === 'downloaded' &&
        sb.forceState.download && sb.forceState.download.file === 'C:\\dl\\setup.exe');
    }

    result.pass = Object.values(result.cases).every((c) => c.pass);
  } catch (e) {
    result.error = (e && e.stack) || String(e);
    result.pass = false;
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.pass ? 0 : 1);
})();
