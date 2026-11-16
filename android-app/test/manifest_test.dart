import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:qfremote/core/manifest.dart';
import 'package:qfremote/core/release_signature.dart';

const _sha = 'ffce5da483d2bd7ab99f32f7d69903c16e5d899275eed07e845a7833a5fbf351';
const _origin = 'https://app.qfremote.top';

/// F-05 夹具签名（TEST ONLY 测试密钥对，与
/// test/release_signature_test.dart 同一对，永不用于生产）：
/// 2026-11-16 r11③ 垫片已删后，ReleaseManifest.parse 要求清单带有效
/// 签名才返回；本文件测的是“结构解析”（版本/minUsable/相对 url），
/// 不是签名本身，故 4 个成功路径用例的夹具改走测试密钥签名，
/// 原断言一字未动；拒绝路径用例仍用无签名体（结构错先于签名门触发）。
const String _testSeedHex =
    '0123456789abcdeffedcba98765432100123456789abcdeffedcba9876543210';
const String _testPubSpkiB64 =
    'MCowBQYDK2VwAyEAxQyzrpVpR6jeGRNbW+JoX/NIr8Y/w0qDesoSvFwfViU=';

List<int> _hex(String s) {
  final out = <int>[];
  for (var i = 0; i < s.length; i += 2) {
    out.add(int.parse(s.substring(i, i + 2), radix: 16));
  }
  return out;
}

/// 给无签名清单体补上测试密钥签名（签规范串，与服务端流程同款）。
String _signedBody(String body) {
  final doc = jsonDecode(body) as Map<String, dynamic>;
  final sig = ed25519Sign(
    seed: _hex(_testSeedHex),
    message: utf8.encode(canonicalReleaseJson(doc)),
  );
  doc['signature'] = <String, dynamic>{
    'alg': 'ed25519',
    'key_id': 'release-1',
    'sig': base64Url.encode(sig).replaceAll('=', ''),
  };
  return jsonEncode(doc);
}

ReleaseManifest _parseSigned(String body) => ReleaseManifest.parse(
      _signedBody(body),
      trustedOrigin: _origin,
      verifyPublicKeyB64: _testPubSpkiB64,
    );

void main() {
  group('ReleaseManifest.parse', () {
    test('解析顶层（Windows）+ android 段', () {
      const body = '''
{
  "version": "1.0.3",
  "notes": "win notes",
  "url": "$_origin/QFRemote-Setup-v1.0.3.exe",
  "sha256": "$_sha",
  "size": 85471395,
  "android": {
    "version": "1.0.4",
    "notes": "安卓首版",
    "url": "$_origin/QFRemote-v1.0.4.apk",
    "sha256": "$_sha",
    "size": 12345678
  }
}''';
      final m = _parseSigned(body);
      expect(m.windows?.version, '1.0.3');
      expect(m.android?.version, '1.0.4');
      expect(m.android?.size, 12345678);
      expect(m.android?.fileName, 'QFRemote-v1.0.4.apk');
    });

    test('强更线 minUsable：双端解析、非法值归 null（2026-11-07）', () {
      const body = '''
{
  "version": "2.4.2",
  "notes": "",
  "url": "$_origin/QFRemote-Setup-v2.4.2.exe",
  "sha256": "$_sha",
  "size": 85471395,
  "minUsable": "2.4.2",
  "android": {
    "version": "2.4.2",
    "notes": "",
    "url": "$_origin/QFRemote-v2.4.2.apk",
    "sha256": "$_sha",
    "size": 12345678,
    "minUsable": "bogus"
  }
}''';
      final m = _parseSigned(body);
      expect(m.windows?.minUsable, '2.4.2');
      expect(m.android?.minUsable, isNull);
    });

    test('H-3：size 缺失/非法 → 整单判失败', () {
      const noSize =
          '{"version":"1.0.3","notes":"","url":"$_origin/x.exe","sha256":"$_sha"}';
      expect(() => ReleaseManifest.parse(noSize, trustedOrigin: _origin),
          throwsFormatException);
      const zeroSize =
          '{"version":"1.0.3","notes":"","url":"$_origin/x.exe","sha256":"$_sha","size":0}';
      expect(() => ReleaseManifest.parse(zeroSize, trustedOrigin: _origin),
          throwsFormatException);
      const strSize =
          '{"version":"1.0.3","notes":"","url":"$_origin/x.exe","sha256":"$_sha","size":"123"}';
      expect(() => ReleaseManifest.parse(strSize, trustedOrigin: _origin),
          throwsFormatException);
      const androidNoSize =
          '{"version":"1.0.3","notes":"","url":"$_origin/x.exe","sha256":"$_sha","size":1,'
          '"android":{"version":"1.0.4","notes":"","url":"$_origin/x.apk","sha256":"$_sha"}}';
      expect(() => ReleaseManifest.parse(androidNoSize, trustedOrigin: _origin),
          throwsFormatException);
    });

    test('文件名加固：异常尾段回落默认名，正常名保留', () {
      ReleaseEntry entry(String url) => ReleaseEntry(
          version: '1.0.0', notes: '', url: url, sha256: 'a' * 64, size: 1);
      expect(entry('https://app.qfremote.top/dl/QFRemote-v2.apk').fileName,
          'QFRemote-v2.apk');
      final dotdot = entry('https://app.qfremote.top/..').fileName;
      expect(dotdot, isNot('..'));
      expect(dotdot, isNot('.'));
      expect(dotdot, isNotEmpty);
    });

    test('没有 android 段时 android 为 null', () {
      const body = '{"version":"1.0.3","notes":"","url":"$_origin/x.exe","sha256":"$_sha","size":1}';
      final m = _parseSigned(body);
      expect(m.android, isNull);
      expect(m.windows?.version, '1.0.3');
    });

    test('下载地址指向别的主机 → 拒绝', () {
      const body = '{"version":"1.0.3","notes":"","url":"https://evil.example.com/x.exe","sha256":"$_sha"}';
      expect(() => ReleaseManifest.parse(body, trustedOrigin: _origin), throwsFormatException);
    });

    test('SHA256 不完整 → 拒绝', () {
      const body = '{"version":"1.0.3","notes":"","url":"$_origin/x.exe","sha256":"abc"}';
      expect(() => ReleaseManifest.parse(body, trustedOrigin: _origin), throwsFormatException);
    });

    test('版本号格式不对 → 拒绝', () {
      const body = '{"version":"v3","notes":"","url":"$_origin/x.exe","sha256":"$_sha"}';
      expect(() => ReleaseManifest.parse(body, trustedOrigin: _origin), throwsFormatException);
    });

    test('相对 url 按清单地址解析且仍受可信校验', () {
      const body = '{"version":"1.0.3","notes":"","url":"/x.exe","sha256":"$_sha","size":1}';
      final m = _parseSigned(body);
      expect(m.windows?.url, '$_origin/x.exe');
    });
  });

  group('isTrustedUrl', () {
    test('只认可信 origin', () {
      expect(isTrustedUrl('$_origin/release.json', trustedOrigin: _origin), isTrue);
      expect(isTrustedUrl('https://app.qfremote.top:9999/x', trustedOrigin: _origin), isFalse);
      expect(isTrustedUrl('http://app.qfremote.top/x', trustedOrigin: _origin), isFalse);
      expect(isTrustedUrl('not a url', trustedOrigin: _origin), isFalse);
    });
  });
}
