/// 渲染进程崩溃恢复策略（S-027，ANDROID-RENDERER-RECOVERY-PLAN R-02/R-03/
/// R-05/R-08/R-09/R-10）——纯逻辑，可单测，不依赖 WebView。
///
/// 职责边界：
///
/// * 每槽一个 generation：重建即递增，旧代的迟到回调一律丢弃（R-02）。
/// * 重建幂等：同一代内同一槽的 onRenderProcessGone 只重建一次（R-08）。
/// * 失败上限：每轮（episode）最多重建 3 次，退避立即／5 秒／15 秒；
///   耗尽后停手，进离线卡＋手动重试，不无限循环（R-05）。
/// * didCrash=false＝系统因内存不足杀渲染进程：先释放后台槽再重建前台槽，
///   60 秒内再死一次则降级（停后台探针由调用方执行，本类只出信号，R-10）。
/// * 日志字段（R-09）：slot／generation／didCrash／rendererPriorityAtExit／
///   attempt／recoveryMs／outcome；禁写密码、cookie 明文、Key、私钥、
///   文件体、屏幕原图。URL 只记 origin＋path，不记 query（query 可能带
///   会话参数）。
///
/// 真机待验（不谎称已验）：renderer kill 实测、Cookie 存续、多槽共享
/// 渲染进程关系、厂商 ROM 回调可靠性，见 R-12 与 11/16 ECS 真机窗口。
library;

import 'slot_nav.dart';

/// onRenderProcessGone 一次回调的裁决。
enum RendererGoneDecision {
  /// 同一代重复回调／已在恢复中：丢弃，不重建。
  ignoreDuplicate,

  /// 前台槽：立即重建。
  rebuildNow,

  /// 后台槽：只记“需恢复”标记，切回前台时再重建（R-08），不烧探针。
  rebuildDeferred,

  /// 本轮重建次数已耗尽：停手，走离线卡＋手动重试（R-05）。
  giveUp,
}

/// 单槽的渲染进程恢复状态。
class SlotRendererState {
  final AppSlot slot;

  /// 当前代次（R-02）：初始 0，每次重建＋1；槽 widget 的 Key 带此值。
  int generation = 0;

  /// 渲染进程是否存活。onRenderProcessGone 后为 false，新实例
  /// onWebViewCreated 后恢复 true。
  bool alive = true;

  /// 正在重建中（已换 Key、等新实例 onLoadStop）。
  bool recovering = false;

  /// 后台槽死后待切回时重建（R-08）。
  bool needsRecovery = false;

  /// 本轮（episode）已重建次数。
  int attempts = 0;

  /// 本轮开始时间（首次 onRenderProcessGone）。
  DateTime? episodeStartedAt;

  /// 最近一次渲染进程死亡时间。
  DateTime? lastGoneAt;

  /// 最近一次死亡原因（true＝崩溃，false＝系统因内存不足杀掉）。
  bool lastDidCrash = true;

  /// 最近一次死亡时的渲染器优先级（detail.rendererPriorityAtExit 的
  /// toString，不含敏感信息）。
  String? lastPriorityAtExit;

  /// 最近一次恢复耗时（毫秒：死亡 → 新实例 onLoadStop）。
  int? lastRecoveryMs;

  /// 最近一次恢复结果。
  String? lastOutcome;

  SlotRendererState(this.slot);

  /// 本轮还能否再重建（R-05：上限 3 次）。
  bool get canRetry => attempts < RendererRecoveryTracker.maxAttemptsPerEpisode;

  /// 下一次重建的退避（R-05：立即／5 秒／15 秒，按已重建次数取）。
  Duration get nextBackoff {
    const schedule = RendererRecoveryTracker.backoffSchedule;
    final i = attempts.clamp(0, schedule.length - 1);
    return schedule[i];
  }
}

/// 五槽渲染进程恢复总管（每槽独立状态，前台优先、后台延迟、多槽同死
/// 各自重建，禁止一次重建整个 IndexedStack，R-08）。
class RendererRecoveryTracker {
  /// 每轮最多重建次数（R-05 建议值 3，真机实测后可调）。
  static const int maxAttemptsPerEpisode = 3;

  /// 退避表（R-05：立即／5 秒／15 秒）。
  static const List<Duration> backoffSchedule = [
    Duration.zero,
    Duration(seconds: 5),
    Duration(seconds: 15),
  ];

  final Map<AppSlot, SlotRendererState> _states = {
    for (final s in const [
      AppSlot.home,
      AppSlot.files,
      AppSlot.devices,
      AppSlot.friends,
      AppSlot.forum,
    ])
      s: SlotRendererState(s),
  };

  SlotRendererState state(AppSlot slot) => _states[slot]!;

  int generation(AppSlot slot) => _states[slot]!.generation;

  bool isAlive(AppSlot slot) => _states[slot]!.alive;

  bool isRecovering(AppSlot slot) => _states[slot]!.recovering;

  bool needsRecovery(AppSlot slot) => _states[slot]!.needsRecovery;

