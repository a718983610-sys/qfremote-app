import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:qfremote/ui/reduced_motion.dart';
import 'package:qfremote/ui/theme.dart';

/// 六项定夺⑤ Reduced motion 原生层接线测试（2026-11-14）。
/// 信号源：MediaQuery.disableAnimations（系统“移除动画”经 WidgetsApp
/// 进入的平台投影）；本文件用 MediaQueryData(disableAnimations: …)
/// 模拟该信号，验证各取值点读到同一值并归零。
/// 注意：主题层 QfMotion 常量只是兜底，不能替代本接线，故此处不断言
/// 常量值，只断言接线行为。
void main() {
  Widget wrap(Widget child, {required bool disableAnimations}) {
    return MaterialApp(
      theme: QfTheme.light(),
      home: MediaQuery(
        data: MediaQueryData(disableAnimations: disableAnimations),
        child: Scaffold(body: child),
      ),
    );
  }

  group('QfMotion.resolve / isReducedMotion', () {
    testWidgets('开启时归零，关闭时原值', (tester) async {
      var sawReduced = false;
      Duration? sawDuration;
      await tester.pumpWidget(wrap(
        Builder(builder: (context) {
          sawReduced = QfMotion.isReducedMotion(context);
          sawDuration =
              QfMotion.resolve(context, QfMotion.medium);
          return const SizedBox();
        }),
        disableAnimations: true,
      ));
      expect(sawReduced, isTrue);
      expect(sawDuration, Duration.zero);

      await tester.pumpWidget(wrap(
        Builder(builder: (context) {
          sawReduced = QfMotion.isReducedMotion(context);
          sawDuration =
              QfMotion.resolve(context, QfMotion.medium);
          return const SizedBox();
        }),
        disableAnimations: false,
      ));
      expect(sawReduced, isFalse);
      expect(sawDuration, QfMotion.medium);
    });
  });

  group('QfPageTransitionsBuilder（路由转场）', () {
    testWidgets('开启时直接返回子页面，关闭时走默认转场', (tester) async {
      const builder = QfPageTransitionsBuilder();
      const child = SizedBox(key: Key('page'));
      late Widget outDisabled;
      late Widget outEnabled;

      await tester.pumpWidget(wrap(
        Builder(builder: (context) {
          final route = MaterialPageRoute<void>(
            builder: (_) => const SizedBox(),
          );
          outDisabled = builder.buildTransitions(
            route,
            context,
            const AlwaysStoppedAnimation<double>(1.0),
            const AlwaysStoppedAnimation<double>(0.0),
            child,
          );
          return const SizedBox();
        }),
        disableAnimations: true,
      ));
      // 开启时零时长直出：返回的就是 child 本身（同一对象）。
      expect(identical(outDisabled, child), isTrue);

      await tester.pumpWidget(wrap(
        Builder(builder: (context) {
          final route = MaterialPageRoute<void>(
            builder: (_) => const SizedBox(),
          );
          outEnabled = builder.buildTransitions(
            route,
            context,
            const AlwaysStoppedAnimation<double>(1.0),
            const AlwaysStoppedAnimation<double>(0.0),
            child,
          );
          return const SizedBox();
        }),
        disableAnimations: false,
      ));
      // 关闭时走默认转场：返回包装后的 widget，不是 child 本身。
      expect(identical(outEnabled, child), isFalse);
    });
  });

  group('QfLoadingIndicator / QfLoadingBar（加载动画）', () {
    testWidgets('圆圈：开启时定值弧线，关闭时 900ms linear 旋转定值弧线（F-A4 返工）', (tester) async {
      await tester.pumpWidget(wrap(
        const QfLoadingIndicator(color: Colors.black),
        disableAnimations: true,
      ));
      final disabled =
          tester.widget<CircularProgressIndicator>(
              find.byType(CircularProgressIndicator));
      expect(disabled.value, 0.5);

      await tester.pumpWidget(wrap(
        const QfLoadingIndicator(color: Colors.black),
        disableAnimations: false,
      ));
      // B §3.3：900ms linear——RotationTransition 驱动 1/4 圈定值弧线，
      // 不再用 CircularProgressIndicator 默认不定值旋转（周期不可控）。
      final rotation = tester.widget<RotationTransition>(find.descendant(
          of: find.byType(QfLoadingIndicator),
          matching: find.byType(RotationTransition)));
      expect((rotation.turns as AnimationController).duration,
          QfMotion.spinnerPeriod);
      final enabled =
          tester.widget<CircularProgressIndicator>(find.descendant(
              of: find.byType(QfLoadingIndicator),
              matching: find.byType(CircularProgressIndicator)));
      expect(enabled.value, 0.25);
    });

    testWidgets('横条：不定条开启时静止空轨，已知进度原样透传',
        (tester) async {
      await tester.pumpWidget(wrap(
        const QfLoadingBar(color: Colors.black),
        disableAnimations: true,
      ));
      expect(
        tester
            .widget<LinearProgressIndicator>(
                find.byType(LinearProgressIndicator))
            .value,
        0,
      );

      await tester.pumpWidget(wrap(
        const QfLoadingBar(color: Colors.black),
        disableAnimations: false,
      ));
      expect(
        tester
            .widget<LinearProgressIndicator>(
                find.byType(LinearProgressIndicator))
            .value,
        isNull,
      );

      await tester.pumpWidget(wrap(
        const QfLoadingBar(value: 0.3, color: Colors.black),
        disableAnimations: true,
      ));
      expect(
        tester
            .widget<LinearProgressIndicator>(
                find.byType(LinearProgressIndicator))
            .value,
        0.3,
      );
    });
  });

  group('showQfDialog（对话框）', () {
    // B 重做 §3.3／§6.3：正常进入 D3=170ms、退出 130ms（F-A1 返工），
    // reduced motion 时 80ms opacity（B 允许 ≤100ms 或 instant，
    // 本线取 80ms）。
    testWidgets('开启时进出时长为 80ms，关闭时进入 D3=170ms、退出 130ms', (tester) async {
      Duration? seenDisabled;
      Duration? seenEnabled;
      Duration? seenDisabledReverse;
      Duration? seenEnabledReverse;

      Future<void> open({required bool disableAnimations}) async {
        await tester.pumpWidget(
          MaterialApp(
            theme: QfTheme.light(),
            home: MediaQuery(
              data: MediaQueryData(disableAnimations: disableAnimations),
              child: Scaffold(
                body: Builder(builder: (context) {
                  return FilledButton(
                    onPressed: () {
                      unawaited(showQfDialog<void>(
                        context: context,
                        builder: (dialogContext) {
                          final route = ModalRoute.of(dialogContext);
                          if (disableAnimations) {
                            seenDisabled = route?.transitionDuration;
                            seenDisabledReverse =
                                route?.reverseTransitionDuration;
                          } else {
                            seenEnabled = route?.transitionDuration;
                            seenEnabledReverse =
                                route?.reverseTransitionDuration;
                          }
                          return const AlertDialog(
                              title: Text('标题'), content: Text('内容'));
                        },
                      ));
                    },
                    child: const Text('打开'),
                  );
                }),
              ),
            ),
          ),
        );
        await tester.tap(find.text('打开'));
        await tester.pump();
        expect(find.text('标题'), findsOneWidget);
        await tester.tapAt(const Offset(10, 10));
        await tester.pumpAndSettle();
      }

      await open(disableAnimations: true);
      expect(seenDisabled, QfMotion.reducedOpacity);
      expect(seenDisabledReverse, QfMotion.reducedOpacity);

      await open(disableAnimations: false);
      expect(seenEnabled, QfMotion.d3);
      expect(seenEnabledReverse, QfMotion.dialogExit);
      expect(seenEnabledReverse!.inMilliseconds, 130);
    });
  });
}
