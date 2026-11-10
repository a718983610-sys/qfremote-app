/* qf-lea-client —— QFRLEA 命名管道客户端（随包下发的小程序）。
 *
 * 用途：接 MeshCentral runcommands 的命令（SYSTEM 身份执行），把一行 JSON
 * 信封转命名管道发给 QFRLEA 服务，收一行 JSON 响应并打印到 stdout
 * （runcommands 回传给服务端）。
 *
 * 用法（下发动词统一，S3，DESIGN §3）：
 *   qf-lea-client.exe dispatch "<base64 信封>"
 *     （服务端小信封的唯一内联形态；客户端 Base64 解码后发往管道。
 *      Base64 字母表对 runcommands／cmd.exe 安全；裸 JSON 含 `"` 且
 *      params 可含用户输入的 `& % " ^ | < >` 等 shell 元字符，故不走裸 JSON。）
 *   qf-lea-client.exe apply "<inbox 文件全路径>"
 *     （服务端大信封第二步；文件内容为原始 JSON 信封。裸文件名解析到
 *      C:\ProgramData\QFR\LEA\inbox\；与 --file 同义。）
 *   qf-lea-client.exe "<一行 JSON 信封>"
 *   qf-lea-client.exe --file <信封文件路径>
 *   echo "<一行 JSON 信封>" | qf-lea-client.exe
 *   qf-lea-client.exe --internal "<一行内部命令 JSON>"
 *     （内部命令：{"cmd":"session.login_changed",...} 等，供主程序／安装
 *      脚本以 SYSTEM 身份通知 LEA；同样走管道，不走信封验签）
 *
 * 动词缺参或 dispatch Base64 解码失败时退出码 2 且绝不把动词原文发往
 * 管道（S3 原 bug：旧 main 把 "dispatch" 当信封原文发出，还收到了
 * 服务端的假成功响应）。
 *
 * 超时：连管道 2s（WaitNamedPipeW，DESIGN §3）；执行等待按信封 timeout_ms
 * 另加 5s（默认 30s）。响应原样打印到 stdout。
 * 退出码：0=服务回 ok:true；1=服务回 ok:false；2=本机错误（连不上管道、
 * 读写失败、参数错误等，此时同样向 stdout 打印一行 JSON 错误，便于
 * runcommands 回传时可读）。
 *
 * 安全：本程序不执行业务命令、不存密钥、不做准入判断（准入在服务端＋
 * QFRLEA 服务两层做）；只做管道搬运。
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "lea_crypto.h" /* S3：dispatch 用 lea_b64_decode（纯 C，无 Win32 依赖） */

#define PIPE_NAME_W L"\\\\.\\pipe\\QFR\\LEA\\v1"
#define CONNECT_TIMEOUT_MS 2000
#define MAX_ENVELOPE 65536
#define MAX_RESPONSE 65536
#define LEA_INBOX_DIR "C:\\ProgramData\\QFR\\LEA\\inbox"

static void print_error_json(const char *code, const char *detail) {
    printf("{\"ok\":false,\"code\":\"%s\",\"request_id\":\"\",\"retryable\":false,"
           "\"detail\":\"%s\",\"result\":null}\n",
           code, detail);
    fflush(stdout);
}

/* F4：只认顶层对象成员（深度 1）——旧实现用 strstr 全文找键，params 里
 * 嵌套的同名键（如 "timeout_ms"）会遮蔽顶层值（与 S1/S2/S4 残留同根，
 * 见 fixclean-REPORT §5 第 4 项）；嵌套 "cmd" 还会把信封误判成内部命令
 * （等待时间从 30s 错成 10s）。本扫描跳过字符串内容、按结构只认顶层；
 * 键含 \u 转义时不认（顶层键由服务端生成，fail-closed）。 */
static const char *json_skip_ws(const char *p) {
    while (*p == ' ' || *p == '\t' || *p == '\n' || *p == '\r') p++;
    return p;
}

/* p 指向开引号：跳过一个 JSON 字符串（含 \" \\ \/ \b \f \n \r \t \uXXXX），
 * 返回尾后指针；不合法返回 NULL。 */
static const char *json_skip_string(const char *p) {
    if (*p != '"') return NULL;
    p++;
    while (*p) {
        if (*p == '\\') {
            if (!p[1]) return NULL;
            if (p[1] == 'u') {
                int i;
                for (i = 0; i < 4; i++) {
                    char c = p[2 + i];
                    if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F'))) return NULL;
                }
                p += 6;
            } else {
                p += 2;
            }
        } else if (*p == '"') {
            return p + 1;
        } else if ((unsigned char)*p < 0x20) {
            return NULL;
        } else {
            p++;
        }
    }
    return NULL;
}

