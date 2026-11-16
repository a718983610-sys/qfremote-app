import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_inappwebview/flutter_inappwebview.dart';
import 'package:open_filex/open_filex.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:path_provider/path_provider.dart';
import 'package:url_launcher/url_launcher.dart';

import 'app/background/background_controller.dart';
import 'app/boot.dart';
import 'app/services.dart';
import 'app/session/session_coordinator.dart';
import 'app/permissions/notification_permission_flow.dart';
import 'app/permissions/qf_bridge_permission_service.dart';
import 'build_info.dart';
import 'core/client_header.dart';
import 'core/constants.dart';
import 'core/jsbridge_guard.dart';
import 'core/license.dart';
import 'core/login_bridge.dart';
import 'core/renderer_recovery.dart';
import 'core/session_recovery.dart';
import 'core/session_stage.dart';
import 'core/session_perf.dart';
import 'core/slot_lifecycle.dart';
import 'core/webview_cookie_policy.dart';
import 'core/chat_device.dart';
import 'core/slot_nav.dart';
import 'core/svc_urls.dart';
import 'core/manifest.dart';
import 'core/update_policy.dart';
import 'core/version.dart';
import 'core/watchdog_core.dart';
import 'data/session/reconnect_policy.dart';
import 'data/session/reconnect_wiring.dart';
import 'data/services/api_client.dart';
import 'data/services/device_list_fetcher.dart';
import 'data/repositories/device_repository.dart';
import 'services/credential_store.dart';
import 'services/device_code.dart';
import 'services/device_key_vault.dart';
import 'services/device_presence.dart';
import 'services/forum_sso.dart';
import 'services/license_client.dart';
import 'services/native_channels.dart';
import 'services/qf_bridge.dart';
import 'services/points.dart';
import 'services/probe.dart';
import 'services/session_log.dart';
import 'services/settings.dart';
import 'services/updater.dart';
import 'ui/about.dart';
import 'ui/adaptive_shell.dart';
import 'ui/core/adaptive.dart';
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
import 'ui/reduced_motion.dart';
import 'ui/toolbar.dart';
import 'ui/features/devices/device_list_screen.dart';
import 'ui/features/devices/device_list_view_model.dart';

/// A1 断根：MaterialApp 的主题跟随用户偏好（_themeMode），不再跟系统。
/// HomePage 的 _themeMode 每次改动都经 setter 同步推到这里；
/// 启动时先按系统亮度取初值（与旧 ThemeMode.system 一致），_boot 读到
/// 已存偏好后由 setter 纠正。
final ValueNotifier<QfThemeMode> _qfThemeMode = ValueNotifier<QfThemeMode>(
  QfThemeMode.blue,
);

/// A-04：启动必须无条件到达 runApp()——main() 里不做任何 await，
/// 只做 ensureInitialized＋主题初值＋runApp；首帧时间由 [_bootFirstFrame]
/// 记录，进发版门（阈值 3000ms，见 app/boot.dart）。
final _bootFirstFrame = FirstFrameTimer();

/// 首帧耗时（毫秒，首帧渲染后才有值；诊断/发版门读取用）。
int? get bootFirstFrameMs => _bootFirstFrame.firstFrameMs;

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  _qfThemeMode.value = resolveThemeMode(
    pref: null,
    platformBrightness:
        WidgetsBinding.instance.platformDispatcher.platformBrightness,
  );
  runApp(const QfRemoteApp());
  _bootFirstFrame.recordFirstFrame();
}

class QfRemoteApp extends StatelessWidget {
  const QfRemoteApp({super.key});

