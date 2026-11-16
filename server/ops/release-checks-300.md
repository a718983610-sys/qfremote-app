# QFRemote 3.0.0 发版门禁清单（S-004：由 2.4.5 版按 3.0.0 重写）

> **性质**：config.json、证书、Caddyfile、生产 nginx 配置均不在仓库内，
> 代码层面无法核实。以下步骤**不是代码暂缓**，而是发版时必须在东京
> 服务端（app.qfremote.top）执行的门禁检查；任一不过即不发。
> 执行人：协调人 / 发版执行者。执行后把每项结果（命令输出摘要）
> 贴回发版记录。
>
> **前置硬门（站长亲令）**：新版发布前必须经站长本人点头确认才能
> 发布；未经他点头，哪怕复测全过、深审全过，也不许发版。发版执行＝
> 复测全过＋三端深审过＋文案已点头＋站长点头，四齐才发。
> 旧版 `release-checks-245.md`（2.4.5）已归档，不再作为发版依据。
> 3.0.0 发版为三端＋官网同步发：官网（标准站＋/3.0 专题页）已就绪
> 也是发版门之一，官网下载包必须同步换成新版并真点下载验收（§5）。

## 1. MeshCentral config.json（W-17）

```bash
cat /opt/meshcentral/meshcentral-data/config.json
```

逐项核对（与仓库 `server/nginx/qfremote-proxy` 的反代口径一致）：

- [ ] `cert` 为 `app.qfremote.top`（不得残留已退役的旧 IP 字面量；
      证书名仍为旧 IP 即不过）
- [ ] `agentAliasDNS` 含 `app.qfremote.top`
- [ ] `trustedProxy` 覆盖本机反代（127.0.0.1 / cloudflared 回环）
      ——QF-19：只允许回环/内网地址（127.0.0.1、::1、10/8、172.16/12、
      192.168/16 等内网段），逐项核对每个地址都在回环/内网段内；
      出现任一公网 IP 即不过（否则 X-Forwarded-For 伪造可影响限流/
      审计 IP 归属）
- [ ] `ports`：`8443`（控制台）/ `8444`（注册）/ `8445`（好友）/
      `8446`（论坛/反馈）/ `8448`（ext）/ `8450`（登录垫片）与
      nginx `proxy_pass` 逐一对应，无一错位

## 2. 证书（W-17）

```bash
echo | openssl s_client -connect 127.0.0.1:8443 -servername app.qfremote.top 2>/dev/null \
  | openssl x509 -noout -subject -issuer -dates -ext subjectAltName
echo | openssl s_client -connect 127.0.0.1:443 -servername app.qfremote.top 2>/dev/null \
  | openssl x509 -noout -subject -issuer -dates -ext subjectAltName
```

- [ ] 两处 CN/SAN 均为 `app.qfremote.top`，无旧 IP
- [ ] 有效期覆盖发版日（3.0.0 发版日之后至少 30 天）；已过期的旧
      cert 立即换
- [ ] 证书链完整（QF-18）：两处（8443 控制台与 443 入口）`openssl
      s_client` 加 `-showcerts` 均须见到叶证书＋中级证书（两段以上），
      且 `Verify return code: 0 (ok)`；只验叶证书日期不够——缺中级时
      严格校验的客户端会报链断裂，即使叶证书本身未过期也不过

```bash
for port in 8443 443; do echo | openssl s_client -connect 127.0.0.1:$port -servername app.qfremote.top -showcerts 2>/dev/null | grep -E 's:|i:|Verify return code'; done
```

- [ ] 自动续期健康（QF-18）：服务端实际续期机制（以现状为准，不假设
      工具名——先 `systemctl list-timers --all | grep -iE 'cert|acme|renew'`
      或查对应定时任务确认机制）须有一项对得上：续期任务存在且上次
      成功；且 notAfter 距发版日 ≥30 天。到期日在 30 天内、又无成功
      续期记录时即不过——先等续期成功、notAfter 延后，再发版，
      不许带着“快到期且续期没跑过”的证书发版

## 3. nginx（W-17）

```bash
nginx -t && nginx -T
```

- [ ] `nginx -t` 通过（syntax ok / test successful）
- [ ] `nginx -T` 展开配置中 6 个变量（`$qf_has_xid` /
      `$qf_has_sig` / `$qf_has_qfrem` / `$qf_dup_xid` /
      `$qf_console_upstream` 及生产站点的其余变量）定义齐全、无未定义引用
- [ ] 3 个 include 文件均存在且被引用：
      `/etc/nginx/qfremote-proxy-headers.conf` 与生产站点的其余两个
      include（以 `nginx -T` 输出为准逐一核对路径）
