import 'package:flutter/services.dart';

/// 原生通道（2.4.5，B9/B18）：MainActivity.kt 侧的两个通道。
///
/// - `qfremote/screen`：setKeepScreenOn(bool)——会话进行态屏幕常亮，
///   退出会话/切后台时清（Window.FLAG_KEEP_SCREEN_ON）。
/// - `qfremote/install`：canInstallUnknown() / openUnknownAppSourcesSettings()
///   ——未知应用安装开关被关时引导用户去系统设置开启（B18）。
class NativeChannels {
  static const MethodChannel _screen =
      MethodChannel('qfremote/screen');
  static const MethodChannel _install =
      MethodChannel('qfremote/install');
  static const MethodChannel _storage =
      MethodChannel('qfremote/storage');

  /// 指定目录所在分区的可用空间（字节，B23）：MainActivity 经 StatFs 取
  /// 值；取不到（通道不可用/路径无效）返回 null——调用方按保守处理
  /// （不拦截下载但记日志，不谎报空间充足）。
  static Future<int?> getFreeSpaceBytes(String path) async {
    try {
      final r = await _storage.invokeMethod<int>(
          'getFreeSpaceBytes', {'path': path});
      if (r == null || r < 0) return null;
      return r;
    } catch (_) {
      return null;
    }
  }

  /// 会话进行时开常亮，退出时关。通道不可用时安静 false（不挡会话）。
  static Future<bool> setKeepScreenOn(bool on) async {
    try {
      final r = await _screen.invokeMethod<bool>(
          'setKeepScreenOn', {'on': on});
      return r ?? true;
    } catch (_) {
      return false;
    }
  }

  /// 本应用是否已被允许安装未知应用。
  static Future<bool?> canInstallUnknown() async {
    try {
      return await _install.invokeMethod<bool>('canInstallUnknown');
    } catch (_) {
      return null;
    }
  }

  /// 跳系统设置页（ACTION_MANAGE_UNKNOWN_APP_SOURCES，本应用）。
  static Future<bool> openUnknownAppSourcesSettings() async {
    try {
      final r = await _install.invokeMethod<bool>(
          'openUnknownAppSourcesSettings');
      return r ?? true;
    } catch (_) {
      return false;
    }
  }
}
