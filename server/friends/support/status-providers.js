'use strict';
/*
 * QFRemote 智能客服 · 本人状态查询适配器（先查后答的数据来源）
 * ================================================================
 * 红线：只查发问者本人（登录态会话用户，或未登录已通过身份核对的账号），
 * 调用方负责身份判定，本模块只按给定账号读数，不做任何跨账号聚合。
 *
 * 数据来源均为现行服务的落盘文件（只读）：
 *  - 冻结：loginshim data/freeze.json   {accounts:{<账号>:{day,fails,frozen}}}
 *  - 申诉：loginshim data/appeals.json  {appeals:[{key|username,status,...}]}
 *  - 封禁：ext 账本 qf-account-ledger.json {accounts:{...}}（存在才读）
 *  - 积分：ext data/points.json {users:{<账号>:rec}}，展示口径复用 points-core
 *  - 注册邮箱（身份核对用）：部署时由账号库导出 contacts.json {<账号>:<邮箱>}
 *    （接线方式见 INTEGRATION.md；在未接线时核对功能如实不可用，不猜测）
 *    【2026-10-25 裁决批③后仅作历史留存：身份核对已全站统一为账号＋密码
 *    （见 verifyPassword），邮箱不再作核对要素，getAccountContact 不再被
 *    核对链调用。】
 * 任一来源读不到 → {available:false}，应答层据此只给通用答案，绝不编造状态。
 */
const fs = require('fs');
const path = require('path');

function readJson(file, fallback) {
  try { const v = JSON.parse(fs.readFileSync(file, 'utf8')); return v == null ? fallback : v; }
  catch (e) { return fallback; }
}
// 部署适配（阶段二 01c）：严格读——区分「读到」与「读不到」。源文件为 0600
// 且属主非 qffriends、写入方每次以 tmp+rename 整体替换（组权限位为 0、ACL
// 掩码随创建模式归零），friends 进程对源文件恒无读权限；若按普通 readJson
// 吞错返回空对象，上层会把「读不到」误报成「未冻结/积分为空」，违反本文件
// 头部「读不到 → available:false」口径。故冻结/申诉/积分三源改为：先读源
// 文件，失败再读由 root 定时任务同步到 friends 数据目录的只读镜像副本
// （provider-mirror/，≤60 秒延迟），镜像也读不到才如实报 available:false。
function readJsonStrict(file) {
  try { const v = JSON.parse(fs.readFileSync(file, 'utf8')); return v == null ? { ok: false } : { ok: true, data: v }; }
  catch (e) { return { ok: false }; }
}
function readJsonWithMirror(primaryFile, mirrorFile, fallback) {
  const a = readJsonStrict(primaryFile);
  if (a.ok) return a;
  if (mirrorFile) { const b = readJsonStrict(mirrorFile); if (b.ok) return b; }
  return { ok: false, data: fallback };
}
function norm(name) { return String(name || '').toLowerCase().trim(); }
function todayKey() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

