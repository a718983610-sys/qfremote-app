# QF-VIDEO-1：画面 FEC＋IDR 请求（客户端协议规范 v1）

- 状态：规范 v1（2026-11-15，L5 后续补文档线出；供 L3 Windows / L4 网页 / L6 安卓做客户端部分）。
- 来源：服务端已落地实现——`server/ext/fec-ref.js`（RS 参考实现＋块头＋交织模拟）、`server/ext/idr-core.js`（IDR 准入状态机）、`server/ext/server.js`（`POST /license/api/session/idr-request` 路由）；设计依据 `L5-DESIGN-CONFIRMATION.md` §三 / §七、大肥鱼复核原文 `l5-evidence/ds-review-rc03-rc09-20261115.md`。
- 范围：本规范只定**客户端须实现的部分**（分片格式、解码端还原、IDR 请求发送时机与节流语义）。编码器出 RS 分片、agent 收到放行决策后强制出 IDR，仍在 agent 侧（树外，另派线）；服务端只做准入控制，不直接碰编码器。
- 鉴权：本节 HTTP 端点在 `server.js` 的 `/license/api/*` 控制台会话门之后，须带有效控制台会话；未加载 L5 模块时返回 HTTP 503 `{ ok:false, code:'L5_UNAVAILABLE' }`。
- 术语：分片（symbol）＝一个 FEC 块内的一片数据或校验；块（block）＝一帧的全部 k+m 个分片；`k`＝数据分片数，`m`＝校验分片数。

## 1. FEC 分片格式

### 1.1 Reed-Solomon 参数（只定两档，不得自创第三档）

| 档位 | k | m | 开销 m/k（`repairPercent`） | 恢复能力 | 用途 |
|---|---|---|---|---|---|
| 高保护 | 10 | 2 | 20% | 任意 2 个分片丢失可恢复 | 默认档（balanced 及以上，见 QF-QUALITY-1） |
| 低保护 | 20 | 1 | 5% | 任意 1 个分片丢失可恢复 | 低码率档（smooth） |

- 有限域 GF(256)，本原多项式 `0x11d`，生成元 `2`；校验行系数为 Vandermonde：校验行 `j`（`j = 0..m-1`）对数据分片 `i` 的系数为 `(j+1)^i`。与服务端 `fec-ref.js` 的 `encodeShards` / `decodeShards` 逐字节一致，agent 侧（C）实现须与该参考实现对拍通过。
- 丢失分片位置已知（erasure 解码，靠块头的 `symbolIndex` 缺口判定）；丢失数 `> m`，或可用校验行不足时，返回不可恢复（`decodeShards` 返回 `null`），不得强行拼帧。
- 沙箱实测（`test-l5-fec.js`，30fps、300 帧）：均匀 5% 丢包 294/300 帧可解码，单丢 103/103、双丢 36/36 恢复；关键帧丢 2 符号 10/10 恢复；RS 编解码基准 0.17ms/块（1KB 分片）。该数值为沙箱模拟值，不是真机值。

### 1.2 块边界与尾块

- **每帧一个块，不得跨关键帧**：块不得包含两个关键帧的数据，也不得把一帧的数据拆进两个块。
- 块内全部 `k+m` 个分片等长（`symbolLength`）；数据分片按帧字节顺序切分，最后一个数据分片不足长时**零填充**，真实长度由块头 `lastSymbolPadding` 保留，解码后按真实长度裁剪，不得把填充零当画面数据。
- 档位切换（`k/m` 变化）只在关键帧 / 块边界生效，块头带 `fecVersion`（见 1.3）。

### 1.3 块头（每分片携带，逻辑字段）

| 字段 | 类型 | 含义 / 约束 |
|---|---|---|
| `fecVersion` | 整数 | 必须为 `1`（`FEC_VERSION = 1`） |
| `blockId` | uint32 | 块序号（每会话内递增） |
| `frameId` | uint32 | 所属帧序号 |
| `isKeyframe` | 布尔 | 该帧是否为关键帧 |
| `frameStart` | 布尔 | 该分片是否为帧首分片 |
| `frameEnd` | 布尔 | 该分片是否为帧末分片 |
| `symbolIndex` | 整数 | 本分片在块内的序号，`0 ≤ symbolIndex < symbolCount` |
| `symbolCount` | 整数 | 必须等于 `k + m` |
| `symbolLength` | 整数 | 分片字节长度，必须 `> 0` |
| `lastSymbolPadding` | 整数 | 尾分片填充字节数，`0 ≤ lastSymbolPadding < symbolLength` |
| `k` | 整数 | 必须为 `10` 或 `20` |
| `m` | 整数 | 必须为 `1` 或 `2` |

