# QF-REC-1：录像事件流（客户端协议规范 v1）

- 状态：规范 v1（2026-11-15，L5 后续补文档线出；供 L3 Windows / L4 网页 / L6 安卓做客户端部分）。
- 来源：服务端已落地实现——`server/ext/recording-core.js`（策略＋存储＋索引＋访问控制）、`server/ext/server.js`（`/license/api/recordings/*` 路由）；设计依据 `L5-DESIGN-CONFIRMATION.md` §三。
- 范围：本规范定 `.qfrec` 事件流格式、录制策略判定、seek 索引、访问控制与回放器功能。事件流的实际捕获埋点（上游 `mcrec.js` 钩子或 agent 侧事件上报）不在树内，须另派线；服务端只定格式＋做服务端侧。不做 mp4 转码。
- 鉴权：本节全部端点在 `server.js` 的 `/license/api/*` 控制台会话门之后，须带有效控制台会话；未加载 L5 模块时返回 HTTP 503 `{ ok:false, code:'L5_UNAVAILABLE' }`。错误一律 HTTP 200 返回 `{ ok:false, code, msg }`，但录像读取类端点无权限时返回 HTTP 404（见 4.2）。
- 术语：`.qfrec`（录像文件，JSONL 事件流，不是视频）/ `.qfrec.idx`（seek 索引文件）/ `.meta.json`（录像元数据）。

## 1. `.qfrec` 事件格式

- 文件格式：JSONL，每行一个事件 JSON 对象（UTF-8，`\n` 分隔）；不存视频帧。
- 通用字段：每个事件必有 `type`（见 1.1）与 `at`（毫秒 epoch；客户端缺省时服务端填当前时间）。
- 事件顺序：`session-start`（服务端写）→ `input` / `clipboard` / `frame-marker` / `quality-change`（客户端发）→ `session-end`（服务端写）。
- 沙箱体积（`test-l5-recording.js`，模拟值非真机值）：10 分钟录像 4,344,386 字节（54,002 事件）vs 同等视频（2500kbps×600s）187,500,000 字节，**比值 43.2x**；事件流体积约为同等视频的 1/43。

### 1.1 事件类型与字段（服务端 `sanitizeEvent` 白名单，只许这些字段）

| type | 字段 | 说明 |
|---|---|---|
| `session-start` | `type`, `at`, `tier`, `policyMode` | 服务端在 `start` 时写；客户端不得发 |
| `input` | `type`, `at`, `kind`, `x`, `y`, `key?` | `kind` 为 `mouse` / `key` / `touch`（非法值按 `mouse` 计）；`x` / `y` 为数字坐标（缺省为 0）；`key` 仅限按键名（如 `Enter`，截断至 32 字符），**只记按键名，不记密码等输入内容** |
| `clipboard` | `type`, `at`, `bytes` | **只记字节数（`bytes`），绝不记剪贴板内容**；客户端发 `content` 字段会被服务端丢弃（测试已证实含 `content:'SECRET-…'` 的事件落盘后无该字符串） |
| `frame-marker` | `type`, `at`, `frameId`, `isKeyframe` | 关键帧锚点；`frameId` 为帧序号，`isKeyframe` 为布尔 |
| `quality-change` | `type`, `at`, `from`, `to` | 档位变化，`from` / `to` 各截断至 32 字符（如 `clear` → `balanced`） |
| `session-end` | `type`, `at` | 服务端在 `end` 时写；客户端不得发 |
| `seek-index` | — | **不是客户端发的事件**；它是索引文件的概念（见 §3），不要往 `/event` 发 `seek-index`（发了也只剩 `type`/`at` 两个字段，无意义） |

- 非法事件类型（如 `video-frame`）服务端返回 `{ ok:false, code:'VALIDATION' }`，不落盘。
- 字段外的值服务端一律丢弃（只保留白名单字段）；客户端不得把敏感内容塞进未列出的字段指望服务端保存——它不会保存，也不得把敏感内容塞进已列出的字段（如 `key` 里放密码）。

## 2. 端点

### 2.1 start——开始录制

```
POST /license/api/recordings/start
请求体：{ "sessionId": "sess-…", "deviceId": "d1", "groupId": "g1", "tier": "balanced" }
```

