import 'dart:async';

import 'package:flutter/material.dart';

import 'theme.dart';

/// Reduced motion 原生层接线（6 项定夺⑤）：对话框与加载动画的取值点。
///
/// 信号源：系统“移除动画”由平台通道经 WidgetsApp 进入
/// MediaQuery.disableAnimations（Flutter 侧投影
/// platformDispatcher.accessibilityFeatures.disableAnimations）。
/// 本文件所有取值点一律读 MediaQuery.disableAnimationsOf(context)，
/// 主题层（QfMotion 常量）只做兜底，不替代本接线。
///
/// 覆盖面：
/// - 对话框：showQfDialog（全仓 showDialog 调用点均已改走本函数）；
/// - 路由转场：QfTheme.pageTransitionsTheme → QfPageTransitionsBuilder；
/// - 显式动效：AnimatedContainer 等走 QfMotion.resolve(context, …)；
/// - 加载动画：QfLoadingIndicator（圆圈）／QfLoadingBar（横条）；
/// - Hero／下拉刷新／骨架：原生层无此部件（聊天骨架在 WebView 网页侧，
///   由网页端 reduced-motion 承接），故无接线点；
/// - 循环／视差／自动播放：原生层无此部件（WebView 内网页内容不由壳
///   控动效），不虚构接线。

/// 对话框路由（F-A1 返工）：RawDialogRoute 的子类，覆写
/// [reverseTransitionDuration] 为 130ms（B §3.3 对话框退出 D2/E-X，
/// 130ms±20）。核实依据（Flutter 3.47.8 SDK
/// `packages/flutter/lib/src/widgets/routes.dart:148-149`）：
/// `TransitionRoute.reverseTransitionDuration` 是虚 getter，默认返回
/// `transitionDuration`，子类覆写即生效——上一轮“无覆写入口”之说
/// 不成立，见返工报告。reduced motion 时进出均为 80ms opacity。
class QfDialogRoute<T> extends RawDialogRoute<T> {
  final bool _reduced;

  QfDialogRoute({
    required super.pageBuilder,
    super.barrierDismissible,
    super.barrierColor,
    super.barrierLabel,
    required bool reduced,
    super.transitionBuilder,
    super.settings,
  })  : _reduced = reduced,
        super(
          transitionDuration:
              reduced ? QfMotion.reducedOpacity : QfMotion.d3,
        );

  @override
  Duration get reverseTransitionDuration =>
      _reduced ? QfMotion.reducedOpacity : QfMotion.dialogExit;
}

/// 对话框（showDialog 的等价封装）：reduced motion 开启时进出时长为
/// 80ms opacity；关闭时进入 D3=170ms、退出 130ms（QfDialogRoute）。
/// B 重做 §3.3：正常态进入 D3=170ms E-S、scale .96＋y+8、opacity；
/// 退出 E-X、scale .98＋y+4；reduced motion 时 80ms opacity、
/// 无 scale/y（B §6.3）。
/// 实现说明：Flutter 3.47.8 的 showDialog 没有 transitionBuilder
/// 参数（DialogRoute 只做 FadeTransition），故直接推 QfDialogRoute
/// 实现 scale＋位移转场；路由类型变化不影响调用方（返回值与 barrier
/// 语义同 showDialog）。
Future<T?> showQfDialog<T>({
  required BuildContext context,
  required WidgetBuilder builder,
  bool barrierDismissible = true,
  Color? barrierColor,
  bool useRootNavigator = true,
}) {
  final reduced = MediaQuery.disableAnimationsOf(context);
  return Navigator.of(context, rootNavigator: useRootNavigator).push<T>(
    QfDialogRoute<T>(
      pageBuilder: (ctx, _, _) => builder(ctx),
      barrierDismissible: barrierDismissible,
      barrierColor: barrierColor ??
          Theme.of(context).dialogTheme.barrierColor ??
          Colors.black54,
      barrierLabel:
          MaterialLocalizations.of(context).modalBarrierDismissLabel,
      reduced: reduced,
      transitionBuilder: reduced
          ? (_, _, _, child) => child
          : (ctx, animation, _, child) {
              final curved = CurvedAnimation(
                parent: animation,
                curve: QfMotion.eS,
                reverseCurve: QfMotion.eX,
              );
              return FadeTransition(
                opacity: curved,
                child: ScaleTransition(
                  scale: Tween<double>(
                    begin: QfMotion.dialogEnterScale,
                    end: 1,
                  ).animate(curved),
                  child: AnimatedBuilder(
                    animation: curved,
                    builder: (_, c) => Transform.translate(
                      offset: Offset(
                        0,
                        QfMotion.dialogEnterOffsetY * (1 - curved.value),
                      ),
                      child: c,
                    ),
                    child: child,
                  ),
                ),
              );
            },
    ),
  );
}

