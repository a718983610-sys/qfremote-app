/* 见 ush_json.h：纯 C，无 Windows 依赖。 */
#include "ush_json.h"
#include <string.h>
#include <stdlib.h>
#include <stdio.h>
#include <math.h>
#include <errno.h>
#include <limits.h>

/* Walk complete JSON values, so nested keys, escaped text and malformed
 * numeric suffixes cannot be mistaken for top-level request fields. */
static const char *json_ws(const char *p) {
    while (*p == ' ' || *p == '\t' || *p == '\r' || *p == '\n') p++;
    return p;
}
static int json_delimiter(char c) {
    return !c || c == ',' || c == '}' || c == ']' || c == ' ' ||
           c == '\t' || c == '\r' || c == '\n';
}
static const char *json_number_end(const char *p, int integral) {
    if (*p == '-') p++;
    if (*p == '0') p++;
    else if (*p >= '1' && *p <= '9') { do { p++; } while (*p >= '0' && *p <= '9'); }
    else return NULL;
    if (!integral && *p == '.') {
        p++;
        if (*p < '0' || *p > '9') return NULL;
        do { p++; } while (*p >= '0' && *p <= '9');
    }
    if (!integral && (*p == 'e' || *p == 'E')) {
        p++;
        if (*p == '+' || *p == '-') p++;
        if (*p < '0' || *p > '9') return NULL;
        do { p++; } while (*p >= '0' && *p <= '9');
    }
    return json_delimiter(*p) ? p : NULL;
}
static const char *json_string_end(const char *p) {
    if (*p++ != '"') return NULL;
    while (*p) {
        if (*p == '"') return p + 1;
        if ((unsigned char)*p < 0x20) return NULL;
        if (*p == '\\') {
            p++;
            if (*p == 'u') {
                for (int i = 0; i < 4; i++) {
                    char c = *++p;
                    if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') ||
                          (c >= 'A' && c <= 'F'))) return NULL;
                }
            } else if (!*p || !strchr("\"\\/bfnrt", *p)) return NULL;
        }
        p++;
    }
    return NULL;
}
static const char *json_value_end(const char *p, int depth) {
    if (depth > 64) return NULL;
    p = json_ws(p);
    if (*p == '"') return json_string_end(p);
    if (*p == '{' || *p == '[') {
        int object = *p == '{';
        char close = object ? '}' : ']';
        p = json_ws(p + 1);
        if (*p == close) return p + 1;
        for (;;) {
            if (object) {
                p = json_string_end(p);
                if (!p || *(p = json_ws(p)) != ':') return NULL;
                p = json_ws(p + 1);
            }
            p = json_value_end(p, depth + 1);
            if (!p) return NULL;
            p = json_ws(p);
            if (*p == close) return p + 1;
            if (*p != ',') return NULL;
            p = json_ws(p + 1);
        }
    }
    if (strncmp(p, "true", 4) == 0 && json_delimiter(p[4])) return p + 4;
    if (strncmp(p, "false", 5) == 0 && json_delimiter(p[5])) return p + 5;
    if (strncmp(p, "null", 4) == 0 && json_delimiter(p[4])) return p + 4;
    return json_number_end(p, 0);
}
static int json_key_equals(const char *start, const char *end, const char *key) {
    start++;
    while (start < end - 1 && *key) {
        unsigned c = (unsigned char)*start++;
        if (c == '\\') {
            c = (unsigned char)*start++;
            if (c == 'u') {
                c = 0;
                for (int i = 0; i < 4; i++) {
                    unsigned h = (unsigned char)*start++;
                    c = (c << 4) | (h <= '9' ? h - '0' : (h | 32) - 'a' + 10);
                }
            } else {
                const char *escapes = "\"\\/bfnrt";
                const char *esc = strchr(escapes, (int)c);
                c = (unsigned char)"\"\\/\b\f\n\r\t"[esc - escapes];
            }
        }
        if (c != (unsigned char)*key++) return 0;
    }
    return start == end - 1 && !*key;
}
static const char *find_key_value(const char *json, const char *key) {
    if (!json || !key || !*key) return NULL;
    const char *p = json_ws(json);
    const char *document_end = json_value_end(p, 0);
    if (*p != '{' || !document_end || *json_ws(document_end)) return NULL;
    const char *found = NULL;
    p = json_ws(p + 1);
    while (*p != '}') {
        const char *start = p, *end = json_string_end(p);
        if (!end) return NULL;
        p = json_ws(json_ws(end) + 1);
        if (json_key_equals(start, end, key)) {
            if (found) return NULL; /* ambiguous duplicate field */
            found = p;
        }
        p = json_ws(json_value_end(p, 1));
        if (*p == '}') break;
        p = json_ws(p + 1);
    }
    return found;
}

