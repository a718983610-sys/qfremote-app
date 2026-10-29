import 'package:flutter_test/flutter_test.dart';
import 'package:qfremote/services/credential_store.dart';
import 'package:qfremote/services/device_code.dart';

/// 读值在调用瞬间定格、延迟后才返回：模拟两路并发读都发生在
/// 任何一路落盘之前（H-7 复现条件）。
class _SlowKv extends MemorySecureKvStore {
  @override
  Future<String?> read(String key) async {
    final v = await super.read(key);
    await Future<void>.delayed(const Duration(milliseconds: 20));
    return v;
  }
}

void main() {
  group('DeviceCodeStore 设备码', () {
    test('首次生成并落盘、再次取同一码', () async {
      final kv = MemorySecureKvStore();
      var n = 0;
      final store = DeviceCodeStore(kv, () => 'code-${++n}');
      final c1 = await store.getOrCreate();
      expect(c1, 'code-1');
      expect(await kv.read('qf_device_code'), 'code-1');
      final c2 = await store.getOrCreate();
      expect(c2, 'code-1');
      expect(n, 1, reason: '已有码时不得再生成');
    });

    test('已有码直接返回、不生成', () async {
      final kv = MemorySecureKvStore();
      await kv.write('qf_device_code', 'existing-code');
      final store = DeviceCodeStore(kv, () => fail('不应生成新码'));
      expect(await store.getOrCreate(), 'existing-code');
    });

    test('H-7：并发首启只产一码、返回值与落盘一致', () async {
      final kv = _SlowKv();
      var n = 0;
      final store = DeviceCodeStore(kv, () => 'code-${++n}');
      final results =
          await Future.wait([store.getOrCreate(), store.getOrCreate()]);
      expect(results[0], results[1], reason: '并发两路必须同码');
      expect(n, 1, reason: '只许生成一次');
      expect(await kv.read('qf_device_code'), results[0]);
    });
  });
}
