/* ush_log.h — USH 结构化日志（Windows）。
 * 落盘：%ProgramData%\QFR\LEA\logs\ush-YYYY-MM-DD.jsonl（按天滚动）。
 * 字段参照 DESIGN.md §11.1。绝不记敏感明文：params 只记 SHA-256 哈希，
 * 输入文本、API Key 明文永不入日志（USH 本来也收不到 Key 明文）。
 */
#ifndef QFR_USH_LOG_H
#define QFR_USH_LOG_H

#include "ush_json.h"

/* 启动/停止时调用（写一行事件日志）。 */
void ush_log_init(void);
void ush_log_event(const char *event, const char *detail);

/* 记一条命令审计日志。result: "ok"/"error"；window_title 可为 NULL。 */
void ush_log_command(const ush_request_t *req, const char *result,
                     const char *error_code, long duration_ms,
                     const char *window_title, int retry_count);

/* params 原文的 SHA-256 hex（小写，64 字符＋'\0'）；失败时填空串。 */
int ush_sha256_hex(const char *text, char out_hex[65]);

#endif /* QFR_USH_LOG_H */
