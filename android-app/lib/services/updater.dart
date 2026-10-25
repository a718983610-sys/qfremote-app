import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';

import '../core/constants.dart';
import '../core/manifest.dart';
import 'probe.dart' show trustedHttpClient;

/// 软件内更新服务（与 Windows 版 update.js 同机制、同信任口径）：
/// 取服务器 release.json → 用其中 android 条目比版本 → 下载 APK（带进度）
/// → 自动核对大小与 SHA256 → 对得上才允许打开安装，对不上立刻删文件。
class UpdateService {
  /// 取清单（8 秒超时）。失败抛异常，调用方安静处理。
  Future<ReleaseManifest> fetchManifest() async {
    final client = trustedHttpClient(connectionTimeout: const Duration(seconds: 8));
    try {
      final req = await client.getUrl(Uri.parse(kReleaseUrl));
      req.headers.set(HttpHeaders.acceptHeader, 'application/json');
      final res = await req.close().timeout(const Duration(seconds: 8));
      if (res.statusCode != 200) {
        throw HttpException('获取更新清单失败：HTTP ${res.statusCode}');
      }
      final body = await utf8.decodeStream(res).timeout(const Duration(seconds: 8));
      return ReleaseManifest.parse(body);
    } finally {
      client.close(force: true);
    }
  }

  /// 下载 APK 到 destDir：进度回调 onProgress(已收字节, 总字节或 null, 百分比或 null)；
  /// 下完核对大小（清单给了才核）与 SHA256：对不上删文件并抛中文错误。
  /// 返回校验通过的本地文件。
  Future<File> downloadApk(
    ReleaseEntry entry,
    Directory destDir,
    void Function(int received, int? total, int? percent) onProgress,
  ) async {
    if (!isTrustedUrl(entry.url)) {
      throw const HttpException('下载地址不在信任范围内');
    }
    await destDir.create(recursive: true);
    final dest = File('${destDir.path}/${entry.fileName}');
    final part = File('${dest.path}.part');
    final client = trustedHttpClient(connectionTimeout: const Duration(seconds: 15));
    try {
      final req = await client.getUrl(Uri.parse(entry.url));
      final res = await req.close();
      if (res.statusCode != 200) {
        throw HttpException('下载失败：HTTP ${res.statusCode}');
      }
      final total = entry.size ?? (res.contentLength >= 0 ? res.contentLength : null);
      var received = 0;
      final sink = part.openWrite();
      try {
        // 30 秒无新数据视为连接已死：抛错删半截文件，不无限挂在「正在下载」
        await for (final chunk in res.timeout(const Duration(seconds: 30))) {
          received += chunk.length;
          sink.add(chunk);
          onProgress(
            received,
            total,
            total != null && total > 0 ? (received * 100 ~/ total).clamp(0, 100) : null,
          );
        }
        await sink.flush();
      } finally {
        await sink.close();
      }
    } catch (e) {
      await _quietDelete(part);
      rethrow;
    } finally {
      client.close(force: true);
    }

    // 核对：大小（清单给了才核）＋ SHA256（必核）——与 Windows 版同一道关。
    try {
      final len = await part.length();
      if (entry.size != null && len != entry.size) {
        throw const FormatException('文件大小与清单不一致');
      }
      final digest = await sha256.bind(part.openRead()).first;
      if (digest.toString().toLowerCase() != entry.sha256.toLowerCase()) {
        throw const FormatException('SHA256 校验码不一致');
      }
      await part.rename(dest.path);
      return dest;
    } catch (e) {
      await _quietDelete(part);
      await _quietDelete(dest);
      if (e is FormatException && e.message == '文件大小与清单不一致') {
        throw const FormatException('下载不完整（文件大小与清单不一致），已删除，请重新下载。');
      }
      if (e is FormatException && e.message == 'SHA256 校验码不一致') {
        throw const FormatException('完整性核对未通过（SHA256 校验码不一致），已删除该文件，请重新下载。');
      }
      rethrow;
    }
  }

  Future<void> _quietDelete(File f) async {
    try {
      if (await f.exists()) await f.delete();
    } catch (_) {}
  }
}
