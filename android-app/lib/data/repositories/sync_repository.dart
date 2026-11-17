import 'dart:async';
import 'dart:convert';

import 'package:drift/drift.dart';
import 'package:flutter/foundation.dart';

import '../db/app_database.dart';
import '../services/api_client.dart';

/// 离线发件箱排空（A-05，Invoice Ninja v2 `SyncRepository.drainOnce` 模式）：
/// 写操作先落 Drift 立即回显，再进 outbox 按公司/实体严格 FIFO 排空。
///
/// 重试退避：5s → 30s → 2m → 10m；5 次后进死信（`dead`），由“待同步”界面
/// 人工处理，不静默丢弃。
/// - 422（服务端拒收的脏数据）直接进死信，不重试。
/// - 409（冲突）走 [onConflict] 回调，由调用方弹冲突解决表。
/// - 412（须重新确认密码）走 [onReauthRequired] 回调，弹一次密码确认表。
/// - 2xx 即成功；其余 4xx/5xx/网络错按退避重试。
/// 幂等键：每条写操作生成一次永不改，服务端去重用；重试不产生重复写入。
class SyncRepository {
  SyncRepository(
    this._db,
    this._transport, {
    this.onConflict,
    this.onReauthRequired,
  });

  final QfDatabase _db;

  /// 发件箱上行通道（可整体重建的网络层注入，见 A-06）。
  final OutboxTransport _transport;

  static const List<Duration> backoff = [
    Duration(seconds: 5),
    Duration(seconds: 30),
    Duration(minutes: 2),
    Duration(minutes: 10),
  ];

  /// 最大尝试次数：达到即死信。
  static const int maxAttempts = 5;

  /// 409 冲突回调：调用方弹冲突解决表，本条进死信，不再重试。
  ValueChanged<OutboxEntry>? onConflict;

  /// 412 回调：调用方弹一次密码确认表，本条进死信，不再重试。
  ValueChanged<OutboxEntry>? onReauthRequired;

  /// 仅测试用：读库断言（生产代码不许调）。
  @visibleForTesting
  QfDatabase get dbForTest => _db;

  /// 把一次写操作写入发件箱（先落库，UI 立即刷新由 Repository 层完成）。
  /// 返回幂等键。
  Future<String> enqueueMutation({
    required String entityKind,
    required String entityId,
    required String op,
    required Map<String, Object?> payload,
  }) async {
    final key =
        'mut_${DateTime.now().microsecondsSinceEpoch}_${entityId.hashCode.abs()}';
    await _db.enqueueOutbox(OutboxEntriesCompanion(
      entityKind: Value(entityKind),
      entityId: Value(entityId),
      op: Value(op),
      payloadJson: Value(jsonEncode(payload)),
      idempotencyKey: Value(key),
    ));
    return key;
  }

  /// 排空一次：按 FIFO 逐条发，遇网络错即停（保序，不跳过失败条目继续发）。
  /// 每条发送前按 id 重读（前一条的 id_remap 改写可能已改了本条的引用）。
  /// 返回本次处理结果摘要。
  Future<DrainResult> drainOnce() async {
    final pending = await _db.pendingOutbox();
    var sent = 0;
    var dead = 0;
    var stoppedOnError = false;
    for (final entry in pending) {
      final fresh = await _db.outboxById(entry.id) ?? entry;
      final outcome = await _sendOne(fresh);
      switch (outcome) {
        case _SendOutcome.sent:
          sent++;
        case _SendOutcome.dead:
          dead++;
        case _SendOutcome.stop:
          stoppedOnError = true;
      }
      if (stoppedOnError) break;
    }
    return DrainResult(
        sent: sent, dead: dead, remaining: pending.length - sent - dead);
  }

  Future<_SendOutcome> _sendOne(OutboxEntry entry) async {
    OutboxResult result;
    try {
      result = await _transport.send(entry);
    } catch (_) {
      result = const OutboxResult.networkError();
    }
    switch (result.kind) {
      case OutboxResultKind.success:
        await _db.deleteOutbox(entry.id);
        // 服务端回了正式 ID：记 id_remap 并改写其余待发条目里的临时 ID 引用。
        final realId = result.realId;
        if (realId != null && entry.entityId.startsWith('tmp_')) {
          await _db.recordIdRemap(entry.entityId, realId);
          await _db.rewriteTmpIdRefs(entry.entityId, realId);
        }
        return _SendOutcome.sent;
      case OutboxResultKind.unprocessable:
        await _markDead(entry);
        return _SendOutcome.dead;
      case OutboxResultKind.conflict:
        if (onConflict != null) {
          onConflict!(entry);
          await _markDead(entry);
          return _SendOutcome.dead;
        }
        return _retryOrDead(entry);
      case OutboxResultKind.reauthRequired:
        if (onReauthRequired != null) {
          onReauthRequired!(entry);
          await _markDead(entry);
          return _SendOutcome.dead;
        }
        return _retryOrDead(entry);
      case OutboxResultKind.networkError:
      case OutboxResultKind.serverError:
        return _retryOrDead(entry);
    }
  }

  Future<_SendOutcome> _retryOrDead(OutboxEntry entry) async {
    final attempts = entry.attempts + 1;
    if (attempts >= maxAttempts) {
      await _markDead(entry, attempts: attempts);
      return _SendOutcome.dead;
    }
    final delay = backoff[(attempts - 1).clamp(0, backoff.length - 1)];
    await _db.updateOutbox(OutboxEntriesCompanion(
      id: Value(entry.id),
      attempts: Value(attempts),
      nextAttemptAt: Value(DateTime.now().add(delay)),
    ));
    return _SendOutcome.stop;
  }

  Future<void> _markDead(OutboxEntry entry, {int? attempts}) =>
      _db.updateOutbox(OutboxEntriesCompanion(
        id: Value(entry.id),
        status: const Value('dead'),
        attempts:
            attempts == null ? const Value.absent() : Value(attempts),
      ));

  /// 死信条目（待同步界面人工处理用）。
  Future<List<OutboxEntry>> deadLetters() => _db.deadOutbox();

  /// 人工重试一条死信：状态回 pending、次数清零、立即排空。
  Future<void> retryDead(int id) async {
    await _db.updateOutbox(OutboxEntriesCompanion(
      id: Value(id),
      status: const Value('pending'),
      attempts: const Value(0),
      nextAttemptAt: Value(DateTime.now()),
    ));
    await drainOnce();
  }
}

enum _SendOutcome { sent, dead, stop }

class DrainResult {
  final int sent;
  final int dead;
  final int remaining;
  const DrainResult(
      {required this.sent, required this.dead, required this.remaining});
}
