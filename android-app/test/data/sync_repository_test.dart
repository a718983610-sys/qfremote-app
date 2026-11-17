import 'package:drift/drift.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:qfremote/data/db/app_database.dart';
import 'package:qfremote/data/repositories/sync_repository.dart';
import 'package:qfremote/data/services/api_client.dart';

/// 按预设结果序列回放的假通道。
class ScriptedTransport implements OutboxTransport {
  ScriptedTransport(this.script);

  final List<OutboxResult> script;
  final sent = <OutboxEntry>[];
  var calls = 0;

  @override
  Future<OutboxResult> send(OutboxEntry entry) async {
    sent.add(entry);
    final r = calls < script.length ? script[calls] : script.last;
    calls++;
    return r;
  }
}

Future<SyncRepository> _repo(ScriptedTransport t) async {
  final db = QfDatabase.memory();
  return SyncRepository(db, t);
}

Future<void> _enqueue(SyncRepository repo, String entityId) =>
    repo.enqueueMutation(
      entityKind: 'device',
      entityId: entityId,
      op: 'rename',
      payload: {'nodeId': entityId, 'name': '新名'},
    );

void main() {
  // 每个用例各建一个内存库：关掉 drift 的多库警告（测试隔离使然，非生产问题）。
  driftRuntimeOptions.dontWarnAboutMultipleDatabases = true;
  group('SyncRepository.drainOnce', () {
    test('成功即删条目，不留残', () async {
      final t = ScriptedTransport([const OutboxResult.success()]);
      final repo = await _repo(t);
      await _enqueue(repo, 'n1');
      final r = await repo.drainOnce();
      expect(r.sent, 1);
      expect(r.remaining, 0);
      expect(t.calls, 1);
    });

    test('严格 FIFO：先入先发，网络错即停不跳过', () async {
      final t = ScriptedTransport([
        const OutboxResult.success(),
        const OutboxResult.networkError(),
        const OutboxResult.success(),
      ]);
      final repo = await _repo(t);
      await _enqueue(repo, 'n1');
      await _enqueue(repo, 'n2');
      await _enqueue(repo, 'n3');
      final r = await repo.drainOnce();
      expect(r.sent, 1);
      expect(t.sent.map((e) => e.entityId).toList(), ['n1', 'n2']);
      expect(t.calls, 2); // 第三条没发
    });

    test('422 直接进死信，不重试', () async {
      final t = ScriptedTransport([const OutboxResult.unprocessable()]);
      final repo = await _repo(t);
      await _enqueue(repo, 'n1');
      final r = await repo.drainOnce();
      expect(r.dead, 1);
      expect(await repo.deadLetters(), hasLength(1));
    });

    test('409 走冲突回调并进死信', () async {
      final t = ScriptedTransport([const OutboxResult.conflict()]);
      final db = QfDatabase.memory();
      var conflicted = 0;
      final repo = SyncRepository(db, t,
          onConflict: (_) => conflicted++);
      await _enqueue(repo, 'n1');
      final r = await repo.drainOnce();
      expect(r.dead, 1);
      expect(conflicted, 1);
    });

    test('412 走密码确认回调并进死信', () async {
      final t = ScriptedTransport([const OutboxResult.reauthRequired()]);
      final db = QfDatabase.memory();
      var reauth = 0;
      final repo = SyncRepository(db, t,
          onReauthRequired: (_) => reauth++);
      await _enqueue(repo, 'n1');
      final r = await repo.drainOnce();
      expect(r.dead, 1);
      expect(reauth, 1);
    });

    test('网络错退避重试：5 次后进死信', () async {
      final t = ScriptedTransport(
          List.filled(10, const OutboxResult.networkError()));
      final repo = await _repo(t);
      await _enqueue(repo, 'n1');
      final db = repo.dbForTest;
      for (var i = 0; i < 4; i++) {
        final r = await repo.drainOnce();
        expect(r.dead, 0);
        // 每次失败后退避时间未到，须把重试时间拨回过去才能触发下一次尝试
        // （生产里由时间自然流逝触发，这里拨表模拟）。
        final rows = await db.allOutboxForTest();
        expect(rows.single.attempts, i + 1);
        await db.setNextAttemptForTest(
            rows.single.id, DateTime.now());
      }
      final r = await repo.drainOnce();
      expect(r.dead, 1);
      expect((await repo.deadLetters()).single.attempts, 5);
    });

    test('服务端回正式 ID：记 id_remap 并改写其余待发条目引用', () async {
      final t = ScriptedTransport([
        const OutboxResult.success(realId: 'node-real'),
        const OutboxResult.success(),
      ]);
      final repo = await _repo(t);
      await repo.enqueueMutation(
        entityKind: 'device_note',
        entityId: 'tmp_1',
        op: 'create',
        payload: {'nodeId': 'n1', 'note': 'x', 'tmpId': 'tmp_1'},
      );
      await repo.enqueueMutation(
        entityKind: 'device_note',
        entityId: 'tmp_1',
        op: 'update',
        payload: {'ref': 'tmp_1', 'note': 'y'},
      );
      final r = await repo.drainOnce();
      expect(r.sent, 2);
      expect(t.sent[1].entityId, 'node-real');
      expect(t.sent[1].payloadJson.contains('node-real'), isTrue);
      expect(t.sent[1].payloadJson.contains('tmp_1'), isFalse);
    });

    test('死信人工重试：状态回 pending、次数清零', () async {
      final t = ScriptedTransport([
        const OutboxResult.unprocessable(),
        const OutboxResult.success(),
      ]);
      final repo = await _repo(t);
      await _enqueue(repo, 'n1');
      await repo.drainOnce();
      final dead = await repo.deadLetters();
      expect(dead, hasLength(1));
      await repo.retryDead(dead.single.id);
      expect(await repo.deadLetters(), isEmpty);
      expect(t.calls, 2);
    });
  });

  group('OutboxResult.fromStatus', () {
    test('状态码映射口径', () {
      expect(OutboxResult.fromStatus(200).kind, OutboxResultKind.success);
      expect(OutboxResult.fromStatus(201).kind, OutboxResultKind.success);
      expect(
          OutboxResult.fromStatus(422).kind, OutboxResultKind.unprocessable);
      expect(OutboxResult.fromStatus(409).kind, OutboxResultKind.conflict);
      expect(OutboxResult.fromStatus(412).kind,
          OutboxResultKind.reauthRequired);
      expect(
          OutboxResult.fromStatus(500).kind, OutboxResultKind.serverError);
      expect(
          OutboxResult.fromStatus(400).kind, OutboxResultKind.networkError);
    });
  });
}
