#!/usr/bin/env bash
# S-096：截图工作流取包脚本——按 GitHub Actions artifact API 取最新成功 run 的
# 唯一 APK 产物，校验版本／包名／SHA256 后再安装。禁止把版本号硬编码在工作流里。
#
# 用法：
#   bash .github/scripts/fetch-prod-apk.sh \
#     --repo OWNER/REPO --workflow android.yml \
#     --expected-version 3.0.0 --package com.qfremote.android \
#     --out-dir prod
# 依赖：gh（已登录，GH_TOKEN 在环境里）、aapt（Android build-tools，随
# flutter-action 装好的 SDK 提供）、sha256sum。
# 产物选择规则：优先取正式产物名 QFRemote-v<version>-apk；没有正式产物时，
# 仅当匹配 QFRemote-v*-apk 的产物恰好唯一才取它（dev 产物），多于一个即失败。
# 失败即非零退出，不许静默取旧包。
set -euo pipefail

REPO="" WORKFLOW="android.yml" EXPECTED_VERSION="" PACKAGE="com.qfremote.android" OUT_DIR="prod"
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO="$2"; shift 2 ;;
    --workflow) WORKFLOW="$2"; shift 2 ;;
    --expected-version) EXPECTED_VERSION="$2"; shift 2 ;;
    --package) PACKAGE="$2"; shift 2 ;;
    --out-dir) OUT_DIR="$2"; shift 2 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done
[ -n "$REPO" ] && [ -n "$EXPECTED_VERSION" ] || { echo "须传 --repo 与 --expected-version" >&2; exit 2; }
command -v gh >/dev/null || { echo "缺少 gh" >&2; exit 2; }
command -v aapt >/dev/null || { echo "缺少 aapt（Android build-tools 未装好）" >&2; exit 2; }

RUN_ID=$(gh run list --repo "$REPO" --workflow "$WORKFLOW" --status success --limit 1 --json databaseId --jq '.[0].databaseId')
case "$RUN_ID" in ''|null|*[!0-9]*) echo "取不到成功的 $WORKFLOW 构建 run（gh 返回：$RUN_ID）" >&2; exit 1 ;; esac
echo "build run: $RUN_ID"

ARTIFACTS=$(gh api "repos/$REPO/actions/runs/$RUN_ID/artifacts" --jq '.artifacts[] | select(.name | startswith("QFRemote-v")) | .name')
[ -n "$ARTIFACTS" ] || { echo "run $RUN_ID 下没有 QFRemote-v*-apk 产物" >&2; exit 1; }
PROD_NAME="QFRemote-v${EXPECTED_VERSION}-apk"
if printf '%s\n' "$ARTIFACTS" | grep -qx "$PROD_NAME"; then
  NAME="$PROD_NAME"
  echo "取正式产物: $NAME"
else
  COUNT=$(printf '%s\n' "$ARTIFACTS" | wc -l)
  if [ "$COUNT" -ne 1 ]; then
    echo "没有正式产物 $PROD_NAME，且候选产物不唯一（$COUNT 个），拒绝猜测：" >&2
    printf '%s\n' "$ARTIFACTS" >&2
    exit 1
  fi
  NAME="$ARTIFACTS"
  echo "无正式产物，取唯一候选（dev）: $NAME"
fi

rm -rf "$OUT_DIR"; mkdir -p "$OUT_DIR"
gh run download "$RUN_ID" --repo "$REPO" -n "$NAME" -D "$OUT_DIR"
APK=$(find "$OUT_DIR" -maxdepth 1 -name '*.apk' -print)
[ -n "$APK" ] || { echo "产物 $NAME 里没有 .apk" >&2; exit 1; }
[ "$(printf '%s\n' "$APK" | wc -l)" -eq 1 ] || { echo "产物 $NAME 里 .apk 不唯一" >&2; exit 1; }

BADGING=$(aapt dump badging "$APK")
GOT_PACKAGE=$(printf '%s' "$BADGING" | sed -n "s/^package: name='\([^']*\)'.*/\1/p" | head -1)
GOT_VERSION=$(printf '%s' "$BADGING" | sed -n "s/^package: .* versionName='\([^']*\)'.*/\1/p" | head -1)
[ "$GOT_PACKAGE" = "$PACKAGE" ] || { echo "包名不符：$GOT_PACKAGE，期望 $PACKAGE" >&2; exit 1; }
[ "$GOT_VERSION" = "$EXPECTED_VERSION" ] || { echo "版本不符：$GOT_VERSION，期望 $EXPECTED_VERSION" >&2; exit 1; }
SHA=$(sha256sum "$APK" | awk '{print $1}')
printf '%s  %s\n' "$SHA" "$(basename "$APK")" > "$OUT_DIR/apk.sha256"
echo "OK apk=$APK package=$GOT_PACKAGE version=$GOT_VERSION sha256=$SHA"
