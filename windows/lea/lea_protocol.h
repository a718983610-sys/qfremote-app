/* QFRLEA 协议层（纯 C，无 Windows 依赖，可在 Linux 上单测）。
 *
 * 信封：一行 JSON，见 DESIGN.md §4.1。字段（v2，F-02）：
 *   version, request_id, batch_id, seq, device_id, account_id, api_key_id,
 *   binding_epoch, grant_epoch, nonce, issued_at, expires_at, idempotency_key,
 *   command, params, timeout_ms, signature
 *
 * v2-only：version 必须为 2，v1 信封直接拒绝，无回落、无版本协商
 * （见 windows/lea/CANONICAL-SIGNING-V2.md §5）。
 *
 * 本层只做：解析、形状校验、时间窗／重放窗判定、命令表（执行方／默认超时／
 * 是否危险／所需 scope）、路径规范化与白名单目录判定、错误码表。
 * 不做：签名密码学（见 lea_crypto.c）、持久化（见 lea_state.c）、管道／服务。
 */
#ifndef QFRLEA_PROTOCOL_H
#define QFRLEA_PROTOCOL_H

#include <stddef.h>
#include <string.h>

#ifdef __cplusplus
extern "C" {
#endif

#define LEA_PROTOCOL_VERSION 2
#define LEA_VERSION_STR "0.1.0-mvp"
#define LEA_MAX_ENVELOPE 65536
#define LEA_MAX_RESPONSE 65536
#define LEA_QUEUE_MAX 100
#define LEA_NONCE_TTL_SEC 600        /* nonce/request_id 去重保留 ≥10 分钟 */
#define LEA_IDEM_RETENTION_DAYS 7    /* 普通命令幂等保留 ≥7 天 */
#define LEA_IDEM_RETENTION_DANGEROUS_DAYS 30
#define LEA_BIND_CACHE_TTL_SEC 5     /* 绑定态缓存 TTL（DESIGN §6.2） */
#define LEA_MAX_CLOCK_SKEW_SEC 30    /* 允许时钟偏差 ±30s */
#define LEA_MAX_ENVELOPE_TTL_SEC 60  /* expires_at - issued_at ≤ 60s */
#define LEA_MAX_SCRIPT_OUTPUT 65536
#define LEA_MAX_FILE_SIZE 1048576
/* params 对象原文上限（#22）：与 USH 的 USH_MAX_PARAMS（32768）一致；
 * 旧值 8192 会把长参数命令静默改成无参执行（超长 params 须明确拒绝，
 * 见 lea_parse_envelope）。 */
#define LEA_MAX_PARAMS 32768
/* B1（2026-11-13，PLAN §2 B1）：输出上限 256KB——单条 job 的全部输出
 * （脚本 stdout/stderr 合计）超限即截断并终止该 job。响应行本身仍受
 * LEA_MAX_RESPONSE（64KB）约束，故 256KB 是 job 级上限、64KB 是行级上限。 */
#define LEA_MAX_JOB_OUTPUT_BYTES 262144
/* B1：执行队列准入上限 8 条（满则回 busy／QUEUE_FULL）。lea_state 的
 * 队列容量仍为 LEA_QUEUE_MAX（100，后备），B1 的 8 条是在 QFRLEA.c
 * 入队前做的准入判断（lea_queue_admit_ok），不得把 LEA_QUEUE_MAX 改
 * 成 8（单测锁死 100，改了即回归失败）。 */
#define LEA_B1_QUEUE_MAX 8
/* B1 命令分级时限（job 强杀 deadline 上限，毫秒）：
 *   L0 控制／健康 8000；L1 普通 8000；L2 长／危险 120000。
 * deadline = min(有效超时, 本级上限)；L2 下限不抬（信封超时 <30s 即
 * 按信封值杀，不延长）。 */
/* B1 命令分级（与 JS COMMANDS.tier 逐项一致）：0=控制／健康（sys.*），
 * 1=普通，2=长／危险（script.run、file.write）。tier 2 含义是“长／危险”，
 * 不是“异步”——mode（sync/async）只由命令定（仅 script.run 走 async）。 */
#define LEA_TIER_INLINE 0
#define LEA_TIER_NORMAL 1
#define LEA_TIER_LONG   2
#define LEA_B1_TIER0_DEADLINE_MAX_MS 8000
#define LEA_B1_TIER1_DEADLINE_MAX_MS 8000
#define LEA_B1_TIER2_DEADLINE_MAX_MS 120000

/* 错误码（DESIGN.md §4.5 为主；带 * 的为 MVP 补充码，见 README）。 */
#define LEA_OK "done"
#define LEA_ERR_BAD_ENVELOPE "QFR_LEA_BAD_ENVELOPE"             /* * 形状/字段错误 */
#define LEA_ERR_BAD_SIGNATURE "QFR_LEA_BAD_SIGNATURE"           /* * 签名格式错误 */
#define LEA_ERR_SIG_NOT_CONFIGURED "QFR_LEA_SIG_NOT_CONFIGURED" /* * 未接入真实公钥 */
#define LEA_ERR_REPLAY "QFR_REPLAY_DETECTED"
#define LEA_ERR_NOT_BOUND "QFR_LEA_NOT_BOUND"
#define LEA_ERR_BINDING_PENDING "QFR_LEA_BINDING_PENDING"       /* 唯一可重试 */
#define LEA_ERR_BINDING_CHANGED "QFR_BINDING_CHANGED"
#define LEA_ERR_NOT_AUTHORIZED "QFR_MUSE_NOT_AUTHORIZED"
#define LEA_ERR_KEY_REVOKED "QFR_API_KEY_REVOKED"
#define LEA_ERR_REVOCATION_UNAVAILABLE "QFR_LEA_REVOCATION_UNAVAILABLE" /* F-01：吊销表不可用（读失败／格式错／陈旧／缺失有历史），不可重试 */
#define LEA_ERR_SCOPE_DENIED "QFR_SCOPE_DENIED"
#define LEA_ERR_DEVICE_NOT_WHITELISTED "QFR_DEVICE_NOT_WHITELISTED"
#define LEA_ERR_GRANT_REVOKED "QFR_GRANT_REVOKED"
#define LEA_ERR_DUPLICATE "QFR_LEA_DUPLICATE_IN_PROGRESS"
#define LEA_ERR_UNKNOWN "QFR_LEA_EXECUTION_UNKNOWN"
#define LEA_ERR_IDEMPOTENT_MISMATCH "QFR_LEA_IDEMPOTENT_MISMATCH" /* FIX1：同幂等键不同请求内容，拒绝回放旧结果（不可重试——须换新键） */
#define LEA_ERR_QUEUE_FULL "QFR_QUEUE_FULL"
#define LEA_ERR_CALLER_NOT_ALLOWED "QFR_LEA_CALLER_NOT_ALLOWED" /* * 内部命令调用方不是已安装的 qf-lea-client.exe（H01） */
#define LEA_ERR_USH_UNAVAILABLE "QFR_LEA_USH_UNAVAILABLE"      /* * USH 未运行/连不上 */
#define LEA_ERR_SCRIPT_NOT_ALLOWED "QFR_LEA_SCRIPT_NOT_ALLOWED" /* * 白名单外脚本 */
#define LEA_ERR_PATH_NOT_ALLOWED "QFR_LEA_PATH_NOT_ALLOWED"     /* * 目录越界 */
#define LEA_ERR_TIMEOUT "QFR_LEA_TIMEOUT"                       /* * 执行超时 */
#define LEA_ERR_RESET "QFR_LEA_RESET"                         /* B1：执行器被 sys.reset／看门狗清队列重置（可重试，未执行） */
#define LEA_ERR_EXPIRED "QFR_LEA_EXPIRED"                       /* * 入队后执行前已过期（H10） */
#define LEA_ERR_NOT_INSTALLED "QFR_LEA_NOT_INSTALLED"
#define LEA_ERR_EXEC_FAILED "QFR_LEA_EXEC_FAILED"               /* * 执行失败通用码 */
#define LEA_ERR_INTERNAL "QFR_LEA_INTERNAL"                     /* * 服务内部错误 */
#define LEA_ERR_HANDSHAKE_REQUIRED "QFR_LEA_HANDSHAKE_REQUIRED" /* RC-01：握手未完成，业务命令拒绝投递（不可重试——服务端重握后重试） */
#define LEA_ERR_CANCELLED "QFR_LEA_CANCELLED" /* S-022：job 被 job.cancel 取消（排队未执行；终态，不可重试） */
#define LEA_ERR_NOT_CANCELLABLE "QFR_LEA_NOT_CANCELLABLE" /* S-022：命令不可取消（危险命令／已在执行） */
#define LEA_ERR_NOT_FOUND "QFR_LEA_NOT_FOUND" /* S-022：job.query／job.cancel 查无此 job */
#define LEA_ERR_PAUSED "QFR_LEA_PAUSED" /* S-021：本机已暂停（lea.pause），业务命令一律拒绝，直至 lea.resume */
#define LEA_ERR_EMERGENCY_STOPPED "QFR_LEA_EMERGENCY_STOPPED" /* emergency_stop：本机已紧急停控，业务命令一律拒绝，直至专用恢复票据清除（不可重试——须走恢复流程，不得盲目重发） */
#define LEA_ERR_LOGIN_PROOF "QFR_LEA_LOGIN_PROOF" /* v3 P0-4：session.login_changed 的登录证明缺失／无效／过期／错配／重放／不可验（fail-closed，不可重试——须重新登录取新证明） */

typedef enum {
    LEA_EXEC_LEA = 0,  /* LEA 服务本机执行 */
    LEA_EXEC_USH = 1,  /* 转 USH 执行 */
    LEA_EXEC_INLINE = 2 /* 管道线程内联处理，不进队列 */
} lea_executor_t;

typedef struct {
    const char *name;
    lea_executor_t executor;
    long default_timeout_ms;
    long max_timeout_ms;
    int dangerous;              /* 1=危险命令：单独串行 lane，禁自动重试 */
    const char *required_scope; /* NULL=只需 muse.execute；否则另需该 scope */
    int tier;                   /* B1 命令分级：0=控制／健康，1=普通，2=长／危险 */
} lea_command_spec_t;

/* 命令表见 DESIGN.md §4.4。危险命令初始定义（待站长确认完整清单，
 * DESIGN §14 #4）：script.run、file.write，以及 params.dangerous=true
 * 的 ui.click / ui.input。
 * RC-01：sys.handshake 在表内（tier 0 内联），使 lea_admit 能对其做同款
 * 准入；握手门本身在 QFRLEA.c handle_envelope（验签后、业务命令前）。 */
const lea_command_spec_t *lea_command_spec(const char *name);

/* RC-01 握手态（纯数据，调用方持有；QFRLEA.c 持一份静态实例）。
 * 完成态须 (指纹, binding_epoch, grant_epoch) 与当前一致，任一变化即失效。
 * 服务端先发 sys.handshake（params 带服务端公钥指纹＋协议版本 2），设备
 * 验签＋核对指纹/版本＋同款准入后才标记完成；未完成时任何业务命令
 * （sys.ping 健康探针除外——只读、无执行，B1 自愈探测须能过）一律回
 * QFR_LEA_HANDSHAKE_REQUIRED，不入队、不执行。--internal 本地控制命令
 * 不走此门（本地 SYSTEM 起源、按进程身份鉴权）。 */
typedef struct {
    int completed;
    char fp[17]; /* 服务端公钥指纹（16 位 hex＋\0） */
    long long binding_epoch;
    long long grant_epoch;
} lea_handshake_state_t;

void lea_handshake_init(lea_handshake_state_t *s);
int lea_handshake_is_complete(const lea_handshake_state_t *s, const char *fp,
                              long long binding_epoch, long long grant_epoch);
void lea_handshake_mark_complete(lea_handshake_state_t *s, const char *fp,
                                 long long binding_epoch, long long grant_epoch);
void lea_handshake_invalidate(lea_handshake_state_t *s);
/* 握手 params 校验：指纹须等于本机编译期公钥指纹且 protocol_version 须为 2。
 * fp 为本机指纹（lea_server_pubkey_fingerprint 的输出）；无公钥（fp 为空）
 * 即拒绝。params_fp 为信封 params.server_pubkey_fp 的值。 */
int lea_handshake_check_params(const char *fp, const char *params_fp, long long protocol_version);

typedef struct {
    int valid;
    int version;
    char request_id[64];
    char batch_id[64];
    long long seq;
    char device_id[128];
    char account_id[128];
    char api_key_id[64];
    long long binding_epoch;
    /* F-02：授权代次（grant_epoch）。信封必填字段：解析时必须存在且
     * 为无符号整数（0..2^53-1，最短十进制、无前导零），不得缺省为 0；
     * lea_admit() 校验 env.grant_epoch == bind->grant_epoch。 */
    long long grant_epoch;
    char nonce[128];
    long long issued_at;
    long long expires_at;
    char idempotency_key[128];
    char command[32];
    char params_raw[LEA_MAX_PARAMS]; /* params 对象原文（用于 params_hash 与参数提取） */
    long long timeout_ms;  /* 0=用命令默认超时 */
    int has_timeout;
    /* B1 信封新字段（PLAN §2 B1；全部可选，老版本忽略）：
     *   job_id：服务端 job 标识（缺失时等同 request_id）；
     *   mode： "sync"（同步短 lane）／"async"（隔离异步 job）；
     *   deadline_ms：调用方期望的 job 强杀时限（毫秒），仅作调度提示，
     *     不得放宽分级上限（lea_job_deadline_ms 取 min 后再夹 tier 上限）。
     * F-02（v2）：job_id／mode／deadline_ms 已进 v2 规范串（20 行），
     * 与 grant_epoch 一起签名；缺省值与解析缺省一致（job_id 缺省 ''、
     * mode 缺省 ''、deadline_ms 缺省 0），签信封原文值。nonce 字段
     * v1 已有，不新增。 */
    char job_id[64];
    char mode[16];
    long long deadline_ms;
    int has_deadline;
    char signature[512];
    char trace_id[64]; /* 可选 */
    char error[64];    /* valid=0 时的错误码 */
    char error_detail[256];
} lea_envelope_t;

int lea_command_is_dangerous(const lea_envelope_t *env);

/* S-022：按命令的可取消性——排队未执行的命令能否被 job.cancel 取消。
 * 内联命令（不进队列）与危险命令（表内危险，或 ui.* 带 params.dangerous=true）
 * 不可取消：危险命令一旦受理必须跑到终态，否则副作用是否发生无法交代；
 * 其余进队列的命令（ui.*／file.read／app.*／sys.*）可取消。
 * 未知命令返回 0（fail-closed）。注意：已在执行的 job 亦不可取消
 * （无中途强杀开关；取消只对排队项生效，运行中 job 只记 CANCEL_REQUESTED）。 */
int lea_command_is_cancellable(const lea_envelope_t *env);

/* B1 命令分级：返回命令的 tier（0/1/2），未知命令返回 -1。 */
int lea_command_tier(const char *name);
/* B1 job 强杀 deadline（毫秒）= min(有效超时, 本级上限)；未知命令 5000。 */
long lea_job_deadline_ms(const lea_envelope_t *env);
/* B1 队列准入：当前深度 < LEA_B1_QUEUE_MAX（8）才放行；满即回 busy。 */
static inline int lea_queue_admit_ok(int depth) {
    return depth < LEA_B1_QUEUE_MAX;
}
/* B1：params 内指定布尔键为 true 时返回 1（file.read recursive 拒绝用）。
 * 键缺失／非布尔／false 返回 0。 */
int lea_params_has_true(const char *params_raw, const char *key);

/* 解析一行 JSON 信封。只做形状校验，不验签名／绑定／幂等。
 * v2-only：version != 2 即拒绝；grant_epoch 必须存在且为无符号整数
 * （0..2^53-1，最短十进制、无前导零、无符号位），不得缺省为 0；
 * 顶层未知字段／重复字段一律拒绝（与 JS envelopeSigningBytes
 * 未知字段拒绝同规则）；整数字段用严格顶层解析（全量消费、溢出拒）。
 * now_unix: 调用方传入当前 unix 秒（便于单测注入时钟）。 */
int lea_parse_envelope(const char *text, long long now_unix, lea_envelope_t *out);

/* 时间窗判定：expires_at-issued_at ∈ (0,60]；issued_at 超前 now ≤30s；
 * now 超过 expires_at 容 +30s。接收窗 = TTL 60s（#20：旧实现另卡
 * now-issued ≤ +30s，误把接收窗压成 30s，与 DESIGN §4.1 不符）。 */
int lea_check_time_window(const lea_envelope_t *env, long long now_unix,
                          char *err, size_t err_size);

/* 超时：envelope.timeout_ms 优先，夹在 [1, 命令 max_timeout_ms]；0 用默认值。 */
long lea_effective_timeout_ms(const lea_envelope_t *env);

/* JSON 取值助手（平铺字段；params 内字段用 lea_params_*）。 */
int lea_json_string(const char *text, const char *key, char *out, size_t out_size);
int lea_json_long(const char *text, const char *key, long long *out);
/* 只认顶层对象成员的裸整数值（#1 世代字段 generation 用）：严格顶层
 * 解析（重复键／嵌套／尾部垃圾即非法）；值须整体为可选负号＋十进制
 * 数字，禁引号／小数／溢出钳制。返回 1=成功、0=成员缺失、-1=成员存在
 * 但非法；调用方须区分缺失与非法。 */
int lea_json_top_level_long(const char *text, const char *key, long long *out);
int lea_json_bool(const char *text, const char *key, int *out);
/* USH 响应 ok 判定（execute_item USH 分支用）：严格顶层解析，只认顶层
 * 对象中唯一一个布尔 "ok"（*out_ok=true/false）；缺失／非布尔／未闭合／
 * 重复键／嵌套 ok／尾部垃圾一律返回 0，调用方须判失败——ok 不得沿用初值 1。 */
int lea_ush_response_ok(const char *resp, int *out_ok);
/* 只认顶层对象成员的字符串值（H08）：全文查找会命中 params 内嵌套的
 * 同名键（如 params {"cmd":...}），导致信封被误判进内部命令处理、绕过
 * 信封验签。顶层须为单个 JSON 对象且成员恰好出现一次；值须为 JSON
 * 字符串（按 JSON 转义解码）。 */
int lea_json_top_level_string(const char *text, const char *key, char *out, size_t out_size);
/* 只认顶层对象成员的字符串数组值（#17 keys.sync-revoked 用）：成员须恰好
 * 出现一次、值为 JSON 数组、元素全为字符串（按 JSON 转义解码）。
 * 返回元素个数（0=空数组），-1=缺失／类型错／重复键／元素溢出。 */
int lea_json_top_level_string_array(const char *text, const char *key,
                                    char out[][128], int max_items);
/* 严格 JSON 值校验（H09：幂等快照写盘前校验行合法性）。 */
int lea_json_is_valid(const char *text);
int lea_json_object_raw(const char *text, const char *key, char *out, size_t out_size);
/* params_raw 内的字符串数组：args[0..n)，返回个数，-1=不是数组/溢出。 */
int lea_params_string_array(const char *params_raw, const char *key,
                            char out[][512], int max_items);

/* 路径规范化：统一 \ 与 /，折叠 . 与 ..；.. 越界返回 0。
 * out 为规范化后的路径（保留原分隔符风格：含 \ 则用 \，否则 /）。
 * 仅做词法规范化，不碰文件系统。 */
int lea_normalize_path(const char *path, char *out, size_t out_size);
/* 规范化后判定 path 是否位于 root 之下（含等于 root 本身时返回 0，
 * 文件必须严格在 root 内）。大小写不敏感（Windows 语义）。 */
int lea_path_under_root(const char *norm_path, const char *norm_root);

/* idempotency_key / request_id / nonce 字符集：[A-Za-z0-9_-]，长度 8..128。 */
int lea_validate_token(const char *s);

/* 规范串 v2 身份字段规则（见 CANONICAL-SIGNING-V2.md §1）：
 * 非空、长度 1..127 字节，不得含 <0x20、0x7F 控制字符（含 \n \r）。
 * 允许 '"'、'\\'、空格等可打印字符（JSON 重建时转义，见 lea_rebuild_envelope）。
 * device_id / account_id / api_key_id / batch_id（非空时）/ lease_id（非空时）均用此规则。 */
int lea_validate_id_field(const char *s);

/* 规范 scopes 字符串格式（CANONICAL-SIGNING-V1.md §3.1）：
 * 空串表示无 scope；否则为逗号连接的 token（字符集 [A-Za-z0-9_.-]），
 * 严格字典序升序、无空格、无空 token、无重复。 */
int lea_validate_scopes_str(const char *s);

/* 信封规范串 v2（CANONICAL-SIGNING-V2.md §2）：20 行 \n 连接串，
 * 域名行 qfr-lea-envelope-v2，params 只含 stable JSON 的 SHA-256 hex，
 * timeout_ms 取有效超时（线上值或命令默认值）。grant_epoch 在
 * binding_epoch 之后一行，须为 0..2^53-1 的无符号整数（JS 安全整数界，
 * 超界／负数即构造失败）。字段非法或空间不足返回 0。 */
int lea_envelope_canonical(const lea_envelope_t *env, char *out, size_t out_size);

/* 票据规范串 v1（CANONICAL-SIGNING-V1.md §3）：9 行 \n 连接串，
 * 域名行 qfr-lea-ticket-v1，覆盖全部授权字段（grant／scopes／lease_id）。
 * scopes 须已是规范字符串（见 lea_validate_scopes_str）；lease_id 为 NULL
 * 或空串时对应行为空行；grant_muse_execute 严格 0/1，非法返回 0。
 * grant 取 long long：调用点不得 (int) 窄化（Windows 下 4294967297
 * 会被截成 1 而签名仍通过）。 */
int lea_ticket_canonical(const char *account_id, const char *device_id,
                         long long binding_epoch, long long grant_epoch,
                         long long grant_muse_execute, const char *scopes,
                         const char *lease_id, long long expires_at,
                         char *out, size_t out_size);

/* 吊销快照规范串（A7-whitelist，GPT 问题 2：验证服务端授权来源）。
 * 4 行 \n 连接串，域名行由 version_tag 给出：
 *   qfr-lea-revoked-sync-v1（keys.sync-revoked，经 rebind 回包转发）
 *   qfr-lea-key-revoked-v1（lea.key_revoked，经 MeshCentral 通道下发）
 * 第 2 行 device_id 须合 id 规则（lea_validate_id_field：非空、≤127、
 * 无控制字符——含 \n 在内，故字段间不可能移位）；第 3 行 generation
 * 为 ≥0 的整数（%lld 输出，无前导零变体）；第 4 行是列表哈希：
 * key_ids 以 '\n' 连接的 SHA-256 hex。
 * key_ids 须已是规范形：每项合 token 规则（lea_validate_token，
 * 8..128 字节 [A-Za-z0-9_-]，不含分隔符），且严格升序（有序＋无重复），
 * 否则返回 0——签名只覆盖规范形集合，非规范列表不得入串、不得应用
 * （服务端签发前同样排序去重；重复项／乱序到达即验签失败）。
 * 空集合法（哈希为 sha256("")），语义是并集合并下的无操作＋世代推进，
 * 永不缩表。n_key_ids 上限 512（与 LEA_REVOKED_MAX_IDS 同值）。
 * 服务端同款实现见 server/ext/lea/lea-core.js revokedSnapshotSigningBytes。
 * 验签由调用点用 lea_verify_ticket_signature（同一把 Ed25519 公钥，
 * 与票据／信封同一信任根；域名行不同故跨协议签名不可互用）。 */
int lea_revoked_snapshot_canonical(const char *version_tag, const char *device_id,
                                   long long generation, const char *const *key_ids,
                                   int n_key_ids, char *out, size_t out_size);

/* 绑定票据原文（binding.confirm 的 ticket JSON）。scopes 缓冲 257 字节：
 * v1 定整串上限 256 UTF-8 字节（与 JS ticketSigningBytes 同界），超限即
 * 解析失败；grant_muse_execute 存解析原值（可为 2／-1 等非法值，入串时
 * 由 lea_ticket_canonical() 拒绝，调用点不得 truthy 归一化）。 */
typedef struct {
    char account_id[128];
    char device_id[128];
    long long binding_epoch;
    long long grant_epoch;
    long long grant_muse_execute;
    char scopes[257];
    char lease_id[128];
    long long expires_at;
    char signature[512];
} lea_ticket_t;

/* 严格解析绑定票据（binding.confirm 用；QFRLEA.c 只保留调用点）。
 * 基于完整 JSON 对象成员遍历（非子串查找）：跳过全部 JSON 空白，
 * 重复键即拒绝；字符串值按 JSON 转义解码（含 \u 代理对）。
 * 全部字段按类型校验，失败返回 0：account_id／device_id 须为字符串且合
 * id 规则；binding_epoch／grant_epoch／expires_at 须为整数，不得缺失；
 * grant_muse_execute 须为整数（原值保留，long long）或布尔，缺失即拒绝；
 * scopes 字段存在时须为字符串且合 §3.1 格式（数组／对象即拒绝，不得当
 * 空串处理），缺失时按空串；lease_id 存在时须为字符串，非空时合 id 规则；
 * ticket_signature 须为非空字符串。 */
int lea_parse_ticket(const char *text, lea_ticket_t *out);

/* ---------- 登录证明（login proof，v3 P0-4／B3） ---------- */
/* 证明 login_changed 声称的账号确系服务端认证的真实登录事件，而非请求体
 * 自报。服务端在用户控制台登录后签发（POST /api/lea/v1/login-attestation，
 * 会话推导账号），客户端随 login_changed 原样带回，本地服务以编译期烘焙
 * 的服务端 Ed25519 公钥验签（与票据同一把钥匙、同一 verify_real）。
 * 规范串：qfr-lea-login-v1\n<key_id>\n<account_id>\n<device_id>\n
 * <issued_at>\n<expires_at>（LF 连接、无结尾换行；key_id 为服务端公钥
 * 指纹前 16 位 hex，见 lea_server_pubkey_fingerprint，与 JS
 * signingPublicKeyFingerprint 逐字节一致；account/device 须合 id 规则，
 * 含 \n \r 控制字符即拒绝，规范串无字段边界歧义）。
 * 时效：服务端签发 TTL 120 秒；本地验收上限 expires-issued ≤ 300 秒，
 * 时钟偏差容忍 ±60 秒（对称检查）。重放由调用方另行以已消费集合拦截
 * （见 QFRLEA.c），此处不做。 */
#define LEA_LOGIN_PROOF_VERSION "qfr-lea-login-v1"
#define LEA_LOGIN_PROOF_TTL_MAX_SEC 300
#define LEA_LOGIN_PROOF_SKEW_SEC 60

typedef struct {
    char version[32];
    char key_id[17];
    char account_id[128];
    char device_id[128];
    long long issued_at;
    long long expires_at;
    char signature[512];
} lea_login_proof_t;

/* 构造登录证明规范串。key_id 须恰好 16 位小写 hex；account/device 须合
 * id 规则；issued/expires 须为正数且 expires > issued。失败返回 0。 */
int lea_login_proof_canonical(const char *key_id, const char *account_id,
                              const char *device_id, long long issued_at,
                              long long expires_at, char *out, size_t out_size);

/* 严格解析登录证明 JSON（与 lea_parse_ticket 同口径：完整顶层对象遍历，
 * 重复键即拒绝，字符串按 JSON 转义解码）。全部字段必填且按类型校验：
 * version／key_id／account_id／device_id／signature 须为非空字符串；
 * issued_at／expires_at 须为整数。失败返回 0。 */
int lea_parse_login_proof(const char *text, lea_login_proof_t *out);

/* 验登录证明。proof_json 为 login_proof 字段的字符串内容（证明 JSON 原文）；
 * account_id／device_id 为 login_changed 信封声称的账号／设备，须与证明内
 * 一致（只比请求体不够——签名绑定证明内字段，错配即拒绝）；now_unix 为
 * 当前 unix 秒。reason 写入失败原因：login-proof-missing（字段缺失／解析
 * 失败）／login-proof-invalid（版本／key_id／字段非法）／login-proof-expired
 * （过期或时效超限）／login-proof-mismatch（账号／设备／key_id 与声称或
 * 本机公钥指纹不一致）／login-proof-bad-signature／login-proof-unverifiable
 * （未烘焙公钥，见 ed25519-pubkey-not-configured）。成功返回 1。 */
int lea_verify_login_proof(const char *proof_json, const char *account_id,
                           const char *device_id, long long now_unix,
                           char *reason, size_t reason_size);

/* emergency_stop 专用恢复票据原文（GPT 2026-11-18 裁决问题 3）。
 * type 固定 "emergency_stop_recovery"，禁止与普通绑定票据混用；
 * 普通 binding.confirm 即使签名有效也不能清除 emergency_stop。
 * auth_context 是服务端强认证结果（由服务端产生并签名覆盖，设备端
 * 只验存在＋签名覆盖，不解释其内容；本地审计只存其哈希）。
 * scope 为恢复的控制权限范围（如 "device-control"）；ticket_id 一次性，
 * recovery_epoch 为恢复操作的独立单调代次。 */
#define LEA_RECOVERY_TICKET_TYPE "emergency_stop_recovery"
typedef struct {
    char type[64];
    char account_id[128];
    char device_id[128];
    char stop_event_id[128];
    long long binding_epoch;
    long long grant_epoch;
    long long recovery_epoch;
    char scope[128];
    char ticket_id[128];
    long long issued_at;
    long long expires_at;
    char auth_context[256];
    char signature[512];
} lea_recovery_ticket_t;

/* 恢复票据规范串 v1：12 行 \n 连接串，域名行
 * qfr-lea-recovery-ticket-v1，覆盖全部字段（type 在首行之后）。
 * 字段非法或空间不足返回 0。服务端 lea-core.js 的
 * recoveryTicketSigningBytes 须逐行一致。 */
int lea_recovery_ticket_canonical(const lea_recovery_ticket_t *t,
                                  char *out, size_t out_size);

/* 严格解析恢复票据（与 lea_parse_ticket 同款严格 JSON 成员遍历）。
 * 全部字段按类型校验，失败返回 0：type 须为 "emergency_stop_recovery"；
 * account_id／device_id／stop_event_id／ticket_id 须为字符串且合 id 规则；
 * binding_epoch／grant_epoch／recovery_epoch／issued_at／expires_at 须为
 * 整数，不得缺失；scope／auth_context 须为字符串（可为空串，但字段须
 * 存在——服务端签发时必带）；signature 须为非空字符串。 */
int lea_parse_recovery_ticket(const char *text, lea_recovery_ticket_t *out);

/* 同步回执规范串：服务端 emergencyStopSync 签发回执时用同一格式；
 * LEA 收到 lea.emergency-stop-sync 后凭此串验签。头部固定
 * qfr-lea-emergency-stop-sync-v1，之后 4 行：stop_event_id、
 * account_id、device_id、synced_at（unix 秒，十进制）。 */
int lea_emergency_stop_sync_canonical(const char *stop_event_id, const char *account_id,
                                      const char *device_id, long long synced_at,
                                      char *out, size_t out_size);

/* 重建信封行（供 LEA→USH 转发；签名等字段原样带回，USH 只信 LEA 不再验签）。
 * pkg1 #25：全部字符串字段经 JSON 转义后拼接，%s 直拼禁止；
 * params_raw 原文 verbatim 拼接（签名覆盖同一份字节）。
 * F-02：重建行含 version（2）与 grant_epoch，缺一不可。空间不足返回 0。 */
int lea_rebuild_envelope(const lea_envelope_t *env, char *out, size_t out_size);

/* JSON 转义后追加到 buf（不含外层引号），返回 0=空间不足。 */
int lea_json_escape_into(char *buf, size_t buf_size, size_t *off, const char *s);

/* 在一行 JSON 对象末尾插入一个字符串字段（H03：LEA→USH 转发时插入
 * ush_token）。在最后一个 '}' 前插入 ,"key":"<转义后 value>"；原串须为
 * 以 '}' 结尾的单行 JSON 对象，空间不足或形状不对返回 0，原串不动。 */
int lea_json_insert_string_field(const char *line, const char *key, const char *value,
                                 char *out, size_t out_size);

/* H07 契约：session.login_changed 的 result 字段格式（见 lea_protocol.c）。
 * main.js 钩子从 result.binding_epoch 取 epoch 去调 rebind；格式一旦
 * 变了钩子就空转，故抽成可单测的纯函数并锁死。 */
int lea_binding_login_result(long long epoch, char *out, size_t out_size);

/* 构造一行 JSON 响应：{"ok":bool,"code":"...","request_id":"...",
 * "retryable":bool,"detail":"...","result":{...}|"result":null}。
 * result_json 为已构造好的 JSON 片段（可为 NULL）。 */
int lea_build_response(char *out, size_t out_size, int ok, const char *code,
                       const char *request_id, int retryable,
                       const char *detail, const char *result_json);

/* 仅 BINDING_PENDING 与 B1 RESET 可重试（DESIGN §4.5；RESET 表示命令
 * 未执行即被清队列，重试安全）。 */
static inline int lea_error_retryable(const char *code) {
    return code && (strcmp(code, LEA_ERR_BINDING_PENDING) == 0 ||
                    strcmp(code, LEA_ERR_RESET) == 0);
}

#ifdef __cplusplus
}
#endif

#endif
