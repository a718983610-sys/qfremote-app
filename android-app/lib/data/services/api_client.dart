import 'dart:async';
import 'dart:convert';
import 'dart:io';

import '../db/app_database.dart';
import '../../core/constants.dart';
import '../../services/probe.dart' show trustedHttpClient;

/// A-06：网络层可整体重建（Signal `NetworkDependenciesModule` 模式）。
///
/// 换节点、换接入域名、换证书配置时，调用 [rebuild] 把整个网络层丢弃重建，
/// 而不是打补丁——根治“换了配置还连旧地址”一类顽疾。
/// 401 全局单飞登出：并发请求同时 401 时只触发一次登出回调（Invoice Ninja
/// v2 `api_client.dart` 的 `_logoutFuture` 单飞模式）。
class QfApiClient {
  QfApiClient({
    required String baseUrl,
    this.onUnauthorized,
    HttpClient Function()? clientFactory,
  }) : _baseUrl = baseUrl,
       _clientFactory = clientFactory ?? trustedHttpClient {
    _http = _clientFactory();
  }

  String _baseUrl;
  late HttpClient _http;
  final HttpClient Function() _clientFactory;

  /// 401 单飞登出回调（由 Services 层接线到登出流程）。
  final Future<void> Function()? onUnauthorized;

  Future<void>? _logoutFuture;

  String get baseUrl => _baseUrl;

  HttpClient _client() {
    // HttpClient 关闭后不可复用：每次重建都换新实例。
    return _clientFactory();
  }

  /// 整体重建：丢弃旧 HttpClient（含旧连接池/DNS 缓存），换新 baseUrl。
  /// 旧实例正在跑的请求会收到关闭错误，调用方按网络错重试（outbox 语义）。
  void rebuild({String? baseUrl}) {
    if (baseUrl != null && baseUrl.isNotEmpty) _baseUrl = baseUrl;
    try {
      _http.close(force: true);
    } catch (_) {}
    _http = _client();
  }

  /// 发一个 JSON GET，返回解码后的 Map。401/403 时触发单飞登出并抛
  /// [UnauthorizedException]；其余非 2xx 抛 [ApiException]；非 JSON
  /// 对象响应抛 [ApiException]。与 [postJson] 同一套状态码口径
  /// （第 2 轮 #2：设备列表取数走 GET /home/api/stats）。
  Future<Map<String, Object?>> getJson(
    String path, {
    Map<String, String>? headers,
    Duration timeout = const Duration(seconds: 15),
  }) async {
    final client = _http;
    final uri = Uri.parse(_baseUrl).resolve(path);
    final req = await client.getUrl(uri).timeout(timeout);
    headers?.forEach(req.headers.set);
    final res = await req.close().timeout(timeout);
    final text = await res.transform(utf8.decoder).join().timeout(timeout);
    if (res.statusCode == 401 || res.statusCode == 403) {
      unawaited(_logoutOnce());
      throw UnauthorizedException(res.statusCode);
    }
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw ApiException(res.statusCode, text);
    }
    final decoded = jsonDecode(text);
    if (decoded is! Map<String, Object?>) {
      throw const ApiException(0, '响应不是 JSON 对象');
    }
    return decoded;
  }

  /// 发一个 JSON POST，返回解码后的 Map。401 时触发单飞登出并抛
  /// [UnauthorizedException]；其余非 2xx 抛 [ApiException]。
  Future<Map<String, Object?>> postJson(
    String path,
    Map<String, Object?> body, {
    Map<String, String>? headers,
    Duration timeout = const Duration(seconds: 15),
  }) async {
    final client = _http;
    final uri = Uri.parse(_baseUrl).resolve(path);
    final req = await client.postUrl(uri).timeout(timeout);
    req.headers.contentType = ContentType.json;
    headers?.forEach(req.headers.set);
    req.write(jsonEncode(body));
    final res = await req.close().timeout(timeout);
    final text = await res.transform(utf8.decoder).join().timeout(timeout);
    if (res.statusCode == 401 || res.statusCode == 403) {
      unawaited(_logoutOnce());
      throw UnauthorizedException(res.statusCode);
    }
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw ApiException(res.statusCode, text);
    }
    final decoded = jsonDecode(text);
    if (decoded is! Map<String, Object?>) {
      throw const ApiException(0, '响应不是 JSON 对象');
    }
    return decoded;
  }

  Future<void> _logoutOnce() {
    final cb = onUnauthorized;
    if (cb == null) return Future<void>.value();
    return _logoutFuture ??= cb().whenComplete(() => _logoutFuture = null);
  }

  void dispose() {
    try {
      _http.close(force: true);
    } catch (_) {}
  }
}

