# W-04 服务端首屏 boot data 注入（QFRemote 网页端）

对标 Grafana boot data 与 Nextcloud `@nextcloud/initial-state`：登录后服务端在
`index.html` 里一次性下发用户/会话快照，客户端消费端 `qfApplyBootData()`
（`qf-runtime.js`，L4 已落地）读 `window.__QF_BOOT__` 播种 `QFStore`，各页只读
store，不另开并行拉取。服务端注入部分由本文件与 `boot-data.mjs` 实现。

## 注入形状（与客户端消费端逐项对齐）

客户端逐项读取的顶层键（`qf-runtime.js` 的 `qfApplyBootData`，以它为准）：

| boot 键 | 客户端消费 | 来源（生产接线） |
|---|---|---|
| `v` | 忽略（格式版本，现为 `1`） | 本模块常量 |
| `user` | `S.user` | 会话用户名 |
| `displayName` | `S.displayName` | `buildHomeStats` 的 displayName |
| `isAdmin` | `S.isAdmin`（仅 boolean） | `buildHomeStats` 的 isAdmin |
| `license` | `S.license`（整体赋值） | `buildStatusView`，见下表 |
| `theme` | 仅 `'dark'`/`'light'` 时 `applyTheme()` | 账号主题偏好（见“主题”一节） |
| `devices` | `QFStore.seedDocs({ devices })` | `buildHomeStats` 的 devices |
| `presence` | 逐键 `QFStore.setPresence(k, v)`（只放内存，永不落盘） | 在线观测（见下） |

`license` 子字段白名单（只含首屏展示必需项；`S.license` 的其余读取点
`gateFor` 只用 `planName`/`keyPlan`/`keyExpiresMs`，均已包含）：

`planName`、`displayStatus`、`statusNote`、`maskedKey`（已脱敏展示值）、`hasKey`、
`webEnabled`、`webBy`（`'paid'`/`'trial'`）、`trialExpiresMs`、`keyExpiresMs`、
`keyPlan`、`keyLifecycle`、`keyDurationHours`、`remainText`、
`slots`（`pc`/`mobile`/`pcUsed`/`pcMax`/`mobileUsed`/`mobileMax`）、
`everBanned`、`activeBan`（`code`/`permanent`/`endsAt`）。

`devices[]` 单条白名单（与 `/home/api/stats` 的设备形状一致）：
`id`、`name`（必填，无名丢弃）、`os`、`group`、`nodeid`、`online`、
`onlineUnknown`、`stale`、`lastAgentPong`、`lastAgentPongAgeMs`、`agentConnectedAt`。

`presence` 为 `{ 键: 标量快照 }` 自由形状（当前无视图逐字段消费，只进内存态）：
值只留 string/number/boolean/null 标量字段，嵌套对象/数组一律丢弃。生产建议值
`{ online, lastAgentPong }`，键用归一化 node id。

## 敏感值红线

- 白名单之外一律丢弃：LEA Key、API Key、票据明文、密码、token、session、
  cookie、`/license/api/me` 的 `decision`/`forceLogout`/`gateCode`、`keyId`、
  `username`（与顶层 `user` 重复）等即使上游误传也不会进页面。
- 注入前 `qfBootDataHasSensitive()` 再扫一遍键名（`maskedKey` 明确豁免），命中即
  拒绝注入、原样出静态页（fail-closed）。
- 内联脚本用安全序列化（`<`/`>`/`&`/U+2028/U+2029 转义），`displayName` 等含
  HTML/JS 片段的用户内容也无法逃逸出 `</script>`。
- 注入页强制 `Cache-Control: no-store`＋`Vary: Cookie`，不进任何共享缓存。

## 服务端接线（部署线做，示例）

