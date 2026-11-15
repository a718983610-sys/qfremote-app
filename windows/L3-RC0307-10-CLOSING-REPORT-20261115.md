# L3 收尾报告：Windows 端 RC-03/07/08/09/10 客户端实现（2026-11-15）

结论先行：五项协议的 Windows 客户端层全部实现并测试通过，6 个新测试文件 249 个用例全绿；全量回归 PASS=42 FAIL=3 SKIP=3（基线 36/3/3，新增 6 项全过，FAIL 仍为 3 个预存项，无回归）。未提交、未推送、未部署、未动 release.json。

工作树：`~/workspace/qfremote/work-recovery241`，分支 `lea-local-agent`。
规范依据：`server/ext/` 下 QF-VIDEO-1、QF-RELAY-1、QF-STREAM-1、QF-QUALITY-1、QF-REC-1 五份 CLIENT-SPEC（末尾“各端待实现清单”＋“与实现有出入处”一节），服务端实现原文已逐份核对（`fec-ref.js`、`idr-core.js`、`relay-core.js`、`transfer-core.js`、`quality-core.js`、`recording-core.js` 及 `server.js` 路由 2753–2930 行），出入处以实现为准。

## 1. 实现内容（按规范条款）

### 1.1 RC-03 画面传输：FEC 解码端＋IDR 发送

新模块 `windows/qf-fec.js`、`windows/qf-idr.js`。

- **FEC（QF-VIDEO-1 §3）**：GF(256) RS 编解码（poly 0x11d，生成元 2，Vandermonde 校验行 `(j+1)^i`），与服务端 `fec-ref.js` 逐字节对拍通过（双向编解码互通）；块头 12 字段，7 类非法拒绝；只许两档 `k=10/m=2`（高保护）与 `k=20/m=1`（低保护）；`fecTierForRepairPercent`：≤5%→low、≥20%→high，10%/15% 返回 `{ok:false, reason:'fec-repair-unmapped'}`（不发明第三档）；`minInterleaveDepth(burstLen)=ceil(burstLen/2)`；块组装器：0 缺失直接成帧；缺片等超时窗口（RTT+jitter+帧时长）后再判；窗口届满缺片≤m 且校验行够则还原，否则丢弃并经 `onUnrecoverable` 恰好回调一次；块头非法整块丢弃；同 blockId 不同 frameId 丢弃；半帧不上屏；档位切换须新建组装器。
- **IDR（QF-VIDEO-1 §4）**：`POST /license/api/session/idr-request`；seq 每会话从 1 单调递增，每发一次消费一个（放行/合并/拒绝都消费）；三 reason（loss/join/quality-change）；join 只发一次；本地同 reason 合并窗口（loss 1s、quality-change 2s、join 1s）内短路；COOLDOWN 响应记本地 `cooldownUntil`（以 retryAfterMs 为准），冷却期内不发网络；REPLAY 不原样重发（下次触发用新 seq）；NO_SESSION/NOT_BOUND/BAD_REASON 不可重试；coalesced/rejected 不补发、不换 reason、不向 UI 报错（只记诊断日志）。
- **缺口（诚实边界）**：块头无线上传输打包格式规范未定——本模块不发明二进制打包格式；服务端“转发给 agent 强制出 IDR”通道未实现，`forward` 只表示服务端允许，不得假设 agent 已收到。

### 1.2 RC-07 中继：宣告列表＋三级回退

新模块 `windows/qf-relay.js`。

- **与服务端同款逻辑（QF-RELAY-1 §3–§5，`relay-core.js` 对拍）**：`normalizeUrl`/`isAllowedRelay`/`pickRelay`/`cleanRelayList`（tier 1–3、排序 tier 升序→priority 降序→id 字典序、上限 32、ttlSec 默认 600）。
- **`createRelaySelector`**：`GET /license/api/relays` 取表，过期判定取列表内最小 ttlSec（最保守）；空列表/请求失败不建连、不用硬编码兜底；在途上限每级默认 8（满了跳过该级、不算失败、不进 failedIds）；`checkDialUrl` 伪造拒绝（不拨号、不进 failedIds、只记 URL 与时间一条日志、提示“该中继不在服务端宣告列表内，已拒绝连接”）；`selectRelay(dialFn)` 回退循环；`retry()` 显式重试（清空 failedIds、重取列表，不自动循环）；`getUiState()` 降级态快照（文案“中继全部不可用，已保留现有会话”，canRetry/canStartNewSession，不宣称已部署多级中继）。
- **缺口**：tier-2/3 真实中继主机目前不存在；无“上报中继故障”服务端端点（失败跟踪、在途计数、回退全在客户端本地）；宣告列表无健康度/延迟字段。

