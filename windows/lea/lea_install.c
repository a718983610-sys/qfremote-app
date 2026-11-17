/* QFRLEA 首装服务安装子命令（A1，2026-11-13）。接口见 lea_install.h。 */
#include "lea_install.h"
#include "lea_local.h" /* S-021：lea_is_local_control_subcommand */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <ctype.h>
#include <stdarg.h>

#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <sddl.h>
#include <aclapi.h>
#include <wincrypt.h>
#include "lea_protocol.h" /* LEA_VERSION_STR / LEA_PROTOCOL_VERSION */
#endif

/* ---------- 纯函数（全平台） ---------- */

static int seg_value(const char *s, size_t len, int *is_num) {
    /* 一段全数字 → 数值；否则 *is_num=0（调用方按字典序比）。 */
    int v = 0;
    *is_num = 1;
    if (len == 0) return 0;
    for (size_t i = 0; i < len; i++) {
        if (!isdigit((unsigned char)s[i])) { *is_num = 0; return 0; }
        v = v * 10 + (s[i] - '0');
        if (v > 1000000) v = 1000000; /* 防溢出钳制：版本号段不会这么大 */
    }
    return v;
}

int lea_version_compare(const char *a, const char *b) {
    const char *pa = (a && *a) ? a : "0";
    const char *pb = (b && *b) ? b : "0";
    for (;;) {
        const char *ea = strchr(pa, '.');
        const char *eb = strchr(pb, '.');
        size_t la = ea ? (size_t)(ea - pa) : strlen(pa);
        size_t lb = eb ? (size_t)(eb - pb) : strlen(pb);
        int na = 0, nb = 0;
        int va = seg_value(pa, la, &na);
        int vb = seg_value(pb, lb, &nb);
        if (na && nb) {
            if (va != vb) return va < vb ? -1 : 1;
        } else {
            /* 至少一段非数字：字典序比本段（长度不同时短的在前）。 */
            size_t m = la < lb ? la : lb;
            int c = m ? strncmp(pa, pb, m) : 0;
            if (c != 0) return c < 0 ? -1 : 1;
            if (la != lb) return la < lb ? -1 : 1;
        }
        if (!ea && !eb) return 0;
        pa = ea ? ea + 1 : pa + la;
        pb = eb ? eb + 1 : pb + lb;
        /* 一方已耗尽：剩余段全 0 即相等，否则耗尽方更小。 */
        if (!ea || !eb) {
            const char *rest = !ea ? pb : pa;
            int rest_nz = 0;
            for (const char *p = rest; *p; p++) {
                if (isdigit((unsigned char)*p) && *p != '0') { rest_nz = 1; break; }
                if (*p == '.') continue;
                if (!isdigit((unsigned char)*p)) { rest_nz = 1; break; }
            }
            if (!rest_nz) return 0;
            return !ea ? -1 : 1;
        }
    }
}

static int is_hex64(const char *s) {
    for (int i = 0; i < 64; i++) {
        if (!isxdigit((unsigned char)s[i])) return 0;
    }
    return 1;
}

static int path_is_safe_rel(const char *p) {
    if (!p || !*p) return 0;
    if (p[0] == '/' || p[0] == '\\') return 0;
    if (p[1] == ':' && ((p[0] >= 'A' && p[0] <= 'Z') || (p[0] >= 'a' && p[0] <= 'z'))) return 0;
    /* 拒绝任何 ".." 段（段首 ".." 且段尾为 / \ 或串尾）。 */
    for (const char *q = p; *q; q++) {
        if (q[0] == '.' && q[1] == '.' && (q == p || q[-1] == '/' || q[-1] == '\\') &&
            (q[2] == '\0' || q[2] == '/' || q[2] == '\\'))
            return 0;
    }
    return 1;
}

