import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_inappwebview/flutter_inappwebview.dart';
import 'package:open_filex/open_filex.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:path_provider/path_provider.dart';

import 'build_info.dart';
import 'core/constants.dart';
import 'core/manifest.dart';
import 'core/update_policy.dart';
import 'core/version.dart';
import 'core/watchdog_core.dart';
import 'services/probe.dart';
import 'services/settings.dart';
import 'services/updater.dart';
import 'ui/about.dart';
import 'ui/force_update.dart';
import 'ui/overlays.dart';
import 'ui/theme.dart';
import 'ui/toolbar.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const QfRemoteApp());
}

class QfRemoteApp extends StatelessWidget {
  const QfRemoteApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'QFRemote',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xFF1450B4)),
        useMaterial3: true,
      ),
      home: const HomePage(),
    );
  }
}

/// WebView 求值适配：把看护的检测/点击脚本送进页面执行。
class _WebViewEvaluator implements WatchdogEvaluator {
  InAppWebViewController? controller;

  String _clean(Object? r) {
    var s = r?.toString() ?? '';
    if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
      s = s.substring(1, s.length - 1);
    }
    return s;
  }

  @override
  Future<String> detect() async {
    final c = controller;
    if (c == null) throw StateError('webview 未就绪');
    final r = await c.evaluateJavascript(source: kDetectJs);
    final s = _clean(r);
    return const ['login', 'disconnected', 'partial', 'ok'].contains(s) ? s : 'unknown';
  }

  @override
  Future<bool> clickReconnect() async {
    final c = controller;
    if (c == null) return false;
    final r = await c.evaluateJavascript(source: kClickJs);
    return r == true || _clean(r) == 'true';
  }
}

class HomePage extends StatefulWidget {
  const HomePage({super.key});

  @override
  State<HomePage> createState() => _HomePageState();
}

class _HomePageState extends State<HomePage> {
  final _updateService = UpdateService();
  final _evaluator = _WebViewEvaluator();

  QfSettings? _settings;
  PackageInfo? _pkg;
  QfThemeMode _themeMode = QfThemeMode.blue;
  bool _booted = false;
  bool _gateDone = false;
  ReleaseEntry? _forceEntry;

  InAppWebViewController? _web;
  WatchdogCore? _watchdog;
  bool _firstLoaded = false;
  bool _splashVisible = true;
  final DateTime _bornAt = DateTime.now();
  bool _canGoBack = false;

  bool _offline = false;
  bool _mainFrameFailed = false; // 本次主框架加载已报错：随后而来的 loadStop 是错误页，不算成功
  bool _sessionCheckScheduled = false;
  int _offlineIdx = 0;
  int _offlineSecondsLeft = 0;
  Timer? _offlineTimer;
  static const _offlineBackoff = [5, 10, 20, 30];

  ProbeResult? _lastProbe;
  bool _probeBusy = false;
  Timer? _probeTimer;

  ReleaseEntry? _updateEntry;
  bool _remindedThisSession = false;
  bool _fullscreen = false;

  String get _currentVersion => _pkg?.version ?? '1.0.5';
  QfPalette get _palette => QfPalette(_themeMode);
  String get _startUrl => kHasTestUrl ? kTestUrl : kConsoleUrl;

  @override
  void initState() {
    super.initState();
    _boot();
  }

  @override
  void dispose() {
    _watchdog?.stop();
    _offlineTimer?.cancel();
    _probeTimer?.cancel();
    super.dispose();
  }

  // ---------------- 启动：设置 → 待更新门 → 控制台 ----------------

  Future<void> _boot() async {
    final settings = await QfSettings.load();
    final pkg = await PackageInfo.fromPlatform();
    if (!mounted) return;
    setState(() {
      _settings = settings;
      _pkg = pkg;
      _themeMode = QfThemeModeX.fromPref(settings.theme);
      _booted = true;
    });
    await _launchGate(settings);
    _startProbeLoop();
  }

