import 'dart:async';

import 'package:drift/drift.dart' hide isNull, isNotNull;
import 'package:flutter_test/flutter_test.dart';
import 'package:qfremote/app/services.dart';
import 'package:qfremote/data/repositories/device_repository.dart';
import 'package:qfremote/data/services/device_list_fetcher.dart';
import 'package:qfremote/ui/features/devices/device_list_view_model.dart';

/// 第 2 轮 #2：DeviceListViewModel 刷新接线测试。
void main() {
  driftRuntimeOptions.dontWarnAboutMultipleDatabases = true;

  group('DeviceListViewModel.refresh', () {
    test('取数成功后写库，设备可见、error 清掉', () async {
      final services = Services.memory();
      final vm = DeviceListViewModel(
        services.deviceRepository,
        fetcher: _FakeSource([
          const DeviceInfo(nodeId: 'n1', name: 'A', online: true),
          const DeviceInfo(nodeId: 'n2', name: 'B', online: false),
        ]),
      );
      await vm.refresh();
      expect(vm.error, isNull);
      expect(vm.devices, hasLength(2));
      expect(vm.refreshing, isFalse);
      vm.dispose();
      await services.dispose();
    });

    test('取数失败留旧列表、置 error，不删库', () async {
      final services = Services.memory();
      final repo = services.deviceRepository;
      await repo.refreshFromServer([
        const DeviceInfo(nodeId: 'n1', name: '旧的'),
      ]);
      final vm = DeviceListViewModel(repo, fetcher: _ThrowingSource());
      // 等构造时的一次性读完成（_load 是 unawaited 的）。
      await Future<void>.delayed(Duration.zero);
      await vm.refresh();
      expect(vm.error, isNotNull);
      expect(vm.devices, hasLength(1));
      expect(vm.devices.single.nodeId, 'n1');
      vm.dispose();
      await services.dispose();
    });

    test('无取数器时 refresh 报“同步服务未就绪”', () async {
      final services = Services.memory();
      final vm = DeviceListViewModel(services.deviceRepository);
      await vm.refresh();
      expect(vm.error, contains('未就绪'));
      vm.dispose();
      await services.dispose();
    });

    test('刷新中 refreshing 为真，结束为假', () async {
      final services = Services.memory();
      final gate = Completer<List<DeviceInfo>>();
      final vm = DeviceListViewModel(
        services.deviceRepository,
        fetcher: _GatedSource(gate.future),
      );
      final running = vm.refresh();
      await Future<void>.delayed(Duration.zero);
      expect(vm.refreshing, isTrue);
      gate.complete([]);
      await running;
      expect(vm.refreshing, isFalse);
      vm.dispose();
      await services.dispose();
    });

    test('改名走注入的串行器（_authChain 顺序由调用方保证）', () async {
      final services = Services.memory();
      final order = <String>[];
      Future<void> serializer(Future<void> Function() op) async {
        order.add('before');
        await op();
        order.add('after');
      }

      var calls = 0;
      Future<void> countingSerializer(Future<void> Function() op) async {
        calls++;
        await serializer(op);
      }

      final vm = DeviceListViewModel(
        services.deviceRepository,
        runSerialized: countingSerializer,
      );
      await services.deviceRepository.refreshFromServer([
        const DeviceInfo(nodeId: 'n1', name: 'A'),
      ]);
      await vm.rename('n1', '新名');
      expect(calls, 1);
      expect(order, ['before', 'after']);
      final row = await services.db.deviceByNodeId('n1');
      expect(row?.name, '新名');
      vm.dispose();
      await services.dispose();
    });
  });
}

class _FakeSource implements DeviceListSource {
  _FakeSource(this.devices);
  final List<DeviceInfo> devices;
  var calls = 0;

  @override
  Future<List<DeviceInfo>> fetchDevices() async {
    calls++;
    return devices;
  }
}

class _ThrowingSource implements DeviceListSource {
  @override
  Future<List<DeviceInfo>> fetchDevices() async {
    throw const DeviceListFetchException('断网');
  }
}

class _GatedSource implements DeviceListSource {
  _GatedSource(this.future);
  final Future<List<DeviceInfo>> future;

  @override
  Future<List<DeviceInfo>> fetchDevices() => future;
}
