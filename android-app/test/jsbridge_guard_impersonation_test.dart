import 'package:flutter_test/flutter_test.dart';
import 'package:qfremote/core/jsbridge_guard.dart';

/// S-045：以外站 iframe 冒名调用为场景的守卫矩阵。
///
/// 威胁模型：壳内任何 frame（含被攻陷的跨源 iframe）都能调
/// `window.flutter_inappwebview.callHandler`；守卫以原生层掌握的
/// “当前主 frame URL”为核对依据（见 jsbridge_guard.dart 头注释）。
/// 本文件按“攻击者 frame 的 URL × handler”逐格断言：外站一律拒，
/// 同源登录页／会话路由才放行。接线核查（4 个 handler 全接
/// _jsbridgeAllowed）见 FIX-C2 报告的 grep 证据，不在本文件读源码。
void main() {
  group('S-045：外站 iframe 冒名调用矩阵', () {
    // 攻击者能控制的 frame URL：外站、子域、错端口、http 明文、about:blank。
    const attackerUrls = [
      'https://evil.example/',
      'https://evil.example/#session/node1234567890abcdef',
      'https://sub.app.qfremote.top/',
      'https://app.qfremote.top:8443/',
      'http://app.qfremote.top/',
      'about:blank',
      'https://app.qfremote.top.evil.example/',
    ];

    test('凭据 handler（qfLoginSubmit）：外站 iframe 冒名提交一律拒', () {
      for (final url in attackerUrls) {
        expect(isLoginSubmitAllowed(url), isFalse, reason: url);
      }
      // 只有登录页主 frame 能提交。
      expect(isLoginSubmitAllowed('https://app.qfremote.top/'), isTrue);
      expect(isLoginSubmitAllowed('https://app.qfremote.top'), isTrue);
    });

    test('凭据 handler（qfLicenseNav）：外站 iframe 冒名导航一律拒', () {
      for (final url in attackerUrls) {
        expect(isLicenseNavAllowed(url), isFalse, reason: url);
      }
      expect(isLicenseNavAllowed('https://app.qfremote.top/'), isTrue);
    });

    test('qfManualLogout：外站 iframe 冒名调“退出”清凭据一律拒', () {
      for (final url in attackerUrls) {
        expect(isManualLogoutAllowed(url), isFalse, reason: url);
      }
      // 控制台根 SPA 任意路由可点，但主 frame 必须是控制台根 origin。
      expect(isManualLogoutAllowed('https://app.qfremote.top/'), isTrue);
      expect(
        isManualLogoutAllowed(
          'https://app.qfremote.top/#session/node1234567890abcdef',
        ),
        isTrue,
      );
      // 论坛／好友槽是别的 WebView，不走此 handler；同源子路径也不认。
      expect(isManualLogoutAllowed('https://app.qfremote.top/forum'), isFalse);
      expect(isManualLogoutAllowed('https://app.qfremote.top/chat'), isFalse);
    });

    test('qfSessionStage：外站 iframe 冒名推进阶段 watcher 一律拒', () {
      for (final url in attackerUrls) {
        expect(isSessionStageAllowed(url), isFalse, reason: url);
      }
      // 只有会话路由主 frame 能打点；登录页／控制台其他路由一律拒。
      expect(
        isSessionStageAllowed(
          'https://app.qfremote.top/#session/node1234567890abcdef',
        ),
        isTrue,
      );
      expect(
        isSessionStageAllowed(
          'https://app.qfremote.top/?node=node1234567890abcdef&viewmode=11',
        ),
        isTrue,
      );
      expect(isSessionStageAllowed('https://app.qfremote.top/'), isFalse);
      expect(isSessionStageAllowed('https://app.qfremote.top/#devices'), isFalse);
    });

    test('凭据与普通事件分开注册：登录提交与阶段打点的允许集不重叠', () {
      // 登录页主 frame：能提交、不能打点（不是会话路由）。
      const login = 'https://app.qfremote.top/';
      expect(isLoginSubmitAllowed(login), isTrue);
      expect(isSessionStageAllowed(login), isFalse);
      // 会话路由主 frame：能打点、不能提交（不是登录页）。
      const session = 'https://app.qfremote.top/#session/node1234567890abcdef';
      expect(isSessionStageAllowed(session), isTrue);
      expect(isLoginSubmitAllowed(session), isFalse);
      // 退出横跨两类路由，但仍与登录提交的允许集不同。
      expect(isManualLogoutAllowed(login), isTrue);
      expect(isManualLogoutAllowed(session), isTrue);
    });
  });
}
