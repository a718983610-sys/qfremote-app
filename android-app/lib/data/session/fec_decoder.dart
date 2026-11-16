import 'dart:typed_data';

/// RC-03 解码端 FEC 还原（QF-VIDEO-1 规范 v1，§1）。
///
/// 与服务端 `server/ext/fec-ref.js` 逐字节一致的 Reed-Solomon 参考实现：
/// GF(256)，本原多项式 0x11d，生成元 2；校验行 Vandermonde，校验行 j
/// 对数据分片 i 的系数为 `(j+1)^i`。
///
/// 只定两档，不得自创第三档（§1.1）：
/// - 高保护 k=10/m=2（开销 20%，任意 2 丢可恢复），默认档；
/// - 低保护 k=20/m=1（开销 5%，任意 1 丢可恢复），低码率档。
///
/// 未定项（§1.3 末尾，§4.2）：块头无线上传输的二进制打包格式未定义，
/// 本文件只实现逻辑块头＋分片还原，**不发明打包格式**；线上传输格式
/// 待 agent 线定版补进规范 v2。性能敏感处走原生是规范对各端的要求，
/// 本文件是纯 Dart 参考实现（与 fec-ref.js 对拍用），大帧解码上生产
/// 路径前须由原生层接管——见报告缺口。
class FecProfile {
  const FecProfile(this.k, this.m);

  /// 高保护档。
  static const FecProfile high = FecProfile(10, 2);

  /// 低保护档。
  static const FecProfile low = FecProfile(20, 1);

  final int k;
  final int m;

  /// 开销 m/k（`repairPercent`），与 fec-ref.js 注释口径一致。
  double get repairPercent => m / k;

  int get symbolCount => k + m;

  bool get isSupported =>
      (k == 10 && m == 2) || (k == 20 && m == 1);

  @override
  bool operator ==(Object other) =>
      other is FecProfile && other.k == k && other.m == m;

  @override
  int get hashCode => Object.hash(k, m);

  @override
  String toString() => 'FecProfile(k=$k, m=$m)';
}

/// QF-QUALITY-1 §6.1 跨协议待定项：档位表里的 fecRepairPercent
/// 10% / 15% 在 FEC 层没有对应档位。映射规则（不得自行发明第三种
/// (k, m) 组合）：
/// - ≤5% → k=20/m=1；≥20% → k=10/m=2；
/// - 中间值（10%/15%，即 balanced / clear 档）→ 返回 null，映射待定，
///   待 agent 线确认后修订。调用方收到 null 时不得猜一个档位，
///   须保持当前 FEC 档位并记一条诊断日志。
FecProfile? fecProfileForRepairPercent(num percent) {
  if (percent <= 5) return FecProfile.low;
  if (percent >= 20) return FecProfile.high;
  return null; // 中间值映射待定（QF-QUALITY-1 §6.1）
}

/// GF(256) 查表（与 fec-ref.js `buildTables` 同款）。
class _Gf256 {
  static final List<int> exp = List<int>.filled(512, 0);
  static final List<int> log = List<int>.filled(256, 0);
  static bool _built = false;

  static void _build() {
    if (_built) return;
    var x = 1;
    for (var i = 0; i < 255; i++) {
      exp[i] = x;
      log[x] = i;
      x <<= 1;
      if ((x & 0x100) != 0) x ^= 0x11d;
    }
    for (var i = 255; i < 512; i++) {
      exp[i] = exp[i - 255];
    }
    _built = true;
  }

  static int mul(int a, int b) {
    _build();
    if (a == 0 || b == 0) return 0;
    return exp[log[a] + log[b]];
  }

  static int inv(int a) {
    _build();
    if (a == 0) throw const FormatException('gf-inv-zero');
    return exp[255 - log[a]];
  }

  static int pow(int a, int e) {
    _build();
    if (e == 0) return 1;
    if (a == 0) return 0;
    return exp[(log[a] * e) % 255];
  }

