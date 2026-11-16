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
 *     API Key 归属（本地吊销表）＋重放表。签名规范串唯一规范源：
 *     信封 v2 见 windows/lea/CANONICAL-SIGNING-V2.md（20 行），
 *     票据 v1 见 ds-review-stage2/CANONICAL-SIGNING-V1.md §3
 *     （票据 9 行，两端同一份）。v1 信封不再接受。
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
 * 首装（A1）：QFRLEA.exe --install-service [--repair]／--repair／
 *   --uninstall-service／--verify-manifest <dir> <manifest>，见 lea_install.h。
 *   只认本地命令行，绝不经 LEA API／qf-lea-client 远程调用。
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
#include <errno.h>
#include "lea_protocol.h"
#include "lea_crypto.h"
#include "lea_state.h"
#include "lea_audit.h"
#include "lea_install.h"
#include "lea_local.h" /* S-021：本机控制状态（暂停／授权／撤销／状态查询） */
#include "whitelist.h"

#define SERVICE_NAME_W L"QFRLEA"
#define SERVICE_DISPLAY_W L"QFRemote 本地执行代理"
#define PIPE_NAME_W L"\\\\.\\pipe\\QFR\\LEA\\v1"
#define USH_PIPE_NAME_W L"\\\\.\\pipe\\QFR\\LEA\\UserHelper\\v1"
#define PIPE_SDDL_W L"D:(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;AU)"
/* r10：与 set_sys_admin_acl() 同步带 OICI（本宏当前未被引用，留作防复发；
 * 无继承标志时服务启动会把数据目录可继承 ACE 剥掉，子项得空 DACL）。 */
#define DIR_SDDL_W L"D:(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)"
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
/* B1（2026-11-13，PLAN §2 B1）：活动 job 登记表（g_lock 保护）——worker
 * 执行期间登记，执行器子进程句柄（powershell 子进程＋Job Object）由
 * run_powershell_script 填入；看门狗线程每 1 秒扫描，超 deadline 即强杀。
 * 单 worker 串行执行，同一时刻最多一个活动 job。 */
typedef struct {
    int active;
    char request_id[64];
    char job_id[64]; /* S-022：job.cancel／job.query 按 job_id 匹配活动 job */
    char command[32];
    char api_key_id[64];     /* RC-02：活动 job 所属 Key（吊销命中时强杀用） */
    ULONGLONG deadline_tick; /* GetTickCount64 单调时钟 */
    HANDLE hProcess;         /* 执行器子进程（可为 NULL，如 USH 转发／文件操作） */
    HANDLE hJob;             /* 子进程绑定的 Job Object（可为 NULL） */
    int timed_out;           /* 看门狗已强杀（worker 收尾时据此改判 TIMEOUT） */
    int reset_kill;          /* sys.reset／看门狗清队时强杀（worker 收尾时改判 RESET） */
    int revoked_kill;        /* RC-02：Key 吊销时强杀（worker 收尾时改判 KEY_REVOKED） */
} lea_active_job_t;
static lea_active_job_t g_active_job;
/* B1 前置声明（看门狗／执行器重置，定义在 execute_item 之前；run_powershell_script
 * 在其前引用登记函数，故先声明）。 */
static void lea_active_job_begin(const lea_envelope_t *env);
static void lea_active_job_set_handles(HANDLE hProcess, HANDLE hJob);
static void lea_active_job_clear_handles(void);
static void lea_active_job_end(void);
static int lea_active_job_check_timeout(void); /* 0=正常，1=看门狗超时，2=reset 强杀，3=吊销强杀（RC-02） */
static void lea_reset_executor(const char *reason); /* 杀活动 job 树＋清待执行队列（RESET） */
/* S-021：本机状态助手（定义在 handle_internal 之前；execute_item／
 * handle_envelope 用前置声明）。 */
static int local_status_snapshot(lea_local_status_t *out);
static void lea_refresh_local_status(const char *last_command, const char *last_result);
static void handle_lea_status(const lea_envelope_t *env, char *resp, size_t resp_size);
static DWORD WINAPI watchdog_loop(LPVOID unused);
static int pipe_write_all(HANDLE pipe, const char *buf, size_t len); /* B1：handle_envelope 写 ACK 用，定义在后 */
static HANDLE g_watchdog_thread = NULL;
/* B1：队列最老等待项入队 tick（单调时钟；队列空时为 0）。看门狗 5 秒
 * 检查用：最老等待超 30 秒即判积压异常。 */
static ULONGLONG g_queue_oldest_tick = 0;
/* B1/G2：agent 级看门狗（同看门狗线程，1 秒扫描）——MeshCentral agent
 * （服务名 "Mesh Agent"，进程 MeshAgent.exe）直接拉起的 runcommands
 * 子进程根（排除 LEA 自身路径），墙钟 25 秒警告、30 秒强杀整棵树。
 * 阈值见 lea_agent_watchdog_*（G2 定夺：b 主选＋c 组合，见证据目录
 * ds-answer-g2.md；a 不采用）。 */
#define LEA_G2_AGENT_EXE "MeshAgent.exe"
#define LEA_G2_WARN_SEC 25
#define LEA_G2_KILL_SEC 30
#define LEA_G2_MAX_ROOTS 32
typedef struct {
    DWORD pid;
    ULONGLONG first_seen_tick;
    ULONGLONG create_time; /* GetProcessTimes 100ns 刻度，防 PID 复用 */
    int warned;
    int seen;              /* 本轮扫描是否仍存在 */
} lea_g2_root_t;
static lea_g2_root_t g_g2_roots[LEA_G2_MAX_ROOTS];
static int g_g2_root_count = 0;

/* 路径（UTF-8） */
static char g_base_dir[MAX_PATH];      /* %ProgramData%\QFR\LEA */
static char g_state_dir[MAX_PATH];
static char g_logs_dir[MAX_PATH];
static char g_work_dir[MAX_PATH];
static char g_install_dir[MAX_PATH];   /* QFRLEA.exe 所在目录 */
static char g_idem_path[MAX_PATH];
static char g_binding_path[MAX_PATH];
static char g_revoked_path[MAX_PATH];
/* F-01 吊销表状态（见 revocation_startup_init／key_revocation_check）：
 * g_revoked_gen_max：本机已接受的最大吊销世代（启动时读 .gen，之后只增；
 * 快照世代低于它即陈旧，ERROR）。g_revoked_has_history：曾经有已接受
 * 世代或绑定历史——文件突然缺失时不当空表。g_revocation_degraded：
 * 启动／最近一次检查发现吊销表异常（缺失有历史／格式错／ACL／链接异常），
 * 业务信封一律拒绝直至推送恢复；检查通过即清零（可自愈，不锁死）。 */
static long long g_revoked_gen_max = 0;
static int g_revoked_gen_loaded = 0;
static int g_revoked_has_history = 0;
static int g_revocation_degraded = 0;
/* RC-01 握手态（本机内存态，重启即失；服务端凭 HANDSHAKE_REQUIRED 重握）。
 * g_lock 保护。 */
static lea_handshake_state_t g_handshake;
/* S-021：本机最近执行命令（g_lock 保护；状态文件是持久态，此处是
 * 内存快照，供状态快照叠加最新值）。 */
static char g_local_last_command[32] = { 0 };
static char g_local_last_result[64] = { 0 };
static long long g_local_last_command_at = 0;
static void revocation_startup_init(void);
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
 * 见 set_acl_or_remove_file，绝不留一个继承父目录宽松 ACL 的状态文件）。
 * r10（2026-11-12，触发器证据缺口 2）：ACE 须带 OICI（容器＋对象继承）。
 * 无继承标志时，服务每次启动调用 ensure_dirs() 都会把 %ProgramData%\QFR\LEA
 * 的可继承 ACE 剥掉；install-lea 步骤③新建的 install-report.json 遂得
 * 空 DACL，Set-Content 报 Access denied（2026-11-12 02:10:43 实测）。
 * OICI 与文件内 USH token 目录 SDDL 惯例一致；文件自身访问判定不受
 * OICI 影响（ACE 仍按 SY/BA FA 生效），目录子项将继承 SY+BA FA。 */
