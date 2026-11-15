package com.qfremote.android

import android.app.job.JobParameters
import android.app.job.JobService
import android.content.Context

/**
 * A-01 第二档的系统任务体：触发时只记一次同步节拍。
 *
 * - 进程被杀后系统仍能触发（这正是系统调度的意义）；节拍写入
 *   `qf_sync` SharedPreferences（last_tick_ms／tick_count），真机可
 *   用 dumpsys jobscheduler 与 prefs 文件核查。
 * - 内容拉取不在本处做：无凭据、无加密上下文；下次进程启动／回前台
 *   时 Dart 侧 `_runProbe` 走加密通道拉取（见 main.dart 生命周期钩子）。
 * - 同步完成即 `jobFinished`，不持有；被系统打断（约束不再满足）时
 *   返回 true 要求重排，下次约束满足时再跑。
 */
class QfSyncJobService : JobService() {
    override fun onStartJob(params: JobParameters?): Boolean {
        val prefs = getSharedPreferences(
            QfSyncScheduler.PREFS_NAME,
            Context.MODE_PRIVATE,
        )
        prefs.edit()
            .putLong(QfSyncScheduler.KEY_LAST_TICK_MS, System.currentTimeMillis())
            .putInt(
                QfSyncScheduler.KEY_TICK_COUNT,
                prefs.getInt(QfSyncScheduler.KEY_TICK_COUNT, 0) + 1,
            )
            .apply()
        jobFinished(params, false)
        return false
    }

    override fun onStopJob(params: JobParameters?): Boolean = true
}
