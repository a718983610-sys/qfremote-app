# QFRemote 2.4.5 发版门禁清单（W-17 / X-15 仓内可做部分）

> **性质**：config.json、证书、Caddyfile、生产 nginx 配置均不在仓库内，
> 代码层面无法核实。以下步骤**不是代码暂缓**，而是发版时必须在东京
> 服务端（app.qfremote.top）执行的门禁检查；任一不过即不发。
> 执行人：协调人 / 发版执行者。执行后把每项结果（命令输出摘要）
> 贴回发版记录。

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
- [ ] 有效期覆盖发版日（2.4.5 发版日 2026-11-10 之后至少 30 天）；
      共享证书下次自动续期为 2026-11-09，已过期的旧 cert 立即换

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
curl -s -o /dev/null -w '%{http_code} %{url_effective}\n' $BASE/dl/QFRemote-Setup-v2.4.5.exe
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

## 5. release.json 翻牌（W-15，翻牌由协调人做）

```bash
node server/ext/make-release-json.js \
  --exe  QFRemote-Setup-v2.4.5.exe \
  --apk  QFRemote-v2.4.5.apk \
  --version 2.4.5 \
  --min-usable 2.4.5 \
  --out server/meshcentral/public/release.json
```

> QF-17：`--min-usable` 必传（生成器不再默认等于 version）。不抬强更线
> 时传旧版本号（如 `--min-usable 2.4.4`），与 §5.3 条件口径一致。

- [ ] 生成后自校验通过（size/sha256 实测实算）
- [ ] `minUsable` 抬到 `2.4.5` 的条件已满足：App 线 A-1～A-4 通过
      （见深查报告 §5.3；条件不满足时 minUsable 不抬，仍发 2.4.5 包）
- [ ] 官网下载包同步换成新版并真点下载验收：
      大小＋指纹＋包内版本号都等于新版；官网与网页版缓存标记
      （`?v=` / UI 版本号）同步换新，网页版内无旧版文件引用
