/* QFRemote.exe parent stub — ONLY for Wine smoke tests (A7-whitelist line).
 * Spawns the real qf-lea-client.exe as its child so the service's caller
 * gate (internal_caller_allowed -> parent_is_main_app) sees a QFRemote.exe
 * parent in the console session. Never ship; test prefix only.
 * Usage: QFRemote.exe --internal-b64 <base64>   (args forwarded verbatim)
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>
#include <string.h>

int main(int argc, char **argv) {
    if (argc < 2) {
        fprintf(stderr, "usage: QFRemote.exe <client-args...>\n");
        return 2;
    }
    char cmdline[8192];
    snprintf(cmdline, sizeof(cmdline), "\"C:\\QFRLEA-wl-test\\qf-lea-client.exe\"");
    for (int i = 1; i < argc; i++) {
        strncat(cmdline, " ", sizeof(cmdline) - strlen(cmdline) - 1);
        strncat(cmdline, argv[i], sizeof(cmdline) - strlen(cmdline) - 1);
    }
    STARTUPINFOA si;
    PROCESS_INFORMATION pi;
    ZeroMemory(&si, sizeof(si));
    si.cb = sizeof(si);
    ZeroMemory(&pi, sizeof(pi));
    if (!CreateProcessA(NULL, cmdline, NULL, NULL, FALSE, 0, NULL, NULL, &si, &pi)) {
        fprintf(stderr, "CreateProcess failed: %lu\n", (unsigned long)GetLastError());
        return 3;
    }
    WaitForSingleObject(pi.hProcess, INFINITE);
    DWORD code = 0;
    GetExitCodeProcess(pi.hProcess, &code);
    CloseHandle(pi.hProcess);
    CloseHandle(pi.hThread);
    return (int)code;
}
