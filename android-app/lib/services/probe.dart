import 'dart:async';
import 'dart:io';

import '../core/client_header.dart';
import '../core/constants.dart';

/// 造一个「只对自家主机放行自签证书」的 HttpClient：
/// 证书回调逐个核对主机+端口，其余一律拒绝。
/// 用于探活与更新（清单/安装包）——与 Windows 版同一信任口径；
/// 不发送任何凭据，完整性另有 SHA256 兜底（更新）与状态码判定（探活）。
HttpClient trustedHttpClient({Duration? connectionTimeout, int port = kServerPort}) {
  final trustedPort = port;
  final client = HttpClient();
  if (connectionTimeout != null) client.connectionTimeout = connectionTimeout;
  client.badCertificateCallback = (cert, host, cbPort) =>
      host == kServerHost && cbPort == trustedPort;
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
    return '服务器不可达（$t${error != null ? '，$error' : ''}）';
  }
}

/// 服务器探活：向自家服务器发一次不带凭据的 HTTPS GET，
/// 拿到任何状态码就算可达（与 Windows 版探活同口径：
/// 探活只量连通性，不参与 WebView 的信任决策）。
Future<ProbeResult> probeServer({Duration timeout = const Duration(seconds: 6)}) async {
  final sw = Stopwatch()..start();
  final client = trustedHttpClient(connectionTimeout: timeout);
  try {
    final req = await client.getUrl(Uri.parse(kServerOrigin)).timeout(timeout);
    applyClientVersionHeader(req);
    final res = await req.close().timeout(timeout);
    await res.drain<void>().timeout(timeout);
    sw.stop();
    return ProbeResult(
      ok: true,
      at: DateTime.now(),
      elapsedMs: sw.elapsedMilliseconds,
      statusCode: res.statusCode,
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
