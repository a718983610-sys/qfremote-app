/* QFRLEA 首装服务安装子命令（A1，2026-11-13）
 * =================================================================
 * 把 install-lea.ps1 里的服务安装逻辑迁入 C（PLAN.md §2 A1）：
 *   QFRLEA.exe --install-service [--repair]   安装／修复 QFRLEA 服务
 *   QFRLEA.exe --repair                       同 --install-service --repair
 *   QFRLEA.exe --uninstall-service            停服务＋删服务＋清 A1 注册表
 *   QFRLEA.exe --verify-manifest <dir> <manifest>
 *       逐文件 SHA-256 校验安装目录（安装器内置清单，见
 *       windows/tools/gen_file_manifest.py）
 *
 * 安全边界（写死，不许放宽）：
 *   - 三个子命令只认本地命令行 argv，绝不经命名管道／LEA API／
 *     qf-lea-client 远程调用（QFRLEA.c 的管道分发与 lea-core.js
 *     白名单里不加它们；main() 在 StartServiceCtrlDispatcherW
 *     之前就分流，服务运行时收不到这些命令）。
 *   - --install-service 须管理员令牌，非管理员直接 exit 2，不静默成功。
 *   - binPath 只取本 exe 所在目录（GetModuleFileNameW），不接受调用方
 *     传入的任何路径／参数，防参数注入。
 *   - 注册表只写 HKLM\SOFTWARE\QFR\LEA（A1 新键）＋兼容旧键
 *     HKLM\SOFTWARE\QFRemote\LEA（install-lea.ps1 互通）。
 *   - 失败写 installState=PendingRepair，exit 非零；升级失败时恢复旧
 *     服务配置并尝试重起旧服务（文件级回滚由安装器负责：安装器在解压
 *     前已备份 $INSTDIR\LEA，见 installer.nsi）。
 *
 * 纯函数（lea_version_compare／lea_parse_manifest_line／
 * lea_is_service_subcommand）不依赖 Windows，可在 Linux 单测里跑
 * （见 test/test_lea.c 的 A1 组）；其余函数仅 _WIN32 下编译。
 */
#ifndef QFRLEA_INSTALL_H
#define QFRLEA_INSTALL_H

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/* 版本比较：点分数字段逐段比，缺段当 0；a<b 返回 -1，相等 0，a>b 返回 1。
 * NULL／空串当 "0"；非数字段按字典序比（只用于兜底，正常版本号全是数字）。 */
int lea_version_compare(const char *a, const char *b);

/* 清单行解析：形如 "<64 位小写／大写 hex><空格><相对路径>"（sha256sum 格式，
 * 允许 1 个以上空格／Tab，允许 "*" 二进制标记）。hash_out 须 ≥65 字节，
 * path_out 须 ≥260 字节。返回 1=合法并已填出；0=非法（hash 非 64 hex、
 * 路径为空／绝对路径／含 ".." 段）。 */
int lea_parse_manifest_line(const char *line, char *hash_out, size_t hash_size,
                            char *path_out, size_t path_size);

/* 是否 A1 服务子命令（--install-service／--repair／--uninstall-service／
 * --verify-manifest）。供 main() 分流与单测断言“集合封闭”。 */
int lea_is_service_subcommand(const char *arg);

#ifdef _WIN32
/* 文件 SHA-256（CryptoAPI CALG_SHA256）。返回 1=已算出小写 hex（64＋NUL）；
 * 0=失败（文件不存在／读失败／CryptoAPI 失败）。 */
int lea_sha256_file(const char *path_utf8, char *hex_out);

/* 安装／修复服务。repair=0：全新安装或已存在时更新配置；repair=1：
 * 显式修复（校验 binPath／ACL／注册表，不对即纠正，重启服务）。
 * 返回 0=成功（服务 RUNNING 且注册表已写）；1=失败（已写 PendingRepair）；
 * 2=非管理员。失败时打印 "LEA-INSTALL: failed <原因>" 到 stderr。 */
int lea_service_install(int repair);

/* 卸载服务：停服务 → 删服务 → 清 HKLM\SOFTWARE\QFR\LEA。
 * 返回 0=成功（服务已不存在）；1=失败。 */
int lea_service_uninstall(void);

/* 逐文件校验：manifest 每行 "<sha256>  <相对路径>"，逐件算安装目录下
 * 对应文件的 SHA-256。返回 0=全部一致；1=有缺失／不一致（逐件打印）；
 * 2=清单读不到／格式非法。 */
int lea_verify_manifest(const char *dir_utf8, const char *manifest_utf8);
#endif /* _WIN32 */

#ifdef __cplusplus
}
#endif

#endif /* QFRLEA_INSTALL_H */
