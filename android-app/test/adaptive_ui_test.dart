import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:qfremote/core/manifest.dart';
import 'package:qfremote/core/slot_nav.dart';
import 'package:qfremote/services/lock_client.dart';
import 'package:qfremote/services/points.dart';
import 'package:qfremote/services/probe.dart';
import 'package:qfremote/ui/about.dart';
import 'package:qfremote/ui/force_update.dart';
import 'package:qfremote/ui/frame.dart';
import 'package:qfremote/ui/lock.dart';
import 'package:qfremote/ui/me_page.dart';
import 'package:qfremote/ui/settings_page.dart';
import 'package:qfremote/ui/overlays.dart';
import 'package:qfremote/ui/theme.dart';

/// 适配增强点验（2.3.0 追加三）：多视口无溢出、刘海/手势条安全区、
/// 键盘弹起可达、旋转不丢状态、深色可构建、主题跟随系统裁决。
/// 说明：登录/设备/好友/聊天/论坛/「我的」是 WebView 内的网页（壳只提供
/// 工具栏＋安全区＋WebView 区域），本套件验壳的全部原生面。

const _sizes = <String, Size>{
  '小屏 360x640': Size(360, 640),
  '主流20:9 360x800': Size(360, 800),
  '长屏21:9 360x840': Size(360, 840),
  '平板 800x1280': Size(800, 1280),
  '横屏小 640x360': Size(640, 360),
  '横屏平板 1280x800': Size(1280, 800),
};

void _setView(WidgetTester tester, Size size) {
  tester.view.physicalSize = size;
  tester.view.devicePixelRatio = 1.0;
  addTearDown(() {
    tester.view.resetPhysicalSize();
    tester.view.resetDevicePixelRatio();
    tester.view.resetPadding();
    tester.view.resetViewInsets();
  });
}

ReleaseEntry _entry({String notes = '更新说明'}) => ReleaseEntry(
      version: '2.3.0',
      notes: notes,
      url: 'https://example.com/qfremote.apk',
      sha256: 'a' * 64,
      size: 1000,
    );

AboutDeps _aboutDeps(QfPalette p) => AboutDeps(
      currentVersion: '2.2.0',
      palette: p,
      probeNow: () async => ProbeResult(
          ok: true, at: DateTime(2026, 10, 25), elapsedMs: 5, statusCode: 200),
      checkUpdate: () async => null,
      download: (e, cb) async => File(''),
      openInstaller: (f) async {},
      diagnosticsText: () async => '诊断信息',
      fetchPoints: () async => null,
    );

