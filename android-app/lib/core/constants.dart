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