/* \uXXXX 解码：读 4 位 hex；返回码点，失败返回 -1。 */
static int hex4(const char *p, unsigned *out) {
    unsigned v = 0;
    for (int i = 0; i < 4; i++) {
        char c = p[i];
        if (!c) return -1;
        v <<= 4;
        if (c >= '0' && c <= '9') v |= (unsigned)(c - '0');
        else if (c >= 'a' && c <= 'f') v |= (unsigned)(c - 'a' + 10);
        else if (c >= 'A' && c <= 'F') v |= (unsigned)(c - 'A' + 10);
        else return -1;
    }
    *out = v;
    return 0;
}

/* 码点写 UTF-8；返回写入字节数。 */
static int utf8_encode(unsigned cp, char *out) {
    if (cp < 0x80) { out[0] = (char)cp; return 1; }
    if (cp < 0x800) {
        out[0] = (char)(0xC0 | (cp >> 6));
        out[1] = (char)(0x80 | (cp & 0x3F));
        return 2;
    }
    if (cp < 0x10000) {
        out[0] = (char)(0xE0 | (cp >> 12));
        out[1] = (char)(0x80 | ((cp >> 6) & 0x3F));
        out[2] = (char)(0x80 | (cp & 0x3F));
        return 3;
    }
    out[0] = (char)(0xF0 | (cp >> 18));
    out[1] = (char)(0x80 | ((cp >> 12) & 0x3F));
    out[2] = (char)(0x80 | ((cp >> 6) & 0x3F));
    out[3] = (char)(0x80 | (cp & 0x3F));
    return 4;
}

static int json_get_string_impl(const char *json, const char *key, char *out, size_t out_size) {
    if (!out || out_size == 0) return 0;
    out[0] = '\0';
    const char *p = find_key_value(json, key);
    if (!p || *p != '"') return 0;
    p++;
    size_t n = 0;
    while (*p) {
        if (*p == '"') {
            if (n >= out_size) return 0;
            out[n] = '\0';
            return 1;
        }
        if ((unsigned char)*p < 0x20) return 0; /* 裸控制字符非法 */
        if (*p == '\\') {
            p++;
            char e = *p;
            if (e == '"' || e == '\\' || e == '/') {
                if (n + 1 >= out_size) return 0;
                out[n++] = e; p++;
            } else if (e == 'b') { if (n + 1 >= out_size) return 0; out[n++] = '\b'; p++; }
            else if (e == 'f') { if (n + 1 >= out_size) return 0; out[n++] = '\f'; p++; }
            else if (e == 'n') { if (n + 1 >= out_size) return 0; out[n++] = '\n'; p++; }
            else if (e == 'r') { if (n + 1 >= out_size) return 0; out[n++] = '\r'; p++; }
            else if (e == 't') { if (n + 1 >= out_size) return 0; out[n++] = '\t'; p++; }
            else if (e == 'u') {
                unsigned cp;
                if (hex4(p + 1, &cp) != 0 || cp == 0) return 0;
                p += 5;
                if (cp >= 0xD800 && cp <= 0xDBFF) {
                    /* 高代理：后须跟 \uDC00-\uDFFF 低代理 */
                    if (p[0] != '\\' || p[1] != 'u') return 0;
                    unsigned lo;
                    if (hex4(p + 2, &lo) != 0) return 0;
                    if (lo < 0xDC00 || lo > 0xDFFF) return 0;
                    cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
                    p += 6;
                } else if (cp >= 0xDC00 && cp <= 0xDFFF) {
                    return 0; /* 孤立低代理 */
                }
                char tmp[4];
                int w = utf8_encode(cp, tmp);
                if (n + (size_t)w >= out_size) return 0;
                memcpy(out + n, tmp, (size_t)w);
                n += (size_t)w;
            } else {
                return 0; /* 非法转义 */
            }
            continue;
        }
        if (n + 1 >= out_size) return 0;
        out[n++] = *p++;
    }
    return 0; /* 未闭合 */
}

