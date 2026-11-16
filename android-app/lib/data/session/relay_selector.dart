import 'dart:async';
import 'dart:convert';
import 'dart:io';

import '../../core/constants.dart';
import '../../services/points.dart' show ConsoleCookieProvider;
import '../../services/probe.dart' show trustedHttpClient;

/// RC-07 中继白名单＋三级回退（QF-RELAY-1 规范 v1）。
///
/// 来源：服务端 `server/ext/relay-core.js`（`announceRelays` /
/// `isAllowedRelay` / `pickRelay` 纯函数）与 `server.js` 的
/// `GET /license/api/relays` 路由。服务端只提供宣告列表，失败跟踪、
/// 在途计数、回退执行全在客户端本地——本文件把两段纯函数逻辑按
/// 规范在 Flutter 侧实现一遍（§4.2），不得只抄一半。
///
/// 出入（§4.1）：tier-2/3 真实中继主机目前不存在，选路逻辑与策略位
/// 先行；客户端不得在 UI 里宣称“已部署多级中继”。
class RelayEntry {
  const RelayEntry({
    required this.id,
    required this.url,
    required this.tier,
    required this.priority,
    required this.ttlSec,
    required this.issuedAt,
  });

  /// 中继标识（服务端去重键，`config.json` 里 id 去空格后截断至 80 字符）。
  final String id;

  /// 中继地址（服务端归一化后：origin＋以 `/` 结尾的路径）。
  final String url;

  /// 1 / 2 / 3（只接受这三个值，其他值条目直接跳过）。
  final int tier;

  /// 同级内排序值，数值越大越先试；未配置时默认 100。
  final int priority;

  /// 列表有效期（秒）；未配置时默认 600。
  final int ttlSec;

  /// 服务端签发时刻（毫秒 epoch，`Date.now()`）。
  final int issuedAt;

  /// 列表有效期：`issuedAt + ttlSec*1000`（§4.4：先统一单位再算过期）。
  int get expiresAtMs => issuedAt + ttlSec * 1000;

  bool isExpiredAt(int nowMs) => nowMs >= expiresAtMs;

  /// 归一化后的 origin＋路径（与服务端 `normalizeUrl` 同款：只接受
  /// http:/https:，路径补齐末尾 `/`）。非法返回 null。
  static ({String origin, String pathname, String href})? normalize(
    String raw,
  ) {
    final uri = Uri.tryParse(raw.trim());
    if (uri == null) return null;
    if (uri.scheme != 'https' && uri.scheme != 'http') return null;
    if (uri.host.isEmpty) return null;
    var pathname = uri.path.isEmpty ? '/' : uri.path;
    if (!pathname.endsWith('/')) pathname += '/';
    final origin = uri.origin;
    return (origin: origin, pathname: pathname, href: origin + pathname);
  }

  /// 解析一条服务端宣告条目；无效条目（无 id、URL 非法、tier 不在
  /// 1–3）返回 null，调用方跳过（§1.2）。
  static RelayEntry? fromJson(Map<String, Object?> json, {int? nowMs}) {
    final id = (json['id'] as String? ?? '').trim();
    final trimmedId = id.length > 80 ? id.substring(0, 80) : id;
    if (trimmedId.isEmpty) return null;
    final normalized = normalize(json['url'] as String? ?? '');
    if (normalized == null) return null;
    final tier = json['tier'] is int
        ? json['tier'] as int
        : int.tryParse('${json['tier']}') ?? -1;
    if (tier != 1 && tier != 2 && tier != 3) return null;
    final priorityRaw = json['priority'];
    final priority = priorityRaw is num
        ? priorityRaw.toInt()
        : int.tryParse('$priorityRaw') ?? 100;
    final ttlRaw = json['ttlSec'];
    final ttlSec = ttlRaw is num && ttlRaw > 0 ? ttlRaw.toInt() : 600;
    final issuedAt = json['issuedAt'] is int
        ? json['issuedAt'] as int
        : nowMs ?? DateTime.now().millisecondsSinceEpoch;
    return RelayEntry(
      id: trimmedId,
      url: normalized.href,
      tier: tier,
      priority: priority,
      ttlSec: ttlSec,
      issuedAt: issuedAt,
    );
  }

  /// 解析宣告列表：去重（同 id 只留第一条）、上限 32 条、排序
  /// tier 升序 → priority 降序 → id 字典序（与服务端同款）。
  static List<RelayEntry> parseAnnouncements(
    List<Object?> raw, {
    int? nowMs,
  }) {
    const maxRelays = 32;
    final out = <RelayEntry>[];
    for (final item in raw) {
      if (out.length >= maxRelays) break;
      if (item is! Map<String, Object?>) continue;
      final entry = RelayEntry.fromJson(item, nowMs: nowMs);
      if (entry == null) continue;
      if (out.any((e) => e.id == entry.id)) continue;
      out.add(entry);
    }
    out.sort(_compare);
    return out;
  }

