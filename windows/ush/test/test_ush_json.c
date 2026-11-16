/* test_ush_json.c — USH 纯逻辑层单测（宿主 gcc 可跑，无 Windows 依赖）。
 * 用法：gcc -I.. -o test_ush_json test_ush_json.c ../ush_json.c && ./test_ush_json
 * 退出码 0=全部通过；任一失败打印 FAIL 并返回 1。
 */
#include <stdio.h>
#include <string.h>
#include "ush_json.h"

static int g_pass = 0, g_fail = 0;

#define CHECK(cond, name) do { \
    if (cond) { g_pass++; printf("PASS %s\n", name); } \
    else { g_fail++; printf("FAIL %s\n", name); } \
} while (0)

static void test_parse_click(void) {
    ush_request_t r;
    const char *req =
        "{\"version\":1,\"request_id\":\"req-1\",\"trace_id\":\"tr-1\",\"batch_id\":\"b-1\","
        "\"seq\":2,\"device_id\":\"node//x\",\"account_id\":\"718983610\","
        "\"command\":\"ui.click\",\"params\":{\"target\":{\"automation_id\":\"okBtn\"}},"
        "\"timeout_ms\":5000,\"idempotency_key\":\"idem-1\",\"dangerous\":false}";
    CHECK(ush_parse_request(req, &r) == 1 && r.valid, "parse: click valid");
    CHECK(r.cmd == USH_CMD_CLICK, "parse: click cmd enum");
    CHECK(strcmp(r.request_id, "req-1") == 0, "parse: request_id");
    CHECK(strcmp(r.trace_id, "tr-1") == 0, "parse: trace_id");
    CHECK(r.seq == 2, "parse: seq");
    CHECK(r.timeout_ms == 5000, "parse: timeout_ms");
    CHECK(r.dangerous == 0, "parse: dangerous false");
    CHECK(strstr(r.params_json, "okBtn") != NULL, "parse: params kept raw");
    char tgt[512];
    CHECK(ush_json_get_object(r.params_json, "target", tgt, sizeof(tgt)) == 1, "parse: target object");
    char aid[128];
    CHECK(ush_json_get_string(tgt, "automation_id", aid, sizeof(aid)) == 1
        && strcmp(aid, "okBtn") == 0, "parse: automation_id value");
}

static void test_parse_variants(void) {
    ush_request_t r;
    CHECK(ush_parse_request("{\"command\":\"ui.ping\"}", &r) == 1 && r.cmd == USH_CMD_PING,
        "parse: ping minimal");
    CHECK(r.timeout_ms == 5000, "parse: default timeout 5000");
    CHECK(ush_parse_request("{\"command\":\"ui.input\",\"params\":{\"text\":\"hi\"},\"timeout_ms\":999999}",
        &r) == 1 && r.timeout_ms == USH_MAX_TIMEOUT_MS, "parse: timeout clamped to max");
    CHECK(ush_parse_request("{\"command\":\"ui.tree\",\"params\":{},\"timeout_ms\":0}",
        &r) == 1 && r.timeout_ms == 1, "parse: timeout clamped to min");
    CHECK(ush_parse_request("{\"command\":\"ui.nope\"}", &r) == 0
        && strcmp(r.error, "unknown-command") == 0, "parse: unknown command");
    CHECK(ush_parse_request("{\"command\":\"ui.nope\",\"request_id\":\"req-x\"}", &r) == 0
        && strcmp(r.request_id, "req-x") == 0,
        "parse: unknown command still echoes request_id");
    CHECK(ush_parse_request("not json", &r) == 0
        && strcmp(r.error, "bad-request") == 0, "parse: not json");
    CHECK(ush_parse_request("", &r) == 0, "parse: empty");
    CHECK(ush_parse_request("{\"command\":\"ui.click\",\"params\":[]}", &r) == 0
        && strcmp(r.error, "bad-request") == 0, "parse: params not object");
    CHECK(ush_parse_request("{\"cmd\":\"ui.snapshot\"}", &r) == 1 && r.cmd == USH_CMD_SNAPSHOT,
        "parse: legacy cmd field accepted");
    /* 超大请求拒绝 */
    static char big[USH_MAX_REQUEST + 64];
    memset(big, 'x', sizeof(big) - 1);
    big[sizeof(big) - 1] = '\0';
    CHECK(ush_parse_request(big, &r) == 0, "parse: oversized rejected");
}

