# L4 网页端「全进 3.0」执行证据（W-01～W-10、RC-03/04/05/07/08/09/10）

工作树 `~/workspace/qfremote/work-recovery241`（分支 lea-local-agent，HEAD b943853）。
本文件只记已跑出的命令输出与数字，不报未验证的结论。涉真机/浏览器的项先沙箱测，
ECS 窗口验的部分在各节写明等 L7 安排。

## W-05 机械拆分（只拆不动行为）——已完成 ✅

- 拆分：`app.js`（6,188 行 / 423,757 B）→ `qf-schema.js`（纯数据/纯函数）＋
  `qf-runtime.js`（服务层）＋`qf-ui.js`（共享 UI 原语）＋`app.js`（应用壳/视图/启动），
  经典脚本按层顺序加载（index.html 已改四 script 标签）。
- 机械性证明：拆分脚本 `/tmp/qf-l4-tools/split.js` 按顶层语句切分，326 条顶层语句守恒、
  跨文件重名顶层声明 0、加载时求值引用 TDZ 检查通过、`node --check` 四文件全过。
- 分层收敛（第二步 `/tmp/qf-l4-tools/move2.js`）：纯函数移 schema（stateBox/statusSummary/
  brandBlock）、身份簇移 qf-ui（MyProfile 等 12 项）、其余应用壳调用走 `QFHooks` 晚绑定
  （定义在 qf-schema.js，app.js boot 首行注册）；`tests/lint-no-cycles.mjs` 绿
  （schema 42 decls → runtime 27 → ui 39 → app 185，无反向引用、无重名声明）。
- 钉住函数逐字未动（`/tmp/qf-l4-tools/verify-pinned.js`）：bareNodeId、ensureNodeMap、
  applyControlNodes、applyLockDevices、controlNodesContain、probeControlSessionOnce、
  checkSessionIdentity、checkPresence、probeFrame、fetchControlNodes、driveConnect、
  frameNodeMatches、startSlowProbe、fetchNodeMap、invalidateNodeMap、buildSessionFrame、
  sessionDied、checkSessionInner、doLogin、doLogout、forceGate、NODE_MAP_TTL_MS、
  CONTROL_PROBE_MS 全部与拆分前备份逐字一致；buildSessionFrame 内防御(a)调用点仍在。
  （2026-11-15 补充：RC-07 接线后 buildSessionFrame 仅多 10 行中继选址插入，
  其余逐字一致；`/tmp/qf-l4-tools/verify-pinned.js` 已把该 10 行记为文档化例外，
  剥离后比对，见本文件 RC-07 节与 `/tmp/bsf-pre.txt`、`/tmp/bsf-post.txt` 的 diff。）
  checkSession 有意移到 qf-runtime.js（windows/test 不按名抽取它，已核查两测试源码）。
- 回归（拆分后）：
  - Playwright：`split-smoke.spec.mjs` 5/5 ＋ `reduced-motion.spec.mjs` 6/6 ＝ 11/11 通过。
  - `windows/test/logout-p1-test.js`：exit 0，全 pass。
  - `windows/test/session-defense-a-test.js`：exit 0，49 cases 全 pass（含 E 组与 HEAD 比对）。
- 注意：工作树 app.js 与 HEAD 相比本来就有 1,097 行 diff（此前各线未提交变更），
  本线拆分前后以 `/tmp/qf-l4-tools/app.js.pre-split` 备份为比对基准，不以 HEAD 为准。

## W-01 主题收敛为单一 token 注册表——已完成 ✅

- 注册表：新建 `server/webapp/qf-tokens.css`（9,007 B）。原 `app.css` 头部 `:root`＋
  `[data-theme="dark"]` 块（11–60 行）verbatim 移入（值未变），下方追加 W-01 新 token
  25 个（浅/深双值）；`app.css` 删去这两块，改为指针注释；`index.html` 首位 link
  `qf-tokens.css`。执行脚本 `/tmp/qf-l4-tools/w01-apply.py`（逐项断言计数，失败即停；
  预检 `/tmp/qf-l4-tools/w01-preflight.py` 先行核对全部目标，17 处原文不符已按实测修正）。
- 收敛量：`app.css` 用法替换 55 处＋注释改写 11 处、删冗余深色规则 32 条（含漏网的
  `[data-theme="dark"] .bnav`）；`session.css` 替换 20 处；`index.html` 去掉两处
  theme-color 字面量（改由 `applyTheme` 从 `--bg` token 写入）；JS 三处 brand SVG
  改 `style="fill:var(--mark-bg)"/style="stroke:var(--mark-fg)"`、头像 canvas `fillStyle`
  改读 `--paper`。25 个新 token 双主题计算值已逐项核对（基线 `:root-custom-props`），
  与设计表一致。
- 验收（lint）：新建 `tests/lint-no-colors.mjs`，规则＝色值字面量只允许出现在
  `qf-tokens.css` 的变量定义中（含注释、HTML、JS），另查 CSS 引用的 token 全部有定义。
  运行结果：`OK: 7 文件零字面量；注册表 token 数见 qf-tokens.css；CSS 引用全部有定义`
  （exit 0）。附：`session.css` 的 `.viewer` 内自有布局 token（--ink/--canvas-0 等）
  不归 W-01 管，lint 定义域＝注册表＋各文件自身定义。
- 验收（视觉基线零差异，除 1 处有意修补）：`tests/theme-baseline.mjs` 双主题 160 条记录，
  改前 `/tmp/qf-l4-tools/theme-baseline.json` 对改后
  `/tmp/qf-l4-tools/theme-baseline-after-fixed2.json`。初版 diff 31 条，全在深色主题，
  机理是删掉的深色规则原本以高特异度压住后置的深色基规则（419/425 行等）——已补 5 条
  token 化恢复规则（见 `app.css` 末尾 W-01 注释块，逐条注明原因；`--card-shadow` 新 token
  承接原 `.card` 深色阴影）。复核 diff 只剩 8 条，实为同一元素同一属性：
  `.cht-msg.me .cht-bub` 深色文字色 #FFFFFF → #08090A。**此为有意修补，非回归**：原深色
  规则 D19 的第二个选择器写的是 `.cht-msg.me .bub`（`.bub`，不存在的 class；字节核对
  selectorText 70 字符、matches false），从未生效；pre 版深色己方气泡是白字白底（字不可见），
  token 化后文字走 `--on-brand`（深色 #08090A）才可读。浅色无变化。
- 基线脚本修补：`theme-baseline.mjs` 的查询改为只在 `#qf-theme-fixture` 内查——此前
  `document.querySelector` 会抓到 app 自身 DOM 里的同名元素（.top/.bnav 等），受 app 动态
  状态影响不可复现；另：一次“pre 值翻转”是误报（第二次 pre 运行误在当前目录执行，实为
  post 值），pre 值本身稳定为 #FFFFFF。
- 既有行为保留（未悄悄 redesign）：深色主题下无深色规则的卡片（.plan/.paycard/.framebox/
  .planitem/.paytab/.field input/.kfrow 等）仍为白色（--paper 白/白）；`.cht-av.av1` 深色
  文字色仍继承（疑似缺陷，未动，见下）；注释里与代码不符的旧值已改写并注明（如 av1 注释
  称浅 #52525B，代码实为 #4B4B55）。
- 回归（W-01 后，全绿）：
  - `node tests/lint-no-cycles.mjs`：OK（分层未变）。
  - `node tests/lint-no-colors.mjs`：OK（见上）。
  - Playwright：11 passed（split-smoke 5/5＋reduced-motion 6/6，7.7s）。
  - `node windows/test/logout-p1-test.js`：exit 0，pass true。
  - `node windows/test/session-defense-a-test.js`：exit 0，49 cases，failed []。
  - `/tmp/qf-l4-tools/verify-pinned.js`：PINNED OK（钉住函数逐字未动）。
  - `node --check`：qf-schema.js、qf-runtime.js、qf-ui.js、app.js 全过。
- 待后续（不阻塞 W-01）：`.cht-av.av1` 深色文字色继承 `.cht-av` 的 #08090A（深底黑字，
  疑似缺陷，W-01 只做了原样保留；是否修等深查线定）；theme-color 在 JS 执行前无值
  （原静态 meta 已删，applyTheme 在 boot 时写入，约 100ms 内；可接受）。
- 备份：`/tmp/qf-l4-tools/app.css.pre-w01`、`/tmp/qf-l4-tools/session.css.pre-w01`、
  `/tmp/qf-l4-tools/index.html.pre-w01`；对照副本 `/tmp/qf-l4-pre-webapp/`（pre-W01 三文件还原）。

## W-02 WebSocket 收敛为频道式 pub/sub＋三层状态分域——已完成 ✅

- `QFTransport(url, opts)`（qf-runtime.js）：connect/send/onMessage/onState/close；可注入
  `WebSocketCtor` 与 `scheduler`；重连固定间隔默认 5 秒、上限 5 次，耗尽后 state=`failed`；
  断线期间可靠发送入队，重连后按序补发。
- `QFBus(transport, opts)`：频道订阅/退订；建连即重订阅＋调 `opts.onSnapshot(channels)` 补快照；
  可靠通道带 msgId＋seq、断线入队、重连补发、收端按 msgId 去重（上限 1000）；易失通道见 W-03。
  上行订阅消息默认不发（`opts.sendSubscribe` 为 true 时才发 `{action:'subscribe'}`，
  因当前 `/control.ashx` 仍是请求/应答式）。
