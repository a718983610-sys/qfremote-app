import 'dart:async';

/// A-01 后台分级三档，绝不混用（Tusky / AntennaPod / Signal 模式）：
/// “在线心跳/待命唤醒”与“正在远程会话”是两回事，前者绝不能用常驻前台
/// 服务硬扛，后者才配前台服务＋明确类型。
///
/// 三档：
/// 1. [BackgroundTier.wakeSignal]——唤醒信号：推送只发信号、不带正文，
///    收到后由端内再拉取。QFRemote 安卓端目前未接 FCM（国内大量无 GMS
///    设备）：无推送通道时本档为空转，直接落到第二档兜底，绝不静默失联
///    （Element X 无推送即失联是反面教材）。
/// 2. [BackgroundTier.periodicSync]——周期同步：系统调度、最短 15 分钟、
///    仅 Wi-Fi/充电/电量不低约束；Dart 侧绝不自己起 Timer 轮询。
/// 3. [BackgroundTier.activeSession]——正在会话：类型明确的前台服务
///    （见 A-02），会话结束即降级/停止。
enum BackgroundTier { wakeSignal, periodicSync, activeSession }

/// 周期同步约束（AntennaPod 约束清单直抄：仅 Wi-Fi、仅充电时、缓存上限）。
class PeriodicSyncConstraints {
  final bool wifiOnly;
  final bool chargingOnly;
  final bool batteryNotLow;

  /// 最短间隔：Android WorkManager 允许的最小值，绝不自己写更短的轮询。
  /// 下限在 [BackgroundScheduler.schedulePeriodicSync] 的实现里强制
  /// （const 构造的 assert 里不能做 Duration 比较，故不在此断言）。
  final Duration interval;

  const PeriodicSyncConstraints({
    this.wifiOnly = true,
    this.chargingOnly = false,
    this.batteryNotLow = true,
    this.interval = const Duration(minutes: 15),
  });
}

/// 后台任务调度器接口：Dart 侧只认接口，原生实现（WorkManager/前台服务）
/// 由平台侧接线；测试用 [FakeBackgroundScheduler]。
abstract class BackgroundScheduler {
  /// 注册周期同步（第二档）。重复注册同一任务时去重，不叠加。
  Future<void> schedulePeriodicSync(
      String taskId, PeriodicSyncConstraints constraints);

  /// 取消周期同步。
  Future<void> cancelPeriodicSync(String taskId);

  /// 唤醒信号到达（第一档）：只记“有新事件”，内容一律走加密通道拉取。
  void onWakeSignal(String kind);

  /// 进入正在会话态（第三档）：起类型明确的前台服务。
  Future<bool> startActiveSession(String sessionLabel);

  /// 退出会话态：停前台服务，降级回周期同步。
  Future<void> stopActiveSession();
}

/// 三档分流裁决（纯逻辑，可单测）：按当前状态决定走哪一档。
BackgroundTier tierFor({
  required bool sessionActive,
  required bool pushAvailable,
}) {
  if (sessionActive) return BackgroundTier.activeSession;
  if (pushAvailable) return BackgroundTier.wakeSignal;
  return BackgroundTier.periodicSync;
}

/// 测试/沙箱用假调度器：只记调用，不碰原生。
class FakeBackgroundScheduler implements BackgroundScheduler {
  final scheduled = <String, PeriodicSyncConstraints>{};
  final wakeSignals = <String>[];
  var activeSession = false;

  @override
  Future<void> schedulePeriodicSync(
      String taskId, PeriodicSyncConstraints constraints) async {
    if (constraints.interval < const Duration(minutes: 15)) {
      throw ArgumentError('周期同步最短 15 分钟（WorkManager 下限），不许更短');
    }
    scheduled[taskId] = constraints;
  }

  @override
  Future<void> cancelPeriodicSync(String taskId) async {
    scheduled.remove(taskId);
  }

  @override
  void onWakeSignal(String kind) => wakeSignals.add(kind);

  @override
  Future<bool> startActiveSession(String sessionLabel) async {
    activeSession = true;
    return true;
  }

  @override
  Future<void> stopActiveSession() async {
    activeSession = false;
  }
}
