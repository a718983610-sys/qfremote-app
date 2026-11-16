/* 见 lea_local.h（S-021）。纯 C：只用 stdio/stdlib/string/time，
 * 不含 windows.h，Linux 单测与 mingw 交叉编译共用。 */
#include "lea_local.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#ifdef _WIN32
#include <direct.h>
#define LEA_MKDIR(p) _mkdir(p)
#else
#include <sys/stat.h>
#include <sys/types.h>
#define LEA_MKDIR(p) mkdir(p, 0700)
#endif

void lea_local_status_init(lea_local_status_t *s) {
    if (!s) return;
    memset(s, 0, sizeof(*s));
}

int lea_local_base_dir(const char *base_dir, char *out, size_t out_size) {
    if (!out || out_size == 0) return 0;
    out[0] = '\0';
    if (base_dir && base_dir[0]) {
        if (strlen(base_dir) >= out_size) return 0;
        strcpy(out, base_dir);
        return 1;
    }
#ifdef _WIN32
    {
        const char *pd = getenv("ProgramData");
        if (!pd || !pd[0]) return 0;
        if (snprintf(out, out_size, "%s\\QFR\\LEA", pd) < 0 ||
            strlen(pd) + strlen("\\QFR\\LEA") >= out_size) return 0;
        return 1;
    }
#else
    {
        const char *d = getenv("LEA_LOCAL_DIR");
        if (!d || !d[0]) return 0;
        if (strlen(d) >= out_size) return 0;
        strcpy(out, d);
        return 1;
    }
#endif
}

/* ---------- 小工具 ---------- */

static int join_path(const char *base, const char *name, char *out, size_t out_size) {
    if (!base || !base[0] || !name || !out || out_size == 0) return 0;
#ifdef _WIN32
    if (snprintf(out, out_size, "%s\\%s", base, name) < 0) return 0;
#else
    if (snprintf(out, out_size, "%s/%s", base, name) < 0) return 0;
#endif
    return strlen(out) < out_size;
}

static int file_exists(const char *path) {
    FILE *f = fopen(path, "rb");
    if (!f) return 0;
    fclose(f);
    return 1;
}

/* 建目录（mkdir -p：CLI 可能在服务未启动、目录尚不存在时运行，
 * 如全新安装后第一次 --pause；写操作前调用，失败即写失败）。 */
static int ensure_dir(const char *dir) {
    if (!dir || !dir[0]) return 0;
    char tmp[1024];
    if (strlen(dir) >= sizeof(tmp)) return 0;
    strcpy(tmp, dir);
    size_t len = strlen(tmp);
    while (len > 0 && (tmp[len - 1] == '\\' || tmp[len - 1] == '/')) tmp[--len] = '\0';
    for (char *p = tmp + 1; *p; p++) {
        if (*p == '\\' || *p == '/') {
            char save = *p;
            *p = '\0';
            /* 跳过盘符前缀（C:）与 UNC 前缀。 */
            if (!(p == tmp + 2 && tmp[1] == ':')) LEA_MKDIR(tmp);
            *p = save;
        }
    }
    LEA_MKDIR(tmp);
    /* 目录已存在即成功：用 fopen 探针验证可写性太重，改为检查
     * 目录能否打开（opendir 不可移植，此处用临时文件探针替代：
     * 直接返回 1，真正失败由后续 atomic_write 的 fopen 报错）。 */
    return 1;
}

static long long read_marker_at(const char *path) {
    /* 标记文件内容为 unix 秒（文本一行）；读不到／格式不对返回 -1，
     * 调用方按“在位但时刻未知”处理（at 留 0）。 */
    FILE *f = fopen(path, "rb");
    if (!f) return -1;
    char buf[64] = { 0 };
    size_t n = fread(buf, 1, sizeof(buf) - 1, f);
    fclose(f);
    buf[n] = '\0';
    char *end = NULL;
    long long v = strtoll(buf, &end, 10);
    if (end == buf) return -1;
    return v;
}

