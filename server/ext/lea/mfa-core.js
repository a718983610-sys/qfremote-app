'use strict';
/*
 * LEA MFA 核心 · emergency_stop 恢复票据全员强制 MFA
 * ============================================================
 * 立项：GPT 2026-11-18 裁决《QFRemote 3.0.0｜emergency_stop 两项正式裁决》
 * §三（恢复票据全员强制 MFA）＋§四（三个安全细节）＋§五（验收清单 MFA 行）。
 *
 * 边界（裁决原话）：全员强制 MFA 只针对申请远程签发紧急停控恢复票据的
 * 账户，不要求所有普通用户每次登录、连接设备时都完成 MFA。Key 生成／
 * 吊销等操作仍走原有密码二次确认，不受本模块影响。
 *
 * 第二因素：TOTP（RFC 6238，SHA-1，30 秒步长，6 位，±1 步容差）为当前
 * 实现的可用第二因素；Passkey 等抗钓鱼认证方式优先但属后续项——方法字
 * 段已预留为可扩展枚举（auth_context 形如 password+totp@<verified_at>，
 * 将来 password+passkey@<verified_at> 可直接接入，无须改票据格式）。
 *
 * 安全要点：
 *  1. 未启用 MFA 的用户：拒绝直接签发恢复票据（MFA_REQUIRED），只给
 *     安全注册路径，不降级为只输入密码。
 *  2. 新注册 MFA → 立刻解除停控不能默认允许：新因素有 24 小时冷静期，
 *     冷静期内验证一律拒绝（MFA_COOLDOWN），须等冷静期结束（风险核验
 *     ＋通知以审计记录与响应文案体现）。
 *  3. MFA 设备丢失：走专门的账户恢复流程（report-lost 立案 → 站长审批
 *     → 重新注册＋冷静期），不降低为只输入密码；丢失的因素立即失效。
 *  4. MFA 验证与本次恢复请求绑定：验证完成后 5 分钟内有效（verification
 *     记录，单次使用）；过期／重复使用一律拒绝。TOTP 码防重放：同一计
 *     数器只接受一次。
 *  5. 密钥（TOTP secret）只存服务端 0600 台账，永不返回（注册时仅一次
 *     返回 otpauth URL＋secret 供扫码绑定）、永不进审计与日志。
 *  6. 审计：认证方式、认证时间、签发与实际恢复结果记入与 lea-core 同款
 *     的按天 audit-YYYY-MM-DD.jsonl（同一数据目录）。
 *
 * 存储：<LEA 数据目录>/mfa.json（0600，原子 tmp+rename，与 lea-core
 * 同款）。单 Node 进程、无 cluster 共享，故不引入文件锁（与 lea-core
 * T13 同口径）。
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ---- 策略常量（GPT 裁决 §三；构造参数可覆盖，仅供测试） ----
const MFA_VERIFY_TTL_S = 300;       // MFA 验证与本次恢复请求绑定，验证完成后 5 分钟内有效
const MFA_COOLDOWN_S = 24 * 3600;  // 新注册 MFA 冷静期 24 小时：冷静期内不得用于签发恢复票据
const ENROLL_TTL_S = 600;          // 注册待确认有效期 10 分钟
const TOTP_STEP_S = 30;             // TOTP 步长 30 秒（RFC 6238）
const TOTP_DIGITS = 6;              // TOTP 6 位
const TOTP_WINDOW = 1;              // 允许 ±1 步时钟偏差
const MFA_METHODS = ['totp'];       // 当前可用第二因素；Passkey 为后续项
const MFA_RECOVERY_PURPOSE = 'emergency-stop-recovery';

// ---- Base32（RFC 4648，无外部依赖） ----
const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Encode(buf) {
  let out = '';
  let bits = 0;
  let value = 0;
  for (const b of buf) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  while (out.length % 8 !== 0) out += '=';
  return out;
}
function base32Decode(str) {
  const clean = String(str || '').replace(/=+$/, '').toUpperCase();
  if (!/^[A-Z2-7]*$/.test(clean)) throw new Error('invalid base32');
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const ch of clean) {
    value = (value << 5) | B32_ALPHABET.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

// ---- TOTP（RFC 6238，SHA-1） ----
function totpCode(secretB32, counter) {
  const key = base32Decode(secretB32);
  const msg = Buffer.alloc(8);
  // 计数器为 64 位大端；JS 安全整数范围内高 32 位恒为 0。
  msg.writeUInt32BE(0, 0);
  msg.writeUInt32BE(counter >>> 0, 4);
  const hmac = crypto.createHmac('sha1', key).update(msg).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(code % (10 ** TOTP_DIGITS)).padStart(TOTP_DIGITS, '0');
}
function verifyTotp(secretB32, code, nowSec, lastCounter) {
  const wanted = String(code || '').trim();
  if (!/^\d{6}$/.test(wanted)) return { ok: false, reason: 'bad-code' };
  const counter = Math.floor(nowSec / TOTP_STEP_S);
  for (let d = -TOTP_WINDOW; d <= TOTP_WINDOW; d++) {
    const c = counter + d;
    if (Number.isSafeInteger(lastCounter) && c <= lastCounter) continue; // 防重放
    let candidate;
    try { candidate = totpCode(secretB32, c); } catch (e) { return { ok: false, reason: 'bad-secret' }; }
    // 定长比较（防时序泄露；候选与输入均为 6 位数字）。
    if (crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(wanted))) {
      return { ok: true, counter: c };
    }
  }
  return { ok: false, reason: 'bad-code' };
}

function mfaErr(code, message) {
  const e = new Error(message || code);
  e.code = code;
  return e;
}

function createMfaCore(opts) {
  opts = opts || {};
  const dir = opts.dir || '/opt/qfremote-ext/data/lea';
  const log = typeof opts.log === 'function' ? opts.log : function () {};
  const nowFn = typeof opts.now === 'function' ? opts.now : Date.now;
  const now = () => nowFn();
  const nowSec = () => Math.floor(now() / 1000);
  const cooldownSec = Number.isSafeInteger(opts.cooldownSec) ? opts.cooldownSec : MFA_COOLDOWN_S;
  const verifyTtlSec = Number.isSafeInteger(opts.verifyTtlSec) ? opts.verifyTtlSec : MFA_VERIFY_TTL_S;
  const enrollTtlSec = Number.isSafeInteger(opts.enrollTtlSec) ? opts.enrollTtlSec : ENROLL_TTL_S;

  const MFA_FILE = path.join(dir, 'mfa.json');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}

  function readJson(file, fallback) {
    try {
      const v = JSON.parse(fs.readFileSync(file, 'utf8'));
      return (v && typeof v === 'object') ? v : fallback;
    } catch (e) { return fallback; }
  }
  function writeJsonAtomic(file, value) {
    const tmp = file + '.tmp-' + process.pid + '-' + crypto.randomBytes(3).toString('hex');
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
    try { fs.chmodSync(file, 0o600); } catch (e) {}
  }
  function load() {
    return readJson(MFA_FILE, { factors: {}, pending_enrollments: {}, verifications: {}, cases: {} });
  }
  function save(st) { writeJsonAtomic(MFA_FILE, st); }

  // 审计：与 lea-core 同款按天 JSONL（同一数据目录）；字段由本模块构造，
  // 永不含 secret／TOTP 码。
  function auditFileName(d) {
    const p2 = (n) => String(n).padStart(2, '0');
    return 'audit-' + d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + '.jsonl';
  }
  function audit(ev, fields) {
    const rec = Object.assign({ ts: new Date(now()).toISOString(), ev }, fields || {});
    try {
      fs.appendFileSync(path.join(dir, auditFileName(new Date(now()))),
        JSON.stringify(rec) + '\n', { mode: 0o600 });
    } catch (e) {
      try { log({ ev: 'lea-mfa-audit-write-failed', err: String(e && e.message) }); } catch (e2) {}
      return null;
    }
    return rec;
  }

  function factorStatus(f, atSec) {
    if (!f) return 'none';
    if (f.status === 'lost') return 'lost';
    if (Number.isSafeInteger(f.cooldown_until) && atSec < f.cooldown_until) return 'cooling-off';
    return 'active';
  }

  // ---- 查询：因素状态（供路由层做 MFA_REQUIRED／COOLDOWN／LOST 分支） ----
  function getFactorStatus(accountId) {
    const st = load();
    const f = st.factors[String(accountId)];
    const atSec = nowSec();
    const status = factorStatus(f, atSec);
    return {
      enrolled: !!f,
      method: f ? f.method : null,
      status,
      enrolled_at: f ? (f.enrolled_at || 0) : 0,
      cooldown_until: f ? (f.cooldown_until || 0) : 0,
      cooldown_remaining_s: status === 'cooling-off' ? Math.max(0, (f.cooldown_until || 0) - atSec) : 0,
    };
  }

  function latestCase(st, accountId, type) {
    let best = null;
    for (const c of Object.values(st.cases || {})) {
      if (c && c.account_id === String(accountId) && (!type || c.type === type)) {
        if (!best || (c.created_at || 0) > (best.created_at || 0)) best = c;
      }
    }
    return best;
  }

  // ---- 注册：开始（控制台会话＋密码二次确认已由路由层完成） ----
  function beginEnrollment(accountId, ctx) {
    const st = load();
    const f = st.factors[String(accountId)];
    const status = factorStatus(f, nowSec());
    if (status === 'active' || status === 'cooling-off') {
      throw mfaErr('QFR_MFA_ALREADY_ENROLLED', '该账号已启用 MFA。');
    }
    if (status === 'lost') {
      // 丢失后重新注册须先有站长批准的恢复案件，否则不允许。
      const c = latestCase(st, accountId, 'mfa-lost');
      if (!c || c.status !== 'approved') {
        throw mfaErr('QFR_MFA_RECOVERY_REQUIRED', 'MFA 设备已挂失，须先完成账户恢复流程（站长审批）后再重新注册。');
      }
    }
    const secret = base32Encode(crypto.randomBytes(20));
    const enrollmentId = 'enr-' + crypto.randomBytes(8).toString('hex');
    const createdAt = nowSec();
    st.pending_enrollments[enrollmentId] = {
      enrollment_id: enrollmentId,
      account_id: String(accountId),
      method: 'totp',
      secret_b32: secret,
      created_at: createdAt,
      expires_at: createdAt + enrollTtlSec,
    };
    save(st);
    const label = 'QFRemote:' + encodeURIComponent(String(accountId));
    const otpauthUrl = 'otpauth://totp/' + label +
      '?secret=' + secret + '&issuer=QFRemote&digits=6&period=30&algorithm=SHA1';
    audit('lea-mfa-enroll-begin', { account_id: String(accountId), method: 'totp', enrollment_id: enrollmentId });
    // secret 只本次返回一次（供扫码绑定），此后永不返回。
    return { enrollment_id: enrollmentId, method: 'totp', secret, otpauth_url: otpauthUrl, expires_at: createdAt + enrollTtlSec, cooldown_s: cooldownSec };
  }

  // ---- 注册：确认（凭 TOTP 码证明持有；成功后进入冷静期） ----
  function confirmEnrollment(accountId, enrollmentId, code, ctx) {
    const st = load();
    const p = st.pending_enrollments[String(enrollmentId)];
    if (!p || p.account_id !== String(accountId)) {
      throw mfaErr('QFR_MFA_ENROLLMENT_INVALID', '注册申请不存在或已失效，请重新开始注册。');
    }
    if (nowSec() > p.expires_at) {
      delete st.pending_enrollments[String(enrollmentId)];
      save(st);
      throw mfaErr('QFR_MFA_ENROLLMENT_INVALID', '注册申请已过期，请重新开始注册。');
    }
    const v = verifyTotp(p.secret_b32, code, nowSec(), null);
    if (!v.ok) {
      audit('lea-mfa-verify-fail', { account_id: String(accountId), method: 'totp', stage: 'enroll-confirm', reason: v.reason });
      throw mfaErr('QFR_MFA_BAD_CODE', 'MFA 校验码不正确。');
    }
    const enrolledAt = nowSec();
    st.factors[String(accountId)] = {
      method: 'totp',
      secret_b32: p.secret_b32,
      status: 'active',
      enrolled_at: enrolledAt,
      cooldown_until: enrolledAt + cooldownSec,
      last_counter: v.counter,
      last_used_at: enrolledAt,
      enrolled_from: ctx ? { ip: ctx.ip || null, user_agent: ctx.userAgent || null } : null,
    };
    delete st.pending_enrollments[String(enrollmentId)];
    save(st);
    audit('lea-mfa-enroll-confirm', {
      account_id: String(accountId), method: 'totp',
      enrolled_at: enrolledAt, cooldown_until: enrolledAt + cooldownSec,
    });
    return { method: 'totp', enrolled_at: enrolledAt, cooldown_until: enrolledAt + cooldownSec };
  }

  // ---- 验证：凭 TOTP 码验证（冷静期内拒绝，不消耗码） ----
  function verifyCode(accountId, code) {
    const st = load();
    const f = st.factors[String(accountId)];
    const atSec = nowSec();
    const status = factorStatus(f, atSec);
    if (status === 'none') throw mfaErr('QFR_MFA_NOT_ENROLLED', '该账号未启用 MFA。');
    if (status === 'lost') throw mfaErr('QFR_MFA_LOST', 'MFA 设备已挂失，须走账户恢复流程。');
    if (status === 'cooling-off') {
      audit('lea-mfa-cooldown-block', {
        account_id: String(accountId), method: f.method,
        enrolled_at: f.enrolled_at, cooldown_until: f.cooldown_until,
      });
      const e = mfaErr('QFR_MFA_COOLDOWN', '新注册的 MFA 处于冷静期，冷静期结束前不得用于签发恢复票据。');
      e.cooldown_until = f.cooldown_until;
      e.cooldown_remaining_s = Math.max(0, f.cooldown_until - atSec);
      throw e;
    }
    const v = verifyTotp(f.secret_b32, code, atSec, f.last_counter);
    if (!v.ok) {
      audit('lea-mfa-verify-fail', { account_id: String(accountId), method: f.method, reason: v.reason });
      throw mfaErr('QFR_MFA_BAD_CODE', 'MFA 校验码不正确或已被使用。');
    }
    f.last_counter = v.counter;
    f.last_used_at = atSec;
    save(st);
    audit('lea-mfa-verify-ok', { account_id: String(accountId), method: f.method, verified_at: atSec });
    return { method: f.method, verified_at: atSec };
  }

  // ---- 验证绑定：签发 5 分钟内有效的单次验证记录 ----
  function createVerification(accountId, method, verifiedAt) {
    const st = load();
    const verificationId = 'mfv-' + crypto.randomBytes(8).toString('hex');
    st.verifications[verificationId] = {
      verification_id: verificationId,
      account_id: String(accountId),
      method,
      verified_at: verifiedAt,
      expires_at: verifiedAt + verifyTtlSec,
      purpose: MFA_RECOVERY_PURPOSE,
      used: false,
    };
    save(st);
    return {
      verification_id: verificationId, method,
      verified_at: verifiedAt, expires_at: verifiedAt + verifyTtlSec,
      purpose: MFA_RECOVERY_PURPOSE,
    };
  }

  // ---- 验证绑定：消费单次验证记录（过期／重复使用一律拒绝） ----
  function consumeVerification(accountId, verificationId) {
    const st = load();
    const v = st.verifications[String(verificationId)];
    if (!v || v.account_id !== String(accountId) || v.purpose !== MFA_RECOVERY_PURPOSE) {
      throw mfaErr('QFR_MFA_VERIFICATION_INVALID', 'MFA 验证记录无效。');
    }
    if (v.used) {
      audit('lea-mfa-verify-fail', { account_id: String(accountId), method: v.method, reason: 'verification-reused' });
      throw mfaErr('QFR_MFA_VERIFICATION_REUSED', 'MFA 验证记录已被使用。');
    }
    if (nowSec() > v.expires_at) {
      audit('lea-mfa-verify-fail', { account_id: String(accountId), method: v.method, reason: 'verification-expired' });
      throw mfaErr('QFR_MFA_VERIFICATION_EXPIRED', 'MFA 验证已过期（5 分钟），请重新验证。');
    }
    v.used = true;
    save(st);
    audit('lea-mfa-verification-consumed', {
      account_id: String(accountId), method: v.method,
      verified_at: v.verified_at, verification_id: v.verification_id,
    });
    return { method: v.method, verified_at: v.verified_at };
  }

  // ---- 丢失：挂失因素＋立案（不降低为只输入密码） ----
  function reportLost(accountId, ctx) {
    const st = load();
    const f = st.factors[String(accountId)];
    if (!f) throw mfaErr('QFR_MFA_NOT_ENROLLED', '该账号未启用 MFA，无须挂失。');
    // 已有待处理案件时幂等返回，不重复立案。
    const open = latestCase(st, accountId, 'mfa-lost');
    if (f.status === 'lost' && open && open.status === 'pending') return open;
    f.status = 'lost';
    const caseId = 'mfa-case-' + crypto.randomBytes(8).toString('hex');
    const rec = {
      case_id: caseId, account_id: String(accountId), type: 'mfa-lost',
      status: 'pending', created_at: nowSec(),
      reported_from: ctx ? { ip: ctx.ip || null, user_agent: ctx.userAgent || null } : null,
      resolved_at: 0, resolved_by: null,
    };
    st.cases[caseId] = rec;
    save(st);
    audit('lea-mfa-lost-reported', { account_id: String(accountId), case_id: caseId });
    return rec;
  }

  // ---- 丢失恢复：站长审批案件（仅路由层 isSiteAdmin 通过后调用） ----
  function resolveCase(caseId, by, decision) {
    const st = load();
    const c = st.cases[String(caseId)];
    if (!c) throw mfaErr('QFR_MFA_CASE_NOT_FOUND', '恢复案件不存在。');
    if (c.status !== 'pending') throw mfaErr('QFR_MFA_CASE_CLOSED', '恢复案件已处理。');
    if (decision !== 'approved' && decision !== 'rejected') {
      throw mfaErr('QFR_VALIDATION', 'decision 须为 approved 或 rejected。');
    }
    c.status = decision;
    c.resolved_at = nowSec();
    c.resolved_by = String(by || '');
    save(st);
    audit('lea-mfa-case-resolved', {
      account_id: c.account_id, case_id: c.case_id,
      decision, resolved_by: c.resolved_by,
    });
    return c;
  }

  function getCase(caseId) {
    const st = load();
    return st.cases[String(caseId)] || null;
  }
  function listOpenCases(accountId) {
    const st = load();
    return Object.values(st.cases || {})
      .filter((c) => c && c.account_id === String(accountId) && c.status === 'pending')
      .map((c) => ({ case_id: c.case_id, type: c.type, status: c.status, created_at: c.created_at }));
  }

  return {
    getFactorStatus, beginEnrollment, confirmEnrollment,
    verifyCode, createVerification, consumeVerification,
    reportLost, resolveCase, getCase, listOpenCases,
    // 供路由层记审计：认证方式＋认证时间（签发与恢复结果由 lea-core 审计）。
    audit,
    MFA_VERIFY_TTL_S: verifyTtlSec,
    MFA_COOLDOWN_S: cooldownSec,
    MFA_METHODS: MFA_METHODS.slice(),
  };
}

module.exports = { createMfaCore, totpCode, verifyTotp, base32Encode, base32Decode, MFA_VERIFY_TTL_S, MFA_COOLDOWN_S, MFA_METHODS };
