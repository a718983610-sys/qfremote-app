/* QFUserHelper (USH) —— QFR 本地代理的用户会话助手（Stage 1 MVP）
 * =================================================================
 * 运行位置：用户登录会话内，当前登录用户权限，随登录启动
 * （计划任务 QFRLEA User Helper，见 register-ush.ps1；主程序兜底拉起由安装线接）。
 * 通道：命名管道 \\.\pipe\QFR\LEA\UserHelper\v1，一行 JSON 请求 → 一行 JSON 响应。
 * 多会话限制（P1-2，2026-11-17 v2，文档口径）：管道名是机器全局单名，
 * 首个启动的 USH 独占；后起会话的 USH 建管道失败、探活成功即整进程
 * 退出（见下“单实例”）。故多会话下 UI 命令／自助绑定仅第一个 USH
 * 所在会话可用，其余会话的转发因 token 对不上 USH 内存 token 而
 * fail-closed，不静默错发到别的会话。单用户部署不受影响。
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
#include <aclapi.h> /* SetNamedSecurityInfoW／SE_FILE_OBJECT（token 文件级 DACL） */
#include <bcrypt.h>
#include <wtsapi32.h> /* ProcessIdToSessionId（取自身会话 id，H03 第三轮） */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "ush_json.h"
#include "ush_log.h"
#include "ush_uia.h"
#include "ush_snapshot.h"
#include "ush_selfbind.h" /* C1：自助绑定（设备签名调 complete 换凭据） */
#include "../lea/lea_instance.h" /* A+：实例身份（生产／TEST）唯一来源 */

#define USH_VERSION "1.0.0-mvp"
/* A+：USH 管道名取自实例身份。生产：\\.\pipe\QFR\LEA\UserHelper\v1；
 * TEST：\\.\pipe\QFR\LEA-TEST\UserHelper\v1，与生产管道彻底分开。 */
#define PIPE_NAME_W LEA_USH_PIPE_NAME_W
#define PIPE_SDDL L"D:(A;;GA;;;SY)(A;;GA;;;BA)"

static volatile LONG g_running = 1;
static HANDLE g_stop_event = NULL;

/* ---------- H03：每启动随机 token ＋ 调用方鉴别 ---------- */
/* token：32 字节 BCryptGenRandom → 64 位小写 hex，存在内存（g_ush_token），
 * 同时写入 %ProgramData%\QFR\LEA\ush-tokens\<sessionid>\token.txt 供 LEA
 * 读取后随信封带回验（v3 路径：每会话子目录，由 SYSTEM 服务创建并授
 * DACL；目录未就绪时写失败、主循环每 30 秒重试，token 只生成一次）。
 * LEA 读不到 token 即不转发 UI 命令（fail-closed）。
 * 生成失败返回 0：此时 g_ush_token 为空，全部 LEA 命令都会因 token
 * 不匹配被拒（fail-closed），只记日志继续跑，等下次启动重试。 */
static char g_ush_token[65] = { 0 };
/* 本进程 token 文件全路径（ush_token_init 填，ush_token_cleanup 用；
 * 为空即未写文件）。 */
static WCHAR g_ush_token_path[MAX_PATH] = { 0 };

/* 退出清理（P1-1，2026-11-17 v2）：删自己会话的 token 文件，不留残留。
 * 尽力而为：删不掉（例如旧 SDDL 下的文件无 DELETE 权限）只记日志，
 * 残留文件是 inert 的——LEA 只读请求方会话的文件，USH 内存 token 已
 * 换新，对不上即 fail-closed，不构成冒用。被 taskkill /F 强杀时不跑，
 * 同样只留 inert 残留。 */
static void ush_token_cleanup(void) {
    if (g_ush_token_path[0] == L'\0') return;
    if (DeleteFileW(g_ush_token_path)) {
        ush_log_event("ush-token-cleaned", "own token file removed on exit");
    } else {
        ush_log_event("ush-token-cleanup-failed", "cannot remove own token file; stale file is inert (fail-closed)");
    }
    g_ush_token_path[0] = L'\0';
}

