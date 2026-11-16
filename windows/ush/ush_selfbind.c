/* ush_selfbind.c — USH 自助绑定（C1）实现。见 ush_selfbind.h 的安全边界。
 *
 * 依赖：ncrypt（CNG 设备密钥）、bcrypt（SHA-256 摘要）、winhttp（服务端
 * complete/renew）、crypt32（DPAPI 凭据存取）。构建见 build.sh。
 */
#define _WIN32_WINNT 0x0A00
#define WINVER 0x0A00
#include <windows.h>
#include <ncrypt.h>
#include <bcrypt.h>
#include <winhttp.h>
#include <wincrypt.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include "ush_selfbind.h"
#include "ush_json.h"

#define SB_KEY_NAME L"QFR-LEA-DeviceKey"
#define SB_SERVER_DEFAULT "https://app.qfremote.top"
#define SB_CRED_FILE L"ush-credential.bin"
#define SB_META_FILE L"ush-credential.json"
#define SB_HTTP_TIMEOUT_MS 20000
#define SB_NONCE_BYTES 16

/* ---------- 小工具 ---------- */
static void sb_zero(void *p, size_t n) {
    if (p && n) { volatile unsigned char *v = (volatile unsigned char *)p; while (n--) *v++ = 0; }
}

/* %ProgramData%\QFR\LEA（USH 日志／token 同目录）；不存在即建。 */
static int sb_lea_dir_w(wchar_t *out, size_t out_chars) {
    wchar_t pd[MAX_PATH] = { 0 };
    DWORD n = GetEnvironmentVariableW(L"ProgramData", pd, MAX_PATH);
    if (n == 0 || n >= MAX_PATH) {
        if (wcscpy_s(pd, MAX_PATH, L"C:\\ProgramData") != 0) return 0;
    }
    if (_snwprintf_s(out, out_chars, _TRUNCATE, L"%s\\QFR\\LEA", pd) < 0) return 0;
    return 1;
}
static int sb_path_w(wchar_t *out, size_t out_chars, const wchar_t *file) {
    wchar_t dir[MAX_PATH] = { 0 };
    if (!sb_lea_dir_w(dir, MAX_PATH)) return 0;
    CreateDirectoryW(dir, NULL); /* 已存在即无操作 */
    if (_snwprintf_s(out, out_chars, _TRUNCATE, L"%s\\%s", dir, file) < 0) return 0;
    return 1;
}
static int sb_write_file_w(const wchar_t *path, const void *data, size_t len) {
    HANDLE h = CreateFileW(path, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS,
                           FILE_ATTRIBUTE_NORMAL, NULL);
    if (h == INVALID_HANDLE_VALUE) return 0;
    DWORD written = 0;
    BOOL ok = WriteFile(h, data, (DWORD)len, &written, NULL);
    CloseHandle(h);
    return ok && written == (DWORD)len;
}
static int sb_read_file_w(const wchar_t *path, char **out_buf, size_t *out_len) {
    HANDLE h = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING,
                           FILE_ATTRIBUTE_NORMAL, NULL);
    if (h == INVALID_HANDLE_VALUE) return 0;
    LARGE_INTEGER sz;
    if (!GetFileSizeEx(h, &sz) || sz.QuadPart <= 0 || sz.QuadPart > (LONGLONG)(16 * 1024 * 1024)) {
        CloseHandle(h);
        return 0;
    }
    char *buf = (char *)malloc((size_t)sz.QuadPart + 1);
    if (!buf) { CloseHandle(h); return 0; }
    DWORD got = 0;
    BOOL ok = ReadFile(h, buf, (DWORD)sz.QuadPart, &got, NULL);
    CloseHandle(h);
    if (!ok || got != (DWORD)sz.QuadPart) { free(buf); return 0; }
    buf[got] = '\0';
    *out_buf = buf;
    *out_len = got;
    return 1;
}
static void sb_delete_file_w(const wchar_t *path) { DeleteFileW(path); }

