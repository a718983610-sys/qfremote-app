import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:qfremote/core/manifest.dart';
import 'package:qfremote/core/release_signature.dart';
import 'package:qfremote/core/update_policy.dart';
import 'package:qfremote/services/updater.dart';

/// 两处签名修复的负向测试（2026-11-16）：
/// ① 主树 build.gradle.kts 无条件回退已修（本文件只测 Dart 侧；
///    Gradle 签名门见 tools/test_release_signing_gate.sh）；
/// ② r11③ 垫片已删：ReleaseManifest.parse 缺签名即抛
///    FormatException（签名无效），不再有“无签名旧清单放行”例外。
///
/// 测试密钥对与 test/release_signature_test.dart 同一对（TEST ONLY，
/// 永不用于生产）。本文件自含夹具，不依赖其他测试文件。
///
/// 站长要求的五类全覆盖：
///   A 缺失密钥/缺签名清单；B 错误签名；C 篡改清单；
///   D 旧版合法签名（正面控制：带正确签名的旧版清单必须通过，
///     无签名 ≤2.4.4 必须拒绝——预签名时代根本没有签名机制，
///     不存在“旧合法签名格式”可保留）；
///   E 降级攻击（无签名低版清单压不住更新；带签名低版清单走
///     版本策略、不因签名问题放行或降级）。
const String _testSeedHex =
    '0123456789abcdeffedcba98765432100123456789abcdeffedcba9876543210';
// 另一把钥匙的种子：只用于“别人签的清单”腿（验签须失败）。
const String _otherSeedHex =
    'ffeeddccbbaa9988776655443322110000112233445566778899aabbccddeeff';
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

String _b64UrlNoPad(List<int> bytes) =>
    base64Url.encode(bytes).replaceAll('=', '');

/// 未签名文档（两端同版本，可调版本号/强更线）。
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

/// 线上现行清单的形状（2026-11-16 实取 app.qfremote.top/release.json：
/// version 2.4.4，两端 2.4.4，minUsable 2.4.4，全程无 signature 字段）。
/// 新版客户端必须拒绝它——这是 fail-closed 的应有之义，不是测试失败；
/// 发版顺序必须是先签发带签名清单上线，再发含本改动的客户端。
Map<String, dynamic> _liveShapeUnsigned244() {
  final doc = _unsignedDoc(version: '2.4.4');
  doc['notes'] = '2.4.4 正式版：稳定性与体验优化。';
  return doc;
}

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

Map<String, dynamic> _signMap(Map<String, dynamic> doc,
    {String seedHex = _testSeedHex}) {
  final sig = ed25519Sign(
    seed: _hex(seedHex),
    message: utf8.encode(canonicalReleaseJson(doc)),
  );
  doc['signature'] = <String, dynamic>{
    'alg': 'ed25519',
    'key_id': 'release-1',
    'sig': _b64UrlNoPad(sig),
  };
  return doc;
}

Map<String, dynamic> _copy(Map<String, dynamic> doc) =>
    jsonDecode(jsonEncode(doc)) as Map<String, dynamic>;

ReleaseManifest _parse(Map<String, dynamic> doc) => ReleaseManifest.parse(
      jsonEncode(doc),
      trustedOrigin: _origin,
      verifyPublicKeyB64: _testPubSpkiB64,
    );

void _expectParseRejects(Map<String, dynamic> doc, String why) {
  expect(
    () => _parse(doc),
    throwsA(isA<FormatException>().having(
      (e) => e.message,
      'message',
      contains('签名无效'),
    )),
    reason: why,
  );
}

