/* 见 lea_local.h（S-021）。纯 C：只用 stdio/stdlib/string/time，
 * 不含 windows.h，Linux 单测与 mingw 交叉编译共用。
 * 原子写统一走 lea_filewrite.c（A9）：fwrite 逐段校验字节数、
 * fflush／fclose 均检查、单次 fclose、同卷替换具替换语义且
 * 失败保留旧文件。旧 atomic_write（先删旧目标再 rename、二次
 * fclose）已删除，不得恢复。 */
#include "lea_local.h"
#include "lea_instance.h" /* A+：实例身份（生产／TEST）唯一来源，见该文件头注 */
#include "lea_filewrite.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <errno.h>
#include <dirent.h> /* 对账扫审计日志（lea_audit.c 同款，mingw 与 POSIX 均可用） */
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
        /* A+：回退数据根目录叶名取自实例身份（TEST：LEA-TEST；生产：LEA）。
         * 旧实现写死 \QFR\LEA，TEST 二进制跑本地控制子命令时会误读写
         * 生产状态文件。 */
        if (snprintf(out, out_size, "%s\\QFR\\%s", pd, LEA_INSTANCE_LEAF) < 0 ||
            strlen(pd) + strlen("\\QFR\\") + strlen(LEA_INSTANCE_LEAF) >= out_size) return 0;
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

/* 原子写（A9）：统一委托 lea_file_write_atomic——临时文件写入 →
 * 逐段校验实际写入字节数（短写循环续写、写满／出错即失败）→
 * fflush＋fclose 均检查（fclose 只调一次）→ 成功后才同卷替换目标
 * （Windows 用 MoveFileExA REPLACE_EXISTING，POSIX 用 rename 原子
 * 替换）。任何一步失败都删临时文件、原文件原样保留、返回失败。
 * 旧实现的三处缺陷已修掉，不得恢复：① fwrite／fclose 返回值不
 * 检查（fwrite 短写、fflush 失败都当成功）；② rename 失败时先
 * remove(path) 再 rename（旧文件先丢，改名再失败即两空）；③ 失败
 * 分支二次 fclose（fwrite 成功＋fclose 失败时 fclose 被调两次，
 * 未定义行为）。临时文件后缀带 pid（.tmp.<pid>），防并发写互相覆盖。 */
