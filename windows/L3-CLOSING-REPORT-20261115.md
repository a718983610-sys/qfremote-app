# L3 Windows 运行端收尾报告（全进 3.0，2026-11-15）

- 执行线：L3（D-06、D-07、D-08、D-09、D-10、RC-04 Windows 客户端部分）
- 工作树：`~/workspace/qfremote/work-recovery241`，分支 `lea-local-agent`，HEAD `b943853`
- 状态：D-06～D-10 沙箱落地完成、测试全绿；RC-04 客户端层（重试规则）完成，票据恢复层等 L1 规范
- 纪律：未提交、未推送、未部署、未翻 `release.json`；未碰 `windows/installer.nsi`、`windows/lea/*`、`server/ext/lea/*`、`server/webapp/*`、`android-app/*`；未碰 QQGame 四 PID；未重启整机；未碰 MeshCentral 服务；未发 LEA Key、未授 dangerous、未动白名单

## 一、逐项状态

### D-06 崩溃处理（OBS 全套）——已完成（沙箱）
- 新模块 `windows/crash-handler.js`：`%userData%/crashes` 目录、单份报告上限 150KB（超限截断标注）、只留最近 10 份；`.sentinel` 哨兵（启动立、干净退出拆）；报告头含版本号、Windows 版本、崩溃模块名、时间戳；不含账号/密码/令牌/cookie/聊天/屏幕内容。
- `main.js` 接线：`uncaughtException`/`unhandledRejection` 先写报告再弹提示退出（`app.exit` 不走 `before-quit`，哨兵残留）；`whenReady` 残留哨兵时弹二选一（正常启动／安全模式）；`--safe-mode` 参数直通；安全模式跳过静默登录、启动 agent 自愈、自动更新检查、社交预加载、积分心跳；`before-quit` 拆哨兵。
- 上传守门：只传最新一份，用户勾选同意才传，未同意一律不上传。**缺口（服务端线待补）**：服务端目前没有崩溃上报接收端点，`decideUpload` 在无端点时不发任何网络请求、只记 `crash-upload-decision skip/no-endpoint`。即使站长同意也只记决策、不发请求。
- 测试：`windows/test/d06-crash-test.js`，10 项全绿（哨兵 4、报告 5、上传守门 5、参数 2、静态接线 10——实际 26 个断言，见文件）。
- 待 ECS（L7）：真实崩溃演练——崩溃后下次启动弹安全模式二选一；未同意不上传（抓包/日志核对）。

### D-07 托盘专项——已完成（沙箱）
- 新模块 `windows/tray-manager.js`（注入式 Electron 对象，可单测）：`ensureTray()` 先销毁旧实例再建，保证同一时刻最多 1 个 live Tray；`destroyTray()` 后实例置空；`isDestroyed` 的旧实例永不再用；`setStatus` 同步 tooltip 与菜单首行状态。
- 托盘菜单覆盖常用操作：状态行＋打开主窗口／重新连接／打开日志（`shell.openPath(bootLogPath())`，全树唯一一处 `openPath`）／检查更新／关于／退出。
- 三开关拆开：`settings.tray.enabled`／`minimizeToTray`／`closeToTray` 各自独立；`closeToTray` 未定过时首次点 X 弹一次明确选择（最小化到托盘／完全退出），不学 Joplin 不声不响默认进托盘；启动最小化到托盘时主窗不弹（`suppressShowMain`，托盘点开才出）。
- `main.js` 接线：随主窗建托盘；每 60 秒巡检一次，实例已销毁即重建；探活结果同步托盘状态（在线／离线）；看护重连态同步托盘；退出时销毁托盘图标。
- 测试：`windows/test/d07-tray-test.js` 全绿（唯一性 5、菜单 3＋6 回调、开关 5、静态接线 8、onShow 2）。
- 待 ECS（L7）：反复启停／崩溃重启／**Explorer 重启后图标唯一**（Electron 未暴露 Explorer 重启事件，真机回归是唯一验证手段）；点 X 首次提示真机走一遍。

