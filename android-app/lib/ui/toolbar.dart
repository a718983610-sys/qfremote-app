import 'package:flutter/material.dart';

import '../services/probe.dart';
import 'theme.dart';

/// 手机端精简工具栏（对齐 Windows 版能力，布局按手机适配）：
/// 后退 / 刷新 / 主页 / 好友 / 论坛 / 注册 / 状态灯（真探活）/ 更新徽标 / 更多菜单（站长才有「管理」）。
/// 图标统一 24 像素网格、命中区 40，窄屏不裁切。
/// 样式与三端一致性清单对齐：平涂品牌蓝、圆角 10 按钮、窄屏收紧不溢出。
class QfToolbar extends StatelessWidget {
  final QfPalette palette;
  final bool canGoBack;
  final ProbeResult? lastProbe;
  final bool probeBusy;
  final bool hasUpdate;
  final VoidCallback onBack;
  final VoidCallback onRefresh;
  final VoidCallback onHome;
  final VoidCallback onFriends;
  final VoidCallback onForum;
  final VoidCallback onRegister;
  final VoidCallback onProbeTap;
  final VoidCallback onUpdateTap;
  final void Function(String action) onMenuAction;

  /// 站长管理入口：仅站长身份时为真，菜单里才出现「管理」（默认隐藏）。
  final bool showAdmin;

  const QfToolbar({
    super.key,
    required this.palette,
    required this.canGoBack,
    required this.lastProbe,
    required this.probeBusy,
    required this.hasUpdate,
    required this.onBack,
    required this.onRefresh,
    required this.onHome,
    required this.onFriends,
    required this.onForum,
    required this.onRegister,
    required this.onProbeTap,
    required this.onUpdateTap,
    required this.onMenuAction,
    this.showAdmin = false,
  });

  Color get _lightColor {
    if (probeBusy || lastProbe == null) return QfPalette.probeBusy;
    return lastProbe!.ok ? QfPalette.probeOk : QfPalette.probeBad;
  }

