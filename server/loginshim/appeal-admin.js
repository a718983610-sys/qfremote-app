'use strict';
/*
 * QFRemote 登录申诉审核执行接口（服务器本机、root 运行）。
 * 申诉由助手在聊天里请站长拍板后执行本脚本，不许自行批准/驳回。
 *   node appeal-admin.js list                 列出待审申诉（JSON）
 *   node appeal-admin.js approve <账号>       批准：生成一次性改密凭证，状态置「已通过」
 *   node appeal-admin.js reject <账号> <原因> 驳回：状态置「已驳回」，原因照录
 * 只改 appeals.json，不动冻结状态（解冻在用户改密成功时由垫片清除，
 * 或次日 0 点按日期键自然失效）。与垫片同文件并发写的风险窗口极小（原子换名）。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE = process.env.QF_APPEALS_FILE || '/opt/qfremote-loginshim/data/appeals.json';

function load() {
  try { const v = JSON.parse(fs.readFileSync(FILE, 'utf8')); if (v && Array.isArray(v.appeals)) { v.appeals = v.appeals.filter((a) => a && typeof a === 'object'); return v; } } catch (e) {}
  return { appeals: [] };
}
function save(data) {
  const tmp = FILE + '.tmp-admin';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
  // 文件平时归垫片（nobody）所有；本脚本以 root 改写后必须把所有权归还，
  // 否则垫片读不了申诉数据（0600）。按数据目录的属主对齐。
  try {
    const st = fs.statSync(path.dirname(FILE));
    fs.chownSync(FILE, st.uid, st.gid);
    fs.chmodSync(FILE, 0o600);
  } catch (e) { console.error('警告：申诉文件所有权归还失败：' + e.message); }
}
function key(name) { return String(name || '').trim().toLowerCase(); }
function findPending(data, k) {
  let best = null;
  for (const a of data.appeals) {
    if (a.key === k && a.status === 'pending' && (!best || a.createdAt > best.createdAt)) best = a;
  }
  return best;
}

/* ===== 统一申诉（阶段 C-2）：代审通道与站长后台同队列同台账，经内网接口裁决（§6.4 防双判） =====
 *   node appeal-admin.js list2                       列出全部待审（含统一封禁申诉）
 *   node appeal-admin.js decide <申诉编号> approve   通过（联动解封/恢复原密钥；换绑申诉则立即执行换绑）
 *   node appeal-admin.js decide <申诉编号> reject <原因>
 * 换绑申诉（type=rebind，§11.9）与封禁申诉同队列：list2 带 kind=rebind 与
 * 槽位/设备字段，decide 同一入口裁决，防双判口径一致（ALREADY_DECIDED）。
 */
const http = require('http');
function licInternal(pathname, payload) {
  return new Promise((resolve) => {
    let secret = '';
    try { secret = fs.readFileSync(process.env.QFLIC_SECRET_FILE || '/opt/qfremote-license/internal.secret', 'utf8').trim(); } catch (e) { return resolve(null); }
    if (!secret) return resolve(null);
    const body = JSON.stringify(payload || {});
    const r = http.request({ hostname: '127.0.0.1', port: 8448, path: pathname, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'X-QF-Internal-Secret': secret }, timeout: 15000 }, (resp) => {
      const chunks = [];
      resp.on('data', (c) => chunks.push(c));
      resp.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { resolve(null); } });
    });
    r.on('timeout', () => { r.destroy(); resolve(null); });
    r.on('error', () => resolve(null));
    r.write(body); r.end();
  });
}
if (process.argv[2] === 'list2' || process.argv[2] === 'decide') {
  const data0 = load();
  if (process.argv[2] === 'list2') {
    const pending = data0.appeals.filter((a) => a.status === 'pending')
      .map((a) => ({ id: a.id, username: a.username, email: a.email, kind: a.type === 'rebind' ? 'rebind' : (a.banId ? 'unified' : 'B1-freeze'), reasonCode: a.reasonCode || 'B1', banId: a.banId || null, freezeDay: a.freezeDay || '', createdAt: a.createdAt, desc: a.desc, platform: a.platform || '', channel: a.channel || '', oldDeviceCode: a.oldDeviceCode || '', newDeviceCodeHash: a.newDeviceCodeHash || '', executionNote: a.executionNote || '' }));
    console.log(JSON.stringify({ ok: true, pending }, null, 1));
    process.exit(0);
  }
  (async () => {
    const appealId = process.argv[3];
    const decision = process.argv[4];
    const reason = process.argv.slice(5).join(' ').trim();
    if (!appealId || !['approve', 'reject'].includes(decision)) { console.error('用法：decide <申诉编号> approve | reject <原因>'); process.exit(2); }
    const out = await licInternal('/internal/license/appeal-decide', { appealId, decision, reason, actor: 'assistant' });
    if (!out) { console.error('许可服务不可达或内网密钥不可读，裁决未执行。'); process.exit(1); }
    console.log(JSON.stringify(out, null, 1));
    process.exit(out.ok ? 0 : 1);
  })();
} else {

const cmd = process.argv[2];
const data = load();
if (cmd === 'list') {
  const pending = data.appeals.filter((a) => a.status === 'pending')
    .map((a) => ({ id: a.id, username: a.username, email: a.email, freezeDay: a.freezeDay, createdAt: a.createdAt, desc: a.desc }));
  console.log(JSON.stringify({ ok: true, pending }, null, 1));
} else if (cmd === 'approve' || cmd === 'reject') {
  const name = process.argv[3];
  if (!name) { console.error('用法：' + cmd + ' <账号>' + (cmd === 'reject' ? ' <原因>' : '')); process.exit(2); }
  const a = findPending(data, key(name));
  if (!a) { console.error('没有找到该账号的待审申诉：' + name); process.exit(1); }
  if (cmd === 'approve') {
    a.status = 'approved';
    a.token = crypto.randomBytes(24).toString('hex');
    a.decidedAt = new Date().toISOString();
    delete a.reason;
    save(data);
    console.log(JSON.stringify({ ok: true, action: 'approved', username: a.username, appealId: a.id, note: '一次性改密凭证已生成，用户在申诉进度页点「修改密码」即可设新密码。' }));
  } else {
    const reason = process.argv.slice(4).join(' ').trim();
    if (!reason) { console.error('驳回必须带原因（站长给词、照录）'); process.exit(2); }
    a.status = 'rejected';
    a.reason = reason;
    a.decidedAt = new Date().toISOString();
    delete a.token;
    save(data);
    console.log(JSON.stringify({ ok: true, action: 'rejected', username: a.username, appealId: a.id, reason }));
  }
} else {
  console.error('未知命令：' + cmd + '（list|approve|reject|list2|decide）');
  process.exit(2);
}
}
