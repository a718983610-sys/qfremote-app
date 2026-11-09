# QFRemote 自助注册服务（开放注册，2026-10-24 10:41 改版）

账号产生的第二条路（第一条是管理员后台生成，见 `../account-kit/`）：
用户在注册页填想要的账号名＋密码＋确认密码即可注册，校验通过后服务在后台建号。
**注册码已于 10:41 撤销**——没有码、不用码。MeshCentral 自带公开注册保持关闭
（`newAccounts=false` 不动），注册只走这个自建小服务。

## 构成

| 文件 | 说明 |
|---|---|
| `server.js` | 服务本体（Node 内置模块＋MeshCentral 自带 ws 模块，无额外依赖） |
| `register.html` | 注册页（亮蓝家族风、移动端优先） |
| `qfremote-register.service` | systemd 单元（专用用户 qfreg、开机自启、崩溃自拉） |
| `test-logic.js` | 纯逻辑自测（时间/封禁状态机/账号与密码规则，20 项） |

服务器落位：`/opt/qfremote-register/`，配置 `config.json`（600、qfreg 属主），
数据 `data/state.json`，日志 `logs/register.log`，成功登记 `data/accounts.jsonl`。

## 对外入口（端口方案）

- 监听 **TCP 8444（HTTPS，自签证书，SAN=服务器 IP）**，注册页网址：
  `https://app.qfremote.top/register`
- 为什么不挂在 8443 同源下：MeshCentral 的官方覆盖目录只能放静态文件，
  动态校验端点挂不进去；自签小服务独立端口是最小改动。**Lightsail 防火墙
  需要放行 TCP 8444 才能从公网打开**（部署时只做了本机/隧道验证，放行由站长决定）。
- 管理面零暴露：服务只有页面、`/health`、`/api/register` 三个路由；
  没有任何管理接口；服务账号凭据只在服务器本机 config 里。

## 建号通道与服务账号

- 专用服务账号 **`qf-regsvc`**：站点权只有「管理用户」一位（siteadmin=2），
  无设备组权限；密码 32 位随机、只存服务器 config（600）。mcdb 已把它列入
  永不触碰名单（与站长号同级保护）。
- 建号走官方控制通道的 `adduser` 命令（与 MeshCtrl AddUser 完全一致），
  不直写数据库。新号：无站点权、不入任何设备组——设备与组权由站长后续
  按分发规矩分配（permissions-plan.md）。
- 账号管理全在站长后台（详见《站长操作手册》admin-guide.md）：改名一次由站长
  通道执行（mcdb rename 默认模式、台账当闸门），用完后站长可越权再改；
  用户改自己密码是底子自带功能、不限次。

## 账号与密码规则

- **账号**（用户 10:41 亲定）：最少 8 位、只许字母和数字、字母和数字都要有
  （实现上限 32 位防滥用；系统按小写存储）。重名提示用用户原话：**「该账户已被注册」**。
- **密码**（暂定口径，用户未单独定）：最少 8 位（实现上限 64 位）；
  两次输入不一致会明确提示。

## 失败与封禁口径（防刷保留，与代码一致）

- **设备**＝来源 IP＋设备 cookie（页面种下的 qfr_did）双因子。
- **算一次失败**：账号名格式不对；账号名是保留名；密码太短（含两次密码
  不一致——页面会先拦，到服务端的按失败计）；账号名已被占用；
  建号被服务器以其他原因拒绝。
- **不算失败**：封禁期间的尝试（直接拒、不叠加不延长）；被限速挡掉的尝试；
  成功注册**不清空**当日计数（自然日累计）。
- **封禁**：同设备当日累计失败**超过 5 次**（第 6 次）触发，封到**次日 0 点
  （Asia/Shanghai）**自动解除（下一次请求时判定并落 `ban-expired` 日志）。
- **限速（叠加）**：单 IP 10 分钟内 POST 超过 15 次 → 429。
- 第 3 次失败起，页面提示会带上「再错几次就封」的剩余次数（重名提示除外，
  逐字用用户原话）。

## 站长查账

- 实时日志：`tail -f /opt/qfremote-register/logs/register.log`（JSON 行：
  success / fail（带 reason 与 fails 计数）/ banned / ban-expired /
  blocked-while-banned / ratelimited；只有设备短哈希、IP、尝试的账号名，
  绝不记密码明文）。
- 当前封禁状态：`data/state.json` 的 devices 里 `bannedUntil` 非空即封禁中。
- 注册成功清单：`data/accounts.jsonl`。
