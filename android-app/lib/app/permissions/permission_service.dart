/// A-03 权限克制清单＋集中权限服务（Tusky 10 权限/3 运行时、VLC、Signal
/// 模式）：先做一张清单逐项问“能不能不要”；运行时权限只留真正需要的；
/// 所有申请收敛到一个集中权限服务类；被永久拒绝时给出去设置的文字路径。
///
/// 当前清单（实测口径，见 docs/PERMISSIONS.md）：
/// - 安装时授权（不弹框）：INTERNET、ACCESS_NETWORK_STATE、WAKE_LOCK、
///   FOREGROUND_SERVICE（含类型）、RECEIVE_BOOT_COMPLETED、
///   REQUEST_INSTALL_PACKAGES（应用内更新拉起安装器）。
/// - 运行时授权（真正需要的）：POST_NOTIFICATIONS（Android 13+，前台服务
///   通知用）——仅此 1 个。
/// - 已删走：宽泛存储权限（READ/WRITE_EXTERNAL_STORAGE、
///   MANAGE_EXTERNAL_STORAGE）一律不声明，文件传输走 SAF 系统选择器。
/// - 未要：位置、通讯录、短信、麦克风（语音是可选增强，要用时才在点对应
///   功能时单独申请，不在首屏弹）。
enum PermissionKind {
  /// Android 13+ 通知权限（前台服务通知用）。
  notifications,

  /// 麦克风（可选增强：语音通话才要，点功能时才申请）。
  microphone,

  /// 悬浮窗（特殊权限，须去系统设置里开，单独引导页）。
  overlay,

  /// 无障碍服务（特殊权限，被控端输入注入用，单独引导页）。
  accessibility,

  /// 电池优化白名单（特殊权限，单独引导页＋说明代价）。
  ignoreBatteryOptimizations,
}

/// 权限申请结果。
enum PermissionOutcome {
  granted,
  denied,
  permanentlyDenied,
}

/// 集中权限服务接口：Dart 侧只认接口，原生实现由 [QfBridge] 接线；
/// 申请前先判断是否需要解释（`shouldShowRequestPermissionRationale` 模式），
/// 被拒过一次的用户先看一句话解释再弹系统框。
abstract class PermissionService {
  Future<PermissionOutcome> request(PermissionKind kind);

  Future<PermissionOutcome> status(PermissionKind kind);

  /// 永久拒绝时的应用内文字路径（Signal 模式）：
  /// “去设置 → 权限 → 打开 XX，否则收不到被控端上线提醒”。
  /// 返回 null 表示该权限无“去设置开”的路径（不适用）。
  String? settingsPathText(PermissionKind kind);

  /// 是否须去系统设置里开（特殊权限：悬浮窗/无障碍/电池优化）。
  bool requiresSettingsPage(PermissionKind kind);
}

/// 各权限的“去设置”文字路径（唯一出处，UI 直接取用，不许各处自写文案）。
String? permissionSettingsPathText(PermissionKind kind) {
  switch (kind) {
    case PermissionKind.notifications:
      return '去设置 → 应用 → QFRemote → 通知 → 打开通知，否则收不到被控端上线提醒，也看不到正在会话的前台通知。';
    case PermissionKind.microphone:
      return '去设置 → 应用 → QFRemote → 权限 → 麦克风 → 打开，否则语音通话没有声音。';
    case PermissionKind.overlay:
      return '去设置 → 应用 → QFRemote → 悬浮窗 → 允许，否则远程会话时无法显示悬浮控制球。';
    case PermissionKind.accessibility:
      return '去设置 → 辅助功能 → QFRemote → 打开无障碍服务，否则被控端无法接受远程输入。';
    case PermissionKind.ignoreBatteryOptimizations:
      return '去设置 → 应用 → QFRemote → 电池 → 不受限制，否则系统可能在后台杀掉会话保活，来电提醒会延迟。';
  }
}

bool permissionRequiresSettingsPage(PermissionKind kind) {
  switch (kind) {
    case PermissionKind.overlay:
    case PermissionKind.accessibility:
    case PermissionKind.ignoreBatteryOptimizations:
      return true;
    case PermissionKind.notifications:
    case PermissionKind.microphone:
      return false;
  }
}

/// 测试/沙箱用假权限服务：状态可预设，申请结果可预设。
class FakePermissionService implements PermissionService {
  final Map<PermissionKind, PermissionOutcome> preset;
  final List<PermissionKind> requested = [];

  FakePermissionService({Map<PermissionKind, PermissionOutcome>? preset})
      : preset = preset ?? {};

  @override
  Future<PermissionOutcome> request(PermissionKind kind) async {
    requested.add(kind);
    return preset[kind] ?? PermissionOutcome.denied;
  }

  @override
  Future<PermissionOutcome> status(PermissionKind kind) async =>
      preset[kind] ?? PermissionOutcome.denied;

  @override
  String? settingsPathText(PermissionKind kind) =>
      permissionSettingsPathText(kind);

  @override
  bool requiresSettingsPage(PermissionKind kind) =>
      permissionRequiresSettingsPage(kind);
}