/* 跳过一个 JSON 值（对象／数组／字符串／数字／true／false／null），返回尾后指针。 */
static const char *json_skip_value(const char *p) {
    p = json_skip_ws(p);
    if (*p == '"') return json_skip_string(p);
    if (*p == '{') {
        p++;
        p = json_skip_ws(p);
        if (*p == '}') return p + 1;
        for (;;) {
            if (*p != '"') return NULL;
            p = json_skip_string(p);
            if (!p) return NULL;
            p = json_skip_ws(p);
            if (*p != ':') return NULL;
            p = json_skip_value(p + 1);
            if (!p) return NULL;
            p = json_skip_ws(p);
            if (*p == ',') { p++; p = json_skip_ws(p); continue; }
            if (*p == '}') return p + 1;
            return NULL;
        }
    }
    if (*p == '[') {
        p++;
        p = json_skip_ws(p);
        if (*p == ']') return p + 1;
        for (;;) {
            p = json_skip_value(p);
            if (!p) return NULL;
            p = json_skip_ws(p);
            if (*p == ',') { p++; continue; }
            if (*p == ']') return p + 1;
            return NULL;
        }
    }
    if (strncmp(p, "true", 4) == 0) return p + 4;
    if (strncmp(p, "false", 5) == 0) return p + 5;
    if (strncmp(p, "null", 4) == 0) return p + 4;
    {
        const char *s = p;
        if (*s == '-') s++;
        if (!(*s >= '0' && *s <= '9')) return NULL;
        while ((*s >= '0' && *s <= '9') || *s == '.' || *s == 'e' || *s == 'E' || *s == '+' || *s == '-') s++;
        return s;
    }
}

/* 在顶层对象里找成员 key，返回指向值首的指针（已跳过空白），找不到返回 NULL。 */
static const char *json_top_level_value(const char *text, const char *key) {
    const char *p = json_skip_ws(text);
    size_t klen = strlen(key);
    if (*p != '{') return NULL;
    p++;
    p = json_skip_ws(p);
    if (*p == '}') return NULL;
    for (;;) {
        const char *kstart;
        const char *kend;
        if (*p != '"') return NULL;
        kstart = p + 1;
        kend = json_skip_string(p);
        if (!kend) return NULL;
        if ((size_t)(kend - 1 - kstart) == klen && memcmp(kstart, key, klen) == 0) {
            p = json_skip_ws(kend);
            if (*p != ':') return NULL;
            return json_skip_ws(p + 1);
        }
        p = json_skip_ws(kend);
        if (*p != ':') return NULL;
        p = json_skip_value(p + 1);
        if (!p) return NULL;
        p = json_skip_ws(p);
        if (*p == ',') { p++; p = json_skip_ws(p); continue; }
        if (*p == '}') return NULL;
        return NULL;
    }
}

static int json_long_field(const char *text, const char *key, long long *out) {
    const char *p = json_top_level_value(text, key);
    if (!p) return 0;
    if (*p == '"') return 0;
    char *end = NULL;
    long long v = strtoll(p, &end, 10);
    if (end == p) return 0;
    *out = v;
    return 1;
}

/* 顶层是否存在 key（任意值类型）。 */
static int json_top_level_has_key(const char *text, const char *key) {
    return json_top_level_value(text, key) != NULL;
}

static int read_all_stdin(char *buf, size_t size) {
    size_t total = 0;
    size_t r;
    while (total + 1 < size &&
           (r = fread(buf + total, 1, size - total - 1, stdin)) > 0) {
        total += r;
    }
    buf[total] = '\0';
    /* 去掉末尾换行 */
    while (total > 0 && (buf[total - 1] == '\n' || buf[total - 1] == '\r'))
        buf[--total] = '\0';
    return total > 0;
}

static int read_file_all(const char *path, char *buf, size_t size) {
    FILE *f = fopen(path, "rb");
    if (!f) return 0;
    size_t total = fread(buf, 1, size - 1, f);
    fclose(f);
    buf[total] = '\0';
    while (total > 0 && (buf[total - 1] == '\n' || buf[total - 1] == '\r'))
        buf[--total] = '\0';
    return total > 0;
}

/* S3：apply 的参数是 inbox 文件全路径；裸文件名解析到 inbox 目录
 * （兼容服务端旧形态 `apply <request_id>.json`）。含分隔符／盘符的
 * 按原样用。返回 0=路径放不下。 */
