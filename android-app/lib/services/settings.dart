import 'package:shared_preferences/shared_preferences.dart';

/// 本地设置与计数（与 Windows 版 qf-settings.json 对应的键尽量同名）。
class QfSettings {
  static const _kTheme = 'theme'; // 'blue' | 'dark'
  static const _kPendingUpdate = 'pending_update_version';
  static const _kOfflineCount = 'stats_offline_count';
  static const _kWatchdogReconnects = 'stats_watchdog_reconnects';

  // 2.3.0 登录三件：两个勾选的上次选择（只存选择本身，账号密码与会话 cookie
  // 一律走 Keystore 加密存储，见 credential_store.dart，绝不落到这里的明文区），
  // 以及「凭据静默登录失败过」的拦截标记（防旧密码反复自动提交撞冻结）。
  static const _kRememberDevice = 'auth_remember_device';
  static const _kRememberPassword = 'auth_remember_password';
  static const _kCredentialBlocked = 'auth_credential_blocked';

  final SharedPreferences _prefs;
  QfSettings(this._prefs);

  static Future<QfSettings> load() async =>
      QfSettings(await SharedPreferences.getInstance());

  String get theme => _prefs.getString(_kTheme) ?? 'blue';

  /// 原始主题偏好：没手动选过时为 null（初始主题跟随系统深浅）。
  String? get themePref => _prefs.getString(_kTheme);

  /// 清除主题偏好（设置页选「跟随系统」时用，回到跟随系统口径）。
  Future<void> clearTheme() => _prefs.remove(_kTheme);
  Future<void> setTheme(String v) => _prefs.setString(_kTheme, v);

  String? get pendingUpdateVersion => _prefs.getString(_kPendingUpdate);
  Future<void> setPendingUpdateVersion(String? v) async {
    if (v == null) {
      await _prefs.remove(_kPendingUpdate);
    } else {
      await _prefs.setString(_kPendingUpdate, v);
    }
  }

  int get offlineCount => _prefs.getInt(_kOfflineCount) ?? 0;
  Future<void> incOfflineCount() =>
      _prefs.setInt(_kOfflineCount, offlineCount + 1);

  int get watchdogReconnects => _prefs.getInt(_kWatchdogReconnects) ?? 0;
  Future<void> incWatchdogReconnects() =>
      _prefs.setInt(_kWatchdogReconnects, watchdogReconnects + 1);

  bool get rememberDevice => _prefs.getBool(_kRememberDevice) ?? false;
  Future<void> setRememberDevice(bool v) => _prefs.setBool(_kRememberDevice, v);

  bool get rememberPassword => _prefs.getBool(_kRememberPassword) ?? false;
  Future<void> setRememberPassword(bool v) =>
      _prefs.setBool(_kRememberPassword, v);

  bool get credentialBlocked => _prefs.getBool(_kCredentialBlocked) ?? false;
  Future<void> setCredentialBlocked(bool v) =>
      _prefs.setBool(_kCredentialBlocked, v);

  /// 手动退出账号：登录相关的选择与标记一次清干净（与凭据存储的 clearAll 配套）。
  Future<void> clearAuthPrefs() async {
    await _prefs.remove(_kRememberDevice);
    await _prefs.remove(_kRememberPassword);
    await _prefs.remove(_kCredentialBlocked);
  }
}
