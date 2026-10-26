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
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import java.time.LocalDate
import java.util.concurrent.TimeUnit

/** Scheduled background refresh (WorkManager). Posts a notification when the snapshot changed, if allowed. */
class RefreshWorker(ctx: Context, params: WorkerParameters) : Worker(ctx, params) {
    override fun doWork(): Result {
        val r = DataFeed.refresh(applicationContext)
        if (!r.ok) return Result.retry()
        if (r.changed && DataFeed.prefs(applicationContext).getBoolean(DataFeed.KEY_NOTIFY, false)) notify(applicationContext)
        return Result.success()
    }

    private fun notify(ctx: Context) {
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
        val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.createNotificationChannel(NotificationChannel(CHANNEL, "IPO data updates", NotificationManager.IMPORTANCE_DEFAULT))
        val live = DataFeed.cacheFile(ctx, "live").takeIf { it.exists() }?.readText() ?: return
        val today = LocalDate.now()
        val text = DataFeed.summary(live, today.toString(), today.plusDays(1).toString())
        val open = PendingIntent.getActivity(ctx, 0, Intent(ctx, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val n = NotificationCompat.Builder(ctx, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_radar)
            .setContentTitle("IPO Radar refreshed")
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setContentIntent(open)
            .setAutoCancel(true)
            .build()
        nm.notify(1, n)
    }

    companion object {
        const val CHANNEL = "updates"
        const val NAME = "ipo-radar-refresh"

        /** hours = 0 cancels; WorkManager's minimum period is 15 minutes, we offer 3 h and up. */
        fun schedule(ctx: Context, hours: Int) {
            val wm = WorkManager.getInstance(ctx)
            if (hours <= 0) { wm.cancelUniqueWork(NAME); return }
            val req = PeriodicWorkRequestBuilder<RefreshWorker>(hours.toLong(), TimeUnit.HOURS)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .build()
            wm.enqueueUniquePeriodicWork(NAME, ExistingPeriodicWorkPolicy.UPDATE, req)
        }
    }
}