int ush_json_get_string(const char *json, const char *key, char *out, size_t out_size) {
    int ok = json_get_string_impl(json, key, out, out_size);
    if (!ok && out && out_size) out[0] = '\0';
    return ok;
}
int ush_json_get_long(const char *json, const char *key, long *out) {
    const char *p = find_key_value(json, key);
    if (!p || !out || !json_number_end(p, 1)) return 0;
    char *end = NULL;
    errno = 0;
    long v = strtol(p, &end, 10);
    if (errno == ERANGE || end != json_number_end(p, 1)) return 0;
    *out = v;
    return 1;
}
int ush_json_get_llong(const char *json, const char *key, long long *out) {
    const char *p = find_key_value(json, key);
    if (!p || !out || !json_number_end(p, 1)) return 0;
    char *end = NULL;
    errno = 0;
    long long v = strtoll(p, &end, 10);
    if (errno == ERANGE || end != json_number_end(p, 1)) return 0;
    *out = v;
    return 1;
}

int ush_json_get_bool(const char *json, const char *key, int *out) {
    const char *p = find_key_value(json, key);
    if (!p || !out) return 0;
    if (strncmp(p, "true", 4) == 0) { *out = 1; return 1; }
    if (strncmp(p, "false", 5) == 0) { *out = 0; return 1; }
    return 0;
}

/* Strict JSON number grammar, including fractional/exponent digits. */
int ush_json_get_double(const char *json, const char *key, double *out) {
    const char *p = find_key_value(json, key);
    if (!p || !out || !json_number_end(p, 0)) return 0;
    char *end = NULL;
    errno = 0;
    double v = strtod(p, &end);
    if (errno == ERANGE || end != json_number_end(p, 0) || !isfinite(v)) return 0;
    *out = v;
    return 1;
}

int ush_json_get_object(const char *json, const char *key, char *out, size_t out_size) {
    if (!out || out_size == 0) return 0;
    out[0] = '\0';
    const char *p = find_key_value(json, key);
    if (!p || *p != '{') return 0;
    int depth = 0, in_str = 0, esc = 0;
    size_t n = 0;
    for (const char *q = p; *q; q++) {
        char c = *q;
        if (n + 1 >= out_size) return 0;
        out[n++] = c;
        if (esc) { esc = 0; continue; }
        if (c == '\\' && in_str) { esc = 1; continue; }
        if (c == '"') { in_str = !in_str; continue; }
        if (in_str) continue;
        if (c == '{') depth++;
        else if (c == '}') {
            depth--;
            if (depth == 0) { out[n] = '\0'; return 1; }
        }
    }
    return 0; /* 花括号未闭合 */
}

static int json_escape_impl(const char *in, char *out, size_t out_size) {
    static const char hexd[] = "0123456789abcdef";
    if (!in || !out || out_size == 0) return 0;
    size_t n = 0;
    for (const unsigned char *p = (const unsigned char *)in; *p; p++) {
        unsigned char c = *p;
        const char *rep = NULL;
        char tmp[7];
        if (c == '"') rep = "\\\"";
        else if (c == '\\') rep = "\\\\";
        else if (c == '\b') rep = "\\b";
        else if (c == '\f') rep = "\\f";
        else if (c == '\n') rep = "\\n";
        else if (c == '\r') rep = "\\r";
        else if (c == '\t') rep = "\\t";
        else if (c < 0x20) {
            tmp[0] = '\\'; tmp[1] = 'u'; tmp[2] = '0'; tmp[3] = '0';
            tmp[4] = hexd[(c >> 4) & 0xF]; tmp[5] = hexd[c & 0xF]; tmp[6] = '\0';
            rep = tmp;
        }
        if (rep) {
            size_t rl = strlen(rep);
            if (n + rl >= out_size) return 0;
            memcpy(out + n, rep, rl);
            n += rl;
        } else {
            if (n + 1 >= out_size) return 0;
            out[n++] = (char)c;
        }
    }
    if (n >= out_size) return 0;
    out[n] = '\0';
    return 1;
}

int ush_json_escape(const char *in, char *out, size_t out_size) {
    int ok = json_escape_impl(in, out, out_size);
    if (!ok && out && out_size) out[0] = '\0';
    return ok;
}

