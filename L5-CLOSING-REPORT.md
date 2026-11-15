# L5 画面与传输：收尾报告（RC-03 / RC-07 / RC-08 / RC-09 / RC-10）

- 线：L5；工作树 `~/workspace/qfremote/work-recovery241`，分支 `lea-local-agent`，HEAD `b943853`
- 日期：2026-11-15；状态：**服务端＋协议部分全部落地，沙箱测试全绿；agent 侧与真机部分按设计待后续线**
- 未提交、不推送、不部署、不翻 `release.json`（遵守）
- 禁动文件本线零触碰：`server/ext/lea/*`、`windows/lea/*`、`windows/installer.nsi`、`server/webapp/*`、`android-app/*` 均未改（树内这些路径的 M 状态是接手时已有的 149 条基线变更，非本线所动）；未碰 QQGame 四 PID，未重启整机，未碰 MeshCentral 服务

## 一、设计确认（已写进工作树）

`L5-DESIGN-CONFIRMATION.md`（树根）：画面采集/编码管线分界凭证据确认——
- 树内无 `meshcore.js` / `meshagent` / `meshrelay.js`（`find` 零命中）；`server/meshcentral/` 只有上游覆盖层（登录模板、`custom.js`、`release.json`）；安装器只打包不透明 `app.7z`，无 agent 源码引用；桌面数据面是 iframe → nginx `/console-engine/` → 上游 MeshCentral `:8443`（部署在东京机 `/opt/meshcentral`，不在树内）。
- 结论：采集/编码（MeshAgent C）、中继（`meshrelay.js`）、网页桌面渲染（上游控制台页）全在树外；本线只做服务端（ext）＋协议＋纯 JS 参考实现，agent 侧不编造实现。

## 二、大肥鱼复核（RC-03/RC-09，只走 shanedit 中转 deepseek-v4-flash）

- 提问原文：`l5-evidence/ds-review-prompt-rc03-rc09-20261115.txt`；回复原文：`l5-evidence/ds-review-rc03-rc09-20261115.md`（提问不含 Key、grants、签名内容；官网 DeepSeek 未用）
- **RC-03：不通过 → 按复核改后有条件通过。** 初版 XOR `k=8,n=2` 数学上不能保任意 2 丢（复核证明：`n=2` 时非零校验列只有 3 种，`k≤3` 才能两两不同）。已改：RS over GF(256)（`k=10,m=2` 任意 2 丢可恢复，`k=20,m=1` 任意 1 丢）；IDR 从“格式校验＋透传”改为服务端准入控制（绑定＋防重放＋令牌桶＋合并窗口＋硬上限＋冷却＋审计）；FEC 块每帧一块、不得跨关键帧；验收扩展为确定性丢包 trace。
- **RC-09：有条件通过 → 按复核改后落地。** 降档判定改为双阈值＋滑动窗口＋冷却（EWMA 只作遥测——实测教训：EWMA 压阈值会让严重值永远到不了阈值）；背压分级 L1 `reduce-fps` → L2 降分辨率/码率 → L3 `drop-to-keyframe`＋受控 IDR；手动升档加健康窗口 20s＋乒乓冷却 60s；档位参数分“热可调”与“需重建”，不再宣称“全部即时无感”。
- 复核裁决要点已写入设计确认 §七。

## 三、每项状态与证据（沙箱实测，命令输出为准）

