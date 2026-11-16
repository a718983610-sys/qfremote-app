/// 设计 token 生成器（S-029，与 S-132 同方案）。
///
/// 用法（在仓库根执行）：
///
/// ```sh
/// dart design-tokens/generate.dart            # 生成 Dart 常量＋CSS token 层
/// dart design-tokens/generate.dart --check    # 只校验：tokens.json 与
///                                             # 现行 qf-tokens-*.css／
///                                             # theme.dart 是否漂移，不写文件
/// ```
///
/// 生成物：
///
/// * `android-app/lib/ui/generated_tokens.dart`——Dart 常量（QfDesignTokens），
///   安卓侧以此为准；theme.dart 的 QfPalette／QfScale 与之逐值对齐，
///   由 `test/design_tokens_test.dart` 锁死，漂移即测试失败。
/// * `server/webapp/qf-tokens-generated.css`——CSS token 层（:root＋
///   [data-theme="dark"]）。已对齐的 token（状态色、链接、字阶、间距、
///   圆角、动效）由此生成；仍有分歧的 token（brand、textPrimary、
///   textSecondary 等，tokens.json 里标 DIVERGENT）在生成时跳过、
///   不覆盖任何一边，统一等 S-132 方案裁决。
///
/// 注意：`qf-tokens-<hash>.css` 是构建期哈希产物，本脚本不改它；
/// --check 读它只做漂移比对。
import 'dart:convert';
import 'dart:io';

const _tokensPath = 'design-tokens/tokens.json';
const _dartOut = 'android-app/lib/ui/generated_tokens.dart';
const _cssOut = 'server/webapp/qf-tokens-generated.css';

/// 已对齐、可生成的颜色 token（key → CSS 变量名）。
/// 注意：只有经 --check 在现行 qf-tokens-*.css 里逐变量绑定比对过的
/// token 才进此表；分歧 token（brand／link／linkUnderline／surface1／
/// textPrimary／textSecondary）只在 tokens.json 登记，不进生成。
const _alignedColors = <String, String>{
  'success': '--success',
  'danger': '--danger',
  'warning': '--warning',
  'info': '--info',
  'surface0': '--surface-0',
};

String _dartColor(String hex) {
  final h = hex.replaceFirst('#', '').toUpperCase();
  return 'Color(0xFF$h)';
}