int ush_parse_request(const char *text, ush_request_t *out) {
    memset(out, 0, sizeof(*out));
    out->timeout_ms = USH_DEFAULT_TIMEOUT_MS;
    if (!text || text[0] == '\0' || strlen(text) > USH_MAX_REQUEST) {
        strcpy(out->error, USH_ERR_BAD_REQUEST);
        return 0;
    }
    /* 信封可选字段先取：即使命令未知/解析失败，响应里也要能回 request_id，
     * 否则调用方（LEA）无法关联。 */
    ush_json_get_string(text, "request_id", out->request_id, sizeof(out->request_id));
    ush_json_get_string(text, "trace_id", out->trace_id, sizeof(out->trace_id));
    ush_json_get_string(text, "batch_id", out->batch_id, sizeof(out->batch_id));
    ush_json_get_string(text, "idempotency_key", out->idempotency_key, sizeof(out->idempotency_key));
    ush_json_get_string(text, "account_id", out->account_id, sizeof(out->account_id));
    ush_json_get_string(text, "device_id", out->device_id, sizeof(out->device_id));
    ush_json_get_string(text, "api_key_id", out->api_key_id, sizeof(out->api_key_id));
    ush_json_get_string(text, "nonce", out->nonce, sizeof(out->nonce));
    /* H03：LEA 转发的鉴权 token（缺失即空串，调用点按未授权拒绝，
     * 自探活 ui.ping 除外）。 */
    ush_json_get_string(text, "ush_token", out->ush_token, sizeof(out->ush_token));
    long be = 0;
    if (ush_json_get_long(text, "binding_epoch", &be)) out->binding_epoch = be;
    long long seq = 0;
    if (ush_json_get_llong(text, "seq", &seq)) out->seq = seq;
    long to = 0;
    if (ush_json_get_long(text, "timeout_ms", &to)) {
        if (to < 1) to = 1;
        if (to > USH_MAX_TIMEOUT_MS) to = USH_MAX_TIMEOUT_MS;
        out->timeout_ms = to;
    }
    int d = 0;
    if (ush_json_get_bool(text, "dangerous", &d)) out->dangerous = d;

    char cmd[32];
    if (!ush_json_get_string(text, "command", cmd, sizeof(cmd))) {
        /* 兼容 QFSysHelper 风格的 "cmd" 字段 */
        if (!ush_json_get_string(text, "cmd", cmd, sizeof(cmd))) {
            strcpy(out->error, USH_ERR_BAD_REQUEST);
            return 0;
        }
    }
    size_t cmd_len = strlen(cmd);
    if (cmd_len > sizeof(out->command) - 1) cmd_len = sizeof(out->command) - 1;
    memcpy(out->command, cmd, cmd_len);
    out->command[cmd_len] = '\0';
    if (strcmp(cmd, "ui.ping") == 0) out->cmd = USH_CMD_PING;
    else if (strcmp(cmd, "ui.click") == 0) out->cmd = USH_CMD_CLICK;
    else if (strcmp(cmd, "ui.input") == 0) out->cmd = USH_CMD_INPUT;
    else if (strcmp(cmd, "ui.snapshot") == 0) out->cmd = USH_CMD_SNAPSHOT;
    else if (strcmp(cmd, "ui.tree") == 0) out->cmd = USH_CMD_TREE;
    else if (strcmp(cmd, "selfbind.deliver-ticket") == 0) out->cmd = USH_CMD_SELFBIND;
    else if (strcmp(cmd, "selfbind.clear-credential") == 0) out->cmd = USH_CMD_SELFBIND_CLEAR;
    else if (strcmp(cmd, "selfbind.status") == 0) out->cmd = USH_CMD_SELFBIND_STATUS;
    else if (strcmp(cmd, "selfbind.renew") == 0) out->cmd = USH_CMD_SELFBIND_RENEW;
    else { strcpy(out->error, USH_ERR_UNKNOWN_COMMAND); return 0; }

    /* params 缺失时视为空对象；params 不是对象时拒绝 */
    if (!ush_json_get_object(text, "params", out->params_json, sizeof(out->params_json))) {
        if (strstr(text, "\"params\"") != NULL) {
            strcpy(out->error, USH_ERR_BAD_REQUEST);
            return 0;
        }
        strcpy(out->params_json, "{}");
    }
    out->valid = 1;
    return 1;
}

