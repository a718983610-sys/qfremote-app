import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

import '../core/constants.dart';
import 'qf_bridge.dart';

/// APK 身份信息：包名 + 全部当前签名者证书 SHA-256 指纹。
@immutable
class ApkIdentity {
  final String packageName;
  final List<String> signerCertSha256s;

  const ApkIdentity({
    required this.packageName,
    required this.signerCertSha256s,
  });
}

/// 测试注入点。
///
/// 生产默认使用 [PlatformApkIdentityVerifier]；
/// 全链测试中假 APK 并非合法 APK 结构，必须注入替身，避免被真验签误伤。
abstract class ApkIdentityVerifier {
  Future<ApkIdentity> inspect(File apk);
}

/// MethodChannel 封装（A-06：走单一桥接 `qfremote/bridge` 的 `apk.` 域）。
///
/// 平台通道不可用、返回格式异常、取不到包名/签名者时均抛异常，
/// 由上层 downloadApk 统一转为中文 fail-closed 文案。
class PlatformApkIdentityVerifier implements ApkIdentityVerifier {
  @override
  Future<ApkIdentity> inspect(File apk) async {
    final Object? raw;
    try {
      raw = await QfBridge.channel.invokeMethod<Object?>('apk.inspectApk', {
        'path': apk.path,
      });
    } on PlatformException catch (e) {
      debugPrint('APK 验签平台异常: code=${e.code}, message=${e.message}');
      throw const ApkVerificationException('APK 签名核验无法完成（验签通道异常）。');
    } on MissingPluginException catch (e) {
      debugPrint('APK 验签通道不可用: $e');
      throw const ApkVerificationException('APK 签名核验无法完成（验签通道未注册）。');
    } catch (e) {
      debugPrint('APK 验签未知异常: $e');
      throw const ApkVerificationException('APK 签名核验无法完成（验签通道未知异常）。');
    }

    if (raw is! Map) {
      debugPrint('APK 验签返回格式异常: ${raw.runtimeType}');
      throw const ApkVerificationException('APK 签名核验无法完成（验签返回格式异常）。');
    }

    final packageName = raw['packageName'];
    final signersRaw = raw['signerCertSha256s'];

    if (packageName is! String || packageName.isEmpty) {
      throw const ApkVerificationException('APK 签名核验无法完成（包名缺失）。');
    }

    if (signersRaw is! List || signersRaw.whereType<String>().isEmpty) {
      throw const ApkVerificationException('APK 签名核验无法完成（签名指纹缺失）。');
    }

    final signerCertSha256s = signersRaw.whereType<String>().toList();

    return ApkIdentity(
      packageName: packageName,
      signerCertSha256s: signerCertSha256s,
    );
  }
}

/// 验签通道/替身不可用时的异常。
///
/// 原文只进 debugPrint 日志，不直接展示给用户；
/// 用户面文案在 updater.dart 中统一转换为正式中文。
class ApkVerificationException implements Exception {
  final String message;
  const ApkVerificationException(this.message);

  @override
  String toString() => message;
}

/// 指纹格式归一化：统一转小写、移除分隔符。
///
/// 容错范围：大小写、`:` 分隔符。
/// 不放宽指纹内容：仍必须为 64 位 SHA-256 hex，否则比对失败。
String normalizeApkCertSha256(String fingerprint) {
  return fingerprint.replaceAll(RegExp(r'[^0-9a-fA-F]'), '').toLowerCase();
}

/// 包名 + 当前签名者指纹比对的纯函数。
///
/// 多签名者口径（QF-10，3.0.0 低组）：每位签名者归一化后都必须落在
/// 期望指纹白名单内（[expectedCertSha256s]，默认 [kExpectedApkCertSha256s]
/// 现行一枚）。未来官方新旧证书双签过渡期，白名单追加新指纹后，新旧
/// 任一单签包、新旧双签包都通过；攻击者附加自签证书时，附加的那位不
/// 在名单内，整包仍拒绝（U-3 口径不变）。
bool isExpectedApkIdentity({
  required String packageName,
  required List<String> signerCertSha256s,
  String expectedPackageName = kExpectedApkPackageName,
  List<String> expectedCertSha256s = kExpectedApkCertSha256s,
}) {
  if (packageName != expectedPackageName) {
    return false;
  }

  if (signerCertSha256s.isEmpty) {
    return false;
  }

  final allowed = expectedCertSha256s.map(normalizeApkCertSha256).toSet();
  if (allowed.isEmpty || allowed.any((f) => !_isSha256Hex(f))) {
    debugPrint('期望签名指纹白名单异常（为空或不是 64 位 SHA-256 hex）。');
    return false;
  }

  return signerCertSha256s.every(
    (fingerprint) => allowed.contains(normalizeApkCertSha256(fingerprint)),
  );
}

bool _isSha256Hex(String value) {
  return value.length == 64 && RegExp(r'^[0-9a-f]{64}$').hasMatch(value);
}
