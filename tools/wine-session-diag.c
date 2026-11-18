/* Wine session diagnostic: prints what parent_is_main_app sees. */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <wtsapi32.h>
#include <stdio.h>
int main(int argc, char **argv) {
    if (argc > 1 && strcmp(argv[1], "child") == 0) { Sleep(15000); return 0; }
    DWORD self = GetCurrentProcessId();
    DWORD sess = 0xDEAD;
    BOOL ok = ProcessIdToSessionId(self, &sess);
    DWORD console = WTSGetActiveConsoleSessionId();
    WCHAR img[MAX_PATH];
    DWORD n = MAX_PATH;
    QueryFullProcessImageNameW(GetCurrentProcess(), 0, img, &n);
    printf("self pid=%lu session=%lu (ok=%d) console_session=%lu (0x%08lX)\n",
           (unsigned long)self, (unsigned long)sess, (int)ok,
           (unsigned long)console, (unsigned long)console);
    printf("self image n=%lu\n", (unsigned long)n);
    return 0;
}