/// Bottom sheet 统一入口（A §3.3：抽屉统一改 bottom sheet——顶部圆角 20、
/// handle 36×4、padding 20；B §3.3：进入 D5/E-L y+32＋scrim，
/// 退出 D3/E-X y+24，拖拽 1:1 跟手、释放 S6，过冲 ≤2dp；
/// reduced motion：80ms opacity、无 spring、释放 instant 吸附）。
/// 面用 BG4（抽屉/模态层），阴影 e2（浮层档）；最大高 90%（C §1.3）。
Future<T?> showQfBottomSheet<T>({
  required BuildContext context,
  required QfPalette palette,
  String? title,
  required WidgetBuilder builder,
  bool isDismissible = true,
  bool enableDrag = true,
}) {
  final reduced = MediaQuery.disableAnimationsOf(context);
  return showModalBottomSheet<T>(
    context: context,
    backgroundColor: palette.bg4,
    barrierColor: palette.scrim,
    isDismissible: isDismissible,
    enableDrag: enableDrag,
    isScrollControlled: true,
    showDragHandle: false,
    constraints: BoxConstraints(
      maxHeight: MediaQuery.of(context).size.height * 0.9,
    ),
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(
        top: Radius.circular(20),
      ),
    ),
    // Flutter 3.47.8 的 showModalBottomSheet 没有 animationStyle 参数，
    // 用 sheetAnimationStyle；reduced motion 时 80ms，正常时走默认
    // sheet 动画（约 250ms，合 B D5）；拖拽释放弹簧由 BottomSheet
    // 内部 fling 承载（S6 语义，见报告）。
    sheetAnimationStyle: reduced
        ? const AnimationStyle(
            duration: Duration(milliseconds: 80),
            reverseDuration: Duration(milliseconds: 80),
          )
        : null,
    builder: (ctx) => Container(
      decoration: BoxDecoration(
        color: palette.bg4,
        borderRadius: const BorderRadius.vertical(top: Radius.circular(20)),
        boxShadow: palette.elevationShadow(2),
      ),
      padding: const EdgeInsets.fromLTRB(20, 12, 20, 20),
      child: SafeArea(
        top: false,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const Center(child: QfSheetHandle()),
            const SizedBox(height: 12),
            if (title != null) ...[
              Text(title, style: QfType.title20(palette.onCard)),
              const SizedBox(height: 12),
            ],
            Flexible(child: builder(ctx)),
          ],
        ),
      ),
    ),
  );
}

/// Bottom sheet 拖拽把手：36×4（A §3.3），三级灰，圆角全圆。
class QfSheetHandle extends StatelessWidget {
  const QfSheetHandle({super.key});

  @override
  Widget build(BuildContext context) {
    final p = QfPalette(
      Theme.of(context).brightness == Brightness.dark
          ? QfThemeMode.dark
          : QfThemeMode.blue,
    );
    return Container(
      width: 36,
      height: 4,
      decoration: BoxDecoration(
        color: p.textTertiary,
        borderRadius: BorderRadius.circular(QfScale.rPill),
      ),
    );
  }
}

