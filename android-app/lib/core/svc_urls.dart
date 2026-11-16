import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:shared_preferences/shared_preferences.dart';

import '../services/probe.dart' show trustedHttpClient;

import 'constants.dart';

/// 服务地址单点收口（2.2.0）：所有入口（好友/论坛/注册/积分/管理）只许从这里取地址。
///
/// 解析顺序：内存（本次运行从官网 product.json 拉到的 web.*）→ 本地缓存
/// （上次成功拉到的值）→ constants.dart 的写死兜底。
/// 好友入口例外：地址恒用 constants 的写死值（2.4.2 起为域名同源
/// /friends），不走 product.json 的通道地址；SSO 口径不动（与控制台同
/// WebView、同会话 cookie）。
class SvcUrls {
  SvcUrls._();

  static final SvcUrls instance = SvcUrls._();

  static const _kForum = 'svc_forum_url';
  static const _kRegister = 'svc_register_url';
  static const _kPoints = 'svc_points_url';
  static const _kAdmin = 'svc_admin_url';
  static const _kTerms = 'svc_terms_url';

  String? _forum;
  String? _register;
  String? _points;
  String? _admin;
  String? _terms;
  bool _loaded = false;
  Future<void>? _resolving;

  /// 好友页：地址恒定口径（见类注释）。
  String get friendsUrl => kFriendsUrl;

  /// 服务地址白名单（F-06，3.0.0，取代 2.4.5 B15 的子域通配）：
  /// 只接受 [kTrustedSvcOrigins] 写死表里的精确 origin（scheme＋host＋
  /// 端口三者全对，见 constants.dart 的表注）。product.json 被劫持／
  /// 投毒也只能指向这一个 origin：任意子域（如 sub.app.qfremote.top、
  /// tun.qfremote.top）、任意非默认端口（如 :8443）、裸域
  /// qfremote.top、userinfo 嵌套一律丢弃并回落写死兜底；会话 cookie
  /// 只向精确的生产 ext origin 移植（见 main.dart
  /// _transplantSessionToExt）。
  static bool isTrustedSvcUrl(String? url) {
    if (url == null) return false;
    if (!url.startsWith('https://') || url.length <= 10 || url.contains(' ')) {
      return false;
    }
    final uri = Uri.tryParse(url);
    if (uri == null) return false;
    if (uri.userInfo.isNotEmpty) return false;
    return kTrustedSvcOrigins.contains(uri.origin);
  }

  /// 这个 origin 字符串是不是精确白名单内的服务 origin（供 Cookie
  /// 移植等只认 origin 的调用方；比较前先归一化，显式 :443 与默认
  /// 端口视为同一 origin，非默认端口不在表内）。
  static bool isTrustedSvcOrigin(String? origin) {
    if (origin == null) return false;
    final uri = Uri.tryParse(origin);
    if (uri == null || uri.scheme != 'https') return false;
    if (uri.userInfo.isNotEmpty) return false;
    try {
      return kTrustedSvcOrigins.contains(uri.origin);
    } catch (_) {
      // 无 authority 等取不到源的地址一律不认。
      return false;
    }
  }

  /// 已退役源过滤：旧版本写入本地缓存（或旧清单下发）的临时隧道地址
  /// 一律视为无效、回落正式兜底——该隧道已拆除，落上去就是死链（H-1）。
  /// 2.4.5 起改为白名单制：不在白名单内的地址一律无效（黑名单制已被
  /// 白名单覆盖，trycloudflare 同样被白名单拦下）。
  static String? _validSvcUrl(String? url) {
    if (url == null) return null;
    if (!isTrustedSvcUrl(url)) return null;
    return url;
  }

  String get forumUrl => _validSvcUrl(_forum) ?? kForumUrl;
  String get registerUrl => _validSvcUrl(_register) ?? kRegisterUrl;
  String get termsUrl => _validSvcUrl(_terms) ?? kTermsUrl;
  String get pointsUrl => _validSvcUrl(_points) ?? kPointsUrlFallback;
  String get adminUrl => _validSvcUrl(_admin) ?? kAdminUrlFallback;

