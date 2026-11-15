import 'dart:convert';

import 'package:crypto/crypto.dart';
import 'package:flutter/foundation.dart';

/// release.json 的 Ed25519 清单签名（F-05，3.0.0 严格阻断项）。
///
/// 与 Windows 版 windows/update.js 的 verifyReleaseSignature() +
/// canonicalReleaseJson() 同一份规范（H26），与服务端
/// server/ext/make-release-json.js 的签名规范一致：
///   规范串 = 去掉 signature 字段后、key 字典序递归排序的紧凑 JSON；
///   signature = { alg:'ed25519', key_id, sig }，sig 为规范串的签名
///   （base64url）；key_id 标识签名密钥轮换代次（现行 release-1）。
///
/// Ed25519 实现路线（定夺）：纯 Dart 实现，不加新依赖、不走原生平台
/// 通道。理由：pubspec 只有 crypto（无 Ed25519），加 pointycastle /
/// cryptography 要拉新依赖并改锁文件；原生通道（参照 'qfremote/apk_verify'
/// MethodChannel）要在 Kotlin 侧接线，flutter test 里还得 mock 通道，
/// 等于验签真不真要靠真机。纯 Dart 用 BigInt 做扩展坐标点运算，
/// flutter test 不依赖设备就能真跑验签；RFC 8032 官方测试向量＋
/// Node crypto 生成的交叉向量双重锁定（见 test/release_signature_test.dart）。
/// 验签是每次取清单才跑一次的量级，纯 Dart 速度足够（单次数十毫秒级）。
///
/// 公钥内嵌（release-1，Ed25519 SPKI DER base64，公开不涉密）：
/// 与 windows/update.js、server/ext/make-release-json.js 同值；
/// 轮换时三处同改。私钥只在发版机离线保管，永不入库。

/// 发版签名公钥（release-1），与 Windows / 服务端同值。
const String kReleaseSignPublicKeyB64 =
    'MCowBQYDK2VwAyEAmGZlcEEV5U0J9ciAaA69WYkIfG/Og7arHBEuR+PTtnA=';

/// 现行签名密钥代次。服务端生成器恒填此值。
const String kReleaseSignKeyId = 'release-1';

/// 签名机制引入前的最后一个版本（r11③ 有界兼容垫片的上界，见 manifest.dart）。
const String kPreSigningMaxVersion = '2.4.4';

/// 验签结果。ok=false 时 reason 说明原因；code 仅缺签名时为
/// 'missing-signature'（与 Windows 版同款机器码，兼容垫片按码识别，
/// 不依赖 reason 文案）。
class ReleaseSignatureResult {
  final bool ok;
  final String? reason;
  final String? code;
  final String? keyId;

  const ReleaseSignatureResult({
    required this.ok,
    this.reason,
    this.code,
    this.keyId,
  });
}

/// 规范串：去掉 signature 字段后、key 字典序递归排序的紧凑 JSON。
/// 与 Node 的 JSON.stringify(sort(doc)) 逐字节一致（键按 UTF-16 码元
/// 排序；整数按十进制；字符串转义与 JSON.stringify 同款：只转义
/// `"`、`\` 与 <0x20 控制字符，中文等非 ASCII 原样输出）。
String canonicalReleaseJson(Map<String, dynamic> doc) {
  dynamic sort(dynamic v) {
    if (v is Map) {
      final keys = v.keys.map((k) => k.toString()).toList()..sort();
      final out = <String, dynamic>{};
      for (final k in keys) {
        out[k] = sort(v[k]);
      }
      return out;
    }
    if (v is List) return v.map(sort).toList();
    return v;
  }

  final sorted = sort(doc) as Map<String, dynamic>;
  // 去掉 signature 字段后再编码（sort 已复制，不动原 doc）。
  sorted.remove('signature');
  return _encodeJson(sorted);
}

String _encodeJson(dynamic v) {
  final buf = StringBuffer();
  _writeJson(buf, v);
  return buf.toString();
}

