#!/bin/sh
# QFRLEA 核心逻辑单测（Linux 沙箱可跑）。
#   ./run_tests.sh            # 测试构建＋严格构建＋测试公钥构建各跑一遍
# 另做 mingw 交叉编译检查（只验证 Windows 本体可编译，不验证运行）。
# 测试公钥（LEA_TEST_PUBKEY_HEX）为单元测试专用密钥（种子 bytes(range(32))，
# 仅测试用，绝不用于生产；生产公钥须以 LEA_SERVER_PUBKEY_HEX 另行编入）。
set -e
cd "$(dirname "$0")"

ED25519_SRCS="../ed25519/verify.c ../ed25519/ge.c ../ed25519/fe.c ../ed25519/sc.c ../ed25519/sha512.c"
LEA_TEST_PUBKEY_HEX=03a107bff3ce10be1d70dd18e74bc09967e4d6309ba50d5f1ddc8664125531b8

echo "== [1/5] core tests (test build: TEST-UNSIGNED accepted, no pubkey) =="
gcc -O1 -Wall -Wextra -DLEA_TEST_UNSIGNED=1 -DLEA_TEST_HOOKS=1 -o /tmp/test_lea test_lea.c \
    ../lea_install.c ../lea_protocol.c ../lea_crypto.c ../lea_state.c ../lea_audit.c $ED25519_SRCS
/tmp/test_lea

echo
echo "== [2/5] core tests (strict build: signature fail-closed, no pubkey) =="
gcc -O1 -Wall -Wextra -DLEA_TEST_HOOKS=1 -o /tmp/test_lea_strict test_lea.c \
    ../lea_install.c ../lea_protocol.c ../lea_crypto.c ../lea_state.c ../lea_audit.c $ED25519_SRCS
/tmp/test_lea_strict

echo
echo "== [3/5] core tests (strict build + TEST pubkey: real Ed25519 verify) =="
gcc -O1 -Wall -Wextra -DLEA_TEST_HOOKS=1 -DLEA_SERVER_PUBKEY_HEX=$LEA_TEST_PUBKEY_HEX \
    -o /tmp/test_lea_pubkey test_lea.c \
    ../lea_install.c ../lea_protocol.c ../lea_crypto.c ../lea_state.c ../lea_audit.c $ED25519_SRCS
/tmp/test_lea_pubkey

echo
echo "== [4/5] mingw cross-compile (service + client, compile-only) =="
if command -v x86_64-w64-mingw32-gcc >/dev/null 2>&1; then
    cd ..
    python3 gen_whitelist.py --check
    x86_64-w64-mingw32-gcc -O2 -Wall -Wextra -o /tmp/QFRLEA.exe QFRLEA.c \
        lea_install.c lea_protocol.c lea_crypto.c lea_state.c lea_audit.c \
        ed25519/verify.c ed25519/ge.c ed25519/fe.c ed25519/sc.c ed25519/sha512.c \
        -ladvapi32 -lcrypt32 -lwtsapi32
    # S3：客户端链接 lea_crypto.c（dispatch <base64> 解码用）；lea_crypto.c
    # 引用 ed25519_verify，故客户端同样须链 ed25519 源文件。
    # -Werror：R-C3 回归门；只加已验证的客户端编译命令，不全仓铺开。
    x86_64-w64-mingw32-gcc -O2 -Wall -Wextra -Werror -o /tmp/qf-lea-client.exe qf-lea-client.c lea_crypto.c \
        ed25519/verify.c ed25519/ge.c ed25519/fe.c ed25519/sc.c ed25519/sha512.c
    file /tmp/QFRLEA.exe /tmp/qf-lea-client.exe
    echo "mingw cross-compile OK"
    # A1 隔离：--install-service 等子命令绝不出现在客户端源码里
    #（客户端是唯一能被 runcommands 远程调到的 LEA 二进制；一旦它能
    # 转发服务安装，就等于给远程加了一条装服务入口）。
    if grep -q -- "--install-service\|--uninstall-service\|--verify-manifest" qf-lea-client.c; then
        echo "FATAL: qf-lea-client.c must not reference service subcommands" >&2
        exit 1
    fi
    echo "A1 isolation check OK (client has no service subcommands)"
    cd test
else
    echo "SKIP: x86_64-w64-mingw32-gcc not found"
fi

echo
echo "== [5/5] whitelist check =="
cd ..
python3 gen_whitelist.py --check
echo
echo "ALL DONE"
