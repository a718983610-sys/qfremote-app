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

/// 好友页（独立服务 qfremote-friends；与控制台同账号体系、会话独立，
/// 好友页需再登一次）。
const int kFriendsPort = 8445;
const String kFriendsUrl = 'https://$kServerHost:$kFriendsPort/friends';

/// 论坛入口：临时通道单点，与官网 product.json 的 web.forumUrl 同源，
/// 域名落地时同批切换；该域名正经证书，证书白名单无需放宽
/// （论坛服务只听服务器回环 8446，公网仅经通道可达——已实查）。
const String kForumUrl = 'https://bookmarks-hunting-rendering-atlas.trycloudflare.com/forum';

/// 注册入口（v2.0.1 新增，工具栏与登录界面可见）：临时通道单点，
/// 与官网 product.json 的 web.registerUrl 同源，域名落地时同批切换；
/// 该域名正经证书，证书白名单无需放宽（注册服务经通道 /register 出网）。
const String kRegisterUrl = 'https://bookmarks-hunting-rendering-atlas.trycloudflare.com/register';

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
