/* 见 ush_snapshot.h。 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <aclapi.h>
#include <ole2.h>
#include <wincodec.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "ush_snapshot.h"

static volatile LONG g_snapshot_sequence = 0;

#define USH_INLINE_MAX_BYTES (6 * 1024 * 1024) /* 内联 PNG 上限 6MB */
/* H24：截图落盘上限——目录内最多保留 50 个文件、超过 7 天的删。 */
#define USH_SNAPSHOT_MAX_FILES 50
#define USH_SNAPSHOT_MAX_AGE_DAYS 7

/* ---------- 窗口查找（标题子串 + 类名精确） ---------- */

typedef struct {
    WCHAR title_sub[256];
    WCHAR class_name[128];
    HWND found;
} find_win_ctx_t;

static BOOL CALLBACK enum_win_proc(HWND hwnd, LPARAM lp) {
    find_win_ctx_t *c = (find_win_ctx_t *)lp;
    if (!IsWindowVisible(hwnd)) return TRUE;
    if (c->class_name[0]) {
        WCHAR cls[128];
        if (GetClassNameW(hwnd, cls, 128) == 0 || wcscmp(cls, c->class_name) != 0) return TRUE;
    }
    if (c->title_sub[0]) {
        WCHAR title[512];
        if (GetWindowTextW(hwnd, title, 512) == 0) return TRUE;
        if (wcsstr(title, c->title_sub) == NULL) return TRUE;
    }
    c->found = hwnd;
    return FALSE; /* 停 */
}

static HWND find_window_by_title(const char *title_utf8, const char *class_utf8) {
    find_win_ctx_t ctx;
    memset(&ctx, 0, sizeof(ctx));
    if (title_utf8 && title_utf8[0]) {
        MultiByteToWideChar(CP_UTF8, 0, title_utf8, -1, ctx.title_sub, 256);
    }
    if (class_utf8 && class_utf8[0]) {
        MultiByteToWideChar(CP_UTF8, 0, class_utf8, -1, ctx.class_name, 128);
    }
    EnumWindows(enum_win_proc, (LPARAM)&ctx);
    return ctx.found;
}

/* ---------- 抓屏到 32bpp DIB（top-down） ---------- */

typedef struct {
    HBITMAP hbmp;
    void *bits;
    int width, height;
    int stride; /* width*4 */
} capture_t;

static int capture_rect(RECT rc, capture_t *out) {
    memset(out, 0, sizeof(*out));
    out->width = rc.right - rc.left;
    out->height = rc.bottom - rc.top;
    if (out->width <= 0 || out->height <= 0 || out->width > 16384 || out->height > 16384) return 0;
    out->stride = out->width * 4;
    HDC screen = GetDC(NULL);
    if (!screen) return 0;
    HDC mem = CreateCompatibleDC(screen);
    if (!mem) { ReleaseDC(NULL, screen); return 0; }
    BITMAPINFO bi;
    memset(&bi, 0, sizeof(bi));
    bi.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
    bi.bmiHeader.biWidth = out->width;
    bi.bmiHeader.biHeight = -out->height; /* top-down */
    bi.bmiHeader.biPlanes = 1;
    bi.bmiHeader.biBitCount = 32;
    bi.bmiHeader.biCompression = BI_RGB;
    out->hbmp = CreateDIBSection(mem, &bi, DIB_RGB_COLORS, &out->bits, NULL, 0);
    if (!out->hbmp || !out->bits) {
        if (out->hbmp) DeleteObject(out->hbmp);
        DeleteDC(mem);
        ReleaseDC(NULL, screen);
        return 0;
    }
    HGDIOBJ old = SelectObject(mem, out->hbmp);
    BOOL ok = BitBlt(mem, 0, 0, out->width, out->height, screen, rc.left, rc.top, SRCCOPY);
    SelectObject(mem, old);
    DeleteDC(mem);
    ReleaseDC(NULL, screen);
    if (!ok) {
        DeleteObject(out->hbmp);
        out->hbmp = NULL;
        return 0;
    }
    return 1;
}

static void capture_free(capture_t *c) {
    if (c->hbmp) DeleteObject(c->hbmp);
    c->hbmp = NULL;
    c->bits = NULL;
}

/* ---------- WIC 编 PNG ---------- */

