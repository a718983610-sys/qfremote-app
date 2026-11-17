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
 *   - 只接已校验指令：调用方须是已安装的 QFRLEA.exe（进程镜像校验，
 *     H03），且须带 USH 每启动一次的随机 token（H03）；两者缺一即
 *     拒绝——USH 不再只信管道 ACL（本机任意 SYSTEM／管理员进程、
 *     含 MeshCentral agent 本身，从此发不了 ui.click／ui.input）。
 *     自探活 ui.ping 例外：只允许 USH 自身进程（QFUserHelper.exe）
 *     发起，无 token 也放行。
 *   - 不做准入、不存密钥、不做签名校验
 *     （业务准入在服务端 + LEA 两层；USH 收到的已是校验过的命令，
 *      再加调用方＋token 两道本地鉴别）；
 *   - 只收 5 个固定命令（ui.ping/ui.click/ui.input/ui.snapshot/ui.tree），
 *     命令名之外只采信白名单字段；输入文本只进 UIA，不进日志（日志只记
 *     params 的 SHA-256 哈希）；不执行任意脚本/命令、不做进程注入；
 *   - 锁屏/休眠/无交互会话时 UI 类指令一律拒绝并返回明确错误码，
 *     绝不谎称已点击；ui.ping 例外（LEA 探活需要，锁屏时也要能回答）。
 * 崩溃恢复：无持久状态；进程死则管道句柄由系统回收，不留僵尸管道。
 * 单实例（r10，2026-11-12 双 USH 竞态修复）：每会话一个命名互斥体，
 * 首实例创建即持有所有权直至进程退出；后起实例 3 秒内拿不到所有权
 * 即干净退出（不写 token 文件、不建管道）；旧实例崩溃则互斥体被遗
 * 弃，后起实例接管。管道层另有兜底：CreateNamedPipe 报 5／231 即探活，
 * 活着就停整个进程，不再每秒重试刷 pipe-create-failed；LEA 侧负责重拉。
 * 构建（Linux 交叉编译，与 QFSysHelper 同链）：
 *   见 build.sh：x86_64-w64-mingw32-gcc … -lole32 -loleaut32 -lwtsapi32
 * 调试：QFUserHelper.exe debug —— 前台跑管道循环（不注册 SCM，USH 不是服务）。
 */
#define WIN32_LEAN_AND_MEAN
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0600 /* GetNamedPipeClientProcessId（H03）须 ≥0x0600 */
#endif
#include <windows.h>
#include <sddl.h>
#include <bcrypt.h>
#include <wtsapi32.h> /* WTSGetActiveConsoleSessionId（H03 第二轮：与 LEA 同源） */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "ush_json.h"
#include "ush_log.h"
#include "ush_uia.h"
#include "ush_snapshot.h"
#include "ush_selfbind.h" /* C1：自助绑定（设备签名调 complete 换凭据） */

#define USH_VERSION "1.0.0-mvp"
#define PIPE_NAME_W L"\\\\.\\pipe\\QFR\\LEA\\UserHelper\\v1"
#define PIPE_SDDL L"D:(A;;GA;;;SY)(A;;GA;;;BA)"

static volatile LONG g_running = 1;
static HANDLE g_stop_event = NULL;

/* ---------- H03：每启动随机 token ＋ 调用方鉴别 ---------- */
/* token：32 字节 BCryptGenRandom → 64 位小写 hex，存在内存（g_ush_token），
 * 同时写入 %ProgramData%\QFR\LEA\ush-tokens\<sessionid>.txt 供 LEA 读取
 * 后随信封带回验。LEA 读不到 token 即不转发 UI 命令（fail-closed）。
 * 生成失败返回 0：此时 g_ush_token 为空，全部 LEA 命令都会因 token
 * 不匹配被拒（fail-closed），只记日志继续跑，等下次启动重试。 */
static char g_ush_token[65] = { 0 };

