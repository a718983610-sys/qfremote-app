/* QFUserHelper (USH) —— QFR 本地代理的用户会话助手（Stage 1 MVP）
 * =================================================================
 * 运行位置：用户登录会话内，当前登录用户权限，随登录启动
 * （计划任务 QFRLEA User Helper，见 register-ush.ps1；主程序兜底拉起由安装线接）。
 * 通道：命名管道 \\.\pipe\QFR\LEA\UserHelper\v1，一行 JSON 请求 → 一行 JSON 响应。
 * 权限：管道 ACL 仅 SYSTEM + Administrators（D:(A;;GA;;;SY)(A;;GA;;;BA)），
 * 即只有 QFRLEA 服务（SYSTEM 身份）能连。比 QFSysHelper 更严是故意的：
 * QFSysHelper 要接用户态 Electron 应用的调用故放行 AU（认证用户），
 * USH 只接 LEA 服务，不需要 AU。另加 PIPE_REJECT_REMOTE_CLIENTS 拒绝远程连入。
 * 安全边界（写死，不许放宽）：
 *   - 只信 LEA 转来的已校验指令，不做准入、不存密钥、不做签名校验
 *     （准入在服务端 + LEA 两层；USH 收到的已是校验过的命令）；
 *   - 只收 5 个固定命令（ui.ping/ui.click/ui.input/ui.snapshot/ui.tree），
 *     命令名之外只采信白名单字段；输入文本只进 UIA，不进日志（日志只记
 *     params 的 SHA-256 哈希）；不执行任意脚本/命令、不做进程注入；
 *   - 锁屏/休眠/无交互会话时 UI 类指令一律拒绝并返回明确错误码，
 *     绝不谎称已点击；ui.ping 例外（LEA 探活需要，锁屏时也要能回答）。
 * 崩溃恢复：无持久状态；进程死则管道句柄由系统回收，不留僵尸管道；
 * 启动时先探活旧实例（ui.ping），活着就退出，死了就接管；LEA 侧负责重拉。
 * 构建（Linux 交叉编译，与 QFSysHelper 同链）：
 *   见 build.sh：x86_64-w64-mingw32-gcc … -lole32 -loleaut32 -lwtsapi32
 * 调试：QFUserHelper.exe debug —— 前台跑管道循环（不注册 SCM，USH 不是服务）。
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <sddl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "ush_json.h"
#include "ush_log.h"
#include "ush_uia.h"
#include "ush_snapshot.h"

#define USH_VERSION "1.0.0-mvp"
#define PIPE_NAME_W L"\\\\.\\pipe\\QFR\\LEA\\UserHelper\\v1"
#define PIPE_SDDL L"D:(A;;GA;;;SY)(A;;GA;;;BA)"

static volatile LONG g_running = 1;
static HANDLE g_stop_event = NULL;

/* ---------- DPI awareness（PerMonitorV2；失败则降级，不阻塞启动） ---------- */
static void enable_dpi_awareness(void) {
    HMODULE user32 = GetModuleHandleW(L"user32.dll");
    if (user32) {
        typedef BOOL (WINAPI *SetCtxFn)(HANDLE);
        SetCtxFn fn = NULL;
        /* 经 void* 中转取函数指针，避免 -Wcast-function-type 警告 */
        *(void **)(&fn) = (void *)GetProcAddress(user32, "SetProcessDpiAwarenessContext");
        if (fn) {
            /* DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = (HANDLE)-4 */
            if (fn((HANDLE)(LONG_PTR)-4)) return;
        }
    }
    HMODULE shcore = LoadLibraryW(L"Shcore.dll");
    if (shcore) {
        typedef HRESULT (WINAPI *SetAwareFn)(int);
        SetAwareFn fn = NULL;
        *(void **)(&fn) = (void *)GetProcAddress(shcore, "SetProcessDpiAwareness");
        if (fn) fn(2); /* PROCESS_PER_MONITOR_DPI_AWARE */
        FreeLibrary(shcore);
    }
}

