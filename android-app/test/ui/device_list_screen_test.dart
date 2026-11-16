import 'package:drift/drift.dart' hide isNull, isNotNull;
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:qfremote/app/services.dart';
import 'package:qfremote/data/repositories/device_repository.dart';
import 'package:qfremote/data/services/device_list_fetcher.dart';
import 'package:qfremote/ui/features/devices/device_list_screen.dart';
import 'package:qfremote/ui/features/devices/device_list_view_model.dart';
import 'package:qfremote/ui/theme.dart';

/// 第 2 轮 #2：DeviceListScreen widget 测试。
void main() {
  driftRuntimeOptions.dontWarnAboutMultipleDatabases = true;
  Future<DeviceListViewModel> pumpList(
    WidgetTester tester, {
    List<DeviceInfo> seed = const [],
    DeviceListSource? fetcher,
    void Function(DeviceInfo device)? onOpenDevice,
  }) async {
    final services = Services.memory();
    final repo = services.deviceRepository;
    if (seed.isNotEmpty) await repo.refreshFromServer(seed);
    final vm = DeviceListViewModel(repo, fetcher: fetcher);
    await tester.pumpWidget(
      MaterialApp(
        theme: QfTheme.light(),
        home: Scaffold(
          body: DeviceListScreen(viewModel: vm, onOpenDevice: onOpenDevice),
        ),
      ),
    );
    await tester.pump();
    return vm;
  }

  testWidgets('设备行渲染，点行回调 onOpenDevice 带 nodeId', (tester) async {
    DeviceInfo? tapped;
    final vm = await pumpList(
      tester,
      seed: const [
        DeviceInfo(nodeId: 'n1', name: '客厅电脑', online: true),
        DeviceInfo(nodeId: 'n2', name: '笔记本', online: false),
      ],
      onOpenDevice: (d) => tapped = d,
    );
    expect(find.text('客厅电脑'), findsOneWidget);
    expect(find.text('笔记本'), findsOneWidget);
    expect(find.text('在线'), findsOneWidget);
    expect(find.text('离线'), findsOneWidget);
    await tester.tap(find.text('客厅电脑'));
    await tester.pump();
    expect(tapped?.nodeId, 'n1');
    vm.dispose();
    await tester.pumpAndSettle();
  });

  testWidgets('空态点“立即同步”触发 refresh', (tester) async {
    var calls = 0;
    final vm = await pumpList(tester, fetcher: _CountingSource(() => calls++));
    expect(find.text('暂无设备'), findsOneWidget);
    await tester.tap(find.text('立即同步'));
    await tester.pump();
    expect(calls, 1);
    vm.dispose();
    await tester.pumpAndSettle();
  });

  testWidgets('取数失败出错误页，点重试再次触发 refresh', (tester) async {
    var calls = 0;
    final vm = await pumpList(tester, fetcher: _ThrowingSource(() => calls++));
    // 空态先点一次同步，取数失败 → 错误页。
    await tester.tap(find.text('立即同步'));
    await tester.pump();
    expect(calls, 1);
    expect(vm.error, isNotNull);
    // 错误页有重试按钮（文案为“重试”）。
    final retry = find.text('重试');
    expect(retry, findsOneWidget);
    await tester.tap(retry);
    await tester.pump();
    expect(calls, 2);
    vm.dispose();
    await tester.pumpAndSettle();
  });
}

class _CountingSource implements DeviceListSource {
  _CountingSource(this.onCall);
  final void Function() onCall;

  @override
  Future<List<DeviceInfo>> fetchDevices() async {
    onCall();
    return const [];
  }
}

class _ThrowingSource implements DeviceListSource {
  _ThrowingSource(this.onCall);
  final void Function() onCall;

  @override
  Future<List<DeviceInfo>> fetchDevices() async {
    onCall();
    throw const DeviceListFetchException('断网');
  }
}
