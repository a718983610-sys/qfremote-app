# LEA 吊销 Fail-Closed 设计（X-01／X-02，3.0.0）

> 状态：已落地（2026-11-15，L1 线）。站长亲令：D-03 严格 fail-closed
> 启动，无自动迁移、显式迁移工具。取代大肥鱼 DS-D03 原回复“默认单机
> 威胁模型下可接受两项残留进 3.0.0，不阻断”的结论——冲突处以站长口径
> 为准（见下 §6）。

## 1. 背景：D-03 是什么

旧版吊销表（`revoked_keys.txt`）没有世代 sidecar（`.gen`）。启动时若
`.gen` 缺失但旧版快照存在，旧实现自动做一次性迁移：写 `.gen=1`＋迁移
标记（`revoked_keys.migrated`，内容 `"1\n"`）。大肥鱼 DS-D03 指出两项
残留：

- ① 一次性世代重置：迁移恒写 `.gen=1`，若真实世代高于 1，世代被重置。
- ② 同删重迁移：`.gen` 和标记同时被删后，下次启动会静默重新迁移，
  吊销状态可被回滚而不留痕迹。

X-01 把自动迁移整个取消；X-02 两项残留随之消除（见 §5）。

## 2. 启动矩阵（`revocation_startup_init`，`windows/lea/QFRLEA.c`）

| 情形 | 行为 |
| --- | --- |
| 首次安装（无 `.gen`、无绑定历史、文件缺失） | 初始化空表＋`.gen=0`＋标记（各带 SYSTEM／Administrators ACL），ACTIVE |
| `.gen` 损坏／不可读 | DEGRADED |
| `.gen` 在位但形态／ACL 不符 | DEGRADED |
| 文件缺失＋有历史（有 `.gen` 或绑定历史） | DEGRADED |
| 文件存在但严格校验失败 | DEGRADED |
| **无 `.gen`＋有旧版快照（snap==-1）** | **DEGRADED**（不再自动迁移；须管理员显式迁移，见 §3） |
| 文件存在且校验通过 | ACTIVE（世代跟进高水位） |

DEGRADED 不是锁死：显式迁移写 `.gen` 后，下次检查通过即清零，无需
重启。H21 推送恢复表内容后仍须显式迁移（有历史时推送不写 `.gen`，
见 §4）。DEGRADED 期间业务信封一律拒绝（吊销态不可确立＝不可执行）。
**运行期检查与启动同一口径**：`key_revocation_check` 在 `snap==-1`
时一律 ERROR（不分已加载／未加载世代），否则启动置的 DEGRADED 会
被首个信封的检查清掉、绕过显式迁移（大肥鱼复核后自查发现并修复）。

纯函数 `lea_revoked_migration_decision`（`windows/lea/lea_state.c`）
已改为：`snap>=0` → 0 放行；`snap==-1` → 一律 -1（DEGRADED）。
旧返回值 1（需一次性迁移）已删除，单测期望同步改为 -1。

## 3. 显式迁移工具（`QFRLEA.exe --migrate-revoked [--generation N] [--accept-empty]`）

- 本地子命令（`lea_is_service_subcommand`），只认本地命令行；命名管道／
  LEA API／qf-lea-client 调不到。