- 频道命名（qf-schema.js 纯函数）：`qfChannel(kind, id)` 生成 `device:{id}:status`、
  `chat:{id}`、`session:{id}:frame-meta`、`presence:{id}`（id 段剔除冒号与空白）；
  `qfParseChannel(name)` 反向解析。
- 测试：`tests/unit/transport-bus.test.mjs`（Transport 连接/入队/重连补发/5 次耗尽；
  Bus 订阅分发/重订阅＋补快照/去重）＋`tests/w02-w10.spec.mjs` W-02（脚本化 FakeWS 对端，
  订阅分发、断线重连重订阅＋补快照、去重），均绿（见最终回归节）。
- 未动：`fetchControlNodes` 与 `probeControlSessionOnce` 仍直连 `new WebSocket`
  （被 windows/test 钉住，不可改）；探针迁移须走 windows/test 快照更新流程，不由 L4 悄悄改。

## W-03 实时消息分可靠/易失双通道——已完成 ✅

- 可靠通道：带 msgId＋seq，断线入队、重连补发、收端按 msgId 去重（上限 1000）。
- 易失通道：100ms 节流、只留最新值、断线即丢（不进可靠队列；实现中曾误入队，已修为
  `_sendRaw(obj, isVolatile)` 返回 `dropped`）。
- 测试：`transport-bus.test.mjs`（双通道可靠入队＋易失 100ms 节流只留最新＋断线即丢）；
  `w02-w10.spec.mjs` W-03（10 次连发只上行 2 次，第二次为最新值）。均绿。

## W-04 首屏 boot data＋单一状态源——已完成 ✅

- `QFStore`（qf-runtime.js，三层分域，抄 tldraw）：docs（持久：devices/friends/chat）、
  session（只留本实例）、presence（只放内存，永不落盘）；`subscribe/setDoc/seedDocs/
  setSession/setPresence/snapshot`；`setDoc` 数组记录走 `reconcileRecords`，写操作经
  QFLocal 持久化＋跨标签页广播。
- `qfApplyBootData()`：读 `window.__QF_BOOT__`（用户/主题/设备列表/presence）播种 `S` 与
  QFStore；无注入返回 null，原有流程不变；不改 `S.auth`（登录态仍由 checkSession 校验）。
  `boot()` 在 `Cache.load()` 之前调用；`QFLocal.load('docs','devices')` 读快照播种 store
  （无 boot data 时）；`QFLocal.onBroadcast` 接 docs 快照与草稿。
- `QFNotifier`：ETag 条件轮询（抄 Nextcloud）：GET `/license/api/me`，有 ETag 即用
  `If-None-Match`，无 ETag 则用关键字段指纹（activeBan/planName/displayStatus/username）比对；
  304 或指纹不变时降频到 300 秒（底噪 120 秒）；变化时走 `QFHooks.checkSessionInner(true,
  {force:true})` 复核（不另起封禁判定）；只在已登录且页面可见时跑；用原生 fetch
  （因 `api()` 丢弃响应头，读不到 ETag）；测试钩子 `QFNotifier._fetchFn`。
- 接线：`Views.devices` 在 `S.stats` 回填后 `QFStore.setDoc('devices', mine)`。
- 测试：`store-local.test.mjs`（QFStore reconcile＋持久化＋presence 永不落盘；QFNotifier
  304 降频/指纹不变降频/变化走 checkSessionInner）；`w02-w10.spec.mjs` W-04
  （`__QF_BOOT__` 播种 store＋深色主题）。均绿。
- 诚实边界：服务端 boot data 注入未做（nginx 静态根目录 `/opt/qfremote-webapp`），
  客户端只做消费端，须发版/部署线加渲染步；ETag 服务端支持未确认（`/license/api/me`
  目前不一定回 ETag，客户端已做指纹比对兜底）；“各页只读 store”本次只迁移了设备列表
  写入 store，其余视图仍读 `S`，为后续迁移，不谎称全站已迁移。

### W-04 服务端注入（补，2026-11-15）——已完成 ✅

- 实现：新建 `server/webapp/boot-data.mjs`（Node ESM，零依赖，浏览器不加载）＋
  契约文档 `server/webapp/BOOT-DATA.md`；`index.html` 的 `<head>` 内加占位注释
  `<!-- QF_BOOT_DATA -->`（静态直出时无害，客户端走原有流程）。
  - `qfBuildBootData(snapshot)`：白名单清洗。顶层只出消费端逐项读的键
    （`v/user/displayName/isAdmin/license/theme/devices/presence`）；`license`
    只留首屏展示字段（`planName/displayStatus/statusNote/maskedKey/hasKey/
    webEnabled/webBy/trialExpiresMs/keyExpiresMs/keyPlan/keyLifecycle/
    keyDurationHours/remainText/slots/everBanned/activeBan`，`slots` 与
    `activeBan` 再按子白名单清洗）；`devices[]` 按 `/home/api/stats` 形状
    （`id/name/os/group/nodeid/online/onlineUnknown/stale/lastAgentPong/
    lastAgentPongAgeMs/agentConnectedAt`，无名丢弃，上限 500）；
    `presence` 值只留标量字段；`theme` 只认 `dark`/`light`；其余一律丢弃
    （LEA Key、apiKey、token、票据、密码、session、`/license/api/me` 的
    `decision`/`forceLogout`/`keyId` 等即使上游误传也不进页面）；无有效内容
    返回 null（不注入）；返回值经 JSON 往返与上游脱钩。
  - `qfBootDataHasSensitive()`：注入前再扫键名（`maskedKey` 明确豁免），命中
    即拒绝注入、原样出静态页。`qfBootDataScript()`：`<`/`>`/`&`/U+2028/U+2029
    全转义，注入脚本内永不出现字面 `</script>`。
  - `qfRenderIndexHtml()`：占位替换（只换第一处）；无占位退到 `</head>` 前；
    无 boot 时原样返回（字节一致）。`createBootDataHandler()`：只认 GET/HEAD
    的 `/` 与 `/index.html`，其余返回 false 交上游；`getSnapshot(req)` 返回
    null（未登录）或抛错、清洗为空、自检命中时一律 fail-closed 出静态模板；
    注入页强制 `Cache-Control: no-store`＋`Vary: Cookie`。
    `createBootServer()` 为同款逻辑的参考实现（静态＋注入，供测试与部署线参考）。
  - 生产接线（部署线做，见 BOOT-DATA.md）：`getSnapshot(req)` 内用已鉴权会话
    取数（`resolveAuth` → `buildHomeStats` → `buildStatusView`），只在已登录时
    返回快照；nginx 保持 `location = /index.html { return 301 /; }`，渲染器挂
    在 `/` 后面。`theme` 注意：服务端现无账号级主题存储，生产快照一般不带
    `theme`，客户端沿用本地偏好；字段已端到端打通，等服务端存了偏好再填。
- 消费端接线缺陷（本线实测发现并修复，改动在 `server/webapp/app.js` 的
  `boot()` 缓存回填分支，钉住函数未动）：`qfApplyBootData()` 先播种
  `S.license`/`S.displayName`/`S.isAdmin`，随后 `S.license = cache.license`
  无条件覆盖——缓存无 license 时把刚播种的 boot 快照清成 `undefined`
  （`isAdmin` 同理被 `!!cache.isAdmin` 清成 `false`）。已加守卫：注入带了的
  字段不许缓存回填盖掉，没带才回填；`S.user` 不动（换账号判定归
  `checkSession`）。改后按 W-08 重算 hash：`app-584f618a.js` →
  `app-544c3587.js`（其余 6 个 keep），`ASSETS.json` 与 `index.html` 已同步。
  附带修：`tests/bump-version.mjs` 的引用改写只匹配裸文件名，内容变更后重命名
  时 `index.html` 仍指旧 hash 文件（本次实测命中：改名前 `index.html` 仍为
  `app-584f618a.js`，文件已改名，断链）；已改为裸名与旧 hash 名都匹配，
  重跑后 `index.html` 正确指向 `app-544c3587.js`，
  `lint-versioned-assets.mjs` OK。
