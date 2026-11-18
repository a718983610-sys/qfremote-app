/* Pipe diag: server accepts one connection and calls GetNamedPipeClientProcessId.
 * Usage: wine pipe-diag.exe server  |  wine pipe-diag.exe client
 * Run server in background, then client. Server prints the result. */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>
#include <string.h>

int main(int argc, char **argv) {
    if (argc > 1 && strcmp(argv[1], "client") == 0) {
        HANDLE h = CreateFileA("\\\\.\\pipe\\WLDIAG\\v1", GENERIC_READ | GENERIC_WRITE,
                               0, NULL, OPEN_EXISTING, 0, NULL);
        if (h == INVALID_HANDLE_VALUE) { printf("client: connect failed %lu\n", (unsigned long)GetLastError()); return 1; }
        printf("client: connected, pid=%lu, sleeping\n", (unsigned long)GetCurrentProcessId());
        Sleep(3000);
        CloseHandle(h);
        return 0;
    }
    HANDLE hPipe = CreateNamedPipeA("\\\\.\\pipe\\WLDIAG\\v1",
        PIPE_ACCESS_DUPLEX, PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
        1, 4096, 4096, 0, NULL);
    if (hPipe == INVALID_HANDLE_VALUE) { printf("server: create failed %lu\n", (unsigned long)GetLastError()); return 1; }
    printf("server: waiting for client (pid=%lu)\n", (unsigned long)GetCurrentProcessId());
    BOOL c = ConnectNamedPipe(hPipe, NULL);
    printf("server: ConnectNamedPipe=%d err=%lu\n", (int)c, (unsigned long)GetLastError());
    DWORD pid = 0xDEAD;
    BOOL ok = GetNamedPipeClientProcessId(hPipe, &pid);
    printf("server: GetNamedPipeClientProcessId ok=%d pid=%lu (err=%lu)\n",
           (int)ok, (unsigned long)pid, (unsigned long)GetLastError());
    /* also try server pid for contrast */
    DWORD spid = 0xDEAD;
    BOOL ok2 = GetNamedPipeServerProcessId(hPipe, &spid);
    printf("server: GetNamedPipeServerProcessId ok=%d pid=%lu (err=%lu)\n",
           (int)ok2, (unsigned long)spid, (unsigned long)GetLastError());
    Sleep(3500);
    CloseHandle(hPipe);
    return 0;
}
