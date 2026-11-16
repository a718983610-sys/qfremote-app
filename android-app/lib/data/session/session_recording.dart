/// RC-10 录像安卓端（Guacamole 指令流录像＋MeshCentral 三级粒度开关模式）：
/// 录像做成指令/事件流，三级粒度开关，默认不录。
///
/// - 录像文件存“画面指令＋鼠标/按键/剪贴板事件”，体积比视频小一个量级，
///   天然支持 seek、变速、按键审计；需要 mp4 时离线转码（不在 3.0.0 做）。
/// - 开关是服务端可下发的策略位：默认不录，须双方知情或站长明确授权才开。
/// - 录像含按键与剪贴板即含敏感信息，存储与查看权限必须与 QFRemote 现有
///   “站长也看不见他人屏幕”的口径对齐：未授权的账号打不开他人录像。
///
/// 录制事件的线格式、服务端存储端点、回放器协议待 L5 规范到达后定：
/// 本文件只实现客户端录制状态机、粒度策略与事件流模型，不发明线格式，
/// 见 `docs/RC-ANDROID-NOTES.md`。
enum RecordingGranularity {
  /// 不录（默认）。
  off,

  /// 只对选定用户录制。
  user,

  /// 对选定用户组录制。
  userGroup,

  /// 对选定设备组录制。
  deviceGroup,
}

/// 录制事件（指令/事件流的一条记录，不是视频帧）。
enum RecordingEventKind {
  /// 画面指令（脏矩形/帧标记等）。
  frame,

  /// 鼠标事件。
  mouse,

  /// 按键事件。
  key,

  /// 剪贴板事件（只记“发生了同步”，不记剪贴板内容）。
  clipboard,
}

class RecordingEvent {
  final RecordingEventKind kind;
  final int timestampMs;
  final String payloadRef;

  const RecordingEvent({
    required this.kind,
    required this.timestampMs,
    required this.payloadRef,
  });

  Map<String, Object?> toJson() => {
    'kind': kind.name,
    't': timestampMs,
    'ref': payloadRef,
  };
}

/// 录制会话（客户端状态机，纯逻辑）。
class RecordingSession {
  RecordingSession({required this.granularity});

  /// 服务端下发的策略位；默认不录。
  RecordingGranularity granularity;

  bool _recording = false;
  final List<RecordingEvent> _events = [];
  static const int maxBufferedEvents = 10000;
  bool capacityExceeded = false;

  bool get isRecording => _recording;
  int get eventCount => _events.length;
  List<RecordingEvent> get events => List.unmodifiable(_events);

  /// 开始录制：只有策略位不是 off 且调用方已获授权时才允许。
  /// 未授权（[authorized] 为 false）时拒绝开始并返回 false。
  bool start({required bool authorized}) {
    if (granularity == RecordingGranularity.off) return false;
    if (!authorized) return false;
    _recording = true;
    return true;
  }

  void stop() => _recording = false;

  /// 记录一条事件：未在录制时丢弃（不攒）。
  void record(RecordingEvent event) {
    if (!_recording) return;
    if (_events.isNotEmpty && event.timestampMs < _events.last.timestampMs)
      return;
    if (_events.length >= maxBufferedEvents) {
      capacityExceeded = true;
      _recording = false;
      return;
    }
    _events.add(event);
  }

  /// 回放支持 seek：按时间戳取事件子集（变速＝按倍率取时间窗口，由回放器做）。
  List<RecordingEvent> eventsBetween(int fromMs, int toMs) => _events
      .where((e) => e.timestampMs >= fromMs && e.timestampMs <= toMs)
      .toList();

  /// 体积估算：事件流按每条约 64 字节计（10 分钟会话约数千条事件，
  /// 比同等视频小一个量级，见 RC-10 验收）。
  int get estimatedBytes => _events.length * 64;
}
