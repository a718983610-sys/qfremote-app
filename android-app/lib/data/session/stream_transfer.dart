import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';

import '../../core/constants.dart';
import '../../services/points.dart' show ConsoleCookieProvider;
import '../../services/probe.dart' show trustedHttpClient;

/// RC-08 文件传输（QF-STREAM-1 规范 v1）。
///
/// 新客户端一律走分片流（init → chunk → commit → staged；断网后
/// missing 查缺片补传；对端 inbox → download(Range) → ack）。
/// 旧整文件 base64 端点 `POST /license/api/files/send` 保留兼容，
/// 新客户端不用。
///
/// 关键口径（以实现为准，§5）：
/// 1. 没有字面 `/resume` 端点，断点续传＝`GET …/missing`；
/// 2. commit 失败（CORRUPT/IO）后传输即作废，不可“修好再 commit”；
///    INCOMPLETE 是唯一可继续的状态；
/// 3. chunk 请求体走 BODY_LIMIT_FILE（288MB），单分片 base64 约为
///    分片字节的 4/3 倍；不得把整文件 base64 一次性塞进 chunk 请求；
/// 4. cancel 只能取消上传中传输；已暂存（staged）的发送没有取消端点；
/// 5. 审计的 `chunks` 字段是 totalChunks（总数），不是已收分片数。
///
/// 本文件与既有 `file_transfer.dart` 的关系：旧文件是 L5 规范到达前
/// 的客户端分片数学（默认 64 KiB Guacamole 口径）与本地状态机，
/// 保持不动（其测试仍以 64 KiB 为准）；本文件是按 QF-STREAM-1 的
/// 协议客户端（默认 1MB、服务端返回的 chunkSize 为准），两者
/// 不得混用 chunkSize。
class StreamTransferConstants {
  /// 默认分片 1MB（1048576）。
  static const int defaultChunkSize = 1024 * 1024;

  /// 服务端钳制范围 64KB～4MB。
  static const int minChunkSize = 64 * 1024;
  static const int maxChunkSize = 4 * 1024 * 1024;

  /// 单文件上限默认 200MB（`config.json` 的 `fileSendMaxMb` 可改）。
  static const int defaultMaxBytes = 200 * 1024 * 1024;

  /// 暂存默认 24h（`config.json` 的 `fileSendStageHours` 可改）。
  static const Duration defaultStageDuration = Duration(hours: 24);

  /// 服务端钳制 chunkSize 到 64KB～4MB（超出范围不报错，按边界取值）。
  static int clampChunkSize(int requested) =>
      requested.clamp(minChunkSize, maxChunkSize);
}

/// 服务端文件名处理（§2.1）：截断至 200 字符，`/` 与 `\` 替换为 `_`，
/// 为空则记为 `file`。客户端先按同一口径处理再 init。
String sanitizeStreamFilename(String filename) {
  final truncated =
      filename.length > 200 ? filename.substring(0, 200) : filename;
  final replaced = truncated.replaceAll(RegExp(r'[/\\]'), '_');
  return replaced.isEmpty ? 'file' : replaced;
}

/// 整文件 SHA-256（64 位小写 hex）。客户端须在本地算好再 init。
String sha256Hex(List<int> bytes) => sha256.convert(bytes).toString();

/// 分片器：按服务端返回的 chunkSize 切分（§2.1：客户端须用返回的
/// chunkSize 切分，不得用自己请求的值）。
class StreamChunker {
  const StreamChunker(this.totalBytes, {required this.chunkSize});

  final int totalBytes;
  final int chunkSize;

  int get totalChunks =>
      totalBytes <= 0 ? 0 : (totalBytes + chunkSize - 1) ~/ chunkSize;

  /// 第 [index] 片的字节范围（左闭右开）；末片按实际剩余长度。
  (int, int) chunkRange(int index) {
    final start = index * chunkSize;
    final end = totalBytes < start + chunkSize ? totalBytes : start + chunkSize;
    return (start, end);
  }

  /// 第 [index] 片的期望字节长度（非末片 = chunkSize，末片 = 剩余）。
  int expectedChunkLength(int index) {
    final (start, end) = chunkRange(index);
    return end - start;
  }

  List<int> missingFromReceived(Set<int> received) => List<int>.generate(
        totalChunks,
        (i) => i,
      ).where((i) => !received.contains(i)).toList();
}