int lea_parse_manifest_line(const char *line, char *hash_out, size_t hash_size,
                            char *path_out, size_t path_size) {
    if (!line || !hash_out || hash_size < 65 || !path_out || path_size < 2) return 0;
    /* 去行尾换行／回车／行首空白。 */
    while (*line == ' ' || *line == '\t') line++;
    size_t ll = strlen(line);
    while (ll > 0 && (line[ll - 1] == '\n' || line[ll - 1] == '\r')) ll--;
    if (ll < 66) return 0; /* 64 hex ＋ 至少 1 空格 ＋ 至少 1 字符路径 */
    if (!is_hex64(line)) return 0;
    const char *p = line + 64;
    if (*p != ' ' && *p != '\t') return 0;
    while (*p == ' ' || *p == '\t') p++;
    if (*p == '*') p++; /* sha256sum 二进制标记 */
    if ((size_t)(line + ll - p) < 1) return 0;
    if ((size_t)(line + ll - p) >= path_size) return 0;
    char tmp[1024];
    size_t n = (size_t)(line + ll - p);
    if (n >= sizeof(tmp)) return 0;
    memcpy(tmp, p, n);
    tmp[n] = '\0';
    /* 行尾空白（生成器不会写，但防御性去掉）。 */
    while (n > 0 && (tmp[n - 1] == ' ' || tmp[n - 1] == '\t')) tmp[--n] = '\0';
    if (!path_is_safe_rel(tmp)) return 0;
    memcpy(hash_out, line, 64);
    hash_out[64] = '\0';
    /* hash 统一小写（比较时不区分大小写，但清单生成器写小写）。 */
    for (int i = 0; i < 64; i++) hash_out[i] = (char)tolower((unsigned char)hash_out[i]);
    strcpy(path_out, tmp);
    return 1;
}

int lea_is_service_subcommand(const char *arg) {
    if (!arg) return 0;
    return strcmp(arg, "--install-service") == 0 ||
           strcmp(arg, "--repair") == 0 ||
           strcmp(arg, "--uninstall-service") == 0 ||
           strcmp(arg, "--verify-manifest") == 0 ||
           strcmp(arg, "--migrate-revoked") == 0 ||
           /* S-021：本机控制子命令同样只认本地命令行，在服务启动前分流。 */
           lea_is_local_control_subcommand(arg);
}

#ifdef _WIN32
/* ---------- Windows 专属 ---------- */

#define LEA_SVC_NAME_W L"QFRLEA"
#define LEA_SVC_DISPLAY_W L"QFRemote \u672c\u5730\u6267\u884c\u4ee3\u7406"
#define LEA_REG_KEY_W L"SOFTWARE\\QFR\\LEA"
#define LEA_REG_COMPAT_W L"SOFTWARE\\QFRemote\\LEA"
#define LEA_DATA_SDDL_A "D:(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)"

static void log_line(const char *fmt, ...) {
    char line[2048];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(line, sizeof(line), fmt, ap);
    va_end(ap);
    fprintf(stderr, "LEA-INSTALL: %s\n", line);
    fflush(stderr);
}

static void utf16_to_utf8(const WCHAR *w, char *out, size_t out_size) {
    if (!w || !out || out_size < 1) return;
    WideCharToMultiByte(CP_UTF8, 0, w, -1, out, (int)out_size, NULL, NULL);
}

static void utf8_to_utf16(const char *u, WCHAR *out, size_t out_size) {
    if (!u || !out || out_size < 1) return;
    MultiByteToWideChar(CP_UTF8, 0, u, -1, out, (int)out_size);
}

static int mkdir_one_u8(const char *path) {
    WCHAR w[MAX_PATH];
    utf8_to_utf16(path, w, MAX_PATH);
    if (CreateDirectoryW(w, NULL)) return 1;
    return GetLastError() == ERROR_ALREADY_EXISTS;
}

