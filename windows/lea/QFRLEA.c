/* QFRLEA —— QFRemote 本地执行代理服务（Stage 1 MVP，v0.1.0-mvp）
 * =================================================================
 * Windows 系统服务（服务名 QFRLEA，SYSTEM 身份），参照
 * windows/syshelper/QFSysHelper.c 的结构与安全模型：
 *   - 命名管道 \\.\pipe\QFR\LEA\v1，SDDL 仅 SYSTEM＋Administrators
 *     （QFSysHelper 另含 AU；LEA 收紧为 SY＋BA，因为调用方是经
 *     runcommands 以 SYSTEM 运行的 qf-lea-client.exe，或管理员）。
 *   - 一行 JSON 请求 → 一行 JSON 响应。
 *   - 第二层准入（DESIGN §6.2）：Ed25519 服务端签名（占位，见
 *     lea_crypto.c，默认 fail-closed）＋ binding_epoch ＋ scope ＋
 *     API Key 归属（本地吊销表）＋重放表。签名规范串 v1 唯一规范源：
 *     ~/workspace/qfremote/local-agent/ds-review-stage2/CANONICAL-SIGNING-V1.md
 *     （信封 16 行／票据 9 行，两端同一份）。
 *   - 幂等：本地持久化去重表 %ProgramData%\QFR\LEA\state\idempotency.jsonl。
 *   - 队列：同一设备串行 FIFO（worker 单线程），上限 100 条；危险命令单独 lane。
 *   - 脚本：只允许白名单脚本（初始仅 qf-agent-heal.ps1，hash 见 whitelist.h，
 *     待站长确认完整清单 DESIGN §14 #5）；PowerShell 固定
 *     -NoProfile -NonInteractive -ExecutionPolicy Bypass -File，参数逐个
 *     引用转义，禁 shell 拼接；路径规范化防 .. 越界。
 *   - app.open：只允许显式 exe 白名单（H16：名＋SHA-256 双重判定，初版仅
 *     QFUserHelper.exe；安装目录内其他 exe 一律拒绝）。
 *   - UI 类命令：经命名管道 \\.\pipe\QFR\LEA\UserHelper\v1 转发 USH
 *     （USH 由另一线实现；此处只做转发＋超时＋USH 不可用时明确报错）。
 *   - 日志：%ProgramData%\QFR\LEA\logs\lea-YYYY-MM-DD.jsonl，保留 30 天，
 *     ACL 仅 SYSTEM／Administrators；API Key 只记 key_id 与前缀片段。
 *   - 绑定：DPAPI LocalMachine 加密存 %ProgramData%\QFR\LEA\state\binding.dat。
 *
 * 安全边界（写死，不许放宽）：
 *   - 不做内核驱动、不做进程注入；不存明文密码、不记 API Key 明文；
 *   - 本地不监听任何 TCP/UDP 端口，只监听命名管道；
 *   - 不执行白名单外的任何脚本／程序；不接受调用方传来的 shell 命令串。
 *
 * 构建（Linux 交叉编译，见 build.sh）：
 *   x86_64-w64-mingw32-gcc -O2 -Wall -o QFRLEA.exe QFRLEA.c lea_protocol.c \
 *       lea_crypto.c lea_state.c lea_audit.c -ladvapi32 -lcrypt32
 * 调试：QFRLEA.exe debug —— 前台跑管道循环（不注册 SCM），供真机自测。
 * 测试冒烟构建（仅单测／真机冒烟，生产绝不启用）：
 *   加 -DLEA_TEST_UNSIGNED=1 后 signature "TEST-UNSIGNED" 放行。
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <sddl.h>
#include <aclapi.h>
#include <dpapi.h>
#include <tlhelp32.h>
#include <wchar.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include "lea_protocol.h"
#include "lea_crypto.h"
#include "lea_state.h"
#include "lea_audit.h"
#include "whitelist.h"

#define SERVICE_NAME_W L"QFRLEA"
#define SERVICE_DISPLAY_W L"QFRemote 本地执行代理"
#define PIPE_NAME_W L"\\\\.\\pipe\\QFR\\LEA\\v1"
#define USH_PIPE_NAME_W L"\\\\.\\pipe\\QFR\\LEA\\UserHelper\\v1"
#define PIPE_SDDL_W L"D:(A;;GA;;;SY)(A;;GA;;;BA)"
#define DIR_SDDL_W L"D:(A;;FA;;;SY)(A;;FA;;;BA)"
#define PIPE_MAX_INSTANCES 8
#define USH_CONNECT_TIMEOUT_MS 2000

static SERVICE_STATUS_HANDLE g_status_handle = NULL;
static SERVICE_STATUS g_status;
static HANDLE g_stop_event = NULL;
static volatile LONG g_running = 1;
static time_t g_started_at = 0;

/* ---------- 全局状态（g_lock 保护） ---------- */
static CRITICAL_SECTION g_lock;
static CRITICAL_SECTION g_audit_lock;
static lea_binding_t g_binding;
static lea_replay_t g_replay;
static lea_idem_t g_idem;
static lea_queue_t g_queue;
static HANDLE g_queue_event = NULL;
static int g_inflight = 0; /* 已入队未完成数 */
static long long g_last_prune_hour = -1;

/* 路径（UTF-8） */
static char g_base_dir[MAX_PATH];      /* %ProgramData%\QFR\LEA */
static char g_state_dir[MAX_PATH];
static char g_logs_dir[MAX_PATH];
static char g_work_dir[MAX_PATH];
static char g_install_dir[MAX_PATH];   /* QFRLEA.exe 所在目录 */
static char g_idem_path[MAX_PATH];
static char g_binding_path[MAX_PATH];
static char g_revoked_path[MAX_PATH];
static char g_service_log_path[MAX_PATH];

/* ---------- 小工具 ---------- */
static long long now_unix(void) { return (long long)time(NULL); }

/* lea_rebuild_envelope 已移入 lea_protocol.c（纯协议层，可单测），声明见 lea_protocol.h。 */

static void utf16_to_utf8(const WCHAR *w, char *out, size_t out_size) {
    if (!w || !out || out_size < 1) return;
    WideCharToMultiByte(CP_UTF8, 0, w, -1, out, (int)out_size, NULL, NULL);
}

static void utf8_to_utf16(const char *u, WCHAR *out, size_t out_size) {
    if (!u || !out || out_size < 1) return;
    MultiByteToWideChar(CP_UTF8, 0, u, -1, out, (int)out_size);
}

/* 本地日期 YYYY-MM-DD 与 ISO 时间戳（含本地时区偏移）。 */
static void local_date_iso(char *date_ymd, size_t date_size, char *iso, size_t iso_size) {
    SYSTEMTIME st;
    GetLocalTime(&st);
    TIME_ZONE_INFORMATION tz;
    DWORD tzr = GetTimeZoneInformation(&tz);
    LONG bias = (tzr == TIME_ZONE_ID_DAYLIGHT) ? tz.Bias + tz.DaylightBias : tz.Bias;
    int sign = bias <= 0 ? '+' : '-';
    LONG ab = bias < 0 ? -bias : bias;
    if (date_ymd) snprintf(date_ymd, date_size, "%04d-%02d-%02d", st.wYear, st.wMonth, st.wDay);
    if (iso) snprintf(iso, iso_size, "%04d-%02d-%02dT%02d:%02d:%02d%c%02d:%02d",
                      st.wYear, st.wMonth, st.wDay, st.wHour, st.wMinute, st.wSecond,
                      sign, (int)(ab / 60), (int)(ab % 60));
}

/* 明文服务日志（仅生命周期／启动错误；业务审计走 JSONL）。 */
static void svc_log(const char *fmt, ...) {
    char line[2048];
    char date_ymd[16] = { 0 }, iso[40] = { 0 };
    local_date_iso(date_ymd, sizeof(date_ymd), iso, sizeof(iso));
    int off = snprintf(line, sizeof(line), "%s ", iso);
    if (off < 0) return;
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(line + off, sizeof(line) - (size_t)off, fmt, ap);
    va_end(ap);
    FILE *f = fopen(g_service_log_path, "a");
    if (!f) return;
    fputs(line, f);
    fputc('\n', f);
    fclose(f);
}

static int mkdir_one(const char *path) {
    WCHAR w[MAX_PATH];
    utf8_to_utf16(path, w, MAX_PATH);
    if (CreateDirectoryW(w, NULL)) return 1;
    return GetLastError() == ERROR_ALREADY_EXISTS;
}

/* 目录／文件 ACL：仅 SYSTEM＋Administrators 完全控制。 */
static void set_sys_admin_acl(const char *path_utf8) {
    PSECURITY_DESCRIPTOR sd = NULL;
    if (!ConvertStringSecurityDescriptorToSecurityDescriptorA(
            "D:(A;;FA;;;SY)(A;;FA;;;BA)", SDDL_REVISION_1, &sd, NULL))
        return;
    WCHAR w[MAX_PATH];
    utf8_to_utf16(path_utf8, w, MAX_PATH);
    SetNamedSecurityInfoW(w, SE_FILE_OBJECT,
                          DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                          NULL, NULL, ((SECURITY_DESCRIPTOR *)sd)->Dacl, NULL);
    LocalFree(sd);
}

