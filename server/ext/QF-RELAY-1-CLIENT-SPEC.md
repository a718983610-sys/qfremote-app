# QF-RELAY-1：中继白名单＋三级回退（客户端协议规范 v1）

- 状态：规范 v1（2026-11-15，L5 后续补文档线出；供 L3 Windows / L4 网页 / L6 安卓做客户端部分）。
- 来源：服务端已落地实现——`server/ext/relay-core.js`（宣告/校验/选路纯函数）、`server/ext/server.js`（`GET /license/api/relays` 路由）；设计依据 `L5-DESIGN-CONFIRMATION.md` §三 / §四。
- 范围：本规范只定**客户端选路**（取宣告列表、建连前校验、三级回退、降级态）。中继自身的转发实现在上游 MeshCentral `meshrelay.js`（树外）；nginx 层不做动态白名单。
- 鉴权：宣告端点在 `server.js` 的 `/license/api/*` 控制台会话门之后，须带有效控制台会话；未加载 L5 模块时返回 HTTP 503 `{ ok:false, code:'L5_UNAVAILABLE' }`。
- 术语：tier（级）＝中继优先级层，1 级最优先；priority（优先级）＝同级内的排序值，**数值越大越先试**；在途（in-flight）＝正在建连、尚未成功或失败的连接尝试。

## 1. 宣告端点与响应格式

### 1.1 请求

```
GET /license/api/relays
（控制台会话鉴权，无请求体）
```

### 1.2 响应

```json
{
  "ok": true,
  "relays": [
    { "id": "qfremote-primary", "url": "https://app.qfremote.top/console-engine/", "tier": 1, "priority": 100, "ttlSec": 600, "issuedAt": 1790000000000 }
  ]
}
```

| 字段 | 含义 / 约束 |
|---|---|
| `id` | 中继标识（服务端去重键，`config.json` 里 `id` 去空格后截断至 80 字符） |
| `url` | 中继地址（服务端归一化后：origin＋以 `/` 结尾的路径） |
| `tier` | 1 / 2 / 3（只接受这三个值，其他值条目直接跳过） |
| `priority` | 同级内排序值，**越大越先试**；未配置时默认 `100` |
| `ttlSec` | 列表有效期（秒）；未配置时默认 `600` |
| `issuedAt` | 服务端签发时刻（毫秒 epoch，`Date.now()`） |

- 排序：服务端返回前已排好序——先按 `tier` 升序，再按 `priority` 降序，再按 `id` 字典序。客户端**不得重排**，按返回顺序试即可；但客户端本地 `pickRelay` 时须用同一排序规则（见 2.2）。
- 列表来源：`config.json` 的 `relays` 数组（每条 `{ id, url, tier, priority?, ttlSec? }`）；无效条目（无 `id`、URL 非法、`tier` 不在 1–3）跳过；同 `id` 只留第一条；**上限 32 条**（`MAX_RELAYS = 32`，超出截断）。
- 未配置时：只宣告一条 tier-1——`{ id:'qfremote-primary', url:<请求 origin>/console-engine/, tier:1, priority:100, ttlSec:600 }`，其中 origin 由请求头 `x-forwarded-host`（优先）或 `host` 派生并强制加 `https://` 前缀，**不写死域名/IP**。
- 缓存：列表有效期为 `issuedAt + ttlSec*1000`；过期后客户端须重新 `GET /license/api/relays`，不得用过期列表建连。

## 2. 三级回退规则与在途上限

### 2.1 选路算法（与服务端 `pickRelay` 同款逻辑，客户端本地执行）

```
pickRelay(list, failedIds, { inFlightByTier, maxInflightPerTier = 8 }):
  候选 = list 中 id 不在 failedIds 里的条目，按 tier 升序、priority 降序、id 字典序排序
  对每条候选（按序）：
    若 inFlightByTier[tier] >= maxInflightPerTier：跳过该条（不算失败，继续看下一条）
    否则返回 { relay: 该条, tier, reason: failedIds 为空 ? 'primary' : 'fallback-after-failure' }
  无候选时返回 { relay: null, tier: 0, degraded: true,
                 reason: 候选非空但各级在途都满 ? 'tier-inflight-full' : 'all-tiers-exhausted' }
```

- 失败处理：某中继建连失败，把它的 `id` 加入 `failedIds`，再调一次 `pickRelay` 选下一条；同一会话内失败过的 `id` 不再试。
- 在途上限：**每级在途建连上限默认 8**（`DEFAULT_MAX_INFLIGHT_PER_TIER = 8`）。`inFlightByTier` 是客户端自己维护的计数（`{ 1: n, 2: n, 3: n }`，正在拨号的连接数）；某级在途已满时跳过该级、试下一级，**不算该级失败**，也不把它的 `id` 加入 `failedIds`。
- 三级耗尽：`degraded:true` 时进入降级态（见 2.3）。

### 2.2 客户端选路算法（会话建立流程）

