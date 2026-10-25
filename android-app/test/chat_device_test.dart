import 'package:flutter_test/flutter_test.dart';
import 'package:qfremote/core/chat_device.dart';

void main() {
  group('planChatDevice 决策矩阵（与 L 线 planChatDevice 同口径）', () {
    ChatDeviceAction plan({
      bool manualLogout = false,
      bool hasToken = true,
      bool locked = true,
      bool unlocked = false,
      bool hasShellDeviceCopy = true,
    }) =>
        planChatDevice(
          manualLogout: manualLogout,
          hasToken: hasToken,
          locked: locked,
          unlocked: unlocked,
          hasShellDeviceCopy: hasShellDeviceCopy,
        );

    test('手动退出 → 不递入', () {
      expect(plan(manualLogout: true), ChatDeviceAction.none);
    });
    test('无聊天会话 → 不递入', () {
      expect(plan(hasToken: false), ChatDeviceAction.none);
    });
    test('已解锁且已有壳副本 → 不动', () {
      expect(plan(unlocked: true, locked: false), ChatDeviceAction.none);
    });
    test('已解锁但无壳副本 → 后台补写', () {
      expect(plan(unlocked: true, locked: false, hasShellDeviceCopy: false),
          ChatDeviceAction.deviceEnroll);
    });
    test('未锁定（状态未明）→ 不递入', () {
      expect(plan(locked: false), ChatDeviceAction.none);
    });
    test('锁定中但无壳副本 → 不递入（留给密码路径/例外）', () {
      expect(plan(hasShellDeviceCopy: false), ChatDeviceAction.none);
    });
    test('锁定中且有壳副本 → 设备静默解锁', () {
      expect(plan(), ChatDeviceAction.deviceUnlock);
    });
  });

  group('parseChatState 探针解析', () {
    test('标准 JSON（含引号包裹）可解析', () {
      final st = parseChatState(
          '"{\\"hasToken\\":true,\\"locked\\":true,\\"unlocked\\":false,\\"hasShellDeviceCopy\\":true}"');
      expect(st, isNotNull);
      expect(st!.hasToken, isTrue);
      expect(st.locked, isTrue);
      expect(st.unlocked, isFalse);
      expect(st.hasShellDeviceCopy, isTrue);
    });
    test('空/null/坏值 → null 不抛', () {
      expect(parseChatState(null), isNull);
      expect(parseChatState(''), isNull);
      expect(parseChatState('null'), isNull);
      expect(parseChatState('<html>'), isNull);
    });
    test('缺字段按 false 处理', () {
      final st = parseChatState('{"hasToken":true}');
      expect(st!.hasToken, isTrue);
      expect(st.locked, isFalse);
    });
  });

  group('递入脚本', () {
    test('解锁脚本：带每页一次标记与钩子名、密钥经 JSON 编码', () {
      final js = buildChatDeviceUnlockScript('KEY+/=');
      expect(js, contains('__qfShellDeviceUnlockTried'));
      expect(js, contains('qfShellDeviceUnlock'));
      expect(js, contains('"KEY+/="'));
    });
    test('补写脚本：标记与解锁相互独立', () {
      final js = buildChatDeviceEnrollScript('KEY');
      expect(js, contains('__qfShellDeviceEnrollTried'));
      expect(js, contains('qfShellDeviceEnroll'));
      expect(js, isNot(contains('__qfShellDeviceUnlockTried')));
    });
  });
}
