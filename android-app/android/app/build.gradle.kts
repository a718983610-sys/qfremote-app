import java.io.FileInputStream
import java.util.Properties

plugins {
    id("com.android.application")
    id("kotlin-android")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

// QFRemote 专属签名：key.properties 存在时用发布签名（CI 从仓库 Secret 写入），
// Release builds require a complete signing configuration. Explicit development
// builds may opt into a debug signer; that artifact must stay in the dev channel.
val keystoreProperties = Properties()
val keystorePropertiesFile = rootProject.file("key.properties")
if (keystorePropertiesFile.exists()) {
    keystoreProperties.load(FileInputStream(keystorePropertiesFile))
}

val allowDebugReleaseSigning = providers.environmentVariable("QFR_ALLOW_DEBUG_RELEASE_SIGNING")
    .map { it == "1" }.getOrElse(false)
val releaseSigningComplete = keystorePropertiesFile.exists() &&
    listOf("keyAlias", "keyPassword", "storeFile", "storePassword").all {
        !keystoreProperties.getProperty(it).isNullOrBlank()
    } && rootProject.file("app").resolve(keystoreProperties.getProperty("storeFile", "")).isFile

gradle.taskGraph.whenReady {
    if (allTasks.any { it.project == project && it.name.contains("Release") }) {
        if (!releaseSigningComplete && !allowDebugReleaseSigning) {
            throw GradleException("Release signing is missing or incomplete; refusing a debug-signed release artifact.")
        }
        if (!releaseSigningComplete) {
            logger.warn("QFREMOTE DEV ONLY: explicit debug signing override; this APK MUST NOT be published as production.")
        }
    }
}

android {
    namespace = "com.qfremote.android"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }

    kotlinOptions {
        jvmTarget = JavaVersion.VERSION_11.toString()
    }

    defaultConfig {
        applicationId = "com.qfremote.android"
        // You can update the following values to match your application needs.
        // For more information, see: https://flutter.dev/to/review-gradle-config.
        minSdk = flutter.minSdkVersion
        targetSdk = flutter.targetSdkVersion
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }

    signingConfigs {
        create("release") {
            keyAlias = keystoreProperties["keyAlias"] as String?
            keyPassword = keystoreProperties["keyPassword"] as String?
            storeFile = (keystoreProperties["storeFile"] as String?)?.let { file(it) }
            storePassword = keystoreProperties["storePassword"] as String?
        }
    }

    buildTypes {
        release {
            signingConfig = if (releaseSigningComplete) {
                signingConfigs.getByName("release")
            } else {
                signingConfigs.getByName("debug")
            }
        }
    }
}

flutter {
    source = "../.."
}
