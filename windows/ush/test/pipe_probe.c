/* pipe_probe.c — USH 管道探活/冒烟客户端（Windows，mingw 交叉编译）。
 * 用法：pipe_probe.exe "<一行 JSON 请求>" [超时毫秒，默认 5000]
 * 打印 USH 的一行响应原文；退出码 0=收到 ok:true，1=收到 ok:false 或失败。
 * 仅供开发/真机冒烟用，不随包下发。
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define PIPE_NAME_W L"\\\\.\\pipe\\QFR\\LEA\\UserHelper\\v1"

int main(int argc, char **argv) {
    if (argc < 2) {
        fprintf(stderr, "usage: pipe_probe.exe \"<json request>\" [timeout_ms]\n");
        return 2;
    }
    DWORD timeout = argc > 2 ? (DWORD)atoi(argv[2]) : 5000;
    if (!WaitNamedPipeW(PIPE_NAME_W, timeout)) {
        fprintf(stderr, "WaitNamedPipe failed %lu\n", (unsigned long)GetLastError());
        return 1;
    }
    HANDLE h = CreateFileW(PIPE_NAME_W, GENERIC_READ | GENERIC_WRITE, 0, NULL,
                           OPEN_EXISTING, 0, NULL);
    if (h == INVALID_HANDLE_VALUE) {
        fprintf(stderr, "CreateFile failed %lu\n", (unsigned long)GetLastError());
        return 1;
    }
    char req[65536];
    snprintf(req, sizeof(req), "%s\n", argv[1]);
    DWORD written = 0;
    if (!WriteFile(h, req, (DWORD)strlen(req), &written, NULL)) {
        fprintf(stderr, "WriteFile failed %lu\n", (unsigned long)GetLastError());
        CloseHandle(h);
        return 1;
    }
    /* 读一行响应（逐字节，直到 \n；上限 16MB） */
    static char resp[16 * 1024 * 1024];
    size_t n = 0;
    DWORD start = GetTickCount();
    while (n + 1 < sizeof(resp)) {
        if (GetTickCount() - start > timeout) {
            fprintf(stderr, "read timeout\n");
            CloseHandle(h);
            return 1;
        }
        char c = 0;
        DWORD read = 0;
        if (!ReadFile(h, &c, 1, &read, NULL) || read == 0) break;
        if (c == '\n') break;
        resp[n++] = c;
    }
    resp[n] = '\0';
    CloseHandle(h);
    printf("%s\n", resp);
    return strstr(resp, "\"ok\":true") ? 0 : 1;
}
