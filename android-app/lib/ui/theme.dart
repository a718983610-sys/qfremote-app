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

  /// 冻结令牌（2.2.0 与 Win 线同一套）：深蓝/发丝/正文/次要。
  static const Color navy = Color(0xFF0B2B5B);
  static const Color hairline = Color(0xFFDFE7F2);
  static const Color textMain = Color(0xFF1F2D47);
  static const Color textDim = Color(0xFF6B7A90);

  /// 列表行浅蓝图标片底色（深色模式用卡片内浅一档）。
  Color get iconChipColor =>
      isDark ? const Color(0xFF2B3038) : const Color(0xFFEEF3FB);
}

/// 品牌默认头像占位（全产品统一）：深蓝圆盘＋白色断环＋橙点。
/// 没有真实头像时一律用它，不许用系统默认人像或灰色剪影。
class QfAvatarPlaceholder extends StatelessWidget {
  final double size;
  const QfAvatarPlaceholder({super.key, this.size = 40});

  @override
  Widget build(BuildContext context) {
    return Container(
      width: size,
      height: size,
      decoration: const BoxDecoration(color: QfPalette.navy, shape: BoxShape.circle),
      child: CustomPaint(painter: _AvatarMarkPainter(), size: Size(size, size)),
    );
  }
}

class _AvatarMarkPainter extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) {
    final c = Offset(size.width / 2, size.height / 2);
    final r = size.width * 0.30;
    final ring = Paint()
      ..color = Colors.white
      ..style = PaintingStyle.stroke
      ..strokeWidth = size.width * 0.075
      ..strokeCap = StrokeCap.round;
    // 断环：留出右上缺口放橙点（与品牌标志同一画法）。
    canvas.drawArc(
      Rect.fromCircle(center: c, radius: r),
      0.9,
      5.1,
      false,
      ring,
    );
    final dot = Paint()..color = QfPalette.accent;
    canvas.drawCircle(
      Offset(c.dx + r * 0.78, c.dy - r * 0.78),
      size.width * 0.085,
      dot,
    );
  }

  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}

/// 列表行（全产品统一）：浅蓝图标片＋标题＋右箭头，整行可点，行高不小于 48。
class QfListRow extends StatelessWidget {
  final QfPalette palette;
  final IconData icon;
  final String title;
  final String? subtitle;
  final VoidCallback? onTap;

  const QfListRow({
    super.key,
    required this.palette,
    required this.icon,
    required this.title,
    this.subtitle,
    this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final p = palette;
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(14),
      child: Container(
        constraints: const BoxConstraints(minHeight: 48),
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        child: Row(
          children: [
            Container(
              width: 36,
              height: 36,
              decoration: BoxDecoration(
                color: p.iconChipColor,
                borderRadius: BorderRadius.circular(10),
              ),
              child: Icon(icon, size: 20, color: QfPalette.brand),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(title,
                      style: TextStyle(
                          color: p.onCard, fontSize: 15, fontWeight: FontWeight.w600)),
                  if (subtitle != null) ...[
                    const SizedBox(height: 2),
                    Text(subtitle!,
                        style: TextStyle(color: p.onCardDim, fontSize: 12.5)),
                  ],
                ],
              ),
            ),
            Icon(Icons.chevron_right, size: 20, color: p.onCardDim),
          ],
        ),
      ),
    );
  }
}
