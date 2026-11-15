import 'dart:convert';

import 'constants.dart';
import 'release_signature.dart';
import 'version.dart';

/// 更新清单（服务器 release.json）里一个平台的条目。
/// 格式与 Windows 版 update.js 的 fetchManifest 完全一致：
/// { version, notes, url, sha256, size }
class ReleaseEntry {
  final String version;
  final String notes;
  final String url; // 已解析为绝对地址且已通过可信校验
  final String sha256;
  final int size;

  /// 强更线（2026-11-07 站长令）：清单可选字段，本机版本低于它即启动强制
  /// 更新（见 update_policy.dart 的 decideUpdate）；缺失/不合规为 null。
  final String? minUsable;

  const ReleaseEntry({
    required this.version,
    required this.notes,
    required this.url,
    required this.sha256,
    required this.size,
    this.minUsable,
  });

  String get fileName {
    final seg = Uri.parse(url).pathSegments;
    if (seg.isEmpty) return 'QFRemote.apk';
    final name = seg.last.replaceAll(RegExp(r'[^\w.\- ]'), '_');
    // 深查加固：'.'/'..' 是目录名不是文件名，一律回落默认名
    if (name.isEmpty || name == '.' || name == '..') return 'QFRemote.apk';
    return name;
  }
}

/// 解析 release.json。
/// 顶层字段是 Windows 的条目；安卓条目在 "android" 子对象里（本 App 扩展）。
/// 校验规则与 Windows 版对齐：版本号必须是 x.y.z、必须有下载地址、
/// 下载地址只许指向可信 origin、SHA256 必须是完整 64 位十六进制。
/// 任一不合规抛 FormatException，调用方安静处理（不弹错误框）。
///
/// F-05（3.0.0 严格阻断项）：清单签名必验。解析在结构校验通过后验
/// signature={alg:'ed25519',key_id,sig}（规范与 Windows 版 H26 同款，
/// 见 release_signature.dart）；验签不过即抛 FormatException、整单
/// 拒绝（fail-closed），不许退回“只核 SHA256”。
/// 唯一例外是 r11③ 有界兼容垫片（与 Windows 版同款）：缺签名且顶层与
/// 安卓版本号都 ≤2.4.4（签名机制引入前的最后一个版本）时放行，并记
/// signatureVerified:false；版本号更新、或签名在场但验不过，一律拒绝。
/// 垫片日落条件：线上清单含有效签名（届时删垫片、缺签名即拒绝）。
/// [verifyPublicKeyB64] 仅测试注入用（测试密钥对）；生产恒用内嵌公钥。
class ReleaseManifest {
  final ReleaseEntry? windows;
  final ReleaseEntry? android;

  /// 清单签名是否验证通过。false 只可能来自 r11③ 垫片放行的旧版
  /// 无签名清单（≤2.4.4）；验签失败时 parse 直接抛错，不会返回 false
  /// 之外的任何“带病清单”。
  final bool signatureVerified;

  const ReleaseManifest({
    required this.windows,
    required this.android,
    required this.signatureVerified,
  });

  static ReleaseManifest parse(
    String body, {
    String? trustedOrigin,
    String? verifyPublicKeyB64,
  }) {
    final origin = trustedOrigin ?? kTrustedOrigin;
    dynamic root;
    try {
      root = jsonDecode(body);
    } catch (_) {
      throw const FormatException('更新清单格式不正确');
    }
    if (root is! Map<String, dynamic>) {
      throw const FormatException('更新清单格式不正确');
    }
    ReleaseEntry? parseEntry(dynamic raw) {
      if (raw == null) return null;
      if (raw is! Map<String, dynamic>) {
        throw const FormatException('更新清单格式不正确');
      }
      final version = raw['version'];
      if (version is! String || !RegExp(r'^\d+\.\d+\.\d+$').hasMatch(version)) {
        throw const FormatException('更新清单缺少版本号');
      }
      final urlRaw = raw['url'];
      if (urlRaw is! String || urlRaw.isEmpty) {
        throw const FormatException('更新清单缺少下载地址');
      }
      final abs = Uri.parse(kReleaseUrl).resolve(urlRaw).toString();
      if (Uri.parse(abs).origin != origin) {
        throw const FormatException('清单里的下载地址不在信任范围内');
      }
      final sha = (raw['sha256'] is String) ? (raw['sha256'] as String).toLowerCase() : '';
      if (!RegExp(r'^[0-9a-f]{64}$').hasMatch(sha)) {
        throw const FormatException('更新清单缺少完整的 SHA256 校验码');
      }
      // 大小必填（H-3）：发版口径 release.json 必带 size，缺失/非正整数
      // 视为清单不完整、整单判失败，不留「给了才核」的纵深缺口。
      final sizeRaw = raw['size'];
      if (sizeRaw is! int || sizeRaw <= 0) {
        throw const FormatException('更新清单缺少有效的文件大小');
      }
      final minUsableRaw = raw['minUsable'];
      return ReleaseEntry(
        version: version,
        notes: raw['notes'] is String ? raw['notes'] as String : '',
        url: abs,
        sha256: sha,
        size: sizeRaw,
        minUsable: (minUsableRaw is String &&
                RegExp(r'^\d+\.\d+\.\d+$').hasMatch(minUsableRaw))
            ? minUsableRaw
            : null,
      );
    }

    final windowsEntry = parseEntry(root);
    final androidEntry = parseEntry(root['android']);

    // F-05：结构校验通过后验清单签名（验签不过即整单拒绝）。
    final vr = verifyReleaseSignature(
      root,
      publicKeyB64: verifyPublicKeyB64,
    );
    var signatureVerified = false;
    if (vr.ok) {
      signatureVerified = true;
    } else if (vr.code == 'missing-signature' &&
        windowsEntry != null &&
        compareVersions(windowsEntry.version, kPreSigningMaxVersion) <= 0 &&
        (androidEntry == null ||
            compareVersions(androidEntry.version, kPreSigningMaxVersion) <=
                0)) {
      // r11③ 有界兼容垫片：线上现行 release.json 是签名机制引入前
      // 发布的 2.4.4，本来就没有 signature 字段——它不是被篡改。
      // 仅当缺签名且两端版本号都 ≤2.4.4 时放行，记 signatureVerified:false；
      // 放行的唯一后果是“不提供比 2.4.4 更新的版本”，下载仍须
      // SHA256＋size＋可信 origin＋APK 包名/证书指纹四重核对。
      signatureVerified = false;
    } else {
      throw FormatException('更新清单签名无效（${vr.reason}），拒绝更新');
    }

    return ReleaseManifest(
      windows: windowsEntry,
      android: androidEntry,
      signatureVerified: signatureVerified,
    );
  }
}

/// 一个地址是否在可信 origin 内（下载/清单的统一信任判定）。
bool isTrustedUrl(String raw, {String? trustedOrigin}) {
  try {
    return Uri.parse(raw).origin == (trustedOrigin ?? kTrustedOrigin);
  } catch (_) {
    return false;
  }
}