  /// 校验行 j 对数据分片 i 的系数：`(j+1)^i`。
  static int parityCoef(int j, int i) => pow(j + 1, i);
}

/// GF(256) 方阵求逆（高斯-约当消元）；奇异返回 null（与 fec-ref.js 同款）。
List<List<int>>? gfInvertMatrix(List<List<int>> mat) {
  final n = mat.length;
  final a = List<List<int>>.generate(
    n,
    (i) => [
      ...mat[i],
      ...List<int>.generate(n, (j) => i == j ? 1 : 0),
    ],
  );
  for (var col = 0; col < n; col++) {
    var pivot = -1;
    for (var r = col; r < n; r++) {
      if (a[r][col] != 0) {
        pivot = r;
        break;
      }
    }
    if (pivot == -1) return null;
    if (pivot != col) {
      final tmp = a[pivot];
      a[pivot] = a[col];
      a[col] = tmp;
    }
    final invPivot = _Gf256.inv(a[col][col]);
    for (var j = 0; j < 2 * n; j++) {
      a[col][j] = _Gf256.mul(a[col][j], invPivot);
    }
    for (var r = 0; r < n; r++) {
      if (r == col || a[r][col] == 0) continue;
      final factor = a[r][col];
      for (var j = 0; j < 2 * n; j++) {
        a[r][j] ^= _Gf256.mul(factor, a[col][j]);
      }
    }
  }
  return a.map((row) => row.sublist(n)).toList();
}

/// 块头（QF-VIDEO-1 §1.3，12 个逻辑字段）。
class FecBlockHeader {
  const FecBlockHeader({
    required this.blockId,
    required this.frameId,
    required this.isKeyframe,
    required this.frameStart,
    required this.frameEnd,
    required this.symbolIndex,
    required this.symbolCount,
    required this.symbolLength,
    required this.lastSymbolPadding,
    required this.k,
    required this.m,
  });

  static const int fecVersion = 1;

  final int blockId;
  final int frameId;
  final bool isKeyframe;
  final bool frameStart;
  final bool frameEnd;
  final int symbolIndex;
  final int symbolCount;
  final int symbolLength;
  final int lastSymbolPadding;
  final int k;
  final int m;

  FecProfile get profile => FecProfile(k, m);

  /// 校验规则（与服务端 `validateBlockHeader` 一字一致）：
  /// fecVersion≠1、m∉{1,2}、k∉{10,20}、symbolCount≠k+m、
  /// symbolIndex≥symbolCount、symbolLength≤0、
  /// lastSymbolPadding<0 或 ≥symbolLength，任一成立即非法。
  ///
  /// 注意（§4.1）：服务端校验接受 k=10/m=1 与 k=20/m=2 的组合，
  /// 但协议只定义 k=10/m=2 与 k=20/m=1 两档；本校验只判服务端
  /// 口径的合法性，档位是否受支持另由 [isSupportedProfile] 判定，
  /// 解码器对不受支持的档位拒绝解码（不得利用校验宽松发其他组合）。
  bool get isValid {
    if (m != 1 && m != 2) return false;
    if (k != 10 && k != 20) return false;
    if (symbolCount != k + m) return false;
    if (symbolIndex >= symbolCount) return false;
    if (symbolLength <= 0) return false;
    if (lastSymbolPadding < 0 || lastSymbolPadding >= symbolLength) {
      return false;
    }
    return true;
  }

  /// 是否为协议定义的两档之一。
  bool get isSupportedProfile => profile.isSupported;

  /// 各数据分片的真实长度：前 k-1 片满长，尾片按 padding 裁剪。
  List<int> get dataLengths {
    final lengths = List<int>.filled(k, symbolLength);
    lengths[k - 1] = symbolLength - lastSymbolPadding;
    return lengths;
  }

