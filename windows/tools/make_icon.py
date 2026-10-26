#!/usr/bin/env python3
"""QFRemote 图标精修生成器（v1.0.1）

以图一标为基础精细化，设计语言对齐 QFClash 家族：
- 多层蓝渐变（天蓝 -> 宝蓝 -> 深蓝），带右上信号源头的蔚蓝辉光与顶部镜面高光
- 信号弧：三段同心弧，圆头端点、由内向外由亮转透，圆心内收不贴边
- 橙点：金橙径向渐变 + 柔光晕（呼应 QFClash 的橙色星点缀）
- 白色 Q：纵向微渐变 + 柔和投影，居中偏左下，留白比例向 QFClash 看齐
输出：build/icon-1024.png（母版）、build/icon.png（512）、build/icon.ico（多尺寸）
"""
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter

S = 2048  # 渲染边长，最后降采样抗锯齿
OUT_DIR = __file__.rsplit('/', 2)[0] + '/build'

def lerp(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))

def gradient_bg(size):
    """对角多段渐变背景 + 右上辉光。"""
    stops = [(0.0, (43, 125, 233)), (0.42, (23, 87, 194)),
             (0.75, (11, 47, 110)), (1.0, (7, 31, 74))]
    y, x = np.mgrid[0:size, 0:size].astype(np.float32)
    t = (x * 0.62 + y * 0.78) / (size * 1.40)  # 对角轴
    t = np.clip(t, 0, 1)
    img = np.zeros((size, size, 3), np.float32)
    for i in range(len(stops) - 1):
        t0, c0 = stops[i]
        t1, c1 = stops[i + 1]
        m = (t >= t0) & (t <= t1)
        k = np.zeros_like(t)
        k[m] = (t[m] - t0) / max(t1 - t0, 1e-6)
        for ch in range(3):
            img[..., ch][m] = c0[ch] + (c1[ch] - c0[ch]) * k[m]
    # 右上辉光（信号源头方向）
    gx, gy = 0.74 * size, 0.14 * size
    d = np.sqrt((x - gx) ** 2 + (y - gy) ** 2) / (0.85 * size)
    glow = np.clip(1 - d, 0, 1) ** 2 * 46
    img[..., 0] += glow * 0.55
    img[..., 1] += glow * 0.80
    img[..., 2] += glow * 1.00
    return Image.fromarray(np.clip(img, 0, 255).astype(np.uint8), 'RGB').convert('RGBA')

def squircle_mask(size, radius_ratio=0.235):
    m = Image.new('L', (size, size), 0)
    d = ImageDraw.Draw(m)
    r = int(size * radius_ratio)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=r, fill=255)
    return m

