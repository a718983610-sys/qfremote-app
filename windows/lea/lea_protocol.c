/* 见 lea_protocol.h */
#include "lea_protocol.h"
#include "lea_crypto.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdarg.h>
#include <ctype.h>
#include <errno.h>

/* 顶层成员查找／字符串解码（定义见本文件后部：json_decode_string 在
 * 票据解析段、json_find_member 在其后；供 lea_json_top_level_string
 * 使用，H08）。 */
static int json_find_member(const char *text, const char *key, const char **val, size_t *val_len);
static const char *json_decode_string(const char *p, char *out, size_t out_size, size_t *out_len);
static const char *json_skip_ws(const char *p);

/* ---------------- 命令表（DESIGN §4.4；超时见 §4.3） ---------------- */
static const lea_command_spec_t k_commands[] = {
    { "app.open",    LEA_EXEC_LEA,    15000,  60000, 0, NULL, 1 },
    { "app.close",   LEA_EXEC_LEA,     5000,  15000, 0, NULL, 1 },
    { "ui.click",    LEA_EXEC_USH,     5000,  15000, 0, NULL, 1 },
    { "ui.input",    LEA_EXEC_USH,     5000,  15000, 0, NULL, 1 },
    { "ui.snapshot", LEA_EXEC_USH,     5000,  15000, 0, NULL, 1 },
    { "ui.tree",     LEA_EXEC_USH,     5000,  15000, 0, NULL, 1 },
    { "script.run",  LEA_EXEC_LEA,    30000, 300000, 1, "muse.execute.dangerous", 2 },
    { "file.read",   LEA_EXEC_LEA,    10000,  30000, 0, NULL, 1 },
    { "file.write",  LEA_EXEC_LEA,    10000,  60000, 1, "muse.execute.dangerous", 2 },
    { "sys.info",    LEA_EXEC_INLINE,  5000,   5000, 0, NULL, 0 },
    /* B1：短命令独立 lane（内联，不进队列，不被长任务占用）。 */
    { "sys.ping",    LEA_EXEC_INLINE,  5000,   8000, 0, NULL, 0 },
    { "sys.reset",   LEA_EXEC_INLINE,  5000,   8000, 0, NULL, 0 },
    /* RC-01：握手命令（tier 0 内联；门在 QFRLEA.c handle_envelope）。 */
    { "sys.handshake", LEA_EXEC_INLINE, 5000,  5000, 0, NULL, 0 },
    { NULL, 0, 0, 0, 0, NULL, 0 },
};

int lea_command_tier(const char *name) {
    const lea_command_spec_t *spec = lea_command_spec(name);
    return spec ? spec->tier : -1;
}

long lea_job_deadline_ms(const lea_envelope_t *env) {
    long eff = lea_effective_timeout_ms(env);
    long cap;
    switch (lea_command_tier(env->command)) {
        case LEA_TIER_INLINE: cap = LEA_B1_TIER0_DEADLINE_MAX_MS; break;
        case LEA_TIER_LONG: cap = LEA_B1_TIER2_DEADLINE_MAX_MS; break;
        case LEA_TIER_NORMAL: cap = LEA_B1_TIER1_DEADLINE_MAX_MS; break;
        default: return 5000;
    }
    /* B1：deadline_ms 是调用方期望的强杀时限（调度提示），取
     * min(deadline_ms, timeout_ms) 后再夹 tier 上限；未提供（老信封）
     * 时用 timeout_ms。提示值不得放宽分级上限。 */
    long want = (env->has_deadline && env->deadline_ms > 0) ? (long)env->deadline_ms : eff;
    long d = want < eff ? want : eff;
    return d < cap ? d : cap;
}

int lea_params_has_true(const char *params_raw, const char *key) {
    int v = 0;
    if (!params_raw || !key) return 0;
    if (!lea_json_bool(params_raw, key, &v)) return 0;
    return v == 1;
}

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

/* S-022：按命令的可取消性（见 lea_protocol.h）。 */
int lea_command_is_cancellable(const lea_envelope_t *env) {
    const lea_command_spec_t *spec = lea_command_spec(env->command);
    if (!spec) return 0;
    if (spec->executor == LEA_EXEC_INLINE) return 0; /* 不进队列，无从取消 */
    if (lea_command_is_dangerous(env)) return 0;
    return 1;
}

/* ---------------- RC-01 握手态（纯函数，见 lea_protocol.h） ---------------- */
void lea_handshake_init(lea_handshake_state_t *s) {
    if (!s) return;
    memset(s, 0, sizeof(*s));
}

int lea_handshake_is_complete(const lea_handshake_state_t *s, const char *fp,
                              long long binding_epoch, long long grant_epoch) {
    if (!s || !s->completed || !fp || !fp[0]) return 0;
    if (strcmp(s->fp, fp) != 0) return 0;
    if (s->binding_epoch != binding_epoch) return 0;
    if (s->grant_epoch != grant_epoch) return 0;
    return 1;
}

void lea_handshake_mark_complete(lea_handshake_state_t *s, const char *fp,
                                 long long binding_epoch, long long grant_epoch) {
    if (!s || !fp || !fp[0]) return;
    s->completed = 1;
    snprintf(s->fp, sizeof(s->fp), "%s", fp);
    s->binding_epoch = binding_epoch;
    s->grant_epoch = grant_epoch;
}

void lea_handshake_invalidate(lea_handshake_state_t *s) {
    if (!s) return;
    s->completed = 0;
    s->fp[0] = '\0';
    s->binding_epoch = 0;
    s->grant_epoch = 0;
}

int lea_handshake_check_params(const char *fp, const char *params_fp, long long protocol_version) {
    if (!fp || !fp[0] || !params_fp) return 0;
    if (protocol_version != LEA_PROTOCOL_VERSION) return 0;
    return strcmp(fp, params_fp) == 0;
}

/* All public field readers use the same strict top-level parser. Signed
 * params cannot be interpreted differently by an executor (M-070/M-071). */
int lea_json_string(const char *text, const char *key, char *out, size_t out_size) {
    if (out && out_size) out[0] = '\0';
    return lea_json_top_level_string(text, key, out, out_size);
}

int lea_json_long(const char *text, const char *key, long long *out) {
    return lea_json_top_level_long(text, key, out) == 1;
}

/* 只认顶层对象成员的裸整数值（#1 世代字段 generation 用）：复用
 * json_find_member 严格顶层解析（重复键／嵌套／尾部垃圾即 -1）；值
 * 切片须整体为可选负号＋十进制数字（禁引号、禁小数、禁尾部字符），
 * strtoll 全量消费且禁 ERANGE 溢出钳制。返回 1=解析成功、0=成员缺失、
 * -1=成员存在但非法——调用方须区分“缺失”（按缺失处理）与“非法”
 * （整单拒绝），不得把非法当缺失静默放过。 */
int lea_json_top_level_long(const char *text, const char *key, long long *out) {
    if (!text || !key || !out) return -1;
    const char *val = NULL;
    size_t vlen = 0;
    int r = json_find_member(text, key, &val, &vlen);
    if (r == 0) return 0;
    if (r != 1) return -1;
    if (vlen == 0 || vlen >= 32) return -1;
    char buf[32];
    memcpy(buf, val, vlen);
    buf[vlen] = '\0';
    size_t i = 0;
    if (buf[0] == '-') i = 1;
    if (i >= vlen) return -1;
    for (; i < vlen; i++)
        if (buf[i] < '0' || buf[i] > '9') return -1;
    errno = 0;
    char *end = NULL;
    long long v = strtoll(buf, &end, 10);
    if (errno == ERANGE || !end || *end != '\0') return -1;
    *out = v;
    return 1;
}

