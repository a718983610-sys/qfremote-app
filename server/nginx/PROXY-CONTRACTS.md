# QFRemote 边缘反代契约（S-088，2026-11-15）

> 正本：`server/nginx/qfremote-proxy`（主配置）＋
> `server/nginx/qfremote-proxy-headers.conf`（安全头）＋
> `server/nginx/qf-front-proxy-common.inc`（公共请求头）。
> 三个文件全部纳入仓库；部署清单 `deploy/manifest.yml` 登记各自 hash，
> 部署后以 `nginx -T` 输出做指纹比对（见末节）。
> 线上 `/etc/nginx/` 若有手工改动，须先合进仓库正本，不可直接覆盖上线。
> 校验：`node server/nginx/check-nginx-contract.mjs`（沙箱跑 `nginx -T` 展开断言）。

## 0. 总则

- 只听回环 `127.0.0.1:8080`；公网唯一入口是 Cloudflare 快速隧道（cloudflared）。
- 未列明路径一律 404（兜底透传已于 2.4.0 删除，G6 隔离面）。
- 安全头统一由边缘输出：每个带 `proxy_pass` 的 location 都 include
  `qfremote-proxy-headers.conf`（HSTS、nosniff、Referrer-Policy、
  Permissions-Policy、X-Frame-Options SAMEORIGIN）。
  例外只有内部子请求 `location = /_qf_whoami`（`internal`，响应头不发往客户端）。
- 全站 CSP 故意不设：控制台（MeshCentral）含内联脚本，直接上 CSP 会断功能；
  如需 CSP 须先做 nonce 改造，另立项。论坛 server.js 的 frame-ancestors
  单指令是全仓唯一 CSP，不动。
- 请求头公共部分统一走 `qf-front-proxy-common.inc`：
  `Host $host`、`X-Real-IP $qf_client_ip`、`X-Forwarded-For $qf_client_ip`、
  `X-Forwarded-Proto https`（恒 https——nginx 与 cloudflared 之间是明文 http，
  取 `$scheme` 会谎报 http）、`CF-Connecting-IP $qf_client_ip`
  （Cloudflare 边缘覆写注入，原样透传；后端 S-091 只认回环来源的该头）。
- WebSocket 位置（`.ashx`、`/console-engine/`）各自显式设
  `Upgrade $http_upgrade`／`Connection "upgrade"`，common.inc 里不放升级头。
- `add_header` 继承规则：location 内一旦有自有 `add_header`
  （如 `/app.js` 的 `Cache-Control: no-store`），server 级继承即失效，
  故这类 location 须在同块内显式 include 安全头文件（已全数补齐）。
- **已知缺口（S-078 未闭合，待部署窗口核对）**：主配置引用了六个
  不在仓库文件里的变量——`$qf_login_upstream`、`$qf_root_final`、
  `$qf_engine_upstream`、`$qf_spa_upstream`、`$qf_frame_ua`、`$qf_ce_ua`——
  其 map 定义在服务器主 conf（`/etc/nginx/nginx.conf` 或 conf.d，
  不在仓库）。仓库内 `check-nginx-contract.mjs` 跑 `-T` 时用桩 map
  （一律指 8443／SPA 8082）只验语法，桩值不代表线上真实分流值；
  部署窗口须把线上这六个 map 的定义抄回仓库（或确认其所在文件已纳入
  部署清单），否则“全部 include 纳入仓库”不算闭合。
  同理：`qf-front-proxy-common.inc` 的线上真实内容此前未知，
  本次以仓库重建版为准，部署时必须与线上逐项 diff 后再 reload。
- body 上限分层（S-077）：server 默认 `10m`；小 JSON API 各自 `1m`；
  仅三个大体量上传路径放宽（见 §2）。后端 `readJsonBody` 另有
  自己的上限（付款截图 17MB、文件发送 288MB），nginx 须留头、不压后端。

## 1. path family 契约表