```js
import { createBootDataHandler } from './boot-data.mjs';
// getSnapshot(req)：只在已鉴权会话下返回快照，未登录返回 null（不注入）。
// 取数复用现有只读路径，不新开鉴权：resolveAuth → buildHomeStats → buildStatusView。
async function getSnapshot(req) {
  const auth = await resolveAuth(req);
  if (!auth) return null;
  const stats = await buildHomeStats(req, auth);
  const license = lic.buildStatusView(auth.user, Date.now());
  return {
    user: auth.user,
    displayName: stats.displayName,
    isAdmin: stats.isAdmin,
    license,
    // theme：见下节；devices：stats.devices；presence：见下节。
    devices: stats.devices || [],
    presence: presenceSnapshotFor(auth.user),
  };
}
const handler = createBootDataHandler({ getSnapshot, webappDir: '/opt/qfremote-webapp' });
// 挂在 / 与 /index.html 之前（只认 GET/HEAD）；其余路径返回 false 交静态服务。
```

- 处理器只处理 `/` 与 `/index.html`，其余路径返回 `false` 交上游；`getSnapshot`
  抛错、清洗为空、自检命中时一律原样出静态模板，不 500 挡壳。
- nginx 侧保持现有 `location = /index.html { return 301 /; }`，渲染器挂在 `/` 后面；
  注入页的 `no-store` 由处理器写，不要再叠加可缓存的 `expires`。
- `createBootServer()` 是同款逻辑的参考实现（静态＋注入），供测试与部署线参考，
  不是生产部署本身。

## 主题

`theme` 只在快照明确给出 `'dark'`/`'light'` 时下发。注意：QFRemote 网页主题偏好
目前只存在浏览器本地（`localStorage` 的 `qf-theme`＋跟随系统），服务端没有
账号级主题存储，所以生产快照现阶段一般不带 `theme`，客户端沿用本地偏好与
`applyTheme(getTheme())`；字段已端到端打通（测试用 fixture 下发 `dark` 验证），
等服务端存了账号偏好再由部署线填入，不要为此现编一个偏好来源。

## 诚实边界（与 L4 客户端证据一致，不夸大）

- 本线只做服务端注入＋与消费端的对齐；`checkSession` 的 `/license/api/me`
  校验与 `/home/api/stats` 回填仍在跑（登录态与封禁判定仍以它们为准，boot data
  不改 `S.auth`、不携带 `decision`）；设备页等视图仍读 `S.stats`，本次不改。
- **消费端接线缺陷已修（本线实测发现）**：`boot()` 里 `qfApplyBootData()` 先播种
  `S.license`/`S.displayName`/`S.isAdmin`，随后缓存回填分支无条件执行
  `S.license = cache.license`，缓存无 license 时把刚播种的 boot 快照清成
  `undefined`（`isAdmin` 同理被 `!!cache.isAdmin` 清成 `false`）。已在
  `app.js` 的 `boot()` 加守卫：注入带了的字段不许缓存回填盖掉，没带才回填；
  `S.user` 不动（换账号判定归 `checkSession`）。守卫由
  `tests/boot-data.spec.mjs` 的首屏断言覆盖（见证据）。
- “各页只读 store”：boot 播种进 `QFStore`（devices＋presence）是一次性的、
  无额外请求；其余视图向 store 的迁移仍是后续工作，不谎称全站已迁移。
- 生产真会话端到端（真实账号登录 → 注入页 → 首屏渲染）须在 ECS 窗口验，
  沙箱内以 fixture 快照＋Playwright 实跑为准（见测试一节）。
- 附带修：`tests/bump-version.mjs` 的引用改写只匹配裸文件名，内容变更后重命名
  时 `index.html` 仍指旧 hash 文件（断链）；已改为裸名与旧 hash 名都匹配，
  本次 `app.js` 重命名已用修复后的脚本验证。

## 测试

- 单测：`server/webapp/tests/unit/boot-data.test.mjs`（白名单、敏感剔除、转义、
  渲染、处理器、与真实 `qfApplyBootData` 的对齐），跑在 `tests/run.mjs` 门禁内。
- E2E：`server/webapp/tests/boot-data.spec.mjs`（Playwright 真浏览器＋
  `createBootServer`：登录态一次下发、字段齐全、敏感值不在其中、匿名不注入、
  各页读 store）。
