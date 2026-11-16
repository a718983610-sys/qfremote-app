import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/physics.dart';

/// QF 家族设计语言（三端统一，三端 UI 重构 Q3c 定版，2026-11-13；
/// 黑白化 2026-11-13 站长令：UI 主色只用黑白灰，品牌蓝 #2470E0 已退役，
/// 唯一字面量出处见旧 brand——现 brand 为随主题走的实例 token；
/// 2026-11-14 按大肥鱼定夺修订：Token 全量收敛到定夺值（见 DEEPSEEK-
/// DESIGN-DECISION.md），整页跟随系统主题黑白切换）：
/// 浅色白底黑字／深色黑底白字；主按钮浅色纯黑底白字、深色纯白底黑字。
/// 深色表面 #08090A/#111113/#18181B／浅色底 #FFFFFF/#F7F7F8/#EFEFF1／
/// 状态色按 2026-11-15 定稿（B 组，三端唯一口径，A 组已废止）：
/// 成功绿 #16A34A（浅）／#22C55E（深）、未激活橙 #EA580C（浅）／#FB923C（深）、
/// 登出红 #DC2626（浅）／#F87171（深）；信息色不用蓝，用中性灰。
/// 深色阴影一律 none（平涂口径）；动效强调色仅黑白与中性灰。
/// 链接不用蓝：主文字色＋始终下划线（见 link／linkUnderline）。
/// 注意：`blue` 是历史名＝浅色模式（偏好存值 'blue' 已落用户设备，
/// 改名会丢用户偏好，故只改含义不改名；见 A1 偏好链）。
enum QfThemeMode { blue, dark }

extension QfThemeModeX on QfThemeMode {
  String get prefValue => this == QfThemeMode.blue ? 'blue' : 'dark';
  static QfThemeMode fromPref(String? v) =>
      v == 'dark' ? QfThemeMode.dark : QfThemeMode.blue;
}

/// 初始主题裁决（纯函数）：用户手动选过（偏好非空）永远听用户的；
/// 从没选过时跟随系统深浅——系统深色用深色主题，否则浅色。
/// 系统切换深浅时也按同一口径实时跟随（仅限没手动选过的用户）。
/// D1 裁决（2026-11-14，大肥鱼 shanedit deepseek-v4-flash 原话，
/// 见 rework/REPLY-D1 归档与返工报告）：“结论：满足。理由：已存手动偏好
/// 不丢，未选过时按系统亮度解析并监听切换，等价于 system 加偏好覆盖，
/// 符合 A1 与 §3.3 的合并语义。”——故本函数逻辑不变，不改成
/// ThemeMode.system；A §3.3 的 system 语义由“未选跟随系统”覆盖。
QfThemeMode resolveThemeMode({
  String? pref,
  required Brightness platformBrightness,
}) {
  if (pref != null && pref.isNotEmpty) return QfThemeModeX.fromPref(pref);
  return platformBrightness == Brightness.dark
      ? QfThemeMode.dark
      : QfThemeMode.blue;
}

/// P0-2：向已加载 WebView 推送壳主题的 JS 片段（纯函数）。
/// 与 Web 页约定的窗口事件 `qf-theme-state` 同契约：
/// detail 为 {resolved: 'dark'|'blue', mode: 'system'|'blue'|'dark'}，
/// 其中 'blue' 是浅色历史键名，不对应蓝色。mode 非法值一律按 'system' 算。
String buildThemeStateEventJs({required bool isDark, String? mode}) {
  final resolved = isDark ? 'dark' : 'blue';
  final m = (mode == 'dark' || mode == 'blue' || mode == 'system')
      ? mode!
      : 'system';
  return "window.dispatchEvent(new CustomEvent('qf-theme-state',{detail:{resolved:'$resolved',mode:'$m'}}));";
}

/// 展示面版本号：技术版本号（如 3.0.0）去尾部 `.0`，展示面写 3.0。
/// 仅用于当前版本展示；待装／清单版本号是技术标识，不走本函数。
/// '3.0.0' → '3.0'；'3.1.0' → '3.1'；'3.0.1' → '3.0.1'；'3.0' → '3.0'。
String displayVersion(String v) {
  final parts = v.split('.');
  if (parts.length > 2 && parts.last == '0') {
    return parts.sublist(0, parts.length - 1).join('.');
  }
  return v;
}

class QfPalette {
  final QfThemeMode mode;
  const QfPalette(this.mode);

  bool get isDark => mode == QfThemeMode.dark;

  /// 主色（按钮、强调、选中态图标）：定夺值——浅色纯黑 #000000、
  /// 深色纯白 #FFFFFF（定夺 §1.3 纯黑／纯白强调）。旧品牌蓝 #2470E0
  /// 已退役（站长令 2026-11-13：从 UI 移除）；各处一律引用实例 brand，
  /// 不许再出现 #2470E0 字面量（历史注释除外，见证据报告）。
  /// 必须是实例 getter：深色要白、浅色要黑，静态常量装不下两端。
  Color get brand =>
      isDark ? const Color(0xFFFFFFFF) : const Color(0xFF000000);

  /// brand 上的字／图标色：浅色白字 #FFFFFF（对纯黑 21.00:1）、
  /// 深色黑字 #000000（对纯白 21.00:1）。
  Color get onBrand =>
      isDark ? const Color(0xFF000000) : const Color(0xFFFFFFFF);

  /// brand 的 CSS hex 形式，由 brand 派生（不许第二处字面量）：
  /// 供登录桥／WebView 注入 CSS 引用。
  String get brandCssHex =>
      '#${brand.toARGB32().toRadixString(16).substring(2).toUpperCase()}';

  /// 链接色（定夺 §3.3：不用蓝，主文字色＋始终下划线）：
  /// 浅色 #09090B（对白底 19.90:1）、深色 #FFFFFF（对卡片 18.86:1）。
  /// 查询密钥／申诉换绑等文字链走 link，不走 brand；下划线色见
  /// linkUnderline，调用方必须同时画下划线（光改色不算区分）。
  Color get link =>
      isDark ? const Color(0xFFFFFFFF) : const Color(0xFF09090B);

  /// 链接下划线色（定夺 §3.3）：浅色 #A1A1AA、深色 #52525B；
  /// hover 时下划线变主文字色（#000000／#FFFFFF）。
  Color get linkUnderline =>
      isDark ? const Color(0xFF52525B) : const Color(0xFFA1A1AA);

  /// link 的 CSS hex 形式，由 link 派生（登录桥文字链用）。
  String get linkCssHex =>
      '#${link.toARGB32().toRadixString(16).substring(2).toUpperCase()}';

  /// linkUnderline 的 CSS hex 形式，由 linkUnderline 派生。
  String get linkUnderlineCssHex =>
      '#${linkUnderline.toARGB32().toRadixString(16).substring(2).toUpperCase()}';

  // ---- Q1b 表面阶梯（定夺 §1.3：深色 #08090A/#111113/#18181B；
  // 浅色 #FFFFFF/#F7F7F8/#EFEFF1，冷中性灰；即兴灰阶已收敛） ----
  Color get surface0 =>
      isDark ? const Color(0xFF08090A) : const Color(0xFFFFFFFF);
  Color get surface1 =>
      isDark ? const Color(0xFF111113) : const Color(0xFFF7F7F8);
  Color get surface2 =>
      isDark ? const Color(0xFF18181B) : const Color(0xFFEFEFF1);
  Color get surface3 =>
      isDark ? const Color(0xFF18181B) : Colors.white;

