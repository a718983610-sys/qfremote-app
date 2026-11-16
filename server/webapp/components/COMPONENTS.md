# QFRemote 网页端内部组件库与布局骨架（W-06）

- 注册表：`qf-ui.js` 的 `QFComponents`（`register/render/list/meta`）。
- 故事文件：本目录 `*.stories.mjs`（Storybook CSF 格式；视觉验收见
  `server/webapp/tests/components.spec.mjs`，每个故事桌面浅色＋手机深色，Primary 另跑四视口 × 双主题）。

## 一、新代码放哪（Supabase 三层划分）

| 层 | 放哪 | 内容 | 例子 |
|---|---|---|---|
| `layouts` | `qf-ui.js` 的 `appShellHtml()`／`QFComponents` 的 `app-shell` | 页面骨架：侧栏／顶栏／抽屉／底部导航／内容区 | AppShell |
| `ui` | `QFComponents.register(...)`（`qf-ui.js`） | 跨页复用：按钮、空态、数据卡、重连条、Toast、弹窗 | button、empty-state、stat-card、reconnect-strip |
| `interfaces` | `app.js` 的 `Views.*` | 某功能页专属：设备行、聊天线程、论坛帖 | Views.devices、Views.chat |

规则：

1. 新 UI 一律从 `QFComponents` 取，禁止各页各写一套导航／弹窗／按钮。
   已有页面逐步迁移，不许新开“第二套壳”。
2. 组件只收 `props`，不读全局 `S`、不直接调 `api()`。数据由调用方传入。
3. 文案由调用方传，或走 `t()`（`qf-runtime.js`，W-09）；组件内不写硬编码中文。
4. 颜色只用 CSS token（`qf-tokens.css`）；组件内不写色值字面量（lint-no-colors 管）。
5. 每个组件带 `meta.a11y`：无障碍名、键盘可达、播报角色三选一写清。
6. 改组件先改故事（`*.stories.mjs`），再跑 `components.spec.mjs` 视觉验收。

## 二、布局骨架（AppShell）

- 桌面：固定侧栏（`#sidebar`）＋顶栏（`#top`）＋内容区（`#view`）。
- 窄屏（≤760px）：汉堡抽屉（`#drawer`）＋底部导航（`#bnav`），侧栏隐藏。
- 骨架的唯一实例是 `index.html` 里的静态壳；`appShellHtml()` 返回同一结构，
  不复制第二套壳（见 `qf-ui.js` 注释）。

## 三、已注册组件

| 名称 | props | 层 |
|---|---|---|
| `button` | `label, kind(primary/grey/ghost/danger), size(sm), icon, ariaLabel, attrs, loading` | ui |
| `empty-state` | `title, sub, actions[{label, go, kind}]` | ui |
| `stat-card` | `icon, label, value, sub` | ui |
| `reconnect-strip` | `attempt, max, state`（文案走 `t()`） | ui |
| `app-shell` | —（返回 live 壳结构） | layouts |

## 四、Storybook

- 故事文件为标准 CSF（`title`＋具名导出＋`args`），可直接由 Storybook 加载。
- 沙箱内未跑 `storybook dev` 服务（重型安装，见证据说明）；视觉验收由
  Playwright 画廊（`components.spec.mjs`）覆盖：每个具名故事在 1440px 浅色＋390px 深色下渲染截图；button/Primary 额外覆盖 390／820／1440／1920 四视口 × 浅／深双主题。截图存 `tests/test-results/gallery/`。
- 状态故事覆盖按钮禁用、加载、仅图标的无障碍名与 attrs，空结果／加载失败、数据缺失／零值和重连首轮／取消。故事数据仅为测试夹具。
