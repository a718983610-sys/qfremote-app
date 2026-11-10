'use strict';
/*
 * M-C 中组（pkg4 DS-5／DS-6）本地自检：windows/main.js maybeInstallSystemServices
 *  DS-5：白名单校验抛异常即 fail-closed（return hash-mismatch），绝不继续提权拉起。
 *        注：该 catch 在 HEAD（H20 同改）已是 return，本文件以行为断言钉死，防回归。
 *  DS-6：① sysPs1 单独必须存在（installPs1 在、sysPs1 缺失也报 no-component）；
 *        ② spawn 后等结果、读 exit 码：exit 0 才算成功，非零／error／超时即报错。
 * 手段：与 update-lea-backfill-test.js 同款——从 main.js 原文按花括号配对抽取
 * 真实函数文本，在 vm 沙箱里跑（fake process/app，spawn 桩为可观测子进程），
 * 不复制逻辑；被验四件文件＋白名单落在真临时目录、走真 sys-helper
 * loadWhitelist／verifyFileHash。结果写 JSON 到 QFTEST_OUT，退出码 0=通过。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const vm = require('vm');
const { EventEmitter } = require('events');
const sh = require('../sys-helper');

const OUT = process.env.QFTEST_OUT || '/tmp/qfr300/mc-midgroup-result.json';
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
    // F1 回填：maybeInstallSystemServices 经 preferUnpackedPath／unpackedAppPath
    // 取脚本路径（打包形态解包路径），不抽取即 ReferenceError——与
    // update-lea-backfill-test.js 同款抽取清单。
    const fns = ['lockComponentSourceDir', 'lockServiceInstalled', 'waitInstallResult', 'maybeInstallSystemServices', 'unpackedAppPath', 'preferUnpackedPath']
      .map((n) => extractFunction(MAIN_SRC, n)).join('\n');
    const constM = MAIN_SRC.match(/const INSTALL_WAIT_MS = \d+;/);
    if (!constM) throw new Error('INSTALL_WAIT_MS not found');
    const code = constM[0] + '\n' + fns;
    ok('X0_extract', code.includes('waitInstallResult') && code.includes('INSTALL_WAIT_MS'));

    // ---- 夹具：四件被验文件＋白名单落在真临时目录，走真 sys-helper ----
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-midgroup-'));
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
    const wlObj = { files: {
      'QFSysHelper.exe': sha256(fs.readFileSync(P.helperExe)),
      'install-lea.ps1': sha256(fs.readFileSync(P.leaPs1)),
      'install-system-services.ps1': sha256(fs.readFileSync(P.sysPs1)),
      'install.ps1': sha256(fs.readFileSync(P.installPs1)),
    }, version: '3.0.0' };
    fs.writeFileSync(P.wlJson, JSON.stringify(wlObj, null, 2));
    const leaOrig = fs.readFileSync(P.leaPs1);

    const PF = 'C:\\Program Files';
    const PD = 'C:\\ProgramData';
    const W = {
      lockDevice: path.join(PF, 'QFRemote', 'Lock', 'device.json'),
      leaExe: path.join(PF, 'QFR', 'LEA', 'QFRLEA.exe'),
      leaVer: path.join(PF, 'QFR', 'LEA', 'version.json'),
      leaDegraded: path.join(PD, 'QFR', 'LEA', 'LEA_DEGRADED'),
    };

    // spawn 行为由外层控制：{ kind: 'close', code } | { kind: 'error', error } |
    // { kind: 'never' }（永不 close，测超时）| { kind: 'unobserved' }（无流 stub）
    let spawnBehavior = { kind: 'close', code: 0 };
    function fakeSpawn() {
      if (spawnBehavior.kind === 'unobserved') return { on: () => {} };
      const ch = new EventEmitter();
      ch.stdout = new EventEmitter();
      ch.stderr = new EventEmitter();
      ch.kill = () => {};
      if (spawnBehavior.kind === 'close') {
        const c = spawnBehavior.code;
        setImmediate(() => ch.emit('close', c));
      } else if (spawnBehavior.kind === 'error') {
        setImmediate(() => ch.emit('error', spawnBehavior.error || new Error('spawn ENOENT')));
      } else if (spawnBehavior.kind === 'stderr-close') {
        setImmediate(() => { ch.stderr.emit('data', Buffer.from('boom-detail')); ch.emit('close', 1); });
      } else if (spawnBehavior.kind === 'error-then-close') {
        // error 后 close 再来：只决议一次（error 胜出，不被 close 覆盖）
        setImmediate(() => { ch.emit('error', new Error('spawn ENOENT')); ch.emit('close', 1); });
      }
      return ch;
    }

    function makeCtx(opts) {
      const o = Object.assign({
        lockInstalled: false, sysPs1Present: true, installPs1Present: true,
        throwWhitelist: false, tamperLea: false, appVersion: '3.0.0', prevVersion: '2.4.4',
      }, opts || {});
      if (o.tamperLea) fs.writeFileSync(P.leaPs1, 'tampered\n');
      else fs.writeFileSync(P.leaPs1, leaOrig);
      const present = new Set();
      if (o.lockInstalled) present.add(W.lockDevice);
      const fakeFs = {
        existsSync: (p) => {
          if (present.has(p)) return true;
          if (p === P.sysPs1) return !!o.sysPs1Present;
          if (p === P.installPs1) return !!o.installPs1Present;
          if (p === P.helperExe || p === P.leaPs1 || p === P.wlJson) return true;
          if (p === 'QFSysHelper.exe') return false;
          return false;
        },
        readFileSync: (p, enc) => fs.readFileSync(p, enc),
      };
      const spawns = [];
      const bootLogs = [];
      const sysHelper = o.throwWhitelist
        ? Object.assign({}, sh, { loadWhitelist: () => { throw new Error('whitelist boom'); } })
        : sh;
      const sandbox = {
        __dirname: tmp,
        process: { platform: 'win32', env: { ProgramFiles: PF, ProgramData: PD }, resourcesPath: '', execPath: 'C:\\QFRemote\\QFRemote.exe' },
        app: { isPackaged: false, getVersion: () => o.appVersion },
        settings: { systemServicesTriedVersion: o.prevVersion },
        saveSettings: () => {},
        currentGateUsername: () => '718983610',
        bootLog: (tag, detail) => { bootLogs.push(tag + (detail ? ':' + detail : '')); },
        syncLockOwner: async () => ({ ok: true, changed: false, uacDispatched: false }),
        sysHelper,
        fs: fakeFs,
        path,
        setTimeout, clearTimeout,
        require: (name) => {
          if (name === 'child_process') {
            return { spawn: (file, args, opts2) => { spawns.push({ file, args: args.slice(), opts: opts2 }); return fakeSpawn(); } };
          }
          throw new Error('unexpected require: ' + name);
        },
        console,
      };
      vm.createContext(sandbox);
      vm.runInContext('let systemServicesInstallTried = false;\n' + code, sandbox);
      return { sandbox, spawns, bootLogs, o };
    }
    const run = async (ctx, force) => vm.runInContext(
      'maybeInstallSystemServices(' + (force ? 'true' : '') + ')', ctx.sandbox);

    // ---- DS-5：白名单校验抛异常 → fail-closed，零拉起 ----
    {
      const c = makeCtx({ throwWhitelist: true });
      spawnBehavior = { kind: 'close', code: 0 };
      const r = await run(c);
      ok('D5_throw_fail_closed', r && r.ok === false && r.reason === 'hash-mismatch', { reason: r && r.reason });
      ok('D5_throw_no_spawn', c.spawns.length === 0);
      ok('D5_throw_logged', c.bootLogs.some((l) => l.startsWith('system-services.whitelist-throw')));
    }
    // DS-5 补（复审 round 1）：verifyFileHash 返回 false（文件被篡改）同样
    // fail-closed——该分支是“不匹配即拒绝”的主要路径，不只抛异常路径。
    {
      const c = makeCtx({ tamperLea: true });
      spawnBehavior = { kind: 'close', code: 0 };
      const r = await run(c);
      ok('D5_mismatch_fail_closed', r && r.ok === false && r.reason === 'hash-mismatch', { reason: r && r.reason });
      ok('D5_mismatch_no_spawn', c.spawns.length === 0);
      fs.writeFileSync(P.leaPs1, leaOrig);
    }

    // ---- DS-6①：sysPs1 缺失（installPs1 在）→ no-component，零拉起 ----
    {
      const c = makeCtx({ sysPs1Present: false, installPs1Present: true });
      spawnBehavior = { kind: 'close', code: 0 };
      const r = await run(c);
      ok('D6_sysps1_missing_no_component', r && r.ok === false && r.reason === 'no-component', { reason: r && r.reason });
      ok('D6_sysps1_missing_no_spawn', c.spawns.length === 0);
    }
    // installPs1 缺失、sysPs1 在 → 仍可拉起（installPs1 缺失可容忍）
    {
      const c = makeCtx({ sysPs1Present: true, installPs1Present: false });
      spawnBehavior = { kind: 'close', code: 0 };
      const r = await run(c);
      ok('D6_installps1_optional', r && r.ok === true && r.reason === 'launched' && c.spawns.length === 1, { reason: r && r.reason });
    }

    // ---- DS-6②：等结果、读 exit 码 ----
    {
      const c = makeCtx({});
      spawnBehavior = { kind: 'close', code: 0 };
      const r = await run(c);
      ok('D6_exit0_launched', r && r.ok === true && r.reason === 'launched', { reason: r && r.reason });
      ok('D6_exit0_spawn_once', c.spawns.length === 1);
    }
    {
      const c = makeCtx({});
      spawnBehavior = { kind: 'stderr-close' };
      const r = await run(c);
      ok('D6_exit1_failed', r && r.ok === false && r.reason === 'install-failed', { reason: r && r.reason });
      ok('D6_exit1_logs_stderr', c.bootLogs.some((l) => l.startsWith('system-services.install-failed') && l.includes('boom-detail')));
    }
    {
      const c = makeCtx({});
      spawnBehavior = { kind: 'error', error: new Error('spawn ENOENT') };
      const r = await run(c);
      ok('D6_spawn_error_launch_failed', r && r.ok === false && r.reason === 'launch-failed', { reason: r && r.reason });
    }
    // error 后 close 再来：只决议一次（error 胜出，不被后到的 close 覆盖）
    {
      const c = makeCtx({});
      spawnBehavior = { kind: 'error-then-close' };
      const r = await run(c);
      ok('D6_error_then_close_once', r && r.ok === false && r.reason === 'launch-failed', { reason: r && r.reason });
    }
    // 超时：waitInstallResult 直接调，短超时
    {
      const c = makeCtx({});
      const ch = new EventEmitter();
      ch.stdout = new EventEmitter(); ch.stderr = new EventEmitter(); ch.kill = () => {};
      const r = await vm.runInContext('waitInstallResult(__ch, 30)', Object.assign(c.sandbox, { __ch: ch }));
      ok('D6_wait_timeout', r && r.timedOut === true);
    }
    // 无流子进程（B 线测试同款 stub）→ 退回 launched，不挂死
    {
      const c = makeCtx({});
      spawnBehavior = { kind: 'unobserved' };
      const r = await run(c);
      ok('D6_unobserved_fallback', r && r.ok === true && r.reason === 'launched', { reason: r && r.reason });
      ok('D6_unobserved_logged', c.bootLogs.some((l) => l.startsWith('system-services.launched-unobserved')));
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
