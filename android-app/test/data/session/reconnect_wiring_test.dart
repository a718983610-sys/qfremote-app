import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:qfremote/data/session/reconnect_policy.dart';
import 'package:qfremote/data/session/reconnect_wiring.dart';

/// 第 2 轮 #4：ReconnectSession（生产接线管理器）单测。
/// 覆盖任务书四项：发票、恢复成功、票据复用被拒、网络失败降级
/// （＋滚动续领／取消／stop 作废／同一设备复用 session_id）。
/// 假通道按规范 §3.3 行事：issue 发合法票据；resume 按预设脚本回放，
/// 并按传入票据回填 ResumeResult（与票据逐项一致）。

Map<String, Object?> ticketJson({
  required String sessionId,
  String deviceId = 'test-device-1',
  int? issuedAt,
}) {
  final now = issuedAt ?? DateTime.now().millisecondsSinceEpoch ~/ 1000;
  return {
    'account_id': 'alice',
    'device_id': deviceId,
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

class FakeReconnectTransport implements ReconnectTransport {
  FakeReconnectTransport({this.issueError, this.resumeScript = const []});

  /// issue 时抛的错（null＝正常发合法票据）。
  final Object? issueError;

  /// resume 回放脚本：ResumeResult 或 ReconnectFailure；'ok' 表示按
  /// 传入票据回填一致的 ResumeResult。
  final List<Object> resumeScript;

  /// resume 第一调改走此门（取消测试用：测试先调 cancel 再放行）。
  Completer<ResumeResult>? resumeGate;

  var issueCalls = 0;
  var resumeCalls = 0;

  @override
  Future<ReconnectTicket> issueTicket({
    required String deviceId,
    required String sessionId,
    String bearerKey = '',
  }) async {
    issueCalls++;
    if (issueError != null) throw issueError!;
    return ReconnectTicket.fromJson(
      ticketJson(sessionId: sessionId, deviceId: deviceId),
    );
  }

  @override
  Future<ResumeResult> resume(ReconnectTicket ticket) async {
    resumeCalls++;
    if (resumeGate != null) return resumeGate!.future;
    final item = resumeCalls <= resumeScript.length
        ? resumeScript[resumeCalls - 1]
        : resumeScript.last;
    if (item is ReconnectFailure) throw item;
    if (item == 'ok') {
      return ResumeResult(
        sessionId: ticket.sessionId,
        deviceId: ticket.deviceId,
        bindingEpoch: ticket.bindingEpoch,
        grantEpoch: ticket.grantEpoch,
      );
    }
    return item as ResumeResult;
  }
}

void main() {
  group('RC-04 接线管理器 ReconnectSession', () {
    test('start 成功：申领一张票据存内存，session_id 合 sess- 格式', () async {
      final transport = FakeReconnectTransport();
      final session = ReconnectSession(transport: transport);
      addTearDown(session.stop);
      final ok = await session.start(deviceId: 'test-device-1');
      expect(ok, isTrue);
      expect(transport.issueCalls, 1);
      expect(session.deviceId, 'test-device-1');
      expect(
        RegExp(r'^sess-[0-9a-f]{16}$').hasMatch(session.sessionId ?? ''),
        isTrue,
      );
      expect(await session.hasLiveTicket, isTrue);
    });

    test('start 时申领网络失败：fail-open，不抛错，无票据', () async {
      final transport = FakeReconnectTransport(
        issueError: Exception('no network'),
      );
      ReconnectFailure? credentialFailure;
      final session = ReconnectSession(
        transport: transport,
        onCredentialFailure: (f) => credentialFailure = f,
      );
      addTearDown(session.stop);
      final ok = await session.start(deviceId: 'test-device-1');
      expect(ok, isFalse);
      expect(await session.hasLiveTicket, isFalse);
      // 无票据时重连直接走完整登录恢复（controller 报 ticketExpired）。
      expect(await session.reconnect(), isFalse);
      expect(credentialFailure?.code, ReconnectErrorCode.ticketExpired);
    });

    test('恢复成功：钩子顺序握手→查询→清输入→Toast；成功后补领新票', () async {
      final transport = FakeReconnectTransport(resumeScript: ['ok']);
      final hooks = <String>[];
      final session = ReconnectSession(
        transport: transport,
        onHandshakeRedo: (_) async => hooks.add('handshake'),
        onQueryUnknownJobs: (_) async => hooks.add('query-unknown'),
        onClearDiscardedInput: () => hooks.add('clear-input'),
        onRestored: () => hooks.add('toast'),
      );
      addTearDown(session.stop);
      expect(await session.start(deviceId: 'test-device-1'), isTrue);
      expect(await session.reconnect(), isTrue);
      expect(hooks, ['handshake', 'query-unknown', 'clear-input', 'toast']);
      expect(transport.resumeCalls, 1);
      // 定夺 A：恢复成功后为同一 session 再领一张新票（不阻塞返回，
      // 这里等一个节拍让补领落定）。
      await Future<void>.delayed(const Duration(milliseconds: 50));
      expect(transport.issueCalls, 2);
      expect(await session.hasLiveTicket, isTrue);
    });

    test('票据复用被拒：resume 报 TICKET_REUSED，1 次即停', () async {
      final transport = FakeReconnectTransport(
        resumeScript: [const ReconnectFailure(ReconnectErrorCode.ticketReused)],
      );
      ReconnectFailure? credentialFailure;
      final session = ReconnectSession(
        transport: transport,
        onCredentialFailure: (f) => credentialFailure = f,
      );
      addTearDown(session.stop);
      expect(await session.start(deviceId: 'test-device-1'), isTrue);
      expect(await session.reconnect(), isFalse);
      expect(transport.resumeCalls, 1);
      expect(credentialFailure?.code, ReconnectErrorCode.ticketReused);
      expect(credentialFailure?.displayText, contains('重新登录'));
    });

    test('纯网络错误连败 5 次即停（固定 5 秒间隔，不指数退避）', () async {
      final transport = FakeReconnectTransport(
        resumeScript: List.filled(5, const ReconnectFailure.network()),
      );
      final session = ReconnectSession(transport: transport);
      addTearDown(session.stop);
      expect(await session.start(deviceId: 'test-device-1'), isTrue);
      expect(await session.reconnect(), isFalse);
      expect(transport.resumeCalls, 5);
    });

    test('用户取消立即停：取消后不再发起下次', () async {
      final transport = FakeReconnectTransport();
      final gate = Completer<ResumeResult>();
      transport.resumeGate = gate;
      final session = ReconnectSession(transport: transport);
      addTearDown(session.stop);
      expect(await session.start(deviceId: 'test-device-1'), isTrue);
      final fut = session.reconnect();
      for (var i = 0; i < 50 && transport.resumeCalls == 0; i++) {
        await Future<void>.delayed(const Duration(milliseconds: 10));
      }
      expect(transport.resumeCalls, 1);
      session.cancel();
      gate.completeError(const ReconnectFailure.network());
      expect(await fut, isFalse);
      expect(transport.resumeCalls, 1);
    });

    test('滚动续领：过期票据重领，仍在效不动', () async {
      final store = InMemoryReconnectTicketStore();
      final transport = FakeReconnectTransport();
      final session = ReconnectSession(transport: transport, store: store);
      addTearDown(session.stop);
      expect(await session.start(deviceId: 'test-device-1'), isTrue);
      expect(transport.issueCalls, 1);
      // 票据仍在效：续领不动。
      expect(await session.rollIfNeeded(), isTrue);
      expect(transport.issueCalls, 1);
      // 票据过期（直接往库里盖一张过期票）：续领重发一张。
      final expired = ReconnectTicket.fromJson(
        ticketJson(
          sessionId: session.sessionId!,
          issuedAt: DateTime.now().millisecondsSinceEpoch ~/ 1000 - 400,
        ),
      );
      await store.save(expired);
      expect(await session.rollIfNeeded(), isTrue);
      expect(transport.issueCalls, 2);
      expect(await session.hasLiveTicket, isTrue);
    });

    test('stop 作废票据，清 session 身份', () async {
      final transport = FakeReconnectTransport();
      final session = ReconnectSession(transport: transport);
      expect(await session.start(deviceId: 'test-device-1'), isTrue);
      expect(await session.hasLiveTicket, isTrue);
      await session.stop();
      expect(await session.hasLiveTicket, isFalse);
      expect(session.sessionId, isNull);
      expect(session.deviceId, isNull);
    });

    test('onAttempt 推状态文案：第 1／2 次序号正确', () async {
      final transport = FakeReconnectTransport(
        resumeScript: [const ReconnectFailure.network(), 'ok'],
      );
      final texts = <String>[];
      final session = ReconnectSession(
        transport: transport,
        onAttempt: texts.add,
      );
      addTearDown(session.stop);
      expect(await session.start(deviceId: 'test-device-1'), isTrue);
      expect(await session.reconnect(), isTrue);
      expect(texts, ['正在重连（第 1 次 / 共 5 次）', '正在重连（第 2 次 / 共 5 次）']);
    });

    test('同一设备重复 start 复用 session_id，不重领', () async {
      final transport = FakeReconnectTransport();
      final session = ReconnectSession(transport: transport);
      addTearDown(session.stop);
      expect(await session.start(deviceId: 'test-device-1'), isTrue);
      final firstId = session.sessionId;
      expect(await session.start(deviceId: 'test-device-1'), isTrue);
      expect(session.sessionId, firstId);
      expect(transport.issueCalls, 1);
    });
  });
}
