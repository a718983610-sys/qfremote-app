/* QFRLEA 审计日志层（纯 C，可在 Linux 上单测；文件滚动用 dirent 实现，
 * mingw 与 POSIX 均可用）。
 *
 * 日志位置（Windows 服务）：%ProgramData%\QFR\LEA\logs\lea-YYYY-MM-DD.jsonl
 * 按天滚动，保留 30 天；目录与文件 ACL 仅 SYSTEM／Administrators（服务层设置）。
 *
 * 字段（DESIGN §11.1）：trace_id/request_id/batch_id/seq/account_id/
 * device_id/api_key_id/binding_epoch/command/params_hash/idempotency_key/
 * nonce/result/error_code/duration_ms/ush_session_id/process_id/retry_count。
 * API Key 只记 key_id 与前缀片段（调用方先用 lea_redact_key_prefix 脱敏），
 * 绝不记明文；params 只记 SHA-256（params_hash），不记原文。
 */
#ifndef QFRLEA_AUDIT_H
#define QFRLEA_AUDIT_H

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

#define LEA_AUDIT_RETAIN_DAYS 30

typedef struct {
    const char *event;         /* "execute" / "admit-reject" / "binding" / "queue" ... */
    const char *trace_id;
    const char *request_id;
    const char *batch_id;
    long long seq;
    const char *account_id;
    const char *device_id;
    const char *api_key_id;    /* 只记 key_id */
    const char *key_prefix_redacted; /* 脱敏后的前缀，如 qfr_lea_xxxxxxxx...yyyy */
    long long binding_epoch;
    const char *command;
    const char *params_hash;   /* SHA-256 hex */
    const char *idempotency_key;
    const char *nonce;
    const char *result;        /* "ok"/"rejected"/"failed"/"timeout"/... */
    const char *error_code;    /* 为空表示无错误 */
    long duration_ms;
    const char *ush_session_id;
    long process_id;
    int retry_count;
    const char *detail;        /* 补充说明（须已脱敏） */
} lea_audit_event_t;

/* 构造一行 JSONL（不含换行符，调用方加 \n）。返回 1=成功。 */
int lea_audit_format_line(const lea_audit_event_t *ev, const char *iso_ts,
                          char *out, size_t out_size);

/* 追加一行到 <dir>/lea-YYYY-MM-DD.jsonl（dir 须已存在）。date_ymd 为
 * "YYYY-MM-DD"，iso_ts 为 "YYYY-MM-DDTHH:MM:SS+08:00" 形。 */
int lea_audit_append(const char *dir, const char *date_ymd,
                     const lea_audit_event_t *ev, const char *iso_ts);

/* 删除 dir 下早于 retain_days 的 lea-YYYY-MM-DD.jsonl；返回删除数，-1=目录打不开。 */
int lea_audit_prune(const char *dir, int retain_days, const char *today_ymd);

#ifdef __cplusplus
}
#endif

#endif
