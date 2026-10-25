import 'dart:convert';

/// 许可体系壳侧纯逻辑（2.3.1 阶段 D；契约正本 v231/license-api-contract.md，
/// 文案正本 v231/ban-appeal-design.md §四 L 系列——按 code 取文案，不得另编）。
///
/// 数据来源（全部是扩展服务同源接口，鉴权＝控制台会话 cookie 桥）：
/// - POST /license/api/device-report：会话建立后立即上报设备码（契约 §3 写死
///   时机），响应带 device{reviewPending, forceLogout} 与 decision；
/// - GET /license/api/me：本人许可概览＋decision（software 渠道判定）；
/// - POST /points/api/heartbeat 响应与 /license/api/me 顶层 forceLogout
///   （契约 §7.5.7：转赠领取后原主人即时强制下线信号）。
///
/// 影子口径（不得自改）：服务端 shadow=true 时，非测试名单账号的 decision
/// 只记录不拦截——evaluate 的 enforce 字段为 false 时壳侧不许拦人；只有
/// enforce=true 的判定才落原生拦截面。forceLogout 与 DEVICE_REVIEW
/// （device-report 专属，契约 §7.6）是服务端已生效的会话处置信号，
/// 不走影子门，收到即执行。

/// 一次许可判定（login-check / device-report / me.decision 同构）。
class LicenseDecision {
  final bool allow;
  final String code;
  final bool shadow;
  final bool enforce;
  final bool forceLogout;
  final int? endsAtMs;
  final int? trialExpiresMs;
  final String? banCode;

  const LicenseDecision({
    required this.allow,
    required this.code,
    this.shadow = false,
    this.enforce = false,
    this.forceLogout = false,
    this.endsAtMs,
    this.trialExpiresMs,
    this.banCode,
  });

  static LicenseDecision? tryParse(Object? v) {
    if (v is! Map) return null;
    final code = v['code'];
    if (code is! String || code.isEmpty) return null;
    int? asMs(Object? x) => x is num ? x.toInt() : null;
    return LicenseDecision(
      allow: v['allow'] == true,
      code: code,
      shadow: v['shadow'] == true,
      enforce: v['enforce'] == true,
      forceLogout: v['forceLogout'] == true,
      endsAtMs: asMs(v['endsAt']),
      trialExpiresMs: asMs(v['trialExpiresMs']),
      banCode: v['banCode'] is String ? v['banCode'] as String : null,
    );
  }
}

/// /license/api/me 的本人许可概览（字段与 buildStatusView 对齐）。
class LicenseMe {
  final String? username;
  final String? planName;
  final String? maskedKey;
  final String? displayStatus;
  final int slotsPc;
  final int slotsMobile;
  final int? trialExpiresMs;
  final int? keyExpiresMs;
  final bool webEnabled;
  final bool everBanned;
  final bool hasKey;
  final LicenseDecision? decision;

  /// 顶层 forceLogout（§7.5.7）：true 时壳须立即登出并落 G1 拦截。
  final bool forceLogout;
  final String? gateCode;

  const LicenseMe({
    this.username,
    this.planName,
    this.maskedKey,
    this.displayStatus,
    this.slotsPc = 0,
    this.slotsMobile = 0,
    this.trialExpiresMs,
    this.keyExpiresMs,
    this.webEnabled = false,
    this.everBanned = false,
    this.hasKey = false,
    this.decision,
    this.forceLogout = false,
    this.gateCode,
  });

  static LicenseMe? tryParse(String body) {
    try {
      final root = jsonDecode(body);
      if (root is! Map<String, dynamic>) return null;
      if (root['ok'] != true) return null;
      final slots = root['slots'];
      int slot(Object? v) => v is num ? v.toInt() : 0;
      int? asMs(Object? x) => x is num ? x.toInt() : null;
      String? asStr(Object? x) => x is String && x.isNotEmpty ? x : null;
      return LicenseMe(
        username: asStr(root['username']),
        planName: asStr(root['planName']),
        maskedKey: asStr(root['maskedKey']),
        displayStatus: asStr(root['displayStatus']),
        slotsPc: slots is Map ? slot(slots['pc']) : 0,
        slotsMobile: slots is Map ? slot(slots['mobile']) : 0,
        trialExpiresMs: asMs(root['trialExpiresMs']),
        keyExpiresMs: asMs(root['keyExpiresMs']),
        webEnabled: root['webEnabled'] == true,
        everBanned: root['everBanned'] == true,
        hasKey: root['hasKey'] == true,
        decision: LicenseDecision.tryParse(root['decision']),
        forceLogout: root['forceLogout'] == true,
        gateCode: asStr(root['gateCode']),
      );
    } catch (_) {
      return null;
    }
  }
}