/* base64url（标准 base64 去填充、+/ 换 -_）；in 为二进制。 */
static int sb_b64url_encode(const unsigned char *in, size_t in_len, char *out, size_t out_size) {
    char tmp[256] = { 0 };
    if (in_len * 2 + 8 > sizeof(tmp)) return 0;
    if (!ush_base64_encode(in, in_len, tmp, sizeof(tmp))) return 0;
    size_t o = 0;
    for (size_t i = 0; tmp[i]; i++) {
        char c = tmp[i];
        if (c == '=') break;
        if (c == '+') c = '-';
        else if (c == '/') c = '_';
        if (o + 1 >= out_size) return 0;
        out[o++] = c;
    }
    out[o] = '\0';
    return 1;
}
/* 16 字节随机 nonce（BCryptGenRandom），base64url。 */
static int sb_random_nonce(char *out, size_t out_size) {
    unsigned char raw[SB_NONCE_BYTES];
    if (BCryptGenRandom(NULL, raw, sizeof(raw), BCRYPT_USE_SYSTEM_PREFERRED_RNG) != 0) return 0;
    int ok = sb_b64url_encode(raw, sizeof(raw), out, out_size);
    sb_zero(raw, sizeof(raw));
    return ok;
}
/* 去 node// 前缀（规范串与绑定台账键一律用裸形）。 */
static void sb_bare_device_id(const char *in, char *out, size_t out_size) {
    if (!in) in = "";
    if (strncmp(in, "node//", 6) == 0) in += 6;
    strncpy_s(out, out_size, in, _TRUNCATE);
}
/* 校验 nonce 字符集（与服务端一致：8..128 位 [A-Za-z0-9_-]）。 */
static int sb_nonce_valid(const char *s) {
    if (!s) return 0;
    size_t n = strlen(s);
    if (n < 8 || n > 128) return 0;
    for (size_t i = 0; i < n; i++) {
        char c = s[i];
        if (!((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
              (c >= '0' && c <= '9') || c == '-' || c == '_')) return 0;
    }
    return 1;
}

/* ---------- CNG 设备密钥（用户密钥库，常驻 "QFR-LEA-DeviceKey"） ---------- */
static int sb_open_device_key(NCRYPT_KEY_HANDLE *out, int create) {
    NCRYPT_PROV_HANDLE hProv = 0;
    NCRYPT_KEY_HANDLE hKey = 0;
    SECURITY_STATUS st = NCryptOpenStorageProvider(&hProv, MS_KEY_STORAGE_PROVIDER, 0);
    if (st != ERROR_SUCCESS) return 0;
    st = NCryptOpenKey(hProv, &hKey, SB_KEY_NAME, 0, 0);
    if (st == ERROR_SUCCESS) {
        NCryptFreeObject(hProv);
        *out = hKey;
        return 1;
    }
    if (!create || st != NTE_NO_KEY) {
        NCryptFreeObject(hProv);
        return 0;
    }
    st = NCryptCreatePersistedKey(hProv, &hKey, NCRYPT_ECDSA_P256_ALGORITHM,
                                  SB_KEY_NAME, 0, 0);
    if (st != ERROR_SUCCESS) { NCryptFreeObject(hProv); return 0; }
    DWORD usage = NCRYPT_ALLOW_SIGNING_FLAG;
    st = NCryptSetProperty(hKey, NCRYPT_KEY_USAGE_PROPERTY,
                           (PBYTE)&usage, sizeof(usage), 0);
    if (st != ERROR_SUCCESS) {
        NCryptFreeObject(hKey);
        NCryptFreeObject(hProv);
        return 0;
    }
    st = NCryptFinalizeKey(hKey, 0);
    NCryptFreeObject(hProv);
    if (st != ERROR_SUCCESS) { NCryptFreeObject(hKey); return 0; }
    *out = hKey;
    return 1;
}
/* 取设备公钥：65 字节未压缩点（0x04||X||Y）的 base64。 */
static int sb_device_pubkey(char *pub_b64, size_t pub_b64_size) {
    NCRYPT_KEY_HANDLE hKey = 0;
    if (!sb_open_device_key(&hKey, 1)) return 0;
    DWORD cbBlob = 0;
    SECURITY_STATUS st = NCryptExportKey(hKey, 0, BCRYPT_ECCPUBLIC_BLOB,
                                         NULL, NULL, 0, &cbBlob, 0);
    unsigned char *blob = NULL;
    int ok = 0;
    if (st == ERROR_SUCCESS && cbBlob >= 8 + 64) {
        blob = (unsigned char *)malloc(cbBlob);
        if (blob) {
            st = NCryptExportKey(hKey, 0, BCRYPT_ECCPUBLIC_BLOB, NULL,
                                 blob, cbBlob, &cbBlob, 0);
            if (st == ERROR_SUCCESS) {
                /* BCRYPT_ECCKEY_BLOB：dwMagic(4)＋cbKey(4)＋X＋Y。 */
                DWORD cbKey = *(DWORD *)(blob + 4);
                if (cbKey == 32) {
                    unsigned char point[65];
                    point[0] = 0x04;
                    memcpy(point + 1, blob + 8, 32);
                    memcpy(point + 33, blob + 40, 32);
                    /* 标准 base64（服务端按 base64 解，并原样入规范串）。 */
                    ok = ush_base64_encode(point, sizeof(point), pub_b64, pub_b64_size);
                    sb_zero(point, sizeof(point));
                }
            }
            free(blob);
        }
    }
    NCryptFreeObject(hKey);
    return ok;
}
/* 对规范串做 SHA-256＋ECDSA P-256 签名；输出 64 字节 r||s 的 base64。 */
static int sb_device_sign(const char *canonical, char *sig_b64, size_t sig_b64_size) {
    NCRYPT_KEY_HANDLE hKey = 0;
    if (!sb_open_device_key(&hKey, 0)) return 0;
    BCRYPT_ALG_HANDLE hAlg = NULL;
    BCRYPT_HASH_HANDLE hHash = NULL;
    unsigned char hash[32] = { 0 };
    unsigned char sig[64] = { 0 };
    DWORD cbSig = 0;
    int ok = 0;
    if (BCryptOpenAlgorithmProvider(&hAlg, BCRYPT_SHA256_ALGORITHM, NULL, 0) != 0) goto done;
    if (BCryptCreateHash(hAlg, &hHash, NULL, 0, NULL, 0, 0) != 0) goto done;
    if (BCryptHashData(hHash, (PBYTE)canonical, (ULONG)strlen(canonical), 0) != 0) goto done;
    if (BCryptFinishHash(hHash, hash, sizeof(hash), 0) != 0) goto done;
    /* ECDSA：NCryptSignHash 默认输出 r||s 原始格式（P1363，64 字节）。 */
    if (NCryptSignHash(hKey, NULL, hash, sizeof(hash), sig, sizeof(sig), &cbSig, 0) != ERROR_SUCCESS) goto done;
    if (cbSig != 64) goto done;
    ok = ush_base64_encode(sig, sizeof(sig), sig_b64, sig_b64_size);
done:
    if (hHash) BCryptDestroyHash(hHash);
    if (hAlg) BCryptCloseAlgorithmProvider(hAlg, 0);
    NCryptFreeObject(hKey);
    sb_zero(hash, sizeof(hash));
    sb_zero(sig, sizeof(sig));
    return ok;
}

/* ---------- WinHTTP（只认 https，绝不忽略证书校验） ---------- */
/* 注销规范串 v1（与服务端 /api/lea/v1/devices/{device_id}/deregister 约定死）：
 *   qfr-lea-deregister-v1\n<account_id>\n<device_id>\n<nonce>\n<timestamp>
 * device_id 一律用裸形（去 node// 前缀）；签名与 self-bind 同款：设备私钥
 * 对规范串 UTF-8 的 SHA-256 做 ECDSA P-256 签名，IEEE P1363（r||s，64 字节）
 * base64。服务端按绑定记录存量 device_pubkey 验签。 */
#define SB_DEREGISTER_CANONICAL_V1 "qfr-lea-deregister-v1"
#define SB_DEREGISTER_TIMEOUT_SHORT 1
/* 路径段 URL 编码：只留 unreserved 字符（A-Za-z0-9-._~），其余 %XX 大写。 */
static int sb_url_encode_segment(const char *in, char *out, size_t out_size) {
    static const char hexd[] = "0123456789ABCDEF";
    size_t o = 0;
    if (!in || !out || out_size < 1) return 0;
    for (size_t i = 0; in[i]; i++) {
        unsigned char c = (unsigned char)in[i];
        int unreserved = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
                         (c >= '0' && c <= '9') || c == '-' || c == '.' ||
                         c == '_' || c == '~';
        if (unreserved) {
            if (o + 1 >= out_size) return 0;
            out[o++] = (char)c;
        } else {
            if (o + 3 >= out_size) return 0;
            out[o++] = '%';
            out[o++] = hexd[(c >> 4) & 0xF];
            out[o++] = hexd[c & 0xF];
        }
    }
    out[o] = '\0';
    return 1;
}
static int sb_wide_from_utf8(const char *in, wchar_t *out, size_t out_chars) {
    if (!in) return 0;
    int n = MultiByteToWideChar(CP_UTF8, 0, in, -1, out, (int)out_chars);
    return n > 0;
}
/* POST https://{server_base}{path}。extra_headers 可为 NULL。
 * 成功（HTTP 200）时 resp_buf 得响应体；返回 1。网络／非 200 返回 0。
 * short_timeout=1 时用短超时（卸载注销用：resolve 2s＋connect 3s＋send 2s
 * ＋receive 3s，分段之和封顶 10 秒）；=0 时沿用 complete/renew 的原超时
 * （5s/5s/10s/20s），行为一字不变。 */
static int sb_https_post(const char *server_base, const char *path,
                         const char *body, const char *extra_headers,
                         char *resp_buf, size_t resp_size, long *out_status,
                         int short_timeout) {
    if (!server_base || strncmp(server_base, "https://", 8) != 0) return 0;
    const char *rest = server_base + 8;
    char host[256] = { 0 };
    size_t hi = 0;
    while (rest[hi] && rest[hi] != '/' && rest[hi] != ':' && hi + 1 < sizeof(host)) {
        host[hi] = rest[hi];
        hi++;
    }
    host[hi] = '\0';
    if (!host[0]) return 0;
    INTERNET_PORT port = INTERNET_DEFAULT_HTTPS_PORT;
    if (rest[hi] == ':') {
        long p = atol(rest + hi + 1);
        if (p <= 0 || p > 65535) return 0;
        port = (INTERNET_PORT)p;
    }
    wchar_t host_w[256] = { 0 }, path_w[512] = { 0 };
    if (!sb_wide_from_utf8(host, host_w, 256)) return 0;
    if (!sb_wide_from_utf8(path, path_w, 512)) return 0;
    HINTERNET hSession = NULL, hConnect = NULL, hReq = NULL;
    int ok = 0;
    long status = 0;
    hSession = WinHttpOpen(L"QFRemote-USH/1.0", WINHTTP_ACCESS_TYPE_DEFAULT_PROXY,
                           WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
    if (!hSession) return 0;
    if (short_timeout)
        WinHttpSetTimeouts(hSession, 2000, 3000, 2000, 3000);
    else
        WinHttpSetTimeouts(hSession, 5000, 5000, 10000, SB_HTTP_TIMEOUT_MS);
    hConnect = WinHttpConnect(hSession, host_w, port, 0);
    if (!hConnect) goto done;
    hReq = WinHttpOpenRequest(hConnect, L"POST", path_w, NULL, WINHTTP_NO_REFERER,
                              WINHTTP_DEFAULT_ACCEPT_TYPES, WINHTTP_FLAG_SECURE);
    if (!hReq) goto done;
    {
        char headers[2048] = { 0 };
        size_t ho = 0;
        int hn = snprintf(headers + ho, sizeof(headers) - ho,
                          "Content-Type: application/json\r\n");
        if (hn < 0) goto done;
        ho += (size_t)hn;
        if (extra_headers && extra_headers[0]) {
            if (ho + strlen(extra_headers) + 1 >= sizeof(headers)) goto done;
            memcpy(headers + ho, extra_headers, strlen(extra_headers));
            ho += strlen(extra_headers);
            headers[ho] = '\0';
        }
        wchar_t headers_w[2048] = { 0 };
        if (!sb_wide_from_utf8(headers, headers_w, 2048)) goto done;
        DWORD body_len = (DWORD)strlen(body);
        if (!WinHttpSendRequest(hReq, headers_w, (DWORD)wcslen(headers_w),
                                (LPVOID)body, body_len, body_len, 0)) goto done;
    }
    if (!WinHttpReceiveResponse(hReq, NULL)) goto done;
    {
        DWORD sc = 0, sc_len = sizeof(sc);
        if (!WinHttpQueryHeaders(hReq, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                                 WINHTTP_HEADER_NAME_BY_INDEX, &sc, &sc_len,
                                 WINHTTP_NO_HEADER_INDEX)) goto done;
        status = (long)sc;
    }
    {
        size_t total = 0;
        for (;;) {
            DWORD avail = 0;
            if (!WinHttpQueryDataAvailable(hReq, &avail)) goto done;
            if (avail == 0) break;
            if (total + avail + 1 > resp_size) goto done;
            DWORD got = 0;
            if (!WinHttpReadData(hReq, resp_buf + total, avail, &got)) goto done;
            total += got;
            if (got == 0) break;
        }
        resp_buf[total] = '\0';
    }
    ok = (status == 200);
done:
    if (hReq) WinHttpCloseHandle(hReq);
    if (hConnect) WinHttpCloseHandle(hConnect);
    if (hSession) WinHttpCloseHandle(hSession);
    if (out_status) *out_status = status;
    return ok;
}

/* ---------- DPAPI 凭据存取（当前用户级；密文只本 Windows 用户能解） ---------- */
static int sb_credential_store(const char *plaintext_json) {
    DATA_BLOB in = { 0 }, out = { 0 };
    in.pbData = (BYTE *)plaintext_json;
    in.cbData = (DWORD)strlen(plaintext_json) + 1;
    if (!CryptProtectData(&in, L"QFR-LEA credential", NULL, NULL, NULL, 0, &out)) return 0;
    wchar_t path[MAX_PATH] = { 0 };
    int ok = 0;
    if (sb_path_w(path, MAX_PATH, SB_CRED_FILE))
        ok = sb_write_file_w(path, out.pbData, out.cbData);
    LocalFree(out.pbData);
    return ok;
}
static int sb_credential_load(char *out, size_t out_size) {
    wchar_t path[MAX_PATH] = { 0 };
    char *blob = NULL;
    size_t blob_len = 0;
    DATA_BLOB in = { 0 }, dec = { 0 };
    int ok = 0;
    if (!sb_path_w(path, MAX_PATH, SB_CRED_FILE)) return 0;
    if (!sb_read_file_w(path, &blob, &blob_len)) return 0;
    in.pbData = (BYTE *)blob;
    in.cbData = (DWORD)blob_len;
    if (!CryptUnprotectData(&in, NULL, NULL, NULL, NULL, 0, &dec)) goto done;
    if (dec.cbData == 0 || dec.cbData >= out_size) goto done;
    memcpy(out, dec.pbData, dec.cbData);
    out[dec.cbData] = '\0';
    ok = 1;
done:
    if (dec.pbData) LocalFree(dec.pbData);
    free(blob);
    return ok;
}
/* 元数据（不含凭据明文）：key_id／key 前缀／expires_at／device／account／
 * 设备名／平台／binding_epoch。 */
static int sb_meta_write(const char *meta_json) {
    wchar_t path[MAX_PATH] = { 0 };
    if (!sb_path_w(path, MAX_PATH, SB_META_FILE)) return 0;
    return sb_write_file_w(path, meta_json, strlen(meta_json));
}
static int sb_meta_read(char *out, size_t out_size) {
    wchar_t path[MAX_PATH] = { 0 };
    char *buf = NULL;
    size_t len = 0;
    if (!sb_path_w(path, MAX_PATH, SB_META_FILE)) return 0;
    if (!sb_read_file_w(path, &buf, &len)) return 0;
    if (len + 1 > out_size) { free(buf); return 0; }
    memcpy(out, buf, len + 1);
    free(buf);
    return 1;
}
static void sb_meta_delete(void) {
    wchar_t path[MAX_PATH] = { 0 };
    if (sb_path_w(path, MAX_PATH, SB_META_FILE)) sb_delete_file_w(path);
}
static void sb_cred_delete(void) {
    wchar_t path[MAX_PATH] = { 0 };
    if (sb_path_w(path, MAX_PATH, SB_CRED_FILE)) sb_delete_file_w(path);
}
/* JSON 字符串字段转义后拼进 buffer（调用方负责引号与逗号）。 */
static int sb_json_str(char *buf, size_t buf_size, size_t *off, const char *key, const char *val) {
    char esc[1024] = { 0 };
    if (!ush_json_escape(val ? val : "", esc, sizeof(esc))) return 0;
    int n = snprintf(buf + *off, buf_size - *off, "\"%s\":\"%s\"", key, esc);
    if (n < 0 || (size_t)n >= buf_size - *off) return 0;
    *off += (size_t)n;
    return 1;
}

/* ---------- 四条命令 ---------- */
/* deliver-ticket：设备签名调 complete 换凭据。params：ticket／challenge／
 * nonce／device_name／platform／expires_at（秒）／server_base（可选）。
 * account_id／device_id 在顶层。成功后凭据进 DPAPI＋元数据落盘。 */
static int sb_cmd_deliver(const ush_request_t *rq, char *data_buf, size_t data_size,
                          char *err_code, size_t err_code_size,
                          char *err_text, size_t err_text_size) {
    char ticket[256] = { 0 }, challenge[128] = { 0 }, nonce[128] = { 0 };
    char devname[128] = { 0 }, platform[64] = { 0 }, server_base[256] = { 0 };
    long long expires_at = 0;
    char device_bare[128] = { 0 };
    if (!ush_json_get_string(rq->params_json, "ticket", ticket, sizeof(ticket)) || !ticket[0] ||
        !ush_json_get_string(rq->params_json, "challenge", challenge, sizeof(challenge)) || !challenge[0] ||
        !ush_json_get_string(rq->params_json, "nonce", nonce, sizeof(nonce)) || !nonce[0] ||
        !ush_json_get_llong(rq->params_json, "expires_at", &expires_at) || expires_at <= 0) {
        snprintf(err_code, err_code_size, "%s", USH_ERR_SELFBIND_BAD_TICKET);
        snprintf(err_text, err_text_size, "%s", "selfbind ticket fields missing or invalid");
        return 0;
    }
    if (strncmp(ticket, "sbt_", 4) != 0 || !sb_nonce_valid(nonce) ||
        expires_at <= (long long)time(NULL) ||
        !rq->account_id[0] || !rq->device_id[0]) {
        snprintf(err_code, err_code_size, "%s", USH_ERR_SELFBIND_BAD_TICKET);
        snprintf(err_text, err_text_size, "%s", "selfbind ticket invalid or expired");
        return 0;
    }
    ush_json_get_string(rq->params_json, "device_name", devname, sizeof(devname));
    ush_json_get_string(rq->params_json, "platform", platform, sizeof(platform));
    if (!ush_json_get_string(rq->params_json, "server_base", server_base, sizeof(server_base)) ||
        !server_base[0]) {
        strncpy_s(server_base, sizeof(server_base), SB_SERVER_DEFAULT, _TRUNCATE);
    }
    sb_bare_device_id(rq->device_id, device_bare, sizeof(device_bare));
    /* 设备公钥（CNG 常驻密钥，不存在即创建）。 */
    char pub_b64[128] = { 0 };
    if (!sb_device_pubkey(pub_b64, sizeof(pub_b64))) {
        snprintf(err_code, err_code_size, "%s", USH_ERR_SELFBIND_KEYSTORE);
        snprintf(err_text, err_text_size, "%s", "device key store unavailable");
        return 0;
    }
    /* 规范串（与服务端 selfBindCompleteSigningBytes 逐字节一致）。 */
    char canonical[2048] = { 0 };
    int cn = snprintf(canonical, sizeof(canonical),
                      "qfr-lea-selfbind-v1\n%s\n%s\n%s\n%s\n%s\n%s\n%lld",
                      rq->account_id, device_bare, ticket, challenge, nonce,
                      pub_b64, expires_at);
    if (cn < 0 || (size_t)cn >= sizeof(canonical)) {
        snprintf(err_code, err_code_size, "%s", USH_ERR_SELFBIND_BAD_TICKET);
        snprintf(err_text, err_text_size, "%s", "canonical string too long");
        return 0;
    }
    char sig_b64[128] = { 0 };
    if (!sb_device_sign(canonical, sig_b64, sizeof(sig_b64))) {
        snprintf(err_code, err_code_size, "%s", USH_ERR_SELFBIND_KEYSTORE);
        snprintf(err_text, err_text_size, "%s", "device signing failed");
        return 0;
    }
    /* 请求体（字符串逐个转义；device_name 可能含引号／中文）。 */
    char body[4096] = { 0 };
    size_t bo = 0;
    int okb = 1;
    #define SB_BODY_APPEND(...) do { \
        int _n = snprintf(body + bo, sizeof(body) - bo, __VA_ARGS__); \
        if (_n < 0 || (size_t)_n >= sizeof(body) - bo) { okb = 0; break; } \
        bo += (size_t)_n; \
    } while (0)
    SB_BODY_APPEND("{\"ticket\":");
    if (okb) { body[bo++] = '"'; okb = ush_json_escape(ticket, body + bo, sizeof(body) - bo) ? 1 : 0; if (okb) bo += strlen(body + bo); }
    SB_BODY_APPEND("\",\"account_id\":");
    if (okb) { body[bo++] = '"'; okb = ush_json_escape(rq->account_id, body + bo, sizeof(body) - bo) ? 1 : 0; if (okb) bo += strlen(body + bo); }
    SB_BODY_APPEND("\",\"device_id\":");
    if (okb) { body[bo++] = '"'; okb = ush_json_escape(device_bare, body + bo, sizeof(body) - bo) ? 1 : 0; if (okb) bo += strlen(body + bo); }
    SB_BODY_APPEND("\",\"nonce\":");
    if (okb) { body[bo++] = '"'; okb = ush_json_escape(nonce, body + bo, sizeof(body) - bo) ? 1 : 0; if (okb) bo += strlen(body + bo); }
    SB_BODY_APPEND("\",\"device_pubkey\":");
    if (okb) { body[bo++] = '"'; okb = ush_json_escape(pub_b64, body + bo, sizeof(body) - bo) ? 1 : 0; if (okb) bo += strlen(body + bo); }
    SB_BODY_APPEND("\",\"signature\":");
    if (okb) { body[bo++] = '"'; okb = ush_json_escape(sig_b64, body + bo, sizeof(body) - bo) ? 1 : 0; if (okb) bo += strlen(body + bo); }
    SB_BODY_APPEND("\"}");
    #undef SB_BODY_APPEND
    sb_zero(canonical, sizeof(canonical));
    sb_zero(sig_b64, sizeof(sig_b64));
    if (!okb) {
        snprintf(err_code, err_code_size, "%s", USH_ERR_SELFBIND_BAD_TICKET);
        snprintf(err_text, err_text_size, "%s", "request body too long");
        return 0;
    }
    char resp[8192] = { 0 };
    long status = 0;
    if (!sb_https_post(server_base, "/api/lea/v1/self-bind/complete", body, NULL,
                       resp, sizeof(resp), &status, 0)) {
        snprintf(err_code, err_code_size, "%s",
                 status ? USH_ERR_SELFBIND_SERVER : USH_ERR_SELFBIND_NETWORK);
        snprintf(err_text, err_text_size, "%s",
                 status ? "self-bind server rejected the request" : "cannot reach self-bind server");
        return 0;
    }
    /* 解析响应：顶层 key（明文，只进 DPAPI）＋record.key_id／expires_at
     * ＋顶层 binding_epoch。ok=false 即服务端拒绝。 */
    int rok = 0;
    if (!ush_json_get_bool(resp, "ok", &rok) || !rok) {
        char scode[64] = { 0 };
        ush_json_get_string(resp, "code", scode, sizeof(scode));
        snprintf(err_code, err_code_size, "%s", USH_ERR_SELFBIND_SERVER);
        snprintf(err_text, err_text_size, "self-bind rejected: %s",
                 scode[0] ? scode : "unknown");
        return 0;
    }
    char key_plain[256] = { 0 };
    char rec_json[4096] = { 0 };
    char key_id[64] = { 0 };
    long long new_expires = 0, binding_epoch = 0;
    if (!ush_json_get_string(resp, "key", key_plain, sizeof(key_plain)) || !key_plain[0] ||
        !ush_json_get_object(resp, "record", rec_json, sizeof(rec_json)) ||
        !ush_json_get_string(rec_json, "key_id", key_id, sizeof(key_id)) || !key_id[0] ||
        !ush_json_get_llong(rec_json, "expires_at", &new_expires) || new_expires <= 0) {
        snprintf(err_code, err_code_size, "%s", USH_ERR_SELFBIND_SERVER);
        snprintf(err_text, err_text_size, "%s", "self-bind response malformed");
        return 0;
    }
    ush_json_get_llong(resp, "binding_epoch", &binding_epoch);
    /* 存凭据（DPAPI）＋元数据。任一失败即报 STORE，不留半写凭据。 */
    char cred_json[512] = { 0 };
    int cn2 = snprintf(cred_json, sizeof(cred_json),
                       "{\"key\":\"%s\",\"key_id\":\"%s\",\"expires_at\":%lld}",
                       key_plain, key_id, new_expires);
    if (cn2 < 0 || (size_t)cn2 >= sizeof(cred_json) ||
        !sb_credential_store(cred_json)) {
        sb_zero(cred_json, sizeof(cred_json));
        sb_zero(key_plain, sizeof(key_plain));
        snprintf(err_code, err_code_size, "%s", USH_ERR_SELFBIND_STORE);
        snprintf(err_text, err_text_size, "%s", "cannot store credential");
        return 0;
    }
    sb_zero(cred_json, sizeof(cred_json));
    sb_zero(key_plain, sizeof(key_plain));
    char meta[2048] = { 0 };
    size_t mo = 0;
    mo += (size_t)snprintf(meta + mo, sizeof(meta) - mo, "{");
    if (!sb_json_str(meta, sizeof(meta), &mo, "key_id", key_id)) goto meta_fail;
    mo += (size_t)snprintf(meta + mo, sizeof(meta) - mo, ",\"expires_at\":%lld", new_expires);
    mo += (size_t)snprintf(meta + mo, sizeof(meta) - mo, ",\"binding_epoch\":%lld", binding_epoch);
    mo += (size_t)snprintf(meta + mo, sizeof(meta) - mo, ",");
    if (!sb_json_str(meta, sizeof(meta), &mo, "device_id", device_bare)) goto meta_fail;
    mo += (size_t)snprintf(meta + mo, sizeof(meta) - mo, ",");
    if (!sb_json_str(meta, sizeof(meta), &mo, "account_id", rq->account_id)) goto meta_fail;
    mo += (size_t)snprintf(meta + mo, sizeof(meta) - mo, ",");
    if (!sb_json_str(meta, sizeof(meta), &mo, "device_name", devname)) goto meta_fail;
    mo += (size_t)snprintf(meta + mo, sizeof(meta) - mo, ",");
    if (!sb_json_str(meta, sizeof(meta), &mo, "platform", platform)) goto meta_fail;
    mo += (size_t)snprintf(meta + mo, sizeof(meta) - mo, ",");
    if (!sb_json_str(meta, sizeof(meta), &mo, "server_base", server_base)) goto meta_fail;
    mo += (size_t)snprintf(meta + mo, sizeof(meta) - mo, "}");
    if (!sb_meta_write(meta)) goto meta_fail;
    /* 响应 data：只含 key_id／expires_at／binding_epoch，绝不含 Key 明文。 */
    snprintf(data_buf, data_size,
             "{\"key_id\":\"%s\",\"expires_at\":%lld,\"binding_epoch\":%lld}",
             key_id, new_expires, binding_epoch);
    return 1;
meta_fail:
    sb_cred_delete();
    snprintf(err_code, err_code_size, "%s", USH_ERR_SELFBIND_STORE);
    snprintf(err_text, err_text_size, "%s", "cannot store credential metadata");
    return 0;
}
/* clear-credential：删 DPAPI 凭据＋元数据（幂等：文件不存在也算成功）。 */
static int sb_cmd_clear(const ush_request_t *rq, char *data_buf, size_t data_size,
                        char *err_code, size_t err_code_size,
                        char *err_text, size_t err_text_size) {
    (void)rq; (void)err_code; (void)err_code_size; (void)err_text; (void)err_text_size;
    sb_cred_delete();
    sb_meta_delete();
    snprintf(data_buf, data_size, "{\"cleared\":true}");
    return 1;
}
/* status：读元数据报链接态（不含凭据明文；无元数据即未链接）。 */
static int sb_cmd_status(const ush_request_t *rq, char *data_buf, size_t data_size,
                         char *err_code, size_t err_code_size,
                         char *err_text, size_t err_text_size) {
    (void)rq; (void)err_code; (void)err_code_size; (void)err_text; (void)err_text_size;
    char meta[2048] = { 0 };
    if (!sb_meta_read(meta, sizeof(meta))) {
        snprintf(data_buf, data_size, "{\"linked\":false}");
        return 1;
    }
    char key_id[64] = { 0 }, device_id[128] = { 0 }, account_id[128] = { 0 };
    long long expires_at = 0;
    if (!ush_json_get_string(meta, "key_id", key_id, sizeof(key_id)) || !key_id[0]) {
        snprintf(data_buf, data_size, "{\"linked\":false}");
        return 1;
    }
    ush_json_get_llong(meta, "expires_at", &expires_at);
    ush_json_get_string(meta, "device_id", device_id, sizeof(device_id));
    ush_json_get_string(meta, "account_id", account_id, sizeof(account_id));
    char did_esc[256] = { 0 }, aid_esc[256] = { 0 };
    ush_json_escape(device_id, did_esc, sizeof(did_esc));
    ush_json_escape(account_id, aid_esc, sizeof(aid_esc));
    snprintf(data_buf, data_size,
             "{\"linked\":true,\"key_id\":\"%s\",\"expires_at\":%lld,"
             "\"device_id\":\"%s\",\"account_id\":\"%s\"}",
             key_id, expires_at, did_esc, aid_esc);
    return 1;
}
/* renew：静默续期。读本机凭据＋元数据，设备签名＋Bearer Key 调 renew，
 * 成功后更新元数据 expires_at（Key 明文不变）。 */
static int sb_cmd_renew(const ush_request_t *rq, char *data_buf, size_t data_size,
                        char *err_code, size_t err_code_size,
                        char *err_text, size_t err_text_size) {
    (void)rq; /* 续期所需账号／设备／Key 全从本机元数据＋凭据读，不用入参。 */
    char meta[2048] = { 0 };
    char cred[512] = { 0 };
    if (!sb_meta_read(meta, sizeof(meta)) || !sb_credential_load(cred, sizeof(cred))) {
        snprintf(err_code, err_code_size, "%s", USH_ERR_SELFBIND_NO_KEY);
        snprintf(err_text, err_text_size, "%s", "no local credential (not linked)");
        return 0;
    }
    char key_id[64] = { 0 }, device_id[128] = { 0 }, account_id[128] = { 0 };
    char server_base[256] = { 0 };
    char key_plain[256] = { 0 };
    if (!ush_json_get_string(meta, "key_id", key_id, sizeof(key_id)) || !key_id[0] ||
        !ush_json_get_string(meta, "device_id", device_id, sizeof(device_id)) || !device_id[0] ||
        !ush_json_get_string(meta, "account_id", account_id, sizeof(account_id)) || !account_id[0] ||
        !ush_json_get_string(cred, "key", key_plain, sizeof(key_plain)) || !key_plain[0]) {
        snprintf(err_code, err_code_size, "%s", USH_ERR_SELFBIND_NO_KEY);
        snprintf(err_text, err_text_size, "%s", "local credential incomplete");
        return 0;
    }
    if (!ush_json_get_string(meta, "server_base", server_base, sizeof(server_base)) ||
        !server_base[0]) {
        strncpy_s(server_base, sizeof(server_base), SB_SERVER_DEFAULT, _TRUNCATE);
    }
    char device_bare[128] = { 0 };
    sb_bare_device_id(device_id, device_bare, sizeof(device_bare));
    /* 续期 nonce＋时间戳：header 与签名共用同一份（防重放）。 */
    char nonce[64] = { 0 };
    if (!sb_random_nonce(nonce, sizeof(nonce))) {
        snprintf(err_code, err_code_size, "%s", USH_ERR_SELFBIND_KEYSTORE);
        snprintf(err_text, err_text_size, "%s", "cannot generate nonce");
        return 0;
    }
    long long ts = (long long)time(NULL);
    /* 规范串（与服务端 selfBindRenewSigningBytes 逐字节一致）。 */
    char canonical[1024] = { 0 };
    int cn = snprintf(canonical, sizeof(canonical),
                      "qfr-lea-selfbind-v1-renew\n%s\n%s\n%s\n%s\n%lld",
                      account_id, device_bare, key_id, nonce, ts);
    if (cn < 0 || (size_t)cn >= sizeof(canonical)) {
        snprintf(err_code, err_code_size, "%s", USH_ERR_SELFBIND_BAD_TICKET);
        snprintf(err_text, err_text_size, "%s", "canonical string too long");
        return 0;
    }
    char sig_b64[128] = { 0 };
    if (!sb_device_sign(canonical, sig_b64, sizeof(sig_b64))) {
        sb_zero(canonical, sizeof(canonical));
        snprintf(err_code, err_code_size, "%s", USH_ERR_SELFBIND_KEYSTORE);
        snprintf(err_text, err_text_size, "%s", "device signing failed");
        return 0;
    }
    sb_zero(canonical, sizeof(canonical));
    char body[1024] = { 0 };
    char body_esc[256] = { 0 };
    ush_json_escape(sig_b64, body_esc, sizeof(body_esc));
    sb_zero(sig_b64, sizeof(sig_b64));
    int bn = snprintf(body, sizeof(body),
                      "{\"device_id\":\"%s\",\"timestamp\":%lld,\"signature\":\"%s\"}",
                      device_bare, ts, body_esc);
    if (bn < 0 || (size_t)bn >= sizeof(body)) {
        snprintf(err_code, err_code_size, "%s", USH_ERR_SELFBIND_BAD_TICKET);
        snprintf(err_text, err_text_size, "%s", "request body too long");
        return 0;
    }
    char headers[1024] = { 0 };
    int hn = snprintf(headers, sizeof(headers),
                      "Authorization: Bearer %s\r\nX-QFR-Timestamp: %lld\r\nX-QFR-Nonce: %s\r\n",
                      key_plain, ts, nonce);
    if (hn < 0 || (size_t)hn >= sizeof(headers)) {
        snprintf(err_code, err_code_size, "%s", USH_ERR_SELFBIND_BAD_TICKET);
        snprintf(err_text, err_text_size, "%s", "request headers too long");
        return 0;
    }
    char resp[8192] = { 0 };
    long status = 0;
    if (!sb_https_post(server_base, "/api/lea/v1/self-bind/renew", body, headers,
                       resp, sizeof(resp), &status, 0)) {
        sb_zero(key_plain, sizeof(key_plain));
        snprintf(err_code, err_code_size, "%s",
                 status ? USH_ERR_SELFBIND_SERVER : USH_ERR_SELFBIND_NETWORK);
        snprintf(err_text, err_text_size, "%s",
                 status ? "self-bind renew rejected" : "cannot reach self-bind server");
        return 0;
    }
    sb_zero(key_plain, sizeof(key_plain));
    int rok = 0;
    if (!ush_json_get_bool(resp, "ok", &rok) || !rok) {
        char scode[64] = { 0 };
        ush_json_get_string(resp, "code", scode, sizeof(scode));
        snprintf(err_code, err_code_size, "%s", USH_ERR_SELFBIND_SERVER);
        snprintf(err_text, err_text_size, "self-bind renew rejected: %s",
                 scode[0] ? scode : "unknown");
        return 0;
    }
    char rec_json[4096] = { 0 };
    long long new_expires = 0;
    if (!ush_json_get_object(resp, "record", rec_json, sizeof(rec_json)) ||
        !ush_json_get_llong(rec_json, "expires_at", &new_expires) || new_expires <= 0) {
        snprintf(err_code, err_code_size, "%s", USH_ERR_SELFBIND_SERVER);
        snprintf(err_text, err_text_size, "%s", "self-bind renew response malformed");
        return 0;
    }
    /* 更新元数据与凭据里的 expires_at（Key 明文不变）。 */
    char cred_json[512] = { 0 };
    char key_plain2[256] = { 0 };
    if (!sb_credential_load(cred_json, sizeof(cred_json)) ||
        !ush_json_get_string(cred_json, "key", key_plain2, sizeof(key_plain2))) {
        snprintf(err_code, err_code_size, "%s", USH_ERR_SELFBIND_STORE);
        snprintf(err_text, err_text_size, "%s", "cannot reload credential");
        return 0;
    }
    int cn2 = snprintf(cred_json, sizeof(cred_json),
                       "{\"key\":\"%s\",\"key_id\":\"%s\",\"expires_at\":%lld}",
                       key_plain2, key_id, new_expires);
    sb_zero(key_plain2, sizeof(key_plain2));
    if (cn2 < 0 || (size_t)cn2 >= sizeof(cred_json) || !sb_credential_store(cred_json)) {
        sb_zero(cred_json, sizeof(cred_json));
        snprintf(err_code, err_code_size, "%s", USH_ERR_SELFBIND_STORE);
        snprintf(err_text, err_text_size, "%s", "cannot update credential");
        return 0;
    }
    sb_zero(cred_json, sizeof(cred_json));
    /* 元数据 expires_at 就地更新：重写整份（字段齐全时才写）。 */
    char meta_new[2048] = { 0 };
    size_t mo = 0;
    char devname[128] = { 0 }, platform[64] = { 0 };
    long long binding_epoch = 0;
    ush_json_get_string(meta, "device_name", devname, sizeof(devname));
    ush_json_get_string(meta, "platform", platform, sizeof(platform));
    ush_json_get_llong(meta, "binding_epoch", &binding_epoch);
    mo += (size_t)snprintf(meta_new + mo, sizeof(meta_new) - mo, "{");
    if (!sb_json_str(meta_new, sizeof(meta_new), &mo, "key_id", key_id)) goto meta_fail;
    mo += (size_t)snprintf(meta_new + mo, sizeof(meta_new) - mo, ",\"expires_at\":%lld", new_expires);
    mo += (size_t)snprintf(meta_new + mo, sizeof(meta_new) - mo, ",\"binding_epoch\":%lld", binding_epoch);
    mo += (size_t)snprintf(meta_new + mo, sizeof(meta_new) - mo, ",");
    if (!sb_json_str(meta_new, sizeof(meta_new), &mo, "device_id", device_bare)) goto meta_fail;
    mo += (size_t)snprintf(meta_new + mo, sizeof(meta_new) - mo, ",");
    if (!sb_json_str(meta_new, sizeof(meta_new), &mo, "account_id", account_id)) goto meta_fail;
    mo += (size_t)snprintf(meta_new + mo, sizeof(meta_new) - mo, ",");
    if (!sb_json_str(meta_new, sizeof(meta_new), &mo, "device_name", devname)) goto meta_fail;
    mo += (size_t)snprintf(meta_new + mo, sizeof(meta_new) - mo, ",");
    if (!sb_json_str(meta_new, sizeof(meta_new), &mo, "platform", platform)) goto meta_fail;
    mo += (size_t)snprintf(meta_new + mo, sizeof(meta_new) - mo, ",");
    if (!sb_json_str(meta_new, sizeof(meta_new), &mo, "server_base", server_base)) goto meta_fail;
    mo += (size_t)snprintf(meta_new + mo, sizeof(meta_new) - mo, "}");
    if (!sb_meta_write(meta_new)) goto meta_fail;
    snprintf(data_buf, data_size,
             "{\"key_id\":\"%s\",\"expires_at\":%lld}", key_id, new_expires);
    return 1;
meta_fail:
    snprintf(err_code, err_code_size, "%s", USH_ERR_SELFBIND_STORE);
    snprintf(err_text, err_text_size, "%s", "cannot update credential metadata");
    return 0;
}

/* deregister：卸载第 0 步的一次性注销（QFUserHelper.exe --deregister 入口，
 * 不走管道／token 门，由 ush.c main() 在单实例互斥之前分流）。
 * 只读本机自助绑定元数据（ush-credential.json：account_id／device_id／
 * server_base），设备私钥签名后调服务端注销接口，删服务端设备登记＋绑定。
 * 红线：
 *  - 付费 LEA 密钥绝不删：本函数永不读 ush-credential.bin（DPAPI 凭据文件，
 *    含 Key 明文）、永不发送 Key、永不调任何删 Key 接口；只注销设备登记。
 *  - 绝不新建设备密钥：sb_device_sign 以 create=0 开密钥，不存在即失败。
 *  - best-effort：无绑定／离线／服务端拒绝一律返回非 0 失败码，由调用方
 *    （NSIS）忽略并继续本地全清，绝不阻断卸载。
 * 返回：0=服务端已接受注销；1=noop（本机无自助绑定元数据或字段不全，
 * 无东西可注销）；2=已尝试但失败（keystore／network／server）。
 * out_json 写一行结果（不含任何凭据／签名／nonce 值，只有状态＋原因码）：
 *   {"deregister":"ok","reason":""} /
 *   {"deregister":"noop","reason":"no-credential"|"bad-meta"} /
 *   {"deregister":"failed","reason":"keystore"|"network"|"server"} */
int ush_selfbind_deregister(char *out_json, size_t out_size) {
    const char *status = "failed";
    const char *reason = "server";
    int rc = 2;
    char meta[2048] = { 0 };
    char account_id[128] = { 0 }, device_id[128] = { 0 }, server_base[256] = { 0 };
    char device_bare[128] = { 0 }, device_enc[384] = { 0 };
    char nonce[64] = { 0 };
    char canonical[1024] = { 0 };
    char sig_b64[128] = { 0 };
    char body[1024] = { 0 };
    char path[640] = { 0 };
    char resp[4096] = { 0 };
    long http_status = 0;

    if (!out_json || out_size < 16) return 2;
    out_json[0] = '\0';
    /* ① 身份来源：只认自助绑定元数据。无元数据＝本机未自助链接＝服务端
     * 无待注销的设备密钥登记（设备公钥只在 complete 时上服务端），noop。 */
    if (!sb_meta_read(meta, sizeof(meta))) {
        status = "noop"; reason = "no-credential"; rc = 1;
        goto done;
    }
    if (!ush_json_get_string(meta, "account_id", account_id, sizeof(account_id)) ||
        !ush_json_get_string(meta, "device_id", device_id, sizeof(device_id)) ||
        !account_id[0] || !device_id[0]) {
        status = "noop"; reason = "bad-meta"; rc = 1;
        goto done;
    }
    if (!ush_json_get_string(meta, "server_base", server_base, sizeof(server_base)) ||
        !server_base[0]) {
        strncpy_s(server_base, sizeof(server_base), SB_SERVER_DEFAULT, _TRUNCATE);
    }
    sb_bare_device_id(device_id, device_bare, sizeof(device_bare));
    if (!device_bare[0]) {
        status = "noop"; reason = "bad-meta"; rc = 1;
        goto done;
    }
    /* ② nonce＋时间戳＋规范串＋设备签名（复用 sb_device_sign，与
     * self-bind／renew 同一私钥、同一 P1363 编码，不改任何签名原语）。 */
    if (!sb_random_nonce(nonce, sizeof(nonce))) {
        status = "failed"; reason = "keystore"; rc = 2;
        goto done;
    }
    {
        long long ts = (long long)time(NULL);
        int cn = snprintf(canonical, sizeof(canonical),
                          SB_DEREGISTER_CANONICAL_V1 "\n%s\n%s\n%s\n%lld",
                          account_id, device_bare, nonce, ts);
        if (cn < 0 || (size_t)cn >= sizeof(canonical)) {
            status = "failed"; reason = "keystore"; rc = 2;
            goto done;
        }
        if (!sb_device_sign(canonical, sig_b64, sizeof(sig_b64))) {
            sb_zero(canonical, sizeof(canonical));
            status = "failed"; reason = "keystore"; rc = 2;
            goto done;
        }
        sb_zero(canonical, sizeof(canonical));
        /* ③ 请求体（固定契约，不许擅自改字段）＋路径（device_id 编码进段）。 */
        {
            char aid_esc[256] = { 0 }, did_esc[256] = { 0 };
            char nonce_esc[128] = { 0 }, sig_esc[256] = { 0 };
            ush_json_escape(account_id, aid_esc, sizeof(aid_esc));
            ush_json_escape(device_bare, did_esc, sizeof(did_esc));
            ush_json_escape(nonce, nonce_esc, sizeof(nonce_esc));
            ush_json_escape(sig_b64, sig_esc, sizeof(sig_esc));
            sb_zero(sig_b64, sizeof(sig_b64));
            int bn = snprintf(body, sizeof(body),
                              "{\"account_id\":\"%s\",\"device_id\":\"%s\","
                              "\"nonce\":\"%s\",\"timestamp\":%lld,\"signature\":\"%s\"}",
                              aid_esc, did_esc, nonce_esc, ts, sig_esc);
            if (bn < 0 || (size_t)bn >= sizeof(body)) {
                status = "failed"; reason = "server"; rc = 2;
                goto done;
            }
        }
        if (!sb_url_encode_segment(device_bare, device_enc, sizeof(device_enc))) {
            status = "failed"; reason = "server"; rc = 2;
            goto done;
        }
        {
            int pn = snprintf(path, sizeof(path),
                              "/api/lea/v1/devices/%s/deregister", device_enc);
            if (pn < 0 || (size_t)pn >= sizeof(path)) {
                status = "failed"; reason = "server"; rc = 2;
                goto done;
            }
        }
        /* ④ 短超时 POST（约 10 秒封顶）。200 且 body 未明示 ok=false 即接受；
         * 网络失败／非 200／ok=false 一律失败——调用方照常继续卸载。 */
        if (!sb_https_post(server_base, path, body, NULL,
                           resp, sizeof(resp), &http_status,
                           SB_DEREGISTER_TIMEOUT_SHORT)) {
            status = "failed";
            reason = http_status ? "server" : "network";
            rc = 2;
            goto done;
        }
        {
            int rok = 0;
            if (ush_json_get_bool(resp, "ok", &rok) && !rok) {
                status = "failed"; reason = "server"; rc = 2;
                goto done;
            }
        }
        status = "ok"; reason = ""; rc = 0;
    }
done:
    sb_zero(sig_b64, sizeof(sig_b64));
    sb_zero(meta, sizeof(meta));
    snprintf(out_json, out_size, "{\"deregister\":\"%s\",\"reason\":\"%s\"}",
             status, reason);
    return rc;
}

int ush_selfbind_dispatch(const ush_request_t *rq, char *data_buf, size_t data_size,
                          char *err_code, size_t err_code_size,
                          char *err_text, size_t err_text_size) {
    if (!rq || !data_buf || data_size < 16) return 0;
    data_buf[0] = '\0';
    if (err_code && err_code_size) err_code[0] = '\0';
    if (err_text && err_text_size) err_text[0] = '\0';
    switch (rq->cmd) {
    case USH_CMD_SELFBIND:
        return sb_cmd_deliver(rq, data_buf, data_size, err_code, err_code_size, err_text, err_text_size);
    case USH_CMD_SELFBIND_CLEAR:
        return sb_cmd_clear(rq, data_buf, data_size, err_code, err_code_size, err_text, err_text_size);
    case USH_CMD_SELFBIND_STATUS:
        return sb_cmd_status(rq, data_buf, data_size, err_code, err_code_size, err_text, err_text_size);
    case USH_CMD_SELFBIND_RENEW:
        return sb_cmd_renew(rq, data_buf, data_size, err_code, err_code_size, err_text, err_text_size);
    default:
        if (err_code && err_code_size) snprintf(err_code, err_code_size, "%s", USH_ERR_UNKNOWN_COMMAND);
        if (err_text && err_text_size) snprintf(err_text, err_text_size, "%s", "not a selfbind command");
        return 0;
    }
}
