import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:qfremote/app/permissions/notification_permission_flow.dart';
import 'package:qfremote/app/permissions/permission_service.dart';
import 'package:qfremote/app/permissions/qf_bridge_permission_service.dart';

/// status 与 request 可分别预设的桩（FakePermissionService 用同一 preset
/// 管两端，模拟不了“首次申请前 status 回 permanently_denied、request 回
/// granted”这类真机语义）。
class _StubPermissionService implements PermissionService {
  _StubPermissionService({
    required this.statusOutcome,
    required this.requestOutcome,
    this.throwOnStatus = false,
    this.throwOnRequest = false,
  });

  PermissionOutcome statusOutcome;
  PermissionOutcome requestOutcome;
  bool throwOnStatus;
  bool throwOnRequest;
  int statusCalls = 0;
  int requestCalls = 0;

  @override
  Future<PermissionOutcome> request(PermissionKind kind) async {
    requestCalls++;
    if (throwOnRequest) throw StateError('request boom');
    return requestOutcome;
  }

  @override
  Future<PermissionOutcome> status(PermissionKind kind) async {
    statusCalls++;
    if (throwOnStatus) throw StateError('status boom');
    return statusOutcome;
  }

  @override
  String? settingsPathText(PermissionKind kind) =>
      permissionSettingsPathText(kind);

  @override
  bool requiresSettingsPage(PermissionKind kind) =>
      permissionRequiresSettingsPage(kind);
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('QfBridgePermissionService（桥接映射）', () {
    late List<String> calls;
    late Map<String, String?> replies;

    setUp(() {
      calls = [];
      replies = {};
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(
        const MethodChannel('qfremote/bridge'),
        (call) async {
          calls.add(
              '${call.method}:${(call.arguments as Map?)?['kind']}');
          if (call.method == 'permissions.status') {
            return replies['status'];
          }
          if (call.method == 'permissions.request') {
            return replies['request'];
          }
          return null;
        },
      );
    });

    tearDown(() {
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(
              const MethodChannel('qfremote/bridge'), null);
    });

    test('status/request 按原生字符串映射', () async {
      const service = QfBridgePermissionService();
      replies['status'] = 'granted';
      expect(await service.status(PermissionKind.notifications),
          PermissionOutcome.granted);
      replies['status'] = 'denied';
      expect(await service.status(PermissionKind.notifications),
          PermissionOutcome.denied);
      replies['status'] = 'permanently_denied';
      expect(await service.status(PermissionKind.notifications),
          PermissionOutcome.permanentlyDenied);
      replies['request'] = 'granted';
      expect(await service.request(PermissionKind.notifications),
          PermissionOutcome.granted);
      replies['request'] = 'permanently_denied';
      expect(await service.request(PermissionKind.notifications),
          PermissionOutcome.permanentlyDenied);
      expect(calls, [
        'permissions.status:notifications',
        'permissions.status:notifications',
        'permissions.status:notifications',
        'permissions.request:notifications',
        'permissions.request:notifications',
      ]);
    });

    test('settings_required/unknown/null 一律按 denied（fail-open）', () async {
      const service = QfBridgePermissionService();
      replies['status'] = 'settings_required';
      expect(await service.status(PermissionKind.notifications),
          PermissionOutcome.denied);
      replies['status'] = 'unknown';
      expect(await service.status(PermissionKind.notifications),
          PermissionOutcome.denied);
      replies['status'] = null;
      expect(await service.status(PermissionKind.notifications),
          PermissionOutcome.denied);
      replies['request'] = 'settings_required';
      expect(await service.request(PermissionKind.notifications),
          PermissionOutcome.denied);
    });

    test('settingsPathText/requiresSettingsPage 走唯一出处', () {
      const service = QfBridgePermissionService();
      expect(service.settingsPathText(PermissionKind.notifications),
          contains('去设置 → 应用 → QFRemote → 通知'));
      expect(service.requiresSettingsPage(PermissionKind.notifications),
          isFalse);
      expect(service.requiresSettingsPage(PermissionKind.overlay), isTrue);
    });
  });

