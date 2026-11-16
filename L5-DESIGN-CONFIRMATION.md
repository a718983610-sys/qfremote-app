# L5 画面与传输：设计确认（RC-03 / RC-07 / RC-08 / RC-09 / RC-10）

- 线：L5（画面与传输），范围见 `~/workspace/qfremote/oss-research-20261115/SCOPE-ALL-IN-3.0.md` §1.1 / §二
- 工作树：`~/workspace/qfremote/work-recovery241`，分支 `lea-local-agent`，HEAD `b943853`
- 日期：2026-11-15；状态：设计确认 v1（RC-03/RC-09 待大肥鱼复核后定版）
- 硬线：不碰 `server/ext/lea/*`、`windows/lea/*`、`windows/installer.nsi`、`server/webapp/*`（等 L4 W-05 拆分后方可按约定新结构进）、`android-app/*`；不碰 QQGame 四 PID；不重启整机；不碰 MeshCentral 服务；不提交、不推送、不部署、不翻 `release.json`。

## 一、分界证据（实测命令与结果，2026-11-15 沙箱）

| 断言 | 命令 / 检查 | 结果 |
|---|---|---|
| 树内无 agent 源码 | `find . -name "*meshcore*" -o -name "*meshagent*" -o -name "*MeshAgent*" -o -name "meshrelay.js"`（排除 `.git`） | 零文件 |
| 树内无 MeshCentral 核心 | `ls server/meshcentral` | 只有 `public/`（`release.json`、`scripts/custom.js`）与 `views/`（登录模板覆盖）——全是上游覆盖层，无 `meshrelay.js` / `meshagent.js` / `meshuser.js` / `mcrec.js` |
| 安装器不含 agent 源码引用 | `grep -n "File" windows/installer.nsi` | 只打包不透明 `app.7z`（`/dev/shm/qfr/app.7z`）、`lea/QFRLEA.exe`、`qf-lea-client.exe`、`ush/QFUserHelper.exe`、privacy-lock 件；无 agent 源码、无 agent 构建步骤 |
| 桌面数据面在上游 | `server/webapp/app.js:1756` 与 `server/nginx/qfremote-proxy:300-340` | 网页桌面会话是 iframe 挂同源 `/console-engine/`，nginx 反代到本机 MeshCentral `:8443`；`connectDesktop`、`meshrelay`、桌面渲染代码全在上游 MeshCentral（部署在东京机 `/opt/meshcentral`，不在本树） |
| 文件发送现状 | `server/ext/files-core.js`（517 行）＋ `server/ext/server.js:2725-2755` | 已有“同账号设备间文件发送”：整文件 base64 一次性上传 → 服务端暂存 24h → 目标端下载＋ack；无分片、无断点续传、无传输审计 |
| 审计现状 | `server/ext/events-core.js`、`server/ext/license-core.js:1659 audit()` | events-core 是站长审核事件队列（订单/申诉/换绑/设备异常/论坛/客服），不是通用审计；license-core `audit()` 只记密钥状态查询类事件、上限 1000 条。文件传输审计目前是缺口（与 REPORT.md §十一-5 一致） |
| 录像现状 | `grep -rn "mcrec\|recording\|qfrec" server/ext/ server/webapp/app.js` | 树内零命中；录像能力只存在于上游 MeshCentral `mcrec.js`（本树无此文件） |

结论：**画面采集/编码管线全在树外**——采集＋编码在 MeshAgent（上游 Ylianst/MeshAgent C 仓库，不在本树、不在本机）；中继转发在 MeshCentral `meshrelay.js`（上游，不在本树）；网页桌面渲染在上游控制台页面（本树 `server/webapp/app.js` 只是 iframe 外壳＋会话阶段机，且按分工冻结等 L4 W-05 拆分）。

## 二、管线分界图

```
被控端采集/编码 ──► 中继配对转发 ──► 三端解码/渲染
[MeshAgent C 树外]   [MeshCentral      [网页：上游控制台页 树外
                      meshrelay.js      （本树只有 iframe 外壳）
                      树外]             Windows Electron：L3
                                        安卓 Flutter：L6]
      ▲                    ▲
      │ agent 侧           │ 服务端侧
      │ RC-03 编码器/FEC   │ RC-07 宣告/选路策略
      │ RC-09 编码参数/    │ RC-08 流抽象/分片/审计
      │ 背压执行            │ RC-09 档位定义/探针/背压信号
                            │ RC-10 策略/索引/访问控制
                            │ RC-03 IDR 请求消息定义
```