  /// 启动门（更新政策）：落盘有待更新时先取清单裁决——
  /// 命中待更新且服务器可达 → 强制更新页；连不上 → 先放行进控制台。
  Future<void> _launchGate(QfSettings settings) async {
    final pending = settings.pendingUpdateVersion;
    if (pending != null && isNewerVersion(pending, _currentVersion)) {
      ReleaseManifest? manifest;
      try {
        manifest = await _updateService.fetchManifest();
      } catch (_) {
        manifest = null; // 取不到清单 = 服务器连不上 → 放行
      }
      final decision = decideUpdate(
        currentVersion: _currentVersion,
        manifestEntry: manifest?.android,
        pendingVersion: pending,
        isLaunchCheck: true,
      );
      if (decision == UpdateDecision.forceAtLaunch && manifest?.android != null) {
        if (!mounted) return;
        setState(() {
          _forceEntry = manifest!.android;
          _gateDone = true;
        });
        return;
      }
      if (decision == UpdateDecision.none && manifest != null) {
        // 待更新已被撤下或已不比本机新 → 清掉标记
        await settings.setPendingUpdateVersion(null);
      }
    } else if (pending != null) {
      await settings.setPendingUpdateVersion(null);
    }
    if (!mounted) return;
    setState(() => _gateDone = true);
  }

  // ---------------- 探活（状态灯） ----------------

  void _startProbeLoop() {
    _runProbe();
    _probeTimer = Timer.periodic(const Duration(seconds: 60), (_) => _runProbe());
  }

  Future<ProbeResult> _runProbe() async {
    if (_probeBusy) {
      return _lastProbe ??
          ProbeResult(ok: false, at: DateTime.now(), elapsedMs: 0, error: '检测中');
    }
    _probeBusy = true;
    final r = await probeServer();
    _probeBusy = false;
    if (mounted) setState(() => _lastProbe = r);
    return r;
  }

  // ---------------- 会话内更新检查（只提醒不强制） ----------------

  Future<ReleaseEntry?> _sessionUpdateCheck({bool manual = false}) async {
    ReleaseManifest? manifest;
    try {
      manifest = await _updateService.fetchManifest();
    } catch (_) {
      if (manual && mounted) _snack('检查更新失败：连不上服务器');
      return null;
    }
    final entry = manifest.android;
    final settings = _settings;
    if (entry == null || settings == null) {
      if (manual && mounted) _snack('已经是最新版');
      return null;
    }
    final decision = decideUpdate(
      currentVersion: _currentVersion,
      manifestEntry: entry,
      pendingVersion: null,
      isLaunchCheck: false,
    );
    if (decision == UpdateDecision.remind) {
      await settings.setPendingUpdateVersion(entry.version);
      if (mounted) setState(() => _updateEntry = entry);
      if (!_remindedThisSession) {
        _remindedThisSession = true;
        if (mounted) _snack('发现新版 v${entry.version}，可在「关于」里下载更新');
      } else if (manual && mounted) {
        _snack('发现新版 v${entry.version}，可在「关于」里下载更新');
      }
      return entry;
    }
    // 已是最新：顺手清掉过期的待更新标记
    final pending = settings.pendingUpdateVersion;
    if (pending != null && !isNewerVersion(pending, _currentVersion)) {
      await settings.setPendingUpdateVersion(null);
    }
    if (mounted) setState(() => _updateEntry = null);
    if (manual && mounted) _snack('已经是最新版');
    return null;
  }

  // ---------------- 下载/安装 ----------------

  Future<Directory> _updatesDir() async {
    final base = await getExternalStorageDirectory() ?? await getTemporaryDirectory();
    return Directory('${base.path}/updates');
  }

  Future<File> _downloadApk(ReleaseEntry entry, void Function(int, int?, int?) onProgress) async {
    return _updateService.downloadApk(entry, await _updatesDir(), onProgress);
  }

  Future<void> _openInstaller(File file) async {
    final result = await OpenFilex.open(file.path);
    if (result.type != ResultType.done && mounted) {
      _snack('打开安装包没成功（${result.message}），文件在：${file.path}');
    }
  }

  // ---------------- WebView 事件 ----------------

  void _startWatchdog() {
    _watchdog?.stop();
    _watchdog = WatchdogCore(
      evaluator: _evaluator,
      enabled: () => mounted && _gateDone && !_offline && _forceEntry == null,
      onStatus: (s) {
        if (mounted) setState(() {});
        debugPrint('QFWATCHDOG status=$s');
      },
      onReconnectClick: () {
        _settings?.incWatchdogReconnects();
        debugPrint('QFWATCHDOG clicked');
      },
      log: (m) => debugPrint('QFWATCHDOG $m'),
    )..start();
  }