static int set_dir_sys_admin_acl_u8(const char *path_utf8) {
    PSECURITY_DESCRIPTOR sd = NULL;
    if (!ConvertStringSecurityDescriptorToSecurityDescriptorA(
            LEA_DATA_SDDL_A, SDDL_REVISION_1, &sd, NULL))
        return 0;
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

int lea_sha256_file(const char *path_utf8, char *hex_out) {
    if (!path_utf8 || !hex_out) return 0;
    WCHAR w[MAX_PATH];
    utf8_to_utf16(path_utf8, w, MAX_PATH);
    HANDLE h = CreateFileW(w, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE,
                           NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (h == INVALID_HANDLE_VALUE) return 0;
    HCRYPTPROV prov = 0;
    HCRYPTHASH hash = 0;
    BYTE buf[65536];
    DWORD read = 0;
    int ok = 0;
    if (!CryptAcquireContextW(&prov, NULL, NULL, PROV_RSA_AES, CRYPT_VERIFYCONTEXT)) goto done;
    if (!CryptCreateHash(prov, CALG_SHA_256, 0, 0, &hash)) goto done;
    for (;;) {
        if (!ReadFile(h, buf, sizeof(buf), &read, NULL)) goto done;
        if (read == 0) break;
        if (!CryptHashData(hash, buf, read, 0)) goto done;
    }
    {
        BYTE digest[32];
        DWORD dlen = sizeof(digest);
        if (!CryptGetHashParam(hash, HP_HASHVAL, digest, &dlen, 0)) goto done;
        if (dlen != 32) goto done;
        static const char hexd[] = "0123456789abcdef";
        for (int i = 0; i < 32; i++) {
            hex_out[i * 2] = hexd[(digest[i] >> 4) & 0xF];
            hex_out[i * 2 + 1] = hexd[digest[i] & 0xF];
        }
        hex_out[64] = '\0';
        ok = 1;
    }
done:
    if (hash) CryptDestroyHash(hash);
    if (prov) CryptReleaseContext(prov, 0);
    CloseHandle(h);
    return ok;
}

static int is_admin(void) {
    BOOL member = FALSE;
    SID_IDENTIFIER_AUTHORITY auth = SECURITY_NT_AUTHORITY;
    PSID admin_sid = NULL;
    if (!AllocateAndInitializeSid(&auth, 2, SECURITY_BUILTIN_DOMAIN_RID,
                                  DOMAIN_ALIAS_RID_ADMINS, 0, 0, 0, 0, 0, 0, &admin_sid))
        return 0;
    CheckTokenMembership(NULL, admin_sid, &member);
    FreeSid(admin_sid);
    return member ? 1 : 0;
}

static void install_dir(char *out, size_t out_size) {
    WCHAR mod[MAX_PATH];
    GetModuleFileNameW(NULL, mod, MAX_PATH);
    WCHAR *slash = wcsrchr(mod, L'\\');
    if (slash) *slash = L'\0';
    utf16_to_utf8(mod, out, out_size);
}

static int read_first_line(const char *path, char *out, size_t out_size) {
    FILE *f = fopen(path, "r");
    if (!f) return 0;
    if (!fgets(out, (int)out_size, f)) { fclose(f); return 0; }
    fclose(f);
    size_t n = strlen(out);
    while (n > 0 && (out[n - 1] == '\n' || out[n - 1] == '\r' || out[n - 1] == ' ' || out[n - 1] == '\t'))
        out[--n] = '\0';
    return n > 0;
}

/* 注册表写字符串值（HKLM）。返回 1=成功。 */
static int reg_set_str(HKEY root, const WCHAR *sub, const WCHAR *name, const char *value_utf8) {
    HKEY k = NULL;
    if (RegCreateKeyExW(root, sub, 0, NULL, 0, KEY_SET_VALUE, NULL, &k, NULL) != ERROR_SUCCESS)
        return 0;
    WCHAR wv[1024];
    utf8_to_utf16(value_utf8 ? value_utf8 : "", wv, 1024);
    LONG rc = RegSetValueExW(k, name, 0, REG_SZ, (const BYTE *)wv,
                             (DWORD)((wcslen(wv) + 1) * sizeof(WCHAR)));
    RegCloseKey(k);
    return rc == ERROR_SUCCESS;
}

static int reg_get_str(HKEY root, const WCHAR *sub, const WCHAR *name, char *out, size_t out_size) {
    HKEY k = NULL;
    if (RegOpenKeyExW(root, sub, 0, KEY_READ, &k) != ERROR_SUCCESS) return 0;
    WCHAR wv[1024];
    DWORD len = sizeof(wv);
    DWORD type = 0;
    LONG rc = RegQueryValueExW(k, name, NULL, &type, (BYTE *)wv, &len);
    RegCloseKey(k);
    if (rc != ERROR_SUCCESS || type != REG_SZ) return 0;
    utf16_to_utf8(wv, out, out_size);
    return 1;
}

static void write_pending_repair(void) {
    reg_set_str(HKEY_LOCAL_MACHINE, LEA_REG_KEY_W, L"installState", "PendingRepair");
}

static int wait_service_state(SC_HANDLE svc, DWORD want, int timeout_sec) {
    for (int i = 0; i < timeout_sec * 2; i++) {
        SERVICE_STATUS st;
        memset(&st, 0, sizeof(st));
        if (!QueryServiceStatus(svc, &st)) return 0;
        if (st.dwCurrentState == want) return 1;
        Sleep(500);
    }
    return 0;
}

static int stop_service_if_present(SC_HANDLE scm) {
    SC_HANDLE svc = OpenServiceW(scm, LEA_SVC_NAME_W, SERVICE_STOP | SERVICE_QUERY_STATUS);
    if (!svc) return GetLastError() == ERROR_SERVICE_DOES_NOT_EXIST ? 1 : 0;
    SERVICE_STATUS st;
    memset(&st, 0, sizeof(st));
    if (QueryServiceStatus(svc, &st) && st.dwCurrentState != SERVICE_STOPPED) {
        ControlService(svc, SERVICE_CONTROL_STOP, &st);
        if (!wait_service_state(svc, SERVICE_STOPPED, 30)) {
            log_line("stop existing service timed out");
            CloseServiceHandle(svc);
            return 0;
        }
    }
    CloseServiceHandle(svc);
    return 1;
}

static int start_service_and_wait(SC_HANDLE scm) {
    SC_HANDLE svc = OpenServiceW(scm, LEA_SVC_NAME_W, SERVICE_START | SERVICE_QUERY_STATUS);
    if (!svc) { log_line("open service for start failed %lu", GetLastError()); return 0; }
    SERVICE_STATUS st;
    memset(&st, 0, sizeof(st));
    if (QueryServiceStatus(svc, &st) && st.dwCurrentState == SERVICE_RUNNING) {
        CloseServiceHandle(svc);
        return 1;
    }
    if (!StartServiceW(svc, 0, NULL)) {
        DWORD e = GetLastError();
        /* 已在启动中（START_PENDING）也算正在起来，等它跑完。 */
        if (e != ERROR_SERVICE_ALREADY_RUNNING) {
            log_line("start service failed %lu", e);
            CloseServiceHandle(svc);
            return 0;
        }
    }
    int ok = wait_service_state(svc, SERVICE_RUNNING, 30);
    if (!ok) log_line("service did not reach RUNNING in 30s");
    CloseServiceHandle(svc);
    return ok;
}

/* 读旧版 version.json 里的 main_version（升级时保留；读不到即 ""）。 */
static void read_old_main_version(const char *dir, char *out, size_t out_size) {
    char p[MAX_PATH + 32];
    snprintf(p, sizeof(p), "%s\\version.json", dir);
    FILE *f = fopen(p, "r");
    if (!f) { out[0] = '\0'; return; }
    char buf[2048];
    size_t n = fread(buf, 1, sizeof(buf) - 1, f);
    fclose(f);
    buf[n] = '\0';
    const char *k = strstr(buf, "\"main_version\"");
    if (!k) { out[0] = '\0'; return; }
    k = strchr(k, ':');
    if (!k) { out[0] = '\0'; return; }
    k++;
    while (*k == ' ' || *k == '\t') k++;
    if (*k != '"') { out[0] = '\0'; return; }
    k++; /* 开引号：空值时下一字符即闭引号，须先跳过开引号再抄（旧代码
            在此把 "," 当成值抄了出来，Wine 实测 version.json main_version=","）。 */
    size_t i = 0;
    while (k[i] && k[i] != '"' && i + 1 < out_size) { out[i] = k[i]; i++; }
    out[i] = '\0';
}

static void write_version_json(const char *dir, const char *lea_version, const char *main_version) {
    char p[MAX_PATH + 32];
    snprintf(p, sizeof(p), "%s\\version.json", dir);
    SYSTEMTIME st;
    GetLocalTime(&st);
    char tmp[MAX_PATH + 40];
    snprintf(tmp, sizeof(tmp), "%s.tmp", p);
    FILE *f = fopen(tmp, "w");
    if (!f) { log_line("cannot write version.json tmp"); return; }
    fprintf(f, "{\"lea_version\":\"%s\",\"main_version\":\"%s\",\"protocol_version\":%d,"
               "\"installed_at\":\"%04d-%02d-%02d %02d:%02d:%02d\"}",
            lea_version, main_version ? main_version : "", LEA_PROTOCOL_VERSION,
            st.wYear, st.wMonth, st.wDay, st.wHour, st.wMinute, st.wSecond);
    fclose(f);
    /* 原子替换：MoveFileEx 覆盖旧文件。 */
    WCHAR wt[MAX_PATH + 40], wp[MAX_PATH + 32];
    utf8_to_utf16(tmp, wt, MAX_PATH + 40);
    utf8_to_utf16(p, wp, MAX_PATH + 32);
    if (!MoveFileExW(wt, wp, MOVEFILE_REPLACE_EXISTING)) {
        log_line("version.json replace failed %lu", GetLastError());
        DeleteFileW(wt);
    }
}

static void write_registry_all(const char *dir, const char *lea_version,
                               const char *main_version, const char *hashes) {
    /* A1 新键 HKLM\SOFTWARE\QFR\LEA（PLAN §2 A1）。 */
    reg_set_str(HKEY_LOCAL_MACHINE, LEA_REG_KEY_W, L"installDir", dir);
    reg_set_str(HKEY_LOCAL_MACHINE, LEA_REG_KEY_W, L"version", lea_version);
    reg_set_str(HKEY_LOCAL_MACHINE, LEA_REG_KEY_W, L"fileHashes", hashes);
    reg_set_str(HKEY_LOCAL_MACHINE, LEA_REG_KEY_W, L"installState", "Installed");
    /* 兼容旧键（install-lea.ps1 的 Get-InstalledLeaVersion 读它）。 */
    reg_set_str(HKEY_LOCAL_MACHINE, LEA_REG_COMPAT_W, L"QFR_LEA_Version", lea_version);
    reg_set_str(HKEY_LOCAL_MACHINE, LEA_REG_COMPAT_W, L"QFR_Main_Version", main_version ? main_version : "");
    {
        char proto[16];
        snprintf(proto, sizeof(proto), "%d", LEA_PROTOCOL_VERSION);
        reg_set_str(HKEY_LOCAL_MACHINE, LEA_REG_COMPAT_W, L"Protocol_Version", proto);
    }
}

static int ensure_data_dirs(void) {
    char pd[MAX_PATH] = { 0 };
    WCHAR wpd[MAX_PATH];
    DWORD n = GetEnvironmentVariableW(L"ProgramData", wpd, MAX_PATH);
    if (n == 0 || n >= MAX_PATH) wcscpy_s(wpd, MAX_PATH, L"C:\\ProgramData");
    utf16_to_utf8(wpd, pd, sizeof(pd));
    char base[MAX_PATH], sub[MAX_PATH];
    snprintf(base, sizeof(base), "%s\\QFR\\LEA", pd);
    {
        char qfr[MAX_PATH];
        snprintf(qfr, sizeof(qfr), "%s\\QFR", pd);
        mkdir_one_u8(qfr);
    }
    mkdir_one_u8(base);
    const char *subs[] = { "inbox", "logs", "state" };
    for (int i = 0; i < 3; i++) {
        snprintf(sub, sizeof(sub), "%s\\%s", base, subs[i]);
        mkdir_one_u8(sub);
        if (!set_dir_sys_admin_acl_u8(sub))
            log_line("warning: acl failed for %s", sub);
    }
    if (!set_dir_sys_admin_acl_u8(base))
        log_line("warning: acl failed for %s", base);
    return 1;
}

int lea_service_install(int repair) {
    if (!is_admin()) {
        log_line("failed not-admin (run as administrator)");
        return 2;
    }
    char dir[MAX_PATH] = { 0 };
    install_dir(dir, sizeof(dir));
    if (!dir[0]) { log_line("failed cannot locate install dir"); return 1; }

    /* 版本：包内 version.txt 为准（验收：注册表版本＝version.txt）。 */
    char version[64] = { 0 };
    {
        char vf[MAX_PATH + 32];
        snprintf(vf, sizeof(vf), "%s\\version.txt", dir);
        if (!read_first_line(vf, version, sizeof(version)))
            snprintf(version, sizeof(version), "%s", LEA_VERSION_STR);
    }
    char old_version[64] = { 0 };
    reg_get_str(HKEY_LOCAL_MACHINE, LEA_REG_KEY_W, L"version", old_version, sizeof(old_version));
    if (!old_version[0])
        reg_get_str(HKEY_LOCAL_MACHINE, LEA_REG_COMPAT_W, L"QFR_LEA_Version", old_version, sizeof(old_version));
    int is_upgrade = old_version[0] && lea_version_compare(version, old_version) != 0;
    log_line("%s version=%s old=%s dir=%s",
             repair ? "repair" : (is_upgrade ? "upgrade" : "install"),
             version, old_version[0] ? old_version : "(none)", dir);

    char main_version[64] = { 0 };
    read_old_main_version(dir, main_version, sizeof(main_version));

    /* ① 数据目录＋ACL（与 install-lea.ps1 ③步同款）。 */
    ensure_data_dirs();

    /* ② 停旧服务（升级／修复时；全新安装时无服务即跳过）。 */
    SC_HANDLE scm = OpenSCManagerW(NULL, NULL, SC_MANAGER_ALL_ACCESS);
    if (!scm) { log_line("failed open SCM %lu", GetLastError()); write_pending_repair(); return 1; }

    SC_HANDLE old = OpenServiceW(scm, LEA_SVC_NAME_W, SERVICE_QUERY_CONFIG | SERVICE_QUERY_STATUS);
    char old_binpath[1024] = { 0 };
    DWORD old_start = SERVICE_AUTO_START;
    if (old) {
        DWORD need = 0;
        QueryServiceConfigW(old, NULL, 0, &need);
        if (GetLastError() == ERROR_INSUFFICIENT_BUFFER && need > 0) {
            LPQUERY_SERVICE_CONFIGW cfg = (LPQUERY_SERVICE_CONFIGW)malloc(need);
            if (cfg && QueryServiceConfigW(old, cfg, need, &need)) {
                utf16_to_utf8(cfg->lpBinaryPathName, old_binpath, sizeof(old_binpath));
                old_start = cfg->dwStartType;
            }
            free(cfg);
        }
        CloseServiceHandle(old);
        /* 升级前记旧配置（回滚用）。 */
        if (old_binpath[0]) {
            reg_set_str(HKEY_LOCAL_MACHINE, LEA_REG_KEY_W, L"rollbackBinPath", old_binpath);
            char st[16];
            snprintf(st, sizeof(st), "%lu", (unsigned long)old_start);
            reg_set_str(HKEY_LOCAL_MACHINE, LEA_REG_KEY_W, L"rollbackStartType", st);
            reg_set_str(HKEY_LOCAL_MACHINE, LEA_REG_KEY_W, L"rollbackVersion", old_version);
        }
    }
    if (!stop_service_if_present(scm)) {
        log_line("failed stop existing service");
        CloseServiceHandle(scm);
        write_pending_repair();
        return 1;
    }

    /* ③ 创建／更新服务。binPath 只取本 exe 所在目录，绝不接受外来路径。 */
    char exe_path[MAX_PATH + 16];
    snprintf(exe_path, sizeof(exe_path), "%s\\QFRLEA.exe", dir);
    WCHAR wbin[MAX_PATH + 16];
    {
        char quoted[MAX_PATH + 20];
        snprintf(quoted, sizeof(quoted), "\"%s\"", exe_path);
        utf8_to_utf16(quoted, wbin, MAX_PATH + 16);
    }
    SC_HANDLE svc = OpenServiceW(scm, LEA_SVC_NAME_W, SERVICE_CHANGE_CONFIG | SERVICE_QUERY_STATUS);
    if (!svc) {
        if (GetLastError() != ERROR_SERVICE_DOES_NOT_EXIST) {
            log_line("failed open service for config %lu", GetLastError());
            CloseServiceHandle(scm);
            write_pending_repair();
            return 1;
        }
        svc = CreateServiceW(scm, LEA_SVC_NAME_W, LEA_SVC_DISPLAY_W,
                             SERVICE_ALL_ACCESS, SERVICE_WIN32_OWN_PROCESS,
                             SERVICE_AUTO_START, SERVICE_ERROR_NORMAL,
                             wbin, NULL, NULL, NULL, NULL, NULL);
        if (!svc) {
            log_line("failed create service %lu", GetLastError());
            CloseServiceHandle(scm);
            write_pending_repair();
            return 1;
        }
        log_line("service created");
    } else {
        if (!ChangeServiceConfigW(svc, SERVICE_WIN32_OWN_PROCESS, SERVICE_AUTO_START,
                                  SERVICE_ERROR_NORMAL, wbin, NULL, NULL, NULL, NULL, NULL, NULL)) {
            log_line("failed update binPath %lu", GetLastError());
            CloseServiceHandle(svc);
            CloseServiceHandle(scm);
            write_pending_repair();
            return 1;
        }
        log_line("service config updated");
    }
    /* 描述＋失败恢复（第 1/2 次 5 秒、后续 30 秒，reset 86400 秒）。 */
    {
        SERVICE_DESCRIPTIONW desc;
        WCHAR wdesc[256];
        wcscpy_s(wdesc, 256, L"QFRemote \u672c\u5730\u6267\u884c\u4ee3\u7406\uff1a\u670d\u52a1\u7aef\u7b7e\u540d\u7684\u6307\u4ee4\u7ecf\u672c\u673a\u6267\u884c\uff0cUI \u7c7b\u8f6c\u7528\u6237\u4f1a\u8bdd\u52a9\u624b\u3002");
        desc.lpDescription = wdesc;
        ChangeServiceConfig2W(svc, SERVICE_CONFIG_DESCRIPTION, &desc);
        SC_ACTION actions[3];
        actions[0].Type = SC_ACTION_RESTART; actions[0].Delay = 5000;
        actions[1].Type = SC_ACTION_RESTART; actions[1].Delay = 5000;
        actions[2].Type = SC_ACTION_RESTART; actions[2].Delay = 30000;
        SERVICE_FAILURE_ACTIONSW fa;
        memset(&fa, 0, sizeof(fa));
        fa.dwResetPeriod = 86400;
        fa.cActions = 3;
        fa.lpsaActions = actions;
        if (!ChangeServiceConfig2W(svc, SERVICE_CONFIG_FAILURE_ACTIONS, &fa))
            log_line("warning: failure actions not set %lu", GetLastError());
    }
    CloseServiceHandle(svc);

    /* ④ 启动并校验 RUNNING；失败则尝试回滚旧服务配置并重起。 */
    if (!start_service_and_wait(scm)) {
        log_line("service start failed, attempting rollback to previous config");
        if (old_binpath[0]) {
            SC_HANDLE rs = OpenServiceW(scm, LEA_SVC_NAME_W, SERVICE_CHANGE_CONFIG);
            if (rs) {
                WCHAR wb[1024];
                utf8_to_utf16(old_binpath, wb, 1024);
                if (ChangeServiceConfigW(rs, SERVICE_WIN32_OWN_PROCESS, old_start,
                                        SERVICE_ERROR_NORMAL, wb, NULL, NULL, NULL, NULL, NULL, NULL))
                    log_line("rolled back binPath to previous service config");
                CloseServiceHandle(rs);
            }
            if (start_service_and_wait(scm))
                log_line("rollback: old service running again");
            else
                log_line("rollback: old service could NOT be restarted");
        }
        CloseServiceHandle(scm);
        write_pending_repair();
        return 1;
    }
    CloseServiceHandle(scm);

    /* ⑤ 关键文件哈希＋注册表＋version.json。 */
    {
        const char *names[] = { "QFRLEA.exe", "qf-lea-client.exe", "QFUserHelper.exe" };
        char hashes[1024] = { 0 };
        size_t off = 0;
        for (int i = 0; i < 3; i++) {
            char p[MAX_PATH + 32];
            snprintf(p, sizeof(p), "%s\\%s", dir, names[i]);
            char h[65] = { 0 };
            if (!lea_sha256_file(p, h)) {
                log_line("failed hash %s (missing or unreadable)", names[i]);
                write_pending_repair();
                return 1;
            }
            off += (size_t)snprintf(hashes + off, sizeof(hashes) - off,
                                    "%s%s=%s", i ? ";" : "", names[i], h);
        }
        write_registry_all(dir, version, main_version, hashes);
        write_version_json(dir, version, main_version);
    }
    /* 回滚快照用完即清（成功路径不留旧 binPath，避免下次误回滚）。 */
    RegDeleteKeyValueW(HKEY_LOCAL_MACHINE, LEA_REG_KEY_W, L"rollbackBinPath");
    RegDeleteKeyValueW(HKEY_LOCAL_MACHINE, LEA_REG_KEY_W, L"rollbackStartType");
    RegDeleteKeyValueW(HKEY_LOCAL_MACHINE, LEA_REG_KEY_W, L"rollbackVersion");
    log_line("ok version=%s service RUNNING", version);
    return 0;
}

int lea_service_uninstall(void) {
    if (!is_admin()) {
        log_line("failed not-admin (run as administrator)");
        return 2;
    }
    SC_HANDLE scm = OpenSCManagerW(NULL, NULL, SC_MANAGER_ALL_ACCESS);
    if (!scm) { log_line("failed open SCM %lu", GetLastError()); return 1; }
    if (!stop_service_if_present(scm)) {
        log_line("failed stop service for uninstall");
        CloseServiceHandle(scm);
        return 1;
    }
    SC_HANDLE svc = OpenServiceW(scm, LEA_SVC_NAME_W, DELETE);
    if (svc) {
        if (!DeleteService(svc))
            log_line("warning: delete service failed %lu", GetLastError());
        else
            log_line("service deleted");
        CloseServiceHandle(svc);
    } else if (GetLastError() != ERROR_SERVICE_DOES_NOT_EXIST) {
        log_line("failed open service for delete %lu", GetLastError());
        CloseServiceHandle(scm);
        return 1;
    }
    CloseServiceHandle(scm);
    RegDeleteTreeW(HKEY_LOCAL_MACHINE, LEA_REG_KEY_W);
    log_line("ok service removed");
    return 0;
}

int lea_verify_manifest(const char *dir_utf8, const char *manifest_utf8) {
    if (!dir_utf8 || !manifest_utf8) return 2;
    FILE *f = fopen(manifest_utf8, "r");
    if (!f) { log_line("failed cannot read manifest %s", manifest_utf8); return 2; }
    char line[2048];
    int checked = 0, bad = 0, bad_lines = 0;
    while (fgets(line, sizeof(line), f)) {
        size_t n = strlen(line);
        while (n > 0 && (line[n - 1] == '\n' || line[n - 1] == '\r')) line[--n] = '\0';
        if (n == 0) continue;
        char hash[65] = { 0 }, rel[1024] = { 0 };
        if (!lea_parse_manifest_line(line, hash, sizeof(hash), rel, sizeof(rel))) {
            log_line("manifest bad line: %s", line);
            bad_lines++;
            continue;
        }
        char full[MAX_PATH + 1024];
        /* 清单用 '/' 分隔，Windows 路径换成 '\'。 */
        char rel_win[1024];
        size_t ri = 0;
        for (size_t i = 0; rel[i] && ri + 1 < sizeof(rel_win); i++)
            rel_win[ri++] = (rel[i] == '/') ? '\\' : rel[i];
        rel_win[ri] = '\0';
        snprintf(full, sizeof(full), "%s\\%s", dir_utf8, rel_win);
        char actual[65] = { 0 };
        checked++;
        if (!lea_sha256_file(full, actual)) {
            log_line("MISSING/UNREADABLE %s", rel);
            bad++;
        } else if (strcmp(actual, hash) != 0) {
            log_line("HASH-MISMATCH %s", rel);
            bad++;
        }
    }
    fclose(f);
    if (bad_lines > 0) { log_line("failed %d bad manifest lines", bad_lines); return 2; }
    if (checked == 0) { log_line("failed manifest empty"); return 2; }
    if (bad > 0) { log_line("failed %d/%d files bad", bad, checked); return 1; }
    log_line("ok %d files verified", checked);
    return 0;
}

#endif /* _WIN32 */
