// 由 design-tokens/generate.dart 从 design-tokens/tokens.json 生成，
// 不要手工改本文件；改 tokens.json 后重新运行生成器。
// S-029：设计 token 单一来源的 Dart 侧产物。
import 'package:flutter/material.dart';

/// 设计 token 单一来源（tokens.json v2）的 Dart 常量。
/// QfPalette／QfScale 须与此逐值对齐（test/design_tokens_test.dart 锁死）。
abstract final class QfDesignTokens {
  static const Color brandLight = Color(0xFF000000);
  static const Color brandDark = Color(0xFFFFFFFF);
  static const Color dangerLight = Color(0xFFDC2626);
  static const Color dangerDark = Color(0xFFF87171);
  static const Color infoLight = Color(0xFF3F3F46);
  static const Color infoDark = Color(0xFFD4D4D8);
  static const Color lineDefaultLight = Color(0xFFE4E4E7);
  static const Color lineDefaultDark = Color(0xFF27272A);
  static const Color linkLight = Color(0xFF09090B);
  static const Color linkDark = Color(0xFFFFFFFF);
  static const Color linkUnderlineLight = Color(0xFFA1A1AA);
  static const Color linkUnderlineDark = Color(0xFF52525B);
  static const Color successLight = Color(0xFF16A34A);
  static const Color successDark = Color(0xFF22C55E);
  static const Color surface0Light = Color(0xFFFFFFFF);
  static const Color surface0Dark = Color(0xFF08090A);
  static const Color surface1Light = Color(0xFFF7F7F8);
  static const Color surface1Dark = Color(0xFF111113);
  static const Color textPrimaryLight = Color(0xFF09090B);
  static const Color textPrimaryDark = Color(0xFFF7F7F8);
  static const Color textSecondaryLight = Color(0xFF52525B);
  static const Color textSecondaryDark = Color(0xFFA1A1AA);
  static const Color warningLight = Color(0xFFEA580C);
  static const Color warningDark = Color(0xFFFB923C);
  static const double fs11 = 11.0;
  static const double fs12 = 12.0;
  static const double fs13 = 13.0;
  static const double fs14 = 14.0;
  static const double fs15 = 15.0;
  static const double fs16 = 16.0;
  static const double fs18 = 18.0;
  static const double fs20 = 20.0;
  static const double fs22 = 22.0;
  static const double fs24 = 24.0;
  static const double fs26 = 26.0;
  static const double fs29 = 29.0;
  static const double sp1 = 4.0;
  static const double sp10 = 64.0;
  static const double sp2 = 8.0;
  static const double sp3 = 12.0;
  static const double sp4 = 16.0;
  static const double sp5 = 20.0;
  static const double sp6 = 24.0;
  static const double sp7 = 32.0;
  static const double sp8 = 40.0;
  static const double sp9 = 48.0;
  static const double rCard = 12.0;
  static const double rPill = 999.0;
  static const double rSmall = 8.0;
  static const double radiusLg = 16.0;
  static const int d0Ms = 60;
  static const int d1Ms = 110;
  static const int d2Ms = 140;
  static const int d3Ms = 170;
  static const int d4Ms = 210;
  static const int d5Ms = 250;
  static const int d6Ms = 290;
}
