import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

/// A-08 自适应三档断点＋状态机＋返回键历史模型
/// （Gallery `adaptive.dart` + `_resolveState` / Invoice Ninja 600px 断点）。
///
/// 全 App 只用这里的两个集中判断函数，不要各页面自己算断点。
/// 三档：
/// - [QfLayoutKind.compact]（<600px）：手机单栏，底部 NavigationBar。
/// - [QfLayoutKind.medium]（600–840px）：平板，左侧 NavigationRail。
/// - [QfLayoutKind.expanded]（>840px）：桌面/大平板双栏（列表＋详情同屏）。
enum QfLayoutKind { compact, medium, expanded }

QfLayoutKind layoutKindForWidth(double width) {
  if (width < 600) return QfLayoutKind.compact;
  if (width <= 840) return QfLayoutKind.medium;
  return QfLayoutKind.expanded;
}

bool isDisplayDesktop(BuildContext context) =>
    layoutKindForWidth(MediaQuery.sizeOf(context).width) ==
    QfLayoutKind.expanded;

bool isDisplayFoldable(BuildContext context) {
  final size = MediaQuery.sizeOf(context);
  // 折叠屏展开态：宽高比接近方屏且宽度进 medium/expanded 档。
  final ratio = size.width / size.height;
  return ratio > 0.85 && ratio < 1.25 && size.width >= 600;
}

/// 页面形态状态机（Gallery `demo.dart` 的 `_resolveState()` 写法）：
/// 按档位定义允许的页面形态，窗口尺寸/折叠状态变化时自动切态，
/// 而不是等用户手动切。
enum QfPageForm {
  /// 单栏全屏（如手机上的远程桌面页只允许全屏会话）。
  single,

  /// 左右分栏（列表＋详情同屏，仅 medium/expanded 允许）。
  twoPane,

  /// 全屏会话（远程桌面进行态）。
  fullScreen,
}

QfPageForm resolvePageForm(QfLayoutKind kind, {required bool inSession}) {
  if (inSession) return QfPageForm.fullScreen;
  switch (kind) {
    case QfLayoutKind.compact:
      return QfPageForm.single;
    case QfLayoutKind.medium:
    case QfLayoutKind.expanded:
      return QfPageForm.twoPane;
  }
}

/// 返回键历史模型（Invoice Ninja `nav_history_controller.dart` 模式）：
/// Android 返回键接历史回退（Back），pane 内“←”做结构 Up，两者绝不混淆；
/// 对话框/抽屉/编辑页先消费返回事件。
class NavHistoryController extends ChangeNotifier {
  NavHistoryController();

  final List<String> _stack = [];

  List<String> get stack => List.unmodifiable(_stack);

  String? get current => _stack.isEmpty ? null : _stack.last;

  void push(String route) {
    _stack.add(route);
    notifyListeners();
  }

  /// Back：历史回退。栈空时返回 false（交给系统处理，即退出应用）。
  bool handleBack() {
    if (_stack.length <= 1) return false;
    _stack.removeLast();
    notifyListeners();
    return true;
  }

  /// Up：结构回退（pane 内“←”）：回到逻辑父级，与历史栈无关。
  /// 返回父级路由；无父级时返回 null。
  String? upTarget(String currentRoute) {
    final idx = currentRoute.lastIndexOf('/');
    if (idx <= 0) return null;
    return currentRoute.substring(0, idx);
  }

  void clear() {
    _stack.clear();
    notifyListeners();
  }
}

/// 切槽时往历史栈记一笔（纯逻辑，可单测；A-07 接线）：
/// 目标与当前相同不记；栈空时先压入当前槽（种子），再压入目标槽，
/// 这样返回键总能回到上一个槽，而不是无路可退。
void recordSlotVisit(
  NavHistoryController history, {
  required String from,
  required String to,
}) {
  if (from == to) return;
  if (history.stack.isEmpty) history.push(from);
  history.push(to);
}

/// 返回键拦截门（配合 [NavHistoryController] 用）：
/// 先让对话框/抽屉/编辑页消费，再走历史回退。
class SystemBackGate extends StatelessWidget {
  const SystemBackGate({
    super.key,
    required this.history,
    required this.child,
    this.onIntercept,
    this.onFallback,
  });

  final NavHistoryController history;
  final Widget child;

  /// 优先拦截器（如抽屉开着/对话框开着时返回 true 表示已消费）。
  final bool Function()? onIntercept;

  /// 历史耗尽后的兜底（未提供时退应用，见下）。
  /// 壳用它接原返回键分级逻辑（页内后退→回设备槽→退出）。
  final Future<void> Function()? onFallback;

  @override
  Widget build(BuildContext context) {
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) {
        if (didPop) return;
        if (onIntercept != null && onIntercept!()) return;
        if (history.handleBack()) return;
        if (onFallback != null) {
          unawaited(onFallback!());
        } else {
          // 无兜底时退应用。注意：绝不能在这里调 Navigator.maybePop()——
          // 本 PopScope 的 canPop:false 会再次否决并重触发 onPopInvoked，
          // 造成无限循环（实测 widget 测试 2 分钟挂住）。
          unawaited(SystemNavigator.pop());
        }
      },
      child: child,
    );
  }
}
