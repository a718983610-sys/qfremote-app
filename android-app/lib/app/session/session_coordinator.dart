import 'dart:async';
import 'dart:math';
import 'dart:typed_data';

import '../../data/session/idr_client.dart';
import '../../data/session/quality_client.dart';
import '../../data/session/recording_client.dart';
import '../../data/session/relay_selector.dart';
import '../../data/session/stream_transfer.dart';
import '../../services/points.dart' show ConsoleCookieProvider;
import '../../services/probe.dart' show probeServer;

/// RC-03/07/08/09/10 会话客户端层接线（第 2 轮 #5）。
///
/// 生产现状：远程桌面本身仍在设备槽 WebView 里的 MeshCentral iframe；
/// 本协调器把 Dart 侧的会话协议客户端（中继选路／IDR／画质探针／
/// 录像／文件流）接到会话生命周期上，取代“实现存在、生产零调用”。
///
/// 接线口径（以 main.dart 会话阶段机为准）：
/// - 会话预检通过后跑中继选路门（[checkRelayGate]，QF-RELAY-1 §2.2）；
/// - video-ready 后 [beginSession]：IDR join、录像 start、画质探针循环；
/// - 离开会话／失败卡走 [endSession]（幂等）：录像 end、待 ACK 补发、
///   停探针循环、清在途计数；
/// - 切后台 [noteBackgrounded]：录像暂停上报、在途拨号取消计数、
///   探针切 5s；回前台 [noteResumed] 恢复。
///
/// 诚实边界（不冒充已接通，见 WIRING-R2-SESSION.md）：
/// - 画质探针只发实测样本：RTT 由 [NetworkRttProbeSource] 实测，
///   lossPct／jitterMs 在 Dart 侧无包级测量源（画面帧在 WebView 内，
///   不到 Dart），样本不完整时 [QualitySessionClient.sendProbe] 本地
///   直接返回 probe-incomplete、不发网络请求——循环已接线、探针网络
///   流量待测量源落地（WebView getStats 桥，另派线）；
/// - FEC 解码（[FecDecoder]）未接帧路：线上传输打包格式未定
///   （QF-VIDEO-1 §1.3 未定项），且帧字节不到 Dart，解码器仍为
///   已测试的纯逻辑库，不得宣称已实现真机纠错；
/// - 录像事件捕获未接：input／clipboard／frame-marker 真实埋点
///   未实现（QF-REC-1 §6.5 另派线），本线只接 start／end 与档位变化
///   事件（档位真变时才发）；
/// - 文件流 UI 仍在 WebView：本线只把传输客户端挂进协调器供后续
///   原生 UI 调用，不谎称已有原生文件页。
class SessionCoordinator {
  SessionCoordinator({
    required String Function() baseUrlProvider,
    ConsoleCookieProvider? cookieProvider,
    RelayTransport? relayTransport,
    QualityTransport? qualityTransport,
    RecordingTransport? recordingTransport,
    StreamTransport? streamTransport,
    IdrRequester Function(String sessionId, String agentId)?
        idrRequesterFactory,
    SessionProbeSource? probeSource,
  })  : _baseUrlProvider = baseUrlProvider,
        _cookieProvider = cookieProvider,
        _injectedRelayTransport = relayTransport,
        _injectedQualityTransport = qualityTransport,
        _injectedRecordingTransport = recordingTransport,
        _injectedStreamTransport = streamTransport,
        _idrRequesterFactory = idrRequesterFactory,
        _probeSource = probeSource ?? NetworkRttProbeSource();

  final String Function() _baseUrlProvider;
  final ConsoleCookieProvider? _cookieProvider;
  final RelayTransport? _injectedRelayTransport;
  final QualityTransport? _injectedQualityTransport;
  final RecordingTransport? _injectedRecordingTransport;
  final StreamTransport? _injectedStreamTransport;
  final IdrRequester Function(String sessionId, String agentId)?
      _idrRequesterFactory;
  final SessionProbeSource _probeSource;

  /// 本地诊断日志（只记事件与 code，不记密钥/会话口令/剪贴板内容）。
  final List<String> diagnosticLog = [];

  bool get isActive => _sessionId != null;
  String? get sessionId => _sessionId;
  SpecQualityTier get tier => _quality?.tier ?? SpecQualityTier.balanced;
  bool get recordingPolicyOff => _recordingPolicyOff;
  bool get relayDegraded => _relayDegraded;
  bool get authDead => _authDead;