/// device-report 响应（契约 §3＋§7.6）。
class DeviceReportResult {
  final bool reviewPending;
  final bool deviceForceLogout;
  final LicenseDecision? decision;

  const DeviceReportResult({
    this.reviewPending = false,
    this.deviceForceLogout = false,
    this.decision,
  });

  static DeviceReportResult? tryParse(String body) {
    try {
      final root = jsonDecode(body);
      if (root is! Map<String, dynamic>) return null;
      if (root['ok'] != true) return null;
      final dev = root['device'];
      return DeviceReportResult(
        reviewPending: dev is Map && dev['reviewPending'] == true,
        deviceForceLogout: dev is Map && dev['forceLogout'] == true,
        decision: LicenseDecision.tryParse(root['decision']),
      );
    } catch (_) {
      return null;
    }
  }
}

/// 剩余时长折算（与网页正本 home-page.js 的 fmtRemain 逐字同口径：
/// 满 24 小时制——先整天、再小时、再分钟，不用自然日）。
String formatRemainMs(int ms) {
  if (ms <= 0) return '已到期';
  final d = ms ~/ 86400000;
  final h = (ms % 86400000) ~/ 3600000;
  final m = (ms % 3600000) ~/ 60000;
  if (d > 0) return '$d 天 $h 小时';
  if (h > 0) return '$h 小时 $m 分钟';
  return '$m 分钟';
}

/// TrialBar 显隐与文案（与网页正本同条件、同文案）：
/// 试用套餐、试用未到期、网页版未开通时才出现。
String? trialBarText(LicenseMe me, int nowMs) {
  final exp = me.trialExpiresMs;
  if (exp == null || exp <= nowMs) return null;
  if (me.webEnabled) return null;
  if (me.planName != 'QFRemote 试用套餐') return null;
  return '免费试用中 · 剩余 ${formatRemainMs(exp - nowMs)}';
}

/// 「剩余时长」行（与网页正本同序：付费钥到期 → 试用 → 无钥 → 长期有效）。
String licenseRemainText(LicenseMe me, int nowMs) {
  final keyExp = me.keyExpiresMs;
  if (keyExp != null) return formatRemainMs(keyExp - nowMs);
  if (me.planName == 'QFRemote 试用套餐' && me.trialExpiresMs != null) {
    return formatRemainMs(me.trialExpiresMs! - nowMs);
  }
  if (!me.hasKey) return '—';
  return '长期有效';
}

/// 日期文案（L8/L12/L14 用）：X 年 X 月 X 日（Asia/Shanghai 与服务端
/// fmtDate 同口径；壳侧按本机时区格式化——用户设备即国内时区，不另造转换）。
String formatDateZh(int ms) {
  final d = DateTime.fromMillisecondsSinceEpoch(ms);
  return '${d.year} 年 ${d.month} 月 ${d.day} 日';
}

/// 拦截面主按钮种类。
enum GatePrimary { purchase, appeal, none }

/// 一个拦截状态的原生渲染文案（标题/正文/主按钮/是否带激活领取框）。
class GateCopy {
  final String title;
  final String body;
  final GatePrimary primary;

  /// G1/G2/G5 带激活领取区（契约 §7.5.5 写死），其余不带。
  final bool hasClaimBox;

  /// G1/G2/G5 附转赠领取指引（设计稿 L16）。
  final bool hasTransferGuide;

  /// G3 附「申诉换绑设备」入口（设计稿 §11.9 定版）。
  final bool hasRebind;

  const GateCopy({
    required this.title,
    required this.body,
    required this.primary,
    this.hasClaimBox = false,
    this.hasTransferGuide = false,
    this.hasRebind = false,
  });
}

/// L16 转赠领取指引（附于 G1/G2/G5 拦截页，逐字正本）。
const String kTransferGuideText =
    '如有其他用户向您转赠密钥，您可在本页登录区点击「查询密钥」，凭账号与密码完成核验后，查看并复制该密钥；再使用您的账号登录，在登录时弹出的激活密钥输入框中粘贴提交，即可完成领取并正常使用。';

