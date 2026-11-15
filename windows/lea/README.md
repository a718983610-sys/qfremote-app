# QFRLEA 本地执行代理（Stage 1 MVP）

> 版本：v0.1.0-mvp（2026-11-10）｜分支：`lea-local-agent`｜工作区：`~/workspace/qfremote/work-recovery241`
> 设计：`~/workspace/qfremote/local-agent/DESIGN.md`（§1/§3/§4/§5/§6/§10/§11/§12）
> 参照：`~/workspace/qfremote/local-agent/CODEBASE-SURVEY.md` §1（QFSysHelper 模板）
>
> **状态：代码完成，Linux 单测全过，mingw 交叉编译通过；Windows 真机未验。**
> **绝不声称已在 Windows 上验证通过——真机验证清单见下文“须 Windows 真机验证”。**

## 一、这是什么

`QFRLEA` 是 Windows 系统服务（服务名 `QFRLEA`，SYSTEM 身份），配合 LEA 客户端
`qf-lea-client.exe`，构成 Muse 操作用户电脑的本地执行端：

```
Muse → 服务端 API → runcommands → qf-lea-client.exe → 命名管道 \\.\pipe\QFR\LEA\v1
  → QFRLEA 服务（准入／幂等／队列／审计）→ 脚本／文件（本机执行）
  → UI 类 → 命名管道 \\.\pipe\QFR\LEA\UserHelper\v1 → USH（另一线实现）
```

红线：不做内核驱动、不做进程注入；不存明文密码、不记 API Key 明文；
本地不监听任何 TCP/UDP 端口，只监听命名管道。

## 二、文件清单

| 文件 | 说明 |
|---|---|
| `QFRLEA.c` | 服务本体（约 1500 行）：管道、准入、队列 worker、脚本／文件／应用执行、USH 转发、DPAPI 绑定、服务控制、debug 模式 |
| `qf-lea-client.c` | LEA 客户端：接 `dispatch <base64>`／`apply <inbox 文件>`／`--file`／裸 JSON／stdin 的信封，连管道 2s，收响应打印 stdout（下发动词统一 S3，DESIGN §3） |
| `lea_protocol.h/.c` | 纯 C 协议层：信封解析、时间窗、命令表、路径规范化、响应构造 |
| `lea_crypto.h/.c` | 纯 C 密码学层：SHA-256、Base64、Ed25519 验签（已实现，见 §三-3）、Key 脱敏 |
| `lea_state.h/.c` | 纯 C 状态层：绑定状态机、重放表、幂等表（持久化）、队列（双 lane） |
| `lea_audit.h/.c` | 纯 C 审计层：JSONL 行构造、按天滚动、30 天清理 |
| `whitelist.h` | 脚本白名单 hash（`gen_whitelist.py` 生成，勿手改） |
| `gen_whitelist.py` | 从发版文件算 hash 生成 `whitelist.h`（`--check` 校验） |
| `build.sh` | mingw 交叉编译（服务＋客户端），默认生产构建 |
| `../install-lea.ps1` | 服务安装脚本（唯一入口，H18；一次 UAC；拷载荷前验 SHA-256，见 H17） |
| `test/test_lea.c` | 核心逻辑单测（Linux 可跑） |
| `test/pipe_server.c` | S3 真客户端单测的管道替身（仅测试用，不进生产包；由 `server/ext/lea/test/test-lea-realclient.js` 驱动） |
| `test/run_tests.sh` | 单测＋交叉编译一键跑 |
| `QFRLEA.exe`、`qf-lea-client.exe` | 本沙箱交叉编译产物（生产构建，见下） |

**未改动**：`installer.nsi`、`server/ext/server.js`、任何 2.4.5 文件（另一线负责）。
`windows/ush/`、`server/ext/lea/`、`windows/install-lea.ps1` 为其他线的工作，本线未碰。

## 三、实现要点（对照任务书）

1. **服务与管道**：服务名 `QFRLEA`，显示名“QFRemote 本地执行代理”，SYSTEM 身份；
   管道 `\\.\pipe\QFR\LEA\v1`，多实例（8 路），每连接独立线程；SDDL
   `D:(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;AU)`（H01：主程序以普通用户身份
   经已安装的 `qf-lea-client.exe` 发内部命令，必须能连上管道；业务信封
   仍须服务端 Ed25519 签名，内部命令另验调用方进程镜像全路径——只认
   安装目录下的 `qf-lea-client.exe`，**且父进程须为主程序
   （QFRemote.exe／开发态 electron.exe，在活动控制台会话内，H01 第二
   轮：只验镜像不够，任意用户都能直接运行合法客户端）**，不通过回
   `QFR_LEA_CALLER_NOT_ALLOWED`）。
   `QFRLEA.exe debug` 前台跑管道循环（同 QFSysHelper 的 debug 模式）。
