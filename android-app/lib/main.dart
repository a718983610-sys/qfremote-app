import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_inappwebview/flutter_inappwebview.dart';
import 'package:open_filex/open_filex.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:path_provider/path_provider.dart';

import 'build_info.dart';
import 'core/constants.dart';
import 'core/login_bridge.dart';
import 'core/session_recovery.dart';
import 'core/svc_urls.dart';
import 'core/manifest.dart';
import 'core/update_policy.dart';
import 'core/version.dart';
import 'core/watchdog_core.dart';
import 'services/credential_store.dart';
import 'services/points.dart';
import 'services/probe.dart';
import 'services/settings.dart';
import 'services/updater.dart';
import 'ui/about.dart';
import 'ui/force_update.dart';
import 'ui/lock.dart';
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
        colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xFF2470E0)),
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

/// 一次登录提交的回传（登录桥 JS 在点登录按钮时送回原生层）：
/// 先挂起，等确认真进了控制台才落盘（密码错了不落，免得存下错密码）。
class _PendingSubmit {
  final String username;
  final String password;
  final bool rememberDevice;
  final bool rememberPassword;
  const _PendingSubmit({
    required this.username,
    required this.password,
    required this.rememberDevice,
    required this.rememberPassword,
  });
}

class HomePage extends StatefulWidget {
  const HomePage({super.key});

  @override
  State<HomePage> createState() => _HomePageState();
}

class _HomePageState extends State<HomePage> with WidgetsBindingObserver {
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

  // 2.2.0：扩展服务（积分心跳/站长判定/管理令牌）与前台状态。
  ExtService? _ext;
  Timer? _heartbeatTimer;
  int _heartbeatTicks = 0;
  bool _foreground = true;
  bool _isAdmin = false;

  // 2.3.0：自动重新登录＋记住账号密码。
  // 恢复链：掉登录 → 先塞回会话快照刷新（30 天内有效）→ 再用已存凭据静默
  // 登录 → 都不行才露登录页提示。恢复全程盖着启动画面，不闪登录页。
  // 手动退出账号是唯一人工终止：清会话、清凭据、清记住标记，此后不再自动登录。
  final _credStore = CredentialStore();
  final _autoLogin = AutoLoginController();
  SavedCredentials? _savedCreds;
  SessionSnapshot? _savedSession;
  Timer? _loginTimer;
  bool _loginTickBusy = false;
  String _currentUrl = '';
  bool _episodeActive = false;
  bool _recoveryCover = false;
  DateTime? _stepWaitUntil;
  bool _injectedThisLoad = false;
  bool _filledThisLoad = false;
  bool _failureSnackShown = false;
  DateTime? _lastSnapshotAt;
  _PendingSubmit? _pendingSubmit;
  DateTime? _pendingSubmitAt;
  bool _pendingSubmitAuto = false;
  bool _autoSubmitInFlight = false;

  ExtService get _extService =>
      _ext ??= ExtService(cookieProvider: _consoleCookieHeader);

