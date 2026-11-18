'use strict';
/*
 * r10 触发器证据缺口 1（windows/main.js bootLog）本地自检：
 *  B1. 主路径可写 → 行写进 %TEMP%\qfremote-boot.log，bootLogPath() 返回该路径；
 *  B2. 主路径追加失败 → 改写 userData\logs\qfremote-boot.log，并先记一行
 *      bootlog-fallback 标明主路径失败；bootLogPath() 返回 fallback 路径；
 *  B3. fallback 标记行全进程只记一次；
 *  B4. 主路径恢复后 → 下一行回到主路径，bootLogPath() 跟回主路径；
 *  B5. 主路径与 fallback 双双失败 → bootLog 不抛错、不影响启动；
 *  B6. 源码级：whenReady.begin 之后有 bootlog.path 一行（把解析后的实际
 *      路径打出来，验证者按行取路径）；bootLogPath 返回最近一次写成功的
 *      实际路径。
 * 手段：从 main.js 原文按花括号配对抽取 bootLog／bootLogPath 两段真实函数
 * 文本，在 vm 沙箱里跑（fake fs／os／app），不复制逻辑。%TEMP% 用管理员
 * 控制台会话的 per-session 目录（Temp\1）作夹具——这正是 r9 查错目录
 * 的根因。结果写 JSON 到 QFTEST_OUT，退出码 0=通过。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const OUT = process.env.QFTEST_OUT || '/tmp/qfr300/r10-bootlog-fallback-result.json';
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

// 夹具：管理员控制台会话的 per-session %TEMP%（r9 查错目录的根因）。
const TMP = 'C:\\Users\\Administrator\\AppData\\Local\\Temp\\1';
const USERDATA = 'C:\\Users\\Administrator\\AppData\\Roaming\\QFRemote';
const PRIMARY = path.join(TMP, 'qfremote-boot.log');
const FALLBACK = path.join(path.join(USERDATA, 'logs'), 'qfremote-boot.log');

function makeSandbox() {
  const writes = {}; // path -> [lines]
  const state = { primaryFail: false, fallbackFail: false, getPathThrows: false, mkdirCalls: [] };
  const fakeFs = {
    appendFileSync: (p, data) => {
      if (p === PRIMARY && state.primaryFail) throw new Error('EPERM primary');
      if (p === FALLBACK && state.fallbackFail) throw new Error('EPERM fallback');
      (writes[p] = writes[p] || []).push(String(data));
    },
    mkdirSync: (d) => { state.mkdirCalls.push(d); },
  };
  const fakeOs = { tmpdir: () => TMP };
  const fakeApp = { getPath: (n) => {
    if (state.getPathThrows) throw new Error('no app');
    return n === 'userData' ? USERDATA : '';
  } };
  // A16-S2：bootLog 改走 testPolicy.bootLogFileName()；沙箱镜像生产值
  //（抽取函数引用它，断言仍按生产文件名 qfremote-boot.log）。
  const sandbox = { fs: fakeFs, os: fakeOs, path, app: fakeApp, console,
    testPolicy: { bootLogFileName: () => 'qfremote-boot.log' } };
  const prelude = 'let bootLogLastPath = \'\';\nlet bootLogFallbackNoted = false;\n';
  const code = prelude + extractFunction(MAIN_SRC, 'bootLog') + '\n' + extractFunction(MAIN_SRC, 'bootLogPath');
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return { sandbox, writes, state };
}

(async () => {
  try {
    // ---- B6 源码级防 stale 断言 ----
    const bootLogSrc = extractFunction(MAIN_SRC, 'bootLog');
    const bootLogPathSrc = extractFunction(MAIN_SRC, 'bootLogPath');
    ok('B6_source', MAIN_SRC.includes("bootLog('bootlog.path', bootLogPath())")
      && bootLogSrc.includes('bootlog-fallback')
      && bootLogSrc.includes("app.getPath('userData')")
      && bootLogSrc.includes('bootLogLastPath')
      && bootLogPathSrc.includes('bootLogLastPath')
      && MAIN_SRC.includes("bootLog('whenReady.begin'"));

    // ---- B1 主路径可写 ----
    const s1 = makeSandbox();
    s1.sandbox.bootLog('whenReady.begin', 'version=3.0.0');
    s1.sandbox.bootLog('bootlog.path', s1.sandbox.bootLogPath());
    const p1 = s1.writes[PRIMARY] || [];
    ok('B1_primary', p1.length === 2
      && p1[0].includes('whenReady.begin')
      && p1[1].includes('bootlog.path') && p1[1].includes(PRIMARY)
      && s1.sandbox.bootLogPath() === PRIMARY
      && !(FALLBACK in s1.writes), { primaryLines: p1.length });

    // ---- B2 主路径失败 → fallback＋标记行；B3 标记只记一次 ----
    const s2 = makeSandbox();
    s2.state.primaryFail = true;
    s2.sandbox.bootLog('whenReady.begin', 'version=3.0.0');
    s2.sandbox.bootLog('a', '1');
    s2.sandbox.bootLog('b', '2');
    const f2 = s2.writes[FALLBACK] || [];
    const noteCount = f2.filter((l) => l.includes('bootlog-fallback')).length;
    ok('B2_fallback', f2.length === 4
      && f2[0].includes('bootlog-fallback') && f2[0].includes('primary-tmpdir-unwritable')
      && f2[1].includes('whenReady.begin')
      && s2.sandbox.bootLogPath() === FALLBACK
      && !(PRIMARY in s2.writes)
      && s2.state.mkdirCalls.length >= 1, { fallbackLines: f2.length });
    ok('B3_note_once', noteCount === 1, { noteCount });

    // ---- B4 主路径恢复 → 回主路径 ----
    s2.state.primaryFail = false;
    s2.sandbox.bootLog('recovered', 'yes');
    const p4 = s2.writes[PRIMARY] || [];
    ok('B4_recover', p4.length === 1 && p4[0].includes('recovered')
      && s2.sandbox.bootLogPath() === PRIMARY, { primaryLines: p4.length });

    // ---- B5 双路失败不抛错 ----
    const s5 = makeSandbox();
    s5.state.primaryFail = true;
    s5.state.fallbackFail = true;
    s5.state.getPathThrows = true;
    let threw = false;
    try { s5.sandbox.bootLog('x', 'y'); s5.sandbox.bootLogPath(); } catch (e) { threw = true; }
    ok('B5_both_fail_silent', !threw && Object.keys(s5.writes).length === 0, { threw });

    result.pass = Object.values(result.cases).every((c) => c.pass);
  } catch (e) {
    result.error = String(e && e.stack || e);
    result.pass = false;
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.pass ? 0 : 1);
})();