int lea_json_bool(const char *text, const char *key, int *out) {
    const char *val = NULL;
    size_t len = 0;
    if (!text || !key || !out || json_find_member(text, key, &val, &len) != 1) return 0;
    if (len == 4 && memcmp(val, "true", 4) == 0) { *out = 1; return 1; }
    if (len == 5 && memcmp(val, "false", 5) == 0) { *out = 0; return 1; }
    return 0;
}

/* USH 响应 ok 判定：严格顶层解析，只认顶层对象中唯一一个布尔 "ok"。
 * 复用 H08 的 json_find_member（完整顶层对象遍历：重复键／对象语法
 * 错误／尾部多余内容即失败；嵌套对象内的同名键与字符串值里的字面量
 * 均不命中）。值切片须恰为 true/false。缺失／非布尔／未闭合／重复键
 * 一律返回 0，调用方（execute_item USH 分支）判失败；*out_ok 只在
 * 返回 1 时写入。绝不用 lea_json_bool 的 strstr 全文查找——
 * {"ok":true（未闭合）与嵌套 {"ok":true} 都会被它误采信。 */
int lea_ush_response_ok(const char *resp, int *out_ok) {
    const char *val = NULL;
    size_t vlen = 0;
    if (!resp || !out_ok) return 0;
    if (json_find_member(resp, "ok", &val, &vlen) != 1) return 0;
    if (vlen == 4 && memcmp(val, "true", 4) == 0) { *out_ok = 1; return 1; }
    if (vlen == 5 && memcmp(val, "false", 5) == 0) { *out_ok = 0; return 1; }
    return 0;
}

/* 只认顶层对象成员的字符串值（H08）。json_find_member 做完整顶层对象
 * 遍历：跳过全部 JSON 空白、重复键即失败、尾部多余内容即失败；值须为
 * JSON 字符串并按转义解码。嵌套对象内的同名键（如 params {"cmd":...}）
 * 绝不会命中。 */
int lea_json_top_level_string(const char *text, const char *key, char *out, size_t out_size) {
    if (!text || !key || !out || out_size < 2) return 0;
    const char *val = NULL;
    size_t vlen = 0;
    int r = json_find_member(text, key, &val, &vlen);
    if (r != 1) return 0;
    if (vlen < 2 || val[0] != '"') return 0;
    if (!json_decode_string(val, out, out_size, NULL)) return 0;
    return 1;
}

/* 只认顶层对象成员的字符串数组值（#17 keys.sync-revoked 用）。 */
int lea_json_top_level_string_array(const char *text, const char *key,
                                    char out[][129], int max_items) {
    if (!text || !key || !out || max_items <= 0) return -1;
    const char *val = NULL;
    size_t vlen = 0;
    int r = json_find_member(text, key, &val, &vlen);
    if (r != 1) return -1;
    const char *p = json_skip_ws(val);
    if (*p != '[') return -1;
    p = json_skip_ws(p + 1);
    int count = 0;
    if (*p == ']') {
        p = json_skip_ws(p + 1);
        return (p == val + vlen) ? 0 : -1;
    }
    for (;;) {
        p = json_skip_ws(p);
        if (*p != '"') return -1;
        if (count >= max_items) return -1;
        const char *after = json_decode_string(p, out[count], 129, NULL);
        if (!after) return -1;
        count++;
        p = json_skip_ws(after);
        if (*p == ',') { p++; continue; }
        if (*p == ']') {
            p = json_skip_ws(p + 1);
            return (p == val + vlen) ? count : -1;
        }
        return -1;
    }
}

/* Copy the exact signed top-level object bytes, preserving canonical input. */
int lea_json_object_raw(const char *text, const char *key, char *out, size_t out_size) {
    const char *val = NULL;
    size_t len = 0;
    if (!text || !key || !out || !out_size) return 0;
    out[0] = '\0';
    if (json_find_member(text, key, &val, &len) != 1 || !len || val[0] != '{' || len >= out_size) return 0;
    memcpy(out, val, len);
    out[len] = '\0';
    return 1;
}

