import 'dart:convert';
import 'dart:io';

import '../core/client_header.dart';

/// 论坛免登桥（2.3.0 追加·单次登录硬门）。
///
/// 论坛服务只认自家会话 cookie `qfr_frm`。服务端现已提供控制台会话互认
/// （POST /api/forum/sso-token：凭控制台 cookie 换一次性令牌；GET
/// /api/forum/sso-login?token=…：种下 qfr_frm 后 302 回 /forum），Windows
/// 壳已接入。本桥打开论坛的顺序：先查既有会话 → 无会话时先走 sso-token
/// 令牌交接（不依赖本机存密码，只勾「记住此设备」的用户同样免登）→
/// 令牌失败才回落旧凭据桥（用已存账号密码调 /api/forum/login 换 qfr_frm）。
/// 两路都失败不做任何事，论坛页自行要求登录。手动退出论坛后服务端
/// ssoSuppressed 会拒绝令牌（401），不会把人自动带回。
class ForumSso {
  final HttpClient Function() _clientFactory;

  ForumSso({HttpClient Function()? clientFactory})
      : _clientFactory = clientFactory ?? (() => HttpClient());

  /// 查论坛当前会话用户：已登录返回用户名，未登录/失败返回 null。
  Future<String?> me(Uri forumOrigin, String cookieHeader) async {
    final client = _clientFactory();
    try {
      client.connectionTimeout = const Duration(seconds: 8);
      final req = await client
          .getUrl(forumOrigin.resolve('/api/forum/me'))
          .timeout(const Duration(seconds: 8));
      applyClientVersionHeader(req);
      if (cookieHeader.isNotEmpty) {
        req.headers.set(HttpHeaders.cookieHeader, cookieHeader);
      }
      final resp = await req.close().timeout(const Duration(seconds: 8));
      final body = await utf8.decoder.bind(resp).join();
      if (resp.statusCode != 200) return null;
      return parseForumMeUser(body);
    } catch (_) {
      return null;
    } finally {
      client.close(force: true);
    }
  }

  /// 凭控制台会话 cookie 换论坛一次性令牌（POST /api/forum/sso-token）：
  /// 成功返回 token（60 秒、单次使用），失败/被手动退出抑制返回 null。
  /// 调用方拿到 token 后应让 WebView 加载 ssoLoginUrl，由服务端在 302
  /// 响应里种下 qfr_frm（与 Windows 壳 loadForumView 同一交接方式）。
  Future<String?> ssoToken(Uri forumOrigin, String cookieHeader) async {
    final client = _clientFactory();
    try {
      client.connectionTimeout = const Duration(seconds: 8);
      final req = await client
          .postUrl(forumOrigin.resolve('/api/forum/sso-token'))
          .timeout(const Duration(seconds: 8));
      applyClientVersionHeader(req);
      if (cookieHeader.isNotEmpty) {
        req.headers.set(HttpHeaders.cookieHeader, cookieHeader);
      }
      req.headers.contentType = ContentType.json;
      req.write('{}');
      final resp = await req.close().timeout(const Duration(seconds: 8));
      final body = await utf8.decoder.bind(resp).join();
      if (resp.statusCode != 200) return null;
      final data = jsonDecode(body);
      if (data is! Map || data['ok'] != true) return null;
      final t = data['token'];
      return (t is String && t.isNotEmpty) ? t : null;
    } catch (_) {
      return null;
    } finally {
      client.close(force: true);
    }
  }

  /// 令牌交接地址：WebView 加载后服务端种 qfr_frm 并 302 回 /forum。
  String ssoLoginUrl(Uri forumOrigin, String token) =>
      forumOrigin
          .resolve('/api/forum/sso-login?token=${Uri.encodeQueryComponent(token)}')
          .toString();

  /// 用账号密码换论坛会话：成功返回 qfr_frm 的值，失败返回 null。
  /// remember=true：论坛会话 30 天（与控制台「记住此设备」同口径）。
  Future<String?> login(Uri forumOrigin, String username, String password) async {
    final client = _clientFactory();
    try {
      client.connectionTimeout = const Duration(seconds: 8);
      final req = await client
          .postUrl(forumOrigin.resolve('/api/forum/login'))
          .timeout(const Duration(seconds: 8));
      applyClientVersionHeader(req);
      req.headers.contentType = ContentType.json;
      req.write(jsonEncode({
        'username': username,
        'password': password,
        'remember': true,
      }));
      final resp = await req.close().timeout(const Duration(seconds: 8));
      final body = await utf8.decoder.bind(resp).join();
      if (resp.statusCode != 200) return null;
      try {
        final data = jsonDecode(body);
        if (data is! Map || data['ok'] != true) return null;
      } catch (_) {
        return null;
      }
      final cookies = resp.headers['set-cookie'] ?? const <String>[];
      return extractSetCookieValue(cookies, 'qfr_frm');
    } catch (_) {
      return null;
    } finally {
      client.close(force: true);
    }
  }
}

/// 解析 /api/forum/me 的响应体：取出 user（未登录为 null/缺失 → 返回 null）。
String? parseForumMeUser(String body) {
  try {
    final data = jsonDecode(body);
    if (data is Map && data['user'] is String) {
      final u = (data['user'] as String).trim();
      return u.isEmpty ? null : u;
    }
  } catch (_) {
    // 非 JSON 按未登录处理
  }
  return null;
}

/// 从一组 Set-Cookie 头里取指定 cookie 的值（取第一段 name=value）。
String? extractSetCookieValue(List<String> setCookieHeaders, String name) {
  for (final header in setCookieHeaders) {
    for (final part in header.split(',')) {
      final seg = part.trim();
      if (seg.startsWith('$name=')) {
        var value = seg.substring(name.length + 1);
        final semi = value.indexOf(';');
        if (semi >= 0) value = value.substring(0, semi);
        value = value.trim();
        return value.isEmpty ? null : value;
      }
    }
  }
  return null;
}
