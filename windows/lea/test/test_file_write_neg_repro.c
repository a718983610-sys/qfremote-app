/* test_file_write_neg_repro — batch1-fix3 负向复现对照（独立小工具，不进单测）。
 *
 * 同一三种失败场景下，对照旧逻辑（QFRLEA.c file.write 修前原样：
 * fopen "wb" 后 fwrite／fclose 全不检查，恒报成功）与新逻辑
 * （lea_file_write_atomic）的行为：
 *   1. 磁盘写满  RLIMIT_FSIZE=0 下写 4096 字节；
 *   2. 权限不足  fork 子进程 setuid nobody(65534) 后写 0555 只读目录内文件；
 *   3. 部分写入  RLIMIT_FSIZE=4096 下写 8192 字节。
 * 断言：旧逻辑在场景 1／3 返回成功且原文件被截断／写残（BUG 复现）；
 * 新逻辑三场景均返回失败、原文件完好、无临时文件残留。
 * 场景 2 旧逻辑在 open 处已有检查，本就返回失败——此处对照证明新
 * 路径未把原有的 open 失败处理丢掉（真正的新增保护在替换一步，
 * 如 Windows 下目标只读／被占用，需真机验证，见 REPORT）。
 *
 * 编译＋运行（沙箱）：
 *   gcc -O1 -Wall -Wextra -o /tmp/test_file_write_neg_repro \
 *       test_file_write_neg_repro.c ../lea_filewrite.c
 *   /tmp/test_file_write_neg_repro
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <signal.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>
#include "../lea_filewrite.h"

typedef int (*write_fn)(const char *, const unsigned char *, size_t, char *, size_t);

static const char *ORIG = "ORIGINAL-DATA-12345";

/* 旧逻辑原样复刻（修前 QFRLEA.c file.write 分支）： */
static int old_file_write(const char *target, const unsigned char *data,
                          size_t len, char *detail, size_t detail_size) {
    FILE *f = fopen(target, "wb");
    if (!f) {
        if (detail && detail_size > 0) snprintf(detail, detail_size, "%s", "file-open-failed");
        return 0;
    }
    fwrite(data, 1, len, f); /* 不检查实际写入字节数 */
    fclose(f);               /* 不检查关闭结果 */
    if (detail && detail_size > 0) snprintf(detail, detail_size, "%s", "ok");
    return 1;                /* 恒报成功，附 size=len（调用方原样上报） */
}

static long file_size(const char *path) {
    struct stat st;
    if (stat(path, &st) != 0) return -1;
    return (long)st.st_size;
}

static int orig_intact(const char *path) {
    FILE *f = fopen(path, "rb");
    if (!f) return 0;
    char buf[64] = { 0 };
    size_t n = fread(buf, 1, sizeof(buf) - 1, f);
    fclose(f);
    return n == strlen(ORIG) && memcmp(buf, ORIG, n) == 0;
}

static void write_orig(const char *path) {
    FILE *f = fopen(path, "wb");
    if (f) { fwrite(ORIG, 1, strlen(ORIG), f); fclose(f); }
}

static void tmp_path_of(const char *target, char *tmp, size_t tmp_size) {
    snprintf(tmp, tmp_size, "%s.tmp.%lu", target, (unsigned long)getpid());
}

/* 场景 1／3：rlimit 下写，返回 1 表示新逻辑通过（失败＋原文件完好）。 */
static int run_rlimit_case(const char *name, write_fn fn, const char *label,
                           const char *target, rlim_t limit, size_t wlen,
                           int expect_old_bug) {
    write_orig(target);
    struct rlimit oldrl, newrl;
    getrlimit(RLIMIT_FSIZE, &oldrl);
    newrl.rlim_cur = limit;
    newrl.rlim_max = oldrl.rlim_max;
    void (*oldh)(int) = signal(SIGXFSZ, SIG_IGN);
    int lim_ok = (setrlimit(RLIMIT_FSIZE, &newrl) == 0);
    unsigned char *big = (unsigned char *)malloc(wlen);
    memset(big, 'X', wlen);
    char detail[64] = { 0 };
    int rc = lim_ok ? fn(target, big, wlen, detail, sizeof(detail)) : -9;
    free(big);
    setrlimit(RLIMIT_FSIZE, &oldrl);
    signal(SIGXFSZ, oldh);
    long sz = file_size(target);
    int intact = orig_intact(target);
    char tmp[600];
    tmp_path_of(target, tmp, sizeof(tmp));
    int no_tmp = (access(tmp, F_OK) != 0);
    printf("[%s] %s: rc=%d detail=%s target_size=%ld orig_intact=%s tmp_left=%s\n",
           name, label, rc, detail, sz, intact ? "YES" : "NO", no_tmp ? "NO" : "YES");
    if (expect_old_bug) {
        /* 旧逻辑应复现 BUG：报成功且原文件被毁。 */
        int reproduced = (rc == 1 && !intact);
        printf("[%s] %s: %s\n", name, label,
               reproduced ? "BUG REPRODUCED (old code reports success, original destroyed)"
                          : "UNEXPECTED (old code did not reproduce)");
        return reproduced;
    }
    int fixed = (rc == 0 && intact && no_tmp);
    printf("[%s] %s: %s\n", name, label,
           fixed ? "FIXED (fails correctly, original intact)"
                 : "STILL BROKEN");
    return fixed;
}

