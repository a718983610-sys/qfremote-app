#!/usr/bin/env bash
# Release 签名门负向测试（2026-11-16，两处签名修复之①）：
# 无 key.properties（缺失密钥）时 `flutter build apk --release` 必须失败，
# 绝不静默产 debug 签名包；任何环境变量都不能绕过。
#
# 分两层：
#   M 静态（默认跑，沙箱可跑）：门文本无条件、release 只用正式签名、
#     dev job 只跑 --debug、仓库里不许躺着 key.properties、第二道拦截
#     verify-apk 须在 release_gate.sh 里落盘（M6）。
#   G 动态（需 --gradle，CI release job 跑）：在临时拷贝里真实跑
#     flutter build apk --release：
#     G1 无 key.properties → 必须失败且日志含
#        `Release signing is missing or incomplete`；
#     G2 设 QFR_ALLOW_DEBUG_RELEASE_SIGNING=1＋无 key.properties → 同样失败；
#     G3 自签测试密钥＋key.properties 齐全 → 门不得误拒（产物随后还会被
#        verify-apk 拒绝，那是第二道拦截的职责，G3 只断言第一道门不误拒）。
#     沙箱跑不了 G（Java 过不了出口代理，TLS 拦截＋HttpURLConnection 在
#     代理 CONNECT 阶段抛错；/tmp 是 512M tmpfs），G 未加 --gradle 时 SKIP。
#
# 用法（在 android-app/ 下）：
#   tools/test_release_signing_gate.sh [--gradle] [--keep-tmp]
# 退出码：任一 FAIL 即非 0；SKIP 不算失败，但会在汇总里列出。
set -uo pipefail
cd "$(dirname "$0")/.."

APP_ROOT="$PWD"
GRADLE_KTS="android/app/build.gradle.kts"
WORKFLOW="../.github/workflows/android.yml"
GATE="tools/release_gate.sh"

RUN_GRADLE=0
KEEP_TMP=0
for arg in "$@"; do
  case "$arg" in
    --gradle) RUN_GRADLE=1 ;;
    --keep-tmp) KEEP_TMP=1 ;;
    -h|--help)
      sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "未知参数：$arg（可用 --gradle / --keep-tmp）"; exit 2 ;;
  esac
done

PASS=0; FAIL=0; SKIP=0
declare -a RESULTS
ok()   { PASS=$((PASS+1)); RESULTS+=("PASS $1"); echo "PASS $1"; }
bad()  { FAIL=$((FAIL+1)); RESULTS+=("FAIL $1"); echo "FAIL $1"; }
skip() { SKIP=$((SKIP+1)); RESULTS+=("SKIP $1 —— $2"); echo "SKIP $1 —— $2"; }

TMPDIR_BASE="${SIGNING_GATE_TMPDIR:-${TMPDIR:-/tmp}}"
WORK="$(mktemp -d "$TMPDIR_BASE/signing-gate-XXXXXX")"
cleanup() {
  if [ "$KEEP_TMP" -eq 1 ]; then echo "临时目录保留：$WORK"; else rm -rf "$WORK"; fi
}
trap cleanup EXIT

# ---------- M 静态 ----------
# M1：仓库里不许躺着 key.properties（正式密钥只由 CI 从 Secret 写入）。
if [ -f android/key.properties ]; then
  bad "M1 仓库无 key.properties：android/key.properties 已存在（正式密钥不许入库）"
else
  ok "M1 仓库无 key.properties：缺失密钥是默认状态，门必须能拦住它"
fi

# M2：抛错门无条件——throw 在 if (!releaseSigningComplete) 内，文案含
# 缺失提示，且无任何 getenv/环境变量读取。
if grep -q 'if (!releaseSigningComplete)' "$GRADLE_KTS" \
  && grep -q 'throw GradleException' "$GRADLE_KTS" \
  && grep -q 'Release signing is missing or incomplete' "$GRADLE_KTS" \
  && grep -q 'no environment variable can override this' "$GRADLE_KTS" \
  && ! grep -qE 'getenv|System\.getenv|QFR_ALLOW' "$GRADLE_KTS"; then
  ok "M2 抛错门无条件：!releaseSigningComplete 即 throw，文案含缺失提示，无 getenv/QFR_ALLOW"
else
  bad "M2 抛错门无条件：build.gradle.kts 未达标"
fi

# M3：release 只用正式签名，无 debug 回退。
if grep -q 'signingConfig = signingConfigs.getByName("release")' "$GRADLE_KTS" \
  && ! grep -qE 'getByName\("debug"\)|signingConfigs\.debug|debugSigning' "$GRADLE_KTS"; then
  ok "M3 release 无 debug 回退：只用 signingConfigs.getByName(\"release\")"
