'use strict';
/*
 * permission-policy.js — S-003（审计 F-019＋第三份 P2-07）：权限请求
 * deny-by-default 统一策略。
 * ============================================================================
 * 问题：各 session partition 上没有任何 setPermissionRequestHandler，
 * 权限请求无统一 deny-by-default handler。
 *
 * 策略（默认拒绝，只对白名单 origin、明确功能、用户主动操作时才放行）：
 *   - 摄像头／麦克风／位置当前不用：直接拒绝（不在任何 allowlist 内）；
 *   - 其余权限同样默认拒绝；未来某功能确需权限时，由调用方经 opts.allow
 *     显式登记 { permission: [origin, ...] }，且须同时满足：
 *     请求 origin 在登记内、details.userGesture 为真（用户主动操作）；
 *   - 同时装 setPermissionCheckHandler：权限查询也按同一表裁决，不让
 *     查询侧先回 true 再在请求侧拒绝造成内外不一致；
 *   - 新 session 创建时自动安装：main.js 在每次取 persist:qfremote
 *     会话后调 installPermissionPolicy（同一 session 重复安装即 no-op，
 *     以 session 对象上的标记去重）。
 *
 * 本模块是纯 JS（不 require electron，可在纯 node 下单测；session 只须
 * 提供 setPermissionRequestHandler／setPermissionCheckHandler 两个方法）。
 */
// 永不放行：摄像头／麦克风／位置当前不用（任务书点名直接拒绝），
// 外加同级高危（MIDI SysEx、屏幕捕获、空闲检测）——应用内无任何场景需要。
// 其余权限仍默认拒绝，只有调用方经 opts.allow 显式登记 origin＋用户手势
// 才放行（见 makeDecider）。
const ALWAYS_DENY = new Set([
  'camera', 'microphone', 'geolocation', 'midiSysex',
  'display-capture', 'idle-detection'
]);

function originOf(url) {
  try { return new URL(String(url || '')).origin; } catch (e) { return ''; }
}

// 构造裁决函数（供单测直接验）：(permission, requestingUrl, userGesture) => bool。
function makeDecider(opts) {
  const allow = (opts && opts.allow) || {};
  return function decide(permission, requestingUrl, userGesture) {
    const perm = String(permission || '');
    if (ALWAYS_DENY.has(perm)) return false;
    const origins = allow[perm];
    if (!Array.isArray(origins) || origins.length === 0) return false;
    if (userGesture !== true) return false; // 非用户主动操作一律不放行
    return origins.indexOf(originOf(requestingUrl)) >= 0;
  };
}

function installPermissionPolicy(sessionLike, opts) {
  if (!sessionLike || typeof sessionLike !== 'object') return false;
  if (sessionLike.__qfPermissionPolicyInstalled) return false;
  if (typeof sessionLike.setPermissionRequestHandler !== 'function') return false;
  const decide = makeDecider(opts);
  try {
    sessionLike.setPermissionRequestHandler((webContents, permission, callback, details) => {
      let ok = false;
      try {
        const d = details || {};
        ok = decide(permission, d.requestingUrl, d.userGesture);
      } catch (e) { ok = false; }
      try { callback(ok); } catch (e) { /* ignore */ }
    });
  } catch (e) { return false; }
  if (typeof sessionLike.setPermissionCheckHandler === 'function') {
    try {
      sessionLike.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
        try {
          const d = details || {};
          return decide(permission, requestingOrigin || d.requestingUrl, d.userGesture);
        } catch (e) { return false; }
      });
    } catch (e) { /* check handler 装不上不影响请求 handler 已生效 */ }
  }
  try { sessionLike.__qfPermissionPolicyInstalled = true; } catch (e) { /* ignore */ }
  return true;
}

module.exports = { ALWAYS_DENY, makeDecider, installPermissionPolicy };
