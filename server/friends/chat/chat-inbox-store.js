'use strict';
/*
 * QFRemote 聊天每收件人持久 inbox（S-079，2026-11-15，C-4）
 * ================================================================
 * 与 C-3 的 S-048/S-053 同一方案的服务端持久化一半：
 *  - C-3 落了内存结构：每收件人 inbox 数组＋inboxFloor＋emitEvent
 *    分发＋poll/catchup 的 gap 判定；但持久化仍走 chat-data.json
 *    单文件全量保存（Store.save() 每次 stringify 全部数据）。
 *  - 本模块把 inbox 的持久化改成分片追加写：每收件人一个文件
 *    <inboxDir>/by-user/<sha256(账号名)>.jsonl，每行一个事件 JSON。
 *    发送只追加一行（O(1)，不再全量重写）；剪枝时才整文件重写。
 *  - chat-data.json 不再存 inbox 数组（Store.save() 序列化时剔除）；
 *    inboxFloor 是每用户一个数字的小元数据，仍留 chat-data.json。
 *  - 密钥材料绝不进 inbox：事件只含密文（nonce/cipher）与元数据，
 *    与原内存事件同一形状。
 * 残留（下一阶段，不在本线动）：messages／vault／graveyard 仍在
 * chat-data.json 单文件全量保存；量大了须同样分片化。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function inboxDirOf(dataFile, inboxDirOverride) {
  return inboxDirOverride || path.join(path.dirname(dataFile), 'inbox', 'by-user');
}
function shardPath(dir, user) {
  const name = crypto.createHash('sha256').update(String(user)).digest('hex');
  return path.join(dir, name + '.jsonl');
}

/** 追加事件到某收件人的分片文件（发送路径，O(1)）。失败返回 false（调用方记日志、继续——消息正本在 d.messages 里，catchup 可按 seq 补回）。 */
function appendInboxEvents(dir, user, events) {
  if (!events || !events.length) return true;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const lines = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
    fs.appendFileSync(shardPath(dir, user), lines);
    return true;
  } catch (e) { return false; }
}

/** 读某收件人的分片文件（启动加载）。坏行跳过并计数，不拦启动。 */
function loadInbox(dir, user) {
  const file = shardPath(dir, user);
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { return { events: [], bad: 0, exists: false }; }
  const events = [];
  let bad = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { const ev = JSON.parse(line); if (ev && typeof ev.seq === 'number') events.push(ev); else bad++; }
    catch (e) { bad++; }
  }
  events.sort((a, b) => a.seq - b.seq);
  return { events, bad, exists: true };
}

/** 整文件重写某收件人的分片（剪枝路径，tmp+rename 原子）。 */
function rewriteInbox(dir, user, events) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = shardPath(dir, user);
    const tmp = file + '.tmp-' + process.pid + '-' + Date.now();
    fs.writeFileSync(tmp, events.map((e) => JSON.stringify(e)).join('\n') + (events.length ? '\n' : ''));
    fs.renameSync(tmp, file);
    return true;
  } catch (e) { return false; }
}

/** 列出分片目录下已有的用户（以文件名反推不到账号名——调用方须另有用户名单；本函数只返回 sha256 文件名集合，供“是否存在分片”判定用）。 */
function listShardFiles(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  } catch (e) { return []; }
}

module.exports = { inboxDirOf, shardPath, appendInboxEvents, loadInbox, rewriteInbox, listShardFiles };
