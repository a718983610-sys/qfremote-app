import 'package:flutter/material.dart';

import 'theme.dart';

/// 启动画面（家族语言：深蓝渐变＋自家标＋橙色进度条），
/// 控制台首屏加载完才退场（最短停留与 Windows 版同为 850ms，在主页逻辑里控制）。
class SplashView extends StatelessWidget {
  final QfPalette palette;
  final String version;
  const SplashView({super.key, required this.palette, required this.version});

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: BoxDecoration(gradient: palette.pageGradient),
      child: Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              width: 92,
              height: 92,
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(22),
                boxShadow: [
                  BoxShadow(color: Colors.black.withValues(alpha: 0.35), blurRadius: 24, offset: const Offset(0, 10)),
                ],
              ),
              child: ClipRRect(
                borderRadius: BorderRadius.circular(22),
                child: Image.asset('assets/icon.png', fit: BoxFit.cover),
              ),
            ),
            const SizedBox(height: 20),
            const Text(
              'QFRemote',
              style: TextStyle(color: Colors.white, fontSize: 27, fontWeight: FontWeight.w600, letterSpacing: 1.2),
            ),
            const SizedBox(height: 6),
            const Text('远程控制', style: TextStyle(color: Colors.white70, fontSize: 14)),
            const SizedBox(height: 30),
            Container(
              width: 168,
              height: 5,
              decoration: BoxDecoration(borderRadius: BorderRadius.circular(3), color: Colors.white24),
              child: ClipRRect(
                borderRadius: BorderRadius.circular(3),
                child: const LinearProgressIndicator(
                  backgroundColor: Colors.transparent,
                  valueColor: AlwaysStoppedAnimation<Color>(QfPalette.accent),
                ),
              ),
            ),
            const SizedBox(height: 26),
            Text('v$version', style: const TextStyle(color: Colors.white38, fontSize: 12)),
          ],
        ),
      ),
    );
  }
}

/// 整页断线友好页（与 Windows 版断线页同行为）：
/// 自家卡片＋「连不上服务器，正在重试」＋倒计时＋立即重试，恢复自动回控制台。
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
      decoration: BoxDecoration(gradient: palette.pageGradient),
      child: Center(
        child: Container(
          margin: const EdgeInsets.symmetric(horizontal: 28),
          padding: const EdgeInsets.fromLTRB(26, 30, 26, 26),
          decoration: BoxDecoration(
            color: palette.cardColor,
            borderRadius: BorderRadius.circular(20),
            boxShadow: [BoxShadow(color: Colors.black.withValues(alpha: 0.3), blurRadius: 24, offset: const Offset(0, 10))],
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              ClipRRect(
                borderRadius: BorderRadius.circular(14),
                child: Image.asset('assets/icon.png', width: 56, height: 56, fit: BoxFit.cover),
              ),
              const SizedBox(height: 16),
              Text(
                '连不上服务器，正在重试',
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
                style: FilledButton.styleFrom(backgroundColor: const Color(0xFF1450B4)),
                child: const Text('立即重试'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
