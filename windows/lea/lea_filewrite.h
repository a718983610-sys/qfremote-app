/* lea_filewrite — file.write 原子写入（batch1-fix3，GPT P0 修复）。
 *
 * 问题（QFRLEA.c file.write 旧实现）：直接 fopen(target,"wb") 后
 * fwrite/fclose，全不检查返回值；"wb" 先截断原文件，磁盘写满／
 * 权限不足／部分写入时仍可能返回预期 size，且原文件已被截断破坏。
 *
 * 修法：临时文件写入 → 逐段检查实际写入字节数（短写循环续写、
 * 写满／出错即失败）→ fflush＋fclose 均检查 → 成功后才同卷替换
 * 目标文件（Windows 用 MoveFileExA REPLACE_EXISTING，POSIX 用
 * rename 原子替换）。任何一步失败都删临时文件、原文件原样保留、
 * 返回失败，绝不返回成功。
 *
 * 本文件刻意保持可移植（仅替换一步按平台区分），以便 Linux 沙箱
 * 单测能直接覆盖同一份写路径；Windows 服务本体（QFRLEA.c）与
 * 单测（test/test_lea.c）共用此实现。
 */
#ifndef LEA_FILEWRITE_H
#define LEA_FILEWRITE_H

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/* 原子写 target（成功返回 1，失败返回 0 且原文件不动）。
 * data 可为 NULL 仅当 len == 0。失败时 detail（可为 NULL）填入
 * 下列原因之一：file-write-bad-arg / file-tmp-path-too-long /
 * file-open-failed / file-write-failed / file-flush-failed /
 * file-close-failed / file-replace-failed。
 * 临时文件名为 target + ".tmp.<pid>"，与目标同目录（同卷）。 */
int lea_file_write_atomic(const char *target, const unsigned char *data,
                          size_t len, char *detail, size_t detail_size);

/* 同卷替换 tmp -> target（成功返回 1，失败返回 0 且目标原文件不动）。
 * Windows 用 MoveFileExA(REPLACE_EXISTING | WRITE_THROUGH)（具替换语义，
 * 不先删旧目标）；POSIX 用 rename（原生原子替换）。绝不要在调用方写
 * “先 remove(target) 再 rename”的两步替换——中间空窗一旦 rename 失败
 * 旧文件即丢失（A9：idem 快照与 binding.dat 均曾因此丢文件）。 */
int lea_file_replace(const char *tmp, const char *target);

#ifdef __cplusplus
}
#endif

#endif /* LEA_FILEWRITE_H */