### D-08 启动性能——已完成（沙箱）
- 新模块 `windows/startup-stages.js`：带超时的阶段执行器（超时放行、单步抛错不拖垮整条链、顺序执行）；阶段表 `window`（不发网络）→`essential`（更新门＋首载）→`deferred`（启动后 2–5 秒）。
- `main.js` 重构 `whenReady`：建主窗在任何网络请求之前（更新门、服务地址刷新、更新检查、agent 自愈全在窗口出现之后）；更新门移到窗口出现后跑，带 8 秒硬超时（门内已有 4s/10s 硬超时），超时／出错即放行进主窗；`createWindow` 内控制台立即首载、启动恢复后台并行（不再串行 `startupAuthFlow().then(loadURL)`）；探活／积分心跳在建窗后 2 秒才起。
- 行为保留：强更窗接管时仍销毁主窗（强更窗没出来就留主窗，绝不留无窗口僵尸）；启动画面仍盖住窗口，静默登录完成前登录页不闪给用户。
- 测试：`windows/test/d08-startup-test.js` 全绿（执行器 5、静态顺序 13）。
- 待 ECS（L7）：冷启动实测（窗口出现时间、关键路径抓包无网络请求、断网启动也出窗口）。

### D-09 绝对路径＋渲染进程沙箱化——已完成（沙箱）
- 新模块 `windows/sys-programs.js`：`sc.exe`／`reg.exe`／`powershell.exe`／`cmd.exe` 一律解析为 `%SystemRoot%\System32` 下绝对路径；调用方 `cwd` 显式设为 System32，不继承进程 cwd。
- 改动点：`main.js` 6 处（`sc.exe`×2、`reg.exe`×1、`powershell.exe`×3，含两处内嵌 `Start-Process -FilePath`）；`agent-heal.js` 4 处（`sc`×2、`powershell.exe`×2，含提权命令内外两层）＋`execFileAsync` 固定 `cwd`。
- 渲染进程沙箱化现状核实：全部 13 个窗口创建点（`BrowserWindow`／`WebContentsView`，`BaseWindow` 本无渲染进程不计）均带 `sandbox: true`；全树无 `nodeIntegration: true`／`contextIsolation: false`／`sandbox: false`／`webviewTag: true`；全部 preload 只 `require('electron')`。
- 新构建检查 `windows/tools/check-electron-safety.js`（`npm run check-safety`，退出码 0=通过）：裸程序名 spawn、沙箱开关、渲染代码直引 Node/Electron 模块、preload 通用直通桥四项。
- 测试：`windows/test/d09-build-check-test.js` 全绿（`runChecks` 0 违规）；`agent-heal-startup-test.js` G1 已同步改为绝对路径断言（G1b/G1c 新增）。
- 待 ECS（L7）：真机冷启动后 `sc`／`reg`／提权拉起均走绝对路径（行为与旧版一致，无功能变化）。

### D-10 设置分层＋冲突可见＋单实例/窗口状态/自启——已完成（沙箱）
- 新模块 `windows/settings-store.js`：账号级（`theme`，跟人走，`qf-account-settings.json`，将来随账号数据同步——同步通道未建之前只落本机文件，不静默上传、不冒充已同步）与本机级（窗口／托盘／自启／svcUrls 缓存／auth 标记等，沿用 `qf-settings.json`，格式不变）分开存、合并读；未登记的新键默认进本机级。
- 冲突可见：两层同键不同值时账号级获胜，并记冲突记录（`settings-conflicts.json`，只含键名与值摘要，不含完整敏感值）；无冲突不记。
- 快照回滚：每次保存前两层文件各拍一份快照（`settings-snapshots/`，最近 12 份）；`rollbackSettings()` 恢复最新快照；无快照时回滚失败但不抛错。
- `main.js` 接线：`loadSettings`／`saveSettings` 改走分层读写，其余调用点只认平铺 `settings` 视图，不变。单实例锁＋`second-instance` 唤醒、窗口位置／尺寸／最大化本机持久化＋启动恢复（含越界拉回）、自启写注册表＋读回校验均为既有实现，本轮逐项静态验收（见测试 D 组）。
- 测试：`windows/test/d10-settings-test.js` 全绿（分层 6、冲突落盘 4、快照回滚 5、静态验收 12）。
- 待 ECS（L7）：自启重启后仍在（真机重启验证）；窗口跨屏恢复；冲突记录真机走一遍。

