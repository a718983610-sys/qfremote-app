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
    const fns = ['lockComponentSourceDir', 'lockServiceInstalled', 'leaServiceInstalled', 'maybeInstallSystemServices']
      .map((n) => extractFunction(MAIN_SRC, n)).join('\n');
    ok('X0_extract', fns.includes('leaServiceInstalled()') && fns.includes('LEA_DEGRADED')
      && fns.includes('system-services.lea-missing') && fns.includes('lea-backfill-deferred')
      && fns.includes('sc.exe') && fns.includes('qf-lea-client.exe'));

    // ---- 夹具：四件被验文件＋白名单落在真临时目录（__dirname 即该目录），
    //      走真 sys-helper loadWhitelist／verifyFileHash ----
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lea-backfill-'));
    const P = {};
    P.sysPs1 = path.join(tmp, 'install-system-services.ps1');
    P.helperExe = path.join(tmp, 'syshelper', 'QFSysHelper.exe');
    P.installPs1 = path.join(tmp, 'privacy-lock', 'install.ps1');
    P.leaPs1 = path.join(tmp, 'syshelper', 'LEA', 'install-lea.ps1');
    P.wlJson = path.join(tmp, 'syshelper', 'whitelist.json');
    for (const p of [P.sysPs1, P.helperExe, P.installPs1, P.leaPs1]) {
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
        tamperLea: false,
      }, opts || {});
      if (o.tamperLea) fs.writeFileSync(P.leaPs1, 'tampered\n');
      else fs.writeFileSync(P.leaPs1, leaOrig);
      const present = new Set();
      if (o.lockInstalled) present.add(W.lockDevice);
      if (o.leaExe) present.add(W.leaExe);
      if (o.leaClient) present.add(W.leaClient);
      if (o.leaVer) present.add(W.leaVer);
      if (o.leaDegraded) present.add(W.leaDegraded);
      const fakeFs = {
        // 夹具四件＋白名单走真磁盘；Windows 落盘态走场景集合；其余一律 false
        //（尤其 resourcesPath 为空时拼出的相对路径 'QFSysHelper.exe'，不得
        // 随 cwd 抖动）。
        existsSync: (p) => {
          if (present.has(p)) return true;
          if (p === P.sysPs1 || p === P.helperExe || p === P.installPs1 || p === P.leaPs1 || p === P.wlJson) return true;
          if (p === 'QFSysHelper.exe') return false;
          return false;
        },
        readFileSync: (p, enc) => fs.readFileSync(p, enc),
      };
      const spawns = [];
      const spawnSyncCalls = [];
      const bootLogs = [];
      let syncCalls = 0;
      const sandbox = {
        __dirname: tmp,
        process: { platform: 'win32', env: { ProgramFiles: PF, ProgramData: PD }, resourcesPath: '', execPath: 'C:\\QFRemote\\QFRemote.exe' },
        app: { isPackaged: false, getVersion: () => o.appVersion },
        settings: { systemServicesTriedVersion: o.prevVersion },
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

    // ---- B7. 文件齐全但服务未注册 → 仍补装（Q1 保守方向） ----
    {
      const c = makeCtx({ lockInstalled: true, leaExe: true, leaClient: true, leaVer: true, svcRegistered: false });
      const r = await run(c);
      ok('B7_launched', r && r.ok === true && r.reason === 'launched', { reason: r && r.reason });
      ok('B8_spawn_once', c.spawns.length === 1);
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
