import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:shared_preferences/shared_preferences.dart';

import 'constants.dart';

/// 服务地址单点收口（2.2.0）：所有入口（好友/论坛/注册/积分/管理）只许从这里取地址。
///
/// 解析顺序：内存（本次运行从官网 product.json 拉到的 web.*）→ 本地缓存
/// （上次成功拉到的值）→ constants.dart 的写死兜底。
/// 好友入口例外：保持直连 8445 的 SSO 口径不动（与控制台同 WebView、同会话
/// cookie、同自签证书校验），不走 product.json 的通道地址。
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

  /// 好友页：直连口径恒定（见类注释）。
  String get friendsUrl => kFriendsUrl;

  String get forumUrl => _forum ?? kForumUrl;
  String get registerUrl => _register ?? kRegisterUrl;
  String get termsUrl => _terms ?? kTermsUrl;
  String get pointsUrl => _points ?? kPointsUrlFallback;
  String get adminUrl => _admin ?? kAdminUrlFallback;

  /// 积分接口基址（pointsUrl 本身即 /points 前缀，接口在其下 /api/*）。
  String get pointsApiBase => pointsUrl;

  /// 管理接口基址（/admin 前缀下 /api/*）。
  String get adminApiBase => adminUrl;

  /// 令牌换发地址：拿控制台会话换一次性登录令牌，再打开管理页。
  String get ssoTokenUrl => '$adminUrl/api/sso-token';

  /// 自有服务源集合：控制台直连、好友直连、当前解析到的通道源。
  /// 导航策略据此识别「自家页面的 /logout」——外站同名路径不许触发
  /// 本机手动退出（深查修复：防外链 /logout 误清凭据）。
  Set<String> ownOrigins() {
    final out = <String>{
      kServerOrigin,
      'https://$kServerHost:$kFriendsPort',
    };
    for (final u in [forumUrl, registerUrl, pointsUrl, adminUrl, termsUrl]) {
      try {
        out.add(Uri.parse(u).origin);
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
  String get extOrigin => Uri.parse(pointsUrl).origin;

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

  static bool _usable(String? v) =>
      v != null && v.startsWith('https://') && v.length > 10 && !v.contains(' ');

  /// 从 product.json 的 JSON 文本里取 web.* 地址（纯函数，供自测）。
  /// 返回字段名 → 地址的映射，只收 https 的字符串值。
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

  /// 启动时调用一次：先读本地缓存垫底，再异步拉官网清单刷新（失败安静保留旧值）。
  Future<void> ensureResolved() {
    return _resolving ??= _resolve();
  }

  Future<void> _resolve() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      if (!_loaded) {
        _loaded = true;
        if (_usable(prefs.getString(_kForum))) _forum = prefs.getString(_kForum);
        if (_usable(prefs.getString(_kRegister))) {
          _register = prefs.getString(_kRegister);
        }
        if (_usable(prefs.getString(_kPoints))) _points = prefs.getString(_kPoints);
        if (_usable(prefs.getString(_kAdmin))) _admin = prefs.getString(_kAdmin);
        if (_usable(prefs.getString(_kTerms))) _terms = prefs.getString(_kTerms);
      }
      final fetched = await _fetchProductWeb();
      if (fetched == null) return;
      void apply(String key, String? v, void Function(String) set) {
        if (v != null) {
          set(v);
          unawaited(prefs.setString(key, v));
        }
      }

      apply(_kForum, fetched['forumUrl'], (v) => _forum = v);
      apply(_kRegister, fetched['registerUrl'], (v) => _register = v);
      apply(_kPoints, fetched['pointsUrl'], (v) => _points = v);
      apply(_kAdmin, fetched['adminUrl'], (v) => _admin = v);
      apply(_kTerms, fetched['termsUrl'], (v) => _terms = v);
    } catch (_) {
      // 拉不到/解析失败：一律安静走缓存与兜底，入口永不因此不可用。
    }
  }

  Future<Map<String, String>?> _fetchProductWeb() async {
    final client = HttpClient();
    client.connectionTimeout = const Duration(seconds: 6);
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
