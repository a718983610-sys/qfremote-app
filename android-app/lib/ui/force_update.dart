import 'dart:io';

import 'package:flutter/material.dart';

import '../core/manifest.dart';
import 'theme.dart';

/// 强制更新页（全家统一更新政策：退出重进时命中待更新 → 先更新才进软件）。
/// 没有关闭、没有跳过：只有「立即更新」→ 进度 → 验完出「打开安装包」；
/// 下载失败只给重试（这一页出现的前提是清单已取到、服务器可达）。
class ForceUpdateView extends StatefulWidget {
  final QfPalette palette;
  final String currentVersion;
  final ReleaseEntry entry;
  final Future<File> Function(ReleaseEntry entry, void Function(int, int?, int?) onProgress) download;
  final Future<void> Function(File file) openInstaller;

  const ForceUpdateView({
    super.key,
    required this.palette,
    required this.currentVersion,
    required this.entry,
    required this.download,
    required this.openInstaller,
  });

  @override
  State<ForceUpdateView> createState() => _ForceUpdateViewState();
}

class _ForceUpdateViewState extends State<ForceUpdateView> {
  int _percent = 0;
  bool _downloading = false;
  File? _file;
  String? _error;

  Future<void> _startDownload() async {
    setState(() {
      _downloading = true;
      _error = null;
      _percent = 0;
    });
    try {
      final f = await widget.download(widget.entry, (received, total, percent) {
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
        _error = e.toString().replaceFirst('FormatException: ', '').replaceFirst('HttpException: ', '');
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = widget.palette;
    return PopScope(
      canPop: false,
      child: Container(
        decoration: BoxDecoration(gradient: p.pageGradient),
        child: Center(
          child: Container(
            margin: const EdgeInsets.symmetric(horizontal: 28),
            padding: const EdgeInsets.fromLTRB(26, 30, 26, 26),
            decoration: BoxDecoration(
              color: p.cardColor,
              borderRadius: BorderRadius.circular(20),
              boxShadow: [BoxShadow(color: Colors.black.withValues(alpha: 0.3), blurRadius: 24, offset: const Offset(0, 10))],
            ),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Center(
                  child: ClipRRect(
                    borderRadius: BorderRadius.circular(14),
                    child: Image.asset('assets/icon.png', width: 56, height: 56, fit: BoxFit.cover),
                  ),
                ),
                const SizedBox(height: 16),
                Center(
                  child: Text('需要更新',
                      style: TextStyle(color: p.onCard, fontSize: 19, fontWeight: FontWeight.w700)),
                ),
                const SizedBox(height: 8),
                Center(
                  child: Text(
                    '从 v${widget.currentVersion} 更新到 v${widget.entry.version}',
                    style: TextStyle(color: p.onCardDim, fontSize: 13.5),
                  ),
                ),
                if (widget.entry.notes.isNotEmpty) ...[
                  const SizedBox(height: 14),
                  Text(widget.entry.notes,
                      style: TextStyle(color: p.onCard, fontSize: 13.5, height: 1.55)),
                ],
                const SizedBox(height: 20),
                if (_downloading || _file != null) ...[
                  ClipRRect(
                    borderRadius: BorderRadius.circular(4),
                    child: LinearProgressIndicator(
                      value: _percent / 100,
                      minHeight: 8,
                      backgroundColor: p.onCardDim.withValues(alpha: 0.2),
                      valueColor: const AlwaysStoppedAnimation<Color>(QfPalette.accent),
                    ),
                  ),
                  const SizedBox(height: 8),
                  Center(
                    child: Text(_file != null ? '下载完成，完整性核对通过' : '正在下载… $_percent%',
                        style: TextStyle(color: p.onCardDim, fontSize: 12.5)),
                  ),
                  const SizedBox(height: 14),
                ],
                if (_error != null) ...[
                  Text(_error!, style: const TextStyle(color: QfPalette.probeBad, fontSize: 13)),
                  const SizedBox(height: 12),
                ],
                if (_file != null)
                  FilledButton(
                    onPressed: () => widget.openInstaller(_file!),
                    style: FilledButton.styleFrom(backgroundColor: const Color(0xFF1450B4)),
                    child: const Text('打开安装包'),
                  )
                else
                  FilledButton(
                    onPressed: _downloading ? null : _startDownload,
                    style: FilledButton.styleFrom(backgroundColor: const Color(0xFF1450B4)),
                    child: Text(_downloading ? '下载中…' : (_error != null ? '重新下载更新' : '立即更新')),
                  ),
                const SizedBox(height: 6),
                Center(
                  child: Text('更新完成后重新打开软件即可使用',
                      style: TextStyle(color: p.onCardDim, fontSize: 11.5)),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
