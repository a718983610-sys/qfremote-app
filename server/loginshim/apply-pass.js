'use strict';
/*
 * QFRemote 申诉改密写库（root 运行，由 qfremote-appeal-setpass 包装脚本在
 * meshcentral 停服窗口内调用）。入参：spool 文件路径，内容
 * {username, salt, hash}（哈希由垫片用 MeshCentral 官方 pass.js 算好，
 * 明文密码不经过本脚本、不落盘）。
 * 写库方式与 account-kit/mcdb.js 同口径：整份用户文档追加一行（NeDB 后写者胜），
 * 写前整库备份到 /var/backups/qfremote/manual/。
 * 注意：mcdb 的 resetpass 对站长/服务账号有硬拒绝，那是「后台代改密」的防手滑闸；
 * 本通道是用户亲定的冻结申诉恢复链（冻结规则站长账号同样适用、无豁免），
 * 闸门在人工审核批准 + 一次性凭证上，故此处不复制那道账号拒绝。
 */
const fs = require('fs');
const net = require('net');

const DB_FILE = '/opt/meshcentral/meshcentral-data/meshcentral.db';
const BACKUP_DIR = '/var/backups/qfremote/manual';

function serviceRunning() {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port: 8443, timeout: 1200 }, () => { sock.destroy(); resolve(true); });
    sock.on('error', () => resolve(false));
    sock.on('timeout', () => { sock.destroy(); resolve(false); });
  });
}

(async () => {
  const spoolFile = process.argv[2];
  if (!spoolFile) { console.error('缺 spool 路径'); process.exit(2); }
  let spool;
  try { spool = JSON.parse(fs.readFileSync(spoolFile, 'utf8')); }
  catch (e) { console.error('spool 读不了：' + e.message); process.exit(2); }
  const username = String(spool.username || '').trim().toLowerCase();
  if (!username || !spool.salt || !spool.hash) { console.error('spool 内容不全'); process.exit(2); }
  if (await serviceRunning()) { console.error('拒绝执行：meshcentral 还在运行（8443 可连），必须停服窗口内写库。'); process.exit(3); }

  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const bak = BACKUP_DIR + '/meshcentral.db.bak-appeal-' + new Date().toISOString().replace(/[:.]/g, '-');
  fs.copyFileSync(DB_FILE, bak);

  const docs = new Map();
  for (const line of fs.readFileSync(DB_FILE, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let d; try { d = JSON.parse(line); } catch (e) { continue; }
    if (d && d._id) { if (d.$$deleted) docs.delete(d._id); else docs.set(d._id, d); }
  }
  const user = docs.get('user//' + username);
  if (!user) { console.error('账号不存在：' + username); process.exit(6); }
  user.salt = spool.salt;
  user.hash = spool.hash;
  user.passchange = Math.floor(Date.now() / 1000);
  fs.appendFileSync(DB_FILE, JSON.stringify(user) + '\n');
  console.log('OK user//' + username + ' backup=' + bak);
})().catch((e) => { console.error('写库失败：' + (e && e.message)); process.exit(1); });
