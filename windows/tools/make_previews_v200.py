#!/usr/bin/env python3
"""v2.0.0 预览拼图：官网六图（连接页/深灰主界面/启动页/断线页/状态灯/关于面板）。"""
from PIL import Image, ImageDraw, ImageFont

APP = '/home/hatch/workspace/qfremote/app-v1'
WEB = '/home/hatch/workspace/qfremote-website/assets/shots'
TMP = '/tmp/qfr200'
F_R = '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc'

def stitch(d, out_app, out_web, bg=(10, 36, 80)):
    tb = Image.open(f'{TMP}/{d}/_pv_toolbar.png').convert('RGB')
    ct = Image.open(f'{TMP}/{d}/_pv_content.png').convert('RGB')
    canvas = Image.new('RGB', (tb.width, tb.height + ct.height), bg)
    canvas.paste(tb, (0, 0))
    canvas.paste(ct, (0, tb.height))
    canvas.save(out_app)
    if out_web:
        canvas.save(out_web)
    return canvas

stitch('main-blue', f'{APP}/ui-v200-main-blue.png', f'{WEB}/connecting.png')
stitch('main-dark', f'{APP}/ui-v200-main-dark.png', f'{WEB}/main-dark.png', bg=(23, 24, 28))
stitch('off-dark', f'{APP}/ui-v200-offline-dark.png', f'{WEB}/offline-dark.png', bg=(23, 24, 28))
Image.open(f'{TMP}/splash-dark/_pv_splash.png').convert('RGB').save(f'{APP}/ui-v200-splash-dark.png')
Image.open(f'{TMP}/splash-dark/_pv_splash.png').convert('RGB').save(f'{WEB}/splash-dark.png')
Image.open(f'{TMP}/upd-dark/_pv_about1.png').convert('RGB').save(f'{APP}/ui-v200-about-dark.png')
Image.open(f'{TMP}/upd-dark/_pv_about1.png').convert('RGB').save(f'{WEB}/about-dark.png')

# 状态灯特写：在亮蓝主界面工具条里定位绿灯像素，居中裁 280 宽，放大 3 倍并加注（沿 v102 规矩）
tb = Image.open(f'{TMP}/main-blue/_pv_toolbar.png').convert('RGB')
px = tb.load()
xs = []
for x in range(tb.width):
    for y in range(tb.height):
        r, g, b = px[x, y]
        if g > 150 and r < 130 and b < 130:  # 绿灯像素
            xs.append(x)
            break
cx = (min(xs) + max(xs)) // 2 if xs else 508
x0 = max(0, min(tb.width - 280, cx - 140))
crop = tb.crop((x0, 0, x0 + 280, tb.height)).resize((280 * 3, tb.height * 3), Image.LANCZOS)
label_h = 44
out = Image.new('RGB', (crop.width, crop.height + label_h), (238, 243, 251))
out.paste(crop, (0, 0))
d = ImageDraw.Draw(out)
d.text((14, crop.height + 9), '状态灯特写：绿灯＝服务器可达（每分钟自动探活一次，点击看最近检测结果与时间）',
       font=ImageFont.truetype(F_R, 21), fill=(52, 78, 128))
out.save(f'{APP}/ui-v200-status-light.png')
out.save(f'{WEB}/status-light.png')
print('v200 previews done, light cx =', cx)