### 1.3 RC-08 文件流：传输＋断点续传

新模块 `windows/qf-transfer.js`。

- **（QF-STREAM-1 §3–§6）**：`sha256Hex`、分片期望长度、Range 头构造与 Content-Range 解析；`startUpload`（本地先校验，init 后**用服务端返回的 chunkSize 切分**）、`uploadChunk`（长度/空/越界本地拒绝）、`uploadBuffer`（顺序传，跳过已收分片）、`queryMissing`（`GET …/missing` 断点续传，**不发任何 /resume 请求**）、`resumeUpload`、`commit`（INCOMPLETE 唯一可继续；CORRUPT/IO 整单作废、transferId 不能再用、`needReinit:true`）、`completeUpload`（INCOMPLETE 最多再补两轮）、`cancel`（仅 uploading/interrupted 态；committing 态禁取消与重复提交；staged 后无取消端点）、`listInbox`/`listSent`/`ackFile`/`listAudit`（limit 钳制 1..200，默认 50）、`downloadResumable`（走注入的 `requestRaw` 回原始字节；206 按区间拼装并校验 Content-Range；200 按全文件处理——非法 Range 回落时丢弃前缀返回整文件；404 过期）、`isFileExpired`、`getUiState()`（CORRUPT 文案“校验失败，须重新发送”，`canRetryCommit:false`，无“重试提交”）。
- **模块边界**：只处理协议与状态机——上传入参是内存 Buffer（磁盘读取由调用方负责），下载出参是 Buffer（落盘由调用方负责）。
- **缺口**：无字面 `/resume` 端点（断点续传＝`GET …/missing`）；commit 失败后整单作废，不可修好再 commit；渲染层文件传输 UI 入口尚未接（见 §4）。

### 1.4 RC-09 画质：探针＋档位执行＋ACK

新模块 `windows/qf-quality.js`。

- **（QF-QUALITY-1 §3–§7）**：档位表 verbatim（smooth 800/15/5%/0.5x/h264；balanced 2500/30/10%/0.75x/h264 默认档；clear 5000/30/15%/1.0x/h264；original 12000/60/20%/1.0x/hevc）、`splitTierChange`（与服务端同款）、阈值 BAD/SEVERE/HEALTHY、`validateProbe`（缺 rttMs/lossPct/jitterMs 任一不发；值域外或 lossSamples<50 仍发但记降权；lossPct 只报观看端下行，不取平均）、探针周期（正常 1s、弱网/切换后 10s 内 500ms、隐藏 5s；尚未探针时按正常 1s，不假定弱网）、`submitProbe`（POST /license/api/session/probe）、`executeDecision`（hot 先行、reconfig 其后、needsIdr 时经 idrSender 发 quality-change IDR＋清旧参考帧、执行后 5s 内 ACK；执行失败保持旧档位、**不伪造 ACK**；新决策到达先把旧决策 ACK 发掉）、`sendAck`（UNKNOWN_DECISION 不再重试同一 id；ACK 超时本地只记 `quality-ack-timeout` 日志、不重发）、`requestUpgrade`（AT_TOP/NO_HEALTH_WINDOW/NOT_HEALTHY/PINGPONG_COOLDOWN＋retryAfterMs 映射）、`executeBackpressure`（L1 reduce-fps、L2 按下一档 resolutionScale/targetKbps、L3 drop-to-keyframe＋受控 IDR reason=loss；level null 的 hint-only 不擅自降档；背压无 decisionId、不 ACK）、`startProbing(measureFn)`/`stopProbing`/`setHidden`/`canRequestUpgrade`。档位切换不重连会话。
- **测试中发现并修复的真 bug（§3.2）**：submitProbe 曾先采纳服务端降档后的 tier，执行失败后档位回不去——现改为有决策时先复位到 `decision.from` 再执行。
- **缺口**：fecRepairPercent 10%/15% 在 FEC 层无对应档位（中间值映射待定，记日志、保持当前 FEC 档位）；EWMA 只作遥测、判定用原始样本；`serverSignal` 由客户端随探针上传（服务端无实测来源）；值域外探针仍入库（只有缺必填才 probe-incomplete 不入库）。

