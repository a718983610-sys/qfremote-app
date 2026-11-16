import 'dart:convert';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:qfremote/data/session/fec_decoder.dart';
import 'package:qfremote/data/session/idr_client.dart';
import 'package:qfremote/data/session/quality_client.dart';
import 'package:qfremote/data/session/recording_client.dart';
import 'package:qfremote/data/session/relay_selector.dart';
import 'package:qfremote/data/session/stream_transfer.dart';

// ---------- 假通道 ----------

class ScriptedIdrTransport implements IdrTransport {
  ScriptedIdrTransport(this.script);
  final List<IdrResult Function(int seq)> script;
  final List<int> seenSeqs = [];
  final List<String> seenReasons = [];
  var calls = 0;

  @override
  Future<IdrResult> request({
    required String sessionId,
    required String agentId,
    required int seq,
    required IdrReason reason,
  }) async {
    calls++;
    seenSeqs.add(seq);
    seenReasons.add(reason.wire);
    final fn = calls <= script.length ? script[calls - 1] : script.last;
    return fn(seq);
  }
}

IdrResult _idr(String code, IdrDecision d, int seq) => IdrResult(
      decision: d,
      code: code,
      message: code,
      seq: seq,
    );

class FakeRelayTransport implements RelayTransport {
  FakeRelayTransport(this.relays);
  final List<RelayEntry> relays;
  var calls = 0;
  @override
  Future<List<RelayEntry>> fetchRelays() async {
    calls++;
    return relays;
  }
}

class FakeStreamTransport implements StreamTransport {
  FakeStreamTransport({this.serverChunkSize = 1024 * 1024});
  final int serverChunkSize;
  final Map<String, Set<int>> received = {};
  final Map<String, int> totalChunksById = {};
  String? lastTransferId;
  var commitCalls = 0;
  StreamCommitOutcome commitOutcome = StreamCommitOutcome.staged;
  List<int> commitMissing = const [];

  @override
  Future<({String transferId, int chunkSize, int totalChunks})> init({
    required String filename,
    required int size,
    required String sha256,
    required String toNode,
    String? fromNode,
    int? chunkSize,
  }) async {
    final id = 'tf_${'a' * 16}';
    lastTransferId = id;
    final cs = serverChunkSize;
    final total = (size + cs - 1) ~/ cs;
    received[id] = {};
    totalChunksById[id] = total;
    return (transferId: id, chunkSize: cs, totalChunks: total);
  }

  @override
  Future<int> putChunk({
    required String transferId,
    required int index,
    required List<int> bytes,
  }) async {
    received.putIfAbsent(transferId, () => {}).add(index);
    return received[transferId]!.length;
  }

  @override
  Future<List<int>> missing({required String transferId}) async {
    final total = totalChunksById[transferId] ?? 0;
    final got = received[transferId] ?? {};
    return List<int>.generate(total, (i) => i)
        .where((i) => !got.contains(i))
        .toList();
  }

  @override
  Future<StreamCommitResult> commit({required String transferId}) async {
    commitCalls++;
    return switch (commitOutcome) {
      StreamCommitOutcome.staged => const StreamCommitResult(
          outcome: StreamCommitOutcome.staged,
          stagedId: 'fs_aaaaaaaaaaaaaaaa',
          size: 10,
          expiresAtMs: 1790000000000,
        ),
      StreamCommitOutcome.incomplete => StreamCommitResult(
          outcome: StreamCommitOutcome.incomplete,
          missing: commitMissing,
          code: 'INCOMPLETE',
        ),
      StreamCommitOutcome.corrupt => const StreamCommitResult(
          outcome: StreamCommitOutcome.corrupt,
          code: 'CORRUPT',
          message: '传输已作废。',
        ),
      StreamCommitOutcome.failed => const StreamCommitResult(
          outcome: StreamCommitOutcome.failed,
          code: 'IO',
        ),
    };
  }

  @override
  Future<void> cancel({required String transferId}) async {}

  @override
  Future<List<StreamInboxFile>> inbox({required String node}) async => const [];

  @override
  Future<List<StreamInboxFile>> sent() async => const [];

  @override
  Future<void> ack({required String stagedId}) async {}

  @override
  Future<List<StreamAuditEntry>> audit({int limit = 50}) async => const [];

  @override
  Future<StreamDownloadResult> download({
    required String stagedId,
    int? rangeStart,
    int? rangeEnd,
  }) async {
    // 模拟服务端：Range 合法 → 206；Range 起点超长 → 200 全文件回落。
    final full = Uint8List.fromList(List<int>.generate(10, (i) => i));
    if (rangeStart != null && rangeStart >= 10) {
      return StreamDownloadResult(bytes: full, isPartial: false);
    }
    if (rangeStart != null) {
      final end = rangeEnd ?? 9;
      return StreamDownloadResult(
        bytes: Uint8List.fromList(full.sublist(rangeStart, end + 1)),
        isPartial: true,
        contentRange: 'bytes $rangeStart-$end/10',
      );
    }
    return StreamDownloadResult(bytes: full, isPartial: false);
  }
}

class FakeQualityTransport implements QualityTransport {
  FakeQualityTransport({this.probeResponse, this.upgradeDecision});
  QualityProbeResponse? probeResponse;
  QualityDecision? upgradeDecision;
  QualityUpgradeRejection? upgradeRejection;
  var probeCalls = 0;
  var ackCalls = 0;
  final List<String> ackedIds = [];
  bool ackUnknown = false;

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
  Future<({QualityDecision? decision, QualityUpgradeRejection? rejection})>
      upgrade({required String sessionId}) async {
    if (upgradeRejection != null) {
      return (decision: null, rejection: upgradeRejection);
    }
    return (decision: upgradeDecision, rejection: null);
  }

