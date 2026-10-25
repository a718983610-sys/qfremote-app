// App 框架槽位与导航裁决（纯逻辑，可单测；2.3.0 追加五/六）。
//
// 框架形态：顶栏＋底部四标签（设备/好友/论坛/我的）。设备、好友、论坛是
// 三个各自保活的 WebView 槽（IndexedStack 常驻，切标签不重载、不闪白）；
// 「我的」是原生页，同样常驻保活。系统返回键分级：先页内后退，
// 再回设备槽，最后才退出 App。

enum AppSlot { devices, friends, forum, me }

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
/// - 非设备槽：页内能退先页内退，否则回设备槽；
/// - 设备槽：页内能退先页内退，否则退出 App。
BackAction decideBackAction({
  required AppSlot active,
  required bool activeCanGoBack,
}) {
  if (active != AppSlot.devices) {
    return activeCanGoBack ? BackAction.pageBack : BackAction.toDevices;
  }
  return activeCanGoBack ? BackAction.pageBack : BackAction.exitApp;
}

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
