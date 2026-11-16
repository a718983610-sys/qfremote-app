# QFRemote Windows 控制端（v1.0.5）

## 待统一发版：自动重新登录 + 记住账号密码（壳侧已落地，版本号由总线统一升 2.3.0）
- **自动重新登录（autologin.js）**：勾过「记住此设备」后，除本人亲手点「退出账号」外，
  关软件重开、崩溃、服务器重启、会话过期、断线恢复都自动恢复已登录。次序：先探活
  persist:qfremote 持久分区里的会话（服务端 30 天有效期）是否还成立，成立直接进；
  不成立且存有凭据时，主进程直接提交登录（不闪登录页），回程 cookie 写回同一分区。
  cookie 一有变动就刷盘、退出前再刷一次，防崩溃丢登录态。自动提交失败立刻停手并在
  登录页给中文提示，绝不反复试密码（单次运行最多 2 次、失败后本运行内不再试）。
- **记住账号密码（creds.js）**：登录页在「记住此设备」下方多一个「记住账号密码」勾选
  （壳注入，与「记住此设备」互相独立）。勾选并登录成功后，账号密码经 Electron
  safeStorage 加密落盘（Windows 上底层为系统 DPAPI，与当前 Windows 用户绑定），
  文件在用户数据目录 `qf-creds.json`，只有一段 base64 密文、无任何明文；系统加密
  不可用时拒绝保存，绝不明文落盘。每次打开登录页自动回填。清除时机：手动退出账号、
  登录时没勾此框（视为关闭记住）、亲手清空已回填的输入框。安全口径如实：本机能以
  该 Windows 用户身份运行的程序可解开它，它防的是明文躺磁盘与整盘拷贝，不是绝对安全。
- **手动退出是唯一人工终止**：壳三路检测退出（会话请求拦截 /logout、页面导航、
  页面内退出点击标记），命中即清会话 cookie（xid、xid.sig、qfrem 全清）、清保险箱、
  清记住标记，回到登录页后不再自动登录，直到下一次亲手登录成功。
- **二次验证不介入**：登录走到验证码页时壳不自动提交、不收割，等用户完成。
- **运行时已升级**：Electron 35.7.5 → 45.0.0（Chromium 156 / Node 24），
  electron-builder 26.0.12 → 26.18.0；持久分区、内容视图、各 preload 桥、更新器、
  隐私锁 IPC 均已在新版实测通过，全量单测（test/ 共 9 个）全绿。

# 以下为历史版本说明

给 QFRemote 服务端（MeshCentral，https://app.qfremote.top ）配的 Windows 桌面控制端：
（2026-11-10 2.4.5：旧生产 IP 已退役，统一走域名 app.qfremote.top；端口映射：旧 :8443/:8444/:8445 直连端口改为域名 :443 同源反代，/friends、/register、/release.json、/dl/ 均同源。）
Electron 外壳，双击打开就是控制台，免开浏览器、免点证书警告；登录状态会记住，下次免登。

## v1.0.5 内容（在 v1.0.4 基础上）
- **好友入口（双端同发）**：工具栏新增「好友」按钮（人形＋加号，更新徽标左侧），点击在现有
  WebView 里打开好友页 `https://app.qfremote.top/friends`（独立小服务 qfremote-friends），
  不新开窗口。好友页与控制台同账号体系、会话独立，需再登一次（更新说明已写明）。
  好友能力：按账号搜索、申请/同意加好友；把自己的设备组共享给好友（默认只看档，
  可选操作档），删好友自动收回共享。
- **证书/导航白名单扩一个端口**：main.js 的 `ALLOWED_PORTS` 由 `['8443']` 改为
  `['8443', '8445']`，证书校验（certificate-error）与导航判定（isTargetUrl）两处共用——
  仍只认自家主机 app.qfremote.top 的证书，其余站点照旧拒绝。更新信任口径不变
  （清单与安装包仍只认 8443 origin）。
- 安卓版同版 1.0.5（仓库 qfremote-app，工具栏加好友按钮、WebView 证书放行同主机 8445、
  清单 `android` 条目同批发布；签名与 1.0.4 同一把专属钥）。
- v1.0.4 全部能力保留（见下）。

