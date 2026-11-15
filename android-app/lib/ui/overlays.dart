import 'package:flutter/material.dart';

import 'theme.dart';
import 'reduced_motion.dart';

/// 启动画面（家族语言：平涂黑白底＋白色图标托＋主色进度条），
/// 控制台首屏加载完才退场（最短停留与 Windows 版同为 850ms，在主页逻辑里控制）。
class SplashView extends StatelessWidget {
  final QfPalette palette;
  final String version;

  /// 附加小字（如自动恢复登录中），为空不显示。
  final String? note;

  /// 恢复进行中时的取消入口（2.4.5 A7/B14）：点后取消恢复、直接露登录页。
  final VoidCallback? onCancelRecovery;

  const SplashView({
    super.key,
    required this.palette,
    required this.version,
    this.note,
    this.onCancelRecovery,
  });

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
              // W4 L 档：88／圆角 14／padding 5／内图 10（与 Windows 启动屏同档）。
              width: 88,
              height: 88,
              padding: const EdgeInsets.all(5),
              decoration: BoxDecoration(
                // 品牌标牌面：浅色底黑牌、深色底白牌（与 Windows 壳同一口径）
                // 定夺修订：圆角 24／20 超出弹窗档（14–16），改外 16／内 12。
                color: palette.tileFill,
                borderRadius: BorderRadius.circular(14),
              ),
              child: ClipRRect(
                borderRadius: BorderRadius.circular(10),
                child: Image.asset('assets/icon.png', fit: BoxFit.cover),
              ),
            ),
            const SizedBox(height: 20),
            Text(
              'QFRemote',
              style: TextStyle(
                color: palette.onCard,
                fontSize: QfScale.fs29,
                fontWeight: FontWeight.w600,
                letterSpacing: 1.2,
              ),
            ),
            const SizedBox(height: 6),
            Text(
              '远程控制',
              style: TextStyle(
                color: palette.onCardDim,
                fontSize: QfScale.fs14,
                letterSpacing: 5,
              ),
            ),
            const SizedBox(height: 30),
            Container(
              width: 168,
              height: 5,
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(3),
                color: palette.lineHover,
              ),
              child: ClipRRect(
                borderRadius: BorderRadius.circular(3),
                // 6 项定夺⑤：启动条走 QfLoadingBar（reduced motion 时不定条
                // 改静止空轨）；轨道色 lineHover 在此为静态底轨（深 #27272A＝
                // 卡片边框、浅 #A1A1AA），计入灰阶清单，不属瞬时态。
                child: QfLoadingBar(
                  backgroundColor: Colors.transparent,
                  color: palette.brand,
                ),
              ),
            ),
            if (note != null) ...[
              const SizedBox(height: 14),
              Text(
                note!,
                style: TextStyle(
                  color: palette.onCardDim,
                  fontSize: QfScale.fs13,
                ),
              ),
            ],
            if (onCancelRecovery != null) ...[
              const SizedBox(height: 18),
              QfButtonTapTarget(child: OutlinedButton(
                onPressed: onCancelRecovery,
                style: OutlinedButton.styleFrom(
                  foregroundColor: palette.onCard,
                  // 6 项定夺②：取消钮描边与卡片边框二选一，并入 lineDefault。
                  side: BorderSide(
                      color: palette.lineDefault),
                  minimumSize: const Size(0, QfScale.buttonVisualHeight),
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(QfScale.radiusMd)),
                ),
                child: const Text('取消恢复，直接登录'),
              )),
            ],
            const SizedBox(height: 26),
            Text('v${displayVersion(version)}',
                style: TextStyle(
                  color: palette.onCardDim,
                  fontSize: QfScale.fs12,
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

  /// 自动重试已达上限停住（2.4.5 B11：10 次后停在卡片上，只留手动重试）。
  final bool autoRetryStopped;

  /// 已自动重试次数（C §2.5 已尝试步骤；调用方实测传入，未传入显示 —）。
  final int? attempts;

  const OfflineView({
    super.key,
    required this.palette,
    required this.secondsLeft,
    required this.onRetryNow,
    this.autoRetryStopped = false,
    this.attempts,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      color: palette.pageColor,
      child: SafeArea(
        // A7 附带：标题 16→24 后，大字号档（2.0x）卡片会超高溢出；
        // 与强制更新页同款可滚动（1.0x 下无变化，不出现滚动条）。
        child: Center(
        child: SingleChildScrollView(
        child: Container(
          margin: const EdgeInsets.symmetric(horizontal: 28),
          // A6 定夺：全屏状态卡内边距统一 24（原 26／30／26／26）。
          padding: EdgeInsets.all(QfScale.statusCardPadding),
          decoration: BoxDecoration(
            color: palette.cardColor,
            borderRadius: BorderRadius.circular(QfScale.radiusMd),
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
                  // W4 M 档：60／圆角 14／padding 4／内图 10。
                  borderRadius: BorderRadius.circular(14),
                  border: Border.all(color: palette.tileBorder),
                ),
                child: ClipRRect(
                  borderRadius: BorderRadius.circular(10),
                  child: Image.asset('assets/icon.png', fit: BoxFit.cover),
                ),
              ),
              const SizedBox(height: 16),
              Text(
                '无法连接服务器，正在重试',
                // A7 定夺：断线卡标题 16→title24，与强制更新页统一为单档 H1。
                style: QfType.title24(palette.onCard),
              ),
              const SizedBox(height: 8),
              Text(
                autoRetryStopped
                    ? '已停止自动重试，请检查网络后点立即重试'
                    : '网络恢复后将自动回到控制台，无需操作。\n将在 $secondsLeft 秒后自动重试',
                textAlign: TextAlign.center,
                style: QfType.body14(palette.textSecondary),
              ),
              const SizedBox(height: 8),
              // C §2.5：已尝试步骤（真实计数由调用方传入）＋错误码
              // （断线原因未结构化，显示 —，不编 NET-xxxx）。
              Text(
                '已尝试：自动重试 ${attempts ?? '—'} / 10 次。错误码：—。',
                textAlign: TextAlign.center,
                style: QfType.tabular(QfType.meta12(palette.textSecondary)),
              ),
              const SizedBox(height: 20),
              QfButtonTapTarget(child: FilledButton(
                onPressed: onRetryNow,
                style: FilledButton.styleFrom(
                  backgroundColor: palette.brand,
                  padding: const EdgeInsets.symmetric(horizontal: 30),
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(QfScale.radiusMd)),
                ),
                child: const Text('立即重试'),
              )),
            ],
          ),
        ),
        ),
        ),
      ),
    );
  }
}
