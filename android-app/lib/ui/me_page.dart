import 'package:flutter/material.dart';

import '../services/points.dart';
import 'theme.dart';

/// 「我的」页（2.3.0 定版样图 m09）：个人卡＋使用时长/积分双统计卡＋账号行。
/// 数据来自积分服务（与关于页同一取数）；取不到时显示「—」，不挡页面。
class MePage extends StatefulWidget {
  final QfPalette palette;
  final String currentVersion;
  final bool hasUpdate;
  final String? updateVersion;

  /// 个人卡副行：记住此设备状态（如「已记住此设备，30 天内不用再登录」）。
  final String rememberLine;
  final String? fallbackUser;
  final Future<PointsInfo?> Function() fetchPoints;
  final VoidCallback onOpenSettings;
  final VoidCallback onCheckUpdate;
  final VoidCallback onAccountAction;
  final VoidCallback onLogout;

  const MePage({
    super.key,
    required this.palette,
    required this.currentVersion,
    required this.hasUpdate,
    required this.updateVersion,
    required this.rememberLine,
    required this.fallbackUser,
    required this.fetchPoints,
    required this.onOpenSettings,
    required this.onCheckUpdate,
    required this.onAccountAction,
    required this.onLogout,
  });

  @override
  State<MePage> createState() => _MePageState();
}

/// 使用时长统计卡的大字格式（样图口径）：<365 天「N 天」，否则「Y 年 ZZ 天」。
String formatUsedDays(int days) {
  if (days < 365) return '$days 天';
  final y = days ~/ 365;
  final r = days % 365;
  return '$y 年 ${r.toString().padLeft(2, '0')} 天';
}

class _MePageState extends State<MePage> {
  PointsInfo? _points;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final info = await widget.fetchPoints();
    if (!mounted) return;
    setState(() => _points = info);
  }

  @override
  Widget build(BuildContext context) {
    final p = widget.palette;
    final user = _points?.user ?? widget.fallbackUser ?? '已登录';
    final days = _points?.daysUsed;
    return Material(
      color: p.pageColor,
      child: Column(
        children: [
          // 样图顶栏：品牌标＋「我的」＋右侧「设置」
          Container(
            color: QfPalette.navy,
            child: SafeArea(
              bottom: false,
              child: SizedBox(
                height: 50,
                child: Row(
                  children: [
                    const SizedBox(width: 12),
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
                    const Expanded(
                      child: Text('我的',
                          style: TextStyle(color: Colors.white, fontSize: 17, fontWeight: FontWeight.w700)),
                    ),
                    TextButton(
                      onPressed: widget.onOpenSettings,
                      child: Text('设置',
                          style: TextStyle(color: Colors.white.withValues(alpha: 0.85), fontSize: 14)),
                    ),
                  ],
                ),
              ),
            ),
          ),
          Expanded(
            child: ListView(
              padding: const EdgeInsets.fromLTRB(16, 14, 16, 20),
              children: [
                _card(
                  child: Row(
                    children: [
                      const QfAvatarPlaceholder(size: 52),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(user,
                                style: TextStyle(color: p.onCard, fontSize: 17, fontWeight: FontWeight.w700)),
                            const SizedBox(height: 3),
                            Text(widget.rememberLine,
                                style: TextStyle(color: p.onCardDim, fontSize: 12.5, height: 1.45)),
                          ],
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 12),
                Row(
                  children: [
                    Expanded(
                      child: _statCard(
                        label: '使用时长',
                        big: days != null ? '已经 ${formatUsedDays(days)}' : (_points?.displayText ?? '—'),
                        bigColor: QfPalette.navy,
                      ),
                    ),
                    const SizedBox(width: 11),
                    Expanded(
                      child: _statCard(
                        label: '我的积分',
                        big: _points?.points != null ? '${_points!.points} 分' : '—',
                        bigColor: QfPalette.accent,
                        sub: '满 2 小时积 1 分',
                      ),
                    ),
                  ],
                ),
                Padding(
                  padding: const EdgeInsets.only(top: 10, left: 2),
                  child: Text('三端时间都算在一起。',
                      style: TextStyle(color: p.onCardDim, fontSize: 11.5)),
                ),
                _section('账号'),
                _rowCard(
                  title: '修改密码',
                  onTap: widget.onAccountAction,
                  chevron: true,
                ),
                const SizedBox(height: 11),
                _rowCard(
                  title: '改名',
                  onTap: widget.onAccountAction,
                  chevron: true,
                ),
                const SizedBox(height: 11),
                _rowCard(
                  title: '软件版本 ${widget.currentVersion}',
                  sub: widget.hasUpdate ? '发现新版 v${widget.updateVersion}' : '已经是最新版',
                  actionLabel: '检查更新',
                  onAction: widget.onCheckUpdate,
                ),
                const SizedBox(height: 11),
                _rowCard(
                  title: '退出账号',
                  titleColor: QfPalette.probeBad,
                  sub: '退出后记住的密码会一起清掉',
                  onTap: widget.onLogout,
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _section(String text) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(2, 18, 2, 10),
      child: Text(text,
          style: TextStyle(color: widget.palette.onCardDim, fontSize: 12.5, fontWeight: FontWeight.w700, letterSpacing: 0.4)),
    );
  }

  Widget _card({required Widget child}) {
    final p = widget.palette;
    return Container(
      decoration: BoxDecoration(
        color: p.cardColor,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: p.cardBorder),
      ),
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 15),
      child: child,
    );
  }

  Widget _statCard({required String label, required String big, required Color bigColor, String? sub}) {
    final p = widget.palette;
    return Container(
      decoration: BoxDecoration(
        color: p.cardColor,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: p.cardBorder),
      ),
      padding: const EdgeInsets.fromLTRB(16, 13, 16, 13),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(label, style: TextStyle(color: p.onCardDim, fontSize: 12.5)),
          const SizedBox(height: 7),
          Text(big,
              style: TextStyle(
                  color: widget.palette.isDark ? widget.palette.onCard : bigColor,
                  fontSize: 19,
                  fontWeight: FontWeight.w800,
                  height: 1.3)),
          if (sub != null) ...[
            const SizedBox(height: 5),
            Text(sub, style: TextStyle(color: p.onCardDim, fontSize: 12)),
          ],
        ],
      ),
    );
  }

  Widget _rowCard({
    required String title,
    String? sub,
    Color? titleColor,
    bool chevron = false,
    String? actionLabel,
    VoidCallback? onAction,
    VoidCallback? onTap,
  }) {
    final p = widget.palette;
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(14),
      child: _card(
        child: Row(
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(title,
                      style: TextStyle(color: titleColor ?? p.onCard, fontSize: 15, fontWeight: FontWeight.w600)),
                  if (sub != null) ...[
                    const SizedBox(height: 2),
                    Text(sub, style: TextStyle(color: p.onCardDim, fontSize: 12.5)),
                  ],
                ],
              ),
            ),
            if (actionLabel != null)
              OutlinedButton(
                onPressed: onAction,
                style: OutlinedButton.styleFrom(
                  foregroundColor: QfPalette.brand,
                  side: BorderSide(color: p.cardBorder),
                  padding: const EdgeInsets.symmetric(horizontal: 13),
                  minimumSize: const Size(0, 32),
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
                ),
                child: Text(actionLabel, style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600)),
              ),
            if (chevron) Icon(Icons.chevron_right, size: 19, color: p.onCardDim),
          ],
        ),
      ),
    );
  }
}
