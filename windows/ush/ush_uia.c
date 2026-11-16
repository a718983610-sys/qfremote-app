/* 见 ush_uia.h。
 * 注意：mingw-w64 的 uiautomationclient.h 内 CLSID_CUIAutomation /
 * IID_IUIAutomation 等 GUID 已与微软公开值核对一致（2026-11-10 实查，
 * 如 CLSID {FF48DBA4-60EF-4201-AA87-54103EEF594E}），直接用头文件定义。
 * INITGUID 只在本文件定义一次，使 GUID 符号落在此编译单元。
 */
#define INITGUID
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <initguid.h>
#include <ole2.h>
#include <oleauto.h>
#include <uiautomation.h>
#include <wtsapi32.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include "ush_uia.h"

static IUIAutomation *g_auto = NULL;
static DWORD g_uia_thread = 0;
static int g_com_initialized = 0;

/* ---------- 小工具 ---------- */

static WCHAR *utf8_to_wide(const char *s) {
    if (!s) return NULL;
    int n = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, s, -1, NULL, 0);
    if (n <= 0) return NULL;
    WCHAR *w = (WCHAR *)malloc((size_t)n * sizeof(WCHAR));
    if (!w) return NULL;
    if (!MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, s, -1, w, n)) { free(w); return NULL; }
    return w;
}

static void wide_to_utf8(const WCHAR *w, char *out, size_t out_size) {
    if (!out || out_size == 0) return;
    out[0] = '\0';
    if (!w) return;
    WideCharToMultiByte(CP_UTF8, 0, w, -1, out, (int)out_size, NULL, NULL);
}

/* ControlType 名字 → UIA_ControlTypeId（值以 mingw 头文件宏为准，如
 * Button=50000, TreeItem=50024, Window=50032）。未知返回 0。 */
static int control_type_id(const char *name) {
    if (!name || !name[0]) return 0;
    static const struct { const char *n; int id; } map[] = {
        {"Button", UIA_ButtonControlTypeId},
        {"Calendar", UIA_CalendarControlTypeId},
        {"CheckBox", UIA_CheckBoxControlTypeId},
        {"ComboBox", UIA_ComboBoxControlTypeId},
        {"Custom", UIA_CustomControlTypeId},
        {"DataGrid", UIA_DataGridControlTypeId},
        {"DataItem", UIA_DataItemControlTypeId},
        {"Document", UIA_DocumentControlTypeId},
        {"Edit", UIA_EditControlTypeId},
        {"Group", UIA_GroupControlTypeId},
        {"Header", UIA_HeaderControlTypeId},
        {"HeaderItem", UIA_HeaderItemControlTypeId},
        {"Hyperlink", UIA_HyperlinkControlTypeId},
        {"Image", UIA_ImageControlTypeId},
        {"List", UIA_ListControlTypeId},
        {"ListItem", UIA_ListItemControlTypeId},
        {"Menu", UIA_MenuControlTypeId},
        {"MenuBar", UIA_MenuBarControlTypeId},
        {"MenuItem", UIA_MenuItemControlTypeId},
        {"Pane", UIA_PaneControlTypeId},
        {"ProgressBar", UIA_ProgressBarControlTypeId},
        {"RadioButton", UIA_RadioButtonControlTypeId},
        {"ScrollBar", UIA_ScrollBarControlTypeId},
        {"Separator", UIA_SeparatorControlTypeId},
        {"Slider", UIA_SliderControlTypeId},
        {"Spinner", UIA_SpinnerControlTypeId},
        {"SplitButton", UIA_SplitButtonControlTypeId},
        {"StatusBar", UIA_StatusBarControlTypeId},
        {"Tab", UIA_TabControlTypeId},
        {"TabItem", UIA_TabItemControlTypeId},
        {"Table", UIA_TableControlTypeId},
        {"Text", UIA_TextControlTypeId},
        {"Thumb", UIA_ThumbControlTypeId},
        {"TitleBar", UIA_TitleBarControlTypeId},
        {"ToolBar", UIA_ToolBarControlTypeId},
        {"ToolTip", UIA_ToolTipControlTypeId},
        {"Tree", UIA_TreeControlTypeId},
        {"TreeItem", UIA_TreeItemControlTypeId},
        {"Window", UIA_WindowControlTypeId},
    };
    for (size_t i = 0; i < sizeof(map) / sizeof(map[0]); i++) {
        if (strcmp(name, map[i].n) == 0) return map[i].id;
    }
    return 0;
}

static const char *control_type_name(int id) {
    switch (id) {
        case UIA_ButtonControlTypeId: return "Button";
        case UIA_CalendarControlTypeId: return "Calendar";
        case UIA_CheckBoxControlTypeId: return "CheckBox";
        case UIA_ComboBoxControlTypeId: return "ComboBox";
        case UIA_CustomControlTypeId: return "Custom";
        case UIA_DataGridControlTypeId: return "DataGrid";
        case UIA_DataItemControlTypeId: return "DataItem";
        case UIA_DocumentControlTypeId: return "Document";
        case UIA_EditControlTypeId: return "Edit";
        case UIA_GroupControlTypeId: return "Group";
        case UIA_HeaderControlTypeId: return "Header";
        case UIA_HeaderItemControlTypeId: return "HeaderItem";
        case UIA_HyperlinkControlTypeId: return "Hyperlink";
        case UIA_ImageControlTypeId: return "Image";
        case UIA_ListControlTypeId: return "List";
        case UIA_ListItemControlTypeId: return "ListItem";
        case UIA_MenuControlTypeId: return "Menu";
        case UIA_MenuBarControlTypeId: return "MenuBar";
        case UIA_MenuItemControlTypeId: return "MenuItem";
        case UIA_PaneControlTypeId: return "Pane";
        case UIA_ProgressBarControlTypeId: return "ProgressBar";
        case UIA_RadioButtonControlTypeId: return "RadioButton";
        case UIA_ScrollBarControlTypeId: return "ScrollBar";
        case UIA_SeparatorControlTypeId: return "Separator";
        case UIA_SliderControlTypeId: return "Slider";
        case UIA_SpinnerControlTypeId: return "Spinner";
        case UIA_SplitButtonControlTypeId: return "SplitButton";
        case UIA_StatusBarControlTypeId: return "StatusBar";
        case UIA_TabControlTypeId: return "Tab";
        case UIA_TabItemControlTypeId: return "TabItem";
        case UIA_TableControlTypeId: return "Table";
        case UIA_TextControlTypeId: return "Text";
        case UIA_ThumbControlTypeId: return "Thumb";
        case UIA_TitleBarControlTypeId: return "TitleBar";
        case UIA_ToolBarControlTypeId: return "ToolBar";
        case UIA_ToolTipControlTypeId: return "ToolTip";
        case UIA_TreeControlTypeId: return "Tree";
        case UIA_TreeItemControlTypeId: return "TreeItem";
        case UIA_WindowControlTypeId: return "Window";
        default: return "Unknown";
    }
}

/* 取元素字符串属性（Name/AutomationId/ClassName）；失败返回空串。 */
static void get_str_prop(IUIAutomationElement *el, PROPERTYID pid, char *out, size_t out_size) {
    if (!out || out_size == 0) return;
    out[0] = '\0';
    if (!el) return;
    VARIANT v;
    VariantInit(&v);
    if (el->lpVtbl->GetCurrentPropertyValue(el, pid, &v) == S_OK && v.vt == VT_BSTR && v.bstrVal) {
        wide_to_utf8(v.bstrVal, out, out_size);
    }
    VariantClear(&v);
}

static int get_int_prop(IUIAutomationElement *el, PROPERTYID pid, int *out) {
    if (!el || !out) return 0;
    VARIANT v;
    VariantInit(&v);
    int ok = 0;
    if (el->lpVtbl->GetCurrentPropertyValue(el, pid, &v) == S_OK && v.vt == VT_I4) {
        *out = v.lVal;
        ok = 1;
    }
    VariantClear(&v);
    return ok;
}

