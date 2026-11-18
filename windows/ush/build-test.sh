#!/bin/sh
# QFUserHelper A+ TEST 实例交叉编译（Linux → Windows x64），与 QFSysHelper 同链：
#   编译 TEST 身份的 QFUserHelper.exe（-DQFR_LEA_TEST_BUILD=1：USH 管道
#   \\.\pipe\QFR\LEA-TEST\UserHelper\v1、token 与日志目录
#   %ProgramData%\QFR\LEA-TEST\…，与生产 USH 全隔离）。
#
# 产物写进 ./out-test/，绝不覆盖树内生产 QFUserHelper.exe。
# 用法（在 windows/ush/ 下）：./build-test.sh [--check-only]
# 产物：out-test/QFUserHelper.exe（附 SHA-256）。
set -e
cd "$(dirname "$0")"

CC="${CC:-x86_64-w64-mingw32-gcc}"
CFLAGS="-O2 -Wall -Wextra -std=c11 -D_WIN32_WINNT=0x0A00 -DWINVER=0x0A00 -DQFR_LEA_TEST_BUILD=1"
# 链接：ole32/oleaut32=COM+UIA/VARIANT；uuid=GUID；wtsapi32=会话态；
# gdi32/user32=截图与 SendInput；bcrypt=日志 params SHA-256；windowscodecs=WIC PNG。
# C1：winhttp=自助绑定调服务端 complete/renew；ncrypt=CNG 设备 P-256 密钥；
# crypt32=DPAPI 凭据存取。
LIBS="-lole32 -loleaut32 -luuid -lwtsapi32 -lgdi32 -luser32 -lbcrypt -lwindowscodecs -lwinhttp -lncrypt -lcrypt32"

if [ "${1:-}" = "--check-only" ]; then
  echo "== USH TEST build (check-only) =="
  "$CC" $CFLAGS -fsyntax-only ush.c ush_json.c ush_log.c ush_uia.c ush_snapshot.c ush_selfbind.c
  echo "== USH TEST check-only OK =="
  exit 0
fi

echo "== USH TEST build =="
echo "Instance identity: TEST (LEA-TEST USH pipe / LEA-TEST token+log dirs)"
mkdir -p out-test
"$CC" $CFLAGS -o out-test/QFUserHelper.exe ush.c ush_json.c ush_log.c ush_uia.c ush_snapshot.c ush_selfbind.c $LIBS
ls -l out-test/QFUserHelper.exe
sha256sum out-test/QFUserHelper.exe
echo "== USH TEST build OK: out-test/QFUserHelper.exe =="