- 成功：`{ ok:true, sessionId }`。`sessionId` 由客户端传入（建议传桌面会话的 `sessionId` 以便关联）；不传时服务端生成 `rec_`＋16 位 hex。
- 策略未开启：`{ ok:false, code:'POLICY_OFF', msg:'录制策略未开启（默认不录）。' }`——客户端收到后不得继续发事件，UI 须提示“当前会话不录制”。
- 文件创建失败：`{ ok:false, code:'IO' }`。
- 开始录制时服务端写 `.meta.json`（`{ sessionId, username, deviceId, groupId, tier, policyMode, startedAt }`）与空 `.qfrec` 文件（0600），并追加一条 `session-start` 事件。

### 2.2 event——追加事件

```
POST /license/api/recordings/{sessionId}/event
请求体：{ "event": { "type": "input", "at": 1790000000100, "kind": "mouse", "x": 100, "y": 200 } }
```

- 成功：`{ ok:true, events:<累计事件数> }`。
- 录制会话不存在：`{ ok:false, code:'NOT_FOUND' }`；事件类型非法：`{ ok:false, code:'VALIDATION' }`；写入失败：`{ ok:false, code:'IO' }`。
- 客户端只发 `input` / `clipboard` / `frame-marker` / `quality-change` 四种事件；`session-start` / `session-end` 由服务端写，不得由客户端发。
- 事件发送频率：有事件即发（输入事件实时发）；批量发时须保持 `at` 单调递增，不得倒序补发旧事件（索引锚点依赖 `at` 单调）。

### 2.3 end——结束录制

```
POST /license/api/recordings/{sessionId}/end
（无请求体或空 JSON）
```

- 成功：`{ ok:true, sessionId, events:<总事件数>, bytes:<总字节数>, index:[{ t, byteOffset }, …] }`，并落盘 `.qfrec.idx` 文件（`{ sessionId, index, events, bytes, endedAt }`）。
- 录制会话不存在：`{ ok:false, code:'NOT_FOUND' }`；索引写入失败：`{ ok:false, code:'IO' }`。
- 结束时服务端追加一条 `session-end` 事件再写索引。

### 2.4 list——列出本人录像

```
GET /license/api/recordings
```

- 成功：`{ ok:true, recordings:[{ sessionId, deviceId, tier, startedAt, bytes }, …] }`，按 `startedAt` 倒序，只返回本人的录像。
- 未开始/无录像时返回空数组。

### 2.5 index——读取 seek 索引

```
GET /license/api/recordings/{sessionId}/index
```

- 成功：`{ ok:true, index:{ sessionId, index:[{ t, byteOffset }, …], events, bytes, endedAt } }`。
- 无权限或不存在：HTTP **404** `{ ok:false, code:'NOT_FOUND', msg:'录像不存在。' }`（无权限与不存在同一响应，不泄露存在性，见 4.2）。
- `.idx` 文件缺失时服务端现扫 `.qfrec` 重建索引，响应里多一个 `rebuilt:true` 字段（重建的锚点语义与正常写入略有不同，见 3.2）。

### 2.6 download——下载录像文件

```
GET /license/api/recordings/{sessionId}/download
```

- 成功：HTTP 200，`Content-Type: application/octet-stream`，`Content-Length` 为文件字节数，`Content-Disposition: attachment; filename="<sessionId>.qfrec"`，`Cache-Control: no-store`，body 为整个 `.qfrec` 文件。
- 无权限或不存在或文件缺失：HTTP 404 `{ ok:false, code:'NOT_FOUND' }`。
- 注意：录像下载**不支持 `Range`**（与 QF-STREAM-1 的文件下载不同）；回放器须整文件下载后本地 seek，不得发 `Range` 请求。

## 3. 三级粒度开关与 seek 索引

### 3.1 录制策略（服务端在 `start` 时判定）

策略来源：`config.json` 的 `recording` 对象：

```json
{ "recording": { "mode": "off", "users": [], "groups": [], "devices": [], "retentionDays": 30 } }
```

| mode | 录制条件 |
|---|---|
| `off`（默认） | 不录任何会话 |
| `user` | `users` 含该 `username` 才录 |
| `group` | `groups` 含该 `groupId` 才录 |
| `device` | `devices` 含该 `deviceId` 才录 |

