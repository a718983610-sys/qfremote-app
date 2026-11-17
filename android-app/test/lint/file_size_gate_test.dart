// 【冻结注明 v6 冻结⑮】本文件在纯冻结树下跳过：
// 它强制要求未冻结的第三批／Week 2 文件 docs/REFACTOR-LIST.md，
// 纯冻结树下该文件不存在、测试失败。跳过期间该 lint 门不生效。
// 第三批合入后恢复本文件。
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// A-10：单文件超 1,000 行进重构清单，不许再往里加功能。
///
/// 规则：`lib/` 下任一 Dart 文件超过 1,000 行时，必须已登记在
/// `docs/REFACTOR-LIST.md`（含拆分方向与 owner）；未登记即失败。
/// 已登记的文件若已缩回 1,000 行以下，测试同样失败（清单过期，须销账）。
/// 本测试只拦“新增超大文件”与“清单失真”，不要求当轮拆掉历史大文件
/// （main.dart 4250 行、theme.dart 1242 行已登记，见清单）。
void main() {
  test('单文件行数门：超 1000 行的文件必须在重构清单里', () {
    final listFile = File('docs/REFACTOR-LIST.md');
    expect(listFile.existsSync(), isTrue,
        reason: 'docs/REFACTOR-LIST.md 不存在');
    final listed = listFile
        .readAsStringSync()
        .split('\n')
        // 只认表格行（`| lib/...dart | ...`），正文里提到的路径不算登记。
        .where((l) => l.trimLeft().startsWith('| lib/'))
        .map((l) {
          final m = RegExp(r'(lib/\S+\.dart)').firstMatch(l);
          return m?.group(1);
        })
        .whereType<String>()
        .toSet();

    final violations = <String>[];
    final stale = <String>[];
    final lib = Directory('lib');
    for (final file in lib
        .listSync(recursive: true)
        .whereType<File>()
        // 生成文件（drift/build_runner 产物）不进门：行数由生成器决定。
        .where((f) =>
            f.path.endsWith('.dart') && !f.path.endsWith('.g.dart'))) {
      final lines = file.readAsLinesSync().length;
      final rel = file.path.replaceFirst(
          RegExp(r'^.*?android-app/'), '');
      if (lines > 1000 && !listed.contains(rel)) {
        violations.add('$rel：$lines 行，未进重构清单');
      }
      if (lines <= 1000 && listed.contains(rel)) {
        stale.add('$rel：已缩回 $lines 行，清单须销账');
      }
    }
    expect(violations, isEmpty, reason: violations.join('\n'));
    expect(stale, isEmpty, reason: stale.join('\n'));
  });
}