static void ensure_dirs(void) {
    char pd[MAX_PATH] = { 0 };
    WCHAR wpd[MAX_PATH];
    DWORD n = GetEnvironmentVariableW(L"ProgramData", wpd, MAX_PATH);
    if (n == 0 || n >= MAX_PATH) wcscpy_s(wpd, MAX_PATH, L"C:\\ProgramData");
    utf16_to_utf8(wpd, pd, sizeof(pd));
    snprintf(g_base_dir, sizeof(g_base_dir), "%s\\QFR\\LEA", pd);
    /* 逐级建目录 */
    {
        char tmp[MAX_PATH];
        snprintf(tmp, sizeof(tmp), "%s\\QFR", pd);
        mkdir_one(tmp);
    }
    mkdir_one(g_base_dir);
    snprintf(g_state_dir, sizeof(g_state_dir), "%s\\state", g_base_dir);
    snprintf(g_logs_dir, sizeof(g_logs_dir), "%s\\logs", g_base_dir);
    snprintf(g_work_dir, sizeof(g_work_dir), "%s\\work", g_base_dir);
    mkdir_one(g_state_dir);
    mkdir_one(g_logs_dir);
    mkdir_one(g_work_dir);
    set_sys_admin_acl(g_base_dir);
    set_sys_admin_acl(g_state_dir);
    set_sys_admin_acl(g_logs_dir);
    set_sys_admin_acl(g_work_dir);
    snprintf(g_idem_path, sizeof(g_idem_path), "%s\\idempotency.jsonl", g_state_dir);
    snprintf(g_binding_path, sizeof(g_binding_path), "%s\\binding.dat", g_state_dir);
    snprintf(g_revoked_path, sizeof(g_revoked_path), "%s\\revoked_keys.txt", g_state_dir);
    snprintf(g_service_log_path, sizeof(g_service_log_path), "%s\\lea-service.log", g_logs_dir);
    /* 安装目录 = 本 exe 所在目录 */
    {
        WCHAR mod[MAX_PATH];
        GetModuleFileNameW(NULL, mod, MAX_PATH);
        WCHAR *slash = wcsrchr(mod, L'\\');
        if (slash) *slash = L'\0';
        utf16_to_utf8(mod, g_install_dir, sizeof(g_install_dir));
    }
}

/* ---------- 审计 ---------- */
static void audit_event(const lea_audit_event_t *ev) {
    char date_ymd[16] = { 0 }, iso[40] = { 0 };
    local_date_iso(date_ymd, sizeof(date_ymd), iso, sizeof(iso));
    EnterCriticalSection(&g_audit_lock);
    /* 目录分隔符：lea_audit_append 用 '/' 拼接，Windows fopen 接受。 */
    char dir_slash[MAX_PATH];
    snprintf(dir_slash, sizeof(dir_slash), "%s", g_logs_dir);
    for (char *p = dir_slash; *p; p++) if (*p == '\\') *p = '/';
    lea_audit_append(dir_slash, date_ymd, ev, iso);
    LeaveCriticalSection(&g_audit_lock);
}

static void audit_for_envelope(const lea_envelope_t *env, const char *event,
                               const char *result, const char *error_code,
                               long duration_ms, const char *detail) {
    char params_hash[65] = { 0 };
    lea_sha256_hex((const unsigned char *)env->params_raw, strlen(env->params_raw), params_hash);
    lea_audit_event_t ev;
    memset(&ev, 0, sizeof(ev));
    ev.event = event;
    ev.trace_id = env->trace_id[0] ? env->trace_id : env->request_id;
    ev.request_id = env->request_id;
    ev.batch_id = env->batch_id;
    ev.seq = env->seq;
    ev.account_id = env->account_id;
    ev.device_id = env->device_id;
    ev.api_key_id = env->api_key_id;
    ev.key_prefix_redacted = "";
    ev.binding_epoch = env->binding_epoch;
    ev.command = env->command;
    ev.params_hash = params_hash;
    ev.idempotency_key = env->idempotency_key;
    ev.nonce = env->nonce;
    ev.result = result;
    ev.error_code = error_code ? error_code : "";
    ev.duration_ms = duration_ms;
    ev.ush_session_id = "";
    ev.process_id = 0;
    ev.retry_count = 0;
    ev.detail = detail ? detail : "";
    audit_event(&ev);
}

/* ---------- 幂等持久化 ---------- */
static void idem_persist_locked(void) {
    /* 调用方须持有 g_lock。表可能很大时仍全量重写（MVP：表 ≤2048 条）。 */
    static char *buf = NULL;
    static size_t buf_size = 0;
    if (!buf) {
        buf_size = 4 * 1024 * 1024;
        buf = (char *)malloc(buf_size);
        if (!buf) return;
    }
    if (!lea_idem_save_text(&g_idem, buf, buf_size)) {
        svc_log("WARN idem save overflow, table not persisted");
        return;
    }
    char tmp_path[MAX_PATH];
    snprintf(tmp_path, sizeof(tmp_path), "%s.tmp", g_idem_path);
    FILE *f = fopen(tmp_path, "w");
    if (!f) return;
    fputs(buf, f);
    fclose(f);
    /* 原子替换：先删旧文件再改名（Windows MoveFile 不覆盖已存在目标时用此法）。 */
    remove(g_idem_path);
    rename(tmp_path, g_idem_path);
    set_sys_admin_acl(g_idem_path);
}

static void idem_load(void) {
    FILE *f = fopen(g_idem_path, "r");
    if (!f) return;
    fseek(f, 0, SEEK_END);
    long sz = ftell(f);
    fseek(f, 0, SEEK_SET);
    if (sz <= 0 || sz > 4 * 1024 * 1024) { fclose(f); return; }
    char *buf = (char *)malloc((size_t)sz + 1);
    if (!buf) { fclose(f); return; }
    size_t r = fread(buf, 1, (size_t)sz, f);
    fclose(f);
    buf[r] = '\0';
    if (!lea_idem_load_text(&g_idem, buf)) {
        svc_log("WARN idem load failed, starting with empty table");
        lea_idem_init(&g_idem);
    }
    free(buf);
}

/* ---------- 绑定持久化（DPAPI LocalMachine） ---------- */
static void binding_persist_locked(void) {
    char text[1024];
    snprintf(text, sizeof(text),
             "{\"account_id\":\"%s\",\"device_id\":\"%s\",\"epoch\":%lld,"
             "\"grant_epoch\":%lld,\"grant\":%d,\"scopes\":\"%s\","
             "\"expires_at\":%lld,\"lease_id\":\"%s\",\"state\":%d}",
             g_binding.account_id, g_binding.device_id, g_binding.epoch,
             g_binding.grant_epoch, g_binding.grant_muse_execute,
             g_binding.scopes, g_binding.expires_at, g_binding.lease_id,
             (int)g_binding.state);
    DATA_BLOB in, out;
    in.pbData = (BYTE *)text;
    in.cbData = (DWORD)strlen(text) + 1;
    memset(&out, 0, sizeof(out));
    if (!CryptProtectData(&in, L"QFRLEA binding", NULL, NULL, NULL,
                          CRYPTPROTECT_LOCAL_MACHINE, &out)) {
        svc_log("ERROR DPAPI protect binding failed %lu", (unsigned long)GetLastError());
        return;
    }
    FILE *f = fopen(g_binding_path, "wb");
    if (!f) {
        LocalFree(out.pbData);
        return;
    }
    fwrite(out.pbData, 1, out.cbData, f);
    fclose(f);
    LocalFree(out.pbData);
    set_sys_admin_acl(g_binding_path);
}

static void binding_load(void) {
    FILE *f = fopen(g_binding_path, "rb");
    if (!f) return;
    fseek(f, 0, SEEK_END);
    long sz = ftell(f);
    fseek(f, 0, SEEK_SET);
    if (sz <= 0 || sz > 65536) { fclose(f); return; }
    BYTE *blob = (BYTE *)malloc((size_t)sz);
    if (!blob) { fclose(f); return; }
    size_t r = fread(blob, 1, (size_t)sz, f);
    fclose(f);
    DATA_BLOB in, out;
    in.pbData = blob;
    in.cbData = (DWORD)r;
    memset(&out, 0, sizeof(out));
    if (!CryptUnprotectData(&in, NULL, NULL, NULL, NULL, CRYPTPROTECT_LOCAL_MACHINE, &out)) {
        svc_log("WARN DPAPI unprotect binding failed, starting UNBOUND");
        free(blob);
        return;
    }
    free(blob);
    char *text = (char *)out.pbData;
    long long epoch = 0, grant_epoch = 0, expires_at = 0, state = 0, grant = 0;
    lea_json_string(text, "account_id", g_binding.account_id, sizeof(g_binding.account_id));
    lea_json_string(text, "device_id", g_binding.device_id, sizeof(g_binding.device_id));
    lea_json_long(text, "epoch", &epoch);
    lea_json_long(text, "grant_epoch", &grant_epoch);
    lea_json_long(text, "grant", &grant);
    lea_json_string(text, "scopes", g_binding.scopes, sizeof(g_binding.scopes));
    lea_json_long(text, "expires_at", &expires_at);
    lea_json_string(text, "lease_id", g_binding.lease_id, sizeof(g_binding.lease_id));
    lea_json_long(text, "state", &state);
    g_binding.epoch = epoch;
    g_binding.grant_epoch = grant_epoch;
    g_binding.grant_muse_execute = (int)grant;
    g_binding.expires_at = expires_at;
    g_binding.state = (state >= 0 && state <= 3) ? (lea_bind_state_t)state : LEA_BIND_UNBOUND;
    g_binding.updated_at = now_unix();
    LocalFree(out.pbData);
    svc_log("binding loaded state=%s account=%s epoch=%lld",
            lea_bind_state_name(g_binding.state), g_binding.account_id, g_binding.epoch);
}