static int ush_token_init(void) {
    unsigned char raw[32];
    if (BCryptGenRandom(NULL, raw, sizeof(raw), BCRYPT_USE_SYSTEM_PREFERRED_RNG) != 0)
        return 0;
    static const char hexd[] = "0123456789abcdef";
    for (int i = 0; i < 32; i++) {
        g_ush_token[i * 2] = hexd[(raw[i] >> 4) & 0xF];
        g_ush_token[i * 2 + 1] = hexd[raw[i] & 0xF];
    }
    g_ush_token[64] = '\0';
    /* 文件名用活动控制台会话 id（H03 第二轮）：与 LEA 的 ush_token_read
     * 用同一来源，RDP／多会话下不错配。旧版用自身会话 id
     * （ProcessIdToSessionId），RDP 会话里的 USH 与 LEA 读的控制台会
     * 话文件对不上，token 永远读不到。多会话各跑一个 USH 时同名文件
     * 后写者胜——UI 命令本就只面向控制台桌面，残留 DoS 接受。
     * DS 第二轮 #6：无活动控制台会话时不回退自身会话 id——LEA 的
     * ush_token_read 同样用 WTSGetActiveConsoleSessionId，取不到直接
     * 失败；两端不一致只会让日志难定位。RDP-only（无控制台会话）下
     * token 文件不写，LEA 读不到 token，UI 命令 fail-closed（见 README）。 */
    DWORD session_id = WTSGetActiveConsoleSessionId();
    if (session_id == 0xFFFFFFFF) {
        ush_log_event("ush-token-no-console-session", "no active console session; token file not written, LEA forwards will fail closed (RDP-only: UI commands unavailable)");
        return 1; /* token 在内存，文件没写 */
    }
    WCHAR wpd[MAX_PATH];
    DWORD n = GetEnvironmentVariableW(L"ProgramData", wpd, MAX_PATH);
    if (n == 0 || n >= MAX_PATH) return 1; /* token 在内存，文件写失败只记日志 */
    WCHAR wpath[MAX_PATH];
    _snwprintf(wpath, MAX_PATH, L"%s\\QFR\\LEA\\ush-tokens\\%lu.txt",
               wpd, (unsigned long)session_id);
    FILE *f = _wfopen(wpath, L"wb");
    if (!f) {
        ush_log_event("ush-token-file-failed", "cannot write ush token file; LEA forwards will fail closed");
        return 1;
    }
    fwrite(g_ush_token, 1, 64, f);
    fputc('\n', f);
    fclose(f);
    return 1;
}

/* 管道调用方鉴别：返回 0=拒绝，1=LEA 服务（QFRLEA.exe，可发全部命令，
 * 另须验 token），2=USH 自身（QFUserHelper.exe，仅 ui.ping 自探活）。
 * 安装目录取 USH 自身 exe 所在目录；其他进程一律拒绝。 */
static int ush_caller_kind(HANDLE pipe) {
    DWORD pid = 0;
    if (!GetNamedPipeClientProcessId(pipe, &pid) || pid == 0) return 0;
    HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (!h) return 0;
    WCHAR img[MAX_PATH];
    DWORD n = MAX_PATH;
    int kind = 0;
    if (QueryFullProcessImageNameW(h, 0, img, &n) && n > 0) {
        WCHAR self[MAX_PATH];
        GetModuleFileNameW(NULL, self, MAX_PATH);
        WCHAR *slash = wcsrchr(self, L'\\');
        if (slash) *slash = L'\0';
        WCHAR expect_lea[MAX_PATH], expect_self[MAX_PATH];
        _snwprintf(expect_lea, MAX_PATH, L"%s\\QFRLEA.exe", self);
        _snwprintf(expect_self, MAX_PATH, L"%s\\QFUserHelper.exe", self);
        if (_wcsicmp(img, expect_lea) == 0) kind = 1;
        else if (_wcsicmp(img, expect_self) == 0) kind = 2;
    }
    CloseHandle(h);
    return kind;
}

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
/* N-11（2026-11-15）：旧实现在写／读两段各建一个事件——写事件在
 * memset 覆盖 OVERLAPPED 后丢失且永不关闭（每次探活泄漏 1 个句柄），
 * 读事件又在 :186 与 :190 各关一次（第二次 CloseHandle 必返
 * ERROR_INVALID_HANDLE）。修法：全程只建一个事件、只关一次；写等待
 * 与读等待之间 ResetEvent＋重填 OVERLAPPED，不再 memset 丢句柄。 */