### 1.5 RC-10 录像：事件流客户端

新模块 `windows/qf-recording.js`。

- **（QF-REC-1 §3–§6）**：`sanitizeEvent`（与服务端同款白名单；clipboard 只记 bytes，`content` 字段丢弃；key 截断 32 字符；kind 非法值按 mouse 计）；`start`（POLICY_OFF 时不录制、不发事件，UI 提示“当前会话不录制”）、`reportEvent`（只发 input/clipboard/frame-marker/quality-change 四种；session-start/session-end/seek-index 本地拒绝不发请求；at 须单调递增，倒序事件本地丢弃不发请求）、`end`（返回 index）、`restartAfterInterrupt`（新录制、新 sessionId 由服务端生成 rec_…，不复用旧 id）、`list`/`getIndex`/`download`（404 时统一文案“录像不存在或无权限查看”，不区分解读、不反复重试；下载整文件、**永不发 Range 请求**）、回放器纯函数 `parseQfrec`（半行不播）、`seekAnchor`（取 t≤T 最后锚点）、`playbackDelayMs`（变速缩放）。
- **服务端出入（以实现为准）**：`/event` 与 `/end` 路由现已先调 `canAccess` 再读写（代码注释“鉴权补齐（2026-11-15）”），无权限与不存在同一 HTTP 404——规范 QF-REC-1 §6.1 称这两条路由“没有按用户鉴权”是旧口径；客户端已按 404 统一处理（interrupted 分支）。
- **缺口（诚实边界）**：事件实际捕获埋点（mcrec.js 钩子）未实现——本模块只做协议就绪部分，不捕获真实输入/剪贴板/关键帧，**不得宣称已实现真机录像**；录制会话只存服务端内存，重启后须提示中断并重开（新 sessionId）。

### 1.6 聚合层与 main.js 接线

新模块 `windows/qf-protocol.js`：共用 transport（extRequest JSON＋extRequestRaw 原始字节）与日志；交叉接线（quality 档位决策的 IDR 走 idrSender；档位变化时向 recording 上报 quality-change 事件，录制进行中才发、best-effort）；`bindSession({sessionId, agentId})` 只登记（不自动启动探针、不自动开始录制）；`unbindSession(reason)` 停探针、best-effort 尝试结束录制、清绑定。sessionId 取票据会话 id（sess-…，登录时生成）；agentId 取当前远程会话被控端节点 id（openSession 的 sessionCtx.nodeId）。

main.js 接线（只改 main.js，不碰 installer.nsi / lea / server / android）：
- `require('./qf-protocol')`（reconnect-ticket 之后）；
- 新增 `extRequestRaw`（与 extRequest 同款 host/cookie 守卫，https only、白名单主机、附控制台会话 cookie，8 秒超时、无重试，返回 `{status, headers, body: Buffer}`，供文件/录像下载用）；
- reconnectTicketStore 创建处附近创建 `qfProtocol`（`createQfProtocolClients({request: extRequest 包装, requestRaw: extRequestRaw 包装, baseUrl: CONSOLE_URL, log: bootLog})`），创建时不发网络、不启动定时器；
- `openSession` 内 sessionCtx 赋值后调 `qfProtocol.bindSession(...)`（无 sessionId 时跳过并记 bootLog，不阻塞开会话）；
- `closeSession` 内调 `qfProtocol.unbindSession('session-close')`；`handleManualLogout` 内 reconnectTicketStore.stopSession 之后调 `qfProtocol.unbindSession('logout')`。
- `package.json` 的 build.files 加 7 个新模块；`tools/check-electron-safety.js` 的 isMainSide 白名单加 7 个新模块（`node tools/check-electron-safety.js`：PASS，0 violations）。

