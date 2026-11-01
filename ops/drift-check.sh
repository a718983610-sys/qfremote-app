#!/bin/bash
# QFRemote 漂移巡查：比对「仓库 origin/main」与「线上现行字节」指纹，只报不改。
# 用法：bash ops/drift-check.sh [--verbose]
# 输出：每处漂移一行 DRIFT ...；无漂移时只输出一行 OK ...。
# 原理：以仓库 server/、windows/ 下的受控文件为清单，按映射拼出线上路径，
#       线上侧一条 ssh 批量取 md5，仓库侧用 git show 取 blob 内容 md5，逐项比对。
set -uo pipefail
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SSH="$HOME/workspace/qfremote/tokyo-ssh.sh"
VERBOSE="${1:-}"

cd "$REPO_DIR"
git fetch --quiet origin main 2>/dev/null || { echo "DRIFT-CHECK-ERROR: git fetch 失败"; exit 0; }

# 本地有未推送提交时先警告（仓库正本以远端 main 为准）
AHEAD=$(git rev-list --count origin/main..HEAD 2>/dev/null || echo 0)
[ "$AHEAD" != "0" ] && echo "WARN: 本地 HEAD 领先 origin/main $AHEAD 个提交（未推送，线上比对仍以 origin/main 为准）"

# 生成映射清单：repo_path <TAB> live_path
# 豁免（2026-10-27 漂移对账裁定第 1 项）：server/ext/config-structure.md 是仓库专用
# 配置结构说明文档、本就不部署到服务器，线上缺失为预期状态，不计漂移。
MAP=$(mktemp)
git ls-tree -r --name-only origin/main -- server windows ops | while IFS= read -r p; do
  case "$p" in
    server/ext/config-structure.md) continue ;;
    # 退役豁免（2026-11-02 回收裁定）：ops/assistant-api/watcher.py 哨兵工具已按站长
    # 2026-11-01 令全关退役，本地在役字节与仓库字节的差异为预期状态，不回收、不复活、不计漂移。
    ops/assistant-api/watcher.py) continue ;;
    server/webapp/*)     live="/opt/qfremote-webapp/${p#server/webapp/}" ;;
    server/ext/*)        live="/opt/qfremote-ext/${p#server/ext/}" ;;
    server/loginshim/*)  live="/opt/qfremote-loginshim/${p#server/loginshim/}" ;;
    server/register/*)   live="/opt/qfremote-register/${p#server/register/}" ;;
    server/friends/*)    live="/opt/qfremote-friends/${p#server/friends/}" ;;
    server/forum/*)      live="/opt/qfremote-forum/${p#server/forum/}" ;;
    server/meshcentral/*) live="/opt/meshcentral/meshcentral-web/${p#server/meshcentral/}" ;;
    server/nginx/*)      live="/etc/nginx/sites-enabled/${p#server/nginx/}" ;;
    server/lock/*)       live="/opt/qfremote-lock/${p#server/lock/}" ;;
    windows/*)           live="$HOME/workspace/qfremote/app-src/${p#windows/}" ;;
    ops/assistant-api/*) live="$HOME/workspace/qfremote/assistant-api/${p#ops/assistant-api/}" ;;
    *) continue ;;
  esac
  printf '%s\t%s\n' "$p" "$live"
done > "$MAP"

TOTAL=$(wc -l < "$MAP")
# 线上批量取指纹（服务器路径 /opt、/etc 走 ssh+sudo；本地 $HOME 路径直接 md5sum）
SRV_PATHS=$(awk -F'\t' '$2 ~ /^\/(opt|etc)\//'"{print \$2}" "$MAP")
LIVE_TMP=$(mktemp)
if [ -n "$SRV_PATHS" ]; then
  echo "$SRV_PATHS" | $SSH 'sudo -n md5sum $(cat) 2>/dev/null' >> "$LIVE_TMP" || echo "DRIFT-CHECK-ERROR: ssh 取指纹失败"
fi
awk -F'\t' '$2 ~ /^\/home\//'"{print \$2}" "$MAP" | while IFS= read -r lp; do
  [ -f "$lp" ] && md5sum "$lp"
done >> "$LIVE_TMP"
# 统一成 "livepath md5"
awk '{print $2, $1}' "$LIVE_TMP" | sort -u > "${LIVE_TMP}.norm"

DRIFT=0
while IFS=$'\t' read -r repo live; do
  blob_md5=$(git show "origin/main:$repo" 2>/dev/null | md5sum | awk '{print $1}')
  live_md5=$(grep -F -m1 "$live " "${LIVE_TMP}.norm" | awk '{print $2}')
  if [ -z "$live_md5" ]; then
    echo "DRIFT $repo 线上缺失或不可读 ($live)"; DRIFT=$((DRIFT+1))
  elif [ "$blob_md5" != "$live_md5" ]; then
    echo "DRIFT $repo repo=$blob_md5 live=$live_md5"; DRIFT=$((DRIFT+1))
  elif [ "$VERBOSE" = "--verbose" ]; then
    echo "OK    $repo $blob_md5"
  fi
done < "$MAP"

rm -f "$MAP" "$LIVE_TMP" "${LIVE_TMP}.norm"
if [ "$DRIFT" = "0" ]; then
  echo "OK 全部 $TOTAL 个受控文件与线上一致"
else
  echo "DRIFT-TOTAL $DRIFT/$TOTAL 处不一致（只报告，不自动修改；按 README 规矩当日回收或回滚）"
fi
exit 0
