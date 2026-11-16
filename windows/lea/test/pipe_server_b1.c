/* pipe_server_b1 —— B1 客户端硬时限测试替身（仅 B1 单测用，绝不进生产包）。
 *
 * 用途：冒充 QFRLEA 服务，验证新客户端 qf-lea-client.exe 的硬时限：
 *   ACK 2 秒、结果 6 秒，超时输出 timeout JSON 并 exit 0。
 *
 * 用法：
 *   pipe_server_b1.exe <mode> <capture 文件 Win 路径> <ready 文件 Win 路径> [delay_ms]
 *   mode:
 *     ack_result  先回 ACK 行，停 delay_ms（默认 500）再回结果行，退出 0。
 *     result      只回结果行（老版本服务行为：不发 ACK），退出 0。
 *     ack_only    只回 ACK 行，然后挂起 10 秒（客户端应在 6 秒结果时限到时退出）。
 *     silent      10 秒内什么都不回（客户端应在 2 秒 ACK 时限到时退出）。
 * 建 \\.\pipe\QFR\LEA\v1，建好后先写 ready 文件，接一个客户端，读一行
 * 原文写入 capture 文件，按 mode 回包，退出 0。只接一个连接。
 *
 * 构建（Linux 沙箱交叉编译）：
 *   x86_64-w64-mingw32-gcc -O2 -Wall -Wextra -o pipe_server_b1.exe pipe_server_b1.c
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static const char *ACK_LINE =
    "{\"ok\":true,\"code\":\"QFR_LEA_ACCEPTED\",\"request_id\":\"req-b1-test\","
    "\"job_id\":\"job_b1test\",\"retryable\":false,\"detail\":\"queued\",\"result\":null}\n";
static const char *RESULT_LINE =
    "{\"ok\":true,\"code\":\"done\",\"request_id\":\"req-b1-test\","
    "\"retryable\":false,\"detail\":\"\",\"result\":{\"version\":\"0.1.0\"}}\n";
/* R-C4 回归陷阱：顶层 ok:false，但嵌套 result 对象里含真实的 "ok":true
 * 成员（字节级确含 "ok":true 子串）。旧客户端用 strstr 判退出码会误判
 * 为成功（exit 0）；修后须按顶层 ok 字段判为失败（exit 1）。
 * 注意：detail 字符串里的 \"ok\":true 经 JSON 转义后字节为 \"ok\":true，
 * ok 后跟的是反斜杠而非引号，strstr 并不命中——真正的触发面是嵌套对象。 */
static const char *FAIL_TRAP_LINE =
    "{\"ok\":false,\"code\":\"QFR_LEA_TRAP\",\"request_id\":\"req-b1-test\","
    "\"retryable\":false,\"detail\":\"nested result carries ok\","
    "\"result\":{\"ok\":true,\"version\":\"0.1.0\"}}\n";
/* 普通失败对照：顶层 ok:false，无陷阱子串（新旧实现都应 exit 1）。 */
static const char *FAIL_LINE =
    "{\"ok\":false,\"code\":\"QFR_LEA_FAILED\",\"request_id\":\"req-b1-test\","
    "\"retryable\":false,\"detail\":\"plain failure\",\"result\":null}\n";

static void write_line(HANDLE pipe, const char *line) {
    DWORD written = 0;
    WriteFile(pipe, line, (DWORD)strlen(line), &written, NULL);
}

int main(int argc, char **argv) {
    if (argc < 4) {
        fprintf(stderr, "usage: pipe_server_b1.exe <ack_result|result|ack_only|silent> <capture> <ready> [delay_ms]\n");
        return 2;
    }
    const char *mode = argv[1];
    DWORD delay_ms = (argc >= 5) ? (DWORD)atoi(argv[4]) : 500;
    HANDLE pipe = CreateNamedPipeW(L"\\\\.\\pipe\\QFR\\LEA\\v1",
        PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED,
        PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
        1, 65536, 65536, 0, NULL);
    if (pipe == INVALID_HANDLE_VALUE) {
        fprintf(stderr, "create-pipe-failed %lu\n", (unsigned long)GetLastError());
        return 2;
    }
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
    FILE *f = fopen(argv[2], "wb");
    if (f) { fwrite(buf, 1, strlen(buf), f); fclose(f); }

    if (strcmp(mode, "ack_result") == 0) {
        write_line(pipe, ACK_LINE);
        Sleep(delay_ms);
        write_line(pipe, RESULT_LINE);
    } else if (strcmp(mode, "result") == 0) {
        write_line(pipe, RESULT_LINE);
    } else if (strcmp(mode, "result_fail_trap") == 0) {
        write_line(pipe, FAIL_TRAP_LINE);
    } else if (strcmp(mode, "result_fail") == 0) {
        write_line(pipe, FAIL_LINE);
    } else if (strcmp(mode, "ack_only") == 0) {
        write_line(pipe, ACK_LINE);
        Sleep(10000);
    } else if (strcmp(mode, "silent") == 0) {
        Sleep(10000);
    } else {
        fprintf(stderr, "unknown mode %s\n", mode);
        return 2;
    }
    FlushFileBuffers(pipe);
    DisconnectNamedPipe(pipe);
    CloseHandle(pipe);
    return 0;
}