2. **协议**：一行 JSON 请求 → 一行 JSON 响应；信封字段按 DESIGN §4.1 全量解析
   （version/request_id/batch_id/seq/device_id/account_id/api_key_id/
   binding_epoch/nonce/issued_at/expires_at/idempotency_key/command/params/
   timeout_ms/signature/trace_id）；时间窗 `expires_at-issued_at ≤ 60s`、
   时钟偏差 ±30s；nonce/request_id 去重保留 10 分钟。
3. **签名验签（已实现，fail-closed）**：`lea_crypto.c` 的 `lea_verify_*` 已接
   真实 Ed25519 验签（vendored Orlp ed25519，仅验签路径；接受标准 base64
   与 base64url 两种签名编码）。服务端公钥由编译期宏
   `LEA_SERVER_PUBKEY_HEX`（64 字符 hex）编入发版包；未编入公钥时
   `lea_server_pubkey_hex()` 返回 NULL，验签一律拒绝（原因
   `ed25519-pubkey-not-configured`，错误码 `QFR_LEA_SIG_NOT_CONFIGURED`）；
   格式错误的签名另报 `QFR_LEA_BAD_SIGNATURE`。仅编译时定义
   `LEA_TEST_UNSIGNED=1` 才接受 signature `TEST-UNSIGNED`
   （单测／真机冒烟专用，`build.sh` 默认不启用，生产构建经 `strings`
   核查不含 `test-only-unsigned-accepted`）。规范串格式见
   `CANONICAL-SIGNING-V2.md`（信封 v2）与 `CANONICAL-SIGNING-V1.md` §3（票据 v1）。
4. **第二层准入**（`lea_admit`，顺序按 DESIGN §6.2）：绑定态 → 设备一致 →
   epoch 一致 → 账号一致 → `muse.execute` 授权 → 本地吊销表（`state/revoked_keys.txt`，
   每行一个 key_id；服务端吊销的本地镜像——写入方：服务端下发命令前经
   runcommands 推送全集，见 H21；admit 的授权代次比对（T07）是第一层控制）
   → scope（危险命令另需 `muse.execute.dangerous`）。拒绝码见 DESIGN §4.5；仅 `QFR_LEA_BINDING_PENDING`
   可重试。准入读内存实时绑定态（服务内 `g_binding`，无缓存过期问题）。
5. **幂等**：键 `(device_id, account_id, idempotency_key)`，状态
   RECEIVED/RUNNING/SUCCEEDED/FAILED/UNKNOWN/EXPIRED；持久化到
   `%ProgramData%\QFR\LEA\state\idempotency.jsonl`（全量快照＋原子替换）；
   普通保留 7 天、危险命令 30 天；终态返回缓存结果不重复执行；执行中回
   `QFR_LEA_DUPLICATE_IN_PROGRESS`；启动时崩溃残留的 RUNNING/RECEIVED 标
   UNKNOWN（不自动重试）。
6. **队列**：worker 单线程串行 FIFO，总上限 100 条，超限回 `QFR_QUEUE_FULL`；
   危险命令单独 lane（独立 FIFO，出队优先于普通 lane；全局仍串行）。
   等待按 `timeout_ms`，超时回 `QFR_LEA_TIMEOUT`＋`job_id`（任务继续跑，
   终态进幂等表；job 查询接口为 Stage 2）。
