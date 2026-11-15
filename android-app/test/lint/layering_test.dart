import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// A-10：架构规则写成测试（Element X Konsist / Invoice Ninja layering_test
/// 模式）。分层靠测试强制，不靠自觉。
///
/// 规则：
/// 1. `lib/data` 不许引用 `lib/ui`（数据层不知道 UI 的存在）。
/// 2. `lib/data` 不许引用 `package:flutter/material.dart` /
///    `package:flutter/widgets.dart`（数据层只许用 foundation，如
///    ChangeNotifier）；UI 依赖只许出现在 ui/app 层。
/// 3. `lib/ui` 不许直接引用 `lib/data/db`（UI 只经 Repository/ViewModel
///    读数，不许直连数据库）。
/// 4. A-06 单一桥接：全仓只许 `lib/services/qf_bridge.dart` 构造
///    MethodChannel；其余 Dart 文件出现 `MethodChannel(` 即失败。
///    （测试替身用 TestDefaultBinaryMessenger，不构造新通道。）
void main() {
  test('分层 lint：数据层不引用 UI，UI 不直连数据库', () {
    final lib = Directory('lib');
    expect(lib.existsSync(), isTrue, reason: '须在 android-app 根目录跑测试');
    final files = lib
        .listSync(recursive: true)
        .whereType<File>()
        .where((f) => f.path.endsWith('.dart'))
        .toList();
    expect(files, isNotEmpty);

    final violations = <String>[];
    for (final file in files) {
      final content = file.readAsStringSync();
      final isData = file.path.contains('/data/');
      final isUi = file.path.contains('/ui/');
      if (isData) {
        if (content.contains("package:qfremote/ui/") ||
            content.contains("import '../ui/") ||
            content.contains("import '../../ui/")) {
          violations.add('${file.path}：数据层引用了 UI 层');
        }
        if (content.contains('package:flutter/material.dart') ||
            content.contains('package:flutter/widgets.dart')) {
          violations.add('${file.path}：数据层引用了 material/widgets');
        }
      }
      if (isUi) {
        if (content.contains("package:qfremote/data/db/") ||
            content.contains("import '../../data/db/") ||
            content.contains("import '../../../data/db/")) {
          violations.add('${file.path}：UI 层直连数据库');
        }
      }
    }
    expect(violations, isEmpty, reason: violations.join('\n'));
  });

  test('单一桥接：只有 qf_bridge.dart 可构造 MethodChannel', () {
    final lib = Directory('lib');
    final offenders = <String>[];
    for (final file in lib
        .listSync(recursive: true)
        .whereType<File>()
        .where((f) => f.path.endsWith('.dart'))) {
      final content = file.readAsStringSync();
      if (content.contains('MethodChannel(') &&
          !file.path.endsWith('services/qf_bridge.dart')) {
        offenders.add(file.path);
      }
    }
    expect(offenders, isEmpty,
        reason: '这些文件自建了 MethodChannel，须走 QfBridge：\n'
            '${offenders.join('\n')}');
  });

  test('新分层代码不写死设计 token 字面量（只扫 A-05 新增目录）', () {
    // 只扫本轮新增的分层目录（老代码 main.dart 等历史包袱在重构清单里，
    // 不由本测试追溯；新代码出现硬编码间距/圆角/时长即失败）。
    final dirs = ['lib/app', 'lib/data', 'lib/ui/core', 'lib/ui/features'];
    final offenders = <String>[];
    final banned = [
      RegExp(r'EdgeInsets\.all\((1[26]|8|24|32)\)'),
      RegExp(r'BorderRadius\.circular\((1[024]|6)\)'),
      RegExp(r'Duration\(milliseconds: (120|200|300)\)'),
    ];
    for (final dir in dirs) {
      final d = Directory(dir);
      if (!d.existsSync()) continue;
      for (final file in d
          .listSync(recursive: true)
          .whereType<File>()
          .where((f) => f.path.endsWith('.dart'))) {
        // design_tokens.dart 本身就是 token 定义的唯一出处，字面量只许出现在这里。
        if (file.path.endsWith('app/design_tokens.dart')) continue;
        final content = file.readAsStringSync();
        for (final re in banned) {
          if (re.hasMatch(content)) {
            offenders.add('${file.path}：命中 $re，须用 QfSpacing/QfRadius/'
                'QfDuration token');
          }
        }
      }
    }
    expect(offenders, isEmpty, reason: offenders.join('\n'));
  });
}
