import 'dart:math' as math;

/// RC-08 文件传输安卓端（Guacamole 统一流抽象＋blob 分片模式）：
/// 先定跨端流接口（进度回调、取消、断网重连行为一致），再让各端去实现；
/// 每次文件传输记一条审计（类型/路径/大小/对端，只记元数据，不记文件内容）。
///
/// 分片与审计的线格式、服务端端点待 L5 协议规范到达后定：本文件只实现
/// 客户端分片数学、进度、取消、断点续传偏移与审计元数据模型，不发明线格式，
/// 见 `docs/RC-ANDROID-NOTES.md`。
enum TransferDirection { upload, download }

enum TransferState { pending, running, paused, cancelled, failed, done }

/// 统一流抽象：进度回调、取消、断网重连行为三端一致的最小接口。
abstract class QfTransferStream {
  TransferState get state;
  int get transferredBytes;
  int get totalBytes;
  double get progress => totalBytes <= 0 ? 0 : transferredBytes / totalBytes;

  /// 取消：已传分片保留偏移，供断点续传用。
  Future<void> cancel();

  /// 暂停：不断连接，只停发分片。
  void pause();

  void resume();
}

/// 分片器：把一次传输切成定长分片（纯逻辑，可单测）。
class Chunker {
  /// 默认分片 64 KiB（Guacamole 的 blob 上限 6048 字节是其协议常量，
  /// QFRemote 取 64 KiB 是客户端实现选择，服务端分片上限以 L5 规范为准）。
  static const int defaultChunkSize = 64 * 1024;

  final int totalBytes;
  final int chunkSize;

  const Chunker(this.totalBytes, {this.chunkSize = defaultChunkSize})
    : assert(totalBytes >= 0),
      assert(chunkSize > 0);

  int get chunkCount =>
      totalBytes <= 0 ? 0 : (totalBytes + chunkSize - 1) ~/ chunkSize;

  /// 第 [index] 片的字节范围（左闭右开）。
  (int, int) chunkRange(int index) {
    if (index < 0 || index >= chunkCount) {
      throw RangeError.range(index, 0, chunkCount - 1, 'index');
    }
    final start = index * chunkSize;
    final end = math.min(start + chunkSize, totalBytes);
    return (start, end);
  }

  /// 断点续传：已传 [transferredBytes] 时下一片序号。
  int nextChunkIndex(int transferredBytes) =>
      (transferredBytes / chunkSize).floor().clamp(0, chunkCount);
}

/// 一次传输的审计元数据（只记元数据，不记文件内容，与“站长也看不见他人
/// 屏幕/文件内容”口径一致；服务端落一条审计记录，见 RC-08 验收）。
class TransferAudit {
  final TransferDirection direction;
  final String path;
  final int sizeBytes;
  final String peerName;
  final DateTime at;
  final TransferState outcome;

  const TransferAudit({
    required this.direction,
    required this.path,
    required this.sizeBytes,
    required this.peerName,
    required this.at,
    required this.outcome,
  });

  Map<String, Object?> toJson() => {
    'direction': direction.name,
    'path': path,
    'sizeBytes': sizeBytes,
    'peer': peerName,
    'at': at.toIso8601String(),
    'outcome': outcome.name,
  };
}

/// 传输会话（客户端状态机，纯逻辑）：进度、取消、断点续传偏移。
class FileTransferSession extends QfTransferStream {
  FileTransferSession({
    required this.direction,
    required this.path,
    required this.totalBytes,
    required this.peerName,
    int chunkSize = Chunker.defaultChunkSize,
  }) : _chunker = Chunker(totalBytes, chunkSize: chunkSize);

  final TransferDirection direction;
  final String path;
  final String peerName;
  final Chunker _chunker;

  @override
  TransferState state = TransferState.pending;

  @override
  int transferredBytes = 0;

  @override
  final int totalBytes;

  int get chunksTotal => _chunker.chunkCount;
  int get nextChunk => _chunker.nextChunkIndex(transferredBytes);

  void start() {
    if (state == TransferState.pending) state = TransferState.running;
  }

  /// 确认一片已传（服务端回执后调）：推进偏移，传完即 done。
  void ackChunk(int bytes) {
    if (state != TransferState.running || bytes <= 0) return;
    transferredBytes = math.min(transferredBytes + bytes, totalBytes);
    if (transferredBytes >= totalBytes) state = TransferState.done;
  }

  void fail() {
    if (state == TransferState.running) state = TransferState.failed;
  }

  @override
  Future<void> cancel() async {
    if (state == TransferState.running || state == TransferState.paused) {
      state = TransferState.cancelled;
    }
  }

  @override
  void pause() {
    if (state == TransferState.running) state = TransferState.paused;
  }

  @override
  void resume() {
    if (state == TransferState.paused) state = TransferState.running;
  }

  TransferAudit audit() => TransferAudit(
    direction: direction,
    path: path,
    sizeBytes: totalBytes,
    peerName: peerName,
    at: DateTime.now(),
    outcome: state,
  );
}