7. **脚本／文件执行**：白名单三重门——① 路径规范化后位于安装目录内；
   ② basename 吻合；③ SHA-256 与 `whitelist.h` 一致。初始清单**仅
   `qf-agent-heal.ps1` 一个**（hash `96b4efbe…1257`，与 QFSysHelper 的
   `whitelist.h` 一致，已用 `gen_whitelist.py --check` 核对；**完整清单待
   站长确认，DESIGN §14 #5**）。PowerShell 固定
   `-NoProfile -NonInteractive -ExecutionPolicy Bypass -File`，参数逐个
   MSVC 规则引用转义（C 版 `ArgumentList` 等价物），禁 `cmd /c`、
   禁 `-Command` 拼接；参数禁控制字符；输出回传上限 8192 字节。
   文件读写仅限 `%ProgramData%\QFR\LEA\work\`（规范化＋前缀判定，`..`
   越界拒绝；`file.read` 内联上限 32KB，超限拒绝）。`app.open` 仅限显式 exe
   白名单（H16：名＋SHA-256 双重判定，初版仅 `QFUserHelper.exe`，见 `whitelist.h`）；
   `app.close` MVP 仅允许 `QFRemote.exe`（清单待站长确认）。
8. **UI 类转 USH**：`ui.click/input/snapshot/tree` 由 worker 重建信封行，
   经 `\\.\pipe\QFR\LEA\UserHelper\v1` 转发（连接超时 2s，执行按
   `timeout_ms`）；USH 不可用时明确报 `QFR_LEA_USH_UNAVAILABLE`
   （MVP 补充码）。USH 响应透传其 `ok`／`code`。**USH 由另一线实现；
   本线不假设 USH 已存在。**（H03：转发前 LEA 读
   `%ProgramData%\QFR\LEA\ush-tokens\<sessionid>.txt` 的当次随机 token，
   以 `ush_token` 字段插进信封行末；读不到 token 即 `ush-token-missing`，
   不裸发。USH 侧另验调用方镜像＋token，见 `windows/ush/README.md`。）
9. **日志与审计**：`%ProgramData%\QFR\LEA\logs\lea-YYYY-MM-DD.jsonl`，
   结构化 JSONL 按天滚动保留 30 天（每小时清理一次）；字段按 DESIGN §11.1
   （trace_id/request_id/batch_id/seq/account_id/device_id/api_key_id/
   binding_epoch/command/params_hash/nonce/result/error_code/duration_ms/…）；
   params 只记 SHA-256；API Key 只记 key_id 与前缀片段（前 8 位＋后 4 位），
   绝不记明文；另有 `lea-service.log` 明文生命周期日志。
   目录与文件 ACL 仅 SYSTEM／Administrators（SDDL＋安装脚本双重设置）。
10. **绑定**：DPAPI `LocalMachine` 加密存 `%ProgramData%\QFR\LEA\state\binding.dat`
    （ACL 仅 SYSTEM／Administrators）；状态机
    UNBOUND→PENDING→ACTIVE→REVOKING→UNBOUND。binding.dat 另存票据签名
    `ticket_signature`（H02）：加载 ACTIVE 态时重验签名，不通过即丢弃回
    UNBOUND（fail-closed；旧版无签名字段的文件同样丢弃，用户重登后由新
    票据重建）。登录事件（内部命令 `session.login_changed`）：
    **同账号重登（应用重启／静默重登）不升 epoch**，已生成 Key 继续可用；
    换号／未绑定时 epoch+1；两种情况都进 PENDING、清空授权等票据确认重填
    （H07 epoch 协调；服务端同账号换绑同样不升，两端一致）。
    票据确认（内部命令 `binding.confirm`，验票据签名）后进 ACTIVE；
    登出／撤销进 UNBOUND 且 epoch+1，**不回滚旧绑定**。
    内部命令走同一管道（ACL 含 AU，见第 1 条），不走信封验签——
    但先验调用方进程镜像＋父进程为主程序（H01），与 QFSysHelper 的 `{cmd,…}` 模式一致。
    登录／登出／换号通知由主程序 `windows/main.js` 发起
    （`notifyLeaLogin`／`notifyLeaLogout`，H07；登出后同账号重登会使
    LEA epoch 跳前，旧 Key 因 epoch 不符失效，须重新生成 Key）。
    `session.login_changed` 的 result 格式由 `lea_binding_login_result`
    锁死并单测覆盖（H07 第二轮：main.js 从 `result.binding_epoch` 取
    epoch 去调 rebind，格式一变钩子就空转）。
    吊销同步（内部命令 `keys.sync-revoked`，#17）：主程序在 rebind 拿到
    `revoked_key_ids` 后经 `qf-lea-client.exe --internal` 发
    `{"cmd":"keys.sync-revoked","key_ids":["k_..."]}`，全量替换本机
    `state/revoked_keys.txt`（一行一个 id，去重＋排序；任一 id 非法即
    整单拒绝，不写残集；回 `{"revoked_count":N}`）。主路径仍是服务端
    下发前推送（H21，`lea-core.js syncRevocations` 经 runcommands 写本机
    文件）；本命令是 C 侧的第二写入方，使 `key_is_revoked` 的检查不再是
    “只读不写”的死机制。调用方同样先验 H01（安装目录客户端＋主程序父进程）。
11. **危险命令初始定义**（待站长确认完整清单，DESIGN §14 #4）：`script.run`、
    `file.write`，以及 `params.dangerous=true` 的 `ui.click`／`ui.input`。
    危险命令禁自动重试、进单独 lane、幂等保留 30 天。

## 四、构建

```sh
cd windows/lea
./build.sh                    # 生产构建：QFRLEA.exe + qf-lea-client.exe
LEA_TEST_UNSIGNED=1 ./build.sh  # 仅冒烟测试用，生产绝不启用
python3 gen_whitelist.py --check  # 校验 whitelist.h 与当前脚本一致
```

## 五、单测结果（本机 Linux 沙箱，2026-11-10 实跑；数字为干净基线 ad506e2＋本补丁实跑，与主树一致）

```sh
sh test/run_tests.sh
```

| 项 | 结果 | 证据 |
|---|---|---|
| 核心单测（测试构建） | **326 通过，0 失败** | `test_lea.c`：SHA-256 向量、协议解析、签名验签、重放、绑定状态机、准入各码、幂等往返＋保留期、路径规范化、队列、审计脱敏、响应构造、参数提取、**规范串 v1（信封／票据定稿向量与 JS 端字节一致、篡改敏感性、字段规则、seq／timeout／grant 严格校验、长 scope token、票据完整 JSON 解析 `lea_parse_ticket`、整数字段全程 64 位、重建转义 #25 全字段＋严格 JSON 校验、显式 `null` 拒绝、转义键解码、`\u0000` 拒绝、顶层值切片解析）**、**H02 票据签名存取与加载重验、H03 信封行末 `ush_token` 插入、H07 同账号重登不升 epoch／换号升 epoch 且清签名、H07 第二轮 `lea_binding_login_result` 格式锁死**、**中组 C（#22 params 缺失／20KB 保留／40KB 拒绝／非对象拒绝、#17 顶层字符串数组＋吊销写入排序去重与非法整单拒绝、#26 700 条约 5.6MB 幂等表流式写盘与逐行加载回表）** |
| 核心单测（严格构建） | **321 通过，0 失败** | 同上（无 `LEA_TEST_UNSIGNED` 时 `TEST-UNSIGNED` 被拒，fail-closed 得证） |
| mingw 交叉编译 | **通过，零警告** | `QFRLEA.exe`（PE32+ x64，503003 B）、`qf-lea-client.exe`（266641 B） |
| 生产构建核查 | **通过** | `strings QFRLEA.exe` 不含 `test-only-unsigned-accepted`（0 处），含 `ed25519-pubkey-not-configured`（2 处） |
| 白名单核查 | **通过** | `gen_whitelist.py --check`：`qf-agent-heal.ps1` sha256 与 `whitelist.h` 一致 |

单测中修掉的两个真问题（已记入代码注释）：
- 幂等缓存结果含末尾换行会破坏 JSONL 行格式 → 存入时剥离换行（`lea_idem_set_status`）。
- 幂等加载时把外层 `}` 吞进 result → 改花括号配对提取（`lea_idem_load_text`）。

## 六、须 Windows 真机验证（未做，不许谎称已验）

以下均须在阿里云 ECS Windows Server（DESIGN §13.1）或 Win11 笔记本上实测，
本沙箱（Linux）无法运行 Windows 服务／命名管道／DPAPI／PowerShell：

1. `install-lea.ps1`（唯一安装入口，H18）一次 UAC 安装：服务创建、启动、Running 状态、失败回滚。
2. `QFRLEA.exe debug` 前台模式：管道可连接、一问一答。
3. 冒烟构建（`LEA_TEST_UNSIGNED=1`）端到端：`session.login_changed` →
   `binding.confirm`（TEST-UNSIGNED）→ `sys.info` → `script.run`
  （qf-agent-heal.ps1，白名单 hash 通过）→ `file.read/write` →
   `ui.*`（USH 未装时应明确报 `QFR_LEA_USH_UNAVAILABLE`）。
4. 生产构建端到端应拒绝执行（`QFR_LEA_SIG_NOT_CONFIGURED`），直至真实公钥接入。
5. `qf-lea-client.exe` 经 `runcommands`（SYSTEM）调用：信封投递、stdout 回传、退出码。
   沙箱内已用 wine64 覆盖到真客户端一级（S3，2026-11-10）：
   `node server/ext/lea/test/test-lea-realclient.js` 16/16 通过——dispatch／apply
   两路管道原文 == 原信封，坏 base64／缺参／缺文件三例 exit 2 且管道零接收。
   仍须真机（ECS／笔记本）验证 runcommands 通道本身与 SYSTEM 身份下的管道连通。
6. DPAPI 绑定落盘与重启恢复；幂等表重启恢复（RUNNING→UNKNOWN）；日志滚动与 30 天清理。
7. 队列满、超时、USH 崩溃、换绑竞态等故障注入（DESIGN §13.2）。
8. 命名管道 ACL 实测：普通用户（AU）经已安装客户端可连；SYSTEM／管理员可连；
   非安装目录客户端冒充发内部命令应被拒（`QFR_LEA_CALLER_NOT_ALLOWED`）。
9. 安装目录位置确认：`qf-agent-heal.ps1` 在包内的实际路径（当前假设为
   安装根目录；若实际在子目录，需调整白名单根目录判定）。

## 七、待站长／他线确认的事项（本线未擅自定）

- 脚本白名单完整清单（DESIGN §14 #5）：当前仅 `qf-agent-heal.ps1`。
- 危险命令完整清单（DESIGN §14 #4）：当前定义见 §三-11。
- `app.close` 允许清单：当前仅 `QFRemote.exe`。
- 服务账户：当前 `LocalSystem`（DESIGN §14 #7 待定；专用低权账户需另评估）。
- Ed25519 服务端公钥接入（服务端线）；签名规范串已冻结为 v2（F-02，2026-11-14）
  （信封 `windows/lea/CANONICAL-SIGNING-V2.md`，20 行；票据仍 v1，
  `ds-review-stage2/CANONICAL-SIGNING-V1.md` §3，9 行，两端同一份）。
  **兼容性：v2 与旧串完全不兼容，v1 信封直接拒绝，旧串验签失败是预期行为，
  不设版本协商、不设 v1 回落；回滚必须两端成对；
  LEA 尚未随任何正式版发布（现行版 2.4.4 无 LEA），服务端与 LEA 随同一版本升级，
  不存在滚动混用；发版说明须写死“必须同时升级两端”。**
  （信封 `windows/lea/CANONICAL-SIGNING-V2.md`，20 行；票据 9 行，两端同一份）。
- USH 管道协议细节（USH 线）：当前按一行 JSON 请求 → 一行 JSON 响应假设，
  与 QFSysHelper 同形。
- `installer.nsi` 的 `SEC_LEA` 段与 `main.js` 登录成功分支调用
  `install-lea.ps1`（唯一入口，H18；旧 `install-lea-service.ps1` 已删）。
- `qf-agent-heal.ps1` 在包内的实际路径（打包线）。

## 八、错误码表（DESIGN §4.5 ＋ MVP 补充码，补充码标 *）

`done` / `QFR_LEA_BAD_ENVELOPE`* / `QFR_LEA_BAD_SIGNATURE`* /
`QFR_LEA_SIG_NOT_CONFIGURED`* / `QFR_REPLAY_DETECTED` / `QFR_LEA_NOT_BOUND` /
`QFR_LEA_BINDING_PENDING`（唯一可重试）/ `QFR_BINDING_CHANGED` /
`QFR_MUSE_NOT_AUTHORIZED` / `QFR_API_KEY_REVOKED` / `QFR_SCOPE_DENIED` /
`QFR_DEVICE_NOT_WHITELISTED` / `QFR_GRANT_REVOKED` /
`QFR_LEA_DUPLICATE_IN_PROGRESS` / `QFR_LEA_EXECUTION_UNKNOWN` /
`QFR_QUEUE_FULL` / `QFR_LEA_USH_UNAVAILABLE`* / `QFR_LEA_SCRIPT_NOT_ALLOWED`* /
`QFR_LEA_PATH_NOT_ALLOWED`* / `QFR_LEA_TIMEOUT`* / `QFR_LEA_NOT_INSTALLED` /
`QFR_LEA_EXEC_FAILED`* / `QFR_LEA_INTERNAL`*。
客户端本机错误另有 `QFR_LEA_CLIENT_*`（见 `qf-lea-client.c`）。
