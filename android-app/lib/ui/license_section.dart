import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../core/license.dart';
import 'license_gate.dart';
import 'theme.dart';

/// 「付费与激活」区（2.3.1 阶段 D，「我的」原生页内，与网页正本同源展示）：
/// 数据全走 /license/api/me（同源展示口径与网页首页一致）；取不到数据时
/// 显示诚实错误态＋重试，绝不填假状态。含：试用提示条（TrialBar）、许可
/// 概览卡（套餐/状态/密钥掩码/剩余时长/设备名额/网页版权益）、本机绑定框
/// （契约 §3 bind）、转赠领取框（契约 §7.5.3 已登录入口）、兑换KEY卡
/// （决策 #24 统一兑换入口：粘贴兑换＋待兑换列表一键兑换）、购买/查询
/// 入口（16:37 定版样式：购买黑底白字、查询主文字色加下划线文字链，壳内打开）。
class LicenseSection extends StatefulWidget {
  final QfPalette palette;
  final Future<LicenseMe?> Function() fetchLicense;
  final Future<LicenseOpResult?> Function(String key) onBind;
  final Future<LicenseOpResult?> Function(String key) onClaim;
  final VoidCallback onPurchase;
  final VoidCallback onStatusQuery;

  /// B7 返修：许可拉取遇 401/403（登录已过期）时为真——许可区显示
  /// 「登录已过期，请重新登录」＋重新登录入口，不再显示空白占位。
  final bool authDead;

  /// B7 返修：重新登录入口（只清会话快照、走凭据恢复链，不清已存凭据）。
  final VoidCallback? onRelogin;

  /// 决策 #24 兑换KEY（可选接线：三者齐备才显示兑换卡）。
  final Future<List<MyLicenseKey>?> Function()? fetchMyKeys;
  final Future<LicenseOpResult?> Function(String key)? onRedeem;
  final Future<LicenseOpResult?> Function(String keyId)? onRedeemId;

  const LicenseSection({
    super.key,
    required this.palette,
    required this.fetchLicense,
    required this.onBind,
    required this.onClaim,
    required this.onPurchase,
    required this.onStatusQuery,
    this.authDead = false,
    this.onRelogin,
    this.fetchMyKeys,
    this.onRedeem,
    this.onRedeemId,
  });

  @override
  State<LicenseSection> createState() => _LicenseSectionState();
}

class _LicenseSectionState extends State<LicenseSection> {
  LicenseMe? _me;
  bool _loading = true;
  bool _failed = false;
  final _bindCtrl = TextEditingController();
  final _claimCtrl = TextEditingController();
  final _redeemCtrl = TextEditingController();
  bool _bindBusy = false;
  bool _claimBusy = false;
  bool _redeemBusy = false;
  String? _bindOut;
  String? _claimOut;
  String? _redeemOut;
  List<MyLicenseKey> _myKeys = const [];
  String? _redeemingId;

  bool get _redeemWired =>
      widget.fetchMyKeys != null &&
      widget.onRedeem != null &&
      widget.onRedeemId != null;

