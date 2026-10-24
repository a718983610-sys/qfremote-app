import 'package:flutter/material.dart';

/// QF 家族设计语言（与 Windows 壳、网页版同一套令牌，2026-10-24 现代版）：
/// 平涂品牌蓝 #2470E0 / 深色卡 #22262E（不用纯黑）/ 页面底 #F4F7FB 与深蓝底
/// #0A2450 / 发丝线 #DFE7F2 / 圆角讲究、留白克制 / 橙点只作点缀（更新与状态）。
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

  /// 品牌主色（按钮、强调）
  static const Color brand = Color(0xFF2470E0);

  /// 工具栏底色：平涂
  Color get toolbarColor =>
      isDark ? const Color(0xFF22262E) : const Color(0xFF2470E0);

  /// 工具栏底部发丝线
  Color get toolbarBorder => isDark
      ? Colors.white.withValues(alpha: 0.08)
      : Colors.black.withValues(alpha: 0.18);

  /// 品牌页（启动/断线/强更）底色：与网页端同一令牌底 #F4F7FB / 深灰
  Color get pageColor =>
      isDark ? const Color(0xFF17181C) : const Color(0xFFF4F7FB);

  /// 看护状态行底色
  Color get statusLineColor =>
      isDark ? const Color(0xFF22262E) : const Color(0xFF0B2B5B);

  /// 卡片：亮主题白卡 / 深色 #22262E
  Color get cardColor =>
      isDark ? const Color(0xFF22262E) : Colors.white;
  Color get cardBorder => isDark
      ? Colors.white.withValues(alpha: 0.07)
      : const Color(0xFF0B2B5B).withValues(alpha: 0.08);
  Color get onCard => isDark ? const Color(0xFFECEFF3) : const Color(0xFF1F2D47);
  Color get onCardDim =>
      isDark ? const Color(0xFF9AA1AB) : const Color(0xFF6B7A90);

  /// 品牌标牌面：浅色底用深蓝牌 #0B2B5B 承载、深色底用白牌承载
  /// （三端口径：不许白字标直接上白底）
  Color get tileFill =>
      isDark ? Colors.white : const Color(0xFF0B2B5B);
  Color get tileBorder => isDark
      ? Colors.white.withValues(alpha: 0.08)
      : const Color(0xFFDFE7F2);

  Color get toolbarIcon => Colors.white;

  /// 卡片阴影：令牌口径平涂无阴影，恒为空（保留 getter 免改调用点）
  List<BoxShadow> get cardShadow => const [];

  /// 家族橙（只作点缀：更新徽标点、更新进度、状态点）
  static const Color accent = Color(0xFFFF8A1E);
  static const Color probeOk = Color(0xFF1DB954);
  static const Color probeBad = Color(0xFFE5484D);
  static const Color probeBusy = Color(0xFFF5A623);
}
