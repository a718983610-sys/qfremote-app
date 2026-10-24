#!/usr/bin/env bash
# QFRemote 安卓截图 + 看护实测（GitHub macOS 模拟器里跑）。
# 前置（工作流已完成）：正式包在 prod/、测试 debug 包已编译、夹具服务器已在 8791 端口运行。
# 产出 shots/*.png 与日志；最后做断言：会话页自动点恰好 1 次、登录页 0 次。
set -u
ADB="${ANDROID_HOME:-$ANDROID_SDK_ROOT}/platform-tools/adb"
PKG=com.qfremote.android
mkdir -p shots
FAIL=0

shot() { "$ADB" exec-out screencap -p > "shots/$1" 2>/dev/null; echo "shot $1 ($(wc -c < "shots/$1") bytes)"; }
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
  echo "prefs seeded"
}
THEME_XML='<?xml version="1.0" encoding="utf-8" standalone="yes" ?>
<map>
    <string name="flutter.qf_theme">dark</string>
</map>'
PENDING_XML='<?xml version="1.0" encoding="utf-8" standalone="yes" ?>
<map>
    <string name="flutter.pending_update_version">9.9.9</string>
</map>'

"$ADB" wait-for-device
"$ADB" shell settings put global window_animation_scale 0 > /dev/null 2>&1

echo "=== P1 正式包：启动画面 + 真实控制台登录页（不登录） ==="
"$ADB" install -r prod/QFRemote-v1.0.4.apk || FAIL=1
launch; sleep 1.3; shot 01-splash.png
sleep 6; shot 02-console-login.png
"$ADB" uninstall $PKG > /dev/null 2>&1

echo "=== P2 测试包：会话断线看护（应自动点 1 次并恢复） ==="
"$ADB" install -r android-app/build/app/outputs/flutter-apk/app-debug.apk || FAIL=1
ctl fake-off; ctl session
"$ADB" logcat -c > /dev/null 2>&1
launch; sleep 3; shot 03-session-disconnected.png
sleep 11; shot 04-session-recovered.png
"$ADB" logcat -d > shots/logcat-session.txt 2>/dev/null
CLICKS=$(grep -c "QFWATCHDOG clicked" shots/logcat-session.txt || true)
echo "session clicks=$CLICKS"

echo "=== P3 登录页诱饵：看护零点击 ==="
ctl login
"$ADB" logcat -c > /dev/null 2>&1
launch; sleep 8; shot 05-login-page.png
"$ADB" logcat -d > shots/logcat-login.txt 2>/dev/null
LOGIN_CLICKS=$(grep -c "QFWATCHDOG clicked" shots/logcat-login.txt || true)
echo "login clicks=$LOGIN_CLICKS"

echo "=== P4 更新提醒（会话内只提醒：徽标+一条提示） ==="
ctl fake-on
launch; sleep 6; shot 06-update-remind.png

echo "=== P5 深灰主题 ==="
seed_prefs "$THEME_XML"
launch; sleep 5; shot 07-dark-theme.png

echo "=== P6 整页断线友好页 ==="
ctl dead
launch; sleep 5; shot 08-offline.png

echo "=== P7 强制更新页（退出重进命中待更新） ==="
seed_prefs "$PENDING_XML"
launch; sleep 5; shot 09-force-update.png
# 找到「立即更新」按钮坐标（Flutter 语义节点）并点击
"$ADB" shell uiautomator dump /sdcard/ui.xml > /dev/null 2>&1
BOUNDS=$("$ADB" shell cat /sdcard/ui.xml 2>/dev/null | tr '>' '\n' | grep '立即更新' | grep -o 'bounds="\[[0-9,]*\]\[[0-9,]*\]"' | head -1)
if [ -n "$BOUNDS" ]; then
  XY=$(echo "$BOUNDS" | sed 's/[^0-9,]/ /g' | awk '{print int(($1+$3)/2), int(($2+$4)/2)}')
  set -- $XY; echo "tap 立即更新 at $1,$2"
  "$ADB" shell input tap "$1" "$2" > /dev/null 2>&1
else
  echo "uiautomator 没找到按钮，用估算坐标"
  "$ADB" shell input tap 540 1560 > /dev/null 2>&1
fi
sleep 8; shot 10-force-downloaded.png

{
  echo "session_clicks=$CLICKS (expect 1)"
  echo "login_clicks=$LOGIN_CLICKS (expect 0)"
} > shots/ASSERTIONS.txt
[ "$CLICKS" = "1" ] || FAIL=1
[ "$LOGIN_CLICKS" = "0" ] || FAIL=1
cat shots/ASSERTIONS.txt
ls -la shots/
exit $FAIL
