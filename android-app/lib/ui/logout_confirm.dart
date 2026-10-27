import 'package:flutter/material.dart';

import 'theme.dart';

/// 退出登录确认文案（站长 12:18 拟稿原文，逐字使用，不许改字）。
const String kLogoutConfirmText = '退出后将清除本机保存的登录信息，下次使用需重新登录。是否继续？';

/// 正式「退出登录」确认（追加十）：我的页与设置页共用同一弹窗、同
/// 一句文案、同一个退出收口——点确认才调 [onLogout]（主框架的手动退出
/// 收口：清会话/凭据/记住标记、置手动退出态），点取消什么都不发生。
Future<void> confirmAndLogout(
  BuildContext context, {
  required QfPalette palette,
  required VoidCallback onLogout,
}) async {
  final p = palette;
  final ok = await showDialog<bool>(
    context: context,
    builder: (ctx) => AlertDialog(
      backgroundColor: p.cardColor,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
      title: Text('退出账号',
          style: TextStyle(color: p.onCard, fontSize: 16, fontWeight: FontWeight.w700)),
      content: Text(kLogoutConfirmText,
          style: TextStyle(color: p.onCard, fontSize: 14, height: 1.5)),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(ctx).pop(false),
          child: Text('取消', style: TextStyle(color: p.onCardDim, fontSize: 14)),
        ),
        TextButton(
          onPressed: () => Navigator.of(ctx).pop(true),
          child: const Text('退出',
              style: TextStyle(
                  color: QfPalette.probeBad,
                  fontSize: 14,
                  fontWeight: FontWeight.w700)),
        ),
      ],
    ),
  );
  if (ok == true) onLogout();
}
