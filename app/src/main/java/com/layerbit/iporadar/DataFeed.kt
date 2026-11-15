package com.layerbit.iporadar

import android.content.Context
import android.content.SharedPreferences
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.SocketTimeoutException
import java.net.URL
import java.security.MessageDigest

/**
 * The app's data feed: JSON files committed to the repository by the `refresh`
 * workflow. Shared by the activity (manual / on-open refresh), the background
 * workers and the widget. Everything is a plain GET of a public file; nothing
 * identifies the phone.
 *
 * Storage is generational so the page never sees a mix of old and new files:
 * a refresh downloads every file, writes them into a fresh directory
 * `files/feed/g<timestamp>/`, and only then atomically swaps the one-line
 * pointer file `files/feed/current` (temp file + rename). A crash or failed
 * download at any point leaves the previous generation untouched.
 */
object DataFeed {
    private const val RAW = "https://raw.githubusercontent.com/vysakhsuresh/ipo-radar/main/"

    /** Required: all three download or the refresh fails and nothing changes. */
    val FILES = linkedMapOf(
        "live" to "data/scored.json",
        "params" to "model/params.json",
        "history" to "data/history.json",
    )

    /** Optional: a 404 or failure never fails the refresh. */
    val OPTIONAL = linkedMapOf(
        "track" to "data/track_record.json",
    )

    const val PREFS = "ipo-radar"
    const val KEY_DOWNLOADED_AT = "downloaded_at"      // epoch ms of the last successful download
    const val KEY_ATTEMPT_AT = "attempt_at"            // epoch ms of the last attempt (success or not)
    const val KEY_GENERATED_AT = "generated_at"        // the snapshot's own timestamp
    const val KEY_HASH = "content_hash"                // SHA-256 of the cached generation
    const val KEY_SCHEDULE_HOURS = "schedule_hours"    // 0 = off
    const val KEY_NOTIFY = "notify"                    // notify when new data lands
    const val KEY_LAST_ERROR = "last_error"

    private const val CONNECT_TIMEOUT_MS = 10_000
    private const val READ_TIMEOUT_MS = 20_000
    private const val RETRY_BACKOFF_MS = 1_500L

    private val lock = Any()

    fun prefs(ctx: Context): SharedPreferences = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private fun feedDir(ctx: Context) = File(ctx.filesDir, "feed")
    private fun pointer(ctx: Context) = File(feedDir(ctx), "current")
    private fun legacyFile(ctx: Context, key: String) = File(ctx.filesDir, "ipo-$key.json")

    private fun currentGen(ctx: Context): File? {
        val name = runCatching { pointer(ctx).readText().trim() }.getOrNull()?.takeIf { it.isNotEmpty() } ?: return null
        return File(feedDir(ctx), name).takeIf { it.isDirectory }
    }

    /** The cached copy of one file (required or optional), or null. */
    fun cacheFile(ctx: Context, key: String): File? {
        currentGen(ctx)?.let { g -> return File(g, "$key.json").takeIf { it.exists() } }
        return legacyFile(ctx, key).takeIf { it.exists() }   // cache written by app version 0.1
    }

    fun cachedText(ctx: Context, key: String): String? = runCatching { cacheFile(ctx, key)?.readText() }.getOrNull()

    /** Cached files as a key → text map (required + any optional present), or null when a required one is missing. */
    fun cached(ctx: Context): Map<String, String>? {
        val out = LinkedHashMap<String, String>()
        for (k in FILES.keys) out[k] = cachedText(ctx, k) ?: return null
        for (k in OPTIONAL.keys) cachedText(ctx, k)?.let { out[k] = it }
        return out
    }

    class Result(val ok: Boolean, val changed: Boolean, val generatedAt: String?, val error: String?)

    private sealed class Fetch {
        class Ok(val text: String) : Fetch()
        object NotFound : Fetch()
        class Failed(val reason: String) : Fetch()
    }

