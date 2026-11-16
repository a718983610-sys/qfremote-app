/// A-07 设计 token 集中化（Element X designsystem / Invoice Ninja InTheme
/// 模式）：颜色、字号、圆角、间距只从 token 取，禁止业务代码写死字面量。
///
/// 颜色 token 的唯一出处仍是 `ui/theme.dart` 的 [QfPalette]/[QfTheme]
/// （三端黑白化定夺值已在那里收敛，本文件不复制色值、不造第二出处）。
/// 本文件收敛非颜色 token：间距、圆角、时长、字号档、布局断点数值。
/// 新增 token 只许加在这里；业务代码出现硬编码 `EdgeInsets.all(16)`、
/// `BorderRadius.circular(12)`、`Duration(milliseconds: 300)` 即视为违规，
/// 由 test/lint/design_token_test.dart 扫描拦截。
abstract final class QfSpacing {
  static const double xs = 4;
  static const double sm = 8;
  static const double md = 12;
  static const double lg = 16;
  static const double xl = 24;
  static const double xxl = 32;
}

abstract final class QfRadius {
  static const double sm = 6;
  static const double md = 10;
  static const double lg = 14;
  static const double xl = 20;
  static const double pill = 999;
}

abstract final class QfDuration {
  static const Duration fast = Duration(milliseconds: 120);
  static const Duration normal = Duration(milliseconds: 200);
  static const Duration slow = Duration(milliseconds: 300);
}

/// 字号档（跟随系统字号缩放，业务代码只取档位，不写具体数字）。
abstract final class QfTextSize {
  static const double caption = 12;
  static const double body = 14;
  static const double bodyLarge = 16;
  static const double title = 18;
  static const double headline = 22;
}

/// 自适应断点（A-08 同源数值，见 ui/core/adaptive.dart）。
abstract final class QfBreakpoint {
  /// <600：手机单栏（底部 NavigationBar）。
  static const double compactMax = 600;

  /// 600–840：平板单栏＋Rail。
  static const double mediumMax = 840;

  /// >840：桌面/大平板双栏（列表＋详情同屏）。
  static const double expandedMin = 840;
}
