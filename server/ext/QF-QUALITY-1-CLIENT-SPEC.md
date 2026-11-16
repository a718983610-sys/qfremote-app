# QF-QUALITY-1：画质四档＋自降档＋背压（客户端协议规范 v1）

- 状态：规范 v1（2026-11-15，L5 后续补文档线出；供 L3 Windows / L4 网页 / L6 安卓做客户端部分）。
- 来源：服务端已落地实现——`server/ext/quality-core.js`（档位表＋探针判定＋升档＋背压＋ACK 状态机）、`server/ext/server.js`（`POST /license/api/session/probe`、`/quality/upgrade`、`/quality/ack` 路由）；设计依据 `L5-DESIGN-CONFIRMATION.md` §三 / §七、大肥鱼复核原文 `l5-evidence/ds-review-rc03-rc09-20261115.md`。
- 范围：本规范定客户端须实现的探针发送、档位执行、ACK 回复。编码参数真正切换、帧堆积检测执行、RTT/丢包探测的底层采集在 agent 侧 / 各端本地（树外，另派线）；服务端只做决策，不直接碰编码器。
- 鉴权：本节全部端点在 `server.js` 的 `/license/api/*` 控制台会话门之后，须带有效控制台会话；未加载 L5 模块时返回 HTTP 503 `{ ok:false, code:'L5_UNAVAILABLE' }`。错误一律 HTTP 200 返回 `{ ok:false, code, msg }`。
- 术语：档位（tier）/ 探针（probe）/ 决策（decision）/ 背压（backpressure）。

## 1. 档位表

| 档位 | 含义 | targetKbps（目标码率） | maxFps（帧率上限） | fecRepairPercent | resolutionScale（分辨率缩放） | encoderPreference（编码器偏好） |
|---|---|---|---|---|---|---|
| `smooth` | 流畅 | 800 | 15 | 5% | 0.5 | h264 |
| `balanced` | 均衡（默认档） | 2500 | 30 | 10% | 0.75 | h264 |
| `clear` | 清晰 | 5000 | 30 | 15% | 1.0 | h264 |
| `original` | 原画 | 12000 | 60 | 20% | 1.0 | hevc |

- 默认档 `balanced`；未知档位回退默认档并记服务端告警日志（`quality-config-fallback`）。
- 档位表来源：`config.json` 的 `qualityTiers`（须含 `version: 1`；每档四个数值字段须为 `> 0` 的数，`encoderPreference` 须为非空字符串；缺档/坏值时该档用上表默认值并记问题日志）。服务端启动后改 `config.json` 不影响已建会话（每会话建会话时快照一份参数表）。
- 参数分两类，切换语义不同（见 4.3）：
  - **热可调**（关键帧/块边界切换）：`targetKbps`、`maxFps`、`fecRepairPercent`；
  - **需重建**（切换触发 IDR、接收端清旧参考帧）：`resolutionScale`、`encoderPreference`。**不再宣称“全部即时无感”**——热参数下一关键帧边界生效，需重建参数经编码器重配＋IDR 后生效。

## 2. 探针端点

### 2.1 请求

```
POST /license/api/session/probe
```

请求体：

```json
{
  "sessionId": "sess-0123456789abcdef",
  "tier": "balanced",
  "probe": { "rttMs": 120, "lossPct": 0.5, "lossSamples": 120, "jitterMs": 12, "decodeLagMs": 40, "pendingFrames": 2 },
  "serverSignal": { "queueBytes": 0, "sendBlockedMs": 0 }
}
```