  @override
  Widget build(BuildContext context) {
    // A1：themeMode 跟随 _qfThemeMode（即用户偏好），Material 层控件
    // （输入框文字、弹窗、顶栏菜单、SnackBar）与壳内自绘面走同一条裁决链。
    return ValueListenableBuilder<QfThemeMode>(
      valueListenable: _qfThemeMode,
      builder: (context, mode, _) {
        // A 重做 §3.3：edge-to-edge，状态栏透明，图标亮度跟随主题
        // （深色亮图标／浅色暗图标）；导航栏同样透明，由底部 tab 自己
        // 吃 safe area。ThemeMode 仍走 A1 偏好链（手动偏好优先，
        // 未选才跟随系统），不改成 ThemeMode.system——D1 已由大肥鱼
        // 裁决“满足”（见 theme.dart resolveThemeMode 注释与返工报告）。
        final isDark = mode == QfThemeMode.dark;
        SystemChrome.setSystemUIOverlayStyle(
          SystemUiOverlayStyle(
            statusBarColor: Colors.transparent,
            statusBarIconBrightness: isDark
                ? Brightness.light
                : Brightness.dark,
            statusBarBrightness: isDark ? Brightness.dark : Brightness.light,
            systemNavigationBarColor: Colors.transparent,
            systemNavigationBarIconBrightness: isDark
                ? Brightness.light
                : Brightness.dark,
          ),
        );
        return MaterialApp(
          title: 'QFRemote',
          debugShowCheckedModeBanner: false,
          // 主题唯一出口：QfTheme 工厂（种子色黑白主色、三档字号、按钮／弹窗／
          // 卡片／输入框组件主题全收口；壳内自绘面走 QfPalette 令牌，口径一致）。
          theme: QfTheme.light(),
          darkTheme: QfTheme.dark(),
          themeMode: mode == QfThemeMode.dark
              ? ThemeMode.dark
              : ThemeMode.light,
          home: const HomePage(),
        );
      },
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
    // B13：JS 求值 5 秒超时，挂起的求值不许拖住后续所有拍。
    final r = await c
        .evaluateJavascript(source: kDetectJs)
        .timeout(const Duration(seconds: 5));
    final s = _clean(r);
    return const [
          'login',
          'disconnected',
          'partial',
          'ok',
          // S-042：已连上、无画布——看护报 connectedWaitRender，不报 ok。
          'connected-wait-render',
          'connecting',
        ].contains(s)
        ? s
        : 'unknown';
  }

  @override
  Future<bool> clickReconnect() async {
    final c = controller;
    if (c == null) return false;
    // B13：点击求值同样 5 秒超时。
    // B10 返修：kClickJs 点不到掩码「重试」时回 'no-retry-button'
    // （如已是 FAIL 态、掩码未展开），记一笔日志再回 false，不静默吞掉。
    final r = await c
        .evaluateJavascript(source: kClickJs)
        .timeout(const Duration(seconds: 5));
    if (_clean(r) == 'no-retry-button') {
      debugPrint('QFWATCHDOG reconnect click: no retry button in mask');
      return false;
    }
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

/// 截图空白判定（B20 返修，纯逻辑可单测）：采样 3×3 九宫格 9 个像素，
/// 全部同色**且为纯黑或纯白**才判空白。
/// 旧口径（5 像素全同色即判空白）会把合法均匀画面（纯色壁纸等）误判为
/// 空白；新口径下均匀彩色画面不再误判。
/// 注意：纯黑画面（远程黑屏、锁屏黑画面）与纯白画面仍会被判空白——
/// 采样仍不可靠的边界，须真机 3 次截图人工比对验证，见回报 B20。
bool isBlankSample(List<int> pixels) {
  if (pixels.isEmpty) return false;
  final first = pixels.first;
  if (pixels.any((p) => p != first)) return false;
  // RGBA 32 位像素：纯黑 (0,0,0,255) 或纯白 (255,255,255,255)。
  // ByteData.getUint32 读出的是大端拼接值：黑 0x000000FF，白 0xFFFFFFFF。
  return first == 0x000000FF || first == 0xFFFFFFFF;
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

/// Tab 槽栈（F-A2 返工）：IndexedStack 的薄壳，只为把 GlobalKey
/// 托管的栈作为 AnimatedSwitcher 的 child——key 变化时 AnimatedSwitcher
/// 认为 child 换了而播 crossfade，但 IndexedStack element 本身
/// （含 5 个 WebView 的控制器与页面状态）只建一次、不复制。
class _SlotStack extends StatelessWidget {
  final GlobalKey stackKey;
  final int index;
  final List<Widget> children;

  const _SlotStack({
    super.key,
    required this.stackKey,
    required this.index,
    required this.children,
  });

  @override
  Widget build(BuildContext context) {
    return IndexedStack(key: stackKey, index: index, children: children);
  }
}

class _HomePageState extends State<HomePage> with WidgetsBindingObserver {
  UpdateService? _updateServiceField;

  /// 更新服务（懒建：B24 客户端版本头取 PackageInfo 读到的包版本）。
  UpdateService get _updateService =>
      _updateServiceField ??= UpdateService(clientVersion: _currentVersion);

  final _evaluator = _WebViewEvaluator();

  /// 会话持久日志（A10）：preflight/阶段/超时/agent_stale 全链留痕。
  final _sessionLog = SessionLog();

  /// 登录身份代数（A6/B6）：登录成功/手动退出/强制下线时递增；在途的
  /// 探针/恢复响应回来时代数已变则丢弃并触发一次 _refreshAuthState，
  /// 不静默吞掉、不许旧响应写入新登录态。
  int _authGen = 0;

  // ---- 2.4.5 会话阶段机（A1/A2/A3/A5/A9） ----
  /// 当前会话路由的 nodeid（裸 id）与设备名（预检回参）。
  String? _sessionNodeid;
  String? _sessionDeviceName;

  /// 阶段 watcher：1 秒一拍，仅顶层 URL 为会话路由时运行。
  Timer? _sessionTimer;
  SessionStage _sessionStage = SessionStage.iframeAttach;
  DateTime? _sessionStageSince;
  DateTime? _sessionStartedAt;
  bool _sessionConnecting = false;
  bool _sessionFailed = false;
  bool _lastSessionFailed = false;
  bool _sessionCardShowing = false;
  String _lastSessionSummary = '暂无会话记录';
  String? _preflightFor;
  bool _preflightBusy = false;

  /// 会话性能 HUD（A8 返修）：WebView 渲染估算/页面探针耗时/输入→回显延迟/
  /// 探针采样，见 lib/core/session_perf.dart 的口径说明（度量不到写「未测量」）。
  final _perfTracker = SessionPerfTracker();

  /// 会话进行态（video-ready 后）才为真：HUD 只在此时可见。
  bool _sessionActive = false;

  /// A-01 后台分级控制器：周期同步＋唤醒信号＋前台会话走同一接线点；
  /// 会话起停与生命周期钩子经它分流（见 _setKeepScreenOnForSession、
  /// _clearKeepScreenOn、didChangeAppLifecycleState）。调度失败只记
  /// lastError，不挡启动；退出登录取消周期同步由 _clearAuthState
  /// 持有方调用 _bgTier?.cancelPeriodicSync()（另一并行线）。
  BackgroundTierController? _bgTier;

  /// RC-04 接线（第 2 轮 #4）：断线重连票据会话管理器＋重连浮层状态。
  /// 票据只存内存（ReconnectSession 内 InMemoryReconnectTicketStore）；
  /// 会话建立成功（videoReady）才申领，申领失败不挡会话（fail-open）。
  ReconnectSession? _reconnectSession;

  /// 票据重连循环进行中（浮层盖住 WebView＝输入短路丢弃，见 build 根 Stack）。
  bool _reconnecting = false;

  /// 重连浮层文案（“正在重连（第 N 次 / 共 5 次）”，由 controller.onAttempt 推）。
  String _reconnectStatus = '';

  /// 最近一次凭据类重连失败（1 次即停，浮层外另弹原因＋“重新登录”卡）。
  ReconnectFailure? _reconnectFailure;

  /// video-ready 后的性能采样定时器（探针间隔跟随画质档位）。
  Timer? _perfTimer;

  /// 服务端时钟偏移（B22）：预检回包 serverTime - 本机 now，快照
  /// savedAt 优先按服务端时间算，本地时钟只作兜底。
  Duration? _serverClockOffset;

  /// 屏幕常亮当前是否已开（B9）：退出会话/切后台时清。
  bool _keepScreenOnActive = false;

  /// A-03 接线（R1）：会话启动时通知权限申请编排（本轮只提示一次，
  /// 见 notification_permission_flow.dart）。
  final NotificationPermissionFlow _notificationPermissionFlow =
      NotificationPermissionFlow(const QfBridgePermissionService());

  // ---- 2.4.5 冷启动看门狗（B1） ----
  Timer? _bootLoadWatchdog;
  Timer? _splashDeadlineTimer;

  // ---- 2.4.5 其他计数器 ----
  int _unknownProbeStreak = 0; // B5：登录探针连续 unknown 拍数
  int _probeFailStreak = 0; // B4：探活连续失败次数
  int _authDeadStreak = 0; // B7：心跳连续 authDead 次数
  int _chatTickCount = 0; // B25：聊天页探针分频
  int _offlineAttempts = 0; // B11：离线自动重试总次数（上限 10）
  bool _offlineRetryStopped = false;
  int _licenseRetryCount = 0; // B21：许可门失败重试次数（上限 3）
  Timer? _licenseRetryTimer;

  /// B7 返修：最近一次许可/积分拉取是否明确遇到 401/403（登录已过期）。
  /// 为真时「我的」页与许可区显示「登录已过期，请重新登录」＋重新登录
  /// 入口，不再显示空白占位；成功拉取后清掉。
  bool _meAuthDead = false;
  bool _licenseAuthDead = false;
  int _updateCheckRetries = 0; // B16：会话内更新检查失败重试（上限 3）
  Timer? _updateCheckRetryTimer;
  bool _gateRecheckDone = false; // B16：弱网放行后只重跑一次更新门
  String _recoveryStepText = ''; // A7：恢复盖小字写明当前步
  bool _awaitingRestoreLoad = false; // B6：快照恢复 reload 后等 onLoadStop 再计时
  bool _certErrorShown = false; // B3：证书异常卡本会话只弹一次

  QfSettings? _settings;
  PackageInfo? _pkg;
  // A1：主题状态唯一写口——所有 _themeMode 赋值都经此 setter，顺带把新值
  // 推给顶层 _qfThemeMode（MaterialApp 跟随），Material 层与壳永不同轨。
  QfThemeMode _themeModeValue = QfThemeMode.blue;
  QfThemeMode get _themeMode => _themeModeValue;
  set _themeMode(QfThemeMode v) {
    _themeModeValue = v;
    _qfThemeMode.value = v;
    // P0-2：主题一变就推给全部已加载 WebView（控制台／好友／聊天／论坛槽），
    // 与 Web 页约定的 `qf-theme-state` 事件同契约；推送失败静默跳过，
    // 下一页 onLoadStop 时由 _injectShellChrome / _onPageLoaded 再推一次。
    unawaited(_pushThemeToWebViews());
  }

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
  /// B2 返修：主框 404 时为真，根 Stack 盖「页面不存在（HTTP 404）」卡
  /// ＋重试按钮，不静默展示服务端 404 页；下次导航/加载成功即清。
  bool _http404 = false;
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

  /// A-05 第 1 轮接线：启动时在 _boot 里构建的 Services（Drift＋网络＋
  /// 仓库＋ViewModel）持有者。构建失败时为 null，UI 走 WebView 降级态
  /// （DeviceList 原生页不可用，绝不挡启动）；退出清库（_clearAuthState）
  /// 与网络重建（_rebuildServicesNetwork）都从这里取。
  final _servicesHolder = ServicesHolder();

  /// 第 2 轮 #5：会话客户端层协调器（中继选路／IDR／画质探针／录像／
  /// 文件流）。懒建：基址取当前 Services（换节点后重建走提供方），
  /// 会话 cookie 取 WebView CookieManager（cookie 桥）。
  SessionCoordinator? _sessionCoordinator;

  SessionCoordinator get _sessionLayer =>
      _sessionCoordinator ??= SessionCoordinator(
        baseUrlProvider: () =>
            _servicesHolder.services?.apiBaseUrl ?? SvcUrls.instance.extOrigin,
        cookieProvider: _consoleCookieHeader,
      );

  /// 第 2 轮 #2：原生设备列表 ViewModel（Services 构建成功后创建一次，
  /// 随 Services 生命周期；退出登录不清——同一库连接由下个账号复用，
  /// 流会自动吐空列表再吐新账号数据）。
  /// 为空＝Services 未构建（降级启动），设备槽回落 WebView 控制台。
  DeviceListViewModel? _deviceListViewModel;

  /// 第 2 轮 #2：设备槽强制显示 WebView（点设备行进会话时置真；WebView
  /// 里的会话路由离开后（_onSessionRouteChanged 的非会话分支）清掉。
  /// WebView 本体始终挂载（登录页／会话／看护都挂在它上面），原生列表
  /// 只是盖在它上面的一层，绝不卸载 WebView。
  bool _devicesShowWeb = false;

  /// 第 2 轮 #2：原生列表上次刷新时间（切进设备槽时节流刷新，60 秒内
  /// 不重复拉；下拉刷新与空态按钮不受节流限制）。
  DateTime? _devicesLastRefresh;

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

  /// A-07：返回键历史模型（与 SystemBackGate 共用同一实例；
  /// 切槽时由 _activateSlot 记一笔，退出登录时 _clearAuthState 清掉）。
  final NavHistoryController _navHistory = NavHistoryController();
  // F-A3 返工：顶栏滚动分割线信号（A §3.3：滚动超过 8px 出 1px 底部分割线）。
  // 信号源：各槽 WebView 的 onScrollChanged（y 像素）与我的页原生
  // ListView 的 ScrollNotification 共用 _onSlotScroll 入口；
  // 只有状态翻转时才 setState，避免滚动每帧重建。
  bool _scrolled = false;
  // F-A2 返工：Tab crossfade 期间新旧 AnimatedSwitcher child 共用
  // 同一个 IndexedStack element（见 build 内注释），不复制 WebView。
  final _slotStackKey = GlobalKey();
  void _onSlotScroll(int y) {
    final scrolled = y > 8;
    if (scrolled != _scrolled && mounted) {
      setState(() => _scrolled = scrolled);
    }
  }

  final SlotLoadTracker _slotLoads = SlotLoadTracker();
  InAppWebViewController? _homeWeb;
  InAppWebViewController? _filesWeb;
  InAppWebViewController? _friendsWeb;
  InAppWebViewController? _forumWeb;

  // S-027 渲染进程崩溃恢复（R-02/R-03/R-05/R-08/R-09/R-10）：每槽一个
  // generation（槽 widget 的 Key 带代次，旧代回调一律丢弃）与恢复状态；
  // 真机 renderer kill 测试列入 11/16 ECS 真机窗口，本线只做代码＋单测。
  final _rendererRecovery = RendererRecoveryTracker();

  // S-032＋S-043 槽生命周期：ACTIVE／WARM／COLD／DISPOSED，最多 1 个
  // WARM 槽持有后台渲染进程，单槽最长后台驻留 30 分钟。
  final _slotLifecycle = SlotLifecycleManager();
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

  /// 登录循环的起步定时器（B13 相位错峰用，见 _startLoginLoop）。
  Timer? _loginLoopStarter;
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

  ExtService get _extService => _ext ??= ExtService(
    cookieProvider: _consoleCookieHeader,
    clientVersion: _currentVersion,
  );

  LicenseClient get _licenseService => _licenseClient ??= LicenseClient(
    cookieProvider: _consoleCookieHeader,
    clientVersion: _currentVersion,
  );

  /// 许可/积分拉取的未登录短路（SUP-P0-06）：「我的」槽在 IndexedStack 里
  /// 常驻构建，其许可区与积分会在未登录时也急切拉取、成对空打 401。
  /// 未检出登录（chrome 未出现）前一律不发请求、按无数据处理；登录检出
  /// 后 MePage 随 chrome 翻转重建（build 里 key 绑定），届时再真拉。
  /// B7 返修：用带 authDead 标记的 fetchMeResult——401/403 时记
  /// _meAuthDead（「我的」页据此显示「登录已过期，请重新登录」），
  /// 网络不通时不置标记（仍按旧口径显示「—」）。
  Future<PointsInfo?> _fetchPointsWhenLoggedIn() async {
    if (!_chromeVisible) return null;
    final r = await _extService.fetchMeResult();
    // 只有本次取不到数据时才按 401/403 置过期标记；取到了就清标记。
    final dead =
        r.info == null &&
        (r.authDead || _isRecentAuthFailure(_extService.lastAuthFailureAt));
    if (mounted && dead != _meAuthDead) {
      setState(() => _meAuthDead = dead);
    }
    return r.info;
  }

  /// 最近 5 分钟内有过 401/403 记录（lastAuthFailureAt 的调用方读取，
  /// B7：新标记之外的第二路判定，供未走 Result 的旧调用方兜底）。
  bool _isRecentAuthFailure(DateTime? at) =>
      at != null && DateTime.now().difference(at) < const Duration(minutes: 5);

  /// 登录已过期后的重新登录入口（B7）：只清会话快照（不碰已存凭据），
  /// 重开恢复轮走凭据静默登录；恢复链试完仍不行就露登录页（桥会回填
  /// 已存账号，用户点登录即可）。不走手动退出（那会清掉已存凭据）。
  Future<void> _reloginAfterAuthDead() async {
    try {
      await _enqueueAuth(() => _credStore.clearSession());
    } catch (_) {}
    _savedSession = null;
    _meAuthDead = false;
    _licenseAuthDead = false;
    _licenseCheckedThisSession = false;
    _licenseErrorSnacked = false;
    _episodeFinished = false;
    _episodeRunning = false;
    _stepWaitUntil = null;
    if (mounted) setState(() {});
    _activateSlot(AppSlot.devices);
    await _web?.reload();
  }

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
    // A-01：后台分级控制器只认接口，生产用真实调度器（JobScheduler）；
    // 登录信号用 _savedCreds（_boot 里加载，闭包调用时才读，不抢跑）。
    _bgTier = BackgroundTierController(
      isLoggedIn: () => _savedCreds != null,
      onPullRequested: () async {
        _runProbe();
      },
    );
    // 第 2 轮 #2：Services 构建落定后创建原生设备列表 ViewModel
    // （只建一次；构建失败 holder 保持 null，设备槽继续走 WebView）。
    _servicesHolder.addListener(_onServicesChanged);
    _boot();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    final resumed = state == AppLifecycleState.resumed;
    final wasForeground = _foreground;
    _foreground = resumed;
    if (!mounted) return;
    if (resumed && !wasForeground) {
      // B8：回前台立即复核（不等定时器）：探活 + 登录探针 + 看护一拍；
      // 会话进行态且 connecting 超阶段超时，立即弹原生失败卡。
      unawaited(_runProbe());
      if (_isConsolePage) {
        unawaited(
          _probeLogin().then((p) async {
            if (p != null && p.isLogin) {
              await _onLoginPageDetected(fromConsole: true);
            }
          }),
        );
      }
      unawaited(_watchdog?.tickNow() ?? Future<void>.value());
      if (_sessionConnecting) _sessionTick();
      _startLoginLoop();
      _startWatchdogIfNeeded();
      // A-01：回前台确保周期同步已调度；有挂起的唤醒信号时拉取一次。
      final bgTier = _bgTier;
      if (bgTier != null) unawaited(bgTier.onAppResumed());
      // 第 2 轮 #5：回前台恢复录像上报、探针恢复常速。
      _sessionLayer.noteResumed();
    } else if (!resumed && wasForeground) {
      // B8：切后台暂停看护与登录探针（后台 evaluateJavascript 空转耗电
      // 且排队），退出会话常亮；回前台时重建。
      _watchdog?.stop();
      _watchdog = null;
      _loginTimer?.cancel();
      _loginTimer = null;
      _loginLoopStarter?.cancel();
      _loginLoopStarter = null;
      _clearKeepScreenOn();
      // A-01：切后台且无会话时确保周期同步已调度（有会话时由前台服务持有）。
      final bgTier = _bgTier;
      if (bgTier != null) unawaited(bgTier.onAppBackgrounded());
      // 第 2 轮 #5：切后台暂停录像上报、在途拨号取消计数、探针切 5s。
      _sessionLayer.noteBackgrounded();
    }
  }

  void _startWatchdogIfNeeded() {
    if (_watchdog == null && _web != null) _startWatchdog();
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
    _servicesHolder.removeListener(_onServicesChanged);
    _deviceListViewModel?.dispose();
    _deviceListViewModel = null;
    _watchdog?.stop();
    _sessionTimer?.cancel();
    _bootLoadWatchdog?.cancel();
    _splashDeadlineTimer?.cancel();
    _licenseRetryTimer?.cancel();
    _updateCheckRetryTimer?.cancel();
    _offlineTimer?.cancel();
    _probeTimer?.cancel();
    _heartbeatTimer?.cancel();
    _loginTimer?.cancel();
    _loginLoopStarter?.cancel();
    _perfTimer?.cancel();
    // B12：释放各槽页面资源（WebView 控制器随 widget 销毁，本处只清页面）。
    unawaited(
      _homeWeb?.loadUrl(urlRequest: URLRequest(url: WebUri('about:blank'))),
    );
    unawaited(
      _filesWeb?.loadUrl(urlRequest: URLRequest(url: WebUri('about:blank'))),
    );
    unawaited(
      _friendsWeb?.loadUrl(urlRequest: URLRequest(url: WebUri('about:blank'))),
    );
    unawaited(
      _forumWeb?.loadUrl(urlRequest: URLRequest(url: WebUri('about:blank'))),
    );
    unawaited(
      _web?.loadUrl(urlRequest: URLRequest(url: WebUri('about:blank'))),
    );
    _clearKeepScreenOn();
    super.dispose();
  }

  // ---------------- 启动：设置 → 待更新门 → 控制台 ----------------

  /// A-04 启动三段：阻塞段每步 10 秒超时、失败降级不挡 UI。
  /// 设置/包信息读不到时走降级启动（不恢复会话、直接进控制台/登录页），
  /// 绝不让用户卡在启动转圈；runApp() 在 main() 里早已到达。
  Future<void> _boot() async {
    // A-05 第 1 轮接线：构建 Services 与设置加载并行——先起 future，
    // 下面设置落定后再 await；构建失败走降级（holder 保持 null）。
    // 注意：这里不 await——设置读不到的降级分支直接露页面，构建在
    // 后台完成后再挂 holder，不拖启动画面。
    final servicesFuture = buildServicesForBoot(
      holder: _servicesHolder,
      baseUrl: SvcUrls.instance.extOrigin,
      // 第 2 轮 #2：401 单飞登出回调接上（DeviceList 消费 apiClient，
      // 401 即登录过期，走登出流程回登录页）。
      build: () => Services.build(
        apiClient: QfApiClient(
          baseUrl: SvcUrls.instance.extOrigin,
          onUnauthorized: _handleApiUnauthorized,
        ),
      ),
      onError: (e) => debugPrint('QFSERVICES build failed: $e'),
    );
    QfSettings? settings;
    try {
      settings = await QfSettings.load().timeout(const Duration(seconds: 10));
    } catch (_) {
      settings = null;
    }
    PackageInfo? pkg;
    try {
      pkg = await PackageInfo.fromPlatform().timeout(
        const Duration(seconds: 10),
      );
    } catch (_) {
      pkg = null;
    }
    if (settings == null) {
      // 降级启动：设置读不到（SharedPreferences 异常/超时），跳过恢复链，
      // 直接露页面；_settings 保持 null，各处按默认值处理。
      if (!mounted) return;
      setState(() {
        _pkg = pkg;
        _booted = true;
      });
      _startSplashDeadline();
      _startProbeLoop();
      unawaited(SvcUrls.instance.ensureResolved());
      _startHeartbeatLoop();
      return;
    }
    // 2.3.0：先把已存凭据/会话快照/拦截标记读进内存；有恢复的可能时，
    // 启动画面先盖住，等恢复链裁决完再露页面（不闪登录页）。
    try {
      _savedCreds = await _credStore.loadCredentials().timeout(
        const Duration(seconds: 10),
      );
      _savedSession = await _credStore.loadSession().timeout(
        const Duration(seconds: 10),
      );
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
    final canRecover =
        (_savedCreds != null ||
            (_savedSession?.isFresh(
                  DateTime.now(),
                  serverNow: _serverNow(),
                  expectedAccount: _snapshotExpectedAccount(),
                ) ??
                false)) &&
        (settings.rememberDevice || settings.rememberPassword);
    if (canRecover) {
      // 只先盖住；episode 由登录探针在确认掉登录后正式开启
      _recoveryCover = true;
    }
    if (!mounted) return;
    // settings 在上面已判非空；setState 闭包会丢提升，须先取局部量。
    final loaded = settings;
    setState(() {
      _settings = loaded;
      _pkg = pkg;
      _themeMode = resolveThemeMode(
        pref: loaded.themePref,
        platformBrightness:
            WidgetsBinding.instance.platformDispatcher.platformBrightness,
      );
      _booted = true;
    });
    // A-05：等 Services 构建落定（通常已随设置加载并行完成；库打不开时
    // 10 秒超时后降级，holder 为 null，不挡启动）。
    await servicesFuture;
    // B1：启动画面 30 秒总上限——超时仍未进控制台/登录页，自动退场并
    // 弹「加载超时」+ 重试（见 _startSplashDeadline）。
    _startSplashDeadline();
    await _launchGate(settings);
    _startProbeLoop();
    unawaited(SvcUrls.instance.ensureResolved());
    // A-06：解析完成后同步一次网络层——解析出的 ext origin 若与构建时
    // 不同，重建 QfApiClient（仓库与 ViewModel 不动）；相同时为空操作。
    unawaited(_rebuildServicesNetwork());
    _startHeartbeatLoop();
  }

  /// A-06：服务域名解析变化时重建网络层（换节点／换域名）。
  /// 只在解析出的 ext origin 与当前 Services 基址不一致时重建
  /// QfApiClient；仓库与 ViewModel 实例不动。Services 未构建（降级
  /// 启动）时直接返回；解析失败时保持旧基址，不抛错。
  /// 调用点：_boot（解析完成后同步一次）、_openShellWeb／
  /// _ensureHomeLoaded（每次重解析后同步一次）。
  Future<void> _rebuildServicesNetwork() async {
    final services = _servicesHolder.services;
    if (services == null) return;
    try {
      await SvcUrls.instance.ensureResolved().timeout(
        const Duration(seconds: 10),
      );
    } catch (_) {}
    final current = SvcUrls.instance.extOrigin;
    if (current == services.apiBaseUrl) return;
    try {
      services.rebuildNetwork(baseUrl: current);
      debugPrint('QFSERVICES network rebuilt: $current');
    } catch (_) {}
  }

  /// 第 2 轮 #2：Services 构建落定后创建原生设备列表 ViewModel（只建
  /// 一次）。取数器用 Services 的 apiClient＋控制台会话 cookie；
  /// 写库走 _authChain 串行（见 Services 线交接：否则与退出清库交叉
  /// 会丢新账号数据）。创建时若已在设备槽且已登录，顺手拉一轮。
  void _onServicesChanged() {
    if (_deviceListViewModel != null) return;
    final services = _servicesHolder.services;
    if (services == null) return;
    _deviceListViewModel = services.deviceListViewModel(
      fetcher: DeviceListFetcher(
        apiClient: services.apiClient,
        cookieProvider: _consoleCookieHeader,
      ),
    );
    if (mounted && _slot == AppSlot.devices && _chromeVisible) {
      unawaited(_maybeRefreshDeviceList());
    }
  }

  /// 第 2 轮 #2：原生设备列表是否显示（盖在设备槽 WebView 上面）。
  /// 未登录（chrome 未出现）时登录页就在 WebView 里，不盖；
  /// 会话进行中／点行进会话后（_devicesShowWeb）露出 WebView；
  /// Services 未构建时回落 WebView 控制台。
  bool get _devicesShowNative =>
      _chromeVisible && _deviceListViewModel != null && !_devicesShowWeb;

  /// 第 2 轮 #2：切进设备槽时节流刷新（60 秒内不重复拉；下拉刷新与
  /// 空态按钮走 ViewModel.refresh()，不受节流限制）。失败不抛，
  /// ViewModel 置 error 由列表页出重试。
  Future<void> _maybeRefreshDeviceList() async {
    final vm = _deviceListViewModel;
    if (vm == null || !mounted) return;
    final last = _devicesLastRefresh;
    if (last != null &&
        DateTime.now().difference(last) < const Duration(seconds: 60)) {
      return;
    }
    _devicesLastRefresh = DateTime.now();
    await vm.refresh();
  }

  /// 第 2 轮 #2：点设备行打开远程会话——在设备槽 WebView 里加载
  /// `#session/<nodeId>`（控制台 SPA 会话路由，预检＋阶段 watcher
  /// 照常跑）。先露出 WebView 再加载，预检卡在根 Stack 可见。
  /// WebView 未就绪时留在列表（fail-open，不弹错）。
  Future<void> _openDeviceSession(DeviceInfo device) async {
    final web = _web;
    if (web == null) return;
    if (mounted) setState(() => _devicesShowWeb = true);
    try {
      await web.loadUrl(
        urlRequest: URLRequest(
          url: WebUri(
            '$kServerOrigin/#session/${Uri.encodeComponent(device.nodeId)}',
          ),
        ),
      );
    } catch (_) {}
  }

  /// 第 2 轮 #2：401 单飞登出回调（QfApiClient.onUnauthorized，
  /// Services.build 时接上）。服务端明确说登录已过期：清干净后回
  /// 设备槽 WebView 登录页。回调里一律不抛（QfApiClient 单飞处是
  /// unawaited，抛错会变未处理异步错误）；已在登出流程中时
  /// _clearAuthState 幂等，多次调用无害。
  Future<void> _handleApiUnauthorized() async {
    try {
      if (!mounted) return;
      await _clearAuthState();
      if (!mounted) return;
      setState(() {
        _slot = AppSlot.devices;
      });
      await _web?.loadUrl(
        urlRequest: URLRequest(url: WebUri('$kServerOrigin/logout')),
      );
      if (mounted) _snack('登录已过期，请重新登录。');
    } catch (_) {}
  }

  /// 启动画面总上限 30 秒（B1）：到时仍盖着启动画面，强制退场并弹
  /// 「加载超时，请检查网络后重试」+ 重试按钮，禁止无限盖屏。
  void _startSplashDeadline() {
    _splashDeadlineTimer?.cancel();
    _splashDeadlineTimer = Timer(const Duration(seconds: 30), () {
      if (!mounted || !_splashVisible || _offline) return;
      setState(() => _splashVisible = false);
      _snack('加载超时，请检查网络后重试。');
      unawaited(
        _sessionLog.log('boot-load-timeout', extra: 'splash-deadline-30s'),
      );
    });
  }

  // ---------------- 积分心跳与站长判定（2.2.0） ----------------

  /// 控制台会话 cookie：从 WebView 的 CookieManager 取控制台源的 cookie 值，
  /// 拼成请求头字符串；没登录/取不到返回 null（心跳与判定自动跳过）。
  Future<String?> _consoleCookieHeader() async {
    try {
      final cookies = await CookieManager.instance().getCookies(
        url: WebUri(kServerOrigin),
      );
      if (cookies.isEmpty) return null;
      return cookies.map((c) => '${c.name}=${c.value}').join('; ');
    } catch (_) {
      return null;
    }
  }

  void _startHeartbeatLoop() {
    _heartbeatTimer?.cancel();
    _heartbeatTimer = Timer.periodic(
      const Duration(seconds: 60),
      (_) => _heartbeatTick(),
    );
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
    // B7：连续 2 次 authDead（401/403）＝登录已死，立即触发探针复核
    // （不等 60 秒定时器），并清掉本地会话快照（防过期快照下一轮又被
    // 拿去撞，见 A7）；网络不通（null）只安静跳过，绝不误清快照。
    if (signal != null && signal.status == AuthStatus.authDead) {
      _authDeadStreak++;
      if (_authDeadStreak >= 2) {
        _authDeadStreak = 0;
        unawaited(_sessionLog.log('auth-dead-heartbeat'));
        try {
          await _enqueueAuth(() => _credStore.clearSession());
        } catch (_) {}
        _savedSession = null;
        final probe = await _probeLogin();
        if (probe != null && probe.isLogin && mounted) {
          await _onLoginPageDetected(fromConsole: true);
        }
      }
      return;
    }
    _authDeadStreak = 0;
    if (signal != null && signal.forceLogout) {
      await _handleForceLogoutSignal(signal.gateCode ?? 'G1');
      return;
    }
    // A7-3：心跳成功顺带刷新快照摘取时间（只更新 savedAt，不改 cookie
    // 值），避免「快照摘取时间陈旧 → 服务端轮换后快照整体作废」。
    if (signal != null && _savedSession != null) {
      unawaited(_touchSnapshot());
    }
    if (_heartbeatTicks % 5 == 1) {
      final admin = await _extService.checkIsAdmin();
      if (mounted && admin != _isAdmin) setState(() => _isAdmin = admin);
    }
  }

  /// QF-02：快照恢复时期的当前账号（许可门认到的用户名优先，已存凭据
  /// 用户名其次，上次登录名兜底）；三路都不知道时返回 null，isFresh
  /// 严格档下快照不新鲜、退回凭据登录。
  String? _snapshotExpectedAccount() {
    if (_gateUsername.isNotEmpty) return _gateUsername;
    final u = _savedCreds?.username;
    if (u != null && u.isNotEmpty) return u;
    final last = _settings?.lastUsername;
    return (last != null && last.isNotEmpty) ? last : null;
  }

  /// 快照摘取时间刷新：同组 cookie、savedAt 记为现在（服务端时间优先）。
  Future<void> _touchSnapshot() async {
    final snap = _savedSession;
    if (snap == null) return;
    final now = _serverNow();
    final fresh = SessionSnapshot(
      cookies: snap.cookies,
      savedAt: now,
      accountId: snap.accountId,
    );
    try {
      await _enqueueAuth(() => _credStore.saveSession(fresh));
      _savedSession = fresh;
      _lastSnapshotAt = now;
    } catch (_) {}
  }

  /// 现在（服务端时间优先：预检回包 serverTime 算出的偏移；无偏移时本地钟）。
  DateTime _serverNow() {
    final off = _serverClockOffset;
    return off == null ? DateTime.now() : DateTime.now().add(off);
  }

  /// B22 返修：预检跑过后用服务端时间重算快照新鲜度。冷启恢复路径在
  /// 预检前只能按本地时间判定（_serverNow() 此时即本地时间）；一旦
  /// 服务端时间到手，若快照按服务端时间已过期（本地钟偏慢时才会发生），
  /// 立即清掉快照并记日志，不静默沿用本地钟的旧结论。快照仍新鲜时
  /// 什么都不做（不改 savedAt，只重算判定）。
  Future<void> _recheckSnapshotFreshness() async {
    final snap = _savedSession;
    if (snap == null || _serverClockOffset == null) return;
    final fresh = snap.isFresh(
      DateTime.now(),
      serverNow: _serverNow(),
      expectedAccount: _snapshotExpectedAccount(),
    );
    if (fresh) return;
    unawaited(
      _sessionLog.log(
        'snapshot-stale-server-clock',
        extra: 'savedAt=${snap.savedAt.toIso8601String()}',
      ),
    );
    try {
      await _enqueueAuth(() => _credStore.clearSession());
    } catch (_) {}
    _savedSession = null;
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
          decision:
              report.decision ??
              (report.reviewPending
                  ? const LicenseDecision(allow: false, code: 'DEVICE_REVIEW')
                  : null),
          fromDeviceReport: true,
          reviewPending: report.reviewPending,
          // 待审与转赠门同走 forceLogout 字段：待审优先落 DEVICE_REVIEW 面
          forceLogoutSignal: report.deviceForceLogout && !report.reviewPending,
        );
        if (await _applyGateAction(action)) {
          return;
        }
      }
      // B7 返修：用带 authDead 标记的 fetchLicenseMeResult——401/403
      // 时记 _licenseAuthDead（许可区据此显示「登录已过期，请重新登录」
      // ＋重新登录入口），不再只回 null 让调用方显示空白占位。
      final meResult = await _licenseService.fetchLicenseMeResult();
      final me = meResult.me;
      if (!mounted) return;
      if (meResult.authDead ||
          _isRecentAuthFailure(_licenseService.lastAuthFailureAt)) {
        _licenseAuthDead = true;
        if (!_licenseErrorSnacked) {
          _licenseErrorSnacked = true;
          _snack('登录已过期，请重新登录。');
        }
        _scheduleLicenseRetry();
      } else if (me != null && _licenseAuthDead) {
        if (mounted) setState(() => _licenseAuthDead = false);
      }
      if (me != null) {
        if (me.username != null && me.username!.isNotEmpty) {
          _gateUsername = me.username!;
          // QF-02：许可门认到用户名时同步上次登录名（快照恢复后才跑
          // 许可门的路径也以此保持同步）。
          unawaited(_settings?.setLastUsername(me.username!));
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
        // B21：许可门失败不再只提示一次就放行——进控制台后每 5 分钟
        // 重试一次（最多 3 次），成功后清标记。
        _scheduleLicenseRetry();
      }
    } catch (_) {
      // 许可检查本身失败不锁死使用：口径同上，只提示不拦截
      if (mounted && !_licenseErrorSnacked) {
        _licenseErrorSnacked = true;
        _snack('许可信息读取失败，请检查网络后重试。');
        _scheduleLicenseRetry();
      }
    } finally {
      _licenseCheckBusy = false;
    }
  }

  /// 许可门失败重试（B21）：5 分钟后重跑一次，最多 3 次；成功后
  /// _runLicenseGateCheck 内无失败分支即不再排期，标记由调用方清。
  void _scheduleLicenseRetry() {
    if (_licenseRetryCount >= 3) return;
    _licenseRetryCount++;
    _licenseRetryTimer?.cancel();
    _licenseRetryTimer = Timer(const Duration(minutes: 5), () {
      if (!mounted || !_chromeVisible) return;
      _licenseCheckedThisSession = false;
      _licenseErrorSnacked = false;
      unawaited(_runLicenseGateCheck());
    });
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
          setState(
            () => _gateDecision =
                action.decision ??
                const LicenseDecision(
                  allow: false,
                  code: 'DEVICE_REVIEW',
                  enforce: true,
                ),
          );
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
    final keepCreds =
        _gateCreds ??
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
    final result = await _licenseService.fetchLicenseMeResult();
    final me = result.me;
    if (!mounted) return;
    // B7 返修：401/403 时明确报「登录已过期」，不再与网络失败混为一谈。
    if (result.authDead ||
        _isRecentAuthFailure(_licenseService.lastAuthFailureAt)) {
      setState(() => _licenseAuthDead = true);
      _snack('登录已过期，请重新登录。');
      return;
    }
    if (me != null && _licenseAuthDead) {
      setState(() => _licenseAuthDead = false);
    }
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
      return _licenseService.claimKey(
        key,
        username: creds.username,
        password: creds.password,
      );
    }
    return _licenseService.claimKey(key);
  }

  /// 打开换绑申诉页（§11.9）：由壳自动带入本机设备码，用户不手填。
  Future<void> _openRebind() async {
    _deviceCode ??= await _deviceCodeStore.getOrCreate();
    await _openShellWeb(
      '申诉换绑设备',
      SvcUrls.instance.rebindUrl,
      postFields: {
        'dc': _deviceCode ?? '',
        'platform': 'mobile',
        'ch': 'android',
      },
    );
  }

  /// 在壳内打开自有网页（购买/查询/申诉/客服）：先移植会话，再推壳内页。
  Future<void> _openShellWeb(
    String title,
    String url, {
    Map<String, String>? postFields,
  }) async {
    // 打开前顺手刷新服务地址解析：此前解析失败过的，本次重试（H-6 的
    // 失败不缓存与此配合）；当次 url 由调用方以 getter 取值，getter 的
    // 退役源过滤＋正式兜底保证不落死链（H-1）。
    await SvcUrls.instance.ensureResolved();
    // A-06：重解析后同步一次网络层（域名变了才重建，否则为空操作）。
    unawaited(_rebuildServicesNetwork());
    await _transplantSessionToExt();
    if (!mounted) return;
    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => ShellWebPage(
          palette: _palette,
          title: title,
          url: url,
          postBody: postFields == null
              ? null
              : Uint8List.fromList(
                  utf8.encode(Uri(queryParameters: postFields).query),
                ),
        ),
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
  /// A2：上次会话以失败收尾时，切回设备槽先对设备槽执行一次冷启
  /// （about:blank → _startUrl），不许带着脏 iframe 续用。
  /// A-07：切槽记历史（recordSlotVisit：栈空先压当前槽再压目标槽；
  /// 历史回退路径 recordHistory:false，只切槽不记）。
  void _activateSlot(AppSlot slot, {bool recordHistory = true}) {
    // S-032＋S-043：切槽推进生命周期（ACTIVE／WARM／COLD），超期与溢出
    // 的 WARM 槽降 COLD、释放渲染进程；控制台槽登录／会话态最低 WARM。
    final released = _slotLifecycle.onActivated(
      slot,
      consoleHasSession: _chromeVisible,
    );
    for (final s in released) {
      unawaited(_releaseSlotRenderer(s));
    }
    // S-027/R-08：后台槽死后只记了“需恢复”标记，切回前台时才重建。
    if (_rendererRecovery.needsRecovery(slot)) {
      if (_rendererRecovery.beginDeferredRebuild(slot)) {
        _slotLoads.invalidate(slot);
        // 代次已递增：立即 setState 换 Key 挂新实例（onWebViewCreated
        // 重注册、_maybeLoadSlot 重载 URL），不等下面的切槽 setState。
        if (mounted) setState(() {});
      } else {
        // 上限已耗尽：进离线卡＋手动重试，不无限重建。
        _slotLifecycle.markDisposed(slot);
        _enterOffline();
      }
    }
    if (slot == AppSlot.devices && _lastSessionFailed && _web != null) {
      _lastSessionFailed = false;
      unawaited(
        _sessionLog.log('session-cold-restart', nodeid: _sessionNodeid ?? ''),
      );
      unawaited(
        _web!
            .loadUrl(urlRequest: URLRequest(url: WebUri('about:blank')))
            .then(
              (_) =>
                  _web?.loadUrl(urlRequest: URLRequest(url: WebUri(_startUrl))),
            ),
      );
    }
    if (_slot != slot) {
      final from = _slot;
      setState(() {
        _slot = slot;
        _scrolled = false;
      });
      if (recordHistory) {
        recordSlotVisit(_navHistory, from: from.name, to: slot.name);
      }
    }
    _maybeLoadSlot(slot);
    // 第 2 轮 #2：切进设备槽时拉一轮原生列表（60 秒节流；首次进入必拉）。
    if (slot == AppSlot.devices && _devicesShowNative) {
      unawaited(_maybeRefreshDeviceList());
    }
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
          urlRequest: URLRequest(url: WebUri(SvcUrls.instance.friendsUrl)),
        );
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
  /// F-06：只允许精确的生产 ext origin（[kServerOrigin]）——extOrigin
  /// 既经精确白名单校验，此处再要求与写死生产源逐字相等；解析值、
  /// 子域、非默认端口一律不移植（页面打开后由服务端自行走登录）。
  Future<void> _transplantSessionToExt() async {
    try {
      final cookies = await CookieManager.instance().getCookies(
        url: WebUri(kServerOrigin),
      );
      final origin = SvcUrls.instance.extOrigin;
      if (!SvcUrls.isTrustedSvcOrigin(origin) || origin != kServerOrigin) {
        return;
      }
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
    // A-06：重解析后同步一次网络层（域名变了才重建，否则为空操作）。
    unawaited(_rebuildServicesNetwork());
    await _transplantSessionToExt();
    if (!mounted) return;
    _homeWeb?.loadUrl(
      urlRequest: URLRequest(url: WebUri(SvcUrls.instance.homeUrl)),
    );
  }

  /// 登录成功后预加载首页槽（B12：好友/论坛槽改为懒加载，等用户第一
  /// 次点到底栏时再加载，不再登录瞬间三路并发打同一服务器）。
  void _preloadSlots() {
    if (_slotsPreloaded) return;
    _slotsPreloaded = true;
    _maybeLoadSlot(AppSlot.home);
  }

  /// 好友/论坛/首页/文件槽的 WebView 设置。
  /// S-027/R-01：显式置 useOnRenderProcessGone: true（不依赖插件的隐式
  /// 置 true 行为），五槽全绑 onRenderProcessGone。
  /// S-044：第三方 Cookie 按槽分配置（WebViewCookiePolicy，全槽 false；
  /// 盘点结论：无功能依赖第三方 Cookie，见 webview_cookie_policy.dart）。
  InAppWebViewSettings _slotWebViewSettings([AppSlot slot = AppSlot.home]) =>
      InAppWebViewSettings(
        javaScriptEnabled: true,
        domStorageEnabled: true,
        databaseEnabled: true,
        cacheEnabled: true,
        thirdPartyCookiesEnabled: WebViewCookiePolicy.thirdPartyCookiesEnabled(
          slot,
        ),
        useOnRenderProcessGone: true,
        supportZoom: true,
        builtInZoomControls: true,
        displayZoomControls: false,
        useShouldOverrideUrlLoading: true,
        mediaPlaybackRequiresUserGesture: true,
        allowsInlineMediaPlayback: true,
        iframeAllow: 'fullscreen',
        applicationNameForUserAgent: 'QFRemote',
        // target=_blank / window.open 不另开窗：onCreateWindow 里就地打开
        supportMultipleWindows: true,
      );

  /// 新窗口请求（target=_blank 等）：自有源才就地打开；外站新窗口一律
  /// 走系统浏览器（B19），不许在壳内打开（顶栏仍是 QFRemote，易钓鱼），
  /// 也不许冲掉控制台会话上下文。返回 false＝不创建新窗口。
  Future<bool> _onCreateWindowInPlace(
    InAppWebViewController controller,
    CreateWindowAction action,
  ) async {
    final u = action.request.url;
    if (u != null && (u.scheme == 'http' || u.scheme == 'https')) {
      if (!SvcUrls.instance.isOwnOrigin(u.toString())) {
        try {
          await launchUrl(
            Uri.parse(u.toString()),
            mode: LaunchMode.externalApplication,
          );
        } catch (_) {}
        return false;
      }
      try {
        await controller.loadUrl(urlRequest: URLRequest(url: u));
      } catch (_) {}
    }
    return false;
  }

  /// 槽内内容页（好友/聊天/论坛）加载完成：藏掉页面自带顶/底栏（壳框架
  /// 即定版框架，见 slot_nav.dart 的口径说明），功能与内容不动。
  Future<void> _injectShellChrome(
    InAppWebViewController controller,
    WebUri? url,
  ) async {
    if (!isShellContentPage(url?.toString())) return;
    try {
      // B13 返修：注入求值包 5 秒超时，超时按本步跳过并记日志。
      await controller
          .evaluateJavascript(source: buildShellChromeHideScript())
          .timeout(const Duration(seconds: 5));
    } on TimeoutException {
      debugPrint('QFSHELL chrome inject timeout, skipped this load');
    } catch (_) {
      // 页面已切走：下一页加载完成时再注入
    }
    // P0-2：每页加载完成都把壳主题推给 WebView（控制台／好友／聊天／论坛槽共用），
    // 与 Web 页约定的 `qf-theme-state` 事件同契约；mode 按手动偏好（有则 'dark'/'blue'，
    // 无则 'system'），resolved 按当前深浅。推送失败静默跳过。
    await _pushThemeToWebView(controller);
  }

  /// P0-2：首页/文件槽的 onLoadStop——只推壳主题，不注入 chrome 隐藏脚本
  /// （这两个槽此前无 onLoadStop，chrome 注入行为保持原样不动）。
  Future<void> _pushThemeOnLoadStop(
    InAppWebViewController controller,
    WebUri? url,
  ) async {
    if (!isShellContentPage(url?.toString())) return;
    await _pushThemeToWebView(controller);
  }

  /// P0-2：把壳主题推给单个已加载 WebView（见 buildThemeStateEventJs 契约）。
  Future<void> _pushThemeToWebView(InAppWebViewController c) async {
    final isDark = _themeMode == QfThemeMode.dark;
    final pref = _settings?.themePref;
    final mode = (pref != null && pref.isNotEmpty)
        ? _themeMode.prefValue
        : 'system';
    try {
      await c
          .evaluateJavascript(
            source: buildThemeStateEventJs(isDark: isDark, mode: mode),
          )
          .timeout(const Duration(seconds: 5));
    } catch (_) {
      // 页面已切走：下一页加载完成时再推
    }
  }

  /// P0-2：把壳主题推给全部已加载 WebView（控制台／好友／聊天／论坛槽）。
  Future<void> _pushThemeToWebViews() async {
    // S-027/R-07：渲染进程已死的槽跳过推送，不向死实例求值。
    final ctrls = <(AppSlot, InAppWebViewController?)>[
      (AppSlot.devices, _web),
      (AppSlot.home, _homeWeb),
      (AppSlot.files, _filesWeb),
      (AppSlot.friends, _friendsWeb),
      (AppSlot.forum, _forumWeb),
    ];
    for (final (slot, c) in ctrls) {
      if (c == null) continue;
      if (!_rendererRecovery.isAlive(slot)) continue;
      await _pushThemeToWebView(c);
    }
  }

  /// 槽内导航口径（与控制台一致）：跳登出地址＝手动退出；只放行 http/https；
  /// 外站链接改走系统浏览器（B19），不在壳内打开。
  Future<NavigationActionPolicy?> _slotUrlPolicy(
    InAppWebViewController controller,
    NavigationAction action,
  ) async {
    final url = action.request.url;
    if (url == null) return NavigationActionPolicy.CANCEL;
    // /logout 只认自有服务源：外站同名路径不许误触发手动退出清凭据
    if (url.path == '/logout' && SvcUrls.instance.isOwnOrigin(url.toString())) {
      _noteManualLogout();
    }
    if (url.scheme == 'http' || url.scheme == 'https') {
      if (!SvcUrls.instance.isOwnOrigin(url.toString())) {
        try {
          await launchUrl(
            Uri.parse(url.toString()),
            mode: LaunchMode.externalApplication,
          );
        } catch (_) {}
        return NavigationActionPolicy.CANCEL;
      }
      return NavigationActionPolicy.ALLOW;
    }
    return NavigationActionPolicy.CANCEL;
  }

  /// 证书挑战（2.4.5 B3）：公共 CA 走系统默认校验——本回调只在系统
  /// 校验失败时才被调用，失败一律 CANCEL，不 PROCEED；同时弹证书异常卡。
  Future<ServerTrustAuthResponse> _onTrustChallenge(
    InAppWebViewController controller,
    URLAuthenticationChallenge challenge,
  ) async {
    if (!_certErrorShown && mounted) {
      _certErrorShown = true;
      unawaited(
        _sessionLog.log(
          'cert-rejected',
          extra: 'host=${challenge.protectionSpace.host}',
        ),
      );
      _showCertError();
    }
    return ServerTrustAuthResponse(
      action: ServerTrustAuthResponseAction.CANCEL,
    );
  }

  /// 证书异常卡（B3）：文案＋复制诊断（最近 20 条阶段日志）。
  Future<void> _showCertError() async {
    if (!mounted) return;
    final diag = await _diagnosticsTextFull();
    if (!mounted) return;
    await showQfDialog<void>(
      context: context,
      barrierDismissible: false,
      builder: (ctx) => AlertDialog(
        title: const Text('服务器证书异常'),
        content: const Text('服务器证书无效，已停止连接（证书无效），请检查网络或稍后重试。'),
        actions: [
          QfButtonTapTarget(
            child: TextButton(
              onPressed: () async {
                await Clipboard.setData(ClipboardData(text: diag));
                if (ctx.mounted) Navigator.of(ctx).pop();
                _snack('诊断信息已复制。');
              },
              child: const Text('复制诊断'),
            ),
          ),
          QfButtonTapTarget(
            child: FilledButton(
              onPressed: () => Navigator.of(ctx).pop(),
              child: const Text('知道了'),
            ),
          ),
        ],
      ),
    );
  }

  /// 系统返回键分级：先页内后退 → 再回设备槽 → 最后退出（纯裁决见 slot_nav）。
  /// A4：会话失败态下第一次按弹原生确认（重试/返回设备列表），不执行
  /// goBack()；会话建立中（connecting）按返回键先弹「正在建立会话，
  /// 确定退出吗？」。
  Future<void> _handleSystemBack() async {
    if (_sessionFailed) {
      final retry = await _confirmSessionFailedBack();
      if (retry == true) {
        await _retrySession();
      } else if (retry == false) {
        _exitSessionToDevices();
      }
      return;
    }
    if (_sessionConnecting) {
      final leave = await _confirmLeaveConnecting();
      if (leave != true) return;
      _stopSessionWatcher();
      _clearKeepScreenOn();
    }
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

  /// 会话失败态返回键确认：true＝重试会话，false＝返回设备列表，
  /// null＝留在失败卡。
  Future<bool?> _confirmSessionFailedBack() async {
    if (!mounted) return null;
    return showQfDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('会话已失败'),
        content: const Text('当前会话已失败，要重试会话还是返回设备列表？'),
        actions: [
          QfButtonTapTarget(
            child: TextButton(
              onPressed: () => Navigator.of(ctx).pop(false),
              child: const Text('返回设备列表'),
            ),
          ),
          QfButtonTapTarget(
            child: FilledButton(
              onPressed: () => Navigator.of(ctx).pop(true),
              child: const Text('重试会话'),
            ),
          ),
        ],
      ),
    );
  }

  /// 会话建立中返回键确认：true＝确定退出会话建立。
  Future<bool?> _confirmLeaveConnecting() async {
    if (!mounted) return null;
    return showQfDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('正在建立会话'),
        content: const Text('正在建立远程会话，确定退出吗？'),
        actions: [
          QfButtonTapTarget(
            child: TextButton(
              onPressed: () => Navigator.of(ctx).pop(false),
              child: const Text('继续等待'),
            ),
          ),
          QfButtonTapTarget(
            child: FilledButton(
              onPressed: () => Navigator.of(ctx).pop(true),
              child: const Text('确定退出'),
            ),
          ),
        ],
      ),
    );
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
              origin,
              creds.username,
              creds.password,
            );
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
    final pendingValid =
        pending != null && isNewerVersion(pending, _currentVersion);
    ReleaseManifest? manifest;
    try {
      // 有落盘待更按原口径 8 秒取清单裁决；无待更只为核强更线短探 3 秒，
      // 断网启动不被长等拖住（取不到照样放行）。
      manifest = await _updateService.fetchManifest(
        timeout: Duration(seconds: pendingValid ? 8 : 3),
      );
    } catch (_) {
      manifest = null; // 取不到清单 = 服务器连不上 → 放行
    }
    final decision = decideUpdate(
      currentVersion: _currentVersion,
      manifestEntry: manifest?.android,
      pendingVersion: pendingValid ? pending : null,
      isLaunchCheck: true,
    );
    // B16：弱网放行（passOffline）时记待复核标记——进控制台后网络恢复
    // 时立即重跑一次更新门（见 _maybeRecheckGate），不许长期停留在
    // 低于 minUsable 的旧版而无感知。
    if (decision == UpdateDecision.passOffline) {
      await settings.setPendingGateRecheck(true);
    }
    if (decision == UpdateDecision.forceAtLaunch && manifest?.android != null) {
      if (!mounted) return;
      setState(() {
        _forceEntry = manifest!.android;
        _gateDone = true;
      });
      return;
    }
    if (pending != null &&
        (decision == UpdateDecision.none && manifest != null ||
            !pendingValid)) {
      // 待更新已被撤下/已不比本机新，或落盘值本身已过期 → 清掉标记
      await settings.setPendingUpdateVersion(null);
    }
    if (!mounted) return;
    setState(() => _gateDone = true);
  }

  /// 弱网放行后的更新门复核（B16）：进控制台后网络恢复（退出离线或
  /// 探活首次成功）时立即重跑一次 _launchGate 逻辑；命中强更线即弹
  /// 强制更新页（即使在会话中，minUsable 命中时也弹强更页）。
  Future<void> _maybeRecheckGate() async {
    final settings = _settings;
    if (settings == null || !settings.pendingGateRecheck || _gateRecheckDone) {
      return;
    }
    _gateRecheckDone = true;
    await settings.setPendingGateRecheck(false);
    await _launchGate(settings);
  }

  // ---------------- 自动重新登录＋记住账号密码（2.3.0） ----------------

  /// 登录逻辑只认控制台根页面（同源、根路径）；好友/论坛/注册等页面不介入。
  bool get _isConsolePage {
    if (kHasTestUrl) return false;
    final uri = Uri.tryParse(_currentUrl);
    if (uri == null) return false;
    return uri.origin == kServerOrigin && (uri.path.isEmpty || uri.path == '/');
  }

  /// 主 frame 导航切换时重建本地授权上下文（F-07）：主 frame 离开
  /// 控制台（登录页／控制台根之外，如 about:blank 冷启）即丢弃挂起
  /// 的登录提交——上个登录页捕获的账号密码不许带到新上下文里被消费。
  /// 注意：登录成功后导航到控制台根不触发（仍是控制台主 frame），
  /// 挂起提交由 _onConsoleDetected 正常消费。
  void _clearPendingSubmitIfLeftConsole(String url) {
    if (isConsoleMainFrame(url)) return;
    if (_pendingSubmit == null) return;
    _pendingSubmit = null;
    _pendingSubmitAt = null;
    debugPrint('QFJSBRIDGE pending submit dropped on nav to $url');
  }

  void _startLoginLoop() {
    _loginTimer?.cancel();
    _loginTimer = null;
    _loginLoopStarter?.cancel();
    // B13 返修：看护与登录探针相位错峰——看护首拍在启动后 800ms
    // （WatchdogCore.start），登录首拍错开到 1800ms，之后登录 2 秒一拍、
    // 看护 4 秒一拍，两拍起始错开 1 秒，避免同拍并发求值堆积。
    _loginLoopStarter = Timer(const Duration(milliseconds: 1800), () {
      if (!mounted) return;
      _loginTimer = Timer.periodic(
        const Duration(seconds: 2),
        (_) => _loginTick(),
      );
    });
  }

  /// JSBridge 来源守卫（F-07）：handler 回调无来源元数据，调用前先
  /// 核对当前主 frame URL（[_currentUrl]，导航开始即同步更新）。
  /// 不过门即丢弃并记一条会话日志，不执行任何回调逻辑。
  String _bridgeCapability = _newBridgeCapability();

  static String _newBridgeCapability() {
    final random = math.Random.secure();
    return base64UrlEncode(List<int>.generate(32, (_) => random.nextInt(256)));
  }

  bool _hasBridgeCapability(List<dynamic> args) =>
      args.isNotEmpty &&
      args.first is Map &&
      (args.first as Map)['bridgeCapability'] == _bridgeCapability;

  bool _jsbridgeAllowed(String handler, bool Function(String?) check) {
    if (check(_currentUrl)) return true;
    debugPrint('QFJSBRIDGE rejected $handler from $_currentUrl');
    unawaited(
      _sessionLog.log(
        'jsbridge-rejected',
        extra: 'handler=$handler url=$_currentUrl',
      ),
    );
    return false;
  }

  /// 注册登录桥的两个 JS 处理器（登录提交回传 / 手动退出回传）。
  void _registerLoginHandlers(InAppWebViewController controller) {
    controller.addJavaScriptHandler(
      handlerName: kHandlerLoginSubmit,
      callback: (args) {
        // F-07：登录密码 handler 只允许登录页主 frame；会话页／外站
        // frame 冒名提交一律丢弃。
        if (!_hasBridgeCapability(args)) return;
        if (!_jsbridgeAllowed(kHandlerLoginSubmit, isLoginSubmitAllowed)) {
          return;
        }
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
      callback: (args) {
        // F-07：手动退出只允许控制台根 SPA 主 frame；外站 frame 冒名
        // 调「退出」清凭据一律丢弃（原生菜单／/logout 导航另走它路）。
        if (!_hasBridgeCapability(args)) return;
        if (!_jsbridgeAllowed(kHandlerManualLogout, isManualLogoutAllowed)) {
          return;
        }
        _noteManualLogout();
      },
    );
    // 2.3.1 登录页版式（16:37 定版）：桥注入的「购买密钥/查询密钥」两行
    // 点击回传——壳内打开 /purchase 或 /license/status，不外跳。
    controller.addJavaScriptHandler(
      handlerName: kHandlerLicenseNav,
      callback: (args) {
        // F-07：购买／查询／换绑三行只注在登录面板里，只允许登录页主 frame。
        if (!_hasBridgeCapability(args)) return;
        if (!_jsbridgeAllowed(kHandlerLicenseNav, isLicenseNavAllowed)) {
          return;
        }
        if (args.isEmpty || args.first is! Map) return;
        final target = (args.first as Map)['target']?.toString();
        if (target == 'purchase') {
          unawaited(_openShellWeb('购买密钥', SvcUrls.instance.purchaseUrl));
        } else if (target == 'status') {
          unawaited(_openShellWeb('查询密钥', SvcUrls.instance.licenseStatusUrl));
        } else if (target == 'rebind') {
          unawaited(_openRebind());
        }
      },
    );
    // 设备钥匙递入走 evaluateJavascript 直调页面钩子（L 线定版契约
    // qfShellDeviceUnlock/qfShellDeviceEnroll，在 _chatTick 里按决策递入），
    // 不再另设 JS 处理器——页面不主动取钥匙，钥匙只经壳单向递入内存。
  }

  // Session progress is observed by the native one-second probe. Do not expose
  // a page-controlled handler that can advance readiness or replace node IDs.

  Future<LoginProbe?> _probeLogin() async {
    final web = _web;
    if (web == null) return null;
    try {
      // B13：探针求值 5 秒超时，挂起不拖下一拍。
      final r = await web
          .evaluateJavascript(source: kLoginProbeJs)
          .timeout(const Duration(seconds: 5));
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
      // B13：求值 5 秒超时。
      final r = await web
          .evaluateJavascript(source: js)
          .timeout(const Duration(seconds: 5));
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
      bridgeCapability: _bridgeCapability,
      // A4：注入按钮底色跟随当前偏好主题。
      isDark: _themeMode == QfThemeMode.dark,
    );
    try {
      // B13 返修：桥注入求值包 5 秒超时，超时按本步跳过并记日志，
      // 不许挂起的求值拖住后续所有拍。
      final r = await web
          .evaluateJavascript(source: js)
          .timeout(const Duration(seconds: 5));
      debugPrint('QFLOGIN bridge -> $r');
      if (fillSaved && r?.toString().contains('filled') == true) {
        _filledThisLoad = true;
      }
    } on TimeoutException {
      debugPrint('QFLOGIN bridge inject timeout, skipped this tick');
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
    // S-027/R-07：好友槽渲染进程已死（重建中）时跳过本拍。
    if (!_rendererRecovery.isAlive(AppSlot.friends)) return;
    final friendsGen = _rendererRecovery.generation(AppSlot.friends);
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
      // B13 返修：状态＋能力合并为一次求值（kChatCombinedProbeJs），
      // 一次 evaluateJavascript 取回全部聊天状态，Dart 侧一次解析；
      // 本拍最多再有一次动作求值（解锁步）或一次桥注入，不再 3～5 次
      // 顺序求值。求值 5 秒超时，挂起不拖下一拍。
      final raw = await web
          .evaluateJavascript(source: kChatCombinedProbeJs)
          .timeout(const Duration(seconds: 5));
      final combined = parseChatCombined(raw?.toString());
      // S-027/R-07：重建期间旧拍回来即丢弃，不许旧响应写入新实例。
      if (friendsGen != _rendererRecovery.generation(AppSlot.friends)) return;
      final st = combined?.state;
      if (st != null) {
        final caps = combined!.caps;
        final step = planChatUnlock(
          manualLogout: _autoLogin.suppressedByManualLogout,
          state: st,
          caps: caps,
          hasCreds: pass != null && pass.isNotEmpty,
        );
        switch (step) {
          case ChatUnlockStep.custodyUnlock:
            final r = await web
                .evaluateJavascript(source: buildChatCustodyUnlockScript())
                .timeout(const Duration(seconds: 5));
            debugPrint('QFCHAT custody-unlock -> $r');
            orchestrated = true;
          case ChatUnlockStep.deviceUnlock:
          case ChatUnlockStep.deviceEnroll:
            final key = await _deviceKeyVault.getOrCreate();
            final script = step == ChatUnlockStep.deviceUnlock
                ? buildChatDeviceUnlockScript(key)
                : buildChatDeviceEnrollScript(key);
            final r = await web
                .evaluateJavascript(source: script)
                .timeout(const Duration(seconds: 5));
            debugPrint('QFCHAT $step -> $r');
            orchestrated = true;
          case ChatUnlockStep.credentialUnlock:
            final r = await web
                .evaluateJavascript(
                  source: buildChatCredentialUnlockScript(pass!),
                )
                .timeout(const Duration(seconds: 5));
            debugPrint('QFCHAT credential-unlock -> $r');
            orchestrated = true;
          case ChatUnlockStep.custodyEnroll:
            final r = await web
                .evaluateJavascript(source: buildChatCustodyEnrollScript())
                .timeout(const Duration(seconds: 5));
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
      final r = await web
          .evaluateJavascript(
            source: buildChatBridgeJs(
              username: user,
              password: pass,
              // QF-04：只有用户勾过控制台「记住此设备」才让聊天兜底登录
              // 建 30 天持久会话；没勾过就不勾 lgRemember。
              rememberDevice: _settings?.rememberDevice ?? false,
            ),
          )
          .timeout(const Duration(seconds: 5));
      debugPrint('QFCHAT bridge -> $r');
    } catch (_) {
      // 页面正在跳转：下一拍再来
    }
  }

  Future<void> _loginTick() async {
    if (_loginTickBusy || !mounted || _web == null) return;
    // S-027/R-07：渲染进程已死（重建中）时跳过本拍，不对着死控制器求值、
    // 不攒异常、不记错误；代次在 await 后复核，旧拍回来即丢弃。
    if (!_rendererRecovery.isAlive(AppSlot.devices)) return;
    final rendererGen = _rendererRecovery.generation(AppSlot.devices);
    if (!_gateDone || _forceEntry != null || _offline) return;
    if (_slot == AppSlot.friends && _isChatPage && _friendsWeb != null) {
      _loginTickBusy = true;
      try {
        await _chatTick();
        // B25：聊天页每 5 拍（10 秒）顺带跑一次控制台登录探针（不阻塞
        // _chatTick）；探针确认掉登录时先提示，切回设备槽立即走恢复链。
        _chatTickCount++;
        if (_chatTickCount % 5 == 0) {
          final probe = await _probeLogin();
          if (probe != null && probe.isLogin && mounted) {
            _snack('登录已过期，正在恢复…');
            await _onLoginPageDetected(fromConsole: true);
          }
        }
      } finally {
        _loginTickBusy = false;
      }
      return;
    }
    if (!_isConsolePage) return;
    _loginTickBusy = true;
    // A6：发起探针时捕获身份代数；await 回来后代数已变（登录成功/
    // 手动退出/强制下线）则整单丢弃并触发一次 _refreshAuthState，
    // 不静默吞掉、不许旧响应写入新登录态。
    final gen = _authGen;
    try {
      final probe = await _probeLogin();
      if (probe == null || !mounted) return;
      if (rendererGen != _rendererRecovery.generation(AppSlot.devices)) {
        // 重建期间旧拍回来：丢弃，不许旧响应写入新实例状态。
        return;
      }
      if (gen != _authGen) {
        unawaited(_refreshAuthState());
        return;
      }
      if (probe.isConsole) {
        _unknownProbeStreak = 0;
        _prevProbeState = 'console';
        await _onConsoleDetected();
      } else if (probe.isLogin) {
        _unknownProbeStreak = 0;
        final fromConsole = _prevProbeState == 'console';
        _prevProbeState = 'login';
        await _onLoginPageDetected(fromConsole: fromConsole);
      } else {
        // unknown：页面还没画完，这一拍不动作、也不覆盖上一个确定状态；
        // B5：连续 5 拍（10 秒）unknown → 强制退恢复盖/启动画面，露出生页
        // 原样 + 提示，不得永久蓝屏。
        _unknownProbeStreak++;
        if (_unknownProbeStreak >= 5) {
          _unknownProbeStreak = 0;
          unawaited(
            _sessionLog.log(
              'login-probe-unknown',
              extra:
                  'url=$_currentUrl hasPw=${probe.hasPasswordInput} '
                  'hasPanel=${probe.hasLoginPanel}',
            ),
          );
          if (mounted && (_recoveryCover || _splashVisible)) {
            setState(() {
              _recoveryCover = false;
              _splashVisible = false;
            });
            _snack('页面状态识别失败，请手动登录或重试。');
          }
        }
      }
    } finally {
      _loginTickBusy = false;
    }
  }

  /// 身份代数变化后的状态重读（A6）：重读 cookie + 重探针一次，
  /// 让新登录态尽快落定，而不是等下一拍 2 秒定时器。
  Future<void> _refreshAuthState() async {
    if (!mounted) return;
    final probe = await _probeLogin();
    if (probe == null || !mounted) return;
    if (probe.isConsole) {
      await _onConsoleDetected();
    } else if (probe.isLogin) {
      await _onLoginPageDetected(fromConsole: _prevProbeState == 'console');
    }
  }

  /// 探针确认已在控制台：落盘挂起的登录提交、刷新会话快照、收尾恢复盖子。
  Future<void> _onConsoleDetected() async {
    // A6：每个 await 之后校验身份代数，变了即 return（本轮响应已过期）。
    final gen = _authGen;
    if (!_injectedThisLoad) {
      await _injectBridge(fillSaved: false);
      if (gen != _authGen) return;
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
        // QF-02：登录成功即记上次登录名（冷启恢复快照的账号来源之一）。
        await s.setLastUsername(pending.username);
      }
      if (pending.rememberPassword) {
        try {
          await _enqueueAuth(
            () =>
                _credStore.saveCredentials(pending.username, pending.password),
          );
          _savedCreds = SavedCredentials(
            username: pending.username,
            password: pending.password,
          );
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
    if (gen != _authGen) return;
    // A6：新鲜登录过渡（恢复轮进行中或框架刚出现）才递增身份代数；
    // 探针每 2 秒的常规命中不递增（否则代数永远在变）。
    final freshLogin = _episodeRunning || !_chromeVisible;
    _autoLogin.onLoginSuccess();
    if (freshLogin) _authGen++;
    _episodeRunning = false;
    _episodeFinished = false; // 回到控制台：下一次掉登录算新一轮
    _stepWaitUntil = null;
    _failureSnackShown = false;
    await _maybeSnapshotSession();
    if (gen != _authGen && !freshLogin) return;
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
    // B26：首屏任务排队错峰——许可门（拦人）立即跑，槽预加载（体验）
    // 500ms 后再跑，不与许可门/更新检查三路并发抢服务器。
    Future<void>.delayed(const Duration(milliseconds: 500), () {
      if (mounted) _preloadSlots();
    });
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
      final cookies = await CookieManager.instance().getCookies(
        url: WebUri(kServerOrigin),
      );
      final map = <String, String>{};
      for (final c in cookies) {
        if ((c.name == 'xid' || c.name == 'xid.sig' || c.name == 'qfrem') &&
            c.value.toString().isNotEmpty) {
          map[c.name] = c.value.toString();
        }
      }
      if ((map['xid'] ?? '').isEmpty) return;
      // B22：savedAt 优先按服务端时间（预检回包算出的偏移），本地时钟兜底。
      // QF-02：快照绑账号——写侧与读侧同三路（上次登录名优先：_onConsoleDetected
      // 里刚用本次登录成功的用户名写过它，是最新鲜的来源；许可门用户名
      // 其次，已存凭据用户名兜底）。三路都不知道时不绑（accountId 为 null），
      // 严格档下恢复时不新鲜，下次登录成功即被带账号的新快照覆盖。
      final last = _settings?.lastUsername;
      final snapAccount = (last != null && last.isNotEmpty)
          ? last
          : (_gateUsername.isNotEmpty ? _gateUsername : _savedCreds?.username);
      final snap = SessionSnapshot(
        cookies: map,
        savedAt: _serverNow(),
        accountId: (snapAccount != null && snapAccount.isNotEmpty)
            ? snapAccount
            : null,
      );
      await _enqueueAuth(() => _credStore.saveSession(snap));
      _savedSession = snap;
      _lastSnapshotAt = _serverNow();
      debugPrint('QFLOGIN session snapshot saved (${map.keys.join(',')})');
    } catch (_) {
      // 摘不到就算了：下次探针再试，不影响使用
    }
  }

  /// 探针确认掉回登录页：按恢复链裁决下一步，全程盖住不闪登录页。
  /// [fromConsole]：上一拍还在控制台、这一拍掉回登录页（同页跳变也算新一轮）。
  Future<void> _onLoginPageDetected({required bool fromConsole}) async {
    // 挂起的提交超过 10 秒还没进控制台 = 这次登录没成：丢弃挂起；
    // 若是自动提交的，置凭据拦截（落盘），防旧密码反复去撞登录冻结。
    // B14：慢网容忍从 6 秒放宽到 10 秒。
    final pendingAt = _pendingSubmitAt;
    if (_pendingSubmit != null &&
        pendingAt != null &&
        DateTime.now().difference(pendingAt) > const Duration(seconds: 10)) {
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
    // B22 返修：isFresh 的 serverNow 参数真正接线——快照新鲜度按服务端
    // 时间（预检回包 serverTime 算出的偏移）判定，本地时钟只作兜底；
    // 冷启且预检未跑时 _serverNow() 即本地时间，预检跑过后见
    // _recheckSnapshotFreshness() 用服务端时间重算一次。
    final hasSession =
        _savedSession?.isFresh(
          DateTime.now(),
          serverNow: _serverNow(),
          expectedAccount: _snapshotExpectedAccount(),
        ) ??
        false;
    final hasCreds = _savedCreds != null;
    final step = _autoLogin.next(
      hasFreshSession: hasSession,
      hasCredentials: hasCreds,
    );
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
    if (step == RecoveryStep.restoreSession) {
      // A7：恢复链先验快照——带快照 cookie 调轻量接口验活；401/403
      // 即判快照已死（服务端已撤销/过期），跳过 reload()+6 秒等待，
      // 直接走凭据登录，不拖 6 秒。
      _recoveryStepText = '正在验证会话…';
      if (mounted) setState(() {});
      final snap = _savedSession!;
      final cookieHeader = snap.cookies.entries
          .map((e) => '${e.key}=${e.value}')
          .join('; ');
      final check = await verifySnapshotAlive(cookieHeader);
      if (check == SnapshotCheck.authDead) {
        unawaited(_sessionLog.log('snapshot-dead'));
        try {
          await _enqueueAuth(() => _credStore.clearSession());
        } catch (_) {}
        _savedSession = null;
        // 本轮快照已记一次？未记——直接改裁决：跳过快照步走凭据。
        // 记一笔 session 尝试（防无凭据时本轮空转），再重新裁决。
        _autoLogin.recordAttempt(RecoveryStep.restoreSession);
        if (mounted) setState(() => _recoveryCover = true);
        await _onLoginPageDetected(fromConsole: false);
        return;
      }
      _autoLogin.recordAttempt(step);
      debugPrint('QFLOGIN recovery: session restore');
      await _applySessionSnapshot(snap);
      // B6：先 reload()，等 onLoadStop 回来再置 _stepWaitUntil（见
      // _onPageLoaded 里的 _awaitingRestoreLoad），避免「已发导航 +
      // 6 秒盲等」窗口；等待期内用户点退出立即 stopLoading + 清快照。
      _awaitingRestoreLoad = true;
      _recoveryStepText = '正在恢复会话…';
      if (mounted) setState(() {});
      await _web?.reload();
    } else if (step == RecoveryStep.credentialLogin) {
      debugPrint('QFLOGIN recovery: credential silent login');
      _recoveryStepText = '正在用已存账号登录…';
      if (mounted) setState(() {});
      await _injectBridge(fillSaved: true);
      await Future<void>.delayed(const Duration(milliseconds: 450));
      // B14：点不到登录按钮（clicked==false）不记凭据尝试——按钮出现
      // 前最多等 4 秒（2 秒后重试一次点按钮），仍点不到才放手等下一拍，
      // 不烧掉唯一一次凭据尝试。
      var clicked = false;
      for (var attempt = 0; attempt < 2 && !clicked; attempt++) {
        if (attempt > 0) {
          await Future<void>.delayed(const Duration(seconds: 2));
        }
        _autoSubmitInFlight = true;
        clicked = await _evalJsBool(kSubmitLoginJs);
        debugPrint('QFLOGIN silent submit clicked=$clicked (try $attempt)');
      }
      Future<void>.delayed(
        const Duration(seconds: 2),
        () => _autoSubmitInFlight = false,
      );
      if (!clicked) {
        // 本轮不记数、不锁死：短暂等待后由下一拍探针重新裁决。
        _stepWaitUntil = DateTime.now().add(const Duration(seconds: 2));
        return;
      }
      _autoLogin.recordAttempt(step);
      _stepWaitUntil = DateTime.now().add(const Duration(seconds: 8));
    }
  }

  /// 取消恢复（A7/B14）：恢复盖上的「取消恢复，直接登录」——停掉本轮
  /// 恢复、露出生登录页，用户可手动登录。
  void _cancelRecovery() {
    _episodeRunning = false;
    _episodeFinished = true;
    _stepWaitUntil = null;
    _recoveryStepText = '';
    if (mounted) {
      setState(() {
        _recoveryCover = false;
        _splashVisible = false;
      });
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
    // B6：先停掉在途导航（已发出的 reload 不会被取消是旧竞态根因），
    // 再清 cookie；同时递增身份代数，在途恢复响应回来即丢弃。
    unawaited(_web?.stopLoading());
    _authGen++;
    _autoLogin.onManualLogout();
    _pendingSubmit = null;
    _pendingSubmitAt = null;
    _episodeRunning = false;
    _episodeFinished = true; // 退出后停在登录页：不许再开恢复轮
    _stepWaitUntil = null;
    _awaitingRestoreLoad = false;
    _failureSnackShown = false;
    _stopSessionWatcher();
    _clearKeepScreenOn();
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
    // QF-02：凭据被拒时上次登录名一并清掉（该账号已失效，不再作为
    // 快照恢复的账号来源）。
    try {
      await _settings?.setLastUsername(null);
    } catch (_) {}
  }

  Future<void> _clearAuthState() async {
    try {
      await _enqueueAuth(() => _credStore.clearAll());
    } catch (_) {}
    // A-05 接线硬门槛（第 1 轮 #9）：退出时清 Drift 库（设备／发件箱／
    // ID 映射），防止下个账号读到上个账号的本地残留。走 _authChain 排队
    // 且 await 到完成——清库一定在退出返回前落定，不会和重登后的新账号
    // 写库交叉。库未构建（降级启动）时为空操作；清库失败不挡退出链。
    // 只清数据行，不关库：退出后应用继续跑（登录页），下个账号复用
    // 同一 Services／同一库连接。
    try {
      await _enqueueAuth(
        () => clearServicesDataForLogout(_servicesHolder.services),
      );
    } catch (_) {}
    // 第 2 轮 #2：退出登录取消周期同步（第 1 轮后台线遗留，接口已暴露）。
    // 尽力而为：取消一个不存在的任务不是错，不抛、不挡退出链。
    // 注意：这里不 await——取消只是尽力而为，后面清场不依赖它。
    try {
      unawaited(_bgTier?.cancelPeriodicSync() ?? Future<void>.value());
    } catch (_) {}
    // 第 2 轮 #2：退出后设备槽回原生列表（下次登录时默认盖住 WebView，
    // 不留上一个账号的会话页在前台）。
    _devicesShowWeb = false;
    // 设备钥匙不清（L 线定版口径：退出登录不等于换设备；副本按账号存
    // 在服务端，本机钥匙留着，下个账号在本机解锁后会补写自己的副本）。
    // RC-04：退出登录即作废重连票据（换账号后旧票据绝不能复用）。
    await _stopReconnectSession();
    // 第 1 轮 #7 遗留项：退出登录取消周期同步（须 _clearAuthState
    // 持有方调已暴露的 cancelPeriodicSync()）。
    try {
      await _bgTier?.cancelPeriodicSync();
    } catch (_) {}
    _savedCreds = null;
    _savedSession = null;
    _lastSnapshotAt = null;
    try {
      await _settings?.clearAuthPrefs();
    } catch (_) {}
    // QF-02：手动退出时上次登录名显式清掉（clearAuthPrefs 里也清，
    // 这里再明写一遍：退出后冷启不得再用旧账号放行旧快照）。
    try {
      await _settings?.setLastUsername(null);
    } catch (_) {}
    try {
      await CookieManager.instance().deleteAllCookies();
    } catch (_) {}
    // B27：各 WebView 槽页面清空改为并行 + 各 3 秒超时（超时即跳过，
    // 不阻塞退出）；弱网下任一槽卡住也不拖住整条清场链。
    Future<void> blank(InAppWebViewController? c) async {
      if (c == null) return;
      try {
        await c
            .loadUrl(urlRequest: URLRequest(url: WebUri('about:blank')))
            .timeout(const Duration(seconds: 3));
      } catch (_) {}
    }

    await Future.wait([
      blank(_homeWeb),
      blank(_filesWeb),
      blank(_friendsWeb),
      blank(_forumWeb),
    ]);
    _friendsCurrentUrl = '';
    // A-07：退出登录清掉返回键历史（上一个账号的槽位访问记录
    // 不带到下个账号）。
    _navHistory.clear();
  }

  /// 原生菜单「退出账号」：清干净后走服务端登出地址回登录页。
  /// B27：等 _clearAuthState() 完成后再导航到 /logout，不再两路导航
  /// （清槽空白页 vs 登出地址）在同一 _web 上互相覆盖。
  Future<void> _manualLogoutFromMenu() async {
    _gateCreds = null;
    if (_gateDecision != null && mounted) {
      setState(() => _gateDecision = null);
    }
    _noteManualLogout();
    await _clearAuthState();
    await _web?.loadUrl(
      urlRequest: URLRequest(url: WebUri('$kServerOrigin/logout')),
    );
    if (mounted) _snack('已退出账号');
  }

  // ---------------- 探活（状态灯） ----------------

  void _startProbeLoop() {
    _runProbe();
    _probeTimer = Timer.periodic(
      const Duration(seconds: 60),
      (_) => _runProbe(),
    );
  }

  Future<ProbeResult> _runProbe() async {
    if (_probeBusy) {
      return _lastProbe ??
          ProbeResult(
            ok: false,
            at: DateTime.now(),
            elapsedMs: 0,
            error: '检测中',
          );
    }
    _probeBusy = true;
    final r = await probeServer(clientVersion: _currentVersion);
    _probeBusy = false;
    if (mounted) setState(() => _lastProbe = r);
    // B4：连续 2 次失败（且不在会话进行态）→ 进离线卡；成功清零。
    // B16：探活首次成功且有待复核标记 → 立即重跑更新门。
    if (r.ok) {
      final wasFailing = _probeFailStreak > 0;
      _probeFailStreak = 0;
      if (wasFailing) unawaited(_maybeRecheckGate());
    } else {
      _probeFailStreak++;
      if (_probeFailStreak >= 2 && !_sessionConnecting && !_offline) {
        _enterOffline();
      }
    }
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
      // B16：会话内更新检查失败后 10 分钟重试一次（最多 3 次），
      // 仍失败则在关于页显示失败态而非「已经是最新版」。
      _scheduleUpdateCheckRetry();
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

  /// 会话内更新检查失败重试（B16）：10 分钟后重跑一次，最多 3 次。
  void _scheduleUpdateCheckRetry() {
    if (_updateCheckRetries >= 3) return;
    _updateCheckRetries++;
    _updateCheckRetryTimer?.cancel();
    _updateCheckRetryTimer = Timer(const Duration(minutes: 10), () {
      if (!mounted) return;
      unawaited(_sessionUpdateCheck());
    });
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

  // ---------------- 会话阶段机（2.4.5 A1/A2/A3/A5/A8/A9/B1/B9） ----------------
  // 结构性前提：Android 没有原生远程会话实现——远程控制全程是设备槽
  // WebView 打开控制台、复用网页 SPA 的会话 iframe。Dart 侧的阶段机
  // 会话阶段由原生侧 1 秒
  // 探针读 Sess/#deskstatus/#Desk 兜底（handler 未就绪时）。

  int _stageIndex(SessionStage s) => SessionStage.values.indexOf(s);

  /// 冷启动看门狗（B1）：_web 首次 loadUrl 时启动 15 秒看门狗，超时无
  /// onLoadStop 且无 onReceivedError → _enterOffline()（离线卡＋立即
  /// 重试）并记 boot-load-timeout 日志。
  void _startBootLoadWatchdog() {
    if (_firstLoaded || _bootLoadWatchdog != null) return;
    _bootLoadWatchdog = Timer(const Duration(seconds: 15), () {
      _bootLoadWatchdog = null;
      if (!mounted || _firstLoaded || _offline) return;
      unawaited(_sessionLog.log('boot-load-timeout', extra: '15s-no-loadstop'));
      _enterOffline();
    });
  }

  /// 会话路由变化（顶层 #session/ 路由或 ?node=&viewmode= 深链）：
  /// 进入会话先跑预检（A5/A9），离开会话停 watcher、清常亮。
  void _onSessionRouteChanged(String url) {
    final route = parseSessionRoute(url);
    if (route == null) {
      if (_sessionConnecting || _sessionFailed) {
        _stopSessionWatcher();
        _exitSessionCleanup();
      }
      // 第 2 轮 #2：离开会话路由 → 设备槽回到原生列表（退出会话回列表、
      // 会话失败卡关掉、冷启重载控制台都走这里）。
      if (_devicesShowWeb && mounted) {
        setState(() => _devicesShowWeb = false);
      }
      return;
    }
    final nodeid = bareNodeId(route.nodeid);
    if (_sessionConnecting && _sessionNodeid == nodeid) return;
    if (_sessionFailed && _sessionNodeid == nodeid && _sessionCardShowing) {
      return;
    }
    unawaited(_runPreflight(nodeid));
  }

  /// 会话预检（A5/A9）：打开会话前先调服务端预检接口，8 秒内出卡，
  /// 不进「正在建立会话…」。通过才启动阶段 watcher；失败按三级分级出卡。
  Future<void> _runPreflight(String nodeid) async {
    if (_preflightBusy && _preflightFor == nodeid) return;
    _preflightBusy = true;
    _preflightFor = nodeid;
    final startedAt = DateTime.now();
    DevicePresence? presence;
    var timedOut = false;
    // QF-07：401/403 是登录过期，不是网络超时——单独记，卡片按
    // authExpired 出「登录已过期」，不误导成设备离线。
    var authExpired = false;
    try {
      presence = await DevicePresenceClient(
        cookieProvider: _consoleCookieHeader,
      ).fetchPresence(nodeid).timeout(const Duration(seconds: 8));
    } on AuthExpiredException {
      authExpired = true;
    } on TimeoutException {
      timedOut = true;
    } catch (_) {
      timedOut = true;
    }
    _preflightBusy = false;
    if (!mounted) return;
    if (presence?.serverTime != null) {
      _serverClockOffset = presence!.serverTime!.difference(DateTime.now());
      // B22 返修：预检跑过、服务端时间到手后，用服务端时间重算一次
      // 快照新鲜度——冷启时先按本地时间记的「新鲜」若按服务端时间已
      // 过期，立即清掉快照，不静默沿用本地钟。
      unawaited(_recheckSnapshotFreshness());
    }
    final outcome = authExpired
        ? PreflightOutcome.authExpired
        : classifyPreflight(presence, timedOut: timedOut);
    final elapsedMs = DateTime.now().difference(startedAt).inMilliseconds;
    unawaited(
      _sessionLog.log(
        'session_preflight',
        nodeid: nodeid,
        extra:
            'outcome=$outcome code=${presence?.code ?? 'none'} '
            'authExpired=$authExpired '
            'elapsedMs=$elapsedMs',
      ),
    );
    if (outcome == PreflightOutcome.ok) {
      _sessionDeviceName = (presence?.name ?? '').isNotEmpty
          ? presence!.name
          : nodeid;
      // 第 2 轮 #5：会话建立前中继选路门（QF-RELAY-1 §2.2）——取列表
      // 失败时 fail-open（不挡既有 WebView 会话路）；会话地址不在
      // 宣告列表内或列表耗尽时阻断，不建 watcher。
      final gate = await _sessionLayer.checkRelayGate();
      if (!mounted) return;
      if (gate.blocked) {
        unawaited(
          _sessionLog.log(
            'session-relay-blocked',
            nodeid: nodeid,
            extra: gate.message ?? '',
          ),
        );
        _snack(gate.message ?? '中继全部不可用，已保留现有会话');
        return;
      }
      _startSessionWatcher(nodeid);
      return;
    }
    if (outcome == PreflightOutcome.offlineStale) {
      unawaited(
        _sessionLog.log(
          'agent_stale',
          nodeid: nodeid,
          extra: 'lastPongAgeMs=${presence?.lastAgentPongAgeMs}',
        ),
      );
    }
    _sessionDeviceName = (presence?.name ?? '').isNotEmpty
        ? presence!.name
        : nodeid;
    _showPreflightCard(outcome, presence);
  }

  /// 阶段 watcher 启动：1 秒一拍（仅会话路由内运行；low 画质档 2 秒一拍）。
  void _startSessionWatcher(String nodeid) {
    _stopSessionWatcher();
    _sessionNodeid = nodeid;
    _sessionStage = SessionStage.iframeAttach;
    _sessionStageSince = DateTime.now();
    _sessionStartedAt = DateTime.now();
    _sessionConnecting = true;
    _sessionFailed = false;
    _sessionCardShowing = false;
    _sessionActive = false;
    _perfTracker.reset();
    unawaited(_sessionLog.log('session-start', nodeid: nodeid));
    _sessionTimer?.cancel();
    _sessionTimer = Timer.periodic(
      Duration(seconds: _perfTracker.probeIntervalSec),
      (_) => _sessionTick(),
    );
    _setKeepScreenOnForSession(true);
    // A8：弱网降质档位透传——会话建立时把画质档位写进顶层页面
    // `window.__qfSessionQuality`（参数名 quality，与网页端约定的
    // `quality=low` 同名；网页侧当前无 quality 处理，待接线后生效，
    // 当前 low 档真正生效的是 Dart 侧降采样，见 session_perf.dart）。
    unawaited(_applySessionQuality());
  }

  /// RC-04：为当前远程会话申领重连票据（会话建立成功 videoReady 时调）。
  /// 同一设备会话重建时复用同一 session_id（票据仍在效就不重领，过期则
  /// 滚动续领）；申领走控制台会话 cookie 桥（服务端自动选该设备最新在
  /// 用的 Key），失败只记日志、不挡会话。
  Future<void> _startReconnectSession() async {
    final nodeid = _sessionNodeid;
    if (nodeid == null || nodeid.isEmpty) return;
    final existing = _reconnectSession;
    if (existing != null && existing.deviceId == nodeid) {
      await existing.rollIfNeeded();
      return;
    }
    await _reconnectSession?.stop();
    // late final：onHandshakeRedo 闭包里要比对 manager 身份（世代守卫），
    // 须先声明再在构造参数里引用（构造完成时才赋值，闭包运行时已就绪）。
    late final ReconnectSession session;
    session = ReconnectSession(
      transport: HttpReconnectTransport(cookieHeader: _consoleCookieHeader),
      onAttempt: (statusText) {
        if (!mounted) return;
        setState(() {
          _reconnecting = true;
          _reconnectStatus = statusText;
        });
      },
      onHandshakeRedo: (_) async {
        // 恢复成功后重做“握手”等价动作：重走 preflight 全链路重建会话。
        // 世代守卫：中途用户已退出（manager 被换掉）则不再重建。
        if (!identical(_reconnectSession, session)) return;
        await _retrySession();
      },
      onQueryUnknownJobs: (_) async {
        // 本端暂无 LEA job 查询通道（#5 会话层接线后补）：恢复后只做
        // 状态重建，不重执行任何业务命令；不伪造一次查询。
      },
      onClearDiscardedInput: () {
        // 重连浮层盖住 WebView，输入已短路丢弃；本端无 Dart 侧输入
        // 队列可清（远程输入全在页面内）。
      },
      onRestored: () {
        if (!mounted) return;
        setState(() {
          _reconnecting = false;
          _reconnectFailure = null;
        });
        _snack('已恢复连接');
      },
      onCredentialFailure: (f) {
        if (!mounted) return;
        setState(() {
          _reconnecting = false;
          _reconnectFailure = f;
        });
      },
    );
    _reconnectSession = session;
    final ok = await session.start(deviceId: nodeid);
    debugPrint('QFRC04 start device=$nodeid ticket=$ok');
  }

  /// RC-04：停止票据会话（显式退出会话／退出登录时调；不放在
  /// _stopSessionWatcher 里——重试 preflight 也会走它，停掉就丢了
  /// 跨重试恢复用的同一张票据）。
  Future<void> _stopReconnectSession() async {
    final session = _reconnectSession;
    _reconnectSession = null;
    _reconnectFailure = null;
    if (mounted) setState(() => _reconnecting = false);
    await session?.stop();
  }

  /// RC-04：会话失败时先走票据重连（持有在效票据才跑）。
  /// 返回 true＝已处理（恢复成功／凭据失败已弹卡），不再弹通用失败卡；
  /// false＝无票据或网络耗尽，落回通用失败卡（手动重试入口）。
  Future<bool> _tryReconnectSession() async {
    final session = _reconnectSession;
    if (session == null || _reconnecting) return false;
    if (!await session.hasLiveTicket) return false;
    _reconnectFailure = null;
    final ok = await session.reconnect();
    if (!identical(_reconnectSession, session)) return true;
    if (ok) return true;
    if (_reconnectFailure != null) {
      unawaited(_showReconnectCredentialCard(_reconnectFailure!));
      return true;
    }
    return false;
  }

  /// RC-04：先试票据重连，不成就弹通用失败卡（手动重试入口）。
  Future<void> _runReconnectOrShowCard(String code, int elapsedSec) async {
    if (await _tryReconnectSession()) return;
    if (!mounted) return;
    await _showSessionFailureCard(code, elapsedSec);
  }

  /// RC-04 凭据类失败卡：失败原因＋“重新登录”入口（清干净后走服务端
  /// 登出地址回登录页，与菜单「退出账号」同路径）。
  Future<void> _showReconnectCredentialCard(ReconnectFailure failure) async {
    if (!mounted) return;
    final go = await showQfDialog<bool>(
      context: context,
      barrierDismissible: false,
      builder: (ctx) => AlertDialog(
        title: const Text('重连失败'),
        content: Text('${failure.displayText}\n\n请重新登录后再次连接。'),
        actions: [
          QfButtonTapTarget(
            child: TextButton(
              onPressed: () => Navigator.of(ctx).pop(false),
              child: const Text('返回设备列表'),
            ),
          ),
          QfButtonTapTarget(
            child: FilledButton(
              onPressed: () => Navigator.of(ctx).pop(true),
              child: const Text('重新登录'),
            ),
          ),
        ],
      ),
    );
    if (!mounted) return;
    if (go == true) {
      await _manualLogoutFromMenu();
    } else {
      _exitSessionToDevices();
    }
  }

  /// 把当前画质档位透传进会话页面（best-effort，失败不挡会话），
  /// 并按档位重建采样定时器（normal 1 秒 / low 2 秒）。
  Future<void> _applySessionQuality() async {
    final web = _web;
    final q = _perfTracker.quality == SessionQuality.low ? 'low' : 'normal';
    if (web != null) {
      try {
        await web
            .evaluateJavascript(
              source:
                  'window.__qfSessionQuality = '
                  '"$q"; "ok";',
            )
            .timeout(const Duration(seconds: 5));
      } catch (_) {
        // 透传失败不挡会话：low 档的 Dart 侧降采样照常生效
      }
    }
    if (_sessionConnecting) {
      _sessionTimer?.cancel();
      _sessionTimer = Timer.periodic(
        Duration(seconds: _perfTracker.probeIntervalSec),
        (_) => _sessionTick(),
      );
    }
    if (_sessionActive) _startPerfTimer();
  }

  /// video-ready 后的性能采样定时器（A8 HUD 用；间隔跟随画质档位）。
  void _startPerfTimer() {
    _perfTimer?.cancel();
    _perfTimer = Timer.periodic(
      Duration(seconds: _perfTracker.probeIntervalSec),
      (_) => _perfTick(),
    );
  }

  void _stopPerfTimer() {
    _perfTimer?.cancel();
    _perfTimer = null;
  }

  /// 会话进行态一拍性能采样：探针往返耗时＋rAF 帧数记进 tracker，
  /// HUD 与诊断据此刷新；求值 5 秒超时按本拍跳过。
  Future<void> _perfTick() async {
    if (!mounted || _web == null || !_sessionActive) return;
    final sw = Stopwatch()..start();
    try {
      final r = await _web!
          .evaluateJavascript(source: kSessionStateJs)
          .timeout(const Duration(seconds: 5));
      sw.stop();
      var s = r?.toString() ?? '';
      if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
        try {
          final decoded = jsonDecode(s);
          if (decoded is String) s = decoded;
        } catch (_) {}
      }
      final reading = SessionProbeReading.parse(s);
      _perfTracker.recordProbe(
        rttMs: sw.elapsedMilliseconds,
        fps: reading?.fps,
      );
      if (mounted) setState(() {});
    } catch (_) {
      // 本拍跳过，下一拍继续
    }
  }

  void _stopSessionWatcher() {
    // 第 2 轮 #5：会话层结束（录像 end、待 ACK 补发、停探针循环；
    // 幂等，未开始时为空操作；_startSessionWatcher 开头也调本方法，
    // 正好先结束上一会话层）。
    unawaited(_sessionLayer.endSession());
    _sessionTimer?.cancel();
    _sessionTimer = null;
    _stopPerfTimer();
    _sessionConnecting = false;
    _sessionActive = false;
  }

  /// 退出会话清理：恢复缩放、清常亮（B9/A8）。
  void _exitSessionCleanup() {
    _sessionActive = false;
    _stopPerfTimer();
    _sessionFailed = false;
    _sessionCardShowing = false;
    _clearKeepScreenOn();
    _applySessionZoom(false);
  }

  /// 阶段 watcher 一拍：探针读数 → 阶段推进；阶段超时/总超时 → 失败卡。
  Future<void> _sessionTick() async {
    if (!mounted || _web == null || !_sessionConnecting) return;
    final now = DateTime.now();
    final totalElapsed = _sessionStartedAt == null
        ? 0
        : now.difference(_sessionStartedAt!).inSeconds;
    if (totalElapsed > kSessionTotalTimeoutSec) {
      _failSession(_sessionStage, codeOverride: 'TIMEOUT_SESSION');
      return;
    }
    SessionProbeReading? reading;
    // A8：记探针往返耗时（Dart→页面求值一来一回）与 rAF 帧数进 HUD。
    final probeSw = Stopwatch()..start();
    try {
      final r = await _web!
          .evaluateJavascript(source: kSessionStateJs)
          .timeout(const Duration(seconds: 5));
      probeSw.stop();
      var s = r?.toString() ?? '';
      if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
        try {
          final decoded = jsonDecode(s);
          if (decoded is String) s = decoded;
        } catch (_) {}
      }
      reading = SessionProbeReading.parse(s);
      _perfTracker.recordProbe(
        rttMs: probeSw.elapsedMilliseconds,
        fps: reading?.fps,
      );
    } catch (_) {
      reading = null;
    }
    if (reading != null && mounted && _sessionConnecting) {
      _onSessionStageReached(mapSessionProbe(reading));
    }
    if (!_sessionConnecting) return;
    final since = _sessionStageSince;
    if (since != null) {
      final stageElapsed = now.difference(since).inSeconds;
      final limit = kSessionStageTimeouts[_sessionStage] ?? 20;
      if (stageElapsed > limit) {
        _failSession(_sessionStage);
      }
    }
  }

  /// 阶段推进（只前进不后退；handler 打点与探针兜底共用）。
  void _onSessionStageReached(SessionStage stage, {bool viaHandler = false}) {
    if (!_sessionConnecting || _sessionFailed) return;
    if (_stageIndex(stage) < _stageIndex(_sessionStage)) return;
    final isNew = _stageIndex(stage) > _stageIndex(_sessionStage);
    if (isNew) {
      _sessionStage = stage;
      _sessionStageSince = DateTime.now();
      final elapsedMs = _sessionStartedAt == null
          ? 0
          : DateTime.now().difference(_sessionStartedAt!).inMilliseconds;
      unawaited(
        _sessionLog.log(
          sessionStageLogName(stage),
          nodeid: _sessionNodeid ?? '',
          extra: 'elapsedMs=$elapsedMs via=${viaHandler ? 'handler' : 'probe'}',
        ),
      );
      if (stage == SessionStage.videoReady) {
        _sessionConnecting = false;
        _sessionTimer?.cancel();
        _sessionTimer = null;
        // A8：出画面即进入会话进行态，HUD 可见，开始性能采样。
        _sessionActive = true;
        _startPerfTimer();
        // 第 2 轮 #5：会话层开始——IDR join、录像 start、画质探针循环
        // （任一步失败都不挡会话本身，只记诊断日志）。
        unawaited(
          _sessionLayer.beginSession(
            nodeId: _sessionNodeid ?? '',
            deviceName: _sessionDeviceName ?? '',
            lowQuality: _perfTracker.quality == SessionQuality.low,
          ),
        );
        final secs = (elapsedMs / 1000).toStringAsFixed(1);
        _lastSessionSummary =
            '${_sessionDeviceName ?? _sessionNodeid ?? '设备'} · video-ready · $secs秒 · 成功';
        if (mounted) setState(() {});
        // A8：会话进行态关闭双指缩放（远程桌面自带缩放，避免手势抢占）。
        _applySessionZoom(true);
        _setKeepScreenOnForSession(true);
        // RC-04：会话建立成功后立即申领重连票据（存内存，滚动续领）。
        unawaited(_startReconnectSession());
      }
    }
  }

  /// 会话失败：记日志＋失败卡（TIMEOUT 加阶段名＋设备名＋耗时＋三按钮）。
  void _failSession(
    SessionStage stage, {
    bool viaWatchdog = false,
    String? codeOverride,
  }) {
    if (_sessionFailed) return;
    _sessionFailed = true;
    _lastSessionFailed = true;
    _sessionConnecting = false;
    _sessionActive = false;
    _stopPerfTimer();
    _sessionTimer?.cancel();
    _sessionTimer = null;
    final code = codeOverride ?? sessionTimeoutCode(stage);
    final elapsedSec = _sessionStartedAt == null
        ? 0
        : DateTime.now().difference(_sessionStartedAt!).inSeconds;
    _lastSessionSummary =
        '${_sessionDeviceName ?? _sessionNodeid ?? '设备'} · $code · $elapsedSec秒 · 失败';
    unawaited(
      _sessionLog.log(
        'timeout-stage',
        nodeid: _sessionNodeid ?? '',
        extra:
            'code=$code stage=${sessionStageLogName(stage)} '
            'elapsedSec=$elapsedSec via=${viaWatchdog ? 'watchdog' : 'watcher'}',
      ),
    );
    _clearKeepScreenOn();
    if (mounted) setState(() {});
    // RC-04：持有在效票据时先走票据重连（5 次／5 秒固定间隔＋取消按钮），
    // 恢复成功或凭据失败都不再弹通用失败卡；网络耗尽才落回失败卡。
    unawaited(_runReconnectOrShowCard(code, elapsedSec));
  }

  /// 原生会话失败卡（A1/A3）：错误码＋设备名＋耗时＋三个按钮
  /// （重试会话／一键修复／返回设备列表）＋复制诊断。
  Future<void> _showSessionFailureCard(String code, int elapsedSec) async {
    if (!mounted || _sessionCardShowing) return;
    _sessionCardShowing = true;
    final device = _sessionDeviceName ?? _sessionNodeid ?? '设备';
    final result = await showQfDialog<String>(
      context: context,
      barrierDismissible: false,
      builder: (ctx) => AlertDialog(
        title: const Text('会话建立失败'),
        content: Text(
          '设备：$device\n错误码：$code\n已耗时：$elapsedSec 秒\n\n请重试会话，或用一键修复检查被控端状态。',
        ),
        actions: [
          QfButtonTapTarget(
            child: TextButton(
              onPressed: () async {
                final diag = await _diagnosticsTextFull();
                if (!ctx.mounted) return;
                await Clipboard.setData(ClipboardData(text: diag));
                if (ctx.mounted) Navigator.of(ctx).pop('copied');
              },
              child: const Text('复制诊断'),
            ),
          ),
          QfButtonTapTarget(
            child: TextButton(
              onPressed: () => Navigator.of(ctx).pop('exit'),
              child: const Text('返回设备列表'),
            ),
          ),
          QfButtonTapTarget(
            child: TextButton(
              onPressed: () => Navigator.of(ctx).pop('repair'),
              child: const Text('一键修复'),
            ),
          ),
          QfButtonTapTarget(
            child: FilledButton(
              onPressed: () => Navigator.of(ctx).pop('retry'),
              child: const Text('重试会话'),
            ),
          ),
        ],
      ),
    );
    _sessionCardShowing = false;
    if (!mounted) return;
    switch (result) {
      case 'retry':
        await _retrySession();
      case 'repair':
        await _showRepairGuidance();
      case 'exit':
        _exitSessionToDevices();
      case 'copied':
        _snack('诊断信息已复制。');
        // 复制后仍留在失败态：重新弹卡（不丢重试入口）。
        _showSessionFailureCard(code, elapsedSec);
      default:
        break;
    }
  }

  /// 重试会话：重新走 preflight → iframe-attach 全链路（A4：不是只
  /// 刷新顶层页）。
  Future<void> _retrySession() async {
    final nodeid = _sessionNodeid;
    if (nodeid == null) return;
    _sessionFailed = false;
    _lastSessionFailed = false;
    _preflightFor = null;
    await _runPreflight(nodeid);
    if (mounted && _sessionConnecting) {
      await _web?.reload();
    }
  }

  /// 退出会话回设备列表（失败卡/返回键共用）。
  void _exitSessionToDevices() {
    _stopSessionWatcher();
    _exitSessionCleanup();
    // RC-04：显式退出会话即作废票据（退出≠断线，不保留恢复）。
    unawaited(_stopReconnectSession());
    _web?.loadUrl(urlRequest: URLRequest(url: WebUri(_startUrl)));
    _activateSlot(AppSlot.devices);
  }

  /// 预检失败卡（A9 三级分级，8 秒内出卡，不进「正在建立会话…」）。
  Future<void> _showPreflightCard(
    PreflightOutcome outcome,
    DevicePresence? presence,
  ) async {
    if (!mounted) return;
    final text = preflightCardText(outcome, presence);
    final nodeid = _sessionNodeid ?? presence?.nodeid ?? '';
    final result = await showQfDialog<String>(
      context: context,
      barrierDismissible: false,
      builder: (ctx) => AlertDialog(
        title: Text(text.title),
        content: Text(text.body),
        actions: [
          if (outcome == PreflightOutcome.preflightTimeout)
            QfButtonTapTarget(
              child: TextButton(
                onPressed: () => Navigator.of(ctx).pop('force'),
                child: const Text('仍要尝试连接'),
              ),
            ),
          QfButtonTapTarget(
            child: TextButton(
              onPressed: () => Navigator.of(ctx).pop('exit'),
              child: const Text('返回设备列表'),
            ),
          ),
          QfButtonTapTarget(
            child: TextButton(
              onPressed: () => Navigator.of(ctx).pop('repair'),
              child: const Text('一键修复'),
            ),
          ),
          QfButtonTapTarget(
            child: FilledButton(
              onPressed: () => Navigator.of(ctx).pop('retry'),
              child: const Text('重试预检'),
            ),
          ),
        ],
      ),
    );
    if (!mounted) return;
    switch (result) {
      case 'retry':
        _preflightFor = null;
        if (nodeid.isNotEmpty) await _runPreflight(nodeid);
      case 'repair':
        await _showRepairGuidance();
      case 'force':
        // 二次确认后才挂 iframe，本次标记为 preflight-skipped 写进日志。
        unawaited(_sessionLog.log('preflight-skipped', nodeid: nodeid));
        if (nodeid.isNotEmpty) _startSessionWatcher(nodeid);
      case 'exit':
        _exitSessionToDevices();
      default:
        break;
    }
  }

  /// 一键修复（协调人定案 5）：手机上跑不了 qf-agent-heal.ps1，点了没
  /// 反应的按钮就是假按钮——改为调服务端预检＋给出笔记本侧修复指引
  /// （重启 Mesh Agent 服务的文字步骤），修好后可直接重试预检。
  Future<void> _showRepairGuidance() async {
    if (!mounted) return;
    final device = _sessionDeviceName ?? _sessionNodeid ?? '该设备';
    final result = await showQfDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('一键修复'),
        content: Text(
          '正在为 $device 检查被控端状态。\n\n'
          '请在笔记本上操作：\n'
          '1. 按 Win+R，输入 services.msc 回车；\n'
          '2. 找到 Mesh Agent 服务，右键「重新启动」；\n'
          '3. 等 10 秒后，回到手机点「重新预检」。\n\n'
          '若服务不在列表里，说明 agent 未安装或已被卸载，'
          '需重新安装被控端。',
        ),
        actions: [
          QfButtonTapTarget(
            child: TextButton(
              onPressed: () => Navigator.of(ctx).pop('close'),
              child: const Text('知道了'),
            ),
          ),
          QfButtonTapTarget(
            child: FilledButton(
              onPressed: () => Navigator.of(ctx).pop('recheck'),
              child: const Text('重新预检'),
            ),
          ),
        ],
      ),
    );
    if (result == 'recheck' && mounted) {
      final nodeid = _sessionNodeid;
      if (nodeid != null) {
        _preflightFor = null;
        await _runPreflight(nodeid);
      }
    }
  }

  /// 屏幕常亮（B9）：进入会话路由或 Sess.state==connected 时开，
  /// 退出会话/切后台时清；设置页开关默认开。
  /// A-02：会话进行态同时起类型明确的前台服务（QfSessionService，
  /// specialUse），会话结束即停——后台分级第三档。
  Future<void> _setKeepScreenOnForSession(bool on) async {
    if (!on) {
      _clearKeepScreenOn();
      return;
    }
    if (!(_settings?.keepScreenOn ?? true)) return;
    _keepScreenOnActive = true;
    await NativeChannels.setKeepScreenOn(true);
    // A-03 接线（R1）：会话启动时申请通知权限（前台服务通知用）。
    // 不 await：权限弹窗是用户交互，前台服务须立即起（后台保活不等弹窗），
    // 流程内部 fail-open，任何一步失败都不挡会话。
    unawaited(_ensureSessionNotificationPermission());
    // A-01：会话起前台服务走分级控制器（第三档）；控制器未建时回退
    // 到原来的直接调用，行为不变。
    final bgTier = _bgTier;
    if (bgTier != null) {
      unawaited(bgTier.onSessionStarted('正在远程会话'));
    } else {
      unawaited(QfBridge.startSessionForeground('正在远程会话'));
    }
  }

  void _clearKeepScreenOn() {
    if (!_keepScreenOnActive) return;
    _keepScreenOnActive = false;
    unawaited(NativeChannels.setKeepScreenOn(false));
    // A-01：会话结束停前台服务、降级回周期同步（第二档）；控制器未建
    // 时回退到原来的直接调用，行为不变。
    final bgTier = _bgTier;
    if (bgTier != null) {
      unawaited(bgTier.onSessionEnded());
    } else {
      unawaited(QfBridge.stopSessionForeground());
    }
  }

  /// A-03 接线（R1）：会话启动时确保通知权限（POST_NOTIFICATIONS，
  /// Android 13+ 前台服务通知用）。只在进入会话时调一次提示逻辑
  /// （NotificationPermissionFlow 内记 _prompted），会话中重复进入
  /// （videoReady 再调 _setKeepScreenOnForSession）不重复打扰。
  /// 失败不挡会话：桥接缺失、弹窗异常一律静默跳过。
  Future<void> _ensureSessionNotificationPermission() async {
    if (!mounted) return;
    try {
      await _notificationPermissionFlow.ensure(
        showRationale: () async {
          if (!mounted) return false;
          final go = await showQfDialog<bool>(
            context: context,
            builder: (ctx) => AlertDialog(
              title: const Text('通知权限'),
              content: const Text(
                '开启通知后，会话进行时能在通知栏看到「正在远程会话」，'
                '被控端上线、离线也能及时提醒。',
              ),
              actions: [
                QfButtonTapTarget(
                  child: TextButton(
                    onPressed: () => Navigator.of(ctx).pop(false),
                    child: const Text('暂不开启'),
                  ),
                ),
                QfButtonTapTarget(
                  child: FilledButton(
                    onPressed: () => Navigator.of(ctx).pop(true),
                    child: const Text('去开启'),
                  ),
                ),
              ],
            ),
          );
          return go ?? false;
        },
        showSettingsPath: (settingsText) async {
          if (!mounted) return false;
          final go = await showQfDialog<bool>(
            context: context,
            builder: (ctx) => AlertDialog(
              title: const Text('通知已关闭'),
              content: Text(settingsText),
              actions: [
                QfButtonTapTarget(
                  child: TextButton(
                    onPressed: () => Navigator.of(ctx).pop(false),
                    child: const Text('知道了'),
                  ),
                ),
                QfButtonTapTarget(
                  child: FilledButton(
                    onPressed: () => Navigator.of(ctx).pop(true),
                    child: const Text('去设置'),
                  ),
                ),
              ],
            ),
          );
          return go ?? false;
        },
        openSettings: () async {
          await QfBridge.openAppSettings();
        },
      );
    } catch (_) {
      // 权限流程任何异常都不挡会话。
    }
  }

  /// 会话进行态缩放开关（A8）：会话中关双指缩放（远程桌面自带缩放），
  /// 退出会话恢复。setSettings 需给全量设置（6.x 会整体替换）。
  /// S-027：全量替换必须带 useOnRenderProcessGone: true，否则会话一开
  /// 就悄悄退订渲染进程死亡回调；第三方 Cookie 同控制台槽口径。
  Future<void> _applySessionZoom(bool sessionActive) async {
    final web = _web;
    if (web == null) return;
    try {
      await web.setSettings(
        settings: InAppWebViewSettings(
          javaScriptEnabled: true,
          domStorageEnabled: true,
          databaseEnabled: true,
          cacheEnabled: true,
          thirdPartyCookiesEnabled:
              WebViewCookiePolicy.thirdPartyCookiesEnabled(AppSlot.devices),
          useOnRenderProcessGone: true,
          supportZoom: !sessionActive,
          builtInZoomControls: !sessionActive,
          displayZoomControls: false,
          useShouldOverrideUrlLoading: true,
          mediaPlaybackRequiresUserGesture: true,
          allowsInlineMediaPlayback: true,
          iframeAllow: 'fullscreen',
          applicationNameForUserAgent: 'QFRemote',
          supportMultipleWindows: true,
        ),
      );
    } catch (_) {
      // 机型/插件不支持时安静跳过，不挡会话
    }
  }

  // ---------------- 下载/安装 ----------------

  Future<Directory> _updatesDir() async {
    final base =
        await getExternalStorageDirectory() ?? await getTemporaryDirectory();
    return Directory('${base.path}/updates');
  }

  Future<File> _downloadApk(
    ReleaseEntry entry,
    void Function(int, int?, int?) onProgress,
  ) async {
    final dir = await _updatesDir();
    // DC-C 新发现（空间预检）：通用下载流有 B23 剩余空间检查，更新流此前
    // 没有。APK 约 144MB，空间不足时下载中途写满才失败、又被报成“网络不
    // 稳定”，用户反复重试也下不完。下载前按剩余待下字节（清单 size 减去
    // 可续传 .part 已收部分，未过期且不超 size 才算）核对一次空间，不足
    // 即中文明示、不启动下载。取不到空间值或预检本身异常时不拦截（保守
    // 放行，下载流的校验与 ENOSPC 明示兜底）。
    try {
      final part = File('${dir.path}/${UpdateService.partFileName(entry)}');
      var resumed = 0;
      if (await part.exists()) {
        final stat = await part.stat();
        if (!UpdateService.isPartExpired(stat.modified)) {
          final len = await part.length();
          if (len <= entry.size) resumed = len;
        }
      }
      final freeBytes = await NativeChannels.getFreeSpaceBytes(dir.path);
      if (freeBytes != null && freeBytes < entry.size - resumed) {
        final needMb = ((entry.size - resumed) / 1048576).toStringAsFixed(1);
        final freeMb = (freeBytes / 1048576).toStringAsFixed(1);
        throw FormatException(
          '设备剩余空间不足（剩余约 $freeMb MB，更新包还需约 $needMb MB），请清理空间后重新下载。',
        );
      }
    } on FormatException {
      rethrow;
    } catch (_) {
      // 预检本身失败不挡下载。
    }
    return _updateService.downloadApk(entry, dir, onProgress);
  }

  Future<void> _openInstaller(File file) async {
    final result = await OpenFilex.open(file.path);
    if (result.type != ResultType.done && mounted) {
      // B18：安装器失败先查未知应用安装开关——被关时弹带「去设置开启」
      // 的引导，不再只报文件路径让用户自己找。
      final canInstall = await NativeChannels.canInstallUnknown();
      if (canInstall == false && mounted) {
        final go = await showQfDialog<bool>(
          context: context,
          builder: (ctx) => AlertDialog(
            title: const Text('需要允许安装未知应用'),
            content: const Text('QFRemote 需要「允许安装未知应用」权限才能安装更新，请在系统设置里开启。'),
            actions: [
              QfButtonTapTarget(
                child: TextButton(
                  onPressed: () => Navigator.of(ctx).pop(false),
                  child: const Text('取消'),
                ),
              ),
              QfButtonTapTarget(
                child: FilledButton(
                  onPressed: () => Navigator.of(ctx).pop(true),
                  child: const Text('去设置开启'),
                ),
              ),
            ],
          ),
        );
        if (go == true) {
          await NativeChannels.openUnknownAppSourcesSettings();
        }
        return;
      }
      _snack('安装包打开失败（${result.message}），文件位于：${file.path}');
    }
  }

  // ---------------- WebView 事件 ----------------

  /// S-027 渲染进程死亡处理（R-03/R-05/R-08/R-09/R-10）。
  ///
  /// 固定顺序：记诊断事件 → 停该槽定时器与看护 → 控制器字段置 null →
  /// setState 递增代次换 Key 重建新实例。禁令：绝不对旧 controller 调
  /// reload()/loadUrl()/evaluateJavascript()；绝不复用旧 controller。
  void _onRendererGone(AppSlot slot, RenderProcessGoneDetail detail) {
    final isForeground = _slot == slot;
    final decision = _rendererRecovery.noteGone(
      slot,
      didCrash: detail.didCrash,
      isForeground: isForeground,
      priorityAtExit: detail.rendererPriorityAtExit?.toString(),
    );
    debugPrint(
      _rendererRecovery.describe(
        slot,
        url: _currentUrl,
        loginState: _chromeVisible ? 'logged-in' : 'logged-out',
      ),
    );
    switch (decision) {
      case RendererGoneDecision.ignoreDuplicate:
        return;
      case RendererGoneDecision.rebuildDeferred:
        // R-08：后台槽只记“需恢复”标记，切回前台时再建（见 _activateSlot）。
        if (mounted) setState(() {});
        return;
      case RendererGoneDecision.giveUp:
        // R-05：本轮重建已达上限（3 次），停手，进离线卡＋手动重试。
        _slotLifecycle.markDisposed(slot);
        _enterOffline();
        return;
      case RendererGoneDecision.rebuildNow:
        break;
    }
    // R-10：didCrash=false＝系统因内存不足杀渲染进程：先释放后台槽
    // 再重建前台槽，避免刚重建又被杀。
    if (!detail.didCrash) _releaseBackgroundSlotsForMemory(except: slot);
    // R-03：先停表再重建——旧拍继续对着死控制器求值只会静默失败。
    if (slot == AppSlot.devices) {
      _watchdog?.stop();
      _watchdog = null;
      _loginTimer?.cancel();
      _loginTimer = null;
      _loginLoopStarter?.cancel();
      _loginLoopStarter = null;
      _sessionTimer?.cancel();
      _sessionTimer = null;
      _perfTimer?.cancel();
      _perfTimer = null;
      _evaluator.controller = null;
    }
    _setSlotController(slot, null);
    if (mounted) setState(() {});
    // 新实例挂载后 onWebViewCreated 会重注册 handler／重启看护与登录循环
    // （控制台槽），再走既有 AutoLoginController 恢复链（R-04），
    // 不重复提交登录、不绕过手动退出／凭据拦截两道闸。
  }

  /// 渲染进程自行恢复信号（R-01）：只记日志＋触发一次看护复核画布，
  /// 不默认“会话已好”。
  void _onRendererResponsive(AppSlot slot, WebUri? url) {
    debugPrint('QFRenderer responsive slot=${slot.name} url=${url.toString()}');
    if (slot == AppSlot.devices)
      unawaited(_watchdog?.tickNow() ?? Future<void>.value());
  }

  /// 给槽位换控制器（重建时置 null，onWebViewCreated 时回填新实例）。
  void _setSlotController(AppSlot slot, InAppWebViewController? controller) {
    switch (slot) {
      case AppSlot.home:
        _homeWeb = controller;
      case AppSlot.files:
        _filesWeb = controller;
      case AppSlot.devices:
        _web = controller;
      case AppSlot.friends:
        _friendsWeb = controller;
      case AppSlot.forum:
        _forumWeb = controller;
      case AppSlot.me:
        break;
    }
  }

  /// 取槽位当前控制器（释放／守卫用）。
  InAppWebViewController? _slotController(AppSlot slot) {
    switch (slot) {
      case AppSlot.home:
        return _homeWeb;
      case AppSlot.files:
        return _filesWeb;
      case AppSlot.devices:
        return _web;
      case AppSlot.friends:
        return _friendsWeb;
      case AppSlot.forum:
        return _forumWeb;
      case AppSlot.me:
        return null;
    }
  }

  /// 释放单个槽的渲染进程（S-032/S-043 COLD 态）：控制器 load
  /// about:blank（只保留 URL，不保留渲染进程），并使该槽重载失效，
  /// 下次切入时按需重载。控制台槽登录／会话态不走这里（最低 WARM）。
  Future<void> _releaseSlotRenderer(AppSlot slot) async {
    final c = _slotController(slot);
    if (c == null) return;
    try {
      await c.loadUrl(urlRequest: URLRequest(url: WebUri('about:blank')));
    } catch (_) {
      // 控制器已死：下次切入时重建即覆盖
    }
    _slotLoads.invalidate(slot);
  }

  /// R-10：内存压力下先释放全部后台槽（除 [except] 与登录态控制台槽），
  /// 再重建前台槽。
  void _releaseBackgroundSlotsForMemory({required AppSlot except}) {
    for (final s in SlotLifecycleManager.webSlots) {
      if (s == except) continue;
      // 控制台槽登录态最低 WARM：保留渲染进程，只停探针（由 R-07 守卫）。
      if (s == AppSlot.devices && _chromeVisible) continue;
      unawaited(_releaseSlotRenderer(s));
    }
  }

  void _startWatchdog() {
    _watchdog?.stop();
    _watchdog = WatchdogCore(
      evaluator: _evaluator,
      enabled: () =>
          mounted &&
          _gateDone &&
          !_offline &&
          _forceEntry == null &&
          _foreground,
      onStatus: (s) {
        if (mounted) setState(() {});
        debugPrint('QFWATCHDOG status=$s');
      },
      onReconnectClick: () {
        _settings?.incWatchdogReconnects();
        debugPrint('QFWATCHDOG clicked');
      },
      // A1/B10：看护判定 connecting-stuck（「正在建立会话…」持续 25 秒
      // 无画布）→ 原生会话失败卡（TIMEOUT_PEER_CONNECTING）。
      onConnectingStuck: () {
        if (_sessionConnecting && !_sessionFailed) {
          _failSession(SessionStage.peerConnecting, viaWatchdog: true);
        }
      },
      // S-042：渲染宽限期（默认 12 秒）到期仍无画面——提示“连接已建立，
      // 画面尚未就绪”＋“重新连接”动作（用户点即重载控制台走恢复链），
      // 并立即再探一拍复核，不静默等下一个 4 秒拍。
      onRenderNotReady: () {
        if (!mounted) return;
        _snack(
          '连接已建立，画面尚未就绪，正在重新协商…',
          action: SnackBarAction(
            label: '重新连接',
            onPressed: () => unawaited(_web?.reload()),
          ),
        );
        unawaited(_watchdog?.tickNow() ?? Future<void>.value());
      },
      log: (m) => debugPrint('QFWATCHDOG $m'),
    )..start();
  }

  Future<void> _onPageLoaded() async {
    // S-027/R-05：控制台槽新实例加载完成，恢复耗时落定。
    _rendererRecovery.noteLoadStopped(AppSlot.devices);
    // B1：首屏加载成功即取消冷启动看门狗；B6：快照恢复的 reload 回来后
    // 才开始 6 秒等待计时。
    _bootLoadWatchdog?.cancel();
    _bootLoadWatchdog = null;
    if (_awaitingRestoreLoad) {
      _awaitingRestoreLoad = false;
      _stepWaitUntil = DateTime.now().add(const Duration(seconds: 6));
    }
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
    // P0-2：主控制台 WebView 每页加载完成都推一次壳主题（朋友/论坛槽由
    // _injectShellChrome、首页/文件槽由 _pushThemeOnLoadStop 覆盖）；
    // 主题切换时由 _themeMode setter 另推全部槽。
    final mainWeb = _web;
    if (mainWeb != null) unawaited(_pushThemeToWebView(mainWeb));
  }

  void _enterOffline() {
    if (_offline || _forceEntry != null) return;
    _offline = true;
    // 恢复盖子先放下，让断线卡片露出来；网络恢复、页面重载成功后恢复链会接着跑
    _recoveryCover = false;
    _splashVisible = false;
    _settings?.incOfflineCount();
    _offlineIdx = 0;
    _offlineAttempts = 0;
    _offlineRetryStopped = false;
    _scheduleOfflineRetry();
    _runProbe();
    if (mounted) setState(() {});
  }

  void _scheduleOfflineRetry() {
    _offlineTimer?.cancel();
    // B11：自动重试总次数上限 10 次（约 5 分钟），超限后停在离线卡片
    // 并改文案为「已停止自动重试」，保留手动重试按钮。
    if (_offlineAttempts >= 10) {
      _offlineRetryStopped = true;
      if (mounted) setState(() {});
      return;
    }
    final secs =
        _offlineBackoff[_offlineIdx.clamp(0, _offlineBackoff.length - 1)];
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
        _offlineAttempts++;
        // 重载前先探活（B11）：探活不通则跳过本次重载，省一次完整页面加载。
        unawaited(
          _runProbe().then((r) {
            if (!mounted || !_offline) return;
            if (r.ok) _web?.reload();
            _scheduleOfflineRetry();
          }),
        );
      }
      setState(() {});
    });
  }

  void _exitOffline() {
    _offlineTimer?.cancel();
    _offline = false;
    _offlineIdx = 0;
    _offlineAttempts = 0;
    _offlineRetryStopped = false;
    // B16：网络恢复后立即重跑弱网放行时欠下的更新门复核。
    unawaited(_maybeRecheckGate());
    if (mounted) setState(() {});
  }

  /// 控制台页面里点到的文件下载：带上 WebView 的会话 Cookie 去下，
  /// 存到本应用的下载目录（与 Windows 版下载行为对齐）。
  /// 2.4.5 B23：下载前读 Content-Length，超过 500MB 或剩余空间不足
  /// 时先弹确认；下载中显示进度＋取消按钮（取消即关连接＋删文件）；
  /// 文件名限 100 字符。
  Future<void> _handlePageDownload(DownloadStartRequest req) async {
    HttpClient? client;
    var cancelled = false;
    File? targetFile;
    // 进度态：由对话框内的 StatefulBuilder 经 setState 刷新。
    var received = 0;
    var total = -1;
    void Function()? refreshProgress;
    // 进度对话框开关（声明在 try 之外：catch 里也要能关掉它）。
    var dialogOpen = false;
    void closeProgressDialog() {
      if (dialogOpen && mounted) {
        dialogOpen = false;
        Navigator.of(context, rootNavigator: true).pop();
      }
    }

    try {
      final cookies = await CookieManager.instance().getCookies(url: req.url);
      // 证书校验端口跟随下载地址本身（各服务面同为自家域名源；此前写死
      // 控制台端口，从好友/聊天页发起的下载会被证书校验拒掉）
      client = trustedHttpClient(
        connectionTimeout: const Duration(seconds: 20),
        port: req.url.port,
      );
      final request = await client.getUrl(Uri.parse(req.url.toString()));
      applyClientVersionHeader(request);
      if (cookies.isNotEmpty) {
        request.headers.set(
          HttpHeaders.cookieHeader,
          cookies.map((c) => '${c.name}=${c.value}').join('; '),
        );
      }
      // 响应头超时 20 秒：服务器接受连接却不回话时不许无声挂死（H-5）。
      final res = await request.close().timeout(const Duration(seconds: 20));
      if (res.statusCode < 200 || res.statusCode >= 300) {
        throw const FormatException('下载失败，服务器返回异常状态，请稍后重试。');
      }
      total = res.contentLength;
      const maxDownloadBytes = 500 * 1024 * 1024;
      // B23 返修：下载前检查剩余空间（StatFs 经 qfremote/storage 通道；
      // 取不到时保守处理——不拦截下载但记日志，不谎报空间充足）。
      // 剩余空间 < 文件大小（Content-Length，未知大小时按 500MB 阈值）
      // 时先弹确认，文案含剩余空间与文件大小，用户确认后才下。
      // 复用既有 >500MB 确认弹框样式（同一弹框、同一按钮）。
      final base =
          await getExternalStorageDirectory() ?? await getTemporaryDirectory();
      final dir = Directory('${base.path}/downloads');
      await dir.create(recursive: true);
      final freeBytes = await NativeChannels.getFreeSpaceBytes(dir.path);
      if (freeBytes == null) {
        debugPrint('QF page download: free space unknown, proceed anyway');
      }
      final requiredBytes = total > 0 ? total : maxDownloadBytes;
      final lowSpace = freeBytes != null && freeBytes < requiredBytes;
      String fmtMb(int bytes) =>
          '${(bytes / 1024 / 1024).toStringAsFixed(1)}MB';
      if (total > maxDownloadBytes || lowSpace) {
        final sizeText = total > 0
            ? '该文件约 ${fmtMb(total)}'
            : '该文件大小未知（按 500MB 估算）';
        final spaceText = freeBytes == null
            ? '剩余空间未知'
            : '设备剩余空间约 ${fmtMb(freeBytes)}';
        final ok = mounted
            ? await showQfDialog<bool>(
                context: context,
                builder: (ctx) => AlertDialog(
                  title: const Text('下载大文件'),
                  content: Text(
                    '$sizeText，$spaceText${lowSpace ? '，剩余空间不足以放下该文件' : '，超过 500MB'}，确定要下载吗？',
                  ),
                  actions: [
                    QfButtonTapTarget(
                      child: TextButton(
                        onPressed: () => Navigator.of(ctx).pop(false),
                        child: const Text('取消'),
                      ),
                    ),
                    QfButtonTapTarget(
                      child: FilledButton(
                        onPressed: () => Navigator.of(ctx).pop(true),
                        child: const Text('继续下载'),
                      ),
                    ),
                  ],
                ),
              )
            : false;
        if (ok != true) return;
      }
      var name = (req.suggestedFilename ?? '').trim();
      if (name.isEmpty) {
        final seg = Uri.parse(req.url.toString()).pathSegments;
        name = seg.isNotEmpty ? seg.last : 'download.bin';
      }
      name = name.replaceAll(RegExp(r'[^\w.\- ]'), '_');
      if (name.isEmpty || name == '.' || name == '..') name = 'download.bin';
      if (name.length > 100) name = name.substring(0, 100);
      final file = File('${dir.path}/$name');
      targetFile = file;
      final sink = file.openWrite();
      // 进度对话框：进度条＋取消（取消即关连接＋删半截文件）。
      if (mounted) {
        dialogOpen = true;
        unawaited(
          showQfDialog<void>(
            context: context,
            barrierDismissible: false,
            builder: (ctx) => StatefulBuilder(
              builder: (ctx2, setDialogState) {
                refreshProgress = () {
                  if (dialogOpen) setDialogState(() {});
                };
                final pct = total > 0
                    ? (received / total).clamp(0.0, 1.0)
                    : null;
                return AlertDialog(
                  title: Text('正在下载 $name'),
                  content: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      LinearProgressIndicator(value: pct),
                      const SizedBox(height: 10),
                      Text(
                        total > 0
                            ? '已下载 ${(received / 1024).toStringAsFixed(0)}KB / ${(total / 1024).toStringAsFixed(0)}KB'
                            : '已下载 ${(received / 1024).toStringAsFixed(0)}KB',
                      ),
                    ],
                  ),
                  actions: [
                    QfButtonTapTarget(
                      child: TextButton(
                        onPressed: () {
                          cancelled = true;
                          dialogOpen = false;
                          client?.close(force: true);
                          Navigator.of(ctx2).pop();
                        },
                        child: const Text('取消下载'),
                      ),
                    ),
                  ],
                );
              },
            ),
          ).then((_) => dialogOpen = false),
        );
      }
      try {
        // 正文无数据超时 30 秒（不设总时限，大文件慢速不断）：连续 30 秒
        // 没有任何新数据才判卡死（H-5）。
        await for (final chunk in res.timeout(const Duration(seconds: 30))) {
          if (cancelled) break;
          received += chunk.length;
          sink.add(chunk);
          refreshProgress?.call();
        }
      } finally {
        await sink.close();
      }
      closeProgressDialog();
      if (cancelled) {
        try {
          if (await file.exists()) await file.delete();
        } catch (_) {}
        if (mounted) _snack('已取消下载。');
        return;
      }
      if (mounted) {
        _snack(
          '已下载：$name',
          action: SnackBarAction(
            label: '打开',
            onPressed: () => OpenFilex.open(file.path),
          ),
        );
      }
    } catch (e) {
      closeProgressDialog();
      if (cancelled) return;
      // 异常原文只进日志，用户面统一中文映射（H-5/VM-03 口径）。
      debugPrint('QF page download failed: $e');
      try {
        if (targetFile != null && await targetFile.exists()) {
          await targetFile.delete();
        }
      } catch (_) {}
      if (mounted) _snack(pageDownloadFailureText(e));
    } finally {
      client?.close(force: true);
    }
  }

  void _snack(String msg, {SnackBarAction? action}) {
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(msg),
        action: action,
        backgroundColor: _palette.snackBg,
        duration: const Duration(seconds: 4),
        behavior: SnackBarBehavior.floating,
        margin: const EdgeInsets.fromLTRB(16, 0, 16, 16),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(QfScale.radiusMd),
        ),
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
        final next = _themeMode == QfThemeMode.blue
            ? QfThemeMode.dark
            : QfThemeMode.blue;
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
          keepScreenOn: s.keepScreenOn,
          onToggleKeepScreenOn: (v) async {
            await _settings?.setKeepScreenOn(v);
            if (!v) _clearKeepScreenOn();
          },
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
                        .instance
                        .platformDispatcher
                        .platformBrightness,
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
      // B20 返修：截图后空白校验——解码 PNG 后采样 3×3 九宫格 9 点，
      // 全同色且为纯黑/纯白才判空白（均匀彩色画面不再误判），提示用户
      // 重试或用系统截图，不保存空白图冒充成功。
      if (await _isBlankImage(bytes)) {
        if (mounted) _snack('截图为空白，请重试或用系统截图。');
        return;
      }
      // QF-08（3.0.0 中组）：截图改存应用内部私有目录（Android 10+
      // 分区存储下外部专属目录虽他应用一般不可读，但 Android 9 及以下
      // 传统外部存储可被他应用读取），文件名加随机后缀、不可预测。
      final base = await getApplicationDocumentsDirectory();
      final dir = Directory('${base.path}/screenshots');
      await dir.create(recursive: true);
      // B20：截图目录 30 天滚动清理（最多保留 50 张）。
      await _pruneScreenshots(dir);
      final now = DateTime.now();
      String two(int n) => n.toString().padLeft(2, '0');
      final rnd = math.Random.secure();
      final randHex = List.generate(
        6,
        (_) => rnd.nextInt(16).toRadixString(16),
      ).join();
      final name =
          'QFRemote-${now.year}${two(now.month)}${two(now.day)}-'
          '${two(now.hour)}${two(now.minute)}${two(now.second)}-$randHex.png';
      final file = File('${dir.path}/$name');
      await file.writeAsBytes(bytes);
      if (mounted) _snack('截图已保存：$name');
    } catch (e) {
      // 异常原文只进日志，用户面统一文案（H-5/VM-03 口径）。
      debugPrint('QF screenshot failed: $e');
      if (mounted) _snack('截图失败，请稍后重试。');
    }
  }

  /// 截图空白判定（B20，纯逻辑见顶层 isBlankSample）：解码后采样
  /// 3×3 九宫格 9 个像素，全同色且为纯黑/纯白才判空白。
  Future<bool> _isBlankImage(Uint8List bytes) async {
    try {
      final codec = await ui.instantiateImageCodec(bytes);
      final frame = await codec.getNextFrame();
      final image = frame.image;
      final data = await image.toByteData(format: ui.ImageByteFormat.rawRgba);
      if (data == null) return false;
      final w = image.width;
      final h = image.height;
      // B20 返修：3×3 九宫格 9 点采样（四角＋四边中点＋中心），
      // 全同色且为纯黑/纯白才判空白（见顶层 isBlankSample）。
      final xs = <int>{0, w ~/ 2, w - 1};
      final ys = <int>{0, h ~/ 2, h - 1};
      final pixels = <int>[
        for (final y in ys)
          for (final x in xs) _pixelAt(data, w, x, y),
      ];
      return isBlankSample(pixels);
    } catch (_) {
      return false; // 解不出来不误判为空白
    }
  }

  int _pixelAt(ByteData data, int width, int x, int y) {
    final off = (y * width + x) * 4;
    return data.getUint32(off);
  }

  /// 截图目录滚动清理：超 30 天或超 50 张时删最旧的。
  Future<void> _pruneScreenshots(Directory dir) async {
    try {
      final files = await dir.list().toList();
      final pngs = files.whereType<File>().toList();
      final cutoff = DateTime.now().subtract(const Duration(days: 30));
      for (final f in pngs) {
        try {
          final stat = await f.stat();
          if (stat.modified.isBefore(cutoff)) await f.delete();
        } catch (_) {}
      }
      final remaining = (await dir.list().toList()).whereType<File>().toList();
      if (remaining.length > 50) {
        remaining.sort((a, b) {
          final am = a.statSync().modified;
          final bm = b.statSync().modified;
          return am.compareTo(bm);
        });
        for (final f in remaining.sublist(0, remaining.length - 50)) {
          try {
            await f.delete();
          } catch (_) {}
        }
      }
    } catch (_) {}
  }

  String _diagnosticsText() {
    final p = _lastProbe;
    final s = _settings;
    return [
      'QFRemote 安卓版诊断信息',
      '版本：v$_currentVersion（构建日期 $kBuildDate）',
      '清单版本：${_updateEntry?.version ?? '未检查'}',
      '系统：${Platform.operatingSystem} ${Platform.operatingSystemVersion}',
      '服务器连通性检测：${p == null ? '尚未检测' : p.describe()}',
      '整页断线次数：${s?.offlineCount ?? 0}',
      '自动重连次数：${s?.watchdogReconnects ?? 0}',
      // A10：最近一次会话（设备＋阶段＋耗时＋结果）＋最近 20 条阶段日志。
      '最近一次会话：$_lastSessionSummary',
      // A8：性能 HUD 数值（WebView 渲染估算/页面探针耗时/输入→回显延迟/探针采样，
      // 见 session_perf.dart）。
      _perfTracker.diagnosticsLine(),
    ].join('\n');
  }

  /// 带最近 20 条阶段日志的完整诊断文本（关于页「复制诊断信息」用）。
  Future<String> _diagnosticsTextFull() async {
    final base = _diagnosticsText();
    final lines = await _sessionLog.recentLines(20);
    if (lines.isEmpty) return base;
    return '$base\n最近 20 条会话日志：\n${lines.join('\n')}';
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
        diagnosticsText: () async => _diagnosticsTextFull(),
        fetchPoints: _fetchPointsWhenLoggedIn,
      ),
    );
  }

  // ---------------- 构建 ----------------

  @override
  Widget build(BuildContext context) {
    if (!_booted || !_gateDone) {
      return Scaffold(
        body: SplashView(palette: _palette, version: _currentVersion),
      );
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
      final copy =
          gateCopyFor(gate) ??
          const GateCopy(
            title: '暂时无法登录',
            body: '当前状态暂时无法登录，请稍后再试，或咨询智能客服。',
            primary: GatePrimary.none,
          );
      return LicenseGatePage(
        decisionCode: gate.code,
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
          unawaited(
            _openShellWeb(
              '提交申诉',
              appealUser.trim().isEmpty
                  ? appealBase
                  : '$appealBase?u=${Uri.encodeQueryComponent(appealUser)}',
            ),
          );
        },
        onRebind: () => unawaited(_openRebind()),
        onSupport: () =>
            _openShellWeb('智能客服', '${SvcUrls.instance.extOrigin}/support'),
        onLogout: _manualLogoutFromMenu,
        onRecheck: _recheckLicense,
      );
    }

    // A-07：三档断点＋页面形态集中判定（全 App 只用这里的两个函数，
    // 不要各页面自己算断点）。
    final kind = layoutKindForWidth(MediaQuery.sizeOf(context).width);
    final form = resolvePageForm(kind, inSession: _fullscreen);

    // A-07：返回键接 SystemBackGate——对话框/抽屉先消费（独立路由
    // 天然先于壳处理），再走历史回退，耗尽后走原 _handleSystemBack
    // （页内后退→回设备槽→退出）。
    return SystemBackGate(
      history: _navHistory,
      onFallback: _handleSystemBack,
      child: Scaffold(
        backgroundColor: _palette.pageColor,
        body: SafeArea(
          // 框架在位时顶/底 inset 由顶栏与标签栏自己处理；无框架（登录页）时整页避让
          top: !_chromeVisible && !_fullscreen,
          bottom: !_chromeVisible && !_fullscreen,
          child: Stack(
            children: [
              QfAdaptiveShell(
                kind: kind,
                form: form,
                history: _navHistory,
                active: _slot,
                onSelect: _activateSlot,
                palette: _palette,
                chromeVisible: _chromeVisible,
                header: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    QfAppHeader(
                      scrolled: _scrolled,
                      palette: _palette,
                      title: _slotTitle,
                      probeColor: _probeBusy || _lastProbe == null
                          ? QfPalette.probeBusy
                          : (_lastProbe!.ok
                                ? QfPalette.probeOk
                                : QfPalette.probeBad),
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
                ),
                content:
                    // F-A2 返工：Tab 切换内容 D2/E-C crossfade（B §3.3）。
                    // AnimatedSwitcher 的 child 以前台槽为 key；槽内 5 个
                    // WebView 由 _slotStackKey 托管的 IndexedStack 只建一次，
                    // 新旧 child 共用同一个 IndexedStack element——crossfade
                    // 期间不复制 WebView（复制会重建控制器、重载页面），
                    // 效果为新内容 D2/E-C 淡入；reduced motion 时 80ms
                    // opacity（B §6.3 tab 行）。
                    AnimatedSwitcher(
                      duration: MediaQuery.disableAnimationsOf(context)
                          ? QfMotion.reducedOpacity
                          : QfMotion.d2,
                      switchInCurve: QfMotion.eC,
                      switchOutCurve: QfMotion.eC,
                      transitionBuilder: (child, animation) =>
                          FadeTransition(opacity: animation, child: child),
                      child: _SlotStack(
                        key: ValueKey<int>(
                          foregroundSlot(
                            chromeVisible: _chromeVisible,
                            selected: _slot,
                          ).index,
                        ),
                        stackKey: _slotStackKey,
                        // 前台槽裁决（SUP-P0-06）：未登录时强制设备槽，
                        // 登录页就在那里；选中槽只在登录后生效。
                        index: foregroundSlot(
                          chromeVisible: _chromeVisible,
                          selected: _slot,
                        ).index,
                        children: [
                          // 首页槽：网页新首页正本（C-3）壳内同框呈现，空白页
                          // 起步，会话建立后移植 cookie 再加载（保活）
                          InAppWebView(
                            // S-027/R-02：Key 带代次——重建即换 Key，
                            // 只换死掉的这一个槽，不动其它槽、不重建整个栈。
                            key: ValueKey(
                              'home-${_rendererRecovery.generation(AppSlot.home)}',
                            ),
                            initialUrlRequest: URLRequest(
                              url: WebUri('about:blank'),
                            ),
                            initialSettings: _slotWebViewSettings(AppSlot.home),
                            onWebViewCreated: (controller) {
                              _homeWeb = controller;
                              _rendererRecovery.noteRecreated(AppSlot.home);
                              if (_chromeVisible) _maybeLoadSlot(AppSlot.home);
                            },
                            // S-027/R-01：渲染进程死亡回调（带槽位标识）。
                            onRenderProcessGone: (controller, detail) =>
                                _onRendererGone(AppSlot.home, detail),
                            onRenderProcessResponsive: (controller, url) async {
                              _onRendererResponsive(AppSlot.home, url);
                              return null;
                            },
                            shouldOverrideUrlLoading: _slotUrlPolicy,
                            onCreateWindow: _onCreateWindowInPlace,
                            onLoadStop: (controller, url) {
                              // S-027/R-05：新实例加载完成，恢复耗时落定。
                              _rendererRecovery.noteLoadStopped(AppSlot.home);
                              unawaited(_pushThemeOnLoadStop(controller, url));
                            },
                            onUpdateVisitedHistory:
                                (controller, url, isReload) async {
                                  final can = await controller.canGoBack();
                                  if (mounted)
                                    setState(() => _homeCanGoBack = can);
                                },
                            onReceivedServerTrustAuthRequest: _onTrustChallenge,
                            onDownloadStartRequest: (controller, request) {
                              _handlePageDownload(request);
                            },
                            onScrollChanged: (controller, x, y) =>
                                _onSlotScroll(y),
                          ),
                          // 文件槽：控制台文件管理（本体在控制台页内）
                          InAppWebView(
                            key: ValueKey(
                              'files-${_rendererRecovery.generation(AppSlot.files)}',
                            ),
                            initialUrlRequest: URLRequest(
                              url: WebUri('about:blank'),
                            ),
                            initialSettings: _slotWebViewSettings(
                              AppSlot.files,
                            ),
                            onWebViewCreated: (controller) {
                              _filesWeb = controller;
                              _rendererRecovery.noteRecreated(AppSlot.files);
                              if (_chromeVisible) _maybeLoadSlot(AppSlot.files);
                            },
                            onRenderProcessGone: (controller, detail) =>
                                _onRendererGone(AppSlot.files, detail),
                            onRenderProcessResponsive: (controller, url) async {
                              _onRendererResponsive(AppSlot.files, url);
                              return null;
                            },
                            shouldOverrideUrlLoading: _slotUrlPolicy,
                            onCreateWindow: _onCreateWindowInPlace,
                            onLoadStop: (controller, url) {
                              _rendererRecovery.noteLoadStopped(AppSlot.files);
                              unawaited(_pushThemeOnLoadStop(controller, url));
                            },
                            onUpdateVisitedHistory:
                                (controller, url, isReload) async {
                                  final can = await controller.canGoBack();
                                  if (mounted)
                                    setState(() => _filesCanGoBack = can);
                                },
                            onReceivedServerTrustAuthRequest: _onTrustChallenge,
                            onDownloadStartRequest: (controller, request) {
                              _handlePageDownload(request);
                            },
                            onScrollChanged: (controller, x, y) =>
                                _onSlotScroll(y),
                          ),
                          // 设备槽：第 2 轮 #2——原生设备列表盖在控制台 WebView 上面
                          // （WebView 始终挂载：登录页／会话／看护都挂在它上面；
                          // 未登录或 Services 未构建时回落 WebView 控制台）。
                          Stack(
                            children: [
                              Stack(
                                // 控制台 WebView＋断线/恢复盖（保活，不随切槽销毁）
                                children: [
                                  InAppWebView(
                                    key: ValueKey(
                                      'devices-${_rendererRecovery.generation(AppSlot.devices)}',
                                    ),
                                    initialUrlRequest: URLRequest(
                                      url: WebUri(_startUrl),
                                    ),
                                    initialSettings: InAppWebViewSettings(
                                      javaScriptEnabled: true,
                                      domStorageEnabled: true,
                                      databaseEnabled: true,
                                      cacheEnabled: true,
                                      thirdPartyCookiesEnabled:
                                          WebViewCookiePolicy.thirdPartyCookiesEnabled(
                                            AppSlot.devices,
                                          ),
                                      // S-027/R-01：显式订阅渲染进程死亡事件。
                                      useOnRenderProcessGone: true,
                                      supportZoom: true,
                                      builtInZoomControls: true,
                                      displayZoomControls: false,
                                      useShouldOverrideUrlLoading: true,
                                      mediaPlaybackRequiresUserGesture: true,
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
                                      _rendererRecovery.noteRecreated(
                                        AppSlot.devices,
                                      );
                                      _registerLoginHandlers(controller);
                                      _startWatchdog();
                                      _startLoginLoop();
                                      // B1：首次加载启动 15 秒冷启动看门狗。
                                      _startBootLoadWatchdog();
                                    },
                                    onRenderProcessGone: (controller, detail) =>
                                        _onRendererGone(
                                          AppSlot.devices,
                                          detail,
                                        ),
                                    onRenderProcessResponsive:
                                        (controller, url) async {
                                          _onRendererResponsive(
                                            AppSlot.devices,
                                            url,
                                          );
                                          return null;
                                        },
                                    shouldOverrideUrlLoading:
                                        (controller, action) async {
                                          final url = action.request.url;
                                          if (url == null)
                                            return NavigationActionPolicy
                                                .CANCEL;
                                          // 跳登出地址 = 本人手动退出：先记下，别被自动恢复拉回来
                                          // （只认自有服务源，外站同名路径不许误触发）
                                          if (url.path == '/logout' &&
                                              SvcUrls.instance.isOwnOrigin(
                                                url.toString(),
                                              )) {
                                            _noteManualLogout();
                                          }
                                          if (url.scheme == 'http' ||
                                              url.scheme == 'https') {
                                            // B19：外站链接走系统浏览器，不在壳内打开。
                                            if (!SvcUrls.instance.isOwnOrigin(
                                              url.toString(),
                                            )) {
                                              try {
                                                await launchUrl(
                                                  Uri.parse(url.toString()),
                                                  mode: LaunchMode
                                                      .externalApplication,
                                                );
                                              } catch (_) {}
                                              return NavigationActionPolicy
                                                  .CANCEL;
                                            }
                                            return NavigationActionPolicy.ALLOW;
                                          }
                                          return NavigationActionPolicy.CANCEL;
                                        },
                                    onLoadStart: (controller, url) {
                                      _bridgeCapability =
                                          _newBridgeCapability();
                                      _mainFrameFailed = false;
                                      _http404 = false;
                                      _startBootLoadWatchdog();
                                      if (url != null) {
                                        _currentUrl = url.toString();
                                        _clearPendingSubmitIfLeftConsole(
                                          _currentUrl,
                                        );
                                        _injectedThisLoad = false;
                                        _filledThisLoad = false;
                                      }
                                    },
                                    onLoadStop: (controller, url) =>
                                        _onPageLoaded(),
                                    onReceivedError:
                                        (controller, request, error) {
                                          _bootLoadWatchdog?.cancel();
                                          _bootLoadWatchdog = null;
                                          if (request.isForMainFrame == true) {
                                            _mainFrameFailed = true;
                                            // S-027：重建中的新实例加载报错，
                                            // 恢复失败记一笔（不清除代次）。
                                            _rendererRecovery.noteRebuildFailed(
                                              AppSlot.devices,
                                            );
                                            _enterOffline();
                                          }
                                        },
                                    // B2：主框 HTTP 错误可见——≥500 进离线卡；404 明确
                                    // 提示「页面不存在（HTTP 404）」＋重试按钮，不静默
                                    // 展示服务端 404 页；401/403 走登录恢复链（不进
                                    // 离线卡，见 B7）。
                                    onReceivedHttpError:
                                        (controller, request, response) {
                                          _bootLoadWatchdog?.cancel();
                                          _bootLoadWatchdog = null;
                                          if (request.isForMainFrame != true)
                                            return;
                                          final code = response.statusCode;
                                          if (code == 404) {
                                            _mainFrameFailed = true;
                                            if (mounted) {
                                              setState(() => _http404 = true);
                                            }
                                          } else if (code != null &&
                                              code >= 500) {
                                            _mainFrameFailed = true;
                                            _enterOffline();
                                          } else if (code == 401 ||
                                              code == 403) {
                                            unawaited(
                                              _probeLogin().then((p) async {
                                                if (p != null &&
                                                    p.isLogin &&
                                                    mounted) {
                                                  await _onLoginPageDetected(
                                                    fromConsole: true,
                                                  );
                                                }
                                              }),
                                            );
                                          }
                                        },
                                    // B3：证书走系统默认校验，失败一律 CANCEL（见
                                    // _onTrustChallenge，不 PROCEED）。
                                    onReceivedServerTrustAuthRequest:
                                        _onTrustChallenge,
                                    onUpdateVisitedHistory:
                                        (controller, url, isReload) async {
                                          if (url != null) {
                                            _currentUrl = url.toString();
                                            _clearPendingSubmitIfLeftConsole(
                                              _currentUrl,
                                            );
                                            // A1/A5：会话路由变化 → 预检＋阶段 watcher。
                                            _onSessionRouteChanged(
                                              url.toString(),
                                            );
                                          }
                                          final can = await controller
                                              .canGoBack();
                                          if (mounted)
                                            setState(() => _canGoBack = can);
                                        },
                                    onConsoleMessage: (controller, msg) {
                                      if (kHasTestUrl)
                                        debugPrint(
                                          '[webconsole] ${msg.message}',
                                        );
                                    },
                                    onDownloadStartRequest:
                                        (controller, request) {
                                          _handlePageDownload(request);
                                        },
                                    onScrollChanged: (controller, x, y) =>
                                        _onSlotScroll(y),
                                  ),
                                  // A8：会话进行态性能 HUD（WebView 渲染估算/页面探针
                                  // 耗时/输入→回显延迟/探针采样，口径见 session_perf.dart；
                                  // 点「降采样」切档，点「标准采样」切回；半透明小条，不挡远程操作
                                  // 主区，须真机确认遮挡与可读性）。
                                  if (_sessionActive)
                                    Positioned(
                                      left: 10,
                                      top: 10,
                                      child: Material(
                                        color: Colors.black54,
                                        borderRadius: BorderRadius.circular(
                                          QfScale.radiusMd,
                                        ),
                                        child: Padding(
                                          padding: const EdgeInsets.symmetric(
                                            horizontal: 8,
                                          ),
                                          child: Row(
                                            mainAxisSize: MainAxisSize.min,
                                            children: [
                                              Text(
                                                _perfTracker.hudText(),
                                                style: const TextStyle(
                                                  color: Colors.white,
                                                  fontSize: QfScale.fs11,
                                                ),
                                              ),
                                              const SizedBox(width: 6),
                                              // A6：切换字改白色加粗（探针色在浅色桌面上
                                              // 对比不足）；触摸区包到 44（整条 HUD 高随之 44，
                                              // 定夺 Android 触控最小 44px）。
                                              GestureDetector(
                                                onTap: () {
                                                  setState(() {
                                                    _perfTracker.quality =
                                                        _perfTracker.quality ==
                                                            SessionQuality.low
                                                        ? SessionQuality.normal
                                                        : SessionQuality.low;
                                                  });
                                                  unawaited(
                                                    _applySessionQuality(),
                                                  );
                                                },
                                                child: Container(
                                                  constraints:
                                                      const BoxConstraints(
                                                        minWidth: 48,
                                                        minHeight: 48,
                                                      ),
                                                  alignment: Alignment.center,
                                                  child: Text(
                                                    _perfTracker.quality ==
                                                            SessionQuality.low
                                                        ? '标准采样'
                                                        : '降采样',
                                                    style: const TextStyle(
                                                      color: Colors.white,
                                                      fontSize: QfScale.fs11,
                                                      fontWeight:
                                                          FontWeight.w600,
                                                    ),
                                                  ),
                                                ),
                                              ),
                                            ],
                                          ),
                                        ),
                                      ),
                                    ),
                                  // S-027/R-05：恢复中轻提示（不弹系统对话框、
                                  // 不阻断其它槽）；恢复成功提示消失，失败达上限
                                  // 进离线卡＋手动重试。
                                  if (_rendererRecovery.isRecovering(
                                    AppSlot.devices,
                                  ))
                                    Positioned(
                                      left: 0,
                                      right: 0,
                                      bottom: 0,
                                      child: Material(
                                        color: Colors.black54,
                                        child: Padding(
                                          padding: const EdgeInsets.symmetric(
                                            vertical: 8,
                                          ),
                                          child: Text(
                                            '页面恢复中…',
                                            textAlign: TextAlign.center,
                                            style: const TextStyle(
                                              color: Colors.white,
                                              fontSize: QfScale.fs13,
                                            ),
                                          ),
                                        ),
                                      ),
                                    ),
                                  // 断线卡片/启动画面已提至根 Stack（SUP-P0-06）：
                                  // 不再困在本槽内，前台是哪个槽都看得见。
                                ],
                              ),
                              if (_devicesShowNative)
                                Positioned.fill(
                                  child: Container(
                                    color: _palette.pageColor,
                                    child: DeviceListScreen(
                                      viewModel: _deviceListViewModel!,
                                      onOpenDevice: _openDeviceSession,
                                    ),
                                  ),
                                ),
                            ],
                          ),
                          // 好友槽（聊天也在此槽内打开）：空白页起步，登录后预加载
                          InAppWebView(
                            key: ValueKey(
                              'friends-${_rendererRecovery.generation(AppSlot.friends)}',
                            ),
                            initialUrlRequest: URLRequest(
                              url: WebUri('about:blank'),
                            ),
                            initialSettings: _slotWebViewSettings(
                              AppSlot.friends,
                            ),
                            onWebViewCreated: (controller) {
                              _friendsWeb = controller;
                              _rendererRecovery.noteRecreated(AppSlot.friends);
                              if (_chromeVisible)
                                _maybeLoadSlot(AppSlot.friends);
                            },
                            onRenderProcessGone: (controller, detail) =>
                                _onRendererGone(AppSlot.friends, detail),
                            onRenderProcessResponsive: (controller, url) async {
                              _onRendererResponsive(AppSlot.friends, url);
                              return null;
                            },
                            shouldOverrideUrlLoading: _slotUrlPolicy,
                            onCreateWindow: _onCreateWindowInPlace,
                            onLoadStop: (controller, url) {
                              _rendererRecovery.noteLoadStopped(
                                AppSlot.friends,
                              );
                              unawaited(_injectShellChrome(controller, url));
                            },
                            onUpdateVisitedHistory:
                                (controller, url, isReload) async {
                                  if (url != null)
                                    _friendsCurrentUrl = url.toString();
                                  final can = await controller.canGoBack();
                                  if (mounted)
                                    setState(() => _friendsCanGoBack = can);
                                },
                            onReceivedServerTrustAuthRequest: _onTrustChallenge,
                            onDownloadStartRequest: (controller, request) {
                              _handlePageDownload(request);
                            },
                            onScrollChanged: (controller, x, y) =>
                                _onSlotScroll(y),
                          ),
                          // 论坛槽：空白页起步，免登桥处理后加载
                          InAppWebView(
                            key: ValueKey(
                              'forum-${_rendererRecovery.generation(AppSlot.forum)}',
                            ),
                            initialUrlRequest: URLRequest(
                              url: WebUri('about:blank'),
                            ),
                            initialSettings: _slotWebViewSettings(
                              AppSlot.forum,
                            ),
                            onWebViewCreated: (controller) {
                              _forumWeb = controller;
                              _rendererRecovery.noteRecreated(AppSlot.forum);
                              if (_chromeVisible) _maybeLoadSlot(AppSlot.forum);
                            },
                            onRenderProcessGone: (controller, detail) =>
                                _onRendererGone(AppSlot.forum, detail),
                            onRenderProcessResponsive: (controller, url) async {
                              _onRendererResponsive(AppSlot.forum, url);
                              return null;
                            },
                            shouldOverrideUrlLoading: _slotUrlPolicy,
                            onCreateWindow: _onCreateWindowInPlace,
                            onLoadStop: (controller, url) {
                              _rendererRecovery.noteLoadStopped(AppSlot.forum);
                              unawaited(_injectShellChrome(controller, url));
                            },
                            onUpdateVisitedHistory:
                                (controller, url, isReload) async {
                                  final can = await controller.canGoBack();
                                  if (mounted)
                                    setState(() => _forumCanGoBack = can);
                                },
                            onReceivedServerTrustAuthRequest: _onTrustChallenge,
                            onDownloadStartRequest: (controller, request) {
                              _handlePageDownload(request);
                            },
                            onScrollChanged: (controller, x, y) =>
                                _onSlotScroll(y),
                          ),
                          // 我的槽：原生页（样图 m09），常驻保活。
                          // key 绑 chrome：登录检出/登出时整页重建——未登录时
                          // 许可/积分拉取被短路（见 _fetchPointsWhenLoggedIn），
                          // 登录后靠这次重建补拉真实数据，不留旧账号残影。
                          NotificationListener<ScrollNotification>(
                            onNotification: (n) {
                              _onSlotScroll(n.metrics.pixels.round());
                              return false;
                            },
                            child: MePage(
                              key: ValueKey<bool>(_chromeVisible),
                              palette: _palette,
                              currentVersion: _currentVersion,
                              buildNumber: _pkg?.buildNumber,
                              hasUpdate: _updateEntry != null,
                              updateVersion: _updateEntry?.version,
                              rememberLine: (_settings?.rememberDevice ?? false)
                                  ? '已记住此设备，30 天内不用再登录'
                                  : '未记住此设备，下次打开需要重新登录',
                              fallbackUser: _savedCreds?.username,
                              fetchPoints: _fetchPointsWhenLoggedIn,
                              // B7 返修：积分拉取遇 401/403 时「我的」页显示
                              // 「登录已过期，请重新登录」＋重新登录入口。
                              authDead: _meAuthDead,
                              onRelogin: _reloginAfterAuthDead,
                              fetchProfile: () => _extService.fetchProfile(),
                              fetchProfileAvatar: (info) =>
                                  _extService.fetchProfileAvatar(info),
                              onOpenSettings: _openSettings,
                              onCheckUpdate: () =>
                                  _sessionUpdateCheck(manual: true),
                              onAccountAction: () {
                                _activateSlot(AppSlot.devices);
                                _snack('账号设置请在设备页中操作。');
                              },
                              onLogout: _manualLogoutFromMenu,
                              onOpenWebsite: () => _openShellWeb(
                                '官网',
                                SvcUrls.instance.websiteUrl,
                              ),
                              // H26/QF-33/三端入口：原生「我的」页 API 密钥入口，
                              // 点开进控制台 API 生成页（#apikeys，生成／撤销）。
                              onOpenApiKeys: () =>
                                  _openShellWeb('API 密钥', '$_startUrl#apikeys'),
                              // C1：已链接的设备（LEA 自助链接密钥列表＋吊销，
                              // 走控制台会话 cookie＋trustedHttpClient 同源）。
                              fetchLeaKeys: () async {
                                if (!_chromeVisible) return null;
                                return _extService.fetchLeaKeys();
                              },
                              revokeLeaKey: (keyId) =>
                                  _extService.revokeLeaSelfBindKey(keyId),
                              licenseSection: LicenseSection(
                                palette: _palette,
                                // B7 返修：许可区拉取遇 401/403 时显示「登录已过期，
                                // 请重新登录」＋重新登录入口（见 LicenseSection
                                // 的 authDead/onRelogin）；成功后入口消失。
                                authDead: _licenseAuthDead,
                                onRelogin: _reloginAfterAuthDead,
                                fetchLicense: () async {
                                  // 未登录短路（SUP-P0-06）：不发请求
                                  if (!_chromeVisible) return null;
                                  final result = await _licenseService
                                      .fetchLicenseMeResult();
                                  final dead =
                                      result.authDead ||
                                      _isRecentAuthFailure(
                                        _licenseService.lastAuthFailureAt,
                                      );
                                  if (mounted && dead != _licenseAuthDead) {
                                    setState(() => _licenseAuthDead = dead);
                                  }
                                  final me = result.me;
                                  // §7.5.7：/me 附带 forceLogout 时立即执行
                                  if (me != null && me.forceLogout) {
                                    unawaited(
                                      _handleForceLogoutSignal(
                                        me.gateCode ?? 'G1',
                                      ),
                                    );
                                  }
                                  return me;
                                },
                                onBind: (key) async {
                                  _deviceCode ??= await _deviceCodeStore
                                      .getOrCreate();
                                  return _licenseService.bindKey(
                                    key,
                                    _deviceCode!,
                                  );
                                },
                                onClaim: _claimFromShell,
                                // 决策 #24 兑换KEY（巡查 A-003 补齐安卓原生入口）
                                fetchMyKeys: _fetchMyKeysWhenLoggedIn,
                                onRedeem: _licenseService.redeemKey,
                                onRedeemId: _licenseService.redeemKeyId,
                                onPurchase: () => _openShellWeb(
                                  '购买密钥',
                                  SvcUrls.instance.purchaseUrl,
                                ),
                                onStatusQuery: () => _openShellWeb(
                                  '查询密钥',
                                  SvcUrls.instance.licenseStatusUrl,
                                ),
                              ),
                            ),
                          ),
                        ],
                      ),
                    ),
                tabBar: QfTabBar(
                  palette: _palette,
                  active: _slot,
                  onSelect: _activateSlot,
                ),
              ),
              if (_fullscreen)
                Positioned(
                  right: 14,
                  bottom: 18,
                  child: FloatingActionButton.small(
                    heroTag: 'exitFs',
                    backgroundColor: Colors.black54,
                    onPressed: _toggleFullscreen,
                    child: const Icon(
                      Icons.fullscreen_exit_outlined,
                      color: Colors.white,
                    ),
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
                    autoRetryStopped: _offlineRetryStopped,
                    attempts: _offlineAttempts,
                    onRetryNow: () {
                      _offlineTimer?.cancel();
                      _offlineAttempts = 0;
                      _offlineRetryStopped = false;
                      _web?.reload();
                      _scheduleOfflineRetry();
                    },
                  ),
                ),
              // RC-04：票据重连进行中浮层（盖住 WebView＝输入短路丢弃；
              // 显示第 N 次／共 5 次＋取消按钮；取消即停，不再自动重连）。
              if (_reconnecting)
                Positioned.fill(
                  child: Container(
                    color: Colors.black54,
                    child: SafeArea(
                      child: Center(
                        child: Container(
                          margin: const EdgeInsets.symmetric(horizontal: 28),
                          padding: const EdgeInsets.fromLTRB(26, 30, 26, 26),
                          decoration: BoxDecoration(
                            color: _palette.cardColor,
                            borderRadius: BorderRadius.circular(
                              QfScale.radiusMd,
                            ),
                            border: Border.all(color: _palette.cardBorder),
                            boxShadow: _palette.cardShadow,
                          ),
                          child: Column(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              Text(
                                _reconnectStatus.isEmpty
                                    ? '正在重连…'
                                    : _reconnectStatus,
                                style: const TextStyle(
                                  fontSize: 16,
                                  fontWeight: FontWeight.w600,
                                ),
                              ),
                              const SizedBox(height: 8),
                              const Text('重连期间不接收任何操作，恢复后自动继续。'),
                              const SizedBox(height: 18),
                              QfButtonTapTarget(
                                child: FilledButton(
                                  onPressed: () => _reconnectSession?.cancel(),
                                  child: const Text('取消重连'),
                                ),
                              ),
                            ],
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
              // B2 返修：主框 404 卡——「页面不存在（HTTP 404）」＋重试
              // 按钮（与 ≥500 离线卡同款式：白卡＋主按钮，不展示服务端
              // 404 页原文）；点重试清标记并重载当前页。
              if (_http404 && !_offline)
                Positioned.fill(
                  child: Container(
                    color: _palette.pageColor,
                    child: SafeArea(
                      child: Center(
                        child: Container(
                          margin: const EdgeInsets.symmetric(horizontal: 28),
                          padding: const EdgeInsets.fromLTRB(26, 30, 26, 26),
                          decoration: BoxDecoration(
                            color: _palette.cardColor,
                            borderRadius: BorderRadius.circular(
                              QfScale.radiusMd,
                            ),
                            border: Border.all(color: _palette.cardBorder),
                            boxShadow: _palette.cardShadow,
                          ),
                          child: Column(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              Text(
                                '页面不存在（HTTP 404）',
                                style: TextStyle(
                                  color: _palette.onCard,
                                  fontSize: QfScale.fs16,
                                  fontWeight: FontWeight.w600,
                                ),
                              ),
                              const SizedBox(height: 8),
                              Text(
                                '要打开的页面不存在或已被删除，请检查地址后重试。',
                                textAlign: TextAlign.center,
                                style: TextStyle(
                                  color: _palette.onCardDim,
                                  fontSize: QfScale.fs13,
                                  height: 1.5,
                                ),
                              ),
                              const SizedBox(height: 20),
                              QfButtonTapTarget(
                                child: FilledButton(
                                  onPressed: () {
                                    setState(() => _http404 = false);
                                    _web?.reload();
                                  },
                                  style: FilledButton.styleFrom(
                                    backgroundColor: _palette.brand,
                                    padding: const EdgeInsets.symmetric(
                                      horizontal: 30,
                                      vertical: 12,
                                    ),
                                    shape: RoundedRectangleBorder(
                                      borderRadius: BorderRadius.circular(
                                        QfScale.radiusMd,
                                      ),
                                    ),
                                  ),
                                  child: const Text('重试'),
                                ),
                              ),
                            ],
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
              if (_splashVisible)
                Positioned.fill(
                  child: SplashView(
                    palette: _palette,
                    version: _currentVersion,
                    note: _recoveryCover
                        ? (_recoveryStepText.isNotEmpty
                              ? _recoveryStepText
                              : '正在恢复登录…')
                        : null,
                    onCancelRecovery: _recoveryCover ? _cancelRecovery : null,
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}
