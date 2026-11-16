# QF-STREAM-1：统一文件流＋分片＋审计（客户端协议规范 v1）

- 状态：规范 v1（2026-11-15，L5 后续补文档线出；供 L3 Windows / L4 网页 / L6 安卓做客户端部分）。
- 来源：服务端已落地实现——`server/ext/transfer-core.js`（流状态机＋分片落盘＋审计 exactly-once）、`server/ext/files-core.js`（`stageBuffer` 暂存入口＋`inbox`/`sent`/`ack`/`limits`，行为一字未改）、`server/ext/server.js`（`/license/api/files/stream/*`、`/license/api/files/audit`、下载 Range 分支）。
- 范围：本规范定新分片流的完整客户端流程。旧的整文件 base64 端点 `POST /license/api/files/send` 保留兼容（老客户端不断），新客户端一律走本规范的分片流。
- 鉴权：本节全部端点在 `server.js` 的 `/license/api/*` 控制台会话门之后，须带有效控制台会话；未加载 L5 模块时返回 HTTP 503 `{ ok:false, code:'L5_UNAVAILABLE' }`。错误一律 HTTP 200 返回 `{ ok:false, code, msg }`（下载与审计以外的特例见各节）。
- 术语：`transferId`（传输单号，`tf_`＋16 位 hex）/ `stagedId`（暂存单号，`fs_`＋16 位 hex，两者不同，不得混用）/ 分片（chunk）。

## 1. 流程总览

```
init → chunk（0..N-1，可乱序、可重发）→ commit → staged
  ├─ 断网/中断：missing（查缺片）→ 补传缺片 → commit
  ├─ 取消：cancel（仅 uploading 态）
  └─ 对端：inbox（查收）→ download（可 Range 续传）→ ack（确认收到）
审计：每次传输恰一条（commit 成功/失败、cancel、过期），init/chunk 不记审计。
```

## 2. 端点

### 2.1 init——初始化传输

```
POST /license/api/files/stream/init
```

请求体：

```json
{ "filename": "报告.pdf", "size": 104857600, "sha256": "<64 位小写 hex>", "chunkSize": 1048576, "toNode": "nodeB", "fromNode": "nodeA" }
```

