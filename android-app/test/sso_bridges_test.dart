import 'package:flutter_test/flutter_test.dart';
import 'package:qfremote/core/login_bridge.dart';
import 'package:qfremote/services/forum_sso.dart';

void main() {
  group('论坛免登桥·纯解析', () {
    test('me 响应有 user 时取用户名', () {
      expect(parseForumMeUser('{"ok":true,"user":"qfverify230a","isAdmin":false}'),
          'qfverify230a');
    });

    test('me 响应 user=null（只带 xid 的实测形态）→ null', () {
      expect(parseForumMeUser('{"ok":true,"user":null}'), isNull);
    });

    test('me 响应异常 → null 不抛', () {
      expect(parseForumMeUser(''), isNull);
      expect(parseForumMeUser('<html>502</html>'), isNull);
      expect(parseForumMeUser('{"ok":true}'), isNull);
    });

    test('从 Set-Cookie 取 qfr_frm 的值（带属性）', () {
      final v = extractSetCookieValue(
        ['qfr_frm=abc123def; Path=/; HttpOnly; Max-Age=2592000'],
        'qfr_frm',
      );
      expect(v, 'abc123def');
    });

    test('多个 cookie 混排时取对目标', () {
      final v = extractSetCookieValue(
        [
          'xid=zzz; Path=/; HttpOnly',
          'qfr_frm=tok999; Path=/; Expires=Wed, 21 Oct 2026 07:28:00 GMT',
        ],
        'qfr_frm',
      );
      expect(v, 'tok999');
    });

    test('没有目标 cookie → null', () {
      expect(extractSetCookieValue(['xid=zzz; Path=/'], 'qfr_frm'), isNull);
      expect(extractSetCookieValue(const [], 'qfr_frm'), isNull);
    });
  });

  group('聊天桥脚本', () {
    test('有凭据：含静默解锁与登录回填、每页一次的闸', () {
      final js = buildChatBridgeJs(username: 'user1', password: 'pass1');
      expect(js, contains('ukPass'));
      expect(js, contains('ukBtn'));
      expect(js, contains('__qfUnlockTried'));
      expect(js, contains('lgUser'));
      expect(js, contains('lgBtn'));
      expect(js, contains('__qfChatLoginTried'));
      expect(js, contains('"pass1"'));
    });

    test('无凭据：不带密码、只改「聊天加密解锁」文案', () {
      final js = buildChatBridgeJs();
      expect(js, contains('var user=null,pass=null'));
      expect(js, contains(kChatUnlockTitle));
      expect(js, contains('这一步不是登录'));
      expect(js, contains('unlock-relabeled'));
    });

    test('空字符串凭据按没存处理', () {
      final js = buildChatBridgeJs(username: '', password: '');
      expect(js, contains('var user=null,pass=null'));
    });
  });
}
