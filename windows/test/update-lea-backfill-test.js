'use strict';
/*
 * 更新路径 LEA 升级补装（B-LEA，3.0.0，windows/main.js）本地自检：
 *  A. leaServiceInstalled 判据：exe＋version.json 齐全且无 LEA_DEGRADED 才算已装；
 *  B. 锁已装＋LEA 缺失（升级场景）→ 不返 already-installed，落到白名单校验＋
 *     一次 UAC 拉起 install-system-services.ps1（-LeaScriptHash 随行）；
 *  C. 锁已装＋LEA 降级（LEA_DEGRADED 在）→ 同样补装；
 *  D. 锁已装＋LEA 齐全 → 原路 already-installed／owner-updated，不拉起；
 *  E. 补装路径哈希篡改 → fail-closed（hash-mismatch，零拉起）；
 *  F. 锁未装（全新安装）→ 原行为 launched 不变；同版本二次调用 already-tried；
 *     force=true（锁面板手动重试）绕过每版本守门；
 *  J. F1 打包形态（深查发现）：打包时 -LeaDir 显式传 $INSTDIR\LEA
 *     （process.execPath 旁），-LeaScriptHash 随行；开发态不传 -LeaDir；
 *     asar 解包映射 unpackedAppPath／preferUnpackedPath 单元断言。
 *  G. 白名单闭环实盘核对（非门禁探针，只记录）：whitelist.json 内
 *     install-lea.ps1 条目 == 磁盘 install-lea.ps1 实算 SHA-256。漂移时
 *     本组只记录、不判失败——install-lea.ps1 与 whitelist.json 属他线
 *     在制品，他线改动中途必然漂移；收口由发版流程 gen_whitelist.py／
 *     build.sh 刷新（H19），否则升级补装上线即 hash-mismatch。
 * 手段：从 main.js 原文按花括号配对抽取 lockComponentSourceDir／
 * lockServiceInstalled／leaServiceInstalled／maybeInstallSystemServices
 * 四段真实函数文本，在 vm 沙箱里跑（fake process/app，spawn／spawnSync
 * 桩记录拉起与服务注册态），不复制逻辑；被验四件文件＋白名单落在真临时
 * 目录、走真 sys-helper loadWhitelist／verifyFileHash；锁 device.json 与
 * LEA 落盘态由 existsSync 桩按场景给。结果写 JSON 到 QFTEST_OUT，退出码
 * 0=通过。R1 补充：Q1 服务注册＋client exe 判据（A5／A6／B7）；Q4 owner
 * UAC 串行化 defer＋下次登录收敛（H）；Q3.2 补装结果日志（I）。
 * 真机部分（旧版→新版 UAC 拉起、QFRLEA 服务真装真起）不在沙箱覆盖，见阿里测试清单。
 * 探针 P1（非门禁）：拉起成功／失败行由 M-C DS-6 拉起块记既有日志
 * （launched／install-failed 等），本线为保 hunk 可分未在该块加 backfill
 * 打标，排障按序对上 lea-missing 行；是否须逐行打标待 DS R2 裁决。
 *  K. r12 哈希比对（leaServiceInstalled 同版号不同哈希 → 未装 → backfill）：
 *     K1 载荷在、三件哈希一致 → 已装／already-installed，不拉起；
 *     K2 载荷在、live USH 哈希不同 → 未装 → launched 补装，记
 *        system-services.lea-hash-mismatch:QFUserHelper.exe；
 *     K3 载荷在、live QFRLEA 哈希不同 → 未装 → launched 补装；
 *     K4 载荷缺失（开发态未编／旧包无 LEA）→ 无法比对，按旧判据放行；
 *     K5 live 比随包新（用户降级应用）→ 同样判未装、与运行中应用对齐；
 *     K6 打包态（execPath 旁 LEA/）：一致 → 已装；USH 不同 → launched。
 *     K7 载荷在、live qf-lea-client.exe 哈希不同 → 未装 → launched 补装。
 *     K8 载荷在、live QFUserHelper.exe 文件缺失 → 未装 → launched 补装
 *        （DS diff 复核覆盖缺口：旧夹具让 live USH 永不缺失）。
 *     K9 载荷在、随包 USH 存在但读失败 → 单记 lea-pkg-hash-read-error
 *        并跳过该件，其余件一致 → 已装（DS diff 复核问题 A）。
 *     沙箱内补装是桩 spawn，不真换文件，故补装后复核仍记 lea-degraded，
 *     属夹具局限（真机上 backfill 换件后哈希即一致，记 lea-installed），
 *     K 组只断言拉起与否与 mismatch 日志，不对复核行断言。
 *  L. r12 守门键（版本 OR 载荷签名，DS 方案复核阻断点 1）：
 *     L1 同版本＋同载荷签名 → tried-this-version，不拉起；
 *     L2 同版本＋载荷签名变 → 放行检查（live 一致 → already-installed，
 *        且 settings.systemServicesTriedPayload 已刷新为新签名）；
 *     L3 同版本＋旧设置无 triedPayload（r11 机器首启 r12）＋live USH
 *        不同 → 放行 → launched 补装（复测无需手动重置守门）；
 *     L4 载荷缺失无法签名＋同版本 → 退回只比版本 → tried-this-version；
 *     L5 owner UAC 在飞 defer 时 triedPayload 随 triedVersion 一并恢复。
 *     L6 部分载荷（缺 client）＋同版本＋签名与在位两件一致 →
 *        tried-this-version（签名逐项跳过，与比对循环同语义）；
 *     L7 部分载荷（缺 client）＋同版本＋旧签名为三件全量 →
 *        签名变 → 放行检查（live 在位件一致 → already-installed）。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const vm = require('vm');
const sh = require('../sys-helper');

const OUT = process.env.QFTEST_OUT || '/tmp/qfr300/update-lea-backfill-result.json';
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

(async () => {
  try {
    // ---- 抽取真实函数文本，并做防 stale 断言 ----
    const fns = ['lockComponentSourceDir', 'lockServiceInstalled', 'leaServiceInstalled', 'maybeInstallSystemServices', 'unpackedAppPath', 'preferUnpackedPath', 'leaPayloadPath', 'sha256File', 'leaPayloadSignature']
      .map((n) => extractFunction(MAIN_SRC, n)).join('\n');
    ok('X0_extract', fns.includes('leaServiceInstalled()') && fns.includes('LEA_DEGRADED')
      && fns.includes('system-services.lea-missing') && fns.includes('lea-backfill-deferred')
      && fns.includes('sc.exe') && fns.includes('qf-lea-client.exe')
      && fns.includes('lea-hash-mismatch') && fns.includes('QFUserHelper.exe')
      && fns.includes('systemServicesTriedPayload') && fns.includes('leaPayloadSignature()'));

    // ---- 夹具：四件被验文件＋白名单落在真临时目录（__dirname 即该目录），
    //      走真 sys-helper loadWhitelist／verifyFileHash ----
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lea-backfill-'));
    const P = {};
    P.sysPs1 = path.join(tmp, 'install-system-services.ps1');
    P.helperExe = path.join(tmp, 'syshelper', 'QFSysHelper.exe');
    P.installPs1 = path.join(tmp, 'privacy-lock', 'install.ps1');
    P.leaPs1 = path.join(tmp, 'syshelper', 'LEA', 'install-lea.ps1');
    P.pkgLeaPs1 = path.join(tmp, 'LEA', 'install-lea.ps1');
    P.wlJson = path.join(tmp, 'syshelper', 'whitelist.json');
    for (const p of [P.sysPs1, P.helperExe, P.installPs1, P.leaPs1, P.pkgLeaPs1]) {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, 'fixture-' + path.basename(p) + '-v3\n');
    }
    const leaHash = sha256(fs.readFileSync(P.leaPs1));
    const wlObj = { files: {
      'QFSysHelper.exe': sha256(fs.readFileSync(P.helperExe)),
      'install-lea.ps1': leaHash,
      'install-system-services.ps1': sha256(fs.readFileSync(P.sysPs1)),
      'install.ps1': sha256(fs.readFileSync(P.installPs1)),
    }, version: '3.0.0' };
    fs.writeFileSync(P.wlJson, JSON.stringify(wlObj, null, 2));
    const leaOrig = fs.readFileSync(P.leaPs1);

    // fake windows 落盘态（只由 existsSync 桩给，磁盘上不存在）
    const PF = 'C:\\Program Files';
    const PD = 'C:\\ProgramData';
    const W = {
      lockDevice: path.join(PF, 'QFRemote', 'Lock', 'device.json'),
      leaExe: path.join(PF, 'QFR', 'LEA', 'QFRLEA.exe'),
      leaClient: path.join(PF, 'QFR', 'LEA', 'qf-lea-client.exe'),
      leaVer: path.join(PF, 'QFR', 'LEA', 'version.json'),
      leaDegraded: path.join(PD, 'QFR', 'LEA', 'LEA_DEGRADED'),
    };

    function makeCtx(opts) {
      const o = Object.assign({
        lockInstalled: true, leaExe: false, leaClient: false, leaVer: false, leaDegraded: false,
        svcRegistered: true,
        ownerChanged: false, ownerUac: false, prevVersion: '2.4.4', appVersion: '3.0.0',
        tamperLea: false, tamperPkgLea: false, packaged: false, execPath: null, extraPresent: null,
        // K（r12）：随包载荷是否在位；live／随包三件内容（默认一致 = r11）。
        payloadPresent: false,
        liveQfr: 'live-QFRLEA-r11', pkgQfr: 'live-QFRLEA-r11',
        liveClient: 'live-qf-client-r11', pkgClient: 'live-qf-client-r11',
        liveUsh: 'live-USH-r11', pkgUsh: 'live-USH-r11',
        // L（r12）：上次已试的载荷签名（undefined = 旧设置无此键，如 r11）。
        prevPayload: undefined,
        // K8/L6/L7/K9（r12）：live USH 是否在位；随包省略件；随包读失败件。
        liveUshPresent: true, pkgOmit: [], pkgReadFail: [],
      }, opts || {});
      if (o.tamperLea) fs.writeFileSync(P.leaPs1, 'tampered\n');
      else fs.writeFileSync(P.leaPs1, leaOrig);
      if (o.tamperPkgLea) fs.writeFileSync(P.pkgLeaPs1, 'tampered\n');
      else fs.writeFileSync(P.pkgLeaPs1, leaOrig);
      const present = new Set();
      if (o.lockInstalled) present.add(W.lockDevice);
      if (o.leaExe) present.add(W.leaExe);
      if (o.leaClient) present.add(W.leaClient);
      if (o.leaVer) present.add(W.leaVer);
      if (o.leaDegraded) present.add(W.leaDegraded);
      // K：live 三件＋随包三件的内容映射（路径 → Buffer）。live 路径恒为
      // %ProgramFiles%\QFR\LEA\ 下三件；随包路径打包态为 execPath 旁 LEA/，
      // 开发态为 __dirname 下 lea/（QFRLEA／client）与 ush/（QFUserHelper）。
      const liveQfrPath = path.join(PF, 'QFR', 'LEA', 'QFRLEA.exe');
      const liveClientPath = path.join(PF, 'QFR', 'LEA', 'qf-lea-client.exe');
      const liveUshPath = path.join(PF, 'QFR', 'LEA', 'QFUserHelper.exe');
      const pkgQfrPath = o.packaged
        ? path.join(path.dirname(o.execPath || 'C:\\QFRemote\\QFRemote.exe'), 'LEA', 'QFRLEA.exe')
        : path.join(tmp, 'lea', 'QFRLEA.exe');
      const pkgClientPath = o.packaged
        ? path.join(path.dirname(o.execPath || 'C:\\QFRemote\\QFRemote.exe'), 'LEA', 'qf-lea-client.exe')
        : path.join(tmp, 'lea', 'qf-lea-client.exe');
      const pkgUshPath = o.packaged
        ? path.join(path.dirname(o.execPath || 'C:\\QFRemote\\QFRemote.exe'), 'LEA', 'QFUserHelper.exe')
        : path.join(tmp, 'ush', 'QFUserHelper.exe');
      const contentMap = new Map();
      if (o.leaExe) contentMap.set(liveQfrPath, Buffer.from(o.liveQfr));
      if (o.leaClient) contentMap.set(liveClientPath, Buffer.from(o.liveClient));
      // USH live 件：r12 哈希比对新增的读取对象；存在性本身不由 leaServiceInstalled
      // 的旧判据检查（旧判据只查 QFRLEA／client／version.json），故只进内容映射，
      // 不进 present 集合——旧用例不受影响。K8 用 liveUshPresent:false 模拟
      // live USH 缺失（DS diff 复核覆盖缺口）。
      if (o.liveUshPresent) contentMap.set(liveUshPath, Buffer.from(o.liveUsh));
      if (o.payloadPresent) {
        if (!o.pkgOmit.includes('QFRLEA.exe')) contentMap.set(pkgQfrPath, Buffer.from(o.pkgQfr));
        if (!o.pkgOmit.includes('qf-lea-client.exe')) contentMap.set(pkgClientPath, Buffer.from(o.pkgClient));
        if (!o.pkgOmit.includes('QFUserHelper.exe')) contentMap.set(pkgUshPath, Buffer.from(o.pkgUsh));
      }
      const fakeFs = {
        // 夹具四件＋白名单＋打包 LEA 载荷走真磁盘；Windows 落盘态走场景集合；
        // 其余一律 false（尤其 resourcesPath 为空时拼出的相对路径
        // 'QFSysHelper.exe'，不得随 cwd 抖动）。
        existsSync: (p) => {
          if (present.has(p)) return true;
          if (contentMap.has(p)) return true;
          if (p === P.sysPs1 || p === P.helperExe || p === P.installPs1 || p === P.leaPs1 || p === P.pkgLeaPs1 || p === P.wlJson) return true;
          if (o.extraPresent && o.extraPresent.has(p)) return true;
          if (p === 'QFSysHelper.exe') return false;
          return false;
        },
        readFileSync: (p, enc) => {
          if (contentMap.has(p)) {
            // K9：模拟随包件存在但读失败（杀毒瞬锁等）——只针对随包路径。
            // 沙箱 path 是 Linux 版，basename 认不出反斜杠，用 split 取尾名。
            const isPkg = p === pkgQfrPath || p === pkgClientPath || p === pkgUshPath;
            const base = String(p).split(/[\\/]/).pop();
            if (isPkg && o.pkgReadFail.includes(base)) throw new Error('simulated read failure: ' + base);
            const b = contentMap.get(p);
            return enc ? b.toString(enc) : b;
          }
          return fs.readFileSync(p, enc);
        },
      };
      const spawns = [];
      const spawnSyncCalls = [];
      const bootLogs = [];
      let syncCalls = 0;
      const sandbox = {
        __dirname: tmp,
        process: { platform: 'win32', env: { ProgramFiles: PF, ProgramData: PD }, resourcesPath: '', execPath: o.execPath || 'C:\\QFRemote\\QFRemote.exe' },
        app: { isPackaged: !!o.packaged, getVersion: () => o.appVersion },
        settings: { systemServicesTriedVersion: o.prevVersion, systemServicesTriedPayload: o.prevPayload },
        saveSettings: () => {},
        currentGateUsername: () => '718983610',
        bootLog: (tag, detail) => { bootLogs.push(tag + (detail ? ':' + detail : '')); },
        // 首调按场景（owner 换号且直接写不动 → 派 UAC）；再调视为 UAC 已完成，
        // 不再派发——模拟 defer 后下次登录的收敛态。
        syncLockOwner: async () => {
          syncCalls++;
          if (syncCalls === 1) return { ok: true, changed: !!o.ownerChanged, uacDispatched: !!o.ownerUac };
          return { ok: true, changed: false, uacDispatched: false };
        },
        sysHelper: sh,
        fs: fakeFs,
        path,
        require: (name) => {
          if (name === 'crypto') return crypto; // r12：sha256File 内联 require
          if (name === 'child_process') {
            return {
              spawn: (file, args, opts2) => {
                spawns.push({ file, args: args.slice(), opts: opts2 });
                return { on: () => {} };
              },
              spawnSync: (file, args, opts2) => {
                spawnSyncCalls.push({ file, args: args.slice() });
                if (file === 'sc.exe') {
                  return { status: o.svcRegistered ? 0 : 1060, stdout: o.svcRegistered ? 'SERVICE_NAME: QFRLEA' : '' };
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
      vm.runInContext('let systemServicesInstallTried = false;\n' + fns, sandbox);
      return { sandbox, spawns, spawnSyncCalls, bootLogs, o };
    }
    const run = async (ctx, force) => vm.runInContext(
      'maybeInstallSystemServices(' + (force ? 'true' : '') + ')', ctx.sandbox);

    // ---- A. leaServiceInstalled 判据（直接调） ----
    {
      const c = makeCtx({ lockInstalled: false, leaExe: true, leaClient: true, leaVer: true });
      ok('A1_full', vm.runInContext('leaServiceInstalled()', c.sandbox) === true);
      const c2 = makeCtx({ lockInstalled: false, leaExe: true, leaClient: true, leaVer: false });
      ok('A2_no_version', vm.runInContext('leaServiceInstalled()', c2.sandbox) === false);
      const c3 = makeCtx({ lockInstalled: false, leaExe: true, leaClient: true, leaVer: true, leaDegraded: true });
      ok('A3_degraded', vm.runInContext('leaServiceInstalled()', c3.sandbox) === false);
      const c4 = makeCtx({ lockInstalled: false });
      ok('A4_absent', vm.runInContext('leaServiceInstalled()', c4.sandbox) === false);
      const c5 = makeCtx({ lockInstalled: false, leaExe: true, leaClient: true, leaVer: true, svcRegistered: false });
      ok('A5_no_service', vm.runInContext('leaServiceInstalled()', c5.sandbox) === false);
      ok('A5b_sc_queried', c5.spawnSyncCalls.some((s) => s.file === 'sc.exe' && s.args.join(' ') === 'query QFRLEA'));
      const c6 = makeCtx({ lockInstalled: false, leaExe: true, leaClient: false, leaVer: true });
      ok('A6_no_client', vm.runInContext('leaServiceInstalled()', c6.sandbox) === false);
    }

    // ---- B. 升级场景：锁已装＋LEA 缺失 → 补装拉起 ----
    {
      const c = makeCtx({ lockInstalled: true, leaExe: false, leaVer: false });
      const r = await run(c);
      ok('B1_launched', r && r.ok === true && r.reason === 'launched', { reason: r && r.reason });
      ok('B2_spawn_once', c.spawns.length === 1);
      const argStr = c.spawns.length ? c.spawns[0].args.join(' ') : '';
      ok('B3_spawn_ps1', argStr.includes('install-system-services.ps1'));
      ok('B4_spawn_hash', argStr.includes('-LeaScriptHash') && argStr.includes(leaHash));
      ok('B5_log_missing', c.bootLogs.some((l) => l.startsWith('system-services.lea-missing')));
      ok('B6_no_already', !c.bootLogs.some((l) => l.startsWith('system-services.already-installed')));
    }

    // ---- C. 锁已装＋LEA 降级 → 补装拉起 ----
    {
      const c = makeCtx({ lockInstalled: true, leaExe: true, leaClient: true, leaVer: true, leaDegraded: true });
      const r = await run(c);
      ok('C1_launched', r && r.ok === true && r.reason === 'launched');
      ok('C2_spawn_once', c.spawns.length === 1);
    }

    // ---- D. 锁已装＋LEA 齐全 → 原路返回，不拉起 ----
    {
      const c = makeCtx({ lockInstalled: true, leaExe: true, leaClient: true, leaVer: true });
      const r = await run(c);
      ok('D1_already', r && r.ok === true && r.reason === 'already-installed', { reason: r && r.reason });
      ok('D2_no_spawn', c.spawns.length === 0);
      const c2 = makeCtx({ lockInstalled: true, leaExe: true, leaClient: true, leaVer: true, ownerChanged: true });
      const r2 = await run(c2);
      ok('D3_owner_updated', r2 && r2.ok === true && r2.reason === 'owner-updated');
      ok('D4_no_spawn2', c2.spawns.length === 0);
    }

    // ---- K. r12 哈希比对：同版号不同哈希 → 未装 → backfill ----
    {
      // K1：载荷在、两件哈希一致 → 已装／already-installed，不拉起。
      const c = makeCtx({ lockInstalled: true, leaExe: true, leaClient: true, leaVer: true, payloadPresent: true });
      ok('K1_match_installed', vm.runInContext('leaServiceInstalled()', c.sandbox) === true);
      const r = await run(c);
      ok('K1_match_already', r && r.ok === true && r.reason === 'already-installed', { reason: r && r.reason });
      ok('K1_match_no_spawn', c.spawns.length === 0);
      ok('K1_match_no_mismatch_log', !c.bootLogs.some((l) => l.startsWith('system-services.lea-hash-mismatch')));
      // K2：live USH 哈希不同（r10 件）→ 未装 → launched 补装。
      const c2 = makeCtx({ lockInstalled: true, leaExe: true, leaClient: true, leaVer: true, payloadPresent: true, liveUsh: 'live-USH-r10' });
      ok('K2_ush_mismatch_uninstalled', vm.runInContext('leaServiceInstalled()', c2.sandbox) === false);
      ok('K2_ush_mismatch_log', c2.bootLogs.some((l) => l === 'system-services.lea-hash-mismatch:QFUserHelper.exe'));
      const r2 = await run(c2);
      ok('K2_ush_launched', r2 && r2.ok === true && r2.reason === 'launched', { reason: r2 && r2.reason });
      ok('K2_ush_spawn_once', c2.spawns.length === 1);
      ok('K2_ush_missing_log', c2.bootLogs.some((l) => l.startsWith('system-services.lea-missing')));
      // K3：live QFRLEA 哈希不同 → 未装 → launched 补装。
      const c3 = makeCtx({ lockInstalled: true, leaExe: true, leaClient: true, leaVer: true, payloadPresent: true, liveQfr: 'live-QFRLEA-r10' });
      ok('K3_qfr_mismatch_uninstalled', vm.runInContext('leaServiceInstalled()', c3.sandbox) === false);
      ok('K3_qfr_mismatch_log', c3.bootLogs.some((l) => l === 'system-services.lea-hash-mismatch:QFRLEA.exe'));
      const r3 = await run(c3);
      ok('K3_qfr_launched', r3 && r3.ok === true && r3.reason === 'launched', { reason: r3 && r3.reason });
      ok('K3_qfr_spawn_once', c3.spawns.length === 1);
      // K4：载荷缺失 → 无法比对，按旧判据放行（already-installed）。
      const c4 = makeCtx({ lockInstalled: true, leaExe: true, leaClient: true, leaVer: true, payloadPresent: false });
      ok('K4_no_payload_installed', vm.runInContext('leaServiceInstalled()', c4.sandbox) === true);
      const r4 = await run(c4);
      ok('K4_no_payload_already', r4 && r4.ok === true && r4.reason === 'already-installed', { reason: r4 && r4.reason });
      ok('K4_no_payload_no_spawn', c4.spawns.length === 0);
      // K5：live 比随包新（用户降级应用）→ 同样判未装、与运行中应用对齐。
      const c5 = makeCtx({ lockInstalled: true, leaExe: true, leaClient: true, leaVer: true, payloadPresent: true, liveQfr: 'live-QFRLEA-vNEXT', liveUsh: 'live-USH-vNEXT' });
      ok('K5_newer_live_uninstalled', vm.runInContext('leaServiceInstalled()', c5.sandbox) === false);
      const r5 = await run(c5);
      ok('K5_newer_live_launched', r5 && r5.ok === true && r5.reason === 'launched', { reason: r5 && r5.reason });
      // K6：打包态（execPath 旁 LEA/）：一致 → 已装；USH 不同 → launched。
      const pkgExec = path.join(tmp, 'QFRemote.exe');
      const c6 = makeCtx({ lockInstalled: true, leaExe: true, leaClient: true, leaVer: true, packaged: true, execPath: pkgExec, payloadPresent: true });
      ok('K6a_pkg_match_installed', vm.runInContext('leaServiceInstalled()', c6.sandbox) === true);
      const r6 = await run(c6);
      ok('K6a_pkg_match_already', r6 && r6.ok === true && r6.reason === 'already-installed', { reason: r6 && r6.reason });
      ok('K6a_pkg_match_no_spawn', c6.spawns.length === 0);
      const c7 = makeCtx({ lockInstalled: true, leaExe: true, leaClient: true, leaVer: true, packaged: true, execPath: pkgExec, payloadPresent: true, liveUsh: 'live-USH-r10' });
      ok('K6b_pkg_mismatch_uninstalled', vm.runInContext('leaServiceInstalled()', c7.sandbox) === false);
      const r7 = await run(c7);
      ok('K6b_pkg_mismatch_launched', r7 && r7.ok === true && r7.reason === 'launched', { reason: r7 && r7.reason });
      ok('K6b_pkg_mismatch_spawn_once', c7.spawns.length === 1);
      // K7：live qf-lea-client.exe 哈希不同 → 未装 → launched 补装。
      const c8 = makeCtx({ lockInstalled: true, leaExe: true, leaClient: true, leaVer: true, payloadPresent: true, liveClient: 'live-qf-client-r10' });
      ok('K7_client_mismatch_uninstalled', vm.runInContext('leaServiceInstalled()', c8.sandbox) === false);
      ok('K7_client_mismatch_log', c8.bootLogs.some((l) => l === 'system-services.lea-hash-mismatch:qf-lea-client.exe'));
      const r8 = await run(c8);
      ok('K7_client_launched', r8 && r8.ok === true && r8.reason === 'launched', { reason: r8 && r8.reason });
      ok('K7_client_spawn_once', c8.spawns.length === 1);
      // K8：live QFUserHelper.exe 文件缺失 → 未装 → launched 补装。
      const c9 = makeCtx({ lockInstalled: true, leaExe: true, leaClient: true, leaVer: true, payloadPresent: true, liveUshPresent: false });
      ok('K8_live_ush_missing_uninstalled', vm.runInContext('leaServiceInstalled()', c9.sandbox) === false);
      ok('K8_live_ush_missing_log', c9.bootLogs.some((l) => l === 'system-services.lea-hash-mismatch:QFUserHelper.exe'));
      const r9 = await run(c9);
      ok('K8_live_ush_missing_launched', r9 && r9.ok === true && r9.reason === 'launched', { reason: r9 && r9.reason });
      ok('K8_live_ush_missing_spawn_once', c9.spawns.length === 1);
      // K9：随包 USH 存在但读失败 → 单记 pkg-hash-read-error 并跳过该件，
      // 其余件一致 → 已装，不误触发补装。
      const c10 = makeCtx({ lockInstalled: true, leaExe: true, leaClient: true, leaVer: true, payloadPresent: true, pkgReadFail: ['QFUserHelper.exe'] });
      ok('K9_pkg_read_fail_installed', vm.runInContext('leaServiceInstalled()', c10.sandbox) === true);
      ok('K9_pkg_read_fail_log', c10.bootLogs.some((l) => l === 'system-services.lea-pkg-hash-read-error:QFUserHelper.exe'));
      const r10 = await run(c10);
      ok('K9_pkg_read_fail_already', r10 && r10.ok === true && r10.reason === 'already-installed', { reason: r10 && r10.reason });
      ok('K9_pkg_read_fail_no_spawn', c10.spawns.length === 0);
    }

    // ---- L. r12 守门键：版本 OR 载荷签名 ----
    {
      const sig = (q, cl, u) => [sha256(Buffer.from(q)), sha256(Buffer.from(cl)), sha256(Buffer.from(u))].join(':');
      const curSig = sig('live-QFRLEA-r11', 'live-qf-client-r11', 'live-USH-r11');
      const r10Sig = sig('live-QFRLEA-r10', 'live-qf-client-r10', 'live-USH-r10');
      // L1：同版本＋同载荷签名 → tried-this-version，不拉起。
      const c = makeCtx({ lockInstalled: true, leaExe: true, leaClient: true, leaVer: true, payloadPresent: true, prevVersion: '3.0.0', prevPayload: curSig });
      const r = await run(c);
      ok('L1_same_sig_tried', r && r.ok === false && r.reason === 'tried-this-version', { reason: r && r.reason });
      ok('L1_same_sig_no_spawn', c.spawns.length === 0);
      // L2：同版本＋载荷签名变 → 放行检查（live 一致 → already-installed，
      // 且 triedPayload 已刷新为新签名）。
      const c2 = makeCtx({ lockInstalled: true, leaExe: true, leaClient: true, leaVer: true, payloadPresent: true, prevVersion: '3.0.0', prevPayload: r10Sig });
      const r2 = await run(c2);
      ok('L2_changed_sig_already', r2 && r2.ok === true && r2.reason === 'already-installed', { reason: r2 && r2.reason });
      ok('L2_changed_sig_no_spawn', c2.spawns.length === 0);
      ok('L2_sig_recorded', c2.sandbox.settings.systemServicesTriedPayload === curSig);
      // L3：同版本＋旧设置无 triedPayload（r11 机器首启 r12）＋live USH
      // 不同 → 放行 → launched 补装。
      const c3 = makeCtx({ lockInstalled: true, leaExe: true, leaClient: true, leaVer: true, payloadPresent: true, prevVersion: '3.0.0', prevPayload: undefined, liveUsh: 'live-USH-r10' });
      const r3 = await run(c3);
      ok('L3_legacy_no_sig_launched', r3 && r3.ok === true && r3.reason === 'launched', { reason: r3 && r3.reason });
      ok('L3_legacy_no_sig_spawn_once', c3.spawns.length === 1);
      // L4：载荷缺失无法签名＋同版本 → 退回只比版本 → tried-this-version。
      const c4 = makeCtx({ lockInstalled: true, leaExe: true, leaClient: true, leaVer: true, payloadPresent: false, prevVersion: '3.0.0' });
      const r4 = await run(c4);
      ok('L4_no_payload_tried', r4 && r4.ok === false && r4.reason === 'tried-this-version', { reason: r4 && r4.reason });
      ok('L4_no_payload_no_spawn', c4.spawns.length === 0);
      // L5：owner UAC 在飞 defer 时 triedPayload 随 triedVersion 一并恢复。
      const c5 = makeCtx({ lockInstalled: true, leaExe: false, leaVer: false, ownerUac: true, prevVersion: '3.0.0', prevPayload: 'old-sig', payloadPresent: true });
      const r5 = await run(c5);
      ok('L5_deferred', r5 && r5.ok === false && r5.reason === 'owner-uac-pending', { reason: r5 && r5.reason });
      ok('L5_payload_restored', c5.sandbox.settings.systemServicesTriedPayload === 'old-sig');
      ok('L5_version_restored', c5.sandbox.settings.systemServicesTriedVersion === '3.0.0');
      // L6：部分载荷（缺 client）＋同版本＋签名与在位两件一致 →
      // tried-this-version（签名逐项跳过，与比对循环同语义）。
      const partialSig = [sha256(Buffer.from('live-QFRLEA-r11')), sha256(Buffer.from('live-USH-r11'))].join(':');
      const c6 = makeCtx({ lockInstalled: true, leaExe: true, leaClient: true, leaVer: true, payloadPresent: true, pkgOmit: ['qf-lea-client.exe'], prevVersion: '3.0.0', prevPayload: partialSig });
      const r6 = await run(c6);
      ok('L6_partial_sig_tried', r6 && r6.ok === false && r6.reason === 'tried-this-version', { reason: r6 && r6.reason });
      ok('L6_partial_sig_no_spawn', c6.spawns.length === 0);
      // L7：部分载荷（缺 client）＋同版本＋旧签名为三件全量 → 签名变 →
      // 放行检查（live 在位件一致 → already-installed）。
      const c7 = makeCtx({ lockInstalled: true, leaExe: true, leaClient: true, leaVer: true, payloadPresent: true, pkgOmit: ['qf-lea-client.exe'], prevVersion: '3.0.0', prevPayload: curSig });
      const r7 = await run(c7);
      ok('L7_partial_sig_changed_already', r7 && r7.ok === true && r7.reason === 'already-installed', { reason: r7 && r7.reason });
      ok('L7_partial_sig_changed_no_spawn', c7.spawns.length === 0);
    }

    // ---- B7. 文件齐全但服务未注册 → 仍补装（Q1 保守方向） ----
    {
      const c = makeCtx({ lockInstalled: true, leaExe: true, leaClient: true, leaVer: true, svcRegistered: false });
      const r = await run(c);
      ok('B7_launched', r && r.ok === true && r.reason === 'launched', { reason: r && r.reason });
      ok('B8_spawn_once', c.spawns.length === 1);
    }

    // ---- J. F1 打包形态：-LeaDir 显式传 $INSTDIR\LEA；开发态不传 ----
    {
      const pkgExec = path.join(tmp, 'QFRemote.exe');
      const pkgLeaDir = path.join(tmp, 'LEA');
      const c = makeCtx({ lockInstalled: true, leaExe: false, leaVer: false, packaged: true, execPath: pkgExec });
      const r = await run(c);
      ok('J1_pkg_launched', r && r.ok === true && r.reason === 'launched', { reason: r && r.reason });
      const argStr = c.spawns.length ? c.spawns[0].args.join(' ') : '';
      ok('J2_pkg_lea_dir', argStr.includes("'-LeaDir'") && argStr.includes(pkgLeaDir));
      ok('J3_pkg_hash', argStr.includes('-LeaScriptHash') && argStr.includes(leaHash));
      const cDev = makeCtx({ lockInstalled: true, leaExe: false, leaVer: false });
      await run(cDev);
      const devArgs = cDev.spawns.length ? cDev.spawns[0].args.join(' ') : '';
      ok('J4_dev_no_lea_dir', !devArgs.includes("'-LeaDir'"));
      const cTam = makeCtx({ lockInstalled: true, leaExe: false, leaVer: false, packaged: true, execPath: pkgExec, tamperPkgLea: true });
      const rTam = await run(cTam);
      ok('J5_pkg_tampered', rTam && rTam.ok === false && rTam.reason === 'hash-mismatch', { reason: rTam && rTam.reason });
      ok('J6_pkg_tampered_no_spawn', cTam.spawns.length === 0);
      fs.writeFileSync(P.pkgLeaPs1, leaOrig);
    }

    // ---- J7. asar 解包映射单元断言 ----
    {
      const c = makeCtx({ lockInstalled: false });
      const asarPs1 = path.join(tmp, 'app.asar', 'install-system-services.ps1');
      const unpPs1 = path.join(tmp, 'app.asar.unpacked', 'install-system-services.ps1');
      ok('J7a_unpack_transform', vm.runInContext('unpackedAppPath(' + JSON.stringify(asarPs1) + ')', c.sandbox) === unpPs1);
      ok('J7b_unpack_idempotent', vm.runInContext('unpackedAppPath(' + JSON.stringify(unpPs1) + ')', c.sandbox) === unpPs1);
      ok('J7c_unpack_passthrough', vm.runInContext('unpackedAppPath(' + JSON.stringify(path.join(tmp, 'x.ps1')) + ')', c.sandbox) === path.join(tmp, 'x.ps1'));
      const c2 = makeCtx({ lockInstalled: false, extraPresent: new Set([unpPs1]) });
      ok('J7d_prefer_unpacked', vm.runInContext('preferUnpackedPath(' + JSON.stringify(asarPs1) + ')', c2.sandbox) === unpPs1);
      const c3 = makeCtx({ lockInstalled: false });
      ok('J7e_prefer_raw_when_absent', vm.runInContext('preferUnpackedPath(' + JSON.stringify(asarPs1) + ')', c3.sandbox) === asarPs1);
    }

    // ---- H. owner UAC 在飞 → 本轮 defer，下次登录收敛补装（Q4 串行化） ----
    {
      const c = makeCtx({ lockInstalled: true, ownerUac: true });
      const r1 = await run(c);
      ok('H1_deferred', r1 && r1.ok === false && r1.reason === 'owner-uac-pending', { reason: r1 && r1.reason });
      ok('H2_no_spawn', c.spawns.length === 0);
      ok('H3_log_deferred', c.bootLogs.some((l) => l.startsWith('system-services.lea-backfill-deferred')));
      ok('H4_guard_restored', c.sandbox.settings.systemServicesTriedVersion === '2.4.4');
      const r2 = await run(c);
      ok('H5_retry_launched', r2 && r2.ok === true && r2.reason === 'launched', { reason: r2 && r2.reason });
      ok('H6_retry_spawn', c.spawns.length === 1);
    }

    // ---- I. 补装结果日志（Q3.2） ----
    {
      const c = makeCtx({ lockInstalled: true, tamperLea: true });
      const r = await run(c);
      ok('I1_fail_log', r && r.reason === 'hash-mismatch'
        && c.bootLogs.some((l) => l === 'system-services.lea-backfill-failed:hash-mismatch'));
      fs.writeFileSync(P.leaPs1, leaOrig);
      const c2 = makeCtx({ lockInstalled: true, leaExe: true, leaClient: true, leaVer: true });
      await run(c2);
      ok('I2_no_backfill_logs', !c2.bootLogs.some((l) => l.startsWith('system-services.lea-backfill')));
    }

    // ---- E. 补装路径哈希篡改 → fail-closed ----
    {
      const c = makeCtx({ lockInstalled: true, tamperLea: true });
      const r = await run(c);
      ok('E1_hash_mismatch', r && r.ok === false && r.reason === 'hash-mismatch', { reason: r && r.reason });
      ok('E2_no_spawn', c.spawns.length === 0);
      fs.writeFileSync(P.leaPs1, leaOrig);
    }

    // ---- F. 全新安装／守门／force ----
    {
      const c = makeCtx({ lockInstalled: false });
      const r = await run(c);
      ok('F1_fresh_launched', r && r.ok === true && r.reason === 'launched');
      ok('F2_fresh_spawn', c.spawns.length === 1);
      const r2 = await run(c);
      ok('F3_already_tried', r2 && r2.ok === false && r2.reason === 'already-tried', { reason: r2 && r2.reason });
      ok('F4_still_one_spawn', c.spawns.length === 1);
      const r3 = await run(c, true);
      ok('F5_force_launched', r3 && r3.ok === true && r3.reason === 'launched');
      ok('F6_force_second_spawn', c.spawns.length === 2);
    }

    // ---- G. 白名单闭环实盘核对（探针，只记录，不门禁：见文件头） ----
    {
      const realLea = path.join(__dirname, '..', 'install-lea.ps1');
      const realWl = sh.loadWhitelist({ resourcesPath: '', dirname: path.join(__dirname, '..', 'syshelper') });
      const realHash = sha256(fs.readFileSync(realLea));
      ok('G1_wl_has_entry', !!(realWl && realWl.files && typeof realWl.files['install-lea.ps1'] === 'string'), { gating: false });
      ok('G2_wl_matches_disk', !!(realWl && realWl.files && realWl.files['install-lea.ps1'] === realHash),
        { wl: realWl && realWl.files && realWl.files['install-lea.ps1'], disk: realHash, gating: false });
      ok('G3_verify_real', sh.verifyFileHash(realLea, realWl) === true, { gating: false });
    }

    // ---- P1. 探针（非门禁）：拉起成功行本身无 backfill 打标 ----
    // 拉起块（M-C DS-6 在制品）记既有日志，本线未动该块；排障按序对上
    // lea-missing 行。记录现状，不判失败。
    {
      const c = makeCtx({ lockInstalled: true, leaExe: false, leaVer: false });
      await run(c);
      ok('P1_launch_tag', c.bootLogs.some((l) => l.startsWith('system-services.lea-backfill-launched')),
        { gating: false, note: 'expected-absent: launch outcome tagged only by sequence correlation (see file header)' });
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