/* 原子写：先写 tmp 再 rename（POSIX 下 rename 原子替换；mingw／Wine
 * 下 rename 不覆盖已存在目标，失败时删旧文件再改名——短暂空窗可
 * 接受：本机状态文件，查询缺失即默认态。失败返回 0，原文件不动
 * （第二步 rename 仍失败时 tmp 已删、旧文件已不在，调用方按失败处理）。 */
static int atomic_write(const char *path, const char *data) {
    char tmp[1024];
    if (snprintf(tmp, sizeof(tmp), "%s.tmp", path) < 0 ||
        strlen(path) + strlen(".tmp") >= sizeof(tmp)) return 0;
    FILE *f = fopen(tmp, "wb");
    if (!f) return 0;
    size_t len = strlen(data);
    int ok = (fwrite(data, 1, len, f) == len) && (fclose(f) == 0);
    if (!ok) { fclose(f); remove(tmp); return 0; }
    if (rename(tmp, path) != 0) {
        remove(path);
        if (rename(tmp, path) != 0) { remove(tmp); return 0; }
    }
    return 1;
}

static int read_file(const char *path, char *out, size_t out_size) {
    FILE *f = fopen(path, "rb");
    if (!f) return 0;
    size_t n = fread(out, 1, out_size - 1, f);
    fclose(f);
    out[n] = '\0';
    return 1;
}

/* ---------- JSON 小解析（只认顶层平铺成员；够状态文件用） ---------- */

static const char *find_key_value(const char *json, const char *key) {
    /* 找 "key" : value；只做朴素扫描（状态文件由本模块写出，无嵌套同名键）。 */
    if (!json || !key) return NULL;
    char pat[64];
    if (snprintf(pat, sizeof(pat), "\"%s\"", key) < 0) return NULL;
    const char *p = strstr(json, pat);
    if (!p) return NULL;
    p += strlen(pat);
    while (*p == ' ' || *p == '\t' || *p == '\n' || *p == '\r') p++;
    if (*p != ':') return NULL;
    p++;
    while (*p == ' ' || *p == '\t' || *p == '\n' || *p == '\r') p++;
    return p;
}

static int json_get_string(const char *json, const char *key, char *out, size_t out_size) {
    if (!out || out_size == 0) return 0;
    out[0] = '\0';
    const char *p = find_key_value(json, key);
    if (!p || *p != '"') return 0;
    p++;
    size_t n = 0;
    while (*p && *p != '"') {
        if (*p == '\\' && p[1]) {
            p++;
            char e = *p;
            if (e == 'n') { if (n + 1 >= out_size) return 0; out[n++] = '\n'; }
            else if (e == 'r') { if (n + 1 >= out_size) return 0; out[n++] = '\r'; }
            else if (e == 't') { if (n + 1 >= out_size) return 0; out[n++] = '\t'; }
            else if (e == 'u') {
                /* \uXXXX：只解 BMP 常用区（状态字段不含代理对；超出即按 ? 计）。
                 * 状态文件里的账号／设备名极少含转义，够用即可。 */
                unsigned cp = 0;
                int i;
                for (i = 0; i < 4; i++) {
                    char c = p[1 + i];
                    cp <<= 4;
                    if (c >= '0' && c <= '9') cp |= (unsigned)(c - '0');
                    else if (c >= 'a' && c <= 'f') cp |= (unsigned)(c - 'a' + 10);
                    else if (c >= 'A' && c <= 'F') cp |= (unsigned)(c - 'A' + 10);
                    else return 0;
                }
                p += 4;
                if (cp < 0x80) { if (n + 1 >= out_size) return 0; out[n++] = (char)cp; }
                else if (cp < 0x800) {
                    if (n + 2 >= out_size) return 0;
                    out[n++] = (char)(0xC0 | (cp >> 6));
                    out[n++] = (char)(0x80 | (cp & 0x3F));
                } else {
                    if (n + 3 >= out_size) return 0;
                    out[n++] = (char)(0xE0 | (cp >> 12));
                    out[n++] = (char)(0x80 | ((cp >> 6) & 0x3F));
                    out[n++] = (char)(0x80 | (cp & 0x3F));
                }
            } else {
                if (n + 1 >= out_size) return 0;
                out[n++] = e; /* \" \\ \/ \b \f 等直通 */
            }
            p++;
            continue;
        }
        if (n + 1 >= out_size) return 0;
        out[n++] = *p++;
    }
    if (*p != '"') return 0;
    out[n] = '\0';
    return 1;
}