/// 激活密钥输入框标签（L17，逐字写死，品牌名拼写不得改）。
const String kClaimInputLabel = '请输入 QFRemote 激活密钥';

/// 按 code 取拦截文案（设计稿 §四 L 系列；loginshim gatePageHtml 同源）。
/// 未知 code 返回 null（调用方按诚实错误态处理，不许自编文案拦人）。
GateCopy? gateCopyFor(LicenseDecision d) {
  switch (d.code) {
    case 'G1': // L9
      return const GateCopy(
        title: '尚未激活',
        body: '软件已升级为一次性付费版本，您尚未购买密钥激活。价格为 18 元，一次购买，终生免费更新。',
        primary: GatePrimary.purchase,
        hasClaimBox: true,
        hasTransferGuide: true,
      );
    case 'G2': // L8
      final when =
          d.trialExpiresMs != null ? formatDateZh(d.trialExpiresMs!) : '';
      return GateCopy(
        title: '试用已到期',
        body: '您的 3 天免费试用已于 $when 到期。真实付费购买密钥后即可继续使用：一台电脑与一部手机可绑定同一密钥，网页版不限设备使用。',
        primary: GatePrimary.purchase,
        hasClaimBox: true,
        hasTransferGuide: true,
      );
    case 'G5': // L14（与「试用」严格区分：不得出现试用字样）
      return const GateCopy(
        title: '密钥已过期',
        body: '您的密钥已到期，密钥已收回，当前账号无法登录。如需继续使用，请购买新密钥（可选永久套餐或按天套餐）：一台电脑与一部手机可绑定同一密钥，网页版不限设备使用。',
        primary: GatePrimary.purchase,
        hasClaimBox: true,
        hasTransferGuide: true,
      );
    case 'G3': // L10（正文逐字不变；另加「申诉换绑设备」入口，§11.9 定版）
      return const GateCopy(
        title: '设备名额已满',
        body: '本设备尚未绑定密钥。您的密钥已绑定一台电脑与一部手机，如需在本设备使用，请购买新密钥。',
        primary: GatePrimary.purchase,
        hasRebind: true,
      );
    case 'G4': // L13
      return const GateCopy(
        title: '网页版未开通',
        body: '网页版为真实付费购买密钥后开通的权益。您当前未真实付费购买密钥（免费试用，或密钥为试用、赠送、活动发放等免费获得），使用范围仅为电脑端与手机端软件，不包含网页版。真实付费购买密钥后即可开通网页版，并可在任意设备上登录使用。',
        primary: GatePrimary.purchase,
      );
    case 'BAN_PERM': // L2（B6 经审核认定违规用专属事由类别）
      return GateCopy(
        title: '账号已被封禁',
        body: d.banCode == 'B6'
            ? '该账号已被永久封禁。原因：同一设备登录多个账号，经审核确认违规，违反《用户协议》相关约定。如对处理结果有异议，可提交申诉，审核通过后将解除封禁。'
            : '该账号已被永久封禁。原因：账号存在违规使用行为，违反《用户协议》相关约定。如对处理结果有异议，可提交申诉，审核通过后将解除封禁。',
        primary: GatePrimary.appeal,
      );
    case 'BAN_UNTIL': // B10 冻结档 L12 / 其余 L5
      final when = d.endsAtMs != null ? formatDateZh(d.endsAtMs!) : '';
      return GateCopy(
        title: '账号已被冻结',
        body: d.banCode == 'B10'
            ? '该账户已被冻结（至 $when）。原因：检测到密钥绑定异常操作。如对处理结果有异议，可提交申诉。'
            : '该账号已被冻结，暂时无法登录${when.isEmpty ? '' : '（至 $when）'}。如需处理，可提交申诉查询原因。',
        primary: GatePrimary.appeal,
      );
    case 'DEVICE_BANNED': // L3
      return const GateCopy(
        title: '设备已被限制登录',
        body: '本设备已被限制登录。如属误判，可提交申诉。',
        primary: GatePrimary.appeal,
      );
    case 'DEVICE_REVIEW': // L15（非封禁、无申诉按钮、不预告处罚）
      return const GateCopy(
        title: '设备异常登录',
        body: '检测到本设备存在异常登录情况（同一设备登录了多个账号），本次登录已退出，相关情况正在核实中。核实期间您可在其他设备上正常使用；如核实结果涉及您的账号，我们将通过登录提示告知。如有疑问，可咨询智能客服。',
        primary: GatePrimary.none,
      );
    default:
      return null;
  }
}

