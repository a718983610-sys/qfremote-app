import 'dart:convert';
import 'dart:io';

import '../core/license.dart';
import '../core/svc_urls.dart';
import 'points.dart' show ConsoleCookieProvider;

/// 许可服务客户端（2.3.1 阶段 D；契约 v231/license-api-contract.md §3/§7.5）。
///
/// 鉴权口径与 ExtService 相同：扩展服务认控制台会话 cookie，壳从 WebView
/// CookieManager 取到后手动附头（cookie 桥）。领取的无会话入口例外：体里带
/// 账号＋密码只核验不签发登录态（§7.5.3），故该请求不附 cookie。
/// 所有请求失败一律返回 null——调用方必须落诚实错误态，不许拿假数据冒充
/// 许可状态（无网/接口失败≠未激活）。
class LicenseClient {
  final ConsoleCookieProvider cookieProvider;
  final SvcUrls urls;

  LicenseClient({required this.cookieProvider, SvcUrls? urls})
      : urls = urls ?? SvcUrls.instance;

  /// 发一次请求取回 (状态码, 响应体)；[withCookie]=false 时不附会话
  /// （领取无会话入口专用）。任何异常返回 null。
  Future<(int, String)?> _send(
    String method,
    String url, {
    Map<String, dynamic>? jsonBody,
    bool withCookie = true,
  }) async {
    String? cookie;
    if (withCookie) {
      cookie = await cookieProvider();
      if (cookie == null || cookie.isEmpty) return null;
    }
    HttpClient? client;
    try {
      client = HttpClient();
      client.connectionTimeout = const Duration(seconds: 8);
      final uri = Uri.parse(url);
      final req = method == 'POST'
          ? await client.postUrl(uri).timeout(const Duration(seconds: 8))
          : await client.getUrl(uri).timeout(const Duration(seconds: 8));
      if (cookie != null) req.headers.set(HttpHeaders.cookieHeader, cookie);
      req.headers.set(HttpHeaders.acceptHeader, 'application/json');
      if (jsonBody != null) {
        req.headers.contentType = ContentType.json;
        req.write(jsonEncode(jsonBody));
      }
      final res = await req.close().timeout(const Duration(seconds: 8));
      final body = await res
          .transform(utf8.decoder)
          .join()
          .timeout(const Duration(seconds: 8));
      return (res.statusCode, body);
    } catch (_) {
      return null;
    } finally {
      client?.close(force: true);
    }
  }

  /// 会话建立后立即上报设备码（契约 §3 写死时机，先于任何设备连接动作）。
  Future<DeviceReportResult?> deviceReport(String deviceCode) async {
    final r = await _send('POST', '${urls.licenseApiBase}/api/device-report',
        jsonBody: {'deviceCode': deviceCode, 'platform': 'mobile'});
    if (r == null || r.$1 != 200) return null;
    return DeviceReportResult.tryParse(r.$2);
  }

  /// 本人许可概览（付费与激活区 + 门裁决 + forceLogout 信号）。
  Future<LicenseMe?> fetchLicenseMe() async {
    final r = await _send('GET', '${urls.licenseApiBase}/api/me');
    if (r == null || r.$1 != 200) return null;
    return LicenseMe.tryParse(r.$2);
  }

  /// 绑定密钥到本机手机槽（契约 §3 bind；结果文案一律用服务端正式提示）。
  Future<LicenseOpResult?> bindKey(String key, String deviceCode) async {
    final r = await _send('POST', '${urls.licenseApiBase}/api/bind',
        jsonBody: {
          'key': key.trim(),
          'deviceCode': deviceCode,
          'platform': 'mobile',
        });
    if (r == null) return null;
    return LicenseOpResult.tryParse(r.$2);
  }

  /// 粘贴领取转赠密钥（契约 §7.5.3 唯一领取端点）。
  /// 已有控制台会话时走已登录入口（只带 key）；无会话时带账号＋密码核验
  /// （凭据只在本次请求体里，不落盘、不签发登录态）。
  Future<LicenseOpResult?> claimKey(
    String key, {
    String? username,
    String? password,
  }) async {
    final hasCreds = username != null &&
        username.isNotEmpty &&
        password != null &&
        password.isNotEmpty;
    final r = hasCreds
        ? await _send('POST', '${urls.licenseApiBase}/api/transfer/claim',
            jsonBody: {'username': username, 'password': password, 'key': key.trim()},
            withCookie: false)
        : await _send('POST', '${urls.licenseApiBase}/api/transfer/claim',
            jsonBody: {'key': key.trim()});
    if (r == null) return null;
    return LicenseOpResult.tryParse(r.$2);
  }
}
