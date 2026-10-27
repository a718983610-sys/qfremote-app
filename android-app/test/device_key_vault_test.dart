import 'dart:convert';
import 'dart:math';

import 'package:flutter_test/flutter_test.dart';
import 'package:qfremote/services/credential_store.dart';
import 'package:qfremote/services/device_key_vault.dart';

void main() {
  group('DeviceKeyVault 设备钥匙库', () {
    test('首次生成：32 字节 base64、落盘、再次取同一把', () async {
      final store = MemorySecureKvStore();
      final vault = DeviceKeyVault(store: store, random: Random(42));
      final k1 = await vault.getOrCreate();
      expect(base64Decode(k1).length, 32);
      expect(await store.read(DeviceKeyVault.storageKey), k1);
      final k2 = await vault.getOrCreate();
      expect(k2, k1);
      expect(await vault.has(), isTrue);
    });

    test('存量坏值（长度不对/非 base64）按没有处理并重建', () async {
      final store = MemorySecureKvStore();
      await store.write(DeviceKeyVault.storageKey, 'aGk='); // "hi"，2 字节
      final vault = DeviceKeyVault(store: store, random: Random(7));
      expect(await vault.has(), isFalse);
      final k = await vault.getOrCreate();
      expect(base64Decode(k).length, 32);
    });

    test('清除后 has 为假、下次生成新钥匙（退出账号口径）', () async {
      final store = MemorySecureKvStore();
      final vault = DeviceKeyVault(store: store, random: Random(42));
      final k1 = await vault.getOrCreate();
      await vault.clear();
      expect(await vault.has(), isFalse);
      expect(await store.read(DeviceKeyVault.storageKey), isNull);
      final vault2 = DeviceKeyVault(store: store, random: Random(99));
      final k2 = await vault2.getOrCreate();
      expect(k2, isNot(k1));
    });

    test('钥匙格式与 L 线定版一致：base64 原始 32 字节（secretbox 钥匙长）', () async {
      final vault = DeviceKeyVault(store: MemorySecureKvStore(), random: Random(3));
      final k = await vault.getOrCreate();
      expect(base64Decode(k).length, 32);
    });
  });
}