校验规则（与服务端 `validateBlockHeader` 一字一致）：`fecVersion !== 1`、`m ∉ {1,2}`、`k ∉ {10,20}`、`symbolCount !== k+m`、`symbolIndex >= symbolCount`、`symbolLength <= 0`、`lastSymbolPadding < 0 或 >= symbolLength`，任一成立即判块头非法，整块丢弃，不得尝试解码。

> **未定项（不编造）**：服务端实现只定义了块头的逻辑字段（`makeBlockHeader` 返回 JS 对象），**没有定义线上传输的二进制打包格式**（字段顺序、字节序、块头是随每分片发送还是带外发送、走哪条传输通道）。线上传输格式须由 agent 侧线定版后补进本规范 v2；客户端在 v2 出来之前不得自行发明打包格式。

### 1.4 交织规则

- 交织：把连续 `G` 个块的符号按轮询顺序交织发送（先发各块的 0 号符号，再发各块的 1 号符号……），突发丢包摊到多个块，每块最多丢 `ceil(burstLen / G)` 个符号。
- 交织深度下限：**`G ≥ ceil(burstLen / 2)`**（`m=2` 时每块至多丢 2 个才能恢复）。即突发长度 5 须 `G ≥ 3`，突发长度 10 须 `G ≥ 5`。
- 不交织的后果（沙箱实测）：突发 5 时 269/300 帧可解码、突发 10 时 273/300（`m=2` 扛不住同块长连丢），超限部分走 IDR 兜底、恢复 ≤ 4 帧。交织后突发 5 为 293/300、突发 10 为 282/300。
- 客户端实现：发送侧（agent）按 `G` 交织；接收侧按 `blockId` / `symbolIndex` 还原归位后再解码。`G` 的取值由 agent 侧按当前突发估计选取，不得小于上式下限；`G` 本身不进块头，由收发双方按档位约定（约定值待 agent 线定版后补进本规范）。

## 2. IDR 请求端点

### 2.1 请求

```
POST /license/api/session/idr-request
Content-Type: application/json
（控制台会话鉴权）
```

请求体：

```json
{ "sessionId": "sess-0123456789abcdef", "agentId": "agent-1", "seq": 7, "reason": "loss" }
```

| 字段 | 要求 |
|---|---|
| `sessionId` | 桌面会话标识，必填；须为已绑定的会话（见 2.3） |
| `agentId` | 被控端 agent 标识，必填；与绑定时的 agent 一致 |
| `seq` | 每会话单调递增的整数，必填；必须 `> ` 服务端已见的最大 seq，否则判重放 |
| `reason` | 白名单三选一：`loss`（丢包不可恢复）/ `join`（新观看端加入）/ `quality-change`（档位切换需关键帧） |

### 2.2 响应（HTTP 200，须看 body，不看 HTTP 状态）

```json
{ "ok": true, "decision": "forward", "code": "OK", "msg": "放行。" }
```

- `decision` 三态：`forward`（放行，服务端将转发给 agent 强制出 IDR）/ `coalesced`（已合并，不产生新的关键帧）/ `rejected`（拒绝，本次不产生关键帧）。
- `ok` 为真当且仅当 `decision` 是 `forward` 或 `coalesced`。被拒绝时 `ok:false`，仍返回 HTTP 200。
- `code` 枚举（与服务端 `idr-core.js` 一字一致）：

