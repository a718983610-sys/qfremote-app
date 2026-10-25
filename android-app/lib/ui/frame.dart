import 'package:flutter/material.dart';

import '../core/slot_nav.dart';
import 'theme.dart';

/// App 框架（2.3.0 定版样图 m02/m09）：深蓝顶栏＋底部四标签。
/// 顶栏：品牌标＋当前页标题＋状态点/更新/更多菜单（旧工具栏功能全保留，
/// 只是按样图收进顶栏右侧与菜单，不删功能）。
class QfAppHeader extends StatelessWidget {
  final QfPalette palette;
  final String title;
  final Color probeColor;
  final bool probeBusy;
  final bool hasUpdate;
  final bool showAdmin;
  final VoidCallback onProbeTap;
  final VoidCallback onUpdateTap;
  final void Function(String action) onMenuAction;

  const QfAppHeader({
    super.key,
    required this.palette,
    required this.title,
    required this.probeColor,
    required this.probeBusy,
    required this.hasUpdate,
    required this.showAdmin,
    required this.onProbeTap,
    required this.onUpdateTap,
    required this.onMenuAction,
  });

  @override
  Widget build(BuildContext context) {
    // 深蓝带向上覆盖状态栏区域（框架不再外包 SafeArea，顶栏自己吃顶部 inset）
    final topInset = MediaQuery.of(context).padding.top;
    return Container(
      decoration: const BoxDecoration(color: QfPalette.navy),
      padding: EdgeInsets.only(left: 12, right: 12, top: topInset),
      child: SizedBox(
        height: 52,
        child: Row(
        children: [
          Container(
            width: 30,
            height: 30,
            padding: const EdgeInsets.all(2),
            decoration: BoxDecoration(
              color: Colors.white,
              borderRadius: BorderRadius.circular(8),
            ),
            child: ClipRRect(
              borderRadius: BorderRadius.circular(6),
              child: Image.asset('assets/icon.png', fit: BoxFit.cover),
            ),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              title,
              style: const TextStyle(
                color: Colors.white,
                fontSize: 17,
                fontWeight: FontWeight.w700,
              ),
            ),
          ),
          // 服务器状态点（点一下立即检测并提示结果）
          InkWell(
            onTap: onProbeTap,
            borderRadius: BorderRadius.circular(16),
            child: Padding(
              padding: const EdgeInsets.all(8),
              child: Container(
                width: 11,
                height: 11,
                decoration: BoxDecoration(color: probeColor, shape: BoxShape.circle),
              ),
            ),
          ),
          if (hasUpdate)
            Stack(
              clipBehavior: Clip.none,
              children: [
                IconButton(
                  tooltip: '有新版本',
                  icon: const Icon(Icons.system_update_alt, size: 23, color: Colors.white),
                  onPressed: onUpdateTap,
                ),
                const Positioned(
                  right: 9,
                  top: 9,
                  child: SizedBox(
                    width: 9,
                    height: 9,
                    child: DecoratedBox(
                      decoration: BoxDecoration(color: QfPalette.accent, shape: BoxShape.circle),
                    ),
                  ),
                ),
              ],
            ),
          PopupMenuButton<String>(
            tooltip: '更多',
            icon: const Icon(Icons.more_vert, color: Colors.white),
            onSelected: onMenuAction,
            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
            itemBuilder: (context) => [
              if (showAdmin)
                const PopupMenuItem(value: 'admin', child: Text('管理')),
              const PopupMenuItem(value: 'refresh', child: Text('刷新')),
              const PopupMenuItem(value: 'fullscreen', child: Text('全屏模式')),
              const PopupMenuItem(value: 'screenshot', child: Text('截图保存')),
              const PopupMenuItem(value: 'theme', child: Text('切换主题（亮蓝/深灰）')),
              const PopupMenuItem(value: 'checkUpdate', child: Text('检查更新')),
              const PopupMenuItem(value: 'lock', child: Text('隐私锁')),
              const PopupMenuItem(value: 'register', child: Text('注册新账号')),
              const PopupMenuItem(value: 'about', child: Text('关于')),
              const PopupMenuItem(value: 'logout', child: Text('退出账号')),
            ],
          ),
        ],
        ),
      ),
    );
  }
}

/// 底部四标签（样图 ptabs）：设备/好友/论坛/我的。
class QfTabBar extends StatelessWidget {
  final QfPalette palette;
  final AppSlot active;
  final void Function(AppSlot slot) onSelect;

  const QfTabBar({
    super.key,
    required this.palette,
    required this.active,
    required this.onSelect,
  });

  @override
  Widget build(BuildContext context) {
    final p = palette;
    // 底部吃手势导航条 inset：标签内容不被压，底色带延伸到屏幕底边
    final bottomInset = MediaQuery.of(context).padding.bottom;
    return Container(
      decoration: BoxDecoration(
        color: p.cardColor,
        border: Border(top: BorderSide(color: p.cardBorder)),
      ),
      padding: EdgeInsets.only(bottom: bottomInset),
      child: Row(
        children: [
          _tab(AppSlot.devices, Icons.monitor_outlined, '设备'),
          _tab(AppSlot.friends, Icons.people_outline, '好友'),
          _tab(AppSlot.forum, Icons.forum_outlined, '论坛'),
          _tab(AppSlot.me, Icons.person_outline, '我的'),
        ],
      ),
    );
  }

  Widget _tab(AppSlot slot, IconData icon, String label) {
    final selected = slot == active;
    final color = selected ? QfPalette.brand : palette.onCardDim;
    return Expanded(
      child: InkWell(
        onTap: () => onSelect(slot),
        child: Padding(
          padding: const EdgeInsets.only(top: 7, bottom: 8),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(icon, size: 24, color: color),
              const SizedBox(height: 2),
              Text(
                label,
                style: TextStyle(
                  color: color,
                  fontSize: 11,
                  fontWeight: selected ? FontWeight.w700 : FontWeight.w500,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// 原生子页顶栏（样图 ptop）：深蓝带＋返回＋标题＋右侧小字，
/// 状态栏区域一并染深蓝（沉浸式，与主框架顶栏同令牌）。
class QfPageHeader extends StatelessWidget {
  final String title;
  final String? rightText;
  final VoidCallback? onRightTap;
  final VoidCallback onBack;

  const QfPageHeader({
    super.key,
    required this.title,
    required this.onBack,
    this.rightText,
    this.onRightTap,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      color: QfPalette.navy,
      child: SafeArea(
        bottom: false,
        child: SizedBox(
          height: 50,
          child: Row(
            children: [
              IconButton(
                tooltip: '返回',
                icon: const Icon(Icons.arrow_back_ios_new, size: 20, color: Colors.white),
                onPressed: onBack,
              ),
              Expanded(
                child: Text(
                  title,
                  style: const TextStyle(color: Colors.white, fontSize: 17, fontWeight: FontWeight.w700),
                ),
              ),
              if (rightText != null)
                GestureDetector(
                  onTap: onRightTap,
                  child: Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 14),
                    child: Text(
                      rightText!,
                      style: TextStyle(color: Colors.white.withValues(alpha: 0.75), fontSize: 12.5),
                    ),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}
