#!/usr/bin/env python3
"""v1.0.2 预览拼图：双主题主界面 + 深色断线页 + 深色启动画面 + 状态灯特写。"""
from PIL import Image, ImageDraw, ImageFont

APP = '/home/hatch/workspace/qfremote/app-v1'
TMP = '/tmp/qfr102'
F_R = '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc'

def stitch(d, out, bg=(10, 36, 80)):
    tb = Image.open(f'{TMP}/{d}/_pv_toolbar.png').convert('RGB')
    ct = Image.open(f'{TMP}/{d}/_pv_content.png').convert('RGB')
    canvas = Image.new('RGB', (tb.width, tb.height + ct.height), bg)
    canvas.paste(tb, (0, 0))
    canvas.paste(ct, (0, tb.height))
    canvas.save(out)
    return canvas

stitch('pv-main-blue', f'{APP}/ui-v102-main-blue.png')
stitch('pv-main-dark', f'{APP}/ui-v102-main-dark.png', bg=(23, 24, 28))
stitch('pv-off-dark', f'{APP}/ui-v102-offline-dark.png', bg=(23, 24, 28))
Image.open(f'{TMP}/pv-splash-dark/_pv_splash.png').convert('RGB').save(f'{APP}/ui-v102-splash-dark.png')

# 状态灯特写：从亮蓝主界面工具栏里裁出状态灯一带，放大 3 倍并加注
tb = Image.open(f'{TMP}/pv-main-blue/_pv_toolbar.png').convert('RGB')
crop = tb.crop((455, 0, 735, tb.height)).resize((280 * 3, tb.height * 3), Image.LANCZOS)
label_h = 44
out = Image.new('RGB', (crop.width, crop.height + label_h), (238, 243, 251))
out.paste(crop, (0, 0))
d = ImageDraw.Draw(out)
d.text((14, crop.height + 9), '状态灯特写：绿灯＝服务器可达（每分钟自动探活一次，点击看最近检测结果与时间）',
       font=ImageFont.truetype(F_R, 21), fill=(52, 78, 128))
out.save(f'{APP}/ui-v102-status-light.png')
print('v102 previews done')