static int set_sys_admin_acl(const char *path_utf8) {
    PSECURITY_DESCRIPTOR sd = NULL;
    if (!ConvertStringSecurityDescriptorToSecurityDescriptorA(
            "D:(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)", SDDL_REVISION_1, &sd, NULL))
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

/* ---------- 吊销表（F-01 三态，fail-closed） ---------- */
/* 旧 key_is_revoked()：fopen 失败直接 return 0（未吊销），即 GPT 第二轮
 * 审计 F-01（P1）fail-open。本函数改为三态（见 lea_state.h
 * lea_revoked_check）：REVOKED / NOT_REVOKED / ERROR；ERROR 时调用点
 * 一律拒绝（LEA_ERR_REVOCATION_UNAVAILABLE，不可重试）。
 * 世代高水位：启动时从 .gen 加载，之后只增——H21 推送先写世代、再写
 * 表，检查时世代高于水位即跟进；低于水位即陈旧快照，ERROR。 */
static lea_revocation_status_t key_revocation_check(const char *api_key_id) {
    /* S-021：一键撤销（本机）——revoke-all.json 在位即全部 Key 已撤销，
     * 不必再读吊销表；g_base_dir 未初始化（服务启动前）时查不到标记，
     * 由下行正常吊销表逻辑继续（此时尚无信封处理）。 */
    if (g_base_dir[0] && lea_local_has_revoke_all(g_base_dir))
        return LEA_REVOCATION_REVOKED;
    long long snap = -1;
    lea_revocation_status_t st = lea_revoked_check(
        g_revoked_path, api_key_id,
        g_revoked_gen_loaded ? g_revoked_gen_max : 0,
        g_revoked_has_history, &snap);
    if (st == LEA_REVOCATION_ERROR) {
        g_revocation_degraded = 1;
    } else {
        /* X-01：启动 DEGRADED 的运行期一致口径——本次检查未见 sidecar
         * （snap==-1）时一律 ERROR，不分两种情形：
         *   ① 本机已加载世代、.gen 在运行中丢失（原有防线）；
         *   ② 本机未加载世代、无 .gen 的旧版快照（X-01 新增；否则启动
         *      置的 DEGRADED 会被首个信封的检查清掉、绕过显式迁移——
         *      大肥鱼复核后自查发现；启动与运行期须同一口径）。
         * 首次安装不受影响（启动时已写 .gen=0 并加载，snap==0）。 */
        if (snap == -1) {
            g_revocation_degraded = 1;
            return LEA_REVOCATION_ERROR;
        }
        g_revocation_degraded = 0;
        if (snap >= 0 && snap > g_revoked_gen_max) {
            g_revoked_gen_max = snap;
            g_revoked_gen_loaded = 1;
        }
    }
    return st;
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

/* ---------- 吊销表启动初始化（F-01 条件式，不许无条件“缺失即建空表”） ---------- */
/* 吊销文件须为普通文件——拒绝符号链接／重解析点／硬链接／路径替换
 * （最终路径须与期望路径一致，大小写不敏感）。仅启动时检查。 */
static int revoked_path_is_plain_file(const char *path_utf8) {
    WCHAR w[MAX_PATH];
    utf8_to_utf16(path_utf8, w, MAX_PATH);
    DWORD attr = GetFileAttributesW(w);
    if (attr == INVALID_FILE_ATTRIBUTES) return 0;
    if (attr & FILE_ATTRIBUTE_REPARSE_POINT) return 0;
    if (attr & FILE_ATTRIBUTE_DIRECTORY) return 0;
    HANDLE h = CreateFileW(w, GENERIC_READ, FILE_SHARE_READ, NULL,
                           OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (h == INVALID_HANDLE_VALUE) return 0;
    BY_HANDLE_FILE_INFORMATION info;
    int ok = GetFileInformationByHandle(h, &info) && info.nNumberOfLinks == 1;
    CloseHandle(h);
    if (!ok) return 0;
    char final_path[MAX_PATH] = { 0 };
    if (!resolve_final_path_utf8(path_utf8, final_path, sizeof(final_path))) return 0;
    return _stricmp(final_path, path_utf8) == 0;
}

/* 吊销文件 DACL 只允许 SYSTEM／Administrators 的允许 ACE；出现其他主体、
 * 拒绝 ACE 或空／缺失 DACL 即失败。继承来的 ACE 同样受限（state 目录
 * DACL 只有 SY+BA，故 H21 推送新建的文件天然通过；不要求 PROTECTED
 * 标志——推送新建文件是继承 DACL，无此标志）。仅启动时检查。 */
static int revoked_acl_is_sys_admin_only(const char *path_utf8) {
    WCHAR w[MAX_PATH];
    utf8_to_utf16(path_utf8, w, MAX_PATH);
    PSECURITY_DESCRIPTOR pSD = NULL;
    PACL pDacl = NULL;
    DWORD rc = GetNamedSecurityInfoW(w, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION,
                                     NULL, NULL, &pDacl, NULL, &pSD);
    if (rc != ERROR_SUCCESS || !pDacl) { if (pSD) LocalFree(pSD); return 0; }
    BYTE sysSid[SECURITY_MAX_SID_SIZE], baSid[SECURITY_MAX_SID_SIZE];
    DWORD sysSize = sizeof(sysSid), baSize = sizeof(baSid);
    int ok = 0;
    if (CreateWellKnownSid(WinLocalSystemSid, NULL, sysSid, &sysSize) &&
        CreateWellKnownSid(WinBuiltinAdministratorsSid, NULL, baSid, &baSize)) {
        ACL_SIZE_INFORMATION info;
        if (GetAclInformation(pDacl, &info, sizeof(info), AclSizeInformation) &&
            info.AceCount > 0) {
            ok = 1;
            for (DWORD i = 0; i < info.AceCount; i++) {
                void *pAce = NULL;
                if (!GetAce(pDacl, i, &pAce) || !pAce) { ok = 0; break; }
                ACE_HEADER *hdr = (ACE_HEADER *)pAce;
                if (hdr->AceType != ACCESS_ALLOWED_ACE_TYPE) { ok = 0; break; }
                PSID sid = (PSID)&((ACCESS_ALLOWED_ACE *)pAce)->SidStart;
                if (!EqualSid(sid, sysSid) && !EqualSid(sid, baSid)) { ok = 0; break; }
            }
        }
    }
    LocalFree(pSD);
    return ok;
}

/* 迁移标记状态（启动层，DS-Q4）：1=有效标记（文件内容＋普通文件形态＋
 * ACL 均通过），0=不存在，-1=损坏／路径派生失败／形态或 ACL 未通过。
 * 只在 snap==-1 且 !g_revoked_gen_loaded 时查，其他状态下标记无关，
 * 不查，避免无关损坏导致误 DEGRADED。 */
static int revoked_migrated_state(void) {
    char mpath[MAX_PATH] = { 0 };
    if (!lea_revoked_migrated_path(g_revoked_path, mpath, sizeof(mpath))) return -1;
    int r = lea_revoked_migrated_read(mpath);
    if (r == 1) {
        if (!revoked_path_is_plain_file(mpath) || !revoked_acl_is_sys_admin_only(mpath)) return -1;
        return 1;
    }
    return r;
}

/* 显式迁移旧版无世代快照（--migrate-revoked 工具用，X-01）：写
 * .gen=<generation>＋标记（各带 SYSTEM／Administrators ACL），.gen 绝不
 * 写 0（generation 须 ≥1，由调用方校验）。全成功才算成；任一失败调用方
 * 进 DEGRADED／报错，不写残集。 */
static int revoked_migrate_legacy_snapshot_gen(long long generation) {
    char gen_path[MAX_PATH] = { 0 };
    char mpath[MAX_PATH] = { 0 };
    if (!lea_revoked_gen_path(g_revoked_path, gen_path, sizeof(gen_path))) return 0;
    if (!lea_revoked_migrated_path(g_revoked_path, mpath, sizeof(mpath))) return 0;
    if (!lea_revoked_generation_write(gen_path, generation)) return 0;
    if (!set_sys_admin_acl(gen_path)) return 0;
    if (!lea_revoked_migrated_write(mpath)) return 0;
    if (!set_sys_admin_acl(mpath)) return 0;
    return 1;
}

/* F-01 启动初始化（条件式）：
 *   - 首次安装（无世代 sidecar、无绑定历史、文件缺失）：完成 ACL 后
 *     明确初始化为空表＋世代 0，进入 ACTIVE。
 *   - 曾经有已接受世代或绑定曾经 ACTIVE，文件突然缺失：不自动建空表，
 *     进 DEGRADED（拒绝业务信封），记日志，留待人工／推送恢复。
 *   - 文件存在：检查存在性、ACL、链接形态、格式、可读性，任一失败即
 *     DEGRADED。世代文件损坏同样 DEGRADED（快照世代无法确立）。
 * DEGRADED 不是锁死：key_revocation_check 每次检查通过即清零，H21
 * 推送恢复文件后自动恢复，无需重启。 */
static void revocation_startup_init(void) {
    char gen_path[MAX_PATH] = { 0 };
    char mpath[MAX_PATH] = { 0 };
    int have_gen = 0;      /* sidecar 存在且有效 */
    int gen_corrupt = 0;   /* sidecar 存在但损坏，或路径算不出 */
    long long gen = 0;
    if (lea_revoked_gen_path(g_revoked_path, gen_path, sizeof(gen_path))) {
        FILE *gf = fopen(gen_path, "rb");
        if (gf) {
            fclose(gf);
            if (lea_revoked_generation_read(gen_path, &gen)) have_gen = 1;
            else gen_corrupt = 1;
        } else if (errno != ENOENT) {
            /* .gen 打不开且不是“不存在”（EACCES 等）：不可读≠缺失，fail-closed。 */
            gen_corrupt = 1;
        }
    } else {
        gen_corrupt = 1;
    }
    lea_revoked_migrated_path(g_revoked_path, mpath, sizeof(mpath));
    /* 绑定历史：binding.dat 存在，或已加载的绑定曾经 ACTIVE。 */
    int have_binding = 0;
    {
        FILE *bf = fopen(g_binding_path, "rb");
        if (bf) { fclose(bf); have_binding = 1; }
    }
    if (g_binding.state == LEA_BIND_ACTIVE) have_binding = 1;
    g_revoked_has_history = (have_gen || have_binding);
    if (have_gen) { g_revoked_gen_max = gen; g_revoked_gen_loaded = 1; }
    if (gen_corrupt) {
        g_revocation_degraded = 1;
        svc_log("ERROR revoked generation file corrupt %s, entering DEGRADED", gen_path);
        return;
    }
    if (have_gen) {
        /* .gen 在位：须与吊销表同等保护（普通文件形态＋SYSTEM／Administrators 专属 ACL）。 */
        if (!revoked_path_is_plain_file(gen_path) || !revoked_acl_is_sys_admin_only(gen_path)) {
            g_revocation_degraded = 1;
            svc_log("ERROR revoked generation file not plain file or ACL not SYSTEM/Administrators-only, entering DEGRADED");
            return;
        }
    }
    FILE *f = fopen(g_revoked_path, "rb");
    if (!f) {
        if (!g_revoked_has_history) {
            if (lea_revoked_write(g_revoked_path, NULL, 0) &&
                lea_revoked_generation_write(gen_path, 0) &&
                lea_revoked_migrated_write(mpath) &&
                set_sys_admin_acl(g_revoked_path) && set_sys_admin_acl(gen_path) &&
                set_sys_admin_acl(mpath)) {
                g_revoked_has_history = 1;
                g_revoked_gen_max = 0;
                g_revoked_gen_loaded = 1;
                g_revocation_degraded = 0;
                svc_log("revoked table initialized empty (first install)");
            } else {
                g_revocation_degraded = 1;
                svc_log("ERROR revoked table first-install init failed, entering DEGRADED");
            }
        } else {
            g_revocation_degraded = 1;
            svc_log("ERROR revoked_keys.txt missing with history (gen=%s binding=%s), entering DEGRADED",
                    have_gen ? "yes" : "no", have_binding ? "yes" : "no");
        }
        return;
    }
    fclose(f);
    if (!revoked_path_is_plain_file(g_revoked_path)) {
        g_revocation_degraded = 1;
        svc_log("ERROR revoked_keys.txt is symlink/reparse/hardlink or final path mismatch, entering DEGRADED");
        return;
    }
    if (!revoked_acl_is_sys_admin_only(g_revoked_path)) {
        g_revocation_degraded = 1;
        svc_log("ERROR revoked_keys.txt ACL not SYSTEM/Administrators-only, entering DEGRADED");
        return;
    }
    long long snap = -1;
    if (!lea_revoked_validate_snapshot(g_revoked_path,
            g_revoked_gen_loaded ? g_revoked_gen_max : 0,
            g_revoked_has_history, &snap)) {
        g_revocation_degraded = 1;
        svc_log("ERROR revoked_keys.txt failed strict validation at startup, entering DEGRADED");
        return;
    }
    if (snap == -1 && !g_revoked_gen_loaded) {
        /* X-01（站长 2026-11-15 亲令，严格 fail-closed）：无 sidecar 的
         * 旧格式快照一律 DEGRADED，不再自动迁移；须管理员显式跑
         * QFRLEA.exe --migrate-revoked [--generation N] 迁移（有日志）。
         * 迁移标记在位（迁移后 .gen 又丢）同样 DEGRADED，不再静默重建。
         * DEGRADED 不是锁死：迁移工具写好文件后，下次吊销检查通过即
         * 自动恢复，无需重启。 */
        int have_migrated = revoked_migrated_state();
        if (have_migrated < 0) {
            g_revocation_degraded = 1;
            svc_log("ERROR revoked migration marker corrupt or unreadable, entering DEGRADED");
            return;
        }
        (void)have_migrated;
        g_revocation_degraded = 1;
        svc_log("ERROR revoked generation file missing with legacy snapshot, entering DEGRADED (run QFRLEA.exe --migrate-revoked to migrate explicitly)");
        return;
    }
    g_revocation_degraded = 0;
    if (snap >= 0 && snap > g_revoked_gen_max) {
        g_revoked_gen_max = snap;
        g_revoked_gen_loaded = 1;
    }
    svc_log("revoked table OK generation=%lld", g_revoked_gen_max);
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
    /* B1：把子进程＋Job 句柄登记进活动 job 表，看门狗超 deadline 时可强杀。
     * 句柄归属仍是本函数（看门狗只终止、不关闭），返回前须先清登记再关句柄。 */
    lea_active_job_set_handles(pi.hProcess, hJob);
    DWORD w = WaitForSingleObject(pi.hProcess, (DWORD)timeout_ms);
    if (w == WAIT_TIMEOUT) {
        if (hJob) TerminateJobObject(hJob, 1);
        else TerminateProcess(pi.hProcess, 1);
        lea_active_job_clear_handles();
        CloseHandle(pi.hProcess);
        CloseHandle(pi.hThread);
        if (hJob) CloseHandle(hJob);
        return -1;
    }
    DWORD code = 1;
    GetExitCodeProcess(pi.hProcess, &code);
    if (exit_code) *exit_code = code;
    lea_active_job_clear_handles();
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

/* r11 tree 加固②：收帧尾 '\n' 但 lea_json_is_valid 为 0 时的早停判据。
 * 裸按“见 '\n' 即完整”会误伤：ui.tree 的 data 内含 pretty-print 字面换行，
 * 4096 字节块边界恰停在行内 '\n' 上时，未收完的前缀也会以 '\n' 结尾。
 * 但行内换行只出现在 data 对象内部（深度 ≥2），而一封已写完的畸形响应
 * （如 r11 的双 head：信封缺 1 个 '}'）收尾时净深度恰为 1；尾部多余内容
 * 的非法帧净深度为 0 或负。只在净深度 ≤1 时早停：完整非法帧立即结束，
 * 行内换行前缀继续读；深度 ≥2 的非法帧不早停，仍由对端关闭（233/109）
 * 交终判，错误码同样是 ush-response-no-ok，只多一次读。
 * 硬约束（DS v4-pro 复核要求写死）：未来不得让信封层在深度 ≤1 的位置
 * 引入 pretty-print 字面换行（例如 "data": 与 data 对象 '{' 之间插 '\n'），
 * 否则 4096 分片恰停在那里会误早停，合法响应被终判失败。 */
static int ush_resp_open_depth(const char *s) {
    int depth = 0, in_str = 0, esc = 0;
    if (!s) return 0;
    for (const unsigned char *p = (const unsigned char *)s; *p; p++) {
        if (in_str) {
            if (esc) esc = 0;
            else if (*p == '\\') esc = 1;
            else if (*p == '"') in_str = 0;
            continue;
        }
        if (*p == '"') { in_str = 1; continue; }
        if (*p == '{' || *p == '[') depth++;
        else if (*p == '}' || *p == ']') depth--;
    }
    return depth;
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
    /* r11 仪器（定位用，定论后由协调人定去留）：记每轮读的 total／got／
     * GetLastError 与退出分支＋相对耗时。逻辑与 r10 完全一致，只加日志；
     * GetLastError 均在失败调用后立即取值，svc_log 本身不污染它。 */
    ULONGLONG fwd_t0 = GetTickCount64();
    int iter = 0;
    svc_log("R11-INSTR fwd-start timeout_ms=%ld", timeout_ms);
    while (total + 1 < resp_size) {
        OVERLAPPED ov;
        memset(&ov, 0, sizeof(ov));
        ov.hEvent = ev;
        /* 同写侧：每轮重用事件前先复位，防残留 signaled 误判。 */
        ResetEvent(ev);
        DWORD got = 0;
        BOOL r = ReadFile(pipe, chunk, sizeof(chunk), &got, &ov);
        DWORD gle = r ? 0 : GetLastError();
        svc_log("R11-INSTR read iter=%d total=%llu elapsed_ms=%llu r=%d gle=%lu got=%lu",
                iter, (unsigned long long)total,
                (unsigned long long)(GetTickCount64() - fwd_t0),
                (int)r, (unsigned long)gle, (unsigned long)got);
        iter++;
        if (!r && gle == ERROR_IO_PENDING) {
            ULONGLONG now = GetTickCount64();
            if (now >= deadline_tick) {
                CancelIo(pipe);
                svc_log("R11-INSTR read BREAK deadline-reached total=%llu elapsed_ms=%llu",
                        (unsigned long long)total,
                        (unsigned long long)(GetTickCount64() - fwd_t0));
                break;
            }
            DWORD wait_ms = (DWORD)(deadline_tick - now);
            if (WaitForSingleObject(ev, wait_ms) != WAIT_OBJECT_0) {
                CancelIo(pipe);
                svc_log("R11-INSTR read BREAK wait-timeout total=%llu elapsed_ms=%llu",
                        (unsigned long long)total,
                        (unsigned long long)(GetTickCount64() - fwd_t0));
                break;
            }
            if (!GetOverlappedResult(pipe, &ov, &got, FALSE)) {
                DWORD ogle = GetLastError();
                /* r10：USH 写完响应即 DisconnectNamedPipe，挂起的读可
                 * 以 ERROR_BROKEN_PIPE 完成，与 got==0 同款视为帧结束；
                 * 已收数据以已收内容为准，终判仍由 lea_ush_response_ok
                 * 做。其它错误仍判失败。
                 * r11 加固①：ERROR_PIPE_NOT_CONNECTED (233) 同按 EOF
                 * 处理——r11 实证第 4 次读即以 233 完成（USH 已断开），
                 * 旧代码只认 109，把已收完整 8883 字节误报为
                 * ush-read-timeout-or-empty。ok=1 只表示“交终判”，
                 * 不得直接判成功。 */
                if ((ogle == ERROR_BROKEN_PIPE ||
                     ogle == ERROR_PIPE_NOT_CONNECTED) && total > 0) { ok = 1; }
                svc_log("R11-INSTR read BREAK overlapped-fail ogle=%lu got=%lu total=%lu ok=%d elapsed_ms=%llu",
                        (unsigned long)ogle, (unsigned long)got,
                        (unsigned long)total, ok,
                        (unsigned long long)(GetTickCount64() - fwd_t0));
                break;
            }
        } else if (!r) {
            /* r10：同上——无挂起读时对端已断开亦为帧结束。
             * r11 加固①：233 与 109 同按 EOF 处理（见上）。 */
            if ((gle == ERROR_BROKEN_PIPE ||
                 gle == ERROR_PIPE_NOT_CONNECTED) && total > 0) { ok = 1; }
            svc_log("R11-INSTR read BREAK immediate-fail gle=%lu total=%llu ok=%d elapsed_ms=%llu",
                    (unsigned long)gle, (unsigned long long)total, ok,
                    (unsigned long long)(GetTickCount64() - fwd_t0));
            break;
        }
        /* T24 同款（M-B 修法，同根）：got==0（对端关闭）时，若已收到部分
         * 数据即视为本次响应结束（无换行也以已收内容为准）；尚未收到任何
         * 数据则仍判无响应。管道短读是常态，不得把 got < sizeof(chunk)
         * 当作完成。 */
        if (got == 0) {
            if (total > 0) ok = 1;
            svc_log("R11-INSTR read BREAK got0 total=%llu ok=%d elapsed_ms=%llu",
                    (unsigned long long)total, ok,
                    (unsigned long long)(GetTickCount64() - fwd_t0));
            break;
        }
        size_t take = got;
        if (total + take >= resp_size) take = resp_size - total - 1;
        memcpy(resp + total, chunk, take);
        total += take;
        resp[total] = '\0';
        svc_log("R11-INSTR read data got=%lu total=%llu last_nl=%d json_valid=%d elapsed_ms=%llu",
                (unsigned long)got, (unsigned long long)total,
                (int)(total > 0 && resp[total - 1] == '\n'),
                (int)(total > 0 && resp[total - 1] == '\n' && lea_json_is_valid(resp)),
                (unsigned long long)(GetTickCount64() - fwd_t0));
        /* r10 tree 修复（方案②改良版，DS v4-pro 复核）：USH 响应是
         * "<JSON>\n"，但 ui.tree 的 JSON 内含 pretty-print 字面换行，
         * 旧逻辑见第一个 '\n' 即停，只收到 `"tree":` 前的半行。
         * 改为帧完整才停：累计内容须为一个完整 JSON 文档且末字节为
         * 帧尾 '\n'（lea_json_is_valid 为严格解析：未闭合／尾部多余
         * 内容／串内裸控制符一律判不完整，继续读；块边界恰停在 '}'
         * 后、无 '\n' 时亦继续读，防前缀完整提前停）。未见帧尾时，
         * 对端关闭（got==0／ERROR_BROKEN_PIPE）或超时／64KB 上限
         * 仍可结束，终判由 lea_ush_response_ok 做。 */
        if (total > 0 && resp[total - 1] == '\n' && lea_json_is_valid(resp)) {
            ok = 1;
            svc_log("R11-INSTR read BREAK frame-complete total=%llu elapsed_ms=%llu",
                    (unsigned long long)total,
                    (unsigned long long)(GetTickCount64() - fwd_t0));
            break;
        }
        /* r11 加固②：已收帧尾 '\n' 但校验失败，且净深度 ≤1（见
         * ush_resp_open_depth）——这是“完整但非法响应”，立即结束，
         * 不再发起下一次读（旧行为会再撞 233，误报
         * ush-read-timeout-or-empty）。ok=1 只表示交终判：
         * lea_ush_response_ok 失败后调用方报 ush-response-no-ok。 */
        if (total > 0 && resp[total - 1] == '\n' &&
            ush_resp_open_depth(resp) <= 1) {
            ok = 1;
            svc_log("R11-INSTR read BREAK frame-invalid total=%llu elapsed_ms=%llu",
                    (unsigned long long)total,
                    (unsigned long long)(GetTickCount64() - fwd_t0));
            break;
        }
        /* 短读继续读：只有帧完整、对端关闭或超时才算完成。 */
    }
    if (total + 1 >= resp_size) {
        svc_log("R11-INSTR read BREAK resp-full total=%llu elapsed_ms=%llu",
                (unsigned long long)total,
                (unsigned long long)(GetTickCount64() - fwd_t0));
    }
    svc_log("R11-INSTR fwd-end ok=%d total=%llu elapsed_ms=%llu",
            ok, (unsigned long long)total,
            (unsigned long long)(GetTickCount64() - fwd_t0));
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

/* ================= B1：通道自愈（PLAN §2 B1） =================
 * 活动 job 登记（worker 执行期间）＋看门狗（1 秒扫描）＋执行器重置。
 * 全部共享态（g_active_job／g_queue_oldest_tick／g_g2_roots）由 g_lock
 * 保护；看门狗只终止进程树、不关闭句柄（句柄归属执行器，防双关竞态）。 */

/* worker 在分发执行器前登记；deadline = 现在＋分级强杀时限。 */
static void lea_active_job_begin(const lea_envelope_t *env) {
    EnterCriticalSection(&g_lock);
    memset(&g_active_job, 0, sizeof(g_active_job));
    g_active_job.active = 1;
    snprintf(g_active_job.request_id, sizeof(g_active_job.request_id), "%s", env->request_id);
    snprintf(g_active_job.job_id, sizeof(g_active_job.job_id), "%s", env->job_id[0] ? env->job_id : env->request_id);
    snprintf(g_active_job.command, sizeof(g_active_job.command), "%s", env->command);
    snprintf(g_active_job.api_key_id, sizeof(g_active_job.api_key_id), "%s", env->api_key_id);
    g_active_job.deadline_tick = GetTickCount64() + (ULONGLONG)lea_job_deadline_ms(env);
    LeaveCriticalSection(&g_lock);
}

/* 执行器（run_powershell_script）在子进程建好后登记句柄；看门狗据此强杀。 */
static void lea_active_job_set_handles(HANDLE hProcess, HANDLE hJob) {
    EnterCriticalSection(&g_lock);
    if (g_active_job.active) {
        g_active_job.hProcess = hProcess;
        g_active_job.hJob = hJob;
    }
    LeaveCriticalSection(&g_lock);
}

/* 执行器在关闭句柄前清登记（防看门狗拿到已关句柄）。 */
static void lea_active_job_clear_handles(void) {
    EnterCriticalSection(&g_lock);
    g_active_job.hProcess = NULL;
    g_active_job.hJob = NULL;
    LeaveCriticalSection(&g_lock);
}

static void lea_active_job_end(void) {
    EnterCriticalSection(&g_lock);
    memset(&g_active_job, 0, sizeof(g_active_job));
    LeaveCriticalSection(&g_lock);
}

/* worker 收尾时查：0=正常，1=看门狗已超时强杀，2=sys.reset／清队强杀，
 * 3=Key 吊销强杀（RC-02）。吊销优先于 reset／超时（同一 job 不可兼得，
 * 吊销是其终态 verdict）。 */
static int lea_active_job_check_timeout(void) {
    int r = 0;
    EnterCriticalSection(&g_lock);
    if (g_active_job.revoked_kill) r = 3;
    else if (g_active_job.reset_kill) r = 2;
    else if (g_active_job.timed_out) r = 1;
    LeaveCriticalSection(&g_lock);
    return r;
}

/* 强杀活动 job 的进程树（看门狗／reset／吊销共用）。kind：0=超时，
 * 1=reset，2=吊销。返回 0=无活动 job；1=进程树已强杀（有 Job／进程句
 * 柄）；2=仅置标志（无子进程句柄，等执行器返回后 worker 改判——大肥鱼
 * 复核：只置标志不是“已终止”，调用方须区分回报，见 lea.key_revoked）。 */
static int lea_watchdog_kill_active_job_kind(int kind) {
    HANDLE hJob = NULL, hProcess = NULL;
    EnterCriticalSection(&g_lock);
    if (!g_active_job.active) {
        LeaveCriticalSection(&g_lock);
        return 0;
    }
    hJob = g_active_job.hJob;
    hProcess = g_active_job.hProcess;
    if (kind == 1) g_active_job.reset_kill = 1;
    else if (kind == 2) g_active_job.revoked_kill = 1;
    else g_active_job.timed_out = 1;
    LeaveCriticalSection(&g_lock);
    if (hJob) {
        TerminateJobObject(hJob, 1);
        svc_log("B1 watchdog kill job request=%s kind=%d", g_active_job.request_id, kind);
        return 1;
    } else if (hProcess) {
        TerminateProcess(hProcess, 1);
        svc_log("B1 watchdog kill process request=%s kind=%d", g_active_job.request_id, kind);
        return 1;
    } else {
        /* 无子进程句柄（USH 转发／文件操作）：只置标志，等执行器自身
         * deadline 返回后 worker 改判；杀不到进程是已知局限。 */
        svc_log("B1 watchdog mark timeout (no child process) request=%s kind=%d",
                g_active_job.request_id, kind);
        return 2;
    }
}

/* 旧名保留（调用点：reset／看门狗超时；返回值同 kind 函数 0/1/2，调用点均忽略）。 */
static int lea_watchdog_kill_active_job(int is_reset) {
    return lea_watchdog_kill_active_job_kind(is_reset ? 1 : 0);
}

/* RC-02：吊销命中活动 job 时强杀并记 revoked_kill（worker 收尾改判
 * KEY_REVOKED）。仅当活动 job 的 api_key_id 与被吊销 Key 之一匹配时才杀；
 * 返回 0=无匹配活动 job；1=进程树已强杀；2=仅置标志（无子进程句柄，
 * 等执行器返回后改判——不是“已终止”，调用方须区分回报）。 */
static int lea_active_job_kill_revoked(const char *const *key_ids, int n_key_ids) {
    if (!key_ids || n_key_ids <= 0) return 0;
    EnterCriticalSection(&g_lock);
    int match = 0;
    if (g_active_job.active) {
        for (int i = 0; i < n_key_ids; i++) {
            if (key_ids[i] && strcmp(g_active_job.api_key_id, key_ids[i]) == 0) { match = 1; break; }
        }
    }
    LeaveCriticalSection(&g_lock);
    if (!match) return 0;
    return lea_watchdog_kill_active_job_kind(2);
}

/* 清空待执行队列：每项回 RESET（可重试，未执行）＋幂等回 RECEIVED＋
 * batch seq 回滚。调用方须持有 g_lock 完成出队与台账更新；完成通知
 * （填结果＋SetEvent＋释放 worker 侧引用）在放锁后做。 */
static void lea_drain_queue_reset(void) {
    lea_queue_item_t *head = NULL, *tail = NULL;
    int drained = 0;
    EnterCriticalSection(&g_lock);
    lea_queue_item_t *it;
    while ((it = lea_queue_dequeue(&g_queue)) != NULL) {
        drained++;
        it->next = NULL;
        if (!head) head = tail = it;
        else { tail->next = it; tail = it; }
        if (it->idem) {
            lea_idem_set_status(&g_idem, it->idem, LEA_IDEM_RECEIVED, NULL, now_unix());
        }
        /* 未入队／未执行：回滚 4.5 步已记的 seq，否则重试同 seq 被判重复。 */
        lea_batch_seq_rollback(&g_batch_seq, it->env.device_id, it->env.account_id,
                               it->env.batch_id, it->env.seq, it->batch_prev_seq);
    }
    if (head) idem_persist_locked();
    if (drained > 0) {
        /* 清掉的项永不到 worker_loop 的 g_inflight--，此处一次扣减，
         * 否则每次 reset 都永久漏记 N 条，队列准入（total＋inflight≤8）
         * 会越收越紧。RC-02 排查时发现的既有问题，同款口径一并修。 */
        g_inflight -= drained;
        if (g_inflight < 0) g_inflight = 0;
    }
    g_queue_oldest_tick = 0;
    /* G2 跟踪根一并清空（看门狗下轮重新发现；被杀的根不再跟踪）。 */
    g_g2_root_count = 0;
    memset(g_g2_roots, 0, sizeof(g_g2_roots));
    LeaveCriticalSection(&g_lock);
    /* 放锁后逐项完成（原管道线程收到 RESET 后释放自己的引用；此处
     * 释放 worker 侧引用——worker 永远不会再取到这些项）。 */
    while (head) {
        lea_queue_item_t *cur = head;
        head = head->next;
        lea_item_ctx_t *ctx = (lea_item_ctx_t *)cur->ctx;
        if (ctx) {
            char resp[LEA_MAX_RESPONSE] = { 0 };
            build_resp(resp, sizeof(resp), 0, LEA_ERR_RESET, cur->env.request_id,
                       lea_error_retryable(LEA_ERR_RESET), "reset-by-watchdog-or-sys-reset", NULL);
            snprintf(ctx->result_json, sizeof(ctx->result_json), "%s", resp);
            SetEvent(ctx->done);
            lea_ctx_release(ctx); /* worker 侧引用 */
        }
        lea_queue_item_free(cur);
    }
}

/* RC-02：按 Key 清待执行队列（吊销踢出用）。调用方（lea.key_revoked）
 * 不必持锁；本函数内部完成出队与台账更新，完成通知在放锁后做（同
 * lea_drain_queue_reset）。与 reset 清队的区别：逐项回 KEY_REVOKED
 * （不可重试）＋幂等记 FAILED（终态并缓存 KEY_REVOKED 响应，防同幂等键
 * 重试再执行）＋batch seq 回滚＋g_inflight 扣减。返回摘下条数。 */
static int lea_drain_queue_revoked(const char *const *key_ids, int n_key_ids) {
    if (!key_ids || n_key_ids <= 0) return 0;
    lea_queue_item_t *head = NULL, *tail = NULL;
    int removed = 0;
    EnterCriticalSection(&g_lock);
    for (int i = 0; i < n_key_ids; i++) {
        if (!key_ids[i] || !key_ids[i][0]) continue;
        int n = 0;
        lea_queue_item_t *list = lea_queue_remove_key(&g_queue, key_ids[i], &n);
        while (list) {
            lea_queue_item_t *cur = list;
            list = list->next;
            cur->next = NULL;
            if (!head) head = tail = cur;
            else { tail->next = cur; tail = cur; }
            removed++;
            /* 幂等记 FAILED 并缓存 KEY_REVOKED 响应（终态）：同幂等键重试
             * 直接回缓存 verdict，不再执行。 */
            char resp[LEA_MAX_RESPONSE] = { 0 };
            build_resp(resp, sizeof(resp), 0, LEA_ERR_KEY_REVOKED, cur->env.request_id,
                       lea_error_retryable(LEA_ERR_KEY_REVOKED), "key-revoked", NULL);
            if (cur->idem) {
                lea_idem_set_status(&g_idem, cur->idem, LEA_IDEM_FAILED, resp, now_unix());
            }
            lea_batch_seq_rollback(&g_batch_seq, cur->env.device_id, cur->env.account_id,
                                   cur->env.batch_id, cur->env.seq, cur->batch_prev_seq);
        }
    }
    if (head) idem_persist_locked();
    if (removed > 0) {
        g_inflight -= removed;
        if (g_inflight < 0) g_inflight = 0;
    }
    LeaveCriticalSection(&g_lock);
    /* 放锁后逐项完成（同 reset 清队：填结果＋SetEvent＋释放 worker 侧引用）。 */
    while (head) {
        lea_queue_item_t *cur = head;
        head = head->next;
        lea_item_ctx_t *ctx = (lea_item_ctx_t *)cur->ctx;
        if (ctx) {
            char resp[LEA_MAX_RESPONSE] = { 0 };
            build_resp(resp, sizeof(resp), 0, LEA_ERR_KEY_REVOKED, cur->env.request_id,
                       lea_error_retryable(LEA_ERR_KEY_REVOKED), "key-revoked", NULL);
            snprintf(ctx->result_json, sizeof(ctx->result_json), "%s", resp);
            SetEvent(ctx->done);
            lea_ctx_release(ctx); /* worker 侧引用 */
        }
        lea_queue_item_free(cur);
    }
    return removed;
}

/* 执行器重置（sys.reset 与看门狗积压共用）：杀活动 job 树＋清待执行队列。
 * 不杀 MeshCentral agent、不重启服务、不重启整机。 */
static void lea_reset_executor(const char *reason) {
    svc_log("B1 reset executor reason=%s", reason ? reason : "");
    lea_watchdog_kill_active_job(1);
    lea_drain_queue_reset();
    lea_audit_event_t ev;
    memset(&ev, 0, sizeof(ev));
    ev.event = "reset";
    ev.command = "sys.reset";
    ev.result = "ok";
    ev.detail = reason ? reason : "";
    audit_event(&ev);
}

/* 看门狗 1 秒检查：活动 job 超 deadline 即强杀。 */
static void lea_watchdog_check_active_job(void) {
    int over = 0;
    char req[64] = { 0 };
    EnterCriticalSection(&g_lock);
    if (g_active_job.active && !g_active_job.timed_out && !g_active_job.reset_kill &&
        GetTickCount64() > g_active_job.deadline_tick) {
        over = 1;
        snprintf(req, sizeof(req), "%s", g_active_job.request_id);
    }
    LeaveCriticalSection(&g_lock);
    if (over) {
        lea_watchdog_kill_active_job(0);
        /* audit_for_envelope 须传有效信封（会解引用），此处无信封，
         * 直接构造最小审计事件。 */
        lea_audit_event_t ev;
        memset(&ev, 0, sizeof(ev));
        ev.event = "watchdog";
        ev.request_id = req;
        ev.command = "job-timeout-kill";
        ev.result = "killed";
        ev.detail = "deadline-exceeded";
        audit_event(&ev);
    }
}

/* 看门狗 5 秒检查：队列最老等待超 30 秒即判积压异常，杀活动 job 树＋清队。 */
static void lea_watchdog_check_backlog(void) {
    int over = 0;
    EnterCriticalSection(&g_lock);
    if (g_queue_oldest_tick != 0 &&
        GetTickCount64() - g_queue_oldest_tick > 30000) {
        over = 1;
    }
    LeaveCriticalSection(&g_lock);
    if (over) {
        svc_log("B1 watchdog queue backlog oldest>30s, resetting executor");
        lea_reset_executor("watchdog-queue-backlog");
    }
}

/* ---------- G2：agent 级看门狗（MeshCentral agent 子进程树） ----------
 * 只跟踪“父进程是 MeshAgent.exe 的直接子进程”；LEA 自身（qf-lea-client、
 * QFRLEA、QFRemote）与 agent 本体永不进跟踪表。墙钟 25 秒警告、30 秒
 * 强杀整棵树（优先临时 Job Object，失败则后序 TerminateProcess）。 */
typedef struct {
    DWORD pid;
    DWORD ppid;
    ULONGLONG create_time; /* GetProcessTimes 100ns 刻度，防 PID 复用 */
    char image[MAX_PATH];
} lea_proc_entry_t;

static int lea_proc_image_is_excluded(const char *image) {
    /* 精确镜像名排除（禁按 powershell.exe 之类进程名整体放行）。 */
    const char *base = image;
    const char *slash = strrchr(image, '\\');
    if (slash) base = slash + 1;
    return _stricmp(base, "qf-lea-client.exe") == 0 ||
           _stricmp(base, "QFRLEA.exe") == 0 ||
           _stricmp(base, "QFRemote.exe") == 0 ||
           _stricmp(base, "MeshAgent.exe") == 0 ||
           _stricmp(base, "QFRLEA.exe") == 0;
}

/* 一次快照：返回进程数（≤max），-1=快照失败。 */
static int lea_proc_snapshot(lea_proc_entry_t *out, int max) {
    HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snap == INVALID_HANDLE_VALUE) return -1;
    PROCESSENTRY32W pe;
    pe.dwSize = sizeof(pe);
    int n = 0;
    if (Process32FirstW(snap, &pe)) {
        do {
            if (n >= max) break;
            HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pe.th32ProcessID);
            ULONGLONG ct = 0;
            if (h) {
                FILETIME cft, eft, kft, uft;
                if (GetProcessTimes(h, &cft, &eft, &kft, &uft)) {
                    ct = ((ULONGLONG)cft.dwHighDateTime << 32) | cft.dwLowDateTime;
                }
                CloseHandle(h);
            }
            out[n].pid = pe.th32ProcessID;
            out[n].ppid = pe.th32ParentProcessID;
            out[n].create_time = ct;
            char utf8[MAX_PATH] = { 0 };
            utf16_to_utf8(pe.szExeFile, utf8, sizeof(utf8));
            snprintf(out[n].image, sizeof(out[n].image), "%s", utf8);
            n++;
        } while (Process32NextW(snap, &pe));
    }
    CloseHandle(snap);
    return n;
}

/* 从快照里找 pid 的创建时间（防 PID 复用），找不到返回 0。 */
static ULONGLONG lea_proc_create_time(lea_proc_entry_t *procs, int n, DWORD pid) {
    for (int i = 0; i < n; i++)
        if (procs[i].pid == pid) return procs[i].create_time;
    return 0;
}

/* 收集 root_pid 的整棵树（root＋全部后代，按发现顺序；创建时间逐个校验）。
 * 返回个数（≤max），root 本人不在树内或创建时间对不上返回 0。 */
static int lea_g2_collect_tree(DWORD root_pid, ULONGLONG root_ct,
                               lea_proc_entry_t *procs, int n,
                               DWORD *out_pids, ULONGLONG *out_cts, int max) {
    if (lea_proc_create_time(procs, n, root_pid) != root_ct || root_ct == 0) return 0;
    int count = 0;
    /* BFS：先 root，再逐层后代。 */
    out_pids[count] = root_pid;
    out_cts[count] = root_ct;
    count++;
    for (int i = 0; i < count; i++) {
        for (int j = 0; j < n && count < max; j++) {
            if (procs[j].ppid == out_pids[i]) {
                /* 去重（同一 pid 只进一次）。 */
                int dup = 0;
                for (int k = 0; k < count; k++) if (out_pids[k] == procs[j].pid) { dup = 1; break; }
                if (!dup) {
                    out_pids[count] = procs[j].pid;
                    out_cts[count] = procs[j].create_time;
                    count++;
                }
            }
        }
    }
    return count;
}

/* 强杀一棵树：优先临时 Job Object（KILL_ON_JOB_CLOSE），逐个挂不进则
 * 后序 TerminateProcess。杀前逐个重查创建时间，防 PID 复用误杀。 */
static int lea_g2_kill_tree(DWORD root_pid, ULONGLONG root_ct) {
    lea_proc_entry_t procs[1024];
    int n = lea_proc_snapshot(procs, 1024);
    if (n < 0) return 0;
    DWORD pids[256];
    ULONGLONG cts[256];
    int count = lea_g2_collect_tree(root_pid, root_ct, procs, n, pids, cts, 256);
    if (count <= 0) return 0;
    int killed = 0;
    /* 先试 Job Object：全部挂进临时 job 再一次清树。 */
    HANDLE hJob = CreateJobObjectW(NULL, NULL);
    int job_ok = 0;
    if (hJob) {
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION jeli;
        ZeroMemory(&jeli, sizeof(jeli));
        jeli.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if (SetInformationJobObject(hJob, JobObjectExtendedLimitInformation, &jeli, sizeof(jeli))) {
            job_ok = 1;
            for (int i = 0; i < count; i++) {
                HANDLE h = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, FALSE, pids[i]);
                if (!h) { job_ok = 0; break; }
                if (!AssignProcessToJobObject(hJob, h)) { CloseHandle(h); job_ok = 0; break; }
                CloseHandle(h);
            }
        }
        if (job_ok) {
            TerminateJobObject(hJob, 1);
            killed = count;
        }
        CloseHandle(hJob);
        if (job_ok) return killed;
    }
    /* 回退：后序（先子后父）逐个 TerminateProcess。PID 复用防护在
     * lea_g2_collect_tree 的 root 创建时间校验＋本快照的新鲜度（毫秒级）。 */
    for (int i = count - 1; i >= 0; i--) {
        HANDLE h = OpenProcess(PROCESS_TERMINATE, FALSE, pids[i]);
        if (!h) continue;
        if (TerminateProcess(h, 1)) killed++;
        CloseHandle(h);
    }
    return killed;
}

/* G2 1 秒扫描：发现 MeshAgent 直接子进程并跟踪，25 秒警告、30 秒强杀。 */
static void lea_g2_watchdog_scan(void) {
    lea_proc_entry_t procs[1024];
    int n = lea_proc_snapshot(procs, 1024);
    if (n < 0) return;
    /* 收集 agent PID（可能多实例）。 */
    DWORD agent_pids[16];
    int agent_n = 0;
    for (int i = 0; i < n && agent_n < 16; i++) {
        const char *base = procs[i].image;
        const char *slash = strrchr(base, '\\');
        if (slash) base = slash + 1;
        if (_stricmp(base, LEA_G2_AGENT_EXE) == 0) agent_pids[agent_n++] = procs[i].pid;
    }
    if (agent_n == 0) return;
    ULONGLONG now = GetTickCount64();
    EnterCriticalSection(&g_lock);
    /* 本轮 seen 清零。 */
    for (int i = 0; i < g_g2_root_count; i++) g_g2_roots[i].seen = 0;
    /* 发现新的直接子进程根。 */
    for (int i = 0; i < n; i++) {
        int is_child = 0;
        for (int a = 0; a < agent_n; a++) if (procs[i].ppid == agent_pids[a]) { is_child = 1; break; }
        if (!is_child) continue;
        if (lea_proc_image_is_excluded(procs[i].image)) continue;
        /* 已在跟踪表里？ */
        int idx = -1;
        for (int k = 0; k < g_g2_root_count; k++)
            if (g_g2_roots[k].pid == procs[i].pid) { idx = k; break; }
        if (idx >= 0) {
            /* PID 复用：创建时间变了即当新根。 */
            if (g_g2_roots[idx].create_time != procs[i].create_time) {
                g_g2_roots[idx].create_time = procs[i].create_time;
                g_g2_roots[idx].first_seen_tick = now;
                g_g2_roots[idx].warned = 0;
            }
            g_g2_roots[idx].seen = 1;
            continue;
        }
        if (g_g2_root_count >= LEA_G2_MAX_ROOTS) continue;
        lea_g2_root_t *r = &g_g2_roots[g_g2_root_count++];
        r->pid = procs[i].pid;
        r->first_seen_tick = now;
        r->create_time = procs[i].create_time;
        r->warned = 0;
        r->seen = 1;
    }
    /* 扫描跟踪表：警告／强杀／清理已退出。 */
    for (int i = 0; i < g_g2_root_count;) {
        lea_g2_root_t *r = &g_g2_roots[i];
        if (!r->seen) {
            /* 已退出：移出表。 */
            g_g2_roots[i] = g_g2_roots[--g_g2_root_count];
            continue;
        }
        ULONGLONG age_ms = now - r->first_seen_tick;
        if (age_ms >= (ULONGLONG)LEA_G2_KILL_SEC * 1000) {
            DWORD pid = r->pid;
            ULONGLONG ct = r->create_time;
            g_g2_roots[i] = g_g2_roots[--g_g2_root_count];
            LeaveCriticalSection(&g_lock);
            int killed = lea_g2_kill_tree(pid, ct);
            EnterCriticalSection(&g_lock);
            svc_log("B1 G2 watchdog kill agent child root pid=%lu killed=%d", (unsigned long)pid, killed);
            lea_audit_event_t ev;
            memset(&ev, 0, sizeof(ev));
            ev.event = "watchdog";
            ev.command = "agent-child-timeout";
            ev.result = "killed";
            ev.detail = "g2-root-30s-kill";
            audit_event(&ev);
            continue;
        }
        if (!r->warned && age_ms >= (ULONGLONG)LEA_G2_WARN_SEC * 1000) {
            r->warned = 1;
            DWORD pid = r->pid;
            LeaveCriticalSection(&g_lock);
            svc_log("B1 G2 watchdog warn agent child pid=%lu age=%llums", (unsigned long)pid, age_ms);
            EnterCriticalSection(&g_lock);
        }
        i++;
    }
    LeaveCriticalSection(&g_lock);
}

/* 看门狗线程：1 秒扫描活动 job 与 G2 agent 子进程；每 5 秒查队列积压。
 * 退出条件：g_stop_event 受信或 g_running 清零。 */
static DWORD WINAPI watchdog_loop(LPVOID unused) {
    (void)unused;
    int tick = 0;
    while (InterlockedCompareExchange(&g_running, 1, 1) == 1) {
        if (g_stop_event) {
            if (WaitForSingleObject(g_stop_event, 1000) != WAIT_TIMEOUT) break;
        } else {
            Sleep(1000);
        }
        if (InterlockedCompareExchange(&g_running, 1, 1) != 1) break;
        tick++;
        lea_watchdog_check_active_job();
        lea_g2_watchdog_scan();
        if (tick % 5 == 0) lea_watchdog_check_backlog();
    }
    return 0;
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
        lea_refresh_local_status(env->command, LEA_ERR_EXPIRED); /* S-021 */
        snprintf(ctx->result_json, sizeof(ctx->result_json), "%s", resp);
        SetEvent(ctx->done);
        lea_ctx_release(ctx);
        return;
    }
    /* RC-02：执行前二次查吊销表——入队后、执行前 Key 被吊销的命令不得
     * 执行（大肥鱼复核：排队命令只在准入时查过一次，离线期间吊销到达后
     * 旧排队命令仍会执行；60 秒信封 TTL 兜底一部分，本检查彻底堵住）。
     * 与 H10 过期预检同款收尾：幂等记 FAILED（终态，不可重试），管道
     * 调用方收到吊销响应。 */
    {
        const char *rcode = lea_revocation_error_code(key_revocation_check(env->api_key_id));
        if (rcode) {
            char resp[LEA_MAX_RESPONSE] = { 0 };
            build_resp(resp, sizeof(resp), 0, rcode, env->request_id, 0,
                               "key-revoked-before-execution", NULL);
            EnterCriticalSection(&g_lock);
            if (item->idem) {
                lea_idem_set_status(&g_idem, item->idem, LEA_IDEM_FAILED, resp, t0);
                idem_persist_locked();
            }
            LeaveCriticalSection(&g_lock);
            audit_for_envelope(env, "execute", "rejected", rcode,
                               (long)(GetTickCount64() - t0_tick),
                               "key-revoked-before-execution");
            lea_refresh_local_status(env->command, rcode); /* S-021 */
            snprintf(ctx->result_json, sizeof(ctx->result_json), "%s", resp);
            SetEvent(ctx->done);
            lea_ctx_release(ctx);
            return;
        }
    }
    const lea_command_spec_t *spec = lea_command_spec(env->command);
    long timeout_ms = lea_effective_timeout_ms(env);
    /* B1：执行器分发前登记活动 job（deadline＝分级强杀时限），看门狗据此强杀。 */
    lea_active_job_begin(env);
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
        /* B1：file.read 不接受 recursive=true（本实现只读单个文件；递归
         * 遍历须走 L2 隔离 lane，当前直接拒绝，不静默当单文件读）。 */
        if (lea_params_has_true(env->params_raw, "recursive")) {
            ok = 0; code = LEA_ERR_PATH_NOT_ALLOWED;
            snprintf(detail, sizeof(detail), "%s", "recursive-not-allowed");
        } else {
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
        } /* B1 recursive else */
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
        /* r11 仪器：给 ush_forward 的 R11-INSTR 行配命令＋请求 id。 */
        svc_log("R11-INSTR dispatch cmd=%s req=%s timeout_ms=%ld",
                env->command, env->request_id, timeout_ms);
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

    /* B1：看门狗／reset 已强杀时改判（执行器返回的“成功／失败”不可信，
     * 进程已被强杀；RESET 表示未执行完、可重试，TIMEOUT 表示超 deadline）。
     * RC-02：吊销强杀改判 KEY_REVOKED（不可重试，命令已因 Key 吊销作废）。 */
    {
        int to = lea_active_job_check_timeout();
        if (to == 3) {
            ok = 0; code = LEA_ERR_KEY_REVOKED;
            snprintf(detail, sizeof(detail), "%s", "key-revoked-during-execution");
            result_json = NULL;
        } else if (to == 2) {
            ok = 0; code = LEA_ERR_RESET;
            snprintf(detail, sizeof(detail), "%s", "reset-by-watchdog-or-sys-reset");
            result_json = NULL;
        } else if (to == 1) {
            ok = 0; code = LEA_ERR_TIMEOUT;
            snprintf(detail, sizeof(detail), "%s", "watchdog-kill-deadline-exceeded");
            result_json = NULL;
        }
    }
    lea_active_job_end();

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
    lea_refresh_local_status(env->command, ok ? "ok" : code); /* S-021 */
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
            /* B1：出队后队列空即清最老等待打点（下次入队重新打点）。 */
            if (!item) g_queue_oldest_tick = 0;
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
    /* RC-01：握手态＋吊销态（诊断用；握手按本信封 epochs 核对）。 */
    char fp[17] = { 0 };
    int hs = 0;
    if (lea_server_pubkey_fingerprint(fp))
        hs = lea_handshake_is_complete(&g_handshake, fp, env->binding_epoch, env->grant_epoch);
    int rev_degraded = g_revocation_degraded;
    LeaveCriticalSection(&g_lock);
    int ush = ush_probe();
    long uptime = (long)(now_unix() - g_started_at);
    snprintf(result, sizeof(result),
             "{\"version\":\"%s\",\"protocol_version\":%d,\"binding_state\":\"%s\","
             "\"account_id\":\"%s\",\"binding_epoch\":%lld,\"queue_depth\":%d,"
             "\"queue_max\":%d,\"ush_available\":%s,\"uptime_s\":%ld,"
             "\"handshake_completed\":%s,\"revocation_state\":\"%s\"}",
             LEA_VERSION_STR, LEA_PROTOCOL_VERSION, bstate, account, epoch,
             qd, LEA_QUEUE_MAX, ush ? "true" : "false", uptime,
             hs ? "true" : "false", rev_degraded ? "degraded" : "ok");
    build_resp(resp, resp_size, 1, LEA_OK, env->request_id, 0, "", result);
}

/* ---------- sys.ping（内联，B1） ---------- */
/* 健康探测：不进队列、不占幂等，L0 短 lane。返回看门狗与队列快照，供
 * 服务端通道健康探测（DEGRADED→RECOVERING 流转）用。 */
static void handle_sys_ping(const lea_envelope_t *env, char *resp, size_t resp_size) {
    char result[1024];
    int active = 0, g2roots = 0, oldest_wait_ms = 0;
    ULONGLONG now_tick = GetTickCount64();
    EnterCriticalSection(&g_lock);
    int qd = lea_queue_total(&g_queue);
    int inflight = g_inflight;
    const char *bstate = lea_bind_state_name(g_binding.state);
    long long epoch = g_binding.epoch;
    active = g_active_job.active;
    g2roots = g_g2_root_count;
    if (g_queue_oldest_tick != 0) oldest_wait_ms = (int)(now_tick - g_queue_oldest_tick);
    LeaveCriticalSection(&g_lock);
    int ush = ush_probe();
    long uptime = (long)(now_unix() - g_started_at);
    snprintf(result, sizeof(result),
             "{\"version\":\"%s\",\"protocol_version\":%d,\"binding_state\":\"%s\","
             "\"binding_epoch\":%lld,\"queue_depth\":%d,\"inflight\":%d,"
             "\"queue_max\":%d,\"active_job\":%s,\"oldest_wait_ms\":%d,"
             "\"g2_roots\":%d,\"ush_available\":%s,\"uptime_s\":%ld}",
             LEA_VERSION_STR, LEA_PROTOCOL_VERSION, bstate, epoch,
             qd, inflight, LEA_B1_QUEUE_MAX, active ? "true" : "false",
             oldest_wait_ms, g2roots, ush ? "true" : "false", uptime);
    build_resp(resp, resp_size, 1, LEA_OK, env->request_id, 0, "", result);
}

/* ---------- sys.reset（内联，B1） ---------- */
/* 执行器重置：杀活动 job 树＋清待执行队列（RESET）。不杀 MeshCentral
 * agent、不重启服务、不重启整机。只认已准入的信封（与 sys.info 同款准入）。 */
static void handle_sys_reset(const lea_envelope_t *env, char *resp, size_t resp_size) {
    int had_active = 0, qd = 0;
    EnterCriticalSection(&g_lock);
    had_active = g_active_job.active;
    qd = lea_queue_total(&g_queue);
    LeaveCriticalSection(&g_lock);
    lea_reset_executor("sys.reset");
    char result[256];
    snprintf(result, sizeof(result),
             "{\"reset\":\"ok\",\"had_active_job\":%s,\"cleared_queued\":%d}",
             had_active ? "true" : "false", qd);
    build_resp(resp, resp_size, 1, LEA_OK, env->request_id, 0, "", result);
}

/* ---------- 内部命令（登录事件／绑定票据／登出） ---------- */
/* ---------- C1：自助绑定内部门支（QFRLEA 只转发票据，不碰 Key 明文） ---------- */
/* 取 USH 响应顶层 "data" 对象原文（含花括号）。USH 响应由
 * ush_build_response 生成，data 在顶层；失败响应无 data 即返回 0。 */
static int ush_response_data(const char *resp, char *out, size_t out_size) {
    if (!resp || !out || out_size < 3) return 0;
    int depth = 0, in_str = 0, esc = 0;
    for (const char *p = resp; *p; p++) {
        char c = *p;
        if (in_str) {
            if (esc) esc = 0;
            else if (c == '\\') esc = 1;
            else if (c == '"') in_str = 0;
            continue;
        }
        if (c == '"') {
            if (depth == 1 && strncmp(p, "\"data\"", 6) == 0) {
                const char *q = p + 6;
                while (*q == ' ' || *q == '\t') q++;
                if (*q != ':') { in_str = 1; continue; }
                q++;
                while (*q == ' ' || *q == '\t') q++;
                if (*q != '{') return 0;
                int d = 0, s2 = 0, e2 = 0;
                const char *start = q;
                for (const char *r = q; *r; r++) {
                    char cc = *r;
                    if (s2) {
                        if (e2) e2 = 0;
                        else if (cc == '\\') e2 = 1;
                        else if (cc == '"') s2 = 0;
                        continue;
                    }
                    if (cc == '"') { s2 = 1; continue; }
                    if (cc == '{') d++;
                    else if (cc == '}') {
                        d--;
                        if (d == 0) {
                            size_t len = (size_t)(r - start + 1);
                            if (len + 1 > out_size) return 0;
                            memcpy(out, start, len);
                            out[len] = '\0';
                            return 1;
                        }
                    }
                }
                return 0;
            }
            in_str = 1;
            continue;
        }
        if (c == '{' || c == '[') depth++;
        else if (c == '}' || c == ']') depth--;
    }
    return 0;
}

/* 自助命令转 USH：读 H03 token 插入命令 JSON 后经 ush_forward 发往
 * USH 管道；USH 响应 ok 时把其 data 对象透传为本命令的 result，
 * 失败时透传 USH 的 code。QFRLEA 不解析、不留存 Key 明文。 */
static void selfbind_forward_ush(const char *ush_cmd_json, long timeout_ms,
                                 char *resp, size_t resp_size) {
    char token[65] = { 0 };
    char env_tok[LEA_MAX_ENVELOPE] = { 0 };
    char ush_resp[LEA_MAX_RESPONSE] = { 0 };
    char udetail[256] = { 0 };
    if (!ush_token_read(token, sizeof(token))) {
        build_resp(resp, resp_size, 0, LEA_ERR_USH_UNAVAILABLE, "", 0, "ush-token-missing", NULL);
        return;
    }
    if (!lea_json_insert_string_field(ush_cmd_json, "ush_token", token,
                                      env_tok, sizeof(env_tok))) {
        build_resp(resp, resp_size, 0, LEA_ERR_INTERNAL, "", 0, "ush-token-insert-failed", NULL);
        return;
    }
    if (!ush_forward(env_tok, timeout_ms, ush_resp, sizeof(ush_resp),
                     udetail, sizeof(udetail))) {
        build_resp(resp, resp_size, 0, LEA_ERR_USH_UNAVAILABLE, "", 0, udetail, NULL);
        svc_log("selfbind ush-forward failed: %s", udetail);
        return;
    }
    int uok = 0;
    if (!lea_ush_response_ok(ush_resp, &uok)) {
        build_resp(resp, resp_size, 0, LEA_ERR_EXEC_FAILED, "", 0, "ush-response-no-ok", NULL);
        return;
    }
    char ush_code[64] = { 0 };
    lea_json_string(ush_resp, "code", ush_code, sizeof(ush_code));
    if (uok) {
        char data[4096] = { 0 };
        if (ush_response_data(ush_resp, data, sizeof(data)))
            build_resp(resp, resp_size, 1, LEA_OK, "", 0, "", data);
        else
            build_resp(resp, resp_size, 1, LEA_OK, "", 0, "", NULL);
    } else {
        build_resp(resp, resp_size, 0,
                   ush_code[0] ? ush_code : LEA_ERR_EXEC_FAILED, "", 0, "", NULL);
    }
}

/* ---------- S-021：本机状态助手 ---------- */
/* 快照：读状态文件（lea_local_status_snapshot），绑定字段为空时用内存
 * 绑定补， 最近命令用内存快照（g_local_*）叠加——文件写盘是 best-effort，
 * 内存值永远最新。调用方须在 g_lock 外调用（内部不加锁，只读 g_binding
 * 时上锁抄出）。 */
static int local_status_snapshot(lea_local_status_t *out) {
    if (!out) return 0;
    if (!lea_local_status_snapshot(g_base_dir, out)) return 0;
    EnterCriticalSection(&g_lock);
    char account[128] = { 0 }, device[128] = { 0 };
    snprintf(account, sizeof(account), "%s", g_binding.account_id);
    snprintf(device, sizeof(device), "%s", g_binding.device_id);
    char lc[32] = { 0 }, lr[64] = { 0 };
    long long lat = g_local_last_command_at;
    snprintf(lc, sizeof(lc), "%s", g_local_last_command);
    snprintf(lr, sizeof(lr), "%s", g_local_last_result);
    LeaveCriticalSection(&g_lock);
    if (!out->account_id[0] && account[0])
        snprintf(out->account_id, sizeof(out->account_id), "%s", account);
    if (!out->device_id[0] && device[0])
        snprintf(out->device_id, sizeof(out->device_id), "%s", device);
    if (lc[0]) {
        snprintf(out->last_command, sizeof(out->last_command), "%s", lc);
        snprintf(out->last_result, sizeof(out->last_result), "%s", lr);
        out->last_command_at = lat;
    }
    return 1;
}

/* 刷新最近命令：更新内存快照并写状态文件（best-effort，写盘失败
 * 不影响执行结果本身）。 */
static void lea_refresh_local_status(const char *last_command, const char *last_result) {
    EnterCriticalSection(&g_lock);
    if (last_command) snprintf(g_local_last_command, sizeof(g_local_last_command), "%s", last_command);
    if (last_result) snprintf(g_local_last_result, sizeof(g_local_last_result), "%s", last_result);
    g_local_last_command_at = now_unix();
    LeaveCriticalSection(&g_lock);
    lea_local_refresh_status(g_base_dir, last_command, last_result, now_unix());
}

/* lea.status 内联处理（信封第 2 步，与 sys.info 同款准入、绕过暂停门）。 */
static void handle_lea_status(const lea_envelope_t *env, char *resp, size_t resp_size) {
    lea_local_status_t st;
    char result[2048];
    if (!local_status_snapshot(&st) ||
        !lea_local_status_to_json(&st, result, sizeof(result))) {
        build_resp(resp, resp_size, 0, LEA_ERR_INTERNAL, env->request_id, 0,
                           "local-status-unavailable", NULL);
        return;
    }
    build_resp(resp, resp_size, 1, LEA_OK, env->request_id, 0, "", result);
}

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
        /* S-021：换号登录清除本机一键撤销标记（旧号撤销不带到新号），并刷新状态。 */
        lea_local_clear_revoke_all(g_base_dir);
        lea_refresh_local_status("session.login_changed", "ok");
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
        lea_refresh_local_status("session.logout", "ok"); /* S-021 */
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
        /* F-05：同一锁内比对票据身份与本机 PENDING 绑定（见
         * lea_binding_confirm）：错账号／错设备的有效签名票据不得激活
         * 本机绑定。期望身份在锁内抄出，供拒绝时审计排障（不记票据
         * 签名原文）。 */
        char expect_account[128] = { 0 }, expect_device[128] = { 0 };
        EnterCriticalSection(&g_lock);
        snprintf(expect_account, sizeof(expect_account), "%s", g_binding.account_id);
        snprintf(expect_device, sizeof(expect_device), "%s", g_binding.device_id);
        int okc = lea_binding_confirm(&g_binding, tk.account_id, tk.device_id, tk.binding_epoch, tk.grant_epoch, tk.grant_muse_execute,
                                      tk.scopes, tk.lease_id, tk.expires_at, tk.signature,
                                      now_unix());
        if (okc) binding_persist_locked();
        long long cur_epoch = g_binding.epoch;
        LeaveCriticalSection(&g_lock);
        if (!okc) {
            build_resp(resp, resp_size, 0, LEA_ERR_BINDING_CHANGED, "", 0,
                               "identity-epoch-or-expiry-mismatch", NULL);
            char detail[640]; /* 4×127 字符身份＋固定文本，须 ＞556 防截断 */
            snprintf(detail, sizeof(detail),
                     "expected account=%s device=%s, ticket account=%s device=%s",
                     expect_account, expect_device, tk.account_id, tk.device_id);
            lea_audit_event_t ev;
            memset(&ev, 0, sizeof(ev));
            ev.event = "binding";
            ev.account_id = tk.account_id;
            ev.device_id = tk.device_id;
            ev.binding_epoch = cur_epoch;
            ev.command = "binding.confirm";
            ev.result = "rejected";
            ev.error_code = LEA_ERR_BINDING_CHANGED;
            ev.detail = detail;
            audit_event(&ev);
            svc_log("binding confirm rejected: expected account=%s device=%s, "
                    "ticket account=%s device=%s", expect_account, expect_device,
                    tk.account_id, tk.device_id);
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
    if (strcmp(cmd, "lea.key_revoked") == 0) {
        /* RC-02：服务端吊销踢出（经 qf-lea-client.exe --internal-b64 下发，
         * 调用方已由 pipe_client_thread 按 H01 验过：安装目录客户端＋
         * 主程序父进程）。
         * 三步：① key_ids 并集合并进本机吊销表（尽力，失败只记日志不阻断
         * 后两步——服务端 H21 推送已是主同步路径）；② 清该 Key 的排队
         * 命令（回 KEY_REVOKED，不可重试）；③ 强杀该 Key 的活动 job
         * （worker 收尾改判 KEY_REVOKED）。 */
        char ids[LEA_REVOKED_MAX_IDS][128];
        int n = lea_json_top_level_string_array(text, "key_ids", ids, LEA_REVOKED_MAX_IDS);
        if (n < 0) {
            build_resp(resp, resp_size, 0, LEA_ERR_BAD_ENVELOPE, "", 0, "key_ids-invalid", NULL);
            return;
        }
        const char *ptrs[LEA_REVOKED_MAX_IDS];
        for (int i = 0; i < n; i++) ptrs[i] = ids[i];
        int merged = lea_revoked_merge(g_revoked_path, ptrs, n);
        if (!merged)
            svc_log("WARN lea.key_revoked merge failed count=%d (queue/job kill continues)", n);
        int cleared = lea_drain_queue_revoked(ptrs, n);
        /* 强杀分真杀／只置标志两档（见 lea_watchdog_kill_active_job_kind）：
         * 只置标志不是“已终止”，响应须如实分开报，不得用 killed 掩盖。 */
        int kill_rc = lea_active_job_kill_revoked(ptrs, n);
        int killed = (kill_rc == 1) ? 1 : 0;
        int marked = (kill_rc == 2) ? 1 : 0;
        lea_audit_event_t ev;
        memset(&ev, 0, sizeof(ev));
        ev.event = "keys";
        ev.command = "lea.key_revoked";
        ev.result = "ok";
        char ev_detail[192];
        snprintf(ev_detail, sizeof(ev_detail),
                 "revoked=%d cleared_queued=%d killed_active=%d marked_active=%d merged=%s",
                 n, cleared, killed, marked, merged ? "yes" : "no");
        ev.detail = ev_detail;
        audit_event(&ev);
        svc_log("lea.key_revoked count=%d cleared_queued=%d killed_active=%d marked_active=%d merged=%d",
                n, cleared, killed, marked, merged);
        char result[192];
        snprintf(result, sizeof(result),
                 "{\"revoked_count\":%d,\"cleared_queued\":%d,\"killed_active\":%d,\"marked_active\":%d,\"merged\":%s}",
                 n, cleared, killed, marked, merged ? "true" : "false");
        build_resp(resp, resp_size, 1, LEA_OK, "", 0, "", result);
        return;
    }
    /* ---------- C1：自助绑定 ---------- */
    if (strcmp(cmd, "selfbind.ush-status") == 0) {
        /* USH 探活：ui.ping 不过会话门（锁屏也能回），只验 H03 token。
         * 5 秒预算：探活只是读 token 文件＋一次管道往返。 */
        selfbind_forward_ush("{\"command\":\"ui.ping\"}", 5000, resp, resp_size);
        return;
    }
    if (strcmp(cmd, "selfbind.clear-credential") == 0) {
        /* 清本机凭据：转 USH 删 DPAPI 凭据文件＋元数据。10 秒预算。 */
        selfbind_forward_ush("{\"command\":\"selfbind.clear-credential\"}", 10000,
                             resp, resp_size);
        return;
    }
    if (strcmp(cmd, "selfbind.status") == 0) {
        /* 本机链接态：转 USH 读元数据（不含凭据）。5 秒预算。 */
        selfbind_forward_ush("{\"command\":\"selfbind.status\"}", 5000, resp, resp_size);
        return;
    }
    if (strcmp(cmd, "selfbind.renew") == 0) {
        /* 静默续期：转 USH（读本机凭据＋设备签名调 renew）。30 秒预算。 */
        char device[128] = { 0 };
        if (!lea_json_top_level_string(text, "device_id", device, sizeof(device)) || !device[0]) {
            build_resp(resp, resp_size, 0, LEA_ERR_BAD_ENVELOPE, "", 0, "selfbind-fields-invalid", NULL);
            return;
        }
        if (strncmp(device, "node//", 6) == 0)
            memmove(device, device + 6, strlen(device + 6) + 1);
        char ush_cmd[512] = { 0 };
        size_t off = 0;
        int okj = 1;
        int _n = snprintf(ush_cmd, sizeof(ush_cmd), "{\"command\":\"selfbind.renew\",\"device_id\":\"");
        if (_n < 0 || (size_t)_n >= sizeof(ush_cmd)) okj = 0;
        else {
            off = (size_t)_n;
            if (!lea_json_escape_into(ush_cmd, sizeof(ush_cmd), &off, device)) okj = 0;
            else if (off + 3 >= sizeof(ush_cmd)) okj = 0;
            else { ush_cmd[off++] = '"'; ush_cmd[off++] = '}'; ush_cmd[off] = '\0'; }
        }
        if (!okj) {
            build_resp(resp, resp_size, 0, LEA_ERR_INTERNAL, "", 0, "selfbind-command-overflow", NULL);
            return;
        }
        selfbind_forward_ush(ush_cmd, 30000, resp, resp_size);
        return;
    }
    if (strcmp(cmd, "selfbind.deliver-ticket") == 0) {
        /* 票据转 USH：主进程已从 SPA 拿到 issue 票据，此处只做字段校验
         * 与 JSON 组装，不碰 Key 明文（明文只在 USH 内出现）。
         * device_id 归一化为裸形（去 node// 前缀）：规范串与绑定台账
         * 键一律用裸形，签名时 USH 同样用裸形入串。 */
        char ticket[256] = { 0 }, challenge[128] = { 0 }, account[128] = { 0 };
        char device[128] = { 0 }, nonce[128] = { 0 }, devname[128] = { 0 };
        char platform[64] = { 0 };
        long long expires_at = 0;
        if (!lea_json_top_level_string(text, "ticket", ticket, sizeof(ticket)) || !ticket[0] ||
            !lea_json_top_level_string(text, "challenge", challenge, sizeof(challenge)) || !challenge[0] ||
            !lea_json_top_level_string(text, "account_id", account, sizeof(account)) || !account[0] ||
            !lea_json_top_level_string(text, "device_id", device, sizeof(device)) || !device[0] ||
            !lea_json_top_level_string(text, "nonce", nonce, sizeof(nonce)) || !nonce[0] ||
            !lea_json_top_level_long(text, "expires_at", &expires_at) || expires_at <= 0) {
            build_resp(resp, resp_size, 0, LEA_ERR_BAD_ENVELOPE, "", 0, "selfbind-fields-invalid", NULL);
            return;
        }
        lea_json_top_level_string(text, "device_name", devname, sizeof(devname));
        lea_json_top_level_string(text, "platform", platform, sizeof(platform));
        char server_base[256] = { 0 };
        lea_json_top_level_string(text, "server_base", server_base, sizeof(server_base));
        if (strncmp(device, "node//", 6) == 0)
            memmove(device, device + 6, strlen(device + 6) + 1);
        /* 组 USH 命令行：字符串逐个转义（设备名可能含引号／反斜杠／中文，
         * 票据／challenge／nonce 只含 [A-Za-z0-9_-] 仍统一走转义）。 */
        char ush_cmd[2048] = { 0 };
        size_t off = 0;
        int okj = 1;
        #define SB_APPEND(...) do { \
            if (off >= sizeof(ush_cmd)) { okj = 0; break; } \
            int _n = snprintf(ush_cmd + off, sizeof(ush_cmd) - off, __VA_ARGS__); \
            if (_n < 0) { okj = 0; break; } \
            off += (size_t)_n; \
            if (off >= sizeof(ush_cmd)) { okj = 0; break; } \
        } while (0)
        #define SB_STR(v) do { \
            if (off + 1 >= sizeof(ush_cmd)) { okj = 0; break; } \
            ush_cmd[off++] = '"'; \
            if (!lea_json_escape_into(ush_cmd, sizeof(ush_cmd), &off, (v))) { okj = 0; break; } \
            if (off + 1 >= sizeof(ush_cmd)) { okj = 0; break; } \
            ush_cmd[off++] = '"'; ush_cmd[off] = '\0'; \
        } while (0)
        SB_APPEND("{\"command\":\"selfbind.deliver-ticket\",\"account_id\":");
        SB_STR(account);
        SB_APPEND(",\"device_id\":");
        SB_STR(device);
        SB_APPEND(",\"params\":{\"ticket\":");
        SB_STR(ticket);
        SB_APPEND(",\"challenge\":");
        SB_STR(challenge);
        SB_APPEND(",\"nonce\":");
        SB_STR(nonce);
        SB_APPEND(",\"device_name\":");
        SB_STR(devname);
        SB_APPEND(",\"platform\":");
        SB_STR(platform);
        SB_APPEND(",\"server_base\":");
        SB_STR(server_base);
        SB_APPEND(",\"expires_at\":%lld}}", expires_at);
        #undef SB_APPEND
        #undef SB_STR
        if (!okj) {
            build_resp(resp, resp_size, 0, LEA_ERR_INTERNAL, "", 0, "selfbind-command-overflow", NULL);
            return;
        }
        /* 30 秒预算：USH 内做 CNG 签名＋一次 WinHTTP 服务端往返。 */
        selfbind_forward_ush(ush_cmd, 30000, resp, resp_size);
        return;
    }
    if (strcmp(cmd, "job.cancel") == 0) {
        /* S-022：取消排队未执行的 job。只认顶层 job_id（调用方传 ACK 里
         * 拿到的 job_id；job_id 缺省等同 request_id）。
         * 排队项＋命令可取消 → 摘队、幂等记 CANCELLED、batch seq 回滚、
         * 唤醒等待方（CANCELLED 响应）；运行中 job → 只记 CANCEL_REQUESTED
         * （继续跑到终态，不强杀）；终态 job → 幂等取消（返回终态）；
         * 查无 → NOT_FOUND；危险命令／已在执行 → NOT_CANCELLABLE。 */
        char job_id[64] = { 0 };
        if (!lea_json_top_level_string(text, "job_id", job_id, sizeof(job_id)) || !job_id[0]) {
            build_resp(resp, resp_size, 0, LEA_ERR_BAD_ENVELOPE, "", 0, "job_id-missing", NULL);
            return;
        }
        lea_queue_item_t *cancel_item = NULL;
        lea_item_ctx_t *cancel_ctx = NULL;
        char cancel_resp[LEA_MAX_RESPONSE] = { 0 };
        char cancel_command[32] = { 0 };
        char cancel_status[32] = { 0 };
        int cancel_kind = 0; /* 0=未找到，1=已取消排队项，2=运行中已记请求，3=终态，4=不可取消 */
        EnterCriticalSection(&g_lock);
        lea_queue_item_t *found = lea_queue_find_by_request_id(&g_queue, job_id);
        if (found) {
            snprintf(cancel_command, sizeof(cancel_command), "%s", found->env.command);
            if (!lea_command_is_cancellable(&found->env)) {
                cancel_kind = 4;
            } else {
                lea_queue_item_t *it = lea_queue_cancel_by_request_id(&g_queue, job_id);
                if (it) {
                    cancel_item = it;
                    cancel_ctx = (lea_item_ctx_t *)it->ctx;
                    if (it->idem) {
                        build_resp(cancel_resp, sizeof(cancel_resp), 0, LEA_ERR_CANCELLED,
                                   it->env.request_id, 0, "cancelled-by-job-cancel", NULL);
                        /* 排队项幂等态为 RUNNING（入队时已置），直接记 CANCELLED；
                         * CANCELLING 只走 CANCEL_REQUESTED→CANCELLING（运行中
                         * 取消请求被执行器接手时），此处不经过。 */
                        lea_idem_mark_cancelled(&g_idem, it->idem, cancel_resp, now_unix());
                    }
                    lea_batch_seq_rollback(&g_batch_seq, it->env.device_id, it->env.account_id,
                                           it->env.batch_id, it->env.seq, it->batch_prev_seq);
                    g_inflight--;
                    if (g_inflight < 0) g_inflight = 0;
                    idem_persist_locked();
                    cancel_kind = 1;
                }
            }
        } else if (g_active_job.active &&
                   (strcmp(g_active_job.request_id, job_id) == 0 ||
                    (g_active_job.job_id[0] && strcmp(g_active_job.job_id, job_id) == 0))) {
            /* 运行中：不强杀。危险性以幂等条目为准（含 params.dangerous 的
             * ui.* 在入队时已按 params 判定过危险并记在条目上）。 */
            snprintf(cancel_command, sizeof(cancel_command), "%s", g_active_job.command);
            lea_idem_entry_t *aide = lea_idem_lookup_by_job(&g_idem, job_id);
            const lea_command_spec_t *aspec = lea_command_spec(g_active_job.command);
            int acancel = aspec && aspec->executor != LEA_EXEC_INLINE &&
                          !(aide && aide->dangerous);
            if (!acancel) {
                cancel_kind = 4;
            } else if (!aide) {
                cancel_kind = 4; /* 活动 job 无幂等条目（不应发生），fail-closed */
            } else if (aide->status == LEA_IDEM_CANCEL_REQUESTED) {
                cancel_kind = 2; /* 已记过请求，幂等成功 */
            } else if (lea_idem_request_cancel(&g_idem, aide, now_unix())) {
                idem_persist_locked();
                cancel_kind = 2;
            } else {
                cancel_kind = 4; /* 状态已变（竞态），按不可取消回 */
            }
        } else {
            lea_idem_entry_t *e = lea_idem_lookup_by_job(&g_idem, job_id);
            if (e) {
                cancel_kind = 3;
                snprintf(cancel_status, sizeof(cancel_status), "%s", lea_idem_status_name(e->status));
                snprintf(cancel_command, sizeof(cancel_command), "%s", e->command);
            } else {
                cancel_kind = 0;
            }
        }
        LeaveCriticalSection(&g_lock);
        /* 放锁后唤醒被取消项的等待方（同 reset 清队口径：填 CANCELLED 响应）。 */
        if (cancel_item && cancel_ctx) {
            if (!cancel_resp[0]) {
                build_resp(cancel_resp, sizeof(cancel_resp), 0, LEA_ERR_CANCELLED,
                           cancel_item->env.request_id, 0, "cancelled-by-job-cancel", NULL);
            }
            snprintf(cancel_ctx->result_json, sizeof(cancel_ctx->result_json), "%s", cancel_resp);
            SetEvent(cancel_ctx->done);
            lea_ctx_release(cancel_ctx);
            lea_queue_item_free(cancel_item);
        }
        /* job_id 进 JSON 前转义（调用方传入，未必是 token 字符集）。 */
        char jid_esc[128] = { 0 };
        size_t joff = 0;
        if (!lea_json_escape_into(jid_esc, sizeof(jid_esc), &joff, job_id)) {
            build_resp(resp, resp_size, 0, LEA_ERR_INTERNAL, "", 0, "job-id-escape-failed", NULL);
            return;
        }
        if (cancel_kind == 1) {
            char result[256] = { 0 };
            snprintf(result, sizeof(result),
                     "{\"job_id\":\"%s\",\"status\":\"CANCELLED\",\"command\":\"%s\"}",
                     jid_esc, cancel_command);
            build_resp(resp, resp_size, 1, LEA_OK, "", 0, "", result);
            svc_log("job.cancel cancelled job=%s command=%s", job_id, cancel_command);
        } else if (cancel_kind == 2) {
            char result[256] = { 0 };
            snprintf(result, sizeof(result),
                     "{\"job_id\":\"%s\",\"status\":\"CANCEL_REQUESTED\",\"command\":\"%s\"}",
                     jid_esc, cancel_command);
            build_resp(resp, resp_size, 1, LEA_OK, "", 0, "", result);
            svc_log("job.cancel cancel-requested job=%s command=%s", job_id, cancel_command);
        } else if (cancel_kind == 3) {
            char result[256] = { 0 };
            snprintf(result, sizeof(result),
                     "{\"job_id\":\"%s\",\"status\":\"%s\",\"command\":\"%s\",\"cancelled\":false}",
                     jid_esc, cancel_status, cancel_command);
            build_resp(resp, resp_size, 1, LEA_OK, "", 0, "already-terminal", result);
            svc_log("job.cancel already-terminal job=%s status=%s", job_id, cancel_status);
        } else if (cancel_kind == 4) {
            build_resp(resp, resp_size, 0, LEA_ERR_NOT_CANCELLABLE, "", 0,
                       "command-not-cancellable-or-already-running", NULL);
            svc_log("job.cancel not-cancellable job=%s command=%s", job_id, cancel_command);
        } else {
            build_resp(resp, resp_size, 0, LEA_ERR_NOT_FOUND, "", 0, "job-not-found", NULL);
        }
        return;
    }
    if (strcmp(cmd, "job.query") == 0) {
        /* S-022：查 job 状态。排队 → RECEIVED，活动 → RUNNING，幂等表 →
         * 终态／取消态（含缓存响应），查无 → NOT_FOUND。 */
        char job_id[64] = { 0 };
        if (!lea_json_top_level_string(text, "job_id", job_id, sizeof(job_id)) || !job_id[0]) {
            build_resp(resp, resp_size, 0, LEA_ERR_BAD_ENVELOPE, "", 0, "job_id-missing", NULL);
            return;
        }
        char qstatus[32] = { 0 }, qcommand[32] = { 0 };
        char qcached[LEA_MAX_RESPONSE] = { 0 };
        int qfound = 0, qcancellable = 0, qcancel_requested = 0;
        EnterCriticalSection(&g_lock);
        lea_queue_item_t *found = lea_queue_find_by_request_id(&g_queue, job_id);
        if (found) {
            qfound = 1;
            snprintf(qstatus, sizeof(qstatus), "%s", "RECEIVED");
            snprintf(qcommand, sizeof(qcommand), "%s", found->env.command);
            qcancellable = lea_command_is_cancellable(&found->env);
        } else if (g_active_job.active &&
                   (strcmp(g_active_job.request_id, job_id) == 0 ||
                    (g_active_job.job_id[0] && strcmp(g_active_job.job_id, job_id) == 0))) {
            qfound = 1;
            snprintf(qstatus, sizeof(qstatus), "%s", "RUNNING");
            snprintf(qcommand, sizeof(qcommand), "%s", g_active_job.command);
            lea_idem_entry_t *aide = lea_idem_lookup_by_job(&g_idem, job_id);
            const lea_command_spec_t *aspec = lea_command_spec(g_active_job.command);
            qcancellable = aspec && aspec->executor != LEA_EXEC_INLINE &&
                           !(aide && aide->dangerous);
            qcancel_requested = (aide && aide->status == LEA_IDEM_CANCEL_REQUESTED) ? 1 : 0;
        } else {
            lea_idem_entry_t *e = lea_idem_lookup_by_job(&g_idem, job_id);
            if (e) {
                qfound = 1;
                snprintf(qstatus, sizeof(qstatus), "%s", lea_idem_status_name(e->status));
                snprintf(qcommand, sizeof(qcommand), "%s", e->command);
                qcancel_requested = (e->status == LEA_IDEM_CANCEL_REQUESTED) ? 1 : 0;
                if (e->result[0]) snprintf(qcached, sizeof(qcached), "%s", e->result);
            }
        }
        LeaveCriticalSection(&g_lock);
        if (!qfound) {
            build_resp(resp, resp_size, 0, LEA_ERR_NOT_FOUND, "", 0, "job-not-found", NULL);
            return;
        }
        char jid_esc[128] = { 0 };
        size_t joff = 0;
        char result[LEA_MAX_RESPONSE] = { 0 };
        if (!lea_json_escape_into(jid_esc, sizeof(jid_esc), &joff, job_id)) {
            build_resp(resp, resp_size, 0, LEA_ERR_INTERNAL, "", 0, "job-id-escape-failed", NULL);
            return;
        }
        int n = 0;
        if (qcached[0]) {
            /* 终态缓存响应原样附后（idem 缓存写时已去尾换行，合法 JSON）。 */
            n = snprintf(result, sizeof(result),
                         "{\"job_id\":\"%s\",\"status\":\"%s\",\"command\":\"%s\","
                         "\"cancellable\":%s,\"cancel_requested\":%s,\"cached_result\":%s}",
                         jid_esc, qstatus, qcommand,
                         qcancellable ? "true" : "false",
                         qcancel_requested ? "true" : "false", qcached);
        } else {
            n = snprintf(result, sizeof(result),
                         "{\"job_id\":\"%s\",\"status\":\"%s\",\"command\":\"%s\","
                         "\"cancellable\":%s,\"cancel_requested\":%s}",
                         jid_esc, qstatus, qcommand,
                         qcancellable ? "true" : "false",
                         qcancel_requested ? "true" : "false");
        }
        if (n < 0 || (size_t)n >= sizeof(result)) {
            build_resp(resp, resp_size, 0, LEA_ERR_INTERNAL, "", 0, "job-query-result-overflow", NULL);
            return;
        }
        build_resp(resp, resp_size, 1, LEA_OK, "", 0, "", result);
        return;
    }
    /* S-021：本机控制命令（只走本地管道：调用方已由 pipe_client_thread
     * 按 H01 验过安装目录客户端＋主程序父进程；不走信封验签、不进队列）。
     * 读状态（lea.status）与改状态（暂停／撤销／授权）都在此。 */
    if (strcmp(cmd, "lea.status") == 0) {
        lea_local_status_t st;
        char result[2048];
        if (!local_status_snapshot(&st) ||
            !lea_local_status_to_json(&st, result, sizeof(result))) {
            build_resp(resp, resp_size, 0, LEA_ERR_INTERNAL, "", 0,
                               "local-status-unavailable", NULL);
            return;
        }
        build_resp(resp, resp_size, 1, LEA_OK, "", 0, "", result);
        return;
    }
    if (strcmp(cmd, "lea.pause") == 0) {
        if (!lea_local_set_paused(g_base_dir, 1)) {
            build_resp(resp, resp_size, 0, LEA_ERR_INTERNAL, "", 0, "pause-failed", NULL);
            return;
        }
        lea_refresh_local_status("lea.pause", "ok");
        build_resp(resp, resp_size, 1, LEA_OK, "", 0, "", "{\"paused\":true}");
        return;
    }
    if (strcmp(cmd, "lea.resume") == 0) {
        if (!lea_local_set_paused(g_base_dir, 0)) {
            build_resp(resp, resp_size, 0, LEA_ERR_INTERNAL, "", 0, "resume-failed", NULL);
            return;
        }
        lea_refresh_local_status("lea.resume", "ok");
        build_resp(resp, resp_size, 1, LEA_OK, "", 0, "", "{\"paused\":false}");
        return;
    }
    if (strcmp(cmd, "lea.revoke-all-keys") == 0) {
        if (!lea_local_set_revoke_all(g_base_dir, 1)) {
            build_resp(resp, resp_size, 0, LEA_ERR_INTERNAL, "", 0, "revoke-failed", NULL);
            return;
        }
        lea_refresh_local_status("lea.revoke-all-keys", "ok");
        build_resp(resp, resp_size, 1, LEA_OK, "", 0, "", "{\"revoked_all\":true}");
        return;
    }
    if (strcmp(cmd, "lea.authorize-dangerous") == 0) {
        if (!lea_local_set_dangerous_consent(g_base_dir, 1)) {
            build_resp(resp, resp_size, 0, LEA_ERR_INTERNAL, "", 0, "authorize-failed", NULL);
            return;
        }
        lea_refresh_local_status("lea.authorize-dangerous", "ok");
        build_resp(resp, resp_size, 1, LEA_OK, "", 0, "", "{\"dangerous_consented\":true}");
        return;
    }
    if (strcmp(cmd, "lea.revoke-dangerous-consent") == 0) {
        if (!lea_local_set_dangerous_consent(g_base_dir, 0)) {
            build_resp(resp, resp_size, 0, LEA_ERR_INTERNAL, "", 0, "revoke-consent-failed", NULL);
            return;
        }
        lea_refresh_local_status("lea.revoke-dangerous-consent", "ok");
        build_resp(resp, resp_size, 1, LEA_OK, "", 0, "", "{\"dangerous_consented\":false}");
        return;
    }
    build_resp(resp, resp_size, 0, LEA_ERR_BAD_ENVELOPE, "", 0, "unknown-internal-cmd", NULL);
}