- `mode` 非法值回退为 `off`；`retentionDays` 非正数时默认 30 天。
- **默认不录**，须双方知情或站长明确授权才开；策略变更不由客户端发起（客户端无改策略端点）。
- 判定在 `startSession` 时做一次：策略关时 `start` 直接 `POLICY_OFF`；策略开着但本次会话不符合时同样 `POLICY_OFF`。客户端不得在策略关时本地“先录着”再上传。

### 3.2 seek 索引

- 生成规则：录制进行中，每当事件 `at` 距上一个锚点 **≥ 10s**（`SEEK_INDEX_INTERVAL_MS = 10000`），追加一个锚点 `{ t:<该事件 at>, byteOffset:<写完该行后的文件字节偏移> }`。10 分钟录像约 60 个锚点（沙箱实测 60 个，单调递增）。
- 锚点含义：`byteOffset` 是该时刻点的字节偏移；回放器 seek 到时刻 `T` 时，取 `t ≤ T` 的最后一个锚点，从该偏移处开始往后读事件、快进重放到 `T`。
- 索引文件：`end` 时写 `.qfrec.idx`（`{ sessionId, index, events, bytes, endedAt }`）。
- 重建差异：`.idx` 缺失时 `readIndex` 现扫 `.qfrec` 重建——重建把**第一个事件也当锚点**（`lastT === null` 即记），而正常写入的第一个锚点要等满 10s 才出现；重建响应带 `rebuilt:true`。回放器两种索引都须能处理（只依赖锚点单调，不依赖首锚点位置）。

## 4. 访问控制

### 4.1 规则

- 录像按账号隔离：`list` 只返回本人的；`index` / `download` 只许本人（`meta.username` 与当前控制台用户一致）。
- 录像含按键与剪贴板信息即含敏感信息：服务端文件 0600、目录 0700；**站长无直通**——站长侧查看须走既有审核/授权流程，本模块不给站长开后门（`canAccess` 对站长同样只认本人）。
- 保留期：默认 30 天（`retentionDays`）；服务端每 60s 清扫一次，超期录像的 `.qfrec` / `.qfrec.idx` / `.meta.json` 一并删。

### 4.2 无权限响应（不泄露存在性）

- 他人访问 `index` / `download`：HTTP 404 `{ ok:false, code:'NOT_FOUND', msg:'录像不存在。' }`——与“录像根本不存在”同一响应；客户端不得把 404 区分解读为“存在但无权限”。
- 客户端收到 404 时：UI 显示“录像不存在或无权限查看”，不得反复重试、不得提示“对方有录像但你看不了”。

## 5. 回放器须实现的功能

回放器由 L4 在 W-05 后做（网页端）；Windows / 安卓如需回放，按同样功能实现：

1. **列表**：调 `GET /license/api/recordings` 列本人录像（会话、设备、档位、开始时间、字节数）。
2. **加载**：选一条后先调 `GET …/index` 取索引，再调 `GET …/download` 整文件下载 `.qfrec`（不支持 Range，见 2.6）。
3. **播放**：按事件 `at` 时间戳顺序重放——`input` 事件还原鼠标/按键光标位置、`frame-marker` 锚点对齐关键帧位置、`quality-change` 显示档位变化标记；不存视频帧，重放的是事件流（光标轨迹＋档位标记），不是视频画面。
4. **seek**：用索引锚点跳到目标时刻（取 `t ≤ T` 的最后锚点，从 `byteOffset` 起往后读事件、快进重放到 `T`）；seek 须在 10s 粒度内准确，不得逐行从头扫到目标时刻。
5. **变速**：支持变速播放（至少 0.5x / 1x / 2x，按 `at` 差值缩放播放间隔）。
6. **边下边播**：下载未完成时可用已下载部分的事件先播（按已下载字节边界切行，不得播半行）。
7. **隐私提示**：回放含按键/剪贴板元数据，播放页须提示“本录像含操作记录”，不得提供“导出剪贴板内容”功能（内容本来就没记）。

## 6. 与实现有出入处（以实现为准）