def main():
    bg = gradient_bg(S)
    mask = squircle_mask(S)
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    img.paste(bg, (0, 0), mask)

    # 顶部镜面高光（QFClash 图标的通透感来源之一）
    sheen = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    sa = np.zeros((S, S), np.uint8)
    yy = np.linspace(0, 1, S, dtype=np.float32)
    col = np.clip(1 - yy / 0.34, 0, 1) ** 1.6 * 34
    sa[:, :] = col[:, None].astype(np.uint8)
    sheen.putalpha(Image.fromarray(sa, 'L'))
    sheen_rgb = Image.new('RGBA', (S, S), (255, 255, 255, 255))
    img.paste(sheen_rgb, (0, 0), Image.composite(sheen.getchannel('A'), Image.new('L', (S, S), 0), mask))

    layer = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)

    # ---- 白色 Q（先投影，后本体渐变）----
    font = ImageFont.truetype('/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf', int(S * 0.575))
    glyph = Image.new('L', (S, S), 0)
    gd = ImageDraw.Draw(glyph)
    gd.text((0, 0), 'Q', font=font, fill=255)
    bbox = glyph.getbbox()
    gw, gh = bbox[2] - bbox[0], bbox[3] - bbox[1]
    cx, cy = S * 0.452, S * 0.548  # 光学中心：略偏左下，给右上信号留呼吸位
    ox, oy = int(cx - (bbox[0] + gw / 2)), int(cy - (bbox[1] + gh / 2))
    glyph = glyph.transform((S, S), Image.AFFINE, (1, 0, -ox, 0, 1, -oy))

    shadow = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    sh = Image.new('RGBA', (S, S), (2, 16, 48, 150))
    shadow.paste(sh, (0, int(S * 0.012)), glyph)
    shadow = shadow.filter(ImageFilter.GaussianBlur(S * 0.012))
    img.paste(shadow, (0, 0), shadow.getchannel('A'))

    # Q 本体：白 -> 淡蓝纵向渐变
    qgrad = np.zeros((S, S, 4), np.uint8)
    t = np.linspace(0, 1, S, dtype=np.float32)[:, None]
    top = np.array([255, 255, 255], np.float32)
    bot = np.array([216, 234, 255], np.float32)
    rgb = (top[None, None, :] * (1 - t[..., None]) + bot[None, None, :] * t[..., None]).astype(np.uint8)
    qgrad[..., 0:3] = rgb
    qgrad[..., 3] = np.asarray(glyph)
    img.alpha_composite(Image.fromarray(qgrad, 'RGBA'))

    # ---- 信号弧：同心圆弧，圆头端点，内亮外透 ----
    ccx, ccy = S * 0.772, S * 0.228
    sw = int(S * 0.036)
    arcs = [(0.108, (232, 244, 255, 255)), (0.196, (168, 210, 255, 240)), (0.284, (111, 171, 255, 215))]
    for r_ratio, color in arcs:
        r = S * r_ratio
        box = [ccx - r, ccy - r, ccx + r, ccy + r]
        d.arc(box, start=180, end=270, fill=color, width=sw)
        for ang in (180, 270):
            a = np.deg2rad(ang)
            ex, ey = ccx + r * np.cos(a), ccy + r * np.sin(a)
            d.ellipse([ex - sw / 2, ey - sw / 2, ex + sw / 2, ey + sw / 2], fill=color)
    img.alpha_composite(layer)

    # ---- 橙点：金橙径向渐变 + 光晕（家族橙点）----
    glow_r = int(S * 0.085)
    glow_img = np.zeros((glow_r * 2, glow_r * 2, 4), np.uint8)
    yy, xx = np.mgrid[0:glow_r * 2, 0:glow_r * 2].astype(np.float32)
    dist = np.sqrt((xx - glow_r) ** 2 + (yy - glow_r) ** 2) / glow_r
    ga = (np.clip(1 - dist, 0, 1) ** 2 * 110).astype(np.uint8)
    glow_img[..., 0], glow_img[..., 1], glow_img[..., 2], glow_img[..., 3] = 255, 150, 40, ga
    img.alpha_composite(Image.fromarray(glow_img, 'RGBA'), (int(ccx - glow_r), int(ccy - glow_r)))

    core_r = int(S * 0.043)
    core = np.zeros((core_r * 2, core_r * 2, 4), np.uint8)
    yy, xx = np.mgrid[0:core_r * 2, 0:core_r * 2].astype(np.float32)
    dist = np.sqrt((xx - core_r) ** 2 + (yy - core_r) ** 2) / core_r
    c_top = np.array([255, 211, 77], np.float32)
    c_bot = np.array([255, 138, 30], np.float32)
    tt = np.clip((yy / (core_r * 2))[..., None], 0, 1)
    core[..., 0:3] = (c_top * (1 - tt) + c_bot * tt).astype(np.uint8)
    core[..., 3] = np.where(dist <= 1, 255, 0).astype(np.uint8)
    img.alpha_composite(Image.fromarray(core, 'RGBA'), (int(ccx - core_r), int(ccy - core_r)))

    # 底部轻微压暗，增加纵深
    vig = np.zeros((S, S), np.uint8)
    t2 = np.clip((np.linspace(0, 1, S, dtype=np.float32) - 0.72) / 0.28, 0, 1) ** 1.5 * 40
    vig[:, :] = t2[:, None].astype(np.uint8)
    black = Image.new('RGBA', (S, S), (0, 6, 24, 255))
    img.paste(black, (0, 0), Image.fromarray(vig, 'L'))

    # 统一裁进 squircle
    final = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    final.paste(img, (0, 0), mask)

    master = final.resize((1024, 1024), Image.LANCZOS)
    master.save(OUT_DIR + '/icon-1024.png')
    master.resize((512, 512), Image.LANCZOS).save(OUT_DIR + '/icon.png')
    master.save(OUT_DIR + '/icon.ico', format='ICO',
                sizes=[(16, 16), (20, 20), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    print('icon done')

if __name__ == '__main__':
    main()
