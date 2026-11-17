import 'package:flutter/material.dart';

import '../core/slot_nav.dart';
import 'core/adaptive.dart';
import 'frame.dart';
import 'theme.dart';

/// A-07 自适应壳（接线层）：三档断点切态＋返回键历史模型。
///
/// 形态（[QfPageForm]，由 [resolvePageForm] 集中判定）：
/// - single（compact，<600px）：手机单栏，顶部栏＋底部 [QfTabBar]。
/// - twoPane（medium/expanded，≥600px）：左侧 [NavigationRail]＋内容区；
///   expanded（>840px）时 rail 展开带文字标签，medium 时只显示图标＋
///   选中项标签。twoPane 的“双栏”在壳这一层指 rail＋内容区；壳内是
///   WebView 控制台，宽视口下网页自己渲染列表＋详情双栏（真机平板／
///   横屏复核，见 WIRING-R1-ADAPTIVE.md）；原生列表＋详情双栏属
///   #2 设备列表原生页的接线范围，不在本线。
/// - fullScreen（会话进行态）：不出任何导航铬，只出内容。
///
/// 未登录（[chromeVisible] 为 false）时也不出任何导航铬：登录页在
/// 设备槽 WebView 内，框架 chrome 未出现前不许切槽。
///
/// 返回键：历史回退由 [NavHistoryController] 驱动——本壳监听历史栈，
/// 只有栈缩短（即一次回退）时才按栈顶切槽；压栈（前进）不触发切槽，
/// 调用方切槽时已自行 setState，重复切槽会把回退当场抵消。
class QfAdaptiveShell extends StatefulWidget {
  const QfAdaptiveShell({
    super.key,
    required this.kind,
    required this.form,
    required this.history,
    required this.active,
    required this.onSelect,
    required this.palette,
    required this.chromeVisible,
    required this.header,
    required this.content,
    required this.tabBar,
  });

  /// 当前档位（[layoutKindForWidth] 集中判定）。
  final QfLayoutKind kind;

  /// 当前页面形态（[resolvePageForm] 集中判定）。
  final QfPageForm form;

  /// 返回键历史模型（与 [SystemBackGate] 共用同一实例）。
  final NavHistoryController history;

  /// 当前前台槽。
  final AppSlot active;

  /// 切槽回调；[recordHistory] 为 false 时只切槽不记历史
  /// （历史回退路径用）。
  final void Function(AppSlot slot, {bool recordHistory}) onSelect;

  final QfPalette palette;

  /// 框架 chrome 是否可见（未登录时 false）。
  final bool chromeVisible;

  /// 顶部栏（含看护状态行；fullScreen／未登录时不展示）。
  final Widget header;

  /// 槽内容（AnimatedSwitcher＋_SlotStack；壳负责包 Expanded）。
  final Widget content;

  /// 底部标签栏（仅 single 形态展示）。
  final QfTabBar tabBar;

  @override
  State<QfAdaptiveShell> createState() => _QfAdaptiveShellState();
}

/// 底部栏同款四槽（好友／论坛无标签位，走首页内链与顶栏菜单可达，
/// 与 [QfTabBar] 一致）。
const List<AppSlot> _railSlots = <AppSlot>[
  AppSlot.home,
  AppSlot.files,
  AppSlot.devices,
  AppSlot.me,
];

AppSlot? _slotForHistoryName(String name) {
  for (final slot in AppSlot.values) {
    if (slot.name == name) return slot;
  }
  return null;
}

class _QfAdaptiveShellState extends State<QfAdaptiveShell> {
  int _lastHistoryLength = 0;

  @override
  void initState() {
    super.initState();
    _lastHistoryLength = widget.history.stack.length;
    widget.history.addListener(_onHistoryChanged);
  }