static int resolve_apply_path(const char *arg, char *out, size_t out_size) {
    if (strchr(arg, '\\') || strchr(arg, '/') || strchr(arg, ':')) {
        if (strlen(arg) >= out_size) return 0;
        snprintf(out, out_size, "%s", arg);
        return 1;
    }
    if (strlen(LEA_INBOX_DIR) + 1 + strlen(arg) >= out_size) return 0;
    snprintf(out, out_size, "%s\\%s", LEA_INBOX_DIR, arg);
    return 1;
}

int main(int argc, char **argv) {
    static char envelope[MAX_ENVELOPE + 1];
    envelope[0] = '\0';

    if (argc >= 3 && strcmp(argv[1], "dispatch") == 0) {
        /* S3 统一下发动词：dispatch <base64 信封>。解码失败／解出空串／
         * 超长时退出 2，绝不把动词或乱码发往管道。 */
        long n = lea_b64_decode(argv[2], (unsigned char *)envelope,
                                sizeof(envelope) - 1);
        if (n <= 0) {
            print_error_json("QFR_LEA_CLIENT_BAD_DISPATCH", "dispatch-base64-decode-failed");
            return 2;
        }
        envelope[n] = '\0';
    } else if (argc >= 3 && strcmp(argv[1], "apply") == 0) {
        /* S3 统一下发动词：apply <inbox 文件全路径|裸文件名>；
         * 文件内容为原始 JSON 信封（与 --file 同义）。 */
        char path[1024];
        if (!resolve_apply_path(argv[2], path, sizeof(path)) ||
            !read_file_all(path, envelope, sizeof(envelope))) {
            print_error_json("QFR_LEA_CLIENT_FILE_READ_FAILED", "cannot-read-envelope-file");
            return 2;
        }
    } else if (argc == 2 && (strcmp(argv[1], "dispatch") == 0 ||
                             strcmp(argv[1], "apply") == 0)) {
        /* S3：动词缺参数时绝不能把动词原文当信封发往管道（原 bug）。 */
        fprintf(stderr, "usage: qf-lea-client.exe dispatch <base64> | apply <file>\n");
        print_error_json("QFR_LEA_CLIENT_NO_INPUT", "missing-verb-argument");
        return 2;
    } else if (argc >= 3 && strcmp(argv[1], "--file") == 0) {
        if (!read_file_all(argv[2], envelope, sizeof(envelope))) {
            print_error_json("QFR_LEA_CLIENT_FILE_READ_FAILED", "cannot-read-envelope-file");
            return 2;
        }
    } else if (argc >= 3 && strcmp(argv[1], "--internal") == 0) {
        if (strlen(argv[2]) >= sizeof(envelope)) {
            print_error_json("QFR_LEA_CLIENT_ENVELOPE_OVERSIZE", "internal-too-large");
            return 2;
        }
        snprintf(envelope, sizeof(envelope), "%s", argv[2]);
    } else if (argc >= 2) {
        if (strlen(argv[1]) >= sizeof(envelope)) {
            print_error_json("QFR_LEA_CLIENT_ENVELOPE_OVERSIZE", "envelope-too-large");
            return 2;
        }
        snprintf(envelope, sizeof(envelope), "%s", argv[1]);
    } else {
        if (!read_all_stdin(envelope, sizeof(envelope))) {
            fprintf(stderr, "usage: qf-lea-client.exe dispatch \"<base64>\" | apply \"<file>\" | \"<json envelope>\" | --file <path> | --internal \"<json>\"\n");
            print_error_json("QFR_LEA_CLIENT_NO_INPUT", "no-envelope");
            return 2;
        }
    }
    if (envelope[0] == '\0') {
        print_error_json("QFR_LEA_CLIENT_NO_INPUT", "empty-envelope");
        return 2;
    }

    /* 执行等待超时：信封 timeout_ms + 5s；内部命令默认 10s；上限 305s。 */
    long long tmo = 0;
    long wait_ms = 30000;
    if (json_long_field(envelope, "timeout_ms", &tmo) && tmo >= 1 && tmo <= 300000)
        wait_ms = (long)(tmo + 5000);
    else if (json_top_level_has_key(envelope, "cmd"))
        wait_ms = 10000;

    if (!WaitNamedPipeW(PIPE_NAME_W, CONNECT_TIMEOUT_MS)) {
        DWORD e = GetLastError();
        char detail[128];
        snprintf(detail, sizeof(detail), "pipe-connect-failed-or-service-not-running:%lu",
                 (unsigned long)e);
        print_error_json("QFR_LEA_NOT_INSTALLED", detail);
        return 2;
    }
    HANDLE pipe = CreateFileW(PIPE_NAME_W, GENERIC_READ | GENERIC_WRITE, 0, NULL,
                              OPEN_EXISTING, FILE_FLAG_OVERLAPPED, NULL);
    if (pipe == INVALID_HANDLE_VALUE) {
        print_error_json("QFR_LEA_NOT_INSTALLED", "pipe-open-failed");
        return 2;
    }
    DWORD mode = PIPE_READMODE_BYTE;
    SetNamedPipeHandleState(pipe, &mode, NULL, NULL);

    size_t slen = strlen(envelope);
    char *sendbuf = (char *)malloc(slen + 2);
    if (!sendbuf) {
        CloseHandle(pipe);
        print_error_json("QFR_LEA_CLIENT_INTERNAL", "alloc-failed");
        return 2;
    }
    memcpy(sendbuf, envelope, slen);
    sendbuf[slen] = '\n';
    sendbuf[slen + 1] = '\0';
    DWORD written = 0;
    OVERLAPPED ov;
    memset(&ov, 0, sizeof(ov));
    ov.hEvent = CreateEventW(NULL, TRUE, FALSE, NULL);
    if (!ov.hEvent) {
        free(sendbuf);
        CloseHandle(pipe);
        print_error_json("QFR_LEA_CLIENT_INTERNAL", "event-failed");
        return 2;
    }
    BOOL wr = WriteFile(pipe, sendbuf, (DWORD)(slen + 1), &written, &ov);
    if (!wr && GetLastError() == ERROR_IO_PENDING) {
        if (WaitForSingleObject(ov.hEvent, CONNECT_TIMEOUT_MS) != WAIT_OBJECT_0 ||
            !GetOverlappedResult(pipe, &ov, &written, FALSE)) {
            CancelIo(pipe);
            CloseHandle(ov.hEvent);
            free(sendbuf);
            CloseHandle(pipe);
            print_error_json("QFR_LEA_CLIENT_WRITE_FAILED", "pipe-write-timeout");
            return 2;
        }
    } else if (!wr) {
        CloseHandle(ov.hEvent);
        free(sendbuf);
        CloseHandle(pipe);
        print_error_json("QFR_LEA_CLIENT_WRITE_FAILED", "pipe-write-failed");
        return 2;
    }
    free(sendbuf);
    if (written != slen + 1) {
        CloseHandle(ov.hEvent);
        CloseHandle(pipe);
        print_error_json("QFR_LEA_CLIENT_WRITE_FAILED", "pipe-write-short");
        return 2;
    }

    /* 读一行响应（带 deadline）。 */
    static char resp[MAX_RESPONSE + 1];
    size_t total = 0;
    int ok_read = 0;
    char chunk[4096];
    DWORD deadline = (DWORD)wait_ms;
    while (total + 1 < sizeof(resp)) {
        DWORD got = 0;
        memset(&ov, 0, sizeof(ov));
        ov.hEvent = CreateEventW(NULL, TRUE, FALSE, NULL);
        if (!ov.hEvent) break;
        BOOL r = ReadFile(pipe, chunk, sizeof(chunk), &got, &ov);
        if (!r && GetLastError() == ERROR_IO_PENDING) {
            DWORD w = WaitForSingleObject(ov.hEvent, deadline);
            if (w != WAIT_OBJECT_0) {
                CancelIo(pipe);
                CloseHandle(ov.hEvent);
                break;
            }
            if (!GetOverlappedResult(pipe, &ov, &got, FALSE)) {
                CloseHandle(ov.hEvent);
                break;
            }
        } else if (!r) {
            CloseHandle(ov.hEvent);
            break;
        }
        CloseHandle(ov.hEvent);
        /* T24：got==0（对端关闭）时，若已收到部分数据即视为本次响应结束
         * （无换行也以已收内容为准）；尚未收到任何数据则仍判无响应。
         * 管道短读是常态，不得把 got < sizeof(chunk) 当作完成。 */
        if (got == 0) { if (total > 0) ok_read = 1; break; }
        size_t take = got;
        if (total + take >= sizeof(resp)) take = sizeof(resp) - total - 1;
        memcpy(resp + total, chunk, take);
        total += take;
        resp[total] = '\0';
        if (memchr(chunk, '\n', got)) { ok_read = 1; break; }
        /* 短读继续读：只有读到换行、对端关闭或超时才算完成。 */
    }
    CloseHandle(pipe);
    if (!ok_read || total == 0) {
        print_error_json("QFR_LEA_TIMEOUT", "no-response-from-service-in-time");
        return 1;
    }
    char *nl = strchr(resp, '\n');
    if (nl) *nl = '\0';
    printf("%s\n", resp);
    fflush(stdout);
    /* 退出码：响应 ok:true → 0，否则 1。 */
    return strstr(resp, "\"ok\":true") ? 0 : 1;
}
