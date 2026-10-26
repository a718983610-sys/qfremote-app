'use strict';
/*
 * QFRemote 自助注册服务（开放注册，2026-10-24 10:41 改版）
 * ================================================================
 * 背景与定位：
 *  - QFRemote 只认账号+密码登录；账号只能经「后台」产生，两条路并存：
 *    A 管理员后台随机生成发放（见 ../account-kit/）；
 *    B 本服务：注册入口自助注册（本文件）。注册码于 10:41 撤销——开放注册，
 *    填账号+密码+确认密码即可。
 *  - MeshCentral 自带公开注册保持关闭（newAccounts=false 不动）；本服务校验
 *    通过后，用一个只有「管理用户」位（siteadmin & 2）的专用服务账号，
 *    经官方控制通道发 adduser 命令建号——与 MeshCtrl AddUser 发的命令完全一致
 *    （meshctrl.js 的 adduser 分支），是正规建号手段，不直写数据库。
 *  - 新注册账号：siteadmin 不传（=0，无站点权）、不入任何设备组（设备与权限
 *    由站长后续按分发规矩分配）。改名一次：用户的一次由站长通道执行、台账
 *    当闸门，用完后站长可后台越权再改（见 ../account-kit/mcdb.js 的 rename）；
 *    用户改自己密码是底子自带功能，不限次。对用户的关卡只有本服务的防刷。
 *
 * 账号规则（用户 10:41 亲定）：最少 8 位、只许字母和数字、字母和数字都要有
 * （实现上限 32 位防滥用；系统按小写存）。重名提示「该账号已被注册」（2026-10-25 站长改定，全站统一用字）。
 * 密码规则（暂定口径，用户未单独定）：最少 8 位（实现上限 64 位）。
 *
 * 失败与封禁口径（写死，README 有给人看的版本）：
 *  - 设备 = 来源 IP + 设备 cookie（qfr_did，页面种下）双因子组合键。
 *  - 算一次失败：账号名格式不对；账号名是保留名；密码太短（含两次密码
 *    不一致——页面会先拦，能到服务端的多半是脚本）；账号名已被占用；
 *    建号被服务器以其他原因拒绝。
 *  - 不算失败：封禁期间的尝试（直接拒、不叠加不延长）；被限速的尝试；成功
 *    注册不清空当日计数（按自然日累计）。
 *  - 同一设备当日累计失败「超过 5 次」（即第 6 次失败）触发封禁，封到次日
 *    0 点（Asia/Shanghai）自动解除；解除在下一次请求时惰性判定并落日志。
 *  - 另有单 IP 限速：10 分钟内 POST 超过 15 次直接 429，与封禁叠加。
 *  - 日志只记时间、设备短哈希、IP、尝试的账号名、结果与计数——绝不记密码明文。
 *
 * 配置（QFREG_CONFIG，默认 /opt/qfremote-register/config.json）：
 *  { port, bind, tlsKey, tlsCert, svcUser, svcPass,
 *    mcUrl, stateFile, logFile, accountsFile }
 *  （旧配置里的 codeSha256 字段已废止，服务不再读取。）
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');

/* ===== 许可注册门（阶段 C-2）：经内网接口问扩展服务（唯一写者），本服务不直写许可状态 ===== */
const LIC_SECRET_FILE = process.env.QFLIC_SECRET_FILE || '/opt/qfremote-license/internal.secret';
function licInternal(pathname, payload) {
  return new Promise((resolve) => {
    let secret = '';
    try { secret = fs.readFileSync(LIC_SECRET_FILE, 'utf8').trim(); } catch (e) { return resolve(null); }
    if (!secret) return resolve(null);
    const body = JSON.stringify(payload || {});
    const r = http.request({ hostname: '127.0.0.1', port: 8448, path: pathname, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'X-QF-Internal-Secret': secret }, timeout: 5000 }, (resp) => {
      const chunks = [];
      resp.on('data', (c) => chunks.push(c));
      resp.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { resolve(null); } });
    });
    r.on('timeout', () => { r.destroy(); resolve(null); });
    r.on('error', () => resolve(null));
    r.write(body); r.end();
  });
}
const L6_MSG = '该设备或网络已注册过账号。根据注册规则，同一设备、同一网络只能注册一个账号，本次注册未完成。如有疑问，请联系智能客服。';