  /// 会话要拨的地址：服务 origin 下的 console-engine 路径
  /// （中继宣告列表里的条目即该路径；白名单校验以它为准）。
  String get sessionDialUrl =>
      Uri.parse(_baseUrl).resolve('/console-engine/').toString();

  String? _sessionId;
  String? _nodeId;
  String _groupId = '';
  SpecQualityTier _initialTier = SpecQualityTier.balanced;

  RelaySessionController? _relay;
  QualitySessionClient? _quality;
  IdrRequester? _idr;
  RecordingSessionClient? _recording;
  StreamTransport? _stream;
  RecordingTransport? _recordingTransport;

  String? _lastBaseUrl;
  bool _recordingPolicyOff = false;
  bool _relayDegraded = false;
  bool _authDead = false;
  bool _hidden = false;
  bool _lastProbeOk = true;
  int _probeSkippedCount = 0;
  Timer? _qualityTimer;
  RelayEntry? _gatedRelay;

  void _log(String line) {
    diagnosticLog.add(line);
    if (diagnosticLog.length > 200) {
      diagnosticLog.removeRange(0, diagnosticLog.length - 200);
    }
  }

  String get _baseUrl => _baseUrlProvider();

  /// 基址变化（换节点／换域名走 _rebuildServicesNetwork）时重建
  /// 未注入的 Http 传输；注入的假传输（测试用）不受影响。
  void _ensureTransports() {
    final baseUrl = _baseUrl;
    if (_lastBaseUrl == baseUrl &&
        _relay != null &&
        _stream != null &&
        _recordingTransport != null) {
      return;
    }
    _lastBaseUrl = baseUrl;
    _relay = RelaySessionController(
      transport: _injectedRelayTransport ??
          HttpRelayTransport(
            baseUrl: baseUrl,
            cookieProvider: _cookieProvider,
          ),
    );
    _stream = _injectedStreamTransport ??
        HttpStreamTransport(
          baseUrl: baseUrl,
          cookieProvider: _cookieProvider,
        );
    _recordingTransport = _injectedRecordingTransport ??
        HttpRecordingTransport(
          baseUrl: baseUrl,
          cookieProvider: _cookieProvider,
        );
  }

  QualityTransport _qualityTransport() =>
      _injectedQualityTransport ??
      HttpQualityTransport(baseUrl: _baseUrl, cookieProvider: _cookieProvider);

  RecordingTransport _recordingTransportForSession() =>
      _recordingTransport ??
      HttpRecordingTransport(
        baseUrl: _baseUrl,
        cookieProvider: _cookieProvider,
      );

  /// 中继选路门（QF-RELAY-1 §2.2，会话预检通过后、建 watcher 前跑）：
  /// 取宣告列表 → 列表为空即降级阻断 → 会话拨号地址不在列表内即
  /// 伪造阻断 → 选一条候选记在途。取列表失败（网络／超时／L5 未加载）
  /// 时 fail-open（返回 unavailable，不挡既有 WebView 会话路）——
  /// 这是对 §2.2“列表为空或请求失败 → 不建连”的有意偏离：本线不
  /// 能让一次端点抖动直接断掉全部远程会话；白名单校验在列表可取时
  /// 仍严格执行。401（登录已死）同样走 unavailable，登录过期由
  /// 既有 auth-dead 流程处理，不在此处另出卡。
  Future<RelayGateResult> checkRelayGate() async {
    _ensureTransports();
    final relay = _relay!;
    try {
      await relay
          .loadAnnouncements()
          .timeout(const Duration(seconds: 3));
    } on RelayUnavailableException catch (e) {
      _log('relay-gate-unavailable: ${e.code}');
      return const RelayGateResult.unavailable();
    } on TimeoutException {
      _log('relay-gate-unavailable: timeout');
      return const RelayGateResult.unavailable();
    } catch (e) {
      _log('relay-gate-unavailable: $e');
      return const RelayGateResult.unavailable();
    }
    if (relay.list.isEmpty) {
      _relayDegraded = true;
      _log('relay-gate-blocked: empty-list');
      return const RelayGateResult.blocked(
        RelaySessionController.degradedMessage,
      );
    }
    final dialUrl = sessionDialUrl;
    if (!relay.checkAllowed(dialUrl)) {
      // 伪造地址：拒绝拨号＋界面提示＋本地日志（§3）；伪造地址不进
      // failedIds（它不是建连失败），直接阻断本次会话。
      final rejection =
          ForgedRelayRejection(url: dialUrl, at: DateTime.now());
      _log(rejection.logLine);
      return RelayGateResult.blocked(rejection.userMessage);
    }
    final pick = relay.pickNext();
    if (pick.degraded || pick.relay == null) {
      _relayDegraded = true;
      _log('relay-gate-blocked: ${pick.reason}');
      return const RelayGateResult.blocked(
        RelaySessionController.degradedMessage,
      );
    }
    _gatedRelay = pick.relay;
    relay.beginDial(pick.relay!.tier);
    return const RelayGateResult.allowed();
  }

