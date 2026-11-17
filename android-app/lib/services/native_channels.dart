import 'qf_bridge.dart';

/// 原生通道薄 shim（A-06）：历史调用点（main.dart）保持原 API 不变，
/// 实际调用全部走单一桥接 [QfBridge]（`qfremote/bridge`）。
/// 新代码直接调 [QfBridge]，不要再经本类中转。
class NativeChannels {
  /// 指定目录所在分区的可用空间（字节，B23）：取不到返回 null——调用方
  /// 按保守处理（不拦截下载但记日志，不谎报空间充足）。
  static Future<int?> getFreeSpaceBytes(String path) =>
      QfBridge.getFreeSpaceBytes(path);

  /// 会话进行时开常亮，退出时关。通道不可用时安静 false（不挡会话）。
  static Future<bool> setKeepScreenOn(bool on) =>
      QfBridge.setKeepScreenOn(on);

  /// 本应用是否已被允许安装未知应用。
  static Future<bool?> canInstallUnknown() => QfBridge.canInstallUnknown();

  /// 跳系统设置页（ACTION_MANAGE_UNKNOWN_APP_SOURCES，本应用）。
  static Future<bool> openUnknownAppSourcesSettings() =>
      QfBridge.openUnknownAppSourcesSettings();
}
