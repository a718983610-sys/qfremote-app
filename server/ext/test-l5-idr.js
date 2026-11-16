'use strict';
// L5 RC-03 自检：IDR 请求准入控制（QF-VIDEO-1，大肥鱼复核数值）。
// 运行：node server/ext/test-l5-idr.js（无外部依赖，退出码 0=通过）。
const { createIdrGate } = require('./idr-core');

let passed = 0, failed = 0;
function t(name, cond, extra) {
  if (cond) { passed++; console.log('ok  -', name); }
  else { failed++; console.log('FAIL-', name, extra || ''); }
}
const logs = [];
const gate = createIdrGate({ log: (e) => logs.push(e) });
let now = 1000000;
function req(sessionId, userId, agentId, seq, reason, at) {
  return gate.request({ sessionId, userId, agentId, seq, reason, nowMs: at !== undefined ? at : now });
}
gate.bind('s1', 'alice', 'ag1', now);
gate.bind('s2', 'alice', 'ag1', now);

// 1) 未绑定会话拒绝；冒用他人会话拒绝；任意 sessionId 拒绝
t('reject-no-session', req('sX', 'alice', 'ag1', 1).code === 'NO_SESSION');
t('reject-wrong-user', req('s1', 'bob', 'ag1', 1).code === 'NOT_BOUND');
t('reject-wrong-agent', req('s1', 'alice', 'ag2', 1).code === 'NOT_BOUND');
// 2) reason 白名单；seq 单调递增防重放
t('reject-bad-reason', req('s1', 'alice', 'ag1', 1, 'spam').code === 'BAD_REASON');
let r = req('s1', 'alice', 'ag1', 1, 'loss');
t('first-forward', r.decision === 'forward', JSON.stringify(r));
t('reject-replay-same-seq', req('s1', 'alice', 'ag1', 1, 'loss').code === 'REPLAY');
t('reject-replay-old-seq', req('s1', 'alice', 'ag1', 0, 'loss').code === 'REPLAY');
// 3) 同 reason 合并窗口：loss 1s 内第二次合并（seq 仍消费）
r = req('s1', 'alice', 'ag1', 2, 'loss', now + 500);
t('coalesce-loss-1s', r.decision === 'coalesced' && r.code === 'COALESCED', JSON.stringify(r));
r = req('s1', 'alice', 'ag1', 3, 'loss', now + 1500);
t('forward-after-coalesce-window', r.decision === 'forward', JSON.stringify(r));
// 4) 硬上限 1/s：同一秒内第二次放行请求被硬上限拦（不同 reason 也不行）
r = req('s1', 'alice', 'ag1', 4, 'quality-change', now + 1600);
t('hard-limit-1-per-sec', r.decision === 'rejected' && r.code === 'HARD_LIMIT', JSON.stringify(r));
// 5) 令牌桶：burst=2，连续请求耗尽后拒绝
gate.bind('s3', 'alice', 'ag1', now);
const seqs = [1, 2, 3, 4, 5];
const outs = seqs.map((s, i) => req('s3', 'alice', 'ag1', s, 'loss', now + 2000 + i * 3000).decision);
t('session-bucket-burst2-then-refill', outs[0] === 'forward' && outs[1] === 'forward' && outs[2] === 'forward', JSON.stringify(outs));
// 注：0.5/s 令牌桶，3s 间隔回 1.5 个令牌，3 次放行符合预期；
// 再以 1.5s 间隔连发（躲开 1s 合并窗口）：每发净耗 0.25 个令牌，
// 第 6 发时桶空或撞 5/10s 硬上限，必被拒绝。
const drain = [6, 7, 8, 9, 10, 11].map((s, i) => req('s3', 'alice', 'ag1', s, 'loss', now + 20000 + i * 1500).decision);
t('session-bucket-eventual-reject', drain[5] === 'rejected', JSON.stringify(drain));
// 6) 连续超限 3 次 → 10s 冷却（每 100ms 连发，reason 轮换躲合并窗口：
// 首次放行后硬上限 1/s 连续拒绝，第 3 次拒绝时挂冷却，其后返回 COOLDOWN）
gate.bind('s4', 'alice', 'ag1', now);
const reasons = ['loss', 'quality-change', 'join', 'loss', 'quality-change', 'join', 'loss'];
const codes = reasons.map((rsn, i) => req('s4', 'alice', 'ag1', i + 1, rsn, now + i * 100).code);
t('cooldown-triggered', codes[0] === 'OK' && codes.includes('COOLDOWN'), JSON.stringify(codes));
t('cooldown-logged', logs.some((e) => e.ev === 'idr-cooldown'), JSON.stringify(logs.map((e) => e.ev)));
// 7) join 宽限：会话建立 10s 内首次 join 不占令牌桶
gate.bind('s5', 'alice', 'ag1', now);
r = req('s5', 'alice', 'ag1', 1, 'join', now + 100);
t('join-grace-forward', r.decision === 'forward', JSON.stringify(r));
r = req('s5', 'alice', 'ag1', 2, 'join', now + 200);
t('join-grace-only-once', r.decision !== 'forward', JSON.stringify(r)); // 第二次 join 受合并窗口/桶约束
// 8) 拒绝与合并均记审计（只记元数据）
t('audit-logs-present', logs.some((e) => e.ev === 'idr-rejected') && logs.some((e) => e.ev === 'idr-coalesced'), JSON.stringify(logs.map((e) => e.ev)));
// 9) 多观看端同 session 合并：同一 session 不同 seq 的 loss 请求在窗口内只放行一次
gate.bind('s6', 'alice', 'ag1', now);
const w1 = req('s6', 'alice', 'ag1', 1, 'loss', now);
const w2 = req('s6', 'alice', 'ag1', 2, 'loss', now + 300);
t('multi-viewer-coalesced', w1.decision === 'forward' && w2.decision === 'coalesced', JSON.stringify([w1.decision, w2.decision]));

console.log(`\nRC-03 IDR: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
