import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:qfremote/core/constants.dart';
import 'package:qfremote/core/manifest.dart';
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
/// 每种都必须明确报错且不留半截文件（＝有提示、不无声卡死、放行）。
/// 运行方式（端口与 dart-define 对齐 constants 里的测试覆盖口径）：
///   flutter test test/updater_chain_test.dart \
///     --dart-define=QF_CHAIN_TEST=true \
///     --dart-define=QF_RELEASE_URL=http://127.0.0.1:18791/release.json
/// 没带 define 时自动跳过（默认清单地址是生产服务器，不能真打）。
const int _port = 18791;
const String _origin = 'http://127.0.0.1:$_port';

void main() {
  const testMode = bool.fromEnvironment('QF_CHAIN_TEST');

  test('更新全流程＋失败注入', () async {
    if (!testMode) {
      markTestSkipped('需要 --dart-define=QF_CHAIN_TEST=true 才跑（见文件头说明）');
      return;
    }
    final apkBytes = List<int>.generate(200000, (i) => (i * 7 + 13) % 251);
    final apkSha = sha256.convert(apkBytes).toString();
    var mode = 'normal'; // normal|tampered|truncated|hang|stall|manifest500

    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, _port);
    addTearDown(() => server.close(force: true));
    server.listen((req) async {
      if (req.uri.path == '/release.json') {
        if (mode == 'manifest500') {
          req.response.statusCode = 500;
          await req.response.close();
          return;
        }
        final manifest = {
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
        };
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
            // 裸套接字手写响应头：声明全长、只发 40% 就掐断连接
            final raw = await req.response.detachSocket();
            raw.write('HTTP/1.1 200 OK\r\n'
                'Content-Length: ${apkBytes.length}\r\n'
                'Content-Type: application/octet-stream\r\n\r\n');
            raw.add(apkBytes.sublist(0, 80000));
            await raw.flush();
            raw.destroy();
            return;
          case 'stall':
            // 发一小块就假死（客户端无数据超时必须判失败）
            req.response.contentLength = apkBytes.length;
            req.response.add(apkBytes.sublist(0, 1000));
            await req.response.flush();
            return;
          default:
            // 分 8 块慢发，让进度回调有多档可观察
            req.response.contentLength = apkBytes.length;
            final chunk = apkBytes.length ~/ 8;
            for (var i = 0; i < 8; i++) {
              final end = i == 7 ? apkBytes.length : (i + 1) * chunk;
              req.response.add(apkBytes.sublist(i * chunk, end));
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

    final svc = UpdateService(apkIdentityVerifier: _StubApkVerifier());
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

    // 3) 中途断流：明确失败＋不留半截
    mode = 'truncated';
    final truncManifest = await svc.fetchManifest();
    await expectLater(
      svc.downloadApk(truncManifest.android!, dir, (_, _, _) {}),
      throwsA(anything),
    );
    await expectDirClean('断流后不许留 .part 半截文件');

    // 4) 清单 500：取清单即明确报错（A5 文案）
    mode = 'manifest500';
    await expectLater(
      svc.fetchManifest(),
      throwsA(isA<HttpException>().having(
          (e) => e.message, 'message', contains('获取更新清单失败：HTTP 500'))),
    );

    // 5) 服务器不回响应头：等响应头超时（注入 600ms）判失败，不无声挂死
    mode = 'hang';
    final hangManifest = ReleaseManifest.parse(jsonEncode({
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
    }), trustedOrigin: _origin);
    final impatient = UpdateService(
      responseTimeout: const Duration(milliseconds: 600),
      stallTimeout: const Duration(milliseconds: 600),
      apkIdentityVerifier: _StubApkVerifier(),
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

    // 6) 下载中途假死：无数据超时判失败＋不留半截
    mode = 'stall';
    await expectLater(
      impatient.downloadApk(hangManifest.android!, dir, (_, _, _) {}),
      throwsA(anything),
    );
    await expectDirClean('假死失败不许留 .part');

    // 7) 清单自洽但签名指纹不符（VM-02 核心腿）：大小与哈希全过，
    // 必须被装前验签拦下、文案为签名证书口径、且不留文件。
    mode = 'normal';
    final okManifest2 = await svc.fetchManifest();
    final wrongSigSvc = UpdateService(
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
  }, timeout: const Timeout(Duration(seconds: 90)));
}
