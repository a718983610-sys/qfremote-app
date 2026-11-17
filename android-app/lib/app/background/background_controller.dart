import 'dart:async';

import 'background_tiers.dart';
import 'qf_background_scheduler.dart';

/// A-01 后台分级控制器：三档的唯一生产接线点。
///
/// - 周期同步（第二档）：登录态下由系统调度（JobScheduler，最短 15 分
///   钟），进程被杀后仍能触发节拍；Dart 侧绝不自己起 Timer 轮询。
/// - 唤醒信号（第一档）：QFRemote 目前未接 FCM（国内大量无 GMS 设备），
///   信号只能来自端内触发；到达时只记种类，内容一律走加密通道拉取——
///   前台时立即拉取，后台时挂起，回前台再拉取。
/// - 正在会话（第三档）：唯一配前台服务的档，复用现有 QfBridge 前台
///   服务（QfSessionService，specialUse）；会话结束即停服务、降级
///   回周期同步。
///
/// 约束边界（本轮不碰，写清）：
/// - 同步的“内容拉取”本身（设备／许可证拉取）依赖 #1 Services／Drift
///   与 #2 设备列表，那两条线未接线；本轮只接调度＋唤醒＋前台整合，
///   节拍到达后由下次进程启动／回前台时的既有探针（`_runProbe`）走
///   加密通道拉取，不在本处发明拉取逻辑。
/// - 退出登录时取消周期同步须由持有 `_clearAuthState` 的线调用
///   [cancelPeriodicSync]（main.dart 的 `_clearAuthState` 段属另一
///   并行线，本线不碰）；控制器 [dispose] 只清内存态，不取消系统任务
///   （任务本就设计为进程被杀后仍在）。
class BackgroundTierController {
  BackgroundTierController({
    BackgroundScheduler? scheduler,
    required this.isLoggedIn,
    this.onPullRequested,
  }) : _scheduler = scheduler ?? QfBackgroundScheduler() {
    final s = _scheduler;
    if (s is QfBackgroundScheduler && s.onWakeSignalReceived == null) {
      s.onWakeSignalReceived = onWakeSignal;
    }
  }

  /// 系统周期同步任务 id（全 App 唯一，JobScheduler 侧按此去重）。
  static const periodicTaskId = 'qf-periodic-sync';

  final BackgroundScheduler _scheduler;

  /// 当前是否登录（main.dart 供：`_savedCreds != null`）。未登录不调度。
  final bool Function() isLoggedIn;

  /// 需要拉取内容时调用（main.dart 供：`_runProbe`）。
  final Future<void> Function()? onPullRequested;

  /// 测试／排障用：当前实际走的调度器。
  BackgroundScheduler get scheduler => _scheduler;

  bool _sessionActive = false;
  bool _foregroundServiceActive = false;
  bool _foreground = true;
  final _periodicScheduled = <String>{};
  final _pendingWakeSignals = <String>[];
  Object? _lastError;

  /// 当前档位：会话态 → 正在会话；否则 → 周期同步（无 FCM，故无
  /// “等待推送”档；唤醒信号只作挂起事件，不单独成档）。
  BackgroundTier get tier =>
      tierFor(sessionActive: _sessionActive, pushAvailable: false);

  bool get sessionActive => _sessionActive;

  /// 前台服务是否实际已起（原生侧回 true 才算起，失败不冒充）。
  bool get foregroundServiceActive => _foregroundServiceActive;

  /// 周期同步是否已在本进程内调度成功。
  bool get periodicScheduled => _periodicScheduled.contains(periodicTaskId);

  /// 挂起未拉取的唤醒信号（只记种类）。
  List<String> get pendingWakeSignals =>
      List.unmodifiable(_pendingWakeSignals);

  /// 最近一次调度／起服务失败的原因（null＝无失败）；下次成功后清掉。
  Object? get lastError => _lastError;

  /// 确保周期同步已调度（登录态才调度；已调度过直接返回；失败记
  /// [lastError] 不抛——调用方均为 unawaited 的生命周期钩子，下次
  /// 生命周期事件会重试）。
  Future<void> ensurePeriodicSync() async {
    if (!isLoggedIn()) return;
    if (_periodicScheduled.contains(periodicTaskId)) return;
    try {
      await _scheduler.schedulePeriodicSync(
          periodicTaskId, const PeriodicSyncConstraints());
      _periodicScheduled.add(periodicTaskId);
      _lastError = null;
    } catch (e) {
      _lastError = e;
    }
  }

  /// 取消周期同步（退出登录时由 `_clearAuthState` 持有方调用）。
  Future<void> cancelPeriodicSync() async {
    await _scheduler.cancelPeriodicSync(periodicTaskId);
    _periodicScheduled.remove(periodicTaskId);
  }

  /// 进入会话态：起类型明确的前台服务（第三档）。
  Future<void> onSessionStarted(String label) async {
    _sessionActive = true;
    try {
      _foregroundServiceActive = await _scheduler.startActiveSession(label);
      if (!_foregroundServiceActive) {
        _lastError = StateError('前台服务启动失败：原生侧未响应');
      } else {
        _lastError = null;
      }
    } catch (e) {
      _foregroundServiceActive = false;
      _lastError = e;
    }
  }

  /// 退出会话态：停前台服务，降级回周期同步（第二档）。
  Future<void> onSessionEnded() async {
    _sessionActive = false;
    _foregroundServiceActive = false;
    try {
      await _scheduler.stopActiveSession();
    } catch (_) {
      // 停服务失败不阻断降级：周期同步照常接管。
    }
    await ensurePeriodicSync();
  }

  /// 唤醒信号到达：前台时立即拉取（不挂起）；后台时只记种类、挂起等
  /// 回前台再拉取。内容一律走加密通道拉取，本处不带正文。
  void onWakeSignal(String kind) {
    if (_foreground) {
      _requestPull();
      return;
    }
    _pendingWakeSignals.add(kind);
  }

  /// 取出并清空挂起的唤醒信号。
  List<String> consumePendingWakeSignals() {
    final out = List<String>.of(_pendingWakeSignals);
    _pendingWakeSignals.clear();
    return out;
  }

  /// 切后台：无会话时确保周期同步已调度（会话进行中由前台服务持有，
  /// 不重复调度）。
  Future<void> onAppBackgrounded() async {
    _foreground = false;
    if (!_sessionActive) await ensurePeriodicSync();
  }

  /// 回前台：确保周期同步已调度；有挂起的唤醒信号时拉取一次。
  Future<void> onAppResumed() async {
    _foreground = true;
    await ensurePeriodicSync();
    if (_pendingWakeSignals.isNotEmpty) {
      consumePendingWakeSignals();
      _requestPull();
    }
  }

  /// 只清内存态；系统周期任务故意不取消（进程被杀后仍在，退出登录
  /// 时由 [cancelPeriodicSync] 取消）。
  void dispose() {
    _pendingWakeSignals.clear();
  }

  void _requestPull() {
    final cb = onPullRequested;
    if (cb != null) unawaited(cb());
  }
}