| 路径 | 上游 | Host | XFF/XFP | Cookie | Upgrade | 超时 | buffering | body | 安全头 | 备注 |
|---|---|---|---|---|---|---|---|---|---|---|
| `= /register`、`= /api/register` | 8444 注册（https，自签，`proxy_ssl_verify off`） | `$host` | 透传 | 透传 | — | 默认 | 默认 | 1m（`/api/register`） | 有 | `/register` 文档请求 302 回 `/` |
| `= /friends`、`/api/friends`、`= /chat`、`/chat/` | 8445 好友／聊天（https 自签） | `$host` | 透传 | 透传 | — | 默认 | 默认 | 1m（API） | 有 | 聊天无上传；`/chat` GET 302 回 `/#chat` |
| `= /api/feedback`、`= /forum`、`/api/forum` | 8446 论坛（http） | `$host` | 透传 | 透传 | — | 默认 | 默认 | 1m（API） | 有 | 留言与论坛同进程 |
| `= /appeal`、`/appeal/`、`= /qf-login` | 8450 登录垫片（http） | `$host` | 透传 | 透传 | — | 默认 | 默认 | 1m（`/appeal/`、`/qf-login`） | 有 | 申诉为纯文本、无图片上传 |
| `= /admin`、`/admin/`、`= /home`、`/home/`、`= /purchase`、`= /license/status`、`= /license/rebind`、`/assistant-api/`、`= /points`、`/points/`、`= /profile`、`/profile/`、`/license/`、`= /api/device/resolve`、`/api/lea/` | 8448 ext（http） | `$host` | 透传 | 透传（`/api/lea/` 崩溃上报除外：客户端不附 Cookie，服务端忽略） | — | 默认（`/api/lea/` 30s、`＝/health` 2s/5s） | 默认 | 1m（`/license/` 其余接口亦 1m） | 有 | `/api/lea/` 为 N-01 补齐（此前 404）；`/assistant-api/` 高频轮询不挂限流 |
| `= /license/api/files/send`、`~ ^/license/api/files/stream/[^/]+/chunk$` | 8448 ext（http） | `$host` | 透传 | 透传 | — | body 300s、read 300s | 默认 | **300m** | 有 | 并发每 IP 2 路（`limit_conn qf_upload 2`）；单文件上限 200MB，base64 约 267MB，后端 288MB |
| `~ ^/license/api/pay/orders/[^/]+/(submit\|recognize)$` | 8448 ext（http） | `$host` | 透传 | 透传 | — | body 120s、read 120s | 并发每 IP 2 路 | **25m** | 有 | 付款截图上限 12MB 图，base64 约 16MB，后端 17MB |
| `= /health` | 8448 ext（http） | `$host` | 透传 | — | — | connect 2s、read 5s | 默认 | 1m | 有 | S-080 首页灯探活（ext 已有 `GET /health`，回 `{ok:true}`，no-store） |
| `= /support`、`/support/`、`/support/api/` | 8445 好友服务（https 自签） | `$host` | 透传 | 透传 | — | 默认 | 默认 | 1m（`/support/api/`） | 有 | 智能客服 |
| `/lock/` | 8445 锁桥（https 自签） | `$host` | 透传 | 透传 | — | 默认 | 默认 | 1m | 有 | proxy_pass 不带 URI 段，保留 `/lock/` 前缀 |
| `= /release.json` | 8443 引擎（https 自签） | `$host` | 透传 | 透传 | — | 默认 | 默认 | —（GET） | 有 | 更新清单显式成路 |
| `~* ^/dl/([^/]+\.(exe\|apk\|zip\|txt))$` | 8443 引擎（https 自签） | `$host` | 透传 | 透传 | — | read/send 3600s | off | —（GET） | 有 | 安装包直下；`.json` 不放行（404） |
| `= /login`、`= /` | 变量上游（`$qf_login_upstream`／`$qf_root_final`，垫片／引擎／SPA 分流） | common | 透传 | 透传 | — | 600s（`/`） | 默认 | 默认 10m | 有 | `auth_request /_qf_whoami`；whoami 故障 fail-soft 落 SPA（`@qf_spa_failsafe`） |
| `@qf_spa_failsafe` | `http://qf_spa_upstream` | `$host` | 透传 | 透传 | — | 默认 | 默认 | 默认 10m | 有 | 仅故障落点 |
| `= /_qf_whoami` | 8450 垫片（http） | — | 透传 | 原样透传（`Cookie $http_cookie`） | — | 1s×3 | 默认 | body 关闭（`proxy_pass_request_body off`） | 无（内部子请求） | 契约恒 200＋`X-QF-Role` |
| `/scripts/`、`/styles/`、`/images/`、`/js/`、`/novnc/`、`/mstsc/`、`/samples/`、`/sounds/`、`/translations/`、`/favicon.ico`、`/robots.txt`、`/serviceworker.js`、`/logo.png`、`~* ^/commander[^/]*\.htm$`、`/meshagents`、`/meshsettings`、`/downloads/`、`= /logout` | 引擎（`$qf_engine_upstream`） | common | 透传 | 透传 | — | 默认 | 默认 | 默认 10m | 有 | 引擎静态／功能路径 |
| `/console-engine/`、`= /console-engine` | `$qf_console_upstream`（垫片／引擎） | common | 透传 | 透传 | **有** | 86400s | off | 默认 10m | 有 | rewrite 剥 `/console-engine/` 前缀；`User-Agent $qf_ce_ua` |
| `~* ^/console-engine/(.+\.ashx)$`、`~* \.ashx$` | 引擎 | `$host` | 透传 | 透传 | **有** | 86400s（条 16，不得压短） | off | 默认 10m | 有 | 会话数据面全集；前者先剥前缀 |
| `= /app.js`、`= /app.css`、`= /session.css`、`/assets/`、`= /apple-touch-icon*.png` | 静态直发（`root`／`alias /opt/qfremote-webapp`） | — | — | — | — | — | — | — | 有 | `app.js/css` 为 `no-store`；图标 `max-age=86400` |
| `= /home/`、`= /admin/`、`= /index.html`、`= /appeal/` | return 302/301 | — | — | — | — | — | — | — | — | 尾斜杠／首页归一 |