/* 编到 IStream；成功返回 1。
 * r9：USH 管道线程（ush.c pipe_loop）从未调 CoInitializeEx——UIA 是
 * 主线程建的、管道线程直接调虚表才“碰巧”能跑，但本函数调
 * CoCreateInstance(CLSID_WICImagingFactory) 须调用线程已初始化 COM，
 * 未初始化即 CO_E_NOTINITIALIZED，截图恒报 "PNG encode failed"
 * （r8 裸形手动派发 ui.snapshot 47ms 即败，抓屏本身已成功）。
 * 修法：本函数内按需 CoInitializeEx(COINIT_MULTITHREADED)；只有当
 * 本次调用真的由我们初始化时才在返回前 CoUninitialize，保证进出
 * 平衡。M010 已将 UIA 的创建、调用和释放全部移到同一个 MTA 管道线程，
 * 不再跨套间直接复用主线程的 STA 对象；此处仍可单独在未初始化线程调用。
 * RPC_E_CHANGED_MODE（线程已被别处以另一模式初始化）时不反初始化、
 * 直接往下走。
 * r9-diag（真机仍败，file/inline 均 31ms）：本函数与两处调用点现把失败步骤＋
 * HRESULT＋CoInitializeEx 结果＋抓屏尺寸带回 err_text，定位到步再修。
 * r9-fix2（真机诊断结论）：失败点是 CreateEncoder/PNG hr=0x88982F50
 * （init=S_OK、抓屏 1024x768 均正常）；独立探针证实：直接 CoCreateInstance
 * 编码器 CLSID 全成功（PNG/BMP 编码器、PNG 解码器均为 S_OK），而工厂
 * CreateEncoder/CreateDecoder 全灭；注册表 InprocServer32 正常
 * （%SystemRoot%\system32\windowscodecs.dll，Both，DLL 完整 1782440 字节），
 * 但 CLSID 下无 Implemented Categories 子键——本机 WIC 元数据注册不完整，
 * 工厂创建编码器前先查元数据故报 COMPONENTNOTFOUND。修法：编码器改直接
 * CoCreateInstance（工厂能建的直接也能建，无需回退）；工厂只保留给
 * file 模式建流（CreateStream 本身正常）。 */
static int encode_png_to_stream(const capture_t *cap, IStream *stream,
                                HRESULT *hr_out, const char **step_out, HRESULT *hr_init_out) {
    int com_init_here = 0;
    HRESULT hr_init = CoInitializeEx(NULL, COINIT_MULTITHREADED);
    if (hr_init_out) *hr_init_out = hr_init;
    if (hr_out) *hr_out = S_OK;
    if (step_out) *step_out = "ok";
    /* COM 规则：CoInitializeEx 每次成功调用（含返回 S_FALSE“已按同模
     * 式初始化”）都会增加引用计数，必须配对一次 CoUninitialize。故用
     * SUCCEEDED 判定——首轮复核误称 S_FALSE 不应反初始化，已由跟进复
     * 核纠正并回退为 SUCCEEDED；RPC_E_CHANGED_MODE 等失败不置位。 */
    if (SUCCEEDED(hr_init)) com_init_here = 1;
    /* S_FALSE 同样增加引用计数，须配对 CoUninitialize（见上）；失败或
     * RPC_E_CHANGED_MODE 时 com_init_here 保持 0，往下照常尝试创建。 */
    IWICBitmapEncoder *enc = NULL;
    HRESULT hr = CoCreateInstance(&CLSID_WICPngEncoder, NULL, CLSCTX_INPROC_SERVER,
                                  &IID_IWICBitmapEncoder, (void **)&enc);
    if (FAILED(hr) || !enc) {
        if (hr_out) *hr_out = FAILED(hr) ? hr : E_FAIL;
        if (step_out) *step_out = "CoCreateInstance/PNGEncoder";
        if (com_init_here) CoUninitialize();
        return 0;
    }
    int ok = 0;
    IWICBitmapFrameEncode *frame = NULL;
    HRESULT hr_step = S_OK;
    const char *fail_step = "ok";
    hr_step = enc->lpVtbl->Initialize(enc, stream, WICBitmapEncoderNoCache);
    if (FAILED(hr_step)) { fail_step = "Encoder/Initialize"; goto done; }
    hr_step = enc->lpVtbl->CreateNewFrame(enc, &frame, NULL);
    if (FAILED(hr_step) || !frame) { fail_step = "CreateNewFrame"; goto done; }
    hr_step = frame->lpVtbl->Initialize(frame, NULL);
    if (FAILED(hr_step)) { fail_step = "Frame/Initialize"; goto done; }
    hr_step = frame->lpVtbl->SetSize(frame, (UINT)cap->width, (UINT)cap->height);
    if (FAILED(hr_step)) { fail_step = "Frame/SetSize"; goto done; }
    {
        WICPixelFormatGUID fmt = GUID_WICPixelFormat32bppBGRA;
        hr_step = frame->lpVtbl->SetPixelFormat(frame, &fmt);
        if (FAILED(hr_step)) { fail_step = "Frame/SetPixelFormat"; goto done; }
        if (memcmp(&fmt, &GUID_WICPixelFormat32bppBGRA, sizeof(GUID)) != 0) {
            fail_step = "Frame/SetPixelFormat-not-BGRA";
            hr_step = E_FAIL;
            goto done;
        }
    }
    hr_step = frame->lpVtbl->WritePixels(frame, (UINT)cap->height,
                                         (UINT)cap->stride,
                                         (UINT)(cap->stride * cap->height),
                                         (BYTE *)cap->bits);
    if (FAILED(hr_step)) { fail_step = "Frame/WritePixels"; goto done; }
    hr_step = frame->lpVtbl->Commit(frame);
    if (FAILED(hr_step)) { fail_step = "Frame/Commit"; goto done; }
    hr_step = enc->lpVtbl->Commit(enc);
    if (FAILED(hr_step)) { fail_step = "Encoder/Commit"; goto done; }
    ok = 1;
done:
    if (!ok) {
        if (hr_out) *hr_out = FAILED(hr_step) ? hr_step : E_FAIL;
        if (step_out) *step_out = fail_step;
    }
    if (frame) frame->lpVtbl->Release(frame);
    if (enc) enc->lpVtbl->Release(enc);
    if (com_init_here) CoUninitialize();
    return ok;
}

