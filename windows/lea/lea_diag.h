/* lea_diag.h — 结构化调用方拒绝诊断（纯 C，无 Windows 依赖，可单测）。
 *
 * A16-S2（2026-11-18，GPT 裁决 §四）：内部命令调用方鉴权拒绝时，不能
 * 只留一条笼统的 caller-not-allowed，须记录结构化诊断字段：
 * client_pid、parent_pid、client_image、parent_image、client_session_id、
 * parent_session_id、session_state、reject_stage、win32_error。
 *
 * 本模块只负责“取值→名字→一行文本”的纯逻辑：会话状态名按
 * WTS_CONNECTSTATE_CLASS 枚举值映射（0=WTSActive … 9=WTSInit，见
 * wtsapi32.h；此处用数值常量以免引入 Windows 头）；诊断行由
 * lea_format_caller_diag 生成，调用方（QFRLEA.c internal_caller_allowed）
 * 以 svc_log 写出。字段值里只有镜像路径可能含空格，故镜像值加双引号，
 * 其余字段为裸 k=v，便于 Select-String / rg 抓取。
 *
 * 约定：会话 id / 会话状态取不到时传 0xFFFFFFFF，格式化为 "unknown"；
 * 镜像路径未知时传 NULL 或 ""，格式化为 ""。reason 与 reject_stage 同值
 * （reason 即被拒的鉴权步骤）。win32_error 仅在 Win32 API 本身失败时
 * 由调用方填 GetLastError()，纯逻辑失配（镜像／会话／SID 不一致）时为 0。
 * 本模块不读、不写任何凭据／密钥／登录密码／Cookie／IPC 密钥。
 */
#ifndef QFRLEA_LEA_DIAG_H
#define QFRLEA_LEA_DIAG_H

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

#define LEA_DIAG_UNKNOWN_ID 0xFFFFFFFFUL

/* 诊断行输入（调用方从 lea_caller_identity_t 填）。 */
typedef struct {
    unsigned long client_pid;
    unsigned long parent_pid;
    const char *client_image;  /* NULL → "" */
    const char *parent_image;  /* NULL → "" */
    unsigned long client_session_id; /* LEA_DIAG_UNKNOWN_ID = unknown */
    unsigned long parent_session_id; /* LEA_DIAG_UNKNOWN_ID = unknown */
    unsigned long session_state;     /* WTS_CONNECTSTATE_CLASS，UNKNOWN = unknown */
    const char *reason;              /* NULL → "unknown"；同时用作 reject_stage */
    unsigned long win32_error;
} lea_caller_diag_t;

/* 会话状态名：WTSActive / WTSConnected / WTSConnectQuery / WTSShadow /
 * WTSDisconnected / WTSIdle / WTSListen / WTSReset / WTSDown / WTSInit，
 * 未知值返回 "unknown"。返回值指向静态字符串，调用方不得释放／修改。 */
const char *lea_session_state_name(unsigned long state);

/* A16-S2 收口（GPT 2026-11-18 裁决问题 2）：内部拒绝细原因 → 统一
 * 审计理由枚举。8 个统一值（裁决给定）：
 *   client-path-mismatch / parent-image-invalid / session-mismatch /
 *   session-disconnected / session-not-active / user-sid-mismatch /
 *   identity-query-failed / internal-caller-not-allowed（保底）。
 * 映射表（细原因 → 统一值）：
 *   image-mismatch → client-path-mismatch
 *   parent-check-failed / system-parent-invalid → parent-image-invalid
 *   session-mismatch → session-mismatch
 *   session-disconnected → session-disconnected
 *   session-not-active → session-not-active
 *   sid-mismatch / logon-mismatch / system-sid-mismatch /
 *     system-logon-mismatch → user-sid-mismatch
 *   其余查询／取证失败（no-client-pid、open-process-failed、
 *     image-query-failed、caller-session-query-failed、caller-session-0、
 *     caller-time-query-failed、caller-token-failed、parent-not-found、
 *     parent-open-failed、parent-token-failed、parent-session-query-failed、
 *     parent-image-query-failed、session-state-query-failed、
 *     parent-create-time-after-caller）→ identity-query-failed
 *   NULL／空串／未知细原因／"ok" → internal-caller-not-allowed（保底，
 *   绝不覆盖已确定的细分原因；仅在调用方未传来有效细原因时使用）。
 * 返回值指向静态字符串，调用方不得释放／修改。 */
