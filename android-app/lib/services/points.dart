import 'dart:convert';
import 'dart:io';

import '../core/svc_urls.dart';

/// 积分信息（扩展服务 /points 的 /api/me 返回）。
class PointsInfo {
  /// 服务器给的时长文案（如「1年02天」口径的 displayText），缺失为 null。
  final String? displayText;

  /// 积分（服务器按总时长折算），缺失为 null。
  final int? points;

  /// 账号名（「我的」页个人卡用），缺失为 null。
  final String? user;

  /// 已用天数（「我的」页统计卡用），缺失为 null。
  final int? daysUsed;

  const PointsInfo({
    required this.displayText,
    required this.points,
    this.user,
    this.daysUsed,
  });

  /// 纯解析（供自测）：字段缺失/类型不对一律给 null，调用方显示「—」。
  static PointsInfo parse(String body) {
    final root = jsonDecode(body);
    if (root is! Map<String, dynamic>) {
      throw const FormatException('积分信息格式不正确');
    }
    final dt = root['displayText'];
    final p = root['points'];
    final u = root['user'];
    final d = root['daysUsed'];
    return PointsInfo(
      displayText: dt is String && dt.isNotEmpty ? dt : null,
      points: p is int ? p : (p is num ? p.toInt() : null),
      user: u is String && u.isNotEmpty ? u : null,
      daysUsed: d is int ? d : (d is num ? d.toInt() : null),
    );
  }
}

/// 取控制台会话 cookie 的函数（由主页注入：从 WebView 的 CookieManager 取值）。
typedef ConsoleCookieProvider = Future<String?> Function();

/// 扩展服务客户端（积分心跳/查询＋站长判定＋管理令牌换发）。
///
/// 鉴权口径：扩展服务认控制台会话 cookie——本端从 WebView 的 CookieManager
/// 取到控制台 cookie 值后，手动附到请求头里（浏览器同源策略之外的人工桥）。
/// 所有请求失败一律安静返回（心跳丢一拍无所谓、关于页显示「—」、管理入口保持隐藏）。
class ExtService {
  final ConsoleCookieProvider cookieProvider;
  final SvcUrls urls;

  ExtService({required this.cookieProvider, SvcUrls? urls})
      : urls = urls ?? SvcUrls.instance;

  /// 发一次带 cookie 的请求并取回 (状态码, 响应体)；任何异常返回 null。
  Future<(int, String)?> _send(
    String method,
    String url, {
    Map<String, dynamic>? jsonBody,
  }) async {
    final cookie = await cookieProvider();
    if (cookie == null || cookie.isEmpty) return null;
    HttpClient? client;
    try {
      client = HttpClient();
      client.connectionTimeout = const Duration(seconds: 8);
      final uri = Uri.parse(url);
      final req = method == 'POST'
          ? await client.postUrl(uri).timeout(const Duration(seconds: 8))
          : await client.getUrl(uri).timeout(const Duration(seconds: 8));
      req.headers.set(HttpHeaders.cookieHeader, cookie);
      req.headers.set(HttpHeaders.acceptHeader, 'application/json');
      if (jsonBody != null) {
        req.headers.contentType = ContentType.json;
        req.write(jsonEncode(jsonBody));
      }
      final res = await req.close().timeout(const Duration(seconds: 8));
      final body =
          await res.transform(utf8.decoder).join().timeout(const Duration(seconds: 8));
      return (res.statusCode, body);
    } catch (_) {
      return null;
    } finally {
      client?.close(force: true);
    }
  }

  /// 积分心跳：App 在前台且控制台已登录时由主页每 60 秒调一次。
  Future<bool> heartbeat() async {
    final r = await _send('POST', '${urls.pointsApiBase}/api/heartbeat',
        jsonBody: {'client': 'android'});
    return r != null && r.$1 == 200;
  }

  /// 心跳＋强制下线信号（2.3.1 契约 §7.5.7）：心跳响应顶层带
  /// forceLogout:true＋gateCode 时，壳须立即登出本机会话并落拦截态。
  /// 返回 null＝本拍没打通（安静跳过，不当作任何许可结论）。
  Future<({bool forceLogout, String? gateCode})?> heartbeatSignal() async {
    final r = await _send('POST', '${urls.pointsApiBase}/api/heartbeat',
        jsonBody: {'client': 'android'});
    if (r == null || r.$1 != 200) return null;
    try {
      final root = jsonDecode(r.$2);
      if (root is Map<String, dynamic>) {
        final gc = root['gateCode'];
        return (
          forceLogout: root['forceLogout'] == true,
          gateCode: gc is String && gc.isNotEmpty ? gc : null,
        );
      }
    } catch (_) {
      // 响应不是 JSON：只当心跳成功，不解读信号
    }
    return (forceLogout: false, gateCode: null);
  }

  /// 我的积分/使用时长：取不到返回 null（关于页显示「—」）。
  Future<PointsInfo?> fetchMe() async {
    final r = await _send('GET', '${urls.pointsApiBase}/api/me');
    if (r == null || r.$1 != 200) return null;
    try {
      return PointsInfo.parse(r.$2);
    } catch (_) {
      return null;
    }
  }

  /// 站长判定：先 /api/me 拿到身份，再探 /admin/api/users——
  /// 只有站长能拿到 200，其余（未登录/普通用户/服务未上线）一律不是。
  Future<bool> checkIsAdmin() async {
    final me = await _send('GET', '${urls.pointsApiBase}/api/me');
    if (me == null || me.$1 != 200) return false;
    final users = await _send('GET', '${urls.adminApiBase}/api/users');
    return users != null && users.$1 == 200;
  }

  /// 管理令牌换发：用控制台会话换一次性令牌，失败返回 null。
  Future<String?> fetchSsoToken() async {
    final r = await _send('POST', urls.ssoTokenUrl, jsonBody: {'client': 'android'});
    if (r == null || r.$1 != 200) return null;
    try {
      final root = jsonDecode(r.$2);
      if (root is Map<String, dynamic>) {
        final t = root['token'];
        if (t is String && t.isNotEmpty) return t;
      }
    } catch (_) {
      // 落到返回 null
    }
    return null;
  }
}
