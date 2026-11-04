'use strict';
/*
 * 2.4.1 客户端版本头（x-qf-client-version）专项自检：
 *  A. client-version.js 纯逻辑：头名常量、回落版本＝package.json 版本、
 *     setClientVersion 合法/非法、headers 生成、withClientVersion 不覆盖
 *     已有同名头、函数形态来源解析；
 *  B. 真链路抓头（本地假服务记录请求头）：
 *     B1 update.js 清单 GET 带头且值＝注入的运行时版本；
 *     B2 update.js 安装包下载 GET 带头；
 *     B3 autologin httpSilentLogin（POST）带头；
 *     B4 autologin httpProbeSession（GET）带头；
 *     B5 lock.js 真桥（本地自签 HTTPS）带头；
 *  C. 静态接线证据：main.js 的 extRequest 出口、会话 onBeforeSendHeaders、
 *     setClientVersion(app.getVersion()) 注入、lockBridge 传参；头名只在
 *     client-version.js 一处定义（其余文件只引用、不自拼）；
 *  D. 待更标记新版首启自动清除的代码证据：dropStalePending 的版本比较
 *     与 startupUpdateGate 首行调用、clearPendingUpdate 落点；
 *  E. 安装器静态证据：.onInstSuccess＋IfSilent＋Exec 拉起、版本串 2.4.1、
 *     交互完成页 MUI_FINISHPAGE_RUN 原样保留；
 *  F. 强更墙形态守卫（#40/#40-补/#42）：force-update.html 的 releaseBtn
 *     放行口、main.js 的 qf-force-release 处理、强更窗无关闭跳过路径的
 *     既有标记仍在。
 * 结果写 JSON 到 QFTEST_OUT，退出码 0=通过。
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const OUT = process.env.QFTEST_OUT || '/tmp/qfr232/client-version-result.json';
const result = { cases: {}, pass: false };
const ok = (name, cond, extra) => { result.cases[name] = Object.assign({ pass: !!cond }, extra || {}); };
const src = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

const cv = require('../client-version');
const pkg = require('../package.json');

(async () => {
  try {
    // ---------- A 纯逻辑 ----------
    ok('A1_header_name', cv.HEADER_NAME === 'x-qf-client-version');
    ok('A2_fallback_is_package_version', cv.getClientVersion() === pkg.version, { got: cv.getClientVersion(), pkg: pkg.version });
    ok('A3_package_version_240', pkg.version === '2.4.1', { pkg: pkg.version });
    cv.setClientVersion('9.8.7');
    ok('A4_set_valid', cv.getClientVersion() === '9.8.7' && cv.clientVersionHeaders()['x-qf-client-version'] === '9.8.7');
    cv.setClientVersion('not-a-version');
    ok('A5_set_invalid_ignored', cv.getClientVersion() === '9.8.7');
    const merged = cv.withClientVersion({ 'Content-Type': 'application/json' });
    ok('A6_with_merges', merged['x-qf-client-version'] === '9.8.7' && merged['Content-Type'] === 'application/json');
    const kept = cv.withClientVersion({ 'x-qf-client-version': '1.2.3' });
    ok('A7_with_no_override', kept['x-qf-client-version'] === '1.2.3');
    ok('A8_fn_source', cv.resolveVersion(() => '3.4.5') === '3.4.5' && cv.resolveVersion('bad') === '9.8.7');
    // 恢复为包版本，后续链路用例以它为期望值
    cv.setClientVersion(pkg.version);
    const EXPECT = pkg.version;

    // ---------- B1/B2 update.js ----------
    const seenUpd = [];
    const payload = crypto.randomBytes(64 * 1024 + 7);
    const payloadSha = crypto.createHash('sha256').update(payload).digest('hex');
    const updServer = http.createServer((req, res) => {
      seenUpd.push({ url: req.url, v: req.headers['x-qf-client-version'] || null });
      if (req.url === '/release.json') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ version: '9.9.9', notes: 't', url: 'http://127.0.0.1:' + updServer.address().port + '/QFRemote-Setup-v9.9.9.exe', sha256: payloadSha, size: payload.length }));
      } else if (req.url === '/QFRemote-Setup-v9.9.9.exe') {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': payload.length });
        res.end(payload);
      } else { res.writeHead(404); res.end(); }
    });
    await new Promise(r => updServer.listen(0, '127.0.0.1', r));
    process.env.QFREMOTE_RELEASE_URL = 'http://127.0.0.1:' + updServer.address().port + '/release.json';
    delete require.cache[require.resolve('../update')];
    delete require.cache[require.resolve('../client-version')];
    const updater = require('../update');
    const cv2 = require('../client-version');
    cv2.setClientVersion(EXPECT);
    const chk = await updater.checkForUpdate('1.0.0');
    const destDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qfr232-upd-'));
    await updater.downloadUpdate(chk.manifest, destDir, () => {});
    const mSeen = seenUpd.find(s => s.url === '/release.json');
    const dSeen = seenUpd.find(s => s.url === '/QFRemote-Setup-v9.9.9.exe');
    ok('B1_manifest_header', !!mSeen && mSeen.v === EXPECT, { seen: mSeen });
    ok('B2_download_header', !!dSeen && dSeen.v === EXPECT, { seen: dSeen });
    updServer.close();

    // ---------- B3/B4 autologin ----------
    const seenAuth = [];
    const authServer = http.createServer((req, res) => {
      seenAuth.push({ method: req.method, v: req.headers['x-qf-client-version'] || null });
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        if (req.method === 'POST') { res.writeHead(200, { 'Set-Cookie': 'xid=testsession; Path=/' }); res.end('<html><head><title>QFRemote 控制台</title></head><body><div id="masthead"></div><!-- 控制台页面填充 console page padding 控制台页面填充 console page padding 控制台页面填充 console page padding 控制台页面填充 console page padding 控制台页面填充 console page padding 控制台页面填充 console page padding 控制台页面填充 console page padding 控制台页面填充 console page padding 控制台页面填充 console page padding 控制台页面填充 console page padding 控制台页面填充 console page padding 控制台页面填充 console page padding -->控制台</body></html>'); }
        else { res.writeHead(200); res.end('<html><head><title>QFRemote 控制台</title></head><body><div id="masthead"></div><!-- 控制台页面填充 console page padding 控制台页面填充 console page padding 控制台页面填充 console page padding 控制台页面填充 console page padding 控制台页面填充 console page padding 控制台页面填充 console page padding 控制台页面填充 console page padding 控制台页面填充 console page padding 控制台页面填充 console page padding 控制台页面填充 console page padding 控制台页面填充 console page padding 控制台页面填充 console page padding -->控制台</body></html>'); }
      });
    });
    await new Promise(r => authServer.listen(0, '127.0.0.1', r));
    const authBase = 'http://127.0.0.1:' + authServer.address().port + '/';
    const autologin = require('../autologin');
    const login = await autologin.httpSilentLogin({ baseUrl: authBase, username: 'u', password: 'p', clientVersion: EXPECT });
    const probe = await autologin.httpProbeSession({ baseUrl: authBase, cookieHeader: 'xid=x', clientVersion: EXPECT });
    const postSeen = seenAuth.find(s => s.method === 'POST');
    const getSeen = seenAuth.find(s => s.method === 'GET');
    ok('B3_silent_login_header', login.ok === true && !!postSeen && postSeen.v === EXPECT, { loginOk: login.ok, seen: postSeen });
    ok('B4_probe_header', probe.alive === true && !!getSeen && getSeen.v === EXPECT, { alive: probe.alive, seen: getSeen });
    authServer.close();

    // ---------- B5 lock.js 真桥 ----------
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qfr232-lock-'));
    execSync('openssl req -x509 -newkey rsa:2048 -keyout ' + path.join(tmp, 'k.pem') +
      ' -out ' + path.join(tmp, 'c.pem') + ' -days 2 -nodes -subj "/CN=127.0.0.1" -addext "subjectAltName=IP:127.0.0.1"',
      { stdio: 'pipe' });
    let lockSeen = null;
    const lockServer = https.createServer(
      { key: fs.readFileSync(path.join(tmp, 'k.pem')), cert: fs.readFileSync(path.join(tmp, 'c.pem')) },
      (req, res) => {
        lockSeen = req.headers['x-qf-client-version'] || null;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ devices: [{ id: 'pc-1', name: '测试机', owner: true, locked: false, component: true }] }));
      });
    await new Promise(r => lockServer.listen(0, '127.0.0.1', r));
    const lock = require('../lock');
    const bridge = lock.createLockBridge(null, { base: 'https://127.0.0.1:' + lockServer.address().port + '/lock', clientVersion: EXPECT });
    const devs = await bridge.listDevices();
    ok('B5_lock_header', devs.length === 1 && lockSeen === EXPECT, { seen: lockSeen, count: devs.length });
    lockServer.close();

    // ---------- C 静态接线 ----------
    const mainSrc = src('main.js');
    ok('C1_main_injects_runtime_version', mainSrc.includes("clientVersion.setClientVersion(app.getVersion())"));
    const extSeg = mainSrc.slice(mainSrc.indexOf('async function extRequest'), mainSrc.indexOf('async function extRequest') + 900);
    ok('C2_extrequest_header', extSeg.includes('clientVersion.clientVersionHeaders()'), { segHead: extSeg.slice(0, 200) });
    ok('C3_session_before_send_headers', mainSrc.includes('onBeforeSendHeaders') && mainSrc.includes('clientVersion.withClientVersion(h)'));
    ok('C4_lockbridge_version_param', mainSrc.includes("clientVersion: () => clientVersion.getClientVersion()"));
    ok('C5_probe_header', mainSrc.includes('headers: clientVersion.clientVersionHeaders()'));
    ok('C6_svcurls_header', src('svc-urls.js').includes('clientVersion.clientVersionHeaders(versionSource)'));
    // 头名不得散落：除 client-version.js 定义与本测试外，业务文件里不许出现字面头名
    const offenders = ['main.js', 'update.js', 'svc-urls.js', 'lock.js', 'autologin.js']
      .filter(f => src(f).includes("'x-qf-client-version'") || src(f).includes('"x-qf-client-version"'));
    ok('C7_header_name_single_source', offenders.length === 0, { offenders });

    // ---------- D 待更首启自动清除 ----------
    const dropSeg = mainSrc.slice(mainSrc.indexOf('function dropStalePending'), mainSrc.indexOf('function dropStalePending') + 260);
    ok('D1_drop_stale_compares', dropSeg.includes('updater.compareVersions(p.version, app.getVersion()) <= 0') && dropSeg.includes('clearPendingUpdate()'), { seg: dropSeg });
    const gateSeg = mainSrc.slice(mainSrc.indexOf('async function startupUpdateGate'), mainSrc.indexOf('async function startupUpdateGate') + 200);
    ok('D2_gate_calls_drop_first', gateSeg.includes('dropStalePending();'), { seg: gateSeg });

    // ---------- E 安装器 ----------
    const nsi = src('installer.nsi');
    ok('E1_oninstsuccess_silent_exec', nsi.includes('Function .onInstSuccess') && nsi.includes('IfSilent') && nsi.includes('Exec "$INSTDIR\\QFRemote.exe"'));
    ok('E2_version_strings_232', nsi.includes('QFRemote-Setup-v2.4.1.exe') && nsi.includes('VIProductVersion "2.4.1.0"') &&
      nsi.includes('"DisplayName" "QFRemote 2.4.1"') && nsi.includes('"DisplayVersion" "2.4.1"') && !nsi.includes('2.3.1'));
    ok('E3_finishpage_run_kept', nsi.includes('MUI_FINISHPAGE_RUN "$INSTDIR\\QFRemote.exe"') && nsi.includes('MUI_PAGE_DIRECTORY'));

    // ---------- F 强更墙守卫 ----------
    const forceHtml = src('force-update.html');
    ok('F1_release_btn_present', forceHtml.includes('id="releaseBtn"') && forceHtml.includes('先进入软件'));
    ok('F2_force_release_handler', mainSrc.includes("ipcMain.on('qf-force-release'"));
    ok('F3_two_tier_markers', mainSrc.includes('startupUpdateGate') && mainSrc.includes('runUpdateCheck'));
  } catch (e) {
    result.fatal = e.message + '\n' + (e.stack || '');
  }
  result.pass = Object.values(result.cases).every(c => c.pass) && !result.fatal;
  try {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  } catch (e) { /* ignore */ }
  console.log(JSON.stringify({ pass: result.pass, cases: result.cases, fatal: result.fatal || null }, null, 2));
  process.exit(result.pass ? 0 : 1);
})();
