import 'dart:async';
import 'dart:convert';
import 'dart:io';

import '../../core/constants.dart';
import '../../services/points.dart' show ConsoleCookieProvider;
import '../../services/probe.dart' show trustedHttpClient;
import 'fec_decoder.dart';
import 'idr_client.dart';

/// RC-09 画质四档＋自降档＋背压（QF-QUALITY-1 规范 v1）。
///
/// 端点：`POST /license/api/session/probe`、
/// `POST /license/api/session/quality/upgrade`、
/// `POST /license/api/session/quality/ack`（控制台会话鉴权）。
///
/// 本文件与既有 `quality_tiers.dart` 的关系：旧文件是 L5 规范到达前
/// 的本地近似（连续 2 次探测变差降档、balanced 2000kbps/24fps），
/// 保持不动；按规范，判定在服务端（原始样本＋计数＋持续时间＋冷却），
/// 客户端只上报观测值并执行服务端决策。本文件是按规范的协议客户端，
/// 档位表数值以服务端 `quality-core.js` 的 DEFAULT_TIER_TABLE 为准。
/// 旧 `QualityController.reportProbe` 的本地降档不得与服务端决策
/// 混用：服务端决策到达时以服务端为准。
enum SpecQualityTier { smooth, balanced, clear, original }

extension SpecQualityTierWire on SpecQualityTier {
  String get wire => name;

  static SpecQualityTier? fromWire(String? raw) {
    for (final t in SpecQualityTier.values) {
      if (t.name == raw) return t;
    }
    return null;
  }

  /// 未知档位回退默认档 balanced（§1）。
  static SpecQualityTier fromWireOrDefault(String? raw) =>
      fromWire(raw) ?? SpecQualityTier.balanced;

  SpecQualityTier get oneDown {
    final i = index;
    return i <= 0 ? this : SpecQualityTier.values[i - 1];
  }

  SpecQualityTier get oneUp {
    final i = index;
    return i >= SpecQualityTier.values.length - 1
        ? this
        : SpecQualityTier.values[i + 1];
  }
}

/// 档位表（§1，服务端 DEFAULT_TIER_TABLE 一字一致）。
class SpecQualityProfile {
  const SpecQualityProfile({
    required this.targetKbps,
    required this.maxFps,
    required this.fecRepairPercent,
    required this.resolutionScale,
    required this.encoderPreference,
  });

  final int targetKbps;
  final int maxFps;
  final int fecRepairPercent;
  final double resolutionScale;
  final String encoderPreference;
}

const Map<SpecQualityTier, SpecQualityProfile> specQualityTierTable = {
  SpecQualityTier.smooth: SpecQualityProfile(
    targetKbps: 800,
    maxFps: 15,
    fecRepairPercent: 5,
    resolutionScale: 0.5,
    encoderPreference: 'h264',
  ),
  SpecQualityTier.balanced: SpecQualityProfile(
    targetKbps: 2500,
    maxFps: 30,
    fecRepairPercent: 10,
    resolutionScale: 0.75,
    encoderPreference: 'h264',
  ),
  SpecQualityTier.clear: SpecQualityProfile(
    targetKbps: 5000,
    maxFps: 30,
    fecRepairPercent: 15,
    resolutionScale: 1.0,
    encoderPreference: 'h264',
  ),
  SpecQualityTier.original: SpecQualityProfile(
    targetKbps: 12000,
    maxFps: 60,
    fecRepairPercent: 20,
    resolutionScale: 1.0,
    encoderPreference: 'hevc',
  ),
};