static void test_json_strings(void) {
    char out[256];
    CHECK(ush_json_get_string("{\"a\":\"hello\"}", "a", out, sizeof(out)) == 1
        && strcmp(out, "hello") == 0, "json: plain string");
    CHECK(ush_json_get_string("{\"a\":\"x\\\\\\\"y\"}", "a", out, sizeof(out)) == 1
        && strcmp(out, "x\\\"y") == 0, "json: escaped quote+backslash");
    CHECK(ush_json_get_string("{\"a\":\"line\\nnext\\ttab\"}", "a", out, sizeof(out)) == 1
        && strcmp(out, "line\nnext\ttab") == 0, "json: \\n \\t escapes");
    /* \u4e2d = 中，\u6587 = 文 */
    CHECK(ush_json_get_string("{\"a\":\"\\u4e2d\\u6587\"}", "a", out, sizeof(out)) == 1
        && strcmp(out, "\xe4\xb8\xad\xe6\x96\x87") == 0, "json: \\uXXXX CJK");
    /* 代理对 \uD83D\uDE00 = 😀 U+1F600 */
    CHECK(ush_json_get_string("{\"a\":\"\\uD83D\\uDE00\"}", "a", out, sizeof(out)) == 1
        && strcmp(out, "\xf0\x9f\x98\x80") == 0, "json: surrogate pair");
    CHECK(ush_json_get_string("{\"a\":\"\\uD83D\"}", "a", out, sizeof(out)) == 0,
        "json: lone high surrogate rejected");
    CHECK(ush_json_get_string("{\"a\":\"\\q\"}", "a", out, sizeof(out)) == 0,
        "json: bad escape rejected");
    CHECK(ush_json_get_string("{\"a\":123}", "a", out, sizeof(out)) == 0,
        "json: non-string rejected");
    CHECK(ush_json_get_string("{\"b\":\"x\"}", "a", out, sizeof(out)) == 0,
        "json: missing key");
    /* 转义输出 */
    char esc[256];
    CHECK(ush_json_escape("a\"b\\c\nd", esc, sizeof(esc)) == 1
        && strcmp(esc, "a\\\"b\\\\c\\nd") == 0, "json: escape output");
    CHECK(ush_json_escape("ctl\x01" "x", esc, sizeof(esc)) == 1
        && strcmp(esc, "ctl\\u0001x") == 0, "json: escape control char");
    /* 嵌套对象提取（含字符串内花括号） */
    char obj[512];
    CHECK(ush_json_get_object("{\"target\":{\"name\":\"a}b\",\"x\":1},\"z\":2}",
        "target", obj, sizeof(obj)) == 1
        && strcmp(obj, "{\"name\":\"a}b\",\"x\":1}") == 0, "json: object with brace in string");
    CHECK(ush_json_get_object("{\"a\":1}", "a", obj, sizeof(obj)) == 0,
        "json: object on non-object");
    /* long/bool */
    long v = 0;
    CHECK(ush_json_get_long("{\"n\":-42}", "n", &v) == 1 && v == -42, "json: negative long");
    int b = -1;
    CHECK(ush_json_get_bool("{\"d\":true}", "d", &b) == 1 && b == 1, "json: bool true");
    CHECK(ush_json_get_bool("{\"d\":false}", "d", &b) == 1 && b == 0, "json: bool false");
    CHECK(ush_json_get_bool("{\"d\":1}", "d", &b) == 0, "json: bool rejects number");
}

/* #11：rel_x/rel_y 的 JSON 数字形式（ush_parse_target 在 ush_uia.c，
 * Windows 专属，沙箱跑不了；此处验底层取值函数，mingw 编译＋真机验端到端）。 */
