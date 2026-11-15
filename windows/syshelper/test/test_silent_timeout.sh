#!/bin/sh
# 低项 1 回归：QFSysHelper 静默占位 30s 读超时后释放管道（Wine 下跑）。
# 场景：
#   silent：连上不发数据 → 服务端须在 ~30s 内断开（读超时），客户端观测
#     到断开；修前永久占住唯一实例，60s 内不断开，本用例失败。
#   ping：随后立即再连并发一行 → 须在 10s 内收到响应（证明管道已释放、
#     可服务；响应为解析失败行亦算数，只验“能服务”）。
# 用法：sh test_silent_timeout.sh（须有 wine 与 x86_64-w64-mingw32-gcc）。
# 产物一律写 $WORKDIR（工作区 scratch），不写 /tmp（512M 易满）。
set -u
cd "$(dirname "$0")/.."
WORKDIR="$HOME/workspace/tmp-n-fix"
mkdir -p "$WORKDIR"
export WINEPREFIX="$HOME/workspace/.wine-b1-test"
export WINEDEBUG=-all

PASS=0; FAIL=0
ok() { PASS=$((PASS+1)); echo "PASS $1"; }
bad() { FAIL=$((FAIL+1)); echo "FAIL $1"; }

# 现有 whitelist.h 直接编译（本修未动白名单，不重生成）。
x86_64-w64-mingw32-gcc -O2 -Wall -Werror -o "$WORKDIR/QFSysHelper-test.exe" \
    QFSysHelper.c protocol.c -lbcrypt -ladvapi32 || exit 1
x86_64-w64-mingw32-gcc -O2 -Wall -Wextra -o "$WORKDIR/silent_probe.exe" \
    test/silent_probe.c || exit 1

wineboot --init >/dev/null 2>&1 || true
wine "$WORKDIR/QFSysHelper-test.exe" debug >"$WORKDIR/syshelper-debug.log" 2>&1 &
HELPER=$!
sleep 2

echo "== silent: connect, send nothing, expect server disconnect in ~30s =="
wine "$WORKDIR/silent_probe.exe" silent >"$WORKDIR/silent-out.txt" 2>&1
code=$?
cat "$WORKDIR/silent-out.txt"
if [ "$code" = 0 ]; then ok "silent client disconnected in ~30s (read timeout frees pipe)"; \
else bad "silent client NOT disconnected in 60s (pipe still held)"; fi

echo "== ping: reconnect immediately, expect a fast response =="
wine "$WORKDIR/silent_probe.exe" ping >"$WORKDIR/ping-out.txt" 2>&1
code=$?
cat "$WORKDIR/ping-out.txt"
if [ "$code" = 0 ]; then ok "ping after silent-timeout got a response (pipe free)"; \
else bad "ping after silent-timeout got no response"; fi

kill $HELPER 2>/dev/null; wait $HELPER 2>/dev/null
wineserver -k 2>/dev/null || true

echo
echo "==== syshelper silent-timeout tests: $PASS passed, $FAIL failed ===="
[ "$FAIL" = 0 ]
