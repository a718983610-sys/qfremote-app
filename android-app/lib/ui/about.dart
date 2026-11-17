import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../build_info.dart';
import '../core/constants.dart';
import '../core/manifest.dart';
import '../core/update_policy.dart';
import '../services/points.dart';
import '../services/probe.dart';
import 'qf_icons.dart';
import 'theme.dart';
import 'reduced_motion.dart';

/// 关于面板需要的外部能力（由主页注入，面板本身不直接碰 WebView）。
class AboutDeps {
  final String currentVersion;
  final QfPalette palette;
  final Future<ProbeResult> Function() probeNow;
  final Future<ReleaseEntry?> Function() checkUpdate; // 有更高版本时返回条目（主页已同步徽标/待更新）

  /// 四态检查（H-2）：区分失败/清单不完整/真最新/有新版，关于页据此
  /// 如实显示，不再把失败渲染成「已经是最新版」。未注入时回落旧
  /// checkUpdate 口径（仅未注入的测试替身场景）。
  final Future<AboutUpdateResult> Function()? checkUpdateDetail;
  final Future<File> Function(ReleaseEntry entry, void Function(int, int?, int?) onProgress) download;
  final Future<void> Function(File file) openInstaller;
  final Future<String> Function() diagnosticsText;

  /// 积分/使用时长取数（2.2.0）：取不到返回 null，两行显示「—」。
  final Future<PointsInfo?> Function()? fetchPoints;

  const AboutDeps({
    required this.currentVersion,
    required this.palette,
    required this.probeNow,
    required this.checkUpdate,
    this.checkUpdateDetail,
    required this.download,
    required this.openInstaller,
    required this.diagnosticsText,
    this.fetchPoints,
  });
}

Future<void> showQfAboutDialog(BuildContext context, AboutDeps deps) {
  return showQfDialog<void>(
    context: context,
    builder: (context) => _AboutDialog(deps: deps),
  );
}

class _AboutDialog extends StatefulWidget {
  final AboutDeps deps;
  const _AboutDialog({required this.deps});

  @override
  State<_AboutDialog> createState() => _AboutDialogState();
}

class _AboutDialogState extends State<_AboutDialog> {
  PointsInfo? _points;
  String? _probeText;
  bool _probing = false;
  ReleaseEntry? _entry;
  String? _updateText;
  bool _checking = false;
  bool _downloading = false;
  int _percent = 0;
  int _received = 0;
  int? _total;
  File? _file;
  String? _downloadError;

  @override
  void initState() {
    super.initState();
    _loadPoints();
  }

  Future<void> _loadPoints() async {
    final fetch = widget.deps.fetchPoints;
    if (fetch == null) return;
    final info = await fetch();
    if (!mounted) return;
    setState(() => _points = info);
  }

  Future<void> _probe() async {
    setState(() => _probing = true);
    final r = await widget.deps.probeNow();
    if (!mounted) return;
    setState(() {
      _probing = false;
      _probeText = r.describe();
    });
  }

  Future<void> _check() async {
    setState(() {
      _checking = true;
      _updateText = null;
    });
    final detail = widget.deps.checkUpdateDetail;
    if (detail != null) {
      // 四态口径（H-2）：失败/不完整如实显示，绝不冒充「已经是最新版」。
      final r = await detail();
      if (!mounted) return;
      setState(() {
        _checking = false;
        _entry = r.entry;
        _updateText = updateCheckText(r);
      });
      return;
    }
    final entry = await widget.deps.checkUpdate();
    if (!mounted) return;
    setState(() {
      _checking = false;
      _entry = entry;
      _updateText = entry == null ? '已经是最新版' : '发现新版 v${entry.version}';
    });
  }

