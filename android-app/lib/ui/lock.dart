import 'package:flutter/material.dart';

import '../services/lock_client.dart';
import 'frame.dart';
import 'theme.dart';
import 'reduced_motion.dart';

/// 隐私锁面板（线 B 壳侧 UI 与状态机；服务端经 LockClient 桥接入）。
///
/// 隐私锁仅作用于本机：屏幕熄灭，须输入密码后使用；远程控制不受影响。
/// 面板三态：加载中 / 需登录 / 服务不可达（可重试）。
/// 设备四态：未锁定 / 已锁定 / 未装组件 / 他人设备（无开关，写死）。
class LockPage extends StatefulWidget {
  final QfPalette palette;
  final VoidCallback onNeedLogin;
  final LockClient? client;

  const LockPage({
    super.key,
    required this.palette,
    required this.onNeedLogin,
    this.client,
  });

  @override
  State<LockPage> createState() => _LockPageState();
}

class _LockPageState extends State<LockPage> {
  late final LockClient _client = widget.client ?? LockClient();

  bool _loading = true;
  bool _needLogin = false;
  String? _error;
  List<LockDevice> _devices = const [];
  bool _busy = false;

  // 内嵌启用表单（样图 m07：点开开关后表单在卡内展开，不再弹窗）
  String? _enableForId;
  final _pw1 = TextEditingController();
  final _pw2 = TextEditingController();
  String? _enableError;