/* ---------- 吊销表 ---------- */
static int key_is_revoked(const char *api_key_id) {
    FILE *f = fopen(g_revoked_path, "r");
    if (!f) return 0;
    char line[128];
    int found = 0;
    while (fgets(line, sizeof(line), f)) {
        size_t n = strlen(line);
        while (n > 0 && (line[n - 1] == '\n' || line[n - 1] == '\r' || line[n - 1] == ' '))
            line[--n] = '\0';
        if (line[0] && strcmp(line, api_key_id) == 0) { found = 1; break; }
    }
    fclose(f);
    return found;
}

/* ---------- 命令行引用转义（C 版 ArgumentList 等价物） ---------- */
/* 按 MSVC 规则引用单个参数：包在双引号内，" 前的 \ 加倍，末尾 \ 加倍。 */
static void quote_arg(const char *arg, char *out, size_t out_size) {
    size_t o = 0;
    if (o + 1 >= out_size) { out[0] = '\0'; return; }
    out[o++] = '"';
    size_t backslashes = 0;
    for (const char *p = arg; *p; p++) {
        if (*p == '\\') { backslashes++; continue; }
        if (*p == '"') {
            for (size_t i = 0; i < backslashes * 2 + 1; i++) {
                if (o + 1 >= out_size) goto done;
                out[o++] = '\\';
            }
            if (o + 1 >= out_size) goto done;
            out[o++] = '"';
            backslashes = 0;
            continue;
        }
        for (size_t i = 0; i < backslashes; i++) {
            if (o + 1 >= out_size) goto done;
            out[o++] = '\\';
        }
        backslashes = 0;
        if (o + 1 >= out_size) goto done;
        out[o++] = *p;
    }
    for (size_t i = 0; i < backslashes * 2; i++) {
        if (o + 1 >= out_size) goto done;
        out[o++] = '\\';
    }
done:
    if (o + 1 >= out_size) o = out_size - 2;
    out[o++] = '"';
    out[o] = '\0';
}

/* ---------- 脚本白名单 ---------- */
/* 初始清单（DESIGN §5.2，待站长确认完整清单 §14 #5）：仅 qf-agent-heal.ps1。
 * 判定三重门：① 路径规范化后位于安装目录内；② basename 吻合；
 * ③ SHA-256 与 whitelist.h 一致（gen_whitelist.py 从发版文件生成）。 */
/* SHA-256 十六进制串大小写不敏感比较（白名单 hash 比对共用）。 */
static int hash_hex_equal(const char *a, const char *b) {
    if (!a || !b) return 0;
    size_t la = strlen(a), lb = strlen(b);
    if (la == 0 || la != lb) return 0;
    for (size_t i = 0; i < la; i++) {
        char ca = a[i], cb = b[i];
        if (ca >= 'A' && ca <= 'F') ca = (char)(ca + 32);
        if (cb >= 'A' && cb <= 'F') cb = (char)(cb + 32);
        if (ca != cb) return 0;
    }
    return 1;
}
static int script_is_allowed(const char *script_path, char *norm_out, size_t norm_size,
                             char *detail, size_t detail_size) {
    if (!lea_normalize_path(script_path, norm_out, norm_size)) {
        snprintf(detail, detail_size, "%s", "path-normalize-failed");
        return 0;
    }
    /* 必须绝对路径 */
    if (!((norm_out[0] >= 'A' && norm_out[0] <= 'Z') ||
          (norm_out[0] >= 'a' && norm_out[0] <= 'z')) || norm_out[1] != ':') {
        snprintf(detail, detail_size, "%s", "not-absolute");
        return 0;
    }
    char norm_install[MAX_PATH] = { 0 };
    if (!lea_normalize_path(g_install_dir, norm_install, sizeof(norm_install))) {
        snprintf(detail, detail_size, "%s", "install-dir-error");
        return 0;
    }
    if (!lea_path_under_root(norm_out, norm_install)) {
        snprintf(detail, detail_size, "%s", "outside-install-dir");
        return 0;
    }
    const char *base = strrchr(norm_out, '\\');
    const char *base2 = strrchr(norm_out, '/');
    if (base2 && (!base || base2 > base)) base = base2;
    base = base ? base + 1 : norm_out;
    if (strcmp(base, "qf-agent-heal.ps1") != 0) {
        snprintf(detail, detail_size, "not-in-script-whitelist:%.64s", base);
        return 0;
    }
    char hex[65] = { 0 };
    if (!lea_sha256_file_hex(norm_out, hex)) {
        snprintf(detail, detail_size, "%s", "script-not-found");
        return 0;
    }
    if (!hash_hex_equal(hex, W_HEAL_PS1_SHA256)) {
        snprintf(detail, detail_size, "%s", "hash-mismatch");
        return 0;
    }
    return 1;
}

/* ---------- 执行：PowerShell 脚本 ---------- */
static int run_powershell_script(const char *script_norm, char args[][512], int nargs,
                                 long timeout_ms, DWORD *exit_code,
                                 char *output, size_t output_size) {
    WCHAR ps_path[MAX_PATH];
    {
        WCHAR sysroot[MAX_PATH];
        DWORD n = GetEnvironmentVariableW(L"SystemRoot", sysroot, MAX_PATH);
        if (n == 0 || n >= MAX_PATH) wcscpy_s(sysroot, MAX_PATH, L"C:\\Windows");
        _snwprintf(ps_path, MAX_PATH, L"%s\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", sysroot);
    }
    /* stdout/stderr 重定向到 work 目录临时文件（上限 64KB 回传）。 */
    char out_path[MAX_PATH];
    snprintf(out_path, sizeof(out_path), "%s\\script-out-%llu.txt", g_work_dir,
             (unsigned long long)now_unix());
    WCHAR wout[MAX_PATH];
    utf8_to_utf16(out_path, wout, MAX_PATH);
    HANDLE hOut = CreateFileW(wout, GENERIC_WRITE, FILE_SHARE_READ, NULL,
                              CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (hOut == INVALID_HANDLE_VALUE) return 0;

    WCHAR cmdline[8192];
    WCHAR wscript[MAX_PATH];
    utf8_to_utf16(script_norm, wscript, MAX_PATH);
    _snwprintf(cmdline, 8192,
               L"powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"%s\"",
               wscript);
    for (int i = 0; i < nargs; i++) {
        char q[1100];
        quote_arg(args[i], q, sizeof(q));
        WCHAR wq[1100];
        utf8_to_utf16(q, wq, 1100);
        wcscat_s(cmdline, 8192, L" ");
        wcscat_s(cmdline, 8192, wq);
    }
    STARTUPINFOW si;
    PROCESS_INFORMATION pi;
    ZeroMemory(&si, sizeof(si));
    si.cb = sizeof(si);
    si.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
    si.wShowWindow = SW_HIDE;
    si.hStdOutput = hOut;
    si.hStdError = hOut;
    /* 服务无控制台 stdin：接 NUL，避免 CreateProcess 因无效 stdin 失败。 */
    si.hStdInput = CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE,
                               NULL, OPEN_EXISTING, 0, NULL);
    if (si.hStdInput == INVALID_HANDLE_VALUE) {
        CloseHandle(hOut);
        return 0;
    }
    ZeroMemory(&pi, sizeof(pi));
    if (!CreateProcessW(ps_path, cmdline, NULL, NULL, TRUE,
                        CREATE_NO_WINDOW, NULL, NULL, &si, &pi)) {
        CloseHandle(hOut);
        CloseHandle(si.hStdInput);
        return 0;
    }
    CloseHandle(hOut);
    CloseHandle(si.hStdInput);
    DWORD w = WaitForSingleObject(pi.hProcess, (DWORD)timeout_ms);
    if (w == WAIT_TIMEOUT) {
        TerminateProcess(pi.hProcess, 1);
        CloseHandle(pi.hProcess);
        CloseHandle(pi.hThread);
        return -1;
    }
    DWORD code = 1;
    GetExitCodeProcess(pi.hProcess, &code);
    if (exit_code) *exit_code = code;
    CloseHandle(pi.hProcess);
    CloseHandle(pi.hThread);
    /* 读回输出（截断到 output_size-1）。 */
    FILE *f = fopen(out_path, "rb");
    if (f) {
        size_t r = fread(output, 1, output_size - 1, f);
        output[r] = '\0';
        fclose(f);
    } else {
        output[0] = '\0';
    }
    remove(out_path);
    return 1;
}

/* ---------- 执行：文件读写（白名单目录 %ProgramData%\QFR\LEA\work） ---------- */
static int file_in_work_root(const char *path, char *norm_out, size_t norm_size,
                             char *detail, size_t detail_size) {
    if (!lea_normalize_path(path, norm_out, norm_size)) {
        snprintf(detail, detail_size, "%s", "path-normalize-failed");
        return 0;
    }
    char norm_root[MAX_PATH] = { 0 };
    if (!lea_normalize_path(g_work_dir, norm_root, sizeof(norm_root))) {
        snprintf(detail, detail_size, "%s", "work-dir-error");
        return 0;
    }
    if (!lea_path_under_root(norm_out, norm_root)) {
        snprintf(detail, detail_size, "%s", "outside-work-root");
        return 0;
    }
    return 1;
}

/* ---------- 执行：app.open / app.close ---------- */
/* H16：app.open 显式 exe 白名单（名＋SHA-256，双重判定；见 whitelist.h，
 * gen_whitelist.py 从发版文件生成）。初版唯一入口：QFUserHelper.exe
 * （用户会话助手；远程重启是其合法用途）。
 * 明确不许：QFRLEA.exe（服务本体，SCM 管理，绝不裸拉）、qf-lea-client.exe
 * （管道搬运，裸拉无意义）；QFRemote.exe／QFSysHelper.exe／qf-lockctl.exe
 * 不在 LEA 安装目录内，不入此表（仍被安装目录门挡住）。
 * 判定四重门：① 路径规范化后位于安装目录内；② 是 .exe；③ basename 在
 * 名单内；④ SHA-256 与 whitelist.h 一致。 */