## v1.0.4 内容（在 v1.0.3 基础上）
- **更新政策（用户 2026-10-24 09:43 亲定，与 QFClash 同款口径）**：
  - 运行中：查到新版只提醒不强制——工具栏徽标＋关于面板说明，一次会话只提醒一次，不弹挡路框，用户可继续用；
  - 待更新落盘：查到新版立刻把待更版本等记进 `qf-settings.json` 的 `pendingUpdate`，退出也留着；
  - 下次启动先过**启动门**（main.js 的 `startupUpdateGate`，只判这一次）：待更还在、能连上服务器、
    且清单确实比本机新 → 先出**强制更新页**（force-update.html，家族风格）再进控制台。
    强更页写清从 X 版到 Y 版＋更新说明，只有一个「立即更新」按钮：下载带进度条、下完验 SHA256，
    验过出「打开安装包」；没有关闭、没有跳过，不装进不了软件。点开安装包后本应用退出、
    把前台交给安装程序（是交接，不是闪退）；装完的新版首启会自动清掉待更标记；
  - 启动时连不上服务器：放行进软件（后台照常探活与查更新）；本次启动内后来连上也只回到「提醒」档，
    强制只在启动那一下执行。关于页里有给用户看的大白话版规矩（「更新规矩」一段）。
- **新账号自助规则（服务端侧，工具在 `~/workspace/qfremote/account-kit/`，说明见其 README）**：
  给别人开的新账号一律随机生成账号名＋随机初始密码；密码对方在软件里随时自改、不限次
  （MeshCentral 原生功能）；账号名能改一次——官方没有自助改名，用户的一次由站长通道
  执行（mcdb rename 默认模式、台账 renameCount 当闸门），用完后站长可 --admin-override
  在后台再改（留痕、不消耗用户次数）。站长管理员账号永不纳入此流程。
  站长管理员账号永不纳入此流程。
- **注册入口（同轮服务端新增，见 `~/workspace/qfremote/register-svc/`）**：关于页加
  「注册新账号」按钮，系统浏览器打开注册页 `https://app.qfremote.top/register`
  （独立注册小服务：开放注册、无注册码，填账号＋密码＋确认密码即可；账号须至少 8 位、
  字母和数字都要有，重名提示「该账户已被注册」；注册失败超 5 次封设备到次日 0 点；
  校验过了后台建号；MeshCentral 自带公开注册保持关闭）。
  注意：8444 需 Lightsail 放行后公网才打得开。软件本身只管账号密码登录，不做注册。
- v1.0.3 全部能力保留（见下）。

## v1.0.3 内容（在 v1.0.2 基础上）
- **软件内更新（真机制，update.js）**：应用启动后自动查一次更新，关于面板也有「检查更新」手动按钮；
  查的是服务器上的版本清单 `https://app.qfremote.top/release.json`（挂在服务器 meshcentral-web/public
  官方覆盖目录，与 favicon 同机制）。清单格式（JSON）：
  `version`（如 "1.0.4"）、`notes`（大白话中文更新说明）、`url`（安装包下载地址）、
  `sha256`（安装包完整 SHA256，**每版必须写全**）、`size`（字节数）。
  行为：清单版本高于本机 → 工具栏出橙色提示徽标、关于面板显示新版本号＋更新说明；
  点「下载更新」把新包下载到下载文件夹（带真实进度条），下完**自动核对大小与 SHA256**，
  对得上才提示可安装并出现「打开安装包」按钮；对不上立刻删文件并如实提示；
  取不到清单/网络失败 → 安静无提示，绝不弹错误框。
  信任口径：清单与下载地址只认自家主机 app.qfremote.top 这一个 origin，清单里 url 指向
  别处直接拒绝；自签证书的 Node 侧放行只对该 origin（同探活口径、不带任何凭据），
  完整性最终兜底是 SHA256 核对。
- **诊断一键复制**：关于面板「复制诊断信息」按钮，把一段中文文本复制到剪贴板：
  软件版本号、构建日期、系统版本、最近一次服务器探活结果与时间、断线/重连事件计数
  （整页断线次数、看护自动重连次数，计数存在既有设置文件 qf-settings.json 的 stats 里）。
  内容不含任何账号密码（拼装点只在 main.js 的 buildDiagnostics 一处，可查）。