  @override
  void didUpdateWidget(QfAdaptiveShell oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.history != widget.history) {
      oldWidget.history.removeListener(_onHistoryChanged);
      _lastHistoryLength = widget.history.stack.length;
      widget.history.addListener(_onHistoryChanged);
    }
  }

  @override
  void dispose() {
    widget.history.removeListener(_onHistoryChanged);
    super.dispose();
  }

  /// 只有栈缩短（一次回退）时才按栈顶切槽；压栈（前进）不触发——
  /// 调用方切槽时已自行 setState，重复切槽会把回退当场抵消。
  /// clear() 后栈顶为空时不切槽（退出登录时历史已清，登录页在设备槽）。
  void _onHistoryChanged() {
    final length = widget.history.stack.length;
    if (length >= _lastHistoryLength) {
      _lastHistoryLength = length;
      return;
    }
    _lastHistoryLength = length;
    final top = widget.history.current;
    if (top == null) return;
    final slot = _slotForHistoryName(top);
    if (slot == null || slot == widget.active) return;
    widget.onSelect(slot, recordHistory: false);
  }

  @override
  Widget build(BuildContext context) {
    // 会话进行态或未登录：不出任何导航铬，只出内容。
    // crossAxisAlignment.stretch：松约束下 Column 也撑满宽（不依赖
    // 内容自身的固有尺寸，全屏态的 WebView 不必自己撑宽）。
    if (!widget.chromeVisible || widget.form == QfPageForm.fullScreen) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [Expanded(child: widget.content)],
      );
    }
    switch (widget.form) {
      case QfPageForm.single:
        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            widget.header,
            Expanded(child: widget.content),
            widget.tabBar,
          ],
        );
      case QfPageForm.twoPane:
        return Row(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            _buildRail(context),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  widget.header,
                  Expanded(child: widget.content),
                ],
              ),
            ),
          ],
        );
      case QfPageForm.fullScreen:
        // 已在上方统一处理（!chromeVisible || fullScreen），此处不可达。
        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [Expanded(child: widget.content)],
        );
    }
  }

  NavigationRail _buildRail(BuildContext context) {
    // expanded（>840px）展开带文字标签；medium 只图标＋选中项标签。
    // isDisplayDesktop 与 kind 同源（都是 layoutKindForWidth 的
    // expanded 判定），这里用它作展开开关。
    final extended = isDisplayDesktop(context);
    final selectedIndex = _railSlots.indexOf(widget.active);
    return NavigationRail(
      extended: extended,
      selectedIndex: selectedIndex < 0 ? null : selectedIndex,
      onDestinationSelected: (index) =>
          widget.onSelect(_railSlots[index], recordHistory: true),
      backgroundColor: widget.palette.cardColor,
      indicatorColor: widget.palette.tabPill,
      selectedIconTheme: IconThemeData(color: widget.palette.brand),
      unselectedIconTheme: IconThemeData(color: widget.palette.textTertiary),
      selectedLabelTextStyle: QfType.label12(
        widget.palette.brand,
        w: FontWeight.w600,
      ),
      unselectedLabelTextStyle: QfType.label12(
        widget.palette.textTertiary,
        w: FontWeight.w500,
      ),
      labelType: extended
          // extended 时 labelType 只能为 null/none（框架断言），
          // 标签由展开态本身展示。
          ? null
          : NavigationRailLabelType.selected,
      destinations: const [
        NavigationRailDestination(
          icon: Icon(Icons.home_outlined),
          selectedIcon: Icon(Icons.home),
          label: Text('首页'),
        ),
        NavigationRailDestination(
          icon: Icon(Icons.folder_outlined),
          selectedIcon: Icon(Icons.folder),
          label: Text('文件'),
        ),
        NavigationRailDestination(
          icon: Icon(Icons.monitor_outlined),
          selectedIcon: Icon(Icons.monitor),
          label: Text('设备'),
        ),
        NavigationRailDestination(
          icon: Icon(Icons.person_outline),
          selectedIcon: Icon(Icons.person),
          label: Text('我的'),
        ),
      ],
    );
  }
}