  // ---- A 重做 §3.0 表面层级 BG0–BG5（2026-11-14） ----
  // 与 surface0–3 并存，不替换旧 token（旧 token 有测试断言与 6 项灰阶
  // 审计口径绑定，见 SIX-ITEMS-DECISION.md ②）：BG0＝surface0（页面底），
  // BG1 深 #121214／浅 surface1；BG2 深 #1C1C1E／浅 #F0F0F2（W3 定夺
  // 2026-11-14：深色相邻面做 Apple 式大跳变，BG1→BG2 拉开层级，
  // hairline 只兜底；BG3 #17181A 与 BG2 #1C1C1E 仍可辨）；BG3–BG5 只用于
  // 悬浮／选中／抽屉／模态等浮层，不作常驻页面底。单视图同时可见的结构灰
  // ≤4 级（A §4：页面底 1＋主表面 1＋悬浮／选中 1＋模态／抽屉 1），
  // 相邻面三选一：明度差 ΔL*≥5，或 1px hairline，或 elevation 阴影／遮罩；
  // 深色相邻面默认配 1px rgba(255,255,255,.08) 内描边，浅色默认配
  // #E4E4E7 hairline 或 e1 阴影。
  Color get bg0 =>
      isDark ? const Color(0xFF08090A) : const Color(0xFFFFFFFF);
  Color get bg1 =>
      isDark ? const Color(0xFF121214) : const Color(0xFFF7F7F8);
  Color get bg2 =>
      isDark ? const Color(0xFF1C1C1E) : const Color(0xFFF0F0F2);
  Color get bg3 =>
      isDark ? const Color(0xFF17181A) : const Color(0xFFE8E8EB);
  Color get bg4 =>
      isDark ? const Color(0xFF1F2023) : const Color(0xFFDFDFE3);
  Color get bg5 =>
      isDark ? const Color(0xFF27272A) : const Color(0xFFD6D6DB);

  /// 深色相邻面内描边：1px rgba(255,255,255,.08)；浅色相邻面用
  /// lineDefault #E4E4E7 hairline（见 A §4 第 4 条）。
  Color get innerHairline => isDark
      ? const Color.from(alpha: 0.08, red: 1, green: 1, blue: 1)
      : lineDefault;

  // ---- A 重做 §2.5 交互状态矩阵（实色叠色，不靠整体 opacity） ----
  // hover 深白 6%／浅黑 4%；selected 深白 9%／浅黑 6%（＋2px inset bar，
  // 见 QfListRow.selected）；pressed 深白 13%／浅黑 10%。
  Color get hoverOverlay => isDark
      ? const Color.from(alpha: 0.06, red: 1, green: 1, blue: 1)
      : const Color.from(alpha: 0.04, red: 0, green: 0, blue: 0);
  Color get selectedOverlay => isDark
      ? const Color.from(alpha: 0.09, red: 1, green: 1, blue: 1)
      : const Color.from(alpha: 0.06, red: 0, green: 0, blue: 0);
  Color get pressedOverlay => isDark
      ? const Color.from(alpha: 0.13, red: 1, green: 1, blue: 1)
      : const Color.from(alpha: 0.10, red: 0, green: 0, blue: 0);

  /// focus ring：2px 实线＋2px offset，深色 #F5F5F7、浅色 #111113，
  /// 禁止蓝色 focus（A §2.5）。
  Color get focusRing =>
      isDark ? const Color(0xFFF5F5F7) : const Color(0xFF111113);

  /// 模态遮罩（A §5 材质）：两端均为 .32（A2 定夺，2026-11-14；
  /// 深色原 .56 超 M3 32% 上限，两端同步改 .32，避免跨端观感不一致）。
  Color get scrim => isDark
      ? const Color.from(alpha: 0.32, red: 0, green: 0, blue: 0)
      : const Color.from(alpha: 0.32, red: 0.067, green: 0.067, blue: 0.075);

  /// 底部 tab 激活 pill：56×32 中性底，8%（A §3.3）。
  Color get tabPill => isDark
      ? const Color.from(alpha: 0.08, red: 1, green: 1, blue: 1)
      : const Color.from(alpha: 0.08, red: 0, green: 0, blue: 0);

  /// 状态点 6px（A §2.7：状态色只做点／线／小标签，面积 ≤3%）。
  static const double statusDotSize = 6;

  // ---- Q1b 边框（定夺 §1.3：深色 #27272A／强边框 #3F3F46；
  // 浅色 #E4E4E7／强边框 #D4D4D8；1px 发丝线，不用透明度叠白） ----
  Color get lineDefault => isDark
      ? const Color(0xFF27272A)
      : const Color(0xFFE4E4E7);
  Color get lineStrong =>
      isDark ? const Color(0xFF3F3F46) : const Color(0xFFD4D4D8);
  Color get lineHover => isDark
      ? const Color(0xFF27272A)
      : const Color(0xFFA1A1AA);

  // ---- Q1b 文字（定夺 §1.3：深色 #F7F7F8/#A1A1AA/#8A8A93/#52525B；
  // 浅色 #09090B/#52525B/#71717A/#A1A1AA。实算见证据报告：主文字深
  // 18.61／浅 19.90（≥12:1）；次文字深 7.78／浅 7.73（≥7:1）；三级
  // 深 #8A8A93 对 #08090A 5.82:1、对卡片 #111113 5.51:1，均过 4.5:1
  // （6 项定夺①：旧深三级 #71717A 仅 4.12／3.90，改为 #8A8A93）；
  // 浅三级 #71717A 4.83 过线，不动。三级只用于短标签／辅助信息、
  // 禁用于长正文（限制保留）） ----
  Color get textPrimary =>
      isDark ? const Color(0xFFF7F7F8) : const Color(0xFF09090B);
  Color get textSecondary =>
      isDark ? const Color(0xFFA1A1AA) : const Color(0xFF52525B);
  Color get textTertiary =>
      isDark ? const Color(0xFF8A8A93) : const Color(0xFF71717A);
  Color get textDisabled =>
      isDark ? const Color(0xFF52525B) : const Color(0xFFA1A1AA);

  // ---- Q1b 状态色（2026-11-15 定稿 B 组，三端唯一口径，见 REDLINES
  // RL-C02；A 组旧值 #30D158／#15803D、#FF9F0A／#B45309、#FF453A 已废止，
  // 仅留历史记录）：
  // 成功绿 #16A34A（浅）／#22C55E（深）、未激活橙 #EA580C（浅）／#FB923C（深）、
  // 登出红 #DC2626（浅）／#F87171（深）；只做功能语义（点／线／浅底／标签），
  // 面积 ≤3%。小字正文一律中性墨色（Q1-2(a)），不直接用状态色写小字。
  // 实算（深色版对深卡 #111113）：绿 8.28／橙 8.33／红 6.82，均过 4.5:1；
  // 浅色版作正文均不达标（绿 3.30／橙 3.56），故小字只走 onCard ----
  Color get success =>
      isDark ? const Color(0xFF22C55E) : const Color(0xFF16A34A);
  Color get danger =>
      isDark ? const Color(0xFFF87171) : const Color(0xFFDC2626);
  Color get warning =>
      isDark ? const Color(0xFFFB923C) : const Color(0xFFEA580C);
  /// 离线／中性状态色（QfStatusPill 离线点用）：两端同一中性灰 #6B7280，
  /// 仅作非文本状态点（对 pill 浅底 ≥3:1：浅色约 4.6:1、深色约 3.9:1，
  /// 见 theme_tokens_test F1 回归断言）；小字正文不走本色，走 onCard。
  Color get statusOffline => const Color(0xFF6B7280);
  /// 信息色（定夺 §3.1）：不用蓝，用中性灰——深 #D4D4D8、浅 #3F3F46。
  Color get info =>
      isDark ? const Color(0xFFD4D4D8) : const Color(0xFF3F3F46);

  /// 通告条（SnackBar）底色：浅色纯黑 #000000（白字 21.00:1），
  /// 深色卡片 #111113（主文字 17.62:1）。
  Color get snackBg =>
      isDark ? const Color(0xFF111113) : const Color(0xFF000000);

  /// 工具栏／顶栏底色（A1 定夺，2026-11-14）：浅色 surface0 #FFFFFF、
  /// 深色卡片 #111113；禁止浅色全宽纯黑顶栏（站长 00:04 令：禁止区块级
  /// 黑白交替）。
  Color get toolbarColor =>
      isDark ? const Color(0xFF111113) : surface0;

  /// 工具栏底部发丝线（定夺边框 token）。
  Color get toolbarBorder => isDark
      ? const Color(0xFF27272A)
      : const Color(0xFFE4E4E7);

