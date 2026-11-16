import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:qfremote/app/session/session_coordinator.dart';
import 'package:qfremote/data/session/idr_client.dart';
import 'package:qfremote/data/session/quality_client.dart';
import 'package:qfremote/data/session/recording_client.dart';
import 'package:qfremote/data/session/relay_selector.dart';

/// 安卓接线第 2 轮 #5：会话客户端层协调器——中继选路门、IDR join、
/// 录像 start／end、画质探针循环（样本不完整时不发网）、手动升档。
void main() {
  RelayEntry primaryEntry() => RelayEntry(
        id: 'qfremote-primary',
        url: 'https://app.qfremote.top/console-engine/',
        tier: 1,
        priority: 100,
        ttlSec: 600,
        issuedAt: DateTime.now().millisecondsSinceEpoch,
      );

  RelayEntry otherEntry() => RelayEntry(
        id: 'other-relay',
        url: 'https://relay.example.com/console-engine/',
        tier: 2,
        priority: 100,
        ttlSec: 600,
        issuedAt: DateTime.now().millisecondsSinceEpoch,
      );

  SessionCoordinator coordinator({
    FakeRelayTransport? relay,
    FakeQualityTransport? quality,
    FakeRecordingTransport? recording,
    FakeIdrTransport? idr,
    FakeProbeSource? source,
  }) {
    return SessionCoordinator(
      baseUrlProvider: () => 'https://app.qfremote.top',
      relayTransport: relay ?? FakeRelayTransport(),
      qualityTransport: quality ?? FakeQualityTransport(),
      recordingTransport: recording ?? FakeRecordingTransport(),
      idrRequesterFactory: (sid, aid) => IdrRequester(
        sessionId: sid,
        agentId: aid,
        transport: idr ?? FakeIdrTransport(),
      ),
      probeSource: source ?? FakeProbeSource(),
    );
  }

  group('checkRelayGate', () {
    test('列表含会话地址 → allowed', () async {
      final relay = FakeRelayTransport()..list = [primaryEntry()];
      final c = coordinator(relay: relay);
      final gate = await c.checkRelayGate();
      expect(gate.blocked, isFalse);
      expect(gate.unavailable, isFalse);
    });

    test('空列表 → blocked（降级态）', () async {
      final relay = FakeRelayTransport()..list = [];
      final c = coordinator(relay: relay);
      final gate = await c.checkRelayGate();
      expect(gate.blocked, isTrue);
      expect(gate.message, RelaySessionController.degradedMessage);
      expect(c.relayDegraded, isTrue);
    });

    test('列表无会话地址 → blocked（伪造提示）', () async {
      final relay = FakeRelayTransport()..list = [otherEntry()];
      final c = coordinator(relay: relay);
      final gate = await c.checkRelayGate();
      expect(gate.blocked, isTrue);
      expect(gate.message, '该中继不在服务端宣告列表内，已拒绝连接');
    });

    test('取列表抛错 → unavailable（fail-open，不挡会话）', () async {
      final relay = FakeRelayTransport()..error = Exception('boom');
      final c = coordinator(relay: relay);
      final gate = await c.checkRelayGate();
      expect(gate.blocked, isFalse);
      expect(gate.unavailable, isTrue);
    });

    test('取列表 401 → unavailable（登录已死，不误判为降级）', () async {
      final relay = FakeRelayTransport()
        ..error = const RelayUnavailableException('UNAUTHORIZED');
      final c = coordinator(relay: relay);
      final gate = await c.checkRelayGate();
      expect(gate.blocked, isFalse);
      expect(gate.unavailable, isTrue);
      expect(c.relayDegraded, isFalse);
    });
  });

  group('beginSession', () {
    test('IDR join 一次＋录像 start 一次，会话激活', () async {
      final idr = FakeIdrTransport();
      final recording = FakeRecordingTransport();
      final c = coordinator(idr: idr, recording: recording);
      try {
        final result = await c.beginSession(
          nodeId: 'node-1',
          deviceName: '测试机',
        );
        expect(result.started, isTrue);
        expect(result.sessionId, startsWith('sess_'));
        expect(result.recordingPolicyOff, isFalse);
        expect(c.isActive, isTrue);
        expect(c.sessionId, result.sessionId);
        expect(idr.calls, 1);
        expect(idr.reasons, [IdrReason.join]);
        expect(recording.startCalls, 1);
      } finally {
        await c.endSession();
      }
    });

    test('POLICY_OFF 时不录制但会话照常激活', () async {
      final recording = FakeRecordingTransport()..startCode = 'POLICY_OFF';
      final c = coordinator(recording: recording);
      try {
        final result = await c.beginSession(
          nodeId: 'node-1',
          deviceName: '测试机',
        );
        expect(result.started, isTrue);
        expect(result.recordingPolicyOff, isTrue);
        expect(c.isActive, isTrue);
        expect(c.recordingPolicyOff, isTrue);
      } finally {
        await c.endSession();
      }
    });

    test('重复 begin 返回同一会话，不重复 join', () async {
      final idr = FakeIdrTransport();
      final c = coordinator(idr: idr);
      try {
        final first = await c.beginSession(
          nodeId: 'node-1',
          deviceName: '测试机',
        );
        final second = await c.beginSession(
          nodeId: 'node-1',
          deviceName: '测试机',
        );
        expect(second.sessionId, first.sessionId);
        expect(idr.calls, 1);
      } finally {
        await c.endSession();
      }
    });
  });

  group('runProbeTick', () {
    test('样本不完整（无测量源）→ 不发探针，只记跳过', () async {
      final quality = FakeQualityTransport();
      final source = FakeProbeSource()..sample = null;
      final c = coordinator(quality: quality, source: source);
      try {
        await c.beginSession(nodeId: 'node-1', deviceName: '测试机');
        await c.runProbeTick();
        expect(quality.probeCalls, 0);
        expect(source.calls, 1);
        expect(
          c.diagnosticLog.any((l) => l.contains('quality-probe-skipped')),
          isTrue,
        );
      } finally {
        await c.endSession();
      }
    });

    test('完整样本＋降档决策 → 探针一次、档位切换发事件、ACK 一次', () async {
      final quality = FakeQualityTransport();
      final recording = FakeRecordingTransport();
      final source = FakeProbeSource()
        ..sample = const QualityProbeSample(
          rttMs: 900,
          lossPct: 25,
          jitterMs: 80,
          lossSamples: 120,
        );
      final c = coordinator(
        quality: quality,
        recording: recording,
        source: source,
      );
      try {
        await c.beginSession(nodeId: 'node-1', deviceName: '测试机');
        quality.probeResponse = QualityProbeResponse(
          tier: SpecQualityTier.smooth,
          decision: QualityDecision(
            kind: 'downgrade-to',
            decisionId: 'qd_1',
            from: SpecQualityTier.balanced,
            to: SpecQualityTier.smooth,
            hot: const {'targetKbps': 800},
            reconfig: const {},
            mustAckByMs:
                DateTime.now().millisecondsSinceEpoch + 60000,
            needsIdr: false,
          ),
          backpressure: const BackpressureDecision(
            level: null,
            action: null,
            note: '无背压。',
          ),
        );
        await c.runProbeTick();
        expect(quality.probeCalls, 1);
        expect(c.tier, SpecQualityTier.smooth);
        expect(recording.postEventCalls, 1);
        expect(recording.postedEvents.single.type, RecEventType.qualityChange);
        expect(recording.postedEvents.single.from, 'balanced');
        expect(recording.postedEvents.single.to, 'smooth');
        expect(quality.ackCalls, 1);
        expect(quality.ackedIds, ['qd_1']);
      } finally {
        await c.endSession();
      }
    });

    test('切后台暂停录像上报、回前台恢复', () async {
      final quality = FakeQualityTransport();
      final recording = FakeRecordingTransport();
      final source = FakeProbeSource()
        ..sample = const QualityProbeSample(
          rttMs: 900,
          lossPct: 25,
          jitterMs: 80,
          lossSamples: 120,
        );
      final c = coordinator(
        quality: quality,
        recording: recording,
        source: source,
      );
      try {
        await c.beginSession(nodeId: 'node-1', deviceName: '测试机');
        quality.probeResponse = QualityProbeResponse(
          tier: SpecQualityTier.smooth,
          decision: QualityDecision(
            kind: 'downgrade-to',
            decisionId: 'qd_1',
            from: SpecQualityTier.balanced,
            to: SpecQualityTier.smooth,
            hot: const {'targetKbps': 800},
            reconfig: const {},
            mustAckByMs:
                DateTime.now().millisecondsSinceEpoch + 60000,
            needsIdr: false,
          ),
          backpressure: const BackpressureDecision(
            level: null,
            action: null,
            note: '无背压。',
          ),
        );
        c.noteBackgrounded();
        await c.runProbeTick();
        // 暂停中事件被丢弃，不发往服务端。
        expect(recording.postEventCalls, 0);
        c.noteResumed();
        quality.probeResponse = QualityProbeResponse(
          tier: SpecQualityTier.balanced,
          decision: QualityDecision(
            kind: 'upgrade-to',
            decisionId: 'qd_2',
            from: SpecQualityTier.smooth,
            to: SpecQualityTier.balanced,
            hot: const {'targetKbps': 2500},
            reconfig: const {},
            mustAckByMs:
                DateTime.now().millisecondsSinceEpoch + 60000,
            needsIdr: false,
          ),
          backpressure: const BackpressureDecision(
            level: null,
            action: null,
            note: '无背压。',
          ),
        );
        await c.runProbeTick();
        expect(recording.postEventCalls, 1);
        expect(c.tier, SpecQualityTier.balanced);
      } finally {
        await c.endSession();
      }
    });
  });

  group('endSession / requestUpgrade', () {
    test('endSession 调录像 end 一次，重复调不再调', () async {
      final recording = FakeRecordingTransport();
      final c = coordinator(recording: recording);
      await c.beginSession(nodeId: 'node-1', deviceName: '测试机');
      await c.endSession();
      await c.endSession();
      expect(recording.endCalls, 1);
      expect(c.isActive, isFalse);
    });

    test('requestUpgrade 透传决策', () async {
      final quality = FakeQualityTransport()
        ..upgradeDecision = QualityDecision(
          kind: 'upgrade-to',
          decisionId: 'qd_9',
          from: SpecQualityTier.balanced,
          to: SpecQualityTier.clear,
          hot: const {'targetKbps': 5000},
          reconfig: const {},
          mustAckByMs: DateTime.now().millisecondsSinceEpoch + 60000,
          needsIdr: false,
        );
      final c = coordinator(quality: quality);
      try {
        await c.beginSession(nodeId: 'node-1', deviceName: '测试机');
        final result = await c.requestUpgrade();
        expect(result.decision?.decisionId, 'qd_9');
        expect(c.tier, SpecQualityTier.clear);
      } finally {
        await c.endSession();
      }
    });

    test('无会话时 requestUpgrade 返回空，不抛错', () async {
      final c = coordinator();
      final result = await c.requestUpgrade();
      expect(result.decision, isNull);
      expect(result.rejection, isNull);
    });
  });
}

