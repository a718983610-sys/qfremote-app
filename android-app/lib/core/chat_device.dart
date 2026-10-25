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
/// hasCustodyCopy＝账号在服务端有「登录状态托管副本」（追加八 O 线）；
/// 页面旧版没有此字段时按 false 处理（托管步自动跳过）。
class ChatPageState {
  final bool hasToken;
  final bool locked;
  final bool unlocked;
  final bool hasShellDeviceCopy;
  final bool hasCustodyCopy;

  const ChatPageState({
    required this.hasToken,
    required this.locked,
    required this.unlocked,
    required this.hasShellDeviceCopy,
    this.hasCustodyCopy = false,
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
      hasCustodyCopy: data['hasCustodyCopy'] == true,
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
/// - 锁定中且无壳副本不递入（noDeviceCopy，编排里继续走托管/凭据步）；
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

// ================= 追加八：解锁编排（托管 → 设备 → 凭据，全程无界面） =====
// 站长 11:54 令：聊天解锁页/解锁框全删、例外取消。壳侧编排顺序固定：
//  ① 会话托管取回（O 线端点：凭有效会话取回本账号钥匙原件静默解锁）；
//  ② 设备副本（qfShellDeviceUnlock 递入设备密钥）；
//  ③ 已存凭据（仅作迁移源：调页面 qfShellUnlock(password) 程序解锁，
//     不碰任何输入框、没有任何界面）；
//  ④ 全失败：壳不做任何界面动作（不可用提示由页面按正式文案渲染，
//     页面不得含密码输入元素——页面侧由 O/L 线保证）。
// 任一路径解锁成功后：账号无托管副本则后台上交补发（custodyEnroll），
// 账号无壳设备副本则补写（deviceEnroll）——都在之后的拍里依次完成。
// 托管钩子名（qfShellCustodyUnlock / qfShellCustodyEnroll）为按 L 线命名
// 惯例的预接线：全部经特性探测（typeof == function 才调用），O 线格式
// 若有出入只需改这两个名字与 qfChatState 的 hasCustodyCopy 字段名。

/// 页面能力探针脚本：页面给壳留的程序钩子是否就位（不取任何材料）。
const String kChatCapsProbeJs =
    '(function(){try{return JSON.stringify({'
    'custodyUnlock:typeof window.qfShellCustodyUnlock==="function",'
    'custodyEnroll:typeof window.qfShellCustodyEnroll==="function",'
    'shellUnlock:typeof window.qfShellUnlock==="function"'
    '});}catch(e){return "";}})()';

/// 页面程序钩子就位情况。
class ChatPageCaps {
  final bool custodyUnlockHook;
  final bool custodyEnrollHook;
  final bool shellUnlockHook;

  const ChatPageCaps({
    this.custodyUnlockHook = false,
    this.custodyEnrollHook = false,
    this.shellUnlockHook = false,
  });
}

/// 解析能力探针返回值（同 parseChatState 的容错口径）。
ChatPageCaps parseChatCaps(String? raw) {
  if (raw == null) return const ChatPageCaps();
  var s = raw.trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    try {
      final decoded = jsonDecode(s);
      if (decoded is String) s = decoded;
    } catch (_) {
      return const ChatPageCaps();
    }
  }
  if (s.isEmpty || s == 'null') return const ChatPageCaps();
  try {
    final data = jsonDecode(s);
    if (data is! Map) return const ChatPageCaps();
    return ChatPageCaps(
      custodyUnlockHook: data['custodyUnlock'] == true,
      custodyEnrollHook: data['custodyEnroll'] == true,
      shellUnlockHook: data['shellUnlock'] == true,
    );
  } catch (_) {
    return const ChatPageCaps();
  }
}

/// 解锁编排的单步动作（每拍只走一步，页面异步工作在拍间落定后重探）。
enum ChatUnlockStep {
  none,
  custodyUnlock,
  deviceUnlock,
  credentialUnlock,
  custodyEnroll,
  deviceEnroll,
}

/// 解锁总编排（纯函数）：按追加八顺序裁决本拍该走哪一步。
/// - 手动退出后 / 无聊天会话：一步都不走（未登录归登录桥兜底）；
/// - 已解锁：先补托管副本（无副本且钩子在）、再补壳设备副本，都齐则停；
/// - 锁定中：托管 → 设备 → 凭据（有已存凭据且 qfShellUnlock 钩子在），
///   都不可用则停（页面显示正式的不可用提示，壳不加任何输入界面）。
ChatUnlockStep planChatUnlock({
  required bool manualLogout,
  required ChatPageState state,
  required ChatPageCaps caps,
  required bool hasCreds,
}) {
  if (manualLogout) return ChatUnlockStep.none;
  if (!state.hasToken) return ChatUnlockStep.none;
  if (state.unlocked) {
    if (!state.hasCustodyCopy && caps.custodyEnrollHook) {
      return ChatUnlockStep.custodyEnroll;
    }
    if (!state.hasShellDeviceCopy) return ChatUnlockStep.deviceEnroll;
    return ChatUnlockStep.none;
  }
  if (!state.locked) return ChatUnlockStep.none;
  if (caps.custodyUnlockHook) return ChatUnlockStep.custodyUnlock;
  if (state.hasShellDeviceCopy) return ChatUnlockStep.deviceUnlock;
  if (hasCreds && caps.shellUnlockHook) return ChatUnlockStep.credentialUnlock;
  return ChatUnlockStep.none;
}

/// 托管取回脚本：每页只调一次；钩子不在就此作罢（特性探测）。
String buildChatCustodyUnlockScript() {
  return '(function(){'
      'if(window.__qfShellCustodyTried)return "already";'
      'window.__qfShellCustodyTried=true;'
      'if(typeof window.qfShellCustodyUnlock!=="function")return "no-hook";'
      'window.qfShellCustodyUnlock();'
      'return "called";'
      '})()';
}

/// 托管补发脚本：解锁成功后账号无托管副本时后台上交，每页只调一次。
String buildChatCustodyEnrollScript() {
  return '(function(){'
      'if(window.__qfShellCustodyEnrollTried)return "already";'
      'window.__qfShellCustodyEnrollTried=true;'
      'if(typeof window.qfShellCustodyEnroll!=="function")return "no-hook";'
      'window.qfShellCustodyEnroll();'
      'return "called";'
      '})()';
}

/// 凭据迁移解锁脚本：用已存密码调页面 qfShellUnlock 程序解锁（无界面、
/// 不碰输入框），每页只试一次；解不开不重试（材料已变时走托管/设备路）。
String buildChatCredentialUnlockScript(String password) {
  return '(function(k){'
      'if(window.__qfShellCredUnlockTried)return "already";'
      'window.__qfShellCredUnlockTried=true;'
      'if(typeof window.qfShellUnlock!=="function")return "no-hook";'
      'window.qfShellUnlock(k);'
      'return "called";'
      '})(${jsonEncode(password)})';
}
