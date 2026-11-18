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
