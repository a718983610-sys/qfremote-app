import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:flutter/foundation.dart';

import '../core/client_header.dart';
import '../core/constants.dart';
import '../core/manifest.dart';
import 'apk_verify.dart';
import 'probe.dart' show trustedHttpClient;

/// 软件内更新服务（与 Windows 版 update.js 同机制、同信任口径）：
/// 取服务器 release.json → 用其中 android 条目比版本 → 下载 APK（带进度）
/// → 自动核对大小与 SHA256 → 再核对包名与签名证书指纹（VM-02 装前验签）
/// → 全部对得上才允许打开安装，对不上立刻删文件。
class UpdateService {
  /// 等服务器开始回应（响应头）的最长的时间：过了就判失败删文件，
  /// 不许在「正在下载… 0%」无声挂死（追加十一）。
  final Duration responseTimeout;

  /// 下载中途无新数据的最长容忍（连接半死判死）。
  final Duration stallTimeout;

  /// 装前验签的注入点（测试替身用）；为空时用平台原生验签实现。
  final ApkIdentityVerifier? apkIdentityVerifier;

  /// 清单地址与可信源：生产恒取全局常量（constants.dart 的信任口径，
  ///含 QF_RELEASE_URL 测试覆盖口径）；仅单元测试可注入本地源，让更新
  /// 全链测试不靠命令行 define 也能真跑（H-8）。生产构造点（main.dart）
  /// 保持无参，不许注入。
  final String releaseUrl;
  final String trustedOrigin;

  UpdateService({
    this.responseTimeout = const Duration(seconds: 30),
    this.stallTimeout = const Duration(seconds: 30),
    this.apkIdentityVerifier,
    String? releaseUrl,
    String? trustedOrigin,
  })  : releaseUrl = releaseUrl ?? kReleaseUrl,
        trustedOrigin = trustedOrigin ?? kTrustedOrigin;

  /// 取清单（默认 8 秒超时）。失败抛异常，调用方安静处理。
  /// [timeout] 可缩短：启动门无落盘待更时只为核强更线短探，不拖住离线启动。
  Future<ReleaseManifest> fetchManifest({
    Duration timeout = const Duration(seconds: 8),
  }) async {
    final client = trustedHttpClient(connectionTimeout: timeout);
    try {
      final req = await client.getUrl(Uri.parse(releaseUrl));
      applyClientVersionHeader(req);
      req.headers.set(HttpHeaders.acceptHeader, 'application/json');
      final res = await req.close().timeout(timeout);
      if (res.statusCode != 200) {
        throw HttpException('获取更新清单失败：HTTP ${res.statusCode}');
      }
      final body = await utf8.decodeStream(res).timeout(timeout);
      return ReleaseManifest.parse(body, trustedOrigin: trustedOrigin);
    } finally {
      client.close(force: true);
    }
  }

  /// 下载 APK 到 destDir：进度回调 onProgress(已收字节, 总字节, 百分比)；
  /// 下完核对大小与 SHA256：对不上删文件并抛中文错误。
  /// 返回校验通过的本地文件。
  Future<File> downloadApk(
    ReleaseEntry entry,
    Directory destDir,
    void Function(int received, int? total, int? percent) onProgress,
  ) async {
    if (!isTrustedUrl(entry.url, trustedOrigin: trustedOrigin)) {
      throw const HttpException('下载地址不在信任范围内');
    }
    try {
      await destDir.create(recursive: true);
    } on FileSystemException catch (e) {
      // VM-03 补漏（DS 门二 P2-2）：目录创建失败的英文原文不上界面。
      debugPrint('QFUPDATE create dir error: $e');
      throw const FormatException('下载失败，请稍后重试。');
    }
    final dest = File('${destDir.path}/${entry.fileName}');
    final part = File('${dest.path}.part');
    final client = trustedHttpClient(connectionTimeout: const Duration(seconds: 15));
    try {
      final req = await client.getUrl(Uri.parse(entry.url));
      applyClientVersionHeader(req);
      final res = await req.close().timeout(responseTimeout);
      if (res.statusCode != 200) {
        throw HttpException('下载失败：HTTP ${res.statusCode}');
      }
      final total = entry.size;
      var received = 0;
      final sink = part.openWrite();
      try {
        // 无新数据超过 stallTimeout 视为连接已死：抛错删半截文件，
        // 不无限挂在「正在下载」
        await for (final chunk in res.timeout(stallTimeout)) {
          received += chunk.length;
          sink.add(chunk);
          onProgress(
            received,
            total,
            (received * 100 ~/ total).clamp(0, 100),
          );
        }
        await sink.flush();
      } finally {
        await sink.close();
      }
    } catch (e) {
      await _quietDelete(part);
      // VM-03：下载层异常（断流/超时/网络错误）的原文多为英文，调用方会
      // 把异常文本直接展示到界面；原文只进日志，用户面统一映射为中文。
      debugPrint('QFUPDATE download error: $e');
      if (e is HttpException && e.message.startsWith('下载失败：HTTP')) {
        // 本服务自抛的 HTTP 状态中文提示原样保留，只换异常类型以便展示。
        throw FormatException(e.message);
      }
      if (e is SocketException ||
          e is HttpException ||
          e is TimeoutException ||
          e is FileSystemException) {
        throw const FormatException('下载中断，网络不稳定，请重新下载。');
      }
      throw const FormatException('下载失败，请稍后重试。');
    } finally {
      client.close(force: true);
    }

    // 核对：大小（必核，清单 size 已在解析层强制必填）＋ SHA256（必核）
    // ——与 Windows 版同一道关。
    try {
      final len = await part.length();
      if (len != entry.size) {
        throw const FormatException('文件大小与清单不一致');
      }
      final digest = await sha256.bind(part.openRead()).first;
      if (digest.toString().toLowerCase() != entry.sha256.toLowerCase()) {
        throw const FormatException('SHA256 校验码不一致');
      }
      // 装前验签（VM-02）：大小与哈希只能证明文件与清单自洽，证明不了
      // 签名出自官方证书——清单与异签名包自洽时，旧版会判「核对通过」
      // 放行到系统安装器。此处在落盘之前核对包名与签名证书指纹，任一
      // 不符、或验签通道不可用，一律拒装（fail-closed），不许跳过。
      final ApkIdentity identity;
      try {
        identity = await (apkIdentityVerifier ??
                PlatformApkIdentityVerifier())
            .inspect(part);
      } catch (e) {
        debugPrint('QFUPDATE apk verify error: $e');
        throw const FormatException(
            '签名核验未通过（无法读取签名证书或验签通道不可用），已删除该文件，请重新下载。');
      }
      if (!isExpectedApkIdentity(
        packageName: identity.packageName,
        signerCertSha256s: identity.signerCertSha256s,
      )) {
        if (identity.packageName != kExpectedApkPackageName) {
          throw const FormatException(
              '身份核验未通过（包名与官方应用不一致），已删除该文件，请重新下载。');
        }
        throw const FormatException(
            '签名证书核验未通过（签名指纹与官方证书不一致），已删除该文件，请重新下载。');
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
