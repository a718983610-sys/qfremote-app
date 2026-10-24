import 'package:flutter/material.dart';

/// QF 家族设计语言（与 Windows 版 v1.0.1/v1.0.2 同一套）：
/// 亮蓝渐变 / 深灰深色（不用纯黑）/ 圆角卡片 / 橙点点缀 / 金色轨道环母题。
enum QfThemeMode { blue, dark }

extension QfThemeModeX on QfThemeMode {
  String get prefValue => this == QfThemeMode.blue ? 'blue' : 'dark';
  static QfThemeMode fromPref(String? v) =>
      v == 'dark' ? QfThemeMode.dark : QfThemeMode.blue;
}

class QfPalette {
  final QfThemeMode mode;
  const QfPalette(this.mode);

  bool get isDark => mode == QfThemeMode.dark;

  /// 工具栏渐变
  Gradient get toolbarGradient => isDark
      ? const LinearGradient(
          colors: [Color(0xFF3D4149), Color(0xFF22242A)],
          begin: Alignment.topCenter,
          end: Alignment.bottomCenter,
        )
      : const LinearGradient(
          colors: [Color(0xFF3B8BFF), Color(0xFF1450B4)],
          begin: Alignment.topCenter,
          end: Alignment.bottomCenter,
        );

  /// 页面/启动画面背景渐变
  Gradient get pageGradient => isDark
      ? const LinearGradient(
          colors: [Color(0xFF23262D), Color(0xFF14161A)],
          begin: Alignment.topCenter,
          end: Alignment.bottomCenter,
        )
      : const LinearGradient(
          colors: [Color(0xFF0E2A52), Color(0xFF1450B4)],
          begin: Alignment.topCenter,
          end: Alignment.bottomCenter,
        );

  Color get cardColor =>
      isDark ? const Color(0xFF2B2F36) : Colors.white.withValues(alpha: 0.96);
  Color get onCard => isDark ? const Color(0xFFE8ECF3) : const Color(0xFF14305E);
  Color get onCardDim =>
      isDark ? const Color(0xFFA7B0BE) : const Color(0xFF5A6E8C);
  Color get toolbarIcon => Colors.white;
  Color get statusBarColor => isDark ? const Color(0xFF2E6BDE) : const Color(0xFF2E7CF6);

  /// 家族橙（徽标、进度、点缀）
  static const Color accent = Color(0xFFFF8A3D);
  static const Gradient accentGradient = LinearGradient(
    colors: [Color(0xFFFFB03A), Color(0xFFFF7A29)],
  );
  static const Color probeOk = Color(0xFF39D98A);
  static const Color probeBad = Color(0xFFFF5A5A);
  static const Color probeBusy = Color(0xFFFFC53D);
}
