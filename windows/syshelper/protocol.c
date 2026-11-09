/* 见 protocol.h */
#include "protocol.h"
#include <string.h>
#include <stdlib.h>

int qf_validate_owner(const char *owner) {
    if (!owner) return 0;
    size_t len = strlen(owner);
    if (len == 0 || len > 192) return 0; /* 64 个字符以 UTF-8 计最多 192 字节 */
    int chars = 0;
    for (size_t i = 0; i < len; i++) {
        unsigned char c = (unsigned char)owner[i];
        if (c < 0x20 || c == 0x7f) return 0; /* 控制字符 */
        if (c < 0x80) {
            chars++;
            if (!((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
                  (c >= '0' && c <= '9') || c == '_' || c == '@' || c == '.' || c == '-'))
                return 0;
        } else if ((c & 0xC0) == 0x80) {
            continue; /* UTF-8 后续字节 */
        } else {
            chars++; /* UTF-8 首字节（CJK 等） */
        }
    }
    return chars >= 1 && chars <= 64;
}

const char *qf_expected_basename(int cmd) {
    return cmd == 0 ? "qf-agent-heal.ps1" : "install.ps1";
}

/* 取 JSON 字符串字段值（只支持 "..." 平铺字段），并做 JSON 反转义：
 * 只接受 \\ 与 \" 两种转义，其余转义（\u、\n 等）一律拒绝。
 * 解出的值再由调用方做字符集校验。 */
static int json_string_field(const char *text, const char *key, char *out, size_t out_size) {
    char pat[64];
    size_t klen = strlen(key);
    if (klen + 4 >= sizeof(pat)) return 0;
    pat[0] = '"';
    memcpy(pat + 1, key, klen);
    pat[klen + 1] = '"';
    pat[klen + 2] = ':';
    pat[klen + 3] = '"';
    pat[klen + 4] = '\0';
    const char *p = strstr(text, pat);
    if (!p) return 0;
    p += klen + 4;
    size_t n = 0;
    while (*p) {
        if (*p == '"') {
            if (n == 0 || n >= out_size) return 0;
            out[n] = '\0';
            return 1;
        }
        if (*p == '\\') {
            p++;
            if (*p != '\\' && *p != '"') return 0;
            if (n + 1 >= out_size) return 0;
            out[n++] = *p++;
            continue;
        }
        if ((unsigned char)*p < 0x20) return 0;
        if (n + 1 >= out_size) return 0;
        out[n++] = *p++;
    }
    return 0;
}

int qf_parse_request(const char *text, qf_request_t *out) {
    memset(out, 0, sizeof(*out));
    if (!text || strlen(text) == 0 || strlen(text) > QF_MAX_REQUEST) {
        strcpy(out->error, "bad-request");
        return 0;
    }
    char cmd[32];
    if (!json_string_field(text, "cmd", cmd, sizeof(cmd))) {
        strcpy(out->error, "bad-request");
        return 0;
    }
    if (strcmp(cmd, QF_CMD_HEAL) == 0) out->cmd = 0;
    else if (strcmp(cmd, QF_CMD_INSTALL_LOCK) == 0) out->cmd = 1;
    else { strcpy(out->error, "unknown-command"); return 0; }

    if (out->cmd == 1) {
        if (!json_string_field(text, "owner", out->owner, sizeof(out->owner)) ||
            !qf_validate_owner(out->owner)) {
            strcpy(out->error, "bad-owner");
            return 0;
        }
    }
    if (!json_string_field(text, "path", out->path, sizeof(out->path))) {
        strcpy(out->error, "bad-path");
        return 0;
    }
    /* 路径：必须绝对路径（盘符 X:\ 或 UNC \\），不得含 ".." */
    size_t plen = strlen(out->path);
    if (plen < 4 || strstr(out->path, "..") != NULL) {
        strcpy(out->error, "bad-path");
        return 0;
    }
    int abs = ((out->path[0] >= 'A' && out->path[0] <= 'Z') ||
               (out->path[0] >= 'a' && out->path[0] <= 'z')) &&
              out->path[1] == ':' && (out->path[2] == '\\' || out->path[2] == '/');
    if (!abs && !(out->path[0] == '\\' && out->path[1] == '\\')) {
        strcpy(out->error, "bad-path");
        return 0;
    }
    /* basename 必须与命令对应 */
    const char *base = strrchr(out->path, '\\');
    const char *base2 = strrchr(out->path, '/');
    if (base2 && (!base || base2 > base)) base = base2;
    base = base ? base + 1 : out->path;
    if (strcmp(base, qf_expected_basename(out->cmd)) != 0) {
        strcpy(out->error, "bad-path");
        return 0;
    }
    out->valid = 1;
    return 1;
}
