import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math' as math;

import '../../core/constants.dart';
import '../../services/probe.dart' show trustedHttpClient;

/// RC-04 安卓客户端重连——按 L1 服务端票据规范实现
/// （`server/ext/lea/RC-04-RECONNECT-TICKET-SPEC.md` 规范 v1，2026-11-15）。
/// 不发明票据格式；服务端签发／核验端点已落地
/// （`lea-routes.js` 的 `/api/lea/v1/reconnect/issue` 与 `/resume`），
/// [HttpReconnectTransport] 直接走真实端点；沙箱测试仍走可注入的
/// [ReconnectTransport] 假通道，真机端到端待 ECS 窗口复验。
///
/// 规范要点（§1/§2/§5）：
/// - 票据 10 字段 JSON（`qfr-lea-reconnect-v1`），TTL 300 秒，只认一次；
/// - `resume_id` = `resume-` + 16 位小写 hex；`session_id` 由客户端在首次
///   建立会话时生成（`sess-` + 16 位小写 hex）；
/// - 客户端在会话建立成功后立即申领一张票据存内存（滚动续领：300 秒过期
///   而会话仍在时凭仍在效的 Key 再领一张，旧票据作废）；
/// - 重试上限 5 次、固定 5 秒间隔（不做指数退避——退避会拖过 300 秒窗口）；
/// - 凭据／授权类失败立即停（§5.2 码表），只有纯网络错误才继续；
/// - 重连期间所有输入事件短路丢弃，不缓存、不补发；
/// - 票据明文只在签发响应里出现一次；客户端存内存，不得写进可同步的
///   配置文件、不得随诊断日志外发；日志只记 `resume_id` 前 8 位 hex 与
///   `api_key_id`。

/// 规范 §5.2 凭据／授权类失败码：命中任一即立即停止重试。
/// 其余失败（超时／连接拒绝／DNS 失败／服务端 502/503）是纯网络错误，才
/// 计入 5 次重试。
enum ReconnectErrorCode {
  apiKeyRevoked('QFR_API_KEY_REVOKED'),
  ticketReused('QFR_TICKET_REUSED'),
  ticketExpired('QFR_TICKET_EXPIRED'),
  bindingChanged('QFR_BINDING_CHANGED'),
  grantRevoked('QFR_GRANT_REVOKED'),
  scopeDenied('QFR_SCOPE_DENIED'),
  leaNotBound('QFR_LEA_NOT_BOUND'),
  ticketInvalid('QFR_TICKET_INVALID'),
  network('NETWORK');

  const ReconnectErrorCode(this.code);
  final String code;

  /// 是否凭据／授权类失败（立即停，不再重试）。
  bool get isCredentialFailure => this != network;

  static ReconnectErrorCode fromServerCode(String? code) {
    for (final c in ReconnectErrorCode.values) {
      if (c.code == code) return c;
    }
    return ReconnectErrorCode.network;
  }
}

/// 重连失败（带规范码，供界面显示失败原因与“重新登录”入口）。
class ReconnectFailure {
  final ReconnectErrorCode code;
  final String? detail;

  const ReconnectFailure(this.code, {this.detail});

  const ReconnectFailure.network([this.detail])
    : code = ReconnectErrorCode.network;

  bool get isCredentialFailure => code.isCredentialFailure;

  /// 界面文案：凭据类失败显示原因＋重新登录入口；网络错显示重试信息。
  String get displayText {
    switch (code) {
      case ReconnectErrorCode.apiKeyRevoked:
        return '授权已被吊销，请重新登录。';
      case ReconnectErrorCode.ticketReused:
        return '重连票据已被使用过，请重新登录。';
      case ReconnectErrorCode.ticketExpired:
        return '重连票据已过期（300 秒），请重新登录。';
      case ReconnectErrorCode.bindingChanged:
        return '设备已换绑，请重新登录。';
      case ReconnectErrorCode.grantRevoked:
        return '授权已被撤销，请重新登录。';
      case ReconnectErrorCode.scopeDenied:
        return '授权范围不足，请重新登录。';
      case ReconnectErrorCode.leaNotBound:
        return '设备未绑定，请重新登录。';
      case ReconnectErrorCode.ticketInvalid:
        return '重连票据无效，请重新登录。';
      case ReconnectErrorCode.network:
        return '网络不通，正在重连…';
    }
  }
}

