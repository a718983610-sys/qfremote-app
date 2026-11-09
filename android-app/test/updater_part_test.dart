import 'package:flutter_test/flutter_test.dart';
import 'package:qfremote/core/manifest.dart';
import 'package:qfremote/services/updater.dart';

ReleaseEntry _entry(String sha) => ReleaseEntry(
      version: '2.4.5',
      notes: '',
      url: 'https://app.qfremote.top/QFRemote-v2.4.5.apk',
      sha256: sha,
      size: 1000,
    );

void main() {
  group('UpdateService .part 命名与过期（B17 返修）', () {
    test('part 文件名带 sha256 前 8 位前缀，换版本即新名', () {
      const shaA = '0123456789abcdef0123456789abcdef'
          '0123456789abcdef0123456789abcdef';
      const shaB = 'fedcba9876543210fedcba9876543210'
          'fedcba9876543210fedcba9876543210';
      expect(UpdateService.partFileName(_entry(shaA)),
          '01234567_QFRemote-v2.4.5.apk.part');
      expect(UpdateService.partFileName(_entry(shaB)),
          'fedcba98_QFRemote-v2.4.5.apk.part');
      expect(UpdateService.partFileName(_entry(shaA)),
          isNot(UpdateService.partFileName(_entry(shaB))));
    });

    test('isPartExpired：24 小时内不过期，超 24 小时过期', () {
      final now = DateTime(2026, 11, 10, 12, 0, 0);
      expect(
          UpdateService.isPartExpired(
              now.subtract(const Duration(hours: 23, minutes: 59)),
              now: now),
          isFalse);
      expect(
          UpdateService.isPartExpired(
              now.subtract(const Duration(hours: 24, minutes: 1)),
              now: now),
          isTrue);
    });
  });
}
