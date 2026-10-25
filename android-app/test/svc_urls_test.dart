import 'package:flutter_test/flutter_test.dart';
import 'package:qfremote/core/constants.dart';
import 'package:qfremote/core/svc_urls.dart';
import 'package:qfremote/services/points.dart';

void main() {
  group('SvcUrls.parseProductWeb', () {
    test('取 web 四字段', () {
      final m = SvcUrls.parseProductWeb(
          '{"web":{"forumUrl":"https://a.example/forum","registerUrl":"https://a.example/register","pointsUrl":"https://a.example/points","adminUrl":"https://a.example/admin"}}');
      expect(m['forumUrl'], 'https://a.example/forum');
      expect(m['registerUrl'], 'https://a.example/register');
      expect(m['pointsUrl'], 'https://a.example/points');
      expect(m['adminUrl'], 'https://a.example/admin');
    });

    test('缺字段/非 https 值被丢弃', () {
      final m = SvcUrls.parseProductWeb(
          '{"web":{"forumUrl":"http://insecure.example/forum","pointsUrl":42}}');
      expect(m, isEmpty);
    });

    test('格式不对抛异常', () {
      expect(() => SvcUrls.parseProductWeb('[]'), throwsFormatException);
      expect(() => SvcUrls.parseProductWeb('{}'), throwsFormatException);
    });
  });

  group('SvcUrls 兜底', () {
    test('未解析时全部走兜底常量', () {
      final u = SvcUrls.instance;
      expect(u.friendsUrl, kFriendsUrl);
      expect(u.forumUrl, kForumUrl);
      expect(u.registerUrl, kRegisterUrl);
      expect(u.pointsUrl, kPointsUrlFallback);
      expect(u.adminUrl, kAdminUrlFallback);
    });

    test('管理登录地址带令牌且转义', () {
      expect(SvcUrls.instance.adminLoginUrl('a b&c'),
          '$kAdminUrlFallback/login?token=a+b%26c');
    });

    test('isOwnOrigin：自有源认、外站拒（/logout 误触发防线）', () {
      final urls = SvcUrls.instance;
      expect(urls.isOwnOrigin('https://54.248.9.192:8443/logout'), isTrue);
      expect(urls.isOwnOrigin('https://54.248.9.192:8445/friends'), isTrue);
      expect(urls.isOwnOrigin(kForumUrl), isTrue);
      expect(urls.isOwnOrigin('https://evil.example.com/logout'), isFalse);
      expect(urls.isOwnOrigin('https://54.248.9.192:9999/logout'), isFalse);
      expect(urls.isOwnOrigin(null), isFalse);
      expect(urls.isOwnOrigin(':::bad'), isFalse);
    });
  });

  group('PointsInfo.parse', () {
    test('正常字段', () {
      final info = PointsInfo.parse('{"displayText":"3天","points":12}');
      expect(info.displayText, '3天');
      expect(info.points, 12);
    });

    test('缺字段给 null（关于页显示 —）', () {
      final info = PointsInfo.parse('{}');
      expect(info.displayText, isNull);
      expect(info.points, isNull);
    });
  });
}
