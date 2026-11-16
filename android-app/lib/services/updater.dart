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

  /// 客户端版本头取值（B24）：主页注入 PackageInfo 读到的包版本；
  /// 未注入时回落 kAppVersion。
  final String? clientVersion;

  /// 清单验签公钥（F-05）：仅单元测试可注入测试公钥（与 releaseUrl /
  /// trustedOrigin 的 H-8 测试注入口径同款）；生产构造点（main.dart）
  /// 保持无参，恒用内嵌的生产公钥，不许注入。
  final String? verifyPublicKeyB64;

  UpdateService({
    this.responseTimeout = const Duration(seconds: 30),
    this.stallTimeout = const Duration(seconds: 30),
    this.apkIdentityVerifier,
    String? releaseUrl,
    String? trustedOrigin,
    this.clientVersion,
    this.verifyPublicKeyB64,
  })  : releaseUrl = releaseUrl ?? kReleaseUrl,
        trustedOrigin = trustedOrigin ?? kTrustedOrigin;

  /// 取清单（默认 8 秒超时）。失败抛异常，调用方安静处理。
  /// [timeout] 可缩短：启动门无落盘待更时只为核强更线短探，不拖住离线启动。
  /// F-05：返回前必验签——ReleaseManifest.parse 在结构校验通过后验
  /// 清单 Ed25519 签名，验签不过（缺签名、签名无效）直接抛
  /// FormatException，fetchManifest 拿不到“带病清单”；返回的清单
  /// signatureVerified 恒为 true。2026-11-16 站长终局：r11③
  /// ≤2.4.4 无签名垫片已删，缺签名即拒绝，不再放行。
  Future<ReleaseManifest> fetchManifest({
    Duration timeout = const Duration(seconds: 8),
  }) async {
    final client = trustedHttpClient(connectionTimeout: timeout);
    try {
      final req = await client.getUrl(Uri.parse(releaseUrl));
      applyClientVersionHeader(req, version: clientVersion);
      req.headers.set(HttpHeaders.acceptHeader, 'application/json');
      final res = await req.close().timeout(timeout);
      if (res.statusCode != 200) {
        throw HttpException('获取更新清单失败：HTTP ${res.statusCode}');
      }
      // QF-09（3.0.0 低组，部分属实）：校验清单响应的 Content-Type。
      // 未校验时，中间页／错误页以 200 + text/html 回来也会进 JSON 解析
      // （解析失败本就会抛，但显式校验把“非清单响应”在解析前挡掉，
      // 并给出可诊断的报错）。允许 application/json、text/json 与
      // text/plain（部分静态托管以 text/plain 发 .json）；text/html 等
      // 一律拒绝。downloadApk 本身无法绕过：入口只认 ReleaseManifest
      // 解析出的条目（url 已验可信 origin、size 必填、sha256 必填），
      // 且下完还要核大小＋SHA256＋包名＋签名指纹四道关。
      final mime = res.headers.contentType?.mimeType.toLowerCase();
      if (mime != 'application/json' &&
          mime != 'text/json' &&
          mime != 'text/plain') {
        throw HttpException(
            '更新清单类型不正确（Content-Type：${res.headers.contentType}），请稍后重试。');
      }
      final body = await utf8.decodeStream(res).timeout(timeout);
      final manifest = ReleaseManifest.parse(
        body,
        trustedOrigin: trustedOrigin,
        verifyPublicKeyB64: verifyPublicKeyB64,
      );
      return manifest;
    } finally {
      client.close(force: true);
    }
  }

  /// 下载 APK 到 destDir：进度回调 onProgress(已收字节, 总字节, 百分比)；
  /// 下完核对大小与 SHA256：对不上删文件并抛中文错误。
  /// 返回校验通过的本地文件。
  /// 2.4.5 B17：断点续传——失败不删 .part（保留 24 小时内可续传，换
  /// 版本即失效由大小/哈希校验兜底），下次带 `Range: bytes=<已收>-`；
  /// 服务器不支持 Range（回 200）时回落全量重下并记日志。
  /// B17 返修：.part 文件名带 entry.sha256 前 8 位前缀
  /// （`<sha8>_<fileName>.part`），换版本即新名、旧 .part 自然失效；
  /// 下载前检查 .part 修改时间，超过 24 小时即删掉重下（不续传）；
  /// 旧固定名 `<fileName>.part` 残留按过期处理（删掉重下，不续传）。
  /// .part 文件名（B17 返修）：`<sha256前8位>_<fileName>.part`。
  static String partFileName(ReleaseEntry entry) =>
      '${entry.sha256.substring(0, 8)}_${entry.fileName}.part';

  /// .part 是否已过期（B17 返修）：修改时间超过 24 小时即过期，不续传。
  static bool isPartExpired(DateTime modified, {DateTime? now}) {
    final ref = now ?? DateTime.now();
    return ref.difference(modified) > const Duration(hours: 24);
  }

  /// 删 updates 目录里的旧版残留：非当前的 *.part 与 *.apk（见 downloadApk
  /// 调用处注释）。只删这两类后缀、只删本目录一层；目标文件与无关文件不动；
  /// 单个删失败不中断、不抛错（尽力清）。
  static Future<void> pruneStaleDownloadFiles(
    Directory destDir, {
    required String keepPartName,
    required String keepDestName,
  }) async {
    try {
      await for (final ent in destDir.list()) {
        if (ent is! File) continue;
        final name = ent.path.split(Platform.pathSeparator).last;
        if (name == keepPartName || name == keepDestName) continue;
        if (name.endsWith('.part') || name.endsWith('.apk')) {
          await _quietDeleteStatic(ent);
        }
      }
    } catch (_) {}
  }

  static Future<void> _quietDeleteStatic(File f) async {
    try {
      if (await f.exists()) await f.delete();
    } catch (_) {}
  }

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
    // B17 返修：.part 带 sha256 前缀命名（换版本即新名、旧 .part 自然
    // 失效）；旧固定名残留按过期处理，直接删掉重下，不续传。
    final legacyPart = File('${dest.path}.part');
    if (await legacyPart.exists()) {
      await _quietDelete(legacyPart);
      debugPrint('QFUPDATE legacy .part removed (renamed scheme)');
    }
    final part = File('${destDir.path}/${partFileName(entry)}');
    // 残留清理（DC-C 新发现）：旧版 .part 文件名带旧 sha8 前缀，换版本即
    // 不可续传，且此前只删当前条目的过期 .part，旧版残留永久堆积；APK
    // 文件名亦带版本号（QFRemote-vX.Y.Z.apk），旧版整包同样堆积（每份约
    // 144MB）。下载开始时只删本目录下非当前的 *.part 与 *.apk，目标文件
    // 本身与无关文件不动。
    await pruneStaleDownloadFiles(destDir,
        keepPartName: partFileName(entry), keepDestName: entry.fileName);
    // 残留 .part 比清单还大＝换版本/已损坏，从头下；超过 24 小时＝过期，
    // 删掉重下（不续传）。
    var resumed = 0;
    try {
      if (await part.exists()) {
        final stat = await part.stat();
        if (isPartExpired(stat.modified)) {
          debugPrint('QFUPDATE .part expired (>24h), restart full download');
          await _quietDelete(part);
        } else {
          final len = await part.length();
          if (len > entry.size) {
            await _quietDelete(part);
          } else {
            resumed = len;
          }
        }
      }
    } catch (_) {
      resumed = 0;
    }
    final client = trustedHttpClient(connectionTimeout: const Duration(seconds: 15));
    try {
      final req = await client.getUrl(Uri.parse(entry.url));
      applyClientVersionHeader(req, version: clientVersion);
      if (resumed > 0) {
        req.headers.set(HttpHeaders.rangeHeader, 'bytes=$resumed-');
      }
      final res = await req.close().timeout(responseTimeout);
      if (res.statusCode != 200 && res.statusCode != 206) {
        throw HttpException('下载失败：HTTP ${res.statusCode}');
      }
      if (resumed > 0 && res.statusCode == 200) {
        // 服务器不支持 Range：回落全量重下
        debugPrint('QFUPDATE server ignores Range, restart full download');
        resumed = 0;
        await _quietDelete(part);
      }
      // 进度 total 优先用 Content-Length（续传时加上已收偏移），与
      // 清单 size 不一致时记日志、最终仍以清单 size 做大小校验。
      final contentLen = res.contentLength;
      final total = contentLen > 0 ? contentLen + resumed : entry.size;
      if (contentLen > 0 && contentLen + resumed != entry.size) {
        debugPrint(
            'QFUPDATE total mismatch: contentLength=$contentLen resumed=$resumed entry.size=${entry.size}');
      }
      var received = resumed;
      final sink = part.openWrite(mode: resumed > 0 ? FileMode.append : FileMode.write);
      try {
        // 无新数据超过 stallTimeout 视为连接已死：抛错、保留 .part 供续传，
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
      // 2.4.5 B17：失败保留 .part（不断流重下），只删已校验失败的文件在
      // 下面的校验分支处理。VM-03：异常原文只进日志，用户面统一中文。
      debugPrint('QFUPDATE download error: $e (kept .part for resume)');
      if (e is HttpException && e.message.startsWith('下载失败：HTTP')) {
        // 本服务自抛的 HTTP 状态中文提示原样保留，只换异常类型以便展示。
        throw FormatException(e.message);
      }
      // DC-C 新发现（空间误诊）：磁盘写满时抛 FileSystemException，旧版
      // 统一报成“下载中断，网络不稳定”，用户反复重试也下不完。errno 28
      // （ENOSPC）即空间不足，单独明示（仍保留 .part 供清理空间后续传）。
      if (e is FileSystemException && _isNoSpaceLeft(e)) {
        throw const FormatException('设备剩余空间不足，下载中断，已保留已下载部分，清理空间后重新下载可续传。');
      }
      if (e is SocketException ||
          e is HttpException ||
          e is TimeoutException ||
          e is FileSystemException) {
        throw const FormatException('下载中断，网络不稳定，已保留已下载部分，重新下载可续传。');
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

  /// 磁盘写满判定：errno 28（ENOSPC）为准，报文含 'No space left on
  /// device' 作后备（不同平台 OS 错误串写法有别时仍能认出）。
  static bool _isNoSpaceLeft(FileSystemException e) =>
      e.osError?.errorCode == 28 ||
      e.message.contains('No space left on device');
}