static const struct { const char *name; const char *sha256; } APP_OPEN_ALLOW[] = {
    { "QFUserHelper.exe", W_USH_EXE_SHA256 },
};
static int app_open_allowed(const char *path, char *norm_out, size_t norm_size,
                            char *detail, size_t detail_size) {
    if (!lea_normalize_path(path, norm_out, norm_size)) {
        snprintf(detail, detail_size, "%s", "path-normalize-failed");
        return 0;
    }
    char norm_install[MAX_PATH] = { 0 };
    lea_normalize_path(g_install_dir, norm_install, sizeof(norm_install));
    if (!lea_path_under_root(norm_out, norm_install)) {
        snprintf(detail, detail_size, "%s", "outside-install-dir");
        return 0;
    }
    const char *base = strrchr(norm_out, '\\');
    base = base ? base + 1 : norm_out;
    size_t bl = strlen(base);
    if (bl < 5 || _stricmp(base + bl - 4, ".exe") != 0) {
        snprintf(detail, detail_size, "%s", "not-exe");
        return 0;
    }
    const char *want_hash = NULL;
    for (size_t i = 0; i < sizeof(APP_OPEN_ALLOW) / sizeof(APP_OPEN_ALLOW[0]); i++) {
        if (_stricmp(base, APP_OPEN_ALLOW[i].name) == 0) { want_hash = APP_OPEN_ALLOW[i].sha256; break; }
    }
    if (!want_hash) {
        snprintf(detail, detail_size, "not-in-app-whitelist:%.64s", base);
        return 0;
    }
    char hex[65] = { 0 };
    if (!lea_sha256_file_hex(norm_out, hex)) {
        snprintf(detail, detail_size, "%s", "app-not-found");
        return 0;
    }
    if (!hash_hex_equal(hex, want_hash)) {
        snprintf(detail, detail_size, "%s", "hash-mismatch");
        return 0;
    }
    return 1;
}

/* ---------- USH 转发 ---------- */
static int ush_forward(const char *envelope_line, long timeout_ms,
                       char *resp, size_t resp_size, char *detail, size_t detail_size) {
    HANDLE pipe = INVALID_HANDLE_VALUE;
    if (!WaitNamedPipeW(USH_PIPE_NAME_W, USH_CONNECT_TIMEOUT_MS)) {
        snprintf(detail, detail_size, "%s", "ush-pipe-connect-timeout-or-missing");
        return 0;
    }
    pipe = CreateFileW(USH_PIPE_NAME_W, GENERIC_READ | GENERIC_WRITE, 0, NULL,
                       OPEN_EXISTING, FILE_FLAG_OVERLAPPED, NULL);
    if (pipe == INVALID_HANDLE_VALUE) {
        snprintf(detail, detail_size, "ush-pipe-open-failed:%lu",
                 (unsigned long)GetLastError());
        return 0;
    }
    DWORD mode = PIPE_READMODE_BYTE;
    SetNamedPipeHandleState(pipe, &mode, NULL, NULL);
    DWORD written = 0;
    char sendbuf[LEA_MAX_ENVELOPE + 2];
    size_t slen = strlen(envelope_line);
    if (slen + 1 > sizeof(sendbuf)) {
        CloseHandle(pipe);
        snprintf(detail, detail_size, "%s", "envelope-oversize");
        return 0;
    }
    memcpy(sendbuf, envelope_line, slen);
    sendbuf[slen] = '\n';
    sendbuf[slen + 1] = '\0';
    if (!WriteFile(pipe, sendbuf, (DWORD)(slen + 1), &written, NULL) ||
        written != slen + 1) {
        CloseHandle(pipe);
        snprintf(detail, detail_size, "%s", "ush-write-failed");
        return 0;
    }
    /* 带超时的读：用 OVERLAPPED + WaitForSingleObject 做 deadline。 */
    OVERLAPPED ov;
    memset(&ov, 0, sizeof(ov));
    ov.hEvent = CreateEventW(NULL, TRUE, FALSE, NULL);
    if (!ov.hEvent) {
        CloseHandle(pipe);
        snprintf(detail, detail_size, "%s", "event-failed");
        return 0;
    }
    size_t total = 0;
    DWORD deadline = (DWORD)(timeout_ms > 0 ? timeout_ms : 5000);
    int ok = 0;
    char chunk[4096];
    while (total + 1 < resp_size) {
        DWORD got = 0;
        BOOL r = ReadFile(pipe, chunk, sizeof(chunk), &got, &ov);
        if (!r && GetLastError() == ERROR_IO_PENDING) {
            DWORD wr = WaitForSingleObject(ov.hEvent, deadline);
            if (wr != WAIT_OBJECT_0) {
                CancelIo(pipe);
                break;
            }
            if (!GetOverlappedResult(pipe, &ov, &got, FALSE)) break;
        } else if (!r) {
            break;
        }
        if (got == 0) break;
        size_t take = got;
        if (total + take >= resp_size) take = resp_size - total - 1;
        memcpy(resp + total, chunk, take);
        total += take;
        resp[total] = '\0';
        if (memchr(chunk, '\n', got)) { ok = 1; break; }
        if (got < sizeof(chunk)) { ok = 1; break; }
    }
    CloseHandle(ov.hEvent);
    CloseHandle(pipe);
    if (!ok || total == 0) {
        snprintf(detail, detail_size, "%s", "ush-read-timeout-or-empty");
        return 0;
    }
    char *nl = strchr(resp, '\n');
    if (nl) *nl = '\0';
    return 1;
}

static int ush_probe(void) {
    HANDLE pipe = INVALID_HANDLE_VALUE;
    if (!WaitNamedPipeW(USH_PIPE_NAME_W, 500)) return 0;
    pipe = CreateFileW(USH_PIPE_NAME_W, GENERIC_READ | GENERIC_WRITE, 0, NULL,
                       OPEN_EXISTING, 0, NULL);
    if (pipe == INVALID_HANDLE_VALUE) return 0;
    CloseHandle(pipe);
    return 1;
}

/* ---------- 队列项上下文（引用计数：管道线程与 worker 各持 1 份引用；
 * 谁最后释放谁关闭事件并 free；超时路径下管道线程先返回，worker 完成
 * 后释放，不存在 use-after-free） ---------- */
typedef struct {
    HANDLE done; /* 完成事件 */
    char result_json[LEA_MAX_RESPONSE];
    volatile LONG refs;
} lea_item_ctx_t;

static void lea_ctx_release(lea_item_ctx_t *ctx) {
    if (!ctx) return;
    if (InterlockedDecrement(&ctx->refs) == 0) {
        CloseHandle(ctx->done);
        free(ctx);
    }
}