**服务端＋客户端可改的部分（树内）：**
- 服务端（ext 服务，`server/ext/`，Node）：可新增协议模块＋HTTP 端点（本线落点）；可读 `config.json`（`lic.readConfig()`）作策略源。
- 网页外壳（`server/webapp/app.js`）：iframe 外壳＋会话阶段机在树内，但**按 SCOPE §三-1 冻结**，等 L4 W-05 拆分落地后再进；本线只出协议，不改文件。
- Windows Electron / 安卓：L3 / L6 所有，本线只出协议规范，不改文件。
- nginx（`server/nginx/qfremote-proxy`）：反代配置在树内，但它是部署态文件、改动即影响线上入口；本线不改 nginx——RC-07 的白名单不在 nginx 层做（见 §四），只在应用层做。

**树外、须上游/agent 侧落地的部分（本线只定协议＋出参考实现，不编造已实现）：**
- RC-03：编码器内 FEC 分片生成（agent）、解码端 FEC 还原（各端解码器）、IDR 强制出帧（agent 编码器）。
- RC-09：编码参数切换（agent）、帧堆积检测与丢帧（agent/中继）、RTT/丢包探测执行（各端）。
- RC-10：指令/事件流的实际捕获（上游 `mcrec.js` 钩子或等价埋点）。
- RC-07：中继自身的选路执行仍在客户端按本线宣告列表执行；服务端强制关口在会话建立时（见 §四）。

## 三、逐项：树内可做 / 树外待办

### RC-03 画面链路 FEC＋随时请求关键帧（设计须大肥鱼复核——已复核：不通过，按 §七改后有条件通过）
- 树内做：
  1. 协议定义 `QF-VIDEO-1`：独立轻量控制消息 `idr-request`（与输入流分离，见 REPORT §十一-2 控制与画面分离），字段：`sessionId`、`seq`（每会话单调递增，防重放）、`reason`（`loss`/`join`/`quality-change` 白名单）、`atTs`（仅日志用）；服务端做准入控制（见 `server/ext/idr-core.js`）：会话绑定＋鉴权、令牌桶、合并窗口、硬上限、超限审计——不是纯透传。
  2. FEC 参考实现 `server/ext/fec-ref.js`（纯 JS、无依赖）：**RS over GF(256)**——`k=10,m=2`（开销 20%，任意 2 丢可恢复）；低档 `k=20,m=1`（开销 5%，任意 1 丢）。块边界：每帧一个块，不得跨关键帧；块头字段见 §七-3；尾块零填充并保留真实长度。
  3. FEC 参数协商：`fec.repairPercent = m/k`，随画质档位走（低码率 5 / 高码率 20，抄 Moonlight `SdpGenerator.c` 口径，见 REPORT §九），只在关键帧/块边界切换，块头带 FEC 参数版本。
- 树外待办（agent 侧＋各端解码器）：编码器出 FEC 分片、解码器做还原、收到 `idr-request` 后强制出 IDR。agent 侧实现须另派线（或上游合入），本线不上报为已完成。
- 验收映射：5% 丢包花屏自愈时间——沙箱以参考实现模拟值验收；真机值等 L7 ECS 弱网窗口。

### RC-07 中继选路“服务端宣告白名单＋三级回退”
- 树内做（`server/ext/relay-core.js`）：
  1. 宣告端点：`GET /license/api/relays`（控制台会话鉴权），返回服务端宣告的中继列表：每条 `{ id, url, tier, priority, ttlSec, issuedAt }`；`tier` 1/2/3；列表由 `config.json` 的 `relays` 驱动，未配置时只宣告一条 tier-1：本源 `/console-engine/`（由请求 origin 派生，不写死域名/IP）。
  2. 白名单校验函数 `isAllowedRelay(url, list)`：精确匹配（origin＋路径前缀），非列表地址一律拒绝；供三端客户端在建连前调用（客户端实现由 L3/L4/L6 按规范落地）。
  3. 三级回退选路函数 `pickRelay(list, failedIds, opts)`：按 tier→priority 顺序试，每级并发建连上限（抄 RustDesk `PunchPool` 各限 32 的思路，取每级在途上限 8）、失败记原因、耗尽三级后进降级态（只保留已建会话＋文件暂存通道，不新开桌面会话）；选择结果可审计记一条 `log`（不记敏感信息）。
  4. 阴性测试：伪造非列表中继地址 → `isAllowedRelay` 拒绝；模拟 tier-1 故障 → 选路自动降到 tier-2/3。