/* 场景 2：权限不足（fork＋setuid nobody 写 0555 目录）。 */
static int run_perm_case(const char *name, write_fn fn, const char *label,
                         const char *dir) {
    char rodir[512], target[528];
    snprintf(rodir, sizeof(rodir), "%s/ro", dir);
    snprintf(target, sizeof(target), "%s/secret.txt", rodir);
    mkdir(rodir, 0755);
    write_orig(target);
    chmod(rodir, 0555);
    int pfd[2];
    int rc = -9;
    char detail[64] = { 0 };
    if (pipe(pfd) == 0) {
        pid_t pid = fork();
        if (pid == 0) {
            close(pfd[0]);
            char out[96];
            if (setgid(65534) != 0 || setuid(65534) != 0) {
                snprintf(out, sizeof(out), "SETUID-FAIL|");
            } else {
                char d[64] = { 0 };
                unsigned char data[] = "new-content";
                int r = fn(target, data, 11, d, sizeof(d));
                snprintf(out, sizeof(out), "%d|%s", r, d);
            }
            size_t off = 0, wlen = strlen(out);
            while (off < wlen) {
                ssize_t w = write(pfd[1], out + off, wlen - off);
                if (w <= 0) break;
                off += (size_t)w;
            }
            close(pfd[1]);
            _exit(0);
        }
        if (pid > 0) {
            close(pfd[1]);
            char res[96] = { 0 };
            ssize_t got, total = 0;
            while ((got = read(pfd[0], res + total, sizeof(res) - 1 - (size_t)total)) > 0)
                total += got;
            close(pfd[0]);
            int status = 0;
            waitpid(pid, &status, 0);
            res[total] = '\0';
            sscanf(res, "%d|%63s", &rc, detail);
        }
    }
    int intact = orig_intact(target);
    printf("[%s] %s: rc=%d detail=%s orig_intact=%s\n",
           name, label, rc, detail, intact ? "YES" : "NO");
    chmod(rodir, 0755);
    remove(target);
    rmdir(rodir);
    if (strcmp(label, "OLD") == 0) {
        /* 旧逻辑 open 处已有检查，本就应返回失败；对照只证明未丢该行为。 */
        int as_before = (rc == 0 && intact);
        printf("[%s] %s: %s\n", name, label,
               as_before ? "AS BEFORE (open check already failed closed)"
                         : "UNEXPECTED");
        return as_before;
    }
    int fixed = (rc == 0 && intact);
    printf("[%s] %s: %s\n", name, label,
           fixed ? "FIXED (fails correctly, original intact)" : "STILL BROKEN");
    return fixed;
}

int main(void) {
    char dir[] = "/tmp/lea-fw-repro-XXXXXX";
    if (!mkdtemp(dir)) { printf("mkdtemp failed\n"); return 2; }
    char target[512];
    snprintf(target, sizeof(target), "%s/target.txt", dir);
    int pass = 0, total = 0;

    total++; pass += run_rlimit_case("disk-full", old_file_write, "OLD", target, 0, 4096, 1);
    total++; pass += run_rlimit_case("disk-full", lea_file_write_atomic, "NEW", target, 0, 4096, 0);
    total++; pass += run_perm_case("permission", old_file_write, "OLD", dir);
    total++; pass += run_perm_case("permission", lea_file_write_atomic, "NEW", dir);
    total++; pass += run_rlimit_case("partial-write", old_file_write, "OLD", target, 4096, 8192, 1);
    total++; pass += run_rlimit_case("partial-write", lea_file_write_atomic, "NEW", target, 4096, 8192, 0);

    remove(target);
    rmdir(dir);
    printf("\nrepro: %d/%d checks as expected\n", pass, total);
    return pass == total ? 0 : 1;
}
