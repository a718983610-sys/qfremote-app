/* QFSysHelper —— QFRemote SYSTEM helper 最小安全版（2.4.5）
 * =================================================================
 * 常驻 SYSTEM 服务，只做两件系统级活：
 *   ① heal-agent    —— 提权跑 agent-heal PS1（本机 agent 自愈）；
 *   ② install-lock  —— 安装锁服务 QFLockSvc（调锁组件 install.ps1）。
 * 通道：命名管道 \\.\pipe\QFSysHelper，一问一答一行 JSON。
 *
 * 安全边界（写死，不许放宽）：
 *   - 只收两个固定命令（协议解析见 protocol.c），命令名之外的一切
 *     字段都不采信；脚本路径只是定位符，执行前必算 SHA-256 对
 *     whitelist.h 里的白名单，hash 不对绝不执行；basename 必须与
 *     命令对应；Owner 再验一次字符集；
 *   - 不留执行任意脚本的口子：除两条白名单脚本外不执行任何文件，
 *     不接受调用方传来的命令行、参数串或环境变量；
 *   - 全部动作记日志：%ProgramData%\\QFRemote\\SysHelper\\helper.log；
 *   - 失败能回滚：安装脚本（install-system-services.ps1）负责
 *     sc create/start 失败时 sc delete＋删文件；本服务只做单次
 *     命令执行，无持久状态可回滚。
 *   - 已知局限（诚实说明）：hash 校验与 CreateProcess 之间存在
 *     TOCTOU 窗口（毫秒级）；本机已有管理员权限的攻击者本来就
 *     不需要走本服务。本服务防的是「普通用户权限的 App 被诱导
 *     去执行任意脚本」，不是防本机管理员。
 *
 * 构建（Linux 交叉编译）：
 *   x86_64-w64-mingw32-gcc -O2 -o QFSysHelper.exe QFSysHelper.c protocol.c -lbcrypt -ladvapi32
 *   whitelist.h 由 syshelper/gen_whitelist.py 从本次发版文件生成，
 *   脚本改动后必须重新生成＋重新编译，否则 hash 对不上、服务拒绝执行。
 * 调试：QFSysHelper.exe debug —— 前台跑管道循环（不注册 SCM），供 Wine 自测。
 */
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0A00
#endif
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <bcrypt.h>
#include <sddl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdarg.h>
#include "protocol.h"
#include "whitelist.h"

#define SERVICE_NAME_W L"QFSysHelper"
#define SERVICE_DISPLAY_W L"QFRemote 系统助手"
#define PIPE_NAME_W L"\\\\.\\pipe\\QFSysHelper"
#define LOG_DIR_SUFFIX L"\\QFRemote\\SysHelper"
#define LOG_FILE_SUFFIX L"\\QFRemote\\SysHelper\\helper.log"
#define EXEC_TIMEOUT_MS 150000
/* 低项 1（2026-11-15）：管道读写时限，与 USH #14 同口径（读 30s／写 10s）。 */
#define QF_PIPE_READ_TIMEOUT_MS 30000
#define QF_PIPE_WRITE_TIMEOUT_MS 10000

static SERVICE_STATUS_HANDLE g_status_handle = NULL;
static SERVICE_STATUS g_status;
static HANDLE g_stop_event = NULL;
static volatile LONG g_running = 1;

