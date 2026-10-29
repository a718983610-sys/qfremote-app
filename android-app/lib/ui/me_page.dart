import 'dart:typed_data';

import 'package:flutter/material.dart';

import '../services/points.dart';
import 'logout_confirm.dart';
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

  /// 统一档案取数（2.3.2 S4 接驳，可选注入）：为空或取不到时，个人卡
  /// 回退现行显示（积分 user → 已存账号名 → 「已登录」＋品牌占位）。
  final Future<ProfileInfo?> Function()? fetchProfile;

  /// 本人头像字节取数（可选注入）：为空/无头像/取不到时显示品牌占位。
  final Future<Uint8List?> Function(ProfileInfo info)? fetchProfileAvatar;
  final VoidCallback onOpenSettings;
  final VoidCallback onCheckUpdate;
  final VoidCallback onAccountAction;
  final VoidCallback onLogout;

  /// 「付费与激活」区（2.3.1 阶段 D 注入；为空时整区不出现）。
  final Widget? licenseSection;

  /// 「官网」带字行（收编 P1 补 X-02；为空时整行不出现）。
  final VoidCallback? onOpenWebsite;

  const MePage({
    super.key,
    required this.palette,
    required this.currentVersion,
    required this.hasUpdate,
    required this.updateVersion,
    required this.rememberLine,
    required this.fallbackUser,
    required this.fetchPoints,
    this.fetchProfile,
    this.fetchProfileAvatar,
    required this.onOpenSettings,
    required this.onCheckUpdate,
    required this.onAccountAction,
    required this.onLogout,
    this.licenseSection,
    this.onOpenWebsite,
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
  ProfileInfo? _profile;
  Uint8List? _avatarBytes;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final info = await widget.fetchPoints();
    if (!mounted) return;
    setState(() => _points = info);
    final fetchProfile = widget.fetchProfile;
    if (fetchProfile == null) return;
    final profile = await fetchProfile();
    if (!mounted || profile == null) return;
    setState(() => _profile = profile);
    final fetchAvatar = widget.fetchProfileAvatar;
    if (fetchAvatar == null || !profile.hasAvatar) return;
    final bytes = await fetchAvatar(profile);
    if (!mounted || bytes == null) return;
    setState(() => _avatarBytes = bytes);
  }

  @override
  Widget build(BuildContext context) {
    final p = widget.palette;
    // 个人卡身份（2.3.2 S4）：档案到手时主行显示生效昵称、副行补登录
    // 账号名（两者不同才补，与 DESIGN §四 C1「分行分称」同口径）；档案
    // 取不到时完全回退现行口径（积分 user → 已存账号名 → 「已登录」）。
    final accountUser =
        _profile?.username ?? _points?.user ?? widget.fallbackUser;
    final user = _profile?.effectiveNickname ?? accountUser ?? '已登录';
    final showAccountLine = _profile?.effectiveNickname != null &&
        accountUser != null &&
        accountUser != _profile!.effectiveNickname;
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
                      if (_avatarBytes != null)
                        ClipOval(
                          child: Image.memory(_avatarBytes!,
                              width: 52, height: 52, fit: BoxFit.cover,
                              // 核对 D7：解码失败回退品牌占位，不留空白
                              errorBuilder: (_, _, _) =>
                                  const QfAvatarPlaceholder(size: 52)),
                        )
                      else
                        const QfAvatarPlaceholder(size: 52),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(user,
                                style: TextStyle(color: p.onCard, fontSize: 17, fontWeight: FontWeight.w700)),
                            if (showAccountLine) ...[
                              const SizedBox(height: 2),
                              Text('账号 $accountUser',
                                  style: TextStyle(color: p.onCardDim, fontSize: 12.5)),
                            ],
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
                        sub: '签到得 1 分 · 满 1 小时积 1 分',
                      ),
                    ),
                  ],
                ),
                Padding(
                  padding: const EdgeInsets.only(top: 10, left: 2),
                  child: Text('三端时间都算在一起。',
                      style: TextStyle(color: p.onCardDim, fontSize: 11.5)),
                ),
                if (widget.licenseSection != null) ...[
                  _section('付费与激活'),
                  widget.licenseSection!,
                ],
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
                if (widget.onOpenWebsite != null) ...[
                  const SizedBox(height: 11),
                  _rowCard(
                    title: '官网',
                    sub: 'QFRemote 官方网站',
                    onTap: widget.onOpenWebsite,
                    chevron: true,
                  ),
                ],
                const SizedBox(height: 11),
                _rowCard(
                  title: '退出账号',
                  titleColor: QfPalette.probeBad,
                  sub: '退出后记住的密码会一起清掉',
                  onTap: () => confirmAndLogout(context,
                      palette: p, onLogout: widget.onLogout),
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
