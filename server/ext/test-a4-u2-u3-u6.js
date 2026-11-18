'use strict';
/*
 * A4 安全修复线（U2/U3/U6）模块级测试
 * =====================================
 * 运行：node server/ext/test-a4-u2-u3-u6.js（在 a4-fix-20261118 工作副本内）
 * 只测工作树内模块；不碰生产、不联网、不启动 server.js。
 * U6 回退测试用 /tmp 隔离副本（复制 lea/ 目录，删父级 qf-diagnostics.js，
 * 再删 forbidden-keys.js 测双重失败 fail-closed）。
 * 退出码：0 全过；1 有失败。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const EXT = __dirname;
const FOUR = ['credit_card', 'card_number', 'ssn', 'idcard'];

let pass = 0, fail = 0;
function t(name, cond, extra) {
  if (cond) { pass++; console.log('ok  -', name); }
  else { fail++; console.log('FAIL-', name, extra === undefined ? '' : JSON.stringify(extra)); }
}
function throws(fn) { try { fn(); return null; } catch (e) { return e; } }

// ---------- U6：共享禁键正本 ----------
{
  const fk = require(path.join(EXT, 'lea', 'forbidden-keys.js'));
  t('u6:forbidden-keys-31', Array.isArray(fk.FORBIDDEN_KEYS) && fk.FORBIDDEN_KEYS.length === 31, fk.FORBIDDEN_KEYS && fk.FORBIDDEN_KEYS.length);
  t('u6:forbidden-keys-has-four', FOUR.every((k) => fk.FORBIDDEN_KEYS.includes(k)));
  t('u6:forbidden-keys-no-dup', new Set(fk.FORBIDDEN_KEYS).size === fk.FORBIDDEN_KEYS.length);
  t('u6:forbidden-keys-frozen', Object.isFrozen(fk.FORBIDDEN_KEYS));
  const d = require(path.join(EXT, 'qf-diagnostics.js'));
  t('u6:diag-set-equals-shared', d.FORBIDDEN_KEYS.size === 31 && fk.FORBIDDEN_KEYS.every((k) => d.FORBIDDEN_KEYS.has(k)));
  const s = d.scrubForbiddenKeys({ credit_card: '4111111111111111', card_number: '4111', ssn: '123-45-6789', idcard: '110101199001011234', CREDIT_CARD: 'x', Ssn: 'y', user: 'alice', note: 'hi' });
  t('u6:diag-scrub-drops-four', s.credit_card === undefined && s.card_number === undefined && s.ssn === undefined && s.idcard === undefined && s.CREDIT_CARD === undefined && s.Ssn === undefined && s.user === 'alice' && s.note === 'hi', s);
}
console.log('---');

// ---------- U6：lea-core 正常路径与回退路径（audit 行为） ----------
function auditDropsFour(core, dir) {
  const rec = core.audit('a4-test', { credit_card: '4111111111111111', card_number: '4111', ssn: '123-45-6789', idcard: '110101199001011234', user: 'alice' });
  if (!rec) return { ok: false, why: 'audit-returned-null' };
  const fourGone = FOUR.every((k) => rec[k] === undefined) && rec.user === 'alice';
  const files = fs.readdirSync(dir).filter((n) => /^audit-.*\.jsonl$/.test(n));
  if (!files.length) return { ok: false, why: 'no-audit-file' };
  const line = fs.readFileSync(path.join(dir, files[0]), 'utf8').trim().split('\n').pop();
  const onDisk = JSON.parse(line);
  const diskGone = FOUR.every((k) => onDisk[k] === undefined) && onDisk.user === 'alice';
  return { ok: fourGone && diskGone, rec, onDisk };
}
{
  const leaCore = require(path.join(EXT, 'lea', 'lea-core.js'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'a4-lea-normal-'));
  const core = leaCore.createLeaCore({ dir: tmp, log: () => {}, enableSweeps: false });
  const r = auditDropsFour(core, tmp);
  t('u6:lea-normal-audit-drops-four', r.ok === true, r.why || r.rec);
  fs.rmSync(tmp, { recursive: true, force: true });
}
{
  // 回退路径：复制 lea/ 到隔离目录，父级无 qf-diagnostics.js → 走 catch 回退。
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'a4-lea-fallback-'));
  const leaCopy = path.join(base, 'lea');
  fs.cpSync(path.join(EXT, 'lea'), leaCopy, { recursive: true });
  const dataDir = path.join(base, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const leaCoreFb = require(path.join(leaCopy, 'lea-core.js'));
  const core = leaCoreFb.createLeaCore({ dir: dataDir, log: () => {}, enableSweeps: false });
  const r = auditDropsFour(core, dataDir);
  t('u6:lea-fallback-audit-drops-four', r.ok === true, r.why || r.rec);
  fs.rmSync(base, { recursive: true, force: true });
}
{
  // 双重失败：回退用的 forbidden-keys.js 也不存在 → require 直接抛错（fail-closed）。
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'a4-lea-df-'));
  const leaCopy = path.join(base, 'lea');
  fs.cpSync(path.join(EXT, 'lea'), leaCopy, { recursive: true });
  fs.unlinkSync(path.join(leaCopy, 'forbidden-keys.js'));
  const err = throws(() => require(path.join(leaCopy, 'lea-core.js')));
  t('u6:lea-double-failure-throws', !!err, err && err.message);
  fs.rmSync(base, { recursive: true, force: true });
}
console.log('---');

// ---------- U3：idr-core（校验器注入、重验、过期） ----------
{
  const idr = require(path.join(EXT, 'idr-core.js'));
  let now = 1000000;
  // 校验器桩：只有 alice 拥有 ag1/ag2；revoked 集合可动态改（模拟换绑/解绑）。
  const revoked = new Set();
  const verify = (u, a) => ((u === 'alice' && (a === 'ag1' || a === 'ag2')) || (u === 'bob' && a === 'agB')) && !revoked.has(u + ':' + a);
  const logs = [];
  const gate = idr.createIdrGate({ log: (e) => logs.push(e), verifyAgent: verify });
  const req = (sid, u, a, seq, reason, at) => gate.request({ sessionId: sid, userId: u, agentId: a, seq, reason, nowMs: at !== undefined ? at : now });

  // 无校验器 → bind 一律拒绝（fail-closed）。
  const gateNoV = idr.createIdrGate({ log: () => {} });
  t('u3:bind-without-verifier-refused', gateNoV.bind('nv1', 'alice', 'ag1', now) === null);
  t('u3:no-verifier-request-no-session', gateNoV.request({ sessionId: 'nv1', userId: 'alice', agentId: 'ag1', seq: 1, reason: 'loss', nowMs: now }).code === 'NO_SESSION');

  // 伪造 agent 绑定被拒；不存在的 agent 被拒；合法绑定成功。
  t('u3:bind-forged-agent-refused', gate.bind('f1', 'alice', 'agB', now) === null);
  t('u3:bind-ghost-agent-refused', gate.bind('f2', 'alice', 'ghost', now) === null);
  t('u3:bind-legit-ok', !!gate.bind('s1', 'alice', 'ag1', now));
  // 已存在绑定不受后来 bind 影响：bob 拿自己的 agent 也抢不走 s1。
  gate.bind('s1', 'bob', 'agB', now);
  t('u3:existing-binding-not-stolen', req('s1', 'bob', 'agB', 1, 'loss').code === 'NOT_BOUND');
  t('u3:owner-request-forward', req('s1', 'alice', 'ag1', 1, 'loss').decision === 'forward');
  t('u3:wrong-agent-not-bound', req('s1', 'alice', 'ag2', 2, 'loss').code === 'NOT_BOUND');
  t('u3:replay-still-rejected', req('s1', 'alice', 'ag1', 1, 'loss').code === 'REPLAY');

  // 撤权复核：校验器翻转为不通过 → 请求被拒，且绑定不被删除（恢复后又能用）。
  revoked.add('alice:ag1');
  t('u3:reverify-after-revoke-refused', req('s1', 'alice', 'ag1', 2, 'loss').code === 'AGENT_NOT_BOUND');
  revoked.delete('alice:ag1');
  const afterRestore = req('s1', 'alice', 'ag1', 2, 'loss');
  t('u3:binding-survives-transient-reverify-fail', afterRestore.decision === 'forward' || afterRestore.decision === 'coalesced', afterRestore);

  // 限流/冷却矩阵（与 P1 line-3 同款序列，补校验器后重验；旧 line-3 的 idr 段
  // 因无校验器 bind 被拒而失效，本文件取代其 idr 覆盖）。放 sweep 之前：
  // bad-reason 测的是 s1，sweep 会把它丢弃。
  t('u3:bad-reason-rejected', req('s1', 'alice', 'ag1', 99, 'spam').code === 'BAD_REASON');
  {
    const g2 = idr.createIdrGate({ log: (e) => logs.push(e), verifyAgent: verify });
    g2.bind('c1', 'alice', 'ag1', now);
    const cReq = (seq, reason, at) => g2.request({ sessionId: 'c1', userId: 'alice', agentId: 'ag1', seq, reason, nowMs: at });
    const c0 = cReq(1, 'loss', now);
    const c1 = cReq(2, 'quality-change', now + 100);
    const c2 = cReq(3, 'join', now + 200);
    const c3 = cReq(4, 'quality-change', now + 300);
    t('u3:rate-limit-rejects', c0.decision === 'forward' && c1.code === 'HARD_LIMIT' && c2.code === 'HARD_LIMIT' && c3.code === 'HARD_LIMIT', { c0, c1, c2, c3 });
    const cool = cReq(5, 'loss', now + 400);
    t('u3:cooldown-after-3-rejects', cool.code === 'COOLDOWN' && typeof cool.retryAfterMs === 'number', cool);
    const afterCool = cReq(6, 'loss', now + 20000);
    t('u3:recovers-after-cooldown', afterCool.decision === 'forward' || afterCool.decision === 'coalesced', afterCool);
  }

  // 闲置过期：sweep 丢弃过期绑定；过期后 seq 从 0 重算（旧 seq 可再用＝新绑定）。
  gate.bind('s2', 'alice', 'ag2', now);
  req('s2', 'alice', 'ag2', 1, 'loss');
  const dropped = gate.sweep(now + 31 * 60 * 1000, 30 * 60 * 1000);
  t('u3:sweep-drops-idle-binding', dropped === 2, dropped); // s1、s2 均超 30 分钟闲置
  t('u3:expired-request-no-session', req('s2', 'alice', 'ag2', 2, 'loss', now + 31 * 60 * 1000).code === 'NO_SESSION');
  gate.bind('s2', 'alice', 'ag2', now + 31 * 60 * 1000);
  const reborn = req('s2', 'alice', 'ag2', 1, 'loss', now + 31 * 60 * 1000);
  t('u3:rebind-after-expiry-fresh-seq', reborn.decision === 'forward', reborn);
  // 未过期不丢：刚建的绑定 sweep 掉 0 个。
  t('u3:sweep-keeps-live-binding', gate.sweep(now + 31 * 60 * 1000, 30 * 60 * 1000) === 0);
  t('u3:bind-refused-logged', logs.some((e) => e.ev === 'idr-bind-refused'));
  t('u3:reverify-failed-logged', logs.some((e) => e.ev === 'idr-agent-reverify-failed'));
}
console.log('---');

// ---------- 客户端码表（新拒绝码本地映射） ----------
{
  const qfIdr = require(path.join(__dirname, '..', '..', 'windows', 'qf-idr.js'));
  t('u3:client-agent-not-bound-nonretryable', qfIdr.REJECTED_CODES.AGENT_NOT_BOUND && qfIdr.REJECTED_CODES.AGENT_NOT_BOUND.retryableNextTrigger === false, qfIdr.REJECTED_CODES.AGENT_NOT_BOUND);
  const qfQ = require(path.join(__dirname, '..', '..', 'windows', 'qf-quality.js'));
  t('u2:client-upgrade-forbidden-message', qfQ.UPGRADE_REFUSAL_MESSAGES.FORBIDDEN === '会话不属于当前用户', qfQ.UPGRADE_REFUSAL_MESSAGES.FORBIDDEN);
}
console.log('---');
console.log('TOTAL pass=' + pass + ' fail=' + fail);
process.exit(fail ? 1 : 0);
