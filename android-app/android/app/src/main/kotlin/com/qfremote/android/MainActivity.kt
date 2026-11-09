package com.qfremote.android

import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.Signature
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.view.WindowManager
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel
import java.io.File
import java.security.MessageDigest

/// 验签检查失败（携带回给 Dart 侧的错误码）。本机 Flutter 嵌入层没有
/// io.flutter.plugin.common.PlatformException 这个 Kotlin 类（DS 成稿
/// 原写法在 CI 编译期 Unresolved reference，见本线 DEV-5 留证），故用
/// 本地异常＋result.error 回传，错误码与文案与成稿一致。
private class ApkInspectException(val code: String, message: String) :
    Exception(message)

class MainActivity : FlutterActivity() {
    private val channelName = "qfremote/apk_verify"
    private val methodName = "inspectApk"

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, channelName)
            .setMethodCallHandler { call, result ->
                if (call.method != methodName) {
                    result.notImplemented()
                    return@setMethodCallHandler
                }
                try {
                    result.success(inspectApk(call.argument<String>("path")))
                } catch (e: ApkInspectException) {
                    result.error(e.code, e.message, null)
                } catch (e: Exception) {
                    result.error("INSPECT_FAILED", e.message ?: "APK 签名核验失败", null)
                }
            }
        // 2.4.5 B9：会话进行态屏幕常亮（FLAG_KEEP_SCREEN_ON），退出会话/
        // 切后台时清。B18：未知应用安装开关查询＋跳系统设置。
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "qfremote/screen")
            .setMethodCallHandler { call, result ->
                if (call.method != "setKeepScreenOn") {
                    result.notImplemented()
                    return@setMethodCallHandler
                }
                val on = call.argument<Boolean>("on") ?: false
                runOnUiThread {
                    if (on) {
                        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                    } else {
                        window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                    }
                }
                result.success(true)
            }
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "qfremote/install")
            .setMethodCallHandler { call, result ->
                when (call.method) {
                    "canInstallUnknown" -> {
                        val can = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                            packageManager.canRequestPackageInstalls()
                        } else {
                            true
                        }
                        result.success(can)
                    }
                    "openUnknownAppSourcesSettings" -> {
                        try {
                            val intent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                                Intent(
                                    Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                                    Uri.parse("package:$packageName"),
                                )
                            } else {
                                Intent(Settings.ACTION_SECURITY_SETTINGS)
                            }
                            startActivity(intent)
                            result.success(true)
                        } catch (e: Exception) {
                            result.error("OPEN_SETTINGS_FAILED", e.message ?: "打开设置失败", null)
                        }
                    }
                    else -> result.notImplemented()
                }
            }
    }

    private fun inspectApk(path: String?): Map<String, Any> {
        if (path.isNullOrBlank()) {
            throw ApkInspectException("INVALID_ARGUMENT", "APK 路径为空")
        }

        val apk = File(path)
        if (!apk.isFile) {
            throw ApkInspectException("FILE_NOT_FOUND", "APK 文件不存在")
        }

        val pm = applicationContext.packageManager
        val flags: Int = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            PackageManager.GET_SIGNING_CERTIFICATES
        } else {
            @Suppress("DEPRECATION")
            PackageManager.GET_SIGNATURES
        }

        val info = pm.getPackageArchiveInfo(path, flags)
            ?: throw ApkInspectException("APK_PARSE_FAILED", "APK 解析失败，无法读取包信息")

        val packageName = info.packageName
            ?: throw ApkInspectException("APK_PARSE_FAILED", "APK 缺少包名")

        val signers: Array<Signature> = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            val signingInfo = info.signingInfo
            val apkSigners = signingInfo?.apkContentsSigners

            // 部分系统对 v1-only APK 可能返回 null/empty，此时回退到旧 API，避免误报“无签名”。
            if (apkSigners != null && apkSigners.isNotEmpty()) {
                apkSigners
            } else {
                @Suppress("DEPRECATION")
                info.signatures
            }
        } else {
            @Suppress("DEPRECATION")
            info.signatures
        } ?: throw ApkInspectException("NO_SIGNERS", "未读取到签名者")

        if (signers.isEmpty()) {
            throw ApkInspectException("NO_SIGNERS", "未读取到签名者")
        }

        val signerCertSha256s = signers.map { sha256Hex(it.toByteArray()) }

        return mapOf(
            "packageName" to packageName,
            "signerCertSha256s" to signerCertSha256s,
        )
    }

    private fun sha256Hex(bytes: ByteArray): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(bytes)
        return digest.joinToString("") { "%02x".format(it.toInt() and 0xff) }
    }
}
