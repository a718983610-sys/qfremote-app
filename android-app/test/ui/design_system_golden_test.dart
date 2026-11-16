import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:qfremote/ui/core/widgets.dart';
import 'package:qfremote/ui/theme.dart';

/// A-07 Golden 截图双主题门：每个核心设计系统件强制配浅/深两张 Golden，
/// CI 比对；QFRemote 要求“跟随系统主题”，没有这条门，黑白化一定会在
/// 深色下漏出白底黑字/白字白底。
/// 生成：flutter test --update-goldens test/ui/design_system_golden_test.dart
void main() {
  Widget wrap(QfThemeMode mode, Widget child) {
    return MaterialApp(
      theme: QfTheme.light(),
      darkTheme: QfTheme.dark(),
      themeMode: mode == QfThemeMode.dark ? ThemeMode.dark : ThemeMode.light,
      home: Scaffold(
        body: Center(
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: child,
          ),
        ),
      ),
    );
  }

  Future<void> pumpCase(
    WidgetTester tester,
    QfThemeMode mode,
    String name,
    Widget child,
  ) async {
    await tester.pumpWidget(wrap(mode, child));
    await tester.pump();
    await expectLater(
      find.byType(Scaffold),
      matchesGoldenFile('goldens/${name}_${mode.name}.png'),
    );
  }

  group('设计系统件 Golden（浅/深双主题）', () {
    for (final mode in QfThemeMode.values) {
      testWidgets('主按钮 / $mode', (tester) async {
        await pumpCase(tester, mode, 'qf_button',
            QfButton(label: '连接', onPressed: () {}));
      });

      testWidgets('状态点 / $mode', (tester) async {
        await pumpCase(
            tester,
            mode,
            'qf_status_pill',
            const Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                QfStatusPill(status: QfStatus.online, label: '在线'),
                SizedBox(height: 8),
                QfStatusPill(status: QfStatus.offline, label: '离线'),
                SizedBox(height: 8),
                QfStatusPill(status: QfStatus.warning, label: '待同步 2 条'),
              ],
            ));
      });

      testWidgets('空态＋错误态 / $mode', (tester) async {
        await pumpCase(
            tester,
            mode,
            'qf_empty_error',
            Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                const QfEmptyState(title: '暂无设备', hint: '登录后设备会出现在这里。'),
                const SizedBox(height: 24),
                QfErrorView(message: '加载失败，请检查网络后重试。', onRetry: () {}),
              ],
            ));
      });

      testWidgets('离线横幅＋同步徽标 / $mode', (tester) async {
        await pumpCase(
            tester,
            mode,
            'qf_banner_badge',
            const Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                QfOfflineBanner(message: '当前离线，改动将在联网后同步'),
                SizedBox(height: 8),
                QfSyncBadge(pendingCount: 3),
              ],
            ));
      });
    }
  });
}
