'use strict';
/*
 * QFRemote 隐私锁 —— 控制端桥（v2.0.0 线 B）
 * ================================================================
 * 联调接缝正本：~/workspace/qfremote/privacy-lock-impl/line-b-shell-seam.md
 * 线 A（服务端/被控端组件）契约落盘后若字段或路径有出入，只改本文件一处，
 * 锁面板 UI（lock.html）与状态机不动。
 *
 * 桥接口 v1：
 *   基址 https://54.248.9.192:8445/lock（与好友/聊天同服务族，8445 已在
 *   本壳证书白名单内）；鉴权用好友服务的会话 Cookie（壳内同一会话分区，
 *   登录一次通用），服务端按账号判设备归属。
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
 *   - 网络请求只发往自家主机 8445 这一个 origin（自签证书放行口径与
 *     update.js 同：仅自家 origin、且不带任何账号密码凭据，只带会话 Cookie）。
 *
 * Mock 适配器：QFREMOTE_LOCK_MOCK=1（或主进程 PREVIEW=lock 时）走内存假
 * 数据，语义与真桥一致（enable 置 locked、disable 清、reset 保持 locked），
 * 供无 A 线时全链自测与截图；生产默认走真桥，服务未开通时如实报错，
 * 不假装已联通。
 */
const https = require('https');
const clientVersion = require('./client-version');

const LOCK_API_BASE = 'https://54.248.9.192:8445/lock';
const LOCK_HOST = '54.248.9.192';
const LOCK_PORT = 8445;

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
  return {
    mock: true,
    async listDevices() { await delay(); return devices.map(d => Object.assign({}, d)); },
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
    async disable(id) {
      await delay();
      const d = byId(id);
      if (!d) throw lockError('未找到这台电脑。');
      if (!d.owner) throw lockError('仅设备所有者可管理这台电脑的隐私锁。');
      d.locked = false;
      return { ok: true, locked: false };
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
      // 取整个分区罐（与主进程 extRequest 同一已实证路径）：控制台会话
      // cookie（xid）在 8443 源下种、隐私锁在 8445 源，按 URL 过滤取罐有
      // 跨端口漏取的风险；整罐取出后由服务端按名认人（只要 xid/qfr_frd）。
      const cookies = await ses.cookies.get({});
      return cookies.map(c => c.name + '=' + c.value).join('; ');
    } catch (e) { return ''; }
  }

  function request(method, route, body) {
    return new Promise(async (resolve, reject) => {
      let u;
      try { u = new URL(base + route); } catch (e) { reject(lockError('隐私锁服务地址不正确。')); return; }
      // 只许自家 origin（测试覆盖 base 时放行本地回环）
      const isLocalTest = u.hostname === '127.0.0.1' || u.hostname === 'localhost';
      if (!isLocalTest && (u.hostname !== LOCK_HOST || Number(u.port) !== LOCK_PORT)) {
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
      const req = https.request({
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method,
        headers,
        timeout: 10000,
        rejectUnauthorized: false // 自签证书：仅自家 origin（上方已逐个核对主机+端口）
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
            reject(lockError((data && data.error) || '隐私锁服务暂时无法处理本次请求，请稍后再试。'));
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
        component: d.component !== false
      })).filter(d => d.id);
    },
    async enable(id, password) {
      const bad = validateLockPassword(password);
      if (bad) throw lockError(bad);
      const r = await request('POST', '/enable', { id, password });
      return { ok: true, locked: r.locked !== false };
    },
    async disable(id) {
      await request('POST', '/disable', { id });
      return { ok: true, locked: false };
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