/// 档位切换拆分（§1 末尾 / 服务端 `splitTierChange`）：
/// - 热可调（关键帧/块边界切换）：targetKbps、maxFps、fecRepairPercent；
/// - 需重建（切换触发 IDR、接收端清旧参考帧）：resolutionScale、
///   encoderPreference。不再宣称“全部即时无感”。
({Map<String, Object?> hot, Map<String, Object?> reconfig}) splitTierChange(
  SpecQualityProfile from,
  SpecQualityProfile to,
) {
  final hot = <String, Object?>{};
  final reconfig = <String, Object?>{};
  if (from.targetKbps != to.targetKbps) hot['targetKbps'] = to.targetKbps;
  if (from.maxFps != to.maxFps) hot['maxFps'] = to.maxFps;
  if (from.fecRepairPercent != to.fecRepairPercent) {
    hot['fecRepairPercent'] = to.fecRepairPercent;
  }
  if (from.resolutionScale != to.resolutionScale) {
    reconfig['resolutionScale'] = to.resolutionScale;
  }
  if (from.encoderPreference != to.encoderPreference) {
    reconfig['encoderPreference'] = to.encoderPreference;
  }
  return (hot: hot, reconfig: reconfig);
}

/// 探针样本（§2.1）。`lossPct` 指观看端下行（服务端→观看端）丢包，
/// 不得把两个方向的丢包率取平均后上报（§2.3 末尾）。
class QualityProbeSample {
  const QualityProbeSample({
    required this.rttMs,
    required this.lossPct,
    required this.jitterMs,
    this.lossSamples,
    this.decodeLagMs,
    this.pendingFrames,
    this.frameCorrupt,
    this.serverQueueBytes,
    this.serverSignalQueueBytes,
    this.serverSignalSendBlockedMs,
  });

  /// 必填；合理范围 0–10000。
  final num rttMs;

  /// 必填；0–100；统计窗口 1s 且样本数 ≥50 包才采信。
  final num lossPct;

  /// 必填；0–5000。
  final num jitterMs;

  /// 该 1s 窗口内的统计包数；<50 时服务端记降权日志，不直接拒收。
  final int? lossSamples;

  /// 可选；0–10000。
  final num? decodeLagMs;

  /// 可选；0–10000。
  final int? pendingFrames;

  /// 可选；只用于背压 L3 判定；不进服务端的值域校验。
  final bool? frameCorrupt;

  /// 可选；客户端观测到的服务端队列字节数，0–64MB（透传进样本记录）。
  final num? serverQueueBytes;

  /// serverSignal（§2.1）：客户端随探针上传；服务端 HTTP 层没有实测
  /// WS bufferedAmount 来填充它（§6.3）。观测不到时传 null / 省略，
  /// 不得编造。
  final num? serverSignalQueueBytes;
  final num? serverSignalSendBlockedMs;

  /// 缺必填字段（非有限数）→ 服务端返回 probe-incomplete，
  /// 该样本不入库、不参与判定（§2.3）。
  bool get isComplete =>
      rttMs.isFinite && lossPct.isFinite && jitterMs.isFinite;

  /// 值域外字段（仍入库，只记降权日志，§6.5）：客户端须自己先校验
  /// 再上报，不得依赖服务端清洗。返回越界字段名。
  List<String> get outOfRangeFields {
    final bad = <String>[];
    if (rttMs < 0 || rttMs > 10000) bad.add('rttMs');
    if (lossPct < 0 || lossPct > 100) bad.add('lossPct');
    if (jitterMs < 0 || jitterMs > 5000) bad.add('jitterMs');
    if (decodeLagMs != null && (decodeLagMs! < 0 || decodeLagMs! > 10000)) {
      bad.add('decodeLagMs');
    }
    if (pendingFrames != null &&
        (pendingFrames! < 0 || pendingFrames! > 10000)) {
      bad.add('pendingFrames');
    }
    if (serverQueueBytes != null &&
        (serverQueueBytes! < 0 || serverQueueBytes! > 64 * 1024 * 1024)) {
      bad.add('serverQueueBytes');
    }
    if (lossSamples != null && lossSamples! < 50) bad.add('lossSamples<50');
    return bad;
  }

  Map<String, Object?> toProbeJson() => {
        'rttMs': rttMs,
        'lossPct': lossPct,
        if (lossSamples != null) 'lossSamples': lossSamples,
        'jitterMs': jitterMs,
        if (decodeLagMs != null) 'decodeLagMs': decodeLagMs,
        if (pendingFrames != null) 'pendingFrames': pendingFrames,
        if (frameCorrupt != null) 'frameCorrupt': frameCorrupt,
        if (serverQueueBytes != null) 'serverQueueBytes': serverQueueBytes,
      };

