import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:qfremote/core/slot_nav.dart';
import 'package:qfremote/ui/frame.dart';
import 'package:qfremote/ui/settings_page.dart';
import 'package:qfremote/ui/theme.dart';
import 'package:qfremote/ui/toolbar.dart';

/// Windows／安卓黑白 UI 修复（2026-11-14，大肥鱼主导评审）专项断言。
/// 逐项对应抽查报告 19 项（A1–A9、W1–W10 中的安卓侧＋W3 跨端 token）；
/// Windows 侧（W1/W2/W4–W10）无 Flutter 渲染，走 node 单测＋Playwright
/// 实测（见 WIN-ANDROID-FIX-REPORT.md），不在本文件断言。
void main() {
  const light = QfPalette(QfThemeMode.blue);
  const dark = QfPalette(QfThemeMode.dark);

  group('A1 顶栏 token：浅色白顶栏＋深色卡片，禁纯黑顶栏', () {
    test('toolbarColor 浅 surface0／深 #111113', () {
      expect(light.toolbarColor, const Color(0xFFFFFFFF));
      expect(light.toolbarColor, light.surface0);
      expect(dark.toolbarColor, const Color(0xFF111113));
    });

    test('toolbarText／toolbarIcon 浅 #09090B／深白', () {
      expect(light.toolbarText, const Color(0xFF09090B));
      expect(dark.toolbarText, Colors.white);
      expect(light.toolbarIcon, const Color(0xFF09090B));
      expect(dark.toolbarIcon, Colors.white);
    });

    test('toolbarBadge 浅 brand 黑／深白（深色顶栏上黑点会隐形）', () {
      expect(light.toolbarBadge, light.brand);
      expect(light.toolbarBadge, const Color(0xFF000000));
      expect(dark.toolbarBadge, Colors.white);
    });
  });

  group('A2/A3/A6 token：scrim／label12／间距 token', () {
    test('scrim 两端均为 .32', () {
      expect((light.scrim.a * 255.0).round().clamp(0, 255), closeTo(0.32 * 255, 1));
      expect((dark.scrim.a * 255.0).round().clamp(0, 255), closeTo(0.32 * 255, 1));
    });

    test('label12：12sp／行高 16／字距 +0.44／默认 w500', () {
      final l12 = QfType.label12(Colors.black);
      expect(l12.fontSize, 12);
      expect(l12.height, closeTo(16 / 12, 0.001));
      expect(l12.letterSpacing, 0.44);
      expect(l12.fontWeight, FontWeight.w500);
    });

    test('间距 token：tab 项高 64／卡片 16／状态卡 24／列表顶距 12／行纵向 8', () {
      expect(QfScale.bottomTabItemHeight, 64);
      expect(QfScale.cardPadding, 16);
      expect(QfScale.statusCardPadding, 24);
      expect(QfScale.listTopGap, 12);
      expect(QfScale.listRowVertical, 8);
    });
  });

  group('A4 头像占位：浅色中性灰盘，深色不动', () {
    testWidgets('浅色盘 #E4E4E7', (tester) async {
      await tester.pumpWidget(MaterialApp(
        theme: QfTheme.light(),
        home: const Scaffold(
          body: Center(child: QfAvatarPlaceholder(size: 56)),
        ),
      ));
      await tester.pump();
      expect(tester.takeException(), isNull);
      final disc = find.byWidgetPredicate(
        (w) =>
            w is Container &&
            w.decoration is BoxDecoration &&
            (w.decoration as BoxDecoration).shape == BoxShape.circle &&
            (w.decoration as BoxDecoration).color ==
                const Color(0xFFE4E4E7),
      );
      expect(disc, findsOneWidget);
    });
  });

  group('A1/A8 顶栏＋底部 tab（widget）', () {
    testWidgets('浅色顶栏白底、标题走 toolbarText、探针点有 1px 外环、更新点走 toolbarBadge',
        (tester) async {
      await tester.pumpWidget(MaterialApp(
        theme: QfTheme.light(),
        home: Scaffold(
          body: QfAppHeader(
            palette: light,
            title: '我的设备',
            probeColor: QfPalette.probeOk,
            probeBusy: false,
            hasUpdate: true,
            showAdmin: false,
            onProbeTap: () {},
            onUpdateTap: () {},
            onMenuAction: (_) {},
          ),
        ),
      ));
      await tester.pump();
      expect(tester.takeException(), isNull);
      // 顶栏底色＝surface0 白，不是纯黑。
      final bar = find.byWidgetPredicate(
        (w) =>
            w is AnimatedContainer &&
            w.decoration is BoxDecoration &&
            (w.decoration as BoxDecoration).color == light.toolbarColor,
      );
      expect(bar, findsOneWidget);
      // 标题色＝toolbarText。
      final title = tester.widget<Text>(find.text('我的设备'));
      expect(title.style?.color, light.toolbarText);
      // 探针点：6px 圆＋1px 外环（toolbarText 色）。
      final dot = find.byWidgetPredicate(
        (w) =>
            w is Container &&
            w.decoration is BoxDecoration &&
            (w.decoration as BoxDecoration).shape == BoxShape.circle &&
            (w.decoration as BoxDecoration).color == QfPalette.probeOk,
      );
      expect(dot, findsOneWidget);
      final dotDec =
          (tester.widget<Container>(dot).decoration as BoxDecoration);
      expect((dotDec.border as Border).top.color, light.toolbarText);
      // 更新徽标点：9px 圆，色＝toolbarBadge（浅 brand 黑）。
      // 注意：徽标点是 DecoratedBox，不是 Container。
      final badge = find.byWidgetPredicate(
        (w) =>
            w is DecoratedBox &&
            w.decoration is BoxDecoration &&
            (w.decoration as BoxDecoration).shape == BoxShape.circle &&
            (w.decoration as BoxDecoration).color == light.toolbarBadge,
      );
      expect(badge, findsOneWidget);
      // 更多菜单图标走 toolbarIcon。
      final more = tester.widget<Icon>(find.byIcon(Icons.more_vert));
      expect(more.color, light.toolbarIcon);
    });

    testWidgets('底部 tab：高 64、标签 12sp、选中 filled＋w600、未激活三级灰',
        (tester) async {
      await tester.pumpWidget(MaterialApp(
        theme: QfTheme.light(),
        home: Scaffold(
          body: Column(
            children: [
              const Expanded(child: SizedBox()),
              QfTabBar(
                palette: light,
                active: AppSlot.home,
                onSelect: (_) {},
              ),
            ],
          ),
        ),
      ));
      await tester.pump();
      expect(tester.takeException(), isNull);
      final size = tester.getSize(find.byType(QfTabBar));
      expect(size.height, 64);
      // 选中项用 filled 图标＋w600。
      expect(find.byIcon(Icons.home), findsOneWidget);
      expect(find.byIcon(Icons.home_outlined), findsNothing);
      final homeLabel = tester.widget<Text>(find.text('首页'));
      expect(homeLabel.style?.fontSize, 12);
      expect(homeLabel.style?.fontWeight, FontWeight.w600);
      // 未激活项用 outlined 图标＋三级灰＋w500。
      expect(find.byIcon(Icons.folder_outlined), findsOneWidget);
      expect(find.byIcon(Icons.folder), findsNothing);
      final filesLabel = tester.widget<Text>(find.text('文件'));
      expect(filesLabel.style?.fontSize, 12);
      expect(filesLabel.style?.color, light.textTertiary);
      expect(filesLabel.style?.fontWeight, FontWeight.w500);
    });

    testWidgets('子页顶栏：标题＋返回图标走 toolbar token', (tester) async {
      await tester.pumpWidget(MaterialApp(
        theme: QfTheme.light(),
        home: Scaffold(
          body: QfPageHeader(
            palette: light,
            title: '设置',
            onBack: () {},
          ),
        ),
      ));
      await tester.pump();
      expect(tester.takeException(), isNull);
      final title = tester.widget<Text>(find.text('设置'));
      expect(title.style?.color, light.toolbarText);
      final back = tester.widget<Icon>(find.byIcon(Icons.arrow_back_ios_new));
      expect(back.color, light.toolbarIcon);
    });
  });

  group('A5 看护状态行：浅色 surface1 底＋textPrimary 字＋底边', () {
    testWidgets('浅色可见时底 surface1、字 textPrimary、有 1px 底边', (tester) async {
      await tester.pumpWidget(MaterialApp(
        theme: QfTheme.light(),
        home: Scaffold(
          body: WatchdogStatusLine(visible: true, palette: light),
        ),
      ));
      await tester.pump();
      expect(tester.takeException(), isNull);
      final line = find.byWidgetPredicate(
        (w) =>
            w is AnimatedContainer &&
            w.decoration is BoxDecoration &&
            (w.decoration as BoxDecoration).color == light.surface1,
      );
      expect(line, findsOneWidget);
      final dec =
          (tester.widget<AnimatedContainer>(line).decoration as BoxDecoration);
      expect((dec.border as Border).bottom.color, light.lineDefault);
      final text = tester.widget<Text>(find.text('连接断开，正在重连…'));
      expect(text.style?.color, light.textPrimary);
    });
  });

  group('A9 深色模式副文案按当前档动态化', () {
    Future<void> pumpSettings(
        WidgetTester tester, ThemeChoice choice) async {
      await tester.pumpWidget(MaterialApp(
        home: SettingsPage(
          palette: light,
          themeChoice: choice,
          rememberDevice: true,
          rememberPassword: false,
          currentVersion: '3.0.0',
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
    }

    testWidgets('跟随系统→“跟随系统深浅”', (tester) async {
      await pumpSettings(tester, ThemeChoice.followSystem);
      expect(find.text('跟随系统深浅'), findsOneWidget);
      expect(find.text('黑底白字'), findsNothing);
    });

    testWidgets('浅色→“白底黑字”', (tester) async {
      await pumpSettings(tester, ThemeChoice.blue);
      expect(find.text('白底黑字'), findsOneWidget);
    });

    testWidgets('深色→“黑底白字”', (tester) async {
      await pumpSettings(tester, ThemeChoice.dark);
      expect(find.text('黑底白字'), findsOneWidget);
    });
  });
}
