import 'package:flutter_test/flutter_test.dart';
import 'package:qfremote/data/services/api_client.dart';
import 'package:qfremote/data/services/device_list_fetcher.dart';

/// 第 2 轮 #2：DeviceListFetcher 契约测试。
/// 只用已有的两个服务端端点（/home/api/stats＋/api/device/resolve），
/// 不发明新接口；取数失败不得当空列表用。
void main() {
  group('DeviceListFetcher', () {
    test('stats＋resolve 正常：返回带 nodeId 的设备', () async {
      final api = _FakeApiClient(
        stats: {
          'ok': true,
          'devices': [
            {
              'name': '客厅电脑',
              'os': 'Windows 11',
              'group': '家里',
              'online': true,
              'lastAgentPong': 1763116800000,
            },
            {'name': '笔记本', 'os': '', 'group': '', 'online': false},
          ],
        },
        resolveByName: {
          '客厅电脑': {
            'ok': true,
            'nodeid': 'node/abc123',
            'name': '客厅电脑',
            'online': true,
          },
          '笔记本': {
            'ok': false,
            'code': 'OFFLINE',
            'nodeid': 'node/def456',
            'name': '笔记本',
          },
        },
      );
      final fetcher = DeviceListFetcher(
        apiClient: api,
        cookieProvider: () async => 'xid=test',
      );
      final devices = await fetcher.fetchDevices();
      expect(devices, hasLength(2));
      expect(devices[0].nodeId, 'node/abc123');
      expect(devices[0].name, '客厅电脑');
      expect(devices[0].os, 'Windows 11');
      expect(devices[0].groupName, '家里');
      expect(devices[0].online, isTrue);
      expect(
        devices[0].lastSeen,
        DateTime.fromMillisecondsSinceEpoch(1763116800000),
      );
      expect(devices[1].nodeId, 'node/def456');
      expect(devices[1].online, isFalse);
    });

    test('stats devices 为 null＝取数失败，抛错不回空列表', () async {
      final api = _FakeApiClient(stats: {'ok': true, 'devices': null});
      final fetcher = DeviceListFetcher(
        apiClient: api,
        cookieProvider: () async => 'xid=test',
      );
      await expectLater(
        fetcher.fetchDevices(),
        throwsA(isA<DeviceListFetchException>()),
      );
    });

    test('stats devices 不是数组，抛错', () async {
      final api = _FakeApiClient(stats: {'ok': true, 'devices': 'oops'});
      final fetcher = DeviceListFetcher(
        apiClient: api,
        cookieProvider: () async => 'xid=test',
      );
      await expectLater(
        fetcher.fetchDevices(),
        throwsA(isA<DeviceListFetchException>()),
      );
    });

    test('stats 零设备时返回空列表（调用方可做删除对账）', () async {
      final api = _FakeApiClient(stats: {'ok': true, 'devices': []});
      final fetcher = DeviceListFetcher(
        apiClient: api,
        cookieProvider: () async => 'xid=test',
      );
      expect(await fetcher.fetchDevices(), isEmpty);
    });

    test('单个设备 resolve 失败只跳过该设备，不影响其他设备', () async {
      final api = _FakeApiClient(
        stats: {
          'ok': true,
          'devices': [
            {'name': '好的', 'online': true},
            {'name': '坏的', 'online': true},
          ],
        },
        resolveByName: {
          '好的': {'ok': true, 'nodeid': 'node/good', 'online': true},
          '坏的': {'ok': false, 'code': 'NOT_FOUND'},
        },
      );
      final fetcher = DeviceListFetcher(
        apiClient: api,
        cookieProvider: () async => 'xid=test',
      );
      final devices = await fetcher.fetchDevices();
      expect(devices.map((d) => d.nodeId), ['node/good']);
    });

    test('同名多台 AMBIGUOUS：按 online 配对，各只一行', () async {
      final api = _FakeApiClient(
        stats: {
          'ok': true,
          'devices': [
            {'name': '同名', 'os': 'Win', 'online': true},
            {'name': '同名', 'os': 'Win', 'online': false},
          ],
        },
        resolveByName: {
          '同名': {
            'ok': false,
            'code': 'AMBIGUOUS',
            'candidates': [
              {'nodeid': 'node/off', 'name': '同名', 'online': false},
              {'nodeid': 'node/on', 'name': '同名', 'online': true},
            ],
          },
        },
      );
      final fetcher = DeviceListFetcher(
        apiClient: api,
        cookieProvider: () async => 'xid=test',
      );
      final devices = await fetcher.fetchDevices();
      expect(devices, hasLength(2));
      final byId = {for (final d in devices) d.nodeId: d};
      expect(byId['node/on']!.online, isTrue);
      expect(byId['node/off']!.online, isFalse);
      // 同名只 resolve 一次。
      expect(
        api.calls.where((c) => c.startsWith('/api/device/resolve')).length,
        1,
      );
    });

    test('stats 401 透传 UnauthorizedException（触发单飞登出）', () async {
      final api = _FakeApiClient(stats: const {}, throwStats401: true);
      final fetcher = DeviceListFetcher(
        apiClient: api,
        cookieProvider: () async => 'xid=test',
      );
      await expectLater(
        fetcher.fetchDevices(),
        throwsA(isA<UnauthorizedException>()),
      );
    });
  });
}

/// 按路径回 canned JSON 的假 QfApiClient（只重写 getJson；不碰网络）。
/// resolve 按名查表（生产侧名字经 URL 编码，fake 侧按 query 解码后查）。
class _FakeApiClient extends QfApiClient {
  _FakeApiClient({
    required Map<String, Object?> stats,
    Map<String, Map<String, Object?>> resolveByName = const {},
    this.throwStats401 = false,
  }) : _stats = stats,
       _resolveByName = resolveByName,
       super(baseUrl: 'https://example.invalid');

  final Map<String, Object?> _stats;
  final Map<String, Map<String, Object?>> _resolveByName;

  /// stats 抛 UnauthorizedException（模拟 401）。
  final bool throwStats401;

  /// 收到的 getJson 路径（断言调用次数用）。
  final calls = <String>[];

  @override
  Future<Map<String, Object?>> getJson(
    String path, {
    Map<String, String>? headers,
    Duration timeout = const Duration(seconds: 15),
  }) async {
    calls.add(path);
    if (path == '/home/api/stats') {
      if (throwStats401) throw const UnauthorizedException(401);
      return _stats;
    }
    if (path.startsWith('/api/device/resolve')) {
      final name = Uri.parse(path).queryParameters['name'] ?? '';
      final res = _resolveByName[name];
      if (res == null) throw const ApiException(404, 'no stub');
      return res;
    }
    throw const ApiException(404, 'no stub');
  }
}
