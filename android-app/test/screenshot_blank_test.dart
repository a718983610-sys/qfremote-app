// 【冻结注明 v6 冻结⑮】本文件在纯冻结树下跳过：
// 它 import lib/main.dart，而 main.dart import manifest.dart，
// manifest.dart:4 import 未冻结的第二批文件 release_signature.dart，
// 纯冻结树下整个文件加载失败。第二批合入后恢复本文件。
import 'package:flutter_test/flutter_test.dart';
import 'package:qfremote/main.dart' show isBlankSample;

void main() {
  group('isBlankSample（B20 返修：九宫格＋仅纯黑/纯白判空白）', () {
    test('9 点全纯黑判空白', () {
      expect(isBlankSample(List.filled(9, 0x000000FF)), isTrue);
    });

    test('9 点全纯白判空白', () {
      expect(isBlankSample(List.filled(9, 0xFFFFFFFF)), isTrue);
    });

    test('9 点全同色红（合法均匀画面）不判空白', () {
      // RGBA 红 (255,0,0,255) 大端值 0xFF0000FF
      expect(isBlankSample(List.filled(9, 0xFF0000FF)), isFalse);
    });

    test('9 点全同色灰不判空白', () {
      expect(isBlankSample(List.filled(9, 0x808080FF)), isFalse);
    });

    test('9 点中有一点不同不判空白', () {
      final pixels = List.filled(9, 0x000000FF);
      pixels[4] = 0x000000FF + 1;
      expect(isBlankSample(pixels), isFalse);
    });

    test('空采样不判空白', () {
      expect(isBlankSample(const []), isFalse);
    });
  });
}
