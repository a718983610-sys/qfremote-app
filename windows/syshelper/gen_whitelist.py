#!/usr/bin/env python3
"""生成 QFSysHelper 白名单：whitelist.h（编译进服务）与 whitelist.json（随包下发，App 校验用）。
用法（在 windows/ 目录下）：
  python3 syshelper/gen_whitelist.py --header-only   # 编译服务之前：只写 whitelist.h（脚本类 hash）
  python3 syshelper/gen_whitelist.py --json-only     # 编译服务之后：只写 whitelist.json（含 exe hash）
  python3 syshelper/gen_whitelist.py                 # 两步都做（exe 已存在时）
白名单文件与本次发版文件一一对应；任一脚本改动后必须重新生成＋重新编译服务，
否则服务算出的 hash 与白名单对不上、拒绝执行（fail-closed）。
"""
import hashlib
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
WIN = os.path.dirname(HERE)

FILES = {
    "qf-agent-heal.ps1": os.path.join(WIN, "qf-agent-heal.ps1"),
    "install.ps1": os.path.join(WIN, "privacy-lock", "install.ps1"),
    "install-system-services.ps1": os.path.join(WIN, "install-system-services.ps1"),
    "QFSysHelper.exe": os.path.join(HERE, "QFSysHelper.exe"),
}


def sha256(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def main():
    mode = sys.argv[1].lstrip("-") if len(sys.argv) > 1 else "all"
    hashes = {}
    for name, p in FILES.items():
        if name == "QFSysHelper.exe" and mode == "header-only":
            continue
        if not os.path.exists(p):
            print(f"MISSING: {p}")
            sys.exit(1)
        hashes[name] = sha256(p)
        print(f"{name}: {hashes[name]}")
    if mode in ("all", "header-only"):
        header = (
            "/* 自动生成：syshelper/gen_whitelist.py。不要手改；脚本改动后重新生成＋重新编译服务。 */\n"
            "#ifndef QFSYSHELPER_WHITELIST_H\n"
            "#define QFSYSHELPER_WHITELIST_H\n\n"
            f"#define W_HEAL_PS1_SHA256 \"{hashes['qf-agent-heal.ps1']}\"\n"
            f"#define W_LOCK_INSTALL_PS1_SHA256 \"{hashes['install.ps1']}\"\n\n"
            "#endif\n"
        )
        with open(os.path.join(HERE, "whitelist.h"), "w", encoding="utf-8") as f:
            f.write(header)
        print("wrote whitelist.h")
    if mode in ("all", "json-only"):
        doc = {"version": "2.4.5", "files": hashes}
        with open(os.path.join(HERE, "whitelist.json"), "w", encoding="utf-8") as f:
            json.dump(doc, f, indent=2, sort_keys=True)
            f.write("\n")
        print("wrote whitelist.json")


if __name__ == "__main__":
    main()
