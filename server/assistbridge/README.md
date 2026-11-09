# QFRemote 助手控制桥 (assistbridge)

让 Muse 通过 QFRemote（MeshCentral）看站长电脑屏幕、并在条件满足后操作它。
桥跑在东京服务器上（与 MeshCentral 同机），只监听 UDS + loopback TCP，
不对外暴露。客户端零改动。

## 状态（2026-11-09 延迟优化轮，v1.1.0）

延迟优化（站长 2026-11-09 22:27 亲令）：批量输入端点 + 快照快路径
（有完整帧时不再全量刷新 + 2 秒静置）+ 单动作变化等待上限 800 ms +
助手侧 SSH 连接复用。控制面仍关闭（0d 未过，P5 门不动）；安全模型不动。
实测数见 `~/workspace/qfremote/assistant-control-bridge-20261027/` 下的
LATENCY-20261109 报告。

| 能力 | 状态 |
|---|---|
| 看屏（快照只读） | 已实现，**离线实证**（2026-10-29 实录瓦片回放）；真机实测待笔记本回线 |
| 鼠标 / 键盘 | 代码已实现，**接口关闭**（409 control-disabled）：P5 门——0d 夹具实证未过 |
| 批量输入（POST /session/:id/batch） | 已实现，**接口关闭**（同 P5 门 409）；一次调用执行整批动作、一次回结果 |
| 中文输入（KEYUNICODE cmd 85） | 代码已实现，**接口关闭**；字节序未证（默认大端，夹具实证后才可翻转） |
| /text（粘贴/长文本） | 403 text-input-disabled，默认禁用 |
| 通知腿（轮询 ACK） | 已实现（outbox + ACK 端点 + 轮询器）；cron 待建 |
| 急停 / kill / 冷却 | 已实现（/kill + DISABLED 持久标志 + owner-remote-kill + 5 分钟冷却） |
| 审计 / 回放 | 已实现（hash 链 JSONL + 每日锚点 + C4 关闭记录 + 7 天回放） |
| 哨兵 C2/C3（屏上提示/确认） | 原型已收编（sentinel/），**未安装**——需夹具/真机验证；cmd 87 输入锁状态读取已实现（viewer 源码证实：5 字节，锁定位第 5 字节） |

0d 判定：**未过（kill 状态）**——夹具未建，输入法/组合键/丢键/F27 四项
无新实证。控制面只停「动手」部分；只看先行（P4）继续。

## 接口（全部需要桥令牌；令牌只存哈希）

- `GET /status` — 服务状态（state / sessionId / controlEnabled / disabled / coolingUntil）
- `POST /session/open {nodeId}` — 开会话。白名单校验 → 写 session-request
  通知 → 等 ACK（75s，超时拒绝，迟到的 ACK 不追认）→ 连中继 → 首帧
  完整才算建立。返回 `{sessionId, observeToken, screen, screenState, frameComplete}`
- `GET /session/:id/snapshot?maxw&q&refresh&hash` — 最新全帧 JPEG（agent 原生 q50 帧；
  maxw/q 只校验，实际宽高/质量见响应头 `X-Bridge-Frame-*`；无 JPEG
  重编——服务器无解码库）。快路径：已有完整帧时直接返回，不再全量
  刷新（`X-Bridge-Refresh: cached`）；`?refresh=1` 强制刷新；
  `?hash=<sha256>` 与当前帧一致时回 304（不传帧字节）
- `POST /session/:id/mouse {x,y,button,action}` — 409（控制面关闭）；
  开启后变化等待上限 800 ms（`changed` = 800 ms 内有变化）
- `POST /session/:id/key {kind,vk|modifiers|char}` — 409（控制面关闭）；
  开启后变化等待上限 800 ms
- `POST /session/:id/batch {actions:[...], waitMs?}` — 409（控制面关闭，
  同 P5 门）。开启后一次调用执行整批动作（move/down/up/click/tap/
  combo/unicode，最多 100 个；先全量校验、坏项整批拒绝不执行），
  结尾一次有界变化等待（waitMs 默认 500，上限 2000），一次回结果
- `POST /session/:id/text` — 403（默认禁用）
- `POST /session/:id/close` — 幂等关闭（C4 记录）
- `POST /kill` — 关会话 + 写持久 DISABLED + 5 分钟冷却（助手令牌）
- `POST /observe/kill` — 站长远程急停（owner 令牌）+ 5 分钟冷却
- `GET /observe/:tok/stream` — 只读 MJPEG 旁观流（view 令牌，绑本会话）
- `POST /ack {eventId}` — 通知 ACK（轮询器用）
- `GET /events/pending` — 未 ACK 事件列表（轮询器用）

## 令牌

`bridge-tokens.json`（0600，桥用户所有）只存 SHA-256 哈希。
角色：assistant（全接口）、view（快照/旁观流，绑会话）、owner（远程急停）。
明文只进操作员保险箱/安全文件，永不打印、永不入日志。

传输规则（2026-11-09 泄露根治）：轮询器把令牌嵌在经 stdin 传给 python
的程序首行（`TOKEN = "..."`），永不进 argv——失败命令的报错会回显
命令行，argv 带令牌即泄露；令牌在服务器 ps 里也短暂可见，stdin
方式同时堵住这一面。回归测试见 `tests/poller.test.js`（argv 无令牌、
首行带令牌、程序可作 Python 语法解析）。

## 文件布局（服务器 /opt/qfremote-bridge/）

```
app/                  桥代码（本目录部署物）
  bridge.js           主服务
  ws-client.js mc-session.js kvm.js frame-assembler.js
  audit.js tokens.js notify.js replay.js config.js
  poller/notify-poller.js   助手侧轮询器（跑在沙箱/cron，不在服务器）
  sentinel/           哨兵 Windows 原型（未安装，见 README）
  systemd/            服务单元
  tests/              离线测试
secrets/assistsvc.json  桥专用号凭据（0600，桥用户所有）
bridge-tokens.json    令牌哈希（0600）
bridge-config.json    配置（白名单/超时/门开关）
audit/                审计 JSONL + 每日锚点（90 天）
outbox.jsonl acks.jsonl  通知 outbox + ACK 记录
replays/              会话回放记录（7 天）
bridge.sock           UDS 监听（0600）
DISABLED              存在即全桥停用（/kill 写入，人工删文件清除）
```

## 运行

```sh
systemctl start qfremote-assistbridge   # 新服务；不碰任何生产服务
systemctl status qfremote-assistbridge
journalctl -u qfremote-assistbridge -f
```

## 安全红线（不可放宽）

- 无公网监听；白名单首期仅站长笔记本；开会话前 control 通道新鲜拉取
  可见集双检；svc 账号在 MC 内只有一台设备的桌面权。
- 审计只记语义（文本记长度+SHA-256、可打印键只计数、坐标只记九宫格、
  快照只记字节数+SHA-256）；凭据/令牌永不入日志。
- NOTERMINAL / NOFILES：输命令、传文件不在桥的能力内，永不加。
- 0d kill 口径：四项（输入法/组合键/丢键/F27）任一不可靠复现即停控制面。
- 凭据轮换演练：待办（需控制台改密码路径，见 BUILD-20261109）。

## 测试

```sh
cd server/assistbridge && node --test tests/
```
全部离线测试（审计链、令牌、帧组装回放、状态机、通知 ACK fail-closed、
输入编码字节向量、MJPEG 流）。真机测试见 BUILD-20261109 报告。