| 字段 | 要求 |
|---|---|
| `sessionId` | 必填；首次探针即创建该会话的质量会话（`initialTier` 取 `body.tier`，非法/缺省为 `balanced`） |
| `tier` | 可选；只在首次探针（建会话）时生效，后续探针改 `tier` 不切换档位 |
| `probe.rttMs` | 必填；往返时延毫秒，合理范围 0–10000 |
| `probe.lossPct` | 必填；丢包率百分比，0–100；**统计窗口 1s 且样本数 ≥ 50 包**（`lossSamples < 50` 的样本会被记为降权日志，见 2.3） |
| `probe.lossSamples` | 建议填；该 1s 窗口内的统计包数；`< 50` 时服务端记 `quality-probe-downweighted`，不直接拒收 |
| `probe.jitterMs` | 必填；抖动毫秒，0–5000 |
| `probe.decodeLagMs` | 可选；解码滞后毫秒，0–10000 |
| `probe.pendingFrames` | 可选；待解码堆积帧数，0–10000 |
| `probe.frameCorrupt` | 可选；布尔，参考链是否已损坏（只用于背压 L3 判定，见 5.1；注意它不进服务端的值域校验） |
| `probe.serverQueueBytes` | 可选；客户端观测到的服务端队列字节数，0–64MB（透传进样本记录） |
| `serverSignal` | 可选；`{ queueBytes, sendBlockedMs }`，服务端独立信号（见 5.3 的出入说明） |

### 2.2 响应

```json
{ "ok": true, "tier": "balanced", "decision": { "decision": null, "reason": "hold" }, "backpressure": { "level": null, "action": null, "note": "无背压。" } }
```

- `tier`：服务端当前档位（降档后即为新档位）。
- `decision`：`{ decision:null, reason:'hold' }`（保持）/ `{ decision:null, reason:'probe-incomplete' }`（探针缺必填字段，本次未入库）/ 降档决策对象（见 4.1）。
- `backpressure`：背压决策对象（见 §5）。

### 2.3 探针发送规则（客户端执行，服务端只按收到样本的时间戳判定）

- 周期：正常 **1s**；弱网或档位切换后 10s 内 **500ms**；页面/应用隐藏时 **5s**。
- `lossPct` 须声明统计窗口与最小包数：1s 窗口且 `lossSamples ≥ 50` 才采信；不足 50 包的样本服务端只记降权日志、不直接拒收（但该样本仍会进判定窗口——见 §6 第 5 条）。
- 探针缺 `rttMs` / `lossPct` / `jitterMs` 任一（非有限数）时，服务端返回 `probe-incomplete`，**该样本不入库、不参与判定**。
- 超出值域的字段（`rttMs` 0–10000、`lossPct` 0–100、`jitterMs` 0–5000、`decodeLagMs` 0–10000、`pendingFrames` 0–10000、`serverQueueBytes` 0–64MB 之外）服务端记 `quality-probe-downweighted` 日志，样本仍入库（见 §6 第 5 条）。
- 探针只上报观测值，不带任何密钥、grants、签名材料。

> `lossPct` 方向说明：实现里探针只有一个 `lossPct` 字段，未分上行/下行。本规范暂定 **`lossPct` 指观看端下行（服务端→观看端）丢包**；上行丢包暂不进探针，待后续修订补字段。客户端不得把两个方向的丢包率取平均后上报。

## 3. 降档规则（服务端判定，客户端执行）

判定阈值（全部来自服务端实现）：

| 条件 | 阈值 |
|---|---|
| 一般坏（bad） | `rttMs > 300` 或 `lossPct > 5` 或 `jitterMs > 50` |
| 严重坏（severe） | `rttMs > 800` 或 `lossPct > 20` 或 `decodeLagMs > 500` |
| 健康（healthy） | `rttMs < 150` 且 `lossPct < 1` 且 `jitterMs < 30` 且（`decodeLagMs` 缺省或 `< 150`） |

降档触发（二选一，满足其一即降一档）：