**未新增 IPC 通道**（会动 ipc-sender-test 计数；渲染层文件传输/探针触发入口是后续 UI 工作，模块已就绪，见 §4 缺口）。

## 2. 测试证据

### 2.1 新增测试（6 个文件，249 个用例，全绿）

| 测试文件 | 用例数 | 覆盖要点 |
|---|---|---|
| `windows/test/rc03-video-test.js` | 58 | RS 与服务端 fec-ref.js 双向对拍（双丢恢复、超 m 不可恢复、校验行不足不可恢复、尾分片裁剪）；块头 7 类非法；fecRepairPercent 映射；块组装器（0 缺失成帧、窗口内迟到恢复、窗口届满还原、3 丢不可恢复恰好一次回调、块头非法丢弃、同块不同帧丢弃、重复分片、交织深度下限、非法档位抛错）；IDR（seq 单调、coalesced 不补发、COOLDOWN 本地短路＋retryAfterMs、REPLAY 不原样重发、NO_SESSION/NOT_BOUND 不重试、BAD_REASON、网络失败可再试、join 只发一次、quality-change 2s 合并窗口、无会话不发请求、503、bind 重置 seq）；静态接线 F 组（main.js 含 qf-protocol 创建＋绑定/解绑、package.json 打包清单、构建检查 0 违规） |
| `windows/test/rc07-relay-test.js` | 39 | isAllowedRelay/pickRelay 与服务端对拍（伪造、同 origin 不同路径、非 http、空列表；排序、失败跳过、在途满跳过、两种降级原因）；宣告列表获取与缓存（过期重取、空列表、网络失败、L5_UNAVAILABLE、无效条目清洗）；伪造拒绝（不拨号、不进 failedIds、只记 URL、继续选下一条）；三级回退循环（首选失败→次选成功、在途计数增减、全部失败进降级态、retry 清空重取）；降级态 UI 快照 |
| `windows/test/rc08-transfer-test.js` | 47 | 内存假服务端（按 transfer-core.js 同款规则）；SHA-256 已知向量与服务端返回 chunkSize 为准（请求 8MB 被钳制到 4MB）；init 本地校验 5 项且不合格不发请求；chunk 上传（长度不符/空/越界本地拒绝、乱序可达、重复覆盖计数不变）；断点续传（missing 查缺片、只补缺片、全程断言无 /resume 请求）；commit（INCOMPLETE 补传再成功、CORRUPT 整单作废＋重新 init 新单、commit 提交中禁取消与重复提交——50ms 延迟假请求测并发）；cancel（仅 uploading 态、staged 后拒绝）；下载（整文件、Range 206 续传、非法 Range 回落 200 全文件、404、下载用 stagedId）；inbox/sent/ack/audit（limit 钳制 200/50）；UI 状态机快照 |
| `windows/test/rc09-quality-test.js` | 44 | 假服务端直接用服务端 `quality-core.js` 原模块；档位表与 splitTierChange 与服务端一致；探针校验（缺必填不发、lossSamples<50 仍发＋降权、值域外仍发＋降权、lossPct 原样、无密钥字段）；探针周期；降档端到端（严重坏连续 2 样本降档；hot 先行、reconfig 其后、IDR＋清旧参考帧、5s 内 ACK；fec 10% 待定保持 high；再降到 smooth 时 fec 5% 映射为 low；smooth 不再降）；执行失败不伪造 ACK（reconfig 拒绝时旧档位保持、0 次 ACK）；ACK 超时（ACK 请求抛错→待 ACK 保留→可控定时器推进→只记日志、不重发；UNKNOWN_DECISION 不再重试）；手动升档（5 健康样本 20s 窗口升档成功、升到 original、AT_TOP、NO_HEALTH_WINDOW、NOT_HEALTHY、PINGPONG_COOLDOWN 桩响应映射、未探针先升档 NOT_FOUND）；背压（hint-only 不动作、连续 3 样本堆积 L1、服务端队列高＋堆积 L2、frameCorrupt＋队列高 L3＋IDR loss）；探针定时发送（可控定时器首 tick 1000ms、隐藏 5s、升档入口提示）与 stopProbing |
| `windows/test/rc10-recording-test.js` | 45 | 假服务端用服务端 `recording-core.js` 原模块＋临时目录；白名单清洗；start（POLICY_OFF、策略命中、服务端生成 rec_ id）；reportEvent（四种事件外本地拒绝、at 单调、剪贴板内容永不外发）；end（返回 index、二次 end 拒绝）；服务端重启中断（同目录新 core 实例模拟内存丢失：旧 sessionId 发事件 → NOT_FOUND；客户端 interrupted 分支＋提示＋restartAfterInterrupt 新 rec_ id）；list/index/download（他人录像同一 404、下载无 Range 头）；回放器纯函数；UI 快照 |
| `windows/test/rc-protocol-test.js` | 16 | 聚合层：bind 参数校验与回显、idr/quality 绑定；探针触发降档 → IDR（reason=quality-change）＋录制 quality-change 事件；unbind 停探针、尝试结束录制、清绑定；transfer/relay 初始态 |

