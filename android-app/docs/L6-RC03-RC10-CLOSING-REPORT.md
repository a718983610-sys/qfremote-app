# L6 后续：安卓端 RC-03/07/08/09/10 客户端实现 — 收尾报告

- 工作树：`~/workspace/qfremote/work-recovery241`，分支 `lea-local-agent`
- 日期：2026-11-15；规范：`server/ext/QF-VIDEO-1 / QF-RELAY-1 / QF-STREAM-1 / QF-QUALITY-1 / QF-REC-1-CLIENT-SPEC.md`（v1）
- 纪律：只改 `android-app/*`，不碰 `server/*`、`windows/*`；**不提交、不推送、不部署、不翻 release.json**；未碰 QQGame PID、未重启整机、未碰 MeshCentral；无权限类事项。

## 一、每项实现内容与对应规范条款

### RC-03 — `lib/data/session/fec_decoder.dart`、`idr_client.dart`
- FEC 还原（QF-VIDEO-1 §1）：GF(256) 0x11d／生成元 2／Vandermonde 校验行 `(j+1)^i`，与 `server/ext/fec-ref.js` 同款编解码；只定 k=10/m=2（20%）与 k=20/m=1（5%）两档；块头 12 字段校验（服务端口径）＋档位受支持判定（服务端接受 k=10/m=1 等宽松组合，但客户端判不受支持、拒绝解码，§4.1）；尾分片零填充、按 `lastSymbolPadding` 裁剪；交织深度下限 `ceil(burstLen/m)`（突发 5→G≥3、突发 10→G≥5，m=2）；收包归位、丢包靠 `symbolIndex` 缺口判定；**超时窗口 `RTT+jitter+1 帧` 届满才判不可恢复，不一丢即请求**（§3.3）。
- IDR 发送（§2/§3.5–6）：`POST /license/api/session/idr-request`；seq 从 1 单调递增、每次消费 1 个（合并也消费）；三 reason（loss/join/quality-change）＋合并窗口（1s/1s/2s）；coalesced/rejected 不补发、不换 reason 重发、UI 不报错；REPLAY 用新 seq 重试一次；同一 sessionId 只许一个 `IdrRequester` 实例（多观看端须共用计数器，否则互相顶掉）。
- 本轮实测抓到的真缺陷并已修：块解码成功后迟到的冗余校验片会重开一个待解块、误判 unrecoverable；已修为已完成块 id 集合，迟到片直接忽略（测试覆盖）。

### RC-07 — `lib/data/session/relay_selector.dart`
- 宣告列表（QF-RELAY-1 §1）：`GET /license/api/relays`；解析去重（同 id 留第一条）、上限 32、排序 tier 升序→priority 降序→id 字典序；过期 `issuedAt + ttlSec*1000`，过期重取。
- 三级回退（§2）：本地 `pickRelay` 与服务端同款；在途上限 8/级，满则跳过该级、不算失败；失败 id 进 `failedIds`、同一会话不再试；耗尽进降级态（只保留已建会话＋文件暂存通道，不新开桌面会话，UI 显示“中继全部不可用，已保留现有会话”＋手动重试入口，不得无间隔自动循环重试）；列表为空或取失败时不建连、不硬编码兜底；退后台清在途计数。
- 伪造中继（§3）：建连前必校验 `isAllowedRelay`（origin 相等＋路径前缀；空列表拒绝；非 http(s) 拒绝）；伪造地址拒绝拨号、界面提示“该中继不在服务端宣告列表内，已拒绝连接”、日志只记 URL 与时间、不进 `failedIds`、继续选下一条。

