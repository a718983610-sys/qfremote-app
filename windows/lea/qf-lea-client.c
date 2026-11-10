/* qf-lea-client —— QFRLEA 命名管道客户端（随包下发的小程序）。
 *
 * 用途：接 MeshCentral runcommands 的命令（SYSTEM 身份执行），把一行 JSON
 * 信封转命名管道发给 QFRLEA 服务，收一行 JSON 响应并打印到 stdout
 * （runcommands 回传给服务端）。
 *
 * 用法：
 *   qf-lea-client.exe "<一行 JSON 信封>"
 *   qf-lea-client.exe --file <信封文件路径>
 *   echo "<一行 JSON 信封>" | qf-lea-client.exe
 *   qf-lea-client.exe --internal "<一行内部命令 JSON>"
 *     （内部命令：{"cmd":"session.login_changed",...} 等，供主程序／安装
 *      脚本以 SYSTEM 身份通知 LEA；同样走管道，不走信封验签）
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

#define PIPE_NAME_W L"\\\\.\\pipe\\QFR\\LEA\\v1"
#define CONNECT_TIMEOUT_MS 2000
#define MAX_ENVELOPE 65536
#define MAX_RESPONSE 65536

static void print_error_json(const char *code, const char *detail) {
    printf("{\"ok\":false,\"code\":\"%s\",\"request_id\":\"\",\"retryable\":false,"
           "\"detail\":\"%s\",\"result\":null}\n",
           code, detail);
    fflush(stdout);
}

static int json_long_field(const char *text, const char *key, long long *out) {
    char pat[64];
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
    if (*p == '"') return 0;
    char *end = NULL;
    long long v = strtoll(p, &end, 10);
    if (end == p) return 0;
    *out = v;
    return 1;
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

int main(int argc, char **argv) {
    static char envelope[MAX_ENVELOPE + 1];
    envelope[0] = '\0';

    if (argc >= 3 && strcmp(argv[1], "--file") == 0) {
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
            fprintf(stderr, "usage: qf-lea-client.exe \"<json envelope>\" | --file <path> | --internal \"<json>\"\n");
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
    else if (strstr(envelope, "\"cmd\""))
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
        if (got == 0) break;
        size_t take = got;
        if (total + take >= sizeof(resp)) take = sizeof(resp) - total - 1;
        memcpy(resp + total, chunk, take);
        total += take;
        resp[total] = '\0';
        if (memchr(chunk, '\n', got)) { ok_read = 1; break; }
        if (got < sizeof(chunk)) { ok_read = 1; break; }
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
