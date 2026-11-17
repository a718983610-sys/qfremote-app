import 'package:drift/drift.dart' hide isNull, isNotNull;
import 'package:flutter_test/flutter_test.dart';
import 'package:qfremote/app/services.dart';
import 'package:qfremote/data/repositories/device_repository.dart';
import 'package:qfremote/data/services/api_client.dart';

void main() {
  driftRuntimeOptions.dontWarnAboutMultipleDatabases = true;
  group('DeviceRepository（契约测试：每实体仓库共享行为）', () {
    test('改名先落库回显、再进发件箱', () async {
      final services = Services.memory(
          transport: _OkTransport());
      final repo = services.deviceRepository;
      await repo.refreshFromServer([
        const DeviceInfo(nodeId: 'n1', name: '旧名', online: true),
      ]);
      final key = await repo.rename('n1', '新名');
      expect(key, isNotEmpty);
      final row = await services.db.deviceByNodeId('n1');
      expect(row?.name, '新名');
      expect(row?.isDirty, isTrue);
      final pending = await services.db.pendingOutbox();
      expect(pending, hasLength(1));
      expect(pending.single.op, 'rename');
      await services.dispose();
    });

    test('服务端刷新写入 Drift，UI 只读流', () async {
      final services = Services.memory();
      final repo = services.deviceRepository;
      await repo.refreshFromServer([
        const DeviceInfo(nodeId: 'n1', name: 'A', online: true),
        const DeviceInfo(nodeId: 'n2', name: 'B', online: false),
      ]);
      final all = await repo.allDevices();
      expect(all.map((d) => d.nodeId), ['n1', 'n2']);
      // 流式订阅收到同一批数据
      final streamed = await repo.watchDevices().first;
      expect(streamed, hasLength(2));
      await services.dispose();
    });

    test('改分组走同一条写管道', () async {
      final services = Services.memory();
      final repo = services.deviceRepository;
      await repo.refreshFromServer([
        const DeviceInfo(nodeId: 'n1', name: 'A', groupName: '默认'),
      ]);
      await repo.setGroup('n1', '工作组');
      final row = await services.db.deviceByNodeId('n1');
      expect(row?.groupName, '工作组');
      expect(row?.isDirty, isTrue);
      await services.dispose();
    });

    test('排空成功后 isDirty 由服务端刷新清掉（刷新即事实源）', () async {
      final services =
          Services.memory(transport: _OkTransport());
      final repo = services.deviceRepository;
      await repo.refreshFromServer([
        const DeviceInfo(nodeId: 'n1', name: 'A'),
      ]);
      await repo.rename('n1', 'B');
      final result = await repo.drainOutbox();
      expect(result.sent, 1);
      // 服务端刷新后脏标记清零
      await repo.refreshFromServer([
        const DeviceInfo(nodeId: 'n1', name: 'B'),
      ]);
      final row = await services.db.deviceByNodeId('n1');
      expect(row?.isDirty, isFalse);
      await services.dispose();
    });
  });

  group('refreshFromServer 删除对账（第 2 轮 #8）', () {
    test('服务端已删的干净行同步删掉', () async {
      final services = Services.memory();
      final repo = services.deviceRepository;
      await repo.refreshFromServer([
        const DeviceInfo(nodeId: 'n1', name: 'A'),
        const DeviceInfo(nodeId: 'n2', name: 'B'),
      ]);
      // 服务端只剩 n1：n2 干净行删掉，n1 保留。
      await repo.refreshFromServer([
        const DeviceInfo(nodeId: 'n1', name: 'A'),
      ]);
      final all = await repo.allDevices();
      expect(all.map((d) => d.nodeId), ['n1']);
      await services.dispose();
    });

    test('脏行（本地未同步改名）即使服务端已无也保留', () async {
      final services =
          Services.memory(transport: _OkTransport());
      final repo = services.deviceRepository;
      await repo.refreshFromServer([
        const DeviceInfo(nodeId: 'n1', name: 'A'),
        const DeviceInfo(nodeId: 'n2', name: 'B'),
      ]);
      await repo.rename('n2', '本地改名');
      // 服务端只剩 n1：n2 脏行保留（改名还没同步，删了会丢改动）。
      await repo.refreshFromServer([
        const DeviceInfo(nodeId: 'n1', name: 'A'),
      ]);
      final row = await services.db.deviceByNodeId('n2');
      expect(row, isNotNull);
      expect(row!.name, '本地改名');
      expect(row.isDirty, isTrue);
      await services.dispose();
    });

    test('服务端零设备时删全部干净行', () async {
      final services = Services.memory();
      final repo = services.deviceRepository;
      await repo.refreshFromServer([
        const DeviceInfo(nodeId: 'n1', name: 'A'),
        const DeviceInfo(nodeId: 'n2', name: 'B'),
      ]);
      await repo.refreshFromServer([]);
      expect(await repo.allDevices(), isEmpty);
      await services.dispose();
    });

    test('服务端仍在的设备只更新不误删', () async {
      final services = Services.memory();
      final repo = services.deviceRepository;
      await repo.refreshFromServer([
        const DeviceInfo(nodeId: 'n1', name: 'A', online: false),
      ]);
      await repo.refreshFromServer([
        const DeviceInfo(nodeId: 'n1', name: 'A-改名', online: true),
      ]);
      final all = await repo.allDevices();
      expect(all, hasLength(1));
      expect(all.single.name, 'A-改名');
      expect(all.single.online, isTrue);
      await services.dispose();
    });
  });

  group('QfApiClient（A-06 网络层可整体重建）', () {    test('rebuild 换 baseUrl', () {
      final api = QfApiClient(baseUrl: 'https://a.example');
      expect(api.baseUrl, 'https://a.example');
      api.rebuild(baseUrl: 'https://b.example');
      expect(api.baseUrl, 'https://b.example');
      api.dispose();
    });

    test('rebuild 不带 baseUrl 时只重建客户端', () {
      final api = QfApiClient(baseUrl: 'https://a.example');
      api.rebuild();
      expect(api.baseUrl, 'https://a.example');
      api.dispose();
    });
  });
}

class _OkTransport implements OutboxTransport {
  @override
  Future<OutboxResult> send(entry) async =>
      const OutboxResult.success();
}
