import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'session_response.dart';
import 'session_history.dart';
import '../../core/constants.dart';
import '../../services/points.dart' show ConsoleCookieProvider;
import '../../services/probe.dart' show trustedHttpClient;

/// 录像下载大小上限：与文件单文件上限同值 200MB（系统内唯一已定稿的
/// 单文件上限；服务端录像体积无单独上限，10 分钟录像沙箱实测约 4.3MB）。
class RecordingConstants {
  static const int defaultMaxDownloadBytes = 200 * 1024 * 1024;
}

/// RC-10 录像事件流客户端（QF-REC-1 规范 v1）。
///
/// 录像文件是 `.qfrec`（JSONL 事件流，不是视频）＋`.qfrec.idx`
/// （seek 索引）＋`.meta.json`（元数据）。不做 mp4 转码。
///
/// 出入（§6，以实现为准）：
/// 1. ~~`/event` 与 `/end` 路由没有按用户鉴权~~已修复（2026-11-15）：服务端
///    路由现已调 `canAccess`，无权限时返回 HTTP 404（不泄露存在性）。
///    客户端不得利用旧缺口；自定义 sessionId 不得用可猜的值（本文件
///    默认不传 sessionId，让服务端生成 `rec_`＋16 位 hex）。
/// 2. 录制会话只存在于服务端内存：服务端重启后内存丢失，此后
///    /event / /end 返回 NOT_FOUND（磁盘上的 .qfrec 文件还在，但
///    续不上）。客户端收到 NOT_FOUND 后不得静默丢事件——提示
///    “录制已中断（服务端重启），本次录像不完整”，并重新 start
///    一个新录制（新 sessionId）。
/// 3. 下载大小受 [RecordingConstants.defaultMaxDownloadBytes] 限制。
/// 4. 录制 ID 只使用 start 响应，不复用桌面会话 ID。
/// 5. 事件实际捕获埋点（mcrec.js 钩子）未实现——客户端按本规范发
///    事件即进入“协议就绪、捕获待落地”状态，**不得宣称已实现
///    真机录像**。真机录像体积比（沙箱 43.2x）是模拟值，不是真机值。
///
/// 另：`session_recording.dart` 的旧回放授权 helper
/// （曾允许“站长（isAdmin）打开他人录像”）已于 2026-11-15 按 C-04
/// 裁决删除；录像访问判定唯一入口是本文件的 [canAccessRecording]
/// （只认本人，空 owner 拒绝，fail-closed），与本规范 §4.1
/// “站长无直通”一致。
enum RecEventType { input, clipboard, frameMarker, qualityChange }

extension RecEventTypeWire on RecEventType {
  String get wire {
    switch (this) {
      case RecEventType.input:
        return 'input';
      case RecEventType.clipboard:
        return 'clipboard';
      case RecEventType.frameMarker:
        return 'frame-marker';
      case RecEventType.qualityChange:
        return 'quality-change';
    }
  }
}

/// 录像事件（§1.1 白名单字段，只许这些字段）。
///
/// - input：kind 为 mouse/key/touch（非法值按 mouse 计）；x/y 为数字
///   坐标（缺省为 0）；key 仅限按键名（如 Enter，截断至 32 字符），
///   **只记按键名，不记密码等输入内容**；
/// - clipboard：**只记字节数（bytes），绝不记剪贴板内容**——本类型
///   没有 content 字段，调用方传不进来内容；
/// - frame-marker：frameId / isKeyframe；
/// - quality-change：from / to 各截断至 32 字符。
/// session-start / session-end 由服务端写，客户端不得发——
/// [toJson] 没有这两个类型，[RecEvent] 也构造不出来。
class RecEvent {
  const RecEvent.input({
    required this.at,
    required this.kind,
    this.x = 0,
    this.y = 0,
    this.key,
  }) : type = RecEventType.input,
       bytes = null,
       frameId = null,
       isKeyframe = null,
       from = null,
       to = null;

  const RecEvent.clipboard({required this.at, required this.bytes})
    : type = RecEventType.clipboard,
      kind = null,
      x = null,
      y = null,
      key = null,
      frameId = null,
      isKeyframe = null,
      from = null,
      to = null;

  const RecEvent.frameMarker({
    required this.at,
    required this.frameId,
    required this.isKeyframe,
  }) : type = RecEventType.frameMarker,
       kind = null,
       x = null,
       y = null,
       key = null,
       bytes = null,
       from = null,
       to = null;