/* ---------- 执行分发（worker 线程） ---------- */
/* 返回 1=已完成并填好 result_json；result_json 为完整一行响应 JSON。 */
static void execute_item(lea_queue_item_t *item) {
    lea_envelope_t *env = &item->env;
    lea_item_ctx_t *ctx = (lea_item_ctx_t *)item->ctx;
    long long t0 = now_unix();
    const lea_command_spec_t *spec = lea_command_spec(env->command);
    long timeout_ms = lea_effective_timeout_ms(env);
    char resp[LEA_MAX_RESPONSE] = { 0 };
    char detail[512] = { 0 };
    char ush_code_buf[64] = { 0 }; /* 承接 USH 透传的 code（worker 单线程，无竞争） */
    const char *code = LEA_OK;
    int ok = 1;
    char *result_json = NULL;
    /* result_buf 与 resp 同为 64KB：脚本输出上限 8192 字节（转义后最坏
     * 6 倍 ≈ 49KB）与 file.read 内联（文件上限 32KB → base64 约 43KB）
     * 均可放进一行响应；超限的输出在各分支内截断／拒绝。 */
    char result_buf[LEA_MAX_RESPONSE] = { 0 };

    if (strcmp(env->command, "script.run") == 0) {
        char script[512] = { 0 };
        char args[16][512];
        int nargs = 0;
        if (!lea_json_string(env->params_raw, "script", script, sizeof(script))) {
            ok = 0; code = LEA_ERR_BAD_ENVELOPE;
            snprintf(detail, sizeof(detail), "%s", "params.script-missing");
        } else {
            int na = lea_params_string_array(env->params_raw, "args", args, 16);
            nargs = na < 0 ? 0 : na;
            if (na < 0 && strstr(env->params_raw, "\"args\"")) {
                ok = 0; code = LEA_ERR_BAD_ENVELOPE;
                snprintf(detail, sizeof(detail), "%s", "params.args-invalid");
            } else {
                /* 相对路径视为安装目录下的脚本名。 */
                char resolved[1024];
                if (script[0] && script[1] != ':' && script[0] != '\\' && script[0] != '/')
                    snprintf(resolved, sizeof(resolved), "%s\\%s", g_install_dir, script);
                else
                    snprintf(resolved, sizeof(resolved), "%s", script);
                char norm[MAX_PATH] = { 0 };
                char sdetail[256] = { 0 };
                if (!script_is_allowed(resolved, norm, sizeof(norm), sdetail, sizeof(sdetail))) {
                    ok = 0; code = LEA_ERR_SCRIPT_NOT_ALLOWED;
                    snprintf(detail, sizeof(detail), "%s", sdetail);
                } else {
                    /* 参数字符集：禁控制字符与换行（防注入）；其余逐个引用传递。 */
                    int bad_arg = 0;
                    for (int i = 0; i < nargs && !bad_arg; i++)
                        for (char *p = args[i]; *p; p++)
                            if ((unsigned char)*p < 0x20) bad_arg = 1;
                    if (bad_arg) {
                        ok = 0; code = LEA_ERR_BAD_ENVELOPE;
                        snprintf(detail, sizeof(detail), "%s", "arg-control-char");
                    } else {
                        DWORD exit_code = 0;
                        /* 脚本输出回传上限 8192 字节（转义后仍可放进一行响应）。 */
                        char output[8192] = { 0 };
                        int r = run_powershell_script(norm, args, nargs, timeout_ms,
                                                      &exit_code, output, sizeof(output));
                        if (r == -1) {
                            ok = 0; code = LEA_ERR_TIMEOUT;
                            snprintf(detail, sizeof(detail), "script-timeout-ms:%ld", timeout_ms);
                        } else if (r == 0) {
                            ok = 0; code = LEA_ERR_EXEC_FAILED;
                            snprintf(detail, sizeof(detail), "%s", "powershell-start-failed");
                        } else {
                            size_t off = 0;
                            off += (size_t)snprintf(result_buf + off, sizeof(result_buf) - off,
                                                    "{\"exit_code\":%lu,\"output\":\"",
                                                    (unsigned long)exit_code);
                            lea_json_escape_into(result_buf, sizeof(result_buf), &off, output);
                            snprintf(result_buf + off, sizeof(result_buf) - off, "\"}");
                            result_json = result_buf;
                            if (exit_code != 0) {
                                ok = 0; code = LEA_ERR_EXEC_FAILED;
                                snprintf(detail, sizeof(detail), "script-exit:%lu",
                                         (unsigned long)exit_code);
                            }
                        }
                    }
                }
            }
        }
    } else if (strcmp(env->command, "file.read") == 0) {
        char path[512] = { 0 };
        if (!lea_json_string(env->params_raw, "path", path, sizeof(path))) {
            ok = 0; code = LEA_ERR_BAD_ENVELOPE;
            snprintf(detail, sizeof(detail), "%s", "params.path-missing");
        } else {
            char norm[MAX_PATH] = { 0 };
            char fdetail[256] = { 0 };
            if (!file_in_work_root(path, norm, sizeof(norm), fdetail, sizeof(fdetail))) {
                ok = 0; code = LEA_ERR_PATH_NOT_ALLOWED;
                snprintf(detail, sizeof(detail), "%s", fdetail);
            } else {
                FILE *f = fopen(norm, "rb");
                if (!f) {
                    ok = 0; code = LEA_ERR_EXEC_FAILED;
                    snprintf(detail, sizeof(detail), "%s", "file-not-found");
                } else {
                    fseek(f, 0, SEEK_END);
                    long sz = ftell(f);
                    fseek(f, 0, SEEK_SET);
                    if (sz < 0 || sz > 32768) {
                        fclose(f);
                        ok = 0; code = LEA_ERR_EXEC_FAILED;
                        snprintf(detail, sizeof(detail), "%s",
                                 "file-too-large-for-inline-read");
                    } else {
                        unsigned char *data = (unsigned char *)malloc((size_t)sz + 1);
                        size_t r = data ? fread(data, 1, (size_t)sz, f) : 0;
                        fclose(f);
                        if (!data) {
                            ok = 0; code = LEA_ERR_INTERNAL;
                        } else {
                            char *b64 = (char *)malloc(((size_t)sz + 2) / 3 * 4 + 2);
                            if (b64 && lea_b64_encode(data, r, b64, ((size_t)sz + 2) / 3 * 4 + 2) >= 0) {
                                snprintf(result_buf, sizeof(result_buf),
                                         "{\"size\":%ld,\"content_b64\":\"%s\"}", sz, b64);
                                result_json = result_buf;
                            } else {
                                ok = 0; code = LEA_ERR_INTERNAL;
                            }
                            free(b64);
                        }
                        free(data);
                    }
                }
            }
        }
    } else if (strcmp(env->command, "file.write") == 0) {
        char path[512] = { 0 };
        char content_b64[LEA_MAX_ENVELOPE] = { 0 };
        if (!lea_json_string(env->params_raw, "path", path, sizeof(path)) ||
            !lea_json_string(env->params_raw, "content_b64", content_b64, sizeof(content_b64))) {
            ok = 0; code = LEA_ERR_BAD_ENVELOPE;
            snprintf(detail, sizeof(detail), "%s", "params.path/content_b64-missing");
        } else {
            char norm[MAX_PATH] = { 0 };
            char fdetail[256] = { 0 };
            if (!file_in_work_root(path, norm, sizeof(norm), fdetail, sizeof(fdetail))) {
                ok = 0; code = LEA_ERR_PATH_NOT_ALLOWED;
                snprintf(detail, sizeof(detail), "%s", fdetail);
            } else {
                size_t cap = strlen(content_b64) * 3 / 4 + 4;
                unsigned char *data = (unsigned char *)malloc(cap);
                long n = data ? lea_b64_decode(content_b64, data, cap) : -1;
                if (n < 0 || n > LEA_MAX_FILE_SIZE) {
                    free(data);
                    ok = 0; code = LEA_ERR_BAD_ENVELOPE;
                    snprintf(detail, sizeof(detail), "%s", "content_b64-invalid-or-oversize");
                } else {
                    FILE *f = fopen(norm, "wb");
                    if (!f) {
                        free(data);
                        ok = 0; code = LEA_ERR_EXEC_FAILED;
                        snprintf(detail, sizeof(detail), "%s", "file-open-failed");
                    } else {
                        fwrite(data, 1, (size_t)n, f);
                        fclose(f);
                        free(data);
                        snprintf(result_buf, sizeof(result_buf), "{\"size\":%ld}", n);
                        result_json = result_buf;
                    }
                }
            }
        }
    } else if (strcmp(env->command, "app.open") == 0) {
        char path[512] = { 0 };
        char args[8][512];
        int nargs = 0;
        if (!lea_json_string(env->params_raw, "path", path, sizeof(path))) {
            ok = 0; code = LEA_ERR_BAD_ENVELOPE;
            snprintf(detail, sizeof(detail), "%s", "params.path-missing");
        } else {
            int na = lea_params_string_array(env->params_raw, "args", args, 8);
            nargs = na < 0 ? 0 : na;
            char norm[MAX_PATH] = { 0 };
            char adetail[256] = { 0 };
            if (!app_open_allowed(path, norm, sizeof(norm), adetail, sizeof(adetail))) {
                ok = 0; code = LEA_ERR_PATH_NOT_ALLOWED;
                snprintf(detail, sizeof(detail), "%s", adetail);
            } else {
                WCHAR wpath[MAX_PATH];
                utf8_to_utf16(norm, wpath, MAX_PATH);
                WCHAR cmdline[4096];
                _snwprintf(cmdline, 4096, L"\"%s\"", wpath);
                for (int i = 0; i < nargs; i++) {
                    char q[1100];
                    quote_arg(args[i], q, sizeof(q));
                    WCHAR wq[1100];
                    utf8_to_utf16(q, wq, 1100);
                    wcscat_s(cmdline, 4096, L" ");
                    wcscat_s(cmdline, 4096, wq);
                }
                STARTUPINFOW si;
                PROCESS_INFORMATION pi;
                ZeroMemory(&si, sizeof(si));
                si.cb = sizeof(si);
                si.dwFlags = STARTF_USESHOWWINDOW;
                si.wShowWindow = SW_SHOWNORMAL;
                ZeroMemory(&pi, sizeof(pi));
                if (!CreateProcessW(NULL, cmdline, NULL, NULL, FALSE, 0, NULL, NULL, &si, &pi)) {
                    ok = 0; code = LEA_ERR_EXEC_FAILED;
                    snprintf(detail, sizeof(detail), "create-process-failed:%lu",
                             (unsigned long)GetLastError());
                } else {
                    snprintf(result_buf, sizeof(result_buf),
                             "{\"process_id\":%lu}", (unsigned long)pi.dwProcessId);
                    result_json = result_buf;
                    CloseHandle(pi.hProcess);
                    CloseHandle(pi.hThread);
                }
            }
        }
    } else if (strcmp(env->command, "app.close") == 0) {
        char name[128] = { 0 };
        if (!lea_json_string(env->params_raw, "process_name", name, sizeof(name))) {
            ok = 0; code = LEA_ERR_BAD_ENVELOPE;
            snprintf(detail, sizeof(detail), "%s", "params.process_name-missing");
        } else if (_stricmp(name, "QFRemote.exe") != 0) {
            /* MVP：只允许关闭 QFR 主程序本身（待站长确认清单）。 */
            ok = 0; code = LEA_ERR_PATH_NOT_ALLOWED;
            snprintf(detail, sizeof(detail), "process-not-in-close-whitelist:%.64s", name);
        } else {
            /* 按进程名枚举并终止（SYSTEM 身份）。此处用 Toolhelp 快照。 */
            HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            int killed = 0;
            if (snap != INVALID_HANDLE_VALUE) {
                PROCESSENTRY32W pe;
                pe.dwSize = sizeof(pe);
                if (Process32FirstW(snap, &pe)) {
                    do {
                        if (_wcsicmp(pe.szExeFile, L"QFRemote.exe") == 0) {
                            HANDLE h = OpenProcess(PROCESS_TERMINATE, FALSE, pe.th32ProcessID);
                            if (h) {
                                if (TerminateProcess(h, 0)) killed++;
                                CloseHandle(h);
                            }
                        }
                    } while (Process32NextW(snap, &pe));
                }
                CloseHandle(snap);
            }
            snprintf(result_buf, sizeof(result_buf), "{\"killed\":%d}", killed);
            result_json = result_buf;
        }
    } else if (spec && spec->executor == LEA_EXEC_USH) {
        /* UI 类：worker 用 item->env 重建信封行转发给 USH（USH 由另一线实现；
         * USH 只信任 LEA，不再验签）。 */
        char ush_resp[LEA_MAX_RESPONSE] = { 0 };
        char udetail[256] = { 0 };
        char env_line[LEA_MAX_ENVELOPE] = { 0 };
        if (!lea_rebuild_envelope(env, env_line, sizeof(env_line))) {
            ok = 0; code = LEA_ERR_INTERNAL;
            snprintf(detail, sizeof(detail), "%s", "rebuild-envelope-failed");
        } else if (!ush_forward(env_line, timeout_ms, ush_resp, sizeof(ush_resp),
                                udetail, sizeof(udetail))) {
            ok = 0; code = LEA_ERR_USH_UNAVAILABLE;
            snprintf(detail, sizeof(detail), "%s", udetail);
        } else {
            /* USH 响应形如 {"ok":...,"code":"..."}：透传其 ok/code。 */
            char ush_code[64] = { 0 };
            int uok = 0;
            if (lea_json_bool(ush_resp, "ok", &uok))
                ok = uok;
            if (lea_json_string(ush_resp, "code", ush_code, sizeof(ush_code)) &&
                ush_code[0]) {
                /* 把 USH 的 code 作为最终 code（ok 已透传）。 */
                snprintf(ush_code_buf, sizeof(ush_code_buf), "%s", ush_code);
                code = ush_code_buf;
                if (!uok) snprintf(detail, sizeof(detail), "ush-%s", ush_code);
            } else if (!uok) {
                code = LEA_ERR_EXEC_FAILED;
                snprintf(detail, sizeof(detail), "%s", "ush-failed-no-code");
            }
            size_t off = 0;
            off += (size_t)snprintf(result_buf + off, sizeof(result_buf) - off,
                                    "{\"ush_response\":\"");
            lea_json_escape_into(result_buf, sizeof(result_buf), &off, ush_resp);
            snprintf(result_buf + off, sizeof(result_buf) - off, "\"}");
            result_json = result_buf;
        }
    } else {
        ok = 0; code = LEA_ERR_BAD_ENVELOPE;
        snprintf(detail, sizeof(detail), "%s", "unknown-command");
    }

    long duration_ms = (long)((now_unix() - t0) * 1000);
    (void)duration_ms;
    lea_build_response(resp, sizeof(resp), ok, code, env->request_id,
                       lea_error_retryable(code), detail[0] ? detail : "",
                       result_json);
    /* 幂等终态＋审计 */
    EnterCriticalSection(&g_lock);
    if (item->idem) {
        lea_idem_set_status(&g_idem, item->idem,
                            ok ? LEA_IDEM_SUCCEEDED : LEA_IDEM_FAILED,
                            resp, now_unix());
        idem_persist_locked();
    }
    LeaveCriticalSection(&g_lock);
    audit_for_envelope(env, "execute", ok ? "ok" : "failed", ok ? "" : code,
                       0, detail);
    snprintf(ctx->result_json, sizeof(ctx->result_json), "%s", resp);
    SetEvent(ctx->done);
    lea_ctx_release(ctx); /* worker 侧引用；管道线程侧引用另行释放 */
}

