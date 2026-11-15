package com.layerbit.iporadar

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.style.ForegroundColorSpan
import android.text.style.StyleSpan
import android.graphics.Typeface
import android.view.View
import android.widget.RemoteViews
import androidx.core.content.ContextCompat
import org.json.JSONObject
import java.time.Duration
import java.time.Instant
import java.time.LocalDate
import java.time.OffsetDateTime
import java.time.format.DateTimeFormatter
import java.util.Locale

/**
 * Home-screen widget: how many IPOs are open now, up to three open/upcoming
 * issues with their verdict and key date, and how old the data is. Tapping it
 * opens the app; the small refresh button runs a one-off background refresh.
 * Rendered from the cached scored.json after every refresh (DataFeed calls
 * [updateAll]) and every 30 minutes so the age label stays honest.
 */
class RadarWidget : AppWidgetProvider() {

    override fun onUpdate(ctx: Context, mgr: AppWidgetManager, ids: IntArray) {
        val views = render(ctx, busy = false)
        for (id in ids) mgr.updateAppWidget(id, views)
    }

    override fun onReceive(ctx: Context, intent: Intent) {
        if (intent.action == ACTION_REFRESH) {
            push(ctx, render(ctx, busy = true))
            RefreshWorker.runNow(ctx)
            return
        }
        super.onReceive(ctx, intent)
    }

