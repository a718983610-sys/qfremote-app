import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:qfremote/data/session/idr_client.dart';
import 'package:qfremote/data/session/quality_client.dart';
import 'package:qfremote/data/session/recording_client.dart';
import 'package:qfremote/data/session/relay_selector.dart';
import 'package:qfremote/data/session/stream_transfer.dart';

/// O1：download 先校验状态码再读体、有大小上限；另验 cookie 桥与 401。
///
/// 真传输（Http*Transport）对本地 HttpServer 实测：不用假传输，
/// 覆盖“状态码判定在读体之前”与“超限中途停”这两条旧代码测不到的路径。
void main() {
  late HttpServer server;
  late String baseUrl;
  late List<String> seenCookies;

  Future<void> Function(HttpRequest req)? handler;

  Future<void> respond(
    HttpRequest req,
    int status,
    List<int> body, {
    Map<String, String>? headers,
    int? contentLength,
  }) async {
    final res = req.response;
    res.statusCode = status;
    headers?.forEach((k, v) => res.headers.set(k, v));
    if (contentLength != null) res.contentLength = contentLength;
    if (body.isNotEmpty) res.add(body);
    await res.close();
  }

  setUp(() async {
    seenCookies = [];
    server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    baseUrl = 'http://127.0.0.1:${server.port}';
    server.listen((req) async {
      final cookie = req.headers.value(HttpHeaders.cookieHeader);
      if (cookie != null) seenCookies.add(cookie);
      try {
        if (handler != null) {
          await handler!(req);
        } else {
          req.response.statusCode = 404;
          await req.response.close();
        }
      } catch (_) {
        // 客户端已断开（超限中途停）时写响应会抛，忽略。
        try {
          await req.response.close();
        } catch (_) {}
      }
    });
  });

  tearDown(() async {
    await server.close(force: true);
  });

  group('HttpStreamTransport.download', () {
    test('500 错误体不当作文件字节返回', () async {
      handler = (req) async => respond(
            req,
            500,
            List<int>.filled(100, 120),
          );
      final transport = HttpStreamTransport(baseUrl: baseUrl);
      await expectLater(
        transport.download(stagedId: 'fs_aaaaaaaaaaaaaaaa'),
        throwsA(
          isA<StreamApiException>()
              .having((e) => e.code, 'code', 'HTTP_500'),
        ),
      );
    });

    test('404 → NOT_FOUND', () async {
      handler = (req) async => respond(
            req,
            404,
            utf8Bytes('{"ok":false,"code":"NOT_FOUND"}'),
          );
      final transport = HttpStreamTransport(baseUrl: baseUrl);
      await expectLater(
        transport.download(stagedId: 'fs_aaaaaaaaaaaaaaaa'),
        throwsA(
          isA<StreamApiException>()
              .having((e) => e.code, 'code', 'NOT_FOUND'),
        ),
      );
    });

    test('206 Range 分片正常返回', () async {
      handler = (req) async {
        expect(
          req.headers.value(HttpHeaders.rangeHeader),
          'bytes=2-4',
        );
        await respond(
          req,
          206,
          [2, 3, 4],
          headers: {HttpHeaders.contentRangeHeader: 'bytes 2-4/10'},
        );
      };
      final transport = HttpStreamTransport(baseUrl: baseUrl);
      final result = await transport.download(
        stagedId: 'fs_aaaaaaaaaaaaaaaa',
        rangeStart: 2,
        rangeEnd: 4,
      );
      expect(result.isPartial, isTrue);
      expect(result.bytes, [2, 3, 4]);
      expect(result.contentRange, 'bytes 2-4/10');
    });

    test('200 且 Content-Length 超限直接拒，不读体', () async {
      handler = (req) async => respond(
            req,
            200,
            List<int>.filled(11, 1),
            contentLength: 11,
          );
      final transport = HttpStreamTransport(
        baseUrl: baseUrl,
        maxDownloadBytes: 10,
      );
      await expectLater(
        transport.download(stagedId: 'fs_aaaaaaaaaaaaaaaa'),
        throwsA(
          isA<StreamApiException>()
              .having((e) => e.code, 'code', 'TOO_LARGE'),
        ),
      );
    });

    test('200 分块体超限中途停', () async {
      handler = (req) async {
        final res = req.response;
        res.statusCode = 200;
        res.add([1, 2, 3]);
        await res.flush();
        res.add([4, 5, 6, 7, 8, 9, 10, 11]);
        await res.close();
      };
      final transport = HttpStreamTransport(
        baseUrl: baseUrl,
        maxDownloadBytes: 10,
      );
      await expectLater(
        transport.download(stagedId: 'fs_aaaaaaaaaaaaaaaa'),
        throwsA(
          isA<StreamApiException>()
              .having((e) => e.code, 'code', 'TOO_LARGE'),
        ),
      );
    });

    test('200 正常返回全文件', () async {
      handler = (req) async => respond(req, 200, [1, 2, 3, 4, 5]);
      final transport = HttpStreamTransport(baseUrl: baseUrl);
      final result = await transport.download(
        stagedId: 'fs_aaaaaaaaaaaaaaaa',
      );
      expect(result.isPartial, isFalse);
      expect(result.bytes, [1, 2, 3, 4, 5]);
    });

    test('401 → UNAUTHORIZED', () async {
      handler = (req) async => respond(
            req,
            401,
            utf8Bytes('{"ok":false,"code":"UNAUTHORIZED"}'),
          );
      final transport = HttpStreamTransport(baseUrl: baseUrl);
      await expectLater(
        transport.download(stagedId: 'fs_aaaaaaaaaaaaaaaa'),
        throwsA(
          isA<StreamApiException>()
              .having((e) => e.code, 'code', 'UNAUTHORIZED'),
        ),
      );
    });
  });

  group('cookie 桥', () {
    test('带 provider 时附 Cookie 头', () async {
      handler = (req) async => respond(req, 200, [1, 2, 3]);
      final transport = HttpStreamTransport(
        baseUrl: baseUrl,
        cookieProvider: () async => 'sess=abc',
      );
      await transport.download(stagedId: 'fs_aaaaaaaaaaaaaaaa');
      expect(seenCookies, contains('sess=abc'));
    });

    test('不带 provider 时无 Cookie 头', () async {
      handler = (req) async => respond(req, 200, [1, 2, 3]);
      final transport = HttpStreamTransport(baseUrl: baseUrl);
      await transport.download(stagedId: 'fs_aaaaaaaaaaaaaaaa');
      expect(seenCookies, isEmpty);
    });

    test('inbox 401 → UNAUTHORIZED', () async {
      handler = (req) async => respond(
            req,
            401,
            utf8Bytes('{"ok":false,"code":"UNAUTHORIZED"}'),
          );
      final transport = HttpStreamTransport(baseUrl: baseUrl);
      await expectLater(
        transport.inbox(node: 'node1'),
        throwsA(
          isA<StreamApiException>()
              .having((e) => e.code, 'code', 'UNAUTHORIZED'),
        ),
      );
    });
  });

  group('HttpRecordingTransport.download', () {
    test('500 错误体不当作录像字节返回', () async {
      handler = (req) async => respond(
            req,
            500,
            List<int>.filled(100, 120),
          );
      final transport = HttpRecordingTransport(baseUrl: baseUrl);
      await expectLater(
        transport.download(sessionId: 'sess_aaaaaaaaaaaaaaaa'),
        throwsA(
          isA<RecordingApiException>()
              .having((e) => e.code, 'code', 'HTTP_500'),
        ),
      );
    });

    test('404 → null（不存在或无权限，不泄露存在性）', () async {
      handler = (req) async => respond(
            req,
            404,
            utf8Bytes('{"ok":false,"code":"NOT_FOUND"}'),
          );
      final transport = HttpRecordingTransport(baseUrl: baseUrl);
      expect(
        await transport.download(sessionId: 'sess_aaaaaaaaaaaaaaaa'),
        isNull,
      );
    });

    test('超限 → TOO_LARGE', () async {
      handler = (req) async => respond(
            req,
            200,
            List<int>.filled(11, 1),
            contentLength: 11,
          );
      final transport = HttpRecordingTransport(
        baseUrl: baseUrl,
        maxDownloadBytes: 10,
      );
      await expectLater(
        transport.download(sessionId: 'sess_aaaaaaaaaaaaaaaa'),
        throwsA(
          isA<RecordingApiException>()
              .having((e) => e.code, 'code', 'TOO_LARGE'),
        ),
      );
    });

    test('200 正常返回', () async {
      handler = (req) async => respond(req, 200, [9, 8, 7]);
      final transport = HttpRecordingTransport(baseUrl: baseUrl);
      expect(
        await transport.download(sessionId: 'sess_aaaaaaaaaaaaaaaa'),
        [9, 8, 7],
      );
    });

    test('start 401 → UNAUTHORIZED', () async {
      handler = (req) async => respond(
            req,
            401,
            utf8Bytes('{"ok":false,"code":"UNAUTHORIZED"}'),
          );
      final transport = HttpRecordingTransport(baseUrl: baseUrl);
      await expectLater(
        transport.start(
          sessionIdForDesktop: 'sess_aaaaaaaaaaaaaaaa',
          deviceId: 'd1',
          groupId: '',
          tier: 'balanced',
        ),
        throwsA(
          isA<RecordingApiException>()
              .having((e) => e.code, 'code', 'UNAUTHORIZED'),
        ),
      );
    });
  });

  group('其余传输 401', () {
    test('relay fetchRelays 401 → UNAUTHORIZED（与空列表区分）', () async {
      handler = (req) async => respond(
            req,
            401,
            utf8Bytes('{"ok":false,"code":"UNAUTHORIZED"}'),
          );
      final transport = HttpRelayTransport(baseUrl: baseUrl);
      await expectLater(
        transport.fetchRelays(),
        throwsA(
          isA<RelayUnavailableException>()
              .having((e) => e.code, 'code', 'UNAUTHORIZED'),
        ),
      );
    });

    test('relay fetchRelays 200 正常解析且附 cookie', () async {
      handler = (req) async => respond(
            req,
            200,
            utf8Bytes(
              '{"ok":true,"relays":[{"id":"qfremote-primary",'
              '"url":"https://app.qfremote.top/console-engine/",'
              '"tier":1,"priority":100,"ttlSec":600,'
              '"issuedAt":1790000000000}]}',
            ),
          );
      final transport = HttpRelayTransport(
        baseUrl: baseUrl,
        cookieProvider: () async => 'sess=abc',
      );
      final list = await transport.fetchRelays();
      expect(list, hasLength(1));
      expect(list.first.id, 'qfremote-primary');
      expect(seenCookies, contains('sess=abc'));
    });

    test('quality probe 401 → UNAUTHORIZED', () async {
      handler = (req) async => respond(
            req,
            401,
            utf8Bytes('{"ok":false,"code":"UNAUTHORIZED"}'),
          );
      final transport = HttpQualityTransport(baseUrl: baseUrl);
      await expectLater(
        transport.probe(
          sessionId: 'sess_aaaaaaaaaaaaaaaa',
          tier: SpecQualityTier.balanced,
          sample: const QualityProbeSample(
            rttMs: 120,
            lossPct: 0.5,
            jitterMs: 12,
          ),
        ),
        throwsA(
          isA<QualityApiException>()
              .having((e) => e.code, 'code', 'UNAUTHORIZED'),
        ),
      );
    });

    test('idr request 401 → rejected UNAUTHORIZED', () async {
      handler = (req) async => respond(
            req,
            401,
            utf8Bytes('{"ok":false,"code":"UNAUTHORIZED"}'),
          );
      final transport = HttpIdrTransport(baseUrl: baseUrl);
      final result = await transport.request(
        sessionId: 'sess_aaaaaaaaaaaaaaaa',
        agentId: 'agent-1',
        seq: 1,
        reason: IdrReason.join,
      );
      expect(result.decision, IdrDecision.rejected);
      expect(result.code, 'UNAUTHORIZED');
    });
  });
}

List<int> utf8Bytes(String s) => utf8.encode(s);