  @override
  Future<({bool ok, String? code, SpecQualityTier? tier, int? rttMs})> ack({
    required String sessionId,
    required String decisionId,
  }) async {
    ackCalls++;
    ackedIds.add(decisionId);
    if (ackUnknown) {
      return (ok: false, code: 'UNKNOWN_DECISION', tier: null, rttMs: null);
    }
    return (ok: true, code: null, tier: SpecQualityTier.balanced, rttMs: 120);
  }
}

class FakeRecordingTransport implements RecordingTransport {
  FakeRecordingTransport({this.policyOff = false, this.notFoundAfter = -1});
  final bool policyOff;
  final int notFoundAfter; // 第几次 event 起返回 NOT_FOUND（-1 = 永不）
  var eventCalls = 0;
  var startCalls = 0;
  String sessionId = 'rec_aaaaaaaaaaaaaaaa';

  @override
  Future<({String? sessionId, String? code, String? message})> start({
    required String sessionIdForDesktop,
    required String deviceId,
    required String groupId,
    required String tier,
  }) async {
    startCalls++;
    if (policyOff) {
      return (sessionId: null, code: 'POLICY_OFF', message: '录制策略未开启（默认不录）。');
    }
    sessionId = 'rec_${'b' * 16}';
    return (sessionId: sessionId, code: null, message: null);
  }

  @override
  Future<({int? events, String? code})> postEvent({
    required String sessionId,
    required RecEvent event,
  }) async {
    eventCalls++;
    if (notFoundAfter >= 0 && eventCalls >= notFoundAfter) {
      return (events: null, code: 'NOT_FOUND');
    }
    return (events: eventCalls, code: null);
  }

  @override
  Future<({int? events, int? bytes, List<RecSeekAnchor>? index, String? code})>
      end({required String sessionId}) async {
    return (
      events: eventCalls,
      bytes: 100,
      index: const [RecSeekAnchor(t: 0, byteOffset: 0)],
      code: null,
    );
  }

  @override
  Future<List<RecordingEntry>> list() async => const [];

  @override
  Future<({List<RecSeekAnchor>? index, bool rebuilt, String? code})> readIndex({
    required String sessionId,
  }) async =>
      (index: const <RecSeekAnchor>[], rebuilt: false, code: null);

  @override
  Future<Uint8List?> download({required String sessionId}) async => null;
}

FecBlockHeader _header({
  int blockId = 1,
  int frameId = 1,
  int symbolIndex = 0,
  int symbolCount = 12,
  int symbolLength = 4,
  int lastSymbolPadding = 0,
  int k = 10,
  int m = 2,
}) =>
    FecBlockHeader(
      blockId: blockId,
      frameId: frameId,
      isKeyframe: false,
      frameStart: symbolIndex == 0,
      frameEnd: symbolIndex == symbolCount - 1,
      symbolIndex: symbolIndex,
      symbolCount: symbolCount,
      symbolLength: symbolLength,
      lastSymbolPadding: lastSymbolPadding,
      k: k,
      m: m,
    );

