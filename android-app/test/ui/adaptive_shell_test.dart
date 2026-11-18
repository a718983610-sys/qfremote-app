import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:qfremote/core/slot_nav.dart';
import 'package:qfremote/ui/adaptive_shell.dart';
import 'package:qfremote/ui/core/adaptive.dart';
import 'package:qfremote/ui/frame.dart';
import 'package:qfremote/ui/theme.dart';

/// A-07 接线测试：三档断点切态＋返回键历史模型。
///
/// 覆盖：QfAdaptiveShell 在 compact/medium/expanded/fullScreen/未登录
/// 五态下的导航铬切换；历史监听只在栈缩短时切槽；recordSlotVisit
/// 记账规则；SystemBackGate 的拦截／回退／兜底三级。
/// 不覆盖：真机平板／横屏观感与 rail 实际手感（待 ECS 真机验）。

final _palette = QfPalette(QfThemeMode.light);

const _headerKey = Key('shell-header');
const _contentKey = Key('shell-content');

Future<void> _pumpShell(
  WidgetTester tester, {
  required Size size,
  required QfLayoutKind kind,
  required QfPageForm form,
  required NavHistoryController history,
  AppSlot active = AppSlot.devices,
  bool chromeVisible = true,
  void Function(AppSlot slot, {bool recordHistory})? onSelect,
}) async {
  tester.view.physicalSize = size;
  tester.view.devicePixelRatio = 1.0;
  addTearDown(() {
    tester.view.resetPhysicalSize();
    tester.view.resetDevicePixelRatio();
  });
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: QfAdaptiveShell(
          kind: kind,
          form: form,
          history: history,
          active: active,
          onSelect: onSelect ?? (_, {bool recordHistory = true}) {},
          palette: _palette,
          chromeVisible: chromeVisible,
          header: const SizedBox(key: _headerKey, height: 48),
          content: const SizedBox(key: _contentKey),
          tabBar: QfTabBar(
              palette: _palette, active: active, onSelect: (_) {}),
        ),
      ),
    ),
  );
  await tester.pump();
}