  Map<String, Object?> toJson() => {
        'fecVersion': fecVersion,
        'blockId': blockId,
        'frameId': frameId,
        'isKeyframe': isKeyframe,
        'frameStart': frameStart,
        'frameEnd': frameEnd,
        'symbolIndex': symbolIndex,
        'symbolCount': symbolCount,
        'symbolLength': symbolLength,
        'lastSymbolPadding': lastSymbolPadding,
        'k': k,
        'm': m,
      };
}

/// RS 编码（与 fec-ref.js `encodeShards` 同款）：数据分片零填充到
/// 等长后按 Vandermonde 校验行生成 m 个校验分片。
/// 返回 (dataShards, parityShards, shardLen)；分片均为等长。
({List<Uint8List> data, List<Uint8List> parity, int shardLen})
    fecEncodeShards(List<Uint8List> dataBuffers, FecProfile profile) {
  final k = profile.k;
  final m = profile.m;
  if (dataBuffers.length != k) {
    throw const FormatException('fec-k-mismatch');
  }
  var shardLen = 1;
  for (final b in dataBuffers) {
    if (b.length > shardLen) shardLen = b.length;
  }
  final data = <Uint8List>[];
  for (final b in dataBuffers) {
    if (b.length == shardLen) {
      data.add(Uint8List.fromList(b));
    } else {
      final p = Uint8List(shardLen);
      p.setRange(0, b.length, b);
      data.add(p);
    }
  }
  final parity = <Uint8List>[];
  for (var j = 0; j < m; j++) {
    final p = Uint8List(shardLen);
    for (var i = 0; i < k; i++) {
      final c = _Gf256.parityCoef(j, i);
      if (c == 0) continue;
      final d = data[i];
      if (c == 1) {
        for (var b = 0; b < shardLen; b++) {
          p[b] ^= d[b];
        }
      } else {
        for (var b = 0; b < shardLen; b++) {
          p[b] ^= _Gf256.mul(c, d[b]);
        }
      }
    }
    parity.add(p);
  }
  return (data: data, parity: parity, shardLen: shardLen);
}

/// RS erasure 解码（与 fec-ref.js `decodeShards` 同款）。
///
/// [shards] 长度须为 k+m，丢失的分片传 null（位置已知，靠块头
/// `symbolIndex` 缺口判定）；[lengths] 为 k 个数据分片的真实长度
/// （尾片按 `lastSymbolPadding` 裁剪后）。
/// 返回恢复后的 k 个数据分片（已按真实长度裁剪）；不可恢复返回 null：
/// 丢失数 > m，或可用校验行不足，或系数矩阵奇异。不得强行拼帧。
List<Uint8List>? fecDecodeShards(
  List<Uint8List?> shards,
  FecProfile profile,
  List<int> lengths,
) {
  final k = profile.k;
  final m = profile.m;
  if (shards.length != k + m) return null;
  final missing = <int>[];
  for (var i = 0; i < k; i++) {
    if (shards[i] == null) missing.add(i);
  }
  if (missing.isEmpty) {
    return List<Uint8List>.generate(
      k,
      (i) => Uint8List.fromList(shards[i]!.sublist(0, lengths[i])),
    );
  }
  if (missing.length > m) return null;
  final availParity = <int>[];
  for (var j = 0; j < m; j++) {
    if (shards[k + j] != null) availParity.add(j);
  }
  if (availParity.length < missing.length) return null;
  final t = missing.length;
  final first = shards.firstWhere((s) => s != null, orElse: () => null);
  if (first == null) return null;
  final shardLen = first.length;
  final rows = availParity.sublist(0, t);
  final mat =
      rows.map((j) => missing.map((i) => _Gf256.parityCoef(j, i)).toList()).toList();
  final inv = gfInvertMatrix(mat);
  if (inv == null) return null;
  final out = List<Uint8List>.generate(t, (_) => Uint8List(shardLen));
  for (var b = 0; b < shardLen; b++) {
    final rhs = rows.map((j) {
      var v = shards[k + j]![b];
      for (var i = 0; i < k; i++) {
        if (missing.contains(i)) continue;
        final c = _Gf256.parityCoef(j, i);
        if (c != 0) v ^= _Gf256.mul(c, shards[i]![b]);
      }
      return v;
    }).toList();
    for (var r = 0; r < t; r++) {
      var v = 0;
      for (var c = 0; c < t; c++) {
        v ^= _Gf256.mul(inv[r][c], rhs[c]);
      }
      out[r][b] = v;
    }
  }
  final result = List<Uint8List?>.generate(
    k,
    (i) => shards[i] == null ? null : Uint8List.fromList(shards[i]!),
  );
  for (var r = 0; r < missing.length; r++) {
    result[missing[r]] = out[r];
  }
  return List<Uint8List>.generate(
    k,
    (i) => Uint8List.fromList(result[i]!.sublist(0, lengths[i])),
  );
}

