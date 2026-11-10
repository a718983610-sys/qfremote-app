import 'package:flutter_test/flutter_test.dart';
import 'package:qfremote/core/watchdog_core.dart';

/// 假求值器：按脚本返回检测结果，点击计数并可切回 ok（模拟点完恢复）。
class FakeEvaluator implements WatchdogEvaluator {
  String state;
  int clicks = 0;
  int detectCalls = 0;
  FakeEvaluator(this.state);

  @override
  Future<String> detect() async {
    detectCalls++;
    return state;
  }

  @override
  Future<bool> clickReconnect() async {
    clicks++;
    return true;
  }
}

WatchdogCore makeCore(
  FakeEvaluator ev,
  List<WatchdogStatus> events, {
  void Function()? onClick,
}) {
  return WatchdogCore(
    evaluator: ev,
    pollInterval: const Duration(milliseconds: 30),
    confirmScans: 2,
    backoffStart: const Duration(milliseconds: 60),
    backoffMax: const Duration(milliseconds: 120),
    onStatus: events.add,
    onReconnectClick: onClick,
  );
}

Future<void> waitFor(bool Function() cond, {int tries = 100}) async {
  for (var i = 0; i < tries; i++) {
    if (cond()) return;
    await Future<void>.delayed(const Duration(milliseconds: 20));
  }
  fail('等待条件超时');
}