/* ---------- H24：截图目录 ACL 加固＋清理 ---------- *
 * 背景（DS pkg1 #13）：snapshot_dir 只 CreateDirectoryW(NULL)，目录继承
 * %ProgramData% 的默认 ACL，普通用户可读；file 模式截图落在
 * %ProgramData%\QFR\LEA\snapshots，屏幕内容可能敏感，且无限累积。
 * 修法：
 *   ① 加固：目录 DACL 只含 SYSTEM／Administrators／当前登录用户（USH 以
 *      当前登录用户身份运行，写盘须保留该用户；SYSTEM 是读截图的 LEA
 *      服务；Administrators 运维），并以 PROTECTED_DACL 阻断父目录继承，
 *      其它普通用户一律不可读。已存在的旧目录每次调用都重设（幂等），
 *      旧的宽松 ACL 不会残留。加固失败不阻塞截图（best-effort，见下），
 *      但真机验收须用 icacls 核对（WINDOWS-TESTS.md）。
 *   ② 清理：每次落盘前剪枝——超 7 天的删；超过 50 个时删最旧的，
 *      留 50 个。文件名 ush-*.png 由本模块生成，剪枝只认此前缀。
 * 注意：ACL 加固是 best-effort——非 NTFS 卷／Wine 等环境下
 * SetNamedSecurityInfo 可能失败，此时仍落盘（LEA 功能不断），
 * 风险记在 WINDOWS-TESTS.md 真机项里，不静默谎称已加固。 */

static int sid_alloc(PSID *out, BYTE sub_count, DWORD sub0, DWORD sub1) {
    SID_IDENTIFIER_AUTHORITY auth = SECURITY_NT_AUTHORITY;
    return AllocateAndInitializeSid(&auth, sub_count, sub0, sub1, 0, 0, 0, 0, 0, 0, out);
}

/* 当前进程用户 SID（调用方 LocalFree）。失败返回 NULL。 */
static PSID current_user_sid(void) {
    HANDLE tok = NULL;
    DWORD len = 0;
    TOKEN_USER *tu = NULL;
    PSID copy = NULL;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &tok)) return NULL;
    GetTokenInformation(tok, TokenUser, NULL, 0, &len);
    if (GetLastError() != ERROR_INSUFFICIENT_BUFFER || len == 0) { CloseHandle(tok); return NULL; }
    tu = (TOKEN_USER *)malloc(len);
    if (!tu) { CloseHandle(tok); return NULL; }
    if (!GetTokenInformation(tok, TokenUser, tu, len, &len)) { free(tu); CloseHandle(tok); return NULL; }
    {
        DWORD sid_len = GetLengthSid(tu->User.Sid);
        copy = (PSID)malloc(sid_len);
        if (copy && !CopySid(sid_len, copy, tu->User.Sid)) { free(copy); copy = NULL; }
    }
    free(tu);
    CloseHandle(tok);
    return copy;
}

