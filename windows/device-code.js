'use strict';
/*
 * QFRemote 本机设备码 —— 许可体系设备标识（2.3.1 阶段 E 新增）
 * ================================================================
 * 职责：为许可上报/绑定（契约 §3 device-report / bind）提供本机稳定
 * 设备码：首次使用时随机生成一次（16 字节随机值的 hex 串，与安卓
 * DeviceCodeStore 同形），之后恒定不变——换账号不换码（B6「一设备
 * 两账号」检测正靠它识别同一设备）；退出登录不清（口径同聊天设备
 * 钥匙 device-key.js：退出不等于换设备）。
 *
 * 保管口径：
 *   - 设备码是设备标识、不是凭据：不含任何账号/个人信息，泄露不
 *     能冒充登录（服务端判定还须控制台会话）。但仍按保险箱同级
 *     纪律优先加密落盘：safeStorage 可用时加密存 qf-device-code.json；
 *   - safeStorage 不可用时退回同目录明文标识文件 qf-device-code.plain
 *     （只存这串随机标识本身）——若此处也拒绝生成，许可上报将永远
 *     没有稳定设备码、B6 检测与槽位绑定无从谈起；明文的仅是随机标
 *     识，不涉及任何密码/令牌，与 creds.js「绝不明文存密码」红线
 *     对象不同。此退回路径在诊断与代码注释中明示，不静默。
 *   - 生成/读取失败一律返回 null，调用方据此跳过本次上报并落诚实
 *     错误态，绝不临时编一串假码上报（假码会污染设备台账）。
 *
 * 本模块不依赖 Electron 本体：safeStorage 与随机源由调用方注入，便于单测。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function createDeviceCodeStore(opts) {
  const o = opts || {};
  const file = o.file; // 加密落盘文件（qf-device-code.json）
  const ss = o.safeStorage;
  const randomBytes = typeof o.randomBytes === 'function' ? o.randomBytes : crypto.randomBytes;
  if (!file) throw new Error('设备码文件路径缺失。');
  const plainFile = file + '.plain';

  function encryptionAvailable() {
    try { return !!(ss && typeof ss.isEncryptionAvailable === 'function' && ss.isEncryptionAvailable()); }
    catch (e) { return false; }
  }

  function generate() {
    return Buffer.from(randomBytes(16)).toString('hex'); // 32 位 hex，与安卓同形
  }

  function loadEncrypted() {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { return null; }
    let payload = null;
    try { payload = JSON.parse(raw); } catch (e) { return null; }
    if (!payload || payload.kind !== 'qfremote-device-code' || typeof payload.data !== 'string' || !payload.data) return null;
    if (!encryptionAvailable()) return null;
    try {
      const plain = ss.decryptString(Buffer.from(payload.data, 'base64'));
      const code = String(plain || '').trim();
      return /^[0-9a-f]{32}$/.test(code) ? code : null;
    } catch (e) { return null; }
  }

  function loadPlain() {
    try {
      const code = fs.readFileSync(plainFile, 'utf8').trim();
      return /^[0-9a-f]{32}$/.test(code) ? code : null;
    } catch (e) { return null; }
  }

  function load() { return loadEncrypted() || loadPlain(); }

  function saveEncrypted(code) {
    let cipherBuf;
    try { cipherBuf = ss.encryptString(code); } catch (e) { return false; }
    const payload = { v: 1, kind: 'qfremote-device-code', cipher: 'electron-safeStorage', data: Buffer.from(cipherBuf).toString('base64') };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(payload));
    fs.renameSync(tmp, file);
    return true;
  }

  function savePlain(code) {
    fs.mkdirSync(path.dirname(plainFile), { recursive: true });
    const tmp = plainFile + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, code);
    fs.renameSync(tmp, plainFile);
    return true;
  }

  // 取本机设备码：有则返回已存值（恒定）；无则生成、落盘后返回。
  // 落盘彻底失败返回 null（调用方跳过上报，不编假码）。
  function ensure() {
    const existing = load();
    if (existing) return existing;
    const code = generate();
    try {
      if (encryptionAvailable()) { if (saveEncrypted(code)) return code; }
      if (savePlain(code)) return code;
    } catch (e) { /* 落盘失败按无码处理 */ }
    return null;
  }

  function has() { return load() !== null; }

  function clear() {
    try { fs.unlinkSync(file); } catch (e) { /* ignore */ }
    try { fs.unlinkSync(plainFile); } catch (e) { /* ignore */ }
  }

  return { encryptionAvailable, ensure, load, has, clear, file, plainFile };
}

module.exports = { createDeviceCodeStore };
