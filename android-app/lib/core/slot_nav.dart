// App 框架槽位与导航裁决（纯逻辑，可单测；2.3.0 追加五/六）。
//
// 框架形态：顶栏＋底部四标签。2.3.1（阶段 D）按站长效果图与决策记录
// 改名改序为：首页/文件/设备/我的——首页＝网页新首页正本在壳内同框
// 呈现的 WebView 槽，文件＝控制台文件管理 WebView 槽，设备＝控制台
// WebView 槽；好友/论坛降为首页长页快速入口与顶栏菜单可达的保活槽
// （槽位本体保留，不删功能）。各 WebView 槽 IndexedStack 常驻保活，
// 切标签不重载、不闪白；「我的」是原生页，同样常驻保活。
// 系统返回键分级：先页内后退，再回设备槽，最后才退出 App。

enum AppSlot { home, files, devices, friends, forum, me }

/// 返回键动作裁决结果。
enum BackAction {
  /// 当前槽页内后退一页
  pageBack,

  /// 回到设备槽
  toDevices,

  /// 退出 App
  exitApp,
}

/// 系统返回键分级裁决（纯函数）：
/// - 非根槽：页内能退先页内退，否则回设备槽；
/// - 根槽（首页/设备）：页内能退先页内退，否则退出 App。
///   首页是 2.3.1 的落地根槽，与设备槽同级，不许返回时被赶去设备槽。
BackAction decideBackAction({
  required AppSlot active,
  required bool activeCanGoBack,
}) {
  if (active != AppSlot.devices && active != AppSlot.home) {
    return activeCanGoBack ? BackAction.pageBack : BackAction.toDevices;
  }
  return activeCanGoBack ? BackAction.pageBack : BackAction.exitApp;
}

/// 前台槽裁决（白屏修复，巡查 SUP-P0-06）：登录页只存在于设备槽的
/// WebView 里。未登录（框架 chrome 未出现）时，前台必须是设备槽——
/// 若按选中槽（如默认的首页槽）呈现，未登录用户会落在一个从未装载的
/// 空白 WebView 上：无顶栏、无标签栏、无任何可点元素，永久困死
/// （2.3.1/2.3.2 冷启动未登录实拍定性）。登录检出后按选中槽呈现。
AppSlot foregroundSlot({
  required bool chromeVisible,
  required AppSlot selected,
}) =>
    chromeVisible ? selected : AppSlot.devices;

/// 槽位加载账本：哪些 WebView 槽已经加载过主页（保活判据）。
/// 登录成功后预加载、点开时未加载才加载；手动退出后全部作废，
/// 下次进入按当时登录态重新加载（不许残留上一个账号的页面）。
class SlotLoadTracker {
  final Set<AppSlot> _loaded = <AppSlot>{};

  bool needsLoad(AppSlot slot) => !_loaded.contains(slot);

  void markLoaded(AppSlot slot) => _loaded.add(slot);

  bool isLoaded(AppSlot slot) => _loaded.contains(slot);

  void invalidateAll() => _loaded.clear();
}

/// 壳内内容页路径（好友/聊天/论坛）：这些页自带一套浏览器形态的顶栏
/// （header.appbar）与移动底栏（nav.tabbar），在 App 里与壳框架（顶栏＋
/// 底部标签）重复。定版样图 m04–m06 的口径是壳框架当框、页面只出内容，
/// 故壳在槽内加载这些页时注入一段样式藏掉页面自带框，并把页面为固定
/// 顶栏预留的 --topbar-h 归零（内容上移、板块粘性定位自动跟随）。
/// 页面本体与功能一概不动（同一页面、同一模板）。
bool isShellContentPage(String? url) {
  if (url == null) return false;
  final path = Uri.tryParse(url)?.path ?? '';
  return path == '/friends' ||
      path == '/chat' ||
      path.startsWith('/chat/') ||
      path == '/forum' ||
      path.startsWith('/forum/');
}

/// 会话深链识别（收编 P1 地基，纯函数可单测）：
/// 控制台 SPA 点「远程桌面 / 远程终端」时产生的引擎会话深链，形态为
/// 自有源根路径＋`node`＋`viewmode`（10 手机设备页 / 11 桌面 / 12 终端）
/// 查询参数。P2 起壳在导航策略里据此拦截、改推根层会话面（槽内 SPA
/// 停留设备详情原地）；P1 只落识别，不接导航策略。
/// 只认 [ownOrigins] 内的源：外源同形地址一律不认；SPA 常规页内导航
/// （无 node/viewmode）、登出址、下载址均不命中，不误伤既有口径。
bool isSessionDeepLink(String? url, {required Set<String> ownOrigins}) {
  if (url == null) return false;
  final uri = Uri.tryParse(url);
  if (uri == null) return false;
  if (uri.scheme != 'http' && uri.scheme != 'https') return false;
  final String origin;
  try {
    origin = uri.origin;
  } catch (_) {
    // 无 authority 等取不到源的地址一律不认（origin 对这类地址会抛错）。
    return false;
  }
  if (!ownOrigins.contains(origin)) return false;
  if (uri.path.isNotEmpty && uri.path != '/') return false;
  final node = uri.queryParameters['node'];
  if (node == null || node.isEmpty) return false;
  const sessionModes = {'10', '11', '12'};
  return sessionModes.contains(uri.queryParameters['viewmode']);
}

/// 藏页面自带框的注入脚本（幂等：同一文档重复注入只留一份样式）。
String buildShellChromeHideScript() {
  return '(function(){'
      'if(document.getElementById("__qfShellChrome"))return "already";'
      'var s=document.createElement("style");'
      's.id="__qfShellChrome";'
      's.textContent=":root{--topbar-h:0px !important}"'
      '+"header.appbar{display:none !important}"'
      '+"nav.tabbar{display:none !important}";'
      '(document.head||document.documentElement).appendChild(s);'
      'return "injected";'
      '})()';
}