  Map<String, Object?>? get serverSignalJson {
    if (serverSignalQueueBytes == null &&
        serverSignalSendBlockedMs == null) {
      return null;
    }
    return {
      if (serverSignalQueueBytes != null)
        'queueBytes': serverSignalQueueBytes,
      if (serverSignalSendBlockedMs != null)
        'sendBlockedMs': serverSignalSendBlockedMs,
    };
  }
}

/// 探针周期（§2.3）：正常 1s；弱网或档位切换后 10s 内 500ms；
/// 页面/应用隐藏时 5s。
Duration probeInterval({
  required bool weakNetwork,
  required bool hidden,
  int? tierChangedAtMs,
  required int nowMs,
}) {
  if (hidden) return const Duration(seconds: 5);
  if (weakNetwork) return const Duration(milliseconds: 500);
  if (tierChangedAtMs != null &&
      nowMs - tierChangedAtMs < 10000) {
    return const Duration(milliseconds: 500);
  }
  return const Duration(seconds: 1);
}

/// 档位决策（降档 downgrade-to / 升档 upgrade-to，§4.1/§4.2）。
class QualityDecision {
  const QualityDecision({
    required this.kind,
    required this.decisionId,
    required this.from,
    required this.to,
    required this.hot,
    required this.reconfig,
    required this.mustAckByMs,
    required this.needsIdr,
  });

  /// `downgrade-to` / `upgrade-to`。
  final String kind;
  final String decisionId;
  final SpecQualityTier from;
  final SpecQualityTier to;
  final Map<String, Object?> hot;
  final Map<String, Object?> reconfig;

  /// ACK 截止时刻（决策时刻＋5000ms）。
  final int mustAckByMs;
  final bool needsIdr;

  bool get isDowngrade => kind == 'downgrade-to';
  bool get isUpgrade => kind == 'upgrade-to';

  /// FEC 档位映射（§6.1 待定项）：hot 里的 fecRepairPercent 中间值
  /// （10%/15%）映射为 null，调用方不得自行发明第三种 (k, m)，
  /// 须保持当前 FEC 档位。
  FecProfile? get fecProfile {
    final percent = hot['fecRepairPercent'];
    if (percent is! num) return null;
    return fecProfileForRepairPercent(percent);
  }

  factory QualityDecision.fromJson(Map<String, Object?> json) {
    final kind = json['decision'] as String? ?? '';
    final hotRaw = json['hot'];
    final reconfigRaw = json['reconfig'];
    return QualityDecision(
      kind: kind,
      decisionId: json['decisionId'] as String? ?? '',
      from: SpecQualityTierWire.fromWireOrDefault(
        json['from'] as String?,
      ),
      to: SpecQualityTierWire.fromWireOrDefault(json['to'] as String?),
      hot: hotRaw is Map<String, Object?>
          ? hotRaw
          : hotRaw is Map
              ? Map<String, Object?>.from(hotRaw)
              : const {},
      reconfig: reconfigRaw is Map<String, Object?>
          ? reconfigRaw
          : reconfigRaw is Map
              ? Map<String, Object?>.from(reconfigRaw)
              : const {},
      mustAckByMs: json['mustAckByMs'] as int? ?? 0,
      needsIdr: json['needsIdr'] as bool? ?? false,
    );
  }
}

/// 背压决策（§5，随每次探针响应返回，无单独端点；不产生 decisionId、
/// 不须 ACK）。
class BackpressureDecision {
  const BackpressureDecision({
    required this.level,
    required this.action,
    required this.note,
  });

  /// `L1` / `L2` / `L3` / null（无背压，或仅客户端自报未交叉验证）。
  final String? level;

  /// `reduce-fps` / `reduce-resolution-bitrate` /
  /// `drop-to-keyframe` / null。
  final String? action;
  final String note;

  bool get hasAction => level != null && action != null;

