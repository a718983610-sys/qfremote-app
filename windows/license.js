'use strict';
/*
 * QFRemote 许可体系壳侧纯逻辑（2.3.1 阶段 E；与安卓阶段 D 的
 * lib/core/license.dart 同口径平移，契约正本 v231/license-api-contract.md，
 * 文案正本 v231/ban-appeal-design.md §四 L 系列——按 code 取文案，不得另编）。
 *
 * 数据来源（全部是扩展服务同源接口，鉴权＝控制台会话 cookie 桥，主进程
 * extRequest 转发）：
 * - POST /license/api/device-report：会话建立后立即上报设备码（契约 §3 写死
 *   时机），响应带 device{reviewPending, forceLogout} 与 decision；
 * - GET /license/api/me：本人许可概览＋decision（software 渠道判定）；
 * - POST /points/api/heartbeat 响应与 /license/api/me 顶层 forceLogout
 *   （契约 §7.5.7：转赠领取后原主人即时强制下线信号）。
 *
 * 影子口径（不得自改）：服务端 shadow=true 时，非测试名单账号的 decision
 * 只记录不拦截——evaluate 的 enforce 字段为 false 时壳侧不许拦人；只有
 * enforce=true 的判定才落原生拦截面。forceLogout 与 DEVICE_REVIEW
 * （device-report 专属，契约 §7.6）是服务端已生效的会话处置信号，
 * 不走影子门，收到即执行。
 *
 * 本模块纯逻辑（不碰 Electron），解析函数接受已解析的 JSON 对象
 * （也兼容 JSON 字符串），供 Node 单测。
 */

function asObj(v) {
  if (v && typeof v === 'object') return v;
  if (typeof v === 'string') { try { return JSON.parse(v); } catch (e) { return null; } }
  return null;
}
function asMs(x) { return (typeof x === 'number' && Number.isFinite(x)) ? Math.trunc(x) : null; }
function asStr(x) { return (typeof x === 'string' && x) ? x : null; }

// ---------- 许可判定解析（login-check / device-report / me.decision 同构） ----------
function parseDecision(v) {
  const o = asObj(v);
  if (!o) return null;
  if (typeof o.code !== 'string' || !o.code) return null;
  return {
    allow: o.allow === true,
    code: o.code,
    shadow: o.shadow === true,
    enforce: o.enforce === true,
    forceLogout: o.forceLogout === true,
    endsAtMs: asMs(o.endsAt),
    trialExpiresMs: asMs(o.trialExpiresMs),
    keyExpiresMs: asMs(o.keyExpiresMs),
    banCode: asStr(o.banCode)
  };
}

// ---------- /license/api/me 本人许可概览 ----------
function parseMe(v) {
  const root = asObj(v);
  if (!root || root.ok !== true) return null;
  const slots = (root.slots && typeof root.slots === 'object') ? root.slots : {};
  const slot = (x) => (typeof x === 'number' && Number.isFinite(x)) ? Math.trunc(x) : 0;
  const slotMax = (x, dflt) => (typeof x === 'number' && Number.isFinite(x)) ? Math.trunc(x) : dflt;
  const asNum = (x) => (typeof x === 'number' && Number.isFinite(x)) ? Math.trunc(x) : null;
  return {
    username: asStr(root.username),
    planName: asStr(root.planName),
    maskedKey: asStr(root.maskedKey),
    displayStatus: asStr(root.displayStatus),
    slotsPc: slot(slots.pc),
    slotsMobile: slot(slots.mobile),
    slotsPcMax: slotMax(slots.pcMax, 2),
    slotsMobileMax: slotMax(slots.mobileMax, 1),
    trialExpiresMs: asMs(root.trialExpiresMs),
    keyExpiresMs: asMs(root.keyExpiresMs),
    webEnabled: root.webEnabled === true,
    everBanned: root.everBanned === true,
    hasKey: root.hasKey === true,
    keyLifecycle: asStr(root.keyLifecycle),
    keyPlan: asStr(root.keyPlan),
    keyDurationHours: asNum(root.keyDurationHours),
    serverRemainText: asStr(root.remainText),
    decision: parseDecision(root.decision),
    // 顶层 forceLogout（§7.5.7）：true 时壳须立即登出并落 G1 拦截
    forceLogout: root.forceLogout === true,
    gateCode: asStr(root.gateCode)
  };
}

// ---------- device-report 响应（契约 §3＋§7.6） ----------
function parseDeviceReport(v) {
  const root = asObj(v);
  if (!root || root.ok !== true) return null;
  const dev = (root.device && typeof root.device === 'object') ? root.device : {};
  return {
    reviewPending: dev.reviewPending === true,
    deviceForceLogout: dev.forceLogout === true,
    decision: parseDecision(root.decision)
  };
}