/* token 文件级 DACL（v3，2026-11-18，GPT A1 两处 DoS 根治）：SY/BA 完
 * 全控制；本会话 Logon SID 最小权限 0x150083（FILE_READ_DATA｜
 * FILE_WRITE_DATA｜DELETE｜WRITE_DAC｜FILE_READ_ATTRIBUTES｜SYNCHRONIZE）
 * ——只够读写自己的 token 文件、原子替换（删旧文件）与收紧文件 DACL。
 * Logon SID 而不用用户 SID：同一用户的两个登录会话各有不同的 Logon
 * SID，同用户跨会话也抢占不了（大肥鱼会诊 Q2）。取不到 Logon SID 时
 * 回退用户 SID（同掩码，记日志）——不因此把掩码放回 FA。构造出的
 * DACL 供两处用：临时文件建好后立即用句柄收紧（SetSecurityInfo），
 * 最终文件写完后按路径收紧（SetNamedSecurityInfoW）。*sd_out 须由调
 * 用方 LocalFree。 */
static int ush_token_logon_sid(LPWSTR *sid_str_out) {
    HANDLE tok = NULL;
    DWORD len = 0;
    TOKEN_GROUPS *tg = NULL;
    DWORD i;
    int ok = 0;
    *sid_str_out = NULL;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &tok)) return 0;
    (void)GetTokenInformation(tok, TokenGroups, NULL, 0, &len);
    if (len == 0 || len > 65536) { CloseHandle(tok); return 0; }
    tg = (TOKEN_GROUPS *)malloc(len);
    if (!tg) { CloseHandle(tok); return 0; }
    if (GetTokenInformation(tok, TokenGroups, tg, len, &len)) {
        for (i = 0; i < tg->GroupCount; i++) {
            if ((tg->Groups[i].Attributes & SE_GROUP_LOGON_ID) &&
                IsValidSid(tg->Groups[i].Sid)) {
                ok = ConvertSidToStringSidW(tg->Groups[i].Sid, sid_str_out) ? 1 : 0;
                break;
            }
        }
    }
    free(tg);
    CloseHandle(tok);
    return ok;
}

static int ush_token_build_file_sd(PSECURITY_DESCRIPTOR *sd_out, PACL *dacl_out) {
    *sd_out = NULL;
    *dacl_out = NULL;
    LPWSTR sid_str = NULL;
    int via_logon = ush_token_logon_sid(&sid_str);
    if (!via_logon) {
        /* 回退用户 SID（同掩码，记日志）。 */
        HANDLE tok = NULL;
        DWORD len = 0;
        TOKEN_USER *tu = NULL;
        if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &tok)) {
            ush_log_event("ush-token-acl-failed", "cannot open process token");
            return 0;
        }
        (void)GetTokenInformation(tok, TokenUser, NULL, 0, &len);
        tu = (TOKEN_USER *)malloc(len > 0 ? len : 1);
        if (!tu || !GetTokenInformation(tok, TokenUser, tu, len, &len)) {
            ush_log_event("ush-token-acl-failed", "cannot query token user");
            free(tu);
            CloseHandle(tok);
            return 0;
        }
        if (!ConvertSidToStringSidW(tu->User.Sid, &sid_str)) {
            ush_log_event("ush-token-acl-failed", "cannot stringify user sid");
            free(tu);
            CloseHandle(tok);
            return 0;
        }
        free(tu);
        CloseHandle(tok);
        ush_log_event("ush-token-acl-logon-fallback", "logon SID unavailable; token file DACL uses user SID");
    }
    WCHAR sddl[512];
    _snwprintf(sddl, 512, L"D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;0x150083;;;%s)", sid_str);
    sddl[511] = L'\0';
    LocalFree(sid_str);
    PSECURITY_DESCRIPTOR sd = NULL;
    if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl, SDDL_REVISION_1, &sd, NULL)) {
        ush_log_event("ush-token-acl-failed", "cannot build token file SDDL");
        return 0;
    }
    PACL dacl = NULL;
    BOOL present = FALSE, defaulted = FALSE;
    if (!GetSecurityDescriptorDacl(sd, &present, &dacl, &defaulted) || !present || !dacl) {
        ush_log_event("ush-token-acl-failed", "cannot get token file DACL");
        LocalFree(sd);
        return 0;
    }
    *sd_out = sd;
    *dacl_out = dacl;
    return 1;
}

/* 按路径收紧指定文件的 DACL。返回 1=已设好，0=失败（调用方定策略：
 * 原子路径下文件本已继承正确 DACL，失败只记日志继续；回退路径下文
 * 件沿用旧 SDDL 的宽松 DACL，失败时调用方删文件 fail-closed，下次启
 * 动文件不存在、走原子路径自愈）。 */
