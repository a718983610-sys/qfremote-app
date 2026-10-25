import 'dart:convert';
import 'dart:io';

import 'package:flutter_inappwebview/flutter_inappwebview.dart';

import '../core/constants.dart';
import 'probe.dart' show trustedHttpClient;

/// 隐私锁桥（线 B 接缝：只此一处耦合服务端契约，UI 与状态机不碰路径/字段）。
///
/// 基址 https://$kServerHost:8445/lock（与好友同服务族）；鉴权用好友服务
/// 会话 Cookie（壳内同一 WebView Cookie 罐，登录一次通用）。
/// 壳不存任何密码：锁密码与登录密码只在提交瞬间过桥，用完即弃。
/// A 线契约若有出入，只改本文件。

/// 无 A 线时全链自测开关：--dart-define=QF_LOCK_MOCK=1（或 =true）启用内存假数据。
const bool kLockMock = bool.fromEnvironment('QF_LOCK_MOCK');

class LockDevice {
  final String id;
  final String name;
  final bool owner;
  final bool locked;
  final bool component;

  const LockDevice({
    required this.id,
    required this.name,
    required this.owner,
    required this.locked,
    required this.component,
  });

  factory LockDevice.fromJson(Map<String, dynamic> json) => LockDevice(
        id: json['id']?.toString() ?? '',
        name: json['name']?.toString() ?? '',
        owner: json['owner'] == true,
        locked: json['locked'] == true,
        component: json['component'] == true,
      );

  LockDevice copyWith({bool? locked}) => LockDevice(
        id: id,
        name: name,
        owner: owner,
        locked: locked ?? this.locked,
        component: component,
      );
}

class LockException implements Exception {
  final String message;
  final bool needLogin;
  const LockException(this.message, {this.needLogin = false});

  @override
  String toString() => message;
}

/// 锁密码壳侧预检（最终以 A 线为准）：4–64 位。
String? validateLockPassword(String password) {
  if (password.length < 4) return '密码至少 4 位，请检查后重试。';
  if (password.length > 64) return '密码最多 64 位，请检查后重试。';
  return null;
}

class LockClient {
  final bool mock;

  LockClient({bool? mock}) : mock = mock ?? kLockMock;

  // ---- Mock（内存假数据，同构于真桥；enable/disable/reset 真改内存状态） ----
  static List<LockDevice> _mockDevices = _seedMock();

  static List<LockDevice> _seedMock() => const [
        LockDevice(id: 'mock-1', name: '我的台式机', owner: true, locked: false, component: true),
        LockDevice(id: 'mock-2', name: '家里电脑', owner: true, locked: true, component: true),
        LockDevice(id: 'mock-3', name: '好友共享的电脑', owner: false, locked: false, component: true),
      ].toList();

  /// 测试用：把 Mock 数据重置回种子状态。
  static void resetMock() {
    _mockDevices = _seedMock();
  }

  int _mockIndex(String id) {
    final i = _mockDevices.indexWhere((d) => d.id == id);
    if (i < 0) throw const LockException('未找到该设备，请检查后重试。');
    return i;
  }

  // ---- 对外接口 ----
  Future<List<LockDevice>> listDevices() async {
    if (mock) return List<LockDevice>.unmodifiable(_mockDevices);
    final json = await _request('GET', '/devices');
    final list = json['devices'];
    if (list is! List) throw const LockException('隐私锁服务返回异常，请稍后重试。');
    return list
        .whereType<Map<String, dynamic>>()
        .map(LockDevice.fromJson)
        .toList();
  }

  Future<void> enable(String id, String password) async {
    final err = validateLockPassword(password);
    if (err != null) throw LockException(err);
    if (mock) {
      final i = _mockIndex(id);
      _mockDevices[i] = _mockDevices[i].copyWith(locked: true);
      return;
    }
    await _request('POST', '/enable', body: {'id': id, 'password': password});
  }

  Future<void> disable(String id) async {
    if (mock) {
      final i = _mockIndex(id);
      _mockDevices[i] = _mockDevices[i].copyWith(locked: false);
      return;
    }
    await _request('POST', '/disable', body: {'id': id});
  }

  Future<void> reset(String id, String loginPassword, String newPassword) async {
    final err = validateLockPassword(newPassword);
    if (err != null) throw LockException(err);
    if (mock) {
      final i = _mockIndex(id);
      // 重设后机器保持锁定：locked 不变。
      _mockDevices[i] = _mockDevices[i].copyWith(locked: true);
      return;
    }
    await _request('POST', '/reset', body: {
      'id': id,
      'loginPassword': loginPassword,
      'newPassword': newPassword,
    });
  }

  // ---- 真桥 ----
  Future<Map<String, dynamic>> _request(
    String method,
    String path, {
    Map<String, dynamic>? body,
  }) async {
    final client = trustedHttpClient(
      connectionTimeout: const Duration(seconds: 10),
      port: kLockPort,
    );
    try {
      final url = Uri.parse('$kLockApiBase$path');
      final HttpClientRequest req;
      if (method == 'GET') {
        req = await client.getUrl(url);
      } else {
        req = await client.postUrl(url);
      }
      final cookieHeader = await _cookieHeader();
      if (cookieHeader != null && cookieHeader.isNotEmpty) {
        req.headers.set(HttpHeaders.cookieHeader, cookieHeader);
      }
      if (body != null) {
        req.headers.contentType = ContentType.json;
        req.write(jsonEncode(body));
      }
      final res = await req.close().timeout(const Duration(seconds: 10));
      final text = await utf8.decodeStream(res).timeout(const Duration(seconds: 10));
      Map<String, dynamic> json = const {};
      if (text.isNotEmpty) {
        try {
          final decoded = jsonDecode(text);
          if (decoded is Map<String, dynamic>) json = decoded;
        } catch (_) {}
      }
      if (res.statusCode == 401) {
        throw LockException(
          json['error']?.toString() ?? '请先登录。',
          needLogin: true,
        );
      }
      if (res.statusCode != 200) {
        throw LockException(
          json['error']?.toString() ?? '隐私锁服务异常（HTTP ${res.statusCode}），请稍后重试。',
        );
      }
      return json;
    } on LockException {
      rethrow;
    } catch (e) {
      throw LockException('暂时无法连接隐私锁服务，请检查网络后重试。');
    } finally {
      client.close(force: true);
    }
  }

  /// 与 main.dart 里 _handlePageDownload 同款：取 WebView 会话 Cookie 拼 Cookie 头。
  Future<String?> _cookieHeader() async {
    try {
      final cookies = await CookieManager.instance().getCookies(url: WebUri(kLockApiBase));
      if (cookies.isEmpty) return null;
      return cookies.map((c) => '${c.name}=${c.value}').join('; ');
    } catch (_) {
      return null;
    }
  }
}
