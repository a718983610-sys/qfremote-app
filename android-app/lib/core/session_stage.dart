import 'dart:convert';

/// 会话建立阶段机（2.4.5，A1/A3/A5/A9）——纯逻辑，可单测。
///
/// 结构性前提：Android 没有原生远程会话实现，会话全程是设备槽 WebView
/// 里的网页 SPA 会话 iframe。本文件只定义 Dart 侧能感知的阶段、超时与
/// 预检分类；网页侧的 postMessage（qf-remote-webapp-ready）与
/// QF_PRE.winReady 由网页/服务端线实现，Dart 侧经 qfSessionStage
/// JavaScriptHandler 接收（见 main.dart _registerLoginHandlers），
/// 未就绪时用 [kSessionStateJs] 探针读 Sess/#deskstatus/#Desk 兜底。

/// 会话建立五阶段（与服务端 SESSION_STAGE_TIMEOUT 同值）。
enum SessionStage {
  iframeAttach,
  iframeLoad,
  webappReady,
  peerConnecting,
  videoReady,
}

/// 各阶段独立超时（秒）——与服务端 SESSION_STAGE_TIMEOUT 逐字同值。
const Map<SessionStage, int> kSessionStageTimeouts = {
  SessionStage.iframeAttach: 8,
  SessionStage.iframeLoad: 12,
  SessionStage.webappReady: 15,
  SessionStage.peerConnecting: 25,
  SessionStage.videoReady: 20,
};

/// 会话总上限（秒）。
const int kSessionTotalTimeoutSec = 60;

/// 预检新鲜度：agent 最后心跳超过 120 秒即判离线（即使 node.conn 为真）。
const int kAgentPongFreshMs = 120000;

/// 阶段对应的超时错误码（与网页侧 showSessionMask 码表逐字一致）。
String sessionTimeoutCode(SessionStage stage) => switch (stage) {
      SessionStage.iframeAttach => 'TIMEOUT_IFRAME_ATTACH',
      SessionStage.iframeLoad => 'TIMEOUT_IFRAME_LOAD',
      SessionStage.webappReady => 'TIMEOUT_WEBAPP_READY',
      SessionStage.peerConnecting => 'TIMEOUT_PEER_CONNECTING',
      SessionStage.videoReady => 'TIMEOUT_VIDEO_READY',
    };

/// 阶段日志名（A10 会话留痕）。
String sessionStageLogName(SessionStage stage) => switch (stage) {
      SessionStage.iframeAttach => 'iframe-attach',
      SessionStage.iframeLoad => 'iframe-load',
      SessionStage.webappReady => 'webapp-ready',
      SessionStage.peerConnecting => 'peer-connecting',
      SessionStage.videoReady => 'video-ready',
    };

/// 会话路由解析：顶层 `#session/<nodeid>` hash 路由，或 `?node=&viewmode=`
/// 深链（viewmode 10/11/12）。返回 (裸 nodeid, viewmode)，不是会话路由
/// 返回 null。nodeid 可能带 `node/` 前缀，调用方用 [bareNodeId] 去前缀。
({String nodeid, int viewMode})? parseSessionRoute(String url) {
  final uri = Uri.tryParse(url);
  if (uri == null) return null;
  final frag = uri.fragment;
  if (frag.startsWith('session/')) {
    final rest = frag.substring('session/'.length);
    final id = rest.split('?').first.split('/').first;
    if (id.isEmpty) return null;
    return (nodeid: id, viewMode: 11);
  }
  final node = uri.queryParameters['node'];
  final vm = int.tryParse(uri.queryParameters['viewmode'] ?? '');
  if (node != null && node.isNotEmpty && vm != null && vm >= 10 && vm <= 12) {
    return (nodeid: node, viewMode: vm);
  }
  return null;
}

/// 去掉 nodeid 可能带的 `node/` 前缀（服务端预检接口要裸 nodeid）。
String bareNodeId(String nodeid) =>
    nodeid.startsWith('node/') ? nodeid.substring(5) : nodeid;