int lea_params_string_array(const char *text, const char *key,
                            char out[][512], int max_items) {
    const char *val = NULL;
    size_t len = 0;
    if (!text || !key || !out || max_items <= 0 ||
        json_find_member(text, key, &val, &len) != 1 || !len || *val != '[') return -1;
    const char *p = json_skip_ws(val + 1);
    int count = 0;
    if (*p == ']') return 0;
    for (;;) {
        if (count >= max_items || *p != '"') return -1;
        const char *end = json_decode_string(p, out[count], 512, NULL);
        if (!end) return -1;
        count++;
        p = json_skip_ws(end);
        if (*p == ']') return p + 1 == val + len ? count : -1;
        if (*p != ',') return -1;
        p = json_skip_ws(p + 1);
    }
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

/* 规范串 v1 身份字段规则：非空、1..127 字节，无 <0x20、0x7F 控制字符。 */
int lea_validate_id_field(const char *s) {
    if (!s || s[0] == '\0') return 0;
    size_t len = strlen(s);
    if (len > 127) return 0;
    for (size_t i = 0; i < len; i++) {
        unsigned char c = (unsigned char)s[i];
        if (c < 0x20 || c == 0x7F) return 0;
    }
    return 1;
}

/* 规范 scopes 字符串：空或逗号连接的 token，严格字典序升序。
 * 不设单 token 长度上限（与 JS validateScopesString 一致；整串长度
 * 受字段／规范串缓冲限制）。 */
int lea_validate_scopes_str(const char *s) {
    if (!s) return 0;
    if (s[0] == '\0') return 1;
    const char *p = s;
    const char *prev = NULL;
    size_t prev_len = 0;
    while (1) {
        const char *comma = strchr(p, ',');
        size_t n = comma ? (size_t)(comma - p) : strlen(p);
        if (n == 0) return 0;
        for (size_t i = 0; i < n; i++) {
            unsigned char c = (unsigned char)p[i];
            if (!((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
                  (c >= '0' && c <= '9') || c == '_' || c == '.' || c == '-'))
                return 0;
        }
        if (prev) {
            size_t m = prev_len < n ? prev_len : n;
            int cmp = strncmp(prev, p, m);
            if (cmp > 0) return 0;
            if (cmp == 0 && prev_len >= n) return 0; /* 相等或 prev 更长 → 非严格升序 */
        }
        prev = p;
        prev_len = n;
        if (!comma) break;
        p = comma + 1;
    }
    return 1;
}

/* ---------------- 规范串 v1（CANONICAL-SIGNING-V1.md） ---------------- */
/* 带溢出检查的追加：写不下即返回 0（调用方按失败处理，绝不输出截断串）。 */
static int append_canonical(char *out, size_t out_size, size_t *off, const char *fmt, ...) {
    if (*off >= out_size) return 0;
    va_list ap;
    va_start(ap, fmt);
    int n = vsnprintf(out + *off, out_size - *off, fmt, ap);
    va_end(ap);
    if (n < 0) return 0;
    *off += (size_t)n;
    if (*off >= out_size) return 0;
    return 1;
}

int lea_envelope_canonical(const lea_envelope_t *env, char *out, size_t out_size) {
    if (!env || !out || out_size < 256) return 0;
    if (env->version != LEA_PROTOCOL_VERSION) return 0;
    if (!lea_validate_token(env->request_id) ||
        !lea_validate_token(env->nonce) ||
        !lea_validate_token(env->idempotency_key)) return 0;
    if (env->batch_id[0] && !lea_validate_id_field(env->batch_id)) return 0;
    if (!lea_validate_id_field(env->device_id) ||
        !lea_validate_id_field(env->account_id) ||
        !lea_validate_id_field(env->api_key_id)) return 0;
    if (env->seq < 1) return 0; /* v2：seq 必填且 ≥1（解析层已拒绝缺失／0） */
    if (!lea_command_spec(env->command)) return 0;
    if (env->params_raw[0] == '\0') return 0;
    /* F-02：grant_epoch 为无符号整数，上限 2^53-1（JS 安全整数界，
     * 与 JS envelopeSigningBytes 同界；超界／负数即构造失败，不得
     * 入串——否则 JS 侧 String() 结果与 C 端 long long 解析值
     * 不一致，规范串逐字节一致即被破坏）。 */
    if (env->grant_epoch < 0 || env->grant_epoch > 9007199254740991LL) return 0;
    /* params 只签 stable JSON 的 SHA-256：线上 params 子串即 stable JSON，
     * 此处对收到的 params_raw 原文算哈希（见规范 §2.1）。 */
    /* F-02：规范串 20 行（v1 的 19 行＋binding_epoch 之后一行
     * grant_epoch，与 JS envelopeSigningBytes 同序；缺省值与解析缺省
     * 一致：job_id 缺省 ''、mode 缺省 ''、deadline_ms 缺省 0；
     * 签信封原文值，不是派生值）。行尾：LF 连接、无结尾换行。 */
    char params_hash[65];
    lea_sha256_hex((const unsigned char *)env->params_raw, strlen(env->params_raw), params_hash);
    long timeout_ms = lea_effective_timeout_ms(env);
    if (timeout_ms < 1) return 0;
    size_t off = 0;
    if (!append_canonical(out, out_size, &off,
            "qfr-lea-envelope-v2\n%d\n%s\n%s\n%lld\n%s\n%s\n%s\n%lld\n%lld\n%s\n%lld\n%lld\n%s\n%s\n%s\n%ld\n%s\n%s\n%lld",
            env->version, env->request_id, env->batch_id, env->seq,
            env->device_id, env->account_id, env->api_key_id,
            env->binding_epoch, env->grant_epoch, env->nonce, env->issued_at, env->expires_at,
            env->idempotency_key, env->command, params_hash, timeout_ms,
            env->job_id, env->mode, (long long)env->deadline_ms))
        return 0;
    return 1;
}

int lea_ticket_canonical(const char *account_id, const char *device_id,
                         long long binding_epoch, long long grant_epoch,
                         long long grant_muse_execute, const char *scopes,
                         const char *lease_id, long long expires_at,
                         char *out, size_t out_size) {
    if (!out || out_size < 128) return 0;
    if (!lea_validate_id_field(account_id) || !lea_validate_id_field(device_id)) return 0;
    if (!scopes) scopes = "";
    if (!lea_validate_scopes_str(scopes)) return 0;
    if (!lease_id) lease_id = "";
    if (lease_id[0] && !lea_validate_id_field(lease_id)) return 0;
    /* grant 严格 0/1：不得 truthy 归一化，否则线上的 2 会被归一化为 1
     * 入串，签名无法绑定线上的实际值。此处收 long long：(int) 窄化会把
     * 4294967297 截成 1，严格校验形同虚设。 */
    if (grant_muse_execute != 0 && grant_muse_execute != 1) return 0;
    size_t off = 0;
    if (!append_canonical(out, out_size, &off,
            "qfr-lea-ticket-v1\n%s\n%s\n%lld\n%lld\n%lld\n%s\n%s\n%lld",
            account_id, device_id, binding_epoch, grant_epoch, grant_muse_execute,
            scopes, lease_id, expires_at))
        return 0;
    return 1;
}

/* ---- 票据完整 JSON 成员解析（不用子串查找） ----
 * 下面的严格 JSON 解析器（json_parse_*）定义在本文件后部，此处先声明。 */
static const char *json_skip_ws(const char *p);
static const char *json_parse_string(const char *p);
static const char *json_parse_value(const char *p, int depth);

/* M-072: one UTF-8 validation path for both syntax and field decoding. */
static size_t json_utf8_sequence(const unsigned char *p) {
    size_t n;
    unsigned char c = p[0];
    if (c >= 0xC2 && c <= 0xDF) n = 2;
    else if (c >= 0xE0 && c <= 0xEF) n = 3;
    else if (c >= 0xF0 && c <= 0xF4) n = 4;
    else return 0;
    for (size_t i = 1; i < n; i++) if (p[i] < 0x80 || p[i] > 0xBF) return 0;
    if ((c == 0xE0 && p[1] < 0xA0) || (c == 0xED && p[1] >= 0xA0) ||
        (c == 0xF0 && p[1] < 0x90) || (c == 0xF4 && p[1] >= 0x90)) return 0;
    return n;
}

/* 解码一个 JSON 字符串值（p 指向开引号）：按 JSON 转义解码写入 out
 *（UTF-8 字节，含 \uXXXX 与代理对），成功返回尾后指针，否则 NULL。
 * 服务端 JSON.stringify 不产生 \u 转义，但攻击者可构造；正确解码才能
 * 让规范串绑定解码后的实际值。 */
static const char *json_decode_string(const char *p, char *out, size_t out_size, size_t *out_len) {
    if (!p || *p != '"' || !out || out_size < 1) return NULL;
    size_t n = 0;
    p++;
    while (*p) {
        unsigned char c = (unsigned char)*p;
        if (c == '"') {
            if (n + 1 > out_size) return NULL;
            out[n] = '\0';
            if (out_len) *out_len = n;
            return p + 1;
        }
        if (c < 0x20) return NULL;
        if (c == '\\') {
            p++;
            char e = *p;
            char rep = 0;
            if (e == '"' || e == '\\' || e == '/') rep = e;
            else if (e == 'b') rep = '\b';
            else if (e == 'f') rep = '\f';
            else if (e == 'n') rep = '\n';
            else if (e == 'r') rep = '\r';
            else if (e == 't') rep = '\t';
            else if (e == 'u') {
                unsigned int cp = 0;
                for (int i = 0; i < 4; i++) {
                    char h = p[1 + i];
                    unsigned int d;
                    if (h >= '0' && h <= '9') d = (unsigned int)(h - '0');
                    else if (h >= 'a' && h <= 'f') d = (unsigned int)(h - 'a' + 10);
                    else if (h >= 'A' && h <= 'F') d = (unsigned int)(h - 'A' + 10);
                    else return NULL;
                    cp = cp * 16 + d;
                }
                /* 解码出的控制字符（含 \u0000）即拒绝：\u0000 写入 C 字符串
                 * 会截断后续内容，strlen／%s 只能看到 NUL 前缀。 */
                if (cp < 0x20 || cp == 0x7F) return NULL;
                p += 5; /* 跳过 uXXXX */
                if (cp >= 0xD800 && cp <= 0xDBFF) {
                    /* 高代理：须紧跟 \uYYYY 低代理 */
                    if (p[0] != '\\' || p[1] != 'u') return NULL;
                    unsigned int lo = 0;
                    for (int i = 0; i < 4; i++) {
                        char h = p[2 + i];
                        unsigned int d;
                        if (h >= '0' && h <= '9') d = (unsigned int)(h - '0');
                        else if (h >= 'a' && h <= 'f') d = (unsigned int)(h - 'a' + 10);
                        else if (h >= 'A' && h <= 'F') d = (unsigned int)(h - 'A' + 10);
                        else return NULL;
                        lo = lo * 16 + d;
                    }
                    if (lo < 0xDC00 || lo > 0xDFFF) return NULL;
                    cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
                    p += 6;
                } else if (cp >= 0xDC00 && cp <= 0xDFFF) {
                    return NULL; /* 孤立低代理 */
                }
                /* cp → UTF-8 */
                char utf8[4];
                int ulen = 0;
                if (cp < 0x80) { utf8[0] = (char)cp; ulen = 1; }
                else if (cp < 0x800) {
                    utf8[0] = (char)(0xC0 | (cp >> 6));
                    utf8[1] = (char)(0x80 | (cp & 0x3F));
                    ulen = 2;
                } else if (cp < 0x10000) {
                    utf8[0] = (char)(0xE0 | (cp >> 12));
                    utf8[1] = (char)(0x80 | ((cp >> 6) & 0x3F));
                    utf8[2] = (char)(0x80 | (cp & 0x3F));
                    ulen = 3;
                } else {
                    utf8[0] = (char)(0xF0 | (cp >> 18));
                    utf8[1] = (char)(0x80 | ((cp >> 12) & 0x3F));
                    utf8[2] = (char)(0x80 | ((cp >> 6) & 0x3F));
                    utf8[3] = (char)(0x80 | (cp & 0x3F));
                    ulen = 4;
                }
                if (n + (size_t)ulen + 1 > out_size) return NULL;
                memcpy(out + n, utf8, (size_t)ulen);
                n += (size_t)ulen;
                continue;
            } else {
                return NULL;
            }
            /* 转义产生的控制字符（如 \n）即拒绝：合法票据值不含控制字符，
             * 下游字段校验本就拒绝，解码层直接拦住更彻底。 */
            if ((unsigned char)rep < 0x20 || rep == 0x7F) return NULL;
            if (n + 2 > out_size) return NULL;
            out[n++] = rep;
            p++;
            continue;
        }
        if (c >= 0x80) {
            size_t width = json_utf8_sequence((const unsigned char *)p);
            if (!width || n + width + 1 > out_size) return NULL;
            memcpy(out + n, p, width);
            n += width;
            p += width;
            continue;
        }
        if (n + 2 > out_size) return NULL;
        out[n++] = (char)c;
        p++;
    }
    return NULL;
}

/* 在顶层 JSON 对象中查找成员 key（原始键字节比较，与 lea_json_string
 * 同语义——含转义的键不匹配，fail-closed）。
 * 返回 1=恰好一次（*val／*val_len 为值原文范围），0=不存在，
 * -1=重复键或对象语法错误（含尾部多余内容）。跳过全部 JSON 空白。 */
static int json_find_member(const char *text, const char *key, const char **val, size_t *val_len) {
    if (!text || !key || !val || !val_len) return -1;
    const char *p = json_skip_ws(text);
    if (*p != '{') return -1;
    p = json_skip_ws(p + 1);
    int found = 0;
    const char *found_val = NULL;
    size_t found_len = 0;
    if (*p == '}') {
        p = json_skip_ws(p + 1);
        return *p == '\0' ? 0 : -1;
    }
    for (;;) {
        p = json_skip_ws(p);
        if (*p != '"') return -1;
        const char *after_key = json_parse_string(p);
        if (!after_key) return -1;
        /* 键须解码后再比较：原始字节比较会把 "sc\u006fpes" 当作不存在，
         * 攻击者可用转义键绕过“字段存在且非字符串必须拒绝”。 */
        char kbuf[128];
        size_t klen = 0;
        if (!json_decode_string(p, kbuf, sizeof(kbuf), &klen)) return -1;
        p = json_skip_ws(after_key);
        if (*p != ':') return -1;
        const char *vstart = json_skip_ws(p + 1);
        const char *vend = json_parse_value(vstart, 0);
        if (!vend) return -1;
        if (klen == strlen(key) && memcmp(kbuf, key, klen) == 0) {
            if (found) return -1; /* 重复键 */
            found = 1;
            found_val = vstart;
            found_len = (size_t)(vend - vstart);
        }
        p = json_skip_ws(vend);
        if (*p == ',') { p++; continue; }
        if (*p == '}') {
            p = json_skip_ws(p + 1);
            if (*p != '\0') return -1;
            if (!found) return 0;
            *val = found_val;
            *val_len = found_len;
            return 1;
        }
        return -1;
    }
}

/* 取字符串成员：存在时须为 JSON 字符串并解码入 out；缺失时 required=1
 * 即失败，required=0 按空串。返回 1=成功，0=失败。 */
static int ticket_get_string(const char *text, const char *key, char *out, size_t out_size, int required) {
    const char *val = NULL;
    size_t vlen = 0;
    int r = json_find_member(text, key, &val, &vlen);
    if (r < 0) return 0;
    if (r == 0) {
        if (required) return 0;
        out[0] = '\0';
        return 1;
    }
    if (vlen < 1 || val[0] != '"') return 0;
    if (!json_decode_string(val, out, out_size, NULL)) return 0;
    return 1;
}
/* 对 json_find_member 返回的值切片做严格整数解析（-?[0-9]+，溢出即失败）。
 * 必须用值切片解析，不得对全文做子串查找重取——params 内的嵌套同名键
 * 会遮蔽顶层值（如 params 含 "timeout_ms":5000 时全文查找会命中嵌套值，
 * 使顶层显式 null 被洗成 5000）。 */
static int json_long_from_slice(const char *val, size_t vlen, long long *out) {
    if (vlen < 1) return 0;
    size_t i = 0;
    if (val[0] == '-') { i = 1; if (vlen < 2) return 0; }
    for (; i < vlen; i++) {
        if (val[i] < '0' || val[i] > '9') return 0;
    }
    char num[32];
    if (vlen >= sizeof(num)) return 0;
    memcpy(num, val, vlen);
    num[vlen] = '\0';
    errno = 0;
    char *end = NULL;
    long long v = strtoll(num, &end, 10);
    if (end == num || *end != '\0' || errno == ERANGE) return 0;
    *out = v;
    return 1;
}
/* F-02：grant_epoch 严格无符号解析（规范 §2.1）。值切片须为最短十进制
 * 无符号整数：全数字、无符号位、无前导零（"0" 本身除外）、无空格／
 * 小数／指数／尾随字符；数值须 ≤ 9007199254740991（2^53-1，JS 安全
 * 整数界，两端同一上限，规范串十进制表示逐字节一致）。前导零与
 * 尾随字符已由 json_find_member 的严格 JSON 数字文法先拦一道，
 * 此处再显式校验（双保险）。strtoll 溢出即失败，不得钳制。 */
static int json_uint53_from_slice(const char *val, size_t vlen, long long *out) {
    if (!val || !out || vlen < 1 || vlen > 16) return 0;
    if (vlen > 1 && val[0] == '0') return 0; /* 前导零 */
    for (size_t i = 0; i < vlen; i++) {
        if (val[i] < '0' || val[i] > '9') return 0;
    }
    char num[32];
    memcpy(num, val, vlen);
    num[vlen] = '\0';
    errno = 0;
    char *end = NULL;
    long long v = strtoll(num, &end, 10);
    if (end == num || *end != '\0' || errno == ERANGE) return 0;
    if (v < 0 || v > 9007199254740991LL) return 0;
    *out = v;
    return 1;
}
/* 取整数成员：值须为 JSON 整数（-?[0-9]+，无小数／指数），strtoll 溢出即失败。
 * 返回 1=成功，0=失败（缺失／类型错／溢出）。 */
static int ticket_get_long(const char *text, const char *key, long long *out) {
    const char *val = NULL;
    size_t vlen = 0;
    int r = json_find_member(text, key, &val, &vlen);
    if (r != 1) return 0;
    return json_long_from_slice(val, vlen, out);
}

int lea_parse_ticket(const char *text, lea_ticket_t *out) {
    if (!text || !out) return 0;
    lea_ticket_t t;
    memset(&t, 0, sizeof(t));
    if (!ticket_get_string(text, "account_id", t.account_id, sizeof(t.account_id), 1) ||
        !lea_validate_id_field(t.account_id)) return 0;
    if (!ticket_get_string(text, "device_id", t.device_id, sizeof(t.device_id), 1) ||
        !lea_validate_id_field(t.device_id)) return 0;
    if (!ticket_get_long(text, "binding_epoch", &t.binding_epoch) ||
        !ticket_get_long(text, "grant_epoch", &t.grant_epoch) ||
        !ticket_get_long(text, "expires_at", &t.expires_at)) return 0;
    /* grant：整数原值保留（long long，入串时由 lea_ticket_canonical()
     * 拒绝非 0/1）；布尔只在解析层接受 true/false → 1/0；缺失即拒绝。 */
    if (!ticket_get_long(text, "grant_muse_execute", &t.grant_muse_execute)) {
        const char *val = NULL;
        size_t vlen = 0;
        int r = json_find_member(text, "grant_muse_execute", &val, &vlen);
        if (r != 1) return 0;
        if (vlen == 4 && memcmp(val, "true", 4) == 0) t.grant_muse_execute = 1;
        else if (vlen == 5 && memcmp(val, "false", 5) == 0) t.grant_muse_execute = 0;
        else return 0;
    }
    /* scopes：字段存在时须为字符串且合 §3.1 格式；缺失时按空串。 */
    if (!ticket_get_string(text, "scopes", t.scopes, sizeof(t.scopes), 0) ||
        !lea_validate_scopes_str(t.scopes)) return 0;
    /* lease_id：存在时须为字符串，非空时合 id 规则；缺失时按空串。 */
    if (!ticket_get_string(text, "lease_id", t.lease_id, sizeof(t.lease_id), 0)) return 0;
    if (t.lease_id[0] && !lea_validate_id_field(t.lease_id)) return 0;
    if (!ticket_get_string(text, "ticket_signature", t.signature, sizeof(t.signature), 1) ||
        t.signature[0] == '\0') return 0;
    *out = t;
    return 1;
}

/* 严格 JSON 校验（RFC 8259 子集）：对象／数组／字符串／严格数字／
 * true／false／null；键须为字符串；无尾随逗号、无非法转义、无多余尾巴。
 * 深度上限 64 防栈溢出。只做花括号配平不算校验（"{a:1}" 须被拒绝）。 */
static const char *json_skip_ws(const char *p) {
    while (*p == ' ' || *p == '\t' || *p == '\n' || *p == '\r') p++;
    return p;
}
static int json_is_hex4(const char *p) {
    for (int i = 0; i < 4; i++) {
        char c = p[i];
        if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F'))) return 0;
    }
    return 1;
}
/* 解析一个 JSON 字符串（p 指向开引号），成功返回尾后指针，否则 NULL。 */
static const char *json_parse_string(const char *p) {
    if (*p != '"') return NULL;
    p++;
    while (*p) {
        unsigned char c = (unsigned char)*p;
        if (c == '"') return p + 1;
        if (c < 0x20) return NULL;
        if (c == '\\') {
            p++;
            char e = *p;
            if (e == '"' || e == '\\' || e == '/' || e == 'b' || e == 'f' ||
                e == 'n' || e == 'r' || e == 't') { p++; continue; }
            if (e == 'u') {
                if (!json_is_hex4(p + 1)) return NULL;
                unsigned long cp = strtoul((char[]){p[1],p[2],p[3],p[4],0}, NULL, 16);
                p += 5;
                if (cp >= 0xD800 && cp <= 0xDBFF) {
                    if (p[0] != '\\' || p[1] != 'u' || !json_is_hex4(p + 2)) return NULL;
                    unsigned long lo = strtoul((char[]){p[2],p[3],p[4],p[5],0}, NULL, 16);
                    if (lo < 0xDC00 || lo > 0xDFFF) return NULL;
                    p += 6;
                } else if (cp >= 0xDC00 && cp <= 0xDFFF) return NULL;
                continue;
            }
            return NULL;
        }
        if (c >= 0x80) {
            size_t width = json_utf8_sequence((const unsigned char *)p);
            if (!width) return NULL;
            p += width;
        } else p++;
    }
    return NULL;
}
/* 严格 JSON 数字：-?(0|[1-9][0-9]*)(.[0-9]+)?([eE][+-]?[0-9]+)? */
static const char *json_parse_number(const char *p) {
    if (*p == '-') p++;
    if (*p == '0') p++;
    else if (*p >= '1' && *p <= '9') { while (*p >= '0' && *p <= '9') p++; }
    else return NULL;
    if (*p == '.') {
        p++;
        if (!(*p >= '0' && *p <= '9')) return NULL;
        while (*p >= '0' && *p <= '9') p++;
    }
    if (*p == 'e' || *p == 'E') {
        p++;
        if (*p == '+' || *p == '-') p++;
        if (!(*p >= '0' && *p <= '9')) return NULL;
        while (*p >= '0' && *p <= '9') p++;
    }
    return p;
}
static const char *json_parse_value(const char *p, int depth);
static const char *json_parse_object(const char *p, int depth) {
    if (depth > 64) return NULL;
    if (*p != '{') return NULL;
    p = json_skip_ws(p + 1);
    if (*p == '}') return p + 1;
    for (;;) {
        p = json_skip_ws(p);
        const char *after_key = json_parse_string(p);
        if (!after_key) return NULL;
        p = json_skip_ws(after_key);
        if (*p != ':') return NULL;
        p = json_parse_value(json_skip_ws(p + 1), depth + 1);
        if (!p) return NULL;
        p = json_skip_ws(p);
        if (*p == ',') { p++; continue; }
        if (*p == '}') return p + 1;
        return NULL;
    }
}
static const char *json_parse_array(const char *p, int depth) {
    if (depth > 64) return NULL;
    if (*p != '[') return NULL;
    p = json_skip_ws(p + 1);
    if (*p == ']') return p + 1;
    for (;;) {
        p = json_parse_value(json_skip_ws(p), depth + 1);
        if (!p) return NULL;
        p = json_skip_ws(p);
        if (*p == ',') { p++; continue; }
        if (*p == ']') return p + 1;
        return NULL;
    }
}
static const char *json_parse_value(const char *p, int depth) {
    if (depth > 64) return NULL;
    p = json_skip_ws(p);
    if (*p == '{') return json_parse_object(p, depth);
    if (*p == '[') return json_parse_array(p, depth);
    if (*p == '"') return json_parse_string(p);
    if (*p == '-' || (*p >= '0' && *p <= '9')) return json_parse_number(p);
    if (strncmp(p, "true", 4) == 0) return p + 4;
    if (strncmp(p, "false", 5) == 0) return p + 5;
    if (strncmp(p, "null", 4) == 0) return p + 4;
    return NULL;
}
/* params_raw 须为严格 JSON 对象。解析层已保证此点（lea_json_object_raw）；
 * 此处防未来调用方误传非法原文（如 "{a:1}" 花括号配平但键不是字符串）。 */
static int params_raw_wellformed(const char *s) {
    if (!s) return 0;
    const char *p = json_parse_object(json_skip_ws(s), 0);
    if (!p) return 0;
    p = json_skip_ws(p);
    return *p == '\0';
}

/* 严格 JSON 值校验（H09：幂等快照写盘前校验行合法性）。 */
int lea_json_is_valid(const char *s) {
    if (!s) return 0;
    const char *p = json_parse_value(json_skip_ws(s), 0);
    if (!p) return 0;
    p = json_skip_ws(p);
    return *p == '\0';
}

/* 重建信封行（pkg1 #25）：全部字符串字段经 JSON 转义后拼接，%s 直拼禁止；
 * params_raw 原文 verbatim 拼接（签名覆盖同一份字节）。 */
int lea_rebuild_envelope(const lea_envelope_t *env, char *out, size_t out_size) {
    if (!env || !out || out_size < 512) return 0;
    if (!params_raw_wellformed(env->params_raw[0] ? env->params_raw : "{}")) return 0;
    size_t off = 0;
#define LEA_RB_APPEND(...) do { \
        if (off >= out_size) return 0; \
        int _n = snprintf(out + off, out_size - off, __VA_ARGS__); \
        if (_n < 0) return 0; \
        off += (size_t)_n; \
        if (off >= out_size) return 0; \
    } while (0)
#define LEA_RB_STR(s) do { \
        if (!lea_json_escape_into(out, out_size, &off, (s) ? (s) : "")) return 0; \
    } while (0)
    LEA_RB_APPEND("{\"version\":%d,\"request_id\":\"", env->version);
    LEA_RB_STR(env->request_id);
    LEA_RB_APPEND("\",\"batch_id\":\"");
    LEA_RB_STR(env->batch_id);
    LEA_RB_APPEND("\",\"seq\":%lld,\"device_id\":\"", env->seq);
    LEA_RB_STR(env->device_id);
    LEA_RB_APPEND("\",\"account_id\":\"");
    LEA_RB_STR(env->account_id);
    LEA_RB_APPEND("\",\"api_key_id\":\"");
    LEA_RB_STR(env->api_key_id);
    LEA_RB_APPEND("\",\"binding_epoch\":%lld,\"grant_epoch\":%lld,\"nonce\":\"",
                  env->binding_epoch, env->grant_epoch);
    LEA_RB_STR(env->nonce);
    LEA_RB_APPEND("\",\"issued_at\":%lld,\"expires_at\":%lld,\"idempotency_key\":\"",
                  env->issued_at, env->expires_at);
    LEA_RB_STR(env->idempotency_key);
    LEA_RB_APPEND("\",\"command\":\"");
    LEA_RB_STR(env->command);
    LEA_RB_APPEND("\",\"params\":%s,\"timeout_ms\":%lld,\"signature\":\"",
                  env->params_raw[0] ? env->params_raw : "{}",
                  env->has_timeout ? env->timeout_ms : lea_effective_timeout_ms(env));
    LEA_RB_STR(env->signature);
    LEA_RB_APPEND("\"}");
#undef LEA_RB_APPEND
#undef LEA_RB_STR
    return 1;
}

