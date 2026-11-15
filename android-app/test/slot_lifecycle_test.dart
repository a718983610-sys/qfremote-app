import 'package:flutter_test/flutter_test.dart';
import 'package:qfremote/core/slot_lifecycle.dart';
import 'package:qfremote/core/slot_nav.dart';

void main() {
  group('S-032/S-043：槽生命周期四态', () {
    test('初始 home 为 ACTIVE，其余 COLD', () {
      final m = SlotLifecycleManager();
      expect(m.state(AppSlot.home), SlotLifecycleState.active);
      expect(m.state(AppSlot.devices), SlotLifecycleState.cold);
      expect(m.state(AppSlot.friends), SlotLifecycleState.cold);
    });

    test('切槽：原 ACTIVE 退 WARM，最多只留 1 个 WARM', () {
      final m = SlotLifecycleManager();
      // home(ACTIVE) → devices：home 变 WARM。
      var released = m.onActivated(
        AppSlot.devices,
        consoleHasSession: false,
      );
      expect(m.state(AppSlot.devices), SlotLifecycleState.active);
      expect(m.state(AppSlot.home), SlotLifecycleState.warm);
      expect(released, isEmpty);
      // devices → friends：devices 变 WARM，home 降 COLD（只留 1 个 WARM）。
      released = m.onActivated(AppSlot.friends, consoleHasSession: false);
      expect(m.state(AppSlot.friends), SlotLifecycleState.active);
      expect(m.state(AppSlot.devices), SlotLifecycleState.warm);
      expect(m.state(AppSlot.home), SlotLifecycleState.cold);
      expect(released, contains(AppSlot.home));
    });

    test('控制台槽登录／会话态最低只到 WARM，不降 COLD', () {
      final m = SlotLifecycleManager();
      final t0 = DateTime(2026, 11, 15, 22, 0);
      m.onActivated(AppSlot.devices, consoleHasSession: true, now: t0);
      m.onActivated(
        AppSlot.friends,
        consoleHasSession: true,
        now: t0.add(const Duration(minutes: 1)),
      );
      m.onActivated(
        AppSlot.forum,
        consoleHasSession: true,
        now: t0.add(const Duration(minutes: 2)),
      );
      // devices 是更早的 WARM，但登录态保护，不进释放列表、不降 COLD。
      expect(m.state(AppSlot.devices), SlotLifecycleState.warm);
      expect(m.holdsRenderer(AppSlot.devices), isTrue);
    });

    test('WARM 只留 1 个：切到第三槽时更早的 WARM 立即降 COLD', () {
      final m = SlotLifecycleManager();
      final t0 = DateTime(2026, 11, 15, 22, 0);
      m.onActivated(AppSlot.devices, consoleHasSession: false, now: t0);
      expect(m.state(AppSlot.home), SlotLifecycleState.warm);
      // 再切一槽：devices 退 WARM，home 因“只留 1 个 WARM”立即降 COLD
      //（不等 30 分钟；30 分钟规则只针对一直留在 WARM 的那个槽）。
      final released = m.onActivated(
        AppSlot.friends,
        consoleHasSession: false,
        now: t0.add(const Duration(minutes: 1)),
      );
      expect(m.state(AppSlot.home), SlotLifecycleState.cold);
      expect(m.state(AppSlot.devices), SlotLifecycleState.warm);
      expect(released, contains(AppSlot.home));
    });

    test('单槽最长后台驻留 30 分钟：一直留在 WARM 的槽超期降 COLD', () {
      final m = SlotLifecycleManager();
      final t0 = DateTime(2026, 11, 15, 22, 0);
      m.onActivated(AppSlot.devices, consoleHasSession: false, now: t0);
      // home 是唯一 WARM；29 分钟后仍 WARM。
      var released = m.demoteOverdue(
        consoleHasSession: false,
        now: t0.add(const Duration(minutes: 29)),
      );
      expect(m.state(AppSlot.home), SlotLifecycleState.warm);
      expect(released, isEmpty);
      // 31 分钟后超期，降 COLD 进释放列表。
      released = m.demoteOverdue(
        consoleHasSession: false,
        now: t0.add(const Duration(minutes: 31)),
      );
      expect(m.state(AppSlot.home), SlotLifecycleState.cold);
      expect(released, contains(AppSlot.home));
    });

    test('控制台槽未登录时超期同样降 COLD；登录态超期不降', () {
      final m = SlotLifecycleManager();
      final t0 = DateTime(2026, 11, 15, 22, 0);
      m.onActivated(AppSlot.devices, consoleHasSession: false, now: t0);
      m.onActivated(
        AppSlot.friends,
        consoleHasSession: false,
        now: t0.add(const Duration(minutes: 1)),
      );
      // 未登录：devices 超期 → COLD。
      final released = m.demoteOverdue(
        consoleHasSession: false,
        now: t0.add(const Duration(minutes: 32)),
      );
      expect(m.state(AppSlot.devices), SlotLifecycleState.cold);
      expect(released, contains(AppSlot.devices));
      // 登录态：同样超期不降。
      final m2 = SlotLifecycleManager();
      m2.onActivated(AppSlot.devices, consoleHasSession: true, now: t0);
      m2.onActivated(
        AppSlot.friends,
        consoleHasSession: true,
        now: t0.add(const Duration(minutes: 1)),
      );
      final released2 = m2.demoteOverdue(
        consoleHasSession: true,
        now: t0.add(const Duration(minutes: 32)),
      );
      expect(m2.state(AppSlot.devices), SlotLifecycleState.warm);
      expect(released2, isNot(contains(AppSlot.devices)));
    });

    test('DISPOSED 槽重新切入复活为 ACTIVE', () {
      final m = SlotLifecycleManager();
      m.markDisposed(AppSlot.friends);
      expect(m.state(AppSlot.friends), SlotLifecycleState.disposed);
      expect(m.holdsRenderer(AppSlot.friends), isFalse);
      m.onActivated(AppSlot.friends, consoleHasSession: false);
      expect(m.state(AppSlot.friends), SlotLifecycleState.active);
    });

    test('连续切槽 50 次：状态机不崩、最多 1 个 WARM、无 OOM 断言（逻辑层）', () {
      // 真机验收（2/3/4GB 切槽 50 次、后台 30 分钟／锁屏／恢复无 OOM）
      // 列入 11/16 真机窗口；此处只验逻辑层 50 次切换后状态仍合法。
      final m = SlotLifecycleManager();
      const order = [
        AppSlot.home,
        AppSlot.files,
        AppSlot.devices,
        AppSlot.friends,
        AppSlot.forum,
        AppSlot.me,
      ];
      for (var i = 0; i < 50; i++) {
        m.onActivated(order[i % order.length], consoleHasSession: true);
      }
      final warms = AppSlot.values
          .where((s) => m.state(s) == SlotLifecycleState.warm)
          .length;
      // 登录态：控制台槽受保护不降 COLD，故 WARM 上限为 1＋受保护的
      // 控制台槽＝2；未登录时上限为 1。
      expect(warms, lessThanOrEqualTo(2));
      expect(m.state(AppSlot.devices), isNot(SlotLifecycleState.cold));
      final actives = AppSlot.values
          .where((s) => m.state(s) == SlotLifecycleState.active)
          .length;
      expect(actives, 1);
    });
  });
}
