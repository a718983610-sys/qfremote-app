/// QFRemote 安卓控制端常量。
///
/// 信任口径（与 Windows 版同一条，不许放宽）：
/// - 控制台与更新清单、安装包，只认 54.248.9.192:8443 这一个主机；
/// - 服务器是自签证书，放行只发生在逐个校验主机+端口之后。
library;

const String kServerHost = '54.248.9.192';
const int kServerPort = 8443;
const String kServerOrigin = 'https://$kServerHost:$kServerPort';
const String kConsoleUrl = '$kServerOrigin/';

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