  bool _purchaseFocused = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _bindCtrl.dispose();
    _claimCtrl.dispose();
    _redeemCtrl.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _failed = false;
    });
    final me = await widget.fetchLicense();
    List<MyLicenseKey>? keys;
    if (_redeemWired) {
      keys = await widget.fetchMyKeys!();
    }
    if (!mounted) return;
    setState(() {
      _loading = false;
      _failed = me == null;
      if (me != null) _me = me;
      if (keys != null) _myKeys = keys;
    });
  }

  Future<void> _submitRedeem() async {
    if (_redeemBusy) return;
    final input = _redeemCtrl.text;
    if (!isKeyFormatValid(input)) {
      setState(() => _redeemOut = '密钥格式不正确，请检查后重新输入。');
      return;
    }
    setState(() {
      _redeemBusy = true;
      _redeemOut = null;
    });
    final r = await widget.onRedeem!(input.trim());
    if (!mounted) return;
    setState(() {
      _redeemBusy = false;
      _redeemOut = r == null
          ? '网络异常，请稍后再试。'
          : (r.msg.isNotEmpty
              ? r.msg
              : (r.ok ? '兑换成功，密钥已激活。' : '兑换未成功，请核对后重试。'));
    });
    if (r != null && r.ok) {
      _redeemCtrl.clear();
      _load();
    }
  }

  Future<void> _redeemById(MyLicenseKey k) async {
    if (_redeemingId != null) return;
    setState(() {
      _redeemingId = k.keyId;
      _redeemOut = null;
    });
    final r = await widget.onRedeemId!(k.keyId);
    if (!mounted) return;
    setState(() {
      _redeemingId = null;
      _redeemOut = r == null
          ? '网络异常，请稍后再试。'
          : (r.msg.isNotEmpty
              ? r.msg
              : (r.ok ? '兑换成功，密钥已激活。' : '兑换未成功，请核对后重试。'));
    });
    if (r != null && r.ok) _load();
  }

  Future<void> _submitBind() async {
    if (_bindBusy) return;
    final input = _bindCtrl.text;
    if (!isKeyFormatValid(input)) {
      setState(() => _bindOut = '密钥格式不正确，请检查后重新输入。');
      return;
    }
    setState(() {
      _bindBusy = true;
      _bindOut = null;
    });
    final r = await widget.onBind(input.trim());
    if (!mounted) return;
    setState(() {
      _bindBusy = false;
      _bindOut = r == null
          ? '网络异常，请稍后再试。'
          : (r.msg.isNotEmpty
              ? r.msg
              : (r.ok ? '绑定成功。' : '绑定未成功，请核对后重试。'));
    });
    if (r != null && r.ok) {
      _bindCtrl.clear();
      _load();
    }
  }

  Future<void> _submitClaim() async {
    if (_claimBusy) return;
    final input = _claimCtrl.text;
    if (!isKeyFormatValid(input)) {
      setState(
          () => _claimOut = claimDisplayText(input: input, result: null));
      return;
    }
    setState(() {
      _claimBusy = true;
      _claimOut = null;
    });
    final r = await widget.onClaim(input.trim());
    if (!mounted) return;
    setState(() {
      _claimBusy = false;
      _claimOut = claimDisplayText(input: input, result: r);
    });
    if (r != null && r.ok) {
      _claimCtrl.clear();
      _load();
    }
  }

  Future<void> _copyDiagnostics() async {
    final me = _me;
    final text = [
      '许可状态：${me?.displayStatus ?? '—'}',
      '当前套餐：${me?.planName ?? '—'}',
      '密钥：${me?.maskedKey ?? '—'}',
      '剩余时长：${me != null ? licenseRemainText(me, DateTime.now().millisecondsSinceEpoch) : '—'}',
      '设备名额：电脑 ${me?.slotsPc ?? 0} / ${me?.slotsPcMax ?? 2} · 手机 ${me?.slotsMobile ?? 0} / ${me?.slotsMobileMax ?? 1}',
    ].join('\n');
    await Clipboard.setData(ClipboardData(text: text));
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text('诊断信息已复制，包含许可状态与密钥掩码。')),
    );
  }

  /// 有效期绝对时间（C §2.4：YYYY-MM-DD HH:mm，本地时区；无则 —）。
  /// 密钥到期优先，试用到期其次；两者皆无为 —，不编造日期。
  String _expiryText(LicenseMe? me) {
    final ms = me?.keyExpiresMs ?? me?.trialExpiresMs;
    if (ms == null) return '—';
    final d = DateTime.fromMillisecondsSinceEpoch(ms);
    String two(int v) => v.toString().padLeft(2, '0');
    return '${d.year}-${two(d.month)}-${two(d.day)} ${two(d.hour)}:${two(d.minute)}';
  }

  Color _statusDot(String? status) {
    final s = status ?? '';
    if (s.contains('过期') || s.contains('失效') || s.contains('封禁') || s.contains('冻结')) {
      return widget.palette.danger;
    }
    if (s.contains('试用')) return widget.palette.warning;
    return widget.palette.success;
  }

  @override
  Widget build(BuildContext context) {
    final p = widget.palette;
    final nowMs = DateTime.now().millisecondsSinceEpoch;
    final me = _me;
    final trialText = me != null ? trialBarText(me, nowMs) : null;
    final entryMode = licenseEntryMode(me);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        // B7 返修：登录已过期时许可区置顶提示＋重新登录入口（成功拉取后
        // 父级清标记，入口消失），不再显示空白占位。
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
                Text('当前登录已过期，许可信息无法读取，请重新登录后查看。',
                    style: TextStyle(color: p.onCardDim, fontSize: QfScale.fs13)),
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
        if (trialText != null) ...[
          TrialBar(palette: p, text: trialText, onPurchase: widget.onPurchase),
          const SizedBox(height: 12),
        ],
        // B7：登录已过期时不显示空白占位卡（上方已有过期提示＋重登入口）。
        if (!widget.authDead)
        _card(
          child: _loading && me == null
              ? Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('正在读取许可信息…',
                        style: QfType.meta12(p.textSecondary)),
                    const SizedBox(height: 12),
                    QfSkeletonRow(palette: p, withAvatar: false),
                    QfSkeletonRow(palette: p, withAvatar: false),
                  ],
                )
              : _failed && me == null
                  ? Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        // B21 返修：常驻重试入口——许可读取失败时一直显示
                        // 「许可信息读取失败，点重试」＋重试按钮（点即立即
                        // 重新拉取，不依赖 5 分钟后台重试）；成功后入口消失。
                        // 文案逐字保留（既有测试精确匹配）；错误码另起一行。
                        QfErrorLine(
                            palette: p, text: '许可信息读取失败，点重试。'),
                        Text('错误码：—。',
                            style: QfType.meta12(p.textSecondary)),
                        const SizedBox(height: 8),
                        QfButtonTapTarget(child: OutlinedButton(
                          onPressed: _load,
                          child: const Text('重试'),
                        )),
                      ],
                    )
                  : Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        // C §2.4：状态 chip（6px 点＋文字，不做大绿块）。
                        QfStatusChip(
                          palette: p,
                          label: me?.displayStatus ?? '—',
                          dotColor: _statusDot(me?.displayStatus),
                        ),
                        const SizedBox(height: 12),
                        _kv('当前套餐', me?.planName ?? '—'),
                        _kv('账户状态', me?.displayStatus ?? '—'),
                        _kv('密钥', me?.maskedKey ?? '—'),
                        _kv('有效期', _expiryText(me)),
                        _kv('剩余时长',
                            me != null ? licenseRemainText(me, nowMs) : '—'),
                        _kv('设备名额',
                            '电脑 ${me?.slotsPc ?? 0} / ${me?.slotsPcMax ?? 2} · 手机 ${me?.slotsMobile ?? 0} / ${me?.slotsMobileMax ?? 1}'),
                        _kv('设备名额（合计）',
                            '${(me?.slotsPc ?? 0) + (me?.slotsMobile ?? 0)} / ${(me?.slotsPcMax ?? 2) + (me?.slotsMobileMax ?? 1)}'),
                        _kv('网页版权益',
                            (me?.webEnabled ?? false)
                                ? '已开通'
                                : '未开通（真实付费购买后开通）',
                            last: true),
                      ],
                    ),
        ),
        // C §2.4：排障日志入口＋硬件指纹折叠。机器码／许可 ID／最后校验
        // 时间／硬件指纹四项在 LicenseMe／本 widget 入参里均无数据源，
        // 按 C 规则显示 — 并在报告列入缺数据 plumbing，不编假值。
        // ExpansionTile（ListTile）须包在自己的 Material 里，否则
        // Flutter 会断言 ink 被上层 DecoratedBox 底色遮住。
        if (!widget.authDead && !_loading)
          Material(
            color: p.cardColor,
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(QfScale.radiusMd),
              side: BorderSide(color: p.cardBorder),
            ),
            clipBehavior: Clip.antiAlias,
            child: Theme(
              data: Theme.of(context).copyWith(
                dividerColor: Colors.transparent,
              ),
              child: ExpansionTile(
                tilePadding:
                    const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
                childrenPadding:
                    const EdgeInsets.fromLTRB(16, 0, 16, 12),
                title: Text('排障与硬件信息',
                    style: QfType.title16(p.onCard)),
                subtitle: Text('机器码、许可 ID、最后校验、硬件指纹',
                    style: QfType.meta12(p.textSecondary)),
                children: [
                  _kv('机器码', '—'),
                  _kv('许可 ID', '—'),
                  _kv('最后校验时间', '—'),
                  _kv('硬件指纹', '—（默认折叠，未提供）'),
                  const SizedBox(height: 8),
                  Align(
                    alignment: Alignment.centerLeft,
                    child: QfButtonTapTarget(child: TextButton(
                      onPressed: _copyDiagnostics,
                      child: const Text('复制诊断信息'),
                    )),
                  ),
                ],
              ),
            ),
          ),
        // #49 分流：已激活（永久/按天）不再显示「输入密钥激活」卡。
        if (entryMode == LicenseEntryMode.inactive) ...[
        const SizedBox(height: 12),
        _card(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('输入密钥激活',
                  style: TextStyle(
                      color: p.onCard, fontSize: QfScale.fs15, fontWeight: FontWeight.w600)),
              const SizedBox(height: 4),
              Text('把密钥粘贴到这里，绑定到本机（两台电脑与一部手机）。',
                  style: TextStyle(color: p.onCardDim, fontSize: QfScale.fs13)),
              const SizedBox(height: 10),
              _keyRow(
                ctrl: _bindCtrl,
                busy: _bindBusy,
                btnLabel: '绑定本机',
                onSubmit: _submitBind,
              ),
              if (_bindOut != null) ...[
                const SizedBox(height: 8),
                Text(_bindOut!,
                    style: TextStyle(color: p.onCard, fontSize: QfScale.fs13, height: 1.5)),
              ],
            ],
          ),
        ),
        ],
        const SizedBox(height: 12),
        _card(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('领取转赠密钥',
                  style: TextStyle(
                      color: p.onCard, fontSize: QfScale.fs15, fontWeight: FontWeight.w600)),
              const SizedBox(height: 4),
              Text('如有人向您转赠密钥：先在登录页点「查询密钥」，凭账号和密码核验后复制完整密钥串，再粘贴到这里领取。领取成功后密钥即转入您的账号，原主人一侧同时失效。',
                  style: TextStyle(color: p.onCardDim, fontSize: QfScale.fs13, height: 1.5)),
              const SizedBox(height: 10),
              _keyRow(
                ctrl: _claimCtrl,
                busy: _claimBusy,
                btnLabel: '领取密钥',
                onSubmit: _submitClaim,
              ),
              if (_claimOut != null) ...[
                const SizedBox(height: 8),
                Text(_claimOut!,
                    style: TextStyle(color: p.onCard, fontSize: QfScale.fs13, height: 1.5)),
              ],
            ],
          ),
        ),
        // 决策 #24 兑换KEY：一切外来密钥的统一兑换/激活点（粘贴兑换＋
        // 本人待兑换密钥一键兑换），与网页正本 home-page 同口径。
        if (_redeemWired) ...[
        const SizedBox(height: 12),
        _card(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('兑换KEY',
                  style: TextStyle(
                      color: p.onCard, fontSize: QfScale.fs15, fontWeight: FontWeight.w600)),
              const SizedBox(height: 4),
              Text('在别处获得的密钥（购买转售、积分兑换等）粘贴到这里即可兑换激活；积分福利兑换的密钥会出现在下方待兑换列表中，点「一键兑换」即可激活。',
                  style: TextStyle(color: p.onCardDim, fontSize: QfScale.fs13, height: 1.5)),
              const SizedBox(height: 10),
              _keyRow(
                ctrl: _redeemCtrl,
                busy: _redeemBusy,
                btnLabel: '兑换',
                onSubmit: _submitRedeem,
              ),
              if (_redeemOut != null) ...[
                const SizedBox(height: 8),
                Text(_redeemOut!,
                    style: TextStyle(color: p.onCard, fontSize: QfScale.fs13, height: 1.5)),
              ],
              ..._pendingRedeemRows(p),
            ],
          ),
        ),
        ],
        const SizedBox(height: 12),
        // 16:37 定版样式：购买密钥黑底白字；其下查询密钥主文字色加下划线文字链
        // #49 分流：永久已激活隐藏购买按钮；按天已激活文案改「购买叠加」
        //（onPurchase 行为不变）；查询密钥入口不受分流影响、恒显示。
        if (entryMode != LicenseEntryMode.permanent)
        Focus(
          // A4 剩余-3 定夺（:focus-visible 等效实现）：焦点白框平时透明
          // 常驻 2px 间隙，聚焦才显色，布局不跳变。
          // 第 6 项（7 项定夺）：浅色焦点描边改 #111111（白描边对浅页底
          // 仅 1.07:1）；深色保留白描边。2px 描边＋2px 间隙不变。黑白化后
          // 焦点环与按钮白边框同为白色系，环在按钮外沿、边框在按钮内沿，
          // 两者不重叠（环 vs 页底：浅色 18.88:1／深色 17.00:1）。
          onFocusChange: (v) => setState(() => _purchaseFocused = v),
          child: Container(
            padding: const EdgeInsets.all(2),
            decoration: BoxDecoration(
              borderRadius:
                  BorderRadius.circular(QfScale.radiusMd + 2),
              border: Border.all(
                color: _purchaseFocused
                    ? (p.isDark
                        ? Colors.white
                        : const Color(0xFF000000))
                    : Colors.transparent,
                width: 2,
              ),
            ),
            child: SizedBox(
              width: double.infinity,
              child: QfButtonTapTarget(child: FilledButton(
                onPressed: widget.onPurchase,
                style: FilledButton.styleFrom(
                  // A4 剩余-3 定夺（黑白化修订）：黑底白字不变（浅色 #000000／
                  // 深色卡片色 #111113；6 项定夺②灰阶审计合并：深色 surface3
                  // #18181B 并入卡片色），两端统一加白色 2px 边框（黑白主色，
                  // 旧品牌蓝边框已退役；边框绘于按钮内沿，不挤占内容）。
                  // 白字对比度：浅色 21.00／深色 18.86。边界承载：浅色由黑底
                  // 对卡片 #FFFFFF 21.00 承载（白边框对卡片 1.0，不示界）；
                  // 深色按钮底与卡片同色（1.0），边界改由白边框对卡片 18.86
                  // 承载，视觉上仍为清晰黑 pill＋白环。
                  backgroundColor:
                      p.isDark ? p.cardColor : const Color(0xFF000000),
                  foregroundColor: Colors.white,
                  minimumSize: const Size(0, QfScale.buttonVisualHeight),
                  side: const BorderSide(
                      color: Colors.white, width: 2),
                  shape: RoundedRectangleBorder(
                      borderRadius:
                          BorderRadius.circular(QfScale.radiusMd)),
                ),
                child: Text(
                    entryMode == LicenseEntryMode.timed ? '购买叠加' : '购买密钥',
                    style: const TextStyle(
                        fontSize: QfScale.fs16, fontWeight: FontWeight.w600)),
              )),
            ),
          ),
        ),
        Center(
          child: QfButtonTapTarget(child: TextButton(
            onPressed: widget.onStatusQuery,
            style: TextButton.styleFrom(
              foregroundColor: p.link,
              minimumSize: const Size(0, QfScale.buttonVisualHeight),
            ),
            // S-040：下划线色与登录桥注入行取同一 token p.linkUnderline
            // （浅 #A1A1AA／深 #52525B）。旧口径并入 onCardDim 与登录桥
            // 正好相反（onCardDim 浅 #52525B／深 #A1A1AA），同一条
            // “查询密钥”文字链两处下划线色对调；S-040 以 linkUnderline
            // 为准统一，旧注释口径随之作废。
            child: Text('查询密钥',
                style: TextStyle(
                    fontSize: QfScale.fs15,
                    decoration: TextDecoration.underline,
                    decorationColor: p.linkUnderline,
                    decorationThickness: 1)),
          )),
        ),
      ],
    );
  }

  /// 待兑换列表行（决策 #24）：本人名下未激活密钥，凭 keyId 一键兑换，
  /// 完整串不出现在列表里（与网页正本同口径）。
  List<Widget> _pendingRedeemRows(QfPalette p) {
    final pend = _myKeys.where((k) => k.canRedeem && k.keyId.isNotEmpty).toList();
    if (pend.isEmpty) return const [];
    return [
      const SizedBox(height: 12),
      Text('待兑换密钥',
          style: TextStyle(
              color: p.onCard, fontSize: QfScale.fs14, fontWeight: FontWeight.w600)),
      const SizedBox(height: 6),
      ...pend.map((k) => Padding(
            padding: const EdgeInsets.only(top: 6),
            child: Row(
              children: [
                Expanded(
                  child: Text(
                      '${k.planName} · ${k.masked}${k.sourceLabel.isNotEmpty ? '（${k.sourceLabel}）' : ''}',
                      style: TextStyle(color: p.onCard, fontSize: QfScale.fs13)),
                ),
                const SizedBox(width: 8),
                QfButtonTapTarget(child: FilledButton(
                  onPressed:
                      _redeemingId == null ? () => _redeemById(k) : null,
                  style: FilledButton.styleFrom(
                    backgroundColor: p.brand,
                    minimumSize: const Size(0, QfScale.buttonVisualHeight),
                    padding: const EdgeInsets.symmetric(horizontal: 13),
                    shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(QfScale.radiusMd)),
                  ),
                  child: Text(
                      _redeemingId == k.keyId ? '处理中…' : '一键兑换',
                      style: const TextStyle(
                          fontSize: QfScale.fs13, fontWeight: FontWeight.w600)),
                )),
              ],
            ),
          )),
    ];
  }

  Widget _keyRow({
    required TextEditingController ctrl,
    required bool busy,
    required String btnLabel,
    required VoidCallback onSubmit,
  }) {
    return Row(
      children: [
        Expanded(
          child: QfTextFieldTapTarget(builder: (node) => TextField(
            focusNode: node,
            controller: ctrl,
            maxLength: 40,
            autocorrect: false,
            enableSuggestions: false,
            textCapitalization: TextCapitalization.characters,
            decoration: InputDecoration(
              hintText: kClaimInputLabel,
              counterText: '',
              border:
                  OutlineInputBorder(borderRadius: BorderRadius.circular(QfScale.radiusMd)),
              contentPadding:
                  const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
            ),
          )),
        ),
        const SizedBox(width: 10),
        QfButtonTapTarget(child: FilledButton(
          onPressed: busy ? null : onSubmit,
          style: FilledButton.styleFrom(
            backgroundColor: widget.palette.brand,
            minimumSize: const Size(0, QfScale.buttonVisualHeight),
            shape:
                RoundedRectangleBorder(borderRadius: BorderRadius.circular(QfScale.radiusMd)),
          ),
          child: Text(busy ? '处理中…' : btnLabel,
              style: const TextStyle(fontWeight: FontWeight.w600)),
        )),
      ],
    );
  }

  Widget _kv(String k, String v, {bool last = false}) {
    final p = widget.palette;
    return Padding(
      padding: EdgeInsets.only(bottom: last ? 0 : 9),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 76,
            child: Text(k, style: TextStyle(color: p.onCardDim, fontSize: QfScale.fs13)),
          ),
          Expanded(
            child: Text(v,
                style: QfType.tabular(
                    TextStyle(color: p.onCard, fontSize: QfScale.fs14, fontWeight: FontWeight.w600))),
          ),
        ],
      ),
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
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 15),
      child: child,
    );
  }
}
