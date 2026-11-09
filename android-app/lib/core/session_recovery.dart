import 'dart:convert';

/// 会话快照的有效期：与服务端「记住此设备」30 天持久会话同一口径。
const Duration kSessionLifetime = Duration(days: 30);

/// 控制台会话快照：登录成功后从 WebView 的 CookieManager 摘下的会话 cookie
/// （xid / xid.sig / qfrem），连同摘取时间一起加密落盘（见 CredentialStore）。
/// 掉登录时先把它塞回 CookieManager 再刷新页面——服务端认这组签名 cookie，
/// 认得回就直接回控制台，不用再输密码。
class SessionSnapshot {
  final Map<String, String> cookies;
  final DateTime savedAt;

  const SessionSnapshot({required this.cookies, required this.savedAt});

  /// 还新鲜：有会话 cookie、没超过 30 天、时间没倒流（改系统时间防误判，
  /// 留 5 分钟宽限）。[serverNow] 为服务端时间（预检回包带 serverTime
  /// 时以服务端时间为准，B22：本地时钟只作兜底）。
  bool isFresh(DateTime now, {DateTime? serverNow}) {
    final ref = serverNow ?? now;
    if (cookies.isEmpty || (cookies['xid'] ?? '').isEmpty) return false;
    if (savedAt.isAfter(ref.add(const Duration(minutes: 5)))) return false;
    return ref.difference(savedAt) < kSessionLifetime;
  }

  String toJson() => jsonEncode({
        'cookies': cookies,
        'savedAt': savedAt.millisecondsSinceEpoch,
      });

  /// 宽容解析：格式不对一律返回 null（按没有快照处理，不许猜）。
  static SessionSnapshot? fromJson(String raw) {
    try {
      final v = jsonDecode(raw);
      if (v is! Map<String, dynamic>) return null;
      final c = v['cookies'];
      final t = v['savedAt'];
      if (c is! Map<String, dynamic> || t is! int) return null;
      final cookies = <String, String>{};
      for (final e in c.entries) {
        if (e.value is String && (e.value as String).isNotEmpty) {
          cookies[e.key] = e.value as String;
        }
      }
      if (cookies.isEmpty) return null;
      return SessionSnapshot(
        cookies: cookies,
        savedAt: DateTime.fromMillisecondsSinceEpoch(t),
      );
    } catch (_) {
      return null;
    }
  }
}

/// 恢复链的下一步。
enum RecoveryStep {
  /// 先试会话恢复：塞回快照 cookie 再刷新。
  restoreSession,

  /// 再试凭据静默登录：回填已存账号密码并自动提交。
  credentialLogin,

  /// 停手：没有可试的了（或被手动退出/凭据拦截挡住），露登录页让用户自己来。
  stop,
}

/// 自动重新登录的状态机（纯逻辑，可单测）——2.3.0 需求 1 的裁决核心：
///
/// 只要用户勾过「记住此设备」或「记住账号密码」，掉登录后按固定顺序恢复：
/// 先会话恢复（最多 [maxSessionAttempts] 次），再凭据静默登录（最多
/// [maxCredentialAttempts] 次）。次数卡死是防冻结红线：服务端同一账号当天
/// 输错 5 次就冻结，自动提交绝不能反复拿（可能已改掉的）旧密码去撞。
///
/// 两道闸：
/// - 手动退出（manualLogout）：唯一人工终止。置位后一切恢复停手，直到下一次
///   登录成功才解除。
/// - 凭据拦截（credentialBlocked）：一次凭据静默登录失败后置位（落盘持久），
///   之后只回填、不自动提交，直到下一次登录成功才解除。
class AutoLoginController {
  static const int maxSessionAttempts = 2;
  static const int maxCredentialAttempts = 1;

  bool _suppressedByManualLogout = false;
  bool credentialBlocked = false;

  int _sessionAttempts = 0;
  int _credentialAttempts = 0;

  bool get suppressedByManualLogout => _suppressedByManualLogout;
  int get sessionAttempts => _sessionAttempts;
  int get credentialAttempts => _credentialAttempts;

  /// 新一轮掉登录：只清本轮计数，两道闸不跟着清。
  void beginEpisode() {
    _sessionAttempts = 0;
    _credentialAttempts = 0;
  }

  /// 登录成功：计数与两道闸全清零。
  void onLoginSuccess() {
    beginEpisode();
    _suppressedByManualLogout = false;
    credentialBlocked = false;
  }

  /// 手动退出账号：置闸并清计数，此后 next 一律 stop。
  void onManualLogout() {
    _suppressedByManualLogout = true;
    beginEpisode();
  }

  /// 裁决下一步（不改状态；真正执行前由调用方记一笔 recordAttempt）。
  RecoveryStep next({
    required bool hasFreshSession,
    required bool hasCredentials,
  }) {
    if (_suppressedByManualLogout) return RecoveryStep.stop;
    if (hasFreshSession && _sessionAttempts < maxSessionAttempts) {
      return RecoveryStep.restoreSession;
    }
    if (hasCredentials &&
        !credentialBlocked &&
        _credentialAttempts < maxCredentialAttempts) {
      return RecoveryStep.credentialLogin;
    }
    return RecoveryStep.stop;
  }

  /// 记一笔已执行的恢复动作。
  void recordAttempt(RecoveryStep step) {
    if (step == RecoveryStep.restoreSession) _sessionAttempts++;
    if (step == RecoveryStep.credentialLogin) _credentialAttempts++;
  }

  /// 本轮是否还可能恢复（给界面判断要不要继续盖住登录页）。
  bool canStillRecover({
    required bool hasFreshSession,
    required bool hasCredentials,
  }) =>
      next(hasFreshSession: hasFreshSession, hasCredentials: hasCredentials) !=
      RecoveryStep.stop;
}
