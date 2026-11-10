#!/bin/sh
# USH 沙箱单测入口：纯逻辑层（ush_json.c）用宿主 gcc 编译运行。
# Windows 专属部分（UIA/管道/截图/会话门）沙箱跑不了，见 WINDOWS-TESTS.md。
set -e
cd "$(dirname "$0")"
gcc -std=c11 -Wall -Wextra -I.. -o /tmp/test_ush_json test_ush_json.c ../ush_json.c
/tmp/test_ush_json