/// 会话状态探针脚本（兜底读数；网页侧 qfSessionStage handler 就绪时优先
/// 用 handler 打点，本脚本只作 handler 未就绪时的 1 秒轮询）。
/// 回传 JSON 字符串：frameExists/frameReady(QF_PRE.ready)/winReady
/// (QF_PRE.winReady)/sessState/deskStatus/canvasW/canvasH/fps。
/// fps 口径（A8）：顶层文档 requestAnimationFrame 自上拍以来的计数，
/// 即 WebView 渲染帧率估算，不是中继出帧率；首拍为 0（计数器刚启动）。
const String kSessionStateJs = r'''(function () {
  var out = {frameExists:false, frameReady:false, winReady:false, sessState:'', deskStatus:'', canvasW:0, canvasH:0, fps:0};
  try {
    var fc = window.__qfFps;
    if (!fc) {
      fc = window.__qfFps = {n:0};
      (function loop(){ fc.n++; requestAnimationFrame(loop); })();
    }
    out.fps = fc.n; fc.n = 0;
  try {
    var pre = window.QF_PRE || null;
    if (pre) { out.frameExists = !!pre.frame; out.frameReady = !!pre.ready; out.winReady = !!pre.winReady; }
    var f = document.querySelector('#qfFrame') || (pre && pre.frame) || null;
    if (f) { out.frameExists = true; try { if (f.contentDocument) out.frameReady = out.frameReady || true; } catch (e) {} }
    var sess = window.Sess || null;
    if (sess && sess.state) out.sessState = String(sess.state);
    var ds = null;
    try {
      ds = document.querySelector('#deskstatus');
      if (!ds && f && f.contentDocument) ds = f.contentDocument.querySelector('#deskstatus');
    } catch (e) {}
    if (ds) out.deskStatus = (ds.textContent || '').trim();
    var cv = null;
    try {
      cv = document.querySelector('#Desk');
      if (!cv && f && f.contentDocument) cv = f.contentDocument.querySelector('#Desk');
    } catch (e) {}
    if (cv) { var r = cv.getBoundingClientRect(); out.canvasW = Math.round(r.width || 0); out.canvasH = Math.round(r.height || 0); }
  } catch (e) {}
  return JSON.stringify(out);
})()''';

/// 探针回传的解析结果。
class SessionProbeReading {
  final bool frameExists;
  final bool frameReady;
  final bool winReady;
  final String sessState;
  final String deskStatus;
  final int canvasW;
  final int canvasH;

  /// 最近一拍 rAF 帧数（WebView 渲染帧率估算，见 kSessionStateJs）。
  final int fps;

  const SessionProbeReading({
    required this.frameExists,
    required this.frameReady,
    required this.winReady,
    required this.sessState,
    required this.deskStatus,
    required this.canvasW,
    required this.canvasH,
    this.fps = 0,
  });

  static SessionProbeReading? parse(String raw) {
    try {
      var s = raw;
      if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
        final decoded = jsonDecode(s);
        if (decoded is String) s = decoded;
      }
      final v = jsonDecode(s);
      if (v is! Map<String, dynamic>) return null;
      return SessionProbeReading(
        frameExists: v['frameExists'] == true,
        frameReady: v['frameReady'] == true,
        winReady: v['winReady'] == true,
        sessState: v['sessState'] is String ? v['sessState'] as String : '',
        deskStatus: v['deskStatus'] is String ? v['deskStatus'] as String : '',
        canvasW: v['canvasW'] is int ? v['canvasW'] as int : 0,
        canvasH: v['canvasH'] is int ? v['canvasH'] as int : 0,
        fps: v['fps'] is int ? v['fps'] as int : 0,
      );
    } catch (_) {
      return null;
    }
  }
}

/// 探针读数 → 阶段映射（兜底口径：handler 打点优先，本映射只在 handler
/// 未就绪时用；Sess.state 为 'connected' 或 #deskstatus Connected +
/// 有尺寸画布即算 video-ready）。
SessionStage mapSessionProbe(SessionProbeReading r) {
  final st = r.sessState.toLowerCase();
  if (st == 'connected' ||
      (r.deskStatus == 'Connected' && r.canvasW > 0 && r.canvasH > 0)) {
    return SessionStage.videoReady;
  }
  if (st == 'connecting' ||
      r.deskStatus == 'Connecting' ||
      r.deskStatus.contains('正在建立') ||
      r.deskStatus.contains('正在连接')) {
    return SessionStage.peerConnecting;
  }
  if (r.winReady || r.deskStatus.isNotEmpty) return SessionStage.peerConnecting;
  if (r.frameReady) return SessionStage.webappReady;
  if (r.frameExists) return SessionStage.iframeLoad;
  return SessionStage.iframeAttach;
}

/// 服务端预检响应（GET /api/device/presence?nodeid=<裸 nodeid>）。
class DevicePresence {
  final bool ok;
  final String code;
  final String nodeid;
  final String name;
  final bool online;
  final bool fresh;
  final DateTime? lastAgentPong;
  final int? lastAgentPongAgeMs;
  final DateTime? serverTime;

