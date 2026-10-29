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
