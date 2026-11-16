import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'session_response.dart';
import '../../core/constants.dart';
import '../../services/points.dart' show ConsoleCookieProvider;
import '../../services/probe.dart' show trustedHttpClient;

/// RC-03 IDR 请求发送器（QF-VIDEO-1 规范 v1，§2/§3 第 5–6 条）。
///
/// 端点 `POST /license/api/session/idr-request`（控制台会话鉴权；
/// 未加载 L5 模块时 HTTP 503 `{ ok:false, code:'L5_UNAVAILABLE' }`）。
/// 请求体 `{ sessionId, agentId, seq, reason }`，响应看 body 不看
/// HTTP 状态（被拒绝时仍 HTTP 200，`ok:false`）。
///
/// 关键语义（数值全部来自服务端实现，不得自行放宽，§2.5）：
/// - seq 每会话从 1 开始单调递增，每发一次加 1，无论放行/合并/拒绝；
///   被合并的请求也消费 seq；
/// - 同一会话的多观看端须共用一个 seq 计数器：本类实例即计数器，
///   同一 sessionId 只许建一个 [IdrRequester]，多端共用须由会话
///   主持端统一发（各端各自 new 一个会互相顶掉、后发的永远 REPLAY）；
/// - 收到 coalesced / rejected 后不补发、不换 reason 重发、不降级成
///   “每帧都请求”；等已放行的关键帧或等冷却/窗口过去；UI 上不得向
///   用户报错（节流是正常行为，可在诊断日志里记一条）；
/// - 收到 REPLAY 时不得原样重发：本地 seq 已单调递增，本次调用用
///   新 seq 重试一次（仍 REPLAY 则停手，交给调用方按正常时机再发）。
///
/// 出入（§4.3）：服务端只做准入决策返回，不直接把放行转发给 agent——
/// “转发给 agent 强制出 IDR”通道尚未实现。在通道落地前，`forward`
/// 只表示“服务端允许”，[IdrResult.agentNotified] 恒为 false，
/// 客户端不得假设 agent 已收到。
enum IdrReason {
  /// 丢包不可恢复。
  loss,

  /// 新观看端加入。
  join,

  /// 档位切换需关键帧。
  qualityChange,
}

extension IdrReasonWire on IdrReason {
  String get wire {
    switch (this) {
      case IdrReason.loss:
        return 'loss';
      case IdrReason.join:
        return 'join';
      case IdrReason.qualityChange:
        return 'quality-change';
    }
  }

  /// 同 reason 合并窗口（§2.5）：loss 1s、quality-change 2s、join 1s。
  Duration get coalesceWindow {
    switch (this) {
      case IdrReason.loss:
        return const Duration(milliseconds: 1000);
      case IdrReason.join:
        return const Duration(milliseconds: 1000);
      case IdrReason.qualityChange:
        return const Duration(milliseconds: 2000);
    }
  }
}

/// IDR 决策（服务端 `idr-core.js` 的 code 枚举，一字一致）。
enum IdrDecision { forward, coalesced, rejected }

/// 一次 IDR 请求的结果。
class IdrResult {
  const IdrResult({
    required this.decision,
    required this.code,
    required this.message,
    required this.seq,
    this.retryAfterMs,
    this.agentNotified = false,
  });

  final IdrDecision decision;
  final String code;
  final String message;

  /// 本次请求实际发出的 seq。
  final int seq;

  /// COOLDOWN / PINGPONG 类响应带的等待毫秒数（冷却结束前不得再发）。
  final int? retryAfterMs;

  /// 通道未实现（§4.3）：forward 也不代表 agent 已收到，恒 false。
  final bool agentNotified;

  /// `ok` 为真当且仅当 decision 是 forward 或 coalesced（§2.2）。
  bool get ok =>
      decision == IdrDecision.forward || decision == IdrDecision.coalesced;

  /// 是否放行（等下一关键帧到达后渲染，不得再发一次）。
  bool get forwarded => decision == IdrDecision.forward;

