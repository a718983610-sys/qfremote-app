import 'package:flutter_test/flutter_test.dart';
import 'package:qfremote/core/slot_nav.dart';
import 'package:qfremote/core/webview_cookie_policy.dart';

void main() {
  group('S-044：第三方 Cookie 分槽配置', () {
    test('全槽默认关（盘点结论：无功能依赖第三方 Cookie）', () {
      for (final slot in AppSlot.values) {
        expect(
          WebViewCookiePolicy.thirdPartyCookiesEnabled(slot),
          isFalse,
          reason: slot.name,
        );
      }
      expect(
        WebViewCookiePolicy.thirdPartyCookiesEnabledForShellPage,
        isFalse,
      );
    });

    test('依赖登记表为空——有依赖须先登记、只改该槽，不许静默改回', () {
      expect(WebViewCookiePolicy.thirdPartyDependencies, isEmpty);
    });

    test('两态验证矩阵覆盖清单要求的五项功能', () {
      final features = WebViewCookiePolicy.verificationMatrix
          .map((e) => e.feature)
          .toSet();
      expect(features, contains('登录'));
      expect(features, contains('好友／聊天'));
      expect(features, contains('Mesh iframe（控制台会话框）'));
      expect(features, contains('远程连接'));
      expect(features, contains('附件下载'));
      // 每个槽至少有一项覆盖。
      final slots = WebViewCookiePolicy.verificationMatrix
          .map((e) => e.slot)
          .toSet();
      expect(slots, contains(AppSlot.devices));
      expect(slots, contains(AppSlot.friends));
      expect(slots, contains(AppSlot.forum));
      expect(slots, contains(AppSlot.home));
    });

    test('盘点前提：全部槽位 URL 同源（否则“无依赖”结论不成立）', () {
      // SvcUrls 默认解析下全部槽位 URL 均为 kServerOrigin 同源；
      // 若服务端下发地址改成跨站源，本断言失败，须重做盘点。
      expect(cookiePolicyAssumptionHolds(), isTrue);
    });
  });
}