- **严重坏连续 2 样本**即降档；
- **一般坏 5s 窗口内 ≥ 3 样本且持续 ≥ 3s**（从首个一般坏样本起算满 3s）才降档。单次尖峰不降档。
- 降档冷却：一般坏降档后 5s 内不再降；连续恶化时每 3s 最多降一档（严重坏路径）。
- 每次降档只降一档；已在 `smooth` 时不再降；会话保持不断连。
- **网络恢复后不自动升档**（须用户手动升档，见 §4.2）。
- EWMA（α=0.3）只作遥测：服务端算 `rttMs` / `lossPct` / `jitterMs` 的 EWMA 供观测，**判定用原始样本**（去抖靠“计数＋持续时间＋冷却”；EWMA 平滑会让严重值永远到不了阈值）。

## 4. 降档 / 升档执行与 ACK 语义

### 4.1 降档决策（`downgrade-to`）

探针响应里的降档决策对象：

```json
{ "decision": "downgrade-to", "decisionId": "qd_12", "from": "clear", "to": "balanced",
  "hot": { "targetKbps": 2500 }, "reconfig": { "resolutionScale": 0.75 },
  "mustAckByMs": 1790000005000, "needsIdr": true }
```

- `decisionId`：`qd_`＋递增序号，ACK 时原样回传。
- `hot`：热可调参数的变化（只含变了的键）；`reconfig`：需重建参数的变化（只含变了的键）。
- `needsIdr`：`reconfig` 非空时为 `true`——客户端执行切换后须触发 IDR（走 QF-VIDEO-1 的 `idr-request`，`reason=quality-change`），并清接收端旧参考帧。
- `mustAckByMs`：ACK 截止时刻（决策时刻＋5000ms）。

### 4.2 手动升档

```
POST /license/api/session/quality/upgrade
请求体：{ "sessionId": "sess-…" }
```

- 前置：该 `sessionId` 须先上报过探针（否则 `{ ok:false, code:'NOT_FOUND', msg:'会话不存在（须先上报探针）。' }`）。
- 健康窗口：最近 20s 内样本 **≥ 5 个且全部健康**（阈值见 §3），否则拒绝。
- 成功：`{ ok:true, decision:'upgrade-to', decisionId, from, to, hot, reconfig, mustAckByMs, needsIdr }`（字段含义同 4.1）；一次只升一档；升档后 10s 观察窗。
- 拒绝码：

| code | 含义 |
|---|---|
| `AT_TOP` | 已是最高档 `original` |
| `NO_HEALTH_WINDOW` | 健康窗口样本不足（需 20s 健康样本，≥ 5 个） |
| `NOT_HEALTHY` | 网络未持续健康 20s（须 rtt<150、loss<1%、jitter<30ms、decodeLag<150ms） |
| `PINGPONG_COOLDOWN` | 该档近期反复升降，冷却中；响应带 `retryAfterMs` |

- 乒乓冷却：升档后 10s 观察窗内被降回记一次乒乓；同一目标档 60s 内 2 次乒乓 → 该档冷却 60s。升档阈值与降档阈值分离（迟滞），不得用同一阈值来回跳。

### 4.3 档位执行（客户端）

- 收到 `downgrade-to` / `upgrade-to` 后：先执行 `hot` 参数（下一关键帧/块边界生效），再执行 `reconfig` 参数（编码器重配；`needsIdr` 为真时发 IDR 并清旧参考帧）。
- 执行完成后须调 ACK（4.4）；执行失败（编码器拒绝重配）时同样要调 ACK 说明？——**不**：实现里 ACK 只有“收到并执行”一种语义，没有“执行失败”分支；执行失败时客户端应保持旧档位、记本地日志，并在下一次探针里如实上报当前实际档位对应的观测值（服务端以下次探针的 `tier` 字段为准重建会话档位——注意：首次建会话后 `tier` 字段不再生效，见 2.1；执行失败的档位回退须走“再次手动升档/等服务端再降档”的正常路径，不得伪造 ACK）。
- 档位切换不重连会话；切换调用返回即决策生效（参数生效时序见 1 节末尾）。

### 4.4 ACK

```
POST /license/api/session/quality/ack
请求体：{ "sessionId": "sess-…", "decisionId": "qd_12" }
```