static int get_bool_prop(IUIAutomationElement *el, PROPERTYID pid, int *out) {
    if (!el || !out) return 0;
    VARIANT v;
    VariantInit(&v);
    int ok = 0;
    if (el->lpVtbl->GetCurrentPropertyValue(el, pid, &v) == S_OK && v.vt == VT_BOOL) {
        *out = v.boolVal ? 1 : 0;
        ok = 1;
    }
    VariantClear(&v);
    return ok;
}

/* 元素状态签名：Name + IsEnabled + Value（ValuePattern 有才取）。
 * 用于点击/输入后的"属性变化确认"。取失败（如元素已消失）返回 NULL。 */
static char *element_signature(IUIAutomationElement *el) {
    char name[256], value[512];
    int enabled = -1;
    get_str_prop(el, UIA_NamePropertyId, name, sizeof(name));
    get_bool_prop(el, UIA_IsEnabledPropertyId, &enabled);
    value[0] = '\0';
    IUnknown *unk = NULL;
    if (el->lpVtbl->GetCurrentPattern(el, UIA_ValuePatternId, &unk) == S_OK && unk) {
        IUIAutomationValuePattern *vp = NULL;
        if (unk->lpVtbl->QueryInterface(unk, &IID_IUIAutomationValuePattern, (void **)&vp) == S_OK && vp) {
            BSTR b = NULL;
            if (vp->lpVtbl->get_CurrentValue(vp, &b) == S_OK && b) {
                wide_to_utf8(b, value, sizeof(value));
                SysFreeString(b);
            }
            vp->lpVtbl->Release(vp);
        }
        unk->lpVtbl->Release(unk);
    }
    char *sig = (char *)malloc(1024);
    if (!sig) return NULL;
    snprintf(sig, 1024, "name=%s|enabled=%d|value=%s", name, enabled, value);
    return sig;
}

/* ---------- 目标解析 ---------- */

void ush_parse_target(const char *params_json, ush_target_t *out) {
    memset(out, 0, sizeof(*out));
    out->index = -1;
    strcpy(out->coords, "physical");
    if (!params_json) return;
    char tgt[4096];
    const char *src = params_json;
    if (ush_json_get_object(params_json, "target", tgt, sizeof(tgt)) == 1) src = tgt;
    ush_json_get_string(src, "window_title", out->window_title, sizeof(out->window_title));
    ush_json_get_string(src, "window_class", out->window_class, sizeof(out->window_class));
    ush_json_get_string(src, "automation_id", out->automation_id, sizeof(out->automation_id));
    ush_json_get_string(src, "name", out->name, sizeof(out->name));
    ush_json_get_string(src, "control_type", out->control_type, sizeof(out->control_type));
    ush_json_get_string(src, "class_name", out->class_name, sizeof(out->class_name));
    long idx = -1;
    if (ush_json_get_long(src, "index", &idx)) out->index = idx;
    double rx = 0, ry = 0;
    /* #11：相对坐标以 rel_x/rel_y（0..1）传；优先取 JSON 数字（0.5），
     * 字符串形式（"0.5"）仍兼容。旧实现只取字符串，数字形式会被静默
     * 忽略、has_rel 恒为 0，点击走错分支。 */
    char numbuf[64];
    if (ush_json_get_double(src, "rel_x", &rx)) out->has_rel = 1;
    else if (ush_json_get_string(src, "rel_x", numbuf, sizeof(numbuf))) { rx = atof(numbuf); out->has_rel = 1; }
    if (ush_json_get_double(src, "rel_y", &ry)) out->has_rel = 1;
    else if (ush_json_get_string(src, "rel_y", numbuf, sizeof(numbuf))) { ry = atof(numbuf); out->has_rel = 1; }
    long lx = 0, ly = 0;
    if (ush_json_get_long(src, "x", &lx)) { out->x = lx; out->has_xy = 1; }
    if (ush_json_get_long(src, "y", &ly)) { out->y = ly; out->has_xy = 1; }
    int rel = 0;
    if (ush_json_get_bool(src, "relative", &rel) && rel && out->has_xy) {
        /* relative:true 时 x/y 是 0..1000 的千分比 */
        rx = (double)out->x / 1000.0;
        ry = (double)out->y / 1000.0;
        out->has_rel = 1;
        out->has_xy = 0;
    }
    out->rel_x = isfinite(rx) ? fmin(1.0, fmax(0.0, rx)) : 0.0;
    out->rel_y = isfinite(ry) ? fmin(1.0, fmax(0.0, ry)) : 0.0;
    ush_json_get_string(src, "coords", out->coords, sizeof(out->coords));
    if (ush_json_get_string(src, "image_template", out->image_template, sizeof(out->image_template))) {
        out->has_image = 1;
    }
}

/* ---------- UIA 初始化 / 会话门 ---------- */

int ush_uia_init(void) {
    if (g_auto) return g_uia_thread == GetCurrentThreadId();
    HRESULT hr = CoInitializeEx(NULL, COINIT_MULTITHREADED);
    if (FAILED(hr)) return 0;
    hr = CoCreateInstance(&CLSID_CUIAutomation, NULL, CLSCTX_INPROC_SERVER,
                          &IID_IUIAutomation, (void **)&g_auto);
    if (FAILED(hr) || !g_auto) {
        g_auto = NULL;
        CoUninitialize();
        return 0;
    }
    g_uia_thread = GetCurrentThreadId();
    g_com_initialized = 1;
    return 1;
}

void ush_uia_shutdown(void) {
    if (g_uia_thread != GetCurrentThreadId()) return;
    if (g_auto) { g_auto->lpVtbl->Release(g_auto); g_auto = NULL; }
    if (g_com_initialized) CoUninitialize();
    g_com_initialized = 0;
    g_uia_thread = 0;
}

int ush_session_interactive(char *err_code, size_t err_size) {
    /* ① 会话连接态须为 Active（锁屏/断开时为 Locked/Disconnected）。
     * WTSConnectState 的 ppBuffer 指向一个 WTS_CONNECTSTATE_CLASS 值（DWORD）。 */
    WTS_CONNECTSTATE_CLASS *pstate = NULL;
    DWORD bytes = 0;
    if (WTSQuerySessionInformationW(WTS_CURRENT_SERVER_HANDLE, WTS_CURRENT_SESSION,
                                    WTSConnectState, (LPWSTR *)&pstate, &bytes)
        && pstate && bytes >= sizeof(DWORD)) {
        DWORD st = (DWORD)*pstate;
        WTSFreeMemory(pstate);
        if (st != WTSActive) {
            if (err_code && err_size) strncpy(err_code, USH_ERR_SESSION_LOCKED, err_size - 1);
            return 0;
        }
    } else {
        if (pstate) WTSFreeMemory(pstate);
        /* 查不到会话态时不直接放行：继续用输入桌面判据兜底 */
    }
    /* ② 打开输入桌面后查桌面名是否为 Default（#10）。锁屏时输入桌面切
     * 到 Winlogon，OpenInputDesktop 可能成功返回 Winlogon 桌面句柄，
     * 只看“打不打开”拦不住锁屏；桌面名不是 Default 即判锁屏。
     * 桌面名取不到时 fail-closed（不放行）。 */
    HDESK desk = OpenInputDesktop(0, FALSE, GENERIC_READ);
    if (!desk) {
        if (err_code && err_size) strncpy(err_code, USH_ERR_SESSION_LOCKED, err_size - 1);
        return 0;
    }
    WCHAR desk_name[64] = { 0 };
    DWORD needed = 0;
    BOOL name_ok = GetUserObjectInformationW(desk, UOI_NAME, desk_name,
                                             sizeof(desk_name), &needed);
    CloseDesktop(desk);
    if (!name_ok || _wcsicmp(desk_name, L"Default") != 0) {
        if (err_code && err_size) strncpy(err_code, USH_ERR_SESSION_LOCKED, err_size - 1);
        return 0;
    }
    return 1;
}