void _writeJson(StringBuffer buf, dynamic v) {
  if (v == null) {
    buf.write('null');
  } else if (v is bool) {
    buf.write(v ? 'true' : 'false');
  } else if (v is int) {
    buf.write(v.toString());
  } else if (v is double) {
    // 清单里没有浮点数；万一出现，整数值浮点按 JS 口径写成整数形式。
    if (v.isFinite && v == v.truncateToDouble()) {
      buf.write(v.toInt().toString());
    } else {
      buf.write(v.toString());
    }
  } else if (v is String) {
    buf.write(jsonEncode(v));
  } else if (v is Map) {
    buf.write('{');
    var first = true;
    for (final e in v.entries) {
      if (!first) buf.write(',');
      first = false;
      buf.write(jsonEncode(e.key.toString()));
      buf.write(':');
      _writeJson(buf, e.value);
    }
    buf.write('}');
  } else if (v is List) {
    buf.write('[');
    for (var i = 0; i < v.length; i++) {
      if (i > 0) buf.write(',');
      _writeJson(buf, v[i]);
    }
    buf.write(']');
  } else {
    throw FormatException('规范串不支持的值类型：${v.runtimeType}');
  }
}

/// 从 base64 SPKI DER 里取出 32 字节 Ed25519 原始公钥。
/// 结构固定为 44 字节：30 2a 30 05 06 03 2b 65 70 03 21 00 + 32 字节公钥。
List<int> parseSpkiEd25519PublicKey(String b64) {
  final der = base64.decode(b64);
  const prefix = <int>[
    0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00
  ];
  if (der.length != 44) {
    throw const FormatException('验签公钥长度不正确（须为 44 字节 SPKI DER）');
  }
  for (var i = 0; i < prefix.length; i++) {
    if (der[i] != prefix[i]) {
      throw const FormatException('验签公钥不是 Ed25519 SPKI 结构');
    }
  }
  return der.sublist(12);
}

List<int> _decodeBase64Url(String s) {
  var norm = s;
  while (norm.length % 4 != 0) {
    norm += '=';
  }
  return base64Url.decode(norm);
}

/// 验 release.json 签名（与 Windows 版 verifyReleaseSignature 同语义，
/// 另加一条更严的 key_id 校验，见下）。
/// [publicKeyB64] 仅测试注入用（测试密钥对）；生产恒用内嵌公钥。
ReleaseSignatureResult verifyReleaseSignature(
  Map<String, dynamic> doc, {
  String? publicKeyB64,
}) {
  final sig = doc['signature'];
  // r11③：缺签名单独给机器码 missing-signature——兼容垫片按码识别。
  if (sig == null || sig is! Map) {
    return const ReleaseSignatureResult(
      ok: false,
      reason: '缺少 signature 字段',
      code: 'missing-signature',
    );
  }
  if (sig['alg'] != 'ed25519') {
    return ReleaseSignatureResult(
      ok: false,
      reason: '未知签名算法：${sig['alg']}',
    );
  }
  // key_id 严格校验：Windows 版只回带 key_id、不校验；安卓侧要求必须
  // 是现行代次 release-1（缺失/错代次一律拒绝）。密钥轮换时新代次随
  // App 更新一起落地，旧 App 拒收新代次签名是预期的 fail-closed；
  // 服务端生成器恒填 release-1，不存在合法的无 key_id 签名。
  if (sig['key_id'] != kReleaseSignKeyId) {
    return ReleaseSignatureResult(
      ok: false,
      reason: '未知签名密钥代次：${sig['key_id']}',
    );
  }
  final sigRaw = sig['sig'];
  if (sigRaw is! String || !RegExp(r'^[A-Za-z0-9_-]+$').hasMatch(sigRaw)) {
    return const ReleaseSignatureResult(ok: false, reason: 'sig 不是 base64url');
  }
  late final List<int> sigBytes;
  try {
    sigBytes = _decodeBase64Url(sigRaw);
  } catch (_) {
    return const ReleaseSignatureResult(ok: false, reason: 'sig 不是 base64url');
  }
  if (sigBytes.length != 64) {
    return const ReleaseSignatureResult(ok: false, reason: 'sig 长度不正确');
  }
  late final List<int> pubKey;
  try {
    pubKey = parseSpkiEd25519PublicKey(publicKeyB64 ?? kReleaseSignPublicKeyB64);
  } catch (_) {
    return const ReleaseSignatureResult(ok: false, reason: '验签公钥无法加载');
  }
  late final String canonical;
  try {
    canonical = canonicalReleaseJson(doc);
  } catch (_) {
    return const ReleaseSignatureResult(ok: false, reason: '清单规范串生成失败');
  }
  final ok = ed25519Verify(
    publicKey: pubKey,
    message: utf8.encode(canonical),
    signature: sigBytes,
  );
  return ok
      ? ReleaseSignatureResult(ok: true, keyId: sig['key_id'] as String?)
      : const ReleaseSignatureResult(ok: false, reason: '签名与文档内容不符');
}