  const RecEvent.qualityChange({
    required this.at,
    required this.from,
    required this.to,
  }) : type = RecEventType.qualityChange,
       kind = null,
       x = null,
       y = null,
       key = null,
       bytes = null,
       frameId = null,
       isKeyframe = null;

  final RecEventType type;

  /// 毫秒 epoch；客户端缺省时服务端填当前时间。
  final int at;
  final String? kind;
  final num? x;
  final num? y;
  final String? key;
  final int? bytes;
  final int? frameId;
  final bool? isKeyframe;
  final String? from;
  final String? to;

  /// 服务端 `sanitizeEvent` 同款清洗：非法 kind 按 mouse 计；
  /// x/y 缺省为 0；key 截断 32 字符；from/to 各截断 32 字符。
  Map<String, Object?> toJson() {
    final base = <String, Object?>{'type': type.wire, 'at': at};
    switch (type) {
      case RecEventType.input:
        final k = kind;
        base['kind'] = (k == 'mouse' || k == 'key' || k == 'touch')
            ? k
            : 'mouse';
        base['x'] = x ?? 0;
        base['y'] = y ?? 0;
        if (key != null) {
          base['key'] = key!.length > 32 ? key!.substring(0, 32) : key!;
        }
      case RecEventType.clipboard:
        base['bytes'] = bytes == null || bytes! < 0 ? 0 : bytes;
      case RecEventType.frameMarker:
        base['frameId'] = frameId ?? 0;
        base['isKeyframe'] = isKeyframe ?? false;
      case RecEventType.qualityChange:
        base['from'] = _truncate32(from);
        base['to'] = _truncate32(to);
    }
    return base;
  }

  static String _truncate32(String? s) {
    if (s == null) return '';
    return s.length > 32 ? s.substring(0, 32) : s;
  }
}

/// seek 索引锚点（§3.2）：每当事件 at 距上一个锚点 ≥10s 追加一个
/// `{ t, byteOffset }`；byteOffset 是该时刻点的字节偏移。
class RecSeekAnchor {
  const RecSeekAnchor({required this.t, required this.byteOffset});

  final int t;
  final int byteOffset;

  factory RecSeekAnchor.fromJson(Map<String, Object?> json) => RecSeekAnchor(
    t: json['t'] as int? ?? 0,
    byteOffset: json['byteOffset'] as int? ?? 0,
  );
}

/// seek：取 `t ≤ T` 的最后一个锚点，从该偏移处开始往后读事件、
/// 快进重放到 T。重建索引（rebuilt:true）把第一个事件也当锚点，
/// 正常写入的第一个锚点要等满 10s 才出现——两种索引都只依赖锚点
/// 单调，不依赖首锚点位置（§3.2）。
RecSeekAnchor? seekAnchor(List<RecSeekAnchor> index, int targetMs) {
  RecSeekAnchor? best;
  for (final anchor in index) {
    if (anchor.t <= targetMs) {
      best = anchor;
    } else {
      break;
    }
  }
  return best;
}

/// 录像条目（§2.4 list）。
class RecordingEntry {
  const RecordingEntry({
    required this.sessionId,
    required this.deviceId,
    required this.tier,
    required this.startedAtMs,
    required this.bytes,
  });

  final String sessionId;
  final String deviceId;
  final String tier;
  final int startedAtMs;
  final int bytes;

  /// 保留期默认 30 天（retentionDays）；到期时刻。
  int get expiresAtMs => startedAtMs + 30 * 24 * 60 * 60 * 1000;

  bool get isExpired => DateTime.now().millisecondsSinceEpoch >= expiresAtMs;

  factory RecordingEntry.fromJson(Map<String, Object?> json) => RecordingEntry(
    sessionId: json['sessionId'] as String? ?? '',
    deviceId: json['deviceId'] as String? ?? '',
    tier: json['tier'] as String? ?? 'balanced',
    startedAtMs: json['startedAt'] as int? ?? 0,
    bytes: json['bytes'] as int? ?? 0,
  );
}

/// 录制策略判定（§3.1，服务端在 start 时判定；客户端只做本地预判，
/// 不得在策略关时本地“先录着”再上传）：
/// off 默认不录；user 须 users 含该 username；group 须 groups 含
/// 该 groupId；device 须 devices 含该 deviceId；mode 非法值回退 off。
bool shouldRecordLocally({
  required String mode,
  required String username,
  required String groupId,
  required String deviceId,
  List<String> users = const [],
  List<String> groups = const [],
  List<String> devices = const [],
}) {
  switch (mode) {
    case 'user':
      return users.contains(username);
    case 'group':
      return groups.contains(groupId);
    case 'device':
      return devices.contains(deviceId);
    default:
      return false; // off 或非法值 → 不录
  }
}

