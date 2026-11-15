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
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import org.json.JSONArray
import org.json.JSONObject
import java.time.DayOfWeek
import java.time.LocalDate
import java.time.ZoneId

/**
 * Local notifications for the watchlist. Everything is opt-in (see [Prefs]) and
 * computed on the phone from the cached snapshot; nothing is pushed from a server.
 *
 * Spam rules: each run (one worker execution) posts at most ONE notification,
 * combining every alert line into it, and every (IPO, kind, date) alert fires
 * at most once.
 */
object Alerts {
    val IST: ZoneId = ZoneId.of("Asia/Kolkata")

    // Channels: distinct so the person can mute one kind in system settings.
    const val CH_WATCH = "watchlist_dates"
    const val CH_VERDICT = "verdict_changes"
    const val CH_UPDATES = "updates"

    // One notification id per channel: a newer one replaces the older one.
    private const val ID_WATCH = 100
    private const val ID_VERDICT = 200
    private const val ID_UPDATES = 1

    const val KEY_ALERTS = "alerts"                 // JSON {"opening":bool,...}
    private const val KEY_TIERS = "verdict_tiers"   // JSON {id: tier} from the last snapshot
    private const val KEY_PENDING = "verdict_pending" // JSON array of lines not yet notified
    private const val KEY_FIRED = "alerts_fired"    // JSON array of "id|kind|date" already notified

    val KINDS = listOf("opening", "closing", "allotment", "listing", "verdict")

    /** The alert switches. Before the page ever calls setAlerts, an existing reminder hour keeps the old closing+listing reminders. */
    fun prefs(ctx: Context): Map<String, Boolean> {
        val p = DataFeed.prefs(ctx)
        val raw = p.getString(KEY_ALERTS, null)
        val legacy = ReminderWorker.hour(ctx) >= 0
        val o = raw?.let { runCatching { JSONObject(it) }.getOrNull() }
        return KINDS.associateWith { k ->
            if (o != null) o.optBoolean(k, false) else legacy && (k == "closing" || k == "listing")
        }
    }

    fun prefsJson(ctx: Context): JSONObject = JSONObject().apply { prefs(ctx).forEach { (k, v) -> put(k, v) } }

    fun setPrefs(ctx: Context, json: String) {
        val o = runCatching { JSONObject(json) }.getOrNull() ?: return
        val cur = prefs(ctx)
        val out = JSONObject()
        for (k in KINDS) out.put(k, if (o.has(k)) o.optBoolean(k, false) else cur[k] == true)
        DataFeed.prefs(ctx).edit().putString(KEY_ALERTS, out.toString()).apply()
    }

    fun anyDateAlert(ctx: Context): Boolean = prefs(ctx).let { it["opening"] == true || it["closing"] == true || it["allotment"] == true || it["listing"] == true }

    fun allowed(ctx: Context): Boolean {
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return false
        return NotificationManagerCompat.from(ctx).areNotificationsEnabled()
    }

    private fun tierOf(r: JSONObject): String = r.optJSONObject("score")?.optJSONObject("verdict")?.optString("tier", "") ?: ""
    private fun labelOf(r: JSONObject): String = r.optJSONObject("score")?.optJSONObject("verdict")?.optString("label", "")?.takeIf { it.isNotEmpty() } ?: "—"

    /**
     * Called by DataFeed after every refresh that changed the snapshot: remembers
     * each IPO's verdict tier and, for watched IPOs whose tier moved, queues a line
     * for the next notification (only when the verdict alert is on).
     */
    fun recordVerdicts(ctx: Context, liveJson: String) {
        val ipos = JSONObject(liveJson).optJSONArray("ipos") ?: return
        val p = DataFeed.prefs(ctx)
        val before = runCatching { JSONObject(p.getString(KEY_TIERS, "{}") ?: "{}") }.getOrDefault(JSONObject())
        val hadBefore = before.length() > 0
        val now = JSONObject()
        val watched = ReminderWorker.watchlist(ctx)
        val on = prefs(ctx)["verdict"] == true
        val pending = runCatching { JSONArray(p.getString(KEY_PENDING, "[]")) }.getOrDefault(JSONArray())
        for (i in 0 until ipos.length()) {
            val r = ipos.optJSONObject(i) ?: continue
            val id = r.optString("id")
            if (id.isEmpty()) continue
            val tier = tierOf(r)
            now.put(id, tier)
            if (!on || !hadBefore || id !in watched) continue
            val old = before.optString(id, "")
            if (old.isNotEmpty() && tier.isNotEmpty() && old != tier && tier != "nodata") {
                pending.put("${r.optString("name")}: verdict now ${labelOf(r)} (was ${tierName(old)})")
            }
        }
        p.edit().putString(KEY_TIERS, now.toString()).putString(KEY_PENDING, pending.toString()).apply()
    }

    private fun tierName(t: String) = when (t) {
        "apply" -> "Apply"; "lean" -> "Lean apply"; "coinflip" -> "Coin flip"; "avoid" -> "Avoid"
        "watch" -> "Too early"; "nodata" -> "Not enough data"; else -> t
    }

    /** Pending verdict-change lines, cleared as they are taken. */
    fun takeVerdictLines(ctx: Context): List<String> {
        val p = DataFeed.prefs(ctx)
        val a = runCatching { JSONArray(p.getString(KEY_PENDING, "[]")) }.getOrDefault(JSONArray())
        if (a.length() == 0) return emptyList()
        p.edit().remove(KEY_PENDING).apply()
        return (0 until a.length()).map { a.getString(it) }.distinct()
    }

