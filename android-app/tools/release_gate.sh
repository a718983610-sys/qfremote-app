#!/usr/bin/env bash
# A-09 安卓端发版门检查脚本（沙箱跑，不部署、不翻 release.json）。
# 用法：tools/release_gate.sh [check|build|diff|verify-apk <apk>]
# verify-apk：对最终 APK 做签名复核（第二道拦截，见下）；build 构建完后
# 会对每个产出的 release APK 自动跑同一复核。
# 标准构建命令：Flutter 3.47.8（/home/hatch/tools/flutter-3.47.8/bin/flutter，
# Dart 3.13.7；默认 PATH 的 3.32.8 解不出包），JDK 21，
# GRADLE_OPTS=-Djava.net.preferIPv4Stack=true。
set -euo pipefail
cd "$(dirname "$0")/.."

FLUTTER=${FLUTTER:-/home/hatch/tools/flutter-3.47.8/bin/flutter}
export GRADLE_OPTS=-Djava.net.preferIPv4Stack=true
OUT_DIR=build/release-gate
CMD="${1:-check}"

# 第二道拦截：最终产物签名复核（2026-11-16 堵死签名旁路新增）。
# 构建阶段 Gradle 已抛错拦截一次；这里对落盘的 APK 再验一次，防止任何
# 构建期旁路漏网。期望指纹与应用内更新器验签同一来源：
# android-app/lib/core/constants.dart 的 kExpectedApkCertSha256s
# （现售包 apksigner 实测值）；证书轮换时两处须同步改，不设环境变量
# 覆盖——环境变量可覆盖期望值本身就是一条新旁路。
EXPECTED_APK_CERT_SHA256S="a3fde275f46b4e470648c8e3fbc0594ce496eb17b8fa52f4da9bf2af7bbf141f"

find_apksigner() {
  if [ -n "${ANDROID_HOME:-}" ]; then
    if [ -n "${BUILD_TOOLS_VERSION:-}" ] && [ -x "$ANDROID_HOME/build-tools/$BUILD_TOOLS_VERSION/apksigner" ]; then
      echo "$ANDROID_HOME/build-tools/$BUILD_TOOLS_VERSION/apksigner"
      return 0
    fi
    local latest
    latest=$(ls -d "$ANDROID_HOME"/build-tools/*/apksigner 2>/dev/null | sort -V | tail -n 1 || true)
    if [ -n "$latest" ] && [ -x "$latest" ]; then
      echo "$latest"
      return 0
    fi
  fi
  command -v apksigner
}

verify_apk_signing() {
  local apk="${1:-}"
  if [ -z "$apk" ] || [ ! -f "$apk" ]; then
    echo "FAIL 签名复核：APK 不存在：$apk"
    return 1
  fi
  local apksigner_bin
  apksigner_bin=$(find_apksigner)
  if [ -z "$apksigner_bin" ]; then
    echo "FAIL 签名复核：找不到 apksigner（需 Android build-tools 或 PATH 中有 apksigner）"
    return 1
  fi
  echo "== 签名复核：$apk（apksigner：$apksigner_bin） =="
  local certs
  if ! certs=$("$apksigner_bin" verify --print-certs "$apk" 2>&1); then
    echo "$certs"
    echo "FAIL 签名复核：apksigner 校验未通过，拒绝该包"
    return 1
  fi
  echo "$certs"
  # ① 拒绝 debug 签名：Android 默认 debug 证书 DN 为 CN=Android Debug。
  if echo "$certs" | grep -qi "Android Debug"; then
    echo "FAIL 签名复核：检测到 Android Debug 签名证书，拒绝该包（release 产物绝不允许 debug 签名）"
    return 1
  fi
  # ② 证书指纹必须落在正式签名白名单内（每位签名者都要命中，不是任一命中）。
  local digests
  digests=$(echo "$certs" | grep -i "certificate SHA-256 digest:" | sed -E 's/.*digest: *//; s/://g; s/ //g' | tr 'A-F' 'a-f')
  if [ -z "$digests" ]; then
    echo "FAIL 签名复核：未取到签名证书 SHA-256 指纹，拒绝该包"
    return 1
  fi
  local d ok
  while IFS= read -r d; do
    [ -z "$d" ] && continue
    ok=0
    for expected in $EXPECTED_APK_CERT_SHA256S; do
      if [ "$d" = "$expected" ]; then ok=1; break; fi
    done
    if [ "$ok" -ne 1 ]; then
      echo "FAIL 签名复核：证书指纹 $d 不在正式签名白名单内，拒绝该包"
      return 1
    fi
  done <<< "$digests"
  echo "OK 签名复核通过：全部签名者均为正式签名证书"
  return 0
}

check() {
  echo "== 版本一致性 =="
  grep -E '^version: ' pubspec.yaml
  echo "== 分层 lint + 行数门 + 全量测试 =="
  "$FLUTTER" analyze
  "$FLUTTER" test test/lint/ test/data/ test/app/ test/ui/ 2>&1 | tail -3
  echo "== Golden 齐全性 =="
  ls test/ui/goldens/ | sort
  echo "CHECK OK"
}

build() {
  mkdir -p "$OUT_DIR"
  echo "== 按 ABI 分包构建（release） =="
  "$FLUTTER" build apk --release --split-per-abi
  echo "== 体积 + SHA-256 =="
  : > "$OUT_DIR/体积报告.txt"
  for apk in build/app/outputs/flutter-apk/app-*-release.apk; do
    size=$(stat -c%s "$apk")
    sha=$(sha256sum "$apk" | cut -d' ' -f1)
    echo "$(basename "$apk") $size $sha" | tee -a "$OUT_DIR/体积报告.txt"
  done
  echo "== 签名复核（第二道拦截：拒绝 debug 签名 / 非正式证书） =="
  for apk in build/app/outputs/flutter-apk/app-*-release.apk; do
    verify_apk_signing "$apk"
  done
  echo "BUILD OK，报告：$OUT_DIR/体积报告.txt"
}

diff_vol() {
  prev="${1:-}"
  if [ -z "$prev" ] || [ ! -f "$prev" ]; then
    echo "用法：$0 diff <上次体积报告路径>"
    exit 2
  fi
  echo "== 体积 diff（超 10% 标红） =="
  while read -r name size sha; do
    old=$(awk -v n="$name" '$1==n {print $2}' "$prev" || true)
    if [ -n "$old" ] && [ "$old" -gt 0 ]; then
      pct=$(( (size - old) * 100 / old ))
      if [ "$pct" -gt 10 ] || [ "$pct" -lt -10 ]; then
        echo "RED $name：$old -> $size（$pct%）"
      else
        echo "OK  $name：$old -> $size（$pct%）"
      fi
    else
      echo "NEW $name：$size"
    fi
  done < "$OUT_DIR/体积报告.txt"
}

case "$CMD" in
  check) check ;;
  build) build ;;
  diff) diff_vol "${2:-}" ;;
  verify-apk)
    if [ -z "${2:-}" ]; then echo "用法：$0 verify-apk <apk 路径>"; exit 2; fi
    verify_apk_signing "$2" ;;
  *) echo "用法：$0 [check|build|diff|verify-apk <apk>]"; exit 2 ;;
esac
