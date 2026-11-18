#!/bin/sh
# QFRLEA A+ TEST 实例交叉编译（Linux → Windows x64）：
#   编译 TEST 身份的 QFRLEA.exe 与 qf-lea-client.exe
#   （-DQFR_LEA_TEST_BUILD=1：服务名 QFRLEA-TEST、管道
#   \\.\pipe\QFR\LEA-TEST\v1、数据根目录 %ProgramData%\QFR\LEA-TEST，
#   与生产资源全隔离；启动时校验失败即 fail-closed）。
#
# 与 build.sh 的区别（刻意）：
#   - 产物写进 ./out-test/，绝不覆盖树内生产 QFRLEA.exe／qf-lea-client.exe；
#   - 不跑 gen_whitelist.py，不改 whitelist.h／install-lea.ps1／
#     whitelist.json／version.txt（生产安装器哈希绝不被 TEST 构建污染）；
#   - 必须显式传 LEA_SERVER_PUBKEY_HEX（与服务端稳定签名密钥对应的
#     64 字符 hex 公钥，不加引号），缺失即拒绝构建——TEST 服务同样要
#     做真实 Ed25519 验签，不用 TEST-UNSIGNED。
#
# 用法（在 windows/lea/ 下）：
#   LEA_SERVER_PUBKEY_HEX=<64 hex> ./build-test.sh
# 产物：out-test/QFRLEA.exe、out-test/qf-lea-client.exe（附 SHA-256）。
# 依赖：x86_64-w64-mingw32-gcc（apt install gcc-mingw-w64-x86-64）。
set -e
cd "$(dirname "$0")"

ED25519_SRCS="ed25519/verify.c ed25519/ge.c ed25519/fe.c ed25519/sc.c ed25519/sha512.c"

if [ -z "${LEA_SERVER_PUBKEY_HEX:-}" ]; then
  echo "ERROR: LEA_SERVER_PUBKEY_HEX is required for the TEST build (64 hex chars, no quotes)" >&2
  exit 1
fi
case "$LEA_SERVER_PUBKEY_HEX" in
  *[!0-9a-fA-F]*)
    echo "ERROR: LEA_SERVER_PUBKEY_HEX must be exactly 64 hex chars" >&2
    exit 1
    ;;
esac
if [ "${#LEA_SERVER_PUBKEY_HEX}" -ne 64 ]; then
  echo "ERROR: LEA_SERVER_PUBKEY_HEX must be exactly 64 hex chars" >&2
  exit 1
fi
echo "Ed25519 verify: server pubkey baked in (${LEA_SERVER_PUBKEY_HEX})"
echo "Instance identity: TEST (QFRLEA-TEST / LEA-TEST pipe / LEA-TEST data root)"

mkdir -p out-test

# shellcheck disable=SC2086
x86_64-w64-mingw32-gcc -O2 -Wall -Wextra -DQFR_LEA_TEST_BUILD=1 -o out-test/QFRLEA.exe QFRLEA.c lea_install.c lea_protocol.c lea_crypto.c lea_state.c lea_audit.c lea_local.c lea_filewrite.c lea_appclose.c lea_diag.c $ED25519_SRCS -DLEA_SERVER_PUBKEY_HEX=$LEA_SERVER_PUBKEY_HEX -ladvapi32 -lcrypt32 -lwtsapi32
# shellcheck disable=SC2086
x86_64-w64-mingw32-gcc -O2 -Wall -Wextra -DQFR_LEA_TEST_BUILD=1 -o out-test/qf-lea-client.exe qf-lea-client.c lea_crypto.c $ED25519_SRCS -DLEA_SERVER_PUBKEY_HEX=$LEA_SERVER_PUBKEY_HEX
ls -l out-test/QFRLEA.exe out-test/qf-lea-client.exe
sha256sum out-test/QFRLEA.exe out-test/qf-lea-client.exe
echo "== TEST build OK: out-test/QFRLEA.exe out-test/qf-lea-client.exe =="
