'use strict';
/*
 * QFRemote 记住账号密码 —— 本机凭据保险箱（v2.3.0 新增）
 * ================================================================
 * 职责：把用户勾选「记住账号密码」后保存的账号＋密码，加密后落盘，
 * 供登录页自动回填与会话失效时的静默登录使用。
 *
 * 加密口径（不许放宽、不许夸大）：
 *   - 用 Electron safeStorage 加密。在 Windows 上 safeStorage 底层就是
 *     系统 DPAPI：密文与当前 Windows 用户账户绑定，换一台电脑、换一个
 *     Windows 用户都解不开，本机其他 Windows 用户也解不开。
 *   - 但要说清：这不是「绝对安全」。能以该 Windows 用户身份运行的程序
 *     （包括本软件自己）都能调用系统解开它；它的作用是让密码不明文躺在
 *     磁盘上、防顺手翻文件和整盘拷贝，不防本机已被攻陷的情况。
 *   - 系统加密不可用时（safeStorage 报不可用）一律拒绝保存，绝不退回
 *     明文或弱混淆落盘。
 *   - 落盘文件里账号与密码都在同一段密文里，文件名与内容都不含明文。
 *
 * 文件格式（JSON，userData 目录下 qf-creds.json）：
 *   { v: 1, kind: 'qfremote-creds', cipher: 'electron-safeStorage', data: '<base64 密文>' }
 * data 是 safeStorage.encryptString(JSON.stringify({username, password})) 的 base64。
 *
 * 本模块不依赖 Electron 本体：safeStorage 由调用方注入，方便单测用假
 * 加密器验证「落盘无明文、往返一致、清除干净」。
 */
const fs = require('fs');
const path = require('path');

function credError(message, code) {
  const e = new Error(message);
  if (code) e.code = code;
  return e;
}

/*
 * createCredStore({ file, safeStorage })
 *  - file: 落盘绝对路径
 *  - safeStorage: Electron 的 safeStorage（或同形假实现）：
 *      isEncryptionAvailable() -> boolean
 *      encryptString(plain) -> Buffer
 *      decryptString(buf) -> string
 */
function createCredStore(opts) {
  const o = opts || {};
  const file = o.file;
  const ss = o.safeStorage;
  if (!file) throw credError('凭据文件路径缺失。', 'NO_FILE');

  function encryptionAvailable() {
    try { return !!(ss && typeof ss.isEncryptionAvailable === 'function' && ss.isEncryptionAvailable()); }
    catch (e) { return false; }
  }

  function save(username, password) {
    const u = String(username == null ? '' : username);
    const p = String(password == null ? '' : password);
    if (!u || !p) throw credError('账号和密码均须填写，才能启用记住密码。', 'EMPTY');
    if (!encryptionAvailable()) {
      // 红线：加密不可用就存不了，绝不明文落盘
      throw credError('本机系统加密当前不可用，本次未保存密码。', 'NO_ENCRYPTION');
    }
    const plain = JSON.stringify({ username: u, password: p });
    let cipherBuf;
    try { cipherBuf = ss.encryptString(plain); }
    catch (e) { throw credError('加密失败，本次未保存密码。', 'ENCRYPT_FAIL'); }
    const payload = {
      v: 1,
      kind: 'qfremote-creds',
      cipher: 'electron-safeStorage',
      data: Buffer.from(cipherBuf).toString('base64')
    };
    // 原子写：先写临时文件再改名，崩溃不留半份文件
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(payload));
    fs.renameSync(tmp, file);
    return true;
  }

  function load() {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { return null; }
    let payload = null;
    try { payload = JSON.parse(raw); } catch (e) { return null; }
    if (!payload || payload.kind !== 'qfremote-creds' || typeof payload.data !== 'string' || !payload.data) return null;
    if (!encryptionAvailable()) return null;
    try {
      const plain = ss.decryptString(Buffer.from(payload.data, 'base64'));
      const obj = JSON.parse(plain);
      if (!obj || typeof obj.username !== 'string' || typeof obj.password !== 'string' || !obj.username || !obj.password) return null;
      return { username: obj.username, password: obj.password };
    } catch (e) { return null; } // 解不开（换了电脑/用户、文件损坏）一律当没有，不报错打扰
  }

  function has() { return load() !== null; }

  function clear() {
    try { fs.unlinkSync(file); } catch (e) { /* 本来就没有，忽略 */ }
  }

  return { encryptionAvailable, save, load, has, clear, file };
}

module.exports = { createCredStore };