  @override
  void dispose() {
    _pw1.dispose();
    _pw2.dispose();
    super.dispose();
  }

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _needLogin = false;
      _error = null;
    });
    try {
      final devices = await _client.listDevices();
      if (!mounted) return;
      setState(() {
        _devices = devices;
        _loading = false;
      });
    } on LockException catch (e) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        if (e.needLogin) {
          _needLogin = true;
        } else {
          _error = e.message;
        }
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = '暂时无法连接隐私锁服务，请检查网络后重试。';
      });
    }
  }

  void _snack(String msg) {
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(msg), duration: const Duration(seconds: 4)),
    );
  }

  Future<void> _run(Future<void> Function() action) async {
    if (_busy) return;
    setState(() => _busy = true);
    try {
      await action();
      await _load();
    } on LockException catch (e) {
      if (!mounted) return;
      if (e.needLogin) {
        setState(() => _needLogin = true);
      } else {
        _snack(e.message);
      }
    } catch (_) {
      if (mounted) _snack('暂时无法连接隐私锁服务，请检查网络后重试。');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _onSwitch(LockDevice device, bool turnOn) async {
    if (turnOn) {
      // 样图 m07 口径：表单在设备卡内展开，不弹窗
      setState(() {
        _enableForId = device.id;
        _pw1.clear();
        _pw2.clear();
        _enableError = null;
      });
    } else {
      final lp = widget.palette;
      final ok = await showQfDialog<bool>(
        context: context,
        builder: (ctx) => AlertDialog(
          backgroundColor: lp.cardColor,
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(QfScale.radiusLg), side: BorderSide(color: lp.cardBorder)),
          title: Text('关闭隐私锁', style: TextStyle(color: lp.onCard)),
          content: Text('关闭隐私锁后，本次密码立即作废。', style: TextStyle(color: lp.onCard)),
          actions: [
            QfButtonTapTarget(child: TextButton(onPressed: () => Navigator.of(ctx).pop(false), child: Text('取消', style: TextStyle(color: lp.onCardDim)))),
            QfButtonTapTarget(child: FilledButton(onPressed: () => Navigator.of(ctx).pop(true), child: const Text('关闭'))),
          ],
        ),
      );
      if (ok != true || !mounted) return;
      await _run(() => _client.disable(device.id));
    }
  }

  void _cancelEnable() {
    setState(() {
      _enableForId = null;
      _enableError = null;
      _pw1.clear();
      _pw2.clear();
    });
  }

  Future<void> _submitEnable(LockDevice device) async {
    final err = validateLockPassword(_pw1.text);
    if (err != null) {
      setState(() => _enableError = err);
      return;
    }
    if (_pw1.text != _pw2.text) {
      setState(() => _enableError = '两次输入的密码不一致，请检查后重试。');
      return;
    }
    final password = _pw1.text;
    setState(() => _enableForId = null);
    await _run(() => _client.enable(device.id, password));
  }

  Future<void> _onReset(LockDevice device) async {
    final result = await showQfDialog<({String loginPassword, String newPassword})>(
      context: context,
      builder: (_) => _ResetDialog(palette: widget.palette),
    );
    if (result == null || !mounted) return;
    await _run(() async {
      await _client.reset(device.id, result.loginPassword, result.newPassword);
      if (mounted) _snack('已重设，电脑保持锁定。');
    });
  }

  String _statusText(LockDevice d) {
    if (!d.owner) return '他人的电脑';
    if (!d.component) return '未装本机锁组件';
    return d.locked ? '已锁定' : '未锁定';
  }

  @override
  Widget build(BuildContext context) {
    final palette = widget.palette;
    return Scaffold(
      backgroundColor: palette.pageColor,
      body: Column(
        children: [
          QfPageHeader(
            palette: palette,
            title: '隐私锁',
            rightText: '仅作用于本机',
            onBack: () => Navigator.of(context).pop(),
          ),
          // 底部安全区：手势导航条不压列表末尾（顶栏已处理顶部刘海）
          Expanded(
            child: SafeArea(
              top: false,
              child: ListView(
          padding: const EdgeInsets.fromLTRB(16, 16, 16, 24),
          children: [
            _panelCard(
              child: Text(
                '隐私锁仅作用于本机：屏幕熄灭，须输入密码后使用；远程控制不受影响。',
                style: TextStyle(color: palette.onCard, fontSize: QfScale.fs14, height: 1.6),
              ),
            ),
            const SizedBox(height: 12),
            if (_loading)
              // C §2.2：不用大转圈——骨架镜像最终布局（设备行 56＋头像 32
              // ＋文本条 60%/40%），静态灰条、不做 shimmer；配阶段文案。
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('正在读取设备…',
                        style: QfType.meta12(palette.textSecondary)),
                    const SizedBox(height: 12),
                    QfSkeletonRow(palette: palette),
                    QfSkeletonRow(palette: palette),
                    QfSkeletonRow(palette: palette),
                  ],
                ),
              )
            else if (_needLogin)
              _panelCard(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      '尚未登录，暂时无法管理隐私锁。请先在软件中完成登录。',
                      textAlign: TextAlign.center,
                      style: TextStyle(color: palette.onCard, fontSize: QfScale.fs14, height: 1.5),
                    ),
                    const SizedBox(height: 16),
                    QfButtonTapTarget(child: FilledButton(
                      // A13（文案清单）：单次登录已打通，未登录态只提示并允许
                      // 重新检查，不再绕行好友页（onNeedLogin 保留兼容旧调用方）。
                      onPressed: _load,
                      style: FilledButton.styleFrom(backgroundColor: palette.brand, shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(QfScale.radiusMd))),
                      child: const Text('重新检查'),
                    )),
                  ],
                ),
              )
            else if (_error != null)
              _panelCard(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    // C §2.5：错误行 6px 红点＋12/18 文案；错误码缺失时
                    // 显示 —（LockClient 未返回错误码，见缺数据清单，
                    // 不编 NET-xxxx）。已尝试：读取设备列表 1 次。
                    QfErrorLine(
                        palette: palette,
                        text:
                            '${_error!} 错误码：—。已尝试：读取设备列表。'),
                    const SizedBox(height: 16),
                    QfButtonTapTarget(child: FilledButton(
                      onPressed: _load,
                      style: FilledButton.styleFrom(backgroundColor: palette.brand, shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(QfScale.radiusMd))),
                      child: const Text('重试'),
                    )),
                  ],
                ),
              )
            else if (_devices.isEmpty)
              // C §2.1 空状态：给证据不给大插画——无设备时说明原因与
              // 下一步（在电脑上装本机锁组件），不写“暂无数据”单独成句。
              // F-A6 返工：空状态入场 D4/E-S y+8（B §3.3）；空态 widget
              // 只在列表变空时挂载，重复出现时不重播（instant 语义由
              // QfAnimatedEntry 只播首挂载保证）。
              QfAnimatedEntry(
                duration: QfMotion.d4,
                offsetY: QfMotion.rowEnterOffsetY,
                child: _panelCard(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text('暂无可管理的设备',
                        style: QfType.title16(palette.onCard)),
                    const SizedBox(height: 4),
                    Text(
                      '隐私锁按设备管理。在电脑上安装本机锁组件后，设备会出现在这里。',
                      style: QfType.body14(palette.textSecondary),
                    ),
                  ],
                ),
                ),
              )
            else
              // B §3.3：列表行进入 D3/E-S y+8＋opacity，stagger 22ms/项、
              // 最多 7 项；滚动中新行不播，reduced motion 时 80ms opacity。
              for (var i = 0; i < _devices.length; i++)
                QfAnimatedEntry(
                  index: i,
                  child: _deviceCard(_devices[i]),
                ),
            if (!_loading && !_needLogin && _error == null)
              Padding(
                padding: const EdgeInsets.only(top: 4),
                child: Text(
                  '锁定后手机仍可远程连接，仅电脑本地屏幕熄灭。',
                  textAlign: TextAlign.center,
                  style: TextStyle(color: palette.onCardDim, fontSize: QfScale.fs12),
                ),
              ),
          ],
              ),
            ),
          ),
        ],
      ),
    );
  }

  /// 卡内启用表单（样图 m07）：设本次密码两次＋说明＋整宽按钮。
  Widget _enableForm(LockDevice d) {
    final palette = widget.palette;
    final labelStyle = TextStyle(color: palette.onCard, fontSize: QfScale.fs14, fontWeight: FontWeight.w600);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Divider(color: palette.cardBorder, height: 28),
        Text('设置本次密码（至少 4 位）', style: labelStyle),
        const SizedBox(height: 8),
        QfTextFieldTapTarget(builder: (node) => TextField(
          focusNode: node,
          controller: _pw1,
          obscureText: true,
          decoration: const InputDecoration(
            border: OutlineInputBorder(borderRadius: BorderRadius.all(Radius.circular(QfScale.radiusMd))),
            contentPadding: EdgeInsets.symmetric(horizontal: 14, vertical: 8),
          ),
        )),
        const SizedBox(height: 12),
        Text('请再次输入', style: labelStyle),
        const SizedBox(height: 8),
        QfTextFieldTapTarget(builder: (node) => TextField(
          focusNode: node,
          controller: _pw2,
          obscureText: true,
          decoration: const InputDecoration(
            border: OutlineInputBorder(borderRadius: BorderRadius.all(Radius.circular(QfScale.radiusMd))),
            contentPadding: EdgeInsets.symmetric(horizontal: 14, vertical: 8),
          ),
        )),
        const SizedBox(height: 12),
        Text(
          '密码只用这一次：本地解锁成功后自动作废，下次打开重新设置。仅设备所有者可开关；在本机输错满 5 次，电脑会自动重启，重启后仍保持锁定。',
          style: TextStyle(color: palette.onCardDim, fontSize: QfScale.fs13, height: 1.5),
        ),
        if (_enableError != null) ...[
          const SizedBox(height: 10),
          QfErrorLine(palette: palette, text: _enableError!),
        ],
        const SizedBox(height: 14),
        QfButtonTapTarget(child: FilledButton(
          onPressed: _busy ? null : () => _submitEnable(d),
          style: FilledButton.styleFrom(
            backgroundColor: palette.brand,
            minimumSize: const Size.fromHeight(QfScale.buttonVisualHeight),
            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(QfScale.radiusMd)),
          ),
          child: const Text('打开隐私锁', style: TextStyle(fontSize: QfScale.fs16, fontWeight: FontWeight.w600)),
        )),
        Align(
          alignment: Alignment.centerRight,
          child: QfButtonTapTarget(child: TextButton(
            onPressed: _busy ? null : _cancelEnable,
            child: const Text('取消'),
          )),
        ),
      ],
    );
  }

  Widget _panelCard({required Widget child}) {
    final palette = widget.palette;
    return Container(
      padding: const EdgeInsets.fromLTRB(22, 24, 22, 22),
      decoration: BoxDecoration(
        color: palette.cardColor,
        borderRadius: BorderRadius.circular(QfScale.radiusMd),
        border: Border.all(color: palette.cardBorder),
      ),
      child: child,
    );
  }

  Widget _deviceCard(LockDevice d) {
    final palette = widget.palette;
    final showSwitch = d.owner && d.component;
    return Container(
      margin: const EdgeInsets.only(bottom: 12),
      padding: const EdgeInsets.fromLTRB(18, 16, 12, 16),
      decoration: BoxDecoration(
        color: palette.cardColor,
        borderRadius: BorderRadius.circular(QfScale.radiusMd),
        border: Border.all(color: palette.cardBorder),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Container(
                width: 36,
                height: 36,
                decoration: BoxDecoration(
                  color: palette.iconChipColor,
                  borderRadius: BorderRadius.circular(QfScale.radiusMd),
                ),
                child: Icon(Icons.computer_outlined, size: 20, color: palette.brand),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      d.name,
                      style: TextStyle(color: palette.onCard, fontSize: QfScale.fs16, fontWeight: FontWeight.w600),
                    ),
                    const SizedBox(height: 4),
                    Text(
                      _statusText(d),
                      style: TextStyle(color: palette.onCardDim, fontSize: QfScale.fs13),
                    ),
                  ],
                ),
              ),
              if (showSwitch) ...[
                Text(
                  d.locked ? '已锁定' : '未锁定',
                  style: TextStyle(color: palette.onCardDim, fontSize: QfScale.fs13),
                ),
                const SizedBox(width: 4),
                Switch(
                  value: d.locked,
                  activeThumbColor: palette.brand,
                  onChanged: _busy ? null : (v) => _onSwitch(d, v),
                ),
              ],
            ],
          ),
          if (!d.owner)
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Text(
                '仅设备所有者可管理这台电脑的隐私锁。',
                style: TextStyle(color: palette.onCardDim, fontSize: QfScale.fs12),
              ),
            ),
          if (showSwitch && _enableForId == d.id) _enableForm(d),
          if (showSwitch && d.locked)
            Align(
              alignment: Alignment.centerLeft,
              child: QfButtonTapTarget(child: TextButton(
                onPressed: _busy ? null : () => _onReset(d),
                child: const Text('忘记密码？用登录密码重设'),
              )),
            ),
        ],
      ),
    );
  }
}