/* ---------- worker 线程 ---------- */
static DWORD WINAPI worker_loop(LPVOID unused) {
    (void)unused;
    while (InterlockedCompareExchange(&g_running, 1, 1) == 1) {
        DWORD w = WaitForSingleObject(g_queue_event, 1000);
        if (w == WAIT_TIMEOUT) {
            /* 周期任务：每小时清理一次幂等表（队列空且无在途时才做）。 */
            long long hour = now_unix() / 3600;
            if (hour != g_last_prune_hour) {
                g_last_prune_hour = hour;
                EnterCriticalSection(&g_lock);
                if (lea_queue_total(&g_queue) == 0 && g_inflight == 0) {
                    lea_idem_prune(&g_idem, now_unix());
                    idem_persist_locked();
                }
                LeaveCriticalSection(&g_lock);
                EnterCriticalSection(&g_audit_lock);
                char date_ymd[16] = { 0 };
                local_date_iso(date_ymd, sizeof(date_ymd), NULL, 0);
                char dir_slash[MAX_PATH];
                snprintf(dir_slash, sizeof(dir_slash), "%s", g_logs_dir);
                for (char *p = dir_slash; *p; p++) if (*p == '\\') *p = '/';
                lea_audit_prune(dir_slash, LEA_AUDIT_RETAIN_DAYS, date_ymd);
                LeaveCriticalSection(&g_audit_lock);
            }
            continue;
        }
        for (;;) {
            EnterCriticalSection(&g_lock);
            lea_queue_item_t *item = lea_queue_dequeue(&g_queue);
            LeaveCriticalSection(&g_lock);
            if (!item) break;
            execute_item(item);
            EnterCriticalSection(&g_lock);
            g_inflight--;
            LeaveCriticalSection(&g_lock);
            /* ctx 由管道线程在取到结果后释放；此处只释放队列节点。 */
            lea_queue_item_free(item);
        }
    }
    return 0;
}

/* ---------- sys.info（内联） ---------- */
static void handle_sys_info(const lea_envelope_t *env, char *resp, size_t resp_size) {
    char result[1024];
    EnterCriticalSection(&g_lock);
    int qd = lea_queue_total(&g_queue);
    const char *bstate = lea_bind_state_name(g_binding.state);
    long long epoch = g_binding.epoch;
    char account[128];
    snprintf(account, sizeof(account), "%s", g_binding.account_id);
    LeaveCriticalSection(&g_lock);
    int ush = ush_probe();
    long uptime = (long)(now_unix() - g_started_at);
    snprintf(result, sizeof(result),
             "{\"version\":\"%s\",\"protocol_version\":%d,\"binding_state\":\"%s\","
             "\"account_id\":\"%s\",\"binding_epoch\":%lld,\"queue_depth\":%d,"
             "\"queue_max\":%d,\"ush_available\":%s,\"uptime_s\":%ld}",
             LEA_VERSION_STR, LEA_PROTOCOL_VERSION, bstate, account, epoch,
             qd, LEA_QUEUE_MAX, ush ? "true" : "false", uptime);
    lea_build_response(resp, resp_size, 1, LEA_OK, env->request_id, 0, "", result);
}

/* ---------- 内部命令（登录事件／绑定票据／登出） ---------- */
static void handle_internal(const char *text, char *resp, size_t resp_size) {
    char cmd[64] = { 0 };
    if (!lea_json_string(text, "cmd", cmd, sizeof(cmd))) {
        lea_build_response(resp, resp_size, 0, LEA_ERR_BAD_ENVELOPE, "", 0, "cmd-missing", NULL);
        return;
    }
    if (strcmp(cmd, "session.login_changed") == 0) {
        char account[128] = { 0 }, device[128] = { 0 };
        if (!lea_json_string(text, "account_id", account, sizeof(account)) || !account[0]) {
            lea_build_response(resp, resp_size, 0, LEA_ERR_BAD_ENVELOPE, "", 0, "account_id-missing", NULL);
            return;
        }
        lea_json_string(text, "device_id", device, sizeof(device));
        EnterCriticalSection(&g_lock);
        long long epoch = lea_binding_on_login(&g_binding, account,
                                               device[0] ? device : g_binding.device_id,
                                               now_unix());
        binding_persist_locked();
        LeaveCriticalSection(&g_lock);
        lea_audit_event_t ev;
        memset(&ev, 0, sizeof(ev));
        ev.event = "binding";
        ev.trace_id = "";
        ev.request_id = "";
        ev.account_id = account;
        ev.device_id = device;
        ev.binding_epoch = epoch;
        ev.command = "session.login_changed";
        ev.result = "pending";
        ev.detail = "login-changed: old binding revoked, awaiting ticket";
        audit_event(&ev);
        svc_log("binding login_changed account=%s epoch=%lld -> PENDING", account, epoch);
        char result[256];
        snprintf(result, sizeof(result),
                 "{\"binding_state\":\"PENDING\",\"binding_epoch\":%lld}", epoch);
        lea_build_response(resp, resp_size, 1, LEA_OK, "", 0, "", result);
        return;
    }
    if (strcmp(cmd, "session.logout") == 0) {
        EnterCriticalSection(&g_lock);
        lea_binding_revoke(&g_binding, now_unix());
        binding_persist_locked();
        LeaveCriticalSection(&g_lock);
        lea_audit_event_t ev;
        memset(&ev, 0, sizeof(ev));
        ev.event = "binding";
        ev.command = "session.logout";
        ev.result = "unbound";
        ev.detail = "logout: binding revoked, no rollback";
        audit_event(&ev);
        svc_log("binding logout -> UNBOUND");
        lea_build_response(resp, resp_size, 1, LEA_OK, "", 0, "", NULL);
        return;
    }
    if (strcmp(cmd, "binding.confirm") == 0) {
        /* 票据严格解析（lea_parse_ticket，可单测）：全部字段按类型校验——
         * 缺失／类型错误一律拒绝；scopes 非字符串不得当空串处理；
         * grant_muse_execute 取解析原值直接入串（非 0/1 由
         * lea_ticket_canonical() 拒绝），调用点不得 truthy 归一化。 */
        lea_ticket_t tk;
        if (!lea_parse_ticket(text, &tk)) {
            lea_build_response(resp, resp_size, 0, LEA_ERR_BAD_ENVELOPE, "", 0, "ticket-fields-invalid", NULL);
            svc_log("binding confirm rejected: ticket-fields-invalid");
            return;
        }
        /* 票据验签（占位 fail-closed；测试构建可用 TEST-UNSIGNED）。
         * 规范串 v1（CANONICAL-SIGNING-V1.md §3）：9 行，覆盖全部授权字段
         * （grant_muse_execute／scopes／lease_id）。 */
        char canonical[1024];
        if (!lea_ticket_canonical(tk.account_id, tk.device_id, tk.binding_epoch, tk.grant_epoch,
                                  tk.grant_muse_execute, tk.scopes, tk.lease_id, tk.expires_at,
                                  canonical, sizeof(canonical))) {
            lea_build_response(resp, resp_size, 0, LEA_ERR_BAD_ENVELOPE, "", 0, "canonical-build-failed", NULL);
            svc_log("binding confirm rejected: canonical-build-failed");
            return;
        }
        char reason[128] = { 0 };
        if (!lea_verify_ticket_signature(tk.signature, canonical, reason, sizeof(reason))) {
            const char *code = strcmp(reason, "ed25519-pubkey-not-configured") == 0
                ? LEA_ERR_SIG_NOT_CONFIGURED : LEA_ERR_BAD_SIGNATURE;
            lea_build_response(resp, resp_size, 0, code, "", 0, reason, NULL);
            svc_log("binding confirm rejected: %s", reason);
            return;
        }
        EnterCriticalSection(&g_lock);
        int okc = lea_binding_confirm(&g_binding, tk.binding_epoch, tk.grant_epoch, tk.grant_muse_execute,
                                      tk.scopes, tk.lease_id, tk.expires_at, now_unix());
        if (okc) binding_persist_locked();
        long long cur_epoch = g_binding.epoch;
        LeaveCriticalSection(&g_lock);
        if (!okc) {
            lea_build_response(resp, resp_size, 0, LEA_ERR_BINDING_CHANGED, "", 0,
                               "epoch-mismatch-or-not-pending", NULL);
            return;
        }
        lea_audit_event_t ev;
        memset(&ev, 0, sizeof(ev));
        ev.event = "binding";
        ev.account_id = tk.account_id;
        ev.device_id = tk.device_id;
        ev.binding_epoch = cur_epoch;
        ev.command = "binding.confirm";
        ev.result = "active";
        ev.detail = "ticket verified, binding ACTIVE";
        audit_event(&ev);
        svc_log("binding confirm account=%s epoch=%lld -> ACTIVE", tk.account_id, cur_epoch);
        char result[256];
        snprintf(result, sizeof(result),
                 "{\"binding_state\":\"ACTIVE\",\"binding_epoch\":%lld}", cur_epoch);
        lea_build_response(resp, resp_size, 1, LEA_OK, "", 0, "", result);
        return;
    }
    lea_build_response(resp, resp_size, 0, LEA_ERR_BAD_ENVELOPE, "", 0, "unknown-internal-cmd", NULL);
}

