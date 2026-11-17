/* test_ush_snapshot.c — H24 截图目录加固＋剪枝单测（mingw 编译，wine64 下跑）。
 *
 * 覆盖 ush_snapshot_harden_dir / ush_snapshot_prune_dir：
 *   ① 超 7 天的文件被删；② 超 50 个时删最旧的、留 50 个；
 *   ③ 非 ush-*.png 文件不动；④ 不存在目录返回 0 不崩；
 *   ⑤ 加固调用不崩（wine 下 ACL 可能 stub，返回 0 时只记 SKIP 不判失败；
 *      真机须返回 1，见 WINDOWS-TESTS.md）。
 * S-025（2026-11-15）：inline 截图断言（结果含 downscaled／
 * masked_password_fields／notice_shown 三字段、宽高 >0、最长边 ≤1920；
 * 无桌面会话导致抓屏失败时记 SKIP 不判失败）。
 * 用法：x86_64-w64-mingw32-gcc -O2 -Wall -Wextra -std=c11
 *   -D_WIN32_WINNT=0x0A00 -DWINVER=0x0A00 -I.. -o /tmp/test_ush_snapshot.exe
 *   test_ush_snapshot.c ../ush_snapshot.c ../ush_json.c
 *   -lole32 -loleaut32 -luuid -lwtsapi32 -lgdi32 -luser32 -lbcrypt -lwindowscodecs
 *   wine64 /tmp/test_ush_snapshot.exe
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "ush_snapshot.h"

static int g_pass = 0, g_fail = 0;
static void t(int cond, const char *name) {
    if (cond) { g_pass++; printf("PASS %s\n", name); }
    else { g_fail++; printf("FAIL %s\n", name); }
}

/* age_days>0：mtime 设为 N 天前；age_sec>0：mtime 设为 N 秒前。
   新文件一律显式给递增 mtime（不依赖创建顺序/文件系统时间精度），
   否则“最旧的先删”断言在 FAT/wine 下不可靠（DS round 1）。 */
