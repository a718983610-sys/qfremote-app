import 'package:flutter/material.dart';

import '../../app/design_tokens.dart';
import '../theme.dart';

/// A-07 自研设计系统包一层（Element X designsystem 原子组件模式）：
/// 按钮/输入框/顶栏/状态点/Toast 各一个封装，颜色、字号、圆角、间距只从
/// 主题 token 取，禁止业务代码写死色值。
/// 黑白化改 token 一处生效，而不是逐屏改色。

/// 主按钮：浅色纯黑底白字、深色纯白底黑字（QfPalette.brand/onBrand）。
class QfButton extends StatelessWidget {
  const QfButton({
    super.key,
    required this.label,
    required this.onPressed,
    this.enabled = true,
  });

  final String label;
  final VoidCallback? onPressed;
  final bool enabled;

  @override
  Widget build(BuildContext context) {
    final palette = QfPalette(_modeOf(context));
    return FilledButton(
      onPressed: enabled ? onPressed : null,
      style: FilledButton.styleFrom(
        backgroundColor: palette.brand,
        foregroundColor: palette.onBrand,
        padding: const EdgeInsets.symmetric(
            horizontal: QfSpacing.xl, vertical: QfSpacing.md),
        shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.all(Radius.circular(QfRadius.md)),
        ),
      ),
      child: Text(label, style: const TextStyle(fontSize: QfTextSize.body)),
    );
  }
}

/// 次按钮：描边样式。
class QfOutlinedButton extends StatelessWidget {
  const QfOutlinedButton({
    super.key,
    required this.label,
    required this.onPressed,
  });

  final String label;
  final VoidCallback? onPressed;

  @override
  Widget build(BuildContext context) {
    return OutlinedButton(
      onPressed: onPressed,
      style: OutlinedButton.styleFrom(
        padding: const EdgeInsets.symmetric(
            horizontal: QfSpacing.xl, vertical: QfSpacing.md),
        shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.all(Radius.circular(QfRadius.md)),
        ),
      ),
      child: Text(label, style: const TextStyle(fontSize: QfTextSize.body)),
    );
  }
}

QfThemeMode _modeOf(BuildContext context) =>
    Theme.of(context).brightness == Brightness.dark
        ? QfThemeMode.dark
        : QfThemeMode.light;

/// 状态点（在线绿/离线灰/警告橙/错误红——状态色已定保持彩色，2026-11-14
/// 站长亲定，不改纯黑白）。
enum QfStatus { online, offline, warning, error }

class QfStatusPill extends StatelessWidget {
  const QfStatusPill({super.key, required this.status, required this.label});

  final QfStatus status;
  final String label;

  /// 状态色走 QfPalette（2026-11-15 定稿 B 组，三端唯一口径）：
  /// 文字一律中性墨色（Q1-2(a)），状态色只做圆点／浅底，不直接写小字。
  Color _color(QfPalette palette) => switch (status) {
        QfStatus.online => palette.success,
        QfStatus.offline => palette.statusOffline,
        QfStatus.warning => palette.warning,
        QfStatus.error => palette.danger,
      };

  @override
  Widget build(BuildContext context) {
    final palette = QfPalette(_modeOf(context));
    final color = _color(palette);
    // F1：pill 底改 6% 不透明烤色（状态色 6% 事先与卡片色 alphaBlend 后
    // 落盘，背景不透明——对比度只取决于烤色本身，不依赖 pill 下面的
    // 实际表面。12% tint 时浅色绿点对底仅 2.89:1（<3:1）；6% 时最紧
    // 的浅色绿点约 3.08:1，其余均过 3:1；小字 onCard 对底约 18:1。
    // 见 theme_tokens_test F1 回归断言。
    return Container(
      padding: const EdgeInsets.symmetric(
          horizontal: QfSpacing.sm, vertical: QfSpacing.xs),
      decoration: BoxDecoration(
        color: Color.alphaBlend(
            color.withValues(alpha: 0.06), palette.cardColor),
        borderRadius:
            const BorderRadius.all(Radius.circular(QfRadius.pill)),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            width: 8,
            height: 8,
            decoration:
                BoxDecoration(color: color, shape: BoxShape.circle),
          ),
          const SizedBox(width: QfSpacing.xs),
          Text(label,
              style: TextStyle(
                  fontSize: QfTextSize.caption, color: palette.onCard)),
        ],
      ),
    );
  }
}

/// 空态（通用件，全端复用）。
class QfEmptyState extends StatelessWidget {
  const QfEmptyState(
      {super.key, required this.title, this.hint, this.action});

  final String title;
  final String? hint;
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(QfSpacing.xl),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(title,
                style: const TextStyle(fontSize: QfTextSize.title)),
            if (hint != null) ...[
              const SizedBox(height: QfSpacing.sm),
              Text(hint!,
                  style: const TextStyle(fontSize: QfTextSize.body),
                  textAlign: TextAlign.center),
            ],
            if (action != null) ...[
              const SizedBox(height: QfSpacing.lg),
              action!,
            ],
          ],
        ),
      ),
    );
  }
}

/// 错误态（通用件：诚实错误＋重试，不填假状态）。
class QfErrorView extends StatelessWidget {
  const QfErrorView(
      {super.key, required this.message, required this.onRetry});

  final String message;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(QfSpacing.xl),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(message,
                style: const TextStyle(fontSize: QfTextSize.body),
                textAlign: TextAlign.center),
            const SizedBox(height: QfSpacing.lg),
            QfOutlinedButton(label: '重试', onPressed: onRetry),
          ],
        ),
      ),
    );
  }
}

/// 离线横幅（通用件）。
class QfOfflineBanner extends StatelessWidget {
  const QfOfflineBanner({super.key, required this.message});

  final String message;

  @override
  Widget build(BuildContext context) {
    final palette = QfPalette(_modeOf(context));
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(
          horizontal: QfSpacing.lg, vertical: QfSpacing.sm),
      color: palette.cardColor,
      child: Text(message,
          style: const TextStyle(fontSize: QfTextSize.caption),
          textAlign: TextAlign.center),
    );
  }
}

/// 同步状态徽标（通用件：待同步条数）。
class QfSyncBadge extends StatelessWidget {
  const QfSyncBadge({super.key, required this.pendingCount});

  final int pendingCount;

  @override
  Widget build(BuildContext context) {
    if (pendingCount <= 0) return const SizedBox.shrink();
    return QfStatusPill(
        status: QfStatus.warning, label: '待同步 $pendingCount 条');
  }
}