const char *lea_unified_reject_reason(const char *fine_reason);

/* A16-S2 收口（GPT 2026-11-18 裁决问题 1）：emergency-stop 专用
 * admission 诊断行输入。九字段与 internal 命令同结构，另加
 * admission_type=emergency-stop、source_type、decision、reason、stop_id。
 * 约定（裁决“不适用字段记 null，禁编造”）：
 *   PID 为 0、会话 id／会话状态为 LEA_DIAG_UNKNOWN_ID、镜像为 NULL 或
 *   ""、stop_id 不可读时，格式化为裸 null（无引号）；stop_id 已读到但无
 *   活动停控时为 "none"（确切事实，非编造）；会话状态已知时记名字
 *   （WTSActive / WTSDisconnected 等），未知时记 null——记会话状态只
 *   用于诊断，绝不用于决定停控是否放行。
 *   source_type 由已鉴权的身份分支决定（local-client /
 *   system-service），未确定前为 "unknown"；绝不取用户提供的 source
 *   字段（管道协议里根本没有该字段）。 */
typedef struct {
    const char *decision;      /* "allow" / "reject"，NULL → "unknown" */
    const char *reason;        /* 细原因，NULL → "unknown"；同时用作 reject_stage */
    const char *source_type;   /* "local-client" / "system-service" / "unknown" */
    unsigned long client_pid;  /* 0 = null */
    unsigned long parent_pid;  /* 0 = null */
    const char *client_image;  /* NULL / "" → null */
    const char *parent_image;  /* NULL / "" → null */
    unsigned long client_session_id; /* LEA_DIAG_UNKNOWN_ID = null */
    unsigned long parent_session_id; /* LEA_DIAG_UNKNOWN_ID = null */
    unsigned long session_state;     /* WTS_CONNECTSTATE_CLASS，UNKNOWN = null */
    unsigned long win32_error;
    const char *stop_id;       /* NULL → null；"none" = 无活动停控 */
} lea_emergency_stop_diag_t;

/* 生成一行 emergency-stop 诊断（不含行尾换行；恒以 NUL 结尾）。
 * 格式：
 *   emergency-stop-allow: decision=<allow|reject> admission_type=emergency-stop
 *   source_type=<s> reason=<r> reject_stage=<r>
 *   client_pid=<n|null> parent_pid=<n|null>
 *   client_image="<p>"|null parent_image="<p>"|null
 *   client_session_id=<n|null> parent_session_id=<n|null>
 *   session_state=<Name|null> win32_error=<n> stop_id=<id>|none|null
 * 返回 1=完整写入，0=输出被截断（仍以 NUL 结尾，内容可用但不完整）。 */
int lea_format_emergency_stop_diag(char *out, size_t out_size,
                                   const lea_emergency_stop_diag_t *d);

/* 生成一行结构化诊断（不含行尾换行；恒以 NUL 结尾）。
 * 格式：
 *   internal-allow: reject reason=<r> reject_stage=<r> client_pid=<n>
 *   parent_pid=<n> client_image="<p>" parent_image="<p>"
 *   client_session_id=<n|unknown> parent_session_id=<n|unknown>
 *   session_state=<Name|unknown> win32_error=<n>
 * 返回 1=完整写入，0=输出被截断（仍以 NUL 结尾，内容可用但不完整）。 */
int lea_format_caller_diag(char *out, size_t out_size,
                           const lea_caller_diag_t *d);

#ifdef __cplusplus
}
#endif

#endif /* QFRLEA_LEA_DIAG_H */
