import 'package:flutter/material.dart';

import '../core/license.dart';
import 'license_gate.dart';
import 'theme.dart';

/// 「付费与激活」区（2.3.1 阶段 D，「我的」原生页内，与网页正本同源展示）：
/// 数据全走 /license/api/me（同源展示口径与网页首页一致）；取不到数据时
/// 显示诚实错误态＋重试，绝不填假状态。含：试用提示条（TrialBar）、许可
/// 概览卡（套餐/状态/密钥掩码/剩余时长/设备名额/网页版权益）、本机绑定框
/// （契约 §3 bind）、转赠领取框（契约 §7.5.3 已登录入口）、兑换KEY卡
/// （决策 #24 统一兑换入口：粘贴兑换＋待兑换列表一键兑换）、购买/查询
/// 入口（16:37 定版样式：购买黑底白字、查询蓝色无边框文字链，壳内打开）。
class LicenseSection extends StatefulWidget {
  final QfPalette palette;
  final Future<LicenseMe?> Function() fetchLicense;
  final Future<LicenseOpResult?> Function(String key) onBind;
  final Future<LicenseOpResult?> Function(String key) onClaim;
  final VoidCallback onPurchase;
  final VoidCallback onStatusQuery;

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
        if (trialText != null) ...[
          TrialBar(palette: p, text: trialText, onPurchase: widget.onPurchase),
          const SizedBox(height: 12),
        ],
        _card(
          child: _loading && me == null
              ? Text('正在读取许可信息…',
                  style: TextStyle(color: p.onCardDim, fontSize: 13.5))
              : _failed && me == null
                  ? Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text('许可信息读取失败，请检查网络后重试。',
                            style:
                                TextStyle(color: p.onCard, fontSize: 13.5)),
                        const SizedBox(height: 8),
                        OutlinedButton(
                          onPressed: _load,
                          child: const Text('重试'),
                        ),
                      ],
                    )
                  : Column(
                      children: [
                        _kv('当前套餐', me?.planName ?? '—'),
                        _kv('账户状态', me?.displayStatus ?? '—'),
                        _kv('密钥', me?.maskedKey ?? '—'),
                        _kv('剩余时长',
                            me != null ? licenseRemainText(me, nowMs) : '—'),
                        _kv('设备名额',
                            '电脑 ${me?.slotsPc ?? 0} / ${me?.slotsPcMax ?? 2} · 手机 ${me?.slotsMobile ?? 0} / ${me?.slotsMobileMax ?? 1}'),
                        _kv('网页版权益',
                            (me?.webEnabled ?? false)
                                ? '已开通'
                                : '未开通（真实付费购买后开通）',
                            last: true),
                      ],
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
                      color: p.onCard, fontSize: 15, fontWeight: FontWeight.w700)),
              const SizedBox(height: 4),
              Text('把密钥粘贴到这里，绑定到本机（两台电脑与一部手机）。',
                  style: TextStyle(color: p.onCardDim, fontSize: 12.5)),
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
                    style: TextStyle(color: p.onCard, fontSize: 13, height: 1.5)),
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
                      color: p.onCard, fontSize: 15, fontWeight: FontWeight.w700)),
              const SizedBox(height: 4),
              Text('如有人向您转赠密钥：先在登录页点「查询密钥」，凭账号和密码核验后复制完整密钥串，再粘贴到这里领取。领取成功后密钥即转入您的账号，原主人一侧同时失效。',
                  style: TextStyle(color: p.onCardDim, fontSize: 12.5, height: 1.5)),
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
                    style: TextStyle(color: p.onCard, fontSize: 13, height: 1.5)),
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
                      color: p.onCard, fontSize: 15, fontWeight: FontWeight.w700)),
              const SizedBox(height: 4),
              Text('在别处获得的密钥（购买转售、积分兑换等）粘贴到这里即可兑换激活；积分福利兑换的密钥会出现在下方待兑换列表中，点「一键兑换」即可激活。',
                  style: TextStyle(color: p.onCardDim, fontSize: 12.5, height: 1.5)),
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
                    style: TextStyle(color: p.onCard, fontSize: 13, height: 1.5)),
              ],
              ..._pendingRedeemRows(p),
            ],
          ),
        ),
        ],
        const SizedBox(height: 12),
        // 16:37 定版样式：购买密钥黑底白字；其下查询密钥蓝色无边框文字链
        // #49 分流：永久已激活隐藏购买按钮；按天已激活文案改「购买叠加」
        //（onPurchase 行为不变）；查询密钥入口不受分流影响、恒显示。
        if (entryMode != LicenseEntryMode.permanent)
        SizedBox(
          width: double.infinity,
          child: FilledButton(
            onPressed: widget.onPurchase,
            style: FilledButton.styleFrom(
              backgroundColor: const Color(0xFF111111),
              foregroundColor: Colors.white,
              minimumSize: const Size(0, 48),
              shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(11)),
            ),
            child: Text(
                entryMode == LicenseEntryMode.timed ? '购买叠加' : '购买密钥',
                style: const TextStyle(
                    fontSize: 15.5, fontWeight: FontWeight.w700)),
          ),
        ),
        Center(
          child: TextButton(
            onPressed: widget.onStatusQuery,
            style: TextButton.styleFrom(
              foregroundColor: QfPalette.brand,
              minimumSize: const Size(0, 44),
            ),
            child: const Text('查询密钥', style: TextStyle(fontSize: 14.5)),
          ),
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
              color: p.onCard, fontSize: 13.5, fontWeight: FontWeight.w700)),
      const SizedBox(height: 6),
      ...pend.map((k) => Padding(
            padding: const EdgeInsets.only(top: 6),
            child: Row(
              children: [
                Expanded(
                  child: Text(
                      '${k.planName} · ${k.masked}${k.sourceLabel.isNotEmpty ? '（${k.sourceLabel}）' : ''}',
                      style: TextStyle(color: p.onCard, fontSize: 13)),
                ),
                const SizedBox(width: 8),
                FilledButton(
                  onPressed:
                      _redeemingId == null ? () => _redeemById(k) : null,
                  style: FilledButton.styleFrom(
                    backgroundColor: QfPalette.brand,
                    minimumSize: const Size(0, 38),
                    padding: const EdgeInsets.symmetric(horizontal: 13),
                    shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(9)),
                  ),
                  child: Text(
                      _redeemingId == k.keyId ? '处理中…' : '一键兑换',
                      style: const TextStyle(
                          fontSize: 13, fontWeight: FontWeight.w700)),
                ),
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
          child: TextField(
            controller: ctrl,
            maxLength: 40,
            autocorrect: false,
            enableSuggestions: false,
            textCapitalization: TextCapitalization.characters,
            decoration: InputDecoration(
              hintText: kClaimInputLabel,
              counterText: '',
              border:
                  OutlineInputBorder(borderRadius: BorderRadius.circular(10)),
              contentPadding:
                  const EdgeInsets.symmetric(horizontal: 12, vertical: 11),
            ),
          ),
        ),
        const SizedBox(width: 10),
        FilledButton(
          onPressed: busy ? null : onSubmit,
          style: FilledButton.styleFrom(
            backgroundColor: QfPalette.brand,
            minimumSize: const Size(0, 46),
            shape:
                RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
          ),
          child: Text(busy ? '处理中…' : btnLabel,
              style: const TextStyle(fontWeight: FontWeight.w700)),
        ),
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
            child: Text(k, style: TextStyle(color: p.onCardDim, fontSize: 13)),
          ),
          Expanded(
            child: Text(v,
                style: TextStyle(
                    color: p.onCard, fontSize: 13.5, fontWeight: FontWeight.w600)),
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
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: p.cardBorder),
      ),
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 15),
      child: child,
    );
  }
}
