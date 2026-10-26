#!/usr/bin/env python3
"""v1.0.3 预览拼图：带更新徽标主界面 + 深灰主界面 + 关于面板 + 自更新实测 + 断线页回归。"""
from PIL import Image, ImageDraw, ImageFont

APP = '/home/hatch/workspace/qfremote/app-v1'
TMP = '/tmp/qfr103'
F_R = '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc'

def stitch(tb_path, ct_path, out, bg=(10, 36, 80)):
    tb = Image.open(tb_path).convert('RGB')
    ct = Image.open(ct_path).convert('RGB')
    canvas = Image.new('RGB', (tb.width, tb.height + ct.height), bg)
    canvas.paste(tb, (0, 0))
    canvas.paste(ct, (0, tb.height))
    canvas.save(out)
    return canvas

# 主界面（带更新徽标态，假清单 9.9.9 实测时所截）
stitch(f'{TMP}/upd/_pv_upd1_toolbar.png', f'{TMP}/upd/_pv_upd1_content.png', f'{APP}/ui-v103-main-badge.png')
# 深灰主界面
stitch(f'{TMP}/main-dark/_pv_toolbar.png', f'{TMP}/main-dark/_pv_content.png', f'{APP}/ui-v103-main-dark.png', bg=(23, 24, 28))
# 关于面板（能看到新版信息 + 诊断按钮 + 快捷键清单上半）
Image.open(f'{TMP}/upd/_pv_about1.png').convert('RGB').save(f'{APP}/ui-v103-about.png')
# 断线页回归
stitch(f'{TMP}/offline/_pv_toolbar.png', f'{TMP}/offline/_pv_content.png', f'{APP}/ui-v103-offline.png')

# 自更新实测存证：工具栏徽标（已下载态）+ 关于面板（核对通过 + 打开安装包按钮）
tb = Image.open(f'{TMP}/upd/_pv_upd2_toolbar.png').convert('RGB')
ab = Image.open(f'{TMP}/upd/_pv_about2.png').convert('RGB')
label_h = 48
W = tb.width
H = tb.height + ab.height + label_h
canvas = Image.new('RGB', (W, H), (8, 31, 71))
canvas.paste(tb, (0, 0))
canvas.paste(ab, ((W - ab.width) // 2, tb.height))
d = ImageDraw.Draw(canvas)
d.text((16, tb.height + ab.height + 11),
       '自更新实测（假清单 v9.9.9）：徽标提示 -> 关于里下载 -> 进度走完 -> 文件落下载文件夹 -> SHA256 自动核对通过',
       font=ImageFont.truetype(F_R, 20), fill=(188, 210, 247))
canvas.save(f'{APP}/ui-v103-update.png')
print('v103 previews done')
