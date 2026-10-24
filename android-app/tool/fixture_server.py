#!/usr/bin/env python3
"""QFRemote 安卓截图/看护实测用的本机夹具服务器（仅 CI 模拟器环境使用）。

服务内容（端口 8791，模拟器里用 10.0.2.2 访问宿主机）：
- /start.html        入口页：问 /next 拿当前目标再跳过去（脚本靠 /ctl/* 切换目标，免重打包）
- /next              返回当前目标 URL 文本
- /ctl/session|login|dead   切换目标：会话假页 / 登录假页 / 死端口（整页断线）
- /ctl/fake-on|fake-off     切换 /release.json 的版本：9.9.9（假新版）/ 1.0.4（与本机同版）
- /release.json      动态清单：sha256/size 按真实待测 APK 现算，保证更新链能验过
- /QFRemote-v9.9.9.apk       回待测 APK 本体
- /session.html /login.html  静态假页（tool/fixtures/）
"""
import hashlib
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
APK_PATH = sys.argv[1] if len(sys.argv) > 1 else ""
PORT = 8791
state = {"next": "/session.html", "fake": False}

START_HTML = """<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>
<script>
fetch('/next').then(r => r.text()).then(u => location.replace(u.trim()));
</script>loading…</body></html>"""


def apk_info():
    data = open(APK_PATH, "rb").read()
    return hashlib.sha256(data).hexdigest(), len(data)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):  # 安静
        pass

    def _send(self, body, ctype="text/plain; charset=utf-8", code=200):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        p = self.path.split("?")[0]
        if p == "/start.html":
            self._send(START_HTML, "text/html; charset=utf-8")
        elif p == "/next":
            self._send(state["next"])
        elif p == "/ctl/session":
            state["next"] = "/session.html"
            self._send("ok")
        elif p == "/ctl/login":
            state["next"] = "/login.html"
            self._send("ok")
        elif p == "/ctl/dead":
            state["next"] = "http://10.0.2.2:9/dead"
            self._send("ok")
        elif p == "/ctl/fake-on":
            state["fake"] = True
            self._send("ok")
        elif p == "/ctl/fake-off":
            state["fake"] = False
            self._send("ok")
        elif p == "/release.json":
            sha, size = apk_info()
            ver = "9.9.9" if state["fake"] else "1.0.4"
            manifest = {
                "version": ver,
                "notes": "（测试清单）",
                "url": "http://10.0.2.2:8791/QFRemote-v9.9.9.apk",
                "sha256": sha,
                "size": size,
                "android": {
                    "version": ver,
                    "notes": "测试新版说明：这是一条假清单，用来验证更新提醒与强制更新页。",
                    "url": "http://10.0.2.2:8791/QFRemote-v9.9.9.apk",
                    "sha256": sha,
                    "size": size,
                },
            }
            self._send(json.dumps(manifest, ensure_ascii=False), "application/json")
        elif p == "/QFRemote-v9.9.9.apk":
            with open(APK_PATH, "rb") as f:
                self._send(f.read(), "application/vnd.android.package-archive")
        elif p in ("/session.html", "/login.html"):
            with open(os.path.join(HERE, "fixtures", p[1:]), "rb") as f:
                self._send(f.read(), "text/html; charset=utf-8")
        else:
            self._send("not found", code=404)


if __name__ == "__main__":
    HTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