  /// 是否被合并（等已放行的那次关键帧，不得重发）。
  bool get coalesced => decision == IdrDecision.coalesced;

  /// 是否被拒绝（不补发、不换 reason 重发；NO_SESSION 不得重试刷请求；
  /// NOT_BOUND 停请求走重新绑定/重新登录；BAD_REASON 是客户端 bug）。
  bool get rejected => decision == IdrDecision.rejected;

  /// UI 上不得向用户报错（§3 第 6 条）：节流拒绝是正常行为。
  /// 只有 NOT_BOUND / BAD_REASON 这类须人工介入的才值得提示调用方。
  bool get needsOperatorAttention =>
      code == 'NOT_BOUND' || code == 'BAD_REASON';

  factory IdrResult.fromJson(Map<String, Object?> json, int seq) {
    final decisionRaw = json['decision'] as String?;
    final decision = switch (decisionRaw) {
      'forward' => IdrDecision.forward,
      'coalesced' => IdrDecision.coalesced,
      _ => IdrDecision.rejected,
    };
    return IdrResult(
      decision: decision,
      code: json['code'] as String? ?? 'UNKNOWN',
      message: json['msg'] as String? ?? '',
      seq: seq,
      retryAfterMs: json['retryAfterMs'] as int?,
    );
  }
}

class IdrApiException implements Exception {
  const IdrApiException(this.code, [this.message = '']);
  final String code;
  final String message;
  @override
  String toString() => 'IdrApiException($code)';
}

/// IDR 请求传输接口（测试用假实现；生产实现见 [HttpIdrTransport]）。
abstract class IdrTransport {
  Future<IdrResult> request({
    required String sessionId,
    required String agentId,
    required int seq,
    required IdrReason reason,
  });
}

/// 基于 `trustedHttpClient` 的默认传输（与 RC-04 的
/// HttpReconnectTransport 同口径；控制台会话鉴权由调用方会话 cookie
/// 承载——本传输不另发明鉴权头）。
class HttpIdrTransport implements IdrTransport {
  HttpIdrTransport({String? baseUrl, ConsoleCookieProvider? cookieProvider})
    : _baseUrl = baseUrl ?? kServerOrigin,
      _cookieProvider = cookieProvider;

  final String _baseUrl;

  /// 控制台会话 cookie（DevicePresenceClient 同款 cookie 桥）：
  /// `/license/api/*` 须控制台会话，未带有效 cookie 时服务端回 401；
  /// 不传时保持旧行为（不带 cookie），调用方须自行保证已登录。
  final ConsoleCookieProvider? _cookieProvider;

  @override
  Future<IdrResult> request({
    required String sessionId,
    required String agentId,
    required int seq,
    required IdrReason reason,
  }) async {
    final client = trustedHttpClient(
      connectionTimeout: const Duration(seconds: 15),
    );
    try {
      final uri = Uri.parse(_baseUrl)
          .resolve('/license/api/session/idr-request');
      final req = await client
          .postUrl(uri)
          .timeout(const Duration(seconds: 15));
      req.headers.contentType = ContentType.json;
      final cookie = await _cookieProvider?.call();
      if (cookie != null && cookie.isNotEmpty) {
        req.headers.set(HttpHeaders.cookieHeader, cookie);
      }
      req.write(
        jsonEncode({
          'sessionId': sessionId,
          'agentId': agentId,
          'seq': seq,
          'reason': reason.wire,
        }),
      );
      final res = await req.close().timeout(const Duration(seconds: 15));
      final text = await res
          .transform(utf8.decoder)
          .join()
          .timeout(const Duration(seconds: 15));
      if (res.statusCode == 401 || res.statusCode == 403) {
        return IdrResult(
          decision: IdrDecision.rejected,
          code: 'UNAUTHORIZED',
          message: '登录已过期。',
          seq: seq,
        );
      }
      if (res.statusCode == 503) {
        return IdrResult(
          decision: IdrDecision.rejected,
          code: 'L5_UNAVAILABLE',
          message: 'L5 模块未加载。',
          seq: seq,
        );
      }
      final decoded = decodeSessionResponse(
        res.statusCode,
        text,
        (code, message) => IdrApiException(code, message),
      );
      return IdrResult.fromJson(decoded, seq);
    } on FormatException {
      throw const IdrApiException('INVALID_RESPONSE');
    } on TypeError {
      throw const IdrApiException('INVALID_RESPONSE');
    } on TimeoutException {
      throw const IdrApiException('TIMEOUT');
    } on IOException {
      throw const IdrApiException('NETWORK');
    } finally {
      client.close(force: true);
    }
  }
}