/* ---------- 定位 ---------- */

static IUIAutomationCondition *prop_cond(PROPERTYID pid, const char *utf8_value) {
    WCHAR *w = utf8_to_wide(utf8_value);
    if (!w) return NULL;
    VARIANT v;
    VariantInit(&v);
    v.vt = VT_BSTR;
    v.bstrVal = SysAllocString(w);
    free(w);
    IUIAutomationCondition *cond = NULL;
    if (g_auto->lpVtbl->CreatePropertyCondition(g_auto, pid, v, &cond) != S_OK) cond = NULL;
    VariantClear(&v);
    return cond;
}

static IUIAutomationCondition *prop_cond_int(PROPERTYID pid, int value) {
    VARIANT v;
    VariantInit(&v);
    v.vt = VT_I4;
    v.lVal = value;
    IUIAutomationCondition *cond = NULL;
    if (g_auto->lpVtbl->CreatePropertyCondition(g_auto, pid, v, &cond) != S_OK) cond = NULL;
    VariantClear(&v);
    return cond;
}

static IUIAutomationCondition *and_cond(IUIAutomationCondition *a, IUIAutomationCondition *b) {
    if (!a) return b;
    if (!b) return a;
    IUIAutomationCondition *out = NULL;
    if (g_auto->lpVtbl->CreateAndCondition(g_auto, a, b, &out) != S_OK) out = NULL;
    a->lpVtbl->Release(a);
    b->lpVtbl->Release(b);
    return out;
}

/* 在 scope 内找顶层窗口（window_title 子串匹配 + window_class 精确匹配）。
 * 不限定则返回 scope（调用方持有引用计数，须 Release）。 */
static IUIAutomationElement *find_scope_window(IUIAutomationElement *root,
                                               const ush_target_t *t, DWORD deadline_ms) {
    if (!t->window_title[0] && !t->window_class[0]) {
        if (root) root->lpVtbl->AddRef(root);
        return root;
    }
    IUIAutomationCondition *cond = NULL;
    if (t->window_class[0]) {
        cond = and_cond(cond, prop_cond(UIA_ClassNamePropertyId, t->window_class));
        cond = and_cond(cond, prop_cond_int(UIA_ControlTypePropertyId, UIA_WindowControlTypeId));
    }
    /* Name 用子串匹配：先取全部顶层窗口再比对（UIA 条件只支持精确匹配）。 */
    IUIAutomationCondition *win_cond = cond;
    if (!win_cond) {
        win_cond = prop_cond_int(UIA_ControlTypePropertyId, UIA_WindowControlTypeId);
    }
    IUIAutomationElementArray *arr = NULL;
    IUIAutomationElement *found = NULL;
    DWORD start = GetTickCount();
    while (GetTickCount() - start < deadline_ms) {
        if (root->lpVtbl->FindAll(root, TreeScope_Children, win_cond, &arr) == S_OK && arr) {
            int len = 0;
            arr->lpVtbl->get_Length(arr, &len);
            for (int i = 0; i < len && !found; i++) {
                IUIAutomationElement *el = NULL;
                if (arr->lpVtbl->GetElement(arr, i, &el) != S_OK || !el) continue;
                int ok = 1;
                if (t->window_title[0]) {
                    char name[256];
                    get_str_prop(el, UIA_NamePropertyId, name, sizeof(name));
                    if (strstr(name, t->window_title) == NULL) ok = 0;
                }
                if (ok && t->window_class[0]) {
                    char cls[128];
                    get_str_prop(el, UIA_ClassNamePropertyId, cls, sizeof(cls));
                    if (strcmp(cls, t->window_class) != 0) ok = 0;
                }
                if (ok) found = el; else el->lpVtbl->Release(el);
            }
            arr->lpVtbl->Release(arr);
            arr = NULL;
        }
        if (found) break;
        Sleep(100);
    }
    if (win_cond) win_cond->lpVtbl->Release(win_cond);
    return found;
}

/* 按策略顺序定位元素。返回 1 找到（*out 须 Release），0 未找到。 */
static int find_element(IUIAutomationElement *scope, const ush_target_t *t,
                        DWORD deadline_ms, IUIAutomationElement **out) {
    *out = NULL;
    /* r9：三种元素定位策略（AutomationId／Name／ClassName）一个都没给
     * 时（如只有 x/y 坐标的 ui.input），旧实现在 while 里空转满整个
     * deadline 才返回 0——坐标 input 恒以 5000ms 超时收场，且 LEA 侧
     * 同时报 QFR_LEA_TIMEOUT。无策略即立即返回 0，由调用方走坐标分支。 */
    if (!t->automation_id[0] && !t->name[0] && !t->class_name[0]) return 0;
    DWORD start = GetTickCount();
    while (GetTickCount() - start < deadline_ms) {
        /* 策略 1：AutomationId */
        if (t->automation_id[0]) {
            IUIAutomationCondition *c = prop_cond(UIA_AutomationIdPropertyId, t->automation_id);
            if (c) {
                if (scope->lpVtbl->FindFirst(scope, TreeScope_Descendants, c, out) == S_OK && *out) {
                    c->lpVtbl->Release(c);
                    return 1;
                }
                c->lpVtbl->Release(c);
            }
        }
        /* 策略 2：Name + ControlType */
        if (t->name[0]) {
            IUIAutomationCondition *c = prop_cond(UIA_NamePropertyId, t->name);
            int ctid = control_type_id(t->control_type);
            if (ctid) c = and_cond(c, prop_cond_int(UIA_ControlTypePropertyId, ctid));
            if (c) {
                if (scope->lpVtbl->FindFirst(scope, TreeScope_Descendants, c, out) == S_OK && *out) {
                    c->lpVtbl->Release(c);
                    return 1;
                }
                c->lpVtbl->Release(c);
            }
        }
        /* 策略 3：ClassName + Index */
        if (t->class_name[0]) {
            IUIAutomationCondition *c = prop_cond(UIA_ClassNamePropertyId, t->class_name);
            int ctid = control_type_id(t->control_type);
            if (ctid) c = and_cond(c, prop_cond_int(UIA_ControlTypePropertyId, ctid));
            if (c) {
                IUIAutomationElementArray *arr = NULL;
                if (scope->lpVtbl->FindAll(scope, TreeScope_Descendants, c, &arr) == S_OK && arr) {
                    int len = 0;
                    arr->lpVtbl->get_Length(arr, &len);
                    long idx = t->index >= 0 ? t->index : 0;
                    if (idx < len) {
                        if (arr->lpVtbl->GetElement(arr, (int)idx, out) == S_OK && *out) {
                            arr->lpVtbl->Release(arr);
                            c->lpVtbl->Release(c);
                            return 1;
                        }
                    }
                    arr->lpVtbl->Release(arr);
                }
                c->lpVtbl->Release(c);
            }
        }
        /* 策略 4/5 在调用方处理（相对坐标 / 图像模板）。此处只等 UIA 元素出现。 */
        Sleep(100);
    }
    return 0;
}

/* 元素所属窗口句柄（NativeWindowHandle 属性；无则 NULL）。 */
static HWND element_window(IUIAutomationElement *el) {
    if (!el) return NULL;
    VARIANT v;
    VariantInit(&v);
    HWND hwnd = NULL;
    if (el->lpVtbl->GetCurrentPropertyValue(el, UIA_NativeWindowHandlePropertyId, &v) == S_OK
        && v.vt == VT_I4) {
        hwnd = (HWND)(ULONG_PTR)v.lVal;
    }
    VariantClear(&v);
    return hwnd;
}

/* 仅坐标点击需要：还原并前置窗口。后台 Pattern 路径不调用。 */
static int bring_window_forward(HWND hwnd) {
    if (!hwnd) return 1; /* explicit desktop coordinates have no window */
    HWND root = GetAncestor(hwnd, GA_ROOT);
    if (!root) return 0;
    if (IsIconic(root)) ShowWindow(root, SW_RESTORE);
    if (GetForegroundWindow() == root) return 1;
    if (!SetForegroundWindow(root)) return 0;
    return GetForegroundWindow() == root;
}

