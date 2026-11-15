#!/usr/bin/env bash
# A-09 安卓端发版门检查脚本（沙箱跑，不部署、不翻 release.json）。
# 用法：tools/release_gate.sh [check|build|diff]
# 标准构建命令：Flutter 3.47.8（/home/hatch/tools/flutter-3.47.8/bin/flutter，
# Dart 3.13.7；默认 PATH 的 3.32.8 解不出包），JDK 21，
# GRADLE_OPTS=-Djava.net.preferIPv4Stack=true。
set -euo pipefail
cd "$(dirname "$0")/.."

FLUTTER=${FLUTTER:-/home/hatch/tools/flutter-3.47.8/bin/flutter}
export GRADLE_OPTS=-Djava.net.preferIPv4Stack=true
OUT_DIR=build/release-gate
CMD="${1:-check}"

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
  *) echo "用法：$0 [check|build|diff]"; exit 2 ;;
esac