/// 重连票据（规范 §1：10 字段，全部字段进签名，缺一不可）。
/// 客户端只做形状校验（未知字段拒绝、签名缺失拒绝、TTL 恰好 300、id 格式），
/// 签名验签在服务端做（§3.2）。
class ReconnectTicket {
  final String accountId;
  final String deviceId;
  final String apiKeyId;
  final int bindingEpoch;
  final int grantEpoch;
  final String resumeId;
  final String sessionId;
  final int issuedAt;
  final int expiresAt;
  final String ticketSignature;

  const ReconnectTicket({
    required this.accountId,
    required this.deviceId,
    required this.apiKeyId,
    required this.bindingEpoch,
    required this.grantEpoch,
    required this.resumeId,
    required this.sessionId,
    required this.issuedAt,
    required this.expiresAt,
    required this.ticketSignature,
  });

  /// 规范 TTL：300 秒（§2）。
  static const int ttlSeconds = 300;

  static const _knownFields = {
    'account_id',
    'device_id',
    'api_key_id',
    'binding_epoch',
    'grant_epoch',
    'resume_id',
    'session_id',
    'issued_at',
    'expires_at',
    'ticket_signature',
  };

  static final _resumeIdPattern = RegExp(r'^resume-[0-9a-f]{16}$');
  static final _sessionIdPattern = RegExp(r'^sess-[0-9a-f]{16}$');

  /// 是否过期（`now > expires_at` 即过期，§2）。
  bool get expired => DateTime.now().millisecondsSinceEpoch ~/ 1000 > expiresAt;

  /// 日志用标识：只记 `resume_id` 的 hex 段前 8 位与 `api_key_id`（§1.1），
  /// 永不记票据明文。`resume_id` 固定带 `resume-` 前缀，先剥离前缀再取
  /// 8 位 hex（F5：直接 substring(0, 8) 取到的是 `resume-`＋1 位 hex，
  /// 只有 16 种取值，无法定位问题）；无前缀的纯 hex 同样取前 8 位，
  /// 短于 8 位时取全部。
  String get logRef {
    final hex = resumeId.startsWith('resume-')
        ? resumeId.substring(7)
        : resumeId;
    final shown = hex.length > 8 ? hex.substring(0, 8) : hex;
    return 'resume=$shown key=$apiKeyId';
  }

  /// 严格解析：未知字段、缺字段、类型错、TTL 不等 300、id 格式错、
  /// 签名缺失、控制字符一律抛 [FormatException]（与信封 v2 同规则）。
  factory ReconnectTicket.fromJson(Map<String, Object?> json) {
    for (final key in json.keys) {
      if (!_knownFields.contains(key)) {
        throw FormatException('重连票据含未知字段：$key');
      }
    }
    String strField(String name) {
      final v = json[name];
      if (v is! String || v.isEmpty) {
        throw FormatException('重连票据字段 $name 缺失或类型错');
      }
      if (v.codeUnits.any((c) => c < 0x20 || c == 0x7F)) {
        throw FormatException('重连票据字段 $name 含控制字符');
      }
      return v;
    }

    int intField(String name) {
      final v = json[name];
      if (v is! int || v < 0 || v > 9007199254740991) {
        throw FormatException('重连票据字段 $name 须为安全整数');
      }
      return v;
    }

    final accountId = strField('account_id');
    final deviceId = strField('device_id');
    if (accountId.length > 127 || deviceId.length > 127) {
      throw const FormatException('重连票据 id 超长（1..127 字节）');
    }
    final ticket = ReconnectTicket(
      accountId: accountId,
      deviceId: deviceId,
      apiKeyId: strField('api_key_id'),
      bindingEpoch: intField('binding_epoch'),
      grantEpoch: intField('grant_epoch'),
      resumeId: strField('resume_id'),
      sessionId: strField('session_id'),
      issuedAt: intField('issued_at'),
      expiresAt: intField('expires_at'),
      ticketSignature: strField('ticket_signature'),
    );
    if (!_resumeIdPattern.hasMatch(ticket.resumeId)) {
      throw const FormatException('resume_id 格式错（resume- + 16 位 hex）');
    }
    if (!_sessionIdPattern.hasMatch(ticket.sessionId)) {
      throw const FormatException('session_id 格式错（sess- + 16 位 hex）');
    }
    if (ticket.expiresAt - ticket.issuedAt != ttlSeconds) {
      throw const FormatException('重连票据 TTL 必须恰好 300 秒');
    }
    return ticket;
  }

