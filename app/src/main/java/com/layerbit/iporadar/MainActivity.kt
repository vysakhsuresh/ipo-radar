package com.layerbit.iporadar

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.View
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout
import androidx.webkit.WebViewAssetLoader
import org.json.JSONObject
import org.json.JSONTokener
import java.io.File
import java.util.concurrent.Executors

/**
 * IPO Radar: the web page in site/, bundled into the APK (assets/www) so it works
 * with no network, plus a refresh of the data files from the repository on open,
 * on return, on pull-down, on the Refresh button and on the schedule the person
 * picks in Settings. Nothing leaves the phone except GETs of public JSON files
 * and whatever the person chooses to share.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var web: WebView
    private lateinit var swipe: SwipeRefreshLayout
    private val io = Executors.newSingleThreadExecutor()
    private var pageReady = false
    private var refreshing = false
    private var lastAutoRefresh = 0L

    companion object {
        private const val ORIGIN = "https://appassets.androidplatform.net"
        private const val START = "$ORIGIN/assets/www/index.html"
        private const val AUTO_REFRESH_GAP_MS = 10 * 60 * 1000L   // on-resume refresh at most every 10 minutes
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        swipe = SwipeRefreshLayout(this)
        web = WebView(this)
        swipe.addView(web)
        setContentView(swipe)

        val loader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

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
                runCatching { startActivity(Intent(Intent.ACTION_VIEW, request.url)) }
                return true
            }

            override fun onPageFinished(view: WebView, url: String) {
                pageReady = true
                DataFeed.cached(this@MainActivity)?.let { inject(it) }
                pushStatus(null)
                refresh(manual = false)
            }
        }
        web.addJavascriptInterface(Bridge(), "IpoNative")
        swipe.setOnRefreshListener { refresh(manual = true) }
        swipe.setColorSchemeColors(getColor(R.color.accent))

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (web.canGoBack()) web.goBack() else { isEnabled = false; onBackPressedDispatcher.onBackPressed() }
            }
        })
        RefreshWorker.schedule(this, DataFeed.prefs(this).getInt(DataFeed.KEY_SCHEDULE_HOURS, 0))
        ReminderWorker.schedule(this, ReminderWorker.hour(this))
        web.loadUrl(START)
    }

    override fun onResume() {
        super.onResume()
        // coming back to the app counts as opening it, but not more than every ten minutes
        if (pageReady && System.currentTimeMillis() - lastAutoRefresh > AUTO_REFRESH_GAP_MS) refresh(manual = false)
    }

    private fun online(): Boolean {
        val cm = getSystemService(CONNECTIVITY_SERVICE) as ConnectivityManager
        val caps = cm.getNetworkCapabilities(cm.activeNetwork) ?: return false
        return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
    }

    /** What the page's status strip shows. */
    private fun statusJson(error: String?): JSONObject {
        val p = DataFeed.prefs(this)
        return JSONObject()
            .put("platform", "android")
            .put("version", runCatching { packageManager.getPackageInfo(packageName, 0).versionName }.getOrDefault("?"))
            .put("downloaded_at", p.getLong(DataFeed.KEY_DOWNLOADED_AT, 0L))
            .put("generated_at", p.getString(DataFeed.KEY_GENERATED_AT, "") ?: "")
            .put("schedule_hours", p.getInt(DataFeed.KEY_SCHEDULE_HOURS, 0))
            .put("notify", p.getBoolean(DataFeed.KEY_NOTIFY, false))
            .put("reminder_hour", ReminderWorker.hour(this))
            .put("watchlist", org.json.JSONArray(ReminderWorker.watchlist(this).toList()))
            .put("online", online())
            .put("refreshing", refreshing)
            .put("error", error ?: p.getString(DataFeed.KEY_LAST_ERROR, null))
    }

    private fun pushStatus(error: String?) {
        if (!pageReady) return
        web.evaluateJavascript("window.ipoRadarStatus && window.ipoRadarStatus(" + statusJson(error) + ")", null)
    }

    private fun inject(parts: Map<String, String>) {
        if (!pageReady) return
        val payload = JSONObject()
        for ((k, v) in parts) payload.put(k, JSONObject.wrap(JSONTokener(v).nextValue()))
        web.evaluateJavascript("window.ipoRadarLoad && window.ipoRadarLoad(" + payload + ")", null)
    }

    private fun refresh(manual: Boolean) {
        if (refreshing) return
        refreshing = true
        lastAutoRefresh = System.currentTimeMillis()
        if (manual) swipe.isRefreshing = true
        pushStatus(null)
        io.execute {
            val r = DataFeed.refresh(this)
            runOnUiThread {
                refreshing = false
                swipe.isRefreshing = false
                if (r.ok) DataFeed.cached(this)?.let { inject(it) }
                pushStatus(if (r.ok) null else (r.error ?: "refresh failed"))
            }
        }
    }

    private fun shareText(text: String, subject: String) {
        val i = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_SUBJECT, subject).putExtra(Intent.EXTRA_TEXT, text)
        runCatching { startActivity(Intent.createChooser(i, subject)) }
    }

    private fun shareFile(name: String, mime: String, content: String) {
        val dir = File(cacheDir, "shared").apply { mkdirs() }
        val f = File(dir, name).apply { writeText(content) }
        val uri = FileProvider.getUriForFile(this, "$packageName.files", f)
        val i = Intent(Intent.ACTION_SEND).setType(mime).putExtra(Intent.EXTRA_STREAM, uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        runCatching { startActivity(Intent.createChooser(i, name)) }
    }

    /** The page calls these; keep the surface tiny and every argument a plain string or number. */
    inner class Bridge {
        @JavascriptInterface fun platform(): String = "android"
        @JavascriptInterface fun status(): String = statusJson(null).toString()
        @JavascriptInterface fun refresh() { runOnUiThread { refresh(manual = true) } }
        @JavascriptInterface fun openExternal(url: String) { runCatching { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) } }
        @JavascriptInterface fun shareText(text: String, subject: String) { runOnUiThread { this@MainActivity.shareText(text, subject) } }
        @JavascriptInterface fun shareFile(name: String, mime: String, content: String) { runOnUiThread { this@MainActivity.shareFile(name, mime, content) } }

        @JavascriptInterface fun setSchedule(hours: Int) {
            DataFeed.prefs(this@MainActivity).edit().putInt(DataFeed.KEY_SCHEDULE_HOURS, hours).apply()
            RefreshWorker.schedule(this@MainActivity, hours)
            runOnUiThread { pushStatus(null) }
        }

        @JavascriptInterface fun setWatchlist(idsJson: String) {
            val clean = runCatching { val a = org.json.JSONArray(idsJson); org.json.JSONArray((0 until a.length()).map { a.getString(it) }).toString() }.getOrDefault("[]")
            DataFeed.prefs(this@MainActivity).edit().putString(ReminderWorker.KEY_WATCH, clean).apply()
        }

        @JavascriptInterface fun setReminderHour(hour: Int) {
            DataFeed.prefs(this@MainActivity).edit().putInt(ReminderWorker.KEY_HOUR, hour).apply()
            ReminderWorker.schedule(this@MainActivity, hour)
            if (hour >= 0) askNotificationPermission()
            runOnUiThread { pushStatus(null) }
        }

        @JavascriptInterface fun setNotify(on: Boolean) {
            DataFeed.prefs(this@MainActivity).edit().putBoolean(DataFeed.KEY_NOTIFY, on).apply()
            if (on) askNotificationPermission()
            runOnUiThread { pushStatus(null) }
        }
    }

    private fun askNotificationPermission() {
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            runOnUiThread { ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.POST_NOTIFICATIONS), 7) }
        }
    }

    override fun onDestroy() {
        io.shutdown()
        web.destroy()
        super.onDestroy()
    }
}
