import 'package:flutter_test/flutter_test.dart';
import 'package:qfremote/core/jsbridge_guard.dart';

void main() {
  group('F-07 JSBridge 来源守卫', () {
    const login = 'https://app.qfremote.top/';
    const loginNoSlash = 'https://app.qfremote.top';
    const consoleSession =
        'https://app.qfremote.top/#session/node1234567890abcdef';
    const consoleDeepLink =
        'https://app.qfremote.top/?node=node1234567890abcdef&viewmode=11';
    const consoleOtherHash = 'https://app.qfremote.top/#devices';
    const forumPath = 'https://app.qfremote.top/forum';
    const subDomain = 'https://sub.app.qfremote.top/';
    const wrongPort = 'https://app.qfremote.top:8443/';
    const evil = 'https://evil.example/';

    test('qfLoginSubmit：只允许登录页主 frame', () {
      expect(isLoginSubmitAllowed(login), isTrue);
      expect(isLoginSubmitAllowed(loginNoSlash), isTrue);
      // 根页带 query 串仍是登录表单页（未登录时服务端在同一根页出表单）。
      expect(isLoginSubmitAllowed('https://app.qfremote.top/?x=1'), isTrue);
      // 会话页／控制台内页的 frame 冒名提交一律拒。
      expect(isLoginSubmitAllowed(consoleSession), isFalse);
      expect(isLoginSubmitAllowed(consoleDeepLink), isFalse);
      expect(isLoginSubmitAllowed(consoleOtherHash), isFalse);
      expect(isLoginSubmitAllowed(forumPath), isFalse);
      expect(isLoginSubmitAllowed(subDomain), isFalse);
      expect(isLoginSubmitAllowed(wrongPort), isFalse);
      expect(isLoginSubmitAllowed(evil), isFalse);
      expect(isLoginSubmitAllowed(null), isFalse);
      expect(isLoginSubmitAllowed(''), isFalse);
      expect(isLoginSubmitAllowed('about:blank'), isFalse);
    });

    test('qfLicenseNav：只允许登录页主 frame', () {
      expect(isLicenseNavAllowed(login), isTrue);
      expect(isLicenseNavAllowed(consoleSession), isFalse);
      expect(isLicenseNavAllowed(forumPath), isFalse);
      expect(isLicenseNavAllowed(evil), isFalse);
      expect(isLicenseNavAllowed(null), isFalse);
    });

    test('qfManualLogout：只允许控制台根 SPA 主 frame', () {
      expect(isManualLogoutAllowed(login), isTrue);
      expect(isManualLogoutAllowed(consoleSession), isTrue);
      expect(isManualLogoutAllowed(consoleDeepLink), isTrue);
      expect(isManualLogoutAllowed(consoleOtherHash), isTrue);
      // 子路径不是控制台 SPA 根，外站同形 /logout 不许触发。
      expect(isManualLogoutAllowed(forumPath), isFalse);
      expect(isManualLogoutAllowed(subDomain), isFalse);
      expect(isManualLogoutAllowed(wrongPort), isFalse);
      expect(isManualLogoutAllowed(evil), isFalse);
      expect(isManualLogoutAllowed(null), isFalse);
      expect(isManualLogoutAllowed('about:blank'), isFalse);
    });

    test('qfSessionStage：只允许会话路由主 frame', () {
      expect(isSessionStageAllowed(consoleSession), isTrue);
      expect(isSessionStageAllowed(consoleDeepLink), isTrue);
      // 登录页／控制台其他路由的 frame 冒名打点一律拒。
      expect(isSessionStageAllowed(login), isFalse);
      expect(isSessionStageAllowed(consoleOtherHash), isFalse);
      expect(isSessionStageAllowed(forumPath), isFalse);
      // viewmode 超出 10..12 不是会话路由。
      expect(
          isSessionStageAllowed(
              'https://app.qfremote.top/?node=x&viewmode=9'),
          isFalse);
      expect(isSessionStageAllowed(subDomain), isFalse);
      expect(isSessionStageAllowed(wrongPort), isFalse);
      expect(isSessionStageAllowed(evil), isFalse);
      expect(isSessionStageAllowed(null), isFalse);
    });

    test('isConsoleMainFrame：根路径口径与 _isConsolePage 一致', () {
      expect(isConsoleMainFrame(login), isTrue);
      expect(isConsoleMainFrame(loginNoSlash), isTrue);
      expect(isConsoleMainFrame('https://app.qfremote.top/?x=1'), isTrue);
      expect(isConsoleMainFrame(forumPath), isFalse);
      expect(isConsoleMainFrame('https://app.qfremote.top/login'), isFalse);
    });
  });
}