- 测试（只报实跑数字）：
  - 单测 `tests/unit/boot-data.test.mjs`：11/11 通过（白名单逐项、6 个哨兵敏感值
    全程不出现、自检扫出 `apiKey`/`devices[0].token` 且豁免 `maskedKey`、
    `</script>` 逃逸只剩结尾 1 个、渲染四路、处理器四态、快照抛错 fail-closed、
    参考服务器注入/匿名/静态/404、真实 `qfApplyBootData` 沙箱对齐
    `S.user/displayName/isAdmin/license.planName`＋store devices/presence，
    且 `S.auth` 仍为 `unknown`）。单测全量 `node --test ./unit/*.test.mjs`：
    **54/54 通过，fail 0**。
  - Playwright `tests/boot-data.spec.mjs`：**3/3 通过**（连跑两遍均 3/3）：
    ① 登录态原始 HTML 含 `window.__QF_BOOT__ =` 恰 1 次、占位已替换、无哨兵值、
    `Cache-Control: no-store`；② 匿名原始 HTML 无 `window.__QF_BOOT__ =`、
    进页后 `window.__QF_BOOT__` 为 undefined、store devices 为 0；
    ③ 登录态首屏壳 document 请求恰 1 次（第 2 个 document 请求是 app 既有的
    `/console-engine/?hide=31&qfm=warm` 预热，与注入无关）、无 `boot-data`
    另行拉取、`data-theme` 为 dark、store devices 为 D1/D2（`/home/api/stats`
    桩回空设备列表，证明来自 boot）、`S.displayName` 为 Test User、
    `S.isAdmin` 为 true、`S.license.planName` 首屏为“QFRemote 永久套餐”、
    放行 `/license/api/me`（门控，非时序竞态）后 `S.license.planName` 变回
    空（证明 boot 只是首屏快照，登录态判定仍以 me 为准）。
    修过的测试缺陷（均为测试侧，非实现）：① 匿名断言原用裸 `__QF_BOOT__`，
    但 `index.html` 注释里就写着这个名字，改为以赋值 `window.__QF_BOOT__ =`
    为准；② 首屏 document 计数原断言为 1，实测 app 另发一次 console-engine
    预热，改为壳请求恰 1 次＋无 boot 拉取；③ 首屏 `S.license` 断言原用 2 秒
    延迟等 me 回包，冷启动下仍竞态，改为门控放行（确定性）。
  - 全量回归（改动后最终态）：`node tests/run.mjs` **5 步全 PASS**
    （lint-no-colors、lint-no-cycles、lint-no-hardcoded-i18n、
    lint-versioned-assets、unit）；`npx playwright test` **48/48 通过
    （49.4s）**；`node windows/test/logout-p1-test.js` exit 0（pass true）；
    `node windows/test/session-defense-a-test.js` exit 0（49 cases，
    failed []）。`/tmp/qf-l4-tools/verify-pinned.js` 已不在盘上（临时目录），
    未重跑；替代证据为上述两 windows 测试（内含 HEAD 比对）全绿＋本次
    `app.js` 改动经 `git` 核对仅为 `boot()` 缓存回填分支 3 行改 8 行，
    钉住函数（doLogin/doLogout/buildSessionFrame 等）未碰。
- 诚实边界（更新）：服务端注入完成，但生产接线（`getSnapshot` 挂真实会话取数
  ＋部署到 `/opt/qfremote-webapp` 前端）不在本线做，未部署、未动
  `release.json`、未碰 `server/ext/*`、未碰真机；真实账号登录端到端仍待
  ECS 窗口（L7）；`theme` 生产一般不带（见上）；设备页等视图仍读 `S.stats`。

## W-06 内部组件库＋布局骨架统一＋Storybook——已完成 ✅

- `QFComponents` 注册表（qf-ui.js，`register/render/list/meta`）＋5 个内置组件：
  `button`（.btn 唯一入口，kind primary/grey/ghost/danger，size sm）、`empty-state`
  （.statebox 唯一入口）、`stat-card`（Grafana Stat 式小面板）、`reconnect-strip`
  （RC-04，文案走 `t()`）、`app-shell`（布局骨架；`appShellHtml()` 有 live DOM 时直接取
  `#shellRoot` 的 innerHTML，不复制第二份文案，无 DOM 时返回无文案结构占位）。
  组件只收 props、不读全局 S、不直接调 api；文案由调用方传或走 `t()`；颜色只用 token。
- 文档：`server/webapp/components/COMPONENTS.md`（成文规范：layouts/interfaces/ui 三层放哪、
  6 条规则、已注册组件表、Storybook 说明）。
- 故事：`server/webapp/components/*.stories.mjs`（CSF 格式，5 文件，`node --check` 全过）：
  button（Primary/Grey/GhostSmall/Danger/WithIcon）、empty-state（NoDevices/NoShared）、
  stat-card（Online/Offline）、reconnect-strip（Attempt2Of5/Cancelled）、app-shell（Shell）。
- 画廊验收：`tests/components.spec.mjs` 13/13 通过（2026-11-15 实测 29.6s），
  截图 30 张存 `tests/test-results/gallery/`（12 个故事各 1440 浅色＋390 深色，
  另 Primary 跑满 4 视口 390/820/1440/1920 ×双主题）；断言无页面报错、组件 HTML 非空、
  渲染可见；主题切换用全局 `applyTheme(theme)`。
  修过的测试缺陷：app-shell 故事复制 live 壳（含画廊容器自身）致两个 `#__gallery`，
  截图改 `.first()`。
- Storybook dev 服务未跑（重型安装）；CSF 故事＋Playwright 画廊为验收手段。

## W-07 发版门：Playwright E2E＋Storybook 视觉件＋Lighthouse/WAVE＋20 条深查——已完成 ✅

- runner：`tests/run.mjs`（跑 lint-no-colors、lint-no-cycles、lint-no-hardcoded-i18n、
  lint-versioned-assets、单测，汇总打印）；`tests/package.json` 的 `test` 脚本即本文件，
  `test:unit` 为 `node --test ./unit/*.test.mjs`，`test:e2e` 为 `npx playwright test`；
  `devDependencies` 已补 `axe-core ^4.10.3`（此前仅 `--no-save` 安装）。
  2026-11-15 实测：5 步全 PASS，门禁全部通过。
- 深查 spec：`tests/deep-check.spec.mjs` 6/6 通过（2026-11-15 实测 9.1s），截图存
  `tests/test-results/deep-check/`（DC-03 8 张＋DC-04 4 张）：
  - DC-03 四视口（390/820/1440/1920）×双主题加载无报错；
  - DC-04 交互态全覆盖：头像菜单、抽屉、底部导航、弹窗、遮罩逐个打开截图；
  - DC-05 数项数：非管理员账号菜单 8 项逐项列出（首页/我的账户/我的文件/好友/论坛/
    API 密钥/官方网站/登出）；抽屉 13 项逐项列出（profile＋MENU34 6 项＋FUNC 5 项＋登出）；
    管理员账号菜单 9 项（多站长管理）、抽屉 14 项。**纠正：此前计划写抽屉 12 项有误，
    实测为 13 项（profile 按钮也带 data-nav），以实测为准。**
  - DC-06 颜色对比：打开态菜单/抽屉内每个文本元素对比度 ≥3.0（页面内 WCAG 亮度公式算）；
  - DC-10 抽屉与头像菜单分开点名：两者独立开关、互不干扰。
  - DC-01/02/11/12/13/14/15/16 属流程项，映射到 lint＋单测＋证据文件，不进运行时用例。
  - 修过的测试缺陷（均为测试侧，非实现）：① DC-06 的有效背景 helper 把半透明背景
    （如 `rgba(17,17,19,0.06)`）当不透明取，亮度与前景同色致比值 1.0 误报，已修为逐层
    alpha 合成；② 汉堡按钮只在 ≤760px 可见（app.css `@media(max-width:760px)`），
    抽屉相关用例改到 390 视口，遮罩点改到抽屉外右侧 (380,400)。
- axe 门：`tests/axe.spec.mjs` 2/2 通过（2026-11-15 实测 3.0s），登录页与壳首页
  0 个 critical/serious 违规。仅 moderate 残留（不拦门，记此备查）：登录页
  `landmark-one-main` 1 节点、`region` 10 节点；壳首页 `heading-order` 1 节点、
  `region` 3 节点。
- Lighthouse：`tests/test-results/lighthouse.json`（fetchTime 2026-11-15T03:58:03.788Z，
  登录页未登录态，静态桩服务器，Chrome 为 Playwright 自带 chromium-1255，
  须设 `CHROME_PATH` 否则报 `CHROME_PATH environment variable must be set`）：
  accessibility 98（≥90 ✅）、best-practices 96（≥90 ✅）、performance 65（只记录，
  不设高门，因桩服务器非真实部署）。
- WAVE 未跑：需 API key/浏览器扩展，无法在沙箱跑——发版门人工项，不谎称已跑。

## W-08 文件名带版本号 bust 缓存＋发版必换名——已完成 ✅

- 机制：内容 hash 命名 `base-<sha256 前 8 位>.ext`＋`server/webapp/ASSETS.json`
  （逻辑名→hash 文件名映射）＋`tests/bump-version.mjs`（算 hash、改名、重写 index.html
  的 src/href 引用、去掉 `?v=` 查询串）＋新 lint `tests/lint-versioned-assets.mjs`
  （每个 hash 文件名与内容 hash 一致、index.html 对裸文件名 0 引用）。
  favicon.ico 不纳入 hash 命名（其 `?v=20261114-1` 保留，lint 已排除该项）。
- 2026-11-15 首次 bump（7 个文件全部改名）：
  qf-schema-343acaf4.js、qf-runtime-dcd12be7.js、qf-ui-ba52a6ad.js、app-584f618a.js、
  qf-tokens-eae9c2b6.css、app-372aff29.css、session-6a4bba6a.css；
  `lint-versioned-assets.mjs` OK；第二次 bump 7 个 keep（内容不变则文件名不变，幂等）。
- 引用更新：三个 lint（no-colors/no-cycles/no-hardcoded-i18n）、`unit/load-webapp.mjs`、
  `split-smoke.spec.mjs`（script src 精确断言改为读 ASSETS.json 比对）均经共享
  `tests/resolve-assets.mjs`（ASSETS.json 缺失时回落逻辑名）解析；`/tmp/qf-l4-tools/
  verify-pinned.js` 同样改走 ASSETS.json。
