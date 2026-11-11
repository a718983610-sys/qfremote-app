/* test_ush_r9.c — r9 三项修复的 C 端回归单测（mingw 编译，wine64 下跑）。
 *
 * 覆盖：
 *  ① ui.snapshot PNG 编码：encode_png_to_stream 在“从未 CoInitialize
 *     的线程”上调用（复现 USH 管道线程条件：ush.c pipe_loop 从不初始
 *     化 COM）。修前 CoCreateInstance 报 CO_E_NOTINITIALIZED、恒返 0；
 *     修后函数内按需 CoInitializeEx（MTA）＋平衡 CoUninitialize，编出
 *     合法 PNG（签名字节＋非空）。用 #include 直接测 static 函数，伪造
 *     4x3 32bpp 抓屏，不依赖真屏幕／BitBlt。r9-diag：encode 失败时经
 *     out 参数带回失败步骤＋HRESULT＋CoInitializeEx 结果；wine 无编码
 *     器时应精确报 CoCreateInstance/PNGEncoder＋失败 hr（即原 SKIP 分支）。
 *     r9-fix2：编码器改直接 CoCreateInstance（绕过工厂 CreateEncoder 的
 *     元数据校验；真机 WIC 元数据注册不完整，Implemented Categories 缺失）。
 *  ② ui.input 坐标定位：find_element 在无任何元素定位字段时立即返 0
 *     （修前空转满 deadline 才返 0，坐标 input 恒 5000ms 超时）；另验
 *     ush_parse_target 能从顶层 params 读出 r8 原样 {"x":200,"y":736}，
 *     且 target_point 对该坐标算出物理点 (200,736)。
 * 用法：x86_64-w64-mingw32-gcc -O2 -Wall -Wextra -std=c11
 *   -D_WIN32_WINNT=0x0A00 -DWINVER=0x0A00 -I.. -o /tmp/test_ush_r9.exe
 *   test_ush_r9.c ../ush_json.c
 *   -lole32 -loleaut32 -luuid -lwtsapi32 -lgdi32 -luser32 -lbcrypt -lwindowscodecs
 *   wine64 /tmp/test_ush_r9.exe
 * 注意：本文件 #include 两个实现文件以测 static 函数，不得再单独链接
 * ../ush_snapshot.c / ../ush_uia.c（会重定义）。
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <ole2.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "ush_json.h"
#include "ush_uia.h"
#include "ush_snapshot.h"

/* 先拉实现文件：encode_png_to_stream / capture_t（ush_snapshot.c），
 * find_element / target_point / ush_parse_target（ush_uia.c）。 */
#include "../ush_snapshot.c"
#include "../ush_uia.c"

static int g_pass = 0, g_fail = 0;
static void t(int cond, const char *name) {
    if (cond) { g_pass++; printf("PASS %s\n", name); }
    else { g_fail++; printf("FAIL %s\n", name); }
}

/* 编一次 4x3 伪造抓屏到内存流，验 PNG 签名。返回 1 编出合法 PNG。
 * diag 出参（可 NULL）接 encode 的失败步骤＋HRESULT＋初始化结果。 */
