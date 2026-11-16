import 'package:flutter_test/flutter_test.dart';
import 'package:qfremote/core/session_perf.dart';

void main() {
  group('SessionPerfTracker（A8 返修）', () {
    test('未采样时三项度量全写「未测量」，不编数字', () {
      final t = SessionPerfTracker();
      expect(t.lastFps, isNull);
      expect(t.lastProbeRttMs, isNull);
      expect(t.echoLatencyMs, isNull);
      expect(t.hudText(), contains('未测量'));
      expect(t.hudText(), contains('WebView 渲染估算'));
      expect(t.hudText(), contains('页面探针耗时'));
      expect(t.hudText(), contains('输入→回显延迟：未测量'));
      expect(t.diagnosticsLine(), contains('会话性能：'));
    });

    test('采样后 HUD 写实测渲染估算与页面探针耗时，回显仍为未测量', () {
      final t = SessionPerfTracker();
      t.recordProbe(rttMs: 42, fps: 57);
      expect(t.hudText(), contains('WebView 渲染估算：57 fps'));
      expect(t.hudText(), contains('页面探针耗时：42 ms'));
      expect(t.hudText(), contains('输入→回显延迟：未测量'));
      expect(t.echoLatencyMs, isNull);
    });

    test('画质档位：normal 1 秒一拍，low 2 秒一拍', () {
      final t = SessionPerfTracker();
      expect(t.quality, SessionQuality.normal);
      expect(t.probeIntervalSec, 1);
      expect(t.hudText(), contains('探针采样：标准采样'));
      t.quality = SessionQuality.low;
      expect(t.probeIntervalSec, 2);
      expect(t.hudText(), contains('探针采样：降采样'));
    });

    test('reset 清掉采样值', () {
      final t = SessionPerfTracker();
      t.recordProbe(rttMs: 10, fps: 30);
      t.reset();
      expect(t.lastFps, isNull);
      expect(t.lastProbeRttMs, isNull);
    });
  });
}
