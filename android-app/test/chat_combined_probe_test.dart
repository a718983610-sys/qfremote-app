import 'package:flutter_test/flutter_test.dart';
import 'package:qfremote/core/chat_device.dart';

void main() {
  group('parseChatCombined（B13 返修：一次求值取回状态＋能力）', () {
    test('合并回包一次解析出状态与能力', () {
      const raw =
          '{"state":{"hasToken":true,"locked":true,"unlocked":false,"hasShellDeviceCopy":true,"hasCustodyCopy":false},'
          '"caps":{"custodyUnlock":true,"custodyEnroll":false,"shellUnlock":true}}';
      final r = parseChatCombined(raw);
      expect(r, isNotNull);
      expect(r!.state, isNotNull);
      expect(r.state!.locked, isTrue);
      expect(r.state!.hasShellDeviceCopy, isTrue);
      expect(r.caps.custodyUnlockHook, isTrue);
      expect(r.caps.shellUnlockHook, isTrue);
      expect(r.caps.custodyEnrollHook, isFalse);
    });

    test('state 为 null 时状态为空、能力照常解析', () {
      const raw =
          '{"state":null,"caps":{"custodyUnlock":false,"custodyEnroll":true,"shellUnlock":false}}';
      final r = parseChatCombined(raw);
      expect(r, isNotNull);
      expect(r!.state, isNull);
      expect(r.caps.custodyEnrollHook, isTrue);
    });

    test('空串/坏 JSON 返回 null（本拍不动作）', () {
      expect(parseChatCombined(''), isNull);
      expect(parseChatCombined('not json'), isNull);
      expect(parseChatCombined(null), isNull);
    });

    test('合并脚本一次取 state 与 caps（单次求值）', () {
      expect(kChatCombinedProbeJs, contains('qfChatState'));
      expect(kChatCombinedProbeJs, contains('qfShellCustodyUnlock'));
      expect(kChatCombinedProbeJs, contains('qfShellUnlock'));
    });
  });
}