  String get _currentVersion => _pkg?.version ?? '2.2.0';
  QfPalette get _palette => QfPalette(_themeMode);
  String get _startUrl => kHasTestUrl ? kTestUrl : kConsoleUrl;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _boot();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _foreground = state == AppLifecycleState.resumed;
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _watchdog?.stop();
    _offlineTimer?.cancel();
    _probeTimer?.cancel();
    _heartbeatTimer?.cancel();
    _loginTimer?.cancel();
    super.dispose();
  }

  // ---------------- 启动：设置 → 待更新门 → 控制台 ----------------

  Future<void> _boot() async {
    final settings = await QfSettings.load();
    final pkg = await PackageInfo.fromPlatform();
    // 2.3.0：先把已存凭据/会话快照/拦截标记读进内存；有恢复的可能时，
    // 启动画面先盖住，等恢复链裁决完再露页面（不闪登录页）。
    try {
      _savedCreds = await _credStore.loadCredentials();
      _savedSession = await _credStore.loadSession();
    } catch (_) {
      _savedCreds = null;
      _savedSession = null;
    }
    _autoLogin.credentialBlocked = settings.credentialBlocked;
    final canRecover = (_savedCreds != null ||
            (_savedSession?.isFresh(DateTime.now()) ?? false)) &&
        (settings.rememberDevice || settings.rememberPassword);
    if (canRecover) {
      _episodeActive = true;
      _recoveryCover = true;
      _autoLogin.beginEpisode();
    }
    if (!mounted) return;
    setState(() {
      _settings = settings;
      _pkg = pkg;
      _themeMode = QfThemeModeX.fromPref(settings.theme);
      _booted = true;
    });
    await _launchGate(settings);
    _startProbeLoop();
    unawaited(SvcUrls.instance.ensureResolved());
    _startHeartbeatLoop();
  }

  // ---------------- 积分心跳与站长判定（2.2.0） ----------------

  /// 控制台会话 cookie：从 WebView 的 CookieManager 取控制台源的 cookie 值，
  /// 拼成请求头字符串；没登录/取不到返回 null（心跳与判定自动跳过）。
  Future<String?> _consoleCookieHeader() async {
    try {
      final cookies =
          await CookieManager.instance().getCookies(url: WebUri(kServerOrigin));
      if (cookies.isEmpty) return null;
      return cookies.map((c) => '${c.name}=${c.value}').join('; ');
    } catch (_) {
      return null;
    }
  }

  void _startHeartbeatLoop() {
    _heartbeatTimer?.cancel();
    _heartbeatTimer =
        Timer.periodic(const Duration(seconds: 60), (_) => _heartbeatTick());
  }

  /// 每 60 秒：App 在前台且控制台已登录（取得到 cookie）才发心跳；
  /// 每 5 拍顺带复查一次站长身份（管理入口显隐）。
  Future<void> _heartbeatTick() async {
    if (!mounted || !_foreground) return;
    final cookie = await _consoleCookieHeader();
    if (cookie == null) return;
    _heartbeatTicks++;
    await _extService.heartbeat();
    if (_heartbeatTicks % 5 == 1) {
      final admin = await _extService.checkIsAdmin();
      if (mounted && admin != _isAdmin) setState(() => _isAdmin = admin);
    }
  }

  /// 打开站长管理页：先用控制台会话换一次性令牌，再在 WebView 打开管理页；
  /// 换不到令牌时直接打开管理页（服务端会自行走登录）。
  Future<void> _openAdmin() async {
    final token = await _extService.fetchSsoToken();
    if (!mounted) return;
    final url = token != null
        ? SvcUrls.instance.adminLoginUrl(token)
        : SvcUrls.instance.adminUrl;
    _web?.loadUrl(urlRequest: URLRequest(url: WebUri(url)));
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

  // ---------------- 自动重新登录＋记住账号密码（2.3.0） ----------------

  /// 登录逻辑只认控制台根页面（同源、根路径）；好友/论坛/注册等页面不介入。
  bool get _isConsolePage {
    if (kHasTestUrl) return false;
    final uri = Uri.tryParse(_currentUrl);
    if (uri == null) return false;
    return uri.origin == kServerOrigin &&
        (uri.path.isEmpty || uri.path == '/');
  }

  void _startLoginLoop() {
    _loginTimer?.cancel();
    _loginTimer =
        Timer.periodic(const Duration(seconds: 2), (_) => _loginTick());
  }

  /// 注册登录桥的两个 JS 处理器（登录提交回传 / 手动退出回传）。
  void _registerLoginHandlers(InAppWebViewController controller) {
    controller.addJavaScriptHandler(
      handlerName: kHandlerLoginSubmit,
      callback: (args) {
        if (args.isEmpty || args.first is! Map) return;
        final m = args.first as Map;
        final u = m['username']?.toString() ?? '';
        final p = m['password']?.toString() ?? '';
        if (u.isEmpty || p.isEmpty) return;
        _pendingSubmit = _PendingSubmit(
          username: u,
          password: p,
          rememberDevice: m['rememberDevice'] == true,
          rememberPassword: m['rememberPassword'] == true,
        );
        _pendingSubmitAt = DateTime.now();
        _pendingSubmitAuto = _autoSubmitInFlight;
        debugPrint('QFLOGIN submit captured (auto=$_pendingSubmitAuto)');
      },
    );
    controller.addJavaScriptHandler(
      handlerName: kHandlerManualLogout,
      callback: (args) => _noteManualLogout(),
    );
  }

  Future<LoginProbe?> _probeLogin() async {
    final web = _web;
    if (web == null) return null;
    try {
      final r = await web.evaluateJavascript(source: kLoginProbeJs);
      var s = r?.toString() ?? '';
      if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
        try {
          final decoded = jsonDecode(s);
          if (decoded is String) s = decoded;
        } catch (_) {
          return null;
        }
      }
      return LoginProbe.parse(s);
    } catch (_) {
      return null;
    }
  }

  Future<bool> _evalJsBool(String js) async {
    final web = _web;
    if (web == null) return false;
    try {
      final r = await web.evaluateJavascript(source: js);
      return r == true || r?.toString() == 'true';
    } catch (_) {
      return false;
    }
  }

  /// 往登录页注入登录桥（勾选框＋钩子＋可选回填），重复注入安全。
  Future<void> _injectBridge({required bool fillSaved}) async {
    final web = _web;
    if (web == null) return;
    final js = buildLoginBridgeJs(
      savedUsername: _savedCreds?.username,
      savedPassword: _savedCreds?.password,
      rememberPasswordChecked: _settings?.rememberPassword ?? false,
      rememberDeviceChecked: _settings?.rememberDevice ?? false,
      fillSaved: fillSaved,
    );
    try {
      final r = await web.evaluateJavascript(source: js);
      debugPrint('QFLOGIN bridge -> $r');
      if (fillSaved && r?.toString().contains('filled') == true) {
        _filledThisLoad = true;
      }
    } catch (_) {
      // 页面正在跳转：这一拍算了，下一拍再来
    }
  }

  Future<void> _loginTick() async {
    if (_loginTickBusy || !mounted || _web == null) return;
    if (!_gateDone || _forceEntry != null || _offline) return;
    if (!_isConsolePage) return;
    _loginTickBusy = true;
    try {
      final probe = await _probeLogin();
      if (probe == null || !mounted) return;
      if (probe.isConsole) {
        await _onConsoleDetected();
      } else if (probe.isLogin) {
        await _onLoginPageDetected();
      }
      // unknown：页面还没画完，这一拍不动作
    } finally {
      _loginTickBusy = false;
    }
  }

  /// 探针确认已在控制台：落盘挂起的登录提交、刷新会话快照、收尾恢复盖子。
  Future<void> _onConsoleDetected() async {
    if (!_injectedThisLoad) {
      await _injectBridge(fillSaved: false);
      _injectedThisLoad = true;
    }
    final pending = _pendingSubmit;
    if (pending != null) {
      _pendingSubmit = null;
      _pendingSubmitAt = null;
      final s = _settings;
      if (s != null) {
        await s.setRememberDevice(pending.rememberDevice);
        await s.setRememberPassword(pending.rememberPassword);
      }
      if (pending.rememberPassword) {
        try {
          await _credStore.saveCredentials(pending.username, pending.password);
          _savedCreds = SavedCredentials(
              username: pending.username, password: pending.password);
        } catch (_) {}
      } else {
        try {
          await _credStore.clearCredentials();
        } catch (_) {}
        _savedCreds = null;
      }
      if (!pending.rememberDevice && !pending.rememberPassword) {
        // 两个记住都没勾：会话快照也不留（关 App 掉登录是应有之义）
        try {
          await _credStore.clearSession();
        } catch (_) {}
        _savedSession = null;
      }
    }
    if (_settings?.credentialBlocked ?? false) {
      await _settings?.setCredentialBlocked(false);
    }
    _autoLogin.onLoginSuccess();
    _episodeActive = false;
    _stepWaitUntil = null;
    _failureSnackShown = false;
    await _maybeSnapshotSession();
    if (mounted && (_recoveryCover || _splashVisible)) {
      setState(() {
        _recoveryCover = false;
        _splashVisible = false;
      });
    }
  }

  /// 登录成功后摘存会话 cookie（两个记住勾了任一项才摘；5 分钟内不重复摘）。
  Future<void> _maybeSnapshotSession() async {
    final s = _settings;
    if (s == null || (!s.rememberDevice && !s.rememberPassword)) return;
    final last = _lastSnapshotAt;
    if (last != null &&
        DateTime.now().difference(last) < const Duration(minutes: 5)) {
      return;
    }
    try {
      final cookies =
          await CookieManager.instance().getCookies(url: WebUri(kServerOrigin));
      final map = <String, String>{};
      for (final c in cookies) {
        if ((c.name == 'xid' || c.name == 'xid.sig' || c.name == 'qfrem') &&
            c.value.toString().isNotEmpty) {
          map[c.name] = c.value.toString();
        }
      }
      if ((map['xid'] ?? '').isEmpty) return;
      final snap = SessionSnapshot(cookies: map, savedAt: DateTime.now());
      await _credStore.saveSession(snap);
      _savedSession = snap;
      _lastSnapshotAt = DateTime.now();
      debugPrint('QFLOGIN session snapshot saved (${map.keys.join(',')})');
    } catch (_) {
      // 摘不到就算了：下次探针再试，不影响使用
    }
  }

  /// 探针确认掉回登录页：按恢复链裁决下一步，全程盖住不闪登录页。
  Future<void> _onLoginPageDetected() async {
    // 挂起的提交超过 6 秒还没进控制台 = 这次登录没成：丢弃挂起；
    // 若是自动提交的，置凭据拦截（落盘），防旧密码反复去撞登录冻结。
    final pendingAt = _pendingSubmitAt;
    if (_pendingSubmit != null &&
        pendingAt != null &&
        DateTime.now().difference(pendingAt) > const Duration(seconds: 6)) {
      final wasAuto = _pendingSubmitAuto;
      _pendingSubmit = null;
      _pendingSubmitAt = null;
      if (wasAuto) {
        _autoLogin.credentialBlocked = true;
        await _settings?.setCredentialBlocked(true);
        debugPrint('QFLOGIN credential auto-login failed -> blocked');
      }
    }
    // 手动退出后：只保证登录页露出来，绝不恢复
    if (_autoLogin.suppressedByManualLogout) {
      if (!_injectedThisLoad) {
        await _injectBridge(fillSaved: false);
        _injectedThisLoad = true;
      }
      if (mounted && (_recoveryCover || _splashVisible)) {
        setState(() {
          _recoveryCover = false;
          _splashVisible = false;
        });
      }
      return;
    }
    if (!_episodeActive) {
      _episodeActive = true;
      _autoLogin.beginEpisode();
    }
    // 上一步还在等结果（刷新/提交后给页面留时间），盖子保持
    final wait = _stepWaitUntil;
    if (wait != null && DateTime.now().isBefore(wait)) {
      if (mounted && !_recoveryCover) {
        setState(() {
          _recoveryCover = true;
          _splashVisible = true;
        });
      }
      return;
    }
    _stepWaitUntil = null;
    final hasSession = _savedSession?.isFresh(DateTime.now()) ?? false;
    final hasCreds = _savedCreds != null;
    final step =
        _autoLogin.next(hasFreshSession: hasSession, hasCredentials: hasCreds);
    if (step == RecoveryStep.stop) {
      // 没得恢复（或已试完）：有凭据就只回填不提交，最后露登录页
      if (hasCreds && !_filledThisLoad) {
        await _injectBridge(fillSaved: true);
      } else if (!_injectedThisLoad) {
        await _injectBridge(fillSaved: false);
        _injectedThisLoad = true;
      }
      final hadAttempts =
          _autoLogin.sessionAttempts + _autoLogin.credentialAttempts > 0;
      _episodeActive = false;
      if (mounted && (_recoveryCover || _splashVisible)) {
        setState(() {
          _recoveryCover = false;
          _splashVisible = false;
        });
      }
      if (hadAttempts && !_failureSnackShown && mounted) {
        _failureSnackShown = true;
        _snack('自动登录没有成功，请重新登录。');
      }
      return;
    }
    if (mounted && !_recoveryCover) {
      setState(() {
        _recoveryCover = true;
        _splashVisible = true;
      });
    }
    _autoLogin.recordAttempt(step);
    if (step == RecoveryStep.restoreSession) {
      debugPrint('QFLOGIN recovery: session restore');
      await _applySessionSnapshot(_savedSession!);
      _stepWaitUntil = DateTime.now().add(const Duration(seconds: 6));
      await _web?.reload();
    } else if (step == RecoveryStep.credentialLogin) {
      debugPrint('QFLOGIN recovery: credential silent login');
      await _injectBridge(fillSaved: true);
      await Future<void>.delayed(const Duration(milliseconds: 450));
      _autoSubmitInFlight = true;
      final clicked = await _evalJsBool(kSubmitLoginJs);
      debugPrint('QFLOGIN silent submit clicked=$clicked');
      Future<void>.delayed(
          const Duration(seconds: 2), () => _autoSubmitInFlight = false);
      _stepWaitUntil = DateTime.now().add(const Duration(seconds: 8));
    }
  }

  /// 把会话快照塞回 WebView 的 CookieManager（带回原 30 天到期时间）。
  Future<void> _applySessionSnapshot(SessionSnapshot snap) async {
    final cm = CookieManager.instance();
    final expires = snap.savedAt.add(kSessionLifetime);
    for (final e in snap.cookies.entries) {
      try {
        await cm.setCookie(
          url: WebUri(kServerOrigin),
          name: e.key,
          value: e.value,
          expiresDate: expires.millisecondsSinceEpoch,
          domain: kServerHost,
          path: '/',
          isSecure: true,
        );
      } catch (_) {
        // 单颗塞不回不中断：其余继续，刷新后探针会裁决成败
      }
    }
  }

  /// 手动退出账号（页面内点退出、跳 /logout、原生菜单点退出都汇到这里）：
  /// 置闸停自动恢复 + 清会话、清凭据、清记住标记。重复调用无副作用。
  void _noteManualLogout() {
    if (_autoLogin.suppressedByManualLogout && _savedCreds == null) return;
    _autoLogin.onManualLogout();
    _pendingSubmit = null;
    _pendingSubmitAt = null;
    _episodeActive = false;
    _stepWaitUntil = null;
    _failureSnackShown = false;
    debugPrint('QFLOGIN manual logout: clearing auth state');
    unawaited(_clearAuthState());
    if (mounted && (_recoveryCover || _splashVisible)) {
      setState(() {
        _recoveryCover = false;
        _splashVisible = false;
      });
    }
  }

  Future<void> _clearAuthState() async {
    try {
      await _credStore.clearAll();
    } catch (_) {}
    _savedCreds = null;
    _savedSession = null;
    _lastSnapshotAt = null;
    try {
      await _settings?.clearAuthPrefs();
    } catch (_) {}
    try {
      await CookieManager.instance().deleteAllCookies();
    } catch (_) {}
  }

  /// 原生菜单「退出账号」：清干净后走服务端登出地址回登录页。
  Future<void> _manualLogoutFromMenu() async {
    _noteManualLogout();
    await _web?.loadUrl(
        urlRequest: URLRequest(url: WebUri('$kServerOrigin/logout')));
    if (mounted) _snack('已退出账号');
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
      if (manual && mounted) _snack('检查更新失败：无法连接服务器，请检查网络后重试。');
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
      _snack('安装包打开失败（${result.message}），文件位于：${file.path}');
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
        if (mounted && !_recoveryCover) setState(() => _splashVisible = false);
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
      // 正在自动恢复登录时不退场：盖住登录页，恢复完（或失败）再由恢复链退
      if (mounted && !_recoveryCover) setState(() => _splashVisible = false);
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
      SnackBar(
        content: Text(msg),
        action: action,
        backgroundColor: const Color(0xFF1F2D47),
        duration: const Duration(seconds: 4),
        behavior: SnackBarBehavior.floating,
        margin: const EdgeInsets.fromLTRB(16, 0, 16, 16),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      ),
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
      case 'lock':
        Navigator.of(context).push(
          MaterialPageRoute<void>(
            builder: (_) => LockPage(
              palette: _palette,
              onNeedLogin: () {
                Navigator.of(context).pop();
                _web?.loadUrl(urlRequest: URLRequest(url: WebUri(SvcUrls.instance.friendsUrl)));
              },
            ),
          ),
        );
        break;
      case 'logout':
        _manualLogoutFromMenu();
        break;
      case 'admin':
        _openAdmin();
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
        fetchPoints: () => _extService.fetchMe(),
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
                      onFriends: () => _web?.loadUrl(urlRequest: URLRequest(url: WebUri(SvcUrls.instance.friendsUrl))),
                      onForum: () => _web?.loadUrl(urlRequest: URLRequest(url: WebUri(SvcUrls.instance.forumUrl))),
                      onRegister: () => _web?.loadUrl(urlRequest: URLRequest(url: WebUri(SvcUrls.instance.registerUrl))),
                      showAdmin: _isAdmin,
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
                            _registerLoginHandlers(controller);
                            _startWatchdog();
                            _startLoginLoop();
                          },
                          shouldOverrideUrlLoading: (controller, action) async {
                            final url = action.request.url;
                            if (url == null) return NavigationActionPolicy.CANCEL;
                            // 跳登出地址 = 本人手动退出：先记下，别被自动恢复拉回来
                            if (url.path == '/logout') _noteManualLogout();
                            if (url.scheme == 'http' || url.scheme == 'https') {
                              return NavigationActionPolicy.ALLOW;
                            }
                            return NavigationActionPolicy.CANCEL;
                          },
                          onLoadStart: (controller, url) {
                            _mainFrameFailed = false;
                            if (url != null) {
                              _currentUrl = url.toString();
                              _injectedThisLoad = false;
                              _filledThisLoad = false;
                            }
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
                            if (url != null) _currentUrl = url.toString();
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
                          SplashView(
                            palette: _palette,
                            version: _currentVersion,
                            note: _recoveryCover ? '正在恢复登录…' : null,
                          ),
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