static void make_file(const WCHAR *dir, const WCHAR *name, int age_days, int age_sec) {
    WCHAR path[MAX_PATH];
    HANDLE h;
    FILETIME ft;
    ULARGE_INTEGER u;
    wcscpy_s(path, MAX_PATH, dir);
    wcscat_s(path, MAX_PATH, L"\\");
    wcscat_s(path, MAX_PATH, name);
    h = CreateFileW(path, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (h == INVALID_HANDLE_VALUE) return;
    {
        const char *blob = "fake-png";
        DWORD w = 0;
        WriteFile(h, blob, 8, &w, NULL);
    }
    if (age_days > 0 || age_sec > 0) {
        GetSystemTimeAsFileTime(&ft);
        u.LowPart = ft.dwLowDateTime; u.HighPart = ft.dwHighDateTime;
        u.QuadPart -= (ULONGLONG)age_days * 24ULL * 3600ULL * 10000000ULL
                    + (ULONGLONG)age_sec * 10000000ULL;
        ft.dwLowDateTime = u.LowPart; ft.dwHighDateTime = u.HighPart;
        SetFileTime(h, NULL, NULL, &ft);
    }
    CloseHandle(h);
}

static int file_exists(const WCHAR *dir, const WCHAR *name) {
    WCHAR path[MAX_PATH];
    DWORD a;
    wcscpy_s(path, MAX_PATH, dir);
    wcscat_s(path, MAX_PATH, L"\\");
    wcscat_s(path, MAX_PATH, name);
    a = GetFileAttributesW(path);
    return a != INVALID_FILE_ATTRIBUTES && !(a & FILE_ATTRIBUTE_DIRECTORY);
}

static int count_files(const WCHAR *dir) {
    WCHAR pat[MAX_PATH];
    WIN32_FIND_DATAW fd;
    HANDLE h;
    int n = 0;
    wcscpy_s(pat, MAX_PATH, dir);
    wcscat_s(pat, MAX_PATH, L"\\ush-*.png");
    h = FindFirstFileW(pat, &fd);
    if (h == INVALID_HANDLE_VALUE) return 0;
    do { if (!(fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY)) n++; } while (FindNextFileW(h, &fd));
    FindClose(h);
    return n;
}

int main(void) {
    WCHAR tmp[MAX_PATH], dir[MAX_PATH];
    char dir_u8[MAX_PATH];
    WCHAR name[64];
    int i, rc;

    if (GetTempPathW(MAX_PATH, tmp) == 0) { printf("FAIL no temp path\n"); return 1; }
    swprintf_s(dir, MAX_PATH, L"%sush-snap-test-%lu", tmp, (unsigned long)GetCurrentProcessId());
    CreateDirectoryW(dir, NULL);
    WideCharToMultiByte(CP_UTF8, 0, dir, -1, dir_u8, MAX_PATH, NULL, NULL);

    /* 不存在目录：返回 0 不崩。 */
    t(ush_snapshot_prune_dir("C:\\nonexistent-dir-qfr-test\\nope", 50, 7) == 0,
      "H24 prune 不存在目录返回 0");
    t(ush_snapshot_harden_dir(L"C:\\nonexistent-dir-qfr-test\\nope") == 0,
      "H24 harden 不存在目录返回 0");

    /* 60 个文件：10 个 10 天前（超龄）＋50 个新鲜。 */
    for (i = 0; i < 10; i++) { swprintf_s(name, 64, L"ush-old-%02d.png", i); make_file(dir, name, 10, 0); }
    /* 新文件 mtime 递增：ush-new-00 最旧（55 秒前），ush-new-49 最新（6 秒前）。 */
    for (i = 0; i < 50; i++) { swprintf_s(name, 64, L"ush-new-%02d.png", i); make_file(dir, name, 0, 55 - i); }
    make_file(dir, L"keep-me.txt", 30, 0); /* 非 ush-*.png：剪枝不动它 */
    t(count_files(dir) == 60, "H24 准备 60 个快照文件");
    rc = ush_snapshot_prune_dir(dir_u8, 50, 7);
    t(rc == 10, "H24 超 7 天的 10 个被删");
    t(count_files(dir) == 50, "H24 删后剩 50 个（上限内不再删）");
    t(file_exists(dir, L"keep-me.txt"), "H24 非快照文件 keep-me.txt 未动");
    t(!file_exists(dir, L"ush-old-00.png"), "H24 旧文件 ush-old-00.png 已删");
    t(file_exists(dir, L"ush-new-00.png"), "H24 新文件 ush-new-00.png 保留");

    /* 再加 5 个新鲜文件 → 55 个，超上限删最旧的 5 个。 */
    /* 新文件 50-54：mtime 5 秒前→1 秒前，均为最新，剪枝应删最旧的 00-04。 */
    for (i = 50; i < 55; i++) { swprintf_s(name, 64, L"ush-new-%02d.png", i); make_file(dir, name, 0, 55 - i); }
    /* 让最旧的 5 个可分辨：ush-new-00..04 的 mtime 最早（先创建）。 */
    rc = ush_snapshot_prune_dir(dir_u8, 50, 7);
    t(rc == 5, "H24 超上限删最旧 5 个");
    t(count_files(dir) == 50, "H24 删后仍剩 50 个");
    t(!file_exists(dir, L"ush-new-00.png"), "H24 最旧 ush-new-00.png 已删");
    t(file_exists(dir, L"ush-new-54.png"), "H24 最新 ush-new-54.png 保留");

    /* 小上限：max_files=3 时只留 3 个。 */
    rc = ush_snapshot_prune_dir(dir_u8, 3, 7);
    t(rc == 47 && count_files(dir) == 3, "H24 max_files=3 留 3 个");

    /* 加固：不崩；wine 下 ACL 可能 stub，返回 0 只记 SKIP。 */
    {
        WCHAR sub[MAX_PATH];
        wcscpy_s(sub, MAX_PATH, dir);
        wcscat_s(sub, MAX_PATH, L"\\harden-me");
        CreateDirectoryW(sub, NULL);
        rc = ush_snapshot_harden_dir(sub);
        if (rc == 1) t(1, "H24 harden 成功返回 1");
        else printf("SKIP H24 harden 返回 0（wine/FS 不支持 ACL，真机须为 1）\n");
        RemoveDirectoryW(sub);
    }

    /* S-025：inline 截图含三字段、最长边 ≤1920；无桌面会话时抓屏失败记 SKIP。
     * （wine 下无桌面会话，capture_rect 即败，属环境限制、不判失败；
     * 真机验收见 WINDOWS-TESTS.md：4K 降采样实效、真实密码框遮罩目视、
     * 提示条目视。） */
    {
        ush_request_t rq;
        memset(&rq, 0, sizeof(rq));
        snprintf(rq.params_json, sizeof(rq.params_json), "%s", "{\"mode\":\"inline\"}");
        rq.timeout_ms = 5000;
        char *data = (char *)malloc(8 * 1024 * 1024);
        char ec[64] = { 0 }, et[512] = { 0 };
        if (!data) {
            printf("SKIP S-025 malloc 失败\n");
        } else {
            int ok = ush_ui_snapshot(&rq, data, 8 * 1024 * 1024, ec, sizeof(ec), et, sizeof(et));
            if (!ok) {
                printf("SKIP S-025 inline 截图失败（无桌面会话，err=%s：%s）\n", ec, et);
            } else {
                t(strstr(data, "\"downscaled\":") != NULL, "S-025 inline 结果含 downscaled");
                t(strstr(data, "\"masked_password_fields\":") != NULL, "S-025 inline 结果含 masked_password_fields");
                t(strstr(data, "\"notice_shown\":") != NULL, "S-025 inline 结果含 notice_shown");
                long w = 0, h = 0;
                ush_json_get_long(data, "width", &w);
                ush_json_get_long(data, "height", &h);
                t(w > 0 && h > 0, "S-025 inline 宽高 >0");
                t((w > h ? w : h) <= 1920, "S-025 inline 最长边 ≤1920");
            }
            free(data);
        }
    }

    /* 清理测试目录。 */
    {
        WCHAR pat[MAX_PATH];
        WIN32_FIND_DATAW fd;
        HANDLE h;
        wcscpy_s(pat, MAX_PATH, dir);
        wcscat_s(pat, MAX_PATH, L"\\*");
        h = FindFirstFileW(pat, &fd);
        if (h != INVALID_HANDLE_VALUE) {
            do {
                WCHAR full[MAX_PATH];
                if (wcscmp(fd.cFileName, L".") == 0 || wcscmp(fd.cFileName, L"..") == 0) continue;
                wcscpy_s(full, MAX_PATH, dir);
                wcscat_s(full, MAX_PATH, L"\\");
                wcscat_s(full, MAX_PATH, fd.cFileName);
                if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) RemoveDirectoryW(full);
                else DeleteFileW(full);
            } while (FindNextFileW(h, &fd));
            FindClose(h);
        }
        RemoveDirectoryW(dir);
    }

    printf("----\n%d passed, %d failed\n", g_pass, g_fail);
    return g_fail ? 1 : 0;
}
