// 【冻结注明 v6 冻结⑮】本文件在纯冻结树下跳过：
// 它 import lib/main.dart，而 main.dart import manifest.dart，
// manifest.dart:4 import 未冻结的第二批文件 release_signature.dart，
// 纯冻结树下整个文件加载失败。第二批合入后恢复本文件。
// 冷启动组合四连测（SUP-P0-06 安卓冷启动白屏修复的验收骨架）。
//
// 通道口径（如实标注，不冒充真机）：
// - InAppWebView 在 widget 测试环境没有平台实现，WebView 内部页面
//   （登录页本体、控制台、恢复链的页面探针终点）在此渲染不出来；
//   「第一眼截图存证」仍须真机/模拟器四连测补（发版硬门，见诊断 §6.5）。
// - 本文件在 widget 层能验到的最硬一层：主框架组合裁决——
//   ① foregroundSlot 纯函数真值表（未登录恒设备槽；登录后按选中槽，
//      这是「已登录回归」一档在纯逻辑层的覆盖）；
//   ② 通道全 mock 的冷启动组合：IndexedStack 前台 index、标签栏缺席、
//      状态面（启动/断线）不在 IndexedStack 子树内（已提根层）；
//   ③ 置闸存量开机自愈：secure storage 的删除调用实证（③项修复）。
// 四档与诊断 §6.5 的对应：新装首启＝场景 A；会话失效＝场景 B；
// 断网启动＝场景 B 的状态面根层断言＋真机补；已登录回归＝纯裁决真值表
// 登录侧＋真机补。
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_inappwebview/flutter_inappwebview.dart';
import 'package:qfremote/core/slot_nav.dart';
import 'package:qfremote/main.dart';
import 'package:qfremote/ui/frame.dart';
import 'package:qfremote/ui/overlays.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// InAppWebView 假平台：widget 测试环境没有平台实现，不装它构建
/// InAppWebView 时断言直接炸掉整帧。假平台只出一块空白占位、不产生
/// 控制器（壳的登录探针等逻辑对控制器为空有守卫、自动空转）——页面
/// 内部渲染本来就不在 widget 层验收范围内（见文件头口径）。
class _FakeInAppWebViewWidget extends PlatformInAppWebViewWidget {
  _FakeInAppWebViewWidget(super.params) : super.implementation();

  @override
  Widget build(BuildContext context) => const SizedBox.expand();

  @override
  T controllerFromPlatform<T>(PlatformInAppWebViewController controller) =>
      throw UnimplementedError('测试假平台不产生控制器');

  @override
  void dispose() {}
}

class _FakeInAppWebViewPlatform extends InAppWebViewPlatform {
  @override
  PlatformInAppWebViewWidget createPlatformInAppWebViewWidget(
          PlatformInAppWebViewWidgetCreationParams params) =>
      _FakeInAppWebViewWidget(params);
}

/// secure storage 通道 mock：读回 [stored]，删除调用记进 [deleted]。
void _mockSecureStorage(
  TestWidgetsFlutterBinding binding, {
  required Map<String, String> stored,
  required List<String> deleted,
}) {
  binding.defaultBinaryMessenger.setMockMethodCallHandler(
    const MethodChannel('plugins.it_nomads.com/flutter_secure_storage'),
    (call) async {
      final args = (call.arguments as Map?) ?? const {};
      final key = args['key']?.toString() ?? '';
      switch (call.method) {
        case 'read':
          return stored[key];
        case 'readAll':
          return stored;
        case 'containsKey':
          return stored.containsKey(key);
        case 'delete':
          deleted.add(key);
          stored.remove(key);
          return null;
        case 'write':
          stored[key] = args['value']?.toString() ?? '';
          return null;
        case 'deleteAll':
          stored.clear();
          return null;
      }
      return null;
    },
  );
}

void _mockPlatformChannels(TestWidgetsFlutterBinding binding) {
  final messenger = binding.defaultBinaryMessenger;
  messenger.setMockMethodCallHandler(
    const MethodChannel('dev.fluttercommunity.plus/package_info'),
    (call) async => <String, dynamic>{
      'appName': 'QFRemote',
      'packageName': 'com.qingfeng.qfremote',
      'version': '2.3.2',
      'buildNumber': '23200',
      'buildSignature': '',
      'installerStore': '',
    },
  );
  messenger.setMockMethodCallHandler(
    const MethodChannel('plugins.flutter.io/path_provider'),
    (call) async => '/tmp',
  );
}

/// 冷启动并把启动异步链尽量推完，最后断言前先拆树（dispose 取消定时器）。
Future<void> _coldStart(WidgetTester tester) async {
  tester.view.physicalSize = const Size(360, 800);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(() {
    tester.view.resetPhysicalSize();
    tester.view.resetDevicePixelRatio();
  });
  await tester.pumpWidget(const QfRemoteApp());
  for (var i = 0; i < 20; i++) {
    await tester.pump(const Duration(milliseconds: 300));
  }
}

Future<void> _tearDownTree(WidgetTester tester) async {
  await tester.pumpWidget(const SizedBox());
  await tester.pump();
}

