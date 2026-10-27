/// QFRemote 安卓控制端常量。
///
/// 信任口径（与 Windows 版同一条，不许放宽）：
/// - 控制台与更新清单、安装包，只认 54.248.9.192:8443 这一个主机；
/// - 服务器是自签证书，放行只发生在逐个校验主机+端口之后；
/// - 好友页在同主机的 8445（v1.0.5 新增），与控制台同一张自签证书，
///   仅 WebView 证书校验多放行这一个端口；更新信任口径不变，仍只认 8443。
library;

const String kServerHost = '54.248.9.192';
const int kServerPort = 8443;
const String kServerOrigin = 'https://$kServerHost:$kServerPort';
const String kConsoleUrl = '$kServerOrigin/';

/// 好友页（独立服务 qfremote-friends；与控制台同账号体系，好友服务认
/// 控制台会话 cookie——同一 WebView 打开即 SSO 直达，不再二次登录）。
const int kFriendsPort = 8445;
const String kFriendsUrl = 'https://$kServerHost:$kFriendsPort/friends';

/// 临时通道源（兜底专用）：2.2.0 起论坛/注册/积分/管理地址一律运行时从官网
/// product.json 的 web.* 解析（见 svc_urls.dart 的 SvcUrls），拉不到用本地缓存、
/// 再拉不到才用这里的写死兜底。全仓临时通道域名只许出现在这一处。
const String kFallbackTunnelOrigin =
    'https://bookmarks-hunting-rendering-atlas.trycloudflare.com';

/// 论坛入口兜底（运行时以 SvcUrls.forumUrl 为准）。
const String kForumUrl = '$kFallbackTunnelOrigin/forum';

/// 注册入口兜底（运行时以 SvcUrls.registerUrl 为准）。
const String kRegisterUrl = '$kFallbackTunnelOrigin/register';

/// 协议页入口兜底（运行时以 SvcUrls.termsUrl 为准）。
const String kTermsUrl = '$kFallbackTunnelOrigin/terms';

/// 积分服务兜底（运行时以 SvcUrls.pointsUrl 为准；product.json 的 web.pointsUrl）。
const String kPointsUrlFallback = '$kFallbackTunnelOrigin/points';

/// 站长管理页兜底（运行时以 SvcUrls.adminUrl 为准；product.json 的 web.adminUrl）。
const String kAdminUrlFallback = '$kFallbackTunnelOrigin/admin';

/// 官网服务地址清单（运行时解析源）：官网 product.json 的 web.* 字段。
const String kProductJsonUrl =
    'https://a718983610-sys.github.io/qfremote-website/product.json';

/// 隐私锁接口（与好友同服务族、同端口，路径 /lock；契约见线 B 接缝文件）。
const int kLockPort = 8445;
const String kLockApiBase = 'https://$kServerHost:$kLockPort/lock';

/// WebView 证书校验：只认自家主机的控制台与好友页两个端口。
bool isTrustedWebViewHostPort(String host, int port) =>
    host == kServerHost && (port == kServerPort || port == kFriendsPort);

/// 正式更新清单地址（服务器 meshcentral-web/public 覆盖目录）。
/// 测试覆盖（仅 debug/测试构建经 --dart-define 注入，生产恒为正式地址）：
/// QF_RELEASE_URL 覆盖清单地址，同时该地址的 origin 成为本次运行的唯一
/// 可信源（与 Windows 版 QFREMOTE_RELEASE_URL 同口径）。
const String _releaseOverride = String.fromEnvironment('QF_RELEASE_URL');
const String _testUrlOverride = String.fromEnvironment('QF_TEST_URL');

String get kReleaseUrl =>
    _releaseOverride.isNotEmpty ? _releaseOverride : '$kServerOrigin/release.json';

/// 本次运行唯一可信的 origin：清单里的下载地址若指向别处，一律拒绝。
String get kTrustedOrigin {
  if (_releaseOverride.isNotEmpty) {
    return Uri.parse(_releaseOverride).origin;
  }
  return kServerOrigin;
}

/// 仅测试用：设置后 WebView 改为加载该地址（看护假页面实测用），
/// 生产构建没有这个 define，恒为空、功能不生效。
String get kTestUrl => _testUrlOverride;

bool get kHasTestUrl => _testUrlOverride.isNotEmpty;