static void test_json_double(void) {
    double d = 0;
    CHECK(ush_json_get_double("{\"rel_x\":0.5}", "rel_x", &d) == 1 && d == 0.5, "dbl: 0.5");
    CHECK(ush_json_get_double("{\"rel_x\":-1.25,\"rel_y\":2}", "rel_x", &d) == 1 && d == -1.25, "dbl: negative");
    CHECK(ush_json_get_double("{\"rel_x\":1e-1}", "rel_x", &d) == 1 && d > 0.099 && d < 0.101, "dbl: exponent");
    CHECK(ush_json_get_double("{\"rel_x\":.5}", "rel_x", &d) == 0, "dbl: leading dot rejected");
    CHECK(ush_json_get_double("{\"rel_x\":0}", "rel_x", &d) == 1 && d == 0, "dbl: zero");
    CHECK(ush_json_get_double("{\"rel_x\":\"0.5\"}", "rel_x", &d) == 0, "dbl: string rejected");
    CHECK(ush_json_get_double("{\"rel_x\":0.5x}", "rel_x", &d) == 0, "dbl: trailing garbage rejected");
    CHECK(ush_json_get_double("{\"rel_x\":true}", "rel_x", &d) == 0, "dbl: bool rejected");
    CHECK(ush_json_get_double("{\"rel_x\":+0.5}", "rel_x", &d) == 0, "dbl: leading plus rejected");
    CHECK(ush_json_get_double("{\"rel_y\":0.5}", "rel_x", &d) == 0, "dbl: missing key");
    CHECK(ush_json_get_double("{\"rel_x\":0.5 }", "rel_x", &d) == 1 && d == 0.5, "dbl: trailing space ok");
}

static void test_response_and_base64(void) {
    char resp[1024];
    CHECK(ush_build_response(resp, sizeof(resp), 1, "done", "req-9", 12,
        "{\"clicked\":true}", NULL) == 1
        && strcmp(resp, "{\"ok\":true,\"code\":\"done\",\"request_id\":\"req-9\","
            "\"duration_ms\":12,\"data\":{\"clicked\":true}}\n") == 0,
        "resp: ok shape");
    CHECK(ush_build_response(resp, sizeof(resp), 0, "QFR_USH_ELEMENT_NOT_FOUND", "req-9",
        30, NULL, "no such element \"x\"") == 1
        && strstr(resp, "\"ok\":false") && strstr(resp, "no such element \\\"x\\\""),
        "resp: error shape with escaping");
    /* T24 同款（LEA→USH 读循环）：LEA 侧只认 '\n' 为完成，短读不算完成；
     * 故 USH 两路响应必须恒以 '\n' 结尾，否则 LEA 会等到超时才收行。 */
    {
        size_t n = strlen(resp);
        CHECK(n > 0 && resp[n - 1] == '\n', "resp: error ends with newline");
        CHECK(ush_build_response(resp, sizeof(resp), 1, "done", "req-9", 12,
            "{\"clicked\":true}", NULL) == 1, "resp: ok rebuilds");
        n = strlen(resp);
        CHECK(n > 0 && resp[n - 1] == '\n', "resp: ok ends with newline");
    }
    CHECK(ush_build_response(resp, 10, 1, "done", "r", 1, "{}", NULL) == 0,
        "resp: too small buffer rejected");

    char b64[64];
    CHECK(ush_base64_encode((const unsigned char *)"Man", 3, b64, sizeof(b64)) == 1
        && strcmp(b64, "TWFu") == 0, "b64: Man");
    CHECK(ush_base64_encode((const unsigned char *)"Ma", 2, b64, sizeof(b64)) == 1
        && strcmp(b64, "TWE=") == 0, "b64: Ma padding");
    CHECK(ush_base64_encode((const unsigned char *)"", 0, b64, sizeof(b64)) == 1
        && strcmp(b64, "") == 0, "b64: empty");
    unsigned char dec[16];
    size_t dl = 0;
    CHECK(ush_base64_decode("TWFu", dec, sizeof(dec), &dl) == 1 && dl == 3
        && memcmp(dec, "Man", 3) == 0, "b64: decode round-trip");
    CHECK(ush_base64_decode("TWE=", dec, sizeof(dec), &dl) == 1 && dl == 2
        && memcmp(dec, "Ma", 2) == 0, "b64: decode padding");
    CHECK(ush_base64_decode("!!!", dec, sizeof(dec), &dl) == 0, "b64: bad input rejected");
}

static void test_retry_and_strategies(void) {
    CHECK(ush_click_retry_delay_ms(0, 0) == 200, "retry: 1st retry 200ms");
    CHECK(ush_click_retry_delay_ms(0, 1) == 500, "retry: 2nd retry 500ms");
    CHECK(ush_click_retry_delay_ms(0, 2) == -1, "retry: no 3rd retry");
    CHECK(ush_click_retry_delay_ms(1, 0) == -1, "retry: dangerous never retries");
    CHECK(ush_locator_strategy_count() == 5, "locator: 5 strategies");
    CHECK(strcmp(ush_locator_strategy_name(0), "automation_id") == 0, "locator: 1st automation_id");
    CHECK(strcmp(ush_locator_strategy_name(1), "name+control_type") == 0, "locator: 2nd name+type");
    CHECK(strcmp(ush_locator_strategy_name(2), "class_name+index") == 0, "locator: 3rd class+index");
    CHECK(strcmp(ush_locator_strategy_name(3), "relative_coords") == 0, "locator: 4th rel coords");
    CHECK(strcmp(ush_locator_strategy_name(4), "image_template") == 0, "locator: 5th image template");
    CHECK(ush_locator_strategy_name(5) == NULL, "locator: out of range NULL");
}