/// 访问控制（§4.1/§4.2）：录像按账号隔离，list 只返回本人的；
/// index / download 只许本人（meta.username 与当前控制台用户一致）。
/// **站长无直通**——站长侧查看须走既有审核/授权流程，本模块不给
/// 站长开后门。404 时 UI 显示“录像不存在或无权限查看”，不得反复
/// 重试、不得提示“对方有录像但你看不了”（不泄露存在性）。
bool canAccessRecording({
  required String ownerUsername,
  required String requesterUsername,
}) => ownerUsername.isNotEmpty && ownerUsername == requesterUsername;

const String recordingNotFoundMessage = '录像不存在或无权限查看';

const String recordingInterruptedMessage = '录制已中断（服务端重启），本次录像不完整';

/// 录像传输接口（测试用假实现；生产实现见 [HttpRecordingTransport]）。
abstract class RecordingTransport {
  /// start：成功返回 sessionId；策略未开启返回 POLICY_OFF。
  /// 不传 sessionId 时服务端生成 `rec_`＋16 位 hex（推荐）。
  Future<({String? sessionId, String? code, String? message})> start({
    required String sessionIdForDesktop,
    required String deviceId,
    required String groupId,
    required String tier,
  });

  /// event：成功返回累计事件数；会话不存在返回 NOT_FOUND。
  Future<({int? events, String? code})> postEvent({
    required String sessionId,
    required RecEvent event,
  });

  Future<({int? events, int? bytes, List<RecSeekAnchor>? index, String? code})>
  end({required String sessionId});

  Future<List<RecordingEntry>> list();

  Future<({List<RecSeekAnchor>? index, bool rebuilt, String? code})> readIndex({
    required String sessionId,
  });

  /// download：整文件下载，不支持 Range（§2.6）。
  Future<Uint8List?> download({required String sessionId});
}

class RecordingApiException implements Exception {
  const RecordingApiException(this.code, [this.message = '']);
  final String code;
  final String message;
  @override
  String toString() => 'RecordingApiException($code)';
}

class HttpRecordingTransport implements RecordingTransport {
  HttpRecordingTransport({
    String? baseUrl,
    ConsoleCookieProvider? cookieProvider,
    int? maxDownloadBytes,
  }) : _baseUrl = baseUrl ?? kServerOrigin,
       _cookieProvider = cookieProvider,
       _maxDownloadBytes =
           maxDownloadBytes ?? RecordingConstants.defaultMaxDownloadBytes;

  final String _baseUrl;
  static const _timeout = Duration(seconds: 15);

  /// 控制台会话 cookie（DevicePresenceClient 同款 cookie 桥）：
  /// `/license/api/*` 须控制台会话，未带有效 cookie 时服务端回 401；
  /// 不传时保持旧行为（不带 cookie），调用方须自行保证已登录。
  final ConsoleCookieProvider? _cookieProvider;

  /// 下载大小上限（默认 200MB；O1：下载前不得无上限读体）。
  final int _maxDownloadBytes;

  Future<void> _attachCookie(HttpClientRequest req) async {
    final cookie = await _cookieProvider?.call();
    if (cookie != null && cookie.isNotEmpty) {
      req.headers.set(HttpHeaders.cookieHeader, cookie);
    }
  }

  Future<Map<String, Object?>> _postJson(
    String path,
    Map<String, Object?> body,
  ) async {
    final client = trustedHttpClient(connectionTimeout: _timeout);
    try {
      final uri = Uri.parse(_baseUrl).resolve(path);
      final req = await client.postUrl(uri).timeout(_timeout);
      req.headers.contentType = ContentType.json;
      await _attachCookie(req);
      req.write(jsonEncode(body));
      final res = await req.close().timeout(_timeout);
      final text = await res.transform(utf8.decoder).join().timeout(_timeout);
      return decodeSessionResponse(
        res.statusCode,
        text,
        (code, message) => RecordingApiException(code, message),
      );
    } on FormatException {
      throw const RecordingApiException('INVALID_RESPONSE');
    } on TypeError {
      throw const RecordingApiException('INVALID_RESPONSE');
    } on TimeoutException {
      throw const RecordingApiException('TIMEOUT');
    } on IOException {
      throw const RecordingApiException('NETWORK');
    } finally {
      client.close(force: true);
    }
  }