/// init 请求的客户端侧校验（与服务端 §2.1 的 VALIDATION / TOO_LARGE
/// 同款；服务端仍会再校验，客户端先校验可少发一次无效请求）。
/// 返回 null 表示通过，否则为错误码。
String? validateStreamInit({
  required String filename,
  required int size,
  required String sha256,
  required String toNode,
  String? fromNode,
  int maxBytes = StreamTransferConstants.defaultMaxBytes,
}) {
  if (toNode.isEmpty) return 'VALIDATION';
  if (fromNode != null && fromNode.isNotEmpty && fromNode == toNode) {
    return 'VALIDATION';
  }
  if (size <= 0) return 'VALIDATION';
  if (size > maxBytes) return 'TOO_LARGE';
  if (!RegExp(r'^[0-9a-f]{64}$').hasMatch(sha256.toLowerCase())) {
    return 'VALIDATION';
  }
  return null;
}

/// 上传状态机（§4）。终态：staged / cancelled / failed。
enum StreamUploadState {
  idle,
  uploading,
  interrupted,
  committing,
  staged,
  cancelled,
  failed,
}

/// commit 结果。
enum StreamCommitOutcome { staged, incomplete, corrupt, failed }

class StreamCommitResult {
  const StreamCommitResult({
    required this.outcome,
    this.stagedId,
    this.size,
    this.expiresAtMs,
    this.missing = const [],
    this.code,
    this.message,
  });

  final StreamCommitOutcome outcome;
  final String? stagedId;
  final int? size;
  final int? expiresAtMs;

  /// INCOMPLETE 时的缺片序号（升序）。
  final List<int> missing;
  final String? code;
  final String? message;

  bool get isStaged => outcome == StreamCommitOutcome.staged;
}

/// 审计记录（§3）：每次传输恰一条（commit 成功/失败、cancel、过期），
/// init/chunk 不记审计；`chunks` ＝ totalChunks（总数，不是已收数）；
/// 只记元数据，不记文件内容。
class StreamAuditEntry {
  const StreamAuditEntry({
    required this.transferId,
    required this.filename,
    required this.size,
    required this.sha256,
    required this.fromNode,
    required this.toNode,
    required this.totalChunks,
    required this.result,
    required this.startedAtMs,
    required this.endedAtMs,
    this.stagedId,
    this.reason,
  });

  final String transferId;
  final String filename;
  final int size;
  final String sha256;
  final String fromNode;
  final String toNode;

  /// ＝ totalChunks（总数）。
  final int totalChunks;

  /// `completed` / `failed` / `cancelled`。
  final String result;
  final int startedAtMs;
  final int endedAtMs;
  final String? stagedId;

  /// 失败原因：`chunk-read-error` / `size-mismatch` /
  /// `sha-mismatch` / `stage-<code>` / `stale`。
  final String? reason;

  factory StreamAuditEntry.fromJson(Map<String, Object?> json) =>
      StreamAuditEntry(
        transferId: json['transferId'] as String? ?? '',
        filename: json['filename'] as String? ?? '',
        size: json['size'] as int? ?? 0,
        sha256: json['sha256'] as String? ?? '',
        fromNode: json['fromNode'] as String? ?? '',
        toNode: json['toNode'] as String? ?? '',
        totalChunks: json['chunks'] as int? ?? 0,
        result: json['result'] as String? ?? '',
        startedAtMs: json['startedAt'] as int? ?? 0,
        endedAtMs: json['endedAt'] as int? ?? 0,
        stagedId: json['stagedId'] as String?,
        reason: json['reason'] as String?,
      );
}

/// 收件箱条目（§2.7）。
class StreamInboxFile {
  const StreamInboxFile({
    required this.id,
    required this.filename,
    required this.size,
    required this.fromNode,
    required this.toNode,
    required this.status,
    required this.createdAtMs,
    required this.expiresAtMs,
  });

  final String id; // stagedId（fs_…）
  final String filename;
  final int size;
  final String fromNode;
  final String toNode;
  final String status;
  final int createdAtMs;
  final int expiresAtMs;

  bool get isExpired =>
      DateTime.now().millisecondsSinceEpoch >= expiresAtMs;

  factory StreamInboxFile.fromJson(Map<String, Object?> json) =>
      StreamInboxFile(
        id: json['id'] as String? ?? '',
        filename: json['filename'] as String? ?? '',
        size: json['size'] as int? ?? 0,
        fromNode: json['fromNode'] as String? ?? '',
        toNode: json['toNode'] as String? ?? '',
        status: json['status'] as String? ?? '',
        createdAtMs: json['createdAt'] as int? ?? 0,
        expiresAtMs: json['expiresAt'] as int? ?? 0,
      );
}

