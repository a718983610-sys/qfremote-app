'use strict';
/*
 * SYSTEM helper 客户端（2.4.5，windows/sys-helper.js）本地自检：
 *  A. validateOwner：合法账号／注入字符／超长／空／CJK；
 *  B. buildRequest：固定命令＋path 定位符形状校验（绝对路径、无 ..、
 *     basename 与命令对应），非法返回 null；
 *  C. parseHelperResponse：合法／坏 JSON／坏形状；
 *  D. loadWhitelist＋verifyFileHash：真文件＋夹具白名单；
 *  E. callHelper（注入 fake connect）：成功响应／不可用／超时／坏响应。
 * 结果写 JSON 到 QFTEST_OUT，退出码 0=通过。
 * 说明：命名管道真路与服务本体在 Wine 下另有端到端验证（见 REPORT），
 * 本文件只验客户端纯逻辑与管道调用封装。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const sh = require('../sys-helper');

const OUT = process.env.QFTEST_OUT || '/tmp/qfr245/sys-helper-result.json';
const result = { cases: {}, pass: false };
const ok = (name, cond, extra) => { result.cases[name] = Object.assign({ pass: !!cond }, extra || {}); };

class FakeSock extends EventEmitter {
  constructor(onWrite) { super(); this._onWrite = onWrite; this.written = ''; }
  write(s) { this.written += s; if (this._onWrite) this._onWrite(s, this); return true; }
  end() { this.emit('close'); }
  destroy() { this.emit('close'); }
}

(async () => {
  try {
    // ---- A. validateOwner ----
    ok('A1_plain', sh.validateOwner('718983610') === true);
    ok('A2_at', sh.validateOwner('user@example.com') === true);
    ok('A3_cjk', sh.validateOwner('张三') === true);
    ok('A4_space', sh.validateOwner('a b') === false);
    ok('A5_quote', sh.validateOwner("a'b") === false);
    ok('A6_semicolon', sh.validateOwner('a;del') === false);
    ok('A7_backslash', sh.validateOwner('a\\b') === false);
    ok('A8_slash', sh.validateOwner('a/b') === false);
    ok('A9_empty', sh.validateOwner('') === false);
    ok('A10_too_long', sh.validateOwner('a'.repeat(65)) === false);
    ok('A11_max_len', sh.validateOwner('a'.repeat(64)) === true);
    ok('A12_null', sh.validateOwner(null) === false);

    // ---- B. buildRequest ----
    const healPath = 'C:\\QFRemote\\qf-agent-heal.ps1';
    const lockPath = 'C:\\QFRemote\\Lock\\install.ps1';
    const rHeal = sh.buildRequest('heal-agent', null, healPath);
    ok('B1_heal_ok', !!rHeal && JSON.parse(rHeal).cmd === 'heal-agent' && JSON.parse(rHeal).path === healPath);
    const rLock = sh.buildRequest('install-lock', '718983610', lockPath);
    ok('B2_lock_ok', !!rLock && JSON.parse(rLock).owner === '718983610');
    ok('B3_lock_no_owner', sh.buildRequest('install-lock', null, lockPath) === null);
    ok('B4_lock_bad_owner', sh.buildRequest('install-lock', 'a b', lockPath) === null);
    ok('B5_unknown_cmd', sh.buildRequest('format-c', null, healPath) === null);
    ok('B6_relative_path', sh.buildRequest('heal-agent', null, 'qf-agent-heal.ps1') === null);
    ok('B7_traversal', sh.buildRequest('heal-agent', null, 'C:\\x\\..\\qf-agent-heal.ps1') === null);
    ok('B8_wrong_basename', sh.buildRequest('heal-agent', null, 'C:\\x\\evil.ps1') === null);
    ok('B9_lock_wrong_basename', sh.buildRequest('install-lock', '718983610', 'C:\\x\\qf-agent-heal.ps1') === null);
    ok('B10_no_path', sh.buildRequest('heal-agent', null, null) === null);
    ok('B11_unc_ok', !!sh.buildRequest('heal-agent', null, '\\\\server\\share\\qf-agent-heal.ps1'));

    // ---- C. parseHelperResponse ----
    ok('C1_valid', (() => { const r = sh.parseHelperResponse('{"ok":true,"code":"done","detail":"exit=0"}'); return r && r.ok === true && r.code === 'done'; })());
    ok('C2_bad_json', sh.parseHelperResponse('not json') === null);
    ok('C3_missing_ok', sh.parseHelperResponse('{"code":"done"}') === null);
    ok('C4_ok_not_bool', sh.parseHelperResponse('{"ok":"yes","code":"done"}') === null);
    ok('C5_empty', sh.parseHelperResponse('') === null);

    // ---- D. loadWhitelist＋verifyFileHash ----
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qfr-wl-'));
    const f1 = path.join(tmpDir, 'qf-agent-heal.ps1');
    fs.writeFileSync(f1, '# test script\n');
    const h1 = crypto.createHash('sha256').update(fs.readFileSync(f1)).digest('hex');
    const wl = { version: '2.4.5', files: { 'qf-agent-heal.ps1': h1 } };
    fs.writeFileSync(path.join(tmpDir, 'whitelist.json'), JSON.stringify(wl));
    ok('D1_load', (() => { const l = sh.loadWhitelist({ dirname: tmpDir }); return l && l.files['qf-agent-heal.ps1'] === h1; })());
    ok('D2_load_missing', sh.loadWhitelist({ dirname: tmpDir + '-nope' }) === null);
    ok('D3_verify_ok', sh.verifyFileHash(f1, wl) === true);
    ok('D4_verify_wrong', sh.verifyFileHash(f1, { files: { 'qf-agent-heal.ps1': '0'.repeat(64) } }) === false);
    ok('D5_verify_missing_file', sh.verifyFileHash(path.join(tmpDir, 'nope.ps1'), wl) === false);
    ok('D6_verify_null_wl', sh.verifyFileHash(f1, null) === false);
    ok('D7_real_whitelist', (() => {
      const real = sh.loadWhitelist({ dirname: path.join(__dirname, '..', 'syshelper') });
      return !!real && typeof real.files['qf-agent-heal.ps1'] === 'string' && real.files['qf-agent-heal.ps1'].length === 64 &&
        sh.verifyFileHash(path.join(__dirname, '..', 'qf-agent-heal.ps1'), real) === true;
    })());

    // ---- E. callHelper（fake connect） ----
    const healPathWin = 'C:\\QFRemote\\qf-agent-heal.ps1';
    const rE1 = await sh.callHelper('heal-agent', null, {
      path: healPathWin,
      connect: () => new FakeSock((s, sock) => {
        const req = JSON.parse(s);
        if (req.cmd !== 'heal-agent') throw new Error('wrong cmd');
        setImmediate(() => sock.emit('data', Buffer.from('{"ok":true,"code":"done","detail":"exit=0"}\n')));
      })
    });
    ok('E1_success', rE1.ok === true && rE1.code === 'done', rE1);
    const rE2 = await sh.callHelper('heal-agent', null, {
      path: healPathWin,
      connect: () => { throw new Error('no pipe'); }
    });
    ok('E2_unavailable', rE2.ok === false && rE2.code === 'unavailable', rE2);
    const rE3 = await sh.callHelper('heal-agent', null, {
      path: healPathWin, timeoutMs: 50,
      connect: () => new FakeSock(() => {})
    });
    ok('E3_timeout', rE3.ok === false && rE3.code === 'timeout', rE3);
    const rE4 = await sh.callHelper('heal-agent', null, {
      path: healPathWin,
      connect: () => new FakeSock((s, sock) => setImmediate(() => sock.emit('data', Buffer.from('garbage-no-json\n'))))
    });
    ok('E4_bad_response', rE4.ok === false && rE4.code === 'bad-response', rE4);
    const rE5 = await sh.callHelper('heal-agent', null, {
      path: healPathWin,
      connect: () => new FakeSock((s, sock) => setImmediate(() => sock.emit('error', new Error('ECONNREFUSED'))))
    });
    ok('E5_sock_error', rE5.ok === false && rE5.code === 'unavailable', rE5);
    const rE6 = await sh.callHelper('heal-agent', null, { path: 'relative.ps1' });
    ok('E6_bad_request', rE6.ok === false && rE6.code === 'bad-request', rE6);

    result.pass = Object.values(result.cases).every((c) => c.pass);
  } catch (e) {
    result.error = String(e && e.stack || e);
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  if (!result.pass) { console.error(JSON.stringify(result, null, 2)); process.exit(1); }
  console.log('sys-helper-test: all ' + Object.keys(result.cases).length + ' cases pass');
})();
