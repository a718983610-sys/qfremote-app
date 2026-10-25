import 'dart:math';

import 'credential_store.dart';

/// 本机设备码（2.3.1 许可体系，契约 §3）：软件端上报/绑定用的稳定设备标识。
///
/// 口径：首次使用时随机生成一次，之后恒定不变（换账号不换码——B6「一设备
/// 两账号」检测正靠它识别同一设备；退出登录不清，口径同聊天设备钥匙）。
/// 只存于 Keystore 加密区，不进明文设置；不含任何账号/个人信息。
class DeviceCodeStore {
  static const _kDeviceCode = 'qf_device_code';

  final SecureKvStore _kv;
  final String Function() _generate;

  DeviceCodeStore([SecureKvStore? kv, String Function()? generate])
      : _kv = kv ?? FlutterSecureKvStore(),
        _generate = generate ?? _randomCode;

  static String _randomCode() {
    final rnd = Random.secure();
    final bytes = List<int>.generate(16, (_) => rnd.nextInt(256));
    return bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
  }

  /// 取本机设备码：没有就生成并落盘（并发调用以先落盘者为准，值恒定后不再变）。
  Future<String> getOrCreate() async {
    final existing = await _kv.read(_kDeviceCode);
    if (existing != null && existing.isNotEmpty) return existing;
    final code = _generate();
    await _kv.write(_kDeviceCode, code);
    return code;
  }
}