/// 下载结果：206 区间响应与 200 全文件回落须区分处理（§2.6）。
class StreamDownloadResult {
  const StreamDownloadResult({
    required this.bytes,
    required this.isPartial,
    this.contentRange,
  });

  final Uint8List bytes;

  /// true = HTTP 206 区间响应；false = HTTP 200 全文件
  /// （Range 非法时服务端回落为 200 全文件，不返回 416——收到 200
  /// 时须按全文件处理，不得当作区间响应拼装）。
  final bool isPartial;
  final String? contentRange;
}

/// 分片流传输接口（测试用假实现；生产实现见 [HttpStreamTransport]）。
abstract class StreamTransport {
  Future<({String transferId, int chunkSize, int totalChunks})> init({
    required String filename,
    required int size,
    required String sha256,
    required String toNode,
    String? fromNode,
    int? chunkSize,
  });

  Future<int> putChunk({
    required String transferId,
    required int index,
    required List<int> bytes,
  });

  Future<List<int>> missing({required String transferId});

  Future<StreamCommitResult> commit({required String transferId});

  Future<void> cancel({required String transferId});

  Future<List<StreamInboxFile>> inbox({required String node});

  Future<List<StreamInboxFile>> sent();

  Future<void> ack({required String stagedId});

  Future<List<StreamAuditEntry>> audit({int limit = 50});

  Future<StreamDownloadResult> download({
    required String stagedId,
    int? rangeStart,
    int? rangeEnd,
  });
}

class StreamApiException implements Exception {
  const StreamApiException(this.code, [this.message = '']);
  final String code;
  final String message;
  @override
  String toString() => 'StreamApiException($code)';
}

/// 基于 `trustedHttpClient` 的默认传输（与 RC-04 同口径；控制台会话
/// 鉴权由调用方会话承载）。错误一律 HTTP 200 返回
/// `{ ok:false, code, msg }`（下载与审计以外的特例见各方法）。
class HttpStreamTransport implements StreamTransport {
  HttpStreamTransport({
    String? baseUrl,
    ConsoleCookieProvider? cookieProvider,
    int? maxDownloadBytes,
  })  : _baseUrl = baseUrl ?? kServerOrigin,
        _cookieProvider = cookieProvider,
        _maxDownloadBytes =
            maxDownloadBytes ?? StreamTransferConstants.defaultMaxBytes;

  final String _baseUrl;
  static const _timeout = Duration(seconds: 30);

  /// 控制台会话 cookie（DevicePresenceClient 同款 cookie 桥）：
  /// `/license/api/*` 须控制台会话，未带有效 cookie 时服务端回 401；
  /// 不传时保持旧行为（不带 cookie），调用方须自行保证已登录。
  final ConsoleCookieProvider? _cookieProvider;

