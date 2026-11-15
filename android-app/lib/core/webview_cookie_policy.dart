/// 第三方 Cookie 依赖盘点与分槽配置（S-044，第三份审查 P2-14）。
///
/// 盘点结论（对工作树原文核实，2026-11-15）：
///
/// 全槽第一方源均为 [kServerOrigin]（https://app.qfremote.top，见
/// constants.dart／svc_urls.dart：控制台、首页、文件、好友／聊天、论坛、
/// 购买／查询／申诉／客服页的 getter 校验后现行值全是 kServerOrigin；
/// 论坛 SSO 是服务端 token 换发（_forumSso），不是跨站 Cookie；
/// 扩展服务 transplant 只在 origin 精确等于 kServerOrigin 时才移植）。
/// 会话 Cookie（xid／xid.sig／qfrem）均为第一方 Cookie；控制台页内
/// Mesh iframe 走同一源反代，不是跨站 frame；附件下载为同源下载请求，
/// 由 CookieManager 的第一方 Cookie 鉴权。
///
/// 因此：没有任何功能在设计上依赖第三方 Cookie。旧代码五处
/// `thirdPartyCookiesEnabled: true` 是“一刀切全开”，跨站信任面过宽。
/// 本线改成分槽配置、默认全关（false）。若 11/16 真机两态验证中某功能
/// 在关态下失败，按下表登记依赖原因、只把该槽改回 true，不许静默改回。
///
/// 两态验证矩阵（待 11/16 真机窗口，见 [verificationMatrix]）：
/// 登录、好友／聊天、Mesh iframe、远程连接、附件下载 × 开／关。
library;

import 'slot_nav.dart';
import 'svc_urls.dart';

/// 逐槽第三方 Cookie 配置（S-044）：每槽独立取值，不许共用一个开关。
class WebViewCookiePolicy {
  const WebViewCookiePolicy._();

  /// 槽位配置：当前全槽 false（盘点结论：无功能依赖第三方 Cookie）。
  /// 某槽将来确有依赖时，在此登记原因并只改该槽。
  static bool thirdPartyCookiesEnabled(AppSlot slot) {
    switch (slot) {
      case AppSlot.home:
      case AppSlot.files:
      case AppSlot.devices:
      case AppSlot.friends:
      case AppSlot.forum:
      case AppSlot.me:
        return false;
    }
  }

  /// 壳内网页页（购买／查询／申诉／客服，见 ui/web_page.dart）：
  /// 同源页，第三方 Cookie 关。
  static const bool thirdPartyCookiesEnabledForShellPage = false;

  /// 两态验证矩阵（S-044）：每行＝一个功能 × 覆盖槽，开关两态
  /// （开／关）分别验证，11/16 真机窗口逐项勾选。
  static const List<({String feature, AppSlot slot})> verificationMatrix = [
    (feature: '登录', slot: AppSlot.devices),
    (feature: '好友／聊天', slot: AppSlot.friends),
    (feature: 'Mesh iframe（控制台会话框）', slot: AppSlot.devices),
    (feature: '远程连接', slot: AppSlot.devices),
    (feature: '附件下载', slot: AppSlot.devices),
    (feature: '首页加载', slot: AppSlot.home),
    (feature: '文件槽加载', slot: AppSlot.files),
    (feature: '论坛加载（SSO 免登）', slot: AppSlot.forum),
  ];

  /// 依赖登记表：当前为空（无功能依赖第三方 Cookie）。
  /// 真机验证若发现某功能关态失败，在此登记后方可改回该槽 true：
  /// （功能，槽，依赖原因）。空表＝全关。
  static const List<({String feature, AppSlot slot, String reason})>
      thirdPartyDependencies = [];
}

/// 盘点依据：全部槽位 URL 的 origin 必须等于可信生产源，否则上面
/// “无功能依赖第三方 Cookie”的结论不成立（跨站页会需要第三方 Cookie）。
bool cookiePolicyAssumptionHolds() {
  final urls = [
    SvcUrls.instance.homeUrl,
    SvcUrls.instance.friendsUrl,
    SvcUrls.instance.forumUrl,
    SvcUrls.instance.purchaseUrl,
    SvcUrls.instance.licenseStatusUrl,
  ];
  for (final u in urls) {
    if (!SvcUrls.instance.isOwnOrigin(u)) return false;
  }
  return true;
}