/// 交织深度下限（§1.4）：`G ≥ ceil(burstLen / m)`；m=2 时突发 5 须
/// G≥3、突发 10 须 G≥5。G 本身不进块头，由收发双方按档位约定，
/// 约定值待 agent 线定版后补进规范——本函数只算下限，不定约定值。
int requiredInterleaveDepth(int burstLen, int m) {
  if (burstLen <= 0 || m <= 0) return 1;
  return (burstLen + m - 1) ~/ m;
}

/// 收包归位结果。
enum FecBlockOutcome {
  /// 块头非法，整块已丢弃，不得尝试解码。
  invalidHeader,

  /// 分片已收下，块未齐（等更多分片或等超时窗口）。
  incomplete,

  /// 0 缺失，直接可渲染。
  complete,

  /// 1–m 缺失，RS 还原成功，帧完整可渲染。
  recovered,

  /// 缺失 > m 或校验行不足，不可恢复（等超时窗口届满再触发 IDR，
  /// 不一丢即请求——见 [FecBlockCollector.checkUnrecoverable]）。
  unrecoverable,
}

/// 解码端收包与归位（QF-VIDEO-1 §3 第 1–4 条）：按 blockId /
///
/// symbolIndex 归位；块头非法即整块丢弃；丢包靠 symbolIndex 缺口判定；
/// 还原后按 lastSymbolPadding 裁剪尾分片；还原出的帧须完整才渲染，
/// 半帧不得上屏。
///
/// 超时窗口（§3 第 3 条）：判定窗口为 `RTT + jitter + 1 帧时长`
/// （30fps 下 1 帧约 33ms）；窗口内等迟到分片，窗口届满仍不可恢复，
/// 才丢弃受影响帧并触发一次受控 IDR（reason=loss）。本类只做判定，
/// 不直接发 IDR（IDR 发送见 `idr_client.dart`）。
class FecBlockCollector {
  FecBlockCollector({required this.profile});

  final FecProfile profile;

  final Map<int, _PendingBlock> _blocks = {};

  /// 已解码完成的块 id：迟到的冗余分片（解码后才到的校验片）直接
  /// 忽略，不得重开一个待解块（否则每块都会在尾片到达时误判为
  /// unrecoverable）。
  final Set<int> _completedBlockIds = {};