1. 会话开始前先 `GET /license/api/relays` 取列表（列表为空或请求失败 → 不建连，界面报错，不得用硬编码地址兜底）。
2. `failedIds = {}`，`inFlightByTier = {1:0, 2:0, 3:0}`。
3. 调 `pickRelay` 得一条候选；建连前先调白名单校验（§3）；校验不通过即视为该条不可用，加入 `failedIds` 并回到第 3 步（**不得绕过校验直接拨号**）。
4. 拨号时该级在途计数 `+1`；成功 → 计数 `-1`，建连完成；失败（超时/拒绝/不可达）→ 计数 `-1`，`id` 进 `failedIds`，回到第 3 步。
5. `pickRelay` 返回 `degraded:true` → 进入降级态（2.3）。

### 2.3 降级态

- 耗尽三级后进降级态：**只保留已建会话＋文件暂存通道，不新开桌面会话**。
- 客户端 UI 须明确显示降级态（例如“中继全部不可用，已保留现有会话”），并提供“重试”入口（重试即清空 `failedIds`、重新取宣告列表、从第 2 步重走；不得无间隔自动循环重试）。
- 降级态下不得自动降级去连任何非列表地址。

## 3. 白名单校验（建连前必调）

- 校验函数（与服务端 `isAllowedRelay(url, list)` 同款逻辑，客户端本地实现）：
  - URL 归一化：只接受 `http:` / `https:` 协议，其他协议（`ftp:` 等）一律拒绝；路径补齐末尾 `/`。
  - 匹配规则：**origin 相等，且路径是列表条目路径的前缀**（`pathname.startsWith(条目 pathname)`）。即 `https://relay1.example.com/r/session/abc` 匹配条目 `https://relay1.example.com/r/`；同 origin 不同路径（`/other/`）不匹配；不同 origin 不匹配。
  - 列表为空时一律拒绝（空列表不等于“全部放行”）。
- 校验时机：每次拨号前，对**实际要拨的完整 URL**校验一次；中继地址来自用户输入、二维码、配置文件等任何渠道的，都先过校验。
- 伪造中继拒绝后的客户端行为：
  1. **拒绝拨号**，不得向该地址发任何建连包；
  2. 界面提示“该中继不在服务端宣告列表内，已拒绝连接”（不得把伪造地址当作可重试的普通失败，不得把它加入 `failedIds` 后继续试下一条时还保留它）；
  3. 记一条本地诊断日志（只记 URL 与时间，不记任何密钥/会话口令）；
  4. 继续按 2.2 选下一条列表内中继；若列表内已无候选，进降级态。

## 4. 与实现有出入处（以实现为准）

1. **tier-2/3 真实中继主机目前不存在**：选路逻辑与策略位先行，备用主机就绪后在 `config.json` 的 `relays` 里加一条即生效，不改代码。客户端不得在 UI 里宣称“已部署多级中继”。
2. **没有“上报中继故障”的服务端端点**：`pickRelay` / `isAllowedRelay` 是 `relay-core.js` 里的纯函数，**不是 HTTP 端点**；服务端只提供宣告列表，失败跟踪、在途计数、回退执行全在客户端本地。客户端须把这两段逻辑按本规范在本地实现一遍（三种语言各一份，不得只抄一半）。
3. 宣告列表没有每中继的健康度/延迟字段；客户端不得按延迟自选排序，须按服务端排好的 tier→priority 顺序试。
4. `issuedAt` 是服务端 `Date.now()`（毫秒），`ttlSec` 是秒；客户端算过期须先统一单位（`issuedAt + ttlSec*1000`）。

## 5. 各端待实现清单

### Windows（L3）
- [ ] 宣告列表获取与缓存：会话开始前 `GET /license/api/relays`，按 `ttlSec` 过期重取。
- [ ] 本地实现 `isAllowedRelay` 与 `pickRelay`（与服务端同款逻辑，含在途计数与降级态）。
- [ ] 建连前必校验；伪造地址拒绝拨号＋界面提示＋本地日志（§3）。
- [ ] 降级态 UI：保留已建会话、不新开桌面会话、提供重试入口。

### 网页（L4）
- [ ] 同上（在网页桌面会话层实现；等 W-05 拆分后的新结构落点，不得改冻结中的旧 `server/webapp/app.js`）。
- [ ] 注意：网页端 iframe 挂 `/console-engine/` 的现状不变，本规范管的是客户端按宣告列表选址建连的逻辑，不得绕过宣告列表直连写死地址。

### 安卓（L6）
- [ ] 同上（Flutter 侧实现；弱网下建连超时须计入 `failedIds` 并回退，不得无限重试同一中继）。
- [ ] 在途计数按 tier 维护；应用退后台后在途拨号须取消计数，不得泄漏计数导致后续全部跳过。

## 6. 核对方法与结果

- 核对方法：逐项对照 `server/ext/relay-core.js`（全文：`announceRelays` / `isAllowedRelay` / `pickRelay`、`MAX_RELAYS` / `DEFAULT_TTL_SEC` / `DEFAULT_MAX_INFLIGHT_PER_TIER`）、`server/ext/server.js` 的 `GET /license/api/relays` 路由（行 2792–2798）；自检脚本 `test-l5-relay.js`（16 项）为沙箱证据，其中阴性用例：伪造中继拒绝、同 origin 不同路径拒绝、非 http 协议拒绝、空列表拒绝。
- 核对结果：端点路径、响应字段、排序规则（tier 升序、priority 降序、id 字典序）、默认值（32 / 600 / 8）、降级原因枚举，均与源码一致；出入处见 §4（4 项，均已标出，未编造未实现的端点）。
