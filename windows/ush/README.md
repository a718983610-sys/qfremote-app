# QFUserHelper（USH）—— 用户会话助手（Stage 1 MVP）

> 设计依据：`~/workspace/qfremote/local-agent/DESIGN.md`（§1.1 双组件原因、§2 USH 职责、
> §4 协议、§5.1 UIA、§5.4 USH 生命周期、§11.1 日志）。
> 分支 `lea-local-agent`，工作区 `~/workspace/qfremote/work-recovery241`。
> 状态：沙箱编译通过、纯逻辑单测通过、Wine 冒烟通过；**Windows 真机未验**（见 `test/WINDOWS-TESTS.md`）。

## 语言选型：C（不是 C#）

- **与现有构建链零新增依赖**：QFSysHelper 已是 C＋mingw 交叉编译（`windows/syshelper/build.sh`），
  同链可直接复用；沙箱实测 `x86_64-w64-mingw32-gcc` 一次编过，无需在构建机/用户机装新工具链。
- **无运行时依赖**：单文件 `QFUserHelper.exe`（约 450KB），不依赖 .NET 运行时。
  C# 方案在 Win11 Home／Windows Server 上要么要求系统自带 .NET（版本不可控），
  要么自包含发布（体积上百 MB，塞进 `app.7z` 打包画像与 NSIS 流程都要重做）。
- **与 QFSysHelper 同构**：命名管道＋SDDL＋一行 JSON＋`debug` 前台模式，同一套心智模型，
  安装线（`register-ush.ps1` 的计划任务注册）可照搬 `install-system-services.ps1` 的模式。
- **代价**：UIA 要手写 C COM 调用（`IUIAutomation` vtable），代码比 C# 啰嗦；
  已用 mingw 头文件逐项核对 GUID／ControlTypeId／vtable 成员名（见 `ush_uia.c` 注释），
  编译期即卡住错名，真机只需验行为。

## 文件清单

| 文件 | 说明 |
|---|---|
| `ush.c` | 主程序：DPI awareness、单实例、命名管道服务、分发、会话门 |
| `ush_json.h` / `ush_json.c` | 纯逻辑协议层（无 Windows 依赖，可在 Linux 单测） |
| `ush_log.h` / `ush_log.c` | JSONL 日志（`%ProgramData%\QFR\LEA\logs\ush-YYYY-MM-DD.jsonl`） |
| `ush_uia.h` / `ush_uia.c` | UIA 引擎：定位、Pattern 点击、输入、控件树、会话门 |
| `ush_snapshot.h` / `ush_snapshot.c` | 截图：GDI BitBlt＋WIC PNG 编码（文件／内联 Base64） |
| `register-ush.ps1` | 注册登录启动计划任务（安装线调用，需管理员） |
| `build.sh` | mingw 交叉编译 |
| `QFUserHelper.exe` | 编译产物（随包下发，约定同 `syshelper/QFSysHelper.exe`） |
| `test/` | 单测与冒烟工具（见下） |

## 协议

管道：`\\.\pipe\QFR\LEA\UserHelper\v1`，一行 JSON 请求 → 一行 JSON 响应。
ACL 仅 SYSTEM＋Administrators（`D:(A;;GA;;;SY)(A;;GA;;;BA)`）＋拒绝远程连入：
只有 QFRLEA 服务（SYSTEM 身份）能连。比 QFSysHelper 更严是故意的——
QFSysHelper 要接用户态 Electron 应用故放行 AU，USH 只接 LEA 服务。
（H03：除管道 ACL 外，USH 另设两道本地鉴别——调用方进程镜像只认
安装目录下的 `QFRLEA.exe`（LEA 服务）与自身 `QFUserHelper.exe`
（仅 `ui.ping` 自探活），其余一律拒绝；LEA 来的请求须带与 USH 内存
token 一致的 `ush_token`（USH 每启动随机生成 32 字节 hex，写
`%ProgramData%\QFR\LEA\ush-tokens\<sessionid>.txt` 供 LEA 读取，
`<sessionid>` 为活动控制台会话 id，H03 第二轮与 LEA 同源，RDP／多
会话下不错配；无活动控制台会话时（RDP-only）USH 不写 token 文件，
LEA 读不到 token，UI 命令 fail-closed），
定长比对，不符回 `QFR_USH_UNAUTHORIZED`。）