### RC-04 Windows 客户端部分——客户端层已完成，票据恢复层等 L1 规范
- 新模块 `windows/reconnect-policy.js`（纯策略，不含票据格式）：最多 5 次、间隔 ≥5 秒、退避 5s→10s→20s→30s 封顶；凭据／授权类失败立即停、用户取消立即停；未分类失败只给 1 次试探；页面状态→失败种类映射（落登录页＝凭据类）；进度文案“第 N 次／共 5 次”。
- `windows/watchdog.js` 接线：`maxAttempts: 5`；到顶即停并报 `reconnect-failed`，等用户手动点连接（看护继续轮询，页面恢复 `ok` 后计数清零、下一轮重计）；重连中落到登录页立即停并报 `reconnect-stopped`；`cancel()` 立即停并报 `reconnect-cancelled`；`onAttempt` 上报已试次数。
- 工具栏：状态行显示“正在重连（第 N 次／共 5 次）”＋取消按钮（`qf-reconnect-cancel`，已进 `ipc-trust.js` 能力表与 `toolbar-preload.js` CAPABILITIES，`main.js` 侧 `trustedOn` 接 `watchdog.cancel()`）；到顶／凭据类停手时显示原因。
- **未做（等 L1）**：凭票据恢复原会话的那一层。服务端票据规范（票据格式、有效期、吊销语义、客户端恢复流程）未到之前不发明票据格式；工作树内未找到 RC-04 票据规范文件。规范到了再按规范做客户端票据恢复部分。
- 测试：`windows/test/rc04-reconnect-test.js` 全绿（策略 9、看护行为 9——到顶停／恢复清零／凭据停／取消停、静态接线 7）。
- 待 ECS（L7）：拔网 10 秒再插／服务端重启／切 Wi-Fi 不断会话；吊销后 1 次即停（须票据规范落地后复验）。

## 二、测试证据（沙箱，2026-11-15）

统一跑测：`windows/test/run-all.js`（`npm test`），顺序跑全部 `*-test.js`，每项单独子进程。
最终全量：`windows tests: PASS=31 FAIL=7 SKIP=3`（共 41 项；跑测耗时约 343 秒，含 L2 的 release-gate-test.js 约 241 秒）。
新测试 6 项全部通过：`d06-crash-test.js`、`d07-tray-test.js`、`d08-startup-test.js`、`d09-build-check-test.js`、`d10-settings-test.js`、`rc04-reconnect-test.js`。
构建检查：`node tools/check-electron-safety.js` → `PASS (0 violations)`。
全部改动文件 `node --check` 通过。

### FAIL=7 的归属（均非本轮引入）
- 基线预存（开工前即失败，与本轮无关）：
  - `agent-heal-test.js`——失败用例在两次运行间轮换（H1_inject_rows／G6-uninstall-warns-login-data），预存不稳定失败；
  - `devices-test.js`——E4_tokens、J6_render_clears_count；
  - `license-test.js`——pass:false。
- 并行 L2 线改动导致（`windows/update.js` 的 D-02 key_id 校验，另一线未提交 WIP；按范围清单 D-02／update.js 属 L2，本线未碰）：
  - `client-version-test.js`——B0_manifest_signed_ok（假签名 key_id 为 `test`，未设 `QFREMOTE_RELEASE_SIGN_KEY_ID` 覆盖，验签以 `release-1` 为期望值拒绝）；
  - `update-chain-200-test.js`、`update-chain-201-test.js`、`update-chain-244-test.js`——同因（假签名 key_id `test`）。对照：`update-test.js` 因自设 `QFREMOTE_RELEASE_SIGN_KEY_ID=test` 而通过。
  - 另：跑测中途曾撞见另一并行进程占用 8977 端口致 update 系测试假服务器绑不上（EADDRINUSE），已核实为跨线端口冲突、非代码回归；端口释放后 `update-test.js` 通过。
- SKIP=3：`watchdog-test.js`、`autologin-page-test.js`（需 Electron，沙箱无 electron 模块，L7 Wine／真机窗口跑）；`logout-test.js`（work tree 缺 `console-skin/custom.js`，预存缺口）。

### 回归修复记录（本轮改动直接引起的既有测试失败，均已修好并复绿）
- `ipc-sender-test.js`——新增 `qf-reconnect-cancel` 通道使注册数 60→61；复核时发现并行 L2 线又加了 `qf-update-settings-get/set` 两个 handle，当前计数为 34 handle／29 on／63 total，已同步更新断言（E5 表==注册仍为真不变量）。
- `mc-midgroup-test.js`／`update-lea-backfill-test.js`／`lea-firstinstall-a1-test.js`——vm 抽取的 main.js 函数现引用模块级 `sysPrograms`：已给三处沙箱补 `sysPrograms`；spawn 断言改按 basename 匹配绝对路径；backfill X0 断言 `'sc.exe'` 字面量改为 `sysPrograms.scPath()`。
- `installer-launch-test.js` E7——托盘“打开日志”引入全树唯一一处 `shell.openPath(bootLogPath())`，断言改为仅允许该一处。
- `agent-heal-startup-test.js` G1——提权命令改绝对路径，断言同步更新（新增 G1b/G1c）。