/* ---------------- 时间窗 ---------------- */
/* #20：DESIGN §4.1 定的是 TTL 60s（expires_at - issued_at ≤ 60s）＋时钟
 * 偏差 ±30s，两者是不同量：TTL 管“签发后多久内可接收”，偏差管“两端
 * 时钟差”。旧实现另卡 now - issued_at ≤ +30s，把两者混成一回事，
 * 有效接收窗只剩 30s——服务端按 ENVELOPE_TTL_S=60 签发（lea-core.js），
 * 签发 31~60s 后到达的合法信封全被拒。修法：只容“未来签发”（issued_at
 * 超前 now >30s 即拒，防服务端时钟超前伪造）；过期仍以 expires_at
 * 为准、另容 +30s 偏差。接收窗恢复为 TTL 60s（＋过期容限）。 */
int lea_check_time_window(const lea_envelope_t *env, long long now_unix,
                          char *err, size_t err_size) {
    if (env->expires_at <= env->issued_at ||
        env->expires_at - env->issued_at > LEA_MAX_ENVELOPE_TTL_SEC) {
        if (err) snprintf(err, err_size, "%s", LEA_ERR_REPLAY);
        return 0;
    }
    if (now_unix < env->issued_at - LEA_MAX_CLOCK_SKEW_SEC) {
        if (err) snprintf(err, err_size, "%s", LEA_ERR_REPLAY);
        return 0;
    }
    if (now_unix > env->expires_at + LEA_MAX_CLOCK_SKEW_SEC) {
        if (err) snprintf(err, err_size, "%s", LEA_ERR_REPLAY);
        return 0;
    }
    return 1;
}

