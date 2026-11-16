import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:qfremote/data/services/api_client.dart';

/// 第 2 轮 #2：QfApiClient.getJson 状态码口径测试（本地回环服务器，
/// 不碰外网）。与 postJson 同一套语义：401/403 单飞登出＋抛
/// UnauthorizedException；其余非 2xx 抛 ApiException；非对象 JSON 抛。
void main() {
  late HttpServer server;
  late String baseUrl;

  setUp(() async {
    server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    baseUrl = 'http://127.0.0.1:${server.port}';
    server.listen((req) async {
      final path = req.uri.path;
      if (path == '/ok') {
        req.response
          ..statusCode = 200
          ..headers.contentType = ContentType.json
          ..write(jsonEncode({'ok': true, 'n': 1}));
      } else if (path == '/unauthorized' || path == '/forbidden') {
        req.response
          ..statusCode = path == '/unauthorized' ? 401 : 403
          ..headers.contentType = ContentType.json
          ..write(jsonEncode({'ok': false}));
      } else if (path == '/boom') {
        req.response
          ..statusCode = 500
          ..write('server error');
      } else if (path == '/array') {
        req.response
          ..statusCode = 200
          ..headers.contentType = ContentType.json
          ..write('[1,2]');
      } else {
        req.response
          ..statusCode = 404
          ..write('not found');
      }
      await req.response.close();
    });
  });

  tearDown(() async {
    await server.close(force: true);
  });

  test('200 JSON 对象正常解析', () async {
    final api = QfApiClient(baseUrl: baseUrl);
    final res = await api.getJson('/ok');
    expect(res['ok'], isTrue);
    expect(res['n'], 1);
    api.dispose();
  });

  test('401 抛 UnauthorizedException 并触发登出回调', () async {
    var calls = 0;
    final api = QfApiClient(
      baseUrl: baseUrl,
      onUnauthorized: () async {
        calls++;
      },
    );
    await expectLater(
      api.getJson('/unauthorized'),
      throwsA(isA<UnauthorizedException>()),
    );
    // 单飞回调在后台跑，等一拍再断言。
    await Future<void>.delayed(const Duration(milliseconds: 100));
    expect(calls, 1);
    api.dispose();
  });

  test('并发两个 401 只触发一次登出回调（单飞）', () async {
    var calls = 0;
    final api = QfApiClient(
      baseUrl: baseUrl,
      onUnauthorized: () async {
        await Future<void>.delayed(const Duration(milliseconds: 50));
        calls++;
      },
    );
    await expectLater(
      Future.wait([
        api.getJson('/unauthorized').then((_) {}, onError: (_) {}),
        api.getJson('/forbidden').then((_) {}, onError: (_) {}),
      ]),
      completes,
    );
    await Future<void>.delayed(const Duration(milliseconds: 100));
    expect(calls, 1);
    api.dispose();
  });

  test('500 抛 ApiException', () async {
    final api = QfApiClient(baseUrl: baseUrl);
    await expectLater(
      api.getJson('/boom'),
      throwsA(isA<ApiException>().having((e) => e.statusCode, 'status', 500)),
    );
    api.dispose();
  });

  test('200 但不是 JSON 对象时抛 ApiException', () async {
    final api = QfApiClient(baseUrl: baseUrl);
    await expectLater(api.getJson('/array'), throwsA(isA<ApiException>()));
    api.dispose();
  });
}
