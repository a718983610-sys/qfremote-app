/* pipe_server —— QFRLEA 命名管道最小替身（仅 S3 真客户端单测用，绝不进生产包）。
 *
 * 用途：冒充 QFRLEA 服务，验证服务端下发的命令经真客户端
 * qf-lea-client.exe 后，管道收到的确实是完整 JSON 信封（S3 回归）：
 *   旧 bug 下管道收到的是字面量 "dispatch"／"apply"。
 *
 * 用法（均由 server/ext/lea/test/test-lea-realclient.js 驱动）：
 *   pipe_server.exe <capture 文件 Win 路径> <响应 JSON（一行）> <ready 文件 Win 路径>
 * 建 \\.\pipe\QFR\LEA\v1，建好后先写 ready 文件（调用方以此判定可连接），
 * 接一个客户端，读一行原文写入 capture 文件，回一行响应 JSON，退出 0。
 * 只接一个连接；客户端不来时调用方负责杀掉本进程。
 *
 * 构建（Linux 沙箱交叉编译）：
 *   x86_64-w64-mingw32-gcc -O2 -Wall -Wextra -o pipe_server.exe pipe_server.c
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>
#include <string.h>

int main(int argc, char **argv) {
    if (argc < 4) {
        fprintf(stderr, "usage: pipe_server.exe <capture> <response> <ready>\n");
        return 2;
    }
    HANDLE pipe = CreateNamedPipeW(L"\\\\.\\pipe\\QFR\\LEA\\v1",
        PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED,
        PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
        1, 65536, 65536, 0, NULL);
    if (pipe == INVALID_HANDLE_VALUE) {
        fprintf(stderr, "create-pipe-failed %lu\n", (unsigned long)GetLastError());
        return 2;
    }
    /* 就绪信号：调用方轮询此文件出现后再跑客户端。 */
    FILE *rf = fopen(argv[3], "wb");
    if (rf) { fputs("ready", rf); fclose(rf); }
    BOOL ok = ConnectNamedPipe(pipe, NULL);
    if (!ok && GetLastError() != ERROR_PIPE_CONNECTED) {
        fprintf(stderr, "connect-failed %lu\n", (unsigned long)GetLastError());
        return 2;
    }
    static char buf[65537];
    DWORD total = 0, got = 0;
    while (total < sizeof(buf) - 1) {
        if (!ReadFile(pipe, buf + total, sizeof(buf) - 1 - total, &got, NULL) || got == 0) break;
        total += got;
        if (memchr(buf, '\n', total)) break;
    }
    buf[total] = '\0';
    char *nl = strchr(buf, '\n');
    if (nl) *nl = '\0';
    FILE *f = fopen(argv[1], "wb");
    if (!f) {
        fprintf(stderr, "capture-open-failed\n");
        return 2;
    }
    fwrite(buf, 1, strlen(buf), f);
    fclose(f);
    char resp[4096];
    snprintf(resp, sizeof(resp), "%s\n", argv[2]);
    DWORD written = 0;
    WriteFile(pipe, resp, (DWORD)strlen(resp), &written, NULL);
    FlushFileBuffers(pipe);
    DisconnectNamedPipe(pipe);
    CloseHandle(pipe);
    return 0;
}