    companion object {
        const val ACTION_REFRESH = "com.layerbit.iporadar.widget.REFRESH"
        private val DAY: DateTimeFormatter = DateTimeFormatter.ofPattern("d MMM", Locale.ENGLISH)
        private val ROWS = intArrayOf(R.id.w_row1, R.id.w_row2, R.id.w_row3)

        /** Re-render every placed widget (no-op when none are placed). */
        fun updateAll(ctx: Context) {
            val mgr = AppWidgetManager.getInstance(ctx) ?: return
            val ids = mgr.getAppWidgetIds(ComponentName(ctx, RadarWidget::class.java))
            if (ids.isEmpty()) return
            push(ctx, render(ctx, busy = false))
        }

        private fun push(ctx: Context, views: RemoteViews) {
            val mgr = AppWidgetManager.getInstance(ctx) ?: return
            mgr.updateAppWidget(ComponentName(ctx, RadarWidget::class.java), views)
        }

        private class Row(val name: String, val status: String, val sort: String, val date: LocalDate?, val label: String, val tier: String, val sme: Boolean)

        private fun date(s: String): LocalDate? = s.takeIf { it.length >= 10 }?.let { runCatching { LocalDate.parse(it.substring(0, 10)) }.getOrNull() }

        private fun tierColor(ctx: Context, tier: String): Int = ContextCompat.getColor(ctx, when (tier) {
            "apply" -> R.color.tier_apply
            "lean" -> R.color.tier_lean
            "coinflip" -> R.color.tier_coinflip
            "avoid" -> R.color.tier_avoid
            else -> R.color.widget_muted
        })

        private fun shortName(n: String): String = n
            .replace(Regex("\\s+(Limited|Ltd\\.?|Pvt\\.?|Private)\\b.*$", RegexOption.IGNORE_CASE), "")
            .trim().ifEmpty { n }

        fun render(ctx: Context, busy: Boolean): RemoteViews {
            val v = RemoteViews(ctx.packageName, R.layout.widget_radar)
            val openApp = PendingIntent.getActivity(ctx, 0,
                Intent(ctx, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
            v.setOnClickPendingIntent(R.id.w_root, openApp)
            val refresh = PendingIntent.getBroadcast(ctx, 1,
                Intent(ctx, RadarWidget::class.java).setAction(ACTION_REFRESH),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
            v.setOnClickPendingIntent(R.id.w_refresh, refresh)

            val live = DataFeed.cachedText(ctx, "live")?.let { runCatching { JSONObject(it) }.getOrNull() }
            val ipos = live?.optJSONArray("ipos")
            if (ipos == null) {
                v.setTextViewText(R.id.w_count, "—")
                v.setTextViewText(R.id.w_count_label, ctx.getString(R.string.widget_open_now))
                ROWS.forEach { v.setViewVisibility(it, View.GONE) }
                v.setViewVisibility(R.id.w_empty, View.VISIBLE)
                v.setTextViewText(R.id.w_empty, ctx.getString(R.string.widget_no_data))
                v.setTextViewText(R.id.w_age, if (busy) ctx.getString(R.string.widget_refreshing) else "")
                return v
            }

            val rows = ArrayList<Row>()
            var openCount = 0
            for (i in 0 until ipos.length()) {
                val r = ipos.optJSONObject(i) ?: continue
                val st = r.optString("status")
                if (st == "open") openCount++
                if (st != "open" && st != "upcoming") continue
                val verdict = r.optJSONObject("score")?.optJSONObject("verdict")
                val d = if (st == "open") date(r.optString("close_date")) else date(r.optString("open_date"))
                rows.add(Row(shortName(r.optString("name")), st, (if (st == "open") "0" else "1") + (d?.toString() ?: "9999"), d,
                    verdict?.optString("label")?.takeIf { it.isNotEmpty() } ?: "No verdict",
                    verdict?.optString("tier") ?: "nodata", r.optString("board") == "sme"))
            }
            rows.sortBy { it.sort }

            v.setTextViewText(R.id.w_count, openCount.toString())
            v.setTextViewText(R.id.w_count_label, ctx.getString(R.string.widget_open_now))
            for ((i, id) in ROWS.withIndex()) {
                val row = rows.getOrNull(i)
                if (row == null) { v.setViewVisibility(id, View.GONE); continue }
                v.setViewVisibility(id, View.VISIBLE)
                v.setTextViewText(id, line(ctx, row))
            }
            v.setViewVisibility(R.id.w_empty, if (rows.isEmpty()) View.VISIBLE else View.GONE)
            if (rows.isEmpty()) v.setTextViewText(R.id.w_empty, ctx.getString(R.string.widget_nothing_open))
            v.setTextViewText(R.id.w_age, if (busy) ctx.getString(R.string.widget_refreshing) else ageText(ctx, live))
            return v
        }

        private fun line(ctx: Context, r: Row): CharSequence {
            val sb = SpannableStringBuilder()
            sb.append(r.name, StyleSpan(Typeface.BOLD), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            if (r.sme) sb.append(" SME", ForegroundColorSpan(ContextCompat.getColor(ctx, R.color.widget_muted)), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            sb.append(" · ")
            sb.append(r.label, ForegroundColorSpan(tierColor(ctx, r.tier)), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            if (r.date != null) {
                sb.append(" · ")
                sb.append((if (r.status == "open") "closes " else "opens ") + r.date.format(DAY),
                    ForegroundColorSpan(ContextCompat.getColor(ctx, R.color.widget_muted)), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            }
            return sb
        }

        private fun ageText(ctx: Context, live: JSONObject): String {
            val p = DataFeed.prefs(ctx)
            // when the app last checked for new data (what people expect), falling back
            // to the snapshot's own time for the copy bundled with the app
            val gen = live.optString("generated_at")
            val at = p.getLong(DataFeed.KEY_DOWNLOADED_AT, 0L).takeIf { it > 0 }?.let { Instant.ofEpochMilli(it) }
                ?: runCatching { OffsetDateTime.parse(gen).toInstant() }.getOrNull()
                ?: runCatching { Instant.parse(gen) }.getOrNull()
                ?: return ""
            val mins = Duration.between(at, Instant.now()).toMinutes().coerceAtLeast(0)
            val age = when {
                mins < 2 -> "just now"
                mins < 60 -> "$mins min ago"
                mins < 48 * 60 -> "${mins / 60} h ago"
                else -> "${mins / (24 * 60)} days ago"
            }
            val failed = p.getString(DataFeed.KEY_LAST_ERROR, null) != null &&
                p.getLong(DataFeed.KEY_ATTEMPT_AT, 0) > p.getLong(DataFeed.KEY_DOWNLOADED_AT, 0)
            return ctx.getString(R.string.widget_data_age, age) + if (failed) " · " + ctx.getString(R.string.widget_offline) else ""
        }
    }
}