static int encode_once(HRESULT *hr_out, const char **step_out, HRESULT *hr_init_out) {
    capture_t cap;
    memset(&cap, 0, sizeof(cap));
    cap.width = 4;
    cap.height = 3;
    cap.stride = 16;
    cap.bits = malloc((size_t)cap.stride * (size_t)cap.height);
    if (!cap.bits) return 0;
    /* 红绿蓝白相间的 4x3（BGRA 32bpp）。 */
    unsigned char *px = (unsigned char *)cap.bits;
    for (int i = 0; i < 12; i++) {
        px[i * 4 + 0] = (unsigned char)(i * 37);       /* B */
        px[i * 4 + 1] = (unsigned char)(255 - i * 17); /* G */
        px[i * 4 + 2] = (unsigned char)(i * 53);       /* R */
        px[i * 4 + 3] = 255;                           /* A */
    }
    IStream *mem = NULL;
    HRESULT hr = CreateStreamOnHGlobal(NULL, TRUE, &mem);
    if (FAILED(hr) || !mem) { free(cap.bits); return 0; }
    HRESULT dhr = S_OK;
    const char *dstep = "ok";
    HRESULT dinit = S_OK;
    int ok = encode_png_to_stream(&cap, mem, &dhr, &dstep, &dinit);
    if (hr_out) *hr_out = dhr;
    if (step_out) *step_out = dstep;
    if (hr_init_out) *hr_init_out = dinit;
    int sig_ok = 0;
    SIZE_T sz = 0;
    if (ok) {
        HGLOBAL hret = NULL;
        if (SUCCEEDED(GetHGlobalFromStream(mem, &hret)) && hret) {
            sz = GlobalSize(hret);
            unsigned char *bytes = (unsigned char *)GlobalLock(hret);
            static const unsigned char png_sig[8] = { 0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A };
            if (bytes && sz >= 8 && memcmp(bytes, png_sig, 8) == 0) sig_ok = 1;
            if (bytes) GlobalUnlock(hret);
        }
    }
    mem->lpVtbl->Release(mem);
    free(cap.bits);
    printf("  [encode] ok=%d sig_ok=%d bytes=%llu step=%s hr=0x%08lx init=0x%08lx\n",
           ok, sig_ok, (unsigned long long)sz, dstep,
           (unsigned long)dhr, (unsigned long)dinit);
    return ok && sig_ok;
}