/* ---------- 管道一次性调用（启动探活用，2 秒超时） ---------- */
static int pipe_probe_alive(void) {
    if (!WaitNamedPipeW(PIPE_NAME_W, 500)) return 0;
    HANDLE h = CreateFileW(PIPE_NAME_W, GENERIC_READ | GENERIC_WRITE, 0, NULL,
                           OPEN_EXISTING, FILE_FLAG_OVERLAPPED, NULL);
    if (h == INVALID_HANDLE_VALUE) return 0;
    const char *req = "{\"command\":\"ui.ping\",\"request_id\":\"ush-startup-probe\"}\n";
    OVERLAPPED ov;
    memset(&ov, 0, sizeof(ov));
    ov.hEvent = CreateEventW(NULL, TRUE, FALSE, NULL);
    DWORD written = 0;
    int alive = 0;
    if (WriteFile(h, req, (DWORD)strlen(req), &written, &ov) ||
        GetLastError() == ERROR_IO_PENDING) {
        if (WaitForSingleObject(ov.hEvent, 2000) == WAIT_OBJECT_0) {
            char resp[512];
            DWORD read = 0;
            memset(&ov, 0, sizeof(ov));
            ov.hEvent = CreateEventW(NULL, TRUE, FALSE, NULL);
            if (ReadFile(h, resp, sizeof(resp) - 1, &read, &ov) ||
                GetLastError() == ERROR_IO_PENDING) {
                if (WaitForSingleObject(ov.hEvent, 2000) == WAIT_OBJECT_0) {
                    DWORD got = 0;
                    if (GetOverlappedResult(h, &ov, &got, FALSE) && got > 0) {
                        resp[got] = '\0';
                        if (strstr(resp, "\"ok\":true") != NULL) alive = 1;
                    }
                }
            }
            if (ov.hEvent) CloseHandle(ov.hEvent);
        }
        CancelIo(h);
    }
    if (ov.hEvent) CloseHandle(ov.hEvent);
    CloseHandle(h);
    return alive;
}

/* ---------- 读一行请求（直到 \n 或上限） ---------- */
static int read_request_line(HANDLE pipe, char *buf, size_t buf_size) {
    size_t n = 0;
    while (n + 1 < buf_size) {
        char c = 0;
        DWORD read = 0;
        if (!ReadFile(pipe, &c, 1, &read, NULL) || read == 0) {
            return n > 0 ? 1 : 0; /* 对端关闭：有内容算一行，无内容算断开 */
        }
        if (c == '\n') break;
        buf[n++] = c;
    }
    buf[n] = '\0';
    return 1;
}