1. ~~**`/event` 与 `/end` 路由没有按用户鉴权**~~**已修复（2026-11-15）**：`server.js` 的 `recEventM` / `recEndM` 路由现已在 `l5Guard` 之后、读请求体之前调 `canAccess(auth.user, id)`，与 `index` / `download` 逐字同口径；无权限时返回 HTTP 404 `{ ok:false, code:'NOT_FOUND', msg:'录像不存在。' }`（与读路径一致，不区分“不存在”与“存在但非本人”，不泄露录制会话存在性；模块层 `canAccess` 仍返回 `FORBIDDEN` 供调用方区分，路由层统一坍缩为 404）。被拒的 `/event` 不落盘、被拒的 `/end` 不结束会话。`sessionId` 不可预测时风险较低（`rec_`＋16 位 hex），客户端传入自定义 `sessionId` 时仍不得用可猜的值。
2. **录制会话只存在于服务端内存**：`startSession` 后会话状态在 `sessions` Map 里；服务端重启后内存丢失，此后 `/event` / `/end` 返回 `NOT_FOUND`（磁盘上的 `.qfrec` 文件还在，但续不上）。客户端收到 `NOT_FOUND` 后不得静默丢事件——应提示“录制已中断（服务端重启），本次录像不完整”，并重新 `start` 一个新录制（新 `sessionId`）。
3. 录像下载不支持 `Range`（见 2.6）；大录像回放须整文件下载。
4. 策略变更审计：设计文档称“策略变更记审计”，但 `recording-core.js` 里没有策略变更审计事件（策略来自 `config.json`，模块只在开始/结束录制时记 `recording-started` / `recording-ended` 日志）。以实现为准：客户端不依赖策略变更审计。
5. 事件实际捕获未实现：本模块只定格式＋服务端侧；输入/剪贴板/关键帧事件的真实捕获埋点（上游 `mcrec.js` 钩子或 agent 侧上报）须另派线——在埋点落地前，客户端按本规范发事件即进入“协议就绪、捕获待落地”状态，不得宣称已实现真机录像。

## 7. 各端待实现清单

### Windows（L3）
- [ ] 录制控制：会话开始时按策略调 `start`（`POLICY_OFF` 时不录制、不发事件）；结束时调 `end` 取索引。
- [ ] 事件上报：输入/剪贴板（只发 `bytes`）/关键帧锚点/档位变化四种事件实时发 `event`；`at` 单调递增。
- [ ] 本地回放器（可选）：按 §5 实现列表/加载/seek/变速；或复用网页回放器。

### 网页（L4）
- [ ] 回放器（W-05 后做）：按 §5 全部七项实现（列表、加载、播放、seek、变速、边下边播、隐私提示）。
- [ ] 录像列表页：调 `list`，展示到期时间（`startedAt + retentionDays`），超期录像服务端已清、列表里不再出现。

### 安卓（L6）
- [ ] 录制控制与事件上报同 Windows（Flutter 侧；应用退后台时录制事件暂停上报、恢复后按 `at` 续发，不得倒序补发）。
- [ ] 录像列表查看（调 `list`）；回放可用网页回放器或本地简版（至少支持列表＋下载＋按 `at` 顺序播放）。

## 8. 核对方法与结果

- 核对方法：逐项对照 `server/ext/recording-core.js`（全文：`EVENT_TYPES` / `SEEK_INDEX_INTERVAL_MS` / `recordingPolicy` / `shouldRecord` / `sanitizeEvent` / `startSession` / `appendEvent` / `endSession` / `canAccess` / `readIndex` / `listRecordings` / `sweep`）、`server/ext/server.js` 的 recordings 路由（行 2880–2923）与 60s 清扫定时器（行 194–198）；自检脚本 `test-l5-recording.js`（28 项）为沙箱证据：默认 off、三种策略模式命中/未命中、剪贴板内容永不落盘、非法事件拒绝、10 分钟体积比 43.2x、seek 索引 60 个锚点单调、他人访问 403（模块层 `FORBIDDEN`，路由层统一 404）、过期清理过。
- 核对结果：端点路径、事件类型与白名单字段、策略四档、10s 索引间隔、30 天保留期、0600/0700 权限、访问控制语义，均与源码一致；出入处见 §6（5 项，均已标出，未编造未实现的端点）。