/// 列表行入场（B §3.3）：D3/E-S y+8＋opacity，stagger 22ms/项、最多 7 项
/// （第 8 项起 0 延迟，见 QfMotion.staggerFor）；reduced motion 时
/// 80ms opacity、无 y、无 stagger（B §6.3）。只包首屏进入的行，
/// 滚动中出现的新行不播（离屏停播）。
/// [duration]/[offsetY] 可覆写：空状态入场用 D4/E-S y+8（F-A6），
/// 其余调用点默认 D3 y+8 不变。
class QfAnimatedEntry extends StatefulWidget {
  final Widget child;
  final int index;
  final Duration duration;
  final double offsetY;

  const QfAnimatedEntry({
    super.key,
    required this.child,
    this.index = 0,
    this.duration = QfMotion.d3,
    this.offsetY = QfMotion.rowEnterOffsetY,
  });

  @override
  State<QfAnimatedEntry> createState() => _QfAnimatedEntryState();
}

class _QfAnimatedEntryState extends State<QfAnimatedEntry>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller;
  late final Animation<double> _animation;
  bool _reduced = false;
  Timer? _delayTimer;

  @override
  void initState() {
    super.initState();
    _controller =
        AnimationController(vsync: this, duration: widget.duration);
    _animation = CurvedAnimation(parent: _controller, curve: QfMotion.eS);
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _reduced = MediaQuery.disableAnimationsOf(context);
    _controller.duration =
        _reduced ? QfMotion.reducedOpacity : widget.duration;
    final delay = QfMotion.staggerFor(context, widget.index);
    _delayTimer?.cancel();
    if (delay == Duration.zero) {
      _controller.forward();
    } else {
      _delayTimer = Timer(delay, () {
        if (mounted) _controller.forward();
      });
    }
  }

  @override
  void dispose() {
    _delayTimer?.cancel();
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _animation,
      builder: (_, child) {
        final v = _animation.value;
        final opacity = Opacity(opacity: v, child: child);
        if (_reduced) return opacity;
        return Transform.translate(
          offset: Offset(0, widget.offsetY * (1 - v)),
          child: opacity,
        );
      },
      child: widget.child,
    );
  }
}

/// 加载阶段状态（C §2.2）：等待／进行／完成／失败。
enum QfStageState { waiting, active, done, failed }

/// 一个加载阶段：标签＋状态＋进行中已用时间（秒，调用方实测传入）。
class QfStage {
  final String label;
  final QfStageState state;
  final double? elapsedSeconds;

  const QfStage(this.label, this.state, {this.elapsedSeconds});
}

/// 阶段加载（C §2.2，不用大转圈）：顶部 2px 进度线＋百分比（tabular）＋
/// 阶段列表（等待/进行/完成/失败，进行中显示已用时间如 `1.8 s`）＋
/// 超时恢复（调用方在 8s 无进展／15s 总超时时传入 onRetry/onCopyLog，
/// 本件只渲染传入的恢复入口，不自己计时、不编造阶段）。
/// 百分比与阶段一律由调用方状态机传入；无数据时百分比显示 —。
class QfStageLoading extends StatelessWidget {
  final QfPalette palette;
  final List<QfStage> stages;
  final int? percent;
  final VoidCallback? onRetry;
  final VoidCallback? onCopyLog;
  final String? timeoutNote;

  const QfStageLoading({
    super.key,
    required this.palette,
    required this.stages,
    this.percent,
    this.onRetry,
    this.onCopyLog,
    this.timeoutNote,
  });