- **快捷键补全**：F5 刷新页面、F9 截图、F10 窗口置顶、F11 全屏、Ctrl+加/减/0 缩放。
  选键时避开了控制台内页常用组合（不用 Ctrl+R、Ctrl+Shift+S、Alt 系），
  键位写进了对应按钮 tooltip 与关于页的快捷键清单。
- v1.0.2 全部能力保留（见下）。

## 发版步骤（写死，三步缺一不可）
以后发新版只走这三步，用户在软件里点更新即可；通知用户只报「从 X 到 Y」：
1. **传新包到服务器更新源**：把新版安装包（如 QFRemote-Setup-v1.0.4.exe）传到服务器
   meshcentral-web/public 覆盖目录（对外地址 https://app.qfremote.top/dl/QFRemote-Setup-v1.0.4.exe ）。
2. **改 release.json 清单**：同目录的 release.json 改四项——版本号、更新说明（大白话中文）、
   完整 SHA256、大小（字节数），url 指向上一步的新包。清单一改，老版本软件下次启动就能查到。
3. **同步官网**：官网仓库 qfremote-website 的产品数据文件逐项对齐新版实况——版本号、下载链接、
   大小、SHA256、更新日志、截图、功能点，一项都不许旧。
   对齐口径：以 `~/workspace/qfremote/app-v1/` 最新产物＋当次发版回报数据为准。
   （软件变化官网必须同步变化，用户 2026-10-24 09:02 亲定。）

## v1.0.2 内容（在 v1.0.1 基础上）
- 工具栏双主题：亮蓝（原）／深灰深色（不用纯黑，对齐 QFClash 双主题规矩），工具栏一键切换、选择持久化；
  启动/加载/断线三页与关于窗的配色随主题联动（页面经 `t` 参数拿主题）。
- 服务器状态灯：工具栏一颗真探活指示灯——主进程每分钟向服务器发一次不带凭据的 HTTPS GET，
  绿=可达、红=不可达、黄=检测中；点击灯显示最近一次检测结果与时间（悬停提示里也有）。
  探活只驱动指示灯、不参与信任决策（见 main.js 探活段注释）。
- 一键截图：工具栏相机按钮把当前控制台画面存成 PNG 进下载文件夹（QFRemote-年月日-时分秒.png），
  存完工具栏浮现一行反馈（capturePage 官方能力）。
- 关于面板补全：独立小窗，含版本号、构建日期（构建时由 tools/gen_build_info.js 生成 build-info.json）、
  服务器地址、「检查服务器状态」真按钮（当场探活一次并显示结果/时间/耗时）。
- v1.0.1 全部能力保留：断线友好页自动重试、会话看护自动重点连、窗口记忆、单开、
  全屏/缩放（百分比）/置顶、开机自启默认开且可关、证书只对自家主机放行。

## v1.0.1 内容
- 界面按 QFClash 家族设计语言重做：新图标（多层蓝渐变＋圆头信号弧＋橙点光晕）、亮蓝渐变工具栏、
  玻璃卡片式的启动/加载/断线页、金色轨道环母题。
- 断线友好页：整页加载失败时显示自家中文页（图一标＋「连不上服务器，正在重试」＋倒计时＋立即重试按钮），
  退避 5s→10s→20s→30s 封顶，网络恢复自动回到控制台。
- 连接看护（watchdog.js）：控制台里桌面会话断开（页面出现「已断线」＋「连接」按钮）时自动重点连，
  两次确认才动手、点击间隔指数退避封顶 30 秒、不限次数；工具栏只显示一行小字，绝不弹窗、不踢回登录页。
  登录页有豁免判定，不会误点。判定逻辑与重试策略的说明写在 watchdog.js 文件头注释里。
- 窗口记忆：大小/位置/最大化状态下次照旧恢复；单开：重复双击只唤起已有窗口。
- 工具栏真功能：全屏（F11）、页面缩放（Ctrl+加/减/0，带百分比显示）、窗口置顶；开机自启默认开、工具栏可关。
- 启动衔接：内容视图预垫品牌深蓝、启动画面最短停留 850ms，不露白屏。

## 安全口径
- 证书放行只对 app.qfremote.top 这一个主机生效（主进程 certificate-error 里校验主机+端口，见 main.js），
  其他站点一律不放行。
