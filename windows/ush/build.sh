#!/bin/sh
# USH 交叉编译（Linux → Windows x64），与 QFSysHelper 同链：
#   x86_64-w64-mingw32-gcc（apt install gcc-mingw-w64-x86-64）
# 产物：QFUserHelper.exe（单文件，无 .NET 运行时依赖，无额外 DLL）。
# 用法：./build.sh [--check-only]；--check-only 只编译不链接出包校验用。
set -e
cd "$(dirname "$0")"

CC="${CC:-x86_64-w64-mingw32-gcc}"
CFLAGS="-O2 -Wall -Wextra -std=c11 -D_WIN32_WINNT=0x0A00 -DWINVER=0x0A00"
# 链接：ole32/oleaut32=COM+UIA/VARIANT；uuid=GUID；wtsapi32=会话态；
# gdi32/user32=截图与 SendInput；bcrypt=日志 params SHA-256；windowscodecs=WIC PNG。
LIBS="-lole32 -loleaut32 -luuid -lwtsapi32 -lgdi32 -luser32 -lbcrypt -lwindowscodecs"

echo "== USH build =="
"$CC" $CFLAGS -o QFUserHelper.exe ush.c ush_json.c ush_log.c ush_uia.c ush_snapshot.c $LIBS
ls -l QFUserHelper.exe
sha256sum QFUserHelper.exe
echo "== USH build OK: QFUserHelper.exe =="