/* ---------- 日志 ---------- */
static void log_line(const char *fmt, ...) {
    WCHAR dir[MAX_PATH];
    WCHAR file[MAX_PATH];
    DWORD n = GetEnvironmentVariableW(L"ProgramData", dir, MAX_PATH);
    if (n == 0 || n >= MAX_PATH) {
        /* 回退：ProgramData 环境变量缺失时（极少数精简环境/Wine）用默认位置 */
        if (wcscpy_s(dir, MAX_PATH, L"C:\\ProgramData") != 0) return;
    }
    /* 逐级建目录：CreateDirectoryW 不会自动建父目录 */
    {
        WCHAR parent[MAX_PATH];
        if (wcscpy_s(parent, MAX_PATH, dir) != 0) return;
        if (wcscat_s(parent, MAX_PATH, L"\\QFRemote") != 0) return;
        CreateDirectoryW(parent, NULL);
    }
    if (wcscat_s(dir, MAX_PATH, LOG_DIR_SUFFIX) != 0) return;
    CreateDirectoryW(dir, NULL);
    if (wcscpy_s(file, MAX_PATH, dir) != 0) return;
    if (wcscat_s(file, MAX_PATH, L"\\helper.log") != 0) return;
    char line[2048];
    SYSTEMTIME st;
    GetLocalTime(&st);
    int off = snprintf(line, sizeof(line), "%04d-%02d-%02d %02d:%02d:%02d ",
        st.wYear, st.wMonth, st.wDay, st.wHour, st.wMinute, st.wSecond);
    if (off < 0) return;
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(line + off, sizeof(line) - (size_t)off, fmt, ap);
    va_end(ap);
    FILE *f = _wfopen(file, L"a");
    if (!f) return;
    fputs(line, f);
    fputc('\n', f);
    fclose(f);
}

/* ---------- SHA-256（BCrypt 系统实现） ---------- */
static int sha256_file_hex(const WCHAR *wpath, char out_hex[65]) {
    FILE *f = _wfopen(wpath, L"rb");
    if (!f) return 0;
    BCRYPT_ALG_HANDLE alg = NULL;
    BCRYPT_HASH_HANDLE hash = NULL;
    int ok = 0;
    if (BCryptOpenAlgorithmProvider(&alg, BCRYPT_SHA256_ALGORITHM, NULL, 0) != 0) goto done;
    if (BCryptCreateHash(alg, &hash, NULL, 0, NULL, 0, 0) != 0) goto done;
    {
        unsigned char buf[8192];
        size_t r;
        while ((r = fread(buf, 1, sizeof(buf), f)) > 0) {
            if (BCryptHashData(hash, buf, (ULONG)r, 0) != 0) goto done;
        }
        if (ferror(f)) goto done;
        unsigned char digest[32];
        if (BCryptFinishHash(hash, digest, sizeof(digest), 0) != 0) goto done;
        static const char hexd[] = "0123456789abcdef";
        for (int i = 0; i < 32; i++) {
            out_hex[i * 2] = hexd[(digest[i] >> 4) & 0xF];
            out_hex[i * 2 + 1] = hexd[digest[i] & 0xF];
        }
        out_hex[64] = '\0';
        ok = 1;
    }
done:
    if (hash) BCryptDestroyHash(hash);
    if (alg) BCryptCloseAlgorithmProvider(alg, 0);
    fclose(f);
    return ok;
}

static int hash_equals_nocase(const char *a, const char *b) {
    if (!a || !b) return 0;
    while (*a && *b) {
        char ca = *a, cb = *b;
        if (ca >= 'A' && ca <= 'F') ca = (char)(ca + 32);
        if (cb >= 'A' && cb <= 'F') cb = (char)(cb + 32);
        if (ca != cb) return 0;
        a++; b++;
    }
    return *a == '\0' && *b == '\0';
}

/* ---------- 执行白名单脚本 ---------- */
/* S-012（R-W8）：powershell 一律走绝对路径
 * %SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe，不用裸名
 * （PATH 劫持面）；路径不存在即 fail-closed，绝不回落裸名调用。 */
static int powershell_path(WCHAR *out, size_t out_chars) {
    WCHAR sysdir[MAX_PATH] = { 0 };
    UINT n = GetSystemDirectoryW(sysdir, MAX_PATH);
    if (n == 0 || n >= MAX_PATH) return 0;
    if (_snwprintf(out, out_chars, L"%s\\WindowsPowerShell\\v1.0\\powershell.exe",
                   sysdir) < 0) return 0;
    if (GetFileAttributesW(out) == INVALID_FILE_ATTRIBUTES) return 0;
    return 1;
}

