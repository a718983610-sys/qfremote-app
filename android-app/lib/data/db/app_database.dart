import 'dart:io';

import 'package:drift/drift.dart';
import 'package:drift/native.dart';
import 'package:flutter/foundation.dart';
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';
import 'package:sqlite3_flutter_libs/sqlite3_flutter_libs.dart';

import 'tables.dart';

part 'app_database.g.dart';

/// A-05：Drift 单一事实源。UI 只订阅这里的流，网络层只写这里，绝不直喂 UI。
///
/// 打开方式：生产用应用文档目录下的 `qfremote.db`；测试用
/// [QfDatabase.memory]（内存库，不碰文件系统）。
@DriftDatabase(tables: [Devices, OutboxEntries, IdRemaps])
class QfDatabase extends _$QfDatabase {
  QfDatabase(super.e);

  /// 生产打开：须先调一次（sqlite3_flutter_libs 要求 Android 侧初始化）。
  static Future<QfDatabase> open() async {
    await applyWorkaroundToOpenSqlite3OnOldAndroidVersions();
    final dir = await getApplicationDocumentsDirectory();
    final file = File(p.join(dir.path, 'qfremote.db'));
    return QfDatabase(NativeDatabase(file));
  }

  /// 测试/内存打开。
  factory QfDatabase.memory() => QfDatabase(NativeDatabase.memory());

  @override
  int get schemaVersion => 1;

  // ---- 设备 ----
  Stream<List<Device>> watchDevices() =>
      (select(devices)..orderBy([(d) => OrderingTerm.asc(d.name)])).watch();

  Future<List<Device>> allDevices() =>
      (select(devices)..orderBy([(d) => OrderingTerm.asc(d.name)])).get();

  Future<Device?> deviceByNodeId(String nodeId) => (select(
    devices,
  )..where((d) => d.nodeId.equals(nodeId))).getSingleOrNull();

  Future<void> upsertDevice(DevicesCompanion row) => into(devices).insert(
    row,
    // 冲突目标是 nodeId 唯一键（不是自增主键 id）：同一设备重复
    // 上报时更新行，而不是因 node_id 唯一约束抛错。
    onConflict: DoUpdate((_) => row, target: [devices.nodeId]),
  );

  Future<void> markDeviceDirty(String nodeId, bool dirty) =>
      (update(devices)..where((d) => d.nodeId.equals(nodeId))).write(
        DevicesCompanion(isDirty: Value(dirty)),
      );

  /// 删除对账（第 2 轮 #8）：删掉不在 [nodeIds] 里的本地设备行。
  /// 脏行（isDirty＝true，有未同步的本地改名／分组）一律保留——
  /// 删了会丢用户还没同步的改动；脏行由服务端刷新回写后清标记，
  /// 或由发件箱排空后自然解决。
  /// [nodeIds] 为空＝服务端明确说零设备：删全部干净行。
  Future<void> deleteDevicesNotIn(Set<String> nodeIds) async {
    if (nodeIds.isEmpty) {
      await (delete(devices)..where((d) => d.isDirty.equals(false))).go();
      return;
    }
    await (delete(
      devices,
    )..where((d) => d.nodeId.isNotIn(nodeIds) & d.isDirty.equals(false))).go();
  }

  // ---- 发件箱 ----
  Future<int> enqueueOutbox(OutboxEntriesCompanion row) =>
      into(outboxEntries).insert(row);

  /// 取出下一批待发条目（严格 FIFO：按创建时间升序，只取已到重试时间的）。
  Future<List<OutboxEntry>> pendingOutbox({int limit = 20}) =>
      (select(outboxEntries)
            ..where(
              (o) =>
                  o.status.equals('pending') &
                  o.nextAttemptAt.isSmallerOrEqualValue(DateTime.now()),
            )
            ..orderBy([(o) => OrderingTerm.asc(o.createdAt)])
            ..limit(limit))
          .get();

  /// 按 id 重读一条（排空循环内用：前一条的 id_remap 改写可能已改了本条的
  /// 引用，须读新鲜值再发，不许发循环开始时取到的旧快照）。
  Future<OutboxEntry?> outboxById(int id) =>
      (select(outboxEntries)..where((o) => o.id.equals(id))).getSingleOrNull();

  Future<void> updateOutbox(OutboxEntriesCompanion row) => (update(
    outboxEntries,
  )..where((o) => o.id.equals(row.id.value))).write(row);

  Future<void> deleteOutbox(int id) =>
      (delete(outboxEntries)..where((o) => o.id.equals(id))).go();

  Future<List<OutboxEntry>> deadOutbox() =>
      (select(outboxEntries)
            ..where((o) => o.status.equals('dead'))
            ..orderBy([(o) => OrderingTerm.asc(o.createdAt)]))
          .get();

  /// 以下仅测试用：排空退避时间的拨动与全量读出（生产代码不许调）。
  @visibleForTesting
  Future<List<OutboxEntry>> allOutboxForTest() => select(outboxEntries).get();

  @visibleForTesting
  Future<void> setNextAttemptForTest(int id, DateTime at) =>
      (update(outboxEntries)..where((o) => o.id.equals(id))).write(
        OutboxEntriesCompanion(nextAttemptAt: Value(at)),
      );

  /// 把待发载荷里的临时 ID 引用全部改写为正式 ID（id_remap 落地后）。
  /// 不用 SQL LIKE（tmpId 含 `_`，在 LIKE 里是通配符会误匹配）：全量读出后
  /// 在 Dart 侧做精确子串判断。
  Future<void> rewriteTmpIdRefs(String tmpId, String realId) async {
    final rows = await select(outboxEntries).get();
    for (final row in rows) {
      if (!row.payloadJson.contains(tmpId) && row.entityId != tmpId) {
        continue;
      }
      final rewritten = row.payloadJson.replaceAll(tmpId, realId);
      final entityId = row.entityId == tmpId ? realId : row.entityId;
      await (update(outboxEntries)..where((o) => o.id.equals(row.id))).write(
        OutboxEntriesCompanion(
          payloadJson: Value(rewritten),
          entityId: Value(entityId),
        ),
      );
    }
  }

  // ---- ID 映射 ----
  Future<void> recordIdRemap(String tmpId, String realId) =>
      into(idRemaps).insert(
        IdRemapsCompanion(tmpId: Value(tmpId), realId: Value(realId)),
        mode: InsertMode.insertOrIgnore,
      );

  Future<String?> resolveTmpId(String tmpId) async {
    final row = await (select(
      idRemaps,
    )..where((r) => r.tmpId.equals(tmpId))).getSingleOrNull();
    return row?.realId;
  }

  /// 退出清库（A-05 接线硬门槛）：删掉全部本地设备／发件箱／ID 映射行，
  /// 防止跨账号残留。表结构不动；重复调用无副作用。
  Future<void> clearAllData() async {
    await delete(devices).go();
    await delete(outboxEntries).go();
    await delete(idRemaps).go();
  }
}