else
  bad "M3 release 无 debug 回退：仍有 debug 回退痕迹"
fi

# M4：签名完整性判定覆盖四项＋keystore 文件存在性。
if grep -q '"keyAlias", "keyPassword", "storeFile", "storePassword"' "$GRADLE_KTS" \
  && grep -q 'isFile' "$GRADLE_KTS"; then
  ok "M4 完整性判定：四项 key.properties 字段＋keystore 文件存在性全查"
else
  bad "M4 完整性判定：四项字段或 keystore 存在性检查缺失"
fi

# M5：工作流 dev job 只跑 --debug，release job 仍跑 --release，无开关。
if grep -q 'flutter build apk --debug' "$WORKFLOW" \
  && grep -q 'flutter build apk --release' "$WORKFLOW" \
  && ! grep -q 'QFR_ALLOW' "$WORKFLOW"; then
  ok "M5 工作流：dev 只跑 --debug、release 仍跑 --release、无 QFR_ALLOW"
else
  bad "M5 工作流：dev/release 构建命令或开关残留异常"
fi

# M6：第二道拦截必须落盘——release_gate.sh 须提供 verify-apk 子命令
# （拒绝 Android Debug 证书＋指纹白名单复核，打印 OK 签名复核通过），
# 且期望指纹与 lib/core/constants.dart 的 kExpectedApkCertSha256 逐字一致。
# 背景：堵死线的补丁（BYPASS-BLOCK-PATCH）给核验树加了这一段，主工作树
# 的 release_gate.sh 仍是旧版（无 verify-apk），CI 跑法里“verify-apk
# 打印 OK 签名复核通过”一步在主树现状下跑不起来——须另线把该 hunk
# 移植到主树，本脚本只测不改，故此处如实判 FAIL。
GATE_FP="$(grep -oE 'EXPECTED_APK_CERT_SHA256S="[0-9a-f]+"' "$GATE" 2>/dev/null | cut -d'"' -f2)"
DART_FP="$(grep -A1 'kExpectedApkCertSha256 =' lib/core/constants.dart | grep -oE "'[0-9a-f]{64}'" | tr -d "'")"
if grep -q 'verify_apk_signing' "$GATE" && grep -q 'verify-apk' "$GATE" \
  && grep -q 'Android Debug' "$GATE" \
  && [ -n "$GATE_FP" ] && [ "$GATE_FP" = "$DART_FP" ]; then
  ok "M6 第二道拦截已落盘：release_gate.sh 含 verify-apk，指纹与 kExpectedApkCertSha256 一致"
else
  bad "M6 第二道拦截未落盘：主树 release_gate.sh 无 verify-apk（gate 指纹=[$GATE_FP]，dart 指纹=[$DART_FP]）——须另线移植堵死补丁的 release_gate.sh hunk，本线只测不改"
fi

