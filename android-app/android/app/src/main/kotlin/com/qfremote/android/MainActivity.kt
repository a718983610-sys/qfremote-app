package com.qfremote.android

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.Signature
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.os.StatFs
import android.provider.Settings
import android.view.WindowManager
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
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
    private val pendingPermissionResults =
        mutableMapOf<Int, MethodChannel.Result>()
    private var permissionRequestCode = 9000

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        // A-06：JNI/通道调用只走一个桥接对象——全 App 只注册 `qfremote/bridge`
        // 一个 MethodChannel，方法名按域加前缀（screen./storage./install./
        // apk./session./permissions.）。旧的四个分散通道已合并，Dart 侧经
        // QfBridge 调用；包名变更时桥接通道名保持不动。
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "qfremote/bridge")
            .setMethodCallHandler { call, result ->
                when (call.method) {
                    "screen.setKeepScreenOn" -> {
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
                    "storage.getFreeSpaceBytes" -> {
                        // 2.4.5 B23：下载前剩余空间检查（StatFs 取指定目录所在分区
                        // 可用字节；路径无效/异常时回 null，Dart 侧保守处理不拦截）。
                        try {
                            val path = call.argument<String>("path")
                            if (path.isNullOrBlank()) {
                                result.success(null)
                            } else {
                                result.success(StatFs(path).availableBytes)
                            }
                        } catch (e: Exception) {
                            result.success(null)
                        }
                    }
                    "install.canInstallUnknown" -> {
                        val can = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                            packageManager.canRequestPackageInstalls()
                        } else {
                            true
                        }
                        result.success(can)
                    }
                    "install.openUnknownAppSourcesSettings" -> {
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
                    "apk.inspectApk" -> {
                        try {
                            result.success(inspectApk(call.argument<String>("path")))
                        } catch (e: ApkInspectException) {
                            result.error(e.code, e.message, null)
                        } catch (e: Exception) {
                            result.error("INSPECT_FAILED", e.message ?: "APK 签名核验失败", null)
                        }
                    }
                    "session.startForeground" -> {
                        val label = call.argument<String>("label") ?: "正在远程会话"
                        try {
                            val intent = Intent(this, QfSessionService::class.java)
                                .putExtra(QfSessionService.EXTRA_LABEL, label)
                            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                                startForegroundService(intent)
                            } else {
                                startService(intent)
                            }
                            result.success(true)
                        } catch (e: Exception) {
                            result.error("START_FOREGROUND_FAILED", e.message ?: "启动前台服务失败", null)
                        }
                    }
                    "session.stopForeground" -> {
                        try {
                            stopService(Intent(this, QfSessionService::class.java))
                            result.success(true)
                        } catch (e: Exception) {
                            result.error("STOP_FOREGROUND_FAILED", e.message ?: "停止前台服务失败", null)
                        }
                    }
                    "session.wakeBriefly" -> {
                        // A-02：WakeLock 只作瞬时唤醒（远程输入到达时亮屏 5 秒，
                        // 用完即放），不作常驻保活（RustDesk MainService 同款）。
                        try {
                            val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
                            val wakeLock = pm.newWakeLock(
                                PowerManager.SCREEN_BRIGHT_WAKE_LOCK or
                                    PowerManager.ACQUIRE_CAUSES_WAKEUP,
                                "QFRemote:wakeBriefly",
                            )
                            wakeLock.acquire(5000)
                            result.success(true)
                        } catch (e: Exception) {
                            result.error("WAKE_FAILED", e.message ?: "唤醒失败", null)
                        }
                    }
                    "permissions.request" -> {
                        requestPermission(call.argument<String>("kind"), result)
                    }
                    "permissions.status" -> {
                        result.success(permissionStatus(call.argument<String>("kind")))
                    }
                    "permissions.openAppSettings" -> {
                        try {
                            val intent = Intent(
                                Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                                Uri.parse("package:$packageName"),
                            )
                            startActivity(intent)
                            result.success(true)
                        } catch (e: Exception) {
                            result.error("OPEN_SETTINGS_FAILED", e.message ?: "打开设置失败", null)
                        }
                    }
                    "background.schedulePeriodicSync" -> {
                        // A-01 第二档：周期同步走系统调度（JobScheduler）。
                        // Dart 侧已拦 <15 分钟，原生侧再钳制一次；失败回
                        // false（不抛 PlatformException，QfBridge 按
                        // false 处理，调用方不冒充已调度）。
                        val taskId = call.argument<String>("taskId") ?: ""
                        val wifiOnly = call.argument<Boolean>("wifiOnly") ?: true
                        val chargingOnly =
                            call.argument<Boolean>("chargingOnly") ?: false
                        val batteryNotLow =
                            call.argument<Boolean>("batteryNotLow") ?: true
                        val intervalMinutes =
                            (call.argument<Int>("intervalMinutes") ?: 15)
                                .coerceAtLeast(15)
                        try {
                            result.success(
                                QfSyncScheduler.schedulePeriodicSync(
                                    this,
                                    taskId,
                                    wifiOnly,
                                    chargingOnly,
                                    batteryNotLow,
                                    intervalMinutes,
                                ),
                            )
                        } catch (e: Exception) {
                            result.success(false)
                        }
                    }
                    "background.cancelPeriodicSync" -> {
                        val taskId = call.argument<String>("taskId") ?: ""
                        try {
                            QfSyncScheduler.cancelPeriodicSync(this, taskId)
                            result.success(true)
                        } catch (e: Exception) {
                            result.success(false)
                        }
                    }
                    else -> result.notImplemented()
                }
            }
    }

    /** A-03：运行时权限申请（申请前调用方先看一句话解释，见 Dart 侧权限服务）。 */
    private fun requestPermission(kind: String?, result: MethodChannel.Result) {
        if (kind == "notifications") {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
                result.success("granted")
                return
            }
            if (ContextCompat.checkSelfPermission(
                    this,
                    Manifest.permission.POST_NOTIFICATIONS,
                ) == PackageManager.PERMISSION_GRANTED
            ) {
                result.success("granted")
                return
            }
            val code = ++permissionRequestCode
            pendingPermissionResults[code] = result
            ActivityCompat.requestPermissions(
                this,
                arrayOf(Manifest.permission.POST_NOTIFICATIONS),
                code,
            )
            return
        }
        // microphone / overlay / accessibility / battery：走系统设置页引导，
        // 不在这里弹系统框（见 permission_service.dart 的 requiresSettingsPage）。
        result.success("settings_required")
    }

    private fun permissionStatus(kind: String?): String {
        if (kind == "notifications") {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return "granted"
            return if (ContextCompat.checkSelfPermission(
                    this,
                    Manifest.permission.POST_NOTIFICATIONS,
                ) == PackageManager.PERMISSION_GRANTED
            ) {
                "granted"
            } else if (ActivityCompat.shouldShowRequestPermissionRationale(
                    this,
                    Manifest.permission.POST_NOTIFICATIONS,
                )
            ) {
                "denied"
            } else {
                "permanently_denied"
            }
        }
        return "unknown"
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray,
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        val result = pendingPermissionResults.remove(requestCode) ?: return
        val granted = grantResults.isNotEmpty() &&
            grantResults[0] == PackageManager.PERMISSION_GRANTED
        if (granted) {
            result.success("granted")
        } else if (ActivityCompat.shouldShowRequestPermissionRationale(
                this,
                Manifest.permission.POST_NOTIFICATIONS,
            )
        ) {
            result.success("denied")
        } else {
            result.success("permanently_denied")
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