- 成功：`{ ok:true, tier:<执行后档位>, kind:'downgrade'|'upgrade', rttMs:<决策到 ACK 的毫秒数> }`。
- 未知 `decisionId`：`{ ok:false, code:'UNKNOWN_DECISION' }`（不得重试同一 `decisionId`）。
- 超时：ACK 须在 `mustAckByMs` 前到达；**超时 5000ms** 未 ACK，服务端只记 `quality-ack-timeout` 日志并清除该待 ACK 项（服务端在每次探针时清扫超时项）。客户端收到新决策前须先把旧决策的 ACK 发掉，不得堆积多个未 ACK 决策。
- ACK 只确认“客户端已执行该决策”，不携带新的探针数据；探针继续按 2.3 周期发。

## 5. 背压 L1/L2/L3

### 5.1 分级与动作

| 级别 | action | 触发条件（服务端 `backpressure()`） | 客户端动作 |
|---|---|---|---|
| L1 | `reduce-fps` | 服务端队列高，或最近 3 样本持续异常（`pendingFrames > 30` 或 `decodeLagMs > 300`） | 先降生产速率（降帧率），优先于 drop-to-keyframe |
| L2 | `reduce-resolution-bitrate` | 服务端队列高 **且** 客户端堆积（`pendingFrames > 30` 或 `decodeLagMs > 300`） | 降分辨率/码率（按档位表下一档的 `resolutionScale` / `targetKbps` 执行，等效降一档的需重建部分） |
| L3 | `drop-to-keyframe` | 客户端报 `frameCorrupt=true` **且**（服务端队列高或客户端堆积） | 丢弃直到关键帧，并发一次受控 IDR（进 QF-VIDEO-1 限流，`reason=loss`） |

阈值：服务端队列高＝`queueBytes > 512KB` 或 `sendBlockedMs > 500ms`；客户端堆积＝`pendingFrames > 30` 或 `decodeLagMs > 300`。

### 5.2 交叉验证（关键规则）

- **仅客户端自报堆积，不触发背压**：`clientHigh` 单独成立时，服务端只记 `quality-backpressure-hint-only` 日志，返回 `{ level:null, action:null, note:'仅客户端自报，未交叉验证，不触发。' }`。
- 触发须满足：服务端独立信号与客户端上报交叉验证，或连续 3 样本异常（L1 的 sustained 路径）。
- 客户端须如实上报 `pendingFrames` / `decodeLagMs` / `frameCorrupt`，不得夸大堆积“催”服务端降档；异常上报会被降权并记录。

### 5.3 背压响应

- 背压决策随每次探针响应返回（`backpressure` 字段），无单独端点。
- 客户端收到 L1/L2/L3 后执行对应动作，并在后续探针里如实上报变化；背压不是档位决策，不产生 `decisionId`、不须 ACK。
- L3 的 `drop-to-keyframe` 语义为“丢弃直到关键帧，并可选请求关键帧”；请求关键帧须走 IDR 限流，不得绕过。

## 6. 与实现有出入处（以实现为准）

