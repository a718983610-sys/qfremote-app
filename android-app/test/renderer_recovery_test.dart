import 'package:flutter_test/flutter_test.dart';
import 'package:qfremote/core/renderer_recovery.dart';
import 'package:qfremote/core/slot_nav.dart';

void main() {
  group('S-027/R-02：每槽一个代次，过期回调一律丢弃', () {
    test('重建即递增代次；各槽代次独立', () {
      final t = RendererRecoveryTracker();
      expect(t.generation(AppSlot.devices), 0);
      final d = t.noteGone(
        AppSlot.devices,
        didCrash: true,
        isForeground: true,
      );
      expect(d, RendererGoneDecision.rebuildNow);
      expect(t.generation(AppSlot.devices), 1);
      expect(t.generation(AppSlot.friends), 0);
    });

    test('同一代内重复回调只重建一次（幂等，R-08）', () {
      final t = RendererRecoveryTracker();
      expect(
        t.noteGone(AppSlot.devices, didCrash: true, isForeground: true),
        RendererGoneDecision.rebuildNow,
      );
      // 恢复中再次回调：丢弃。
      expect(
        t.noteGone(AppSlot.devices, didCrash: true, isForeground: true),
        RendererGoneDecision.ignoreDuplicate,
      );
      expect(t.generation(AppSlot.devices), 1);
    });
  });

  group('S-027/R-08：多槽同死各自重建，后台槽延迟', () {
    test('后台槽只记标记、不立即重建；切回时再建', () {
      final t = RendererRecoveryTracker();
      expect(
        t.noteGone(AppSlot.forum, didCrash: true, isForeground: false),
        RendererGoneDecision.rebuildDeferred,
      );
      expect(t.generation(AppSlot.forum), 0);
      expect(t.needsRecovery(AppSlot.forum), isTrue);
      expect(t.isAlive(AppSlot.forum), isFalse);
      expect(t.beginDeferredRebuild(AppSlot.forum), isTrue);
      expect(t.generation(AppSlot.forum), 1);
      expect(t.needsRecovery(AppSlot.forum), isFalse);
      // 无需重建的槽 beginDeferredRebuild 回 false，不动代次。
      expect(t.beginDeferredRebuild(AppSlot.forum), isFalse);
      expect(t.generation(AppSlot.forum), 1);
    });

    test('多槽同死：各槽独立重建，不重建整个栈', () {
      final t = RendererRecoveryTracker();
      expect(
        t.noteGone(AppSlot.devices, didCrash: true, isForeground: true),
        RendererGoneDecision.rebuildNow,
      );
      expect(
        t.noteGone(AppSlot.friends, didCrash: true, isForeground: false),
        RendererGoneDecision.rebuildDeferred,
      );
      expect(t.generation(AppSlot.devices), 1);
      expect(t.generation(AppSlot.forum), 0);
      expect(t.isAlive(AppSlot.devices), isFalse);
      expect(t.isAlive(AppSlot.friends), isFalse);
    });
  });

  group('S-027/R-05：失败上限与退避', () {
    test('每轮最多 3 次重建，退避立即／5 秒／15 秒；耗尽后停手', () {
      final t = RendererRecoveryTracker();
      final now = DateTime(2026, 11, 15, 22, 0);
      expect(t.state(AppSlot.devices).nextBackoff, Duration.zero);
      for (var i = 0; i < 3; i++) {
        expect(
          t.noteGone(
            AppSlot.devices,
            didCrash: true,
            isForeground: true,
            now: now.add(Duration(seconds: i)),
          ),
          RendererGoneDecision.rebuildNow,
        );
        // 模拟新实例挂载后又死（恢复失败→下一轮）。
        t.noteRecreated(AppSlot.devices);
        t.noteRebuildFailed(AppSlot.devices);
      }
      expect(
        t.state(AppSlot.devices).nextBackoff,
        const Duration(seconds: 15),
      );
      expect(
        t.noteGone(
          AppSlot.devices,
          didCrash: true,
          isForeground: true,
          now: now.add(const Duration(seconds: 99)),
        ),
        RendererGoneDecision.giveUp,
      );
      expect(t.state(AppSlot.devices).attempts, 3);
    });

    test('恢复成功记耗时；手动重试清掉本轮计数', () {
      final t = RendererRecoveryTracker();
      final goneAt = DateTime(2026, 11, 15, 22, 0);
      t.noteGone(
        AppSlot.devices,
        didCrash: true,
        isForeground: true,
        now: goneAt,
      );
      t.noteRecreated(AppSlot.devices);
      t.noteLoadStopped(
        AppSlot.devices,
        now: goneAt.add(const Duration(milliseconds: 1500)),
      );
      expect(t.isRecovering(AppSlot.devices), isFalse);
      expect(t.state(AppSlot.devices).lastRecoveryMs, 1500);
      expect(t.state(AppSlot.devices).lastOutcome, 'recovered');
      t.resetEpisode(AppSlot.devices);
      expect(t.state(AppSlot.devices).attempts, 0);
      expect(t.state(AppSlot.devices).canRetry, isTrue);
    });
  });

  group('S-027/R-10：内存压力分支', () {
    test('didCrash=false 记为系统杀进程（调用方据此先释后台槽）', () {
      final t = RendererRecoveryTracker();
      expect(
        t.noteGone(AppSlot.devices, didCrash: false, isForeground: true),
        RendererGoneDecision.rebuildNow,
      );
      expect(t.state(AppSlot.devices).lastDidCrash, isFalse);
    });
  });

  group('S-027/R-09：诊断日志禁敏感信息', () {
    test('日志含 slot／generation／didCrash／attempt，不含 query 与密码', () {
      final t = RendererRecoveryTracker();
      t.noteGone(AppSlot.devices, didCrash: true, isForeground: true);
      final line = t.describe(
        AppSlot.devices,
        url: 'https://app.qfremote.top/#session/node123?token=secret',
        loginState: 'logged-in',
      );
      expect(line, contains('slot=devices'));
      expect(line, contains('generation=1'));
      expect(line, contains('didCrash=true'));
      expect(line, contains('attempt=1'));
      expect(line, isNot(contains('token=secret')));
      expect(line, isNot(contains('#session/node123')));
    });
  });

  group('S-027/R-04：恢复走既有快照链（本类只约束顺序，不另起一套）', () {
    test('重建后恢复顺序：快照→凭据→停手（次数上限与 AutoLoginController 一致）', () {
      // 恢复顺序本身由 AutoLoginController 的既有单测覆盖
      // （session_recovery_test.dart：先会话恢复最多 2 次，再凭据
      // 静默登录最多 1 次）；此处只锁“重建不绕过次数上限”的策略位：
      // 同一 episode 内重建 3 次即停手，不无限刷恢复。
      final t = RendererRecoveryTracker();
      expect(RendererRecoveryTracker.maxAttemptsPerEpisode, 3);
      expect(RendererRecoveryTracker.backoffSchedule, [
        Duration.zero,
        const Duration(seconds: 5),
        const Duration(seconds: 15),
      ]);
      expect(t.state(AppSlot.devices).canRetry, isTrue);
    });
  });
}
