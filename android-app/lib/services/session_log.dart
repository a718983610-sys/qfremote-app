import 'dart:io';

import 'package:path_provider/path_provider.dart';

/// 会话持久日志（2.4.5，A10）：环形文件日志，杀 App 重进后仍在。
///
/// 写 `getApplicationDocumentsDirectory()/qfremote/session.log`，
/// 上限 200KB，滚动覆盖。每条带时间戳与 nodeid/阶段/耗时。
/// 关于页「复制诊断信息」一并带出最近 20 条（见 main.dart
/// _diagnosticsText）。
class SessionLog {
  static const int maxBytes = 200 * 1024;
  static const String fileName = 'session.log';

  final Directory? dirOverride;

  SessionLog({this.dirOverride});

  File? _file;
  bool _initTried = false;

  Future<File?> _resolveFile() async {
    if (_file != null) return _file;
    if (_initTried) return _file;
    _initTried = true;
    try {
      final base = dirOverride ??
          await getApplicationDocumentsDirectory();
      final dir = Directory('${base.path}/qfremote');
      await dir.create(recursive: true);
      _file = File('${dir.path}/$fileName');
    } catch (_) {
      _file = null;
    }
    return _file;
  }

  /// 记一条阶段日志：`HH:MM:SS.mmm <event> node=<nodeid> <extra>`。
  /// 写失败安静跳过（日志本身不许影响会话流程）。
  Future<void> log(
    String event, {
    String nodeid = '',
    String extra = '',
  }) async {
    final f = await _resolveFile();
    if (f == null) return;
    try {
      final now = DateTime.now();
      String two(int n) => n.toString().padLeft(2, '0');
      String three(int n) => n.toString().padLeft(3, '0');
      final ts = '${two(now.hour)}:${two(now.minute)}:${two(now.second)}'
          '.${three(now.millisecond)}';
      final line = '$ts $event'
          '${nodeid.isNotEmpty ? ' node=$nodeid' : ''}'
          '${extra.isNotEmpty ? ' $extra' : ''}\n';
      if (await f.exists() && await f.length() > maxBytes) {
        await f.writeAsString(line, mode: FileMode.write);
      } else {
        await f.writeAsString(line, mode: FileMode.append);
      }
    } catch (_) {
      // 日志写失败不挡路
    }
  }

  /// 最近 n 条（诊断复制用）。
  Future<List<String>> recentLines(int n) async {
    final f = await _resolveFile();
    if (f == null) return const [];
    try {
      if (!await f.exists()) return const [];
      final lines = await f.readAsLines();
      if (lines.length <= n) return lines;
      return lines.sublist(lines.length - n);
    } catch (_) {
      return const [];
    }
  }
}

/// 诊断用的一行文本格式化（纯函数，供单测）：与 SessionLog.log 同格式。
String formatSessionLogLine(DateTime now, String event,
    {String nodeid = '', String extra = ''}) {
  String two(int n) => n.toString().padLeft(2, '0');
  String three(int n) => n.toString().padLeft(3, '0');
  final ts = '${two(now.hour)}:${two(now.minute)}:${two(now.second)}'
      '.${three(now.millisecond)}';
  return '$ts $event'
      '${nodeid.isNotEmpty ? ' node=$nodeid' : ''}'
      '${extra.isNotEmpty ? ' $extra' : ''}';
}
