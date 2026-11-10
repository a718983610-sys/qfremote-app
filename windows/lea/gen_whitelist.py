#!/usr/bin/env python3
"""生成 windows/lea/whitelist.h：从发版文件算 SHA-256。

用法（在 windows/lea/ 下）：
    python3 gen_whitelist.py            # 生成 whitelist.h
    python3 gen_whitelist.py --check    # 只校验现文件与脚本是否一致

参照 windows/syshelper/gen_whitelist.py 的模式。白名单初始清单
（DESIGN §5.2，待站长确认完整清单 §14 #5）：仅 qf-agent-heal.ps1 一个。
脚本改动后必须重新生成＋重新编译服务，否则 hash 对不上、服务拒绝执行。
"""
import argparse
import hashlib
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
# qf-agent-heal.ps1 在 windows/ 根目录（随 app.7z 进包，见 CODEBASE-SURVEY §4）。
HEAL_PS1 = HERE.parent / "qf-agent-heal.ps1"
OUT = HERE / "whitelist.h"

HEADER = """/* 自动生成：lea/gen_whitelist.py。不要手改；脚本改动后重新生成＋重新编译服务。
 * 初始清单（DESIGN §5.2，待站长确认完整清单 §14 #5）：仅 QFR 自带运维脚本
 * qf-agent-heal.ps1 一个。 */
#ifndef QFRLEA_WHITELIST_H
#define QFRLEA_WHITELIST_H

#define W_HEAL_PS1_SHA256 "{heal}"

#endif
"""


def sha256_hex(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args()

    if not HEAL_PS1.exists():
        print(f"FATAL: {HEAL_PS1} 不存在（须在 work-recovery241 树内运行）", file=sys.stderr)
        return 1
    heal = sha256_hex(HEAL_PS1)
    text = HEADER.format(heal=heal)
    if args.check:
        if not OUT.exists():
            print("whitelist.h 不存在", file=sys.stderr)
            return 1
        if OUT.read_text(encoding="utf-8") != text:
            print("whitelist.h 与当前脚本 hash 不一致，请重新生成", file=sys.stderr)
            return 1
        print(f"whitelist.h OK (qf-agent-heal.ps1 sha256={heal})")
        return 0
    OUT.write_text(text, encoding="utf-8")
    print(f"wrote {OUT} (qf-agent-heal.ps1 sha256={heal})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
