/* lea_appclose.c — app.close 跨用户误杀修复（batch1-fix2，2026-11-16）
 * 见 lea_appclose.h 头注释：旧实现只按进程名 TerminateProcess，
 * 本模块要求 PID／用户 SID／Session ID／完整路径全量核对＋优先优雅退出。
 */
#include "lea_appclose.h"
#include "lea_protocol.h"

#include <ctype.h>
#include <stdio.h>
#include <string.h>

#ifdef _WIN32
#include <windows.h>
#include <sddl.h>
#include <tlhelp32.h>
#include <wtsapi32.h>
#endif

/* ---------- 可移植小工具 ---------- */
static int appclose_iequal(const char *a, const char *b) {
    if (!a || !b) return 0;
    while (*a && *b) {
        if (tolower((unsigned char)*a) != tolower((unsigned char)*b)) return 0;
        a++; b++;
    }
    return *a == *b;
}

static void appclose_set_reason(char *reason, size_t reason_size, const char *s) {
    if (reason && reason_size > 0) snprintf(reason, reason_size, "%s", s);
}

/* 路径末段（basename）：/ 与 \ 都认。 */
static const char *appclose_basename(const char *path) {
    const char *base = path;
    for (const char *p = path; *p; p++)
        if (*p == '\\' || *p == '/') base = p + 1;
    return base;
}

/* ---------- 纯核对逻辑（Linux 单测可跑） ---------- */
int lea_appclose_target_allowed(const lea_appclose_candidate_t *cand,
                                const lea_appclose_authorized_t *auth,
                                char *reason, size_t reason_size) {
    if (!cand || !auth) {
        appclose_set_reason(reason, reason_size, "bad-args");
        return 0;
    }
    if (cand->pid == 0) {
        appclose_set_reason(reason, reason_size, "bad-pid");
        return 0;
    }
    /* 被授权会话必须是真实交互会话：0xFFFFFFFF（无活动控制台会话）与
     * 会话 0（服务会话，主程序永不在此）一律拒绝。 */
    if (auth->session_id == 0xFFFFFFFFUL || auth->session_id == 0) {
        appclose_set_reason(reason, reason_size, "bad-session");
        return 0;
    }
    /* ① Session ID 必须一致：其他会话的同名进程一律不碰。 */
    if (cand->session_id != auth->session_id) {
        appclose_set_reason(reason, reason_size, "session-mismatch");
        return 0;
    }
    /* ② 用户 SID 必须一致：未知 SID（空串）即拒绝，不存在“查不到就放行”。 */
    if (!auth->user_sid[0] || !cand->user_sid[0]) {
        appclose_set_reason(reason, reason_size, "unknown-sid");
        return 0;
    }
    if (!appclose_iequal(cand->user_sid, auth->user_sid)) {
        appclose_set_reason(reason, reason_size, "sid-mismatch");
        return 0;
    }
    /* ③ 完整路径：先验名（QFRemote.exe），再验全路径（规范化＋大小写不敏感）。
     * 路径未知／规范化失败即拒绝。 */
    if (!cand->image_path[0] || !auth->image_path[0]) {
        appclose_set_reason(reason, reason_size, "unknown-path");
        return 0;
    }
    if (!appclose_iequal(appclose_basename(cand->image_path), "QFRemote.exe")) {
        appclose_set_reason(reason, reason_size, "name-mismatch");
        return 0;
    }
    {
        char norm_cand[LEA_APPCLOSE_PATH_MAX];
        char norm_auth[LEA_APPCLOSE_PATH_MAX];
        if (!lea_normalize_path(cand->image_path, norm_cand, sizeof(norm_cand)) ||
            !lea_normalize_path(auth->image_path, norm_auth, sizeof(norm_auth))) {
            appclose_set_reason(reason, reason_size, "unknown-path");
            return 0;
        }
        /* lea_normalize_path 保留输入的主导分隔符（\ 或 /），Windows
         * 路径比较须分隔符不敏感：比较前统一成 \。 */
        for (char *p = norm_cand; *p; p++) if (*p == '/') *p = '\\';
        for (char *p = norm_auth; *p; p++) if (*p == '/') *p = '\\';
        if (!appclose_iequal(norm_cand, norm_auth)) {
            appclose_set_reason(reason, reason_size, "path-mismatch");
            return 0;
        }
    }
    /* ④ PID：调用方指定具体 PID 时只许碰该 PID。 */
    if (auth->pid != 0 && cand->pid != auth->pid) {
        appclose_set_reason(reason, reason_size, "pid-mismatch");
        return 0;
    }
    /* ⑤ 创建时刻：调用方钉死时必须精确相等（防 PID 复用误杀）；候选
     * 创建时刻未知（0）时同样拒绝——未知不能当作相等。 */
    if (auth->create_time != 0) {
        if (cand->create_time == 0 || cand->create_time != auth->create_time) {
            appclose_set_reason(reason, reason_size, "create-time-mismatch");
            return 0;
        }
    }
    appclose_set_reason(reason, reason_size, "ok");
    return 1;
}