void main() {
  group('WatchdogCore（与 Windows 版 watchdog-test 同口径）', () {
    test('A. 断开：两次确认后自动点一次；恢复后停手、不再乱点', () async {
      final ev = FakeEvaluator('disconnected');
      final events = <WatchdogStatus>[];
      var clickCallbacks = 0;
      final core = makeCore(ev, events, onClick: () => clickCallbacks++);
      core.start();

      // 应自动点一次并进入 reconnecting 状态
      await waitFor(() => ev.clicks == 1);
      expect(events, contains(WatchdogStatus.reconnecting));
      expect(clickCallbacks, 1);

      // 页面点完恢复成 ok → 状态回 ok、退避清零
      ev.state = 'ok';
      await waitFor(() => events.isNotEmpty && events.last == WatchdogStatus.ok);

      // 恢复后再观察一段：绝不能再多点
      final clicksAtOk = ev.clicks;
      await Future<void>.delayed(const Duration(milliseconds: 300));
      expect(ev.clicks, clicksAtOk);
      core.stop();
    });

    test('A2. 一直断开：会持续重试但受冷却节流（不限次数）', () async {
      final ev = FakeEvaluator('disconnected');
      final events = <WatchdogStatus>[];
      final core = makeCore(ev, events);
      core.start();
      // 等到至少点满 3 次（CI 机器慢，给足时间，不用固定时长赌时序）
      await waitFor(() => ev.clicks >= 3, tries: 500);
      final clicksSoFar = ev.clicks;
      // 再过 400ms：有冷却节流，新增点击必然有限（无节流时 30ms 轮询会点十多次）
      await Future<void>.delayed(const Duration(milliseconds: 400));
      core.stop();
      expect(ev.clicks, greaterThanOrEqualTo(3));
      expect(ev.clicks - clicksSoFar, lessThanOrEqualTo(6));
    });

    test('B. 登录页豁免：有密码框时绝不点、无状态事件', () async {
      final ev = FakeEvaluator('login');
      final events = <WatchdogStatus>[];
      final core = makeCore(ev, events);
      core.start();
      await Future<void>.delayed(const Duration(milliseconds: 350));
      core.stop();
      expect(ev.clicks, 0);
      expect(events, isEmpty);
    });

    test('C. partial（只有一个标记）：不动', () async {
      final ev = FakeEvaluator('partial');
      final events = <WatchdogStatus>[];
      final core = makeCore(ev, events);
      core.start();
      await Future<void>.delayed(const Duration(milliseconds: 300));
      core.stop();
      expect(ev.clicks, 0);
      expect(events, isEmpty);
    });

    test('D. 一次断开紧接 ok（页面切换残影）：确认计数不够，不点', () async {
      final ev = FakeEvaluator('disconnected');
      final events = <WatchdogStatus>[];
      final core = makeCore(ev, events);
      core.start();
      // 只让第一次轮询摸到 disconnected，随即切走
      await waitFor(() => ev.detectCalls >= 1);
      ev.state = 'ok';
      await Future<void>.delayed(const Duration(milliseconds: 300));
      core.stop();
      expect(ev.clicks, 0);
    });

    test('E. connecting（正在建立会话…）：短时间内不点、不报 stuck', () async {
      final ev = FakeEvaluator('connecting');
      final events = <WatchdogStatus>[];
      var stuck = 0;
      final core = WatchdogCore(
        evaluator: ev,
        pollInterval: const Duration(milliseconds: 30),
        confirmScans: 2,
        backoffStart: const Duration(milliseconds: 60),
        backoffMax: const Duration(milliseconds: 120),
        onStatus: events.add,
        onConnectingStuck: () => stuck++,
      );
      core.start();
      await Future<void>.delayed(const Duration(milliseconds: 350));
      core.stop();
      expect(ev.clicks, 0);
      expect(stuck, 0, reason: 'connecting 持续 25 秒才报 stuck，350ms 内不报');
      expect(events, isEmpty);
    });

    test('F. partial 持续 12 秒才升级（短时间不动，旧口径 C 仍成立）', () async {
      final ev = FakeEvaluator('partial');
      final events = <WatchdogStatus>[];
      final core = makeCore(ev, events);
      core.start();
      await Future<void>.delayed(const Duration(milliseconds: 350));
      core.stop();
      expect(ev.clicks, 0);
      expect(events, isEmpty);
    });
  });

  group('kDetectJs（QF-06：状态子串匹配＋visible 祖先校验）', () {
    test('状态文本用子串匹配：“已断线，请重试”不再漏报', () {
      expect(kDetectJs, contains('statusText'));
      expect(kDetectJs, contains('indexOf(norm(STATUS'));
      expect(kDetectJs, isNot(contains('STATUS.indexOf(t)')));
      expect(kDetectJs, isNot(contains('STATUS.indexOf(fDeskText)')));
    });

    test('按钮标签不用子串（“断开连接”含“连接”，子串会误认恢复按钮）', () {
      expect(kDetectJs, contains('btnText'));
      expect(kDetectJs, contains('断开连接'));
      expect(kDetectJs, contains("norm(list[i]) === nt"));
    });

    test('visible 沿祖先链查 display/visibility 与 overflow 裁剪', () {
      expect(kDetectJs, contains('parentElement'));
      expect(kDetectJs, contains("visibility === 'collapse'"));
      expect(kDetectJs, contains("ov.indexOf('hidden')"));
      expect(kDetectJs, contains('ar.left'));
    });
  });

  group('kClickJs（QF-06：visible 与检测侧同口径）', () {
    test('点击侧 visible 同样沿祖先链查裁剪', () {
      expect(kClickJs, contains('parentElement'));
      expect(kClickJs, contains("ov.indexOf('hidden')"));
    });
  });

  group('kDetectJs（QF-05：检测与点击用同一恢复按钮集合）', () {
    test('检测认 data-act="retry" 与文本「重试」，与 kClickJs 闭环', () {
      expect(kDetectJs, contains('data-act'));
      expect(kDetectJs, contains("'重试'"));
    });
  });

  group('kClickJs（B10 返修：点掩码「重试」）', () {
    test('优先按 data-act="retry" 定位掩码重试按钮', () {
      expect(kClickJs, contains('data-act="retry"'));
    });

    test('文本「重试」作后备；无重试按钮时回 no-retry-button，不静默', () {
      expect(kClickJs, contains("'重试'"));
      expect(kClickJs, contains('no-retry-button'));
    });

    test('不再找「连接／重新连接」——掩码里没有这两个按钮', () {
      expect(kClickJs, isNot(contains("'连接'")));
      expect(kClickJs, isNot(contains("'重新连接'")));
    });

    test('保留祖先校验（#qfFrame 或 .qf-session-layer），不误点列表页', () {
      expect(kClickJs, contains('qf-session-layer'));
      expect(kClickJs, contains("qfFrame"));
    });
  });
}