  /// 下载大小上限（默认单文件上限 200MB；O1：下载前不得无上限读体）。
  final int _maxDownloadBytes;

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
        throw const StreamApiException('UNAUTHORIZED');
      }
      if (res.statusCode == 503) {
        throw const StreamApiException('L5_UNAVAILABLE');
      }
      final decoded = jsonDecode(text);
      if (decoded is! Map<String, Object?>) {
        throw const FormatException('stream 响应不是 JSON 对象');
      }
      return decoded;
    } finally {
      client.close(force: true);
    }
  }

  Future<Map<String, Object?>> _getJson(String path) async {
    final client = trustedHttpClient(connectionTimeout: _timeout);
    try {
      final uri = Uri.parse(_baseUrl).resolve(path);
      final req = await client.getUrl(uri).timeout(_timeout);
      await _attachCookie(req);
      final res = await req.close().timeout(_timeout);
      final text = await res.transform(utf8.decoder).join().timeout(_timeout);
      if (res.statusCode == 401 || res.statusCode == 403) {
        throw const StreamApiException('UNAUTHORIZED');
      }
      if (res.statusCode == 503) {
        throw const StreamApiException('L5_UNAVAILABLE');
      }
      final decoded = jsonDecode(text);
      if (decoded is! Map<String, Object?>) {
        throw const FormatException('stream 响应不是 JSON 对象');
      }
      return decoded;
    } finally {
      client.close(force: true);
    }
  }

  Map<String, Object?> _requireOk(Map<String, Object?> json) {
    if (json['ok'] != true) {
      throw StreamApiException(
        json['code'] as String? ?? 'UNKNOWN',
        json['msg'] as String? ?? '',
      );
    }
    return json;
  }

  @override
  Future<({String transferId, int chunkSize, int totalChunks})> init({
    required String filename,
    required int size,
    required String sha256,
    required String toNode,
    String? fromNode,
    int? chunkSize,
  }) async {
    final body = <String, Object?>{
      'filename': filename,
      'size': size,
      'sha256': sha256,
      'chunkSize': chunkSize ?? StreamTransferConstants.defaultChunkSize,
      'toNode': toNode,
    };
    if (fromNode != null) body['fromNode'] = fromNode;
    final json = _requireOk(await _postJson(
      '/license/api/files/stream/init',
      body,
    ));
    return (
      transferId: json['transferId'] as String,
      chunkSize: json['chunkSize'] as int,
      totalChunks: json['totalChunks'] as int,
    );
  }

  @override
  Future<int> putChunk({
    required String transferId,
    required int index,
    required List<int> bytes,
  }) async {
    final json = _requireOk(await _postJson(
      '/license/api/files/stream/$transferId/chunk',
      {'index': index, 'contentBase64': base64Encode(bytes)},
    ));
    return json['received'] as int? ?? 0;
  }

  @override
  Future<List<int>> missing({required String transferId}) async {
    final json = _requireOk(await _getJson(
      '/license/api/files/stream/$transferId/missing',
    ));
    final raw = json['missing'];
    if (raw is! List) return const [];
    return raw.map((e) => e as int).toList();
  }

  @override
  Future<StreamCommitResult> commit({required String transferId}) async {
    final json = await _postJson(
      '/license/api/files/stream/$transferId/commit',
      {},
    );
    if (json['ok'] == true) {
      return StreamCommitResult(
        outcome: StreamCommitOutcome.staged,
        stagedId: json['stagedId'] as String?,
        size: json['size'] as int?,
        expiresAtMs: json['expiresAt'] as int?,
      );
    }
    final code = json['code'] as String? ?? 'UNKNOWN';
    final missingRaw = json['missing'];
    final missing = missingRaw is List
        ? missingRaw.map((e) => e as int).toList()
        : const <int>[];
    return switch (code) {
      'INCOMPLETE' => StreamCommitResult(
          outcome: StreamCommitOutcome.incomplete,
          missing: missing,
          code: code,
          message: json['msg'] as String?,
        ),
      'CORRUPT' => StreamCommitResult(
          outcome: StreamCommitOutcome.corrupt,
          code: code,
          message: json['msg'] as String?,
        ),
      _ => StreamCommitResult(
          outcome: StreamCommitOutcome.failed,
          code: code,
          message: json['msg'] as String?,
        ),
    };
  }

  @override
  Future<void> cancel({required String transferId}) async {
    _requireOk(await _postJson(
      '/license/api/files/stream/$transferId/cancel',
      {},
    ));
  }

  @override
  Future<List<StreamInboxFile>> inbox({required String node}) async {
    final json = _requireOk(await _getJson(
      '/license/api/files/inbox?node=${Uri.encodeComponent(node)}',
    ));
    final raw = json['files'];
    if (raw is! List) return const [];
    return raw
        .whereType<Map<String, Object?>>()
        .map(StreamInboxFile.fromJson)
        .toList();
  }

  @override
  Future<List<StreamInboxFile>> sent() async {
    final json = _requireOk(await _getJson('/license/api/files/sent'));
    final raw = json['files'];
    if (raw is! List) return const [];
    return raw
        .whereType<Map<String, Object?>>()
        .map(StreamInboxFile.fromJson)
        .toList();
  }

  @override
  Future<void> ack({required String stagedId}) async {
    _requireOk(await _postJson('/license/api/files/$stagedId/ack', {}));
  }

  @override
  Future<List<StreamAuditEntry>> audit({int limit = 50}) async {
    final clamped = limit.clamp(1, 200);
    final json = _requireOk(
      await _getJson('/license/api/files/audit?limit=$clamped'),
    );
    final raw = json['audit'];
    if (raw is! List) return const [];
    return raw
        .whereType<Map<String, Object?>>()
        .map(StreamAuditEntry.fromJson)
        .toList();
  }

  @override
  Future<StreamDownloadResult> download({
    required String stagedId,
    int? rangeStart,
    int? rangeEnd,
  }) async {
    final client = trustedHttpClient(connectionTimeout: _timeout);
    try {
      final uri = Uri.parse(_baseUrl).resolve(
        '/license/api/files/$stagedId/download',
      );
      final req = await client.getUrl(uri).timeout(_timeout);
      if (rangeStart != null) {
        final endPart = rangeEnd == null ? '' : '$rangeEnd';
        req.headers.set(
          HttpHeaders.rangeHeader,
          'bytes=$rangeStart-$endPart',
        );
      }
      await _attachCookie(req);
      final res = await req.close().timeout(_timeout);
      // O1：先校验状态码再读体——非法状态的响应体（错误页/401 JSON）
      // 不得当作文件字节返回；404 仍按 NOT_FOUND，503 按 L5 未加载。
      if (res.statusCode == 404) {
        throw const StreamApiException('NOT_FOUND');
      }
      if (res.statusCode == 401 || res.statusCode == 403) {
        throw const StreamApiException('UNAUTHORIZED');
      }
      if (res.statusCode == 503) {
        throw const StreamApiException('L5_UNAVAILABLE');
      }
      if (res.statusCode != 200 && res.statusCode != 206) {
        throw StreamApiException('HTTP_${res.statusCode}');
      }
      final bytes = await _readCappedBody(res);
      if (res.statusCode == 206) {
        return StreamDownloadResult(
          bytes: bytes,
          isPartial: true,
          contentRange: res.headers.value(HttpHeaders.contentRangeHeader),
        );
      }
      // 200：全文件（Range 非法回落亦然，按全文件处理，不得拼装）。
      return StreamDownloadResult(bytes: bytes, isPartial: false);
    } finally {
      client.close(force: true);
    }
  }

  /// 流式读体并执行大小上限（O1）：Content-Length 已知且超限时直接
  /// 拒绝，不读体；未知长度时边读边计，超限即停并抛 TOO_LARGE。
  /// 上限为单文件上限（默认 200MB）；Range 分片只计本段响应体长度。
  Future<Uint8List> _readCappedBody(HttpClientResponse res) async {
    final contentLength = res.contentLength;
    if (contentLength >= 0 && contentLength > _maxDownloadBytes) {
      throw const StreamApiException('TOO_LARGE');
    }
    final builder = BytesBuilder();
    var total = 0;
    await for (final chunk in res.timeout(_timeout)) {
      total += chunk.length;
      if (total > _maxDownloadBytes) {
        throw const StreamApiException('TOO_LARGE');
      }
      builder.add(chunk);
    }
    return builder.takeBytes();
  }
}