- 代码里没有任何账号密码，登录由用户自己在软件里输入。
- 软件内更新的下载与校验只走上面同一信任口径，不另放宽（见 v1.0.3 节）。

## 构建（本机实际出包路线，Linux 沙箱）
0. `node tools/gen_build_info.js` 生成 build-info.json（版本号＋构建日期，关于面板用）。
1. `npx electron-builder --win --dir` 出 `dist/win-unpacked`（主程序 PE32+ x64，版本串由此步写入）。
2. 把 win-unpacked 内容用 7z 打成 `app.7z`，连同 Nsis7z 插件（x86-unicode）放到仓库内 staging `windows/build/installer-work/`（S-017：不再用 /dev/shm）
   （本沙箱对磁盘大文件 mmap 会 SIGBUS，必须走内存盘中转；另注意 /tmp 是 512M tmpfs，
   大文件别往 /tmp 堆，会把更新自测的下载挤爆——v1.0.3 实测踩过）。
   —— 7z 与 makensis 的系统版会被沙箱环境重置弄丢，优先用电缓存里的：
   7zz 在 `~/.cache/electron-builder/7zip@1.0.0/*/bin/7zz`，
   makensis 在 `~/.cache/electron-builder/nsis-3.0.4.1/*/linux/makensis`（配 NSISDIR=该缓存根）。
3. 用 `windows/tools/build-installer.sh --plugins-dir <插件目录> --app-7z <app.7z>` 编译内外两层（版本由 BUILD_VERSION 注入，默认 3.0.0；产物进 `windows/dist/`），不要直接拿 makensis 编裸脚本。
   —— electron-builder 自带的 NSIS 收尾在本沙箱跑不了（wine 段错误），故用原生 makensis 与它同款的解压机制手工组装。
4. 图标重绘：`python3 tools/make_icon.py`；v1.0.1 预览拼版：`python3 tools/make_previews.py`；
   v1.0.2 预览拼版：`python3 tools/make_previews_v102.py`；v1.0.3 预览拼版：`python3 tools/make_previews_v103.py`；
   看护逻辑自检：`xvfb-run -a ./node_modules/.bin/electron test/watchdog-test.js --no-sandbox`（本地假页面模拟断开/恢复/登录页）；
   更新模块自检：`node test/update-test.js`（本地假清单服务器，验有更新判定/下载进度/SHA256 核对/坏哈希删文件/外链拒绝）。
   界面预览：以 QFREMOTE_PREVIEW=main|offline|splash 环境变量启动应用截图（offline 模式会在本地拦截目标请求，
   人为走通 did-fail-load → 断线页路径）；主题用 QFREMOTE_PREVIEW_THEME=blue|dark 强制；
   探活可经 QFREMOTE_PROBE_URL 指向本地隧道口（与生产同一探活代码、仅路由不同，预览图里状态灯为真状态）。
   更新界面自测：QFREMOTE_PREVIEW=update 启动（自动等检查结果→开关于面板截图→自动点「下载更新」→下完核对后截图，
   结果写 QFREMOTE_PREVIEW_DIR/_pv_update_result.json），必须同时设 QFREMOTE_RELEASE_URL 指向假清单。
   强更页自测：QFREMOTE_PREVIEW=force 启动（只跑启动门），配合 QFREMOTE_PREVIEW_USERDATA 里预置的
   pendingUpdate 与 QFREMOTE_RELEASE_URL 假清单：被门拦住会截强更页→自动点「立即更新」走真下载→
   核对后截图，结果写 _pv_force_result.json（含「下载完待更仍在」的断言）；门放行时结果里 gated=false。
   **QFREMOTE_RELEASE_URL 是仅测试用的清单地址覆盖开关**：只许指向本机回环
   地址（127.0.0.1 / localhost / ::1，测试假清单服务器用），设置后应用改认
   该地址的 origin 为唯一可信源；非回环地址一律忽略、回落正式 origin；
   生产环境绝不要设这个环境变量，正式清单恒为 https://app.qfremote.top/release.json 。

## 在 Windows 上手工出包
装 Node.js 20+，本目录 `npm install`，先 `node tools/gen_build_info.js`，再 `npm run dist`（electron-builder 官方 NSIS 路线），
产物 `dist/QFRemote-Setup-v1.0.4.exe`（未签名，首次运行弹 SmartScreen，点“更多信息→仍要运行”）。
