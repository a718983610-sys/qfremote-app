/* ush_snapshot.h — USH 截图（Windows）。
 * 抓屏：GDI BitBlt（虚拟屏或指定窗口客户区外框）；编码：WIC PNG 编码器
 * （纯 C COM 调用，不依赖 GDI+ C++ 类；mingw 的 gdiplus.h 不提供 C 平面 API）。
 * 两种返回：mode=file（默认，写 %ProgramData%\QFR\LEA\snapshots\*.png，
 * 回路径）或 mode=inline（PNG Base64 进响应，超 6MB 拒绝并提示用 file）。
 * 锁屏时由调用方（ush.c 的会话门）先拦，本模块不重复判断。
 * H24：snapshots 目录只 SYSTEM／Administrators／当前登录用户可读写
 * （PROTECTED_DACL，不继承父目录 ACL），每次落盘前剪枝（最多 50 个、
 * 超 7 天删）。加固失败为 best-effort（非 NTFS 卷等），不阻塞截图，
 * 真机须用 icacls 核对。
 * S-025（2026-11-15）：① 分辨率上限——最长边超 1920 即按比例降采样
 * （HALFTONE），结果带 "downscaled"；② 密码遮罩——抓屏后先遮经典
 * Win32 Edit 密码框（类名 Edit＋ES_PASSWORD 样式，区域涂不透明黑），
 * 再降采样，结果带 "masked_password_fields"；③ 设备端提示条——抓屏
 * 前弹置顶小窗（"QFRemote 正在截图…"，独立线程＋自带消息泵，不阻塞
 * 管道线程；建窗失败即无提示继续），编码完成后撤掉，结果带
 * "notice_shown"。提示条本身会出现在截图里（有意为之：远端看到的
 * 画面与本机用户看到的提示一致）。
 * 已知局限：现代 UIA 密码框（如 Chromium 密码字段、WPF PasswordBox）
 * 不是 Win32 Edit，不在遮罩之列——见 ush_snapshot.c 注释，真机验收
 * 见 WINDOWS-TESTS.md。安全桌面（Winlogon／UAC 提示）不在用户会话
 * 抓屏范围内：BitBlt 抓不到安全桌面内容，锁屏时由调用方会话门先拦。
 */
#ifndef QFR_USH_SNAPSHOT_H
#define QFR_USH_SNAPSHOT_H

#include "ush_json.h"

int ush_ui_snapshot(const ush_request_t *req, char *data_json, size_t data_size,
                    char *err_code, size_t err_code_size,
                    char *err_text, size_t err_text_size);

/* H24：加固截图目录 ACL（成功 1／失败 0）；剪枝目录（返回删除数）。
 * 供单测与调用方复用；ush_ui_snapshot 的 file 模式每次落盘前自动调。 */
int ush_snapshot_harden_dir(const WCHAR *dir_w);
int ush_snapshot_prune_dir(const char *dir_utf8, int max_files, int max_age_days);

#endif /* QFR_USH_SNAPSHOT_H */
