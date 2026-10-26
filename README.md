# QFRemote

QFRemote 是我们自有的远程控制软件：电脑装一次，之后用电脑软件、手机 App 或手机浏览器打开，就能连上你的电脑。

## 安卓控制端（android-app/）

Flutter 壳，与 Windows 版同口径：打开直达控制台、登录记住、断线自动重连、软件内更新（查同一份版本清单）。云端 GitHub Actions 编译，专属签名。

- 手动跑构建：仓库 Actions 页选「Android 正式构建」→ Run workflow；产物在该次运行的 Artifacts 里。

## Windows 控制端

- 官方网站与下载：见官网（GitHub Pages，仓库 `qfremote-website`）
- 安装包：见本仓库 Releases（只认正式版，草稿与预发布不要下载）
- 每个安装包都会公布 SHA-256 校验值，下载后可对照确认没被掉包

## 发版流程（写死三步）

1. 新安装包传到本仓库 Releases（正式版）；
2. 更新服务端软件内更新的版本清单；
3. 同步官网 `qfremote-website` 仓库的 `product.json`（版本/下载/校验码/日志/截图/功能点）。

QFRemote 基于开源项目 MeshCentral（Apache-2.0 许可证）构建。

## 平台正本规矩（2026-10-26 站长令立，全员执行）

本仓库自 2026-10-26 起是 QFRemote **全部生产代码的单一正本**：网页端、服务端、Windows 壳、安卓端都在这一处。此前「本地工目录一份、服务器一份、谁新谁旧说不清」的局面到此为止——今日多起事故（底本过期、整份覆盖、补丁散落）都源于此。

### 目录

| 目录 | 对应线上位置 |
|---|---|
| `server/webapp/` | 服务器 `/opt/qfremote-webapp/`（控制台三件＋assets） |
| `server/ext/` | `/opt/qfremote-ext/`（许可、订单、积分、站长后台、首页） |
| `server/loginshim/` | `/opt/qfremote-loginshim/`（登录垫片、申诉） |
| `server/register/` | `/opt/qfremote-register/`（注册服务） |
| `server/friends/` | `/opt/qfremote-friends/`（好友/聊天/客服，含 chat/、support/） |
| `server/forum/` | `/opt/qfremote-forum/`（论坛服务） |
| `server/meshcentral/` | `/opt/meshcentral/meshcentral-web/` 下的自有覆盖（login2 模板、custom.js、release.json） |
| `server/nginx/` | `/etc/nginx/sites-enabled/qfremote-proxy` |
| `server/lock/` | `/opt/qfremote-lock/`（仅公钥标记；二进制与私钥不入库） |
| `windows/` | Windows 壳源码（本机 `app-src` 树的正本） |
| `android-app/` | 安卓壳（既有面，云端 Actions 构建） |
| `ops/` | 运维脚本（漂移巡查、助手事件哨兵） |

初始入库的逐面指纹对账见 [FINGERPRINTS.md](FINGERPRINTS.md)。

### 五条铁规

1. **补丁 = 提交。** 任何修复先在本仓库改、提交，再谈部署；一个修复一个提交，提交信息注明对应的台账编号（如 P2-022）。禁止拿散落工目录里的文件直接往服务器上贴。
2. **部署 = 同步指定提交。** 部署就是把某个已提交的版本同步到服务器，部署后必须核对线上指纹与该提交逐字一致，并回登记。先部署后补提交，禁止。
3. **底本永远从仓库拉。** 动手前先 `git pull`；发现线上与仓库不一致时，先按第 4 条回收对齐，不许就地在服务器上改完就走。
4. **带外变更当日回收。** 站长后台操作、紧急热修等没走仓库的线上变更，必须在当日把现行字节回收进仓库并提交，提交信息注明出处与原因。
5. **密钥与数据永不入库。** 令牌、密钥、凭据、各服务真实 config.json、运行数据、备份文件一律不进仓库（根目录 `.gitignore` 是防护网不是借口）；任何新文件入库前先过秘密扫描，真秘密 0 命中才许推。

### 漂移巡查

`ops/drift-check.sh` 每日自动比对仓库 `origin/main` 与线上关键面的指纹，只报不改：一致则静默，漂移则在 QFRemote 工作聊天逐项报告，由主会话按第 4 条处置（回收或回滚）。任何人不得以「巡查没报」为由跳过部署后的指纹核对（第 2 条）。

### 旧正本退役

本地 `web-rebuild/`、`web-overrides/`、`app-src` 裸树、v231/v232 各工目录里的代码副本，自本规矩生效起一律降为历史参考；与本仓库冲突时，以本仓库为准。
