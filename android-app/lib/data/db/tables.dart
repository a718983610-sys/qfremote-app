import 'package:drift/drift.dart';

/// A-05 五层 MVVM 的数据层表定义（Invoice Ninja v2 模式，见 android
/// REPORT §九）：Drift 是唯一事实源——UI 只看 Drift 流，网络只写 Drift。
///
/// 表：
/// - [Devices]：设备登记（服务端下发的设备列表本地镜像）。
/// - [OutboxEntries]：离线发件箱（写操作先落库立即回显，再排队上行）。
/// - [IdRemaps]：离线新建的临时 ID（`tmp_<uuid>`）到服务端正式 ID 的映射。
class Devices extends Table {
  IntColumn get id => integer().autoIncrement()();

  /// 服务端设备编号（nodeid），唯一。
  TextColumn get nodeId => text().unique()();

  TextColumn get name => text().withDefault(const Constant(''))();

  TextColumn get os => text().withDefault(const Constant(''))();

  TextColumn get groupName => text().withDefault(const Constant(''))();

  BoolColumn get online => boolean().withDefault(const Constant(false))();

  DateTimeColumn get lastSeen => dateTime().nullable()();

  /// 本地有未同步的写操作（改名/分组等）时为真。
  BoolColumn get isDirty => boolean().withDefault(const Constant(false))();

  DateTimeColumn get updatedAt =>
      dateTime().withDefault(currentDateAndTime)();
}

class OutboxEntries extends Table {
  IntColumn get id => integer().autoIncrement()();

  /// 实体种类，如 `device`。
  TextColumn get entityKind => text()();

  /// 实体本地标识（新建时为 `tmp_<uuid>`，同步后由 id_remap 改写）。
  TextColumn get entityId => text()();

  /// 操作，如 `rename` / `set_group` / `set_note`。
  TextColumn get op => text()();

  /// 操作载荷（JSON 字符串）。
  TextColumn get payloadJson => text()();

  /// 幂等键：服务端去重用，客户端生成一次永不改。
  TextColumn get idempotencyKey => text().unique()();

  /// 已尝试次数；达到 [SyncRepository.maxAttempts] 后进死信。
  IntColumn get attempts => integer().withDefault(const Constant(0))();

  /// 下次可尝试时间（指数退避用）。
  DateTimeColumn get nextAttemptAt =>
      dateTime().withDefault(currentDateAndTime)();

  /// `pending` / `dead`（死信，须人工处理）。
  TextColumn get status => text().withDefault(const Constant('pending'))();

  DateTimeColumn get createdAt =>
      dateTime().withDefault(currentDateAndTime)();
}

class IdRemaps extends Table {
  IntColumn get id => integer().autoIncrement()();

  TextColumn get tmpId => text().unique()();

  TextColumn get realId => text()();

  DateTimeColumn get createdAt =>
      dateTime().withDefault(currentDateAndTime)();
}