// ---------- 假传输 ----------

class FakeRelayTransport implements RelayTransport {
  List<RelayEntry> list = [];
  Object? error;
  var fetchCalls = 0;

  @override
  Future<List<RelayEntry>> fetchRelays() async {
    fetchCalls++;
    if (error != null) throw error!;
    return list;
  }
}

class FakeQualityTransport implements QualityTransport {
  QualityProbeResponse? probeResponse;
  QualityDecision? upgradeDecision;
  var probeCalls = 0;
  var ackCalls = 0;
  final List<String> ackedIds = [];

  @override
  Future<QualityProbeResponse> probe({
    required String sessionId,
    required SpecQualityTier tier,
    required QualityProbeSample sample,
  }) async {
    probeCalls++;
    return probeResponse ??
        QualityProbeResponse(
          tier: tier,
          backpressure: const BackpressureDecision(
            level: null,
            action: null,
            note: '无背压。',
          ),
        );
  }

  @override
  Future<
      ({
        QualityDecision? decision,
        QualityUpgradeRejection? rejection,
      })> upgrade({required String sessionId}) async {
    if (upgradeDecision != null) {
      return (decision: upgradeDecision, rejection: null);
    }
    return (decision: null, rejection: null);
  }

  @override
  Future<({bool ok, String? code, SpecQualityTier? tier, int? rttMs})> ack({
    required String sessionId,
    required String decisionId,
  }) async {
    ackCalls++;
    ackedIds.add(decisionId);
    return (
      ok: true,
      code: null,
      tier: SpecQualityTier.balanced,
      rttMs: 10,
    );
  }
}