const CONFIG_PATH = process.env.QFREG_CONFIG || '/opt/qfremote-register/config.json';
let _WebSocket = null;
function loadWebSocket() {
  if (_WebSocket) return _WebSocket;
  try { _WebSocket = require('/opt/meshcentral/node_modules/ws'); }
  catch (e) { _WebSocket = require('ws'); }
  return _WebSocket;
}

// ---------- 上海时间（封禁按自然日，次日 0 点解除） ----------
function shanghaiDayKey(now) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
}
function nextShanghaiMidnightMs(now) {
  return Date.parse(shanghaiDayKey(now) + 'T00:00:00+08:00') + 86400000;
}

// ---------- 失败/封禁状态机（纯逻辑，可单测） ----------
// record: { day, fails, bannedUntil }
function rollDay(rec, now) {
  const today = shanghaiDayKey(now);
  if (rec.day !== today) { rec.day = today; rec.fails = 0; rec.bannedUntil = null; }
}
function checkBan(rec, now) {
  // 先判过期再滚日：封禁到期时刻永远在次日 0 点，与滚日同时发生，
  // 先滚日会把 bannedUntil 清掉、过期标记（要落日志）就丢了。
  let expired = false;
  if (rec.bannedUntil && now >= rec.bannedUntil) { expired = true; rec.bannedUntil = null; rec.fails = 0; }
  rollDay(rec, now);
  if (rec.bannedUntil && now < rec.bannedUntil) return { banned: true, until: rec.bannedUntil };
  return { banned: false, expired };
}
function applyFailure(rec, now) {
  rollDay(rec, now);
  rec.fails += 1;
  if (rec.fails > 5 && !rec.bannedUntil) {
    rec.bannedUntil = nextShanghaiMidnightMs(now);
    return { fails: rec.fails, justBanned: true, until: rec.bannedUntil };
  }
  return { fails: rec.fails, justBanned: false };
}

// ---------- 校验规矩 ----------
const RESERVED = new Set(['qf-regsvc', 'admin', 'administrator', 'root', 'system', 'support', 'qfremote', 'wayne', 'a718983610@gmail.com', '718983610']);
function validateUsernameInput(raw) {
  const name = String(raw || '').toLowerCase().trim();
  if (name.length < 8) return { ok: false, name, msg: '账号须为字母与数字的组合，至少 8 位，请检查后重试。' };
  if (name.length > 32) return { ok: false, name, msg: '账号最多 32 位，请检查后重试。' };
  if (!/^[a-z0-9]+$/.test(name)) return { ok: false, name, msg: '账号须为字母与数字的组合，至少 8 位，请检查后重试。' };
  if (!/[a-z]/.test(name)) return { ok: false, name, msg: '账号须为字母与数字的组合，至少 8 位，请检查后重试。' };
  if (!/[0-9]/.test(name)) return { ok: false, name, msg: '账号须为字母与数字的组合，至少 8 位，请检查后重试。' };
  if (RESERVED.has(name)) return { ok: false, name, reserved: true, msg: '该账号名不可用，请更换一个。' };
  return { ok: true, name };
}
function validatePasswordInput(pw, pw2, username) {
  pw = String(pw || ''); pw2 = String(pw2 || '');
  if (pw !== pw2) return { ok: false, msg: '两次输入的密码不一致，请检查后重试。' };
  // 暂定口径（用户 10:41 未单独定密码规则）：最少 8 位，上限 64 位防滥用。
  if (pw.length < 8) return { ok: false, msg: '密码至少 8 位，请检查后重试。' };
  if (pw.length > 64) return { ok: false, msg: '密码最多 64 位，请检查后重试。' };
  return { ok: true };
}

