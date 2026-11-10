#!/usr/bin/env python3
"""生成 windows/lea/whitelist.h：从发版文件算 SHA-256。

用法（在 windows/lea/ 下）：
    python3 gen_whitelist.py                  # 生成 whitelist.h
    python3 gen_whitelist.py --check          # 只校验现文件与白名单是否一致
    python3 gen_whitelist.py --update-installer
        # 刷新 windows/install-lea.ps1 里载荷 exe 的期望哈希（H17）；
        # 三个 exe 任一重编后都必须重刷，否则安装直接报 degraded。
        # 刷完须再跑 syshelper/gen_whitelist.py 刷新 whitelist.json
        # 里的 install-lea.ps1 哈希（脚本本身变了）。

参照 windows/syshelper/gen_whitelist.py 的模式。白名单清单
（DESIGN §5.2，待站长确认完整清单 §14 #5）：
  脚本白名单：qf-agent-heal.ps1 一个。
  app.open 白名单（H16）：QFUserHelper.exe 一个（名＋SHA-256 双重判定）。
文件改动后必须重新生成＋重新编译服务，否则 hash 对不上、服务拒绝执行。
"""
import argparse
import hashlib
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
# qf-agent-heal.ps1 在 windows/ 根目录（随 app.7z 进包，见 CODEBASE-SURVEY §4）。
HEAL_PS1 = HERE.parent / "qf-agent-heal.ps1"
# USH 在 windows/ush/（另一线 build.sh 产物；重编后 hash 会变，须重刷本白名单）。
USH_EXE = HERE.parent / "ush" / "QFUserHelper.exe"
OUT = HERE / "whitelist.h"
# H17：install-lea.ps1 拷文件前验的载荷 exe（与本脚本同一批发版二进制）。
INSTALLER_PS1 = HERE.parent / "install-lea.ps1"
LEA_EXES = {
    "QFRLEA.exe": HERE / "QFRLEA.exe",
    "qf-lea-client.exe": HERE / "qf-lea-client.exe",
    "QFUserHelper.exe": USH_EXE,
}
HASH_BLOCK_START = "# BEGIN LEA-EXPECTED-HASHES (gen_whitelist.py --update-installer)"
HASH_BLOCK_END = "# END LEA-EXPECTED-HASHES"

HEADER = """/* 自动生成：lea/gen_whitelist.py。不要手改；脚本改动后重新生成＋重新编译服务。
 * 清单（DESIGN §5.2，待站长确认完整清单 §14 #5）：
 *   脚本白名单：qf-agent-heal.ps1 一个。
 *   app.open 白名单（H16）：QFUserHelper.exe 一个（名＋SHA-256 双重判定）。
 * 任一文件重编／改动后必须重新生成＋重新编译服务，否则 hash 对不上、服务拒绝执行。
 * USH 重编后须同步重刷 windows/install-lea.ps1 的载荷哈希（--update-installer）。
 */
#ifndef QFRLEA_WHITELIST_H
#define QFRLEA_WHITELIST_H

#define W_HEAL_PS1_SHA256 "{heal}"
#define W_USH_EXE_SHA256 "{ush}"

#endif
"""


def sha256_hex(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            h.update(chunk)
    return h.hexdigest()


def update_installer() -> int:
    """刷新 install-lea.ps1 的 $expectedHashes 块（H17）。"""
    for name, p in LEA_EXES.items():
        if not p.exists():
            print(f"FATAL: {p} 不存在（须在 work-recovery241 树内运行）", file=sys.stderr)
            return 1
    if not INSTALLER_PS1.exists():
        print(f"FATAL: {INSTALLER_PS1} 不存在", file=sys.stderr)
        return 1
    hashes = {name: sha256_hex(p) for name, p in sorted(LEA_EXES.items())}
    lines = ["$expectedHashes = @{"]
    lines += [f"  '{name}' = '{hashes[name]}'" for name in sorted(hashes)]
    lines += ["}"]
    block = "\n".join([HASH_BLOCK_START] + lines + [HASH_BLOCK_END])
    text = INSTALLER_PS1.read_text(encoding="utf-8")
    pat = re.compile(re.escape(HASH_BLOCK_START) + r".*?" + re.escape(HASH_BLOCK_END), re.S)
    if not pat.search(text):
        print("FATAL: install-lea.ps1 里找不到期望哈希块标记（须先由 H17 写入占位块）", file=sys.stderr)
        return 1
    INSTALLER_PS1.write_text(pat.sub(block, text, count=1), encoding="utf-8")
    for name in sorted(hashes):
        print(f"{name}: {hashes[name]}")
    print(f"updated {INSTALLER_PS1} (expected hashes refreshed)")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--update-installer", action="store_true")
    args = ap.parse_args()

    if args.update_installer:
        return update_installer()

    for p in (HEAL_PS1, USH_EXE):
        if not p.exists():
            print(f"FATAL: {p} 不存在（须在 work-recovery241 树内运行）", file=sys.stderr)
            return 1
    heal = sha256_hex(HEAL_PS1)
    ush = sha256_hex(USH_EXE)
    text = HEADER.format(heal=heal, ush=ush)
    if args.check:
        if not OUT.exists():
            print("whitelist.h 不存在", file=sys.stderr)
            return 1
        if OUT.read_text(encoding="utf-8") != text:
            print("whitelist.h 与当前文件 hash 不一致，请重新生成", file=sys.stderr)
            return 1
        print(f"whitelist.h OK (qf-agent-heal.ps1 sha256={heal}, QFUserHelper.exe sha256={ush})")
        return 0
    OUT.write_text(text, encoding="utf-8")
    print(f"wrote {OUT} (qf-agent-heal.ps1 sha256={heal}, QFUserHelper.exe sha256={ush})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
