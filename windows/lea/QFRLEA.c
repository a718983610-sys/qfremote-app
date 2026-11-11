/* QFRLEA —— QFRemote 本地执行代理服务（Stage 1 MVP，v0.1.0-mvp）
 * =================================================================
 * Windows 系统服务（服务名 QFRLEA，SYSTEM 身份），参照
 * windows/syshelper/QFSysHelper.c 的结构与安全模型：
 *   - 命名管道 \\.\pipe\QFR\LEA\v1，SDDL 为 SYSTEM＋Administrators＋
 *     Authenticated Users（H01：主程序以普通用户身份经已安装的
 *     qf-lea-client.exe 发内部命令，必须能连上管道；业务信封仍须
 *     服务端 Ed25519 签名，AU 连上管道也做不了业务命令；内部命令
 *     另有调用方进程鉴别——只认安装目录下的 qf-lea-client.exe）。
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
 *     引用转义，禁 shell 拼接；路径规范化＋最终路径验根防符号链接绕根
 *     （#21①）；hash 与执行同一批字节——验后复制执行副本（#21②）。
 *   - 文件读写：只限 work 目录，最终路径验根（#21①）；file.read 的
 *     size 用实际读到的字节数（#21④）。
 *   - app.open：只允许显式 exe 白名单（H16：名＋SHA-256 双重判定，初版仅
 *     QFUserHelper.exe；安装目录内其他 exe 一律拒绝）。
 *   - UI 类命令：经命名管道 \\.\pipe\QFR\LEA\UserHelper\v1 转发 USH
 *     （USH 由另一线实现；此处只做转发＋超时＋USH 不可用时明确报错）。
 *   - 日志：%ProgramData%\QFR\LEA\logs\lea-YYYY-MM-DD.jsonl，保留 30 天，
 *     ACL 仅 SYSTEM／Administrators；API Key 只记 key_id 与前缀片段。
 *   - 绑定：DPAPI LocalMachine 加密存 %ProgramData%\QFR\LEA\state\binding.dat，
 *     内含服务端票据签名原文；加载时重验票据签名（H02），签名缺失／
 *     不通过即丢弃绑定回 UNBOUND——DPAPI 本机可调不等于可伪造绑定。
 *   - 内部命令（session.login_changed／logout／binding.confirm）：只认
 *     已安装的 qf-lea-client.exe 进程（H01，调用方进程镜像全路径校验）
 *     ＋该进程的父进程须为主程序（QFRemote.exe／开发态 electron.exe，
 *     且在活动控制台会话内，H01 第二轮——只验镜像不够，任意用户都
 *     能直接运行合法客户端）。
 *   - LEA→USH 转发：除管道 ACL 外，另带 USH 每启动一次的随机 token
 *     （H03，USH 验 token＋验 LEA 进程镜像，不再只信管道 ACL）。
 *   - 换号：同账号重登不升 epoch（H07，两端 epoch 保持一致，已生成 Key
 *     继续可用）；换号 epoch+1，旧绑定立即作废。
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
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0600 /* GetNamedPipeClientProcessId（H01）须 ≥0x0600 */
#endif
#include <windows.h>
#include <sddl.h>
#include <aclapi.h>
#include <dpapi.h>
#include <wtsapi32.h>
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
#define PIPE_SDDL_W L"D:(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;AU)"
#define DIR_SDDL_W L"D:(A;;FA;;;SY)(A;;FA;;;BA)"
/* USH token 目录：SY/BA 完全控制，AU 仅 FILE_ADD_FILE（WD）——USH（用户
 * 身份）只能新建自己的 token 文件，读不到他人 token；token 文件继承此
 * ACL，WD 在文件上即 FILE_WRITE_DATA，故同机认证用户可覆写他人 token
 * 文件内容（但删不掉、也建不了同名占位——删文件须文件 DELETE 或目录
 * FILE_DELETE_CHILD，均未授）。残留：覆写只造成 USH 转发失败（DoS），
 * 不能伪造通过（USH 只认自己内存里的 token）。 */
#define USH_TOKENS_SDDL_W L"D:(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;WD;;;AU)"
#define PIPE_MAX_INSTANCES 8
#define USH_CONNECT_TIMEOUT_MS 2000
/* #14：LEA 管道读一行请求的总 deadline。旧实现读行无超时，一个连上不
 * 发数据的客户端即可占住 1 个实例（最多 8 个），阻塞后续请求。 */
#define LEA_PIPE_READ_TIMEOUT_MS 30000
/* #14：管道响应写超时（句柄为 OVERLAPPED，同步 WriteFile 传 NULL 违反
 * Win32 文档，见 #8）。 */
#define LEA_PIPE_WRITE_TIMEOUT_MS 10000

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
static lea_batch_seq_t g_batch_seq; /* H10：批量 batch_id/seq 单调表 */
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
static char g_ushtokens_dir[MAX_PATH]; /* %ProgramData%\QFR\LEA\ush-tokens（H03） */
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

/* 目录／文件 ACL：仅 SYSTEM＋Administrators 完全控制。
 * #24：返回 1=已设置、0=失败——转换失败不再静默 return，调用方必须
 * 处理（目录：记 ERROR 日志；刚写好的敏感文件：删文件＋记 ERROR，
 * 见 set_acl_or_remove_file，绝不留一个继承父目录宽松 ACL 的状态文件）。 */
static int set_sys_admin_acl(const char *path_utf8) {
    PSECURITY_DESCRIPTOR sd = NULL;
    if (!ConvertStringSecurityDescriptorToSecurityDescriptorA(
            "D:(A;;FA;;;SY)(A;;FA;;;BA)", SDDL_REVISION_1, &sd, NULL))
        return 0;
    /* 2026-11-11 启动即退出根因：ConvertStringSecurityDescriptor*
     * 返回的是自相对（self-relative）描述符，其 Dacl 字段是偏移量而
     * 非指针；直接取 ((SECURITY_DESCRIPTOR *)sd)->Dacl 会把 SID/ACL
     * 数据误读为指针（实测野指针 0x00000101001F0201），
     * SetNamedSecurityInfoW 解引用即访问违例，进程在 ensure_dirs 首个
     * ACL 处崩溃（START_PENDING 后退出、事件 7031、无日志）。
     * 必须用 GetSecurityDescriptorDacl 取 DACL。 */
    PACL dacl = NULL;
    BOOL present = FALSE, defaulted = FALSE;
    if (!GetSecurityDescriptorDacl(sd, &present, &dacl, &defaulted) || !present || !dacl) {
        LocalFree(sd);
        return 0;
    }
    WCHAR w[MAX_PATH];
    utf8_to_utf16(path_utf8, w, MAX_PATH);
    DWORD rc = SetNamedSecurityInfoW(w, SE_FILE_OBJECT,
                          DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                          NULL, NULL, dacl, NULL);
    LocalFree(sd);
    return rc == ERROR_SUCCESS;
}

/* #24：给刚写好的敏感文件设 ACL；失败时删文件并记 ERROR（fail-closed，
 * 不留宽松 ACL 的文件；调用方按“持久化失败”处理）。返回 1=文件在且 ACL 已设。 */
static int set_acl_or_remove_file(const char *path_utf8) {
    if (set_sys_admin_acl(path_utf8)) return 1;
    svc_log("ERROR acl failed for %s, removing file (fail-closed)", path_utf8);
    remove(path_utf8);
    return 0;
}

/* USH token 目录 ACL（H03）：见 USH_TOKENS_SDDL_W。失败静默（调用方不
 * 检查；失败时目录继承父目录 ACL，token 仍可用，只是隔离弱化——服务
 * 日志不记，避免启动噪音；该失败不影响业务命令）。 */