/* ---------- 单次请求处理 ---------- */
static void handle_request(const char *req_text, char *resp, size_t resp_size,
                           DWORD *out_duration_ms) {
    DWORD start = GetTickCount();
    ush_request_t rq;
    /* data_buf 必须放堆上：handle_request 跑在管道工作线程（默认 1MB 栈），
     * 16MB 栈数组会在函数入口直接栈溢出（Wine 实测：首个请求即崩进程）。 */
    char *data_buf = (char *)malloc(USH_MAX_RESPONSE);
    if (!data_buf) {
        ush_build_response(resp, resp_size, 0, USH_ERR_FAILED, "", 0, NULL,
                           "out of memory");
        if (out_duration_ms) *out_duration_ms = GetTickCount() - start;
        return;
    }
    char err_text[512] = {0};
    char err_code[64] = {0};
    char window_title[256] = {0};
    int retry_count = 0;
    int ok = 0;
    const char *code = "done";

    data_buf[0] = '\0';
    if (!ush_parse_request(req_text, &rq)) {
        code = rq.error;
        snprintf(err_text, sizeof(err_text), "request parse failed: %s", rq.error);
        ush_build_response(resp, resp_size, 0, code, rq.request_id,
                           (long)(GetTickCount() - start), NULL, err_text);
        ush_log_command(&rq, "error", code, (long)(GetTickCount() - start), NULL, 0);
        if (out_duration_ms) *out_duration_ms = GetTickCount() - start;
        free(data_buf);
        return;
    }

    if (rq.cmd == USH_CMD_PING) {
        DWORD session_id = 0;
        ProcessIdToSessionId(GetCurrentProcessId(), &session_id);
        snprintf(data_buf, USH_MAX_RESPONSE,
            "{\"alive\":true,\"version\":\"%s\",\"pid\":%lu,\"session_id\":%lu}",
            USH_VERSION, (unsigned long)GetCurrentProcessId(), (unsigned long)session_id);
        ok = 1;
    } else {
        /* 会话门：UI 类指令要求交互式会话已解锁 */
        char gate_err[64] = {0};
        if (!ush_session_interactive(gate_err, sizeof(gate_err))) {
            strncpy(err_code, gate_err, sizeof(err_code) - 1);
            err_code[sizeof(err_code) - 1] = '\0';
            snprintf(err_text, sizeof(err_text),
                "interactive session not available (locked/sleeping/disconnected); refusing UI command");
            code = err_code;
        } else if (rq.cmd == USH_CMD_CLICK) {
            ok = ush_ui_click(&rq, data_buf, USH_MAX_RESPONSE,
                              err_code, sizeof(err_code), err_text, sizeof(err_text),
                              &retry_count, window_title, sizeof(window_title));
            code = ok ? "done" : err_code;
        } else if (rq.cmd == USH_CMD_INPUT) {
            ok = ush_ui_input(&rq, data_buf, USH_MAX_RESPONSE,
                              err_code, sizeof(err_code), err_text, sizeof(err_text),
                              &retry_count, window_title, sizeof(window_title));
            code = ok ? "done" : err_code;
        } else if (rq.cmd == USH_CMD_SNAPSHOT) {
            ok = ush_ui_snapshot(&rq, data_buf, USH_MAX_RESPONSE,
                                 err_code, sizeof(err_code), err_text, sizeof(err_text));
            code = ok ? "done" : err_code;
        } else if (rq.cmd == USH_CMD_TREE) {
            ok = ush_ui_tree(&rq, data_buf, USH_MAX_RESPONSE,
                             err_code, sizeof(err_code), err_text, sizeof(err_text),
                             window_title, sizeof(window_title));
            code = ok ? "done" : err_code;
        }
    }

    DWORD dur = GetTickCount() - start;
    if (ok) {
        ush_build_response(resp, resp_size, 1, "done", rq.request_id, (long)dur, data_buf, NULL);
        ush_log_command(&rq, "ok", "done", (long)dur,
                        window_title[0] ? window_title : NULL, retry_count);
    } else {
        ush_build_response(resp, resp_size, 0, code, rq.request_id, (long)dur, NULL, err_text);
        ush_log_command(&rq, "error", code, (long)dur,
                        window_title[0] ? window_title : NULL, retry_count);
    }
    if (out_duration_ms) *out_duration_ms = dur;
    free(data_buf);
}

/* ---------- 管道循环 ---------- */
static DWORD WINAPI pipe_loop(LPVOID unused) {
    (void)unused;
    PSECURITY_DESCRIPTOR sd = NULL;
    if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(
            PIPE_SDDL, SDDL_REVISION_1, &sd, NULL)) {
        ush_log_event("fatal", "pipe security descriptor failed");
        return 1;
    }
    SECURITY_ATTRIBUTES sa;
    sa.nLength = sizeof(sa);
    sa.lpSecurityDescriptor = sd;
    sa.bInheritHandle = FALSE;
    ush_log_event("pipe-listening", "pipe=\\\\.\\pipe\\QFR\\LEA\\UserHelper\\v1");
    static char req_buf[USH_MAX_REQUEST + 1];
    char *resp_buf = (char *)malloc(USH_MAX_RESPONSE);
    if (!resp_buf) {
        LocalFree(sd);
        return 1;
    }
    while (InterlockedCompareExchange(&g_running, 1, 1) == 1) {
        /* 注意：CreateNamedPipe 的缓冲大小只是内核缓冲，不是消息上限
         * （WriteFile 可分片写大响应）；给 16MB 会建管道失败，须用小值。 */
        HANDLE pipe = CreateNamedPipeW(PIPE_NAME_W,
            PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
            1, USH_MAX_REQUEST, USH_MAX_REQUEST, 0, &sa);
        if (pipe == INVALID_HANDLE_VALUE) {
            DWORD e = GetLastError();
            char detail[128];
            snprintf(detail, sizeof(detail), "CreateNamedPipe failed error=%lu", (unsigned long)e);
            ush_log_event("pipe-create-failed", detail);
            if (e == ERROR_ACCESS_DENIED) {
                /* 已有实例持有管道（FILE_FLAG_FIRST_PIPE_INSTANCE 拒绝）：
                 * 探活一次，活着就退出，避免两个 USH 抢管道。 */
                if (pipe_probe_alive()) {
                    ush_log_event("duplicate-instance", "another USH is alive; exiting");
                    break;
                }
                Sleep(1000);
                continue;
            }
            Sleep(1000);
            continue;
        }
        BOOL connected = ConnectNamedPipe(pipe, NULL);
        if (!connected && GetLastError() != ERROR_PIPE_CONNECTED) {
            CloseHandle(pipe);
            continue;
        }
        if (read_request_line(pipe, req_buf, sizeof(req_buf))) {
            DWORD dur = 0;
            handle_request(req_buf, resp_buf, USH_MAX_RESPONSE, &dur);
            DWORD written = 0;
            WriteFile(pipe, resp_buf, (DWORD)strlen(resp_buf), &written, NULL);
        }
        FlushFileBuffers(pipe);
        DisconnectNamedPipe(pipe);
        CloseHandle(pipe);
    }
    free(resp_buf);
    LocalFree(sd);
    ush_log_event("pipe-stopped", "pipe loop exited");
    return 0;
}