| code | decision | 含义 / 客户端反应 |
|---|---|---|
| `OK` | forward | 放行；等下一关键帧到达后渲染，不得再发一次 |
| `COALESCED` | coalesced | 同 reason 合并窗口内，已合并；等已放行的那次关键帧，不得重发 |
| `NO_SESSION` | rejected | 会话未绑定；检查 `sessionId` 是否传错，不得重试刷请求 |
| `NOT_BOUND` | rejected | 会话不属于当前用户/agent；停止请求，走重新绑定/重新登录 |
| `BAD_REASON` | rejected | `reason` 非法；客户端 bug，不得重试 |
| `REPLAY` | rejected | `seq` 非单调递增（重放/乱序）；按 2.4 修复 seq 后再发 |
| `COOLDOWN` | rejected | 连续超限冷却中；响应带 `retryAfterMs`，冷却结束前不得再发 |
| `HARD_LIMIT` | rejected | 硬上限（1/s、5/10s）；等窗口滑过后再发 |
| `SESSION_BUCKET` | rejected | 会话令牌桶已空；等令牌恢复后再发 |
| `AGENT_BUCKET` | rejected | agent 令牌桶已空；等令牌恢复后再发 |

### 2.3 会话绑定（先到先得）

- 服务端 `idrGate.bind()`：**首次见到的 `sessionId` 按先到先得绑定到当前控制台用户＋请求体里的 `agentId`**，此后只认该绑定；换用户或换 `agentId` 再请求同一 `sessionId` 即 `NOT_BOUND`。
- 绑定只存在于服务端内存，服务端重启后绑定丢失，客户端须在会话重建后重新走首次绑定（即重发一次请求即完成重新绑定，无单独的绑定端点）。
- 权威绑定（agent 侧注册）待 agent 通道落地后以 LEA/控制通道为准，当前先到先得是过渡口径（`server.js` 路由注释已写明）。

### 2.4 防重放（seq）

- `seq` 每会话从 1 开始单调递增，每发一次请求加 1，无论上次是放行、合并还是拒绝——**被合并（`coalesced`）的请求也消费 `seq`**（服务端 `maxSeq` 前进）。
- 收到 `REPLAY` 时：客户端不得原样重发；须把本地 `seq` 同步到大于服务端已见最大值（本地记 `maxSeq+1`，即下一次发送用 `lastAckedSeq + 1` 之上的新值——实现上以本地单调计数器为准，只要保证每次发送的 `seq` 大于之前所有已发送的 `seq` 即可），再按正常时机发。
- 多观看端同 `sessionId`：`seq` 由各观看端各自维护会互相顶掉——**同一会话的多观看端须共用一个 seq 计数器**（由会话主持端统一发 IDR 请求，或各端通过同一本地协调器发号），否则后发的端永远 `REPLAY`。

### 2.5 节流与防重放语义（数值全部来自服务端实现，不得自行放宽）

| 规则 | 值 |
|---|---|
| 会话令牌桶 | 速率 0.5/s，burst 2（初始满桶 2） |
| agent 令牌桶 | 速率 2/s，burst 5 |
| 硬上限（只统计实际放行的请求） | 每会话 1/s、5/10s（滑动窗口） |
| 同 reason 合并窗口 | `loss` 1s、`quality-change` 2s、`join` 1s（窗口内同 reason 请求合并，不产生新关键帧，不消耗硬上限额度） |
| 连续超限冷却 | 连续 3 次拒绝 → 10s 冷却（`cooldownUntil`），冷却期内一律 `COOLDOWN` 并返回 `retryAfterMs` |
| join 宽限 | 会话绑定后 10s 内首次 `join` 不占令牌桶（仍受硬上限与合并窗口约束）；仅首次一次 |
| 多观看端 | 同 `sessionId` 的请求按会话合并，不各触发一次关键帧 |

判定顺序（服务端 `request()`）：未绑定 → 绑定不符 → reason 非法 → seq 重放 → 冷却中 → 合并窗口 → 硬上限 → join 宽限/令牌桶 → 放行。每次拒绝都计入连续超限次数；放行后连续超限计数清零。

## 3. 解码端须实现的行为

