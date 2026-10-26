# QFRemote 智能客服 · 集成与部署申请清单（阶段二）

本地实现已完成并通过红线自测（`node test-support.js`，35 项全过）。**本线未部署、未改任何线上文件**；以下为部署前需主代理与 2.3.0 发布线对齐放行的改动清单。

## 一、模块文件（新增，不改现有文件）

| 文件 | 作用 |
|---|---|
| `support/kb-data.js` | 知识库数据（39 条：功能 22＋场景 8＋话术 9），审稿包与上线数据同源 |
| `support/support.js` | 应答引擎：本地双字组检索、置信三层、候选顺位、双口吻、先查后答、三层门控、核对与锁定 |
| `support/support-store.js` | 会话/工单 JSON 落盘＋消息与未命中 jsonl 留痕 |
| `support/status-providers.js` | 本人状态只读适配器（冻结/申诉/封禁/积分/注册邮箱） |
| `support/http-router.js` | `/support/api/*` 路由：会话、提问、核对、工单、站长收件箱 |
| `support/support-page-preview.html` | 客服页版式预览（三端改造统一依据） |
| `support/build-review.js` | 由 kb-data.js 再生成审稿包（改字后复核一致用） |

运行时数据目录（部署时新建）：`support/data/`（support-sessions.json、support-tickets.json、support-messages.jsonl、support-unhits.jsonl）。

## 二、挂载与接线（部署时做，需对齐窗口）

1. **宿主挂载**：在 friends 服务（8445）进程内挂载 http-router（与好友/聊天同进程，沿用其会话校验作 `authenticate`：已登录用户名取自现行 qfr_frd / xid 校验链，含 2.3.0 单次登录口径；`authenticateAdmin` 复用站长判定）。如 2.3.0 线另有服务规划，以其规划为准，本模块可整体迁移。
2. **状态适配器路径**（服务器实路径，部署时以现行部署为准核对）：
   - loginshimDataDir：loginshim 的 data 目录（freeze.json / appeals.json 只读）；
   - extDataDir：qfremote-ext 的 data 目录（points.json 只读，展示口径复用 ext-svc/points-core.js）；
   - ledgerFile：`/opt/meshcentral/meshcentral-data/qf-account-ledger.json`（ext 现行口径）；
   - contactsFile：**需新接线**——身份核对用的「账号→注册邮箱」映射。建议由 account-kit 在部署时从 MeshCentral 用户记录导出一份只读 JSON（账号→email）定期刷新；在未接线前，未登录核对会如实返回不可用（只给通用指引），不影响其余功能。
3. **站长回复台**：收件箱 API 已在本模块（`/support/api/admin/tickets|reply|close`）；页面侧需在现行站长管理页（qfremote-ext 的 /admin）加「客服收件箱」一区调用上述 API——属 ext 页面改动，列入部署协调。
4. **客服页（三端）**：入口仍为好友列表置顶「官方客服」；点入打开新客服会话页（版式按 support-page-preview.html），不再进入端到端加密会话。旧客服加密历史只读保留（默认稿，待站长改）：聊天列表中原客服会话保留可看、不可续聊，并给出已迁移提示。Windows 壳/安卓端为 WebView 同页，无额外原生改动；网页版同页。
5. **未登录入口（全状态可达）**：以下页面各加一个「智能客服」入口，打开同一客服页（未登录会话）：
   - 登录页（loginshim 注入面，与「申诉进度」入口并列）；
   - 注册页（register-svc/register.html）；
   - 冻结提示弹窗（loginshim freezePopupHtml 内与「去申诉」并列）；
   - 申诉页与申诉进度页（loginshim appeal 页）。
   以上均属其他线文件，须经主代理协调后改动，本线未动。
6. **下线静态 FAQ**：知识库上线后，chat 页内现行 support-faq.json 静态展示下线（5 条已并入知识库，对照见审稿包第四节）。

## 三、上线口径与红线（已自测）

- 答不上不死胡同：澄清（带选项）→ 候选顺位 → 转人工兜底，全路径有出口；
- 先查后答只查本人：登录态凭会话用户；未登录凭身份核对（账号＋注册邮箱），核对连错 5 次锁定 1 小时，核对不过零信息泄露；
- 转人工后机器人不再抢答，仅记录并提示；人工呈现名「人工客服」（默认稿）；
- 未登录限频：提问 30 次/小时/会话（IP 维度另有上限）、核对 10 次/小时；转人工门控三层对未登录同口径，未登录工单必须留联系邮箱；
- 未命中问题全部留痕（support-unhits.jsonl），供上线后补库；
- 客服数据不计积分；账号注销时客服两表一并清除——**待补**：注销清除钩子需在账号注销流程侧接线，列为部署跟进项。

## 四、已知取舍（如实）

- 检索为纯本地双字组打分（自检索准确率 98.4%）；3 条场景条目的标题式问法由功能条目并列第一，靠引擎的场景优先规则在应答时纠正（自测已覆盖）。语义向量为二期增强，届时问题仍不出本机服务。
- 身份核对依赖 contacts 映射接线；未接线前该功能不可用（有如实降级）。
- 积分「先查后答」只报当前积分与已用时长，不报流水明细（现行 ext 未提供流水查询接口；如站长要求，再立项）。
