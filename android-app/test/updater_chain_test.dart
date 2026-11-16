import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:qfremote/core/constants.dart';
import 'package:qfremote/core/manifest.dart';
import 'package:qfremote/core/release_signature.dart';
import 'package:qfremote/services/apk_verify.dart';
import 'package:qfremote/services/updater.dart';

/// 验签替身（VM-02）：假 APK 不是合法 APK 结构，真验签必然失败；
/// 全链测试注入替身模拟平台验签结果。验签门本身的拒绝路径由
/// 本文件第 7/8 腿与 apk_verify_test.dart 覆盖。
class _StubApkVerifier implements ApkIdentityVerifier {
  final ApkIdentity identity;
  final Object? error;

  _StubApkVerifier({ApkIdentity? identity, this.error})
      : identity = identity ??
            const ApkIdentity(
              packageName: kExpectedApkPackageName,
              signerCertSha256s: [kExpectedApkCertSha256],
            );

  @override
  Future<ApkIdentity> inspect(File apk) async {
    final e = error;
    if (e != null) throw e;
    return identity;
  }
}

/// 更新链实测（假清单，追加十一补齐失败注入）：本机起一个临时服务器发假的
/// release.json + 假 APK，真走一遍 App 自己的更新服务全流程：
/// 取清单 → 解析 → 下载（进度单调至 100%）→ 核对 SHA256 → 落盘；
/// 失败注入：中途断流、校验篡改、清单 500、服务器不回响应头、下载中途假死，
/// 每种都必须明确报错；校验/验签失败不留文件，断流/假死保留 .part 供续传
/// （2.4.5 B17），续传成功后文件完整可用。
/// 运行方式：普通 `flutter test` 即跑（H-8 起默认开启）——清单地址与可信源
/// 经 UpdateService 的测试注入参指向本机假服务器，不再依赖命令行 define，
/// 更不会打到生产服务器。
const int _port = 18791;
const String _origin = 'http://127.0.0.1:$_port';

/// F-05：假清单也要带 Ed25519 签名（测试密钥对，与
/// test/release_signature_test.dart 同一对，TEST ONLY）。
/// 发版清单签名覆盖整份文档，篡改腿（mode=tampered）是“先改 sha 再签”，
/// 这样 fetchManifest 验签通过、下载完整性腿仍能测到 SHA 不一致；
/// 若只签正常文档再改 sha，清单签名腿会先拦，下载腿就测不到了。
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

Map<String, dynamic> _signManifest(Map<String, dynamic> doc) {
  final sig = ed25519Sign(
    seed: _hex(_testSeedHex),
    message: utf8.encode(canonicalReleaseJson(doc)),
  );
  doc['signature'] = <String, dynamic>{
    'alg': 'ed25519',
    'key_id': 'release-1',
    'sig': base64Url.encode(sig).replaceAll('=', ''),
  };
  return doc;
}