int main(void) {
    /* ① 先复现根因：本线程刻意不调 CoInitializeEx（USH 管道线程条件）。
     * 无初始化时 WIC 工厂建不出（0x800401F0 CO_E_NOTINITIALIZED）——
     * 这就是 r8 snapshot 47ms 即败 "PNG encode failed" 的根因。 */
    {
        IWICImagingFactory *f = NULL;
        HRESULT hr = CoCreateInstance(&CLSID_WICImagingFactory, NULL, CLSCTX_INPROC_SERVER,
                                      &IID_IWICImagingFactory, (void **)&f);
        printf("  [probe] no-init CoCreateInstance hr=0x%08lx\n", (unsigned long)hr);
        t(hr == (HRESULT)0x800401F0, "r9 snapshot 复现：无 COM 初始化时 WIC 工厂建不出 0x800401F0");
        if (f) f->lpVtbl->Release(f);
    }
    /* ② 本 wine 前缀若无 PNG 编码器（直接 CoCreateInstance 报失败），
     * 编 PNG 全程断言记 SKIP（wine 缺件，非修复无效；真机验收见
     * WINDOWS-TESTS.md／r9 真机验证）。有编码器时才跑全程。r9-fix2：
     * encode 已改直接 CoCreateInstance 建编码器（绕过工厂 CreateEncoder
     * 的元数据校验），故探针与诊断断言同步改直接创建。 */
    int skip_encode = 0;
    HRESULT skip_hr = S_OK;
    {
        HRESULT hr_init = CoInitializeEx(NULL, COINIT_MULTITHREADED);
        IWICImagingFactory *f = NULL;
        HRESULT hr = CoCreateInstance(&CLSID_WICImagingFactory, NULL, CLSCTX_INPROC_SERVER,
                                      &IID_IWICImagingFactory, (void **)&f);
        printf("  [probe] with-init factory hr=0x%08lx\n", (unsigned long)hr);
        t(SUCCEEDED(hr) && f, "r9 snapshot 初始化 COM 后 WIC 工厂能建出");
        if (f) f->lpVtbl->Release(f);
        IWICBitmapEncoder *enc = NULL;
        HRESULT hre = CoCreateInstance(&CLSID_WICPngEncoder, NULL, CLSCTX_INPROC_SERVER,
                                       &IID_IWICBitmapEncoder, (void **)&enc);
        printf("  [probe] direct CoCreateInstance PNG encoder hr=0x%08lx\n", (unsigned long)hre);
        skip_hr = hre;
        if (FAILED(hre) || !enc) {
            skip_encode = 1;
            printf("SKIP r9 snapshot 编 PNG 全程（本 wine 前缀无 PNG 编码器 hr=0x%08lx，真机验）\n",
                   (unsigned long)hre);
        }
        if (enc) enc->lpVtbl->Release(enc);
        if (SUCCEEDED(hr_init)) CoUninitialize();
    }
    /* ③ encode_png_to_stream 全程（仅当编码器存在）：函数内按需初始化
     * COM，两次调用都成即进出平衡。第二次带回诊断字段，成功时应为
     * ok／S_OK／S_OK。 */
    if (!skip_encode) {
        t(encode_once(NULL, NULL, NULL), "r9 snapshot 无 COM 初始化线程上 WIC 编 PNG 成功（首次）");
        {
            HRESULT dhr = S_OK;
            const char *dstep = "";
            HRESULT dinit = S_OK;
            t(encode_once(&dhr, &dstep, &dinit), "r9 snapshot 无 COM 初始化线程上 WIC 编 PNG 成功（再次，进出平衡）");
            t(dhr == S_OK && dstep && strcmp(dstep, "ok") == 0 && dinit == S_OK,
              "r9-diag 编码成功时诊断字段为 ok/S_OK/S_OK");
        }
    } else {
        /* 无编码器分支：诊断必须精确指到直接创建步骤，且 hr 与探针直接
         * 创建一致；CoInitializeEx 本身成功（S_OK），证明失败不在 COM 初始化。 */
        HRESULT dhr = S_OK;
        const char *dstep = "";
        HRESULT dinit = S_OK;
        t(!encode_once(&dhr, &dstep, &dinit), "r9-diag 无 PNG 编码器时 encode 返 0");
        t(dstep && strcmp(dstep, "CoCreateInstance/PNGEncoder") == 0 && FAILED(dhr),
          "r9-diag 无 PNG 编码器时报 CoCreateInstance/PNGEncoder");
        t(dhr == skip_hr, "r9-diag 无 PNG 编码器时 hr 与探针直接创建一致");
        t(dinit == S_OK, "r9-diag 无 PNG 编码器时 CoInitializeEx 本身成功 S_OK");
    }

    /* find_element 无定位字段：立即返 0，不空转满 deadline。 */
    {
        ush_target_t tgt;
        memset(&tgt, 0, sizeof(tgt));
        tgt.index = -1;
        IUIAutomationElement *el = NULL;
        DWORD t0 = GetTickCount();
        int r = find_element(NULL, &tgt, 5000, &el);
        DWORD dt = GetTickCount() - t0;
        printf("  [find_element] r=%d elapsed_ms=%lu\n", r, (unsigned long)dt);
        t(r == 0 && el == NULL, "r9 input 无定位字段时 find_element 返 0");
        t(dt < 1000, "r9 input 无定位字段时 find_element 不空转 deadline（<1000ms）");
    }
    /* r8 原样 params：顶层 x/y 被解析为坐标定位。 */
    {
        ush_target_t tgt;
        ush_parse_target("{\"text\":\"r8probe\",\"x\":200,\"y\":736}", &tgt);
        t(tgt.has_xy && tgt.x == 200 && tgt.y == 736, "r9 input 解析顶层 x/y（r8 原样 params）");
        POINT pt;
        t(target_point(&tgt, NULL, &pt) && pt.x == 200 && pt.y == 736,
          "r9 input 坐标换算得物理点 (200,736)");
    }
    /* 相对坐标无窗口时用主屏估算（wine 下主屏存在）。 */
    {
        ush_target_t tgt;
        memset(&tgt, 0, sizeof(tgt));
        tgt.index = -1;
        tgt.has_rel = 1;
        tgt.rel_x = 0.5;
        tgt.rel_y = 0.5;
        POINT pt;
        int ok = target_point(&tgt, NULL, &pt);
        printf("  [target_point rel] ok=%d pt=(%ld,%ld)\n", ok, (long)pt.x, (long)pt.y);
        t(ok && pt.x > 0 && pt.y > 0, "r9 input 相对坐标无窗口时主屏估算出点");
    }

    printf("----\n%d passed, %d failed\n", g_pass, g_fail);
    return g_fail ? 1 : 0;
}