void _expectLoggedOutComposition() {
  // 主框架在：前台必须是设备槽（登录页所在），不是默认的首页空白槽。
  final stacks = find.byType(IndexedStack).evaluate();
  expect(stacks, isNotEmpty, reason: '启动门走完后主框架 IndexedStack 应在树上');
  final stack = stacks.first.widget as IndexedStack;
  expect(stack.index, AppSlot.devices.index,
      reason: '未登录时前台槽必须被裁决为设备槽（登录页在那里）');
  // 未登录没有导航 chrome：标签栏不许出现。
  expect(find.byType(QfTabBar), findsNothing,
      reason: '未登录时底部标签栏不应出现');
  // 状态面必须在根层：IndexedStack 子树里不许再有启动/断线面。
  expect(
    find.descendant(
        of: find.byType(IndexedStack), matching: find.byType(SplashView)),
    findsNothing,
    reason: '启动/恢复盖子已提根层，不许再困在槽位子树里',
  );
  expect(
    find.descendant(
        of: find.byType(IndexedStack), matching: find.byType(OfflineView)),
    findsNothing,
    reason: '断线卡片已提根层，不许再困在槽位子树里',
  );
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('foregroundSlot 裁决真值表（纯逻辑）', () {
    test('未登录：无论选中哪槽，前台恒为设备槽', () {
      for (final s in AppSlot.values) {
        expect(foregroundSlot(chromeVisible: false, selected: s),
            AppSlot.devices,
            reason: '未登录 selected=$s');
      }
    });
    test('已登录回归：前台按选中槽呈现（含默认落地首页槽）', () {
      for (final s in AppSlot.values) {
        expect(foregroundSlot(chromeVisible: true, selected: s), s,
            reason: '已登录 selected=$s');
      }
    });
  });

  group('冷启动组合（通道 mock）', () {
    setUp(() {
      InAppWebViewPlatform.instance = _FakeInAppWebViewPlatform();
    });

    testWidgets('场景 A · 新装首启：无凭据无会话 → 前台设备槽、无标签栏',
        (tester) async {
      SharedPreferences.setMockInitialValues({});
      final deleted = <String>[];
      _mockSecureStorage(TestWidgetsFlutterBinding.instance,
          stored: {}, deleted: deleted);
      _mockPlatformChannels(TestWidgetsFlutterBinding.instance);

      await _coldStart(tester);
      _expectLoggedOutComposition();
      await _tearDownTree(tester);
    });

    testWidgets('场景 B · 会话失效存量：有旧凭据＋快照 → 仍落设备槽、恢复盖子在根层',
        (tester) async {
      SharedPreferences.setMockInitialValues({
        'auth_remember_device': true,
        'auth_remember_password': true,
      });
      final snapshot = jsonEncode({
        'cookies': {'xid': 'dead-xid', 'xid.sig': 'dead-sig'},
        'savedAt': DateTime.now().millisecondsSinceEpoch,
      });
      final deleted = <String>[];
      _mockSecureStorage(TestWidgetsFlutterBinding.instance, stored: {
        'qf_saved_username': 'oldname@example.com',
        'qf_saved_password': 'old-password',
        'qf_session_snapshot': snapshot,
      }, deleted: deleted);
      _mockPlatformChannels(TestWidgetsFlutterBinding.instance);

      await _coldStart(tester);
      _expectLoggedOutComposition();
      // 有可恢复存档时开机盖子应在场（恢复链在盖子后跑），且在根层。
      expect(find.byType(SplashView), findsWidgets,
          reason: '有存档可恢复时启动/恢复盖子应盖住全屏（根层）');
      await _tearDownTree(tester);
    });

    testWidgets('场景 B2 · 置闸存量自愈：拦截标记在册 → 开机清存档并停手',
        (tester) async {
      SharedPreferences.setMockInitialValues({
        'auth_remember_device': true,
        'auth_credential_blocked': true,
      });
      final snapshot = jsonEncode({
        'cookies': {'xid': 'dead-xid', 'xid.sig': 'dead-sig'},
        'savedAt': DateTime.now().millisecondsSinceEpoch,
      });
      final deleted = <String>[];
      final stored = <String, String>{
        'qf_saved_username': 'oldname@example.com',
        'qf_saved_password': 'old-password',
        'qf_session_snapshot': snapshot,
      };
      _mockSecureStorage(TestWidgetsFlutterBinding.instance,
          stored: stored, deleted: deleted);
      _mockPlatformChannels(TestWidgetsFlutterBinding.instance);

      await _coldStart(tester);
      // ③项自愈实证：三件存档必须在开机阶段被删干净。
      expect(
          deleted,
          containsAll(<String>[
            'qf_saved_username',
            'qf_saved_password',
            'qf_session_snapshot',
          ]),
          reason: '置闸存量开机必须清凭据＋会话快照（删除调用实证）');
      // R-A8：clearAll 另持久化“已手动退出”闸——三件存档仍须删干净，
      // 但底层会多一个闸 key；闸只拦读凭据／会话（已是本场景要的停手
      // 状态），下次登录成功落盘新凭据时清掉。
      expect(stored.keys.toSet(), {'qf_manual_logout'},
          reason: '清完后 secure storage 只剩手动退出闸，无凭据／快照残留');
      _expectLoggedOutComposition();
      await _tearDownTree(tester);
    });
  });
}
