#!/usr/bin/env python3
"""QFRemote 站长 API 助手哨兵（#22/#31）。
维护一条 SSH 本地转发（本机 18080 -> 东京 nginx 8080），以游标增量轮询
/assistant-api/events，把新事件追加写入 queue.jsonl 供助手处理；
裁定经 /assistant-api/decide 回写（由助手在处理时调用，本脚本只负责发现与落盘）。
令牌只读 token.txt（600），从不打印。点火时以 systemd/常驻方式启动。
"""
import json, os, subprocess, sys, time, urllib.request

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
TOKEN = open(os.path.join(BASE_DIR, "token.txt")).read().strip()
STATE = os.path.join(BASE_DIR, "cursor.json")
QUEUE = os.path.join(BASE_DIR, "queue.jsonl")
LOCAL = "http://127.0.0.1:18080"
SSH_KEY = "/home/hatch/workspace/cloudphone/node-eng/keys/LightsailDefaultKey-ap-northeast-1.pem"
PROXY = "python3 /home/hatch/workspace/cloudphone/ssh_proxy_connect.py %h %p"

def ensure_forward():
    r = subprocess.run(["bash", "-c", "ss -ltn | grep -q ':18080 '"],
                       capture_output=True)
    if r.returncode != 0:
        subprocess.Popen(["ssh", "-i", SSH_KEY, "-o", f"ProxyCommand={PROXY}",
                          "-o", "StrictHostKeyChecking=accept-new", "-o", "ExitOnForwardFailure=yes",
                          "-N", "-L", "18080:127.0.0.1:8080", "ubuntu@app.qfremote.top"],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        time.sleep(3)

def poll(cursor):
    req = urllib.request.Request(f"{LOCAL}/assistant-api/events?after={cursor}&limit=50",
                                 headers={"x-assistant-token": TOKEN})
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read().decode())

def main():
    cursor = 0
    if os.path.exists(STATE):
        cursor = json.load(open(STATE)).get("cursor", 0)
    while True:
        try:
            ensure_forward()
            data = poll(cursor)
            for ev in data.get("events", []):
                with open(QUEUE, "a") as f:
                    f.write(json.dumps(ev, ensure_ascii=False) + "\n")
            cursor = data.get("nextCursor", cursor)
            json.dump({"cursor": cursor}, open(STATE, "w"))
        except Exception as e:
            print(f"watcher poll error: {e}", file=sys.stderr)
        time.sleep(5)

if __name__ == "__main__":
    main()
