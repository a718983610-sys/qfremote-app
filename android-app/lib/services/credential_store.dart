import 'dart:async';
import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../core/session_recovery.dart';

/// 安全键值存储的最小面（凭据存储只用读/写/删三件），供单测换内存实现。
abstract class SecureKvStore {
  Future<String?> read(String key);
  Future<void> write(String key, String value);
  Future<void> delete(String key);
}

/// 生产实现：flutter_secure_storage —— 安卓端走 Android Keystore 体系：
/// 数据用 AES-GCM 加密，加密密钥用 RSA-OAEP 包裹、密钥本体由系统
/// Keystore 保管，密文落在应用私有的 SharedPreferences 里。
///
/// 安全口径（如实，不夸大）：密钥不出 Keystore、磁盘上没有明文；但本机在
/// 已解锁状态下，本应用自己能解出明文使用——这是「记住密码」能自动回填的
/// 前提。手机丢失且锁屏密码被破、或手机被植入恶意软件时，这层保护挡不住；
/// 它防的是「数据文件被拷走后离线读出明文」这一类情况。
class FlutterSecureKvStore implements SecureKvStore {
  final FlutterSecureStorage _storage;

  FlutterSecureKvStore([FlutterSecureStorage? storage])
      : _storage = storage ??
            const FlutterSecureStorage(aOptions: AndroidOptions());

  @override
  Future<String?> read(String key) => _storage.read(key: key);

  @override
  Future<void> write(String key, String value) =>
      _storage.write(key: key, value: value);

  @override
  Future<void> delete(String key) => _storage.delete(key: key);
}

/// 内存实现：只供单元测试，进程退出即没，不落盘。
class MemorySecureKvStore implements SecureKvStore {
  final Map<String, String> map = {};

  @override
  Future<String?> read(String key) async => map[key];

  @override
  Future<void> write(String key, String value) async {
    map[key] = value;
  }

  @override
  Future<void> delete(String key) async {
    map.remove(key);
  }
}

/// 一组已保存的账号密码。
class SavedCredentials {
  final String username;
  final String password;
  const SavedCredentials({required this.username, required this.password});
}

/// 凭据与会话快照的加密落盘（2.3.0 需求 1+2 的存储层）。
///
/// 只存三样，全部经 SecureKvStore（生产为 Keystore 加密），绝不进
/// SharedPreferences 明文区：
/// - 账号、密码：仅当用户在登录处勾了「记住账号密码」并提交后才写；
///   未勾选一次都不写；提交时没勾就清掉旧的。
/// - 会话快照：勾过「记住此设备」或「记住账号密码」任一项后，登录成功时
///   摘存，供掉登录时先行恢复。
/// 手动退出账号时 clearAll 一次清干净（三样全清）。
class CredentialStore {
  /// 2.4.5 B22：凭据一次写——账号密码合并成一个 JSON 值写单个 key
  /// （qf_saved_creds），读时整体解析，缺任一字段按无存处理；两次写
  /// 之间崩溃不再留半截凭据。旧版两个分开的 key（qf_saved_username /
  /// qf_saved_password）只作读兼容，写/清时一并处理。
  static const _kCreds = 'qf_saved_creds';
  static const _kUsername = 'qf_saved_username';
  static const _kPassword = 'qf_saved_password';
  static const _kSession = 'qf_session_snapshot';

  final SecureKvStore _kv;

  CredentialStore([SecureKvStore? kv]) : _kv = kv ?? FlutterSecureKvStore();

  /// QF-01（3.0.0 低组）：凭据写改成“新 key 先落盘＋旧 key 尽力清＋
  /// 下次读时扫尾”。旧版三次独立写（写新 key、删旧账号、删旧密码）：
  /// 写新 key 后、删旧 key 前崩溃会留新旧两份凭据同时残留。
  /// 现：① 新 key 写成功即本次保存已生效，删旧 key 各自 try/catch，
  /// 单个删除失败不再把已生效的保存报成失败；② loadCredentials 读到
  /// 有效新 key 时顺手清掉残留旧 key（崩溃窗口的自愈扫尾，同样尽力
  /// 而为、失败不影响本次读凭据）。旧 key 从此只剩“读兼容”，不再
  /// 是第二份有效凭据。
  Future<void> saveCredentials(String username, String password) async {
    await _kv.write(
        _kCreds, jsonEncode({'username': username, 'password': password}));
    // 旧版分开的 key 不再写新值，残留的旧值清掉，免得新旧两份打架。
    // 尽力清：新凭据已落盘，删旧失败不能反噬本次保存。
    await _quietDelete(_kUsername);
    await _quietDelete(_kPassword);
  }

  /// 尽力删一个 key：失败只吞掉（调用方已保证主写已完成，或读侧
  /// 已拿到有效值），不许删除失败反噬主流程。
  Future<void> _quietDelete(String key) async {
    try {
      await _kv.delete(key);
    } catch (_) {
      // 残留旧 key 由下次 loadCredentials 扫尾再清，不在这里报错。
    }
  }

  /// 取已存凭据：账号密码缺任一项（或为空）都按没存处理，绝不回半截。
  Future<SavedCredentials?> loadCredentials() async {
    final raw = await _kv.read(_kCreds);
    if (raw != null && raw.isNotEmpty) {
      try {
        final v = jsonDecode(raw);
        if (v is Map<String, dynamic>) {
          final u = v['username'];
          final p = v['password'];
          if (u is String &&
              u.isNotEmpty &&
              p is String &&
              p.isNotEmpty) {
            // QF-01 扫尾：新 key 有效即本次读凭据已定，顺手清掉崩溃窗口
            // 可能残留的旧 key（尽力清，不等它、不因它失败）。
            unawaited(_quietDelete(_kUsername));
            unawaited(_quietDelete(_kPassword));
            return SavedCredentials(username: u, password: p);
          }
        }
      } catch (_) {
        // 新 key 损坏：落到旧 key 兼容读
      }
      return null;
    }
    final u = await _kv.read(_kUsername);
    final p = await _kv.read(_kPassword);
    if (u == null || u.isEmpty || p == null || p.isEmpty) return null;
    return SavedCredentials(username: u, password: p);
  }

  /// DC-C 新发现（QF-01 同类，清路径）：清理是尽力而为——单步删除失败
  /// 不许中断后续清除。旧版三删顺序 await，任一步抛错（如 Keystore 瞬时
  /// 不可用）即中断 clearAll，后面的 key 全残留：退出登录时若会话快照
  /// 残留，下次冷启恢复链会拿它自动恢复，等同“退了又自动登回来”。
  /// 各删各自 try/catch（复用 _quietDelete），清不掉的下次读/写时再扫尾。
  Future<void> clearCredentials() async {
    await _quietDelete(_kCreds);
    await _quietDelete(_kUsername);
    await _quietDelete(_kPassword);
  }

  Future<void> saveSession(SessionSnapshot snapshot) =>
      _kv.write(_kSession, snapshot.toJson());

  Future<SessionSnapshot?> loadSession() async {
    final raw = await _kv.read(_kSession);
    if (raw == null || raw.isEmpty) return null;
    return SessionSnapshot.fromJson(raw);
  }

  Future<void> clearSession() => _quietDelete(_kSession);

  /// 一次清干净：凭据 + 会话快照全清（手动退出账号专用）。
  Future<void> clearAll() async {
    await clearCredentials();
    await clearSession();
  }
}
