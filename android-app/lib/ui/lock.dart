import 'package:flutter/material.dart';

import '../services/lock_client.dart';
import 'theme.dart';

/// 隐私锁面板（线 B 壳侧 UI 与状态机；服务端经 LockClient 桥接入）。
///
/// 锁只锁电脑跟前：屏幕变黑、要输密码才能用；远程控制不受影响。
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
        _error = '暂时连不上隐私锁服务，请检查网络后重试。';
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
      if (mounted) _snack('暂时连不上隐私锁服务，请检查网络后重试。');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _onSwitch(LockDevice device, bool turnOn) async {
    if (turnOn) {
      final password = await showDialog<String>(
        context: context,
        builder: (_) => const _EnableDialog(),
      );
      if (password == null || !mounted) return;
      await _run(() => _client.enable(device.id, password));
    } else {
      final ok = await showDialog<bool>(
        context: context,
        builder: (ctx) => AlertDialog(
          title: const Text('关闭隐私锁'),
          content: const Text('关掉隐私锁后，本次密码立即作废。'),
          actions: [
            TextButton(onPressed: () => Navigator.of(ctx).pop(false), child: const Text('取消')),
            FilledButton(onPressed: () => Navigator.of(ctx).pop(true), child: const Text('关掉')),
          ],
        ),
      );
      if (ok != true || !mounted) return;
      await _run(() => _client.disable(device.id));
    }
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
      appBar: AppBar(
        title: const Text('隐私锁'),
        backgroundColor: palette.isDark ? const Color(0xFF2B2F36) : const Color(0xFF1450B4),
        foregroundColor: Colors.white,
      ),
      body: Container(
        decoration: BoxDecoration(gradient: palette.pageGradient),
        child: ListView(
          padding: const EdgeInsets.fromLTRB(18, 20, 18, 24),
          children: [
            Text(
              '锁只锁电脑跟前：屏幕变黑、要输密码才能用；远程控制不受影响。',
              style: TextStyle(color: Colors.white.withValues(alpha: 0.85), fontSize: 13.5, height: 1.5),
            ),
            const SizedBox(height: 18),
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
                      '先到「好友」页登录一次，再回来管理隐私锁。',
                      textAlign: TextAlign.center,
                      style: TextStyle(color: palette.onCard, fontSize: 14, height: 1.5),
                    ),
                    const SizedBox(height: 16),
                    FilledButton(
                      onPressed: widget.onNeedLogin,
                      style: FilledButton.styleFrom(backgroundColor: const Color(0xFF1450B4)),
                      child: const Text('去登录'),
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
                      '暂时连不上隐私锁服务，请检查网络后重试。',
                      textAlign: TextAlign.center,
                      style: TextStyle(color: palette.onCard, fontSize: 14, height: 1.5),
                    ),
                    const SizedBox(height: 16),
                    FilledButton(
                      onPressed: _load,
                      style: FilledButton.styleFrom(backgroundColor: const Color(0xFF1450B4)),
                      child: const Text('重试'),
                    ),
                  ],
                ),
              )
            else
              for (final d in _devices) _deviceCard(d),
          ],
        ),
      ),
    );
  }

  Widget _panelCard({required Widget child}) {
    final palette = widget.palette;
    return Container(
      padding: const EdgeInsets.fromLTRB(22, 24, 22, 22),
      decoration: BoxDecoration(
        color: palette.cardColor,
        borderRadius: BorderRadius.circular(18),
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
        borderRadius: BorderRadius.circular(18),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
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
              if (showSwitch)
                Switch(
                  value: d.locked,
                  onChanged: _busy ? null : (v) => _onSwitch(d, v),
                ),
            ],
          ),
          if (!d.owner)
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Text(
                '只有机主能管理这台电脑的隐私锁。',
                style: TextStyle(color: palette.onCardDim, fontSize: 12),
              ),
            ),
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

/// 设密码对话框：两个密码框＋一次性说明＋预检（长度＋两次一致）。
class _EnableDialog extends StatefulWidget {
  const _EnableDialog();

  @override
  State<_EnableDialog> createState() => _EnableDialogState();
}

class _EnableDialogState extends State<_EnableDialog> {
  final _first = TextEditingController();
  final _second = TextEditingController();
  String? _error;

  @override
  void dispose() {
    _first.dispose();
    _second.dispose();
    super.dispose();
  }

  void _submit() {
    final err = validateLockPassword(_first.text);
    if (err != null) {
      setState(() => _error = err);
      return;
    }
    if (_first.text != _second.text) {
      setState(() => _error = '两次输入的密码不一致，请检查后重试。');
      return;
    }
    Navigator.of(context).pop(_first.text);
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('设置本次密码'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const Text('密码只用这一次：本地解锁成功后自动作废，下次打开重新设置。'),
          const SizedBox(height: 14),
          TextField(
            controller: _first,
            obscureText: true,
            decoration: const InputDecoration(labelText: '设置本次密码'),
          ),
          TextField(
            controller: _second,
            obscureText: true,
            decoration: const InputDecoration(labelText: '再输一遍'),
          ),
          if (_error != null) ...[
            const SizedBox(height: 10),
            Text(_error!, style: const TextStyle(color: Colors.red, fontSize: 12.5)),
          ],
        ],
      ),
      actions: [
        TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text('取消')),
        FilledButton(onPressed: _submit, child: const Text('打开隐私锁')),
      ],
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
      setState(() => _error = '请填写登录密码，请检查后重试。');
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
      title: const Text('用登录密码重设'),
      content: Column(
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
            decoration: const InputDecoration(labelText: '再输一遍'),
          ),
          if (_error != null) ...[
            const SizedBox(height: 10),
            Text(_error!, style: const TextStyle(color: Colors.red, fontSize: 12.5)),
          ],
        ],
      ),
      actions: [
        TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text('取消')),
        FilledButton(onPressed: _submit, child: const Text('重设')),
      ],
    );
  }
}