请求（LEA 转来的已校验信封；USH 不做准入、不验签名、不存密钥——
但先验调用方身份与 ush_token，见上）：

```json
{"version":1,"request_id":"<uuid>","trace_id":"...","batch_id":"...","seq":1,
 "device_id":"...","account_id":"...","api_key_id":"...","binding_epoch":3,
 "nonce":"...","command":"ui.click","params":{...},"timeout_ms":5000,
 "idempotency_key":"...","dangerous":false}
```

响应：

```json
{"ok":true,"code":"done","request_id":"...","duration_ms":12,"data":{...}}
{"ok":false,"code":"QFR_USH_ELEMENT_NOT_FOUND","request_id":"...","duration_ms":12,"error":"..."}
```

`request_id` 在命令未知时也会回显（LEA 靠它关联）。

## 命令（MVP）

| 命令 | params | 执行方说明 |
|---|---|---|
| `ui.ping` | — | 探活；**不受会话门限制**（锁屏时也要能回答，LEA 靠它区分“USH 活着但锁屏”与“USH 死了”） |
| `ui.click` | `target`（见下），`dangerous` 透传信封字段 | 定位 → 后台 Pattern（Invoke/Toggle/SelectionItem）→ 无 Pattern 时坐标点击；点击后比对 UIA 属性签名确认；普通点击最多 2 次重试（200ms/500ms），危险按钮不重试 |
| `ui.input` | `target`，`text`（必填），`mode:"set"`（默认，ValuePattern）／`"type"`（SendInput），`submit`（回车） | 优先 `ValuePattern.SetValue`；无 ValuePattern 时聚焦＋SendInput Unicode 打字；能读回 Value 时比对确认，读不回时如实返回 `confirmed:false`（不谎称成功） |
| `ui.snapshot` | `mode:"file"`（默认）／`"inline"`，`window_title`／`window_class`（可选，指定窗口；缺省虚拟屏全屏） | file：写 `%ProgramData%\QFR\LEA\snapshots\ush-*.png` 回路径；inline：PNG Base64，超 6MB 拒绝并提示用 file |
| `ui.tree` | `target`（可选，限定窗口），`max_depth`（默认 5，上限 10），`max_nodes`（默认 500，上限 5000） | 递归取控件树；超量截断并置 `truncated:true` |

`target` 字段（定位策略按 DESIGN.md §5.1 顺序尝试）：

```json
{"window_title":"记事本","window_class":"Notepad",
 "automation_id":"okBtn","name":"确定","control_type":"Button",
 "class_name":"Button","index":0,
 "rel_x":0.5,"rel_y":0.5,            // 窗口内相对坐标（0..1）
 "x":100,"y":200,"coords":"physical",// 绝对坐标；coords=logical 时按目标窗口 DPI 换算
 "relative":true,                    // 兼容写法：x/y 为 0..1000 千分比
 "image_template":"..."}             // MVP 未实现：仅含此字段时返回 QFR_USH_UNSUPPORTED
```

## 关键行为（对照 DESIGN.md §5.1）

- **后台 Pattern 优先**：Invoke／Toggle／SelectionItem 无需窗口前置、被遮挡也可用；
  只有必须坐标点击时才 `ShowWindow(SW_RESTORE)`＋`SetForegroundWindow`。
- **DPI**：启动时声明 PerMonitorV2（`SetProcessDpiAwarenessContext`，失败降级
  `SetProcessDpiAwareness`）；UIA 返回的矩形本身就是物理像素；`coords=logical` 时按
  `GetDpiForWindow` 换算。
- **确认**：点击／输入后取元素签名（Name＋IsEnabled＋Value）比对；Pattern Invoke 返回
  S_OK 即为执行确认，`change_observed` 只作附加信号（有些按钮点击后自身属性不变）。
  坐标点击无元素可比对时：有元素但属性未变 → 重试，耗尽报失败；纯坐标点击
  （无元素）→ 如实返回 `confirmed:false`＋说明，不谎称已确认。
- **会话门**：`ui.click/input/snapshot/tree` 执行前查 `WTSConnectState==Active` 且能打开
  输入桌面；锁屏／休眠／断开会话时返回 `QFR_USH_SESSION_LOCKED` 或
  `QFR_USH_NO_INTERACTIVE_SESSION`，绝不谎称已点击。