  /// 仅客户端自报堆积，不触发背压（§5.2）：服务端只记日志，
  /// 返回 level/action 为 null。客户端此时不得擅自降档。
  bool get isHintOnly =>
      level == null && note.contains('仅客户端自报');

  factory BackpressureDecision.fromJson(Map<String, Object?> json) =>
      BackpressureDecision(
        level: json['level'] as String?,
        action: json['action'] as String?,
        note: json['note'] as String? ?? '',
      );
}

/// 探针响应。
class QualityProbeResponse {
  const QualityProbeResponse({
    required this.tier,
    this.decision,
    required this.backpressure,
    this.probeIncomplete = false,
  });

  final SpecQualityTier tier;
  final QualityDecision? decision;
  final BackpressureDecision backpressure;
  final bool probeIncomplete;

  factory QualityProbeResponse.fromJson(Map<String, Object?> json) {
    final decisionRaw = json['decision'];
    QualityDecision? decision;
    var incomplete = false;
    if (decisionRaw is Map<String, Object?>) {
      if (decisionRaw['reason'] == 'probe-incomplete') {
        incomplete = true;
      } else if (decisionRaw['decision'] != null) {
        decision = QualityDecision.fromJson(decisionRaw);
      }
    } else if (decisionRaw is Map) {
      final m = Map<String, Object?>.from(decisionRaw);
      if (m['reason'] == 'probe-incomplete') {
        incomplete = true;
      } else if (m['decision'] != null) {
        decision = QualityDecision.fromJson(m);
      }
    }
    final bpRaw = json['backpressure'];
    final bp = bpRaw is Map<String, Object?>
        ? BackpressureDecision.fromJson(bpRaw)
        : bpRaw is Map
            ? BackpressureDecision.fromJson(
                Map<String, Object?>.from(bpRaw),
              )
            : const BackpressureDecision(
                level: null,
                action: null,
                note: '无背压。',
              );
    return QualityProbeResponse(
      tier: SpecQualityTierWire.fromWireOrDefault(
        json['tier'] as String?,
      ),
      decision: decision,
      backpressure: bp,
      probeIncomplete: incomplete,
    );
  }
}

/// 手动升档拒绝码（§4.2）。
class QualityUpgradeRejection {
  const QualityUpgradeRejection({
    required this.code,
    required this.message,
    this.retryAfterMs,
  });

  /// `AT_TOP` / `NO_HEALTH_WINDOW` / `NOT_HEALTHY` /
  /// `PINGPONG_COOLDOWN` / `NOT_FOUND`。
  final String code;
  final String message;
  final int? retryAfterMs;

  String get displayText {
    switch (code) {
      case 'AT_TOP':
        return '已是最高档。';
      case 'NO_HEALTH_WINDOW':
        return '健康样本不足，需 20 秒健康样本（≥5 个）才能升档。';
      case 'NOT_HEALTHY':
        return '网络未持续健康 20 秒（须 rtt<150、loss<1%、jitter<30ms、decodeLag<150ms），暂不升档。';
      case 'PINGPONG_COOLDOWN':
        return '该档近期反复升降，冷却中。';
      case 'NOT_FOUND':
        return '会话不存在（须先上报探针）。';
      default:
        return message;
    }
  }
}

/// 质量传输接口（测试用假实现；生产实现见 [HttpQualityTransport]）。
abstract class QualityTransport {
  Future<QualityProbeResponse> probe({
    required String sessionId,
    required SpecQualityTier tier,
    required QualityProbeSample sample,
  });

  Future<({QualityDecision? decision, QualityUpgradeRejection? rejection})>
      upgrade({required String sessionId});

  Future<({bool ok, String? code, SpecQualityTier? tier, int? rttMs})> ack({
    required String sessionId,
    required String decisionId,
  });
}

class QualityApiException implements Exception {
  const QualityApiException(this.code, [this.message = '']);
  final String code;
  final String message;
  @override
  String toString() => 'QualityApiException($code)';
}

class HttpQualityTransport implements QualityTransport {
  HttpQualityTransport({String? baseUrl, ConsoleCookieProvider? cookieProvider})
      : _baseUrl = baseUrl ?? kServerOrigin,
        _cookieProvider = cookieProvider;

