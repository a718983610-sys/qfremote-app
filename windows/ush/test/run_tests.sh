#!/bin/sh
# USH 沙箱单测入口：纯逻辑层（ush_json.c）用宿主 gcc 编译运行。
# Windows 专属部分（UIA/管道/截图/会话门）沙箱跑不了，见 WINDOWS-TESTS.md。
set -e
cd "$(dirname "$0")"
gcc -std=c11 -Wall -Wextra -I.. -o /tmp/test_ush_json test_ush_json.c ../ush_json.c
/tmp/test_ush_json

echo
echo "== [2/2] mingw cross-compile (USH service, compile-only) =="
if command -v x86_64-w64-mingw32-gcc >/dev/null 2>&1; then
    cd ..
    x86_64-w64-mingw32-gcc -O2 -Wall -Wextra -std=c11 -D_WIN32_WINNT=0x0A00 -DWINVER=0x0A00 \
        -o /tmp/QFUserHelper.exe ush.c ush_json.c ush_log.c ush_uia.c ush_snapshot.c ush_selfbind.c \
        -lole32 -loleaut32 -luuid -lwtsapi32 -lgdi32 -luser32 -lbcrypt -lwindowscodecs -lwinhttp -lncrypt -lcrypt32
    file /tmp/QFUserHelper.exe
    echo "mingw cross-compile OK"
    cd test
else
    echo "SKIP: x86_64-w64-mingw32-gcc not found"
fi

echo
echo "== [3/3] H24 snapshot harden/prune (wine, if available) =="
if command -v wine64 >/dev/null 2>&1 && command -v x86_64-w64-mingw32-gcc >/dev/null 2>&1; then
    x86_64-w64-mingw32-gcc -O2 -Wall -Wextra -std=c11 -D_WIN32_WINNT=0x0A00 -DWINVER=0x0A00 \
        -I.. -o /tmp/test_ush_snapshot.exe test_ush_snapshot.c ../ush_snapshot.c ../ush_json.c \
        -lole32 -loleaut32 -luuid -lwtsapi32 -lgdi32 -luser32 -lbcrypt -lwindowscodecs
    wine64 /tmp/test_ush_snapshot.exe
else
    echo "SKIP: wine64 或 mingw 不在沙箱（H24 harness 见 test_ush_snapshot.c，真机跑）"
fi