/* ---------- 信封处理（管道线程） ---------- */
static void handle_envelope(const char *text, char *resp, size_t resp_size) {
    lea_envelope_t env;
    long long t0 = now_unix();
    if (!lea_parse_envelope(text, t0, &env)) {
        /* 解析失败时 request_id 可能未知；尽力提取后回包。 */
        char rid[64] = { 0 };
        lea_json_string(text, "request_id", rid, sizeof(rid));
        lea_build_response(resp, resp_size, 0, env.error, rid,
                           lea_error_retryable(env.error),
                           env.error_detail[0] ? env.error_detail : "", NULL);
        svc_log("REJECT parse error=%s detail=%s", env.error, env.error_detail);
        return;
    }
    /* 1. 签名验签（占位 fail-closed）。
     * 规范串 v1（CANONICAL-SIGNING-V1.md §2）：16 行，覆盖全部关键字段
     * （batch_id／seq／account_id／api_key_id／timeout_ms／params 哈希）。 */
    char canonical[4096];
    if (!lea_envelope_canonical(&env, canonical, sizeof(canonical))) {
        lea_build_response(resp, resp_size, 0, LEA_ERR_BAD_ENVELOPE, env.request_id, 0,
                           "canonical-build-failed", NULL);
        audit_for_envelope(&env, "admit-reject", "rejected", LEA_ERR_BAD_ENVELOPE, 0,
                           "canonical-build-failed");
        svc_log("REJECT canonical build failed request=%s", env.request_id);
        return;
    }
    char reason[128] = { 0 };
    if (!lea_verify_envelope_signature(env.signature, canonical, reason, sizeof(reason))) {
        const char *code = strcmp(reason, "ed25519-pubkey-not-configured") == 0
            ? LEA_ERR_SIG_NOT_CONFIGURED : LEA_ERR_BAD_SIGNATURE;
        lea_build_response(resp, resp_size, 0, code, env.request_id, 0, reason, NULL);
        audit_for_envelope(&env, "admit-reject", "rejected", code, 0, reason);
        svc_log("REJECT sig request=%s reason=%s", env.request_id, reason);
        return;
    }
    /* 2. sys.info 内联，不进队列／不占幂等。 */
    if (strcmp(env.command, "sys.info") == 0) {
        /* sys.info 同样要过准入（未绑定时返回 NOT_BOUND；Key 已吊销也拒绝）。 */
        EnterCriticalSection(&g_lock);
        char err[64] = { 0 };
        int admitted = lea_admit(&env, &g_binding, NULL, 0, err, sizeof(err));
        LeaveCriticalSection(&g_lock);
        if (admitted && key_is_revoked(env.api_key_id)) {
            admitted = 0;
            snprintf(err, sizeof(err), "%s", LEA_ERR_KEY_REVOKED);
        }
        if (!admitted) {
            lea_build_response(resp, resp_size, 0, err, env.request_id,
                               lea_error_retryable(err), "", NULL);
            audit_for_envelope(&env, "admit-reject", "rejected", err, 0, "");
            return;
        }
        handle_sys_info(&env, resp, resp_size);
        return;
    }
    /* 3. 重放表。 */
    EnterCriticalSection(&g_lock);
    int fresh = lea_replay_check_and_add(&g_replay, env.request_id, env.nonce, t0);
    LeaveCriticalSection(&g_lock);
    if (!fresh) {
        lea_build_response(resp, resp_size, 0, LEA_ERR_REPLAY, env.request_id, 0,
                           "nonce-or-request_id-reused", NULL);
        audit_for_envelope(&env, "admit-reject", "rejected", LEA_ERR_REPLAY, 0,
                           "replay");
        return;
    }
    /* 4. 准入（绑定／设备／epoch／授权／scope）；Key 吊销另查本地吊销文件。 */
    EnterCriticalSection(&g_lock);
    char err[64] = { 0 };
    int admitted = lea_admit(&env, &g_binding, NULL, 0, err, sizeof(err));
    LeaveCriticalSection(&g_lock);
    if (admitted && key_is_revoked(env.api_key_id)) {
        admitted = 0;
        snprintf(err, sizeof(err), "%s", LEA_ERR_KEY_REVOKED);
    }
    if (!admitted) {
        lea_build_response(resp, resp_size, 0, err, env.request_id,
                           lea_error_retryable(err), "", NULL);
        audit_for_envelope(&env, "admit-reject", "rejected", err, 0, "");
        svc_log("REJECT admit request=%s code=%s", env.request_id, err);
        return;
    }
    /* 5. 幂等：终态直接回缓存；执行中回 DUPLICATE。 */
    int dangerous = lea_command_is_dangerous(&env);
    EnterCriticalSection(&g_lock);
    lea_idem_entry_t *idem = lea_idem_get_or_create(&g_idem, env.device_id,
                                                    env.account_id, env.idempotency_key,
                                                    dangerous, t0);
    if (idem && (idem->status == LEA_IDEM_SUCCEEDED || idem->status == LEA_IDEM_FAILED) &&
        idem->result[0]) {
        /* 缓存命中：原样返回终态响应（补一个换行，管道协议要求一行以 \n 结束）。 */
        char cached[LEA_MAX_RESPONSE];
        snprintf(cached, sizeof(cached), "%s\n", idem->result);
        LeaveCriticalSection(&g_lock);
        snprintf(resp, resp_size, "%s", cached);
        audit_for_envelope(&env, "execute", "replayed-cached", "", 0, "idempotent-replay");
        return;
    }
    if (idem && idem->status == LEA_IDEM_RUNNING) {
        LeaveCriticalSection(&g_lock);
        lea_build_response(resp, resp_size, 0, LEA_ERR_DUPLICATE, env.request_id, 0,
                           "same idempotency_key already running", NULL);
        audit_for_envelope(&env, "execute", "rejected", LEA_ERR_DUPLICATE, 0, "");
        return;
    }
    if (idem && idem->status == LEA_IDEM_UNKNOWN) {
        LeaveCriticalSection(&g_lock);
        lea_build_response(resp, resp_size, 0, LEA_ERR_UNKNOWN, env.request_id, 0,
                           "previous attempt outcome unknown; confirm manually", NULL);
        return;
    }
    if (!idem) {
        LeaveCriticalSection(&g_lock);
        lea_build_response(resp, resp_size, 0, LEA_ERR_INTERNAL, env.request_id, 0,
                           "idempotency-table-full", NULL);
        return;
    }
    lea_idem_set_status(&g_idem, idem, LEA_IDEM_RUNNING, NULL, t0);
    idem_persist_locked();
    /* 6. 入队。 */
    lea_queue_item_t *item = (lea_queue_item_t *)calloc(1, sizeof(*item));
    lea_item_ctx_t *ctx = (lea_item_ctx_t *)calloc(1, sizeof(*ctx));
    if (!item || !ctx) {
        free(item);
        free(ctx);
        lea_idem_set_status(&g_idem, idem, LEA_IDEM_UNKNOWN, NULL, t0);
        idem_persist_locked();
        LeaveCriticalSection(&g_lock);
        lea_build_response(resp, resp_size, 0, LEA_ERR_INTERNAL, env.request_id, 0,
                           "alloc-failed", NULL);
        return;
    }
    ctx->done = CreateEventW(NULL, TRUE, FALSE, NULL);
    ctx->refs = 2; /* 管道线程 1 份＋worker 1 份 */
    item->env = env;
    item->dangerous = dangerous;
    item->idem = idem;
    item->ctx = ctx;
    char qerr[64] = { 0 };
    if (!lea_queue_enqueue(&g_queue, item, qerr, sizeof(qerr))) {
        free(item);
        CloseHandle(ctx->done);
        free(ctx);
        lea_idem_set_status(&g_idem, idem, LEA_IDEM_RECEIVED, NULL, t0);
        idem_persist_locked();
        LeaveCriticalSection(&g_lock);
        lea_build_response(resp, resp_size, 0, LEA_ERR_QUEUE_FULL, env.request_id, 0,
                           "queue-full", NULL);
        audit_for_envelope(&env, "queue", "rejected", LEA_ERR_QUEUE_FULL, 0, "");
        return;
    }
    g_inflight++;
    LeaveCriticalSection(&g_lock);
    SetEvent(g_queue_event);
    /* 7. 等执行完成（按 timeout_ms；超时则回 timeout，任务继续跑，幂等表留终态）。 */
    long timeout_ms = lea_effective_timeout_ms(&env);
    DWORD w = WaitForSingleObject(ctx->done, (DWORD)timeout_ms);
    if (w == WAIT_TIMEOUT) {
        char result[256];
        snprintf(result, sizeof(result), "{\"job_id\":\"%s\"}", env.request_id);
        lea_build_response(resp, resp_size, 0, LEA_ERR_TIMEOUT, env.request_id, 0,
                           "execution still running past timeout_ms", result);
        audit_for_envelope(&env, "execute", "timeout", LEA_ERR_TIMEOUT,
                           (long)timeout_ms, "wait-timeout");
        /* 管道线程释放自己的引用后返回；worker 完成时释放另一份引用，
         * 最后一个释放者关闭事件并 free ctx（无 use-after-free）。 */
        lea_ctx_release(ctx);
        return;
    }
    snprintf(resp, resp_size, "%s", ctx->result_json);
    lea_ctx_release(ctx);
}

