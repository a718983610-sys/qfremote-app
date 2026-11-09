'use strict';
/*
 * QFRemote SYSTEM helper 客户端（2.4.5，最小安全版）
 * ================================================================
 * 服务端：QFSysHelper（Windows SYSTEM 服务，源码见 syshelper/，
 * 以 SYSTEM 身份常驻，只收命名管道 \\.\pipe\QFSysHelper 的固定命令）。
 *
 * 安全边界（写死，不许放宽）：
 *   - 只收两个固定命令：heal-agent（提权跑 agent-heal PS1）、
 *     install-lock（安装锁服务 QFLockSvc）。不留执行任意脚本的口子：
 *     客户端发来的只有命令名＋（install-lock 时）一个 Owner 字符串，
 *     脚本路径与参数全部由服务端写死，执行前先算 SHA-256 对白名单；
 *   - Owner 只允许字母/数字/_/@/./- 与 CJK 字符，1–64 字符，拒绝一切
 *     引号/反斜杠/ shell 元字符/控制字符（本模块先验，服务端再验）；
 *   - 白名单 whitelist.json 随包下发（build.files），含本次发版四件
 *     文件的 SHA-256；App 提权拉起安装脚本前先验 hash，hash 不对绝不拉起；
 *   - 全部动作记日志：服务端写 %ProgramData%\\QFRemote\\SysHelper\\helper.log，
 *     客户端失败记 bootLog（由 main.js 接）。
 *   - helper 不可用（未安装/未启动/超时/坏响应）时调用方回落 runas UAC，
 *     绝不因此阻塞自愈或锁安装。
 *
 * 本模块不依赖 Electron（net 直连命名管道，Linux 上直接返回 unavailable，
 * 便于单测）；main.js 负责在 Windows 上调用。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const net = require('net');

const PIPE_NAME = '\\\\.\\pipe\\QFSysHelper';
const WHITELIST_NAME = 'whitelist.json';
// 固定命令表：除此之外服务端一律拒绝。
const COMMANDS = ['heal-agent', 'install-lock'];
const OWNER_RE = /^[A-Za-z0-9_@.\-\u4e00-\u9fa5]{1,64}$/;

// Owner 校验：1–64 字符，只许字母/数字/_/@/./- 与 CJK；拒绝引号、
// 反斜杠、空白、控制字符与一切 shell 元字符。
function validateOwner(owner) {
  if (typeof owner !== 'string') return false;
  return OWNER_RE.test(owner);
}

function buildRequest(cmd, owner, filePath) {
  if (COMMANDS.indexOf(cmd) < 0) return null;
  if (cmd === 'install-lock' && !validateOwner(owner)) return null;
  // path 只是定位符：服务端执行前必验 SHA-256 白名单＋basename 对应；
  // 客户端先做形状校验（绝对路径、无 ".."、basename 对应）。
  if (typeof filePath !== 'string' || !filePath) return null;
  if (filePath.indexOf('..') >= 0) return null;
  const abs = /^[A-Za-z]:[\\/]/.test(filePath) || filePath.startsWith('\\\\');
  if (!abs) return null;
  const base = filePath.split(/[\\/]/).pop();
  const want = cmd === 'heal-agent' ? 'qf-agent-heal.ps1' : 'install.ps1';
  if (base !== want) return null;
  const obj = { cmd, path: filePath };
  if (cmd === 'install-lock') obj.owner = owner;
  return JSON.stringify(obj) + '\n';
}

// 服务端响应解析：{ok, code, detail?}，形状不对返回 null。
function parseHelperResponse(text) {
  let j = null;
  try { j = JSON.parse(String(text || '').trim()); } catch (e) { return null; }
  if (!j || typeof j !== 'object' || typeof j.ok !== 'boolean' || typeof j.code !== 'string') return null;
  return { ok: j.ok, code: j.code, detail: typeof j.detail === 'string' ? j.detail : null };
}

// 白名单加载：resources/（根与 syshelper/ 子目录）优先，其次 __dirname
// （根与 syshelper/ 子目录，开发态）。
function loadWhitelist(o) {
  const cands = [];
  if (o && o.resourcesPath) {
    cands.push(path.join(o.resourcesPath, WHITELIST_NAME));
    cands.push(path.join(o.resourcesPath, 'syshelper', WHITELIST_NAME));
  }
  if (o && o.dirname) {
    cands.push(path.join(o.dirname, WHITELIST_NAME));
    cands.push(path.join(o.dirname, 'syshelper', WHITELIST_NAME));
  }
  for (const c of cands) {
    try {
      const j = JSON.parse(fs.readFileSync(c, 'utf8'));
      if (j && j.files && typeof j.files === 'object') return j;
    } catch (e) { /* try next */ }
  }
  return null;
}

// 文件 SHA-256 是否与白名单一致（按 basename 查表；无表/无条目即 false）。
function verifyFileHash(filePath, whitelist) {
  try {
    if (!whitelist || !whitelist.files) return false;
    const want = whitelist.files[path.basename(filePath)];
    if (typeof want !== 'string' || !/^[0-9a-f]{64}$/.test(want)) return false;
    const h = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
    return h === want.toLowerCase();
  } catch (e) { return false; }
}

// 调 helper：命名管道一问一答。opts.connect 可注入假实现做单测；
// opts.timeoutMs 默认 150000（PS1 最长约 120 秒）；opts.path 为脚本定位符。
// 返回 {ok, code, detail}；管道不可用返回 {ok:false, code:'unavailable'}。
function callHelper(cmd, owner, opts) {
  const o = opts || {};
  const req = buildRequest(cmd, owner, o.path);
  if (!req) return Promise.resolve({ ok: false, code: 'bad-request' });
  const connectFn = o.connect || ((pipeName) => net.connect(pipeName));
  const timeoutMs = o.timeoutMs || 150000;
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let sock = null;
    try {
      sock = connectFn(PIPE_NAME);
    } catch (e) {
      finish({ ok: false, code: 'unavailable' });
      return;
    }
    if (!sock || typeof sock.on !== 'function') { finish({ ok: false, code: 'unavailable' }); return; }
    const timer = setTimeout(() => {
      // 先落定 timeout 再拆 socket：destroy() 会同步触发 close，
      // 若先拆，close 处理会抢先以 unavailable 落定（同 E1 竞态）。
      finish({ ok: false, code: 'timeout' });
      try { sock.destroy(); } catch (e) { /* ignore */ }
    }, timeoutMs);
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      const idx = buf.indexOf('\n');
      if (idx >= 0) {
        clearTimeout(timer);
        const parsed = parseHelperResponse(buf.slice(0, idx));
        // 先落定结果再关 socket：end() 会同步触发 close，若先 end，
        // close 处理会抢先以 unavailable 落定（fake socket 实测复现）。
        finish(parsed || { ok: false, code: 'bad-response' });
        try { sock.end(); } catch (e) { /* ignore */ }
      }
    });
    sock.on('error', () => { clearTimeout(timer); finish({ ok: false, code: 'unavailable' }); });
    sock.on('close', () => {
      clearTimeout(timer);
      if (!done) finish({ ok: false, code: 'unavailable' });
    });
    try { sock.write(req); } catch (e) { clearTimeout(timer); finish({ ok: false, code: 'unavailable' }); }
  });
}

module.exports = {
  PIPE_NAME,
  WHITELIST_NAME,
  COMMANDS,
  validateOwner,
  buildRequest,
  parseHelperResponse,
  loadWhitelist,
  verifyFileHash,
  callHelper
};
