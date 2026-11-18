import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:qfremote/ui/generated_tokens.dart';
import 'package:qfremote/ui/theme.dart';

/// 对比度（WCAG 相对亮度公式）：正文 ≥4.5:1 才算过线。
double contrast(Color a, Color b) {
  double lum(Color c) {
    double ch(int v) {
      final s = v / 255.0;
      return s <= 0.03928 ? s / 12.92 : math.pow((s + 0.055) / 1.055, 2.4).toDouble();
    }
    final argb = c.toARGB32();
    return 0.2126 * ch((argb >> 16) & 0xFF) +
        0.7152 * ch((argb >> 8) & 0xFF) +
        0.0722 * ch(argb & 0xFF);
  }

  final l1 = lum(a);
  final l2 = lum(b);
  final hi = math.max(l1, l2);
  final lo = math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

void main() {
  group('S-029：tokens.json 单一来源——Dart 常量与 QfPalette／QfScale 对齐', () {
    test('状态色（已对齐）与生成常量逐值相等，深浅两端', () {
      const light = QfPalette(QfThemeMode.light);
      const dark = QfPalette(QfThemeMode.dark);
      expect(light.success, QfDesignTokens.successLight);
      expect(dark.success, QfDesignTokens.successDark);
      expect(light.danger, QfDesignTokens.dangerLight);
      expect(dark.danger, QfDesignTokens.dangerDark);
      expect(light.warning, QfDesignTokens.warningLight);
      expect(dark.warning, QfDesignTokens.warningDark);
      expect(light.info, QfDesignTokens.infoLight);
      expect(dark.info, QfDesignTokens.infoDark);
      expect(light.surface0, QfDesignTokens.surface0Light);
      expect(dark.surface0, QfDesignTokens.surface0Dark);
    });

    test('链接与下划线色与生成常量逐值相等（S-040 同一 token）', () {
      const light = QfPalette(QfThemeMode.light);
      const dark = QfPalette(QfThemeMode.dark);
      expect(light.link, QfDesignTokens.linkLight);
      expect(dark.link, QfDesignTokens.linkDark);
      expect(light.linkUnderline, QfDesignTokens.linkUnderlineLight);
      expect(dark.linkUnderline, QfDesignTokens.linkUnderlineDark);
      expect(light.linkUnderlineCssHex, '#A1A1AA');
      expect(dark.linkUnderlineCssHex, '#52525B');
    });

    test('字阶补齐 18／22／26，间距补齐 sp8=40（与网页 token 同一套数）', () {
      expect(QfScale.fs18, 18);
      expect(QfScale.fs22, 22);
      expect(QfScale.fs26, 26);
      expect(QfScale.sp8, 40);
      expect(QfScale.fs18, QfDesignTokens.fs18);
      expect(QfScale.fs22, QfDesignTokens.fs22);
      expect(QfScale.fs26, QfDesignTokens.fs26);
      expect(QfScale.sp8, QfDesignTokens.sp8);
      expect(QfScale.nearestFontSize(18), 18);
      expect(QfScale.nearestFontSize(22), 22);
      expect(QfScale.nearestFontSize(26), 26);
    });

    test('链接色对页面底对比度过 4.5:1（深浅两端，S-033 连带）', () {
      const light = QfPalette(QfThemeMode.light);
      const dark = QfPalette(QfThemeMode.dark);
      expect(contrast(light.link, light.pageColor), greaterThanOrEqualTo(4.5));
      expect(contrast(dark.link, dark.pageColor), greaterThanOrEqualTo(4.5));
      expect(
        contrast(light.textSecondary, light.pageColor),
        greaterThanOrEqualTo(4.5),
      );
      expect(
        contrast(dark.textSecondary, dark.pageColor),
        greaterThanOrEqualTo(4.5),
      );
    });
  });
}