// ---------- 时长折算（与网页正本 home-page.js 的 fmtRemain 逐字同口径：
// 满 24 小时制——先整天、再小时、再分钟，不用自然日） ----------
function formatRemainMs(ms) {
  if (!(ms > 0)) return '已到期';
  const d = Math.floor(ms / 86400000);
  const h = Math.floor((ms % 86400000) / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (d > 0) return d + ' 天 ' + h + ' 小时';
  if (h > 0) return h + ' 小时 ' + m + ' 分钟';
  return m + ' 分钟';
}

// TrialBar 显隐与文案（与网页正本同条件、同文案）：
// 试用套餐、试用未到期、网页版未开通时才出现。
function trialBarText(me, nowMs) {
  if (!me) return null;
  const exp = me.trialExpiresMs;
  if (exp == null || exp <= nowMs) return null;
  if (me.webEnabled) return null;
  if (me.planName !== 'QFRemote 试用套餐') return null;
  return '免费试用中 · 剩余 ' + formatRemainMs(exp - nowMs);
}

// 「剩余时长」行：服务端 remainText 优先（统一文案），本地兜底与服务端
// 同序同文案：付费钥到期 → 试用 → 无钥 → 未激活（按天/永久）→
// 已过期/已收回 → 长期有效。
const TIMED_PLAN_HOURS = { d1: 24, d7: 168, d30: 720 };
function licenseRemainText(me, nowMs) {
  if (!me) return '—';
  if (typeof me.serverRemainText === 'string' && me.serverRemainText) return me.serverRemainText;
  if (me.keyExpiresMs != null) return formatRemainMs(me.keyExpiresMs - nowMs);
  if (me.planName === 'QFRemote 试用套餐' && me.trialExpiresMs != null) {
    return formatRemainMs(me.trialExpiresMs - nowMs);
  }
  if (!me.hasKey) return '—';
  if (me.keyLifecycle === 'expired') return '已过期';
  if (me.keyLifecycle === 'revoked') return '已收回';
  const isTimedPlan = Object.prototype.hasOwnProperty.call(TIMED_PLAN_HOURS, me.keyPlan);
  if (me.keyLifecycle === 'unactivated') {
    if (me.keyPlan === 'permanent') return '未激活（激活后长期有效）';
    const h = (typeof me.keyDurationHours === 'number' && Number.isFinite(me.keyDurationHours))
      ? me.keyDurationHours : (isTimedPlan ? TIMED_PLAN_HOURS[me.keyPlan] : null);
    if (h != null) return '未激活（自激活起 ' + h + ' 小时有效）';
    return '未激活';
  }
  if (!me.keyLifecycle && isTimedPlan) {
    const h = (typeof me.keyDurationHours === 'number' && Number.isFinite(me.keyDurationHours))
      ? me.keyDurationHours : TIMED_PLAN_HOURS[me.keyPlan];
    if (h != null) return '未激活（自激活起 ' + h + ' 小时有效）';
    return '未激活';
  }
  return '长期有效';
}

// 许可入口分流（决策 #49）：permanent=已激活永久、timed=已激活按天、
// 其余（含 null me）一律 inactive。
function licenseEntryMode(me) {
  if (!me) return 'inactive';
  if (me.keyPlan === 'permanent' && me.keyLifecycle === 'activated') return 'permanent';
  if (me.keyLifecycle === 'activated' && (me.keyPlan === 'd1' || me.keyPlan === 'd7' || me.keyPlan === 'd30')) return 'timed';
  return 'inactive';
}

// 日期文案（L8/L12 用）：X 年 X 月 X 日（壳侧按本机时区格式化——
// 用户设备即国内时区，与安卓端口径一致，不另造转换）
function formatDateZh(ms) {
  const d = new Date(ms);
  return d.getFullYear() + ' 年 ' + (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日';
}

// ---------- 拦截文案（设计稿 §四 L 系列；与安卓 gateCopyFor 逐字一致） ----------
// L16 转赠领取指引（附于 G1/G2/G5 拦截页，逐字正本）
const TRANSFER_GUIDE_TEXT = '如有其他用户向您转赠密钥，您可在本页登录区点击「查询密钥」，凭账号与密码完成核验后，查看并复制该密钥；再使用您的账号登录，在登录时弹出的激活密钥输入框中粘贴提交，即可完成领取并正常使用。';
// 激活密钥输入框标签（L17，逐字写死，品牌名拼写不得改）
const CLAIM_INPUT_LABEL = '请输入 QFRemote 激活密钥';
// 未知 code 的兜底文案（与安卓主框架/loginshim 同款，不自编、不放行假状态）
const FALLBACK_GATE_COPY = {
  title: '暂时无法登录',
  body: '当前状态暂时无法登录，请稍后再试，或咨询智能客服。',
  primary: 'none', hasClaimBox: false, hasTransferGuide: false
};

// primary: 'purchase' | 'appeal' | 'none'
// 未知 code 返回 null（调用方用 FALLBACK_GATE_COPY，不许自编文案拦人）
function gateCopyFor(d) {
  if (!d || typeof d.code !== 'string') return null;
  switch (d.code) {
    case 'G1': // L9
      return {
        title: '尚未激活',
        body: '软件已升级为一次性付费版本，您尚未购买密钥激活。价格为 18 元，一次购买，终生免费更新。',
        primary: 'purchase', hasClaimBox: true, hasTransferGuide: true
      };
    case 'G2': { // L8
      const when = d.trialExpiresMs != null ? formatDateZh(d.trialExpiresMs) : '';
      return {
        title: '试用已到期',
        body: '您的 3 天免费试用已于 ' + when + ' 到期。真实付费购买密钥后即可继续使用：两台电脑与一部手机可绑定同一密钥，网页版不限设备使用。',
        primary: 'purchase', hasClaimBox: true, hasTransferGuide: true
      };
    }
    case 'G5': { // L14（与「试用」严格区分：不得出现试用字样；裁决批①：过期提示带到期日期）
      const when = d.keyExpiresMs != null ? formatDateZh(d.keyExpiresMs) : '';
      return {
        title: '密钥已过期',
        body: (when ? '您的密钥已于 ' + when + ' 到期' : '您的密钥已到期') + '，密钥已收回，当前账号无法登录。如需继续使用，请购买新密钥（可选永久套餐或按天套餐）：两台电脑与一部手机可绑定同一密钥，网页版不限设备使用。',
        primary: 'purchase', hasClaimBox: true, hasTransferGuide: true
      };
    }
    case 'G3': // L10（正文逐字不变；另加「申诉换绑设备」入口，§11.9 定版）
      return {
        title: '设备名额已满',
        body: '本设备尚未绑定密钥。您的密钥已绑定两台电脑与一部手机，如需在本设备使用，请购买新密钥。',
        primary: 'purchase', hasClaimBox: false, hasTransferGuide: false, hasRebind: true
      };
    case 'G4': // L13
      return {
        title: '网页版未开通',
        body: '网页版为真实付费购买密钥后开通的权益。您当前未真实付费购买密钥（免费试用，或密钥为试用、赠送、活动发放等免费获得），使用范围仅为电脑端与手机端软件，不包含网页版。真实付费购买密钥后即可开通网页版，并可在任意设备上登录使用。',
        primary: 'purchase', hasClaimBox: false, hasTransferGuide: false
      };
    case 'BAN_PERM': // L2（B6 经审核认定违规用专属事由类别）
      return {
        title: '账号已被封禁',
        body: d.banCode === 'B6'
          ? '该账号已被永久封禁。原因：同一设备登录多个账号，经审核确认违规，违反《用户协议》相关约定。如对处理结果有异议，可提交申诉，审核通过后将解除封禁。'
          : '该账号已被永久封禁。原因：账号存在违规使用行为，违反《用户协议》相关约定。如对处理结果有异议，可提交申诉，审核通过后将解除封禁。',
        primary: 'appeal', hasClaimBox: false, hasTransferGuide: false
      };
    case 'BAN_UNTIL': { // B10 冻结档 L12 / 其余 L5
      const when = d.endsAtMs != null ? formatDateZh(d.endsAtMs) : '';
      return {
        title: '账号已被冻结',
        body: d.banCode === 'B10'
          ? '该账户已被冻结（至 ' + when + '）。原因：检测到密钥绑定异常操作。如对处理结果有异议，可提交申诉。'
          : '该账号已被冻结，暂时无法登录' + (when ? '（至 ' + when + '）' : '') + '。如需处理，可提交申诉查询原因。',
        primary: 'appeal', hasClaimBox: false, hasTransferGuide: false
      };
    }
    case 'DEVICE_BANNED': // L3
      return {
        title: '设备已被限制登录',
        body: '本设备已被限制登录。如属误判，可提交申诉。',
        primary: 'appeal', hasClaimBox: false, hasTransferGuide: false
      };
    case 'DEVICE_REVIEW': // L15（非封禁、无申诉按钮、不预告处罚）
      return {
        title: '设备异常登录',
        body: '检测到本设备存在异常登录情况（同一设备登录了多个账号），本次登录已退出，相关情况正在核实中。核实期间您可在其他设备上正常使用；如核实结果涉及您的账号，我们将通过登录提示告知。如有疑问，可咨询智能客服。',
        primary: 'none', hasClaimBox: false, hasTransferGuide: false
      };
    default:
      return null;
  }
}

// ---------- 门裁决（纯函数，与安卓 resolveGateAction 同口径）：
// - forceLogout 信号优先于一切（§7.5.7 同一时点、无宽限）；
// - device-report 回的 DEVICE_REVIEW（或 reviewPending）按 §7.6 执行，
//   这是设备级已生效处置，不经影子门；
// - 其余未允许判定只在 enforce=true 时拦（影子模式只记录不拦）。
function resolveGateAction(opts) {
  const o = opts || {};
  if (o.forceLogoutSignal) {
    // 落面 code 只认信号自带的 gateCode（§7.5.7 恒为 G1），不许拿伴随
    // decision 的 code 冒充——decision 可能是 OK/其它状态。
    const code = (typeof o.forceLogoutGateCode === 'string' && o.forceLogoutGateCode)
      ? o.forceLogoutGateCode : 'G1';
    return {
      kind: 'forceLogoutToGate',
      decision: { allow: false, code, shadow: false, enforce: true, forceLogout: true, endsAtMs: null, trialExpiresMs: null, banCode: null }
    };
  }
  const d = o.decision;
  if (!d || d.allow) return { kind: 'none', decision: null };
  if (o.fromDeviceReport && (d.code === 'DEVICE_REVIEW' || o.reviewPending)) {
    return { kind: 'deviceReview', decision: d };
  }
  if (d.enforce) return { kind: 'showGate', decision: d };
  return { kind: 'none', decision: null };
}

// ---------- 密钥串格式（契约 §7.5.3：5×5 分段串；本地只判格式分支
// L17(d)，格式错误不计任何风控；有效性一律以服务端校验为准） ----------
function isKeyFormatValid(raw) {
  const v = String(raw == null ? '' : raw).trim().toUpperCase();
  return /^[A-Z0-9]{5}(-[A-Z0-9]{5}){4}$/.test(v);
}

// 领取/绑定类接口的统一结果（壳侧只显示服务端正式提示，不自编）
function parseOpResult(v) {
  const root = asObj(v);
  if (!root) return null;
  return {
    ok: root.ok === true,
    code: typeof root.code === 'string' ? root.code : null,
    msg: (typeof root.msg === 'string' && root.msg) ? root.msg : '',
    expiredAtMs: asMs(root.expiredAt)
  };
}

// 领取提交后的展示文案（§7.5.5 写死分支，与安卓 claimDisplayText 一致）：
// - 格式不正确 → L17(d)「密钥格式不正确，请检查后重新输入。」（本地判，不打服务端）；
// - KEY_EXPIRED → 服务端带到期日期时「密钥已过期，已于 X 到期。」（裁决批
//   ①）；未带日期（如离线旧响应）回落原文「密钥已过期。」，不得混入试用字样；
// - 其余 → 服务端回的正式提示原文。
function claimDisplayText(input, result) {
  if (!isKeyFormatValid(input)) return '密钥格式不正确，请检查后重新输入。';
  if (result == null) return '网络异常，请稍后再试。';
  if (result.ok) {
    return result.msg ? result.msg : '领取成功，密钥已转入您的账号。登录后在软件端重新绑定即可使用。';
  }
  if (result.code === 'KEY_EXPIRED') {
    return result.expiredAtMs != null
      ? '密钥已过期，已于 ' + formatDateZh(result.expiredAtMs) + ' 到期。'
      : '密钥已过期。';
  }
  return result.msg ? result.msg : '领取未成功，请核对后重试。';
}

// 登录页许可入口导航判定（16:37 定版）：控制台源（直连 8443）上的
// /purchase 与 /license/status 是登录页服务端两行的相对 href 落点，
// 在直连源上不可用——壳据此拦截导航、改走扩展源壳内打开（与安卓
// 登录桥接管点击同口径）。只认控制台主机，其余（含扩展源自身链接）
// 一律返回 null，不许误劫持。
function licenseNavTarget(raw, consoleHost) {
  let u;
  try { u = new URL(raw); } catch (e) { return null; }
  if (!consoleHost || u.hostname !== consoleHost) return null;
  if (u.pathname === '/purchase') return 'purchase';
  if (u.pathname === '/license/status') return 'status';
  if (u.pathname === '/license/rebind') return 'rebind';
  return null;
}

module.exports = {
  parseDecision, parseMe, parseDeviceReport,
  formatRemainMs, trialBarText, licenseRemainText, licenseEntryMode, formatDateZh,
  TRANSFER_GUIDE_TEXT, CLAIM_INPUT_LABEL, FALLBACK_GATE_COPY, gateCopyFor,
  resolveGateAction, isKeyFormatValid, parseOpResult, claimDisplayText,
  licenseNavTarget
};
