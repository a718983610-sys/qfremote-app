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
import 'core/client_header.dart';
import 'core/constants.dart';
import 'core/license.dart';
import 'core/login_bridge.dart';
import 'core/session_recovery.dart';
import 'core/chat_device.dart';
import 'core/slot_nav.dart';
import 'core/svc_urls.dart';
import 'core/manifest.dart';
import 'core/update_policy.dart';
import 'core/version.dart';
import 'core/watchdog_core.dart';
import 'services/credential_store.dart';
import 'services/device_code.dart';
import 'services/device_key_vault.dart';
import 'services/forum_sso.dart';
import 'services/license_client.dart';
import 'services/points.dart';
import 'services/probe.dart';
import 'services/settings.dart';
import 'services/updater.dart';
import 'ui/about.dart';
import 'ui/force_update.dart';
import 'ui/license_gate.dart';
import 'ui/license_section.dart';
import 'ui/lock.dart';
import 'ui/overlays.dart';
import 'ui/frame.dart';
import 'ui/me_page.dart';
import 'ui/web_page.dart';
import 'ui/settings_page.dart';
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
      // 深色定义补齐（与品牌令牌同一种子色）：Material 层控件跟随系统深浅；
      // 壳内自绘面（工具栏/卡片等）走 QfPalette 双主题令牌，口径一致。
      darkTheme: ThemeData(
        colorScheme: ColorScheme.fromSeed(
          seedColor: const Color(0xFF2470E0),
          brightness: Brightness.dark,
        ),
        useMaterial3: true,
      ),
      themeMode: ThemeMode.system,
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
    if (c == null) throw StateError('页面尚未就绪');
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
/// 页面下载失败的用户面文案映射（H-5）：异常原文不上屏（VM-03 口径），
/// 按异常类型归一到正式中文。自抛的中文 FormatException 原样透传。
String pageDownloadFailureText(Object e) {
  if (e is FormatException) {
    return e.message.isNotEmpty ? e.message : '下载失败，请稍后重试。';
  }
  if (e is TimeoutException) {
    return '下载中断，网络不稳定，请重新下载。';
  }
  if (e is SocketException ||
      e is HttpException ||
      e is HandshakeException ||
      e is TlsException) {
    return '下载失败：无法连接服务器，请检查网络后重试。';
  }
  if (e is FileSystemException) {
    return '保存失败，请检查存储空间或权限后重试。';
  }
  return '下载失败，请稍后重试。';
}

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

  /// 凭据/快照落盘串行链（深查修复）：退出清库与紧接着的重登存凭据都是
  /// 异步写，若并发交叉，慢到的清库会把刚存好的新凭据抹掉。所有写操作
  /// 一律排进这条链按发生顺序执行，读操作不进链（内存镜像先行更新）。
  Future<void> _authChain = Future<void>.value();

  Future<void> _enqueueAuth(Future<void> Function() op) {
    final run = _authChain.then((_) async {
      try {
        await op();
      } catch (_) {
        // 单步失败不许毒死整条链
      }
    });
    _authChain = run;
    return run;
  }
  final _deviceKeyVault = DeviceKeyVault();
  final _forumSso = ForumSso();

  // 2.3.0 追加五/六：框架槽位（设备/好友/论坛三 WebView 保活＋我的原生页）。
  // 2.3.1 阶段 D：底部导航改名改序为 首页/文件/设备/我的，默认落地首页槽；
  // 好友/论坛槽保留保活（首页长页快速入口与顶栏菜单可达）。
  AppSlot _slot = AppSlot.home;
  final SlotLoadTracker _slotLoads = SlotLoadTracker();
  InAppWebViewController? _homeWeb;
  InAppWebViewController? _filesWeb;
  InAppWebViewController? _friendsWeb;
  InAppWebViewController? _forumWeb;
  bool _homeCanGoBack = false;
  bool _filesCanGoBack = false;
  String _friendsCurrentUrl = '';
  bool _friendsCanGoBack = false;
  bool _forumCanGoBack = false;

  // 2.3.1 许可全链（阶段 D）：设备码上报→许可判定→原生拦截面。
  LicenseClient? _licenseClient;
  final _deviceCodeStore = DeviceCodeStore();
  String? _deviceCode;

  /// 非空＝当前落原生许可拦截面（build 直接渲染拦截页，盖住全部槽位）。
  LicenseDecision? _gateDecision;

  /// 本次控制台会话已跑过许可门检查（每会话只跑一次，防 2 秒探针反复打）。
  bool _licenseCheckedThisSession = false;
  bool _licenseCheckBusy = false;
  bool _licenseErrorSnacked = false;

  /// 本次登录流程内验过的凭据（只在内存，绝不落盘）：拦截面领取转赠时
  /// 按契约 §7.5.5 由壳随请求带上（用户只粘贴密钥串、不重复输密码）。
  ({String username, String password})? _gateCreds;
  String _gateUsername = '';
  bool _chromeVisible = false; // 登录前不显示顶栏/标签（样图 m01 登录页无框架）
  bool _slotsPreloaded = false;
  final _autoLogin = AutoLoginController();
  SavedCredentials? _savedCreds;
  SessionSnapshot? _savedSession;
  Timer? _loginTimer;
  bool _loginTickBusy = false;
  String _currentUrl = '';
  // 一轮掉登录（episode）的生命周期：一轮只从「新页面加载」或「刚还在控制台、
  // 现在掉回登录页」的跳变开始；试完（_episodeFinished）就锁死本轮，绝不因为
  // 探针下一拍又看到登录页就重开一轮——那会让凭据被反复自动提交、撞登录冻结。
  bool _episodeRunning = false;
  bool _episodeFinished = false;
  String _prevProbeState = 'unknown';
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

  LicenseClient get _licenseService => _licenseClient ??=
      LicenseClient(cookieProvider: _consoleCookieHeader);

  /// 许可/积分拉取的未登录短路（SUP-P0-06）：「我的」槽在 IndexedStack 里
  /// 常驻构建，其许可区与积分会在未登录时也急切拉取、成对空打 401。
  /// 未检出登录（chrome 未出现）前一律不发请求、按无数据处理；登录检出
  /// 后 MePage 随 chrome 翻转重建（build 里 key 绑定），届时再真拉。
  Future<PointsInfo?> _fetchPointsWhenLoggedIn() =>
      _chromeVisible ? _extService.fetchMe() : Future<PointsInfo?>.value();

  Future<List<MyLicenseKey>?> _fetchMyKeysWhenLoggedIn() => _chromeVisible
      ? _licenseService.fetchMyKeys()
      : Future<List<MyLicenseKey>?>.value();

  String get _currentVersion => _pkg?.version ?? kAppVersion;
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

  /// 系统深浅切换时跟随（仅限从没手动选过主题的用户；选过的听用户的）。
  @override
  void didChangePlatformBrightness() {
    super.didChangePlatformBrightness();
    final s = _settings;
    if (s == null || !mounted) return;
    if (s.themePref != null && s.themePref!.isNotEmpty) return;
    setState(() {
      _themeMode = resolveThemeMode(
        pref: null,
        platformBrightness:
            WidgetsBinding.instance.platformDispatcher.platformBrightness,
      );
    });
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
    if (settings.credentialBlocked &&
        (_savedCreds != null || _savedSession != null)) {
      // 凭据自愈（SUP-P0-06）：拦截标记在册＝本机存档凭据已被服务端明确
      // 拒过（旧版本只置闸、没清存档）；开机先清掉，免得带着旧名旧密码
      // 再进恢复链。本版本起置闸时已同步清存档，此处只兜旧版存量。
      try {
        await _credStore.clearAll();
      } catch (_) {}
      _savedCreds = null;
      _savedSession = null;
    }
    final canRecover = (_savedCreds != null ||
            (_savedSession?.isFresh(DateTime.now()) ?? false)) &&
        (settings.rememberDevice || settings.rememberPassword);
    if (canRecover) {
      // 只先盖住；episode 由登录探针在确认掉登录后正式开启
      _recoveryCover = true;
    }
    if (!mounted) return;
    setState(() {
      _settings = settings;
      _pkg = pkg;
      _themeMode = resolveThemeMode(
        pref: settings.themePref,
        platformBrightness:
            WidgetsBinding.instance.platformDispatcher.platformBrightness,
      );
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
  /// 2.3.1：心跳响应带 forceLogout 信号（契约 §7.5.7，转赠领取后原主人
  /// 即时下线）时立即执行登出＋落 G1 拦截，不许延迟到下次冷启动。
  Future<void> _heartbeatTick() async {
    if (!mounted || !_foreground) return;
    final cookie = await _consoleCookieHeader();
    if (cookie == null) return;
    _heartbeatTicks++;
    final signal = await _extService.heartbeatSignal();
    if (signal != null && signal.forceLogout) {
      await _handleForceLogoutSignal(signal.gateCode ?? 'G1');
      return;
    }
    if (_heartbeatTicks % 5 == 1) {
      final admin = await _extService.checkIsAdmin();
      if (mounted && admin != _isAdmin) setState(() => _isAdmin = admin);
    }
  }

  /// 打开站长管理页：先用控制台会话换一次性令牌，再以壳内页打开管理页
  /// （收编 P1：不再劫持设备槽 WebView，令牌 URL 口径不变）；
  /// 换不到令牌时直接打开管理页（服务端会自行走登录）。
  Future<void> _openAdmin() async {
    final token = await _extService.fetchSsoToken();
    if (!mounted) return;
    final url = token != null
        ? SvcUrls.instance.adminLoginUrl(token)
        : SvcUrls.instance.adminUrl;
    await _openShellWeb('管理', url);
  }

  // ---------------- 许可全链（2.3.1 阶段 D） ----------------

  /// 控制台会话建立成功后立即执行（契约 §3 写死时机，先于任何设备连接
  /// 动作）：上报设备码 → 读许可判定 → 按裁决落原生拦截面。
  /// 每会话只跑一次；接口失败不拦人，只给一次诚实提示（不许拿假状态冒充）。
  Future<void> _runLicenseGateCheck() async {
    if (_licenseCheckedThisSession || _licenseCheckBusy) return;
    _licenseCheckedThisSession = true;
    _licenseCheckBusy = true;
    try {
      _deviceCode ??= await _deviceCodeStore.getOrCreate();
      final report = await _licenseService.deviceReport(_deviceCode!);
      if (!mounted) return;
      if (report != null) {
        final action = resolveGateAction(
          decision: report.decision ??
              (report.reviewPending
                  ? const LicenseDecision(allow: false, code: 'DEVICE_REVIEW')
                  : null),
          fromDeviceReport: true,
          reviewPending: report.reviewPending,
          // 待审与转赠门同走 forceLogout 字段：待审优先落 DEVICE_REVIEW 面
          forceLogoutSignal:
              report.deviceForceLogout && !report.reviewPending,
        );
        if (await _applyGateAction(action)) {
          return;
        }
      }
      final me = await _licenseService.fetchLicenseMe();
      if (!mounted) return;
      if (me != null) {
        if (me.username != null && me.username!.isNotEmpty) {
          _gateUsername = me.username!;
        }
        final action = resolveGateAction(
          decision: me.decision,
          forceLogoutSignal: me.forceLogout,
          forceLogoutGateCode: me.gateCode,
        );
        if (await _applyGateAction(action)) {
          return;
        }
      }
      if (report == null && me == null && !_licenseErrorSnacked) {
        _licenseErrorSnacked = true;
        _snack('许可信息读取失败，请检查网络后重试。');
      }
    } catch (_) {
      // 许可检查本身失败不锁死使用：口径同上，只提示不拦截
      if (mounted && !_licenseErrorSnacked) {
        _licenseErrorSnacked = true;
        _snack('许可信息读取失败，请检查网络后重试。');
      }
    } finally {
      _licenseCheckBusy = false;
    }
  }

  /// 执行门裁决。返回 true＝已落拦截/登出态，调用方到此为止。
  Future<bool> _applyGateAction(GateAction action) async {
    switch (action.kind) {
      case GateActionKind.none:
        return false;
      case GateActionKind.showGate:
        if (mounted) setState(() => _gateDecision = action.decision);
        return true;
      case GateActionKind.deviceReview:
        // §7.6：待审期间强制登出该设备会话＋落「设备异常登录」面。
        // 复用手动退出的清会话收口（停自动恢复），但这不是用户手动退出。
        final keepCreds = _gateCreds;
        _noteManualLogout();
        _gateCreds = keepCreds;
        if (mounted) {
          setState(() => _gateDecision = action.decision ??
              const LicenseDecision(
                  allow: false, code: 'DEVICE_REVIEW', enforce: true));
        }
        return true;
      case GateActionKind.forceLogoutToGate:
        await _handleForceLogoutSignal(action.decision?.code ?? 'G1');
        return true;
    }
  }

  /// forceLogout 即时执行（契约 §7.5.7）：立即登出本端会话并落拦截态，
  /// 不许延迟到下次冷启动。服务端已同步撤销原会话，本机只做清场＋落面。
  Future<void> _handleForceLogoutSignal(String gateCode) async {
    if (!mounted) return;
    if (_gateDecision?.forceLogout == true) return; // 已在强制下线拦截态
    final code = gateCode.isNotEmpty ? gateCode : 'G1';
    // 内存核验凭据保全：落 G1 面后领取转赠还要用（§7.5.5 壳带凭据口径）；
    // 清掉的是会话与落盘凭据，不含这份仅内存的核验材料。
    final keepCreds = _gateCreds ??
        (_savedCreds != null
            ? (username: _savedCreds!.username, password: _savedCreds!.password)
            : null);
    _noteManualLogout();
    _gateCreds = keepCreds;
    if (mounted) {
      setState(() {
        _gateDecision = LicenseDecision(
          allow: false,
          code: code,
          enforce: true,
          forceLogout: true,
          banCode: null,
        );
      });
    }
  }

  /// 拦截面「重新检查」/购买返回后复查：判定放行（或影子只记录）即消解
  /// 拦截；仍是 enforce 的未允许判定则换上最新拦截面。
  Future<void> _recheckLicense() async {
    final me = await _licenseService.fetchLicenseMe();
    if (!mounted) return;
    if (me == null) {
      _snack('许可信息读取失败，请检查网络后重试。');
      return;
    }
    final action = resolveGateAction(
      decision: me.decision,
      forceLogoutSignal: me.forceLogout,
      forceLogoutGateCode: me.gateCode,
    );
    if (action.kind == GateActionKind.none) {
      setState(() => _gateDecision = null);
      _licenseCheckedThisSession = false;
      _snack('状态已更新。');
    } else if (action.kind == GateActionKind.showGate) {
      setState(() => _gateDecision = action.decision);
    }
  }

  /// 拦截面/「我的」页领取转赠（契约 §7.5.3）：本次登录已验密时由壳带
  /// 账号＋凭据走无会话入口（只核验不签发），否则走已登录入口。
  Future<LicenseOpResult?> _claimFromShell(String key) async {
    final creds = _gateCreds;
    if (creds != null) {
      return _licenseService.claimKey(key,
          username: creds.username, password: creds.password);
    }
    return _licenseService.claimKey(key);
  }

  /// 打开换绑申诉页（§11.9）：由壳自动带入本机设备码，用户不手填。
  Future<void> _openRebind() async {
    _deviceCode ??= await _deviceCodeStore.getOrCreate();
    await _openShellWeb('申诉换绑设备',
        '${SvcUrls.instance.rebindUrl}?dc=${Uri.encodeQueryComponent(_deviceCode ?? '')}&platform=mobile&ch=android');
  }

  /// 在壳内打开自有网页（购买/查询/申诉/客服）：先移植会话，再推壳内页。
  Future<void> _openShellWeb(String title, String url) async {
    // 打开前顺手刷新服务地址解析：此前解析失败过的，本次重试（H-6 的
    // 失败不缓存与此配合）；当次 url 由调用方以 getter 取值，getter 的
    // 退役源过滤＋正式兜底保证不落死链（H-1）。
    await SvcUrls.instance.ensureResolved();
    await _transplantSessionToExt();
    if (!mounted) return;
    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => ShellWebPage(palette: _palette, title: title, url: url),
      ),
    );
  }

  /// 打开论坛（2.3.0 追加·单次登录硬门）：论坛服务只认自家会话 cookie，
  /// 没有会话且本机存有凭据时，先用凭据换回论坛会话写入 WebView 再打开，
  /// 用户不再被要求二次登录；换不到就照常打开（论坛页自行处理）。
  // ---------------- 框架槽位（追加五/六） ----------------

  InAppWebViewController? get _activeWeb => switch (_slot) {
        AppSlot.home => _homeWeb,
        AppSlot.files => _filesWeb,
        AppSlot.devices => _web,
        AppSlot.friends => _friendsWeb,
        AppSlot.forum => _forumWeb,
        AppSlot.me => null,
      };

  String get _slotTitle => switch (_slot) {
        AppSlot.home => '首页',
        AppSlot.files => '我的文件',
        AppSlot.devices => '我的设备',
        AppSlot.friends => '好友',
        AppSlot.forum => '论坛',
        AppSlot.me => '我的',
      };

  /// 切槽：已加载过的槽直接显示（保活，不重载、不闪白）；
  /// 没加载过的按登录态首次加载。
  void _activateSlot(AppSlot slot) {
    if (_slot != slot) setState(() => _slot = slot);
    _maybeLoadSlot(slot);
  }

  void _maybeLoadSlot(AppSlot slot) {
    if (slot == AppSlot.home) {
      if (_homeWeb != null && _slotLoads.needsLoad(AppSlot.home)) {
        _slotLoads.markLoaded(AppSlot.home);
        unawaited(_ensureHomeLoaded());
      }
    } else if (slot == AppSlot.files) {
      if (_filesWeb != null && _slotLoads.needsLoad(AppSlot.files)) {
        _slotLoads.markLoaded(AppSlot.files);
        // 文件槽＝控制台文件管理（本体在控制台页内，壳不另造文件逻辑）
        _filesWeb?.loadUrl(urlRequest: URLRequest(url: WebUri(_startUrl)));
      }
    } else if (slot == AppSlot.friends) {
      if (_friendsWeb != null && _slotLoads.needsLoad(AppSlot.friends)) {
        _slotLoads.markLoaded(AppSlot.friends);
        _friendsWeb?.loadUrl(
            urlRequest: URLRequest(url: WebUri(SvcUrls.instance.friendsUrl)));
      }
    } else if (slot == AppSlot.forum) {
      if (_forumWeb != null && _slotLoads.needsLoad(AppSlot.forum)) {
        unawaited(_ensureForumLoaded());
      }
    }
  }

  /// 把控制台会话 cookie 移植到扩展服务源：安卓登录发生在直连控制台，
  /// cookie 只在直连源上；扩展服务（新首页/购买/许可页）与积分同口径认
  /// xid——先把同一组 cookie 种到扩展源，WebView 打开这些页时即同源带上，
  /// 不再被要求二次登录（与论坛免登桥同一种移植手法）。
  Future<void> _transplantSessionToExt() async {
    try {
      final cookies =
          await CookieManager.instance().getCookies(url: WebUri(kServerOrigin));
      final origin = SvcUrls.instance.extOrigin;
      for (final c in cookies) {
        final v = c.value.toString();
        if ((c.name == 'xid' || c.name == 'xid.sig' || c.name == 'qfrem') &&
            v.isNotEmpty) {
          await CookieManager.instance().setCookie(
            url: WebUri(origin),
            name: c.name,
            value: v,
            path: '/',
          );
        }
      }
    } catch (_) {
      // 移植失败不挡路：页面打开后由服务端自行走登录/核验
    }
  }

  /// 首页槽首次加载：先等服务地址解析＋移植会话，再打开网页新首页正本
  /// （壳内同框呈现，不整页外跳）。
  Future<void> _ensureHomeLoaded() async {
    if (_homeWeb == null) return;
    await SvcUrls.instance.ensureResolved();
    await _transplantSessionToExt();
    if (!mounted) return;
    _homeWeb?.loadUrl(
        urlRequest: URLRequest(url: WebUri(SvcUrls.instance.homeUrl)));
  }

  /// 登录成功后预加载首页/好友/论坛槽（再次点开即达）。
  void _preloadSlots() {
    if (_slotsPreloaded) return;
    _slotsPreloaded = true;
    _maybeLoadSlot(AppSlot.home);
    _maybeLoadSlot(AppSlot.friends);
    _maybeLoadSlot(AppSlot.forum);
  }

  /// 好友/论坛槽的 WebView 设置（与控制台同口径：脚本/存储/三方 cookie 全开）。
  InAppWebViewSettings _slotWebViewSettings() => InAppWebViewSettings(
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
        // target=_blank / window.open 不另开窗：onCreateWindow 里就地打开
        supportMultipleWindows: true,
      );

  /// 新窗口请求（target=_blank 等）就地打开：不跳外部浏览器、不丢当前页
  /// 上下文（页面返回键仍可回）。返回 false＝不创建新窗口。
  Future<bool> _onCreateWindowInPlace(
      InAppWebViewController controller, CreateWindowAction action) async {
    final u = action.request.url;
    if (u != null && (u.scheme == 'http' || u.scheme == 'https')) {
      try {
        await controller.loadUrl(urlRequest: URLRequest(url: u));
      } catch (_) {}
    }
    return false;
  }

  /// 槽内内容页（好友/聊天/论坛）加载完成：藏掉页面自带顶/底栏（壳框架
  /// 即定版框架，见 slot_nav.dart 的口径说明），功能与内容不动。
  Future<void> _injectShellChrome(
      InAppWebViewController controller, WebUri? url) async {
    if (!isShellContentPage(url?.toString())) return;
    try {
      await controller.evaluateJavascript(source: buildShellChromeHideScript());
    } catch (_) {
      // 页面已切走：下一页加载完成时再注入
    }
  }

  /// 槽内导航口径（与控制台一致）：跳登出地址＝手动退出；只放行 http/https。
  Future<NavigationActionPolicy?> _slotUrlPolicy(
      InAppWebViewController controller, NavigationAction action) async {
    final url = action.request.url;
    if (url == null) return NavigationActionPolicy.CANCEL;
    // /logout 只认自有服务源：外站同名路径不许误触发手动退出清凭据
    if (url.path == '/logout' && SvcUrls.instance.isOwnOrigin(url.toString())) {
      _noteManualLogout();
    }
    if (url.scheme == 'http' || url.scheme == 'https') {
      return NavigationActionPolicy.ALLOW;
    }
    return NavigationActionPolicy.CANCEL;
  }

  /// 证书挑战（与控制台一致）：只认自家主机＋端口，其余拒绝。
  Future<ServerTrustAuthResponse> _onTrustChallenge(
      InAppWebViewController controller,
      URLAuthenticationChallenge challenge) async {
    final host = challenge.protectionSpace.host;
    final port = challenge.protectionSpace.port;
    final ok = port != null && isTrustedWebViewHostPort(host, port);
    return ServerTrustAuthResponse(
      action: ok
          ? ServerTrustAuthResponseAction.PROCEED
          : ServerTrustAuthResponseAction.CANCEL,
    );
  }

  /// 系统返回键分级：先页内后退 → 再回设备槽 → 最后退出（纯裁决见 slot_nav）。
  Future<void> _handleSystemBack() async {
    final can = switch (_slot) {
      AppSlot.home => _homeCanGoBack,
      AppSlot.files => _filesCanGoBack,
      AppSlot.devices => _canGoBack,
      AppSlot.friends => _friendsCanGoBack,
      AppSlot.forum => _forumCanGoBack,
      AppSlot.me => false,
    };
    final action = decideBackAction(active: _slot, activeCanGoBack: can);
    switch (action) {
      case BackAction.pageBack:
        await _activeWeb?.goBack();
      case BackAction.toDevices:
        _activateSlot(AppSlot.devices);
      case BackAction.exitApp:
        await SystemNavigator.pop();
    }
  }

  /// 打开论坛槽：先走免登桥（无会话且有已存凭据时换回 qfr_frm），
  /// 再把论坛页加载进论坛槽（保活，后续点开不再重载）。
  Future<void> _ensureForumLoaded() async {
    if (_forumWeb == null || !_slotLoads.needsLoad(AppSlot.forum)) return;
    _slotLoads.markLoaded(AppSlot.forum);
    final forumUrl = SvcUrls.instance.forumUrl;
    var loadUrl = forumUrl;
    try {
      final pageUri = Uri.parse(forumUrl);
      final origin = Uri(
        scheme: pageUri.scheme,
        host: pageUri.host,
        port: pageUri.hasPort ? pageUri.port : null,
      );
      final cookieHeader = await _consoleCookieHeader() ?? '';
      final user = await _forumSso.me(origin, cookieHeader);
      if (user == null &&
          !(_settings?.credentialBlocked ?? false) &&
          !(_autoLogin.suppressedByManualLogout)) {
        // 先走服务端令牌交接（只认控制台会话，不依赖本机存密码）；
        // 拿到令牌就改加载交接地址，服务端种 qfr_frm 后自回 /forum。
        final token = await _forumSso.ssoToken(origin, cookieHeader);
        if (token != null) {
          loadUrl = _forumSso.ssoLoginUrl(origin, token);
        } else {
          final creds = _savedCreds ?? await _credStore.loadCredentials();
          if (creds != null) {
            final frm = await _forumSso.login(
                origin, creds.username, creds.password);
            if (frm != null) {
              await CookieManager.instance().setCookie(
                url: WebUri(origin.toString()),
                name: 'qfr_frm',
                value: frm,
                path: '/',
              );
            }
          }
        }
      }
    } catch (_) {
      // 免登桥失败不挡路：照常加载论坛页
    }
    if (!mounted) return;
    _forumWeb?.loadUrl(urlRequest: URLRequest(url: WebUri(loadUrl)));
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
    // 2.3.1 登录页版式（16:37 定版）：桥注入的「购买密钥/查询密钥」两行
    // 点击回传——壳内打开 /purchase 或 /license/status，不外跳。
    controller.addJavaScriptHandler(
      handlerName: kHandlerLicenseNav,
      callback: (args) {
        if (args.isEmpty || args.first is! Map) return;
        final target = (args.first as Map)['target']?.toString();
        if (target == 'purchase') {
          unawaited(_openShellWeb('购买密钥', SvcUrls.instance.purchaseUrl));
        } else if (target == 'status') {
          unawaited(
              _openShellWeb('查询密钥', SvcUrls.instance.licenseStatusUrl));
        } else if (target == 'rebind') {
          unawaited(_openRebind());
        }
      },
    );
    // 设备钥匙递入走 evaluateJavascript 直调页面钩子（L 线定版契约
    // qfShellDeviceUnlock/qfShellDeviceEnroll，在 _chatTick 里按决策递入），
    // 不再另设 JS 处理器——页面不主动取钥匙，钥匙只经壳单向递入内存。
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

  /// 聊天页判定：好友槽当前页为 /chat（聊天随好友槽保活，追加五）。
  bool get _isChatPage {
    if (kHasTestUrl) return false;
    final uri = Uri.tryParse(_friendsCurrentUrl);
    if (uri == null) return false;
    return uri.path == '/chat' || uri.path.startsWith('/chat/');
  }

  /// 聊天页一拍（对好友槽的控制器）：解锁编排按追加八绝对口径——
  /// 会话托管取回 → 设备副本 → 已存凭据（仅迁移源、程序调用无界面），
  /// 全程不出现任何输密码解锁界面；解锁后无托管/设备副本时后台补发补写。
  /// 编排裁决在 chat_device.dart 的 planChatUnlock；本拍没走解锁步时才落
  /// 登录兜底桥（那是聊天令牌失效＝未登录，与解锁无关）。
  Future<void> _chatTick() async {
    final web = _friendsWeb;
    if (web == null) return;
    // 已存凭据先备好（裁决要用；凭据在这里只是解锁迁移源，不进任何界面）
    String? user, pass;
    if ((_settings?.rememberPassword ?? false) &&
        !(_settings?.credentialBlocked ?? false) &&
        !_autoLogin.suppressedByManualLogout) {
      final creds = _savedCreds ?? await _credStore.loadCredentials();
      if (creds != null) {
        user = creds.username;
        pass = creds.password;
      }
    }
    var orchestrated = false;
    try {
      final raw = await web.evaluateJavascript(source: kChatStateProbeJs);
      final st = parseChatState(raw?.toString());
      if (st != null) {
        final capsRaw = await web.evaluateJavascript(source: kChatCapsProbeJs);
        final caps = parseChatCaps(capsRaw?.toString());
        final step = planChatUnlock(
          manualLogout: _autoLogin.suppressedByManualLogout,
          state: st,
          caps: caps,
          hasCreds: pass != null && pass.isNotEmpty,
        );
        switch (step) {
          case ChatUnlockStep.custodyUnlock:
            final r = await web.evaluateJavascript(
                source: buildChatCustodyUnlockScript());
            debugPrint('QFCHAT custody-unlock -> $r');
            orchestrated = true;
          case ChatUnlockStep.deviceUnlock:
          case ChatUnlockStep.deviceEnroll:
            final key = await _deviceKeyVault.getOrCreate();
            final script = step == ChatUnlockStep.deviceUnlock
                ? buildChatDeviceUnlockScript(key)
                : buildChatDeviceEnrollScript(key);
            final r = await web.evaluateJavascript(source: script);
            debugPrint('QFCHAT $step -> $r');
            orchestrated = true;
          case ChatUnlockStep.credentialUnlock:
            final r = await web.evaluateJavascript(
                source: buildChatCredentialUnlockScript(pass!));
            debugPrint('QFCHAT credential-unlock -> $r');
            orchestrated = true;
          case ChatUnlockStep.custodyEnroll:
            final r = await web.evaluateJavascript(
                source: buildChatCustodyEnrollScript());
            debugPrint('QFCHAT custody-enroll -> $r');
            orchestrated = true;
          case ChatUnlockStep.none:
            break;
        }
      }
    } catch (_) {
      // 页面未就绪（钩子还没挂）：落到登录兜底桥，本拍继续
    }
    if (orchestrated) return; // 已走解锁步的拍不再叠加注入
    try {
      final r = await web.evaluateJavascript(
          source: buildChatBridgeJs(username: user, password: pass));
      debugPrint('QFCHAT bridge -> $r');
    } catch (_) {
      // 页面正在跳转：下一拍再来
    }
  }

  Future<void> _loginTick() async {
    if (_loginTickBusy || !mounted || _web == null) return;
    if (!_gateDone || _forceEntry != null || _offline) return;
    if (_slot == AppSlot.friends && _isChatPage && _friendsWeb != null) {
      _loginTickBusy = true;
      try {
        await _chatTick();
      } finally {
        _loginTickBusy = false;
      }
      return;
    }
    if (!_isConsolePage) return;
    _loginTickBusy = true;
    try {
      final probe = await _probeLogin();
      if (probe == null || !mounted) return;
      if (probe.isConsole) {
        _prevProbeState = 'console';
        await _onConsoleDetected();
      } else if (probe.isLogin) {
        final fromConsole = _prevProbeState == 'console';
        _prevProbeState = 'login';
        await _onLoginPageDetected(fromConsole: fromConsole);
      }
      // unknown：页面还没画完，这一拍不动作、也不覆盖上一个确定状态
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
      // 2.3.1：本次登录已验密的凭据只留内存（拦截面领取转赠时壳随请求
      // 带上，契约 §7.5.5）；落盘口径仍走下面既有的记住密码机制，不另存。
      _gateCreds = (username: pending.username, password: pending.password);
      _gateUsername = pending.username;
      final s = _settings;
      if (s != null) {
        await s.setRememberDevice(pending.rememberDevice);
        await s.setRememberPassword(pending.rememberPassword);
      }
      if (pending.rememberPassword) {
        try {
          await _enqueueAuth(() => _credStore.saveCredentials(pending.username, pending.password));
          _savedCreds = SavedCredentials(
              username: pending.username, password: pending.password);
        } catch (_) {}
      } else {
        try {
          await _enqueueAuth(() => _credStore.clearCredentials());
        } catch (_) {}
        _savedCreds = null;
      }
      if (!pending.rememberDevice && !pending.rememberPassword) {
        // 两个记住都没勾：会话快照也不留（关 App 掉登录是应有之义）
        try {
          await _enqueueAuth(() => _credStore.clearSession());
        } catch (_) {}
        _savedSession = null;
      }
    }
    if (_settings?.credentialBlocked ?? false) {
      await _settings?.setCredentialBlocked(false);
    }
    _autoLogin.onLoginSuccess();
    _episodeRunning = false;
    _episodeFinished = false; // 回到控制台：下一次掉登录算新一轮
    _stepWaitUntil = null;
    _failureSnackShown = false;
    await _maybeSnapshotSession();
    // 已登录：框架顶栏/标签出现，并预加载好友/论坛槽。
    // 落点切回首页槽（阶段 D 定版）：未登录期间 _slot 被收尾逻辑钉在
    // 设备槽（登录页所在，SUP-P0-06），只在 chrome 由无到有这一拍切回；
    // 会话中途掉线又恢复时 chrome 未曾收起，不动用户当前所在槽。
    if (mounted && !_chromeVisible) {
      setState(() {
        _chromeVisible = true;
        _slot = AppSlot.home;
      });
    }
    _preloadSlots();
    // 2.3.1：会话建立成功后立即跑许可门（§3 时机：先于任何设备连接动作；
    // 函数内有每会话一次的守卫，探针反复命中不会重复打）
    unawaited(_runLicenseGateCheck());
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
      await _enqueueAuth(() => _credStore.saveSession(snap));
      _savedSession = snap;
      _lastSnapshotAt = DateTime.now();
      debugPrint('QFLOGIN session snapshot saved (${map.keys.join(',')})');
    } catch (_) {
      // 摘不到就算了：下次探针再试，不影响使用
    }
  }

  /// 探针确认掉回登录页：按恢复链裁决下一步，全程盖住不闪登录页。
  /// [fromConsole]：上一拍还在控制台、这一拍掉回登录页（同页跳变也算新一轮）。
  Future<void> _onLoginPageDetected({required bool fromConsole}) async {
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
        // 凭据自愈（SUP-P0-06）：服务端已明确拒了自动提交的这组凭据
        // （如账号已改名、密码已变更）——本机存档（凭据＋会话快照）一并
        // 清掉并停手，绝不留着到下次冷启动再拿旧名反复自动提交。
        await _purgeRejectedAuth();
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
    // 新一轮的开始：刚从控制台掉下来，或本页还没跑过一轮。
    // 本轮已试完（_episodeFinished）时只做回填/装钩子，绝不重开新一轮。
    if (fromConsole && _episodeFinished) _episodeFinished = false;
    if (_episodeFinished) {
      if ((_savedCreds != null) && !_filledThisLoad) {
        await _injectBridge(fillSaved: true);
      } else if (!_injectedThisLoad) {
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
    if (!_episodeRunning) {
      _episodeRunning = true;
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
      _episodeRunning = false;
      _episodeFinished = true; // 本轮锁死：探针再看到登录页也不重开
      if (mounted && (_recoveryCover || _splashVisible)) {
        setState(() {
          _recoveryCover = false;
          _splashVisible = false;
        });
      }
      if (hadAttempts && !_failureSnackShown && mounted) {
        _failureSnackShown = true;
        _snack('自动登录未成功，请重新登录。');
      }
      // 恢复失败、停在登录页：框架收起并落设备槽——登录页就在设备槽的
      // WebView 里；回首页槽会把人晾在未装载的空白槽上（SUP-P0-06 定性，
      // 此前方向写反了）。登录成功后由 _onConsoleDetected 切回首页槽。
      if (mounted && _chromeVisible) {
        setState(() {
          _chromeVisible = false;
          _slot = AppSlot.devices;
        });
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
    _episodeRunning = false;
    _episodeFinished = true; // 退出后停在登录页：不许再开恢复轮
    _stepWaitUntil = null;
    _failureSnackShown = false;
    debugPrint('QFLOGIN manual logout: clearing auth state');
    // 框架复位：落设备槽（登录页所在，SUP-P0-06；此前写回首页槽会把人
    // 晾在空白槽上）、收起顶栏/标签、槽位账本作废（不残留上个账号页面）；
    // 许可门守卫一并复位，下个会话重新检查。重新登录成功后由
    // _onConsoleDetected 切回首页槽落地。
    _slotsPreloaded = false;
    _licenseCheckedThisSession = false;
    _slotLoads.invalidateAll();
    if (mounted) {
      setState(() {
        _slot = AppSlot.devices;
        _chromeVisible = false;
      });
    }
    unawaited(_clearAuthState());
    if (mounted && (_recoveryCover || _splashVisible)) {
      setState(() {
        _recoveryCover = false;
        _splashVisible = false;
      });
    }
  }

  /// 凭据自愈（SUP-P0-06）：自动提交的凭据被服务端明确拒绝后，清掉本机
  /// 存档（凭据＋会话快照）与内存镜像。此后恢复链无凭据可用、只会停手落
  /// 登录页；用户手动输新凭据登录成功后，按记住勾选重新落盘。
  /// 与手动退出的 _clearAuthState 分工：这里不动 cookie、不清槽位页面、
  /// 不置手动退出闸——用户没退出，只是这组存档凭据作废了。
  Future<void> _purgeRejectedAuth() async {
    try {
      await _enqueueAuth(() => _credStore.clearAll());
    } catch (_) {}
    _savedCreds = null;
    _savedSession = null;
  }

  Future<void> _clearAuthState() async {
    try {
      await _enqueueAuth(() => _credStore.clearAll());
    } catch (_) {}
    // 设备钥匙不清（L 线定版口径：退出登录不等于换设备；副本按账号存
    // 在服务端，本机钥匙留着，下个账号在本机解锁后会补写自己的副本）。
    _savedCreds = null;
    _savedSession = null;
    _lastSnapshotAt = null;
    try {
      await _settings?.clearAuthPrefs();
    } catch (_) {}
    try {
      await CookieManager.instance().deleteAllCookies();
    } catch (_) {}
    // 各 WebView 槽页面清空，防止下个账号看到上个账号的保活页
    try {
      await _homeWeb?.loadUrl(
          urlRequest: URLRequest(url: WebUri('about:blank')));
      await _filesWeb?.loadUrl(
          urlRequest: URLRequest(url: WebUri('about:blank')));
      await _friendsWeb?.loadUrl(
          urlRequest: URLRequest(url: WebUri('about:blank')));
      await _forumWeb?.loadUrl(
          urlRequest: URLRequest(url: WebUri('about:blank')));
    } catch (_) {}
    _friendsCurrentUrl = '';
  }

  /// 原生菜单「退出账号」：清干净后走服务端登出地址回登录页。
  Future<void> _manualLogoutFromMenu() async {
    _gateCreds = null;
    if (_gateDecision != null && mounted) {
      setState(() => _gateDecision = null);
    }
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

  /// 检查更新（四态版，H-2）：取清单失败 / 清单无安卓条目 / 真最新 /
  /// 有新版严格分开。状态副作用（待更新标记、工具栏徽标）只在此一处；
  /// 提示文案不在这里出，由调用方按 updateCheckText 统一映射。
  Future<AboutUpdateResult> _sessionUpdateCheckDetail() async {
    ReleaseManifest manifest;
    try {
      manifest = await _updateService.fetchManifest();
    } catch (e) {
      // 异常原文只进日志，用户面走四态文案（VM-03 口径）。
      debugPrint('QFUPDATE check failed: $e');
      return AboutUpdateResult.failed();
    }
    final entry = manifest.android;
    final settings = _settings;
    if (entry == null || settings == null) {
      return AboutUpdateResult.manifestIncomplete();
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
      return AboutUpdateResult.available(entry);
    }
    // 已是最新：顺手清掉过期的待更新标记
    final pending = settings.pendingUpdateVersion;
    if (pending != null && !isNewerVersion(pending, _currentVersion)) {
      await settings.setPendingUpdateVersion(null);
    }
    if (mounted) setState(() => _updateEntry = null);
    return AboutUpdateResult.upToDate();
  }

  Future<ReleaseEntry?> _sessionUpdateCheck({bool manual = false}) async {
    final result = await _sessionUpdateCheckDetail();
    if (result.status == AboutUpdateStatus.available) {
      if (manual) {
        if (mounted) _snack(updateCheckText(result));
      } else if (!_remindedThisSession) {
        // 会话内首次发现新版：提醒一次（只提醒不强制，口径不变）。
        _remindedThisSession = true;
        if (mounted) {
          _snack('发现新版 v${result.version}，可在「关于」中下载更新');
        }
      }
      return result.entry;
    }
    // 失败/不完整/真最新：手动检查如实回文案，自动检查安静。
    if (manual && mounted) _snack(updateCheckText(result));
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
    // 恢复盖子先放下，让断线卡片露出来；网络恢复、页面重载成功后恢复链会接着跑
    _recoveryCover = false;
    _splashVisible = false;
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
      // 证书校验端口跟随下载地址本身（好友源 8445 与控制台 8443 都是自家
      // 自签证书；此前写死 8443，从好友/聊天页发起的下载会被证书校验拒掉）
      final client = trustedHttpClient(
          connectionTimeout: const Duration(seconds: 20), port: req.url.port);
      try {
        final request = await client.getUrl(Uri.parse(req.url.toString()));
        applyClientVersionHeader(request);
        if (cookies.isNotEmpty) {
          request.headers.set(HttpHeaders.cookieHeader,
              cookies.map((c) => '${c.name}=${c.value}').join('; '));
        }
        // 响应头超时 20 秒：服务器接受连接却不回话时不许无声挂死（H-5）。
        final res = await request.close().timeout(const Duration(seconds: 20));
        if (res.statusCode < 200 || res.statusCode >= 300) {
          throw const FormatException('下载失败，服务器返回异常状态，请稍后重试。');
        }
        final base = await getExternalStorageDirectory() ?? await getTemporaryDirectory();
        final dir = Directory('${base.path}/downloads');
        await dir.create(recursive: true);
        var name = (req.suggestedFilename ?? '').trim();
        if (name.isEmpty) {
          final seg = Uri.parse(req.url.toString()).pathSegments;
          name = seg.isNotEmpty ? seg.last : 'download.bin';
        }
        name = name.replaceAll(RegExp(r'[^\w.\- ]'), '_');
        if (name.isEmpty || name == '.' || name == '..') name = 'download.bin';
        final file = File('${dir.path}/$name');
        final sink = file.openWrite();
        // 正文无数据超时 30 秒（不设总时限，大文件慢速不断）：连续 30 秒
        // 没有任何新数据才判卡死（H-5）。
        await res.timeout(const Duration(seconds: 30)).pipe(sink);
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
      // 异常原文只进日志，用户面统一中文映射（H-5/VM-03 口径）。
      debugPrint('QF page download failed: $e');
      if (mounted) _snack(pageDownloadFailureText(e));
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
      case 'refresh':
        _activeWeb?.reload();
        break;
      case 'register':
        // 收编 P1：注册页改走壳内页，不再整页冲掉设备槽的控制台语境。
        _openShellWeb('注册新账号', SvcUrls.instance.registerUrl);
        break;
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
                _activateSlot(AppSlot.friends);
              },
            ),
          ),
        );
        break;
      case 'logout':
        _manualLogoutFromMenu();
        break;
      case 'friends':
        _activateSlot(AppSlot.friends);
        break;
      case 'forum':
        _activateSlot(AppSlot.forum);
        break;
      case 'admin':
        _openAdmin();
        break;
      case 'about':
        _activateSlot(AppSlot.me);
        break;
    }
  }

  /// 打开「设置」页（样图 m11）：主题三态/两个记住开关在此页统一管理。
  void _openSettings() {
    final s = _settings;
    if (s == null) return;
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => SettingsPage(
          palette: _palette,
          themeChoice: s.themePref == null
              ? ThemeChoice.followSystem
              : (s.themePref == 'dark' ? ThemeChoice.dark : ThemeChoice.blue),
          rememberDevice: s.rememberDevice,
          rememberPassword: s.rememberPassword,
          currentVersion: _currentVersion,
          onThemeChoice: (choice) async {
            final settings = _settings;
            if (settings == null) return;
            switch (choice) {
              case ThemeChoice.followSystem:
                await settings.clearTheme();
                if (!mounted) return;
                setState(() {
                  _themeMode = resolveThemeMode(
                    pref: null,
                    platformBrightness: WidgetsBinding
                        .instance.platformDispatcher.platformBrightness,
                  );
                });
              case ThemeChoice.blue:
                await settings.setTheme(QfThemeMode.blue.prefValue);
                if (mounted) setState(() => _themeMode = QfThemeMode.blue);
              case ThemeChoice.dark:
                await settings.setTheme(QfThemeMode.dark.prefValue);
                if (mounted) setState(() => _themeMode = QfThemeMode.dark);
            }
          },
          onToggleRememberDevice: (v) async {
            await _settings?.setRememberDevice(v);
            if (!v) {
              // 关掉记住此设备：会话快照一并清（下次打开需重新登录）
              try {
                await _enqueueAuth(() => _credStore.clearSession());
              } catch (_) {}
              _savedSession = null;
            }
          },
          onToggleRememberPassword: (v) async {
            await _settings?.setRememberPassword(v);
            if (!v) {
              try {
                await _enqueueAuth(() => _credStore.clearCredentials());
              } catch (_) {}
              _savedCreds = null;
            }
          },
          onCheckUpdate: () => _sessionUpdateCheck(manual: true),
          onLogout: () {
            Navigator.of(context).pop();
            _manualLogoutFromMenu();
          },
          onOpenTerms: () {
            Navigator.of(context).pop();
            // 收编 P1：协议页改走壳内页，不再劫持设备槽。
            _openShellWeb('用户协议', SvcUrls.instance.termsUrl);
          },
        ),
      ),
    );
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
    final web = _activeWeb;
    if (web == null) {
      _snack('当前页面无法截图，请切换到设备、好友或论坛页面。');
      return;
    }
    try {
      final bytes = await web.takeScreenshot();
      if (bytes == null) throw StateError('截图失败：未获取到画面。');
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
      // 异常原文只进日志，用户面统一文案（H-5/VM-03 口径）。
      debugPrint('QF screenshot failed: $e');
      if (mounted) _snack('截图失败，请稍后重试。');
    }
  }

  String _diagnosticsText() {
    final p = _lastProbe;
    final s = _settings;
    return [
      'QFRemote 安卓版诊断信息',
      '版本：v$_currentVersion（构建日期 $kBuildDate）',
      '系统：${Platform.operatingSystem} ${Platform.operatingSystemVersion}',
      '服务器连通性检测：${p == null ? '尚未检测' : p.describe()}',
      '整页断线次数：${s?.offlineCount ?? 0}',
      '自动重连次数：${s?.watchdogReconnects ?? 0}',
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
        checkUpdateDetail: _sessionUpdateCheckDetail,
        download: _downloadApk,
        openInstaller: _openInstaller,
        diagnosticsText: () async => _diagnosticsText(),
        fetchPoints: _fetchPointsWhenLoggedIn,
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
          // 决策 #43：下载失败放行出口——只清本次会话的墙，待更新标记
          // 保留在设置里，下次启动 _launchGate 仍会拦。
          onSkipOnce: () => setState(() => _forceEntry = null),
        ),
      );
    }

    // 2.3.1 许可拦截面：原生整页盖住全部槽位（文案按 code 取 L 系列正本；
    // 未知 code 用 loginshim 同款兜底文案，不自编、不放行假状态）。
    final gate = _gateDecision;
    if (gate != null) {
      final copy = gateCopyFor(gate) ??
          const GateCopy(
            title: '暂时无法登录',
            body: '当前状态暂时无法登录，请稍后再试，或咨询智能客服。',
            primary: GatePrimary.none,
          );
      return LicenseGatePage(
        palette: _palette,
        username: _gateUsername.isNotEmpty
            ? _gateUsername
            : (_savedCreds?.username ?? ''),
        copy: copy,
        onClaim: copy.hasClaimBox ? _claimFromShell : null,
        onPurchase: () async {
          await _openShellWeb('购买密钥', SvcUrls.instance.purchaseUrl);
          await _recheckLicense();
        },
        onAppeal: () {
          // C2-09（发版前全量审，DS flash 裁定）：申诉链接的账号参数与门禁页
          // 显示口径一致（_gateUsername 优先、保存凭据兜底）；解析结果为空
          // 时整段省略 u 参数，不再附空值。
          final appealUser = _gateUsername.isNotEmpty
              ? _gateUsername
              : (_savedCreds?.username ?? '');
          final appealBase = SvcUrls.instance.appealUrl;
          unawaited(_openShellWeb(
              '提交申诉',
              appealUser.trim().isEmpty
                  ? appealBase
                  : '$appealBase?u=${Uri.encodeQueryComponent(appealUser)}'));
        },
        onRebind: () => unawaited(_openRebind()),
        onSupport: () =>
            _openShellWeb('智能客服', '${SvcUrls.instance.extOrigin}/support'),
        onLogout: _manualLogoutFromMenu,
        onRecheck: _recheckLicense,
      );
    }

    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, result) {
        if (didPop) return;
        unawaited(_handleSystemBack());
      },
      child: Scaffold(
        backgroundColor: _palette.pageColor,
        body: SafeArea(
          // 框架在位时顶/底 inset 由顶栏与标签栏自己处理；无框架（登录页）时整页避让
          top: !_chromeVisible && !_fullscreen,
          bottom: !_chromeVisible && !_fullscreen,
          child: Stack(
            children: [
              Column(
                children: [
                  if (!_fullscreen && _chromeVisible) ...[
                    QfAppHeader(
                      palette: _palette,
                      title: _slotTitle,
                      probeColor: _probeBusy || _lastProbe == null
                          ? QfPalette.probeBusy
                          : (_lastProbe!.ok ? QfPalette.probeOk : QfPalette.probeBad),
                      probeBusy: _probeBusy,
                      hasUpdate: _updateEntry != null,
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
                    child: IndexedStack(
                      // 前台槽裁决（SUP-P0-06）：未登录时强制设备槽，
                      // 登录页就在那里；选中槽只在登录后生效。
                      index: foregroundSlot(
                              chromeVisible: _chromeVisible, selected: _slot)
                          .index,
                      children: [
                        // 首页槽：网页新首页正本（C-3）壳内同框呈现，空白页
                        // 起步，会话建立后移植 cookie 再加载（保活）
                        InAppWebView(
                          initialUrlRequest:
                              URLRequest(url: WebUri('about:blank')),
                          initialSettings: _slotWebViewSettings(),
                          onWebViewCreated: (controller) {
                            _homeWeb = controller;
                            if (_chromeVisible) _maybeLoadSlot(AppSlot.home);
                          },
                          shouldOverrideUrlLoading: _slotUrlPolicy,
                          onCreateWindow: _onCreateWindowInPlace,
                          onUpdateVisitedHistory: (controller, url, isReload) async {
                            final can = await controller.canGoBack();
                            if (mounted) setState(() => _homeCanGoBack = can);
                          },
                          onReceivedServerTrustAuthRequest: _onTrustChallenge,
                          onDownloadStartRequest: (controller, request) {
                            _handlePageDownload(request);
                          },
                        ),
                        // 文件槽：控制台文件管理（本体在控制台页内）
                        InAppWebView(
                          initialUrlRequest:
                              URLRequest(url: WebUri('about:blank')),
                          initialSettings: _slotWebViewSettings(),
                          onWebViewCreated: (controller) {
                            _filesWeb = controller;
                            if (_chromeVisible) _maybeLoadSlot(AppSlot.files);
                          },
                          shouldOverrideUrlLoading: _slotUrlPolicy,
                          onCreateWindow: _onCreateWindowInPlace,
                          onUpdateVisitedHistory: (controller, url, isReload) async {
                            final can = await controller.canGoBack();
                            if (mounted) setState(() => _filesCanGoBack = can);
                          },
                          onReceivedServerTrustAuthRequest: _onTrustChallenge,
                          onDownloadStartRequest: (controller, request) {
                            _handlePageDownload(request);
                          },
                        ),
                        // 设备槽：控制台 WebView＋断线/恢复盖（保活，不随切槽销毁）
                        Stack(
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
                            supportMultipleWindows: true,
                            // 明文流量开关由清单管（main 关、debug 为测试夹具开），插件无此项
                          ),
                          onCreateWindow: _onCreateWindowInPlace,
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
                            // （只认自有服务源，外站同名路径不许误触发）
                            if (url.path == '/logout' &&
                                SvcUrls.instance.isOwnOrigin(url.toString())) {
                              _noteManualLogout();
                            }
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
                            // 断线卡片/启动画面已提至根 Stack（SUP-P0-06）：
                            // 不再困在本槽内，前台是哪个槽都看得见。
                          ],
                        ),
                        // 好友槽（聊天也在此槽内打开）：空白页起步，登录后预加载
                        InAppWebView(
                          initialUrlRequest:
                              URLRequest(url: WebUri('about:blank')),
                          initialSettings: _slotWebViewSettings(),
                          onWebViewCreated: (controller) {
                            _friendsWeb = controller;
                            if (_chromeVisible) _maybeLoadSlot(AppSlot.friends);
                          },
                          shouldOverrideUrlLoading: _slotUrlPolicy,
                          onCreateWindow: _onCreateWindowInPlace,
                          onLoadStop: _injectShellChrome,
                          onUpdateVisitedHistory: (controller, url, isReload) async {
                            if (url != null) _friendsCurrentUrl = url.toString();
                            final can = await controller.canGoBack();
                            if (mounted) setState(() => _friendsCanGoBack = can);
                          },
                          onReceivedServerTrustAuthRequest: _onTrustChallenge,
                          onDownloadStartRequest: (controller, request) {
                            _handlePageDownload(request);
                          },
                        ),
                        // 论坛槽：空白页起步，免登桥处理后加载
                        InAppWebView(
                          initialUrlRequest:
                              URLRequest(url: WebUri('about:blank')),
                          initialSettings: _slotWebViewSettings(),
                          onWebViewCreated: (controller) {
                            _forumWeb = controller;
                            if (_chromeVisible) _maybeLoadSlot(AppSlot.forum);
                          },
                          shouldOverrideUrlLoading: _slotUrlPolicy,
                          onCreateWindow: _onCreateWindowInPlace,
                          onLoadStop: _injectShellChrome,
                          onUpdateVisitedHistory: (controller, url, isReload) async {
                            final can = await controller.canGoBack();
                            if (mounted) setState(() => _forumCanGoBack = can);
                          },
                          onReceivedServerTrustAuthRequest: _onTrustChallenge,
                          onDownloadStartRequest: (controller, request) {
                            _handlePageDownload(request);
                          },
                        ),
                        // 我的槽：原生页（样图 m09），常驻保活。
                        // key 绑 chrome：登录检出/登出时整页重建——未登录时
                        // 许可/积分拉取被短路（见 _fetchPointsWhenLoggedIn），
                        // 登录后靠这次重建补拉真实数据，不留旧账号残影。
                        MePage(
                          key: ValueKey<bool>(_chromeVisible),
                          palette: _palette,
                          currentVersion: _currentVersion,
                          hasUpdate: _updateEntry != null,
                          updateVersion: _updateEntry?.version,
                          rememberLine: (_settings?.rememberDevice ?? false)
                              ? '已记住此设备，30 天内不用再登录'
                              : '未记住此设备，下次打开需要重新登录',
                          fallbackUser: _savedCreds?.username,
                          fetchPoints: _fetchPointsWhenLoggedIn,
                          onOpenSettings: _openSettings,
                          onCheckUpdate: () => _sessionUpdateCheck(manual: true),
                          onAccountAction: () {
                            _activateSlot(AppSlot.devices);
                            _snack('账号设置请在设备页中操作。');
                          },
                          onLogout: _manualLogoutFromMenu,
                          onOpenWebsite: () => _openShellWeb(
                              '官网', SvcUrls.instance.websiteUrl),
                          licenseSection: LicenseSection(
                            palette: _palette,
                            fetchLicense: () async {
                              // 未登录短路（SUP-P0-06）：不发请求
                              if (!_chromeVisible) return null;
                              final me =
                                  await _licenseService.fetchLicenseMe();
                              // §7.5.7：/me 附带 forceLogout 时立即执行
                              if (me != null && me.forceLogout) {
                                unawaited(_handleForceLogoutSignal(
                                    me.gateCode ?? 'G1'));
                              }
                              return me;
                            },
                            onBind: (key) async {
                              _deviceCode ??=
                                  await _deviceCodeStore.getOrCreate();
                              return _licenseService.bindKey(
                                  key, _deviceCode!);
                            },
                            onClaim: _claimFromShell,
                            // 决策 #24 兑换KEY（巡查 A-003 补齐安卓原生入口）
                            fetchMyKeys: _fetchMyKeysWhenLoggedIn,
                            onRedeem: _licenseService.redeemKey,
                            onRedeemId: _licenseService.redeemKeyId,
                            onPurchase: () => _openShellWeb(
                                '购买密钥', SvcUrls.instance.purchaseUrl),
                            onStatusQuery: () => _openShellWeb(
                                '查询密钥', SvcUrls.instance.licenseStatusUrl),
                          ),
                        ),
                      ],
                    ),
                  ),
                  if (!_fullscreen && _chromeVisible)
                    QfTabBar(
                      palette: _palette,
                      active: _slot,
                      onSelect: _activateSlot,
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
              // 状态面根层（SUP-P0-06）：断线卡片与启动/恢复盖子提到根
              // Stack，与前台槽无关地可见——断网冷启动、恢复进行中都必须
              // 看得见、点得到重试，不许再困在设备槽里被别的槽盖住。
              if (_offline)
                Positioned.fill(
                  child: OfflineView(
                    palette: _palette,
                    secondsLeft: _offlineSecondsLeft,
                    onRetryNow: () {
                      _offlineTimer?.cancel();
                      _web?.reload();
                      _scheduleOfflineRetry();
                    },
                  ),
                ),
              if (_splashVisible)
                Positioned.fill(
                  child: SplashView(
                    palette: _palette,
                    version: _currentVersion,
                    note: _recoveryCover ? '正在恢复登录…' : null,
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}
