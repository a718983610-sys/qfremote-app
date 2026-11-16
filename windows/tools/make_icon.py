#!/usr/bin/env python3
"""QFRemote 图标生成器（白底黑标定稿版）

定稿图标：白色为主，白底黑 C + 黑点，512x512。
本脚本不再绘制任何图形，只以 build/icon.png（定稿源）为唯一输入
派生其余文件，旧蓝版绘制逻辑（蓝渐变 / 白 Q / 橙点）已彻底删除，
重跑也不会把图标打回旧蓝版。

输出：
- build/icon-1024.png：源图 Lanczos 放大到 1024x1024
- build/icon.png：源图本身即定稿，不改动（哈希不变）
- build/icon.ico：多尺寸 ICO（16/20/24/32/48/64/128/256）
- icon.ico（windows/，安装器用）：与 build/icon.ico 内容完全一致
"""
import hashlib
import shutil
from pathlib import Path

from PIL import Image

WINDOWS_DIR = Path(__file__).resolve().parents[1]
BUILD_DIR = WINDOWS_DIR / "build"
SRC = BUILD_DIR / "icon.png"
SIZES = [(16, 16), (20, 20), (24, 24), (32, 32),
         (48, 48), (64, 64), (128, 128), (256, 256)]


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def main():
    src = Image.open(SRC).convert("RGBA")
    assert src.size == (512, 512), f"定稿源尺寸异常: {src.size}，应为 512x512"

    # 1024 母版：Lanczos 放大
    src.resize((1024, 1024), Image.LANCZOS).save(BUILD_DIR / "icon-1024.png")

    # 512：源图本身就是 build/icon.png 定稿，无需复制，哈希天然不变
    assert (BUILD_DIR / "icon.png").resolve() == SRC.resolve()

    # ICO：两处写同一份 PIL 输出，内容完全一致
    src.save(BUILD_DIR / "icon.ico", format="ICO", sizes=SIZES)
    shutil.copyfile(BUILD_DIR / "icon.ico", WINDOWS_DIR / "icon.ico")

    for p in (BUILD_DIR / "icon-1024.png", BUILD_DIR / "icon.png",
              BUILD_DIR / "icon.ico", WINDOWS_DIR / "icon.ico"):
        print(f"{p.relative_to(WINDOWS_DIR)}  {sha256(p)}")
    print("icon done (white)")


if __name__ == "__main__":
    main()
