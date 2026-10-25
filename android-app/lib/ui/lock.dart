import 'package:flutter/material.dart';

import '../services/lock_client.dart';
import 'frame.dart';
import 'theme.dart';

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
      final ok = await showDialog<bool>(
        context: context,
        builder: (ctx) => AlertDialog(
          backgroundColor: Colors.white,
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14), side: const BorderSide(color: QfPalette.hairline)),
          title: const Text('关闭隐私锁'),
          content: const Text('关闭隐私锁后，本次密码立即作废。'),
          actions: [
            TextButton(onPressed: () => Navigator.of(ctx).pop(false), child: const Text('取消')),
            FilledButton(onPressed: () => Navigator.of(ctx).pop(true), child: const Text('关闭')),
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
    final result = await showDialog<({String loginPassword, String newPassword})>(
      context: context,
      builder: (_) => const _ResetDialog(),
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
            title: '隐私锁',
            rightText: '仅作用于本机',
            onBack: () => Navigator.of(context).pop(),
          ),
          // 底部安全区：手势导航条不压列表末尾（顶栏已处理顶部刘海）
          Expanded(
            child: SafeArea(
              top: false,
              child: ListView(
          padding: const EdgeInsets.fromLTRB(18, 16, 18, 24),
          children: [
            _panelCard(
              child: Text(
                '隐私锁仅作用于本机：屏幕熄灭，须输入密码后使用；远程控制不受影响。',
                style: TextStyle(color: palette.onCard, fontSize: 13.5, height: 1.6),
              ),
            ),
            const SizedBox(height: 12),
            if (_loading)
              const Padding(
                padding: EdgeInsets.only(top: 48),
                child: Center(child: CircularProgressIndicator(color: QfPalette.accent)),
              )
            else if (_needLogin)
              _panelCard(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      '尚未登录，暂时无法管理隐私锁。请先在软件中完成登录。',
                      textAlign: TextAlign.center,
                      style: TextStyle(color: palette.onCard, fontSize: 14, height: 1.5),
                    ),
                    const SizedBox(height: 16),
                    FilledButton(
                      // A13（文案清单）：单次登录已打通，未登录态只提示并允许
                      // 重新检查，不再绕行好友页（onNeedLogin 保留兼容旧调用方）。
                      onPressed: _load,
                      style: FilledButton.styleFrom(backgroundColor: QfPalette.brand, shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14))),
                      child: const Text('重新检查'),
                    ),
                  ],
                ),
              )
            else if (_error != null)
              _panelCard(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      '暂时无法连接隐私锁服务，请检查网络后重试。',
                      textAlign: TextAlign.center,
                      style: TextStyle(color: palette.onCard, fontSize: 14, height: 1.5),
                    ),
                    const SizedBox(height: 16),
                    FilledButton(
                      onPressed: _load,
                      style: FilledButton.styleFrom(backgroundColor: QfPalette.brand, shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14))),
                      child: const Text('重试'),
                    ),
                  ],
                ),
              )
            else
              for (final d in _devices) _deviceCard(d),
            if (!_loading && !_needLogin && _error == null)
              Padding(
                padding: const EdgeInsets.only(top: 4),
                child: Text(
                  '锁定后手机仍可远程连接，仅电脑本地屏幕熄灭。',
                  textAlign: TextAlign.center,
                  style: TextStyle(color: palette.onCardDim, fontSize: 12),
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
    final labelStyle = TextStyle(color: palette.onCard, fontSize: 13.5, fontWeight: FontWeight.w600);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Divider(color: palette.cardBorder, height: 28),
        Text('设置本次密码（至少 4 位）', style: labelStyle),
        const SizedBox(height: 8),
        TextField(
          controller: _pw1,
          obscureText: true,
          decoration: const InputDecoration(
            border: OutlineInputBorder(borderRadius: BorderRadius.all(Radius.circular(12))),
            contentPadding: EdgeInsets.symmetric(horizontal: 14, vertical: 13),
          ),
        ),
        const SizedBox(height: 12),
        Text('请再次输入', style: labelStyle),
        const SizedBox(height: 8),
        TextField(
          controller: _pw2,
          obscureText: true,
          decoration: const InputDecoration(
            border: OutlineInputBorder(borderRadius: BorderRadius.all(Radius.circular(12))),
            contentPadding: EdgeInsets.symmetric(horizontal: 14, vertical: 13),
          ),
        ),
        const SizedBox(height: 12),
        Text(
          '密码只用这一次：本地解锁成功后自动作废，下次打开重新设置。仅设备所有者可开关；在本机输错满 5 次，电脑会自动重启，重启后仍保持锁定。',
          style: TextStyle(color: palette.onCardDim, fontSize: 12.5, height: 1.5),
        ),
        if (_enableError != null) ...[
          const SizedBox(height: 10),
          Text(_enableError!, style: const TextStyle(color: QfPalette.probeBad, fontSize: 12.5)),
        ],
        const SizedBox(height: 14),
        FilledButton(
          onPressed: _busy ? null : () => _submitEnable(d),
          style: FilledButton.styleFrom(
            backgroundColor: QfPalette.brand,
            minimumSize: const Size.fromHeight(50),
            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
          ),
          child: const Text('打开隐私锁', style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
        ),
        Align(
          alignment: Alignment.centerRight,
          child: TextButton(
            onPressed: _busy ? null : _cancelEnable,
            child: const Text('取消'),
          ),
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
        borderRadius: BorderRadius.circular(14),
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
        borderRadius: BorderRadius.circular(14),
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
                  borderRadius: BorderRadius.circular(10),
                ),
                child: const Icon(Icons.computer_outlined, size: 20, color: QfPalette.brand),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      d.name,
                      style: TextStyle(color: palette.onCard, fontSize: 15.5, fontWeight: FontWeight.w600),
                    ),
                    const SizedBox(height: 4),
                    Text(
                      _statusText(d),
                      style: TextStyle(color: palette.onCardDim, fontSize: 12.5),
                    ),
                  ],
                ),
              ),
              if (showSwitch) ...[
                Text(
                  d.locked ? '已锁定' : '未锁定',
                  style: TextStyle(color: palette.onCardDim, fontSize: 13),
                ),
                const SizedBox(width: 4),
                Switch(
                  value: d.locked,
                  activeThumbColor: QfPalette.brand,
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
                style: TextStyle(color: palette.onCardDim, fontSize: 12),
              ),
            ),
          if (showSwitch && _enableForId == d.id) _enableForm(d),
          if (showSwitch && d.locked)
            Align(
              alignment: Alignment.centerLeft,
              child: TextButton(
                onPressed: _busy ? null : () => _onReset(d),
                child: const Text('忘记密码？用登录密码重设'),
              ),
            ),
        ],
      ),
    );
  }
}

/// 重设对话框：登录密码验密＋新锁密码（两次一致＋预检）。
class _ResetDialog extends StatefulWidget {
  const _ResetDialog();

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
    return AlertDialog(
      backgroundColor: Colors.white,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14), side: const BorderSide(color: QfPalette.hairline)),
      title: const Text('用登录密码重设'),
      content: SingleChildScrollView(
        child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          TextField(
            controller: _login,
            obscureText: true,
            decoration: const InputDecoration(labelText: '登录密码'),
          ),
          TextField(
            controller: _first,
            obscureText: true,
            decoration: const InputDecoration(labelText: '新锁密码'),
          ),
          TextField(
            controller: _second,
            obscureText: true,
            decoration: const InputDecoration(labelText: '请再次输入'),
          ),
          if (_error != null) ...[
            const SizedBox(height: 10),
            Text(_error!, style: const TextStyle(color: Colors.red, fontSize: 12.5)),
          ],
        ],
        ),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text('取消')),
        FilledButton(onPressed: _submit, child: const Text('重设')),
      ],
    );
  }
}
