import 'package:qfremote/services/qf_bridge.dart';

import 'permission_service.dart';

/// A-03 接线（R1）：集中权限服务的生产实现，走 QfBridge `permissions.`
/// 域调原生 MainActivity 申请（POST_NOTIFICATIONS 等运行时权限）。
///
/// 原生侧字符串语义（MainActivity.kt）：
/// - `permissions.status("notifications")`：
///   "granted" 已授权；"denied" 被拒过且还能再弹（rationale 可示）；
///   "permanently_denied" rationale 不可示——注意：首次申请前也返回
///   该值（系统从未弹过框时 shouldShowRequestPermissionRationale 为
///   false），调用方不得仅凭 status 就判“永久拒绝”，须先 request 一次。
/// - `permissions.request("notifications")`：
///   Android 13 以下直接 "granted"；已授权直接 "granted"；否则弹系统框，
///   按用户选择回 "granted"/"denied"/"permanently_denied"。
/// - 非通知类 kind（microphone/overlay/accessibility/battery）：
///   原生回 "settings_required"，须走设置页引导，不弹系统框。
/// 桥接缺失／返回 null／未知串一律按 denied 处理（fail-open：会话不被
/// 权限流程挡住，调用方按“未授权”走解释或设置路径）。
class QfBridgePermissionService implements PermissionService {
  const QfBridgePermissionService();

  static PermissionOutcome _mapOutcome(String? raw) {
    switch (raw) {
      case 'granted':
        return PermissionOutcome.granted;
      case 'permanently_denied':
        return PermissionOutcome.permanentlyDenied;
      case 'denied':
      case 'settings_required':
      case 'unknown':
      default:
        // settings_required：须走设置页的权限，request 不弹系统框，
        // 调用方应按 requiresSettingsPage 走设置路径；此处先按 denied
        // 计，settingsPathText 仍由 permissionSettingsPathText 提供。
        return PermissionOutcome.denied;
    }
  }

  @override
  Future<PermissionOutcome> request(PermissionKind kind) async {
    final raw = await QfBridge.requestPermission(kind.name);
    return _mapOutcome(raw);
  }

  @override
  Future<PermissionOutcome> status(PermissionKind kind) async {
    final raw = await QfBridge.permissionStatus(kind.name);
    return _mapOutcome(raw);
  }

  @override
  String? settingsPathText(PermissionKind kind) =>
      permissionSettingsPathText(kind);

  @override
  bool requiresSettingsPage(PermissionKind kind) =>
      permissionRequiresSettingsPage(kind);
}
