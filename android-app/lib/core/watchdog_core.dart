import 'dart:async';

/// QFRemote 连接看护（watchdog）——「断线不顾一切自动重连」的 Dart 平移版，
/// 判定逻辑与重试策略与 Windows 版 watchdog.js 逐条对齐：
///
///   1. 登录页豁免：页面上有可见的密码输入框 → 判定 'login'，看护不介入。
///   2. 双标记同现才算断开：文本恰好等于「已断线/已断开/未连接/Disconnected/
///      Not connected」的可见叶子元素，与文本恰好等于「连接/重新连接/Connect/
///      Reconnect」的可见按钮，必须同时出现；只出现一个判定 'partial'，不动。
///   3. 两次确认：连续两次轮询都判定 'disconnected' 才真正去点按钮。
///   4. 点击前用同一套严格条件在页面里重新定位按钮，找不到就不点。
///
/// 重试策略（不设次数上限、永不放弃、但不疯狂刷屏）：
///   - 轮询间隔 pollMs（默认 4 秒）；
///   - 每次点击后进入冷却，冷却从 backoffStartMs（默认 5 秒）起每次翻倍，
///     封顶 backoffMaxMs（默认 30 秒）：5s→10s→20s→30s→30s…
///   - 检测恢复 'ok' 后，退避与确认计数全部清零；
///   - 全程不弹任何对话框，状态只经 onStatus 回调交给工具栏显示一行小字。

/// 页面内状态检测脚本（与 Windows 版 DETECT_JS 原样一致）：
/// 返回 'login' | 'disconnected' | 'partial' | 'ok'
const String kDetectJs = r'''(function () {
  function visible(el) {
    if (!el) return false;
    var r = el.getBoundingClientRect();
    if (!r || r.width === 0 || r.height === 0) return false;
    var s = window.getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
  }
  var pw = document.querySelector('input[type="password"]');
  if (pw && visible(pw)) return 'login';
  var STATUS = ['已断线', '已断开', '未连接', 'Disconnected', 'Not connected'];
  var BTNS = ['连接', '重新连接', 'Connect', 'Reconnect'];
  var statusHit = false, btnHit = false;
  var texts = document.querySelectorAll('div, span, td, li, label, p');
  for (var i = 0; i < texts.length; i++) {
    var el = texts[i];
    if (el.children.length !== 0) continue;
    var t = (el.textContent || '').trim();
    if (STATUS.indexOf(t) >= 0 && visible(el)) { statusHit = true; break; }
  }
  var btns = document.querySelectorAll('button, a, input[type="button"], input[type="submit"]');
  for (var j = 0; j < btns.length; j++) {
    var b = btns[j];
    var bt = ((b.textContent || b.value || '') + '').trim();
    if (BTNS.indexOf(bt) >= 0 && visible(b)) { btnHit = true; break; }
  }
  if (statusHit && btnHit) return 'disconnected';
  if (statusHit || btnHit) return 'partial';
  return 'ok';
})()''';

/// 页面内点击脚本（与 Windows 版 CLICK_JS 原样一致）：
/// 用与检测完全相同的严格条件重新定位按钮再点，点到返回 true。
const String kClickJs = r'''(function () {
  function visible(el) {
    if (!el) return false;
    var r = el.getBoundingClientRect();
    if (!r || r.width === 0 || r.height === 0) return false;
    var s = window.getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
  }
  var BTNS = ['连接', '重新连接', 'Connect', 'Reconnect'];
  var btns = document.querySelectorAll('button, a, input[type="button"], input[type="submit"]');
  for (var j = 0; j < btns.length; j++) {
    var b = btns[j];
    var bt = ((b.textContent || b.value || '') + '').trim();
    if (BTNS.indexOf(bt) >= 0 && visible(b)) { b.click(); return true; }
  }
  return false;
})()''';

/// 看护需要的页面求值能力（由 WebView 控制器实现；单元测试用假实现）。
abstract class WatchdogEvaluator {
  /// 执行检测脚本，返回 'login'|'disconnected'|'partial'|'ok'，
  /// 页面跳转中等异常情况抛错（看护按 'unknown' 处理、下一拍再看）。
  Future<String> detect();

  /// 执行点击脚本，点到返回 true。
  Future<bool> clickReconnect();
}

enum WatchdogStatus { ok, reconnecting }

class WatchdogCore {
  final WatchdogEvaluator evaluator;
  final Duration pollInterval;
  final int confirmScans;
  final Duration backoffStart;
  final Duration backoffMax;
  final bool Function() enabled;
  final void Function(WatchdogStatus status) onStatus;
  final void Function() onReconnectClick;
  final void Function(String message) log;

  Timer? _timer;
  bool _stopped = false;
  bool _ticking = false;
  int _confirmCount = 0;
  Duration _backoff;
  DateTime? _nextAttemptAt;
  WatchdogStatus _status = WatchdogStatus.ok;

  WatchdogCore({
    required this.evaluator,
    this.pollInterval = const Duration(seconds: 4),
    this.confirmScans = 2,
    this.backoffStart = const Duration(seconds: 5),
    this.backoffMax = const Duration(seconds: 30),
    bool Function()? enabled,
    void Function(WatchdogStatus)? onStatus,
    void Function()? onReconnectClick,
    void Function(String)? log,
  })  : enabled = enabled ?? (() => true),
        onStatus = onStatus ?? ((_) {}),
        onReconnectClick = onReconnectClick ?? (() {}),
        log = log ?? ((_) {}),
        _backoff = backoffStart;

  bool get isReconnecting => _status == WatchdogStatus.reconnecting;

  void start() {
    if (_stopped || _timer != null) return;
    _timer = Timer(const Duration(milliseconds: 800), _tick);
  }

  void stop() {
    _stopped = true;
    _timer?.cancel();
    _timer = null;
  }

  void _scheduleNext() {
    if (_stopped) return;
    _timer = Timer(pollInterval, _tick);
  }

  void _setStatus(WatchdogStatus s) {
    if (_status == s) return;
    _status = s;
    onStatus(s);
  }

  Future<void> _tick() async {
    if (_stopped || _ticking) {
      _scheduleNext();
      return;
    }
    _ticking = true;
    try {
      await _tickInner();
    } finally {
      _ticking = false;
      _scheduleNext();
    }
  }

  Future<void> _tickInner() async {
    if (!enabled()) return;
    String state;
    try {
      state = await evaluator.detect();
    } catch (_) {
      state = 'unknown'; // 页面正在跳转/重载：这一拍跳过
    }
    if (_stopped) return;
    log('detect=$state');

    if (state == 'disconnected') {
      _confirmCount++;
      final now = DateTime.now();
      final cooledDown = _nextAttemptAt == null || !now.isBefore(_nextAttemptAt!);
      if (_confirmCount >= confirmScans && cooledDown) {
        _setStatus(WatchdogStatus.reconnecting);
        var clicked = false;
        try {
          clicked = await evaluator.clickReconnect();
        } catch (_) {
          clicked = false;
        }
        log('reconnect click -> $clicked');
        if (clicked) onReconnectClick();
        _nextAttemptAt = DateTime.now().add(_backoff);
        _backoff = _backoff * 2 > backoffMax ? backoffMax : _backoff * 2;
        _confirmCount = 0;
      }
      return;
    }

    if (state == 'ok') {
      _confirmCount = 0;
      _backoff = backoffStart;
      _nextAttemptAt = null;
      _setStatus(WatchdogStatus.ok);
    } else {
      // login / partial / unknown：不动作，只清确认计数，避免跨状态攒数
      _confirmCount = 0;
    }
  }
}
