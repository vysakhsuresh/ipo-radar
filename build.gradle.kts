// IPO Radar - Android app. The screen is the web page in site/ (built by
// tools/build_site.py into the app's assets); the Kotlin shell adds offline
// bundling, online data refresh, pull-to-refresh and the launcher icon.
plugins {
    id("com.android.application") version "8.5.2" apply false
    id("org.jetbrains.kotlin.android") version "1.9.24" apply false
}
