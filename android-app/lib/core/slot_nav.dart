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