  /// onRenderProcessGone 入口（R-03/R-05/R-08）。
  ///
  /// [isForeground] 为真＝死掉的是当前前台槽，立即重建；为假＝后台槽，
  /// 只记标记、切回时再建。[now] 可注入（单测用假时钟）。
  RendererGoneDecision noteGone(
    AppSlot slot, {
    required bool didCrash,
    required bool isForeground,
    String? priorityAtExit,
    DateTime? now,
  }) {
    final st = _states[slot]!;
    final at = now ?? DateTime.now();
    // 幂等（R-08）：同一代内重复回调／已在恢复中，直接丢弃。
    if (!st.alive || st.recovering) return RendererGoneDecision.ignoreDuplicate;
    st.alive = false;
    st.lastGoneAt = at;
    st.lastDidCrash = didCrash;
    st.lastPriorityAtExit = priorityAtExit;
    st.episodeStartedAt ??= at;
    // 上限耗尽（R-05）：停手，进离线卡＋手动重试。
    if (!st.canRetry) {
      st.lastOutcome = 'gave-up';
      return RendererGoneDecision.giveUp;
    }
    st.attempts++;
    if (!isForeground) {
      st.needsRecovery = true;
      st.lastOutcome = 'deferred';
      return RendererGoneDecision.rebuildDeferred;
    }
    st.recovering = true;
    st.generation++;
    st.lastOutcome = 'rebuilding';
    return RendererGoneDecision.rebuildNow;
  }

  /// 后台槽切回前台时，把“需恢复”转为一次立即重建（R-08）。
  /// 返回 false＝该槽无需重建（或上限已耗尽，调用方走离线卡）。
  bool beginDeferredRebuild(AppSlot slot, {DateTime? now}) {
    final st = _states[slot]!;
    if (!st.needsRecovery) return false;
    st.needsRecovery = false;
    if (!st.alive && !st.canRetry) {
      st.lastOutcome = 'gave-up';
      return false;
    }
    // needsRecovery 只在死亡后置真，此时 alive 必为 false；若中途已
    // 被别的路径恢复（alive 又为真），不重复重建。
    if (st.alive) return false;
    st.recovering = true;
    st.generation++;
    st.lastOutcome = 'rebuilding';
    return true;
  }

  /// 新实例 onWebViewCreated：控制器已换新，渲染进程恢复存活。
  /// 只清 alive，不清 recovering——恢复耗时要等 onLoadStop 才落定。
  void noteRecreated(AppSlot slot) {
    final st = _states[slot]!;
    st.alive = true;
  }

  /// 新实例 onLoadStop：恢复完成，记恢复耗时（R-05/R-09）。
  void noteLoadStopped(AppSlot slot, {DateTime? now}) {
    final st = _states[slot]!;
    if (!st.recovering) return;
    st.recovering = false;
    final at = now ?? DateTime.now();
    final goneAt = st.lastGoneAt;
    st.lastRecoveryMs = goneAt == null
        ? null
        : at.difference(goneAt).inMilliseconds;
    st.lastOutcome = 'recovered';
  }

  /// 恢复失败（新实例加载报错／超时）：清 recovering，下一次
  /// onRenderProcessGone 会按 attempt 计数继续退避或停手。
  void noteRebuildFailed(AppSlot slot) {
    final st = _states[slot]!;
    st.recovering = false;
    st.lastOutcome = 'failed';
  }

  /// 手动重试／新一轮开始：清掉本轮计数与标记（R-05：上限耗尽后，
  /// 看护与登录循环保持停止，直到用户手动重试或切槽触发新一轮）。
  void resetEpisode(AppSlot slot) {
    final st = _states[slot]!;
    st.attempts = 0;
    st.episodeStartedAt = null;
    st.needsRecovery = false;
    st.recovering = false;
    st.lastOutcome = null;
    st.lastRecoveryMs = null;
    // alive 不动：手动重试时若渲染进程还活着，不必重建。
  }

  /// R-09 结构化日志行（禁敏感信息；URL 只记 origin＋path）。
  String describe(
    AppSlot slot, {
    String? url,
    String? loginState,
  }) {
    final st = _states[slot]!;
    final u = _safeUrl(url);
    return 'QFRenderer slot=${slot.name} generation=${st.generation} '
        'didCrash=${st.lastDidCrash} '
        'priorityAtExit=${st.lastPriorityAtExit ?? '-'} '
        'attempt=${st.attempts} '
        'recoveryMs=${st.lastRecoveryMs?.toString() ?? '-'} '
        'outcome=${st.lastOutcome ?? '-'} '
        'url=$u loginState=${loginState ?? '-'}';
  }

  static String _safeUrl(String? url) {
    if (url == null || url.isEmpty) return '-';
    final uri = Uri.tryParse(url);
    if (uri == null) return '-';
    // 只留 origin＋path；query/fragment 可能带会话参数，一律不记。
    final origin = uri.hasAuthority ? uri.origin : '';
    return '$origin${uri.path}';
  }
}
