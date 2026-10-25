import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:qfremote/ui/logout_confirm.dart';
import 'package:qfremote/ui/me_page.dart';
import 'package:qfremote/ui/settings_page.dart';
import 'package:qfremote/ui/theme.dart';

void main() {
  final palette = QfPalette(QfThemeMode.blue);

  test('确认文案与站长拟稿逐字一致', () {
    expect(kLogoutConfirmText, '退出后将清除本机保存的登录信息，下次使用需重新登录。是否继续？');
  });

  Future<void> exerciseFlow(
    WidgetTester tester, {
    required int Function() logoutCalls,
  }) async {
    // 点入口 → 弹窗出现、文案逐字
    await tester.ensureVisible(find.text('退出账号'));
    await tester.tap(find.text('退出账号'));
    await tester.pumpAndSettle();
    expect(find.text(kLogoutConfirmText), findsOneWidget);
    expect(logoutCalls(), 0, reason: '弹窗未确认不得退出');
    // 取消 → 弹窗关、不退出
    await tester.tap(find.text('取消'));
    await tester.pumpAndSettle();
    expect(find.text(kLogoutConfirmText), findsNothing);
    expect(logoutCalls(), 0);
    // 再点 → 确认「退出」→ 收口恰好调用一次
    await tester.ensureVisible(find.text('退出账号'));
    await tester.tap(find.text('退出账号'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('退出'));
    await tester.pumpAndSettle();
    expect(logoutCalls(), 1);
  }

  testWidgets('我的页：退出先确认、确认才走手动退出收口', (tester) async {
    tester.view.physicalSize = const Size(360, 800);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    var calls = 0;
    await tester.pumpWidget(MaterialApp(
      home: MePage(
        palette: palette,
        currentVersion: '2.2.0',
        hasUpdate: false,
        updateVersion: null,
        rememberLine: '已记住此设备',
        fallbackUser: 'tester',
        fetchPoints: () async => null,
        onOpenSettings: () {},
        onCheckUpdate: () {},
        onAccountAction: () {},
        onLogout: () => calls++,
      ),
    ));
    await tester.pump();
    await exerciseFlow(tester, logoutCalls: () => calls);
  });

  testWidgets('设置页：退出入口同弹窗同文案、确认才走收口', (tester) async {
    tester.view.physicalSize = const Size(360, 800);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    var calls = 0;
    await tester.pumpWidget(MaterialApp(
      home: SettingsPage(
        palette: palette,
        themeChoice: ThemeChoice.followSystem,
        rememberDevice: true,
        rememberPassword: true,
        currentVersion: '2.2.0',
        onThemeChoice: (_) {},
        onToggleRememberDevice: (_) {},
        onToggleRememberPassword: (_) {},
        onCheckUpdate: () {},
        onOpenTerms: () {},
        onLogout: () => calls++,
      ),
    ));
    await tester.pump();
    await exerciseFlow(tester, logoutCalls: () => calls);
  });
}
