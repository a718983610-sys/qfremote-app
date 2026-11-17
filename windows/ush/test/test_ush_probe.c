/* test_ush_probe.c — N-11 pipe_probe_alive 回归单测（mingw 编译，wine 下跑）。
 *
 * 覆盖：
 *  ① 对假 USH 管道服务连续探活 50 次，每次都返回 alive=1（改写后写／读
 *     两段共用一个事件仍能正常走完：写等待→ResetEvent→读等待→读结果）。
 *  ② 50 次探活前后进程句柄数不变（修前每次泄漏 1 个事件句柄：写事件
 *     在 memset 覆盖 OVERLAPPED 后丢失且永不关闭；修后全程只建一个
 *     事件、只关一次）。沙箱 Wine 的 GetProcessHandleCount 是 stub
 *     （恒报 0），此时该断言记 SKIP、真机验；泄漏／双关的结构面由
 *     grep 核对兜底（见③）。
 *  ③ 双关的静态面由 grep 核对（见报告）：函数内 CreateEventW 出现 1 次、
 *     CloseHandle(ev) 出现 1 次，无 memset 丢句柄路径。
 * 用法：x86_64-w64-mingw32-gcc -O2 -Wall -Wextra -std=c11
 *   -D_WIN32_WINNT=0x0A00 -DWINVER=0x0A00 -I.. -o /tmp/test_ush_probe.exe
 *   test_ush_probe.c ../ush_json.c ../ush_log.c ../ush_uia.c ../ush_snapshot.c ../ush_selfbind.c
 *   -lole32 -loleaut32 -luuid -lwtsapi32 -lgdi32 -luser32 -lbcrypt -lwindowscodecs -lwinhttp -lncrypt -lcrypt32
 *   wine64 /tmp/test_ush_probe.exe
 * 注意：本文件以 #define main 改名后 #include ../ush.c 以测 static 的
 * pipe_probe_alive，不得再单独链接 ../ush.c（会重定义）。
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define main ush_disabled_main
#include "../ush.c"
#undef main

#define PROBE_COUNT 50

static int g_pass = 0, g_fail = 0;
static void t(int cond, const char *name) {
    if (cond) { g_pass++; printf("PASS %s\n", name); }
    else { g_fail++; printf("FAIL %s\n", name); }
}

static volatile LONG g_server_stop = 0;

/* 假 USH 管道服务：接一行 ui.ping，回 {"ok":true}。只服务探活，不做鉴权。 */
static DWORD WINAPI fake_server_thread(LPVOID unused) {
    (void)unused;
    HANDLE pipe = CreateNamedPipeW(L"\\\\.\\pipe\\QFR\\LEA\\UserHelper\\v1",
        PIPE_ACCESS_DUPLEX, PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
        1, 4096, 4096, 0, NULL);
    if (pipe == INVALID_HANDLE_VALUE) return 1;
    for (;;) {
        BOOL connected = ConnectNamedPipe(pipe, NULL);
        if (InterlockedCompareExchange(&g_server_stop, 0, 0) == 1) {
            if (connected) DisconnectNamedPipe(pipe);
            break;
        }
        if (!connected && GetLastError() != ERROR_PIPE_CONNECTED) continue;
        char buf[1024];
        DWORD read = 0;
        /* 读一行（探活只发一行）；读到即回 ok:true。 */
        size_t n = 0;
        while (n + 1 < sizeof(buf)) {
            char c = 0;
            DWORD got = 0;
            if (!ReadFile(pipe, &c, 1, &got, NULL) || got == 0) break;
            buf[n++] = c;
            if (c == '\n') break;
        }
        buf[n] = '\0';
        (void)read;
        const char *resp = "{\"ok\":true,\"code\":\"done\",\"request_id\":\"ush-startup-probe\"}\n";
        DWORD written = 0;
        WriteFile(pipe, resp, (DWORD)strlen(resp), &written, NULL);
        FlushFileBuffers(pipe);
        DisconnectNamedPipe(pipe);
    }
    CloseHandle(pipe);
    return 0;
}

int main(void) {
    HANDLE srv = CreateThread(NULL, 0, fake_server_thread, NULL, 0, NULL);
    if (!srv) { printf("FAIL fake server thread not created\n"); return 1; }
    /* 等管道建好（WaitNamedPipe 500ms 内可达即就绪）。 */
    int ready = 0;
    for (int i = 0; i < 50 && !ready; i++) {
        if (WaitNamedPipeW(L"\\\\.\\pipe\\QFR\\LEA\\UserHelper\\v1", 200)) ready = 1;
        else Sleep(100);
    }
    t(ready, "N-11 假 USH 管道服务就绪");

    DWORD handles_before = 0, handles_after = 0;
    int counts_ok = GetProcessHandleCount(GetCurrentProcess(), &handles_before);
    int alive_ok = 0;
    for (int i = 0; i < PROBE_COUNT; i++) {
        if (pipe_probe_alive()) alive_ok++;
    }
    if (counts_ok) counts_ok = GetProcessHandleCount(GetCurrentProcess(), &handles_after);
    printf("  [probe] %d/%d alive, handles before=%lu after=%lu\n",
           alive_ok, PROBE_COUNT,
           (unsigned long)handles_before, (unsigned long)handles_after);
    t(alive_ok == PROBE_COUNT, "N-11 连续 50 次探活均返回 alive=1（单事件改写不断路）");
    /* Wine 的 GetProcessHandleCount 是 stub（恒报 0），0==0 不能当泄漏
     * 证据：计数须大于 0 才采信，否则记 SKIP（真机验）。泄漏／双关的
     * 结构面由 grep 核对兜底：函数内 CreateEventW 仅 1 处、CloseHandle
     * 仅 1 处，且 CreateEventW 与 CloseHandle 之间无提前 return——
     * 单事件单关在结构上即无泄漏、无双关。 */
    if (counts_ok && handles_before > 0) {
        t(handles_after == handles_before,
          "N-11 50 次探活后进程句柄数不变（无事件句柄泄漏）");
    } else {
        printf("SKIP N-11 句柄数核对（本 wine 前缀 GetProcessHandleCount 报 0，属 stub，真机验）\n");
    }

    /* 停假服务：置停标志＋一次空连接唤醒 ConnectNamedPipe。 */
    InterlockedExchange(&g_server_stop, 1);
    {
        HANDLE h = CreateFileW(L"\\\\.\\pipe\\QFR\\LEA\\UserHelper\\v1",
            GENERIC_READ | GENERIC_WRITE, 0, NULL, OPEN_EXISTING, 0, NULL);
        if (h != INVALID_HANDLE_VALUE) CloseHandle(h);
    }
    WaitForSingleObject(srv, 5000);
    CloseHandle(srv);

    printf("----\n%d passed, %d failed\n", g_pass, g_fail);
    return g_fail ? 1 : 0;
}
