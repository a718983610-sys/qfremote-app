import 'dart:convert';

/// 控制台登录页桥（2.3.0 安卓端）：原生层与 WebView 里 MeshCentral 登录页之间的约定。
///
/// 背景：登录发生在控制台网页里（#loginpanel / #username / #password /
/// #loginButton / 服务端已有的 #qfRememberDevice「记住此设备」）。安卓壳不重做
/// 登录界面，只往这个页面注入一小段脚本完成四件事：
///   1) 在「记住此设备」下面补一个并列且互相独立的「记住账号密码」勾选框
///      （#qfRememberPassword，服务端页面本身没有这个框，由壳注入）；
///   2) 点登录按钮（含回车触发的程序化点击）时，把本次填写的账号、密码与两个
///      勾选状态经 JS 处理器回传原生层（qfLoginSubmit），由原生层决定存不存；
///   3) 点退出（#logoutMenuOption / #logoutControl 等）时先回传原生层
///      （qfManualLogout）——手动退出是唯一的人工终止，原生层据此清干净并
///      停掉自动恢复，免得刚退出又被自动登录拉回来；
///   4) 原生层要求回填时，把已存账号密码填回输入框并触发页面自己的校验
///      （validateLogin），保证登录按钮可用状态与手输一致。
///
/// 本文件只管脚本生成与探针结果解析（纯函数，可单测）；真正的求值与存储在
/// main.dart 与 services/credential_store.dart。

/// JS 处理器名：登录提交回传。
const String kHandlerLoginSubmit = 'qfLoginSubmit';

/// JS 处理器名：手动退出回传。
const String kHandlerManualLogout = 'qfManualLogout';

/// 登录页探针结果。
class LoginProbe {
  /// 'login' = 登录面板可见（掉登录了）；'console' = 已在控制台里；
  /// 'unknown' = 两个都认不出（页面还没画完/空白页），调用方这一拍不许动作。
  final String state;

  /// 当前登录框里的账号（登录页才有意义）。
  final String username;

  /// 「记住此设备」勾选状态，页面上没有这个框时为 null。
  final bool? rememberDevice;

  /// 「记住账号密码」勾选状态（壳注入的框），还没注入时为 null。
  final bool? rememberPassword;

  const LoginProbe({
    required this.state,
    this.username = '',
    this.rememberDevice,
    this.rememberPassword,
  });

  bool get isLogin => state == 'login';
  bool get isConsole => state == 'console';

  /// 解析探针脚本回传的 JSON 文本（求值层可能带引号包裹，调用方先清洗）。
  /// 解析不了返回 null（按「这一拍看不清」处理，不许猜）。
  static LoginProbe? parse(String raw) {
    try {
      final v = jsonDecode(raw);
      if (v is! Map<String, dynamic>) return null;
      final state = v['state'];
      if (state != 'login' && state != 'console' && state != 'unknown') {
        return null;
      }
      return LoginProbe(
        state: state as String,
        username: v['username'] is String ? v['username'] as String : '',
        rememberDevice:
            v['rememberDevice'] is bool ? v['rememberDevice'] as bool : null,
        rememberPassword: v['rememberPassword'] is bool
            ? v['rememberPassword'] as bool
            : null,
      );
    } catch (_) {
      return null;
    }
  }
}

/// 探针脚本：只读页面状态，回传 JSON 字符串（见 LoginProbe.parse）。
const String kLoginProbeJs = r'''(function () {
  function visible(el) {
    if (!el) return false;
    var r = el.getBoundingClientRect();
    if (!r || r.width === 0 || r.height === 0) return false;
    var s = window.getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
  }
  var panel = document.getElementById('loginpanel');
  var pw = document.getElementById('password');
  var isLogin = !!(panel && pw && visible(pw));
  var hasConsole = !!document.querySelector('#logoutControl, #logoutMenuOption, #masthead, #topMenu, #page_leftbar');
  var rd = document.getElementById('qfRememberDevice');
  var rp = document.getElementById('qfRememberPassword');
  var u = document.getElementById('username');
  return JSON.stringify({
    state: isLogin ? 'login' : (hasConsole ? 'console' : 'unknown'),
    username: u ? u.value : '',
    rememberDevice: rd ? !!rd.checked : null,
    rememberPassword: rp ? !!rp.checked : null
  });
})()''';

