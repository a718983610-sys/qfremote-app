import 'package:flutter/material.dart';

import 'frame.dart';
import 'logout_confirm.dart';
import 'theme.dart';
import 'reduced_motion.dart';

/// 主题选择：跟随系统不是一个 QfThemeMode，用独立枚举表达三态。
enum ThemeChoice { followSystem, blue, dark }

/// 「设置」页（2.3.0 定版样图 m11）：只放有真实后端行为的行。
/// 样图中的「自动选择最快节点／断线自动重连开关／远程时自动横屏／意见反馈」
/// 在安卓端无对应功能或与既定红线冲突，未做假开关，已单独回报总线裁定。
class SettingsPage extends StatefulWidget {
  final QfPalette palette;
  final ThemeChoice themeChoice;
  final bool rememberDevice;
  final bool rememberPassword;

  /// 远程控制时屏幕常亮（2.4.5 B9，默认开；测试构造可不传）。
  final bool keepScreenOn;
  final void Function(bool value)? onToggleKeepScreenOn;

  final String currentVersion;
  final void Function(ThemeChoice choice) onThemeChoice;
  final void Function(bool value) onToggleRememberDevice;
  final void Function(bool value) onToggleRememberPassword;
  final VoidCallback onCheckUpdate;
  final VoidCallback onOpenTerms;

  /// 正式「退出登录」入口（追加十）：确认后走主框架手动退出收口。
  final VoidCallback onLogout;

  const SettingsPage({
    super.key,
    required this.palette,
    required this.themeChoice,
    required this.rememberDevice,
    required this.rememberPassword,
    this.keepScreenOn = true,
    this.onToggleKeepScreenOn,
    required this.currentVersion,
    required this.onThemeChoice,
    required this.onToggleRememberDevice,
    required this.onToggleRememberPassword,
    required this.onCheckUpdate,
    required this.onOpenTerms,
    required this.onLogout,
  });

  @override
  State<SettingsPage> createState() => _SettingsPageState();
}

class _SettingsPageState extends State<SettingsPage> {
  late ThemeChoice _theme = widget.themeChoice;
  late bool _rememberDevice = widget.rememberDevice;
  late bool _rememberPassword = widget.rememberPassword;
  late bool _keepScreenOn = widget.keepScreenOn;

  String get _themeLabel => switch (_theme) {
        ThemeChoice.followSystem => '跟随系统',
        ThemeChoice.blue => '浅色',
        ThemeChoice.dark => '深色',
      };