单跑命令与结果（工作树 `windows/` 下，2026-11-15 沙箱实测）：
```
$ node test/rc03-video-test.js     → {"pass":true,"failed":[]}
$ node test/rc07-relay-test.js     → {"pass":true,"failed":[]}
$ node test/rc08-transfer-test.js  → {"pass":true,"failed":[]}
$ node test/rc09-quality-test.js   → {"pass":true,"failed":[]}
$ node test/rc10-recording-test.js → {"pass":true,"failed":[]}
$ node test/rc-protocol-test.js    → {"pass":true,"failed":[]}
$ node tools/check-electron-safety.js → check-electron-safety: PASS (0 violations, ...)
$ node --check main.js qf-fec.js qf-idr.js qf-relay.js qf-transfer.js qf-quality.js qf-recording.js qf-protocol.js → 全部通过
```

### 2.2 全量回归

```
$ node test/run-all.js
windows tests: PASS=42 FAIL=3 SKIP=3
```
对照 RC-04 收尾报告基线 PASS=36 FAIL=3 SKIP=3：**新增 6 项全过（+6），FAIL 仍为 3 个预存项（agent-heal-test 不稳定、devices-test E4/J6、license-test），SKIP 仍为 3 项（autologin-page-test、watchdog-test 需 Electron；logout-test 缺 console-skin/custom.js），无回归**。

说明：第一轮全量曾出现 PASS=41 FAIL=4（多出 update-chain-200-test.js），该测试不依赖 main.js（只 require `../update`＋本地 http 服务），单跑通过、后两轮全量＋单跑均通过，判定为套件内偶发（端口/时序），非本线改动所致；最终一轮落盘 `/tmp/run-all-final.txt` 为 PASS=42 FAIL=3 SKIP=3。

### 2.3 服务端侧（L5 自检，未动 server/，仅复核）

L5 服务端自检脚本本轮开工时已跑过、全部通过：test-l5-fec 27 项、test-l5-idr 18 项、test-l5-relay 16 项、test-l5-quality 26 项、test-l5-transfer 37 项、test-l5-recording 39 项。

## 3. 测试中发现并修复的问题

1. **真 bug——qf-quality.js 档位回滚失效（E2 回归已覆盖）**：submitProbe 曾无条件采纳服务端响应里的降档后 tier，executeDecision 执行失败时档位已变成新档、回不去旧档。已改为：有决策时先把 tier 复位到 `decision.from` 再执行，执行成功才置 `to`。测试 E2（reconfig 拒绝时旧档位保持、0 次 ACK）现通过。
2. **真 bug——qf-protocol.js unbind 竞态（C5 回归已覆盖）**：unbindSession 曾同步调 `recording.unbind()`（state='idle'），随后异步 `end()` 回写 state='ended' 把 idle 覆盖掉。已改为：录制中时等 `end()` 落定后再 unbind。
3. **测试用例错（非实现错，均已修正并注明）**：
   - rc03 A2：丢 2 数据＋1 校验只剩 1 行校验，2 个未知数本就不可恢复——改为只丢 2 数据片；
   - rc08 G5：404 探测用的另一个 fs_ id 不含 stagedId，`every()` 断言错——改为断言全部含 fs_、全不含 /tf_；
   - rc09 D9：服务端 severeStreak 在降档后不清零，下一严重样本（距上次降档 4s ≥ 3s 最小间隔）即再次降档——改为第一个探针即断言降到 smooth；
   - rc10 D3：end() 曾先判 `!sessionId`、后判 `already-ended`，二次 end 返回 kind 不对——实现改为先判 ended；
   - rc10 F2：bob 不在 users 列表里时策略为 POLICY_OFF、建不出录像——改为经 users 含 bob 的另一 core 实例建他人录像；
   - rc10 E 组：清理了写乱的死代码（client4–client7 无效赋值与 `void` 占位），只保留路由级 NOT_FOUND 验证（E1）与客户端 interrupted 桩验证（E2–E5）。