# ---------- G 动态（Gradle 第一道拦截，需 --gradle） ----------
if [ "$RUN_GRADLE" -eq 1 ]; then
  FLUTTER_BIN="${FLUTTER:-/home/hatch/tools/flutter-3.47.8/bin/flutter}"
  if [ ! -x "$FLUTTER_BIN" ]; then
    skip "G1-G3 Gradle 真实构建" "无 flutter：$FLUTTER_BIN"
  elif [ -z "${ANDROID_HOME:-}" ] || [ ! -d "$ANDROID_HOME/build-tools" ]; then
    skip "G1-G3 Gradle 真实构建" "无 Android SDK（ANDROID_HOME 未设或无 build-tools）"
  else
    PERSIST_LOG_DIR="$APP_ROOT/../verify-logs/signing-gate"
    [ -d "$PERSIST_LOG_DIR" ] || PERSIST_LOG_DIR="$WORK"
    gradle_probe() { # $1=用例名 $2=是否设变量(0/1) $3=是否放正式签名(0/1) $4=日志名
      local name="$1" setvar="$2" withsign="$3" log="$PERSIST_LOG_DIR/$4"
      local copy="$WORK/gradle-$name"
      cp -r "$APP_ROOT" "$copy" 2>/dev/null
      rm -rf "$copy/build" "$copy/.dart_tool"
      if [ "$withsign" -eq 1 ]; then
        keytool -genkeypair -noprompt -alias qftest -keyalg RSA -keysize 2048 \
          -validity 10000 -dname "CN=QFRemote Test, O=QFRemote, C=CN" \
          -keystore "$copy/android/app/qfremote-test.jks" \
          -storepass android -keypass android >/dev/null 2>&1
        cat > "$copy/android/key.properties" <<EOF
storePassword=android
keyPassword=android
keyAlias=qftest
storeFile=qfremote-test.jks
EOF
      else
        rm -f "$copy/android/key.properties" "$copy/android/app/qfremote-test.jks"
      fi
      (cd "$copy" && if [ "$setvar" -eq 1 ]; then export QFR_ALLOW_DEBUG_RELEASE_SIGNING=1; fi
       "$FLUTTER_BIN" build apk --release >"$log" 2>&1; echo "EXIT=$?" >>"$log")
      if grep -q "Release signing is missing or incomplete" "$log"; then
        echo "GATE_FIRED"
      elif ls "$copy/build/app/outputs/flutter-apk/app-release.apk" >/dev/null 2>&1; then
        echo "APK_BUILT"
      elif grep -qE "was not found in any of the following sources|Could not resolve|SSLException|No space left" "$log"; then
        echo "ENV_BLOCKED"
      else
        echo "OTHER_FAIL"
      fi
    }
    # G1：无 key.properties → 门必须触发。
    res=$(gradle_probe g1-nokey 0 0 signing-gate-g1.log)
    case "$res" in
      GATE_FIRED) ok "G1 无 key.properties：Gradle 门触发、构建失败（日志 signing-gate-g1.log）" ;;
      APK_BUILT)  bad "G1 无 key.properties：竟产出 release APK，门未触发" ;;
      ENV_BLOCKED) skip "G1 无 key.properties" "Gradle 环境受阻、未走到配置门（见 signing-gate-g1.log）" ;;
      *) bad "G1 无 key.properties：既无门触发也无产物（OTHER_FAIL，见 signing-gate-g1.log）" ;;
    esac
    # G2：设变量＋无 key.properties → 门必须触发（变量绕不过）。
    res=$(gradle_probe g2-envvar-nokey 1 0 signing-gate-g2.log)
    case "$res" in
      GATE_FIRED) ok "G2 设变量＋无 key.properties：Gradle 门触发、构建失败（日志 signing-gate-g2.log）" ;;
      APK_BUILT)  bad "G2 设变量＋无 key.properties：竟产出 release APK，变量绕过了门" ;;
      ENV_BLOCKED) skip "G2 设变量＋无 key.properties" "Gradle 环境受阻、未走到配置门（见 signing-gate-g2.log）" ;;
      *) bad "G2 设变量＋无 key.properties：既无门触发也无产物（OTHER_FAIL，见 signing-gate-g2.log）" ;;
    esac
    # G3：签名齐全 → 门不得误拒；产物随后还会被 verify-apk 拒绝
    # （自签测试密钥指纹不在正式白名单内，那是第二道拦截的职责）。
    res=$(gradle_probe g3-withsign 0 1 signing-gate-g3.log)
    case "$res" in
      GATE_FIRED) bad "G3 签名齐全：Gradle 门误拒（应放行）" ;;
      APK_BUILT)
        # 注意：不能只看退出码——主树 release_gate.sh 若无 verify-apk 子命令，
        # 会以用法错误（exit 2）退出，那不是“拒绝”，必须单独报出来，
        # 不能误算成第二道拦截正常。
        if bash "$APP_ROOT/$GATE" verify-apk "$WORK/gradle-g3-withsign/build/app/outputs/flutter-apk/app-release.apk" >"$WORK/gate-out.txt" 2>&1; then
          bad "G3 签名齐全：自签测试包竟通过 verify-apk（白名单失效？）"
        elif grep -qE "不在正式签名白名单内|Android Debug|校验未通过" "$WORK/gate-out.txt"; then
          ok "G3 签名齐全：Gradle 门放行、产物随后被 verify-apk 拒绝（第二道拦截正常）"
        else
          bad "G3 签名齐全：verify-apk 未给出明确拒绝原因（可能是 release_gate.sh 无 verify-apk 子命令，见 M6；gate 输出见 $WORK/gate-out.txt）"
        fi ;;
      ENV_BLOCKED) skip "G3 签名齐全" "Gradle 环境受阻、未走到配置门（见 signing-gate-g3.log）" ;;
      *) bad "G3 签名齐全：构建失败且非门触发（OTHER_FAIL，见 signing-gate-g3.log）" ;;
    esac
  fi
else
  skip "G1-G3 Gradle 真实构建" "未加 --gradle（默认只跑 M 静态；CI release job 须加 --gradle 跑）"
fi

echo "----------------------------------------"
echo "汇总：PASS=$PASS FAIL=$FAIL SKIP=$SKIP"
printf '%s\n' "${RESULTS[@]}"
[ "$FAIL" -eq 0 ]
