import 'dart:async';

import 'package:flutter/widgets.dart';

/// A-04 启动三段（Invoice Ninja 2026-09-22 事故教训＋Signal 三阶段启动）：
/// 启动必须无条件到达 runApp()，前面一切 await 都加超时、try/catch，
/// 失败也要先跑起 UI 再降级提示，绝不让用户卡在启动转圈。
///
/// 三段：
/// 1. [BootPhase.blocking]——阻塞段：只做解密库、数据库、依赖注册。
/// 2. [BootPhase.nonBlocking]——非阻塞段：并行做远程配置刷新等。
/// 3. [BootPhase.deferred]——首帧渲染后：订阅检查等次要事。
/// 每步默认超时 10 秒（[stepTimeout]），超时按失败记、继续下一步。
enum BootPhase { blocking, nonBlocking, deferred }

class BootStepResult {
  final String name;
  final BootPhase phase;
  final bool ok;
  final int elapsedMs;
  final String? error;

  const BootStepResult({
    required this.name,
    required this.phase,
    required this.ok,
    required this.elapsedMs,
    this.error,
  });
}

class BootReport {
  final List<BootStepResult> steps;
  final DateTime startedAt;
  final int? firstFrameMs;

  const BootReport({
    required this.steps,
    required this.startedAt,
    this.firstFrameMs,
  });

  bool get blockingOk =>
      steps.where((s) => s.phase == BootPhase.blocking).every((s) => s.ok);

  List<String> get failedSteps =>
      steps.where((s) => !s.ok).map((s) => s.name).toList();
}

/// 跑一步启动任务：超时＋异常都按失败记，不抛到调用方。
Future<BootStepResult> runBootStep(
  String name,
  BootPhase phase,
  Future<void> Function() step, {
  Duration stepTimeout = const Duration(seconds: 10),
}) async {
  final sw = Stopwatch()..start();
  try {
    await step().timeout(stepTimeout);
    sw.stop();
    return BootStepResult(
        name: name, phase: phase, ok: true, elapsedMs: sw.elapsedMilliseconds);
  } on TimeoutException {
    sw.stop();
    return BootStepResult(
        name: name,
        phase: phase,
        ok: false,
        elapsedMs: sw.elapsedMilliseconds,
        error: 'timeout ${stepTimeout.inSeconds}s');
  } catch (e) {
    sw.stop();
    return BootStepResult(
        name: name,
        phase: phase,
        ok: false,
        elapsedMs: sw.elapsedMilliseconds,
        error: e.toString());
  }
}

/// 首帧计时（A-04 发版门）：从 runApp 起到第一帧渲染完成的时间。
/// 用法：main() 里建一个，runApp 后 `recordFirstFrame()`，读 [firstFrameMs]。
/// 超过 3000ms 即进发版门红线（须人工复核启动链，不自动放行）。
class FirstFrameTimer {
  FirstFrameTimer() : _startedAt = DateTime.now();

  final DateTime _startedAt;
  int? _firstFrameMs;
  bool _recorded = false;

  int? get firstFrameMs => _firstFrameMs;

  /// 在 runApp 后调用一次；首帧回调到达时记下耗时。
  void recordFirstFrame() {
    if (_recorded) return;
    _recorded = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _firstFrameMs =
          DateTime.now().difference(_startedAt).inMilliseconds;
    });
  }

  /// 发版门阈值（毫秒）。
  static const int gateThresholdMs = 3000;

  bool get overGate =>
      _firstFrameMs != null && _firstFrameMs! > gateThresholdMs;
}
