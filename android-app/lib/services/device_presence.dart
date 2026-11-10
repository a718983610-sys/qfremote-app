import 'dart:async';
import 'dart:convert';
import 'dart:io';

import '../core/client_header.dart';
import '../core/constants.dart';
import '../core/session_stage.dart';
import '../core/svc_urls.dart';
import 'points.dart' show ConsoleCookieProvider;
import 'probe.dart' show trustedHttpClient;

/// 设备预检与会话快照校验（2.4.5，A5/A7/A9）——原生 HTTP 层。
///
/// 预检接口（网页/服务端线实现，契约已定）：
/// `GET /api/device/presence?nodeid=<裸 nodeid>`，8 秒超时，
/// 出参 {ok, code, nodeid, name, online, fresh, lastAgentPong,
/// lastAgentPongAgeMs, serverTime}，code 为 ONLINE/STALE/OFFLINE/
/// NOT_FOUND/TIMEOUT/UNKNOWN。
/// QF-07（3.0.0 中组）：服务端明确说登录已过期（401/403），与网络不通
/// 不是一回事——调用方须弹「登录已过期」而不是「设备离线」。
class AuthExpiredException implements Exception {
  final int statusCode;
  const AuthExpiredException(this.statusCode);
  @override
  String toString() => 'AuthExpiredException(HTTP $statusCode)';
}

class DevicePresenceClient {
  final ConsoleCookieProvider cookieProvider;
  final Duration timeout;

  DevicePresenceClient({
    required this.cookieProvider,
    this.timeout = const Duration(seconds: 8),
  });

  /// 打开会话前预检：失败（offline/timeout）时调用方不挂 iframe，
  /// 直接弹原生卡（见 session_stage.classifyPreflight）。
  /// 返回 null＝接口本身没在 8 秒内给可信结论（按 PREFLIGHT_TIMEOUT 计）。
  /// QF-07：401/403 不再吞成 null，改抛 [AuthExpiredException]，调用方
  /// 按「登录已过期」出卡；其他非 200 与异常仍返回 null（网络不通）。
  Future<DevicePresence?> fetchPresence(String nodeid) async {
    final cookie = await cookieProvider();
    final client = trustedHttpClient(connectionTimeout: timeout);
    try {
      final uri = Uri.parse(
          '$kServerOrigin/api/device/presence?nodeid=${Uri.encodeQueryComponent(bareNodeId(nodeid))}');
      final req = await client.getUrl(uri).timeout(timeout);
      applyClientVersionHeader(req);
      if (cookie != null && cookie.isNotEmpty) {
        req.headers.set(HttpHeaders.cookieHeader, cookie);
      }
      req.headers.set(HttpHeaders.acceptHeader, 'application/json');
      final res = await req.close().timeout(timeout);
      if (res.statusCode == 401 || res.statusCode == 403) {
        throw AuthExpiredException(res.statusCode);
      }
      if (res.statusCode != 200) return null;
      final body = await res.transform(utf8.decoder).join().timeout(timeout);
      return DevicePresence.parse(body);
    } catch (e) {
      if (e is AuthExpiredException) rethrow;
      return null;
    } finally {
      client.close(force: true);
    }
  }
}

/// 会话快照校验结果（A7）：恢复链先验快照，死了就跳过 6 秒等待。
enum SnapshotCheck { alive, authDead, unreachable }

/// 验快照：带快照 cookie 调一次轻量接口（许可 /api/me，8 秒超时）。
/// 401/403＝快照已死（服务端已撤销/过期），直接走凭据登录；
/// 200＝快照还活着，才塞 cookie + reload；其他/异常＝unreachable，
/// 按旧口径走一次快照恢复（不断网时不误判）。
Future<SnapshotCheck> verifySnapshotAlive(
  String cookieHeader, {
  Duration timeout = const Duration(seconds: 8),
}) async {
  final client = trustedHttpClient(connectionTimeout: timeout);
  try {
    final req = await client
        .getUrl(Uri.parse('${SvcUrls.instance.licenseApiBase}/api/me'))
        .timeout(timeout);
    applyClientVersionHeader(req);
    req.headers.set(HttpHeaders.cookieHeader, cookieHeader);
    req.headers.set(HttpHeaders.acceptHeader, 'application/json');
    final res = await req.close().timeout(timeout);
    await res.drain<void>().timeout(timeout);
    if (res.statusCode == 200) return SnapshotCheck.alive;
    if (res.statusCode == 401 || res.statusCode == 403) {
      return SnapshotCheck.authDead;
    }
    return SnapshotCheck.unreachable;
  } catch (_) {
    return SnapshotCheck.unreachable;
  } finally {
    client.close(force: true);
  }
}
