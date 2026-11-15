import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.layerbit.iporadar"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.layerbit.iporadar"
        minSdk = 26
        targetSdk = 36
        versionCode = 3
        versionName = "1.0.0"
    }

    // Release signing from a keystore.properties that is NOT in the repo; without it
    // the release build stays unsigned instead of failing (same as Dawn Patrol).
    val keystoreFile = rootProject.file("keystore.properties")
    signingConfigs {
        create("release") {
            if (keystoreFile.exists()) {
                val props = Properties()
                keystoreFile.inputStream().use { props.load(it) }
                storeFile = rootProject.file(props.getProperty("storeFile"))
                storePassword = props.getProperty("storePassword")
                keyAlias = props.getProperty("keyAlias")
                keyPassword = props.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            if (keystoreFile.exists()) signingConfig = signingConfigs.getByName("release")
        }
    }

    buildFeatures { buildConfig = true }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }

    // The data snapshot changes on every refresh commit; never let lint block a release over it.
    lint { abortOnError = false; checkReleaseBuilds = false }
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
    implementation("androidx.core:core-ktx:1.17.0")
    implementation("androidx.core:core-splashscreen:1.0.1")
    implementation("androidx.activity:activity:1.11.0")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.webkit:webkit:1.11.0")
    implementation("androidx.swiperefreshlayout:swiperefreshlayout:1.1.0")
    implementation("androidx.work:work-runtime-ktx:2.10.0")
}
