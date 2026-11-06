import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:qfremote/core/manifest.dart';
import 'package:qfremote/services/lock_client.dart';
import 'package:qfremote/services/probe.dart';
import 'package:qfremote/ui/about.dart';
import 'package:qfremote/ui/force_update.dart';
import 'package:qfremote/ui/lock.dart';
import 'package:qfremote/ui/overlays.dart';
import 'package:qfremote/ui/settings_page.dart';
import 'package:qfremote/ui/theme.dart';

/// 弹窗专项普查（追加十一）：App 内全部弹窗/浮层在 360 宽窄屏 × 系统字体
/// 放大 1.3/2.0 档下逐个构建——不溢出、不截断关键文字、层级在最前；
/// 更新类弹窗另验进度百分比实时显示与失败提示＋重试（不无声卡死）。
void main() {
  final palette = QfPalette(QfThemeMode.blue);
  const longNotes = '本次更新内容：修复了若干已知问题，优化了连接稳定性与界面显示效果；'
      '建议所有用户尽快更新到最新版本，以便获得更好的使用体验与安全保障。';

  ReleaseEntry fakeEntry() => ReleaseEntry(
        version: '9.9.9',
        notes: longNotes,
        url: 'https://app.qfremote.top/dl/QFRemote-v9.9.9.apk',
        sha256: 'a' * 64,
        size: 1000,
      );

  Future<void> pumpScaled(
    WidgetTester tester,
    double scale,
    Widget home, {
    Size size = const Size(360, 640),
  }) async {
    tester.view.physicalSize = size;
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(MaterialApp(
      builder: (context, child) => MediaQuery(
        data: MediaQuery.of(context)
            .copyWith(textScaler: TextScaler.linear(scale)),
        child: child!,
      ),
      home: home,
    ));
    await tester.pump();
  }

  for (final scale in [1.3, 2.0]) {
    testWidgets('关于弹窗：字体 $scale 档不溢出、长更新说明可读', (tester) async {
      final deps = AboutDeps(
        currentVersion: '2.2.0',
        palette: palette,
        probeNow: () async => ProbeResult(
            ok: true, at: DateTime.now(), elapsedMs: 3, statusCode: 200),
        checkUpdate: () async => fakeEntry(),
        download: (entry, cb) async {
          cb(1000, 1000, 100);
          return File('/tmp/QFRemote-v9.9.9.apk');
        },
        openInstaller: (_) async {},
        diagnosticsText: () async => '诊断',
        fetchPoints: null,
      );
      await pumpScaled(
        tester,
        scale,
        Scaffold(
          body: Builder(
            builder: (ctx) => Center(
              child: FilledButton(
                onPressed: () => showQfAboutDialog(ctx, deps),
                child: const Text('打开关于'),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('打开关于'));
      await tester.pumpAndSettle(const Duration(milliseconds: 100), EnginePhase.sendSemanticsUpdate, const Duration(seconds: 30));
      expect(tester.takeException(), isNull);
      // 大字体下按钮会被顶出可视区：先滚到它再点（点空不算数）
      await tester.scrollUntilVisible(find.text('检查更新'), 120);
      await tester.pumpAndSettle(const Duration(milliseconds: 100), EnginePhase.sendSemanticsUpdate, const Duration(seconds: 30));
      await tester.tap(find.text('检查更新'));
      await tester.pumpAndSettle(const Duration(milliseconds: 100), EnginePhase.sendSemanticsUpdate, const Duration(seconds: 30));
      expect(tester.takeException(), isNull);
      expect(find.text('发现新版 v9.9.9'), findsOneWidget);
      expect(find.text('下载更新'), findsOneWidget);
    });

    testWidgets('设置页主题弹窗＋退出确认弹窗：字体 $scale 档不溢出', (tester) async {
      // 本用例只压窄宽＋大字体：视口高给到 1000 让退出行直接建成，
      // 不把滚动机制混进断言（滚动可达已由其他用例覆盖）
      await pumpScaled(
        tester,
        scale,
        size: const Size(360, 1000),
        SettingsPage(
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
          onLogout: () {},
        ),
      );
      await tester.tap(find.text('深色模式'));
      await tester.pumpAndSettle(const Duration(milliseconds: 100), EnginePhase.sendSemanticsUpdate, const Duration(seconds: 30));
      expect(tester.takeException(), isNull);
      expect(find.text('深灰（不用纯黑）'), findsOneWidget);
      // 弹窗里的选项：不能点已选项（不触发变更、弹窗不关），点「深灰」
      await tester.tap(find.descendant(
          of: find.byType(AlertDialog), matching: find.text('深灰（不用纯黑）')));
      await tester.pumpAndSettle(const Duration(milliseconds: 100), EnginePhase.sendSemanticsUpdate, const Duration(seconds: 30));
      await tester.scrollUntilVisible(find.text('退出账号'), 200);
      await tester.pumpAndSettle(const Duration(milliseconds: 100), EnginePhase.sendSemanticsUpdate, const Duration(seconds: 30));
      await tester.tap(find.text('退出账号'));
      await tester.pumpAndSettle(const Duration(milliseconds: 100), EnginePhase.sendSemanticsUpdate, const Duration(seconds: 30));
      expect(tester.takeException(), isNull);
      expect(find.text('退出后将清除本机保存的登录信息，下次使用需重新登录。是否继续？'),
          findsOneWidget);
    });

    testWidgets('隐私锁关闭确认＋重设弹窗：字体 $scale 档不溢出', (tester) async {
      LockClient.resetMock();
      await pumpScaled(
        tester,
        scale,
        LockPage(
          palette: palette,
          onNeedLogin: () {},
          client: LockClient(mock: true),
        ),
      );
      await tester.pump(const Duration(milliseconds: 300));
      // 已锁定设备（mock-2）的开关是开着的：点关 → 关闭确认弹窗
      final switches = find.byType(Switch);
      expect(switches, findsWidgets);
      await tester.tap(switches.at(1));
      await tester.pumpAndSettle(const Duration(milliseconds: 100), EnginePhase.sendSemanticsUpdate, const Duration(seconds: 30));
      expect(tester.takeException(), isNull);
      expect(find.text('关闭隐私锁后，本次密码立即作废。'), findsOneWidget);
      await tester.tap(find.text('取消'));
      await tester.pumpAndSettle(const Duration(milliseconds: 100), EnginePhase.sendSemanticsUpdate, const Duration(seconds: 30));
      // 重设弹窗（三密码框＋错误位）
      await tester.scrollUntilVisible(find.text('忘记密码？用登录密码重设'), 200);
      await tester.pumpAndSettle(const Duration(milliseconds: 100), EnginePhase.sendSemanticsUpdate, const Duration(seconds: 30));
      await tester.tap(find.text('忘记密码？用登录密码重设'));
      await tester.pumpAndSettle(const Duration(milliseconds: 100), EnginePhase.sendSemanticsUpdate, const Duration(seconds: 30));
      expect(tester.takeException(), isNull);
      expect(find.text('用登录密码重设'), findsOneWidget);
      expect(find.text('新锁密码'), findsOneWidget);
    });

    testWidgets('断线浮层与开屏浮层：字体 $scale 档不溢出', (tester) async {
      await pumpScaled(
        tester,
        scale,
        OfflineView(palette: palette, secondsLeft: 12, onRetryNow: () {}),
      );
      expect(tester.takeException(), isNull);
      await pumpScaled(tester, scale, SplashView(palette: palette, version: '2.2.0'));
      expect(tester.takeException(), isNull);
    });
  }

  testWidgets('强制更新页：进度百分比实时、失败有提示有重试（不卡死）', (tester) async {
    tester.view.physicalSize = const Size(360, 640);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    final gate = Completer<File>();
    var calls = 0;
    Future<File> fakeDownload(
        ReleaseEntry entry, void Function(int, int?, int?) cb) {
      calls++;
      if (calls == 1) {
        cb(500, 1000, 50);
        return gate.future;
      }
      return Future.error(
          const FormatException('完整性核对未通过（SHA256 校验码不一致），已删除该文件，请重新下载。'));
    }

    await tester.pumpWidget(MaterialApp(
      home: ForceUpdateView(
        palette: palette,
        currentVersion: '2.2.0',
        entry: fakeEntry(),
        download: fakeDownload,
        openInstaller: (_) async {},
      ),
    ));
    await tester.pump();
    await tester.tap(find.text('立即更新'));
    await tester.pump();
    // 下载进行中：数字百分比与进度条都在
    expect(find.text('正在下载… 50%'), findsOneWidget);
    expect(find.byType(LinearProgressIndicator), findsOneWidget);
    // 完成 → 打开安装包
    gate.complete(File('/tmp/QFRemote-v9.9.9.apk'));
    await tester.pumpAndSettle(const Duration(milliseconds: 100), EnginePhase.sendSemanticsUpdate, const Duration(seconds: 30));
    expect(find.text('打开安装包'), findsOneWidget);
    expect(find.text('下载完成，完整性核对通过'), findsOneWidget);
  });

  testWidgets('强制更新页：下载失败显示具体原因并可重试', (tester) async {
    tester.view.physicalSize = const Size(360, 640);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    Future<File> failing(
            ReleaseEntry entry, void Function(int, int?, int?) cb) =>
        Future.error(const HttpException('下载失败：HTTP 500'));
    await tester.pumpWidget(MaterialApp(
      home: ForceUpdateView(
        palette: palette,
        currentVersion: '2.2.0',
        entry: fakeEntry(),
        download: failing,
        openInstaller: (_) async {},
      ),
    ));
    await tester.pump();
    await tester.tap(find.text('立即更新'));
    await tester.pumpAndSettle(const Duration(milliseconds: 100), EnginePhase.sendSemanticsUpdate, const Duration(seconds: 30));
    expect(find.textContaining('下载失败：HTTP 500'), findsOneWidget);
    expect(find.text('重新下载更新'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('强制更新页 #43：失败态才有放行出口，点击触发回调', (tester) async {
    tester.view.physicalSize = const Size(360, 640);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    var skipped = 0;
    Future<File> failing(
            ReleaseEntry entry, void Function(int, int?, int?) cb) =>
        Future.error(const HttpException('下载失败：HTTP 500'));
    await tester.pumpWidget(MaterialApp(
      home: ForceUpdateView(
        palette: palette,
        currentVersion: '2.2.0',
        entry: fakeEntry(),
        download: failing,
        openInstaller: (_) async {},
        onSkipOnce: () => skipped++,
      ),
    ));
    await tester.pump();
    // 未失败前不许出现放行出口（能更时拦死）
    expect(find.text('下载失败？先进入软件，下次再更新'), findsNothing);
    await tester.tap(find.text('立即更新'));
    await tester.pumpAndSettle(const Duration(milliseconds: 100), EnginePhase.sendSemanticsUpdate, const Duration(seconds: 30));
    expect(find.text('下载失败？先进入软件，下次再更新'), findsOneWidget);
    await tester.tap(find.text('下载失败？先进入软件，下次再更新'));
    await tester.pump();
    expect(skipped, 1);
    expect(tester.takeException(), isNull);
  });

  testWidgets('关于弹窗：下载进度 50% 可见、失败原因可见', (tester) async {
    tester.view.physicalSize = const Size(360, 640);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    final gate = Completer<File>();
    final deps = AboutDeps(
      currentVersion: '2.2.0',
      palette: palette,
      probeNow: () async => ProbeResult(
          ok: true, at: DateTime.now(), elapsedMs: 3, statusCode: 200),
      checkUpdate: () async => fakeEntry(),
      download: (entry, cb) {
        cb(500, 1000, 50);
        return gate.future;
      },
      openInstaller: (_) async {},
      diagnosticsText: () async => '诊断',
      fetchPoints: null,
    );
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: Builder(
          builder: (ctx) => Center(
            child: FilledButton(
              onPressed: () => showQfAboutDialog(ctx, deps),
              child: const Text('打开关于'),
            ),
          ),
        ),
      ),
    ));
    await tester.tap(find.text('打开关于'));
    await tester.pumpAndSettle(const Duration(milliseconds: 100), EnginePhase.sendSemanticsUpdate, const Duration(seconds: 30));
    await tester.tap(find.text('检查更新'));
    await tester.pumpAndSettle(const Duration(milliseconds: 100), EnginePhase.sendSemanticsUpdate, const Duration(seconds: 30));
    await tester.tap(find.text('下载更新'));
    await tester.pump();
    expect(find.text('正在下载… 50%'), findsOneWidget);
    expect(find.byType(LinearProgressIndicator), findsWidgets);
    gate.completeError(
        const FormatException('下载不完整（文件大小与清单不一致），已删除，请重新下载。'));
    await tester.pumpAndSettle(const Duration(milliseconds: 100), EnginePhase.sendSemanticsUpdate, const Duration(seconds: 30));
    expect(find.textContaining('下载不完整'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('SnackBar 长文案（安装失败带路径）：2.0 档不溢出', (tester) async {
    tester.view.physicalSize = const Size(360, 640);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(MaterialApp(
      builder: (context, child) => MediaQuery(
        data: MediaQuery.of(context)
            .copyWith(textScaler: const TextScaler.linear(2.0)),
        child: child!,
      ),
      home: Scaffold(
        body: Builder(
          builder: (ctx) => Center(
            child: FilledButton(
              onPressed: () => ScaffoldMessenger.of(ctx).showSnackBar(
                const SnackBar(
                  content: Text(
                      '安装包打开失败（无法打开该文件），文件位于：/storage/emulated/0/Android/data/com.qfremote.android/files/updates/QFRemote-v2.3.0.apk'),
                  duration: Duration(seconds: 30),
                ),
              ),
              child: const Text('弹出'),
            ),
          ),
        ),
      ),
    ));
    await tester.tap(find.text('弹出'));
    await tester.pumpAndSettle(const Duration(milliseconds: 100), EnginePhase.sendSemanticsUpdate, const Duration(seconds: 30));
    expect(tester.takeException(), isNull);
    expect(find.textContaining('安装包打开失败'), findsOneWidget);
  });
}