/* F-02：信封顶层键白名单普查（未知字段／重复字段一律拒绝）。
 * json_find_member 只查找指定键，未知键会被静默忽略；此处在解析前
 * 对顶层对象做一次完整遍历：键须在白名单内且恰好出现一次，值须为
 * 合法 JSON 值，对象闭合后不得有尾部内容。键按解码后比较（含转义键
 * "vers\u0069on" 解码后即 "version"，与 json_find_member 同语义）。
 * 白名单＝服务端 buildEnvelope 发出的 20 个字段＋trace_id（服务端
 * 不签发、设备端只接收）。 */
static int envelope_top_level_keys_ok(const char *text) {
    static const char *allowed[] = {
        "version", "request_id", "batch_id", "seq", "device_id",
        "account_id", "api_key_id", "binding_epoch", "grant_epoch",
        "nonce", "issued_at", "expires_at", "idempotency_key",
        "command", "params", "timeout_ms", "job_id", "mode",
        "deadline_ms", "signature", "trace_id",
    };
    const int n_allowed = (int)(sizeof(allowed) / sizeof(allowed[0]));
    char seen[21][32];
    int n_seen = 0;
    const char *p = json_skip_ws(text);
    if (*p != '{') return 0;
    p = json_skip_ws(p + 1);
    if (*p == '}') {
        p = json_skip_ws(p + 1);
        return *p == '\0';
    }
    for (;;) {
        p = json_skip_ws(p);
        if (*p != '"') return 0;
        const char *after_key = json_parse_string(p);
        if (!after_key) return 0;
        char kbuf[128];
        size_t klen = 0;
        if (!json_decode_string(p, kbuf, sizeof(kbuf), &klen)) return 0;
        int known = 0;
        for (int i = 0; i < n_allowed; i++) {
            if (klen == strlen(allowed[i]) && memcmp(kbuf, allowed[i], klen) == 0) {
                known = 1;
                break;
            }
        }
        if (!known) return 0;
        for (int i = 0; i < n_seen; i++) {
            if (strcmp(seen[i], kbuf) == 0) return 0; /* 重复键 */
        }
        if (n_seen >= 21 || klen >= sizeof(seen[0])) return 0;
        memcpy(seen[n_seen], kbuf, klen);
        seen[n_seen][klen] = '\0';
        n_seen++;
        p = json_skip_ws(after_key);
        if (*p != ':') return 0;
        const char *vend = json_parse_value(json_skip_ws(p + 1), 0);
        if (!vend) return 0;
        p = json_skip_ws(vend);
        if (*p == ',') { p++; continue; }
        if (*p == '}') {
            p = json_skip_ws(p + 1);
            return *p == '\0';
        }
        return 0;
    }
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
    /* F-02：顶层未知字段／重复字段／尾部垃圾一律拒绝（普查先行）。 */
    if (!envelope_top_level_keys_ok(text)) {
        set_err(out, LEA_ERR_BAD_ENVELOPE, "unknown-or-duplicate-field");
        return 0;
    }
    long long v = 0;
    /* F-02：v2-only。整数字段一律用严格顶层解析（json_find_member 全
     * 量遍历：重复键／嵌套同名键／尾部字符／溢出即拒），不用全文子串
     * 查找（lea_json_long／lea_json_string 会命中 params 内嵌套值）。 */
    if (lea_json_top_level_long(text, "version", &v) != 1 || v != LEA_PROTOCOL_VERSION) {
        set_err(out, LEA_ERR_BAD_ENVELOPE, "version");
        return 0;
    }
    out->version = (int)v;
    if (!lea_json_top_level_string(text, "request_id", out->request_id, sizeof(out->request_id)) ||
        !lea_validate_token(out->request_id)) {
        set_err(out, LEA_ERR_BAD_ENVELOPE, "request_id");
        return 0;
    }
    /* batch_id 可选；seq 必填且 ≥1（v2 语义：单条为 1、批量单调递增；
     * 缺失或 0 即拒绝，不得缺省为 0 后签名／验签）。batch_id 显式出现
     * 但非字符串即拒绝，不得当缺失静默放过；空串沿用旧义（等同缺失）。 */
    {
        const char *bval = NULL;
        size_t bvlen = 0;
        int br = json_find_member(text, "batch_id", &bval, &bvlen);
        if (br < 0) {
            set_err(out, LEA_ERR_BAD_ENVELOPE, "batch_id");
            return 0;
        }
        if (br == 1) {
            if (!lea_json_top_level_string(text, "batch_id", out->batch_id, sizeof(out->batch_id))) {
                set_err(out, LEA_ERR_BAD_ENVELOPE, "batch_id");
                return 0;
            }
            if (out->batch_id[0] && !lea_validate_id_field(out->batch_id)) {
                set_err(out, LEA_ERR_BAD_ENVELOPE, "batch_id");
                return 0;
            }
        }
    }
    long long seq = 0;
    if (lea_json_top_level_long(text, "seq", &seq) != 1 || seq < 1) {
        set_err(out, LEA_ERR_BAD_ENVELOPE, "seq");
        return 0;
    }
    out->seq = seq;
    if (!lea_json_top_level_string(text, "device_id", out->device_id, sizeof(out->device_id)) ||
        out->device_id[0] == '\0' || !lea_validate_id_field(out->device_id)) {
        set_err(out, LEA_ERR_BAD_ENVELOPE, "device_id");
        return 0;
    }
    if (!lea_json_top_level_string(text, "account_id", out->account_id, sizeof(out->account_id)) ||
        out->account_id[0] == '\0' || !lea_validate_id_field(out->account_id)) {
        set_err(out, LEA_ERR_BAD_ENVELOPE, "account_id");
        return 0;
    }
    if (!lea_json_top_level_string(text, "api_key_id", out->api_key_id, sizeof(out->api_key_id)) ||
        out->api_key_id[0] == '\0' || !lea_validate_id_field(out->api_key_id)) {
        set_err(out, LEA_ERR_BAD_ENVELOPE, "api_key_id");
        return 0;
    }
    if (lea_json_top_level_long(text, "binding_epoch", &out->binding_epoch) != 1) {
        set_err(out, LEA_ERR_BAD_ENVELOPE, "binding_epoch");
        return 0;
    }
    /* F-02：grant_epoch 必填、无符号整数（0..2^53-1，最短十进制、
     * 无前导零、无符号位、无空格／小数／尾随字符）。缺失／非法／
     * 超界一律拒绝，不得缺省为 0 后签名／验签。 */
    {
        const char *gval = NULL;
        size_t gvlen = 0;
        int gr = json_find_member(text, "grant_epoch", &gval, &gvlen);
        if (gr != 1 || !json_uint53_from_slice(gval, gvlen, &out->grant_epoch)) {
            set_err(out, LEA_ERR_BAD_ENVELOPE, "grant_epoch");
            return 0;
        }
    }
    if (!lea_json_top_level_string(text, "nonce", out->nonce, sizeof(out->nonce)) ||
        !lea_validate_token(out->nonce)) {
        set_err(out, LEA_ERR_BAD_ENVELOPE, "nonce");
        return 0;
    }
    if (lea_json_top_level_long(text, "issued_at", &out->issued_at) != 1 ||
        lea_json_top_level_long(text, "expires_at", &out->expires_at) != 1) {
        set_err(out, LEA_ERR_BAD_ENVELOPE, "issued_at/expires_at");
        return 0;
    }
    char tw_err[64] = { 0 };
    if (!lea_check_time_window(out, now_unix, tw_err, sizeof(tw_err))) {
        set_err(out, tw_err, "time-window");
        return 0;
    }
    if (!lea_json_top_level_string(text, "idempotency_key", out->idempotency_key,
                         sizeof(out->idempotency_key)) ||
        !lea_validate_token(out->idempotency_key)) {
        set_err(out, LEA_ERR_BAD_ENVELOPE, "idempotency_key");
        return 0;
    }
    if (!lea_json_top_level_string(text, "command", out->command, sizeof(out->command)) ||
        !lea_command_spec(out->command)) {
        set_err(out, LEA_ERR_BAD_ENVELOPE, "command");
        return 0;
    }
    /* #22：区分“params 缺失”和“params 超长／非法”。缺失时视为空对象
     * （sys.info 等无参命令）；字段存在但取不出对象原文（超 LEA_MAX_PARAMS
     * 32768、非对象、JSON 残缺）即明确拒绝，绝不再静默置 {} 后改义执行。
     * json_find_member 返回 -1（重复键／对象语法错／尾部多余内容）同样拒绝。 */
    {
        const char *pval = NULL;
        size_t pvlen = 0;
        int pr = json_find_member(text, "params", &pval, &pvlen);
        if (pr < 0) {
            set_err(out, LEA_ERR_BAD_ENVELOPE, "params");
            return 0;
        }
        if (pr == 0) {
            snprintf(out->params_raw, sizeof(out->params_raw), "{}");
        } else if (!lea_json_object_raw(text, "params", out->params_raw, sizeof(out->params_raw))) {
            set_err(out, LEA_ERR_BAD_ENVELOPE, "params-oversize-or-invalid");
            return 0;
        }
    }
    long long tmo = 0;
    {
        /* timeout_ms 显式存在性判定（键存在性，非 lea_json_long 成败）：
         * 显式存在但非整数（含 null／字符串／小数／溢出）即拒绝，不得当
         * 缺失回退默认值；缺失时取命令默认值。 */
        const char *tval = NULL;
        size_t tvlen = 0;
        int tr = json_find_member(text, "timeout_ms", &tval, &tvlen);
        if (tr < 0) {
            set_err(out, LEA_ERR_BAD_ENVELOPE, "timeout_ms");
            return 0;
        }
        if (tr == 1) {
            /* 须用 json_find_member 返回的顶层值切片（tval/tvlen）解析，
             * 不得再用全文子串查找（lea_json_long）重取——params 内的嵌套
             * "timeout_ms" 会遮蔽顶层 null，使显式非法值被洗成已签名值。 */
            if (!json_long_from_slice(tval, tvlen, &tmo)) {
                set_err(out, LEA_ERR_BAD_ENVELOPE, "timeout_ms");
                return 0;
            }
            out->timeout_ms = tmo;
            out->has_timeout = 1;
            const lea_command_spec_t *spec = lea_command_spec(out->command);
            if (tmo < 1 || tmo > spec->max_timeout_ms) {
                set_err(out, LEA_ERR_BAD_ENVELOPE, "timeout_ms");
                return 0;
            }
        }
    }
    /* B1 信封新字段（全部可选；老版本不发即缺省，老版本收到新字段时
     * 按未知键忽略——本解析只按已知键查找，不拒未知字段，故双向兼容。
     * job_id 非法／mode 非法／deadline_ms 越界即整单拒绝，不静默回退。 */
    out->job_id[0] = '\0';
    out->mode[0] = '\0';
    out->deadline_ms = 0;
    out->has_deadline = 0;
    {
        const char *jval = NULL;
        size_t jvlen = 0;
        int jr = json_find_member(text, "job_id", &jval, &jvlen);
        if (jr < 0) {
            set_err(out, LEA_ERR_BAD_ENVELOPE, "job_id");
            return 0;
        }
        if (jr == 1) {
            char jid[64] = { 0 };
            if (!lea_json_top_level_string(text, "job_id", jid, sizeof(jid)) ||
                !lea_validate_token(jid)) {
                set_err(out, LEA_ERR_BAD_ENVELOPE, "job_id");
                return 0;
            }
            snprintf(out->job_id, sizeof(out->job_id), "%s", jid);
        }
        const char *mval = NULL;
        size_t mvlen = 0;
        int mr = json_find_member(text, "mode", &mval, &mvlen);
        if (mr < 0) {
            set_err(out, LEA_ERR_BAD_ENVELOPE, "mode");
            return 0;
        }
        if (mr == 1) {
            char md[16] = { 0 };
            if (!lea_json_top_level_string(text, "mode", md, sizeof(md)) ||
                (strcmp(md, "sync") != 0 && strcmp(md, "async") != 0)) {
                set_err(out, LEA_ERR_BAD_ENVELOPE, "mode");
                return 0;
            }
            snprintf(out->mode, sizeof(out->mode), "%s", md);
        }
        const char *dval = NULL;
        size_t dvlen = 0;
        int dr = json_find_member(text, "deadline_ms", &dval, &dvlen);
        if (dr < 0) {
            set_err(out, LEA_ERR_BAD_ENVELOPE, "deadline_ms");
            return 0;
        }
        if (dr == 1) {
            long long dl = 0;
            if (!json_long_from_slice(dval, dvlen, &dl) || dl < 1 || dl > 120000) {
                set_err(out, LEA_ERR_BAD_ENVELOPE, "deadline_ms");
                return 0;
            }
            out->deadline_ms = dl;
            out->has_deadline = 1;
        }
    }
    if (!lea_json_top_level_string(text, "signature", out->signature, sizeof(out->signature)) ||
        out->signature[0] == '\0') {
        set_err(out, LEA_ERR_BAD_ENVELOPE, "signature");
        return 0;
    }
    lea_json_top_level_string(text, "trace_id", out->trace_id, sizeof(out->trace_id));
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
 * 保留盘符前缀（C:）与开头的 \\（UNC）。输出用输入的主导分隔符。
 * 所有权（N-01 修复，2026-11-15）：段数组 segs[] 只由函数末尾的单
 * 一 cleanup 出口释放，拼接循环内绝不 free；任何失败路径都走
 * fail:，不再有裸 return 0。拼接前先算清所需输出长度，超
 * out_size 直接拒绝，不进入部分拼接。 */
int lea_normalize_path(const char *path, char *out, size_t out_size) {
    if (!path || !out || out_size < 4 || path[0] == '\0') return 0;
    int use_backslash = strchr(path, '\\') != NULL;
    char sep = use_backslash ? '\\' : '/';
    /* 分段 */
    char tmp[1024];
    if (strlen(path) >= sizeof(tmp)) return 0; /* 入参上限：tmp 含 NUL */
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
    int ok = 0;
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
            if (nseg == 0) goto fail; /* 越界 */
            /* 弹出段时一并释放（旧代码只 nseg--，每 ".." 漏一次 malloc）。 */
            free(segs[--nseg]);
            segs[nseg] = NULL;
            continue;
        }
        if (nseg >= 128) goto fail; /* 段数上限，直接拒绝 */
        char *s = (char *)malloc(slen + 1);
        if (!s) goto fail;
        memcpy(s, start, slen);
        s[slen] = '\0';
        segs[nseg++] = s;
    }
    /* 拼接前先算清所需输出长度（含 NUL），超 out_size 直接拒绝，不
     * 进入部分拼接（fail-closed）。输出 = 前缀＋每段前一个分隔符
     * （当前末字符已是分隔符时不加）＋段本身。 */
    {
        size_t need = strlen(prefix);
        for (int i = 0; i < nseg; i++) {
            if (need > 0) {
                char last = (i == 0) ? prefix[need - 1]
                                     : segs[i - 1][strlen(segs[i - 1]) - 1];
                if (last != sep) need += 1;
            }
            need += strlen(segs[i]);
        }
        if (need + 1 > out_size) goto fail;
    }
    if (nseg == 0 && prefix[0] == '\0') goto fail; /* 空路径 */
    {
        size_t off = 0;
        off += (size_t)snprintf(out + off, out_size - off, "%s", prefix);
        for (int i = 0; i < nseg; i++) {
            if (off > 0 && out[off - 1] != sep) {
                out[off++] = sep;
                out[off] = '\0';
            }
            size_t l = strlen(segs[i]);
            memcpy(out + off, segs[i], l);
            off += l;
            out[off] = '\0';
        }
    }
    ok = 1;
