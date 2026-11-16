import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:qfremote/ui/theme.dart';

/// 黑白化 6 项定夺 9 项遗留第 1 项（安卓③按钮／输入框视觉高度）：
/// 实测按钮 Filled／Outlined／TextButton 与输入框的真实像素高
/// （tester.getSize），改前改后同一文件复测。
/// 口径：按钮视觉 40、输入框视觉 40、触控命中区 ≥44。
///
/// 改前基线（Flutter 3.47.8，2026-11-14 实测）：
/// filled=48 outlined=48 text=48 override44=48 field=56
/// （默认 padded 把视觉顶到 48；输入框非 dense 有 48 地板）。
/// 改后（本文件断言）：视觉 40，命中区由外层容器补到 44。
void main() {
  Future<void> pumpHarness(WidgetTester tester) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: QfTheme.light(),
        home: Scaffold(
          body: SingleChildScrollView(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                FilledButton(
                  key: const Key('filled-theme'),
                  onPressed: () {},
                  child: const Text('确定'),
                ),
                OutlinedButton(
                  key: const Key('outlined-theme'),
                  onPressed: () {},
                  child: const Text('取消'),
                ),
                TextButton(
                  key: const Key('text-theme'),
                  onPressed: () {},
                  child: const Text('更多'),
                ),
                // 呼叫点同款覆盖：styleFrom 显式 minimumSize（现为视觉常量 40）。
                FilledButton(
                  key: const Key('filled-override'),
                  onPressed: () {},
                  style: FilledButton.styleFrom(
                    minimumSize: const Size(0, QfScale.buttonVisualHeight),
                  ),
                  child: const Text('领取密钥'),
                ),
                // 输入框：只走主题 InputDecorationTheme，不写局部 padding。
                const TextField(
                  key: Key('field-theme'),
                  decoration: InputDecoration(hintText: '输入'),
                ),
              ],
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  double h(WidgetTester tester, String key) =>
      tester.getSize(find.byKey(Key(key))).height;

  testWidgets('改后实测：按钮与输入框视觉均为 40', (tester) async {
    await pumpHarness(tester);
    final filled = h(tester, 'filled-theme');
    final outlined = h(tester, 'outlined-theme');
    final text = h(tester, 'text-theme');
    final override = h(tester, 'filled-override');
    final field = h(tester, 'field-theme');
    // ignore: avoid_print
    print('LEFTOVER-1 AFTER filled=$filled outlined=$outlined '
        'text=$text override=$override field=$field');
    expect(filled, 40);
    expect(outlined, 40);
    expect(text, 40);
    expect(override, 40);
    expect(field, 40);
    expect(QfScale.buttonVisualHeight, 40);
    expect(QfScale.minTouch, 44);
  });

  testWidgets('按钮命中区：容器 44、按钮视觉 40、条带点按 1 次、本体 1 次、禁用 0 次、全宽',
      (tester) async {
    var count = 0;
    await tester.pumpWidget(
      MaterialApp(
        theme: QfTheme.light(),
        home: Scaffold(
          body: Column(
            children: [
              SizedBox(
                width: 400,
                child: QfButtonTapTarget(
                  child: FilledButton(
                    key: const Key('wrapped'),
                    onPressed: () => count++,
                    child: const Text('领取密钥'),
                  ),
                ),
              ),
              QfButtonTapTarget(
                child: FilledButton(
                  key: const Key('disabled'),
                  onPressed: null,
                  child: const Text('禁用'),
                ),
              ),
            ],
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    final wrapSize = tester.getSize(find.byType(QfButtonTapTarget).first);
    final btnSize = tester.getSize(find.byKey(const Key('wrapped')));
    // ignore: avoid_print
    print('LEFTOVER-1 TAP-BUTTON wrap=$wrapSize btn=$btnSize');
    expect(wrapSize.height, 44);
    expect(btnSize.height, 40);
    expect(btnSize.width, 400); // 全宽透传
    await tester.tap(find.byKey(const Key('wrapped')));
    expect(count, 1); // 本体点按只触发 1 次（外层不重复触发）
    final topLeft = tester.getTopLeft(find.byType(QfButtonTapTarget).first);
    await tester.tapAt(topLeft + const Offset(200, 1));
    expect(count, 2); // 顶部条带转给按钮
    final bottomLeft =
        tester.getBottomLeft(find.byType(QfButtonTapTarget).first);
    await tester.tapAt(bottomLeft + const Offset(200, -1));
    expect(count, 3); // 底部条带转给按钮
    final dTopLeft = tester.getTopLeft(find.byType(QfButtonTapTarget).at(1));
    await tester.tapAt(dTopLeft + const Offset(50, 1));
    expect(count, 3); // 禁用按钮条带不触发
  });

  testWidgets('输入框命中区：容器 44、视觉 40、条带点按聚焦、全宽', (tester) async {
    FocusNode? captured;
    await tester.pumpWidget(
      MaterialApp(
        theme: QfTheme.light(),
        home: Scaffold(
          // 真实布局：输入框总在 Column／对话框里（松约束），不在 Scaffold 直属。
          body: Column(
            children: [
              SizedBox(
                width: 400,
                child: QfTextFieldTapTarget(
                  builder: (node) {
                    captured = node;
                    return TextField(
                      key: const Key('field'),
                      focusNode: node,
                      decoration: const InputDecoration(hintText: '输入'),
                    );
                  },
                ),
              ),
            ],
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    final wrapSize = tester.getSize(find.byType(QfTextFieldTapTarget));
    final fieldSize = tester.getSize(find.byKey(const Key('field')));
    // ignore: avoid_print
    print('LEFTOVER-1 TAP-FIELD wrap=$wrapSize field=$fieldSize');
    expect(wrapSize.height, 44);
    expect(fieldSize.height, 40);
    expect(fieldSize.width, 400); // 全宽透传
    expect(captured!.hasFocus, isFalse);
    final topLeft = tester.getTopLeft(find.byType(QfTextFieldTapTarget));
    await tester.tapAt(topLeft + const Offset(200, 1));
    await tester.pump();
    expect(captured!.hasFocus, isTrue); // 顶部条带点按聚焦
    captured!.unfocus();
    await tester.pump();
    await tester.tap(find.byKey(const Key('field')));
    await tester.pump();
    expect(captured!.hasFocus, isTrue); // 本体点按聚焦
  });

  testWidgets('输入框命中区兜底：矮字段（fs14，视觉 37）容器仍 44', (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: QfTheme.light(),
        home: Scaffold(
          body: Column(
            children: [
              QfTextFieldTapTarget(
                builder: (node) => TextField(
                  key: const Key('short-field'),
                  focusNode: node,
                  style: const TextStyle(fontSize: 14),
                  decoration: const InputDecoration(labelText: '登录密码'),
                ),
              ),
            ],
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    final wrapSize = tester.getSize(find.byType(QfTextFieldTapTarget));
    final fieldSize = tester.getSize(find.byKey(const Key('short-field')));
    // ignore: avoid_print
    print('LEFTOVER-1 TAP-FIELD-SHORT wrap=$wrapSize field=$fieldSize');
    expect(fieldSize.height, 37); // 14px 行高 21：8+8+21=37（定夺算式按 16px 计）
    expect(wrapSize.height, 44); // minHeight 强制，命中区仍 ≥44
  });
}