int ush_snapshot_harden_dir(const WCHAR *dir_w) {
    PSID sys_sid = NULL, admin_sid = NULL, user_sid = NULL;
    EXPLICIT_ACCESS_W ea[3];
    PACL acl = NULL;
    DWORD rc;
    int ok = 0;
    if (!dir_w || !dir_w[0]) return 0;
    /* S-1-5-18 SYSTEM；S-1-5-32-544 Administrators（authority 均为 NT）。 */
    if (!sid_alloc(&sys_sid, 1, SECURITY_LOCAL_SYSTEM_RID, 0)) goto done;
    if (!sid_alloc(&admin_sid, 2, SECURITY_BUILTIN_DOMAIN_RID, DOMAIN_ALIAS_RID_ADMINS)) goto done;
    user_sid = current_user_sid();
    if (!user_sid) goto done; /* 拿不到当前用户 SID 即不改 ACL，不留半截 DACL */
    memset(ea, 0, sizeof(ea));
    ea[0].grfAccessPermissions = GENERIC_ALL;
    ea[0].grfAccessMode = SET_ACCESS;
    ea[0].grfInheritance = SUB_CONTAINERS_AND_OBJECTS_INHERIT;
    ea[0].Trustee.TrusteeForm = TRUSTEE_IS_SID;
    ea[0].Trustee.TrusteeType = TRUSTEE_IS_WELL_KNOWN_GROUP;
    ea[0].Trustee.ptstrName = (LPWSTR)sys_sid;
    ea[1] = ea[0];
    ea[1].Trustee.ptstrName = (LPWSTR)admin_sid;
    ea[2] = ea[0];
    ea[2].Trustee.TrusteeType = TRUSTEE_IS_USER;
    ea[2].Trustee.ptstrName = (LPWSTR)user_sid;
    rc = SetEntriesInAclW(3, ea, NULL, &acl);
    if (rc != ERROR_SUCCESS || !acl) goto done;
    /* M104: create with the final protected DACL, never a permissive window. */
    SECURITY_DESCRIPTOR descriptor;
    SECURITY_ATTRIBUTES attrs = { sizeof(attrs), &descriptor, FALSE };
    if (!InitializeSecurityDescriptor(&descriptor, SECURITY_DESCRIPTOR_REVISION) ||
        !SetSecurityDescriptorDacl(&descriptor, TRUE, acl, FALSE) ||
        !SetSecurityDescriptorControl(&descriptor, SE_DACL_PROTECTED, SE_DACL_PROTECTED)) goto done;
    if (!CreateDirectoryW(dir_w, &attrs) && GetLastError() != ERROR_ALREADY_EXISTS) goto done;
    /* PROTECTED_DACL：不继承父目录 ACL，目录只认上面三条 ACE。 */
    rc = SetNamedSecurityInfoW((LPWSTR)dir_w, SE_FILE_OBJECT,
                               DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                               NULL, NULL, acl, NULL);
    ok = (rc == ERROR_SUCCESS);
done:
    if (acl) LocalFree(acl);
    if (sys_sid) FreeSid(sys_sid);
    if (admin_sid) FreeSid(admin_sid);
    if (user_sid) free(user_sid);
    return ok;
}

typedef struct {
    WCHAR name[MAX_PATH];
    FILETIME mtime;
    int deleted; /* 已删标记：不靠 mtime 猜，避免与真实写入时间撞车 */
} snap_entry_t;

static int snap_entry_cmp(const void *a, const void *b) {
    /* 最旧在前（先删最旧的）；mtime 相同按名字 tie-break，保证顺序确定。 */
    int c = CompareFileTime(&((const snap_entry_t *)a)->mtime, &((const snap_entry_t *)b)->mtime);
    if (c != 0) return c;
    return wcscmp(((const snap_entry_t *)a)->name, ((const snap_entry_t *)b)->name);
}

