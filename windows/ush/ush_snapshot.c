/* 见 ush_snapshot.h。 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <ole2.h>
#include <wincodec.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "ush_snapshot.h"

#define USH_INLINE_MAX_BYTES (6 * 1024 * 1024) /* 内联 PNG 上限 6MB */

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

/* 编到 IStream；成功返回 1。 */
static int encode_png_to_stream(const capture_t *cap, IStream *stream) {
    IWICImagingFactory *factory = NULL;
    HRESULT hr = CoCreateInstance(&CLSID_WICImagingFactory, NULL, CLSCTX_INPROC_SERVER,
                                  &IID_IWICImagingFactory, (void **)&factory);
    if (FAILED(hr) || !factory) return 0;
    int ok = 0;
    IWICBitmapEncoder *enc = NULL;
    IWICBitmapFrameEncode *frame = NULL;
    if (FAILED(factory->lpVtbl->CreateEncoder(factory, &CLSID_WICPngEncoder, NULL, &enc)) || !enc)
        goto done;
    if (FAILED(enc->lpVtbl->Initialize(enc, stream, WICBitmapEncoderNoCache)) ) goto done;
    if (FAILED(enc->lpVtbl->CreateNewFrame(enc, &frame, NULL)) || !frame) goto done;
    if (FAILED(frame->lpVtbl->Initialize(frame, NULL))) goto done;
    if (FAILED(frame->lpVtbl->SetSize(frame, (UINT)cap->width, (UINT)cap->height))) goto done;
    {
        WICPixelFormatGUID fmt = GUID_WICPixelFormat32bppBGRA;
        if (FAILED(frame->lpVtbl->SetPixelFormat(frame, &fmt))) goto done;
        if (memcmp(&fmt, &GUID_WICPixelFormat32bppBGRA, sizeof(GUID)) != 0) goto done;
    }
    if (FAILED(frame->lpVtbl->WritePixels(frame, (UINT)cap->height,
                                          (UINT)cap->stride,
                                          (UINT)(cap->stride * cap->height),
                                          (BYTE *)cap->bits))) goto done;
    if (FAILED(frame->lpVtbl->Commit(frame))) goto done;
    if (FAILED(enc->lpVtbl->Commit(enc))) goto done;
    ok = 1;
done:
    if (frame) frame->lpVtbl->Release(frame);
    if (enc) enc->lpVtbl->Release(enc);
    if (factory) factory->lpVtbl->Release(factory);
    return ok;
}

static void snapshot_dir(char *out, size_t out_size) {
    WCHAR dir[MAX_PATH];
    DWORD n = GetEnvironmentVariableW(L"ProgramData", dir, MAX_PATH);
    if (n == 0 || n >= MAX_PATH) wcscpy_s(dir, MAX_PATH, L"C:\\ProgramData");
    WCHAR p[MAX_PATH];
    wcscpy_s(p, MAX_PATH, dir);
    wcscat_s(p, MAX_PATH, L"\\QFR");
    CreateDirectoryW(p, NULL);
    wcscat_s(p, MAX_PATH, L"\\LEA");
    CreateDirectoryW(p, NULL);
    wcscat_s(p, MAX_PATH, L"\\snapshots");
    CreateDirectoryW(p, NULL);
    WideCharToMultiByte(CP_UTF8, 0, p, -1, out, (int)out_size, NULL, NULL);
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
        snapshot_dir(dir, sizeof(dir));
        SYSTEMTIME st;
        GetLocalTime(&st);
        char path[MAX_PATH + 64];
        snprintf(path, sizeof(path), "%s\\ush-%04d%02d%02d-%02d%02d%02d-%03d-%lu.png",
            dir, st.wYear, st.wMonth, st.wDay, st.wHour, st.wMinute, st.wSecond,
            st.wMilliseconds, (unsigned long)GetCurrentProcessId());
        /* WIC 直接写文件：用 IWICStream::InitializeFromFilename */
        IWICImagingFactory *factory = NULL;
        HRESULT hr = CoCreateInstance(&CLSID_WICImagingFactory, NULL, CLSCTX_INPROC_SERVER,
                                      &IID_IWICImagingFactory, (void **)&factory);
        if (SUCCEEDED(hr) && factory) {
            IWICStream *wstream = NULL;
            if (SUCCEEDED(factory->lpVtbl->CreateStream(factory, &wstream)) && wstream) {
                WCHAR wpath[MAX_PATH + 64];
                MultiByteToWideChar(CP_UTF8, 0, path, -1, wpath, MAX_PATH + 64);
                if (SUCCEEDED(wstream->lpVtbl->InitializeFromFilename(wstream, wpath, GENERIC_WRITE))) {
                    IStream *istream = NULL;
                    if (SUCCEEDED(wstream->lpVtbl->QueryInterface(wstream, &IID_IStream, (void **)&istream)) && istream) {
                        ok = encode_png_to_stream(&cap, istream);
                        istream->lpVtbl->Release(istream);
                    }
                }
                wstream->lpVtbl->Release(wstream);
            }
            factory->lpVtbl->Release(factory);
        }
        if (ok) {
            /* 文件大小 */
            HANDLE h = CreateFileA(path, GENERIC_READ, FILE_SHARE_READ, NULL,
                                   OPEN_EXISTING, 0, NULL);
            DWORD fsize = 0;
            if (h != INVALID_HANDLE_VALUE) {
                fsize = GetFileSize(h, NULL);
                CloseHandle(h);
            }
            char pesc[4096];
            ush_json_escape(path, pesc, sizeof(pesc));
            snprintf(data_json, data_size,
                "{\"mode\":\"file\",\"path\":\"%s\",\"width\":%d,\"height\":%d,\"bytes\":%lu}",
                pesc, cap.width, cap.height, (unsigned long)fsize);
        } else {
            strncpy(err_code, USH_ERR_FAILED, err_code_size - 1);
            snprintf(err_text, err_text_size, "PNG encode failed");
        }
    } else {
        /* 内联：编到内存流 → 读 HGLOBAL → Base64 */
        HGLOBAL hg = NULL;
        IStream *mem = NULL;
        HRESULT hr = CreateStreamOnHGlobal(NULL, TRUE, &mem);
        if (SUCCEEDED(hr) && mem) {
            if (encode_png_to_stream(&cap, mem)) {
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
                snprintf(err_text, err_text_size, "PNG encode failed");
            }
            mem->lpVtbl->Release(mem);
        } else {
            strncpy(err_code, USH_ERR_FAILED, err_code_size - 1);
            snprintf(err_text, err_text_size, "CreateStreamOnHGlobal failed");
        }
        (void)hg;
    }
    capture_free(&cap);
    return ok;
}