static void set_ushtokens_acl(const char *path_utf8) {
    PSECURITY_DESCRIPTOR sd = NULL;
    if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(
            USH_TOKENS_SDDL_W, SDDL_REVISION_1, &sd, NULL)) {
        /* H03 第二轮：ACL 配失败不再静默——目录权限不对时 token 文件
         * 对同机用户可写，LEA 转发仍 fail-closed，但要留日志可查。 */
        svc_log("ush-tokens acl: ConvertStringSecurityDescriptor failed %lu", GetLastError());
        return;
    }
    /* 同 set_sys_admin_acl：自相对描述符须用 GetSecurityDescriptorDacl
     * 取 DACL，直接取 ->Dacl 是野指针，会使 SetNamedSecurityInfoW 崩溃。 */
    PACL dacl = NULL;
    BOOL present = FALSE, defaulted = FALSE;
    if (!GetSecurityDescriptorDacl(sd, &present, &dacl, &defaulted) || !present || !dacl) {
        svc_log("ush-tokens acl: GetSecurityDescriptorDacl failed");
        LocalFree(sd);
        return;
    }
    WCHAR w[MAX_PATH];
    utf8_to_utf16(path_utf8, w, MAX_PATH);
    DWORD rc = SetNamedSecurityInfoW(w, SE_FILE_OBJECT,
                          DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                          NULL, NULL, dacl, NULL);
    if (rc != ERROR_SUCCESS)
        svc_log("ush-tokens acl: SetNamedSecurityInfo failed %lu", rc);
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
    /* #24：目录 ACL 失败必须留 ERROR 日志（目录不能像文件那样删了重来，
     * 服务仍须跑；但失败即意味着状态文件可能继承父目录宽松 ACL）。 */
    if (!set_sys_admin_acl(g_base_dir))
        svc_log("ERROR acl failed for base dir %s", g_base_dir);
    if (!set_sys_admin_acl(g_state_dir))
        svc_log("ERROR acl failed for state dir %s", g_state_dir);
    if (!set_sys_admin_acl(g_logs_dir))
        svc_log("ERROR acl failed for logs dir %s", g_logs_dir);
    if (!set_sys_admin_acl(g_work_dir))
        svc_log("ERROR acl failed for work dir %s", g_work_dir);
    snprintf(g_idem_path, sizeof(g_idem_path), "%s\\idempotency.jsonl", g_state_dir);
    snprintf(g_binding_path, sizeof(g_binding_path), "%s\\binding.dat", g_state_dir);
    snprintf(g_revoked_path, sizeof(g_revoked_path), "%s\\revoked_keys.txt", g_state_dir);
    snprintf(g_ushtokens_dir, sizeof(g_ushtokens_dir), "%s\\ush-tokens", g_base_dir);
    mkdir_one(g_ushtokens_dir);
    set_ushtokens_acl(g_ushtokens_dir);
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
    /* 调用方须持有 g_lock。#26：逐行流式写 tmp 文件，不再要求整表先装进
     * 一块 4MB 内存缓冲（旧实现超 4MB 即记 WARN、不落盘，重启后终态命令
     * 可重复执行）。写失败／ACL 失败即丢弃 tmp、保留旧快照。 */
    char tmp_path[MAX_PATH];
    snprintf(tmp_path, sizeof(tmp_path), "%s.tmp", g_idem_path);
    FILE *f = fopen(tmp_path, "w");
    if (!f) return;
    int skipped = 0;
    int ok = lea_idem_save_to_file(&g_idem, f, &skipped);
    if (ok && fflush(f) != 0) ok = 0;
    if (fclose(f) != 0) ok = 0;
    if (skipped > 0)
        svc_log("WARN idem save skipped %d invalid lines", skipped);
    if (!ok) {
        svc_log("WARN idem save failed, keeping previous snapshot");
        remove(tmp_path);
        return;
    }
    if (!set_sys_admin_acl(tmp_path)) {
        svc_log("ERROR idem acl failed, keeping previous snapshot");
        remove(tmp_path);
        return;
    }
    /* 原子替换：先删旧文件再改名（Windows MoveFile 不覆盖已存在目标时用此法）。 */
    remove(g_idem_path);
    if (rename(tmp_path, g_idem_path) != 0) {
        svc_log("WARN idem rename failed, keeping previous snapshot");
        remove(tmp_path);
    }
}

static void idem_load(void) {
    /* #26：逐行流式读，不再整文件读进 4MB 上限缓冲（旧实现超 4MB 即整表
     * 放弃加载）。坏行由 lea_idem_load_line 隔离跳过。 */
    FILE *f = fopen(g_idem_path, "r");
    if (!f) return;
    lea_idem_init(&g_idem);
    char line[LEA_IDEM_RESULT_MAX + 512];
    for (;;) {
        if (!fgets(line, sizeof(line), f)) break;
        size_t len = strlen(line);
        /* 行超缓冲（fgets 未读到换行且未到 EOF）：整行跳过，丢弃剩余部分。 */
        if (len > 0 && line[len - 1] != '\n' && !feof(f)) {
            int c;
            do { c = fgetc(f); } while (c != EOF && c != '\n');
            continue;
        }
        while (len > 0 && (line[len - 1] == '\n' || line[len - 1] == '\r'))
            line[--len] = '\0';
        if (len == 0) continue;
        lea_idem_load_line(&g_idem, line);
        if (g_idem.count >= LEA_IDEM_MAX) break;
    }
    fclose(f);
}

/* ---------- 绑定持久化（DPAPI LocalMachine） ---------- */
/* H02：binding.dat 内含服务端票据签名原文（ticket_signature）。DPAPI
 * LocalMachine 本机任意进程可调，只防“看不懂”，不防“伪造”；真正的
 * 防伪造是票据签名——加载时按规范串 v1 重建 canonical 并重验。 */
static void binding_persist_locked(void) {
    char text[2048]; /* 票据签名最长 511 字节，缓冲须留足 */
    snprintf(text, sizeof(text),
             "{\"account_id\":\"%s\",\"device_id\":\"%s\",\"epoch\":%lld,"
             "\"grant_epoch\":%lld,\"grant\":%d,\"scopes\":\"%s\","
             "\"expires_at\":%lld,\"lease_id\":\"%s\",\"state\":%d,"
             "\"ticket_signature\":\"%s\"}",
             g_binding.account_id, g_binding.device_id, g_binding.epoch,
             g_binding.grant_epoch, g_binding.grant_muse_execute,
             g_binding.scopes, g_binding.expires_at, g_binding.lease_id,
             (int)g_binding.state, g_binding.ticket_signature);
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
    /* #24：ACL 失败即删文件（fail-closed，不留宽松 ACL 的 binding.dat；
     * 下次启动即 UNBOUND，须重登重建绑定）。 */
    set_acl_or_remove_file(g_binding_path);
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
    /* H02：旧版 binding.dat 无 ticket_signature 字段时取不到即为空串，
     * 下方 ACTIVE 态重验必失败 → 丢弃绑定（fail-closed；旧文件本就
     * 可伪造，不可采信，用户重登后由新票据重建绑定）。 */
    lea_json_string(text, "ticket_signature", g_binding.ticket_signature,
                    sizeof(g_binding.ticket_signature));
    g_binding.epoch = epoch;
    g_binding.grant_epoch = grant_epoch;
    g_binding.grant_muse_execute = (int)grant;
    g_binding.expires_at = expires_at;
    g_binding.state = (state >= 0 && state <= 3) ? (lea_bind_state_t)state : LEA_BIND_UNBOUND;
    g_binding.updated_at = now_unix();
    LocalFree(out.pbData);
    if (g_binding.state == LEA_BIND_ACTIVE && !lea_binding_verify_ticket(&g_binding)) {
        svc_log("WARN binding ticket signature verify failed, dropping to UNBOUND");
        lea_binding_init(&g_binding);
        return;
    }
    svc_log("binding loaded state=%s account=%s epoch=%lld",
            lea_bind_state_name(g_binding.state), g_binding.account_id, g_binding.epoch);
}

/* ---------- 内部命令调用方鉴别（H01） ---------- */
/* 只认安装目录下的 qf-lea-client.exe（全路径大小写不敏感比对）。任意
 * 其他进程（含 MeshCentral agent、任意 SYSTEM/管理员进程）即使连上
 * 管道也发不了内部命令。防的是“随手发一行 JSON 就废掉绑定”的低成本
 * DoS；能覆写安装目录下客户端二进制的攻击者本来就已完全控制本机，
 * 不在本项防御内。 */
/* 父进程校验（H01 第二轮）：内部命令的合法发起方只有主程序
 * （QFRemote.exe，安装态；electron.exe，开发态）。客户端必须是主程序
 * 的直接子进程——主程序用 spawnSync 拉起客户端。只验客户端镜像不够：
 * 任意用户都能直接运行已安装的合法客户端发内部命令。
 * 边界：同会话用户自己跑一个同名 QFRemote.exe 做父进程可绕过——但
 * 同会话代码执行已等同会话沦陷（可直接读主程序内存／会话），不在
 * 本项防御内；本项挡的是跨会话／跨用户／SYSTEM 服务直接拉客户端
 * 的滥用。 */
static int parent_is_main_app(DWORD pid) {
    HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snap == INVALID_HANDLE_VALUE) return 0;
    PROCESSENTRY32W pe;
    pe.dwSize = sizeof(pe);
    DWORD parent = 0;
    if (Process32FirstW(snap, &pe)) {
        do {
            if (pe.th32ProcessID == pid) { parent = pe.th32ParentProcessID; break; }
        } while (Process32NextW(snap, &pe));
    }
    CloseHandle(snap);
    if (!parent) return 0;
    /* 父进程须在当前活动控制台会话里（主程序是交互会话进程；SYSTEM
     * 服务在 session 0，跨会话拉客户端直接拒）。 */
    DWORD parent_session = 0;
    if (!ProcessIdToSessionId(parent, &parent_session)) return 0;
    if (parent_session != WTSGetActiveConsoleSessionId()) return 0;
    HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, parent);
    if (!h) return 0;
    WCHAR img[MAX_PATH];
    DWORD n = MAX_PATH;
    int ok = 0;
    if (QueryFullProcessImageNameW(h, 0, img, &n) && n > 0) {
        WCHAR *base = img;
        for (WCHAR *p = img; *p; p++) if (*p == L'\\' || *p == L'/') base = p + 1;
        ok = (_wcsicmp(base, L"QFRemote.exe") == 0 ||
              _wcsicmp(base, L"electron.exe") == 0);
    }
    CloseHandle(h);
    return ok;
}