void main() {
  group('A 缺签名清单一律拒绝（r11③ 垫片已删）', () {
    test('A1 无签名 2.4.4（线上现行形状）拒绝', () {
      final vr = verifyReleaseSignature(
        _liveShapeUnsigned244(),
        publicKeyB64: _testPubSpkiB64,
      );
      expect(vr.ok, isFalse);
      expect(vr.code, 'missing-signature');
      _expectParseRejects(_liveShapeUnsigned244(), '线上形状的无签名 2.4.4 必须拒绝');
    });

    test('A2 无签名 2.4.3 / 2.4.0 / 2.4.4（更旧版）同样拒绝', () {
      for (final v in ['2.4.3', '2.4.0', '2.4.4']) {
        _expectParseRejects(
          _unsignedDoc(version: v),
          '无签名 $v 必须拒绝（垫片已删，不分版本）',
        );
      }
    });

    test('A3 无签名 3.0.0 / 2.4.5 拒绝', () {
      _expectParseRejects(_unsignedDoc(version: '3.0.0'), '无签名 3.0.0 必须拒绝');
      _expectParseRejects(_unsignedDoc(version: '2.4.5'), '无签名 2.4.5 必须拒绝');
    });

    test('A4 signature 字段为 null / 非对象，同样拒绝', () {
      final nullSig = _unsignedDoc(version: '3.0.0')..['signature'] = null;
      _expectParseRejects(nullSig, 'signature=null 必须拒绝');
      final strSig = _unsignedDoc(version: '3.0.0')
        ..['signature'] = 'ed25519:deadbeef';
      _expectParseRejects(strSig, 'signature 非对象必须拒绝');
    });

    test('A5 顶层 2.4.4 但安卓段 3.0.0、缺签名：拒绝', () {
      _expectParseRejects(
        _unsignedDoc(version: '2.4.4', androidVersion: '3.0.0'),
        '任一段版本高于 2.4.4 且缺签名必须拒绝',
      );
    });

    test('A6 缺签名拒绝的报错文案含“签名无效”，不含旧垫片口径', () {
      try {
        _parse(_unsignedDoc(version: '2.4.4'));
        fail('无签名清单应抛错');
      } on FormatException catch (e) {
        expect(e.message, contains('签名无效'));
        expect(e.message, isNot(contains('放行')));
      }
    });
  });

  group('B 错误签名拒绝', () {
    test('B1 别人钥匙签的清单拒绝（密钥不错位）', () {
      final doc = _unsignedDoc(version: '3.0.0');
      _signMap(doc, seedHex: _otherSeedHex);
      final vr = verifyReleaseSignature(doc, publicKeyB64: _testPubSpkiB64);
      expect(vr.ok, isFalse);
      _expectParseRejects(doc, '非 release-1 钥匙签的清单必须拒绝');
    });

    test('B2 alg 不是 ed25519 拒绝', () {
      for (final alg in ['Ed25519', 'ed25519-sha256', 'rsa', '']) {
        final doc = _signedDoc(version: '3.0.0');
        (doc['signature'] as Map<String, dynamic>)['alg'] = alg;
        expect(
          verifyReleaseSignature(doc, publicKeyB64: _testPubSpkiB64).ok,
          isFalse,
          reason: 'alg=$alg 必须拒绝',
        );
      }
      final doc = _signedDoc(version: '3.0.0');
      (doc['signature'] as Map<String, dynamic>)['alg'] = 'hmac-sha256';
      _expectParseRejects(doc, 'alg=hmac-sha256 解析必须拒绝');
    });

    test('B3 key_id 不对拒绝：release-2 / release-0 / 空 / 缺失', () {
      for (final kid in ['release-2', 'release-0', '', 'RELEASE-1']) {
        final doc = _signedDoc(version: '3.0.0');
        (doc['signature'] as Map<String, dynamic>)['key_id'] = kid;
        expect(
          verifyReleaseSignature(doc, publicKeyB64: _testPubSpkiB64).ok,
          isFalse,
          reason: 'key_id=$kid 必须拒绝',
        );
      }
      final missing = _signedDoc(version: '3.0.0');
      (missing['signature'] as Map<String, dynamic>).remove('key_id');
      _expectParseRejects(missing, '缺 key_id 解析必须拒绝');
    });

    test('B4 sig 全零 / 32 字节 / 65 字节 / 非 base64url 拒绝', () {
      final zero = _signedDoc(version: '3.0.0');
      (zero['signature'] as Map<String, dynamic>)['sig'] =
          _b64UrlNoPad(List<int>.filled(64, 0));
      _expectParseRejects(zero, '全零签名必须拒绝');

      final short = _signedDoc(version: '3.0.0');
      (short['signature'] as Map<String, dynamic>)['sig'] =
          _b64UrlNoPad(List<int>.filled(32, 1));
      expect(
        verifyReleaseSignature(short, publicKeyB64: _testPubSpkiB64).ok,
        isFalse,
        reason: '32 字节签名必须拒绝',
      );

      final long = _signedDoc(version: '3.0.0');
      (long['signature'] as Map<String, dynamic>)['sig'] =
          _b64UrlNoPad(List<int>.filled(65, 1));
      expect(
        verifyReleaseSignature(long, publicKeyB64: _testPubSpkiB64).ok,
        isFalse,
        reason: '65 字节签名必须拒绝',
      );

      final badB64 = _signedDoc(version: '3.0.0');
      (badB64['signature'] as Map<String, dynamic>)['sig'] = '!!!not-b64!!!';
      expect(
        verifyReleaseSignature(badB64, publicKeyB64: _testPubSpkiB64).ok,
        isFalse,
        reason: '非 base64url 签名必须拒绝',
      );
    });

    test('B5 签名缺 sig 字段拒绝', () {
      final doc = _signedDoc(version: '3.0.0');
      (doc['signature'] as Map<String, dynamic>).remove('sig');
      _expectParseRejects(doc, '缺 sig 字段必须拒绝');
    });
  });

  group('C 篡改清单拒绝', () {
    test('C1 篡改已签名清单任一字段后解析拒绝', () {
      final cases = <String, void Function(Map<String, dynamic>)>{
        '顶层版本号': (d) => d['version'] = '3.0.1',
        '安卓版本号': (d) =>
            (d['android'] as Map<String, dynamic>)['version'] = '3.0.1',
        '顶层下载地址': (d) =>
            d['url'] = '$_origin/dl/QFRemote-Setup-v3.0.0-evil.exe',
        '安卓下载地址': (d) => (d['android'] as Map<String, dynamic>)['url'] =
            '$_origin/dl/QFRemote-v3.0.0-evil.apk',
        '顶层 sha256': (d) => d['sha256'] = 'a' * 64,
        '安卓 sha256': (d) => (d['android'] as Map<String, dynamic>)['sha256'] =
            'a' * 64,
        '顶层 size': (d) => d['size'] = 1,
        '安卓 size': (d) =>
            (d['android'] as Map<String, dynamic>)['size'] = 1,
        '顶层 minUsable': (d) => d['minUsable'] = '9.9.9',
        '安卓 minUsable': (d) =>
            (d['android'] as Map<String, dynamic>)['minUsable'] = '9.9.9',
        '备注': (d) => d['notes'] = '假备注：请立即更新到恶意版',
        'interop 窗口': (d) =>
            (d['interop'] as Map<String, dynamic>)['window'] = 99,
      };
      for (final e in cases.entries) {
        final doc = _copy(_signedDoc(version: '3.0.0'));
        e.value(doc);
        expect(
          verifyReleaseSignature(doc, publicKeyB64: _testPubSpkiB64).ok,
          isFalse,
          reason: '篡改${e.key}后验签必须失败',
        );
        _expectParseRejects(doc, '篡改${e.key}后解析必须拒绝');
      }
    });

    test('C2 篡改后用别人的钥匙重签，仍拒绝', () {
      final doc = _copy(_signedDoc(version: '3.0.0'));
      doc['version'] = '9.9.9';
      (doc['android'] as Map<String, dynamic>)['version'] = '9.9.9';
      doc.remove('signature');
      _signMap(doc, seedHex: _otherSeedHex);
      _expectParseRejects(doc, '篡改后换钥匙重签仍须拒绝');
    });

    test('C3 只改签名本身（sig 换成另一份合法签名）拒绝', () {
      final docA = _signedDoc(version: '3.0.0');
      final docB = _signedDoc(version: '3.0.1');
      (docA['signature'] as Map<String, dynamic>)['sig'] =
          (docB['signature'] as Map<String, dynamic>)['sig'];
      _expectParseRejects(docA, '挪用另一份文档的签名必须拒绝');
    });

    test('C4 删掉 signature 后解析拒绝（签名剥离攻击）', () {
      final doc = _copy(_signedDoc(version: '3.0.0'));
      doc.remove('signature');
      final vr = verifyReleaseSignature(doc, publicKeyB64: _testPubSpkiB64);
      expect(vr.ok, isFalse);
      expect(vr.code, 'missing-signature');
      _expectParseRejects(doc, '剥离签名后必须拒绝');
    });
  });

  group('D 旧版合法签名：正面控制', () {
    test('D1 带正确签名的 2.4.4 清单必须通过', () {
      final m = _parse(_signedDoc(version: '2.4.4'));
      expect(m.signatureVerified, isTrue);
      expect(m.android?.version, '2.4.4');
      expect(m.windows?.version, '2.4.4');
    });

    test('D2 带正确签名的 2.4.0 / 2.4.3 清单必须通过', () {
      for (final v in ['2.4.0', '2.4.3']) {
        final m = _parse(_signedDoc(version: v));
        expect(m.signatureVerified, isTrue, reason: '带签名的 $v 应通过');
        expect(m.android?.version, v);
      }
    });

    test('D3 同版本对照：带签名的 2.4.4 通过、无签名的 2.4.4 拒绝', () {
      expect(_parse(_signedDoc(version: '2.4.4')).signatureVerified, isTrue);
      _expectParseRejects(
        _unsignedDoc(version: '2.4.4'),
        '同为 2.4.4，无签名必须拒绝（判定：预签名时代无签名机制，'
        '不存在可保留的旧签名格式）',
      );
    });

    test('D4 带正确签名的 3.0.0 清单通过（新版正向路径未断）', () {
      final m = _parse(_signedDoc(version: '3.0.0'));
      expect(m.signatureVerified, isTrue);
      expect(m.android?.version, '3.0.0');
    });
  });

  group('E 降级攻击', () {
    test('E1 无签名 2.4.4 清单递给 3.0.0 客户端：解析即拒绝，压不住更新', () {
      // 攻击目标：让已装 3.0.0 的客户端以为“最新就是 2.4.4”、
      // 从而不再提示更新。签名门在解析层先拦，策略层根本见不到它。
      _expectParseRejects(
        _unsignedDoc(version: '2.4.4'),
        '无签名低版清单必须在解析层拒绝',
      );
    });

    test('E2 无签名低版清单即使 minUsable 写成 9.9.9 也拒绝', () {
      // 攻击目标：伪造强更线逼客户端“强制更新”到低版/恶意版。
      _expectParseRejects(
        _unsignedDoc(version: '2.4.4', minUsable: '9.9.9'),
        '无签名清单的伪造强更线须在签名门先拦下',
      );
    });

    test('E3 带签名 2.4.4 清单递给 3.0.0 客户端：签名过，但版本策略不降级', () {
      final m = _parse(_signedDoc(version: '2.4.4'));
      expect(m.signatureVerified, isTrue);
      // 会话中：低版不是新版，不提醒。
      expect(
        decideUpdate(
          currentVersion: '3.0.0',
          manifestEntry: m.android,
          pendingVersion: null,
          isLaunchCheck: false,
        ),
        UpdateDecision.none,
      );
      // 启动时：待更新 3.0.0 未完成，清单却只有 2.4.4，不强制。
      expect(
        decideUpdate(
          currentVersion: '3.0.0',
          manifestEntry: m.android,
          pendingVersion: '3.0.0',
          isLaunchCheck: true,
        ),
        UpdateDecision.none,
      );
      // 强更线 2.4.4 不比本机 3.0.0 新，不触发强制。
      expect(
        decideUpdate(
          currentVersion: '3.0.0',
          manifestEntry: m.android,
          pendingVersion: null,
          isLaunchCheck: true,
        ),
        UpdateDecision.none,
      );
    });

    test('E4 带签名 3.0.0 清单递给 2.4.4 客户端：正常提醒/强制，更新通道未断', () {
      final m = _parse(_signedDoc(version: '3.0.0'));
      expect(
        decideUpdate(
          currentVersion: '2.4.4',
          manifestEntry: m.android,
          pendingVersion: null,
          isLaunchCheck: false,
        ),
        UpdateDecision.remind,
      );
      expect(
        decideUpdate(
          currentVersion: '2.4.4',
          manifestEntry: m.android,
          pendingVersion: null,
          isLaunchCheck: true,
        ),
        UpdateDecision.forceAtLaunch,
      );
    });

    test('E5 篡改版号冒充高版（3.0.0 改 9.9.9）不带重签：拒绝，不会误触发更新', () {
      final doc = _copy(_signedDoc(version: '3.0.0'));
      doc['version'] = '9.9.9';
      (doc['android'] as Map<String, dynamic>)['version'] = '9.9.9';
      _expectParseRejects(doc, '只改版本号不重签必须拒绝');
    });
  });

  group('F fetchManifest 负向（本机假服务器，真走取清单链路）', () {
    late HttpServer server;
    late String origin;
    var mode = 'signed-244'; // signed-244 | unsigned-244 | tampered-signed

    Map<String, dynamic> docForMode() {
      switch (mode) {
        case 'signed-244':
          final doc = _signedDoc(version: '2.4.4');
          doc['url'] = '$origin/dl/QFRemote-Setup-v2.4.4.exe';
          (doc['android'] as Map<String, dynamic>)['url'] =
              '$origin/dl/QFRemote-v2.4.4.apk';
          doc.remove('signature');
          return _signMap(doc);
        case 'tampered-signed':
          final doc = _signedDoc(version: '3.0.0');
          doc['url'] = '$origin/dl/QFRemote-Setup-v3.0.0.exe';
          (doc['android'] as Map<String, dynamic>)['url'] =
              '$origin/dl/QFRemote-v3.0.0.apk';
          doc.remove('signature');
          _signMap(doc);
          // 签完再改安卓地址：签名失效。
          (doc['android'] as Map<String, dynamic>)['url'] =
              '$origin/dl/QFRemote-v3.0.0-evil.apk';
          return doc;
        default: // unsigned-244：线上现行形状
          final doc = _liveShapeUnsigned244();
          doc['url'] = '$origin/dl/QFRemote-Setup-v2.4.4.exe';
          (doc['android'] as Map<String, dynamic>)['url'] =
              '$origin/dl/QFRemote-v2.4.4.apk';
          return doc;
      }
    }

    setUp(() async {
      server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      origin = 'http://127.0.0.1:${server.port}';
      server.listen((req) async {
        if (req.uri.path == '/release.json') {
          req.response
            ..headers.contentType = ContentType.json
            ..write(jsonEncode(docForMode()));
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

    test('F1 无签名 2.4.4 清单取回即拒绝', () async {
      mode = 'unsigned-244';
      await expectLater(
        svc().fetchManifest(),
        throwsA(isA<FormatException>().having(
          (e) => e.message,
          'message',
          contains('签名无效'),
        )),
      );
    });

    test('F2 签后篡改的清单取回即拒绝', () async {
      mode = 'tampered-signed';
      await expectLater(
        svc().fetchManifest(),
        throwsA(isA<FormatException>().having(
          (e) => e.message,
          'message',
          contains('签名无效'),
        )),
      );
    });

    test('F3 带正确签名的 2.4.4 清单取回通过（正面控制）', () async {
      mode = 'signed-244';
      final m = await svc().fetchManifest();
      expect(m.signatureVerified, isTrue);
      expect(m.android?.version, '2.4.4');
    });
  });
}
