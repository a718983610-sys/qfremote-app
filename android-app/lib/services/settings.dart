import 'package:shared_preferences/shared_preferences.dart';

/// 本地设置与计数（与 Windows 版 qf-settings.json 对应的键尽量同名）。
class QfSettings {
  static const _kTheme = 'theme'; // 'blue' | 'dark'
  static const _kPendingUpdate = 'pending_update_version';
  static const _kOfflineCount = 'stats_offline_count';
  static const _kWatchdogReconnects = 'stats_watchdog_reconnects';

  final SharedPreferences _prefs;
  QfSettings(this._prefs);

  static Future<QfSettings> load() async =>
      QfSettings(await SharedPreferences.getInstance());

  String get theme => _prefs.getString(_kTheme) ?? 'blue';
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
}
