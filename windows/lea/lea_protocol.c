/* 见 lea_protocol.h */
#include "lea_protocol.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <ctype.h>

/* ---------------- 命令表（DESIGN §4.4；超时见 §4.3） ---------------- */
static const lea_command_spec_t k_commands[] = {
    { "app.open",    LEA_EXEC_LEA,    15000,  60000, 0, NULL },
    { "app.close",   LEA_EXEC_LEA,     5000,  15000, 0, NULL },
    { "ui.click",    LEA_EXEC_USH,     5000,  15000, 0, NULL },
    { "ui.input",    LEA_EXEC_USH,     5000,  15000, 0, NULL },
    { "ui.snapshot", LEA_EXEC_USH,     5000,  15000, 0, NULL },
    { "ui.tree",     LEA_EXEC_USH,     5000,  15000, 0, NULL },
    { "script.run",  LEA_EXEC_LEA,    30000, 300000, 1, "muse.execute.dangerous" },
    { "file.read",   LEA_EXEC_LEA,    10000,  30000, 0, NULL },
    { "file.write",  LEA_EXEC_LEA,    10000,  60000, 1, "muse.execute.dangerous" },
    { "sys.info",    LEA_EXEC_INLINE,  5000,   5000, 0, NULL },
    { NULL, 0, 0, 0, 0, NULL },
};

const lea_command_spec_t *lea_command_spec(const char *name) {
    if (!name) return NULL;
    for (int i = 0; k_commands[i].name; i++)
        if (strcmp(name, k_commands[i].name) == 0) return &k_commands[i];
    return NULL;
}

int lea_command_is_dangerous(const lea_envelope_t *env) {
    const lea_command_spec_t *spec = lea_command_spec(env->command);
    if (!spec) return 0;
    if (spec->dangerous) return 1;
    /* ui.click / ui.input 带 params.dangerous=true 时按危险命令走单独 lane。 */
    if (strcmp(env->command, "ui.click") == 0 ||
        strcmp(env->command, "ui.input") == 0) {
        int d = 0;
        if (lea_json_bool(env->params_raw, "dangerous", &d) && d) return 1;
    }
    return 0;
}

/* ---------------- JSON 取值（平铺字段；只认 \" 与 \\ 转义） ---------------- */
int lea_json_string(const char *text, const char *key, char *out, size_t out_size) {
    if (!text || !key || !out || out_size < 2) return 0;
    char pat[80];
    size_t klen = strlen(key);
    if (klen + 4 >= sizeof(pat)) return 0;
    pat[0] = '"';
    memcpy(pat + 1, key, klen);
    pat[klen + 1] = '"';
    pat[klen + 2] = ':';
    pat[klen + 3] = '"';
    pat[klen + 4] = '\0';
    const char *p = strstr(text, pat);
    if (!p) return 0;
    p += klen + 4;
    size_t n = 0;
    while (*p) {
        if (*p == '"') {
            out[n] = '\0';
            return 1;
        }
        if (*p == '\\') {
            p++;
            if (*p != '\\' && *p != '"') return 0;
            if (n + 1 >= out_size) return 0;
            out[n++] = *p++;
            continue;
        }
        if ((unsigned char)*p < 0x20) return 0;
        if (n + 1 >= out_size) return 0;
        out[n++] = *p++;
    }
    return 0;
}

int lea_json_long(const char *text, const char *key, long long *out) {
    if (!text || !key || !out) return 0;
    char pat[80];
    size_t klen = strlen(key);
    if (klen + 3 >= sizeof(pat)) return 0;
    pat[0] = '"';
    memcpy(pat + 1, key, klen);
    pat[klen + 1] = '"';
    pat[klen + 2] = ':';
    pat[klen + 3] = '\0';
    const char *p = strstr(text, pat);
    if (!p) return 0;
    p += klen + 3;
    while (*p == ' ' || *p == '\t') p++;
    if (*p == '"') return 0; /* 数字字段不接受引号包裹 */
    char *end = NULL;
    long long v = strtoll(p, &end, 10);
    if (end == p) return 0;
    *out = v;
    return 1;
}