  Future<(Map<String, Object?>, int)> _getRaw(String path) async {
    final client = trustedHttpClient(connectionTimeout: _timeout);
    try {
      final uri = Uri.parse(_baseUrl).resolve(path);
      final req = await client.getUrl(uri).timeout(_timeout);
      await _attachCookie(req);
      final res = await req.close().timeout(_timeout);
      final text = await res.transform(utf8.decoder).join().timeout(_timeout);
      if (res.statusCode == 401 || res.statusCode == 403) {
        throw const RecordingApiException('UNAUTHORIZED');
      }
      if (res.statusCode == 404) return (<String, Object?>{}, 404);
      final decoded = decodeSessionResponse(
        res.statusCode,
        text,
        (code, message) => RecordingApiException(code, message),
      );
      return (decoded, res.statusCode);
    } on FormatException {
      throw const RecordingApiException('INVALID_RESPONSE');
    } on TypeError {
      throw const RecordingApiException('INVALID_RESPONSE');
    } on TimeoutException {
      throw const RecordingApiException('TIMEOUT');
    } on IOException {
      throw const RecordingApiException('NETWORK');
    } finally {
      client.close(force: true);
    }
  }

  @override
  Future<({String? sessionId, String? code, String? message})> start({
    required String sessionIdForDesktop,
    required String deviceId,
    required String groupId,
    required String tier,
  }) async {
    // 录制 ID 由服务端随机生成；桌面会话 ID 不用作可猜的存储标识。
    final json = await _postJson('/license/api/recordings/start', {
      'deviceId': deviceId,
      'groupId': groupId,
      'tier': tier,
    });
    if (json['ok'] == true) {
      return (
        sessionId: json['sessionId'] as String?,
        code: null,
        message: null,
      );
    }
    return (
      sessionId: null,
      code: json['code'] as String?,
      message: json['msg'] as String?,
    );
  }

  @override
  Future<({int? events, String? code})> postEvent({
    required String sessionId,
    required RecEvent event,
  }) async {
    final json = await _postJson('/license/api/recordings/$sessionId/event', {
      'event': event.toJson(),
    });
    if (json['ok'] == true) {
      return (events: json['events'] as int?, code: null);
    }
    return (events: null, code: json['code'] as String?);
  }

  @override
  Future<({int? events, int? bytes, List<RecSeekAnchor>? index, String? code})>
  end({required String sessionId}) async {
    final json = await _postJson('/license/api/recordings/$sessionId/end', {});
    if (json['ok'] == true) {
      final raw = json['index'];
      final index = raw is List
          ? raw
                .whereType<Map<String, Object?>>()
                .map(RecSeekAnchor.fromJson)
                .toList()
          : null;
      return (
        events: json['events'] as int?,
        bytes: json['bytes'] as int?,
        index: index,
        code: null,
      );
    }
    return (
      events: null,
      bytes: null,
      index: null,
      code: json['code'] as String?,
    );
  }

  @override
  Future<List<RecordingEntry>> list() async {
    final (json, _) = await _getRaw('/license/api/recordings');
    final raw = json['recordings'];
    if (raw is! List) return const [];
    return raw
        .whereType<Map<String, Object?>>()
        .map(RecordingEntry.fromJson)
        .toList();
  }

  @override
  Future<({List<RecSeekAnchor>? index, bool rebuilt, String? code})> readIndex({
    required String sessionId,
  }) async {
    final (json, status) = await _getRaw(
      '/license/api/recordings/$sessionId/index',
    );
    if (status == 404) {
      return (index: null, rebuilt: false, code: 'NOT_FOUND');
    }
    final inner = json['index'];
    if (inner is! Map<String, Object?>) {
      return (index: null, rebuilt: false, code: 'NOT_FOUND');
    }
    final raw = inner['index'];
    final index = raw is List
        ? raw
              .whereType<Map<String, Object?>>()
              .map(RecSeekAnchor.fromJson)
              .toList()
        : null;
    return (
      index: index,
      rebuilt: inner['rebuilt'] as bool? ?? false,
      code: null,
    );
  }

