package com.qfremote.android

import android.content.pm.PackageManager
import android.content.pm.Signature
import android.os.Build
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel
import io.flutter.plugin.common.PlatformException
import java.io.File
import java.security.MessageDigest

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
                } catch (e: Exception) {
                    when (e) {
                        is PlatformException -> result.error(e.code, e.message, e.details)
                        else -> result.error("INSPECT_FAILED", e.message ?: "APK 签名核验失败", null)
                    }
                }
            }
    }

    private fun inspectApk(path: String?): Map<String, Any> {
        if (path.isNullOrBlank()) {
            throw PlatformException("INVALID_ARGUMENT", "APK 路径为空", null)
        }

        val apk = File(path)
        if (!apk.isFile) {
            throw PlatformException("FILE_NOT_FOUND", "APK 文件不存在", null)
        }

        val pm = applicationContext.packageManager
        val flags: Int = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            PackageManager.GET_SIGNING_CERTIFICATES
        } else {
            @Suppress("DEPRECATION")
            PackageManager.GET_SIGNATURES
        }

        val info = pm.getPackageArchiveInfo(path, flags)
            ?: throw PlatformException("APK_PARSE_FAILED", "APK 解析失败，无法读取包信息", null)

        val packageName = info.packageName
            ?: throw PlatformException("APK_PARSE_FAILED", "APK 缺少包名", null)

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
        } ?: throw PlatformException("NO_SIGNERS", "未读取到签名者", null)

        if (signers.isEmpty()) {
            throw PlatformException("NO_SIGNERS", "未读取到签名者", null)
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