  /// 品牌页（启动/断线/强更）底色：与网页端同一令牌底 #FFFFFF / 深色 #08090A。
  Color get pageColor => surface0;

  /// 看护状态行底色（A5 定夺，2026-11-14）：浅色 surface1 #F7F7F8
  ///（字走 textPrimary），深色卡片 #111113（白字）；不再整条纯黑。
  Color get statusLineColor =>
      isDark ? const Color(0xFF111113) : surface1;

  /// 卡片：亮主题白卡 / 深色 #111113（定夺卡片 token）。
  Color get cardColor => isDark ? const Color(0xFF111113) : Colors.white;
  Color get cardBorder => isDark
      ? const Color(0xFF27272A)
      : const Color(0xFFE4E4E7);
  Color get onCard => textPrimary;
  Color get onCardDim => isDark ? const Color(0xFFA1A1AA) : const Color(0xFF52525B);

  /// 品牌标牌面：浅色底用黑牌 #000000 承载、深色底用白牌承载
  /// （三端口径：不许白字标直接上白底；牌内只放 logo 图，无文字）。
  Color get tileFill =>
      isDark ? Colors.white : const Color(0xFF000000);
  Color get tileBorder => isDark
      ? const Color(0xFF27272A)
      : const Color(0xFFE4E4E7);

  /// 顶栏文字／图标色（A1 定夺，2026-11-14）：浅 #09090B、深 #FFFFFF；
  /// 三处顶栏（QfAppHeader／QfPageHeader／“我的”自定义顶栏）的标题、
  /// 图标、右侧小字一律走本 token，禁写死 Colors.white。
  Color get toolbarText =>
      isDark ? Colors.white : const Color(0xFF09090B);
  Color get toolbarIcon =>
      isDark ? Colors.white : const Color(0xFF09090B);

  /// 更新徽标点（A1 定夺，2026-11-14）：浅色 brand（黑）、深色 #FFFFFF；
  /// 不能只用 brand——深色顶栏 #111113 上的黑点会隐形。
  Color get toolbarBadge => isDark ? Colors.white : brand;

  /// 卡片阴影：令牌口径平涂无阴影，恒为空（保留 getter 免改调用点；
  /// 定夺 10：深色全局 shadow token 即 none）。
  /// A 重做 §2.1：列表卡片默认不加阴影，只有浮层才加 elevation——
  /// 浮层走 [elevationShadow]，不要改本 getter。
  List<BoxShadow> get cardShadow => const [];

  /// Elevation 阴影（A §3.0／§5：同一视图最多 3 层——背景→主表面→浮层）：
  /// level 1＝浅色 `0 1px 2px rgba(17,17,19,.06)`，深色无（内高光＋边框承载）；
  /// level 2＝浮层：浅色 `0 8px 24px rgba(17,17,19,.08)`，
  /// 深色 `inset 0 1px 0 rgba(255,255,255,.04)`＋`0 8px 24px rgba(0,0,0,.36)`。
  /// level 0 恒为空。只用于 bottom sheet／对话框／菜单等浮层。
  List<BoxShadow> elevationShadow(int level) {
    if (level <= 0) return const [];
    if (level == 1) {
      if (isDark) return const [];
      return const [
        BoxShadow(
          color: Color.from(alpha: 0.06, red: 0.067, green: 0.067, blue: 0.075),
          offset: Offset(0, 1),
          blurRadius: 2,
        ),
      ];
    }
    if (isDark) {
      return const [
        BoxShadow(
          color: Color.from(alpha: 0.04, red: 1, green: 1, blue: 1),
          offset: Offset(0, 1),
          blurRadius: 0,
        ),
        BoxShadow(
          color: Color.from(alpha: 0.36, red: 0, green: 0, blue: 0),
          offset: Offset(0, 8),
          blurRadius: 24,
        ),
      ];
    }
    return const [
      BoxShadow(
        color: Color.from(alpha: 0.08, red: 0.067, green: 0.067, blue: 0.075),
        offset: Offset(0, 8),
        blurRadius: 24,
      ),
    ];
  }

  /// 家族橙 #FF8A1E 已按定夺删除：定夺调色板里没有橙色，四处原用处
  /// （更新徽标点、锁页加载圈、积分大字、头像橙点）已逐项替换为中性灰
  /// 或最近的定夺状态色，见各调用点注释与证据报告（2026-11-14 修订）。
  /// 任何新代码不许再引橙色。

  /// 探针状态色＝语义状态色 B 组深色值（绿 #22C55E／红 #F87171／
  /// 橙 #FB923C）。保持静态的原因：探针点只落在黑白顶栏上
  /// （浅色顶栏纯黑、深色顶栏 #111113），深色值两端都清晰（对纯黑
  /// 均过 7:1，对 #111113 为 8.28／6.82／8.33），
  /// 不需要随主题换浅色值。
  static const Color probeOk = Color(0xFF22C55E);
  static const Color probeBad = Color(0xFFF87171);
  static const Color probeBusy = Color(0xFFFB923C);

  /// 冻结令牌（2.2.0 与 Win 线同一套）：发丝/正文/次要（已去蓝）。
  /// navy 深蓝 #0B2B5B 已随黑白化删除——顶栏／头像占位改走 toolbarColor
  /// 或主题内亮度判断，不许再引深蓝。
  static const Color hairline = Color(0xFFE4E4E7);
  static const Color textMain = Color(0xFF09090B);
  static const Color textDim = Color(0xFF52525B);

  /// 列表行图标片底色（深色 #111113＝卡片色，浅色分区 #F7F7F8）。
  /// 6 项定夺②灰阶审计合并：深色芯片由 #18181B 并入卡片色 #111113——
  /// 卡片上的芯片隐去（图标仍以主色示），落在页底 #08090A 上的列表行
  /// 芯片仍可见；浅色 #F7F7F8 不动（白卡上须与卡片区分）。
  Color get iconChipColor =>
      isDark ? const Color(0xFF111113) : const Color(0xFFF7F7F8);
}

/// 三端统一标度（排版批1 P30 地基，与网页 app.css :root 同一套数，
/// Q3c 定版后全量引用；2026-11-14 按定夺修订）：
/// 字阶 11/12/13/14/15/16/20/24/29（页面标题 24／区块标题 20／正文
/// 14／标签 12；页面标题与正文比 24/14≈1.71（≥1.6），区块标题与正文比
/// 20/14≈1.43——6 项定夺④接受，不拉到 23px；要强化区块层级用字重／
/// 间距／颜色，不靠放大区块标题）、间距
/// 4/8/12/16/20/24/32/48/64、圆角：Android 卡片／按钮／输入框 12
/// （定夺 §2.3：Android Flutter 可 12px）、小浮层 8、弹窗 16、
/// 气泡 16＋尾角 4（定夺 12，见 QfChat）、Pill 999；
/// 内容封顶 1184（阅读类）/560（弹窗卡类）、最小触摸 44（定夺 §2.1：
/// Android 触控最小 44px）。
/// 旧字号映射（最近档，半档向上）：12.5→13、13.5→14、14.5→15、15.5→16；
/// 17→16、18→20、19→20、27→29。
class QfScale {
  // S-029：字阶补齐 18／22／26（与网页 token fs-18／fs-22／fs-26 同一套数；
  // 旧 QfScale 缺这三档，与 app.css“同一套数”的自称不符）。
  static const double fs11 = 11, fs12 = 12, fs13 = 13, fs14 = 14, fs15 = 15,
      fs16 = 16, fs18 = 18, fs20 = 20, fs22 = 22, fs24 = 24, fs26 = 26,
      fs29 = 29;
  // S-029：间距补齐 sp8=40（网页 --sp-8:40px；旧 QfScale 只有 sp7=32、
  // sp9=48，缺 40 档）。
  static const double sp1 = 4, sp2 = 8, sp3 = 12, sp4 = 16, sp5 = 20,
      sp6 = 24, sp7 = 32, sp8 = 40, sp9 = 48, sp10 = 64;
  static const double rSmall = 8, rCard = 12, rPill = 999;