  const DevicePresence({
    required this.ok,
    required this.code,
    required this.nodeid,
    this.name = '',
    required this.online,
    required this.fresh,
    this.lastAgentPong,
    this.lastAgentPongAgeMs,
    this.serverTime,
  });

  static DevicePresence? parse(String body) {
    try {
      final root = jsonDecode(body);
      if (root is! Map<String, dynamic>) return null;
      DateTime? msToDate(Object? v) => v is int
          ? DateTime.fromMillisecondsSinceEpoch(v)
          : (v is String ? DateTime.tryParse(v) : null);
      final age = root['lastAgentPongAgeMs'];
      return DevicePresence(
        ok: root['ok'] == true,
        code: root['code'] is String ? root['code'] as String : 'UNKNOWN',
        nodeid: root['nodeid'] is String ? root['nodeid'] as String : '',
        name: root['name'] is String ? root['name'] as String : '',
        online: root['online'] == true,
        fresh: root['fresh'] == true,
        lastAgentPong: msToDate(root['lastAgentPong']),
        lastAgentPongAgeMs: age is int ? age : (age is num ? age.toInt() : null),
        serverTime: msToDate(root['serverTime']),
      );
    } catch (_) {
      return null;
    }
  }
}

/// 预检失败表现分级（A9）：四级，8 秒内出卡，不进「正在建立会话…」。
/// QF-07：authExpired＝服务端 401/403（登录已过期），与网络超时分开。
enum PreflightOutcome { ok, offlineStale, offlineConn, preflightTimeout, authExpired }

/// 预检分类（纯函数，可单测）：服务端 code 为 ONLINE/STALE/OFFLINE/
/// NOT_FOUND/TIMEOUT/UNKNOWN；STALE＝agent 心跳超 120 秒（即使 node.conn
/// 为真）；TIMEOUT/UNKNOWN＝接口本身没在 8 秒内给可信结论。
PreflightOutcome classifyPreflight(DevicePresence? p, {bool timedOut = false}) {
  if (timedOut) return PreflightOutcome.preflightTimeout;
  if (p == null) return PreflightOutcome.preflightTimeout;
  switch (p.code) {
    case 'ONLINE':
      return p.online && p.fresh
          ? PreflightOutcome.ok
          : PreflightOutcome.offlineStale;
    case 'STALE':
      return PreflightOutcome.offlineStale;
    case 'OFFLINE':
    case 'NOT_FOUND':
      return PreflightOutcome.offlineConn;
    case 'TIMEOUT':
    case 'UNKNOWN':
      return PreflightOutcome.preflightTimeout;
    default:
      return p.online && p.fresh
          ? PreflightOutcome.ok
          : PreflightOutcome.offlineStale;
  }
}

/// 预检失败卡片的标题/正文（A9 三级文案，调用方按 outcome 取）。
({String title, String body}) preflightCardText(
  PreflightOutcome outcome,
  DevicePresence? p,
) {
  String hhmm(DateTime? t) {
    if (t == null) return '未知';
    String two(int n) => n.toString().padLeft(2, '0');
    return '${two(t.hour)}:${two(t.minute)}:${two(t.second)}';
  }

  final name = (p?.name ?? '').isNotEmpty ? p!.name : '该设备';
  switch (outcome) {
    case PreflightOutcome.ok:
      return (title: '', body: '');
    case PreflightOutcome.offlineStale:
      final ageSec = p?.lastAgentPongAgeMs != null
          ? (p!.lastAgentPongAgeMs! ~/ 1000)
          : -1;
      return (
        title: '设备当前不在线',
        body: '$name 的被控端 agent 已超过 ${ageSec >= 0 ? '$ageSec 秒' : '120 秒'}'
            '没有心跳（最后心跳 ${hhmm(p?.lastAgentPong)}），'
            '可能服务假死或断网。',
      );
    case PreflightOutcome.offlineConn:
      return (
        title: '设备当前不在线',
        body: '$name 未连接到服务器，请确认被控端已开机且 Mesh Agent 正在运行。',
      );
    case PreflightOutcome.preflightTimeout:
      return (
        title: '无法确认设备状态',
        body: '服务器响应超时（8 秒内未确认 $name 的状态），请检查网络后重试。',
      );
    case PreflightOutcome.authExpired:
      return (
        title: '登录已过期',
        body: '会话已失效（服务端拒绝了当前登录），请重新登录后再打开 $name。',
      );
  }
}
