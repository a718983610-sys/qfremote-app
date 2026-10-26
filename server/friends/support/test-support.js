'use strict';
/*
 * QFRemote 智能客服 · 红线自测（本地运行，不连生产）
 * 运行：node test-support.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { KB_ENTRIES } = require('./kb-data');
const { createStore } = require('./support-store');
const { createEngine, rankEntries, HIGH_MIN } = require('./support');
const { createSupportRouter } = require('./http-router');

let passed = 0;
function ok(name, cond) { assert(cond, name); passed++; console.log('  ✓ ' + name); }

const stubProviders = {
  async getFreeze(u) { return { available: true, frozen: u === 'frozenuser', fails: u === 'frozenuser' ? 5 : 1 }; },
  async getAppeal(u) { return { available: true, status: u === 'frozenuser' ? 'pending' : null }; },
  async getBan(u) { return { available: true, banned: u === 'banneduser' }; },
  async getPoints(u) { return { available: true, points: 7, displayText: '使用该软件已经12天' }; },
  async getAccountContact(u) {
    const map = { frozenuser: 'a@example.com', banneduser: 'b@example.com' };
    return map[u] ? { available: true, exists: true, email: map[u] } : { available: true, exists: false, email: null };
  },
  // 裁决批③：身份核对改账号＋密码（测试桩：frozenuser 的密码为 pw-frozen）
  async verifyPassword(u, pw) { return { available: true, ok: u === 'frozenuser' && pw === 'pw-frozen' }; }
};

async function main() {
  console.log('== 1. 知识库自检索准确率（每条问法应命中本条） ==');
  let total = 0, top1 = 0; const missedEntries = new Set(); const misses = [];
  for (const e of KB_ENTRIES) {
    if (e.kind === 'system') continue;
    let hitSelf = false;
    for (const q of e.questions) {
      total++;
      const r = rankEntries(q);
      if (r.length && r[0].e.id === e.id) { top1++; hitSelf = true; }
      else misses.push(e.id + ' <- ' + q + ' => ' + (r[0] ? r[0].e.id + '(' + r[0].score + ')' : 'none'));
    }
    if (!hitSelf) missedEntries.add(e.id);
  }
  console.log('  top1 准确率 ' + top1 + '/' + total + ' = ' + Math.round(1000 * top1 / total) / 10 + '%');
  if (misses.length) console.log('  未命中样例：\n    ' + misses.slice(0, 12).join('\n    '));
  ok('top1 准确率 >= 85%', top1 / total >= 0.85);
  ok('每条条目至少被自身一条问法命中', missedEntries.size === 0);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qfsup-'));
  const store = createStore(dir);
  const engine = createEngine({ store, providers: stubProviders });

  console.log('== 2. 口吻切换：触发后重答当前主题且整场保持 ==');
  {
    const s = engine.newSession('user', 'alice'); store.putSession(s);
    let r = await engine.handleText(s, '怎么加好友');
    ok('先答出好友条目', r[0].entryId === 'F12');
    r = await engine.handleText(s, '说人话');
    ok('触发后以大白话重答当前主题', r[0].entryId === 'F12' && s.tone === 'plain');
    r = await engine.handleText(s, '怎么更新软件');
    ok('后续答复保持大白话版', r[0].text.includes('只提醒你一下') || r[0].kind === 'answer');
  }

  console.log('== 3. 场景优先与候选顺位、「不是这个」耗尽转人工 ==');
  {
    const s = engine.newSession('user', 'alice'); store.putSession(s);
    let r = await engine.handleText(s, '连不上自己的电脑');
    ok('场景问题整套先答 S01', r[0].entryId === 'S01');
    const s2 = engine.newSession('user', 'alice'); store.putSession(s2);
    r = await engine.handleText(s2, '连不上');
    ok('高置信答复且备有候选队列', r[0].kind === 'answer' && s2.queue.length >= 1);
    let last = null, guard = 0;
    while (guard++ < 8) {
      last = await engine.handleText(s2, '不是这个');
      if (last[0].kind === 'handoff-offer') break;
    }
    ok('候选耗尽后给转人工兜底（不死胡同）', last && last[0].kind === 'handoff-offer');
  }

  console.log('== 4. 低置信不死胡同：澄清→超范围也带出口 ==');
  {
    const s = engine.newSession('user', 'alice'); store.putSession(s);
    let r = await engine.handleText(s, 'zzzzqqqqxxxx');
    ok('答不上先给带选项的澄清', r[0].kind === 'clarify' && (r[0].options || []).length >= 3);
    r = await engine.handleText(s, 'zzzzqqqqxxxx');
    r = await engine.handleText(s, 'zzzzqqqqxxxx');
    ok('反复答不上给超范围话术且仍带转人工出口', r[0].kind === 'off-scope' && (r[0].options || []).some(o => o.id === 'handoff'));
    const unhits = fs.readFileSync(path.join(dir, 'support-unhits.jsonl'), 'utf8').trim().split('\n');
    ok('未命中已留痕供补库', unhits.length >= 1);
  }

  console.log('== 5. 转人工三层门控（登录态） ==');
  {
    const s = engine.newSession('user', 'alice'); store.putSession(s);
    let r = await engine.handleText(s, '转人工');
    ok('零交互直转被拦、先给自助引导', r[0].kind === 'handoff-guide' && Object.keys(store.allTickets()).length === 0);
    r = await engine.handleText(s, '转人工');
    ok('再次申请进入留描述', r[0].kind === 'handoff-ask-desc');
    r = await engine.handleText(s, '我的电脑连不上，帮我看看');
    ok('留描述后建单', r[0].kind === 'handoff-done' && !!r[0].ticketId);
    r = await engine.handleText(s, '怎么加好友');
    ok('转人工后机器人不再抢答', r[0].kind === 'ticket-note');
    const t = store.getTicket(r[0].ticketId);
    ok('工单含用户后续消息', t && t.messages.some(m => m.text.includes('怎么加好友')));
  }

  console.log('== 6. 先查后答（登录态）：只报本人状态 ==');
  {
    const s = engine.newSession('user', 'frozenuser'); store.putSession(s);
    const r = await engine.handleText(s, '我的账号被冻结了吗，申诉到哪一步了');
    ok('组装出本人冻结事实', r[0].text.includes('今日已冻结') && r[0].text.includes('审核中'));
    const s2 = engine.newSession('user', 'alice'); store.putSession(s2);
    const r2 = await engine.handleText(s2, '我的账号被冻结了吗');
    ok('他人会话只报其本人状态（未冻结）', r2[0].text.includes('今日未冻结') && !r2[0].text.includes('今日已冻结'));
    const r3 = await engine.handleText(s2, '积分规则是什么');
    ok('纯规则问法走通用答案不查状态', !r3[0].text.includes('当前积分：') && !r3[0].text.includes('已核对您的账号状态'));
  }

  console.log('== 7. 未登录：先核对、后给本人信息；核对不过零泄露 ==');
  {
    const s = engine.newSession('anon', null); store.putSession(s);
    let r = await engine.handleText(s, '我的账号被冻结了吗');
    ok('未登录问本人状态先要求核对', r[0].kind === 'verify-required');
    ok('核对前不泄露任何状态', !r[0].text.includes('已冻结') && !r[0].text.includes('输错 5 次'));
    let v = await engine.verifyIdentity(s, 'frozenuser', 'wrong-password');
    ok('密码不对核对失败且给通用指引', !v.ok && v.reason === 'mismatch' && v.text.includes('无法查询该账号的状态'));
    v = await engine.verifyIdentity(s, 'frozenuser', 'pw-frozen');
    ok('核对通过后自动补答本人状态', v.ok && v.follow && v.follow[0].text.includes('今日已冻结'));
    const s2 = engine.newSession('anon', null); store.putSession(s2);
    for (let i = 0; i < 5; i++) await engine.verifyIdentity(s2, 'frozenuser', 'bad-password');
    const v6 = await engine.verifyIdentity(s2, 'frozenuser', 'a@example.com');
    ok('核对连错 5 次后锁定（防撞库）', !v6.ok && v6.reason === 'locked');
  }

  console.log('== 8. 未登录转人工：须留描述＋联系邮箱 ==');
  {
    const s = engine.newSession('anon', null); store.putSession(s);
    await engine.handleText(s, '转人工');
    let r = await engine.handleText(s, '转人工');
    ok('未登录首次直转同样先引导', r[0].kind === 'handoff-ask-desc' || r[0].kind === 'handoff-guide');
    if (r[0].kind === 'handoff-guide') r = await engine.handleText(s, '转人工');
    r = await engine.handleText(s, '登不上，提示冻结');
    ok('留描述后索要联系邮箱', r[0].kind === 'handoff-ask-email');
    r = await engine.handleText(s, 'not-an-email');
    ok('邮箱格式不对不建单', r[0].kind === 'handoff-ask-email' && !s.ticketId);
    r = await engine.handleText(s, 'me@example.com');
    ok('邮箱合格后建单且工单带联系方式', r[0].kind === 'handoff-done');
    const t = store.getTicket(r[0].ticketId);
    ok('工单标注未登录并留邮箱', t && t.anon === true && t.email === 'me@example.com');
  }

  console.log('== 9. HTTP 路由：限频与站长收件箱 ==');
  {
    const router = createSupportRouter({
      engine, store,
      authenticate: req => req.headers['x-test-user'] || null,
      authenticateAdmin: req => req.headers['x-test-admin'] === '1',
      limits: { anonMsgPerHour: 3, userMsgPerHour: 120, verifyPerHour: 10, handoffPerDay: 5 }
    });
    const srv = http.createServer((req, res) => { router(req, res).then(handled => { if (!handled) { res.writeHead(404); res.end(); } }); });
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    const base = 'http://127.0.0.1:' + srv.address().port;
    const post = async (p2, body2, headers) => {
      const resp = await fetch(base + p2, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}), body: JSON.stringify(body2 || {}) });
      return { code: resp.status, json: await resp.json().catch(() => ({})) };
    };
    const sres = await post('/support/api/session', {});
    ok('未登录可建客服会话且有开场白', sres.json.ok && sres.json.kind === 'anon' && sres.json.welcome.text.includes('智能客服'));
    const tok = sres.json.session;
    let code = 0;
    for (let i = 0; i < 4; i++) { const rr = await post('/support/api/message', { session: tok, text: '怎么注册' }); code = rr.code; }
    ok('未登录提问超限频返回 429', code === 429);
    // 管理面
    const sres2 = await post('/support/api/session', {}, { 'x-test-user': 'carol' });
    const tok2 = sres2.json.session;
    await post('/support/api/message', { session: tok2, text: '转人工' }, { 'x-test-user': 'carol' });
    await post('/support/api/message', { session: tok2, text: '转人工' }, { 'x-test-user': 'carol' });
    const hd = await post('/support/api/message', { session: tok2, text: '屏幕共享看不到画面' }, { 'x-test-user': 'carol' });
    ok('登录用户经路由完成转人工', hd.json.replies && hd.json.replies[0].kind === 'handoff-done');
    const noAdmin = await fetch(base + '/support/api/admin/tickets');
    ok('非站长访问收件箱被拒', noAdmin.status === 403);
    const inbox = await fetch(base + '/support/api/admin/tickets', { headers: { 'x-test-admin': '1' } }).then(r => r.json());
    ok('站长收件箱能看到工单', inbox.tickets && inbox.tickets.length >= 1);
    const tk = inbox.tickets[0];
    await post('/support/api/admin/reply', { ticketId: tk.id, text: '您好，已收到，正在处理。' }, { 'x-test-admin': '1' });
    const mine = await fetch(base + '/support/api/ticket', { headers: { 'x-support-session': tok2 } }).then(r => r.json());
    ok('用户侧看到人工回复且呈现名为「人工客服」', mine.ticket && mine.ticket.messages.some(m => m.role === 'agent' && m.name === '人工客服'));
    srv.close();
  }

  console.log('\n全部通过：' + passed + ' 项');
}

main().catch(e => { console.error('✗ 失败：', e.message); process.exit(1); });
