#!/usr/bin/env bash
# QFRemote 安卓截图 + 看护实测（GitHub Ubuntu 模拟器里跑）。
# 前置（工作流已完成）：正式包在 prod/、测试 debug 包已编译、夹具服务器已在 8791 端口运行。
# 产出 shots/*.png 与日志；最后做断言：会话页自动点恰好 1 次、登录页 0 次。
set -u
ADB="${ANDROID_HOME:-$ANDROID_SDK_ROOT}/platform-tools/adb"
PKG=com.qfremote.android
mkdir -p shots
FAIL=0

# 等系统完全开机再动手（冷启动+装包高负载下 Pixel Launcher 容易弹 ANR 框，先稳住）
"$ADB" wait-for-device
for i in $(seq 1 60); do
  [ "$("$ADB" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ] && break
  sleep 2
done
sleep 8
# 关掉「后台应用 ANR 弹窗」并重启一次桌面进程：桌面在开机高负载时 ANR 后，
# 它的系统框会一直挂在所有截图上（点 Wait 坐标不可靠，直接从源头掐掉）
"$ADB" shell settings put global anr_show_background_dialogs 0 > /dev/null 2>&1
"$ADB" shell am force-stop com.google.android.apps.nexuslauncher > /dev/null 2>&1
sleep 2

dismiss_anr() {
  # 兜底：画面上还有「… isn't responding」系统框时，选最宽的 Wait 行点它
  "$ADB" shell uiautomator dump /sdcard/ui.xml > /dev/null 2>&1
  local xml
  xml=$("$ADB" shell cat /sdcard/ui.xml 2>/dev/null)
  if echo "$xml" | grep -q "isn.t responding"; then
    local best
    best=$(echo "$xml" | tr '>' '\n' | grep 'text="Wait"' | grep -o 'bounds="\[[0-9,]*\]\[[0-9,]*\]"' | \
      awk -F'[],[]' '{w=$4-$2; print w, $2, $3, $4, $5}' | sort -rn | head -1)
    if [ -n "$best" ]; then
      local cx cy
      cx=$(echo "$best" | awk '{print int(($2+$4)/2)}')
      cy=$(echo "$best" | awk '{print int(($3+$5)/2)}')
      echo "dismiss ANR dialog (tap Wait at $cx,$cy)"
      "$ADB" shell input tap "$cx" "$cy" > /dev/null 2>&1
      sleep 1
    fi
  fi
}

shot() { dismiss_anr; "$ADB" exec-out screencap -p > "shots/$1" 2>/dev/null; echo "shot $1 ($(wc -c < "shots/$1") bytes)"; }
ctl() { curl -s "http://127.0.0.1:8791/ctl/$1" > /dev/null; }
launch() {
  "$ADB" shell am force-stop $PKG > /dev/null 2>&1
  "$ADB" shell am start -n $PKG/$PKG.MainActivity > /dev/null 2>&1
}
seed_prefs() {
  "$ADB" shell am force-stop $PKG > /dev/null 2>&1
  printf '%s' "$1" > /tmp/prefs.xml
  "$ADB" push /tmp/prefs.xml /data/local/tmp/prefs.xml > /dev/null 2>&1
  "$ADB" shell run-as $PKG mkdir -p shared_prefs > /dev/null 2>&1
  "$ADB" shell run-as $PKG cp /data/local/tmp/prefs.xml shared_prefs/FlutterSharedPreferences.xml > /dev/null 2>&1
  # 回读验证真种进去了（run-as 失败时别默默往下跑）
  local back
  back=$("$ADB" shell run-as $PKG cat shared_prefs/FlutterSharedPreferences.xml 2>/dev/null | tr -d '\r\n')
  echo "prefs seeded: $back"
}
THEME_XML='<?xml version="1.0" encoding="utf-8" standalone="yes" ?>
<map>
    <string name="flutter.theme">dark</string>
</map>'
PENDING_XML='<?xml version="1.0" encoding="utf-8" standalone="yes" ?>
<map>
    <string name="flutter.pending_update_version">9.9.9</string>
</map>'

echo "=== P1 正式包：启动画面 + 真实控制台登录页（不登录） ==="
PROD_APK=$(ls prod/*.apk 2>/dev/null | head -1)
echo "prod apk: $PROD_APK"
"$ADB" install -r "$PROD_APK" || FAIL=1
launch; dismiss_anr; sleep 1; shot 01-splash.png
sleep 12; shot 02-console-login.png
"$ADB" uninstall $PKG > /dev/null 2>&1

echo "=== P2 测试包：会话断线看护（应自动点 1 次并恢复） ==="
"$ADB" install -r android-app/build/app/outputs/flutter-apk/app-debug.apk || FAIL=1
ctl fake-off; ctl session
"$ADB" logcat -c > /dev/null 2>&1
launch; sleep 4; shot 03-session-disconnected.png
sleep 20; shot 04-session-recovered.png
"$ADB" logcat -d > shots/logcat-session.txt 2>/dev/null
CLICKS=$(grep -c "QFWATCHDOG clicked" shots/logcat-session.txt || true)
echo "session clicks=$CLICKS"

echo "=== P3 登录页诱饵：看护零点击 ==="
ctl login
"$ADB" logcat -c > /dev/null 2>&1
launch; sleep 10; shot 05-login-page.png
"$ADB" logcat -d > shots/logcat-login.txt 2>/dev/null
LOGIN_CLICKS=$(grep -c "QFWATCHDOG clicked" shots/logcat-login.txt || true)
echo "login clicks=$LOGIN_CLICKS"

echo "=== P4 更新提醒（会话内只提醒：徽标+一条提示） ==="
ctl fake-on
launch; sleep 8; shot 06-update-remind.png
# 关掉假新版：否则后面每次启动的会话检查都会重新记下待更新，把 P6 的断线页拦成强制页
ctl fake-off

echo "=== P5 深灰主题 ==="
seed_prefs "$THEME_XML"
launch; sleep 6; shot 07-dark-theme.png

echo "=== P6 整页断线友好页 ==="
ctl dead
launch; sleep 6; shot 08-offline.png

echo "=== P7 强制更新页（退出重进命中待更新） ==="
seed_prefs "$PENDING_XML"
ctl fake-on
launch; sleep 6; shot 09-force-update.png
# 点「立即更新」：pixel_6（1080x2400）下卡片按钮位置固定，直接点中心；
# 之前从 uiautomator 解析坐标两次都偏，固定坐标更可靠
echo "tap 立即更新 at 540,1415"
"$ADB" shell input tap 540 1415 > /dev/null 2>&1
sleep 10; shot 10-force-downloaded.png

{
  echo "session_clicks=$CLICKS (expect 1)"
  echo "login_clicks=$LOGIN_CLICKS (expect 0)"
} > shots/ASSERTIONS.txt
[ "$CLICKS" = "1" ] || FAIL=1
[ "$LOGIN_CLICKS" = "0" ] || FAIL=1
cat shots/ASSERTIONS.txt
ls -la shots/
exit $FAIL
