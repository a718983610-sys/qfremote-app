import 'dart:io';

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

  group('DC-C：旧版下载残留清理 pruneStaleDownloadFiles', () {
    test('删旧版 .part 与旧版 APK，留当前目标与无关文件', () async {
      final dir = await Directory.systemTemp.createTemp('qf-prune-');
      addTearDown(() => dir.delete(recursive: true));
      Future<File> mk(String name) async {
        final f = File('${dir.path}/$name');
        await f.writeAsBytes([1, 2, 3]);
        return f;
      }

      final stalePart =
          await mk('aaaaaaaa_QFRemote-v2.4.5.apk.part');
      final staleApk = await mk('QFRemote-v2.4.5.apk');
      final keepPart = await mk('01234567_QFRemote-v3.0.0.apk.part');
      final keepDest = await mk('QFRemote-v3.0.0.apk');
      final other = await mk('notes.txt');

      await UpdateService.pruneStaleDownloadFiles(dir,
          keepPartName: '01234567_QFRemote-v3.0.0.apk.part',
          keepDestName: 'QFRemote-v3.0.0.apk');

      expect(await stalePart.exists(), isFalse);
      expect(await staleApk.exists(), isFalse);
      expect(await keepPart.exists(), isTrue);
      expect(await keepDest.exists(), isTrue);
      expect(await other.exists(), isTrue);
    });
  });
}
