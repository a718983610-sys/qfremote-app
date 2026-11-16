import 'package:flutter_test/flutter_test.dart';
import 'package:qfremote/core/constants.dart';
import 'package:qfremote/core/svc_urls.dart';
import 'package:qfremote/services/points.dart';

void main() {
  group('SvcUrls.parseProductWeb', () {
    test('取 web 四字段（自家源）', () {
      final m = SvcUrls.parseProductWeb(
          '{"web":{"forumUrl":"https://app.qfremote.top/forum","registerUrl":"https://app.qfremote.top/register","pointsUrl":"https://app.qfremote.top/points","adminUrl":"https://app.qfremote.top/admin"}}');
      expect(m['forumUrl'], 'https://app.qfremote.top/forum');
      expect(m['registerUrl'], 'https://app.qfremote.top/register');
      expect(m['pointsUrl'], 'https://app.qfremote.top/points');
      expect(m['adminUrl'], 'https://app.qfremote.top/admin');
    });

    test('B15：非白名单源一律丢弃（任意 https 不再信任）', () {
      final m = SvcUrls.parseProductWeb(
          '{"web":{"forumUrl":"https://a.example/forum","registerUrl":"https://evil.example/register","pointsUrl":"https://app.qfremote.top.evil.example/points","adminUrl":"https://app.qfremote.top/admin"}}');
      expect(m, {'adminUrl': 'https://app.qfremote.top/admin'});
      expect(SvcUrls.isTrustedSvcUrl('https://evil.example/points'), isFalse);
      expect(SvcUrls.isTrustedSvcUrl('https://app.qfremote.top.evil.example/x'),
          isFalse);
      // F-06：子域通配已收回——子域不再信任，须回落写死兜底。
      expect(SvcUrls.isTrustedSvcUrl('https://sub.app.qfremote.top/points'),
          isFalse);
      expect(SvcUrls.isTrustedSvcUrl('http://app.qfremote.top/points'), isFalse);
      expect(SvcUrls.isTrustedSvcUrl('https://trycloudflare.com/x'), isFalse);
    });

    test('F-06：精确 origin 白名单——只认写死表，不许子域／任意端口', () {
      // 显式 :443 与默认端口同一 origin，认。
      expect(SvcUrls.isTrustedSvcUrl('https://app.qfremote.top:443/points'),
          isTrue);
      expect(SvcUrls.isTrustedSvcUrl('https://app.qfremote.top/points'),
          isTrue);
      // 非默认端口、子域、裸域、userinfo 一律拒。
      expect(SvcUrls.isTrustedSvcUrl('https://app.qfremote.top:8443/points'),
          isFalse);
      expect(SvcUrls.isTrustedSvcUrl('https://app.qfremote.top:80/points'),
          isFalse);
      expect(SvcUrls.isTrustedSvcUrl('https://tun.qfremote.top/points'),
          isFalse);
      expect(SvcUrls.isTrustedSvcUrl('https://qfremote.top/points'), isFalse);
      expect(
          SvcUrls.isTrustedSvcUrl('https://user@app.qfremote.top/points'),
          isFalse);
      expect(SvcUrls.isTrustedSvcUrl('https://APP.QFREMOTE.TOP/points'),
          isTrue);
      // 投毒 product.json：子域 points 地址被丢弃、回落兜底。
      final m = SvcUrls.parseProductWeb(
          '{"web":{"pointsUrl":"https://evil-sub.app.qfremote.top/points","forumUrl":"https://app.qfremote.top:8443/forum"}}');
      expect(m, isEmpty);
      // origin 校验口径与 URL 校验一致。
      expect(SvcUrls.isTrustedSvcOrigin('https://app.qfremote.top'), isTrue);
      expect(SvcUrls.isTrustedSvcOrigin('https://app.qfremote.top:443'),
          isTrue);
      expect(SvcUrls.isTrustedSvcOrigin('https://app.qfremote.top:8443'),
          isFalse);
      expect(SvcUrls.isTrustedSvcOrigin('https://sub.app.qfremote.top'),
          isFalse);
      expect(SvcUrls.isTrustedSvcOrigin(null), isFalse);
      // extOrigin 恒为精确生产源。
      expect(SvcUrls.instance.extOrigin, 'https://app.qfremote.top');
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
    test('H-1：兜底与官网/解析源全部落正式域名、无旧隧道与旧托管页', () {
      expect(kForumUrl, 'https://app.qfremote.top/forum');
      expect(kRegisterUrl, 'https://app.qfremote.top/register');
      expect(kTermsUrl, 'https://app.qfremote.top/terms');
      expect(kPointsUrlFallback, 'https://app.qfremote.top/points');
      expect(kAdminUrlFallback, 'https://app.qfremote.top/admin');
      expect(kWebsiteUrl, 'https://qfremote.top/');
      expect(kProductJsonUrl, 'https://qfremote.top/product.json');
    });

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
      expect(urls.isOwnOrigin('https://app.qfremote.top/logout'), isTrue);
      expect(urls.isOwnOrigin('https://app.qfremote.top/friends'), isTrue);
      expect(urls.isOwnOrigin(kForumUrl), isTrue);
      expect(urls.isOwnOrigin('https://evil.example.com/logout'), isFalse);
      expect(urls.isOwnOrigin('https://app.qfremote.top:8443/logout'), isFalse);
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
