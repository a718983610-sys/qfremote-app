#!/bin/bash
# QFRemote 漂移巡查：比对「仓库 origin/main」与「线上现行字节」指纹，只报不改。
# 用法：bash ops/drift-check.sh [--verbose]
# 指纹：完整 SHA-256（64 位 hex）。仓库侧 git show 取 blob 内容算 sha256sum，
#       线上侧 ssh+sudo sha256sum；本地 $HOME 路径直接 sha256sum。
#       （2026-11-19 改造：旧版用 md5sum（32 位）且末尾固定 exit 0，不能作为
#        SHA-256 验证证据，也会掩盖执行失败；见 GPT 漂移定夺
#        gpt-drift-ruling-20261119.md §一，登记 OPS-DRIFT-20261119。）
# 输出：每处漂移一行 DRIFT ...；无漂移时只输出一行 OK ...；
#       执行失败时输出 DRIFT-CHECK-ERROR ...（漂移判断与巡查执行健康状态分开记录）。
# 退出码口径（2026-11-19 定版）：
#   0 = 巡查执行成功，且无漂移（全部一致）；
#   1 = 执行错误（git fetch 失败 / ssh 连接失败 / 未取回任何服务端指纹 /
#       仓库 blob 取指纹失败等），此时 DRIFT 输出不可信，必须先修执行健康再看漂移；
#   2 = 巡查执行成功，且发现漂移（DRIFT-TOTAL > 0）。
#   其中 ssh 批量取指纹若只是部分文件失败（exit 非 0 非 255 且已取回部分指纹），
#   记 WARN 后继续比对，缺失文件按漂移报告；只有连接失败（exit 255）或
#   一行指纹都没取回时才算执行错误。
# 原理：以仓库 server/、windows/ 下的受控文件为清单，按映射拼出线上路径，
#       线上侧一条 ssh 批量取 sha256，仓库侧用 git show 取 blob 内容 sha256，逐项比对。
set -uo pipefail
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SSH="$HOME/workspace/qfremote/tokyo-ssh.sh"
VERBOSE="${1:-}"
ERR=0
DRIFT=0

cd "$REPO_DIR"
git fetch --quiet origin main 2>/dev/null || { echo "DRIFT-CHECK-ERROR: git fetch 失败"; exit 1; }

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
# 线上批量取指纹（服务器路径 /opt、/etc 走 ssh+sudo；本地 $HOME 路径直接 sha256sum）
SRV_PATHS=$(awk -F'\t' '$2 ~ /^\/(opt|etc)\//'"{print \$2}" "$MAP")
LIVE_TMP=$(mktemp)
if [ -n "$SRV_PATHS" ]; then
  SRV_COUNT=$(printf '%s\n' "$SRV_PATHS" | wc -l)
  echo "$SRV_PATHS" | $SSH 'sudo -n sha256sum $(cat) 2>/dev/null' >> "$LIVE_TMP"
  SSH_RC=$?
  SRV_GOT=$(grep -c . "$LIVE_TMP" 2>/dev/null || true)
  if [ "$SSH_RC" = "255" ]; then
    echo "DRIFT-CHECK-ERROR: ssh 连接失败（exit 255）"
    ERR=1
  elif [ "$SRV_GOT" = "0" ]; then
    echo "DRIFT-CHECK-ERROR: ssh 取指纹失败（未取回任何服务端指纹，ssh exit=$SSH_RC）"
    ERR=1
  elif [ "$SSH_RC" != "0" ]; then
    echo "WARN: 部分服务端指纹取回失败（ssh exit=$SSH_RC，已取回 $SRV_GOT/$SRV_COUNT 行），缺失文件将按漂移报告"
  fi
fi
awk -F'\t' '$2 ~ /^\/home\//'"{print \$2}" "$MAP" | while IFS= read -r lp; do
  if [ -f "$lp" ]; then
    sha256sum "$lp" || echo "WARN: 本地指纹取回失败 ($lp)" >&2
  fi
done >> "$LIVE_TMP"
# 统一成 "livepath sha256"
awk '{print $2, $1}' "$LIVE_TMP" | sort -u > "${LIVE_TMP}.norm"

# 服务端指纹未取回时逐项比对无意义（会把全部文件误报为缺失漂移），直接按
# 执行错误退出；漂移判断与巡查执行健康状态分开记录。
if [ "$ERR" != "0" ]; then
  rm -f "$MAP" "$LIVE_TMP" "${LIVE_TMP}.norm"
  echo "DRIFT-CHECK-ERROR: 巡查执行失败（见上方 ERROR 行），本次漂移结果不可信"
  exit 1
fi

while IFS=$'\t' read -r repo live; do
  blob_tmp=$(mktemp)
  if git show "origin/main:$repo" > "$blob_tmp" 2>/dev/null; then
    blob_sha256=$(sha256sum "$blob_tmp" | awk '{print $1}')
  else
    echo "DRIFT-CHECK-ERROR: 仓库 blob 取指纹失败 ($repo)"
    ERR=1
    rm -f "$blob_tmp"
    continue
  fi
  rm -f "$blob_tmp"
  live_sha256=$(grep -F -m1 "$live " "${LIVE_TMP}.norm" | awk '{print $2}')
  if [ -z "$live_sha256" ]; then
    echo "DRIFT $repo 线上缺失或不可读 ($live)"; DRIFT=$((DRIFT+1))
  elif [ "$blob_sha256" != "$live_sha256" ]; then
    echo "DRIFT $repo repo=$blob_sha256 live=$live_sha256"; DRIFT=$((DRIFT+1))
  elif [ "$VERBOSE" = "--verbose" ]; then
    echo "OK    $repo $blob_sha256"
  fi
done < "$MAP"

rm -f "$MAP" "$LIVE_TMP" "${LIVE_TMP}.norm"
if [ "$ERR" != "0" ]; then
  echo "DRIFT-CHECK-ERROR: 巡查执行失败（见上方 ERROR 行），本次漂移结果不可信"
  exit 1
fi
if [ "$DRIFT" = "0" ]; then
  echo "OK 全部 $TOTAL 个受控文件与线上一致"
  exit 0
else
  echo "DRIFT-TOTAL $DRIFT/$TOTAL 处不一致（只报告，不自动修改；按 README 规矩当日回收或回滚）"
  exit 2
fi
