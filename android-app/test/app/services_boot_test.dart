import 'dart:async';

import 'package:drift/drift.dart' hide isNull, isNotNull;
import 'package:flutter_test/flutter_test.dart';
import 'package:qfremote/app/services.dart';
import 'package:qfremote/data/db/app_database.dart';
import 'package:qfremote/data/repositories/device_repository.dart';

/// 安卓接线第 1 轮（Drift 层＋Services.build）：
/// #1 _boot 内构建 Services（失败降级）、#10 网络层重建、#9 退出清库。
void main() {
  driftRuntimeOptions.dontWarnAboutMultipleDatabases = true;

  group('buildServicesForBoot（#1）', () {
    test('构建成功时挂到 holder 并返回同一实例', () async {
      final holder = ServicesHolder();
      final services = await buildServicesForBoot(
        holder: holder,
        baseUrl: 'https://example.invalid',
        build: () async => Services.memory(),
      );
      expect(services, isNotNull);
      expect(identical(holder.services, services), isTrue);
      expect(services!.apiBaseUrl, 'https://example.invalid');
      await services.dispose();
    });

    test('构建抛错时返回 null、holder 保持 null、不抛错', () async {
      final holder = ServicesHolder();
      Object? seen;
      final services = await buildServicesForBoot(
        holder: holder,
        baseUrl: 'https://example.invalid',
        build: () async => throw StateError('db open failed'),
        onError: (e) => seen = e,
      );
      expect(services, isNull);
      expect(holder.services, isNull);
      expect(seen, isA<StateError>());
    });

    test('构建挂起时超时返回 null（降级，不等挂起的构建）', () async {
      final holder = ServicesHolder();
      final sw = Stopwatch()..start();
      final services = await buildServicesForBoot(
        holder: holder,
        baseUrl: 'https://example.invalid',
        build: () => Completer<Services>().future,
        timeout: const Duration(milliseconds: 100),
      );
      sw.stop();
      expect(services, isNull);
      expect(holder.services, isNull);
      expect(sw.elapsedMilliseconds, lessThan(5000));
    });
  });

  group('rebuildNetwork（#10）', () {
    test('换基址时重建网络层、仓库实例不动、库内数据仍在', () async {
      final services = Services.memory();
      final devicesBefore = services.deviceRepository;
      final syncBefore = services.syncRepository;
      await services.deviceRepository.refreshFromServer([
        const DeviceInfo(nodeId: 'n1', name: 'A', online: true),
      ]);
      expect(services.apiBaseUrl, 'https://example.invalid');
      services.rebuildNetwork(baseUrl: 'https://other.invalid');
      expect(services.apiBaseUrl, 'https://other.invalid');
      expect(identical(services.deviceRepository, devicesBefore), isTrue);
      expect(identical(services.syncRepository, syncBefore), isTrue);
      final all = await services.deviceRepository.allDevices();
      expect(all.map((d) => d.nodeId), ['n1']);
      await services.dispose();
    });
  });

  group('clearAllData / 退出清库（#9）', () {
    test('清掉设备／发件箱／ID 映射三表，重复清不抛错', () async {
      final db = QfDatabase.memory();
      await db.upsertDevice(const DevicesCompanion(
        nodeId: Value('n1'),
        name: Value('A'),
      ));
      await db.enqueueOutbox(const OutboxEntriesCompanion(
        entityKind: Value('device'),
        entityId: Value('n1'),
        op: Value('rename'),
        payloadJson: Value('{}'),
        idempotencyKey: Value('k1'),
      ));
      await db.recordIdRemap('tmp-1', 'real-1');
      expect((await db.allDevices()).length, 1);
      expect((await db.allOutboxForTest()).length, 1);
      expect(await db.resolveTmpId('tmp-1'), 'real-1');
      await db.clearAllData();
      expect(await db.allDevices(), isEmpty);
      expect(await db.allOutboxForTest(), isEmpty);
      expect(await db.resolveTmpId('tmp-1'), isNull);
      await db.clearAllData(); // 幂等
      await db.close();
    });

    test('clearServicesDataForLogout：services 为 null 时不抛错', () async {
      await clearServicesDataForLogout(null);
    });

    test('clearServicesDataForLogout：清掉内存库全部数据、连接仍可用',
        () async {
      final services = Services.memory();
      await services.db.upsertDevice(const DevicesCompanion(
        nodeId: Value('n1'),
        name: Value('A'),
      ));
      await clearServicesDataForLogout(services);
      expect(await services.db.allDevices(), isEmpty);
      // 连接未关：清库后仍可写（下个账号复用同一库）。
      await services.db.upsertDevice(const DevicesCompanion(
        nodeId: Value('n2'),
        name: Value('B'),
      ));
      expect((await services.db.allDevices()).length, 1);
      await services.dispose();
    });
  });
}
