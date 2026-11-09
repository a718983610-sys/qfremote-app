import 'dart:async';
import 'dart:io';

import '../core/client_header.dart';
import '../core/constants.dart';

/// 原生 HTTP 客户端（2.4.5 B3）：公共 CA 证书走系统默认校验——
///
/// 不再设 badCertificateCallback（2.4.4 的回调对自家主机放行一切证书
/// 错误：自签/过期/错 CN 全 PROCEED，与「公共 CA」口径直接矛盾）。
/// 系统校验失败时请求直接抛错，调用方按失败处理；证书被拒时 WebView
/// 侧出证书异常卡（见 main.dart _showCertError）。
/// 不发送任何凭据，完整性另有 SHA256 兜底（更新）与状态码判定（探活）。
HttpClient trustedHttpClient({Duration? connectionTimeout, int port = kServerPort}) {
  final client = HttpClient();
  if (connectionTimeout != null) client.connectionTimeout = connectionTimeout;
  return client;
}

class ProbeResult {
  final bool ok;
  final DateTime at;
  final int elapsedMs;
  final int? statusCode;
  final String? error;

  const ProbeResult({
    required this.ok,
    required this.at,
    required this.elapsedMs,
    this.statusCode,
    this.error,
  });

  String describe() {
    final t = '${at.hour.toString().padLeft(2, '0')}:'
        '${at.minute.toString().padLeft(2, '0')}:'
        '${at.second.toString().padLeft(2, '0')}';
    if (ok) return '服务器可达（HTTP $statusCode，$t，用时 $elapsedMs 毫秒）';
    if (statusCode != null && statusCode! >= 500) {
      return '服务器异常（HTTP $statusCode，$t）';
    }
    return '服务器不可达（$t${error != null ? '，$error' : ''}）';
  }
}

/// 服务器探活：向自家服务器发一次不带凭据的 HTTPS GET。
/// 2.4.5 B4：只有 2xx/3xx 才算可达——500 也亮绿灯的「探活假绿」已修；
/// 非 2xx/3xx 时 ok=false 且带上状态码（调用方连续 2 次失败可进离线）。
/// B24：版本头取调用方注入的包版本，未注入回落 kAppVersion。
Future<ProbeResult> probeServer({
  Duration timeout = const Duration(seconds: 6),
  String? clientVersion,
}) async {
  final sw = Stopwatch()..start();
  final client = trustedHttpClient(connectionTimeout: timeout);
  try {
    final req = await client.getUrl(Uri.parse(kServerOrigin)).timeout(timeout);
    applyClientVersionHeader(req, version: clientVersion);
    final res = await req.close().timeout(timeout);
    await res.drain<void>().timeout(timeout);
    sw.stop();
    final ok = res.statusCode >= 200 && res.statusCode < 400;
    return ProbeResult(
      ok: ok,
      at: DateTime.now(),
      elapsedMs: sw.elapsedMilliseconds,
      statusCode: res.statusCode,
      error: ok ? null : 'HTTP ${res.statusCode}',
    );
  } catch (e) {
    sw.stop();
    return ProbeResult(
      ok: false,
      at: DateTime.now(),
      elapsedMs: sw.elapsedMilliseconds,
      error: e.toString(),
    );
  } finally {
    client.close(force: true);
  }
}
