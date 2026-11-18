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
  echo "Ed25519 verify: NO server pubkey baked in (fail-closed; pass LEA_SERVER_PUBKEY_HEX=<64 hex> for production)"
  PUBKEY_FLAG=""
fi

if [ "${QFRLEA_ALLOW_DEV_ELECTRON:-0}" = "1" ]; then
  echo "WARNING: dev-only build (QFRLEA_ALLOW_DEV_ELECTRON=1): electron.exe parent accepted. NEVER ship this."
  DEV_FLAG="-DQFRLEA_ALLOW_DEV_ELECTRON=1"
else
  DEV_FLAG=""
fi

# shellcheck disable=SC2086
x86_64-w64-mingw32-gcc -O2 -Wall -Wextra -o QFRLEA.exe QFRLEA.c lea_install.c lea_protocol.c lea_crypto.c lea_state.c lea_audit.c lea_local.c lea_filewrite.c lea_appclose.c lea_diag.c $ED25519_SRCS $TEST_FLAG $PUBKEY_FLAG $DEV_FLAG -ladvapi32 -lcrypt32 -lwtsapi32
# shellcheck disable=SC2086
# S3：客户端用 lea_crypto.c 的 lea_b64_decode 解析 dispatch <base64>（纯 C，无需额外库）。
# lea_crypto.c 引用 ed25519_verify，故客户端同样须链 ed25519 源文件。
x86_64-w64-mingw32-gcc -O2 -Wall -Wextra -o qf-lea-client.exe qf-lea-client.c lea_crypto.c $ED25519_SRCS $TEST_FLAG $PUBKEY_FLAG
python3 gen_whitelist.py --check
# H19：每次构建重写 version.txt（与 install-lea.ps1 的默认值 0.1.0 一致）。
printf '0.1.0\n' > version.txt
# H17/H20：刚编出的 exe 哈希已变，同步刷新安装脚本的载荷哈希与白名单。
python3 gen_whitelist.py --update-installer
python3 ../syshelper/gen_whitelist.py
ls -l QFRLEA.exe qf-lea-client.exe whitelist.h version.txt
