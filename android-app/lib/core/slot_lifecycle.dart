/// 槽生命周期（S-032＋S-043，第三份审查 P2-13）——纯逻辑，可单测。
///
/// 四态：
///
/// * ACTIVE——当前前台槽：探针全开，渲染进程工作。
/// * WARM——最近一个可恢复的后台槽：渲染进程保留、探针停（R-07 守卫），
///   切回即用。最多只留 1 个 WARM（最近切走的那个）；更早的 WARM 降 COLD。
/// * COLD——其余后台槽：只保留必要 URL／state，渲染进程已释放
///   （由调用方对控制器 load about:blank 实现），切回时按需重载。
/// * DISPOSED——已放弃：渲染进程死亡且重建上限耗尽（R-05 give-up），
///   或调用方明确丢弃；须用户手动重试或重新切入才回到 ACTIVE。
///
/// 内存预算口径（诚实说明）：字节级总预算须 2/3/4GB 真机实测后才能定数，
/// 本线不凭空编 MB 数。预算以“槽数＋驻留时长”执行：最多 1 个 WARM 槽
/// 持有后台渲染进程、其余一律 COLD；单槽最长后台驻留 30 分钟，超期即
/// 降 COLD。验收“2/3/4GB 切槽 50 次、后台 30 分钟／锁屏／恢复无 OOM”
/// 列入 11/16 真机窗口，本线只做逻辑＋单测，不谎称已真机验。
///
/// 控制台槽（devices）例外：登录态／会话进行中时最低只到 WARM，
/// 绝不因切槽或超期被降 COLD（会话与登录恢复链挂在它上面）；未登录时
/// 可正常降 COLD。
library;

import 'slot_nav.dart';

/// 槽生命周期四态（S-032/S-043）。
enum SlotLifecycleState { active, warm, cold, disposed }

/// 槽生命周期管理器：切槽时推进状态，超期后台槽降级。
class SlotLifecycleManager {
  /// 最多保留的 WARM 槽数（S-043：后台只留最近一个可恢复槽）。
  static const int maxWarmSlots = 1;

  /// 单槽最大后台驻留时长（S-032/S-043）：超期即降 COLD。
  static const Duration maxBackgroundResidency = Duration(minutes: 30);

  /// 有渲染进程的槽（“我的”原生页无 WebView，不参与渲染进程管理，
  /// 但参与前台／后台状态流转以便统一计时）。
  static const List<AppSlot> webSlots = [
    AppSlot.home,
    AppSlot.files,
    AppSlot.devices,
    AppSlot.friends,
    AppSlot.forum,
  ];

  final Map<AppSlot, SlotLifecycleState> _states = {
    for (final s in AppSlot.values) s: SlotLifecycleState.cold,
  };
  final Map<AppSlot, DateTime> _backgroundedAt = {};

  SlotLifecycleManager() {
    _states[AppSlot.home] = SlotLifecycleState.active;
  }

  SlotLifecycleState state(AppSlot slot) => _states[slot]!;

  /// 切入 [slot]：返回本次应释放渲染进程（降 COLD）的槽列表，
  /// 调用方对其中每个槽的控制器 load about:blank 并使该槽重载失效。
  ///
  /// [consoleHasSession] 为真＝控制台槽处于登录／会话态，最低只到
  /// WARM，不进释放列表。[now] 可注入（单测用假时钟）。
  List<AppSlot> onActivated(
    AppSlot slot, {
    required bool consoleHasSession,
    DateTime? now,
  }) {
    final at = now ?? DateTime.now();
    final released = <AppSlot>[];
    // 1. 超期后台槽先降级（WARM 且驻留超 30 分钟 → COLD）。
    released.addAll(
      demoteOverdue(consoleHasSession: consoleHasSession, now: at),
    );
    // 2. 原 ACTIVE 槽退到后台。
    for (final s in AppSlot.values) {
      if (s != slot && _states[s] == SlotLifecycleState.active) {
        _states[s] = SlotLifecycleState.warm;
        _backgroundedAt[s] = at;
      }
    }
    // 3. WARM 只留最近一个（maxWarmSlots=1）：更早的 WARM → COLD。
    final warms = AppSlot.values
        .where((s) => _states[s] == SlotLifecycleState.warm)
        .toList();
    // 按切走时间排序，最近的留 WARM，其余降 COLD。无时间戳的按枚举序兜底。
    warms.sort((a, b) {
      final ta = _backgroundedAt[a];
      final tb = _backgroundedAt[b];
      if (ta == null && tb == null) return 0;
      if (ta == null) return 1;
      if (tb == null) return -1;
      return tb.compareTo(ta);
    });
    for (var i = maxWarmSlots; i < warms.length; i++) {
      final s = warms[i];
      if (s == AppSlot.devices && consoleHasSession) continue;
      _states[s] = SlotLifecycleState.cold;
      _backgroundedAt.remove(s);
      if (webSlots.contains(s)) released.add(s);
    }
    // 4. 目标槽回到 ACTIVE（DISPOSED 槽重新切入同样复活）。
    _states[slot] = SlotLifecycleState.active;
    _backgroundedAt.remove(slot);
    return released;
  }

  /// 超期降级：返回应释放渲染进程的槽（调用方执行释放）。
  List<AppSlot> demoteOverdue({
    required bool consoleHasSession,
    DateTime? now,
  }) {
    final at = now ?? DateTime.now();
    final released = <AppSlot>[];
    for (final s in AppSlot.values) {
      if (_states[s] != SlotLifecycleState.warm) continue;
      final since = _backgroundedAt[s];
      if (since == null) continue;
      if (at.difference(since) < maxBackgroundResidency) continue;
      // 控制台槽登录／会话态不降 COLD。
      if (s == AppSlot.devices && consoleHasSession) continue;
      _states[s] = SlotLifecycleState.cold;
      _backgroundedAt.remove(s);
      if (webSlots.contains(s)) released.add(s);
    }
    return released;
  }

  /// 槽被放弃（渲染进程死亡且重建上限耗尽，R-05 give-up）：标 DISPOSED。
  void markDisposed(AppSlot slot) {
    _states[slot] = SlotLifecycleState.disposed;
    _backgroundedAt.remove(slot);
  }

  /// 后台槽是否还持有渲染进程（ACTIVE／WARM 持有，COLD／DISPOSED 不持有）。
  bool holdsRenderer(AppSlot slot) {
    final s = _states[slot]!;
    return s == SlotLifecycleState.active || s == SlotLifecycleState.warm;
  }
}
