/* 见 lea_audit.h */
#include "lea_audit.h"
#include "lea_protocol.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdarg.h>
#include <dirent.h>

/* #18：安全追加——snprintf/vsnprintf 返回的是“所需长度”（可能 ≥ 剩余
 * 空间），直接累加会让 *off 越过 out_size，后续 out_size - *off 下溢为
 * 巨大值，再写即越界写（DS 由高调低：当前字段有上限、不可达，字段上限
 * 放宽即变真漏洞）。本函数：off 已到顶／写不下／出错一律返回 0，
 * 调用方见 0 即整行失败（绝不发半行），*off 恒 < out_size。 */
static int append_fmt(char *out, size_t out_size, size_t *off, const char *fmt, ...) {
    if (*off >= out_size) return 0;
    va_list ap;
    va_start(ap, fmt);
    int n = vsnprintf(out + *off, out_size - *off, fmt, ap);
    va_end(ap);
    if (n < 0 || (size_t)n >= out_size - *off) return 0;
    *off += (size_t)n;
    return 1;
}

static int append_esc_str(char *out, size_t out_size, size_t *off,
                          const char *key, const char *val, int comma) {
    if (*off >= out_size) return 0;
    if (comma) {
        if (*off + 1 >= out_size) return 0;
        out[(*off)++] = ',';
    }
    if (!append_fmt(out, out_size, off, "\"%s\":\"", key)) return 0;
    if (!lea_json_escape_into(out, out_size, off, val ? val : "")) return 0;
    if (*off + 1 >= out_size) return 0;
    out[(*off)++] = '"';
    out[*off] = '\0';
    return 1;
}

int lea_audit_format_line(const lea_audit_event_t *ev, const char *iso_ts,
                          char *out, size_t out_size) {
    if (!ev || !out || out_size < 256) return 0;
    size_t off = 0;
    /* #18：以下每次追加都校验返回值——任一步放不下即整行失败返回 0，
     * 绝不让 off 越过 out_size 后继续写（旧实现 off += snprintf 返回值，
     * 截断后 off 照涨，末尾 out[off] 写越界）。 */
    if (!append_fmt(out, out_size, &off, "{")) return 0;
    if (!append_esc_str(out, out_size, &off, "ts", iso_ts ? iso_ts : "", 0)) return 0;
    if (!append_esc_str(out, out_size, &off, "event", ev->event ? ev->event : "execute", 1)) return 0;
    if (!append_esc_str(out, out_size, &off, "trace_id", ev->trace_id, 1)) return 0;
    if (!append_esc_str(out, out_size, &off, "request_id", ev->request_id, 1)) return 0;
    if (!append_esc_str(out, out_size, &off, "batch_id", ev->batch_id, 1)) return 0;
    if (!append_fmt(out, out_size, &off, ",\"seq\":%lld", ev->seq)) return 0;
    if (!append_esc_str(out, out_size, &off, "account_id", ev->account_id, 1)) return 0;
    if (!append_esc_str(out, out_size, &off, "device_id", ev->device_id, 1)) return 0;
    if (!append_esc_str(out, out_size, &off, "api_key_id", ev->api_key_id, 1)) return 0;
    if (!append_esc_str(out, out_size, &off, "key_prefix", ev->key_prefix_redacted, 1)) return 0;
    if (!append_fmt(out, out_size, &off, ",\"binding_epoch\":%lld",
                    ev->binding_epoch)) return 0;
    if (!append_esc_str(out, out_size, &off, "command", ev->command, 1)) return 0;
    if (!append_esc_str(out, out_size, &off, "params_hash", ev->params_hash, 1)) return 0;
    if (!append_esc_str(out, out_size, &off, "idempotency_key", ev->idempotency_key, 1)) return 0;
    if (!append_esc_str(out, out_size, &off, "nonce", ev->nonce, 1)) return 0;
    if (!append_esc_str(out, out_size, &off, "result", ev->result, 1)) return 0;
    if (!append_esc_str(out, out_size, &off, "error_code", ev->error_code, 1)) return 0;
    if (!append_fmt(out, out_size, &off, ",\"duration_ms\":%ld",
                    ev->duration_ms)) return 0;
    if (!append_esc_str(out, out_size, &off, "ush_session_id", ev->ush_session_id, 1)) return 0;
    if (!append_fmt(out, out_size, &off, ",\"process_id\":%ld",
                    ev->process_id)) return 0;
    if (!append_fmt(out, out_size, &off, ",\"retry_count\":%d",
                    ev->retry_count)) return 0;
    if (!append_esc_str(out, out_size, &off, "detail", ev->detail, 1)) return 0;
    if (off + 2 >= out_size) return 0;
    out[off++] = '}';
    out[off] = '\0';
    return 1;
}

int lea_audit_append(const char *dir, const char *date_ymd,
                     const lea_audit_event_t *ev, const char *iso_ts) {
    if (!dir || !date_ymd || !ev) return 0;
    char path[1024];
    if (snprintf(path, sizeof(path), "%s/lea-%s.jsonl", dir, date_ymd) >= (int)sizeof(path))
        return 0;
    char line[8192];
    if (!lea_audit_format_line(ev, iso_ts, line, sizeof(line))) return 0;
    FILE *f = fopen(path, "a");
    if (!f) return 0;
    /* A7：审计落盘须可验证——fputs／fputc／fflush／fclose 任一失败
     * 即返回失败（调用方据此 fail-closed）；fclose 只调一次。
     * 旧实现全不检查返回值，磁盘满时审计静默丢失、调用方还以为已记。 */
    int ok = (fputs(line, f) != EOF) && (fputc('\n', f) != EOF) &&
             (fflush(f) == 0);
    if (fclose(f) != 0) ok = 0;
    return ok;
}

/* "YYYY-MM-DD" 转天数（Civil from Days 算法，Howard Hinnant 公共领域算法）。 */
static long ymd_to_days(int y, int m, int d) {
    y -= m <= 2;
    long era = (y >= 0 ? y : y - 399) / 400;
    unsigned yoe = (unsigned)(y - era * 400);
    unsigned doy = (unsigned)((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1);
    unsigned doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    return era * 146097 + (long)doe - 719468;
}

int lea_audit_prune(const char *dir, int retain_days, const char *today_ymd) {
    if (!dir || !today_ymd) return -1;
    int ty, tm, td;
    if (sscanf(today_ymd, "%d-%d-%d", &ty, &tm, &td) != 3) return -1;
    long today = ymd_to_days(ty, tm, td);
    DIR *dp = opendir(dir);
    if (!dp) return -1;
    int removed = 0;
    struct dirent *de;
    char path[1024];
    while ((de = readdir(dp)) != NULL) {
        int y, m, d;
        if (strncmp(de->d_name, "lea-", 4) != 0) continue;
        if (sscanf(de->d_name + 4, "%d-%d-%d", &y, &m, &d) != 3) continue;
        if (today - ymd_to_days(y, m, d) > retain_days) {
            snprintf(path, sizeof(path), "%s/%s", dir, de->d_name);
            if (remove(path) == 0) removed++;
        }
    }
    closedir(dp);
    return removed;
}
