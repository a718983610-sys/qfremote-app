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

  group('会话深链识别 isSessionDeepLink（收编 P1 地基）', () {
    const own = {
      'https://54.248.9.192:8443',
      'https://app.qfremote.top',
    };
    test('正例：桌面/终端/手机设备页三形态全命中', () {
      expect(
          isSessionDeepLink('https://54.248.9.192:8443/?node=abc&viewmode=11',
              ownOrigins: own),
          isTrue);
      expect(
          isSessionDeepLink('https://54.248.9.192:8443/?node=abc&viewmode=12',
              ownOrigins: own),
          isTrue);
      expect(
          isSessionDeepLink('https://54.248.9.192:8443/?node=abc&viewmode=10',
              ownOrigins: own),
          isTrue);
    });
    test('正例：带额外参数、node 含转义字符、自有源集合内另一源', () {
      expect(
          isSessionDeepLink(
              'https://54.248.9.192:8443/?node=t3Eza%40Zz%24x&viewmode=11&title=a',
              ownOrigins: own),
          isTrue);
      expect(
          isSessionDeepLink(
              'https://app.qfremote.top/?node=abc&viewmode=11',
              ownOrigins: own),
          isTrue);
    });
    test('反例：SPA 常规导航不误伤（根路径无参/仅 node/模式外 viewmode）', () {
      expect(isSessionDeepLink('https://54.248.9.192:8443/', ownOrigins: own),
          isFalse);
      expect(
          isSessionDeepLink('https://54.248.9.192:8443/home',
              ownOrigins: own),
          isFalse);
      expect(
          isSessionDeepLink('https://54.248.9.192:8443/?node=abc',
              ownOrigins: own),
          isFalse);
      expect(
          isSessionDeepLink('https://54.248.9.192:8443/?viewmode=11',
              ownOrigins: own),
          isFalse);
      expect(
          isSessionDeepLink('https://54.248.9.192:8443/?node=&viewmode=11',
              ownOrigins: own),
          isFalse);
      expect(
          isSessionDeepLink('https://54.248.9.192:8443/?node=abc&viewmode=13',
              ownOrigins: own),
          isFalse);
    });
    test('反例：外源同形、登出址、下载址、空值', () {
      expect(
          isSessionDeepLink('https://evil.example.com/?node=abc&viewmode=11',
              ownOrigins: own),
          isFalse);
      expect(
          isSessionDeepLink(
              'https://54.248.9.192:8443/logout?node=abc&viewmode=11',
              ownOrigins: own),
          isFalse);
      expect(
          isSessionDeepLink(
              'https://54.248.9.192:8443/dl/app.apk?node=abc&viewmode=11',
              ownOrigins: own),
          isFalse);
      expect(isSessionDeepLink(null, ownOrigins: own), isFalse);
      expect(isSessionDeepLink('', ownOrigins: own), isFalse);
      expect(isSessionDeepLink('about:blank', ownOrigins: own), isFalse);
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
