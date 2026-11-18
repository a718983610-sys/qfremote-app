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

# F3 审计落盘（A15 整改）：每次运行都在 $OUT_DIR 写一份结构化审计记录
# （commit／dirty 状态／工具链版本／产物 SHA／错误信息／实际退出码），
# 用 trap EXIT 保证失败也记录。审计写盘失败不影响门禁本身的退出码。
# 审计只记录本次运行的元数据与结果，不记录 APK 内容与密钥。
AUDIT_START=$(date -u +%Y-%m-%dT%H%M:%SZ)
AUDIT_CMDLINE="$0 $*"
AUDIT_CMD_SAFE=$(printf '%s' "$CMD" | tr -c 'A-Za-z0-9_.-' '_')
AUDIT_STAMP="$(date -u +%Y%m%d-%H%M%S)-$$"
AUDIT_FILE="$OUT_DIR/audit-$AUDIT_CMD_SAFE-$AUDIT_STAMP.log"
VERIFY_TARGET=""
if [ "$CMD" = "verify-apk" ]; then VERIFY_TARGET="${2:-}"; fi
GATE_ERROR=""

# 记录一次门禁 FAIL 断言的操作员可见文案，供审计落盘引用。
fail_msg() {
  GATE_ERROR="$1"
  echo "FAIL $1"
}

write_audit() {
  # EXIT trap 内执行：绝不改写脚本退出码、绝不因自身失败而报错。
  set +e
  set +u
  local rc="${1:-?}"
  local result="PASS"
  [ "$rc" != "0" ] && result="FAIL"
  local flutter_ver dart_ver java_ver signer_path signer_ver commit dirty flutter_out
  mkdir -p "$OUT_DIR" 2>/dev/null
  flutter_out=$("$FLUTTER" --version 2>/dev/null || true)
  flutter_ver=$(echo "$flutter_out" | head -n 1)
  [ -z "$flutter_ver" ] && flutter_ver="unknown"
  dart_ver=$(echo "$flutter_out" | grep -o "Dart [0-9.]*" | head -n 1)
  [ -z "$dart_ver" ] && dart_ver="unknown"
  if command -v java >/dev/null 2>&1; then
    java_ver=$(java -version 2>&1 | head -n 1)
  else
    java_ver="unknown"
  fi
  [ -z "$java_ver" ] && java_ver="unknown"
  signer_path=$(find_apksigner 2>/dev/null || true)
  [ -z "$signer_path" ] && signer_path="unknown"
  if [ "$signer_path" != "unknown" ] && [ -x "$signer_path" ]; then
    signer_ver=$("$signer_path" --version 2>/dev/null | head -n 1 || true)
    [ -z "$signer_ver" ] && signer_ver="unknown"
  else
    signer_ver="unknown"
  fi
  commit=$(git rev-parse HEAD 2>/dev/null || echo unknown)
  if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    dirty=$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')
  else
    dirty="unknown"
  fi
  {
    echo "# release_gate 审计记录"
    echo "timestamp_start=$AUDIT_START"
    echo "timestamp_end=$(date -u +%Y-%m-%dT%H%M:%SZ)"
    echo "command=$AUDIT_CMDLINE"
    echo "exit_code=$rc"
    echo "result=$result"
    echo "commit=$commit"
    echo "dirty_files=$dirty"
    echo "flutter=$flutter_ver"
    echo "dart=$dart_ver"
    echo "java=$java_ver"
    echo "apksigner_path=$signer_path"
    echo "apksigner_version=$signer_ver"
    if [ -n "$GATE_ERROR" ]; then
      echo "error=$GATE_ERROR"
    else
      echo "error=(none; 失败详情见本次运行 stdout)"
    fi
    echo "products:"
    if [ -f "$OUT_DIR/体积报告.txt" ]; then
      sed 's/^/  /' "$OUT_DIR/体积报告.txt"
    elif [ -n "$VERIFY_TARGET" ] && [ -f "$VERIFY_TARGET" ]; then
      echo "  $(basename "$VERIFY_TARGET") $(sha256sum "$VERIFY_TARGET" | cut -d' ' -f1)"
    else
      echo "  (none)"
    fi
  } >> "$AUDIT_FILE" 2>/dev/null || true
}

trap 'write_audit "$?"' EXIT
mkdir -p "$OUT_DIR" || { echo "FAIL 审计目录不可写：$OUT_DIR" >&2; exit 1; }

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
    fail_msg "签名复核：APK 不存在：$apk"
    return 1
  fi
  local apksigner_bin
  if ! apksigner_bin=$(find_apksigner); then
    fail_msg "签名复核：找不到 apksigner（需 Android build-tools 或 PATH 中有 apksigner）"
    return 1
  fi
  if [ -z "$apksigner_bin" ]; then
    fail_msg "签名复核：找不到 apksigner（需 Android build-tools 或 PATH 中有 apksigner）"
    return 1
  fi
  echo "== 签名复核：$apk（apksigner：$apksigner_bin） =="
  local certs
  if ! certs=$("$apksigner_bin" verify --print-certs "$apk" 2>&1); then
    echo "$certs"
    fail_msg "签名复核：apksigner 校验未通过，拒绝该包"
    return 1
  fi
  echo "$certs"
  # ① 拒绝 debug 签名：Android 默认 debug 证书 DN 为 CN=Android Debug。
  if echo "$certs" | grep -qi "Android Debug"; then
    fail_msg "签名复核：检测到 Android Debug 签名证书，拒绝该包（release 产物绝不允许 debug 签名）"
    return 1
  fi
  # ② 证书指纹必须落在正式签名白名单内（每位签名者都要命中，不是任一命中）。
  local digests
  if ! digests=$(echo "$certs" | grep -i "certificate SHA-256 digest:" | sed -E 's/.*digest: *//; s/://g; s/ //g' | tr 'A-F' 'a-f'); then
    fail_msg "签名复核：未取到签名证书 SHA-256 指纹，拒绝该包"
    return 1
  fi
  if [ -z "$digests" ]; then
    fail_msg "签名复核：未取到签名证书 SHA-256 指纹，拒绝该包"
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
      fail_msg "签名复核：证书指纹 $d 不在正式签名白名单内，拒绝该包"
      return 1
    fi
  done <<< "$digests"
  echo "OK 签名复核通过：全部签名者均为正式签名证书"
  return 0
}

check() {
  echo "== 版本一致性 =="
  grep -E '^version: ' pubspec.yaml || { GATE_ERROR="pubspec.yaml 未找到 version 行"; return 1; }
  echo "== 分层 lint + 行数门 + 全量测试 =="
  "$FLUTTER" analyze || { GATE_ERROR="flutter analyze 失败（见上方输出）"; return 1; }
  "$FLUTTER" test 2>&1 | tail -3 || { GATE_ERROR="flutter test 失败（见上方输出）"; return 1; }
  echo "== Golden 齐全性 =="
  ls test/ui/goldens/ | sort || { GATE_ERROR="Golden 目录缺失或不可读：test/ui/goldens/"; return 1; }
  echo "CHECK OK"
}

build() {
  mkdir -p "$OUT_DIR"
  echo "== 按 ABI 分包构建（release） =="
  "$FLUTTER" build apk --release --split-per-abi || { GATE_ERROR="flutter build apk 失败（见上方输出）"; return 1; }
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