  Map<String, Object?> toJson() => {
    'account_id': accountId,
    'device_id': deviceId,
    'api_key_id': apiKeyId,
    'binding_epoch': bindingEpoch,
    'grant_epoch': grantEpoch,
    'resume_id': resumeId,
    'session_id': sessionId,
    'issued_at': issuedAt,
    'expires_at': expiresAt,
    'ticket_signature': ticketSignature,
  };

  /// 规范串（§1.2：10 行 `\n` 连接，行尾 LF、无结尾换行）。
  /// 客户端不验签，但按同一口径生成供测试与诊断比对。
  String get canonicalString => [
    'qfr-lea-reconnect-v1',
    accountId,
    deviceId,
    apiKeyId,
    bindingEpoch.toString(),
    grantEpoch.toString(),
    resumeId,
    sessionId,
    issuedAt.toString(),
    expiresAt.toString(),
  ].join('\n');
}

/// `session_id` 生成（规范 §1：客户端在首次建立会话时生成，
/// `sess-` + 16 位小写 hex）。
String generateSessionId([math.Random? random]) {
  final r = random ?? math.Random.secure();
  final hex = List.generate(
    16,
    (_) => '0123456789abcdef'[r.nextInt(16)],
  ).join();
  return 'sess-$hex';
}

/// 重连票据内存存储（规范 §1.1：客户端存内存，不得写进可同步的配置文件、
/// 不得随诊断日志外发）。
/// 同一 `session_id` 只留最新一张（滚动续领时旧票据作废，§5.1）。
abstract class ReconnectTicketStore {
  Future<void> save(ReconnectTicket ticket);
  Future<ReconnectTicket?> take(String sessionId);
  Future<void> invalidate(String sessionId);
}

class InMemoryReconnectTicketStore implements ReconnectTicketStore {
  final Map<String, ReconnectTicket> _tickets = {};

  @override
  Future<void> save(ReconnectTicket ticket) async {
    _tickets[ticket.sessionId] = ticket;
  }

  @override
  Future<ReconnectTicket?> take(String sessionId) async {
    final t = _tickets[sessionId];
    if (t == null || t.expired) {
      _tickets.remove(sessionId);
      return null;
    }
    return t;
  }

  /// 消费：单次性——resume 成功后调用，取走即作废（服务端同样只认一次）。
  Future<ReconnectTicket?> consume(String sessionId) async =>
      _tickets.remove(sessionId);

  @override
  Future<void> invalidate(String sessionId) async {
    _tickets.remove(sessionId);
  }
}

/// 客户端重连状态机（规范 §5.2，数字写死，不得自行放宽）。
class ReconnectPolicy {
  /// 重试上限 5 次（默认；不得无上限重试）。
  static const int maxAttempts = 5;

  /// 重试间隔：固定 5 秒（不做指数退避——退避会拖过票据 300 秒窗口）。
  static const Duration retryInterval = Duration(seconds: 5);

  int _attempts = 0;
  bool _cancelled = false;

  int get attempts => _attempts;
  bool get cancelled => _cancelled;

  /// 是否还可继续重试：未超 5 次、未取消、上次失败是纯网络错误。
  /// 凭据／授权类失败立即停（反复试错只会更快锁号／刷屏）。
  bool shouldRetry(ReconnectFailure lastFailure) {
    if (_cancelled) return false;
    if (lastFailure.isCredentialFailure) return false;
    return _attempts < maxAttempts;
  }

  /// 记录一次尝试（调用方在每次重试前调，含首次重连）。
  void recordAttempt() => _attempts++;

  void cancel() => _cancelled = true;

  /// 5 次耗尽后用户手动点“重试”才再来一轮（§5.2）。
  void reset() {
    _attempts = 0;
    _cancelled = false;
  }

  /// 界面文案：“正在重连（第 N 次 / 共 5 次）”＋取消按钮。
  String get statusText => '正在重连（第 $_attempts 次 / 共 $maxAttempts 次）';