### RC-08 — `lib/data/session/stream_transfer.dart`
- 全端点（QF-STREAM-1 §2）：init / chunk / missing / commit / cancel / inbox / sent / ack / audit / download；默认 1MB、钳制 64KB～4MB，**用服务端返回的 chunkSize 切分**；本地 SHA-256（64 位小写 hex）；文件名清洗（截断 200、`/` `\`→`_`、空为 `file`）；init 客户端侧校验（VALIDATION/TOO_LARGE）。
- 断点续传（§2.3/§4）：无字面 `/resume` 端点，断点续传＝`GET …/missing`，只补缺片、不从头重传；乱序/重发同一 index 允许。
- commit（§2.4）：INCOMPLETE 回 uploading 补传；CORRUPT 整单作废、transferId 不能再用、须重新 init（UI 显示“校验失败，须重新发送”，不显示“重试提交”）；cancel 只在 uploading 态，commit 提交中禁取消与重复提交。
- 下载（§2.6）：Range 206 区间与 200 全文件回落须区分（非法 Range 服务端回落 200、不返 416，收到 200 按全文件处理、不得拼装）；用 `stagedId`（fs_…）下载，不用 `transferId`。
- 审计（§3）：`chunks`＝totalChunks；只记元数据，不记文件内容。

### RC-09 — `lib/data/session/quality_client.dart`
- 档位表（QF-QUALITY-1 §1）：与服务端 `DEFAULT_TIER_TABLE` 一字一致（smooth 800/15/5%/0.5/h264；balanced 2500/30/10%/0.75/h264；clear 5000/30/15%/1.0/h264；original 12000/60/20%/1.0/hevc）；hot（targetKbps/maxFps/fecRepairPercent）与 reconfig（resolutionScale/encoderPreference）拆分；未知档位回退 balanced。
- 探针（§2）：`POST /license/api/session/probe`；缺必填字段本地判 probe-incomplete、不发网；值域外记降权日志；`lossSamples<50` 降权；`lossPct` 指观看端下行丢包，不取上下行平均；周期正常 1s／弱网或档位切换后 10s 内 500ms／隐藏 5s。
- 决策与 ACK（§4）：先 hot 后 reconfig；`needsIdr` 时发 IDR（reason=quality-change）并清旧参考帧；ACK 须在 `mustAckByMs`（＋5000ms）前到达；**超时只记日志不重发**（§6.4）；UNKNOWN_DECISION 不重试同一 id；收到新决策前先把旧决策 ACK 发掉；执行失败不伪造 ACK、保持旧档位、记本地日志。
- 手动升档（§4.2）：拒绝码 AT_TOP / NO_HEALTH_WINDOW / NOT_HEALTHY / PINGPONG_COOLDOWN（带 retryAfterMs）＋中文文案；网络恢复不自动升档。
- 背压（§5）：L1 reduce-fps → L2 reduce-resolution-bitrate → L3 drop-to-keyframe＋受控 IDR（reason=loss）；hint-only（仅客户端自报）不触发、不擅自降档；背压无 decisionId、不须 ACK。

### RC-10 — `lib/data/session/recording_client.dart`
- 端点（QF-REC-1 §2）：start / event / end / list / index / download；start 不传可猜的自定义 sessionId（按规范示例传桌面会话 id 关联，返回的 sessionId 为准继续走 event/end）。
- 事件（§1.1）：只发 input / clipboard / frame-marker / quality-change；session-start/end 由服务端写，客户端构造不出来；非法 kind 按 mouse 计；key 只记按键名、截断 32；**剪贴板只记 bytes，类型里根本没有 content 字段**；from/to 各截断 32。
- 控制（§2/§7）：POLICY_OFF 时不录制、不发事件；at 单调递增、倒序丢弃不发；退后台暂停上报、恢复后按 at 续发；服务端重启 NOT_FOUND 时提示“录制已中断（服务端重启），本次录像不完整”并重开新录制（新 sessionId），不得静默丢事件。
- 回放（§5）：先 index 后整文件 download（**不支持 Range**）；seek 取 `t≤T` 的最后锚点、从 byteOffset 起读（含重建索引首锚点在起点的差异）；边下边播只播完整行、不播半行；变速 0.5x/1x/2x；隐私提示“本录像含操作记录”，不提供导出剪贴板内容。
- 访问控制（§4）：只认本人，**站长无直通**；404 显示“录像不存在或无权限查看”，不泄露存在性、不反复重试；保留期 30 天。

## 二、旧文件关系（未改旧文件、未改旧测试）
- `file_transfer.dart`（64 KiB Guacamole 口径）与 `stream_transfer.dart`（QF-STREAM-1 1MB 口径）并存，不得混用 chunkSize。
- `quality_tiers.dart`（本地 2 次变差降档、balanced 2000kbps/24fps 近似）与 `quality_client.dart`（服务端判定为准、balanced 2500kbps/30fps）并存；服务端决策到达时以服务端为准。
- `session_recording.dart` 的旧回放授权 helper 允许站长打开他人录像，与 QF-REC-1 §4.1 冲突——服务端录像访问判定一律用 `canAccessRecording`（只认本人），旧 helper 不得用于服务端录像。（2026-11-15 C-04 批注：该 helper 已按裁决删除，见 `FIX-C04.md`；本句保留为当时记录。）以上三点已写入 `android-app/docs/RC-ANDROID-NOTES.md` 新增一节。

## 三、测试证据（只报数字不算完成，附命令输出）
- 新增测试 `android-app/test/data/session/rc03_rc07_rc08_rc09_rc10_test.dart`：**37 项，全部通过**（`All tests passed!`）。
  - RC-03：GF 对拍（k=10/m=2 单丢＋双丢恢复、3 丢不可恢复、校验行不足不可恢复）、k=20/m=1 单丢恢复／双丢不可恢复／尾片裁剪、块头 7 类非法、fecRepairPercent 映射、交织深度、收包归位＋超时窗口。
  - IDR：seq 单调、coalesced/COOLDOWN/NO_SESSION、REPLAY 新 seq 重试、reason 线值与合并窗口。
  - RC-07：宣告排序/去重/无效跳过、白名单 5 类阴性、回退/在途满/耗尽、伪造拒绝、过期/退后台/重试。
  - RC-08：100MB 按 1MB 切 100 片、SHA-256 已知向量（abc→ba7816…）、断点续传只补缺片、INCOMPLETE 补传、CORRUPT 作废重 init、取消态、Range 206/200 回落、审计模型。
  - RC-09：档位表数值、探针校验/周期、降档执行＋IDR＋ACK、ACK 超时/UNKNOWN、升档拒绝码、执行失败不伪造 ACK、背压 L1/L2/L3 与 hint-only。
  - RC-10：事件清洗、POLICY_OFF、at 单调/退后台、NOT_FOUND 重开、seek、回放完整行/变速、访问控制。
- 全量：`flutter test` **499 通过**（原 462＋新增 37），`All tests passed!`，exit 0。
- `flutter analyze`：新文件 0 问题；全仓仅剩 2 条既有 info（`test/ui/win_android_fix_test.dart` 的 deprecated `alpha`，非本次文件，改动前已存在）。
- 构建命令：Flutter 3.47.x（`/home/hatch/tools/flutter-3.47.8/bin/flutter`），GRADLE_OPTS=-Djava.net.preferIPv4Stack=true。
- 服务端 L5 自检脚本复跑（交叉证据，node）：fec 27、idr 18、relay 16、transfer 37、quality 26、recording **39**，全部 0 失败。注意：recording 实测 39 项，与规范 §8 写的 28 项不符，以实测为准。
- 新增文件（git 可见，未提交）：`lib/data/session/fec_decoder.dart`、`idr_client.dart`、`relay_selector.dart`、`stream_transfer.dart`、`quality_client.dart`、`recording_client.dart`；`test/data/session/rc03_rc07_rc08_rc09_rc10_test.dart`；文档更新 `android-app/docs/RC-ANDROID-NOTES.md`。

## 四、缺口与未实现（只做客户端能做的部分，不得宣称已实现）
1. RC-03：块头无线上传输二进制打包格式未定义（QF-VIDEO-1 §1.3 未定项，待 agent 线定版补规范 v2）——本轮只实现逻辑块头＋还原，不发明打包格式；服务端“转发给 agent 强制出 IDR”通道未实现（§4.3），`forward` 只表示服务端允许；交织深度 G 的约定值待 agent 线定版；纯 Dart FEC 是与 fec-ref.js 对拍的参考实现，大帧解码上生产路径前须走原生（规范要求性能敏感处走原生）。
2. RC-07：tier-2/3 真实中继主机不存在（QF-RELAY-1 §4.1），选路逻辑先行；不得在 UI 宣称“已部署多级中继”；无“上报中继故障”服务端端点。
3. RC-08：无字面 `/resume` 端点（已按 `missing` 实现）；commit 成功后无取消端点；100MB 端到端为沙箱假通道值，服务端自检 100MB 耗时 2011ms 为服务端沙箱值。
4. RC-09：fecRepairPercent 10%/15%（balanced/clear）映射待定（QF-QUALITY-1 §6.1），中间值返回 null、保持当前 FEC 档位，不得发明第三种 (k,m)；`serverSignal` 无服务端实测来源，观测不到时省略、不得编造；ACK 超时不重发（§6.4）。
5. RC-10：事件实际捕获埋点（mcrec.js 钩子）未实现（QF-REC-1 §6.5）——本轮只做协议就绪，**不得宣称已实现真机录像**；录制会话只存服务端内存，重启后 NOT_FOUND 须提示中断并重开（已实现）；`/event` 与 `/end` 路由鉴权已于 2026-11-15 补上（§6.1 已修复，见 QF-REC-1 规范）；10 分钟录像体积比 43.2x 为服务端沙箱模拟值，非真机值。

## 五、待真机验清单（等 L7 安排，本轮只做了模拟器/沙箱假通道测试）
- RC-03：5% 均匀丢包自愈率（沙箱 294/300 帧可解码为模拟值）、突发丢包＋交织真机表现、IDR 真机到达（forward 后 agent 是否真出关键帧，待转发通道落地）。
- RC-07：弱网建连超时计入 failedIds 并回退、退后台在途计数不泄漏、降级态 UI 与手动重试。
- RC-08：100MB 真机上传＋断点续传＋SHA-256 校验、通知栏/页面持续进度、收件箱到期置灰、审计恰一条。
- RC-09：弱网不断连、四档真机切换（hot 下一关键帧生效、reconfig 重配＋IDR）、手动升档健康窗口、背压 L1/L2/L3 真机动作。
- RC-10：真机录像体积比（43.2x 为模拟值）、seek/变速真机回放、POLICY_OFF 真机提示、服务端重启中断重开。