- 连带改动（W-08 后果，路径-only，不改行为）：`windows/test/logout-p1-test.js:106` 与
  `windows/test/session-defense-a-test.js:27-28` 硬编码读 `server/webapp/app.js`，
  改名后 ENOENT，改为经 ASSETS.json 解析当前 hash 文件名；两测试重跑全绿（见最终回归节）。
  `session-defense-a-test.js:278` 的 `git show HEAD:server/webapp/app.js` 未动
  （HEAD 仍有旧路径）。

## W-09 i18n：文案进语言包；新代码硬编码中文归零——已完成 ✅

- `locales/zh-CN.json`、`locales/en.json` 各 38 键（原 6 键＋L5 新增 32 键：relay/quality/
  files/rec 四组），key 一致，en 为真实英文翻译；`QF_I18N_ZH` 内嵌表已同步。
- `t(key, vars)`（qf-runtime.js，`{n}` 插值；查表→中文兜底→原样回 key）、
  `qfLoadLocale(lang)`（fetch `locales/<lang>.json`，失败回落中文）。
- 新 lint `tests/lint-no-hardcoded-i18n.mjs` 全绿：① zh/en key 一致；② 代码里 `t('key')`
  须在 zh-CN.json 存在；③ `QF_I18N_ZH` key 与 zh-CN.json 一致；④ qf-runtime.js/qf-ui.js
  含中文的字符串字面量数不得超 `tests/i18n-baseline.json` 基线
  （`{"qf-runtime.js": 43, "qf-ui.js": 44}`，旧代码 grandfathered，只许减不许增；
  `QF_I18N_ZH` 内嵌表本身排除在计数外，因它受规则③管）。
- 测试：`w02-w10.spec.mjs` W-09（en 包加载后切换、缺 key 回落中文）。绿。

## W-10 本地优先 IndexedDB 持久化＋多标签页同步——已完成 ✅

- `QFLocal`（qf-runtime.js）：IndexedDB 库 `qfremote-web`，表 docs/drafts/meta；
  不可用时回落内存＋localStorage 镜像（键 `qf-idb-fallback:*`）；
  `BroadcastChannel('qfremote-web')`＋storage 事件双通道，`_deliver` 按 `type|tabId|at`
  去重（同消息只投递一次，上限 200 条去重记录）；`tabId` 随机生成。
- 接线：`mountChatThread` 的 input 加 `oninput`（防抖 300ms 写 IndexedDB
  `drafts/chat:<对方>`＋广播；空值则删）；`chOpenConversation` 打开会话即恢复草稿
  （已有输入不覆盖）；`chSendMessage` 在 `await chVaultAppend(...)` 成功后才清草稿
  （发送失败保留可重打）。`boot()` 里 `QFLocal.onBroadcast` 接 docs 快照与草稿
  （只在输入框为空时接，不覆盖本页正在打的字）。
- 测试：`store-local.test.mjs`（QFLocal 假 IDB 存取＋无 IDB 回落、多标签页广播本页不收
  他页收）；`w02-w10.spec.mjs` W-10（草稿跨页可见、广播只投递一次）。均绿。

## RC-05 网页端渲染抄 noVNC「后备缓冲＋脏矩形＋绘制队列」，鼠标 17ms 节流——已完成 ✅

- `QFRemoteRenderer(visible, opts)`（抄 noVNC）：后备 Canvas＋脏矩形＋绘制队列；
  `blit/fillRect` 入队时即标脏区（flush 不再重复标，避免坍缩计数翻倍）；脏矩形重叠/相接
  即并集；并集面积超 60% 即坍为全屏（`stats.collapsedFull` 计数）；`flush()` 按入队顺序
  落到后备缓冲；`present()` 只把脏区 `drawImage` 到可见 Canvas 并清脏区，返回
  `{rects, area}`。
- `QFMouseThrottle`（17ms，抄 noVNC `MOUSE_MOVE_DELAY=17`）：只记最后位置，每 17ms
  最多发一次，待发用定时器补发最新值；计数 `sent/dropped`。
- 测试：`tests/unit/renderer.test.mjs`（4 测试：脏矩形合并/坍缩、绘制队列保序、鼠标
  10 秒 60Hz 画圈上行包数 ≤600（实测在 500～600 之间）、静止不发包/首包立即发）；
  `w02-w10.spec.mjs` RC-05（真浏览器 canvas：100 小矩形 present 只贴脏区、脏区面积
  小于全屏、present <50ms；鼠标 3 秒画圈 ≤200 包且 ≥150 包）。均绿。
- 诚实边界：画面本身仍在上游 MeshCentral iframe 内渲染，本渲染器是网页端自有的绘制层
  （供会话覆盖层/回放器等自绘面使用），不谎称已接管引擎帧；“同段窗口拖动录屏 CPU/帧率
  对比”须在 ECS 真机跑，等 L7 安排。

## RC-04 网页客户端：断线重连两层（L1 票据规范 v1）——已完成 ✅

规范：工作树 `server/ext/lea/RC-04-RECONNECT-TICKET-SPEC.md`（L1 出，2026-11-15）。
按规范条款实现（逐项对应）：

- §1 形状校验与规范串：`validateReconnectTicket(ticket)`（qf-schema.js）：字段齐全、
  无未知顶层字段、api_key_id `k_`＋10 字符、epochs 安全整数≥0、resume/session 正则、
  TTL 恰好 300、缺签名拒绝；不验签名（签名由服务端核验）。`QF_RECONNECT_TICKET_TTL_S =
  300`、`QF_RECONNECT_TICKET_FIELDS`（10 字段）、`qfReconnectTicketCanonical(ticket)`
  （10 行规范串 `qfr-lea-reconnect-v1`，LF、无结尾换行）。`qfNewSessionId()`
  （`sess-`＋16 hex，优先 `crypto.getRandomValues`）。
- §3.1/§3.3 issue/resume 端点调用：`QFReconnect(opts)`（qf-runtime.js）：
  `issue()`（POST `/api/lea/v1/reconnect/issue`，200 合法票据存内存、404 记
  `endpointMissing`、非法票据拒收并记 `QFR_TICKET_INVALID`）、`resume()`（POST
  `/api/lea/v1/reconnect/resume`，200 ok 即消费丢弃票据；凭据码即停；404 记
  endpointMissing；502/503/0/networkError 判网络错误）。
- §5.2 重试规则（数字写死不得放宽）：`start(handlers)` 上限 5 次、固定 5 秒、重连期间
  `inputBlocked=true`；`onAttempt/onLegacyAttempt/onLegacyOk/onRestored/onStop`；
  `stop(reason, code)`、`cancel()`。
- §4 吊销语义码表：`QF_RECONNECT_CREDENTIAL_CODES`（7 码 Set）＋
  `qfIsCredentialFailure(code)`：`QFR_API_KEY_REVOKED` / `QFR_TICKET_REUSED` /
  `QFR_TICKET_EXPIRED` / `QFR_BINDING_CHANGED` / `QFR_GRANT_REVOKED` /
  `QFR_SCOPE_DENIED` / `QFR_LEA_NOT_BOUND`——凭据/授权类失败立即停；只有纯网络错误
  （超时/连接拒绝/DNS/502/503）才继续；5 次耗尽即停，界面给手动重试按钮；
  重连期间输入短路丢弃；成功后立即重做 RC-01 握手、查询原会话 UNKNOWN job 状态
  （只查不重执行）、Toast“已恢复连接”。
- app.js 接线：`Sess` 新增 `resumeId`、`reconnectCtl`、`_restoredByReconnect`；
  `teardownSession` 末尾停旧控制器、清 `resumeId` 与恢复标记（新会话须新 session_id，
  旧票据不跨会话复用）；`setConnected` 恢复过则 Toast `t('reconnect.restored')`、
  停旧控制器、为下次掉线申领一张新票据（只存内存；端点未实现时 404 降级）；
  `setLost` 调新函数 `sessEnsureReconnect(view)`（复用 setConnected 时带票据的控制器
  idle 态，已在跑则返回，终态则新建；挂一次取消按钮 `[data-act="reconnect-cancel"]`，
  文案 `t('reconnect.cancel')`；`onAttempt` 写条文 `t('reconnect.attempt', {n, max})`＋
  `Sess.reconnectN`；`onLegacyAttempt` 调钉住的 `driveConnect()`；`onLegacyOk` 调钉住的
  `probeFrame() === 'connected'`；`onRestored` 补调一次 `driveConnect()` 并置恢复标记；
  `onStop` 调 `sessReconnectStopped`）；`sessReconnectStopped`：`restored` 忽略；
  `cancelled` 改条文 `t('reconnect.cancelled')`＋徽标“已取消重连”；`credential` Toast
  `t('reconnect.stoppedCredential')` 后落 FAIL 遮罩；`exhausted` Toast
  `t('reconnect.exhausted')` 后落 FAIL 遮罩（遮罩 reason 均为 `lost-reconnect`，
  手动重试入口在遮罩上）。`startSentinel` 的 lost 分支删掉旧逻辑（W-07 每 5 秒无限
  driveConnect、30 秒自动重建帧、重建后 20 秒落 FAIL），改为只做探针与终态判定，
  重连由 QFReconnect 控制器驱动。
- 测试：`tests/unit/reconnect.test.mjs`（7 测试：issue 404、issue 200 合法/非法、resume
  成功单次消费、凭据失败 1 次即停、纯网络错误 5 次耗尽、取消即停＋输入短路、无票据走
  legacy 第 2 次成功恢复）；`w02-w10.spec.mjs` RC-04（QFReconnect＋票据校验＋
  sessEnsureReconnect 可用、重连条含“第 2 次 / 共 5 次”与“取消重连”）。均绿。