- 树外待办：三端客户端按宣告列表执行建连＋回退（L3/L4/L6）；第二/第三级真实中继主机目前不存在——tier-2/3 是策略位＋选路逻辑先行，待有备用中继主机时在 `config.json` 里加一条即生效，不改代码。本线如实上报此点，不把“逻辑就绪”说成“多中继已部署”。
- 不做的事：不在 nginx 层加动态白名单（nginx 只有静态 upstream，动态中继 dial 不在 nginx 层）；不改 MeshCentral `meshrelay.js`（树外）。

### RC-08 文件传输“统一流抽象＋分片”，每次传输记一条审计
- 树内做（`server/ext/transfer-core.js`，复用 `files-core.js` 的暂存/收件箱/清理机制，不重写）：
  1. 统一流接口定义 `QF-STREAM-1`（协议文档，见实现文件头注释＋本设计 §五）：`init`（元数据：文件名/大小/SHA-256/分片大小/目标节点）→ `chunk`（序号/偏移/base64 分片）→ `commit`（齐片校验 SHA-256）→ `resume-query`（缺片列表）→ `download`（支持 `Range`）→ `cancel`；进度回调、取消、断网重连语义三端一致写进规范。
  2. 分片落盘：分片先写临时分片文件，`commit` 时按序拼装＋SHA-256 校验，校验通过才进现有 `file-stage` 暂存（复用 24h 暂存、收件箱、ack、sweep）；校验失败整单作废＋清分片。
  3. 审计：每次传输恰一条审计记录——新追加式审计文件 `transfer-audit.jsonl`（与 `events.json` 审核队列分离；只记元数据：`transferId/username/方向/文件名/大小/对端节点/分片数/结果/起止时间`，不记文件内容），写在 `commit` 成功或终态失败时 exactly-once（以 `transferId` 去重；`init` 不记、`chunk` 不记）。审计查询端点只返回本人记录。
  4. 100MB 行为一致性：分片大小默认 1MB（`GUAC_PROTOCOL_BLOB_MAX_LENGTH 6048` 太小不抄数值，只抄“分片＋流抽象”思路；1MB 是服务端暂存场景的折中，写进规范可配）；沙箱实测 100MB 分片上传/拼装/SHA-256/下载全流程。
- 树外待办：三端客户端按 `QF-STREAM-1` 实现上传/下载 UI 与断点续传（L3/L4/L6）；现有整文件 base64 `/license/api/files/send` 端点保留兼容（老客户端不断），新端点并行。
- 不碰：`files-core.js` 的核心暂存语义只做加法（新增分片拼装入口，不改 `stage/inbox/ack/sweep` 行为）。

### RC-09 画质四档＋弱网自降档＋服务端背压（设计须大肥鱼复核）
- 树内做（`server/ext/quality-core.js`，按 §七复核意见修订版）：
  1. 四档定义 `QF-QUALITY-1`：`smooth / balanced / clear / original`（流畅/均衡/清晰/原画），每档 = 一组编码参数；参数分“热可调”（目标码率、帧率上限、FEC repairPercent，关键帧/块边界切换）与“需重建”（分辨率缩放、编码器偏好，切换触发 IDR、接收端清旧参考帧）；档位只存标志位组合（抄 FreeRDP `performance_flags_make/split` 思路），参数放 `config.json` 可改，不写死枚举；档位表须 schema 校验＋版本＋默认回退＋每会话参数快照，未知档位回退默认档并告警。
  2. 探针与自降档：客户端周期上报 `{ rttMs, lossPct, lossSamples, jitterMs, decodeLagMs, pendingFrames }`（上报周期正常 1s、弱网/切换后 10s 内 500ms、页面隐藏 5s；`lossPct` 须 1s 窗口且 ≥50 包，区分上行/下行）；服务端用 EWMA（α=0.3）＋滑动窗口判定：一般坏 5s 窗口 ≥3 样本且持续 ≥3s 才降档，严重坏连续 2 样本即降档，降档冷却 5s（连续恶化每 3s 最多一档）；网络恢复后**不自动升档**（抄 REPORT §十二-9）；`downgrade-to` 须客户端执行＋ACK（含超时）；手动升档须健康窗口 20s＋一次一档＋10s 观察窗＋乒乓冷却 60s。
  3. 服务端背压：分级 L1 `reduce-fps` → L2 降分辨率/码率 → L3 `drop-to-keyframe`＋受控 IDR（进 RC-03 限流）；决策须服务端独立信号（WS `bufferedAmount`/发送队列高水位）与客户端上报交叉验证，或连续 3 样本异常；客户端自报单字段不直接触发；异常上报降权并记录。
  4. 沙箱测试：探针序列驱动档位机，验证弱网序列下不卡死（档位一路降到 smooth 且会话保持）、四档切换即时（切换调用返回即生效，无重连）。
