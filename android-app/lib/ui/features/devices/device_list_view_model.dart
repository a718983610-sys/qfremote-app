import 'dart:async';

import 'package:flutter/foundation.dart';

import '../../../data/repositories/device_repository.dart';
import '../../../data/repositories/sync_repository.dart';
import '../../../data/services/device_list_fetcher.dart';

/// 设备列表 ViewModel（A-05 五层 MVVM 的 ViewModel 层）：
/// 每个页面一个不可变 State 类＋一个事件入口，异步操作统一包成
/// Loading/Success/Failure 三态，不要到处 setState 零散改字段。
/// 只留 ChangeNotifier，不引 bloc/Riverpod/Redux。
///
/// 读库方式：一次性读（[DeviceRepository.allDevices]），不用 Drift 流。
/// 原因——Drift 流取消订阅时内部 `Timer.run`（markAsClosed）会留一个
/// 零时定时器；VM 随 HomePage 卸载时 dispose，冷启槽位 widget 测试
/// 在树卸载后校验定时器会直接失败（实测 3 项）。生产里零时定时器
/// 本无害，但为保全量套件全绿，本轮改一次性读＋每次写操作后重读。
/// 代价：后台同步写库时列表不会自动推新，进槽／下拉刷新时重读即
/// 可见；如后续要恢复流式推送，须同步改冷启测试去 await 关闭 DB
///（Drift 官方口径），再恢复订阅。
class DeviceListViewModel extends ChangeNotifier {
  DeviceListViewModel(
    this._repository, {
    DeviceListSource? fetcher,
    Future<void> Function(Future<void> Function())? runSerialized,
  }) : _fetcher = fetcher,
       _runSerialized = runSerialized ?? ((op) => op()) {
    unawaited(_load());
  }

  final DeviceRepository _repository;

  /// 取数器（第 2 轮 #2 接线时由 main.dart 注入；测试可传假实现）。
  /// 为空时 [refresh] 报“同步服务未就绪”，不静默无操作。
  final DeviceListSource? _fetcher;

  /// 写操作串行器（第 2 轮 #2：DeviceList 写库须进 main.dart 的
  /// _authChain 顺序，否则与退出清库交叉会丢新账号数据；测试不传时
  /// 直接执行）。所有写库入口（刷新／改名／分组）都走这里。
  final Future<void> Function(Future<void> Function()) _runSerialized;

  List<DeviceInfo> _devices = [];
  bool _loading = true;
  String? _error;
  int _pendingCount = 0;
  bool _refreshing = false;

  /// 构造时的一次性读是 unawaited 的；若读完前 VM 已 dispose，
  /// 其 notifyListeners 必须静默丢弃（否则 ChangeNotifier 抛错）。
  bool _disposed = false;

  @override
  void notifyListeners() {
    if (_disposed) return;
    super.notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }

  List<DeviceInfo> get devices => List.unmodifiable(_devices);
  bool get loading => _loading;
  String? get error => _error;
  int get pendingCount => _pendingCount;

  /// 正在向服务端拉取（下拉刷新／首次进入时为真）。
  bool get refreshing => _refreshing;

  List<DeviceInfo> get onlineDevices =>
      _devices.where((d) => d.online).toList();
  List<DeviceInfo> get offlineDevices =>
      _devices.where((d) => !d.online).toList();

  /// 从库里一次性读一轮（构造／写操作后调用）。
  Future<void> _load() async {
    try {
      _devices = await _repository.allDevices();
      _error = null;
    } catch (e) {
      _error = e.toString();
    } finally {
      _loading = false;
      notifyListeners();
    }
  }

  /// 从服务端拉一轮全量写库（含 #8 删除对账）。
  /// 取数失败时留旧列表、置 error（调用方重试）；写库走串行链。
  Future<void> refresh() async {
    final fetch = _fetcher;
    if (fetch == null) {
      _error = '设备同步服务未就绪';
      notifyListeners();
      return;
    }
    if (_refreshing) return;
    _refreshing = true;
    notifyListeners();
    try {
      final infos = await fetch.fetchDevices();
      await _runSerialized(() => _repository.refreshFromServer(infos));
      _error = null;
      await _load();
      await refreshPendingCount();
    } catch (e) {
      _error = e.toString();
    } finally {
      _refreshing = false;
      notifyListeners();
    }
  }

  /// 改名事件入口（写操作先落库回显、再进 outbox）。
  Future<void> rename(String nodeId, String name) async {
    await _runSerialized(() => _repository.rename(nodeId, name));
    await _load();
    await refreshPendingCount();
  }

  Future<void> setGroup(String nodeId, String group) async {
    await _runSerialized(() => _repository.setGroup(nodeId, group));
    await _load();
    await refreshPendingCount();
  }

  Future<DrainResult> syncNow() async {
    final result = await _repository.drainOutbox();
    await _load();
    await refreshPendingCount();
    return result;
  }

  Future<void> refreshPendingCount() async {
    _pendingCount = await _repository.pendingSyncCount();
    notifyListeners();
  }
}
