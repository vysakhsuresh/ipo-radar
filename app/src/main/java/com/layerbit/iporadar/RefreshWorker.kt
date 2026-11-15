package com.layerbit.iporadar

import android.content.Context
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import java.time.LocalDate
import java.util.concurrent.TimeUnit

/**
 * Background refresh (WorkManager): the periodic schedule picked in Settings, and
 * one-off runs from the widget's refresh button. Posts at most one notification
 * per run: verdict changes on watched IPOs if any (and the verdict alert is on),
 * otherwise the "new data" summary if the person turned that on (scheduled runs only).
 */
class RefreshWorker(ctx: Context, params: WorkerParameters) : Worker(ctx, params) {
    override fun doWork(): Result {
        val ctx = applicationContext
        val fromWidget = inputData.getString(KEY_SOURCE) == SOURCE_WIDGET
        val r = DataFeed.refresh(ctx)   // updates the widget itself, success or failure
        if (!r.ok) return if (fromWidget && runAttemptCount >= 1) Result.failure() else Result.retry()
        val verdictLines = Alerts.takeVerdictLines(ctx)
        val summary = if (!fromWidget && r.changed && DataFeed.prefs(ctx).getBoolean(DataFeed.KEY_NOTIFY, false)) {
            DataFeed.cachedText(ctx, "live")?.let { live ->
                val today = LocalDate.now(Alerts.IST)
                DataFeed.summary(live, today.toString(), today.plusDays(1).toString())
            }
        } else null
        Alerts.post(ctx, emptyList(), verdictLines, summary)
        return Result.success()
    }

    companion object {
        const val NAME = "ipo-radar-refresh"
        const val NAME_NOW = "ipo-radar-refresh-now"
        const val KEY_SOURCE = "source"
        const val SOURCE_WIDGET = "widget"

        private val network = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()

        /** hours = 0 cancels; WorkManager's minimum period is 15 minutes, we offer 3 h and up. */
        fun schedule(ctx: Context, hours: Int) {
            val wm = WorkManager.getInstance(ctx)
            if (hours <= 0) { wm.cancelUniqueWork(NAME); return }
            val req = PeriodicWorkRequestBuilder<RefreshWorker>(hours.toLong(), TimeUnit.HOURS)
                .setConstraints(network)
                .build()
            wm.enqueueUniquePeriodicWork(NAME, ExistingPeriodicWorkPolicy.UPDATE, req)
        }

        /** A one-off refresh as soon as there is a network (the widget's button). */
        fun runNow(ctx: Context) {
            val req = OneTimeWorkRequestBuilder<RefreshWorker>()
                .setConstraints(network)
                .setInputData(workDataOf(KEY_SOURCE to SOURCE_WIDGET))
                .build()
            WorkManager.getInstance(ctx).enqueueUniqueWork(NAME_NOW, ExistingWorkPolicy.KEEP, req)
        }
    }
}
