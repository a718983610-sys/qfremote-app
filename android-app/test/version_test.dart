import 'package:flutter_test/flutter_test.dart';
import 'package:qfremote/core/version.dart';

void main() {
  group('compareVersions', () {
    test('相等', () {
      expect(compareVersions('1.0.4', '1.0.4'), 0);
      expect(compareVersions('1.0', '1.0.0'), 0);
    });
    test('更高/更低', () {
      expect(compareVersions('1.0.5', '1.0.4'), 1);
      expect(compareVersions('1.0.4', '1.0.5'), -1);
      expect(compareVersions('1.1.0', '1.0.9'), 1);
      expect(compareVersions('2.0.0', '1.9.9'), 1);
      expect(compareVersions('1.0.10', '1.0.9'), 1); // 数字段比较，不是字符串比较
    });
    test('isNewerVersion', () {
      expect(isNewerVersion('1.0.5', '1.0.4'), isTrue);
      expect(isNewerVersion('1.0.4', '1.0.4'), isFalse);
      expect(isNewerVersion('1.0.3', '1.0.4'), isFalse);
    });
  });
}
