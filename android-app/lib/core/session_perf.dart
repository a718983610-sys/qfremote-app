/// 会话性能 HUD（2.4.5 返修 A8）——纯逻辑，可单测。
///
/// 口径（写死在这里，界面只照抄，不许另编数字）：
/// - 帧率：WebView 顶层文档 requestAnimationFrame 采样得到的渲染帧数/秒
///   （kSessionStateJs 里的 `fps` 字段，每拍回传自上拍以来的 rAF 计数）。
///   它量的是壳内 WebView 的合成渲染帧率，不是 MeshCentral 中继的远端
///   出帧率——两者不等，诊断里必须写清是「WebView 渲染估算」。
/// - RTT：Dart 侧一次会话探针求值（evaluateJavascript）的往返耗时，
///   即 Dart→页面求值一来一回的毫秒数，不是中继 RTT。
/// - 输入→回显延迟：壳内没有任何输入打点钩子，**未测量**——HUD 与诊断
///   一律写「未测量」，绝不编一个数字冒充。
/// - 档位：normal（探针 1 秒一拍）/ low（探针 2 秒一拍＋向会话透传
///   `quality=low`）。网页端 app.js 当前**没有** quality 参数处理
///   （全仓 grep `quality` 零命中），Dart 侧透传方式是会话建立时在
///   顶层页面置 `window.__qfSessionQuality = 'low'`，参数名与网页端
///   约定的 `quality=low` 同名，待网页侧接线后生效；low 档当前真正
///   生效的只有 Dart 侧降采样，不谎称网页已降画质。
enum SessionQuality { normal, low }

/// quality 参数名（与网页端约定同名；见上，网页侧待接线）。
const String kSessionQualityParam = 'quality';

/// quality=low 时的取值（拼进会话透传，与网页端约定同值）。
const String kSessionQualityLowValue = 'low';

/// 性能采样器：只记数、不碰 WebView，可单测。
class SessionPerfTracker {
  SessionQuality quality = SessionQuality.normal;

  /// 最近一拍探针往返耗时（毫秒），未采到为 null。
  int? lastProbeRttMs;

  /// 最近一拍 rAF 帧数（约等于该秒渲染帧率），未采到为 null。
  int? lastFps;

  /// 输入→回显延迟：壳内无打点钩子，恒为 null＝未测量。
  int? get echoLatencyMs => null;

  /// 探针采样间隔（秒）：normal 1 秒，low 2 秒（降质降采样）。
  int get probeIntervalSec => quality == SessionQuality.low ? 2 : 1;

  /// 记一拍探针结果（rtt 毫秒、fps 帧数；任一为 null 表示本拍未采到）。
  void recordProbe({int? rttMs, int? fps}) {
    if (rttMs != null && rttMs >= 0) lastProbeRttMs = rttMs;
    if (fps != null && fps >= 0) lastFps = fps;
  }

  void reset() {
    lastProbeRttMs = null;
    lastFps = null;
  }

  /// HUD 一行文案（测不到的项写「未测量」，不编数字；标签按审计 F-002
  /// 第一阶段改名：FPS→WebView 渲染估算、RTT→页面探针耗时、回显延迟→未测量；
  /// 档位标签按 A 线核查补改：low 档实际只降探针采样、不降远端画质，故 HUD
  /// 与切换按钮一律写「采样」不写「画质」）。
  String hudText() {
    final fps = lastFps == null ? '未测量' : '$lastFps fps';
    final rtt = lastProbeRttMs == null ? '未测量' : '$lastProbeRttMs ms';
    final q = quality == SessionQuality.low ? '降采样' : '标准采样';
    return 'WebView 渲染估算：$fps · 页面探针耗时：$rtt · '
        '输入→回显延迟：未测量 · 探针采样：$q';
  }

  /// 诊断追加行（与 hudText 同口径）。
  String diagnosticsLine() => '会话性能：${hudText()}';
}