  /// 会话开始（video-ready 后跑）：生成会话 id、IDR join、录像
  /// start、启动画质探针循环。任一步失败都不挡会话本身（IDR／录像／
  /// 探针是增强层，远程桌面在 WebView 内照常进行），只记诊断日志。
  Future<SessionBeginResult> beginSession({
    required String nodeId,
    required String deviceName,
    String groupId = '',
    bool lowQuality = false,
  }) async {
    if (isActive) {
      return SessionBeginResult(
        started: true,
        sessionId: _sessionId,
        recordingPolicyOff: _recordingPolicyOff,
      );
    }
    _ensureTransports();
    _nodeId = nodeId;
    _groupId = groupId;
    _initialTier =
        lowQuality ? SpecQualityTier.smooth : SpecQualityTier.balanced;
    _sessionId = _newSessionId();
    _authDead = false;
    _recordingPolicyOff = false;
    _probeSkippedCount = 0;
    _log('session-begun: $_sessionId device=$deviceName');

    final sessionId = _sessionId!;
    _idr = _idrRequesterFactory?.call(sessionId, nodeId) ??
        IdrRequester(
          sessionId: sessionId,
          agentId: nodeId,
          transport: HttpIdrTransport(
            baseUrl: _baseUrl,
            cookieProvider: _cookieProvider,
          ),
        );
    _quality = QualitySessionClient(
      sessionId: sessionId,
      transport: _qualityTransport(),
      idrRequester: _idr,
      initialTier: _initialTier,
      onHotApplied: (d) => _log(
        'quality-hot-applied: ${d.decisionId} to=${d.to.name}',
      ),
      onReconfigApplied: (d) => _log(
        'quality-reconfig-applied: ${d.decisionId} to=${d.to.name}',
      ),
      onClearReferenceFrames: () =>
          _log('quality-clear-reference-frames'),
    );
    _recording = RecordingSessionClient(
      transport: _recordingTransportForSession(),
    );

    // IDR join：新观看端加入，绑定后 10s 宽限内发一次（QF-VIDEO-1 §3）。
    try {
      final join = await _idr!.sendJoin().timeout(
            const Duration(seconds: 5),
          );
      _log('idr-join: ${join.code}');
      if (join.code == 'UNAUTHORIZED') _authDead = true;
    } catch (e) {
      _log('idr-join-failed: $e');
    }

    // 录像 start：POLICY_OFF 时不录制、不发事件（QF-REC-1 §2.1）。
    try {
      final ok = await _recording!
          .start(
            sessionIdForDesktop: sessionId,
            deviceId: nodeId,
            groupId: groupId,
            tier: _initialTier.name,
          )
          .timeout(const Duration(seconds: 5));
      if (!ok) {
        _recordingPolicyOff = _recording!.diagnosticLog.any(
          (l) => l.contains('POLICY_OFF'),
        );
        _log(
          'recording-not-started: policyOff=$_recordingPolicyOff',
        );
      }
    } catch (e) {
      _log('recording-start-failed: $e');
    }

    _scheduleNextQualityTick();
    return SessionBeginResult(
      started: true,
      sessionId: sessionId,
      recordingPolicyOff: _recordingPolicyOff,
    );
  }