/// 壳侧门裁决结果。
enum GateActionKind {
  /// 放行（无判定/影子只记录/已允许）。
  none,

  /// 落原生拦截面（enforce 的未允许判定）。
  showGate,

  /// 设备异常待审（§7.6）：强制登出该设备会话＋DEVICE_REVIEW 面。
  deviceReview,

  /// forceLogout 信号（§7.5.7）：立即登出本机会话＋落 G1 拦截面。
  forceLogoutToGate,
}

class GateAction {
  final GateActionKind kind;
  final LicenseDecision? decision;
  const GateAction(this.kind, [this.decision]);
}

/// 门裁决（纯函数）：
/// - forceLogout 信号优先于一切（§7.5.7 同一时点、无宽限）；
/// - device-report 回的 DEVICE_REVIEW（或 reviewPending）按 §7.6 执行，
///   这是设备级已生效处置，不经影子门；
/// - 其余未允许判定只在 enforce=true 时拦（影子模式只记录不拦）。
GateAction resolveGateAction({
  required LicenseDecision? decision,
  bool forceLogoutSignal = false,
  String? forceLogoutGateCode,
  bool fromDeviceReport = false,
  bool reviewPending = false,
}) {
  if (forceLogoutSignal) {
    // 落面 code 只认信号自带的 gateCode（§7.5.7 恒为 G1），不许拿伴随
    // decision 的 code 冒充——decision 可能是 OK/其它状态。
    final code = (forceLogoutGateCode != null && forceLogoutGateCode.isNotEmpty)
        ? forceLogoutGateCode
        : 'G1';
    return GateAction(
      GateActionKind.forceLogoutToGate,
      LicenseDecision(allow: false, code: code, enforce: true, forceLogout: true),
    );
  }
  final d = decision;
  if (d == null || d.allow) return const GateAction(GateActionKind.none);
  if (fromDeviceReport && (d.code == 'DEVICE_REVIEW' || reviewPending)) {
    return GateAction(GateActionKind.deviceReview, d);
  }
  if (d.enforce) return GateAction(GateActionKind.showGate, d);
  return const GateAction(GateActionKind.none);
}

/// 密钥串格式（契约 §7.5.3：5×5 分段串；本地只判格式分支 L17(d)，
/// 格式错误不计任何风控；有效性一律以服务端校验为准）。
bool isKeyFormatValid(String raw) {
  final v = raw.trim().toUpperCase();
  return RegExp(r'^[A-Z0-9]{5}(-[A-Z0-9]{5}){4}$').hasMatch(v);
}

/// 领取/绑定类接口的统一结果（壳侧只显示服务端正式提示，不自编）。
class LicenseOpResult {
  final bool ok;
  final String? code;
  final String msg;
  const LicenseOpResult({required this.ok, this.code, required this.msg});

  static LicenseOpResult? tryParse(String body) {
    try {
      final root = jsonDecode(body);
      if (root is! Map<String, dynamic>) return null;
      final msg = root['msg'];
      return LicenseOpResult(
        ok: root['ok'] == true,
        code: root['code'] is String ? root['code'] as String : null,
        msg: msg is String && msg.isNotEmpty ? msg : '',
      );
    } catch (_) {
      return null;
    }
  }
}

/// 领取提交后的展示文案（§7.5.5 写死分支）：
/// - 格式不正确 → L17(d)「密钥格式不正确，请检查后重新输入。」（本地判，不打服务端）；
/// - KEY_EXPIRED → 「密钥已过期。」（原文，不得改写、不得混入试用字样）；
/// - 其余 → 服务端回的正式提示原文。
String claimDisplayText({required String input, LicenseOpResult? result}) {
  if (!isKeyFormatValid(input)) return '密钥格式不正确，请检查后重新输入。';
  if (result == null) return '网络异常，请稍后再试。';
  if (result.ok) {
    return result.msg.isNotEmpty
        ? result.msg
        : '领取成功，密钥已转入您的账号。登录后在软件端重新绑定即可使用。';
  }
  if (result.code == 'KEY_EXPIRED') return '密钥已过期。';
  return result.msg.isNotEmpty ? result.msg : '领取未成功，请核对后重试。';
}