  /// 重连期间输入事件是否短路丢弃：重试未结束前一律丢弃（不缓存、不补发）。
  bool get dropInput => _attempts > 0 && !isFinished;

  bool get isFinished => _cancelled || _attempts >= maxAttempts;
}

/// 票据端点传输接口（规范 §3.3；服务端实现是 §7 后续项，未落地前用假实现测）。
abstract class ReconnectTransport {
  /// `POST /api/lea/v1/reconnect/issue`（Bearer Key 鉴权；body
  /// `{ device_id, session_id }`；成功 200 返回票据 JSON 全文）。
  /// 控制台会话路径（第 2 轮 #4 接线）不带 Key：`bearerKey` 为空时不发
  /// Authorization 头，由传输实现改附控制台会话 cookie（服务端走
  /// consoleAuth 自动选该设备最新在用的 Key）。
  Future<ReconnectTicket> issueTicket({
    required String deviceId,
    required String sessionId,
    String bearerKey = '',
  });

  /// `POST /api/lea/v1/reconnect/resume`（body 为票据 JSON 全文，不走
  /// Bearer——票据本身就是 bearer；成功 200 返回
  /// `{ ok, session_id, device_id, binding_epoch, grant_epoch }`）。
  Future<ResumeResult> resume(ReconnectTicket ticket);
}

class ResumeResult {
  final String sessionId;
  final String deviceId;
  final int bindingEpoch;
  final int grantEpoch;

  const ResumeResult({
    required this.sessionId,
    required this.deviceId,
    required this.bindingEpoch,
    required this.grantEpoch,
  });

  /// 严格解析（F6）：四字段缺失或类型错一律抛 [FormatException]，
  /// 由传输层统一转 [ReconnectFailure]，不得让其他异常穿出 `reconnect()`。
  /// 不拒未知字段：服务端成功体含 `ok` 字段，不在四字段内。
  factory ResumeResult.fromJson(Map<String, Object?> json) {
    final sessionId = json['session_id'];
    final deviceId = json['device_id'];
    final bindingEpoch = json['binding_epoch'];
    final grantEpoch = json['grant_epoch'];
    if (sessionId is! String ||
        sessionId.isEmpty ||
        deviceId is! String ||
        deviceId.isEmpty ||
        bindingEpoch is! int ||
        grantEpoch is! int) {
      throw const FormatException('resume 响应字段缺失或类型错');
    }
    return ResumeResult(
      sessionId: sessionId,
      deviceId: deviceId,
      bindingEpoch: bindingEpoch,
      grantEpoch: grantEpoch,
    );
  }
}

/// 基于 `trustedHttpClient` 的默认传输（公共 CA 走系统默认校验，与
/// `probe.dart` 同口径；不发送 Key 明文之外的任何秘密）。
/// 第 2 轮 #4 接线：可选 [cookieHeader]（控制台会话 cookie 桥——生产
/// 调用方从 WebView CookieManager 取值后手动附头，与 LicenseClient 同
/// 口径；服务端 issue 端点无 Bearer 时走 consoleAuth 自动选 Key）。
/// 提供 cookie 时 issue 请求附 Cookie 头、不发 Authorization；resume
/// 请求不附 cookie（票据本身就是 bearer，服务端不看其他鉴权头）。
class HttpReconnectTransport implements ReconnectTransport {
  HttpReconnectTransport({String? baseUrl, this.cookieHeader})
    : _baseUrl = baseUrl ?? kServerOrigin;

  final String _baseUrl;
  final Future<String?> Function()? cookieHeader;