static int pipe_probe_alive(void) {
    if (!WaitNamedPipeW(PIPE_NAME_W, 500)) return 0;
    HANDLE h = CreateFileW(PIPE_NAME_W, GENERIC_READ | GENERIC_WRITE, 0, NULL,
                           OPEN_EXISTING, FILE_FLAG_OVERLAPPED, NULL);
    if (h == INVALID_HANDLE_VALUE) return 0;
    HANDLE ev = CreateEventW(NULL, TRUE, FALSE, NULL);
    if (!ev) { CloseHandle(h); return 0; }
    const char *req = "{\"command\":\"ui.ping\",\"request_id\":\"ush-startup-probe\"}\n";
    OVERLAPPED ov;
    memset(&ov, 0, sizeof(ov));
    ov.hEvent = ev;
    DWORD written = 0;
    int alive = 0;
    if (WriteFile(h, req, (DWORD)strlen(req), &written, &ov) ||
        GetLastError() == ERROR_IO_PENDING) {
        if (WaitForSingleObject(ev, 2000) == WAIT_OBJECT_0) {
            char resp[512];
            DWORD read = 0;
            ResetEvent(ev);
            memset(&ov, 0, sizeof(ov));
            ov.hEvent = ev;
            if (ReadFile(h, resp, sizeof(resp) - 1, &read, &ov) ||
                GetLastError() == ERROR_IO_PENDING) {
                if (WaitForSingleObject(ev, 2000) == WAIT_OBJECT_0) {
                    DWORD got = 0;
                    if (GetOverlappedResult(h, &ov, &got, FALSE) && got > 0) {
                        resp[got] = '\0';
                        if (strstr(resp, "\"ok\":true") != NULL) alive = 1;
                    }
                }
            }
        }
        CancelIo(h);
    }
    CloseHandle(ev);
    CloseHandle(h);
    return alive;
}

/* ---------- 读一行请求（直到 \n 或上限） ---------- */
/* #14：总 deadline 30s。旧实现逐字节同步读、无超时；USH 单实例串行，
 * 一个连上不发数据的客户端即可占住实例，阻塞后续请求。超时返回 0
 * （调用方直接断开，不处理半行）。 */
#define USH_PIPE_READ_TIMEOUT_MS 30000
#define USH_PIPE_WRITE_TIMEOUT_MS 10000
static int read_request_line(HANDLE pipe, char *buf, size_t buf_size) {
    ULONGLONG deadline_tick = GetTickCount64() + USH_PIPE_READ_TIMEOUT_MS;
    HANDLE ev = CreateEventW(NULL, TRUE, FALSE, NULL);
    if (!ev) return 0;
    size_t n = 0;
    int timed_out = 0;
    char chunk[4096];
    while (n + 1 < buf_size) {
        OVERLAPPED ov;
        memset(&ov, 0, sizeof(ov));
        ov.hEvent = ev;
        ResetEvent(ev);
        DWORD want = (DWORD)(buf_size - 1 - n);
        if (want > sizeof(chunk)) want = sizeof(chunk);
        DWORD got = 0;
        BOOL r = ReadFile(pipe, chunk, want, &got, &ov);
        if (!r && GetLastError() == ERROR_IO_PENDING) {
            ULONGLONG now = GetTickCount64();
            if (now >= deadline_tick) { CancelIo(pipe); timed_out = 1; break; }
            DWORD wait_ms = (DWORD)(deadline_tick - now);
            if (WaitForSingleObject(ev, wait_ms) != WAIT_OBJECT_0) {
                CancelIo(pipe);
                timed_out = 1;
                break;
            }
            if (!GetOverlappedResult(pipe, &ov, &got, FALSE)) break;
        } else if (!r) {
            break;
        }
        if (got == 0) break;
        char *nl = memchr(chunk, '\n', got);
        size_t take = nl ? (size_t)(nl - chunk) : got;
        if (n + take >= buf_size - 1) take = buf_size - 1 - n;
        memcpy(buf + n, chunk, take);
        n += take;
        if (nl) {
            buf[n] = '\0';
            CloseHandle(ev);
            return 1;
        }
        if (n + 1 >= buf_size) break;
        /* 短读且无换行：继续等（总 deadline 内），不把半行当整行解析。 */
    }
    CloseHandle(ev);
    buf[n] = '\0';
    if (timed_out) return 0;
    return n > 0 ? 1 : 0;
}