static int json_get_bool(const char *json, const char *key, int *out) {
    const char *p = find_key_value(json, key);
    if (!p) return 0;
    if (strncmp(p, "true", 4) == 0) { *out = 1; return 1; }
    if (strncmp(p, "false", 5) == 0) { *out = 0; return 1; }
    return 0;
}

static int json_get_llong(const char *json, const char *key, long long *out) {
    const char *p = find_key_value(json, key);
    if (!p) return 0;
    char *end = NULL;
    long long v = strtoll(p, &end, 10);
    if (end == p) return 0;
    *out = v;
    return 1;
}

/* JSON 转义后追加（不含外层引号）；空间不足返回 0。 */
static int json_escape_into(char *buf, size_t buf_size, size_t *off, const char *s) {
    size_t o = *off;
    if (!s) s = "";
    for (const unsigned char *p = (const unsigned char *)s; *p; p++) {
        const char *esc = NULL;
        char tmp[8] = { 0 };
        if (*p == '"') esc = "\\\"";
        else if (*p == '\\') esc = "\\\\";
        else if (*p == '\n') esc = "\\n";
        else if (*p == '\r') esc = "\\r";
        else if (*p == '\t') esc = "\\t";
        else if (*p < 0x20) { snprintf(tmp, sizeof(tmp), "\\u%04x", *p); esc = tmp; }
        if (esc) {
            size_t el = strlen(esc);
            if (o + el + 1 > buf_size) return 0;
            memcpy(buf + o, esc, el);
            o += el;
        } else {
            if (o + 2 > buf_size) return 0;
            buf[o++] = (char)*p;
        }
    }
    buf[o] = '\0';
    *off = o;
    return 1;
}

/* ---------- 暂停／授权／撤销 ---------- */

int lea_local_is_paused(const char *base_dir) {
    char base[1024], path[1100];
    if (!lea_local_base_dir(base_dir, base, sizeof(base))) return 0;
    if (!join_path(base, "lea-paused", path, sizeof(path))) return 0;
    return file_exists(path);
}

int lea_local_set_paused(const char *base_dir, int paused) {
    char base[1024], path[1100];
    if (!lea_local_base_dir(base_dir, base, sizeof(base))) return 0;
    if (!join_path(base, "lea-paused", path, sizeof(path))) return 0;
    if (!paused) {
        remove(path);
        return !file_exists(path);
    }
    ensure_dir(base); /* CLI 可能先于服务运行，目录尚不存在 */
    char data[32];
    snprintf(data, sizeof(data), "%lld\n", (long long)time(NULL));
    return atomic_write(path, data);
}

int lea_local_has_dangerous_consent(const char *base_dir) {
    char base[1024], path[1100], buf[256];
    if (!lea_local_base_dir(base_dir, base, sizeof(base))) return 0;
    if (!join_path(base, "dangerous-consent.json", path, sizeof(path))) return 0;
    if (!read_file(path, buf, sizeof(buf))) return 0;
    int v = 0;
    if (!json_get_bool(buf, "consented", &v)) return 0;
    return v == 1;
}

int lea_local_set_dangerous_consent(const char *base_dir, int consented) {
    char base[1024], path[1100], data[128];
    if (!lea_local_base_dir(base_dir, base, sizeof(base))) return 0;
    if (!join_path(base, "dangerous-consent.json", path, sizeof(path))) return 0;
    ensure_dir(base); /* CLI 可能先于服务运行，目录尚不存在 */
    snprintf(data, sizeof(data), "{\"consented\":%s,\"at\":%lld}",
             consented ? "true" : "false", (long long)time(NULL));
    return atomic_write(path, data);
}