- 诚实边界（规范 §7）：服务端签发／核验端点的实现尚未做——实查 `server/ext/lea/
  lea-routes.js` 与 `lea-core.js` 内无 `reconnect` 相关代码，客户端须对 404 做降级
  （记 `endpointMissing`、走 legacy 路径），不发明票据格式、不伪造成功。真机验收
  （规范 §5.3 七场景：拔网 10 秒、服务端重启、切 Wi-Fi、吊销后 1 次即停、票据过期
  300 秒、票据重放、换绑后旧票据）须等端点实现＋ECS 窗口，等 L7 安排。

## RC-03 解码端 FEC＋IDR 发送（QF-VIDEO-1）——已完成 ✅

规范：工作树 `server/ext/QF-VIDEO-1-CLIENT-SPEC.md`（L5 出，2026-11-15）。
服务端实现已实查存在（`server/ext/fec-ref.js`、`idr-core.js`，路由见 `server/ext/server.js`
2834 行附近）。

- §1 FEC：RS over GF(256)，本原多项式 `0x11d`、生成元 2，校验行 Vandermonde 系数
  `(j+1)^i`；只两档（高保护 k=10/m=2 开销 20%、低保护 k=20/m=1 开销 5%）；
  `QF_FEC_VERSION=1`、`QF_FEC_TIERS={high:{k:10,m:2}, low:{k:20,m:1}}`、
  `qfValidateFecHeader(h)`（7 条非法条件，与服务端 `validateBlockHeader` 一字一致）；
  块头 12 字段，`fecVersion` 必须为 1；每帧一个块、不得跨关键帧；尾分片零填充、
  `lastSymbolPadding` 保留真实长度；交织深度下限 `G ≥ ceil(burstLen/2)`。
  `qfGfMul/qfGfDiv/qfGfInv/qfGfPow/qfGfParityCoef`＋`qfGfInvertMatrix`＋
  `qfRsEncode(dataShards,k,m)`＋`qfRsDecode(shards,k,m,lengths)`（Uint8Array，erasure
  解码；丢失>m 或可用校验行不足返回 null；按真实长度裁剪）。
- §2 IDR：`QFIdrRequester(opts)`：`seq` 每会话从 1 单调递增、每次发送加 1（合并也消费）；
  `request(sessionId, agentId, reason)`（reason 白名单三选一 loss/join/quality-change）；
  端点 `POST /license/api/session/idr-request`（控制台会话鉴权），body
  `{sessionId, agentId, seq, reason}`；响应 HTTP 200 看 body，decision 三态
  forward/coalesced/rejected，code 枚举 OK/COALESCED/NO_SESSION/NOT_BOUND/BAD_REASON/
  REPLAY/COOLDOWN/HARD_LIMIT/SESSION_BUCKET/AGENT_BUCKET；COOLDOWN 时按 `retryAfterMs`
  本地设门、冷却结束前不再发；coalesced/rejected 后不补发、不换 reason 重发、UI 不报错；
  连续 3 次拒绝 → 10s 冷却（带 `retryAfterMs`）；join 宽限（绑定后 10s 内首次 join
  不占令牌桶）；令牌桶/硬上限/合并窗口（loss 1s、quality-change 2s、join 1s）由服务端执行。
- `QFFecReceiver(opts)`：`ingest(header, bytes)`（块头校验→按 blockId/symbolIndex 归位；
  窗口 `RTT+jitter+33ms` 届满才判定，不一丢即请求；0 缺失直接渲染、1..m 缺失 RS 还原、
  超 m 或还原失败判不可恢复并调 `onUnrecoverable(frameId, header)`）；
  `setNetwork(rttMs, jitterMs)`；`resetOnKeyframe()`（关键帧到达清旧参考帧）；`stop()`。
  接线：`sessStartL5Clients` 建 FEC 接收器，不可恢复帧→受控 IDR `reason=loss`；
  `setConnected` 后 IDR 请求器发 join（绑定后 10s 宽限内）。
- 测试：`tests/unit/l5-clients.test.mjs` RC-03 部分（块头 7 条非法逐条拒绝、RS k=10/m=2
  丢 2 恢复/丢 3 不可恢复、k=20/m=1 丢 1 恢复、QFFecReceiver 0 缺失直出/2 缺失 RS 恢复/
  3 缺失触发 IDR/坏头丢弃、QFIdrRequester seq 单调/coalesced 不补发/COOLDOWN 门/
  非法 reason 拒绝）；`tests/l5-clients.spec.mjs` RC-03（join 发送、丢 2 分片 RS 恢复出帧
  且第 7 片字节一致）。均绿。
- 诚实边界（规范“与实现有出入处”）：① `validateBlockHeader` 接受 k=10/m=1 与 k=20/m=2
  组合，但协议只许两档，客户端只许发这两档；② 块头无线上传输打包格式未定（待 agent 线
  定版 v2），客户端不得自创——接收器以逻辑分片（header 对象＋Uint8Array）为入口；
  ③ 服务端只做准入决策返回，不直接转发给 agent（“转发”通道未实现，`forward` 只表示
  “服务端允许”）；④ `quality-change` 每次切换最多 1 次靠 2s 合并窗口等效，无单独去重。
  真实分片到达通道（上游帧流）在树外，待捕获埋点落地后接线 `QFFecReceiver.ingest`。

## RC-07 按宣告列表建连＋回退（QF-RELAY-1）——已完成 ✅

规范：工作树 `server/ext/QF-RELAY-1-CLIENT-SPEC.md`（L5 出，2026-11-15）。
服务端实现已实查存在（`server/ext/relay-core.js`，路由 `server/ext/server.js` 2793 行）。

- §1 宣告列表：`QFRelayClient(opts)`：`fetchList(force)`（GET `/license/api/relays`，
  控制台会话鉴权；未过期用缓存；503→`L5_UNAVAILABLE`）；响应
  `{ok, relays:[{id, url, tier, priority, ttlSec, issuedAt}]}`；排序 tier 升序、
  priority 降序（越大越先试）、id 字典序；tier 只接受 1/2/3；上限 32 条
  （`QF_RELAY_MAX_RELAYS=32`）；未配置时只宣告一条 tier-1
  （`{id:'qfremote-primary', url:<请求 origin>/console-engine/, tier:1, priority:100,
  ttlSec:600}`，origin 由 `x-forwarded-host` 或 `host` 派生并强制 `https://`）；
  缓存有效期 `issuedAt + ttlSec*1000`（`qfRelayListExpired`，单位已统一）。
- §2 选路：`qfPickRelay(list, failedIds, opts)`（与服务端同款逻辑）：候选按序、某级在途满
  跳过不算失败、无候选时 `degraded:true`，reason `tier-inflight-full` 或
  `all-tiers-exhausted`；在途上限每级默认 8（`QF_RELAY_MAX_INFLIGHT_PER_TIER=8`）；
  失败 id 进 `failedIds` 同会话不再试；`pickFor(dialUrlFor)` 循环 pick→校验待拨 URL→
  同源检查；伪造地址拒绝拨号、记诊断日志（只记 URL 与时间）、该条进 failedIds 再选下一条；
  异源中继（无法在同源 iframe 复用控制台会话）视为该条不可用继续选下一条；三级耗尽返回
  degraded；`settle(relay, ok)`（在途计数-1、失败进 failedIds）；`retry()`（清空
  failedIds＋在途计数、重新取列表，不得无间隔自动循环）。
- §2.2/§2.3 降级态：列表为空或请求失败 → 不建连；降级态只保留已建会话＋文件暂存通道、
  不新开桌面会话、UI 明确显示＋重试入口。接线：`buildSessionFrame` 在 identity 检查后、
  挂 iframe 之前插入中继选址（`sessSelectRelay(view, gen0)`，待拨 URL 为
  `sessionDeepLinkCurrent()` 同源 `/console-engine/` 深链）；失败时 `Sess.state='failed'`＋
  `showSessionMask(view, 'RELAY_DEGRADED', {relay, reason})`，不建连；`showSessionMask`
  新增 `RELAY_DEGRADED` 分支（标题“中继全部不可用”，文案 `t('relay.unavailable')`
  （L5_UNAVAILABLE 时）或 `t('relay.degraded')`，重试按钮为主按钮）。
  **buildSessionFrame 的改动即本节 10 行插入**，其余逐字一致（verify-pinned.js 文档化例外）。
- §3 白名单校验：`qfIsAllowedRelay(url, list)`（只接受 http:/https:，路径补末尾 `/`，
  origin 相等且路径是条目路径前缀；空列表一律拒绝）；每次拨号前对实际要拨的完整 URL
  校验一次；伪造中继拒绝拨号＋界面提示“该中继不在服务端宣告列表内，已拒绝连接”＋
  本地诊断日志（只记 URL 与时间，不记密钥/会话口令）＋继续选下一条。
- 测试：`l5-clients.test.mjs` RC-07 部分（pickRelay 排序/在途满跳过/三级耗尽降级、
  isAllowedRelay 六种拒绝、QFRelayClient 缓存＋TTL 过期重取＋503 透传＋异源跳过）；
  `l5-clients.spec.mjs` RC-07（宣告列表为空→不建连、遮罩“中继全部不可用”＋重试按钮可见；
  同源 tier-1 在列表内→不落降级遮罩、会话继续建立）。均绿。