  Future<void> _download() async {
    final entry = _entry;
    if (entry == null) return;
    setState(() {
      _downloading = true;
      _downloadError = null;
      _percent = 0;
      _received = 0;
      _total = null;
    });
    try {
      final f = await widget.deps.download(entry, (received, total, percent) {
        if (!mounted) return;
        setState(() {
          _received = received;
          _total = total;
          if (percent != null) _percent = percent;
        });
      });
      if (!mounted) return;
      setState(() {
        _downloading = false;
        _file = f;
        _percent = 100;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _downloading = false;
        _downloadError = e.toString().replaceFirst('FormatException: ', '').replaceFirst('HttpException: ', '');
      });
    }
  }

  Future<void> _copyDiag() async {
    final text = await widget.deps.diagnosticsText();
    await Clipboard.setData(ClipboardData(text: text));
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('诊断信息已复制')));
  }

  Widget _infoRow(QfPalette p, String label, String value) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 7),
      child: Row(
        children: [
          SizedBox(
            width: 76,
            child: Text(label, style: TextStyle(color: p.onCardDim, fontSize: QfScale.fs13)),
          ),
          Expanded(
            child: Text(value,
                style: TextStyle(color: p.onCard, fontSize: QfScale.fs14, fontWeight: FontWeight.w600)),
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final d = widget.deps;
    final p = d.palette;
    final primaryStyle = FilledButton.styleFrom(
      backgroundColor: p.brand,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(QfScale.radiusMd)),
    );
    final ghostStyle = OutlinedButton.styleFrom(
      foregroundColor: p.onCard,
      side: BorderSide(color: p.tileBorder),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(QfScale.radiusMd)),
    );
    return Dialog(
      backgroundColor: p.cardColor,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(QfScale.radiusLg)),
      insetPadding: const EdgeInsets.symmetric(horizontal: 24, vertical: 24),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(20, 18, 20, 14),
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                children: [
                  Container(
                    width: 44,
                    height: 44,
                    padding: const EdgeInsets.all(3),
                    decoration: BoxDecoration(
                      color: p.tileFill,
                      borderRadius: BorderRadius.circular(QfScale.radiusMd),
                      border: Border.all(color: p.tileBorder),
                    ),
                    child: ClipRRect(
                      borderRadius: BorderRadius.circular(QfScale.radiusMd),
                      child: Image.asset('assets/icon.png', fit: BoxFit.cover),
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text('QFRemote',
                            style: TextStyle(color: p.onCard, fontSize: QfScale.fs20, fontWeight: FontWeight.w600)),
                        const SizedBox(height: 2),
                        Text('关于', style: TextStyle(color: p.onCardDim, fontSize: QfScale.fs12)),
                      ],
                    ),
                  ),
                  IconButton(
                    onPressed: () => Navigator.of(context).pop(),
                    icon: Icon(Icons.close, size: 19, color: p.onCardDim),
                    style: IconButton.styleFrom(
                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(QfScale.radiusMd)),
                    ),
                    tooltip: '关闭',
                  ),
                ],
              ),
              const SizedBox(height: 10),
              _infoRow(p, '当前版本', 'v${displayVersion(d.currentVersion)}'),
              Divider(height: 1, color: p.tileBorder),
              _infoRow(p, '构建日期', kBuildDate),
              Divider(height: 1, color: p.tileBorder),
              _infoRow(p, '服务器', kServerOrigin),
              Divider(height: 1, color: p.tileBorder),
              _infoRow(p, '使用时长', _points?.displayText ?? '—'),
              Divider(height: 1, color: p.tileBorder),
              _infoRow(p, '我的积分', _points?.points == null ? '—' : '${_points!.points} 分'),
              const SizedBox(height: 14),
              if (_probeText != null) ...[
                Text(_probeText!, style: TextStyle(color: p.onCard, fontSize: QfScale.fs13)),
                const SizedBox(height: 8),
              ],
              QfButtonTapTarget(child: FilledButton.icon(
                onPressed: _probing ? null : _probe,
                style: primaryStyle,
                icon: const QfIcon(QfIconKind.probe, size: 18),
                label: Text(_probing ? '检查中…' : '检查服务器状态'),
              )),
              const SizedBox(height: 16),
              if (_updateText != null) ...[
                Text(_updateText!, style: TextStyle(color: p.onCard, fontSize: QfScale.fs13)),
                const SizedBox(height: 6),
              ],
              if (_entry != null && _entry!.notes.isNotEmpty)
                Container(
                  width: double.infinity,
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                  decoration: BoxDecoration(
                    color: p.iconChipColor,
                    borderRadius: BorderRadius.circular(QfScale.radiusMd),
                    border: Border.all(color: p.cardBorder),
                  ),
                  child: Text(_entry!.notes,
                      style: TextStyle(color: p.onCard, fontSize: QfScale.fs13, height: 1.5)),
                ),
              if (_downloading || _file != null) ...[
                const SizedBox(height: 12),
                ClipRRect(
                  borderRadius: BorderRadius.circular(4),
                  child: QfLoadingBar(
                    // 总大小未知时给不确定进度，不假装冻在 0%
                    // （reduced motion 下不定条改静止空轨，见 QfLoadingBar）。
                    value: _file != null
                        ? 1
                        : (_total != null && _total! > 0 ? _percent / 100 : null),
                    minHeight: 8,
                    // 6 项定夺②：轨道不用 20% 半透明次级字（会渲染出第 7 个
                    // 灰阶），改实色卡片边框（本页已计数）。
                    backgroundColor: p.cardBorder,
                    color: p.brand,
                  ),
                ),
                const SizedBox(height: 6),
                Text(
                    _file != null
                        ? '下载完成，完整性核对通过'
                        : (_total != null && _total! > 0
                            ? '正在下载… $_percent%'
                            : '正在下载… ${(_received / 1048576).toStringAsFixed(1)} MB'),
                    style: TextStyle(color: p.onCardDim, fontSize: QfScale.fs12)),
              ],
              if (_downloadError != null) ...[
                const SizedBox(height: 8),
                Text(_downloadError!, style: TextStyle(color: p.danger, fontSize: QfScale.fs13)),
              ],
              const SizedBox(height: 12),
              Row(
                children: [
                  Expanded(
                    child: QfButtonTapTarget(child: OutlinedButton.icon(
                      onPressed: _checking ? null : _check,
                      style: ghostStyle,
                      icon: const QfIcon(QfIconKind.download, size: 18),
                      label: Text(_checking ? '检查中…' : '检查更新'),
                    )),
                  ),
                  if (_entry != null && _file == null) ...[
                    const SizedBox(width: 10),
                    Expanded(
                      child: QfButtonTapTarget(child: FilledButton.icon(
                        onPressed: _downloading ? null : _download,
                        style: primaryStyle,
                        icon: const QfIcon(QfIconKind.download, size: 18),
                        label: const Text('下载更新'),
                      )),
                    ),
                  ],
                  if (_file != null) ...[
                    const SizedBox(width: 10),
                    Expanded(
                      child: QfButtonTapTarget(child: FilledButton.icon(
                        onPressed: () => d.openInstaller(_file!),
                        style: primaryStyle,
                        icon: const QfIcon(QfIconKind.installPhone, size: 18),
                        label: const Text('打开安装包'),
                      )),
                    ),
                  ],
                ],
              ),
              const SizedBox(height: 10),
              QfButtonTapTarget(child: OutlinedButton.icon(
                onPressed: _copyDiag,
                style: ghostStyle,
                icon: const Icon(Icons.copy_all_outlined, size: 18),
                label: const Text('复制诊断信息'),
              )),
              Align(
                alignment: Alignment.centerRight,
                child: QfButtonTapTarget(child: TextButton(
                  onPressed: () => Navigator.of(context).pop(),
                  style: TextButton.styleFrom(foregroundColor: p.onCardDim),
                  child: const Text('关闭'),
                )),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