static int point_in_virtual_screen(POINT pt) {
    LONG left = GetSystemMetrics(SM_XVIRTUALSCREEN), top = GetSystemMetrics(SM_YVIRTUALSCREEN);
    LONG width = GetSystemMetrics(SM_CXVIRTUALSCREEN), height = GetSystemMetrics(SM_CYVIRTUALSCREEN);
    return width > 0 && height > 0 && pt.x >= left && pt.y >= top &&
           (long long)pt.x < (long long)left + width && (long long)pt.y < (long long)top + height;
}

/* BoundingRectangle 回退中心点：UIA_BoundingRectanglePropertyId 返回的
 * SAFEARRAY 是 UiaRect [left, top, width, height]（不是 [l,t,r,b]），
 * 中心须为 left + width/2、top + height/2。N-10（2026-11-15）：旧代码
 * 把 width/height 当右／下边沿算 (left+width)/2，点落在元素之外
 * （如 left=100、width=50 时真中心 x=125，旧代码得 75），可能误触
 * 别的控件。抽成独立函数供单测直验。 */
static void bounding_rect_center(const double rect[4], POINT *pt) {
    pt->x = (LONG)(rect[0] + rect[2] / 2.0);
    pt->y = (LONG)(rect[1] + rect[3] / 2.0);
}

/* 取元素可点击点（ClickablePoint，失败则用 BoundingRectangle 中心）。 */
static int clickable_point(IUIAutomationElement *el, POINT *pt) {
    if (!el || !pt) return 0;
    POINT p;
    WINBOOL got = FALSE;
    if (el->lpVtbl->GetClickablePoint(el, &p, &got) == S_OK && got) {
        *pt = p;
        return 1;
    }
    VARIANT v;
    VariantInit(&v);
    int ok = 0;
    if (el->lpVtbl->GetCurrentPropertyValue(el, UIA_BoundingRectanglePropertyId, &v) == S_OK
        && (v.vt & VT_ARRAY)) {
        SAFEARRAY *sa = (v.vt & VT_BYREF) ? *(SAFEARRAY **)v.byref : v.parray;
        if (sa) {
            double rect[4] = {0};
            LONG lb = 0, ub = 0;
            if (SafeArrayGetLBound(sa, 1, &lb) == S_OK &&
                SafeArrayGetUBound(sa, 1, &ub) == S_OK && ub - lb >= 3) {
                for (int i = 0; i < 4; i++) {
                    double d = 0;
                    if (SafeArrayGetElement(sa, &(LONG){lb + i}, &d) == S_OK) rect[i] = d;
                }
                bounding_rect_center(rect, pt);
                ok = 1;
            }
        }
    }
    VariantClear(&v);
    return ok;
}

/* SendInput 鼠标左键点击物理坐标点。 */
static int send_mouse_click(POINT pt) {
    if (!point_in_virtual_screen(pt) || !SetCursorPos(pt.x, pt.y)) return 0;
    INPUT in[2];
    memset(in, 0, sizeof(in));
    in[0].type = INPUT_MOUSE; in[0].mi.dwFlags = MOUSEEVENTF_LEFTDOWN;
    in[1].type = INPUT_MOUSE; in[1].mi.dwFlags = MOUSEEVENTF_LEFTUP;
    return SendInput(2, in, sizeof(INPUT)) == 2;
}

/* ---------- Pattern 执行 ---------- */

/* 尝试后台 Pattern：Invoke → Toggle → SelectionItem。成功返回 1。 */
static int invoke_background_pattern(IUIAutomationElement *el, const char *control_type) {
    /* 显式类型优先：CheckBox/Radio 用 Toggle；ListItem/TreeItem/TabItem 用 SelectionItem */
    if (control_type && (strcmp(control_type, "CheckBox") == 0 ||
                         strcmp(control_type, "RadioButton") == 0)) {
        IUnknown *unk = NULL;
        if (el->lpVtbl->GetCurrentPattern(el, UIA_TogglePatternId, &unk) == S_OK && unk) {
            IUIAutomationTogglePattern *tp = NULL;
            HRESULT hr = unk->lpVtbl->QueryInterface(unk, &IID_IUIAutomationTogglePattern, (void **)&tp);
            unk->lpVtbl->Release(unk);
            if (hr == S_OK && tp) {
                hr = tp->lpVtbl->Toggle(tp);
                tp->lpVtbl->Release(tp);
                return SUCCEEDED(hr);
            }
        }
    }
    if (control_type && (strcmp(control_type, "ListItem") == 0 ||
                         strcmp(control_type, "TreeItem") == 0 ||
                         strcmp(control_type, "TabItem") == 0)) {
        IUnknown *unk = NULL;
        if (el->lpVtbl->GetCurrentPattern(el, UIA_SelectionItemPatternId, &unk) == S_OK && unk) {
            IUIAutomationSelectionItemPattern *sp = NULL;
            HRESULT hr = unk->lpVtbl->QueryInterface(unk, &IID_IUIAutomationSelectionItemPattern, (void **)&sp);
            unk->lpVtbl->Release(unk);
            if (hr == S_OK && sp) {
                hr = sp->lpVtbl->Select(sp);
                sp->lpVtbl->Release(sp);
                return SUCCEEDED(hr);
            }
        }
    }
    /* 默认：Invoke，失败再试 Toggle，再试 SelectionItem */
    IUnknown *unk = NULL;
    if (el->lpVtbl->GetCurrentPattern(el, UIA_InvokePatternId, &unk) == S_OK && unk) {
        IUIAutomationInvokePattern *ip = NULL;
        HRESULT hr = unk->lpVtbl->QueryInterface(unk, &IID_IUIAutomationInvokePattern, (void **)&ip);
        unk->lpVtbl->Release(unk);
        if (hr == S_OK && ip) {
            hr = ip->lpVtbl->Invoke(ip);
            ip->lpVtbl->Release(ip);
            if (SUCCEEDED(hr)) return 1;
        }
    }
    if (el->lpVtbl->GetCurrentPattern(el, UIA_TogglePatternId, &unk) == S_OK && unk) {
        IUIAutomationTogglePattern *tp = NULL;
        HRESULT hr = unk->lpVtbl->QueryInterface(unk, &IID_IUIAutomationTogglePattern, (void **)&tp);
        unk->lpVtbl->Release(unk);
        if (hr == S_OK && tp) {
            hr = tp->lpVtbl->Toggle(tp);
            tp->lpVtbl->Release(tp);
            if (SUCCEEDED(hr)) return 1;
        }
    }
    if (el->lpVtbl->GetCurrentPattern(el, UIA_SelectionItemPatternId, &unk) == S_OK && unk) {
        IUIAutomationSelectionItemPattern *sp = NULL;
        HRESULT hr = unk->lpVtbl->QueryInterface(unk, &IID_IUIAutomationSelectionItemPattern, (void **)&sp);
        unk->lpVtbl->Release(unk);
        if (hr == S_OK && sp) {
            hr = sp->lpVtbl->Select(sp);
            sp->lpVtbl->Release(sp);
            if (SUCCEEDED(hr)) return 1;
        }
    }
    return 0;
}

/* ---------- ui.click ---------- */

