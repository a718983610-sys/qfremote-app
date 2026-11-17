# app.js 拆分路线（S-072，C-3 线）

> 现状：`server/webapp/app-9277ca2a.js` 5620 行经典脚本（hash bundle 名随内容变，
> 见 `tests/ASSETS.json`）。本路线不做一次性全量 ES modules 转换——经典脚本＋
> hash 命名＋`lint-no-cycles`＋`split-smoke.spec.mjs`（4 脚本按序加载）四重约束下，
> 全转会破门禁。做法：先理职责、定模块契约，首批纯逻辑模块先落 `qf-schema.js`／
> `qf-runtime.js`（可单测），业务模块按提取顺序逐个抽出，每抽一个即补测试、即跑门禁。
> C-4 的 S-087 在此结构上继续。

## 模块契约（每个 feature module 必须满足）

| 层 | 要求 |
|---|---|
| 入口 | 一个 `mountXxx(view, hooks)` 或 `startXxx()`，只收显式参数，不读别的模块的私有态 |
| state | 模块自有 state 对象（如 `CH`、`Sess`），代次（gen）守卫跨 await 写入 |
| API adapter | 所有网络调用收敛到一个 adapter（如 `cq`、`chatApi`、`forumFetch`），不散落 fetch |
| DOM view | 只操作自己挂载的根节点；跨模块通信走回调／事件，不直接读别的模块的 DOM |
| 可单测 | 纯逻辑（状态机、编解码、分页、去重）抽到 `qf-schema.js`／`qf-runtime.js`，走 `tests/unit/load-webapp.mjs` 的 vm 沙箱＋`node --test`；DOM 行为走 Playwright |

## 已落地的首批模块（本线，2026-11-15）

| 模块 | 位置 | 内容 |
|---|---|---|
| 连接状态机 `QFSessionSM` | `qf-runtime-252deee4.js`（S-075） | `CONNECTING → TRANSPORT_READY → REMOTE_AUTHENTICATED → VIDEO_FIRST_FRAME → INPUT_READY → HEALTHY`，每段独立 timeout 与诊断码；单测 `tests/unit/session-sm.test.mjs` 4/4 |
| 客户端消息 ID `qfNewClientMessageId()` | `qf-schema-87aee99f.js`（S-054） | `cm-`＋32 位小写 hex；单测 `tests/unit/schema.test.mjs` |
| 聊天事件流服务端 | `server/friends/chat/chat-server.js`（S-048/S-053/S-051） | 每收件人持久 inbox＋`inboxFloor`、`/chat/api/catchup`、poll 的 `gap/hasMore/nextSince`、vault 分页；压力脚本 `server/friends/chat/stress-inbox-test.js` |
| 聊天事件流客户端 | `app-9277ca2a.js` 的 `chCatchUp`／`chPollRound`、`chat-client.js` 的 `catchUp`／`pollOnce` | gap 时先 catchup 再推游标，hasMore 翻页，历史 vault 分页拉取 |

## 全量模块清单（按行区，行号为 2026-11-15 晚现状）

| # | 模块 | 行区 | 职责 | 提取顺序 |
|---|---|---|---|---|
| 1 | shell（壳／路由／启动） | 1–32，353–638，5534–5620 | `S` 全局态、路由、壳切换、启动 boot | 最后（被所有模块依赖） |
| 2 | auth（登录／登出／gate） | 149–352，407–558 | `doLogin/doLogout/checkSessionInner`、gate、未登录区 | 6（windows/test 快照钉住原样函数，须同步更新快照） |
| 3 | devices（设备列表／节点图） | 33–148，639–805，2283–2832 | nodeMap 单飞缓存、设备行、锁面板、文件发送 | 7 |
| 4 | session-frame（会话框／预热） | 778–805，1093–1526，1335–1465 | 预热框升格、frame 导航、guard、ready 消息 | 5 |
| 5 | session-machine（会话状态机） | 806–1092，1527–1760，1795–2282 | `Sess`、哨兵、probe、阶段超时、重连接线 | 4（已先落 `QFSessionSM` 纯逻辑核） |
| 6 | chat-crypto（聊天密钥／解锁） | 2949–3314 | 聊天令牌、设备密钥副本、托管副本、静默解锁 | 3 |
| 7 | chat-history（聊天历史／保险库） | 3304–3487 | `chLoadHistory` 分页、`chVaultAppend`、traces | 2 |
| 8 | chat-sync（聊天同步轮询） | 3545–3827 | `chPollRound`／`chCatchUp`／`chHandleEvent`、已读位 | 1（先抽：纯事件流逻辑最独立） |
| 9 | chat-thread（聊天会话界面） | 3488–3544，3828–4055 | 会话打开／发送／撤回／删对话、挂载 | 2（随 chat-sync 一起抽） |
| 10 | forum（论坛） | 4056–4264 | 帖子列表／详情、会话 | 8 |
| 11 | support（智能客服） | 4265–4343 | AI 通道＋知识库兜底＋转人工 | 8 |
| 12 | shop（购买／订单／积分／密钥） | 4344–5000，4763–4848，4848–5000 | 订单、签到福利、LEA 密钥 | 9 |
| 13 | account／appeal／admin（我的／申诉／站长） | 5000–5533 | 我的账户、申诉、站长管理 | 9 |

## 提取规则

1. 一次只抽一个模块：先把模块的纯逻辑函数移到 `qf-schema.js`（无副作用）或
   `qf-runtime.js`（带定时器／fetch 注入），DOM 部分留在 `app.js` 内以
   `mountXxx` 收口，`app.js` 只剩壳＋各模块挂载。
2. 每抽一个：`node --check` 各改动文件 → `node --test ./unit/*.test.mjs` →
   `node run.mjs`（5/5）→ 相关 Playwright 用例；全绿才抽下一个。
3. 不新增全局可变态：模块间共享只读配置走参数，共享可变态走显式 adapter。
4. hash bundle 改名：内容变即跑 `tests/bump-version.mjs` 重命名，
   `ASSETS.json` 与 `tests/lint-versioned-assets.mjs` 同步（S-074 同理）。
5. 不碰的线：`chat.html`／`crypto-core.js`／`package.json` 已有其他线修改；
   `server/friends/chat/chat-server.js` 与 `chat-client.js` 的聊天事件流改动归 C-3，
   C-4 的 S-084/085/086 须在本线改动落地后重读再动手。
