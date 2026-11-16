package com.qfremote.android

import android.app.job.JobInfo
import android.app.job.JobScheduler
import android.content.ComponentName
import android.content.Context
import android.content.SharedPreferences
import android.os.Build

/**
 * A-01 第二档：周期同步的系统调度（JobScheduler，框架 API）。
 *
 * 不引 WorkManager：离线镜像仓无 androidx.work，新增依赖会断构建；
 * JobScheduler 本就是 WorkManager 底层走的系统调度器，约束（仅 Wi-Fi／
 * 仅充电／电量不低）与 15 分钟下限均可直接表达，进程被杀后任务仍在。
 *
 * 约束语义：约束 gate 的是“内容拉取”的时机信号，不是节拍标记本身——
 * 任务触发时只写节拍（见 [QfSyncJobService]），内容拉取在下次进程启
 * 动／回前台时由 Dart 侧 `_runProbe` 走加密通道做，本处绝不直接发网
 * 络请求（无凭据、无加密上下文）。
 *
 * 不持久化到重启（不用 setPersisted，不新增 RECEIVE_BOOT_COMPLETED
 * 权限）：重启后任务消失，下次打开 App 时 `onAppResumed` 重新调度。
 */
object QfSyncScheduler {
    /** 节拍落盘的 SharedPreferences 文件名（与 Dart 侧 shared_preferences 无关）。 */
    const val PREFS_NAME = "qf_sync"

    /** 上次节拍触发的毫秒时间戳。 */
    const val KEY_LAST_TICK_MS = "last_tick_ms"

    /** 累计节拍次数（真机验：dumpsys jobscheduler＋本文件可查任务是否在跑）。 */
    const val KEY_TICK_COUNT = "tick_count"

    /** 任务 id → JobScheduler 作业 id：String.hashCode 是确定性算法，跨进程稳定。 */
    fun jobIdFor(taskId: String): Int = taskId.hashCode() and 0x7fffffff

    fun schedulePeriodicSync(
        context: Context,
        taskId: String,
        wifiOnly: Boolean,
        chargingOnly: Boolean,
        batteryNotLow: Boolean,
        intervalMinutes: Int,
    ): Boolean {
        if (taskId.isBlank()) return false
        val minutes = intervalMinutes.coerceAtLeast(15)
        val builder = JobInfo.Builder(
            jobIdFor(taskId),
            ComponentName(context, QfSyncJobService::class.java),
        )
            .setPeriodic(minutes * 60_000L)
            .setRequiredNetworkType(
                if (wifiOnly) JobInfo.NETWORK_TYPE_UNMETERED else JobInfo.NETWORK_TYPE_NONE,
            )
            .setRequiresCharging(chargingOnly)
        if (batteryNotLow && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            builder.setRequiresBatteryNotLow(true)
        }
        val scheduler =
            context.getSystemService(Context.JOB_SCHEDULER_SERVICE) as JobScheduler
        return scheduler.schedule(builder.build()) == JobScheduler.RESULT_SUCCESS
    }

    fun cancelPeriodicSync(context: Context, taskId: String) {
        if (taskId.isBlank()) return
        val scheduler =
            context.getSystemService(Context.JOB_SCHEDULER_SERVICE) as JobScheduler
        scheduler.cancel(jobIdFor(taskId))
    }

    /** 供排障／后续“上次同步时间”展示读数。 */
    fun readLastTick(context: Context): Pair<Long, Int> {
        val prefs: SharedPreferences =
            context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        return prefs.getLong(KEY_LAST_TICK_MS, 0L) to prefs.getInt(KEY_TICK_COUNT, 0)
    }
}
