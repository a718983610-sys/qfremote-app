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

/// 服务地址兜底基址（正式域名）：2.2.0 起论坛/注册/协议/积分/管理地址一律
/// 运行时从官网 product.json 的 web.* 解析（见 svc_urls.dart 的 SvcUrls），
/// 拉不到用本地缓存、再拉不到才用这里的写死兜底。兜底值与 product.json
/// 现行 web.* 同源同值（均为 app.qfremote.top 下的同名路径），保证解析源
/// 不可达且无缓存时五族入口仍落正式服务、不落死链。旧版用过的临时隧道
/// 地址已于 2026-10-28 拆除，不得再作兜底（解析层另有过滤，见 svc_urls）。
const String kSvcBaseOrigin = 'https://app.qfremote.top';

/// 论坛入口兜底（运行时以 SvcUrls.forumUrl 为准）。
const String kForumUrl = '$kSvcBaseOrigin/forum';

/// 注册入口兜底（运行时以 SvcUrls.registerUrl 为准）。
const String kRegisterUrl = '$kSvcBaseOrigin/register';

/// 协议页入口兜底（运行时以 SvcUrls.termsUrl 为准）。
const String kTermsUrl = '$kSvcBaseOrigin/terms';

/// 积分服务兜底（运行时以 SvcUrls.pointsUrl 为准；product.json 的 web.pointsUrl）。
const String kPointsUrlFallback = '$kSvcBaseOrigin/points';

/// 站长管理页兜底（运行时以 SvcUrls.adminUrl 为准；product.json 的 web.adminUrl）。
const String kAdminUrlFallback = '$kSvcBaseOrigin/admin';

/// 官网服务地址清单（运行时解析源）：官网 product.json 的 web.* 字段；
/// 文件由官网根域直发（与官网下载页同一份），不再经第三方托管页。
const String kProductJsonUrl = 'https://qfremote.top/product.json';

/// 官网根址（收编 P1 补「官网」带字入口 X-02）：全仓只许出现在这一处，
/// 取址走 SvcUrls.websiteUrl 单点。
const String kWebsiteUrl = 'https://qfremote.top/';

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

/// 官方 APK 包名（更新器装前验签的期望值，VM-02）。
const String kExpectedApkPackageName = 'com.qfremote.android';

/// 官方 APK 签名证书 SHA-256 指纹，小写 hex、无冒号（更新器装前验签的
/// 期望值，VM-02；与现售包 apksigner 实测一致）。
const String kExpectedApkCertSha256 =
    'a3fde275f46b4e470648c8e3fbc0594ce496eb17b8fa52f4da9bf2af7bbf141f';