  @override
  Widget build(BuildContext context) {
    final iconColor = palette.toolbarIcon;
    final btnStyle = IconButton.styleFrom(
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
    );
    return Container(
      height: 52,
      decoration: BoxDecoration(
        color: palette.toolbarColor,
        border: Border(bottom: BorderSide(color: palette.toolbarBorder)),
      ),
      child: LayoutBuilder(
        builder: (context, constraints) {
          // 按钮位宽按真实渲染宽算账（适配点验 2026-10-25 实测教训）：
          // IconButton 实际渲染 48 而非 constraints 写的 40——6 导航＋更新＋菜单
          // ＋状态灯，非紧凑总宽约 451、紧凑（灯只留色点＋位宽 40）约 351。
          // 故 <470 走紧凑档，并用 SizedBox 紧约束把位宽落实到 40，
          // 360 宽不溢出、不裁切（整行仍按可用宽排，不设固定 min-width）。
          final compact = constraints.maxWidth < 470;
          final slotW = compact ? 40.0 : 48.0;
          const btnBox = BoxConstraints(minWidth: 40, minHeight: 40);
          return Row(
            children: [
              SizedBox(width: slotW, child: IconButton(
                style: btnStyle,
                constraints: btnBox,
                tooltip: '后退',
                icon: Icon(Icons.arrow_back_ios_new, size: 24, color: canGoBack ? iconColor : iconColor.withValues(alpha: 0.35)),
                onPressed: canGoBack ? onBack : null,
              )),
              SizedBox(width: slotW, child: IconButton(
                style: btnStyle,
                constraints: btnBox,
                tooltip: '刷新',
                icon: Icon(Icons.refresh, size: 24, color: iconColor),
                onPressed: onRefresh,
              )),
              SizedBox(width: slotW, child: IconButton(
                style: btnStyle,
                constraints: btnBox,
                tooltip: '主页',
                icon: Icon(Icons.home_outlined, size: 24, color: iconColor),
                onPressed: onHome,
              )),
              SizedBox(width: slotW, child: IconButton(
                style: btnStyle,
                constraints: btnBox,
                tooltip: '好友',
                icon: Icon(Icons.person_outline, size: 24, color: iconColor),
                onPressed: onFriends,
              )),
              SizedBox(width: slotW, child: IconButton(
                style: btnStyle,
                constraints: btnBox,
                tooltip: '论坛',
                icon: Icon(Icons.forum_outlined, size: 24, color: iconColor),
                onPressed: onForum,
              )),
              SizedBox(width: slotW, child: IconButton(
                style: btnStyle,
                constraints: btnBox,
                tooltip: '注册新账号',
                icon: Icon(Icons.how_to_reg_outlined, size: 24, color: iconColor),
                onPressed: onRegister,
              )),
              const Spacer(),
              // 服务器状态灯（真探活，点击看最近一次结果）
              InkWell(
                onTap: onProbeTap,
                borderRadius: BorderRadius.circular(20),
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Container(
                        width: 11,
                        height: 11,
                        decoration: BoxDecoration(
                          color: _lightColor,
                          shape: BoxShape.circle,
                        ),
                      ),
                      if (!compact) ...[
                        const SizedBox(width: 6),
                        Text('服务器', style: TextStyle(color: iconColor, fontSize: 12)),
                      ],
                    ],
                  ),
                ),
              ),
              if (hasUpdate)
                SizedBox(width: slotW, child: Stack(
                  clipBehavior: Clip.none,
                  children: [
                    SizedBox(width: slotW, child: IconButton(
                      style: btnStyle,
                      constraints: btnBox,
                      tooltip: '有新版本',
                      icon: Icon(Icons.system_update_alt, size: 24, color: iconColor),
                      onPressed: onUpdateTap,
                    )),
                    Positioned(
                      right: 8,
                      top: 8,
                      child: Container(
                        width: 9,
                        height: 9,
                        decoration: const BoxDecoration(color: QfPalette.accent, shape: BoxShape.circle),
                      ),
                    ),
                  ],
                )),
              SizedBox(width: slotW, child: PopupMenuButton<String>(
                tooltip: '更多',
                icon: Icon(Icons.more_vert, color: iconColor),
                onSelected: onMenuAction,
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
                itemBuilder: (context) => [
                  if (showAdmin)
                    const PopupMenuItem(value: 'admin', child: Text('管理')),
                  const PopupMenuItem(value: 'theme', child: Text('切换主题（亮蓝/深灰）')),
                  const PopupMenuItem(value: 'fullscreen', child: Text('全屏模式')),
                  const PopupMenuItem(value: 'screenshot', child: Text('截图保存')),
                  const PopupMenuItem(value: 'checkUpdate', child: Text('检查更新')),
                  const PopupMenuItem(value: 'lock', child: Text('隐私锁')),
                  const PopupMenuItem(value: 'logout', child: Text('退出账号')),
                  const PopupMenuItem(value: 'about', child: Text('关于')),
                ],
              )),
            ],
          );
        },
      ),
    );
  }
}

/// 工具栏下方的看护状态行：只在断线重连时出现一行小字，连上自动消失
/// （与 Windows 版同一口径：不弹窗、不踢回登录页）。
class WatchdogStatusLine extends StatelessWidget {
  final bool visible;
  final QfPalette palette;
  const WatchdogStatusLine({super.key, required this.visible, required this.palette});

  @override
  Widget build(BuildContext context) {
    return AnimatedContainer(
      duration: const Duration(milliseconds: 200),
      height: visible ? 22 : 0,
      color: palette.statusLineColor,
      child: visible
          ? const Center(
              child: Text(
                '连接断开，正在重连…',
                style: TextStyle(color: Colors.white70, fontSize: 11.5),
              ),
            )
          : null,
    );
  }
}