/* ---------- 管道连接处理 ---------- */
static DWORD WINAPI pipe_client_thread(LPVOID param) {
    HANDLE pipe = (HANDLE)param;
    char buf[LEA_MAX_ENVELOPE + 1];
    size_t total = 0;
    /* 读一行（'\n' 结束），上限 LEA_MAX_ENVELOPE。 */
    while (total < LEA_MAX_ENVELOPE) {
        DWORD got = 0;
        BOOL ok = ReadFile(pipe, buf + total, (DWORD)(LEA_MAX_ENVELOPE - total), &got, NULL);
        if (!ok || got == 0) break;
        total += got;
        buf[total] = '\0';
        if (memchr(buf, '\n', total)) break;
    }
    if (total > 0) {
        buf[total] = '\0';
        char *nl = strchr(buf, '\n');
        if (nl) *nl = '\0';
        /* 去掉末尾 \r */
        size_t l = strlen(buf);
        if (l > 0 && buf[l - 1] == '\r') buf[l - 1] = '\0';
        char resp[LEA_MAX_RESPONSE] = { 0 };
        /* 内部命令（{"cmd":...}）与信封分流。 */
        char cmd[64] = { 0 };
        if (lea_json_string(buf, "cmd", cmd, sizeof(cmd)) && cmd[0]) {
            handle_internal(buf, resp, sizeof(resp));
        } else {
            handle_envelope(buf, resp, sizeof(resp));
        }
        DWORD written = 0;
        WriteFile(pipe, resp, (DWORD)strlen(resp), &written, NULL);
    }
    FlushFileBuffers(pipe);
    DisconnectNamedPipe(pipe);
    CloseHandle(pipe);
    return 0;
}

static DWORD WINAPI pipe_loop(LPVOID unused) {
    (void)unused;
    PSECURITY_DESCRIPTOR sd = NULL;
    if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(
            PIPE_SDDL_W, SDDL_REVISION_1, &sd, NULL)) {
        svc_log("FATAL pipe security descriptor failed");
        return 1;
    }
    SECURITY_ATTRIBUTES sa;
    sa.nLength = sizeof(sa);
    sa.lpSecurityDescriptor = sd;
    sa.bInheritHandle = FALSE;
    svc_log("START pipe listening \\\\.\\pipe\\QFR\\LEA\\v1");
    while (InterlockedCompareExchange(&g_running, 1, 1) == 1) {
        HANDLE pipe = CreateNamedPipeW(PIPE_NAME_W,
            PIPE_ACCESS_DUPLEX,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
            PIPE_MAX_INSTANCES, LEA_MAX_ENVELOPE, LEA_MAX_ENVELOPE, 0, &sa);
        if (pipe == INVALID_HANDLE_VALUE) {
            svc_log("ERROR CreateNamedPipe failed %lu", (unsigned long)GetLastError());
            Sleep(1000);
            continue;
        }
        /* 同步等连接（监听线程阻塞；连接后另起线程处理）。
         * 停止时 service_main 用一次本地客户端连接自唤醒（同 QFSysHelper）。 */
        BOOL connected = ConnectNamedPipe(pipe, NULL);
        if (!connected && GetLastError() != ERROR_PIPE_CONNECTED) {
            CloseHandle(pipe);
            continue;
        }
        if (InterlockedCompareExchange(&g_running, 1, 1) != 1) {
            /* 停止中：这次连接只是自唤醒，丢弃。 */
            DisconnectNamedPipe(pipe);
            CloseHandle(pipe);
            break;
        }
        HANDLE th = CreateThread(NULL, 0, pipe_client_thread, pipe, 0, NULL);
        if (th) CloseHandle(th);
        else {
            DisconnectNamedPipe(pipe);
            CloseHandle(pipe);
        }
    }
    LocalFree(sd);
    svc_log("STOP pipe loop");
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
        report_status(SERVICE_STOP_PENDING, 5000);
        InterlockedExchange(&g_running, 0);
        if (g_stop_event) SetEvent(g_stop_event);
        if (g_queue_event) SetEvent(g_queue_event);
    }
}

static int lea_service_init(void) {
    g_started_at = now_unix();
    InitializeCriticalSection(&g_lock);
    InitializeCriticalSection(&g_audit_lock);
    lea_binding_init(&g_binding);
    lea_replay_init(&g_replay);
    lea_idem_init(&g_idem);
    lea_queue_init(&g_queue);
    g_queue_event = CreateEventW(NULL, FALSE, FALSE, NULL);
    ensure_dirs();
    binding_load();
    idem_load();
    /* 启动恢复：崩溃残留的 RUNNING/RECEIVED 标 UNKNOWN（不自动重试）。 */
    EnterCriticalSection(&g_lock);
    int n = lea_idem_mark_crashed_unknown(&g_idem, now_unix());
    if (n > 0) {
        idem_persist_locked();
        svc_log("startup: %d crashed idem entries marked UNKNOWN", n);
    }
    lea_idem_prune(&g_idem, now_unix());
    idem_persist_locked();
    LeaveCriticalSection(&g_lock);
    svc_log("QFRLEA init done version=%s install_dir=%s", LEA_VERSION_STR, g_install_dir);
    return 1;
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
    lea_service_init();
    svc_log("SERVICE started");
    report_status(SERVICE_RUNNING, 0);
    HANDLE worker = CreateThread(NULL, 0, worker_loop, NULL, 0, NULL);
    HANDLE listener = CreateThread(NULL, 0, pipe_loop, NULL, 0, NULL);
    WaitForSingleObject(g_stop_event, INFINITE);
    InterlockedExchange(&g_running, 0);
    if (g_queue_event) SetEvent(g_queue_event);
    /* 自唤醒：连一次管道让阻塞的 ConnectNamedPipe 返回（同 QFSysHelper）。 */
    {
        HANDLE h = CreateFileW(PIPE_NAME_W, GENERIC_READ | GENERIC_WRITE,
            0, NULL, OPEN_EXISTING, 0, NULL);
        if (h != INVALID_HANDLE_VALUE) CloseHandle(h);
    }
    if (listener) WaitForSingleObject(listener, 5000);
    if (worker) WaitForSingleObject(worker, 5000);
    EnterCriticalSection(&g_lock);
    idem_persist_locked();
    LeaveCriticalSection(&g_lock);
    report_status(SERVICE_STOPPED, 0);
    svc_log("SERVICE stopped");
}

int main(int argc, char **argv) {
    if (argc > 1 && strcmp(argv[1], "debug") == 0) {
        g_stop_event = CreateEventW(NULL, TRUE, FALSE, NULL);
        lea_service_init();
        svc_log("DEBUG mode start");
        HANDLE worker = CreateThread(NULL, 0, worker_loop, NULL, 0, NULL);
        pipe_loop(NULL);
        if (worker) WaitForSingleObject(worker, 5000);
        return 0;
    }
    SERVICE_TABLE_ENTRYW table[] = {
        { (LPWSTR)SERVICE_NAME_W, service_main },
        { NULL, NULL }
    };
    if (!StartServiceCtrlDispatcherW(table)) {
        fprintf(stderr, "QFRLEA is a Windows service. Install with windows/lea/install-lea-service.ps1.\n");
        return 1;
    }
    return 0;
}