  Future<void> _pickTheme() async {
    final p = widget.palette;
    final choice = await showQfDialog<ThemeChoice>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: p.cardColor,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(QfScale.radiusLg)),
        title: Text('深色模式', style: TextStyle(color: p.onCard, fontSize: QfScale.fs16, fontWeight: FontWeight.w600)),
        content: SingleChildScrollView(
          child: RadioGroup<ThemeChoice>(
          groupValue: _theme,
          onChanged: (v) {
            if (v != null) Navigator.of(ctx).pop(v);
          },
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              for (final c in ThemeChoice.values)
                RadioListTile<ThemeChoice>(
                  value: c,
                  title: Text(
                    switch (c) {
                      ThemeChoice.followSystem => '跟随系统',
                      ThemeChoice.blue => '浅色',
                      ThemeChoice.dark => '深色',
                    },
                    style: TextStyle(color: p.onCard, fontSize: QfScale.fs15),
                  ),
                ),
            ],
          ),
          ),
        ),
      ),
    );
    if (choice == null) return;
    setState(() => _theme = choice);
    widget.onThemeChoice(choice);
  }

  @override
  Widget build(BuildContext context) {
    final p = widget.palette;
    return Scaffold(
      backgroundColor: p.pageColor,
      body: Column(
        children: [
          QfPageHeader(
            palette: p,
            title: '设置',
            rightText: '改完马上生效',
            onBack: () => Navigator.of(context).pop(),
          ),
          Expanded(
            child: ListView(
              padding: EdgeInsets.fromLTRB(16, QfScale.listTopGap,
                  16, 20 + MediaQuery.of(context).padding.bottom),
              children: [
                _section('通用'),
                _group([
                  _row(
                    title: '深色模式',
                    // A9 定夺：副文案按当前档动态化（跟随系统→“跟随系统深浅”、
                    // 浅色→“白底黑字”、深色→“黑底白字”）；旧写死“黑底白字”
                    // 在选“跟随系统”时仍显示，状态不符。
                    sub: switch (_theme) {
                      ThemeChoice.followSystem => '跟随系统深浅',
                      ThemeChoice.blue => '白底黑字',
                      ThemeChoice.dark => '黑底白字',
                    },
                    trailing: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text(_themeLabel, style: TextStyle(color: p.onCardDim, fontSize: QfScale.fs13)),
                        Icon(Icons.chevron_right, size: 18, color: p.onCardDim),
                      ],
                    ),
                    onTap: _pickTheme,
                  ),
                  _row(
                    title: '记住此设备',
                    sub: '30 天内不用再登录',
                    trailing: Switch(
                      value: _rememberDevice,
                      activeThumbColor: p.brand,
                      onChanged: (v) {
                        setState(() => _rememberDevice = v);
                        widget.onToggleRememberDevice(v);
                      },
                    ),
                  ),
                  _row(
                    title: '记住账号密码',
                    sub: '账号密码留在登录框，掉线自动登回',
                    trailing: Switch(
                      value: _rememberPassword,
                      activeThumbColor: p.brand,
                      onChanged: (v) {
                        setState(() => _rememberPassword = v);
                        widget.onToggleRememberPassword(v);
                      },
                    ),
                  ),
                  _row(
                    title: '远程控制时屏幕常亮',
                    sub: '开着远程画面时手机不自动熄屏',
                    trailing: Switch(
                      value: _keepScreenOn,
                      activeThumbColor: p.brand,
                      onChanged: (v) {
                        setState(() => _keepScreenOn = v);
                        widget.onToggleKeepScreenOn?.call(v);
                      },
                    ),
                    last: true,
                  ),
                ]),
                _section('软件更新'),
                _group([
                  _row(
                    title: '当前版本 ${displayVersion(widget.currentVersion)}',
                    sub: '运行中只提醒，退出重进时完成更新',
                    trailing: QfButtonTapTarget(child: OutlinedButton(
                      onPressed: widget.onCheckUpdate,
                      style: OutlinedButton.styleFrom(
                        foregroundColor: p.brand,
                        side: BorderSide(color: p.cardBorder),
                        padding: const EdgeInsets.symmetric(horizontal: 13),
                        minimumSize: const Size(0, QfScale.buttonVisualHeight),
                        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(QfScale.radiusMd)),
                      ),
                      child: const Text('检查更新', style: TextStyle(fontSize: QfScale.fs13, fontWeight: FontWeight.w600)),
                    )),
                    last: true,
                  ),
                ]),
                _section('关于'),
                _group([
                  _row(
                    title: '用户协议与隐私说明',
                    trailing: Icon(Icons.chevron_right, size: 18, color: p.onCardDim),
                    onTap: widget.onOpenTerms,
                    last: true,
                  ),
                ]),
                _section('账号'),
                _group([
                  _row(
                    title: '退出账号',
                    sub: '清除本机保存的登录信息',
                    titleColor: p.danger,
                    trailing: Icon(Icons.chevron_right, size: 18, color: p.onCardDim),
                    onTap: () => confirmAndLogout(context,
                        palette: p, onLogout: widget.onLogout),
                    last: true,
                  ),
                ]),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _section(String text) {
    // C §1.3：分区标题高 32。
    return SizedBox(
      height: 32,
      child: Align(
        alignment: Alignment.centerLeft,
        child: Padding(
          padding: const EdgeInsets.only(left: 2),
          child: Text(text, style: QfType.label11(widget.palette.textSecondary)),
        ),
      ),
    );
  }

  // A §2.6 去卡片化：设置分组不再做卡片容器，扁平列表＋行间分隔线。
  Widget _group(List<Widget> rows) {
    return Column(children: rows);
  }

  Widget _row({
    required String title,
    String? sub,
    required Widget trailing,
    VoidCallback? onTap,
    bool last = false,
    Color? titleColor,
  }) {
    final p = widget.palette;
    return InkWell(
      onTap: onTap,
      child: Container(
        constraints: const BoxConstraints(minHeight: 56),
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
        decoration: BoxDecoration(
          // 6 项定夺②：行间分隔线用实色卡片边框（60% 半透明边框叠在卡片上
          // 会渲染出第 7 个灰阶）；最后一行无分隔。
          border: last ? null : Border(bottom: BorderSide(color: p.cardBorder)),
        ),
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
            trailing,
          ],
        ),
      ),
    );
  }
}