  /// Win/Android 修复 2026-11-14（A3／A6 定夺）：
  /// 底部 tab 项高 64（1px 顶边用 border 绘制，不占内容布局）；
  /// 卡片内边距 16；全屏状态卡内边距 24；列表顶距 12；列表行纵向 8。
  static const double bottomTabItemHeight = 64;
  static const double cardPadding = 16;
  static const double statusCardPadding = 24;
  static const double listTopGap = 12;
  static const double listRowVertical = 8;

  /// 圆角档：小浮层 8；Android 标准卡片／按钮／输入框 12；弹窗 16。
  static const double radiusSm = 8, radiusMd = 12, radiusLg = 16;
  static const double maxReadWidth = 1184, maxCardWidth = 560;
  static const double dialogMaxWidth = 560;
  static const double minTouch = 44;

  /// 按钮视觉高（黑白化遗留①定夺：按钮／输入框视觉压到 40，触控目标
  /// 另保 ≥44）。只管视觉：主题里 minimumSize 用它；触控由外层
  /// QfButtonTapTarget（44 高点击容器）补足。minTouch 44 不动，
  /// 仍是触控与列表行的下限。
  static const double buttonVisualHeight = 40;

  /// 旧字号就近映射到 QfScale 字阶（半档向上，见类注释）。
  static double nearestFontSize(double v) {
    const steps = [
      fs11, fs12, fs13, fs14, fs15, fs16, fs18, fs20, fs22, fs24, fs26, fs29,
    ];
    var best = steps.first;
    var bestDist = (v - best).abs();
    for (final s in steps.skip(1)) {
      final d = (v - s).abs();
      // 距离相等时取大档（半档向上）。
      if (d < bestDist || (d == bestDist && s > best)) {
        best = s;
        bestDist = d;
      }
    }
    return best;
  }
}

/// Q1e 动效体系常量（安卓 AnimationController 口径；2026-11-14 按定夺
/// §2.5 修订：微交互 120–180ms、面板／路由 240–320ms、缓动
/// cubic-bezier(.2,.8,.2,1)、页面进入透明度 0→1＋上移 8px、Hover 位移
/// 最多 translateY(-1px），禁弹跳；须支持 reduced motion）。
/// 红线：禁弹跳／视差／滚动劫持／跑马灯／扫描线／网格漂移／HUD／霓虹发光；
/// 动效强调色仅黑白与中性灰。
class QfMotion {
  static const Duration press = Duration(milliseconds: 120);
  static const Duration focus = Duration(milliseconds: 120);
  static const Duration fast = Duration(milliseconds: 160);
  static const Duration hover = Duration(milliseconds: 180);
  static const Duration medium = Duration(milliseconds: 240);
  static const Duration view = Duration(milliseconds: 260);
  static const Duration enter = Duration(milliseconds: 320);
  static const Cubic easeOut = Cubic(0.2, 0.8, 0.2, 1);
  static const double revealOffsetY = 8;

  /// Reduced motion 原生层接线（6 项定夺⑤）：系统“移除动画”由平台通道
  /// 经 WidgetsApp 进入 MediaQuery.disableAnimations（Flutter 侧投影
  /// platformDispatcher.accessibilityFeatures.disableAnimations，见 SDK
  /// media_query.dart）；各动效取值点一律读它，不读主题层开关。
  /// 主题层只能做兜底，不能替代本接线。
  static bool isReducedMotion(BuildContext context) =>
      MediaQuery.disableAnimationsOf(context);

  /// 时长解析：reduced motion 开启时返回 Duration.zero，否则返回原值。
  /// 供 AnimatedContainer 等显式动效调用；路由转场走
  /// QfPageTransitionsBuilder，对话框走 showQfDialog，加载动画走
  /// QfLoadingIndicator／QfLoadingBar（见 ui/reduced_motion.dart）。
  static Duration resolve(BuildContext context, Duration normal) =>
      isReducedMotion(context) ? Duration.zero : normal;

  // ---- B 重做 §0 动效 tokens（2026-11-14，与旧 press/fast/hover/
  // medium/view/enter 常量并存：旧常量有测试断言且仍被看护状态行等
  // 显式动效引用，新组件一律用下面 D/E/S tokens） ----
  // 时长：D0 按压下压 60ms，D1 hover/focus/小元素退出 110ms，
  // D2 控件状态/crossfade 140ms，D3 列表行/弹窗进入 170ms，
  // D4 抽屉/空状态 210ms，D5 页面/路由 250ms，D6 大画布 290ms。
  // 退出通用＝进入 ×0.72，夹在 100–190ms（见 exitDurationFor）。
  static const Duration d0 = Duration(milliseconds: 60);
  static const Duration d1 = Duration(milliseconds: 110);
  static const Duration d2 = Duration(milliseconds: 140);
  static const Duration d3 = Duration(milliseconds: 170);
  static const Duration d4 = Duration(milliseconds: 210);
  static const Duration d5 = Duration(milliseconds: 250);
  static const Duration d6 = Duration(milliseconds: 290);

  /// 对话框退出时长（B §3.3：对话框退出 D2/E-X，130ms±20）。
  /// 不走 exitDurationFor（170×0.72＝122 会落在允差内但不是 B 明示值，
  /// 直接取 B 表值 130ms）。
  static const Duration dialogExit = Duration(milliseconds: 130);

  /// spinner 旋转周期（B §3.3：900ms linear）。
  static const Duration spinnerPeriod = Duration(milliseconds: 900);

  /// 退出时长：进入 ×0.72，夹在 100–190ms（B §0.1）。
  static Duration exitDurationFor(Duration enter) {
    final ms = (enter.inMilliseconds * 0.72).round().clamp(100, 190);
    return Duration(milliseconds: ms);
  }

  // 曲线：E-S 小/中入场，E-L 大面板/页面，E-X 空间退出，
  // E-Q 快速消失（toast/行删除），E-C 同级 crossfade，
  // LIN 旋转/进度/颜色插值（位移禁用），E-OV 仅 toggle/knob 极小过冲。
  static const Cubic eS = Cubic(0.16, 1, 0.3, 1);
  static const Cubic eL = Cubic(0.19, 1, 0.22, 1);
  static const Cubic eX = Cubic(0.32, 0, 0.78, 0.14);
  static const Cubic eQ = Cubic(0.4, 0, 1, 1);
  static const Cubic eC = Cubic(0.22, 1, 0.36, 1);
  static const Cubic eOv = Cubic(0.34, 1.08, 0.64, 1);

  // 位移基准（B §0.3）：行/消息进入 y+8，卡片 y+12，
  // 弹窗 scale .96＋y+8，抽屉 x+32，页面前进 x+24，
  // press scale .985（回弹最多 1.004）。
  static const double rowEnterOffsetY = 8;
  static const double cardEnterOffsetY = 12;
  static const double dialogEnterScale = 0.96;
  static const double dialogEnterOffsetY = 8;
  static const double sheetEnterOffsetY = 32;
  static const double pageEnterOffsetX = 24;
  static const double pressScale = 0.985;
  static const double pressReleaseMaxScale = 1.004;

  // 弹簧（B §4，全表只允许 S5/S6/S7 用在安卓端；页面/路由/弹窗/
  // 对话框/列表增删/toast/保存条/错误 shake/加载进度/空状态禁用弹簧）。
  // S5 bottom sheet 进入/吸附：k380 c36 m1.0 ζ≈0.923；
  // S6 拖拽释放/下拉刷新回位：k300 c34 m1.0 ζ≈0.981，过冲 ≤2dp；
  // S7 PIN 成功点：k600 c40 m0.7 ζ≈0.976，过冲 ≤1px。
  static SpringSimulation springS5() => SpringSimulation(
        const SpringDescription(mass: 1.0, stiffness: 380, damping: 36),
        0,
        1,
        0,
      );
  static SpringSimulation springS6() => SpringSimulation(
        const SpringDescription(mass: 1.0, stiffness: 300, damping: 34),
        0,
        1,
        0,
      );
  static SpringSimulation springS7() => SpringSimulation(
        const SpringDescription(mass: 0.7, stiffness: 600, damping: 40),
        0,
        1,
        0,
      );