int lea_local_has_revoke_all(const char *base_dir) {
    char base[1024], path[1100], buf[256];
    if (!lea_local_base_dir(base_dir, base, sizeof(base))) return 0;
    if (!join_path(base, "revoke-all.json", path, sizeof(path))) return 0;
    if (!read_file(path, buf, sizeof(buf))) return 0;
    int v = 0;
    if (!json_get_bool(buf, "revoked", &v)) return 0;
    return v == 1;
}

int lea_local_set_revoke_all(const char *base_dir, int revoked) {
    char base[1024], path[1100], data[128];
    if (!lea_local_base_dir(base_dir, base, sizeof(base))) return 0;
    if (!join_path(base, "revoke-all.json", path, sizeof(path))) return 0;
    if (!revoked) return lea_local_clear_revoke_all(base_dir);
    ensure_dir(base); /* CLI 可能先于服务运行，目录尚不存在 */
    snprintf(data, sizeof(data), "{\"revoked\":true,\"at\":%lld}",
             (long long)time(NULL));
    return atomic_write(path, data);
}

int lea_local_clear_revoke_all(const char *base_dir) {
    char base[1024], path[1100];
    if (!lea_local_base_dir(base_dir, base, sizeof(base))) return 0;
    if (!join_path(base, "revoke-all.json", path, sizeof(path))) return 0;
    remove(path);
    return !file_exists(path);
}

/* ---------- 状态 JSON ---------- */

int lea_local_status_to_json(const lea_local_status_t *s, char *out, size_t out_size) {
    if (!s || !out || out_size == 0) return 0;
    size_t o = 0;
    out[0] = '\0';
    char head[512];
    int n = snprintf(head, sizeof(head),
                     "{\"paused\":%s,\"dangerous_consented\":%s,"
                     "\"dangerous_consented_at\":%lld,\"revoked_all\":%s,"
                     "\"revoked_at\":%lld,\"account_id\":\"",
                     s->paused ? "true" : "false",
                     s->dangerous_consented ? "true" : "false",
                     s->dangerous_consented_at,
                     s->revoked_all ? "true" : "false",
                     s->revoked_at);
    if (n < 0 || (size_t)n >= sizeof(head) || (size_t)n + 1 > out_size) return 0;
    memcpy(out, head, (size_t)n);
    o = (size_t)n;
    if (!json_escape_into(out, out_size, &o, s->account_id)) return 0;
    const char *mid1 = "\",\"device_id\":\"";
    if (o + strlen(mid1) + 1 > out_size) return 0;
    memcpy(out + o, mid1, strlen(mid1));
    o += strlen(mid1);
    if (!json_escape_into(out, out_size, &o, s->device_id)) return 0;
    const char *mid2 = "\",\"last_command\":\"";
    if (o + strlen(mid2) + 1 > out_size) return 0;
    memcpy(out + o, mid2, strlen(mid2));
    o += strlen(mid2);
    if (!json_escape_into(out, out_size, &o, s->last_command)) return 0;
    const char *mid3 = "\",\"last_result\":\"";
    if (o + strlen(mid3) + 1 > out_size) return 0;
    memcpy(out + o, mid3, strlen(mid3));
    o += strlen(mid3);
    if (!json_escape_into(out, out_size, &o, s->last_result)) return 0;
    char tail[128];
    n = snprintf(tail, sizeof(tail), "\",\"last_command_at\":%lld}",
                 s->last_command_at);
    if (n < 0 || o + (size_t)n + 1 > out_size) return 0;
    memcpy(out + o, tail, (size_t)n);
    o += (size_t)n;
    out[o] = '\0';
    return 1;
}

