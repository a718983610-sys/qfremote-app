/* silent_probe.c — 低项 1 回归探针（QFSysHelper 读超时，mingw 交叉编译，wine 下跑）。
 *
 * 用法：silent_probe.exe <silent|ping>
 *   silent：连上管道后什么都不发，等服务端断开（读 30s 超时），打印
 *     elapsed_ms 并在 60s 内观测到断开时 exit 0；60s 仍不断开（修前
 *     永久占住唯一实例）即 exit 1。
 *   ping：连上后发一行垃圾请求，10s 内收到任意响应行即 exit 0（证明
 *     管道已释放、可服务）；超时／无响应即 exit 1。
 * 仅供开发／Wine 回归用，不随包下发。
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define PIPE_NAME_W L"\\\\.\\pipe\\QFSysHelper"

static HANDLE connect_pipe(void) {
    /* 15s 内重试等服务端建好管道（wine 启动慢）。 */
    DWORD t0 = GetTickCount();
    for (;;) {
        if (!WaitNamedPipeW(PIPE_NAME_W, 1000)) {
            if (GetTickCount() - t0 > 15000) return INVALID_HANDLE_VALUE;
            continue;
        }
        HANDLE h = CreateFileW(PIPE_NAME_W, GENERIC_READ | GENERIC_WRITE, 0, NULL,
                               OPEN_EXISTING, FILE_FLAG_OVERLAPPED, NULL);
        if (h != INVALID_HANDLE_VALUE) return h;
        if (GetTickCount() - t0 > 15000) return INVALID_HANDLE_VALUE;
        Sleep(200);
    }
}

static int mode_silent(void) {
    HANDLE h = connect_pipe();
    if (h == INVALID_HANDLE_VALUE) {
        fprintf(stderr, "silent: connect failed\n");
        return 1;
    }
    printf("silent: connected, sending nothing, waiting for server disconnect\n");
    fflush(stdout);
    OVERLAPPED ov;
    memset(&ov, 0, sizeof(ov));
    ov.hEvent = CreateEventW(NULL, TRUE, FALSE, NULL);
    if (!ov.hEvent) { CloseHandle(h); return 1; }
    char c = 0;
    DWORD got = 0;
    DWORD t0 = GetTickCount();
    BOOL r = ReadFile(h, &c, 1, &got, &ov);
    DWORD elapsed = 0;
    int disconnected = 0;
    if (!r && GetLastError() == ERROR_IO_PENDING) {
        DWORD w = WaitForSingleObject(ov.hEvent, 60000);
        elapsed = GetTickCount() - t0;
        if (w == WAIT_OBJECT_0) {
            /* 读完成（对端断开即读到 0 字节／BROKEN_PIPE）。 */
            disconnected = !GetOverlappedResult(h, &ov, &got, FALSE) || got == 0;
        }
    } else {
        elapsed = GetTickCount() - t0;
        disconnected = !r || got == 0;
    }
    printf("silent: elapsed_ms=%lu disconnected=%d\n", (unsigned long)elapsed, disconnected);
    fflush(stdout);
    CloseHandle(ov.hEvent);
    CloseHandle(h);
    /* 修后：服务端 30s 读超时即断开，elapsed 应在 25s~45s（wine 有抖动）；
     * 修前：60s 等满仍不断开，disconnected=0。 */
    if (disconnected && elapsed >= 25000 && elapsed <= 45000) return 0;
    return 1;
}

static int mode_ping(void) {
    HANDLE h = connect_pipe();
    if (h == INVALID_HANDLE_VALUE) {
        fprintf(stderr, "ping: connect failed\n");
        return 1;
    }
    const char *req = "garbage\n";
    OVERLAPPED ov;
    memset(&ov, 0, sizeof(ov));
    ov.hEvent = CreateEventW(NULL, TRUE, FALSE, NULL);
    if (!ov.hEvent) { CloseHandle(h); return 1; }
    DWORD written = 0;
    BOOL wr = WriteFile(h, req, (DWORD)strlen(req), &written, &ov);
    if (!wr && GetLastError() == ERROR_IO_PENDING) {
        if (WaitForSingleObject(ov.hEvent, 5000) != WAIT_OBJECT_0 ||
            !GetOverlappedResult(h, &ov, &written, FALSE)) {
            fprintf(stderr, "ping: write timeout\n");
            CloseHandle(ov.hEvent);
            CloseHandle(h);
            return 1;
        }
    } else if (!wr) {
        fprintf(stderr, "ping: write failed\n");
        CloseHandle(ov.hEvent);
        CloseHandle(h);
        return 1;
    }
    /* 读一行响应（10s 上限）。复用同一事件（只建一次、只关一次）。 */
    ResetEvent(ov.hEvent);
    static char resp[4096];
    size_t n = 0;
    DWORD t0 = GetTickCount();
    int got_line = 0;
    while (n + 1 < sizeof(resp)) {
        char c = 0;
        DWORD got = 0;
        OVERLAPPED rov;
        memset(&rov, 0, sizeof(rov));
        rov.hEvent = ov.hEvent;
        BOOL r = ReadFile(h, &c, 1, &got, &rov);
        if (!r && GetLastError() == ERROR_IO_PENDING) {
            if (WaitForSingleObject(rov.hEvent, 10000) != WAIT_OBJECT_0) break;
            if (!GetOverlappedResult(h, &rov, &got, FALSE) || got == 0) break;
        } else if (!r || got == 0) {
            break;
        }
        resp[n++] = c;
        if (c == '\n') { got_line = 1; break; }
    }
    DWORD elapsed = GetTickCount() - t0;
    resp[n] = '\0';
    printf("ping: elapsed_ms=%lu resp=%s", (unsigned long)elapsed, resp);
    fflush(stdout);
    CloseHandle(ov.hEvent);
    CloseHandle(h);
    return (got_line && strstr(resp, "\"ok\"") != NULL && elapsed <= 10000) ? 0 : 1;
}

int main(int argc, char **argv) {
    if (argc < 2) {
        fprintf(stderr, "usage: silent_probe.exe <silent|ping>\n");
        return 2;
    }
    if (strcmp(argv[1], "silent") == 0) return mode_silent();
    if (strcmp(argv[1], "ping") == 0) return mode_ping();
    fprintf(stderr, "unknown mode %s\n", argv[1]);
    return 2;
}
