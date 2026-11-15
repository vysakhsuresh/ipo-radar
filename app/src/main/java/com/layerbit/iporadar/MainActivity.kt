package com.layerbit.iporadar

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.graphics.Color
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.view.View
import android.webkit.JavascriptInterface
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.activity.OnBackPressedCallback
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout
import androidx.webkit.WebViewAssetLoader
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.Executors

/**
 * IPO Radar: the web page in site/, bundled into the APK (assets/www) so it works
 * with no network, plus a refresh of the data files from the repository on open,
 * on return (at most every 10 min), on pull-down, on the page's Refresh button and
 * on the schedule the person picks in Settings. Nothing leaves the phone except
 * GETs of public JSON files and whatever the person chooses to share.
 *
 * ## Native → page (functions the page defines on `window`)
 * - `ipoRadarLoad({live, params, history, track?})` — the cached/refreshed data.
 *   Called once after page load with the cached copy (if any), then again only
 *   when a refresh brought DIFFERENT content. `track` (data/track_record.json)
 *   is optional and absent when the file does not exist upstream.
 * - `ipoRadarStatus(status)` — status object (below) whenever it changes.
 * - `ipoRadarBack()` — called on the system back gesture; return `true` if the
 *   page handled it (closed a sheet/overlay), anything else lets the app go back.
 *
 * ## Page → native: `window.IpoNative.*` (arguments are plain strings/numbers/booleans)
 * - `platform(): string` — "android".
 * - `status(): string` — the status object as a JSON string.
 * - `refresh()` — refresh now; repeated calls within 3 s (or while one runs) are ignored.
 * - `openExternal(url)` / `openUrl(url)` — open an http(s)/mailto/tel/upi link outside the app.
 * - `shareText(text, subject)`, `shareFile(name, mime, content)`, `shareImage(name, dataUrl, caption)`.
 * - `setSchedule(hours: int)` — background refresh every N hours; 0 = off.
 * - `setNotify(on: bool)` — "new data" summary after a scheduled refresh.
 * - `setWatchlist(idsJson: string)` — JSON array of IPO ids.
 * - `setReminderHour(hour: int)` — daily watchlist alert time 0–23 (IST); -1 = default 09:00 when alerts are on.
 * - `setAlerts(json: string)` — `{"opening":bool,"closing":bool,"allotment":bool,"listing":bool,"verdict":bool}`
 *   for watched IPOs: bidding opens today, last bidding day, allotment day
 *   (`allotment_date` or close + 1 trading day), listing on the next trading day,
 *   verdict tier changed. Missing keys keep their current value. Asks for the
 *   notification permission (Android 13+) when any is on.
 * - `notificationsAllowed(): bool` — whether the app may post notifications right now.
 * - `setTheme(mode: string)` — "system" | "light" | "dark": status/navigation bar
 *   icons and the colour behind them follow the page's theme.
 * - `touchState(innerScrolled: bool)` — internal; sent by a helper the app injects so
 *   pull-to-refresh only starts when no inner scroller is scrolled down.
 *
 * ## Status object
 * `{platform, version, version_code, downloaded_at, last_success_at, last_attempt_at,
 *   generated_at, changed, schedule_hours, notify, reminder_hour, watchlist[], alerts{…},
 *   notifications_allowed, theme, has_track, online, refreshing, error}`;
 * times are epoch ms (0 = never) except `generated_at` (the snapshot's own ISO string);
 * `changed` = whether the last completed refresh brought new data.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var root: FrameLayout
    private lateinit var web: WebView
    private lateinit var swipe: SwipeRefreshLayout
    private lateinit var backCallback: OnBackPressedCallback
    private val io = Executors.newSingleThreadExecutor()
    private var pageReady = false
    private var refreshing = false
    private var lastAutoRefresh = 0L
    private var lastRequest = 0L
    private var lastChanged = false
    private var themeMode = "system"
    private val startedAt = SystemClock.elapsedRealtime()
    @Volatile private var innerScrolled = false

    private val askPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { pushStatus(null) }

    companion object {
        private const val ORIGIN = "https://appassets.androidplatform.net"
        private const val START = "$ORIGIN/assets/www/index.html"
        private const val AUTO_REFRESH_GAP_MS = 10 * 60 * 1000L   // on-resume refresh at most every 10 minutes
        private const val REQUEST_GAP_MS = 3_000L                 // bridge/pull refresh throttle
        private const val SPLASH_MAX_MS = 1_200L
        private const val KEY_THEME = "theme"
        private const val LIGHT_BG = 0xFFFFFFFF.toInt()           // @color/surface (light)
        private const val DARK_BG = 0xFF171C1E.toInt()            // @color/surface (night)
        private val SCHEMES = setOf("http", "https", "mailto", "tel", "upi")

        /** Tells the app whether the touched element sits inside a scrolled-down inner scroller. */
        private const val TOUCH_HELPER = """(function(){if(window.__ipoTouch)return;window.__ipoTouch=1;
function inner(t){for(var e=t;e&&e.nodeType===1&&e!==document.body&&e!==document.documentElement;e=e.parentElement){
if(e.scrollTop>0){var o=getComputedStyle(e).overflowY;if(o==='auto'||o==='scroll'||o==='overlay')return true;}}return false;}
document.addEventListener('touchstart',function(ev){try{IpoNative.touchState(inner(ev.target));}catch(_){}},{passive:true,capture:true});})();"""

        private const val BACK_JS = "(function(){try{return window.ipoRadarBack?window.ipoRadarBack()===true:false}catch(e){return false}})()"
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        val splash = installSplashScreen()
        super.onCreate(savedInstanceState)
        splash.setKeepOnScreenCondition { !pageReady && SystemClock.elapsedRealtime() - startedAt < SPLASH_MAX_MS }

        themeMode = DataFeed.prefs(this).getString(KEY_THEME, "system") ?: "system"
        root = FrameLayout(this)
        swipe = SwipeRefreshLayout(this)
        web = WebView(this)
        swipe.addView(web)
        root.addView(swipe)
        setContentView(root)
        applyBars()

        // Edge to edge: the WebView is padded by the system bars / cutout / keyboard so nothing
        // hides under them; the strip behind the bars shows the page colour (see applyBars).
        // The insets are consumed here, so the page's env(safe-area-inset-*) resolves to 0.
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            v.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, ime.bottom))
            WindowInsetsCompat.CONSUMED
        }

        val loader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        with(web.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            cacheMode = WebSettings.LOAD_DEFAULT
            allowFileAccess = false
            allowContentAccess = false
            setSupportZoom(false)
            textZoom = 100
        }
        web.overScrollMode = View.OVER_SCROLL_NEVER
        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                loader.shouldInterceptRequest(request.url)

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (request.url.host == "appassets.androidplatform.net") return false
                openExternal(request.url.toString())
                return true
            }

            override fun onPageStarted(view: WebView, url: String, favicon: android.graphics.Bitmap?) {
                pageReady = false
            }

            override fun onPageFinished(view: WebView, url: String) {
                if (pageReady) return
                pageReady = true
                web.evaluateJavascript(TOUCH_HELPER, null)
                // cached copy first (read off the UI thread), then a refresh that re-injects only on change
                io.execute {
                    val js = DataFeed.cached(applicationContext)?.let { loadJs(it) }
                    runOnUiThread {
                        if (isDestroyed) return@runOnUiThread
                        js?.let { web.evaluateJavascript(it, null) }
                        pushStatus(null)
                        refresh(manual = false)
                    }
                }
            }

            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                // The renderer crashed or was killed for memory: start over with a fresh WebView.
                recreate()
                return true
            }
        }
        web.addJavascriptInterface(Bridge(), "IpoNative")
        swipe.setOnRefreshListener { requestRefresh() }
        swipe.setOnChildScrollUpCallback { _, _ -> web.scrollY > 0 || innerScrolled }
        swipe.setColorSchemeColors(ContextCompat.getColor(this, R.color.accent))

        backCallback = object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (!pageReady) { defaultBack(); return }
                web.evaluateJavascript(BACK_JS) { handled -> if (handled != "true") defaultBack() }
            }
        }
        onBackPressedDispatcher.addCallback(this, backCallback)

        RefreshWorker.schedule(this, DataFeed.prefs(this).getInt(DataFeed.KEY_SCHEDULE_HOURS, 0))
        ReminderWorker.schedule(this, ReminderWorker.hour(this))
        web.loadUrl(START)
    }

    private fun defaultBack() {
        if (web.canGoBack()) { web.goBack(); return }
        backCallback.isEnabled = false
        onBackPressedDispatcher.onBackPressed()
        backCallback.isEnabled = true
    }

    override fun onResume() {
        super.onResume()
        // coming back to the app counts as opening it, but not more than every ten minutes
        if (pageReady && System.currentTimeMillis() - lastAutoRefresh > AUTO_REFRESH_GAP_MS) refresh(manual = false)
        else if (pageReady) pushStatus(null)   // e.g. notification permission changed in Settings
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        if (themeMode == "system") applyBars()
    }

    private fun isDark(): Boolean = when (themeMode) {
        "dark" -> true
        "light" -> false
        else -> (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
    }

    /** Bar icon colours and the colour behind the bars follow the page theme. */
    private fun applyBars() {
        val dark = isDark()
        val status = if (dark) SystemBarStyle.dark(Color.TRANSPARENT) else SystemBarStyle.light(Color.TRANSPARENT, Color.TRANSPARENT)
        // light nav-bar icons need API 27; below that the dark scrim keeps the buttons visible
        val nav = if (dark) SystemBarStyle.dark(Color.TRANSPARENT) else SystemBarStyle.light(Color.TRANSPARENT, 0x801B1B1B.toInt())
        enableEdgeToEdge(status, nav)
        if (Build.VERSION.SDK_INT >= 29) window.isNavigationBarContrastEnforced = false
        val bg = if (dark) DARK_BG else LIGHT_BG
        root.setBackgroundColor(bg)
        web.setBackgroundColor(bg)
        window.decorView.setBackgroundColor(bg)
    }

    private fun online(): Boolean {
        val cm = getSystemService(CONNECTIVITY_SERVICE) as ConnectivityManager
        val caps = cm.getNetworkCapabilities(cm.activeNetwork) ?: return false
        return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
    }

    /** What the page's status strip and settings show (see the KDoc at the top). */
    private fun statusJson(error: String?): JSONObject {
        val p = DataFeed.prefs(this)
        val success = p.getLong(DataFeed.KEY_DOWNLOADED_AT, 0L)
        return JSONObject()
            .put("platform", "android")
            .put("version", BuildConfig.VERSION_NAME)
            .put("version_code", BuildConfig.VERSION_CODE)
            .put("downloaded_at", success)
            .put("last_success_at", success)
            .put("last_attempt_at", p.getLong(DataFeed.KEY_ATTEMPT_AT, 0L))
            .put("generated_at", p.getString(DataFeed.KEY_GENERATED_AT, "") ?: "")
            .put("changed", lastChanged)
            .put("schedule_hours", p.getInt(DataFeed.KEY_SCHEDULE_HOURS, 0))
            .put("notify", p.getBoolean(DataFeed.KEY_NOTIFY, false))
            .put("reminder_hour", ReminderWorker.hour(this))
            .put("watchlist", JSONArray(ReminderWorker.watchlist(this).toList()))
            .put("alerts", Alerts.prefsJson(this))
            .put("notifications_allowed", Alerts.allowed(this))
            .put("theme", themeMode)
            .put("has_track", DataFeed.cacheFile(this, "track") != null)
            .put("online", online())
            .put("refreshing", refreshing)
            .put("error", error ?: p.getString(DataFeed.KEY_LAST_ERROR, null) ?: JSONObject.NULL)
    }

    private fun pushStatus(error: String?) {
        if (!pageReady || isDestroyed) return
        web.evaluateJavascript("window.ipoRadarStatus && window.ipoRadarStatus(" + statusJson(error) + ")", null)
    }

    /**
     * The load call as a JS string. Every cached file was validated as JSON when it was
     * downloaded, so the texts are spliced in as-is instead of being re-parsed here.
     */
    private fun loadJs(parts: Map<String, String>): String {
        val sb = StringBuilder(parts.values.sumOf { it.length } + 128)
        sb.append("window.ipoRadarLoad && window.ipoRadarLoad({")
        var first = true
        for ((k, v) in parts) {
            if (!first) sb.append(',')
            first = false
            sb.append(JSONObject.quote(k)).append(':').append(v.trim())
        }
        sb.append("})")
        return sb.toString()
    }

    /** Pull-down and the page's button: throttled so repeated calls start one refresh. */
    private fun requestRefresh() {
        val now = SystemClock.elapsedRealtime()
        if (refreshing || now - lastRequest < REQUEST_GAP_MS) {
            if (!refreshing) swipe.isRefreshing = false
            pushStatus(null)
            return
        }
        lastRequest = now
        refresh(manual = true)
    }

    private fun refresh(manual: Boolean) {
        if (refreshing) return
        refreshing = true
        lastAutoRefresh = System.currentTimeMillis()
        if (manual) swipe.isRefreshing = true
        pushStatus(null)
        val ctx = applicationContext
        io.execute {
            val r = DataFeed.refresh(ctx)
            val js = if (r.ok && r.changed) DataFeed.cached(ctx)?.let { loadJs(it) } else null
            if (r.ok) Alerts.takeVerdictLines(ctx).takeIf { it.isNotEmpty() }?.let { Alerts.post(ctx, emptyList(), it, null) }
            runOnUiThread {
                if (isDestroyed) return@runOnUiThread
                refreshing = false
                swipe.isRefreshing = false
                if (r.ok) lastChanged = r.changed
                js?.let { if (pageReady) web.evaluateJavascript(it, null) }
                pushStatus(if (r.ok) null else (r.error ?: "refresh failed"))
            }
        }
    }

    private fun openExternal(url: String) {
        val uri = runCatching { Uri.parse(url) }.getOrNull() ?: return
        if (uri.scheme?.lowercase() !in SCHEMES) return
        runCatching { startActivity(Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE)) }
    }

    private fun shareText(text: String, subject: String) {
        val i = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_SUBJECT, subject).putExtra(Intent.EXTRA_TEXT, text)
        runCatching { startActivity(Intent.createChooser(i, subject)) }
    }

    private fun safeName(name: String, fallback: String) = name.replace(Regex("[^A-Za-z0-9._-]"), "-").ifBlank { fallback }

    private fun shareFile(name: String, mime: String, content: String) {
        val dir = File(cacheDir, "shared").apply { mkdirs() }
        val f = File(dir, safeName(name, "ipo-radar.txt")).apply { writeText(content) }
        val uri = FileProvider.getUriForFile(this, "$packageName.files", f)
        val i = Intent(Intent.ACTION_SEND).setType(mime).putExtra(Intent.EXTRA_STREAM, uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        runCatching { startActivity(Intent.createChooser(i, name)) }
    }

    /** A PNG drawn by the page (an IPO card), shared with a caption so WhatsApp, Instagram and the rest can take it. */
    private fun shareImage(name: String, dataUrl: String, caption: String) {
        val b64 = dataUrl.substringAfter(",", "")
        val bytes = runCatching { android.util.Base64.decode(b64, android.util.Base64.DEFAULT) }.getOrNull() ?: return
        val dir = File(cacheDir, "shared").apply { mkdirs() }
        val f = File(dir, safeName(name, "ipo-radar.png")).apply { writeBytes(bytes) }
        val uri = FileProvider.getUriForFile(this, "$packageName.files", f)
        val i = Intent(Intent.ACTION_SEND).setType("image/png").putExtra(Intent.EXTRA_STREAM, uri).putExtra(Intent.EXTRA_TEXT, caption).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        runCatching { startActivity(Intent.createChooser(i, "Share card")) }
    }

    /** The page calls these (documented at the top of the file); every argument is a plain string, number or boolean. */
    inner class Bridge {
        @JavascriptInterface fun platform(): String = "android"
        @JavascriptInterface fun status(): String = statusJson(null).toString()
        @JavascriptInterface fun refresh() { runOnUiThread { requestRefresh() } }
        @JavascriptInterface fun openExternal(url: String) { runOnUiThread { this@MainActivity.openExternal(url) } }
        @JavascriptInterface fun openUrl(url: String) = openExternal(url)
        @JavascriptInterface fun shareText(text: String, subject: String) { runOnUiThread { this@MainActivity.shareText(text, subject) } }
        @JavascriptInterface fun shareFile(name: String, mime: String, content: String) { runOnUiThread { this@MainActivity.shareFile(name, mime, content) } }
        @JavascriptInterface fun shareImage(name: String, dataUrl: String, caption: String) { runOnUiThread { this@MainActivity.shareImage(name, dataUrl, caption) } }
        @JavascriptInterface fun notificationsAllowed(): Boolean = Alerts.allowed(this@MainActivity)
        @JavascriptInterface fun touchState(inner: Boolean) { innerScrolled = inner }

        @JavascriptInterface fun setSchedule(hours: Int) {
            DataFeed.prefs(this@MainActivity).edit().putInt(DataFeed.KEY_SCHEDULE_HOURS, hours.coerceIn(0, 24 * 7)).apply()
            RefreshWorker.schedule(this@MainActivity, hours)
            runOnUiThread { pushStatus(null) }
        }

        @JavascriptInterface fun setWatchlist(idsJson: String) {
            val clean = runCatching { val a = JSONArray(idsJson); JSONArray((0 until a.length()).map { a.getString(it) }).toString() }.getOrDefault("[]")
            DataFeed.prefs(this@MainActivity).edit().putString(ReminderWorker.KEY_WATCH, clean).apply()
        }

        @JavascriptInterface fun setReminderHour(hour: Int) {
            val h = if (hour in 0..23) hour else -1
            DataFeed.prefs(this@MainActivity).edit().putInt(ReminderWorker.KEY_HOUR, h).apply()
            ReminderWorker.schedule(this@MainActivity, h)
            if (h >= 0) askNotificationPermission()
            runOnUiThread { pushStatus(null) }
        }

        @JavascriptInterface fun setNotify(on: Boolean) {
            DataFeed.prefs(this@MainActivity).edit().putBoolean(DataFeed.KEY_NOTIFY, on).apply()
            if (on) askNotificationPermission()
            runOnUiThread { pushStatus(null) }
        }

        @JavascriptInterface fun setAlerts(json: String) {
            Alerts.setPrefs(this@MainActivity, json)
            ReminderWorker.schedule(this@MainActivity, ReminderWorker.hour(this@MainActivity))
            if (Alerts.prefs(this@MainActivity).values.any { it }) askNotificationPermission()
            runOnUiThread { pushStatus(null) }
        }

        @JavascriptInterface fun setTheme(mode: String) {
            val m = mode.lowercase().takeIf { it == "light" || it == "dark" } ?: "system"
            DataFeed.prefs(this@MainActivity).edit().putString(KEY_THEME, m).apply()
            runOnUiThread { themeMode = m; if (!isDestroyed) applyBars() }
        }
    }

    private fun askNotificationPermission() {
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            runOnUiThread { if (!isFinishing) askPermission.launch(Manifest.permission.POST_NOTIFICATIONS) }
        }
    }

    override fun onDestroy() {
        io.shutdown()
        web.removeJavascriptInterface("IpoNative")
        (web.parent as? android.view.ViewGroup)?.removeView(web)
        web.destroy()
        super.onDestroy()
    }
}
