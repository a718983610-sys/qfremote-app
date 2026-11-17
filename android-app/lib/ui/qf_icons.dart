import 'package:flutter/material.dart';

/// QF 自绘图标（黑白化 2026-11-13 站长补充令：图标按大厂水准重画）。
///
/// 设计规约（对标 Linear / Raycast / Apple / Stripe 的线性图标；
/// 2026-11-14 按定夺 §2.6 修订：1.5px 线性描边，24px 网格，单色）：
/// - 24×24 网格，描边 1.5px（按尺寸等比缩放：stroke = size / 16），
///   圆角线帽＋圆角连接，单色填充——无填充、无双色、无阴影；
/// - 造型只用直线／圆弧／圆角矩形，拐角一律圆角化；视觉重量均衡，
///   图形居中、留白四边一致（光学居中，非几何居中）；
/// - 颜色一律由调用方给（默认跟随 IconTheme，即按钮前景／正文色），
///   图标本身不带任何颜色。
///
/// 只有造型不达标的才进本文件重画（见各 kind 注释）；造型已达标的
/// Material outlined 图标（close、copy_all_outlined、more_vert、
/// home/folder/monitor/person outlined、arrow_back_ios_new、
/// computer_outlined、chevron_right）继续用 Material，不重复造轮子。
enum QfIconKind {
  /// 下载／更新：托盘＋下箭头。替代实心 system_update_alt（×2）与
  /// 实心 download（×1）：旧图标箭头粗、托盘实心，视觉重、与描边
  /// 家族不统一；重画后三处同一 glyph，渲染完全一致。
  download,

  /// 时钟：圆＋两针。替代实心 schedule：旧图标是实心圆盘时钟，
  /// 在描边家族里像一颗黑点；重画为描边圆＋短针，呼吸感一致。
  clock,

  /// 探针／检查服务器状态：心电脉冲折线。替代 network_ping：
  /// 旧图标是生僻的雷达 blob，语义不明、笔画粗细不一；脉冲线
  /// 一眼即“正在检测”，且与 Linear 的 activity 同款画法。
  probe,

  /// 安装包：手机轮廓＋下箭头。替代实心 install_mobile：旧图标
  /// 手机实心、箭头糊在其中，缩小后糊成一团；重画为描边手机＋
  /// 居中箭头，18px 下仍清晰。
  installPhone,
}

/// 自绘图标 widget：尺寸默认 20，与周边 Material 图标同档。
class QfIcon extends StatelessWidget {
  final QfIconKind kind;
  final double size;
  final Color? color;

  const QfIcon(this.kind, {super.key, this.size = 20, this.color});

  @override
  Widget build(BuildContext context) {
    final c = color ??
        IconTheme.of(context).color ??
        (Theme.of(context).brightness == Brightness.dark
            ? Colors.white
            : Colors.black);
    return SizedBox(
      width: size,
      height: size,
      child: CustomPaint(painter: _QfIconPainter(kind, c)),
    );
  }
}

class _QfIconPainter extends CustomPainter {
  final QfIconKind kind;
  final Color color;

  const _QfIconPainter(this.kind, this.color);

  @override
  void paint(Canvas canvas, Size size) {
    // 统一缩放到 24 网格作画：路径坐标全部按 24 格写，描边恒为 1.5
    //（定夺 §2.6：1.5px 线性；1.5px 下小尺寸仍清晰，2px 在 18px 下偏粗）。
    final s = size.width / 24;
    canvas.scale(s, s);
    final paint = Paint()
      ..color = color
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.5
      ..strokeCap = StrokeCap.round
      ..strokeJoin = StrokeJoin.round;
    final path = Path();
    switch (kind) {
      case QfIconKind.download:
        // 托盘：左右壁＋底边（圆角连接收口）；箭头：竖杆＋V 形头。
        path
          ..moveTo(4, 15)
          ..lineTo(4, 19)
          ..lineTo(20, 19)
          ..lineTo(20, 15)
          ..moveTo(12, 3)
          ..lineTo(12, 14)
          ..moveTo(7, 9)
          ..lineTo(12, 14)
          ..lineTo(17, 9);
        canvas.drawPath(path, paint);
      case QfIconKind.clock:
        // 圆 r=8.5（描边 1.5，视觉外径与 24 格留白一致）；短针指 12 点，
        // 长针指 4 点半方向，两针交于圆心。
        canvas.drawCircle(const Offset(12, 12), 8.5, paint);
        path
          ..moveTo(12, 12)
          ..lineTo(12, 7)
          ..moveTo(12, 12)
          ..lineTo(16, 14);
        canvas.drawPath(path, paint);
      case QfIconKind.probe:
        // 脉冲折线：平—上跳—下跳—回平，峰谷对称，视觉重心在中线。
        path
          ..moveTo(2.5, 12)
          ..lineTo(6.5, 12)
          ..lineTo(9.5, 5.5)
          ..lineTo(14, 18.5)
          ..lineTo(16.5, 12)
          ..lineTo(21.5, 12);
        canvas.drawPath(path, paint);
      case QfIconKind.installPhone:
        // 手机：圆角矩形（7, 2.5）–（17, 21.5），圆角 3；箭头居中；
        // 底部一横为 Home 指示线，与机身同描边。
        canvas.drawRRect(
            RRect.fromRectAndRadius(
                const Rect.fromLTWH(7, 2.5, 10, 19),
                const Radius.circular(3)),
            paint);
        path
          ..moveTo(12, 7)
          ..lineTo(12, 13.5)
          ..moveTo(9, 10.5)
          ..lineTo(12, 13.5)
          ..lineTo(15, 10.5)
          ..moveTo(10.8, 18.5)
          ..lineTo(13.2, 18.5);
        canvas.drawPath(path, paint);
    }
  }

  @override
  bool shouldRepaint(covariant _QfIconPainter oldDelegate) =>
      oldDelegate.kind != kind || oldDelegate.color != color;
}
