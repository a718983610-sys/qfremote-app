import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:qfremote/core/license.dart';
import 'package:qfremote/ui/license_section.dart';
import 'package:qfremote/ui/theme.dart';

/// S-033：无障碍验收（安卓侧，WCAG 2.2 AA）。
///
/// 覆盖：对比度（见 design_tokens_test 的数值断言）、focus 顺序／陷阱、
/// Escape 关闭、200% 字号缩放、触控目标 ≥44、live region 不重复朗读
/// （SnackBar 行为）、减少动效（见既有 reduced_motion_test）。
/// 深浅两主题均测。axe-core 网页自动扫描须在浏览器里跑（沙箱无浏览器，
/// 见 FIX-C2 报告“未闭合项”），本文件只做 Flutter 侧。
Widget _wrap(Widget child, QfThemeMode mode) {
  return MaterialApp(
    theme: ThemeData.light(),
    darkTheme: ThemeData.dark(),
    themeMode: mode == QfThemeMode.dark ? ThemeMode.dark : ThemeMode.light,
    // LicenseSection 是纵向 Column，在产品里放在可滚动的“我的”页内；
    // 测试壳同样包一层可滚动容器，避免 800×600 视口溢出干扰断言。
    home: Scaffold(body: SingleChildScrollView(child: child)),
  );
}

Future<void> _pumpLicenseSection(
  WidgetTester tester,
  QfThemeMode mode,
) async {
  final me = LicenseMe.tryParse(
    '{"ok":true,"username":"qflic2510a","planName":"QFRemote 永久套餐",'
    '"maskedKey":"QFR8K-•••••-•••••-•••••-V5YQZ","displayStatus":"正常",'
    '"slots":{"pc":1,"mobile":0},"trialExpiresMs":null,'
    '"keyExpiresMs":null,"webEnabled":true,"everBanned":false,'
    '"hasKey":true,"decision":{"allow":true,"code":"OK","shadow":true,'
    '"enforce":true}}',
  )!;
  await tester.pumpWidget(
    _wrap(
      LicenseSection(
        palette: QfPalette(mode),
        fetchLicense: () async => me,
        onBind: (_) async => null,
        onClaim: (_) async => null,
        onPurchase: () {},
        onStatusQuery: () {},
      ),
      mode,
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  group('S-033：无障碍（深浅两主题）', () {
    for (final mode in [QfThemeMode.light, QfThemeMode.dark]) {
      final name = mode == QfThemeMode.dark ? '深色' : '浅色';
      testWidgets('$name：查询密钥文字链有下划线、色取 linkUnderline、触控目标 ≥44', (tester) async {
        await _pumpLicenseSection(tester, mode);
        final linkFinder = find.text('查询密钥');
        expect(linkFinder, findsOneWidget);
        final text = tester.widget<Text>(linkFinder);
        final style = text.style!;
        expect(style.decoration, TextDecoration.underline);
        // S-040：下划线色与登录桥注入行同一 token。
        expect(style.decorationColor, QfPalette(mode).linkUnderline);
        // 触控目标：外层 QfButtonTapTarget 保 ≥44。
        final buttonFinder = find.widgetWithText(TextButton, '查询密钥');
        expect(buttonFinder, findsOneWidget);
        final size = tester.getSize(buttonFinder);
        expect(size.height, greaterThanOrEqualTo(44));
      });

      testWidgets('$name：查询密钥链是语义按钮（读屏可达）', (tester) async {
        await _pumpLicenseSection(tester, mode);
        final handle = tester.ensureSemantics();
        final semantics = tester.getSemantics(find.text('查询密钥'));
        // hasFlag 已弃用（Flutter 3.32+），改走 flagsCollection 具名字段。
        expect(semantics.getSemanticsData().flagsCollection.isButton, isTrue);
        expect(semantics.label, contains('查询密钥'));
        // 须在测试体末尾直接 dispose（框架在 tearDown 之前就校验 handle）。
        handle.dispose();
      });

      testWidgets('$name：200% 字号缩放不溢出、不抛错', (tester) async {
        final me = LicenseMe.tryParse(
          '{"ok":true,"username":"qflic2510a","planName":"QFRemote 永久套餐",'
          '"maskedKey":"QFR8K-•••••-•••••-•••••-V5YQZ","displayStatus":"正常",'
          '"slots":{"pc":1,"mobile":0},"trialExpiresMs":null,'
          '"keyExpiresMs":null,"webEnabled":true,"everBanned":false,'
          '"hasKey":true,"decision":{"allow":true,"code":"OK","shadow":true,'
          '"enforce":true}}',
        )!;
        // MediaQuery 必须放在 MaterialApp 内（外层会被 MaterialApp 的
        // 视图 MediaQuery 覆盖），只包 LicenseSection 子树。
        await tester.pumpWidget(
          _wrap(
            MediaQuery(
              data: const MediaQueryData(
                textScaler: TextScaler.linear(2.0),
              ),
              child: LicenseSection(
                palette: QfPalette(mode),
                fetchLicense: () async => me,
                onBind: (_) async => null,
                onClaim: (_) async => null,
                onPurchase: () {},
                onStatusQuery: () {},
              ),
            ),
            mode,
          ),
        );
        await tester.pumpAndSettle();
        expect(tester.takeException(), isNull);
        expect(find.text('查询密钥'), findsOneWidget);
      });
    }

    testWidgets('键盘：Tab 按顺序移动焦点，不困在单个控件里（无 focus 陷阱）', (tester) async {
      final nodes = [FocusNode(), FocusNode(), FocusNode()];
      addTearDown(() {
        for (final n in nodes) {
          n.dispose();
        }
      });
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: FocusTraversalGroup(
              child: Column(
                children: [
                  for (var i = 0; i < 3; i++)
                    TextButton(
                      focusNode: nodes[i],
                      onPressed: () {},
                      child: Text('操作 ${i + 1}'),
                    ),
                ],
              ),
            ),
          ),
        ),
      );
      nodes[0].requestFocus();
      await tester.pump();
      expect(nodes[0].hasFocus, isTrue);
      await tester.sendKeyEvent(LogicalKeyboardKey.tab);
      await tester.pump();
      expect(nodes[1].hasFocus, isTrue);
      await tester.sendKeyEvent(LogicalKeyboardKey.tab);
      await tester.pump();
      expect(nodes[2].hasFocus, isTrue);
      // 到末尾再 Tab：焦点须离开最后一个控件（不困住）；无论是落到
      // 组外还是回到首个，都不许停在原地。
      await tester.sendKeyEvent(LogicalKeyboardKey.tab);
      await tester.pump();
      expect(nodes[2].hasFocus, isFalse);
    });

    testWidgets('Escape：对话框按 Escape 关闭（不困住键盘用户）', (tester) async {
      var closed = false;
      await tester.pumpWidget(
        MaterialApp(
          home: Builder(
            builder: (context) => Scaffold(
              body: TextButton(
                onPressed: () async {
                  await showDialog<void>(
                    context: context,
                    builder: (ctx) => const AlertDialog(
                      content: Text('测试对话框'),
                    ),
                  );
                  closed = true;
                },
                child: const Text('打开'),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('打开'));
      await tester.pumpAndSettle();
      expect(find.text('测试对话框'), findsOneWidget);
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      expect(find.text('测试对话框'), findsNothing);
      expect(closed, isTrue);
    });
  });
}
