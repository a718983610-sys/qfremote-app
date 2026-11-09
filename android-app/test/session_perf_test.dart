import 'package:flutter_test/flutter_test.dart';
import 'package:qfremote/core/session_perf.dart';

void main() {
  group('SessionPerfTracker（A8 返修）', () {
    test('未采样时三项度量全写「未度量」，不编数字', () {
      final t = SessionPerfTracker();
      expect(t.lastFps, isNull);
      expect(t.lastProbeRttMs, isNull);
      expect(t.echoLatencyMs, isNull);
      expect(t.hudText(), contains('未度量'));
      expect(t.hudText(), contains('输入→回显：未度量'));
      expect(t.diagnosticsLine(), contains('会话性能：'));
    });

    test('采样后 HUD 写实测帧率与探针往返，回显仍为未度量', () {
      final t = SessionPerfTracker();
      t.recordProbe(rttMs: 42, fps: 57);
      expect(t.hudText(), contains('57 fps'));
      expect(t.hudText(), contains('42 ms'));
      expect(t.hudText(), contains('输入→回显：未度量'));
      expect(t.echoLatencyMs, isNull);
    });

    test('画质档位：normal 1 秒一拍，low 2 秒一拍', () {
      final t = SessionPerfTracker();
      expect(t.quality, SessionQuality.normal);
      expect(t.probeIntervalSec, 1);
      t.quality = SessionQuality.low;
      expect(t.probeIntervalSec, 2);
      expect(t.hudText(), contains('低画质'));
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