int lea_json_bool(const char *text, const char *key, int *out) {
    if (!text || !key || !out) return 0;
    char pat[80];
    size_t klen = strlen(key);
    if (klen + 3 >= sizeof(pat)) return 0;
    pat[0] = '"';
    memcpy(pat + 1, key, klen);
    pat[klen + 1] = '"';
    pat[klen + 2] = ':';
    pat[klen + 3] = '\0';
    const char *p = strstr(text, pat);
    if (!p) return 0;
    p += klen + 3;
    while (*p == ' ' || *p == '\t') p++;
    if (strncmp(p, "true", 4) == 0) { *out = 1; return 1; }
    if (strncmp(p, "false", 5) == 0) { *out = 0; return 1; }
    return 0;
}

/* 取 params 对象原文（含花括号），做花括号配对。 */
int lea_json_object_raw(const char *text, const char *key, char *out, size_t out_size) {
    if (!text || !key || !out || out_size < 3) return 0;
    char pat[80];
    size_t klen = strlen(key);
    if (klen + 3 >= sizeof(pat)) return 0;
    pat[0] = '"';
    memcpy(pat + 1, key, klen);
    pat[klen + 1] = '"';
    pat[klen + 2] = ':';
    pat[klen + 3] = '\0';
    const char *p = strstr(text, pat);
    if (!p) return 0;
    p += klen + 3;
    while (*p == ' ' || *p == '\t') p++;
    if (*p != '{') return 0;
    int depth = 0, in_str = 0;
    const char *q = p;
    while (*q) {
        char c = *q;
        if (in_str) {
            if (c == '\\') { q += 2; continue; }
            if (c == '"') in_str = 0;
        } else {
            if (c == '"') in_str = 1;
            else if (c == '{') depth++;
            else if (c == '}') {
                depth--;
                if (depth == 0) {
                    size_t n = (size_t)(q - p) + 1;
                    if (n + 1 > out_size) return 0;
                    memcpy(out, p, n);
                    out[n] = '\0';
                    return 1;
                }
            }
        }
        q++;
    }
    return 0;
}

/* params 内字符串数组，如 "args":["a","b"]。 */
int lea_params_string_array(const char *params_raw, const char *key,
                            char out[][512], int max_items) {
    if (!params_raw || !key || !out || max_items <= 0) return -1;
    char pat[80];
    size_t klen = strlen(key);
    if (klen + 3 >= sizeof(pat)) return -1;
    pat[0] = '"';
    memcpy(pat + 1, key, klen);
    pat[klen + 1] = '"';
    pat[klen + 2] = ':';
    pat[klen + 3] = '\0';
    const char *p = strstr(params_raw, pat);
    if (!p) return -1;
    p += klen + 3;
    while (*p == ' ' || *p == '\t') p++;
    if (*p != '[') return -1;
    p++;
    int count = 0;
    while (*p) {
        while (*p == ' ' || *p == '\t' || *p == ',') p++;
        if (*p == ']') return count;
        if (*p != '"') return -1;
        p++;
        size_t n = 0;
        int closed = 0;
        while (*p) {
            if (*p == '"') { closed = 1; p++; break; }
            if (*p == '\\') {
                p++;
                if (*p != '\\' && *p != '"') return -1;
                if (n + 1 >= 512) return -1;
                out[count][n++] = *p++;
                continue;
            }
            if ((unsigned char)*p < 0x20) return -1;
            if (n + 1 >= 512) return -1;
            out[count][n++] = *p++;
        }
        if (!closed) return -1;
        out[count][n] = '\0';
        count++;
        if (count >= max_items) {
            /* 还有更多元素则溢出 */
            while (*p == ' ' || *p == '\t' || *p == ',') p++;
            if (*p != ']') return -1;
            return count;
        }
    }
    return -1;
}