  /// B §6.3 reduced motion 降级：取消位移/缩放/弹簧/shake/视差/stagger，
  /// 只保留 80ms 以内 opacity 或 instant（对话框/页面/bottom sheet/
  /// 列表/空状态统一走本值）。
  static const Duration reducedOpacity = Duration(milliseconds: 80);

  /// B §0.3 stagger：密集行 22ms/项，最多 7 项；第 8 项起同组 0 延迟。
  /// reduced motion 时返回 Duration.zero。
  static Duration staggerFor(BuildContext context, int index) {
    if (isReducedMotion(context)) return Duration.zero;
    if (index >= 7) return Duration.zero;
    return Duration(milliseconds: 22 * index);
  }
}

/// 排版系统（A 重做 §2.2／§3.3，字阶固定）：
/// 11/16、12/18、13/20、14/22、16/24、20/28、24/32、28/36；
/// 字重只用 400/500/600（中文页面标题 600，正文 400，表头 500，
/// 禁用 700/800——旧 w700/w800 调用点已随重做改 600）；
/// 标题 20/28 字距 -0.01em，英文小标签 11/16 字距 +0.04em；
/// 数字全部 tabular-nums（见 [tabular]）；正文行宽 60–75 字符；
/// 工具界面正文 14/22，元信息 12/18，不用 12px 以下承载关键信息。
class QfType {
  static TextStyle _s({
    required double size,
    required double height,
    required FontWeight weight,
    required Color color,
    double? letterSpacing,
    List<ui.FontFeature>? fontFeatures,
  }) =>
      TextStyle(
        fontSize: size,
        height: height / size,
        fontWeight: weight,
        color: color,
        letterSpacing: letterSpacing,
        fontFeatures: fontFeatures,
      );

  /// 数字等宽（tabular-nums）：在已有 style 上叠加 tabular figures。
  static TextStyle tabular(TextStyle s) => s.copyWith(
        fontFeatures: const [ui.FontFeature.tabularFigures()],
      );

  static TextStyle label11(Color c, {FontWeight w = FontWeight.w500}) =>
      _s(size: 11, height: 16, weight: w, color: c, letterSpacing: 0.44);

  /// 底部 tab 标签 12/16 字距 +0.44（A3 定夺，2026-11-14；M3 12sp 下限，
  /// 11px 不达标）；选中 w600 由调用方（A8）控制，默认 w500。
  static TextStyle label12(Color c, {FontWeight w = FontWeight.w500}) =>
      _s(size: 12, height: 16, weight: w, color: c, letterSpacing: 0.44);
  static TextStyle meta12(Color c, {FontWeight w = FontWeight.w400}) =>
      _s(size: 12, height: 18, weight: w, color: c);
  static TextStyle meta13(Color c, {FontWeight w = FontWeight.w400}) =>
      _s(size: 13, height: 20, weight: w, color: c);
  static TextStyle body14(Color c, {FontWeight w = FontWeight.w400}) =>
      _s(size: 14, height: 22, weight: w, color: c);
  static TextStyle title16(Color c, {FontWeight w = FontWeight.w600}) =>
      _s(size: 16, height: 24, weight: w, color: c);
  static TextStyle title20(Color c, {FontWeight w = FontWeight.w600}) =>
      _s(size: 20, height: 28, weight: w, color: c, letterSpacing: -0.2);
  static TextStyle title24(Color c, {FontWeight w = FontWeight.w600}) =>
      _s(size: 24, height: 32, weight: w, color: c, letterSpacing: -0.24);
  static TextStyle title28(Color c, {FontWeight w = FontWeight.w600}) =>
      _s(size: 28, height: 36, weight: w, color: c, letterSpacing: -0.28);
}

/// Q4 聊天 token（定夺 11–15；以下均为深色 token，聊天区不使用玻璃、
/// 无阴影）。
/// ⚠ 仅深色可用：本类全部 token 都是写死的深色值，没有浅色版；原生聊天
/// 若要在浅色主题复用，必须先补一套浅色版 token，不许直接引用本类——
/// 否则浅色下对方气泡／输入行会是深色块（与 A4 同类问题，见 A8）。
/// 落地说明：安卓原生层无聊天 widgets——会话列表／气泡／输入行均在
/// 好友槽 WebView 内的网页聊天页渲染，视觉由 Q3a 网页端 tokens 承载；
/// 本类把 Q4 的值钉在原生主题出口，供测试断言与日后原生聊天复用，
/// 壳层只保留槽位容器与返回键行为（不动）。
class QfChat {
  // 会话列表项：行高 64（390px 档 60）、内边距 12、头像-内容间距 12、项间距 4、圆角 8。
  static const double listRowMinHeight = 64;
  static const double listRowMinHeightCompact = 60;
  static const double listRowPadding = 12;
  static const double listRowGap = 12;
  static const double listRowSpacing = 4;
  // 头像 36×36（390px 档 32），radius 999，bg #111113，边框白 5%，文字 12/16 #A1A1AA。
  static const double avatarSize = 36;
  static const double avatarSizeCompact = 32;
  static const Color avatarBg = Color(0xFF111113);
  // rgba(255,255,255,.05)：用 Color.from 保真 0.05（0x0DFFFFFF 是 13/255≈0.051）。
  static const Color avatarBorder =
      Color.from(alpha: 0.05, red: 1, green: 1, blue: 1);
  static const Color avatarText = Color(0xFFA1A1AA);
  // 在线点 10px #22C55E（B 组成功绿深色值），描边 2px #111113。
  static const double onlineDotSize = 10;
  static const Color onlineDot = Color(0xFF22C55E);
  static const Color onlineDotStroke = Color(0xFF111113);
  // 名称／摘要 15/20（定夺 15：聊天专用收紧行高）。
  static const double nameFontSize = 15;
  static const double summaryFontSize = 15;
  // 未读 badge：高 18、最小宽 18、padding 0 6px、radius 999、白底、黑字 Mono 12/16。
  // 黑白化：badgeBg 白、badgeText #111111（18.88:1；旧白字落白底仅 1.0:1，
  // 若只改底不改字会隐形——两处须同改）。
  static const double badgeHeight = 18;
  static const double badgeMinWidth = 18;
  static const double badgePaddingH = 6;
  static const Color badgeBg = Color(0xFFFFFFFF);
  static const Color badgeText = Color(0xFF000000);
  // 消息气泡：16px＋尾角 4px（定夺 12）；己方白底右对齐／对方深灰左对齐；
  // 己方边框白 5%（定夺 14），对方边框 #23252A；文字 15/22；内边距 10px 14px。
  // 注意：本类为深色 token；己方气泡改白底后，网页聊天渲染侧须配黑字，
  // 原生层无聊天 widgets，此处只钉 token 值（见报告跟进项）。
  static const double bubbleRadius = 16;
  static const double bubbleTailRadius = 4;
  static const double bubblePaddingV = 10;
  static const double bubblePaddingH = 14;
  static const double bubbleFontSize = 15;
  static const Color bubbleMineBg = Color(0xFFFFFFFF);
  static const Color bubbleMineBorder =
      Color.from(alpha: 0.05, red: 1, green: 1, blue: 1);
  static const Color bubbleOtherBg = Color(0xFF111113);
  static const Color bubbleOtherBorder = Color(0xFF27272A);
  // 最大宽：桌面 min(560px,68%)；390px min(78vw,520px)。组间距：同人 8、异人 16。
  static const double bubbleMaxWidthDesktop = 560;
  static const double bubbleMaxWidthDesktopFrac = 0.68;
  static const double bubbleMaxWidthMobileFrac = 0.78;
  static const double groupGapSame = 8;
  static const double groupGapDifferent = 16;
  // 时间戳 12/16 #8A8A93 Mono，气泡外下方 margin-top 4px。
  // 深色三级，随 6 项定夺①由 #71717A 改 #8A8A93（对气泡底 #111113
  // 5.51:1；仅短标签／辅助信息，禁长正文）。
  static const double timestampFontSize = 12;
  static const Color timestampColor = Color(0xFF8A8A93);
  // 输入行：composer 圆角 16（定夺 11，聊天专用）、min-height 44（390px 档 40）、
  // max-height 120（390px 档 96）、bg #141516、边框 #23252A；发送按钮 40×40 pill。
  static const double composerRadius = 16;
  static const double composerMinHeight = 44;
  static const double composerMinHeightCompact = 40;
  static const double composerMaxHeight = 120;
  static const double composerMaxHeightCompact = 96;
  static const Color composerBg = Color(0xFF111113);
  static const Color composerBorder = Color(0xFF27272A);
  static const double sendButtonSize = 40;
  static const double sendIconSize = 18;
  // 加密提示：12/16 #8A8F98，锁图标 12px，无背景、无边框、不可点击。
  static const double e2eFontSize = 12;
  static const Color e2eColor = Color(0xFFA1A1AA);
  static const double e2eIconSize = 12;
  // 动效：新消息入场 180ms／translateY(6px)→0；自动滚底 240ms。
  static const Duration entryDuration = Duration(milliseconds: 180);
  static const double entryOffsetY = 6;
  static const Duration scrollDuration = Duration(milliseconds: 240);
}