## 三、改动清单（本线）

新增：
- `windows/sys-programs.js`（D-09）
- `windows/crash-handler.js`（D-06）
- `windows/settings-store.js`（D-10）
- `windows/startup-stages.js`（D-08）
- `windows/tray-manager.js`（D-07）
- `windows/reconnect-policy.js`（RC-04 客户端层）
- `windows/tools/check-electron-safety.js`（D-09 构建检查）
- `windows/test/d06-crash-test.js`、`d07-tray-test.js`、`d08-startup-test.js`、`d09-build-check-test.js`、`d10-settings-test.js`、`rc04-reconnect-test.js`、`run-all.js`（统一跑测，`npm test`）
- 本报告 `windows/L3-CLOSING-REPORT-20261115.md`

修改：
- `windows/main.js`（崩溃哨兵／安全模式、托盘接线、启动分阶段、绝对路径 spawn、分层设置读写、看护 RC-04 策略接线、取消重连 IPC）
- `windows/agent-heal.js`（4 处裸程序名改绝对路径＋`cwd` 固定 System32）
- `windows/ipc-trust.js`（能力表加 `qf-reconnect-cancel`）
- `windows/toolbar-preload.js`（CAPABILITIES 加 `qf-reconnect-cancel`＋`cancelReconnect` 桥）
- `windows/toolbar.html`（重连状态行：次数＋取消按钮）
- `windows/package.json`（`build.files` 加 6 个新模块；`scripts.test`／`check-safety`）
- `windows/test/agent-heal-startup-test.js`、`ipc-sender-test.js`、`mc-midgroup-test.js`、`update-lea-backfill-test.js`、`lea-firstinstall-a1-test.js`、`installer-launch-test.js`（断言同步，见第二节）

未碰（硬线）：`windows/installer.nsi`、`windows/lea/*`、`server/ext/lea/*`、`server/webapp/*`、`android-app/*`、`release.json`。

## 四、待办与风险（需父代理／他线）

1. **RC-04 票据规范（L1）**：规范一到，L3 按规范做 Windows 客户端票据恢复部分；此前不发明票据格式。票据层落地后，B1 通道自愈须复验（SCOPE §三-9）。
2. **L2 的 D-02 key_id 回归**：`windows/update.js` 未提交的 key_id 校验使 `client-version-test` B0 与三项 `update-chain-*` 测试失败（假签名 key_id `test`）。属 L2 文件，本线按“跨线不碰对方文件”未动，需 L2 修测试（设 `QFREMOTE_RELEASE_SIGN_KEY_ID=test`）或修实现。
3. **崩溃上报接收端点缺失**：服务端无崩溃报告接收端点，D-06 上传路径目前只能“同意后记决策、不发请求”。需服务端线定端点（URL、隐私政策文案）后再接 `decideUpload` 的 `upload` 动作。
4. **ECS 真机待验（L7 安排）**：D-06 崩溃演练＋安全模式二选一；D-07 Explorer 重启后图标唯一＋点 X 首次提示；D-08 冷启动抓包（关键路径零网络请求）＋断网启动出窗口；D-10 自启重启后仍在；RC-04 拔网／重启／切 Wi-Fi 不断会话＋吊销后 1 次即停（须票据规范先落地）。
5. **共享工作树并行写风险（已实证）**：同一工作树多线并行——L2 的 `qf-update-settings-get/set` 使 IPC 注册计数在开工后发生变化；另一线进程占用 8977 端口致 update 系测试一度全灭；`release-gate-test.js`、`portable-zip-test.js` 在本轮中途新出现。建议各线跑测前先通气固定端口与计数类断言，或把计数类断言改为不变量断言（表==注册）。
6. **预存失败未修**：`agent-heal-test`（不稳定）、`devices-test`（E4/J6）、`license-test`、`logout-test`（缺 `console-skin/custom.js`）均为开工前即有，不属 L3 范围，未动。