fail:
    for (int i = 0; i < nseg; i++) {
        free(segs[i]);
        segs[i] = NULL;
    }
    if (!ok) out[0] = '\0'; /* 失败不留部分输出 */
    return ok;
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
    /* #18 同根：off 已到顶时直接失败——空串也会走到末尾 buf[o]='\0'，
     * off >= buf_size 即越界写 1 字节。调用方须保证 off < buf_size，
     * 此处是最后一道防线。 */
    if (*off >= buf_size) return 0;
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

int lea_json_insert_string_field(const char *line, const char *key, const char *value,
                                 char *out, size_t out_size) {
    if (!line || !key || !value || !out || out_size < 8) return 0;
    if (key[0] == '\0') return 0;
    size_t len = strlen(line);
    /* 去掉行尾空白，找到最后一个 '}'；须为单行 JSON 对象。 */
    while (len > 0 && (line[len - 1] == ' ' || line[len - 1] == '\t' ||
                       line[len - 1] == '\n' || line[len - 1] == '\r'))
        len--;
    if (len < 2 || line[0] != '{' || line[len - 1] != '}' || !lea_json_is_valid(line)) return 0;
    const char *existing = NULL;
    size_t existing_len = 0;
    if (json_find_member(line, key, &existing, &existing_len) != 0) return 0;
    int empty = *json_skip_ws(line + 1) == '}';
    /* 先算转义后长度：key 与 value 都须完整放下。 */
    char esc_key[256], esc_val[4096];
    size_t ko = 0, vo = 0;
    if (!lea_json_escape_into(esc_key, sizeof(esc_key), &ko, key)) return 0;
    if (!lea_json_escape_into(esc_val, sizeof(esc_val), &vo, value)) return 0;
    /* 需要：原串(去尾空白后，去掉 '}') + ',"k":"v"}' + '\0'。 */
    size_t need = (len - 1) + ko + vo + 8;
    if (need > out_size) return 0;
    memcpy(out, line, len - 1);
    size_t off = len - 1;
    /* DS 第三轮 #2：snprintf 返回值防御性校验——need 预留已排除截断
     * （需 ko+vo+7，留了 8），此处只是多一道防线，永不触发也须正确。 */
    int w = snprintf(out + off, out_size - off, "%s\"%s\":\"%s\"}", empty ? "" : ",", esc_key, esc_val);
    if (w < 0 || (size_t)w >= out_size - off) return 0;
    off += (size_t)w;
    out[off] = '\0';
    return 1;
}

/* H07 契约：session.login_changed 的 result 字段格式。C 端与 main.js
 * 钩子的约定：main.js 从 result.binding_epoch 取 epoch 去调服务端
 * rebind；格式一旦变了钩子就空转。故抽成纯函数并由单测锁死格式，
 * QFRLEA.c 的 login_changed 分支直接调它，不再内联 snprintf。 */
int lea_binding_login_result(long long epoch, char *out, size_t out_size) {
    if (!out || out_size == 0) return 0;
    int n = snprintf(out, out_size,
                     "{\"binding_state\":\"PENDING\",\"binding_epoch\":%lld}",
                     epoch);
    return (n > 0 && (size_t)n < out_size) ? 1 : 0;
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
