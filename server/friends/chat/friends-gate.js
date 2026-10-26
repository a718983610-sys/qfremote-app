'use strict';
/*
 * 好友关系闸口（聊天服务与一期好友服务的合并契约）
 * ================================================================
 * 聊天服务只通过这一个接口问「A 和 B 是不是好友」：
 *   areFriends(a, b) -> boolean
 *   listFriends(a)   -> [账号名...]
 * 数据来源是一个 JSON 文件（路径由配置 friendsFile 给出）：
 *   { "pairs": [["alice01", "bob00002"], ...] }   // 无向对，成对出现即好友
 * 一期好友服务落地时，好友关系正本归它维护：它可以继续写这个文件
 * （申请/同意/删除/封禁联动的结果落成 pairs 的增减），也可以把本模块
 * 换成查它自己库的实现——接口不变，聊天服务一行不用改。
 * 文件不存在 = 没有任何好友关系（全部拒发），这是安全的默认。
 */
const fs = require('fs');

function norm(u) { return String(u || '').toLowerCase().trim(); }
function pairKey(a, b) { return JSON.stringify([norm(a), norm(b)].sort()); }

/*
 * 系统联系人（客服）预留位（用户 11:28 定，细节等专项方案）：
 *  - 保留账号名 SUPPORT_ACCOUNT：未来的客服号，一个真实的对话一方账号
 *    （由站长以该账号身份收与回），不是后端窥视口——A 案不破的原理见
 *    chat/DESIGN.md「系统联系人（客服）预留位」一节。
 *  - 语义三条，先在数据层占死：① 默认在每个人的好友列表里（peers 恒含）；
 *    ② 与任何人的关系是虚拟常驻关系，不落 pairs 文件、不可删（一期关系层
 *    做删除时必须豁免本账号，见 ../README.md 合并契约）；③ 闸口对
 *    「用户 ↔ 客服号」恒放行（否则客服上线即被非好友拒发规则挡死）。
 *  - 本账号目前不存在、没有钥匙：现在给它发消息会在钥匙目录处得到
 *    「对方还没设置聊天」（409），属预期——预留的是位置，不是功能。
 */
const SUPPORT_ACCOUNT = 'qf-support';
function peerType(u) { return norm(u) === SUPPORT_ACCOUNT ? 'system' : 'user'; }
function isSupport(u) { return peerType(u) === 'system'; }

class FriendsGate {
  constructor(file) {
    this.file = file;
    this.pairs = new Set();
    this.reload();
  }
  reload() {
    this.pairs = new Set();
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      (data.pairs || []).forEach(p => { if (Array.isArray(p) && p.length === 2) this.pairs.add(pairKey(p[0], p[1])); });
    } catch (e) { /* 文件不存在/损坏 → 空集合（拒发），不抛错 */ }
  }
  areFriends(a, b) {
    if (!a || !b || norm(a) === norm(b)) return false;
    if (isSupport(a) || isSupport(b)) return true; // 系统联系人：虚拟常驻关系（见文件头预留位说明）
    this.reload();
    return this.pairs.has(pairKey(a, b));
  }
  listFriends(a) {
    this.reload();
    const me = norm(a), out = [];
    this.pairs.forEach(k => {
      const [x, y] = JSON.parse(k);
      if (x === me) out.push(y); else if (y === me) out.push(x);
    });
    out.sort();
    // 系统联系人默认在列表：非本人时恒置于首位（客服号本人不需要自己）
    if (!isSupport(me) && !out.includes(SUPPORT_ACCOUNT)) out.unshift(SUPPORT_ACCOUNT);
    return out;
  }
  // 带类型的对端清单（客户端据此给系统联系人打标/置顶；names 口径与 listFriends 一致）
  listPeers(a) {
    return this.listFriends(a).map(name => ({ name, type: peerType(name) }));
  }
  // 仅供自测与一期联调写入；生产由一期好友服务维护正本
  setFriends(a, b, on) {
    this.reload();
    if (on) this.pairs.add(pairKey(a, b)); else this.pairs.delete(pairKey(a, b));
    const pairs = Array.from(this.pairs).map(k => JSON.parse(k));
    fs.writeFileSync(this.file + '.tmp', JSON.stringify({ pairs }, null, 2));
    fs.renameSync(this.file + '.tmp', this.file);
  }
}

module.exports = { FriendsGate, pairKey, norm, SUPPORT_ACCOUNT, peerType, isSupport };