int ush_snapshot_prune_dir(const char *dir_utf8, int max_files, int max_age_days) {
    WCHAR dir_w[MAX_PATH];
    WCHAR pat[MAX_PATH + 16];
    WIN32_FIND_DATAW fd;
    HANDLE h = INVALID_HANDLE_VALUE;
    snap_entry_t *list = NULL;
    size_t count = 0, cap = 0;
    int removed = 0;
    FILETIME now_ft, age_cutoff;
    ULARGE_INTEGER now_u, cut_u;
    if (!dir_utf8 || !dir_utf8[0]) return 0;
    if (max_files <= 0) max_files = USH_SNAPSHOT_MAX_FILES;
    if (max_age_days <= 0) max_age_days = USH_SNAPSHOT_MAX_AGE_DAYS;
    if (MultiByteToWideChar(CP_UTF8, 0, dir_utf8, -1, dir_w, MAX_PATH) == 0) return 0;
    wcscpy_s(pat, MAX_PATH + 16, dir_w);
    wcscat_s(pat, MAX_PATH + 16, L"\\ush-*.png");
    GetSystemTimeAsFileTime(&now_ft);
    now_u.LowPart = now_ft.dwLowDateTime; now_u.HighPart = now_ft.dwHighDateTime;
    cut_u.QuadPart = now_u.QuadPart - (ULONGLONG)max_age_days * 24ULL * 3600ULL * 10000000ULL;
    age_cutoff.dwLowDateTime = cut_u.LowPart; age_cutoff.dwHighDateTime = cut_u.HighPart;
    h = FindFirstFileW(pat, &fd);
    if (h == INVALID_HANDLE_VALUE) return 0; /* 无文件即无事可做（不是错） */
    for (;;) {
        if (!(fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY)) {
            if (count == cap) {
                size_t ncap = cap ? cap * 2 : 32;
                snap_entry_t *nl = (snap_entry_t *)realloc(list, ncap * sizeof(*nl));
                if (!nl) break;
                list = nl; cap = ncap;
            }
            wcscpy_s(list[count].name, MAX_PATH, fd.cFileName);
            list[count].mtime = fd.ftLastWriteTime;
            list[count].deleted = 0;
            count++;
        }
        if (!FindNextFileW(h, &fd)) break;
    }
    FindClose(h);
    if (!list) return 0;
    /* ① 先删超龄的。 */
    for (size_t i = 0; i < count; i++) {
        if (CompareFileTime(&list[i].mtime, &age_cutoff) < 0) {
            WCHAR full[MAX_PATH + 16];
            wcscpy_s(full, MAX_PATH + 16, dir_w);
            wcscat_s(full, MAX_PATH + 16, L"\\");
            wcscat_s(full, MAX_PATH + 16, list[i].name);
            if (DeleteFileW(full)) { removed++; list[i].deleted = 1; }
        }
    }
    /* ② 仍超上限：先算保留集——按（时间，名字）从旧到新排，留最新的
       max_files 个；只删保留集之外的，每项最多尝试一次，删失败的不补删
       其它文件（下次剪枝再试）。此设计下没有“need 计数器”，不存在
       删失败导致计数无法归零的路径；同轮内同一文件不会被尝试两次。 */
    {
        size_t alive = 0;
        for (size_t i = 0; i < count; i++) if (!list[i].deleted) alive++;
        if (alive > (size_t)max_files) {
            size_t keep = 0;
            qsort(list, count, sizeof(*list), snap_entry_cmp);
            for (size_t j = count; j-- > 0;) {
                if (list[j].deleted) continue; /* 超龄已删，不在保留集里 */
                if (keep < (size_t)max_files) { keep++; continue; } /* 保留集：最新的若干个 */
                {
                    WCHAR full[MAX_PATH + 16];
                    wcscpy_s(full, MAX_PATH + 16, dir_w);
                    wcscat_s(full, MAX_PATH + 16, L"\\");
                    wcscat_s(full, MAX_PATH + 16, list[j].name);
                    if (DeleteFileW(full)) { removed++; list[j].deleted = 1; }
                    /* 删失败：不补删，留待下次剪枝（上限是软限，不阻塞截图）。 */
                }
            }
        }
    }
    free(list);
    return removed;
}

static int snapshot_dir(char *out, size_t out_size) {
    WCHAR dir[MAX_PATH] = { 0 }, p[MAX_PATH] = { 0 };
    DWORD n = GetEnvironmentVariableW(L"ProgramData", dir, MAX_PATH);
    if (n == 0 || n >= MAX_PATH) wcscpy_s(dir, MAX_PATH, L"C:\\ProgramData");
    if (wcscpy_s(p, MAX_PATH, dir) || wcscat_s(p, MAX_PATH, L"\\QFR")) return 0;
    if (!CreateDirectoryW(p, NULL) && GetLastError() != ERROR_ALREADY_EXISTS) return 0;
    if (wcscat_s(p, MAX_PATH, L"\\LEA")) return 0;
    if (!CreateDirectoryW(p, NULL) && GetLastError() != ERROR_ALREADY_EXISTS) return 0;
    if (wcscat_s(p, MAX_PATH, L"\\snapshots") || !ush_snapshot_harden_dir(p)) return 0;
    if (!WideCharToMultiByte(CP_UTF8, 0, p, -1, out, (int)out_size, NULL, NULL)) return 0;
    ush_snapshot_prune_dir(out, USH_SNAPSHOT_MAX_FILES, USH_SNAPSHOT_MAX_AGE_DAYS);
    return 1;
}

