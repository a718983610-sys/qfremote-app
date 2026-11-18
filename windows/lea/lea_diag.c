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
