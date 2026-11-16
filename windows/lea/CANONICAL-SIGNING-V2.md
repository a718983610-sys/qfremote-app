# LEA 信封规范串 v2（CANONICAL-SIGNING-V2）

> 状态：**现行规范**。2026-11-14 由 F-02 修复引入，取代信封规范串 v1。
> 票据规范串仍为 v1，见 `ds-review-stage2/CANONICAL-SIGNING-V1.md` §3（9 行），
> 本文档只规范**信封**。服务端（`server/ext/lea/lea-core.js`）与设备端
> （`windows/lea/lea_protocol.c`）按本文档实现，两端逐字节一致。

## §1 版本策略：v2-only，无回落

- 信封 `version` 字段必须为 `2`；`version != 2`（含旧 v1 信封）直接拒绝，
  错误码 `QFR_LEA_BAD_ENVELOPE`（detail `version`），无回落、无版本协商、
  不设版本降级开关。
- 协议版本**不得做成可随意降级的配置开关**：回滚必须成对——服务端回滚到
  发 v1、设备端仍只收 v2 时系统不可用；回滚即两端同版本成对回滚。
- 切换窗口：两端必须同步升级；窗口内一端未升级则命令全失败（fail-closed，
  不是静默降级）。已签发未执行的 v1 信封会失效；信封 TTL 仅 60 秒，
  影响窗口短，但切换时仍须排空队列并观察失败率。
- 文档与审计同步版本化归档：本文件为 v2 规范源；再改规范须升 v3，
  不得悄悄改 v2。

## §2 信封规范串 v2：20 行

域名行 `qfr-lea-envelope-v2`，LF（`\n`）连接，**无结尾换行**，不允许混合行尾
（`\r`、CRLF 一律非法）。行数固定 20 行，每一行都必须存在。

| 行 | 内容 | 说明 |
|---|---|---|
| 1 | `qfr-lea-envelope-v2` | 域名行 |
| 2 | `version` | 固定 `2` |
| 3 | `request_id` | token 规则 |
| 4 | `batch_id` | 缺省为空行（见 §4） |
| 5 | `seq` | ≥1 的整数 |
| 6 | `device_id` | id 规则（§1 身份字段） |
| 7 | `account_id` | id 规则 |
| 8 | `api_key_id` | id 规则 |
| 9 | `binding_epoch` | 安全整数 |
| 10 | `grant_epoch` | **F-02 新增**：无符号整数，见 §3 |
| 11 | `nonce` | token 规则 |
| 12 | `issued_at` | 安全整数（unix 秒） |
| 13 | `expires_at` | 安全整数（unix 秒） |
| 14 | `idempotency_key` | token 规则 |
| 15 | `command` | 命令表内命令 |
| 16 | `params` 的 SHA-256 hex | params 只签其 stable JSON 的 SHA-256（小写 hex） |
| 17 | `timeout_ms` | 有效超时（线上值或命令默认值） |
| 18 | `job_id` | 缺省为空行（见 §4） |
| 19 | `mode` | 缺省为空行（见 §4） |
| 20 | `deadline_ms` | 缺省为 `0`（见 §4） |

字段顺序固定，不得调换；行数固定，不得省略任何一行（包括缺省为空的行）。

### §2.1 定稿向量（JS 与 C 同一向量，逐字节相等）

输入：`version=2, request_id=req-0000001, batch_id=batch-0001, seq=1,
device_id=node-1, account_id=alice, api_key_id=key-abc12345,
binding_epoch=3, grant_epoch=1, nonce=nonce-00001,
issued_at=1780000000, expires_at=1780000060,
idempotency_key=idem-key-0001, command=ui.click,
params={"a":1,"b":2}（stable JSON，SHA-256 见下）, timeout_ms=5000`
（`job_id`／`mode`／`deadline_ms` 缺省 → `''`／`''`／`0`）。

```
qfr-lea-envelope-v2
2
req-0000001
batch-0001
1
node-1
alice
key-abc12345
3
1
nonce-00001
1780000000
1780000060
idem-key-0001
ui.click
43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777
5000


0
```

（末三行依次为 `job_id=''`、`mode=''`、`deadline_ms=0`；整串无结尾换行。）
params 哈希：`SHA-256('{"a":1,"b":2}') =
43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777`。

## §3 grant_epoch 语义与表示

- 语义：账号授权代次。服务端 `grant_epoch` 只在“首次授予／撤销后重授予”
  两个代次跃迁时递增；Key 生成时盖上当时值，服务端 `admit()` 与设备端
  `lea_admit()` 各比对一次。撤销后旧 `grant_epoch` 的 Key 永不复活，
  重授予后须发新 Key。
- 位置：规范串第 10 行，`binding_epoch` 之后一行；信封 JSON 字段
  `"grant_epoch"` 同样在 `"binding_epoch"` 之后（字段顺序不影响 JSON
  解析，但两端组包保持同一顺序）。
- 表示：无符号整数，位宽逻辑上 64 位，但**线上传输与规范串的上限为
  2^53-1（9007199254740991）**——JS `Number` 安全整数界；C 端解析
  超此界即拒绝，保证 JS `String()` 结果与 C 端 `long long` 解析值
  逐字节一致。最短十进制表示：无前导零（`0` 本身除外）、无 `+` 号、
  无负号、无空格、无千分位；`0` 单独表示为 `0`。
- 校验：JS 端 `Number.isSafeInteger` 且 `>= 0`；C 端严格切片解析
  （全数字、无符号位、无前导零、拒绝溢出、拒绝尾随字符、拒绝空串、
  拒绝 `> 2^53-1`）。`grant_epoch` 缺失即非法，**不得缺省为 0 后
  签名／验签**。