static int run_powershell_script(const WCHAR *script_path, const char *owner_utf8, DWORD *exit_code) {
    WCHAR ps_path[MAX_PATH] = { 0 };
    if (!powershell_path(ps_path, MAX_PATH)) return 0; /* 绝对路径不可用即拒绝 */
    WCHAR cmdline[2048] = { 0 };
    int cmd_chars;
    if (owner_utf8 && owner_utf8[0]) {
        /* R-C2：初始化缓冲区并检查转换返回值；MB_ERR_INVALID_CHARS 使
         * 无效 UTF-8 转换失败即拒绝执行，绝不把未初始化栈内存拼入命令行。 */
        WCHAR wowner[128] = { 0 };
        if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, owner_utf8, -1, wowner, 128) == 0) {
            return 0;
        }
        /* Owner 已由协议层验过字符集，此处只做引号包裹，不拼接任何其他参数 */
        cmd_chars = _snwprintf(cmdline, 2048,
            L"\"%s\" -NoProfile -ExecutionPolicy Bypass -File \"%s\" -Owner \"%s\"",
            ps_path, script_path, wowner);
    } else {
        cmd_chars = _snwprintf(cmdline, 2048,
            L"\"%s\" -NoProfile -ExecutionPolicy Bypass -File \"%s\"",
            ps_path, script_path);
    }
    if (cmd_chars < 0 || cmd_chars >= 2048) return 0;
    STARTUPINFOW si;
    PROCESS_INFORMATION pi;
    ZeroMemory(&si, sizeof(si));
    si.cb = sizeof(si);
    si.dwFlags = STARTF_USESHOWWINDOW;
    si.wShowWindow = SW_HIDE;
    ZeroMemory(&pi, sizeof(pi));
    if (!CreateProcessW(ps_path, cmdline, NULL, NULL, FALSE,
            CREATE_NO_WINDOW, NULL, NULL, &si, &pi)) {
        return 0;
    }
    HANDLE waits[2] = { pi.hProcess, g_stop_event };
    DWORD w = g_stop_event ? WaitForMultipleObjects(2, waits, FALSE, EXEC_TIMEOUT_MS)
                          : WaitForSingleObject(pi.hProcess, EXEC_TIMEOUT_MS);
    if (w != WAIT_OBJECT_0) {
        TerminateProcess(pi.hProcess, 1);
        CloseHandle(pi.hProcess);
        CloseHandle(pi.hThread);
        return w == WAIT_TIMEOUT ? -1 : 0;
    }
    DWORD code = 1;
    BOOL exit_ok = GetExitCodeProcess(pi.hProcess, &code);
    if (exit_code) *exit_code = code;
    CloseHandle(pi.hProcess);
    CloseHandle(pi.hThread);
    return exit_ok && code != STILL_ACTIVE;
}