- 须管理员权限：写 `%ProgramData%\QFR\LEA\state\` 下状态文件＋设
  SYSTEM／Administrators 专属 ACL；非管理员时写盘／ACL 失败即报错退出。
- 前置检查（任一失败即拒绝，不写残集）：
  1. `.gen` 已存在 → 拒绝覆盖；
  2. 快照须通过严格校验（`lea_revoked_validate_snapshot`）。唯一例外：
     文件存在且 0 字节＝旧版从未吊销过任何 Key 的合法空表，**且须管理
     员显式带 `--accept-empty` 才按空表迁移**（大肥鱼复核：0 字节不能
     自证，崩溃截断／磁盘损坏／清空都可能产生 0 字节；无此旗即拒绝，
     记高风险日志）；文件缺失／内容损坏一律拒绝，须从备份恢复。
- `--generation N`：写入的世代，缺省 1，须 ≥1；应与服务端／备份的真实
  世代一致。下次服务端同步世代更高时向上纠正（服务端写命令只接受
  incoming ≥ 当前值）。
- 成功：写 `.gen=<N>`＋标记（同款 ACL），记 `svc_log` 日志＋stdout 回显。
  服务正在跑时也可迁移：下次吊销检查通过即自动脱离 DEGRADED，无需重启。

## 4. 服务端护栏（`server/ext/lea/lea-core.js`，`leaRevocationsWriteCmd`）

H21 推送写盘的 PowerShell 命令带守卫，`.gen` 缺失时分两种情形：
- **无历史**（`binding.dat` 不存在且表缺失／空表，首次安装）：写表＋
  写 `.gen`，初始化；
- **有历史**（`binding.dat` 存在或表非空，旧版快照／表被删）：只写表、
  跳过写 `.gen`——服务端恢复的是表内容（服务端全集权威、只增不减），
  世代仍须管理员在设备上跑显式迁移工具授予；设备在显式迁移前保持
  DEGRADED（C 侧运行期检查与启动同口径，见 §2）。
旧口径“表非空即抛错不写盘”会把有历史＋表缺失的设备卡死（表回不来、
工具又拒绝缺失文件），故改为写表跳 `.gen`。世代文件损坏（非纯数字）
仍抛错不写盘（fail-closed）。

## 5. X-02 两条验收

### ① 一次性世代重置——已堵（有界窗口，列入已知局限）

- 只有显式工具能写 `.gen`；缺省 1，但支持 `--generation N`，由管理员
  按服务端／备份填真实世代。
- 下次服务端同步世代更高时向上纠正（只接受 incoming ≥ 当前值）。
- 窗口有界：世代只是排序元数据，真正执行吊销的是表内容（被吊销的
  Key ID 全集）；世代偏低只影响“陈旧快照判定”的严格程度，不会放行
  已吊销的 Key——准入另查表内容，且服务端 `admit()` 实时查台账。
  内容单调有三重保证（大肥鱼复核后书面论证）：① 服务端吊销全集只
  增不减（吊销不可逆），H21 推送的永远是当前全集，不存在“更旧的全
  量”；② 世代门（incoming < 当前值拒绝）；③ 合并路径（`keys.sync-
  revoked`、`lea.key_revoked`）一律并集合并、不覆盖删除。执行前二次
  检查（`execute_item`，见 §7 第 5 条）兜底离线窗口。
- 记为已知局限（见 §7）。

### ② 同删重迁移——已消除

- 自动迁移取消后，同删 `.gen` 和标记只会进 DEGRADED，不再静默重迁移；
  恢复须显式工具（有 `svc_log` 日志）。
- 注意：同删＋再删绑定历史（`binding.dat`）＋删表，会退化为“首次安装”
  形态（见 §7 第 1 条已知局限）——这是本地管理员权限的边界，不是
  迁移逻辑的漏洞。

## 6. 大肥鱼 5 项前提（DS-D03-RESIDUAL-REPLY.md）落实情况

| # | 前提 | 落实 |
| --- | --- | --- |
| 1 | 安全文档明确威胁模型边界（不防御拥有吊销表目录写权限的本地主体／本地管理员） | 本文件 §7。本地管理员能删改状态文件是设计边界，不是本机制防御的目标；机制保证的是“删改可被发现（DEGRADED），恢复须显式留痕”，而非“删不掉”。 |
| 2 | `.gen` 和迁移标记 ACL 不弱于吊销表，普通用户不可删 | 三者同款 `set_sys_admin_acl`（SYSTEM／Administrators 专属）；启动时校验三者形态（普通文件）＋ACL，任一失败即 DEGRADED。 |
| 3 | 首次迁移、重新迁移、DEGRADED、元数据缺失加审计／告警 | 启动 DEGRADED 记 `svc_log` ERROR；显式迁移记 `svc_log`＋stdout；`sys.info` 新增 `revocation_state`（`ok`／`degraded`）字段供服务端／诊断读取；吊销检查每次重验，恢复即记 `revoked table OK generation=…`。 |
| 4 | “本地管理员可回滚吊销状态、同删元数据可重迁移”列入已知局限 | 本文件 §7。 |
| 5 | 若产品安全承诺包含“防本地管理员回滚”，则改为阻断，须 TPM／受保护存储／远程高水位，而非仅加显式迁移工具 | 产品承诺（站长定）：**不包含**防本地管理员回滚。见 §7 第 1 条。若将来承诺改变，须按本条改方案（TPM／受保护存储／远程高水位），不得只靠加显式迁移工具。 |

与大肥鱼原回复的分歧（单列）：大肥鱼 DS-D03 原回复主张“保留自动
迁移、不建议阻断”，站长 2026-11-15 亲令改为严格 fail-closed 进
3.0.0。冲突处以站长口径为准，本实现按站长口径落地。

## 7. 威胁模型边界与已知局限

1. **不防御本地管理员。** 拥有吊销表目录（`%ProgramData%\QFR\LEA\
   state\`）写权限的本地主体／本地管理员可以删除 `.gen`、标记、
   吊销表乃至绑定历史，伪造一次“首次安装”。本机制不承诺防住这种
   回滚；它承诺的是：删改会被发现（DEGRADED，业务停摆并记日志），
   恢复必须走显式迁移（留日志），而不是静默自愈。若产品将来承诺
   防本地管理员回滚，须改用 TPM／受保护存储／远程高水位方案。
2. **显式迁移的世代缺省为 1。** 管理员未填 `--generation N` 时写 1；
   真实世代更高时，下次服务端同步向上纠正。纠正前，世代偏低只影响
   陈旧判定，不影响吊销执行（表内容＋服务端实时准入兜底）。
3. **空表迁移例外须显式确认。** 0 字节文件按合法空表迁移（旧版从未吊
   销过 Key）须管理员显式带 `--accept-empty`；无此旗即拒绝。0 字节也
   可能是截断损坏——工具是管理员显式操作，管理员本人对“这就是空表”
   负责；有疑问时应先从备份恢复，而非直接迁移。启动时 0 字节文件一
   律 DEGRADED，从不自动按空表迁移。
4. **踢出命令尽力而为。** `lea.key_revoked` 的表合并失败不阻断清队／
   强杀（服务端 H21 推送是主同步路径）；设备离线时踢出命令到不了，
   吊销仍即时生效（服务端 `admit()` 实时拦＋下次下发前 H21 重推）。
   强杀结果分两档回报（大肥鱼复核后落改）：`killed_active`＝进程树
   已强杀；`marked_active`＝无子进程句柄、只置标志，等执行器返回后
   改判——**只置标志不是“已终止”**，在途的转发／文件操作可能在标志
   生效前已产生副作用；高危操作立即停止须短租约／协作取消（后续线）。
5. **执行前二次检查。** 排队命令在执行前复查吊销表（`execute_item`，
   与 H10 过期预检同款收尾，幂等记 FAILED 终态）：入队后、执行前 Key
   被吊销的命令不得执行。离线期间吊销到达、旧排队命令在下次接触前
   仍可能执行——60 秒信封 TTL 兜底一部分，本检查彻底堵住。**离线设
   备的残余风险**：设备离线时本地已排队／活动任务无出站通道可拉取吊
   销高水位，须待下次接触；RC-02 承诺范围是在线会话，设备主动拉取
   ／短租约／心跳同步须新增出站通道与租约子系统，超出 L1 范围，记为
   产品级残余风险（建议后续线评估）。
6. **半迁移／崩溃一致性。** `.gen` 与标记写均 tmp+rename 原子；半迁
   移态均有确定归宿（仅 `.gen`→可工作，标记只在 `.gen` 缺失时看；
   仅标记→DEGRADED，工具可重跑）；断电丢 rename 只回到迁移前
   （DEGRADED），fail-closed，不丢安全。未做 fsync／目录刷新是已知
   局限。
7. **DEGRADED 下统一拒信封。** DEGRADED 期间所有信封（含 `sys.ping`／
   `sys.info`）一律拒绝，失败本身就是信号；迁移后下次检查／下发即
   恢复，无需强制同步。

## 8. 相关文件

- `windows/lea/QFRLEA.c`：`revocation_startup_init`（X-01）、
  `revoked_migrate_legacy_snapshot_gen`、`lea_migrate_revoked_cmd`、
  `lea_drain_queue_revoked`、`lea_active_job_kill_revoked`、
  `lea.key_revoked` 内部命令、`sys.info` 的 `revocation_state` 字段。
- `windows/lea/lea_state.{h,c}`：`lea_revoked_migration_decision`
  （恒 -1）、`lea_queue_remove_key`。
- `windows/lea/lea_install.c`：`--migrate-revoked` 子命令注册。
- `windows/lea/lea_protocol.{h,c}`／`lea_crypto.{h,c}`：RC-01 握手
  （`sys.handshake`、`LEA_ERR_HANDSHAKE_REQUIRED`、
  `lea_server_pubkey_fingerprint`）。
- `server/ext/lea/lea-core.js`：`leaRevocationsWriteCmd` 守卫、
  `kickRevokedSessions`（RC-02）。
- `server/ext/lea/RC-04-RECONNECT-TICKET-SPEC.md`：RC-04 重连票据规范。
- 故障注入 S8b 预期变更：同删 `.gen` 和标记后不再是“自动重建
  `.gen=1`”，而是 DEGRADED＋显式迁移（须 L7／故障注入线更新计划，
  本线不擅自改他线计划文件）。
