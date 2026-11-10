import 'package:flutter_test/flutter_test.dart';
import 'package:qfremote/core/session_stage.dart';
import 'package:qfremote/services/session_log.dart';

void main() {
  group('会话阶段超时（A1/A3：与服务端 SESSION_STAGE_TIMEOUT 同值）', () {
    test('各阶段超时秒数', () {
      expect(kSessionStageTimeouts[SessionStage.iframeAttach], 8);
      expect(kSessionStageTimeouts[SessionStage.iframeLoad], 12);
      expect(kSessionStageTimeouts[SessionStage.webappReady], 15);
      expect(kSessionStageTimeouts[SessionStage.peerConnecting], 25);
      expect(kSessionStageTimeouts[SessionStage.videoReady], 20);
      expect(kSessionTotalTimeoutSec, 60);
    });

    test('超时错误码与网页侧逐字一致', () {
      expect(sessionTimeoutCode(SessionStage.iframeAttach),
          'TIMEOUT_IFRAME_ATTACH');
      expect(sessionTimeoutCode(SessionStage.iframeLoad), 'TIMEOUT_IFRAME_LOAD');
      expect(sessionTimeoutCode(SessionStage.webappReady), 'TIMEOUT_WEBAPP_READY');
      expect(sessionTimeoutCode(SessionStage.peerConnecting),
          'TIMEOUT_PEER_CONNECTING');
      expect(sessionTimeoutCode(SessionStage.videoReady), 'TIMEOUT_VIDEO_READY');
    });

    test('阶段日志名', () {
      expect(sessionStageLogName(SessionStage.iframeAttach), 'iframe-attach');
      expect(sessionStageLogName(SessionStage.videoReady), 'video-ready');
    });
  });

  group('会话路由解析', () {
    test('#session/ hash 路由', () {
      final r = parseSessionRoute('https://app.qfremote.top/#session/node123');
      expect(r?.nodeid, 'node123');
      expect(r?.viewMode, 11);
    });

    test('?node=&viewmode= 深链', () {
      final r = parseSessionRoute(
          'https://app.qfremote.top/?node=node%2Fabc&viewmode=11&qfm=frame');
      expect(r?.nodeid, 'node/abc');
      expect(r?.viewMode, 11);
      expect(bareNodeId(r!.nodeid), 'abc');
    });

    test('非会话路由返回 null', () {
      expect(parseSessionRoute('https://app.qfremote.top/'), isNull);
      expect(parseSessionRoute('https://app.qfremote.top/?node=x'), isNull);
      expect(parseSessionRoute('https://app.qfremote.top/#devices'), isNull);
    });
  });

  group('探针读数 → 阶段映射（A1 兜底口径）', () {
    SessionProbeReading reading({
      bool frameExists = false,
      bool frameReady = false,
      bool winReady = false,
      String sessState = '',
      String deskStatus = '',
      int canvasW = 0,
      int canvasH = 0,
    }) =>
        SessionProbeReading(
          frameExists: frameExists,
          frameReady: frameReady,
          winReady: winReady,
          sessState: sessState,
          deskStatus: deskStatus,
          canvasW: canvasW,
          canvasH: canvasH,
        );

    test('无框 → attach；有框未 ready → load；ready 未 winReady → webapp-ready',
        () {
      expect(mapSessionProbe(reading()), SessionStage.iframeAttach);
      expect(mapSessionProbe(reading(frameExists: true)),
          SessionStage.iframeLoad);
      expect(mapSessionProbe(reading(frameExists: true, frameReady: true)),
          SessionStage.webappReady);
    });

    test('deskstatus 正在建立 → peer-connecting；Connected+画布 → video-ready',
        () {
      expect(
          mapSessionProbe(reading(
              frameExists: true, frameReady: true, deskStatus: '正在建立会话…')),
          SessionStage.peerConnecting);
      expect(
          mapSessionProbe(reading(
              frameExists: true,
              frameReady: true,
              winReady: true,
              sessState: 'connected',
              deskStatus: 'Connected',
              canvasW: 800,
              canvasH: 600)),
          SessionStage.videoReady);
      // Connected 但无画布尺寸不算 video-ready
      expect(
          mapSessionProbe(reading(
              frameExists: true,
              frameReady: true,
              winReady: true,
              deskStatus: 'Connected')),
          SessionStage.peerConnecting);
    });

    test('探针 JSON 解析与坏数据', () {
      final r = SessionProbeReading.parse(
          '{"frameExists":true,"frameReady":true,"winReady":false,"sessState":"connecting","deskStatus":"","canvasW":0,"canvasH":0}');
      expect(r?.frameReady, isTrue);
      expect(r?.sessState, 'connecting');
      expect(SessionProbeReading.parse('junk'), isNull);
    });
  });

  group('预检分类（A5/A9：lastAgentPong 120 秒新鲜度）', () {
    DevicePresence presence(String code,
            {bool online = true, bool fresh = true, int? ageMs}) =>
        DevicePresence(
          ok: true,
          code: code,
          nodeid: 'n1',
          name: '笔记本',
          online: online,
          fresh: fresh,
          lastAgentPongAgeMs: ageMs,
        );

    test('ONLINE 且 fresh → ok；STALE → offlineStale', () {
      expect(classifyPreflight(presence('ONLINE')), PreflightOutcome.ok);
      expect(classifyPreflight(presence('STALE', fresh: false, ageMs: 180000)),
          PreflightOutcome.offlineStale);
      // ONLINE 但 fresh 为假同样判 stale（node.conn 为真也不信）
      expect(classifyPreflight(presence('ONLINE', fresh: false)),
          PreflightOutcome.offlineStale);
    });

    test('OFFLINE/NOT_FOUND → offlineConn；TIMEOUT/UNKNOWN/null → 超时', () {
      expect(classifyPreflight(presence('OFFLINE', online: false)),
          PreflightOutcome.offlineConn);
      expect(classifyPreflight(presence('NOT_FOUND', online: false)),
          PreflightOutcome.offlineConn);
      expect(classifyPreflight(presence('TIMEOUT')),
          PreflightOutcome.preflightTimeout);
      expect(classifyPreflight(presence('UNKNOWN')),
          PreflightOutcome.preflightTimeout);
      expect(classifyPreflight(null), PreflightOutcome.preflightTimeout);
      expect(classifyPreflight(presence('ONLINE'), timedOut: true),
          PreflightOutcome.preflightTimeout);
    });

    test('QF-07：authExpired 有独立的「登录已过期」卡片文案', () {
      final text = preflightCardText(PreflightOutcome.authExpired, presence('ONLINE'));
      expect(text.title, '登录已过期');
      expect(text.body, contains('重新登录'));
    });

    test('预检响应解析', () {
      final p = DevicePresence.parse(
          '{"ok":true,"code":"STALE","nodeid":"n1","name":"笔记本","online":true,"fresh":false,"lastAgentPong":1762800000000,"lastAgentPongAgeMs":180000,"serverTime":1762800180000}');
      expect(p?.code, 'STALE');
      expect(p?.name, '笔记本');
      expect(p?.lastAgentPongAgeMs, 180000);
      expect(p?.serverTime?.millisecondsSinceEpoch, 1762800180000);
      expect(DevicePresence.parse('junk'), isNull);
    });

    test('失败卡片文案分级', () {
      final stale = presence('STALE', fresh: false, ageMs: 180000);
      final t = preflightCardText(PreflightOutcome.offlineStale, stale);
      expect(t.title, '设备当前不在线');
      expect(t.body, contains('180 秒'));
      expect(
          preflightCardText(PreflightOutcome.offlineConn, presence('OFFLINE'))
              .body,
          contains('未连接到服务器'));
      expect(
          preflightCardText(PreflightOutcome.preflightTimeout, null).title,
          '无法确认设备状态');
    });
  });

  group('会话日志格式（A10）', () {
    test('formatSessionLogLine 与文件格式一致', () {
      final line = formatSessionLogLine(
        DateTime(2026, 11, 10, 2, 24, 30, 123),
        'video-ready',
        nodeid: 'n1',
        extra: 'elapsedMs=8500',
      );
      expect(line, '02:24:30.123 video-ready node=n1 elapsedMs=8500');
    });
  });
}