/// Reduced motion 路由转场（6 项定夺⑤）：开启时直接返回子页面，零时长、
/// 零位移；关闭时走 B §3.3 安卓页面切换——前进 D5=250ms／E-L／x+24＋
/// opacity，被盖住的旧页 x-16 退出；后退反向，退出 D3=170ms／E-X。
/// 时长直接由本 builder 的 transitionDuration／reverseTransitionDuration
/// 提供（MaterialPageRoute 向 theme 的 builder 取时长，见 SDK
/// `material/page.dart:91-98`），全仓 MaterialPageRoute push 点
/// 无需逐个改路由类。
/// 系统预测返回手势（predictive back）仍由 Navigator／路由层承载：
/// 本 builder 只按 route animation 的值做位移＋透明度，不拦截手势、
/// 不自写返回逻辑；手势拖动时 animation 由系统驱动，页面跟手。
class QfPageTransitionsBuilder extends PageTransitionsBuilder {
  const QfPageTransitionsBuilder();

  /// B §3.3：页面前进 D5=250ms。
  @override
  Duration get transitionDuration => QfMotion.d5;

  /// B §3.3：页面退出 D3=170ms（E-X）。
  @override
  Duration get reverseTransitionDuration => QfMotion.d3;

  @override
  Widget buildTransitions<T>(
    PageRoute<T> route,
    BuildContext context,
    Animation<double> animation,
    Animation<double> secondaryAnimation,
    Widget child,
  ) {
    if (MediaQuery.disableAnimationsOf(context)) return child;
    final width = MediaQuery.of(context).size.width;
    // 前进 x+24（像素转 Offset 分数）；后退时同一 Tween 反向回 +24，
    // 即退出向右，符合 B §5“后退反向”。
    final enter = Tween<Offset>(
      begin: Offset(QfMotion.pageEnterOffsetX / width, 0),
      end: Offset.zero,
    ).animate(CurvedAnimation(
      parent: animation,
      curve: QfMotion.eL,
      reverseCurve: QfMotion.eX,
    ));
    // 被新页盖住时旧页 x-16 退出（B §3.3 安卓行）；被揭开时反向回位。
    final covered = Tween<Offset>(
      begin: Offset.zero,
      end: const Offset(-16 / 390, 0),
    ).animate(CurvedAnimation(
      parent: secondaryAnimation,
      curve: QfMotion.eL,
      reverseCurve: QfMotion.eX,
    ));
    // 注意：-16px 按 390px 基准屏宽折成分数；宽屏上绝对位移略小，
    // 方向与量级不变，不按实时屏宽放大（避免平板上退出位移过大）。
    return SlideTransition(
      position: covered,
      child: SlideTransition(
        position: enter,
        child: FadeTransition(opacity: animation, child: child),
      ),
    );
  }
}

/// 唯一主题出口：两套 ThemeData 工厂（QfTheme.dark/light）。
/// Material 层控件（按钮／弹窗／输入框／开关／菜单／通告）统一样式收口；
/// 壳内自绘面（顶栏／卡片／列表行）仍走 QfPalette 令牌，口径一致。
class QfTheme {
  static ThemeData dark() => _build(const QfPalette(QfThemeMode.dark));
  static ThemeData light() => _build(const QfPalette(QfThemeMode.blue));

