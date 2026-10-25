import 'dart:convert';

/// 聊天设备静默解锁·壳侧接线（2.3.0 追加四，格式以 L 线定版为准，
/// 见 social-svc/chat/DESIGN.md 第八节与 v230/l-line/main-js-patch.md）。
///
/// 页面契约（已上线）：window.qfChatState() 同步返回会话/锁定/设备副本
/// 状态；window.qfShellDeviceUnlock(keyB64) 用壳递入的设备密钥尝试解开
/// 「壳路径」设备包裹副本；window.qfShellDeviceEnroll(keyB64) 在页面已
/// 解锁时后台补写壳路径副本。壳只负责：探状态 → 按 planChatDevice 决策
/// → 把设备密钥递入页面（每页每路只递一次，页面内有标记防重复）。

/// 聊天页状态探针脚本：取 qfChatState() 的 JSON；页面没就绪返回空。
const String kChatStateProbeJs =
    '(function(){try{'
    'if(typeof window.qfChatState!=="function")return "";'
    'return JSON.stringify(window.qfChatState());'
    '}catch(e){return "";}})()';

/// qfChatState() 的壳侧视图（只取决策需要的字段）。
class ChatPageState {
  final bool hasToken;
  final bool locked;
  final bool unlocked;
  final bool hasShellDeviceCopy;

  const ChatPageState({
    required this.hasToken,
    required this.locked,
    required this.unlocked,
    required this.hasShellDeviceCopy,
  });
}

/// 解析探针返回值（evaluateJavascript 给的字符串可能带引号包裹）：
/// 解析不了返回 null（本拍不动作）。
ChatPageState? parseChatState(String? raw) {
  if (raw == null) return null;
  var s = raw.trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    try {
      final decoded = jsonDecode(s);
      if (decoded is String) s = decoded;
    } catch (_) {
      return null;
    }
  }
  if (s.isEmpty || s == 'null') return null;
  try {
    final data = jsonDecode(s);
    if (data is! Map) return null;
    return ChatPageState(
      hasToken: data['hasToken'] == true,
      locked: data['locked'] == true,
      unlocked: data['unlocked'] == true,
      hasShellDeviceCopy: data['hasShellDeviceCopy'] == true,
    );
  } catch (_) {
    return null;
  }
}

/// 设备路径动作（与 L 线 planChatDevice 一一对应）。
enum ChatDeviceAction {
  none,
  deviceUnlock,
  deviceEnroll,
}

/// 设备路径决策（纯函数，语义与 L 线 planChatDevice 完全一致）：
/// - 手动退出后不递入（manualLogout）；
/// - 没有聊天会话不递入（noToken）；
/// - 页面已解锁：有壳副本就不动（alreadyEnrolled），没有就补写（deviceEnroll）；
/// - 页面未锁定不递入（notLocked）；
/// - 锁定中且无壳副本不递入（noDeviceCopy，留给密码路径/例外页）；
/// - 锁定中且有壳副本 → deviceUnlock 静默解开。
ChatDeviceAction planChatDevice({
  required bool manualLogout,
  required bool hasToken,
  required bool locked,
  required bool unlocked,
  required bool hasShellDeviceCopy,
}) {
  if (manualLogout) return ChatDeviceAction.none;
  if (!hasToken) return ChatDeviceAction.none;
  if (unlocked) {
    return hasShellDeviceCopy
        ? ChatDeviceAction.none
        : ChatDeviceAction.deviceEnroll;
  }
  if (!locked) return ChatDeviceAction.none;
  if (!hasShellDeviceCopy) return ChatDeviceAction.none;
  return ChatDeviceAction.deviceUnlock;
}

/// 递入脚本（与 L 线 pageChatDeviceUnlock 同语义）：同一页面存活期内
/// 只递一次；页面没有钩子就此作罢；解不开不重试（页面内部处理）。
String buildChatDeviceUnlockScript(String deviceKeyB64) {
  return '(function(k){'
      'if(window.__qfShellDeviceUnlockTried)return "already";'
      'window.__qfShellDeviceUnlockTried=true;'
      'if(typeof window.qfShellDeviceUnlock!=="function")return "no-hook";'
      'window.qfShellDeviceUnlock(k);'
      'return "called";'
      '})(${jsonEncode(deviceKeyB64)})';
}

/// 补写递入脚本（与 L 线 pageChatDeviceEnroll 同语义，标记与解锁独立）。
String buildChatDeviceEnrollScript(String deviceKeyB64) {
  return '(function(k){'
      'if(window.__qfShellDeviceEnrollTried)return "already";'
      'window.__qfShellDeviceEnrollTried=true;'
      'if(typeof window.qfShellDeviceEnroll!=="function")return "no-hook";'
      'window.qfShellDeviceEnroll(k);'
      'return "called";'
      '})(${jsonEncode(deviceKeyB64)})';
}
