import 'package:flutter/material.dart';

import 'theme.dart';

/// A8：QfToolbar 已删除（2026-11-13）——坐实死代码，零生产调用方；
/// 主框架用的是 frame.dart 的 QfAppHeader。不要复活本文件里的旧工具栏：
/// 其状态点落在亮蓝工具栏上对比度只有 1.40–1.86，且自带第二套 8 项菜单，
/// 与现役 12 项菜单漂移。本文件现只剩生产仍在用的 WatchdogStatusLine。
/// 工具栏下方的看护状态行：只在断线重连时出现一行小字，连上自动消失
/// （与 Windows 版同一口径：不弹窗、不踢回登录页）。
class WatchdogStatusLine extends StatelessWidget {
  final bool visible;
  final QfPalette palette;
  const WatchdogStatusLine({super.key, required this.visible, required this.palette});

  @override
  Widget build(BuildContext context) {
    return AnimatedContainer(
      // 6 项定夺⑤：reduced motion 开启时时长归零（高度 22↔0 直接切换，
      // 不做展开动画）；关闭时保持 240ms。
      duration: QfMotion.resolve(context, QfMotion.medium),
      height: visible ? 22 : 0,
      // A5 定夺：浅色 surface1 底＋textPrimary 字＋1px 底边 lineDefault；
      // 深色仍 #111113＋白字（statusLineColor／textPrimary 已按主题取值）。
      decoration: BoxDecoration(
        color: palette.statusLineColor,
        border: visible
            ? Border(bottom: BorderSide(color: palette.lineDefault))
            : null,
      ),
      child: visible
          ? Center(
              child: Text(
                '连接断开，正在重连…',
                style: TextStyle(
                    color: palette.isDark
                        ? Colors.white
                        : palette.textPrimary,
                    fontSize: QfScale.fs12),
              ),
            )
          : null,
    );
  }
}