- 诚实边界（规范“与实现有出入处”）：① tier-2/3 真实中继主机目前不存在（选路逻辑与策略位
  先行）；② 没有“上报中继故障”的服务端端点（失败跟踪/在途计数/回退全在客户端本地）；
  ③ 宣告列表无健康度/延迟字段，不得按延迟自选排序。**部署依赖**：L5 模块在 server.js
  启动时 try/catch 加载，失败则全部端点回 503 `L5_UNAVAILABLE`；若部署的服务端未加载
  L5 模块，宣告端点回 503，客户端按规范进降级遮罩、不建连——所有会话都会落降级遮罩，
  发版/部署线须确认 L5 已加载。

## RC-08 文件传输 UI＋断点续传（QF-STREAM-1）——已完成 ✅

规范：工作树 `server/ext/QF-STREAM-1-CLIENT-SPEC.md`（L5 出，2026-11-15）。
服务端实现已实查存在（`server/ext/transfer-core.js`，路由 `server/ext/server.js`
2845–2876 行）。新分片流，旧整文件 base64 端点 `POST /license/api/files/send` 保留兼容，
新客户端一律走分片流。

- 流程：`QFFileTransfer(opts)`：`upload(file, toNode, fromNode, onProgress)`（init→按服务端
  返回的 `chunkSize` 切分→`File.slice` 流式读、每片 base64→chunk→commit；中断后自动调
  `missing` 续传、不重传已收分片；`INCOMPLETE` 返回缺片列表不终态；`CORRUPT` 整单作废终态；
  `cancel()` 仅 uploading/interrupted 态）。端点：init（`{filename, size, sha256(64 位小写
  hex), chunkSize, toNode, fromNode}`，`chunkSize` 服务端钳制 64KB～4MB、默认 1MB，**客户端
  须用返回的 chunkSize 切分**；size 必须 >0 且 ≤ 单文件上限默认 200MB）；chunk（`POST
  /license/api/files/stream/{transferId}/chunk`，`{index, contentBase64}`，分片长度须精确等于
  期望值，空分片 VALIDATION，乱序可达、重复上传允许覆盖）；missing（`GET …/missing`，
  断点续传就是调本端点查缺片，**没有字面叫 `/resume` 的端点**）；commit（成功
  `{ok:true, transferId, stagedId:"fs_…", size, expiresAt}`，`stagedId` 是对端下载用的暂存单号，
  `expiresAt`＝now＋stageMs 默认 24h；缺片 `INCOMPLETE`＋missing 列表；SHA 校验失败
  `CORRUPT`——**整单作废，分片已清，此 transferId 不能再用**，须重新 init；重复 commit
  第二次即 `STATE`）；cancel（仅 uploading 态，成功记一条 `cancelled` 审计；commit 成功后
  没有取消端点）。
- 下载：`download(stagedId, onProgress)`（`GET /license/api/files/{stagedId}/download`，
  Range 续传，收到 200 按全文件处理、丢弃已收区间；读流中断再试一次；返回 Blob）；
  `parseRange` 支持 `bytes=N-`/`bytes=-N`/`bytes=N-M`，非法 Range **回落 200 全文件，
  不返回 416**；不存在/过期 404；下载用 `stagedId`（`fs_…`），不是 `transferId`。
- inbox/sent/ack 复用既有端点（行为未改）；审计 `listAudit(limit)`（limit 钳制 1..200，
  默认 50），只返回本人、按时间倒序，每条 `{transferId, username, filename, size, sha256,
  fromNode, toNode, chunks(=totalChunks), result, startedAt, endedAt}`＋`stagedId`（完成时）
  或 `reason`（失败时），result 三态 completed/failed/cancelled，**exactly-once**
  （每次传输恰一条，以 transferId 去重；init/chunk 不记审计；过期未完成由服务端每 60s
  清扫记 failed＋`reason:'stale'`）。
- UI 状态机（规范 §4）：上传进度按分片数（`received/totalChunks`）＋已传字节/总字节；
  断网重连后自动调 missing 续传，不得从头重传；取消按钮只在 uploading 态可用；commit
  提交中禁点取消与重复提交；失败提示须带服务端 code，`CORRUPT` 时明确告知“须重新发送”，
  不要显示“重试提交”；收件箱显示 `expiresAt` 到期时间，过期文件置灰不可下载；审计入口
  展示本人记录（result 三态着色）。接线：`mountFileSend` 改线（新增取消按钮
  `.fs-cancel`，上传中可见；上传走 `QFFileTransfer.upload`，进度文案
  `t('files.uploading', {r, n})`，中断时 `t('files.resume')`，提交中
  `t('files.checking')`；成功沿用旧成功文案（`r.expiresAt`）；`CANCELLED`→
  `t('files.cancelled')`；`CORRUPT`→`t('files.corrupt')`＋（CORRUPT），不显示“重试提交”；
  其他失败带服务端 code）；`loadInboxList` 下载按钮改线（`QFFileTransfer.download`
  Range 续传＋Blob 落盘，随后 ack 不变）；`Views.files` 新增两卡：传输记录
  （`#auditList`，`mountAuditList` 调 `listAudit(50)`，result 三态着色）与录像回放
  （见 RC-10）。旧的整文件 base64 路径（`readFileBase64`＋`xhrSendFile`）不再走；
  两函数留在 qf-runtime.js 未删（现无调用方）。
- 测试：`l5-clients.test.mjs` RC-08 部分（全流程：服务端返回 chunkSize 切分、分片内容为
  原文件字节直接切分；网络中断后 missing 续传不重传已收分片（chunk 调用 4 次：0、1 抛错、
  1 补、2 补）；CORRUPT 整单作废、INCOMPLETE 只补缺片、下载 Range 续传＋审计）；
  `l5-clients.spec.mjs` RC-08（真浏览器 File＋SHA-256＋3 分片＋commit 全流程，分片
  base64 解码后与原字节一致）。均绿。
- 诚实边界：SHA-256 须整文件读一次（WebCrypto 无流式接口），上传分片本身按 `File.slice`
  流式、不整文件 base64；新下载路径没有旧 `downloadStagedFile` 的 30 秒无进展超时
  （Range 续传覆盖中断场景）；chunk 请求体走 `BODY_LIMIT_FILE`（288MB），单分片
  base64 约 5.6MB 远小于上限。

## RC-09 探针＋档位执行＋ACK（QF-QUALITY-1）——已完成 ✅

规范：工作树 `server/ext/QF-QUALITY-1-CLIENT-SPEC.md`（L5 出，2026-11-15）。
服务端实现已实查存在（`server/ext/quality-core.js`，路由 `server/ext/server.js`
2800–2823 行）。

- §1 档位表：`QF_QUALITY_TIERS`、`QF_QUALITY_DEFAULT_TIER='balanced'`、
  `QF_QUALITY_TIER_TABLE`（四档数值与规范 §1 一致）：smooth（800kbps/15fps/5%/0.5/h264）、
  balanced 默认（2500/30/10%/0.75/h264）、clear（5000/30/15%/1.0/h264）、original
  （12000/60/20%/1.0/hevc）；热可调（`targetKbps`、`maxFps`、`fecRepairPercent`）：
  `QF_QUALITY_HOT_KEYS`；需重建（触发 IDR、接收端清旧参考帧）：`resolutionScale`、
  `encoderPreference`：`QF_QUALITY_RECONFIG_KEYS`；`qfSplitTierChange(fromTier, toTier)`
  （`{hot, reconfig, needsIdr}`，reconfig 非空时 needsIdr=true；未知档位回退默认档）。
  **不再宣称“全部即时无感”**。
- §2 探针：`QFQualityProbe(opts)`：`start/stop`；周期 1s 正常、弱网或档位切换后 10s 内
  500ms、页面/应用隐藏 5s（visibilitychange，恢复后补一次即时探针）；`sendOnce()`；
  端点 `POST /license/api/session/probe`，body `{sessionId, tier, probe:{rttMs, lossPct,
  lossSamples, jitterMs, decodeLagMs?, pendingFrames?, frameCorrupt?, serverQueueBytes?},
  serverSignal?}`；`sessionId` 必填（首次探针即建会话，`initialTier` 取 body.tier，
  非法/缺省 balanced；后续探针改 tier 不切换档位）；`lossPct` 指观看端下行丢包；
  统计窗口 1s 且 `lossSamples ≥ 50` 才采信（<50 记降权日志，仍入库）；缺 `rttMs`/`lossPct`/
  `jitterMs` 任一 → `probe-incomplete`（不入库）；值域外字段记
  `quality-probe-downweighted` 仍入库。`collect()` 只补本地观测值；RTT/丢包/抖动默认用
  本次探针调用自身的往返实测——上次往返时延、近 10 次标准差（`_jitter()`）、1s 窗口内
  失败占比；`lossSamples` 为窗口内尝试数，网页端约 1/s、如实上报小样本数，服务端按 §2.3
  记降权日志；客户端先校验值域，不依赖服务端清洗。
