'use strict';
/*
 * QFRemote 登录垫片（qfremote-loginshim）
 * ================================================================
 * 职责一：「记住此设备」的会话保鲜层（原有机制，不变）。
 * 背景：MeshCentral 1.3.1 的会话 cookie（xid/xid.sig，cookie-session）默认会话级
 * （关浏览器即失效）；官方唯一的有效期开关是全局 settings.sessionTime，一开全员
 * 持久，没法按「本次登录是否勾选」区分。且登录后控制台的普通请求会改动会话、
 * 重发不带有效期的 xid，把登录那一笔设好的持久 cookie 冲掉——所以保鲜必须覆盖
 * 记住用户的全部控制台流量，而不只是登录那一笔。
 *  1) 登录页提交走 /qf-login 到本服务：摘掉自家字段 qfrememberdevice 后原样
 *     转发 MeshCentral；勾选时在回程给 xid/xid.sig 补 Max-Age=2592000（30 天），
 *     同时种一颗同为 30 天的标记 cookie「qfrem=1」。
 *  2) nginx 对带 qfrem 标记的请求走本服务（通用转发模式）：请求/响应/WebSocket
 *     原样透传，只在回程 Set-Cookie 上继续给 xid/xid.sig 补 Max-Age 防冲掉。
 *  3) 登出（/logout）时清掉 qfrem 标记；未勾选提交时同样清标记。
 *
 * 职责二：登录冻结＋申诉（2026-10-24 用户亲定，本次新增）。
 * 规则：同一账号当天（Asia/Shanghai 自然日）密码输错满 5 次 → 当天冻结，
 * 之后输对也不让进，次日 0 点自动解冻；计数只认账号不认 IP。
 * 触发冻结的那次及冻结期间每次尝试，登录页弹出原文提示，句中「申诉＞＞＞＞」
 * 红字可点进申诉页 /appeal。申诉（账号/邮箱/情况说明）入库待审，站长（经助手）
 * 批准后生成一次性改密凭证，用户在申诉进度页点「修改密码」设新密码，设完
 * 冻结与计数一并清除。冻结状态与申诉都落盘（data/），服务重启不丢。
 * 适用面 v1：控制台登录页（网页通道）。直连 8443 与好友/聊天/论坛登录不纳入。
 * MeshCentral 本体零改动；改密经一次性 spool + root 包装脚本停服写库完成。
 * 只监听回环 127.0.0.1:8450，仅 nginx 本机反代可达。
 */
const http = require('http');
const https = require('https');
const tls = require('tls');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const MAX_AGE = 2592000; // 30 天（秒）
const MARKER = 'qfrem=1; Path=/; Max-Age=' + MAX_AGE + '; Secure; SameSite=Lax';
const MARKER_CLEAR = 'qfrem=; Path=/; Max-Age=0; Secure; SameSite=Lax';

const DATA_DIR = '/opt/qfremote-loginshim/data';
const FREEZE_FILE = path.join(DATA_DIR, 'freeze.json');
const APPEALS_FILE = path.join(DATA_DIR, 'appeals.json');
const ATTEMPTS_FILE = path.join(DATA_DIR, 'attempts.jsonl');
const SPOOL_DIR = path.join(DATA_DIR, 'reset-spool');
const SETPASS_CMD = '/usr/local/bin/qfremote-appeal-setpass';
const FREEZE_LIMIT = 5;
const FREEZE_TEXT_PRE = '该账号今日密码输入错误已超过 5 次，今日不能再试。请前往';
const FREEZE_LINK_TEXT = '申诉＞＞＞＞';

let passmod = null;
try { passmod = require('/opt/meshcentral/node_modules/meshcentral/pass.js'); }
catch (e) { console.error('警告：加载不到 MeshCentral pass.js，申诉改密将不可用：', e.message); }

/* ===== 许可门（阶段 C-2）：只经内网接口问扩展服务（唯一写者），本垫片不直写许可状态 ===== */
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
function fmtDate(ms) {
  if (!ms) return '';
  try { return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: 'long', day: 'numeric' }).format(new Date(ms)); } catch (e) { return ''; }
}
// 许可/封禁拦截整页（设计稿 §四 L 文案；G 类与 B 类不同标题与主按钮）
function gatePageHtml(username, d) {
  const u = encodeURIComponent(username || '');
  let title = '暂时无法登录', text = '', btn = '';
  if (d.code === 'BAN_PERM') {
    title = '账号已被封禁';
    text = d.banCode === 'B6'
      ? '该账号已被永久封禁。原因：检测到同一台设备登录多个账号，违反《用户协议》关于账号与设备使用的约定。如对处理结果有异议，可提交申诉，审核通过后将解除封禁。'
      : '该账号已被封禁。原因：账号存在违规使用行为，违反《用户协议》相关约定。如对处理结果有异议，可提交申诉。';
    btn = '<a class="btn" href="/appeal?u=' + u + '">提交申诉</a>';
  } else if (d.code === 'BAN_UNTIL') {
    title = '账号已被冻结';
    text = d.banCode === 'B10'
      ? '该账户已被冻结（至 ' + fmtDate(d.endsAt) + '）。原因：检测到密钥绑定异常操作。如对处理结果有异议，可提交申诉。'
      : '该账号已被冻结，暂时无法登录' + (d.endsAt ? '（至 ' + fmtDate(d.endsAt) + '）' : '') + '。如需处理，可提交申诉查询原因。';
    btn = '<a class="btn" href="/appeal?u=' + u + '">提交申诉</a>';
  } else if (d.code === 'G1') {
    title = '尚未激活';
    text = '软件已升级为一次性付费版本，您尚未购买密钥激活。价格为 18 元，一次购买，终生免费更新。';
    btn = '<a class="btn" href="/purchase">前往购买</a>';
  } else if (d.code === 'G2') {
    title = '试用已到期';
    text = '您的 3 天免费试用已于 ' + fmtDate(d.trialExpiresMs) + ' 到期。真实付费购买密钥后即可继续使用：两台电脑与一部手机可绑定同一密钥，网页版不限设备使用。';
    btn = '<a class="btn" href="/purchase">前往购买</a>';
  } else if (d.code === 'G4') {
    title = '网页版未开通';
    text = '网页版为真实付费购买密钥后开通的权益。您当前持有的密钥为免费获得（赠送、活动发放或积分兑换），不含网页版权益，使用范围仅为电脑端与手机端软件。真实付费购买密钥后即可开通网页版，并可在任意设备上登录使用。';
    btn = '<a class="btn" href="/purchase">前往购买</a>';
  } else if (d.code === 'G5') {
    title = '密钥已过期';
    text = (d.keyExpiresMs ? '您的密钥已于 ' + fmtDate(d.keyExpiresMs) + ' 到期' : '您的密钥已到期') + '，密钥已收回，当前账号无法登录。如需继续使用，请购买新密钥（可选永久套餐或按天套餐）：两台电脑与一部手机可绑定同一密钥，网页版不限设备使用。';
    btn = '<a class="btn" href="/purchase">前往购买</a>';
  } else if (d.code === 'G3') {
    title = '设备名额已满';
    text = '本设备尚未绑定密钥。您的密钥已绑定两台电脑与一部手机，如需在本设备使用，请购买新密钥。';
    btn = '<a class="btn" href="/purchase">前往购买</a>'
      + '<p class="note" style="margin-top:10px">如已更换设备，可由本设备提交换绑申诉，审核通过后以本设备替换同类旧设备：<a href="/license/rebind">申诉换绑设备</a></p>';
  } else {
    text = '当前状态暂时无法登录，请稍后再试，或咨询智能客服。';
    btn = '<a class="btn" href="/support">咨询智能客服</a>';
  }
  // G1/G2/G5 拦截页转赠领取（17:23 定版，撤换 17:03 点接受指引）：
  // 受赠人先在登录页「查询密钥」凭账号＋密码核验后看完整串并复制，再回到
  // 本页把串粘贴进激活框提交即完成领取。本页无登录会话，领取请求带账号
  // ＋密码再核验一次（只核验不签发登录态），与同一校验端点
  // POST /license/api/transfer/claim 的无会话入口一致；软件端壳（阶段
  // D/E）在登录流程内已验密，可由壳直接带核验结果调用同一端点，用户侧
  // 只需粘贴串（契约 §7.5 拦截页激活框行为）。
  const isGate = ['G1', 'G2', 'G5'].includes(d.code);
  const transferGuide = isGate
    ? '<p class="note" style="margin-top:10px">如有他人向您转赠密钥：先在登录页点击「查询密钥」，凭账号和密码核验后查看并复制完整密钥串，再回到本页粘贴到下方输入框领取；领取成功后即可正常登录使用，无需购买。</p>' : '';
  const claimBox = isGate
    ? '<div style="margin-top:14px;border:1px solid #DFE7F2;border-radius:10px;padding:14px">'
    + '<label for="qfClaimKey" style="margin-top:0">请输入 QFRemote 激活密钥</label>'
    + '<input id="qfClaimKey" type="text" maxlength="40" autocomplete="off" placeholder="粘贴完整密钥串">'
    + '<label for="qfClaimPw">账号密码（再次核验）</label>'
    + '<input id="qfClaimPw" type="password" maxlength="256" autocomplete="current-password" placeholder="输入当前账号的密码">'
    + '<button class="btn" type="button" id="qfClaimBtn">领取密钥</button>'
    + '<div id="qfClaimOut" style="margin-top:10px"></div>'
    + '<script>(function(){var btn=document.getElementById("qfClaimBtn");btn.onclick=function(){var key=document.getElementById("qfClaimKey").value.trim(),pw=document.getElementById("qfClaimPw").value,out=document.getElementById("qfClaimOut");'
    + 'if(!key){out.innerHTML="<div class=\\"err\\">请输入 QFRemote 激活密钥。</div>";return;}'
    + 'btn.disabled=true;fetch("/license/api/transfer/claim",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({username:' + JSON.stringify(String(username || '')) + ',password:pw,key:key})}).then(function(r){return r.json()}).then(function(j){btn.disabled=false;'
    + 'if(j.ok){out.innerHTML="<div class=\\"ok\\">领取成功，密钥已转入您的账号。请重新登录使用。</div><a class=\\"btn\\" href=\\"/\\">去登录</a>";}else{out.innerHTML="<div class=\\"err\\">"+String(j.msg||"领取未成功，请核对后重试。").replace(/[<>&]/g,"")+"</div>";}}).catch(function(){btn.disabled=false;out.innerHTML="<div class=\\"err\\">网络异常，请稍后再试。</div>";});};})();</' + 'script>'
    + '</div>' : '';
  const inner = '<div style="font-size:19px;font-weight:700;margin:4px 0 10px">' + esc(title) + '</div>'
    + '<p class="note" style="font-size:14px">' + esc(text) + '</p>'
    + transferGuide
    + (username ? '<p class="note">当前账号：' + esc(username) + '</p>' : '')
    + btn
    + claimBox
    + '<p class="note" style="margin-top:14px">如需帮助，可咨询<a href="/support">智能客服</a>。</p>';
  return pageShell(title, inner);
}

