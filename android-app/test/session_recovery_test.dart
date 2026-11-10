import 'package:flutter_test/flutter_test.dart';
import 'package:qfremote/core/login_bridge.dart';
import 'package:qfremote/core/session_recovery.dart';
import 'package:qfremote/services/credential_store.dart';

void main() {
  group('SessionSnapshot（会话快照）', () {
    final now = DateTime(2026, 10, 25, 12, 0);

    test('JSON 往返不丢字段（含账号绑定）', () {
      final snap = SessionSnapshot(
        cookies: {'xid': 'abc', 'xid.sig': 'sig', 'qfrem': '1'},
        savedAt: now,
        accountId: 'alice',
      );
      final back = SessionSnapshot.fromJson(snap.toJson());
      expect(back, isNotNull);
      expect(back!.cookies, snap.cookies);
      expect(back.savedAt, now);
      expect(back.accountId, 'alice');
      // 旧版无账号字段的快照照常读出，accountId 为 null
      final legacy = SessionSnapshot.fromJson(
          '{"cookies":{"xid":"abc","xid.sig":"sig"},"savedAt":${now.millisecondsSinceEpoch}}');
      expect(legacy?.accountId, isNull);
    });

    test('新鲜度：29 天内新鲜、31 天过期、没 xid 不算数', () {
      SessionSnapshot at(Duration age) => SessionSnapshot(
          cookies: {'xid': 'abc', 'xid.sig': 'sig'},
          savedAt: now.subtract(age));
      expect(at(const Duration(days: 29)).isFresh(now), isTrue);
      expect(at(const Duration(days: 31)).isFresh(now), isFalse);
      expect(
        SessionSnapshot(cookies: {'qfrem': '1'}, savedAt: now).isFresh(now),
        isFalse,
      );
      expect(
        SessionSnapshot(cookies: const {}, savedAt: now).isFresh(now),
        isFalse,
      );
    });

    test('QF-02：缺签名 xid.sig 不新鲜；账号不一致不新鲜', () {
      // 只有 xid、没有 xid.sig：服务端认的是签名 cookie 组，不新鲜
      expect(
        SessionSnapshot(cookies: {'xid': 'abc'}, savedAt: now).isFresh(now),
        isFalse,
      );
      SessionSnapshot snap({String? account}) => SessionSnapshot(
          cookies: {'xid': 'abc', 'xid.sig': 'sig'},
          savedAt: now,
          accountId: account);
      // 快照绑 A：当前账号是 A 才新鲜，是 B 就不新鲜
      expect(snap(account: 'alice')
          .isFresh(now, expectedAccount: 'alice'), isTrue);
      expect(snap(account: 'alice')
          .isFresh(now, expectedAccount: 'bob'), isFalse);
      // 旧版无账号快照：调用方给了当前账号时一律不新鲜（fail-closed）
      expect(snap().isFresh(now, expectedAccount: 'bob'), isFalse);
      // QF-02 严格档：调用方给不出当前账号时，新旧快照一律不新鲜
      // （账号未知就不能证明快照属于当前使用者；冷启时调用方从已存
      // 凭据／许可门／上次登录名三路解析账号，正常设备必有一路能给出）
      expect(snap().isFresh(now), isFalse);
      expect(snap(account: 'alice').isFresh(now), isFalse);
    });

    test('坏 JSON 返回 null，不许猜', () {
      expect(SessionSnapshot.fromJson('not json'), isNull);
      expect(SessionSnapshot.fromJson('[]'), isNull);
      expect(SessionSnapshot.fromJson('{"cookies":{},"savedAt":1}'), isNull);
    });
  });

  group('AutoLoginController（恢复链裁决）', () {
    test('顺序：先会话恢复（2 次），再凭据登录（1 次），然后停手', () {
      final c = AutoLoginController();
      expect(c.next(hasFreshSession: true, hasCredentials: true),
          RecoveryStep.restoreSession);
      c.recordAttempt(RecoveryStep.restoreSession);
      expect(c.next(hasFreshSession: true, hasCredentials: true),
          RecoveryStep.restoreSession);
      c.recordAttempt(RecoveryStep.restoreSession);
      expect(c.next(hasFreshSession: true, hasCredentials: true),
          RecoveryStep.credentialLogin);
      c.recordAttempt(RecoveryStep.credentialLogin);
      expect(c.next(hasFreshSession: true, hasCredentials: true),
          RecoveryStep.stop);
    });

    test('没会话快照时直接走凭据登录；没凭据时停手', () {
      final c = AutoLoginController();
      expect(c.next(hasFreshSession: false, hasCredentials: true),
          RecoveryStep.credentialLogin);
      expect(c.next(hasFreshSession: false, hasCredentials: false),
          RecoveryStep.stop);
    });

    test('手动退出是一切的人工终止：有会话有凭据也停手，登录成功才解除', () {
      final c = AutoLoginController();
      c.onManualLogout();
      expect(c.next(hasFreshSession: true, hasCredentials: true),
          RecoveryStep.stop);
      c.beginEpisode(); // 新一轮掉登录也不许解除手动退出的闸
      expect(c.next(hasFreshSession: true, hasCredentials: true),
          RecoveryStep.stop);
      c.onLoginSuccess();
      expect(c.next(hasFreshSession: true, hasCredentials: true),
          RecoveryStep.restoreSession);
    });

    test('凭据拦截置位后跳过凭据登录；登录成功清拦截', () {
      final c = AutoLoginController()..credentialBlocked = true;
      expect(c.next(hasFreshSession: false, hasCredentials: true),
          RecoveryStep.stop);
      expect(c.next(hasFreshSession: true, hasCredentials: true),
          RecoveryStep.restoreSession); // 会话恢复不受凭据拦截影响
      c.onLoginSuccess();
      expect(c.credentialBlocked, isFalse);
      expect(c.next(hasFreshSession: false, hasCredentials: true),
          RecoveryStep.credentialLogin);
    });
  });

  group('CredentialStore（内存安全存储替身）', () {
    test('存取凭据与会话、clearAll 一次清干净', () async {
      final kv = MemorySecureKvStore();
      final store = CredentialStore(kv);
      expect(await store.loadCredentials(), isNull);
      expect(await store.loadSession(), isNull);

      await store.saveCredentials('alice', 'secret-1');
      final creds = await store.loadCredentials();
      expect(creds?.username, 'alice');
      expect(creds?.password, 'secret-1');

      await store.saveSession(SessionSnapshot(
          cookies: {'xid': 'x1'}, savedAt: DateTime(2026, 10, 25)));
      expect((await store.loadSession())?.cookies['xid'], 'x1');

      await store.clearAll();
      expect(await store.loadCredentials(), isNull);
      expect(await store.loadSession(), isNull);
      expect(kv.map, isEmpty); // 手动退出的验证口径：底层一位不剩
    });

    test('只剩半截凭据（只有账号）按没存处理', () async {
      final kv = MemorySecureKvStore();
      final store = CredentialStore(kv);
      await kv.write('qf_saved_username', 'alice');
      expect(await store.loadCredentials(), isNull);
    });

    test('QF-01：崩溃窗口残留的旧 key 在下次读时被扫尾清掉', () async {
      final kv = MemorySecureKvStore();
      final store = CredentialStore(kv);
      // 模拟崩溃窗口：新 key 已写、旧 key 没来得及删。
      await kv.write('qf_saved_creds',
          '{"username":"alice","password":"secret-1"}');
      await kv.write('qf_saved_username', 'alice');
      await kv.write('qf_saved_password', 'old-pass');
      final creds = await store.loadCredentials();
      expect(creds?.username, 'alice');
      expect(creds?.password, 'secret-1');
      expect(kv.map.containsKey('qf_saved_username'), isFalse);
      expect(kv.map.containsKey('qf_saved_password'), isFalse);
    });

    test('QF-01：删旧 key 失败不反噬保存（新凭据已落盘即成功）', () async {
      final kv = _DeleteFailingKv();
      final store = CredentialStore(kv);
      await kv.write('qf_saved_username', 'bob');
      await kv.write('qf_saved_password', 'old-pass');
      // 删旧 key 全抛错，saveCredentials 也不应抛错。
      await store.saveCredentials('carol', 'secret-2');
      expect((await store.loadCredentials())?.username, 'carol');
    });

    test('B22：凭据一次写——单 key JSON，旧分开 key 不残留', () async {
      final kv = MemorySecureKvStore();
      final store = CredentialStore(kv);
      await store.saveCredentials('alice', 'secret-1');
      expect(kv.map.keys, ['qf_saved_creds']);
      expect((await store.loadCredentials())?.password, 'secret-1');
      // 旧版残留的分开 key 也能兼容读，但写后不再留
      await kv.write('qf_saved_username', 'bob');
      await kv.write('qf_saved_password', 'old-pass');
      await store.saveCredentials('carol', 'secret-2');
      expect(kv.map.containsKey('qf_saved_username'), isFalse);
      expect(kv.map.containsKey('qf_saved_password'), isFalse);
      expect((await store.loadCredentials())?.username, 'carol');
      await store.clearCredentials();
      expect(kv.map, isEmpty);
    });

    test('DC-C：clearAll 单步删除失败不中断后续清除（退出不留快照）', () async {
      // 旧版 clearAll：第一删抛错即中断，后面的 key 全残留——退出登录时
      // 若会话快照残留，下次冷启恢复链会拿它自动恢复。修后各删尽力而为。
      final kv = _DeleteFirstKeyFailingKv();
      final store = CredentialStore(kv);
      await store.saveCredentials('alice', 'secret-1');
      await store.saveSession(SessionSnapshot(
          cookies: {'xid': 'x1', 'xid.sig': 's1'},
          savedAt: DateTime(2026, 11, 10)));
      await store.clearAll();
      expect(await store.loadCredentials(), isNull);
      expect(await store.loadSession(), isNull);
      expect(kv.map, isEmpty);
    });
  });

  group('登录桥脚本', () {
    test('探针解析：login / console / unknown 与坏数据', () {
      final p = LoginProbe.parse(
          '{"state":"login","username":"alice","rememberDevice":true,"rememberPassword":null}');
      expect(p?.isLogin, isTrue);
      expect(p?.username, 'alice');
      expect(p?.rememberDevice, isTrue);
      expect(p?.rememberPassword, isNull);
      expect(LoginProbe.parse('{"state":"console"}')?.isConsole, isTrue);
      expect(LoginProbe.parse('{"state":"unknown"}')?.state, 'unknown');
      expect(LoginProbe.parse('{"state":"weird"}'), isNull);
      expect(LoginProbe.parse('junk'), isNull);
    });

    test('注入脚本含两个处理器、独立的「记住账号密码」框与页面校验调用', () {
      final js = buildLoginBridgeJs(
        savedUsername: 'alice',
        savedPassword: 'p@ss"word\n',
        rememberPasswordChecked: true,
        rememberDeviceChecked: false,
        fillSaved: true,
      );
      expect(js, contains('qfRememberPassword'));
      expect(js, contains('记住账号密码'));
      expect(js, contains(kHandlerLoginSubmit));
      expect(js, contains(kHandlerManualLogout));
      expect(js, contains('validateLogin'));
      // 密码里的引号/换行必须被转义进 JS 字符串，不能把脚本撑破
      expect(js, contains(r'p@ss\"word\n'));
      expect(js, isNot(contains('p@ss"word')));
    });

    test('没有已存凭据时不回填（脚本里凭据为空、仍装钩子）', () {
      final js = buildLoginBridgeJs(
        savedUsername: null,
        savedPassword: null,
        rememberPasswordChecked: false,
        rememberDeviceChecked: false,
        fillSaved: true,
      );
      expect(js, contains('HAS_SAVED = false'));
      expect(js, contains(kHandlerLoginSubmit));
    });
  });
}

/// QF-01 测试替身：读/写正常，删一律抛错（模拟删旧 key 时的安全存储故障）。
class _DeleteFailingKv implements SecureKvStore {
  final MemorySecureKvStore _inner = MemorySecureKvStore();

  @override
  Future<String?> read(String key) => _inner.read(key);

  @override
  Future<void> write(String key, String value) => _inner.write(key, value);

  @override
  Future<void> delete(String key) async {
    throw StateError('delete failed (test double)');
  }
}

/// DC-C 测试替身：只删第一个 key（qf_saved_creds）时抛错，其余正常删
/// ——模拟退出清库中途一次 Keystore 瞬时失败，验证后续清除不中断。
class _DeleteFirstKeyFailingKv implements SecureKvStore {
  final MemorySecureKvStore _inner = MemorySecureKvStore();

  @override
  Future<String?> read(String key) => _inner.read(key);

  @override
  Future<void> write(String key, String value) => _inner.write(key, value);

  @override
  Future<void> delete(String key) async {
    if (key == 'qf_saved_creds') {
      throw StateError('delete failed (test double)');
    }
    await _inner.delete(key);
  }
}
