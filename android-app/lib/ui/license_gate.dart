import 'package:flutter/material.dart';

import '../core/license.dart';
import 'theme.dart';

/// 许可拦截面（2.3.1 阶段 D；设计稿 §四 + 契约 §7.5.5）：
/// 四要素齐全——当前账号、状态名称（标题）、产生原因（正文）、下一步操作
/// （主按钮）；G 类主按钮＝前往购买、B 类主按钮＝提交申诉，两类不共用文案；
/// G1/G2/G5 附转赠领取指引（L16）＋激活领取区（L17 输入框＋「领取密钥」）；
/// 申诉入口在全部封禁态可达；客服咨询入口常设。
class LicenseGatePage extends StatefulWidget {
  final QfPalette palette;
  final String username;
  final GateCopy copy;
  final Future<LicenseOpResult?> Function(String key)? onClaim;
  final VoidCallback onPurchase;
  final VoidCallback onAppeal;
  final VoidCallback onSupport;
  final VoidCallback onLogout;
  final VoidCallback onRecheck;

  const LicenseGatePage({
    super.key,
    required this.palette,
    required this.username,
    required this.copy,
    required this.onClaim,
    required this.onPurchase,
    required this.onAppeal,
    required this.onSupport,
    required this.onLogout,
    required this.onRecheck,
  });

  @override
  State<LicenseGatePage> createState() => _LicenseGatePageState();
}

class _LicenseGatePageState extends State<LicenseGatePage> {
  final _claimCtrl = TextEditingController();
  bool _claimBusy = false;
  String? _claimOut;

  @override
  void dispose() {
    _claimCtrl.dispose();
    super.dispose();
  }

