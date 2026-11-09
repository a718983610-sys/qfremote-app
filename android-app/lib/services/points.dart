import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import '../core/client_header.dart';
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

/// 统一档案（扩展服务 /profile 的 /api/me 返回，2.3.2 S4 接驳）。
/// 字段口径见 profile-avatar-nickname/DESIGN.md §5.2：effectiveNickname 为
/// 全站生效昵称（未设昵称时服务端回退为登录账号名）；hasAvatar 为 false
/// 或头像取不到时，「我的」页一律显示品牌占位 QfAvatarPlaceholder。
class ProfileInfo {
  /// 登录账号名（不可自助修改，与昵称分开）。
  final String? username;

  /// 生效昵称（个人卡主行显示），缺失为 null。
  final String? effectiveNickname;

  /// 是否已设置真实头像。
  final bool hasAvatar;

  /// 头像版本戳（拼版本化 URL 防缓存），缺失为 null。
  final int? avatarUpdatedAt;

  const ProfileInfo({
    this.username,
    this.effectiveNickname,
    this.hasAvatar = false,
    this.avatarUpdatedAt,
  });

  /// 纯解析（供自测）：字段缺失/类型不对一律给缺省值，调用方回退旧显示。
  static ProfileInfo parse(String body) {
    final root = jsonDecode(body);
    if (root is! Map<String, dynamic>) {
      throw const FormatException('档案信息格式不正确');
    }
    final u = root['username'];
    final n = root['effectiveNickname'];
    final v = root['avatarUpdatedAt'];
    return ProfileInfo(
      username: u is String && u.isNotEmpty ? u : null,
      effectiveNickname: n is String && n.isNotEmpty ? n : null,
      hasAvatar: root['hasAvatar'] == true,
      avatarUpdatedAt: v is int ? v : (v is num ? v.toInt() : null),
    );
  }
}

/// 取控制台会话 cookie 的函数（由主页注入：从 WebView 的 CookieManager 取值）。
typedef ConsoleCookieProvider = Future<String?> Function();

/// 心跳鉴权状态（2.4.5 B7）：401/403（登录已死）与网络不通必须分开——
/// 前者触发探针复核＋清过期快照，后者只安静跳过，绝不误清快照。
enum AuthStatus { ok, authDead, unreachable }

/// 扩展服务客户端（积分心跳/查询＋站长判定＋管理令牌换发）。
///
/// 鉴权口径：扩展服务认控制台会话 cookie——本端从 WebView 的 CookieManager
/// 取到控制台 cookie 值后，手动附到请求头里（浏览器同源策略之外的人工桥）。
/// 所有请求失败一律安静返回（心跳丢一拍无所谓、关于页显示「—」、管理入口保持隐藏）。
class ExtService {
  final ConsoleCookieProvider cookieProvider;
  final SvcUrls urls;

  /// 客户端版本头取值（B24）：主页注入 PackageInfo 读到的包版本；
  /// 未注入时回落 kAppVersion。
  final String? clientVersion;

  /// 最近一次 401/403 的时间（B7）：调用方据此判定登录已死。
  DateTime? lastAuthFailureAt;

  ExtService({required this.cookieProvider, SvcUrls? urls, this.clientVersion})
      : urls = urls ?? SvcUrls.instance;

  void _applyVersion(HttpClientRequest req) =>
      applyClientVersionHeader(req, version: clientVersion);

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
      _applyVersion(req);
      req.headers.set(HttpHeaders.cookieHeader, cookie);
      req.headers.set(HttpHeaders.acceptHeader, 'application/json');
      if (jsonBody != null) {
        req.headers.contentType = ContentType.json;
        req.write(jsonEncode(jsonBody));
      }
      final res = await req.close().timeout(const Duration(seconds: 8));
      final body =
          await res.transform(utf8.decoder).join().timeout(const Duration(seconds: 8));
      if (res.statusCode == 401 || res.statusCode == 403) {
        lastAuthFailureAt = DateTime.now();
      }
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
  /// 返回 null＝本拍没打通（unreachable，安静跳过，不当作任何许可结论）；
  /// status==authDead＝服务端明确拒了这组会话（401/403），调用方须立即
  /// 触发探针复核（见 main.dart _heartbeatTick，B7）。
  Future<({AuthStatus status, bool forceLogout, String? gateCode})?>
      heartbeatSignal() async {
    final r = await _send('POST', '${urls.pointsApiBase}/api/heartbeat',
        jsonBody: {'client': 'android'});
    if (r == null) return null;
    if (r.$1 == 401 || r.$1 == 403) {
      return (status: AuthStatus.authDead, forceLogout: false, gateCode: null);
    }
    if (r.$1 != 200) return null;
    try {
      final root = jsonDecode(r.$2);
      if (root is Map<String, dynamic>) {
        final gc = root['gateCode'];
        return (
          status: AuthStatus.ok,
          forceLogout: root['forceLogout'] == true,
          gateCode: gc is String && gc.isNotEmpty ? gc : null,
        );
      }
    } catch (_) {
      // 响应不是 JSON：只当心跳成功，不解读信号
    }
    return (status: AuthStatus.ok, forceLogout: false, gateCode: null);
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

  /// 我的统一档案：取不到返回 null（「我的」页回退积分 user/已存账号名显示，
  /// 头像回退品牌占位，不挡页面，与 fetchMe 同口径）。
  Future<ProfileInfo?> fetchProfile() async {
    final r = await _send('GET', urls.profileMeUrl);
    if (r == null || r.$1 != 200) return null;
    try {
      return ProfileInfo.parse(r.$2);
    } catch (_) {
      return null;
    }
  }

  /// 我的头像字节：走同一 cookie 桥取二进制（_send 按 UTF-8 文本解码，
  /// 会损坏图片字节，故单独一条字节通道）。无头像（404）/失败返回 null，
  /// 调用方显示品牌占位。
  Future<Uint8List?> fetchProfileAvatar(ProfileInfo info) async {
    if (!info.hasAvatar) return null;
    final cookie = await cookieProvider();
    if (cookie == null || cookie.isEmpty) return null;
    HttpClient? client;
    try {
      client = HttpClient();
      client.connectionTimeout = const Duration(seconds: 8);
      final req = await client
          .getUrl(Uri.parse(urls.profileAvatarUrl(info.avatarUpdatedAt)))
          .timeout(const Duration(seconds: 8));
      _applyVersion(req);
      req.headers.set(HttpHeaders.cookieHeader, cookie);
      final res = await req.close().timeout(const Duration(seconds: 8));
      if (res.statusCode != 200) return null;
      // 核对 D6：头像字节累计上限 1MB（正本落盘上限 200KB，此为异常路径兜底），
      // 超限即中止回 null 走品牌占位，不再无条件累加。
      if (res.contentLength > 1048576) return null;
      final builder = BytesBuilder(copy: false);
      var totalBytes = 0;
      await for (final chunk in res.timeout(const Duration(seconds: 8))) {
        totalBytes += chunk.length;
        if (totalBytes > 1048576) return null;
        builder.add(chunk);
      }
      final bytes = builder.takeBytes();
      return bytes.isEmpty ? null : bytes;
    } catch (_) {
      return null;
    } finally {
      client?.close(force: true);
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
