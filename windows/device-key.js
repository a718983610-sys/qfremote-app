'use strict';
/*
 * QFRemote 聊天设备密钥 —— 本机设备密钥保险箱（v2.3.0 L 线新增，待总线合入 app-src）
 * ================================================================
 * 职责：为「聊天设备静默解锁」在本机生成并保管一把设备密钥（32 字节
 * 随机值）。聊天页用它把身份私钥与保险库钥匙包成「设备包裹副本」存于
 * 服务端（服务端只有密文）；此后打开聊天，会话有效且本机能出示这把
 * 设备密钥，即可静默解开，不再出现任何密码框。
 *
 * 保管口径（与 creds.js 同级纪律，不许放宽）：
 *   - 用 Electron safeStorage 加密落盘。Windows 上底层为系统 DPAPI：
 *     密文与当前 Windows 用户账户绑定，换电脑、换用户都解不开。
 *   - 系统加密不可用时一律拒绝生成/保存，绝不退回明文或弱混淆落盘；
 *     此时聊天页自动回退到 WebCrypto 设备密钥路径（页面自带），功能不缺位。
 *   - 设备密钥只递入自家聊天页的内存（window.qfShellDeviceUnlock /
 *     qfShellDeviceEnroll），不进日志、不进诊断、不进设置文件。
 *   - 清除语义：清除后本机设备副本即失效（服务端副本仍在但无人能解），
 *     聊天回到密码/例外解锁路径；不影响账号与其他设备。
 *
 * 文件格式（JSON，userData 目录下 qf-device-key.json）：
 *   { v: 1, kind: 'qfremote-device-key', cipher: 'electron-safeStorage', data: '<base64 密文>' }
 * data 是 safeStorage.encryptString(<设备密钥的 base64 文本>) 的 base64。
 *
 * 本模块不依赖 Electron 本体：safeStorage 与随机源由调用方注入，便于单测。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function keyError(message, code) {
  const e = new Error(message);
  if (code) e.code = code;
  return e;
}

/*
 * createDeviceKeyStore({ file, safeStorage, randomBytes })
 *  - ensure(): 有则返回已存设备密钥（base64）；无则生成、加密落盘后返回。
 *    加密不可用返回 null（调用方据此回退页面 WebCrypto 路径）。
 *  - load(): 只读不生成；解不开返回 null。
 *  - clear(): 删除文件（手动退出是否连带清除，由主进程策略决定；默认不清除，
 *    设备密钥与登录态相互独立，退出登录不等于换设备）。
 */
function createDeviceKeyStore(opts) {
  const o = opts || {};
  const file = o.file;
  const ss = o.safeStorage;
  const randomBytes = typeof o.randomBytes === 'function' ? o.randomBytes : crypto.randomBytes;
  if (!file) throw keyError('设备密钥文件路径缺失。', 'NO_FILE');

  function encryptionAvailable() {
    try { return !!(ss && typeof ss.isEncryptionAvailable === 'function' && ss.isEncryptionAvailable()); }
    catch (e) { return false; }
  }

  function load() {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { return null; }
    let payload = null;
    try { payload = JSON.parse(raw); } catch (e) { return null; }
    if (!payload || payload.kind !== 'qfremote-device-key' || typeof payload.data !== 'string' || !payload.data) return null;
    if (!encryptionAvailable()) return null;
    try {
      const plain = ss.decryptString(Buffer.from(payload.data, 'base64'));
      const key = Buffer.from(String(plain || ''), 'base64');
      if (key.length !== 32) return null;
      return String(plain);
    } catch (e) { return null; }
  }

  function ensure() {
    const existing = load();
    if (existing) return existing;
    if (!encryptionAvailable()) return null; // 红线：加密不可用绝不明文落盘
    const keyB64 = Buffer.from(randomBytes(32)).toString('base64');
    let cipherBuf;
    try { cipherBuf = ss.encryptString(keyB64); }
    catch (e) { return null; }
    const payload = { v: 1, kind: 'qfremote-device-key', cipher: 'electron-safeStorage', data: Buffer.from(cipherBuf).toString('base64') };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(payload));
    fs.renameSync(tmp, file);
    return keyB64;
  }

  function has() { return load() !== null; }

  function clear() {
    try { fs.unlinkSync(file); } catch (e) { /* 本来就没有，忽略 */ }
  }

  return { encryptionAvailable, ensure, load, has, clear, file };
}

module.exports = { createDeviceKeyStore };
