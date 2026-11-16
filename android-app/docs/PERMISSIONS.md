# 安卓端权限清单（A-03，2026-11-15）

> 口径：先做一张清单逐项问“能不能不要”；运行时权限只留真正需要的 2–3 个；
> 所有申请收敛到一个集中权限服务类（`lib/app/permissions/permission_service.dart`）；
> 被永久拒绝时在应用内写清“去设置 → 权限 → 打开 XX”并给直达按钮；
> 宽泛存储权限直接删掉走 SAF；悬浮窗/无障碍这类“要去设置里开”的权限单独做
> 带跳转按钮的引导页；可选权限只在用户第一次点对应功能时才弹。

## 安装时授权（不弹框）

| 权限 | 用途 | 能不能不要 |
|---|---|---|
| INTERNET | 联网 | 不能（核心） |
| ACCESS_NETWORK_STATE | 探活/断网判断 | 不能 |
| WAKE_LOCK | 会话常亮＋远程输入瞬时亮屏 5 秒 | 不能（瞬时持有，用完即放） |
| FOREGROUND_SERVICE / FOREGROUND_SERVICE_SPECIAL_USE / FOREGROUND_SERVICE_DATA_SYNC | 正在会话的前台服务（A-02） | 不能 |
| REQUEST_INSTALL_PACKAGES | 应用内更新：下载完 APK 拉起系统安装 | 不能（官网直下版更新链） |

## 运行时授权（真正需要的，仅 1 个）

| 权限 | 用途 | 申请时机 |
|---|---|---|
| POST_NOTIFICATIONS（Android 13+） | 前台服务通知＋被控端上线/离线提醒 | 首次进入会话前（不在首屏全弹）；被拒过一次先看一句话解释再弹系统框；被永久拒绝时显示去设置文字路径＋直达按钮 |

## 接线状态（R1，2026-11-15）

已接线：`QfBridgePermissionService`（`lib/app/permissions/qf_bridge_permission_service.dart`，
走 QfBridge `permissions.` 域调原生 MainActivity）＋ `NotificationPermissionFlow`
（`lib/app/permissions/notification_permission_flow.dart`，会话启动编排）；
`main.dart` 的 `_setKeepScreenOnForSession(true)`（会话启动段，前台服务起之前）
调 `_ensureSessionNotificationPermission()`，不 await（前台服务不等弹窗），
流程 fail-open、任何一步失败都不挡会话。注意：原生 `status` 在首次申请前也回
`permanently_denied`（rationale 为 false），流程先 request 一次再判永久拒绝，
不得仅凭 status 就弹设置路径。真机弹窗（首次使用系统框、永久拒绝去设置路径）
待 ECS／真机验，见 evidence-deep-review-20261115/WIRING-R1-PERMISSIONS.md。

## 已删走（不声明）

- `READ_EXTERNAL_STORAGE` / `WRITE_EXTERNAL_STORAGE` /
  `MANAGE_EXTERNAL_STORAGE`：宽泛存储权限一律不声明，文件传输走 SAF 系统选择器
  （RustDesk 同款 `tools:node="remove"` 口径）。

## 未要（可选增强，点功能时才申请）

| 权限 | 用途 | 说明 |
|---|---|---|
| RECORD_AUDIO（麦克风） | 语音通话 | 只在用户第一次点语音功能时才弹 |
| SYSTEM_ALERT_WINDOW（悬浮窗） | 悬浮控制球 | 特殊权限：单独引导页＋跳设置按钮 |
| BIND_ACCESSIBILITY_SERVICE（无障碍） | 被控端输入注入 | 特殊权限：单独引导页＋跳设置按钮 |
| REQUEST_IGNORE_BATTERY_OPTIMIZATIONS | 电池优化白名单 | 特殊权限：应用内提示＋一键跳转，并说明“不开会被系统杀”的代价；各厂商表现不同，须真机实测，不以“某某也这么做”为依据 |

## 永久拒绝的文字路径（唯一出处）

见 `permissionSettingsPathText()`（`lib/app/permissions/permission_service.dart`），
UI 直接取用，不许各处自写文案。