// ---------------------------------------------------------------------------
// 纯 Dart Ed25519（RFC 8032）验签。扩展坐标点运算，只在最后比较时用
// 交叉相乘（不做逐点求逆），单次验签两次标量乘法。
// ---------------------------------------------------------------------------

final BigInt _p = (BigInt.one << 255) - BigInt.from(19);
final BigInt _l = (BigInt.one << 252) +
    BigInt.parse('27742317777372353535851937790883648493');

BigInt _modInv(BigInt a) => a.modPow(_p - BigInt.two, _p);

final BigInt _d = (-BigInt.from(121665) * _modInv(BigInt.from(121666))) % _p;
final BigInt _i = BigInt.two.modPow((_p - BigInt.one) ~/ BigInt.from(4), _p);

/// 扩展坐标点 (X, Y, T, Z)，x = X/Z，y = Y/Z，xy = T/Z。
class _ExtPoint {
  final BigInt x, y, t, z;
  const _ExtPoint(this.x, this.y, this.t, this.z);
}

final _ExtPoint _identity = _ExtPoint(BigInt.zero, BigInt.one, BigInt.zero, BigInt.one);

_ExtPoint _add(_ExtPoint p1, _ExtPoint p2) {
  final a = ((p1.y - p1.x) * (p2.y - p2.x)) % _p;
  final b = ((p1.y + p1.x) * (p2.y + p2.x)) % _p;
  final c = (p1.t * BigInt.two * _d * p2.t) % _p;
  final d = (p1.z * BigInt.two * p2.z) % _p;
  final e = (b - a) % _p;
  final f = (d - c) % _p;
  final g = (d + c) % _p;
  final h = (b + a) % _p;
  return _ExtPoint((e * f) % _p, (g * h) % _p, (e * h) % _p, (f * g) % _p);
}

_ExtPoint _double(_ExtPoint p1) {
  final a = (p1.x * p1.x) % _p;
  final b = (p1.y * p1.y) % _p;
  final c = (BigInt.two * p1.z * p1.z) % _p;
  final d = (-a) % _p;
  final e = ((p1.x + p1.y) * (p1.x + p1.y) - a - b) % _p;
  final g = (d + b) % _p;
  final f = (g - c) % _p;
  final h = (d - b) % _p;
  return _ExtPoint((e * f) % _p, (g * h) % _p, (e * h) % _p, (f * g) % _p);
}

_ExtPoint _scalarMult(_ExtPoint pt, BigInt e) {
  var q = _identity;
  for (var i = e.bitLength - 1; i >= 0; i--) {
    q = _double(q);
    if (((e >> i) & BigInt.one) == BigInt.one) q = _add(q, pt);
  }
  return q;
}

bool _pointsEqual(_ExtPoint a, _ExtPoint b) =>
    ((a.x * b.z - b.x * a.z) % _p) == BigInt.zero &&
    ((a.y * b.z - b.y * a.z) % _p) == BigInt.zero;

/// 从 y 恢复 x（RFC 8032 §5.1.3）：返回偶数 x，失败回 null。
BigInt? _xRecover(BigInt y) {
  final v = (_d * y * y + BigInt.one) % _p;
  if (v == BigInt.zero) return null;
  final xx = ((y * y - BigInt.one) * _modInv(v)) % _p;
  var x = xx.modPow((_p + BigInt.from(3)) ~/ BigInt.from(8), _p);
  if (((x * x - xx) % _p) != BigInt.zero) x = (x * _i) % _p;
  if (((x * x - xx) % _p) != BigInt.zero) return null;
  if (x.isOdd) x = _p - x;
  return x;
}

