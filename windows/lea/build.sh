#!/bin/sh
# QFRLEA 交叉编译（Linux → Windows x64）：
#   1) 生成 whitelist.h（脚本类 hash）；
#   2) 编译服务本体 QFRLEA.exe；
#   3) 编译客户端 qf-lea-client.exe；
#   4) 校验 whitelist.h 与当前脚本一致；
#   5) 重写 version.txt（H19：供 installer.nsi SEC_LEA fatal 打包）；
#   6) 刷新 install-lea.ps1 的载荷哈希＋whitelist.json（H17/H20：exe
#      每重编一次哈希就变，不刷新则安装直接 fail-closed 报 degraded）。
# 依赖：x86_64-w64-mingw32-gcc（apt install gcc-mingw-w64-x86-64）。
# Ed25519 验签（真实实现，vendored Orlp ed25519，仅验签路径）：
#   默认构建：未编入服务端公钥，验签 fail-closed（无公钥即拒绝一切命令）。
#   生产构建：须以环境变量 LEA_SERVER_PUBKEY_HEX=<64 字符 hex，不加引号>
#   传入与服务端稳定签名密钥对应的公钥，编入后验签才放行有效签名。
#   服务端须先配好稳定密钥（signingKeyFile），否则公钥无从对应。
# 测试冒烟构建（仅单测／真机冒烟，生产绝不启用）：
#   LEA_TEST_UNSIGNED=1 ./build.sh
#   此时 signature "TEST-UNSIGNED" 放行。
set -e
cd "$(dirname "$0")"

ED25519_SRCS="ed25519/verify.c ed25519/ge.c ed25519/fe.c ed25519/sc.c ed25519/sha512.c"

# Product version comes from the repository's release source, never a second
# hand-maintained LEA version (M-124).
BUILD_VERSION=$(python3 -c 'import json; print(json.load(open("../../version.json"))["version"])')
OUTPUT_DIR=.
if [ "${LEA_TEST_UNSIGNED:-0}" = "1" ]; then
  if [ -z "${LEA_TEST_OUTPUT_DIR:-}" ] || [ "$LEA_TEST_OUTPUT_DIR" = "." ]; then
    echo "ERROR: test builds require a separate LEA_TEST_OUTPUT_DIR; normal package paths are forbidden" >&2
    exit 1
  fi
  mkdir -p "$LEA_TEST_OUTPUT_DIR"
  OUTPUT_DIR=$(cd "$LEA_TEST_OUTPUT_DIR" && pwd)
  if [ "$OUTPUT_DIR" = "$(pwd)" ]; then
    echo "ERROR: LEA_TEST_OUTPUT_DIR must not be the production directory" >&2
    exit 1
  fi
fi
python3 gen_whitelist.py
if [ "${LEA_TEST_UNSIGNED:-0}" = "1" ]; then
  echo "WARNING: test-only build (LEA_TEST_UNSIGNED=1): TEST-UNSIGNED accepted. NEVER ship this."
  TEST_FLAG="-DLEA_TEST_UNSIGNED=1"
else
  TEST_FLAG=""
fi

if [ -n "${LEA_SERVER_PUBKEY_HEX:-}" ]; then
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
  PUBKEY_FLAG="-DLEA_SERVER_PUBKEY_HEX=$LEA_SERVER_PUBKEY_HEX"
else
  if [ "${LEA_TEST_UNSIGNED:-0}" != "1" ]; then
    echo "ERROR: production build requires LEA_SERVER_PUBKEY_HEX; no-key fail-closed verification builds belong in test/run_tests.sh" >&2
    exit 1
  fi
  PUBKEY_FLAG=""
fi

# shellcheck disable=SC2086
x86_64-w64-mingw32-gcc -O2 -Wall -Wextra -D_WIN32_WINNT=0x0A00 -DWINVER=0x0A00 -o "$OUTPUT_DIR/QFRLEA.exe" QFRLEA.c lea_install.c lea_protocol.c lea_crypto.c lea_state.c lea_audit.c $ED25519_SRCS $TEST_FLAG $PUBKEY_FLAG -ladvapi32 -lcrypt32 -lwtsapi32
# shellcheck disable=SC2086
# S3：客户端用 lea_crypto.c 的 lea_b64_decode 解析 dispatch <base64>（纯 C，无需额外库）。
# lea_crypto.c 引用 ed25519_verify，故客户端同样须链 ed25519 源文件。
x86_64-w64-mingw32-gcc -O2 -Wall -Wextra -D_WIN32_WINNT=0x0A00 -DWINVER=0x0A00 -o "$OUTPUT_DIR/qf-lea-client.exe" qf-lea-client.c lea_crypto.c $ED25519_SRCS $TEST_FLAG $PUBKEY_FLAG
python3 gen_whitelist.py --check
# M-017/M-127: check actual artifacts and keep unsafe output away from installers.
if [ "${LEA_TEST_UNSIGNED:-0}" = "1" ]; then
  for artifact in "$OUTPUT_DIR/QFRLEA.exe" "$OUTPUT_DIR/qf-lea-client.exe"; do
    strings "$artifact" | grep -q QFRLEA_TEST_UNSIGNED_BUILD || { echo "ERROR: missing test marker" >&2; exit 1; }
  done
  sha256sum "$OUTPUT_DIR/QFRLEA.exe" "$OUTPUT_DIR/qf-lea-client.exe"
  printf '%s-test-only\n' "$BUILD_VERSION" > "$OUTPUT_DIR/version.txt"
  exit 0
fi
for artifact in QFRLEA.exe qf-lea-client.exe; do
  if strings "$artifact" | grep -q QFRLEA_TEST_UNSIGNED_BUILD; then
    echo "ERROR: test-only marker in normal build" >&2; exit 1
  fi
done
printf '%s\n' "$BUILD_VERSION" > version.txt
sha256sum QFRLEA.exe qf-lea-client.exe
# H17/H20：刚编出的 exe 哈希已变，同步刷新安装脚本的载荷哈希与白名单。
python3 gen_whitelist.py --update-installer
python3 ../syshelper/gen_whitelist.py
node ../tools/native-build-receipt.js --record lea
ls -l QFRLEA.exe qf-lea-client.exe whitelist.h version.txt