int lea_local_status_from_json(const char *text, lea_local_status_t *out) {
    if (!text || !out) return 0;
    /* 须为 JSON 对象；脏数据（非对象／未闭合）返回 0。 */
    const char *p = text;
    while (*p == ' ' || *p == '\t' || *p == '\n' || *p == '\r') p++;
    if (*p != '{') return 0;
    lea_local_status_t tmp;
    lea_local_status_init(&tmp);
    /* 缺失字段留默认；类型错（布尔非 true/false、数字非数字、
     * 字符串未闭合）只影响该字段（留默认），不整单拒绝——查询
     * 须永远有答案；但字符串解码失败即整单失败（防半截字段）。 */
    int b = 0;
    long long v = 0;
    if (json_get_bool(text, "paused", &b)) tmp.paused = b;
    if (json_get_bool(text, "dangerous_consented", &b)) tmp.dangerous_consented = b;
    if (json_get_llong(text, "dangerous_consented_at", &v)) tmp.dangerous_consented_at = v;
    if (json_get_bool(text, "revoked_all", &b)) tmp.revoked_all = b;
    if (json_get_llong(text, "revoked_at", &v)) tmp.revoked_at = v;
    if (json_get_llong(text, "last_command_at", &v)) tmp.last_command_at = v;
    /* 字符串字段：键存在但解不出（未闭合／溢出）即整单失败。 */
    if (strstr(text, "\"account_id\"") &&
        !json_get_string(text, "account_id", tmp.account_id, sizeof(tmp.account_id))) return 0;
    if (strstr(text, "\"device_id\"") &&
        !json_get_string(text, "device_id", tmp.device_id, sizeof(tmp.device_id))) return 0;
    if (strstr(text, "\"last_command\"") &&
        !json_get_string(text, "last_command", tmp.last_command, sizeof(tmp.last_command))) return 0;
    if (strstr(text, "\"last_result\"") &&
        !json_get_string(text, "last_result", tmp.last_result, sizeof(tmp.last_result))) return 0;
    *out = tmp;
    return 1;
}

int lea_local_status_snapshot(const char *base_dir, lea_local_status_t *out) {
    char base[1024], path[1100], buf[2048];
    if (!out) return 0;
    lea_local_status_init(out);
    if (!lea_local_base_dir(base_dir, base, sizeof(base))) return 0;
    if (join_path(base, "lea-status.json", path, sizeof(path)) &&
        read_file(path, buf, sizeof(buf))) {
        /* 状态文件脏了也不报错：解析失败即用默认态（标记文件仍叠加）。 */
        lea_local_status_t saved;
        if (lea_local_status_from_json(buf, &saved)) *out = saved;
    }
    /* 三个标记文件是实时态，永远覆盖快照里的对应字段。 */
    out->paused = lea_local_is_paused(base_dir);
    out->dangerous_consented = lea_local_has_dangerous_consent(base_dir);
    if (out->dangerous_consented) {
        char cpath[1100];
        if (join_path(base, "dangerous-consent.json", cpath, sizeof(cpath))) {
            char cbuf[256];
            if (read_file(cpath, cbuf, sizeof(cbuf))) {
                long long at = 0;
                if (json_get_llong(cbuf, "at", &at)) out->dangerous_consented_at = at;
            }
        }
    }
    out->revoked_all = lea_local_has_revoke_all(base_dir);
    if (out->revoked_all) {
        char rpath[1100];
        if (join_path(base, "revoke-all.json", rpath, sizeof(rpath))) {
            long long at = read_marker_at(rpath);
            if (at < 0) {
                char rbuf[256];
                if (read_file(rpath, rbuf, sizeof(rbuf)))
                    json_get_llong(rbuf, "at", &at);
            }
            if (at >= 0) out->revoked_at = at;
        }
    }
    return 1;
}

int lea_local_write_status(const char *base_dir, const lea_local_status_t *s) {
    char base[1024], path[1100], json[2048];
    if (!s) return 0;
    if (!lea_local_base_dir(base_dir, base, sizeof(base))) return 0;
    if (!join_path(base, "lea-status.json", path, sizeof(path))) return 0;
    if (!lea_local_status_to_json(s, json, sizeof(json))) return 0;
    ensure_dir(base); /* CLI 可能先于服务运行，目录尚不存在 */
    return atomic_write(path, json);
}

