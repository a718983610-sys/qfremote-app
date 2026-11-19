#!/usr/bin/env python3
"""A 线自动化检查：会话状态解析 / IPC 超时与协议契约 / 组件 SHA 清单。
纯静态+契约检查（沙箱实跑），绝不代替真机复现与 Dump 判读。
用法：python3 tests/session-ipc-checks.py
退出码：0 = 全部 PASS；1 = 任一 FAIL。
"""
import hashlib, json, os, re, sys

WT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
IMPL = "/home/hatch/workspace/qfremote/privacy-lock-impl"
PHASE1 = "/home/hatch/workspace/qfremote/a16-s2-20261118/phase-2-closeout/lockfix-phase1"
results = []

def check(name, ok, detail=""):
    results.append((name, bool(ok), detail))
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))

def sha256(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()

# 1. 四个旧 Go 二进制：wt-a 与 v2.0.3 发行包逐字节一致
for exe in ["QFLockService.exe", "QFLockUI.exe", "qf-lockctl.exe", "qf-lockupdater.exe"]:
    a = os.path.join(WT, "windows/privacy-lock/app", exe)
    b = os.path.join(IMPL, "dist/pkg/app", exe)
    check(f"sha-identical:{exe}", os.path.exists(a) and os.path.exists(b) and sha256(a) == sha256(b),
          sha256(a)[:16] + "…" if os.path.exists(a) else "missing")

# 2. 发行 zip SHA 与 release-info.json 一致
rel = json.load(open(os.path.join(IMPL, "dist/release-info.json")))
z = os.path.join(IMPL, "dist", rel["file"])
check("zip-sha==release-info.json", sha256(z) == rel["sha256"] and rel["version"] == "2.0.3",
      f'{rel["file"]} {rel["sha256"][:16]}… size={rel["sizeBytes"]}')

# 3. 二进制内无版本资源、无 2.0.3 字面量（版本身份只能靠 device.json/status.json）
for exe in ["QFLockUI.exe", "QFLockService.exe"]:
    data = open(os.path.join(WT, "windows/privacy-lock/app", exe), "rb").read()
    check(f"no-embedded-version:{exe}", b"2.0.3" not in data and b"VS_VERSION_INFO" not in data,
          "无 2.0.3 字面量、无版本资源（实跑）")

# 4. 管道名与 SDDL：源码与二进制一致
svc_src = open(os.path.join(IMPL, "src/cmd/qflocksvc/main_windows.go"), encoding="utf-8").read()
ui_bin = open(os.path.join(WT, "windows/privacy-lock/app/QFLockUI.exe"), "rb").read()
check("pipe-name==QFLockSvc", r"\\.\pipe\QFLockSvc" in svc_src and b"QFLockSvc" in ui_bin,
      "pipewin.DialTimeout(`\\\\.\\pipe\\QFLockSvc`, 3s)；SDDL=D:(A;;GA;;;SY)(A;;GA;;;BA)(A;;GRGW;;;IU)")
check("pipe-sddl-present", 'D:(A;;GA;;;SY)(A;;GA;;;BA)(A;;GRGW;;;IU)' in svc_src)

# 5. IPC 协议字段（对照 core/ipc.go）：请求 5 类、响应字段齐全
ipc = open(os.path.join(IMPL, "src/internal/core/ipc.go"), encoding="utf-8").read()
for t in ['"hello"', '"status"', '"apply"', '"unlock"', '"recover"']:
    check(f"ipc-request-type:{t}", t in ipc)
for f in ['json:"t"', 'json:"password', 'json:"session', 'json:"pid', 'json:"affinity', 'json:"ok"', 'json:"code"', 'json:"state"', 'json:"fault', 'json:"waitSec', 'json:"remaining', 'json:"reboot']:
    check(f"ipc-field:{f}", f in ipc)

# 6. IPC 超时常量（源码实值）
ui_src = open(os.path.join(IMPL, "src/cmd/qflockui/main_windows.go"), encoding="utf-8").read()
ipccli = open(os.path.join(IMPL, "src/internal/ipcclient/ipcclient.go"), encoding="utf-8").read()
check("timeout: dial=3s", "DialTimeout(`\\\\.\\pipe\\QFLockSvc`, 3*time.Second)" in ui_src)
check("timeout: status/unlock=10s, recover=30s",
      'return 30 * time.Second' in ui_src and 'return 10 * time.Second' in ui_src)
check("timeout: hello Do=6s, retry x20",
      '6*time.Second' in ui_src and 'i < 20' in ui_src)
check("timeout: ipcclient default=10s", "timeout = 10 * time.Second" in ipccli)
check("single-flight: CallAsync CAS + drop-on-busy",
      "CompareAndSwap(false, true)" in ipccli and "inflight atomic.Bool" in ipccli)
check("resetConn does not take ioMu (no timeout deadlock)",
      "func (c *Client) resetConn()" in ipccli and "c.state.Swap(nil)" in ipccli)

# 7. 服务端对账超时（lock-bridge.js 实值）
lb = open(os.path.join(WT, "server/friends/lock-bridge.js"), encoding="utf-8").read()
check("bridge: RECONCILE_MS=30000", "const RECONCILE_MS = 30000;" in lb)
check("bridge: runcommands timeout default 20000", "timeoutMs || 20000" in lb)

# 8. UI 线程纪律（源码实查）：LockOSThread + 隐藏建窗 + 分步初始化
check("ui: init() LockOSThread", "func init() { runtime.LockOSThread() }" in ui_src)
check("ui: buildWindows creates hidden (wsPopup, no WS_VISIBLE)",
      "wsPopup," in ui_src and "pCreateWindowEx.Call(wsExTopmost|wsExToolWindow," in ui_src)
check("ui: runInitStep stepwise affinity", "func runInitStep()" in ui_src and "initAffinityIdx" in ui_src)
check("ui: hooks observe-only (CallNextHookEx, no block)",
      "pCallNextHookEx.Call(0, uintptr(nCode), wParam, lParam)" in ui_src)
check("ui: no BlockInput in UI source", "BlockInput" not in ui_src)
check("ui: status poll 1500ms, topmost tick 500ms",
      "timerPoll, 1500, 0" in ui_src and "timerTick, 500, 0" in ui_src)

# 9. 服务端拉起 UI：WTSQueryUserToken + CreateProcessAsUser + winsta0\default
check("svc: launchUIInSession via WTSQueryUserToken",
      "procWTSQueryUserToken.Call" in svc_src and "CreateProcessAsUser" in svc_src)
check("svc: si.Desktop=winsta0\\default", r'"winsta0\\default"' in svc_src)
check("svc: watchdog 2s tick, relaunch when Locked",
      "time.NewTicker(2 * time.Second)" in svc_src and "state != core.StateLocked" in svc_src)
check("svc: ui-killed counts as tamper when helloSeen",
      's.engine.TamperDetected("ui-killed")' in svc_src)

# 10. 阶段 1 锁记录（实跑复核）：arm 成功 5 条（11-15 三次 + 11-18 一次 + ？），disarm 成功 1 条
recs = [json.loads(l) for l in open(os.path.join(PHASE1, "evidence/lock-records-20261119.jsonl"), encoding="utf-8")]
arms = [r for r in recs if "arm 成功" in r.get("msg", "")]
disarms = [r for r in recs if "disarm 成功" in r.get("msg", "")]
check("records: 298 lines", len(recs) == 298, f"实跑 {len(recs)} 行")
check("records: arm-success==5", len(arms) == 5, f"实跑 {len(arms)} 条")
check("records: disarm-success==1 (2026-11-15 only)", len(disarms) == 1,
      disarms[0]["at"] if disarms else "none")
check("records: 2026-11-18T17:11:58.053Z arm D39ABOL present",
      any(r.get("at") == "2026-11-18T17:11:58.053Z" and "DESKTOP-D39ABOL" in r.get("msg", "") for r in recs))
check("records: no disarm-success after 2026-11-18T17:11:58Z",
      not any(r.get("at", "") > "2026-11-18T17:11:58.053Z" and "disarm 成功" in r.get("msg", "") for r in recs))

# 11. 会话/显示矩阵规则自检（示例 status.json + device.json 按 status.go/device.json 模式）
sample_status = {"component": "QFRemote 本机锁", "version": "2.0.3", "state": "Locked",
                 "ownerUsername": "718983610", "nodeId": "node//x", "captureExclusion": "active"}
sample_device = {"nodeId": "node//x", "ownerUsername": "718983610", "componentVersion": "2.0.3"}
check("matrix: version fields agree (status.version==device.componentVersion)",
      sample_status["version"] == sample_device["componentVersion"])
check("matrix: owner fields agree", sample_status["ownerUsername"] == sample_device["ownerUsername"])
check("matrix: state in {Off, Locked}", sample_status["state"] in ("Off", "Locked"))
check("matrix: captureExclusion in {active, failed-degraded}",
      sample_status["captureExclusion"] in ("active", "failed-degraded"))

fails = [r for r in results if not r[1]]
print(f"\n{len(results) - len(fails)}/{len(results)} PASS；{len(fails)} FAIL")
sys.exit(1 if fails else 0)
