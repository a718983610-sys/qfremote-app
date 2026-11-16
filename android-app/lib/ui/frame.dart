import 'package:flutter/material.dart';

import '../core/slot_nav.dart';
import 'qf_icons.dart';
import 'reduced_motion.dart';
import 'theme.dart';

/// App 框架（2.3.0 定版样图 m02/m09）：黑白顶栏＋底部四标签。
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

  /// 滚动超过 8px 时为真：顶栏出现 1px 底部分割线（A §3.3，120ms 淡入
  /// 由 AnimatedContainer 承载）；默认无阴影、无分割线。
  final bool scrolled;

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
    this.scrolled = false,
  });

  @override
  Widget build(BuildContext context) {
    // 顶栏向上覆盖状态栏区域（框架不再外包 SafeArea，顶栏自己吃顶部 inset）
    final topInset = MediaQuery.of(context).padding.top;
    final p = palette;
    return AnimatedContainer(
      duration: QfMotion.resolve(context, QfMotion.d1),
      decoration: BoxDecoration(
        color: palette.toolbarColor,
        border: scrolled
            ? Border(bottom: BorderSide(color: palette.toolbarBorder))
            : null,
      ),
      padding: EdgeInsets.only(left: 12, right: 12, top: topInset),
      child: SizedBox(
        // A §3.3：顶栏高 56px＋状态栏。
        height: 56,
        child: Row(
          children: [
            Container(
              // W4 S 档：32／圆角 8／padding 4／内图 24；浅色白底加 1px 描边（A1）。
              width: 32,
              height: 32,
              padding: const EdgeInsets.all(4),
              decoration: BoxDecoration(
                color: p.tileFill,
                borderRadius: BorderRadius.circular(QfScale.rSmall),
                border: p.isDark ? null : Border.all(color: p.lineDefault),
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
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                // A §3.3：标题 20/28/600；字重只用 400/500/600（A §2.2）。
                style: QfType.title20(p.toolbarText),
              ),
            ),
            // 服务器状态点（点一下立即检测并提示结果）：6px 状态点
            // （A §2.7），热区 48（6＋21×2）。
            Tooltip(
              message: probeBusy ? '正在检查服务连接' : '检查服务连接',
              child: Semantics(
                button: true,
                enabled: !probeBusy,
                label: probeBusy ? '正在检查服务连接' : '检查服务连接',
                child: InkWell(
                  onTap: probeBusy ? null : onProbeTap,
                  borderRadius: BorderRadius.circular(QfScale.rPill),
                  child: SizedBox(
                    width: 48,
                    height: 48,
                    child: Center(
                      child: probeBusy
                          ? SizedBox(
                              width: 14,
                              height: 14,
                              child: QfLoadingIndicator(
                                color: p.toolbarText,
                                strokeWidth: 1.5,
                              ),
                            )
                          : Container(
                              width: QfPalette.statusDotSize,
                              height: QfPalette.statusDotSize,
                              decoration: BoxDecoration(
                                color: probeColor,
                                shape: BoxShape.circle,
                                border: Border.all(color: p.toolbarText),
                              ),
                            ),
                    ),
                  ),
                ),
              ),
            ),
            if (hasUpdate)
              Stack(
                clipBehavior: Clip.none,
                children: [
                  IconButton(
                    tooltip: '有新版本',
                    icon: QfIcon(
                      QfIconKind.download,
                      size: 23,
                      color: p.toolbarIcon,
                    ),
                    onPressed: onUpdateTap,
                  ),
                  Positioned(
                    right: 9,
                    top: 9,
                    child: SizedBox(
                      width: 9,
                      height: 9,
                      child: DecoratedBox(
                        // A1 定夺：更新徽标点走 toolbarBadge（浅 brand 黑／深白）；
                        // 旧“纯白”在 A1 后的浅色白顶栏上会隐形。纯装饰，不用状态色。
                        decoration: BoxDecoration(
                          color: p.toolbarBadge,
                          shape: BoxShape.circle,
                        ),
                      ),
                    ),
                  ),
                ],
              ),
            PopupMenuButton<String>(
              tooltip: '更多',
              icon: Icon(Icons.more_vert, color: p.toolbarIcon),
              onSelected: onMenuAction,
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(QfScale.radiusMd),
              ),
              itemBuilder: (context) => [
                if (showAdmin)
                  const PopupMenuItem(value: 'admin', child: Text('管理')),
                const PopupMenuItem(value: 'friends', child: Text('好友')),
                const PopupMenuItem(value: 'forum', child: Text('论坛')),
                const PopupMenuItem(value: 'refresh', child: Text('刷新')),
                const PopupMenuItem(value: 'fullscreen', child: Text('全屏模式')),
                const PopupMenuItem(value: 'screenshot', child: Text('截图保存')),
                const PopupMenuItem(value: 'theme', child: Text('切换主题（浅色/深色）')),
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

/// 底部四标签（2.3.1 效果图定版）：首页/文件/设备/我的。
/// 好友/论坛不在底部导航（降为首页长页快速入口＋顶栏菜单可达，槽位保活不变）。
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
      // A3 定夺：项高 64 固定 token；1px 顶边用 border 绘制，不占内容布局；
      // 内部 Column 居中，不再用 63+1 / 上下 6/7 拼魔数凑高。
      height: QfScale.bottomTabItemHeight + bottomInset,
      decoration: BoxDecoration(
        color: p.cardColor,
        border: Border(top: BorderSide(color: p.cardBorder)),
      ),
      padding: EdgeInsets.only(bottom: bottomInset),
      child: Row(
        children: [
          _tab(context, AppSlot.home, Icons.home, Icons.home_outlined, '首页'),
          _tab(
            context,
            AppSlot.files,
            Icons.folder,
            Icons.folder_outlined,
            '文件',
          ),
          _tab(
            context,
            AppSlot.devices,
            Icons.monitor,
            Icons.monitor_outlined,
            '设备',
          ),
          _tab(context, AppSlot.me, Icons.person, Icons.person_outline, '我的'),
        ],
      ),
    );
  }

  Widget _tab(
    BuildContext context,
    AppSlot slot,
    IconData iconSelected,
    IconData icon,
    String label,
  ) {
    final selected = slot == active;
    // A8 定夺：未激活用三级灰（浅 #71717A／深 #8A8A93＝textTertiary），
    // 选中用 brand；图标 filled/outlined＋字重双编码，pill 不动。
    final color = selected ? palette.brand : palette.textTertiary;
    return Expanded(
      child: Semantics(
        selected: selected,
        button: true,
        child: InkWell(
          onTap: selected ? null : () => onSelect(slot),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              // A §3.3：激活 56×32 中性 pill（8%）＋label 600；
              // 未激活图标三级灰；选中同时有色＋形状（C §1.3）。
              // B §3.3：tab 切换内容 D2 crossfade、不横向滑动；
              // press D0 scale .985 由 InkWell 涟漪＋本行无缩放承载
              // （行级 press 禁弹跳）；指示条语义由 pill 形状承载。
              AnimatedContainer(
                duration: QfMotion.resolve(context, QfMotion.d1),
                curve: QfMotion.easeOut,
                width: 56,
                height: 32,
                decoration: BoxDecoration(
                  color: selected ? palette.tabPill : null,
                  borderRadius: BorderRadius.circular(QfScale.rPill),
                ),
                child: Icon(
                  selected ? iconSelected : icon,
                  size: 24,
                  color: color,
                ),
              ),
              const SizedBox(height: 2),
              Text(
                label,
                style: QfType.label12(
                  color,
                  w: selected ? FontWeight.w600 : FontWeight.w500,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// 原生子页顶栏（样图 ptop）：顶栏带＋返回＋标题＋右侧小字，
/// 状态栏区域一并染色（沉浸式，与主框架顶栏同令牌 toolbarColor）。
class QfPageHeader extends StatelessWidget {
  final QfPalette palette;
  final String title;
  final String? rightText;
  final VoidCallback? onRightTap;
  final VoidCallback onBack;

  const QfPageHeader({
    super.key,
    required this.palette,
    required this.title,
    required this.onBack,
    this.rightText,
    this.onRightTap,
  });

  @override
  Widget build(BuildContext context) {
    final p = palette;
    return Container(
      color: palette.toolbarColor,
      child: SafeArea(
        bottom: false,
        child: SizedBox(
          // A §3.3：顶栏高 56px＋状态栏；标题 20/28/600，1 行末省略；
          // 返回/操作热区 48×48（IconButton 默认 48 命中区）。
          height: 56,
          child: Row(
            children: [
              IconButton(
                tooltip: '返回',
                icon: Icon(
                  Icons.arrow_back_ios_new,
                  size: 20,
                  color: p.toolbarIcon,
                ),
                onPressed: onBack,
              ),
              Expanded(
                child: Text(
                  title,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: QfType.title20(p.toolbarText),
                ),
              ),
              if (rightText != null)
                GestureDetector(
                  onTap: onRightTap,
                  child: Padding(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 14,
                      vertical: 15,
                    ),
                    child: Text(
                      rightText!,
                      // A1 定夺：右侧小字走 toolbarText 实色（与标题同 token）；
                      // 旧实色白只在黑顶栏上成立，浅色白顶栏上会隐形。
                      style: TextStyle(
                        color: p.toolbarText,
                        fontSize: QfScale.fs13,
                      ),
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