int lea_local_refresh_status(const char *base_dir, const char *last_command,
                             const char *last_result, long long at) {
    lea_local_status_t st;
    if (!lea_local_status_snapshot(base_dir, &st)) return 0;
    if (last_command && last_command[0]) {
        snprintf(st.last_command, sizeof(st.last_command), "%s", last_command);
    }
    if (last_result && last_result[0]) {
        snprintf(st.last_result, sizeof(st.last_result), "%s", last_result);
    }
    st.last_command_at = (at > 0) ? at : (long long)time(NULL);
    return lea_local_write_status(base_dir, &st);
}

/* ---------- 子命令集合与 CLI ---------- */

int lea_is_local_control_subcommand(const char *arg) {
    if (!arg) return 0;
    return strcmp(arg, "--status") == 0 ||
           strcmp(arg, "--pause") == 0 ||
           strcmp(arg, "--resume") == 0 ||
           strcmp(arg, "--revoke-all-keys") == 0 ||
           strcmp(arg, "--authorize-dangerous") == 0 ||
           strcmp(arg, "--revoke-dangerous-consent") == 0;
}

int lea_local_cli(int argc, char **argv, const char *base_dir) {
    if (argc < 2 || !lea_is_local_control_subcommand(argv[1])) {
        fprintf(stderr, "usage: QFRLEA.exe --status | --pause | --resume | "
                        "--revoke-all-keys | --authorize-dangerous | "
                        "--revoke-dangerous-consent\n");
        return 2;
    }
    const char *cmd = argv[1];
    char base[1024];
    if (!lea_local_base_dir(base_dir, base, sizeof(base))) {
        printf("{\"ok\":false,\"error\":\"no-base-dir\"}\n");
        return 1;
    }
    if (strcmp(cmd, "--status") == 0) {
        lea_local_status_t st;
        char json[2048];
        if (!lea_local_status_snapshot(base, &st) ||
            !lea_local_status_to_json(&st, json, sizeof(json))) {
            printf("{\"ok\":false,\"error\":\"status-read-failed\"}\n");
            return 1;
        }
        printf("{\"ok\":true,\"result\":%s}\n", json);
        return 0;
    }
    if (strcmp(cmd, "--pause") == 0) {
        if (!lea_local_set_paused(base, 1)) { printf("{\"ok\":false,\"error\":\"pause-failed\"}\n"); return 1; }
        lea_local_refresh_status(base, "lea.pause", "ok", 0);
        printf("{\"ok\":true,\"paused\":true}\n");
        return 0;
    }
    if (strcmp(cmd, "--resume") == 0) {
        if (!lea_local_set_paused(base, 0)) { printf("{\"ok\":false,\"error\":\"resume-failed\"}\n"); return 1; }
        lea_local_refresh_status(base, "lea.resume", "ok", 0);
        printf("{\"ok\":true,\"paused\":false}\n");
        return 0;
    }
    if (strcmp(cmd, "--revoke-all-keys") == 0) {
        if (!lea_local_set_revoke_all(base, 1)) { printf("{\"ok\":false,\"error\":\"revoke-failed\"}\n"); return 1; }
        lea_local_refresh_status(base, "lea.revoke-all-keys", "ok", 0);
        printf("{\"ok\":true,\"revoked_all\":true}\n");
        return 0;
    }
    if (strcmp(cmd, "--authorize-dangerous") == 0) {
        if (!lea_local_set_dangerous_consent(base, 1)) { printf("{\"ok\":false,\"error\":\"authorize-failed\"}\n"); return 1; }
        lea_local_refresh_status(base, "lea.authorize-dangerous", "ok", 0);
        printf("{\"ok\":true,\"dangerous_consented\":true}\n");
        return 0;
    }
    /* --revoke-dangerous-consent */
    if (!lea_local_set_dangerous_consent(base, 0)) { printf("{\"ok\":false,\"error\":\"revoke-consent-failed\"}\n"); return 1; }
    lea_local_refresh_status(base, "lea.revoke-dangerous-consent", "ok", 0);
    printf("{\"ok\":true,\"dangerous_consented\":false}\n");
    return 0;
}