  Future<(int, Map<String, Object?>)> _post(
    String path, {
    required Map<String, Object?> body,
    String? bearer,
    bool withCookie = false,
  }) async {
    final client = trustedHttpClient(
      connectionTimeout: const Duration(seconds: 15),
    );
    try {
      final uri = Uri.parse(_baseUrl).resolve(path);
      final req = await client
          .postUrl(uri)
          .timeout(const Duration(seconds: 15));
      req.headers.contentType = ContentType.json;
      if (bearer != null && bearer.isNotEmpty) {
        req.headers.set(HttpHeaders.authorizationHeader, 'Bearer $bearer');
      }
      if (withCookie && cookieHeader != null) {
        final cookie = await cookieHeader!();
        if (cookie != null && cookie.isNotEmpty) {
          req.headers.set(HttpHeaders.cookieHeader, cookie);
        }
      }
      req.write(jsonEncode(body));
      final res = await req.close().timeout(const Duration(seconds: 15));
      final text = await res
          .transform(utf8.decoder)
          .join()
          .timeout(const Duration(seconds: 15));
      final decodedRaw = text.isEmpty ? null : jsonDecode(text);
      final decoded = decodedRaw is Map<String, Object?>
          ? decodedRaw
          : <String, Object?>{};
      return (res.statusCode, decoded);
    } finally {
      client.close(force: true);
    }
  }

  ReconnectFailure _failureFrom(int status, Map<String, Object?> body) {
    if (status == 502 || status == 503) {
      return ReconnectFailure.network('HTTP $status');
    }
    final code = ReconnectErrorCode.fromServerCode(
      body['error'] as String? ?? body['code'] as String?,
    );
    if (code == ReconnectErrorCode.network) {
      return ReconnectFailure.network('HTTP $status');
    }
    return ReconnectFailure(code);
  }

  @override
  Future<ReconnectTicket> issueTicket({
    required String deviceId,
    required String sessionId,
    String bearerKey = '',
  }) async {
    // S-039：照 resume 的 F6 口径包 try/catch，传输异常统一转
    // ReconnectFailure，不得以原始 Exception 穿出。
    try {
      final (status, body) = await _post(
        '/api/lea/v1/reconnect/issue',
        body: {'device_id': deviceId, 'session_id': sessionId},
        bearer: bearerKey,
        withCookie: true,
      );
      if (status >= 200 && status < 300) {
        return ReconnectTicket.fromJson(body);
      }
      throw _failureFrom(status, body);
    } on ReconnectFailure {
      rethrow;
    } on FormatException catch (e) {
      // 畸形 200（JSON 损坏／字段缺失类型错）统一转网络失败重试。
      throw ReconnectFailure.network('issue 响应畸形：$e');
    } on Exception catch (e) {
      // 传输层异常（连接失败／超时等）同样转网络失败。
      throw ReconnectFailure.network('issue 请求失败：$e');
    }
  }

  @override
  Future<ResumeResult> resume(ReconnectTicket ticket) async {
    try {
      final (status, body) = await _post(
        '/api/lea/v1/reconnect/resume',
        body: ticket.toJson(),
      );
      if (status >= 200 && status < 300) {
        return ResumeResult.fromJson(body);
      }
      throw _failureFrom(status, body);
    } on ReconnectFailure {
      rethrow;
    } on FormatException catch (e) {
      // F6：畸形 200（JSON 损坏／字段缺失类型错）统一转网络失败重试，
      // 不得穿出 reconnect()。
      throw ReconnectFailure.network('resume 响应畸形：$e');
    } on Exception catch (e) {
      // F6：传输层异常（连接失败／超时等）同样转网络失败。
      throw ReconnectFailure.network('resume 请求失败：$e');
    }
  }
}

/// 重连控制器（规范 §5 客户端恢复流程，两层）：
/// 协议层（票据申领／滚动续领／resume）＋客户端层（重试循环）。
/// 恢复成功后的步骤由钩子交调用方（main.dart 接线）：
/// 立即重做 RC-01 握手（新 `sys.handshake`）→ 查询原会话 UNKNOWN job 的
/// 状态（只查，不重执行）→ 清空已丢弃的输入队列 → Toast“已恢复连接”。
class ReconnectController {
  ReconnectController({
    required this.transport,
    required this.store,
    ReconnectPolicy? policy,
    this.onHandshakeRedo,
    this.onQueryUnknownJobs,
    this.onClearDiscardedInput,
    this.onRestored,
    this.onCredentialFailure,
    this.onAttempt,
  }) : policy = policy ?? ReconnectPolicy();

  final ReconnectTransport transport;
  final ReconnectTicketStore store;
  final ReconnectPolicy policy;
  final Future<void> Function(ResumeResult result)? onHandshakeRedo;
  final Future<void> Function(String sessionId)? onQueryUnknownJobs;
  final void Function()? onClearDiscardedInput;
  final void Function()? onRestored;
  final void Function(ReconnectFailure failure)? onCredentialFailure;