static int internal_caller_allowed(HANDLE pipe) {
    DWORD pid = 0;
    if (!GetNamedPipeClientProcessId(pipe, &pid) || pid == 0) return 0;
    HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (!h) return 0;
    WCHAR img[MAX_PATH];
    DWORD n = MAX_PATH;
    int ok = 0;
    if (QueryFullProcessImageNameW(h, 0, img, &n) && n > 0) {
        char img_u8[MAX_PATH];
        utf16_to_utf8(img, img_u8, sizeof(img_u8));
        char expect[MAX_PATH];
        snprintf(expect, sizeof(expect), "%s\\qf-lea-client.exe", g_install_dir);
        for (char *p = img_u8; *p; p++) if (*p == '/') *p = '\\';
        for (char *p = expect; *p; p++) if (*p == '/') *p = '\\';
        ok = (_stricmp(img_u8, expect) == 0);
    }
    CloseHandle(h);
    /* 镜像对上还不够：客户端须是主程序的直接子进程（见 parent_is_main_app）。 */
    if (ok) ok = parent_is_main_app(pid);
    return ok;
}

/* ---------- USH 鉴权 token（H03） ---------- */
/* 读当前控制台会话 USH 的每启动随机 token（USH 启动时生成并写入
 * %ProgramData%\QFR\LEA\ush-tokens\<sessionid>.txt）。返回 1=读到
 * 合法 token（64 位小写 hex）。读不到／格式不对即返回 0，调用方
 * fail-closed，不裸发 UI 命令。 */
