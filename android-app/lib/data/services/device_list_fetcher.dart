import '../repositories/device_repository.dart';
import '../services/api_client.dart';
import '../../services/points.dart' show ConsoleCookieProvider;

/// 设备列表取数源（接口）：生产实现是 [DeviceListFetcher]，测试用假实现。
abstract class DeviceListSource {
  /// 拉一轮服务端设备全量（带 nodeId）。
  /// 返回空列表＝服务端明确说零设备；取数失败抛错。
  Future<List<DeviceInfo>> fetchDevices();
}

/// 设备列表取数（第 2 轮 #2：原生设备列表页的生产取数路径）。
///
/// 只用已有的服务端端点，不发明新接口：
/// - `GET /home/api/stats`（cookie 会话鉴权）：回包 `devices` 数组，
///   每项只有 name/os/group/online/stale/lastAgentPong，没有 nodeId
///   （服务端有意不回 id——见 server.js `buildHomeStats`）。
/// - `GET /api/device/resolve?name=<设备名>`：按名查裸 nodeId（服务端
///   已有兜底端点，专治 name→nodeid 竞态）。ok／OFFLINE 都带 nodeid；
///   AMBIGUOUS 时 candidates 里带全部 nodeId；NOT_FOUND／TIMEOUT 则
///   该设备本轮跳过（本地旧行保留，不误删）。
///
/// 失败语义（fail-open 分层）：
/// - stats 取数失败（网络错／非 200／devices 不是数组／devices 为 null）
///   直接抛错——调用方留旧列表、不写库（绝不拿失败的空结果去触发 #8
///   删除对账误删全表）。
/// - 单个设备 resolve 失败：只跳过该设备，不影响其他设备与整轮刷新。
/// - 同名设备：同名只 resolve 一次（按名去重并发），AMBIGUOUS 时
///   candidates 全量落库（同名设备靠 nodeId 区分行；os/group 取 stats
///   项的值，无法逐台区分时以先到者为准，改名后刷新即纠正）。
class DeviceListFetcher implements DeviceListSource {
  DeviceListFetcher({
    required this.apiClient,
    required this.cookieProvider,
    this.timeout = const Duration(seconds: 10),
  });

  final QfApiClient apiClient;
  final ConsoleCookieProvider cookieProvider;
  final Duration timeout;

  /// 拉一轮服务端设备全量，返回带 nodeId 的 [DeviceInfo] 列表。
  /// 返回空列表＝服务端明确说零设备（调用方可据此做 #8 删除对账）；
  /// 取数失败抛错（调用方不得把失败当空列表）。
  @override
  Future<List<DeviceInfo>> fetchDevices() async {
    final cookie = await cookieProvider();
    final headers = <String, String>{
      if (cookie != null && cookie.isNotEmpty) 'Cookie': cookie,
    };
    final stats = await apiClient.getJson(
      '/home/api/stats',
      headers: headers,
      timeout: timeout,
    );
    final raw = stats['devices'];
    if (raw == null) {
      // devices 为 null＝服务端没取到节点图（nodesByMesh 为 null），
      // 不是“零设备”——抛错，绝不按空列表删库。
      throw const DeviceListFetchException('设备列表暂时取不到。');
    }
    if (raw is! List) {
      throw const DeviceListFetchException('设备列表响应格式异常。');
    }
    // 按名去重：同名设备只 resolve 一次。
    final byName = <String, List<Map<String, Object?>>>{};
    for (final item in raw) {
      if (item is! Map<String, Object?>) continue;
      final name = (item['name'] as String? ?? '').trim();
      if (name.isEmpty) continue;
      byName.putIfAbsent(name, () => []).add(item);
    }
    final resolved = await Future.wait(
      byName.keys.map((name) => _resolveName(name)),
    );
    final out = <DeviceInfo>[];
    var i = 0;
    for (final name in byName.keys) {
      final candidates = resolved[i++];
      final items = byName[name]!;
      // 同名多台时按 online 配对（candidates 自带 online；配不上时按
      // 顺序取未用的 nodeId，配完即止——绝不把一台设备展开成多行）。
      final unused = List<_ResolvedDevice>.from(candidates);
      for (final item in items) {
        final os = item['os'] as String? ?? '';
        final group = item['group'] as String? ?? '';
        final online = item['online'] as bool? ?? false;
        final lastSeen = _parseLastSeen(item['lastAgentPong']);
        final pick = _pickCandidate(unused, online);
        if (pick == null) continue;
        out.add(
          DeviceInfo(
            nodeId: pick.nodeId,
            name: name,
            os: os,
            groupName: group,
            online: online,
            lastSeen: lastSeen,
          ),
        );
      }
    }
    // 去重：同一 nodeId 只留一行（先到者为准）。
    final seen = <String>{};
    return out.where((d) => seen.add(d.nodeId)).toList();
  }

  /// 在未用的候选里挑一个：优先 online 一致的，否则取第一个。
  /// 挑完即移除——一个 nodeId 一轮只认一个 stats 项。
  static _ResolvedDevice? _pickCandidate(
    List<_ResolvedDevice> unused,
    bool online,
  ) {
    var idx = unused.indexWhere((c) => c.online == online);
    idx = idx >= 0 ? idx : (unused.isEmpty ? -1 : 0);
    if (idx < 0) return null;
    return unused.removeAt(idx);
  }

  /// 按名查 nodeId：ok／OFFLINE 取 nodeid；AMBIGUOUS 取全部
  /// candidates（带 online，供同名多台时配对）；其他情况
  /// （NOT_FOUND／TIMEOUT／网络错）返回空列表（本轮跳过该设备，
  /// 不删本地旧行）。
  Future<List<_ResolvedDevice>> _resolveName(String name) async {
    try {
      final cookie = await cookieProvider();
      final headers = <String, String>{
        if (cookie != null && cookie.isNotEmpty) 'Cookie': cookie,
      };
      final res = await apiClient.getJson(
        '/api/device/resolve?name=${Uri.encodeQueryComponent(name)}',
        headers: headers,
        timeout: timeout,
      );
      final nodeId = res['nodeid'] as String?;
      if (nodeId != null && nodeId.isNotEmpty) {
        return [_ResolvedDevice(nodeId, res['online'] as bool? ?? false)];
      }
      final candidates = res['candidates'];
      if (candidates is List) {
        return candidates
            .whereType<Map<String, Object?>>()
            .map(
              (c) => _ResolvedDevice(
                c['nodeid'] as String? ?? '',
                c['online'] as bool? ?? false,
              ),
            )
            .where((c) => c.nodeId.isNotEmpty)
            .toList();
      }
      return const [];
    } catch (_) {
      return const [];
    }
  }

  /// stats 的 lastAgentPong 是毫秒 epoch（服务端最后一次亲眼见到它
  /// 在线）；没有则 lastSeen 为空。
  static DateTime? _parseLastSeen(Object? value) {
    if (value is num) {
      final ms = value.toInt();
      if (ms <= 0) return null;
      return DateTime.fromMillisecondsSinceEpoch(ms);
    }
    return null;
  }
}

/// 取数失败（stats 级别）：调用方不得把失败当空列表用。
class DeviceListFetchException implements Exception {
  final String message;
  const DeviceListFetchException(this.message);
  @override
  String toString() => 'DeviceListFetchException: $message';
}

/// resolve 结果：nodeId＋online（同名多台配对用）。
class _ResolvedDevice {
  const _ResolvedDevice(this.nodeId, this.online);
  final String nodeId;
  final bool online;
}