  Future<void> _onPageLoaded() async {
    if (_mainFrameFailed) {
      // 错误页的 loadStop：不算加载成功（整页断线页继续盖着，等重试成功再退场）。
      // 只处理启动画面退场，让断线卡片露出来。
      if (!_firstLoaded) {
        _firstLoaded = true;
        final elapsed = DateTime.now().difference(_bornAt).inMilliseconds;
        if (elapsed < 850) {
          await Future<void>.delayed(Duration(milliseconds: 850 - elapsed));
        }
        if (mounted) setState(() => _splashVisible = false);
      }
      return;
    }
    if (_offline) _exitOffline();
    if (!_firstLoaded) {
      _firstLoaded = true;
      final elapsed = DateTime.now().difference(_bornAt).inMilliseconds;
      // 启动画面最短停留 850ms（与 Windows 版一致），内容没好不露白
      if (elapsed < 850) {
        await Future<void>.delayed(Duration(milliseconds: 850 - elapsed));
      }
      if (mounted) setState(() => _splashVisible = false);
    }
    if (!_sessionCheckScheduled) {
      _sessionCheckScheduled = true;
      // 打开后 2 秒查一次更新（会话内只提醒，失败安静）
      Future<void>.delayed(const Duration(seconds: 2), () {
        if (mounted) _sessionUpdateCheck();
      });
    }
  }

  void _enterOffline() {
    if (_offline || _forceEntry != null) return;
    _offline = true;
    _settings?.incOfflineCount();
    _offlineIdx = 0;
    _scheduleOfflineRetry();
    _runProbe();
    if (mounted) setState(() {});
  }

  void _scheduleOfflineRetry() {
    _offlineTimer?.cancel();
    final secs = _offlineBackoff[_offlineIdx.clamp(0, _offlineBackoff.length - 1)];
    _offlineSecondsLeft = secs;
    if (mounted) setState(() {});
    _offlineTimer = Timer.periodic(const Duration(seconds: 1), (t) {
      if (!mounted || !_offline) {
        t.cancel();
        return;
      }
      _offlineSecondsLeft--;
      if (_offlineSecondsLeft <= 0) {
        t.cancel();
        if (_offlineIdx < _offlineBackoff.length - 1) _offlineIdx++;
        _web?.reload();
        _scheduleOfflineRetry();
      }
      setState(() {});
    });
  }

  void _exitOffline() {
    _offlineTimer?.cancel();
    _offline = false;
    _offlineIdx = 0;
    if (mounted) setState(() {});
  }

  /// 控制台页面里点到的文件下载：带上 WebView 的会话 Cookie 去下，
  /// 存到本应用的下载目录（与 Windows 版下载行为对齐）。
  Future<void> _handlePageDownload(DownloadStartRequest req) async {
    try {
      final cookies = await CookieManager.instance().getCookies(url: req.url);
      final client = trustedHttpClient(connectionTimeout: const Duration(seconds: 20));
      try {
        final request = await client.getUrl(Uri.parse(req.url.toString()));
        if (cookies.isNotEmpty) {
          request.headers.set(HttpHeaders.cookieHeader,
              cookies.map((c) => '${c.name}=${c.value}').join('; '));
        }
        final res = await request.close();
        if (res.statusCode != 200) throw HttpException('HTTP ${res.statusCode}');
        final base = await getExternalStorageDirectory() ?? await getTemporaryDirectory();
        final dir = Directory('${base.path}/downloads');
        await dir.create(recursive: true);
        var name = (req.suggestedFilename ?? '').trim();
        if (name.isEmpty) {
          final seg = Uri.parse(req.url.toString()).pathSegments;
          name = seg.isNotEmpty ? seg.last : 'download.bin';
        }
        name = name.replaceAll(RegExp(r'[^\w.\- ]'), '_');
        final file = File('${dir.path}/$name');
        final sink = file.openWrite();
        await res.pipe(sink);
        if (mounted) {
          _snack('已下载：$name', action: SnackBarAction(
            label: '打开',
            onPressed: () => OpenFilex.open(file.path),
          ));
        }
      } finally {
        client.close(force: true);
      }
    } catch (e) {
      if (mounted) _snack('下载失败：$e');
    }
  }

