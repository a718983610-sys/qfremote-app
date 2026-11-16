import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:qfremote/core/manifest.dart';
import 'package:qfremote/core/release_signature.dart';
import 'package:qfremote/services/updater.dart';

/// F-05 测试：安卓更新清单 Ed25519 验签。
///
/// 测试密钥对（仅测试用，TEST ONLY，永不用于生产）：种子固定写死，
/// 公钥以 SPKI base64 注入；生产公钥是内嵌的 release-1（另见
/// “测试密钥签的清单用默认生产公钥解析必须拒绝”一腿）。
const String _testSeedHex =
    '0123456789abcdeffedcba98765432100123456789abcdeffedcba9876543210';
const String _testPubSpkiB64 =
    'MCowBQYDK2VwAyEAxQyzrpVpR6jeGRNbW+JoX/NIr8Y/w0qDesoSvFwfViU=';

const String _sha =
    'ffce5da483d2bd7ab99f32f7d69903c16e5d899275eed07e845a7833a5fbf351';
const String _origin = 'https://app.qfremote.top';

List<int> _hex(String s) {
  final out = <int>[];
  for (var i = 0; i < s.length; i += 2) {
    out.add(int.parse(s.substring(i, i + 2), radix: 16));
  }
  return out;
}

List<int> get _testSeed => _hex(_testSeedHex);

String _b64UrlNoPad(List<int> bytes) =>
    base64Url.encode(bytes).replaceAll('=', '');

List<int> _decodeB64UrlForTest(String s) {
  var norm = s;
  while (norm.length % 4 != 0) {
    norm += '=';
  }
  return base64Url.decode(norm);
}

/// 未签名文档：两端同版本，可调版本号/强更线。
Map<String, dynamic> _unsignedDoc({
  String version = '3.0.0',
  String? androidVersion,
  String? minUsable,
}) {
  final av = androidVersion ?? version;
  final mu = minUsable ?? version;
  return <String, dynamic>{
    'version': version,
    'notes': '测试版：稳定性与体验优化。',
    'url': '$_origin/dl/QFRemote-Setup-v$version.exe',
    'sha256': _sha,
    'size': 85471395,
    'minUsable': mu,
    'android': <String, dynamic>{
      'version': av,
      'notes': '测试版安卓',
      'url': '$_origin/dl/QFRemote-v$av.apk',
      'sha256': _sha,
      'size': 12345678,
      'minUsable': mu,
    },
    'interop': <String, dynamic>{'window': 2, 'minVersion': version},
  };
}

/// 给文档签上测试密钥签名（签的是去 signature 的规范串，与服务端
/// make-release-json.js --sign-key 同款流程）。
Map<String, dynamic> _signedDoc({
  String version = '3.0.0',
  String? androidVersion,
  String? minUsable,
}) {
  final doc = _unsignedDoc(
    version: version,
    androidVersion: androidVersion,
    minUsable: minUsable,
  );
  return _signMap(doc);
}

Map<String, dynamic> _signMap(Map<String, dynamic> doc) {
  final sig = ed25519Sign(
    seed: _testSeed,
    message: utf8.encode(canonicalReleaseJson(doc)),
  );
  doc['signature'] = <String, dynamic>{
    'alg': 'ed25519',
    'key_id': 'release-1',
    'sig': _b64UrlNoPad(sig),
  };
  return doc;
}

/// 深拷贝（篡改腿用：改副本不污染原签名文档）。
Map<String, dynamic> _copy(Map<String, dynamic> doc) =>
    jsonDecode(jsonEncode(doc)) as Map<String, dynamic>;