- 树外待办（agent 侧＋各端）：编码参数真正切换、堆积检测执行、RTT/丢包探测执行；弱网真机值等 L7 ECS 窗口。
- 验收映射：弱网（300ms＋5% 丢包）不卡死不断连——沙箱以档位机＋探针序列验收逻辑，真机等 ECS。

### RC-10 录像做成指令/事件流，三级粒度开关，默认不录
- 树内做（`server/ext/recording-core.js`）：
  1. 录像格式 `.qfrec`（JSONL 事件流，协议定义见实现文件头注释）：`session-start`（会话元数据＋档位＋录制策略）→ 事件（`input` 鼠标/按键、`clipboard`、`frame-marker` 关键帧锚点、`quality-change`）→ `session-end`；不存视频帧（体积目标：10 分钟录像比同等视频小一个量级，沙箱以模拟事件流实测体积比）；回放索引：每 N 秒一个 `seek-index`（事件偏移＋时间戳），支持 seek/变速（回放器由 L4 在 W-05 后做，本线只出索引＋读取 API）。
  2. 三级粒度开关（抄 MeshCentral `mcrec.js` 口径）：`recording.policy` = `off`（默认）/ `user`（指定用户）/ `group`（指定设备组）/ `device`（指定设备），策略放 `config.json`，服务端在会话建立时判定本会话是否录制；默认不录，须双方知情或站长明确授权才开（策略变更记审计）。
  3. 访问控制：录像文件按账号隔离＋策略白名单；读取端点 `GET /license/api/recordings/:id` 须本人（或站长）会话，未授权返回 403 且不泄露存在性（统一 404）；录像含按键与剪贴板即含敏感信息，存储 0600、与“站长也看不见他人屏幕”口径对齐——站长侧查看须走既有审核/授权流程，不另开后门。
  4. 沙箱测试：10 分钟模拟会话事件流体积 vs 同等视频估算（按档位码率算）比值；seek 索引正确性；未授权访问被拒。
- 树外待办：事件流的实际捕获埋点（上游 `mcrec.js` 钩子或 agent 侧事件上报，须另派线）；网页回放器（L4，W-05 后）。
- 不做的事：不做 mp4 转码（REPORT §十二-10：先只做录制＋回放最小闭环，不急着转 mp4）。

## 四、RC-07 补充：为什么白名单不在 nginx / MeshCentral 层做
- nginx 只有静态 upstream，没有“客户端自带中继地址、服务端校验后放行”的语义；伪造中继的攻击面在客户端建连那一步，不在反代层。
- MeshCentral `meshrelay.js` 的配对是 HMAC relay id＋同用户校验（REPORT §三），已在上游；本线补的是 RustDesk 式“服务端宣告可用中继列表、客户端只连列表内”的那一层（REPORT §十一-3），落点是 ext 服务的宣告端点＋客户端建连前校验。

## 五、协议编号（本线新定，三端共用）
- `QF-VIDEO-1`：画面控制消息（含 `idr-request`）与 FEC 分组格式（XOR 校验组，`k=8/n=2` 默认）。
- `QF-RELAY-1`：中继宣告列表格式与三级回退选路算法。
- `QF-STREAM-1`：统一文件流抽象（init/chunk/commit/resume/download/cancel）与审计记录格式。
- `QF-QUALITY-1`：四档画质参数表、探针格式、自降档规则、背压信号。
- `QF-REC-1`：`.qfrec` 事件流格式、三级录制策略、回放索引。

以上协议只含格式与算法，不含任何密钥、grants、签名材料；不涉及 LEA 握手（L1 范围）。

