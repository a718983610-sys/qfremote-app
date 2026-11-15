import 'dart:async';
import 'dart:convert';

import 'package:drift/drift.dart';
import 'package:flutter/foundation.dart';

import '../db/app_database.dart';
import 'sync_repository.dart';

/// 设备仓库（A-05）：设备实体单一事实源。
///
/// - 读：只从 Drift 流读（[watchDevices]），网络只写库，绝不直喂 UI。
/// - 写：改名/分组先落本地库立即回显（`isDirty = true`），再进 outbox 排队。
/// - 离线新建：本地先用 `tmp_<uuid>` 占位，服务端回正式 ID 后经 id_remap
///   改写引用，打开的详情页不跳 URL（Invoice Ninja v2 同款语义）。
class DeviceRepository extends ChangeNotifier {
  DeviceRepository(this._db, this._sync);

  final QfDatabase _db;
  final SyncRepository _sync;

  Stream<List<DeviceInfo>> watchDevices() => _db.watchDevices().map(
    (list) => list.map(DeviceInfo.fromDevice).toList(),
  );

  Future<List<DeviceInfo>> allDevices() async {
    final rows = await _db.allDevices();
    return rows.map(DeviceInfo.fromDevice).toList();
  }

  /// 服务端下发的设备列表写入本地库（以 nodeId 为键的 upsert）。
  /// 入参是服务端全量：写完后做删除对账（#8）——本地有、服务端没
  /// 有的干净行删掉；脏行（本地未同步改动）保留。
  /// 调用方只在取数成功后调本方法；取数失败不得拿空列表调（会误删）。
  Future<void> refreshFromServer(List<DeviceInfo> infos) async {
    for (final info in infos) {
      await _db.upsertDevice(
        DevicesCompanion(
          nodeId: Value(info.nodeId),
          name: Value(info.name),
          os: Value(info.os),
          groupName: Value(info.groupName),
          online: Value(info.online),
          lastSeen: Value(info.lastSeen),
          isDirty: const Value(false),
        ),
      );
    }
    await _db.deleteDevicesNotIn(infos.map((i) => i.nodeId).toSet());
    notifyListeners();
  }

  /// 改名：先落库回显，再进发件箱。
  Future<String> rename(String nodeId, String newName) async {
    await _db.upsertDevice(
      DevicesCompanion(
        nodeId: Value(nodeId),
        name: Value(newName),
        isDirty: const Value(true),
        updatedAt: Value(DateTime.now()),
      ),
    );
    final key = await _sync.enqueueMutation(
      entityKind: 'device',
      entityId: nodeId,
      op: 'rename',
      payload: {'nodeId': nodeId, 'name': newName},
    );
    notifyListeners();
    return key;
  }

  /// 改分组：同改名管道。
  Future<String> setGroup(String nodeId, String groupName) async {
    await _db.upsertDevice(
      DevicesCompanion(
        nodeId: Value(nodeId),
        groupName: Value(groupName),
        isDirty: const Value(true),
        updatedAt: Value(DateTime.now()),
      ),
    );
    final key = await _sync.enqueueMutation(
      entityKind: 'device',
      entityId: nodeId,
      op: 'set_group',
      payload: {'nodeId': nodeId, 'group': groupName},
    );
    notifyListeners();
    return key;
  }

  /// 离线新建设备备注（示例写路径）：本地 tmp ID 占位，同步后自动改写。
  Future<String> createLocalNote(String nodeId, String note) async {
    final tmpId = 'tmp_${DateTime.now().microsecondsSinceEpoch}';
    final key = await _sync.enqueueMutation(
      entityKind: 'device_note',
      entityId: tmpId,
      op: 'create',
      payload: {'nodeId': nodeId, 'note': note, 'tmpId': tmpId},
    );
    return key;
  }

  /// 网络恢复/回前台时触发一次排空（A-05：outbox drain 触发点）。
  Future<DrainResult> drainOutbox() => _sync.drainOnce();

  /// 待同步条数（待发＋死信），供同步徽标显示。
  Future<int> pendingSyncCount() async {
    final pending = await _db.pendingOutbox(limit: 1000);
    final dead = await _sync.deadLetters();
    return pending.length + dead.length;
  }
}

/// 服务端设备信息（网络层解析出的纯数据，不含任何 UI 引用）。
class DeviceInfo {
  final String nodeId;
  final String name;
  final String os;
  final String groupName;
  final bool online;
  final DateTime? lastSeen;

  const DeviceInfo({
    required this.nodeId,
    required this.name,
    this.os = '',
    this.groupName = '',
    this.online = false,
    this.lastSeen,
  });

  factory DeviceInfo.fromJson(Map<String, Object?> json) => DeviceInfo(
    nodeId: json['nodeId'] as String? ?? '',
    name: json['name'] as String? ?? '',
    os: json['os'] as String? ?? '',
    groupName: json['group'] as String? ?? '',
    online: json['online'] as bool? ?? false,
    lastSeen: json['lastSeen'] == null
        ? null
        : DateTime.tryParse(json['lastSeen'] as String),
  );

  /// Drift 行转 DTO（UI 层只见 DTO，不见数据库行类型）。
  factory DeviceInfo.fromDevice(Device row) => DeviceInfo(
    nodeId: row.nodeId,
    name: row.name,
    os: row.os,
    groupName: row.groupName,
    online: row.online,
    lastSeen: row.lastSeen,
  );

  Map<String, Object?> toJson() => {
    'nodeId': nodeId,
    'name': name,
    'os': os,
    'group': groupName,
    'online': online,
    'lastSeen': lastSeen?.toIso8601String(),
  };

  static String encodeList(List<DeviceInfo> infos) =>
      jsonEncode(infos.map((e) => e.toJson()).toList());
}
