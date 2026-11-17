import java.io.FileInputStream
import java.util.Properties

plugins {
    id("com.android.application")
    id("kotlin-android")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

// QFRemote 专属签名：key.properties 存在时用发布签名（CI 从仓库 Secret 写入）。
// 政策（2026-11-16 站长终局拍板）：Release 构建强制正式签名，签名不完整即
// 构建失败；任何环境变量都不能绕过（已废止的调试签名环境变量旁路
// 已彻底删除）。Debug 签名只允许 debug 构建类型（flutter build apk
// --debug），绝不允许出现在 release 产物上。
val keystoreProperties = Properties()
val keystorePropertiesFile = rootProject.file("key.properties")
if (keystorePropertiesFile.exists()) {
    keystoreProperties.load(FileInputStream(keystorePropertiesFile))
}

val releaseSigningComplete = keystorePropertiesFile.exists() &&
    listOf("keyAlias", "keyPassword", "storeFile", "storePassword").all {
        !keystoreProperties.getProperty(it).isNullOrBlank()
    } && rootProject.file("app").resolve(keystoreProperties.getProperty("storeFile", "")).isFile

gradle.taskGraph.whenReady {
    if (allTasks.any { it.project == project && it.name.contains("Release") }) {
        // 无条件抛错门：签名不完整即拒绝构建，任何环境变量都不能绕过。
        if (!releaseSigningComplete) {
            throw GradleException("Release signing is missing or incomplete; refusing a debug-signed release artifact. Release builds require a complete release signing configuration (key.properties + keystore); no environment variable can override this.")
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
            // 不再回退 debug 签名：release 构建类型只用正式签名。签名不完整时
            // 上方的 taskGraph 门已抛错、构建失败，不会走到这里。注意不能在
            // 这里直接 throw——配置期抛错会连 --debug 构建一起毒死；拦截点
            // 是 taskGraph（仅 Release 任务在图时生效）＋ release-gate 的
            // 产物签名复核。
            signingConfig = signingConfigs.getByName("release")
        }
    }
}

flutter {
    source = "../.."
}
