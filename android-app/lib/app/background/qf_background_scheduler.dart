import 'background_tiers.dart';
import 'package:qfremote/services/qf_bridge.dart';

/// A-01 第二档的真实调度器：Dart 侧只认 [BackgroundScheduler] 接口，
/// 原生实现走 `qfremote/bridge` 的 `background.*` 方法（Kotlin 侧
/// JobScheduler 系统调度，见 MainActivity.kt 与 QfSyncScheduler.kt）。
///
/// 失败语义（fail-closed）：
/// - 周期同步最短 15 分钟：Dart 侧先拦（[ArgumentError]，与
///   [FakeBackgroundScheduler] 同口径），原生侧再钳制一次，绝不自己写
///   更短的轮询。
/// - 原生侧返回 false／无响应（沙箱／旧包）时 [schedulePeriodicSync]
///   抛 [StateError]，调用方（[BackgroundTierController]）记错重
///   试，不静默当作已调度。
/// - [cancelPeriodicSync] 尽力而为：取消一个不存在的任务不是错，不抛。
class QfBackgroundScheduler implements BackgroundScheduler {
  QfBackgroundScheduler({this.onWakeSignalReceived});

  /// 唤醒信号到达时的回调（由 [BackgroundTierController] 在构造后
  /// 接上）；未接时信号只记入 [receivedWakeSignals]，不丢。
  void Function(String kind)? onWakeSignalReceived;

  /// 未接回调时收到的唤醒信号（只记种类，内容一律走加密通道拉取）。
  final receivedWakeSignals = <String>[];

  @override
  Future<void> schedulePeriodicSync(
      String taskId, PeriodicSyncConstraints constraints) async {
    if (constraints.interval < const Duration(minutes: 15)) {
      throw ArgumentError('周期同步最短 15 分钟（WorkManager 下限），不许更短');
    }
    final ok = await QfBridge.schedulePeriodicSync(
      taskId,
      wifiOnly: constraints.wifiOnly,
      chargingOnly: constraints.chargingOnly,
      batteryNotLow: constraints.batteryNotLow,
      intervalMinutes: constraints.interval.inMinutes,
    );
    if (!ok) {
      throw StateError('周期同步注册失败：原生侧未响应（taskId=$taskId）');
    }
  }

  @override
  Future<void> cancelPeriodicSync(String taskId) async {
    await QfBridge.cancelPeriodicSync(taskId);
  }

  @override
  void onWakeSignal(String kind) {
    receivedWakeSignals.add(kind);
    onWakeSignalReceived?.call(kind);
  }

  @override
  Future<bool> startActiveSession(String sessionLabel) =>
      QfBridge.startSessionForeground(sessionLabel);

  @override
  Future<void> stopActiveSession() async {
    await QfBridge.stopSessionForeground();
  }
}
