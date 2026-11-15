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
        wcscat_s(parent, MAX_PATH, L"\\QFRemote");
        CreateDirectoryW(parent, NULL);
    }
    wcscat_s(dir, MAX_PATH, LOG_DIR_SUFFIX);
    CreateDirectoryW(dir, NULL);
    if (wcscpy_s(file, MAX_PATH, dir) != 0) return;
    wcscat_s(file, MAX_PATH, L"\\helper.log");
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
    WCHAR cmdline[2048];
    if (owner_utf8 && owner_utf8[0]) {
        /* R-C2：初始化缓冲区并检查转换返回值；MB_ERR_INVALID_CHARS 使
         * 无效 UTF-8 转换失败即拒绝执行，绝不把未初始化栈内存拼入命令行。 */
        WCHAR wowner[128] = { 0 };
        if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, owner_utf8, -1, wowner, 128) == 0) {
            return 0;
        }
        /* Owner 已由协议层验过字符集，此处只做引号包裹，不拼接任何其他参数 */
        _snwprintf(cmdline, 2048,
            L"\"%s\" -NoProfile -ExecutionPolicy Bypass -File \"%s\" -Owner \"%s\"",
            ps_path, script_path, wowner);
    } else {
        _snwprintf(cmdline, 2048,
            L"\"%s\" -NoProfile -ExecutionPolicy Bypass -File \"%s\"",
            ps_path, script_path);
    }
    STARTUPINFOW si;
    PROCESS_INFORMATION pi;
    ZeroMemory(&si, sizeof(si));
    si.cb = sizeof(si);
    si.dwFlags = STARTF_USESHOWWINDOW;
    si.wShowWindow = SW_HIDE;
    ZeroMemory(&pi, sizeof(pi));
    if (!CreateProcessW(NULL, cmdline, NULL, NULL, FALSE,
            CREATE_NO_WINDOW, NULL, NULL, &si, &pi)) {
        return 0;
    }
    DWORD w = WaitForSingleObject(pi.hProcess, EXEC_TIMEOUT_MS);
    if (w == WAIT_TIMEOUT) {
        TerminateProcess(pi.hProcess, 1);
        CloseHandle(pi.hProcess);
        CloseHandle(pi.hThread);
        return -1; /* 超时 */
    }
    DWORD code = 1;
    GetExitCodeProcess(pi.hProcess, &code);
    if (exit_code) *exit_code = code;
    CloseHandle(pi.hProcess);
    CloseHandle(pi.hThread);
    return 1;
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
    WCHAR wpath[MAX_PATH];
    MultiByteToWideChar(CP_UTF8, 0, rq.path, -1, wpath, MAX_PATH);
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

/* ---------- 管道循环 ---------- */
static DWORD WINAPI pipe_loop(LPVOID unused) {
    (void)unused;
    PSECURITY_DESCRIPTOR sd = NULL;
    /* 仅认证用户＋SYSTEM＋管理员可连管道 */
    if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(
            L"D:(A;;GA;;;AU)(A;;GA;;;SY)(A;;GA;;;BA)",
            SDDL_REVISION_1, &sd, NULL)) {
        log_line("FATAL pipe security descriptor failed");
        return 1;
    }
    SECURITY_ATTRIBUTES sa;
    sa.nLength = sizeof(sa);
    sa.lpSecurityDescriptor = sd;
    sa.bInheritHandle = FALSE;
    log_line("START pipe listening");
    while (InterlockedCompareExchange(&g_running, 1, 1) == 1) {
        HANDLE pipe = CreateNamedPipeW(PIPE_NAME_W,
            PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED, PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
            1, QF_MAX_REQUEST, QF_MAX_REQUEST, 0, &sa);
        if (pipe == INVALID_HANDLE_VALUE) {
            log_line("ERROR CreateNamedPipe failed %lu", (unsigned long)GetLastError());
            Sleep(1000);
            continue;
        }
        BOOL connected = ConnectNamedPipe(pipe, NULL);
        if (!connected && GetLastError() != ERROR_PIPE_CONNECTED) {
            CloseHandle(pipe);
            continue;
        }
        /* 低项 1（2026-11-15）：旧实现同步 ReadFile 无超时——任一可连管道
         * 的本地 AU 用户连上不发数据即可永久占住唯一实例，heal-agent／
         * install-lock 被堵死直至服务重启（QFRLEA／USH 同类问题已按 #14
         * 修为 30s deadline，此处未修）。修法与 USH #14 同口径：实例以
         * FILE_FLAG_OVERLAPPED 创建，重叠读 30s deadline、重叠写 10s
         * 超时；超时即断开，不处理半行。ConnectNamedPipe 仍阻塞等待
         * （停止时主线程自唤醒连接，见 service_main）。 */
        HANDLE ev = CreateEventW(NULL, TRUE, FALSE, NULL);
        if (ev) {
            char buf[QF_MAX_REQUEST + 1];
            DWORD read = 0;
            OVERLAPPED ov;
            memset(&ov, 0, sizeof(ov));
            ov.hEvent = ev;
            BOOL ok = FALSE;
            BOOL r = ReadFile(pipe, buf, QF_MAX_REQUEST, &read, &ov);
            if (!r && GetLastError() == ERROR_IO_PENDING) {
                if (WaitForSingleObject(ev, QF_PIPE_READ_TIMEOUT_MS) == WAIT_OBJECT_0)
                    ok = GetOverlappedResult(pipe, &ov, &read, FALSE);
                else {
                    CancelIo(pipe);
                    log_line("TIMEOUT read no data in %lu ms, disconnecting",
                             (unsigned long)QF_PIPE_READ_TIMEOUT_MS);
                }
            } else {
                ok = r;
            }
            if (ok && read > 0) {
                buf[read] = '\0';
                char *nl = strchr(buf, '\n');
                if (nl) *nl = '\0';
                char resp[512];
                handle_request(buf, resp, sizeof(resp));
                size_t resp_len = strlen(resp);
                size_t sent = 0;
                ResetEvent(ev);
                while (sent < resp_len) {
                    OVERLAPPED wov;
                    memset(&wov, 0, sizeof(wov));
                    wov.hEvent = ev;
                    DWORD written = 0;
                    BOOL wr = WriteFile(pipe, resp + sent, (DWORD)(resp_len - sent), &written, &wov);
                    if (!wr && GetLastError() == ERROR_IO_PENDING) {
                        if (WaitForSingleObject(ev, QF_PIPE_WRITE_TIMEOUT_MS) != WAIT_OBJECT_0) {
                            CancelIo(pipe);
                            log_line("TIMEOUT write response, disconnecting");
                            break;
                        }
                        if (!GetOverlappedResult(pipe, &wov, &written, FALSE)) break;
                    } else if (!wr) {
                        break;
                    }
                    sent += written;
                }
            }
            CloseHandle(ev);
        }
        FlushFileBuffers(pipe);
        DisconnectNamedPipe(pipe);
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
    WaitForSingleObject(g_stop_event, INFINITE);
    InterlockedExchange(&g_running, 0);
    /* 自唤醒：连一次管道让 ConnectNamedPipe 返回 */
    {
        HANDLE h = CreateFileW(PIPE_NAME_W, GENERIC_READ | GENERIC_WRITE,
            0, NULL, OPEN_EXISTING, 0, NULL);
        if (h != INVALID_HANDLE_VALUE) CloseHandle(h);
    }
    if (loop_thread) WaitForSingleObject(loop_thread, 5000);
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