- **日志**：每请求一行 JSONL（字段见 DESIGN.md §11.1：trace/request/batch/seq、
  account/device/api_key_id/binding_epoch、command、params_hash、idempotency_key、
  nonce、result/error_code、duration_ms、ush_session_id、process_id、window_title
  （截断 80 字符）、retry_count）。params 只记 SHA-256 哈希；输入文本、Key 明文永不入日志。
- **单实例／崩溃恢复**：每会话一个互斥体，首实例创建即持有所有权直至
  进程退出；后起实例 3 秒内拿不到所有权即干净退出（不写 token 文件、
  不建管道）；旧实例崩溃则互斥体被遗弃，后起实例接管（r10 双 USH 修
  复：旧版先写 token 再查互斥＋靠 pipe 探活裁决，触发器 backfill 与应用
  登录同秒拉起时双进程并存、token 互串、失败方每秒刷 pipe-create-failed；
  管道层另有兜底，CreateNamedPipe 报 5／231 且探活成功即停整个进程）。
  无持久状态，进程死则管道句柄由系统回收，不留僵尸管道；计划任务
  失败自动重启（1 分钟间隔，最多 3 次）。
- **红线**：不做内核驱动、不做进程注入；不执行任意脚本／命令；USH 只信 LEA
  （H03：调用方镜像＋ush_token 两道鉴别，不只信管道 ACL）。

## 构建

```sh
./build.sh   # 产物 QFUserHelper.exe，打印 SHA-256
```

依赖：`x86_64-w64-mingw32-gcc`（与 QFSysHelper 同链）。
链接库：`ole32 oleaut32 uuid wtsapi32 gdi32 user32 bcrypt windowscodecs`。

## 启动入口（安装线接线）

```powershell
# 管理员权限，安装时调用一次（主程序一次 UAC 拉起，或安装器 SEC_LEA 段调用）：
powershell -NoProfile -ExecutionPolicy Bypass -File register-ush.ps1 `
  -ExePath "C:\Program Files\QFRemote\LEA\QFUserHelper.exe"
```

注册计划任务 `QFRLEA User Helper`（触发器：用户登录；当前用户权限，不提权；
失败自动重启；注册后立即启动一次）。本目录不改 `installer.nsi`、
不改 `server/ext/server.js`、不碰 `windows/lea/`（另一线负责）。

前台调试：`QFUserHelper.exe debug`（不注册 SCM，USH 不是服务）。

## 测试

- 沙箱单测：`sh test/run_tests.sh`（纯逻辑层，宿主 gcc；72 项，见 `test/test_ush_json.c`，
  含 T24 同款契约：`ush_build_response` 两路响应恒以 `\n` 结尾——LEA→USH 读循环只认
  `\n` 为完成，短读不算完成）。
- Wine 冒烟：`test/pipe_probe.c`（mingw 编译）连管道发请求；Wine 下 `ui.ping` 通、
  未知命令／UI 失败均返回结构化错误、进程不崩、日志落盘、重复实例自退。
  Wine 无真实 UIA／无显示驱动，`ui.click/input/tree/snapshot` 在 Wine 下预期失败——
  **不代表真机失败**，须按 `test/WINDOWS-TESTS.md` 在阿里 ECS 真机验证。
- 已知教训（Wine 实测挖出，已修）：① `CreateNamedPipe` 缓冲给 16MB 会建管失败，
  改 64KB（WriteFile 分片写大响应不受影响）；② 16MB 栈数组放管道工作线程（1MB 栈）
  会在首个请求入口直接栈溢出崩进程，`data_buf` 已改堆分配。

## 未完成／须真机验证

见 `test/WINDOWS-TESTS.md`。核心是：在阿里 ECS（交互会话已解锁）上跑通
`ui.click`（记事本按钮，Pattern 与坐标两路）、`ui.input`（ValuePattern 与 SendInput 两路）、
`ui.snapshot`（file 与 inline）、`ui.tree`、锁屏拒绝、DPI 125% 坐标换算、计划任务登录自启、
USH 被杀后 LEA 重拉（LEA 侧实现，本线只保证崩溃不留僵尸管道）。
