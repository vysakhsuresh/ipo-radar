package com.layerbit.iporadar

import android.annotation.SuppressLint
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.view.View
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout
import androidx.webkit.WebViewAssetLoader
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

/**
 * IPO Radar is the web page in site/, bundled into the APK (assets/www) so it
 * works with no network, plus a refresh of the three data files from the
 * repository whenever the app opens or the user pulls down. Nothing leaves the
 * phone: the only requests are GETs for public JSON files.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var web: WebView
    private lateinit var swipe: SwipeRefreshLayout
    private val io = Executors.newSingleThreadExecutor()
    private var pageReady = false

    companion object {
        // Served from a private https origin so localStorage and relative fetches behave.
        private const val ORIGIN = "https://appassets.androidplatform.net"
        private const val START = "$ORIGIN/assets/www/index.html"
        private const val RAW = "https://raw.githubusercontent.com/vysakhsuresh/ipo-radar/main/"
        private val FILES = mapOf(
            "live" to "data/scored.json",
            "params" to "model/params.json",
            "history" to "data/history.json",
        )
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
                val url = request.url
                if (url.host == "appassets.androidplatform.net") return false
                // Get help, Buy me a coffee, source links: hand them to the browser.
                runCatching { startActivity(Intent(Intent.ACTION_VIEW, url)) }
                return true
            }

            override fun onPageFinished(view: WebView, url: String) {
                pageReady = true
                applyCachedData()
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
        web.loadUrl(START)
    }

    /** The page calls these; keep the surface tiny. */
    inner class Bridge {
        @android.webkit.JavascriptInterface
        fun refresh() { runOnUiThread { refresh(manual = true) } }

        @android.webkit.JavascriptInterface
        fun openExternal(url: String) {
            runCatching { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }
        }

        @android.webkit.JavascriptInterface
        fun platform(): String = "android"
    }

    private fun cacheFile(key: String) = File(filesDir, "ipo-$key.json")

    /** Push the last downloaded data (if any) into the page before going online. */
    private fun applyCachedData() {
        val parts = FILES.keys.mapNotNull { k -> cacheFile(k).takeIf { it.exists() }?.let { k to it.readText() } }
        if (parts.size == FILES.size) inject(parts.toMap())
    }

    private fun inject(parts: Map<String, String>) {
        if (!pageReady) return
        val payload = JSONObject()
        for ((k, v) in parts) payload.put(k, JSONObject.wrap(org.json.JSONTokener(v).nextValue()))
        web.evaluateJavascript("window.ipoRadarLoad && window.ipoRadarLoad(" + payload.toString() + ")", null)
    }

    private fun refresh(manual: Boolean) {
        if (manual) swipe.isRefreshing = true
        io.execute {
            val got = HashMap<String, String>()
            var ok = true
            for ((k, path) in FILES) {
                val text = download(RAW + path)
                if (text == null) { ok = false; break }
                got[k] = text
            }
            runOnUiThread {
                swipe.isRefreshing = false
                if (ok) {
                    for ((k, v) in got) cacheFile(k).writeText(v)
                    inject(got)
                    if (manual) Toast.makeText(this, R.string.refreshing, Toast.LENGTH_SHORT).show()
                } else if (manual) {
                    Toast.makeText(this, R.string.refresh_failed, Toast.LENGTH_SHORT).show()
                }
            }
        }
    }

    private fun download(url: String): String? = runCatching {
        val c = URL(url).openConnection() as HttpURLConnection
        c.connectTimeout = 15000; c.readTimeout = 20000
        c.setRequestProperty("Accept", "application/json")
        try {
            if (c.responseCode != 200) return null
            c.inputStream.bufferedReader().use { it.readText() }
        } finally { c.disconnect() }
    }.getOrNull()

    override fun onDestroy() {
        io.shutdown()
        web.destroy()
        super.onDestroy()
    }
}