  void _snack(String msg, {SnackBarAction? action}) {
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(msg), action: action, duration: const Duration(seconds: 4)),
    );
  }

  // ---------------- 工具栏动作 ----------------

  void _onMenuAction(String action) {
    switch (action) {
      case 'theme':
        final next = _themeMode == QfThemeMode.blue ? QfThemeMode.dark : QfThemeMode.blue;
        setState(() => _themeMode = next);
        _settings?.setTheme(next.prefValue);
        break;
      case 'fullscreen':
        _toggleFullscreen();
        break;
      case 'screenshot':
        _takeScreenshot();
        break;
      case 'checkUpdate':
        _sessionUpdateCheck(manual: true);
        break;
      case 'about':
        _showAbout();
        break;
    }
  }

  Future<void> _toggleFullscreen() async {
    final next = !_fullscreen;
    setState(() => _fullscreen = next);
    if (next) {
      await SystemChrome.setEnabledSystemUIMode(SystemUiMode.immersiveSticky);
    } else {
      await SystemChrome.setEnabledSystemUIMode(SystemUiMode.edgeToEdge);
    }
  }

  Future<void> _takeScreenshot() async {
    final web = _web;
    if (web == null) return;
    try {
      final bytes = await web.takeScreenshot();
      if (bytes == null) throw StateError('没截到图');
      final base = await getExternalStorageDirectory() ?? await getTemporaryDirectory();
      final dir = Directory('${base.path}/screenshots');
      await dir.create(recursive: true);
      final now = DateTime.now();
      String two(int n) => n.toString().padLeft(2, '0');
      final name = 'QFRemote-${now.year}${two(now.month)}${two(now.day)}-'
          '${two(now.hour)}${two(now.minute)}${two(now.second)}.png';
      final file = File('${dir.path}/$name');
      await file.writeAsBytes(bytes);
      if (mounted) _snack('截图已保存：$name');
    } catch (e) {
      if (mounted) _snack('截图失败：$e');
    }
  }

  String _diagnosticsText() {
    final p = _lastProbe;
    final s = _settings;
    return [
      'QFRemote 安卓版诊断信息',
      '版本：v$_currentVersion（构建日期 $kBuildDate）',
      '系统：${Platform.operatingSystem} ${Platform.operatingSystemVersion}',
      '服务器探活：${p == null ? '还没测过' : p.describe()}',
      '整页断线次数：${s?.offlineCount ?? 0}',
      '看护自动重连次数：${s?.watchdogReconnects ?? 0}',
    ].join('\n');
  }

  void _showAbout() {
    final settings = _settings;
    if (settings == null) return;
    showQfAboutDialog(
      context,
      AboutDeps(
        currentVersion: _currentVersion,
        palette: _palette,
        probeNow: _runProbe,
        checkUpdate: () => _sessionUpdateCheck(),
        download: _downloadApk,
        openInstaller: _openInstaller,
        diagnosticsText: () async => _diagnosticsText(),
      ),
    );
  }

  // ---------------- 构建 ----------------

  @override
  Widget build(BuildContext context) {
    if (!_booted || !_gateDone) {
      return Scaffold(body: SplashView(palette: _palette, version: _currentVersion));
    }
    if (_forceEntry != null) {
      return Scaffold(
        body: ForceUpdateView(
          palette: _palette,
          currentVersion: _currentVersion,
          entry: _forceEntry!,
          download: _downloadApk,
          openInstaller: _openInstaller,
        ),
      );
    }

    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, result) {
        if (didPop) return;
        if (_canGoBack) {
          _web?.goBack();
        } else {
          SystemNavigator.pop();
        }
      },
      child: Scaffold(
        body: SafeArea(
          child: Stack(
            children: [
              Column(
                children: [
                  if (!_fullscreen) ...[
                    QfToolbar(
                      palette: _palette,
                      canGoBack: _canGoBack,
                      lastProbe: _lastProbe,
                      probeBusy: _probeBusy,
                      hasUpdate: _updateEntry != null,
                      onBack: () => _web?.goBack(),
                      onRefresh: () => _web?.reload(),
                      onHome: () => _web?.loadUrl(urlRequest: URLRequest(url: WebUri(_startUrl))),
                      onFriends: () => _web?.loadUrl(urlRequest: URLRequest(url: WebUri(kFriendsUrl))),
                      onProbeTap: () async {
                        final r = await _runProbe();
                        if (mounted) _snack(r.describe());
                      },
                      onUpdateTap: _showAbout,
                      onMenuAction: _onMenuAction,
                    ),
                    WatchdogStatusLine(
                      visible: _watchdog?.isReconnecting ?? false,
                      palette: _palette,
                    ),
                  ],
                  Expanded(
                    child: Stack(
                      children: [
                        InAppWebView(
                          initialUrlRequest: URLRequest(url: WebUri(_startUrl)),
                          initialSettings: InAppWebViewSettings(
                            javaScriptEnabled: true,
                            domStorageEnabled: true,
                            databaseEnabled: true,
                            cacheEnabled: true,
                            thirdPartyCookiesEnabled: true,
                            supportZoom: true,
                            builtInZoomControls: true,
                            displayZoomControls: false,
                            useShouldOverrideUrlLoading: true,
                            mediaPlaybackRequiresUserGesture: false,
                            allowsInlineMediaPlayback: true,
                            iframeAllow: 'fullscreen',
                            applicationNameForUserAgent: 'QFRemote',
                            // 明文流量开关由清单管（main 关、debug 为测试夹具开），插件无此项
                          ),
                          onWebViewCreated: (controller) {
                            _web = controller;
                            _evaluator.controller = controller;
                            _startWatchdog();
                          },
                          shouldOverrideUrlLoading: (controller, action) async {
                            final url = action.request.url;
                            if (url == null) return NavigationActionPolicy.CANCEL;
                            if (url.scheme == 'http' || url.scheme == 'https') {
                              return NavigationActionPolicy.ALLOW;
                            }
                            return NavigationActionPolicy.CANCEL;
                          },
                          onLoadStart: (controller, url) {
                            _mainFrameFailed = false;
                          },
                          onLoadStop: (controller, url) => _onPageLoaded(),
                          onReceivedError: (controller, request, error) {
                            if (request.isForMainFrame == true) {
                              _mainFrameFailed = true;
                              _enterOffline();
                            }
                          },
                          onReceivedServerTrustAuthRequest: (controller, challenge) async {
                            // 证书只认自家主机：逐个核对主机+端口（控制台 8443、好友页 8445），其余一律拒绝
                            final host = challenge.protectionSpace.host;
                            final port = challenge.protectionSpace.port;
                            final ok = port != null && isTrustedWebViewHostPort(host, port);
                            return ServerTrustAuthResponse(
                              action: ok
                                  ? ServerTrustAuthResponseAction.PROCEED
                                  : ServerTrustAuthResponseAction.CANCEL,
                            );
                          },
                          onUpdateVisitedHistory: (controller, url, isReload) async {
                            final can = await controller.canGoBack();
                            if (mounted) setState(() => _canGoBack = can);
                          },
                          onConsoleMessage: (controller, msg) {
                            if (kHasTestUrl) debugPrint('[webconsole] ${msg.message}');
                          },
                          onDownloadStartRequest: (controller, request) {
                            _handlePageDownload(request);
                          },
                        ),
                        if (_offline)
                          OfflineView(
                            palette: _palette,
                            secondsLeft: _offlineSecondsLeft,
                            onRetryNow: () {
                              _offlineTimer?.cancel();
                              _web?.reload();
                              _scheduleOfflineRetry();
                            },
                          ),
                        if (_splashVisible)
                          SplashView(palette: _palette, version: _currentVersion),
                      ],
                    ),
                  ),
                ],
              ),
              if (_fullscreen)
                Positioned(
                  right: 14,
                  bottom: 18,
                  child: FloatingActionButton.small(
                    heroTag: 'exitFs',
                    backgroundColor: Colors.black54,
                    onPressed: _toggleFullscreen,
                    child: const Icon(Icons.fullscreen_exit, color: Colors.white),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}