| 字段 | 要求 |
|---|---|
| `filename` | 必填；服务端截断至 200 字符，`/` 与 `\` 替换为 `_`，为空则记为 `file` |
| `size` | 必填；文件总字节数，必须 `> 0` 且 `≤ ` 单文件上限（默认 200MB，`config.json` 的 `fileSendMaxMb` 可改） |
| `sha256` | 必填；整文件 SHA-256，64 位小写 hex（服务端先转小写再校验格式）；缺失或格式不对即 `VALIDATION` |
| `chunkSize` | 可选；服务端钳制到 64KB～4MB，**默认 1MB（1048576）**；超出范围不报错，按边界取值 |
| `toNode` | 必填；目标设备节点 id；为空即 `VALIDATION` |
| `fromNode` | 可选；来源设备节点 id；与 `toNode` 相同即 `VALIDATION` |

成功响应：`{ ok:true, transferId:"tf_…", chunkSize:<服务端实际采用值>, totalChunks:<ceil(size/chunkSize)> }`。
失败：`{ ok:false, code:'VALIDATION'|'TOO_LARGE'|'IO', msg }`。**客户端须用返回的 `chunkSize` 切分，不得用自己请求的值**（服务端可能已钳制）。

### 2.2 chunk——上传分片

```
POST /license/api/files/stream/{transferId}/chunk
```

请求体：`{ "index": 0, "contentBase64": "<该分片字节的 base64>" }`。

- `index` 为 0 起的分片序号，必须 `0 ≤ index < totalChunks`，否则 `VALIDATION`。
- 分片长度必须精确等于期望值：非末片等于 `chunkSize`，末片等于 `size - index*chunkSize`；长度不符即 `VALIDATION`（服务端报错会写明期望字节数）。
- 分片内容为空（空 base64）即 `VALIDATION`。
- **乱序可达**：分片可按任意顺序上传；重复上传同一 `index` 允许（覆盖写，已收计数不变）。
- 成功响应：`{ ok:true, received:<已收分片数>, totalChunks }`。
- 失败：`NOT_FOUND`（传输不存在或不是本人发起）、`STATE`（传输不在 uploading 态）、`VALIDATION`、`IO`、`TOO_LARGE`（请求体超 288MB 上限，见 §5 第 3 条）。
- 客户端须在本地算好整文件 SHA-256 再 init；分片用原文件字节直接切分，不得先压缩/改名。

### 2.3 missing——断点续传查询（resume-query）

```
GET /license/api/files/stream/{transferId}/missing
```

成功响应：`{ ok:true, transferId, status:"uploading", received:<已收数>, totalChunks, missing:[1,3] }`（`missing` 为缺失分片序号升序数组）。
失败：`NOT_FOUND`（传输不存在或不是本人发起）。

> 命名说明：任务书里写的 `resume` 在实现中没有同名端点，断点续传就是调本端点查缺片（设计文档称 `resume-query`）。客户端不要去试不存在的 `/resume` 路径。

### 2.4 commit——拼装＋校验＋暂存

```
POST /license/api/files/stream/{transferId}/commit
（无请求体或空 JSON）
```

- 成功响应：`{ ok:true, transferId, stagedId:"fs_…", size, expiresAt:<毫秒 epoch> }`。`stagedId` 是对端下载用的暂存单号；`expiresAt` 为暂存到期时刻（`now + stageMs`，默认 24h，`config.json` 的 `fileSendStageHours` 可改）。
- 缺片时：`{ ok:false, code:'INCOMPLETE', msg, missing:[…] }`——客户端补传缺片后再 commit。
- SHA-256 校验失败或拼装大小不符：`{ ok:false, code:'CORRUPT', msg:'…传输已作废。' }`——**整单作废，分片已清，此 `transferId` 不能再用**，须重新 `init` 一个新传输（重传同一文件须重新算 SHA-256、重新上传全部分片）。
- 其他失败：`NOT_FOUND` / `STATE`（重复 commit：首次成功后第二次调即 `STATE`，不产生第二条审计）/ `IO`。
- 校验通过后文件进既有 `file-stage` 暂存（复用 24h 暂存、收件箱、ack、sweep），此后流程与旧整文件发送一致。

### 2.5 cancel——取消上传

```
POST /license/api/files/stream/{transferId}/cancel
```

- 仅 `uploading` 态可取消；成功 `{ ok:true, transferId, status:'cancelled' }`，记一条 `cancelled` 审计，分片清掉。
- 非 uploading 态：`{ ok:false, code:'STATE' }`；不存在/非本人：`NOT_FOUND`。
- commit 成功后没有取消端点——已暂存的文件靠 24h 到期自动清（或对端 ack 后处理），客户端不要在 commit 后调 cancel。

### 2.6 download——对端下载（支持 Range 续传）

```
GET /license/api/files/{stagedId}/download
```

- 无 `Range` 头：HTTP 200，全文件，`Content-Type: application/octet-stream`，`Accept-Ranges: bytes`，`Content-Disposition: attachment; filename="<url 编码文件名>"`，`Cache-Control: no-store`。
- 带 `Range: bytes=start-end`：HTTP **206**，`Content-Range: bytes start-end/size`，只返回该区间字节。
- Range 写法（服务端 `parseRange`）：`bytes=N-`（从 N 到末尾）、`bytes=-N`（最后 N 字节）、`bytes=N-M`（闭区间）；`start >= size`、`end < start`、`end <= 0` 的后缀等非法形式解析失败时**回落为 200 全文件，不返回 416**——客户端收到 200 时须按全文件处理，不得当作区间响应拼装。
- 文件不存在/已过期：HTTP 404 `{ ok:false, code:'NOT_FOUND' }`。
- 注意：下载用的是 `stagedId`（`fs_…`），不是 `transferId`（`tf_…`）。

### 2.7 inbox / sent / ack（复用既有端点，行为未改）

- `GET /license/api/files/inbox?node=<本设备节点>` → `{ ok:true, files:[{ id, filename, size, fromNode, toNode, status, createdAt, expiresAt, deliveredAt, downloadedAt }], limits:{ maxBytes, stageMs } }`。
- `GET /license/api/files/sent` → `{ ok:true, files:[…同上…] }`。
- `POST /license/api/files/{stagedId}/ack` → 既有 `fileStage.ack` 返回值（确认收到）。

## 3. 审计记录语义

- 查询：`GET /license/api/files/audit?limit=<1..200，默认 50>` → `{ ok:true, audit:[…] }`，只返回本人的记录，按时间倒序取最后 N 条。
- 每条审计记录字段：`transferId`、`username`、`filename`、`size`、`sha256`、`fromNode`、`toNode`、`chunks`（＝`totalChunks`）、`result`、`startedAt`、`endedAt`，另加 `stagedId`（完成时）或 `reason`（失败时）。
- `result` 三态：`completed`（commit 成功）/ `failed`（原因见 `reason`：`chunk-read-error` / `size-mismatch` / `sha-mismatch` / `stage-<code>` / `stale`）/ `cancelled`（主动取消）。
- **exactly-once**：每次传输恰一条审计，以 `transferId` 去重，内存 Set＋启动时扫审计文件重建，跨重启也不重复；重复 commit、重复 cancel 都不产生第二条。
- `init` / `chunk` 不记审计；过期未完成的上传由服务端每 60s 清扫（`stageMs` 内无更新即 `failed` + `reason:'stale'`，分片清掉）。
- 审计只记元数据，**不记文件内容**；客户端展示审计时不得尝试还原文件内容。

## 4. 客户端 UI 须实现的状态机

```
idle → init 发起 → uploading（进度 received/totalChunks，逐片）
  →（断网/切后台）→ interrupted → missing 查缺片 → 补传 → uploading
  → commit 提交中 → staged（显示 stagedId、expiresAt 到期倒计时）
  → 对端 inbox 可见 → downloading（Range 续传进度）→ acked（完成）
  └─ uploading 态可 cancel → cancelled（终态）
  └─ commit 返回 INCOMPLETE → 回 uploading 补传缺片
  └─ commit 返回 CORRUPT → failed（终态，提示“校验失败，须重新发送”，提供“重新发送”入口＝重新 init）
