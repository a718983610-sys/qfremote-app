import 'package:flutter/services.dart';

/// A-06：JNI/通道调用只走一个桥接对象（RustDesk `ffi.kt` 的 `object FFI`
/// 模式）：所有原生调用收敛到单一 MethodChannel `qfremote/bridge`，
/// 方法名按域加前缀（`screen.` / `storage.` / `install.` / `apk.` /
/// `session.` / `permissions.`），禁止各处散落 MethodChannel。
/// 包名变更时桥接通道名保持不动（否则原生侧接不到调用）。
///
/// 旧的三通道（`qfremote/screen`、`qfremote/storage`、`qfremote/install`）
/// 与 `qfremote/apk_verify` 已合并到本桥，旧类 [NativeChannels] 与
/// [ApkVerify] 改为经本桥转发的薄 shim（见各自文件），Kotlin 侧只注册
/// 一个 `qfremote/bridge` 通道。
class QfBridge {
  QfBridge._();

  static const MethodChannel channel = MethodChannel('qfremote/bridge');

  static Future<T?> invoke<T>(String method, [Map<String, Object?>? args]) async {
    try {
      return await channel.invokeMethod<T>(method, args);
    } on MissingPluginException {
      return null;
    } on PlatformException {
      return null;
    }
  }

  // ---- screen（会话常亮）----
  static Future<bool> setKeepScreenOn(bool on) async {
    final r = await invoke<bool>('screen.setKeepScreenOn', {'on': on});
    return r ?? false;
  }

  // ---- storage（剩余空间）----
  static Future<int?> getFreeSpaceBytes(String path) async {
    final r =
        await invoke<int>('storage.getFreeSpaceBytes', {'path': path});
    if (r == null || r < 0) return null;
    return r;
  }

  // ---- install（未知应用安装）----
  static Future<bool?> canInstallUnknown() =>
      invoke<bool>('install.canInstallUnknown');

  static Future<bool> openUnknownAppSourcesSettings() async {
    final r =
        await invoke<bool>('install.openUnknownAppSourcesSettings');
    return r ?? false;
  }

  // ---- apk（安装包验签）----
  static Future<Map<Object?, Object?>?> inspectApk(String path) async {
    final r = await channel.invokeMethod<Map<Object?, Object?>>(
        'apk.inspectApk', {'path': path});
    return r;
  }

  // ---- session（A-02 前台服务）----
  static Future<bool> startSessionForeground(String label) async {
    final r = await invoke<bool>(
        'session.startForeground', {'label': label});
    return r ?? false;
  }

  static Future<bool> stopSessionForeground() async {
    final r = await invoke<bool>('session.stopForeground');
    return r ?? false;
  }

  /// 远程输入到达时亮屏 5 秒（WakeLock 瞬时持有，用完即放，不作常驻保活）。
  static Future<bool> wakeBriefly() async {
    final r = await invoke<bool>('session.wakeBriefly');
    return r ?? false;
  }

  // ---- background（A-01 周期同步调度：原生 JobScheduler 系统调度）----
  /// 注册周期同步（第二档）。intervalMinutes 由调用方保证 ≥15（原生侧
  /// 再钳制一次）；原生侧未响应回 false，调用方按失败处理、不冒充已调度。
  static Future<bool> schedulePeriodicSync(
    String taskId, {
    required bool wifiOnly,
    required bool chargingOnly,
    required bool batteryNotLow,
    required int intervalMinutes,
  }) async {
    final r = await invoke<bool>('background.schedulePeriodicSync', {
      'taskId': taskId,
      'wifiOnly': wifiOnly,
      'chargingOnly': chargingOnly,
      'batteryNotLow': batteryNotLow,
      'intervalMinutes': intervalMinutes,
    });
    return r ?? false;
  }

  /// 取消周期同步（尽力而为；取消不存在的任务不是错）。
  static Future<bool> cancelPeriodicSync(String taskId) async {
    final r = await invoke<bool>(
        'background.cancelPeriodicSync', {'taskId': taskId});
    return r ?? false;
  }

  // ---- permissions（A-03：通知权限等运行时权限走桥接向原生申请）----
  static Future<String?> requestPermission(String kind) =>
      invoke<String>('permissions.request', {'kind': kind});

  static Future<String?> permissionStatus(String kind) =>
      invoke<String>('permissions.status', {'kind': kind});

  static Future<bool> openAppSettings() async {
    final r = await invoke<bool>('permissions.openAppSettings');
    return r ?? false;
  }
}
