import 'package:flutter/material.dart';

import 'theme.dart';

/// 启动画面（家族语言：平涂深蓝底＋白色图标托＋橙色进度条），
/// 控制台首屏加载完才退场（最短停留与 Windows 版同为 850ms，在主页逻辑里控制）。
class SplashView extends StatelessWidget {
  final QfPalette palette;
  final String version;

  /// 附加小字（如自动恢复登录中），为空不显示。
  final String? note;
  const SplashView({super.key, required this.palette, required this.version, this.note});

  @override
  Widget build(BuildContext context) {
    return Container(
      color: palette.pageColor,
      child: SafeArea(
        child: Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              width: 96,
              height: 96,
              padding: const EdgeInsets.all(5),
              decoration: BoxDecoration(
                // 品牌标牌面：浅色底深蓝牌、深色底白牌（与 Windows 壳同一口径）
                color: palette.isDark ? Colors.white : const Color(0xFF0B2B5B),
                borderRadius: BorderRadius.circular(24),
              ),
              child: ClipRRect(
                borderRadius: BorderRadius.circular(20),
                child: Image.asset('assets/icon.png', fit: BoxFit.cover),
              ),
            ),
            const SizedBox(height: 20),
            Text(
              'QFRemote',
              style: TextStyle(
                color: palette.isDark ? Colors.white : const Color(0xFF1F2D47),
                fontSize: 27,
                fontWeight: FontWeight.w700,
                letterSpacing: 1.2,
              ),
            ),
            const SizedBox(height: 6),
            Text(
              '远程控制',
              style: TextStyle(
                color: palette.isDark ? const Color(0xFF9AA1AB) : const Color(0xFF5D6E84),
                fontSize: 14,
                letterSpacing: 5,
              ),
            ),
            const SizedBox(height: 30),
            Container(
              width: 168,
              height: 5,
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(3),
                color: palette.isDark ? Colors.white24 : const Color(0xFFDFE7F2),
              ),
              child: ClipRRect(
                borderRadius: BorderRadius.circular(3),
                child: const LinearProgressIndicator(
                  backgroundColor: Colors.transparent,
                  valueColor: AlwaysStoppedAnimation<Color>(QfPalette.brand),
                ),
              ),
            ),
            if (note != null) ...[
              const SizedBox(height: 14),
              Text(
                note!,
                style: TextStyle(
                  color: palette.isDark ? const Color(0xFF9AA1AB) : const Color(0xFF5D6E84),
                  fontSize: 13,
                ),
              ),
            ],
            const SizedBox(height: 26),
            Text('v$version',
                style: TextStyle(
                  color: palette.isDark ? Colors.white38 : const Color(0xFF5D6E84),
                  fontSize: 12,
                )),
          ],
        ),
        ),
      ),
    );
  }
}

/// 整页断线友好页（与 Windows 版断线页同行为）：
/// 白卡（深色 #22262E）＋「无法连接服务器，正在重试」＋倒计时＋立即重试，恢复自动回控制台。
class OfflineView extends StatelessWidget {
  final QfPalette palette;
  final int secondsLeft;
  final VoidCallback onRetryNow;
  const OfflineView({
    super.key,
    required this.palette,
    required this.secondsLeft,
    required this.onRetryNow,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      color: palette.pageColor,
      child: SafeArea(
        child: Center(
        child: Container(
          margin: const EdgeInsets.symmetric(horizontal: 28),
          padding: const EdgeInsets.fromLTRB(26, 30, 26, 26),
          decoration: BoxDecoration(
            color: palette.cardColor,
            borderRadius: BorderRadius.circular(14),
            border: Border.all(color: palette.cardBorder),
            boxShadow: palette.cardShadow,
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Container(
                width: 60,
                height: 60,
                padding: const EdgeInsets.all(4),
                decoration: BoxDecoration(
                  color: palette.tileFill,
                  borderRadius: BorderRadius.circular(16),
                  border: Border.all(color: palette.tileBorder),
                ),
                child: ClipRRect(
                  borderRadius: BorderRadius.circular(12),
                  child: Image.asset('assets/icon.png', fit: BoxFit.cover),
                ),
              ),
              const SizedBox(height: 16),
              Text(
                '无法连接服务器，正在重试',
                style: TextStyle(color: palette.onCard, fontSize: 17, fontWeight: FontWeight.w600),
              ),
              const SizedBox(height: 8),
              Text(
                '网络恢复后将自动回到控制台，无需操作。\n将在 $secondsLeft 秒后自动重试',
                textAlign: TextAlign.center,
                style: TextStyle(color: palette.onCardDim, fontSize: 13, height: 1.5),
              ),
              const SizedBox(height: 20),
              FilledButton(
                onPressed: onRetryNow,
                style: FilledButton.styleFrom(
                  backgroundColor: QfPalette.brand,
                  padding: const EdgeInsets.symmetric(horizontal: 30, vertical: 12),
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
                ),
                child: const Text('立即重试'),
              ),
            ],
          ),
        ),
        ),
      ),
    );
  }
}
