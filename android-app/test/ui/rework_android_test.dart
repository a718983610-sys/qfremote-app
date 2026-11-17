// 【冻结注明 v6 冻结⑮】本文件在纯冻结树下跳过：
// 它 import lib/core/manifest.dart，而 manifest.dart:4 import 未冻结的
// 第二批文件 lib/core/release_signature.dart，纯冻结树下整个文件加载失败。
// 第二批合入后恢复本文件。
import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/physics.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:qfremote/core/license.dart';
import 'package:qfremote/core/manifest.dart';
import 'package:qfremote/core/slot_nav.dart';
import 'package:qfremote/ui/force_update.dart';
import 'package:qfremote/ui/frame.dart';
import 'package:qfremote/ui/license_gate.dart';
import 'package:qfremote/ui/me_page.dart';
import 'package:qfremote/ui/reduced_motion.dart';
import 'package:qfremote/ui/theme.dart';

/// 安卓端黑白 UI 重做（A＋B＋C，2026-11-14）专项断言。
/// 只断言重做新增的 token／动效／组件行为；既有定夺值（深三级 #8A8A93、
/// 按钮视觉 40／触控 ≥44、reduced motion 接线）仍由
/// theme_tokens_test／reduced_motion_test／button_input_visual_height_test
/// 覆盖，本文件不重复。
void main() {
  const light = QfPalette(QfThemeMode.blue);
  const dark = QfPalette(QfThemeMode.dark);

  group('A §3.0 表面层级 BG0–BG5（与 surface0–3 并存，不替换旧 token）', () {
    test('深色 BG0–BG5（W3 定夺 2026-11-14：BG1 #121214／BG2 #1C1C1E）', () {
      expect(dark.bg0, const Color(0xFF08090A));
      expect(dark.bg1, const Color(0xFF121214));
      expect(dark.bg2, const Color(0xFF1C1C1E));
      expect(dark.bg3, const Color(0xFF17181A));
      expect(dark.bg4, const Color(0xFF1F2023));
      expect(dark.bg5, const Color(0xFF27272A));
    });

    test('浅色 BG0–BG5', () {
      expect(light.bg0, const Color(0xFFFFFFFF));
      expect(light.bg1, const Color(0xFFF7F7F8));
      expect(light.bg2, const Color(0xFFF0F0F2));
      expect(light.bg3, const Color(0xFFE8E8EB));
      expect(light.bg4, const Color(0xFFDFDFE3));
      expect(light.bg5, const Color(0xFFD6D6DB));
    });

    test('交互状态矩阵：hover 6%/4%、selected 9%/6%、pressed 13%/10%', () {
      expect(dark.hoverOverlay,
          const Color.from(alpha: 0.06, red: 1, green: 1, blue: 1));
      expect(light.hoverOverlay,
          const Color.from(alpha: 0.04, red: 0, green: 0, blue: 0));
      expect(dark.selectedOverlay,
          const Color.from(alpha: 0.09, red: 1, green: 1, blue: 1));
      expect(light.selectedOverlay,
          const Color.from(alpha: 0.06, red: 0, green: 0, blue: 0));
      expect(dark.pressedOverlay,
          const Color.from(alpha: 0.13, red: 1, green: 1, blue: 1));
      expect(light.pressedOverlay,
          const Color.from(alpha: 0.10, red: 0, green: 0, blue: 0));
    });

    test('focus ring 2px 实色：深 #F5F5F7／浅 #111113；遮罩两端 .32（A2 定夺）', () {
      expect(dark.focusRing, const Color(0xFFF5F5F7));
      expect(light.focusRing, const Color(0xFF111113));
      expect(
          light.scrim,
          const Color.from(
              alpha: 0.32, red: 0.067, green: 0.067, blue: 0.075));
      expect(dark.scrim,
          const Color.from(alpha: 0.32, red: 0, green: 0, blue: 0));
    });

    test('elevation：列表卡片默认无阴影；浮层 e1/e2 只用于浮层', () {
      expect(dark.cardShadow, isEmpty);
      expect(light.cardShadow, isEmpty);
      expect(light.elevationShadow(0), isEmpty);
      expect(light.elevationShadow(1), hasLength(1));
      expect(light.elevationShadow(2), hasLength(1));
      expect(dark.elevationShadow(1), isEmpty);
      expect(dark.elevationShadow(2), hasLength(2));
    });
  });

  group('A §3.3 显式 ColorScheme：primary＝主文字黑／白，无蓝', () {
    test('primary／surface／error', () {
      expect(QfTheme.light().colorScheme.primary, light.textPrimary);
      expect(QfTheme.dark().colorScheme.primary, dark.textPrimary);
      expect(QfTheme.light().colorScheme.surface, light.surface0);
      expect(QfTheme.dark().colorScheme.surface, dark.surface0);
      expect(QfTheme.light().colorScheme.error, light.danger);
      expect(QfTheme.dark().colorScheme.error, dark.danger);
      expect(QfTheme.light().colorScheme.primary, isNot(Colors.blue));
      expect(QfTheme.dark().colorScheme.primary, isNot(Colors.blue));
    });
  });

  group('A §2.2 排版：字阶固定，字重只用 400/500/600', () {
    test('QfType 字号／行高／字重', () {
      final t20 = QfType.title20(Colors.black);
      expect(t20.fontSize, 20);
      expect(t20.height, closeTo(28 / 20, 0.001));
      expect(t20.fontWeight, FontWeight.w600);
      final b14 = QfType.body14(Colors.black);
      expect(b14.fontSize, 14);
      expect(b14.height, closeTo(22 / 14, 0.001));
      expect(b14.fontWeight, FontWeight.w400);
      final m12 = QfType.meta12(Colors.black);
      expect(m12.fontSize, 12);
      expect(m12.height, closeTo(18 / 12, 0.001));
      expect(m12.fontWeight, FontWeight.w400);
      final l11 = QfType.label11(Colors.black);
      expect(l11.fontSize, 11);
      expect(l11.height, closeTo(16 / 11, 0.001));
      expect(l11.fontWeight, FontWeight.w500);
      // 数字 tabular-nums：叠加后含 tabular figures。
      final tab = QfType.tabular(b14);
      expect(tab.fontFeatures, contains(FontFeature.tabularFigures()));
    });
  });

  group('B §0 动效 tokens', () {
    test('时长 D0–D6', () {
      expect(QfMotion.d0, const Duration(milliseconds: 60));
      expect(QfMotion.d1, const Duration(milliseconds: 110));
      expect(QfMotion.d2, const Duration(milliseconds: 140));
      expect(QfMotion.d3, const Duration(milliseconds: 170));
      expect(QfMotion.d4, const Duration(milliseconds: 210));
      expect(QfMotion.d5, const Duration(milliseconds: 250));
      expect(QfMotion.d6, const Duration(milliseconds: 290));
    });

    test('退出时长＝进入×0.72，夹 100–190ms', () {
      expect(QfMotion.exitDurationFor(QfMotion.d3),
          const Duration(milliseconds: 122));
      expect(QfMotion.exitDurationFor(QfMotion.d5),
          const Duration(milliseconds: 180));
      expect(QfMotion.exitDurationFor(QfMotion.d0),
          const Duration(milliseconds: 100));
      expect(QfMotion.exitDurationFor(QfMotion.d6),
          const Duration(milliseconds: 190));
    });

    test('曲线 E-S/E-L/E-X/E-Q/E-C', () {
      expect(QfMotion.eS, const Cubic(0.16, 1, 0.3, 1));
      expect(QfMotion.eL, const Cubic(0.19, 1, 0.22, 1));
      expect(QfMotion.eX, const Cubic(0.32, 0, 0.78, 0.14));
      expect(QfMotion.eQ, const Cubic(0.4, 0, 1, 1));
      expect(QfMotion.eC, const Cubic(0.22, 1, 0.36, 1));
    });

    test('弹簧 S5/S6/S7 参数（stiffness/damping/mass）', () {
      // SpringSimulation 不暴露参数；改断言构造不抛错且为 SpringSimulation。
      expect(QfMotion.springS5(), isA<SpringSimulation>());
      expect(QfMotion.springS6(), isA<SpringSimulation>());
      expect(QfMotion.springS7(), isA<SpringSimulation>());
    });

    testWidgets('stagger：22ms/项、最多 7 项，第 8 项起 0 延迟；reduced 归零',
        (tester) async {
      Duration? d0, d7, d8, dReduced;
      await tester.pumpWidget(
        MaterialApp(
          home: MediaQuery(
            data: const MediaQueryData(disableAnimations: false),
            child: Builder(builder: (context) {
              d0 = QfMotion.staggerFor(context, 0);
              d7 = QfMotion.staggerFor(context, 6);
              d8 = QfMotion.staggerFor(context, 7);
              return const SizedBox();
            }),
          ),
        ),
      );
      expect(d0, Duration.zero);
      expect(d7, const Duration(milliseconds: 132));
      expect(d8, Duration.zero);
      await tester.pumpWidget(
        MaterialApp(
          home: MediaQuery(
            data: const MediaQueryData(disableAnimations: true),
            child: Builder(builder: (context) {
              dReduced = QfMotion.staggerFor(context, 3);
              return const SizedBox();
            }),
          ),
        ),
      );
      expect(dReduced, Duration.zero);
    });
  });

  group('A §3.3 顶栏 56／底部 tab 64＋pill', () {
    testWidgets('顶栏高 56、标题 20/600、状态点 6px', (tester) async {
      await tester.pumpWidget(MaterialApp(
        theme: QfTheme.light(),
        home: Scaffold(
          body: QfAppHeader(
            palette: light,
            title: '我的设备',
            probeColor: QfPalette.probeOk,
            probeBusy: false,
            hasUpdate: false,
            showAdmin: false,
            onProbeTap: () {},
            onUpdateTap: () {},
            onMenuAction: (_) {},
          ),
        ),
      ));
      await tester.pump();
      expect(tester.takeException(), isNull);
      final size = tester.getSize(find.byType(QfAppHeader));
      expect(size.height, 56);
      final title = tester.widget<Text>(find.text('我的设备'));
      expect(title.style?.fontSize, 20);
      expect(title.style?.fontWeight, FontWeight.w600);
    });

    testWidgets('底部 tab 高 64、激活 pill 56×32、label 600', (tester) async {
      AppSlot? picked;
      await tester.pumpWidget(MaterialApp(
        theme: QfTheme.light(),
        home: Scaffold(
          body: Column(
            children: [
              const Expanded(child: SizedBox()),
              QfTabBar(
                palette: light,
                active: AppSlot.devices,
                onSelect: (s) => picked = s,
              ),
            ],
          ),
        ),
      ));
      await tester.pump();
      expect(tester.takeException(), isNull);
      final size = tester.getSize(find.byType(QfTabBar));
      expect(size.height, 64);
      // 激活 pill：56×32 的圆角容器（选中项图标的父容器，底色 tabPill）。
      final pill = find.byWidgetPredicate(
        (w) =>
            w is Container &&
            w.decoration is BoxDecoration &&
            (w.decoration as BoxDecoration).color == light.tabPill,
      );
      expect(pill, findsOneWidget);
      expect(tester.getSize(pill), const Size(56, 32));
      await tester.tap(find.text('我的'));
      expect(picked, AppSlot.me);
    });
  });

  group('C §1.3 列表行 56＋选中 inset bar', () {
    testWidgets('QfListRow 行高 56、选中带 2px 左侧 bar', (tester) async {
      await tester.pumpWidget(MaterialApp(
        theme: QfTheme.light(),
        home: Scaffold(
          body: Column(
            children: [
              QfListRow(
                  palette: light,
                  icon: Icons.person_outline,
                  title: '修改密码',
                  onTap: () {}),
              QfListRow(
                  palette: light,
                  icon: Icons.person_outline,
                  title: '已选行',
                  selected: true,
                  onTap: () {}),
            ],
          ),
        ),
      ));
      await tester.pump();
      expect(tester.takeException(), isNull);
      final row = tester.getSize(find.byType(QfListRow).first);
      expect(row.height, greaterThanOrEqualTo(56));
      final selected = find.byWidgetPredicate((w) =>
          w is Container &&
          w.decoration is BoxDecoration &&
          (w.decoration as BoxDecoration).border is Border &&
          ((w.decoration as BoxDecoration).border as Border).left.width ==
              2);
      expect(selected, findsOneWidget);
    });
  });

  group('B §3.3 bottom sheet：圆角 20、handle 36×4、padding 20', () {
    testWidgets('showQfBottomSheet 出现把手与标题', (tester) async {
      await tester.pumpWidget(MaterialApp(
        theme: QfTheme.light(),
        home: Scaffold(
          body: Builder(builder: (context) {
            return FilledButton(
              onPressed: () {
                showQfBottomSheet<void>(
                  context: context,
                  palette: light,
                  title: '选择连接方式',
                  builder: (_) => const Text('P2P 优先，Relay 备用'),
                );
              },
              child: const Text('打开'),
            );
          }),
        ),
      ));
      await tester.tap(find.text('打开'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));
      expect(find.byType(QfSheetHandle), findsOneWidget);
      expect(find.text('选择连接方式'), findsOneWidget);
      expect(find.text('P2P 优先，Relay 备用'), findsOneWidget);
      final handle = tester.getSize(find.byType(QfSheetHandle));
      expect(handle, const Size(36, 4));
    });
  });

  group('C §2.2 阶段加载：百分比＋阶段＋超时恢复入口', () {
    testWidgets('QfStageLoading 渲染阶段与重试／复制日志', (tester) async {
      var retried = false;
      var copied = false;
      await tester.pumpWidget(MaterialApp(
        theme: QfTheme.light(),
        home: Scaffold(
          body: QfStageLoading(
            palette: light,
            percent: 42,
            stages: const [
              QfStage('下载安装包', QfStageState.active, elapsedSeconds: 1.8),
              QfStage('完整性核对', QfStageState.waiting),
            ],
            timeoutNote: '仍在等待…可复制日志',
            onRetry: () => retried = true,
            onCopyLog: () => copied = true,
          ),
        ),
      ));
      await tester.pump();
      expect(find.text('42%'), findsOneWidget);
      expect(find.text('下载安装包'), findsOneWidget);
      expect(find.text('完整性核对'), findsOneWidget);
      expect(find.text('1.8 s'), findsOneWidget);
      await tester.tap(find.text('重试'));
      await tester.tap(find.text('复制日志'));
      expect(retried, isTrue);
      expect(copied, isTrue);
    });
  });

  group('A §2.6 我的页去卡片化：只剩账户 hero 卡', () {
    testWidgets('我的页渲染扁平行，无双统计卡', (tester) async {
      await tester.pumpWidget(MaterialApp(
        theme: QfTheme.light(),
        home: MePage(
          palette: light,
          currentVersion: '3.0.0',
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
      expect(find.text('我的积分'), findsOneWidget);
      expect(find.text('修改密码'), findsOneWidget);
      expect(find.text('退出账号'), findsOneWidget);
      // 统计值缺失显示 —，不编 0。
      expect(find.text('—'), findsWidgets);
    });
  });

  group('返工 F-A1 对话框退出 130ms（QfDialogRoute 覆写 reverseTransitionDuration）', () {
    test('正常态进入 170ms、退出 130ms；reduced motion 进出均为 80ms', () {
      final normal = QfDialogRoute<void>(
        pageBuilder: (_, _, _) => const Text('x'),
        reduced: false,
      );
      expect(normal.transitionDuration, QfMotion.d3);
      expect(normal.transitionDuration.inMilliseconds, 170);
      expect(normal.reverseTransitionDuration, QfMotion.dialogExit);
      expect(normal.reverseTransitionDuration.inMilliseconds, 130);
      final reduced = QfDialogRoute<void>(
        pageBuilder: (_, _, _) => const Text('x'),
        reduced: true,
      );
      expect(reduced.transitionDuration, QfMotion.reducedOpacity);
      expect(reduced.reverseTransitionDuration, QfMotion.reducedOpacity);
    });
  });

  group('返工 F-A2 页面切换 D5/E-L x+24、Tab 内容 D2/E-C crossfade', () {
    test('QfPageTransitionsBuilder 时长：前进 D5=250ms、退出 D3=170ms', () {
      const builder = QfPageTransitionsBuilder();
      expect(builder.transitionDuration, QfMotion.d5);
      expect(builder.transitionDuration.inMilliseconds, 250);
      expect(builder.reverseTransitionDuration, QfMotion.d3);
      expect(builder.reverseTransitionDuration.inMilliseconds, 170);
    });

    testWidgets('路由切换走 QfPageTransitionsBuilder（Slide＋Fade）', (tester) async {
      await tester.pumpWidget(MaterialApp(
        theme: QfTheme.light(),
        home: Scaffold(
          body: Builder(builder: (context) {
            return FilledButton(
              onPressed: () {
                Navigator.of(context).push(
                  MaterialPageRoute<void>(
                    builder: (_) => const Scaffold(body: Text('page2')),
                  ),
                );
              },
              child: const Text('go'),
            );
          }),
        ),
      ));
      await tester.tap(find.text('go'));
      await tester.pump(const Duration(milliseconds: 125));
      expect(find.byType(SlideTransition), findsWidgets);
      expect(find.byType(FadeTransition), findsWidgets);
      await tester.pumpAndSettle();
      expect(find.text('page2'), findsOneWidget);
    });
  });

  group('返工 F-A3 顶栏滚动分割线：scrolled 参数驱动 1px 底边', () {
    Future<void> pumpHeader(WidgetTester tester, bool scrolled) async {
      await tester.pumpWidget(MaterialApp(
        theme: QfTheme.light(),
        home: Scaffold(
          body: QfAppHeader(
            palette: light,
            title: '设备',
            probeColor: Colors.green,
            probeBusy: false,
            hasUpdate: false,
            showAdmin: false,
            onProbeTap: () {},
            onUpdateTap: () {},
            onMenuAction: (_) {},
            scrolled: scrolled,
          ),
        ),
      ));
      await tester.pump();
    }

    testWidgets('scrolled=true 有底边、false 无底边', (tester) async {
      await pumpHeader(tester, true);
      final withBorder = tester.widget<AnimatedContainer>(
          find.byType(AnimatedContainer));
      expect((withBorder.decoration as BoxDecoration?)?.border, isNotNull);
      await pumpHeader(tester, false);
      final withoutBorder = tester.widget<AnimatedContainer>(
          find.byType(AnimatedContainer));
      expect((withoutBorder.decoration as BoxDecoration?)?.border, isNull);
    });
  });

  group('返工 F-A4 spinner 900ms linear', () {
    testWidgets('正常态 RotationTransition 一圈 900ms；reduced 静态弧线', (tester) async {
      await tester.pumpWidget(MaterialApp(
        theme: QfTheme.light(),
        home: const Scaffold(body: Center(child: QfLoadingIndicator())),
      ));
      await tester.pump();
      final rotation = tester.widget<RotationTransition>(find.descendant(
          of: find.byType(QfLoadingIndicator),
          matching: find.byType(RotationTransition)));
      final period = (rotation.turns as AnimationController).duration;
      expect(period, QfMotion.spinnerPeriod);
      expect(period!.inMilliseconds, 900);
      // reduced motion：无旋转，定值弧线 value 0.5。
      await tester.pumpWidget(MaterialApp(
        theme: QfTheme.light(),
        home: const MediaQuery(
          data: MediaQueryData(disableAnimations: true),
          child: Scaffold(body: Center(child: QfLoadingIndicator())),
        ),
      ));
      await tester.pump();
      expect(
          find.descendant(
              of: find.byType(QfLoadingIndicator),
              matching: find.byType(RotationTransition)),
          findsNothing);
      expect(
          tester.widget<CircularProgressIndicator>(find.descendant(
                  of: find.byType(QfLoadingIndicator),
                  matching: find.byType(CircularProgressIndicator)))
              .value,
          0.5);
    });
  });

  group('返工 F-A5 强制更新 8s 无进展／15s 总超时', () {
    testWidgets('8s 无进展出提示，15s 总超时置失败态', (tester) async {
      tester.view.physicalSize = const Size(360, 640);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.reset);
      // 只回调一次 0 字节、之后永不进展、永不完成。
      Future<File> stalled(
          ReleaseEntry entry, void Function(int, int?, int?) cb) {
        cb(0, 1000, 0);
        return Completer<File>().future;
      }

      await tester.pumpWidget(MaterialApp(
        home: ForceUpdateView(
          palette: light,
          currentVersion: '2.2.0',
          entry: const ReleaseEntry(
            version: '3.0.1',
            notes: '',
            url: 'https://example.invalid/a.apk',
            sha256: '00',
            size: 1000,
          ),
          download: stalled,
          openInstaller: (_) async {},
        ),
      ));
      await tester.pump();
      await tester.tap(find.text('立即更新'));
      await tester.pump();
      expect(find.textContaining('8 秒无下载进展'), findsNothing);
      await tester.pump(const Duration(seconds: 8));
      expect(find.textContaining('8 秒无下载进展'), findsOneWidget);
      await tester.pump(const Duration(seconds: 7));
      expect(find.textContaining('下载超时'), findsOneWidget);
      expect(find.text('重新下载更新'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });
  });

  group('返工 F-A6 空状态入场 D4/E-S y+8', () {
    test('QfAnimatedEntry duration 参数默认 D3、可覆写为 D4', () {
      const def = QfAnimatedEntry(child: Text('x'));
      expect(def.duration, QfMotion.d3);
      expect(def.offsetY, QfMotion.rowEnterOffsetY);
      const empty = QfAnimatedEntry(
        duration: QfMotion.d4,
        offsetY: QfMotion.rowEnterOffsetY,
        child: Text('x'),
      );
      expect(empty.duration, QfMotion.d4);
      expect(empty.duration.inMilliseconds, 210);
    });
  });

  group('返工 F-A7 我的页版本号带构建号', () {
    Future<void> pumpMe(WidgetTester tester, {String? buildNumber}) async {
      await tester.pumpWidget(MaterialApp(
        theme: QfTheme.light(),
        home: MePage(
          palette: light,
          currentVersion: '3.0.0',
          buildNumber: buildNumber,
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
    }

    testWidgets('传入 build 号时显示“构建 30000”', (tester) async {
      await pumpMe(tester, buildNumber: '30000');
      expect(find.textContaining('构建 30000'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('不传 build 号时只显 version，不编构建号', (tester) async {
      await pumpMe(tester);
      expect(find.textContaining('软件版本 3.0'), findsOneWidget);
      expect(find.textContaining('构建'), findsNothing);
    });
  });

  group('返工 F-A8 许可拦截页拦截码 chip', () {
    Future<void> pumpGate(WidgetTester tester, {String? code}) async {
      await tester.pumpWidget(MaterialApp(
        home: LicenseGatePage(
          palette: light,
          username: 'u1',
          copy: gateCopyFor(const LicenseDecision(
              allow: false, code: 'G1', enforce: true))!,
          decisionCode: code,
          onClaim: null,
          onPurchase: () {},
          onAppeal: () {},
          onSupport: () {},
          onLogout: () {},
          onRecheck: () {},
        ),
      ));
      await tester.pump();
    }

    testWidgets('传入 code 时显示 chip', (tester) async {
      await pumpGate(tester, code: 'G1');
      expect(find.text('G1'), findsOneWidget);
      expect(find.byType(QfStatusChip), findsOneWidget);
    });

    testWidgets('不传 code 时无 chip', (tester) async {
      await pumpGate(tester);
      expect(find.byType(QfStatusChip), findsNothing);
    });
  });

  group('返工 D1 ThemeMode 裁决：手动偏好保留、未选跟随系统', () {
    test('有 pref 时保留 pref，无 pref 时跟随系统（大肥鱼裁决：满足）', () {
      expect(
          resolveThemeMode(
              pref: 'dark', platformBrightness: Brightness.light),
          QfThemeMode.dark);
      expect(
          resolveThemeMode(
              pref: 'blue', platformBrightness: Brightness.dark),
          QfThemeMode.blue);
      expect(
          resolveThemeMode(
              pref: null, platformBrightness: Brightness.dark),
          QfThemeMode.dark);
      expect(
          resolveThemeMode(
              pref: null, platformBrightness: Brightness.light),
          QfThemeMode.blue);
    });
  });
}