| 项 | 树内交付 | 沙箱测试 | 结果 |
|---|---|---|---|
| RC-03 FEC＋IDR | `server/ext/fec-ref.js`（RS GF(256) 参考实现＋块头＋交织＋丢包 trace 模拟）、`server/ext/idr-core.js`（IDR 准入：绑定/防重放/令牌桶/合并/硬上限/冷却/审计）；端点 `POST /license/api/session/idr-request` | `node server/ext/test-l5-fec.js`、`test-l5-idr.js` | **FEC 27/27，IDR 18/18**。均匀 5%：294/300 帧可解码，单丢 103/103、双丢 36/36 恢复，IDR 6 次；突发（Gilbert-Elliott，平均 5%）：交织深度按 `D≥ceil(burst/2)` 时 burst-5 293/300、burst-10 282/300，超限部分 IDR 兜底、恢复 ≤4 帧；关键帧丢 2 符号 10/10 恢复；RS 编解码基准 0.17ms/块（1KB 分片）。诚实记录：无交织时 burst-5 269/300、burst-10 273/300（m=2 扛不住同块长连丢，须交织或 IDR 兜底） |
| RC-07 中继白名单＋三级回退 | `server/ext/relay-core.js`（宣告/精确白名单校验/三级回退选路，每级在途上限 8，上限 32 条）；端点 `GET /license/api/relays`（未配置时只宣告本源 tier-1，不写死域名/IP） | `node server/ext/test-l5-relay.js` | **16/16**。伪造非列表中继拒绝；tier-1 故障 → tier-2 → tier-3 → 降级态；在途满跳过该级。**如实上报：tier-2/3 真实中继主机目前不存在**——选路逻辑与策略位先行，备用主机就绪后在 `config.json` 的 `relays` 里加一条即生效 |
| RC-08 统一流＋分片＋审计 | `server/ext/transfer-core.js`（QF-STREAM-1：init/chunk/commit/resume/cancel，1MB 分片，SHA-256 校验，`transfer-audit.jsonl` exactly-once）；`files-core.js` 加法式新增 `stageBuffer`（stage/inbox/ack/sweep 行为一字不改）；端点 `/license/api/files/stream/*`、`/license/api/files/audit`；下载端点加 Range 续传（206，无 Range 时行为不变） | `node server/ext/test-l5-transfer.js` | **37/37**。100MB 端到端（1MB×100 分片）：上传＋拼装＋SHA-256＋暂存＋字节一致，耗时 2011ms（含 100MB 随机数生成）；审计文件 6 行、6 个唯一 transferId（完成/失败/取消各恰一条，重复 commit 不产生第二条）；断点续传、乱序分片、SHA 校验失败作废全过。注：100MB 用例在 512MB tmpfs 跑，测试自带 exit 清理（此前三轮残留已清，/tmp 回到 18%） |
| RC-09 四档＋自降档＋背压 | `server/ext/quality-core.js`（QF-QUALITY-1：四档参数表＋schema 校验＋每会话快照、EWMA 遥测、双阈值降档、手动升档健康窗口＋乒乓冷却、背压 L1/L2/L3、ACK 超时）；端点 `POST /license/api/session/probe`、`/quality/upgrade`、`/quality/ack` | `node server/ext/test-l5-quality.js` | **26/26**。单次尖峰不降档；严重坏连续 2 样本降档；一般坏 5s 窗口 ≥3 样本且持续 ≥3s 才降档；弱网序列一路降到 smooth 且会话保持；恢复不自动升档；手动升档须 20s 健康窗口；仅客户端自报不触发背压，交叉验证才触发；ACK 超时记日志 |
| RC-10 录像事件流 | `server/ext/recording-core.js`（QF-REC-1：`.qfrec` JSONL 事件流、三级粒度开关默认 off、seek 索引每 10s、访问控制仅本人、剪贴板只记元数据绝不记内容）；端点 `/license/api/recordings/*`（start/event/end/list/index/download） | `node server/ext/test-l5-recording.js` | **28/28**。10 分钟模拟录像 4,344,386 字节（54,002 事件）vs 同等视频（2500kbps×600s）187,500,000 字节，**比值 43.2x**；seek 索引 60 个锚点单调；他人访问 403；过期清理过 |