class ApiException implements Exception {
  final int statusCode;
  final String body;
  const ApiException(this.statusCode, this.body);
  @override
  String toString() => 'ApiException($statusCode)';
}

class UnauthorizedException implements Exception {
  final int statusCode;
  const UnauthorizedException(this.statusCode);
  @override
  String toString() => 'UnauthorizedException($statusCode)';
}

/// 发件箱上行通道：把一条 outbox 条目发给服务端。
/// 实现由 Services 层提供（走 [QfApiClient]）；测试用假实现。
abstract class OutboxTransport {
  Future<OutboxResult> send(OutboxEntry entry);
}

enum OutboxResultKind {
  success,
  unprocessable, // 422：直接死信
  conflict, // 409：冲突解决表
  reauthRequired, // 412：密码确认表
  networkError,
  serverError,
}

class OutboxResult {
  final OutboxResultKind kind;

  /// 服务端回的正式 ID（离线新建 tmp ID 时用，触发 id_remap）。
  final String? realId;

  const OutboxResult(this.kind, {this.realId});
  const OutboxResult.success({this.realId}) : kind = OutboxResultKind.success;
  const OutboxResult.unprocessable()
    : kind = OutboxResultKind.unprocessable,
      realId = null;
  const OutboxResult.conflict()
    : kind = OutboxResultKind.conflict,
      realId = null;
  const OutboxResult.reauthRequired()
    : kind = OutboxResultKind.reauthRequired,
      realId = null;
  const OutboxResult.networkError()
    : kind = OutboxResultKind.networkError,
      realId = null;
  const OutboxResult.serverError()
    : kind = OutboxResultKind.serverError,
      realId = null;

  /// 按 HTTP 状态码映射（SyncRepository 的判定口径唯一出处）。
  factory OutboxResult.fromStatus(int status, {String? realId}) {
    if (status >= 200 && status < 300) {
      return OutboxResult.success(realId: realId);
    }
    if (status == 422) return const OutboxResult.unprocessable();
    if (status == 409) return const OutboxResult.conflict();
    if (status == 412) return const OutboxResult.reauthRequired();
    if (status >= 500) return const OutboxResult.serverError();
    return const OutboxResult.networkError();
  }
}

/// 基于 [QfApiClient] 的默认发件箱通道：默认端点 `/api/outbox`。
/// 服务端协议待 L1/L5 规范确认前，本通道只做“按状态码映射结果”的纯逻辑；
/// 端点与载荷字段以规范到达后为准，见 `docs/RC-ANDROID-NOTES.md`。
class HttpOutboxTransport implements OutboxTransport {
  HttpOutboxTransport(this._api, {this.path = '/api/outbox'});

  final QfApiClient _api;
  final String path;

  @override
  Future<OutboxResult> send(OutboxEntry entry) async {
    try {
      final res = await _api.postJson(path, {
        'entityKind': entry.entityKind,
        'entityId': entry.entityId,
        'op': entry.op,
        'payload': jsonDecode(entry.payloadJson),
        'idempotencyKey': entry.idempotencyKey,
      });
      final realId = res['realId'] as String?;
      return OutboxResult.success(realId: realId);
    } on UnauthorizedException {
      return const OutboxResult.reauthRequired();
    } on ApiException catch (e) {
      return OutboxResult.fromStatus(e.statusCode);
    } catch (_) {
      return const OutboxResult.networkError();
    }
  }
}

/// 默认 baseUrl：生产服务 origin（与 constants 的写死兜底同源）。
String defaultApiBaseUrl() => kServerOrigin;