int ush_build_response(char *out, size_t out_size, int ok, const char *code,
                       const char *request_id, long duration_ms,
                       const char *data_json, const char *error_text) {
    if (!out || out_size == 0 || !code) return 0;
    char rid_esc[256];
    if (!ush_json_escape(request_id ? request_id : "", rid_esc, sizeof(rid_esc))) return 0;
    int n;
    if (ok) {
        n = snprintf(out, out_size,
            "{\"ok\":true,\"code\":\"%s\",\"request_id\":\"%s\",\"duration_ms\":%ld,\"data\":%s}\n",
            code, rid_esc, duration_ms, data_json ? data_json : "{}");
    } else {
        char err_esc[1024];
        if (!ush_json_escape(error_text ? error_text : "", err_esc, sizeof(err_esc))) return 0;
        n = snprintf(out, out_size,
            "{\"ok\":false,\"code\":\"%s\",\"request_id\":\"%s\",\"duration_ms\":%ld,\"error\":\"%s\"}\n",
            code, rid_esc, duration_ms, err_esc);
    }
    return n > 0 && (size_t)n < out_size;
}

int ush_base64_encode(const unsigned char *in, size_t len, char *out, size_t out_size) {
    static const char tbl[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    size_t need = ((len + 2) / 3) * 4 + 1;
    if (!in || !out || out_size < need) return 0;
    size_t o = 0;
    for (size_t i = 0; i < len; i += 3) {
        size_t rem = len - i;
        unsigned v = (unsigned)in[i] << 16;
        if (rem > 1) v |= (unsigned)in[i + 1] << 8;
        if (rem > 2) v |= in[i + 2];
        out[o++] = tbl[(v >> 18) & 0x3F];
        out[o++] = tbl[(v >> 12) & 0x3F];
        out[o++] = rem > 1 ? tbl[(v >> 6) & 0x3F] : '=';
        out[o++] = rem > 2 ? tbl[v & 0x3F] : '=';
    }
    out[o] = '\0';
    return 1;
}

int ush_base64_decode(const char *in, unsigned char *out, size_t out_size, size_t *out_len) {
    if (out_len) *out_len = 0;
    if (!in || !out || !out_len) return 0;
    size_t ilen = strlen(in);
    if (ilen % 4) return 0;
    size_t need = (ilen / 4) * 3;
    if (ilen && in[ilen - 1] == '=') need--;
    if (ilen > 1 && in[ilen - 2] == '=') need--;
    if (out_size < need) return 0;
    size_t o = 0;
    for (size_t i = 0; i < ilen; i += 4) {
        unsigned v = 0;
        int pad = 0;
        for (int j = 0; j < 4; j++) {
            char c = in[i + j];
            unsigned d;
            if (c == '=') {
                if (i + 4 != ilen || j < 2) return 0;
                d = 0;
                pad++;
            } else {
                if (pad) return 0;
                if (c >= 'A' && c <= 'Z') d = (unsigned)(c - 'A');
                else if (c >= 'a' && c <= 'z') d = (unsigned)(c - 'a' + 26);
                else if (c >= '0' && c <= '9') d = (unsigned)(c - '0' + 52);
                else if (c == '+') d = 62;
                else if (c == '/') d = 63;
                else return 0;
            }
            v = (v << 6) | d;
        }
        if ((pad == 2 && (v & 0xffffu)) || (pad == 1 && (v & 0xffu))) return 0;
        out[o++] = (unsigned char)(v >> 16);
        if (pad < 2) out[o++] = (unsigned char)(v >> 8);
        if (pad < 1) out[o++] = (unsigned char)v;
    }
    *out_len = o;
    return 1;
}

int ush_token_matches(const char *expected, const char *provided) {
    if (!expected || !provided) return 0;
    size_t el = strlen(expected), pl = strlen(provided);
    if (el == 0 || pl == 0 || el != pl) return 0;
    unsigned char diff = 0;
    for (size_t i = 0; i < el; i++) diff |= (unsigned char)(expected[i] ^ provided[i]);
    return diff == 0;
}

int ush_click_retry_delay_ms(int dangerous, int attempt) {
    if (dangerous) return -1;
    if (attempt == 0) return 200;
    if (attempt == 1) return 500;
    return -1;
}

static const char *g_strategies[] = {
    "automation_id",
    "name+control_type",
    "class_name+index",
    "relative_coords",
    "image_template" /* MVP 未实现 */
};

int ush_locator_strategy_count(void) { return 5; }

const char *ush_locator_strategy_name(int index) {
    if (index < 0 || index >= 5) return NULL;
    return g_strategies[index];
}