/// 上传会话（§4 状态机，纯逻辑＋传输编排）：
/// idle → uploading →（断网/切后台）interrupted → missing 查缺片 →
/// 补传 → uploading → committing → staged；uploading 态可 cancel →
/// cancelled；commit INCOMPLETE → 回 uploading 补传缺片；
/// commit CORRUPT → failed（终态，整单作废，transferId 不能再用，
/// 须重新 init；UI 提供“重新发送”入口＝重新 init，不得显示
/// “重试提交”）。
///
/// 进度按分片数显示（received/totalChunks），并显示已传字节/总字节；
/// 断网重连后自动调 missing 续传，不得从头重传已收分片；
/// 取消按钮只在 uploading 态可用；commit 提交中禁点取消与重复提交
/// （[isCommitting] 为真时 [cancel] 拒绝）。
class StreamUploadSession {
  StreamUploadSession({
    required this.transport,
    required this.filename,
    required this.fileBytes,
    required this.toNode,
    this.fromNode,
  });

  final StreamTransport transport;
  final String filename;
  final Uint8List fileBytes;
  final String toNode;
  final String? fromNode;

  StreamUploadState state = StreamUploadState.idle;
  String? transferId;
  String? stagedId;
  int? expiresAtMs;
  int chunkSize = StreamTransferConstants.defaultChunkSize;
  int totalChunks = 0;
  int receivedChunks = 0;
  String? lastErrorCode;
  String? lastErrorMessage;

  /// CORRUPT 后整单作废：该 transferId 已不能再用，须重新 init。
  bool get transferVoided => state == StreamUploadState.failed;

  bool get isCommitting => state == StreamUploadState.committing;

  /// 取消按钮只在 uploading 态可用（§4）。
  bool get canCancel => state == StreamUploadState.uploading;