/// 重设对话框：登录密码验密＋新锁密码（两次一致＋预检）。
class _ResetDialog extends StatefulWidget {
  final QfPalette palette;
  const _ResetDialog({required this.palette});

  @override
  State<_ResetDialog> createState() => _ResetDialogState();
}

class _ResetDialogState extends State<_ResetDialog> {
  final _login = TextEditingController();
  final _first = TextEditingController();
  final _second = TextEditingController();
  String? _error;

  @override
  void dispose() {
    _login.dispose();
    _first.dispose();
    _second.dispose();
    super.dispose();
  }

  void _submit() {
    if (_login.text.isEmpty) {
      setState(() => _error = '请填写登录密码。');
      return;
    }
    final err = validateLockPassword(_first.text);
    if (err != null) {
      setState(() => _error = err);
      return;
    }
    if (_first.text != _second.text) {
      setState(() => _error = '两次输入的密码不一致，请检查后重试。');
      return;
    }
    Navigator.of(context).pop((loginPassword: _login.text, newPassword: _first.text));
  }

  @override
  Widget build(BuildContext context) {
    final p = widget.palette;
    // 遗留①：输入字号由 fs14 改 fs16——14px 行高 21，纵向 padding 8 时
    // 视觉只有 37；16px 行高 24，视觉正好 40，与全 app 其余输入框一致。
    final fieldStyle = TextStyle(color: p.onCard, fontSize: QfScale.fs16);
    InputDecoration deco(String label) => InputDecoration(
          labelText: label,
          labelStyle: TextStyle(color: p.onCardDim),
        );
    return AlertDialog(
      backgroundColor: p.cardColor,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(QfScale.radiusLg), side: BorderSide(color: p.cardBorder)),
      title: Text('用登录密码重设', style: TextStyle(color: p.onCard)),
      content: SingleChildScrollView(
        child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          QfTextFieldTapTarget(builder: (node) => TextField(
            focusNode: node,
            controller: _login,
            obscureText: true,
            style: fieldStyle,
            decoration: deco('登录密码'),
          )),
          QfTextFieldTapTarget(builder: (node) => TextField(
            focusNode: node,
            controller: _first,
            obscureText: true,
            style: fieldStyle,
            decoration: deco('新锁密码'),
          )),
          QfTextFieldTapTarget(builder: (node) => TextField(
            focusNode: node,
            controller: _second,
            obscureText: true,
            style: fieldStyle,
            decoration: deco('请再次输入'),
          )),
          if (_error != null) ...[
            const SizedBox(height: 10),
            QfErrorLine(palette: p, text: _error!),
          ],
        ],
        ),
      ),
      actions: [
        QfButtonTapTarget(child: TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text('取消'))),
        QfButtonTapTarget(child: FilledButton(onPressed: _submit, child: const Text('重设'))),
      ],
    );
  }
}
