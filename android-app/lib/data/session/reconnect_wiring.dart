import 'dart:async';

import 'package:flutter/foundation.dart';

import 'reconnect_policy.dart';

/// RC-04 接线：重连票据会话管理器（第 2 轮 #4）。
///
/// 拥有 [ReconnectController]＋内存票据库＋滚动续领定时器；生产调用方
/// （main.dart）只通过它接触 RC-04，不直接碰 controller／store。
///
/// 规范要点（`server/ext/lea/RC-04-RECONNECT-TICKET-SPEC.md` §5）：
/// - 会话建立成功后立即申领一张票据存内存；票据过期（300 秒）而会话仍在
///   时滚动续领（同 session 只留最新一张，旧票据作废）；
/// - 掉线后重连一轮：最多 5 次、固定 5 秒间隔；凭据／授权类失败 1 次即停，
///   只有纯网络错误才继续；恢复成功后为同一 session 再领一张新票
///   （RC-04 (b) 定夺 A：单次性保护的是“一张票只认一次”，不是
///   “一个 session 一生只恢复一次”）；
/// - 票据明文只存内存，不得写进可同步的配置文件、不得随诊断日志外发；
///   日志只记 `resume_id` 前 8 位 hex 与 `api_key_id`（见 ticket.logRef）。
///
/// 失败语义（fail-open，不挡会话）：
/// - 申领／续领失败（无 cookie／无在用 Key／网络不通）只记日志，会话照常
///   跑；无票据时重连直接走完整登录恢复（controller 报 ticketExpired）。
/// - 恢复成功后补领新票同样 best-effort：补领失败不影响已恢复的会话，
///   下次续领节拍再试。
class ReconnectSession {
  ReconnectSession({
    required ReconnectTransport transport,
    ReconnectTicketStore? store,
    ReconnectPolicy? policy,
    this.onAttempt,
    this.onRestored,
    this.onCredentialFailure,
    this.onHandshakeRedo,
    this.onQueryUnknownJobs,
    this.onClearDiscardedInput,
    this.rollInterval = const Duration(seconds: 120),
  }) : _store = store ?? InMemoryReconnectTicketStore() {
    _controller = ReconnectController(
      transport: transport,
      store: _store,
      policy: policy,
      onHandshakeRedo: onHandshakeRedo,
      onQueryUnknownJobs: onQueryUnknownJobs,
      onClearDiscardedInput: onClearDiscardedInput,
      onRestored: onRestored,
      onCredentialFailure: onCredentialFailure,
      onAttempt: (attempt) {
        _reconnecting = true;
        onAttempt?.call(_controller.policy.statusText);
      },
    );
  }

  final ReconnectTicketStore _store;
  late final ReconnectController _controller;

  /// 每次重试发起时回调（参数为 policy.statusText，即
  /// “正在重连（第 N 次 / 共 5 次）”，生产浮层直接显示）。
  final void Function(String statusText)? onAttempt;

  /// 恢复成功后回调（钩子顺序：握手重建 → 状态查询 → 清输入 → 本回调）。
  final void Function()? onRestored;

  /// 凭据／授权类失败回调（1 次即停，界面显示原因＋“重新登录”入口）。
  final void Function(ReconnectFailure failure)? onCredentialFailure;

  /// 恢复成功后重做 RC-01 握手的钩子（生产：重走 preflight 全链路）。
  final Future<void> Function(ResumeResult result)? onHandshakeRedo;

  /// 恢复成功后查询原会话 UNKNOWN job 状态的钩子（只查，不重执行）。
  final Future<void> Function(String sessionId)? onQueryUnknownJobs;

  /// 恢复成功后清空已丢弃输入队列的钩子。
  final void Function()? onClearDiscardedInput;

  /// 滚动续领节拍（默认 120 秒＜票据 TTL 300 秒；服务端同设备签发最小
  /// 间隔 5 秒，120 秒节拍不会触发限流）。
  final Duration rollInterval;

  String? _sessionId;
  String? _deviceId;
  Timer? _rollTimer;
  bool _reconnecting = false;