- [ ] `server_name` 为 `app.qfremote.top`；`proxy_pass` 上游端口与
      §1 的 ports 逐一对应

## 4. 逐 location 冒烟（W-17）

在服务端本机执行（须带有效控制台会话 cookie 测需鉴权的项；
cookie 只放命令行环境、不落盘、不贴回记录）：

```bash
BASE=https://app.qfremote.top
curl -s -o /dev/null -w '%{http_code} %{url_effective}\n' $BASE/
curl -s -o /dev/null -w '%{http_code} %{url_effective}\n' $BASE/login
curl -s -o /dev/null -w '%{http_code} %{url_effective}\n' $BASE/console-engine/
curl -s -o /dev/null -w '%{http_code} %{url_effective}\n' $BASE/release.json
curl -s -o /dev/null -w '%{http_code} %{url_effective}\n' $BASE/dl/QFRemote-Setup-v3.0.0.exe
curl -s -o /dev/null -w '%{http_code} %{url_effective}\n' $BASE/api/device/resolve
curl -s -o /dev/null -w '%{http_code} %{url_effective}\n' "$BASE/api/device/presence?nodeid=<已知的设备 nodeid>"
curl -s -o /dev/null -w '%{http_code} %{url_effective}\n' $BASE/lock/
```

- [ ] `/`、`/login`、`/console-engine/`、`/release.json`、`/dl/`、
      `/api/device/resolve`、`/api/device/presence`、`/lock/` 逐一返回
      预期状态（未登录的鉴权端点回 401 属预期；404/502/503 即不过；
      `/api/device/presence` 已登录时回 200 且 code 为 ONLINE/STALE/
      OFFLINE 之一）
- [ ] 桥健康检查（QF-20）：`systemctl is-active qfremote-assistbridge`
      为 active；无令牌调桥 `curl -s -o /dev/null -w '%{http_code}\n'
      http://127.0.0.1:18081/status` 回 401（桥在监听且鉴权门活着；
      回 000/404/500 即不过——桥挂了或鉴权门坏了）
- [ ] `/release.json` 实取内容与生成器输出一致：
      `node server/ext/make-release-json.js --check <线上取回的 release.json> <exe> <apk>`
      （见 `server/ext/make-release-json.js` 的 `--check` 模式）
- [ ] 崩溃上报端点已部署：`POST /api/lea/v1/crash-report` 不再回 404
      （部署与验证随 FI 设备恢复后的同一窗口；未部署即不过）

## 5. release.json 翻牌（W-15，翻牌由协调人做）

```bash
node server/ext/make-release-json.js \
  --exe  QFRemote-Setup-v3.0.0.exe \
  --apk  QFRemote-v3.0.0.apk \
  --version 3.0.0 \
  --min-usable 3.0.0 \
  --sign-key <生产签名密钥，--sign-key 重签，见 S-107> \
  --out server/meshcentral/public/release.json
```

> QF-17：`--min-usable` 必传（生成器不再默认等于 version）。3.0.0
> 为大更（minor+1、patch 归零、强更 minUsable＝新版），不抬强更线
> 时传旧版本号（如 `--min-usable 2.4.4`），与 §5.3 条件口径一致。

- [ ] 生成后自校验通过（size/sha256 实测实算）
- [ ] `minUsable` 抬到 `3.0.0` 的条件已满足：三端深审过、复测全过、
      官网同步就绪、站长已点头；条件不满足时 minUsable 不抬
- [ ] 官网下载包同步换成新版并真点下载验收：
      大小＋指纹＋包内版本号都等于新版；官网与网页版缓存标记
      （`?v=` / UI 版本号）同步换新，网页版内无旧版文件引用；
      缺此项不算发布完成
- [ ] 三端版本号严格一致：`windows/package.json`、
      `installer.nsi`／`installer-outer.nsi` 的 VIProductVersion、
      安卓 `pubspec.yaml`、服务端 `release.json` 均为 3.0.0
      （打包画像验收见 `windows/tools/release-gate.js`）
- [ ] LEA 发版包已编入生产服务端公钥（缺公钥时验签一律拒绝）；
      安卓更新清单已用 `--sign-key` 重签，否则新版安卓客户端
      只能拿到旧版

## 6. 发版后复核（3.0.0 新增）

- [ ] 线上站首屏版本号为 3.0.0（非旧版残留）
- [ ] `/3.0` 专题页可达，下载区版本号／大小／指纹与实物一致
- [ ] Windows／安卓客户端各走一次“下载→安装→登录→在线”全链路
- [ ] 发版记录已贴回本清单每项的命令输出摘要
