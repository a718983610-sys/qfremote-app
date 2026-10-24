import 'manifest.dart';
import 'version.dart';

/// 更新政策的决策结果（全家统一政策，用户 2026-10-24 09:43 亲定，
/// 与 Windows v1.0.4 实现同一口径）：
/// - 运行中发现新版：只提醒、不强制（工具栏徽标＋关于里说明，一次会话提一次）；
/// - 退出后重新进入应用时：强制更新（无关闭、无跳过，装完才进）；
/// - 启动时连不上服务器先放行，强制只在启动那一下且在线时执行。
enum UpdateDecision {
  /// 没有新版 / 本来就是最新。
  none,

  /// 会话中发现新版：只提醒，并落盘「待更新」，下次启动强制。
  remind,

  /// 启动时命中待更新且服务器可达：先进强制更新页，装完才进控制台。
  forceAtLaunch,

  /// 启动时有待更新但服务器连不上：先放行进控制台（待更新标记保留）。
  passOffline,
}

/// 纯决策函数（可单测）：
/// - [currentVersion] 本机版本；
/// - [manifestEntry] 本次取到的安卓清单条目（取不到/失败为 null）；
/// - [pendingVersion] 落盘的待更新版本号（上次会话发现并记录的，没有为 null）；
/// - [isLaunchCheck] true=启动时的检查；false=会话中的检查。
UpdateDecision decideUpdate({
  required String currentVersion,
  required ReleaseEntry? manifestEntry,
  required String? pendingVersion,
  required bool isLaunchCheck,
}) {
  if (!isLaunchCheck) {
    // 会话中：查到更高版本 → 只提醒（调用方同时把待更新落盘）。
    if (manifestEntry != null && isNewerVersion(manifestEntry.version, currentVersion)) {
      return UpdateDecision.remind;
    }
    return UpdateDecision.none;
  }

  // 启动时：
  if (pendingVersion == null || !isNewerVersion(pendingVersion, currentVersion)) {
    return UpdateDecision.none; // 没有待更新（或早已更完）
  }
  if (manifestEntry == null) {
    return UpdateDecision.passOffline; // 清单都没取到 = 服务器连不上，先放行
  }
  if (manifestEntry.version == pendingVersion &&
      isNewerVersion(manifestEntry.version, currentVersion)) {
    return UpdateDecision.forceAtLaunch;
  }
  // 待更新已被更高的新版顶替（清单版本 >= 待更新且比本机新）→ 照样强制到清单版本。
  if (isNewerVersion(manifestEntry.version, currentVersion) &&
      compareVersions(manifestEntry.version, pendingVersion) >= 0) {
    return UpdateDecision.forceAtLaunch;
  }
  // 清单版本低于待更新（例如待更新已被撤下）→ 不强制，按无新版处理。
  return UpdateDecision.none;
}
