'use strict';
/*
 * A1 首装两段式（2026-11-13，windows/main.js＋安装器＋QFRLEA 子命令）本地自检：
 *
 * 手段：从 main.js 原文按花括号配对抽取 leaHealthCheck／repairLeaService／
 * maybeCheckLeaHealth／leaRegistryValue／leaServiceState／leaServiceInstalled
 * 等真实函数文本，在 vm 沙箱里跑（fake process/app，reg.exe／sc.exe／
 * spawn／spawnSync 桩按场景给），不复制逻辑；结果写 JSON 到 QFTEST_OUT，
 * 退出码 0=通过。NSIS／PS1／C 子命令的覆盖见同文件静态组与
 * windows/lea/test/test_lea.c 的 A1 组、run_tests.sh 的隔离检查；
 * Wine 真装见证据目录的测试包记录。
 *
 * 组别：
 *  H. leaHealthCheck 全部不健康态：服务未注册／服务停了／注册表版本不一
 *     致／注册表版本缺失／PendingRepair／LEA_DEGRADED 标记／文件哈希不符／
 *     健康态（零 reason）。
 *  R. repairLeaService：helper 不可用→一次 UAC --repair 拉起（参数逐字）；
 *     白名单哈希不符→零拉起；载荷缺失→零拉起；exit 非零→失败＋可见提示
 *     ＋60 秒重试已调度；超时→失败＋提示＋重试；spawn 抛错→失败＋提示＋
 *     重试；并发二次调用→already-running；非 Windows→non-windows。
 *  M. maybeCheckLeaHealth：健康即不打扰（零拉起）；不健康即走修复。
 *  S. 静态深查（不跑代码，只验文本与真实文件）：
 *     S1 内层 installer.nsi：admin 级、OutFile QFRSetupAdmin.exe、清单
 *        校验 3 次重试、--install-service、升级回滚、-TasksOnly、
 *        PendingRepair、.onInstFailed、完成标记；无 user 级、无登录后装服务；
 *     S2 外层 installer-outer.nsi：user 级、runas、UAC 拒绝明示、不留半装、
 *        完成标记轮询（900 秒）、静默透传 /S、不含 7z；
 *     S3 install-lea.ps1：-TasksOnly 开关、Register-AllUshTasks、完整模式
 *        仍保留（回滚／服务安装）；S4 wrapper A1 跳过守卫；
 *     S5 隔离：qf-lea-client.c／server/ext/lea/*.js 不含服务子命令；
 *     S6 清单工具 gen_file_manifest.py：生成／校验／篡改／缺失；
 *     S7 main.js：登录分支调 maybeCheckLeaHealth；maybeInstallSystemServices
 *        不再含 backfill 拉起；S8 白名单含 QFRLEA.exe 且与磁盘实算一致。
 *  P. H1（2026-11-15，v6）：leaClientExePath 候选顺序——自家目录（运行目录旁
 *     LEA\）优先，__dirname\lea 其次，旧 Program Files 只作最后兜底；
 *     独存时仍能兜底找到；全无时返回 null；ProgramFiles 未设也不崩。
 *     S1k/S1l：升级段解压前删 %ProgramFiles%\QFR\LEA（只删该目录，删不掉
 *     Abort）；S1m：安装器三条铁律仍在（停服等退出／重试 SetOutPath／
 *     校验失败落盘坏文件名）。
 * 真机部分（干净 Win10/11 双击、一次 UAC、服务 RUNNING）不在沙箱覆盖，
 * 见证据目录待真机验收清单。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const vm = require('vm');
const sh = require('../sys-helper');
const { execFileSync } = require('child_process');

const OUT = process.env.QFTEST_OUT || '/tmp/qfr300/lea-firstinstall-a1-result.json';
const result = { cases: {}, pass: false };
const ok = (name, cond, extra) => { result.cases[name] = Object.assign({ pass: !!cond }, extra || {}); };

const MAIN_SRC = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

function extractFunction(src, name) {
  const re = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(');
  const m = re.exec(src);
  if (!m) throw new Error('function not found: ' + name);
  const open = src.indexOf('{', m.index);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(m.index, i + 1); }
  }
  throw new Error('unbalanced braces: ' + name);
}
function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

const FNS = ['lockComponentSourceDir', 'lockServiceInstalled', 'leaServiceInstalled',
  'leaRegistryValue', 'leaServiceState', 'leaHealthCheck', 'showLeaRepairFailure',
  'repairLeaService', 'maybeCheckLeaHealth', 'leaPayloadPath', 'sha256File',
  'leaPayloadSignature', 'scheduleLeaBackfillRecheck', 'waitInstallResult',
  'showHealFailure', 'unpackedAppPath', 'preferUnpackedPath', 'leaClientExePath']
  .map((n) => extractFunction(MAIN_SRC, n)).join('\n');

(async () => {
  try {
    // ---- 夹具：白名单＋随包载荷落在真临时目录 ----
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lea-a1-'));
    const P = {};
    P.wlJson = path.join(tmp, 'syshelper', 'whitelist.json');
    for (const p of [P.wlJson]) fs.mkdirSync(path.dirname(p), { recursive: true });
    const PF = 'C:\\Program Files';
    const PD = 'C:\\ProgramData';

    function makeCtx(opts) {
      const o = Object.assign({
        // 健康检查场景
        svcState: 'RUNNING', svcRegistered: true,
        regVersion: '0.1.0', regState: 'Installed', regPresent: true,
        pkgVersion: '0.1.0',
        leaDegraded: false,
        // leaServiceInstalled 场景（live 三件＋随包三件内容）
        leaExe: true, leaClient: true, leaVer: true,
        liveQfr: 'live-QFRLEA-r11', pkgQfr: 'live-QFRLEA-r11',
        liveClient: 'live-qf-client-r11', pkgClient: 'live-qf-client-r11',
        liveUsh: 'live-USH-r11', pkgUsh: 'live-USH-r11',
        payloadPresent: true, liveUshPresent: true,
        // 修复场景
        spawnMode: 'ok', // ok | fail | timeout | throw
        platform: 'win32',
        tamperPkgQfr: false,
      }, opts || {});
      const pkgQfrContent = o.tamperPkgQfr ? 'tampered-QFRLEA' : o.pkgQfr;
      // 白名单：QFRLEA.exe 条目＝随包件原始实算（篡改场景下磁盘已变、
      // 白名单未变→门禁；若白名单跟着篡改内容算，就验不出篡改）。
      const wlObj = { files: { 'QFRLEA.exe': sha256(Buffer.from(o.pkgQfr)) }, version: '3.0.0' };
      fs.writeFileSync(P.wlJson, JSON.stringify(wlObj, null, 2));
      const present = new Set();
      if (o.leaExe) present.add(path.join(PF, 'QFR', 'LEA', 'QFRLEA.exe'));
      if (o.leaClient) present.add(path.join(PF, 'QFR', 'LEA', 'qf-lea-client.exe'));
      if (o.leaVer) present.add(path.join(PF, 'QFR', 'LEA', 'version.json'));
      if (o.leaDegraded) present.add(path.join(PD, 'QFR', 'LEA', 'LEA_DEGRADED'));
      if (o.extraPresent) for (const p of o.extraPresent) present.add(p);
      const liveQfrPath = path.join(PF, 'QFR', 'LEA', 'QFRLEA.exe');
      const liveClientPath = path.join(PF, 'QFR', 'LEA', 'qf-lea-client.exe');
      const liveUshPath = path.join(PF, 'QFR', 'LEA', 'QFUserHelper.exe');
      const pkgQfrPath = path.join(tmp, 'lea', 'QFRLEA.exe');
      const pkgClientPath = path.join(tmp, 'lea', 'qf-lea-client.exe');
      const pkgUshPath = path.join(tmp, 'ush', 'QFUserHelper.exe');
      const pkgVerPath = path.join(tmp, 'lea', 'version.txt');
      // 随包三件＋version.txt 写真实磁盘：repairLeaService 调的 sys-helper
      // 是真实模块（读真实磁盘，不走沙箱 fakeFs）；只放 contentMap 里它
      // 读不到，会误报 hash-mismatch。live 三件是假 Windows 路径，只进
      // contentMap（leaServiceInstalled 用沙箱 fs，读得到）。
      for (const [p, content] of [[pkgQfrPath, pkgQfrContent], [pkgClientPath, o.pkgClient], [pkgUshPath, o.pkgUsh], [pkgVerPath, o.pkgVersion + '\n']]) {
        if (o.payloadPresent) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); }
        else fs.rmSync(p, { force: true }); // 删上轮夹具残留，免得缺件场景读到旧文件
      }
      const contentMap = new Map();
      if (o.leaExe) contentMap.set(liveQfrPath, Buffer.from(o.liveQfr));
      if (o.leaClient) contentMap.set(liveClientPath, Buffer.from(o.liveClient));
      if (o.liveUshPresent) contentMap.set(liveUshPath, Buffer.from(o.liveUsh));
      if (o.payloadPresent) {
        contentMap.set(pkgQfrPath, Buffer.from(pkgQfrContent));
        contentMap.set(pkgClientPath, Buffer.from(o.pkgClient));
        contentMap.set(pkgUshPath, Buffer.from(o.pkgUsh));
        contentMap.set(pkgVerPath, Buffer.from(o.pkgVersion + '\n'));
      }
      const realFixture = new Set([P.wlJson]);
      if (o.payloadPresent) for (const p of [pkgQfrPath, pkgClientPath, pkgUshPath, pkgVerPath]) realFixture.add(p);
      const fakeFs = {
        existsSync: (p) => {
          if (present.has(p)) return true;
          if (contentMap.has(p)) return true;
          if (realFixture.has(p)) return true;
          return false;
        },
        readFileSync: (p, enc) => {
          if (contentMap.has(p)) {
            const b = contentMap.get(p);
            return enc ? b.toString(enc) : b;
          }
          return fs.readFileSync(p, enc);
        },
      };
      const spawns = [];
      const spawnSyncCalls = [];
      const bootLogs = [];
      const dialogCalls = [];
      const timeoutCalls = [];
      const fakeSetTimeout = (fn, ms, ...rest) => {
        timeoutCalls.push({ ms });
        // 只真调度短定时器（waitInstallResult 的 50ms 超时）；60 秒重试与
        // 10 秒轮询只记录、不真等（进程退出时不拖时间）。
        if (ms <= 2000) return setTimeout(fn, ms, ...rest);
        return { unref: () => {} };
      };
      const sandbox = {
        __dirname: tmp,
        IS_TEST: false, // A16-S2：main.js 模块级 TEST 身份镜像（生产模式；抽取函数引用它）。
        process: { platform: o.platform, env: { ProgramFiles: (o.envPf !== undefined ? o.envPf : PF), ProgramData: PD }, resourcesPath: '', execPath: 'C:\\QFRemote\\QFRemote.exe' },
        app: { isPackaged: false, getVersion: () => '3.0.0' },
        settings: {},
        saveSettings: () => {},
        bootLog: (tag, detail) => { bootLogs.push(tag + (detail ? ':' + detail : '')); },
        setTimeout: fakeSetTimeout, clearTimeout,
        sysHelper: sh,
        sysPrograms: require('../sys-programs'), // D-09
        fs: fakeFs,
        path,
        win: null,
        dialog: { showMessageBox: async (owner, opts) => { dialogCalls.push(opts); return { response: 0 }; } },
        require: (name) => {
          if (name === 'crypto') return crypto;
          if (name === 'child_process') {
            return {
              spawn: (file, args, opts2) => {
                spawns.push({ file, args: args.slice(), opts: opts2 });
                if (o.spawnMode === 'throw') throw new Error('simulated spawn ENOENT');
                return {
                  on: (ev, cb) => {
                    if (ev === 'close' && typeof cb === 'function') {
                      if (o.spawnMode === 'ok') cb(0);
                      else if (o.spawnMode === 'fail') cb(1);
                      // timeout：永不 close，等 waitInstallResult 超时。
                    }
                  },
                  stdout: { on: () => {} },
                  stderr: { on: () => {} },
                  kill: () => { spawns[spawns.length - 1].killed = true; },
                };
              },
              spawnSync: (file, args, opts2) => {
                spawnSyncCalls.push({ file, args: args.slice() });
                // D-09
                if (String(file).replace(/\\/g, '/').endsWith('/sc.exe')) {
                  if (!o.svcRegistered) return { status: 1060, stdout: '' };
                  return { status: 0, stdout: 'SERVICE_NAME: QFRLEA\n        STATE              : 4  ' + o.svcState + '\n' };
                }
                if (String(file).replace(/\\/g, '/').endsWith('/reg.exe')) {
                  const v = args[args.length - 1];
                  if (!o.regPresent) return { status: 1, stdout: '' };
                  const val = v === 'version' ? o.regVersion : o.regState;
                  if (val === '' || val == null) return { status: 1, stdout: '' };
                  return { status: 0, stdout: 'HKEY_LOCAL_MACHINE\\SOFTWARE\\QFR\\LEA\n    ' + v + '    REG_SZ    ' + val + '\n' };
                }
                return { status: 0, stdout: '' };
              },
            };
          }
          throw new Error('unexpected require: ' + name);
        },
        console,
      };
      vm.createContext(sandbox);
      vm.runInContext(
        'let systemServicesInstallTried = false;\nlet leaBackfillRecheckRunning = false;\n' +
        'let leaRepairRunning = false;\nlet leaRepairRetried = false;\n' +
        'let healDialogOpen = false;\nlet lastHealShownKey = null;\n' +
        'let INSTALL_WAIT_MS = 50;\n' + FNS, sandbox);
      return { sandbox, spawns, spawnSyncCalls, bootLogs, dialogCalls, timeoutCalls, o,
        health: () => vm.runInContext('leaHealthCheck()', sandbox),
        repair: () => vm.runInContext('repairLeaService()', sandbox),
        check: () => vm.runInContext('maybeCheckLeaHealth()', sandbox),
        clientPath: () => vm.runInContext('leaClientExePath()', sandbox) };
    }
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    // ---- H. 健康检查全部不健康态 ----
    {
      const c = makeCtx({});
      const h = c.health();
      ok('H1_healthy', h.healthy === true && h.reasons.length === 0, { reasons: h.reasons });
      ok('H1b_versions', h.registryVersion === '0.1.0' && h.packagedVersion === '0.1.0');
      // D-09：主进程传绝对路径，按 basename 匹配。
      ok('H1c_sc_reg_queried', c.spawnSyncCalls.some((s) => String(s.file).replace(/\\/g, '/').endsWith('/sc.exe')) && c.spawnSyncCalls.some((s) => String(s.file).replace(/\\/g, '/').endsWith('/reg.exe')));

      const c2 = makeCtx({ svcRegistered: false });
      const h2 = c2.health();
      ok('H2_no_service', h2.healthy === false && h2.reasons.includes('service-not-registered'), { reasons: h2.reasons });

      const c3 = makeCtx({ svcState: 'STOPPED' });
      const h3 = c3.health();
      ok('H3_stopped', h3.healthy === false && h3.reasons.some((r) => r.startsWith('service-not-running:STOPPED')), { reasons: h3.reasons });

      const c4 = makeCtx({ regVersion: '0.2.0' });
      const h4 = c4.health();
      ok('H4_version_mismatch', h4.healthy === false && h4.reasons.some((r) => r.startsWith('version-mismatch')), { reasons: h4.reasons });

      const c5 = makeCtx({ regPresent: false });
      const h5 = c5.health();
      ok('H5_reg_missing', h5.healthy === false && h5.reasons.includes('registry-version-missing'), { reasons: h5.reasons });

      const c6 = makeCtx({ regState: 'PendingRepair' });
      const h6 = c6.health();
      ok('H6_pending_repair', h6.healthy === false && h6.pendingRepair === true && h6.reasons.includes('pending-repair'), { reasons: h6.reasons });

      const c7 = makeCtx({ leaDegraded: true });
      const h7 = c7.health();
      ok('H7_degraded_marker', h7.healthy === false && h7.pendingRepair === true && h7.reasons.includes('degraded-marker'), { reasons: h7.reasons });

      const c8 = makeCtx({ liveUsh: 'live-USH-r10' });
      const h8 = c8.health();
      ok('H8_hash_mismatch', h8.healthy === false && h8.reasons.includes('files-or-registration'), { reasons: h8.reasons });

      const c9 = makeCtx({ svcRegistered: false, regState: 'PendingRepair', leaDegraded: true, regVersion: '9.9.9' });
      const h9 = c9.health();
      ok('H9_multi_reasons', h9.healthy === false && h9.reasons.length >= 4, { reasons: h9.reasons });
    }

    // ---- R. 修复路径 ----
    {
      // R1：helper 不可用→一次 UAC --install-service --repair（参数逐字）。
      const c = makeCtx({ svcRegistered: false });
      const r = await c.repair();
      ok('R1_launched', r && r.ok === true && r.reason === 'launched', { reason: r && r.reason });
      ok('R1_helper_unavailable_log', c.bootLogs.some((l) => l.startsWith('lea-repair.helper-unavailable')));
      ok('R1_one_spawn', c.spawns.length === 1);
      const argStr = c.spawns.length ? c.spawns[0].args.join(' ') : '';
      ok('R1_powershell_hidden', c.spawns[0].file === require('../sys-programs').powershellPath() && argStr.includes('-WindowStyle Hidden'));
      ok('R1_runas_repair', argStr.includes('-Verb RunAs') && argStr.includes("'--install-service'") && argStr.includes("'--repair'"));
      ok('R1_pending_log', c.bootLogs.some((l) => l === 'lea-repair.pending'));
      ok('R1_no_dialog_on_launch', c.dialogCalls.length === 0);

      // R2：白名单哈希不符→零拉起。
      const c2 = makeCtx({ tamperPkgQfr: true });
      const r2 = await c2.repair();
      ok('R2_hash_mismatch', r2 && r2.ok === false && r2.reason === 'hash-mismatch', { reason: r2 && r2.reason });
      ok('R2_no_spawn', c2.spawns.length === 0);
      ok('R2_log', c2.bootLogs.some((l) => l === 'lea-repair.hash-mismatch:QFRLEA.exe'));

      // R3：载荷缺失→零拉起。
      const c3 = makeCtx({ payloadPresent: false });
      const r3 = await c3.repair();
      ok('R3_no_payload', r3 && r3.ok === false && r3.reason === 'no-payload', { reason: r3 && r3.reason });
      ok('R3_no_spawn', c3.spawns.length === 0);

      // R4：exit 非零→失败＋可见提示＋60 秒重试已调度。
      const c4 = makeCtx({ spawnMode: 'fail' });
      const r4 = await c4.repair();
      ok('R4_failed', r4 && r4.ok === false && r4.reason === 'repair-failed', { reason: r4 && r4.reason });
      ok('R4_log', c4.bootLogs.some((l) => l.startsWith('lea-repair.install-failed')));
      ok('R4_dialog_shown', c4.dialogCalls.length === 1 && String(c4.dialogCalls[0].message || '').includes('本地代理服务修复失败'));
      ok('R4_retry_scheduled_60s', c4.timeoutCalls.some((t) => t.ms === 60000));

      // R5：超时→失败＋提示＋重试（INSTALL_WAIT_MS=50，桩永不 close）。
      const c5 = makeCtx({ spawnMode: 'timeout' });
      const r5 = await c5.repair();
      ok('R5_timeout', r5 && r5.ok === false && r5.reason === 'repair-failed', { reason: r5 && r5.reason });
      ok('R5_log', c5.bootLogs.some((l) => l === 'lea-repair.timeout'));
      ok('R5_dialog_shown', c5.dialogCalls.length === 1);
      ok('R5_retry_scheduled_60s', c5.timeoutCalls.some((t) => t.ms === 60000));

      // R6：spawn 抛错→失败＋提示＋重试（不挂起 promise）。
      const c6 = makeCtx({ spawnMode: 'throw' });
      const r6 = await c6.repair();
      ok('R6_spawn_throw', r6 && r6.ok === false && r6.reason === 'repair-failed', { reason: r6 && r6.reason });
      ok('R6_log', c6.bootLogs.some((l) => l.startsWith('lea-repair.spawn-throw')));
      ok('R6_dialog_shown', c6.dialogCalls.length === 1);
      ok('R6_retry_scheduled_60s', c6.timeoutCalls.some((t) => t.ms === 60000));

      // R7：并发二次调用→already-running（只拉起一次）。
      const c7 = makeCtx({ spawnMode: 'timeout' });
      const p1 = c7.repair();
      const r7b = await c7.repair();
      ok('R7_second_already_running', r7b && r7b.ok === false && r7b.reason === 'already-running', { reason: r7b && r7b.reason });
      await p1;
      ok('R7_one_spawn', c7.spawns.length === 1);

      // R8：非 Windows→non-windows，零拉起。
      const c8 = makeCtx({ platform: 'linux' });
      const r8 = await c8.repair();
      ok('R8_non_windows', r8 && r8.ok === false && r8.reason === 'non-windows', { reason: r8 && r8.reason });
      ok('R8_no_spawn', c8.spawns.length === 0);
    }

    // ---- M. 健康检查入口 ----
    {
      const c = makeCtx({});
      const r = await c.check();
      ok('M1_healthy_noop', r && r.ok === true && r.reason === 'healthy', { reason: r && r.reason });
      ok('M1_healthy_no_spawn', c.spawns.length === 0);
      ok('M1_healthy_log', c.bootLogs.some((l) => l.startsWith('lea-health.ok')));

      const c2 = makeCtx({ svcRegistered: false });
      const r2 = await c2.check();
      ok('M2_unhealthy_repairs', r2 && r2.ok === true && r2.reason === 'launched', { reason: r2 && r2.reason });
      ok('M2_unhealthy_log', c2.bootLogs.some((l) => l.startsWith('lea-health.unhealthy')));
      ok('M2_one_spawn', c2.spawns.length === 1);

      const c3 = makeCtx({ platform: 'linux' });
      const r3 = await c3.check();
      ok('M3_non_windows', r3 && r3.ok === false && r3.reason === 'non-windows');
    }

    // ---- P. H1：leaClientExePath 候选顺序（自家目录优先） ----
    // 注意：本沙箱是 posix path，'C:\QFRemote\QFRemote.exe' 的 dirname 会坍成
    // '.'，故 execPath 旁候选在本机算作 'LEA/qf-lea-client.exe'；断言的是三
    // 候选的相对优先关系（与真机 win32 path 的顺序语义一致），不是盘符拼写。
    // payloadPresent:false：否则夹具会把随包客户端写进 tmp/lea/，恰好等于
    // __dirname 候选，使“旧目录独存／全无”两个场景失真。
    {
      const execSide = path.join(path.dirname('C:\\QFRemote\\QFRemote.exe'), 'LEA', 'qf-lea-client.exe');
      const devDir = path.join(tmp, 'lea', 'qf-lea-client.exe');
      const pfOld = path.join(PF, 'QFR', 'LEA', 'qf-lea-client.exe');
      const c1 = makeCtx({ leaClient: true, payloadPresent: false, extraPresent: [execSide] });
      ok('P1_both_prefers_own', c1.clientPath() === execSide, { got: c1.clientPath() });
      const c2 = makeCtx({ leaClient: true, payloadPresent: false });
      ok('P2_pf_only_fallback', c2.clientPath() === pfOld, { got: c2.clientPath() });
      const c3 = makeCtx({ leaClient: false, payloadPresent: false, extraPresent: [devDir] });
      ok('P3_dirname_only', c3.clientPath() === devDir, { got: c3.clientPath() });
      const c4 = makeCtx({ leaClient: false, payloadPresent: false, extraPresent: [execSide, devDir] });
      ok('P4_exec_beats_dirname', c4.clientPath() === execSide, { got: c4.clientPath() });
      const c5 = makeCtx({ leaClient: false, payloadPresent: false });
      ok('P5_none_null', c5.clientPath() === null, { got: c5.clientPath() });
      const c6 = makeCtx({ leaClient: false, payloadPresent: false, envPf: '', extraPresent: [execSide] });
      ok('P6_no_pf_env', c6.clientPath() === execSide, { got: c6.clientPath() });
    }

    // ---- S. 静态深查 ----
    {
      const nsi = fs.readFileSync(path.join(__dirname, '..', 'installer.nsi'), 'utf8');
      const outer = fs.readFileSync(path.join(__dirname, '..', 'installer-outer.nsi'), 'utf8');
      const leaPs1 = fs.readFileSync(path.join(__dirname, '..', 'install-lea.ps1'), 'utf8');
      const wrapper = fs.readFileSync(path.join(__dirname, '..', 'install-system-services.ps1'), 'utf8');
      ok('S1a_inner_admin', /^RequestExecutionLevel admin$/m.test(nsi) && !/^RequestExecutionLevel user$/m.test(nsi));
      ok('S1b_inner_outfile', nsi.includes('OutFile "${OUT_DIR}/QFRSetupAdmin.exe"'));
      ok('S1c_verify_3x', nsi.includes('--verify-manifest') && nsi.includes('IntCmp $R8 3 a1VerifyFail'));
      ok('S1d_install_service', nsi.includes('--install-service') && nsi.includes('--install-service --repair'));
      ok('S1e_rollback', nsi.includes('QFR-LEA-backup') && nsi.includes('已恢复旧版服务'));
      ok('S1f_tasksonly', (() => {
        const leaCall = nsi.split('\n').find((l) => l.includes('install-lea.ps1') && l.includes('nsExec'));
        return !!leaCall && leaCall.includes('-TasksOnly');
      })());
      ok('S1g_pending_repair', nsi.includes('A1WritePendingRepair') && nsi.includes('"installState" "PendingRepair"'));
      ok('S1h_done_file', nsi.includes('QFRSetupAdmin.done') && nsi.includes('.onInstFailed'));
      ok('S1i_no_login_install', !nsi.includes('首次登录后安装') && !nsi.includes('install-system-services.ps1'));
      ok('S1j_uninstall_service', nsi.includes('--uninstall-service'));
      // S1k/S1l（H1，v6）：升级段解压前删旧全机残留，只删该目录、删不掉 Abort。
      ok('S1k_h1_pf_cleanup', (() => {
        const iClear = nsi.indexOf('Call A1ClearVerifyResidue');
        const iH1 = nsi.indexOf('RMDir /r "$PROGRAMFILES\\QFR\\LEA"');
        const iExtract = nsi.indexOf('正在解压程序文件');
        return iClear > -1 && iH1 > iClear && iExtract > iH1 && !nsi.includes('RMDir /r "$PROGRAMFILES\\QFR"');
      })());
      ok('S1l_h1_cleanup_abort', (() => {
        const h1Block = nsi.slice(nsi.indexOf('H1（2026-11-15'), nsi.indexOf('h1PfLeaClean:'));
        return h1Block.includes('RMDir /r "$PROGRAMFILES\\QFR\\LEA"') && h1Block.includes('Abort') && h1Block.includes('DetailPrint');
      })());
      // S1m（H1）：安装器三条铁律仍在——①停服等退出 ②重试显式 SetOutPath
      // ③校验失败落盘坏文件名（A1PrintVerifyBadFiles＋qfr-verify.log）。
      ok('S1m_iron_laws', nsi.includes('sc stop QFRLEA') && nsi.includes('waitSvcStopped')
        && (nsi.match(/SetOutPath "\$INSTDIR"/g) || []).length >= 2
        && nsi.includes('A1PrintVerifyBadFiles') && nsi.includes('qfr-verify.log'));
      ok('S2a_outer_user', outer.includes('RequestExecutionLevel user'));
      ok('S2b_outer_runas', outer.includes('ExecShell "runas"'));
      ok('S2c_uac_denied', outer.includes('您拒绝了管理员授权') && outer.includes('未安装任何文件'));
      ok('S2d_done_wait_900', outer.includes('QFRSetupAdmin.done') && outer.includes('StrCpy $R8 900'));
      ok('S2e_outer_silent', outer.includes('"/S"') || outer.includes("StrCpy $R2 \"/S\""));
      ok('S2f_outer_no_7z', (() => {
        const code = outer.split('\n').filter((l) => !/^\s*;/.test(l)).join('\n');
        return !code.includes('app.7z') && !code.includes('Nsis7z');
      })());
      ok('S2g_outer_outfile', outer.includes('OutFile "${OUT_DIR}/QFRemote-Setup-v${BUILD_VERSION}.exe"'));
      ok('S3a_tasksonly_switch', leaPs1.includes('[switch]$TasksOnly'));
      ok('S3b_register_fn', leaPs1.includes('function Register-AllUshTasks'));
      ok('S3c_tasksonly_exit', leaPs1.includes("if ($TasksOnly)") && leaPs1.includes('TasksOnly ok'));
      ok('S3d_full_mode_kept', leaPs1.includes('if ($Rollback)') && leaPs1.includes('create-service'));
      ok('S4_wrapper_skip_guard', wrapper.includes('already installed by setup') && wrapper.includes('leaAlreadyHealthy'));
      // S5：隔离——客户端与服务端不含服务子命令。
      const client = fs.readFileSync(path.join(__dirname, '..', 'lea', 'qf-lea-client.c'), 'utf8');
      ok('S5a_client_clean', !client.includes('--install-service') && !client.includes('--uninstall-service') && !client.includes('--verify-manifest'));
      let serverClean = true;
      for (const f of ['lea-core.js', 'lea-channel.js']) {
        const src = fs.readFileSync(path.join(__dirname, '..', '..', 'server', 'ext', 'lea', f), 'utf8');
        if (src.includes('--install-service') || src.includes('--uninstall-service')) serverClean = false;
      }
      ok('S5b_server_clean', serverClean);
      // S6：清单工具——生成／校验／篡改／缺失。
      const payloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lea-a1-manifest-'));
      fs.writeFileSync(path.join(payloadDir, 'a.txt'), 'hello');
      fs.mkdirSync(path.join(payloadDir, 'sub'));
      fs.writeFileSync(path.join(payloadDir, 'sub', 'b.bin'), Buffer.from([0, 1, 2, 3]));
      const genTool = path.join(__dirname, '..', 'tools', 'gen_file_manifest.py');
      execFileSync('python3', [genTool, '--payload', payloadDir], { encoding: 'utf8' });
      const manifest = fs.readFileSync(path.join(payloadDir, 'file-manifest.txt'), 'utf8');
      ok('S6a_manifest_2_files', manifest.trim().split('\n').length === 2 && manifest.includes('a.txt') && manifest.includes('sub/b.bin'));
      ok('S6b_manifest_hash', manifest.split('\n')[0].startsWith(sha256(Buffer.from('hello'))));
      execFileSync('python3', [genTool, '--payload', payloadDir, '--check'], { encoding: 'utf8' });
      ok('S6c_check_ok', true);
      fs.writeFileSync(path.join(payloadDir, 'a.txt'), 'tampered');
      let checkFailed = false;
      try { execFileSync('python3', [genTool, '--payload', payloadDir, '--check'], { encoding: 'utf8' }); } catch (e) { checkFailed = true; }
      ok('S6d_check_fails_on_tamper', checkFailed);
      fs.unlinkSync(path.join(payloadDir, 'file-manifest.txt'));
      let checkFailed2 = false;
      try { execFileSync('python3', [genTool, '--payload', payloadDir, '--check'], { encoding: 'utf8' }); } catch (e) { checkFailed2 = true; }
      ok('S6e_check_fails_when_missing', checkFailed2);
      // S7：main.js 接线。
      ok('S7a_login_calls_health', MAIN_SRC.includes('maybeCheckLeaHealth().catch(() => {});'));
      ok('S7b_no_backfill_launch', !MAIN_SRC.includes('leaBackfill = true') && !MAIN_SRC.includes("bootLog('system-services.lea-backfill-pending'"));
      ok('S7c_health_in_main', MAIN_SRC.includes('function leaHealthCheck()') && MAIN_SRC.includes('function repairLeaService()'));
      // S7d（H1，v6）：leaClientExePath 候选顺序——运行目录旁 LEA\ ＞
      // __dirname\lea ＞ %ProgramFiles%\QFR\LEA（最后兜底）。
      ok('S7d_lea_client_order', (() => {
        const leaFn = extractFunction(MAIN_SRC, 'leaClientExePath');
        const iExec = leaFn.indexOf("path.dirname(process.execPath), 'LEA'");
        const iDir = leaFn.indexOf("__dirname, 'lea'");
        const iPf = leaFn.indexOf("path.join(pf, 'QFR', 'LEA'");
        return iExec > -1 && iDir > iExec && iPf > iDir;
      })());
      // S8：白名单含 QFRLEA.exe 且与磁盘实算一致。
      const realWl = sh.loadWhitelist({ resourcesPath: '', dirname: path.join(__dirname, '..', 'syshelper') });
      const realQfr = path.join(__dirname, '..', 'lea', 'QFRLEA.exe');
      const realQfrHash = sha256(fs.readFileSync(realQfr));
      ok('S8_wl_has_qfrlea', !!(realWl && realWl.files && realWl.files['QFRLEA.exe'] === realQfrHash),
        { wl: realWl && realWl.files && realWl.files['QFRLEA.exe'], disk: realQfrHash });
      ok('S8_verify_qfrlea', sh.verifyFileHash(realQfr, realWl) === true);
    }

    result.pass = Object.values(result.cases).every((c) => c.gating === false || c.pass);
  } catch (e) {
    result.error = (e && e.stack) || String(e);
    result.pass = false;
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.pass ? 0 : 1);
})();
