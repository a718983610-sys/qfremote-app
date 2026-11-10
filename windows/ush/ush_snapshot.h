/* ush_snapshot.h — USH 截图（Windows）。
 * 抓屏：GDI BitBlt（虚拟屏或指定窗口客户区外框）；编码：WIC PNG 编码器
 * （纯 C COM 调用，不依赖 GDI+ C++ 类；mingw 的 gdiplus.h 不提供 C 平面 API）。
 * 两种返回：mode=file（默认，写 %ProgramData%\QFR\LEA\snapshots\*.png，
 * 回路径）或 mode=inline（PNG Base64 进响应，超 6MB 拒绝并提示用 file）。
 * 锁屏时由调用方（ush.c 的会话门）先拦，本模块不重复判断。
 */
#ifndef QFR_USH_SNAPSHOT_H
#define QFR_USH_SNAPSHOT_H

#include "ush_json.h"

int ush_ui_snapshot(const ush_request_t *req, char *data_json, size_t data_size,
                    char *err_code, size_t err_code_size,
                    char *err_text, size_t err_text_size);

#endif /* QFR_USH_SNAPSHOT_H */