void main() {
  test('更新全流程＋失败注入', () async {
    final apkBytes = List<int>.generate(200000, (i) => (i * 7 + 13) % 251);
    final apkSha = sha256.convert(apkBytes).toString();
    var mode = 'normal'; // normal|tampered|truncated|hang|stall|manifest500|manifestHtml

    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, _port);
    addTearDown(() => server.close(force: true));
    server.listen((req) async {
      if (req.uri.path == '/release.json') {
        if (mode == 'manifest500') {
          req.response.statusCode = 500;
          await req.response.close();
          return;
        }
        if (mode == 'manifestHtml') {
          // QF-09：200 + text/html 的假清单（中间页／错误页冒充清单）。
          req.response
            ..headers.contentType = ContentType.html
            ..write('<html><body>not a manifest</body></html>');
          await req.response.close();
          return;
        }
        final manifest = _signManifest({
          'version': '9.9.9',
          'notes': '测试清单（Windows 段占位）',
          'url': '$_origin/QFRemote-Setup-v9.9.9.exe',
          'sha256': apkSha,
          'size': apkBytes.length,
          'android': {
            'version': '9.9.9',
            'notes': '测试更新',
            'url': '$_origin/QFRemote-v9.9.9.apk',
            'sha256': mode == 'tampered' ? 'b' * 64 : apkSha,
            'size': apkBytes.length,
          },
        });
        req.response
          ..headers.contentType = ContentType.json
          ..write(jsonEncode(manifest));
        await req.response.close();
        return;
      }
      if (req.uri.path.endsWith('.apk')) {
        switch (mode) {
          case 'hang':
            // 接受请求、永不回响应头（客户端等响应头超时必须判失败）
            return;
          case 'truncated':
            // 2.4.5 B17 夹具修正：先在 HttpResponse 上写好 Content-Length
            // 再 detach（新版 Dart 的 detachSocket 会先刷默认头，裸写
            // 状态行会导致客户端收到双份头、按 chunked 解析失败）；
            // 只发 40% 就掐断连接，模拟中途断流。
            req.response.contentLength = apkBytes.length;
            req.response.headers.contentType = ContentType.binary;
            final raw = await req.response.detachSocket();
            raw.add(apkBytes.sublist(0, 80000));
            await raw.flush();
            raw.destroy();
            return;
          case 'stall':
            // 发一大块就假死（客户端无数据超时必须判失败）。首块须够大
            // （100KB）：小写入会被服务端响应缓冲扣住不发出，客户端
            // 永远收不到、测不到「已收部分保留」。
            req.response.contentLength = apkBytes.length;
            req.response.add(apkBytes.sublist(0, 100000));
            await req.response.flush();
            return;
          default:
            // 2.4.5 B17：支持 Range 续传——带 bytes=N- 时回 206 + 剩余字节。
            final range = req.headers.value(HttpHeaders.rangeHeader);
            var start = 0;
            if (range != null) {
              final m = RegExp(r'bytes=(\d+)-').firstMatch(range);
              if (m != null) {
                start = int.parse(m.group(1)!).clamp(0, apkBytes.length);
                req.response.statusCode = 206;
                req.response.headers.set(
                    'Content-Range', 'bytes $start-${apkBytes.length - 1}/${apkBytes.length}');
              }
            }
            req.response.contentLength = apkBytes.length - start;
            final chunk = (apkBytes.length - start) ~/ 8;
            for (var i = 0; i < 8; i++) {
              final s = start + i * chunk;
              final end = i == 7 ? apkBytes.length : start + (i + 1) * chunk;
              req.response.add(apkBytes.sublist(s, end));
              await req.response.flush();
              await Future<void>.delayed(const Duration(milliseconds: 30));
            }
            await req.response.close();
            return;
        }
      }
      req.response.statusCode = 404;
      await req.response.close();
    });

    final svc = UpdateService(
      apkIdentityVerifier: _StubApkVerifier(),
      releaseUrl: '$_origin/release.json',
      trustedOrigin: _origin,
      verifyPublicKeyB64: _testPubSpkiB64,
    );
    final dir = await Directory.systemTemp.createTemp('qf_upd_test');
    addTearDown(() async {
      try {
        await dir.delete(recursive: true);
      } catch (_) {}
    });

    Future<void> expectDirClean(String why) async {
      final leftovers = await dir.list().toList();
      expect(
        leftovers.where((e) => e.path.endsWith('.apk') || e.path.endsWith('.part')),
        isEmpty,
        reason: why,
      );
    }

    // 1) 全流程：清单→下载→核对→落盘；进度单调不减、终点 100
    final manifest = await svc.fetchManifest();
    expect(manifest.android, isNotNull);
    expect(manifest.android!.version, '9.9.9');
    final percents = <int>[];
    final file = await svc.downloadApk(manifest.android!, dir, (r, t, p) {
      if (p != null) percents.add(p);
    });
    expect(percents.length, greaterThanOrEqualTo(3), reason: '进度应多档实时更新');
    for (var i = 1; i < percents.length; i++) {
      expect(percents[i], greaterThanOrEqualTo(percents[i - 1]),
          reason: '进度必须单调不减');
    }
    expect(percents.last, 100);
    expect(await file.length(), apkBytes.length);
    expect(sha256.convert(await file.readAsBytes()).toString(), apkSha);
    await file.delete();

    // 2) 校验篡改：明确失败＋不留坏包
    mode = 'tampered';
    final badManifest = await svc.fetchManifest();
    await expectLater(
      svc.downloadApk(badManifest.android!, dir, (_, _, _) {}),
      throwsA(isA<FormatException>().having(
          (e) => e.message, 'message', contains('完整性核对未通过'))),
    );
    await expectDirClean('校验不过的文件（连同 .part）必须删掉');

    // 3) 中途断流：明确失败＋保留 .part（2.4.5 B17：续传用），
    // 再下一次须从断点续传成功、文件完整。
    mode = 'truncated';
    final truncManifest = await svc.fetchManifest();
    await expectLater(
      svc.downloadApk(truncManifest.android!, dir, (_, _, _) {}),
      throwsA(anything),
    );
    final partAfterTrunc = File(
        '${dir.path}/${UpdateService.partFileName(truncManifest.android!)}');
    expect(await partAfterTrunc.exists(), isTrue,
        reason: '断流后 .part 须保留供续传');
    expect(await partAfterTrunc.length(), 80000);
    mode = 'normal';
    final resumedFile =
        await svc.downloadApk(truncManifest.android!, dir, (_, _, _) {});
    expect(await resumedFile.length(), apkBytes.length);
    expect(sha256.convert(await resumedFile.readAsBytes()).toString(), apkSha);
    expect(await partAfterTrunc.exists(), isFalse,
        reason: '续传成功后 .part 应已改名落盘');
    await resumedFile.delete();

    // 4) 清单 500：取清单即明确报错（A5 文案）
    mode = 'manifest500';
    await expectLater(
      svc.fetchManifest(),
      throwsA(isA<HttpException>().having(
          (e) => e.message, 'message', contains('获取更新清单失败：HTTP 500'))),
    );

    // 5) 服务器不回响应头：等响应头超时（注入 600ms）判失败，不无声挂死
    mode = 'hang';
    final hangManifest = ReleaseManifest.parse(jsonEncode(_signManifest({
      'version': '9.9.9',
      'notes': '',
      'url': '$_origin/QFRemote-Setup-v9.9.9.exe',
      'sha256': apkSha,
      'size': apkBytes.length,
      'android': {
        'version': '9.9.9',
        'notes': '',
        'url': '$_origin/QFRemote-v9.9.9.apk',
        'sha256': apkSha,
        'size': apkBytes.length,
      },
    })), trustedOrigin: _origin, verifyPublicKeyB64: _testPubSpkiB64);
    final impatient = UpdateService(
      responseTimeout: const Duration(milliseconds: 600),
      stallTimeout: const Duration(milliseconds: 600),
      apkIdentityVerifier: _StubApkVerifier(),
      releaseUrl: '$_origin/release.json',
      trustedOrigin: _origin,
      verifyPublicKeyB64: _testPubSpkiB64,
    );
    final sw = Stopwatch()..start();
    // VM-03 起下载层异常统一映射为中文 FormatException 展示给用户，
    // 超时也不再以 TimeoutException 原文上界面；判失败的时限口径不变。
    await expectLater(
      impatient.downloadApk(hangManifest.android!, dir, (_, _, _) {}),
      throwsA(isA<FormatException>().having(
          (e) => e.message, 'message', contains('下载中断'))),
    );
    expect(sw.elapsed, lessThan(const Duration(seconds: 10)),
        reason: '等响应头超时应在注入时限附近判失败');
    await expectDirClean('无响应头失败不许留文件');

    // 6) 下载中途假死：无数据超时判失败＋保留 .part 供续传（2.4.5 B17）
    mode = 'stall';
    await expectLater(
      impatient.downloadApk(hangManifest.android!, dir, (_, _, _) {}),
      throwsA(anything),
    );
    final partAfterStall = File(
        '${dir.path}/${UpdateService.partFileName(hangManifest.android!)}');
    expect(await partAfterStall.exists(), isTrue,
        reason: '假死后 .part 须保留供续传');
    expect(await partAfterStall.length(), 100000);

    // 7) 清单自洽但签名指纹不符（VM-02 核心腿）：大小与哈希全过，
    // 必须被装前验签拦下、文案为签名证书口径、且不留文件。
    mode = 'normal';
    final okManifest2 = await svc.fetchManifest();
    final wrongSigSvc = UpdateService(
      releaseUrl: '$_origin/release.json',
      trustedOrigin: _origin,
      apkIdentityVerifier: _StubApkVerifier(
        identity: const ApkIdentity(
          packageName: kExpectedApkPackageName,
          signerCertSha256s: [
            '0000000000000000000000000000000000000000000000000000000000000000'
          ],
        ),
      ),
    );
    await expectLater(
      wrongSigSvc.downloadApk(okManifest2.android!, dir, (_, _, _) {}),
      throwsA(isA<FormatException>().having(
          (e) => e.message, 'message', contains('签名证书核验未通过'))),
    );
    await expectDirClean('验签不过的文件（连同 .part）必须删掉');

    // 8) 验签通道不可用（替身抛错）：fail-closed 拒装＋不留文件。
    final deadSvc = UpdateService(
      releaseUrl: '$_origin/release.json',
      trustedOrigin: _origin,
      apkIdentityVerifier: _StubApkVerifier(
        error: const ApkVerificationException('仿真验签通道失败'),
      ),
    );
    await expectLater(
      deadSvc.downloadApk(okManifest2.android!, dir, (_, _, _) {}),
      throwsA(isA<FormatException>().having(
          (e) => e.message, 'message', contains('签名核验未通过'))),
    );
    await expectDirClean('验签通道不可用时不许留文件');

    // 9) QF-09：清单以 text/html 回来（200＋错误页冒充清单）时，
    // fetchManifest 须在解析前按 Content-Type 拒绝，不进 JSON 解析。
    mode = 'manifestHtml';
    await expectLater(
      svc.fetchManifest(),
      throwsA(isA<HttpException>().having(
          (e) => e.message, 'message', contains('更新清单类型不正确'))),
    );
    // 恢复正常模式后清单仍可取（上一腿只拒了这一次响应）。
    mode = 'normal';
    final afterHtml = await svc.fetchManifest();
    expect(afterHtml.android?.version, '9.9.9');
  }, timeout: const Timeout(Duration(seconds: 90)));
}
