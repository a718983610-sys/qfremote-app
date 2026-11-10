#!/bin/sh
# QFRLEA 交叉编译（Linux → Windows x64）：
#   1) 生成 whitelist.h（脚本类 hash）；
#   2) 编译服务本体 QFRLEA.exe；
#   3) 编译客户端 qf-lea-client.exe；
#   4) 校验 whitelist.h 与当前脚本一致。
# 依赖：x86_64-w64-mingw32-gcc（apt install gcc-mingw-w64-x86-64）。
# 默认构建为生产形态：Ed25519 验签占位 fail-closed（无真实公钥）。
# 测试冒烟构建（仅单测／真机冒烟，生产绝不启用）：
#   LEA_TEST_UNSIGNED=1 ./build.sh
#   此时 signature "TEST-UNSIGNED" 放行。
set -e
cd "$(dirname "$0")"

python3 gen_whitelist.py
if [ "${LEA_TEST_UNSIGNED:-0}" = "1" ]; then
  echo "WARNING: test-only build (LEA_TEST_UNSIGNED=1): TEST-UNSIGNED accepted. NEVER ship this."
  TEST_FLAG="-DLEA_TEST_UNSIGNED=1"
else
  TEST_FLAG=""
fi

# shellcheck disable=SC2086
x86_64-w64-mingw32-gcc -O2 -Wall -Wextra -o QFRLEA.exe QFRLEA.c lea_protocol.c lea_crypto.c lea_state.c lea_audit.c $TEST_FLAG -ladvapi32 -lcrypt32
# shellcheck disable=SC2086
# S3：客户端用 lea_crypto.c 的 lea_b64_decode 解析 dispatch <base64>（纯 C，无需额外库）。
x86_64-w64-mingw32-gcc -O2 -Wall -Wextra -o qf-lea-client.exe qf-lea-client.c lea_crypto.c $TEST_FLAG
python3 gen_whitelist.py --check
ls -l QFRLEA.exe qf-lea-client.exe whitelist.h