  group('NotificationPermissionFlow（会话启动编排）', () {
    Future<PermissionOutcome> runFlow(
      NotificationPermissionFlow flow, {
      bool rationaleAnswer = true,
      bool settingsAnswer = false,
      void Function()? onRationale,
      void Function(String text)? onSettings,
      void Function()? onOpenSettings,
    }) {
      return flow.ensure(
        showRationale: () async {
          onRationale?.call();
          return rationaleAnswer;
        },
        showSettingsPath: (text) async {
          onSettings?.call(text);
          return settingsAnswer;
        },
        openSettings: () async {
          onOpenSettings?.call();
        },
      );
    }

    test('已授权：不弹任何框、不调 request、直接 granted', () async {
      final service = _StubPermissionService(
        statusOutcome: PermissionOutcome.granted,
        requestOutcome: PermissionOutcome.granted,
      );
      final flow = NotificationPermissionFlow(service);
      var rationaleShown = false;
      var settingsShown = false;
      final outcome = await runFlow(
        flow,
        onRationale: () => rationaleShown = true,
        onSettings: (_) => settingsShown = true,
      );
      expect(outcome, PermissionOutcome.granted);
      expect(rationaleShown, isFalse);
      expect(settingsShown, isFalse);
      expect(service.requestCalls, 0);
      expect(flow.prompted, isFalse);
    });

    test('首次申请：status 回永久拒绝口径时直接 request，不先弹解释', () async {
      // 原生首次申请前 status 也回 permanently_denied（rationale 为 false），
      // 流程须直接 request（系统框会弹），不能误判成“永久拒绝去设置”。
      final service = _StubPermissionService(
        statusOutcome: PermissionOutcome.permanentlyDenied,
        requestOutcome: PermissionOutcome.granted,
      );
      final flow = NotificationPermissionFlow(service);
      var rationaleShown = false;
      var settingsShown = false;
      final outcome = await runFlow(
        flow,
        onRationale: () => rationaleShown = true,
        onSettings: (_) => settingsShown = true,
      );
      expect(outcome, PermissionOutcome.granted);
      expect(rationaleShown, isFalse);
      expect(settingsShown, isFalse);
      expect(service.requestCalls, 1);
    });

    test('被拒过一次：先弹解释，用户点“暂不开启”则不调 request', () async {
      final service = _StubPermissionService(
        statusOutcome: PermissionOutcome.denied,
        requestOutcome: PermissionOutcome.granted,
      );
      final flow = NotificationPermissionFlow(service);
      var rationaleShown = false;
      final outcome = await runFlow(
        flow,
        rationaleAnswer: false,
        onRationale: () => rationaleShown = true,
      );
      expect(outcome, PermissionOutcome.denied);
      expect(rationaleShown, isTrue);
      expect(service.requestCalls, 0);
      expect(flow.prompted, isTrue);
      // 本轮第二次 ensure 不再打扰。
      final second = await runFlow(flow, rationaleAnswer: false);
      expect(second, PermissionOutcome.denied);
      expect(service.requestCalls, 0);
    });

    test('被拒过一次：解释后点“去开启”，request 被拒则返回 denied', () async {
      final service = _StubPermissionService(
        statusOutcome: PermissionOutcome.denied,
        requestOutcome: PermissionOutcome.denied,
      );
      final flow = NotificationPermissionFlow(service);
      var rationaleShown = false;
      var settingsShown = false;
      final outcome = await runFlow(
        flow,
        rationaleAnswer: true,
        onRationale: () => rationaleShown = true,
        onSettings: (_) => settingsShown = true,
      );
      expect(outcome, PermissionOutcome.denied);
      expect(rationaleShown, isTrue);
      expect(settingsShown, isFalse);
      expect(service.requestCalls, 1);
    });

    test('request 回永久拒绝：弹设置路径，点“去设置”则打开设置', () async {
      final service = _StubPermissionService(
        statusOutcome: PermissionOutcome.denied,
        requestOutcome: PermissionOutcome.permanentlyDenied,
      );
      final flow = NotificationPermissionFlow(service);
      String? shownText;
      var opened = false;
      final outcome = await runFlow(
        flow,
        rationaleAnswer: true,
        settingsAnswer: true,
        onSettings: (text) => shownText = text,
        onOpenSettings: () => opened = true,
      );
      expect(outcome, PermissionOutcome.permanentlyDenied);
      expect(shownText, contains('去设置 → 应用 → QFRemote → 通知'));
      expect(opened, isTrue);
    });

    test('request 回永久拒绝：点“知道了”则不打开设置', () async {
      final service = _StubPermissionService(
        statusOutcome: PermissionOutcome.permanentlyDenied,
        requestOutcome: PermissionOutcome.permanentlyDenied,
      );
      final flow = NotificationPermissionFlow(service);
      var opened = false;
      final outcome = await runFlow(
        flow,
        settingsAnswer: false,
        onOpenSettings: () => opened = true,
      );
      expect(outcome, PermissionOutcome.permanentlyDenied);
      expect(opened, isFalse);
    });

    test('服务抛错：status/request 任一抛错都按 denied 返回，不抛到调用方',
        () async {
      final statusBoom = _StubPermissionService(
        statusOutcome: PermissionOutcome.granted,
        requestOutcome: PermissionOutcome.granted,
        throwOnStatus: true,
      );
      final flow1 = NotificationPermissionFlow(statusBoom);
      expect(await runFlow(flow1), PermissionOutcome.denied);

      final requestBoom = _StubPermissionService(
        statusOutcome: PermissionOutcome.permanentlyDenied,
        requestOutcome: PermissionOutcome.granted,
        throwOnRequest: true,
      );
      final flow2 = NotificationPermissionFlow(requestBoom);
      expect(await runFlow(flow2), PermissionOutcome.denied);
    });
  });
}
