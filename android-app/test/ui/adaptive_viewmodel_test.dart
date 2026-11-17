import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:qfremote/app/services.dart';
import 'package:qfremote/data/repositories/device_repository.dart';
import 'package:qfremote/ui/core/adaptive.dart';
import 'package:qfremote/ui/features/devices/device_list_view_model.dart';

void main() {
  group('A-08 自适应三档断点＋状态机', () {
    test('layoutKindForWidth：三档边界', () {
      expect(layoutKindForWidth(359), QfLayoutKind.compact);
      expect(layoutKindForWidth(599), QfLayoutKind.compact);
      expect(layoutKindForWidth(600), QfLayoutKind.medium);
      expect(layoutKindForWidth(840), QfLayoutKind.medium);
      expect(layoutKindForWidth(841), QfLayoutKind.expanded);
    });

    test('resolvePageForm：手机只允许单栏，会话态只允许全屏', () {
      expect(
        resolvePageForm(QfLayoutKind.compact, inSession: false),
        QfPageForm.single,
      );
      expect(
        resolvePageForm(QfLayoutKind.medium, inSession: false),
        QfPageForm.twoPane,
      );
      expect(
        resolvePageForm(QfLayoutKind.expanded, inSession: false),
        QfPageForm.twoPane,
      );
      expect(
        resolvePageForm(QfLayoutKind.expanded, inSession: true),
        QfPageForm.fullScreen,
      );
      expect(
        resolvePageForm(QfLayoutKind.compact, inSession: true),
        QfPageForm.fullScreen,
      );
    });

    test('NavHistoryController：Back 走历史，Up 走结构，两者不混淆', () {
      final nav = NavHistoryController();
      nav.push('/devices');
      nav.push('/devices/n1');
      expect(nav.current, '/devices/n1');
      expect(nav.handleBack(), isTrue);
      expect(nav.current, '/devices');
      expect(nav.handleBack(), isFalse); // 栈底：交给系统
      expect(nav.upTarget('/devices/n1'), '/devices');
      expect(nav.upTarget('/devices'), isNull);
    });

    testWidgets('isDisplayDesktop / isDisplayFoldable 共用集中判断', (tester) async {
      await tester.pumpWidget(
        MaterialApp(
          home: Builder(
            builder: (context) {
              final w = MediaQuery.sizeOf(context).width;
              return Text(
                '${isDisplayDesktop(context)}-${isDisplayFoldable(context)}-$w',
              );
            },
          ),
        ),
      );
      expect(find.textContaining('false-false-'), findsOneWidget);
    });
  });

  group('A-05 DeviceListViewModel', () {
    // 第 2 轮 #2：VM 改一次性读（Drift 流取消订阅的 Timer.run 会弄
    // 坏冷启 widget 测试，见 WIRING-R2-DEVICELIST.md）。构造时读库，
    // 构造后写库不再自动推新，须显式 refresh/rename 才重读。
    test('构造时一次性读库：已有设备可见、loading 清掉', () async {
      final services = Services.memory();
      final repo = services.deviceRepository;
      await repo.refreshFromServer([
        const DeviceInfo(nodeId: 'n1', name: 'A', online: true),
        const DeviceInfo(nodeId: 'n2', name: 'B', online: false),
      ]);
      final vm = DeviceListViewModel(repo);
      await Future<void>.delayed(Duration.zero);
      expect(vm.loading, isFalse);
      expect(vm.devices, hasLength(2));
      expect(vm.onlineDevices, hasLength(1));
      expect(vm.offlineDevices, hasLength(1));
      vm.dispose();
      await services.dispose();
    });

    test('构造后写库不自动推新（须显式 refresh 才可见）', () async {
      final services = Services.memory();
      final repo = services.deviceRepository;
      final vm = DeviceListViewModel(repo);
      await Future<void>.delayed(Duration.zero);
      expect(vm.devices, isEmpty);
      await repo.refreshFromServer([
        const DeviceInfo(nodeId: 'n1', name: 'A', online: true),
      ]);
      await Future<void>.delayed(Duration.zero);
      expect(vm.devices, isEmpty);
      vm.dispose();
      await services.dispose();
    });

    test('改名走 ViewModel 事件入口', () async {
      final services = Services.memory();
      final repo = services.deviceRepository;
      final vm = DeviceListViewModel(repo);
      await repo.refreshFromServer([const DeviceInfo(nodeId: 'n1', name: 'A')]);
      await vm.rename('n1', '新名');
      await Future<void>.delayed(Duration.zero);
      expect(vm.devices.single.name, '新名');
      expect(vm.pendingCount, 1);
      vm.dispose();
      await services.dispose();
    });
  });
}
