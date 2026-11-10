#!/usr/bin/env python3
"""生成 QFSysHelper 白名单：whitelist.h（编译进服务）与 whitelist.json（随包下发，App 校验用）。
用法（在 windows/ 目录下）：
  python3 syshelper/gen_whitelist.py --header-only   # 编译服务之前：只写 whitelist.h（脚本类 hash）
  python3 syshelper/gen_whitelist.py --json-only     # 编译服务之后：只写 whitelist.json（含 exe hash）
  python3 syshelper/gen_whitelist.py                 # 两步都做（exe 已存在时）
白名单文件与本次发版文件一一对应；任一脚本改动后必须重新生成＋重新编译服务，
否则服务算出的 hash 与白名单对不上、拒绝执行（fail-closed）。
H20：install-lea.ps1 纳入 whitelist.json（main.js 提权拉起前验 hash；LEA
服务安装脚本自此有白名单约束，不再是注释里说的“未纳入白名单”状态）。
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
    "install-lea.ps1": os.path.join(WIN, "install-lea.ps1"),
    "QFSysHelper.exe": os.path.join(HERE, "QFSysHelper.exe"),
}


def sha256(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def check_whitelist() -> int:
    """真 --check（F1 深查发现）：旧实现把 --check 当作未知 mode，
    只打印哈希、写 nothing、exit 0——发版门“gen_whitelist.py --check
    必过”会静默放行过期白名单。现逐项比对磁盘实算与 whitelist.json
    登记值：缺失／不一致／多余条目均报错并 exit 1；只读不写。"""
    import json as _json
    json_path = os.path.join(HERE, "whitelist.json")
    if not os.path.exists(json_path):
        print("whitelist.json 不存在", file=sys.stderr)
        return 1
    try:
        with open(json_path, encoding="utf-8") as f:
            doc = _json.load(f)
    except Exception as e:
        print(f"whitelist.json 读不出: {e}", file=sys.stderr)
        return 1
    registered = doc.get("files") if isinstance(doc, dict) else None
    if not isinstance(registered, dict):
        print("whitelist.json 里没有 files 表", file=sys.stderr)
        return 1
    bad = 0
    for name, p in sorted(FILES.items()):
        if not os.path.exists(p):
            print(f"MISSING: {p}")
            bad += 1
            continue
        actual = sha256(p)
        want = registered.get(name)
        if want != actual:
            print(f"MISMATCH: {name}: whitelist.json 登记 {want}，磁盘实算 {actual}")
            bad += 1
        else:
            print(f"OK: {name}: {actual}")
    for name in sorted(registered):
        if name not in FILES:
            print(f"EXTRA: whitelist.json 有多余条目 {name}（磁盘无此文件）")
            bad += 1
    if bad:
        print(f"whitelist.json 与磁盘文件不一致（{bad} 项），请用 gen_whitelist.py 刷新", file=sys.stderr)
        return 1
    print("whitelist.json OK（全部登记项与磁盘实算一致）")
    return 0


def main():
    mode = sys.argv[1].lstrip("-") if len(sys.argv) > 1 else "all"
    if mode == "check":
        return check_whitelist()
    if mode not in ("all", "header-only", "json-only"):
        print(f"未知模式: {sys.argv[1]}（可用: all / --header-only / --json-only / --check）", file=sys.stderr)
        return 2
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
        doc = {"version": "3.0.0", "files": hashes}
        with open(os.path.join(HERE, "whitelist.json"), "w", encoding="utf-8") as f:
            json.dump(doc, f, indent=2, sort_keys=True)
            f.write("\n")
        print("wrote whitelist.json")


if __name__ == "__main__":
    raise SystemExit(main())
