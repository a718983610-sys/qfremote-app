import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:qfremote/services/updater.dart';

/// 更新链实测（假清单）：本机起一个临时服务器发假的 release.json + 假 APK，
/// 真走一遍 App 自己的更新服务（取清单 → 解析 → 下载带进度 → 核对 SHA256）。
/// 运行方式（端口与 dart-define 对齐 constants 里的测试覆盖口径）：
///   flutter test test/updater_chain_test.dart \
///     --dart-define=QF_RELEASE_URL=http://127.0.0.1:18791/release.json
/// 没带这个 define 时测试自动跳过（默认清单地址是生产服务器，不能真打）。
const int _port = 18791;
const String _origin = 'http://127.0.0.1:$_port';

void main() {
  const testMode = bool.fromEnvironment('QF_CHAIN_TEST');
  test('假清单更新链：解析→下载→哈希核对通过；篡改清单必须被拒', () async {
    if (!testMode) {
      markTestSkipped('需要 --dart-define=QF_CHAIN_TEST=true 才跑（见文件头说明）');
      return;
    }
    // 假 APK 内容（固定字节，方便算哈希）
    final apkBytes = List<int>.generate(200000, (i) => (i * 7 + 13) % 251);
    final apkSha = sha256.convert(apkBytes).toString();
    var tampered = false;

    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, _port);
    addTearDown(() => server.close(force: true));
    server.listen((req) {
      if (req.uri.path == '/release.json') {
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
            'sha256': tampered ? 'b' * 64 : apkSha,
            'size': apkBytes.length,
          },
        };
        req.response
          ..headers.contentType = ContentType.json
          ..write(jsonEncode(manifest));
        req.response.close();
      } else if (req.uri.path.endsWith('.apk')) {
        req.response
          ..contentLength = apkBytes.length
          ..add(apkBytes);
        req.response.close();
      } else {
        req.response.statusCode = 404;
        req.response.close();
      }
    });

    final svc = UpdateService();
    final dir = await Directory.systemTemp.createTemp('qf_upd_test');

    // 1) 取清单：android 段解析正确
    final manifest = await svc.fetchManifest();
    expect(manifest.android, isNotNull);
    expect(manifest.android!.version, '9.9.9');
    expect(manifest.android!.sha256, apkSha);

    // 2) 下载 + 核对：成功，且有进度回调、文件内容一致
    var progressEvents = 0;
    int? lastPercent;
    final file = await svc.downloadApk(manifest.android!, dir, (r, t, p) {
      progressEvents++;
      lastPercent = p;
    });
    expect(progressEvents, greaterThan(0));
    expect(lastPercent, 100);
    expect(await file.length(), apkBytes.length);
    expect(sha256.convert(await file.readAsBytes()).toString(), apkSha);

    // 3) 篡改 SHA 的清单：下载必须失败、文件必须被删
    tampered = true;
    final badManifest = await svc.fetchManifest();
    await expectLater(
      svc.downloadApk(badManifest.android!, dir, (_, _, _) {}),
      throwsA(isA<FormatException>()),
    );
    final leftovers = await dir.list().toList();
    expect(leftovers.where((e) => e.path.endsWith('.apk') || e.path.endsWith('.part')),
        isEmpty,
        reason: '校验不过的文件（连同同名目标与 .part）都必须删掉，绝不留坏包');

    await dir.delete(recursive: true);
  }, timeout: const Timeout(Duration(seconds: 60)));
}
