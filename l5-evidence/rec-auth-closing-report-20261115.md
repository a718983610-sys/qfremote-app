# L5 补录像 /event 与 /end 按用户鉴权 — 收尾报告（2026-11-15）

任务：QF-REC-1 §6-1 安全缺口修复。工作树 `~/workspace/qfremote/work-recovery241`，分支 `lea-local-agent`。未提交、未推送、未部署、未翻 release.json。

## 改动内容（只动 2 个文件）

1. `server/ext/server.js`（录像路由挂载处，约 2886–2905 行）
   - `POST /license/api/recordings/{sessionId}/event`（recEventM）：`l5Guard` 之后、读请求体之前，先调 `l5.recordingCore.canAccess(auth.user, id)`；未通过直接返回，不解析 body、不调 `appendEvent`。
   - `POST /license/api/recordings/{sessionId}/end`（recEndM）：同样先调 `canAccess`；未通过直接返回，不调 `endSession`。
   - `server/ext/recording-core.js` 未动（`canAccess` 本就存在且行为正确，无需改）；`server/ext/lea/*`、`windows/*`、`android-app/*`、QQGame、MeshCentral、整机均未碰。

## 拒绝语义选择与理由

- 选了 **HTTP 404 `{ ok:false, code:'NOT_FOUND', msg:'录像不存在。' }`**，与 `index` / `download` 逐字一致。
- 理由：写路径按读路径同口径处理，不区分“不存在”与“存在但非本人”，不泄露录制会话存在性。备选方案（HTTP 403 FORBIDDEN）被否决：它会向猜 sessionId 的攻击者证实该录制会话存在，与 QF-REC-1 §4.2 的掩盖口径冲突；且 `canAccess` 模块层仍返回 `FORBIDDEN` 供调用方区分，路由层统一坍缩为 404（测试 `route-collapses-forbidden-and-missing` 已 pin 住该坍缩）。
- 顺序：`l5Guard`（503）优先于 `canAccess`（404），与 index/download 一致；站长无直通（`canAccess` 对站长同样只认本人），与既有口径一致。
- 副作用：无。被拒的 /event 不落盘、被拒的 /end 不结束会话；本人路径行为不变（成功响应与之前逐字相同）。

## 测试证据（沙箱实测，非编造）

基线（改前）：27+18+26+28+16+37 = **152 项全绿**。
改后全套 `server/ext/test-l5-*.js`：

| 文件 | 结果 |
|---|---|
| test-l5-fec.js | RC-03 FEC: 27 passed, 0 failed |
| test-l5-idr.js | RC-03 IDR: 18 passed, 0 failed |
| test-l5-quality.js | RC-09 quality: 26 passed, 0 failed |
| test-l5-recording.js | RC-10 recording: **39 passed, 0 failed**（28 基线 + 11 新增） |
| test-l5-relay.js | RC-07: 16 passed, 0 failed |
| test-l5-transfer.js | RC-08 transfer: 37 passed, 0 failed |

合计 **163 passed, 0 failed**。`node --check server.js` 通过。

新增 11 项（`test-l5-recording.js` §6，全部 `ok`）：
- `live-other-event-forbidden`：进行中会话，他人 `canAccess` → FORBIDDEN（路由即 404，不追加）。
- `live-owner-event-allowed` / `live-owner-append-ok`：本人放行、可正常追加。
- `live-other-end-forbidden` / `live-session-survives-other-end`：他人“调 /end”被守卫挡下后会话仍活着，本人仍可追加。
- `live-owner-end-allowed` / `live-owner-end-ok`：本人正常结束（4 事件：session-start + 2 input + session-end）。
- `route-collapses-forbidden-and-missing`：FORBIDDEN 与 NOT_FOUND 路由层同一 404。
- `route-event-guard-in-source` / `route-end-guard-in-source`：源码回归守卫——server.js 里 /event 与 /end 处理块内确含 `canAccess(auth.user` 且位于 `appendEvent` / `endSession` 之前，并带 404 NOT_FOUND 拒绝行。

## 局限与待办（未完成、须言明）

- 沙箱无 MeshCentral 控制台会话（`resolveAuth` 须控制 WS 验真），路由级真实 HTTP 请求（带他人 cookie 调 /event、/end）无法在沙箱直测；上述证据为守卫谓词级＋源码回归守卫级。**真机 HTTP 验等 L7 安排**（L7 用两个真实账号、同一 sessionId 分别调 /event 与 /end，核对他人 404、本人 200）。
- `QF-REC-1-CLIENT-SPEC.md` §6-1（“与实现有出入处”第 1 条）现已过期：缺口已补，但按本任务硬线（只改上述两文件）未动该文档；建议另派文档线把 §6-1 改为“已修复（2026-11-15）”，并在 §2.2/§2.3 补上“无权限时 HTTP 404”的说明。
- 边界说明：`canAccess` 读磁盘 `.meta.json`（`startSession` 时写）；服务端重启后内存会话丢失时 /event、/end 对本人也回 NOT_FOUND（既有行为，见规范 §6-2，不变）。
