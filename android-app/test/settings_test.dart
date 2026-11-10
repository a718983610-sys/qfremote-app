// QF-02（3.0.0 中组）：上次登录名 lastUsername 的持久化口径。
// 登录成功时写（冷启恢复快照的账号来源之一），手动退出（clearAuthPrefs）
// 与凭据被拒时清——退出后冷启不得再用旧账号放行旧快照。
import 'package:flutter_test/flutter_test.dart';
import 'package:qfremote/services/settings.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  test('lastUsername 写后可读，clearAuthPrefs 后为空', () async {
    SharedPreferences.setMockInitialValues({});
    final s = await QfSettings.load();
    expect(s.lastUsername, isNull);
    await s.setLastUsername('alice');
    expect(s.lastUsername, 'alice');
    await s.setLastUsername('bob');
    expect(s.lastUsername, 'bob');
    // 手动退出：登录相关的选择与标记一次清干净，含上次登录名。
    await s.setRememberDevice(true);
    await s.setRememberPassword(true);
    await s.clearAuthPrefs();
    expect(s.lastUsername, isNull);
    expect(s.rememberDevice, isFalse);
    expect(s.rememberPassword, isFalse);
  });

  test('setLastUsername(null) 与空串都清掉', () async {
    SharedPreferences.setMockInitialValues({});
    final s = await QfSettings.load();
    await s.setLastUsername('alice');
    await s.setLastUsername(null);
    expect(s.lastUsername, isNull);
    await s.setLastUsername('alice');
    await s.setLastUsername('');
    expect(s.lastUsername, isNull);
  });
}
