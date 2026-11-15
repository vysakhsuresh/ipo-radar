# IPO Radar R8 rules.

# The page calls MainActivity.Bridge through addJavascriptInterface; the method names are
# looked up by reflection at runtime, so every @JavascriptInterface method must survive
# with its exact name.
-keepattributes JavascriptInterface
-keepclassmembers class com.layerbit.iporadar.MainActivity$Bridge {
    @android.webkit.JavascriptInterface <methods>;
}
-keep class com.layerbit.iporadar.MainActivity$Bridge

# WorkManager instantiates workers by class name (stored in its database) via the
# (Context, WorkerParameters) constructor. WorkManager ships its own consumer rules;
# these make the dependency explicit for our workers.
-keep class com.layerbit.iporadar.RefreshWorker { <init>(android.content.Context, androidx.work.WorkerParameters); }
-keep class com.layerbit.iporadar.ReminderWorker { <init>(android.content.Context, androidx.work.WorkerParameters); }

# Readable stack traces in Play vitals.
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile
