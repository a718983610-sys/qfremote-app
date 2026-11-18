/* 见 ush_log.h。日志目录 ACL 由安装线配置（仅 SYSTEM/Administrators 可读）；
 * USH 只负责建目录、写当日文件。 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <bcrypt.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "ush_log.h"
#include "../lea/lea_instance.h" /* A+：实例身份（生产／TEST）唯一来源 */

static char g_log_dir[MAX_PATH] = {0};

static void ensure_log_dir(void) {
    if (g_log_dir[0]) return;
    WCHAR dir[MAX_PATH];
    DWORD n = GetEnvironmentVariableW(L"ProgramData", dir, MAX_PATH);
    if (n == 0 || n >= MAX_PATH) {
        wcscpy_s(dir, MAX_PATH, L"C:\\ProgramData");
    }
    WCHAR parent[MAX_PATH];
    wcscpy_s(parent, MAX_PATH, dir);
    wcscat_s(parent, MAX_PATH, L"\\QFR");
    CreateDirectoryW(parent, NULL);
    /* A+：日志目录叶名取自实例身份（TEST：…\QFR\LEA-TEST\logs）。 */
    wcscat_s(parent, MAX_PATH, L"\\");
    wcscat_s(parent, MAX_PATH, LEA_INSTANCE_LEAF_W);
    CreateDirectoryW(parent, NULL);
    wcscat_s(parent, MAX_PATH, L"\\logs");
    CreateDirectoryW(parent, NULL);
    WideCharToMultiByte(CP_UTF8, 0, parent, -1, g_log_dir, MAX_PATH, NULL, NULL);
}

static void log_path_today(char *out, size_t out_size) {
    SYSTEMTIME st;
    GetLocalTime(&st);
    ensure_log_dir();
    snprintf(out, out_size, "%s\\ush-%04d-%02d-%02d.jsonl",
        g_log_dir, st.wYear, st.wMonth, st.wDay);
}

static void append_line(const char *line) {
    char path[MAX_PATH + 64];
    log_path_today(path, sizeof(path));
    FILE *f = fopen(path, "a");
    if (!f) return;
    fputs(line, f);
    fputc('\n', f);
    fclose(f);
}

/* ISO-8601 本地时间（含毫秒），如 2026-11-10T12:34:56.789+08:00（只拼 +08:00
 * 占位？不——用系统时区偏差实算）。简单起见用 UTC "Z" 后缀，保证可比性。 */
static void iso_now(char *out, size_t out_size) {
    SYSTEMTIME st;
    GetSystemTime(&st);
    snprintf(out, out_size, "%04d-%02d-%02dT%02d:%02d:%02d.%03dZ",
        st.wYear, st.wMonth, st.wDay, st.wHour, st.wMinute, st.wSecond, st.wMilliseconds);
}

int ush_sha256_hex(const char *text, char out_hex[65]) {
    static const char hexd[] = "0123456789abcdef";
    out_hex[0] = '\0';
    if (!text) return 0;
    BCRYPT_ALG_HANDLE alg = NULL;
    BCRYPT_HASH_HANDLE hash = NULL;
    int ok = 0;
    if (BCryptOpenAlgorithmProvider(&alg, BCRYPT_SHA256_ALGORITHM, NULL, 0) != 0) return 0;
    if (BCryptCreateHash(alg, &hash, NULL, 0, NULL, 0, 0) != 0) goto done;
    if (BCryptHashData(hash, (PUCHAR)text, (ULONG)strlen(text), 0) != 0) goto done;
    {
        unsigned char digest[32];
        if (BCryptFinishHash(hash, digest, sizeof(digest), 0) != 0) goto done;
        for (int i = 0; i < 32; i++) {
            out_hex[i * 2] = hexd[(digest[i] >> 4) & 0xF];
            out_hex[i * 2 + 1] = hexd[digest[i] & 0xF];
        }
        out_hex[64] = '\0';
        ok = 1;
    }
done:
    if (hash) BCryptDestroyHash(hash);
    if (alg) BCryptCloseAlgorithmProvider(alg, 0);
    return ok;
}