- §3 降档判定（服务端，客户端执行）：一般坏 `rtt>300` 或 `loss>5` 或 `jitter>50`；严重坏
  `rtt>800` 或 `loss>20` 或 `decodeLag>500`；健康 `rtt<150` 且 `loss<1` 且 `jitter<30`
  且（`decodeLag` 缺省或 `<150`）；严重坏连续 2 样本即降档；一般坏 5s 窗口内 ≥3 样本且
  持续 ≥3s 才降档；降档冷却一般坏 5s、连续恶化每 3s 最多降一档；每次只降一档、已在
  smooth 不再降、会话保持不断连；**网络恢复后不自动升档**（须用户手动升档）；EWMA
  （α=0.3）只作遥测，判定用原始样本。`qfQualityClassify(s)`（healthy/bad/severe/
  neutral/unknown；缺必填字段→unknown）。降档决策 `{decision:'downgrade-to',
  decisionId:'qd_…', from, to, hot, reconfig, mustAckByMs(决策时刻＋5000ms), needsIdr}`。
  执行：`_applyDecision(d, kind)`（先 hot 再 reconfig；`needsIdr` 时经 `idr` 发
  `reason=quality-change`；执行后在 `mustAckByMs` 前 ACK；旧决策 ACK 未发完不堆积新决策；
  执行失败不伪造 ACK）。**修过的真 bug**：初版 `sendOnce` 先用 `j.tier` 覆盖
  `probe.tier` 再执行决策，导致 `from` 丢失（单测抓到：`changes[0].from` 为 'balanced'
  而非 'clear'）；现降档决策先执行（`from` 取决策自带值）再以响应 tier 为准。
- §4 手动升档：`upgrade()`（`POST /license/api/session/quality/upgrade`，前置须先上报过
  探针；健康窗口最近 20s 内样本 ≥5 个且全部健康；一次只升一档；升档后 10s 观察窗；
  拒绝码 AT_TOP/NO_HEALTH_WINDOW/NOT_HEALTHY/PINGPONG_COOLDOWN（带 `retryAfterMs`）；
  乒乓冷却：升档后 10s 观察窗内被降回记一次乒乓，同一目标档 60s 内 2 次乒乓 → 该档冷却
  60s）。接线：设置抽屉新增“画质”段（当前档位 `#qfQualityTier`、背压行 `#qfQualityBp`、
  “提升画质”按钮 `#qfQualityUpgrade`、说明文字）；`wireSession` 绑定升档按钮
  （成功 Toast `t('quality.upgraded')`，拒绝按 code 映射文案，无控制器时 Toast
  `t('quality.noHealthWindow')`）。
- §6 ACK：`ack(decisionId)`（`POST /license/api/session/quality/ack`，
  `{sessionId, decisionId}`），成功 `{ok:true, tier, kind:'downgrade'|'upgrade', rttMs}`，
  未知 decisionId `UNKNOWN_DECISION`（不得重试），超时 5000ms 未 ACK 服务端只记日志并
  清除待 ACK 项（不重发），客户端收到新决策前须先把旧决策 ACK 发掉，不得堆积。
- §7 背压：L1 `reduce-fps`（服务端队列高，或最近 3 样本持续异常 `pendingFrames>30` 或
  `decodeLag>300`）、L2 `reduce-resolution-bitrate`（服务端队列高 **且** 客户端堆积）、
  L3 `drop-to-keyframe`（`frameCorrupt=true` **且**（服务端队列高或客户端堆积））；阈值
  服务端队列高＝`queueBytes>512KB` 或 `sendBlockedMs>500ms`，客户端堆积＝
  `pendingFrames>30` 或 `decodeLag>300`；**仅客户端自报堆积不触发背压**（只记
  `quality-backpressure-hint-only` 日志）；背压随每次探针响应返回，无单独端点，
  不产生 decisionId、不须 ACK；L3 请求关键帧须走 IDR 限流。接线：`onBackpressure`
  只记级别＋更新画质行，L3 时清本地参考帧＋受控 IDR；`onTierChange` 更新画质行、
  清旧参考帧、向录制发 `quality-change` 事件、Toast `t('quality.autoDown')`；
  `collect` 只报 FEC 待解块数作 `pendingFrames`，帧流在 iframe 内、取不到的观测值
  不填不伪造。
- 测试：`l5-clients.test.mjs` RC-09 部分（画质分类阈值、档位拆分 hot/reconfig 分离、
  QFQualityProbe 降档执行＋ACK＋升档 AT_TOP 透传、背压 L1 回调＋缺必填字段仍发
  （服务端判 probe-incomplete））；`l5-clients.spec.mjs` RC-09（降档决策执行＋5 秒内
  ACK、升档 AT_TOP 透传）。均绿。
- 诚实边界（规范“与实现有出入处”）：① 档位表 `fecRepairPercent` 10%/15% 在 FEC 层无对应
  档位（只有 k=20/m=1（5%）与 k=10/m=2（20%）两档），`≤5%` 用 k=20/m=1、`≥20%` 用
  k=10/m=2，中间值映射待定（`qfFecTierForRepairPercent(p)`，中间值回 null），不得自创
  第三种 `(k,m)`；② EWMA 只作遥测；③ `serverSignal` 由客户端随探针上传，服务端 HTTP 层
  没有实测 WS `bufferedAmount`/发送队列来填充它，客户端观测不到时传 null/省略，交叉验证
  退化为“连续 3 样本异常”路径；④ ACK 超时只记日志、不重发；⑤ 值域外探针仍入库；
  ⑥ `snapshot()` 是建会话时的档位快照，档位变化后不更新，客户端以探针响应的 `tier`
  与决策的 `hot`/`reconfig` 为准。**背压 L1/L2 的编码器侧动作（降帧率/降分辨率码率）
  网页端无法直接执行（画面在 iframe 内），只记级别、不擅自降档；L3 可执行
  （清本地参考帧＋受控 IDR）。**

## RC-10 录像回放器（QF-REC-1）——已完成 ✅

规范：工作树 `server/ext/QF-REC-1-CLIENT-SPEC.md`（L5 出，2026-11-15）。
服务端实现已实查存在（`server/ext/recording-core.js`，路由 `server/ext/server.js`
2881–2918 行）。

- §1 格式：`.qfrec` 为 JSONL 事件流（每行一个事件 JSON，UTF-8，`\n` 分隔），不存视频帧；
  通用字段 `type`＋`at`（毫秒 epoch）；事件顺序 `session-start`（服务端写）→
  `input`/`clipboard`/`frame-marker`/`quality-change`（客户端发）→ `session-end`
  （服务端写）；10 分钟录像约 4,344,386 字节（54,002 事件），约为同等视频的 1/43。
- §2 事件白名单（服务端 `sanitizeEvent`）：`qfRecSanitizeEvent(ev)`（白名单清洗：
  clipboard 只留 bytes、key 截 32、kind 非法→mouse、x/y 缺省 0）：`input`（`kind`
  mouse/key/touch，非法按 mouse 计；`x`/`y` 数字缺省 0；`key` 仅限按键名，截断 32 字符，
  **只记按键名，不记密码等输入内容**）、`clipboard`（**只记字节数 `bytes`，绝不记剪贴板
  内容**；发 `content` 会被服务端丢弃）、`frame-marker`（`frameId`、`isKeyframe`）、
  `quality-change`（`from`/`to` 各截断 32 字符）、`session-start`/`session-end`
  服务端写、客户端不得发；`seek-index` 不是客户端发的事件，不要往 `/event` 发；
  非法事件类型（如 `video-frame`）回 `{ok:false, code:'VALIDATION'}`。
- §3 端点：`QFRecording(opts)`：`newRecordingId()`（`rec_`＋16 hex，crypto 随机）；
  `start(deviceId, groupId, tier, sessionId)`（`{sessionId, deviceId, groupId, tier}`，
  sessionId 可传桌面会话 id 关联，须匹配 `/^(sess|rec)-[0-9a-f]{16}$/` 否则生成 rec_；
  策略未开启回 `POLICY_OFF`，客户端不得继续发事件，UI 须提示“当前会话不录制”；
  开始时服务端写 `.meta.json` 与空 `.qfrec`（0600）并追加 `session-start`）；
  `sendEvent(ev)`（`POST /license/api/recordings/{sessionId}/event`，`{event}`，只发四种
  事件；批量发须保持 `at` 单调递增，不得倒序补发）；`end()`（`POST …/end`，成功
  `{ok:true, sessionId, events, bytes, index:[{t, byteOffset}, …]}`，落盘 `.qfrec.idx`；
  结束时追加 `session-end` 再写索引）；`list()`（`GET /license/api/recordings`，
  只返回本人，按 `startedAt` 倒序）；`getIndex(sessionId)`（`GET …/{sessionId}/index`，
  无权限或不存在 HTTP **404** `{ok:false, code:'NOT_FOUND'}`，与不存在同一响应，
  不泄露存在性；`.idx` 缺失时服务端现扫重建，响应多 `rebuilt:true`，重建把第一个事件也
  当锚点）；`downloadBytes(sessionId)`（`GET …/{sessionId}/download`，200 全文件，
  `Content-Disposition: attachment; filename="<sessionId>.qfrec"`，**不支持 `Range`**，
  回放器须整文件下载后本地 seek）。
  接线：`sessStartL5Clients` 建录制控制（sessionId 传桌面会话 id 关联；`POLICY_OFF`
  默认不录）；`sessStopL5Clients` 录制 end。`sendEvent` 倒序丢弃记 `droppedOutOfOrder`；
  `/event` 回 `NOT_FOUND` 时 state='interrupted'（规范 §6.2）。