  @override
  Future<Uint8List?> download({required String sessionId}) async {
    final client = trustedHttpClient(connectionTimeout: _timeout);
    try {
      final uri = Uri.parse(_baseUrl)
          .resolve('/license/api/recordings/$sessionId/download');
      final req = await client.getUrl(uri).timeout(_timeout);
      await _attachCookie(req);
      final res = await req.close().timeout(_timeout);
      // O1：先校验状态码再读体；404 仍按“不存在或无权限”返回 null
      // （§4.2 不泄露存在性）；其余非 200 不得当作录像字节返回。
      if (res.statusCode == 404) return null;
      if (res.statusCode == 401 || res.statusCode == 403) {
        throw const RecordingApiException('UNAUTHORIZED');
      }
      if (res.statusCode == 503) {
        throw const RecordingApiException('L5_UNAVAILABLE');
      }
      if (res.statusCode != 200) {
        throw RecordingApiException('HTTP_${res.statusCode}');
      }
      return await _readCappedBody(res);
    } on FormatException {
      throw const RecordingApiException('INVALID_RESPONSE');
    } on TypeError {
      throw const RecordingApiException('INVALID_RESPONSE');
    } on TimeoutException {
      throw const RecordingApiException('TIMEOUT');
    } on IOException {
      throw const RecordingApiException('NETWORK');
    } finally {
      client.close(force: true);
    }
  }

  /// 流式读体并执行大小上限（O1，口径同 HttpStreamTransport）。
  Future<Uint8List> _readCappedBody(HttpClientResponse res) async {
    final contentLength = res.contentLength;
    if (contentLength >= 0 && contentLength > _maxDownloadBytes) {
      throw const RecordingApiException('TOO_LARGE');
    }
    final builder = BytesBuilder();
    var total = 0;
    await for (final chunk in res.timeout(_timeout)) {
      total += chunk.length;
      if (total > _maxDownloadBytes) {
        throw const RecordingApiException('TOO_LARGE');
      }
      builder.add(chunk);
    }
    return builder.takeBytes();
  }
}

/// 录制控制与事件上报编排（§2/§7 安卓一节）。
///
/// - 会话开始时按策略调 start（POLICY_OFF 时不录制、不发事件，
///   UI 提示“当前会话不录制”）；
/// - 事件实时发；批量发时须保持 at 单调递增，不得倒序补发旧事件
///   （索引锚点依赖 at 单调）——本类在本地强制单调，倒序事件直接
///   丢弃并记诊断日志，不发往服务端；
/// - 应用退后台时录制事件暂停上报、恢复后按 at 续发，不得倒序补发
///   （[pauseForBackground] / [resumeFromBackground]）；
/// - end 时取索引；NOT_FOUND（服务端重启）时提示中断并重新 start
///   一个新录制（新 sessionId），见 [handleNotFound]。
class RecordingSessionClient {
  RecordingSessionClient({required RecordingTransport transport})
    : _transport = transport;

  final RecordingTransport _transport;

  String? sessionId;
  bool get isRecording => sessionId != null && !_paused;
  bool _paused = false;
  bool get pausedForBackground => _paused;

  int eventCount = 0;
  int? _lastAtMs;
  final List<String> diagnosticLog = [];

  /// 开始录制。策略未开启（POLICY_OFF）时返回 false，不录制、不发事件。
  Future<bool> start({
    required String sessionIdForDesktop,
    required String deviceId,
    required String groupId,
    required String tier,
  }) async {
    final result = await _transport.start(
      sessionIdForDesktop: sessionIdForDesktop,
      deviceId: deviceId,
      groupId: groupId,
      tier: tier,
    );
    if (result.sessionId == null) {
      appendSessionHistory(
        diagnosticLog,
        'recording-start-rejected: ${result.code ?? 'UNKNOWN'}',
      );
      return false;
    }
    sessionId = result.sessionId;
    eventCount = 0;
    _lastAtMs = null;
    _paused = false;
    return true;
  }

  /// 发一个事件。未录制/后台暂停时丢弃（不攒）；at 倒序时丢弃
  /// （不得倒序补发旧事件）；NOT_FOUND 时返回 false 并置
  /// [interrupted]（调用方按 §6.2 提示中断并重开新录制）。
  bool interrupted = false;

  Future<bool> postEvent(RecEvent event) async {
    final id = sessionId;
    if (id == null || _paused) return false;
    if (_lastAtMs != null && event.at < _lastAtMs!) {
      appendSessionHistory(
        diagnosticLog,
        'recording-event-out-of-order-dropped: at=${event.at}',
      );
      return false;
    }
    final result = await _transport.postEvent(sessionId: id, event: event);
    if (result.code == 'NOT_FOUND') {
      interrupted = true;
      return false;
    }
    if (result.code != null) {
      appendSessionHistory(
        diagnosticLog,
        'recording-event-rejected: ${result.code}',
      );
      return false;
    }
    _lastAtMs = event.at;
    eventCount = result.events ?? eventCount + 1;
    return true;
  }

