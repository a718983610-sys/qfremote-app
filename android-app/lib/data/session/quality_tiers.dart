/// RC-09 画质安卓端（Remmina 四档位掩码＋FreeRDP `freerdp_performance_flags`
/// 模式）：档位只是一组编码参数的组合，存在配置里，用户可改每档参数，
/// 不要写死枚举；底层只认标志位。
///
/// 四档：流畅 / 均衡 / 清晰 / 原画。每档＝分辨率缩放、帧率上限、编码器、
/// 码率的组合。
/// - 客户端持续测 RTT/丢包，连续 2 次探测变差自动降一档并 Toast 提示，
///   网络恢复后**不自动升档**（须用户手动升）。
/// - 服务端发现客户端消费跟不上（帧堆积）时主动降质、不发新帧：客户端
///   收到背压信号后同样降一档（[onBackpressure]）。
///
/// 编码参数的服务端协商格式待 L5 规范（RC-09 设计确认）到达后定：本文件
/// 只实现客户端档位模型与自降档状态机，不发明线格式，
/// 见 `docs/RC-ANDROID-NOTES.md`。
enum QualityTier { smooth, balanced, clear, original }

/// 一档的编码参数组合（用户可改每档参数，存在配置里）。
class QualityProfile {
  /// 分辨率缩放（1.0＝原画）。
  final double resolutionScale;

  /// 帧率上限。
  final int maxFps;

  /// 编码器名（如 `h264`；服务端协商后为准）。
  final String encoder;

  /// 码率上限（kbps）。
  final int maxBitrateKbps;

  const QualityProfile({
    required this.resolutionScale,
    required this.maxFps,
    required this.encoder,
    required this.maxBitrateKbps,
  });

  /// 底层标志位组合（FreeRDP `performance_flags_make` 模式：档位只是
  /// 标志位的组合，底层只认标志位）。
  int get flags =>
      ((resolutionScale * 100).round() & 0xFF) |
      ((maxFps & 0xFF) << 8) |
      ((maxBitrateKbps ~/ 100 & 0xFFFF) << 16);
}

/// 四档默认参数（客户端默认值，用户可在设置里改每档）。
const Map<QualityTier, QualityProfile> defaultQualityProfiles = {
  QualityTier.smooth: QualityProfile(
      resolutionScale: 0.5, maxFps: 15, encoder: 'h264',
      maxBitrateKbps: 800),
  QualityTier.balanced: QualityProfile(
      resolutionScale: 0.75, maxFps: 24, encoder: 'h264',
      maxBitrateKbps: 2000),
  QualityTier.clear: QualityProfile(
      resolutionScale: 1.0, maxFps: 30, encoder: 'h264',
      maxBitrateKbps: 5000),
  QualityTier.original: QualityProfile(
      resolutionScale: 1.0, maxFps: 60, encoder: 'h264',
      maxBitrateKbps: 12000),
};

/// 一次网络探测结果（RTT＋丢包率）。
class NetworkProbe {
  final int rttMs;
  final double lossPercent;

  const NetworkProbe({required this.rttMs, required this.lossPercent});

  /// 变差判定（弱网阈值：300ms 延迟＋5% 丢包，见 RC-09 验收场景）。
  bool get degraded => rttMs >= 300 || lossPercent >= 5;
}

/// 画质状态机（纯逻辑，可单测）。
class QualityController {
  QualityController({QualityTier initial = QualityTier.balanced})
      : _tier = initial;

  QualityTier _tier;
  int _badStreak = 0;

  QualityTier get tier => _tier;
  QualityProfile get profile => defaultQualityProfiles[_tier]!;

  /// 用户手动切档：即时生效，无需重连。
  void setTier(QualityTier tier) {
    _tier = tier;
    _badStreak = 0;
  }

  /// 上报一次探测：连续 2 次变差自动降一档（返回 true 表示降档了）。
  /// 网络恢复后不自动升档。
  bool reportProbe(NetworkProbe probe) {
    if (probe.degraded) {
      _badStreak++;
      if (_badStreak >= 2 && _tier.index > 0) {
        _tier = QualityTier.values[_tier.index - 1];
        _badStreak = 0;
        return true;
      }
      return false;
    }
    _badStreak = 0;
    return false;
  }

  /// 服务端背压信号：客户端消费跟不上（帧堆积）时主动降一档、不发新帧。
  /// 返回 true 表示降档了；已在最低档时返回 false（只停发新帧，由调用方处理）。
  bool onBackpressure() {
    if (_tier.index > 0) {
      _tier = QualityTier.values[_tier.index - 1];
      _badStreak = 0;
      return true;
    }
    return false;
  }
}