  Future<void> _submitClaim() async {
    final onClaim = widget.onClaim;
    if (onClaim == null || _claimBusy) return;
    final input = _claimCtrl.text;
    // 格式分支本地先判（L17(d)）：格式不正确不打服务端、不计任何风控
    if (!isKeyFormatValid(input)) {
      setState(() => _claimOut = claimDisplayText(input: input, result: null));
      return;
    }
    setState(() {
      _claimBusy = true;
      _claimOut = null;
    });
    final result = await onClaim(input.trim());
    if (!mounted) return;
    setState(() {
      _claimBusy = false;
      _claimOut = claimDisplayText(input: input, result: result);
    });
    if (result != null && result.ok) {
      _claimCtrl.clear();
      // 领取成功：许可判定已放行，请主框架复查并消解拦截（§7.5.5）
      widget.onRecheck();
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = widget.palette;
    final copy = widget.copy;
    return Scaffold(
      backgroundColor: p.pageColor,
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(16, 28, 16, 24),
          children: [
            const Center(child: QfAvatarPlaceholder(size: 54)),
            const SizedBox(height: 14),
            Center(
              child: Text(copy.title,
                  style: TextStyle(
                      color: p.onCard, fontSize: 20, fontWeight: FontWeight.w800)),
            ),
            const SizedBox(height: 6),
            Center(
              child: Text('当前账号：${widget.username}',
                  style: TextStyle(color: p.onCardDim, fontSize: 13)),
            ),
            const SizedBox(height: 16),
            Container(
              decoration: BoxDecoration(
                color: p.cardColor,
                borderRadius: BorderRadius.circular(14),
                border: Border.all(color: p.cardBorder),
              ),
              padding: const EdgeInsets.fromLTRB(16, 15, 16, 15),
              child: Text(copy.body,
                  style: TextStyle(color: p.onCard, fontSize: 14.5, height: 1.65)),
            ),
            if (copy.hasTransferGuide) ...[
              const SizedBox(height: 12),
              Text(kTransferGuideText,
                  style: TextStyle(color: p.onCardDim, fontSize: 13, height: 1.6)),
            ],
            if (copy.hasClaimBox && widget.onClaim != null) ...[
              const SizedBox(height: 16),
              Container(
                decoration: BoxDecoration(
                  color: p.cardColor,
                  borderRadius: BorderRadius.circular(14),
                  border: Border.all(color: p.cardBorder),
                ),
                padding: const EdgeInsets.fromLTRB(16, 14, 16, 14),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(kClaimInputLabel,
                        style: TextStyle(
                            color: p.onCard, fontSize: 14, fontWeight: FontWeight.w700)),
                    const SizedBox(height: 10),
                    TextField(
                      controller: _claimCtrl,
                      maxLength: 40,
                      autocorrect: false,
                      enableSuggestions: false,
                      textCapitalization: TextCapitalization.characters,
                      decoration: InputDecoration(
                        hintText: '粘贴完整密钥串',
                        counterText: '',
                        border: OutlineInputBorder(
                            borderRadius: BorderRadius.circular(10)),
                        contentPadding: const EdgeInsets.symmetric(
                            horizontal: 12, vertical: 11),
                      ),
                    ),
                    const SizedBox(height: 10),
                    SizedBox(
                      width: double.infinity,
                      child: FilledButton(
                        onPressed: _claimBusy ? null : _submitClaim,
                        style: FilledButton.styleFrom(
                          backgroundColor: QfPalette.brand,
                          minimumSize: const Size(0, 46),
                          shape: RoundedRectangleBorder(
                              borderRadius: BorderRadius.circular(10)),
                        ),
                        child: Text(_claimBusy ? '正在领取…' : '领取密钥',
                            style: const TextStyle(
                                fontSize: 15, fontWeight: FontWeight.w700)),
                      ),
                    ),
                    if (_claimOut != null) ...[
                      const SizedBox(height: 10),
                      Text(_claimOut!,
                          style: TextStyle(
                              color: p.onCard, fontSize: 13.5, height: 1.55)),
                    ],
                  ],
                ),
              ),
            ],
            const SizedBox(height: 18),
            if (copy.primary == GatePrimary.purchase)
              FilledButton(
                onPressed: widget.onPurchase,
                style: FilledButton.styleFrom(
                  backgroundColor: QfPalette.brand,
                  minimumSize: const Size(0, 48),
                  shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(11)),
                ),
                child: const Text('前往购买',
                    style: TextStyle(fontSize: 15.5, fontWeight: FontWeight.w700)),
              ),
            if (copy.primary == GatePrimary.appeal)
              FilledButton(
                onPressed: widget.onAppeal,
                style: FilledButton.styleFrom(
                  backgroundColor: QfPalette.brand,
                  minimumSize: const Size(0, 48),
                  shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(11)),
                ),
                child: const Text('提交申诉',
                    style: TextStyle(fontSize: 15.5, fontWeight: FontWeight.w700)),
              ),
            const SizedBox(height: 6),
            TextButton(
              onPressed: widget.onRecheck,
              child: const Text('重新检查状态'),
            ),
            Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                TextButton(
                  onPressed: widget.onSupport,
                  child: const Text('咨询智能客服'),
                ),
                TextButton(
                  onPressed: widget.onLogout,
                  child: Text('退出账号',
                      style: TextStyle(color: QfPalette.probeBad)),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

/// 试用提示条（TrialBar，与网页正本同条件同文案；出现在「我的」页顶部）。
class TrialBar extends StatelessWidget {
  final QfPalette palette;
  final String text;
  final VoidCallback onPurchase;

  const TrialBar({
    super.key,
    required this.palette,
    required this.text,
    required this.onPurchase,
  });

  @override
  Widget build(BuildContext context) {
    final p = palette;
    return Container(
      decoration: BoxDecoration(
        color: p.cardColor,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: p.cardBorder),
      ),
      padding: const EdgeInsets.fromLTRB(16, 13, 16, 13),
      child: Row(
        children: [
          Icon(Icons.schedule, size: 20, color: QfPalette.brand),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(text,
                    style: TextStyle(
                        color: p.onCard, fontSize: 14.5, fontWeight: FontWeight.w700)),
                const SizedBox(height: 3),
                Text('试用结束后，电脑与手机需使用激活密钥继续使用；购买密钥后，网页版免费开通，可在任意设备登录使用。',
                    style: TextStyle(color: p.onCardDim, fontSize: 12.5, height: 1.45)),
              ],
            ),
          ),
          const SizedBox(width: 10),
          FilledButton(
            onPressed: onPurchase,
            style: FilledButton.styleFrom(
              backgroundColor: QfPalette.brand,
              minimumSize: const Size(0, 40),
              padding: const EdgeInsets.symmetric(horizontal: 14),
              shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(999)),
            ),
            child: const Text('购买密钥', style: TextStyle(fontWeight: FontWeight.w700)),
          ),
        ],
      ),
    );
  }
}