  final String _baseUrl;
  static const _timeout = Duration(seconds: 15);

  /// 控制台会话 cookie（DevicePresenceClient 同款 cookie 桥）：
  /// `/license/api/*` 须控制台会话，未带有效 cookie 时服务端回 401；
  /// 不传时保持旧行为（不带 cookie），调用方须自行保证已登录。
  final ConsoleCookieProvider? _cookieProvider;

  Future<void> _attachCookie(HttpClientRequest req) async {
    final cookie = await _cookieProvider?.call();
    if (cookie != null && cookie.isNotEmpty) {
      req.headers.set(HttpHeaders.cookieHeader, cookie);
    }
  }

  Future<Map<String, Object?>> _postJson(
    String path,
    Map<String, Object?> body,
  ) async {
    final client = trustedHttpClient(connectionTimeout: _timeout);
    try {
      final uri = Uri.parse(_baseUrl).resolve(path);
      final req = await client.postUrl(uri).timeout(_timeout);
      req.headers.contentType = ContentType.json;
      await _attachCookie(req);
      req.write(jsonEncode(body));
      final res = await req.close().timeout(_timeout);
      final text = await res.transform(utf8.decoder).join().timeout(_timeout);
      if (res.statusCode == 401 || res.statusCode == 403) {
        throw const QualityApiException('UNAUTHORIZED');
      }
      if (res.statusCode == 503) {
        throw const QualityApiException('L5_UNAVAILABLE');
      }
      final decoded = jsonDecode(text);
      if (decoded is! Map<String, Object?>) {
        throw const FormatException('quality 响应不是 JSON 对象');
      }
      return decoded;
    } finally {
      client.close(force: true);
    }
  }

  @override
  Future<QualityProbeResponse> probe({
    required String sessionId,
    required SpecQualityTier tier,
    required QualityProbeSample sample,
  }) async {
    final body = <String, Object?>{
      'sessionId': sessionId,
      'tier': tier.wire,
      'probe': sample.toProbeJson(),
    };
    final signal = sample.serverSignalJson;
    if (signal != null) body['serverSignal'] = signal;
    final json = await _postJson('/license/api/session/probe', body);
    return QualityProbeResponse.fromJson(json);
  }

  @override
  Future<({QualityDecision? decision, QualityUpgradeRejection? rejection})>
      upgrade({required String sessionId}) async {
    final json = await _postJson(
      '/license/api/session/quality/upgrade',
      {'sessionId': sessionId},
    );
    if (json['ok'] == true) {
      return (
        decision: QualityDecision.fromJson(json),
        rejection: null,
      );
    }
    return (
      decision: null,
      rejection: QualityUpgradeRejection(
        code: json['code'] as String? ?? 'UNKNOWN',
        message: json['msg'] as String? ?? '',
        retryAfterMs: json['retryAfterMs'] as int?,
      ),
    );
  }

  @override
  Future<({bool ok, String? code, SpecQualityTier? tier, int? rttMs})> ack({
    required String sessionId,
    required String decisionId,
  }) async {
    final json = await _postJson(
      '/license/api/session/quality/ack',
      {'sessionId': sessionId, 'decisionId': decisionId},
    );
    if (json['ok'] == true) {
      return (
        ok: true,
        code: null,
        tier: SpecQualityTierWire.fromWire(json['tier'] as String?),
        rttMs: json['rttMs'] as int?,
      );
    }
    return (
      ok: false,
      code: json['code'] as String?,
      tier: null,
      rttMs: null,
    );
  }
}