1. **档位表里的 `fecRepairPercent` 10% / 15% 在 FEC 层没有对应档位**：QF-VIDEO-1 只定义 `k=20/m=1`（5%）与 `k=10/m=2`（20%）两档；`balanced` 的 10% 与 `clear` 的 15% 无法直接映射为 `(k,m)`。在 agent 线定版映射之前，客户端按档位表上报/执行 `fecRepairPercent` 时：`≤ 5%` 用 `k=20/m=1`，`≥ 20%` 用 `k=10/m=2`，中间值（10%/15%）的映射待定，不得自行发明第三种 `(k,m)` 组合。本条为跨协议待定项，须 agent 线确认后修订。
2. **EWMA 只作遥测**：设计确认 §七-1 曾写“rtt/loss 用 EWMA（α=0.3）”，实现改为判定用原始样本、EWMA 只作遥测。以实现为准。
3. **`serverSignal` 由客户端随探针上传**：`POST /license/api/session/probe` 的 `body.serverSignal` 是客户端传进来的，服务端 HTTP 层没有实测 WS `bufferedAmount` / 发送队列来填充它。也就是说“服务端独立信号”目前没有服务端实测来源；客户端应如实传自己能观测到的值（观测不到时传 `null` / 省略该字段），背压的交叉验证在信号缺失时退化为“连续 3 样本异常”路径。服务端实测信号待后续线补。
4. **ACK 超时只记日志，不重发**：设计确认 §七-7 曾写“未 ACK 记日志并重发一次”，实现里 `sweepAcks` 只记 `quality-ack-timeout` 并清除待 ACK 项，不重发决策。以实现为准；客户端不得等服务端重发，须自己在 `mustAckByMs` 前 ACK。
5. **值域外探针仍入库**：`sanitize` 只记 `quality-probe-downweighted` 日志，不钳制、不丢弃（只有缺必填字段才 `probe-incomplete` 不入库）。客户端不得依赖服务端清洗，须自己先校验再上报。
6. **`snapshot()` 是建会话时的档位快照**：`createQualitySession` 建会话时对初始档参数做深拷贝快照，档位变化后快照不更新；服务端路由层也不使用它。客户端以探针响应的 `tier` 与决策的 `hot` / `reconfig` 为准，不要用快照推断当前档位。

## 7. 各端待实现清单

### Windows（L3）
- [ ] 探针采集与发送：RTT/丢包/抖动/解码滞后/堆积帧数按 2.3 周期上报（正常 1s、弱网 500ms、隐藏 5s）。
- [ ] 档位执行：`hot` 参数关键帧边界生效、`reconfig` 参数重配＋IDR＋清旧参考帧；执行后 5s 内 ACK（§4）。
- [ ] 手动升档入口：仅在健康时可点，拒绝时展示服务端 `code` 对应的原因（`NOT_HEALTHY` / `PINGPONG_COOLDOWN` 等）。
- [ ] 背压执行：L1 降帧率 → L2 降分辨率/码率 → L3 丢弃到关键帧＋受控 IDR；仅自报堆积不触发时不擅自降档。

### 网页（L4）
- [ ] 同上（网页桌面会话层；等 W-05 拆分后的新结构落点，不得改冻结中的旧 `server/webapp/app.js`）。
- [ ] 页面隐藏时探针周期切 5s；页面恢复后恢复 1s，并补一次即时探针。

### 安卓（L6）
- [ ] 同上（Flutter 侧；移动端切后台/弱网时探针周期与重连逻辑与 Windows 一致）。
- [ ] 手动升档入口与 ACK 超时处理与 Windows 一致；档位切换不得重建会话。

## 8. 核对方法与结果

- 核对方法：逐项对照 `server/ext/quality-core.js`（全文：`TIERS` / `DEFAULT_TIER_TABLE` / `HOT_KEYS` / `RECONFIG_KEYS` / `BAD` / `SEVERE` / `HEALTHY`、各毫秒常量、`validateTierTable` / `splitTierChange` / `ingestProbe` / `requestUpgrade` / `backpressure` / `ack` / `sweepAcks`）、`server/ext/server.js` 的三个 quality 路由（行 2799–2828）；自检脚本 `test-l5-quality.js`（26 项）为沙箱证据：单次尖峰不降档、严重坏连续 2 样本降档、一般坏 5s 窗口 ≥ 3 样本且持续 ≥ 3s 降档、弱网序列一路降到 smooth 且会话保持、恢复不自动升档、手动升档须 20s 健康窗口、仅客户端自报不触发背压、ACK 超时记日志。
- 核对结果：档位表数值、阈值、冷却/观察窗/乒乓规则、背压分级与阈值、ACK 5000ms 超时、端点路径与字段名，均与源码一致；出入处见 §6（6 项，均已标出，未编造未实现的端点）。
