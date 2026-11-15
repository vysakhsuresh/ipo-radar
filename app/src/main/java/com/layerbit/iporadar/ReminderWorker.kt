package com.layerbit.iporadar

import android.content.Context
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import org.json.JSONArray
import java.time.Duration
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.LocalTime
import java.util.concurrent.TimeUnit

/**
 * Watchlist reminders: once a day (at the reminder hour the person picked, or
 * 09:00 IST when only the alert switches are on), refresh the data, then post
 * ONE notification combining every due alert for watched IPOs — bidding opens
 * today, last bidding day, allotment day, listing on the next trading day — and
 * any verdict changes. Re-schedules itself for the next day after running.
 */
class ReminderWorker(ctx: Context, params: WorkerParameters) : Worker(ctx, params) {
    override fun doWork(): Result {
        val ctx = applicationContext
        try {
            DataFeed.refresh(ctx)   // best effort; the cached copy is used either way
            val dates = Alerts.takeDateLines(ctx)
            val verdicts = Alerts.takeVerdictLines(ctx)
            Alerts.post(ctx, dates, verdicts, null)
        } finally {
            schedule(ctx, hour(ctx))
        }
        return Result.success()
    }

    companion object {
        const val NAME = "ipo-radar-reminder"
        const val KEY_HOUR = "reminder_hour"      // -1 = off
        const val KEY_WATCH = "watchlist"         // JSON array of IPO ids
        private const val DEFAULT_HOUR = 9

        fun hour(ctx: Context): Int = DataFeed.prefs(ctx).getInt(KEY_HOUR, -1)
        fun watchlist(ctx: Context): Set<String> = runCatching {
            val a = JSONArray(DataFeed.prefs(ctx).getString(KEY_WATCH, "[]") ?: "[]")
            (0 until a.length()).map { a.getString(it) }.toSet()
        }.getOrDefault(emptySet())

        /** The hour the daily run happens at, or -1 when nothing needs it. */
        fun effectiveHour(ctx: Context, hour: Int): Int = when {
            hour in 0..23 -> hour
            Alerts.anyDateAlert(ctx) || Alerts.prefs(ctx)["verdict"] == true -> DEFAULT_HOUR
            else -> -1
        }

        /** Off when neither a reminder hour nor any alert is set; otherwise one-shot work at the next hour:00 IST. */
        fun schedule(ctx: Context, hour: Int) {
            val wm = WorkManager.getInstance(ctx)
            val h = effectiveHour(ctx, hour)
            if (h < 0) { wm.cancelUniqueWork(NAME); return }
            val now = LocalDateTime.now(Alerts.IST)
            var next = LocalDateTime.of(LocalDate.now(Alerts.IST), LocalTime.of(h, 0))
            if (!next.isAfter(now.plusMinutes(1))) next = next.plusDays(1)
            val delay = Duration.between(now, next).toMillis()
            val req = OneTimeWorkRequestBuilder<ReminderWorker>().setInitialDelay(delay, TimeUnit.MILLISECONDS).build()
            wm.enqueueUniqueWork(NAME, ExistingWorkPolicy.REPLACE, req)
        }
    }
}
