import 'dart:async';

/// QFRemote 连接看护（watchdog）——「断线不顾一切自动重连」的 Dart 平移版，
/// 判定逻辑与重试策略与 Windows 版 watchdog.js 逐条对齐：
///
///   1. 登录页豁免：页面上有可见的密码输入框 → 判定 'login'，看护不介入。
///   2. 双标记同现才算断开：文本恰好等于「已断线/已断开/未连接/Disconnected/
///      Not connected」的可见叶子元素，与文本恰好等于「连接/重新连接/Connect/
///      Reconnect」的可见按钮，必须同时出现；只出现一个判定 'partial'，
///      持续 12 秒升级为 disconnected（2.4.5 B10）。
///   2b. 会话 iframe 分支：同源时读 #qfFrame 内 #deskstatus/#Desk；
///      跨域/读不到返回 'unknown'；顶层含「正在建立会话…」且无画布时
///      判定 'connecting'，持续 25 秒回调 onConnectingStuck（2.4.5 A1）。
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
/// 2.4.5 B10：增加 iframe 分支（同源时读会话框 #qfFrame 的 contentDocument
/// 里的 #deskstatus 与 #Desk 尺寸；跨域/读不到时返回 'unknown' 而非 'ok'，
/// 不假报正常）与 'connecting' 态（顶层含「正在建立会话…」且无 #Desk 画布；
/// 持续超 25 秒由 Dart 侧升级为 connecting-stuck，见 WatchdogCore）。
/// 登录豁免收紧（B10）：只在顶层 URL 为控制台根路径且 #loginpanel 可见
/// 时豁免，不再以「任意可见密码框」为准（会话页/设置页的密码框不再豁免）。
const String kDetectJs = r'''(function () {
  function visible(el) {
    if (!el) return false;
    var r = el.getBoundingClientRect();
    if (!r || r.width === 0 || r.height === 0) return false;
    var s = window.getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
  }
  var isRoot = location.pathname === '/' || location.pathname === '';
  var loginPanel = document.getElementById('loginpanel');
  if (isRoot && loginPanel && visible(loginPanel)) return 'login';
  var STATUS = ['已断线', '已断开', '未连接', 'Disconnected', 'Not connected'];
  var BTNS = ['连接', '重新连接', 'Connect', 'Reconnect'];
  function scanDoc(doc) {
    var statusHit = false, btnHit = false;
    var texts = doc.querySelectorAll('div, span, td, li, label, p');
    for (var i = 0; i < texts.length; i++) {
      var el = texts[i];
      if (el.children.length !== 0) continue;
      var t = (el.textContent || '').trim();
      if (STATUS.indexOf(t) >= 0 && visible(el)) { statusHit = true; break; }
    }
    var btns = doc.querySelectorAll('button, a, input[type="button"], input[type="submit"]');
    for (var j = 0; j < btns.length; j++) {
      var b = btns[j];
      var bt = ((b.textContent || b.value || '') + '').trim();
      if (BTNS.indexOf(bt) >= 0 && visible(b)) { btnHit = true; break; }
    }
    return {statusHit: statusHit, btnHit: btnHit};
  }
  // 会话 iframe 分支：会话断线文本在会话框内，顶层看不到。
  var frame = document.querySelector('#qfFrame');
  var frameDoc = null, frameReadable = false;
  if (frame) {
    try { frameDoc = frame.contentDocument; frameReadable = !!frameDoc; } catch (e) { frameReadable = false; }
  }
  if (frame && !frameReadable) return 'unknown';
  if (frameDoc) {
    var fs = scanDoc(frameDoc);
    var fds = frameDoc.querySelector('#deskstatus');
    var fDesk = frameDoc.querySelector('#Desk');
    var fDeskText = fds ? (fds.textContent || '').trim() : '';
    var fHasCanvas = false;
    if (fDesk) { var r = fDesk.getBoundingClientRect(); fHasCanvas = r.width > 0 && r.height > 0; }
    if (STATUS.indexOf(fDeskText) >= 0) fs.statusHit = true;
    if (fs.statusHit && fs.btnHit) return 'disconnected';
    if (fs.statusHit || fs.btnHit) return 'partial';
    if (fDeskText === 'Connected' && fHasCanvas) return 'ok';
    if (fDeskText === 'Connected') return 'ok';
    // 框内既无断线标记也无 Connected：可能是正在建立，交给顶层 connecting 判定
  }
  var top = scanDoc(document);
  if (top.statusHit && top.btnHit) return 'disconnected';
  if (top.statusHit || top.btnHit) return 'partial';
  // 正在建立会话：顶层含掩码文本且（顶层或框内）无 #Desk 画布
  var maskHit = false;
  var all = document.querySelectorAll('div, span, td, li, label, p');
  for (var k = 0; k < all.length; k++) {
    var el2 = all[k];
    if (el2.children.length !== 0) continue;
    if (((el2.textContent || '').trim() === '正在建立会话…') && visible(el2)) { maskHit = true; break; }
  }
  var hasCanvas = false;
  var desk = document.querySelector('#Desk');
  if (desk) { var rr = desk.getBoundingClientRect(); hasCanvas = rr.width > 0 && rr.height > 0; }
  if (frameDoc) {
    var fd2 = frameDoc.querySelector('#Desk');
    if (fd2) { var rr2 = fd2.getBoundingClientRect(); hasCanvas = hasCanvas || (rr2.width > 0 && rr2.height > 0); }
  }
  if (maskHit && !hasCanvas) return 'connecting';
  return 'ok';
})()''';