void main() {
  group('recordSlotVisit（纯逻辑）', () {
    test('目标与当前相同不记', () {
      final history = NavHistoryController();
      recordSlotVisit(history, from: 'home', to: 'home');
      expect(history.stack, isEmpty);
    });

    test('栈空时先压当前槽再压目标槽', () {
      final history = NavHistoryController();
      recordSlotVisit(history, from: 'home', to: 'files');
      expect(history.stack, ['home', 'files']);
    });

    test('栈非空时只追加目标槽', () {
      final history = NavHistoryController();
      recordSlotVisit(history, from: 'home', to: 'files');
      recordSlotVisit(history, from: 'files', to: 'devices');
      expect(history.stack, ['home', 'files', 'devices']);
    });

    test('回退后新前进只追加，不恢复旧分支', () {
      final history = NavHistoryController();
      recordSlotVisit(history, from: 'home', to: 'files');
      recordSlotVisit(history, from: 'files', to: 'devices');
      expect(history.handleBack(), isTrue);
      expect(history.current, 'files');
      recordSlotVisit(history, from: 'files', to: 'forum');
      expect(history.stack, ['home', 'files', 'forum']);
    });
  });

  group('QfAdaptiveShell 三档切态', () {
    testWidgets('compact 单栏：底部栏＋顶栏，内容占满余宽', (tester) async {
      await _pumpShell(
        tester,
        size: const Size(360, 800),
        kind: QfLayoutKind.compact,
        form: QfPageForm.single,
        history: NavHistoryController(),
      );
      expect(find.byType(QfTabBar), findsOneWidget);
      expect(find.byType(NavigationRail), findsNothing);
      expect(find.byKey(_headerKey), findsOneWidget);
      final content = tester.getRect(find.byKey(_contentKey));
      expect(content.left, 0);
      expect(content.right, 360);
      expect(content.top, 48);
      // 底部栏高 64（QfScale.bottomTabItemHeight，测试内底 inset 为 0）。
      expect(content.bottom, 800 - 64);
      expect(tester.takeException(), isNull);
    });

    testWidgets('medium 双栏：左侧 rail（不展开）＋内容区，点 rail 切槽',
        (tester) async {
      final calls = <(AppSlot, bool)>[];
      await _pumpShell(
        tester,
        size: const Size(800, 1280),
        kind: QfLayoutKind.medium,
        form: QfPageForm.twoPane,
        history: NavHistoryController(),
        onSelect: (slot, {bool recordHistory = true}) =>
            calls.add((slot, recordHistory)),
      );
      expect(find.byType(NavigationRail), findsOneWidget);
      expect(
          tester.widget<NavigationRail>(find.byType(NavigationRail)).extended,
          isFalse);
      expect(find.byType(QfTabBar), findsNothing);
      final rail = tester.getRect(find.byType(NavigationRail));
      expect(rail.left, 0);
      expect(rail.width, 80);
      expect(rail.top, 0);
      expect(rail.bottom, 1280);
      final content = tester.getRect(find.byKey(_contentKey));
      expect(content.left, 80);
      expect(content.right, 800);
      // 顶栏在内容区（rail 右侧），不跨 rail。
      expect(tester.getRect(find.byKey(_headerKey)).left, 80);
      // 未展开时只显示选中项标签（当前槽 devices）；未选中项的标签
      // 仍在树内（透明度 0，框架行为），不做 findsNothing 断言。
      expect(find.text('设备'), findsOneWidget);
      // 点 rail 文件图标切槽，记历史。
      await tester.tap(find.byIcon(Icons.folder_outlined));
      await tester.pump();
      expect(calls, [(AppSlot.files, true)]);
      expect(tester.takeException(), isNull);
    });

    testWidgets('expanded 双栏：rail 展开带全部标签，内容区左界 256',
        (tester) async {
      final calls = <(AppSlot, bool)>[];
      await _pumpShell(
        tester,
        size: const Size(1280, 800),
        kind: QfLayoutKind.expanded,
        form: QfPageForm.twoPane,
        history: NavHistoryController(),
        onSelect: (slot, {bool recordHistory = true}) =>
            calls.add((slot, recordHistory)),
      );
      final railWidget =
          tester.widget<NavigationRail>(find.byType(NavigationRail));
      expect(railWidget.extended, isTrue);
      expect(find.byType(QfTabBar), findsNothing);
      expect(tester.getRect(find.byType(NavigationRail)).width, 256);
      final content = tester.getRect(find.byKey(_contentKey));
      expect(content.left, 256);
      expect(content.right, 1280);
      for (final label in ['首页', '文件', '设备', '我的']) {
        expect(find.text(label), findsOneWidget);
      }
      await tester.tap(find.text('文件'));
      await tester.pump();
      expect(calls, [(AppSlot.files, true)]);
      expect(tester.takeException(), isNull);
    });

    testWidgets('fullScreen：不出任何导航铬，只出内容', (tester) async {
      await _pumpShell(
        tester,
        size: const Size(360, 800),
        kind: QfLayoutKind.compact,
        form: QfPageForm.fullScreen,
        history: NavHistoryController(),
      );
      expect(find.byType(QfTabBar), findsNothing);
      expect(find.byType(NavigationRail), findsNothing);
      expect(find.byKey(_headerKey), findsNothing);
      final content = tester.getRect(find.byKey(_contentKey));
      expect(content.left, 0);
      expect(content.right, 360);
      expect(content.top, 0);
      expect(content.bottom, 800);
      expect(tester.takeException(), isNull);
    });

    testWidgets('未登录：不出任何导航铬，只出内容', (tester) async {
      await _pumpShell(
        tester,
        size: const Size(800, 1280),
        kind: QfLayoutKind.medium,
        form: QfPageForm.twoPane,
        history: NavHistoryController(),
        chromeVisible: false,
      );
      expect(find.byType(QfTabBar), findsNothing);
      expect(find.byType(NavigationRail), findsNothing);
      expect(find.byKey(_headerKey), findsNothing);
      final content = tester.getRect(find.byKey(_contentKey));
      expect(content.left, 0);
      expect(content.right, 800);
      expect(content.top, 0);
      expect(content.bottom, 1280);
      expect(tester.takeException(), isNull);
    });

    testWidgets('当前槽无 rail 位置（好友／论坛）：rail 不选中、不崩',
        (tester) async {
      await _pumpShell(
        tester,
        size: const Size(800, 1280),
        kind: QfLayoutKind.medium,
        form: QfPageForm.twoPane,
        history: NavHistoryController(),
        active: AppSlot.forum,
      );
      expect(
          tester.widget<NavigationRail>(find.byType(NavigationRail))
              .selectedIndex,
          isNull);
      expect(tester.takeException(), isNull);
    });
  });

  group('返回键历史模型', () {
    testWidgets('栈缩短（回退）时按栈顶切槽，不记历史', (tester) async {
      final history = NavHistoryController();
      recordSlotVisit(history, from: 'home', to: 'files');
      final calls = <(AppSlot, bool)>[];
      await _pumpShell(
        tester,
        size: const Size(360, 800),
        kind: QfLayoutKind.compact,
        form: QfPageForm.single,
        history: history,
        active: AppSlot.files,
        onSelect: (slot, {bool recordHistory = true}) =>
            calls.add((slot, recordHistory)),
      );
      expect(history.handleBack(), isTrue);
      await tester.pump();
      expect(calls, [(AppSlot.home, false)]);
      expect(tester.takeException(), isNull);
    });

    testWidgets('压栈（前进）不触发切槽', (tester) async {
      final history = NavHistoryController();
      recordSlotVisit(history, from: 'home', to: 'files');
      final calls = <(AppSlot, bool)>[];
      await _pumpShell(
        tester,
        size: const Size(360, 800),
        kind: QfLayoutKind.compact,
        form: QfPageForm.single,
        history: history,
        active: AppSlot.files,
        onSelect: (slot, {bool recordHistory = true}) =>
            calls.add((slot, recordHistory)),
      );
      history.push('forum');
      await tester.pump();
      expect(calls, isEmpty);
      expect(tester.takeException(), isNull);
    });

    testWidgets('栈顶名字无法映射到槽位时不切槽、不崩', (tester) async {
      final history = NavHistoryController();
      history.push('nope');
      history.push('home');
      final calls = <(AppSlot, bool)>[];
      await _pumpShell(
        tester,
        size: const Size(360, 800),
        kind: QfLayoutKind.compact,
        form: QfPageForm.single,
        history: history,
        active: AppSlot.home,
        onSelect: (slot, {bool recordHistory = true}) =>
            calls.add((slot, recordHistory)),
      );
      expect(history.handleBack(), isTrue);
      await tester.pump();
      expect(calls, isEmpty);
      expect(tester.takeException(), isNull);
    });

    testWidgets('SystemBackGate：历史回退→耗尽走兜底→拦截器优先',
        (tester) async {
      final history = NavHistoryController();
      recordSlotVisit(history, from: 'home', to: 'files');
      var fallbackCalls = 0;
      var intercepted = false;
      await tester.pumpWidget(
        MaterialApp(
          home: SystemBackGate(
            history: history,
            onIntercept: () => intercepted,
            onFallback: () async {
              fallbackCalls++;
            },
            child: const Text('x'),
          ),
        ),
      );
      await tester.pump();
      // 第 1 次返回：历史回退到 home，不走兜底。
      await tester.binding.handlePopRoute();
      await tester.pump();
      expect(history.current, 'home');
      expect(fallbackCalls, 0);
      // 第 2 次返回：历史耗尽，走兜底。
      await tester.binding.handlePopRoute();
      await tester.pump();
      expect(history.current, 'home');
      expect(fallbackCalls, 1);
      // 拦截器优先：历史与兜底都不动。
      intercepted = true;
      history.push('files');
      await tester.binding.handlePopRoute();
      await tester.pump();
      expect(history.current, 'files');
      expect(fallbackCalls, 1);
      expect(tester.takeException(), isNull);
    });

    testWidgets('SystemBackGate：无兜底时耗尽后退应用（不崩、不死循环）',
        (tester) async {
      final history = NavHistoryController();
      history.push('home');
      await tester.pumpWidget(
        MaterialApp(
          home: SystemBackGate(
            history: history,
            child: const Text('x'),
          ),
        ),
      );
      await tester.pump();
      await tester.binding.handlePopRoute();
      await tester.pump();
      expect(history.current, 'home');
      expect(tester.takeException(), isNull);
    });
  });
}