/* ---------- 信封处理（管道线程） ---------- */
static void handle_envelope(const char *text, char *resp, size_t resp_size, HANDLE pipe) {
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
     * 规范串 v2（CANONICAL-SIGNING-V2.md §2）：20 行，覆盖全部关键字段
     * （batch_id／seq／account_id／api_key_id／timeout_ms／params 哈希
     * ／grant_epoch）。验签对象是解析后重建的规范串，不是收到的原文
     * ——解析字段与验签字段必须一致。 */
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
    /* 1.5 RC-01 握手门：验签后、任何业务命令前。
     *   - sys.handshake 自身：同款准入（绑定／epoch／授权＋吊销三态）＋
     *     params 校验（指纹须等于本机编译期公钥指纹、protocol_version 须
     *     为 2）后标记完成；任一失败即拒绝，不标记。
     *   - sys.ping 健康探针只读、无执行，免于此门（B1 自愈探测须能过；
     *     仍过验签＋准入）。
     *   - 其余命令握手未完成即回 HANDSHAKE_REQUIRED，不入队、不执行、
     *     不占重放／幂等；服务端凭此码重握一次再重试（见 lea-core.js）。
     *   --internal 本地控制命令不在此门内（另见 handle_internal，本地
     *   SYSTEM 起源、按进程身份鉴权）。 */
    if (strcmp(env.command, "sys.handshake") == 0) {
        EnterCriticalSection(&g_lock);
        char herr[64] = { 0 };
        int hadmitted = lea_admit(&env, &g_binding, NULL, 0, herr, sizeof(herr));
        LeaveCriticalSection(&g_lock);
        if (hadmitted) {
            const char *rcode = lea_revocation_error_code(key_revocation_check(env.api_key_id));
            if (rcode) {
                hadmitted = 0;
                snprintf(herr, sizeof(herr), "%s", rcode);
            }
        }
        if (!hadmitted) {
            build_resp(resp, resp_size, 0, herr, env.request_id,
                               lea_error_retryable(herr), "", NULL);
            audit_for_envelope(&env, "admit-reject", "rejected", herr, 0, "");
            return;
        }
        char fp[17] = { 0 };
        char pfp[128] = { 0 };
        long long pver = -1;
        int fp_ok = lea_server_pubkey_fingerprint(fp);
        int params_ok = lea_json_string(env.params_raw, "server_pubkey_fp", pfp, sizeof(pfp)) &&
                        lea_json_long(env.params_raw, "protocol_version", &pver) &&
                        lea_handshake_check_params(fp_ok ? fp : "", pfp, pver);
        if (!params_ok) {
            build_resp(resp, resp_size, 0, LEA_ERR_BAD_ENVELOPE, env.request_id, 0,
                               "handshake-params-mismatch", NULL);
            audit_for_envelope(&env, "admit-reject", "rejected", LEA_ERR_BAD_ENVELOPE, 0,
                               "handshake-params-mismatch");
            svc_log("REJECT handshake params request=%s", env.request_id);
            return;
        }
        EnterCriticalSection(&g_lock);
        lea_handshake_mark_complete(&g_handshake, fp, env.binding_epoch, env.grant_epoch);
        LeaveCriticalSection(&g_lock);
        build_resp(resp, resp_size, 1, LEA_OK, env.request_id, 0, "", "{\"handshake\":\"ok\"}");
        audit_for_envelope(&env, "handshake", "ok", "", 0, "");
        svc_log("handshake completed device=%s binding_epoch=%lld grant_epoch=%lld",
                env.device_id, env.binding_epoch, env.grant_epoch);
        return;
    }
    if (strcmp(env.command, "sys.ping") != 0) {
        char fp[17] = { 0 };
        int complete = 0;
        if (lea_server_pubkey_fingerprint(fp)) {
            EnterCriticalSection(&g_lock);
            complete = lea_handshake_is_complete(&g_handshake, fp, env.binding_epoch, env.grant_epoch);
            LeaveCriticalSection(&g_lock);
        }
        if (!complete) {
            /* RC-01：被拒信封也要占重放表（防“先拒后重放”：已验签的旧信
             * 封在握手完成后被再次提交——信封有 60 秒 TTL，单次占表即堵
             * 住该窗口；未过验签的信封不占表，防伪造占表 DoS）。
             * 服务端重试一律用全新信封（新 request_id／nonce，复用幂等
             * 键），不受影响。 */
            EnterCriticalSection(&g_lock);
            lea_replay_check_and_add(&g_replay, env.request_id, env.nonce, t0);
            LeaveCriticalSection(&g_lock);
            build_resp(resp, resp_size, 0, LEA_ERR_HANDSHAKE_REQUIRED, env.request_id, 0,
                               "handshake-required", NULL);
            audit_for_envelope(&env, "admit-reject", "rejected", LEA_ERR_HANDSHAKE_REQUIRED, 0,
                               "handshake-required");
            return;
        }
    }
    /* 2. sys.info／sys.ping／sys.reset／lea.status 内联，不进队列／不占幂等。 */
    if (strcmp(env.command, "sys.info") == 0 || strcmp(env.command, "sys.ping") == 0 ||
        strcmp(env.command, "sys.reset") == 0 || strcmp(env.command, "lea.status") == 0) {
        /* 三者同样要过准入（未绑定时返回 NOT_BOUND；Key 已吊销也拒绝）。
         * F-01 三态（lea_revocation_error_code，单测覆盖）：仅 NOT_REVOKED
         * 放行；REVOKED → KEY_REVOKED；ERROR → REVOCATION_UNAVAILABLE。 */
        EnterCriticalSection(&g_lock);
        char err[64] = { 0 };
        int admitted = lea_admit(&env, &g_binding, NULL, 0, err, sizeof(err));
        LeaveCriticalSection(&g_lock);
        if (admitted) {
            const char *rcode = lea_revocation_error_code(key_revocation_check(env.api_key_id));
            if (rcode) {
                admitted = 0;
                snprintf(err, sizeof(err), "%s", rcode);
            }
        }
        if (!admitted) {
            build_resp(resp, resp_size, 0, err, env.request_id,
                               lea_error_retryable(err), "", NULL);
            audit_for_envelope(&env, "admit-reject", "rejected", err, 0, "");
            return;
        }
        if (strcmp(env.command, "sys.ping") == 0) {
            handle_sys_ping(&env, resp, resp_size);
        } else if (strcmp(env.command, "sys.reset") == 0) {
            handle_sys_reset(&env, resp, resp_size);
        } else if (strcmp(env.command, "lea.status") == 0) {
            /* S-021：与 sys.info 同款准入，绕过暂停门（暂停时仍可查状态）。 */
            handle_lea_status(&env, resp, resp_size);
        } else {
            handle_sys_info(&env, resp, resp_size);
        }
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
    /* 4. 准入（绑定／设备／epoch／授权／scope）；Key 吊销另查本地吊销文件。
     * F-01 三态：仅 NOT_REVOKED 放行；REVOKED → KEY_REVOKED；
     * ERROR → REVOCATION_UNAVAILABLE（见 lea_revocation_error_code）。 */
    EnterCriticalSection(&g_lock);
    char err[64] = { 0 };
    int admitted = lea_admit(&env, &g_binding, NULL, 0, err, sizeof(err));
    LeaveCriticalSection(&g_lock);
    if (admitted) {
        const char *rcode = lea_revocation_error_code(key_revocation_check(env.api_key_id));
        if (rcode) {
            admitted = 0;
            snprintf(err, sizeof(err), "%s", rcode);
        }
    }
    if (!admitted) {
        build_resp(resp, resp_size, 0, err, env.request_id,
                           lea_error_retryable(err), "", NULL);
        audit_for_envelope(&env, "admit-reject", "rejected", err, 0, "");
        svc_log("REJECT admit request=%s code=%s", env.request_id, err);
        return;
    }
    /* 4.4 S-021：本机暂停门＋危险授权门（在幂等／入队之前；lea.status
     * 已在第 2 步内联处理，不到此处，故暂停时仍可查状态）。 */
    if (lea_local_is_paused(g_base_dir)) {
        build_resp(resp, resp_size, 0, LEA_ERR_PAUSED, env.request_id, 0,
                           "local-paused", NULL);
        audit_for_envelope(&env, "admit-reject", "rejected", LEA_ERR_PAUSED, 0,
                           "local-paused");
        svc_log("REJECT paused request=%s", env.request_id);
        return;
    }
    if (lea_command_is_dangerous(&env) && !lea_local_has_dangerous_consent(g_base_dir)) {
        build_resp(resp, resp_size, 0, LEA_ERR_SCOPE_DENIED, env.request_id, 0,
                           "dangerous-consent-required", NULL);
        audit_for_envelope(&env, "admit-reject", "rejected", LEA_ERR_SCOPE_DENIED, 0,
                           "dangerous-consent-required");
        svc_log("REJECT dangerous-consent-required request=%s command=%s",
                env.request_id, env.command);
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
    /* S-022：job 查询用——条目记 request_id／job_id／command（新条目才填，
     * 重复提交不覆盖首次记录；旧条目此三字段为空，查询时回 not-found）。 */
    if (idem->request_id[0] == '\0') {
        snprintf(idem->request_id, sizeof(idem->request_id), "%s", env.request_id);
        snprintf(idem->job_id, sizeof(idem->job_id), "%s", env.job_id[0] ? env.job_id : env.request_id);
        snprintf(idem->command, sizeof(idem->command), "%s", env.command);
    }
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
    item->batch_prev_seq = batch_prev_seq; /* B1：reset 清队时回滚 batch seq 用 */
    char qerr[64] = { 0 };
    /* B1：队列准入（在队＋在执行合计 ≤8）。满即回 QUEUE_FULL（沿用既有
     * 队列满路径：batch seq 回滚＋幂等回 RECEIVED），不入队；100 条容量
     * 上限几乎到不了，8 条准入是绑定约束。 */
    if (!lea_queue_admit_ok(lea_queue_total(&g_queue) + g_inflight) ||
        !lea_queue_enqueue(&g_queue, item, qerr, sizeof(qerr))) {
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
    if (g_queue_oldest_tick == 0) g_queue_oldest_tick = GetTickCount64(); /* B1：队空→非空，打点 */
    LeaveCriticalSection(&g_lock);
    SetEvent(g_queue_event);
    /* B1：入队成功即回 ACK 行（客户端 2 秒 ACK 时限；同步命令再等结果行，
     * 异步命令收到 ACK 即退出）。ACK 写失败（客户端已断开）不影响执行。 */
    {
        char ack[LEA_MAX_RESPONSE] = { 0 };
        char ack_result[192] = { 0 };
        const char *jid = env.job_id[0] ? env.job_id : env.request_id;
        snprintf(ack_result, sizeof(ack_result), "{\"job_id\":\"%s\"}", jid);
        build_resp(ack, sizeof(ack), 1, "QFR_LEA_ACCEPTED", env.request_id, 0,
                   "queued", ack_result);
        pipe_write_all(pipe, ack, strlen(ack));
    }
    /* B1：异步模式（L2 长命令）发 ACK 后即返，不等执行完成。纵深防御：
     * 只有 tier==L2（长命令）才认 async；L0／L1 信封纵写 async 也强制
     * 同步（防信封被改写后把短命令变异步、绕过结果等待）。 */
    if (env.mode[0] && strcmp(env.mode, "async") == 0 &&
        lea_command_tier(env.command) == LEA_TIER_LONG) {
        lea_ctx_release(ctx);
        return;
    }
    /* 7. 等执行完成（按 timeout_ms；超时则回 timeout，任务继续跑，幂等表留终态）。 */
    long timeout_ms = lea_effective_timeout_ms(&env);
    DWORD w = WaitForSingleObject(ctx->done, (DWORD)timeout_ms);
    if (w == WAIT_TIMEOUT) {
        /* S-022：超时即结果未知；危险命令禁止重复提交（新 key 重发会再执行
         * 一次副作用）。同幂等键重查仍安全（RUNNING 回 DUPLICATE，终态回缓存）。 */
        const char *tjid = env.job_id[0] ? env.job_id : env.request_id;
        char result[256];
        snprintf(result, sizeof(result),
                 "{\"job_id\":\"%s\",\"result_unknown\":true,\"do_not_resubmit\":%s}",
                 tjid, dangerous ? "true" : "false");
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
            handle_envelope(buf, resp, sizeof(resp), pipe);
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
    lea_handshake_init(&g_handshake); /* RC-01：握手态初始为未完成 */
    lea_batch_seq_init(&g_batch_seq);
    g_queue_event = CreateEventW(NULL, FALSE, FALSE, NULL);
    ensure_dirs();
    binding_load();
    revocation_startup_init(); /* F-01：吊销表启动初始化（条件式，见上） */
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
    /* B1：看门狗线程（1 秒循环，活动 job 超 deadline 强杀、积压清队、
     * G2 MeshCentral agent 子进程树扫描）。 */
    g_watchdog_thread = CreateThread(NULL, 0, watchdog_loop, NULL, 0, NULL);
    if (!g_watchdog_thread) svc_log("WARN watchdog thread start failed");
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
    if (g_watchdog_thread) WaitForSingleObject(g_watchdog_thread, 5000); /* B1 */
    EnterCriticalSection(&g_lock);
    idem_persist_locked();
    LeaveCriticalSection(&g_lock);
    report_status(SERVICE_STOPPED, 0);
    svc_log("SERVICE stopped");
}

/* X-01：显式迁移工具（管理员手动跑，须管理员权限——写 ProgramData 状态
 * 文件＋设 SYSTEM／Administrators ACL；非管理员时写盘／ACL 失败即报错）。
 * 用法：QFRLEA.exe --migrate-revoked [--generation N] [--accept-empty]
 *   --generation N：写入的世代（缺省 1，须 ≥1；应与服务端／备份的真实
 *     世代一致；下次服务端同步世代更高时向上纠正）。
 *   --accept-empty：0 字节文件须显式确认才按空表迁移（大肥鱼复核：0 字
 *     节不能自证“旧版从未吊销过”，崩溃截断／磁盘损坏／清空都可能产生
 *     0 字节；无此旗时 0 字节文件拒绝迁移）。
 * 前置：.gen 已存在时拒绝覆盖；快照须通过严格校验（空文件是唯一例外：
 * 旧版从未吊销过任何 Key 时表就是空的——文件存在且 0 字节、且带
 * --accept-empty 时才按合法空表迁移；文件缺失／内容损坏一律拒绝，须从
 * 备份恢复）；迁移成功写 .gen＋标记（同款 ACL）并记日志；失败不写残集。
 * 服务正在跑时也可迁移：下次吊销检查通过即自动脱离 DEGRADED，无需重启。 */
static int lea_migrate_revoked_cmd(int argc, char **argv) {
    ensure_dirs();
    long long generation = 1;
    int accept_empty = 0;
    for (int i = 2; i < argc; i++) {
        if (strcmp(argv[i], "--accept-empty") == 0) {
            accept_empty = 1;
        } else if (strcmp(argv[i], "--generation") == 0) {
            if (i + 1 >= argc) {
                fprintf(stderr, "usage: QFRLEA.exe --migrate-revoked [--generation N] [--accept-empty]\n");
                return 2;
            }
            char *end = NULL;
            generation = strtoll(argv[++i], &end, 10);
            if (!end || *end != '\0' || generation < 1) {
                fprintf(stderr, "--generation must be an integer >= 1\n");
                return 2;
            }
        } else {
            fprintf(stderr, "usage: QFRLEA.exe --migrate-revoked [--generation N] [--accept-empty]\n");
            return 2;
        }
    }
    char gen_path[MAX_PATH] = { 0 };
    if (!lea_revoked_gen_path(g_revoked_path, gen_path, sizeof(gen_path))) {
        fprintf(stderr, "cannot derive generation path\n");
        return 1;
    }
    FILE *gf = fopen(gen_path, "rb");
    if (gf) {
        fclose(gf);
        fprintf(stderr, "generation file already exists, refusing to overwrite\n");
        return 1;
    }
    long long snap = -1;
    if (!lea_revoked_validate_snapshot(g_revoked_path, 0, 1, &snap)) {
        /* 唯一例外：文件存在且 0 字节＝旧版从未吊销过的合法空表——但 0 字
         * 节不能自证（截断／损坏／清空都可能产生），须管理员显式带
         * --accept-empty 确认才迁移（大肥鱼复核）；无此旗即拒绝。 */
        FILE *f = fopen(g_revoked_path, "rb");
        int empty = 0;
        if (f) {
            fseek(f, 0, SEEK_END);
            empty = (ftell(f) == 0);
            fclose(f);
        }
        if (!empty || !accept_empty) {
            fprintf(stderr, "revoked snapshot failed strict validation, refusing to migrate (restore from backup)%s\n",
                    empty ? " (0-byte file: pass --accept-empty to migrate it as an empty table)" : "");
            return 1;
        }
        svc_log("migrate-revoked: legacy snapshot is empty (no keys ever revoked), migrating as empty table (explicit --accept-empty)");
    }
    if (!revoked_migrate_legacy_snapshot_gen(generation)) {
        fprintf(stderr, "migration failed (generation/marker write or ACL failed)\n");
        return 1;
    }
    svc_log("revoked table migrated explicitly to generation %lld", generation);
    printf("revoked table migrated to generation %lld\n", generation);
    return 0;
}

int main(int argc, char **argv) {
    /* S-021：本机控制子命令只认本地命令行，在服务启动前分流——服务
     * 运行时收不到它们，命名管道／LEA API／qf-lea-client 也调不到它们。
     * CLI 直接读写 %ProgramData%\QFR\LEA 下状态文件。 */
    if (argc > 1 && lea_is_local_control_subcommand(argv[1])) {
        return lea_local_cli(argc, argv, NULL);
    }
    /* A1（2026-11-13）：首装服务子命令只认本地命令行，在
     * StartServiceCtrlDispatcherW 之前分流——服务运行时收不到它们，
     * 命名管道／LEA API／qf-lea-client 也调不到它们（白名单不加）。
     * binPath 只取本 exe 所在目录，不接受调用方传入路径。 */
    if (argc > 1 && lea_is_service_subcommand(argv[1])) {
        if (strcmp(argv[1], "--install-service") == 0) {
            int repair = (argc > 2 && strcmp(argv[2], "--repair") == 0);
            return lea_service_install(repair);
        }
        if (strcmp(argv[1], "--repair") == 0)
            return lea_service_install(1);
        if (strcmp(argv[1], "--uninstall-service") == 0)
            return lea_service_uninstall();
        if (strcmp(argv[1], "--verify-manifest") == 0) {
            if (argc < 4) {
                fprintf(stderr, "usage: QFRLEA.exe --verify-manifest <dir> <manifest>\n");
                return 2;
            }
            return lea_verify_manifest(argv[2], argv[3]);
        }
        if (strcmp(argv[1], "--migrate-revoked") == 0)
            return lea_migrate_revoked_cmd(argc, argv);
        return 2;
    }
    if (argc > 1 && strcmp(argv[1], "debug") == 0) {
        g_stop_event = CreateEventW(NULL, TRUE, FALSE, NULL);
        lea_service_init();
        svc_log("DEBUG mode start");
        HANDLE worker = CreateThread(NULL, 0, worker_loop, NULL, 0, NULL);
        g_watchdog_thread = CreateThread(NULL, 0, watchdog_loop, NULL, 0, NULL); /* B1 */
        pipe_loop(NULL);
        if (worker) WaitForSingleObject(worker, 5000);
        if (g_watchdog_thread) WaitForSingleObject(g_watchdog_thread, 5000); /* B1 */
        return 0;
    }
    SERVICE_TABLE_ENTRYW table[] = {
        { (LPWSTR)SERVICE_NAME_W, service_main },
        { NULL, NULL }
    };
    if (!StartServiceCtrlDispatcherW(table)) {
        fprintf(stderr, "QFRLEA is a Windows service. Install with: QFRLEA.exe --install-service (run as administrator).\n");
        return 1;
    }
    return 0;
}