  double get progress =>
      totalChunks <= 0 ? 0 : receivedChunks / totalChunks;

  int get transferredBytes =>
      (receivedChunks * chunkSize).clamp(0, fileBytes.length);

  String get sha256 => sha256Hex(fileBytes);

  /// init：本地算好 SHA-256 再发；用服务端返回的 chunkSize 切分。
  Future<void> start() async {
    final validationError = validateStreamInit(
      filename: filename,
      size: fileBytes.length,
      sha256: sha256,
      toNode: toNode,
      fromNode: fromNode,
    );
    if (validationError != null) {
      state = StreamUploadState.failed;
      lastErrorCode = validationError;
      throw StreamApiException(validationError);
    }
    state = StreamUploadState.uploading;
    final result = await transport.init(
      filename: sanitizeStreamFilename(filename),
      size: fileBytes.length,
      sha256: sha256,
      toNode: toNode,
      fromNode: fromNode,
    );
    transferId = result.transferId;
    chunkSize = result.chunkSize;
    totalChunks = result.totalChunks;
  }

  StreamChunker get _chunker =>
      StreamChunker(fileBytes.length, chunkSize: chunkSize);

  /// 上传缺失的分片（顺序或乱序均可；重复上传同一 index 允许，
  /// 服务端覆盖写、已收计数不变）。[indices] 为空时传全部未收分片
  /// 的本地估算——断点续传时调用方应先调 [resumeAfterInterruption]
  /// 拿服务端 missing 列表再传。
  Future<void> uploadChunks(Iterable<int> indices) async {
    if (state != StreamUploadState.uploading &&
        state != StreamUploadState.interrupted) {
      return;
    }
    state = StreamUploadState.uploading;
    for (final index in indices) {
      final (start, end) = _chunker.chunkRange(index);
      final received = await transport.putChunk(
        transferId: transferId!,
        index: index,
        bytes: fileBytes.sublist(start, end),
      );
      receivedChunks = received;
    }
  }

  /// 断网/切后台后自动续传（§4）：调 missing 查缺片，只补传缺片，
  /// 不得从头重传已收分片。
  Future<List<int>> resumeAfterInterruption() async {
    if (transferId == null) return const [];
    state = StreamUploadState.interrupted;
    final missing = await transport.missing(transferId: transferId!);
    receivedChunks = totalChunks - missing.length;
    await uploadChunks(missing);
    return missing;
  }

  /// commit：INCOMPLETE → 回 uploading 补传缺片后调用方可再 commit；
  /// CORRUPT → failed 终态，整单作废；成功 → staged。
  Future<StreamCommitResult> commit() async {
    if (state == StreamUploadState.committing) {
      throw const StreamApiException('STATE', '提交进行中，禁止重复提交');
    }
    if (transferId == null) {
      throw const StreamApiException('STATE', '未初始化传输');
    }
    state = StreamUploadState.committing;
    final result = await transport.commit(transferId: transferId!);
    switch (result.outcome) {
      case StreamCommitOutcome.staged:
        state = StreamUploadState.staged;
        stagedId = result.stagedId;
        expiresAtMs = result.expiresAtMs;
      case StreamCommitOutcome.incomplete:
        state = StreamUploadState.uploading;
        lastErrorCode = 'INCOMPLETE';
        lastErrorMessage = result.message;
      case StreamCommitOutcome.corrupt:
        // 整单作废，分片已清，此 transferId 不能再用（§2.4）。
        state = StreamUploadState.failed;
        lastErrorCode = 'CORRUPT';
        lastErrorMessage = '校验失败，须重新发送';
      case StreamCommitOutcome.failed:
        state = StreamUploadState.failed;
        lastErrorCode = result.code;
        lastErrorMessage = result.message;
    }
    return result;
  }

  /// 取消：仅 uploading 态可取消；commit 提交中禁点取消。
  Future<bool> cancel() async {
    if (!canCancel || transferId == null) return false;
    await transport.cancel(transferId: transferId!);
    state = StreamUploadState.cancelled;
    return true;
  }

  /// 重新发送入口（CORRUPT 后）：重新 init 一个新传输（新 transferId），
  /// 重传同一文件须重新算 SHA-256、重新上传全部分片。
  StreamUploadSession newAttempt() => StreamUploadSession(
        transport: transport,
        filename: filename,
        fileBytes: fileBytes,
        toNode: toNode,
        fromNode: fromNode,
      );
}
