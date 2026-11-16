'use strict';
/*
 * QFRemote 智能客服 · contacts 映射导出（N 线阶段一交付，部署在服务器侧运行）
 * ================================================================
 * 用途：为智能客服「未登录身份核对」提供只读映射 contacts.json
 *   { "<小写登录名>": "<注册/资料邮箱>" }
 * 数据来源：MeshCentral 用户记录的 email 字段，经官方控制通道以好友服务
 * 执行账号（qf-socialsvc，凭据只存在于服务器 /opt/qfremote-friends/config.json）
 * 发 users 命令读取——与好友服务 listUsers 同一条官方通道，不直读、不直写
 * MeshCentral 数据库，服务账号凭据不打印、不落本地明文、不进日志。
 *
 * 重要实情（2026-10-25 核查）：现行自助注册只填账号＋密码，不采集邮箱；
 * 后台开户同样不写 email。因此 contacts 的实际覆盖取决于用户是否在控制台
 * 「我的账户」里填过邮箱，未填邮箱的账号不会出现在映射里，其未登录核对
 * 会按模块既定降级返回「不可用/通用指引」，不影响其余客服功能。
 *
 * 用法（服务器本机，root 或 qffriends 均可，须能读 friends 配置）：
 *   node export-contacts.js [--dry-run] [--config <path>] [--out <path>]
 *   --dry-run 只打印统计（账号总数/带邮箱数），不写文件、不打印任何邮箱值。
 * 默认：config=/opt/qfremote-friends/config.json，
 *       out=<config.stateFile 同级目录>/contacts.json（即 data/contacts.json）。
 * 输出：原子写（tmp+rename），0600 起写后尽量收紧为 0640 并交回数据目录属主
 *       （照 account-kit mcdb.js 的 chownBack 口径），保证 qffriends 可读。
 */
const fs = require('fs');
const path = require('path');

function loadWebSocket() {
  return require('ws');
}

// 与好友服务 server.js 的 mcConnect/mcCall 同口径：以服务账号凭据开控制
// 通道，收到服务器下发的 userinfo 才算连通，随后发一条命令等回执。
function mcConnect(cfg, timeoutMs) {
  return new Promise((resolve, reject) => {
    const WebSocket = loadWebSocket();
    const auth = Buffer.from(cfg.svcUser).toString('base64') + ',' + Buffer.from(cfg.svcPass).toString('base64');
    const ws = new WebSocket(cfg.mcUrl || 'wss://127.0.0.1:8443/control.ashx', { rejectUnauthorized: false, headers: { 'x-meshauth': auth } });
    let done = false;
    const timer = setTimeout(() => finish(new Error('mc-connect-timeout')), timeoutMs || 10000);
    function finish(err, sess) { if (done) return; done = true; clearTimeout(timer); if (err) { try { ws.close(); } catch (e) {} reject(err); } else resolve(sess); }
    const sess = { ws, userinfo: null, waiters: [], send(obj) { ws.send(JSON.stringify(obj)); } };
    ws.on('message', (data) => {
      let m; try { m = JSON.parse(data.toString()); } catch (e) { return; }
      if (m && m.action === 'userinfo' && m.userinfo) { sess.userinfo = m.userinfo; finish(null, sess); return; }
      for (let i = 0; i < sess.waiters.length; i++) {
        if (sess.waiters[i].match(m)) { const w = sess.waiters.splice(i, 1)[0]; w.resolve(m); return; }
      }
    });
    ws.on('error', () => finish(new Error('mc-conn-error')));
    ws.on('close', () => finish(new Error('mc-auth-failed')));
  });
}
function mcCall(sess, obj, timeoutMs) {
  return new Promise((resolve, reject) => {
    const rid = 'qfcontacts-' + Math.random().toString(16).slice(2, 10);
    obj.responseid = rid; obj.tag = rid;
    const w = { match: (m) => m && (m.responseid === rid || m.tag === rid), resolve: null };
    const timer = setTimeout(() => { const i = sess.waiters.indexOf(w); if (i >= 0) sess.waiters.splice(i, 1); reject(new Error('mc-call-timeout')); }, timeoutMs || 10000);
    w.resolve = (m) => { clearTimeout(timer); resolve(m); };
    sess.waiters.push(w);
    sess.send(obj);
  });
}

// 纯函数（可单测）：users 命令回包 → { contacts, total, withEmail }
// 登录名口径与好友服务 listUsers 一致：从 _id 拆 user/<域>/<登录名> 并小写。
// email 只接受字符串且含 '@'；同一登录名后到者覆盖先到者（与 DB 最终态一致）。
function parseUsersResponse(users) {
  const contacts = {};
  let total = 0;
  for (const u of (users || [])) {
    const rawId = String((u && u._id) || '');
    if (!rawId.startsWith('user/')) continue; // 只认用户记录，其余类型不计
    const login = rawId.replace(/^user\/[^/]*\//, '').toLowerCase();
    if (!login) continue;
    total++;
    const email = typeof u.email === 'string' ? u.email.trim().toLowerCase() : '';
    if (email && email.includes('@')) contacts[login] = email;
  }
  return { contacts, total, withEmail: Object.keys(contacts).length };
}

function chownBackToDirOwner(file) {
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) return;
  try { const st = fs.statSync(path.dirname(file)); fs.chownSync(file, st.uid, st.gid); } catch (e) { /* 交不回去不拦正事 */ }
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const argVal = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
  const cfgPath = argVal('--config') || process.env.QFCONTACTS_CONFIG || '/opt/qfremote-friends/config.json';
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  if (!cfg.svcUser || !cfg.svcPass) { console.error('配置里没有服务账号凭据，无法导出。'); process.exit(2); }
  const outFile = argVal('--out') || process.env.QFCONTACTS_OUT ||
    path.join(cfg.stateFile ? path.dirname(cfg.stateFile) : '/opt/qfremote-friends/data', 'contacts.json');

  const sess = await mcConnect(cfg);
  let res;
  try { res = await mcCall(sess, { action: 'users' }); }
  finally { try { sess.ws.close(); } catch (e) {} }
  const { contacts, total, withEmail } = parseUsersResponse(res && res.users);
  // 只报计数，绝不打印任何邮箱值或凭据
  console.log('用户总数 ' + total + '，其中带邮箱 ' + withEmail + '，将写入映射 ' + withEmail + ' 条。');
  if (dryRun) { console.log('dry-run：未写文件。'); return; }
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const tmp = outFile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(contacts, null, 1), { mode: 0o640 });
  fs.renameSync(tmp, outFile);
  try { fs.chmodSync(outFile, 0o640); } catch (e) {}
  chownBackToDirOwner(outFile);
  console.log('已写入 ' + outFile + '（0640，属主已交回数据目录属主）。');
}

if (require.main === module) main().catch((e) => { console.error('导出失败：' + (e && e.message)); process.exit(1); });
module.exports = { parseUsersResponse };
