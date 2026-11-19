'use strict';
/*
 * QFRemote 隐私锁 v2 · 一次性密码保管（B 线）
 * ================================================================
 * 定夺 §3 附加约束：
 *   - 不得自制外观仿冒 Windows 登录的密码采集界面；
 *   - 不得保存明文一次性密码；
 *   - 临时密码须经审查的验证方案，有独立过期、撤销和失败次数限制。
 *
 * 实现：只存 scrypt 盐+哈希（Node 内置 crypto.scryptSync），明文密码
 * 只在调用方内存里短暂出现、永不落盘、不进日志。本模块不画任何 UI，
 * 解锁界面由 session-agent.ps1 的 plain QFRemote 密码框负责（明确标注
 * QFRemote 隐私锁，不仿冒 Windows 登录）。
 *
 * 默认：有效期 10 分钟（与信封 arm TTL 对齐）、最多错 5 次；错满立即撤销
 * 并返回 REVOKED，协调层据此进入 FAILSAFE（调 Windows 原生锁屏兜底）。
 */
const crypto = require('crypto');

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_ATTEMPTS = 5;

class PasswordVaultError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'PasswordVaultError';
    this.code = code || 'VAULT_ERROR';
  }
}

class OneTimePasswordVault {
  constructor(opts) {
    const o = opts || {};
    this.ttlMs = o.ttlMs || DEFAULT_TTL_MS;
    this.maxAttempts = o.maxAttempts || DEFAULT_MAX_ATTEMPTS;
    this.entry = null; // { salt, hash, expiresAt, attempts, revoked, setAt }
  }

  // 明文只进内存做一次哈希，随即丢弃。调用方有责任在用后清掉自己的明文引用。
  set(password, opts) {
    const o = opts || {};
    if (typeof password !== 'string' || password.length < 4 || password.length > 64) {
      throw new PasswordVaultError('密码长度须为 4–64 位', 'BAD_PASSWORD');
    }
    const salt = crypto.randomBytes(16);
    const hash = crypto.scryptSync(password, salt, 64);
    this.entry = {
      salt: salt.toString('base64'),
      hash: hash.toString('base64'),
      expiresAt: Date.now() + (o.ttlMs || this.ttlMs),
      attempts: 0,
      revoked: false,
      setAt: Date.now()
    };
    return { expiresAt: this.entry.expiresAt, maxAttempts: this.maxAttempts };
  }

  verify(password) {
    const e = this.entry;
    if (!e) return { ok: false, code: 'NO_PASSWORD', message: '本次密码未设置或已作废' };
    if (e.revoked) return { ok: false, code: 'REVOKED', message: '本次密码已作废' };
    if (Date.now() > e.expiresAt) {
      e.revoked = true;
      return { ok: false, code: 'EXPIRED', message: '本次密码已过期' };
    }
    if (e.attempts >= this.maxAttempts) {
      e.revoked = true;
      return { ok: false, code: 'REVOKED', message: '失败次数已满，本次密码已作废' };
    }
    let candidate;
    try {
      candidate = crypto.scryptSync(String(password), Buffer.from(e.salt, 'base64'), 64);
    } catch (err) {
      return { ok: false, code: 'BAD_PASSWORD', message: '密码格式错误' };
    }
    const expected = Buffer.from(e.hash, 'base64');
    const match = candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
    if (!match) {
      e.attempts += 1;
      if (e.attempts >= this.maxAttempts) {
        e.revoked = true;
        return { ok: false, code: 'REVOKED', message: '密码错误；失败次数已满，本次密码已作废', attempts: e.attempts };
      }
      return { ok: false, code: 'WRONG_PASSWORD', message: '密码错误', attempts: e.attempts, remaining: this.maxAttempts - e.attempts };
    }
    // 一次性：验对即作废，不可复用。
    e.revoked = true;
    return { ok: true, code: 'OK', message: '验证通过，本次密码已作废' };
  }

  revoke(reason) {
    if (this.entry) this.entry.revoked = true;
    return { revoked: true, reason: reason || '' };
  }

  // 只暴露元数据，绝不暴露盐/哈希以外的任何秘密——连盐哈希也不对外输出。
  status() {
    const e = this.entry;
    if (!e) return { set: false };
    return {
      set: true, revoked: e.revoked, attempts: e.attempts,
      maxAttempts: this.maxAttempts, expiresAt: e.expiresAt,
      expired: Date.now() > e.expiresAt
    };
  }
}

module.exports = { PasswordVaultError, OneTimePasswordVault, DEFAULT_TTL_MS, DEFAULT_MAX_ATTEMPTS };
