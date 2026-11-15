import 'package:flutter/foundation.dart';

import '../data/db/app_database.dart';
import '../data/repositories/device_repository.dart';
import '../data/repositories/sync_repository.dart';
import '../data/services/api_client.dart';
import '../data/services/device_list_fetcher.dart';
import '../ui/features/devices/device_list_view_model.dart';

/// A-05 DI 注册表（Invoice Ninja v2 `Services.build` 模式：手动单例注册表，
/// 不用 Dagger/Hilt/Riverpod；ViewModel 构造器注入，不直接读 Services）。
///
/// 构建顺序：数据库 → 网络层（可整体重建）→ 发件箱通道 → 仓库 → ViewModel。
/// UI 层只从这里取 ViewModel/Repository，绝不自己 new 数据库或 HttpClient。
class Services {
  Services._({
    required this.db,
    required this.apiClient,
    required this.syncRepository,
    required this.deviceRepository,
  });

  final QfDatabase db;
  final QfApiClient apiClient;
  final SyncRepository syncRepository;
  final DeviceRepository deviceRepository;

  static Future<Services> build({
    QfDatabase? db,
    QfApiClient? apiClient,
    OutboxTransport? transport,
    Future<void> Function()? onUnauthorized,
  }) async {
    final database = db ?? await QfDatabase.open();
    final api =
        apiClient ??
        QfApiClient(
          baseUrl: defaultApiBaseUrl(),
          onUnauthorized: onUnauthorized,
        );
    final outbox = transport ?? HttpOutboxTransport(api);
    final sync = SyncRepository(database, outbox);
    final devices = DeviceRepository(database, sync);
    return Services._(
      db: database,
      apiClient: api,
      syncRepository: sync,
      deviceRepository: devices,
    );
  }

  /// 测试用内存构建（不碰文件系统、不碰网络）。
  static Services memory({OutboxTransport? transport}) {
    final database = QfDatabase.memory();
    final api = QfApiClient(baseUrl: 'https://example.invalid');
    final outbox = transport ?? _NullOutboxTransport();
    final sync = SyncRepository(database, outbox);
    final devices = DeviceRepository(database, sync);
    return Services._(
      db: database,
      apiClient: api,
      syncRepository: sync,
      deviceRepository: devices,
    );
  }

  /// 设备列表 ViewModel（第 2 轮 #2：main.dart 接线时传入取数器；
  /// 不传时 ViewModel 的 refresh() 报“同步服务未就绪”）。
  /// 注意：每次调用都新建一个 ViewModel（新建流订阅），调用方
  /// （main.dart）须缓存复用，不得每帧新建。
  DeviceListViewModel deviceListViewModel({DeviceListSource? fetcher}) =>
      DeviceListViewModel(deviceRepository, fetcher: fetcher);

  /// 当前网络层基址（A-06：重建前后对比用）。
  String get apiBaseUrl => apiClient.baseUrl;

  /// 换节点/换接入域名：网络层整体重建（A-06），仓库与 ViewModel 不动。
  void rebuildNetwork({required String baseUrl}) {
    apiClient.rebuild(baseUrl: baseUrl);
  }

  Future<void> dispose() async {
    apiClient.dispose();
    await db.close();
  }
}

class _NullOutboxTransport implements OutboxTransport {
  @override
  Future<OutboxResult> send(OutboxEntry entry) async =>
      const OutboxResult.networkError();
}

/// 顶层 Services 持有者（ChangeNotifier 式单例，供 main.dart 在 _boot 里
/// 构建后下发；失败时为 null，UI 走降级态，绝不挡 runApp）。
class ServicesHolder extends ChangeNotifier {
  Services? _services;
  Services? get services => _services;

  void set(Services s) {
    _services = s;
    notifyListeners();
  }
}

/// 启动接线（A-05/A-06，第 1 轮）：在 main.dart `_boot()` 里构建 Services
/// 并挂到 [ServicesHolder]；构建失败时返回 null（不抛），调用方走降级态
/// （WebView 仍是生产路径，绝不挡 runApp／启动画面）。
/// [build] 仅供测试注入（抛错／挂起以验证降级）；生产走默认 [Services.build]，
/// 基址用启动时已解析的服务 origin。构建 10 秒超时（超时即降级，不等）。
/// 注意：401 单飞登出回调（onUnauthorized）本轮不接线——DeviceList 尚未
/// 消费 apiClient，接线点留给第 2 轮（届时接到登出流程）。
Future<Services?> buildServicesForBoot({
  required ServicesHolder holder,
  required String baseUrl,
  Future<Services> Function()? build,
  Duration timeout = const Duration(seconds: 10),
  void Function(Object error)? onError,
}) async {
  try {
    final services =
        await (build ??
                () =>
                    Services.build(apiClient: QfApiClient(baseUrl: baseUrl)))()
            .timeout(timeout);
    holder.set(services);
    return services;
  } catch (e) {
    onError?.call(e);
    return null;
  }
}

/// 退出清库（A-05 接线硬门槛）：清掉 Services 持有的全部本地数据
/// （Drift 库：设备／发件箱／ID 映射），防止跨账号残留。
/// [services] 为 null（降级启动、从未构建）时直接返回，不抛错。
/// 注意：只清数据行，不关库、不 dispose——退出后应用继续跑（登录页），
/// 下个账号登录复用同一 Services／同一库连接。
Future<void> clearServicesDataForLogout(Services? services) async {
  if (services == null) return;
  await services.db.clearAllData();
}