```

UI 要求：
- 上传进度按分片数显示（`received/totalChunks`），并显示已传字节/总字节；
- 断网重连后自动调 `missing` 续传，不得从头重传已收分片；
- 取消按钮只在 uploading 态可用；commit 提交中须禁点取消与重复提交；
- 失败提示须带服务端 `code`（`INCOMPLETE`/`CORRUPT`/`TOO_LARGE`/`VALIDATION`），`CORRUPT` 时明确告知用户“须重新发送”，不要显示“重试提交”；
- 收件箱须显示 `expiresAt` 到期时间，过期文件置灰不可下载；
- 审计入口展示本人传输记录（`result` 三态着色：完成/失败/取消），不展示他人记录。

## 5. 与实现有出入处（以实现为准）

1. 没有字面叫 `/resume` 的端点，断点续传＝`GET …/missing`（见 2.3）。
2. commit 失败（`CORRUPT`/`IO`）后传输即作废，不可“修好再 commit”；`INCOMPLETE` 是唯一可继续的状态。
3. chunk 请求体走 `BODY_LIMIT_FILE`（288MB），单个分片 base64 约为分片字节的 4/3 倍；分片上限 4MB 时单请求约 5.6MB，远小于上限，不会触发；但客户端不得把整文件 base64 一次性塞进 chunk 请求。
4. `cancel` 只能取消上传中传输；已暂存（staged）的发送没有取消端点。
5. 审计的 `chunks` 字段是 `totalChunks`（总数），不是已收分片数；`startedAt` 是 `init` 时刻，`endedAt` 是终态落审计时刻。

## 6. 各端待实现清单

### Windows（L3）
- [ ] 上传器：本地算 SHA-256 → init → 按服务端返回的 `chunkSize` 切分 → 乱序/顺序上传 → commit；断网后 `missing` 续传。
- [ ] 下载器：inbox 列表 → `download`（带 `Range` 续传，收到 200 时按全文件处理）→ ack。
- [ ] 上传/下载 UI 状态机（§4），含取消、到期倒计时、`CORRUPT` 重发入口。
- [ ] 审计查看页：调 `/license/api/files/audit` 展示本人记录。

### 网页（L4）
- [ ] 同上（网页文件 UI；等 W-05 拆分后的新结构落点，不得改冻结中的旧 `server/webapp/app.js`）。
- [ ] 大文件上传须分片流式读文件（File.slice），不得整文件读进内存再 base64。

### 安卓（L6）
- [ ] 同上（Flutter 侧；后台/切网后续传用 `missing` 查缺片，不得从头重传）。
- [ ] 移动端上传进度须在通知栏/页面持续显示；取消与重发入口与 Windows 一致。

## 7. 核对方法与结果

- 核对方法：逐项对照 `server/ext/transfer-core.js`（全文：`init` / `putChunk` / `missingChunks` / `commit` / `cancel` / `sweep` / `listAudit` / `parseRange`、常量 `DEFAULT_CHUNK_SIZE` / `MIN_CHUNK_SIZE` / `MAX_CHUNK_SIZE`）、`server/ext/server.js` 的 stream 路由与下载 Range 分支（行 2753–2878）、`server/ext/files-core.js` 的 `stageBuffer` / `limits`（默认 200MB / 24h）；自检脚本 `test-l5-transfer.js`（37 项）为沙箱证据，其中 100MB 端到端（1MB×100 分片）上传＋拼装＋SHA-256＋字节一致耗时 2011ms（含 100MB 随机数生成），审计 6 行、6 个唯一 transferId（完成/失败/取消各恰一条，重复 commit 不产生第二条）。
- 核对结果：端点路径、请求/响应字段、错误码、1MB 默认分片、SHA-256 校验语义、审计字段与 exactly-once，均与源码一致；出入处见 §5（5 项，均已标出，未编造未实现的端点）。
