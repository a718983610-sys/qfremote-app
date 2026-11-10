# USH Windows 真机验证清单（Stage 1 MVP）

> 沙箱已验证：mingw 编译零警告、纯逻辑单测 58/58、Wine 下管道问答／日志／去重实例。
> Wine 无真实 UIA、无显示驱动，以下各项**必须在真机验证**，通过才算 MVP 完成。
> 建议测试机：阿里云 ECS Windows Server `47.98.169.87`（DESIGN.md §13.1），
> RDP 会话保持解锁；QQ 水浒游戏按 §13.1 约束：只在真正上机 UI 测试时暂停，测完立即恢复。

## 前置

- [ ] 机器在线、管理员权限；`QFUserHelper.exe`（本目录产物）已拷到测试目录。
- [ ] 以管理员身份跑 `register-ush.ps1`，任务 `QFRLEA User Helper` 已注册且状态为就绪。
- [ ] 注销重登录后任务自动拉起 USH（任务计划程序 → 上次运行结果 0x0）；
      任务管理器可见 `QFUserHelper.exe`（当前登录用户身份，非 SYSTEM）。
- [ ] `%ProgramData%\QFR\LEA\logs\ush-YYYY-MM-DD.jsonl` 有 `ush-started`＋`pipe-listening`。

冒烟客户端（本目录 `test/pipe_probe.c`，mingw 编译后拷上机）：

```cmd
x86_64-w64-mingw32-gcc -O2 -o pipe_probe.exe test/pipe_probe.c
pipe_probe.exe "{\"command\":\"ui.ping\",\"request_id\":\"t1\"}"
```

## 逐项（每项给 通过／不通过＋证据：响应原文＋日志行）

### 1. ui.ping（探活）
- [ ] 返回 `{"ok":true,"code":"done","data":{"alive":true,...}}`，`duration_ms` 为个位数毫秒。
- [ ] 锁屏后 `ui.ping` 仍返回 ok（探活不受会话门限制）。

### 2. ui.click —— Pattern 路径（记事本）
1. 打开记事本，输入任意文字。
2. `ui.click {"target":{"window_title":"记事本","name":"关闭","control_type":"Button"}}`
   或用 AutomationId 定位记事本菜单项（如有）。
- [ ] 返回 `method:pattern`，`confirmed:true`；记事本实际关闭／菜单实际打开。
- [ ] 换 `name+control_type`、`class_name+index` 各定位一次，均成功（策略回退）。

### 3. ui.click —— 坐标路径
- [ ] `ui.click {"target":{"window_title":"记事本","rel_x":0.5,"rel_y":0.1}}`
  返回 `method:coordinate`；窗口被前置（最小化记事本先测 `SW_RESTORE` 生效）。
- [ ] `coords:logical` 在 DPI 125% 的 Win11 笔记本上复验：逻辑坐标换算后落点正确
  （Server 常 100%，此项可记为笔记本复验观察项，见 DESIGN.md §13.1）。

### 4. ui.click —— 重试与危险按钮
- [ ] 定位不存在的元素：返回 `QFR_USH_ELEMENT_NOT_FOUND`，耗时约等于 `timeout_ms`，
      且日志 `retry_count` 反映重试（普通点击应有 2 次重试间隔 200ms/500ms）。
- [ ] `dangerous:true` 的同类请求：只试一次即返回（日志 `retry_count:0`）。

### 5. ui.input
- [ ] 记事本编辑框：`mode:set`（ValuePattern）输入中文，返回 `confirmed:true`，
      编辑框内容一致。
- [ ] `mode:type`（SendInput）输入英文＋换行，内容一致；`submit:true` 触发回车。
- [ ] 日志里**没有**输入文本明文（只查到 `params_hash`）。

### 6. ui.snapshot
- [ ] `mode:file`：返回路径，文件存在且为合法 PNG（能打开，与屏幕一致），
      尺寸与虚拟屏一致；多显示器时覆盖全部显示器。
- [ ] `mode:inline`：返回 `data_base64`，解码后为合法 PNG。
- [ ] 指定 `window_title`：只截该窗口。
- [ ] H24 截图目录 ACL：`icacls "%ProgramData%\QFR\LEA\snapshots"` 只含
      `NT AUTHORITY\SYSTEM`、`BUILTIN\Administrators`、当前登录用户三条
      允许 ACE，且无继承 ACE（`icacls` 输出不含 `(I)` 继承标记）；
      换一个普通用户登录后打不开目录内 PNG（拒绝访问）。
- [ ] H24 截图目录清理：放 60 个 `ush-*.png`（10 个改 10 天前）后触发一次
      file 截图，旧 10 个被删、总数回到 50 个；再放 5 个后总数仍为 50 个。

### 7. ui.tree
- [ ] 记事本窗口 `max_depth:2`：返回树，含菜单／编辑框节点，字段齐全
      （name/control_type/automation_id/class_name/rect/enabled/children）。
- [ ] 桌面根＋默认深度：返回 `truncated` 标记正常，不崩、不超时失控。

### 8. 会话门（锁屏拒绝）
- [ ] 锁屏（Win+L）后 `ui.click` 返回 `QFR_USH_SESSION_LOCKED`（或
      `QFR_USH_NO_INTERACTIVE_SESSION`），且**没有**发生任何点击（解锁后确认目标状态未变）。
- [ ] 解锁后同一命令恢复成功。

### 9. 管道 ACL 与单实例
- [ ] 普通用户进程直接连管道应被拒绝（LEA 服务 SYSTEM 身份可连；本项在真机上
      用非管理员 PowerShell `\\.\pipe\QFR\LEA\UserHelper\v1` 验证连入失败）。
- [ ] 手动再起一个 `QFUserHelper.exe`：第二个进程自行退出（日志 `duplicate-instance`），
      第一个继续服务，`ui.ping` 正常。
- [ ] 任务管理器杀掉 USH：管道消失；重新登录或手动启动任务后恢复（LEA 侧重拉由 LEA 线验证）。

### 10. 日志
- [ ] 每条命令在当日 `ush-*.jsonl` 里恰好一行，字段齐全（见 README“日志”一节），
      `params_hash` 为 64 位小写 hex；全文 grep 不到本次输入的文本明文与任何 Key 明文。

## 不通过时

按 DESIGN.md §13.3 返工循环：记问题清单（现象、复现步骤、trace、影响、严重级别）
→ 修 → 重测，直至零问题。**不许带已知问题发布。**
