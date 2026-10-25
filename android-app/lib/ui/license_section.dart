import 'package:flutter/material.dart';

import '../core/license.dart';
import 'license_gate.dart';
import 'theme.dart';

/// 「付费与激活」区（2.3.1 阶段 D，「我的」原生页内，与网页正本同源展示）：
/// 数据全走 /license/api/me（同源展示口径与网页首页一致）；取不到数据时
/// 显示诚实错误态＋重试，绝不填假状态。含：试用提示条（TrialBar）、许可
/// 概览卡（套餐/状态/密钥掩码/剩余时长/设备名额/网页版权益）、本机绑定框
/// （契约 §3 bind）、转赠领取框（契约 §7.5.3 已登录入口）、购买/查询入口
/// （16:37 定版样式：购买黑底白字、查询蓝色无边框文字链，壳内打开）。
class LicenseSection extends StatefulWidget {
  final QfPalette palette;
  final Future<LicenseMe?> Function() fetchLicense;
  final Future<LicenseOpResult?> Function(String key) onBind;
  final Future<LicenseOpResult?> Function(String key) onClaim;
  final VoidCallback onPurchase;
  final VoidCallback onStatusQuery;

  const LicenseSection({
    super.key,
    required this.palette,
    required this.fetchLicense,
    required this.onBind,
    required this.onClaim,
    required this.onPurchase,
    required this.onStatusQuery,
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
  bool _bindBusy = false;
  bool _claimBusy = false;
  String? _bindOut;
  String? _claimOut;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _bindCtrl.dispose();
    _claimCtrl.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _failed = false;
    });
    final me = await widget.fetchLicense();
    if (!mounted) return;
    setState(() {
      _loading = false;
      _failed = me == null;
      if (me != null) _me = me;
    });
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
                            '电脑 ${me?.slotsPc ?? 0} / 1 · 手机 ${me?.slotsMobile ?? 0} / 1'),
                        _kv('网页版权益',
                            (me?.webEnabled ?? false)
                                ? '已开通'
                                : '未开通（真实付费购买后开通）',
                            last: true),
                      ],
                    ),
        ),
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
        const SizedBox(height: 12),
        // 16:37 定版样式：购买密钥黑底白字；其下查询密钥蓝色无边框文字链
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
            child: const Text('购买密钥',
                style: TextStyle(fontSize: 15.5, fontWeight: FontWeight.w700)),
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
