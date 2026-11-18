# 会话与显示适配验证矩阵（供 B 线用）
# 来源：定夺 §3 工程约束 + 旧组件源码实读（launchUIInSession / display FSM / install.ps1）。
# 状态：需求矩阵，未经真机验证；D39ABOL 硬件行标注“转述/待取证核实”。
# B 线新组件的每个组合必须有真机实测结果才能标 PASS，不得凭本表直接标 PASS。

## 1. 会话 / 桌面 / SID 组合（新组件的准入表）

| # | 会话 | Window Station / Desktop | 进程身份（SID/token） | 结论 | 备注 |
|---|---|---|---|---|---|
| S1 | 活动控制台会话（WTSActive，SessionId ≥ 1） | WinSta0\Default | WTSQueryUserToken 该会话用户 | ✅ 允许：唯一合法锁 UI 落点 | 事故机即此类（黑屏曾可见）；须实测 SessionId 与 SID |
| S2 | Session 0（服务会话） | 任意 | LocalSystem | ❌ 必须拒绝建交互窗口 | 定夺 §3 约束 1；QFRLEA 只协调，显示组件在用户会话 |
| S3 | 非活动会话（Disconnected / Idle） | WinSta0\Default | 该会话用户 | ❌ 必须拒绝（不拉 UI、不记已锁定） | 无可见桌面时拉 UI 等于白锁；须回 UNKNOWN |
| S4 | RDP 会话（活动远程会话） | WinSta0\Default | RDP 用户 | ⚠️ 有条件允许：仅当该 RDP 会话是目标会话且本地控制台无人时；多会话并存须按 device.json 登记机主匹配 | 须真机实测 RDP 连接/断开场景（定夺 §6.2 会话安全） |
| S5 | Winlogon 桌面正显示（Win+L / 登录界面） | WinSta0\Winlogon | — | ❌ 必须拒绝在 Winlogon 上叠加锁窗口 | 须用 GetInputDesktop/OpenInputDesktop 判定当前输入桌面；锁屏态不画锁 UI |
| S6 | 目标 SID ≠ device.json ownerUsername 对应用户 | WinSta0\Default | 另一用户 | ❌ 必须拒绝 | 跨用户拉 UI 是越权；须核对 WTSQueryUserToken 的 SID 与登记机主 |
| S7 | 会话切换中（切换用户 / 注销进行中） | 任意 | 任意 | ❌ 必须拒绝并回 UNKNOWN | 切换期间 token 可能失效；失败须可恢复、不许把旧状态当已锁定 |
| S8 | 多用户同时活动（快速切换，两个活动会话） | 各自 WinSta0\Default | 各自用户 | ⚠️ 只锁登记机主所在会话；另一会话不得出现锁 UI | 须真机实测，见定夺 §6.2 |

## 2. D39ABOL 硬件类别适配要点（转述，待取证核实）

- 机型：站长笔记本 DESKTOP-D39ABOL（转述：Win11 家庭版 26H2 / Build 26300，内屏；
  D3 证据文件里未找到 OS Build 实测行，取证包须以 `winver` / 注册表
  `HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion`（CurrentBuildNumber +
  DisplayVersion）实测为准，不得沿用本行转述值）。
- 显示：单内屏（转述）；须实测：内屏熄屏后远程采集是否持续（定夺 §3 熄屏硬门）、
  DPI 缩放（100%/125%/150%）下密码框布局、合盖/插电/电池三种电源态。
- 捕获：旧组件用 `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)`（0x11）逐窗排除；
  新组件若沿用，须在 D39ABOL 上实测“排除后远端画面是否仍连续、无持续黑屏/灰屏”，
  并实测排除失败时的降级（旧组件 affinity 失败只记 `failed-degraded`，仍显示黑窗——
  新组件不得把降级当成功，必须报 DEGRADED）。
- 输入隔离：旧组件低级钩子只观察、不拦截（`CallNextHookEx` 放行），物理/注入靠
  LLKHF_INJECTED（0x10）/LLMHF_INJECTED（0x01）区分；新组件不得用 `BlockInput(TRUE)`
 （定夺 §3 约束 4）、不得用不可靠键鼠钩子冒充安全边界（约束 5）。
- 电源：2 分钟熄屏超时（插电+电池）是临时措施，保留；新锁验收须分别测
  `powercfg /requests` 无常驻阻止请求、闲置熄屏与远控中熄屏两种状态。

## 3. 显示兼容必测组合（定夺 §6.2，B 线逐项真机实测）

| 组合 | 要求 |
|---|---|
| 内屏单屏 | 熄屏真实发光停止（物理观察），远端画面与输入持续正常 |
| 外屏 / 多屏 | 每块屏都锁住、无一屏漏桌面；拔插显示器（WM_DISPLAYCHANGE）不丢锁、不挂起 |
| DPI 缩放 100/125/150% | 密码框完整可见、不溢出、不被任务栏遮挡 |
| 插电 / 电池 / 合盖 | 合盖后远程仍可控、本地不漏桌面；唤醒后锁状态与服务端一致 |
| 锁屏 / 注销 / RDP 连接-断开 | 不越权、不把旧状态当已锁定、不在 Winlogon 上画锁 UI |

## 4. 状态机对照（B 线实现时核对，C 线对账用）
- 旧组件只有两态：`Off` / `Locked`（`state.dat`，`status.json:state`）——
  这正是 LOCK-P0-03 失真的一半原因。新组件须用定夺 §4.2 六态
  （UNLOCKED / LOCKING / LOCKED / UNLOCKING / UNKNOWN / RECOVERY_REQUIRED，
  另加 DEGRADED/FAILSAFE 原因），且只有设备端确认后才报 LOCKED。