/// 档位执行与 ACK 编排（§4.3/§4.4）。
///
/// - 收到 downgrade-to / upgrade-to 后：先执行 hot 参数（下一关键帧/
///   块边界生效），再执行 reconfig 参数（编码器重配；needsIdr 为真时
///   发 IDR 并清旧参考帧）；
/// - 执行完成后须调 ACK；执行失败时**不得伪造 ACK**（实现里 ACK 只有
///   “收到并执行”一种语义，没有“执行失败”分支）：保持旧档位、记本地
///   日志，并在下一次探针里如实上报当前实际档位；
/// - ACK 须在 mustAckByMs 前到达；超时 5000ms 未 ACK，服务端只记
///   `quality-ack-timeout` 日志并清除该待 ACK 项，**不重发**（§6.4）：
///   客户端收到新决策前须先把旧决策的 ACK 发掉，不得堆积多个未 ACK
///   决策；超时后只记日志，不重发决策、不补 ACK；
/// - 档位切换不重连会话。
class QualitySessionClient {
  QualitySessionClient({
    required this.sessionId,
    required QualityTransport transport,
    IdrRequester? idrRequester,
    SpecQualityTier initialTier = SpecQualityTier.balanced,
    void Function(QualityDecision decision)? onHotApplied,
    void Function(QualityDecision decision)? onReconfigApplied,
    void Function()? onClearReferenceFrames,
  })  : _transport = transport,
        _idrRequester = idrRequester,
        _tier = initialTier,
        _onHotApplied = onHotApplied,
        _onReconfigApplied = onReconfigApplied,
        _onClearReferenceFrames = onClearReferenceFrames;

  final String sessionId;
  final QualityTransport _transport;
  final IdrRequester? _idrRequester;
  final void Function(QualityDecision decision)? _onHotApplied;
  final void Function(QualityDecision decision)? _onReconfigApplied;
  final void Function()? _onClearReferenceFrames;

  SpecQualityTier _tier;
  SpecQualityTier get tier => _tier;
  SpecQualityProfile get profile => specQualityTierTable[_tier]!;

  QualityDecision? _pendingDecision;
  QualityDecision? get pendingDecision => _pendingDecision;

  /// 超时未 ACK 的决策 id（只记日志，不重发，§6.4）。
  final List<String> ackTimedOutDecisionIds = [];

  /// 本地诊断日志（节流/超时等正常行为记日志，不向用户报错）。
  final List<String> diagnosticLog = [];

  int? _tierChangedAtMs;
  int? get tierChangedAtMs => _tierChangedAtMs;

  /// 发一次探针。缺必填字段时本地直接返回 probe-incomplete，
  /// 不发网络请求（该样本不入库、不参与判定，§2.3）。
  Future<QualityProbeResponse> sendProbe(
    QualityProbeSample sample, {
    required int nowMs,
  }) async {
    if (!sample.isComplete) {
      return const QualityProbeResponse(
        tier: SpecQualityTier.balanced,
        backpressure: BackpressureDecision(
          level: null,
          action: null,
          note: '无背压。',
        ),
        probeIncomplete: true,
      );
    }
    final outOfRange = sample.outOfRangeFields;
    if (outOfRange.isNotEmpty) {
      diagnosticLog.add(
        'quality-probe-downweighted: ${outOfRange.join(',')}',
      );
    }
    // 旧决策未 ACK 时先清扫超时项（服务端同样在每次探针时清扫）。
    sweepAckTimeouts(nowMs);
    final response = await _transport.probe(
      sessionId: sessionId,
      tier: _tier,
      sample: sample,
    );
    _tier = response.tier;
    if (response.decision != null) {
      await applyDecision(response.decision!, nowMs: nowMs);
    }
    if (response.backpressure.hasAction) {
      await applyBackpressure(response.backpressure, nowMs: nowMs);
    }
    // 仅自报堆积不触发时不擅自降档（§5.2）。
    return response;
  }

