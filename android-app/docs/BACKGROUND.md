# 安卓端后台分级（A-01/A-02，2026-11-15）

> “在线心跳/待命唤醒”与“正在远程会话”是两回事，前者绝不能用常驻前台服务
> 硬扛，后者才配前台服务＋明确类型。三档绝不混用。

## 三档

| 档 | 触发 | 实现 | 状态 |
|---|---|---|---|
| 1 唤醒信号 | 推送到达 | 推送只发信号、不带正文，收到后由端内再拉取。QFRemote 安卓端目前未接 FCM（国内大量无 GMS 设备）：无推送通道时本档为空转，直接落到第二档兜底，绝不静默失联（Element X 无推送即失联是反面教材）。 | 接口已定（`BackgroundScheduler.onWakeSignal`），FCM 接入待定 |
| 2 周期同步 | 系统调度 | 最短 15 分钟（WorkManager 下限，不许更短）；约束仅 Wi-Fi/充电/电量不低；Dart 侧绝不自己起 Timer 轮询。离线改动同步走 outbox 排空（A-05），触发点是回前台/网络恢复。 | Dart 侧调度器接口＋Fake 已落地；原生 WorkManager 接线待 L7 真机窗口（须 workmanager 插件＋Manifest 注册＋真机耗电回归），见下 |
| 3 正在会话 | 会话进行态 | 类型明确的前台服务 `QfSessionService`（`specialUse`，Android 8.0+ 在 `onCreate()` 里立即 `startForeground()`）；通知渠道集中管理（`NotificationChannels`，会话/同步/提醒三渠道）；会话结束即停。WakeLock 只作瞬时唤醒（远程输入到达时亮屏 5 秒，用完即放）。 | 已落地（Kotlin＋桥接＋main.dart 接线） |

## 待办（L7 真机窗口，不在本轮冒充完成）

- 原生 WorkManager 接线：加 `workmanager` 插件、Dart 侧 `callbackDispatcher`、
  Manifest 注册、15 分钟周期任务注册＋去重；真机测 Doze 下是否准时、耗电量。
- 真机验：Android 14+ 前台服务类型声明、通知渠道文案、切后台后服务是否被杀、
  各厂商电池优化表现（Doze 白名单引导须自己实测）。
