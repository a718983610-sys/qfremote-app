#!/usr/bin/env python3
"""v1.0.4 预览拼图：带更新徽标主界面 + 关于（含更新规矩）+ 强更页两段 + 深灰主界面 + 断线页回归。"""
from PIL import Image, ImageDraw, ImageFont

APP = '/home/hatch/workspace/qfremote/app-v1'
TMP = '/tmp/qfr104'
F_R = '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc'

def stitch(tb_path, ct_path, out, bg=(10, 36, 80)):
    tb = Image.open(tb_path).convert('RGB')
    ct = Image.open(ct_path).convert('RGB')
    canvas = Image.new('RGB', (tb.width, tb.height + ct.height), bg)
    canvas.paste(tb, (0, 0))
    canvas.paste(ct, (0, tb.height))
    canvas.save(out)
    return canvas

# 阶段A：运行中只提醒（徽标 + 关于面板）
stitch(f'{TMP}/stageA/out/_pv_upd1_toolbar.png', f'{TMP}/stageA/out/_pv_upd1_content.png', f'{APP}/ui-v104-main-badge.png')
Image.open(f'{TMP}/stageA/out/_pv_about1.png').convert('RGB').save(f'{APP}/ui-v104-about.png')
# 深灰主界面 + 断线页回归
stitch(f'{TMP}/prev-main-dark/_pv_toolbar.png', f'{TMP}/prev-main-dark/_pv_content.png', f'{APP}/ui-v104-main-dark.png', bg=(23, 24, 28))
stitch(f'{TMP}/prev-offline/_pv_toolbar.png', f'{TMP}/prev-offline/_pv_content.png', f'{APP}/ui-v104-offline.png')

# 阶段B：强更页（拦截态 + 下载核对完成态）并排存证
f1 = Image.open(f'{TMP}/stageB/out/_pv_force1.png').convert('RGB')
f2 = Image.open(f'{TMP}/stageB/out/_pv_force2.png').convert('RGB')
label_h = 48
W = f1.width + f2.width + 12
H = max(f1.height, f2.height) + label_h
canvas = Image.new('RGB', (W, H), (8, 31, 71))
canvas.paste(f1, (0, 0))
canvas.paste(f2, (f1.width + 12, 0))
d = ImageDraw.Draw(canvas)
d.text((16, H - label_h + 11),
       '强制更新页实测（假清单 v9.9.9）：左=被拦下（只有「立即更新」） 右=下载完成、SHA256 核对通过（出「打开安装包」）',
       font=ImageFont.truetype(F_R, 20), fill=(188, 210, 247))
canvas.save(f'{APP}/ui-v104-force.png')
print('v104 previews done')