int ush_ui_click(const ush_request_t *req, char *data_json, size_t data_size,
                 char *err_code, size_t err_code_size,
                 char *err_text, size_t err_text_size,
                 int *retry_count, char *window_title, size_t window_title_size) {
    if (retry_count) *retry_count = 0;
    if (window_title && window_title_size) window_title[0] = '\0';
    if (!ush_uia_init()) {
        strncpy(err_code, USH_ERR_FAILED, err_code_size - 1);
        snprintf(err_text, err_text_size, "UIA init failed");
        return 0;
    }
    ush_target_t t;
    ush_parse_target(req->params_json, &t);
    if (t.has_image && !t.automation_id[0] && !t.name[0] && !t.class_name[0]
        && !t.has_rel && !t.has_xy) {
        strncpy(err_code, USH_ERR_NOT_SUPPORTED, err_code_size - 1);
        snprintf(err_text, err_text_size,
            "image_template locator not implemented in MVP (use automation_id/name/class/relative coords)");
        return 0;
    }
    DWORD deadline = (DWORD)req->timeout_ms;
    DWORD start = GetTickCount();
    IUIAutomationElement *root = NULL;
    if (g_auto->lpVtbl->GetRootElement(g_auto, &root) != S_OK || !root) {
        strncpy(err_code, USH_ERR_FAILED, err_code_size - 1);
        snprintf(err_text, err_text_size, "cannot get UIA root element");
        return 0;
    }
    IUIAutomationElement *scope = find_scope_window(root, &t, deadline);
    root->lpVtbl->Release(root);
    if (!scope) {
        strncpy(err_code, USH_ERR_NOT_FOUND, err_code_size - 1);
        snprintf(err_text, err_text_size, "target window not found");
        return 0;
    }
    if (window_title && window_title_size) {
        get_str_prop(scope, UIA_NamePropertyId, window_title, window_title_size);
    }

    int click_sent = 0;
    int attempt = 0; /* 0=首次，1/2=重试 */
    for (;;) {
        DWORD remain = deadline > (GetTickCount() - start) ? deadline - (GetTickCount() - start) : 0;
        if (remain == 0) break;
        IUIAutomationElement *el = NULL;
        int found = 0;
        if (t.automation_id[0] || t.name[0] || t.class_name[0]) {
            found = find_element(scope, &t, remain > 2000 ? 2000 : remain, &el);
        }
        if (!found && el) { el->lpVtbl->Release(el); el = NULL; }

        if (found && el) {
            char *before = element_signature(el);
            /* 先试后台 Pattern（无需前置窗口） */
            int pattern_ok = invoke_background_pattern(el, t.control_type);
            if (pattern_ok) {
                Sleep(150);
                char *after = element_signature(el);
                int changed = (!before && !after) ? 0 : (!before || !after || strcmp(before, after) != 0);
                free(before);
                free(after);
                el->lpVtbl->Release(el);
                /* Pattern Invoke 返回 S_OK 即为执行确认；change_observed 只是
                 * 附加信号（有些控件点击后自身属性不变，如导航按钮）。 */
                snprintf(data_json, data_size,
                    "{\"method\":\"pattern\",\"confirmed\":true,\"change_observed\":%s,\"retries\":%d}",
                    changed ? "true" : "false", attempt);
                scope->lpVtbl->Release(scope);
                if (retry_count) *retry_count = attempt;
                return 1;
            }
            free(before);
            /* 无 Pattern 可用 → 坐标点击（此时才前置窗口） */
            POINT pt;
            if (clickable_point(el, &pt)) {
                HWND hwnd = element_window(el);
                if (!bring_window_forward(hwnd) || GetTickCount() - start >= deadline) {
                    el->lpVtbl->Release(el); break;
                }
                char *b2 = element_signature(el);
                if (!send_mouse_click(pt)) { free(b2); el->lpVtbl->Release(el); break; }
                click_sent = 1;
                Sleep(150);
                char *a2 = element_signature(el);
                int changed = (!b2 && !a2) ? 0 : (!b2 || !a2 || strcmp(b2, a2) != 0);
                free(b2);
                free(a2);
                el->lpVtbl->Release(el);
                if (changed) {
                    snprintf(data_json, data_size,
                        "{\"method\":\"coordinate\",\"x\":%ld,\"y\":%ld,\"confirmed\":true,\"retries\":%d}",
                        (long)pt.x, (long)pt.y, attempt);
                    scope->lpVtbl->Release(scope);
                    if (retry_count) *retry_count = attempt;
                    return 1;
                }
                /* 未观测到属性变化：坐标点击本身已发出，是否成功无法确认。
                 * 按"不谎称已点击"：未确认则重试；重试耗尽则报失败。 */
            } else {
                el->lpVtbl->Release(el);
            }
        } else if (!found && (t.has_rel || t.has_xy)) {
            /* 策略 4：窗口内相对坐标 / 绝对坐标 */
            RECT wr;
            HWND hwnd = element_window(scope);
            POINT pt;
            int have_pt = 0;
            if (t.has_rel && hwnd && GetWindowRect(hwnd, &wr)) {
                pt.x = (LONG)(wr.left + t.rel_x * (wr.right - wr.left - 1));
                pt.y = (LONG)(wr.top + t.rel_y * (wr.bottom - wr.top - 1));
                have_pt = 1;
            } else if (t.has_xy) {
                pt.x = t.x;
                pt.y = t.y;
                if (strcmp(t.coords, "logical") == 0 && hwnd) {
                    UINT dpi = GetDpiForWindow(hwnd);
                    if (dpi == 0) dpi = 96;
                    pt.x = (LONG)(pt.x * dpi / 96);
                    pt.y = (LONG)(pt.y * dpi / 96);
                }
                have_pt = 1;
            } else if (t.has_rel) {
                /* 无窗口句柄：用主屏尺寸估算（scope 为桌面根时） */
                int sw = GetSystemMetrics(SM_CXVIRTUALSCREEN);
                int sh = GetSystemMetrics(SM_CYVIRTUALSCREEN);
                pt.x = GetSystemMetrics(SM_XVIRTUALSCREEN) + (LONG)(t.rel_x * (sw - 1));
                pt.y = GetSystemMetrics(SM_YVIRTUALSCREEN) + (LONG)(t.rel_y * (sh - 1));
                have_pt = 1;
            }
            if (have_pt) {
                if (!bring_window_forward(hwnd) || GetTickCount() - start >= deadline || !send_mouse_click(pt)) break;
                click_sent = 1;
                snprintf(data_json, data_size,
                    "{\"method\":\"coordinate\",\"x\":%ld,\"y\":%ld,\"confirmed\":false,"
                    "\"note\":\"coordinate click has no element to confirm against\",\"retries\":%d}",
                    (long)pt.x, (long)pt.y, attempt);
                scope->lpVtbl->Release(scope);
                if (retry_count) *retry_count = attempt;
                return 1;
            }
        }

        /* 本次未成功：决定是否重试 */
        int delay = ush_click_retry_delay_ms(req->dangerous, attempt);
        if (delay < 0) break;
        Sleep((DWORD)delay);
        attempt++;
        if (retry_count) *retry_count = attempt;
    }
    scope->lpVtbl->Release(scope);
    strncpy(err_code, click_sent ? USH_ERR_NOT_CONFIRMED : USH_ERR_NOT_FOUND, err_code_size - 1);
    snprintf(err_text, err_text_size,
        "element not found or click not confirmed after %d attempt(s)", attempt + 1);
    return 0;
}

/* ---------- ui.input ---------- */

/* SendInput 打 Unicode 文本（逐字符 KEYEVENTF_UNICODE；换行转回车）。 */
static int send_key_pair(WORD key, WORD scan, DWORD flags) {
    INPUT in[2];
    memset(in, 0, sizeof(in));
    in[0].type = in[1].type = INPUT_KEYBOARD;
    in[0].ki.wVk = in[1].ki.wVk = key;
    in[0].ki.wScan = in[1].ki.wScan = scan;
    in[0].ki.dwFlags = flags;
    in[1].ki.dwFlags = flags | KEYEVENTF_KEYUP;
    return SendInput(2, in, sizeof(INPUT)) == 2;
}
static int send_unicode_text(const char *utf8) {
    WCHAR *w = utf8_to_wide(utf8);
    if (!w) return 0;
    int ok = 1;
    for (WCHAR *p = w; *p; p++) {
        if (*p == L'\r' || *p == L'\n') {
            if (*p == L'\r' && p[1] == L'\n') p++;
            if (!send_key_pair(VK_RETURN, 0, 0)) { ok = 0; break; }
        } else if (!send_key_pair(0, *p, KEYEVENTF_UNICODE)) { ok = 0; break; }
    }
    free(w);
    return ok;
}