  static int _compare(RelayEntry a, RelayEntry b) {
    if (a.tier != b.tier) return a.tier - b.tier;
    if (a.priority != b.priority) return b.priority - a.priority;
    return a.id.compareTo(b.id);
  }

  Map<String, Object?> toJson() => {
        'id': id,
        'url': url,
        'tier': tier,
        'priority': priority,
        'ttlSec': ttlSec,
        'issuedAt': issuedAt,
      };
}

/// 白名单校验（与服务端 `isAllowedRelay` 同款，建连前必调，§3）：
/// URL 归一化（只接受 http:/https:，路径补齐末尾 `/`）；匹配规则为
/// origin 相等，且路径是列表条目路径的前缀。列表为空时一律拒绝
/// （空列表不等于“全部放行”）。
bool isAllowedRelay(String url, List<RelayEntry> list) {
  if (list.isEmpty) return false;
  final n = RelayEntry.normalize(url);
  if (n == null) return false;
  for (final entry in list) {
    final en = RelayEntry.normalize(entry.url);
    if (en == null) continue;
    if (n.origin == en.origin && n.pathname.startsWith(en.pathname)) {
      return true;
    }
  }
  return false;
}

/// 选路结果。
class PickRelayResult {
  const PickRelayResult({
    required this.relay,
    required this.tier,
    required this.reason,
    required this.degraded,
  });

  final RelayEntry? relay;
  final int tier;

  /// `primary` / `fallback-after-failure` /
  /// `tier-inflight-full` / `all-tiers-exhausted`。
  final String reason;
  final bool degraded;
}

/// 选路算法（与服务端 `pickRelay` 同款，§2.1）：候选按 tier 升序、
///
/// priority 降序、id 字典序；某级在途已满时跳过该级（不算失败，
/// 也不把它的 id 加入 failedIds）；无候选时 degraded:true。
PickRelayResult pickRelay(
  List<RelayEntry> list,
  Set<String> failedIds, {
  Map<int, int> inFlightByTier = const {},
  int maxInflightPerTier = 8,
}) {
  final sorted = list
      .where((e) => !failedIds.contains(e.id))
      .toList()
    ..sort(RelayEntry._compare);
  for (final entry in sorted) {
    final cur = inFlightByTier[entry.tier] ?? 0;
    if (cur >= maxInflightPerTier) continue;
    return PickRelayResult(
      relay: entry,
      tier: entry.tier,
      reason: failedIds.isEmpty ? 'primary' : 'fallback-after-failure',
      degraded: false,
    );
  }
  return PickRelayResult(
    relay: null,
    tier: 0,
    reason: sorted.isNotEmpty
        ? 'tier-inflight-full'
        : 'all-tiers-exhausted',
    degraded: true,
  );
}

/// 伪造中继拒绝后的客户端行为（§3）：拒绝拨号，不得向该地址发任何
/// 建连包；界面提示“该中继不在服务端宣告列表内，已拒绝连接”；记一条
/// 本地诊断日志（只记 URL 与时间，不记任何密钥/会话口令）；继续按
/// §2.2 选下一条列表内中继——伪造地址不得加入 failedIds（它不是
/// 可重试的普通失败），也不得保留它。
class ForgedRelayRejection {
  ForgedRelayRejection({required this.url, required this.at});

  final String url;
  final DateTime at;

  /// 界面提示（§3 第 2 条，一字口径）。
  String get userMessage => '该中继不在服务端宣告列表内，已拒绝连接';

  /// 本地诊断日志行：只记 URL 与时间，不记密钥/会话口令。
  String get logLine => 'relay-forged-rejected url=$url at=${at.toIso8601String()}';
}

/// 宣告列表传输接口（测试用假实现；生产实现见 [HttpRelayTransport]）。
abstract class RelayTransport {
  Future<List<RelayEntry>> fetchRelays();
}

class HttpRelayTransport implements RelayTransport {
  HttpRelayTransport({String? baseUrl, ConsoleCookieProvider? cookieProvider})
      : _baseUrl = baseUrl ?? kServerOrigin,
        _cookieProvider = cookieProvider;

  final String _baseUrl;

  /// 控制台会话 cookie（DevicePresenceClient 同款 cookie 桥）：
  /// `/license/api/*` 须控制台会话，未带有效 cookie 时服务端回 401；
  /// 不传时保持旧行为（不带 cookie），调用方须自行保证已登录。
  final ConsoleCookieProvider? _cookieProvider;