  /// 官网根址（收编 P1，X-02）：固定公开站，不走 product.json 解析。
  String get websiteUrl => kWebsiteUrl;

  /// 积分接口基址（pointsUrl 本身即 /points 前缀，接口在其下 /api/*）。
  String get pointsApiBase => pointsUrl;

  /// 管理接口基址（/admin 前缀下 /api/*）。
  String get adminApiBase => adminUrl;

  /// 令牌换发地址：拿控制台会话换一次性登录令牌，再打开管理页。
  String get ssoTokenUrl => '$adminUrl/api/sso-token';

  /// 自有服务源集合：F-06 起只含精确白名单内的 origin。五族地址经
  /// getter 校验后现行值全是 [kServerOrigin]，本集合同步只收可信
  /// origin——外站同名路径（如 /logout）不许触发本机手动退出。
  Set<String> ownOrigins() {
    final out = <String>{};
    if (isTrustedSvcOrigin(kServerOrigin)) out.add(kServerOrigin);
    if (isTrustedSvcOrigin(Uri.parse(kFriendsUrl).origin)) {
      out.add(Uri.parse(kFriendsUrl).origin);
    }
    for (final u in [forumUrl, registerUrl, pointsUrl, adminUrl, termsUrl]) {
      try {
        final o = Uri.parse(u).origin;
        if (isTrustedSvcOrigin(o)) out.add(o);
      } catch (_) {
        // 解析不了的地址不进集合
      }
    }
    return out;
  }

  /// 这个地址是不是自有服务源上的（无法解析一律 false）。
  bool isOwnOrigin(String? url) {
    if (url == null) return false;
    try {
      return ownOrigins().contains(Uri.parse(url).origin);
    } catch (_) {
      return false;
    }
  }

  /// 管理页登录地址（带一次性令牌）。
  String adminLoginUrl(String token) =>
      '$adminUrl/login?token=${Uri.encodeQueryComponent(token)}';

  /// 扩展服务同源根（2.3.1 许可/新首页落点）：许可接口、新首页、购买页、
  /// 状态查询页都挂在扩展服务同一源下（经 nginx 同源 /license/*、/purchase、
  /// /home），与积分同源——取 pointsUrl 的 origin，不另设地址来源。
  /// F-06：pointsUrl 既经精确白名单校验，此处再守一道——origin 不在
  /// 白名单内时回落 [kServerOrigin]，绝不把会话 Cookie 的移植目标
  /// 交给解析值单方面决定。
  String get extOrigin {
    final o = Uri.parse(pointsUrl).origin;
    return isTrustedSvcOrigin(o) ? o : kServerOrigin;
  }

  /// 新版首页（阶段 C-3 网页正本，壳内同框呈现）。
  String get homeUrl => '$extOrigin/home';

  /// 购买页（真实支付开关关时页面自带正式提示，壳只负责壳内打开）。
  String get purchaseUrl => '$extOrigin/purchase';

  /// 账户状态查询页（登录页「查询密钥」落点，§十）。
  String get licenseStatusUrl => '$extOrigin/license/status';

  /// 换绑申诉页（§11.9；打开时由壳带入本机设备码，见 main.dart _openRebind）。
  String get rebindUrl => '$extOrigin/license/rebind';

  /// 申诉页（既有 /appeal 通道，全状态可达）。
  String get appealUrl => '$extOrigin/appeal';

  /// 许可接口基址（/license 前缀下 /api/*）。
  String get licenseApiBase => '$extOrigin/license';

  /// 统一档案接口基址（2.3.2 S4 接驳；与积分/许可同在扩展服务同源，
  /// 路径口径见 profile-avatar-nickname/DESIGN.md §5.2）。
  String get profileApiBase => '$extOrigin/profile';

  /// 本人档案（GET /profile/api/me，认控制台会话 cookie）。
  String get profileMeUrl => '$profileApiBase/api/me';