/* ---------- 单次请求处理 ---------- */
static void handle_request(const char *req_text, char *resp, size_t resp_size) {
    qf_request_t rq;
    if (!qf_parse_request(req_text, &rq)) {
        log_line("REJECT parse cmd=? error=%s", rq.error);
        snprintf(resp, resp_size, "{\"ok\":false,\"code\":\"%s\"}\n", rq.error);
        return;
    }
    const char *expected = (rq.cmd == 0) ? W_HEAL_PS1_SHA256 : W_LOCK_INSTALL_PS1_SHA256;
    const char *base = (rq.cmd == 0) ? "qf-agent-heal.ps1" : "install.ps1";
    WCHAR wpath[MAX_PATH] = { 0 };
    if (!MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, rq.path, -1, wpath, MAX_PATH)) {
        snprintf(resp, resp_size, "{\"ok\":false,\"code\":\"bad-path\"}\n");
        return;
    }
    char hex[65] = { 0 };
    if (!sha256_file_hex(wpath, hex)) {
        log_line("REJECT cmd=%s path-missing base=%s", rq.cmd == 0 ? "heal-agent" : "install-lock", base);
        snprintf(resp, resp_size, "{\"ok\":false,\"code\":\"not-found\"}\n");
        return;
    }
    if (!hash_equals_nocase(hex, expected)) {
        log_line("REJECT cmd=%s hash-mismatch base=%s", rq.cmd == 0 ? "heal-agent" : "install-lock", base);
        snprintf(resp, resp_size, "{\"ok\":false,\"code\":\"hash-mismatch\"}\n");
        return;
    }
    log_line("ACCEPT cmd=%s base=%s hash-ok", rq.cmd == 0 ? "heal-agent" : "install-lock", base);
    DWORD exit_code = 0;
    int r = run_powershell_script(wpath, rq.cmd == 1 ? rq.owner : NULL, &exit_code);
    if (r == -1) {
        log_line("TIMEOUT cmd=%s base=%s", rq.cmd == 0 ? "heal-agent" : "install-lock", base);
        snprintf(resp, resp_size, "{\"ok\":false,\"code\":\"timeout\"}\n");
        return;
    }
    if (r == 0) {
        log_line("EXEC-FAILED cmd=%s base=%s", rq.cmd == 0 ? "heal-agent" : "install-lock", base);
        snprintf(resp, resp_size, "{\"ok\":false,\"code\":\"exec-failed\"}\n");
        return;
    }
    log_line("DONE cmd=%s base=%s exit=%lu", rq.cmd == 0 ? "heal-agent" : "install-lock", base, (unsigned long)exit_code);
    snprintf(resp, resp_size, "{\"ok\":true,\"code\":\"done\",\"detail\":\"exit=%lu\"}\n", (unsigned long)exit_code);
}

/* Complete or cancel every overlapped operation before its stack frame and
 * event disappear. Shutdown interrupts connect/read/write waits immediately. */
static int pipe_complete(HANDLE pipe, OVERLAPPED *ov, DWORD timeout, DWORD *bytes) {
    HANDLE waits[2] = { ov->hEvent, g_stop_event };
    DWORD result = g_stop_event ? WaitForMultipleObjects(2, waits, FALSE, timeout)
                               : WaitForSingleObject(ov->hEvent, timeout);
    if (result == WAIT_OBJECT_0) return GetOverlappedResult(pipe, ov, bytes, FALSE);
    CancelIoEx(pipe, ov);
    GetOverlappedResult(pipe, ov, bytes, TRUE);
    return 0;
}
static int pipe_read_line(HANDLE pipe, HANDLE ev, char *buf, size_t size) {
    size_t used = 0;
    ULONGLONG deadline = GetTickCount64() + QF_PIPE_READ_TIMEOUT_MS;
    while (used + 1 < size && InterlockedCompareExchange(&g_running, 1, 1)) {
        OVERLAPPED ov = { 0 };
        ov.hEvent = ev;
        ResetEvent(ev);
        DWORD got = 0;
        ULONGLONG now = GetTickCount64();
        if (now >= deadline) return 0;
        BOOL ok = ReadFile(pipe, buf + used, (DWORD)(size - used - 1), &got, &ov);
        if (!ok && GetLastError() == ERROR_IO_PENDING)
            ok = pipe_complete(pipe, &ov, (DWORD)(deadline - now), &got);
        if (!ok || !got) return 0;
        char *nl = memchr(buf + used, '\n', got);
        if (nl) { *nl = 0; return 1; }
        used += got;
    }
    return 0; /* EOF, oversize and partial requests never execute. */
}
static int pipe_write_response(HANDLE pipe, HANDLE ev, const char *buf) {
    size_t length = strlen(buf), sent = 0;
    ULONGLONG deadline = GetTickCount64() + QF_PIPE_WRITE_TIMEOUT_MS;
    while (sent < length) {
        OVERLAPPED ov = { 0 };
        ov.hEvent = ev;
        ResetEvent(ev);
        DWORD written = 0;
        ULONGLONG now = GetTickCount64();
        if (now >= deadline) return 0;
        BOOL ok = WriteFile(pipe, buf + sent, (DWORD)(length - sent), &written, &ov);
        if (!ok && GetLastError() == ERROR_IO_PENDING)
            ok = pipe_complete(pipe, &ov, (DWORD)(deadline - now), &written);
        if (!ok || !written) return 0;
        sent += written;
    }
    return 1;
}