## 七、大肥鱼复核裁决（2026-11-15，shanedit 中转 deepseek-v4-flash）
- 原文存档：`l5-evidence/ds-review-rc03-rc09-20261115.md`（提问原文同目录 `ds-review-prompt-rc03-rc09-20261115.txt`）；提问不含 Key、grants、签名内容。
- **RC-03：不通过 → 按复核改后有条件通过。** 必须改的点已落地到 `server/ext/fec-ref.js` 与 `server/ext/idr-core.js`：
  1. 放弃 XOR `k=8,n=2` 宣称“任意 2 丢可还原”（数学上不成立：`n=2` 时非零校验列只有 3 种，`k≤3` 才能两两不同）。改用 **RS over GF(256)**：`k=10,m=2`（开销 20%，任意 2 丢可恢复）；低档 `k=20,m=1`（开销 5%，任意 1 丢）。
  2. `repairPercent` 定义分母为数据分片数 `k`（`m/k`），档位切换只在关键帧/块边界生效，块头带 FEC 参数版本。
  3. `idr-request` 不再是“格式校验＋透传”：服务端做准入控制——会话绑定＋鉴权、每会话单调 `seq` 防重放、令牌桶（每 session 0.5/s、burst 2；每 agent 2/s、burst 5）、硬上限（每 session 1/s、5/10s）、同 reason 合并窗口（loss 1s、quality-change 2s）、超限返回 `rejected/coalesced` 并记审计、连续超限 10s 冷却＋告警；多观看端同 session 请求合并。
  4. FEC 块边界：**每帧一个块，不得跨关键帧**；块头字段 `blockId/symbolIndex/symbolCount/frameId/frameStart/frameEnd/isKeyframe/symbolLength/lastSymbolPadding/fecVersion`；尾块零填充并保留真实长度；不可恢复时丢弃受影响帧并触发一次受控 `idr-request`（进 IDR 限流）；不可恢复判定用超时窗口 `RTT + jitter + 1 帧`，不一丢即请求。
  5. 验收从“5% 随机丢包”扩展为确定性丢包 trace：均匀 5%、Gilbert-Elliott 突发（平均 5%，burst 1/2/5/10）、关键帧丢、尾块、连续 2 丢、块头丢、乱序、重复；指标：单/双丢恢复率、帧可解码率、idr-request 次数、恢复时间 p50/p95/p99（同时报 ms 与帧数，帧率固定 30fps 换算）。
- **RC-09：有条件通过 → 按复核改后落地。** 必须改的点已落地到 `server/ext/quality-core.js`：
  1. 降档判定改为双阈值＋滑动窗口＋冷却：一般坏（`rtt>300 或 loss>5% 或 jitter>50ms`）5s 窗口内 ≥3 样本且持续 ≥3s 才降档；严重坏（`rtt>800 或 loss>20% 或 decodeLag>500ms`）连续 2 样本即降档；rtt/loss 用 EWMA（α=0.3）；降档冷却 5s（连续恶化时每 3s 最多降一档）。
  2. 探针周期：正常 1s、弱网/切换后 10s 内 500ms、页面隐藏 5s；`lossPct` 须声明统计窗口与最小包数（1s 窗口且 ≥50 包），区分上行/下行丢包。
  3. 背压分级：L1 `reduce-fps` 优先 → L2 降分辨率/码率 → L3 `drop-to-keyframe`＋受控 IDR（进 RC-03 限流）；`drop-to-keyframe` 语义为“丢弃直到关键帧，并可选请求关键帧”。
  4. 手动升档：健康窗口（`rtt<150、loss<1%、jitter<30ms、decodeLag<150ms` 持续 20s）否则拒绝并提示原因；一次只升一档；升档后 10s 观察窗；同一目标档 60s 内 2 次“升档后 10s 内被降回”则该档冷却 60s；升档阈值与降档阈值分离（迟滞）。
  5. `pendingFrames` 客户端自报只作提示：背压决策须服务端独立信号（WS `bufferedAmount`/发送队列高水位/写阻塞）＋客户端上报交叉验证，或连续 3 样本异常；单字段不直接触发降档；异常上报降权并记录。
  6. 档位参数分“热可调”（目标码率、帧率上限、FEC repairPercent，关键帧/块边界切换）与“需重建”（分辨率缩放、编码器偏好，切换触发 IDR、接收端清旧参考帧）；不再宣称“全部即时无感”——热参数下一关键帧边界生效，需重建参数经编码器重配＋IDR 后生效。
  7. `config.json` 档位表须 schema 校验＋版本＋默认回退＋每会话参数快照；未知档位回退默认档并告警；`downgrade-to` 须客户端执行＋ACK（含超时，未 ACK 记日志并重发一次）。
- 真机门禁（L7 ECS 窗口）：300ms RTT＋5% 丢包下不断连、10s 内到 smooth、关键帧请求 ≤1/s 或 5/10s、恢复后不自动升档、无档位乒乓。

## 六、测试与证据口径
- 每项附独立 Node 自检脚本 `server/ext/test-l5-*.js`（零外部依赖，`node <file>`，退出码 0=通过），输出逐项 `ok/FAIL` 行；只报数字不算完成。
- 沙箱可验：协议校验、选路、FEC 模拟、档位机、分片拼装＋SHA-256、审计 exactly-once、录像体积比模拟、访问控制。
- 等 L7/ECS 的：5% 丢包真机自愈时间、弱网真机不断连、四档真机切换、100MB 三端行为一致、录像真机体积比。报告里逐项写明“沙箱已验 / 等 ECS”，不把模拟值说成真机值。
