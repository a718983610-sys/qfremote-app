/* lea_appclose.h — app.close 跨用户误杀修复（batch1-fix2，2026-11-16）
 * =================================================================
 * 问题（GPT 审查 97f445a，2026-11-16 20:49；站长 20:57 已批准修复）：
 * 旧 app.close 以 SYSTEM 身份按进程名枚举 QFRemote.exe 就 TerminateProcess，
 * 未核对 Session ID、用户 SID 或完整可执行路径，会误杀同一电脑上其他
 * 登录用户的 QFRemote 实例。
 *
 * 修法（本模块＋QFRLEA.c app.close 分支）：
 *   1) 核对四元组——PID（可选指定时才钉死）、用户 SID、Windows Session ID、
 *      进程完整路径，全部通过才允许触碰；任一未知／失配即拒绝（fail-closed）。
 *   2) 只限当前被授权的会话＝活动控制台会话（WTSGetActiveConsoleSessionId，
 *      与 H01 parent_is_main_app 同一口径）；会话 0（服务）永不授权。
 *   3) 完整路径以被授权用户自己的安装位置为准（其 HKCU 卸载注册表
 *      InstallLocation，即安装器写入的 $INSTDIR\QFRemote.exe；取不到时
 *      回退 ProfileImagePath 下默认位置；两者都取不到即拒绝，不猜路径）。
 *   4) 优先正常退出（向目标进程顶层窗口发 WM_CLOSE 并等退出）；仍在世的
 *      才走强制结束，且强制前重新探测＋重新全量核对（含创建时刻，防 PID 复用）。
 *
 * 纯核对逻辑（lea_appclose_target_allowed）是纯 C、无 Windows 依赖，
 * 可在 Linux 单测里跑（见 test/test_lea.c 的 appclose 组）；探测／身份
 * 解析／优雅退出是 Windows-only（#ifdef _WIN32），只编进 QFRLEA.exe。
 * 本模块不读、不写任何凭据／密钥。
 */
#ifndef QFRLEA_APPCLOSE_H
#define QFRLEA_APPCLOSE_H

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

#define LEA_APPCLOSE_SID_MAX 256
#define LEA_APPCLOSE_PATH_MAX 512

/* 候选进程（一次探测的快照）。create_time 为 GetProcessTimes 的 FILETIME
 * 100ns 刻度；0 表示未知（未知时凡要求核对创建时刻的判定一律拒绝）。 */
typedef struct {
    unsigned long pid;
    unsigned long session_id;
    unsigned long long create_time;
    char user_sid[LEA_APPCLOSE_SID_MAX];       /* "S-1-5-21-..." 字符串形式 */
    char image_path[LEA_APPCLOSE_PATH_MAX];    /* QueryFullProcessImageName 全路径 */
} lea_appclose_candidate_t;

/* 被授权的目标画像。pid==0 表示不限定具体 PID（关掉本会话本用户名下
 * 全部合法实例）；pid!=0 表示只许碰该 PID。create_time==0 表示不核对
 * 创建时刻；!=0 时必须精确相等（强制结束前的 PID 复用防护用）。 */
typedef struct {
    unsigned long session_id;                  /* 活动控制台会话 ID */
    char user_sid[LEA_APPCLOSE_SID_MAX];       /* 该会话用户的 SID 字符串 */
    char image_path[LEA_APPCLOSE_PATH_MAX];    /* 该用户安装位置的 QFRemote.exe 全路径 */
    unsigned long pid;
    unsigned long long create_time;
} lea_appclose_authorized_t;

/* 全量核对：四元组＋名称全部通过返回 1，否则返回 0（fail-closed）。
 * reason 写入拒绝原因（"ok"／"session-mismatch"／"sid-mismatch"／
 * "path-mismatch"／"name-mismatch"／"pid-mismatch"／
 * "create-time-mismatch"／"unknown-sid"／"unknown-path"／"bad-session"／
 * "bad-pid"／"bad-args"），供调用方记日志／计 skipped；reason 可为 NULL。 */
int lea_appclose_target_allowed(const lea_appclose_candidate_t *cand,
                                const lea_appclose_authorized_t *auth,
                                char *reason, size_t reason_size);

#ifdef _WIN32
/* 探测一个进程，填出候选快照。任一字段取不到即返回 0（调用方按不合格
 * 处理，绝不按“查不到就放行”处理）。 */
int lea_appclose_probe(unsigned long pid, lea_appclose_candidate_t *out);

/* 解析被授权会话的身份：会话用户的 SID 字符串＋其安装位置的
 * QFRemote.exe 全路径。任一解析失败返回 0（调用方拒绝执行、不杀任何进程）。
 * session_id 为 WTSGetActiveConsoleSessionId() 的返回值。 */
int lea_appclose_authorized_identity(unsigned long session_id,
                                     char *sid_out, size_t sid_size,
                                     char *image_out, size_t image_size);

/* 优雅退出：向 pids[n] 每个进程的可见顶层窗口发 WM_CLOSE，再等全部退出
 * 至多 timeout_ms。exited[i] 置 1=已退出／0=仍在。返回 1=全部已退出，
 * 0=仍有在世者，-1=内部错误（调用方按“优雅失败”处理，仍可走受限强制路径，
 * 但强制前必须重新探测＋重新核对）。 */
int lea_appclose_request_exit(const unsigned long *pids, int n,
                              unsigned long timeout_ms, int *exited);

/* 单个进程是否已退出（句柄可等且已 signaled，或进程已不存在）。
 * 返回 1=已退出，0=仍在，-1=查不到（调用方按“仍在”保守处理）。 */
int lea_appclose_process_exited(unsigned long pid);
#endif /* _WIN32 */

#ifdef __cplusplus
}
#endif

#endif /* QFRLEA_APPCLOSE_H */
