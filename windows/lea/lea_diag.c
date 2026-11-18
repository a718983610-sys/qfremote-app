/* lea_diag.c — 结构化调用方拒绝诊断（纯 C，见 lea_diag.h）。 */
#include "lea_diag.h"

#include <stdio.h>
#include <string.h>

const char *lea_session_state_name(unsigned long state) {
    /* WTS_CONNECTSTATE_CLASS（wtsapi32.h）：数值是稳定 ABI。 */
    switch (state) {
        case 0: return "WTSActive";
        case 1: return "WTSConnected";
        case 2: return "WTSConnectQuery";
        case 3: return "WTSShadow";
        case 4: return "WTSDisconnected";
        case 5: return "WTSIdle";
        case 6: return "WTSListen";
        case 7: return "WTSReset";
        case 8: return "WTSDown";
        case 9: return "WTSInit";
        default: return "unknown";
    }
}

int lea_format_caller_diag(char *out, size_t out_size,
                           const lea_caller_diag_t *d) {
    char client_session[32];
    char parent_session[32];
    const char *reason;
    const char *client_image;
    const char *parent_image;
    int n;
    if (!out || out_size == 0 || !d) return 0;
    out[0] = '\0';
    if (d->client_session_id == LEA_DIAG_UNKNOWN_ID)
        snprintf(client_session, sizeof(client_session), "%s", "unknown");
    else
        snprintf(client_session, sizeof(client_session), "%lu",
                 d->client_session_id);
    if (d->parent_session_id == LEA_DIAG_UNKNOWN_ID)
        snprintf(parent_session, sizeof(parent_session), "%s", "unknown");
    else
        snprintf(parent_session, sizeof(parent_session), "%lu",
                 d->parent_session_id);
    reason = (d->reason && d->reason[0]) ? d->reason : "unknown";
    client_image = d->client_image ? d->client_image : "";
    parent_image = d->parent_image ? d->parent_image : "";
    n = snprintf(out, out_size,
                 "internal-allow: reject reason=%s reject_stage=%s "
                 "client_pid=%lu parent_pid=%lu "
                 "client_image=\"%s\" parent_image=\"%s\" "
                 "client_session_id=%s parent_session_id=%s "
                 "session_state=%s win32_error=%lu",
                 reason, reason,
                 d->client_pid, d->parent_pid,
                 client_image, parent_image,
                 client_session, parent_session,
                 lea_session_state_name(d->session_state),
                 d->win32_error);
    return (n >= 0 && (size_t)n < out_size) ? 1 : 0;
}

const char *lea_unified_reject_reason(const char *fine_reason) {
    if (!fine_reason || !fine_reason[0]) return "internal-caller-not-allowed";
    if (strcmp(fine_reason, "image-mismatch") == 0)
        return "client-path-mismatch";
    if (strcmp(fine_reason, "parent-check-failed") == 0 ||
        strcmp(fine_reason, "system-parent-invalid") == 0)
        return "parent-image-invalid";
    if (strcmp(fine_reason, "session-mismatch") == 0)
        return "session-mismatch";
    if (strcmp(fine_reason, "session-disconnected") == 0)
        return "session-disconnected";
    if (strcmp(fine_reason, "session-not-active") == 0)
        return "session-not-active";
    if (strcmp(fine_reason, "sid-mismatch") == 0 ||
        strcmp(fine_reason, "logon-mismatch") == 0 ||
        strcmp(fine_reason, "system-sid-mismatch") == 0 ||
        strcmp(fine_reason, "system-logon-mismatch") == 0)
        return "user-sid-mismatch";
    if (strcmp(fine_reason, "no-client-pid") == 0 ||
        strcmp(fine_reason, "open-process-failed") == 0 ||
        strcmp(fine_reason, "image-query-failed") == 0 ||
        strcmp(fine_reason, "caller-session-query-failed") == 0 ||
        strcmp(fine_reason, "caller-session-0") == 0 ||
        strcmp(fine_reason, "caller-time-query-failed") == 0 ||
        strcmp(fine_reason, "caller-token-failed") == 0 ||
        strcmp(fine_reason, "parent-not-found") == 0 ||
        strcmp(fine_reason, "parent-open-failed") == 0 ||
        strcmp(fine_reason, "parent-token-failed") == 0 ||
        strcmp(fine_reason, "parent-session-query-failed") == 0 ||
        strcmp(fine_reason, "parent-image-query-failed") == 0 ||
        strcmp(fine_reason, "session-state-query-failed") == 0 ||
        strcmp(fine_reason, "parent-create-time-after-caller") == 0)
        return "identity-query-failed";
    /* 未知细原因与 "ok" 一律落保底值，绝不把保底值反写为细分原因。 */
    return "internal-caller-not-allowed";
}

