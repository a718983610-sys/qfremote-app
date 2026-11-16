#!/usr/bin/env python3
"""生成安装文件清单 file-manifest.txt（A1，2026-11-13）。

安装器内层（installer.nsi，admin）在解压 app.7z 后调
QFRLEA.exe --verify-manifest "$INSTDIR" "$INSTDIR\\file-manifest.txt"
逐文件 SHA-256 校验；缺失／不一致即从安装包重放并重试（最多 3 次），
仍失败进错误页并写 PendingRepair。

用法（在 work-recovery241 树根）：
  python3 windows/tools/gen_file_manifest.py --payload <payload-dir>
      # 默认输出 <payload-dir>/file-manifest.txt
  python3 windows/tools/gen_file_manifest.py --payload <payload-dir> --check
      # 只校验：清单在位且与 payload 目录逐件一致（发版门用）

格式：每行 "<sha256小写>  <相对路径>"（sha256sum 格式，'/' 分隔，
按相对路径排序）。清单本身不列入清单。只覆盖 payload 目录
（即 app.7z 的内容）；SEC_LEA／SEC_LOCK 的 File 直嵌文件由 makensis
编译时 fatal 校验＋安装时 NSIS 错误标志兜底，不进本清单。
"""
import argparse
import hashlib
import sys
from pathlib import Path

MANIFEST_NAME = "file-manifest.txt"


def sha256_hex(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def build_entries(payload: Path):
    entries = []
    for p in sorted(payload.rglob("*")):
        if not p.is_file():
            continue
        rel = p.relative_to(payload).as_posix()
        if rel == MANIFEST_NAME:
            continue
        entries.append((rel, sha256_hex(p)))
    return entries


def render(entries) -> str:
    return "".join(f"{h}  {rel}\n" for rel, h in entries)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--payload", required=True, help="payload 根目录（app.7z 的内容）")
    ap.add_argument("--out", help="清单输出路径（默认 <payload>/file-manifest.txt）")
    ap.add_argument("--check", action="store_true", help="只校验，不写盘")
    args = ap.parse_args()

    payload = Path(args.payload)
    if not payload.is_dir():
        print(f"FATAL: payload 目录不存在：{payload}", file=sys.stderr)
        return 1
    out = Path(args.out) if args.out else payload / MANIFEST_NAME
    entries = build_entries(payload)
    if not entries:
        print("FATAL: payload 为空", file=sys.stderr)
        return 1
    if args.check:
        if not out.is_file():
            print(f"FATAL: 清单缺失：{out}", file=sys.stderr)
            return 1
        want = render(entries)
        got = out.read_text(encoding="utf-8")
        if got != want:
            print("FATAL: 清单与 payload 不一致（须重跑本脚本生成）", file=sys.stderr)
            return 1
        print(f"manifest check ok: {len(entries)} files")
        return 0
    out.write_text(render(entries), encoding="utf-8")
    print(f"manifest written: {out} ({len(entries)} files)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