function hasMarker(req) {
  const c = String(req.headers.cookie || '');
  return /(?:^|;\s*)qfrem=1(?:;|$)/.test(c);
}
function addMaxAge(setCookies) {
  return setCookies.map((v) => {
    const name = v.split('=', 1)[0].trim().toLowerCase();
    if ((name === 'xid' || name === 'xid.sig') && !/;\s*max-age=/i.test(v)) return v + '; Max-Age=' + MAX_AGE;
    return v;
  });
}
function xidHashFromSetCookies(setCookies) {
  // DS-R02-③ 配套：与 ext 侧验真缓存键同构造 sha256(xid + '.' + xid.sig)，
  // 只上报哈希、不上报明文；取不到 xid 时回 null（ext 侧对非法/缺失落 null 兼容）。
  const list = Array.isArray(setCookies) ? setCookies : (setCookies ? [setCookies] : []);
  const jar = {};
  for (const v of list) {
    const first = String(v).split(';', 1)[0];
    const i = first.indexOf('=');
    if (i <= 0) continue;
    const name = first.slice(0, i).trim().toLowerCase();
    if (name === 'xid' || name === 'xid.sig') jar[name] = first.slice(i + 1).trim();
  }
  if (!jar.xid) return null;
  return crypto.createHash('sha256').update(String(jar.xid) + '.' + String(jar['xid.sig'] || '')).digest('hex');
}
function appendCookie(headers, cookie) {
  const sc = headers['set-cookie'];
  if (Array.isArray(sc)) sc.push(cookie);
  else if (sc) headers['set-cookie'] = [sc, cookie];
  else headers['set-cookie'] = [cookie];
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function todayKey() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function atomicWriteJson(file, obj) {
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 1), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
function loadJson(file, fallback) {
  try { const v = JSON.parse(fs.readFileSync(file, 'utf8')); return v == null ? fallback : v; }
  catch (e) { return fallback; }
}

// —— 冻结状态（垫片是唯一写者） ——
let freezeState = loadJson(FREEZE_FILE, { accounts: {} });
if (!freezeState.accounts) freezeState = { accounts: {} };
function accountState(key) {
  const t = todayKey();
  let st = freezeState.accounts[key];
  if (!st || st.day !== t) { st = { day: t, fails: 0, frozen: false }; freezeState.accounts[key] = st; }
  return st;
}
// DS-R28：saveFreeze 返回是否落盘成功（原调用方不接返回值，行为不变）；
// clear-freeze 端点据此如实回 500，不许内存已清、落盘失败却报成功。
function saveFreeze() { try { atomicWriteJson(FREEZE_FILE, freezeState); return true; } catch (e) { console.error('freeze 落盘失败：', e.message); return false; } }

// ===== 内网 clear-freeze 专用响应 =====
function jsonReply(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length });
  res.end(body);
}

