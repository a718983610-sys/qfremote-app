'use strict';
/*
 * QFRemote 隐私锁 —— 控制端桥（v2.0.0 线 B）
 * ================================================================
 * 联调接缝正本：~/workspace/qfremote/privacy-lock-impl/line-b-shell-seam.md
 * 线 A（服务端/被控端组件）契约落盘后若字段或路径有出入，只改本文件一处，
 * 锁面板 UI（lock.html）与状态机不动。
 *
 * 桥接口 v1：
 *   基址 https://app.qfremote.top/lock（2.4.2 起，与好友/聊天同经正式
 *   域名聚合路径到达好友服务内的锁桥）；鉴权用好友服务的会话 Cookie
 *   （壳内同一会话分区，登录一次通用），服务端按账号判设备归属。
 *   GET  /devices -> { devices: [{ id, name, owner, locked, component }] }
 *   POST /enable  { id, password }          打开开关并当场设本次密码
 *   POST /disable { id }                    关锁，本次密码立即作废
 *   POST /reset   { id, loginPassword, newPassword }  登录密码验密后重设
 *   401 -> 软件登录状态失效（面板提示重新登录软件）；其余错误取响应体 error 一句话。
 *   免登口径（2.3.0）：面板凭控制台会话（xid）直接可用，服务端桥已认 xid
 *   并处理会话绑 IP 的转发（见服务端 lock-bridge／好友服务校验），不要求
 *   用户先去好友页登录过——qfr_frd 只是桥的优先项，不是门槛。
 *
 * 纪律（写死，不许放宽）：
 *   - 壳不存任何密码：锁密码/登录密码只在提交瞬间过桥，用完即弃，
 *     不落盘、不进日志、不进诊断信息；
 *   - 非机主设备不显示开关——owner 判定以服务端返回为准，壳侧只呈现；
 *   - 网络请求只发往自家域名这一个 origin（证书走系统默认校验，与
 *     update.js 同口径：仅自家 origin、且不带任何账号密码凭据，只带会话 Cookie）。
 *
 * Mock 适配器：QFREMOTE_LOCK_MOCK=1（或主进程 PREVIEW=lock 时）走内存假
 * 数据，语义与真桥一致（enable 置 locked、disable 清、reset 保持 locked），
 * 供无 A 线时全链自测与截图；生产默认走真桥，服务未开通时如实报错，
 * 不假装已联通。
 */
const https = require('https');
const http = require('http');
const clientVersion = require('./client-version');

const LOCK_API_BASE = 'https://app.qfremote.top/lock';
const LOCK_HOST = 'app.qfremote.top';
const LOCK_PORT = 443;

// 密码预检（壳侧，最终以 A 线契约为准）：4–64 位。
function validateLockPassword(pw) {
  if (typeof pw !== 'string' || pw.length < 4) return '密码至少 4 位，请检查后重试。';
  if (pw.length > 64) return '密码最多 64 位，请检查后重试。';
  return null;
}

function lockError(message, code) {
  const e = new Error(message);
  if (code) e.code = code;
  return e;
}

// ---------------- Mock 适配器（测试专用，生产不启用） ----------------
function createMockBridge() {
  const devices = [
    { id: 'mock-pc-1', name: '我的台式机', owner: true, locked: false, component: true },
    { id: 'mock-pc-2', name: '家里电脑', owner: true, locked: true, component: true },
    { id: 'mock-pc-3', name: '老笔记本（未装组件）', owner: true, locked: false, component: false },
    { id: 'mock-pc-4', name: '好友共享的电脑', owner: false, locked: false, component: true }
  ];
  const byId = (id) => devices.find(d => d.id === id);
  const delay = () => new Promise(r => setTimeout(r, 180));
  // Mock 挑战与幂等：与服务端同语义（单次挑战、操作编号去重），供弹窗单测与截图。
  const mockChallenges = new Map(); // challenge -> { id, used }
  const mockSeenOps = new Map(); // operationId -> result
  let mockChSeq = 0;
  return {
    mock: true,
    async listDevices() { await delay(); return devices.map(d => Object.assign({}, d)); },
    async challenge(id) {
      await delay();
      const d = byId(id);
      if (!d) throw lockError('未找到这台电脑。');
      const ch = 'mock-ch-' + (++mockChSeq);
      mockChallenges.set(ch, { id, used: false });
      return { ok: true, challenge: ch, expiresAt: Date.now() + 5 * 60 * 1000, op: 'disarm', deviceId: id };
    },
    async enable(id, password) {
      await delay();
      const d = byId(id);
      if (!d) throw lockError('未找到这台电脑。');
      if (!d.owner) throw lockError('仅设备所有者可管理这台电脑的隐私锁。');
      if (!d.component) throw lockError('这台电脑尚未安装本机锁组件，暂无法使用隐私锁。');
      const bad = validateLockPassword(password);
      if (bad) throw lockError(bad);
      d.locked = true;
      return { ok: true, locked: true };
    },
    async disable(id, opts) {
      await delay();
      const o = opts || {};
      const d = byId(id);
      if (!d) throw lockError('未找到这台电脑。');
      if (!d.owner) throw lockError('仅设备所有者可管理这台电脑的隐私锁。');
      if (!o.operationId) throw lockError('缺少操作编号，请重新打开确认窗口。');
      const seen = mockSeenOps.get(o.operationId);
      if (seen) return Object.assign({ ok: true, replayed: true }, seen);
      const rec = mockChallenges.get(o.challenge);
      if (!rec || rec.used || rec.id !== id) throw lockError('操作确认信息无效或已被使用，请重新打开确认窗口。');
      rec.used = true;
      let out;
      if (!d.locked) out = { locked: false, alreadyUnlocked: true, lockState: 'UNLOCKED' };
      else { d.locked = false; out = { locked: false, lockState: 'UNLOCKED' }; }
      mockSeenOps.set(o.operationId, out);
      return Object.assign({ ok: true }, out);
    },
    async reset(id, loginPassword, newPassword) {
      await delay();
      const d = byId(id);
      if (!d) throw lockError('未找到这台电脑。');
      if (!d.owner) throw lockError('仅设备所有者可管理这台电脑的隐私锁。');
      if (!loginPassword) throw lockError('请输入登录密码。');
      const bad = validateLockPassword(newPassword);
      if (bad) throw lockError(bad);
      // 保持上锁，只换本次密码（找回链第一条）
      d.locked = true;
      return { ok: true, locked: true };
    }
  };
}