## 4. 缺口与后续工作（不在本线范围内）

1. **渲染层入口未接**：未新增 IPC 通道；文件传输 UI、探针触发入口（测量值须会话层显式传入 `startProbing(measureFn)`）、录像事件捕获埋点（mcrec.js 钩子）、录制开始/结束按钮，均待后续 UI 线接。模块已就绪，调用方式见各模块文件头与 `qf-protocol.js`。
2. **线上传输打包格式未定**：FEC 块头无线上传输的二进制打包格式规范未定，客户端不发明格式；待规范补齐后接。
3. **agent 转发 IDR 通道未实现**：服务端 forward ≠ agent 已收到，强制出 IDR 的通道待服务端/ agent 线。
4. **tier-2/3 中继主机不存在**：回退逻辑已就绪，真实主机待部署后验。
5. **fecRepairPercent 10%/15% 映射待定**：FEC 层无对应档位，现记日志、保持当前档位；待定夺。
6. **录像捕获埋点未实现**：不得宣称已实现真机录像；mcrec.js 钩子待后续线。

## 5. 待真机验清单（等 L7 安排，沙箱无法验）

- 5% 丢包自愈（FEC 高保护档真实丢包下画面恢复、无半帧上屏）；
- 弱网不断连（探针周期 500ms 切换、背压 L1–L3 真实触发、档位降档不重连会话）；
- 四档切换（smooth/balanced/clear/original 真实切换＋IDR＋ACK 全链路）；
- 100MB 传输（init/chunk/commit 全流程、断点续传、CORRUPT 整单作废重发）；
- 录像体积比（沙箱值 43.2x 为假服务端推算，**非真机值**，真机须实测）；
- 中继三级回退（须 tier-2/3 真实主机部署后）；
- Electron 真机：qfProtocol 绑定/解绑随 openSession/closeSession/登出实际走通（沙箱只验了静态接线＋聚合层假请求）。

## 6. 改动文件清单（本线）

新增（7 个模块＋6 个测试）：
- `windows/qf-fec.js`、`windows/qf-idr.js`、`windows/qf-relay.js`、`windows/qf-transfer.js`、`windows/qf-quality.js`、`windows/qf-recording.js`、`windows/qf-protocol.js`
- `windows/test/rc03-video-test.js`、`windows/test/rc07-relay-test.js`、`windows/test/rc08-transfer-test.js`、`windows/test/rc09-quality-test.js`、`windows/test/rc10-recording-test.js`、`windows/test/rc-protocol-test.js`

修改（3 个）：
- `windows/main.js`（require＋extRequestRaw＋qfProtocol 创建＋openSession 绑定＋closeSession/登出解绑；**注：该文件工作树内另有他线未提交 WIP，本线改动为上述 5 处 hunk，可经 `git diff -- windows/main.js | grep qfProtocol` 核对**）
- `windows/package.json`（build.files 加 7 模块；该文件亦含他线改动，本线为 qf-*.js 7 行）
- `windows/tools/check-electron-safety.js`（isMainSide 白名单加 7 模块；该文件本身为未提交新文件）

未碰：`windows/installer.nsi`、`windows/lea/*`、`server/*`、`android-app/*`、`release.json`；未提交、未推送、未部署；未碰 QQGame 四 PID；未重启整机；未碰 MeshCentral 服务；无权限类事项。

本报告：`windows/L3-RC0307-10-CLOSING-REPORT-20261115.md`。
