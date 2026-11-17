#!/usr/bin/env python3
"""将 package.json build.asarUnpack 列出的文件 staging 到 payload 的
resources/app.asar.unpacked/（与 asar 内相同的相对路径）。

背景（PACKAGING-DEFECT-ASARUNPACK-20261111.md）：Windows 打包流水线
不用 electron-builder，而是手工 asar pack + 7z + makensis，因此
package.json 里的 build.asarUnpack 配置从未被任何工具消费——3.0.0
测试包里根本没有 resources/app.asar.unpacked/，导致首启登录时
maybeInstallSystemServices 因 sysPs1 不存在直接返 no-component，
系统服务与 LEA 永不安装。本脚本是流水线里补上这一步的唯一落点：
每次打 app.asar 后、打 app.7z 前，必须跑一次。

用法（在 work-recovery241 树内）：
  python3 windows/tools/stage-asar-unpacked.py --src windows/ --payload <payload-dir>
      # 默认 --package-json windows/package.json
  python3 windows/tools/stage-asar-unpacked.py --check --payload <payload-dir>
      # 只校验：payload 里 unpacked 三件是否在位且哈希与源码一致（发版门用）

任一文件缺失／哈希不一致即报错并 exit 1；只读校验（--check）不写盘。
"""
import argparse
import hashlib
import json
import shutil
import sys
from pathlib import Path


def sha256_hex(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def load_unpack_list(package_json: Path):
    try:
        doc = json.loads(package_json.read_text(encoding="utf-8"))
    except Exception as e:
        print(f"FATAL: 读不出 {package_json}: {e}", file=sys.stderr)
        return None
    lst = ((doc.get("build") or {}).get("asarUnpack")) if isinstance(doc, dict) else None
    if not isinstance(lst, list) or not lst:
        print(f"FATAL: {package_json} 里没有 build.asarUnpack（须先配好三件）", file=sys.stderr)
        return None
    return lst


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", help="asar 源根目录（build.files 的根，如 windows/）")
    ap.add_argument("--payload", required=True, help="payload 根目录（内含 resources/）")
    ap.add_argument("--package-json", default="windows/package.json")
    ap.add_argument("--check", action="store_true", help="只校验，不写盘")
    args = ap.parse_args()

    package_json = Path(args.package_json)
    payload = Path(args.payload)
    unpacked_root = payload / "resources" / "app.asar.unpacked"

    lst = load_unpack_list(package_json)
    if lst is None:
        return 1
    if not args.check and not args.src:
        print("FATAL: staging 须传 --src（asar 源根目录）", file=sys.stderr)
        return 1
    src_root = Path(args.src) if args.src else None

    bad = 0
    for rel in lst:
        src = (src_root / rel) if src_root else None
        dst = unpacked_root / rel
        if args.check:
            if not dst.exists():
                print(f"MISSING: {dst}（payload 缺 app.asar.unpacked/{rel}）")
                bad += 1
                continue
            if src is None or not src.exists():
                print(f"MISSING-SRC: {src}（无法比对）")
                bad += 1
                continue
            if sha256_hex(dst) != sha256_hex(src):
                print(f"MISMATCH: {dst} 与源码哈希不一致")
                bad += 1
            else:
                print(f"OK: app.asar.unpacked/{rel} sha256={sha256_hex(dst)[:16]}...")
            continue
        if not src.exists():
            print(f"FATAL: 源文件不存在：{src}", file=sys.stderr)
            return 1
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
        if sha256_hex(dst) != sha256_hex(src):
            print(f"FATAL: 拷贝后哈希不一致：{dst}", file=sys.stderr)
            return 1
        print(f"staged: app.asar.unpacked/{rel} ({dst.stat().st_size} B, sha256={sha256_hex(dst)})")
    if args.check:
        if bad:
            print(f"app.asar.unpacked 校验失败（{bad} 项），须重跑 staging", file=sys.stderr)
            return 1
        print(f"app.asar.unpacked OK（{len(lst)} 件与源码一致）")
        return 0
    print(f"staged {len(lst)} files into {unpacked_root}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
