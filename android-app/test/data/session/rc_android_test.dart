import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:qfremote/data/session/file_transfer.dart';
import 'package:qfremote/data/session/quality_tiers.dart';
import 'package:qfremote/data/session/reconnect_policy.dart';
import 'package:qfremote/data/session/recording_client.dart';
import 'package:qfremote/data/session/session_recording.dart';

/// 规范 §1 的合法票据 JSON（签名内容不参与客户端形状校验，用占位串）。
Map<String, Object?> validTicketJson({
  String sessionId = 'sess-0123456789abcdef',
  int? issuedAt,
}) {
  final now = (issuedAt ?? DateTime.now().millisecondsSinceEpoch ~/ 1000);
  return {
    'account_id': 'alice',
    'device_id': 'test-device-1',
    'api_key_id': 'k_xxxxxxxxxx',
    'binding_epoch': 3,
    'grant_epoch': 1,
    'resume_id': 'resume-0123456789abcdef',
    'session_id': sessionId,
    'issued_at': now,
    'expires_at': now + 300,
    'ticket_signature': 'A' * 88,
  };
}

/// 按规范 §3.3 行事的假通道：issue 发合法票据；resume 按预设脚本回放。
class ScriptedReconnectTransport implements ReconnectTransport {
  ScriptedReconnectTransport({this.resumeScript = const []});

  final List<Object> resumeScript; // ResumeResult 或 ReconnectFailure
  var issueCalls = 0;
  var resumeCalls = 0;
  ReconnectTicket? lastIssued;

  @override
  Future<ReconnectTicket> issueTicket({
    required String deviceId,
    required String sessionId,
    String bearerKey = '',
  }) async {
    issueCalls++;
    final t = ReconnectTicket.fromJson(validTicketJson(sessionId: sessionId));
    lastIssued = t;
    return t;
  }

  @override
  Future<ResumeResult> resume(ReconnectTicket ticket) async {
    resumeCalls++;
    final item = resumeCalls <= resumeScript.length
        ? resumeScript[resumeCalls - 1]
        : resumeScript.last;
    if (item is ReconnectFailure) throw item;
    return item as ResumeResult;
  }
}

const _resumeOk = ResumeResult(
  sessionId: 'sess-0123456789abcdef',
  deviceId: 'test-device-1',
  bindingEpoch: 3,
  grantEpoch: 1,
);

/// F6：首调抛 FormatException（畸形 200 的等价物），次调返回正常结果。
class ThrowingReconnectTransport implements ReconnectTransport {
  var resumeCalls = 0;

  @override
  Future<ReconnectTicket> issueTicket({
    required String deviceId,
    required String sessionId,
    String bearerKey = '',
  }) async => ReconnectTicket.fromJson(validTicketJson(sessionId: sessionId));

  @override
  Future<ResumeResult> resume(ReconnectTicket ticket) async {
    resumeCalls++;
    if (resumeCalls == 1) throw const FormatException('畸形 200');
    return _resumeOk;
  }
}

