import 'package:flutter_test/flutter_test.dart';
import 'package:qfremote/core/login_bridge.dart';
import 'package:qfremote/core/session_recovery.dart';
import 'package:qfremote/services/credential_store.dart';

void main() {
  group('SessionSnapshot（会话快照）', () {
    final now = DateTime(2026, 10, 25, 12, 0);

    test('JSON 往返不丢字段', () {
      final snap = SessionSnapshot(
        cookies: {'xid': 'abc', 'xid.sig': 'sig', 'qfrem': '1'},
        savedAt: now,
      );
      final back = SessionSnapshot.fromJson(snap.toJson());
      expect(back, isNotNull);
      expect(back!.cookies, snap.cookies);
      expect(back.savedAt, now);
    });

    test('新鲜度：29 天内新鲜、31 天过期、没 xid 不算数', () {
      SessionSnapshot at(Duration age) => SessionSnapshot(
          cookies: {'xid': 'abc'}, savedAt: now.subtract(age));
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