// ---------------- 真桥 ----------------
// getSession: () => Electron session（取 persist:qfremote 分区的 Cookie 罐）。
// opts.base 仅测试用（指向本地假服务），生产恒为 LOCK_API_BASE。
function createLockBridge(getSession, opts) {
  const options = opts || {};
  if (options.mock) return createMockBridge();
  const base = options.base || LOCK_API_BASE;

  async function cookieHeader() {
    try {
      const ses = getSession && getSession();
      if (!ses || !ses.cookies) return '';
      // W-29：按名取会话 cookie，不再发整罐——整罐含控制台 xid 与
      // 各子服务会话，外泄面不必要地大。取三名：xid + xid.sig（控制台
      // 会话签名对，缺 sig 服务端可能不认会话；与 transplantSessionToExt
      // 及安卓端同款三件套 xid/xid.sig/qfrem 中的前两件——qfrem 为
      // “记住我”凭据，API 调用有 xid 对即够，不取）+ qfr_frd（锁桥优先项）。
      const picked = [];
      for (const name of ['xid', 'xid.sig', 'qfr_frd']) {
        try {
          const cs = await ses.cookies.get({ name });
          for (const c of cs || []) if (c.value) picked.push(c.name + '=' + c.value);
        } catch (e) { /* 单个名取不到不影响其余 */ }
      }
      return picked.join('; ');
    } catch (e) { return ''; }
  }

  function request(method, route, body) {
    return new Promise(async (resolve, reject) => {
      let u;
      try { u = new URL(base + route); } catch (e) { reject(lockError('隐私锁服务地址不正确。')); return; }
      // 只许自家 origin（测试覆盖 base 时放行本地回环）；端口按有效端口
      // 比对：URL 未显式写端口时 u.port 为空串，https 记 443、http 记 80
      const isLocalTest = u.hostname === '127.0.0.1' || u.hostname === 'localhost';
      const effPort = u.port === '' ? (u.protocol === 'https:' ? 443 : 80) : Number(u.port);
      if (!isLocalTest && (u.hostname !== LOCK_HOST || effPort !== LOCK_PORT)) {
        reject(lockError('隐私锁服务地址不在信任范围内。'));
        return;
      }
      const payload = body ? JSON.stringify(body) : null;
      // 2.3.2：带统一版本头（见 client-version.js）；opts.clientVersion 可覆盖来源
      const headers = clientVersion.withClientVersion({ 'Accept': 'application/json' }, options.clientVersion);
      if (payload) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = Buffer.byteLength(payload);
      }
      const cookie = await cookieHeader();
      if (cookie) headers['Cookie'] = cookie;
      // W-29：按协议分流（http 回环假服务走 http.request，不再对 http
      // 地址发 TLS）；端口用算出的有效端口，不再写死 443 回退。
      const lib = u.protocol === 'http:' ? http : https;
      const req = lib.request({
        hostname: u.hostname,
        port: effPort,
        path: u.pathname + u.search,
        method,
        headers,
        timeout: 10000,
        // 证书走 Node 默认校验（正式域名公共 CA）；仅本地测试假服务
        // （opts.base 指向回环、自签证书）放行校验，生产基址恒为正式域名
        rejectUnauthorized: !isLocalTest
      }, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let data = null;
          try { data = JSON.parse(text); } catch (e) { /* 非 JSON 按状态码处理 */ }
          if (res.statusCode === 401) {
            reject(lockError('软件的登录状态已失效，请重新登录软件后再回来管理隐私锁。', 'NEED_LOGIN'));
            return;
          }
          if (res.statusCode < 200 || res.statusCode >= 300) {
            // C 线：服务端新路径带机器可读 code（如 revision-stale / challenge-*），
            // 原样透传给弹窗做分支（刷新快照 vs 仅显示错误）；旧错误无 code 即 null。
            reject(lockError((data && data.error) || '隐私锁服务暂时无法处理本次请求，请稍后再试。', (data && data.code) || null));
            return;
          }
          resolve(data || {});
        });
        res.on('error', () => reject(lockError('暂时连不上隐私锁服务，请检查网络后重试。', 'UNREACHABLE')));
      });
      req.on('timeout', () => req.destroy(lockError('暂时连不上隐私锁服务，请检查网络后重试。', 'UNREACHABLE')));
      req.on('error', (e) => {
        if (e && e.code === 'UNREACHABLE') reject(e);
        else reject(lockError('暂时连不上隐私锁服务，请检查网络后重试。', 'UNREACHABLE'));
      });
      if (payload) req.write(payload);
      req.end();
    });
  }

  return {
    mock: false,
    async listDevices() {
      const data = await request('GET', '/devices');
      const list = Array.isArray(data.devices) ? data.devices : [];
      return list.map(d => ({
        id: String(d.id || ''),
        name: String(d.name || d.id || '未命名电脑'),
        owner: !!d.owner,
        locked: !!d.locked,
        // C 线：服务端新字段直传（缺失即未知，不猜）：lockState 为权威锁状态，
        // lockId/revision 供关闭确认弹窗冻结快照用。
        lockState: typeof d.lockState === 'string' ? d.lockState : (d.locked ? 'LOCKED' : 'UNLOCKED'),
        lockId: typeof d.lockId === 'string' ? d.lockId : null,
        revision: typeof d.revision === 'number' ? d.revision : 0,
        lastHeartbeat: d.lastHeartbeat != null ? d.lastHeartbeat : null,
        degraded: typeof d.degraded === 'string' ? d.degraded : null,
        // W-11③：component 字段缺失即未知（null），面板显示「状态未知」，
        // 不再缺省当已装。
        component: d.component === false ? false : (d.component === true ? true : null)
      })).filter(d => d.id);
    },
    // C 线：关闭确认弹窗打开时取短期操作挑战（5 分钟、单次、绑定设备）。
    async challenge(id, op) {
      const r = await request('GET', '/challenge?id=' + encodeURIComponent(id) + '&op=' + encodeURIComponent(op || 'disarm'));
      return { ok: true, challenge: r.challenge, expiresAt: r.expiresAt, op: r.op, deviceId: r.deviceId };
    },
    async enable(id, password) {
      const bad = validateLockPassword(password);
      if (bad) throw lockError(bad);
      const r = await request('POST', '/enable', { id, password });
      return { ok: true, locked: r.locked !== false };
    },
    // C 线：disable 必须带操作编号＋挑战＋冻结 revision（见 lock.html 弹窗）；
    // loginPassword 可选，填了即做短时重新认证。服务端返回 replayed /
    // alreadyUnlocked 时直接透传，不当作错误。
    async disable(id, opts) {
      const o = opts || {};
      if (!o.operationId) throw lockError('缺少操作编号，请重新打开确认窗口。');
      if (!o.challenge) throw lockError('缺少操作确认信息，请重新打开确认窗口。');
      if (typeof o.revision !== 'number') throw lockError('缺少设备状态版本，请重新打开确认窗口。');
      const body = { id, challenge: o.challenge, operationId: o.operationId, revision: o.revision };
      if (typeof o.loginPassword === 'string' && o.loginPassword) body.loginPassword = o.loginPassword;
      const r = await request('POST', '/disable', body);
      return { ok: true, locked: false, replayed: !!r.replayed, alreadyUnlocked: !!r.alreadyUnlocked, lockState: r.lockState || 'UNLOCKED', revision: r.revision };
    },
    async reset(id, loginPassword, newPassword) {
      if (!loginPassword) throw lockError('请输入登录密码。');
      const bad = validateLockPassword(newPassword);
      if (bad) throw lockError(bad);
      await request('POST', '/reset', { id, loginPassword, newPassword });
      return { ok: true, locked: true };
    }
  };
}

module.exports = { LOCK_API_BASE, validateLockPassword, createLockBridge, createMockBridge };
