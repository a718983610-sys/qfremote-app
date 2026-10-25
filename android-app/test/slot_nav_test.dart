import 'package:flutter_test/flutter_test.dart';
import 'package:qfremote/core/slot_nav.dart';

void main() {
  group('壳内内容页判定与藏框脚本（追加十：页面自带框与壳框架去重）', () {
    test('好友/聊天/论坛路径命中，控制台与杂路径不命中', () {
      expect(isShellContentPage('https://h:8445/friends'), isTrue);
      expect(isShellContentPage('https://h:8445/chat'), isTrue);
      expect(isShellContentPage('https://t/forum'), isTrue);
      expect(isShellContentPage('https://t/forum/post/1'), isTrue);
      expect(isShellContentPage('https://h:8443/'), isFalse);
      expect(isShellContentPage('about:blank'), isFalse);
      expect(isShellContentPage(null), isFalse);
      expect(isShellContentPage(''), isFalse);
    });
    test('脚本：藏 appbar/tabbar、顶栏预留归零、幂等标记', () {
      final js = buildShellChromeHideScript();
      expect(js, contains('header.appbar'));
      expect(js, contains('nav.tabbar'));
      expect(js, contains('--topbar-h:0px'));
      expect(js, contains('__qfShellChrome'));
      // 聊天页的会话返回条不在藏除范围
      expect(js, isNot(contains('backbar')));
    });
  });

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
    test('首页槽是根槽（2.3.1）：可退 → 页内后退；不可退 → 退出 App', () {
      expect(decideBackAction(active: AppSlot.home, activeCanGoBack: true),
          BackAction.pageBack);
      expect(decideBackAction(active: AppSlot.home, activeCanGoBack: false),
          BackAction.exitApp);
    });
    test('文件槽：可退 → 页内后退；不可退 → 回设备槽', () {
      expect(decideBackAction(active: AppSlot.files, activeCanGoBack: true),
          BackAction.pageBack);
      expect(decideBackAction(active: AppSlot.files, activeCanGoBack: false),
          BackAction.toDevices);
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
