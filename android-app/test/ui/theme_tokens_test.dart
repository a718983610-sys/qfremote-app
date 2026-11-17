import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:qfremote/app/design_tokens.dart';
import 'package:qfremote/ui/core/widgets.dart';
import 'package:qfremote/ui/theme.dart';

/// 三端 UI 重构 Q3c：主题 token 断言（2026-11-13）。
/// 只断言表现层 token 与展示面版本，不碰业务逻辑。
void main() {
  group('主色（定夺值：浅纯黑／深纯白，品牌蓝已退役）', () {
    test('QfPalette.brand 是实例 token：浅 #000000、深 #FFFFFF', () {
      expect(const QfPalette(QfThemeMode.blue).brand,
          const Color(0xFF000000));
      expect(const QfPalette(QfThemeMode.dark).brand,
          const Color(0xFFFFFFFF));
      expect(const QfPalette(QfThemeMode.blue).onBrand,
          const Color(0xFFFFFFFF));
      expect(const QfPalette(QfThemeMode.dark).onBrand,
          const Color(0xFF000000));
    });

    test('brandCssHex 由 brand 派生', () {
      expect(const QfPalette(QfThemeMode.blue).brandCssHex, '#000000');
      expect(const QfPalette(QfThemeMode.dark).brandCssHex, '#FFFFFF');
      // 派生关系：改 brand 则 CSS hex 跟着变（不许第二处字面量）。
      const light = QfPalette(QfThemeMode.blue);
      final hex = light.brand
          .toARGB32()
          .toRadixString(16)
          .substring(2)
          .toUpperCase();
      expect(light.brandCssHex, '#$hex');
    });

    test('两套 ThemeData 用显式 ColorScheme：primary 即主文字黑／白（禁蓝）', () {
      // A 重做 §3.3：不用 fromSeed 推导——fromSeed 会按色调推导 primary
      // （≠主色原值）；primary 直接映射主文字（浅 #09090B／深 #F7F7F8）。
      const lightPal = QfPalette(QfThemeMode.blue);
      const darkPal = QfPalette(QfThemeMode.dark);
      expect(QfTheme.light().colorScheme.primary, lightPal.textPrimary);
      expect(QfTheme.dark().colorScheme.primary, darkPal.textPrimary);
      expect(QfTheme.light().colorScheme.primary,
          const Color(0xFF09090B));
      expect(QfTheme.dark().colorScheme.primary,
          const Color(0xFFF7F7F8));
      final filledBg = QfTheme.light()
          .filledButtonTheme
          .style
          ?.backgroundColor
          ?.resolve({});
      expect(filledBg, lightPal.brand);
    });
  });

  group('Q1b 色板（深色／浅色）', () {
    test('深色表面阶梯与文字（定夺 token）', () {
      const p = QfPalette(QfThemeMode.dark);
      expect(p.pageColor, const Color(0xFF08090A));
      expect(p.cardColor, const Color(0xFF111113));
      expect(p.surface1, const Color(0xFF111113));
      expect(p.surface2, const Color(0xFF18181B));
      expect(p.surface3, const Color(0xFF18181B));
      expect(p.onCard, const Color(0xFFF7F7F8));
      expect(p.onCardDim, const Color(0xFFA1A1AA));
      expect(p.textTertiary, const Color(0xFF8A8A93));
      expect(p.textDisabled, const Color(0xFF52525B));
      expect(p.lineDefault, const Color(0xFF27272A));
      expect(p.lineStrong, const Color(0xFF3F3F46));
    });

    test('浅色表面阶梯与文字（定夺 token）', () {
      const p = QfPalette(QfThemeMode.blue);
      expect(p.pageColor, const Color(0xFFFFFFFF));
      expect(p.cardColor, Colors.white);
      expect(p.surface1, const Color(0xFFF7F7F8));
      expect(p.surface2, const Color(0xFFEFEFF1));
      expect(p.onCard, const Color(0xFF09090B));
      expect(p.onCardDim, const Color(0xFF52525B));
      expect(p.textTertiary, const Color(0xFF71717A));
      expect(p.textDisabled, const Color(0xFFA1A1AA));
      expect(p.lineDefault, const Color(0xFFE4E4E7));
      expect(p.lineStrong, const Color(0xFFD4D4D8));
    });

    test('状态色按 2026-11-15 定稿 B 组：成功绿 #16A34A／#22C55E、未激活橙、登出红', () {
      const dark = QfPalette(QfThemeMode.dark);
      const light = QfPalette(QfThemeMode.blue);
      expect(dark.success, const Color(0xFF22C55E));
      expect(light.success, const Color(0xFF16A34A));
      expect(dark.warning, const Color(0xFFFB923C));
      expect(light.warning, const Color(0xFFEA580C));
      expect(dark.danger, const Color(0xFFF87171));
      expect(light.danger, const Color(0xFFDC2626));
      // A 组旧值已废止，不得再出现。
      expect(dark.success, isNot(const Color(0xFF30D158)));
      expect(light.success, isNot(const Color(0xFF15803D)));
      expect(dark.warning, isNot(const Color(0xFFFF9F0A)));
      expect(light.warning, isNot(const Color(0xFFB45309)));
      expect(dark.danger, isNot(const Color(0xFFFF453A)));
      expect(dark.success, isNot(const Color(0xFF1F9D63)));
      expect(dark.success, isNot(const Color(0xFF12B76A)));
      // 离线中性灰两端同一值，只作非文本状态点。
      expect(light.statusOffline, const Color(0xFF6B7280));
      expect(dark.statusOffline, const Color(0xFF6B7280));
      // 探针状态色与语义色 B 组深色值同源（只落在黑白顶栏上）。
      expect(QfPalette.probeOk, const Color(0xFF22C55E));
      expect(QfPalette.probeBad, const Color(0xFFF87171));
      expect(QfPalette.probeBusy, const Color(0xFFFB923C));
    });

    test('链接不用蓝：主文字色＋下划线色；信息色用中性灰', () {
      const dark = QfPalette(QfThemeMode.dark);
      const light = QfPalette(QfThemeMode.blue);
      expect(light.link, const Color(0xFF09090B));
      expect(dark.link, const Color(0xFFFFFFFF));
      expect(light.linkUnderline, const Color(0xFFA1A1AA));
      expect(dark.linkUnderline, const Color(0xFF52525B));
      expect(light.linkCssHex, '#09090B');
      expect(dark.linkCssHex, '#FFFFFF');
      expect(light.linkUnderlineCssHex, '#A1A1AA');
      expect(dark.linkUnderlineCssHex, '#52525B');
      expect(light.info, const Color(0xFF3F3F46));
      expect(dark.info, const Color(0xFFD4D4D8));
    });

    test('深色阴影为 none（平涂口径）', () {
      const p = QfPalette(QfThemeMode.dark);
      expect(p.cardShadow, isEmpty);
    });
  });

  group('QfScale 关键 token', () {
    test('字阶与间距档', () {
      expect(QfScale.fs12, 12);
      expect(QfScale.fs13, 13);
      expect(QfScale.fs14, 14);
      expect(QfScale.fs15, 15);
      expect(QfScale.fs16, 16);
      expect(QfScale.sp2, 8);
      expect(QfScale.sp4, 16);
      expect(QfScale.minTouch, 44);
    });

    test('圆角：Android 卡片／按钮 12px，弹窗 16px，小浮层 8px', () {
      expect(QfScale.radiusMd, 12);
      expect(QfScale.rCard, 12);
      expect(QfScale.radiusLg, 16);
      expect(QfScale.radiusSm, 8);
      expect(QfScale.rPill, 999);
    });

    test('动效按定夺：微交互 120–180ms、面板 240–320ms、缓动 (.2,.8,.2,1)、进入上移 8px', () {
      expect(QfMotion.press, const Duration(milliseconds: 120));
      expect(QfMotion.fast, const Duration(milliseconds: 160));
      expect(QfMotion.hover, const Duration(milliseconds: 180));
      expect(QfMotion.medium, const Duration(milliseconds: 240));
      expect(QfMotion.view, const Duration(milliseconds: 260));
      expect(QfMotion.enter, const Duration(milliseconds: 320));
      expect(QfMotion.easeOut, const Cubic(0.2, 0.8, 0.2, 1));
      expect(QfMotion.revealOffsetY, 8);
    });

    test('旧字号映射到最近档（半档向上）', () {
      expect(QfScale.nearestFontSize(12.5), QfScale.fs13);
      expect(QfScale.nearestFontSize(13.5), QfScale.fs14);
      expect(QfScale.nearestFontSize(14.5), QfScale.fs15);
      expect(QfScale.nearestFontSize(15.5), QfScale.fs16);
      // S-029：步进表补 fs18 后，17 正卡 16/18 正中，按“半档向上”取 18。
      expect(QfScale.nearestFontSize(17), QfScale.fs18);
      expect(QfScale.nearestFontSize(19), QfScale.fs20);
    });
  });

  group('QfTheme 工厂', () {
    test('dark/light 底色与卡片色跟随 QfPalette', () {
      final dark = QfTheme.dark();
      final light = QfTheme.light();
      expect(dark.scaffoldBackgroundColor, const Color(0xFF08090A));
      expect(light.scaffoldBackgroundColor, const Color(0xFFFFFFFF));
      expect(dark.cardTheme.color, const Color(0xFF111113));
      expect(light.cardTheme.color, Colors.white);
    });

    test('弹窗圆角 16、卡片／按钮／输入框圆角 12', () {
      for (final theme in [QfTheme.dark(), QfTheme.light()]) {
        final dialogShape = theme.dialogTheme.shape as RoundedRectangleBorder;
        expect(dialogShape.borderRadius, BorderRadius.circular(16));
        final cardShape = theme.cardTheme.shape as RoundedRectangleBorder;
        expect(cardShape.borderRadius, BorderRadius.circular(12));
        final filledShape =
            theme.filledButtonTheme.style?.shape?.resolve({}) as OutlinedBorder;
        expect(
          (filledShape as RoundedRectangleBorder).borderRadius,
          BorderRadius.circular(12),
        );
      }
    });

    test('正文字号三档与 QfScale 一致', () {
      final textTheme = QfTheme.light().textTheme;
      expect(textTheme.bodyMedium?.fontSize, QfScale.fs14);
      expect(textTheme.bodySmall?.fontSize, QfScale.fs12);
      expect(textTheme.titleMedium?.fontSize, QfScale.fs16);
    });
  });

  group('版本展示 3.0', () {
    test('displayVersion 去尾部 .0', () {
      expect(displayVersion('3.0.0'), '3.0');
      expect(displayVersion('3.1.0'), '3.1');
      expect(displayVersion('3.0.1'), '3.0.1');
      expect(displayVersion('3.0'), '3.0');
    });
  });

  group('Q4 聊天 token（定夺 11–15）', () {
    test('气泡 16px＋尾角 4px，己方白底／对方 #111113', () {
      expect(QfChat.bubbleRadius, 16);
      expect(QfChat.bubbleTailRadius, 4);
      expect(QfChat.bubbleMineBg, const Color(0xFFFFFFFF));
      expect(QfChat.bubbleOtherBg, const Color(0xFF111113));
      // 定夺 14：己方气泡边框收敛为 0.05。
      expect(QfChat.bubbleMineBorder,
          const Color(0xFFFFFFFF).withValues(alpha: 0.05));
      expect(QfChat.bubbleOtherBorder, const Color(0xFF27272A));
    });

    test('列表项／badge／输入行关键值', () {
      expect(QfChat.listRowMinHeight, 64);
      expect(QfChat.listRowMinHeightCompact, 60);
      expect(QfChat.badgeHeight, 18);
      expect(QfChat.badgeMinWidth, 18);
      expect(QfChat.badgeBg, const Color(0xFFFFFFFF));
      expect(QfChat.badgeText, const Color(0xFF000000));
      expect(QfChat.composerRadius, 16);
      expect(QfChat.composerMinHeight, 44);
      expect(QfChat.sendButtonSize, 40);
    });

    test('新消息入场 180ms／translateY(6px)', () {
      expect(QfChat.entryDuration, const Duration(milliseconds: 180));
      expect(QfChat.entryOffsetY, 6);
    });
  });

  group('六项定夺①②（2026-11-14）：深三级改值＋灰阶审计合并', () {
    // WCAG 相对亮度与对比度（标准公式，与证据报告 python 实算同一口径）。
    double lum(Color c) {
      double lin(int v) {
        final x = v / 255.0;
        if (x <= 0.04045) return x / 12.92;
        final y = (x + 0.055) / 1.055;
        return math.pow(y, 2.4).toDouble();
      }

      return 0.2126 * lin((c.r * 255.0).round()) +
          0.7152 * lin((c.g * 255.0).round()) +
          0.0722 * lin((c.b * 255.0).round());
    }

    double contrast(Color a, Color b) {
      final la = lum(a);
      final lb = lum(b);
      final hi = la > lb ? la : lb;
      final lo = la > lb ? lb : la;
      return (hi + 0.05) / (lo + 0.05);
    }

    test('深三级 #8A8A93 对深底双双过 4.5:1（WCAG 实算）', () {
      const fg = Color(0xFF8A8A93);
      expect(contrast(fg, const Color(0xFF08090A)), closeTo(5.82, 0.02));
      expect(contrast(fg, const Color(0xFF111113)), closeTo(5.51, 0.02));
      expect(contrast(fg, const Color(0xFF08090A)), greaterThanOrEqualTo(4.5));
      expect(contrast(fg, const Color(0xFF111113)), greaterThanOrEqualTo(4.5));
      // 旧值 #71717A 对卡片仅 3.90，不可接受（定夺①）。
      expect(contrast(const Color(0xFF71717A), const Color(0xFF111113)),
          lessThan(4.5));
      // 浅三级 #71717A 不动（对白底 4.83，过线）。
      expect(contrast(const Color(0xFF71717A), const Color(0xFFFFFFFF)),
          greaterThanOrEqualTo(4.5));
    });

    test('聊天时间戳随深三级改 #8A8A93', () {
      expect(QfChat.timestampColor, const Color(0xFF8A8A93));
    });

    test('灰阶合并：深色图标片并入卡片色 #111113，浅色 #F7F7F8 不动', () {
      expect(const QfPalette(QfThemeMode.dark).iconChipColor,
          const Color(0xFF111113));
      expect(const QfPalette(QfThemeMode.blue).iconChipColor,
          const Color(0xFFF7F7F8));
    });

    test('灰阶合并：输入框常驻边框与描边按钮并入 lineDefault', () {
      for (final theme in [QfTheme.dark(), QfTheme.light()]) {
        final p = theme.brightness == Brightness.dark
            ? const QfPalette(QfThemeMode.dark)
            : const QfPalette(QfThemeMode.blue);
        final enabled = theme.inputDecorationTheme.enabledBorder
            as OutlineInputBorder;
        expect(enabled.borderSide.color, p.lineDefault);
        final side = theme.outlinedButtonTheme.style?.side?.resolve({});
        expect(side?.color, p.lineDefault);
      }
    });

    test('灰阶合并：开关选中轨道用实色 onCardDim，不用半透明 brand', () {
      for (final theme in [QfTheme.dark(), QfTheme.light()]) {
        final p = theme.brightness == Brightness.dark
            ? const QfPalette(QfThemeMode.dark)
            : const QfPalette(QfThemeMode.blue);
        final track =
            theme.switchTheme.trackColor?.resolve({WidgetState.selected});
        expect(track, p.onCardDim);
      }
    });

    test('灰阶合并：禁用按钮底并入 lineDefault，描边禁用字用 onCardDim', () {
      for (final theme in [QfTheme.dark(), QfTheme.light()]) {
        final p = theme.brightness == Brightness.dark
            ? const QfPalette(QfThemeMode.dark)
            : const QfPalette(QfThemeMode.blue);
        final filledBg = theme.filledButtonTheme.style?.backgroundColor
            ?.resolve({WidgetState.disabled});
        expect(filledBg, p.lineDefault);
        final outlinedFg = theme.outlinedButtonTheme.style
            ?.foregroundColor
            ?.resolve({WidgetState.disabled});
        expect(outlinedFg, p.onCardDim);
      }
    });

    test('路由转场：安卓走 QfPageTransitionsBuilder', () {
      for (final theme in [QfTheme.dark(), QfTheme.light()]) {
        expect(
          theme.pageTransitionsTheme.builders[TargetPlatform.android],
          isA<QfPageTransitionsBuilder>(),
        );
      }
    });
  });

  group('主题裁决（既有语义锁定）', () {
    test('手动偏好优先，未选跟随系统', () {
      expect(
        resolveThemeMode(pref: 'dark', platformBrightness: Brightness.light),
        QfThemeMode.dark,
      );
      expect(
        resolveThemeMode(pref: null, platformBrightness: Brightness.dark),
        QfThemeMode.dark,
      );
      expect(
        resolveThemeMode(pref: null, platformBrightness: Brightness.light),
        QfThemeMode.blue,
      );
    });
  });

  group('P0-2：壳主题推送 buildThemeStateEventJs（与 Web 页 qf-theme-state 同契约）', () {
    test('深色＋手动偏好派 resolved dark / mode dark', () {
      expect(
        buildThemeStateEventJs(isDark: true, mode: 'dark'),
        "window.dispatchEvent(new CustomEvent('qf-theme-state',{detail:{resolved:'dark',mode:'dark'}}));",
      );
    });
    test('浅色＋未选偏好派 resolved blue / mode system', () {
      expect(
        buildThemeStateEventJs(isDark: false, mode: 'system'),
        "window.dispatchEvent(new CustomEvent('qf-theme-state',{detail:{resolved:'blue',mode:'system'}}));",
      );
    });
    test('mode 省略与非法值一律落 system', () {
      expect(
        buildThemeStateEventJs(isDark: false),
        contains("mode:'system'"),
      );
      expect(
        buildThemeStateEventJs(isDark: true, mode: 'evil'),
        contains("mode:'system'"),
      );
    });
  });

  group('F1 回归：QfStatusPill 走 QfPalette＋小字中性墨色（B 组＋Q1-2(a)）', () {
    // WCAG 相对亮度与对比度（与证据报告 python 实算同一口径）。
    double lum(Color c) {
      double lin(int v) {
        final x = v / 255.0;
        if (x <= 0.04045) return x / 12.92;
        final y = (x + 0.055) / 1.055;
        return math.pow(y, 2.4).toDouble();
      }

      return 0.2126 * lin((c.r * 255.0).round()) +
          0.7152 * lin((c.g * 255.0).round()) +
          0.0722 * lin((c.b * 255.0).round());
    }

    double contrast(Color a, Color b) {
      final la = lum(a);
      final lb = lum(b);
      final hi = la > lb ? la : lb;
      final lo = la > lb ? lb : la;
      return (hi + 0.05) / (lo + 0.05);
    }

    // pill 浅底＝状态色 6% 事先与卡片色 alphaBlend 后的不透明烤色
    // （与 widgets.dart 落盘值同一口径）。
    Color pillBg(Color status, Color card) =>
        Color.alphaBlend(status.withValues(alpha: 0.06), card);

    test('小字（onCard）对 pill 浅底 ≥4.5:1：四状态 × 两主题', () {
      for (final mode in QfThemeMode.values) {
        final p = QfPalette(mode);
        final card = p.cardColor;
        for (final s in <Color>[
          p.success,
          p.statusOffline,
          p.warning,
          p.danger,
        ]) {
          expect(contrast(p.onCard, pillBg(s, card)),
              greaterThanOrEqualTo(4.5),
              reason: 'onCard vs pill $mode $s');
        }
      }
    });

    test('状态点对 pill 浅底 ≥3:1（非文本）：四状态 × 两主题', () {
      for (final mode in QfThemeMode.values) {
        final p = QfPalette(mode);
        final card = p.cardColor;
        for (final s in <Color>[
          p.success,
          p.statusOffline,
          p.warning,
          p.danger,
        ]) {
          expect(contrast(s, pillBg(s, card)), greaterThanOrEqualTo(3.0),
              reason: 'dot vs pill $mode $s');
        }
      }
    });

    testWidgets('QfStatusPill：文字中性墨色、圆点走 palette 状态色（浅／深）',
        (tester) async {
      for (final mode in QfThemeMode.values) {
        await tester.pumpWidget(MaterialApp(
          theme: QfTheme.light(),
          darkTheme: QfTheme.dark(),
          themeMode:
              mode == QfThemeMode.dark ? ThemeMode.dark : ThemeMode.light,
          home: const Scaffold(
            body: QfStatusPill(status: QfStatus.online, label: '在线'),
          ),
        ));
        // 主题切换有 200ms 动画过渡，须 pumpAndSettle 等主题完全落定，
        // 否则 Theme.of 仍取旧主题亮度。
        await tester.pumpAndSettle();
        final p = QfPalette(mode);
        final text = tester.widget<Text>(find.text('在线'));
        expect(text.style?.color, p.onCard);
        expect(text.style?.fontSize, QfTextSize.caption);
        final dot = tester.widget<Container>(find.byWidgetPredicate(
          (w) =>
              w is Container &&
              w.decoration is BoxDecoration &&
              (w.decoration as BoxDecoration).shape == BoxShape.circle,
        ));
        expect((dot.decoration as BoxDecoration).color, p.success);
        final pill = tester.widget<Container>(find.byWidgetPredicate(
          (w) =>
              w is Container &&
              w.decoration is BoxDecoration &&
              (w.decoration as BoxDecoration).borderRadius ==
                  const BorderRadius.all(
                      Radius.circular(QfRadius.pill)),
        ));
        expect((pill.decoration as BoxDecoration).color,
            Color.alphaBlend(p.success.withValues(alpha: 0.06), p.cardColor));
      }
    });

    testWidgets('QfErrorLine：文案中性墨色、红点走 danger（R-A6，Q1-2(a)）',
        (tester) async {
      for (final mode in QfThemeMode.values) {
        await tester.pumpWidget(MaterialApp(
          theme: QfTheme.light(),
          darkTheme: QfTheme.dark(),
          themeMode:
              mode == QfThemeMode.dark ? ThemeMode.dark : ThemeMode.light,
          home: Scaffold(
            body: QfErrorLine(
                palette: QfPalette(mode), text: 'E1001：测试错误'),
          ),
        ));
        // 主题切换有 200ms 动画过渡，须 pumpAndSettle 等主题完全落定。
        await tester.pumpAndSettle();
        final p = QfPalette(mode);
        final text = tester.widget<Text>(find.text('E1001：测试错误'));
        expect(text.style?.color, p.onCard);
        expect(text.style?.fontSize, 12);
        // 中性墨色对卡片底 ≥4.5:1（小字正文线）。
        expect(contrast(p.onCard, p.cardColor), greaterThanOrEqualTo(4.5));
        final dot = tester.widget<Container>(find.byWidgetPredicate(
          (w) =>
              w is Container &&
              w.decoration is BoxDecoration &&
              (w.decoration as BoxDecoration).shape == BoxShape.circle,
        ));
        expect((dot.decoration as BoxDecoration).color, p.danger);
      }
    });
  });
}
