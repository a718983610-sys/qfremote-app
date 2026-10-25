import 'package:flutter_test/flutter_test.dart';
import 'package:qfremote/core/slot_nav.dart';

void main() {
  group('返回键分级裁决 decideBackAction', () {
    test('好友槽页内可退 → 页内后退', () {
      expect(
          decideBackAction(active: AppSlot.friends, activeCanGoBack: true),
          BackAction.pageBack);
    });
    test('好友槽页内不可退 → 回设备槽', () {
      expect(
          decideBackAction(active: AppSlot.friends, activeCanGoBack: false),
          BackAction.toDevices);
    });
    test('论坛槽同口径', () {
      expect(decideBackAction(active: AppSlot.forum, activeCanGoBack: true),
          BackAction.pageBack);
      expect(decideBackAction(active: AppSlot.forum, activeCanGoBack: false),
          BackAction.toDevices);
    });
    test('我的页（原生、无页内历史）→ 回设备槽', () {
      expect(decideBackAction(active: AppSlot.me, activeCanGoBack: false),
          BackAction.toDevices);
    });
    test('设备槽可退 → 页内后退；不可退 → 退出 App', () {
      expect(decideBackAction(active: AppSlot.devices, activeCanGoBack: true),
          BackAction.pageBack);
      expect(decideBackAction(active: AppSlot.devices, activeCanGoBack: false),
          BackAction.exitApp);
    });
  });

  group('槽位加载账本 SlotLoadTracker', () {
    test('初始全部需要加载；标记后不再需要', () {
      final t = SlotLoadTracker();
      expect(t.needsLoad(AppSlot.friends), isTrue);
      t.markLoaded(AppSlot.friends);
      expect(t.needsLoad(AppSlot.friends), isFalse);
      expect(t.isLoaded(AppSlot.forum), isFalse);
    });
    test('退出后全部作废（不残留上个账号页面）', () {
      final t = SlotLoadTracker();
      t.markLoaded(AppSlot.friends);
      t.markLoaded(AppSlot.forum);
      t.invalidateAll();
      expect(t.needsLoad(AppSlot.friends), isTrue);
      expect(t.needsLoad(AppSlot.forum), isTrue);
    });
  });
}
