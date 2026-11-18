/* Replicates parent_is_main_app() step by step for a spawned child. */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <wtsapi32.h>
#include <tlhelp32.h>
#include <stdio.h>
#include <string.h>
#include <wchar.h>

int main(int argc, char **argv) {
    /* spawn a child (ping-like sleeper: wine's timeout.exe may not exist; use self with arg) */
    char cmdline[1024];
    snprintf(cmdline, sizeof(cmdline), "\"C:\\QFRLEA-wl-test\\wine-session-diag.exe\" child");
    STARTUPINFOA si; PROCESS_INFORMATION pi;
    ZeroMemory(&si, sizeof(si)); si.cb = sizeof(si);
    ZeroMemory(&pi, sizeof(pi));
    if (!CreateProcessA(NULL, cmdline, NULL, NULL, FALSE, 0, NULL, NULL, &si, &pi)) {
        printf("CreateProcess failed %lu\n", (unsigned long)GetLastError());
        return 3;
    }
    Sleep(500);
    DWORD child = pi.dwProcessId;
    printf("parent(self) pid=%lu child pid=%lu\n", (unsigned long)GetCurrentProcessId(), (unsigned long)child);
    /* toolhelp: find child's parent pid */
    HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    printf("snapshot=%s\n", snap == INVALID_HANDLE_VALUE ? "INVALID" : "ok");
    PROCESSENTRY32W pe; pe.dwSize = sizeof(pe);
    DWORD parent = 0;
    if (Process32FirstW(snap, &pe)) {
        do {
            if (pe.th32ProcessID == child) { parent = pe.th32ParentProcessID; break; }
        } while (Process32NextW(snap, &pe));
    }
    CloseHandle(snap);
    printf("toolhelp parent of child = %lu (expect self %lu)\n", (unsigned long)parent, (unsigned long)GetCurrentProcessId());
    DWORD psess = 0xDEAD;
    BOOL ok = ProcessIdToSessionId(parent, &psess);
    DWORD console = WTSGetActiveConsoleSessionId();
    printf("parent session=%lu (ok=%d) console=%lu match=%d\n",
           (unsigned long)psess, (int)ok, (unsigned long)console, (int)(psess == console));
    HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, parent);
    printf("OpenProcess(parent)=%s\n", h ? "ok" : "FAIL");
    if (h) {
        WCHAR img[MAX_PATH]; DWORD n = MAX_PATH;
        BOOL q = QueryFullProcessImageNameW(h, 0, img, &n);
        printf("QueryFullProcessImageNameW=%d n=%lu img=%ls\n", (int)q, (unsigned long)n, q ? img : L"(n/a)");
        CloseHandle(h);
    }
    /* also print child's own image as the service would see it */
    HANDLE hc = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, child);
    if (hc) {
        WCHAR img[MAX_PATH]; DWORD n = MAX_PATH;
        BOOL q = QueryFullProcessImageNameW(hc, 0, img, &n);
        printf("child image=%d n=%lu img=%ls\n", (int)q, (unsigned long)n, q ? img : L"(n/a)");
        CloseHandle(hc);
    }
    TerminateProcess(pi.hProcess, 0);
    WaitForSingleObject(pi.hProcess, INFINITE);
    CloseHandle(pi.hProcess); CloseHandle(pi.hThread);
    return 0;
}
