import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:qfremote/app/background/background_controller.dart';
import 'package:qfremote/app/background/background_tiers.dart';
import 'package:qfremote/app/background/qf_background_scheduler.dart';
import 'package:qfremote/services/qf_bridge.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('QfBackgroundScheduler（真实调度器，走 qfremote/bridge）', () {
    final calls = <MethodCall>[];
    bool? nextResult;

    setUp(() {
      calls.clear();
      nextResult = true;
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(QfBridge.channel, (call) async {
        calls.add(call);
        return nextResult;
      });
    });

    tearDown(() {
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(QfBridge.channel, null);
    });

    test('schedule：发 background.schedulePeriodicSync，参数逐字一致', () async {
      final s = QfBackgroundScheduler();
      await s.schedulePeriodicSync(
        'qf-periodic-sync',
        const PeriodicSyncConstraints(
          wifiOnly: true,
          chargingOnly: true,
          batteryNotLow: false,
          interval: Duration(minutes: 30),
        ),
      );
      expect(calls, hasLength(1));
      expect(calls.single.method, 'background.schedulePeriodicSync');
      expect(
        calls.single.arguments,
        {
          'taskId': 'qf-periodic-sync',
          'wifiOnly': true,
          'chargingOnly': true,
          'batteryNotLow': false,
          'intervalMinutes': 30,
        },
      );
    });

    test('schedule：间隔 <15 分钟直接 ArgumentError，不发通道调用', () async {
      final s = QfBackgroundScheduler();
      await expectLater(
        s.schedulePeriodicSync(
          'x',
          const PeriodicSyncConstraints(interval: Duration(minutes: 5)),
        ),
        throwsArgumentError,
      );
      expect(calls, isEmpty);
    });

    test('schedule：原生回 false 抛 StateError，不冒充已调度', () async {
      nextResult = false;
      final s = QfBackgroundScheduler();
      await expectLater(
        s.schedulePeriodicSync(
            'x', const PeriodicSyncConstraints()),
        throwsStateError,
      );
    });

    test('schedule：原生无响应（null）抛 StateError', () async {
      nextResult = null;
      final s = QfBackgroundScheduler();
      await expectLater(
        s.schedulePeriodicSync(
            'x', const PeriodicSyncConstraints()),
        throwsStateError,
      );
    });

    test('cancel：发 background.cancelPeriodicSync；原生 false 也不抛', () async {
      nextResult = false;
      final s = QfBackgroundScheduler();
      await s.cancelPeriodicSync('qf-periodic-sync');
      expect(calls.single.method, 'background.cancelPeriodicSync');
      expect(calls.single.arguments, {'taskId': 'qf-periodic-sync'});
    });

    test('startActiveSession：原生 true→true，null→false', () async {
      final s = QfBackgroundScheduler();
      expect(await s.startActiveSession('正在远程会话'), isTrue);
      expect(calls.single.method, 'session.startForeground');
      expect(calls.single.arguments, {'label': '正在远程会话'});
      nextResult = null;
      expect(await s.startActiveSession('正在远程会话'), isFalse);
    });

    test('stopActiveSession：发 session.stopForeground', () async {
      final s = QfBackgroundScheduler();
      await s.stopActiveSession();
      expect(calls.single.method, 'session.stopForeground');
    });

    test('onWakeSignal：调回调＋记列表', () {
      final seen = <String>[];
      final s = QfBackgroundScheduler(onWakeSignalReceived: seen.add);
      s.onWakeSignal('device_online');
      expect(seen, ['device_online']);
      expect(s.receivedWakeSignals, ['device_online']);
    });
  });

  group('BackgroundTierController（分级策略）', () {
    test('初始 periodicSync；登录态下调度一次且去重', () async {
      final fake = FakeBackgroundScheduler();
      final c = BackgroundTierController(
        scheduler: fake,
        isLoggedIn: () => true,
      );
      expect(c.tier, BackgroundTier.periodicSync);
      await c.ensurePeriodicSync();
      await c.ensurePeriodicSync();
      expect(fake.scheduled, hasLength(1));
      expect(
        fake.scheduled.containsKey(BackgroundTierController.periodicTaskId),
        isTrue,
      );
      expect(c.periodicScheduled, isTrue);
      expect(c.lastError, isNull);
    });

    test('未登录不调度', () async {
      final fake = FakeBackgroundScheduler();
      final c = BackgroundTierController(
        scheduler: fake,
        isLoggedIn: () => false,
      );
      await c.ensurePeriodicSync();
      expect(fake.scheduled, isEmpty);
      expect(c.periodicScheduled, isFalse);
    });

    test('会话起停：activeSession→停服务降级回周期同步', () async {
      final fake = FakeBackgroundScheduler();
      final c = BackgroundTierController(
        scheduler: fake,
        isLoggedIn: () => true,
      );
      await c.onSessionStarted('正在远程会话');
      expect(c.tier, BackgroundTier.activeSession);
      expect(c.sessionActive, isTrue);
      expect(fake.activeSession, isTrue);
      expect(c.foregroundServiceActive, isTrue);
      await c.onSessionEnded();
      expect(c.tier, BackgroundTier.periodicSync);
      expect(c.sessionActive, isFalse);
      expect(fake.activeSession, isFalse);
      expect(c.foregroundServiceActive, isFalse);
      expect(c.periodicScheduled, isTrue);
    });

    test('唤醒信号：前台立即拉取，后台挂起、回前台拉取一次', () async {
      final fake = FakeBackgroundScheduler();
      var pulls = 0;
      final c = BackgroundTierController(
        scheduler: fake,
        isLoggedIn: () => true,
        onPullRequested: () async => pulls++,
      );
      c.onWakeSignal('device_online');
      expect(pulls, 1);
      expect(c.pendingWakeSignals, isEmpty);
      await c.onAppBackgrounded();
      c.onWakeSignal('license_changed');
      c.onWakeSignal('device_offline');
      expect(pulls, 1);
      expect(c.pendingWakeSignals,
          ['license_changed', 'device_offline']);
      await c.onAppResumed();
      expect(pulls, 2);
      expect(c.pendingWakeSignals, isEmpty);
    });

    test('切后台：无会话调度周期同步；有会话不重复调度', () async {
      final fake = FakeBackgroundScheduler();
      final c = BackgroundTierController(
        scheduler: fake,
        isLoggedIn: () => true,
      );
      await c.onAppBackgrounded();
      expect(fake.scheduled, hasLength(1));
      await c.onSessionStarted('正在远程会话');
      await c.onAppBackgrounded();
      expect(fake.scheduled, hasLength(1));
    });

    test('调度失败记 lastError 不抛，下次成功后清掉', () async {
      final c = BackgroundTierController(
        scheduler: _FailingScheduler(),
        isLoggedIn: () => true,
      );
      await c.ensurePeriodicSync();
      expect(c.periodicScheduled, isFalse);
      expect(c.lastError, isNotNull);
    });

    test('默认调度器是真实调度器；控制器接上其唤醒回调', () async {
      var pulls = 0;
      final c = BackgroundTierController(
        isLoggedIn: () => true,
        onPullRequested: () async => pulls++,
      );
      expect(c.scheduler, isA<QfBackgroundScheduler>());
      final real = c.scheduler as QfBackgroundScheduler;
      expect(real.onWakeSignalReceived, isNotNull);
      // 前台：经调度器收到的唤醒信号直达控制器并立即拉取，不挂起。
      real.onWakeSignal('device_online');
      expect(real.receivedWakeSignals, ['device_online']);
      expect(pulls, 1);
      expect(c.pendingWakeSignals, isEmpty);
      // 后台：经调度器收到的唤醒信号挂起，回前台再拉取。
      await c.onAppBackgrounded();
      real.onWakeSignal('license_changed');
      expect(pulls, 1);
      expect(c.pendingWakeSignals, ['license_changed']);
      await c.onAppResumed();
      expect(pulls, 2);
      expect(c.pendingWakeSignals, isEmpty);
    });

    test('cancelPeriodicSync：清掉调度记录（供退出登录调用）', () async {
      final fake = FakeBackgroundScheduler();
      final c = BackgroundTierController(
        scheduler: fake,
        isLoggedIn: () => true,
      );
      await c.ensurePeriodicSync();
      expect(c.periodicScheduled, isTrue);
      await c.cancelPeriodicSync();
      expect(c.periodicScheduled, isFalse);
      expect(fake.scheduled, isEmpty);
    });
  });
}

/// 只在 schedule 时抛错的调度器（其余走 Fake），用于“失败记错不抛”用例。
class _FailingScheduler implements BackgroundScheduler {
  final _fake = FakeBackgroundScheduler();

  @override
  Future<void> schedulePeriodicSync(
          String taskId, PeriodicSyncConstraints constraints) =>
      throw StateError('native unavailable');

  @override
  Future<void> cancelPeriodicSync(String taskId) =>
      _fake.cancelPeriodicSync(taskId);

  @override
  void onWakeSignal(String kind) => _fake.onWakeSignal(kind);

  @override
  Future<bool> startActiveSession(String sessionLabel) =>
      _fake.startActiveSession(sessionLabel);

  @override
  Future<void> stopActiveSession() => _fake.stopActiveSession();
}
