# QFRemote 3.0 源码分支（给 Codex 修 BUG 用）

本分支是 QFRemote 3.0.0 的完整最新三端源码，供 Codex 在此修 BUG。

- 基底：冻结 RC 提交 `e2f64258ea45de8cc78dda8ee96dcba6e7c23639`（2026-11-19，A16-S2 合并线），版本 `3.0.0` / build `30000`（见 `version.json`）。
- 本分支在冻结提交之上只加了一笔仓库整理提交（补 `.gitignore` 密钥漏口、补安卓 Gradle Wrapper、加本文件），**没有改任何一行源码**。冻结提交本身一个字节都没动。

## 目录结构

| 目录 | 内容 |
|---|---|
| `windows/` | Windows 客户端（Electron），入口 `windows/package.json`（3.0.0）、`windows/main.js`；LEA 原生代理 C 源码在 `windows/lea/` |
| `android-app/` | Android 客户端（Flutter），`pubspec.yaml`：`3.0.0+30000`；Gradle Wrapper 已补齐（Gradle 8.14.3，AGP 8.7.3），可直接跑 `./gradlew` |
| `server/` | 服务端（MeshCentral 扩展＋Web 控制台），入口 `server/ext/server.js`；LEA 通道三件套在 `server/ext/lea/`（`lea-channel.js`、`lea-core.js`、`lea-routes.js`） |
| `design-tokens/` | 设计令牌唯一正本 `tokens.json`（三端颜色等均以它为准） |
| `contract/`、`matrix/`、`evidence/`、`tests/`、`tools/` | 契约、矩阵、证据、测试、工具 |

## 哪些东西不在这个分支里（别当成已实现）

- **MeshCentral 本体不在树里**：`server/meshcentral/` 只有 `public/`、`views/` 覆盖件。修服务端要先确认 MeshCentral 核心版本来源（以东京部署为准）。
- **B-08 文案未实施**：文案修订还在 QA 缺口阶段，不在本分支。
- **删除设备只有 UI 原型＋API 契约**：`API-DEVICE-REMOVE-V1` 已定稿，服务端真实实现（真实解绑＋授权撤销＋审计）尚未排期，别当成已实现。
- **三端新版 UI 原型不在本分支**：GPT 裁决批准的 HTML/CSS/JS 设计原型在另一处，落到真实代码（Electron/Flutter/Web）的合入方案待定，合入完成前不要按原型改源码。
- **`ops/` 不在本分支**：哨兵、漂移巡查等运维工具在 `v220` 线，不属于三端代码。

## 两条红线

1. **绝不提交密钥、口令、证书**：安卓发布密钥库（`.jks`）、`key.properties`、`KEYSTORE-README*`、`.env`、`*password*`、`*credentials*`、`.p12`/`.pfx`、私钥（`.pem`/`.key`）已被根 `.gitignore` 拦截。签名一律读树外的 `key.properties`，不要把签名文件拷进树里。
2. **`windows/test/agent-heal-startup-test.js` 里嵌着一把测试专用自签 RSA 私钥＋证书**：只在测试内起 `127.0.0.1` 本地 TLS 服务器用，文件内已注明与生产无关。**永不把它当生产证书用，永不把它抄进生产代码路径。** 将来应改为测试运行期现签。

## 版本口径（别用错数）

- 线上在跑的是 **2.4.4**，3.0 未发布；价格四档 ¥2/¥6/¥9.9/¥18；试用 3 天仅 Win/Android，网页版须真实付费；1 密钥＝2 电脑＋1 手机。
- 正式发版有五条门（复测、三端深审、文案、站长点头、官网就绪），当前 0/5，3.0.0 仍 NO-GO。不要在本分支上直接发版。
- A1/B1/C1（首装两段式、通道自愈、API 一键打通）的代码已在树内，但**代码进树 ≠ 验收通过**，验收结论以验证线报告为准。