// ---------- 主服务 ----------
function main() {
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const PAGE = fs.readFileSync(path.join(__dirname, 'register.html'), 'utf8');
  const stateFile = cfg.stateFile, logFile = cfg.logFile, accountsFile = cfg.accountsFile;

  let state = { devices: {}, ipWindows: {} };
  try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch (e) { /* 首次运行 */ }
  if (!state.devices) state.devices = {};
  if (!state.ipWindows) state.ipWindows = {};
  function saveState() {
    fs.writeFileSync(stateFile + '.tmp', JSON.stringify(state));
    fs.renameSync(stateFile + '.tmp', stateFile);
  }
  function log(obj) {
    const line = JSON.stringify(Object.assign({ at: new Date().toISOString() }, obj)) + '\n';
    try { fs.appendFileSync(logFile, line); } catch (e) { /* 日志写不了不拦正事 */ }
  }
  const deviceKeyOf = (ip, did) => crypto.createHash('sha256').update(ip + '\n' + (did || '')).digest('hex');
  const shortHash = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 12);

  // 经官方控制通道建号（与 MeshCtrl AddUser 同一条命令）
  function createAccount(username, password) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (r) => { if (!done) { done = true; try { ws.close(); } catch (e) {} resolve(r); } };
      const auth = Buffer.from(cfg.svcUser).toString('base64') + ',' + Buffer.from(cfg.svcPass).toString('base64');
      const WebSocket = loadWebSocket();
      const ws = new WebSocket(cfg.mcUrl || 'wss://127.0.0.1:8443/control.ashx', { rejectUnauthorized: false, headers: { 'x-meshauth': auth } });
      const timer = setTimeout(() => finish({ ok: false, result: 'timeout' }), 10000);
      ws.on('open', () => {
        ws.send(JSON.stringify({ action: 'adduser', username, pass: password, responseid: 'qfreg' }));
      });
      ws.on('message', (data) => {
        let m; try { m = JSON.parse(data.toString()); } catch (e) { return; }
        if (m && m.action === 'adduser' && m.responseid === 'qfreg') {
          clearTimeout(timer);
          finish({ ok: m.result === 'ok', result: String(m.result || 'unknown') });
        }
      });
      ws.on('error', () => { clearTimeout(timer); finish({ ok: false, result: 'conn-error' }); });
    });
  }

  function clientIp(req) {
    // 只认本机回环来的 X-Forwarded-For（将来若挂反代在本机），其余一律用连接地址
    const remote = req.socket.remoteAddress || '';
    if ((remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1') && req.headers['x-forwarded-for']) {
      return String(req.headers['x-forwarded-for']).split(',')[0].trim();
    }
    return remote.replace(/^::ffff:/, '');
  }
  function parseCookies(req) {
    const out = {};
    String(req.headers.cookie || '').split(';').forEach(p => {
      const i = p.indexOf('=');
      if (i > 0) out[p.slice(0, i).trim()] = p.slice(i + 1).trim();
    });
    return out;
  }
  function sendJson(res, code, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(body);
  }

  async function handleRegister(req, res) {
    const now = Date.now();
    const ip = clientIp(req);
    const cookies = parseCookies(req);
    const did = cookies.qfr_did || '';
    const dkey = deviceKeyOf(ip, did);
    const devTag = shortHash(dkey);

    // 限速（单 IP 10 分钟 15 次 POST）
    const win = (state.ipWindows[ip] || []).filter(t => now - t < 600000);
    win.push(now);
    state.ipWindows[ip] = win;
    if (win.length > 15) { saveState(); log({ ev: 'ratelimited', dev: devTag, ip }); return sendJson(res, 429, { ok: false, msg: '操作过于频繁，请稍后再试。' }); }

    // 设备记录与封禁判定
    let rec = state.devices[dkey];
    if (!rec) { rec = state.devices[dkey] = { ip, did: shortHash(did || 'nocookie'), day: shanghaiDayKey(now), fails: 0, bannedUntil: null }; }
    rec.ip = ip;
    const ban = checkBan(rec, now);
    if (ban.expired) log({ ev: 'ban-expired', dev: devTag, ip });
    if (ban.banned) {
      saveState();
      log({ ev: 'blocked-while-banned', dev: devTag, ip });
      return sendJson(res, 403, { ok: false, banned: true, msg: '本设备今日注册失败次数过多，已暂停注册，次日 0 点恢复。如有疑问，请联系官方客服。' });
    }

    // 读 body（限 8KB）
    let body = '';
    req.on('data', c => { body += c; if (body.length > 8192) req.destroy(); });
    await new Promise(r => { req.on('end', r); req.on('close', r); });
    let data = {};
    try { data = JSON.parse(body || '{}'); } catch (e) { /* 当作空提交，走码错分支 */ }

    const fail = (reason, msg, opts) => {
      const r = applyFailure(rec, now);
      saveState();
      log({ ev: 'fail', dev: devTag, ip, user: String(data.username || '').slice(0, 40), reason, fails: r.fails, banned: r.justBanned });
      if (r.justBanned) {
        log({ ev: 'banned', dev: devTag, ip, until: new Date(r.until).toISOString() });
        return sendJson(res, 403, { ok: false, banned: true, msg: '注册失败次数过多，本设备今日已暂停注册，次日 0 点恢复。' });
      }
      const left = 6 - r.fails;
      // opts.exact：文案逐字返回（如重名提示用用户原话），不拼剩余次数后缀
      return sendJson(res, 200, { ok: false, msg: (opts && opts.exact) ? msg : msg + (r.fails >= 3 ? '（今日再失败 ' + left + ' 次，本设备将暂停注册至次日。）' : '') });
    };

    // 成功台账门（一设备一 IP 一账号）：命中直接按 L6 拒绝，不计失败、不产封禁记录，
    // 与上方失败计数防刷并行不互扰。许可服务不可达时不拦（不锁死注册）。
    const licDeviceHash = crypto.createHash('sha256').update('did:' + (did || '')).digest('hex');
    const regChk = await licInternal('/internal/license/register-check', { deviceHash: did ? licDeviceHash : '', ip });
    if (regChk && regChk.ok && regChk.allow === false) {
      log({ ev: 'reg-ledger-reject', dev: devTag, ip, reason: regChk.reason || '' });
      return sendJson(res, 200, { ok: false, msg: L6_MSG });
    }

    const vu = validateUsernameInput(data.username);
    if (!vu.ok) return fail(vu.reserved ? 'username-reserved' : 'username-format', vu.msg);
    const vp = validatePasswordInput(data.password, data.password2, vu.name);
    if (!vp.ok) return fail('password-weak', vp.msg);

    const created = await createAccount(vu.name, String(data.password));
    if (!created.ok) {
      if (created.result === 'User already exists') return fail('username-taken', '该账号已被注册', { exact: true });
      if (created.result === 'Invalid password') return fail('password-weak', '密码至少 8 位，请检查后重试。');
      if (created.result === 'Invalid username') return fail('username-format', '账号须为字母与数字的组合，至少 8 位，请检查后重试。');
      log({ ev: 'create-error', dev: devTag, ip, user: vu.name, result: created.result });
      return fail('server', '服务器暂时出现问题，本次注册未成功，请稍后再试。');
    }

    // 成功回写许可台账＋开 3 天试用（仅软件端）；失败不拦注册成功响应。
    await licInternal('/internal/license/register-success', { username: vu.name, deviceHash: did ? licDeviceHash : '', ip });
    log({ ev: 'success', dev: devTag, ip, user: vu.name, failsToday: rec.fails });
    try { fs.appendFileSync(accountsFile, JSON.stringify({ username: vu.name, at: new Date().toISOString(), via: 'self-reg' }) + '\n'); } catch (e) {}
    saveState();
    return sendJson(res, 200, { ok: true, msg: '注册成功。请打开 QFRemote 软件，使用新注册的账号和密码登录。设备与权限由管理员后续为您分配。' });
  }

  const server = https.createServer({ key: fs.readFileSync(cfg.tlsKey), cert: fs.readFileSync(cfg.tlsCert) }, (req, res) => {
    const u = new URL(req.url, 'https://localhost');
    if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/register')) {
      const cookies = parseCookies(req);
      const headers = {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer'
      };
      if (!cookies.qfr_did) {
        const did = crypto.randomBytes(16).toString('hex');
        headers['Set-Cookie'] = 'qfr_did=' + did + '; Path=/; Max-Age=34560000; SameSite=Lax; Secure; HttpOnly';
      }
      res.writeHead(200, headers);
      res.end(PAGE);
      return;
    }
    if (req.method === 'GET' && u.pathname === '/health') return sendJson(res, 200, { ok: true });
    if (req.method === 'POST' && u.pathname === '/api/register') { handleRegister(req, res).catch(() => { try { sendJson(res, 500, { ok: false, msg: '服务器暂时出现问题，请稍后再试。' }); } catch (e) {} }); return; }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
  });
  server.listen(cfg.port || 8444, cfg.bind || '0.0.0.0', () => {
    console.log('qfremote-register listening on ' + (cfg.bind || '0.0.0.0') + ':' + (cfg.port || 8444));
  });
}

if (require.main === module) main();
module.exports = { shanghaiDayKey, nextShanghaiMidnightMs, rollDay, checkBan, applyFailure, validateUsernameInput, validatePasswordInput };
