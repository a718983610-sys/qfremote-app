/* QFRLEA 协议层（纯 C，无 Windows 依赖，可在 Linux 上单测）。
 *
 * 信封：一行 JSON，见 DESIGN.md §4.1。字段：
 *   version, request_id, batch_id, seq, device_id, account_id, api_key_id,
 *   binding_epoch, nonce, issued_at, expires_at, idempotency_key,
 *   command, params, timeout_ms, signature
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

#define LEA_PROTOCOL_VERSION 1
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
#define LEA_ERR_SCOPE_DENIED "QFR_SCOPE_DENIED"
#define LEA_ERR_DEVICE_NOT_WHITELISTED "QFR_DEVICE_NOT_WHITELISTED"
#define LEA_ERR_GRANT_REVOKED "QFR_GRANT_REVOKED"
#define LEA_ERR_DUPLICATE "QFR_LEA_DUPLICATE_IN_PROGRESS"
#define LEA_ERR_UNKNOWN "QFR_LEA_EXECUTION_UNKNOWN"
#define LEA_ERR_QUEUE_FULL "QFR_QUEUE_FULL"
#define LEA_ERR_USH_UNAVAILABLE "QFR_LEA_USH_UNAVAILABLE"      /* * USH 未运行/连不上 */
#define LEA_ERR_SCRIPT_NOT_ALLOWED "QFR_LEA_SCRIPT_NOT_ALLOWED" /* * 白名单外脚本 */
#define LEA_ERR_PATH_NOT_ALLOWED "QFR_LEA_PATH_NOT_ALLOWED"     /* * 目录越界 */
#define LEA_ERR_TIMEOUT "QFR_LEA_TIMEOUT"                       /* * 执行超时 */
#define LEA_ERR_NOT_INSTALLED "QFR_LEA_NOT_INSTALLED"
#define LEA_ERR_EXEC_FAILED "QFR_LEA_EXEC_FAILED"               /* * 执行失败通用码 */
#define LEA_ERR_INTERNAL "QFR_LEA_INTERNAL"                     /* * 服务内部错误 */

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
} lea_command_spec_t;

/* 命令表见 DESIGN.md §4.4。危险命令初始定义（待站长确认完整清单，
 * DESIGN §14 #4）：script.run、file.write，以及 params.dangerous=true
 * 的 ui.click / ui.input。 */
const lea_command_spec_t *lea_command_spec(const char *name);

typedef struct {
    int valid;
    int version;
    char request_id[64];
    char batch_id[64];
    long seq;
    char device_id[128];
    char account_id[128];
    char api_key_id[64];
    long long binding_epoch;
    char nonce[128];
    long long issued_at;
    long long expires_at;
    char idempotency_key[128];
    char command[32];
    char params_raw[8192]; /* params 对象原文（用于 params_hash 与参数提取） */
    long long timeout_ms;  /* 0=用命令默认超时 */
    int has_timeout;
    char signature[512];
    char trace_id[64]; /* 可选 */
    char error[64];    /* valid=0 时的错误码 */
    char error_detail[256];
} lea_envelope_t;

int lea_command_is_dangerous(const lea_envelope_t *env);

/* 解析一行 JSON 信封。只做形状校验，不验签名／绑定／幂等。
 * now_unix: 调用方传入当前 unix 秒（便于单测注入时钟）。 */
int lea_parse_envelope(const char *text, long long now_unix, lea_envelope_t *out);

/* 时间窗判定：expires_at-issued_at ∈ (0,60] 且 issued_at 距 now ≤30s 偏差。 */
int lea_check_time_window(const lea_envelope_t *env, long long now_unix,
                          char *err, size_t err_size);

/* 超时：envelope.timeout_ms 优先，夹在 [1, 命令 max_timeout_ms]；0 用默认值。 */
long lea_effective_timeout_ms(const lea_envelope_t *env);

/* JSON 取值助手（平铺字段；params 内字段用 lea_params_*）。 */
int lea_json_string(const char *text, const char *key, char *out, size_t out_size);
int lea_json_long(const char *text, const char *key, long long *out);
int lea_json_bool(const char *text, const char *key, int *out);
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

/* JSON 转义后追加到 buf（不含外层引号），返回 0=空间不足。 */
int lea_json_escape_into(char *buf, size_t buf_size, size_t *off, const char *s);

/* 构造一行 JSON 响应：{"ok":bool,"code":"...","request_id":"...",
 * "retryable":bool,"detail":"...","result":{...}|"result":null}。
 * result_json 为已构造好的 JSON 片段（可为 NULL）。 */
int lea_build_response(char *out, size_t out_size, int ok, const char *code,
                       const char *request_id, int retryable,
                       const char *detail, const char *result_json);

/* 仅 BINDING_PENDING 可重试（DESIGN §4.5）。 */
static inline int lea_error_retryable(const char *code) {
    return code && strcmp(code, LEA_ERR_BINDING_PENDING) == 0;
}

#ifdef __cplusplus
}
#endif

#endif