function createFileProviders(opts) {
  const o = opts || {};
  const loginshimDataDir = o.loginshimDataDir || '';
  const extDataDir = o.extDataDir || '';
  const ledgerFile = o.ledgerFile || '';
  const contactsFile = o.contactsFile || '';
  // 镜像目录与 contacts.json 同级推导（friends 数据目录下 provider-mirror/），
  // 子目录 loginshim/ 与 ext/ 分别放 freeze/appeals 与 points 的同步副本。
  const mirrorBase = o.mirrorBase || (contactsFile ? path.join(path.dirname(contactsFile), 'provider-mirror') : '');
  const mirrorFile = (sub, name) => (mirrorBase ? path.join(mirrorBase, sub, name) : '');

  let pointsCore = null;
  // 本地仓库布局是 ext-svc 与 social-svc 同级；服务器布局是两个独立部署目录
  // （/opt/qfremote-friends 与 /opt/qfremote-ext），相对路径够不到，补绝对路径兜底。
  try { pointsCore = require(path.join(__dirname, '..', '..', 'ext-svc', 'points-core.js')); } catch (e) {
    try { pointsCore = require('/opt/qfremote-ext/points-core.js'); } catch (e2) { pointsCore = null; }
  }

  return {
    async getFreeze(username) {
      if (!loginshimDataDir) return { available: false };
      const r = readJsonWithMirror(path.join(loginshimDataDir, 'freeze.json'), mirrorFile('loginshim', 'freeze.json'), { accounts: {} });
      if (!r.ok) return { available: false };
      const data = r.data;
      const st = (data.accounts || {})[norm(username)];
      if (!st) return { available: true, frozen: false, fails: 0 };
      if (st.day !== todayKey()) return { available: true, frozen: false, fails: 0 };
      return { available: true, frozen: !!st.frozen, fails: st.fails || 0 };
    },
    async getAppeal(username) {
      if (!loginshimDataDir) return { available: false };
      const r = readJsonWithMirror(path.join(loginshimDataDir, 'appeals.json'), mirrorFile('loginshim', 'appeals.json'), { appeals: [] });
      if (!r.ok) return { available: false };
      const data = r.data;
      const list = (data.appeals || []).filter(a => a && norm(a.key || a.username) === norm(username));
      if (!list.length) return { available: true, status: null };
      const last = list[list.length - 1];
      return { available: true, status: last.status || null, at: last.updatedAt || last.createdAt || null };
    },
    async getBan(username) {
      if (!ledgerFile) return { available: false };
      const r = readJsonStrict(ledgerFile);
      if (!r.ok) return { available: false };
      const data = r.data;
      const acc = (data.accounts || {})[norm(username)] || (data.accounts || {})[username];
      if (!acc) return { available: true, banned: false };
      const banned = !!(acc.banned || acc.status === 'banned' || acc.ban);
      return { available: true, banned };
    },
    async getPoints(username) {
      if (!extDataDir || !pointsCore) return { available: false };
      const r = readJsonWithMirror(path.join(extDataDir, 'points.json'), mirrorFile('ext', 'points.json'), { users: {} });
      if (!r.ok) return { available: false };
      const data = r.data;
      const rec = (data.users || {})[norm(username)] || (data.users || {})[username] || null;
      const me = pointsCore.computeMe(norm(username), rec, Date.now());
      return { available: true, points: me.points, displayText: me.displayText, daysUsed: me.daysUsed };
    },
    // 许可状态（阶段 C-2）：读许可核心写入的掩码级镜像，只查不判，无密钥原文
    async getLicenseState(username) {
      const r = readJsonWithMirror(path.join(mirrorBase || '', 'license', 'status.json'), '', {});
      if (!r.ok) return { available: false };
      const rec = (r.data || {})[norm(username)];
      if (!rec) return { available: true, found: false };
      return Object.assign({ available: true, found: true }, rec);
    },
    // 身份核对（裁决批③：全站统一账号＋密码）：实际验密由部署接线注入
    // verifyPasswordFn（经控制台控制通道验密）；未注入时如实报不可用，
    // 不把「没接线」冒充成「核对失败」（否则会误计失败次数、误锁用户）。
    async verifyPassword(username, password) {
      if (typeof o.verifyPasswordFn !== 'function') return { available: false };
      try {
        const r = await o.verifyPasswordFn(norm(username), String(password || ''));
        if (!r || r.available === false) return { available: false };
        return { available: true, ok: !!r.ok };
      } catch (e) { return { available: false }; }
    },
    async getAccountContact(username) {
      if (!contactsFile) return { available: false };
      // 映射文件尚不存在＝导出未接线：如实报不可用，不把「没这份文件」冒充
      // 成「账号不存在」（否则会误计核对失败次数、误锁用户）。
      if (!fs.existsSync(contactsFile)) return { available: false };
      const rc = readJsonStrict(contactsFile);
      if (!rc.ok) return { available: false };
      const data = rc.data;
      const email = data[norm(username)] || data[username];
      if (!email) return { available: true, exists: false, email: null };
      return { available: true, exists: true, email: String(email) };
    }
  };
}

module.exports = { createFileProviders };
