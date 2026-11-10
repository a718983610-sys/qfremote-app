#!/bin/sh
# QFRLEA 核心逻辑单测（Linux 沙箱可跑）。
#   ./run_tests.sh            # 测试构建（LEA_TEST_UNSIGNED=1）＋严格构建各跑一遍
# 另做 mingw 交叉编译检查（只验证 Windows 本体可编译，不验证运行）。
set -e
cd "$(dirname "$0")"

echo "== [1/4] core tests (test build: TEST-UNSIGNED accepted) =="
gcc -O1 -Wall -Wextra -DLEA_TEST_UNSIGNED=1 -o /tmp/test_lea test_lea.c \
    ../lea_protocol.c ../lea_crypto.c ../lea_state.c ../lea_audit.c
/tmp/test_lea

echo
echo "== [2/4] core tests (strict build: signature fail-closed) =="
gcc -O1 -Wall -Wextra -o /tmp/test_lea_strict test_lea.c \
    ../lea_protocol.c ../lea_crypto.c ../lea_state.c ../lea_audit.c
/tmp/test_lea_strict

echo
echo "== [3/4] mingw cross-compile (service + client, compile-only) =="
if command -v x86_64-w64-mingw32-gcc >/dev/null 2>&1; then
    cd ..
    python3 gen_whitelist.py --check
    x86_64-w64-mingw32-gcc -O2 -Wall -Wextra -o /tmp/QFRLEA.exe QFRLEA.c \
        lea_protocol.c lea_crypto.c lea_state.c lea_audit.c -ladvapi32 -lcrypt32 -lwtsapi32
    # S3：客户端链接 lea_crypto.c（dispatch <base64> 解码用）。
    x86_64-w64-mingw32-gcc -O2 -Wall -Wextra -o /tmp/qf-lea-client.exe qf-lea-client.c lea_crypto.c
    file /tmp/QFRLEA.exe /tmp/qf-lea-client.exe
    echo "mingw cross-compile OK"
    cd test
else
    echo "SKIP: x86_64-w64-mingw32-gcc not found"
fi

echo
echo "== [4/4] whitelist check =="
cd ..
python3 gen_whitelist.py --check
echo
echo "ALL DONE"