static int ush_token_set_file_acl(WCHAR *wpath) {
    PSECURITY_DESCRIPTOR sd = NULL;
    PACL dacl = NULL;
    if (!ush_token_build_file_sd(&sd, &dacl)) return 0;
    DWORD rc = SetNamedSecurityInfoW(wpath, SE_FILE_OBJECT,
                          DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                          NULL, NULL, dacl, NULL);
    LocalFree(sd);
    if (rc != ERROR_SUCCESS) {
        ush_log_event("ush-token-acl-failed", "cannot set token file DACL");
        return 0;
    }
    return 1;
}

/* token 文件是否已写上（ush_token_write_file 置 1；写失败时主循环每
 * 30 秒重试，重试只重写文件、token 不重生成）。 */
static int g_ush_token_file_written = 0;

/* 写 token 文件（v3 路径：每会话子目录 <sessionid>\token.txt，由 SYSTEM
 * 服务创建并授 DACL——USH 不自己建目录（父目录只留 SY/BA，用户进程
 * 建不了）；目录未就绪时写失败、返回 0，主循环 30 秒后重试，服务侧
 * 启动枚举／LEA 读 token 时按需建目录，两边终会合。原子替换：先写同
 * 目录临时文件再 MoveFileEx REPLACE_EXISTING 改名——LEA 永远读到完整
 * 的新文件或完整的旧文件，不会读到写一半的截断内容；同目录改名是原
 * 子操作。临时文件随机名＋CREATE_NEW 独占创建：pid 可预测、可复用，
 * 攻击者可预置同名临时文件干扰写入；4 字节随机后缀使预置不可行，取
 * 随机失败时回退 pid；独占创建使预置占位即碰撞，重试换名。（互斥体
 * 本已挡住同会话双实例，此处只是纵深。）改名失败时回退直接覆写：
 * 旧文件无 DELETE 权限、改名换不掉（一次性升级残留）；回退路径记日
 * 志。回退写是截断式，LEA 并发读可能读到半截——但 token 格式校验
 * （恰好 64 位小写 hex）使半截内容恒被拒，只造成一次性的 transient
 * 失败，不会误接受；且写完后立即收紧文件 DACL（见
 * ush_token_set_file_acl），旧洞一次写清，下次启动即走原子路径。 */