void main() {
  group('RC-04 断线重连（按 L1 规范 v1，§1/§2/§5）', () {
    test('票据形状：合法票据解析＋规范串 10 行', () {
      final t = ReconnectTicket.fromJson(validTicketJson());
      expect(t.accountId, 'alice');
      expect(t.expiresAt - t.issuedAt, 300);
      expect(t.expired, isFalse);
      final lines = t.canonicalString.split('\n');
      expect(lines, hasLength(10));
      expect(lines.first, 'qfr-lea-reconnect-v1');
      expect(lines[1], 'alice');
      expect(t.logRef, 'resume=01234567 key=k_xxxxxxxxxx');
      expect(t.canonicalString.contains('A' * 88), isFalse); // 签名不进规范串
    });

    test('票据形状：未知字段／缺签名／TTL 不等 300／id 格式错一律拒绝', () {
      final unknown = validTicketJson()..['scopes'] = ['a'];
      expect(() => ReconnectTicket.fromJson(unknown), throwsFormatException);
      final noSig = validTicketJson()..remove('ticket_signature');
      expect(() => ReconnectTicket.fromJson(noSig), throwsFormatException);
      final badTtl = validTicketJson()
        ..['expires_at'] = (validTicketJson()['issued_at'] as int) + 299;
      expect(() => ReconnectTicket.fromJson(badTtl), throwsFormatException);
      final badResume = validTicketJson()..['resume_id'] = 'resume-XYZ';
      expect(() => ReconnectTicket.fromJson(badResume), throwsFormatException);
      final badSession = validTicketJson()..['session_id'] = 'sess-xyz';
      expect(() => ReconnectTicket.fromJson(badSession), throwsFormatException);
    });

    test('session_id 生成：sess- + 16 位小写 hex', () {
      final id = generateSessionId();
      expect(RegExp(r'^sess-[0-9a-f]{16}$').hasMatch(id), isTrue);
      expect(generateSessionId(), isNot(generateSessionId()));
    });

    test('F5：logRef 取 resume_id 的 hex 段前 8 位（剥离 resume- 前缀）', () {
      // 带前缀：resume-0123456789abcdef → 01234567
      final t = ReconnectTicket.fromJson(validTicketJson());
      expect(t.logRef, 'resume=01234567 key=k_xxxxxxxxxx');
      // 无前缀纯 hex：同样取前 8 位
      const pure = ReconnectTicket(
        accountId: 'alice',
        deviceId: 'test-device-1',
        apiKeyId: 'k_xxxxxxxxxx',
        bindingEpoch: 3,
        grantEpoch: 1,
        resumeId: 'abcdef0123456789',
        sessionId: 'sess-0123456789abcdef',
        issuedAt: 1000,
        expiresAt: 1300,
        ticketSignature: 'A',
      );
      expect(pure.logRef, 'resume=abcdef01 key=k_xxxxxxxxxx');
      // 短值：取全部，不抛错
      const short = ReconnectTicket(
        accountId: 'alice',
        deviceId: 'test-device-1',
        apiKeyId: 'k_xxxxxxxxxx',
        bindingEpoch: 3,
        grantEpoch: 1,
        resumeId: 'resume-abc',
        sessionId: 'sess-0123456789abcdef',
        issuedAt: 1000,
        expiresAt: 1300,
        ticketSignature: 'A',
      );
      expect(short.logRef, 'resume=abc key=k_xxxxxxxxxx');
    });

    test('F6：ResumeResult.fromJson 缺字段／类型错抛 FormatException，ok 字段放行', () {
      // 服务端成功体含 ok 字段，不在四字段内，放行。
      expect(
        () => ResumeResult.fromJson({
          'ok': true,
          'session_id': 'sess-0123456789abcdef',
          'device_id': 'test-device-1',
          'binding_epoch': 3,
          'grant_epoch': 1,
        }),
        returnsNormally,
      );
      // 缺 grant_epoch
      expect(
        () => ResumeResult.fromJson({
          'session_id': 'sess-0123456789abcdef',
          'device_id': 'test-device-1',
          'binding_epoch': 3,
        }),
        throwsFormatException,
      );
      // binding_epoch 类型错
      expect(
        () => ResumeResult.fromJson({
          'session_id': 'sess-0123456789abcdef',
          'device_id': 'test-device-1',
          'binding_epoch': '3',
          'grant_epoch': 1,
        }),
        throwsFormatException,
      );
      // session_id 空串
      expect(
        () => ResumeResult.fromJson({
          'session_id': '',
          'device_id': 'test-device-1',
          'binding_epoch': 3,
          'grant_epoch': 1,
        }),
        throwsFormatException,
      );
    });

    test('F6：resume 响应与票据不一致时拒绝，不消费票据', () async {
      const variants = [
        // session_id 不一致
        ResumeResult(
          sessionId: 'sess-fedcba9876543210',
          deviceId: 'test-device-1',
          bindingEpoch: 3,
          grantEpoch: 1,
        ),
        // device_id 不一致
        ResumeResult(
          sessionId: 'sess-0123456789abcdef',
          deviceId: 'other-device',
          bindingEpoch: 3,
          grantEpoch: 1,
        ),
        // binding_epoch 不一致
        ResumeResult(
          sessionId: 'sess-0123456789abcdef',
          deviceId: 'test-device-1',
          bindingEpoch: 4,
          grantEpoch: 1,
        ),
        // grant_epoch 不一致
        ResumeResult(
          sessionId: 'sess-0123456789abcdef',
          deviceId: 'test-device-1',
          bindingEpoch: 3,
          grantEpoch: 2,
        ),
      ];
      for (final wrong in variants) {
        final transport = ScriptedReconnectTransport(resumeScript: [wrong]);
        final store = InMemoryReconnectTicketStore();
        ReconnectFailure? credentialFailure;
        final controller = ReconnectController(
          transport: transport,
          store: store,
          policy: ReconnectPolicy(),
          onCredentialFailure: (f) => credentialFailure = f,
        );
        const sessionId = 'sess-0123456789abcdef';
        await controller.issueOnSessionStart(
          deviceId: 'test-device-1',
          sessionId: sessionId,
          bearerKey: 'k_xxxxxxxxxx',
        );
        final ok = await controller.reconnect(sessionId);
        expect(ok, isFalse, reason: 'mismatch $wrong');
        expect(transport.resumeCalls, 1, reason: 'mismatch $wrong');
        expect(
          credentialFailure!.code,
          ReconnectErrorCode.ticketInvalid,
          reason: 'mismatch $wrong',
        );
        // 票据未消费：仍可取出（后续走完整登录恢复）。
        expect(
          await store.take(sessionId),
          isNotNull,
          reason: 'mismatch $wrong',
        );
      }
    });

    test('F6：transport 抛非 ReconnectFailure 异常时转网络失败重试，不穿出', () async {
      final transport = ThrowingReconnectTransport();
      final store = InMemoryReconnectTicketStore();
      final hooks = <String>[];
      final controller = ReconnectController(
        transport: transport,
        store: store,
        policy: ReconnectPolicy(),
        onRestored: () => hooks.add('toast'),
      );
      const sessionId = 'sess-0123456789abcdef';
      await controller.issueOnSessionStart(
        deviceId: 'test-device-1',
        sessionId: sessionId,
        bearerKey: 'k_xxxxxxxxxx',
      );
      final ok = await controller.reconnect(sessionId);
      expect(ok, isTrue);
      expect(transport.resumeCalls, 2); // 第 1 次畸形转网络重试，第 2 次成功
      expect(hooks, ['toast']);
    });

    test(
      'F6：HttpReconnectTransport 畸形 200 转 ReconnectFailure.network',
      () async {
        final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
        addTearDown(server.close);
        server.listen((req) async {
          await utf8.decoder.bind(req).join();
          req.response.headers.contentType = ContentType.json;
          // 畸形 200：session_id 类型错
          req.response.write('{"session_id": 123}');
          await req.response.close();
        });
        final transport = HttpReconnectTransport(
          baseUrl: 'http://127.0.0.1:${server.port}',
        );
        final ticket = ReconnectTicket.fromJson(validTicketJson());
        await expectLater(
          transport.resume(ticket),
          throwsA(
            isA<ReconnectFailure>().having(
              (f) => f.code,
              'code',
              ReconnectErrorCode.network,
            ),
          ),
        );
      },
    );

    test(
      'S-039：HttpReconnectTransport.issueTicket 畸形 200 转 ReconnectFailure.network',
      () async {
        final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
        addTearDown(server.close);
        server.listen((req) async {
          await utf8.decoder.bind(req).join();
          req.response.headers.contentType = ContentType.json;
          // 畸形 200：票据字段类型错（fromJson 抛 FormatException）。
          req.response.write('{"ticket": 123}');
          await req.response.close();
        });
        final transport = HttpReconnectTransport(
          baseUrl: 'http://127.0.0.1:${server.port}',
        );
        await expectLater(
          transport.issueTicket(
            deviceId: 'test-device-1',
            sessionId: 'sess-0123456789abcdef',
          ),
          throwsA(
            isA<ReconnectFailure>().having(
              (f) => f.code,
              'code',
              ReconnectErrorCode.network,
            ),
          ),
        );
      },
    );

    test(
      'S-039：HttpReconnectTransport.issueTicket 连接失败转 ReconnectFailure.network（不穿原始异常）',
      () async {
        // 先占一个端口再关掉：连上去即 connection refused。
        final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
        final port = server.port;
        await server.close();
        final transport = HttpReconnectTransport(
          baseUrl: 'http://127.0.0.1:$port',
        );
        await expectLater(
          transport.issueTicket(
            deviceId: 'test-device-1',
            sessionId: 'sess-0123456789abcdef',
          ),
          throwsA(
            isA<ReconnectFailure>().having(
              (f) => f.code,
              'code',
              ReconnectErrorCode.network,
            ),
          ),
        );
      },
    );

    test('F6：HttpReconnectTransport 正常 200 返回 ResumeResult', () async {
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      addTearDown(server.close);
      server.listen((req) async {
        await utf8.decoder.bind(req).join();
        req.response.headers.contentType = ContentType.json;
        req.response.write(
          jsonEncode({
            'ok': true,
            'session_id': 'sess-0123456789abcdef',
            'device_id': 'test-device-1',
            'binding_epoch': 3,
            'grant_epoch': 1,
          }),
        );
        await req.response.close();
      });
      final transport = HttpReconnectTransport(
        baseUrl: 'http://127.0.0.1:${server.port}',
      );
      final ticket = ReconnectTicket.fromJson(validTicketJson());
      final result = await transport.resume(ticket);
      expect(result.sessionId, 'sess-0123456789abcdef');
      expect(result.deviceId, 'test-device-1');
      expect(result.bindingEpoch, 3);
      expect(result.grantEpoch, 1);
    });

    test('§5.2：8 类凭据失败 1 次即停；纯网络错误才继续', () {
      const credentialCodes = [
        'QFR_API_KEY_REVOKED',
        'QFR_TICKET_REUSED',
        'QFR_TICKET_EXPIRED',
        'QFR_BINDING_CHANGED',
        'QFR_GRANT_REVOKED',
        'QFR_SCOPE_DENIED',
        'QFR_LEA_NOT_BOUND',
        // S-041：第 8 码 QFR_TICKET_INVALID 进循环断言（此前只在循环外
        // 断言 isCredentialFailure，未断言 shouldRetry／displayText）。
        'QFR_TICKET_INVALID',
      ];
      for (final code in credentialCodes) {
        final p = ReconnectPolicy();
        p.recordAttempt();
        final f = ReconnectFailure(ReconnectErrorCode.fromServerCode(code));
        expect(f.isCredentialFailure, isTrue, reason: code);
        expect(p.shouldRetry(f), isFalse, reason: code);
        expect(f.displayText, contains('重新登录'));
      }
      final p = ReconnectPolicy();
      expect(p.shouldRetry(const ReconnectFailure.network()), isTrue);
      expect(
        ReconnectErrorCode.fromServerCode('UNKNOWN_CODE'),
        ReconnectErrorCode.network,
      );
    });

    test('§5.2：重试上限 5 次、固定 5 秒间隔、界面文案', () {
      expect(ReconnectPolicy.maxAttempts, 5);
      expect(ReconnectPolicy.retryInterval, const Duration(seconds: 5));
      final p = ReconnectPolicy();
      for (var i = 0; i < 5; i++) {
        expect(p.shouldRetry(const ReconnectFailure.network()), isTrue);
        p.recordAttempt();
      }
      expect(p.shouldRetry(const ReconnectFailure.network()), isFalse);
      expect(p.isFinished, isTrue);
      expect(p.statusText, '正在重连（第 5 次 / 共 5 次）');
    });

    test('§5.2：用户取消立即停；重连期间输入短路丢弃', () {
      final p = ReconnectPolicy();
      p.recordAttempt();
      expect(p.dropInput, isTrue);
      p.cancel();
      expect(p.shouldRetry(const ReconnectFailure.network()), isFalse);
      expect(p.cancelled, isTrue);
    });

    test('§5.1/§1.1：票据只存内存；滚动续领只留最新；过期取不到', () async {
      final store = InMemoryReconnectTicketStore();
      final t1 = ReconnectTicket.fromJson(validTicketJson());
      await store.save(t1);
      expect((await store.take(t1.sessionId))?.resumeId, t1.resumeId);
      // 滚动续领：同 session 新票据覆盖旧票据
      final t2 = ReconnectTicket.fromJson(
        validTicketJson()..['resume_id'] = 'resume-fedcba9876543210',
      );
      await store.save(t2);
      expect(
        (await store.take(t2.sessionId))?.resumeId,
        'resume-fedcba9876543210',
      );
      // 单次性：consume 后取不到
      await store.consume(t2.sessionId);
      expect(await store.take(t2.sessionId), isNull);
      // 过期票据取不到
      final expired = ReconnectTicket.fromJson(
        validTicketJson(
          issuedAt: DateTime.now().millisecondsSinceEpoch ~/ 1000 - 400,
        ),
      );
      await store.save(expired);
      expect(await store.take(expired.sessionId), isNull);
    });

    test('§5：会话建立后立即申领票据；resume 成功走握手重建＋状态查询＋清输入＋Toast', () async {
      final transport = ScriptedReconnectTransport(resumeScript: [_resumeOk]);
      final store = InMemoryReconnectTicketStore();
      final hooks = <String>[];
      final controller = ReconnectController(
        transport: transport,
        store: store,
        policy: ReconnectPolicy(),
        onHandshakeRedo: (_) async => hooks.add('handshake'),
        onQueryUnknownJobs: (_) async => hooks.add('query-unknown'),
        onClearDiscardedInput: () => hooks.add('clear-input'),
        onRestored: () => hooks.add('toast'),
      );
      const sessionId = 'sess-0123456789abcdef';
      await controller.issueOnSessionStart(
        deviceId: 'test-device-1',
        sessionId: sessionId,
        bearerKey: 'k_xxxxxxxxxx',
      );
      expect(transport.issueCalls, 1);
      expect(await store.take(sessionId), isNotNull);
      final ok = await controller.reconnect(sessionId);
      expect(ok, isTrue);
      expect(transport.resumeCalls, 1);
      expect(hooks, ['handshake', 'query-unknown', 'clear-input', 'toast']);
      // 单次性：成功后本地票据已消费
      expect(await store.take(sessionId), isNull);
    });

    test('§5.2/§5.3-4：凭据被吊销后重连 1 次即停，不刷屏', () async {
      final transport = ScriptedReconnectTransport(
        resumeScript: [
          const ReconnectFailure(ReconnectErrorCode.apiKeyRevoked),
        ],
      );
      final store = InMemoryReconnectTicketStore();
      ReconnectFailure? credentialFailure;
      final controller = ReconnectController(
        transport: transport,
        store: store,
        policy: ReconnectPolicy(),
        onCredentialFailure: (f) => credentialFailure = f,
      );
      const sessionId = 'sess-0123456789abcdef';
      await controller.issueOnSessionStart(
        deviceId: 'test-device-1',
        sessionId: sessionId,
        bearerKey: 'k_xxxxxxxxxx',
      );
      final ok = await controller.reconnect(sessionId);
      expect(ok, isFalse);
      expect(transport.resumeCalls, 1);
      expect(credentialFailure!.code, ReconnectErrorCode.apiKeyRevoked);
      expect(credentialFailure!.displayText, contains('重新登录'));
    });

    test('§5.3-6：票据重放（同一张票据恢复两次）第二次报 TICKET_REUSED，1 次即停', () async {
      final transport = ScriptedReconnectTransport(
        resumeScript: [const ReconnectFailure(ReconnectErrorCode.ticketReused)],
      );
      final store = InMemoryReconnectTicketStore();
      ReconnectFailure? credentialFailure;
      final controller = ReconnectController(
        transport: transport,
        store: store,
        policy: ReconnectPolicy(),
        onCredentialFailure: (f) => credentialFailure = f,
      );
      const sessionId = 'sess-0123456789abcdef';
      await controller.issueOnSessionStart(
        deviceId: 'test-device-1',
        sessionId: sessionId,
        bearerKey: 'k_xxxxxxxxxx',
      );
      final ok = await controller.reconnect(sessionId);
      expect(ok, isFalse);
      expect(transport.resumeCalls, 1);
      expect(credentialFailure!.code, ReconnectErrorCode.ticketReused);
      expect(credentialFailure!.displayText, contains('重新登录'));
    });

    test('§5.2：纯网络错误连败 5 次即停（固定 5 秒间隔不指数退避）', () async {
      final transport = ScriptedReconnectTransport(
        resumeScript: List.filled(5, const ReconnectFailure.network()),
      );
      final store = InMemoryReconnectTicketStore();
      final controller = ReconnectController(
        transport: transport,
        store: store,
        policy: ReconnectPolicy(),
      );
      const sessionId = 'sess-0123456789abcdef';
      await controller.issueOnSessionStart(
        deviceId: 'test-device-1',
        sessionId: sessionId,
        bearerKey: 'k_xxxxxxxxxx',
      );
      final ok = await controller.reconnect(sessionId);
      expect(ok, isFalse);
      expect(transport.resumeCalls, 5);
    });

    test('§5.3-5：票据过期后掉线不 resume，走完整登录恢复', () async {
      final transport = ScriptedReconnectTransport(resumeScript: [_resumeOk]);
      final store = InMemoryReconnectTicketStore();
      ReconnectFailure? credentialFailure;
      final controller = ReconnectController(
        transport: transport,
        store: store,
        policy: ReconnectPolicy(),
        onCredentialFailure: (f) => credentialFailure = f,
      );
      const sessionId = 'sess-0123456789abcdef';
      final ok = await controller.reconnect(sessionId);
      expect(ok, isFalse);
      expect(transport.resumeCalls, 0);
      expect(credentialFailure!.code, ReconnectErrorCode.ticketExpired);
    });
  });

  group('RC-08 文件传输（安卓端）', () {
    test('Chunker：100MB 切片数与边界', () {
      const chunker = Chunker(100 * 1024 * 1024);
      expect(chunker.chunkCount, 1600);
      expect(chunker.chunkRange(0), (0, 65536));
      expect(chunker.chunkRange(1599), (1599 * 65536, 100 * 1024 * 1024));
      expect(chunker.nextChunkIndex(0), 0);
      expect(chunker.nextChunkIndex(65536), 1);
    });

    test('传输会话：进度、取消保留偏移、断点续传', () async {
      final s = FileTransferSession(
        direction: TransferDirection.upload,
        path: '/sdcard/a.bin',
        totalBytes: 200000,
        peerName: 'PC-1',
      );
      s.start();
      s.ackChunk(65536);
      expect(s.progress, closeTo(65536 / 200000, 0.001));
      expect(s.nextChunk, 1);
      await s.cancel();
      expect(s.state, TransferState.cancelled);
      final audit = s.audit();
      expect(audit.path, '/sdcard/a.bin');
      expect(audit.sizeBytes, 200000);
      expect(audit.toJson()['peer'], 'PC-1');
    });

    test('传输完成即 done，审计 outcome 为 done', () {
      final s = FileTransferSession(
        direction: TransferDirection.download,
        path: '/a.bin',
        totalBytes: 100,
        peerName: 'PC-1',
      );
      s.start();
      s.ackChunk(100);
      expect(s.state, TransferState.done);
      expect(s.audit().outcome, TransferState.done);
    });
  });

  group('RC-09 画质四档（安卓端）', () {
    test('四档默认参数：档位越高码率越高', () {
      expect(
        defaultQualityProfiles[QualityTier.smooth]!.maxBitrateKbps,
        lessThan(defaultQualityProfiles[QualityTier.balanced]!.maxBitrateKbps),
      );
      expect(
        defaultQualityProfiles[QualityTier.balanced]!.maxBitrateKbps,
        lessThan(defaultQualityProfiles[QualityTier.clear]!.maxBitrateKbps),
      );
      expect(
        defaultQualityProfiles[QualityTier.clear]!.maxBitrateKbps,
        lessThan(defaultQualityProfiles[QualityTier.original]!.maxBitrateKbps),
      );
    });

    test('连续 2 次探测变差自动降一档，网络恢复不自动升档', () {
      final c = QualityController(initial: QualityTier.clear);
      expect(
        c.reportProbe(const NetworkProbe(rttMs: 400, lossPercent: 6)),
        isFalse,
      ); // 第 1 次只记 streak
      expect(
        c.reportProbe(const NetworkProbe(rttMs: 400, lossPercent: 6)),
        isTrue,
      ); // 第 2 次降档
      expect(c.tier, QualityTier.balanced);
      c.reportProbe(const NetworkProbe(rttMs: 20, lossPercent: 0));
      c.reportProbe(const NetworkProbe(rttMs: 20, lossPercent: 0));
      expect(c.tier, QualityTier.balanced); // 不自动升档
    });

    test('服务端背压降档；已在最低档时不降只停发', () {
      final c = QualityController(initial: QualityTier.smooth);
      expect(c.onBackpressure(), isFalse);
      final c2 = QualityController(initial: QualityTier.balanced);
      expect(c2.onBackpressure(), isTrue);
      expect(c2.tier, QualityTier.smooth);
    });

    test('用户手动切档即时生效', () {
      final c = QualityController();
      c.setTier(QualityTier.original);
      expect(c.profile.maxFps, 60);
    });
  });

  group('RC-10 录像（安卓端）', () {
    test('默认不录：策略 off 时 start 拒绝', () {
      final s = RecordingSession(granularity: RecordingGranularity.off);
      expect(s.start(authorized: true), isFalse);
      expect(s.isRecording, isFalse);
    });

    test('未授权时拒绝开始；授权后可录', () {
      final s = RecordingSession(granularity: RecordingGranularity.user);
      expect(s.start(authorized: false), isFalse);
      expect(s.start(authorized: true), isTrue);
      s.record(
        const RecordingEvent(
          kind: RecordingEventKind.mouse,
          timestampMs: 1000,
          payloadRef: 'm1',
        ),
      );
      s.record(
        const RecordingEvent(
          kind: RecordingEventKind.key,
          timestampMs: 2000,
          payloadRef: 'k1',
        ),
      );
      expect(s.eventCount, 2);
      expect(s.eventsBetween(0, 1500), hasLength(1));
      expect(s.estimatedBytes, 128);
      s.stop();
      s.record(
        const RecordingEvent(
          kind: RecordingEventKind.mouse,
          timestampMs: 3000,
          payloadRef: 'm2',
        ),
      );
      expect(s.eventCount, 2); // 停录后丢弃
    });

    test('回放授权：只认本人，站长无直通；空 owner 拒绝（C-04）', () {
      // 本人可看。
      expect(
        canAccessRecording(ownerUsername: 'a', requesterUsername: 'a'),
        isTrue,
      );
      // 他人不可看；没有站长直通——站长看他人录像与本人看他人录像同判。
      expect(
        canAccessRecording(ownerUsername: 'a', requesterUsername: 'b'),
        isFalse,
      );
      // 空 owner 一律拒绝（fail-closed），不因请求方身份放行。
      expect(
        canAccessRecording(ownerUsername: '', requesterUsername: 'a'),
        isFalse,
      );
      expect(
        canAccessRecording(ownerUsername: '', requesterUsername: ''),
        isFalse,
      );
      expect(
        canAccessRecording(ownerUsername: 'a', requesterUsername: ''),
        isFalse,
      );
    });
  });
}