final _ExtPoint _basePoint = (() {
  final by = (BigInt.from(4) * _modInv(BigInt.from(5))) % _p;
  final bx = _xRecover(by)!;
  return _ExtPoint(bx, by, (bx * by) % _p, BigInt.one);
})();

_ExtPoint? _decodePoint(List<int> bytes) {
  if (bytes.length != 32) return null;
  var y = BigInt.zero;
  for (var i = 0; i < 32; i++) {
    y |= BigInt.from(bytes[i]) << (8 * i);
  }
  final sign = (bytes[31] & 0x80) != 0;
  y &= (BigInt.one << 255) - BigInt.one;
  if (y >= _p) return null;
  var x = _xRecover(y);
  if (x == null) return null;
  if (x.isOdd != sign) x = _p - x;
  return _ExtPoint(x, y, (x * y) % _p, BigInt.one);
}

List<int> _encodePoint(_ExtPoint pt) {
  final zInv = _modInv(pt.z);
  final x = (pt.x * zInv) % _p;
  final y = (pt.y * zInv) % _p;
  final out = List<int>.filled(32, 0);
  var v = y;
  for (var i = 0; i < 32; i++) {
    out[i] = (v & BigInt.from(0xff)).toInt();
    v >>= 8;
  }
  if (x.isOdd) out[31] |= 0x80;
  return out;
}

BigInt _leBytesToInt(List<int> bytes) {
  var v = BigInt.zero;
  for (var i = bytes.length - 1; i >= 0; i--) {
    v = (v << 8) | BigInt.from(bytes[i]);
  }
  return v;
}

List<int> _intToLeBytes(BigInt v, int len) {
  final out = List<int>.filled(len, 0);
  var x = v;
  for (var i = 0; i < len; i++) {
    out[i] = (x & BigInt.from(0xff)).toInt();
    x >>= 8;
  }
  return out;
}

/// RFC 8032 Ed25519 验签：[S]B == R + [H(R‖A‖M)]A。
/// 任何格式问题（公钥/签名点解码失败、S ≥ L、长度不对）都返回 false，
/// 不抛异常——调用方按 fail-closed 处理。
bool ed25519Verify({
  required List<int> publicKey,
  required List<int> message,
  required List<int> signature,
}) {
  try {
    if (publicKey.length != 32 || signature.length != 64) return false;
    final a = _decodePoint(publicKey);
    if (a == null) return false;
    final rBytes = signature.sublist(0, 32);
    final r = _decodePoint(rBytes);
    if (r == null) return false;
    final s = _leBytesToInt(signature.sublist(32));
    if (s >= _l) return false;
    final hBytes = sha512.convert([...rBytes, ...publicKey, ...message]).bytes;
    final h = _leBytesToInt(hBytes) % _l;
    final left = _scalarMult(_basePoint, s);
    final right = _add(r, _scalarMult(a, h));
    return _pointsEqual(left, right);
  } catch (_) {
    return false;
  }
}

/// RFC 8032 Ed25519 签名（仅测试用：给测试夹具签发带签名的假清单，
/// 让 updater 全链测试不用真机也能跑通签名路径）。
/// 生产代码永不调用——签名私钥不在仓库、不在 App 里。
@visibleForTesting
List<int> ed25519Sign({
  required List<int> seed,
  required List<int> message,
}) {
  if (seed.length != 32) {
    throw ArgumentError('Ed25519 种子须为 32 字节');
  }
  final h = sha512.convert(seed).bytes;
  final aBytes = List<int>.from(h.sublist(0, 32));
  aBytes[0] &= 248;
  aBytes[31] &= 127;
  aBytes[31] |= 64;
  final a = _leBytesToInt(aBytes);
  final prefix = h.sublist(32);
  final aEnc = _encodePoint(_scalarMult(_basePoint, a));
  final r = _leBytesToInt(sha512.convert([...prefix, ...message]).bytes) % _l;
  final rEnc = _encodePoint(_scalarMult(_basePoint, r));
  final k =
      _leBytesToInt(sha512.convert([...rEnc, ...aEnc, ...message]).bytes) % _l;
  final s = (r + k * a) % _l;
  return [...rEnc, ..._intToLeBytes(s, 32)];
}
