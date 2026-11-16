package com.qfremote.android

import android.app.Notification
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat

/**
 * A-01/A-02：正在远程会话的前台服务（第三档，后台分级唯一配前台服务的档）。
 *
 * - Android 8.0+ 在 `onCreate()` 里立即 `startForeground()`（VLC
 *   PlaybackService 模式：不立即前台化会被系统杀掉）。
 * - 类型按实际用途声明：`specialUse`（远程会话保活；Android 14+ 必填，
 *   上架 Play 须在控制台声明用途；本应用官网直下版不受 Play 声明约束，
 *   但类型仍须真实）。
 * - 通知由 [NotificationChannels.SESSION] 渠道发，文案固定
 *   “正在远程会话”，不带业务内容。
 * - 会话结束即 `stopSelf()` 降级/停止，不常驻持有；WakeLock 只作瞬时唤醒
 *   （远程输入到达时亮屏 5 秒，用完即放），见 `QfBridge` 的
 *   `session.wakeBriefly`，不作常驻保活。
 */
class QfSessionService : Service() {

    override fun onCreate() {
        super.onCreate()
        NotificationChannels.createAll(this)
        // onCreate 拿不到 Intent（标签在 onStartCommand 里到）：先用固定文案
        // 立即前台化，标签到了再刷新通知。
        val notification = buildNotification("正在远程会话")
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE,
            )
        } else {
            @Suppress("DEPRECATION")
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // 标签变化时刷新通知文案；服务本身只保活，不做业务逻辑。
        val label = intent?.getStringExtra(EXTRA_LABEL)
        if (label != null) {
            val manager =
                getSystemService(NOTIFICATION_SERVICE) as android.app.NotificationManager
            manager.notify(NOTIFICATION_ID, buildNotification(label))
        }
        return START_NOT_STICKY
    }

    private fun buildNotification(label: String): Notification =
        NotificationCompat.Builder(this, NotificationChannels.SESSION)
            .setContentTitle(label)
            .setContentText("QFRemote 正在远程会话")
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setOngoing(true)
            .build()

    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        const val NOTIFICATION_ID = 1001
        const val EXTRA_LABEL = "label"
    }
}
