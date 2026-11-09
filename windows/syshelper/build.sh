#!/bin/sh
# QFSysHelper 交叉编译（Linux → Windows x64）：
#   1) 生成 whitelist.h（脚本类 hash）；
#   2) 编译服务本体 QFSysHelper.exe；
#   3) 生成 whitelist.json（含 exe hash，随包下发）。
# 依赖：x86_64-w64-mingw32-gcc（apt install gcc-mingw-w64-x86-64）。
set -e
cd "$(dirname "$0")"
python3 gen_whitelist.py --header-only
x86_64-w64-mingw32-gcc -O2 -Wall -o QFSysHelper.exe QFSysHelper.c protocol.c -lbcrypt -ladvapi32
python3 gen_whitelist.py --json-only
ls -l QFSysHelper.exe whitelist.h whitelist.json
