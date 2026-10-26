import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.layerbit.iporadar"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.layerbit.iporadar"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "0.1"
    }

    // Release signing from a keystore.properties that is NOT in the repo; without it
    // the release build stays unsigned instead of failing (same as Dawn Patrol).
    signingConfigs {
        create("release") {
            val props = Properties()
            val f = rootProject.file("keystore.properties")
            if (f.exists()) {
                f.inputStream().use { props.load(it) }
                storeFile = rootProject.file(props.getProperty("storeFile"))
                storePassword = props.getProperty("storePassword")
                keyAlias = props.getProperty("keyAlias")
                keyPassword = props.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            val f = rootProject.file("keystore.properties")
            if (f.exists()) signingConfig = signingConfigs.getByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

// The page and its data snapshot are generated into the assets folder before every
// build, so the APK always carries the current site/ sources and data/ files.
val buildWeb = tasks.register<Exec>("buildWeb") {
    description = "Build the web page + data snapshot into app assets"
    workingDir = rootProject.projectDir
    val python = if (System.getProperty("os.name").lowercase().contains("win")) "python" else "python3"
    commandLine(python, "tools/build_site.py", "--out", "app/src/main/assets/www")
}
tasks.named("preBuild") { dependsOn(buildWeb) }

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.webkit:webkit:1.11.0")
    implementation("androidx.swiperefreshlayout:swiperefreshlayout:1.1.0")
    implementation("androidx.work:work-runtime-ktx:2.9.1")
}
