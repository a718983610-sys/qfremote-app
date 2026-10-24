import 'package:flutter_test/flutter_test.dart';
import 'package:qfremote/services/lock_client.dart';

void main() {
  group('validateLockPassword（4–64 位预检）', () {
    test('边界：3 位太短、4 位通过', () {
      expect(validateLockPassword('abc'), '密码至少 4 位，请检查后重试。');
      expect(validateLockPassword(''), '密码至少 4 位，请检查后重试。');
      expect(validateLockPassword('abcd'), isNull);
    });
    test('边界：64 位通过、65 位太长', () {
      expect(validateLockPassword('a' * 64), isNull);
      expect(validateLockPassword('a' * 65), '密码最多 64 位，请检查后重试。');
    });
  });

  group('MockLock 数据流（内存假数据真改状态）', () {
    setUp(() => LockClient.resetMock());

    test('种子数据：3 台，含一台已锁定与一台非机主', () async {
      final client = LockClient(mock: true);
      final devices = await client.listDevices();
      expect(devices.length, 3);
      expect(devices.where((d) => d.owner).length, 2);
      expect(devices.where((d) => !d.owner).length, 1);
      expect(devices.where((d) => d.locked).length, 1);
    });

    test('enable 后 locked=true，disable 后 locked=false', () async {
      final client = LockClient(mock: true);
      var devices = await client.listDevices();
      final target = devices.firstWhere((d) => d.owner && !d.locked);
      expect(target.locked, isFalse);

      await client.enable(target.id, '1234');
      devices = await client.listDevices();
      expect(devices.firstWhere((d) => d.id == target.id).locked, isTrue);

      await client.disable(target.id);
      devices = await client.listDevices();
      expect(devices.firstWhere((d) => d.id == target.id).locked, isFalse);
    });

    test('reset 后保持 locked（电脑保持锁定）', () async {
      final client = LockClient(mock: true);
      var devices = await client.listDevices();
      final locked = devices.firstWhere((d) => d.locked);

      await client.reset(locked.id, 'login-pass', '5678');
      devices = await client.listDevices();
      expect(devices.firstWhere((d) => d.id == locked.id).locked, isTrue);
    });

    test('enable 密码预检不通过抛 LockException 且不改状态', () async {
      final client = LockClient(mock: true);
      final devices = await client.listDevices();
      final target = devices.firstWhere((d) => d.owner && !d.locked);
      await expectLater(
        client.enable(target.id, '123'),
        throwsA(isA<LockException>()),
      );
      final after = await client.listDevices();
      expect(after.firstWhere((d) => d.id == target.id).locked, isFalse);
    });
  });
}