/* ---------- file 模式：WIC 工厂＋文件流 ---------- */
/* N-09（2026-11-15）：file 模式在 USH 管道线程上跑，管道线程从未初始
 * 化 COM——旧代码在 ush_ui_snapshot 内直接 CoCreateInstance 建 WIC
 * 工厂，恒返 CO_E_NOTINITIALIZED（0x800401F0），默认 mode=file 截图
 * 恒败（encode 内的 CoInitializeEx 根本没机会跑到）。修法：本函数入
 * 口即按需 CoInitializeEx（MTA，与 encode 内同款）；只有本次调用真
 * 由我们初始化时才置 *com_init_out=1，调用方在 encode 完成后凭此配
 * 对 CoUninitialize（本函数自身绝不反初始化——流与编码器须在初始化
 * 的线程上用完再反初始化）。UIA 现已归同一个 MTA 管道线程所有；
 * 此 helper 仍支持未初始化的独立线程测试。RPC_E_CHANGED_MODE 等失败时
 * 不置位，照常往下尝试创建（线程已被别处以另一模式初始化时工厂
 * 创建仍可成功）。
 * 成功返回 1（factory／wstream／istream 均已建出，调用方释放）；
 * 失败返回 0 并带回步骤＋HRESULT（步骤口径与旧内联代码一致）；
 * 失败时已建出的对象由本函数自行释放，调用方无需再释放。
 * 供单测直验：无 COM 初始化的线程上调本函数须成功建出工厂＋流。 */
static int snapshot_open_file_stream(const char *path_utf8,
                                     IWICImagingFactory **factory_out,
                                     IWICStream **wstream_out,
                                     IStream **istream_out,
                                     int *com_init_out,
                                     HRESULT *hr_out, const char **step_out,
                                     HRESULT *hr_init_out) {
    if (factory_out) *factory_out = NULL;
    if (wstream_out) *wstream_out = NULL;
    if (istream_out) *istream_out = NULL;
    if (com_init_out) *com_init_out = 0;
    if (hr_out) *hr_out = E_FAIL;
    if (step_out) *step_out = "handler/stream-setup";
    HRESULT hr_init = CoInitializeEx(NULL, COINIT_MULTITHREADED);
    if (hr_init_out) *hr_init_out = hr_init;
    int com_init_here = SUCCEEDED(hr_init);
    if (com_init_out) *com_init_out = com_init_here;
    IWICImagingFactory *factory = NULL;
    HRESULT hr = CoCreateInstance(&CLSID_WICImagingFactory, NULL, CLSCTX_INPROC_SERVER,
                                  &IID_IWICImagingFactory, (void **)&factory);
    if (FAILED(hr) || !factory) {
        if (hr_out) *hr_out = FAILED(hr) ? hr : E_POINTER;
        if (step_out) *step_out = "handler/CoCreateInstance";
        return 0;
    }
    IWICStream *wstream = NULL;
    HRESULT hr2 = factory->lpVtbl->CreateStream(factory, &wstream);
    if (FAILED(hr2) || !wstream) {
        if (hr_out) *hr_out = FAILED(hr2) ? hr2 : E_POINTER;
        if (step_out) *step_out = "handler/CreateStream";
        factory->lpVtbl->Release(factory);
        return 0;
    }
    WCHAR wpath[MAX_PATH + 64];
    if (!MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, path_utf8, -1, wpath, MAX_PATH + 64)) {
        wstream->lpVtbl->Release(wstream); factory->lpVtbl->Release(factory);
        if (step_out) *step_out = "handler/path-utf8";
        return 0;
    }
    hr2 = wstream->lpVtbl->InitializeFromFilename(wstream, wpath, GENERIC_WRITE);
    if (FAILED(hr2)) {
        if (hr_out) *hr_out = hr2;
        if (step_out) *step_out = "handler/InitializeFromFilename";
        wstream->lpVtbl->Release(wstream);
        factory->lpVtbl->Release(factory);
        return 0;
    }
    IStream *istream = NULL;
    hr2 = wstream->lpVtbl->QueryInterface(wstream, &IID_IStream, (void **)&istream);
    if (FAILED(hr2) || !istream) {
        if (hr_out) *hr_out = FAILED(hr2) ? hr2 : E_POINTER;
        if (step_out) *step_out = "handler/QueryInterface";
        wstream->lpVtbl->Release(wstream);
        factory->lpVtbl->Release(factory);
        return 0;
    }
    if (factory_out) *factory_out = factory;
    if (wstream_out) *wstream_out = wstream;
    if (istream_out) *istream_out = istream;
    if (hr_out) *hr_out = S_OK;
    if (step_out) *step_out = "ok";
    return 1;
}