  /// 本人头像字节（GET /profile/avatar；带版本戳防旧图缓存，无头像 404）。
  String profileAvatarUrl(int? avatarUpdatedAt) => avatarUpdatedAt == null
      ? '$profileApiBase/avatar'
      : '$profileApiBase/avatar?v=$avatarUpdatedAt';

  static bool _usable(String? v) => isTrustedSvcUrl(v);

  /// 从 product.json 的 JSON 文本里取 web.* 地址（纯函数，供自测）。
  /// 返回字段名 → 地址的映射，只收白名单内的 https 字符串值。
  static Map<String, String> parseProductWeb(String body) {
    final root = jsonDecode(body);
    if (root is! Map<String, dynamic>) {
      throw const FormatException('更新清单格式不正确');
    }
    final web = root['web'];
    if (web is! Map<String, dynamic>) {
      throw const FormatException('更新清单缺少服务地址配置');
    }
    final out = <String, String>{};
    for (final key in ['forumUrl', 'registerUrl', 'pointsUrl', 'adminUrl', 'termsUrl']) {
      final v = web[key];
      if (_usable(v is String ? v : null)) out[key] = v as String;
    }
    return out;
  }

  /// 解析服务地址：先读本地缓存垫底，再拉官网清单刷新（失败安静保留旧值）。
  /// 成功后本会话内复用结果；失败不缓存，下次调用自动重试（H-6）。
  Future<void> ensureResolved() {
    return _resolving ??= _resolve();
  }

  Future<void> _resolve() async {
    var fetchedOk = false;
    try {
      final prefs = await SharedPreferences.getInstance();
      if (!_loaded) {
        _loaded = true;
        String? cached(String key) => _validSvcUrl(prefs.getString(key));
        if (_usable(cached(_kForum))) _forum = cached(_kForum);
        if (_usable(cached(_kRegister))) _register = cached(_kRegister);
        if (_usable(cached(_kPoints))) _points = cached(_kPoints);
        if (_usable(cached(_kAdmin))) _admin = cached(_kAdmin);
        if (_usable(cached(_kTerms))) _terms = cached(_kTerms);
      }
      final fetched = await _fetchProductWeb();
      if (fetched == null) return;
      fetchedOk = true;
      void apply(String key, String? v, void Function(String) set) {
        final vv = _validSvcUrl(v);
        if (vv != null) {
          set(vv);
          unawaited(prefs.setString(key, vv));
        }
      }

      apply(_kForum, fetched['forumUrl'], (v) => _forum = v);
      apply(_kRegister, fetched['registerUrl'], (v) => _register = v);
      apply(_kPoints, fetched['pointsUrl'], (v) => _points = v);
      apply(_kAdmin, fetched['adminUrl'], (v) => _admin = v);
      apply(_kTerms, fetched['termsUrl'], (v) => _terms = v);
    } catch (_) {
      // 拉不到/解析失败：一律安静走缓存与兜底，入口永不因此不可用。
    } finally {
      // 本轮没拉到新值（网络瞬时失败/清单异常）：清掉在途记录，下次调用
      // 重新解析，不让一次失败把整会话钉死在兜底上（H-6）；拉到新值则
      // 保留已完成记录，后续调用直接返回、不重复打网络。
      if (!fetchedOk) _resolving = null;
    }
  }

  Future<Map<String, String>?> _fetchProductWeb() async {
    // 2.4.5 B15/B3：走同一证书校验（系统默认公共 CA，不再用默认
    // HttpClient 绕过信任口径）。
    final client = trustedHttpClient(connectionTimeout: const Duration(seconds: 6));
    try {
      final req = await client
          .getUrl(Uri.parse(kProductJsonUrl))
          .timeout(const Duration(seconds: 6));
      req.headers.set(HttpHeaders.acceptHeader, 'application/json');
      final res = await req.close().timeout(const Duration(seconds: 6));
      if (res.statusCode != 200) return null;
      final body = await res
          .transform(utf8.decoder)
          .join()
          .timeout(const Duration(seconds: 6));
      return parseProductWeb(body);
    } catch (_) {
      return null;
    } finally {
      client.close(force: true);
    }
  }
}
