import 'package:flutter_test/flutter_test.dart';
import 'package:qfremote/core/constants.dart';
import 'package:qfremote/services/apk_verify.dart';

/// 装前验签纯函数单测（VM-02）：指纹归一化只容大小写与分隔符，
/// 内容必须与官方证书指纹 64 位 hex 全等；包名不符、多签名者任一
/// 不符、签名者为空，一律拒绝。
void main() {
  const wrongFingerprint =
      '0000000000000000000000000000000000000000000000000000000000000000';

  group('normalizeApkCertSha256', () {
    test('接受大小写与冒号格式，且不改变指纹内容', () {
      const upperColon =
          'A3:FD:E2:75:F4:6B:4E:47:06:48:C8:E3:FB:C0:59:4C:E4:96:EB:17:B8:FA:52:F4:DA:9B:F2:AF:7B:BF:14:1F';

      expect(normalizeApkCertSha256(upperColon), kExpectedApkCertSha256);
    });

    test('错误指纹仍不会被归一化成期望值', () {
      expect(
        normalizeApkCertSha256(wrongFingerprint),
        isNot(kExpectedApkCertSha256),
      );
    });
  });

  group('isExpectedApkIdentity', () {
    test('包名不符拒绝', () {
      expect(
        isExpectedApkIdentity(
          packageName: 'com.evil.android',
          signerCertSha256s: const [kExpectedApkCertSha256],
        ),
        false,
      );
    });

    test('单签名者正确通过', () {
      expect(
        isExpectedApkIdentity(
          packageName: kExpectedApkPackageName,
          signerCertSha256s: const [kExpectedApkCertSha256],
        ),
        true,
      );
    });

    test('多签名者任一不符即整包拒绝', () {
      expect(
        isExpectedApkIdentity(
          packageName: kExpectedApkPackageName,
          signerCertSha256s: const [
            kExpectedApkCertSha256,
            wrongFingerprint,
          ],
        ),
        false,
      );
    });

    test('QF-10：双签轮换窗口——新旧双签包通过，旧单签仍通过', () {
      const newFingerprint =
          '1111111111111111111111111111111111111111111111111111111111111111';
      const allowed = [kExpectedApkCertSha256, newFingerprint];
      // 新旧双签过渡期的包：两位签名者都在白名单内。
      expect(
        isExpectedApkIdentity(
          packageName: kExpectedApkPackageName,
          signerCertSha256s: const [kExpectedApkCertSha256, newFingerprint],
          expectedCertSha256s: allowed,
        ),
        true,
      );
      // 只剩新证书单签的包：同样通过（轮换完成）。
      expect(
        isExpectedApkIdentity(
          packageName: kExpectedApkPackageName,
          signerCertSha256s: const [newFingerprint],
          expectedCertSha256s: allowed,
        ),
        true,
      );
      // 旧单签包：仍通过（过渡期内旧证书未下线）。
      expect(
        isExpectedApkIdentity(
          packageName: kExpectedApkPackageName,
          signerCertSha256s: const [kExpectedApkCertSha256],
          expectedCertSha256s: allowed,
        ),
        true,
      );
    });

    test('QF-10：附加自签证书仍拒绝（U-3 口径不变），白名单异常也拒绝', () {
      const newFingerprint =
          '1111111111111111111111111111111111111111111111111111111111111111';
      const allowed = [kExpectedApkCertSha256, newFingerprint];
      // 攻击者给合法包附加一张自签证书：附加的那位不在名单内。
      expect(
        isExpectedApkIdentity(
          packageName: kExpectedApkPackageName,
          signerCertSha256s: const [kExpectedApkCertSha256, wrongFingerprint],
          expectedCertSha256s: allowed,
        ),
        false,
      );
      // 白名单为空或含非法指纹：一律拒绝，不放行。
      expect(
        isExpectedApkIdentity(
          packageName: kExpectedApkPackageName,
          signerCertSha256s: const [kExpectedApkCertSha256],
          expectedCertSha256s: const [],
        ),
        false,
      );
      expect(
        isExpectedApkIdentity(
          packageName: kExpectedApkPackageName,
          signerCertSha256s: const [kExpectedApkCertSha256],
          expectedCertSha256s: const ['not-a-sha256'],
        ),
        false,
      );
    });

    test('签名者为空拒绝', () {
      expect(
        isExpectedApkIdentity(
          packageName: kExpectedApkPackageName,
          signerCertSha256s: const [],
        ),
        false,
      );
    });

    test('指纹带冒号但内容正确仍通过', () {
      const upperColon =
          'A3:FD:E2:75:F4:6B:4E:47:06:48:C8:E3:FB:C0:59:4C:E4:96:EB:17:B8:FA:52:F4:DA:9B:F2:AF:7B:BF:14:1F';

      expect(
        isExpectedApkIdentity(
          packageName: kExpectedApkPackageName,
          signerCertSha256s: const [upperColon],
        ),
        true,
      );
    });
  });
}
