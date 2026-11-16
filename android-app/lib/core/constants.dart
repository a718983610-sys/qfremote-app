/// QFRemote 安卓控制端常量。
///
/// 信任口径（与 Windows 版同一条，不许放宽）：
/// - 控制台与更新清单、安装包，只认 app.qfremote.top 这一个正式域名；
/// - 2.4.2 起全量迁正式域名（服务器换 IP 后旧 IP 直连源已退役）；
/// - 正式域名是公共 CA 证书（Let's Encrypt）：证书校验走系统默认，
///   系统校验失败即拒绝（2.4.5 B3：删掉 PROCEED 分支，WebView 的
///   onReceivedServerTrustAuthRequest 只在系统校验失败时才被调用，
///   失败一律 CANCEL；不做指纹白名单——WebView 没有合法的自签使用场景）。
/// - 好友页/聊天/隐私锁与控制台同源（域名聚合路径 /friends、/chat、
///   /lock），好友服务认控制台会话 cookie——同一 WebView 打开即 SSO
///   直达，不再二次登录。
library;

const String kServerHost = 'app.qfremote.top';
const int kServerPort = 443;
const String kServerOrigin = 'https://$kServerHost';
const String kConsoleUrl = '$kServerOrigin/';

/// F-06 精确服务 origin 白名单（3.0.0）：只认这张写死表里的 origin，
/// 不许子域通配、不许任意端口。线上 product.json 的 web.* 五字段现行
/// 值（2026-11-09 v2.4.4 实测）全落在 `https://app.qfremote.top` 这
/// 一个 origin 上；服务端若日后把某服务迁到新子域，须随应用发版同步
/// 加表——旧版会把新地址判不信任并回落写死兜底，不会静默跟去新源。
/// 比较一律走 [Uri.origin]：`https://app.qfremote.top:443` 的 origin
/// 即 `https://app.qfremote.top`（默认端口归一），而 `:8443` 等非
/// 默认端口的 origin 带端口后缀，不在表内。
const Set<String> kTrustedSvcOrigins = {'https://app.qfremote.top'};

/// 好友页（独立服务 qfremote-friends，经域名聚合路径到达）。
const int kFriendsPort = 443;
const String kFriendsUrl = '$kServerOrigin/friends';

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

/// 隐私锁接口（与好友同服务族、同源，路径 /lock；契约见线 B 接缝文件）。
const int kLockPort = 443;
const String kLockApiBase = '$kServerOrigin/lock';

/// WebView 证书校验（2.4.5 B3）：公共 CA 走系统默认校验——本函数不再
/// 用于放行任何证书错误（onReceivedServerTrustAuthRequest 只在系统
/// 校验失败时才被调用，失败一律 CANCEL）。仅保留「是不是自家主机+端口」
/// 的识别，供证书异常卡的诊断文案区分自家源与外站。
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

/// QF-10（3.0.0 低组）：官方签名证书指纹白名单（轮换窗口）。
/// 现行只有一枚；未来新旧证书双签过渡期，在此追加新指纹、待旧包
/// 下线后再移除旧指纹。isExpectedApkIdentity 要求“每位签名者都
/// 落在白名单内”——不是“任一命中”：攻击者附加自签证书时，附加
/// 的那位不在名单内，整包仍拒绝（U-3 口径不变）。
const List<String> kExpectedApkCertSha256s = [kExpectedApkCertSha256];