static DWORD WINAPI qf_flush_worker(LPVOID pipe) {
    return FlushFileBuffers((HANDLE)pipe) ? 0 : 1;
}
static void qf_flush_bounded(HANDLE pipe) {
    HANDLE thread = CreateThread(NULL, 0, qf_flush_worker, pipe, 0, NULL);
    if (!thread) return;
    HANDLE waits[2] = { thread, g_stop_event };
    DWORD result = g_stop_event ? WaitForMultipleObjects(2, waits, FALSE, 10000)
                               : WaitForSingleObject(thread, 10000);
    if (result != WAIT_OBJECT_0) {
        CancelSynchronousIo(thread);
        DisconnectNamedPipe(pipe);
        WaitForSingleObject(thread, INFINITE);
    }
    CloseHandle(thread);
}

/* ---------- 管道循环 ---------- */
static DWORD WINAPI pipe_loop(LPVOID unused) {
    (void)unused;
    PSECURITY_DESCRIPTOR sd = NULL;
    if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(
            L"D:(A;;GA;;;AU)(A;;GA;;;SY)(A;;GA;;;BA)", SDDL_REVISION_1, &sd, NULL)) {
        log_line("FATAL pipe security descriptor failed");
        return 1;
    }
    SECURITY_ATTRIBUTES sa = { sizeof(sa), sd, FALSE };
    log_line("START pipe listening");
    while (InterlockedCompareExchange(&g_running, 1, 1)) {
        HANDLE pipe = CreateNamedPipeW(PIPE_NAME_W,
            PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
            1, QF_MAX_REQUEST, QF_MAX_REQUEST, 0, &sa);
        if (pipe == INVALID_HANDLE_VALUE) {
            log_line("ERROR CreateNamedPipe failed %lu", (unsigned long)GetLastError());
            if (g_stop_event) WaitForSingleObject(g_stop_event, 1000); else Sleep(1000);
            continue;
        }
        HANDLE ev = CreateEventW(NULL, TRUE, FALSE, NULL);
        if (!ev) { CloseHandle(pipe); break; }
        OVERLAPPED cov = { 0 };
        cov.hEvent = ev;
        BOOL connected = ConnectNamedPipe(pipe, &cov);
        DWORD error = connected ? ERROR_SUCCESS : GetLastError();
        if (error == ERROR_IO_PENDING) {
            DWORD unused_bytes = 0;
            connected = pipe_complete(pipe, &cov, INFINITE, &unused_bytes);
        } else if (error == ERROR_PIPE_CONNECTED) connected = TRUE;
        if (connected && InterlockedCompareExchange(&g_running, 1, 1)) {
            char buf[QF_MAX_REQUEST + 1], response[512];
            if (pipe_read_line(pipe, ev, buf, sizeof(buf))) {
                handle_request(buf, response, sizeof(response));
                if (pipe_write_response(pipe, ev, response)) qf_flush_bounded(pipe);
            }
        }
        DisconnectNamedPipe(pipe);
        CloseHandle(ev);
        CloseHandle(pipe);
    }
    LocalFree(sd);
    log_line("STOP pipe loop");
    return 0;
}

