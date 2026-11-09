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