void main(List<String> args) {
  final checkOnly = args.contains('--check');
  final tokensFile = File('$_tokensPath');
  if (!tokensFile.existsSync()) {
    stderr.writeln('tokens.json 不存在：$_tokensPath（请在仓库根执行）');
    exit(2);
  }
  final tokens =
      jsonDecode(tokensFile.readAsStringSync()) as Map<String, dynamic>;
  final colors = tokens['color'] as Map<String, dynamic>;
  final fontSize = tokens['fontSize'] as Map<String, dynamic>;
  final spacing = tokens['spacing'] as Map<String, dynamic>;
  final radius = tokens['radius'] as Map<String, dynamic>;
  final motion = tokens['motion'] as Map<String, dynamic>;

  final failures = <String>[];
  final warnings = <String>[];

  // 分歧 token：只报，不生成、不覆盖。
  for (final entry in colors.entries) {
    final note = (entry.value as Map<String, dynamic>)['note'] as String? ?? '';
    if (note.startsWith('DIVERGENT')) {
      warnings.add('DIVERGENT ${entry.key}：$note');
    }
  }

  // ---- 生成 Dart 常量 ----
  final dart = StringBuffer()
    ..writeln('// 由 design-tokens/generate.dart 从 design-tokens/tokens.json 生成，')
    ..writeln('// 不要手工改本文件；改 tokens.json 后重新运行生成器。')
    ..writeln('// S-029：设计 token 单一来源的 Dart 侧产物。')
    ..writeln("import 'package:flutter/material.dart';")
    ..writeln()
    ..writeln('/// 设计 token 单一来源（tokens.json v${tokens['version']}）的 Dart 常量。')
    ..writeln('/// QfPalette／QfScale 须与此逐值对齐（test/design_tokens_test.dart 锁死）。')
    ..writeln('abstract final class QfDesignTokens {');
  for (final entry in colors.entries) {
    final v = entry.value as Map<String, dynamic>;
    final name = entry.key;
    dart
      ..writeln('  static const Color ${name}Light = ${_dartColor(v['light'] as String)};')
      ..writeln('  static const Color ${name}Dark = ${_dartColor(v['dark'] as String)};');
  }
  for (final entry in fontSize.entries) {
    dart.writeln('  static const double ${entry.key} = ${(entry.value as num).toDouble()};');
  }
  for (final entry in spacing.entries) {
    dart.writeln('  static const double ${entry.key} = ${(entry.value as num).toDouble()};');
  }
  for (final entry in radius.entries) {
    dart.writeln('  static const double ${entry.key} = ${(entry.value as num).toDouble()};');
  }
  for (final entry in motion.entries) {
    dart.writeln('  static const int ${entry.key} = ${entry.value};');
  }
  dart.writeln('}');

  // ---- 生成 CSS token 层（只含已对齐 token） ----
  final css = StringBuffer()
    ..writeln('/* 由 design-tokens/generate.dart 从 design-tokens/tokens.json 生成，')
    ..writeln('   不要手工改本文件。S-029：设计 token 单一来源的 CSS 侧产物。')
    ..writeln('   只含已对齐 token；分歧 token（brand／textPrimary／textSecondary 等）')
    ..writeln('   不在此生成、不覆盖任何一边，统一等 S-132 方案裁决。*/')
    ..writeln(':root{');
  for (final entry in _alignedColors.entries) {
    final v = colors[entry.key] as Map<String, dynamic>;
    css.writeln('${entry.value}:${(v['light'] as String).toLowerCase()};');
  }
  for (final entry in fontSize.entries) {
    css.writeln('--${entry.key}:${entry.value}px;');
  }
  for (final entry in spacing.entries) {
    css.writeln('--${entry.key}:${entry.value}px;');
  }
  for (final entry in radius.entries) {
    css.writeln('--${entry.key}:${entry.value}px;');
  }
  css
    ..writeln('}')
    ..writeln('[data-theme="dark"]{');
  for (final entry in _alignedColors.entries) {
    final v = colors[entry.key] as Map<String, dynamic>;
    css.writeln('${entry.value}:${(v['dark'] as String).toLowerCase()};');
  }
  css.writeln('}');

  // ---- --check：与现行 qf-tokens-<hash>.css／theme.dart 比对漂移 ----
  if (checkOnly) {
    final webapp = Directory('server/webapp');
    var cssFound = false;
    if (webapp.existsSync()) {
      for (final f in webapp.listSync()) {
        if (f is File && f.path.contains('qf-tokens-') && f.path.endsWith('.css')) {
          cssFound = true;
          final text = f.readAsStringSync().toLowerCase();
          for (final entry in _alignedColors.entries) {
            final v = colors[entry.key] as Map<String, dynamic>;
            for (final theme in ['light', 'dark']) {
              final hex = (v[theme] as String).toLowerCase();
              // 变量绑定比对（--success:#16a34a），不是裸 hex 出现——
              // 裸 hex 会在无关变量里命中，造成假通过。
              if (!text.contains('${entry.value}:$hex')) {
                failures.add('CSS 漂移：${entry.key}.$theme ${entry.value}:$hex 在 ${f.path} 中未找到');
              }
            }
          }
        }
      }
    }
    if (!cssFound) failures.add('未找到 server/webapp/qf-tokens-*.css');
    final themeFile = File('android-app/lib/ui/theme.dart');
    if (themeFile.existsSync()) {
      final text = themeFile.readAsStringSync();
      for (final entry in fontSize.entries) {
        if (!text.contains('${entry.key} = ${entry.value}') &&
            !text.contains('${entry.key}=${entry.value}')) {
          failures.add('theme.dart 漂移：QfScale 缺 ${entry.key}=${entry.value}');
        }
      }
      for (final entry in spacing.entries) {
        if (!text.contains('${entry.key} = ${entry.value}') &&
            !text.contains('${entry.key}=${entry.value}')) {
          failures.add('theme.dart 漂移：QfScale 缺 ${entry.key}=${entry.value}');
        }
      }
    } else {
      failures.add('未找到 android-app/lib/ui/theme.dart');
    }
    for (final w in warnings) {
      stdout.writeln('WARN $w');
    }
    if (failures.isEmpty) {
      stdout.writeln('tokens --check 通过：已对齐 token 无漂移（${warnings.length} 项已知分歧待 S-132 裁决）。');
    } else {
      for (final f in failures) {
        stderr.writeln('FAIL $f');
      }
      exit(1);
    }
    return;
  }

  File(_dartOut).writeAsStringSync(dart.toString());
  File(_cssOut).writeAsStringSync(css.toString());
  stdout.writeln('已生成 $_dartOut');
  stdout.writeln('已生成 $_cssOut');
  for (final w in warnings) {
    stdout.writeln('WARN $w');
  }
  stdout.writeln('提示：改动 tokens.json 后重新运行本脚本；漂移检查用 --check。');
}