/// 点登录按钮的脚本（自动恢复的静默登录用）：按钮在且可用才点，点到返回 true。
const String kSubmitLoginJs = r'''(function () {
  var b = document.getElementById('loginButton');
  if (!b || b.disabled) return false;
  b.click();
  return true;
})()''';

/// 生成登录桥注入脚本。
///
/// [savedUsername]/[savedPassword]：已存凭据（都非空才回填；任一为空只装钩子
/// 与勾选框，绝不回填半截）。[rememberPasswordChecked]/[rememberDeviceChecked]：
/// 两个勾选框的初始状态（取上次提交时保存的选择）。[fillSaved]：本轮是否回填。
/// 返回值（字符串）说明本轮做了什么，供日志与排查：
/// 'no-form' 没登录表单（不在登录页）/ 'hooks-only' 只装了钩子与勾选框 /
/// 'filled' 已回填 / 'fill-failed' 回填没对上。
String buildLoginBridgeJs({
  required String? savedUsername,
  required String? savedPassword,
  required bool rememberPasswordChecked,
  required bool rememberDeviceChecked,
  required bool fillSaved,
}) {
  final u = jsonEncode(savedUsername ?? '');
  final p = jsonEncode(savedPassword ?? '');
  final hasSaved =
      (savedUsername ?? '').isNotEmpty && (savedPassword ?? '').isNotEmpty;
  return '''
(function () {
  var SAVED_U = $u;
  var SAVED_P = $p;
  var HAS_SAVED = $hasSaved;
  var WANT_RP = $rememberPasswordChecked;
  var WANT_RD = $rememberDeviceChecked;
  var FILL = $fillSaved;
  function visible(el) {
    if (!el) return false;
    var r = el.getBoundingClientRect();
    if (!r || r.width === 0 || r.height === 0) return false;
    var s = window.getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
  }
  function call(name, data) {
    try {
      if (window.flutter_inappwebview && window.flutter_inappwebview.callHandler) {
        window.flutter_inappwebview.callHandler(name, data);
      }
    } catch (e) {}
  }
  if (!window.__qfBridgeHooked) {
    window.__qfBridgeHooked = true;
    document.addEventListener('click', function (e) {
      var t = e.target;
      if (!t || !t.closest) return;
      if (t.closest('#loginButton')) {
        var uu = document.getElementById('username');
        var pp = document.getElementById('password');
        var rd = document.getElementById('qfRememberDevice');
        var rp = document.getElementById('qfRememberPassword');
        call('$kHandlerLoginSubmit', {
          username: uu ? uu.value : '',
          password: pp ? pp.value : '',
          rememberDevice: rd ? !!rd.checked : false,
          rememberPassword: rp ? !!rp.checked : false
        });
        return;
      }
      var lo = t.closest('#logoutMenuOption, #logoutControl');
      if (!lo) {
        var txt = (t.textContent || '').trim();
        if (txt === '退出登录' || txt === 'Logout') lo = t;
      }
      if (lo) call('$kHandlerManualLogout', {});
    }, true);
  }
  var panel = document.getElementById('loginpanel');
  var pw = document.getElementById('password');
  if (!panel || !pw) return 'no-form';
  var rpBox = document.getElementById('qfRememberPassword');
  if (!rpBox) {
    var rdBox = document.getElementById('qfRememberDevice');
    var tr = document.createElement('tr');
    var td = document.createElement('td');
    var label = document.createElement('label');
    label.style.cssText = 'box-sizing:border-box;width:280px;display:block;text-align:left;font-size:13px;padding:6px 2px 0 2px;cursor:pointer';
    var input = document.createElement('input');
    input.id = 'qfRememberPassword';
    input.name = 'qfrememberpassword';
    input.type = 'checkbox';
    input.style.cssText = 'vertical-align:-2px;margin-right:6px';
    input.checked = WANT_RP;
    label.appendChild(input);
    label.appendChild(document.createTextNode('记住账号密码'));
    td.appendChild(label);
    tr.appendChild(td);
    var anchor = null;
    if (rdBox) { var rdTr = rdBox.closest('tr'); if (rdTr) anchor = rdTr; }
    if (!anchor) { var pwTr = pw.closest('tr'); if (pwTr) anchor = pwTr; }
    if (anchor && anchor.parentNode) {
      anchor.parentNode.insertBefore(tr, anchor.nextSibling);
      rpBox = input;
    }
  }
  if (!FILL || !HAS_SAVED) return 'hooks-only';
  var uEl = document.getElementById('username');
  if (!uEl || !visible(pw)) return 'hooks-only';
  function setVal(el, v) {
    try {
      var setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set;
      setter.call(el, v);
    } catch (e) { el.value = v; }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
  }
  if (uEl.value !== SAVED_U) setVal(uEl, SAVED_U);
  if (pw.value !== SAVED_P) setVal(pw, SAVED_P);
  if (typeof validateLogin === 'function') {
    try { validateLogin(1); validateLogin(2); } catch (e) {}
  }
  var rd2 = document.getElementById('qfRememberDevice');
  if (rd2) rd2.checked = WANT_RD;
  return (uEl.value === SAVED_U && pw.value === SAVED_P) ? 'filled' : 'fill-failed';
})()
''';
}