  @override
  Future<List<RelayEntry>> fetchRelays() async {
    final client = trustedHttpClient(
      connectionTimeout: const Duration(seconds: 15),
    );
    try {
      final uri = Uri.parse(_baseUrl).resolve('/license/api/relays');
      final req = await client.getUrl(uri).timeout(
            const Duration(seconds: 15),
          );
      final cookie = await _cookieProvider?.call();
      if (cookie != null && cookie.isNotEmpty) {
        req.headers.set(HttpHeaders.cookieHeader, cookie);
      }
      final res = await req.close().timeout(const Duration(seconds: 15));
      final text =
          await res.transform(utf8.decoder).join().timeout(
                const Duration(seconds: 15),
              );
      if (res.statusCode == 401 || res.statusCode == 403) {
        // 与“空列表”区分：401 是登录已死，不是“无可用中继”，
        // 调用方须按 UNAUTHORIZED 处理，不得误判为降级态。
        throw const RelayUnavailableException('UNAUTHORIZED');
      }
      if (res.statusCode == 503) {
        throw const RelayUnavailableException('L5_UNAVAILABLE');
      }
      final decoded = jsonDecode(text);
      if (decoded is! Map<String, Object?>) {
        throw const FormatException('relays 响应不是 JSON 对象');
      }
      final raw = decoded['relays'];
      if (raw is! List) return const [];
      return RelayEntry.parseAnnouncements(raw.cast<Object?>());
    } finally {
      client.close(force: true);
    }
  }
}

class RelayUnavailableException implements Exception {
  const RelayUnavailableException(this.code);
  final String code;
  @override
  String toString() => 'RelayUnavailableException($code)';
}

/// 会话建立流程（§2.2）＋降级态（§2.3）＋在途计数。
///
/// - 会话开始前先取列表；列表为空或请求失败 → 不建连，界面报错，
///   不得用硬编码地址兜底（[loadAnnouncements] 失败时 [list] 为空，
///   调用方须按此处理）；
/// - 失败的中继 id 进 failedIds，同一会话内不再试；
/// - 降级态：只保留已建会话＋文件暂存通道，不新开桌面会话；UI 须明确
///   显示降级态并提供“重试”入口（[retry] 清空 failedIds、重新取列表、
///   从头重走；不得无间隔自动循环重试）；
/// - 应用退后台后在途拨号须取消计数（[cancelInFlightOnBackground]），
///   不得泄漏计数导致后续全部跳过。
class RelaySessionController {
  RelaySessionController({required RelayTransport transport})
      : _transport = transport;

  final RelayTransport _transport;

  List<RelayEntry> _list = [];
  final Set<String> _failedIds = {};
  final Map<int, int> _inFlightByTier = {1: 0, 2: 0, 3: 0};

  List<RelayEntry> get list => List.unmodifiable(_list);
  Set<String> get failedIds => Set.unmodifiable(_failedIds);
  Map<int, int> get inFlightByTier => Map.unmodifiable(_inFlightByTier);

  /// 列表是否过期（issuedAt + ttlSec*1000）；过期后须重新取，
  /// 不得用过期列表建连（§1.2）。
  bool isListExpiredAt(int nowMs) {
    if (_list.isEmpty) return true;
    return _list.every((e) => e.isExpiredAt(nowMs));
  }

  Future<void> loadAnnouncements() async {
    _list = await _transport.fetchRelays();
  }

  /// 选下一条候选。返回 degraded:true 时进入降级态（§2.3）。
  PickRelayResult pickNext() =>
      pickRelay(_list, _failedIds, inFlightByTier: _inFlightByTier);

  /// 建连前必调白名单校验（§3）：不通过即视为该条不可用，加入
  /// failedIds 并选下一条，不得绕过校验直接拨号。
  bool checkAllowed(String dialUrl) => isAllowedRelay(dialUrl, _list);

  /// 伪造中继：拒绝拨号＋界面提示＋本地日志（§3）；不进 failedIds。
  ForgedRelayRejection rejectForged(String url) =>
      ForgedRelayRejection(url: url, at: DateTime.now());

  /// 拨号开始：该级在途计数 +1。调用方须在拨号结束（成功或失败）
  /// 后调 [finishDial] 减回。
  void beginDial(int tier) {
    _inFlightByTier[tier] = (_inFlightByTier[tier] ?? 0) + 1;
  }

  /// 拨号结束：计数 -1；失败时 id 进 failedIds 再选下一条；
  /// 成功时只减计数。
  void finishDial({required int tier, String? failedRelayId}) {
    final cur = _inFlightByTier[tier] ?? 0;
    _inFlightByTier[tier] = cur > 0 ? cur - 1 : 0;
    if (failedRelayId != null) _failedIds.add(failedRelayId);
  }

  /// 应用退后台：在途拨号取消计数，不得泄漏计数。
  void cancelInFlightOnBackground() {
    _inFlightByTier.updateAll((_, _) => 0);
  }

  /// 降级态“重试”入口：清空 failedIds、重新取宣告列表、从头重走。
  /// 调用方须由用户点“重试”触发，不得无间隔自动循环重试。
  Future<void> retry() async {
    _failedIds.clear();
    cancelInFlightOnBackground();
    await loadAnnouncements();
  }

  /// 降级态 UI 文案（§2.3）。
  static const String degradedMessage = '中继全部不可用，已保留现有会话';
}