void main() {
  group('多视口×双主题：关键原生面无溢出、无异常', () {
    for (final entry in _sizes.entries) {
      for (final mode in QfThemeMode.values) {
        testWidgets('${entry.key} / ${mode.name}', (tester) async {
          _setView(tester, entry.value);
          final p = QfPalette(mode);

          // 开屏页
          await tester.pumpWidget(MaterialApp(
              home: Scaffold(
                  body: SplashView(palette: p, version: '2.2.0'))));
          await tester.pump();
          expect(tester.takeException(), isNull);
          expect(find.text('QFRemote'), findsOneWidget);

          // 断线页：重试按钮必须在可视范围内
          await tester.pumpWidget(MaterialApp(
              home: Scaffold(
                  body: OfflineView(
                      palette: p, secondsLeft: 5, onRetryNow: () {}))));
          await tester.pump();
          expect(tester.takeException(), isNull);
          final retry = tester.getRect(find.text('立即重试'));
          expect(retry.bottom, lessThanOrEqualTo(entry.value.height + 0.5));
          expect(retry.top, greaterThanOrEqualTo(-0.5));

          // 强更页（长更新说明也不许溢出）
          await tester.pumpWidget(MaterialApp(
              home: Scaffold(
                  body: ForceUpdateView(
                palette: p,
                currentVersion: '2.2.0',
                entry: _entry(notes: '本次更新说明。' * 60),
                download: (e, cb) async => File(''),
                openInstaller: (f) async {},
              ))));
          await tester.pump();
          expect(tester.takeException(), isNull);
          expect(find.text('立即更新'), findsOneWidget);

          // 隐私锁页（Mock 数据）
          LockClient.resetMock();
          await tester.pumpWidget(MaterialApp(
              home: LockPage(
                  palette: p,
                  onNeedLogin: () {},
                  client: LockClient(mock: true))));
          await tester.pump();
          await tester.pump(const Duration(milliseconds: 300));
          expect(tester.takeException(), isNull);
          expect(find.byType(ListView), findsOneWidget);
        });
      }
    }
  });

  testWidgets('关于面板：小屏＋深色下可打开、无溢出、关键行齐全', (tester) async {
    _setView(tester, const Size(360, 640));
    final p = QfPalette(QfThemeMode.dark);
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: Builder(
          builder: (ctx) => Center(
            child: FilledButton(
              onPressed: () => showQfAboutDialog(ctx, _aboutDeps(p)),
              child: const Text('打开关于'),
            ),
          ),
        ),
      ),
    ));
    await tester.tap(find.text('打开关于'));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    expect(find.text('当前版本'), findsOneWidget);
    expect(find.text('使用时长'), findsOneWidget);
    expect(find.text('我的积分'), findsOneWidget);
    expect(find.text('检查更新'), findsOneWidget);
  });

  testWidgets('刘海/手势条：强更页按钮不进顶部挖孔区、不被底部手势条压', (tester) async {
    _setView(tester, const Size(390, 844));
    tester.view.padding = const FakeViewPadding(top: 47, bottom: 34);
    final p = QfPalette(QfThemeMode.blue);
    await tester.pumpWidget(MaterialApp(
        home: Scaffold(
            body: ForceUpdateView(
      palette: p,
      currentVersion: '2.2.0',
      entry: _entry(),
      download: (e, cb) async => File(''),
      openInstaller: (f) async {},
    ))));
    await tester.pump();
    expect(tester.takeException(), isNull);
    final btn = tester.getRect(find.text('立即更新'));
    expect(btn.bottom, lessThanOrEqualTo(844 - 34 + 0.5));
    final title = tester.getRect(find.text('需要更新'));
    expect(title.top, greaterThanOrEqualTo(47 - 0.5));
    // 三个全屏原生面都自带 SafeArea（主页面另有外层 SafeArea，见 main.dart）
    expect(find.byType(SafeArea), findsWidgets);
  });

  testWidgets('锁页底部安全区：body 带 SafeArea(top:false)', (tester) async {
    _setView(tester, const Size(390, 844));
    tester.view.padding = const FakeViewPadding(bottom: 34);
    LockClient.resetMock();
    await tester.pumpWidget(MaterialApp(
        home: LockPage(
            palette: QfPalette(QfThemeMode.blue),
            onNeedLogin: () {},
            client: LockClient(mock: true))));
    await tester.pump();
    final safe = tester.widgetList<SafeArea>(find.byType(SafeArea)).toList();
    expect(safe.any((s) => s.top == false && s.bottom == true), isTrue);
    expect(tester.takeException(), isNull);
  });

  testWidgets('键盘弹起：锁页内嵌表单输入框可滚动到可见、无溢出', (tester) async {
    _setView(tester, const Size(360, 640));
    LockClient.resetMock();
    await tester.pumpWidget(MaterialApp(
        home: LockPage(
            palette: QfPalette(QfThemeMode.blue),
            onNeedLogin: () {},
            client: LockClient(mock: true))));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    // 打开一台未锁定机主设备的开关 → 卡内展开「设置本次密码」表单（样图 m07）
    // （种子里有一台已锁定：点它会先弹关闭确认，取消后继续找下一台）
    final switches = find.byType(Switch);
    expect(switches, findsWidgets);
    final count = switches.evaluate().length;
    var opened = false;
    for (var i = 0; i < count && !opened; i++) {
      await tester.tap(find.byType(Switch).at(i));
      await tester.pumpAndSettle();
      if (find.text('设置本次密码（至少 4 位）').evaluate().isNotEmpty) {
        opened = true;
      } else if (find.text('取消').evaluate().isNotEmpty) {
        await tester.tap(find.text('取消').last);
        await tester.pumpAndSettle();
      }
    }
    expect(opened, isTrue, reason: '应能展开卡内启用表单');
    expect(find.byType(TextField), findsNWidgets(2));
    // 键盘弹起占下半屏：表单在列表内可滚动，字段滚到可见区后不被键盘压
    tester.view.viewInsets = const FakeViewPadding(bottom: 300);
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    await tester.ensureVisible(find.byType(TextField).first);
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    final field = tester.getRect(find.byType(TextField).first);
    expect(field.bottom, lessThanOrEqualTo(640 - 300 + 1));
    await tester.ensureVisible(find.text('打开隐私锁'));
    await tester.pumpAndSettle();
    final okBtn = tester.getRect(find.text('打开隐私锁'));
    expect(okBtn.bottom, lessThanOrEqualTo(640 - 300 + 1));
  });

  testWidgets('框架顶栏/标签栏＋我的页＋设置页：360x640 双主题无溢出', (tester) async {
    _setView(tester, const Size(360, 640));
    for (final mode in QfThemeMode.values) {
      final p = QfPalette(mode);
      await tester.pumpWidget(MaterialApp(
        home: Scaffold(
          body: Column(
            children: [
              QfAppHeader(
                palette: p,
                title: '我的设备',
                probeColor: QfPalette.probeOk,
                probeBusy: false,
                hasUpdate: true,
                showAdmin: true,
                onProbeTap: () {},
                onUpdateTap: () {},
                onMenuAction: (_) {},
              ),
              const Expanded(child: SizedBox()),
              QfTabBar(palette: p, active: AppSlot.devices, onSelect: (_) {}),
            ],
          ),
        ),
      ));
      await tester.pump();
      expect(tester.takeException(), isNull);
      expect(find.text('设备'), findsOneWidget);
      expect(find.text('我的'), findsOneWidget);

      await tester.pumpWidget(MaterialApp(
        home: MePage(
          palette: p,
          currentVersion: '2.2.0',
          hasUpdate: false,
          updateVersion: null,
          rememberLine: '已记住此设备，30 天内不用再登录',
          fallbackUser: 'qfverify230a',
          fetchPoints: () async => null,
          onOpenSettings: () {},
          onCheckUpdate: () {},
          onAccountAction: () {},
          onLogout: () {},
        ),
      ));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));
      expect(tester.takeException(), isNull);
      expect(find.text('使用时长'), findsOneWidget);
      expect(find.text('退出账号'), findsOneWidget);

      await tester.pumpWidget(MaterialApp(
        home: SettingsPage(
          palette: p,
          themeChoice: ThemeChoice.followSystem,
          rememberDevice: true,
          rememberPassword: false,
          currentVersion: '2.2.0',
          onThemeChoice: (_) {},
          onToggleRememberDevice: (_) {},
          onToggleRememberPassword: (_) {},
          onCheckUpdate: () {},
          onOpenTerms: () {},
          onLogout: () {},
        ),
      ));
      await tester.pump();
      expect(tester.takeException(), isNull);
      expect(find.text('记住账号密码'), findsOneWidget);
      expect(find.text('用户协议与隐私说明'), findsOneWidget);
    }
  });

  testWidgets('旋转：锁页竖→横状态不丢（设备列表还在）、布局不崩', (tester) async {
    _setView(tester, const Size(360, 640));
    LockClient.resetMock();
    await tester.pumpWidget(MaterialApp(
        home: LockPage(
            palette: QfPalette(QfThemeMode.dark),
            onNeedLogin: () {},
            client: LockClient(mock: true))));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.byType(Switch), findsWidgets);
    final before = find.byType(Switch).evaluate().length;
    // 旋转到横屏
    tester.view.physicalSize = const Size(640, 360);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));
    expect(tester.takeException(), isNull);
    expect(find.byType(Switch).evaluate().length, before);
  });

  group('主题裁决 resolveThemeMode', () {
    test('手动选过：永远听用户的（与系统深浅无关）', () {
      expect(
          resolveThemeMode(
              pref: 'dark', platformBrightness: Brightness.light),
          QfThemeMode.dark);
      expect(
          resolveThemeMode(
              pref: 'blue', platformBrightness: Brightness.dark),
          QfThemeMode.blue);
    });

    test('没选过：跟随系统（深→深灰、浅→品牌蓝）', () {
      expect(
          resolveThemeMode(pref: null, platformBrightness: Brightness.dark),
          QfThemeMode.dark);
      expect(
          resolveThemeMode(pref: null, platformBrightness: Brightness.light),
          QfThemeMode.blue);
      expect(
          resolveThemeMode(pref: '', platformBrightness: Brightness.dark),
          QfThemeMode.dark);
    });
  });

  test('积分模型不受适配影响（回归锚点）', () {
    final info = PointsInfo.parse(
        '{"user":"u","points":3,"totalSeconds":21600,"daysUsed":2,"displayText":"使用该软件已经2天"}');
    expect(info.displayText, '使用该软件已经2天');
    expect(info.points, 3);
  });
}