int lea_format_emergency_stop_diag(char *out, size_t out_size,
                                   const lea_emergency_stop_diag_t *d) {
    char client_pid[32];
    char parent_pid[32];
    char client_session[32];
    char parent_session[32];
    char session_state[32];
    const char *decision;
    const char *reason;
    const char *source_type;
    const char *stop_id;
    int n;
    if (!out || out_size == 0 || !d) return 0;
    out[0] = '\0';
    decision = (d->decision && d->decision[0]) ? d->decision : "unknown";
    reason = (d->reason && d->reason[0]) ? d->reason : "unknown";
    source_type = (d->source_type && d->source_type[0]) ? d->source_type : "unknown";
    stop_id = (d->stop_id && d->stop_id[0]) ? d->stop_id : "null";
    if (d->client_pid == 0)
        snprintf(client_pid, sizeof(client_pid), "%s", "null");
    else
        snprintf(client_pid, sizeof(client_pid), "%lu", d->client_pid);
    if (d->parent_pid == 0)
        snprintf(parent_pid, sizeof(parent_pid), "%s", "null");
    else
        snprintf(parent_pid, sizeof(parent_pid), "%lu", d->parent_pid);
    if (d->client_session_id == LEA_DIAG_UNKNOWN_ID)
        snprintf(client_session, sizeof(client_session), "%s", "null");
    else
        snprintf(client_session, sizeof(client_session), "%lu",
                 d->client_session_id);
    if (d->parent_session_id == LEA_DIAG_UNKNOWN_ID)
        snprintf(parent_session, sizeof(parent_session), "%s", "null");
    else
        snprintf(parent_session, sizeof(parent_session), "%lu",
                 d->parent_session_id);
    if (d->session_state == LEA_DIAG_UNKNOWN_ID)
        snprintf(session_state, sizeof(session_state), "%s", "null");
    else
        snprintf(session_state, sizeof(session_state), "%s",
                 lea_session_state_name(d->session_state));
    /* 镜像：已知记 "path"，未知记裸 null（不用 "" 冒充空路径）。 */
    if ((d->client_image && d->client_image[0]) &&
        (d->parent_image && d->parent_image[0])) {
        n = snprintf(out, out_size,
                     "emergency-stop-allow: decision=%s admission_type=emergency-stop "
                     "source_type=%s reason=%s reject_stage=%s "
                     "client_pid=%s parent_pid=%s "
                     "client_image=\"%s\" parent_image=\"%s\" "
                     "client_session_id=%s parent_session_id=%s "
                     "session_state=%s win32_error=%lu stop_id=%s",
                     decision, source_type, reason, reason,
                     client_pid, parent_pid,
                     d->client_image, d->parent_image,
                     client_session, parent_session,
                     session_state, d->win32_error, stop_id);
    } else if (d->client_image && d->client_image[0]) {
        n = snprintf(out, out_size,
                     "emergency-stop-allow: decision=%s admission_type=emergency-stop "
                     "source_type=%s reason=%s reject_stage=%s "
                     "client_pid=%s parent_pid=%s "
                     "client_image=\"%s\" parent_image=null "
                     "client_session_id=%s parent_session_id=%s "
                     "session_state=%s win32_error=%lu stop_id=%s",
                     decision, source_type, reason, reason,
                     client_pid, parent_pid,
                     d->client_image,
                     client_session, parent_session,
                     session_state, d->win32_error, stop_id);
    } else if (d->parent_image && d->parent_image[0]) {
        n = snprintf(out, out_size,
                     "emergency-stop-allow: decision=%s admission_type=emergency-stop "
                     "source_type=%s reason=%s reject_stage=%s "
                     "client_pid=%s parent_pid=%s "
                     "client_image=null parent_image=\"%s\" "
                     "client_session_id=%s parent_session_id=%s "
                     "session_state=%s win32_error=%lu stop_id=%s",
                     decision, source_type, reason, reason,
                     client_pid, parent_pid,
                     d->parent_image,
                     client_session, parent_session,
                     session_state, d->win32_error, stop_id);
    } else {
        n = snprintf(out, out_size,
                     "emergency-stop-allow: decision=%s admission_type=emergency-stop "
                     "source_type=%s reason=%s reject_stage=%s "
                     "client_pid=%s parent_pid=%s "
                     "client_image=null parent_image=null "
                     "client_session_id=%s parent_session_id=%s "
                     "session_state=%s win32_error=%lu stop_id=%s",
                     decision, source_type, reason, reason,
                     client_pid, parent_pid,
                     client_session, parent_session,
                     session_state, d->win32_error, stop_id);
    }
    return (n >= 0 && (size_t)n < out_size) ? 1 : 0;
}