  /// 画质探针一拍（定时器回调与测试共用）：量样本 → 完整才发探针 →
  /// 档位变化时发 quality-change 录像事件 → 待 ACK 决策补发。
  /// 样本不完整（无 loss／jitter 测量源）时不发网络请求，只记一次
  /// 跳过日志（之后每拍只计数，不刷日志）。
  Future<void> runProbeTick() async {
    final quality = _quality;
    if (!isActive || quality == null) return;
    final sample = await _probeSource.measureSample();
    if (sample == null) {
      _probeSkippedCount++;
      if (_probeSkippedCount == 1) {
        final source = _probeSource;
        final rtt = source is NetworkRttProbeSource ? source.lastRttMs : null;
        _log(
          'quality-probe-skipped: no loss/jitter source'
          '${rtt == null ? '' : ' (rtt=${rtt}ms)'}',
        );
      }
      _scheduleNextQualityTick();
      return;
    }
    final prevTier = quality.tier;
    try {
      await quality.sendProbe(
        sample,
        nowMs: DateTime.now().millisecondsSinceEpoch,
      );
      _lastProbeOk = true;
      if (quality.tier != prevTier) {
        await _postQualityChangeEvent(prevTier, quality.tier);
      }
      await quality.ackPending();
    } on QualityApiException catch (e) {
      _lastProbeOk = false;
      if (e.code == 'UNAUTHORIZED') {
        // 登录已死：停探针循环，不在此处另出卡（既有 auth-dead 流程接管）。
        _authDead = true;
        _log('quality-probe-unauthorized: loop stopped');
        _qualityTimer?.cancel();
        _qualityTimer = null;
        return;
      }
      _log('quality-probe-failed: ${e.code}');
    } catch (e) {
      _lastProbeOk = false;
      _log('quality-probe-failed: $e');
    }
    _scheduleNextQualityTick();
  }

  Future<void> _postQualityChangeEvent(
    SpecQualityTier from,
    SpecQualityTier to,
  ) async {
    final recording = _recording;
    if (recording == null || !recording.isRecording) return;
    final ok = await recording.postEvent(
      RecEvent.qualityChange(
        at: DateTime.now().millisecondsSinceEpoch,
        from: from.name,
        to: to.name,
      ),
    );
    if (!ok && recording.interrupted) {
      // 服务端重启致 NOT_FOUND：按 QF-REC-1 §6.2 提示中断并重开新录制。
      final restarted = await recording.handleNotFoundAndRestart(
        sessionIdForDesktop: _sessionId ?? '',
        deviceId: _nodeId ?? '',
        groupId: _groupId,
        tier: to.name,
      );
      _log('recording-restarted: ${restarted != null}');
    }
  }

  void _scheduleNextQualityTick() {
    _qualityTimer?.cancel();
    if (!isActive) return;
    final nowMs = DateTime.now().millisecondsSinceEpoch;
    final interval = probeInterval(
      weakNetwork: !_lastProbeOk,
      hidden: _hidden,
      tierChangedAtMs: _quality?.tierChangedAtMs,
      nowMs: nowMs,
    );
    _qualityTimer = Timer(interval, () {
      unawaited(runProbeTick());
    });
  }

  /// 手动升档（QF-QUALITY-1 §4.2）：仅健康时可点；拒绝时调用方按
  /// [QualityUpgradeRejection.displayText] 展示原因。
  Future<
      ({
        QualityDecision? decision,
        QualityUpgradeRejection? rejection,
      })> requestUpgrade() async {
    final quality = _quality;
    if (!isActive || quality == null) {
      return (decision: null, rejection: null);
    }
    try {
      return await quality.requestUpgrade();
    } on QualityApiException catch (e) {
      _log('quality-upgrade-failed: ${e.code}');
      return (decision: null, rejection: null);
    }
  }

  /// 切后台：录像暂停上报、在途拨号取消计数、探针切 5s 周期。
  void noteBackgrounded() {
    _hidden = true;
    _recording?.pauseForBackground();
    _relay?.cancelInFlightOnBackground();
  }

  /// 回前台：录像恢复上报（按 at 续发，不得倒序补发）、探针恢复常速。
  void noteResumed() {
    _hidden = false;
    _recording?.resumeFromBackground();
    _scheduleNextQualityTick();
  }

  /// 会话结束（离开会话路由／失败卡／登出，幂等）：录像 end、
  /// 待 ACK 决策补发、在途计数归还、停探针循环、清会话态。
  /// 在途计数归还放在 isActive 守卫之前：选路门通过后、beginSession
  /// 之前会话也可能失败（video-ready 前超时），计数不能泄漏。
  Future<void> endSession() async {
    final gated = _gatedRelay;
    if (gated != null) {
      _relay?.finishDial(tier: gated.tier);
      _gatedRelay = null;
    }
    if (!isActive) return;
    _qualityTimer?.cancel();
    _qualityTimer = null;
    final sessionId = _sessionId;
    _sessionId = null;
    try {
      await _quality?.ackPending();
    } catch (e) {
      _log('quality-ack-flush-failed: $e');
    }
    try {
      final ended = await _recording?.end();
      if (ended != null) {
        _log(
          'recording-ended: events=${ended.events} bytes=${ended.bytes}',
        );
      }
    } catch (e) {
      _log('recording-end-failed: $e');
    }
    _quality = null;
    _idr = null;
    _recording = null;
    _recordingPolicyOff = false;
    _relayDegraded = false;
    _nodeId = null;
    _groupId = '';
    _log('session-ended: $sessionId');
  }

