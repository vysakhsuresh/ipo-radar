package com.layerbit.iporadar

import android.content.Context
import android.content.SharedPreferences
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * The app's data feed: three JSON files committed to the repository by the
 * `refresh` workflow. Shared by the activity (manual / on-open refresh) and the
 * background worker (scheduled refresh). Everything is a plain GET of a public
 * file; nothing identifies the phone.
 */
object DataFeed {
    private const val RAW = "https://raw.githubusercontent.com/vysakhsuresh/ipo-radar/main/"
    val FILES = linkedMapOf(
        "live" to "data/scored.json",
        "params" to "model/params.json",
        "history" to "data/history.json",
    )
    const val PREFS = "ipo-radar"
    const val KEY_DOWNLOADED_AT = "downloaded_at"      // epoch ms of the last successful download
    const val KEY_GENERATED_AT = "generated_at"        // the snapshot's own timestamp
    const val KEY_SCHEDULE_HOURS = "schedule_hours"    // 0 = off
    const val KEY_NOTIFY = "notify"                    // notify when new data lands
    const val KEY_LAST_ERROR = "last_error"

    fun prefs(ctx: Context): SharedPreferences = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    fun cacheFile(ctx: Context, key: String) = File(ctx.filesDir, "ipo-$key.json")

    /** Cached files as a key → text map, or null when any is missing. */
    fun cached(ctx: Context): Map<String, String>? {
        val out = LinkedHashMap<String, String>()
        for (k in FILES.keys) {
            val f = cacheFile(ctx, k)
            if (!f.exists()) return null
            out[k] = f.readText()
        }
        return out
    }

    class Result(val ok: Boolean, val changed: Boolean, val generatedAt: String?, val error: String?)

    /** Download all three files; only when all succeed are they written, atomically enough for our purposes. */
    fun refresh(ctx: Context): Result {
        val got = LinkedHashMap<String, String>()
        for ((k, path) in FILES) {
            val text = download(RAW + path) ?: return Result(false, false, null, "could not download $path").also {
                prefs(ctx).edit().putString(KEY_LAST_ERROR, it.error).apply()
            }
            got[k] = text
        }
        val generatedAt = runCatching { JSONObject(got["live"]!!).optString("generated_at", "") }.getOrDefault("")
        val previous = prefs(ctx).getString(KEY_GENERATED_AT, "") ?: ""
        for ((k, v) in got) cacheFile(ctx, k).writeText(v)
        prefs(ctx).edit()
            .putLong(KEY_DOWNLOADED_AT, System.currentTimeMillis())
            .putString(KEY_GENERATED_AT, generatedAt)
            .remove(KEY_LAST_ERROR)
            .apply()
        return Result(true, generatedAt != previous, generatedAt, null)
    }

    private fun download(url: String): String? = runCatching {
        val c = URL(url).openConnection() as HttpURLConnection
        c.connectTimeout = 15000; c.readTimeout = 25000
        c.setRequestProperty("Accept", "application/json")
        c.setRequestProperty("Cache-Control", "no-cache")
        try {
            if (c.responseCode != 200) return null
            c.inputStream.bufferedReader().use { it.readText() }
        } finally { c.disconnect() }
    }.getOrNull()

    /** A one-line summary of the live snapshot for notifications and shares. */
    fun summary(liveJson: String, today: String, tomorrow: String): String = runCatching {
        val ipos = JSONObject(liveJson).getJSONArray("ipos")
        var open = 0; var closing = 0; var listing = 0; var apply = 0
        for (i in 0 until ipos.length()) {
            val r = ipos.getJSONObject(i)
            val st = r.optString("status")
            if (st == "open") open++
            if (r.optString("close_date") == tomorrow || (st == "open" && r.optString("close_date") == today)) closing++
            if (r.optString("listing_date") == tomorrow) listing++
            val tier = r.optJSONObject("score")?.optJSONObject("verdict")?.optString("tier")
            if ((st == "open" || st == "upcoming") && (tier == "apply" || tier == "lean")) apply++
        }
        val parts = ArrayList<String>()
        parts.add("$open open")
        if (closing > 0) parts.add("$closing closing by tomorrow")
        if (listing > 0) parts.add("$listing listing tomorrow")
        parts.add("$apply apply-grade")
        parts.joinToString(" · ")
    }.getOrDefault("IPO data updated")
}