  void pauseForBackground() {
    _paused = true;
  }

  void resumeFromBackground() {
    _paused = false;
  }

  /// 服务端重启导致 NOT_FOUND 后的处理：提示中断，本次录像不完整，
  /// 重新 start 一个新录制（新 sessionId）。返回新录制的 sessionId，
  /// 失败返回 null。
  Future<String?> handleNotFoundAndRestart({
    required String sessionIdForDesktop,
    required String deviceId,
    required String groupId,
    required String tier,
  }) async {
    sessionId = null;
    interrupted = false;
    _lastAtMs = null;
    eventCount = 0;
    final ok = await start(
      sessionIdForDesktop: sessionIdForDesktop,
      deviceId: deviceId,
      groupId: groupId,
      tier: tier,
    );
    return ok ? sessionId : null;
  }

  Future<({int? events, int? bytes, List<RecSeekAnchor>? index})?> end() async {
    final id = sessionId;
    if (id == null) return null;
    // Stop sending immediately; an ambiguous end result must not leave a live
    // local recording that continues to post to a possibly closed server ID.
    sessionId = null;
    _paused = true;
    final result = await _transport.end(sessionId: id);
    if (result.code != null) return null;
    return (events: result.events, bytes: result.bytes, index: result.index);
  }
}

/// 回放器：按事件 at 时间戳顺序重放（§5）。
///
/// - 加载：先调 index 取索引，再调 download 整文件下载 .qfrec
///   （不支持 Range，须整文件下载后本地 seek，不得发 Range 请求）；
/// - 播放：input 还原鼠标/按键光标位置、frame-marker 锚点对齐关键帧
///   位置、quality-change 显示档位变化标记；重放的是事件流
///   （光标轨迹＋档位标记），不是视频画面；
/// - seek：用索引锚点跳到目标时刻（取 t ≤ T 的最后锚点，从
///   byteOffset 起往后读事件、快进重放到 T）；seek 须在 10s 粒度内
///   准确，不得逐行从头扫到目标时刻——[seekEvents] 从锚点偏移起读；
/// - 变速：0.5x / 1x / 2x，按 at 差值缩放播放间隔
///   （[scaledIntervalMs]）；
/// - 边下边播：下载未完成时可用已下载部分的事件先播（按已下载字节
///   边界切行，不得播半行——[parseCompleteLines] 只返回完整行）；
/// - 隐私提示：回放含按键/剪贴板元数据，播放页须提示
///   “本录像含操作记录”，不得提供“导出剪贴板内容”功能
///   （内容本来就没记）。
class RecPlayback {
  /// 解析已下载字节中的完整 JSONL 行（末尾半行不返回，留待后续字节补齐）。
  static List<Map<String, Object?>> parseCompleteLines(
    Uint8List downloadedBytes,
  ) {
    final text = utf8.decode(downloadedBytes, allowMalformed: true);
    final lines = text.split('\n');
    // 最后一个分段可能是半行（下载未完成时），丢弃。
    final complete = lines.sublist(0, lines.length - 1);
    final out = <Map<String, Object?>>[];
    for (final line in complete) {
      if (line.trim().isEmpty) continue;
      try {
        final decoded = jsonDecode(line);
        if (decoded is Map<String, Object?>) out.add(decoded);
      } catch (_) {
        // 坏行跳过，不阻断回放。
      }
    }
    return out;
  }

  /// 从锚点偏移起往后读事件、快进重放到目标时刻 T。
  static List<Map<String, Object?>> seekEvents(
    Uint8List fileBytes,
    List<RecSeekAnchor> index,
    int targetMs,
  ) {
    final anchor = seekAnchor(index, targetMs);
    final startOffset = anchor?.byteOffset ?? 0;
    if (startOffset >= fileBytes.length) return const [];
    final slice = fileBytes.sublist(startOffset);
    final events = parseCompleteLines(Uint8List.fromList([...slice, 10]));
    return events.where((e) {
      final at = e['at'];
      return at is int && at <= targetMs;
    }).toList();
  }

  /// 变速播放间隔：按 at 差值缩放（0.5x / 1x / 2x）。
  static int scaledIntervalMs(int atDeltaMs, double speed) {
    if (speed <= 0) return atDeltaMs;
    return (atDeltaMs / speed).round();
  }

  static const String privacyNotice = '本录像含操作记录';
}