  /// 文件流传输客户端（供后续原生文件 UI 调用；本轮只挂接线，不建 UI）。
  StreamTransport get streamTransport {
    _ensureTransports();
    return _stream!;
  }

  /// 录像传输客户端（供录像列表／回放调用）。
  RecordingTransport get recordingTransport {
    _ensureTransports();
    return _recordingTransport!;
  }

  /// 列出本人录像（QF-REC-1 §2.4）。
  Future<List<RecordingEntry>> listRecordings() async {
    _ensureTransports();
    return _recordingTransport!.list();
  }

  /// 下载整份录像文件（QF-REC-1 §2.6：不支持 Range，整文件下载；
  /// O1 已修：先校验状态码再读体、有大小上限）。
  Future<Uint8List?> downloadRecording({required String sessionId}) async {
    _ensureTransports();
    return _recordingTransport!.download(sessionId: sessionId);
  }

  /// 读取 seek 索引（QF-REC-1 §2.5）。
  Future<({List<RecSeekAnchor>? index, bool rebuilt, String? code})>
      readRecordingIndex({required String sessionId}) async {
    _ensureTransports();
    return _recordingTransport!.readIndex(sessionId: sessionId);
  }

  void dispose() {
    unawaited(endSession());
  }

  String _newSessionId() {
    final r = Random.secure();
    final hex = List.generate(
      8,
      (_) => r.nextInt(256).toRadixString(16).padLeft(2, '0'),
    ).join();
    return 'sess_$hex';
  }
}

/// 中继选路门结果。
class RelayGateResult {
  const RelayGateResult.allowed()
      : blocked = false,
        unavailable = false,
        message = null;

  const RelayGateResult.blocked(this.message)
      : blocked = true,
        unavailable = false;

  const RelayGateResult.unavailable()
      : blocked = false,
        unavailable = true,
        message = null;

  /// 阻断：URL 不在宣告列表内（伪造）或列表耗尽——不得新开桌面会话。
  final bool blocked;

  /// 未知：取列表失败——fail-open，允许既有 WebView 会话路继续。
  final bool unavailable;

  /// 阻断时给用户的文案（伪造提示或降级态文案）。
  final String? message;
}

/// 会话开始结果。
class SessionBeginResult {
  const SessionBeginResult({
    required this.started,
    required this.sessionId,
    required this.recordingPolicyOff,
  });

  final bool started;
  final String? sessionId;

  /// 录像策略未开启（POLICY_OFF）：本次会话不录制、不发事件。
  final bool recordingPolicyOff;
}

/// 画质探针样本源：量出一次可上报的样本；量不出时返回 null
/// （调用方不发网络请求，只记跳过——不得编数字冒充实测）。
abstract class SessionProbeSource {
  Future<QualityProbeSample?> measureSample();
}

/// 生产样本源：RTT 用探活实测（到服务 origin 的 HTTPS GET 往返）；
/// lossPct／jitterMs 在 Dart 侧无包级测量源（画面帧在 WebView 内，
/// 不到 Dart；探针往返耗时是本地求值延迟，不是中继 RTT），故始终
/// 返回 null——循环跑、网络探针不发。测量源落地（WebView
/// RTCPeerConnection.getStats 桥，另派线）后替换本实现即可，
/// 协调器其他部分不用改。
class NetworkRttProbeSource implements SessionProbeSource {
  /// 最近一次实测 RTT（毫秒），未测到为 null；仅供诊断日志用。
  int? lastRttMs;

  @override
  Future<QualityProbeSample?> measureSample() async {
    try {
      final r = await probeServer(timeout: const Duration(seconds: 5));
      if (r.ok) lastRttMs = r.elapsedMs;
    } catch (_) {
      // 量不到 RTT 也不抛：本拍跳过即可。
    }
    return null;
  }
}