/* r9：坐标换算（与 ui.click 策略 4 同口径）：窗口内相对坐标按 scope
 * 窗口矩形换算；绝对坐标默认物理像素，coords=logical 时按 scope 窗口
 * DPI 换算；无窗口句柄的相对坐标用主屏尺寸估算。返回 1 可算出点。 */
static int target_point(const ush_target_t *t, IUIAutomationElement *scope, POINT *pt) {
    if (!t || !pt) return 0;
    HWND hwnd = element_window(scope);
    if (t->has_rel && hwnd) {
        RECT wr;
        if (GetWindowRect(hwnd, &wr)) {
            pt->x = (LONG)(wr.left + t->rel_x * (wr.right - wr.left - 1));
            pt->y = (LONG)(wr.top + t->rel_y * (wr.bottom - wr.top - 1));
            return 1;
        }
    }
    if (t->has_xy) {
        pt->x = t->x;
        pt->y = t->y;
        if (strcmp(t->coords, "logical") == 0 && hwnd) {
            UINT dpi = GetDpiForWindow(hwnd);
            if (dpi == 0) dpi = 96;
            pt->x = (LONG)(pt->x * dpi / 96);
            pt->y = (LONG)(pt->y * dpi / 96);
        }
        return 1;
    }
    if (t->has_rel) {
        int sw = GetSystemMetrics(SM_CXVIRTUALSCREEN);
        int sh = GetSystemMetrics(SM_CYVIRTUALSCREEN);
        pt->x = GetSystemMetrics(SM_XVIRTUALSCREEN) + (LONG)(t->rel_x * (sw - 1));
        pt->y = GetSystemMetrics(SM_YVIRTUALSCREEN) + (LONG)(t->rel_y * (sh - 1));
        return 1;
    }
    return 0;
}

/* r9b-DS：读元素的 Value（UIA_ValueValuePropertyId）作打字前基线，返回状态：
 * 0=读不到（属性不可用/非 BSTR），1=读到且不等于 expect（含空串），
 * 2=读到且等于 expect。空串是有效基线（搜索框打字前即为空），必须与
 * “读不到”区分，否则焦点确认在搜索框场景下永远无法成立。 */
static int value_baseline_state(IUIAutomationElement *el, const char *expect) {
    if (!el) return 0;
    VARIANT v;
    VariantInit(&v);
    int state = 0;
    if (el->lpVtbl->GetCurrentPropertyValue(el, UIA_ValueValuePropertyId, &v) == S_OK
        && v.vt == VT_BSTR) {
        char cur[4096];
        cur[0] = '\0';
        if (v.bstrVal) wide_to_utf8(v.bstrVal, cur, sizeof(cur));
        size_t tl = strlen(expect), cl = strlen(cur);
        state = (cl == tl && strncmp(cur, expect, tl) == 0) ? 2 : 1;
    }
    VariantClear(&v);
    return state;
}

/* r9b：坐标打字——真实鼠标点击该坐标获焦再 SendInput 打字，随后重取该点
 * 元素（读不到时再读焦点元素）读 Value 确认。触发条件：坐标 input 且
 * 该点无元素，或元素不支持 ValuePattern（如任务栏搜索框容器——SetFocus
 * 对其静默失效，必须真点）。返回 1 已处理（调用方直接返回），
 * data_json 已填；返回 0 未处理。 */
static int input_by_click_and_type(const ush_target_t *t, IUIAutomationElement *scope,
                                   const char *text, int submit,
                                   char *data_json, size_t data_size) {
    POINT pt;
    if (!target_point(t, scope, &pt)) return 0;
    if (!bring_window_forward(element_window(scope)) || !send_mouse_click(pt)) return 0;
    Sleep(150);
    IUIAutomationElement *before = NULL;
    int has_focus = 0;
    if (FAILED(g_auto->lpVtbl->GetFocusedElement(g_auto, &before)) || !before) return 0;
    if (!get_bool_prop(before, UIA_HasKeyboardFocusPropertyId, &has_focus) || !has_focus) {
        before->lpVtbl->Release(before);
        return 0;
    }
    int baseline = value_baseline_state(before, text);
    if (!send_unicode_text(text)) { before->lpVtbl->Release(before); return 0; }
    IUIAutomationElement *after = NULL;
    WINBOOL same = FALSE;
    int confirmed = 0;
    if (SUCCEEDED(g_auto->lpVtbl->GetFocusedElement(g_auto, &after)) && after) {
        if (SUCCEEDED(g_auto->lpVtbl->CompareElements(g_auto, before, after, &same)) && same)
            confirmed = baseline == 1 && value_baseline_state(after, text) == 2;
        after->lpVtbl->Release(after);
    }
    before->lpVtbl->Release(before);
    if (confirmed && submit && !send_key_pair(VK_RETURN, 0, 0)) return 0;
    snprintf(data_json, data_size,
        "{\"method\":\"coordinate-click-type\",\"confirmed\":%s%s}",
        confirmed ? "true" : "false",
        confirmed ? "" : ",\"note\":\"input target/value not confirmed; submit was withheld\"");
    return 1;
}

/* r9b：对已定位的元素试 ValuePattern.SetValue；成功返回 1（调用方即确认），
 * 否则返回 0（调用方改走点击/聚焦打字）。只读元素不写。 */
static int try_value_pattern_set(IUIAutomationElement *el, const char *text) {
    IUnknown *unk = NULL;
    if (el->lpVtbl->GetCurrentPattern(el, UIA_ValuePatternId, &unk) != S_OK || !unk) return 0;
    IUIAutomationValuePattern *vp = NULL;
    HRESULT hr = unk->lpVtbl->QueryInterface(unk, &IID_IUIAutomationValuePattern, (void **)&vp);
    unk->lpVtbl->Release(unk);
    if (hr != S_OK || !vp) return 0;
    int ro = 0;
    vp->lpVtbl->get_CurrentIsReadOnly(vp, &ro);
    int ok = 0;
    if (!ro) {
        WCHAR *w = utf8_to_wide(text);
        if (w) {
            hr = vp->lpVtbl->SetValue(vp, w);
            free(w);
            if (SUCCEEDED(hr)) ok = 1;
        }
    }
    vp->lpVtbl->Release(vp);
    return ok;
}