  /// 当前会话的 session_id（`sess-` + 16 位小写 hex，首次建立会话时生成）。
  String? get sessionId => _sessionId;

  /// 当前会话的设备 id（裸 nodeid）。
  String? get deviceId => _deviceId;

  /// 是否正在重连循环内。
  bool get isReconnecting => _reconnecting;

  /// 当前重连状态文案（policy.statusText）。
  String get statusText => _controller.policy.statusText;

  /// 是否持有在效票据（过期取不到；不消费——只做接线点的存在性判断）。
  Future<bool> get hasLiveTicket async {
    final id = _sessionId;
    if (id == null) return false;
    return (await _store.take(id)) != null;
  }

  /// 会话建立成功后调：生成 session_id、申领票据、起滚动续领定时器。
  /// 同一设备重复调时复用同一 session_id（票据仍在效就不重领，过期则
  /// 滚动续领）；设备变了调用方须先 [stop] 再 [start]。
  /// 返回 true＝已持有在效票据；false＝申领失败（无票据，会话照常跑）。
  Future<bool> start({required String deviceId}) async {
    if (_sessionId != null && _deviceId == deviceId) {
      return rollIfNeeded();
    }
    _sessionId = generateSessionId();
    _deviceId = deviceId;
    bool ok = false;
    try {
      await _controller.issueOnSessionStart(
        deviceId: deviceId,
        sessionId: _sessionId!,
      );
      ok = true;
    } catch (e) {
      // fail-open：申领失败不挡会话（无 cookie／无在用 Key／网络不通
      // 都只记日志；日志只记 session_id，不记票据明文）。
      debugPrint('QFRC04 issue failed device=$deviceId: $e');
    }
    _rollTimer?.cancel();
    _rollTimer = Timer.periodic(rollInterval, (_) {
      unawaited(_rollTick());
    });
    return ok;
  }

  /// 票据过期而会话仍在时滚动续领（store.take 取不到即重领；仍在效则
  /// 不动）。返回 true＝续领后持有在效票据。
  Future<bool> rollIfNeeded() async {
    final sessionId = _sessionId;
    final deviceId = _deviceId;
    if (sessionId == null || deviceId == null) return false;
    try {
      final ticket = await _controller.rollTicketIfNeeded(
        deviceId: deviceId,
        sessionId: sessionId,
      );
      return ticket != null;
    } catch (e) {
      debugPrint('QFRC04 roll failed session=$sessionId: $e');
      return false;
    }
  }

  /// 掉线后重连一轮（§5.2：最多 5 次、固定 5 秒间隔；凭据类失败 1 次即停）。
  /// 返回 true＝恢复成功（钩子已依次跑完；随后 best-effort 补领一张新票，
  /// 供同一 session 下次断线再用）；false＝本轮未恢复。
  Future<bool> reconnect() async {
    final sessionId = _sessionId;
    if (sessionId == null) return false;
    _reconnecting = true;
    try {
      final ok = await _controller.reconnect(sessionId);
      if (ok) {
        // 定夺 A：恢复成功后为同一 session 再领一张新票（不阻塞返回，
        // 补领失败只记日志，下次续领节拍再试）。
        unawaited(rollIfNeeded());
      }
      return ok;
    } finally {
      _reconnecting = false;
    }
  }

  /// 用户点“取消”：停止重连循环（当前在途请求跑完即停，不再发起下次）。
  void cancel() => _controller.policy.cancel();

  /// 显式结束会话：停续领定时器、作废内存票据、清 session 身份。
  /// 注意：重试 preflight 不调它（跨重试要保留同一张票据）；只在显式
  /// 退出会话／退出登录时调。
  Future<void> stop() async {
    _rollTimer?.cancel();
    _rollTimer = null;
    _reconnecting = false;
    final sessionId = _sessionId;
    _sessionId = null;
    _deviceId = null;
    if (sessionId != null) {
      await _store.invalidate(sessionId);
    }
  }

  Future<void> _rollTick() async {
    // 续领失败只记日志（rollIfNeeded 内部已记），不抛、不停定时器。
    await rollIfNeeded();
  }
}