/* H03：LEA→USH token 解析与比对 */
static void test_ush_token(void) {
    ush_request_t r;
    const char *tok = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    char req[512];
    snprintf(req, sizeof(req),
             "{\"command\":\"ui.click\",\"request_id\":\"req-t1\",\"ush_token\":\"%s\",\"params\":{}}", tok);
    CHECK(ush_parse_request(req, &r) == 1 && r.valid, "token: parse ok");
    CHECK(strcmp(r.ush_token, tok) == 0, "token: parsed value");
    CHECK(ush_parse_request("{\"command\":\"ui.click\",\"params\":{}}", &r) == 1 && r.valid,
          "token: missing parses ok");
    CHECK(r.ush_token[0] == '\0', "token: missing is empty");
    CHECK(ush_token_matches(tok, tok), "token: equal matches");
    CHECK(!ush_token_matches(tok, "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcde0"),
          "token: one-char diff rejects");
    CHECK(!ush_token_matches(tok, "0123456789abcdef"), "token: short rejects");
    CHECK(!ush_token_matches(tok, ""), "token: empty provided rejects");
    CHECK(!ush_token_matches("", tok), "token: empty expected rejects");
    CHECK(!ush_token_matches(NULL, tok), "token: null expected rejects");
    CHECK(!ush_token_matches(tok, NULL), "token: null provided rejects");
}

/* C1：自助绑定命令解析（deliver-ticket／clear／status／renew）。 */
static void test_parse_selfbind(void) {
    ush_request_t r;
    const char *deliver =
        "{\"command\":\"selfbind.deliver-ticket\",\"account_id\":\"alice\","
        "\"device_id\":\"node//test-device-1\","
        "\"params\":{\"ticket\":\"sbt_abc123\",\"challenge\":\"ch-1\","
        "\"nonce\":\"test-nonce-001\",\"device_name\":\"TEST-PC\","
        "\"platform\":\"windows\",\"expires_at\":1794568473}}";
    CHECK(ush_parse_request(deliver, &r) == 1 && r.valid, "C1 parse: deliver-ticket valid");
    CHECK(r.cmd == USH_CMD_SELFBIND, "C1 parse: deliver-ticket cmd enum");
    CHECK(strcmp(r.account_id, "alice") == 0, "C1 parse: deliver account_id");
    CHECK(strcmp(r.device_id, "node//test-device-1") == 0, "C1 parse: deliver device_id kept raw");
    CHECK(strstr(r.params_json, "sbt_abc123") != NULL, "C1 parse: deliver params kept raw");
    char tk[128];
    CHECK(ush_json_get_string(r.params_json, "ticket", tk, sizeof(tk)) == 1
        && strcmp(tk, "sbt_abc123") == 0, "C1 parse: deliver ticket value");
    long exp = 0;
    CHECK(ush_json_get_long(r.params_json, "expires_at", &exp) == 1
        && exp == 1794568473, "C1 parse: deliver expires_at value");
    CHECK(ush_parse_request("{\"command\":\"selfbind.clear-credential\"}", &r) == 1
        && r.cmd == USH_CMD_SELFBIND_CLEAR, "C1 parse: clear-credential");
    CHECK(ush_parse_request("{\"command\":\"selfbind.status\"}", &r) == 1
        && r.cmd == USH_CMD_SELFBIND_STATUS, "C1 parse: status");
    CHECK(ush_parse_request("{\"command\":\"selfbind.renew\",\"device_id\":\"node//x\"}", &r) == 1
        && r.cmd == USH_CMD_SELFBIND_RENEW, "C1 parse: renew");
    CHECK(ush_parse_request("{\"command\":\"selfbind.nope\"}", &r) == 0
        && strcmp(r.error, "unknown-command") == 0, "C1 parse: unknown selfbind rejected");
    /* C1：毫秒时间戳须走 llong（Windows long 只有 32 位，strtol 会截断）。 */
    long long ms = 0;
    CHECK(ush_json_get_llong("{\"expires_at\":1794568473000}", "expires_at", &ms) == 1
        && ms == 1794568473000LL, "C1 llong: ms timestamp parses fully");
    long long sec = 0;
    CHECK(ush_json_get_llong("{\"expires_at\":1794568473}", "expires_at", &sec) == 1
        && sec == 1794568473LL, "C1 llong: seconds timestamp parses");
    CHECK(ush_json_get_llong("{\"expires_at\":\"x\"}", "expires_at", &ms) == 0,
        "C1 llong: non-number rejects");
}


