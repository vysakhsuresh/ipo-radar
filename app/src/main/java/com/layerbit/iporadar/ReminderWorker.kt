package com.layerbit.iporadar

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import org.json.JSONArray
import org.json.JSONObject
import java.time.Duration
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.LocalTime
import java.time.ZoneId
import java.util.concurrent.TimeUnit

/**
 * Watchlist reminders: once a day at the hour the person picked (IST), look at
 * the cached snapshot and notify for every watched IPO whose last bidding day
 * is today, and for every watched IPO listing today. Re-schedules itself for
 * the next day after running. Refreshes the data first so the verdict in the
 * notification is current.
 */
class ReminderWorker(ctx: Context, params: WorkerParameters) : Worker(ctx, params) {
    override fun doWork(): Result {
        try {
            DataFeed.refresh(applicationContext)   // best effort; the cached copy is used either way
            fire(applicationContext)
        } finally {
            schedule(applicationContext, hour(applicationContext))
        }
        return Result.success()
    }

    companion object {
        const val NAME = "ipo-radar-reminder"
        const val CHANNEL = "reminders"
        const val KEY_HOUR = "reminder_hour"      // -1 = off
        const val KEY_WATCH = "watchlist"         // JSON array of IPO ids
        private val IST: ZoneId = ZoneId.of("Asia/Kolkata")

        fun hour(ctx: Context): Int = DataFeed.prefs(ctx).getInt(KEY_HOUR, -1)
        fun watchlist(ctx: Context): Set<String> = runCatching {
            val a = JSONArray(DataFeed.prefs(ctx).getString(KEY_WATCH, "[]") ?: "[]")
            (0 until a.length()).map { a.getString(it) }.toSet()
        }.getOrDefault(emptySet())

        /** hour < 0 cancels; otherwise one-shot work at the next occurrence of hour:00 IST. */
        fun schedule(ctx: Context, hour: Int) {
            val wm = WorkManager.getInstance(ctx)
            if (hour < 0) { wm.cancelUniqueWork(NAME); return }
            val now = LocalDateTime.now(IST)
            var next = LocalDateTime.of(LocalDate.now(IST), LocalTime.of(hour, 0))
            if (!next.isAfter(now.plusMinutes(1))) next = next.plusDays(1)
            val delay = Duration.between(now, next).toMillis()
            val req = OneTimeWorkRequestBuilder<ReminderWorker>().setInitialDelay(delay, TimeUnit.MILLISECONDS).build()
            wm.enqueueUniqueWork(NAME, ExistingWorkPolicy.REPLACE, req)
        }

        fun fire(ctx: Context) {
            if (Build.VERSION.SDK_INT >= 33 &&
                ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
            val watched = watchlist(ctx)
            if (watched.isEmpty()) return
            val live = DataFeed.cacheFile(ctx, "live").takeIf { it.exists() }?.readText() ?: return
            val today = LocalDate.now(IST).toString()
            val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            nm.createNotificationChannel(NotificationChannel(CHANNEL, "Watchlist reminders", NotificationManager.IMPORTANCE_HIGH))
            val ipos = runCatching { JSONObject(live).getJSONArray("ipos") }.getOrNull() ?: return
            var n = 100
            for (i in 0 until ipos.length()) {
                val r = ipos.getJSONObject(i)
                if (r.optString("id") !in watched) continue
                val closing = r.optString("close_date") == today
                val listing = r.optString("listing_date") == today
                if (!closing && !listing) continue
                val score = r.optJSONObject("score")
                val verdict = score?.optJSONObject("verdict")
                val p = score?.optDouble("p_up", Double.NaN) ?: Double.NaN
                val ev = score?.optJSONObject("ev")?.optDouble("ev", Double.NaN) ?: Double.NaN
                val bits = ArrayList<String>()
                verdict?.optString("label")?.takeIf { it.isNotEmpty() }?.let { bits.add("Verdict $it") }
                if (!p.isNaN()) bits.add("${Math.round(p * 100)}% chance of a listing gain")
                if (!ev.isNaN()) bits.add("worth ₹${Math.round(ev)} per application")
                val title = if (closing) "Last bidding day: ${r.optString("name")}" else "Listing today: ${r.optString("name")}"
                val text = (if (closing) "Bids close today. " else "Shares list today. ") + bits.joinToString(" · ")
                val open = PendingIntent.getActivity(ctx, n, Intent(ctx, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
                nm.notify(n++, NotificationCompat.Builder(ctx, CHANNEL)
                    .setSmallIcon(R.drawable.ic_stat_radar).setContentTitle(title).setContentText(text)
                    .setStyle(NotificationCompat.BigTextStyle().bigText(text)).setContentIntent(open).setAutoCancel(true)
                    .setPriority(NotificationCompat.PRIORITY_HIGH).build())
            }
        }
    }
}