/* #14：重叠写响应（带超时；实例句柄为 FILE_FLAG_OVERLAPPED，同步
 * WriteFile 传 NULL 不可靠，见 LEA #8）。 */
static int ush_pipe_write_all(HANDLE pipe, const char *buf, size_t len) {
    ULONGLONG deadline_tick = GetTickCount64() + USH_PIPE_WRITE_TIMEOUT_MS;
    HANDLE ev = CreateEventW(NULL, TRUE, FALSE, NULL);
    if (!ev) return 0;
    size_t sent = 0;
    int ok = 0;
    while (sent < len) {
        OVERLAPPED ov;
        memset(&ov, 0, sizeof(ov));
        ov.hEvent = ev;
        ResetEvent(ev);
        DWORD chunk = 0;
        DWORD want = (DWORD)(len - sent);
        BOOL r = WriteFile(pipe, buf + sent, want, &chunk, &ov);
        if (!r && GetLastError() == ERROR_IO_PENDING) {
            ULONGLONG now = GetTickCount64();
            if (now >= deadline_tick) { CancelIo(pipe); break; }
            DWORD wait_ms = (DWORD)(deadline_tick - now);
            if (WaitForSingleObject(ev, wait_ms) != WAIT_OBJECT_0) {
                CancelIo(pipe);
                break;
            }
            if (!GetOverlappedResult(pipe, &ov, &chunk, FALSE)) break;
        } else if (!r) {
            break;
        }
        if (chunk == 0) break;
        sent += chunk;
    }
    if (sent == len) ok = 1;
    CloseHandle(ev);
    return ok;
}

/* ---------- 单次请求处理 ---------- */
/* caller_kind：ush_caller_kind 的返回值（1=LEA，2=USH 自身自探活）。
 * H03：LEA 来的请求须带与本进程 token 一致的 ush_token，否则拒绝；
 * 自身来的只放行 ui.ping。 */