- 设备端准入：`env.grant_epoch == bind->grant_epoch` 否则拒绝，
  错误码 `QFR_GRANT_REVOKED`（见 §6）。

## §4 空值与缺省策略

- 安全相关字段必填且非空：`version`、`request_id`、`seq`、`device_id`、
  `account_id`、`api_key_id`、`binding_epoch`、`grant_epoch`、`nonce`、
  `issued_at`、`expires_at`、`idempotency_key`、`command`、`params`、
  `signature`。缺失、空值、类型错误一律拒绝；**不允许“字段缺失时
  按空串处理”的隐式规则**。
- 非授权提示字段保留显式缺省（v1/B1 冻结契约，非本次改动）：
  `batch_id` 缺省为空行（单条命令）、`job_id` 缺省为空行、
  `mode` 缺省为空行、`deadline_ms` 缺省为 `0`、`timeout_ms` 缺省为
  命令默认值。这些字段不是授权依据（`mode`／`deadline_ms` 不得放宽
  任何安全检查）；规范串层面它们仍占固定行位，不省略。
- `grant_epoch` 与 `binding_epoch` 不适用任何缺省。

## §5 编码、行尾与严格解析

- 编码固定 UTF-8；字段值禁止 CR、LF、NUL 及一切 `<0x20`／`0x7F`
  控制字符（身份字段与 token 字段的校验已拦）。
- 规范串行尾固定 LF、无结尾换行；任何 `\r` 出现即非法。
- 信封 JSON 解析（设备端 `lea_parse_envelope`）：
  - 顶层未知字段一律拒绝；顶层重复字段一律拒绝；对象闭合后尾部
    多余内容一律拒绝；
  - 整数字段用严格顶层解析：值切片全量消费，拒绝溢出、尾随字符、
    空串、非法字符，不用全文子串查找（`params` 内嵌套同名键不得
    遮蔽顶层值）；
  - 字符串字段只认顶层对象成员，按 JSON 转义解码（含 `\u` 代理对）。
- 验签流程：解析 → 用解析出的字段**重新构造规范串** → 对重建串验签；
  解析字段与验签字段必须一致（QFRLEA `handle_envelope` 已按此流程，
  不对收到的原文直接验签）。

## §6 错误码区分

| 情形 | 错误码 | 说明 |
|---|---|---|
| 版本不支持（`version != 2`，含 v1） | `QFR_LEA_BAD_ENVELOPE`（detail `version`） | 解析层拒绝 |
| 字段校验失败（缺失／类型错／越界／未知／重复字段） | `QFR_LEA_BAD_ENVELOPE`（detail 为字段名，如 `grant_epoch`） | 解析层拒绝 |
| 规范串非法（构造失败，如字段含控制字符、超界） | `QFR_LEA_BAD_ENVELOPE`（detail `canonical-build-failed`） | 验签前拒绝 |
| 签名失败 | `QFR_LEA_BAD_SIGNATURE`（公钥未配置时为 `QFR_LEA_SIG_NOT_CONFIGURED`） | 验签层拒绝 |
| 授权代次不匹配（设备端准入） | `QFR_GRANT_REVOKED` | 选用理由：与服务端 `admit()` 同一条件同一码（服务端 `grant_epoch` 不匹配时即报此码），两端错误契约一致；语义上 `grant_epoch` 不匹配的唯一成因就是授权被撤销后重授予，即“旧授权已撤销”，不是绑定变更（绑定变更用 `QFR_BINDING_CHANGED`）；该码已定义，无需新码 |

## §7 明确不出范围

- v2 只加 `grant_epoch`。吊销世代（revocation generation）的端到端
  携带／绑定是后续项，**本次不做**，不为此再改协议版本。
- 绑定票据仍为 v1（已含 `grant_epoch`），本次不动。

## §8 测试向量要求（跨语言）

JS（`server/ext/lea/test/test-lea.js` §7b/§7b-F02）与 C
（`windows/lea/test/test_lea.c`）共用 §2.1 定稿向量，逐字节相等。
另须覆盖：

- 边界整数：`grant_epoch` 为 0、1、`2^53-1`（合法）；`2^53`（JS 拒签、
  C 解析拒）；`2^63-1`（C 解析拒）；`seq` 为 4294967297（合法原值入串）。
- 最大长度／超长字段：身份字段超 127 字节拒；`params` 超上限拒。
- 空值：`grant_epoch` 缺失拒；`batch_id` 空串等同缺失（旧义保留）；
  `job_id`／`mode` 缺省为空行。
- 非法换行／CRLF：字段值含 `\n`／`\r` 拒签（JS）／拒解析（C）；
  规范串含 `\r` 即与定稿向量不等。
- Unicode：含 Unicode 的身份字段两端规范串逐字节一致（params 哈希
  按 UTF-8 字节算）。
- 前后空格：JSON 空白合法（`"grant_epoch": 1` 通过）；数值本身含空格
  （`"grant_epoch": "1"` 字符串型、`1.0`、`+1`、`01`）一律拒。
- 重复字段：顶层 `grant_epoch`／`version` 重复出现拒。
- 未知字段：顶层多余字段（如 `"evil":1`）拒；JS 侧 `envelopeSigningBytes`
  遇对象未知键亦拒。
- 旧版拒绝：完整 v1 信封（`version:1`、无 `grant_epoch`）解析拒；
  v2 信封缺 `grant_epoch` 解析拒；`grant_epoch` 与绑定不一致时
  `lea_admit` 报 `QFR_GRANT_REVOKED`，一致时通过。