#ifdef _WIN32
/* ---------- Windows-only：探测／身份解析／优雅退出 ---------- */

/* 宽字符转 UTF-8（QFRLEA.c 另有同名静态助手，此处模块内自含，避免跨文件依赖）。 */
static int appclose_wide_to_utf8(const WCHAR *w, char *out, size_t out_size) {
    if (!w || !out || out_size == 0) return 0;
    int n = WideCharToMultiByte(CP_UTF8, 0, w, -1, out, (int)out_size, NULL, NULL);
    return n > 0;
}

int lea_appclose_probe(unsigned long pid, lea_appclose_candidate_t *out) {
    if (!out || pid == 0) return 0;
    memset(out, 0, sizeof(*out));
    out->pid = pid;
    /* Session ID。 */
    DWORD session = 0;
    if (!ProcessIdToSessionId(pid, &session)) return 0;
    out->session_id = session;
    HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (!h) return 0;
    int ok = 0;
    /* 完整路径。 */
    WCHAR img[MAX_PATH];
    DWORD n = MAX_PATH;
    if (!QueryFullProcessImageNameW(h, 0, img, &n) || n == 0) goto done;
    if (!appclose_wide_to_utf8(img, out->image_path, sizeof(out->image_path))) goto done;
    /* 创建时刻（防 PID 复用）。 */
    {
        FILETIME cft, eft, kft, uft;
        if (GetProcessTimes(h, &cft, &eft, &kft, &uft))
            out->create_time = ((unsigned long long)cft.dwHighDateTime << 32) |
                               (unsigned long long)cft.dwLowDateTime;
    }
    /* 用户 SID（进程令牌 TokenUser → 字符串形式）。 */
    {
        HANDLE tok = NULL;
        if (!OpenProcessToken(h, TOKEN_QUERY, &tok)) goto done;
        DWORD need = 0;
        GetTokenInformation(tok, TokenUser, NULL, 0, &need);
        if (need == 0 || need > 4096) { CloseHandle(tok); goto done; }
        BYTE buf[4096];
        if (!GetTokenInformation(tok, TokenUser, buf, need, &need)) {
            CloseHandle(tok);
            goto done;
        }
        CloseHandle(tok);
        TOKEN_USER *tu = (TOKEN_USER *)buf;
        char *sid_str = NULL;
        if (!ConvertSidToStringSidA(tu->User.Sid, &sid_str) || !sid_str) goto done;
        snprintf(out->user_sid, sizeof(out->user_sid), "%s", sid_str);
        LocalFree(sid_str);
    }
    ok = 1;
done:
    CloseHandle(h);
    if (!ok) memset(out, 0, sizeof(*out));
    return ok;
}

/* 读字符串注册表值（REG_SZ／REG_EXPAND_SZ）。返回 1=读到。 */
static int appclose_reg_string(HKEY root, const char *subkey, const char *value,
                               char *out, size_t out_size) {
    HKEY k = NULL;
    if (RegOpenKeyExA(root, subkey, 0, KEY_READ, &k) != ERROR_SUCCESS) return 0;
    DWORD type = 0;
    DWORD cb = (DWORD)out_size;
    LONG r = RegQueryValueExA(k, value, NULL, &type, (LPBYTE)out, &cb);
    RegCloseKey(k);
    if (r != ERROR_SUCCESS) return 0;
    if (type != REG_SZ && type != REG_EXPAND_SZ) return 0;
    out[out_size - 1] = '\0';
    return out[0] != '\0';
}

/* 被授权会话用户的安装位置 QFRemote.exe 全路径。
 * 首选：HKEY_USERS\<sid>\Software\Microsoft\Windows\CurrentVersion\
 *   Uninstall\QFRemote 的 InstallLocation（安装器写入，$INSTDIR 可改时仍准）。
 * 回退：HKLM ProfileList\<sid> 的 ProfileImagePath ＋
 *   \AppData\Local\Programs\QFRemote\QFRemote.exe（安装器默认位置）。
 * 两者都取不到返回 0（调用方拒绝执行）。 */
static int appclose_expected_image(const char *sid_str, char *out, size_t out_size) {
    char subkey[512];
    char loc[LEA_APPCLOSE_PATH_MAX];
    snprintf(subkey, sizeof(subkey),
             "%s\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\QFRemote",
             sid_str);
    if (appclose_reg_string(HKEY_USERS, subkey, "InstallLocation", loc, sizeof(loc))) {
        size_t l = strlen(loc);
        while (l > 0 && (loc[l - 1] == '\\' || loc[l - 1] == '/')) loc[--l] = '\0';
        snprintf(out, out_size, "%s\\QFRemote.exe", loc);
        return out[0] != '\0';
    }
    snprintf(subkey, sizeof(subkey),
             "SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList\\%s", sid_str);
    char profile[LEA_APPCLOSE_PATH_MAX];
    if (appclose_reg_string(HKEY_LOCAL_MACHINE, subkey, "ProfileImagePath",
                            profile, sizeof(profile))) {
        size_t l = strlen(profile);
        while (l > 0 && (profile[l - 1] == '\\' || profile[l - 1] == '/'))
            profile[--l] = '\0';
        snprintf(out, out_size, "%s\\AppData\\Local\\Programs\\QFRemote\\QFRemote.exe",
                 profile);
        return out[0] != '\0';
    }
    return 0;
}

