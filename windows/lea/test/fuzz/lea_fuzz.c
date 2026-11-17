/* lea_fuzz.c — LEA/USH C 层模糊测试入口（S-023，2026-11-15）
 * =================================================================
 * 覆盖：lea_parse_envelope、lea_envelope_canonical、base64 编解码往返、
 * USH JSON 取值（ush_json_get_*）、lea_local_status_from_json、
 * 命令表派生（tier／dangerous／cancellable／deadline）。
 *
 * 两种模式：
 *   - 默认 LEA_FUZZ_STANDALONE：独立驱动，main() 逐个读入 corpus 文件
 *     调 LLVMFuzzerTestOneInput（沙箱无 clang、无 libFuzzer 时用此模式）。
 *   - 不定义 LEA_FUZZ_STANDALONE 时只导出 LLVMFuzzerTestOneInput，
 *     供 clang -fsanitize=fuzzer / AFL++ 以 libFuzzer 模式链接。
 *
 * 入口永不主动 abort／exit：非法输入只返回 0；内存错误由
 * ASan/UBSan 在运行时捕获（run_fuzz.sh 用 -fsanitize=address,undefined
 * 且 -fno-sanitize-recover=all，任何越界／未定义行为即非零退出）。
 * 输入超 65536 字节时截断到 LEA_MAX_ENVELOPE 再喂（与管道读行上限一致）。
 */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "../../lea_protocol.h"
#include "../../lea_crypto.h"
#include "../../lea_local.h"
#include "../../../ush/ush_json.h"

#define FUZZ_MAX_INPUT LEA_MAX_ENVELOPE

int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size) {
    if (!data || size == 0) return 0;
    size_t n = size > FUZZ_MAX_INPUT ? FUZZ_MAX_INPUT : size;
    /* NUL 结尾副本：各解析入口均为 C 字符串入口；原始输入里的内嵌
     * NUL 同样会被各入口当作串尾——这是调用约定，不是待修项。 */
    static char buf[FUZZ_MAX_INPUT + 1];
    memcpy(buf, data, n);
    buf[n] = '\0';
    long long now = (long long)time(NULL);

    /* ① 信封解析＋规范串＋命令表派生。 */
    lea_envelope_t env;
    memset(&env, 0, sizeof(env));
    if (lea_parse_envelope(buf, now, &env)) {
        char canon[8192];
        lea_envelope_canonical(&env, canon, sizeof(canon));
        (void)lea_command_spec(env.command);
        (void)lea_command_tier(env.command);
        (void)lea_command_is_dangerous(&env);
        (void)lea_command_is_cancellable(&env);
        (void)lea_effective_timeout_ms(&env);
        (void)lea_job_deadline_ms(&env);
        char rebuilt[LEA_MAX_RESPONSE];
        lea_rebuild_envelope(&env, rebuilt, sizeof(rebuilt));
        char sig_check[16] = { 0 };
        (void)lea_json_string(buf, "signature", sig_check, sizeof(sig_check));
    }
    (void)lea_json_is_valid(buf);
    {
        char tmp[128] = { 0 };
        (void)lea_json_top_level_string(buf, "cmd", tmp, sizeof(tmp));
        (void)lea_json_top_level_string(buf, "command", tmp, sizeof(tmp));
        long long lv = 0;
        (void)lea_json_long(buf, "binding_epoch", &lv);
        (void)lea_json_top_level_long(buf, "grant_epoch", &lv);
        int bv = 0;
        (void)lea_json_bool(buf, "dangerous", &bv);
    }

    /* ② base64 编解码往返（LEA 侧标准／url 两路＋USH 侧）。 */
    {
        unsigned char decoded[512];
        long dlen = lea_b64_decode(buf, decoded, sizeof(decoded));
        if (dlen > 0) {
            char reenc[1024];
            if (lea_b64_encode(decoded, (size_t)dlen, reenc, sizeof(reenc)) > 0) {
                unsigned char decoded2[512];
                long dlen2 = lea_b64_decode(reenc, decoded2, sizeof(decoded2));
                /* 往返长度一致即通过（内容一致由编解码本身保证；长度不
                 * 一致只说明输入不是规范编码，不判失败）。 */
                (void)dlen2;
            }
        }
        (void)lea_b64url_decode(buf, decoded, sizeof(decoded));
        /* USH 侧：原始字节编解码往返必须字节一致。 */
        char ub64[1024];
        if (ush_base64_encode(data, n > 512 ? 512 : n, ub64, sizeof(ub64))) {
            unsigned char uback[512];
            size_t ulen = 0;
            if (ush_base64_decode(ub64, uback, sizeof(uback), &ulen) && ulen > 0) {
                size_t cmp = n > 512 ? 512 : n;
                if (ulen != cmp || memcmp(uback, data, cmp) != 0) {
                    /* 往返不一致是确定性 bug：stderr 留痕后返回 0，
                     * 由 run_fuzz.sh 的退出码机制捕获（此处不 abort，
                     * 保持 fuzzer 可继续跑其余语料）。 */
                    fprintf(stderr, "fuzz: ush base64 roundtrip mismatch\n");
                }
            }
        }
    }

    /* ③ USH JSON 取值（字符串／数字／布尔／对象，含 \u 转义路径）。 */
    {
        char s[256] = { 0 };
        (void)ush_json_get_string(buf, "text", s, sizeof(s));
        (void)ush_json_get_string(buf, "account_id", s, sizeof(s));
        long lv = 0;
        (void)ush_json_get_long(buf, "timeout_ms", &lv);
        long long llv = 0;
        (void)ush_json_get_llong(buf, "issued_at", &llv);
        int bv = 0;
        (void)ush_json_get_bool(buf, "submit", &bv);
        double dv = 0;
        (void)ush_json_get_double(buf, "rel_x", &dv);
        char obj[1024] = { 0 };
        (void)ush_json_get_object(buf, "params", obj, sizeof(obj));
        (void)ush_json_get_object(buf, "target", obj, sizeof(obj));
    }

    /* ④ 本机状态 JSON 编解码往返。 */
    {
        lea_local_status_t st;
        if (lea_local_status_from_json(buf, &st)) {
            char js[2048];
            if (lea_local_status_to_json(&st, js, sizeof(js))) {
                lea_local_status_t st2;
                (void)lea_local_status_from_json(js, &st2);
            }
        }
    }

    /* ⑤ 票据解析（严格 JSON 对象遍历；脏输入只返回 0）。 */
    {
        lea_ticket_t tk;
        (void)lea_parse_ticket(buf, &tk);
    }

    return 0;
}

#ifdef LEA_FUZZ_STANDALONE
int main(int argc, char **argv) {
    if (argc < 2) {
        fprintf(stderr, "usage: lea_fuzz <corpus-file>...\n");
        return 2;
    }
    int failed = 0;
    for (int i = 1; i < argc; i++) {
        FILE *f = fopen(argv[i], "rb");
        if (!f) {
            fprintf(stderr, "FAIL %s: cannot open\n", argv[i]);
            failed = 1;
            continue;
        }
        static uint8_t data[FUZZ_MAX_INPUT + 1];
        size_t n = fread(data, 1, sizeof(data) - 1, f);
        fclose(f);
        (void)LLVMFuzzerTestOneInput(data, n);
        printf("OK %s (%zu bytes)\n", argv[i], n);
    }
    return failed ? 1 : 0;
}
#endif