- §4 seek 索引：事件 `at` 距上一个锚点 ≥10s（`SEEK_INDEX_INTERVAL_MS = 10000`）追加锚点
  `{t, byteOffset}`（写完该行后的文件字节偏移）；10 分钟录像约 60 个锚点；seek 取
  `t ≤ T` 的最后锚点，从 `byteOffset` 起往后读事件、快进重放到 `T`。
  `QF_REC_SEEK_INTERVAL_MS=10000`、`QF_REC_EVENT_TYPES`、`qfRecSeekAnchor(index, tMs)`
  （取 t≤T 的最后锚点）、`qfRecParseJsonl(text, fromByte)`（只解析完整行，尾部半行不消费，
  返回 `{events, consumedBytes, skipped}`）。
- §5 回放器七项（`QFRecPlayer(opts)`＋`Views.files` 录像回放卡）：① 列表
  （`GET /license/api/recordings`）；② 加载（先 `index` 再 `download` 整文件）；③ 播放
  （按 `at` 顺序重放：`input` 还原鼠标/按键光标位置、`frame-marker` 锚点对齐关键帧位置、
  `quality-change` 显示档位变化标记；重放事件流不是视频画面）；④ seek（锚点跳到目标时刻，
  10s 粒度内准确，不得逐行从头扫）；⑤ 变速（0.5x/1x/2x，按 `at` 差值缩放间隔）；⑥ 边下
  边播（下载未完成时可用已下载部分的事件先播，按已下载字节边界切行，不得播半行；
  `appendText(text)` 只解析新增完整行）；⑦ 隐私提示（播放页须提示“本录像含操作记录”，
  不得提供“导出剪贴板内容”功能）。实现：`mountRecList`（每行播放按钮）、
  `mountRecPlayer(root, sessionId)`（隐私提示、640×360 canvas、播放/暂停按钮、seek 滑块、
  变速下拉、时间显示、状态行；载入后按事件 x/y 最大值重算归一化分辨率（远端分辨率未知，
  先按 1920×1080）；播放中每 200ms 刷新画布与滑块，播完按钮变回“播放”；
  getIndex/download 任一失败显示“录像不存在或无权限查看”（404 不区分解读））。
  `seek(tMs)`（取 t≤T 的最后锚点，从 `byteOffset` 起往后读事件、快进重放到 T；
  **锚点前事件不重扫**，10s 粒度近似——seek 后光标/档位状态仅由锚点后事件重建）。
  **修过的真 bug**：回放器 `draw()` 曾把 `state()` 返回的数字 `durationMs` 当函数调
  （`st.durationMs()`），致 IIFE 进 catch 显示“录像不存在或无权限查看”——Playwright
  抓到，已修为 `st.durationMs`。画布光标前景色运行时从 token `--text` 读，失败回落
  CSS 系统色 `CanvasText`——不得在 JS 写 hex 字面量（`lint-no-colors` 曾抓到
  `#111`/`#fff`/`#888` 三处，已修）。
- §6 策略与访问控制：录制策略（`config.json` 的 `recording` 对象）：`off`（默认，不录任何
  会话）、`user`（`users` 含该 username）、`group`、`device`；非法 mode 回退 off；
  `retentionDays` 非正数默认 30 天；**默认不录**，须双方知情或站长明确授权才开；策略变更
  不由客户端发起。录像按账号隔离，`index`/`download` 只许本人；服务端文件 0600、目录
  0700；**站长无直通**（站长侧查看须走既有审核/授权流程，`canAccess` 对站长同样只认本人）；
  保留期默认 30 天，服务端每 60s 清扫。
- 测试：`l5-clients.test.mjs` RC-10 部分（事件清洗：clipboard 只记 bytes、key 截 32、
  非法 kind→mouse；seek 锚点＋JSONL 解析：半行不消费、非法行跳过；QFRecording
  POLICY_OFF/倒序丢弃/NOT_FOUND 记 interrupted；QFRecPlayer 按 at 顺序播放/变速/seek
  锚点快进/边下边播半行不解析）；`l5-clients.spec.mjs` RC-10（列表→加载→播放出光标、
  seek 锚点快进；canvas 非透明像素数 >0 断言光标已画出）。均绿。
- 诚实边界（规范“与实现有出入处”）：① **`/event` 与 `/end` 路由没有按用户鉴权**
  （只要求控制台会话，不调 `canAccess`；任何已登录用户只要猜到 `sessionId` 就能往他人
  录制会话追加事件或提前结束它；`index`/`download` 有 `canAccess`，这两条没有）；
  客户端不得利用这一点；服务端后续须补鉴权；`sessionId` 不可预测时风险较低
  （`rec_`＋16 位 hex），但客户端传入自定义 `sessionId` 时不得用可猜的值——本线
  sessionId 一律用不可猜的随机值（桌面会话 id `sess-`＋16 hex 或 `rec_`＋16 hex）；
  ② 录制会话只存在于服务端内存，服务端重启后内存丢失，此后 `/event`/`/end` 返回
  `NOT_FOUND`（磁盘 `.qfrec` 还在，但续不上），客户端收到 `NOT_FOUND` 后不得静默丢事件——
  应提示“录制已中断（服务端重启），本次录像不完整”，并重新 `start` 一个新录制
  （新 `sessionId`）；③ 录像下载不支持 Range；④ 策略变更审计不存在
  （`recording-core.js` 里没有策略变更审计事件）；⑤ 事件实际捕获未实现（本模块只定格式＋
  服务端侧；输入/剪贴板/关键帧事件的真实捕获埋点须另派线，在埋点落地前客户端按规范发事件
  即进入“协议就绪、捕获待落地”状态，不得宣称已实现真机录像）。

## 最终全量回归（2026-11-15，本轮收尾时实跑）

- `node run.mjs`（tests/run.mjs）：5 步全 PASS——lint-no-colors（7 文件零字面量）、
  lint-no-cycles（schema 87 decls → runtime 49 → ui 41 → app 195，无反向引用、无重名声明）、
  lint-no-hardcoded-i18n（qf-runtime.js 43＝基线、qf-ui.js 44＝基线）、
  lint-versioned-assets（7 个资产 hash 文件名与内容一致）、单测。
- 单测：`node --test ./unit/*.test.mjs` 43/43 全绿（schema 6＋transport-bus 3＋
  reconnect 7＋renderer 4＋store-local 5＋l5-clients 18）。
- Playwright 全套：`npx playwright test` 45/45 通过（38.4s）——split-smoke 5、
  reduced-motion 6、w02-w10 7、components 13、deep-check 6、axe 2、l5-clients 6。
- `node --check` 四个 hash 命名的 JS 文件全过（qf-schema-343acaf4.js、
  qf-runtime-dcd12be7.js、qf-ui-ba52a6ad.js、app-584f618a.js）。
- `/tmp/qf-l4-tools/verify-pinned.js`：PINNED OK（buildSessionFrame 含文档化 RC-07
  10 行例外，剥离后逐字一致；其余钉住函数全部逐字一致）。
- `node windows/test/logout-p1-test.js`：pass true。
- `node windows/test/session-defense-a-test.js`：49 cases，failed: []。
- Lighthouse：a11y 98、best-practices 96、performance 65（见 W-07 节）。

## 未完成／待 ECS 真机验证（诚实口径，勿谎称已做）

- RC-04 服务端 issue/resume 端点未实现（规范 §7）：客户端已按规范做完并用假 fetch 测过，
  404 时走 legacy；真机验收（规范 §5.3 七场景）须等端点实现＋ECS 窗口，等 L7 安排。
- RC-05：真机桌面帧在上游 MeshCentral iframe 内；“同段窗口拖动录屏 CPU/帧率对比”须在
  ECS 真机跑，等 L7 安排。
- W-04：服务端 boot data 注入未做（nginx 静态根目录），客户端消费端已做；ETag 服务端
  支持未确认（客户端已做指纹比对兜底）。
- W-06：Storybook dev 服务未跑（重型安装）；CSF 故事＋Playwright 画廊为验收手段。
- W-07：WAVE 未跑（需 API key/扩展），发版门人工项；axe 仅 moderate 残留 2 项（见 W-07 节）。
- W-02 探针迁移：`fetchControlNodes` 与 `probeControlSessionOnce` 仍直连 `new WebSocket`
  （被 windows/test 钉住），须走快照更新流程。
- W-04 “各页只读 store”：本次只迁移了设备列表写入 store；其余视图仍读 `S`。
- `.cht-av.av1` 深色黑字疑似缺陷仍未动，等深查线定。
- RC-07 部署依赖：服务端未加载 L5 模块时宣告端点回 503，客户端按规范进降级遮罩、不建连；
  若部署机未加载 L5，所有会话都会落降级遮罩（发版/部署线须确认 L5 已加载）。
- RC-09 背压：L1/L2 的编码器侧动作网页端无法执行，只记级别＋更新画质行；L3 可执行。
- RC-03 FEC：分片到达通道在上游帧流内，待捕获埋点落地后接线 `QFFecReceiver.ingest`；
  块头二进制打包格式待 agent 线定版，不得自创。
- RC-10 录制：真实输入/剪贴板/关键帧捕获埋点在上游，待落地后接线；`/event` 与 `/end`
  路由无用户鉴权（规范 §6.1 安全缺口），客户端不得利用，sessionId 一律用不可猜的随机值。
- RC-08：SHA-256 须整文件读一次（WebCrypto 无流式接口），上传分片本身按 `File.slice` 流式；
  新下载路径无旧 `downloadStagedFile` 的 30 秒无进展超时（Range 续传覆盖中断场景）。