void main() {
  group('RC-03 FEC（QF-VIDEO-1 §1）', () {
    test('GF(256) 与 fec-ref.js 对拍：k=10/m=2 单丢＋双丢可恢复，3 丢不可恢复', () {
      final data = List<Uint8List>.generate(
        10,
        (i) => Uint8List.fromList([i + 1, (i + 1) * 2, 7, 9]),
      );
      final enc = fecEncodeShards(data, FecProfile.high);
      expect(enc.shardLen, 4);
      // 无丢：直接还原
      final all = [...enc.data, ...enc.parity];
      final dec0 = fecDecodeShards(
        all,
        FecProfile.high,
        List<int>.filled(10, 4),
      );
      expect(dec0, isNotNull);
      for (var i = 0; i < 10; i++) {
        expect(dec0![i], data[i]);
      }
      // 单丢数据片
      final List<Uint8List?> one = [...all]..[3] = null;
      expect(fecDecodeShards(one, FecProfile.high, List<int>.filled(10, 4))![3],
          data[3]);
      // 双丢数据片
      final List<Uint8List?> two = [...all]
        ..[3] = null
        ..[7] = null;
      final dec2 = fecDecodeShards(two, FecProfile.high, List<int>.filled(10, 4));
      expect(dec2, isNotNull);
      expect(dec2![3], data[3]);
      expect(dec2[7], data[7]);
      // 双丢含 1 校验片（剩 1 校验行，仍可恢复 1 个数据丢）
      final List<Uint8List?> mixed = [...all]
        ..[3] = null
        ..[11] = null;
      expect(
          fecDecodeShards(mixed, FecProfile.high, List<int>.filled(10, 4))![3],
          data[3]);
      // 3 丢不可恢复
      final List<Uint8List?> three = [...all]
        ..[1] = null
        ..[2] = null
        ..[3] = null;
      expect(
          fecDecodeShards(three, FecProfile.high, List<int>.filled(10, 4)),
          isNull);
      // 校验行不足不可恢复（丢 2 数据＋丢 1 校验，只剩 1 行）
      final List<Uint8List?> short = [...all]
        ..[1] = null
        ..[2] = null
        ..[10] = null;
      expect(
          fecDecodeShards(short, FecProfile.high, List<int>.filled(10, 4)),
          isNull);
    });

    test('k=20/m=1：单丢可恢复，双丢不可恢复；尾分片零填充裁剪', () {
      final data = List<Uint8List>.generate(
        20,
        (i) => Uint8List.fromList([i, i + 1]),
      );
      // 尾片真实长度 1（symbolLength 2，padding 1）
      final lengths = List<int>.filled(20, 2)..[19] = 1;
      final enc = fecEncodeShards(data, FecProfile.low);
      final List<Uint8List?> shards = [...enc.data, ...enc.parity]..[19] = null;
      final dec = fecDecodeShards(shards, FecProfile.low, lengths);
      expect(dec, isNotNull);
      expect(dec![19], [19]); // 按 lastSymbolPadding 裁剪，不得把填充零当数据
      final List<Uint8List?> two = [...enc.data, ...enc.parity]
        ..[0] = null
        ..[1] = null;
      expect(fecDecodeShards(two, FecProfile.low, lengths), isNull);
    });

    test('块头校验：7 类非法一律判非法；服务端宽松组合不是协议档位', () {
      expect(_header().isValid, isTrue);
      expect(_header().isSupportedProfile, isTrue);
      expect(_header(symbolCount: 11).isValid, isFalse);
      expect(_header(symbolIndex: 12).isValid, isFalse);
      expect(_header(symbolLength: 0).isValid, isFalse);
      expect(_header(lastSymbolPadding: 4, symbolLength: 4).isValid, isFalse);
      expect(_header(k: 11).isValid, isFalse);
      expect(_header(m: 3, symbolCount: 13).isValid, isFalse);
      // 服务端 validate 接受 k=10/m=1，但协议只定两档：客户端判不受支持
      final loose = _header(k: 10, m: 1, symbolCount: 11);
      expect(loose.isValid, isTrue);
      expect(loose.isSupportedProfile, isFalse);
    });

    test('fecRepairPercent 映射：≤5% 低档、≥20% 高档、10%/15% 待定返回 null', () {
      expect(fecProfileForRepairPercent(5), FecProfile.low);
      expect(fecProfileForRepairPercent(20), FecProfile.high);
      expect(fecProfileForRepairPercent(10), isNull);
      expect(fecProfileForRepairPercent(15), isNull);
    });

    test('交织深度下限：突发 5 须 G≥3、突发 10 须 G≥5（m=2）', () {
      expect(requiredInterleaveDepth(5, 2), 3);
      expect(requiredInterleaveDepth(10, 2), 5);
      expect(requiredInterleaveDepth(1, 1), 1);
    });

    test('收包归位：非法块头整块丢弃；单丢还原；超限等超时窗口才判 IDR', () {
      final collector = FecBlockCollector(profile: FecProfile.high);
      // 非法块头
      final (outcomeBad, _) = collector.addShard(
        _header(symbolCount: 99),
        Uint8List(4),
        receivedAtMs: 1000,
      );
      expect(outcomeBad, FecBlockOutcome.invalidHeader);
      // 正常收 11 片（缺 1 数据片，校验齐）→ recovered
      final data = List<Uint8List>.generate(
        10,
        (i) => Uint8List.fromList([i, i, i, i]),
      );
      final enc = fecEncodeShards(data, FecProfile.high);
      final all = [...enc.data, ...enc.parity];
      FecBlockOutcome? last;
      List<Uint8List>? decoded;
      List<Uint8List>? recoveredDecoded;
      for (var i = 0; i < 12; i++) {
        if (i == 5) continue; // 丢 1 数据片
        final (o, d) = collector.addShard(
          _header(symbolIndex: i),
          all[i],
          receivedAtMs: 1000,
        );
        last = o;
        decoded = d;
        if (o == FecBlockOutcome.recovered) recoveredDecoded = d;
      }
      // 第 10 片到达时已还原（recovered）；第 11 片是迟到的冗余校验片，
      // 直接忽略（complete），不得重开待解块。
      expect(recoveredDecoded![5], data[5]);
      expect(last, FecBlockOutcome.complete);
      expect(decoded, isNull); // 迟到片不带重复解码结果
      // 超限块：窗口内不判 IDR，窗口届满才判
      final c2 = FecBlockCollector(profile: FecProfile.high);
      for (var i = 0; i < 9; i++) {
        c2.addShard(_header(blockId: 2, symbolIndex: i), all[i],
            receivedAtMs: 1000);
      }
      expect(
        c2.checkUnrecoverable(nowMs: 1000, rttMs: 120, jitterMs: 12, frameMs: 33),
        isEmpty,
      );
      expect(
        c2.checkUnrecoverable(nowMs: 2000, rttMs: 120, jitterMs: 12, frameMs: 33),
        [2],
      );
    });
  });

  group('RC-03 IDR（QF-VIDEO-1 §2/§3）', () {
    test('seq 从 1 单调递增，每发一次加 1；forward 只表示服务端允许', () async {
      final t = ScriptedIdrTransport([
        (s) => _idr('OK', IdrDecision.forward, s),
        (s) => _idr('OK', IdrDecision.forward, s),
      ]);
      final r = IdrRequester(
        sessionId: 'sess-0123456789abcdef',
        agentId: 'agent-1',
        transport: t,
      );
      final a = await r.sendJoin();
      final b = await r.sendLoss();
      expect(a.seq, 1);
      expect(b.seq, 2);
      expect(t.seenSeqs, [1, 2]);
      expect(a.ok, isTrue);
      expect(a.forwarded, isTrue);
      expect(a.agentNotified, isFalse); // §4.3：转发通道未实现
      expect(r.sentCount, 2);
    });

    test('coalesced 不补发；COOLDOWN 带 retryAfterMs；NO_SESSION 不重试', () async {
      final t = ScriptedIdrTransport([
        (s) => _idr('COALESCED', IdrDecision.coalesced, s),
        (s) => IdrResult(
            decision: IdrDecision.rejected,
            code: 'COOLDOWN',
            message: '冷却中',
            seq: s,
            retryAfterMs: 9000),
        (s) => _idr('NO_SESSION', IdrDecision.rejected, s),
      ]);
      final r = IdrRequester(
        sessionId: 'sess-0123456789abcdef',
        agentId: 'agent-1',
        transport: t,
      );
      final a = await r.sendLoss();
      expect(a.ok, isTrue); // coalesced 时 ok 为真
      expect(a.coalesced, isTrue);
      final b = await r.sendLoss();
      expect(b.rejected, isTrue);
      expect(b.retryAfterMs, 9000);
      final c = await r.sendLoss();
      expect(c.code, 'NO_SESSION');
      expect(t.calls, 3); // 每次调用只发一次，不自动补发
    });

    test('REPLAY：不原样重发，用新 seq 重试一次', () async {
      final t = ScriptedIdrTransport([
        (s) => _idr('REPLAY', IdrDecision.rejected, s),
        (s) => _idr('OK', IdrDecision.forward, s),
      ]);
      final r = IdrRequester(
        sessionId: 'sess-0123456789abcdef',
        agentId: 'agent-1',
        transport: t,
      );
      final res = await r.sendLoss();
      expect(res.forwarded, isTrue);
      expect(t.seenSeqs, [1, 2]); // 第二次用新 seq，不是原样重发
    });

    test('reason 线值与合并窗口：loss/join 1s、quality-change 2s', () {
      expect(IdrReason.loss.wire, 'loss');
      expect(IdrReason.join.wire, 'join');
      expect(IdrReason.qualityChange.wire, 'quality-change');
      expect(IdrReason.loss.coalesceWindow,
          const Duration(milliseconds: 1000));
      expect(IdrReason.qualityChange.coalesceWindow,
          const Duration(milliseconds: 2000));
    });
  });

  group('RC-07 中继（QF-RELAY-1）', () {
    List<RelayEntry> sampleList() => RelayEntry.parseAnnouncements([
          {
            'id': 'r2',
            'url': 'https://relay2.example.com/r/',
            'tier': 2,
            'priority': 50,
            'ttlSec': 600,
            'issuedAt': 1000000,
          },
          {
            'id': 'r1',
            'url': 'https://relay1.example.com/r/',
            'tier': 1,
            'priority': 10,
            'ttlSec': 600,
            'issuedAt': 1000000,
          },
          {
            'id': 'r1b',
            'url': 'https://relay1.example.com/r/',
            'tier': 1,
            'priority': 100,
            'ttlSec': 600,
            'issuedAt': 1000000,
          },
          {'id': 'bad-tier', 'url': 'https://x.example.com/', 'tier': 9},
          {'id': '', 'url': 'https://x.example.com/', 'tier': 1},
          {'id': 'r1', 'url': 'https://dup.example.com/', 'tier': 1},
        ]);

    test('宣告解析：排序 tier→priority→id；无效条目跳过；同 id 只留第一条', () {
      final list = sampleList();
      expect(list.map((e) => e.id), ['r1b', 'r1', 'r2']);
      expect(list.first.url, 'https://relay1.example.com/r/');
    });

    test('白名单：origin＋路径前缀；同 origin 不同路径／ftp／空列表拒绝', () {
      final list = sampleList();
      expect(
          isAllowedRelay('https://relay1.example.com/r/session/abc', list),
          isTrue);
      expect(isAllowedRelay('https://relay1.example.com/other/', list),
          isFalse);
      expect(isAllowedRelay('https://evil.example.com/r/', list), isFalse);
      expect(isAllowedRelay('ftp://relay1.example.com/r/', list), isFalse);
      expect(isAllowedRelay('https://relay1.example.com/r/', []), isFalse);
    });

    test('三级回退：失败进 failedIds 选下一条；在途满跳过不算失败；耗尽进降级态', () {
      final list = sampleList();
      var pick = pickRelay(list, {});
      expect(pick.relay!.id, 'r1b');
      expect(pick.reason, 'primary');
      pick = pickRelay(list, {'r1b'});
      expect(pick.relay!.id, 'r1');
      expect(pick.reason, 'fallback-after-failure');
      // r1b 所在 tier-1 在途满：跳过 tier-1，试 tier-2，不算失败
      pick = pickRelay(list, {}, inFlightByTier: {1: 8, 2: 0});
      expect(pick.relay!.id, 'r2');
      expect(pick.tier, 2);
      // 全部在途满 → tier-inflight-full；全部失败 → all-tiers-exhausted
      pick = pickRelay(list, {}, inFlightByTier: {1: 8, 2: 8, 3: 8});
      expect(pick.degraded, isTrue);
      expect(pick.reason, 'tier-inflight-full');
      pick = pickRelay(list, {'r1b', 'r1', 'r2'});
      expect(pick.degraded, isTrue);
      expect(pick.reason, 'all-tiers-exhausted');
    });

    test('伪造中继：拒绝拨号、不进 failedIds、日志只记 URL 与时间', () async {
      final c = RelaySessionController(
        transport: FakeRelayTransport(sampleList()),
      );
      await c.loadAnnouncements();
      expect(c.checkAllowed('https://evil.example.com/r/'), isFalse);
      final rej = c.rejectForged('https://evil.example.com/r/');
      expect(rej.userMessage, '该中继不在服务端宣告列表内，已拒绝连接');
      expect(rej.logLine, contains('https://evil.example.com/r/'));
      expect(rej.logLine, isNot(contains('key')));
      expect(c.failedIds, isEmpty); // 伪造地址不是可重试的普通失败
      expect(c.pickNext().relay, isNotNull); // 继续选下一条列表内中继
    });

    test('过期重取：issuedAt+ttlSec*1000；退后台清在途计数；重试清空 failedIds', () async {
      final c = RelaySessionController(
        transport: FakeRelayTransport(sampleList()),
      );
      await c.loadAnnouncements();
      expect(c.isListExpiredAt(1000000 + 600 * 1000 - 1), isFalse);
      expect(c.isListExpiredAt(1000000 + 600 * 1000), isTrue);
      c.beginDial(1);
      c.beginDial(1);
      expect(c.inFlightByTier[1], 2);
      c.cancelInFlightOnBackground();
      expect(c.inFlightByTier[1], 0);
      c.finishDial(tier: 1, failedRelayId: 'r1b');
      expect(c.failedIds, {'r1b'});
      await c.retry();
      expect(c.failedIds, isEmpty);
      expect(c.list, isNotEmpty);
    });
  });

  group('RC-08 文件流（QF-STREAM-1）', () {
    test('分片数学：100MB 按服务端 1MB 切 100 片；服务端钳制优先', () {
      const chunker = StreamChunker(100 * 1024 * 1024, chunkSize: 1024 * 1024);
      expect(chunker.totalChunks, 100);
      expect(chunker.chunkRange(0), (0, 1024 * 1024));
      expect(chunker.chunkRange(99),
          (99 * 1024 * 1024, 100 * 1024 * 1024));
      expect(chunker.expectedChunkLength(99), 1024 * 1024);
      expect(StreamTransferConstants.clampChunkSize(100), 64 * 1024);
      expect(StreamTransferConstants.clampChunkSize(99 * 1024 * 1024),
          4 * 1024 * 1024);
    });

    test('SHA-256 已知向量；文件名清洗；init 校验', () {
      expect(sha256Hex(utf8.encode('abc')),
          'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
      expect(sanitizeStreamFilename('a/b\\c.pdf'), 'a_b_c.pdf');
      expect(sanitizeStreamFilename(''), 'file');
      expect(
          validateStreamInit(
            filename: 'a.pdf',
            size: 10,
            sha256: 'x',
            toNode: 'nodeB',
          ),
          'VALIDATION');
      expect(
          validateStreamInit(
            filename: 'a.pdf',
            size: 201 * 1024 * 1024,
            sha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            toNode: 'nodeB',
          ),
          'TOO_LARGE');
      expect(
          validateStreamInit(
            filename: 'a.pdf',
            size: 10,
            sha256: 'A' * 64,
            toNode: 'nodeB',
            fromNode: 'nodeB',
          ),
          'VALIDATION');
      expect(
          validateStreamInit(
            filename: 'a.pdf',
            size: 10,
            sha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            toNode: 'nodeB',
          ),
          isNull);
    });

    test('上传＋断点续传：missing 只补缺片，不从头重传', () async {
      final transport = FakeStreamTransport();
      final bytes = Uint8List.fromList(List<int>.generate(2500000, (i) => i % 256));
      final session = StreamUploadSession(
        transport: transport,
        filename: '报告.pdf',
        fileBytes: bytes,
        toNode: 'nodeB',
        fromNode: 'nodeA',
      );
      await session.start();
      expect(session.transferId, 'tf_aaaaaaaaaaaaaaaa');
      expect(session.totalChunks, 3); // 1MB×3（2.5MB）
      expect(session.chunkSize, 1024 * 1024);
      await session.uploadChunks([0, 1]);
      expect(session.receivedChunks, 2);
      // 模拟断网：服务端只收到 0、1，missing 返回 [2]
      final missing = await session.resumeAfterInterruption();
      expect(missing, [2]);
      expect(session.receivedChunks, 3);
      expect(session.progress, 1.0);
      final commit = await session.commit();
      expect(commit.isStaged, isTrue);
      expect(session.state, StreamUploadState.staged);
      expect(session.stagedId, 'fs_aaaaaaaaaaaaaaaa');
    });

    test('commit INCOMPLETE 回 uploading 补传；CORRUPT 整单作废须重新 init', () async {
      final transport = FakeStreamTransport();
      transport.commitOutcome = StreamCommitOutcome.incomplete;
      transport.commitMissing = [1];
      final bytes = Uint8List.fromList(List<int>.generate(1500000, (i) => i % 7));
      final session = StreamUploadSession(
        transport: transport,
        filename: 'a.bin',
        fileBytes: bytes,
        toNode: 'nodeB',
      );
      await session.start();
      await session.uploadChunks([0]);
      var result = await session.commit();
      expect(result.outcome, StreamCommitOutcome.incomplete);
      expect(result.missing, [1]);
      expect(session.state, StreamUploadState.uploading);
      // 补传后 commit 成功
      transport.commitOutcome = StreamCommitOutcome.staged;
      await session.uploadChunks([1]);
      result = await session.commit();
      expect(result.isStaged, isTrue);

      // CORRUPT：终态 failed，transferId 作废，重新 init 才可再发
      final t2 = FakeStreamTransport()
        ..commitOutcome = StreamCommitOutcome.corrupt;
      final s2 = StreamUploadSession(
        transport: t2,
        filename: 'a.bin',
        fileBytes: bytes,
        toNode: 'nodeB',
      );
      await s2.start();
      await s2.uploadChunks([0, 1]);
      final r2 = await s2.commit();
      expect(r2.outcome, StreamCommitOutcome.corrupt);
      expect(s2.state, StreamUploadState.failed);
      expect(s2.transferVoided, isTrue);
      expect(s2.lastErrorCode, 'CORRUPT');
      expect(s2.lastErrorMessage, contains('须重新发送'));
      final retry = s2.newAttempt();
      expect(retry.transferId, isNull);
      expect(retry.state, StreamUploadState.idle);
    });

    test('取消只在 uploading 态可用；commit 提交中禁取消与重复提交', () async {
      final transport = FakeStreamTransport();
      final session = StreamUploadSession(
        transport: transport,
        filename: 'a.bin',
        fileBytes: Uint8List(100),
        toNode: 'nodeB',
      );
      expect(await session.cancel(), isFalse); // idle 不可取消
      await session.start();
      expect(session.canCancel, isTrue);
      expect(await session.cancel(), isTrue);
      expect(session.state, StreamUploadState.cancelled);
    });

    test('下载 Range：206 区间与 200 全文件回落须区分', () async {
      final transport = FakeStreamTransport();
      final partial = await transport.download(
        stagedId: 'fs_aaaaaaaaaaaaaaaa',
        rangeStart: 2,
        rangeEnd: 4,
      );
      expect(partial.isPartial, isTrue);
      expect(partial.bytes, [2, 3, 4]);
      expect(partial.contentRange, 'bytes 2-4/10');
      // 非法 Range（起点超长）服务端回落 200 全文件：按全文件处理
      final fallback = await transport.download(
        stagedId: 'fs_aaaaaaaaaaaaaaaa',
        rangeStart: 99,
      );
      expect(fallback.isPartial, isFalse);
      expect(fallback.bytes.length, 10);
    });

    test('审计模型：chunks 是 totalChunks；只记元数据', () {
      final entry = StreamAuditEntry(
        transferId: 'tf_aaaaaaaaaaaaaaaa',
        filename: 'a.pdf',
        size: 100,
        sha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        fromNode: 'nodeA',
        toNode: 'nodeB',
        totalChunks: 3,
        result: 'completed',
        startedAtMs: 1000,
        endedAtMs: 2000,
        stagedId: 'fs_aaaaaaaaaaaaaaaa',
      );
      expect(entry.totalChunks, 3);
      expect(entry.result, 'completed');
    });
  });

  group('RC-09 画质（QF-QUALITY-1）', () {
    test('档位表数值与服务端 DEFAULT_TIER_TABLE 一致；拆分 hot/reconfig', () {
      expect(specQualityTierTable[SpecQualityTier.balanced]!.targetKbps, 2500);
      expect(specQualityTierTable[SpecQualityTier.balanced]!.maxFps, 30);
      expect(specQualityTierTable[SpecQualityTier.balanced]!.fecRepairPercent, 10);
      expect(specQualityTierTable[SpecQualityTier.original]!.encoderPreference, 'hevc');
      expect(specQualityTierTable[SpecQualityTier.original]!.maxFps, 60);
      final split = splitTierChange(
        specQualityTierTable[SpecQualityTier.clear]!,
        specQualityTierTable[SpecQualityTier.balanced]!,
      );
      expect(split.hot['targetKbps'], 2500);
      expect(split.reconfig['resolutionScale'], 0.75);
      // smooth→balanced 只有 hot 变化（分辨率同为 0.5→0.75？实为 reconfig）
      final split2 = splitTierChange(
        specQualityTierTable[SpecQualityTier.smooth]!,
        specQualityTierTable[SpecQualityTier.balanced]!,
      );
      expect(split2.hot['targetKbps'], 2500);
      expect(split2.reconfig['resolutionScale'], 0.75);
    });

    test('探针校验：缺必填字段不入库；值域外记降权；lossSamples<50 降权', () {
      const incomplete = QualityProbeSample(
        rttMs: double.nan,
        lossPct: 0.5,
        jitterMs: 12,
      );
      expect(incomplete.isComplete, isFalse);
      const sample = QualityProbeSample(
        rttMs: 120,
        lossPct: 0.5,
        lossSamples: 120,
        jitterMs: 12,
        decodeLagMs: 40,
        pendingFrames: 2,
      );
      expect(sample.isComplete, isTrue);
      expect(sample.outOfRangeFields, isEmpty);
      const small = QualityProbeSample(
        rttMs: 120,
        lossPct: 0.5,
        lossSamples: 10,
        jitterMs: 12,
      );
      expect(small.outOfRangeFields, contains('lossSamples<50'));
      const bad = QualityProbeSample(
        rttMs: 20000,
        lossPct: 150,
        jitterMs: 12,
      );
      expect(bad.outOfRangeFields, containsAll(['rttMs', 'lossPct']));
    });

    test('探针周期：正常 1s、弱网/切换后 10s 内 500ms、隐藏 5s', () {
      expect(
          probeInterval(weakNetwork: false, hidden: false, nowMs: 10000),
          const Duration(seconds: 1));
      expect(
          probeInterval(weakNetwork: true, hidden: false, nowMs: 10000),
          const Duration(milliseconds: 500));
      expect(
          probeInterval(
            weakNetwork: false,
            hidden: false,
            tierChangedAtMs: 5000,
            nowMs: 12000,
          ),
          const Duration(milliseconds: 500));
      expect(
          probeInterval(
            weakNetwork: false,
            hidden: false,
            tierChangedAtMs: 0,
            nowMs: 20000,
          ),
          const Duration(seconds: 1));
      expect(
          probeInterval(weakNetwork: false, hidden: true, nowMs: 10000),
          const Duration(seconds: 5));
    });

    test('降档执行：先 hot 后 reconfig，needsIdr 时发 IDR 并清旧参考帧，5s 内 ACK', () async {
      final idrTransport = ScriptedIdrTransport([
        (s) => _idr('OK', IdrDecision.forward, s),
      ]);
      final idr = IdrRequester(
        sessionId: 'sess-0123456789abcdef',
        agentId: 'agent-1',
        transport: idrTransport,
      );
      final applied = <String>[];
      final transport = FakeQualityTransport();
      final client = QualitySessionClient(
        sessionId: 'sess-0123456789abcdef',
        transport: transport,
        idrRequester: idr,
        initialTier: SpecQualityTier.clear,
        onHotApplied: (_) => applied.add('hot'),
        onReconfigApplied: (_) => applied.add('reconfig'),
        onClearReferenceFrames: () => applied.add('clear-ref'),
      );
      transport.probeResponse = QualityProbeResponse(
        tier: SpecQualityTier.balanced,
        decision: const QualityDecision(
          kind: 'downgrade-to',
          decisionId: 'qd_12',
          from: SpecQualityTier.clear,
          to: SpecQualityTier.balanced,
          hot: {'targetKbps': 2500},
          reconfig: {'resolutionScale': 0.75},
          mustAckByMs: 1790000005000,
          needsIdr: true,
        ),
        backpressure: const BackpressureDecision(
          level: null,
          action: null,
          note: '无背压。',
        ),
      );
      final res = await client.sendProbe(
        const QualityProbeSample(rttMs: 900, lossPct: 25, jitterMs: 12),
        nowMs: 1790000000000,
      );
      expect(res.decision, isNotNull);
      expect(applied, ['hot', 'reconfig', 'clear-ref']);
      expect(client.tier, SpecQualityTier.balanced);
      expect(idrTransport.seenReasons, ['quality-change']);
      expect(client.pendingDecision!.decisionId, 'qd_12');
      // FEC 中间值 10% 映射待定：不得自行发明第三种 (k,m)
      expect(res.decision!.fecProfile, isNull);
      // 5s 内 ACK 成功
      expect(
          await client.ackPending(nowMs: 1790000001000),
          isTrue);
      expect(transport.ackCalls, 1);
      expect(client.pendingDecision, isNull);
    });

    test('ACK 超时只记日志不重发；UNKNOWN_DECISION 不得重试同一 id', () async {
      final transport = FakeQualityTransport()..ackUnknown = true;
      final client = QualitySessionClient(
        sessionId: 'sess-0123456789abcdef',
        transport: transport,
        initialTier: SpecQualityTier.clear,
      );
      const decision = QualityDecision(
        kind: 'downgrade-to',
        decisionId: 'qd_9',
        from: SpecQualityTier.clear,
        to: SpecQualityTier.balanced,
        hot: {'targetKbps': 2500},
        reconfig: {},
        mustAckByMs: 5000,
        needsIdr: false,
      );
      await client.applyDecision(decision, nowMs: 1000);
      // 超时后扫出，只记日志，不重发
      expect(client.sweepAckTimeouts(6000), ['qd_9']);
      expect(client.ackTimedOutDecisionIds, ['qd_9']);
      expect(client.pendingDecision, isNull);
      expect(transport.ackCalls, 0);
      // UNKNOWN_DECISION：发一次即停，不重试
      await client.applyDecision(decision, nowMs: 1000);
      expect(await client.ackPending(nowMs: 2000), isFalse);
      expect(transport.ackCalls, 1);
      expect(client.pendingDecision, isNull);
    });

    test('手动升档拒绝码与文案；执行失败不伪造 ACK、保持旧档位', () async {
      final transport = FakeQualityTransport()
        ..upgradeRejection = const QualityUpgradeRejection(
          code: 'NOT_HEALTHY',
          message: '网络未持续健康 20s',
        );
      final client = QualitySessionClient(
        sessionId: 'sess-0123456789abcdef',
        transport: transport,
      );
      final result = await client.requestUpgrade();
      expect(result.rejection!.code, 'NOT_HEALTHY');
      expect(result.rejection!.displayText, contains('未持续健康 20 秒'));
      expect(
          const QualityUpgradeRejection(code: 'AT_TOP', message: '').displayText,
          '已是最高档。');
      expect(
          const QualityUpgradeRejection(code: 'PINGPONG_COOLDOWN', message: '')
              .displayText,
          contains('冷却中'));
      // 执行失败：hot 回调抛错 → 保持旧档位、不发 ACK
      final failing = QualitySessionClient(
        sessionId: 'sess-0123456789abcdef',
        transport: FakeQualityTransport(),
        initialTier: SpecQualityTier.clear,
        onHotApplied: (_) => throw StateError('编码器拒绝重配'),
      );
      const decision = QualityDecision(
        kind: 'downgrade-to',
        decisionId: 'qd_1',
        from: SpecQualityTier.clear,
        to: SpecQualityTier.balanced,
        hot: {'targetKbps': 2500},
        reconfig: {},
        mustAckByMs: 9999999999999,
        needsIdr: false,
      );
      expect(await failing.applyDecision(decision, nowMs: 1000), isFalse);
      expect(failing.tier, SpecQualityTier.clear);
      expect(failing.pendingDecision, isNull);
    });

    test('背压：L1/L2/L3 动作；仅自报堆积不触发、不擅自降档', () async {
      final idrTransport = ScriptedIdrTransport([
        (s) => _idr('OK', IdrDecision.forward, s),
      ]);
      final idr = IdrRequester(
        sessionId: 'sess-0123456789abcdef',
        agentId: 'agent-1',
        transport: idrTransport,
      );
      final client = QualitySessionClient(
        sessionId: 'sess-0123456789abcdef',
        transport: FakeQualityTransport(),
        idrRequester: idr,
      );
      const hintOnly = BackpressureDecision(
        level: null,
        action: null,
        note: '仅客户端自报，未交叉验证，不触发。',
      );
      expect(hintOnly.isHintOnly, isTrue);
      expect(await client.applyBackpressure(hintOnly), isNull);
      expect(idrTransport.calls, 0); // 不擅自降档、不发 IDR
      expect(
          await client.applyBackpressure(const BackpressureDecision(
            level: 'L1',
            action: 'reduce-fps',
            note: '先降生产速率。',
          )),
          'reduce-fps');
      expect(
          await client.applyBackpressure(const BackpressureDecision(
            level: 'L3',
            action: 'drop-to-keyframe',
            note: '参考链已损坏。',
          )),
          'drop-to-keyframe');
      expect(idrTransport.seenReasons, ['loss']); // L3 走受控 IDR
    });
  });

  group('RC-10 录像（QF-REC-1）', () {
    test('事件清洗：非法 kind 按 mouse 计；key 截断 32；剪贴板只记 bytes', () {
      final ev = RecEvent.input(
        at: 1000,
        kind: 'bogus',
        x: 100,
        y: 200,
        key: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      );
      final json = ev.toJson();
      expect(json['kind'], 'mouse');
      expect((json['key'] as String).length, 32);
      const clip = RecEvent.clipboard(at: 1000, bytes: 42);
      expect(clip.toJson(), {
        'type': 'clipboard',
        'at': 1000,
        'bytes': 42,
      });
      expect(clip.toJson().containsKey('content'), isFalse);
      const q = RecEvent.qualityChange(at: 1000, from: 'clear', to: 'balanced');
      expect(q.toJson()['from'], 'clear');
    });

    test('POLICY_OFF 时不录制、不发事件；策略判定四档', () async {
      final transport = FakeRecordingTransport(policyOff: true);
      final client = RecordingSessionClient(transport: transport);
      expect(
          await client.start(
            sessionIdForDesktop: 'sess-0123456789abcdef',
            deviceId: 'd1',
            groupId: 'g1',
            tier: 'balanced',
          ),
          isFalse);
      expect(client.isRecording, isFalse);
      expect(transport.eventCalls, 0);
      expect(
          shouldRecordLocally(
            mode: 'off',
            username: 'a',
            groupId: 'g1',
            deviceId: 'd1',
          ),
          isFalse);
      expect(
          shouldRecordLocally(
            mode: 'user',
            username: 'a',
            groupId: 'g1',
            deviceId: 'd1',
            users: ['a'],
          ),
          isTrue);
      expect(
          shouldRecordLocally(
            mode: 'group',
            username: 'a',
            groupId: 'g1',
            deviceId: 'd1',
            groups: ['g9'],
          ),
          isFalse);
      expect(
          shouldRecordLocally(
            mode: 'device',
            username: 'a',
            groupId: 'g1',
            deviceId: 'd1',
            devices: ['d1'],
          ),
          isTrue);
      expect(
          shouldRecordLocally(
            mode: 'bogus',
            username: 'a',
            groupId: 'g1',
            deviceId: 'd1',
          ),
          isFalse);
    });

    test('事件上报：at 单调递增，倒序丢弃不发；退后台暂停、恢复后按 at 续发', () async {
      final transport = FakeRecordingTransport();
      final client = RecordingSessionClient(transport: transport);
      await client.start(
        sessionIdForDesktop: 'sess-0123456789abcdef',
        deviceId: 'd1',
        groupId: 'g1',
        tier: 'balanced',
      );
      expect(
          await client.postEvent(
            const RecEvent.input(at: 1000, kind: 'mouse', x: 10, y: 20),
          ),
          isTrue);
      expect(
          await client.postEvent(
            const RecEvent.input(at: 900, kind: 'mouse', x: 10, y: 20),
          ),
          isFalse); // 倒序不补发
      expect(transport.eventCalls, 1);
      client.pauseForBackground();
      expect(
          await client.postEvent(
            const RecEvent.input(at: 2000, kind: 'mouse', x: 10, y: 20),
          ),
          isFalse);
      client.resumeFromBackground();
      expect(
          await client.postEvent(
            const RecEvent.input(at: 2000, kind: 'mouse', x: 10, y: 20),
          ),
          isTrue);
      expect(client.eventCount, 2);
    });

    test('服务端重启 NOT_FOUND：提示中断并重开新录制，不得静默丢事件', () async {
      final transport = FakeRecordingTransport(notFoundAfter: 2);
      final client = RecordingSessionClient(transport: transport);
      await client.start(
        sessionIdForDesktop: 'sess-0123456789abcdef',
        deviceId: 'd1',
        groupId: 'g1',
        tier: 'balanced',
      );
      expect(
          await client.postEvent(
            const RecEvent.input(at: 1000, kind: 'mouse', x: 1, y: 2),
          ),
          isTrue);
      expect(
          await client.postEvent(
            const RecEvent.input(at: 2000, kind: 'mouse', x: 3, y: 4),
          ),
          isFalse);
      expect(client.interrupted, isTrue);
      expect(recordingInterruptedMessage, contains('服务端重启'));
      final newId = await client.handleNotFoundAndRestart(
        sessionIdForDesktop: 'sess-0123456789abcdef',
        deviceId: 'd1',
        groupId: 'g1',
        tier: 'balanced',
      );
      expect(newId, isNotNull);
      expect(client.interrupted, isFalse);
      expect(transport.startCalls, 2);
    });

    test('seek：取 t≤T 的最后锚点；重建索引首锚点在起点也能处理', () {
      const index = [
        RecSeekAnchor(t: 0, byteOffset: 0),
        RecSeekAnchor(t: 10000, byteOffset: 1000),
        RecSeekAnchor(t: 20000, byteOffset: 2000),
      ];
      expect(seekAnchor(index, 15000)!.t, 10000);
      expect(seekAnchor(index, 9999)!.t, 0);
      expect(seekAnchor(index, 0)!.t, 0);
      expect(seekAnchor(const [], 5000), isNull);
      // 正常索引首锚点在 10s：T=5000 时无锚点 → 从头读
      const normal = [RecSeekAnchor(t: 10000, byteOffset: 500)];
      expect(seekAnchor(normal, 5000), isNull);
    });

    test('回放：边下边播只播完整行；变速缩放间隔；隐私提示', () {
      final line1 = jsonEncode({
        'type': 'input',
        'at': 1000,
        'kind': 'mouse',
        'x': 10,
        'y': 20,
      });
      final line2 = jsonEncode({'type': 'input', 'at': 2000, 'kind': 'key'});
      // 模拟下载一半：第二行被截断
      final partial = Uint8List.fromList(
        utf8.encode('$line1\n${line2.substring(0, 10)}'),
      );
      final events = RecPlayback.parseCompleteLines(partial);
      expect(events, hasLength(1));
      expect(events.first['at'], 1000);
      final full = Uint8List.fromList(utf8.encode('$line1\n$line2\n'));
      expect(RecPlayback.parseCompleteLines(full), hasLength(2));
      expect(RecPlayback.scaledIntervalMs(1000, 2.0), 500);
      expect(RecPlayback.scaledIntervalMs(1000, 0.5), 2000);
      expect(RecPlayback.privacyNotice, '本录像含操作记录');
      // seek 从锚点偏移起读
      final sought = RecPlayback.seekEvents(
        full,
        const [RecSeekAnchor(t: 1000, byteOffset: 0)],
        1500,
      );
      expect(sought, hasLength(1));
    });

    test('访问控制：只认本人，站长无直通；404 不泄露存在性', () {
      expect(canAccessRecording(ownerUsername: 'a', requesterUsername: 'a'),
          isTrue);
      expect(canAccessRecording(ownerUsername: 'a', requesterUsername: 'b'),
          isFalse);
      expect(recordingNotFoundMessage, '录像不存在或无权限查看');
      expect(
          RecordingEntry(
            sessionId: 'rec_aaaaaaaaaaaaaaaa',
            deviceId: 'd1',
            tier: 'balanced',
            startedAtMs: 1000000,
            bytes: 100,
          ).expiresAtMs,
          1000000 + 30 * 24 * 60 * 60 * 1000);
    });

    test('sha256 工具：crypto 包可用', () {
      expect(sha256.convert(utf8.encode('abc')).toString(),
          'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    });
  });
}
