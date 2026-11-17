// 【冻结注明 v6 冻结⑮】本文件在纯冻结树下跳过：
// 它 import lib/core/manifest.dart，而 manifest.dart:4 import 未冻结的
// 第二批文件 lib/core/release_signature.dart，纯冻结树下整个文件加载失败。
// 第二批合入后恢复本文件。
import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:qfremote/core/manifest.dart';
import 'package:qfremote/core/update_policy.dart';
import 'package:qfremote/main.dart' show pageDownloadFailureText;
import 'package:qfremote/services/probe.dart';
import 'package:qfremote/ui/about.dart';
import 'package:qfremote/ui/theme.dart';

/// H-2 回归：关于页检查更新四态如实显示——失败/清单不完整绝不冒充
/// 「已经是最新版」；H-5 回归：页面下载失败文案映射不带异常原文。
ReleaseEntry _entry() => ReleaseEntry(
      version: '9.9.9',
      notes: '',
      url: 'https://app.qfremote.top/dl/QFRemote-v9.9.9.apk',
      sha256: 'a' * 64,
      size: 1000,
    );

AboutDeps _deps(Future<AboutUpdateResult> Function() detail) => AboutDeps(
      currentVersion: '2.3.2',
      palette: QfPalette(QfThemeMode.blue),
      probeNow: () async => ProbeResult(
          ok: true, at: DateTime.now(), elapsedMs: 3, statusCode: 200),
      checkUpdate: () async => null,
      checkUpdateDetail: detail,
      download: (entry, cb) async => File('/tmp/x.apk'),
      openInstaller: (_) async {},
      diagnosticsText: () async => '诊断',
    );

Future<void> _openAndCheck(WidgetTester tester, AboutDeps deps) async {
  await tester.pumpWidget(MaterialApp(
    home: Scaffold(
      body: Builder(
        builder: (ctx) => Center(
          child: FilledButton(
            onPressed: () => showQfAboutDialog(ctx, deps),
            child: const Text('打开关于'),
          ),
        ),
      ),
    ),
  ));
  await tester.tap(find.text('打开关于'));
  await tester.pumpAndSettle();
  await tester.scrollUntilVisible(find.text('检查更新'), 120);
  await tester.tap(find.text('检查更新'));
  await tester.pumpAndSettle();
}

void main() {
  group('updateCheckText 四态文案', () {
    test('逐态对表', () {
      expect(updateCheckText(AboutUpdateResult.failed()),
          '检查更新失败：无法连接服务器，请检查网络后重试。');
      expect(updateCheckText(AboutUpdateResult.manifestIncomplete()),
          '检查更新失败：更新信息不完整，请稍后重试。');
      expect(updateCheckText(AboutUpdateResult.upToDate()), '已经是最新版');
      expect(updateCheckText(AboutUpdateResult.available(_entry())),
          '发现新版 v9.9.9');
    });
  });

  group('关于页检查更新（H-2）', () {
    testWidgets('失败态：显示失败文案、绝不显示「已经是最新版」', (tester) async {
      await _openAndCheck(tester, _deps(() async => AboutUpdateResult.failed()));
      expect(find.text('检查更新失败：无法连接服务器，请检查网络后重试。'),
          findsOneWidget);
      expect(find.text('已经是最新版'), findsNothing);
    });

    testWidgets('清单不完整态：显示不完整文案、绝不显示「已经是最新版」',
        (tester) async {
      await _openAndCheck(
          tester, _deps(() async => AboutUpdateResult.manifestIncomplete()));
      expect(find.text('检查更新失败：更新信息不完整，请稍后重试。'),
          findsOneWidget);
      expect(find.text('已经是最新版'), findsNothing);
    });

    testWidgets('真最新态：显示「已经是最新版」', (tester) async {
      await _openAndCheck(tester, _deps(() async => AboutUpdateResult.upToDate()));
      expect(find.text('已经是最新版'), findsOneWidget);
    });

    testWidgets('有新版态：显示新版文案与下载按钮', (tester) async {
      await _openAndCheck(
          tester, _deps(() async => AboutUpdateResult.available(_entry())));
      expect(find.text('发现新版 v9.9.9'), findsOneWidget);
      expect(find.text('下载更新'), findsOneWidget);
    });
  });

  group('pageDownloadFailureText（H-5）', () {
    test('逐类型对表、原文不上屏', () {
      expect(pageDownloadFailureText(const FormatException('下载失败，服务器返回异常状态，请稍后重试。')),
          '下载失败，服务器返回异常状态，请稍后重试。');
      expect(pageDownloadFailureText(TimeoutException('slow')),
          '下载中断，网络不稳定，请重新下载。');
      expect(
          pageDownloadFailureText(
              const SocketException('Connection refused (OS Error)')),
          '下载失败：无法连接服务器，请检查网络后重试。');
      expect(pageDownloadFailureText(const HttpException('HTTP 500')),
          '下载失败：无法连接服务器，请检查网络后重试。');
      expect(
          pageDownloadFailureText(
              const FileSystemException('No space left on device')),
          '保存失败，请检查存储空间或权限后重试。');
      expect(pageDownloadFailureText(StateError('weird internals')),
          '下载失败，请稍后重试。');
    });
  });
}
