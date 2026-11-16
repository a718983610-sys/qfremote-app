import 'dart:convert';

/// Validate the shared session JSON envelope before protocol-specific casts.
/// Invalid HTTP/JSON/field types stay inside each transport's domain errors.
Map<String, Object?> decodeSessionResponse(
  int status,
  String text,
  Exception Function(String code, String message) error,
) {
  if (status == 401 || status == 403) throw error('UNAUTHORIZED', '');
  if (status == 503) throw error('L5_UNAVAILABLE', '');
  if (status == 404) throw error('NOT_FOUND', '');
  if (status != 200) throw error('HTTP_$status', '');
  try {
    final decoded = jsonDecode(text);
    if (decoded is! Map<String, Object?>) {
      throw const FormatException('Expected JSON object');
    }
    _validateFields(decoded);
    return decoded;
  } on FormatException {
    throw error('INVALID_RESPONSE', '服务端响应格式无效');
  } on TypeError {
    throw error('INVALID_RESPONSE', '服务端响应字段无效');
  }
}

void _validateFields(Map<String, Object?> object, [int depth = 0]) {
  if (depth > 12) throw const FormatException('Response too deeply nested');
  const strings = {
    'code',
    'msg',
    'message',
    'tier',
    'decisionId',
    'from',
    'to',
    'action',
    'note',
    'level',
    'transferId',
    'stagedId',
    'sessionId',
    'deviceId',
    'groupId',
    'result',
    'filename',
    'sha256',
    'fromNode',
    'toNode',
    'status',
    'id',
    'reason',
  };
  const integers = {
    'seq',
    'retryAfterMs',
    'mustAckByMs',
    'events',
    'bytes',
    'size',
    'expiresAt',
    'chunkSize',
    'totalChunks',
    'received',
    'chunks',
    'startedAt',
    'endedAt',
    'createdAt',
    'byteOffset',
    't',
    'at',
    'rttMs',
  };
  const booleans = {'ok', 'needsIdr', 'rebuilt', 'hintOnly'};
  const maps = {'hot', 'reconfig', 'backpressure'};
  const lists = {'missing', 'files', 'audit', 'index', 'relays'};
  for (final entry in object.entries) {
    final value = entry.value;
    if (value == null) continue;
    if ((strings.contains(entry.key) && value is! String) ||
        (integers.contains(entry.key) && value is! int) ||
        (booleans.contains(entry.key) && value is! bool) ||
        (maps.contains(entry.key) && value is! Map<String, Object?>) ||
        (lists.contains(entry.key) && value is! List)) {
      throw const FormatException('Invalid response field type');
    }
    if (entry.key == 'decision' &&
        value is! String &&
        value is! Map<String, Object?>) {
      throw const FormatException('Invalid decision');
    }
    if (entry.key == 'missing' &&
        value is List &&
        value.any((v) => v is! int || v < 0)) {
      throw const FormatException('Invalid missing indices');
    }
    if (value is Map<String, Object?>) _validateFields(value, depth + 1);
    if (value is List) {
      for (final item in value) {
        if (item is Map<String, Object?>) _validateFields(item, depth + 1);
      }
    }
  }
}