static int ush_token_write_file(void) {
    DWORD session_id = 0;
    if (!ProcessIdToSessionId(GetCurrentProcessId(), &session_id)) {
        ush_log_event("ush-token-no-session", "cannot get own session id; token file not written, LEA forwards will fail closed");
        return 0;
    }
    WCHAR wpd[MAX_PATH];
    DWORD n = GetEnvironmentVariableW(L"ProgramData", wpd, MAX_PATH);
    if (n == 0 || n >= MAX_PATH) return 0;
    WCHAR wpath[MAX_PATH];
    /* A+：token 路径叶名取自实例身份（TEST：…\QFR\LEA-TEST\ush-tokens\…）。 */
    _snwprintf(wpath, MAX_PATH, L"%s\\QFR\\%s\\ush-tokens\\%lu\\token.txt",
               wpd, LEA_INSTANCE_LEAF_W, (unsigned long)session_id);
    wcsncpy(g_ush_token_path, wpath, MAX_PATH - 1);
    g_ush_token_path[MAX_PATH - 1] = L'\0';
    unsigned char rnd[4] = { 0 };
    unsigned long tmp_tag = (unsigned long)GetCurrentProcessId();
    if (BCryptGenRandom(NULL, rnd, sizeof(rnd), BCRYPT_USE_SYSTEM_PREFERRED_RNG) == 0)
        tmp_tag = (unsigned long)(((unsigned long)rnd[0] << 24) | ((unsigned long)rnd[1] << 16) |
                                  ((unsigned long)rnd[2] << 8) | (unsigned long)rnd[3]);
    WCHAR wtmp[MAX_PATH];
    _snwprintf(wtmp, MAX_PATH, L"%s\\QFR\\%s\\ush-tokens\\%lu\\%lu.tmp-%08lx.txt",
               wpd, LEA_INSTANCE_LEAF_W, (unsigned long)session_id, (unsigned long)session_id, tmp_tag);
    /* 临时文件独占创建（CREATE_NEW）：随机名＋独占创建，预置占位即碰
     * 撞，重试换名；建好立即用句柄收紧临时文件 DACL（写内容之前），
     * 不留“先写内容、后收紧”的暴露窗口。注意：文件以共享模式 0 独占
     * 打开时，按路径设 DACL 会被共享冲突拒绝，故必须用句柄设 DACL
     * （打开时带 WRITE_DAC）；收紧失败即关句柄、删临时文件、返回失败，
     * 不继续写。非碰撞失败不重试（目录未就绪属此类，主循环 30 秒后重
     * 试整个写文件流程）。 */
    HANDLE htmp = INVALID_HANDLE_VALUE;
    int attempt;
    for (attempt = 0; attempt < 3 && htmp == INVALID_HANDLE_VALUE; attempt++) {
        if (attempt > 0) {
            if (BCryptGenRandom(NULL, rnd, sizeof(rnd), BCRYPT_USE_SYSTEM_PREFERRED_RNG) == 0)
                tmp_tag = (unsigned long)(((unsigned long)rnd[0] << 24) | ((unsigned long)rnd[1] << 16) |
                                          ((unsigned long)rnd[2] << 8) | (unsigned long)rnd[3]);
            _snwprintf(wtmp, MAX_PATH, L"%s\\QFR\\%s\\ush-tokens\\%lu\\%lu.tmp-%08lx.txt",
                       wpd, LEA_INSTANCE_LEAF_W, (unsigned long)session_id, (unsigned long)session_id, tmp_tag);
        }
        htmp = CreateFileW(wtmp, GENERIC_WRITE | WRITE_DAC, 0, NULL, CREATE_NEW,
                           FILE_ATTRIBUTE_NORMAL, NULL);
        if (htmp == INVALID_HANDLE_VALUE && GetLastError() != ERROR_FILE_EXISTS)
            break;
    }
    if (htmp == INVALID_HANDLE_VALUE) {
        ush_log_event("ush-token-file-failed", "cannot create ush token temp file; LEA forwards will fail closed (retry in 30s)");
        return 0;
    }
    {
        PSECURITY_DESCRIPTOR sd = NULL;
        PACL dacl = NULL;
        if (!ush_token_build_file_sd(&sd, &dacl) ||
            SetSecurityInfo(htmp, SE_FILE_OBJECT,
                            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                            NULL, NULL, dacl, NULL) != ERROR_SUCCESS) {
            ush_log_event("ush-token-acl-failed", "cannot set temp token file DACL; aborting write");
            LocalFree(sd);
            CloseHandle(htmp);
            if (!DeleteFileW(wtmp))
                ush_log_event("ush-token-temp-delete-failed", "stale temp token file remains; not read by LEA");
            return 0;
        }
        LocalFree(sd);
    }
    DWORD written = 0;
    BOOL wok = WriteFile(htmp, g_ush_token, 64, &written, NULL) && written == 64;
    if (wok) {
        char nl = '\n';
        DWORD w2 = 0;
        wok = WriteFile(htmp, &nl, 1, &w2, NULL) && w2 == 1;
    }
    if (!CloseHandle(htmp) || !wok) {
        ush_log_event("ush-token-file-failed", "cannot write ush token temp file; LEA forwards will fail closed (retry in 30s)");
        if (!DeleteFileW(wtmp))
            ush_log_event("ush-token-temp-delete-failed", "stale temp token file remains; not read by LEA");
        return 0;
    }
    int via_fallback = 0;
    if (!MoveFileExW(wtmp, wpath, MOVEFILE_REPLACE_EXISTING)) {
        via_fallback = 1;
        ush_log_event("ush-token-atomic-fallback", "atomic replace failed; falling back to direct overwrite (legacy ACL)");
        if (!DeleteFileW(wtmp))
            ush_log_event("ush-token-temp-delete-failed", "stale temp token file remains; not read by LEA");
        FILE *f = _wfopen(wpath, L"wb");
        if (!f) {
            ush_log_event("ush-token-file-failed", "cannot write ush token file; LEA forwards will fail closed (retry in 30s)");
            return 0;
        }
        size_t wn = fwrite(g_ush_token, 1, 64, f);
        int wc = fputc('\n', f);
        int cc = fclose(f);
        if (wn != 64 || wc == EOF || cc != 0) {
            ush_log_event("ush-token-file-failed", "cannot write ush token file; LEA forwards will fail closed (retry in 30s)");
            return 0;
        }
    }
    /* 写完即收紧文件级 DACL（见 ush_token_set_file_acl）：原子路径下
     * 文件本已继承正确 DACL、临时文件也已用句柄收紧，此处是纵深，失败
     * 只记日志继续；回退路径下文件沿用旧 SDDL 的宽松 DACL，收紧失败时
     * 删文件 fail-closed（下次启动文件不存在，走原子路径自愈），不留
     * 宽松文件继续用。删成功后清 g_ush_token_path，避免退出清理再对
     * 已删文件记一条误导性的 cleanup-failed。删不掉（常见于文件属主
     * 是他人、USH 无 DELETE 权）则把内存 token 清零再返回 0：与本函数
     * 头注释的契约一致（返回 0 ⟺ g_ush_token 为空，全部转发命令因
     * token 不匹配被拒），宽松文件里的 token 从此对不上内存，UI 命令
     * fail-closed 直到下次启动重生成。 */
    if (!ush_token_set_file_acl(wpath) && via_fallback) {
        if (DeleteFileW(wpath)) {
            g_ush_token_path[0] = L'\0';
            ush_log_event("ush-token-acl-failed-removed", "token file DACL cannot be tightened; file removed, UI commands fail closed until next USH start");
        } else {
            ush_log_event("ush-token-acl-failed-remove-failed", "token file DACL cannot be tightened and file cannot be removed; memory token zeroed, UI commands fail closed until next USH start");
            memset(g_ush_token, 0, sizeof(g_ush_token));
            return 0;
        }
    }
    g_ush_token_file_written = 1;
    return 1;
}