  /// 每次重试发起时回调（第 2 轮 #4 接线：生产浮层显示
  /// “正在重连（第 N 次 / 共 5 次）”用；参数为本次尝试序号）。
  final void Function(int attempt)? onAttempt;

  /// 会话建立成功后立即申领一张票据存内存（§5.1）。
  /// 控制台会话路径不带 Key：`bearerKey` 为空时传输层改附会话 cookie。
  Future<ReconnectTicket> issueOnSessionStart({
    required String deviceId,
    required String sessionId,
    String bearerKey = '',
  }) async {
    final ticket = await transport.issueTicket(
      deviceId: deviceId,
      sessionId: sessionId,
      bearerKey: bearerKey,
    );
    await store.save(ticket);
    return ticket;
  }

  /// 票据过期（300 秒）而会话仍在时滚动续领（§5.1）：凭仍在效的 Key 再领
  /// 一张；同 `session_id` 的旧票据作废（store 只留最新）。
  Future<ReconnectTicket?> rollTicketIfNeeded({
    required String deviceId,
    required String sessionId,
    String bearerKey = '',
  }) async {
    final current = await store.take(sessionId);
    if (current != null) return current;
    return issueOnSessionStart(
      deviceId: deviceId,
      sessionId: sessionId,
      bearerKey: bearerKey,
    );
  }

  /// 掉线后重连一轮（§5.2）：最多 5 次、固定 5 秒间隔；凭据类失败 1 次即停。
  /// 返回 true＝恢复成功；false＝本轮结束未恢复（调用方按失败原因显示
  /// 界面；5 次耗尽时给用户手动“重试”按钮，点后调 [retryManually]）。
  Future<bool> reconnect(String sessionId) async {
    policy.reset();
    while (true) {
      final ticket = await store.take(sessionId);
      if (ticket == null) {
        // 无票据（过期／未申领）：走完整登录恢复，本轮不再试。
        onCredentialFailure?.call(
          const ReconnectFailure(ReconnectErrorCode.ticketExpired),
        );
        return false;
      }
      policy.recordAttempt();
      onAttempt?.call(policy.attempts);
      final ResumeResult result;
      try {
        result = await transport.resume(ticket);
      } on ReconnectFailure catch (f) {
        if (f.isCredentialFailure) {
          onCredentialFailure?.call(f);
          return false;
        }
        if (!policy.shouldRetry(f)) return false;
        await Future<void>.delayed(ReconnectPolicy.retryInterval);
        continue;
      } on Exception catch (e) {
        // F6：传输层漏出的非 ReconnectFailure 异常统一转网络失败，
        // 不得穿出 reconnect()；按纯网络错误走重试循环。
        final f = ReconnectFailure.network('resume 失败：$e');
        if (!policy.shouldRetry(f)) return false;
        await Future<void>.delayed(ReconnectPolicy.retryInterval);
        continue;
      }
      // F6：比对响应与票据（session_id／device_id／binding_epoch／
      // grant_epoch）；不一致拒绝且不消费票据（票据仍可走完整登录恢复，
      // 服务端单次性以服务端台账为准，重试时票据已消费会报 TICKET_REUSED）。
      if (result.sessionId != ticket.sessionId ||
          result.deviceId != ticket.deviceId ||
          result.bindingEpoch != ticket.bindingEpoch ||
          result.grantEpoch != ticket.grantEpoch) {
        onCredentialFailure?.call(
          const ReconnectFailure(
            ReconnectErrorCode.ticketInvalid,
            detail: 'resume 响应与票据不一致',
          ),
        );
        return false;
      }
      // 单次性：resume 成功即消费本地票据。
      if (store is InMemoryReconnectTicketStore) {
        await (store as InMemoryReconnectTicketStore).consume(sessionId);
      } else {
        await store.invalidate(sessionId);
      }
      await onHandshakeRedo?.call(result);
      await onQueryUnknownJobs?.call(sessionId);
      onClearDiscardedInput?.call();
      onRestored?.call();
      return true;
    }
  }

  /// 5 次耗尽后用户手动点“重试”再来一轮（§5.2）。
  Future<bool> retryManually(String sessionId) => reconnect(sessionId);
}