static int atomic_write(const char *path, const char *data) {
    char detail[64] = { 0 };
    return lea_file_write_atomic(path, (const unsigned char *)data,
                                 strlen(data), detail, sizeof(detail));
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

/* A7：一键撤销标记带服务端单调量（恢复路径用）。
 * set_revoke_all_at 写 revoke-all.json：
 *   {"revoked":true,"at":<本机 unix>,"grant_epoch":<撤销时绑定 grant_epoch>,
 *    "expires_at":<撤销时绑定票据 expires_at>}
 * grant_epoch／expires_at 均来自服务端签发票据（单调递增、不依赖本机
 * 墙钟）。恢复时只有 grant_epoch 更大或 expires_at 更晚的新票据才能
 * 清除标记（见 QFRLEA.c binding.confirm），旧票据重放不得清除。
 * 旧格式标记（只有 revoked／at）读不到两字段即按 0 计，任何有效新
 * 票据（expires_at>0）都能清除——fail-closed 方向仍是“新票据才能清”。 */
int lea_local_set_revoke_all_at(const char *base_dir, int revoked,
                                long long grant_epoch, long long expires_at) {
    char base[1024], path[1100], data[192];
    if (!lea_local_base_dir(base_dir, base, sizeof(base))) return 0;
    if (!join_path(base, "revoke-all.json", path, sizeof(path))) return 0;
    if (!revoked) return lea_local_clear_revoke_all(base_dir);
    ensure_dir(base); /* CLI 可能先于服务运行，目录尚不存在 */
    snprintf(data, sizeof(data),
             "{\"revoked\":true,\"at\":%lld,\"grant_epoch\":%lld,\"expires_at\":%lld}",
             (long long)time(NULL), grant_epoch, expires_at);
    return atomic_write(path, data);
}

int lea_local_get_revoke_all(const char *base_dir, long long *grant_epoch_out,
                             long long *expires_at_out) {
    char base[1024], path[1100], buf[256];
    if (grant_epoch_out) *grant_epoch_out = 0;
    if (expires_at_out) *expires_at_out = 0;
    if (!lea_local_base_dir(base_dir, base, sizeof(base))) return 0;
    if (!join_path(base, "revoke-all.json", path, sizeof(path))) return 0;
    if (!read_file(path, buf, sizeof(buf))) return 0;
    int v = 0;
    if (!json_get_bool(buf, "revoked", &v)) return 0;
    if (v != 1) return 0;
    long long g = 0, e = 0;
    json_get_llong(buf, "grant_epoch", &g);
    json_get_llong(buf, "expires_at", &e);
    if (grant_epoch_out) *grant_epoch_out = g;
    if (expires_at_out) *expires_at_out = e;
    return 1;
}

int lea_local_set_revoke_all(const char *base_dir, int revoked) {
    return lea_local_set_revoke_all_at(base_dir, revoked, 0, 0);
}

/* A7：撤销恢复判定（纯函数，可单测）。标记记的是撤销时绑定的票据
 * 单调量（grant_epoch／expires_at，均来自服务端签发票据，不依赖
 * 本机墙钟）。只有新票据比标记更新才允许清除：grant_epoch 更大，
 * 或 expires_at 更晚。旧票据重放（两值都不大于标记）不得清除；
 * 旧格式标记（两值皆 0）时任何有效新票据（expires_at>0）都可清除。 */
int lea_revoke_recovery_allowed(long long marker_grant_epoch,
                                long long marker_expires_at,
                                long long ticket_grant_epoch,
                                long long ticket_expires_at) {
    return (ticket_grant_epoch > marker_grant_epoch) ||
           (ticket_expires_at > marker_expires_at);
}

/* A7：管道侧改状态命令判定（纯函数，可单测）。这 5 个命令在
 * handle_internal 一律拒绝（须走已签名已审计的信封通路）；其余
 * 内部命令（session.login_changed、binding.confirm、lea.status
 * 等）不受影响。 */
int lea_internal_state_command(const char *cmd) {
    if (!cmd) return 0;
    return strcmp(cmd, "lea.pause") == 0 ||
           strcmp(cmd, "lea.resume") == 0 ||
           strcmp(cmd, "lea.revoke-all-keys") == 0 ||
           strcmp(cmd, "lea.authorize-dangerous") == 0 ||
           strcmp(cmd, "lea.revoke-dangerous-consent") == 0;
}

/* A7-whitelist：内部命令显式白名单（纯函数，可单测）。表内 13 个：
 * 绑定三件（login_changed／logout／confirm）＋吊销同步两件
 * （sync-revoked／key_revoked）＋只读状态（lea.status）＋自助绑定
 * 五件（selfbind.*，转 USH）＋任务查询两件（job.cancel／job.query）。
 * 不在表内的命令（包括 5 个改状态命令与一切未知命令）一律拒绝。
 * 白名单只管命令准入：各命令自身的身份／签名／代次校验仍在
 * handle_internal 各分支内做（logout 账户绑定、sync/kick 签名＋代次、
 * confirm 票据验签＋身份＋epoch、login_changed 证明由 A1 线负责）。 */
int lea_internal_whitelist_command(const char *cmd) {
    if (!cmd) return 0;
    return strcmp(cmd, "session.login_changed") == 0 ||
           strcmp(cmd, "session.logout") == 0 ||
           strcmp(cmd, "binding.confirm") == 0 ||
           strcmp(cmd, "keys.sync-revoked") == 0 ||
           strcmp(cmd, "lea.key_revoked") == 0 ||
           strcmp(cmd, "lea.status") == 0 ||
           strcmp(cmd, "selfbind.ush-status") == 0 ||
           strcmp(cmd, "selfbind.clear-credential") == 0 ||
           strcmp(cmd, "selfbind.status") == 0 ||
           strcmp(cmd, "selfbind.renew") == 0 ||
           strcmp(cmd, "selfbind.deliver-ticket") == 0 ||
           strcmp(cmd, "job.cancel") == 0 ||
           strcmp(cmd, "job.query") == 0;
}

int lea_local_clear_revoke_all(const char *base_dir) {
    char base[1024], path[1100];
    if (!lea_local_base_dir(base_dir, base, sizeof(base))) return 0;
    if (!join_path(base, "revoke-all.json", path, sizeof(path))) return 0;
    remove(path);
    return !file_exists(path);
}

/* ---------- emergency_stop 紧急停控（GPT 2026-11-18 裁决问题 1＋六节） ---------- */

void lea_emergency_stop_init(lea_emergency_stop_t *s) {
    if (!s) return;
    memset(s, 0, sizeof(*s));
    snprintf(s->sync_status, sizeof(s->sync_status), "%s", "pending");
    snprintf(s->scope, sizeof(s->scope), "%s", "device-control");
}

int lea_emergency_stop_to_json(const lea_emergency_stop_t *s, char *out, size_t out_size) {
    if (!s || !out || out_size == 0) return 0;
    size_t o = 0;
    out[0] = '\0';
    char head[256];
    int n = snprintf(head, sizeof(head),
                     "{\"stopped\":%s,\"stop_event_id\":\"",
                     s->stopped ? "true" : "false");
    if (n < 0 || (size_t)n >= sizeof(head) || (size_t)n + 1 > out_size) return 0;
    memcpy(out, head, (size_t)n);
    o = (size_t)n;
    if (!json_escape_into(out, out_size, &o, s->stop_event_id)) return 0;
    char mid[512];
    n = snprintf(mid, sizeof(mid),
                 "\",\"stop_seq\":%lld,\"account_id\":\"",
                 s->stop_seq);
    if (n < 0 || o + (size_t)n + 1 > out_size) return 0;
    memcpy(out + o, mid, (size_t)n);
    o += (size_t)n;
    if (!json_escape_into(out, out_size, &o, s->account_id)) return 0;
    const char *m1 = "\",\"device_id\":\"";
    if (o + strlen(m1) + 1 > out_size) return 0;
    memcpy(out + o, m1, strlen(m1));
    o += strlen(m1);
    if (!json_escape_into(out, out_size, &o, s->device_id)) return 0;
    n = snprintf(mid, sizeof(mid),
                 "\",\"scope\":\"");
    if (n < 0 || o + (size_t)n + 1 > out_size) return 0;
    memcpy(out + o, mid, (size_t)n);
    o += (size_t)n;
    if (!json_escape_into(out, out_size, &o, s->scope)) return 0;
    n = snprintf(mid, sizeof(mid),
                 "\",\"binding_epoch\":%lld,\"grant_epoch\":%lld,\"stopped_at\":%lld,\"sync_status\":\"",
                 s->binding_epoch, s->grant_epoch, s->stopped_at);
    if (n < 0 || o + (size_t)n + 1 > out_size) return 0;
    memcpy(out + o, mid, (size_t)n);
    o += (size_t)n;
    if (!json_escape_into(out, out_size, &o, s->sync_status)) return 0;
    const char *m2 = "\",\"sync_receipt\":\"";
    if (o + strlen(m2) + 1 > out_size) return 0;
    memcpy(out + o, m2, strlen(m2));
    o += strlen(m2);
    if (!json_escape_into(out, out_size, &o, s->sync_receipt)) return 0;
    n = snprintf(mid, sizeof(mid),
                 "\",\"last_recovery_epoch\":%lld,\"cleared_by_ticket_id\":\"",
                 s->last_recovery_epoch);
    if (n < 0 || o + (size_t)n + 1 > out_size) return 0;
    memcpy(out + o, mid, (size_t)n);
    o += (size_t)n;
    if (!json_escape_into(out, out_size, &o, s->cleared_by_ticket_id)) return 0;
    n = snprintf(mid, sizeof(mid),
                 "\",\"cleared_by_recovery_epoch\":%lld,\"cleared_at\":%lld}",
                 s->cleared_by_recovery_epoch, s->cleared_at);
    if (n < 0 || o + (size_t)n + 1 > out_size) return 0;
    memcpy(out + o, mid, (size_t)n);
    o += (size_t)n;
    out[o] = '\0';
    return 1;
}

int lea_emergency_stop_from_json(const char *text, lea_emergency_stop_t *out) {
    if (!text || !out) return 0;
    const char *p = text;
    while (*p == ' ' || *p == '\t' || *p == '\n' || *p == '\r') p++;
    if (*p != '{') return 0;
    lea_emergency_stop_t tmp;
    lea_emergency_stop_init(&tmp);
    int b = 0;
    long long v = 0;
    if (json_get_bool(text, "stopped", &b)) tmp.stopped = b;
    if (json_get_llong(text, "stop_seq", &v)) tmp.stop_seq = v;
    if (json_get_llong(text, "binding_epoch", &v)) tmp.binding_epoch = v;
    if (json_get_llong(text, "grant_epoch", &v)) tmp.grant_epoch = v;
    if (json_get_llong(text, "stopped_at", &v)) tmp.stopped_at = v;
    if (json_get_llong(text, "last_recovery_epoch", &v)) tmp.last_recovery_epoch = v;
    if (json_get_llong(text, "cleared_by_recovery_epoch", &v)) tmp.cleared_by_recovery_epoch = v;
    if (json_get_llong(text, "cleared_at", &v)) tmp.cleared_at = v;
    /* 字符串字段：键存在但解不出即整单失败（防半截字段）。 */
    if (strstr(text, "\"stop_event_id\"") &&
        !json_get_string(text, "stop_event_id", tmp.stop_event_id, sizeof(tmp.stop_event_id))) return 0;
    if (strstr(text, "\"account_id\"") &&
        !json_get_string(text, "account_id", tmp.account_id, sizeof(tmp.account_id))) return 0;
    if (strstr(text, "\"device_id\"") &&
        !json_get_string(text, "device_id", tmp.device_id, sizeof(tmp.device_id))) return 0;
    if (strstr(text, "\"scope\"") &&
        !json_get_string(text, "scope", tmp.scope, sizeof(tmp.scope))) return 0;
    if (strstr(text, "\"sync_status\"") &&
        !json_get_string(text, "sync_status", tmp.sync_status, sizeof(tmp.sync_status))) return 0;
    if (strstr(text, "\"sync_receipt\"") &&
        !json_get_string(text, "sync_receipt", tmp.sync_receipt, sizeof(tmp.sync_receipt))) return 0;
    if (strstr(text, "\"cleared_by_ticket_id\"") &&
        !json_get_string(text, "cleared_by_ticket_id", tmp.cleared_by_ticket_id, sizeof(tmp.cleared_by_ticket_id))) return 0;
    *out = tmp;
    return 1;
}

int lea_local_emergency_stop_read(const char *base_dir, lea_emergency_stop_t *out) {
    char base[1024], path[1100], buf[2048];
    if (!out) return -1;
    lea_emergency_stop_init(out);
    if (!lea_local_base_dir(base_dir, base, sizeof(base))) return -1;
    if (!join_path(base, "emergency-stop.json", path, sizeof(path))) return -1;
    /* 缺失 vs 损坏须分清：fopen 失败且 errno==ENOENT 即文件缺失（全新
     * 设备）；其他失败（权限等）或内容不可解析即损坏，按已停控处理。 */
    FILE *f = fopen(path, "rb");
    if (!f) return (errno == ENOENT) ? 0 : -1;
    size_t n = fread(buf, 1, sizeof(buf) - 1, f);
    fclose(f);
    buf[n] = '\0';
    if (!lea_emergency_stop_from_json(buf, out)) return -1;
    return 1;
}

int lea_local_emergency_stop_write(const char *base_dir, const lea_emergency_stop_t *s) {
    char base[1024], path[1100], json[2048];
    if (!s) return 0;
    if (!lea_local_base_dir(base_dir, base, sizeof(base))) return 0;
    if (!join_path(base, "emergency-stop.json", path, sizeof(path))) return 0;
    if (!lea_emergency_stop_to_json(s, json, sizeof(json))) return 0;
    ensure_dir(base);
    return atomic_write(path, json);
}

int lea_local_emergency_stopped(const char *base_dir) {
    lea_emergency_stop_t st;
    int rc = lea_local_emergency_stop_read(base_dir, &st);
    if (rc == 1) return st.stopped == 1;
    if (rc == -1) return 1; /* 文件损坏即按已停控（fail-closed） */
    return 0;               /* 文件缺失＝未停控过 */
}

/* ---------- 已用恢复票据记录 recovery-tickets-used.jsonl ---------- */

#define LEA_USED_TICKETS_MAX_BYTES (64 * 1024)

/* 票据记录行字段解析（行内平铺 JSON；脏行返回 0，调用方原样保留）。 */
static int used_ticket_parse_line(const char *line, char *ticket_id, size_t ticket_size,
                                  char *stop_event_id, size_t stop_size,
                                  long long *recovery_epoch, long long *used_at,
                                  char *status, size_t status_size) {
    if (ticket_id) ticket_id[0] = '\0';
    if (stop_event_id) stop_event_id[0] = '\0';
    if (recovery_epoch) *recovery_epoch = 0;
    if (used_at) *used_at = 0;
    if (status) status[0] = '\0';
    if (!line || !strstr(line, "\"ticket_id\"")) return 0;
    if (ticket_id && !json_get_string(line, "ticket_id", ticket_id, ticket_size)) return 0;
    if (stop_event_id && !json_get_string(line, "stop_event_id", stop_event_id, stop_size)) return 0;
    long long e = 0, u = 0;
    if (!json_get_llong(line, "recovery_epoch", &e)) return 0;
    if (recovery_epoch) *recovery_epoch = e;
    if (used_at) {
        if (json_get_llong(line, "used_at", &u)) *used_at = u;
    }
    if (status && !json_get_string(line, "status", status, status_size)) return 0;
    return 1;
}

static int used_ticket_emit_line(char *out, size_t out_size, const char *ticket_id,
                                 const char *stop_event_id, long long recovery_epoch,
                                 long long used_at, const char *status) {
    /* ticket_id／stop_event_id 调用方已按 id 规则校验（仅 [A-Za-z0-9_.-]），
     * status 为模块内常量，三者直拼安全。 */
    int n = snprintf(out, out_size,
                     "{\"ticket_id\":\"%s\",\"stop_event_id\":\"%s\",\"recovery_epoch\":%lld,\"used_at\":%lld,\"status\":\"%s\"}",
                     ticket_id, stop_event_id, recovery_epoch, used_at, status);
    return n > 0 && (size_t)n < out_size;
}

/* 读整份记录文件到 buf（不存在即空串，返回 1；超限返回 0，不静默截断）。 */
static int used_tickets_read_all(const char *base_dir, char *buf, size_t buf_size) {
    char base[1024], path[1100];
    buf[0] = '\0';
    if (!lea_local_base_dir(base_dir, base, sizeof(base))) return 0;
    if (!join_path(base, "recovery-tickets-used.jsonl", path, sizeof(path))) return 0;
    FILE *f = fopen(path, "rb");
    if (!f) return (errno == ENOENT) ? 1 : 0;
    size_t n = fread(buf, 1, buf_size - 1, f);
    /* 读满缓冲仍有剩余即超限（须人工介入，不截断）。 */
    if (n == buf_size - 1 && fgetc(f) != EOF) {
        fclose(f);
        buf[0] = '\0';
        return 0;
    }
    fclose(f);
    buf[n] = '\0';
    return 1;
}

static int used_tickets_write_all(const char *base_dir, const char *data) {
    char base[1024], path[1100];
    if (!lea_local_base_dir(base_dir, base, sizeof(base))) return 0;
    if (!join_path(base, "recovery-tickets-used.jsonl", path, sizeof(path))) return 0;
    ensure_dir(base);
    return atomic_write(path, data);
}

int lea_local_recovery_ticket_consume(const char *base_dir, const char *ticket_id,
                                      const char *stop_event_id, long long recovery_epoch) {
    if (!lea_validate_id_field(ticket_id) || !lea_validate_id_field(stop_event_id)) return 0;
    char buf[LEA_USED_TICKETS_MAX_BYTES];
    if (!used_tickets_read_all(base_dir, buf, sizeof(buf))) return 0;
    /* 已在记录中即拒绝（重放）；逐行扫描。 */
    const char *p = buf;
    while (*p) {
        const char *eol = strchr(p, '\n');
        size_t len = eol ? (size_t)(eol - p) : strlen(p);
        if (len > 0 && len < 1024) {
            char line[1024];
            memcpy(line, p, len);
            line[len] = '\0';
            char tid[128] = { 0 };
            if (used_ticket_parse_line(line, tid, sizeof(tid), NULL, 0, NULL, NULL, NULL, 0) &&
                strcmp(tid, ticket_id) == 0)
                return 0; /* 已消费过，拒绝重放 */
        }
        if (!eol) break;
        p = eol + 1;
    }
    char line[1024];
    if (!used_ticket_emit_line(line, sizeof(line), ticket_id, stop_event_id,
                               recovery_epoch, (long long)time(NULL),
                               "consumed_pending_clear")) return 0;
    /* 全量重写（原子写）：旧内容＋新行。 */
    size_t old_len = strlen(buf);
    if (old_len + strlen(line) + 2 > sizeof(buf)) return 0;
    char out[LEA_USED_TICKETS_MAX_BYTES];
    snprintf(out, sizeof(out), "%s%s%s", buf,
             (old_len > 0 && buf[old_len - 1] != '\n') ? "\n" : "", line);
    size_t o = strlen(out);
    if (o + 2 > sizeof(out)) return 0;
    out[o++] = '\n';
    out[o] = '\0';
    return used_tickets_write_all(base_dir, out);
}

int lea_local_recovery_ticket_mark_recovered(const char *base_dir, const char *ticket_id) {
    if (!lea_validate_id_field(ticket_id)) return 0;
    char buf[LEA_USED_TICKETS_MAX_BYTES];
    if (!used_tickets_read_all(base_dir, buf, sizeof(buf))) return 0;
    char out[LEA_USED_TICKETS_MAX_BYTES];
    out[0] = '\0';
    size_t o = 0;
    int found = 0;
    const char *p = buf;
    while (*p) {
        const char *eol = strchr(p, '\n');
        size_t len = eol ? (size_t)(eol - p) : strlen(p);
        if (len == 0) { if (!eol) break; p = eol + 1; continue; }
        char line[1024];
        if (len >= sizeof(line)) return 0;
        memcpy(line, p, len);
        line[len] = '\0';
        char tid[128] = { 0 }, seid[128] = { 0 }, status[64] = { 0 };
        long long epoch = 0, used_at = 0;
        if (used_ticket_parse_line(line, tid, sizeof(tid), seid, sizeof(seid),
                                   &epoch, &used_at, status, sizeof(status)) &&
            strcmp(tid, ticket_id) == 0) {
            found = 1;
            if (!used_ticket_emit_line(line, sizeof(line), tid, seid, epoch, used_at, "recovered"))
                return 0;
        }
        /* 脏行原样保留，不丢数据。 */
        size_t ll = strlen(line);
        if (o + ll + 2 > sizeof(out)) return 0;
        memcpy(out + o, line, ll);
        o += ll;
        out[o++] = '\n';
        out[o] = '\0';
        if (!eol) break;
        p = eol + 1;
    }
    if (!found) return 0;
    return used_tickets_write_all(base_dir, out);
}

long long lea_local_recovery_max_epoch(const char *base_dir) {
    char buf[LEA_USED_TICKETS_MAX_BYTES];
    if (!used_tickets_read_all(base_dir, buf, sizeof(buf))) return 0;
    long long max_e = 0;
    const char *p = buf;
    while (*p) {
        const char *eol = strchr(p, '\n');
        size_t len = eol ? (size_t)(eol - p) : strlen(p);
        if (len > 0 && len < 1024) {
            char line[1024];
            memcpy(line, p, len);
            line[len] = '\0';
            long long epoch = 0;
            if (used_ticket_parse_line(line, NULL, 0, NULL, 0, &epoch, NULL, NULL, 0) &&
                epoch > max_e)
                max_e = epoch;
        }
        if (!eol) break;
        p = eol + 1;
    }
    return max_e;
}

int lea_local_recovery_ticket_status(const char *base_dir, const char *ticket_id,
                                     char *status_out, size_t status_out_size,
                                     long long *recovery_epoch_out) {
    if (status_out) status_out[0] = '\0';
    if (recovery_epoch_out) *recovery_epoch_out = 0;
    if (!lea_validate_id_field(ticket_id)) return 0;
    char buf[LEA_USED_TICKETS_MAX_BYTES];
    if (!used_tickets_read_all(base_dir, buf, sizeof(buf))) return 0;
    const char *p = buf;
    while (*p) {
        const char *eol = strchr(p, '\n');
        size_t len = eol ? (size_t)(eol - p) : strlen(p);
        if (len > 0 && len < 1024) {
            char line[1024];
            memcpy(line, p, len);
            line[len] = '\0';
            char tid[128] = { 0 }, status[64] = { 0 };
            long long epoch = 0;
            if (used_ticket_parse_line(line, tid, sizeof(tid), NULL, 0, &epoch, NULL,
                                       status, sizeof(status)) &&
                strcmp(tid, ticket_id) == 0) {
                if (status_out) snprintf(status_out, status_out_size, "%s", status);
                if (recovery_epoch_out) *recovery_epoch_out = epoch;
                return 1;
            }
        }
        if (!eol) break;
        p = eol + 1;
    }
    return 0;
}

/* 恢复判定（纯函数）。标记 stopped 且 stop_event_id 一致，且票据
 * recovery_epoch 严格大于已见最大代次（调用方传 max_recovery_epoch
 * 与标记 last_recovery_epoch 的大者），且 grant_epoch 不小于标记的
 * grant_epoch，且账号／设备与标记一致，才允许清除。 */
int lea_emergency_stop_recovery_allowed(const lea_emergency_stop_t *marker,
                                        const lea_recovery_ticket_t *tk,
                                        long long max_recovery_epoch) {
    if (!marker || !tk) return 0;
    if (!marker->stopped) return 0;
    if (strcmp(marker->stop_event_id, tk->stop_event_id) != 0) return 0;
    if (strcmp(marker->account_id, tk->account_id) != 0) return 0;
    if (strcmp(marker->device_id, tk->device_id) != 0) return 0;
    long long seen = max_recovery_epoch > marker->last_recovery_epoch
                         ? max_recovery_epoch : marker->last_recovery_epoch;
    if (tk->recovery_epoch <= seen) return 0;
    if (tk->grant_epoch < marker->grant_epoch) return 0;
    return 1;
}

/* ---------- 启动对账 ---------- */

/* 从审计 detail 里取 "stop_event_id=<id>"（id 字符集 [A-Za-z0-9_.-]）。 */
static int detail_get_stop_event_id(const char *detail, char *out, size_t out_size) {
    if (!detail || !out || out_size == 0) return 0;
    out[0] = '\0';
    const char *p = strstr(detail, "stop_event_id=");
    if (!p) return 0;
    p += strlen("stop_event_id=");
    size_t n = 0;
    while (*p && ((*p >= 'A' && *p <= 'Z') || (*p >= 'a' && *p <= 'z') ||
                  (*p >= '0' && *p <= '9') || *p == '_' || *p == '.' || *p == '-')) {
        if (n + 1 >= out_size) return 0;
        out[n++] = *p++;
    }
    out[n] = '\0';
    return n > 0;
}

static int detail_get_stop_seq(const char *detail, long long *out) {
    if (!detail || !out) return 0;
    const char *p = strstr(detail, "stop_seq=");
    if (!p) return 0;
    p += strlen("stop_seq=");
    char *end = NULL;
    long long v = strtoll(p, &end, 10);
    if (end == p) return 0;
    *out = v;
    return 1;
}

/* 扫一份审计 JSONL：找最后一条停控相关事件（event 为 emergency-stop
 * 或 emergency-stop-recover）。last_kind：0=无，1=stop，2=recover；
 * last_result 为该事件的 result 串。 */
static int audit_scan_file(const char *path, int *last_kind, char *last_result,
                           size_t result_size, char *last_event_id, size_t event_size,
                           long long *last_seq, char *last_account, size_t account_size,
                           char *last_device, size_t device_size,
                           long long *last_binding_epoch, long long *last_grant_epoch) {
    FILE *f = fopen(path, "rb");
    if (!f) return 0;
    char line[8192];
    while (fgets(line, sizeof(line), f)) {
        int is_stop = strstr(line, "\"event\":\"emergency-stop\"") != NULL;
        int is_recover = strstr(line, "\"event\":\"emergency-stop-recover\"") != NULL;
        if (!is_stop && !is_recover) continue;
        char result[64] = { 0 };
        if (!json_get_string(line, "result", result, sizeof(result))) continue;
        /* 只认终态结果：stop 的 "ok"、recover 的 "recovered"。attempt／
         * failed 不改状态——失败的恢复不清除停控，失败的停控不建立停控。
         * （否则最后一条若是失败的恢复 attempt，会把之前已完成的停控
         * 误判为未停控。） */
        if (is_stop && strcmp(result, "ok") != 0) continue;
        if (is_recover && strcmp(result, "recovered") != 0) continue;
        char detail[1024] = { 0 };
        char event_id[128] = { 0 };
        json_get_string(line, "detail", detail, sizeof(detail));
        if (!detail_get_stop_event_id(detail, event_id, sizeof(event_id))) continue;
        *last_kind = is_stop ? 1 : 2;
        snprintf(last_result, result_size, "%s", result);
        snprintf(last_event_id, event_size, "%s", event_id);
        long long seq = 0;
        if (detail_get_stop_seq(detail, &seq)) *last_seq = seq;
        char acc[128] = { 0 }, dev[128] = { 0 };
        if (json_get_string(line, "account_id", acc, sizeof(acc)))
            snprintf(last_account, account_size, "%s", acc);
        if (json_get_string(line, "device_id", dev, sizeof(dev)))
            snprintf(last_device, device_size, "%s", dev);
        long long be = 0, ge = 0;
        if (json_get_llong(line, "binding_epoch", &be)) *last_binding_epoch = be;
        /* grant_epoch 不在审计顶层字段里，从 detail 取。 */
        const char *gp = strstr(detail, "grant_epoch=");
        if (gp) {
            char *end = NULL;
            long long gv = strtoll(gp + strlen("grant_epoch="), &end, 10);
            if (end != gp + strlen("grant_epoch=")) *last_grant_epoch = gv;
        }
    }
    fclose(f);
    return 1;
}

int lea_local_emergency_stop_reconcile(const char *base_dir, const char *logs_dir) {
    lea_emergency_stop_t marker;
    int rc = lea_local_emergency_stop_read(base_dir, &marker);
    if (rc == -1) return -1; /* 标记损坏：调用方按已停控处理＋告警，不覆写 */
    if (rc == 1) {
        if (marker.stopped) return 0; /* 标记在位即停控，无须对账 */
        /* 标记已清是 ground truth：票据记录里若有 consumed_pending_clear
         * 同事件票据，说明清标记后改票据状态一步未落盘，补为 recovered。 */
        char buf[LEA_USED_TICKETS_MAX_BYTES];
        if (!used_tickets_read_all(base_dir, buf, sizeof(buf))) return -1;
        const char *p = buf;
        int repaired = 0;
        while (*p) {
            const char *eol = strchr(p, '\n');
            size_t len = eol ? (size_t)(eol - p) : strlen(p);
            if (len > 0 && len < 1024) {
                char line[1024];
                memcpy(line, p, len);
                line[len] = '\0';
                char tid[128] = { 0 }, seid[128] = { 0 }, status[64] = { 0 };
                if (used_ticket_parse_line(line, tid, sizeof(tid), seid, sizeof(seid),
                                           NULL, NULL, status, sizeof(status)) &&
                    strcmp(seid, marker.stop_event_id) == 0 &&
                    strcmp(status, "consumed_pending_clear") == 0) {
                    if (!lea_local_recovery_ticket_mark_recovered(base_dir, tid)) return -1;
                    repaired = 1;
                }
            }
            if (!eol) break;
            p = eol + 1;
        }
        return repaired ? 2 : 0;
    }
    /* rc == 0：标记文件缺失。先看票据记录有无 pending 票据（恢复未完成），
     * 再扫审计日志找最后一条已完成的停控事件；任一证据指向"停控过且未
     * 完成恢复"，即重建标记（已停控）。审计 clear 事件永不删标记，
     * 此处只用作"最后事件是恢复完成"的判定。 */
    int have_pending_ticket = 0;
    char pending_event_id[128] = { 0 };
    {
        char buf[LEA_USED_TICKETS_MAX_BYTES];
        if (!used_tickets_read_all(base_dir, buf, sizeof(buf))) return -1;
        const char *p = buf;
        while (*p) {
            const char *eol = strchr(p, '\n');
            size_t len = eol ? (size_t)(eol - p) : strlen(p);
            if (len > 0 && len < 1024) {
                char line[1024];
                memcpy(line, p, len);
                line[len] = '\0';
                char tid[128] = { 0 }, seid[128] = { 0 }, status[64] = { 0 };
                if (used_ticket_parse_line(line, tid, sizeof(tid), seid, sizeof(seid),
                                           NULL, NULL, status, sizeof(status)) &&
                    strcmp(status, "consumed_pending_clear") == 0) {
                    have_pending_ticket = 1;
                    snprintf(pending_event_id, sizeof(pending_event_id), "%s", seid);
                    break;
                }
            }
            if (!eol) break;
            p = eol + 1;
        }
    }
    /* 扫审计日志（按文件名排序＝按天顺序；同天内按行顺序）。 */
    int last_kind = 0; /* 0=无，1=stop，2=recover */
    char last_result[64] = { 0 }, last_event_id[128] = { 0 };
    long long last_seq = 0, last_be = 0, last_ge = 0;
    char last_account[128] = { 0 }, last_device[128] = { 0 };
    if (logs_dir && logs_dir[0]) {
        DIR *dp = opendir(logs_dir);
        if (dp) {
            /* 收集文件名再排序（readdir 顺序不定）。 */
            char names[64][64];
            int n = 0;
            struct dirent *de;
            while ((de = readdir(dp)) != NULL && n < 64) {
                if (strncmp(de->d_name, "lea-", 4) != 0) continue;
                size_t l = strlen(de->d_name);
                if (l < 5 || strcmp(de->d_name + l - 6, ".jsonl") != 0) continue;
                snprintf(names[n], sizeof(names[n]), "%s", de->d_name);
                n++;
            }
            closedir(dp);
            /* 冒泡排序（文件数极少）。 */
            for (int i = 0; i < n; i++)
                for (int j = i + 1; j < n; j++)
                    if (strcmp(names[i], names[j]) > 0) {
                        char tmp[64];
                        snprintf(tmp, sizeof(tmp), "%s", names[i]);
                        snprintf(names[i], sizeof(names[i]), "%s", names[j]);
                        snprintf(names[j], sizeof(names[j]), "%s", tmp);
                    }
            for (int i = 0; i < n; i++) {
                char path[1200];
                snprintf(path, sizeof(path), "%s/%s", logs_dir, names[i]);
                audit_scan_file(path, &last_kind, last_result, sizeof(last_result),
                                last_event_id, sizeof(last_event_id), &last_seq,
                                last_account, sizeof(last_account),
                                last_device, sizeof(last_device),
                                &last_be, &last_ge);
            }
        }
    }
    if (last_kind == 1 && strcmp(last_result, "ok") == 0 && last_event_id[0]) {
        /* 最后一条已完成事件是停控成功 → 重建标记。 */
        lea_emergency_stop_t rebuilt;
        lea_emergency_stop_init(&rebuilt);
        rebuilt.stopped = 1;
        snprintf(rebuilt.stop_event_id, sizeof(rebuilt.stop_event_id), "%s", last_event_id);
        rebuilt.stop_seq = last_seq;
        snprintf(rebuilt.account_id, sizeof(rebuilt.account_id), "%s", last_account);
        snprintf(rebuilt.device_id, sizeof(rebuilt.device_id), "%s", last_device);
        rebuilt.binding_epoch = last_be;
        rebuilt.grant_epoch = last_ge;
        rebuilt.stopped_at = (long long)time(NULL);
        if (!lea_local_emergency_stop_write(base_dir, &rebuilt)) return -1;
        return 1;
    }
    if (last_kind == 2 && strcmp(last_result, "recovered") == 0) {
        /* 最后一条已完成事件是恢复成功 → 标记缺失即未停控，不重建。 */
        return 0;
    }
    if (have_pending_ticket && pending_event_id[0]) {
        /* 票据已消费但标记文件丢了：恢复未完成，按已停控重建最小标记
         * （只有事件 ID 可信，其余字段留空／0；下一次停控的 stop_seq
         * 从 0 续计，事件 ID 仍凭 unix 分量唯一）。 */
        lea_emergency_stop_t rebuilt;
        lea_emergency_stop_init(&rebuilt);
        rebuilt.stopped = 1;
        snprintf(rebuilt.stop_event_id, sizeof(rebuilt.stop_event_id), "%s", pending_event_id);
        rebuilt.stop_seq = 0;
        rebuilt.stopped_at = (long long)time(NULL);
        if (!lea_local_emergency_stop_write(base_dir, &rebuilt)) return -1;
        return 1;
    }
    return 0; /* 无任何停控证据＝全新设备，未停控 */
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
    char tail[256];
    n = snprintf(tail, sizeof(tail),
                 "\",\"last_command_at\":%lld,\"emergency_stopped\":%s,\"emergency_stop_event_id\":\"",
                 s->last_command_at, s->emergency_stopped ? "true" : "false");
    if (n < 0 || o + (size_t)n + 1 > out_size) return 0;
    memcpy(out + o, tail, (size_t)n);
    o += (size_t)n;
    if (!json_escape_into(out, out_size, &o, s->emergency_stop_event_id)) return 0;
    const char *mid4 = "\",\"emergency_sync_status\":\"";
    if (o + strlen(mid4) + 1 > out_size) return 0;
    memcpy(out + o, mid4, strlen(mid4));
    o += strlen(mid4);
    if (!json_escape_into(out, out_size, &o, s->emergency_sync_status)) return 0;
    if (o + 3 > out_size) return 0;
    out[o++] = '"';
    out[o++] = '}';
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
    if (json_get_bool(text, "emergency_stopped", &b)) tmp.emergency_stopped = b;
    /* 字符串字段：键存在但解不出（未闭合／溢出）即整单失败。 */
    if (strstr(text, "\"account_id\"") &&
        !json_get_string(text, "account_id", tmp.account_id, sizeof(tmp.account_id))) return 0;
    if (strstr(text, "\"device_id\"") &&
        !json_get_string(text, "device_id", tmp.device_id, sizeof(tmp.device_id))) return 0;
    if (strstr(text, "\"last_command\"") &&
        !json_get_string(text, "last_command", tmp.last_command, sizeof(tmp.last_command))) return 0;
    if (strstr(text, "\"last_result\"") &&
        !json_get_string(text, "last_result", tmp.last_result, sizeof(tmp.last_result))) return 0;
    if (strstr(text, "\"emergency_stop_event_id\"") &&
        !json_get_string(text, "emergency_stop_event_id", tmp.emergency_stop_event_id, sizeof(tmp.emergency_stop_event_id))) return 0;
    if (strstr(text, "\"emergency_sync_status\"") &&
        !json_get_string(text, "emergency_sync_status", tmp.emergency_sync_status, sizeof(tmp.emergency_sync_status))) return 0;
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
    /* emergency_stop：标记文件是实时态，永远覆盖快照里的对应字段。
     * 文件损坏即按已停控（fail-closed），事件 ID 不可信即留空。 */
    {
        lea_emergency_stop_t est;
        int erc = lea_local_emergency_stop_read(base_dir, &est);
        if (erc == 1) {
            out->emergency_stopped = est.stopped;
            snprintf(out->emergency_stop_event_id, sizeof(out->emergency_stop_event_id),
                     "%s", est.stopped ? est.stop_event_id : "");
            snprintf(out->emergency_sync_status, sizeof(out->emergency_sync_status),
                     "%s", est.stopped ? est.sync_status : "");
        } else if (erc == -1) {
            out->emergency_stopped = 1;
            out->emergency_stop_event_id[0] = '\0';
            out->emergency_sync_status[0] = '\0';
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
        fprintf(stderr, "usage: QFRLEA.exe --status\n");
        return 2;
    }
    const char *cmd = argv[1];
    /* v6 裁决（2026-11-17，站长）：正式版 CLI 只保留 --status 只读查询；
     * 5 个改状态子命令在派发入口显式拒绝。拒绝发生在任何状态访问之前，
     * 与调用方权限无关（即使管理员也拒绝），且绝不改状态。底层状态读写
     * 函数供已签名已审计的信封通路调用（见 QFRLEA.c handle_envelope
     * 内联 lea.* 命令）；管道侧 --internal 的 5 个改状态命令同样拒绝
     * （A7，见 lea_internal_state_command）。
     * 识别集合（lea_is_local_control_subcommand）仍含这 5 个名字，目的
     * 是让它们进到这里拿明确的 unsupported 错误，而不是落到 main() 的
     * 服务启动分支。 */
    if (strcmp(cmd, "--pause") == 0 ||
        strcmp(cmd, "--resume") == 0 ||
        strcmp(cmd, "--revoke-all-keys") == 0 ||
        strcmp(cmd, "--authorize-dangerous") == 0 ||
        strcmp(cmd, "--revoke-dangerous-consent") == 0) {
        printf("{\"ok\":false,\"error\":\"unsupported-command\"}\n");
        return 2;
    }
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
    /* 不可达：cmd 必为 6 个子命令之一，5 个改状态已在入口拒绝，未知
     * 子命令已被集合检查挡住。防御性返回用法错误。 */
    fprintf(stderr, "usage: QFRLEA.exe --status\n");
    return 2;
}
