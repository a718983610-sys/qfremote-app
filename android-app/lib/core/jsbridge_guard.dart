import 'constants.dart';
import 'session_stage.dart';

/// JSBridge 来源守卫（F-07，3.0.0）——纯函数，可单测。
///
/// 背景：flutter_inappwebview 的 JS 处理器回调只给参数、不给来源
/// frame／origin 元数据；壳内任何 frame（含被攻陷的跨源 iframe）都
/// 能调 `window.flutter_inappwebview.callHandler`。本文件用原生层
/// 掌握的「当前主 frame URL」（设备槽 WebView 的 onLoadStart／
/// onUpdateVisitedHistory 回写的 `_currentUrl`）作核对依据：主 frame
/// 导航开始即同步更新该值，新页脚本跑起来之前值已是新地址。
///
/// 允许规则（主 frame URL 必须同时满足）：
/// - qfLoginSubmit：只允许登录页主 frame——控制台根（origin 为
///   [kServerOrigin] 且 path 为空或 `/`）。登录按钮只在登录页存在。
/// - qfLicenseNav：与登录提交同页——购买／查询／换绑三行只注在登录
///   面板里，同样只允许登录页主 frame。
/// - qfManualLogout：控制台根 SPA 任意路由（含 `#session/...` 会话
///   路由）——退出入口在控制台顶栏，各路由都可点；但主 frame 必须
///   仍是控制台根 origin，论坛／好友等槽是别的 WebView，不走此 handler。
/// - qfSessionStage：只允许会话路由主 frame（`#session/<nodeid>` 或
///   `?node=&viewmode=10..12`，见 [parseSessionRoute]）——阶段打点
///   只在远程会话进行时由会话页发出。
///
/// 已知局限（写进 F06-F07-FIX-REPORT.md，不藏）：
/// 1. 守卫核对的是主 frame URL，不是每一次调用的 frame origin——
///    插件不提供后者。同一主 frame 内的同源 iframe 调用与页面自身
///    调用无法区分；同源内容由服务端下发、与页面同等信任，威胁模型
///    只覆盖跨源 frame。
/// 2. 主 frame URL 与 handler 调用之间存在原生层状态竞态的理论窗口：
///    onLoadStart／onUpdateVisitedHistory 在导航开始即更新，窗口仅
///    限导航已开始、回调尚未执行的瞬间；旧页脚本在新导航开始后即被
///    丢弃，无法利用该窗口持续调用。
bool isConsoleMainFrame(String? url) {
  final uri = Uri.tryParse(url ?? '');
  if (uri == null || uri.scheme != 'https') return false;
  final String origin;
  try {
    origin = uri.origin;
  } catch (_) {
    // 无 authority 等取不到源的地址一律不认（origin 对这类地址会抛错，
    // 口径与 slot_nav.dart 的 isSessionDeepLink 一致）。
    return false;
  }
  return origin == kServerOrigin && (uri.path.isEmpty || uri.path == '/');
}

/// 登录页主 frame：控制台根，且不是会话路由、且无 hash 路由。
/// 控制台 SPA 的路由全在 hash／`?node=&viewmode=` 里（见
/// [parseSessionRoute]）；登录表单只在无路由的根页上，任何 hash
/// 路由（如 `#session/...`）都不是登录页。query 串不排除——未登录
/// 时服务端在同一根页上出登录表单。
bool isLoginPageMainFrame(String? url) {
  if (!isConsoleMainFrame(url)) return false;
  final uri = Uri.tryParse(url ?? '');
  if (uri == null) return false;
  if (uri.fragment.isNotEmpty) return false;
  return parseSessionRoute(url!) == null;
}

/// 登录提交 handler 是否允许：只允许登录页主 frame。
bool isLoginSubmitAllowed(String? mainFrameUrl) =>
    isLoginPageMainFrame(mainFrameUrl);

/// 许可入口导航 handler 是否允许：只允许登录页主 frame。
bool isLicenseNavAllowed(String? mainFrameUrl) =>
    isLoginPageMainFrame(mainFrameUrl);

/// 手动退出 handler 是否允许：控制台根 SPA 任意路由。
bool isManualLogoutAllowed(String? mainFrameUrl) =>
    isConsoleMainFrame(mainFrameUrl);

/// 会话阶段打点 handler 是否允许：只允许会话路由主 frame。
bool isSessionStageAllowed(String? mainFrameUrl) {
  final uri = Uri.tryParse(mainFrameUrl ?? '');
  if (uri == null || uri.scheme != 'https') return false;
  final String origin;
  try {
    origin = uri.origin;
  } catch (_) {
    return false;
  }
  if (origin != kServerOrigin) return false;
  return parseSessionRoute(mainFrameUrl!) != null;
}