1. **收包与归位**：按 `blockId` / `symbolIndex` 收包；块头非法（1.3）即整块丢弃，不尝试解码。
2. **丢包判定**：分片缺失靠 `symbolIndex` 缺口判定；收到分片后先看缺失数：0 缺失直接渲染；1–2 缺失（按 `m`）走 RS 还原；超过 `m` 或可用校验行不足，判不可恢复。
3. **不可恢复判定用超时窗口，不一丢即请求**：判定窗口为 `RTT + jitter + 1 帧时长`（30fps 下 1 帧为约 33ms）；窗口内等迟到分片，窗口届满仍不可恢复，才丢弃受影响帧并触发一次受控 `idr-request`（`reason=loss`，进 2.5 限流）。（注意：服务端 `simulateFrames` 是模拟简化，每不可解码帧计一次 IDR；解码端实现须按本条超时窗口做，不得照模拟抄“一丢即请求”。）
4. **FEC 还原**：用 1.1 的 RS 参数做 erasure 解码；还原后按 `lastSymbolPadding` 裁剪尾分片；还原出的帧须完整才渲染，半帧不得上屏。
5. **IDR 发送时机（只这三种，不得另加）**：
   - 新观看端加入：发一次 `reason=join`（绑定后 10s 宽限内发，利用免令牌桶的首次机会）；
   - 帧不可恢复：按第 3 条超时窗口届满后发一次 `reason=loss`；
   - 档位切换需关键帧：每次档位切换最多一次 `reason=quality-change`（2s 合并窗口会兜底重复发送）。
6. **收到 `coalesced` / `rejected` 后的行为**：不补发、不换 reason 重发、不降级成“每帧都请求”；等已放行的关键帧或等冷却/窗口过去；UI 上不得向用户报错（节流是正常行为，可在诊断日志里记一条）。
7. **关键帧到达后**：清旧参考帧，用新关键帧重建解码状态；此前的不可恢复帧不再补请求。

## 4. 与实现有出入处（以实现为准）

1. `validateBlockHeader` 接受 `k=10/m=1` 与 `k=20/m=2` 的组合（只校验 `k ∈ {10,20}` 且 `m ∈ {1,2}`），但本协议只定义 `k=10/m=2` 与 `k=20/m=1` 两档。**客户端只许发这两档**，不得利用校验宽松发其他组合；服务端后续可收紧校验。
2. 块头无线上传输打包格式（见 1.3 末尾未定项），待 agent 线定版。
3. 服务端只做准入决策返回，不直接把放行转发给 agent——“转发给 agent 强制出 IDR”这一步的通道尚未实现（`idr-core.js` 注释：放行决策由调用方转发给 agent）。在通道落地前，`forward` 只表示“服务端允许”，客户端不得假设 agent 已收到。
4. `quality-change` 的“每次档位切换最多 1 次”在实现里由 2s 合并窗口等效实现，没有单独的“档位切换 id”去重；客户端切换档位时自己只发一次，不得依赖服务端去重。

## 5. 各端待实现清单

### Windows（L3）
- [ ] 解码器接 RS 还原：按 1.1–1.3 实现收包、块头校验、erasure 解码、尾分片裁剪；不可恢复帧丢弃＋受控 IDR（§3 第 2–4 条）。
- [ ] IDR 请求发送器：会话级单调 `seq`、三 reason、超时窗口判定、收到 `coalesced`/`rejected` 后不补发（§3 第 5–6 条）。
- [ ] 交织还原：按 `blockId` / `symbolIndex` 归位（交织深度 `G` 待 agent 线定值后接入）。

### 网页（L4）
- [ ] 网页解码端同上（在网页桌面会话层实现；注意网页端须等 W-05 拆分后的新结构落点，不得改冻结中的旧 `server/webapp/app.js`）。
- [ ] IDR 请求走 `POST /license/api/session/idr-request`（同源 fetch，带控制台会话）；UI 不展示节流拒绝。

### 安卓（L6）
- [ ] Flutter 解码端同上（Dart/原生解码层实现 RS 还原；性能敏感处走原生，不要纯 Dart 逐字节解码大帧）。
- [ ] IDR 请求发送器同上；移动端弱网下更须遵守超时窗口，不得一丢即请求。

## 6. 核对方法与结果

- 核对方法：逐项对照 `server/ext/fec-ref.js`（全文）、`server/ext/idr-core.js`（全文）、`server/ext/server.js` 的 `idr-request` 路由（行 2830–2843）与 `L5-DESIGN-CONFIRMATION.md` §七；端点、字段名、枚举值、数值逐一核对原文；自检脚本 `test-l5-fec.js`（27 项）、`test-l5-idr.js`（18 项）为沙箱证据。
- 核对结果：端点路径、请求/响应字段、`REASONS`、`COALESCE_MS`、令牌桶/硬上限/冷却数值、块头 12 字段与校验规则、RS 两档参数，均与源码一致；出入处见 §4（4 项，均已标出，未编造未实现的端点）。
