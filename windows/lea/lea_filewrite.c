/* lea_filewrite.c — 见 lea_filewrite.h。 */
#include "lea_filewrite.h"

#include <stdio.h>
#include <string.h>

#ifdef _WIN32
#include <windows.h>
#else
#include <unistd.h>
#endif

static void set_detail(char *detail, size_t detail_size, const char *s) {
    if (detail && detail_size > 0) snprintf(detail, detail_size, "%s", s);
}

/* 同卷替换：成功返回 1，失败返回 0（目标原文件不动）。
 * Windows 用 MoveFileExA 具替换语义的原子替换（不先删旧目标——
 * mingw／Wine 下 rename 不覆盖已存在目标，旧代码为此先删旧文件
 * 再改名，中间空窗一旦改名失败旧文件即丢失，A9 修掉）；POSIX
 * 用 rename（原生原子替换）。 */
int lea_file_replace(const char *tmp, const char *target) {
#ifdef _WIN32
    return MoveFileExA(tmp, target,
                       MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) != 0;
#else
    return rename(tmp, target) == 0;
#endif
}

int lea_file_write_atomic(const char *target, const unsigned char *data,
                          size_t len, char *detail, size_t detail_size) {
    if (!target || !target[0] || (len > 0 && !data)) {
        set_detail(detail, detail_size, "file-write-bad-arg");
        return 0;
    }
    /* 临时文件与目标同目录（同卷），后缀带 pid 防并发写互相覆盖。 */
    char tmp[1024];
    unsigned long pid;
#ifdef _WIN32
    pid = (unsigned long)GetCurrentProcessId();
#else
    pid = (unsigned long)getpid();
#endif
    int w = snprintf(tmp, sizeof(tmp), "%s.tmp.%lu", target, pid);
    if (w < 0 || (size_t)w >= sizeof(tmp)) {
        set_detail(detail, detail_size, "file-tmp-path-too-long");
        return 0;
    }
    FILE *f = fopen(tmp, "wb");
    if (!f) {
        set_detail(detail, detail_size, "file-open-failed");
        return 0;
    }
    /* 逐段写：fwrite 可能短写（返回 < 请求字节但无错），必须循环续写；
     * 返回 0 或 ferror 即为写失败（写满／设备错），不是成功。 */
    size_t written = 0;
    int closed = 0;
    const char *fail = NULL;
    while (written < len) {
        size_t n = fwrite(data + written, 1, len - written, f);
        if (n == 0) {
            if (ferror(f)) fail = "file-write-failed";
            else fail = "file-write-failed"; /* 0 字节且无错亦非成功 */
            break;
        }
        written += n;
    }
    if (!fail && fflush(f) != 0) fail = "file-flush-failed";
    /* fclose 只调一次：失败分支不再重复 fclose（二次关闭是未定义行为，
     * 旧 lea_local.c atomic_write 即有此隐患，本处不重蹈）。 */
    if (fclose(f) != 0 && !fail) fail = "file-close-failed";
    closed = 1;
    (void)closed;
    if (fail) {
        remove(tmp);
        set_detail(detail, detail_size, fail);
        return 0;
    }
    /* 成功才替换目标；替换失败同样删 tmp、保留旧文件、报失败。 */
    if (!lea_file_replace(tmp, target)) {
        remove(tmp);
        set_detail(detail, detail_size, "file-replace-failed");
        return 0;
    }
    return 1;
}