int lea_appclose_authorized_identity(unsigned long session_id,
                                     char *sid_out, size_t sid_size,
                                     char *image_out, size_t image_size) {
    if (session_id == 0xFFFFFFFFUL || session_id == 0) return 0;
    if (!sid_out || sid_size == 0 || !image_out || image_size == 0) return 0;
    /* 会话用户名（WTSUserName＋WTSDomainName）→ LookupAccountName 取 SID。 */
    LPSTR user = NULL, domain = NULL;
    DWORD bytes = 0;
    if (!WTSQuerySessionInformationA(WTS_CURRENT_SERVER_HANDLE, session_id,
                                     WTSUserName, &user, &bytes) || !user || !*user)
        return 0;
    if (!WTSQuerySessionInformationA(WTS_CURRENT_SERVER_HANDLE, session_id,
                                     WTSDomainName, &domain, &bytes) || !domain)
        domain = NULL; /* 本地账户可能无域：按裸用户名查 */
    char account[512];
    if (domain && *domain) snprintf(account, sizeof(account), "%s\\%s", domain, user);
    else snprintf(account, sizeof(account), "%s", user);
    WTSFreeMemory(user);
    if (domain) WTSFreeMemory(domain);
    DWORD sid_len = 0, dom_len = 0;
    SID_NAME_USE use;
    LookupAccountNameA(NULL, account, NULL, &sid_len, NULL, &dom_len, &use);
    if (sid_len == 0 || sid_len > 1024) return 0;
    BYTE sid_buf[1024];
    char dom_buf[256];
    dom_len = sizeof(dom_buf);
    if (!LookupAccountNameA(NULL, account, sid_buf, &sid_len,
                            dom_buf, &dom_len, &use))
        return 0;
    char *sid_str = NULL;
    if (!ConvertSidToStringSidA(sid_buf, &sid_str) || !sid_str) return 0;
    snprintf(sid_out, sid_size, "%s", sid_str);
    LocalFree(sid_str);
    /* 安装位置全路径（SID 键控，不猜、不跨用户读 HKCU）。 */
    if (!appclose_expected_image(sid_out, image_out, image_size)) return 0;
    return 1;
}

/* EnumWindows 回调：把属于目标 PID 的可见顶层窗口发 WM_CLOSE。 */
typedef struct {
    const unsigned long *pids;
    int n;
    int posted;
} appclose_enum_ctx_t;

static BOOL CALLBACK appclose_enum_wnd(HWND hwnd, LPARAM lp) {
    appclose_enum_ctx_t *ctx = (appclose_enum_ctx_t *)lp;
    if (!IsWindowVisible(hwnd)) return TRUE;
    /* 跳过子窗口：只关顶层窗口。 */
    if (GetParent(hwnd) != NULL) return TRUE;
    DWORD wpid = 0;
    GetWindowThreadProcessId(hwnd, &wpid);
    for (int i = 0; i < ctx->n; i++) {
        if (wpid == ctx->pids[i]) {
            PostMessageW(hwnd, WM_CLOSE, 0, 0);
            ctx->posted++;
            break;
        }
    }
    return TRUE;
}

int lea_appclose_process_exited(unsigned long pid) {
    if (pid == 0) return -1;
    HANDLE h = OpenProcess(SYNCHRONIZE, FALSE, pid);
    if (!h) {
        /* 进程已不存在时 OpenProcess 报 INVALID_PARAMETER／ACCESS_DENIED
         * 均可能；此处按“查不到”返回 -1，由调用方重探测判定。 */
        return -1;
    }
    DWORD r = WaitForSingleObject(h, 0);
    CloseHandle(h);
    return r == WAIT_OBJECT_0 ? 1 : 0;
}

int lea_appclose_request_exit(const unsigned long *pids, int n,
                              unsigned long timeout_ms, int *exited) {
    if (!pids || n <= 0 || !exited) return -1;
    for (int i = 0; i < n; i++) exited[i] = 0;
    appclose_enum_ctx_t ctx;
    ctx.pids = pids;
    ctx.n = n;
    ctx.posted = 0;
    EnumWindows(appclose_enum_wnd, (LPARAM)&ctx);
    /* 共享等待预算：轮询至 deadline，任一时刻全退即提前返回。 */
    ULONGLONG deadline = GetTickCount64() + timeout_ms;
    for (;;) {
        int all = 1;
        for (int i = 0; i < n; i++) {
            if (exited[i]) continue;
            int st = lea_appclose_process_exited(pids[i]);
            if (st == 1) exited[i] = 1;
            else all = 0;
        }
        if (all) return 1;
        if (GetTickCount64() >= deadline) return 0;
        Sleep(100);
    }
}
#endif /* _WIN32 */