/* ---------- 服务控制 ---------- */
static void report_status(DWORD state, DWORD wait_hint) {
    if (!g_status_handle) return;
    g_status.dwServiceType = SERVICE_WIN32_OWN_PROCESS;
    g_status.dwCurrentState = state;
    g_status.dwControlsAccepted = (state == SERVICE_RUNNING)
        ? (SERVICE_ACCEPT_STOP | SERVICE_ACCEPT_SHUTDOWN) : 0;
    g_status.dwWin32ExitCode = NO_ERROR;
    g_status.dwServiceSpecificExitCode = 0;
    g_status.dwCheckPoint = 0;
    g_status.dwWaitHint = wait_hint;
    SetServiceStatus(g_status_handle, &g_status);
}

static void WINAPI service_ctrl_handler(DWORD ctrl) {
    if (ctrl == SERVICE_CONTROL_STOP || ctrl == SERVICE_CONTROL_SHUTDOWN) {
        report_status(SERVICE_STOP_PENDING, 3000);
        InterlockedExchange(&g_running, 0);
        if (g_stop_event) SetEvent(g_stop_event);
    }
}

static void WINAPI service_main(DWORD argc, LPWSTR *argv) {
    (void)argc; (void)argv;
    g_status_handle = RegisterServiceCtrlHandlerW(SERVICE_NAME_W, service_ctrl_handler);
    if (!g_status_handle) return;
    report_status(SERVICE_START_PENDING, 3000);
    g_stop_event = CreateEventW(NULL, TRUE, FALSE, NULL);
    if (!g_stop_event) {
        report_status(SERVICE_STOPPED, 0);
        return;
    }
    log_line("SERVICE started");
    report_status(SERVICE_RUNNING, 0);
    /* 管道循环跑在主线程；停止时由另一个线程的 ConnectNamedPipe 超时唤醒——
       为简单起见，循环内每次建管道前检查 g_running，停止信号到后，
       当前 ConnectNamedPipe 仍在等连接：用一个本地客户端连一次自唤醒。 */
    HANDLE loop_thread = CreateThread(NULL, 0, pipe_loop, NULL, 0, NULL);
    if (!loop_thread) {
        CloseHandle(g_stop_event); g_stop_event = NULL;
        report_status(SERVICE_STOPPED, 0); return;
    }
    WaitForSingleObject(g_stop_event, INFINITE);
    InterlockedExchange(&g_running, 0);
    /* 自唤醒：连一次管道让 ConnectNamedPipe 返回 */
    {
        HANDLE h = CreateFileW(PIPE_NAME_W, GENERIC_READ | GENERIC_WRITE,
            0, NULL, OPEN_EXISTING, 0, NULL);
        if (h != INVALID_HANDLE_VALUE) CloseHandle(h);
    }
    DWORD stopped = WaitForSingleObject(loop_thread, 5000);
    if (stopped != WAIT_OBJECT_0) {
        log_line("ERROR pipe thread did not stop in 5s; waiting before reporting STOPPED");
        report_status(SERVICE_STOP_PENDING, EXEC_TIMEOUT_MS);
        WaitForSingleObject(loop_thread, INFINITE);
    }
    CloseHandle(loop_thread);
    CloseHandle(g_stop_event); g_stop_event = NULL;
    report_status(SERVICE_STOPPED, 0);
    log_line("SERVICE stopped");
}

int main(int argc, char **argv) {
    if (argc > 1 && strcmp(argv[1], "debug") == 0) {
        /* 前台调试模式：不注册 SCM，直接跑管道循环 */
        log_line("DEBUG mode start");
        pipe_loop(NULL);
        return 0;
    }
    SERVICE_TABLE_ENTRYW table[] = {
        { (LPWSTR)SERVICE_NAME_W, service_main },
        { NULL, NULL }
    };
    if (!StartServiceCtrlDispatcherW(table)) {
        /* 非服务方式启动（如直接双击）：提示用途后退出 */
        fprintf(stderr, "QFSysHelper is a Windows service. Install with install-system-services.ps1.\n");
        return 1;
    }
    return 0;
}
