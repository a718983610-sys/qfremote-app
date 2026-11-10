/* ush_uia.h — USH 的 UIA 执行引擎（Windows）。
 * 实现 DESIGN.md §5.1：UIA 首选；定位 AutomationId → Name+ControlType →
 * ClassName+Index → 窗口内相对坐标 → 图像模板（MVP 未实现，见下）；
 * 优先后台 Pattern（Invoke/Toggle/SelectionItem/Value），无需窗口前置；
 * 必须坐标点击时才 ShowWindow(SW_RESTORE) + SetForegroundWindow；
 * PerMonitorV2 DPI awareness（主程序入口声明，见 ush.c）；
 * 点击后等 UIA 属性变化确认；普通点击最多 2 次重试（200ms/500ms），
 * 危险按钮不自动重试。
 *
 * 本文件只负责"找到元素并执行"，不解析信封（解析在 ush_json.c），
 * 不管管道（在 ush.c），不管截图文件编码（在 ush_snapshot.c）。
 */
#ifndef QFR_USH_UIA_H
#define QFR_USH_UIA_H

#include "ush_json.h"

/* 定位目标（从 params.target 解析；各字段缺失即不用该策略）。 */
typedef struct {
    char window_title[256];  /* 限定顶层窗口（Name 匹配，子串） */
    char window_class[128];  /* 限定顶层窗口（ClassName 精确） */
    char automation_id[256];
    char name[256];
    char control_type[64];   /* 如 Button/Edit/Text/CheckBox/ListItem… */
    char class_name[128];
    long index;              /* ClassName+Index 用；-1=未指定 */
    double rel_x, rel_y;     /* 窗口内相对坐标 0..1；has_rel=1 时有效 */
    int has_rel;
    long x, y;               /* 绝对坐标（物理像素；coords=logical 时按窗口 DPI 换算） */
    int has_xy;
    char coords[16];         /* "physical"（默认）或 "logical" */
    char image_template[512];/* 图像模板路径/Base64；MVP 未实现 */
    int has_image;
} ush_target_t;

/* 从 params_json 里解析 target（无 target 字段时全空，不报错）。 */
void ush_parse_target(const char *params_json, ush_target_t *out);

/* 初始化 UIA（CoInitialize + CoCreateInstance CUIAutomation）。
 * 须在主线程调用一次；失败返回 0。 */
int ush_uia_init(void);
void ush_uia_shutdown(void);

/* 会话门：交互式会话已解锁才返回 1。锁屏/休眠/断开会话返回 0，
 * err_code 填 QFR_USH_SESSION_LOCKED 或 QFR_USH_NO_INTERACTIVE_SESSION。 */
int ush_session_interactive(char *err_code, size_t err_size);

/* 执行命令。成功返回 1，data_json 填好结果对象原文（含花括号）；
 * 失败返回 0，err_code 填错误码，err_text 填人类可读说明（不含敏感明文）。
 * retry_count 回填实际重试次数；window_title 回填目标窗口标题（可空）。 */
int ush_ui_click(const ush_request_t *req, char *data_json, size_t data_size,
                 char *err_code, size_t err_code_size,
                 char *err_text, size_t err_text_size,
                 int *retry_count, char *window_title, size_t window_title_size);
int ush_ui_input(const ush_request_t *req, char *data_json, size_t data_size,
                 char *err_code, size_t err_code_size,
                 char *err_text, size_t err_text_size,
                 int *retry_count, char *window_title, size_t window_title_size);
int ush_ui_tree(const ush_request_t *req, char *data_json, size_t data_size,
                char *err_code, size_t err_code_size,
                char *err_text, size_t err_text_size,
                char *window_title, size_t window_title_size);

#endif /* QFR_USH_UIA_H */