  /// 收到一个分片。返回归位结果；[receivedAtMs] 为收到时刻
  /// （毫秒 epoch，供超时窗口用）。
  /// [shard] 为该分片的字节；非法块头或不受支持的档位时整块丢弃
  /// 并返回 [FecBlockOutcome.invalidHeader]。
  (FecBlockOutcome, List<Uint8List>?) addShard(
    FecBlockHeader header,
    Uint8List shard, {
    required int receivedAtMs,
  }) {
    if (!header.isValid || !header.isSupportedProfile) {
      _blocks.remove(header.blockId);
      return (FecBlockOutcome.invalidHeader, null);
    }
    if (_completedBlockIds.contains(header.blockId)) {
      // 已解码完成的块的迟到冗余分片：忽略，不重开待解块。
      return (FecBlockOutcome.complete, null);
    }
    if (header.k != profile.k || header.m != profile.m) {
      // 档位切换只在关键帧/块边界生效（§1.2）；跨档位的分片
      // 不混进当前块，整块丢弃，调用方按新档位重建 collector。
      _blocks.remove(header.blockId);
      return (FecBlockOutcome.invalidHeader, null);
    }
    final pending = _blocks.putIfAbsent(
      header.blockId,
      () => _PendingBlock(
        header: header,
        firstSeenMs: receivedAtMs,
      ),
    );
    pending.shards[header.symbolIndex] = shard;
    return _tryDecode(pending);
  }

  (FecBlockOutcome, List<Uint8List>?) _tryDecode(_PendingBlock pending) {
    final header = pending.header;
    final shards = List<Uint8List?>.generate(
      profile.symbolCount,
      (i) => pending.shards[i],
    );
    final missingData =
        shards.sublist(0, profile.k).where((s) => s == null).length;
    if (missingData == 0) {
      _blocks.remove(header.blockId);
      _completedBlockIds.add(header.blockId);
      return (
        FecBlockOutcome.complete,
        fecDecodeShards(shards, profile, header.dataLengths),
      );
    }
    if (missingData > profile.m) {
      // 超过恢复能力：先不判死刑，等超时窗口（迟到分片可能还在路上）。
      return (FecBlockOutcome.unrecoverable, null);
    }
    final decoded =
        fecDecodeShards(shards, profile, header.dataLengths);
    if (decoded == null) {
      return (FecBlockOutcome.unrecoverable, null);
    }
    _blocks.remove(header.blockId);
    _completedBlockIds.add(header.blockId);
    return (FecBlockOutcome.recovered, decoded);
  }

  /// 超时窗口届满仍不可恢复的块（§3 第 3 条）。
  /// [nowMs] 当前时刻；窗口 = rttMs + jitterMs + frameMs。
  /// 返回的 blockId 列表：调用方丢弃受影响帧并对每帧触发一次
  /// 受控 IDR（reason=loss，进 IDR 限流），随后调 [dropBlock] 清理。
  List<int> checkUnrecoverable({
    required int nowMs,
    required int rttMs,
    required int jitterMs,
    required int frameMs,
  }) {
    final windowMs = rttMs + jitterMs + frameMs;
    final out = <int>[];
    for (final entry in _blocks.entries) {
      final pending = entry.value;
      if (nowMs - pending.firstSeenMs < windowMs) continue;
      final shards = List<Uint8List?>.generate(
        profile.symbolCount,
        (i) => pending.shards[i],
      );
      final missingData =
          shards.sublist(0, profile.k).where((s) => s == null).length;
      if (missingData == 0) continue;
      if (fecDecodeShards(shards, profile, pending.header.dataLengths) ==
          null) {
        out.add(entry.key);
      } else {
        // 窗口内迟到分片已补齐可解：直接清掉（下次 addShard 会重建）。
        // 这里不返回，调用方无需 IDR。
      }
    }
    return out;
  }

  /// 关键帧到达后（§3 第 7 条）：清旧参考帧，用新关键帧重建解码状态；
  /// 此前的不可恢复帧不再补请求——调用方丢弃早于该关键帧的待解块。
  void dropBlocksBefore(int blockId) {
    _blocks.removeWhere((id, _) => id < blockId);
    _completedBlockIds.removeWhere((id) => id < blockId);
  }

  void dropBlock(int blockId) {
    _blocks.remove(blockId);
    _completedBlockIds.remove(blockId);
  }

  int get pendingBlockCount => _blocks.length;
}

class _PendingBlock {
  _PendingBlock({required this.header, required this.firstSeenMs});

  final FecBlockHeader header;
  final int firstSeenMs;
  final Map<int, Uint8List> shards = {};
}