// DS-R28：管理端解封联动——清除本地登录页当日冻结（loginshim 为 freeze.json
// 唯一写方）。仅回环监听内可达，并按 X-QF-Internal-Secret 同密钥文件校验；
// 只清「当日存在且 frozen」的条目并连同 fails 清零（不清零则下一次错密立即
// 再冻）；无条目/非当日/未冻结回 wasFrozen:false，不新建条目；落盘失败回滚
// 内存态并回 500。
async function handleClearFreeze(req, res) {
  if (req.method !== 'POST') return jsonReply(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED' });
  let secret = '';
  try { secret = fs.readFileSync(LIC_SECRET_FILE, 'utf8').trim(); } catch (e) { secret = ''; }
  const got = String(req.headers['x-qf-internal-secret'] || '');
  if (!secret || got !== secret) return jsonReply(res, 403, { ok: false, code: 'FORBIDDEN' });
  let body;
  try {
    body = await new Promise((resolve, reject) => {
      let done = false; let size = 0; const chunks = [];
      req.on('data', (c) => {
        if (done) return;
        size += c.length;
        if (size > 10000) { done = true; reject(new Error('TOO_BIG')); try { req.destroy(); } catch (e) {} return; }
        chunks.push(c);
      });
      req.on('end', () => { if (done) return; done = true; try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { reject(e); } });
      req.on('error', (e) => { if (!done) { done = true; reject(e); } });
    });
  } catch (e) { return jsonReply(res, 400, { ok: false, code: 'BAD_JSON' }); }
  const username = String(body.username || '').trim().toLowerCase();
  if (!username) return jsonReply(res, 400, { ok: false, code: 'VALIDATION' });
  const tk = todayKey();
  const st = freezeState.accounts[username];
  if (!st || st.day !== tk || !st.frozen) return jsonReply(res, 200, { ok: true, wasFrozen: false });
  const oldFrozen = st.frozen; const oldFails = st.fails;
  st.frozen = false; st.fails = 0;
  if (!saveFreeze()) {
    st.frozen = oldFrozen; st.fails = oldFails;
    return jsonReply(res, 500, { ok: false, code: 'FREEZE_WRITE_FAILED' });
  }
  return jsonReply(res, 200, { ok: true, wasFrozen: true });
}
function clientIp(req) {
  const remote = String((req.socket && req.socket.remoteAddress) || '');
  const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
  const forwarded = String((req.headers && req.headers['cf-connecting-ip']) || '').trim();
  // M-026: only our loopback proxy may supply this validated single-IP header.
  if (loopback && require('net').isIP(forwarded)) return forwarded;
  return remote.replace(/^::ffff:/, '');
}
function logAttempt(user, ok, ip, blocked) {
  try {
    fs.appendFileSync(ATTEMPTS_FILE, JSON.stringify({ ts: new Date().toISOString(), user, ok, ip, blocked: !!blocked }) + '\n');
  } catch (e) { /* 记账失败不许影响登录 */ }
}

// —— 冻结弹窗（注入登录页 </body> 前） ——
function freezePopupHtml(username) {
  const link = '/appeal?u=' + encodeURIComponent(username || '');
  return '<div id="qfFreezePopup" style="position:fixed;inset:0;background:rgba(8,18,38,.5);z-index:99999;display:flex;align-items:center;justify-content:center">'
    + '<div style="background:#fff;border-radius:14px;max-width:88vw;width:430px;padding:24px 22px;box-shadow:0 14px 44px rgba(0,0,0,.3);font-size:15px;line-height:1.8;color:#1c2733;text-align:center">'
    + '<div>' + FREEZE_TEXT_PRE + '<a href="' + link + '" style="color:#d40000;text-decoration:none;font-weight:700">' + FREEZE_LINK_TEXT + '</a></div>'
    + '<div style="margin-top:8px">也可以先咨询<a href="/support" style="color:#2470e0;text-decoration:none;font-weight:700">智能客服</a>，或在客服中申请转人工。</div>'
    + '<button type="button" onclick="document.getElementById(\'qfFreezePopup\').remove()" style="margin-top:16px;border:0;border-radius:8px;background:#2470e0;color:#fff;font-size:14px;padding:8px 26px;cursor:pointer">知道了</button>'
    + '</div></div>';
}
function injectPopup(html, username) {
  const tag = freezePopupHtml(username);
  const i = html.toLowerCase().lastIndexOf('</body>');
  if (i >= 0) return html.slice(0, i) + tag + html.slice(i);
  return html + tag;
}

/* ===== whoami（2.4.0 前置翻牌契约，组装步 1 新增） =====
 * GET /_qf_whoami —— 供前置 nginx 以 auth_request 子请求回填角色：
 * 恒回 200，响应头 X-QF-Role: siteadmin|user|anon，绝不回 401/5xx。
 * 判定机制与 ext/friends 同一：以请求 Cookie 的控制台会话（xid）开
 * MeshCentral 控制通道，收到服务器主动下发的 userinfo 才算验真；
 * userinfo.siteadmin === 4294967295（全权）→ siteadmin；其余验真
 * 用户 → user；无会话/验不过/超时/任何异常 → anon（前置条 17 定案：
 * 故障 fail-soft 落 anon，前置据此放行 SPA；站长例外在故障期失效、
 * 可用性优先）。校验结果按 sha256(xid+'.'+xid.sig) 缓存 30 秒
 * （照 ext 口径）：验真成功与服务器明拒（action=close）才入缓存，
 * 超时/连接异常不缓存，避免引擎偶发迟缓把角色误冻 30 秒。缓存
 * 上限 5000 条、写入前剪枝（照 ext DS-R02-① 口径），防根路径文档
 * 请求每次都新开校验通道。本服务只听回环、nginx 侧 location 标
 * internal 不对外，本端点只回角色字、不回任何账号信息。
 */
const WHOAMI_MC_URL = process.env.QFSHIM_MC_URL || 'wss://127.0.0.1:8443/control.ashx';
const WHOAMI_SITEADMIN_FULL = 4294967295;
let _whoamiWebSocket = null;
function whoamiLoadWebSocket() {
  if (_whoamiWebSocket) return _whoamiWebSocket;
  _whoamiWebSocket = require('ws'); // M-025: service-owned dependency
  return _whoamiWebSocket;
}
function whoamiSessionIp(cookieHeader) {
  try {
    const jar = {};
    String(cookieHeader || '').split(';').forEach((p) => { const i = p.indexOf('='); if (i > 0) jar[p.slice(0, i).trim()] = p.slice(i + 1).trim(); });
    if (!jar.xid) return null;
    const obj = JSON.parse(Buffer.from(String(jar.xid), 'base64').toString('utf8'));
    const ip = obj && obj.ip;
    if (typeof ip === 'string' && ip.length <= 64 && /^[0-9a-fA-F.:%[\]]+$/.test(ip)) return ip;
  } catch (e) { /* 解不出就走后备候选 */ }
  return null;
}
const whoamiCache = new Map(); // sha256(xid+'.'+xid.sig) -> {at, role}
const WHOAMI_CACHE_MAX = 5000;
function whoamiCacheGet(key) {
  const v = whoamiCache.get(key);
  if (!v) return null;
  if (Date.now() - v.at >= 30000) { whoamiCache.delete(key); return null; }
  return v.role;
}
function whoamiCacheSet(key, role) {
  const now = Date.now();
  if (whoamiCache.size >= WHOAMI_CACHE_MAX) {
    for (const [k, v] of whoamiCache) { if (!v || now - v.at >= 30000) whoamiCache.delete(k); }
    while (whoamiCache.size >= WHOAMI_CACHE_MAX) {
      const oldest = whoamiCache.keys().next();
      if (oldest.done) break;
      whoamiCache.delete(oldest.value);
    }
  }
  whoamiCache.set(key, { at: now, role });
}
function whoamiConnectOnce(cookieHeader, timeoutMs, fwdIp) {
  return new Promise((resolve, reject) => {
    let WebSocket;
    try { WebSocket = whoamiLoadWebSocket(); } catch (e) { reject(new Error('ws-unavailable')); return; }
    const headers = { Cookie: cookieHeader, Origin: 'https://127.0.0.1:8443' };
    if (fwdIp) headers['X-Forwarded-For'] = fwdIp;
    const ws = new WebSocket(WHOAMI_MC_URL, { rejectUnauthorized: false, headers });
    let done = false;
    const timer = setTimeout(() => finish(new Error('mc-connect-timeout')), timeoutMs);
    function finish(err, userinfo) {
      if (done) return; done = true; clearTimeout(timer);
      // 超时路径用 terminate 立即断（DS flash 复核建议 1）：引擎假死时
      // close() 的关闭握手会让半开连接滞留到 ws 内部关闭超时。
      try { if (err && err.message === 'mc-connect-timeout' && ws.terminate) ws.terminate(); else ws.close(); } catch (e) {}
      if (err) reject(err); else resolve(userinfo);
    }
    ws.on('message', (data) => {
      let m; try { m = JSON.parse(data.toString()); } catch (e) { return; }
      if (m && m.action === 'userinfo' && m.userinfo) { finish(null, m.userinfo); return; }
      // 服务器对无效/伪造会话立刻回 action=close：认这个信号秒拒（照 ext 口径）。
      if (m && m.action === 'close') finish(new Error('mc-session-rejected'));
    });
    ws.on('error', () => finish(new Error('mc-conn-error')));
    ws.on('close', () => finish(new Error('mc-auth-failed')));
  });
}
async function whoamiResolveRole(req) {
  const cookieHeader = String(req.headers.cookie || '');
  const jar = {};
  cookieHeader.split(';').forEach((p) => { const i = p.indexOf('='); if (i > 0) jar[p.slice(0, i).trim()] = p.slice(i + 1).trim(); });
  if (!jar.xid) return 'anon';
  const key = crypto.createHash('sha256').update(String(jar.xid) + '.' + String(jar['xid.sig'] || '')).digest('hex');
  const cached = whoamiCacheGet(key);
  if (cached) return cached;
  const candidates = [];
  const sip = whoamiSessionIp(cookieHeader);
  if (sip) candidates.push(sip);
  const cip = clientIp(req);
  if (cip && !candidates.includes(cip)) candidates.push(cip);
  candidates.push(null);
  let role = 'anon', cacheable = false;
  for (const ip of candidates) {
    try {
      const info = await whoamiConnectOnce(cookieHeader, 500, ip);
      role = (info && info.siteadmin === WHOAMI_SITEADMIN_FULL) ? 'siteadmin' : 'user';
      cacheable = true;
      break;
    } catch (e) {
      if (e && e.message === 'mc-session-rejected') { cacheable = true; break; }
      if (e && e.message === 'mc-connect-timeout') break; // 超时不叠试（照 ext 口径）
    }
  }
  if (cacheable) whoamiCacheSet(key, role);
  return role;
}
function handleWhoami(req, res) {
  const reply = (role) => {
    try {
      res.writeHead(200, { 'X-QF-Role': role, 'Cache-Control': 'no-store', 'Content-Length': '0' });
      res.end();
    } catch (e) { /* 子请求断开不外溢 */ }
  };
  whoamiResolveRole(req).then(reply).catch(() => reply('anon'));
}

const server = http.createServer((req, res) => {
  let pathname = req.url;
  try { pathname = new URL(req.url, 'http://localhost').pathname; } catch (e) {}
  if (pathname === '/internal/clear-freeze') return handleClearFreeze(req, res);
  if (pathname === '/_qf_whoami') return handleWhoami(req, res);
  if (pathname === '/qf-login') return handleLogin(req, res);
  if (pathname === '/appeal' || pathname.startsWith('/appeal/')) return handleAppeal(req, res, pathname);
  const isLogout = pathname === '/logout' || pathname.startsWith('/logout/');
  return handleGeneric(req, res, isLogout);
});

// base64url 编码器（Node 内置 Buffer；兼容处理 URL 安全字符）
function base64UrlEncode(str) {
  return Buffer.from(str, 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// 2026-10-28 热修（封禁登录误报）：MC 返回 messageid=110（密码验过且账号被锁定）
// 时，先通过 verify-password 二次验密（排除 maxInvalidLogin 前置 110 路径），再
// 用 login-check 确认确实存在活动封禁。若成立，给控制台返回 X-QF-Login-Result:
// banned 与 X-QF-Ban-View（base64url JSON），控制台在登录卡内画封禁/冻结门，
// 不再把封禁误报成「账号或密码不正确」。任一内网调用失败或条件不满足时，
// 都原样透传上游响应，确保不过度暴露封禁状态。
async function maybeBanAndRespond(req, res, key, usernameRaw, passwordRaw, ip, text, statusCode, upstreamHeaders, upstreamBody) {
  // 只处理 MC 返回 messageid=110 的响应
  const m = /messageid\s*=\s*parseInt\(\s*'(\d+)'\s*\)/.exec(text);
  if (!m || m[1] !== '110') return false;

  // 二次验密（走内部许可服务，与锁定位无关）
  let vp = null;
  try {
    vp = await licInternal('/internal/license/verify-password', { username: key, password: passwordRaw });
  } catch (e) {
    console.warn('bancheck verify-password error', e);
  }
  if (!vp || vp.ok !== true) {
    // 密码未二次验过：可能是前置 110 路径或 legacy passtype；fail-closed
    return false;
  }

  // 查询活动封禁（evaluate 结果）
  let lc = null;
  try {
    lc = await licInternal('/internal/license/login-check', { username: key, channel: 'web' });
  } catch (e) {
    console.warn('bancheck login-check error', e);
  }
  // R7 中性判定（DS-R25 微修，DS 门一＋增量裁定）：密码已二次验过、MC 锁定位
  // 在身，但台账无活动封禁——evaluate() 有活动封禁时必先回 BAN_PERM/BAN_UNTIL，
  // 故生产可达的非封禁形状只有 allow:true→code 'OK' 与 allow:false→G1/G2/G4/G5，
  // 落入此允许名单即属异常漂移态：只记日志、不计失败/不清零，调用方以 ok=null
  // 记录并原样透传。
  // W1-3（ds-p1-rest-20261029，DS 门一）：返回值由 'neutral' 更名为 'locked'，
  // 且其余漂移形状（lc 为空、allow:true＋BAN_* 矛盾形状、未知 code、未知
  // banCode）同归 'locked'——调用方透传时补 X-QF-Login-Result: locked 头，
  // SPA 据此呈现中性「暂时无法登录」，不再把漂移态误报成「账号或密码不正
  // 确」；计数与日志语义与原 'neutral'/回 false 路径一致（不计失败、不清零）。
  if (lc && ((lc.allow === true && lc.code === 'OK') ||
      (lc.allow === false && ['G1', 'G2', 'G4', 'G5'].indexOf(lc.code) >= 0))) {
    console.warn('bancheck inconsistent: password ok, MC locked, no active ban for', key);
    return 'locked';
  }

  if (!lc || lc.allow !== false || (lc.code !== 'BAN_PERM' && lc.code !== 'BAN_UNTIL')) {
    // 无活动封禁或非预期 code；MC 锁定位可能由其他原因产生，不透传封禁
    // 值得记异常日志：密码验过、MC 称 locked、台账却无活动封禁
    if (vp.ok === true && lc && (lc.allow !== false || (lc.code !== 'BAN_PERM' && lc.code !== 'BAN_UNTIL'))) {
      console.warn('bancheck inconsistent: password ok, MC locked, no active ban for', key);
    }
    return 'locked';
  }

  // 根据 BAN_* code 和 banCode 映射门型，不暴露原始 banCode
  let mode;
  let permanent;
  let endsAt = null;
  const banCode = String(lc.banCode || '');
  if (lc.code === 'BAN_PERM') {
    mode = 'banned';
    permanent = true;
  } else { // BAN_UNTIL
    permanent = false;
    endsAt = lc.endsAt || null;
    if (['B6', 'B7', 'B9'].indexOf(banCode) >= 0) {
      mode = 'banned';
    } else if (['B1', 'B8', 'B10'].indexOf(banCode) >= 0) {
      mode = 'frozen';
    } else {
      // 未知冻结/封禁 code；不露状态（DS-R25 P3-1：补 inconsistent 日志；
      // W1-3 起同归 'locked' 中性透传，不报密码错误）
      console.warn('bancheck inconsistent: password ok, MC locked, active BAN_UNTIL with unknown banCode ' + banCode + ' for', key);
      return 'locked';
    }
  }

  // 构造封禁数据头
  const banView = base64UrlEncode(JSON.stringify({ mode, permanent, endsAt, category: typeof lc.banCategory === 'string' ? lc.banCategory.slice(0, 200) : '' }));
  const h = Object.assign({}, upstreamHeaders);
  h['x-qf-login-result'] = 'banned';
  h['x-qf-ban-view'] = banView;
  delete h.etag;
  if (Array.isArray(h['set-cookie'])) {
    h['set-cookie'] = h['set-cookie'].filter((v) => !/^\s*xid(\.sig)?=/i.test(v));
    if (!h['set-cookie'].length) delete h['set-cookie'];
  }
  appendCookie(h, MARKER_CLEAR); // 防御：清掉旧 qfrem 标记
  logAttempt(key, null, ip, false); // 不计冻结、不清零，只记日志
  res.writeHead(statusCode || 200, h);
  res.end(upstreamBody);
  return true;
}

// —— 登录专用：冻结计数 + 摘自家字段 + 转发 MeshCentral 根路径 ——
function handleLogin(req, res) {
  if (req.method !== 'POST') { res.writeHead(405, { 'Content-Type': 'text/plain' }); return res.end('Method Not Allowed'); }
  const chunks = [];
  let size = 0;
  req.on('data', (c) => { size += c.length; if (size > 1024 * 1024) { req.destroy(); return; } chunks.push(c); });
  req.on('end', () => {
    let body = Buffer.concat(chunks);
    let remember = false;
    let usernameRaw = '';
    let passwordRaw = '';  // 新增：用于封禁判定中的 verify-password
    const ct = String(req.headers['content-type'] || '');
    if (ct.includes('application/x-www-form-urlencoded')) {
      try {
        const params = new URLSearchParams(body.toString('utf8'));
        usernameRaw = String(params.get('username') || '');
        passwordRaw = String(params.get('password') || '');  // 新增
        if (params.get('qfrememberdevice') === 'on') {
          remember = true;
          params.delete('qfrememberdevice');
          body = Buffer.from(params.toString(), 'utf8');
        }
      } catch (e) { /* 解析不了就原样转发 */ }
    }
    const key = usernameRaw.trim().toLowerCase();
    const ip = clientIp(req);
    let st = null;
    if (key) {
      st = accountState(key);
      if (st.frozen) {
        // 2026-10-26 热修（冻结误报）：冻结账号不再不验密码就回冻结页——
        // 先把凭据转发 MeshCentral 验真，按结果分流：
        //  · 密码错 → 原样透传上游失败响应（控制台据 /me 401 报「账号或密码
        //    不正确」，与未冻结时口径一致）；
        //  · 密码对 → 回冻结提示页并带结构化信号头 X-QF-Login-Result: frozen，
        //    控制台据此在登录页显示冻结提示＋申诉入口，不再误报密码错误；
        //    会话 cookie 不下发（serveFrozenPage 另行取登录页并滤掉 xid）。
        // 冻结判定与计数（B1）一概不动：本分支不改 fails/frozen、不落盘。
        return serveFrozenVerify(req, res, body, usernameRaw, passwordRaw, key, ip);
      }
    }
    const headers = Object.assign({}, req.headers, { host: '127.0.0.1:8443', 'content-length': body.length });
    delete headers.connection;
    delete headers['accept-encoding']; // 强制明文回程，便于判定成败与注入弹窗
    const up = https.request({ hostname: '127.0.0.1', port: 8443, path: '/', method: 'POST', headers, rejectUnauthorized: false }, (ur) => {
      const uchunks = [];
      ur.on('data', (c) => uchunks.push(c));
      ur.on('end', async () => {
        let ubody = Buffer.concat(uchunks);
        const h = Object.assign({}, ur.headers);
        if (remember) {
          if (Array.isArray(h['set-cookie'])) h['set-cookie'] = addMaxAge(h['set-cookie']);
          appendCookie(h, MARKER);
        } else {
          appendCookie(h, MARKER_CLEAR); // 防御：走到这里却没勾选时，清掉旧标记
        }
        if (key && st) {
          const text = ubody.toString('utf8');
          // 新增：先做封禁判定，必须在任何 verdict/冻结计数之前
          const banHandled = await maybeBanAndRespond(
            req, res, key, usernameRaw, passwordRaw, ip, text,
            ur.statusCode, ur.headers, ubody
          );
          if (banHandled === true) return;
          if (banHandled === 'locked') {
            // R7（DS-R25）＋W1-3：只记日志、不计失败/不清零、原样透传；
            // 用已算好的 h，保留 remember cookie 处理口径，并补 locked 头
            // 供 SPA 呈现中性提示（不再误报密码错误）
            logAttempt(key, null, ip, false);
            h['x-qf-login-result'] = 'locked';
            res.writeHead(ur.statusCode, h);
            res.end(ubody);
            return;
          }
          const hasLoginForm = text.includes('loginpanelform');
          let verdict = 'neutral';
          if (hasLoginForm && text.includes('登录失败')) verdict = 'fail';
          else if (!hasLoginForm) verdict = 'ok';
          if (verdict === 'fail') {
            st.fails += 1;
            if (st.fails >= FREEZE_LIMIT) st.frozen = true;
            saveFreeze();
            logAttempt(key, false, ip, false);
            if (st.frozen) {
              licInternal('/internal/license/ban-event', { username: key, code: 'B1', action: 'apply', actor: 'loginshim' }); // 统一台账回写（暂停计时联动）
              ubody = Buffer.from(injectPopup(text, usernameRaw), 'utf8');
              h['content-length'] = ubody.length;
              delete h.etag;
            }
          } else if (verdict === 'ok') {
            if (st.fails !== 0) { st.fails = 0; saveFreeze(); }
            logAttempt(key, true, ip, false);
            // 2026-10-26 热修（登录误报）：许可门不再在垫片层拦截 /qf-login。
            // 旧做法对无钥/未开通网页权益的账号回整页拦截并清会话 cookie，
            // 而新控制台丢弃登录响应体、改以 /license/api/me 判成败——会话被
            // 吃掉后 /me 必 401，G1/G2/G4/G5/BAN 被一律误报「账号或密码不正确」，
            // 且与决策 #46（未激活只限功能、不限登录）冲突。现一律透传上游
            // 响应：准入与封禁的呈现由新控制台按 /me 的 decision 处理
            // （未激活首页/准入提示态/封禁申诉入口），冻结机制不受影响。
            // QFClash 内嵌登录（2.0.3 更新 3）：带 qfr_src=qfclash 标记的
            // 一笔成功登录记入扩展服务，供个人中心「登录设备」显示来源；
            // 不改判定、不计绑定，失败不影响登录主流程。
            if (/(?:^|;\s*)qfr_src=qfclash(?:;|$)/.test(req.headers.cookie || '')) {
              licInternal('/internal/license/qfclash-login-note', { username: key, ua: req.headers['user-agent'] || '', xidHash: xidHashFromSetCookies(h['set-cookie']) });
            }
            res.writeHead(ur.statusCode, h);
            return res.end(ubody);
          } else {
            logAttempt(key, null, ip, false);
          }
        }
        res.writeHead(ur.statusCode, h);
        res.end(ubody);
      });
      ur.on('error', () => { if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' }); try { res.end('Bad Gateway'); } catch (e) {} });
    });
    up.on('error', () => { if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' }); res.end('Bad Gateway'); });
    up.write(body);
    up.end();
  });
  req.on('error', () => { try { res.destroy(); } catch (e) {} });
}

// 冻结账号的登录尝试：先转发 MeshCentral 验密码再分流（见 handleLogin 冻结
// 分支注释）。判定口径与主路径一致：上游回登录页且含「登录失败」＝密码错；
// 回非登录页＝密码对。本函数绝不修改冻结状态（fails/frozen 不动、不落盘），
// 密码对时也不透传会话，改回冻结提示页（serveFrozenPage）。
// 2026-10-28 热修：本函数同样先做封禁判定，封禁优先于冻结。
function serveFrozenVerify(req, res, body, usernameRaw, passwordRaw, key, ip) {
  // 前端传入的 passwordRaw 已在调用方解析，可用于封禁二次验密
  const headers = Object.assign({}, req.headers, { host: '127.0.0.1:8443', 'content-length': body.length });
  delete headers.connection;
  delete headers['accept-encoding']; // 强制明文回程，便于判定成败
  const up = https.request({ hostname: '127.0.0.1', port: 8443, path: '/', method: 'POST', headers, rejectUnauthorized: false }, (ur) => {
    const uchunks = [];
    ur.on('data', (c) => uchunks.push(c));
    ur.on('end', async () => {
      const ubody = Buffer.concat(uchunks);
      const text = ubody.toString('utf8');
      // 新增：封禁判定（封禁优先于冻结）
      const banHandled = await maybeBanAndRespond(
        req, res, key, usernameRaw, passwordRaw, ip, text,
        ur.statusCode, ur.headers, ubody
      );
      if (banHandled === true) return;
      if (banHandled === 'locked') {
        // R7（DS-R25）＋W1-3：冻结路径同样中性——只记日志（blocked 保持
        // true）、原样透传，不进冻结页、不动冻结状态；补 locked 头供 SPA
        // 呈现中性提示
        logAttempt(key, null, ip, true);
        const lh = Object.assign({}, ur.headers);
        lh['x-qf-login-result'] = 'locked';
        res.writeHead(ur.statusCode, lh);
        res.end(ubody);
        return;
      }
      const hasLoginForm = text.includes('loginpanelform');
      let verdict = 'neutral';
      if (hasLoginForm && text.includes('登录失败')) verdict = 'fail';
      else if (!hasLoginForm) verdict = 'ok';
      if (verdict === 'ok') {
        logAttempt(key, true, ip, true);
        return serveFrozenPage(req, res, usernameRaw);
      }
      logAttempt(key, verdict === 'fail' ? false : null, ip, true);
      res.writeHead(ur.statusCode, ur.headers);
      res.end(ubody);
    });
    ur.on('error', () => { if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' }); try { res.end('Bad Gateway'); } catch (e) {} });
  });
  up.on('error', () => { if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' }); res.end('Bad Gateway'); });
  up.write(body);
  up.end();
}

// 冻结提示：回登录页 + 冻结弹窗（只在「密码正确但账号冻结」时经此返回）
function serveFrozenPage(req, res, usernameRaw) {
  const headers = { host: '127.0.0.1:8443', 'user-agent': req.headers['user-agent'] || 'qfremote-loginshim' };
  const up = https.request({ hostname: '127.0.0.1', port: 8443, path: '/', method: 'GET', headers, rejectUnauthorized: false }, (ur) => {
    const chunks = [];
    ur.on('data', (c) => chunks.push(c));
    ur.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const body = Buffer.from(injectPopup(text, usernameRaw), 'utf8');
      const h = Object.assign({}, ur.headers, { 'content-length': body.length });
      delete h.etag;
      // 2026-10-26 热修（冻结误报）：给新控制台一个结构化信号——控制台
      // doLogin 读到 X-QF-Login-Result: frozen 即在登录页呈现冻结提示＋
      // 申诉入口，不再把冻结误报成「账号或密码不正确」。
      h['x-qf-login-result'] = 'frozen';
      // 防御：冻结提示页不得携带会话 cookie（冻结账号不签发会话）
      if (Array.isArray(h['set-cookie'])) {
        h['set-cookie'] = h['set-cookie'].filter((v) => !/^\s*xid(\.sig)?=/i.test(v));
        if (!h['set-cookie'].length) delete h['set-cookie'];
      }
      res.writeHead(200, h);
      res.end(body);
    });
    ur.on('error', () => { if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' }); try { res.end('Bad Gateway'); } catch (e) {} });
  });
  up.on('error', () => { if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' }); res.end('Bad Gateway'); });
  up.end();
}

// —— 通用转发：记住用户的控制台流量（含普通请求，流式透传） ——
function handleGeneric(req, res, isLogout) {
  const marked = hasMarker(req);
  const headers = Object.assign({}, req.headers, { host: '127.0.0.1:8443' });
  const up = https.request({ hostname: '127.0.0.1', port: 8443, path: req.url, method: req.method, headers, rejectUnauthorized: false }, (ur) => {
    const h = Object.assign({}, ur.headers);
    if (isLogout) {
      appendCookie(h, MARKER_CLEAR);
    } else if (marked && Array.isArray(h['set-cookie'])) {
      h['set-cookie'] = addMaxAge(h['set-cookie']);
    }
    res.writeHead(ur.statusCode, h);
    ur.pipe(res);
  });
  up.on('error', () => { if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' }); try { res.end('Bad Gateway'); } catch (e) {} });
  req.pipe(up);
}

// —— WebSocket 透传：记住用户的控制台长连接（原始字节管道，不解析） ——
server.on('upgrade', (req, socket, head) => {
  const upstream = tls.connect({ host: '127.0.0.1', port: 8443, rejectUnauthorized: false }, () => {
    const lines = [req.method + ' ' + req.url + ' HTTP/' + req.httpVersion];
    let hostWritten = false;
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const k = req.rawHeaders[i], v = req.rawHeaders[i + 1];
      if (k.toLowerCase() === 'host') { lines.push('Host: 127.0.0.1:8443'); hostWritten = true; }
      else lines.push(k + ': ' + v);
    }
    if (!hostWritten) lines.push('Host: 127.0.0.1:8443');
    upstream.write(lines.join('\r\n') + '\r\n\r\n');
    if (head && head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on('error', () => { try { socket.destroy(); } catch (e) {} });
  socket.on('error', () => { try { upstream.destroy(); } catch (e) {} });
});

/* ================= 申诉 ================= */

function loadAppeals() {
  const v = loadJson(APPEALS_FILE, { appeals: [] });
  if (!v || !Array.isArray(v.appeals)) return { appeals: [] };
  v.appeals = v.appeals.filter((a) => a && typeof a === 'object'); // 历史文件曾混入 null，先过滤防崩
  return v;
}
function saveAppeals(data) { atomicWriteJson(APPEALS_FILE, data); }
function appealKey(username) { return String(username || '').trim().toLowerCase(); }
function latestAppeal(data, key) {
  let best = null;
  for (const a of data.appeals) {
    if (a.key === key && (!best || a.createdAt > best.createdAt)) best = a;
  }
  return best;
}
function pageShell(title, inner) {
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>' + esc(title) + ' · QFRemote</title>'
    + '<style>'
    + 'body{margin:0;font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;background:#eef3fa;color:#1c2733}'
    + '.wrap{max-width:430px;margin:0 auto;padding:26px 16px 40px}'
    + '.brand{font-size:20px;font-weight:700;color:#1450b4;margin:8px 2px 4px}'
    + '.sub{font-size:13px;color:#5b6b7d;margin:0 2px 18px}'
    + '.card{background:#fff;border-radius:14px;padding:22px 20px;box-shadow:0 6px 24px rgba(20,60,140,.08)}'
    + 'label{display:block;font-size:13px;color:#43536a;margin:14px 0 6px}'
    + 'input,textarea{box-sizing:border-box;width:100%;border:1px solid #c9d6e8;border-radius:8px;padding:10px;font-size:15px;background:#fff}'
    + 'textarea{min-height:96px;resize:vertical}'
    + '.btn{display:block;width:100%;box-sizing:border-box;text-align:center;border:0;border-radius:9px;background:linear-gradient(135deg,#3f8cff,#2470e0);color:#fff;font-size:16px;padding:12px;margin-top:20px;cursor:pointer;text-decoration:none}'
    + '.note{font-size:13px;color:#5b6b7d;line-height:1.7}'
    + '.err{background:#fdf0f0;border:1px solid #f3c2c2;color:#a40000;border-radius:9px;padding:10px 12px;font-size:14px;line-height:1.7}'
    + '.ok{background:#eefaf0;border:1px solid #bfe6c8;color:#14632a;border-radius:9px;padding:10px 12px;font-size:14px;line-height:1.7}'
    + '.status{font-size:19px;font-weight:700;margin:4px 0 8px}'
    + 'a{color:#2470e0}'
    + '</style></head><body><div class="wrap">'
    + '<div class="brand">QFRemote</div>'
    + '<p class="sub">' + esc(title) + '</p>'
    + '<div class="card">' + inner + '</div>'
    + '<p class="note" style="text-align:center;margin-top:18px"><a href="/">返回登录页</a> · <a href="/support">智能客服</a></p>'
    + '</div></body></html>';
}
function sendHtml(res, status, html) {
  const body = Buffer.from(html, 'utf8');
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store' });
  res.end(body);
}
function readForm(req, cb) {
  const chunks = [];
  let size = 0;
  req.on('data', (c) => { size += c.length; if (size > 256 * 1024) { req.destroy(); return; } chunks.push(c); });
  req.on('end', () => {
    let params = new URLSearchParams();
    try { params = new URLSearchParams(Buffer.concat(chunks).toString('utf8')); } catch (e) {}
    cb(params);
  });
  req.on('error', () => { try { cb(new URLSearchParams()); } catch (e) {} });
}
function appealFormPage(prefillUser, errMsg) {
  const inner = (errMsg ? '<div class="err">' + esc(errMsg) + '</div>' : '')
    + '<form method="post" action="/appeal">'
    + '<label for="a-user">账号</label><input id="a-user" name="username" type="text" required maxlength="64" value="' + esc(prefillUser || '') + '">'
    + '<label for="a-pass">账号密码（身份核验）</label><input id="a-pass" name="password" type="password" required maxlength="256" autocomplete="current-password">'
    + '<p class="note">本站身份核验只使用账号密码，不使用邮箱验证码；密码只用于核验本次申诉身份。</p>'
    + '<label for="a-email">联系邮箱（仅用于接收审核结果通知，不作身份核验）</label><input id="a-email" name="email" type="email" required maxlength="120" placeholder="审核结果与改密进度都靠它联系你">'
    + '<label for="a-desc">情况说明</label><textarea id="a-desc" name="desc" required maxlength="2000" placeholder="说说账号是你的什么设备在用、最后一次成功登录大概是什么时候"></textarea>'
    + '<label for="a-newev">新证据说明（再次申诉时必填）</label><textarea id="a-newev" name="newev" maxlength="2000" placeholder="如曾就同一处理提交过申诉，请写明这次新增的事实或证据；首次申诉可留空"></textarea>'
    + '<p class="note">申诉次数上限：永久封禁可申诉 2 次，其余封禁/冻结可申诉 3 次（按同一处理计算）；再次申诉须提供新证据。</p>'
    + '<button class="btn" type="submit">提交申诉</button></form>'
    + '<p class="note" style="margin-top:14px">提交后由站长人工审核。审核进度可在登录页「申诉进度」中输入账号查询。</p>';
  return pageShell('账号冻结申诉', inner);
}
function statusFormPage(username, resultHtml) {
  const inner = '<form method="post" action="/appeal/status">'
    + '<label for="s-user">账号</label><input id="s-user" name="username" type="text" required maxlength="64" value="' + esc(username || '') + '">'
    + '<button class="btn" type="submit">查询进度</button></form>'
    + (resultHtml || '');
  return pageShell('申诉进度', inner);
}

function handleAppeal(req, res, pathname) {
  const q = new URL(req.url, 'http://localhost').searchParams;
  if (pathname === '/appeal') {
    // 收编二期收口（2026-10-26）：独立申诉页退役，活路只剩控制台 SPA 的申诉视图（/#appeal）；
    // POST /appeal 提交、POST /appeal/status 进度、/appeal/reset 一次性改密页原样保留。
    if (req.method === 'GET') { res.writeHead(302, { 'Location': '/#appeal', 'Cache-Control': 'no-store' }); return res.end(); }
    if (req.method === 'POST') return readForm(req, (p) => handleAppealSubmit(req, res, p));
  }
  if (pathname === '/appeal/status') {
    if (req.method === 'GET') { res.writeHead(302, { 'Location': '/#appeal', 'Cache-Control': 'no-store' }); return res.end(); }
    if (req.method === 'POST') return readForm(req, (p) => handleStatusQuery(req, res, p));
  }
  if (pathname === '/appeal/reset') {
    if (req.method === 'GET') return handleResetGet(req, res, q.get('t') || '');
    if (req.method === 'POST') return readForm(req, (p) => handleResetPost(req, res, p));
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
}

async function handleAppealSubmit(req, res, p) {
  const username = String(p.get('username') || '').trim();
  const email = String(p.get('email') || '').trim();
  const desc = String(p.get('desc') || '').trim();
  if (!username || !email || !desc) return sendHtml(res, 200, appealFormPage(username, '账号、联系邮箱、情况说明三项均须填写。'));
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return sendHtml(res, 200, appealFormPage(username, '联系邮箱格式不正确，请检查后重新填写。'));
  // 身份核验（裁决批③：全站统一账号＋密码，废止邮箱核验）：经许可内网
  // 核验端点验密，不存在的账号与密码错误回同一提示，不透露账号是否存在。
  const vpw = await licInternal('/internal/license/verify-password', { username: appealKey(username), password: String(p.get('password') || '') });
  if (!vpw || vpw.ok !== true) return sendHtml(res, 200, appealFormPage(username, '账号或密码不正确，无法核验身份，请核对后重新提交。'));
  const key = appealKey(username);
  const st = accountState(key);
  if (!st.frozen) {
    // 统一申诉：不在 B1 冻结中时，查统一封禁台账（B2/B3/B6/B7/B8/B9/B10）
    const chk = await licInternal('/internal/license/appeal-check', { username: key });
    if (chk && chk.ok && chk.hasActiveBan) {
      const data = loadAppeals();
      // 申诉次数上限（站长 16:53 裁决，按同一处置计）：永久 2 次，其余 3 次
      const prior = data.appeals.filter((a) => a.key === key && a.banId === chk.ban.id);
      const limit = chk.ban.permanent ? 2 : 3;
      if (prior.length >= limit) {
        return sendHtml(res, 200, pageShell('申诉',
          '<div class="err">该处理已达申诉次数上限（' + limit + ' 次），申诉入口关闭。如仍有疑问，请联系智能客服。</div>'));
      }
      // 再次申诉须新证据（§6.5 并行保留）
      const hasDecided = prior.some((a) => a.status === 'rejected' || a.status === 'approved');
      const newev = String(p.get('newev') || '').trim();
      if (hasDecided && !newev) {
        return sendHtml(res, 200, appealFormPage(username, '您已就同一处理提交过申诉。再次申诉须在「新证据说明」中写明新增的事实或证据。'));
      }
      const existU = data.appeals.find((a) => a.key === key && a.banId === chk.ban.id && a.status === 'pending');
      if (existU) {
        return sendHtml(res, 200, pageShell('申诉',
          '<div class="ok">该封禁已有一条申诉正在审核中，无需重复提交。<br>申诉编号：' + esc(existU.id) + '<br><a href="/appeal/status?u=' + encodeURIComponent(username) + '">去看申诉进度</a></div>'));
      }
      const appealU = {
        id: crypto.randomBytes(4).toString('hex'),
        username, key, email, desc: newev ? desc + '\n【新证据】' + newev : desc,
        reasonCode: chk.ban.code, banId: chk.ban.id,
        status: 'pending', createdAt: Date.now(),
      };
      data.appeals.push(appealU);
      try { saveAppeals(data); } catch (e) { return sendHtml(res, 500, appealFormPage(username, '提交失败，请稍后再试。')); }
      licInternal('/internal/events/push', { type: 'appeal', refId: appealU.id, summary: { username: key, reasonCode: chk.ban.code } }); // #31 统一事件队列（不阻塞响应）
      return sendHtml(res, 200, pageShell('申诉',
        '<div class="ok">申诉已提交，正在审核中。申诉编号：' + esc(appealU.id) + '，请保存编号，凭编号在「申诉进度」查询结果。申诉已进入人工审核队列，处理结果将在进度页更新。</div>'
        + '<a class="btn" href="/appeal/status?u=' + encodeURIComponent(username) + '">查看申诉进度</a>'));
    }
    return sendHtml(res, 200, pageShell('账号冻结申诉',
      '<div class="ok">该账号当前未被冻结或封禁，无需申诉。如忘记密码，请联系站长处理。</div>'));
  }
  const data = loadAppeals();
  // B1 属冻结类：同一处置（当日冻结）上限 3 次（16:53 裁决）
  const priorB1 = data.appeals.filter((a) => a.key === key && a.freezeDay === st.day && !a.banId);
  if (priorB1.length >= 3) {
    return sendHtml(res, 200, pageShell('账号冻结申诉',
      '<div class="err">本次冻结已达申诉次数上限（3 次），申诉入口关闭。冻结将于次日 0 点自动解除。</div>'));
  }
  const exist = data.appeals.find((a) => a.key === key && a.freezeDay === st.day && a.status === 'pending');
  if (exist) {
    return sendHtml(res, 200, pageShell('账号冻结申诉',
      '<div class="ok">该账号今日已提交申诉，正在审核中，无需重复提交。<br><a href="/appeal/status?u=' + encodeURIComponent(username) + '">去看申诉进度</a></div>'));
  }
  const approvedOpen = data.appeals.find((a) => a.key === key && a.status === 'approved');
  if (approvedOpen) {
    return sendHtml(res, 200, pageShell('账号冻结申诉',
      '<div class="ok">该账号的申诉已通过。<br><a href="/appeal/status?u=' + encodeURIComponent(username) + '">去申诉进度页改密码</a></div>'));
  }
  // 再次申诉须新证据（§6.5，阶段 F 深查修复：与统一封禁申诉同口径补齐
  // B1 分支——此前 B1 被驳回后可无新证据重复提交，与统一路径不一致）
  const newevB1 = String(p.get('newev') || '').trim();
  const hasDecidedB1 = priorB1.some((a) => a.status === 'rejected');
  if (hasDecidedB1 && !newevB1) {
    return sendHtml(res, 200, appealFormPage(username, '您已就同一处理提交过申诉。再次申诉须在「新证据说明」中写明新增的事实或证据。'));
  }
  const appeal = {
    id: crypto.randomBytes(4).toString('hex'),
    username, key, email, desc: newevB1 ? desc + '\n【新证据】' + newevB1 : desc,
    freezeDay: st.day,
    status: 'pending',
    createdAt: Date.now(),
  };
  data.appeals.push(appeal);
  try { saveAppeals(data); }
  catch (e) { return sendHtml(res, 500, appealFormPage(username, '提交失败，请稍后再试。')); }
  licInternal('/internal/events/push', { type: 'appeal', refId: appeal.id, summary: { username: key, reasonCode: 'B1' } }); // #31 统一事件队列（不阻塞响应）
  return sendHtml(res, 200, pageShell('账号冻结申诉',
    '<div class="ok">申诉已提交，正在审核中。站长处理后，可在「申诉进度」中输入账号查看结果。</div>'
    + '<a class="btn" href="/appeal/status?u=' + encodeURIComponent(username) + '">查看申诉进度</a>'));
}

function handleStatusQuery(req, res, p) {
  const username = String(p.get('username') || '').trim();
  if (!username) return sendHtml(res, 200, statusFormPage('', ''));
  const data = loadAppeals();
  const a = latestAppeal(data, appealKey(username));
  let html;
  if (!a) {
    html = '<div class="err" style="margin-top:16px">未查询到该账号的申诉记录。</div>';
  } else if (a.status === 'pending' && a.type === 'rebind') {
    html = '<div style="margin-top:18px"><div class="status">审核中</div>'
      + '<p class="note">换绑申诉已收到，正在人工审核中。审核通过后，同类旧设备将解绑、本设备将绑入。</p></div>';
  } else if (a.status === 'pending') {
    html = '<div style="margin-top:18px"><div class="status">审核中</div>'
      + '<p class="note">申诉已收到，站长将尽快审核，请耐心等待。</p></div>';
  } else if (a.status === 'approved' && a.type === 'rebind') {
    html = '<div style="margin-top:18px"><div class="status">已通过</div>'
      + '<p class="note">换绑申诉已通过，设备已换绑完成，请在新设备上登录使用。</p>'
      + '<a class="btn" href="/">去登录</a></div>';
  } else if (a.status === 'approved' && a.banId) {
    html = '<div style="margin-top:18px"><div class="status">已通过</div>'
      + '<p class="note">申诉已通过，封禁已解除，请重新登录。如曾因永久封禁被回收密钥，原密钥已恢复。</p>'
      + '<a class="btn" href="/">去登录</a></div>';
  } else if (a.status === 'approved') {
    html = '<div style="margin-top:18px"><div class="status">已通过</div>'
      + '<p class="note">申诉已通过，请点下方按钮设置新密码。设置完成后冻结自动解除，请使用新密码登录。</p>'
      + '<a class="btn" href="/appeal/reset?t=' + encodeURIComponent(a.token || '') + '">修改密码</a></div>';
  } else if (a.status === 'rejected') {
    html = '<div style="margin-top:18px"><div class="status">已驳回</div>'
      + '<p class="note">原因：' + esc(a.reason || '未说明') + '</p></div>';
  } else if (a.status === 'done') {
    html = '<div style="margin-top:18px"><div class="status">已通过</div>'
      + '<p class="note">密码已经修改完成，冻结已解除，请用新密码登录。</p></div>';
  } else {
    html = '<div class="err" style="margin-top:16px">状态异常，请联系站长。</div>';
  }
  return sendHtml(res, 200, statusFormPage(username, html));
}

function findByToken(data, token) {
  if (!token || !/^[a-f0-9]{48}$/.test(token)) return null;
  return data.appeals.find((a) => a.status === 'approved' && a.token === token) || null;
}
function resetFormPage(token, errMsg) {
  const inner = (errMsg ? '<div class="err">' + esc(errMsg) + '</div>' : '')
    + '<form method="post" action="/appeal/reset">'
    + '<input type="hidden" name="t" value="' + esc(token) + '">'
    + '<label for="r-p1">新密码</label><input id="r-p1" name="password" type="password" required minlength="8" maxlength="256" placeholder="至少 8 位">'
    + '<label for="r-p2">请再次输入新密码</label><input id="r-p2" name="password2" type="password" required minlength="8" maxlength="256">'
    + '<button class="btn" type="submit">确认修改</button></form>'
    + '<p class="note" style="margin-top:14px">本改密入口仅可使用一次。设置完成后冻结自动解除，请使用新密码登录。</p>';
  return pageShell('修改密码', inner);
}
function handleResetGet(req, res, token) {
  const data = loadAppeals();
  const a = findByToken(data, token);
  if (!a) {
    return sendHtml(res, 200, pageShell('修改密码',
      '<div class="err">本改密入口不正确，或已被使用。请返回「申诉进度」页输入账号重新查看。</div>'));
  }
  return sendHtml(res, 200, resetFormPage(token, ''));
}
function handleResetPost(req, res, p) {
  const token = String(p.get('t') || '');
  const pw = String(p.get('password') || '');
  const pw2 = String(p.get('password2') || '');
  const data = loadAppeals();
  const a = findByToken(data, token);
  if (!a) {
    return sendHtml(res, 200, pageShell('修改密码',
      '<div class="err">本改密入口不正确，或已被使用。请返回「申诉进度」页输入账号重新查看。</div>'));
  }
  if (pw.length < 8) return sendHtml(res, 200, resetFormPage(token, '新密码至少为 8 位。'));
  if (pw !== pw2) return sendHtml(res, 200, resetFormPage(token, '两次输入的新密码不一致，请重新输入。'));
  if (!passmod) return sendHtml(res, 500, resetFormPage(token, '服务器暂时无法处理，请稍后再试或联系站长。'));
  passmod.hash(pw, (err, salt, hash) => {
    if (err) return sendHtml(res, 500, resetFormPage(token, '服务器暂时无法处理，请稍后再试或联系站长。'));
    let spoolFile;
    try {
      fs.mkdirSync(SPOOL_DIR, { recursive: true });
      spoolFile = path.join(SPOOL_DIR, token + '.json');
      fs.writeFileSync(spoolFile, JSON.stringify({ username: a.username, salt, hash }), { mode: 0o600 });
    } catch (e) {
      return sendHtml(res, 500, resetFormPage(token, '服务器暂时无法处理，请稍后再试或联系站长。'));
    }
    execFile('sudo', ['-n', SETPASS_CMD, token], { timeout: 90000 }, (e2) => {
      if (e2) {
        try { fs.unlinkSync(spoolFile); } catch (e) {}
        console.error('申诉改密执行失败：', e2.message);
        return sendHtml(res, 500, resetFormPage(token, '修改未成功，请稍后再试；如仍不成功，请联系站长。'));
      }
      a.status = 'done';
      delete a.token;
      a.doneAt = Date.now();
      try { saveAppeals(data); } catch (e) {}
      const st = freezeState.accounts[a.key];
      if (st) { st.fails = 0; st.frozen = false; saveFreeze(); }
      return sendHtml(res, 200, pageShell('修改密码',
        '<div class="ok">密码已修改，冻结已解除。请用新密码登录。</div>'
        + '<a class="btn" href="/">去登录</a>'));
    });
  });
}

server.listen(8450, '127.0.0.1', () => {
  console.log('qfremote-loginshim listening on 127.0.0.1:8450');
});