// ================= 聊天页桥（2.3.0 追加八·解锁框全删后的口径） =================
// 聊天页（social-svc /chat）自带会话互认：带控制台 cookie 打开即自动换令牌
// 进会话层，不再要登录。**加密解锁全程无界面**：解锁编排在 chat_device.dart
// （顺序＝会话托管取回 → 设备副本 → 已存凭据调 qfShellUnlock，均是程序调用，
// 不碰任何输入框）；解锁框/解锁页相关旧实现（回填 ukPass、改写「聊天加密
// 解锁」标题文案）已按站长 11:54 令全部撤除，例外取消。
// 本桥只剩一件事：登录视图若意外出现（如聊天令牌彻底失效＝未登录，不是
// 解锁）且有已存凭据，回填提交一次——这是账号登录兜底，不是加密解锁。

/// 生成聊天页登录兜底桥脚本。[username]/[password] 为已存凭据（未存时传
/// null）：仅当聊天页登录视图可见时回填提交一次，其余情况不动页面。
String buildChatBridgeJs({String? username, String? password}) {
  final hasCreds = username != null &&
      username.isNotEmpty &&
      password != null &&
      password.isNotEmpty;
  final userJs = hasCreds ? jsonEncode(username) : 'null';
  final passJs = hasCreds ? jsonEncode(password) : 'null';
  return '(function(){'
      'function vis(id){var e=document.getElementById(id);if(!e)return false;'
      'if(e.classList.contains("hidden"))return false;'
      'var s=getComputedStyle(e);return s.display!=="none"&&s.visibility!=="hidden";}'
      'function fill(id,v){var e=document.getElementById(id);if(!e)return;'
      'e.value=v;e.dispatchEvent(new Event("input",{bubbles:true}));'
      'e.dispatchEvent(new Event("change",{bubbles:true}));}'
      'var user=$userJs,pass=$passJs;'
      'if(vis("loginView")){'
      'if(user&&pass&&!window.__qfChatLoginTried){window.__qfChatLoginTried=1;'
      'fill("lgUser",user);fill("lgPass",pass);'
      'var r=document.getElementById("lgRemember");if(r)r.checked=true;'
      'var lb=document.getElementById("lgBtn");if(lb)lb.click();'
      'return "login-submitted";}'
      'return "login-visible";'
      '}'
      'return "chat-ready";'
      '})()';
}
