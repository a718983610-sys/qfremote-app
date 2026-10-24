import 'package:flutter/material.dart';

import '../services/probe.dart';
import 'theme.dart';

/// 手机端精简工具栏（对齐 Windows 版能力，布局按手机适配）：
/// 后退 / 刷新 / 主页 / 状态灯（真探活）/ 更新徽标 / 更多菜单。
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
  });

  Color get _lightColor {
    if (probeBusy || lastProbe == null) return QfPalette.probeBusy;
    return lastProbe!.ok ? QfPalette.probeOk : QfPalette.probeBad;
  }

  @override
  Widget build(BuildContext context) {
    final iconColor = palette.toolbarIcon;
    return Container(
      height: 52,
      decoration: BoxDecoration(gradient: palette.toolbarGradient),
      child: Row(
        children: [
          IconButton(
            tooltip: '后退',
            icon: Icon(Icons.arrow_back_ios_new, size: 19, color: canGoBack ? iconColor : iconColor.withValues(alpha: 0.35)),
            onPressed: canGoBack ? onBack : null,
          ),
          IconButton(
            tooltip: '刷新',
            icon: Icon(Icons.refresh, size: 21, color: iconColor),
            onPressed: onRefresh,
          ),
          IconButton(
            tooltip: '主页',
            icon: Icon(Icons.home_outlined, size: 21, color: iconColor),
            onPressed: onHome,
          ),
          IconButton(
            tooltip: '好友',
            icon: Icon(Icons.person_add_outlined, size: 21, color: iconColor),
            onPressed: onFriends,
          ),
          IconButton(
            tooltip: '论坛',
            icon: Icon(Icons.forum_outlined, size: 21, color: iconColor),
            onPressed: onForum,
          ),
          IconButton(
            tooltip: '注册新账号',
            icon: Icon(Icons.how_to_reg_outlined, size: 21, color: iconColor),
            onPressed: onRegister,
          ),
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
                      boxShadow: [BoxShadow(color: _lightColor.withValues(alpha: 0.7), blurRadius: 6)],
                    ),
                  ),
                  const SizedBox(width: 6),
                  Text('服务器', style: TextStyle(color: iconColor, fontSize: 12)),
                ],
              ),
            ),
          ),
          if (hasUpdate)
            Stack(
              clipBehavior: Clip.none,
              children: [
                IconButton(
                  tooltip: '有新版本',
                  icon: Icon(Icons.system_update_alt, size: 21, color: iconColor),
                  onPressed: onUpdateTap,
                ),
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
            ),
          PopupMenuButton<String>(
            tooltip: '更多',
            icon: Icon(Icons.more_vert, color: iconColor),
            onSelected: onMenuAction,
            itemBuilder: (context) => const [
              PopupMenuItem(value: 'theme', child: Text('切换主题（亮蓝/深灰）')),
              PopupMenuItem(value: 'fullscreen', child: Text('全屏模式')),
              PopupMenuItem(value: 'screenshot', child: Text('截图保存')),
              PopupMenuItem(value: 'checkUpdate', child: Text('检查更新')),
              PopupMenuItem(value: 'lock', child: Text('隐私锁')),
              PopupMenuItem(value: 'about', child: Text('关于')),
            ],
          ),
        ],
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
      color: palette.isDark ? const Color(0xFF22242A) : const Color(0xFF0E2A52),
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