int ush_ui_snapshot(const ush_request_t *req, char *data_json, size_t data_size,
                    char *err_code, size_t err_code_size,
                    char *err_text, size_t err_text_size) {
    char mode[16] = {0};
    char window_title[256] = {0};
    char window_class[128] = {0};
    ush_json_get_string(req->params_json, "mode", mode, sizeof(mode));
    ush_json_get_string(req->params_json, "window_title", window_title, sizeof(window_title));
    ush_json_get_string(req->params_json, "window_class", window_class, sizeof(window_class));
    int inline_mode = (strcmp(mode, "inline") == 0);

    /* 目标矩形：指定窗口 → 窗口外框；否则虚拟屏（全部显示器）。 */
    RECT rc;
    if (window_title[0] || window_class[0]) {
        HWND hwnd = find_window_by_title(window_title, window_class);
        if (!hwnd) {
            strncpy(err_code, USH_ERR_NOT_FOUND, err_code_size - 1);
            snprintf(err_text, err_text_size, "snapshot window not found");
            return 0;
        }
        if (IsIconic(hwnd)) {
            strncpy(err_code, USH_ERR_NOT_SUPPORTED, err_code_size - 1);
            snprintf(err_text, err_text_size, "minimized window cannot be captured reliably");
            return 0;
        }
        if (!GetWindowRect(hwnd, &rc)) {
            strncpy(err_code, USH_ERR_FAILED, err_code_size - 1);
            snprintf(err_text, err_text_size, "GetWindowRect failed");
            return 0;
        }
    } else {
        rc.left = GetSystemMetrics(SM_XVIRTUALSCREEN);
        rc.top = GetSystemMetrics(SM_YVIRTUALSCREEN);
        rc.right = rc.left + GetSystemMetrics(SM_CXVIRTUALSCREEN);
        rc.bottom = rc.top + GetSystemMetrics(SM_CYVIRTUALSCREEN);
    }

    capture_t cap;
    if (!capture_rect(rc, &cap)) {
        strncpy(err_code, USH_ERR_FAILED, err_code_size - 1);
        snprintf(err_text, err_text_size,
            "screen capture failed (BitBlt); session may be locked or RDP disconnected");
        return 0;
    }

    int ok = 0;
    if (!inline_mode) {
        char dir[MAX_PATH];
        if (!snapshot_dir(dir, sizeof(dir))) {
            capture_free(&cap);
            strncpy(err_code, USH_ERR_FAILED, err_code_size - 1);
            snprintf(err_text, err_text_size, "snapshot directory security could not be established");
            return 0;
        }
        SYSTEMTIME st;
        GetLocalTime(&st);
        char path[MAX_PATH + 64];
        snprintf(path, sizeof(path), "%s\\ush-%04d%02d%02d-%02d%02d%02d-%03d-%lu-%llu-%lu.png",
            dir, st.wYear, st.wMonth, st.wDay, st.wHour, st.wMinute, st.wSecond,
            st.wMilliseconds, (unsigned long)GetCurrentProcessId(),
            (unsigned long long)GetTickCount64(),
            (unsigned long)InterlockedIncrement(&g_snapshot_sequence));
        /* WIC 直接写文件：用 IWICStream::InitializeFromFilename。
         * r9-diag：handler 自身的工厂创建与流搭建失败时同样带回步骤＋HRESULT；
         * 默认先记 handler/stream-setup，encode 被调到后由其覆写为真实步骤。
         * N-09：工厂＋流搭建抽到 snapshot_open_file_stream（入口即按需
         * CoInitializeEx，见该函数注释）。 */
        HRESULT diag_hr = E_FAIL;
        const char *diag_step = "handler/stream-setup";
        /* 0xFFFFFFFF＝哨兵：CoInitializeEx 尚未在本路径调用（open 失败且
         * encode 未被调到时沿用此值）；切勿默认为 S_OK，那会谎称“初始化
         * 已成功”。open 成功时 diag_init 为 open 的初始化结果，encode 被
         * 调到后由其覆写为真实步骤。 */
        HRESULT diag_init = (HRESULT)0xFFFFFFFF;
        int com_init_here = 0;
        IWICImagingFactory *factory = NULL;
        IWICStream *wstream = NULL;
        IStream *istream = NULL;
        if (snapshot_open_file_stream(path, &factory, &wstream, &istream,
                                      &com_init_here, &diag_hr, &diag_step, &diag_init)) {
            ok = encode_png_to_stream(&cap, istream, &diag_hr, &diag_step, &diag_init);
            istream->lpVtbl->Release(istream);
            wstream->lpVtbl->Release(wstream);
            factory->lpVtbl->Release(factory);
        }
        if (ok) {
            HANDLE h = CreateFileA(path, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, 0, NULL);
            LARGE_INTEGER size = { 0 };
            ok = h != INVALID_HANDLE_VALUE && GetFileSizeEx(h, &size) && size.QuadPart > 0;
            if (h != INVALID_HANDLE_VALUE) CloseHandle(h);
            char pesc[4096];
            if (ok) ok = ush_json_escape(path, pesc, sizeof(pesc));
            if (ok) {
                int n = snprintf(data_json, data_size,
                    "{\"mode\":\"file\",\"path\":\"%s\",\"width\":%d,\"height\":%d,\"bytes\":%llu}",
                    pesc, cap.width, cap.height, (unsigned long long)size.QuadPart);
                ok = n > 0 && (size_t)n < data_size;
            }
            if (!ok) diag_step = "handler/file-metadata";
        }
        if (!ok) {
            DeleteFileA(path);
            strncpy(err_code, USH_ERR_FAILED, err_code_size - 1);
            snprintf(err_text, err_text_size, "PNG encode/metadata failed at %s hr=0x%08lX init=0x%08lX cap=%dx%d stride=%d",
                     diag_step, (unsigned long)diag_hr, (unsigned long)diag_init,
                     cap.width, cap.height, cap.stride);
        }
        /* N-09：与 snapshot_open_file_stream 内的 CoInitializeEx 配对
         * （仅本次调用真由我们初始化时反初始化；RPC_E_CHANGED_MODE 等
         * 失败时不反初始化）。 */
        if (com_init_here) CoUninitialize();
    } else {
        /* 内联：编到内存流 → 读 HGLOBAL → Base64 */
        HGLOBAL hg = NULL;
        IStream *mem = NULL;
        HRESULT hr = CreateStreamOnHGlobal(NULL, TRUE, &mem);
        if (SUCCEEDED(hr) && mem) {
            HRESULT diag_hr = S_OK;
            const char *diag_step = "ok";
            HRESULT diag_init = S_OK;
            if (encode_png_to_stream(&cap, mem, &diag_hr, &diag_step, &diag_init)) {
                HGLOBAL hret = NULL;
                if (SUCCEEDED(GetHGlobalFromStream(mem, &hret)) && hret) {
                    SIZE_T sz = GlobalSize(hret);
                    void *bytes = GlobalLock(hret);
                    if (bytes && sz > 0 && sz <= USH_INLINE_MAX_BYTES) {
                        size_t b64_size = ((sz + 2) / 3) * 4 + 1;
                        char *b64 = (char *)malloc(b64_size);
                        if (b64 && ush_base64_encode((const unsigned char *)bytes, sz, b64, b64_size)) {
                            if (strlen(b64) + 256 < data_size) {
                                snprintf(data_json, data_size,
                                    "{\"mode\":\"inline\",\"format\":\"png\",\"width\":%d,"
                                    "\"height\":%d,\"bytes\":%llu,\"data_base64\":\"%s\"}",
                                    cap.width, cap.height,
                                    (unsigned long long)sz, b64);
                                ok = 1;
                            } else {
                                strncpy(err_code, USH_ERR_TOO_LARGE, err_code_size - 1);
                                snprintf(err_text, err_text_size,
                                    "inline snapshot too large for response; use mode=file");
                            }
                            free(b64);
                        } else {
                            if (b64) free(b64);
                            strncpy(err_code, USH_ERR_FAILED, err_code_size - 1);
                            snprintf(err_text, err_text_size, "base64 encode failed");
                        }
                    } else if (bytes && sz > USH_INLINE_MAX_BYTES) {
                        strncpy(err_code, USH_ERR_TOO_LARGE, err_code_size - 1);
                        snprintf(err_text, err_text_size,
                            "inline PNG is %llu bytes (>6MB); use mode=file", (unsigned long long)sz);
                    } else {
                        strncpy(err_code, USH_ERR_FAILED, err_code_size - 1);
                        snprintf(err_text, err_text_size, "cannot read encoded PNG from memory stream");
                    }
                    if (bytes) GlobalUnlock(hret);
                } else {
                    strncpy(err_code, USH_ERR_FAILED, err_code_size - 1);
                    snprintf(err_text, err_text_size, "GetHGlobalFromStream failed");
                }
            } else {
                strncpy(err_code, USH_ERR_FAILED, err_code_size - 1);
                snprintf(err_text, err_text_size, "PNG encode failed at %s hr=0x%08lX init=0x%08lX cap=%dx%d stride=%d",
                         diag_step, (unsigned long)diag_hr, (unsigned long)diag_init,
                         cap.width, cap.height, cap.stride);
            }
            mem->lpVtbl->Release(mem);
        } else {
            strncpy(err_code, USH_ERR_FAILED, err_code_size - 1);
            snprintf(err_text, err_text_size, "CreateStreamOnHGlobal failed hr=0x%08lX",
                     (unsigned long)hr);
        }
        (void)hg;
    }
    capture_free(&cap);
    return ok;
}