## 2. 上传与磁盘保护（S-077）

- 默认 `client_max_body_size 10m`：任意未列明路径的超大体在边缘即被 413 拦下，
  到不了后端；小 JSON API 各自 `1m`（§1 表）。
- 仅三个路径放宽（§1 表）：`files/send` 与 `stream chunk` 300m、
  `pay submit/recognize` 25m——数值按后端上限（288MB／17MB）加头定死，
  新增上传路径须先改后端上限、再改本文件、再改本契约，不得只改一边。
- 并发：`limit_conn_zone $qf_client_ip zone=qf_upload:10m`（http 层），
  三个大体量 location 各 `limit_conn qf_upload 2`（每 IP 同时 2 路）。
- 磁盘：`client_body` 走默认临时目录（`/var/lib/nginx/tmp/client_body`）；
  300m 体量×每 IP 2 路，最坏单 IP 占盘 600MB；部署前确认该盘余量，
  并与 ext 服务端 1GB 轮转封顶、崩溃报告 5000 份／1GB 封顶共同看待。
- 认证：上传路径不另设边缘鉴权——三个路径均在 `/license/` 下，
  由 ext 服务端会话鉴权守门；边缘只做体量／并发／磁盘三层。

## 3. 部署与指纹比对（S-078）

1. 部署清单 `deploy/manifest.yml` 登记三个文件的 sha256（部署时实算填入）。
2. 拷到线上：`qfremote-proxy` → `/etc/nginx/qfremote-proxy`（或 sites-available
   内的同名文件，按线上实际布局）、另两个文件 → `/etc/nginx/` 同名。
3. 部署前 `diff` 线上 `/etc/nginx/` 同名文件：线上若有仓库没有的手工改动，
   先合进仓库正本再上线，不可直接覆盖。
4. 部署后跑 `nginx -T`，把展开配置与仓库正本逐项比对（安全头在位、
   `/api/lea/` 与 `/health` 在位、body 分层一致、无相对路径 include）。
   仓库内校验脚本：`node server/nginx/check-nginx-contract.mjs`
   （在沙箱搭临时配置跑 `nginx -T` 做同一组断言）。
5. `nginx -t` 通过后 `nginx -s reload`；线上实际上传核验（200MB 文件发送、
   12MB 付款截图提交）随部署窗口做，不在仓库内谎称已验。

## M-026 / M-158 修复说明

所有反代位置（含 `/assistant-api/` 与内部 whoami）显式传递 Cloudflare 边缘地址，XFF 被覆写而非追加客户端输入；后端仅从回环 socket 接受合法的 CF-Connecting-IP，无该头则使用 socket 地址。此信任建立在 cloudflared 是回环监听器唯一公网入口的部署前提上。上传并发也按边缘 IP 分桶。`proxy_ssl_verify off` 只适用于已注明的本机自签 HTTPS 上游，六个外置 map 的真实值仍须部署窗口核对（M-159 未闭合）。