static void test_completeness_regressions(void) {
    char out[16];
    long n = 17;
    long long wide = 0;
    double d = 0;
    unsigned char decoded[16];
    size_t count = 99;
    CHECK(!ush_json_get_long("{\"n\":12garbage}", "n", &n) && n == 17, "M098: integer suffix rejected without mutation");
    CHECK(!ush_json_get_long("{\"n\":1.5}", "n", &n), "M098: fractional integer rejected");
    CHECK(!ush_json_get_llong("{\"n\":9223372036854775808}", "n", &wide), "M098: integer overflow rejected");
    CHECK(!ush_json_get_double("{\"n\":01}", "n", &d), "M099: leading zero rejected");
    CHECK(!ush_json_get_double("{\"n\":1.}", "n", &d), "M099: fraction requires digits");
    CHECK(!ush_json_get_double("{\"n\":1e+}", "n", &d), "M099: exponent requires digits");
    memset(out, 'x', sizeof(out));
    CHECK(!ush_json_get_string("{\"x\":\"abcdefghijklmnopq\"}", "x", out, sizeof(out)) && out[0] == 0, "M097: failed string is empty and terminated");
    memset(out, 'x', sizeof(out));
    CHECK(!ush_json_escape("\"\"\"\"\"\"\"\"\"\"", out, sizeof(out)) && out[0] == 0, "M112: failed escaping never exposes stack bytes");
    CHECK(!ush_base64_decode("=AAA", decoded, sizeof(decoded), &count) && count == 0, "M100: leading padding rejected");
    CHECK(!ush_base64_decode("AA=A", decoded, sizeof(decoded), &count), "M100: padding cannot precede data");
    CHECK(!ush_base64_decode("AA==AAAA", decoded, sizeof(decoded), &count), "M100: padding only in final quartet");
    CHECK(!ush_base64_decode("AB==", decoded, sizeof(decoded), &count), "M100: noncanonical tail bits rejected");
    CHECK(ush_base64_decode("AA==", decoded, sizeof(decoded), &count) && count == 1 && decoded[0] == 0, "M100: canonical one-byte encoding accepted");
    ush_request_t r;
    CHECK(ush_parse_request("{\"params\":{\"command\":\"ui.input\"}, \"command\" : \"ui.ping\", \"seq\":4294967296}", &r) && r.cmd == USH_CMD_PING && r.seq == 4294967296LL, "M098: wide seq preserved and nested command cannot shadow request");
    CHECK(!ush_parse_request("{\"command\":\"ui.ping\",\"command\":\"ui.click\"}", &r), "protocol: duplicate command rejected");
    CHECK(!ush_parse_request("{\"command\":\"ui.ping\",\"comm\\u0061nd\":\"ui.click\"}", &r), "protocol: escaped duplicate command rejected");
    CHECK(!ush_parse_request("{\"command\":\"ui.ping\"}garbage", &r), "protocol: document trailing data rejected");
    CHECK(ush_json_get_string("{\"x\" : \"ok\"}", "x", out, sizeof(out)) && !strcmp(out,"ok"), "protocol: whitespace before colon accepted");
    const char *sample = "{\"x\":\"\\uD800\\uDC00\",\"n\":[1,{\"a\":true}]}";
    char prefix[128];
    for (size_t i = 0; i < strlen(sample); i++) {
        memcpy(prefix, sample, i); prefix[i] = 0;
        CHECK(!ush_json_get_string(prefix, "x", out, sizeof(out)), "protocol: truncated document rejected");
    }
}

int main(void) {
    test_completeness_regressions();
    test_parse_click();
    test_parse_variants();
    test_json_strings();
    test_json_double();
    test_response_and_base64();
    test_retry_and_strategies();
    test_ush_token();
    test_parse_selfbind();
    printf("----\n%d passed, %d failed\n", g_pass, g_fail);
    return g_fail ? 1 : 0;
}