  @override
  Widget build(BuildContext context) {
    final p = palette;
    final reduced = MediaQuery.disableAnimationsOf(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        Row(
          children: [
            Expanded(
              child: ClipRRect(
                borderRadius: BorderRadius.circular(2),
                child: QfLoadingBar(
                  value: percent == null ? null : percent! / 100,
                  minHeight: 2,
                  backgroundColor: p.cardBorder,
                  color: p.brand,
                ),
              ),
            ),
            const SizedBox(width: 12),
            Text(
              percent == null ? '—' : '$percent%',
              style: QfType.tabular(QfType.meta12(p.textSecondary)),
            ),
          ],
        ),
        const SizedBox(height: 16),
        for (final s in stages) ...[
          Row(
            children: [
              SizedBox(
                width: 16,
                child: s.state == QfStageState.active && !reduced
                    ? SizedBox(
                        width: 12,
                        height: 12,
                        child: QfLoadingIndicator(
                          color: p.brand,
                          strokeWidth: 2,
                        ),
                      )
                    : Icon(
                        s.state == QfStageState.done
                            ? Icons.check
                            : s.state == QfStageState.failed
                                ? Icons.close
                                : Icons.circle_outlined,
                        size: 12,
                        color: s.state == QfStageState.done
                            ? p.success
                            : s.state == QfStageState.failed
                                ? p.danger
                                : p.textTertiary,
                      ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Text(s.label, style: QfType.body14(p.onCard)),
              ),
              if (s.state == QfStageState.active &&
                  s.elapsedSeconds != null)
                Text(
                  '${s.elapsedSeconds!.toStringAsFixed(1)} s',
                  style: QfType.tabular(QfType.meta12(p.textSecondary)),
                ),
            ],
          ),
          const SizedBox(height: 8),
        ],
        if (timeoutNote != null) ...[
          const SizedBox(height: 8),
          Text(timeoutNote!, style: QfType.meta12(p.textSecondary)),
        ],
        if (onRetry != null || onCopyLog != null) ...[
          const SizedBox(height: 12),
          Row(
            children: [
              if (onRetry != null)
                QfButtonTapTarget(
                  child: OutlinedButton(
                    onPressed: onRetry,
                    child: const Text('重试'),
                  ),
                ),
              if (onRetry != null && onCopyLog != null)
                const SizedBox(width: 8),
              if (onCopyLog != null)
                QfButtonTapTarget(
                  child: TextButton(
                    onPressed: onCopyLog,
                    child: const Text('复制日志'),
                  ),
                ),
            ],
          ),
        ],
      ],
    );
  }
}

/// 加载圆圈（F-A4 返工）：正常态旋转周期 900ms linear（B §3.3）——
/// `CircularProgressIndicator` 默认不定值旋转周期不可控，故改用
/// 900ms 线性重复的 RotationTransition 驱动一段定值弧线（value 0.25，
/// 即 1/4 圈弧）；reduced motion 开启时改定值弧线（value 0.5，不转）。
/// 定值弧线只是“正在加载”的静态示意，不冒充进度。
class QfLoadingIndicator extends StatefulWidget {
  final Color? color;
  final double? strokeWidth;

  const QfLoadingIndicator({super.key, this.color, this.strokeWidth});

  @override
  State<QfLoadingIndicator> createState() => _QfLoadingIndicatorState();
}

class _QfLoadingIndicatorState extends State<QfLoadingIndicator>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller;

  @override
  void initState() {
    super.initState();
    // B §3.3：spinner 900ms linear（一圈 900ms，匀速）。
    _controller = AnimationController(
      vsync: this,
      duration: QfMotion.spinnerPeriod,
    )..repeat();
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (MediaQuery.disableAnimationsOf(context)) {
      return CircularProgressIndicator(
        value: 0.5,
        color: widget.color,
        strokeWidth: widget.strokeWidth ?? 4.0,
      );
    }
    return RotationTransition(
      turns: _controller,
      child: CircularProgressIndicator(
        value: 0.25,
        color: widget.color,
        strokeWidth: widget.strokeWidth ?? 4.0,
      ),
    );
  }
}

/// 加载横条：value 已知（下载进度）时原样透传——进度变化是内容本身，
/// 不是装饰动效；value 为空（总量未知的不定条）且 reduced motion 开启
/// 时改定值 0（空轨静止，不转、不冒充一半进度）。
class QfLoadingBar extends StatelessWidget {
  final double? value;
  final Color? color;
  final Color? backgroundColor;
  final double? minHeight;

  const QfLoadingBar({
    super.key,
    this.value,
    this.color,
    this.backgroundColor,
    this.minHeight,
  });

  @override
  Widget build(BuildContext context) {
    final reduced = MediaQuery.disableAnimationsOf(context);
    return LinearProgressIndicator(
      value: reduced && value == null ? 0 : value,
      color: color,
      backgroundColor: backgroundColor,
      minHeight: minHeight,
    );
  }
}