/* 生成 token（只做一次）：32 字节 BCryptGenRandom → 64 位小写 hex，存
 * 内存（g_ush_token），再调 ush_token_write_file 落盘供 LEA 读取。
 * 生成失败返回 0：此时 g_ush_token 为空，全部 LEA 命令都会因 token
 * 不匹配被拒（fail-closed），只记日志继续跑，等下次启动重试。写文件
 * 失败返回 1（token 在内存，文件没写，主循环每 30 秒重试写文件）。 */
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
    /* 文件名用 USH 自身会话 id（H03 第三轮，2026-11-17）：LEA 按“发来
     * 本条命令的客户端所在会话”读 token（见 QFRLEA.c ush_token_read），
     * 两端同源、RDP／多会话下不错配。旧版（第二轮）两端同用活动控制台
     * 会话 id，Server＋RDP 下 USH 所在会话与控制台会话对不上、RDP-only
     * 时甚至无控制台会话，token 文件不写、LEA 永远读不到，UI 命令与
     * 自助绑定全线 fail-closed。多会话各跑一个 USH 时各写各的会话文件，
     * 不再同名抢写。v3：文件改放每会话子目录 <sessionid>\token.txt
     * （见 ush_token_write_file）。 */
    ush_token_write_file();
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
    /* A+：监听日志写实例管道名（TEST：…\QFR\LEA-TEST\UserHelper\v1）；
     * 保持旧格式 "pipe=<管道名>"，生产输出逐字节不变。 */
    {
        char pipe_detail[128];
        snprintf(pipe_detail, sizeof(pipe_detail), "pipe=%s", LEA_USH_PIPE_NAME_A);
        ush_log_event("pipe-listening", pipe_detail);
    }
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
            LEA_USH_PIPE_NAME_A);
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
        ush_token_cleanup();
        return 1;
    }
    /* v3：token 文件写失败时每 30 秒重试一次（目录由 SYSTEM 服务创建，
     * USH 启动时目录可能还没建好——服务启动枚举／LEA 读 token 时按需建；
     * 目录未就绪时写失败只记日志，重试直到写上；token 只生成一次，重
     * 试只重写文件）。 */
    for (;;) {
        DWORD w = WaitForSingleObject(g_stop_event, 30000);
        if (w != WAIT_TIMEOUT) break;
        if (g_ush_token[0] && !g_ush_token_file_written)
            ush_token_write_file();
    }
    InterlockedExchange(&g_running, 0);
    /* 自唤醒：连一次管道让 ConnectNamedPipe 返回 */
    {
        HANDLE h = CreateFileW(PIPE_NAME_W, GENERIC_READ | GENERIC_WRITE,
            0, NULL, OPEN_EXISTING, 0, NULL);
        if (h != INVALID_HANDLE_VALUE) CloseHandle(h);
    }
    WaitForSingleObject(loop_thread, 5000);
    ush_token_cleanup();
    ush_uia_shutdown();
    if (mutex) CloseHandle(mutex);
    ush_log_event("ush-stopped", "shutdown complete");
    return 0;
}