static int ush_token_read(char *out, size_t out_size) {
    DWORD sid = WTSGetActiveConsoleSessionId();
    if (sid == 0xFFFFFFFF) return 0;
    char path[MAX_PATH];
    snprintf(path, sizeof(path), "%s\\%lu.txt", g_ushtokens_dir, (unsigned long)sid);
    FILE *f = fopen(path, "rb");
    if (!f) return 0;
    char buf[128] = { 0 };
    size_t r = fread(buf, 1, sizeof(buf) - 1, f);
    fclose(f);
    buf[r] = '\0';
    size_t n = strlen(buf);
    while (n > 0 && (buf[n - 1] == '\n' || buf[n - 1] == '\r' ||
                     buf[n - 1] == ' ' || buf[n - 1] == '\t'))
        buf[--n] = '\0';
    if (n != 64) return 0;
    for (size_t i = 0; i < n; i++)
        if (!((buf[i] >= '0' && buf[i] <= '9') || (buf[i] >= 'a' && buf[i] <= 'f')))
            return 0;
    if (out_size < 65) return 0;
    snprintf(out, out_size, "%s", buf);
    return 1;
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

/* ---------- 最终路径解析（#21①） ---------- */
/* 对已打开句柄取最终路径（GetFinalPathNameByHandle 解析全部重解析点，
 * 含符号链接／目录连接／挂载点），去 \\?\ 前缀后返回 UTF-8 路径。
 * 词法规范化（lea_normalize_path）只认 . 与 ..，目录内一个指向根外的
 * 符号链接词法上仍在根内——所有“在根内”判定都须对最终路径再验一次。
 * 失败返回 0（调用方 fail-closed）。 */
/* 去 GetFinalPathNameByHandle 返回的 \\?\ 前缀
 *（\\?\UNC\server\share → \\server\share，其余 \\?\C:\... → C:\...）。 */
static int strip_nt_prefix_w(const WCHAR *wfinal, WCHAR *wnorm, size_t wnorm_size) {
    if (!wfinal || !wnorm || wnorm_size < 4) return 0;
    if (wcsncmp(wfinal, L"\\\\?\\UNC\\", 8) == 0) {
        return _snwprintf(wnorm, wnorm_size, L"\\\\%s", wfinal + 8) >= 0;
    } else if (wcsncmp(wfinal, L"\\\\?\\", 4) == 0) {
        return wcscpy_s(wnorm, wnorm_size, wfinal + 4) == 0;
    }
    return wcscpy_s(wnorm, wnorm_size, wfinal) == 0;
}

static int resolve_final_path_utf8(const char *path_utf8, char *out, size_t out_size) {
    if (!path_utf8 || !out || out_size < 4) return 0;
    WCHAR wpath[MAX_PATH];
    utf8_to_utf16(path_utf8, wpath, MAX_PATH);
    if (wpath[0] == L'\0') return 0;
    HANDLE h = CreateFileW(wpath, GENERIC_READ,
                           FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                           NULL, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, NULL);
    if (h == INVALID_HANDLE_VALUE) return 0;
    WCHAR wfinal[MAX_PATH];
    DWORD n = GetFinalPathNameByHandleW(h, wfinal, MAX_PATH, FILE_NAME_NORMALIZED);
    CloseHandle(h);
    if (n == 0 || n >= MAX_PATH) return 0;
    WCHAR wnorm[MAX_PATH];
    if (!strip_nt_prefix_w(wfinal, wnorm, MAX_PATH)) return 0;
    utf16_to_utf8(wnorm, out, out_size);
    return out[0] != '\0';
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
    /* #21①：词法在安装目录内 ≠ 实际在安装目录内——目录内一个指向目录
     * 外的符号链接，词法检查照样通过。对已打开句柄取最终路径再验根；
     * basename 与 hash 一律对最终路径做（链接目标文件名可能不同）。
     * 成功时 norm_out 回写最终路径，调用方不再碰原始词法路径。 */
    char final_path[MAX_PATH] = { 0 };
    if (!resolve_final_path_utf8(norm_out, final_path, sizeof(final_path))) {
        snprintf(detail, detail_size, "%s", "final-path-resolve-failed");
        return 0;
    }
    char norm_final[MAX_PATH] = { 0 };
    if (!lea_normalize_path(final_path, norm_final, sizeof(norm_final)) ||
        !lea_path_under_root(norm_final, norm_install)) {
        snprintf(detail, detail_size, "%s", "symlink-outside-install-dir");
        return 0;
    }
    snprintf(norm_out, norm_size, "%s", norm_final);
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

/* ---------- 脚本验后复制（#21②） ---------- */
/* TOCTOU：script_is_allowed 按路径算 hash，PowerShell 再按路径打开执行——
 * 两次打开之间文件被换，hash 验的是旧文件、执行的是新文件。PowerShell
 * -File 接不了句柄，唯一能让“hash 的字节 = 执行的字节”的办法是：对同一
 * 已打开句柄边读边算 hash、边写一份私有副本，执行这份副本（副本在仅
 * SY/BA 可写的 work 目录；生成后不再碰原文）。残留窗口只剩“攻击者在
 * hash 完成、执行开始之间改写副本”——改写者须有 work 目录写权限（即
 * SY/BA，与服务同权），不在本项防御内；服务中途崩溃会留一份副本在
 * work 目录，内容即白名单脚本本身的逐字节复制、无害。
 * 失败返回 0（调用方按 SCRIPT_NOT_ALLOWED 报 detail），半成品副本已删。 */
static int script_prepare_verified_copy(const char *script_final_path,
                                        char *copy_out, size_t copy_size,
                                        char *detail, size_t detail_size) {
    if (!script_final_path || !copy_out || copy_size < 4) return 0;
    WCHAR wpath[MAX_PATH];
    utf8_to_utf16(script_final_path, wpath, MAX_PATH);
    HANDLE h = CreateFileW(wpath, GENERIC_READ, FILE_SHARE_READ, NULL,
                           OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (h == INVALID_HANDLE_VALUE) {
        snprintf(detail, detail_size, "%s", "script-open-failed");
        return 0;
    }
    /* 同一打开期间再取最终路径，必须与 gate 给的最终路径一致——gate 与
     * 复制之间文件被换（路径被重定向）即拒。 */
    WCHAR wfinal[MAX_PATH];
    DWORD n = GetFinalPathNameByHandleW(h, wfinal, MAX_PATH, FILE_NAME_NORMALIZED);
    if (n == 0 || n >= MAX_PATH) {
        CloseHandle(h);
        snprintf(detail, detail_size, "%s", "final-path-resolve-failed");
        return 0;
    }
    char final_path[MAX_PATH] = { 0 };
    {
        WCHAR wnorm[MAX_PATH];
        if (!strip_nt_prefix_w(wfinal, wnorm, MAX_PATH)) {
            CloseHandle(h);
            snprintf(detail, detail_size, "%s", "final-path-resolve-failed");
            return 0;
        }
        utf16_to_utf8(wnorm, final_path, sizeof(final_path));
    }
    char norm_final[MAX_PATH] = { 0 };
    if (!lea_normalize_path(final_path, norm_final, sizeof(norm_final)) ||
        _stricmp(norm_final, script_final_path) != 0) {
        CloseHandle(h);
        snprintf(detail, detail_size, "%s", "final-path-changed");
        return 0;
    }
    char copy_path[MAX_PATH] = { 0 };
    snprintf(copy_path, sizeof(copy_path), "%s\\script-verified-%lu-%llu.ps1",
             g_work_dir, (unsigned long)GetCurrentProcessId(),
             (unsigned long long)GetTickCount64());
    FILE *cf = fopen(copy_path, "wb");
    if (!cf) {
        CloseHandle(h);
        snprintf(detail, detail_size, "%s", "verified-copy-create-failed");
        return 0;
    }
    lea_sha256_ctx_t ctx;
    lea_sha256_init(&ctx);
    unsigned char buf[8192];
    int ok = 1;
    for (;;) {
        DWORD got = 0;
        if (!ReadFile(h, buf, sizeof(buf), &got, NULL)) { ok = 0; break; }
        if (got == 0) break;
        lea_sha256_update(&ctx, buf, got);
        if (fwrite(buf, 1, got, cf) != got) { ok = 0; break; }
    }
    CloseHandle(h);
    fclose(cf);
    char hex[65] = { 0 };
    if (ok) {
        lea_sha256_final_hex(&ctx, hex);
        if (!hash_hex_equal(hex, W_HEAL_PS1_SHA256)) ok = 0;
    }
    if (!ok) {
        remove(copy_path);
        snprintf(detail, detail_size, "%s", "hash-mismatch");
        return 0;
    }
    snprintf(copy_out, copy_size, "%s", copy_path);
    return 1;
}

/* ---------- 执行：PowerShell 脚本 ---------- */
/* 返回值：1=已执行（exit_code 有效），0=启动失败，-1=超时（已清树），
 * -2=命令行超长（#23，调用方按 BAD_ENVELOPE 报 powershell-cmdline-too-long）。
 * #21③：超时不再只 TerminateProcess 直接子进程——脚本进 Job Object
 * （KILL_ON_JOB_CLOSE），超时用 TerminateJobObject 清整棵树，正常结束
 * 后关闭 Job 句柄也会清掉残留的孙子进程，不留 SYSTEM 孤儿。Job 建不出／
 * 挂不进时记日志并退回旧的 TerminateProcess（不因 Job 失败拒绝执行）。
 * 挂 Job 须在子进程拉起孙子进程前完成：CREATE_SUSPENDED 起进程 → 挂 Job
 * → ResumeThread（挂失败也照常 Resume，不卡进程）。 */
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

    /* #23：先把全部参数引用好、算清总宽字符长度，超 8192 即拒绝；不再
     * 依赖 wcscat_s 的失败语义（MSVC 失败是否清空整行存疑，且失败时已
     * 拼入的参数会静默丢失）。wcscat_s 返回值仍逐一检查，双保险。 */
    WCHAR cmdline[8192];
    WCHAR wscript[MAX_PATH];
    utf8_to_utf16(script_norm, wscript, MAX_PATH);
    int pre = _snwprintf(cmdline, 8192,
               L"powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"%s\"",
               wscript);
    if (pre < 0 || pre >= 8192) {
        CloseHandle(hOut);
        return -2;
    }
    size_t need = (size_t)pre + 1;
    WCHAR wargs[16][1100];
    if (nargs > 16) nargs = 16;
    for (int i = 0; i < nargs; i++) {
        char q[1100];
        quote_arg(args[i], q, sizeof(q));
        utf8_to_utf16(q, wargs[i], 1100);
        need += 1 + wcslen(wargs[i]);
    }
    if (need >= 8192) {
        CloseHandle(hOut);
        return -2;
    }
    for (int i = 0; i < nargs; i++) {
        if (wcscat_s(cmdline, 8192, L" ") != 0 ||
            wcscat_s(cmdline, 8192, wargs[i]) != 0) {
            CloseHandle(hOut);
            return -2;
        }
    }
    /* Job Object（#21③）：先建 Job、配 KILL_ON_JOB_CLOSE，建不出即不用。 */
    HANDLE hJob = CreateJobObjectW(NULL, NULL);
    DWORD create_flags = CREATE_NO_WINDOW;
    if (hJob) {
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION jeli;
        ZeroMemory(&jeli, sizeof(jeli));
        jeli.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if (SetInformationJobObject(hJob, JobObjectExtendedLimitInformation,
                                    &jeli, sizeof(jeli)))
            create_flags |= CREATE_SUSPENDED;
        else {
            CloseHandle(hJob);
            hJob = NULL;
        }
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
        if (hJob) CloseHandle(hJob);
        return 0;
    }
    ZeroMemory(&pi, sizeof(pi));
    if (!CreateProcessW(ps_path, cmdline, NULL, NULL, TRUE,
                        create_flags, NULL, NULL, &si, &pi)) {
        CloseHandle(hOut);
        CloseHandle(si.hStdInput);
        if (hJob) CloseHandle(hJob);
        return 0;
    }
    CloseHandle(hOut);
    CloseHandle(si.hStdInput);
    if (hJob && !AssignProcessToJobObject(hJob, pi.hProcess)) {
        /* 挂不进（如父进程已在 Job 内）：记日志，退回 TerminateProcess。 */
        svc_log("WARN powershell job assign failed %lu, timeout kills direct child only",
                (unsigned long)GetLastError());
        CloseHandle(hJob);
        hJob = NULL;
    }
    if (create_flags & CREATE_SUSPENDED) ResumeThread(pi.hThread);
    DWORD w = WaitForSingleObject(pi.hProcess, (DWORD)timeout_ms);
    if (w == WAIT_TIMEOUT) {
        if (hJob) TerminateJobObject(hJob, 1);
        else TerminateProcess(pi.hProcess, 1);
        CloseHandle(pi.hProcess);
        CloseHandle(pi.hThread);
        if (hJob) CloseHandle(hJob);
        return -1;
    }
    DWORD code = 1;
    GetExitCodeProcess(pi.hProcess, &code);
    if (exit_code) *exit_code = code;
    CloseHandle(pi.hProcess);
    CloseHandle(pi.hThread);
    /* 正常结束也关 Job 句柄：KILL_ON_JOB_CLOSE 会清掉脚本残留的孙子进程。 */
    if (hJob) CloseHandle(hJob);
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
/* #21①：词法在 work 根内 ≠ 实际在根内——中间目录或文件本身可能是符号
 * 链接。已存在的文件／目录：对已打开句柄取最终路径再验根；不存在的
 * （file.write 新建）：验父目录最终路径在根内，叶节点本身不存在、无
 * 链接可言。成功时 norm_out 回写最终路径，调用方不再碰原始词法路径。
 * 残留竞态：新建文件在“验父目录”与“fopen 创建”之间被第三者预置为
 * 符号链接——预置者须有 work 目录写权限（即 SY/BA，与服务同权），
 * 不在本项防御内（见改动清单）。 */
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
    WCHAR wpath[MAX_PATH];
    utf8_to_utf16(norm_out, wpath, MAX_PATH);
    DWORD attrs = GetFileAttributesW(wpath);
    if (attrs != INVALID_FILE_ATTRIBUTES) {
        char final_path[MAX_PATH] = { 0 };
        if (!resolve_final_path_utf8(norm_out, final_path, sizeof(final_path))) {
            snprintf(detail, detail_size, "%s", "final-path-resolve-failed");
            return 0;
        }
        char norm_final[MAX_PATH] = { 0 };
        if (!lea_normalize_path(final_path, norm_final, sizeof(norm_final)) ||
            !lea_path_under_root(norm_final, norm_root)) {
            snprintf(detail, detail_size, "%s", "symlink-outside-work-root");
            return 0;
        }
        snprintf(norm_out, norm_size, "%s", norm_final);
    } else {
        /* 不存在：拆父目录＋叶名，父目录最终路径须在根内。 */
        char parent[MAX_PATH] = { 0 };
        const char *leaf = norm_out;
        for (const char *p = norm_out; *p; p++)
            if (*p == '\\' || *p == '/') leaf = p + 1;
        size_t plen = (size_t)(leaf - norm_out);
        if (plen == 0 || leaf[0] == '\0' || plen >= sizeof(parent)) {
            snprintf(detail, detail_size, "%s", "path-normalize-failed");
            return 0;
        }
        memcpy(parent, norm_out, plen);
        parent[plen] = '\0';
        /* 去掉父目录末尾分隔符（根本身 "C:\..." 末尾已有分隔符时除外，
         * resolve 前 lea_normalize_path 已处理，此处只去多余的一个）。 */
        size_t pl = strlen(parent);
        if (pl > 1 && (parent[pl - 1] == '\\' || parent[pl - 1] == '/'))
            parent[pl - 1] = '\0';
        char final_parent[MAX_PATH] = { 0 };
        if (!resolve_final_path_utf8(parent, final_parent, sizeof(final_parent))) {
            snprintf(detail, detail_size, "%s", "parent-resolve-failed");
            return 0;
        }
        char norm_parent[MAX_PATH] = { 0 };
        if (!lea_normalize_path(final_parent, norm_parent, sizeof(norm_parent)) ||
            !lea_path_under_root(norm_parent, norm_root)) {
            snprintf(detail, detail_size, "%s", "symlink-outside-work-root");
            return 0;
        }
        snprintf(norm_out, norm_size, "%s\\%s", norm_parent, leaf);
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
    /* #21①：同 script_is_allowed——安装目录内指向目录外的符号链接，
     * 词法检查照样通过。对已打开句柄取最终路径再验根；basename 与
     * hash 一律对最终路径做。成功时 norm_out 回写最终路径。 */
    char final_path[MAX_PATH] = { 0 };
    if (!resolve_final_path_utf8(norm_out, final_path, sizeof(final_path))) {
        snprintf(detail, detail_size, "%s", "final-path-resolve-failed");
        return 0;
    }
    char norm_final[MAX_PATH] = { 0 };
    if (!lea_normalize_path(final_path, norm_final, sizeof(norm_final)) ||
        !lea_path_under_root(norm_final, norm_install)) {
        snprintf(detail, detail_size, "%s", "symlink-outside-install-dir");
        return 0;
    }
    snprintf(norm_out, norm_size, "%s", norm_final);
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
/* #8：句柄以 FILE_FLAG_OVERLAPPED 打开时，WriteFile/ReadFile 必须传
 * OVERLAPPED（传 NULL 违反 Win32 文档、行为不可靠）；读侧用一个绝对
 * deadline（start+timeout_ms），每 chunk 只等剩余时间，不再每 chunk
 * 等完整 timeout_ms（慢速响应可把等待拉长到多倍 timeout）。
 * 注：LEA→USH 转发此前从未在真机跑过；修后须阿里真机冒烟覆盖此路径
 * （见改动清单遗留项）。 */
static int ush_write_all_overlapped(HANDLE pipe, const char *buf, size_t len,
                                    ULONGLONG deadline_tick) {
    HANDLE ev = CreateEventW(NULL, TRUE, FALSE, NULL);
    if (!ev) return 0;
    size_t sent = 0;
    int ok = 0;
    while (sent < len) {
        OVERLAPPED ov;
        memset(&ov, 0, sizeof(ov));
        ov.hEvent = ev;
        /* 每轮重用事件前先复位：系统不在新操作开始时复位事件，残留的
         * signaled 会让 WaitForSingleObject 误判已完成。 */
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

static int ush_forward(const char *envelope_line, long timeout_ms,
                       char *resp, size_t resp_size, char *detail, size_t detail_size) {
    /* 绝对 deadline：写＋读共享同一个 timeout_ms 预算。 */
    ULONGLONG deadline_tick = GetTickCount64() +
        (ULONGLONG)(timeout_ms > 0 ? timeout_ms : 5000);
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
    if (!ush_write_all_overlapped(pipe, sendbuf, slen + 1, deadline_tick)) {
        CloseHandle(pipe);
        snprintf(detail, detail_size, "%s", "ush-write-failed");
        return 0;
    }
    /* 带绝对 deadline 的读：每次只等剩余时间。 */
    HANDLE ev = CreateEventW(NULL, TRUE, FALSE, NULL);
    if (!ev) {
        CloseHandle(pipe);
        snprintf(detail, detail_size, "%s", "event-failed");
        return 0;
    }
    size_t total = 0;
    int ok = 0;
    char chunk[4096];
    while (total + 1 < resp_size) {
        OVERLAPPED ov;
        memset(&ov, 0, sizeof(ov));
        ov.hEvent = ev;
        /* 同写侧：每轮重用事件前先复位，防残留 signaled 误判。 */
        ResetEvent(ev);
        DWORD got = 0;
        BOOL r = ReadFile(pipe, chunk, sizeof(chunk), &got, &ov);
        if (!r && GetLastError() == ERROR_IO_PENDING) {
            ULONGLONG now = GetTickCount64();
            if (now >= deadline_tick) {
                CancelIo(pipe);
                break;
            }
            DWORD wait_ms = (DWORD)(deadline_tick - now);
            if (WaitForSingleObject(ev, wait_ms) != WAIT_OBJECT_0) {
                CancelIo(pipe);
                break;
            }
            if (!GetOverlappedResult(pipe, &ov, &got, FALSE)) {
                /* r10：USH 写完响应即 DisconnectNamedPipe，挂起的读可
                 * 以 ERROR_BROKEN_PIPE 完成，与 got==0 同款视为帧结束；
                 * 已收数据以已收内容为准，终判仍由 lea_ush_response_ok
                 * 做。其它错误仍判失败。 */
                if (GetLastError() == ERROR_BROKEN_PIPE && total > 0) { ok = 1; }
                break;
            }
        } else if (!r) {
            /* r10：同上——无挂起读时对端已断开亦为帧结束。 */
            if (GetLastError() == ERROR_BROKEN_PIPE && total > 0) { ok = 1; }
            break;
        }
        /* T24 同款（M-B 修法，同根）：got==0（对端关闭）时，若已收到部分
         * 数据即视为本次响应结束（无换行也以已收内容为准）；尚未收到任何
         * 数据则仍判无响应。管道短读是常态，不得把 got < sizeof(chunk)
         * 当作完成。 */
        if (got == 0) { if (total > 0) ok = 1; break; }
        size_t take = got;
        if (total + take >= resp_size) take = resp_size - total - 1;
        memcpy(resp + total, chunk, take);
        total += take;
        resp[total] = '\0';
        /* r10 tree 修复（方案②改良版，DS v4-pro 复核）：USH 响应是
         * "<JSON>\n"，但 ui.tree 的 JSON 内含 pretty-print 字面换行，
         * 旧逻辑见第一个 '\n' 即停，只收到 `"tree":` 前的半行。
         * 改为帧完整才停：累计内容须为一个完整 JSON 文档且末字节为
         * 帧尾 '\n'（lea_json_is_valid 为严格解析：未闭合／尾部多余
         * 内容／串内裸控制符一律判不完整，继续读；块边界恰停在 '}'
         * 后、无 '\n' 时亦继续读，防前缀完整提前停）。未见帧尾时，
         * 对端关闭（got==0／ERROR_BROKEN_PIPE）或超时／64KB 上限
         * 仍可结束，终判由 lea_ush_response_ok 做。 */
        if (total > 0 && resp[total - 1] == '\n' && lea_json_is_valid(resp)) { ok = 1; break; }
        /* 短读继续读：只有帧完整、对端关闭或超时才算完成。 */
    }
    CloseHandle(ev);
    CloseHandle(pipe);
    if (!ok || total == 0) {
        snprintf(detail, detail_size, "%s", "ush-read-timeout-or-empty");
        return 0;
    }
    /* r10：只剥末尾帧尾换行，不再截断首个 '\n'（tree 内含换行）。 */
    while (total > 0 && (resp[total - 1] == '\n' || resp[total - 1] == '\r')) {
        resp[--total] = '\0';
    }
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

/* #7：响应构造包装——lea_build_response 放不下时返回 0 且 resp 里是截断
 * 半行 JSON；各处若不检查返回值就原样发回，客户端收到非法 JSON。
 * 此处统一检查：失败时改发预置的小错误 JSON（detail=response-overflow），
 * 绝不发送截断半行。request_id 只取 token 字符集内的前缀后拼入，
 * 保证 fallback 本身恒为合法 JSON。 */
static void build_resp(char *resp, size_t resp_size, int ok, const char *code,
                       const char *request_id, int retryable,
                       const char *detail, const char *result_json) {
    if (lea_build_response(resp, resp_size, ok, code, request_id, retryable,
                           detail, result_json))
        return;
    svc_log("ERROR response-overflow code=%s request=%s",
            code ? code : "", request_id ? request_id : "");
    char rid[64] = { 0 };
    if (request_id) {
        size_t i = 0;
        for (; i < sizeof(rid) - 1 && request_id[i]; i++) {
            char c = request_id[i];
            if (!((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
                  (c >= '0' && c <= '9') || c == '-' || c == '_'))
                break;
            rid[i] = c;
        }
        rid[i] = '\0';
    }
    snprintf(resp, resp_size,
             "{\"ok\":false,\"code\":\"%s\",\"request_id\":\"%s\",\"retryable\":false,"
             "\"detail\":\"response-overflow\",\"result\":null}\n",
             LEA_ERR_INTERNAL, rid);
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
    /* #19：毫秒单调时钟——now_unix 只有秒精度，(now_unix()-t0)*1000
     * 对短命令恒为 0（旧实现算出 duration 又 (void) 丢弃、审计传 0）。
     * t0（秒）仍用于幂等时间戳；耗时一律以 t0_tick 计。 */
    ULONGLONG t0_tick = GetTickCount64();
    /* H10：执行前复查 expires_at——入队后已过期（已过 30s 时钟偏差容限，
     * 与 lea_check_time_window 的容限一致）的命令不得执行：幂等记
     * EXPIRED（同键重试可重跑，未执行过不算重复），管道调用方收到过期
     * 响应；已超时的管道线程可能已返回，本处仍按正常尾巴收尾（填
     * result_json＋SetEvent＋释放 worker 侧引用）。 */
    if (t0 > env->expires_at + LEA_MAX_CLOCK_SKEW_SEC) {
        char resp[LEA_MAX_RESPONSE] = { 0 };
        build_resp(resp, sizeof(resp), 0, LEA_ERR_EXPIRED, env->request_id, 0,
                           "expired-before-execution", NULL);
        EnterCriticalSection(&g_lock);
        if (item->idem) {
            lea_idem_set_status(&g_idem, item->idem, LEA_IDEM_EXPIRED, NULL, t0);
            idem_persist_locked();
        }
        LeaveCriticalSection(&g_lock);
        audit_for_envelope(env, "execute", "expired", LEA_ERR_EXPIRED,
                           (long)(GetTickCount64() - t0_tick),
                           "expired-before-execution");
        snprintf(ctx->result_json, sizeof(ctx->result_json), "%s", resp);
        SetEvent(ctx->done);
        lea_ctx_release(ctx);
        return;
    }
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
                /* #21②：gate 验过的最终路径再做一次“验后复制”——执行的是
                 * 副本（verified），不再碰原文；副本用完即删（各出口
                 * 汇合到分支末尾统一删，见下）。 */
                char verified[MAX_PATH] = { 0 };
                if (!script_is_allowed(resolved, norm, sizeof(norm), sdetail, sizeof(sdetail))) {
                    ok = 0; code = LEA_ERR_SCRIPT_NOT_ALLOWED;
                    snprintf(detail, sizeof(detail), "%s", sdetail);
                } else if (!script_prepare_verified_copy(norm, verified, sizeof(verified),
                                                         sdetail, sizeof(sdetail))) {
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
                        /* #21②：执行验后副本 verified（hash 过的同一批字节），
                         * 不执行原文 norm。 */
                        int r = run_powershell_script(verified, args, nargs, timeout_ms,
                                                      &exit_code, output, sizeof(output));
                        if (r == -2) {
                            /* #23：命令行超 8192 宽字符——参数未被截断执行，
                             * 明确报 BAD_ENVELOPE，调用方缩短参数后重试。 */
                            ok = 0; code = LEA_ERR_BAD_ENVELOPE;
                            snprintf(detail, sizeof(detail), "%s", "powershell-cmdline-too-long");
                        } else if (r == -1) {
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
                /* #21②：验后副本用完即删（gate 失败／复制失败时 verified
                 * 为空串，remove 为空操作；成功执行后也不留副本）。 */
                if (verified[0]) remove(verified);
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
                    /* #21④：size 用实际读到的字节数，不用 ftell——文件在
                     * ftell 与 fread 之间变化时会说谎（变大被截断、变小
                     * 谎报；旧实现 b64 编 r 字节却报 sz）。循环读到 EOF，
                     * 上限 32768，超限即拒绝（与旧口径同一码／同一文案）。 */
                    unsigned char data[32768 + 1];
                    size_t r = 0;
                    int over = 0, rd_err = 0;
                    for (;;) {
                        if (r >= 32768) {
                            unsigned char probe;
                            if (fread(&probe, 1, 1, f) > 0) over = 1;
                            break;
                        }
                        size_t n = fread(data + r, 1, 32768 - r, f);
                        if (n == 0) break;
                        r += n;
                    }
                    if (ferror(f)) rd_err = 1;
                    fclose(f);
                    if (rd_err) {
                        ok = 0; code = LEA_ERR_EXEC_FAILED;
                        snprintf(detail, sizeof(detail), "%s", "file-read-failed");
                    } else if (over) {
                        ok = 0; code = LEA_ERR_EXEC_FAILED;
                        snprintf(detail, sizeof(detail), "%s",
                                 "file-too-large-for-inline-read");
                    } else {
                        char *b64 = (char *)malloc((r + 2) / 3 * 4 + 2);
                        if (b64 && lea_b64_encode(data, r, b64, (r + 2) / 3 * 4 + 2) >= 0) {
                            snprintf(result_buf, sizeof(result_buf),
                                     "{\"size\":%lu,\"content_b64\":\"%s\"}",
                                     (unsigned long)r, b64);
                            result_json = result_buf;
                        } else {
                            ok = 0; code = LEA_ERR_INTERNAL;
                        }
                        free(b64);
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
        /* UI 类：worker 用 item->env 重建信封行转发给 USH。
         * H03：转发前读当前会话 USH 的每启动随机 token 并插入信封行
         * （ush_token 字段），USH 验 token＋验 LEA 进程镜像；token
         * 读不到即 fail-closed，不裸发。 */
        char ush_resp[LEA_MAX_RESPONSE] = { 0 };
        char udetail[256] = { 0 };
        char env_line[LEA_MAX_ENVELOPE] = { 0 };
        char env_tok[LEA_MAX_ENVELOPE] = { 0 };
        char ush_token[65] = { 0 };
        if (!lea_rebuild_envelope(env, env_line, sizeof(env_line))) {
            ok = 0; code = LEA_ERR_INTERNAL;
            snprintf(detail, sizeof(detail), "%s", "rebuild-envelope-failed");
        } else if (!ush_token_read(ush_token, sizeof(ush_token))) {
            ok = 0; code = LEA_ERR_USH_UNAVAILABLE;
            snprintf(detail, sizeof(detail), "%s", "ush-token-missing");
        } else if (!lea_json_insert_string_field(env_line, "ush_token", ush_token,
                                                 env_tok, sizeof(env_tok))) {
            ok = 0; code = LEA_ERR_INTERNAL;
            snprintf(detail, sizeof(detail), "%s", "ush-token-insert-failed");
        } else if (!ush_forward(env_tok, timeout_ms, ush_resp, sizeof(ush_resp),
                                udetail, sizeof(udetail))) {
            ok = 0; code = LEA_ERR_USH_UNAVAILABLE;
            snprintf(detail, sizeof(detail), "%s", udetail);
        } else {
            /* USH 响应形如 {"ok":...,"code":"..."}：透传其 ok/code。
             * 须含布尔 ok 字段才采信：lea_ush_response_ok 返回 0（垃圾／
             * 截断／无 ok 字段响应）即判失败，ok 不得沿用初值 1；此时不
             * 采信响应里的 code（不可信），一律报 EXEC_FAILED。 */
            char ush_code[64] = { 0 };
            int uok = 0;
            if (!lea_ush_response_ok(ush_resp, &uok)) {
                ok = 0; code = LEA_ERR_EXEC_FAILED;
                snprintf(detail, sizeof(detail), "%s", "ush-response-no-ok");
            } else {
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
            }
            /* #7：ush_resp 最长近 64KB，转义后可能超 64KB。转义失败即
             * 丢弃 result、明言 ush-response-too-large，绝不把截断半行
             * 拼进 result 发回（build_resp 的 fallback 只兜底整行放不下，
             * 兜不住 result 内部已截断的情形）。 */
            size_t off = 0;
            off += (size_t)snprintf(result_buf + off, sizeof(result_buf) - off,
                                    "{\"ush_response\":\"");
            if (!lea_json_escape_into(result_buf, sizeof(result_buf), &off, ush_resp)) {
                ok = 0; code = LEA_ERR_INTERNAL;
                snprintf(detail, sizeof(detail), "%s", "ush-response-too-large");
                result_json = NULL;
            } else {
                snprintf(result_buf + off, sizeof(result_buf) - off, "\"}");
                result_json = result_buf;
            }
        }
    } else {
        ok = 0; code = LEA_ERR_BAD_ENVELOPE;
        snprintf(detail, sizeof(detail), "%s", "unknown-command");
    }

    /* #19：执行耗时用毫秒单调时钟实测，不再用秒级 now_unix() 相减。 */
    long duration_ms = (long)(GetTickCount64() - t0_tick);
    build_resp(resp, sizeof(resp), ok, code, env->request_id,
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
                       duration_ms, detail);
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
    build_resp(resp, resp_size, 1, LEA_OK, env->request_id, 0, "", result);
}

/* ---------- 内部命令（登录事件／绑定票据／登出） ---------- */
static void handle_internal(const char *text, char *resp, size_t resp_size) {
    char cmd[64] = { 0 };
    /* H08：内部命令各字段同样只认顶层成员（嵌套同名键不得遮蔽顶层值）。 */
    if (!lea_json_top_level_string(text, "cmd", cmd, sizeof(cmd))) {
        build_resp(resp, resp_size, 0, LEA_ERR_BAD_ENVELOPE, "", 0, "cmd-missing", NULL);
        return;
    }
    if (strcmp(cmd, "session.login_changed") == 0) {
        char account[128] = { 0 }, device[128] = { 0 };
        if (!lea_json_top_level_string(text, "account_id", account, sizeof(account)) || !account[0]) {
            build_resp(resp, resp_size, 0, LEA_ERR_BAD_ENVELOPE, "", 0, "account_id-missing", NULL);
            return;
        }
        lea_json_top_level_string(text, "device_id", device, sizeof(device));
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
        if (!lea_binding_login_result(epoch, result, sizeof(result))) {
            build_resp(resp, resp_size, 0, LEA_ERR_INTERNAL, "", 0, "login-result-too-small", NULL);
            return;
        }
        build_resp(resp, resp_size, 1, LEA_OK, "", 0, "", result);
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
        build_resp(resp, resp_size, 1, LEA_OK, "", 0, "", NULL);
        return;
    }
    if (strcmp(cmd, "binding.confirm") == 0) {
        /* 票据严格解析（lea_parse_ticket，可单测）：全部字段按类型校验——
         * 缺失／类型错误一律拒绝；scopes 非字符串不得当空串处理；
         * grant_muse_execute 取解析原值直接入串（非 0/1 由
         * lea_ticket_canonical() 拒绝），调用点不得 truthy 归一化。 */
        lea_ticket_t tk;
        if (!lea_parse_ticket(text, &tk)) {
            build_resp(resp, resp_size, 0, LEA_ERR_BAD_ENVELOPE, "", 0, "ticket-fields-invalid", NULL);
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
            build_resp(resp, resp_size, 0, LEA_ERR_BAD_ENVELOPE, "", 0, "canonical-build-failed", NULL);
            svc_log("binding confirm rejected: canonical-build-failed");
            return;
        }
        char reason[128] = { 0 };
        if (!lea_verify_ticket_signature(tk.signature, canonical, reason, sizeof(reason))) {
            const char *code = strcmp(reason, "ed25519-pubkey-not-configured") == 0
                ? LEA_ERR_SIG_NOT_CONFIGURED : LEA_ERR_BAD_SIGNATURE;
            build_resp(resp, resp_size, 0, code, "", 0, reason, NULL);
            svc_log("binding confirm rejected: %s", reason);
            return;
        }
        EnterCriticalSection(&g_lock);
        int okc = lea_binding_confirm(&g_binding, tk.binding_epoch, tk.grant_epoch, tk.grant_muse_execute,
                                      tk.scopes, tk.lease_id, tk.expires_at, tk.signature,
                                      now_unix());
        if (okc) binding_persist_locked();
        long long cur_epoch = g_binding.epoch;
        LeaveCriticalSection(&g_lock);
        if (!okc) {
            build_resp(resp, resp_size, 0, LEA_ERR_BINDING_CHANGED, "", 0,
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
        build_resp(resp, resp_size, 1, LEA_OK, "", 0, "", result);
        return;
    }
    if (strcmp(cmd, "keys.sync-revoked") == 0) {
        /* #17：C 侧吊销表写入方。主程序在 rebind 拿到服务端吊销全集快照
         * （rb.json.revocations.revoked_key_ids）后经 qf-lea-client.exe
         * --internal 发 {"cmd":"keys.sync-revoked","key_ids":[...]}。
         * 写入语义是并集合并（lea_revoked_merge），不是全量替换：本机表
         * 另有 H21 下发前推送这一全量替换写入方，两方到达顺序无保证，
         * 陈旧快照全量替换会缩表（丢新吊销项，陈旧空集还会清表）；服务
         * 端台账只增不减，并集合并下陈旧快照／空集至多无操作，永不缩表。
         * key_ids 缺失／非数组／元素非法即拒绝，不写残集；写盘失败
         * （含 ACL 失败删文件）即报 INTERNAL，调用方下次下发前服务端
         * 推送会重新同步（H21 pushed_epoch 未追上即重推）。调用方已由
         * pipe_client_thread 按 H01 验过（安装目录客户端＋主程序父进程），
         * 此处不再另验。
         * #1 版本化：generation 成员缺失（旧版回包）即走无版本并集合并，
         * 不推进本机世代；存在但非法（非裸整数／负数／溢出／重复键）
         * 即整单拒绝；存在且小于本机已接受的最大世代即陈旧快照，拒绝
         * 不写盘（detail revoked-generation-stale）。 */
        char ids[LEA_REVOKED_MAX_IDS][128];
        int n = lea_json_top_level_string_array(text, "key_ids", ids, LEA_REVOKED_MAX_IDS);
        if (n < 0) {
            build_resp(resp, resp_size, 0, LEA_ERR_BAD_ENVELOPE, "", 0, "key_ids-invalid", NULL);
            return;
        }
        const char *ptrs[LEA_REVOKED_MAX_IDS];
        for (int i = 0; i < n; i++) ptrs[i] = ids[i];
        long long gen = -1;
        int gen_rc = lea_json_top_level_long(text, "generation", &gen);
        if (gen_rc < 0 || (gen_rc == 1 && gen < 0)) {
            build_resp(resp, resp_size, 0, LEA_ERR_BAD_ENVELOPE, "", 0, "generation-invalid", NULL);
            return;
        }
        if (gen_rc == 1) {
            int stale = 0;
            if (!lea_revoked_merge_with_generation(g_revoked_path, ptrs, n, gen, &stale)) {
                build_resp(resp, resp_size, 0, LEA_ERR_INTERNAL, "", 0,
                           stale ? "revoked-generation-stale" : "revoked-write-failed", NULL);
                svc_log("ERROR keys.sync-revoked %s count=%d generation=%lld",
                        stale ? "stale-generation" : "write failed", n, gen);
                return;
            }
        } else if (!lea_revoked_merge(g_revoked_path, ptrs, n)) {
            build_resp(resp, resp_size, 0, LEA_ERR_INTERNAL, "", 0, "revoked-write-failed", NULL);
            svc_log("ERROR keys.sync-revoked write failed count=%d", n);
            return;
        }
        if (!set_sys_admin_acl(g_revoked_path))
            /* 只记 ERROR，不删文件：主路径（服务端 H21 推送）写此文件时
             * 同样不设 ACL，删了反而丢吊销数据；下次下发前服务端会重推。 */
            svc_log("ERROR keys.sync-revoked acl failed for %s", g_revoked_path);
        lea_audit_event_t ev;
        memset(&ev, 0, sizeof(ev));
        ev.event = "keys";
        ev.command = "keys.sync-revoked";
        ev.result = "ok";
        ev.detail = "revoked_keys.txt merged from rebind";
        audit_event(&ev);
        char result[128];
        if (gen_rc == 1)
            snprintf(result, sizeof(result), "{\"revoked_count\":%d,\"generation\":%lld}", n, gen);
        else
            snprintf(result, sizeof(result), "{\"revoked_count\":%d}", n);
        build_resp(resp, resp_size, 1, LEA_OK, "", 0, "", result);
        return;
    }
    build_resp(resp, resp_size, 0, LEA_ERR_BAD_ENVELOPE, "", 0, "unknown-internal-cmd", NULL);
}

/* ---------- 信封处理（管道线程） ---------- */
static void handle_envelope(const char *text, char *resp, size_t resp_size) {
    lea_envelope_t env;
    long long t0 = now_unix();
    if (!lea_parse_envelope(text, t0, &env)) {
        /* 解析失败时 request_id 可能未知；尽力提取后回包。 */
        char rid[64] = { 0 };
        lea_json_string(text, "request_id", rid, sizeof(rid));
        build_resp(resp, resp_size, 0, env.error, rid,
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
        build_resp(resp, resp_size, 0, LEA_ERR_BAD_ENVELOPE, env.request_id, 0,
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
        build_resp(resp, resp_size, 0, code, env.request_id, 0, reason, NULL);
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
            build_resp(resp, resp_size, 0, err, env.request_id,
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
        build_resp(resp, resp_size, 0, LEA_ERR_REPLAY, env.request_id, 0,
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
        build_resp(resp, resp_size, 0, err, env.request_id,
                           lea_error_retryable(err), "", NULL);
        audit_for_envelope(&env, "admit-reject", "rejected", err, 0, "");
        svc_log("REJECT admit request=%s code=%s", env.request_id, err);
        return;
    }
    /* 4.5 H10：batch_id／seq 单调性——同批 seq 必须严格递增（乱序／重放步
     * 拒绝）；单条（无 batch_id）seq 必须为 1。验签后才查，拒绝不入队。
     * DS 复查阻塞项：检查通过即写表，但后续入队可能失败（队列满／分配
     * 失败）——失败路径必须用 prev_seq 回滚，否则该 seq 被记为“已消费”，
     * 客户端重试同步会被判重复拒绝（队列满可重试退化为永久卡死）。 */
    long long batch_prev_seq = -1;
    {
        EnterCriticalSection(&g_lock);
        int seq_ok = lea_batch_seq_check(&g_batch_seq, env.device_id, env.account_id,
                                         env.batch_id, env.seq, t0, &batch_prev_seq);
        LeaveCriticalSection(&g_lock);
        if (!seq_ok) {
            build_resp(resp, resp_size, 0, LEA_ERR_REPLAY, env.request_id, 0,
                               "batch-seq-not-monotonic", NULL);
            audit_for_envelope(&env, "admit-reject", "rejected", LEA_ERR_REPLAY, 0,
                               "batch-seq-not-monotonic");
            svc_log("REJECT batch-seq request=%s batch=%s seq=%lld",
                    env.request_id, env.batch_id, env.seq);
            return;
        }
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
        build_resp(resp, resp_size, 0, LEA_ERR_DUPLICATE, env.request_id, 0,
                           "same idempotency_key already running", NULL);
        audit_for_envelope(&env, "execute", "rejected", LEA_ERR_DUPLICATE, 0, "");
        return;
    }
    if (idem && idem->status == LEA_IDEM_UNKNOWN) {
        LeaveCriticalSection(&g_lock);
        build_resp(resp, resp_size, 0, LEA_ERR_UNKNOWN, env.request_id, 0,
                           "previous attempt outcome unknown; confirm manually", NULL);
        return;
    }
    if (!idem) {
        LeaveCriticalSection(&g_lock);
        build_resp(resp, resp_size, 0, LEA_ERR_INTERNAL, env.request_id, 0,
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
        /* 未入队：回滚 4.5 步已记的 seq（同队列满路径），否则重试被判重复。 */
        lea_batch_seq_rollback(&g_batch_seq, env.device_id, env.account_id,
                               env.batch_id, env.seq, batch_prev_seq);
        lea_idem_set_status(&g_idem, idem, LEA_IDEM_UNKNOWN, NULL, t0);
        idem_persist_locked();
        LeaveCriticalSection(&g_lock);
        build_resp(resp, resp_size, 0, LEA_ERR_INTERNAL, env.request_id, 0,
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
        /* 未入队：回滚 4.5 步已记的 seq，否则重试同 seq 会被判重复拒绝。 */
        lea_batch_seq_rollback(&g_batch_seq, env.device_id, env.account_id,
                               env.batch_id, env.seq, batch_prev_seq);
        lea_idem_set_status(&g_idem, idem, LEA_IDEM_RECEIVED, NULL, t0);
        idem_persist_locked();
        LeaveCriticalSection(&g_lock);
        build_resp(resp, resp_size, 0, LEA_ERR_QUEUE_FULL, env.request_id, 0,
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
        build_resp(resp, resp_size, 0, LEA_ERR_TIMEOUT, env.request_id, 0,
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
/* #14：重叠写一行响应（带超时；句柄为 FILE_FLAG_OVERLAPPED，同步
 * WriteFile 传 NULL 不可靠）。 */
static int pipe_write_all(HANDLE pipe, const char *buf, size_t len) {
    ULONGLONG deadline_tick = GetTickCount64() + LEA_PIPE_WRITE_TIMEOUT_MS;
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

static DWORD WINAPI pipe_client_thread(LPVOID param) {
    HANDLE pipe = (HANDLE)param;
    char buf[LEA_MAX_ENVELOPE + 1];
    size_t total = 0;
    /* #14：读一行（'\n' 结束），上限 LEA_MAX_ENVELOPE，总 deadline 30s。
     * 旧实现同步 ReadFile 无超时，连上不发数据的客户端永久占住实例。
     * 超时即断开、不处理（不把半行当请求解析）。 */
    ULONGLONG deadline_tick = GetTickCount64() + LEA_PIPE_READ_TIMEOUT_MS;
    HANDLE ev = CreateEventW(NULL, TRUE, FALSE, NULL);
    int read_timed_out = 0;
    if (!ev) {
        DisconnectNamedPipe(pipe);
        CloseHandle(pipe);
        return 0;
    }
    while (total < LEA_MAX_ENVELOPE) {
        OVERLAPPED ov;
        memset(&ov, 0, sizeof(ov));
        ov.hEvent = ev;
        ResetEvent(ev);
        DWORD got = 0;
        BOOL ok = ReadFile(pipe, buf + total, (DWORD)(LEA_MAX_ENVELOPE - total), &got, &ov);
        if (!ok && GetLastError() == ERROR_IO_PENDING) {
            ULONGLONG now = GetTickCount64();
            if (now >= deadline_tick) {
                CancelIo(pipe);
                read_timed_out = 1;
                break;
            }
            DWORD wait_ms = (DWORD)(deadline_tick - now);
            if (WaitForSingleObject(ev, wait_ms) != WAIT_OBJECT_0) {
                CancelIo(pipe);
                read_timed_out = 1;
                break;
            }
            if (!GetOverlappedResult(pipe, &ov, &got, FALSE)) break;
        } else if (!ok) {
            break;
        }
        if (got == 0) break;
        total += got;
        buf[total] = '\0';
        if (memchr(buf, '\n', total)) break;
    }
    CloseHandle(ev);
    if (read_timed_out) {
        svc_log("WARN pipe read timeout (30s), disconnecting idle client");
        FlushFileBuffers(pipe);
        DisconnectNamedPipe(pipe);
        CloseHandle(pipe);
        return 0;
    }
    if (total > 0) {
        buf[total] = '\0';
        char *nl = strchr(buf, '\n');
        if (nl) *nl = '\0';
        /* 去掉末尾 \r */
        size_t l = strlen(buf);
        if (l > 0 && buf[l - 1] == '\r') buf[l - 1] = '\0';
        char resp[LEA_MAX_RESPONSE] = { 0 };
        /* 内部命令（{"cmd":...}）与信封分流。H08：只认顶层 "cmd" 成员——
         * 全文查找会命中 params 内嵌套的 "cmd" 键，使已签信封被误判进
         * handle_internal、绕过信封验签；无顶层 "cmd" 即走信封处理。 */
        char cmd[64] = { 0 };
        if (lea_json_top_level_string(buf, "cmd", cmd, sizeof(cmd)) && cmd[0]) {
            /* H01：内部命令先验调用方身份——不是已安装的客户端一律拒绝，
             * 含 session.logout 这类可废掉绑定的命令。 */
            if (!internal_caller_allowed(pipe)) {
                svc_log("REJECT internal cmd=%s caller-not-allowed", cmd);
                lea_audit_event_t ev;
                memset(&ev, 0, sizeof(ev));
                ev.event = "admit-reject";
                ev.command = cmd;
                ev.result = "rejected";
                ev.detail = "internal-caller-not-allowed";
                audit_event(&ev);
                build_resp(resp, sizeof(resp), 0, LEA_ERR_CALLER_NOT_ALLOWED, "", 0,
                                   "internal-caller-not-allowed", NULL);
            } else {
                handle_internal(buf, resp, sizeof(resp));
            }
        } else {
            handle_envelope(buf, resp, sizeof(resp));
        }
        /* #14：响应写同样走重叠 I/O（句柄为 OVERLAPPED）。 */
        pipe_write_all(pipe, resp, strlen(resp));
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
        /* #14：实例以 FILE_FLAG_OVERLAPPED 创建，连接与读写一律走重叠 I/O，
         * 读行才有总 deadline 可言（同步句柄的 ReadFile 无法设超时）。 */
        HANDLE pipe = CreateNamedPipeW(PIPE_NAME_W,
            PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED,
            /* #27：PIPE_REJECT_REMOTE_CLIENTS——远程客户端纵有管理员凭据
             * 也连不上本机管道（旧实现只靠 SY+BA+AU 的 ACL，远程仍可尝试
             * 建连；USH 管道已设此标志，LEA 补齐）。 */
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
            PIPE_MAX_INSTANCES, LEA_MAX_ENVELOPE, LEA_MAX_ENVELOPE, 0, &sa);
        if (pipe == INVALID_HANDLE_VALUE) {
            svc_log("ERROR CreateNamedPipe failed %lu", (unsigned long)GetLastError());
            Sleep(1000);
            continue;
        }
        /* 重叠等连接（监听线程阻塞；连接后另起线程处理）。
         * 停止时 service_main 用一次本地客户端连接自唤醒（同 QFSysHelper）。 */
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
    lea_batch_seq_init(&g_batch_seq);
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