    /** Next weekday after [d] (no exchange-holiday calendar on the phone). */
    fun nextTradingDay(d: LocalDate): LocalDate {
        var x = d.plusDays(1)
        while (x.dayOfWeek == DayOfWeek.SATURDAY || x.dayOfWeek == DayOfWeek.SUNDAY) x = x.plusDays(1)
        return x
    }

    private fun date(s: String?): LocalDate? = s?.takeIf { it.length >= 10 }?.let { runCatching { LocalDate.parse(it.substring(0, 10)) }.getOrNull() }

    /** Today's date alerts for watched IPOs that have not been sent yet; marks them as sent. */
    fun takeDateLines(ctx: Context, today: LocalDate = LocalDate.now(IST)): List<String> {
        val on = prefs(ctx)
        val watched = ReminderWorker.watchlist(ctx)
        if (watched.isEmpty()) return emptyList()
        val live = DataFeed.cachedText(ctx, "live") ?: return emptyList()
        val ipos = runCatching { JSONObject(live).getJSONArray("ipos") }.getOrNull() ?: return emptyList()
        val p = DataFeed.prefs(ctx)
        val firedArr = runCatching { JSONArray(p.getString(KEY_FIRED, "[]")) }.getOrDefault(JSONArray())
        // keep only recent keys so the list stays small
        val cutoff = today.minusDays(10).toString()
        val fired = (0 until firedArr.length()).map { firedArr.getString(it) }.filter { it.substringAfterLast('|') >= cutoff }.toMutableSet()
        val next = nextTradingDay(today)
        val lines = ArrayList<String>()
        for (i in 0 until ipos.length()) {
            val r = ipos.optJSONObject(i) ?: continue
            val id = r.optString("id")
            if (id !in watched) continue
            val name = r.optString("name")
            val open = date(r.optString("open_date"))
            val close = date(r.optString("close_date"))
            val listing = date(r.optString("listing_date"))
            val allot = date(r.optString("allotment_date")) ?: close?.let { nextTradingDay(it) }
            val verdict = labelOf(r)
            fun add(kind: String, text: String) {
                val key = "$id|$kind|$today"
                if (key in fired) return
                fired.add(key); lines.add(text)
            }
            if (on["opening"] == true && open == today) add("opening", "$name: bidding opens today · $verdict")
            if (on["closing"] == true && close == today) add("closing", "$name: last bidding day · $verdict")
            if (on["allotment"] == true && allot == today) add("allotment", "$name: allotment expected today")
            if (on["listing"] == true && listing == next) add("listing", "$name: lists ${if (next == today.plusDays(1)) "tomorrow" else "on " + next.dayOfWeek.name.lowercase().replaceFirstChar { it.uppercase() }}")
        }
        p.edit().putString(KEY_FIRED, JSONArray(fired.toList()).toString()).apply()
        return lines
    }

    fun ensureChannels(ctx: Context) {
        val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.createNotificationChannel(NotificationChannel(CH_WATCH, "Watchlist dates", NotificationManager.IMPORTANCE_HIGH).apply {
            description = "Bidding opens, last bidding day, allotment and listing for IPOs you watch"
        })
        nm.createNotificationChannel(NotificationChannel(CH_VERDICT, "Verdict changes", NotificationManager.IMPORTANCE_DEFAULT).apply {
            description = "When the verdict on an IPO you watch changes"
        })
        nm.createNotificationChannel(NotificationChannel(CH_UPDATES, "New data", NotificationManager.IMPORTANCE_LOW).apply {
            description = "A short summary when a scheduled refresh brings new IPO data"
        })
    }

    /**
     * Post one combined notification. [dateLines] and [verdictLines] go into a single
     * notification on the most important channel present; [summary] is used only
     * when there is nothing else to say. Returns true when something was posted.
     */
    @android.annotation.SuppressLint("MissingPermission")   // checked by allowed()
    fun post(ctx: Context, dateLines: List<String>, verdictLines: List<String>, summary: String?): Boolean {
        if (!allowed(ctx)) return false
        val lines = dateLines + verdictLines
        val channel: String; val id: Int; val title: String; val body: List<String>
        when {
            dateLines.isNotEmpty() -> { channel = CH_WATCH; id = ID_WATCH; body = lines
                title = if (lines.size == 1) "Watchlist" else "Watchlist: ${lines.size} updates" }
            verdictLines.isNotEmpty() -> { channel = CH_VERDICT; id = ID_VERDICT; body = lines
                title = if (lines.size == 1) "Verdict changed" else "${lines.size} verdicts changed" }
            summary != null -> { channel = CH_UPDATES; id = ID_UPDATES; body = listOf(summary); title = "IPO Radar refreshed" }
            else -> return false
        }
        ensureChannels(ctx)
        val open = PendingIntent.getActivity(ctx, id, Intent(ctx, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val b = NotificationCompat.Builder(ctx, channel)
            .setSmallIcon(R.drawable.ic_stat_radar)
            .setColor(ContextCompat.getColor(ctx, R.color.accent))
            .setContentTitle(title)
            .setContentText(body.first())
            .setContentIntent(open)
            .setAutoCancel(true)
            .setOnlyAlertOnce(true)
            .setPriority(if (channel == CH_WATCH) NotificationCompat.PRIORITY_HIGH else NotificationCompat.PRIORITY_DEFAULT)
        if (body.size == 1) b.setStyle(NotificationCompat.BigTextStyle().bigText(body.first()))
        else b.setStyle(NotificationCompat.InboxStyle().also { s -> body.take(7).forEach { s.addLine(it) }; if (body.size > 7) s.setSummaryText("+${body.size - 7} more") })
        return runCatching { NotificationManagerCompat.from(ctx).notify(id, b.build()); true }.getOrDefault(false)
    }
}