/// 页面内点击脚本（与 Windows 版 CLICK_JS 原样一致）：
/// 用与检测完全相同的严格条件重新定位按钮再点，点到返回 true。
/// 2.4.5 B10：点前校验按钮祖先含 #qfFrame 或会话层 .qf-session-layer，
/// 否则不点（设备列表页的同名「连接」入口不再被误点）。
const String kClickJs = r'''(function () {
  function visible(el) {
    if (!el) return false;
    var r = el.getBoundingClientRect();
    if (!r || r.width === 0 || r.height === 0) return false;
    var s = window.getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
  }
  function inSessionLayer(el) {
    var n = el;
    while (n) {
      if (n.id === 'qfFrame') return true;
      if (n.classList && n.classList.contains('qf-session-layer')) return true;
      n = n.parentElement;
    }
    return false;
  }
  var BTNS = ['连接', '重新连接', 'Connect', 'Reconnect'];
  var btns = document.querySelectorAll('button, a, input[type="button"], input[type="submit"]');
  for (var j = 0; j < btns.length; j++) {
    var b = btns[j];
    var bt = ((b.textContent || b.value || '') + '').trim();
    if (BTNS.indexOf(bt) >= 0 && visible(b) && inSessionLayer(b)) { b.click(); return true; }
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

  /// 'connecting' 持续超标后回调（2.4.5 A1/B10）：原生层弹会话失败卡。
  final void Function() onConnectingStuck;

  Timer? _timer;
  bool _stopped = false;
  bool _ticking = false;
  int _confirmCount = 0;
  Duration _backoff;
  DateTime? _nextAttemptAt;
  WatchdogStatus _status = WatchdogStatus.ok;

  /// partial 连续出现时开始计时（B10：持续 12 秒升级为 disconnected）。
  DateTime? _partialSince;

  /// connecting 持续出现时开始计时（A1：持续 25 秒升级为 stuck）。
  DateTime? _connectingSince;
  bool _stuckReported = false;

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
    void Function()? onConnectingStuck,
  })  : enabled = enabled ?? (() => true),
        onStatus = onStatus ?? ((_) {}),
        onReconnectClick = onReconnectClick ?? (() {}),
        log = log ?? ((_) {}),
        onConnectingStuck = onConnectingStuck ?? (() {}),
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

  /// 立即跑一拍（B8：回前台复核不等下一个 4 秒拍；不重置轮询定时器）。
  Future<void> tickNow() async {
    if (_stopped || _ticking) return;
    _ticking = true;
    try {
      await _tickInner();
    } finally {
      _ticking = false;
    }
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

  Future<void> _verifyClickNoop() async {
    await Future<void>.delayed(const Duration(seconds: 2));
    if (_stopped) return;
    try {
      final state = await evaluator.detect().timeout(const Duration(seconds: 5));
      if (state == 'disconnected' || state == 'partial') {
        log('reconnect-click-noop');
      }
    } catch (_) {
      // 复核本身失败不记结论，下一拍继续看
    }
  }

  Future<void> _tickInner() async {
    if (!enabled()) return;
    String state;
    try {
      state = await evaluator.detect().timeout(const Duration(seconds: 5));
    } catch (_) {
      state = 'unknown'; // 页面正在跳转/重载：这一拍跳过
    }
    if (_stopped) return;
    log('detect=$state');

    // connecting 持续超 25 秒（peer-connecting 阶段超时）→ 原生失败卡。
    if (state == 'connecting') {
      _connectingSince ??= DateTime.now();
      if (!_stuckReported &&
          DateTime.now().difference(_connectingSince!) >=
              const Duration(seconds: 25)) {
        _stuckReported = true;
        log('connecting-stuck');
        onConnectingStuck();
      }
      _partialSince = null;
      return;
    }
    _connectingSince = null;
    _stuckReported = false;

    // partial 连续 12 秒 → 升级为 disconnected，走同一确认流程。
    if (state == 'partial') {
      _partialSince ??= DateTime.now();
      if (DateTime.now().difference(_partialSince!) >=
          const Duration(seconds: 12)) {
        log('partial-escalated');
        state = 'disconnected';
      } else {
        _confirmCount = 0;
        return;
      }
    } else {
      _partialSince = null;
    }

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
        if (clicked) {
          onReconnectClick();
          // B10：点后 2 秒内复核 #deskstatus 是否离开断线态，否则记一笔
          // reconnect-click-noop（点中了按钮但会话没起来 ≠ 恢复）。
          unawaited(_verifyClickNoop());
        }
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
      // login / unknown：不动作，只清确认计数，避免跨状态攒数
      _confirmCount = 0;
    }
  }
}