- 合计：**L5 自检 152 项全绿**（16+27+18+26+37+28）。
- 回归：既有 ext 测试全过——`test-make-release-json.js` 19/19、`test-points.js` 11 项、`test-presence.js` 23/23、`test-guardcheck.js` 23/23、`test-client-version.js` 全过；`node --check` 8 个新/改文件全过；`QFEXT_NO_LISTEN=1` 加载 `server.js` 成功，日志见 `l5-modules-loaded`（lea/instant-review 报错是沙箱本就缺文件，与本次改动无关）。
- 网页面工作（RC-08 文件 UI、RC-10 回放器）未动，等 L4 W-05 拆分落地后再进（遵守分工）。

## 四、未完成／待后续线（不悄悄延期，如实列出）

1. **agent 侧实现（须另派线）**：RC-03 编码器出 RS 分片、解码端还原、收到 `idr-request` 后强制出 IDR；RC-09 编码参数真正切换、帧堆积检测执行、RTT/丢包探测执行；RC-10 事件流实际捕获埋点（上游 `mcrec.js` 钩子）。本线只定了协议（`QF-VIDEO-1` / `QF-QUALITY-1` / `QF-REC-1`）＋参考实现，未上报为已实现。
2. **三端客户端实现（L3/L4/L6 按本线规范落地）**：RC-07 按宣告列表建连＋回退；RC-08 按 `QF-STREAM-1` 实现上传/下载 UI 与断点续传；RC-09 探针上报＋档位执行＋ACK；RC-03 解码端 FEC 还原＋IDR 请求发送；RC-10 网页回放器（L4，W-05 后）。
3. **真机验收（等 L7 安排 ECS 弱网窗口）**：5% 丢包花屏自愈真机时间、弱网（300ms＋5% 丢包）不断连、四档真机切换、100MB 三端行为一致、10 分钟录像真机体积比、伪造中继阴性测试真机版、中继故障自动降级真机版。沙箱数值（上表）不是真机值。
4. **IDR 绑定说明**：ext 侧 `idr-request` 端点目前按“首次见到的 sessionId 先到先得绑定到当前用户＋agentId”执行（此后只认该绑定）；权威绑定待 agent 通道落地后以 LEA/控制通道为准，已在代码注释与路由注释写明。
5. **RC-07 tier-2/3**：真实备用中继主机不存在，见上表。

## 五、协议编号（本线新定，三端共用）

- `QF-VIDEO-1`：`idr-request` 控制消息＋RS FEC 分组格式（`k=10,m=2` / `k=20,m=1`，交织深度规则 `D≥ceil(burst/2)`）
- `QF-RELAY-1`：中继宣告列表格式与三级回退选路算法
- `QF-STREAM-1`：统一文件流抽象（init/chunk/commit/resume/download/cancel）与审计记录格式
- `QF-QUALITY-1`：四档画质参数表（热可调/需重建拆分）、探针格式、自降档规则、背压信号
- `QF-REC-1`：`.qfrec` 事件流格式、三级录制策略、回放索引

以上协议只含格式与算法，不含任何密钥、grants、签名材料；不涉及 LEA 握手（L1 范围）。

## 六、文件清单（工作树内）

- 设计确认：`L5-DESIGN-CONFIRMATION.md`
- 大肥鱼复核原文：`l5-evidence/ds-review-rc03-rc09-20261115.md`、`l5-evidence/ds-review-prompt-rc03-rc09-20261115.txt`
- 新模块：`server/ext/relay-core.js`、`server/ext/fec-ref.js`、`server/ext/idr-core.js`、`server/ext/quality-core.js`、`server/ext/transfer-core.js`、`server/ext/recording-core.js`
- 自检：`server/ext/test-l5-relay.js`、`test-l5-fec.js`、`test-l5-idr.js`、`test-l5-quality.js`、`test-l5-transfer.js`、`test-l5-recording.js`
- 改动：`server/ext/files-core.js`（加法式 `stageBuffer`）、`server/ext/server.js`（L5 模块加载＋端点挂载＋下载 Range 分支；其余 diff 行为接手前基线）
- 本报告：`L5-CLOSING-REPORT.md`
