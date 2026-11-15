import 'package:flutter_test/flutter_test.dart';
import 'package:qfremote/app/background/background_tiers.dart';
import 'package:qfremote/app/boot.dart';
import 'package:qfremote/app/permissions/permission_service.dart';

void main() {
  group('A-04 启动三段', () {
    test('runBootStep：成功记耗时', () async {
      final r = await runBootStep('db', BootPhase.blocking, () async {});
      expect(r.ok, isTrue);
      expect(r.elapsedMs, greaterThanOrEqualTo(0));
    });

    test('runBootStep：抛错按失败记，不抛到调用方', () async {
      final r = await runBootStep(
          'db', BootPhase.blocking, () async => throw StateError('boom'));
      expect(r.ok, isFalse);
      expect(r.error, contains('boom'));
    });

    test('runBootStep：超时按失败记（10 秒默认可覆盖）', () async {
      final r = await runBootStep(
        'slow',
        BootPhase.nonBlocking,
        () async => Future<void>.delayed(const Duration(seconds: 2)),
        stepTimeout: const Duration(milliseconds: 100),
      );
      expect(r.ok, isFalse);
      expect(r.error, contains('timeout'));
    });

    test('BootReport.blockingOk 只看阻塞段', () {
      final report = BootReport(
        steps: [
          const BootStepResult(
              name: 'db', phase: BootPhase.blocking, ok: true, elapsedMs: 5),
          const BootStepResult(
              name: 'remote-config',
              phase: BootPhase.nonBlocking,
              ok: false,
              elapsedMs: 5),
        ],
        startedAt: DateTime.now(),
      );
      expect(report.blockingOk, isTrue);
      expect(report.failedSteps, ['remote-config']);
    });

    test('FirstFrameTimer 门阈值 3000ms', () {
      expect(FirstFrameTimer.gateThresholdMs, 3000);
    });
  });

  group('A-01 后台分级三档', () {
    test('tierFor：会话态优先，其次推送兜底，最后周期同步', () {
      expect(
          tierFor(sessionActive: true, pushAvailable: true),
          BackgroundTier.activeSession);
      expect(
          tierFor(sessionActive: false, pushAvailable: true),
          BackgroundTier.wakeSignal);
      expect(
          tierFor(sessionActive: false, pushAvailable: false),
          BackgroundTier.periodicSync);
    });

    test('周期同步最短 15 分钟，不许更短', () async {
      const ok = PeriodicSyncConstraints();
      expect(ok.interval, const Duration(minutes: 15));
      expect(ok.wifiOnly, isTrue);
      final s = FakeBackgroundScheduler();
      await expectLater(
          s.schedulePeriodicSync('x',
              const PeriodicSyncConstraints(interval: Duration(minutes: 5))),
          throwsArgumentError);
    });

    test('FakeBackgroundScheduler：注册去重＋唤醒信号只记种类', () async {
      final s = FakeBackgroundScheduler();
      await s.schedulePeriodicSync(
          'sync', const PeriodicSyncConstraints());
      await s.schedulePeriodicSync(
          'sync', const PeriodicSyncConstraints());
      expect(s.scheduled, hasLength(1));
      s.onWakeSignal('device_online');
      expect(s.wakeSignals, ['device_online']);
      expect(await s.startActiveSession('会话'), isTrue);
      expect(s.activeSession, isTrue);
      await s.stopActiveSession();
      expect(s.activeSession, isFalse);
    });
  });

  group('A-03 权限克制清单', () {
    test('每种权限都有去设置的文字路径', () {
      for (final kind in PermissionKind.values) {
        final text = permissionSettingsPathText(kind);
        expect(text, isNotNull);
        expect(text, contains('去设置'));
      }
    });

    test('特殊权限须去设置页，运行时权限不用', () {
      expect(permissionRequiresSettingsPage(PermissionKind.overlay),
          isTrue);
      expect(
          permissionRequiresSettingsPage(PermissionKind.accessibility),
          isTrue);
      expect(
          permissionRequiresSettingsPage(
              PermissionKind.ignoreBatteryOptimizations),
          isTrue);
      expect(
          permissionRequiresSettingsPage(PermissionKind.notifications),
          isFalse);
      expect(permissionRequiresSettingsPage(PermissionKind.microphone),
          isFalse);
    });

    test('FakePermissionService：申请被记下来', () async {
      final s = FakePermissionService(preset: {
        PermissionKind.notifications: PermissionOutcome.permanentlyDenied,
      });
      expect(await s.request(PermissionKind.notifications),
          PermissionOutcome.permanentlyDenied);
      expect(s.requested, [PermissionKind.notifications]);
      expect(s.settingsPathText(PermissionKind.notifications),
          contains('通知'));
    });
  });
}