static void handle_request(const char *req_text, char *resp, size_t resp_size,
                           DWORD *out_duration_ms, int caller_kind) {
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

    /* H03 鉴权门（解析通过后、执行前）：LEA 来的请求必须带与本进程
     * token 一致的 ush_token；自身来的只放行 ui.ping；其他 caller_kind
     * （含 0）一律拒绝。token 缺失／不匹配返回明确错误码，不执行。 */
    if (caller_kind == 1) {
        if (!ush_token_matches(g_ush_token, rq.ush_token)) {
            code = USH_ERR_UNAUTHORIZED;
            snprintf(err_text, sizeof(err_text), "ush token missing or mismatch");
            ush_build_response(resp, resp_size, 0, code, rq.request_id,
                               (long)(GetTickCount() - start), NULL, err_text);
            ush_log_command(&rq, "error", code, (long)(GetTickCount() - start), NULL, 0);
            if (out_duration_ms) *out_duration_ms = GetTickCount() - start;
            free(data_buf);
            return;
        }
    } else if (caller_kind == 2) {
        if (rq.cmd != USH_CMD_PING) {
            code = USH_ERR_CALLER_NOT_ALLOWED;
            snprintf(err_text, sizeof(err_text), "self-probe may only send ui.ping");
            ush_build_response(resp, resp_size, 0, code, rq.request_id,
                               (long)(GetTickCount() - start), NULL, err_text);
            ush_log_command(&rq, "error", code, (long)(GetTickCount() - start), NULL, 0);
            if (out_duration_ms) *out_duration_ms = GetTickCount() - start;
            free(data_buf);
            return;
        }
    } else {
        code = USH_ERR_CALLER_NOT_ALLOWED;
        snprintf(err_text, sizeof(err_text), "pipe caller not allowed");
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
    } else if (rq.cmd == USH_CMD_SELFBIND || rq.cmd == USH_CMD_SELFBIND_CLEAR ||
               rq.cmd == USH_CMD_SELFBIND_STATUS || rq.cmd == USH_CMD_SELFBIND_RENEW) {
        /* C1 自助绑定：不做 UI、不进会话门（锁屏也能链接／吊销／续期）。
         * H03 token 门已在上游通过（LEA 来路必带 token）；本模块不验
         * 准入，只信 LEA。凭据明文只进 USH，不进 data_buf（见模块头）。 */
        ok = ush_selfbind_dispatch(&rq, data_buf, USH_MAX_RESPONSE,
                                   err_code, sizeof(err_code),
                                   err_text, sizeof(err_text));
        code = ok ? "done" : err_code;
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
         * （WriteFile 可分片写大响应）；给 16MB 会建管道失败，须用小值。
         * #14：实例以 FILE_FLAG_OVERLAPPED 创建，连接与读写一律走重叠 I/O，
         * 读行才有总 deadline 可言（同步句柄的 ReadFile 无法设超时）。 */
        HANDLE pipe = CreateNamedPipeW(PIPE_NAME_W,
            PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
            1, USH_MAX_REQUEST, USH_MAX_REQUEST, 0, &sa);
        if (pipe == INVALID_HANDLE_VALUE) {
            DWORD e = GetLastError();
            char detail[128];
            snprintf(detail, sizeof(detail), "CreateNamedPipe failed error=%lu", (unsigned long)e);
            ush_log_event("pipe-create-failed", detail);
            if (e == ERROR_ACCESS_DENIED || e == ERROR_PIPE_BUSY) {
                /* r10：管道已被另一实例持有（FILE_FLAG_FIRST_PIPE_INSTANCE
                 * 拒绝为 5；实测 r9 双 USH 失败方报的是 231 ERROR_PIPE_BUSY，
                 * 旧代码只认 5，231 落入下方的每秒重试，终身刷
                 * pipe-create-failed）。探活一次，活着就干净退出整个进程：
                 * 只 break 断循环线程不够——main 还在等 g_stop_event，进程
                 * 会僵死残留（持互斥体句柄、token 文件已被它覆写）。 */
                if (pipe_probe_alive()) {
                    ush_log_event("duplicate-instance", "another USH is alive; exiting");
                    InterlockedExchange(&g_running, 0);
                    if (g_stop_event) SetEvent(g_stop_event);
                    break;
                }
                Sleep(1000);
                continue;
            }
            Sleep(1000);
            continue;
        }
        /* #14：重叠等连接（监听线程阻塞；停止时主线程用一次本地客户端
         * 连接自唤醒）。 */
        HANDLE cev = CreateEventW(NULL, TRUE, FALSE, NULL);
        if (!cev) {
            CloseHandle(pipe);
            Sleep(1000);
            continue;
        }
        OVERLAPPED cov;
        memset(&cov, 0, sizeof(cov));
        cov.hEvent = cev;
        BOOL connected = ConnectNamedPipe(pipe, &cov);
        if (!connected && GetLastError() == ERROR_IO_PENDING) {
            if (WaitForSingleObject(cev, INFINITE) == WAIT_OBJECT_0) {
                DWORD dummy = 0;
                connected = GetOverlappedResult(pipe, &cov, &dummy, FALSE);
            }
        }
        CloseHandle(cev);
        if (!connected && GetLastError() != ERROR_PIPE_CONNECTED) {
            CloseHandle(pipe);
            continue;
        }
        /* H03：先验调用方身份，不是 QFRLEA.exe／QFUserHelper.exe 直接拒，
         * 不读请求、不执行。 */
        int caller = ush_caller_kind(pipe);
        if (caller == 0) {
            char deny[512];
            ush_build_response(deny, sizeof(deny), 0, USH_ERR_CALLER_NOT_ALLOWED, "", 0,
                               NULL, "pipe caller is not QFRLEA.exe or QFUserHelper.exe");
            ush_pipe_write_all(pipe, deny, strlen(deny));
            FlushFileBuffers(pipe);
            DisconnectNamedPipe(pipe);
            CloseHandle(pipe);
            ush_log_event("caller-rejected", "non-LEA process attempted USH pipe");
            continue;
        }
        if (read_request_line(pipe, req_buf, sizeof(req_buf))) {
            DWORD dur = 0;
            handle_request(req_buf, resp_buf, USH_MAX_RESPONSE, &dur, caller);
            ush_pipe_write_all(pipe, resp_buf, strlen(resp_buf));
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
    /* --deregister（卸载第 0 步，2026-11-14）：一次性注销服务端设备登记。
     * 必须在单实例互斥／token／管道／UIA 之前分流——卸载时 USH 很可能已在
     * 运行（登录任务常驻），互斥体会让第二个实例直接退出；本分支不建管道、
     * 不写 token、不碰 UIA、不写日志，只做一次注销即退出。退出码：0＝已注销
     * 或本机无绑定（noop）；1＝已尝试但失败（NSIS 不看退出码，照常继续卸载）。 */
    if (argc > 1 && strcmp(argv[1], "--deregister") == 0) {
        char out[256] = { 0 };
        int rc = ush_selfbind_deregister(out, sizeof(out));
        printf("%s\n", out[0] ? out : "{\"deregister\":\"failed\",\"reason\":\"unknown\"}");
        fflush(stdout);
        return (rc == 0 || rc == 1) ? 0 : 1;
    }
    int debug = (argc > 1 && strcmp(argv[1], "debug") == 0);
    enable_dpi_awareness();
    ush_log_init();

    /* r10 单实例互斥（双 USH 竞态根因修复，2026-11-12）：
     * 互斥体必须在 token 生成之前抢——旧顺序先写 token 文件再查互斥，
     * 副本会把 token 文件覆写成自己的随机值，LEA 读到副本的 token、
     * 管道持有方验自己的一份 → 全部 UI 命令 QFR_USH_UNAUTHORIZED。
     * 裁决不用 pipe 探活：首实例在 token 生成＋UIA 初始化＋起管道线程
     * 之前有几百毫秒还没建管道，旧代码此时探活必失败，副本误判“旧实例
     * 已死”继续跑，双进程并存。改用互斥体所有权裁决（原子）：
     * CreateMutex(bInitialOwner=TRUE) 已存在时等 3 秒抢所有权——旧实例
     * 活着则超时，干净退出；旧实例正常退出则拿到所有权；旧实例崩溃则
     * 互斥体被遗弃（WAIT_ABANDONED），接管。退出前不写 token、不建管道。
     * 互斥体按会话命名（Local\QFRUSHMutex-<session>），多会话各一个。 */
    DWORD session_id = 0;
    ProcessIdToSessionId(GetCurrentProcessId(), &session_id);
    char mutex_name[64];
    snprintf(mutex_name, sizeof(mutex_name), "Local\\QFRUSHMutex-%lu", (unsigned long)session_id);
    HANDLE mutex = CreateMutexA(NULL, TRUE, mutex_name);
    if (mutex && GetLastError() == ERROR_ALREADY_EXISTS) {
        DWORD w = WaitForSingleObject(mutex, 3000);
        if (w == WAIT_TIMEOUT) {
            ush_log_event("duplicate-instance", "another USH instance owns the mutex; exiting");
            CloseHandle(mutex);
            return 0;
        }
        /* WAIT_OBJECT_0（旧实例刚退出）或 WAIT_ABANDONED（旧实例崩溃）：
         * 已拿到所有权，接管。 */
        ush_log_event("stale-instance", "previous USH instance is gone; taking over");
    } else if (!mutex) {
        ush_log_event("mutex-failed", "CreateMutex failed; continuing without single-instance protection");
        mutex = NULL;
    }

    /* H03：启动即生成每启动随机 token 并落盘供 LEA 读取；生成失败只记
     * 日志继续跑（token 为空时全部 LEA 命令都会被拒，fail-closed）。 */
    if (!ush_token_init())
        ush_log_event("ush-token-init-failed", "token generation failed; LEA commands will be refused");
    if (debug) {
        fprintf(stderr, "QFUserHelper %s debug mode: pipe %s\n", USH_VERSION,
            "\\\\.\\pipe\\QFR\\LEA\\UserHelper\\v1");
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
