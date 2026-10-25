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

  group('planChatUnlock 总编排（追加八：托管→设备→凭据，全程无界面）', () {
    ChatPageState st({
      bool hasToken = true,
      bool locked = true,
      bool unlocked = false,
      bool shell = false,
      bool custody = false,
    }) =>
        ChatPageState(
          hasToken: hasToken,
          locked: locked,
          unlocked: unlocked,
          hasShellDeviceCopy: shell,
          hasCustodyCopy: custody,
        );
    const capsAll =
        ChatPageCaps(custodyUnlockHook: true, custodyEnrollHook: true, shellUnlockHook: true);

    ChatUnlockStep plan(ChatPageState s,
            {ChatPageCaps caps = capsAll, bool creds = true, bool manual = false}) =>
        planChatUnlock(manualLogout: manual, state: s, caps: caps, hasCreds: creds);

    test('手动退出 → 不走任何步', () {
      expect(plan(st(), manual: true), ChatUnlockStep.none);
    });
    test('无会话 → 不走（归登录兜底）', () {
      expect(plan(st(hasToken: false)), ChatUnlockStep.none);
    });
    test('锁定中：托管钩子在 → 先托管取回（哪怕设备副本与凭据都在）', () {
      expect(plan(st(shell: true)), ChatUnlockStep.custodyUnlock);
    });
    test('锁定中：无托管钩子、有设备副本 → 设备解锁', () {
      expect(
          plan(st(shell: true),
              caps: const ChatPageCaps(shellUnlockHook: true)),
          ChatUnlockStep.deviceUnlock);
    });
    test('锁定中：托管与设备都不可用、有凭据 → 凭据程序解锁（迁移源）', () {
      expect(plan(st(), caps: const ChatPageCaps(shellUnlockHook: true)),
          ChatUnlockStep.credentialUnlock);
    });
    test('锁定中：三路全不可用 → 停手（页面正式不可用提示，壳不加界面）', () {
      expect(plan(st(), caps: const ChatPageCaps(), creds: false),
          ChatUnlockStep.none);
    });
    test('已解锁无托管副本 → 先补发托管', () {
      expect(plan(st(locked: false, unlocked: true, shell: true)),
          ChatUnlockStep.custodyEnroll);
    });
    test('已解锁有托管、无设备副本 → 补写设备副本', () {
      expect(plan(st(locked: false, unlocked: true, custody: true)),
          ChatUnlockStep.deviceEnroll);
    });
    test('已解锁且副本齐全 → 停', () {
      expect(plan(st(locked: false, unlocked: true, shell: true, custody: true)),
          ChatUnlockStep.none);
    });
  });

  group('托管/凭据脚本与能力探针', () {
    test('托管取回与补发：每页一次标记、特性探测钩子名', () {
      final u = buildChatCustodyUnlockScript();
      expect(u, contains('__qfShellCustodyTried'));
      expect(u, contains('qfShellCustodyUnlock'));
      final e = buildChatCustodyEnrollScript();
      expect(e, contains('__qfShellCustodyEnrollTried'));
      expect(e, contains('qfShellCustodyEnroll'));
    });
    test('凭据解锁：调 qfShellUnlock 程序解锁、不碰任何输入元素', () {
      final js = buildChatCredentialUnlockScript('pw+/');
      expect(js, contains('qfShellUnlock'));
      expect(js, contains('__qfShellCredUnlockTried'));
      expect(js, contains('"pw+/"'));
      expect(js, isNot(contains('ukPass')));
      expect(js, isNot(contains('getElementById')));
    });
    test('能力探针解析：缺失/坏值全 false 不抛', () {
      final c = parseChatCaps(
          '"{\\"custodyUnlock\\":true,\\"custodyEnroll\\":false,\\"shellUnlock\\":true}"');
      expect(c.custodyUnlockHook, isTrue);
      expect(c.custodyEnrollHook, isFalse);
      expect(c.shellUnlockHook, isTrue);
      expect(parseChatCaps('').custodyUnlockHook, isFalse);
      expect(parseChatCaps(null).shellUnlockHook, isFalse);
    });
    test('状态解析带托管副本字段', () {
      final s = parseChatState('{"hasToken":true,"hasCustodyCopy":true}');
      expect(s!.hasCustodyCopy, isTrue);
      final s2 = parseChatState('{"hasToken":true}');
      expect(s2!.hasCustodyCopy, isFalse);
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