class FakeRecordingTransport implements RecordingTransport {
  String? startCode;
  var startCalls = 0;
  var endCalls = 0;
  var postEventCalls = 0;
  final List<RecEvent> postedEvents = [];

  @override
  Future<({String? sessionId, String? code, String? message})> start({
    required String sessionIdForDesktop,
    required String deviceId,
    required String groupId,
    required String tier,
  }) async {
    startCalls++;
    if (startCode != null) {
      return (sessionId: null, code: startCode, message: 'policy off');
    }
    return (sessionId: sessionIdForDesktop, code: null, message: null);
  }

  @override
  Future<({int? events, String? code})> postEvent({
    required String sessionId,
    required RecEvent event,
  }) async {
    postEventCalls++;
    postedEvents.add(event);
    return (events: postEventCalls, code: null);
  }

  @override
  Future<
      ({
        int? events,
        int? bytes,
        List<RecSeekAnchor>? index,
        String? code,
      })> end({required String sessionId}) async {
    endCalls++;
    return (events: 3, bytes: 100, index: null, code: null);
  }

  @override
  Future<List<RecordingEntry>> list() async => const [];

  @override
  Future<({List<RecSeekAnchor>? index, bool rebuilt, String? code})>
      readIndex({required String sessionId}) async =>
          (index: null, rebuilt: false, code: 'NOT_FOUND');

  @override
  Future<Uint8List?> download({required String sessionId}) async => null;
}

class FakeIdrTransport implements IdrTransport {
  var calls = 0;
  final List<IdrReason> reasons = [];

  @override
  Future<IdrResult> request({
    required String sessionId,
    required String agentId,
    required int seq,
    required IdrReason reason,
  }) async {
    calls++;
    reasons.add(reason);
    return IdrResult(
      decision: IdrDecision.forward,
      code: 'OK',
      message: '',
      seq: seq,
    );
  }
}

class FakeProbeSource implements SessionProbeSource {
  QualityProbeSample? sample;
  var calls = 0;

  @override
  Future<QualityProbeSample?> measureSample() async {
    calls++;
    return sample;
  }
}