/// IDR 请求发送器：会话级单调 seq＋三 reason＋节流语义。
///
/// 发送时机只这三种（§3 第 5 条，不得另加）：
/// - 新观看端加入：发一次 reason=join（绑定后 10s 宽限内发）；
/// - 帧不可恢复：超时窗口届满后发一次 reason=loss；
/// - 档位切换需关键帧：每次档位切换最多一次 reason=quality-change。
class IdrRequester {
  IdrRequester({
    required this.sessionId,
    required this.agentId,
    required IdrTransport transport,
    int Function()? nowMs,
  }) : _transport = transport,
       _nowMs = nowMs ?? (() => DateTime.now().millisecondsSinceEpoch);

  final String sessionId;
  final String agentId;
  final IdrTransport _transport;
  final int Function() _nowMs;
  final Map<IdrReason, int> _lastSentAt = {};
  final Map<IdrReason, int> _lastSentSeq = {};

  /// 下一次发送用的 seq（从 1 开始，§2.4）。
  int _nextSeq = 1;

  int get nextSeq => _nextSeq;

  /// 已发出的请求数（放行/合并/拒绝都消费 seq）。
  int get sentCount => _nextSeq - 1;

  /// 发一次 IDR 请求。REPLAY 时用新 seq 重试一次（仍 REPLAY 则返回
  /// 该结果停手，不原样重发、不无限重试）。
  Future<IdrResult> send(IdrReason reason) async {
    final at = _nowMs();
    final previous = _lastSentAt[reason];
    if (previous != null &&
        at >= previous &&
        at - previous < reason.coalesceWindow.inMilliseconds) {
      return IdrResult(
        decision: IdrDecision.coalesced,
        code: 'COALESCED_LOCAL',
        message: '',
        seq: _lastSentSeq[reason]!,
        retryAfterMs: reason.coalesceWindow.inMilliseconds - (at - previous),
      );
    }
    final seq = _nextSeq++;
    _lastSentAt[reason] = at;
    _lastSentSeq[reason] = seq;
    final IdrResult first;
    try {
      first = await _transport.request(
        sessionId: sessionId,
        agentId: agentId,
        seq: seq,
        reason: reason,
      );
    } catch (_) {
      if (_lastSentSeq[reason] == seq) {
        _lastSentAt.remove(reason);
        _lastSentSeq.remove(reason);
      }
      rethrow;
    }
    var result = first;
    if (result.code == 'REPLAY') {
      final retrySeq = _nextSeq++;
      _lastSentSeq[reason] = retrySeq;
      result = await _transport.request(
        sessionId: sessionId,
        agentId: agentId,
        seq: retrySeq,
        reason: reason,
      );
    }
    return result;
  }

  /// 新观看端加入（§3 第 5 条第一种）：绑定后 10s 宽限内发一次，
  /// 利用免令牌桶的首次机会。
  Future<IdrResult> sendJoin() => send(IdrReason.join);

  /// 帧不可恢复（§3 第 5 条第二种）：超时窗口届满后发一次。
  Future<IdrResult> sendLoss() => send(IdrReason.loss);

  /// 档位切换需关键帧（§3 第 5 条第三种）：每次切换最多一次。
  Future<IdrResult> sendQualityChange() => send(IdrReason.qualityChange);
}
