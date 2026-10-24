import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../build_info.dart';
import '../core/constants.dart';
import '../core/manifest.dart';
import '../services/probe.dart';
import 'theme.dart';

/// 关于面板需要的外部能力（由主页注入，面板本身不直接碰 WebView）。
class AboutDeps {
  final String currentVersion;
  final QfPalette palette;
  final Future<ProbeResult> Function() probeNow;
  final Future<ReleaseEntry?> Function() checkUpdate; // 有更高版本时返回条目（主页已同步徽标/待更新）
  final Future<File> Function(ReleaseEntry entry, void Function(int, int?, int?) onProgress) download;
  final Future<void> Function(File file) openInstaller;
  final Future<String> Function() diagnosticsText;

  const AboutDeps({
    required this.currentVersion,
    required this.palette,
    required this.probeNow,
    required this.checkUpdate,
    required this.download,
    required this.openInstaller,
    required this.diagnosticsText,
  });
}

Future<void> showQfAboutDialog(BuildContext context, AboutDeps deps) {
  return showDialog<void>(
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
  String? _probeText;
  bool _probing = false;
  ReleaseEntry? _entry;
  String? _updateText;
  bool _checking = false;
  bool _downloading = false;
  int _percent = 0;
  File? _file;
  String? _downloadError;

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
    });
    try {
      final f = await widget.deps.download(entry, (received, total, percent) {
        if (mounted && percent != null) setState(() => _percent = percent);
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

  @override
  Widget build(BuildContext context) {
    final d = widget.deps;
    return AlertDialog(
      title: Row(
        children: [
          ClipRRect(
            borderRadius: BorderRadius.circular(8),
            child: Image.asset('assets/icon.png', width: 34, height: 34, fit: BoxFit.cover),
          ),
          const SizedBox(width: 10),
          const Text('QFRemote'),
        ],
      ),
      content: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('版本 v${d.currentVersion}（构建日期 $kBuildDate）'),
            const SizedBox(height: 4),
            const Text('服务器 $kServerOrigin'),
            const Divider(height: 22),
            if (_probeText != null) Text(_probeText!, style: const TextStyle(fontSize: 13)),
            const SizedBox(height: 6),
            OutlinedButton.icon(
              onPressed: _probing ? null : _probe,
              icon: const Icon(Icons.network_ping, size: 18),
              label: Text(_probing ? '检查中…' : '检查服务器状态'),
            ),
            const Divider(height: 22),
            if (_updateText != null) Text(_updateText!, style: const TextStyle(fontSize: 13)),
            if (_entry != null && _entry!.notes.isNotEmpty) ...[
              const SizedBox(height: 6),
              Text(_entry!.notes, style: const TextStyle(fontSize: 13, height: 1.5)),
            ],
            if (_downloading || _file != null) ...[
              const SizedBox(height: 10),
              LinearProgressIndicator(value: _percent / 100),
              const SizedBox(height: 4),
              Text(_file != null ? '下载完成，完整性核对通过' : '正在下载… $_percent%', style: const TextStyle(fontSize: 12)),
            ],
            if (_downloadError != null) ...[
              const SizedBox(height: 6),
              Text(_downloadError!, style: const TextStyle(color: QfPalette.probeBad, fontSize: 12.5)),
            ],
            const SizedBox(height: 8),
            Wrap(
              spacing: 8,
              runSpacing: 4,
              children: [
                OutlinedButton.icon(
                  onPressed: _checking ? null : _check,
                  icon: const Icon(Icons.system_update_alt, size: 18),
                  label: Text(_checking ? '检查中…' : '检查更新'),
                ),
                if (_entry != null && _file == null)
                  FilledButton.icon(
                    onPressed: _downloading ? null : _download,
                    icon: const Icon(Icons.download, size: 18),
                    label: const Text('下载更新'),
                  ),
                if (_file != null)
                  FilledButton.icon(
                    onPressed: () => d.openInstaller(_file!),
                    icon: const Icon(Icons.install_mobile, size: 18),
                    label: const Text('打开安装包'),
                  ),
              ],
            ),
            const Divider(height: 22),
            OutlinedButton.icon(
              onPressed: _copyDiag,
              icon: const Icon(Icons.copy_all_outlined, size: 18),
              label: const Text('复制诊断信息'),
            ),
          ],
        ),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text('关闭')),
      ],
    );
  }
}