void main() {
  group('ed25519Verify：RFC 8032 官方向量', () {
    test('TEST 1：空消息', () {
      expect(
        ed25519Verify(
          publicKey: _hex(
              'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a'),
          message: const <int>[],
          signature: _hex(
              'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e06522490155'
              '5fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b'),
        ),
        isTrue,
      );
    });

    test('TEST 2：1 字节消息 0x72', () {
      expect(
        ed25519Verify(
          publicKey: _hex(
              '3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c'),
          message: const <int>[0x72],
          signature: _hex(
              '92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da'
              '085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00'),
        ),
        isTrue,
      );
    });

    test('改一个签名位即失败', () {
      final sig = _hex(
          'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e06522490155'
          '5fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b');
      sig[0] ^= 0x01;
      expect(
        ed25519Verify(
          publicKey: _hex(
              'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a'),
          message: const <int>[],
          signature: sig,
        ),
        isFalse,
      );
    });

    test('S ≥ L 的签名拒绝（防 malleability）', () {
      // S 全填 0xff：远大于群阶 L。
      final sig = List<int>.filled(64, 0)
        ..setRange(0, 32, _hex(
            'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e06522490155'))
        ..fillRange(32, 64, 0xff);
      expect(
        ed25519Verify(
          publicKey: _hex(
              'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a'),
          message: const <int>[],
          signature: sig,
        ),
        isFalse,
      );
    });
  });

  group('canonicalReleaseJson 与 Node 交叉向量', () {
    test('规范串与 Node JSON.stringify(排序后) 逐字节一致', () {
      const expected =
          '{"android":{"minUsable":"3.0.0","notes":"测试版安卓","sha256":"$_sha","size":12345678,"url":"$_origin/dl/QFRemote-v3.0.0.apk","version":"3.0.0"},"interop":{"minVersion":"3.0.0","window":2},"minUsable":"3.0.0","notes":"测试版：稳定性与体验优化。","sha256":"$_sha","size":85471395,"url":"$_origin/dl/QFRemote-Setup-v3.0.0.exe","version":"3.0.0"}';
      expect(canonicalReleaseJson(_unsignedDoc()), expected);
    });

    test('Node crypto 签的向量：Dart 验签通过（交叉实现互认）', () {
      // 签名由 Node crypto.sign 对上面同一规范串签发（测试密钥对）。
      const nodeSig =
          '6_IPdGmG5fU40UCINVXY_yzY2i01A7lh8tAptNVAAy9RYSlkGAiif4TV74vfwDjsFIhgPBfr1g7RXaJGyz2UBA';
      final doc = _unsignedDoc();
      doc['signature'] = <String, dynamic>{
        'alg': 'ed25519',
        'key_id': 'release-1',
        'sig': nodeSig,
      };
      final vr = verifyReleaseSignature(doc, publicKeyB64: _testPubSpkiB64);
      expect(vr.ok, isTrue, reason: vr.reason);
      expect(vr.keyId, 'release-1');
    });

    test('本机 ed25519Sign 自签自验往返', () {
      final doc = _signedDoc(version: '3.0.0');
      final vr = verifyReleaseSignature(doc, publicKeyB64: _testPubSpkiB64);
      expect(vr.ok, isTrue, reason: vr.reason);
    });
  });

  group('verifyReleaseSignature：拒绝腿', () {
    test('缺签名：code 为 missing-signature', () {
      final vr = verifyReleaseSignature(
        _unsignedDoc(),
        publicKeyB64: _testPubSpkiB64,
      );
      expect(vr.ok, isFalse);
      expect(vr.code, 'missing-signature');
    });

    test('坏签名拒绝', () {
      final doc = _signedDoc();
      final sig = doc['signature'] as Map<String, dynamic>;
      // 改签名中间一个字节（仍为合法 base64url，解码后值变了）：
      // 末字符只含填充位，改它解码会报格式错、测不到密码学不匹配。
      final raw = _decodeB64UrlForTest(sig['sig'] as String);
      raw[10] ^= 0x01;
      sig['sig'] = _b64UrlNoPad(raw);
      final vr = verifyReleaseSignature(doc, publicKeyB64: _testPubSpkiB64);
      expect(vr.ok, isFalse);
      expect(vr.reason, contains('签名与文档内容不符'));
    });

    test('错误 key_id 拒绝（release-2 / 缺失）', () {
      final wrong = _signedDoc();
      (wrong['signature'] as Map<String, dynamic>)['key_id'] = 'release-2';
      expect(
        verifyReleaseSignature(wrong, publicKeyB64: _testPubSpkiB64).ok,
        isFalse,
      );
      final missing = _signedDoc();
      (missing['signature'] as Map<String, dynamic>).remove('key_id');
      expect(
        verifyReleaseSignature(missing, publicKeyB64: _testPubSpkiB64).ok,
        isFalse,
      );
    });

    test('错误 alg / sig 非 base64url / sig 长度不对，一律拒绝', () {
      final badAlg = _signedDoc();
      (badAlg['signature'] as Map<String, dynamic>)['alg'] = 'ed25519-sha256';
      expect(
        verifyReleaseSignature(badAlg, publicKeyB64: _testPubSpkiB64).ok,
        isFalse,
      );
      final badB64 = _signedDoc();
      (badB64['signature'] as Map<String, dynamic>)['sig'] = 'not base64!@#';
      expect(
        verifyReleaseSignature(badB64, publicKeyB64: _testPubSpkiB64).ok,
        isFalse,
      );
      final shortSig = _signedDoc();
      (shortSig['signature'] as Map<String, dynamic>)['sig'] =
          _b64UrlNoPad(List<int>.filled(32, 1));
      expect(
        verifyReleaseSignature(shortSig, publicKeyB64: _testPubSpkiB64).ok,
        isFalse,
      );
    });

    test('篡改任一字段都拒绝：版本号 / android url / sha256 / minUsable', () {
      final cases = <String, void Function(Map<String, dynamic>)>{
        '顶层版本号': (d) => d['version'] = '3.0.1',
        '安卓版本号': (d) =>
            (d['android'] as Map<String, dynamic>)['version'] = '3.0.1',
        '安卓下载地址': (d) => (d['android'] as Map<String, dynamic>)['url'] =
            '$_origin/dl/QFRemote-v3.0.0-evil.apk',
        '顶层下载地址': (d) =>
            d['url'] = '$_origin/dl/QFRemote-Setup-v3.0.0-evil.exe',
        '安卓 sha256': (d) => (d['android'] as Map<String, dynamic>)['sha256'] =
            'a' * 64,
        '顶层 sha256': (d) => d['sha256'] = 'a' * 64,
        '顶层 minUsable': (d) => d['minUsable'] = '2.4.4',
        '安卓 minUsable': (d) =>
            (d['android'] as Map<String, dynamic>)['minUsable'] = '2.4.4',
        '备注': (d) => d['notes'] = '被改过的备注',
      };
      for (final e in cases.entries) {
        final doc = _copy(_signedDoc());
        e.value(doc);
        expect(
          verifyReleaseSignature(doc, publicKeyB64: _testPubSpkiB64).ok,
          isFalse,
          reason: '篡改${e.key}后验签必须失败',
        );
      }
    });

    test('SPKI 公钥损坏无法加载即拒绝', () {
      final vr = verifyReleaseSignature(
        _signedDoc(),
        publicKeyB64: 'AAAA',
      );
      expect(vr.ok, isFalse);
      expect(vr.reason, contains('验签公钥无法加载'));
    });
  });

  group('ReleaseManifest.parse：签名门（r11③ 垫片已删，缺签名一律拒绝）', () {
    test('有效签名通过，signatureVerified=true', () {
      final m = ReleaseManifest.parse(
        jsonEncode(_signedDoc(version: '3.0.0')),
        trustedOrigin: _origin,
        verifyPublicKeyB64: _testPubSpkiB64,
      );
      expect(m.signatureVerified, isTrue);
      expect(m.android?.version, '3.0.0');
    });

    test('缺签名＋≤2.4.4 也拒绝（垫片已删，不再放行无签名旧清单）', () {
      expect(
        () => ReleaseManifest.parse(
          jsonEncode(_unsignedDoc(version: '2.4.4')),
          trustedOrigin: _origin,
          verifyPublicKeyB64: _testPubSpkiB64,
        ),
        throwsA(isA<FormatException>().having(
          (e) => e.message,
          'message',
          contains('签名无效'),
        )),
      );
    });

    test('缺签名＋2.4.5 拒绝', () {
      expect(
        () => ReleaseManifest.parse(
          jsonEncode(_unsignedDoc(version: '2.4.5')),
          trustedOrigin: _origin,
          verifyPublicKeyB64: _testPubSpkiB64,
        ),
        throwsA(isA<FormatException>().having(
          (e) => e.message,
          'message',
          contains('签名无效'),
        )),
      );
    });

    test('缺签名＋3.0.0 拒绝', () {
      expect(
        () => ReleaseManifest.parse(
          jsonEncode(_unsignedDoc(version: '3.0.0')),
          trustedOrigin: _origin,
          verifyPublicKeyB64: _testPubSpkiB64,
        ),
        throwsFormatException,
      );
    });

    test('缺签名但安卓段 2.4.5、顶层 2.4.4：拒绝（两端都须 ≤2.4.4）', () {
      expect(
        () => ReleaseManifest.parse(
          jsonEncode(_unsignedDoc(
            version: '2.4.4',
            androidVersion: '2.4.5',
          )),
          trustedOrigin: _origin,
          verifyPublicKeyB64: _testPubSpkiB64,
        ),
        throwsFormatException,
      );
    });

    test('坏签名拒绝（签名在场但验不过）', () {
      final doc = _signedDoc(version: '2.4.4');
      (doc['signature'] as Map<String, dynamic>)['sig'] =
          _b64UrlNoPad(List<int>.filled(64, 7));
      expect(
        () => ReleaseManifest.parse(
          jsonEncode(doc),
          trustedOrigin: _origin,
          verifyPublicKeyB64: _testPubSpkiB64,
        ),
        throwsA(isA<FormatException>().having(
          (e) => e.message,
          'message',
          contains('签名无效'),
        )),
      );
    });

    test('错误 key_id 拒绝', () {
      final doc = _signedDoc(version: '3.0.0');
      (doc['signature'] as Map<String, dynamic>)['key_id'] = 'release-9';
      expect(
        () => ReleaseManifest.parse(
          jsonEncode(doc),
          trustedOrigin: _origin,
          verifyPublicKeyB64: _testPubSpkiB64,
        ),
        throwsFormatException,
      );
    });

    test('测试密钥签的清单用默认生产公钥解析必须拒绝（密钥不错位）', () {
      expect(
        () => ReleaseManifest.parse(
          jsonEncode(_signedDoc(version: '3.0.0')),
          trustedOrigin: _origin,
        ),
        throwsFormatException,
      );
    });

    test('篡改已签名清单的版本号后解析拒绝', () {
      final doc = _copy(_signedDoc(version: '3.0.0'));
      doc['version'] = '3.0.1';
      expect(
        () => ReleaseManifest.parse(
          jsonEncode(doc),
          trustedOrigin: _origin,
          verifyPublicKeyB64: _testPubSpkiB64,
        ),
        throwsFormatException,
      );
    });
  });

  group('UpdateService.fetchManifest：取清单即验签', () {
    late HttpServer server;
    late String origin;
    var mode = 'signed-3.0.0'; // signed-3.0.0 | unsigned-2.4.4 | unsigned-3.0.0

    setUp(() async {
      server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      origin = 'http://127.0.0.1:${server.port}';
      server.listen((req) async {
        if (req.uri.path == '/release.json') {
          final Map<String, dynamic> doc;
          switch (mode) {
            case 'signed-3.0.0':
              doc = _signedDoc(version: '3.0.0');
              // 下载地址须落在本次测试 origin 内（否则 origin 校验先拦）。
              doc['url'] = '$origin/dl/QFRemote-Setup-v3.0.0.exe';
              (doc['android'] as Map<String, dynamic>)['url'] =
                  '$origin/dl/QFRemote-v3.0.0.apk';
              // 改了 url 须重签（签名覆盖整份文档）。
              doc.remove('signature');
              _signMap(doc);
              break;
            case 'unsigned-2.4.4':
              doc = _unsignedDoc(version: '2.4.4');
              doc['url'] = '$origin/dl/QFRemote-Setup-v2.4.4.exe';
              (doc['android'] as Map<String, dynamic>)['url'] =
                  '$origin/dl/QFRemote-v2.4.4.apk';
              break;
            default:
              doc = _unsignedDoc(version: '3.0.0');
              doc['url'] = '$origin/dl/QFRemote-Setup-v3.0.0.exe';
              (doc['android'] as Map<String, dynamic>)['url'] =
                  '$origin/dl/QFRemote-v3.0.0.apk';
              break;
          }
          req.response
            ..headers.contentType = ContentType.json
            ..write(jsonEncode(doc));
          await req.response.close();
          return;
        }
        req.response.statusCode = 404;
        await req.response.close();
      });
    });

    tearDown(() async {
      await server.close(force: true);
    });

    UpdateService svc() => UpdateService(
          releaseUrl: '$origin/release.json',
          trustedOrigin: origin,
          verifyPublicKeyB64: _testPubSpkiB64,
        );

    test('已签名 3.0.0 清单取回，signatureVerified=true', () async {
      mode = 'signed-3.0.0';
      final m = await svc().fetchManifest();
      expect(m.signatureVerified, isTrue);
      expect(m.android?.version, '3.0.0');
    });

    test('无签名 2.4.4 清单取回即拒绝（垫片已删）', () async {
      mode = 'unsigned-2.4.4';
      await expectLater(
        svc().fetchManifest(),
        throwsA(isA<FormatException>().having(
          (e) => e.message,
          'message',
          contains('签名无效'),
        )),
      );
    });

    test('无签名 3.0.0 清单取回即拒绝', () async {
      mode = 'unsigned-3.0.0';
      await expectLater(
        svc().fetchManifest(),
        throwsA(isA<FormatException>().having(
          (e) => e.message,
          'message',
          contains('签名无效'),
        )),
      );
    });
  });
}
