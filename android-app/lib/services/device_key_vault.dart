import 'dart:convert';
import 'dart:math';

import 'credential_store.dart';

/// 设备钥匙库（2.3.0 追加四，格式以 L 线定版为准：DESIGN.md 第八节）。
///
/// 一把 32 字节随机「设备钥匙」只存本机（经 [SecureKvStore]，生产实现为
/// flutter_secure_storage＝Android Keystore 体系加密落盘）。壳在聊天页
/// 需要时经 evaluateJavascript 把钥匙递入页面内存（qfShellDeviceUnlock /
/// qfShellDeviceEnroll），页面用它解开/补写服务端的「壳路径」设备包裹
/// 副本（libsodium secretbox，sodium-secretbox-v1）。页面不落盘保存钥匙。
///
/// 口径（与 L 线 device-key.js 一致）：
/// - 设备钥匙与登录密码互相独立：改密不影响设备副本与本机历史可读；
/// - 手动退出账号不清设备钥匙（退出不等于换设备）；副本按账号存放在
///   服务端，下个账号在本机解锁后会补写自己的副本；
/// - 钥匙只递入自家聊天页内存（与页面解锁后持有明文钥匙同一信任级）。
class DeviceKeyVault {
  static const String storageKey = 'qf_device_key_v1';

  final SecureKvStore _store;
  final Random _random;

  DeviceKeyVault({SecureKvStore? store, Random? random})
      : _store = store ?? FlutterSecureKvStore(),
        _random = random ?? Random.secure();

  /// 取设备钥匙（base64，32 字节）；没有就生成并落盘（首次建钥匙时刻）。
  Future<String> getOrCreate() async {
    final existing = await _store.read(storageKey);
    if (existing != null && _isValidKey(existing)) return existing;
    final bytes = List<int>.generate(32, (_) => _random.nextInt(256));
    final key = base64Encode(bytes);
    await _store.write(storageKey, key);
    return key;
  }

  /// 是否已有可用的设备钥匙（不生成）。
  Future<bool> has() async {
    final existing = await _store.read(storageKey);
    return existing != null && _isValidKey(existing);
  }

  /// 清除设备钥匙（手动退出时调用）。
  Future<void> clear() => _store.delete(storageKey);

  static bool _isValidKey(String b64) {
    try {
      return base64Decode(b64).length == 32;
    } catch (_) {
      return false;
    }
  }
}
