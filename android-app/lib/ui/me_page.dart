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

  /// 构建号（F-A7 返工，C §1.3）：PackageInfo.buildNumber，由 main 传入；
  /// 为空时只显示 version 串（旧调用点／测试不传时不破版）。
  final String? buildNumber;
  final bool hasUpdate;
  final String? updateVersion;

  /// 个人卡副行：记住此设备状态（如「已记住此设备，30 天内不用再登录」）。
  final String rememberLine;
  final String? fallbackUser;
  final Future<PointsInfo?> Function() fetchPoints;

  /// B7 返修：积分拉取遇 401/403（登录已过期）时为真——「我的」页显示
  /// 「登录已过期，请重新登录」＋重新登录入口，不再只显示空白占位。
  final bool authDead;

  /// B7 返修：重新登录入口（只清会话快照、走凭据恢复链，不清已存凭据）。
  final VoidCallback? onRelogin;

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

  /// H26/QF-33/三端入口（站长 13:34 定）：「API 密钥」带字行，点开进
  /// 控制台 API 生成页（生成／撤销）；为空时整行不出现。
  final VoidCallback? onOpenApiKeys;

  /// C1：LEA 自助链接密钥列表取数（可选注入）：为空时「已链接的设备」
  /// 整区不出现；取不到时显示占位，不挡页面。
  final Future<List<LeaKeyInfo>?> Function()? fetchLeaKeys;

  /// C1：吊销一条自助链接密钥（可选注入）：为空时不显示吊销按钮。
  final Future<bool> Function(String keyId)? revokeLeaKey;

  const MePage({
    super.key,
    required this.palette,
    required this.currentVersion,
    this.buildNumber,
    required this.hasUpdate,
    required this.updateVersion,
    required this.rememberLine,
    required this.fallbackUser,
    required this.fetchPoints,
    this.authDead = false,
    this.onRelogin,
    this.fetchProfile,
    this.fetchProfileAvatar,
    required this.onOpenSettings,
    required this.onCheckUpdate,
    required this.onAccountAction,
    required this.onLogout,
    this.licenseSection,
    this.onOpenWebsite,
    this.onOpenApiKeys,
    this.fetchLeaKeys,
    this.revokeLeaKey,
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

  /// C1：LEA 自助链接密钥（只展示 self_bind 的；控制台生成的 Key 在
  /// 网页 API 密钥页管理）。null＝未取到（显示占位，不挡页面）。
  List<LeaKeyInfo>? _leaKeys;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final info = await widget.fetchPoints();
    if (!mounted) return;
    setState(() => _points = info);
    final fetchLeaKeys = widget.fetchLeaKeys;
    if (fetchLeaKeys != null) {
      final keys = await fetchLeaKeys();
      if (!mounted) return;
      setState(() => _leaKeys = keys?.where((k) => k.selfBind).toList());
    }
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
            color: p.toolbarColor,
            child: SafeArea(
              bottom: false,
              child: SizedBox(
                height: 56,
                child: Row(
                  children: [
                    const SizedBox(width: 12),
                    Container(
                      // W4 S 档：32／圆角 8／padding 4／内图 24；浅色白底加 1px 描边（A1）。
                      width: 32,
                      height: 32,
                      padding: const EdgeInsets.all(4),
                      decoration: BoxDecoration(
                        color: p.tileFill,
                        borderRadius:
                            BorderRadius.circular(QfScale.rSmall),
                        border:
                            p.isDark ? null : Border.all(color: p.lineDefault),
                      ),
                      child: ClipRRect(
                        borderRadius: BorderRadius.circular(6),
                        child: Image.asset('assets/icon.png', fit: BoxFit.cover),
                      ),
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Text('我的',
                          style: TextStyle(
                              color: p.toolbarText,
                              fontSize: 20,
                              fontWeight: FontWeight.w600,
                              height: 28 / 20)),
                    ),
                    QfButtonTapTarget(child: TextButton(
                      onPressed: widget.onOpenSettings,
                      child: Text('设置',
                          // A1 定夺：走 toolbarText 实色；旧实色白只在黑顶栏上成立。
                          style: TextStyle(
                              color: p.toolbarText,
                              fontSize: QfScale.fs14)),
                    )),
                  ],
                ),
              ),
            ),
          ),
          Expanded(
            child: ListView(
              // A6 定夺：列表顶距统一 12（原 14）。
              padding: EdgeInsets.fromLTRB(16, QfScale.listTopGap, 16, 20),
              children: [
                // B7 返修：登录已过期时置顶提示＋重新登录入口，不显示空白占位。
                if (widget.authDead) ...[
                  _card(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text('登录已过期，请重新登录',
                            style: TextStyle(
                                color: p.onCard,
                                fontSize: QfScale.fs15,
                                fontWeight: FontWeight.w600)),
                        const SizedBox(height: 4),
                        Text('当前登录已过期，积分与许可信息无法读取，请重新登录后查看。',
                            style: TextStyle(
                                color: p.onCardDim, fontSize: QfScale.fs13)),
                        const SizedBox(height: 10),
                        QfButtonTapTarget(child: FilledButton(
                          onPressed: widget.onRelogin,
                          style: FilledButton.styleFrom(
                            backgroundColor: p.brand,
                            minimumSize: const Size(0, QfScale.buttonVisualHeight),
                            shape: RoundedRectangleBorder(
                                borderRadius: BorderRadius.circular(QfScale.radiusMd)),
                          ),
                          child: const Text('重新登录',
                              style: TextStyle(fontWeight: FontWeight.w600)),
                        )),
                      ],
                    ),
                  ),
                  const SizedBox(height: 12),
                ],
                // A 重做 §3.3：我的页只保留一个账户 hero 卡（头像 56、
                // 姓名 17→16/24/600、副信息 12/18 三级），其余设置全部扁平列表。
                _card(
                  child: Row(
                    children: [
                      if (_avatarBytes != null)
                        ClipOval(
                          child: Image.memory(_avatarBytes!,
                              width: 56, height: 56, fit: BoxFit.cover,
                              // 核对 D7：解码失败回退品牌占位，不留空白
                              errorBuilder: (_, _, _) =>
                                  const QfAvatarPlaceholder(size: 56)),
                        )
                      else
                        const QfAvatarPlaceholder(size: 56),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(user,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: QfType.title16(p.onCard)),
                            if (showAccountLine) ...[
                              const SizedBox(height: 2),
                              Text('账号 $accountUser',
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: QfType.meta12(p.textSecondary)),
                            ],
                            const SizedBox(height: 3),
                            Text(widget.rememberLine,
                                style: QfType.meta12(p.textSecondary)),
                          ],
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 12),
                // 统计不再做双卡片：扁平列表行，数值 tabular-nums 右对齐。
                _flatRow(
                  title: '使用时长',
                  value: days != null
                      ? '已经 ${formatUsedDays(days)}'
                      : (_points?.displayText ?? '—'),
                ),
                _flatRow(
                  title: '我的积分',
                  value: _points?.points != null ? '${_points!.points} 分' : '—',
                  sub: '签到得 1 分 · 满 1 小时积 1 分',
                  last: true,
                ),
                Padding(
                  padding: const EdgeInsets.only(top: 10, left: 2),
                  child: Text('三端时间都算在一起。',
                      style: QfType.meta12(p.textSecondary)),
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
                _rowCard(
                  title: '改名',
                  onTap: widget.onAccountAction,
                  chevron: true,
                ),
                if (widget.onOpenApiKeys != null)
                  _rowCard(
                    title: 'API 密钥',
                    sub: '生成与吊销 Muse 操作密钥',
                    onTap: widget.onOpenApiKeys,
                    chevron: true,
                  ),
                // C1：已链接的设备（LEA 自助链接密钥：设备名／平台／
                // 有效期／状态／吊销；只在注入取数时出现）。
                if (widget.fetchLeaKeys != null) _leaKeysCard(),
                _rowCard(
                  // F-A7：版本号＋构建号（C §1.3）；无 build 号时只显 version。
                  title:
                      '软件版本 ${displayVersion(widget.currentVersion)}${widget.buildNumber == null ? '' : '（构建 ${widget.buildNumber}）'}',
                  sub: widget.hasUpdate ? '发现新版 v${widget.updateVersion}' : '已经是最新版',
                  actionLabel: '检查更新',
                  onAction: widget.onCheckUpdate,
                ),
                if (widget.onOpenWebsite != null)
                  _rowCard(
                    title: '官网',
                    sub: 'QFRemote 官方网站',
                    onTap: widget.onOpenWebsite,
                    chevron: true,
                  ),
                const SizedBox(height: 12),
                _rowCard(
                  title: '退出账号',
                  titleColor: p.danger,
                  sub: '退出后记住的密码会一起清掉',
                  onTap: () => confirmAndLogout(context,
                      palette: p, onLogout: widget.onLogout),
                  last: true,
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  // C §1.3：分区标题高 32。
  Widget _section(String text) {
    return SizedBox(
      height: 32,
      child: Align(
        alignment: Alignment.centerLeft,
        child: Padding(
          padding: const EdgeInsets.only(left: 2),
          child: Text(text,
              style: QfType.label11(widget.palette.textSecondary)),
        ),
      ),
    );
  }

  /// 扁平列表行（A §2.6 去卡片化）：行高 56，分隔线左 inset 16，
  /// 最后一行无分隔；标题 16/24/600，副标题 12/18；数值右对齐 tabular。
  Widget _flatRow({
    required String title,
    required String value,
    String? sub,
    bool last = false,
  }) {
    final p = widget.palette;
    return Container(
      constraints: const BoxConstraints(minHeight: 56),
      decoration: BoxDecoration(
        border: last
            ? null
            : Border(bottom: BorderSide(color: p.lineDefault)),
      ),
      padding: EdgeInsets.symmetric(horizontal: 16, vertical: QfScale.listRowVertical),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(title,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: QfType.title16(p.onCard)),
                if (sub != null) ...[
                  const SizedBox(height: 2),
                  Text(sub, style: QfType.meta12(p.textSecondary)),
                ],
              ],
            ),
          ),
          const SizedBox(width: 12),
          Text(value,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: QfType.tabular(QfType.title16(p.onCard))),
        ],
      ),
    );
  }

  /// C1：已链接的设备卡。_leaKeys==null 时取数失败，显示占位；
  /// 空列表显示“暂无”；每行是在效／已吊销的自助链接密钥。
  Widget _leaKeysCard() {
    final p = widget.palette;
    final keys = _leaKeys;
    String dateText(int? ms) {
      if (ms == null) return '—';
      final d = DateTime.fromMillisecondsSinceEpoch(ms);
      return '${d.year}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';
    }

    String statusText(String s) => switch (s) {
          'active' => '使用中',
          'revoked' => '已吊销',
          'revoked_by_rebind' => '换绑后吊销',
          'expired' => '已过期',
          _ => s.isEmpty ? '未知' : s,
        };
    final rows = <Widget>[];
    if (keys == null) {
      rows.add(Text('密钥列表暂时不可用',
          style: TextStyle(color: p.onCardDim, fontSize: QfScale.fs13)));
    } else if (keys.isEmpty) {
      rows.add(Text('暂无已链接的设备',
          style: TextStyle(color: p.onCardDim, fontSize: QfScale.fs13)));
      rows.add(const SizedBox(height: 4));
      rows.add(Text('在桌面软件里点“链接这台电脑”后，设备会出现在这里。',
          style: TextStyle(color: p.onCardDim, fontSize: QfScale.fs13)));
    } else {
      for (final k in keys) {
        final title = (k.deviceName != null && k.deviceName!.isNotEmpty)
            ? k.deviceName!
            : k.keyId;
        final sub = [
          if (k.platform != null && k.platform!.isNotEmpty) k.platform!,
          statusText(k.status),
          '到期 ${dateText(k.expiresAt)}',
        ].join(' · ');
        rows.add(
          Container(
            constraints: const BoxConstraints(minHeight: 56),
            decoration: BoxDecoration(
              border: Border(bottom: BorderSide(color: p.lineDefault)),
            ),
            padding: EdgeInsets.symmetric(vertical: QfScale.listRowVertical),
            child: Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(title,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: QfType.title16(p.onCard)),
                    const SizedBox(height: 2),
                    Text(sub,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: QfType.meta12(p.textSecondary)),
                  ],
                ),
              ),
              if (k.status == 'active' && widget.revokeLeaKey != null)
                QfButtonTapTarget(child: OutlinedButton(
                  onPressed: () async {
                    final ok = await widget.revokeLeaKey!(k.keyId);
                    if (!mounted) return;
                    if (ok) {
                      setState(() => _leaKeys =
                          _leaKeys?.where((x) => x.keyId != k.keyId).toList());
                      ScaffoldMessenger.of(context).showSnackBar(
                          const SnackBar(content: Text('密钥已吊销，立即失效。')));
                    } else {
                      ScaffoldMessenger.of(context).showSnackBar(
                          const SnackBar(content: Text('吊销失败，请稍后再试。')));
                    }
                  },
                  style: OutlinedButton.styleFrom(
                    foregroundColor: p.brand,
                    side: BorderSide(color: p.cardBorder),
                    padding: const EdgeInsets.symmetric(horizontal: 13),
                    minimumSize: const Size(0, QfScale.buttonVisualHeight),
                    shape: RoundedRectangleBorder(
                        borderRadius:
                            BorderRadius.circular(QfScale.radiusMd)),
                  ),
                  child: const Text('吊销',
                      style: TextStyle(
                          fontSize: QfScale.fs13, fontWeight: FontWeight.w600)),
                )),
            ],
            ),
          ),
        );
      }
    }
    // 扁平列表：标题行＋每密钥一行（行高 56，分隔线左 inset 16），
    // 不做卡片（A §2.6：只有账户 hero 卡保留卡片）。
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        _section('已链接的设备'),
        ...rows,
      ],
    );
  }

  Widget _card({required Widget child}) {
    final p = widget.palette;
    return Container(
      decoration: BoxDecoration(
        color: p.cardColor,
        borderRadius: BorderRadius.circular(QfScale.radiusMd),
        border: Border.all(color: p.cardBorder),
      ),
      padding: EdgeInsets.symmetric(
          horizontal: QfScale.cardPadding, vertical: QfScale.cardPadding),
      child: child,
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
    bool last = false,
  }) {
    final p = widget.palette;
    return InkWell(
      onTap: onTap,
      child: Container(
        constraints: const BoxConstraints(minHeight: 56),
        decoration: BoxDecoration(
          border: last
              ? null
              : Border(bottom: BorderSide(color: p.lineDefault)),
        ),
        padding: EdgeInsets.symmetric(horizontal: 16, vertical: QfScale.listRowVertical),
        child: Row(
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(title,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: QfType.title16(titleColor ?? p.onCard)),
                  if (sub != null) ...[
                    const SizedBox(height: 2),
                    Text(sub,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: QfType.meta12(p.textSecondary)),
                  ],
                ],
              ),
            ),
            if (actionLabel != null)
              QfButtonTapTarget(child: OutlinedButton(
                onPressed: onAction,
                style: OutlinedButton.styleFrom(
                  foregroundColor: p.brand,
                  side: BorderSide(color: p.cardBorder),
                  padding: const EdgeInsets.symmetric(horizontal: 13),
                  minimumSize: const Size(0, QfScale.buttonVisualHeight),
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(QfScale.radiusMd)),
                ),
                child: Text(actionLabel, style: const TextStyle(fontSize: QfScale.fs13, fontWeight: FontWeight.w600)),
              )),
            if (chevron) Icon(Icons.chevron_right, size: 16, color: p.textTertiary),
          ],
        ),
      ),
    );
  }

}
