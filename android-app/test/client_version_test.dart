import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:qfremote/build_info.dart';
import 'package:qfremote/core/client_header.dart';

void main() {
  group('客户端版本头（2.3.2 互联窗观察）', () {
    test('头名写死为 x-qf-client-version', () {
      expect(kClientVersionHeader, 'x-qf-client-version');
    });

    test('kAppVersion 与 pubspec.yaml 的 version 逐字一致（单一事实源守卫）', () {
      final pubspec = File('pubspec.yaml').readAsStringSync();
      final m = RegExp(r'^version:\s*([0-9]+\.[0-9]+\.[0-9]+)\+([0-9]+)\s*$',
              multiLine: true)
          .firstMatch(pubspec);
      expect(m, isNotNull, reason: 'pubspec.yaml 应有 version: x.y.z+code 行');
      expect(m!.group(1), kAppVersion,
          reason: 'lib/build_info.dart 的 kAppVersion 必须与 pubspec 同步改');
    });

    test('版本号格式为三段数字', () {
      expect(kAppVersion, matches(RegExp(r'^\d+\.\d+\.\d+$')));
    });
  });
}
