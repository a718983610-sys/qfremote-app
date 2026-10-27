import 'dart:convert';
import 'dart:io';

import '../core/client_header.dart';

/// 论坛免登桥（2.3.0 追加·单次登录硬门）。
///
/// 现状（2026-10-25 服务器本地实测）：论坛服务没有控制台会话（xid）互认，
/// 只认自家会话 cookie `qfr_frm`；只带 xid 请求 /api/forum/me 返回 user=null。
/// 本桥在打开论坛前先查会话：没有会话且本机存有「记住账号密码」的凭据时，
/// 用凭据调论坛登录接口换回 qfr_frm，由主页写入 WebView cookie 后再打开
/// 论坛页，用户无感、不再二次输密码。没有已存凭据时不做任何事（论坛页
/// 自行要求登录）——真正的 xid 互认需服务端补端点，已列入依赖清单。
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