static BOOL WINAPI ctrl_handler(DWORD type) {
    if (type == CTRL_C_EVENT || type == CTRL_BREAK_EVENT || type == CTRL_CLOSE_EVENT) {
        InterlockedExchange(&g_running, 0);
        if (g_stop_event) SetEvent(g_stop_event);
        return TRUE;
    }
    return FALSE;
}

int main(int argc, char **argv) {
    int debug = (argc > 1 && strcmp(argv[1], "debug") == 0);
    enable_dpi_awareness();
    ush_log_init();
    if (debug) {
        fprintf(stderr, "QFUserHelper %s debug mode: pipe %s\n", USH_VERSION,
            "\\\\.\\pipe\\QFR\\LEA\\UserHelper\\v1");
    }

    /* 单实例：每会话一个互斥体；已有实例活着就退出 */
    DWORD session_id = 0;
    ProcessIdToSessionId(GetCurrentProcessId(), &session_id);
    char mutex_name[64];
    snprintf(mutex_name, sizeof(mutex_name), "Local\\QFRUSHMutex-%lu", (unsigned long)session_id);
    HANDLE mutex = CreateMutexA(NULL, FALSE, mutex_name);
    if (mutex && GetLastError() == ERROR_ALREADY_EXISTS) {
        if (pipe_probe_alive()) {
            ush_log_event("duplicate-instance", "another USH is alive; exiting");
            CloseHandle(mutex);
            return 0;
        }
        /* 管道无响应：旧实例已死但互斥体残留（异常崩溃），继续接管 */
        ush_log_event("stale-instance", "old instance not responding; taking over");
    }

    g_stop_event = CreateEventW(NULL, TRUE, FALSE, NULL);
    SetConsoleCtrlHandler(ctrl_handler, TRUE);
    if (!ush_uia_init()) {
        /* UIA 初始化失败不致命：ui.ping 仍可回答，UI 命令会报 QFR_USH_FAILED。
         * 记日志继续跑，等 LEA 探活看到 ping 通但 UI 失败时再处置。 */
        ush_log_event("uia-init-failed", "CoCreateInstance CUIAutomation failed; UI commands will fail");
    }
    HANDLE loop_thread = CreateThread(NULL, 0, pipe_loop, NULL, 0, NULL);
    if (!loop_thread) {
        ush_log_event("fatal", "cannot start pipe thread");
        return 1;
    }
    WaitForSingleObject(g_stop_event, INFINITE);
    InterlockedExchange(&g_running, 0);
    /* 自唤醒：连一次管道让 ConnectNamedPipe 返回 */
    {
        HANDLE h = CreateFileW(PIPE_NAME_W, GENERIC_READ | GENERIC_WRITE,
            0, NULL, OPEN_EXISTING, 0, NULL);
        if (h != INVALID_HANDLE_VALUE) CloseHandle(h);
    }
    WaitForSingleObject(loop_thread, 5000);
    ush_uia_shutdown();
    if (mutex) CloseHandle(mutex);
    ush_log_event("ush-stopped", "shutdown complete");
    return 0;
}
