package com.qfremote.android

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.os.Build

/**
 * A-02：通知渠道集中管理（RustDesk MainService / VLC NotificationHelper 模式）。
 * 全 App 的通知渠道只在这里建，禁止各处自建渠道、禁止复用同一渠道发
 * 不同类型通知。
 */
object NotificationChannels {
    /** 正在远程会话（前台服务常驻通知）。 */
    const val SESSION = "qf_session"

    /** 周期同步/离线补发等短时后台任务。 */
    const val SYNC = "qf_sync"

    /** 告警类（被控端上线/离线、工单、申诉）：只发唤醒信号，不带业务内容。 */
    const val ALERT = "qf_alert"

    fun createAll(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager =
            context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val channels = listOf(
            NotificationChannel(
                SESSION,
                "正在远程会话",
                NotificationManager.IMPORTANCE_LOW,
            ).apply { description = "远程会话进行时显示的前台服务通知" },
            NotificationChannel(
                SYNC,
                "同步",
                NotificationManager.IMPORTANCE_LOW,
            ).apply { description = "离线改动同步、更新包下载等短时后台任务" },
            NotificationChannel(
                ALERT,
                "提醒",
                NotificationManager.IMPORTANCE_DEFAULT,
            ).apply { description = "被控端上线/离线、工单、申诉等提醒（只发唤醒信号）" },
        )
        channels.forEach { manager.createNotificationChannel(it) }
    }
}
