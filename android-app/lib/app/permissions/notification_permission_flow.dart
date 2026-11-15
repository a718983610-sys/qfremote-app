import 'permission_service.dart';

/// A-03 接线（R1）：会话启动时通知权限的申请编排（纯逻辑，UI 回调由调用方注入，
/// 便于单测；真机弹窗行为见 evidence-deep-review-20261115/WIRING-R1-PERMISSIONS.md
/// 待真机验清单）。
///
/// 流程（docs/PERMISSIONS.md 口径）：
/// 1. 已授权 → 直接返回 granted，不弹任何框。
/// 2. 本轮已提示过（[_prompted]）→ 不再重复打扰，返回上次结果。
/// 3. status == denied（被拒过一次、还能再弹）→ 先弹一句话解释
///    （[showRationale]），用户点“去开启”才调 request；点“暂不开启”即停。
/// 4. 其余（status == permanentlyDenied：含首次申请前——系统从未弹过框时
///    rationale 亦为 false）→ 直接 request（首次会弹系统框）。
/// 5. request 回 permanentlyDenied → 弹设置路径（[showSettingsPath]，
///    文案唯一出处 permissionSettingsPathText），用户点“去设置”则
///    [openSettings]（QfBridge.openAppSettings）。
/// 任何一步抛错都按 denied 返回，不挡会话（fail-open）。
class NotificationPermissionFlow {
  NotificationPermissionFlow(this.service);

  final PermissionService service;

  bool _prompted = false;
  PermissionOutcome _lastOutcome = PermissionOutcome.denied;

  /// 本轮是否已提示过（单测／调用方可见）。
  bool get prompted => _prompted;

  Future<PermissionOutcome> ensure({
    required Future<bool> Function() showRationale,
    required Future<bool> Function(String settingsText) showSettingsPath,
    required Future<void> Function() openSettings,
  }) async {
    PermissionOutcome current;
    try {
      current = await service.status(PermissionKind.notifications);
    } catch (_) {
      return PermissionOutcome.denied;
    }
    if (current == PermissionOutcome.granted) {
      _lastOutcome = PermissionOutcome.granted;
      return PermissionOutcome.granted;
    }
    if (_prompted) return _lastOutcome;

    if (current == PermissionOutcome.denied) {
      bool goAhead;
      try {
        goAhead = await showRationale();
      } catch (_) {
        goAhead = false;
      }
      if (!goAhead) {
        _prompted = true;
        _lastOutcome = PermissionOutcome.denied;
        return PermissionOutcome.denied;
      }
    }
    PermissionOutcome outcome;
    try {
      outcome = await service.request(PermissionKind.notifications);
    } catch (_) {
      outcome = PermissionOutcome.denied;
    }
    _prompted = true;
    _lastOutcome = outcome;
    if (outcome == PermissionOutcome.permanentlyDenied) {
      final settingsText =
          permissionSettingsPathText(PermissionKind.notifications) ?? '';
      bool goSettings;
      try {
        goSettings = await showSettingsPath(settingsText);
      } catch (_) {
        goSettings = false;
      }
      if (goSettings) {
        try {
          await openSettings();
        } catch (_) {
          // 打开设置失败也不挡会话。
        }
      }
    }
    return outcome;
  }
}