    /**
     * Download every file; only when all required ones succeed is a new generation
     * committed. `changed` is true when the content differs from what was cached.
     * Serialised process-wide so the activity, the workers and the widget never race.
     */
    fun refresh(ctx: Context): Result = synchronized(lock) {
        val p = prefs(ctx)
        p.edit().putLong(KEY_ATTEMPT_AT, System.currentTimeMillis()).apply()
        val bust = System.currentTimeMillis() / 1000
        val got = LinkedHashMap<String, String>()
        for ((k, path) in FILES) {
            when (val f = fetch(RAW + path, bust)) {
                is Fetch.Ok -> got[k] = f.text
                is Fetch.NotFound -> return fail(ctx, "could not download $path (not found)")
                is Fetch.Failed -> return fail(ctx, "could not download $path (${f.reason})")
            }
        }
        for ((k, path) in OPTIONAL) {
            when (val f = fetch(RAW + path, bust)) {
                is Fetch.Ok -> got[k] = f.text
                is Fetch.NotFound -> Unit                                   // gone upstream: drop it
                is Fetch.Failed -> cachedText(ctx, k)?.let { got[k] = it }  // keep the last good copy
            }
        }

        val hash = sha256(got)
        val hadCache = FILES.keys.all { cacheFile(ctx, it) != null }
        val changed = !hadCache || hash != p.getString(KEY_HASH, "")
        val generatedAt = runCatching { JSONObject(got["live"]!!).optString("generated_at", "") }.getOrDefault("")

        if (changed || currentGen(ctx) == null) {
            if (!commit(ctx, got)) return fail(ctx, "could not save the downloaded data")
        }
        p.edit()
            .putLong(KEY_DOWNLOADED_AT, System.currentTimeMillis())
            .putString(KEY_GENERATED_AT, generatedAt)
            .putString(KEY_HASH, hash)
            .remove(KEY_LAST_ERROR)
            .apply()
        if (changed) runCatching { Alerts.recordVerdicts(ctx, got["live"]!!) }
        runCatching { RadarWidget.updateAll(ctx) }
        Result(true, changed, generatedAt, null)
    }

    private fun fail(ctx: Context, error: String): Result {
        prefs(ctx).edit().putString(KEY_LAST_ERROR, error).apply()
        runCatching { RadarWidget.updateAll(ctx) }
        return Result(false, false, null, error)
    }

    /** Write a new generation, then swap the pointer atomically and delete older generations. */
    private fun commit(ctx: Context, files: Map<String, String>): Boolean = runCatching {
        val dir = feedDir(ctx).apply { mkdirs() }
        val gen = File(dir, "g" + System.currentTimeMillis())
        gen.deleteRecursively()
        if (!gen.mkdirs()) throw IOException("mkdir")
        for ((k, v) in files) File(gen, "$k.json").writeText(v)
        val tmp = File(dir, "current.tmp")
        tmp.writeText(gen.name)
        if (!tmp.renameTo(pointer(ctx))) {
            // renameTo over an existing file works on Android's filesystems; fall back defensively
            pointer(ctx).delete()
            if (!tmp.renameTo(pointer(ctx))) throw IOException("rename")
        }
        dir.listFiles()?.forEach { if (it.isDirectory && it.name != gen.name) it.deleteRecursively() }
        for (k in FILES.keys + OPTIONAL.keys) legacyFile(ctx, k).delete()
        true
    }.getOrDefault(false)

    /** GET with cache-busting, timeouts and one retry with backoff; the body must parse as JSON. */
    private fun fetch(url: String, bust: Long): Fetch {
        var last: Fetch = Fetch.Failed("no attempt")
        for (attempt in 0..1) {
            if (attempt > 0) runCatching { Thread.sleep(RETRY_BACKOFF_MS) }
            last = fetchOnce("$url?t=$bust")
            if (last !is Fetch.Failed) return last
        }
        return last
    }

    private fun fetchOnce(url: String): Fetch {
        val c = try { URL(url).openConnection() as HttpURLConnection } catch (e: Exception) { return Fetch.Failed("bad url") }
        return try {
            c.connectTimeout = CONNECT_TIMEOUT_MS
            c.readTimeout = READ_TIMEOUT_MS
            c.useCaches = false
            c.instanceFollowRedirects = true
            c.setRequestProperty("Accept", "application/json")
            c.setRequestProperty("Cache-Control", "no-cache")
            c.setRequestProperty("Pragma", "no-cache")
            when (val code = c.responseCode) {
                200 -> {
                    val text = c.inputStream.bufferedReader(Charsets.UTF_8).use { it.readText() }
                    val v = runCatching { JSONTokener(text).nextValue() }.getOrNull()
                    if (v is JSONObject || v is JSONArray) Fetch.Ok(text) else Fetch.Failed("not valid JSON")
                }
                404, 410 -> Fetch.NotFound
                else -> Fetch.Failed("HTTP $code")
            }
        } catch (e: SocketTimeoutException) {
            Fetch.Failed("timed out")
        } catch (e: Exception) {
            Fetch.Failed(e.javaClass.simpleName)
        } finally {
            c.disconnect()
        }
    }

    private fun sha256(files: Map<String, String>): String {
        val md = MessageDigest.getInstance("SHA-256")
        for ((k, v) in files.toSortedMap()) {
            md.update(k.toByteArray()); md.update(0)
            md.update(v.toByteArray(Charsets.UTF_8)); md.update(0)
        }
        return md.digest().joinToString("") { "%02x".format(it) }
    }

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
