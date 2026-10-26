#!/usr/bin/env python3
"""把 Electron 真实渲染的截图拼成最终预览图与新旧对比图。"""
from PIL import Image, ImageDraw, ImageFont

APP = '/home/hatch/workspace/qfremote/app-v1'
TMP = '/tmp/qfr101'
F_B = '/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc'
F_R = '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc'

def stitch(toolbar_path, content_path, out):
    tb = Image.open(toolbar_path).convert('RGB')
    ct = Image.open(content_path).convert('RGB')
    canvas = Image.new('RGB', (tb.width, tb.height + ct.height), (10, 36, 80))
    canvas.paste(tb, (0, 0))
    canvas.paste(ct, (0, tb.height))
    canvas.save(out)
    return canvas

main_img = stitch(f'{TMP}/pv-main/_pv_toolbar.png', f'{TMP}/pv-main/_pv_content.png', f'{APP}/ui-final-main.png')
off_img = stitch(f'{TMP}/pv-offline/_pv_toolbar.png', f'{TMP}/pv-offline/_pv_content.png', f'{APP}/ui-final-offline.png')
splash_img = Image.open(f'{TMP}/pv-splash/_pv_splash.png').convert('RGB')
splash_img.save(f'{APP}/ui-final-splash.png')

# ---------------- 对比图 ----------------
W = 1680
BG = (238, 243, 251)
NAVY = (10, 36, 80)
SUB = (91, 123, 180)
WHITE = (255, 255, 255)
MUTE = (120, 140, 175)

old_icon = Image.open(f'{TMP}/old-icon.png').convert('RGBA')
new_icon = Image.open('/home/hatch/workspace/qfremote/app-src/build/icon.png').convert('RGBA')
old_splash = Image.open(f'{APP}/ui-preview-splash.png').convert('RGB')
old_main = Image.open(f'{APP}/ui-preview.png').convert('RGB')

rows = []  # (title, [(img, label)], height)
def fit(img, w=None, h=None):
    r = (w / img.width) if w else (h / img.height)
    return img.resize((round(img.width * r), round(img.height * r)), Image.LANCZOS)

rows.append(('应用图标', [(fit(old_icon, 300, 300), '旧版：平涂、弧贴边角'),
                          (fit(new_icon, 300, 300), '新版：多层渐变、圆头弧、橙点光晕')]))
rows.append(('启动画面', [(fit(old_splash, h=300), '旧版：平铺深蓝＋小图标'),
                           (fit(splash_img, h=300), '新版：图标置于光泽瓷砖中，轨道环母题，层次分明')]))
rows.append(('主界面', [(fit(old_main, w=792), '旧版：一条深蓝杠＋文字按钮，内容区一片纯蓝'),
                         (fit(main_img, w=792), '新版：亮蓝渐变工具栏（全屏／缩放／置顶），玻璃卡片加载页')]))

HEADER = 128
SEC_T = 52
LBL = 44
PAD = 26
FOOT = 196
total_h = HEADER + FOOT
for _, items in rows:
    total_h += SEC_T + max(i.height for i, _ in items) + LBL + PAD

canvas = Image.new('RGB', (W, total_h), BG)
d = ImageDraw.Draw(canvas)
d.rectangle([0, 0, W, HEADER], fill=NAVY)
d.text((56, 30), 'QFRemote 界面升级对比', font=ImageFont.truetype(F_B, 42), fill=WHITE)
d.text((58, 84), '左：v1.0.0 旧版   ｜   右：v1.0.1 新版（对齐 QFClash 家族设计语言）',
       font=ImageFont.truetype(F_R, 23), fill=(169, 198, 245))

y = HEADER + 10
for title, items in rows:
    d.text((56, y + 6), title, font=ImageFont.truetype(F_B, 30), fill=NAVY)
    y += SEC_T
    ih = max(i.height for i, _ in items)
    total_w = sum(i.width for i, _ in items) + 56
    x = (W - total_w) // 2
    for img, label in items:
        canvas.paste(img, (x, y), img if img.mode == 'RGBA' else None)
        tw = d.textlength(label, font=ImageFont.truetype(F_R, 21))
        d.text((x + (img.width - tw) / 2, y + ih + 10), label, font=ImageFont.truetype(F_R, 21), fill=SUB)
        x += img.width + 56
    y += ih + LBL + PAD

notes = [
    '升级点一览：',
    '① 图标：多层蓝渐变＋顶部镜面高光；信号弧内收、圆头端点、由亮转透；橙点改金橙径向渐变并带光晕。',
    '② 工具栏：亮蓝渐变＋统一 2px 圆头线条图标；新增全屏、页面缩放（带百分比）、窗口置顶，均为真功能，配中文提示与快捷键（F11 / Ctrl+加减）。',
    '③ 启动 / 加载 / 断线三页：玻璃拟态卡片＋大留白＋金色轨道环母题，深色用深蓝灰、不用纯黑，与 QFClash 同一家族。',
    '④ 断线行为：整页失败走断线友好页自动重试；会话断开由看护自动重点连，工具栏只显示一行小字，全程不用用户动手。',
]
d.rectangle([0, total_h - FOOT, W, total_h], fill=(222, 233, 250))
ny = total_h - FOOT + 22
for i, line in enumerate(notes):
    d.text((56, ny), line, font=ImageFont.truetype(F_B if i == 0 else F_R, 22 if i == 0 else 21),
           fill=NAVY if i == 0 else (52, 78, 128))
    ny += 33

canvas.save(f'{APP}/ui-design-compare.png')
print('previews done', canvas.size)