  static ThemeData _build(QfPalette p) {
    final onCard = p.onCard;
    final onCardDim = p.onCardDim;
    final radiusMd = BorderRadius.circular(QfScale.radiusMd);
    final radiusLg = BorderRadius.circular(QfScale.radiusLg);
    return ThemeData(
      // A 重做 §3.3：Material 3 自定义 ColorScheme，primary 直接映射到
      // 主文字黑／白（浅 #09090B／深 #F7F7F8），不用 fromSeed 推导——
      // fromSeed 会按色调推导 primary（≠主色原值），且种子色路径上
      // 可能带出蓝调；品牌蓝已退役，全 scheme 无蓝。
      colorScheme: ColorScheme(
        brightness: p.isDark ? Brightness.dark : Brightness.light,
        primary: p.textPrimary,
        onPrimary: p.isDark ? const Color(0xFF000000) : const Color(0xFFFFFFFF),
        secondary: p.textSecondary,
        onSecondary: p.textPrimary,
        error: p.danger,
        onError: p.isDark ? const Color(0xFF000000) : const Color(0xFFFFFFFF),
        surface: p.surface0,
        onSurface: p.textPrimary,
        surfaceContainerHighest: p.bg2,
        outline: p.lineDefault,
        outlineVariant: p.lineDefault,
      ),
      useMaterial3: true,
      scaffoldBackgroundColor: p.pageColor,
      // 6 项定夺⑤：安卓路由转场走 QfPageTransitionsBuilder（reduced
      // motion 时零时长直出）；其余平台不写，沿用 Flutter 默认。
      pageTransitionsTheme: const PageTransitionsTheme(
        builders: <TargetPlatform, PageTransitionsBuilder>{
          TargetPlatform.android: QfPageTransitionsBuilder(),
        },
      ),
      textTheme: TextTheme(
        bodyMedium: TextStyle(fontSize: QfScale.fs14, color: onCard),
        bodySmall: TextStyle(fontSize: QfScale.fs12, color: onCardDim),
        titleMedium: TextStyle(
            fontSize: QfScale.fs16, fontWeight: FontWeight.w600, color: onCard),
        titleLarge: TextStyle(
            fontSize: QfScale.fs20, fontWeight: FontWeight.w600, color: onCard),
        labelLarge: TextStyle(
            fontSize: QfScale.fs14, fontWeight: FontWeight.w600, color: onCard),
      ),
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          backgroundColor: p.brand,
          foregroundColor: p.onBrand,
          // A3：禁用字原 textDisabled 浅色只有 1.92，改 onCardDim（浅色 5.21）。
          disabledForegroundColor: p.onCardDim,
          // 6 项定夺②：禁用底不用 surface3 #18181B（长下载时禁用钮常驻同屏，
          // 会多出第 7 个灰阶），并入卡片边框色 lineDefault（本页已计数）；
          // 浅色由 #FFFFFF 改 #E4E4E7，禁用钮在白卡上反而更可见。
          disabledBackgroundColor: p.lineDefault,
          // 遗留①：视觉压到 40（实测 Flutter 3.47.8 默认 padded 会把盒高
          // 顶到 48，故改 shrinkWrap；命中区由外层 QfButtonTapTarget 补到 44）。
          minimumSize: const Size(0, QfScale.buttonVisualHeight),
          tapTargetSize: MaterialTapTargetSize.shrinkWrap,
          padding: const EdgeInsets.symmetric(horizontal: QfScale.sp4),
          textStyle: const TextStyle(
              fontSize: QfScale.fs15, fontWeight: FontWeight.w600),
          shape: RoundedRectangleBorder(borderRadius: radiusMd),
        ),
      ),
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          foregroundColor: onCard,
          // 6 项定夺②：禁用描边字用实色 onCardDim（不用 Flutter 默认的
          // 38% 半透明 onSurface，避免渲染出未计数的灰阶；关于页“检查更
          // 新”钮检查中禁用即走此值）。
          disabledForegroundColor: p.onCardDim,
          // 6 项定夺②灰阶审计合并：描边边框与卡片边框二选一，描边并入
          // lineDefault（旧 lineStrong #3F3F46／#D4D4D8 只剩 token 定义，
          // 常驻界面不再出现；focus 态描边仍走 brand，不计入常驻）。
          side: BorderSide(color: p.lineDefault),
          // 遗留①：与 FilledButton 同口径——视觉 40＋shrinkWrap，
          // 命中区由外层 QfButtonTapTarget 补到 44。
          minimumSize: const Size(0, QfScale.buttonVisualHeight),
          tapTargetSize: MaterialTapTargetSize.shrinkWrap,
          padding: const EdgeInsets.symmetric(horizontal: QfScale.sp4),
          textStyle: const TextStyle(
              fontSize: QfScale.fs15, fontWeight: FontWeight.w600),
          shape: RoundedRectangleBorder(borderRadius: radiusMd),
        ),
      ),
      textButtonTheme: TextButtonThemeData(
        style: TextButton.styleFrom(
          foregroundColor: p.textSecondary,
          // 遗留①：TextButton 主题原无 minimumSize，实测视觉 48（padded
          // 地板）；补视觉 40＋shrinkWrap，与主／描边按钮同一口径。
          minimumSize: const Size(0, QfScale.buttonVisualHeight),
          tapTargetSize: MaterialTapTargetSize.shrinkWrap,
          textStyle: const TextStyle(
              fontSize: QfScale.fs15, fontWeight: FontWeight.w500),
          shape: RoundedRectangleBorder(borderRadius: radiusMd),
        ),
      ),
      iconButtonTheme: IconButtonThemeData(
        style: IconButton.styleFrom(
          shape: RoundedRectangleBorder(borderRadius: radiusMd),
        ),
      ),
      dialogTheme: DialogThemeData(
        backgroundColor: p.cardColor,
        surfaceTintColor: Colors.transparent,
        // A §5 材质遮罩：浅 rgba(17,17,19,.32)／深 rgba(0,0,0,.56)。
        barrierColor: p.scrim,
        // B §3.3 对话框：宽 min(280, 屏宽-48) 至 560（C §1.3），
        // 圆角 16（A §3.0 抽屉/模态档）；内边距 24 由调用方 contentPadding 承接。
        shape: RoundedRectangleBorder(borderRadius: radiusLg),
        titleTextStyle: TextStyle(
            fontSize: QfScale.fs20, fontWeight: FontWeight.w600, color: onCard),
        contentTextStyle:
            TextStyle(fontSize: QfScale.fs14, color: onCard, height: 1.5),
      ),
      cardTheme: CardThemeData(
        color: p.cardColor,
        elevation: 0,
        shape: RoundedRectangleBorder(borderRadius: radiusMd),
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: p.surface0,
        // 遗留①：纵向 contentPadding 由 sp4=16 改 sp2=8；
        // 实测：光改 padding 到不了 40——InputDecorator 对非 dense 输入框
        // 有硬地板 minContainerHeight=kMinInteractiveDimension=48
        // （SDK input_decorator.dart），故必须同时 isDense: true
        // （地板改回输入自身高度），视觉才为 8+8+24=40。
        // 这是定夺算式在此 Flutter 版本（3.47.8）成立的唯一补件。
        isDense: true,
        contentPadding: const EdgeInsets.symmetric(
            horizontal: QfScale.sp3, vertical: QfScale.sp2),
        // A3：hint 原 textDisabled 浅色只有 1.92，改 onCardDim（浅色 4.85）。
        hintStyle: TextStyle(fontSize: QfScale.fs16, color: p.onCardDim),
        border: OutlineInputBorder(
            borderRadius: radiusMd, borderSide: BorderSide(color: p.lineDefault)),
        enabledBorder: OutlineInputBorder(
            borderRadius: radiusMd, borderSide: BorderSide(color: p.lineDefault)),
        focusedBorder: OutlineInputBorder(
            borderRadius: radiusMd,
            borderSide: BorderSide(color: p.brand, width: 1.5)),
        errorBorder: OutlineInputBorder(
            borderRadius: radiusMd, borderSide: BorderSide(color: p.danger)),
        focusedErrorBorder: OutlineInputBorder(
            borderRadius: radiusMd, borderSide: BorderSide(color: p.danger)),
      ),
      snackBarTheme: SnackBarThemeData(
        backgroundColor: p.snackBg,
        contentTextStyle:
            const TextStyle(fontSize: QfScale.fs14, color: Color(0xFFF7F7F8)),
        shape: RoundedRectangleBorder(borderRadius: radiusMd),
        behavior: SnackBarBehavior.floating,
      ),
      switchTheme: SwitchThemeData(
        thumbColor: WidgetStateProperty.resolveWith(
          (states) => states.contains(WidgetState.selected)
              ? p.brand
              : null,
        ),
        // 6 项定夺②：选中轨道不用半透明 brand（40% brand 叠在页底上会
        // 渲染出第 7 个灰阶），改实色 onCardDim（两端均已在页内计数，
        // 不新增灰阶；拇指仍为 brand，两色可辨）。
        trackColor: WidgetStateProperty.resolveWith(
          (states) => states.contains(WidgetState.selected)
              ? p.onCardDim
              : null,
        ),
      ),
      popupMenuTheme: PopupMenuThemeData(
        color: p.cardColor,
        surfaceTintColor: Colors.transparent,
        shape: RoundedRectangleBorder(borderRadius: radiusMd),
        textStyle: TextStyle(fontSize: QfScale.fs15, color: onCard),
      ),
      dividerTheme: DividerThemeData(
        color: p.lineDefault,
        thickness: 1,
        space: 1,
      ),
      progressIndicatorTheme:
          ProgressIndicatorThemeData(color: p.brand),
    );
  }
}

/// 品牌默认头像占位（全产品统一）：圆盘＋断环＋圆点，断环几何与品牌画法不动。
/// 黑白化（A4 定夺，2026-11-14）：浅色改中性灰盘 #E4E4E7＋深灰环／点
/// #71717A（白底 hero 卡里不再过抢）；深色白盘黑环保持不动。
/// 没有真实头像时一律用它，不许用系统默认人像或灰色剪影。
class QfAvatarPlaceholder extends StatelessWidget {
  final double size;
  const QfAvatarPlaceholder({super.key, this.size = 40});

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
          color: isDark ? Colors.white : const Color(0xFFE4E4E7),
          shape: BoxShape.circle),
      child: CustomPaint(
          painter: _AvatarMarkPainter(
              ringColor:
                  isDark ? const Color(0xFF000000) : const Color(0xFF71717A)),
          size: Size(size, size)),
    );
  }
}

class _AvatarMarkPainter extends CustomPainter {
  final Color ringColor;
  const _AvatarMarkPainter({required this.ringColor});

  @override
  void paint(Canvas canvas, Size size) {
    final c = Offset(size.width / 2, size.height / 2);
    final r = size.width * 0.30;
    final ring = Paint()
      ..color = ringColor
      ..style = PaintingStyle.stroke
      ..strokeWidth = size.width * 0.075
      ..strokeCap = StrokeCap.round;
    // 断环：留出右上缺口放橙点（与品牌标志同一画法）。
    canvas.drawArc(
      Rect.fromCircle(center: c, radius: r),
      0.9,
      5.1,
      false,
      ring,
    );
    // 定夺修订：橙点改为与断环同色（单色化，见类注释）。
    final dot = Paint()..color = ringColor;
    canvas.drawCircle(
      Offset(c.dx + r * 0.78, c.dy - r * 0.78),
      size.width * 0.085,
      dot,
    );
  }

  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}