/* ---------------- token 校验 ---------------- */
int lea_validate_token(const char *s) {
    if (!s) return 0;
    size_t len = strlen(s);
    if (len < 8 || len > 128) return 0;
    for (size_t i = 0; i < len; i++) {
        unsigned char c = (unsigned char)s[i];
        if (!((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
              (c >= '0' && c <= '9') || c == '-' || c == '_'))
            return 0;
    }
    return 1;
}

/* ---------------- 时间窗 ---------------- */
int lea_check_time_window(const lea_envelope_t *env, long long now_unix,
                          char *err, size_t err_size) {
    if (env->expires_at <= env->issued_at ||
        env->expires_at - env->issued_at > LEA_MAX_ENVELOPE_TTL_SEC) {
        if (err) snprintf(err, err_size, "%s", LEA_ERR_REPLAY);
        return 0;
    }
    long long skew = now_unix - env->issued_at;
    if (skew < -LEA_MAX_CLOCK_SKEW_SEC || skew > LEA_MAX_CLOCK_SKEW_SEC) {
        if (err) snprintf(err, err_size, "%s", LEA_ERR_REPLAY);
        return 0;
    }
    if (now_unix > env->expires_at + LEA_MAX_CLOCK_SKEW_SEC) {
        if (err) snprintf(err, err_size, "%s", LEA_ERR_REPLAY);
        return 0;
    }
    return 1;
}

/* ---------------- 信封解析 ---------------- */
static void set_err(lea_envelope_t *out, const char *code, const char *detail) {
    snprintf(out->error, sizeof(out->error), "%s", code);
    if (detail) snprintf(out->error_detail, sizeof(out->error_detail), "%s", detail);
}

int lea_parse_envelope(const char *text, long long now_unix, lea_envelope_t *out) {
    memset(out, 0, sizeof(*out));
    if (!text || text[0] == '\0' || strlen(text) > LEA_MAX_ENVELOPE) {
        set_err(out, LEA_ERR_BAD_ENVELOPE, "empty-or-oversize");
        return 0;
    }
    long long v = 0;
    if (!lea_json_long(text, "version", &v) || v != LEA_PROTOCOL_VERSION) {
        set_err(out, LEA_ERR_BAD_ENVELOPE, "version");
        return 0;
    }
    out->version = (int)v;
    if (!lea_json_string(text, "request_id", out->request_id, sizeof(out->request_id)) ||
        !lea_validate_token(out->request_id)) {
        set_err(out, LEA_ERR_BAD_ENVELOPE, "request_id");
        return 0;
    }
    /* batch_id 可选；seq 可选（默认 0）。 */
    lea_json_string(text, "batch_id", out->batch_id, sizeof(out->batch_id));
    long long seq = 0;
    if (lea_json_long(text, "seq", &seq)) out->seq = seq;
    if (!lea_json_string(text, "device_id", out->device_id, sizeof(out->device_id)) ||
        out->device_id[0] == '\0') {
        set_err(out, LEA_ERR_BAD_ENVELOPE, "device_id");
        return 0;
    }
    if (!lea_json_string(text, "account_id", out->account_id, sizeof(out->account_id)) ||
        out->account_id[0] == '\0') {
        set_err(out, LEA_ERR_BAD_ENVELOPE, "account_id");
        return 0;
    }
    if (!lea_json_string(text, "api_key_id", out->api_key_id, sizeof(out->api_key_id)) ||
        out->api_key_id[0] == '\0') {
        set_err(out, LEA_ERR_BAD_ENVELOPE, "api_key_id");
        return 0;
    }
    if (!lea_json_long(text, "binding_epoch", &out->binding_epoch)) {
        set_err(out, LEA_ERR_BAD_ENVELOPE, "binding_epoch");
        return 0;
    }
    if (!lea_json_string(text, "nonce", out->nonce, sizeof(out->nonce)) ||
        !lea_validate_token(out->nonce)) {
        set_err(out, LEA_ERR_BAD_ENVELOPE, "nonce");
        return 0;
    }
    if (!lea_json_long(text, "issued_at", &out->issued_at) ||
        !lea_json_long(text, "expires_at", &out->expires_at)) {
        set_err(out, LEA_ERR_BAD_ENVELOPE, "issued_at/expires_at");
        return 0;
    }
    char tw_err[64] = { 0 };
    if (!lea_check_time_window(out, now_unix, tw_err, sizeof(tw_err))) {
        set_err(out, tw_err, "time-window");
        return 0;
    }
    if (!lea_json_string(text, "idempotency_key", out->idempotency_key,
                         sizeof(out->idempotency_key)) ||
        !lea_validate_token(out->idempotency_key)) {
        set_err(out, LEA_ERR_BAD_ENVELOPE, "idempotency_key");
        return 0;
    }
    if (!lea_json_string(text, "command", out->command, sizeof(out->command)) ||
        !lea_command_spec(out->command)) {
        set_err(out, LEA_ERR_BAD_ENVELOPE, "command");
        return 0;
    }
    if (!lea_json_object_raw(text, "params", out->params_raw, sizeof(out->params_raw))) {
        /* params 缺失时视为空对象（sys.info 等无参命令）。 */
        snprintf(out->params_raw, sizeof(out->params_raw), "{}");
    }
    long long tmo = 0;
    if (lea_json_long(text, "timeout_ms", &tmo)) {
        out->timeout_ms = tmo;
        out->has_timeout = 1;
        const lea_command_spec_t *spec = lea_command_spec(out->command);
        if (tmo < 1 || tmo > spec->max_timeout_ms) {
            set_err(out, LEA_ERR_BAD_ENVELOPE, "timeout_ms");
            return 0;
        }
    }
    if (!lea_json_string(text, "signature", out->signature, sizeof(out->signature)) ||
        out->signature[0] == '\0') {
        set_err(out, LEA_ERR_BAD_ENVELOPE, "signature");
        return 0;
    }
    lea_json_string(text, "trace_id", out->trace_id, sizeof(out->trace_id));
    out->valid = 1;
    return 1;
}

long lea_effective_timeout_ms(const lea_envelope_t *env) {
    const lea_command_spec_t *spec = lea_command_spec(env->command);
    if (!spec) return 5000;
    if (env->has_timeout && env->timeout_ms >= 1 && env->timeout_ms <= spec->max_timeout_ms)
        return (long)env->timeout_ms;
    return spec->default_timeout_ms;
}

/* ---------------- 路径规范化 ---------------- */
/* 词法规范化：把 / 视为分隔符；折叠 "."；解析 ".."（越界根返回 0）。
 * 保留盘符前缀（C:）与开头的 \\（UNC）。输出用输入的主导分隔符。 */
int lea_normalize_path(const char *path, char *out, size_t out_size) {
    if (!path || !out || out_size < 4 || path[0] == '\0') return 0;
    int use_backslash = strchr(path, '\\') != NULL;
    char sep = use_backslash ? '\\' : '/';
    /* 分段 */
    char tmp[1024];
    if (strlen(path) >= sizeof(tmp)) return 0;
    snprintf(tmp, sizeof(tmp), "%s", path);
    for (char *p = tmp; *p; p++) if (*p == '/' || *p == '\\') *p = sep;

    char prefix[16] = { 0 };
    char *rest = tmp;
    size_t plen = strlen(tmp);
    if (plen >= 2 && tmp[1] == ':' &&
        ((tmp[0] >= 'A' && tmp[0] <= 'Z') || (tmp[0] >= 'a' && tmp[0] <= 'z'))) {
        prefix[0] = tmp[0]; prefix[1] = ':'; prefix[2] = '\0';
        rest = tmp + 2;
    } else if (plen >= 2 && tmp[0] == sep && tmp[1] == sep) {
        snprintf(prefix, sizeof(prefix), "%c%c", sep, sep);
        rest = tmp + 2;
    } else if (tmp[0] == sep) {
        snprintf(prefix, sizeof(prefix), "%c", sep);
        rest = tmp + 1;
    }
    /* 切分并解析 */
    char *segs[128];
    int nseg = 0;
    char *save = NULL;
    /* 手动切分（strtok_r 在 MSVC 下为 strtok_s；这里手写避免可移植性问题）。 */
    char *cur = rest;
    while (*cur) {
        while (*cur == sep) cur++;
        if (*cur == '\0') break;
        char *start = cur;
        while (*cur && *cur != sep) cur++;
        size_t slen = (size_t)(cur - start);
        if (slen == 1 && start[0] == '.') continue;
        if (slen == 2 && start[0] == '.' && start[1] == '.') {
            if (nseg == 0) return 0; /* 越界 */
            nseg--;
            continue;
        }
        if (nseg >= 128) return 0;
        char *s = (char *)malloc(slen + 1);
        if (!s) return 0;
        memcpy(s, start, slen);
        s[slen] = '\0';
        segs[nseg++] = s;
    }
    (void)save;
    size_t off = 0;
    off += (size_t)snprintf(out + off, out_size - off, "%s", prefix);
    for (int i = 0; i < nseg; i++) {
        if (off > 0 && out[off - 1] != sep) {
            if (off + 1 >= out_size) goto fail;
            out[off++] = sep;
            out[off] = '\0';
        }
        size_t l = strlen(segs[i]);
        if (off + l >= out_size) goto fail;
        memcpy(out + off, segs[i], l);
        off += l;
        out[off] = '\0';
        free(segs[i]);
    }
    if (nseg == 0 && prefix[0] == '\0') {
        /* 空路径 */
        goto fail;
    }
    return 1;
fail:
    for (int i = 0; i < nseg; i++) free(segs[i]);
    return 0;
}

static int ci_startswith(const char *s, const char *prefix) {
    while (*prefix) {
        char a = *s, b = *prefix;
        if (a >= 'A' && a <= 'Z') a = (char)(a + 32);
        if (b >= 'A' && b <= 'Z') b = (char)(b + 32);
        if (a != b) return 0;
        s++; prefix++;
    }
    return 1;
}

int lea_path_under_root(const char *norm_path, const char *norm_root) {
    if (!norm_path || !norm_root) return 0;
    size_t rlen = strlen(norm_root);
    if (rlen == 0) return 0;
    if (!ci_startswith(norm_path, norm_root)) return 0;
    char next = norm_path[rlen];
    if (next == '\0') return 0; /* 等于 root 本身不算在其内 */
    return next == '\\' || next == '/';
}

/* ---------------- JSON 输出助手 ---------------- */
int lea_json_escape_into(char *buf, size_t buf_size, size_t *off, const char *s) {
    if (!buf || !off || !s) return 0;
    size_t o = *off;
    for (const unsigned char *p = (const unsigned char *)s; *p; p++) {
        const char *esc = NULL;
        char tmp[8];
        if (*p == '"') esc = "\\\"";
        else if (*p == '\\') esc = "\\\\";
        else if (*p == '\n') esc = "\\n";
        else if (*p == '\r') esc = "\\r";
        else if (*p == '\t') esc = "\\t";
        else if (*p < 0x20) { snprintf(tmp, sizeof(tmp), "\\u%04x", *p); esc = tmp; }
        else {
            if (o + 1 >= buf_size) return 0;
            buf[o++] = (char)*p;
            continue;
        }
        size_t el = strlen(esc);
        if (o + el >= buf_size) return 0;
        memcpy(buf + o, esc, el);
        o += el;
    }
    buf[o] = '\0';
    *off = o;
    return 1;
}

int lea_build_response(char *out, size_t out_size, int ok, const char *code,
                       const char *request_id, int retryable,
                       const char *detail, const char *result_json) {
    if (!out || out_size < 64 || !code) return 0;
    size_t off = 0;
    /* 每次 snprintf 后夹紧 off：off 一旦触顶即返回 0，绝不让 out+off
     * 越过缓冲区（snprintf 的返回值是“本想写的长度”，不能直接累加）。 */
#define LEA_APPEND(...) do { \
        if (off >= out_size) return 0; \
        int _n = snprintf(out + off, out_size - off, __VA_ARGS__); \
        if (_n < 0) return 0; \
        off += (size_t)_n; \
        if (off >= out_size) return 0; \
    } while (0)
    LEA_APPEND("{\"ok\":%s,\"code\":\"%s\",\"request_id\":\"",
               ok ? "true" : "false", code);
    if (!lea_json_escape_into(out, out_size, &off, request_id ? request_id : "")) return 0;
    LEA_APPEND("\",\"retryable\":%s,\"detail\":\"", retryable ? "true" : "false");
    if (!lea_json_escape_into(out, out_size, &off, detail ? detail : "")) return 0;
    LEA_APPEND("\",\"result\":%s}\n", result_json ? result_json : "null");
#undef LEA_APPEND
    return 1;
}