  /// 执行决策：先 hot，再 reconfig；needsIdr 时发 IDR（reason=
  /// quality-change）并清旧参考帧；执行完成后 5s 内 ACK。
  /// 执行失败（调用方回调抛错）时保持旧档位、不发 ACK、不伪造 ACK。
  Future<bool> applyDecision(QualityDecision decision, {int? nowMs}) async {
    if (_pendingDecision != null &&
        _pendingDecision!.decisionId != decision.decisionId) {
      // 收到新决策前须先把旧决策的 ACK 发掉，不得堆积多个未 ACK 决策。
      await ackPending(nowMs: nowMs ?? DateTime.now().millisecondsSinceEpoch);
    }
    final previousTier = _tier;
    try {
      _onHotApplied?.call(decision);
      if (decision.reconfig.isNotEmpty) {
        _onReconfigApplied?.call(decision);
      }
    } catch (e) {
      // 执行失败：保持旧档位、记本地日志，不发 ACK。
      _tier = previousTier;
      diagnosticLog.add(
        'quality-decision-apply-failed: ${decision.decisionId} $e',
      );
      return false;
    }
    _tier = decision.to;
    _tierChangedAtMs = nowMs ?? DateTime.now().millisecondsSinceEpoch;
    _pendingDecision = decision;
    if (decision.needsIdr) {
      _onClearReferenceFrames?.call();
      final idr = _idrRequester;
      if (idr != null) {
        await idr.sendQualityChange();
      }
    }
    return true;
  }

  /// 对当前待 ACK 决策发 ACK。未知 decisionId 时不得重试同一 id。
  Future<bool> ackPending({int? nowMs}) async {
    final decision = _pendingDecision;
    if (decision == null) return true;
    final at = nowMs ?? DateTime.now().millisecondsSinceEpoch;
    if (at > decision.mustAckByMs) {
      // 已超时：服务端已清除该项，只记日志，不补 ACK、不重发。
      ackTimedOutDecisionIds.add(decision.decisionId);
      diagnosticLog.add('quality-ack-timeout: ${decision.decisionId}');
      _pendingDecision = null;
      return false;
    }
    final result = await _transport.ack(
      sessionId: sessionId,
      decisionId: decision.decisionId,
    );
    if (!result.ok) {
      // UNKNOWN_DECISION：不得重试同一 decisionId。
      diagnosticLog.add(
        'quality-ack-rejected: ${decision.decisionId} ${result.code}',
      );
      _pendingDecision = null;
      return false;
    }
    _pendingDecision = null;
    return true;
  }

  /// 清扫超时待 ACK 项（服务端在每次探针时清扫超时项，§4.4）。
  /// 返回本次超时的 decisionId 列表。
  List<String> sweepAckTimeouts(int nowMs) {
    final decision = _pendingDecision;
    if (decision == null) return const [];
    if (nowMs > decision.mustAckByMs) {
      ackTimedOutDecisionIds.add(decision.decisionId);
      diagnosticLog.add('quality-ack-timeout: ${decision.decisionId}');
      _pendingDecision = null;
      return [decision.decisionId];
    }
    return const [];
  }

  /// 手动升档（§4.2）：仅在健康时可点；拒绝时调用方展示
  /// [QualityUpgradeRejection.displayText] 对应的原因。
  /// 成功时按决策执行（同 applyDecision，一次只升一档）。
  Future<({QualityDecision? decision, QualityUpgradeRejection? rejection})>
      requestUpgrade({int? nowMs}) async {
    final result = await _transport.upgrade(sessionId: sessionId);
    if (result.decision != null) {
      await applyDecision(result.decision!, nowMs: nowMs);
    }
    return result;
  }

  /// 背压执行（§5.1）：L1 先降生产速率（降帧率）→ L2 降分辨率/码率
  /// → L3 丢弃到关键帧＋受控 IDR（reason=loss，进 QF-VIDEO-1 限流）。
  /// 背压不是档位决策，不产生 decisionId、不须 ACK。
  /// 返回执行动作描述；hint-only 时返回 null（不擅自降档）。
  Future<String?> applyBackpressure(
    BackpressureDecision backpressure, {
    int? nowMs,
  }) async {
    switch (backpressure.action) {
      case 'reduce-fps':
        return 'reduce-fps';
      case 'reduce-resolution-bitrate':
        return 'reduce-resolution-bitrate';
      case 'drop-to-keyframe':
        final idr = _idrRequester;
        if (idr != null) {
          await idr.sendLoss();
        }
        _onClearReferenceFrames?.call();
        return 'drop-to-keyframe';
      default:
        return null;
    }
  }
}