/// 列表行（全产品统一）：中性灰图标片＋标题＋右箭头，整行可点。
/// A 重做 §3.3／C §1.3：行高 56（minHeight 56，触控热区 ≥48 另由
/// QfButtonTapTarget/行本身保证）；标题 16/24/600，副标题 12/18 次级；
/// selected 时背景 selectedOverlay＋左侧 2px inset bar（A §2.5），
/// 不只变色；press 走 InkWell（D0 60ms 下压语义由 Material 涟漪承载，
/// 不另加 scale——行级 press 禁用弹跳，见 B §3.3）。
class QfListRow extends StatelessWidget {
  final QfPalette palette;
  final IconData icon;
  final String title;
  final String? subtitle;
  final VoidCallback? onTap;
  final bool selected;

  const QfListRow({
    super.key,
    required this.palette,
    required this.icon,
    required this.title,
    this.subtitle,
    this.onTap,
    this.selected = false,
  });

  @override
  Widget build(BuildContext context) {
    final p = palette;
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(QfScale.radiusMd),
      child: Container(
        constraints: const BoxConstraints(minHeight: 56),
        decoration: BoxDecoration(
          color: selected ? p.selectedOverlay : null,
          border: selected
              ? Border(left: BorderSide(color: p.brand, width: 2))
              : null,
        ),
        padding: const EdgeInsets.symmetric(
            horizontal: QfScale.sp3, vertical: QfScale.sp2),
        child: Row(
          children: [
            Container(
              width: 36,
              height: 36,
              decoration: BoxDecoration(
                color: p.iconChipColor,
                borderRadius: BorderRadius.circular(QfScale.radiusMd),
              ),
              child: Icon(icon, size: 20, color: p.brand),
            ),
            const SizedBox(width: QfScale.sp3),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(title,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: QfType.title16(p.onCard)),
                  if (subtitle != null) ...[
                    const SizedBox(height: 2),
                    Text(subtitle!,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: QfType.meta12(p.textSecondary)),
                  ],
                ],
              ),
            ),
            Icon(Icons.chevron_right, size: 20, color: p.onCardDim),
          ],
        ),
      ),
    );
  }
}

/// 状态 chip（A §2.7／C §2.4）：11/16＋1px 边＋8% 底＋6px 状态点＋文字，
/// 不做整块绿/红填充；状态色只做点/线/小标签，面积 ≤3%。
class QfStatusChip extends StatelessWidget {
  final QfPalette palette;
  final String label;
  final Color dotColor;

  const QfStatusChip({
    super.key,
    required this.palette,
    required this.label,
    required this.dotColor,
  });

  @override
  Widget build(BuildContext context) {
    final p = palette;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
      decoration: BoxDecoration(
        color: p.selectedOverlay,
        borderRadius: BorderRadius.circular(QfScale.rPill),
        border: Border.all(color: p.lineDefault),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            width: QfPalette.statusDotSize,
            height: QfPalette.statusDotSize,
            decoration: BoxDecoration(color: dotColor, shape: BoxShape.circle),
          ),
          const SizedBox(width: 6),
          Text(label, style: QfType.label11(p.onCard)),
        ],
      ),
    );
  }
}

/// 骨架行（C §1.1／§2.2）：镜像最终布局——列表行 56、头像 32 圆、
/// 文本条 60%/40%；静态灰条，不做渐变 shimmer（B 禁项），
/// 不冒充内容；reduced motion 下同样静态。
class QfSkeletonRow extends StatelessWidget {
  final QfPalette palette;
  final bool withAvatar;

  const QfSkeletonRow({super.key, required this.palette, this.withAvatar = true});

  @override
  Widget build(BuildContext context) {
    final p = palette;
    return SizedBox(
      height: 56,
      child: Row(
        children: [
          if (withAvatar) ...[
            Container(
              width: 32,
              height: 32,
              decoration: BoxDecoration(color: p.bg2, shape: BoxShape.circle),
            ),
            const SizedBox(width: 12),
          ],
          Expanded(
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                FractionallySizedBox(
                  widthFactor: 0.6,
                  child: Container(height: 12, color: p.bg2),
                ),
                const SizedBox(height: 8),
                FractionallySizedBox(
                  widthFactor: 0.4,
                  child: Container(height: 12, color: p.bg2),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// 错误行（C §1.3／§2.5）：6px 红点＋12/18 错误文案，不只变色；
/// 错误文案须含错误码或规则（调用方传入已含码的文案）。
/// 文案颜色走中性墨色 onCard（Q1-2(a)，R-A6），状态色只用于 6px 红点。
class QfErrorLine extends StatelessWidget {
  final QfPalette palette;
  final String text;

  const QfErrorLine({super.key, required this.palette, required this.text});

  @override
  Widget build(BuildContext context) {
    final p = palette;
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Container(
          width: QfPalette.statusDotSize,
          height: QfPalette.statusDotSize,
          margin: const EdgeInsets.only(top: 6),
          decoration: BoxDecoration(color: p.danger, shape: BoxShape.circle),
        ),
        const SizedBox(width: 8),
        // R-A6：12px 错误正文走中性墨色 onCard，不直接用状态色写小字；
        // 6px 红点保留作非颜色提示。
        Expanded(child: Text(text, style: QfType.meta12(p.onCard))),
      ],
    );
  }
}

/// 主题按钮视觉已压到 40（shrinkWrap），自身命中区只剩 40，不够 44；
/// 外套本容器把命中区补到 44，视觉仍 40。
/// 实现：上下各 2px 透明条带（Padding 只改纵向尺寸，不动横向约束，
/// 全宽按钮仍全宽、 intrinsic 按钮仍按内容宽）；点条带时外层
/// GestureDetector 把点击转给内层按钮的 onPressed；点按钮本体时按钮
/// 自己响应（手势竞技场里子按钮的 InkWell 优先，外层不重复触发——
/// 见 button_input_visual_height_test.dart 的单次触发断言）。
/// 禁用按钮（onPressed 为 null）外层也不接点击。
/// 用法：直接包在按钮构造外面（QfButtonTapTarget(child: FilledButton(…))），
/// 放在 SizedBox/Expanded 等宽度容器里面，不要包在外面。
/// 按钮 44px 触控容器（黑白化遗留①定夺）：
class QfButtonTapTarget extends StatelessWidget {
  const QfButtonTapTarget({super.key, required this.child});

  final Widget child;

  static VoidCallback? _onPressedOf(Widget w) {
    if (w is FilledButton) return w.onPressed;
    if (w is OutlinedButton) return w.onPressed;
    if (w is TextButton) return w.onPressed;
    return null;
  }

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: _onPressedOf(child),
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 2),
        // Padding 只纵向加 2+2，横向约束原样透传给按钮。
        child: child,
      ),
    );
  }
}

/// 输入框 44px 触控容器（黑白化遗留①定夺）：
/// 输入框视觉已压到 40（主题 contentPadding 纵向 8），自身命中区只有
/// 约 40，不够 44；外套本容器把命中区补到 44（上下各 2px），视觉仍 40。
/// 点条带时外层 GestureDetector 对本容器持有的 FocusNode 调
/// requestFocus()，键盘／光标正常进场；点输入框本体时输入框自己响应。
/// 用法：QfTextFieldTapTarget(builder: (node) => TextField(focusNode: node, …))。
/// 全 app 没有统一输入框封装处（7 处 TextField 分散在 lock.dart、
/// license_gate.dart、license_section.dart，各自带局部 padding），故用
/// 这一个共享容器逐处套用，不遍地开花。
class QfTextFieldTapTarget extends StatefulWidget {
  const QfTextFieldTapTarget({super.key, required this.builder});

  final Widget Function(FocusNode focusNode) builder;

  @override
  State<QfTextFieldTapTarget> createState() => _QfTextFieldTapTargetState();
}

class _QfTextFieldTapTargetState extends State<QfTextFieldTapTarget> {
  final FocusNode _node = FocusNode();

  @override
  void dispose() {
    _node.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: _node.requestFocus,
      child: ConstrainedBox(
        // minHeight 强制 44：输入框自身若矮于 40（如 14px 字号的 37），
        // 光靠上下各 2px 也到不了 44；Center 把输入框在 44 里居中。
        // 松约束父级（Column／对话框）下盒高即 44；紧约束父级跟随父级。
        constraints: const BoxConstraints(minHeight: QfScale.minTouch),
        child: Center(child: widget.builder(_node)),
      ),
    );
  }
}