static void json_escape_into(const char *in, char *out, size_t out_size) {
    if (!ush_json_escape(in ? in : "", out, out_size)) {
        if (out_size) out[0] = '\0';
    }
}

void ush_log_init(void) {
    ensure_log_dir();
    /* A+：启动日志写实例管道名，保持旧格式 "pipe=<管道名>"，生产输出逐字节不变。 */
    char pipe_detail[128];
    snprintf(pipe_detail, sizeof(pipe_detail), "pipe=%s", LEA_USH_PIPE_NAME_A);
    ush_log_event("ush-started", pipe_detail);
}

void ush_log_event(const char *event, const char *detail) {
    char ts[40], ev[128], dt[512], line[2048];
    iso_now(ts, sizeof(ts));
    json_escape_into(event, ev, sizeof(ev));
    json_escape_into(detail, dt, sizeof(dt));
    DWORD session_id = 0;
    ProcessIdToSessionId(GetCurrentProcessId(), &session_id);
    snprintf(line, sizeof(line),
        "{\"ts\":\"%s\",\"event\":\"%s\",\"detail\":\"%s\",\"process_id\":%lu,\"ush_session_id\":%lu}",
        ts, ev, dt, (unsigned long)GetCurrentProcessId(), (unsigned long)session_id);
    append_line(line);
}

void ush_log_command(const ush_request_t *req, const char *result,
                     const char *error_code, long duration_ms,
                     const char *window_title, int retry_count) {
    char ts[40], line[4096];
    char params_hash[65] = {0};
    ush_sha256_hex(req->params_json, params_hash);
    char rid[256], tid[256], bid[256], aid[256], did[512], kid[128], nonce[256];
    char cmd[64], res[32], ec[128], wt[256];
    iso_now(ts, sizeof(ts));
    json_escape_into(req->request_id, rid, sizeof(rid));
    json_escape_into(req->trace_id, tid, sizeof(tid));
    json_escape_into(req->batch_id, bid, sizeof(bid));
    json_escape_into(req->account_id, aid, sizeof(aid));
    json_escape_into(req->device_id, did, sizeof(did));
    json_escape_into(req->api_key_id, kid, sizeof(kid));
    json_escape_into(req->nonce, nonce, sizeof(nonce));
    json_escape_into(req->command, cmd, sizeof(cmd));
    json_escape_into(result, res, sizeof(res));
    json_escape_into(error_code ? error_code : "", ec, sizeof(ec));
    /* window_title 截断 80 字符：只作定位佐证，不记长文本 */
    char wt_trunc[96] = {0};
    if (window_title) {
        strncpy(wt_trunc, window_title, 80);
        wt_trunc[80] = '\0';
    }
    json_escape_into(wt_trunc, wt, sizeof(wt));
    DWORD session_id = 0;
    ProcessIdToSessionId(GetCurrentProcessId(), &session_id);
    snprintf(line, sizeof(line),
        "{\"ts\":\"%s\",\"trace_id\":\"%s\",\"request_id\":\"%s\",\"batch_id\":\"%s\","
        "\"seq\":%d,\"account_id\":\"%s\",\"device_id\":\"%s\",\"api_key_id\":\"%s\","
        "\"binding_epoch\":%ld,\"command\":\"%s\",\"params_hash\":\"%s\","
        "\"idempotency_key\":\"%s\",\"nonce\":\"%s\",\"result\":\"%s\",\"error_code\":\"%s\","
        "\"duration_ms\":%ld,\"ush_session_id\":%lu,\"process_id\":%lu,"
        "\"window_title\":\"%s\",\"retry_count\":%d}",
        ts, tid, rid, bid, req->seq, aid, did, kid, req->binding_epoch, cmd,
        params_hash, req->idempotency_key, nonce, res, ec, duration_ms,
        (unsigned long)session_id, (unsigned long)GetCurrentProcessId(),
        wt, retry_count);
    append_line(line);
}