int ush_ui_input(const ush_request_t *req, char *data_json, size_t data_size,
                 char *err_code, size_t err_code_size,
                 char *err_text, size_t err_text_size,
                 int *retry_count, char *window_title, size_t window_title_size) {
    if (retry_count) *retry_count = 0;
    if (window_title && window_title_size) window_title[0] = '\0';
    if (!ush_uia_init()) {
        strncpy(err_code, USH_ERR_FAILED, err_code_size - 1);
        snprintf(err_text, err_text_size, "UIA init failed");
        return 0;
    }
    char text[4096] = {0};
    char mode[32] = {0};
    int submit = 0;
    if (!ush_json_get_string(req->params_json, "text", text, sizeof(text))) {
        strncpy(err_code, USH_ERR_BAD_REQUEST, err_code_size - 1);
        snprintf(err_text, err_text_size, "params.text must be a string of at most 4095 UTF-8 bytes");
        return 0;
    }
    ush_json_get_string(req->params_json, "mode", mode, sizeof(mode));
    ush_json_get_bool(req->params_json, "submit", &submit);
    if (!text[0]) {
        strncpy(err_code, USH_ERR_BAD_REQUEST, err_code_size - 1);
        snprintf(err_text, err_text_size, "params.text is required and must be non-empty");
        return 0;
    }
    ush_target_t t;
    ush_parse_target(req->params_json, &t);
    DWORD deadline = (DWORD)req->timeout_ms;
    DWORD started = GetTickCount();
    IUIAutomationElement *root = NULL;
    if (g_auto->lpVtbl->GetRootElement(g_auto, &root) != S_OK || !root) {
        strncpy(err_code, USH_ERR_FAILED, err_code_size - 1);
        snprintf(err_text, err_text_size, "cannot get UIA root element");
        return 0;
    }
    IUIAutomationElement *scope = find_scope_window(root, &t, deadline);
    root->lpVtbl->Release(root);
    if (!scope) {
        strncpy(err_code, USH_ERR_NOT_FOUND, err_code_size - 1);
        snprintf(err_text, err_text_size, "target window not found");
        return 0;
    }
    if (window_title && window_title_size) {
        get_str_prop(scope, UIA_NamePropertyId, window_title, window_title_size);
    }
    /* r9/r9b：定位分三路——① 有元素定位字段时按元素找；② 只有坐标时
     * （r8 的 {"text":"r8probe","x":200,"y":736} 即此路）先用
     * ElementFromPoint 取该点元素：能 ValuePattern 就后台写入，否则
     * 点坐标获焦再打字（任务栏搜索框容器不支持 ValuePattern 且 SetFocus
     * 静默失效，必须真点）；取不到元素同样点坐标获焦再打字；③ 两者
     * 皆无直接报 NOT_FOUND，不再空转满 deadline。 */
    IUIAutomationElement *el = NULL;
    int coord_vp_done = 0; /* 坐标分支 ValuePattern 已后台写入成功：走公共尾部做 submit＋确认 */
    int have_locator = (t.automation_id[0] || t.name[0] || t.class_name[0]);
    if (have_locator) {
        DWORD elapsed = GetTickCount() - started;
        if (elapsed >= deadline || !find_element(scope, &t, deadline - elapsed, &el)) {
            scope->lpVtbl->Release(scope);
            strncpy(err_code, USH_ERR_NOT_FOUND, err_code_size - 1);
            snprintf(err_text, err_text_size, "input element not found");
            return 0;
        }
    } else if (t.has_rel || t.has_xy) {
        POINT pt;
        if (!target_point(&t, scope, &pt)) {
            scope->lpVtbl->Release(scope);
            strncpy(err_code, USH_ERR_NOT_FOUND, err_code_size - 1);
            snprintf(err_text, err_text_size, "input coordinate cannot be resolved");
            return 0;
        }
        /* r9b：该点有元素时先试 ValuePattern（真编辑框走此路，后台且无焦点依赖）；
         * 任务栏搜索框这类容器元素不支持 ValuePattern——旧逻辑随后走 SetFocus 兜底，
         * 但容器不可聚焦、SetFocus 静默失效，按键发给桌面、文字丢了（真机实证：
         * r9probe 未填入）。ValuePattern 不可用时改走真实鼠标点击获焦再打字，
         * 与用户自己点搜索框的行为一致。mode=="type" 时跳过 ValuePattern。
         * 注意：ValuePattern 成功后不直接 return——须走公共尾部做 submit＋确认，
         * 否则 submit:true 的回车会被跳过（DS 复核指出）。 */
        if (g_auto->lpVtbl->ElementFromPoint(g_auto, pt, &el) == S_OK && el) {
            if (strcmp(mode, "type") != 0 && try_value_pattern_set(el, text)) {
                coord_vp_done = 1;
            } else {
                el->lpVtbl->Release(el);
                el = NULL;
            }
        }
        if (!coord_vp_done) {
            /* 取不到元素，或元素不支持 ValuePattern：点坐标获焦再打字。 */
            if (input_by_click_and_type(&t, scope, text, submit, data_json, data_size)) {
                scope->lpVtbl->Release(scope);
                return 1;
            }
            scope->lpVtbl->Release(scope);
            strncpy(err_code, USH_ERR_NOT_FOUND, err_code_size - 1);
            snprintf(err_text, err_text_size, "input element not found at point");
            return 0;
        }
    } else {
        scope->lpVtbl->Release(scope);
        strncpy(err_code, USH_ERR_NOT_FOUND, err_code_size - 1);
        snprintf(err_text, err_text_size, "input element not found");
        return 0;
    }
    scope->lpVtbl->Release(scope);

    /* 优先 ValuePattern.SetValue（后台，无需前置/聚焦） */
    int done = 0;
    const char *method = NULL;
    if (coord_vp_done) {
        done = 1; /* 坐标分支已后台写入；不再重写一遍，直接走 submit＋确认 */
        method = "value-pattern";
    } else if (strcmp(mode, "type") != 0 && try_value_pattern_set(el, text)) {
        done = 1;
        method = "value-pattern";
    }
    if (!done) {
        /* 兜底：聚焦 + SendInput 打字（须窗口前置，元素需可聚焦） */
        HWND hwnd = element_window(el);
        int focused = 0;
        if (!bring_window_forward(hwnd) || FAILED(el->lpVtbl->SetFocus(el)) ||
            !get_bool_prop(el, UIA_HasKeyboardFocusPropertyId, &focused) || !focused ||
            GetTickCount() - started >= deadline || !send_unicode_text(text)) {
            el->lpVtbl->Release(el);
            strncpy(err_code, USH_ERR_NOT_CONFIRMED, err_code_size - 1);
            snprintf(err_text, err_text_size, "target focus or keyboard input could not be confirmed");
            return 0;
        }
        done = 1;
        method = "sendinput";
    }
    /* 确认：能读回 Value 时比对（#12：必须整串相等才算确认。旧逻辑把
     * “现有值是输入文本前缀”也判 confirmed=true——要求输 "hello world"
     * 而字段只剩 "hello" 时也会误报已输入）。 */
    int confirmed = 0;
    {
        char cur[4096];
        get_str_prop(el, UIA_ValueValuePropertyId, cur, sizeof(cur));
        if (cur[0]) {
            size_t tl = strlen(text), cl = strlen(cur);
            confirmed = (cl == tl && strncmp(cur, text, tl) == 0);
        }
    }
    if (confirmed && submit) {
        HWND hwnd = element_window(el);
        int focused = 0;
        if (!bring_window_forward(hwnd) || FAILED(el->lpVtbl->SetFocus(el)) ||
            !get_bool_prop(el, UIA_HasKeyboardFocusPropertyId, &focused) || !focused ||
            !send_key_pair(VK_RETURN, 0, 0)) {
            el->lpVtbl->Release(el);
            strncpy(err_code, USH_ERR_NOT_CONFIRMED, err_code_size - 1);
            snprintf(err_text, err_text_size, "text confirmed but submit target could not be confirmed");
            return 0;
        }
    }
    el->lpVtbl->Release(el);
    if (!confirmed) {
        /* SendInput 路径读不回 Value（如密码框/富文本）：不谎称失败也不谎称确认，
         * 如实返回 confirmed=false，由调用方（LEA/Muse）决定是否截图复核。 */
        snprintf(data_json, data_size,
            "{\"method\":\"%s\",\"confirmed\":false,"
            "\"note\":\"value not readable after typing; verify via ui.snapshot\"}", method);
        return 1;
    }
    snprintf(data_json, data_size, "{\"method\":\"%s\",\"confirmed\":true}", method);
    return 1;
}

/* ---------- ui.tree ---------- */

typedef struct {
    char *buf;
    size_t len, cap;
    int nodes;
    int max_nodes;
    int max_depth;
    int truncated;
    ULONGLONG deadline_tick;
    int failed;
} tree_ctx_t;

static int tree_append(tree_ctx_t *c, const char *s) {
    size_t sl = strlen(s);
    if (c->len + sl + 1 > c->cap) {
        size_t nc = (c->cap ? c->cap * 2 : 8192);
        while (nc < c->len + sl + 1) nc *= 2;
        char *nb = (char *)realloc(c->buf, nc);
        if (!nb) { c->failed = 1; return 0; }
        c->buf = nb;
        c->cap = nc;
    }
    memcpy(c->buf + c->len, s, sl);
    c->len += sl;
    c->buf[c->len] = '\0';
    return 1;
}

static void tree_walk(IUIAutomationElement *el, int depth, tree_ctx_t *c) {
    if (c->nodes >= c->max_nodes || depth > c->max_depth || GetTickCount64() >= c->deadline_tick) {
        c->truncated = 1;
        tree_append(c, "null");
        return;
    }
    char name[256], aid[256], cls[128], esc[1024];
    int ctid = 0, enabled = 0;
    get_str_prop(el, UIA_NamePropertyId, name, sizeof(name));
    get_str_prop(el, UIA_AutomationIdPropertyId, aid, sizeof(aid));
    get_str_prop(el, UIA_ClassNamePropertyId, cls, sizeof(cls));
    get_int_prop(el, UIA_ControlTypePropertyId, &ctid);
    get_bool_prop(el, UIA_IsEnabledPropertyId, &enabled);
    /* rect */
    char rect_s[128] = "null";
    VARIANT v;
    VariantInit(&v);
    if (el->lpVtbl->GetCurrentPropertyValue(el, UIA_BoundingRectanglePropertyId, &v) == S_OK
        && (v.vt & VT_ARRAY)) {
        SAFEARRAY *sa = (v.vt & VT_BYREF) ? *(SAFEARRAY **)v.byref : v.parray;
        double rect[4] = {0};
        LONG lb = 0, ub = 0;
        if (sa && SafeArrayGetLBound(sa, 1, &lb) == S_OK &&
            SafeArrayGetUBound(sa, 1, &ub) == S_OK && ub - lb >= 3) {
            for (int i = 0; i < 4; i++) {
                double d = 0;
                SafeArrayGetElement(sa, &(LONG){lb + i}, &d);
                rect[i] = d;
            }
            snprintf(rect_s, sizeof(rect_s), "[%.0f,%.0f,%.0f,%.0f]",
                rect[0], rect[1], rect[2], rect[3]);
        }
    }
    VariantClear(&v);

    c->nodes++;
    for (int i = 0; i < depth; i++) tree_append(c, "  ");
    if (!ush_json_escape(name, esc, sizeof(esc))) c->truncated = 1;
    char line[2048];
    snprintf(line, sizeof(line),
        "{\"name\":\"%s\",\"control_type\":\"%s\",\"control_type_id\":%d,",
        esc, control_type_name(ctid), ctid);
    tree_append(c, line);
    if (!ush_json_escape(aid, esc, sizeof(esc))) c->truncated = 1;
    snprintf(line, sizeof(line), "\"automation_id\":\"%s\",", esc);
    tree_append(c, line);
    if (!ush_json_escape(cls, esc, sizeof(esc))) c->truncated = 1;
    snprintf(line, sizeof(line), "\"class_name\":\"%s\",\"rect\":%s,\"enabled\":%s,\"children\":[",
        esc, rect_s, enabled ? "true" : "false");
    tree_append(c, line);

    if (depth < c->max_depth && c->nodes < c->max_nodes) {
        IUIAutomationCondition *tc = NULL;
        if (g_auto->lpVtbl->CreateTrueCondition(g_auto, &tc) == S_OK && tc) {
            IUIAutomationElementArray *arr = NULL;
            if (el->lpVtbl->FindAll(el, TreeScope_Children, tc, &arr) == S_OK && arr) {
                int len = 0;
                arr->lpVtbl->get_Length(arr, &len);
                int emitted = 0;
                for (int i = 0; i < len; i++) {
                    if (c->nodes >= c->max_nodes || GetTickCount64() >= c->deadline_tick) { c->truncated = 1; break; }
                    IUIAutomationElement *child = NULL;
                    if (arr->lpVtbl->GetElement(arr, i, &child) != S_OK || !child) continue;
                    if (emitted++) tree_append(c, ",");
                    tree_append(c, "\n");
                    tree_walk(child, depth + 1, c);
                    child->lpVtbl->Release(child);
                }
                arr->lpVtbl->Release(arr);
            }
            tc->lpVtbl->Release(tc);
        }
    }
    tree_append(c, "\n");
    for (int i = 0; i < depth; i++) tree_append(c, "  ");
    tree_append(c, "]}");
}

int ush_ui_tree(const ush_request_t *req, char *data_json, size_t data_size,
                char *err_code, size_t err_code_size,
                char *err_text, size_t err_text_size,
                char *window_title, size_t window_title_size) {
    if (window_title && window_title_size) window_title[0] = '\0';
    if (!ush_uia_init()) {
        strncpy(err_code, USH_ERR_FAILED, err_code_size - 1);
        snprintf(err_text, err_text_size, "UIA init failed");
        return 0;
    }
    ush_target_t t;
    ush_parse_target(req->params_json, &t);
    long max_depth = 5, max_nodes = 500;
    long v = 0;
    if (ush_json_get_long(req->params_json, "max_depth", &v)) {
        if (v < 1) v = 1;
        if (v > 10) v = 10;
        max_depth = v;
    }
    if (ush_json_get_long(req->params_json, "max_nodes", &v)) {
        if (v < 1) v = 1;
        if (v > 5000) v = 5000;
        max_nodes = v;
    }
    ULONGLONG deadline_tick = GetTickCount64() + (DWORD)req->timeout_ms;
    DWORD deadline = (DWORD)req->timeout_ms;
    IUIAutomationElement *root = NULL;
    if (g_auto->lpVtbl->GetRootElement(g_auto, &root) != S_OK || !root) {
        strncpy(err_code, USH_ERR_FAILED, err_code_size - 1);
        snprintf(err_text, err_text_size, "cannot get UIA root element");
        return 0;
    }
    IUIAutomationElement *scope = find_scope_window(root, &t, deadline);
    root->lpVtbl->Release(root);
    if (!scope) {
        strncpy(err_code, USH_ERR_NOT_FOUND, err_code_size - 1);
        snprintf(err_text, err_text_size, "target window not found");
        return 0;
    }
    if (window_title && window_title_size) {
        get_str_prop(scope, UIA_NamePropertyId, window_title, window_title_size);
    }
    tree_ctx_t ctx;
    memset(&ctx, 0, sizeof(ctx));
    ctx.deadline_tick = deadline_tick;
    ctx.max_nodes = (int)max_nodes;
    ctx.max_depth = (int)max_depth;
    /* r11 tree 主修：删占位 head。旧代码先把 {"truncated":false,"nodes":0,
     * "tree": 写进 ctx.buf，随后又在前面 memcpy 一个回填后的 head，
     * 导致 data 里出现两个 head、外层信封少一个 '}'，响应为畸形 JSON
     * （LEA 帧校验拒收，报 ush-read-timeout-or-empty）。删除后 ctx.buf
     * 只含 tree_walk 输出，data = 回填 head ＋根节点＋1 个 '}'，括号平衡。 */
    tree_walk(scope, 0, &ctx);
    scope->lpVtbl->Release(scope);
    if (ctx.failed || !ctx.buf) {
        free(ctx.buf);
        strncpy(err_code, USH_ERR_FAILED, err_code_size - 1);
        snprintf(err_text, err_text_size, "tree allocation failed");
        return 0;
    }
    /* 回填 truncated/nodes */
    char head[256];
    snprintf(head, sizeof(head), "{\"truncated\":%s,\"nodes\":%d,\"tree\":\n",
        ctx.truncated ? "true" : "false", ctx.nodes);
    size_t hlen = strlen(head);
    size_t total = hlen + ctx.len + 2;
    if (total > data_size) {
        free(ctx.buf);
        strncpy(err_code, USH_ERR_TOO_LARGE, err_code_size - 1);
        snprintf(err_text, err_text_size,
            "tree too large (%zu bytes); reduce max_depth/max_nodes or scope to a window", total);
        return 0;
    }
    memcpy(data_json, head, hlen);
    memcpy(data_json + hlen, ctx.buf, ctx.len);
    data_json[hlen + ctx.len] = '}';
    data_json[hlen + ctx.len + 1] = '\0';
    free(ctx.buf);
    return 1;
}
