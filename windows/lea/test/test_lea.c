/* QFRLEA 核心逻辑单测（Linux 沙箱可跑；Windows 服务本体不在此列）。
 *
 * 编译＋运行（见 run_tests.sh）：
 *   gcc -O1 -Wall -Wextra -DLEA_TEST_UNSIGNED=1 -o test_lea test_lea.c \
 *       ../lea_protocol.c ../lea_crypto.c ../lea_state.c ../lea_audit.c
 *   ./test_lea
 * 严格模式（验 fail-closed）：
 *   gcc -O1 -Wall -Wextra -o test_lea_strict test_lea.c \
 *       ../lea_protocol.c ../lea_crypto.c ../lea_state.c ../lea_audit.c
 *   ./test_lea_strict
 *
 * 覆盖：协议解析、签名验签占位、幂等去重、准入拒绝各码、脚本白名单
 * 判定（路径部分＋文件 hash）、app.open 白名单 hash 钉死（H16）、队列超限、
 * 审计脱敏、SHA-256 向量。
 * Windows 服务本体（QFRLEA.c、qf-lea-client.c）无法在 Linux 沙箱运行，
 * 只做 mingw 交叉编译检查，须 Windows 真机／Wine 验证（见 README）。
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>
#include "../lea_protocol.h"
#include "../lea_crypto.h"
#include "../lea_state.h"
#include "../lea_audit.h"
#include "../lea_commandline.h"
#include "../lea_install.h" /* A1：首装服务子命令纯函数（版本比较／清单解析） */
#include "../whitelist.h" /* H16：app.open 白名单 hash（W_USH_EXE_SHA256）须与发版 USH 一致 */

static int g_pass = 0, g_fail = 0;
#define CHECK(cond, name) do { \
    if (cond) { g_pass++; printf("PASS %s\n", name); } \
    else { g_fail++; printf("FAIL %s\n", name); } \
} while (0)
#define CHECK_STR_EQ(a, b, name) CHECK(strcmp((a), (b)) == 0, name)

/* 构造一个有效信封（除可覆盖字段外均合法）。v2：version 2＋grant_epoch。 */
static void make_envelope_ge(char *out, size_t out_size, long long now,
                          const char *command, const char *params,
                          long long binding_epoch, long long grant_epoch, const char *device_id,
                          const char *account_id, const char *idem_key,
                          const char *nonce, const char *request_id,
                          const char *signature) {
    snprintf(out, out_size,
             "{\"version\":2,\"request_id\":\"%s\",\"batch_id\":\"batch-0001\","
             "\"seq\":1,\"device_id\":\"%s\",\"account_id\":\"%s\","
             "\"api_key_id\":\"key-abc12345\",\"binding_epoch\":%lld,"
             "\"grant_epoch\":%lld,"
             "\"nonce\":\"%s\",\"issued_at\":%lld,\"expires_at\":%lld,"
             "\"idempotency_key\":\"%s\",\"command\":\"%s\",\"params\":%s,"
             "\"timeout_ms\":5000,\"signature\":\"%s\"}",
             request_id, device_id, account_id, binding_epoch, grant_epoch,
             nonce, now, now + 60, idem_key, command,
             params ? params : "{}", signature);
}
static void make_envelope(char *out, size_t out_size, long long now,
                          const char *command, const char *params,
                          long long binding_epoch, const char *device_id,
                          const char *account_id, const char *idem_key,
                          const char *nonce, const char *request_id,
                          const char *signature) {
    make_envelope_ge(out, out_size, now, command, params, binding_epoch, 1,
                     device_id, account_id, idem_key, nonce, request_id, signature);
}

/* 构造一张有效票据（除可覆盖字段外均合法）。grant_raw／scopes_raw／
 * lease_raw 为 NULL 时用默认值；scopes_raw 为 NULL 表示缺失该字段。 */
static void make_ticket(char *out, size_t out_size,
                        const char *grant_raw, const char *scopes_raw,
                        const char *lease_raw, int omit_expires) {
    char scopes_part[600] = { 0 }, lease_part[256] = { 0 }, exp_part[64] = { 0 };
    if (scopes_raw) snprintf(scopes_part, sizeof(scopes_part), "\"scopes\":%s,", scopes_raw);
    if (lease_raw) snprintf(lease_part, sizeof(lease_part), "\"lease_id\":%s,", lease_raw);
    if (!omit_expires) snprintf(exp_part, sizeof(exp_part), "\"expires_at\":1780086400,");
    snprintf(out, out_size,
             "{\"account_id\":\"alice\",\"device_id\":\"node-1\",\"binding_epoch\":3,"
             "\"grant_epoch\":1,\"grant_muse_execute\":%s,%s%s%s"
             "\"ticket_signature\":\"TEST-UNSIGNED\"}",
             grant_raw ? grant_raw : "1", scopes_part, lease_part, exp_part);
}

static void active_binding(lea_binding_t *b, long long epoch, int grant,
                           const char *scopes) {
    lea_binding_init(b);
    b->state = LEA_BIND_ACTIVE;
    snprintf(b->account_id, sizeof(b->account_id), "alice");
    snprintf(b->device_id, sizeof(b->device_id), "node-1");
    b->epoch = epoch;
    b->grant_epoch = 1;
    b->grant_muse_execute = grant;
    snprintf(b->scopes, sizeof(b->scopes), "%s", scopes ? scopes : "");
    b->expires_at = 0;
}

/* CAS 测试钩子：第一次调用时把文件全量替换为 [A,D]（模拟 H21 直写
 * 落在 merge 基线读之后、写前重读之前），之后不再触发。
 * 仅在定义 LEA_TEST_HOOKS 时编译（见 lea_state.h）。 */
#ifdef LEA_TEST_HOOKS
static int g_cas_hook_fired = 0;
static void cas_hook(const char *path) {
    if (g_cas_hook_fired) return;
    g_cas_hook_fired = 1;
    const char *hd[] = { "k_aaa1111111", "k_ddd4444444" };
    lea_revoked_write(path, hd, 2);
}

/* 世代合并最终重读测试钩子：第 2 次调用时把文件全量替换为 [A]（模拟
 * 陈旧 H21 直写落在写盘与世代推进之间），其余调用无操作。调用序：
 * 第 1 次＝内层写前重读前，第 2 次＝世代推进后、最终重读前。 */
static int g_gen_hook_calls = 0;
static void gen_hook(const char *path) {
    g_gen_hook_calls++;
    if (g_gen_hook_calls != 2) return;
    const char *hd[] = { "k_aaa1111111" };
    lea_revoked_write(path, hd, 1);
}

/* R2 交错钩子：第 2 次调用（世代推进后）按模式模拟他方写盘：
 * 模式 1＝只把世代文件推到 9（更新推送的世代写已到、表写未到）；
 * 模式 2＝只把世代文件回退到 2（陈旧推送回退了世代）；
 * 模式 3＝世代推到 9 且把表覆盖为 [A]（更新推送世代已到＋陈旧推送
 * 覆盖了表——R2-2.1 反例：旧写法第 2 轮入口即判 stale 而不重合并）。 */
static int g_gen_interleave_mode = 0;
static void gen_interleave_hook(const char *path) {
    g_gen_hook_calls++;
    if (g_gen_hook_calls != 2) return;
    char gf[512];
    if (!lea_revoked_gen_path(path, gf, sizeof(gf))) return;
    if (g_gen_interleave_mode == 1) {
        lea_revoked_generation_write(gf, 9);
    } else if (g_gen_interleave_mode == 2) {
        lea_revoked_generation_write(gf, 2);
    } else if (g_gen_interleave_mode == 3) {
        lea_revoked_generation_write(gf, 9);
        const char *hd[] = { "k_aaa1111111" };
        lea_revoked_write(path, hd, 1);
    }
}
#endif

/* F-01 测试小助手：写原始文件内容（不走 lea_revoked_write，才能造出
 * 损坏快照）。 */
static int f01_write_raw(const char *path, const char *data, size_t len) {
    FILE *f = fopen(path, "wb");
    if (!f) return 0;
    int ok = 1;
    if (len > 0 && fwrite(data, 1, len, f) != len) ok = 0;
    if (fclose(f) != 0) ok = 0;
    return ok;
}
static int f01_write_text(const char *path, const char *text) {
    return f01_write_raw(path, text, strlen(text));
}

int main(void) {
    long long now = (long long)time(NULL);
    char env_buf[8192];
    lea_envelope_t env;

    /* ---------- SHA-256 已知向量 ---------- */
    {
        char hex[65];
        lea_sha256_hex((const unsigned char *)"", 0, hex);
        CHECK_STR_EQ(hex, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", "sha256-empty");
        lea_sha256_hex((const unsigned char *)"abc", 3, hex);
        CHECK_STR_EQ(hex, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", "sha256-abc");
        lea_sha256_hex((const unsigned char *)"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq", 56, hex);
        CHECK_STR_EQ(hex, "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1", "sha256-56byte");
        /* 文件 hash：qf-agent-heal.ps1（与 whitelist.h 一致；用宏钉死，
         * 脚本改动后 hash 变也不用再改测试，与下面的 USH 测试同款）。 */
        char fhex[65] = { 0 };
        const char *heal = "../../qf-agent-heal.ps1";
        if (access(heal, R_OK) == 0) {
            CHECK(lea_sha256_file_hex(heal, fhex), "sha256-file-readable");
            CHECK_STR_EQ(fhex, W_HEAL_PS1_SHA256,
                         "sha256-heal-ps1-matches-whitelist");
        } else {
            printf("SKIP sha256-file tests (qf-agent-heal.ps1 not found at %s)\n", heal);
        }
        /* H16：app.open 白名单——发版 QFUserHelper.exe 的 hash 须与 whitelist.h
         * 的 W_USH_EXE_SHA256 一致（USH 重编后须重跑 gen_whitelist.py）。 */
        {
            char uhex[65] = { 0 };
            const char *ush = "../../ush/QFUserHelper.exe";
            if (access(ush, R_OK) == 0) {
                CHECK(lea_sha256_file_hex(ush, uhex), "sha256-ush-file-readable");
                CHECK_STR_EQ(uhex, W_USH_EXE_SHA256,
                             "sha256-ush-exe-matches-whitelist");
            } else {
                printf("SKIP sha256-ush test (QFUserHelper.exe not found at %s)\n", ush);
            }
        }
    }

    /* ---------- Base64 ---------- */
    {
        char b64[64];
        unsigned char raw[64];
        CHECK(lea_b64_encode((const unsigned char *)"hello", 5, b64, sizeof(b64)) == 8, "b64-encode-len");
        CHECK_STR_EQ(b64, "aGVsbG8=", "b64-encode-hello");
        CHECK(lea_b64_decode("aGVsbG8=", raw, sizeof(raw)) == 5, "b64-decode-len");
        CHECK(memcmp(raw, "hello", 5) == 0, "b64-decode-hello");
        CHECK(lea_b64_decode("!!!", raw, sizeof(raw)) == -1, "b64-decode-invalid");
        CHECK(lea_b64url_decode("aGVsbG8", raw, sizeof(raw)) == 5, "b64url-decode-no-pad");
    }

    /* ---------- 协议解析：有效信封 ---------- */
    make_envelope(env_buf, sizeof(env_buf), now, "sys.info", "{}", 3, "node-1",
                  "alice", "idem-key-0001", "nonce-00001", "req-0000001", "TEST-UNSIGNED");
    CHECK(lea_parse_envelope(env_buf, now, &env), "parse-valid-envelope");
    CHECK(env.valid && env.binding_epoch == 3 && strcmp(env.command, "sys.info") == 0,
          "parse-fields");
    CHECK(lea_effective_timeout_ms(&env) == 5000, "timeout-from-envelope");

    /* 默认超时：无 timeout_ms 时用命令默认值。 */
    {
        char e2[4096];
        snprintf(e2, sizeof(e2),
                 "{\"version\":2,\"request_id\":\"req-0000002\",\"seq\":1,\"device_id\":\"node-1\","
                 "\"account_id\":\"alice\",\"api_key_id\":\"key-abc12345\","
                 "\"binding_epoch\":3,\"grant_epoch\":1,\"nonce\":\"nonce-00002\",\"issued_at\":%lld,"
                 "\"expires_at\":%lld,\"idempotency_key\":\"idem-key-0002\","
                 "\"command\":\"script.run\",\"params\":{},\"signature\":\"TEST-UNSIGNED\"}",
                 now, now + 60);
        CHECK(lea_parse_envelope(e2, now, &env), "parse-no-timeout");
        CHECK(lea_effective_timeout_ms(&env) == 30000, "timeout-default-script-30s");
        CHECK(lea_command_is_dangerous(&env), "script-run-is-dangerous");
        CHECK(!lea_command_is_dangerous(&(lea_envelope_t){ .command = "ui.click", .params_raw = "{}" }),
              "ui-click-plain-not-dangerous");
        lea_envelope_t d = { 0 };
        snprintf(d.command, sizeof(d.command), "ui.click");
        snprintf(d.params_raw, sizeof(d.params_raw), "{\"dangerous\":true}");
        CHECK(lea_command_is_dangerous(&d), "ui-click-dangerous-flag");
    }

    /* ---------- 协议解析：失败 ---------- */
    {
        char bad[8192];
        /* 版本错误：v2-only，version 2→1 即拒绝 */
        snprintf(bad, sizeof(bad), "%s", env_buf);
        char *v = strstr(bad, "\"version\":2");
        if (v) v[10] = '1';
        CHECK(!lea_parse_envelope(bad, now, &env) && strcmp(env.error, "QFR_LEA_BAD_ENVELOPE") == 0,
              "parse-bad-version");
        /* 版本错误：version 2→3 即拒绝 */
        snprintf(bad, sizeof(bad), "%s", env_buf);
        v = strstr(bad, "\"version\":2");
        if (v) v[10] = '3';
        CHECK(!lea_parse_envelope(bad, now, &env) && strcmp(env.error, "QFR_LEA_BAD_ENVELOPE") == 0,
              "parse-bad-version-3");
        /* 未知命令 */
        make_envelope(bad, sizeof(bad), now, "rm.everything", "{}", 3, "node-1",
                      "alice", "idem-key-0003", "nonce-00003", "req-0000003", "TEST-UNSIGNED");
        CHECK(!lea_parse_envelope(bad, now, &env), "parse-unknown-command");
        /* 时间窗超 60s */
        snprintf(bad, sizeof(bad),
                 "{\"version\":2,\"request_id\":\"req-0000004\",\"seq\":1,\"device_id\":\"node-1\","
                 "\"account_id\":\"alice\",\"api_key_id\":\"key-abc12345\","
                 "\"binding_epoch\":3,\"grant_epoch\":1,\"nonce\":\"nonce-00004\",\"issued_at\":%lld,"
                 "\"expires_at\":%lld,\"idempotency_key\":\"idem-key-0004\","
                 "\"command\":\"sys.info\",\"params\":{},\"signature\":\"TEST-UNSIGNED\"}",
                 now, now + 61);
        CHECK(!lea_parse_envelope(bad, now, &env) && strcmp(env.error, "QFR_REPLAY_DETECTED") == 0,
              "parse-expires-window-gt-60s");
        /* 过期信封 */
        snprintf(bad, sizeof(bad),
                 "{\"version\":2,\"request_id\":\"req-0000005\",\"seq\":1,\"device_id\":\"node-1\","
                 "\"account_id\":\"alice\",\"api_key_id\":\"key-abc12345\","
                 "\"binding_epoch\":3,\"grant_epoch\":1,\"nonce\":\"nonce-00005\",\"issued_at\":%lld,"
                 "\"expires_at\":%lld,\"idempotency_key\":\"idem-key-0005\","
                 "\"command\":\"sys.info\",\"params\":{},\"signature\":\"TEST-UNSIGNED\"}",
                 now - 120, now - 60);
        CHECK(!lea_parse_envelope(bad, now, &env), "parse-expired-envelope");
        /* timeout_ms 超上限（script.run 上限 300000） */
        snprintf(bad, sizeof(bad),
                 "{\"version\":2,\"request_id\":\"req-0000006\",\"seq\":1,\"device_id\":\"node-1\","
                 "\"account_id\":\"alice\",\"api_key_id\":\"key-abc12345\","
                 "\"binding_epoch\":3,\"grant_epoch\":1,\"nonce\":\"nonce-00006\",\"issued_at\":%lld,"
                 "\"expires_at\":%lld,\"idempotency_key\":\"idem-key-0006\","
                 "\"command\":\"script.run\",\"params\":{},\"timeout_ms\":999999,"
                 "\"signature\":\"TEST-UNSIGNED\"}", now, now + 60);
        CHECK(!lea_parse_envelope(bad, now, &env), "parse-timeout-over-max");
        /* 缺 idempotency_key */
        snprintf(bad, sizeof(bad),
                 "{\"version\":2,\"request_id\":\"req-0000007\",\"seq\":1,\"device_id\":\"node-1\","
                 "\"account_id\":\"alice\",\"api_key_id\":\"key-abc12345\","
                 "\"binding_epoch\":3,\"grant_epoch\":1,\"nonce\":\"nonce-00007\",\"issued_at\":%lld,"
                 "\"expires_at\":%lld,\"command\":\"sys.info\",\"params\":{},"
                 "\"signature\":\"TEST-UNSIGNED\"}", now, now + 60);
        CHECK(!lea_parse_envelope(bad, now, &env), "parse-missing-idempotency-key");
    }

    /* ---------- F-02：v1 拒绝／grant_epoch 必填／严格表示／未知与重复字段 ---------- */
    {
        char f02[8192];
        /* 完整 v1 信封（version 1、无 grant_epoch）→ 拒绝。 */
        snprintf(f02, sizeof(f02),
                 "{\"version\":1,\"request_id\":\"req-f02-01\",\"batch_id\":\"batch-0001\","
                 "\"seq\":1,\"device_id\":\"node-1\",\"account_id\":\"alice\","
                 "\"api_key_id\":\"key-abc12345\",\"binding_epoch\":3,"
                 "\"nonce\":\"nonce-f0201\",\"issued_at\":%lld,\"expires_at\":%lld,"
                 "\"idempotency_key\":\"idem-f02-01\",\"command\":\"sys.info\",\"params\":{},"
                 "\"signature\":\"TEST-UNSIGNED\"}", now, now + 60);
        CHECK(!lea_parse_envelope(f02, now, &env) && strcmp(env.error, "QFR_LEA_BAD_ENVELOPE") == 0,
              "f02-v1-envelope-rejected");
        /* v2 信封缺 grant_epoch → 拒绝（不得缺省为 0）。 */
        snprintf(f02, sizeof(f02),
                 "{\"version\":2,\"request_id\":\"req-f02-02\",\"batch_id\":\"batch-0001\","
                 "\"seq\":1,\"device_id\":\"node-1\",\"account_id\":\"alice\","
                 "\"api_key_id\":\"key-abc12345\",\"binding_epoch\":3,"
                 "\"nonce\":\"nonce-f0202\",\"issued_at\":%lld,\"expires_at\":%lld,"
                 "\"idempotency_key\":\"idem-f02-02\",\"command\":\"sys.info\",\"params\":{},"
                 "\"signature\":\"TEST-UNSIGNED\"}", now, now + 60);
        CHECK(!lea_parse_envelope(f02, now, &env) && strcmp(env.error_detail, "grant_epoch") == 0,
              "f02-missing-grant-epoch-rejected");
        /* grant_epoch 非法表示一律拒绝：前导零／负数／加号／字符串／小数／超 2^53-1。 */
        const char *bad_ge[] = {
            "\"grant_epoch\":01", "\"grant_epoch\":-1", "\"grant_epoch\":+1",
            "\"grant_epoch\":\"1\"", "\"grant_epoch\":1.0",
            "\"grant_epoch\":9007199254740992", "\"grant_epoch\":9223372036854775807",
            "\"grant_epoch\":18446744073709551615",
        };
        for (int i = 0; i < 8; i++) {
            snprintf(f02, sizeof(f02),
                     "{\"version\":2,\"request_id\":\"req-f02-1%d\",\"seq\":1,\"device_id\":\"node-1\","
                     "\"account_id\":\"alice\",\"api_key_id\":\"key-abc12345\","
                     "\"binding_epoch\":3,%s,"
                     "\"nonce\":\"nonce-f021%d\",\"issued_at\":%lld,\"expires_at\":%lld,"
                     "\"idempotency_key\":\"idem-f02-1%d\",\"command\":\"sys.info\",\"params\":{},"
                     "\"signature\":\"TEST-UNSIGNED\"}",
                     i, bad_ge[i], i, now, now + 60, i);
            char tname[64];
            snprintf(tname, sizeof(tname), "f02-grant-epoch-bad-form-%d", i);
            CHECK(!lea_parse_envelope(f02, now, &env), tname);
        }
        /* grant_epoch 边界合法值：0、1、2^53-1 均解析通过。 */
        const char *ok_ge[] = { "0", "1", "9007199254740991" };
        for (int i = 0; i < 3; i++) {
            snprintf(f02, sizeof(f02),
                     "{\"version\":2,\"request_id\":\"req-f02-2%d\",\"seq\":1,\"device_id\":\"node-1\","
                     "\"account_id\":\"alice\",\"api_key_id\":\"key-abc12345\","
                     "\"binding_epoch\":3,\"grant_epoch\":%s,"
                     "\"nonce\":\"nonce-f022%d\",\"issued_at\":%lld,\"expires_at\":%lld,"
                     "\"idempotency_key\":\"idem-f02-2%d\",\"command\":\"sys.info\",\"params\":{},"
                     "\"signature\":\"TEST-UNSIGNED\"}",
                     i, ok_ge[i], i, now, now + 60, i);
            char tname[64];
            snprintf(tname, sizeof(tname), "f02-grant-epoch-ok-%s", ok_ge[i]);
            CHECK(lea_parse_envelope(f02, now, &env), tname);
        }
        /* 未知顶层字段 → 拒绝；重复 grant_epoch → 拒绝；重复 version → 拒绝。 */
        make_envelope(f02, sizeof(f02), now, "sys.info", "{}", 3, "node-1",
                      "alice", "idem-f02-30", "nonce-f0230", "req-f02-30", "TEST-UNSIGNED");
        {
            char unk[8192];
            size_t n = strlen(f02);
            snprintf(unk, sizeof(unk), "%.*s,\"evil\":1}", (int)n - 1, f02);
            CHECK(!lea_parse_envelope(unk, now, &env), "f02-unknown-field-rejected");
        }
        {
            char dup[8192];
            snprintf(dup, sizeof(dup),
                     "{\"version\":2,\"version\":2,\"request_id\":\"req-f02-31\",\"seq\":1,"
                     "\"device_id\":\"node-1\",\"account_id\":\"alice\","
                     "\"api_key_id\":\"key-abc12345\",\"binding_epoch\":3,\"grant_epoch\":1,"
                     "\"nonce\":\"nonce-f0231\",\"issued_at\":%lld,\"expires_at\":%lld,"
                     "\"idempotency_key\":\"idem-f02-31\",\"command\":\"sys.info\",\"params\":{},"
                     "\"signature\":\"TEST-UNSIGNED\"}", now, now + 60);
            CHECK(!lea_parse_envelope(dup, now, &env), "f02-duplicate-version-rejected");
        }
        {
            char dup[8192];
            snprintf(dup, sizeof(dup),
                     "{\"version\":2,\"request_id\":\"req-f02-32\",\"seq\":1,"
                     "\"device_id\":\"node-1\",\"account_id\":\"alice\","
                     "\"api_key_id\":\"key-abc12345\",\"binding_epoch\":3,"
                     "\"grant_epoch\":1,\"grant_epoch\":1,"
                     "\"nonce\":\"nonce-f0232\",\"issued_at\":%lld,\"expires_at\":%lld,"
                     "\"idempotency_key\":\"idem-f02-32\",\"command\":\"sys.info\",\"params\":{},"
                     "\"signature\":\"TEST-UNSIGNED\"}", now, now + 60);
            CHECK(!lea_parse_envelope(dup, now, &env), "f02-duplicate-grant-epoch-rejected");
        }
        /* 嵌套遮蔽：params 内含 grant_epoch 不得被当作顶层值（顶层缺失即拒）。 */
        {
            char sh[8192];
            snprintf(sh, sizeof(sh),
                     "{\"version\":2,\"request_id\":\"req-f02-33\",\"seq\":1,"
                     "\"device_id\":\"node-1\",\"account_id\":\"alice\","
                     "\"api_key_id\":\"key-abc12345\",\"binding_epoch\":3,"
                     "\"nonce\":\"nonce-f0233\",\"issued_at\":%lld,\"expires_at\":%lld,"
                     "\"idempotency_key\":\"idem-f02-33\",\"command\":\"sys.info\","
                     "\"params\":{\"grant_epoch\":1},\"signature\":\"TEST-UNSIGNED\"}",
                     now, now + 60);
            CHECK(!lea_parse_envelope(sh, now, &env), "f02-nested-grant-epoch-not-accepted");
        }
        /* 合法 v2 信封解析后 grant_epoch 字段值正确。 */
        make_envelope_ge(f02, sizeof(f02), now, "sys.info", "{}", 3, 7, "node-1",
                         "alice", "idem-f02-34", "nonce-f0234", "req-f02-34", "TEST-UNSIGNED");
        CHECK(lea_parse_envelope(f02, now, &env) && env.version == 2 && env.grant_epoch == 7,
              "f02-parse-grant-epoch-value");
    }

    /* ---------- 签名验签（真实 Ed25519；测试向量见
     * ~/workspace/qfremote/local-agent/evidence-ed25519-20261111/
     * gen_test_vectors.py，测试密钥种子 bytes(range(32))，仅测试用） ---------- */
    {
        char reason[128] = { 0 };
        /* 格式错误的签名一律拒绝（与公钥配置无关） */
        CHECK(!lea_verify_envelope_signature("short", "", reason, sizeof(reason)) &&
              strcmp(reason, "bad-signature-format") == 0, "sig-malformed-rejected");
        CHECK(!lea_sig_format_ok("short"), "sig-format-short");
        /* 64 字节签名的 base64url（86 字符）格式合理 */
        char sig86[92];
        memset(sig86, 'A', 86);
        sig86[86] = '\0';
        CHECK(lea_sig_format_ok(sig86), "sig-format-86-ok");
        /* 标准 base64（88 字符，含 '/'）格式同样合理：服务端签发即此编码 */
        CHECK(lea_sig_format_ok("h9REmhvldwQHXzecimBOhiQREyydn6w/U2tyQBUB2stjppZLPn6cbnzyDGnQGZKqnrjRcFBGrAr/Aeoa8bN4Aw=="),
              "sig-format-std-b64-ok");
        /* 混用两种字母表（既含 '/' 又含 '_'）即格式错误 */
        CHECK(!lea_sig_format_ok("h9REmhvldwQHXzecimBOhiQREyydn6w/U2tyQBUB2stjppZLPn6cbnzyDGnQGZKqnrjRcFBGrAr_Aeoa8bN4Aw"),
              "sig-format-mixed-alphabet-rejected");
#ifdef LEA_SERVER_PUBKEY_HEX
        /* ---- 真实验签（测试公钥已编入） ---- */
        CHECK(lea_server_pubkey_hex() != NULL &&
              strcmp(lea_server_pubkey_hex(),
                     "03a107bff3ce10be1d70dd18e74bc09967e4d6309ba50d5f1ddc8664125531b8") == 0,
              "sig-test-pubkey-configured");
        /* RC-01：服务端公钥指纹（JS↔C 交叉核对——node 对同一测试公钥
         * 算出 ff73a0647bbc29aa：32 字节 → 标准 base64 → SHA-256 前 16 位）。 */
        {
            char fp[17] = { 0 };
            CHECK(lea_server_pubkey_fingerprint(fp) == 1, "rc01-fingerprint-ok");
            CHECK_STR_EQ(fp, "ff73a0647bbc29aa", "rc01-fingerprint-matches-js");
        }
        /* 信封规范串（CANONICAL-SIGNING-V2.md §2.1 测试向量），测试私钥所签。
         * F-02：20 行完整规范串（含 job_id／mode／deadline_ms 缺省行），
         * 签名由测试密钥（种子 bytes(range(32))，仅测试用）重签。 */
        const char *env_canonical =
            "qfr-lea-envelope-v2\n2\nreq-0000001\nbatch-0001\n1\nnode-1\nalice\n"
            "key-abc12345\n3\n1\nnonce-00001\n1780000000\n1780000060\nidem-key-0001\n"
            "ui.click\n43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777\n5000\n\n\n0";
        /* base64url 形式 */
        CHECK(lea_verify_envelope_signature("pw55vlGLGYB8gmGxEPSgmt6W1cusgGJhoFHAvry4W8VdKhJzgsZsA4rexv0ijFqERb11X1Wb-rFa4BeJFvVZDg",
                                            env_canonical, reason, sizeof(reason)) &&
              strcmp(reason, "ok") == 0, "sig-env-valid-b64url");
        /* 标准 base64 形式（服务端实际签发编码，含 '/'） */
        CHECK(lea_verify_envelope_signature("pw55vlGLGYB8gmGxEPSgmt6W1cusgGJhoFHAvry4W8VdKhJzgsZsA4rexv0ijFqERb11X1Wb+rFa4BeJFvVZDg==",
                                            env_canonical, reason, sizeof(reason)) &&
              strcmp(reason, "ok") == 0, "sig-env-valid-std-b64");
        /* 篡改规范串（timeout 5000→5001）→ 拒绝 */
        CHECK(!lea_verify_envelope_signature("pw55vlGLGYB8gmGxEPSgmt6W1cusgGJhoFHAvry4W8VdKhJzgsZsA4rexv0ijFqERb11X1Wb-rFa4BeJFvVZDg",
                                             "qfr-lea-envelope-v2\n2\nreq-0000001\nbatch-0001\n1\nnode-1\nalice\n"
                                             "key-abc12345\n3\n1\nnonce-00001\n1780000000\n1780000060\nidem-key-0001\n"
                                             "ui.click\n43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777\n5001\n\n\n0",
                                             reason, sizeof(reason)) &&
              strcmp(reason, "bad-signature") == 0, "sig-env-tampered-canonical-rejected");
        /* 篡改规范串（grant_epoch 1→2）→ 拒绝 */
        CHECK(!lea_verify_envelope_signature("pw55vlGLGYB8gmGxEPSgmt6W1cusgGJhoFHAvry4W8VdKhJzgsZsA4rexv0ijFqERb11X1Wb-rFa4BeJFvVZDg",
                                             "qfr-lea-envelope-v2\n2\nreq-0000001\nbatch-0001\n1\nnode-1\nalice\n"
                                             "key-abc12345\n3\n2\nnonce-00001\n1780000000\n1780000060\nidem-key-0001\n"
                                             "ui.click\n43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777\n5000\n\n\n0",
                                             reason, sizeof(reason)) &&
              strcmp(reason, "bad-signature") == 0, "sig-env-tampered-grant-epoch-rejected");
        /* 篡改签名（末字符 g→A：改末字节低 2 位；注意 g→h 只动填充位，字节不变）→ 拒绝 */
        CHECK(!lea_verify_envelope_signature("pw55vlGLGYB8gmGxEPSgmt6W1cusgGJhoFHAvry4W8VdKhJzgsZsA4rexv0ijFqERb11X1Wb-rFa4BeJFvVZDA",
                                             env_canonical, reason, sizeof(reason)) &&
              strcmp(reason, "bad-signature") == 0, "sig-env-tampered-sig-rejected");
        /* 另一把密钥所签 → 拒绝 */
        CHECK(!lea_verify_envelope_signature("h7Wrr8EHG4BUqAoB_zGzFZuIBfAl8H9UzbhpUKCUNennaUcXPP4fsDjAQZJqUTuTVysBqT886HX6GajGbOwYCg",
                                             env_canonical, reason, sizeof(reason)) &&
              strcmp(reason, "bad-signature") == 0, "sig-env-wrong-key-rejected");
        /* 格式合理但随机（86 个 'A'）→ 拒绝 */
        CHECK(!lea_verify_envelope_signature(sig86, env_canonical, reason, sizeof(reason)) &&
              strcmp(reason, "bad-signature") == 0, "sig-env-random-rejected");
        /* 票据签名（CANONICAL-SIGNING-V1.md §3.3 测试向量） */
        const char *ticket_canonical =
            "qfr-lea-ticket-v1\nalice\nnode-1\n3\n1\n1\nmuse.execute\n"
            "lease-0123456789abcdef\n1780086400";
        CHECK(lea_verify_ticket_signature("eNnL8IF32UOK4dunaNH5rZTIP0D9SpuoL9gxm2U6ZGbSOlw9uQY2W1FXI3PJ3nA0E_rVev3myRxDErIqepBWBg",
                                          ticket_canonical, reason, sizeof(reason)) &&
              strcmp(reason, "ok") == 0, "sig-ticket-valid");
        /* 票据签名用于信封串 → 拒绝（交叉） */
        CHECK(!lea_verify_ticket_signature("eNnL8IF32UOK4dunaNH5rZTIP0D9SpuoL9gxm2U6ZGbSOlw9uQY2W1FXI3PJ3nA0E_rVev3myRxDErIqepBWBg",
                                           env_canonical, reason, sizeof(reason)) &&
              strcmp(reason, "bad-signature") == 0, "sig-ticket-on-env-rejected");
#ifdef LEA_TEST_UNSIGNED
        CHECK(lea_verify_envelope_signature("TEST-UNSIGNED", env_canonical, reason, sizeof(reason)) &&
              strcmp(reason, "test-only-unsigned-accepted") == 0,
              "sig-test-unsigned-accepted-in-test-build");
#else
        CHECK(!lea_verify_envelope_signature("TEST-UNSIGNED", env_canonical, reason, sizeof(reason)),
              "sig-test-unsigned-rejected-in-strict-build");
#endif
#else
        /* ---- 占位（未编入公钥，fail-closed） ---- */
        CHECK(lea_server_pubkey_hex() == NULL, "sig-pubkey-not-configured");
        /* RC-01：无公钥时指纹算不出（握手永不完成，fail-closed）。 */
        {
            char fp[17] = { 0 };
            CHECK(lea_server_pubkey_fingerprint(fp) == 0 && fp[0] == '\0', "rc01-fingerprint-no-pubkey-fail-closed");
        }
        CHECK(!lea_verify_envelope_signature(sig86, "canonical", reason, sizeof(reason)) &&
              strcmp(reason, "ed25519-pubkey-not-configured") == 0,
              "sig-wellformed-but-no-pubkey-fail-closed");
#ifdef LEA_TEST_UNSIGNED
        CHECK(lea_verify_envelope_signature("TEST-UNSIGNED", "canonical", reason, sizeof(reason)) &&
              strcmp(reason, "test-only-unsigned-accepted") == 0,
              "sig-test-unsigned-accepted-in-test-build");
#else
        CHECK(!lea_verify_envelope_signature("TEST-UNSIGNED", "canonical", reason, sizeof(reason)),
              "sig-test-unsigned-rejected-in-strict-build");
#endif
#endif
    }

    /* ---------- RC-01：握手状态机（纯函数） ---------- */
    {
        lea_handshake_state_t hs;
        lea_handshake_init(&hs);
        CHECK(!lea_handshake_is_complete(&hs, "ff73a0647bbc29aa", 1, 1), "rc01-hs-init-incomplete");
        lea_handshake_mark_complete(&hs, "ff73a0647bbc29aa", 1, 1);
        CHECK(lea_handshake_is_complete(&hs, "ff73a0647bbc29aa", 1, 1), "rc01-hs-complete");
        /* 任一 epoch 变化即失效 */
        CHECK(!lea_handshake_is_complete(&hs, "ff73a0647bbc29aa", 2, 1), "rc01-hs-binding-epoch-change-invalid");
        CHECK(!lea_handshake_is_complete(&hs, "ff73a0647bbc29aa", 1, 2), "rc01-hs-grant-epoch-change-invalid");
        /* 指纹变化（公钥轮换）即失效 */
        CHECK(!lea_handshake_is_complete(&hs, "0000000000000000", 1, 1), "rc01-hs-fp-change-invalid");
        /* 显式失效后须重新标记 */
        lea_handshake_invalidate(&hs);
        CHECK(!lea_handshake_is_complete(&hs, "ff73a0647bbc29aa", 1, 1), "rc01-hs-invalidate");
        lea_handshake_mark_complete(&hs, "ff73a0647bbc29aa", 3, 2);
        CHECK(lea_handshake_is_complete(&hs, "ff73a0647bbc29aa", 3, 2), "rc01-hs-remark-complete-new-epochs");
        /* 空指纹永不标记完成（无公钥即 fail-closed） */
        lea_handshake_init(&hs);
        lea_handshake_mark_complete(&hs, "", 1, 1);
        CHECK(!lea_handshake_is_complete(&hs, "", 1, 1), "rc01-hs-empty-fp-never-complete");
        /* params 校验：指纹＋协议版本 2 缺一不可 */
        CHECK(lea_handshake_check_params("ff73a0647bbc29aa", "ff73a0647bbc29aa", 2), "rc01-hs-params-ok");
        CHECK(!lea_handshake_check_params("ff73a0647bbc29aa", "ff73a0647bbc29aa", 1), "rc01-hs-params-downgrade-rejected");
        CHECK(!lea_handshake_check_params("ff73a0647bbc29aa", "0000000000000000", 2), "rc01-hs-params-wrong-fp-rejected");
        CHECK(!lea_handshake_check_params("", "ff73a0647bbc29aa", 2), "rc01-hs-params-no-local-fp-rejected");
        CHECK(!lea_handshake_check_params("ff73a0647bbc29aa", NULL, 2), "rc01-hs-params-null-fp-rejected");
    }

    /* ---------- 重放表 ---------- */
    {
        static lea_replay_t r;
        lea_replay_init(&r);
        CHECK(lea_replay_check_and_add(&r, "req-a", "nonce-a", now), "replay-first-ok");
        CHECK(!lea_replay_check_and_add(&r, "req-a", "nonce-b", now), "replay-same-request-id");
        CHECK(!lea_replay_check_and_add(&r, "req-b", "nonce-a", now), "replay-same-nonce");
        CHECK(lea_replay_check_and_add(&r, "req-c", "nonce-c", now), "replay-other-ok");
        lea_replay_prune(&r, now + 601);
        CHECK(r.count == 0, "replay-prune-after-ttl");
    }

    /* ---------- 绑定状态机 ---------- */
    {
        lea_binding_t b;
        lea_binding_init(&b);
        CHECK(b.state == LEA_BIND_UNBOUND, "bind-init-unbound");
        long long e1 = lea_binding_on_login(&b, "alice", "node-1", now);
        CHECK(b.state == LEA_BIND_PENDING && e1 == 1, "bind-login-pending-epoch1");
        CHECK(!lea_binding_confirm(&b, "alice", "node-1", 99, 1, 1, "muse.execute", "lease-1", now + 3600, "TEST-UNSIGNED", now),
              "bind-confirm-wrong-epoch");
        CHECK(lea_binding_confirm(&b, "alice", "node-1", 1, 1, 1, "muse.execute", "lease-1", now + 3600, "TEST-UNSIGNED", now) &&
              b.state == LEA_BIND_ACTIVE, "bind-confirm-active");
        CHECK(lea_binding_has_scope(&b, "muse.execute"), "bind-scope-hit");
        CHECK(!lea_binding_has_scope(&b, "muse.execute.dangerous"), "bind-scope-miss");
        long long e2 = lea_binding_on_login(&b, "bob", "node-1", now);
        CHECK(e2 == 2 && b.state == LEA_BIND_PENDING && b.grant_muse_execute == 0,
              "bind-relogin-revokes-old-epoch-plus-1");
        lea_binding_revoke(&b, now);
        CHECK(b.state == LEA_BIND_UNBOUND && b.epoch == 3, "bind-revoke-unbound-epoch-plus-1");
    }

    /* ---------- H07：同账号重登不升 epoch；H02：票据签名存取与重验 ---------- */
    {
        lea_binding_t b;
        lea_binding_init(&b);
        long long e1 = lea_binding_on_login(&b, "alice", "node-1", now);
        CHECK(lea_binding_confirm(&b, "alice", "node-1", 1, 1, 1, "muse.execute", "lease-0123456789abcdef",
                                  now + 3600, "TEST-UNSIGNED", now) &&
              b.state == LEA_BIND_ACTIVE, "h07-same-account-setup-active");
        CHECK(strcmp(b.ticket_signature, "TEST-UNSIGNED") == 0, "h02-confirm-stores-signature");
        long long e2 = lea_binding_on_login(&b, "alice", "node-1", now);
        CHECK(e2 == e1 && b.state == LEA_BIND_PENDING, "h07-same-account-relogin-keeps-epoch");
        /* 同账号重登后仍可用同一票据确认（epoch 未变） */
        CHECK(lea_binding_confirm(&b, "alice", "node-1", 1, 1, 1, "muse.execute", "lease-0123456789abcdef",
                                  now + 3600, "TEST-UNSIGNED", now) &&
              b.state == LEA_BIND_ACTIVE, "h07-same-account-reconfirm-active");
#ifdef LEA_TEST_UNSIGNED
        CHECK(lea_binding_verify_ticket(&b), "h02-verify-ticket-ok-test-build");
        /* 占位验签（TEST-UNSIGNED）不看规范串内容，篡改字段测不断言
         * verify——断言规范串本身随授权字段变化（真公钥下验签必失败，
         * 见 canonical-ticket-changes-on-grant-flip）。 */
        {
            char c_before[1024], c_after[1024];
            CHECK(lea_ticket_canonical(b.account_id, b.device_id, b.epoch, b.grant_epoch,
                                       b.grant_muse_execute, b.scopes, b.lease_id, b.expires_at,
                                       c_before, sizeof(c_before)), "h02-canonical-before-builds");
            b.grant_muse_execute = 0; /* 篡改授权字段 */
            CHECK(lea_ticket_canonical(b.account_id, b.device_id, b.epoch, b.grant_epoch,
                                       b.grant_muse_execute, b.scopes, b.lease_id, b.expires_at,
                                       c_after, sizeof(c_after)) &&
                  strcmp(c_before, c_after) != 0, "h02-canonical-changes-on-tampered-grant");
            b.grant_muse_execute = 1;
        }
        CHECK(lea_binding_verify_ticket(&b), "h02-verify-ticket-ok-after-restore");
        b.ticket_signature[0] = '\0'; /* 签名缺失 */
        CHECK(!lea_binding_verify_ticket(&b), "h02-verify-ticket-fails-on-missing-sig");
#else
        CHECK(!lea_binding_verify_ticket(&b), "h02-verify-ticket-fail-closed-strict-build");
#endif
        /* 换号仍升 epoch；登出清签名 */
        lea_binding_on_login(&b, "bob", "node-1", now);
        CHECK(b.epoch == 2 && b.ticket_signature[0] == '\0', "h07-switch-account-bumps-epoch-clears-sig");
        lea_binding_revoke(&b, now);
        CHECK(b.ticket_signature[0] == '\0', "h02-revoke-clears-signature");
    }

    /* ---------- 低项 3：绑定 scopes／lease_id 缓冲与票据同宽 ----------
     * 票据 lea_ticket_t 为 scopes[257]／lease_id[128]，旧绑定
     * lea_binding_t 为 scopes[256]／lease_id[64]，超长字段会被静默截断
     * （重启后 canonical 对不上即丢绑定）。本用例以票据级最大长度确认：
     * 256 字符 scopes 与 127 字符 lease_id 须原样存入绑定。 */
    {
        char scopes_max[257];
        char lease_max[128];
        /* 50 个 "a000".."a049" ＋ ",a05000"：严格升序，共 256 字符。 */
        scopes_max[0] = '\0';
        for (int i = 0; i < 50; i++) {
            char tok[8];
            snprintf(tok, sizeof(tok), "a%03d", i);
            if (i) strcat(scopes_max, ",");
            strcat(scopes_max, tok);
        }
        strcat(scopes_max, ",a05000");
        CHECK(strlen(scopes_max) == 256, "low3-scopes-fixture-256");
        CHECK(lea_validate_scopes_str(scopes_max), "low3-scopes-fixture-valid");
        memset(lease_max, '9', 127);
        memcpy(lease_max, "lease-", 6);
        lease_max[127] = '\0';
        CHECK(strlen(lease_max) == 127, "low3-lease-fixture-127");
        CHECK(lea_validate_id_field(lease_max), "low3-lease-fixture-valid");
        lea_binding_t b;
        lea_binding_init(&b);
        lea_binding_on_login(&b, "alice", "node-1", now);
        CHECK(lea_binding_confirm(&b, "alice", "node-1", 1, 1, 1, scopes_max, lease_max,
                                  now + 3600, "TEST-UNSIGNED", now) &&
              b.state == LEA_BIND_ACTIVE, "low3-confirm-max-length-active");
        CHECK(strcmp(b.scopes, scopes_max) == 0, "low3-scopes-stored-full-256");
        CHECK(strcmp(b.lease_id, lease_max) == 0, "low3-lease-stored-full-127");
        CHECK(lea_binding_has_scope(&b, "a049"), "low3-scope-hit-last-token");
#ifdef LEA_TEST_UNSIGNED
        /* 规范串须随超长字段完整重建（占位验签下只验 canonical 本身能
         * 建成且含完整字段；真公钥下验签才有意义）。 */
        {
            char canon[1024];
            CHECK(lea_ticket_canonical(b.account_id, b.device_id, b.epoch, b.grant_epoch,
                                       b.grant_muse_execute, b.scopes, b.lease_id, b.expires_at,
                                       canon, sizeof(canon)) &&
                  strstr(canon, scopes_max) != NULL && strstr(canon, lease_max) != NULL,
                  "low3-canonical-carries-full-scopes-lease");
            CHECK(lea_binding_verify_ticket(&b), "low3-verify-ticket-ok-max-length");
        }
#endif
    }

    /* ---------- F-05：绑定票据身份须与本机 PENDING 绑定一致 ----------
     * GPT 第二轮审计 F-05（P2，严格阻断项）：旧 lea_binding_confirm 只
     * 查 state／epoch／过期，从不比对票据 account_id／device_id 与本机
     * PENDING 绑定——一张有效签名但属于别的账号／设备的票据（epoch
     * 相同）会被接受并激活绑定，属跨设备票据混用。另堵 expires_at==0
     * 永不过期：租约须 > now 且 ≤ now＋24h＋5min（服务端签发
     * nowSec()＋24h，见 lea-core.js TICKET_TTL_S；5min 为时钟偏差容限）。
     * 拒绝后绑定须仍停在 PENDING（不写授权字段、不激活），以便合法票据
     * 随后仍可确认。 */
    {
        lea_binding_t b;
        lea_binding_init(&b);
        lea_binding_on_login(&b, "alice", "node-1", now);
        CHECK(b.state == LEA_BIND_PENDING && b.epoch == 1, "f05-setup-pending");
        /* 错账号（epoch 相同）拒绝，仍 PENDING */
        CHECK(!lea_binding_confirm(&b, "bob", "node-1", 1, 1, 1, "muse.execute", "lease-1",
                                   now + 3600, "TEST-UNSIGNED", now) &&
              b.state == LEA_BIND_PENDING && b.grant_muse_execute == 0,
              "f05-wrong-account-rejected");
        /* 错设备拒绝，仍 PENDING */
        CHECK(!lea_binding_confirm(&b, "alice", "node-2", 1, 1, 1, "muse.execute", "lease-1",
                                   now + 3600, "TEST-UNSIGNED", now) &&
              b.state == LEA_BIND_PENDING,
              "f05-wrong-device-rejected");
        /* 空账号／空设备拒绝（永不命中） */
        CHECK(!lea_binding_confirm(&b, "", "node-1", 1, 1, 1, "muse.execute", "lease-1",
                                   now + 3600, "TEST-UNSIGNED", now),
              "f05-empty-account-rejected");
        CHECK(!lea_binding_confirm(&b, "alice", "", 1, 1, 1, "muse.execute", "lease-1",
                                   now + 3600, "TEST-UNSIGNED", now),
              "f05-empty-device-rejected");
        /* expires_at==0（旧“永不过期”）拒绝 */
        CHECK(!lea_binding_confirm(&b, "alice", "node-1", 1, 1, 1, "muse.execute", "lease-1",
                                   0, "TEST-UNSIGNED", now) &&
              b.state == LEA_BIND_PENDING,
              "f05-expires-zero-rejected");
        /* 负数 expires_at 拒绝 */
        CHECK(!lea_binding_confirm(&b, "alice", "node-1", 1, 1, 1, "muse.execute", "lease-1",
                                   -1, "TEST-UNSIGNED", now),
              "f05-expires-negative-rejected");
        /* 已过期（== now 与 < now）拒绝 */
        CHECK(!lea_binding_confirm(&b, "alice", "node-1", 1, 1, 1, "muse.execute", "lease-1",
                                   now, "TEST-UNSIGNED", now),
              "f05-expires-now-rejected");
        CHECK(!lea_binding_confirm(&b, "alice", "node-1", 1, 1, 1, "muse.execute", "lease-1",
                                   now - 3600, "TEST-UNSIGNED", now),
              "f05-expires-past-rejected");
        /* 超长 TTL（24h＋5min＋1s）拒绝 */
        CHECK(!lea_binding_confirm(&b, "alice", "node-1", 1, 1, 1, "muse.execute", "lease-1",
                                   now + LEA_BINDING_TICKET_MAX_TTL_SEC + 1,
                                   "TEST-UNSIGNED", now),
              "f05-ttl-too-long-rejected");
        /* 合法票据仍通过 */
        CHECK(lea_binding_confirm(&b, "alice", "node-1", 1, 1, 1, "muse.execute", "lease-1",
                                  now + 3600, "TEST-UNSIGNED", now) &&
              b.state == LEA_BIND_ACTIVE, "f05-legit-ticket-active");
        /* 上限边界（恰 24h＋5min）通过 */
        lea_binding_on_login(&b, "alice", "node-1", now);
        CHECK(lea_binding_confirm(&b, "alice", "node-1", 1, 1, 1, "muse.execute", "lease-1",
                                  now + LEA_BINDING_TICKET_MAX_TTL_SEC,
                                  "TEST-UNSIGNED", now) &&
              b.state == LEA_BIND_ACTIVE, "f05-max-ttl-boundary-ok");
        /* 票据 device_id 全形 "node//..."，本机绑定裸形：归一后匹配通过 */
        lea_binding_on_login(&b, "alice", "node-1", now);
        CHECK(lea_binding_confirm(&b, "alice", "node//node-1", 1, 1, 1, "muse.execute", "lease-1",
                                  now + 3600, "TEST-UNSIGNED", now) &&
              b.state == LEA_BIND_ACTIVE, "f05-full-form-device-id-ok");
        /* 反向：本机绑定全形、票据裸形，同样通过 */
        lea_binding_on_login(&b, "alice", "node//node-1", now);
        CHECK(lea_binding_confirm(&b, "alice", "node-1", 1, 1, 1, "muse.execute", "lease-1",
                                  now + 3600, "TEST-UNSIGNED", now) &&
              b.state == LEA_BIND_ACTIVE, "f05-bare-ticket-full-binding-ok");
    }

    /* ---------- H03：信封插 token 字段 ---------- */
    {
        char out[256];
        CHECK(lea_json_insert_string_field("{\"a\":1}", "ush_token", "abcdef0123456789", out, sizeof(out)) &&
              strcmp(out, "{\"a\":1,\"ush_token\":\"abcdef0123456789\"}") == 0, "insert-field-basic");
        CHECK(lea_json_insert_string_field("{\"a\":\"x\\\"y\"}", "k", "v\"w", out, sizeof(out)) &&
              strcmp(out, "{\"a\":\"x\\\"y\",\"k\":\"v\\\"w\"}") == 0, "insert-field-escapes");
        CHECK(!lea_json_insert_string_field("not json", "k", "v", out, sizeof(out)), "insert-field-rejects-non-object");
        CHECK(!lea_json_insert_string_field("{\"a\":1}", "k", "v", out, 10), "insert-field-rejects-tiny-buffer");
        CHECK(!lea_json_insert_string_field("", "k", "v", out, sizeof(out)), "insert-field-rejects-empty");
    }

    /* ---------- H07 第二轮：login_changed 的 result 格式锁死 ----------
     * main.js 钩子从 result.binding_epoch 取 epoch 去调 rebind；格式一变
     * 钩子就空转。QFRLEA.c 的 login_changed 分支直接调本函数，不再内联
     * snprintf——格式由这里的断言守住。 */
    {
        char out[256];
        CHECK(lea_binding_login_result(42, out, sizeof(out)) &&
              strcmp(out, "{\"binding_state\":\"PENDING\",\"binding_epoch\":42}") == 0,
              "h07-login-result-format");
        CHECK(lea_binding_login_result(0, out, sizeof(out)) &&
              strcmp(out, "{\"binding_state\":\"PENDING\",\"binding_epoch\":0}") == 0,
              "h07-login-result-epoch-zero");
        CHECK(!lea_binding_login_result(1, out, 10), "h07-login-result-rejects-tiny-buffer");
        CHECK(!lea_binding_login_result(1, NULL, sizeof(out)), "h07-login-result-rejects-null");
    }

    /* ---------- 准入各码 ---------- */
    {
        lea_binding_t b;
        char err[64] = { 0 };
        make_envelope(env_buf, sizeof(env_buf), now, "sys.info", "{}", 3, "node-1",
                      "alice", "idem-key-1001", "nonce-10001", "req-1000001", "TEST-UNSIGNED");
        lea_parse_envelope(env_buf, now, &env);
        /* 未绑定 */
        lea_binding_init(&b);
        CHECK(!lea_admit(&env, &b, NULL, 0, err, sizeof(err)) &&
              strcmp(err, "QFR_LEA_NOT_BOUND") == 0, "admit-not-bound");
        /* PENDING（唯一可重试） */
        lea_binding_on_login(&b, "alice", "node-1", now);
        b.epoch = 3;
        CHECK(!lea_admit(&env, &b, NULL, 0, err, sizeof(err)) &&
              strcmp(err, "QFR_LEA_BINDING_PENDING") == 0 &&
              lea_error_retryable(err), "admit-binding-pending-retryable");
        /* 正常放行 */
        active_binding(&b, 3, 1, "muse.execute,muse.execute.dangerous");
        CHECK(lea_admit(&env, &b, NULL, 0, err, sizeof(err)), "admit-ok");
        /* epoch 不匹配 */
        make_envelope(env_buf, sizeof(env_buf), now, "sys.info", "{}", 2, "node-1",
                      "alice", "idem-key-1002", "nonce-10002", "req-1000002", "TEST-UNSIGNED");
        lea_parse_envelope(env_buf, now, &env);
        CHECK(!lea_admit(&env, &b, NULL, 0, err, sizeof(err)) &&
              strcmp(err, "QFR_BINDING_CHANGED") == 0, "admit-binding-changed");
        /* F-02：grant_epoch 不匹配 → QFR_GRANT_REVOKED（撤销后重授予，
         * 旧代次信封永不复活；与服务端 admit() 同一条件同一码）。 */
        make_envelope_ge(env_buf, sizeof(env_buf), now, "sys.info", "{}", 3, 2, "node-1",
                      "alice", "idem-key-1007", "nonce-10007", "req-1000007", "TEST-UNSIGNED");
        lea_parse_envelope(env_buf, now, &env);
        CHECK(!lea_admit(&env, &b, NULL, 0, err, sizeof(err)) &&
              strcmp(err, "QFR_GRANT_REVOKED") == 0, "admit-grant-epoch-changed");
        /* F-02：grant_epoch 0 也不放行（ACTIVE 绑定 grant_epoch 恒 ≥1）。 */
        make_envelope_ge(env_buf, sizeof(env_buf), now, "sys.info", "{}", 3, 0, "node-1",
                      "alice", "idem-key-1008", "nonce-10008", "req-1000008", "TEST-UNSIGNED");
        lea_parse_envelope(env_buf, now, &env);
        CHECK(!lea_admit(&env, &b, NULL, 0, err, sizeof(err)) &&
              strcmp(err, "QFR_GRANT_REVOKED") == 0, "admit-grant-epoch-zero-rejected");
        /* F-02：grant_epoch 一致（＝绑定值 1）即通过本项。 */
        make_envelope_ge(env_buf, sizeof(env_buf), now, "sys.info", "{}", 3, 1, "node-1",
                      "alice", "idem-key-1009", "nonce-10009", "req-1000009", "TEST-UNSIGNED");
        lea_parse_envelope(env_buf, now, &env);
        CHECK(lea_admit(&env, &b, NULL, 0, err, sizeof(err)), "admit-grant-epoch-match-ok");
        /* 设备不匹配 */
        make_envelope(env_buf, sizeof(env_buf), now, "sys.info", "{}", 3, "node-2",
                      "alice", "idem-key-1003", "nonce-10003", "req-1000003", "TEST-UNSIGNED");
        lea_parse_envelope(env_buf, now, &env);
        CHECK(!lea_admit(&env, &b, NULL, 0, err, sizeof(err)) &&
              strcmp(err, "QFR_DEVICE_NOT_WHITELISTED") == 0, "admit-device-not-whitelisted");
        /* 未授权 muse.execute */
        active_binding(&b, 3, 0, "");
        make_envelope(env_buf, sizeof(env_buf), now, "sys.info", "{}", 3, "node-1",
                      "alice", "idem-key-1004", "nonce-10004", "req-1000004", "TEST-UNSIGNED");
        lea_parse_envelope(env_buf, now, &env);
        CHECK(!lea_admit(&env, &b, NULL, 0, err, sizeof(err)) &&
              strcmp(err, "QFR_MUSE_NOT_AUTHORIZED") == 0, "admit-not-authorized");
        /* scope 不足：script.run 需 dangerous scope */
        active_binding(&b, 3, 1, "muse.execute");
        make_envelope(env_buf, sizeof(env_buf), now, "script.run", "{}", 3, "node-1",
                      "alice", "idem-key-1005", "nonce-10005", "req-1000005", "TEST-UNSIGNED");
        lea_parse_envelope(env_buf, now, &env);
        CHECK(!lea_admit(&env, &b, NULL, 0, err, sizeof(err)) &&
              strcmp(err, "QFR_SCOPE_DENIED") == 0, "admit-scope-denied");
        /* Key 已吊销 */
        active_binding(&b, 3, 1, "muse.execute,muse.execute.dangerous");
        const char *revoked[] = { "key-abc12345" };
        make_envelope(env_buf, sizeof(env_buf), now, "sys.info", "{}", 3, "node-1",
                      "alice", "idem-key-1006", "nonce-10006", "req-1000006", "TEST-UNSIGNED");
        lea_parse_envelope(env_buf, now, &env);
        CHECK(!lea_admit(&env, &b, revoked, 1, err, sizeof(err)) &&
              strcmp(err, "QFR_API_KEY_REVOKED") == 0, "admit-key-revoked");
    }

    /* ---------- r9：admit device_id 归一（裸形／全形双向命中） ----------
     * r8 根因：服务端信封 device_id 回显全形（node//…），本地绑定存裸形，
     * strcmp 原始比较恒不等 → QFR_DEVICE_NOT_WHITELISTED。归一口径与
     * 服务端 bareNodeId 一致：仅去一层 "node//" 前缀。 */
    {
        lea_binding_t b;
        char err[64] = { 0 };
        /* helper 本身：仅去一层前缀；NULL／空／退化 id 归一为空串。 */
        CHECK(strcmp(lea_bare_node_id("node//abc"), "abc") == 0, "r9-bare-strips-one-prefix");
        CHECK(strcmp(lea_bare_node_id("abc"), "abc") == 0, "r9-bare-keeps-bare");
        CHECK(strcmp(lea_bare_node_id(""), "") == 0, "r9-bare-empty");
        CHECK(strcmp(lea_bare_node_id(NULL), "") == 0, "r9-bare-null");
        CHECK(strcmp(lea_bare_node_id("node//"), "") == 0, "r9-bare-degenerate-prefix-only");
        CHECK(strcmp(lea_bare_node_id("node//node//x"), "node//x") == 0,
              "r9-bare-strips-only-one-layer");
        CHECK(lea_device_id_matches("node//node-1", "node-1"), "r9-match-full-vs-bare");
        CHECK(lea_device_id_matches("node-1", "node//node-1"), "r9-match-bare-vs-full");
        CHECK(!lea_device_id_matches("node//node-1", "node-2"), "r9-match-different-device");
        CHECK(!lea_device_id_matches("node//", "node//"), "r9-match-degenerate-never");
        CHECK(!lea_device_id_matches("", ""), "r9-match-empty-never");
        CHECK(!lea_device_id_matches(NULL, "node-1"), "r9-match-null-never");

        /* 四种组合均放行：裸绑定＋全形信封（r8 真实阻塞形态）、
         * 全形绑定＋裸形信封、双裸、双全。 */
        const char *bind_ids[4] = { "node-1", "node//node-1", "node-1", "node//node-1" };
        const char *env_ids[4] = { "node//node-1", "node-1", "node-1", "node//node-1" };
        const char *names[4] = { "r9-admit-bare-bind-full-env", "r9-admit-full-bind-bare-env",
                                 "r9-admit-bare-bare", "r9-admit-full-full" };
        for (int i = 0; i < 4; i++) {
            active_binding(&b, 3, 1, "muse.execute,muse.execute.dangerous");
            snprintf(b.device_id, sizeof(b.device_id), "%s", bind_ids[i]);
            char idem[32], nonce[32], req[32];
            snprintf(idem, sizeof(idem), "idem-key-200%d", i);
            snprintf(nonce, sizeof(nonce), "nonce-2000%d", i);
            snprintf(req, sizeof(req), "req-200000%d", i);
            make_envelope(env_buf, sizeof(env_buf), now, "sys.info", "{}", 3, env_ids[i],
                          "alice", idem, nonce, req, "TEST-UNSIGNED");
            lea_parse_envelope(env_buf, now, &env);
            CHECK(lea_admit(&env, &b, NULL, 0, err, sizeof(err)), names[i]);
        }
        /* 否定：不同设备（全形信封）仍拒绝。 */
        active_binding(&b, 3, 1, "muse.execute,muse.execute.dangerous");
        make_envelope(env_buf, sizeof(env_buf), now, "sys.info", "{}", 3, "node//node-2",
                      "alice", "idem-key-2010", "nonce-20100", "req-2010000", "TEST-UNSIGNED");
        lea_parse_envelope(env_buf, now, &env);
        CHECK(!lea_admit(&env, &b, NULL, 0, err, sizeof(err)) &&
              strcmp(err, "QFR_DEVICE_NOT_WHITELISTED") == 0,
              "r9-admit-full-env-different-device-rejected");
        /* 否定：退化 id（绑定与信封均为 "node//"）永不命中，fail-closed。 */
        active_binding(&b, 3, 1, "muse.execute,muse.execute.dangerous");
        snprintf(b.device_id, sizeof(b.device_id), "node//");
        make_envelope(env_buf, sizeof(env_buf), now, "sys.info", "{}", 3, "node//",
                      "alice", "idem-key-2011", "nonce-20101", "req-2010001", "TEST-UNSIGNED");
        lea_parse_envelope(env_buf, now, &env);
        CHECK(!lea_admit(&env, &b, NULL, 0, err, sizeof(err)) &&
              strcmp(err, "QFR_DEVICE_NOT_WHITELISTED") == 0,
              "r9-admit-degenerate-id-rejected");
    }

    /* ---------- 幂等去重＋持久化 ---------- */
    {
        static lea_idem_t t;
        lea_idem_init(&t);
        lea_idem_entry_t *e = lea_idem_get_or_create(&t, "node-1", "alice", "k-1", 0, now);
        CHECK(e && e->status == LEA_IDEM_RECEIVED, "idem-create-received");
        CHECK(lea_idem_lookup(&t, "node-1", "alice", "k-1") == e, "idem-lookup-hit");
        CHECK(lea_idem_lookup(&t, "node-1", "alice", "k-2") == NULL, "idem-lookup-miss");
        CHECK(lea_idem_lookup(&t, "node-1", "bob", "k-1") == NULL, "idem-key-scoped-by-account");
        lea_idem_set_status(&t, e, LEA_IDEM_RUNNING, NULL, now);
        CHECK(lea_idem_lookup(&t, "node-1", "alice", "k-1")->status == LEA_IDEM_RUNNING,
              "idem-running");
        const char *cached = "{\"ok\":true,\"code\":\"done\",\"request_id\":\"r\"}";
        lea_idem_set_status(&t, e, LEA_IDEM_SUCCEEDED, cached, now);
        CHECK(strcmp(lea_idem_lookup(&t, "node-1", "alice", "k-1")->result, cached) == 0,
              "idem-cached-result");
        /* 带末尾换行的响应存入后须被剥离，JSONL 往返才不断行。 */
        lea_idem_entry_t *e_nl = lea_idem_get_or_create(&t, "node-1", "alice", "k-nl", 0, now);
        char cached_nl[128];
        snprintf(cached_nl, sizeof(cached_nl), "%s\n", cached);
        lea_idem_set_status(&t, e_nl, LEA_IDEM_SUCCEEDED, cached_nl, now);
        CHECK(strchr(lea_idem_lookup(&t, "node-1", "alice", "k-nl")->result, '\n') == NULL,
              "idem-result-newline-stripped");
        /* 持久化往返 */
        static char text[1 << 20];
        CHECK(lea_idem_save_text(&t, text, sizeof(text)), "idem-save-text");
        static lea_idem_t t2;
        CHECK(lea_idem_load_text(&t2, text), "idem-load-text");
        lea_idem_entry_t *e2 = lea_idem_lookup(&t2, "node-1", "alice", "k-1");
        CHECK(e2 && e2->status == LEA_IDEM_SUCCEEDED &&
              strcmp(e2->result, cached) == 0, "idem-roundtrip");
        /* 崩溃残留标 UNKNOWN */
        lea_idem_get_or_create(&t2, "node-1", "alice", "k-9", 0, now);
        CHECK(lea_idem_mark_crashed_unknown(&t2, now) == 1, "idem-crashed-to-unknown");
        CHECK(lea_idem_lookup(&t2, "node-1", "alice", "k-9")->status == LEA_IDEM_UNKNOWN,
              "idem-unknown-status");
        /* 保留期：普通 7 天、危险 30 天 */
        static lea_idem_t t3;
        lea_idem_init(&t3);
        lea_idem_entry_t *old = lea_idem_get_or_create(&t3, "node-1", "alice", "old", 0, now - 8 * 86400);
        lea_idem_set_status(&t3, old, LEA_IDEM_SUCCEEDED, cached, now - 8 * 86400);
        lea_idem_entry_t *old_d = lea_idem_get_or_create(&t3, "node-1", "alice", "old-d", 1, now - 8 * 86400);
        lea_idem_set_status(&t3, old_d, LEA_IDEM_SUCCEEDED, cached, now - 8 * 86400);
        lea_idem_entry_t *fresh = lea_idem_get_or_create(&t3, "node-1", "alice", "fresh", 0, now);
        lea_idem_set_status(&t3, fresh, LEA_IDEM_SUCCEEDED, cached, now);
        CHECK(lea_idem_prune(&t3, now) == 1, "idem-prune-7d-only-normal");
        CHECK(lea_idem_lookup(&t3, "node-1", "alice", "old") == NULL, "idem-pruned-old");
        CHECK(lea_idem_lookup(&t3, "node-1", "alice", "old-d") != NULL, "idem-dangerous-kept-30d");
    }

    /* ---------- 路径规范化与白名单目录判定 ---------- */
    {
        char norm[512];
        CHECK(lea_normalize_path("C:\\Program Files\\QFRemote\\..\\QFRemote\\x.ps1", norm, sizeof(norm)) &&
              strcmp(norm, "C:\\Program Files\\QFRemote\\x.ps1") == 0, "path-normalize-dotdot-inside");
        CHECK(lea_normalize_path("C:\\Program Files\\QFRemote\\..\\..\\Windows\\x.ps1", norm, sizeof(norm)) &&
              strcmp(norm, "C:\\Windows\\x.ps1") == 0, "path-normalize-dotdot-resolves");
        /* 上一级的 .. 只是词法解析到别的目录；真正的安全判定是 under-root。 */
        CHECK(!lea_path_under_root("C:\\Windows\\x.ps1", "C:\\Program Files\\QFRemote"),
              "path-dotdot-outside-install-rejected-by-root-check");
        CHECK(!lea_normalize_path("C:\\..\\x.ps1", norm, sizeof(norm)),
              "path-normalize-dotdot-escape-drive-root");
        CHECK(!lea_normalize_path("..\\evil.ps1", norm, sizeof(norm)), "path-normalize-leading-dotdot");
        CHECK(lea_normalize_path("C:\\ProgramData\\QFR\\LEA\\work\\.\\a.txt", norm, sizeof(norm)) &&
              strcmp(norm, "C:\\ProgramData\\QFR\\LEA\\work\\a.txt") == 0, "path-normalize-dot");
        /* N-01 超长输出边界（double-free 回归）：输出缓冲 260（MAX_PATH）。
         * 旧代码在拼接中途 goto fail 时二次释放已 free 的段（SYSTEM 服务
         * 堆破坏）；以下用例逐一走该路径，ASan 下旧代码必报 heap-double-free。 */
        {
            char norm260[260];
            char big[1200];
            size_t k;
            /* 23 段 × 10 字符＋末段 3 字符：归一化长 2 + 23*11 + 4 = 259，
             * 259 + NUL = 260，恰好装进 260 缓冲 → 成功。 */
            strcpy(big, "C:");
            for (k = 0; k < 23; k++) strcat(big, "\\aaaaaaaaaa");
            strcat(big, "\\aaa");
            CHECK(lea_normalize_path(big, norm260, sizeof(norm260)) &&
                  strlen(norm260) == 259, "path-normalize-259-fits-260");
            /* 末段 4 字符：归一化长 260，260 + NUL = 261 > 260 → 拒绝，
             * 且失败后 out 不留部分输出。 */
            strcpy(big, "C:");
            for (k = 0; k < 23; k++) strcat(big, "\\aaaaaaaaaa");
            strcat(big, "\\aaaa");
            norm260[0] = 'X';
            CHECK(!lea_normalize_path(big, norm260, sizeof(norm260)) &&
                  norm260[0] == '\0', "path-normalize-260-rejected-260");
            /* 1023 字符输入：tmp[1024] 上限内，单段归一化后 1023 字符，
             * 大缓冲成功、260 缓冲拒绝。 */
            memset(big, 'a', 1023);
            big[1023] = '\0';
            {
                char norm2048[2048];
                CHECK(lea_normalize_path(big, norm2048, sizeof(norm2048)) &&
                      strlen(norm2048) == 1023, "path-normalize-1023-input-ok");
            }
            CHECK(!lea_normalize_path(big, norm260, sizeof(norm260)),
                  "path-normalize-1023-input-rejected-260");
            /* 1024 字符输入：超 tmp[1024] 上限，直接拒绝。 */
            memset(big, 'a', 1024);
            big[1024] = '\0';
            CHECK(!lea_normalize_path(big, norm260, sizeof(norm260)),
                  "path-normalize-1024-input-rejected");
            /* 多段路径：128 段 × 1 字符，归一化长 2 + 128*2 = 258 → 成功；
             * 129 段触段数上限 128 → 拒绝（不泄漏）。 */
            strcpy(big, "C:");
            for (k = 0; k < 128; k++) strcat(big, "\\s");
            CHECK(lea_normalize_path(big, norm260, sizeof(norm260)) &&
                  strlen(norm260) == 258, "path-normalize-128-segments-ok");
            strcat(big, "\\s");
            CHECK(!lea_normalize_path(big, norm260, sizeof(norm260)),
                  "path-normalize-129-segments-rejected");
            /* ".." 弹段不泄漏：大量 ".." 来回后仍能正常归一化（ASan 下
             * 无泄漏报告；旧代码每 ".." 漏一次 malloc）。 */
            strcpy(big, "C:\\a\\b\\c\\..\\..\\d\\e\\..\\f.txt");
            CHECK(lea_normalize_path(big, norm260, sizeof(norm260)) &&
                  strcmp(norm260, "C:\\a\\d\\f.txt") == 0,
                  "path-normalize-dotdot-pop-no-leak");
        }
        CHECK(lea_path_under_root("C:\\ProgramData\\QFR\\LEA\\work\\a.txt",
                                  "C:\\ProgramData\\QFR\\LEA\\work"), "path-under-root-ok");
        CHECK(!lea_path_under_root("C:\\ProgramData\\QFR\\LEA\\work2\\a.txt",
                                   "C:\\ProgramData\\QFR\\LEA\\work"), "path-under-root-sibling-prefix");
        CHECK(!lea_path_under_root("C:\\ProgramData\\QFR\\LEA\\work",
                                   "C:\\ProgramData\\QFR\\LEA\\work"), "path-under-root-equal-not-inside");
        CHECK(lea_path_under_root("c:\\programdata\\qfr\\lea\\work\\a.txt",
                                  "C:\\ProgramData\\QFR\\LEA\\work"), "path-under-root-case-insensitive");
    }

    /* ---------- 队列 ---------- */
    {
        static lea_queue_t q;
        lea_queue_init(&q);
        CHECK(lea_queue_total(&q) == 0, "queue-init-empty");
        /* 每项含 8KB params_raw，101 项约 1MB：放静态区，不放栈。 */
        static lea_queue_item_t items[101];
        memset(items, 0, sizeof(items));
        char err[64] = { 0 };
        int enqueued = 0;
        for (int i = 0; i < 100; i++) {
            items[i].dangerous = 0;
            if (lea_queue_enqueue(&q, &items[i], err, sizeof(err))) enqueued++;
        }
        CHECK(enqueued == 100 && lea_queue_total(&q) == 100, "queue-enqueue-100");
        items[100].dangerous = 0;
        CHECK(!lea_queue_enqueue(&q, &items[100], err, sizeof(err)) &&
              strcmp(err, "QFR_QUEUE_FULL") == 0, "queue-full-101st");
        /* FIFO 顺序 */
        lea_queue_item_t *first = lea_queue_dequeue(&q);
        CHECK(first == &items[0], "queue-fifo-order");
        /* 危险 lane 优先 */
        static lea_queue_t q2;
        lea_queue_init(&q2);
        lea_queue_item_t a, b, c;
        memset(&a, 0, sizeof(a));
        memset(&b, 0, sizeof(b));
        memset(&c, 0, sizeof(c));
        a.dangerous = 0; b.dangerous = 1; c.dangerous = 0;
        lea_queue_enqueue(&q2, &a, err, sizeof(err));
        lea_queue_enqueue(&q2, &b, err, sizeof(err));
        lea_queue_enqueue(&q2, &c, err, sizeof(err));
        CHECK(lea_queue_dequeue(&q2) == &b, "queue-dangerous-lane-first");
        CHECK(lea_queue_dequeue(&q2) == &a, "queue-normal-fifo-after-dangerous");
        CHECK(lea_queue_dequeue(&q2) == &c, "queue-normal-second");
        CHECK(lea_queue_dequeue(&q2) == NULL, "queue-drain-empty");
    }

    /* ---------- RC-02：按 Key 摘队列 ---------- */
    {
        static lea_queue_t q3;
        lea_queue_init(&q3);
        static lea_queue_item_t ritems[6];
        memset(ritems, 0, sizeof(ritems));
        char err[64];
        /* 3 条普通（k1,k2,k1）＋2 条危险（k1,k2）＋1 条普通（k2）。 */
        const char *rkeys[6] = { "k_1111111111", "k_2222222222", "k_1111111111",
                                 "k_1111111111", "k_2222222222", "k_2222222222" };
        int rdang[6] = { 0, 0, 0, 1, 1, 0 };
        for (int i = 0; i < 6; i++) {
            snprintf(ritems[i].env.api_key_id, sizeof(ritems[i].env.api_key_id), "%s", rkeys[i]);
            ritems[i].dangerous = rdang[i];
            CHECK(lea_queue_enqueue(&q3, &ritems[i], err, sizeof(err)), "rc02-queue-remove-setup");
        }
        CHECK(lea_queue_total(&q3) == 6, "rc02-queue-remove-total-6");
        int removed = -1;
        lea_queue_item_t *gone = lea_queue_remove_key(&q3, "k_1111111111", &removed);
        CHECK(removed == 3, "rc02-queue-remove-count-3");
        CHECK(gone == &ritems[0] && gone->next == &ritems[2] && gone->next->next == &ritems[3] && gone->next->next->next == NULL,
              "rc02-queue-remove-order-kept");
        CHECK(lea_queue_total(&q3) == 3, "rc02-queue-remove-left-3");
        /* 余下 3 条（全 k2）仍可按原顺序出队 */
        CHECK(lea_queue_dequeue(&q3) == &ritems[4], "rc02-queue-remove-danger-first-left");
        CHECK(lea_queue_dequeue(&q3) == &ritems[1], "rc02-queue-remove-normal-left-1");
        CHECK(lea_queue_dequeue(&q3) == &ritems[5], "rc02-queue-remove-normal-left-2");
        CHECK(lea_queue_dequeue(&q3) == NULL, "rc02-queue-remove-drain-empty");
        /* 空 Key／不存在的 Key／空队列不动 */
        CHECK(lea_queue_remove_key(&q3, "", NULL) == NULL, "rc02-queue-remove-empty-key-null");
        CHECK(lea_queue_remove_key(&q3, "k_9999999999", &removed) == NULL && removed == 0, "rc02-queue-remove-missing-zero");
        CHECK(lea_queue_remove_key(NULL, "k_1111111111", NULL) == NULL, "rc02-queue-remove-null-queue-null");
    }

    /* ---------- H08：内部命令分流只认顶层 "cmd" ---------- */
    {
        char cmd[64] = { 0 };
        CHECK(lea_json_top_level_string("{\"cmd\":\"session.logout\"}", "cmd", cmd, sizeof(cmd)) &&
              strcmp(cmd, "session.logout") == 0, "h08-top-cmd-hit");
        /* params 内嵌套 "cmd" 不得命中（原全文查找会误判进 handle_internal） */
        CHECK(!lea_json_top_level_string(
                  "{\"version\":2,\"command\":\"ui.click\",\"params\":{\"cmd\":\"session.logout\"}}",
                  "cmd", cmd, sizeof(cmd)), "h08-nested-cmd-no-hit");
        CHECK(!lea_json_top_level_string(
                  "{\"request_id\":\"req-1\",\"params\":{\"cmd\":\"session.logout\"}}",
                  "cmd", cmd, sizeof(cmd)), "h08-envelope-nested-cmd-no-hit");
        /* 带空白的顶层 cmd 仍命中 */
        memset(cmd, 0, sizeof(cmd));
        CHECK(lea_json_top_level_string("{ \"cmd\" : \"session.logout\" }", "cmd", cmd, sizeof(cmd)) &&
              strcmp(cmd, "session.logout") == 0, "h08-top-cmd-ws");
        /* 重复顶层 cmd 拒绝（fail-closed） */
        CHECK(!lea_json_top_level_string("{\"cmd\":\"a\",\"cmd\":\"b\"}", "cmd", cmd, sizeof(cmd)),
              "h08-dup-top-cmd-reject");
        /* 顶层 cmd 非字符串拒绝 */
        CHECK(!lea_json_top_level_string("{\"cmd\":123}", "cmd", cmd, sizeof(cmd)),
              "h08-nonstring-cmd-reject");
        /* 转义的顶层 cmd 值正确解码 */
        memset(cmd, 0, sizeof(cmd));
        CHECK(lea_json_top_level_string("{\"cmd\":\"a\\\"b\"}", "cmd", cmd, sizeof(cmd)) &&
              strcmp(cmd, "a\"b") == 0, "h08-top-cmd-escaped");
        /* 顶层 account_id 不被嵌套遮蔽 */
        char acc[128] = { 0 };
        CHECK(lea_json_top_level_string(
                  "{\"x\":{\"account_id\":\"bob\"},\"cmd\":\"session.login_changed\",\"account_id\":\"alice\"}",
                  "account_id", acc, sizeof(acc)) && strcmp(acc, "alice") == 0,
              "h08-top-account-not-shadowed");
    }

    /* ---------- H09：幂等结果截断投毒 ---------- */
    {
        /* 超长结果不得截断成非法 JSON：占位行保留 ok/code/request_id 且合法 */
        static lea_idem_t th;
        lea_idem_init(&th);
        lea_idem_entry_t *e = lea_idem_get_or_create(&th, "node-1", "alice", "k-big", 0, now);
        static char big_resp[20000];
        int bl = snprintf(big_resp, sizeof(big_resp),
                          "{\"ok\":true,\"code\":\"done\",\"request_id\":\"req-big-1\","
                          "\"retryable\":false,\"detail\":\"\",\"result\":{\"output\":\"");
        memset(big_resp + bl, 'x', 12000);
        strcpy(big_resp + bl + 12000, "\"}}");
        lea_idem_set_status(&th, e, LEA_IDEM_SUCCEEDED, big_resp, now);
        CHECK(strstr(e->result, "\"detail\":\"result-truncated\"") != NULL,
              "h09-truncated-placeholder");
        CHECK(strstr(e->result, "\"ok\":true") != NULL, "h09-truncated-keeps-ok");
        CHECK(strstr(e->result, "\"code\":\"done\"") != NULL, "h09-truncated-keeps-code");
        CHECK(strstr(e->result, "\"request_id\":\"req-big-1\"") != NULL,
              "h09-truncated-keeps-request-id");
        CHECK(lea_json_is_valid(e->result), "h09-truncated-placeholder-valid-json");
        /* 占位行可正常 save/load 往返 */
        static char saved_big[65536];
        CHECK(lea_idem_save_text(&th, saved_big, sizeof(saved_big)), "h09-truncated-save");
        static lea_idem_t th_big;
        CHECK(lea_idem_load_text(&th_big, saved_big), "h09-truncated-load");
        lea_idem_entry_t *e_big = lea_idem_lookup(&th_big, "node-1", "alice", "k-big");
        CHECK(e_big && e_big->status == LEA_IDEM_SUCCEEDED &&
              strstr(e_big->result, "result-truncated") != NULL,
              "h09-truncated-roundtrip");
        /* 坏行隔离：坏行跳过，好行保留，不清空整表 */
        static lea_idem_t th2;
        const char *poisoned =
            "{\"device_id\":\"node-1\",\"account_id\":\"alice\",\"key\":\"k-good\",\"status\":\"SUCCEEDED\",\"dangerous\":0,\"created_at\":100,\"updated_at\":100,\"result\":{\"ok\":true}}\n"
            "{\"device_id\":\"node-1\",\"account_id\":\"alice\",\"key\":\"k-bad\",\"status\":\"SUCCEEDED\",\"dangerous\":0,\"created_at\":100,\"updated_at\":100,\"result\":{\"ok\":true,\"output\":\"abc}\n"
            "{\"device_id\":\"node-1\",\"account_id\":\"alice\",\"key\":\"k-good2\",\"status\":\"FAILED\",\"dangerous\":0,\"created_at\":100,\"updated_at\":100,\"result\":null}\n";
        CHECK(lea_idem_load_text(&th2, poisoned), "h09-load-poisoned-ok");
        CHECK(lea_idem_lookup(&th2, "node-1", "alice", "k-good") != NULL,
              "h09-load-keeps-good-before");
        CHECK(lea_idem_lookup(&th2, "node-1", "alice", "k-bad") == NULL,
              "h09-load-skips-bad-line");
        CHECK(lea_idem_lookup(&th2, "node-1", "alice", "k-good2") != NULL,
              "h09-load-keeps-good-after");
        /* save 跳过非法行：手工写一条坏 result 的条目，save 不写毒行 */
        static lea_idem_t th3;
        lea_idem_init(&th3);
        lea_idem_entry_t *eb = lea_idem_get_or_create(&th3, "node-1", "alice", "k-poison", 0, now);
        snprintf(eb->result, sizeof(eb->result), "%s", "{\"ok\":true,\"cut\":");
        eb->status = LEA_IDEM_SUCCEEDED;
        lea_idem_entry_t *eg = lea_idem_get_or_create(&th3, "node-1", "alice", "k-ok", 0, now);
        lea_idem_set_status(&th3, eg, LEA_IDEM_SUCCEEDED, "{\"ok\":true,\"code\":\"done\"}", now);
        static char saved[65536];
        int skipped = -1;
        CHECK(lea_idem_save_text_ex(&th3, saved, sizeof(saved), &skipped), "h09-save-skips-bad");
        CHECK(skipped == 1, "h09-save-skipped-count");
        CHECK(strstr(saved, "k-poison") == NULL, "h09-save-no-poison-line");
        CHECK(strstr(saved, "k-ok") != NULL, "h09-save-keeps-good");
        static lea_idem_t th4;
        CHECK(lea_idem_load_text(&th4, saved), "h09-save-load-roundtrip");
        CHECK(lea_idem_lookup(&th4, "node-1", "alice", "k-ok") != NULL,
              "h09-save-roundtrip-keeps-good");
        CHECK(lea_idem_lookup(&th4, "node-1", "alice", "k-poison") == NULL,
              "h09-save-roundtrip-no-poison");
    }

    /* ---------- H10：队列语义 ---------- */
    {
        char err[64] = { 0 };
        /* 危险 lane 配额：连续 4 条危险后轮转 1 条普通 */
        static lea_queue_t q3;
        lea_queue_init(&q3);
        static lea_queue_item_t d[6], n1;
        memset(d, 0, sizeof(d));
        memset(&n1, 0, sizeof(n1));
        for (int i = 0; i < 6; i++) d[i].dangerous = 1;
        n1.dangerous = 0;
        for (int i = 0; i < 5; i++) lea_queue_enqueue(&q3, &d[i], err, sizeof(err));
        lea_queue_enqueue(&q3, &n1, err, sizeof(err));
        lea_queue_enqueue(&q3, &d[5], err, sizeof(err));
        CHECK(lea_queue_dequeue(&q3) == &d[0], "h10-danger-1");
        CHECK(lea_queue_dequeue(&q3) == &d[1], "h10-danger-2");
        CHECK(lea_queue_dequeue(&q3) == &d[2], "h10-danger-3");
        CHECK(lea_queue_dequeue(&q3) == &d[3], "h10-danger-4");
        CHECK(lea_queue_dequeue(&q3) == &n1, "h10-normal-rotated-after-quota");
        CHECK(lea_queue_dequeue(&q3) == &d[4], "h10-danger-after-rotation");
        CHECK(lea_queue_dequeue(&q3) == &d[5], "h10-danger-last");
        /* 只有危险 lane 时配额不限流 */
        static lea_queue_t q4;
        lea_queue_init(&q4);
        static lea_queue_item_t d2[6];
        memset(d2, 0, sizeof(d2));
        for (int i = 0; i < 6; i++) { d2[i].dangerous = 1; lea_queue_enqueue(&q4, &d2[i], err, sizeof(err)); }
        int got = 0;
        while (lea_queue_dequeue(&q4)) got++;
        CHECK(got == 6, "h10-danger-only-no-starve");
        /* batch seq 单调 */
        static lea_batch_seq_t bs;
        lea_batch_seq_init(&bs);
        long long prev = -99;
        CHECK(lea_batch_seq_check(&bs, "node-1", "alice", "batch-1", 1, now, &prev) && prev == -1,
              "h10-seq-first");
        CHECK(lea_batch_seq_check(&bs, "node-1", "alice", "batch-1", 2, now, &prev) && prev == 1,
              "h10-seq-incr");
        CHECK(!lea_batch_seq_check(&bs, "node-1", "alice", "batch-1", 2, now, NULL),
              "h10-seq-dup-reject");
        CHECK(!lea_batch_seq_check(&bs, "node-1", "alice", "batch-1", 1, now, NULL),
              "h10-seq-reorder-reject");
        CHECK(lea_batch_seq_check(&bs, "node-1", "alice", "batch-1", 3, now, NULL),
              "h10-seq-resume");
        CHECK(lea_batch_seq_check(&bs, "node-1", "alice", "batch-2", 1, now, NULL),
              "h10-seq-other-batch");
        CHECK(!lea_batch_seq_check(&bs, "node-1", "alice", "batch-2", 1, now, NULL),
              "h10-seq-other-batch-dup");
        CHECK(lea_batch_seq_check(&bs, "node-1", "bob", "batch-1", 1, now, NULL),
              "h10-seq-other-account");
        /* 单条 seq 必须为 1 */
        CHECK(lea_batch_seq_check(&bs, "node-1", "alice", "", 1, now, NULL),
              "h10-single-seq-1");
        CHECK(!lea_batch_seq_check(&bs, "node-1", "alice", "", 2, now, NULL),
              "h10-single-seq-2-reject");
        CHECK(!lea_batch_seq_check(&bs, "node-1", "alice", "batch-1", 0, now, NULL),
              "h10-seq-zero-reject");
        /* DS 复查阻塞项：检查通过、入队失败时回滚，否则重试同 seq 被判重复 */
        static lea_batch_seq_t br;
        lea_batch_seq_init(&br);
        long long p1 = -99, p2 = -99;
        CHECK(lea_batch_seq_check(&br, "node-1", "alice", "batch-r", 1, now, &p1) && p1 == -1,
              "h10-rollback-first-prev");
        CHECK(lea_batch_seq_check(&br, "node-1", "alice", "batch-r", 2, now, &p2) && p2 == 1,
              "h10-rollback-second-prev");
        lea_batch_seq_rollback(&br, "node-1", "alice", "batch-r", 2, p2);
        CHECK(lea_batch_seq_check(&br, "node-1", "alice", "batch-r", 2, now, NULL),
              "h10-rollback-retry-same-seq-accepted");
        CHECK(!lea_batch_seq_check(&br, "node-1", "alice", "batch-r", 2, now, NULL),
              "h10-rollback-retry-then-dup-reject");
        /* 回滚新建 batch 删除条目：重试首步仍按新 batch 接受 */
        static lea_batch_seq_t br2;
        lea_batch_seq_init(&br2);
        long long p3 = -99;
        CHECK(lea_batch_seq_check(&br2, "node-1", "alice", "batch-n", 5, now, &p3) && p3 == -1,
              "h10-rollback-newbatch-prev");
        lea_batch_seq_rollback(&br2, "node-1", "alice", "batch-n", 5, p3);
        CHECK(lea_batch_seq_check(&br2, "node-1", "alice", "batch-n", 5, now, NULL),
              "h10-rollback-newbatch-retry-accepted");
        /* 回滚已被更大 seq 推进时不动（不误删后续记录） */
        lea_batch_seq_check(&br2, "node-1", "alice", "batch-n", 6, now, NULL);
        lea_batch_seq_rollback(&br2, "node-1", "alice", "batch-n", 5, -1);
        CHECK(!lea_batch_seq_check(&br2, "node-1", "alice", "batch-n", 6, now, NULL),
              "h10-rollback-superseded-noop");
        /* 单条无记录，回滚是空操作 */
        lea_batch_seq_rollback(&br2, "node-1", "alice", "", 1, -1);
        CHECK(lea_batch_seq_check(&br2, "node-1", "alice", "", 1, now, NULL),
              "h10-rollback-single-noop");
    }

    /* ---------- 审计脱敏 ---------- */
    {
        char red[64];
        lea_redact_key_prefix("qfr_lea_abcdefgh12345678wxyz", red, sizeof(red));
        CHECK_STR_EQ(red, "qfr_lea_...wxyz", "audit-redact-key-prefix");
        CHECK(strstr(red, "abcdefgh") == NULL, "audit-redact-no-middle");
        lea_audit_event_t ev;
        memset(&ev, 0, sizeof(ev));
        ev.event = "execute";
        ev.trace_id = "trace-1";
        ev.request_id = "req-1";
        ev.account_id = "alice";
        ev.device_id = "node-1";
        ev.api_key_id = "key-abc12345";
        ev.key_prefix_redacted = red;
        ev.binding_epoch = 3;
        ev.command = "script.run";
        ev.params_hash = "deadbeef";
        ev.idempotency_key = "idem-1";
        ev.nonce = "nonce-1";
        ev.result = "ok";
        ev.error_code = "";
        ev.duration_ms = 12;
        char line[8192];
        CHECK(lea_audit_format_line(&ev, "2026-11-10T12:00:00+08:00", line, sizeof(line)),
              "audit-format-line");
        CHECK(strstr(line, "\"command\":\"script.run\"") != NULL, "audit-line-has-command");
        CHECK(strstr(line, "\"params_hash\":\"deadbeef\"") != NULL, "audit-line-has-params-hash");
        CHECK(strstr(line, "abcdefgh") == NULL, "audit-line-no-key-material");
        /* 审计文件追加＋滚动清理 */
        const char *dir = "/tmp/lea-audit-test";
        char cmd[256];
        snprintf(cmd, sizeof(cmd), "rm -rf %s && mkdir -p %s", dir, dir);
        int rc = system(cmd);
        CHECK(rc == 0, "audit-test-dir-setup");
        CHECK(lea_audit_append(dir, "2026-11-10", &ev, "2026-11-10T12:00:00+08:00"),
              "audit-append");
        CHECK(lea_audit_append(dir, "2026-09-01", &ev, "2026-09-01T12:00:00+08:00"),
              "audit-append-old");
        CHECK(lea_audit_prune(dir, 30, "2026-11-10") == 1, "audit-prune-30d");
        CHECK(access("/tmp/lea-audit-test/lea-2026-11-10.jsonl", R_OK) == 0,
              "audit-kept-today");
        CHECK(access("/tmp/lea-audit-test/lea-2026-09-01.jsonl", R_OK) != 0,
              "audit-pruned-old");
    }

    /* ---------- 响应构造 ---------- */
    {
        char resp[512];
        CHECK(lea_build_response(resp, sizeof(resp), 1, "done", "req-1", 0, "",
                                 "{\"exit_code\":0}"), "response-build-ok");
        CHECK(strstr(resp, "\"ok\":true") && strstr(resp, "\"code\":\"done\"") &&
              strstr(resp, "\"request_id\":\"req-1\""), "response-fields");
        CHECK(lea_build_response(resp, sizeof(resp), 0, "QFR_LEA_NOT_BOUND", "req-1", 0,
                                 "", NULL), "response-build-error");
        CHECK(strstr(resp, "\"result\":null") != NULL, "response-null-result");
        /* 超大 result 不得溢出：返回 0 而不是写坏缓冲区。 */
        static char big[70000];
        memset(big, 'x', sizeof(big) - 1);
        big[sizeof(big) - 1] = '\0';
        CHECK(!lea_build_response(resp, sizeof(resp), 1, "done", "req-1", 0, "", big),
              "response-oversize-fails-clean");
        /* JSON 转义 */
        char ebuf[256] = { 0 };
        size_t off = 0;
        CHECK(lea_json_escape_into(ebuf, sizeof(ebuf), &off, "a\"b\\c\nd"), "escape-ok");
        CHECK_STR_EQ(ebuf, "a\\\"b\\\\c\\nd", "escape-content");
    }

    /* ---------- 参数提取 ---------- */
    {
        char args[4][512];
        int n = lea_params_string_array("{\"script\":\"x.ps1\",\"args\":[\"-A\",\"b c\"]}",
                                        "args", args, 4);
        CHECK(n == 2 && strcmp(args[0], "-A") == 0 && strcmp(args[1], "b c") == 0,
              "params-args-array");
        CHECK(lea_params_string_array("{\"script\":\"x.ps1\"}", "args", args, 4) == -1,
              "params-args-missing");
        char script[128];
        CHECK(lea_json_string("{\"script\":\"qf-agent-heal.ps1\"}", "script", script, sizeof(script)) &&
              strcmp(script, "qf-agent-heal.ps1") == 0, "params-script-field");
    }

    /* ---------- 规范串 v2（F-02；与 JS 单测同一向量） ---------- */
    {
        /* 信封向量：与 JS test-lea.js §7b 同一输入／同一期望串。
         * F-02：规范串 20 行（v1 的 19 行＋binding_epoch 之后一行
         * grant_epoch；v 未设 job_id／mode／deadline_ms，缺省 ''／''／0，
         * 故末尾追加 "\n\n\n0"）。 */
        static const char *vec_canonical =
            "qfr-lea-envelope-v2\n2\nreq-0000001\nbatch-0001\n1\nnode-1\nalice\n"
            "key-abc12345\n3\n1\nnonce-00001\n1780000000\n1780000060\nidem-key-0001\n"
            "ui.click\n43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777\n5000\n\n\n0";
        lea_envelope_t v;
        memset(&v, 0, sizeof(v));
        v.version = 2;
        snprintf(v.request_id, sizeof(v.request_id), "req-0000001");
        snprintf(v.batch_id, sizeof(v.batch_id), "batch-0001");
        v.seq = 1;
        snprintf(v.device_id, sizeof(v.device_id), "node-1");
        snprintf(v.account_id, sizeof(v.account_id), "alice");
        snprintf(v.api_key_id, sizeof(v.api_key_id), "key-abc12345");
        v.binding_epoch = 3;
        v.grant_epoch = 1;
        snprintf(v.nonce, sizeof(v.nonce), "nonce-00001");
        v.issued_at = 1780000000;
        v.expires_at = 1780000060;
        snprintf(v.idempotency_key, sizeof(v.idempotency_key), "idem-key-0001");
        snprintf(v.command, sizeof(v.command), "ui.click");
        snprintf(v.params_raw, sizeof(v.params_raw), "{\"a\":1,\"b\":2}");
        v.timeout_ms = 5000;
        v.has_timeout = 1;
        char canon[4096];
        CHECK(lea_envelope_canonical(&v, canon, sizeof(canon)), "canonical-envelope-builds");
        CHECK_STR_EQ(canon, vec_canonical, "canonical-envelope-matches-js-vector");
        /* 经解析路径：线上 params 子串即 stable JSON，原文哈希对上。 */
        {
            char wire[2048];
            snprintf(wire, sizeof(wire),
                     "{\"version\":2,\"request_id\":\"req-0000001\",\"batch_id\":\"batch-0001\","
                     "\"seq\":1,\"device_id\":\"node-1\",\"account_id\":\"alice\","
                     "\"api_key_id\":\"key-abc12345\",\"binding_epoch\":3,\"grant_epoch\":1,"
                     "\"nonce\":\"nonce-00001\",\"issued_at\":1780000000,\"expires_at\":1780000060,"
                     "\"idempotency_key\":\"idem-key-0001\",\"command\":\"ui.click\","
                     "\"params\":{\"a\":1,\"b\":2},\"timeout_ms\":5000,"
                     "\"signature\":\"TEST-UNSIGNED\"}");
            lea_envelope_t pv;
            CHECK(lea_parse_envelope(wire, 1780000000, &pv), "canonical-parse-wire-envelope");
            char canon2[4096];
            CHECK(lea_envelope_canonical(&pv, canon2, sizeof(canon2)) &&
                  strcmp(canon2, vec_canonical) == 0, "canonical-parsed-envelope-matches-vector");
        }
        /* 篡改任一覆盖字段即改变规范串（params／account／timeout／seq／batch／grant_epoch）。 */
        {
            lea_envelope_t m = v;
            snprintf(m.params_raw, sizeof(m.params_raw), "{\"a\":1,\"b\":3}");
            char c2[4096];
            CHECK(lea_envelope_canonical(&m, c2, sizeof(c2)) && strcmp(c2, vec_canonical) != 0,
                  "canonical-changes-on-params-tamper");
            m = v;
            snprintf(m.account_id, sizeof(m.account_id), "mallory");
            CHECK(lea_envelope_canonical(&m, c2, sizeof(c2)) && strcmp(c2, vec_canonical) != 0,
                  "canonical-changes-on-account-tamper");
            m = v;
            m.timeout_ms = 6000;
            CHECK(lea_envelope_canonical(&m, c2, sizeof(c2)) && strcmp(c2, vec_canonical) != 0,
                  "canonical-changes-on-timeout-tamper");
            m = v;
            m.seq = 2;
            CHECK(lea_envelope_canonical(&m, c2, sizeof(c2)) && strcmp(c2, vec_canonical) != 0,
                  "canonical-changes-on-seq-tamper");
            m = v;
            m.grant_epoch = 2;
            CHECK(lea_envelope_canonical(&m, c2, sizeof(c2)) && strcmp(c2, vec_canonical) != 0,
                  "canonical-changes-on-grant-epoch-tamper");
            m = v;
            m.batch_id[0] = '\0';
            char c3[4096];
            CHECK(lea_envelope_canonical(&m, c3, sizeof(c3)) &&
                  strstr(c3, "req-0000001\n\n1\nnode-1") != NULL,
                  "canonical-empty-batch-id-is-empty-line");
        }
        /* 缺 timeout_ms 时取命令默认值（script.run 30000）。 */
        {
            lea_envelope_t d = v;
            snprintf(d.command, sizeof(d.command), "script.run");
            d.has_timeout = 0;
            d.timeout_ms = 0;
            char c4[4096];
            CHECK(lea_envelope_canonical(&d, c4, sizeof(c4)) &&
                  strstr(c4, "43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777\n30000") != NULL,
                  "canonical-default-timeout-script-30s");
        }
        /* 非法输入构造失败（fail-closed）。 */
        {
            lea_envelope_t b = v;
            b.version = 1;
            CHECK(!lea_envelope_canonical(&b, canon, sizeof(canon)), "canonical-rejects-version-1");
            b = v;
            b.version = 3;
            CHECK(!lea_envelope_canonical(&b, canon, sizeof(canon)), "canonical-rejects-version-3");
            b = v;
            b.grant_epoch = -1;
            CHECK(!lea_envelope_canonical(&b, canon, sizeof(canon)), "canonical-rejects-grant-epoch-minus-1");
            b = v;
            b.grant_epoch = 9007199254740992LL;
            CHECK(!lea_envelope_canonical(&b, canon, sizeof(canon)), "canonical-rejects-grant-epoch-over-2pow53");
            b = v;
            b.grant_epoch = 9007199254740991LL;
            CHECK(lea_envelope_canonical(&b, canon, sizeof(canon)), "canonical-accepts-grant-epoch-2pow53-minus-1");
            b = v;
            b.grant_epoch = 0;
            CHECK(lea_envelope_canonical(&b, canon, sizeof(canon)), "canonical-accepts-grant-epoch-zero");
            b = v;
            snprintf(b.account_id, sizeof(b.account_id), "a\nb");
            CHECK(!lea_envelope_canonical(&b, canon, sizeof(canon)), "canonical-rejects-newline-in-account");
            CHECK(!lea_envelope_canonical(&v, canon, 64), "canonical-rejects-tiny-buffer");
        }
        /* 票据向量：与 JS test-lea.js §7c 同一输入／同一期望串。 */
        static const char *vec_ticket =
            "qfr-lea-ticket-v1\nalice\nnode-1\n3\n1\n1\nmuse.execute\n"
            "lease-0123456789abcdef\n1780086400";
        char tcanon[1024];
        CHECK(lea_ticket_canonical("alice", "node-1", 3, 1, 1, "muse.execute",
                                   "lease-0123456789abcdef", 1780086400,
                                   tcanon, sizeof(tcanon)),
              "canonical-ticket-builds");
        CHECK_STR_EQ(tcanon, vec_ticket, "canonical-ticket-matches-js-vector");
        CHECK(!lea_ticket_canonical("alice", "node-1", 3, 1, 1,
                                    "muse.execute.dangerous,muse.execute",
                                    "lease-0123456789abcdef", 1780086400,
                                    tcanon, sizeof(tcanon)),
              "canonical-ticket-rejects-unsorted-scopes");
        {
            char t2[1024];
            CHECK(lea_ticket_canonical("alice", "node-1", 3, 1, 0, "muse.execute",
                                       "lease-0123456789abcdef", 1780086400,
                                       t2, sizeof(t2)) && strcmp(t2, vec_ticket) != 0,
                  "canonical-ticket-changes-on-grant-flip");
            CHECK(lea_ticket_canonical("alice", "node-1", 3, 1, 1, "",
                                       "lease-0123456789abcdef", 1780086400,
                                       t2, sizeof(t2)) &&
                  strstr(t2, "1\n\nlease-0123456789abcdef") != NULL,
                  "canonical-ticket-empty-scopes-is-empty-line");
        }
        /* 字段规则。 */
        CHECK(lea_validate_id_field("alice"), "id-field-plain-ok");
        CHECK(lea_validate_id_field("node//test-device-1"), "id-field-slashes-ok");
        CHECK(lea_validate_id_field("al\"ice"), "id-field-quote-allowed-escaped-on-rebuild");
        CHECK(!lea_validate_id_field(""), "id-field-empty-rejected");
        CHECK(!lea_validate_id_field("a\nb"), "id-field-newline-rejected");
        CHECK(!lea_validate_id_field("a\x7f" "b"), "id-field-del-rejected");
        CHECK(lea_validate_scopes_str(""), "scopes-empty-ok");
        CHECK(lea_validate_scopes_str("muse.execute"), "scopes-single-ok");
        CHECK(lea_validate_scopes_str("muse.execute,muse.execute.dangerous"), "scopes-sorted-ok");
        CHECK(!lea_validate_scopes_str("muse.execute.dangerous,muse.execute"), "scopes-unsorted-rejected");
        CHECK(!lea_validate_scopes_str("muse.execute, muse.execute"), "scopes-space-rejected");
        CHECK(!lea_validate_scopes_str("muse.execute,muse.execute"), "scopes-duplicate-rejected");
        CHECK(!lea_validate_scopes_str("muse.execute,"), "scopes-trailing-comma-rejected");
        /* v1：seq 必填且 ≥1；timeout 非法即拒。 */
        {
            char noseq[4096];
            snprintf(noseq, sizeof(noseq),
                     "{\"version\":2,\"request_id\":\"req-0000009\",\"device_id\":\"node-1\","
                     "\"account_id\":\"alice\",\"api_key_id\":\"key-abc12345\","
                     "\"binding_epoch\":3,\"grant_epoch\":1,\"nonce\":\"nonce-00009\",\"issued_at\":%lld,"
                     "\"expires_at\":%lld,\"idempotency_key\":\"idem-key-0009\","
                     "\"command\":\"sys.info\",\"params\":{},\"signature\":\"TEST-UNSIGNED\"}",
                     now, now + 60);
            CHECK(!lea_parse_envelope(noseq, now, &env) &&
                  strcmp(env.error, "QFR_LEA_BAD_ENVELOPE") == 0, "parse-missing-seq-rejected");
            char seq0[4096];
            snprintf(seq0, sizeof(seq0),
                     "{\"version\":2,\"request_id\":\"req-0000010\",\"seq\":0,\"device_id\":\"node-1\","
                     "\"account_id\":\"alice\",\"api_key_id\":\"key-abc12345\","
                     "\"binding_epoch\":3,\"grant_epoch\":1,\"nonce\":\"nonce-00010\",\"issued_at\":%lld,"
                     "\"expires_at\":%lld,\"idempotency_key\":\"idem-key-0010\","
                     "\"command\":\"sys.info\",\"params\":{},\"signature\":\"TEST-UNSIGNED\"}",
                     now, now + 60);
            CHECK(!lea_parse_envelope(seq0, now, &env), "parse-seq-zero-rejected");
            char tmo0[4096];
            snprintf(tmo0, sizeof(tmo0),
                     "{\"version\":2,\"request_id\":\"req-0000011\",\"seq\":1,\"device_id\":\"node-1\","
                     "\"account_id\":\"alice\",\"api_key_id\":\"key-abc12345\","
                     "\"binding_epoch\":3,\"grant_epoch\":1,\"nonce\":\"nonce-00011\",\"issued_at\":%lld,"
                     "\"expires_at\":%lld,\"idempotency_key\":\"idem-key-0011\","
                     "\"command\":\"sys.info\",\"params\":{},\"timeout_ms\":0,"
                     "\"signature\":\"TEST-UNSIGNED\"}", now, now + 60);
            CHECK(!lea_parse_envelope(tmo0, now, &env), "parse-timeout-zero-rejected");
            /* timeout_ms: null 是显式非法值，不得当缺失回退默认。 */
            snprintf(tmo0, sizeof(tmo0),
                     "{\"version\":2,\"request_id\":\"req-0000011\",\"seq\":1,\"device_id\":\"node-1\","
                     "\"account_id\":\"alice\",\"api_key_id\":\"key-abc12345\","
                     "\"binding_epoch\":3,\"grant_epoch\":1,\"nonce\":\"nonce-00011\",\"issued_at\":%lld,"
                     "\"expires_at\":%lld,\"idempotency_key\":\"idem-key-0011\","
                     "\"command\":\"sys.info\",\"params\":{},\"timeout_ms\":null,"
                     "\"signature\":\"TEST-UNSIGNED\"}", now, now + 60);
            CHECK(!lea_parse_envelope(tmo0, now, &env), "parse-timeout-null-rejected");
            /* 嵌套遮蔽：params 含 "timeout_ms":5000 且顶层为 null → 必须拒绝，
             * 不得用全文查找命中嵌套值把顶层 null 洗成 5000。 */
            snprintf(tmo0, sizeof(tmo0),
                     "{\"version\":2,\"request_id\":\"req-0000011\",\"seq\":1,\"device_id\":\"node-1\","
                     "\"account_id\":\"alice\",\"api_key_id\":\"key-abc12345\","
                     "\"binding_epoch\":3,\"grant_epoch\":1,\"nonce\":\"nonce-00011\",\"issued_at\":%lld,"
                     "\"expires_at\":%lld,\"idempotency_key\":\"idem-key-0011\","
                     "\"command\":\"sys.info\",\"params\":{\"timeout_ms\":5000},\"timeout_ms\":null,"
                     "\"signature\":\"TEST-UNSIGNED\"}", now, now + 60);
            CHECK(!lea_parse_envelope(tmo0, now, &env), "parse-timeout-nested-shadow-null-rejected");
            /* 顶层胜出：params 嵌套 6000、顶层 5000 → 解析成功且取顶层值 5000。 */
            snprintf(tmo0, sizeof(tmo0),
                     "{\"version\":2,\"request_id\":\"req-0000011\",\"seq\":1,\"device_id\":\"node-1\","
                     "\"account_id\":\"alice\",\"api_key_id\":\"key-abc12345\","
                     "\"binding_epoch\":3,\"grant_epoch\":1,\"nonce\":\"nonce-00011\",\"issued_at\":%lld,"
                     "\"expires_at\":%lld,\"idempotency_key\":\"idem-key-0011\","
                     "\"command\":\"sys.info\",\"params\":{\"timeout_ms\":6000},\"timeout_ms\":5000,"
                     "\"signature\":\"TEST-UNSIGNED\"}", now, now + 60);
            CHECK(lea_parse_envelope(tmo0, now, &env) && env.has_timeout && env.timeout_ms == 5000,
                  "parse-timeout-top-level-wins-over-nested");
            /* 嵌套不被采纳：顶层缺失、params 嵌套 5000 → has_timeout 为 0，取命令默认值。 */
            snprintf(tmo0, sizeof(tmo0),
                     "{\"version\":2,\"request_id\":\"req-0000011\",\"seq\":1,\"device_id\":\"node-1\","
                     "\"account_id\":\"alice\",\"api_key_id\":\"key-abc12345\","
                     "\"binding_epoch\":3,\"grant_epoch\":1,\"nonce\":\"nonce-00011\",\"issued_at\":%lld,"
                     "\"expires_at\":%lld,\"idempotency_key\":\"idem-key-0011\","
                     "\"command\":\"script.run\",\"params\":{\"timeout_ms\":5000},"
                     "\"signature\":\"TEST-UNSIGNED\"}", now, now + 60);
            CHECK(lea_parse_envelope(tmo0, now, &env) && !env.has_timeout &&
                  lea_effective_timeout_ms(&env) == 30000,
                  "parse-timeout-nested-ignored-when-absent");
            lea_envelope_t s0 = v;
            s0.seq = 0;
            CHECK(!lea_envelope_canonical(&s0, canon, sizeof(canon)), "canonical-rejects-seq-zero");
        }
        /* 票据 grant 严格 0/1；长 scope token（100 字符）两端规则一致。 */
        {
            CHECK(!lea_ticket_canonical("alice", "node-1", 3, 1, 2, "muse.execute",
                                       "lease-0123456789abcdef", 1780086400,
                                       tcanon, sizeof(tcanon)),
                  "canonical-ticket-rejects-grant-2");
            CHECK(!lea_ticket_canonical("alice", "node-1", 3, 1, -1, "muse.execute",
                                       "lease-0123456789abcdef", 1780086400,
                                       tcanon, sizeof(tcanon)),
                  "canonical-ticket-rejects-grant-minus-1");
            char long_scope[128];
            memset(long_scope, 's', 100);
            long_scope[100] = '\0';
            CHECK(lea_validate_scopes_str(long_scope), "scopes-100char-token-ok");
            char t3[1024];
            CHECK(lea_ticket_canonical("alice", "node-1", 3, 1, 1, long_scope,
                                       "lease-0123456789abcdef", 1780086400,
                                       t3, sizeof(t3)) &&
                  strstr(t3, long_scope) != NULL,
                  "canonical-ticket-long-scope-token-ok");
        }
        /* 票据严格解析（lea_parse_ticket，binding.confirm 调用点逻辑）。 */
        {
            lea_ticket_t tk;
            char tj[2048];
            make_ticket(tj, sizeof(tj), NULL, "\"muse.execute\"", "\"lease-0123456789abcdef\"", 0);
            CHECK(lea_parse_ticket(tj, &tk), "parse-ticket-valid");
            CHECK(tk.grant_muse_execute == 1 && strcmp(tk.scopes, "muse.execute") == 0 &&
                  strcmp(tk.lease_id, "lease-0123456789abcdef") == 0 &&
                  tk.expires_at == 1780086400, "parse-ticket-fields");
            /* grant 原值保留：2 可解析，但 canonical 拒绝（调用点不得归一化）。 */
            make_ticket(tj, sizeof(tj), "2", "\"muse.execute\"", "\"lease-0123456789abcdef\"", 0);
            CHECK(lea_parse_ticket(tj, &tk) && tk.grant_muse_execute == 2, "parse-ticket-grant-2-kept-raw");
            CHECK(!lea_ticket_canonical(tk.account_id, tk.device_id, tk.binding_epoch, tk.grant_epoch,
                                        (int)tk.grant_muse_execute, tk.scopes, tk.lease_id, tk.expires_at,
                                        tcanon, sizeof(tcanon)),
                  "parse-ticket-grant-2-canonical-rejects");
            make_ticket(tj, sizeof(tj), "-1", "\"muse.execute\"", "\"lease-0123456789abcdef\"", 0);
            CHECK(lea_parse_ticket(tj, &tk) && tk.grant_muse_execute == -1, "parse-ticket-grant-minus-1-kept-raw");
            CHECK(!lea_ticket_canonical(tk.account_id, tk.device_id, tk.binding_epoch, tk.grant_epoch,
                                        (int)tk.grant_muse_execute, tk.scopes, tk.lease_id, tk.expires_at,
                                        tcanon, sizeof(tcanon)),
                  "parse-ticket-grant-minus-1-canonical-rejects");
            /* grant 布尔 true → 1（解析层接受）；缺失 → 拒绝。 */
            make_ticket(tj, sizeof(tj), "true", "\"muse.execute\"", "\"lease-0123456789abcdef\"", 0);
            CHECK(lea_parse_ticket(tj, &tk) && tk.grant_muse_execute == 1, "parse-ticket-grant-bool-true");
            {
                char no_grant[2048];
                snprintf(no_grant, sizeof(no_grant),
                         "{\"account_id\":\"alice\",\"device_id\":\"node-1\",\"binding_epoch\":3,"
                         "\"grant_epoch\":1,\"scopes\":\"muse.execute\","
                         "\"lease_id\":\"lease-0123456789abcdef\",\"expires_at\":1780086400,"
                         "\"ticket_signature\":\"TEST-UNSIGNED\"}");
                CHECK(!lea_parse_ticket(no_grant, &tk), "parse-ticket-grant-missing-rejected");
            }
            /* scopes 数组／对象 → 拒绝（不得当空串处理，签名不得继续通过）。 */
            make_ticket(tj, sizeof(tj), "1", "[\"muse.execute\"]", "\"lease-0123456789abcdef\"", 0);
            CHECK(!lea_parse_ticket(tj, &tk), "parse-ticket-scopes-array-rejected");
            make_ticket(tj, sizeof(tj), "1", "{\"x\":1}", "\"lease-0123456789abcdef\"", 0);
            CHECK(!lea_parse_ticket(tj, &tk), "parse-ticket-scopes-object-rejected");
            /* scopes 缺失 → 按空串；未排序 → 拒绝。 */
            make_ticket(tj, sizeof(tj), "1", NULL, "\"lease-0123456789abcdef\"", 0);
            CHECK(lea_parse_ticket(tj, &tk) && tk.scopes[0] == '\0', "parse-ticket-scopes-missing-is-empty");
            make_ticket(tj, sizeof(tj), "1", "\"muse.execute.dangerous,muse.execute\"", "\"lease-0123456789abcdef\"", 0);
            CHECK(!lea_parse_ticket(tj, &tk), "parse-ticket-scopes-unsorted-rejected");
            /* scopes 257 字节超限 → 拒绝；256 字节通过（v1 上限）。 */
            {
                char long_scopes[300];
                memset(long_scopes, 's', 257);
                long_scopes[257] = '\0';
                char scopes_json[320];
                snprintf(scopes_json, sizeof(scopes_json), "\"%s\"", long_scopes);
                make_ticket(tj, sizeof(tj), "1", scopes_json, "\"lease-0123456789abcdef\"", 0);
                CHECK(!lea_parse_ticket(tj, &tk), "parse-ticket-scopes-257-rejected");
                memset(long_scopes, 's', 256);
                long_scopes[256] = '\0';
                snprintf(scopes_json, sizeof(scopes_json), "\"%s\"", long_scopes);
                make_ticket(tj, sizeof(tj), "1", scopes_json, "\"lease-0123456789abcdef\"", 0);
                CHECK(lea_parse_ticket(tj, &tk), "parse-ticket-scopes-256-ok");
            }
            /* lease 200 字符超限 → 拒绝；lease 缺失 → 按空串。 */
            {
                char long_lease[220];
                memset(long_lease, 'a', 200);
                long_lease[200] = '\0';
                char lease_json[240];
                snprintf(lease_json, sizeof(lease_json), "\"%s\"", long_lease);
                make_ticket(tj, sizeof(tj), "1", "\"muse.execute\"", lease_json, 0);
                CHECK(!lea_parse_ticket(tj, &tk), "parse-ticket-lease-200-rejected");
                make_ticket(tj, sizeof(tj), "1", "\"muse.execute\"", NULL, 0);
                CHECK(lea_parse_ticket(tj, &tk) && tk.lease_id[0] == '\0', "parse-ticket-lease-missing-is-empty");
            }
            /* 其余必填字段缺失 → 拒绝。 */
            make_ticket(tj, sizeof(tj), "1", "\"muse.execute\"", "\"lease-0123456789abcdef\"", 1);
            CHECK(!lea_parse_ticket(tj, &tk), "parse-ticket-expires-missing-rejected");
            {
                char no_sig[2048];
                snprintf(no_sig, sizeof(no_sig),
                         "{\"account_id\":\"alice\",\"device_id\":\"node-1\",\"binding_epoch\":3,"
                         "\"grant_epoch\":1,\"grant_muse_execute\":1,\"scopes\":\"muse.execute\","
                         "\"lease_id\":\"lease-0123456789abcdef\",\"expires_at\":1780086400}");
                CHECK(!lea_parse_ticket(no_sig, &tk), "parse-ticket-signature-missing-rejected");
            }
            /* 完整 JSON 成员解析：空白变体／重复键／\u 转义／类型与溢出。 */
            {
                /* "scopes"\r:[...]：\r 为合法 JSON 空白，须识别为存在并拒绝。 */
                char ws[2048];
                snprintf(ws, sizeof(ws),
                         "{\"account_id\":\"alice\",\"device_id\":\"node-1\",\"binding_epoch\":3,"
                         "\"grant_epoch\":1,\"grant_muse_execute\":1,\"scopes\"\r:[\"muse.execute\"],"
                         "\"lease_id\":\"lease-0123456789abcdef\",\"expires_at\":1780086400,"
                         "\"ticket_signature\":\"TEST-UNSIGNED\"}");
                CHECK(!lea_parse_ticket(ws, &tk), "parse-ticket-scopes-cr-ws-array-rejected");
                /* "scopes" : "..."（冒号两侧空白）为合法 JSON，须正常解析。 */
                snprintf(ws, sizeof(ws),
                         "{\"account_id\" : \"alice\", \"device_id\" : \"node-1\", \"binding_epoch\" : 3,"
                         "\"grant_epoch\" : 1, \"grant_muse_execute\" : 1, \"scopes\" : \"muse.execute\","
                         "\"lease_id\" : \"lease-0123456789abcdef\", \"expires_at\" : 1780086400,"
                         "\"ticket_signature\" : \"TEST-UNSIGNED\"}");
                CHECK(lea_parse_ticket(ws, &tk) && strcmp(tk.scopes, "muse.execute") == 0,
                      "parse-ticket-ws-around-colon-ok");
                /* 重复 scopes 键 → 拒绝；重复 grant 键 → 拒绝。 */
                snprintf(ws, sizeof(ws),
                         "{\"account_id\":\"alice\",\"device_id\":\"node-1\",\"binding_epoch\":3,"
                         "\"grant_epoch\":1,\"grant_muse_execute\":1,\"scopes\":\"muse.execute\","
                         "\"scopes\":\"\",\"lease_id\":\"lease-0123456789abcdef\",\"expires_at\":1780086400,"
                         "\"ticket_signature\":\"TEST-UNSIGNED\"}");
                CHECK(!lea_parse_ticket(ws, &tk), "parse-ticket-dup-scopes-rejected");
                snprintf(ws, sizeof(ws),
                         "{\"account_id\":\"alice\",\"device_id\":\"node-1\",\"binding_epoch\":3,"
                         "\"grant_epoch\":1,\"grant_muse_execute\":1,\"grant_muse_execute\":0,"
                         "\"scopes\":\"muse.execute\",\"lease_id\":\"lease-0123456789abcdef\","
                         "\"expires_at\":1780086400,\"ticket_signature\":\"TEST-UNSIGNED\"}");
                CHECK(!lea_parse_ticket(ws, &tk), "parse-ticket-dup-grant-rejected");
                /* \u 转义解码：\u0061lice → alice；代理对 → UTF-8。 */
                snprintf(ws, sizeof(ws),
                         "{\"account_id\":\"\\u0061lice\",\"device_id\":\"node-1\",\"binding_epoch\":3,"
                         "\"grant_epoch\":1,\"grant_muse_execute\":1,\"scopes\":\"muse.execute\","
                         "\"lease_id\":\"lease-0123456789abcdef\",\"expires_at\":1780086400,"
                         "\"ticket_signature\":\"TEST-UNSIGNED\"}");
                CHECK(lea_parse_ticket(ws, &tk) && strcmp(tk.account_id, "alice") == 0,
                      "parse-ticket-unicode-escape-ok");
                snprintf(ws, sizeof(ws),
                         "{\"account_id\":\"\\uD83D\\uDE00alice\",\"device_id\":\"node-1\",\"binding_epoch\":3,"
                         "\"grant_epoch\":1,\"grant_muse_execute\":1,\"scopes\":\"muse.execute\","
                         "\"lease_id\":\"lease-0123456789abcdef\",\"expires_at\":1780086400,"
                         "\"ticket_signature\":\"TEST-UNSIGNED\"}");
                CHECK(lea_parse_ticket(ws, &tk) &&
                      strcmp(tk.account_id, "\xF0\x9F\x98\x80" "alice") == 0,
                      "parse-ticket-surrogate-pair-ok");
                /* grant 1.5（小数）→ 拒绝；binding_epoch 字符串 → 拒绝；尾巴 → 拒绝。 */
                make_ticket(tj, sizeof(tj), "1.5", "\"muse.execute\"", "\"lease-0123456789abcdef\"", 0);
                CHECK(!lea_parse_ticket(tj, &tk), "parse-ticket-grant-float-rejected");
                snprintf(ws, sizeof(ws),
                         "{\"account_id\":\"alice\",\"device_id\":\"node-1\",\"binding_epoch\":\"3\","
                         "\"grant_epoch\":1,\"grant_muse_execute\":1,\"scopes\":\"muse.execute\","
                         "\"lease_id\":\"lease-0123456789abcdef\",\"expires_at\":1780086400,"
                         "\"ticket_signature\":\"TEST-UNSIGNED\"}");
                CHECK(!lea_parse_ticket(ws, &tk), "parse-ticket-epoch-string-rejected");
                make_ticket(tj, sizeof(tj), "1", "\"muse.execute\"", "\"lease-0123456789abcdef\"", 0);
                strncat(tj, " trailing", sizeof(tj) - strlen(tj) - 1);
                CHECK(!lea_parse_ticket(tj, &tk), "parse-ticket-trailing-garbage-rejected");
            }
            /* 转义键与 \u0000：键须解码后比较，解码出的控制字符即拒绝。 */
            {
                char esc[2048];
                /* "sc\u006fpes" 解码后即 scopes，数组值须拒绝（不得当缺失）。 */
                snprintf(esc, sizeof(esc),
                         "{\"account_id\":\"alice\",\"device_id\":\"node-1\",\"binding_epoch\":3,"
                         "\"grant_epoch\":1,\"grant_muse_execute\":1,\"sc\\u006fpes\":[\"muse.execute\"],"
                         "\"lease_id\":\"lease-0123456789abcdef\",\"expires_at\":1780086400,"
                         "\"ticket_signature\":\"TEST-UNSIGNED\"}");
                CHECK(!lea_parse_ticket(esc, &tk), "parse-ticket-escaped-key-scopes-array-rejected");
                /* 键本身用 \u 转义（\u0061ccount_id → account_id）须正常解析。 */
                snprintf(esc, sizeof(esc),
                         "{\"\\u0061ccount_id\":\"alice\",\"device_id\":\"node-1\",\"binding_epoch\":3,"
                         "\"grant_epoch\":1,\"grant_muse_execute\":1,\"scopes\":\"muse.execute\","
                         "\"lease_id\":\"lease-0123456789abcdef\",\"expires_at\":1780086400,"
                         "\"ticket_signature\":\"TEST-UNSIGNED\"}");
                CHECK(lea_parse_ticket(esc, &tk) && strcmp(tk.account_id, "alice") == 0,
                      "parse-ticket-escaped-key-ok");
                /* account 含 \u0000 → 解码即拒绝（不得截断成 alice 通过）。 */
                snprintf(esc, sizeof(esc),
                         "{\"account_id\":\"alice\\u0000evil\",\"device_id\":\"node-1\",\"binding_epoch\":3,"
                         "\"grant_epoch\":1,\"grant_muse_execute\":1,\"scopes\":\"muse.execute\","
                         "\"lease_id\":\"lease-0123456789abcdef\",\"expires_at\":1780086400,"
                         "\"ticket_signature\":\"TEST-UNSIGNED\"}");
                CHECK(!lea_parse_ticket(esc, &tk), "parse-ticket-nul-escape-rejected");
                /* account 含 \n 转义 → 解码出的控制字符即拒绝。 */
                snprintf(esc, sizeof(esc),
                         "{\"account_id\":\"al\\nice\",\"device_id\":\"node-1\",\"binding_epoch\":3,"
                         "\"grant_epoch\":1,\"grant_muse_execute\":1,\"scopes\":\"muse.execute\","
                         "\"lease_id\":\"lease-0123456789abcdef\",\"expires_at\":1780086400,"
                         "\"ticket_signature\":\"TEST-UNSIGNED\"}");
                CHECK(!lea_parse_ticket(esc, &tk), "parse-ticket-newline-escape-rejected");
            }
            /* grant 4294967297：解析保留原值（long long），canonical 拒绝
             *（旧 (int) 窄化会截成 1 而通过）。 */
            make_ticket(tj, sizeof(tj), "4294967297", "\"muse.execute\"", "\"lease-0123456789abcdef\"", 0);
            CHECK(lea_parse_ticket(tj, &tk) && tk.grant_muse_execute == 4294967297LL,
                  "parse-ticket-grant-big-kept-raw");
            CHECK(!lea_ticket_canonical(tk.account_id, tk.device_id, tk.binding_epoch, tk.grant_epoch,
                                        tk.grant_muse_execute, tk.scopes, tk.lease_id, tk.expires_at,
                                        tcanon, sizeof(tcanon)),
                  "parse-ticket-grant-big-canonical-rejects");
        }
        /* seq 全程 64 位：4294967297 不得截成 1；超 long long 即拒绝。 */
        {
            char bigseq[4096];
            snprintf(bigseq, sizeof(bigseq),
                     "{\"version\":2,\"request_id\":\"req-0000012\",\"seq\":4294967297,\"device_id\":\"node-1\","
                     "\"account_id\":\"alice\",\"api_key_id\":\"key-abc12345\","
                     "\"binding_epoch\":3,\"grant_epoch\":1,\"nonce\":\"nonce-00012\",\"issued_at\":%lld,"
                     "\"expires_at\":%lld,\"idempotency_key\":\"idem-key-0012\","
                     "\"command\":\"sys.info\",\"params\":{},\"signature\":\"TEST-UNSIGNED\"}",
                     now, now + 60);
            lea_envelope_t be;
            CHECK(lea_parse_envelope(bigseq, now, &be) && be.seq == 4294967297LL,
                  "parse-seq-4294967297-kept");
            char c5[4096];
            CHECK(lea_envelope_canonical(&be, c5, sizeof(c5)) &&
                  strstr(c5, "\n4294967297\n") != NULL,
                  "canonical-seq-4294967297-not-truncated");
            char ovf[4096];
            snprintf(ovf, sizeof(ovf),
                     "{\"version\":2,\"request_id\":\"req-0000013\",\"seq\":9999999999999999999999,\"device_id\":\"node-1\","
                     "\"account_id\":\"alice\",\"api_key_id\":\"key-abc12345\","
                     "\"binding_epoch\":3,\"grant_epoch\":1,\"nonce\":\"nonce-00013\",\"issued_at\":%lld,"
                     "\"expires_at\":%lld,\"idempotency_key\":\"idem-key-0013\","
                     "\"command\":\"sys.info\",\"params\":{},\"signature\":\"TEST-UNSIGNED\"}",
                     now, now + 60);
            CHECK(!lea_parse_envelope(ovf, now, &be), "parse-seq-overflow-rejected");
        }
        /* 解析层：含 DEL 的 account_id 拒绝。 */
        {
            char bad[4096];
            snprintf(bad, sizeof(bad),
                     "{\"version\":2,\"request_id\":\"req-0000008\",\"seq\":1,\"device_id\":\"node-1\","
                     "\"account_id\":\"al\x7f" "ice\",\"api_key_id\":\"key-abc12345\","
                     "\"binding_epoch\":3,\"grant_epoch\":1,\"nonce\":\"nonce-00008\",\"issued_at\":%lld,"
                     "\"expires_at\":%lld,\"idempotency_key\":\"idem-key-0008\","
                     "\"command\":\"sys.info\",\"params\":{},\"signature\":\"TEST-UNSIGNED\"}",
                     now, now + 60);
            CHECK(!lea_parse_envelope(bad, now, &env), "parse-del-in-account-rejected");
        }
    }

    /* ---------- 信封重建转义（pkg1 #25） ---------- */
    {
        lea_envelope_t e;
        memset(&e, 0, sizeof(e));
        e.version = 2;
        snprintf(e.request_id, sizeof(e.request_id), "req-0000009");
        snprintf(e.batch_id, sizeof(e.batch_id), "batch-0001");
        e.seq = 1;
        snprintf(e.device_id, sizeof(e.device_id), "no\\de-1");
        snprintf(e.account_id, sizeof(e.account_id), "al\"ice");
        snprintf(e.api_key_id, sizeof(e.api_key_id), "key-abc12345");
        e.binding_epoch = 3;
        e.grant_epoch = 1;
        snprintf(e.nonce, sizeof(e.nonce), "nonce-00009");
        e.issued_at = now;
        e.expires_at = now + 60;
        snprintf(e.idempotency_key, sizeof(e.idempotency_key), "idem-key-0009");
        snprintf(e.command, sizeof(e.command), "ui.click");
        snprintf(e.params_raw, sizeof(e.params_raw), "{\"text\":\"a\\\"b\"}");
        e.timeout_ms = 5000;
        e.has_timeout = 1;
        snprintf(e.signature, sizeof(e.signature), "TEST-UNSIGNED");
        char line[8192];
        CHECK(lea_rebuild_envelope(&e, line, sizeof(line)), "rebuild-escapes-builds");
        CHECK(strstr(line, "\"account_id\":\"al\\\"ice\"") != NULL, "rebuild-escapes-quote");
        CHECK(strstr(line, "\"device_id\":\"no\\\\de-1\"") != NULL, "rebuild-escapes-backslash");
        CHECK(strstr(line, "\"params\":{\"text\":\"a\\\"b\"}") != NULL, "rebuild-params-verbatim");
        /* F-02：重建行含 version 2 与 grant_epoch。 */
        CHECK(strstr(line, "\"version\":2") != NULL, "rebuild-has-version-2");
        CHECK(strstr(line, "\"grant_epoch\":1") != NULL, "rebuild-has-grant-epoch");
        /* 重建行可再解析，且字段原样回来（无注入、无断裂）。 */
        lea_envelope_t back;
        CHECK(lea_parse_envelope(line, now, &back), "rebuild-line-reparses");
        CHECK(back.version == 2 && back.grant_epoch == 1, "rebuild-version-grant-epoch-roundtrip");
        CHECK(strcmp(back.account_id, "al\"ice") == 0 &&
              strcmp(back.device_id, "no\\de-1") == 0, "rebuild-fields-roundtrip");
        CHECK(strcmp(back.params_raw, "{\"text\":\"a\\\"b\"}") == 0, "rebuild-params-roundtrip");
        /* 注入形态：account 含 "command" 片段时，转义后的引号破坏了
         * "command":" 的字面形态，解析出的 command 仍是原命令，不被改写。 */
        snprintf(e.account_id, sizeof(e.account_id), "x\",\"command\":\"script.run");
        CHECK(lea_rebuild_envelope(&e, line, sizeof(line)), "rebuild-injection-shape-builds");
        CHECK(lea_parse_envelope(line, now, &back) &&
              strcmp(back.command, "ui.click") == 0 &&
              strcmp(back.account_id, "x\",\"command\":\"script.run") == 0,
              "rebuild-injection-shape-contained");
        /* 全部字符串字段转义（#25 全覆盖）：request_id／nonce／idempotency_key
         * 含引号时输出为转义形态（不做解析回绕——其须合 token 规则）。 */
        {
            lea_envelope_t f;
            memset(&f, 0, sizeof(f));
            f.version = 2;
            snprintf(f.request_id, sizeof(f.request_id), "req-\"000010\"");
            f.seq = 1;
            snprintf(f.device_id, sizeof(f.device_id), "node-1");
            snprintf(f.account_id, sizeof(f.account_id), "alice");
            snprintf(f.api_key_id, sizeof(f.api_key_id), "key-abc12345");
            f.binding_epoch = 3;
            f.grant_epoch = 1;
            snprintf(f.nonce, sizeof(f.nonce), "non\"ce-00010");
            f.issued_at = now;
            f.expires_at = now + 60;
            snprintf(f.idempotency_key, sizeof(f.idempotency_key), "idem-\"key-0010\"");
            snprintf(f.command, sizeof(f.command), "ui.click");
            snprintf(f.params_raw, sizeof(f.params_raw), "{}");
            f.timeout_ms = 5000;
            f.has_timeout = 1;
            char line2[8192];
            CHECK(lea_rebuild_envelope(&f, line2, sizeof(line2)), "rebuild-token-fields-escaped-builds");
            CHECK(strstr(line2, "\"request_id\":\"req-\\\"000010\\\"\"") != NULL, "rebuild-escapes-request-id");
            CHECK(strstr(line2, "\"nonce\":\"non\\\"ce-00010\"") != NULL, "rebuild-escapes-nonce");
            CHECK(strstr(line2, "\"idempotency_key\":\"idem-\\\"key-0010\\\"\"") != NULL, "rebuild-escapes-idempotency-key");
        }
        /* batch／device／account／api_key／signature 含引号与反斜杠时重建后
         * 解析回原值（往返原样）。 */
        {
            lea_envelope_t f2;
            memset(&f2, 0, sizeof(f2));
            f2.version = 2;
            snprintf(f2.request_id, sizeof(f2.request_id), "req-0000010");
            snprintf(f2.batch_id, sizeof(f2.batch_id), "ba\"tch\\-0001");
            f2.seq = 1;
            snprintf(f2.device_id, sizeof(f2.device_id), "no\"de\\-1");
            snprintf(f2.account_id, sizeof(f2.account_id), "al\"ice\\x");
            snprintf(f2.api_key_id, sizeof(f2.api_key_id), "key-\"abc");
            f2.binding_epoch = 3;
            f2.grant_epoch = 1;
            snprintf(f2.nonce, sizeof(f2.nonce), "nonce-00010");
            f2.issued_at = now;
            f2.expires_at = now + 60;
            snprintf(f2.idempotency_key, sizeof(f2.idempotency_key), "idem-key-0010");
            snprintf(f2.command, sizeof(f2.command), "ui.click");
            snprintf(f2.params_raw, sizeof(f2.params_raw), "{}");
            f2.timeout_ms = 5000;
            f2.has_timeout = 1;
            snprintf(f2.signature, sizeof(f2.signature), "SIG\"N");
            char line3[8192];
            CHECK(lea_rebuild_envelope(&f2, line3, sizeof(line3)), "rebuild-id-fields-escaped-builds");
            CHECK(strstr(line3, "\"signature\":\"SIG\\\"N\"") != NULL, "rebuild-escapes-signature");
            lea_envelope_t back2;
            CHECK(lea_parse_envelope(line3, now, &back2), "rebuild-id-fields-reparses");
            CHECK(strcmp(back2.batch_id, "ba\"tch\\-0001") == 0 &&
                  strcmp(back2.device_id, "no\"de\\-1") == 0 &&
                  strcmp(back2.account_id, "al\"ice\\x") == 0 &&
                  strcmp(back2.api_key_id, "key-\"abc") == 0 &&
                  strcmp(back2.signature, "SIG\"N") == 0,
                  "rebuild-id-fields-roundtrip");
        }
        /* params_raw 非法即拒（不输出非法 JSON）。 */
        {
            lea_envelope_t g = e;
            snprintf(g.params_raw, sizeof(g.params_raw), "not-json");
            CHECK(!lea_rebuild_envelope(&g, line, sizeof(line)), "rebuild-rejects-non-json-params");
            snprintf(g.params_raw, sizeof(g.params_raw), "{\"a\":1} trailing");
            CHECK(!lea_rebuild_envelope(&g, line, sizeof(line)), "rebuild-rejects-trailing-params");
            snprintf(g.params_raw, sizeof(g.params_raw), "{\"a\":\"unterminated}");
            CHECK(!lea_rebuild_envelope(&g, line, sizeof(line)), "rebuild-rejects-unterminated-params");
            /* 严格 JSON 对象校验：只做花括号配平不算校验，下列非法原文须拒。 */
            snprintf(g.params_raw, sizeof(g.params_raw), "{a:1}");
            CHECK(!lea_rebuild_envelope(&g, line, sizeof(line)), "rebuild-rejects-unquoted-key");
            snprintf(g.params_raw, sizeof(g.params_raw), "{\"a\":1,}");
            CHECK(!lea_rebuild_envelope(&g, line, sizeof(line)), "rebuild-rejects-trailing-comma");
            snprintf(g.params_raw, sizeof(g.params_raw), "{\"a\":01}");
            CHECK(!lea_rebuild_envelope(&g, line, sizeof(line)), "rebuild-rejects-leading-zero");
            snprintf(g.params_raw, sizeof(g.params_raw), "{\"a\":\"x\\q\"}");
            CHECK(!lea_rebuild_envelope(&g, line, sizeof(line)), "rebuild-rejects-bad-escape");
            snprintf(g.params_raw, sizeof(g.params_raw), "{\"a\":1e}");
            CHECK(!lea_rebuild_envelope(&g, line, sizeof(line)), "rebuild-rejects-bad-exponent");
            snprintf(g.params_raw, sizeof(g.params_raw), "{\"a\":\"\\u12\"}");
            CHECK(!lea_rebuild_envelope(&g, line, sizeof(line)), "rebuild-rejects-short-unicode-escape");
            snprintf(g.params_raw, sizeof(g.params_raw), "{\"a\":tru}");
            CHECK(!lea_rebuild_envelope(&g, line, sizeof(line)), "rebuild-rejects-bad-literal");
            snprintf(g.params_raw, sizeof(g.params_raw), "{\"a\":1} {\"b\":2}");
            CHECK(!lea_rebuild_envelope(&g, line, sizeof(line)), "rebuild-rejects-second-object");
            /* 合法嵌套（对象／数组／转义／unicode／指数）须通过。 */
            snprintf(g.params_raw, sizeof(g.params_raw), "{\"a\":[1,{\"b\":null}],\"c\":true,\"d\":\"\\u0041\\n\",\"e\":1.5e-3}");
            CHECK(lea_rebuild_envelope(&g, line, sizeof(line)), "rebuild-accepts-strict-nested-json");
            snprintf(g.params_raw, sizeof(g.params_raw), "{ }");
            CHECK(lea_rebuild_envelope(&g, line, sizeof(line)), "rebuild-accepts-empty-object-ws");
        }
        /* 缓冲不足返回 0，不输出截断 JSON。 */
        char tiny[64];
        CHECK(!lea_rebuild_envelope(&e, tiny, sizeof(tiny)), "rebuild-tiny-buffer-fails-clean");
    }

    /* ---------- #22 params：缺失为空对象、长参数保留、超长／非法明确拒绝 ---------- */
    {
        char *big = (char *)malloc(70000);
        CHECK(big != NULL, "m22-alloc");
        if (big) {
            /* 缺失 params → {}。 */
            {
                char env2[2048];
                snprintf(env2, sizeof(env2),
                    "{\"version\":2,\"request_id\":\"req-m22a01\",\"batch_id\":\"batch-0001\","
                    "\"seq\":1,\"device_id\":\"node-1\",\"account_id\":\"alice\","
                    "\"api_key_id\":\"key-abc12345\",\"binding_epoch\":3,\"grant_epoch\":1,\"nonce\":\"nonce-m22a01\","
                    "\"issued_at\":%lld,\"expires_at\":%lld,\"idempotency_key\":\"idem-m22a01\","
                    "\"command\":\"sys.info\",\"timeout_ms\":5000,\"signature\":\"TEST-UNSIGNED\"}",
                    now, now + 60);
                lea_envelope_t e2;
                CHECK(lea_parse_envelope(env2, now, &e2) && strcmp(e2.params_raw, "{}") == 0,
                      "m22-params-missing-is-empty-object");
            }
            /* 约 20KB 合法 params（> 旧 8192 上限）须完整保留。 */
            {
                char pad[20000];
                memset(pad, 'a', sizeof(pad) - 1);
                pad[sizeof(pad) - 1] = '\0';
                int n = snprintf(big, 70000,
                    "{\"version\":2,\"request_id\":\"req-m22b01\",\"batch_id\":\"batch-0001\","
                    "\"seq\":1,\"device_id\":\"node-1\",\"account_id\":\"alice\","
                    "\"api_key_id\":\"key-abc12345\",\"binding_epoch\":3,\"grant_epoch\":1,\"nonce\":\"nonce-m22b01\","
                    "\"issued_at\":%lld,\"expires_at\":%lld,\"idempotency_key\":\"idem-m22b01\","
                    "\"command\":\"sys.info\",\"params\":{\"pad\":\"%s\"},"
                    "\"timeout_ms\":5000,\"signature\":\"TEST-UNSIGNED\"}",
                    now, now + 60, pad);
                CHECK(n > 0 && n < 70000, "m22-big-built");
                lea_envelope_t e2;
                CHECK(lea_parse_envelope(big, now, &e2) && strlen(e2.params_raw) > 8192,
                      "m22-params-20k-preserved");
            }
            /* 约 40KB params（> 32768 上限）须明确拒绝，不得静默置 {}。 */
            {
                char pad[40000];
                memset(pad, 'b', sizeof(pad) - 1);
                pad[sizeof(pad) - 1] = '\0';
                int n = snprintf(big, 70000,
                    "{\"version\":2,\"request_id\":\"req-m22c01\",\"batch_id\":\"batch-0001\","
                    "\"seq\":1,\"device_id\":\"node-1\",\"account_id\":\"alice\","
                    "\"api_key_id\":\"key-abc12345\",\"binding_epoch\":3,\"grant_epoch\":1,\"nonce\":\"nonce-m22c01\","
                    "\"issued_at\":%lld,\"expires_at\":%lld,\"idempotency_key\":\"idem-m22c01\","
                    "\"command\":\"sys.info\",\"params\":{\"pad\":\"%s\"},"
                    "\"timeout_ms\":5000,\"signature\":\"TEST-UNSIGNED\"}",
                    now, now + 60, pad);
                CHECK(n > 0 && n < 70000, "m22-oversize-built");
                lea_envelope_t e2;
                CHECK(!lea_parse_envelope(big, now, &e2) &&
                      strcmp(e2.error, LEA_ERR_BAD_ENVELOPE) == 0 &&
                      strcmp(e2.error_detail, "params-oversize-or-invalid") == 0,
                      "m22-params-40k-rejected");
            }
            /* params 非对象（字符串／数组）须拒绝。 */
            {
                lea_envelope_t e2;
                make_envelope(env_buf, sizeof(env_buf), now, "sys.info", "\"x\"",
                              3, "node-1", "alice", "idem-m22d01", "nonce-m22d01",
                              "req-m22d01", "TEST-UNSIGNED");
                CHECK(!lea_parse_envelope(env_buf, now, &e2), "m22-params-string-rejected");
                make_envelope(env_buf, sizeof(env_buf), now, "sys.info", "[1,2]",
                              3, "node-1", "alice", "idem-m22d02", "nonce-m22d02",
                              "req-m22d02", "TEST-UNSIGNED");
                CHECK(!lea_parse_envelope(env_buf, now, &e2), "m22-params-array-rejected");
            }
        }
        free(big);
    }

    /* ---------- #17 吊销写入方＋顶层字符串数组 ---------- */
    {
        char ids[8][129];
        int n = lea_json_top_level_string_array(
            "{\"cmd\":\"keys.sync-revoked\",\"key_ids\":[\"k_abc1234567\",\"k_xyz1234567\"]}",
            "key_ids", ids, 8);
        CHECK(n == 2 && strcmp(ids[0], "k_abc1234567") == 0 && strcmp(ids[1], "k_xyz1234567") == 0,
              "m17-top-array");
        CHECK(lea_json_top_level_string_array(
            "{\"cmd\":\"keys.sync-revoked\",\"key_ids\":[]}", "key_ids", ids, 8) == 0,
            "m17-top-array-empty");
        CHECK(lea_json_top_level_string_array(
            "{\"cmd\":\"keys.sync-revoked\"}", "key_ids", ids, 8) == -1,
            "m17-top-array-missing");
        CHECK(lea_json_top_level_string_array(
            "{\"cmd\":\"keys.sync-revoked\",\"key_ids\":\"k_abc1234567\"}", "key_ids", ids, 8) == -1,
            "m17-top-array-not-array");
        CHECK(lea_json_top_level_string_array(
            "{\"cmd\":\"keys.sync-revoked\",\"key_ids\":[\"k_abc1234567\",123]}", "key_ids", ids, 8) == -1,
            "m17-top-array-nonstring-elem");
        /* 嵌套在 params 里的同名键不得命中顶层。 */
        CHECK(lea_json_top_level_string_array(
            "{\"cmd\":\"x\",\"params\":{\"key_ids\":[\"k_abc1234567\"]}}", "key_ids", ids, 8) == -1,
            "m17-top-array-nested-not-matched");
        /* 转义元素解码。 */
        n = lea_json_top_level_string_array(
            "{\"key_ids\":[\"k_a\\\"b\"]}", "key_ids", ids, 8);
        CHECK(n == 1 && strcmp(ids[0], "k_a\"b") == 0, "m17-top-array-escaped");
        /* lea_revoked_write：排序＋去重＋全量替换；非法 id 整单拒绝。 */
        const char *path = "/tmp/m17-revoked.txt";
        remove(path);
        const char *set1[] = { "k_bbb2222222", "k_aaa1111111", "k_bbb2222222" };
        CHECK(lea_revoked_write(path, set1, 3), "m17-revoked-write");
        {
            FILE *f = fopen(path, "r");
            CHECK(f != NULL, "m17-revoked-readable");
            char content[256] = { 0 };
            size_t r = f ? fread(content, 1, sizeof(content) - 1, f) : 0;
            if (f) fclose(f);
            content[r] = '\0';
            CHECK(strcmp(content, "k_aaa1111111\nk_bbb2222222\n") == 0, "m17-revoked-sorted-dedup");
        }
        const char *bad[] = { "k_aaa1111111", "bad id!" };
        CHECK(!lea_revoked_write(path, bad, 2), "m17-revoked-bad-id-rejected");
        {
            /* 拒绝后文件内容不变（无残集）。 */
            FILE *f = fopen(path, "r");
            char content[256] = { 0 };
            size_t r = f ? fread(content, 1, sizeof(content) - 1, f) : 0;
            if (f) fclose(f);
            content[r] = '\0';
            CHECK(strcmp(content, "k_aaa1111111\nk_bbb2222222\n") == 0, "m17-revoked-reject-keeps-file");
        }
        CHECK(lea_revoked_write(path, NULL, 0), "m17-revoked-clear");
        {
            FILE *f = fopen(path, "r");
            int c = f ? fgetc(f) : -2;
            if (f) fclose(f);
            CHECK(c == EOF, "m17-revoked-empty-after-clear");
        }
        remove(path);
    }

    /* ---------- #17 第二轮：lea_revoked_merge 并集合并 ----------
     * keys.sync-revoked 有两个全量替换写入方（H21 推送与 rebind 快照），
     * 到达顺序无保证；合并写入使陈旧快照／空集至多无操作、永不缩表。
     * lea_revoked_write 全量替换语义本身不动（上块用例仍覆盖）。 */
    {
        const char *mpath = "/tmp/m17-revoked-merge.txt";
        remove(mpath);
        const char *mset1[] = { "k_bbb2222222", "k_aaa1111111", "k_bbb2222222" };
        CHECK(lea_revoked_merge(mpath, mset1, 3), "m17-merge-missing-file");
        {
            FILE *f = fopen(mpath, "r");
            char content[256] = { 0 };
            size_t r = f ? fread(content, 1, sizeof(content) - 1, f) : 0;
            if (f) fclose(f);
            content[r] = '\0';
            CHECK(strcmp(content, "k_aaa1111111\nk_bbb2222222\n") == 0, "m17-merge-sorted-dedup");
        }
        const char *mset2[] = { "k_ccc3333333" };
        CHECK(lea_revoked_merge(mpath, mset2, 1), "m17-merge-adds");
        {
            FILE *f = fopen(mpath, "r");
            char content[256] = { 0 };
            size_t r = f ? fread(content, 1, sizeof(content) - 1, f) : 0;
            if (f) fclose(f);
            content[r] = '\0';
            CHECK(strcmp(content, "k_aaa1111111\nk_bbb2222222\nk_ccc3333333\n") == 0, "m17-merge-union");
        }
        /* 陈旧快照（缺 k_bbb/k_ccc）不得缩表。 */
        const char *mstale[] = { "k_aaa1111111" };
        CHECK(lea_revoked_merge(mpath, mstale, 1), "m17-merge-stale-ok");
        {
            FILE *f = fopen(mpath, "r");
            char content[256] = { 0 };
            size_t r = f ? fread(content, 1, sizeof(content) - 1, f) : 0;
            if (f) fclose(f);
            content[r] = '\0';
            CHECK(strcmp(content, "k_aaa1111111\nk_bbb2222222\nk_ccc3333333\n") == 0, "m17-merge-stale-no-shrink");
        }
        /* 空集即无操作。 */
        CHECK(lea_revoked_merge(mpath, NULL, 0), "m17-merge-empty-ok");
        {
            FILE *f = fopen(mpath, "r");
            char content[256] = { 0 };
            size_t r = f ? fread(content, 1, sizeof(content) - 1, f) : 0;
            if (f) fclose(f);
            content[r] = '\0';
            CHECK(strcmp(content, "k_aaa1111111\nk_bbb2222222\nk_ccc3333333\n") == 0, "m17-merge-empty-noop");
        }
        /* 传入非法 id 整单拒绝、文件不变。 */
        const char *mbad[] = { "k_ddd4444444", "bad id!" };
        CHECK(!lea_revoked_merge(mpath, mbad, 2), "m17-merge-bad-id-rejected");
        {
            FILE *f = fopen(mpath, "r");
            char content[256] = { 0 };
            size_t r = f ? fread(content, 1, sizeof(content) - 1, f) : 0;
            if (f) fclose(f);
            content[r] = '\0';
            CHECK(strcmp(content, "k_aaa1111111\nk_bbb2222222\nk_ccc3333333\n") == 0, "m17-merge-reject-keeps-file");
        }
        /* 空集真 no-op：缺失文件也不创建。 */
        remove(mpath);
        CHECK(lea_revoked_merge(mpath, NULL, 0) && access(mpath, F_OK) != 0, "m17-merge-empty-missing-noop");
        /* 路径是目录即整单拒绝（读盘失败非 ENOENT）。 */
        CHECK(!lea_revoked_merge("/tmp", mset2, 1), "m17-merge-dir-rejected");
        /* 末行无换行照常读。 */
        {
            FILE *f = fopen(mpath, "w");
            if (f) { fputs("k_aaa1111111\nk_bbb2222222", f); fclose(f); }
        }
        CHECK(lea_revoked_merge(mpath, mset2, 1), "m17-merge-no-trailing-newline-ok");
        {
            FILE *f = fopen(mpath, "r");
            char content[256] = { 0 };
            size_t r = f ? fread(content, 1, sizeof(content) - 1, f) : 0;
            if (f) fclose(f);
            content[r] = '\0';
            CHECK(strcmp(content, "k_aaa1111111\nk_bbb2222222\nk_ccc3333333\n") == 0, "m17-merge-no-trailing-newline-union");
        }
        /* 600 行重复行：去重后不超上限，合并成功。 */
        {
            FILE *f = fopen(mpath, "w");
            if (f) { for (int i = 0; i < 600; i++) fputs("k_aaa1111111\n", f); fclose(f); }
        }
        CHECK(lea_revoked_merge(mpath, mset2, 1), "m17-merge-dup-lines-ok");
        {
            FILE *f = fopen(mpath, "r");
            char content[256] = { 0 };
            size_t r = f ? fread(content, 1, sizeof(content) - 1, f) : 0;
            if (f) fclose(f);
            content[r] = '\0';
            CHECK(strcmp(content, "k_aaa1111111\nk_ccc3333333\n") == 0, "m17-merge-dup-lines-dedup");
        }
        /* 传入 key_ids 为 NULL 但 n>0 即拒绝（禁解引用 NULL）。 */
        CHECK(!lea_revoked_merge(mpath, NULL, 1), "m17-merge-null-ids-rejected");
        /* 行尾 tab／大量空格：整行读＋先 trim 再校验，不误拒。 */
        {
            FILE *f = fopen(mpath, "w");
            if (f) { fputs("k_aaa1111111\t\nk_bbb2222222", f); for (int i = 0; i < 2000; i++) fputc(' ', f); fputc('\n', f); fclose(f); }
        }
        CHECK(lea_revoked_merge(mpath, mset2, 1), "m17-merge-trailing-ws-ok");
        {
            FILE *f = fopen(mpath, "r");
            char content[256] = { 0 };
            size_t r = f ? fread(content, 1, sizeof(content) - 1, f) : 0;
            if (f) fclose(f);
            content[r] = '\0';
            CHECK(strcmp(content, "k_aaa1111111\nk_bbb2222222\nk_ccc3333333\n") == 0, "m17-merge-trailing-ws-union");
        }
        /* 上限边界（自证式）：511 个唯一 id＋1 个新 id＝512，合并成功；
         * 再加 1 个即 513，去重后超上限整单拒绝、文件不变（512 行）。
         * 先证 511 行可读，再证超限拒绝，拒绝原因不可能是“行非法”。 */
        {
            FILE *f = fopen(mpath, "w");
            if (f) {
                for (int i = 0; i < 511; i++) fprintf(f, "k_%08d\n", i);
                fclose(f);
            }
        }
        const char *mcap1[] = { "k_bbb2222222" };
        CHECK(lea_revoked_merge(mpath, mcap1, 1), "m17-merge-cap-512-ok");
        {
            FILE *f = fopen(mpath, "r");
            int lines = 0;
            char lb[256];
            while (f && fgets(lb, sizeof(lb), f)) lines++;
            if (f) fclose(f);
            CHECK(lines == 512, "m17-merge-cap-512-lines");
        }
        CHECK(!lea_revoked_merge(mpath, mset2, 1), "m17-merge-over-cap-rejected");
        {
            FILE *f = fopen(mpath, "r");
            int lines = 0;
            char lb[256];
            while (f && fgets(lb, sizeof(lb), f)) lines++;
            if (f) fclose(f);
            CHECK(lines == 512, "m17-merge-over-cap-keeps-file");
        }
        remove(mpath);
    }

    /* ---------- #17 R6：写前 CAS——H21 直写落在读-写之间不得丢项 ----------
     * 钩子在 merge 基线读后、写前重读前把文件全量替换为 [A,D]（H21 直写
     * 形态）。无 CAS 时 merge 会以 [A,B,C] 覆盖丢 D，且只验传入 id 的
     * 写后校验照常通过；有 CAS 时应检测到文件已变、重合并，最终表含 D。
     * 仅在定义 LEA_TEST_HOOKS 时跑（钩子本身只在该宏下编译）。 */
#ifdef LEA_TEST_HOOKS
    {
        const char *cpath = "/tmp/m17-revoked-cas.txt";
        remove(cpath);
        const char *cinit[] = { "k_aaa1111111", "k_bbb2222222" };
        CHECK(lea_revoked_write(cpath, cinit, 2), "m17-cas-setup");
        g_cas_hook_fired = 0;
        lea_revoked_merge_set_pre_write_hook(cas_hook);
        const char *cinc[] = { "k_ccc3333333" };
        CHECK(lea_revoked_merge(cpath, cinc, 1), "m17-cas-merge-ok");
        lea_revoked_merge_set_pre_write_hook(NULL);
        {
            FILE *f = fopen(cpath, "r");
            char content[256] = { 0 };
            size_t r = f ? fread(content, 1, sizeof(content) - 1, f) : 0;
            if (f) fclose(f);
            content[r] = '\0';
            CHECK(strcmp(content, "k_aaa1111111\nk_bbb2222222\nk_ccc3333333\nk_ddd4444444\n") == 0, "m17-cas-keeps-h21-item");
        }
        remove(cpath);
    }

    /* ---------- #1 版本化：世代合并——陈旧 H21 落在写盘与世代推进之间 ----------
     * 钩子第 2 次调用（世代推进后、最终重读前）把文件全量替换为 [A]
     * （陈旧 H21 形态，丢 B、C）。无最终重读＋重试时 merge 返回成功但
     * 表只剩 [A]；有最终重读时应发现期望集缺失、以外层累积期望集重合并，
     * 最终表为 [A,B,C] 且世代文件为 6。 */
    {
        const char *gpath = "/tmp/m17-revoked-gen.txt";
        char genfile[512];
        CHECK(lea_revoked_gen_path(gpath, genfile, sizeof(genfile)), "gen-merge-genpath-ok");
        CHECK(strcmp(genfile, "/tmp/m17-revoked-gen.gen") == 0, "gen-merge-genpath-txt-suffix");
        remove(gpath);
        remove(genfile);
        const char *ginit[] = { "k_aaa1111111", "k_bbb2222222" };
        CHECK(lea_revoked_write(gpath, ginit, 2), "gen-merge-setup");
        CHECK(lea_revoked_generation_write(genfile, 5), "gen-merge-setup-gen");
        g_gen_hook_calls = 0;
        lea_revoked_merge_set_pre_write_hook(gen_hook);
        const char *ginc[] = { "k_ccc3333333" };
        int gstale = -1;
        CHECK(lea_revoked_merge_with_generation(gpath, ginc, 1, 6, &gstale), "gen-merge-ok");
        CHECK(gstale == 0, "gen-merge-not-stale");
        lea_revoked_merge_set_pre_write_hook(NULL);
        {
            FILE *f = fopen(gpath, "r");
            char content[256] = { 0 };
            size_t r = f ? fread(content, 1, sizeof(content) - 1, f) : 0;
            if (f) fclose(f);
            content[r] = '\0';
            CHECK(strcmp(content, "k_aaa1111111\nk_bbb2222222\nk_ccc3333333\n") == 0, "gen-merge-final-table");
        }
        {
            long long gv = -1;
            CHECK(lea_revoked_generation_read(genfile, &gv) && gv == 6, "gen-merge-final-gen");
        }
        remove(gpath);
        remove(genfile);
    }

    /* ---------- #1 版本化 R2：入口一次性 stale 检查＋世代稳定性重验 ----------
     * 三个模式共用同一初态（表 [A,B]、世代 5，传入 [C]、generation 6）：
     * 模式 3＝R2-2.1 反例（世代推进后更新推送世代 9 已到、表又被陈旧
     * 推送覆盖为 [A]）：旧写法第 2 轮入口 `6 < 9` 即判 stale 返回 0，
     * 表停在 [A]；新写法只在首轮判 stale，重试轮以累积期望集重合并，
     * 终表 [A,B,C]、世代保持 9（不回退）。模式 1＝R2-2.2 稳定性·更新
     * （世代被推到 9、表未变）：须多跑一轮确认稳定后才返回 1。模式 2
     * ＝R2-2.2 稳定性·回退（世代被回退到 2）：须重合并一轮重断世代，
     * 终表 [A,B,C]、世代恢复为 6。 */
    {
        const char *gpath = "/tmp/m17-revoked-gen2.txt";
        char genfile[512];
        CHECK(lea_revoked_gen_path(gpath, genfile, sizeof(genfile)), "gen2-genpath-ok");
        const char *ginit[] = { "k_aaa1111111", "k_bbb2222222" };
        const char *ginc[] = { "k_ccc3333333" };
        /* 模式 3：2.1 反例。 */
        remove(gpath);
        remove(genfile);
        CHECK(lea_revoked_write(gpath, ginit, 2), "gen2-setup");
        CHECK(lea_revoked_generation_write(genfile, 5), "gen2-setup-gen");
        g_gen_interleave_mode = 3;
        g_gen_hook_calls = 0;
        lea_revoked_merge_set_pre_write_hook(gen_interleave_hook);
        int gstale = -1;
        CHECK(lea_revoked_merge_with_generation(gpath, ginc, 1, 6, &gstale), "gen2-retry-not-stale-ok");
        CHECK(gstale == 0, "gen2-retry-not-stale-flag");
        lea_revoked_merge_set_pre_write_hook(NULL);
        {
            FILE *f = fopen(gpath, "r");
            char content[256] = { 0 };
            size_t r = f ? fread(content, 1, sizeof(content) - 1, f) : 0;
            if (f) fclose(f);
            content[r] = '\0';
            CHECK(strcmp(content, "k_aaa1111111\nk_bbb2222222\nk_ccc3333333\n") == 0, "gen2-retry-final-table");
        }
        {
            long long gv = -1;
            CHECK(lea_revoked_generation_read(genfile, &gv) && gv == 9, "gen2-retry-final-gen-kept");
        }
        /* 模式 1：2.2 稳定性·更新。定位说明：本测试锁定新写法在世代被
         * 推高时不误报失败／不回退（回归防护），旧写法下也通过，非旧
         * bug 反例——与模式 2／模式 3（旧写法失败型）定位不同。 */
        remove(gpath);
        remove(genfile);
        CHECK(lea_revoked_write(gpath, ginit, 2), "gen2-stable-setup");
        CHECK(lea_revoked_generation_write(genfile, 5), "gen2-stable-setup-gen");
        g_gen_interleave_mode = 1;
        g_gen_hook_calls = 0;
        lea_revoked_merge_set_pre_write_hook(gen_interleave_hook);
        CHECK(lea_revoked_merge_with_generation(gpath, ginc, 1, 6, NULL), "gen2-stable-newer-ok");
        lea_revoked_merge_set_pre_write_hook(NULL);
        {
            FILE *f = fopen(gpath, "r");
            char content[256] = { 0 };
            size_t r = f ? fread(content, 1, sizeof(content) - 1, f) : 0;
            if (f) fclose(f);
            content[r] = '\0';
            CHECK(strcmp(content, "k_aaa1111111\nk_bbb2222222\nk_ccc3333333\n") == 0, "gen2-stable-newer-table");
        }
        {
            long long gv = -1;
            CHECK(lea_revoked_generation_read(genfile, &gv) && gv == 9, "gen2-stable-newer-gen");
        }
        /* 模式 2：2.2 稳定性·回退。 */
        remove(gpath);
        remove(genfile);
        CHECK(lea_revoked_write(gpath, ginit, 2), "gen2-regress-setup");
        CHECK(lea_revoked_generation_write(genfile, 5), "gen2-regress-setup-gen");
        g_gen_interleave_mode = 2;
        g_gen_hook_calls = 0;
        lea_revoked_merge_set_pre_write_hook(gen_interleave_hook);
        CHECK(lea_revoked_merge_with_generation(gpath, ginc, 1, 6, NULL), "gen2-stable-regress-ok");
        lea_revoked_merge_set_pre_write_hook(NULL);
        {
            FILE *f = fopen(gpath, "r");
            char content[256] = { 0 };
            size_t r = f ? fread(content, 1, sizeof(content) - 1, f) : 0;
            if (f) fclose(f);
            content[r] = '\0';
            CHECK(strcmp(content, "k_aaa1111111\nk_bbb2222222\nk_ccc3333333\n") == 0, "gen2-stable-regress-table");
        }
        {
            long long gv = -1;
            CHECK(lea_revoked_generation_read(genfile, &gv) && gv == 6, "gen2-stable-regress-gen-restored");
        }
        remove(gpath);
        remove(genfile);
    }
#endif

    /* ---------- F-01：吊销表三态 fail-closed（GPT 第二轮审计 F-01） ----------
     * 旧 key_is_revoked：fopen 失败即当“未吊销”。新 lea_revoked_check 三态
     * （REVOKED / NOT_REVOKED / ERROR），快照严格校验全有或全无。
     * 调用点（QFRLEA.c 两处）的三态映射由 lea_revocation_error_code 集中
     * 承担并在此覆盖全部臂；QFRLEA.c 本体只做 mingw 交叉编译检查
     * （Linux 沙箱跑不了 Windows 服务），真机故障注入见回报未完成项。 */
    {
        const char *fpath = "/tmp/f01-revoked.txt";
        char gpath[512];
        CHECK(lea_revoked_gen_path(fpath, gpath, sizeof(gpath)), "f01-genpath-ok");
        long long snap = -2;
        /* 合法命中／未命中／快照世代回填。 */
        remove(fpath);
        remove(gpath);
        CHECK(f01_write_text(fpath, "k_aaa1111111\nk_bbb2222222\n"), "f01-legal-setup");
        CHECK(lea_revoked_generation_write(gpath, 3), "f01-legal-setup-gen");
        CHECK(lea_revoked_check(fpath, "k_aaa1111111", 3, 1, &snap) == LEA_REVOCATION_REVOKED, "f01-legal-hit");
        CHECK(snap == 3, "f01-legal-hit-snap-gen");
        CHECK(lea_revoked_check(fpath, "k_zzz9999999", 3, 1, NULL) == LEA_REVOCATION_NOT_REVOKED, "f01-legal-miss");
        CHECK(lea_revoked_validate_snapshot(fpath, 3, 1, &snap) && snap == 3, "f01-legal-validate-ok");
        /* 合法空表（带世代标记）。 */
        remove(fpath);
        remove(gpath);
        CHECK(f01_write_text(fpath, ""), "f01-empty-setup");
        CHECK(lea_revoked_generation_write(gpath, 3), "f01-empty-setup-gen");
        CHECK(lea_revoked_check(fpath, "k_zzz9999999", 3, 1, NULL) == LEA_REVOCATION_NOT_REVOKED, "f01-legal-empty-with-gen");
        /* 裸空文件（无世代标记）→ ERROR。 */
        remove(gpath);
        CHECK(lea_revoked_check(fpath, "k_zzz9999999", 0, 0, NULL) == LEA_REVOCATION_ERROR, "f01-bare-empty-error");
        /* 空文件＋世代陈旧 → ERROR。 */
        CHECK(lea_revoked_generation_write(gpath, 1), "f01-empty-stale-setup-gen");
        CHECK(lea_revoked_check(fpath, "k_zzz9999999", 2, 1, NULL) == LEA_REVOCATION_ERROR, "f01-empty-stale-error");
        /* 文件缺失：首次安装（无世代、无历史）= 合法空表；有历史／有世代 = ERROR。 */
        remove(fpath);
        remove(gpath);
        CHECK(lea_revoked_check(fpath, "k_zzz9999999", 0, 0, NULL) == LEA_REVOCATION_NOT_REVOKED, "f01-missing-first-install-ok");
        CHECK(lea_revoked_check(fpath, "k_zzz9999999", 0, 1, NULL) == LEA_REVOCATION_ERROR, "f01-missing-with-history-error");
        CHECK(lea_revoked_generation_write(gpath, 2), "f01-missing-gen-setup");
        CHECK(lea_revoked_check(fpath, "k_zzz9999999", 2, 0, NULL) == LEA_REVOCATION_ERROR, "f01-missing-with-gen-error");
        remove(gpath);
        /* 半截行（末行无换行）→ ERROR 整份。 */
        CHECK(f01_write_text(fpath, "k_aaa1111111\nk_bbb2222222"), "f01-truncated-setup");
        CHECK(lea_revoked_generation_write(gpath, 3), "f01-truncated-setup-gen");
        CHECK(lea_revoked_check(fpath, "k_aaa1111111", 3, 1, NULL) == LEA_REVOCATION_ERROR, "f01-truncated-line-error");
        /* 超长行（129 字节／200 字节）→ ERROR，不截断。 */
        {
            char longline[201];
            memset(longline, 'a', 129);
            longline[129] = '\n';
            CHECK(f01_write_raw(fpath, longline, 130), "f01-overlong-setup");
            CHECK(lea_revoked_check(fpath, "k_zzz9999999", 3, 1, NULL) == LEA_REVOCATION_ERROR, "f01-overlong-129-error");
            memset(longline, 'a', 200);
            longline[200] = '\n';
            CHECK(f01_write_raw(fpath, longline, 201), "f01-overlong200-setup");
            CHECK(lea_revoked_check(fpath, "k_zzz9999999", 3, 1, NULL) == LEA_REVOCATION_ERROR, "f01-overlong-200-error");
        }
        /* 非法字符行：行尾空格／CRLF／控制字符／NUL → ERROR 整份。 */
        CHECK(f01_write_text(fpath, "k_aaa1111111 \n"), "f01-space-setup");
        CHECK(lea_revoked_check(fpath, "k_aaa1111111", 3, 1, NULL) == LEA_REVOCATION_ERROR, "f01-trailing-space-error");
        CHECK(f01_write_text(fpath, "k_aaa1111111\r\nk_bbb2222222\n"), "f01-crlf-setup");
        CHECK(lea_revoked_check(fpath, "k_aaa1111111", 3, 1, NULL) == LEA_REVOCATION_ERROR, "f01-crlf-error");
        CHECK(f01_write_text(fpath, "k_aaa1111111\nk_bbb\x01" "2222222\n"), "f01-control-setup");
        CHECK(lea_revoked_check(fpath, "k_aaa1111111", 3, 1, NULL) == LEA_REVOCATION_ERROR, "f01-control-char-error");
        {
            char nuldata[] = { 'k','_','a','a','a','1','1','1','1','1','1','1','\n',
                               'k','_','b','b','b','\0','2','2','2','2','2','2','2','\n' };
            CHECK(f01_write_raw(fpath, nuldata, sizeof(nuldata)), "f01-nul-setup");
            CHECK(lea_revoked_check(fpath, "k_aaa1111111", 3, 1, NULL) == LEA_REVOCATION_ERROR, "f01-nul-error");
        }
        /* 重复行 → ERROR。 */
        CHECK(f01_write_text(fpath, "k_aaa1111111\nk_aaa1111111\n"), "f01-dup-setup");
        CHECK(lea_revoked_check(fpath, "k_aaa1111111", 3, 1, NULL) == LEA_REVOCATION_ERROR, "f01-duplicate-error");
        /* 陈旧世代（快照 gen 1 < 已接受 2）→ ERROR；世代超前 → 通过且回填。 */
        CHECK(f01_write_text(fpath, "k_aaa1111111\n"), "f01-stale-setup");
        CHECK(lea_revoked_generation_write(gpath, 1), "f01-stale-setup-gen");
        CHECK(lea_revoked_check(fpath, "k_zzz9999999", 2, 1, NULL) == LEA_REVOCATION_ERROR, "f01-stale-gen-error");
        CHECK(lea_revoked_generation_write(gpath, 3), "f01-ahead-setup-gen");
        snap = -2;
        CHECK(lea_revoked_check(fpath, "k_zzz9999999", 2, 1, &snap) == LEA_REVOCATION_NOT_REVOKED, "f01-gen-ahead-ok");
        CHECK(snap == 3, "f01-gen-ahead-snap");
        /* 世代文件损坏 → ERROR；世代丢失而本机已有接受历史 → ERROR。 */
        CHECK(f01_write_text(gpath, "abc\n"), "f01-gen-corrupt-setup");
        CHECK(lea_revoked_check(fpath, "k_zzz9999999", 2, 1, NULL) == LEA_REVOCATION_ERROR, "f01-gen-corrupt-error");
        remove(gpath);
        CHECK(lea_revoked_check(fpath, "k_zzz9999999", 2, 1, NULL) == LEA_REVOCATION_ERROR, "f01-gen-missing-with-max-error");
        /* 无世代旧版非空快照（max=0）：兼容放行，回填世代 -1。 */
        snap = -2;
        CHECK(lea_revoked_check(fpath, "k_aaa1111111", 0, 0, &snap) == LEA_REVOCATION_REVOKED, "f01-legacy-no-gen-hit");
        CHECK(snap == -1, "f01-legacy-no-gen-snap-minus1");
        /* 超 512 行 → ERROR。 */
        {
            FILE *f = fopen(fpath, "w");
            CHECK(f != NULL, "f01-over-cap-setup");
            if (f) {
                for (int i = 0; i < 513; i++) fprintf(f, "k_%09d\n", i);
                fclose(f);
            }
            CHECK(lea_revoked_generation_write(gpath, 1), "f01-over-cap-setup-gen");
            CHECK(lea_revoked_check(fpath, "k_zzz9999999", 1, 1, NULL) == LEA_REVOCATION_ERROR, "f01-over-cap-error");
        }
        /* 路径是目录 → ERROR（读不到）。 */
        mkdir("/tmp/f01-asan-dir", 0755);
        CHECK(lea_revoked_check("/tmp/f01-asan-dir", "k_zzz9999999", 0, 0, NULL) == LEA_REVOCATION_ERROR, "f01-dir-as-file-error");
        rmdir("/tmp/f01-asan-dir");
        /* 只读目录里的文件仍可读：只读磁盘不得把读路径变成 ERROR。 */
        {
            const char *dir = "/tmp/f01-rodir";
            char rp[256], rg[256];
            mkdir(dir, 0755);
            snprintf(rp, sizeof(rp), "%s/revoked_keys.txt", dir);
            snprintf(rg, sizeof(rg), "%s/revoked_keys.gen", dir);
            CHECK(f01_write_text(rp, "k_aaa1111111\n"), "f01-rodir-setup");
            CHECK(lea_revoked_generation_write(rg, 1), "f01-rodir-setup-gen");
            chmod(dir, 0555);
            CHECK(lea_revoked_check(rp, "k_zzz9999999", 1, 1, NULL) == LEA_REVOCATION_NOT_REVOKED, "f01-readonly-dir-reads-ok");
            chmod(dir, 0755);
            remove(rp);
            remove(rg);
            rmdir(dir);
        }
        /* 拒绝读取（chmod 000）：root 下仍可读则跳过（沙箱以 root 跑）。 */
        CHECK(f01_write_text(fpath, "k_aaa1111111\n"), "f01-unreadable-setup");
        CHECK(lea_revoked_generation_write(gpath, 1), "f01-unreadable-setup-gen");
        chmod(fpath, 0000);
        if (access(fpath, R_OK) != 0) {
            CHECK(lea_revoked_check(fpath, "k_zzz9999999", 1, 1, NULL) == LEA_REVOCATION_ERROR, "f01-unreadable-error");
        } else {
            printf("SKIP f01-unreadable-error (running as root, chmod 000 still readable)\n");
        }
        chmod(fpath, 0644);
        /* 非法 api_key_id → ERROR（防御性 fail-closed）。 */
        CHECK(lea_revoked_check(fpath, NULL, 1, 1, NULL) == LEA_REVOCATION_ERROR, "f01-null-key-id-error");
        CHECK(lea_revoked_check(fpath, "", 1, 1, NULL) == LEA_REVOCATION_ERROR, "f01-empty-key-id-error");
        CHECK(lea_revoked_check(fpath, "short", 1, 1, NULL) == LEA_REVOCATION_ERROR, "f01-short-key-id-error");
        CHECK(lea_revoked_check(fpath, "bad id!", 1, 1, NULL) == LEA_REVOCATION_ERROR, "f01-bad-key-id-error");
        /* 三态 → 错误码全映射（两处调用点共用的唯一映射函数）。 */
        CHECK(lea_revocation_error_code(LEA_REVOCATION_NOT_REVOKED) == NULL, "f01-map-not-revoked-null");
        CHECK_STR_EQ(lea_revocation_error_code(LEA_REVOCATION_REVOKED), "QFR_API_KEY_REVOKED", "f01-map-revoked");
        CHECK_STR_EQ(lea_revocation_error_code(LEA_REVOCATION_ERROR), "QFR_LEA_REVOCATION_UNAVAILABLE", "f01-map-error");
        CHECK_STR_EQ(lea_revocation_error_code((lea_revocation_status_t)99), "QFR_LEA_REVOCATION_UNAVAILABLE", "f01-map-unknown-fail-closed");
        /* 新错误码不可重试。 */
        CHECK(!lea_error_retryable(LEA_ERR_REVOCATION_UNAVAILABLE), "f01-new-code-not-retryable");
        CHECK(!lea_error_retryable(LEA_ERR_KEY_REVOKED), "f01-revoked-not-retryable");
        /* ---------- .gen 缺失 fail-open 窗口：迁移标记（DS-Q4） ----------
         * 标记 revoked_keys.migrated，内容严格为 "1\n"（schema v1），含义
         * “本安装的吊销世代状态已建立（首次安装初始化或旧版迁移）”。 */
        {
            char mpath[512];
            /* A. 标记助手：路径派生（有／无 .txt 后缀）／写读往返／缺失／坏内容／空文件。 */
            CHECK(lea_revoked_migrated_path(fpath, mpath, sizeof(mpath)) && strcmp(mpath, "/tmp/f01-revoked.migrated") == 0, "f01m-migrated-path-txt");
            CHECK(lea_revoked_migrated_path("/tmp/x/table", mpath, sizeof(mpath)) && strcmp(mpath, "/tmp/x/table.migrated") == 0, "f01m-migrated-path-append");
            CHECK(lea_revoked_migrated_path(fpath, mpath, sizeof(mpath)), "f01m-migrated-path-ok");
            remove(mpath);
            CHECK(lea_revoked_migrated_write(mpath), "f01m-migrated-write-ok");
            CHECK(lea_revoked_migrated_read(mpath) == 1, "f01m-migrated-read-ok");
            remove(mpath);
            CHECK(lea_revoked_migrated_read(mpath) == 0, "f01m-migrated-read-missing");
            CHECK(f01_write_text(mpath, "abc\n"), "f01m-migrated-bad-setup");
            CHECK(lea_revoked_migrated_read(mpath) == -1, "f01m-migrated-read-bad");
            CHECK(f01_write_text(mpath, ""), "f01m-migrated-empty-setup");
            CHECK(lea_revoked_migrated_read(mpath) == -1, "f01m-migrated-read-empty");
            remove(mpath);
            /* B. 迁移决策（纯函数）：snap>=0 放行；snap==-1 一律 DEGRADED
             * （X-01，站长 2026-11-15 亲令严格 fail-closed：取消自动迁移，
             * 无 .gen 的旧版快照不再返回 1，须管理员跑显式迁移工具）。 */
            CHECK(lea_revoked_migration_decision(0, 0, 3) == 0, "f01m-decision-snap-ok");
            CHECK(lea_revoked_migration_decision(0, 0, -1) == -1, "f01m-decision-need-migrate-degraded");
            CHECK(lea_revoked_migration_decision(0, 1, -1) == -1, "f01m-decision-migrated-degraded");
            CHECK(lea_revoked_migration_decision(1, 0, -1) == -1, "f01m-decision-gen-present-degraded");
            CHECK(lea_revoked_migration_decision(1, 1, -1) == -1, "f01m-decision-gen-present-migrated-degraded");
            /* C. 验证器在迁移相关状态下的行为（兼容语义故意保留）：
             * 无 sidecar＋max=0＋has_history=1＋合法非空表 → 仍返回 1 且
             * snap==-1：显式迁移工具先靠它验证旧快照合法，再迁移；改了
             * 它就断了旧版升级。无 sidecar＋max=1 → ERROR（迁移后运行时
             * 防线：.gen 在运行中丢失时 key_revocation_check 同样 ERROR）。 */
            remove(gpath);
            CHECK(f01_write_text(fpath, "k_aaa1111111\n"), "f01m-legacy-compat-setup");
            snap = -2;
            CHECK(lea_revoked_validate_snapshot(fpath, 0, 1, &snap) && snap == -1, "f01m-legacy-compat-validate");
            CHECK(lea_revoked_check(fpath, "k_zzz9999999", 1, 1, NULL) == LEA_REVOCATION_ERROR, "f01m-max1-no-sidecar-error");
            /* .gen 不可读（EACCES）时 generation_read 返回 0：root 下仍可读
             * 则跳过（沙箱以 root 跑），待 11/16 真机补验。 */
            CHECK(lea_revoked_generation_write(gpath, 3), "f01m-gen-unreadable-setup");
            chmod(gpath, 0000);
            if (geteuid() == 0) {
                printf("SKIP f01m-gen-unreadable-error (running as root, chmod 000 still readable)\n");
            } else {
                long long gv = -1;
                CHECK(!lea_revoked_generation_read(gpath, &gv), "f01m-gen-unreadable-error");
            }
            chmod(gpath, 0644);
            remove(mpath);
        }
        remove(fpath);
        remove(gpath);
    }

    /* ---------- #1 版本化：世代文件读写与带世代合并 ----------
     * 世代文件 revoked_keys.gen 与表文件同目录；旧 generation 直写拒绝
     * （不写盘、世代不动），新 generation 接受（合并＋推进世代），缺失
     * generation 走无版本合并（不碰世代文件），世代文件损坏即整单拒绝。 */
    {
        const char *vpath = "/tmp/m17-revoked-ver.txt";
        char vgen[512];
        long long gv = -1;
        /* 世代路径派生：.txt→.gen；无后缀追加；大小写不敏感；缓冲不足拒绝。 */
        CHECK(lea_revoked_gen_path(vpath, vgen, sizeof(vgen)) && strcmp(vgen, "/tmp/m17-revoked-ver.gen") == 0, "gen-path-txt");
        CHECK(lea_revoked_gen_path("/tmp/x/revoked_keys.TXT", vgen, sizeof(vgen)) && strcmp(vgen, "/tmp/x/revoked_keys.gen") == 0, "gen-path-txt-upper");
        CHECK(lea_revoked_gen_path("/tmp/x/table", vgen, sizeof(vgen)) && strcmp(vgen, "/tmp/x/table.gen") == 0, "gen-path-append");
        CHECK(!lea_revoked_gen_path(vpath, vgen, 8), "gen-path-small-buf-rejected");
        CHECK(!lea_revoked_gen_path(NULL, vgen, sizeof(vgen)), "gen-path-null-rejected");
        remove(vpath);
        remove("/tmp/m17-revoked-ver.gen");
        /* 缺失世代文件读作 0；写读往返；负数拒绝写。 */
        CHECK(lea_revoked_generation_read("/tmp/m17-revoked-ver.gen", &gv) && gv == 0, "gen-read-missing-zero");
        CHECK(lea_revoked_generation_write("/tmp/m17-revoked-ver.gen", 7), "gen-write-ok");
        CHECK(lea_revoked_generation_read("/tmp/m17-revoked-ver.gen", &gv) && gv == 7, "gen-read-roundtrip");
        CHECK(!lea_revoked_generation_write("/tmp/m17-revoked-ver.gen", -1), "gen-write-negative-rejected");
        /* 损坏内容一律拒绝读：非数字／带尾巴／空文件／超长行。 */
        {
            FILE *f = fopen("/tmp/m17-revoked-ver.gen", "w");
            if (f) { fputs("abc\n", f); fclose(f); }
        }
        CHECK(!lea_revoked_generation_read("/tmp/m17-revoked-ver.gen", &gv), "gen-read-alpha-rejected");
        {
            FILE *f = fopen("/tmp/m17-revoked-ver.gen", "w");
            if (f) { fputs("12x\n", f); fclose(f); }
        }
        CHECK(!lea_revoked_generation_read("/tmp/m17-revoked-ver.gen", &gv), "gen-read-trailing-junk-rejected");
        {
            FILE *f = fopen("/tmp/m17-revoked-ver.gen", "w");
            if (f) { fputs("7\nEXTRA\n", f); fclose(f); }
        }
        CHECK(!lea_revoked_generation_read("/tmp/m17-revoked-ver.gen", &gv), "gen-read-extra-line-rejected");
        {
            FILE *f = fopen("/tmp/m17-revoked-ver.gen", "w");
            if (f) fclose(f);
        }
        CHECK(!lea_revoked_generation_read("/tmp/m17-revoked-ver.gen", &gv), "gen-read-empty-rejected");
        /* 只向前推进：更小即无操作成功，世代不动；更大才写盘。 */
        CHECK(lea_revoked_generation_write("/tmp/m17-revoked-ver.gen", 5), "gen-advance-setup");
        CHECK(lea_revoked_generation_advance("/tmp/m17-revoked-ver.gen", 3), "gen-advance-older-ok");
        CHECK(lea_revoked_generation_read("/tmp/m17-revoked-ver.gen", &gv) && gv == 5, "gen-advance-older-no-regress");
        CHECK(lea_revoked_generation_advance("/tmp/m17-revoked-ver.gen", 9), "gen-advance-newer-ok");
        CHECK(lea_revoked_generation_read("/tmp/m17-revoked-ver.gen", &gv) && gv == 9, "gen-advance-newer-writes");
        /* 新 generation 接受：合并＋推进世代。 */
        const char *vinit[] = { "k_aaa1111111", "k_bbb2222222" };
        CHECK(lea_revoked_write(vpath, vinit, 2), "gen-merge-setup");
        CHECK(lea_revoked_generation_write("/tmp/m17-revoked-ver.gen", 5), "gen-merge-setup-gen");
        const char *vinc[] = { "k_ccc3333333" };
        int vstale = -1;
        CHECK(lea_revoked_merge_with_generation(vpath, vinc, 1, 6, &vstale), "gen-merge-new-ok");
        CHECK(vstale == 0, "gen-merge-new-not-stale");
        {
            FILE *f = fopen(vpath, "r");
            char content[256] = { 0 };
            size_t r = f ? fread(content, 1, sizeof(content) - 1, f) : 0;
            if (f) fclose(f);
            content[r] = '\0';
            CHECK(strcmp(content, "k_aaa1111111\nk_bbb2222222\nk_ccc3333333\n") == 0, "gen-merge-new-table");
        }
        CHECK(lea_revoked_generation_read("/tmp/m17-revoked-ver.gen", &gv) && gv == 6, "gen-merge-new-gen");
        /* 旧 generation 直写拒绝：不写盘、世代不动、*out_stale 置 1。 */
        const char *vold[] = { "k_ddd4444444" };
        vstale = 0;
        CHECK(!lea_revoked_merge_with_generation(vpath, vold, 1, 3, &vstale), "gen-merge-stale-rejected");
        CHECK(vstale == 1, "gen-merge-stale-flag");
        {
            FILE *f = fopen(vpath, "r");
            char content[256] = { 0 };
            size_t r = f ? fread(content, 1, sizeof(content) - 1, f) : 0;
            if (f) fclose(f);
            content[r] = '\0';
            CHECK(strcmp(content, "k_aaa1111111\nk_bbb2222222\nk_ccc3333333\n") == 0, "gen-merge-stale-keeps-file");
        }
        CHECK(lea_revoked_generation_read("/tmp/m17-revoked-ver.gen", &gv) && gv == 6, "gen-merge-stale-keeps-gen");
        /* 等值 generation 是幂等重发：接受，世代不动。 */
        CHECK(lea_revoked_merge_with_generation(vpath, vold, 1, 6, &vstale), "gen-merge-equal-ok");
        CHECK(vstale == 0, "gen-merge-equal-not-stale");
        CHECK(lea_revoked_generation_read("/tmp/m17-revoked-ver.gen", &gv) && gv == 6, "gen-merge-equal-keeps-gen");
        /* 缺失 generation（-1）走无版本合并：表照常合并，世代文件不动。 */
        const char *vmiss[] = { "k_eee5555555" };
        CHECK(lea_revoked_merge_with_generation(vpath, vmiss, 1, -1, NULL), "gen-merge-missing-ok");
        CHECK(lea_revoked_generation_read("/tmp/m17-revoked-ver.gen", &gv) && gv == 6, "gen-merge-missing-keeps-gen");
        /* 世代文件损坏即整单拒绝、表不动。 */
        {
            FILE *f = fopen("/tmp/m17-revoked-ver.gen", "w");
            if (f) { fputs("zz\n", f); fclose(f); }
        }
        CHECK(!lea_revoked_merge_with_generation(vpath, vinc, 1, 9, NULL), "gen-merge-corrupt-gen-rejected");
        {
            FILE *f = fopen(vpath, "r");
            char content[512] = { 0 };
            size_t r = f ? fread(content, 1, sizeof(content) - 1, f) : 0;
            if (f) fclose(f);
            content[r] = '\0';
            CHECK(strcmp(content, "k_aaa1111111\nk_bbb2222222\nk_ccc3333333\nk_ddd4444444\nk_eee5555555\n") == 0, "gen-merge-corrupt-keeps-file");
        }
        /* 空集＋世代：只推进世代，不动表。 */
        CHECK(lea_revoked_generation_write("/tmp/m17-revoked-ver.gen", 6), "gen-merge-empty-setup");
        CHECK(lea_revoked_merge_with_generation(vpath, NULL, 0, 8, NULL), "gen-merge-empty-ok");
        CHECK(lea_revoked_generation_read("/tmp/m17-revoked-ver.gen", &gv) && gv == 8, "gen-merge-empty-advances-gen");
        remove(vpath);
        remove("/tmp/m17-revoked-ver.gen");
    }

    /* ---------- #1 版本化：lea_json_top_level_long 三态 ----------
     * 1=解析成功、0=成员缺失、-1=成员存在但非法（字符串／小数／重复键／
     * 嵌套／尾部垃圾／溢出）。调用方须区分缺失与非法。 */
    {
        long long v = -999;
        CHECK(lea_json_top_level_long("{\"generation\":7}", "generation", &v) == 1 && v == 7, "top-long-ok");
        v = -999;
        CHECK(lea_json_top_level_long("{\"generation\": 7 }", "generation", &v) == 1 && v == 7, "top-long-spaced");
        v = -999;
        CHECK(lea_json_top_level_long("{\"generation\":-3}", "generation", &v) == 1 && v == -3, "top-long-negative-parsed");
        CHECK(lea_json_top_level_long("{\"generation\":\"7\"}", "generation", &v) == -1, "top-long-string-invalid");
        CHECK(lea_json_top_level_long("{\"generation\":7.5}", "generation", &v) == -1, "top-long-float-invalid");
        CHECK(lea_json_top_level_long("{\"generation\":7,\"generation\":8}", "generation", &v) == -1, "top-long-duplicate-invalid");
        CHECK(lea_json_top_level_long("{\"a\":{\"generation\":7}}", "generation", &v) == 0, "top-long-nested-missing");
        CHECK(lea_json_top_level_long("{\"other\":1}", "generation", &v) == 0, "top-long-missing");
        CHECK(lea_json_top_level_long("{\"generation\":7} garbage", "generation", &v) == -1, "top-long-trailing-invalid");
        CHECK(lea_json_top_level_long("{\"generation\":9999999999999999999999}", "generation", &v) == -1, "top-long-overflow-invalid");
        CHECK(lea_json_top_level_long(NULL, "generation", &v) == -1, "top-long-null-invalid");
        CHECK(lea_json_top_level_long("{\"generation\":7}", "generation", NULL) == -1, "top-long-null-out-invalid");
    }

    /* ---------- execute_item USH 分支 ok 判定：须含 ok 字段才采信 ----------
     * execute_item 本体在 QFRLEA.c（Windows 服务，Linux 沙箱跑不到），
     * 判定规则抽为 lea_ush_response_ok（lea_protocol.c，H08
     * json_find_member 严格顶层解析）后在此覆盖：垃圾／截断（含无闭合
     * {"ok":true）／无 ok 字段／ok 为字符串／嵌套 ok／字符串值内伪装
     * "ok":true／重复 ok 键／尾部垃圾均不采信（判失败），ok:true／
     * ok:false 各判对；末尾换行（USH 行响应可能带 \n）照常采信。 */
    {
        int v = -1;
        CHECK(!lea_ush_response_ok("garbage-not-json", &v) && v == -1, "ush-ok-garbage-fails");
        CHECK(!lea_ush_response_ok("{\"ok\":tr", &v) && v == -1, "ush-ok-truncated-fails");
        CHECK(!lea_ush_response_ok("{\"ok\":true", &v) && v == -1, "ush-ok-unclosed-true-fails");
        CHECK(!lea_ush_response_ok("{\"ok\":false", &v) && v == -1, "ush-ok-unclosed-false-fails");
        CHECK(!lea_ush_response_ok("{\"code\":\"QFR_OK\",\"result\":\"done\"}", &v) && v == -1, "ush-ok-missing-fails");
        CHECK(!lea_ush_response_ok("{\"ok\":\"true\",\"code\":\"QFR_OK\"}", &v) && v == -1, "ush-ok-string-fails");
        CHECK(!lea_ush_response_ok("{\"code\":\"x\",\"params\":{\"ok\":true}}", &v) && v == -1, "ush-ok-nested-fails");
        CHECK(!lea_ush_response_ok("{\"msg\":\"\\\"ok\\\":true\"}", &v) && v == -1, "ush-ok-in-string-fails");
        CHECK(!lea_ush_response_ok("{\"ok\":true,\"ok\":false}", &v) && v == -1, "ush-ok-duplicate-fails");
        CHECK(!lea_ush_response_ok("{\"ok\":true} garbage", &v) && v == -1, "ush-ok-trailing-garbage-fails");
        CHECK(!lea_ush_response_ok("{\"ok\":true,}", &v) && v == -1, "ush-ok-trailing-comma-fails");
        CHECK(!lea_ush_response_ok("{\"ok\":truex}", &v) && v == -1, "ush-ok-bad-literal-fails");
        CHECK(!lea_ush_response_ok(NULL, &v) && v == -1, "ush-ok-null-fails");
        CHECK(!lea_ush_response_ok("{\"ok\":true}", NULL), "ush-ok-null-out-fails");
        v = -1;
        CHECK(lea_ush_response_ok("{\"ok\": true }", &v) && v == 1, "ush-ok-true-spaced");
        v = -1;
        CHECK(lea_ush_response_ok("{\"ok\":true,\"code\":\"QFR_OK\"}", &v) && v == 1, "ush-ok-true");
        v = -1;
        CHECK(lea_ush_response_ok("{\"ok\":false,\"code\":\"QFR_LEA_EXEC_FAILED\"}", &v) && v == 0, "ush-ok-false");
        v = -1;
        CHECK(lea_ush_response_ok("{\"ok\":true}\n", &v) && v == 1, "ush-ok-true-trailing-newline");
    }

    /* ---------- #26 幂等表超 4MB 仍持久化（流式写盘＋逐行加载） ---------- */
    {
        static lea_idem_t t26;
        static lea_idem_t t26b;
        lea_idem_init(&t26);
        /* 每条 result 约 7900 字节、700 条 ≈ 5.6MB（> 旧 4MB 缓冲）。 */
        char big_result[8100];
        {
            int pn = snprintf(big_result, sizeof(big_result),
                "{\"ok\":true,\"code\":\"done\",\"request_id\":\"r26\",\"retryable\":false,"
                "\"detail\":\"\",\"result\":{\"x\":\"");
            memset(big_result + pn, 'a', 7800);
            big_result[pn + 7800] = '\0';
            strcat(big_result, "\"}}");
        }
        int created = 0;
        for (int i = 0; i < 700; i++) {
            char key[32];
            snprintf(key, sizeof(key), "key-%04d", i);
            lea_idem_entry_t *e = lea_idem_get_or_create(&t26, "node-1", "alice", key, 0, now);
            if (!e) break;
            lea_idem_set_status(&t26, e, LEA_IDEM_SUCCEEDED, big_result, now);
            created++;
        }
        CHECK(created == 700 && t26.count == 700, "m26-create-700");
        /* 旧路（4MB 内存缓冲）装不下：返回 0；新路（流式写文件）必须成功。 */
        static char buf4m[4 * 1024 * 1024];
        CHECK(!lea_idem_save_text(&t26, buf4m, sizeof(buf4m)), "m26-save-text-4mb-overflow");
        const char *path26 = "/tmp/m26-idem.jsonl";
        remove(path26);
        FILE *f = fopen(path26, "w");
        CHECK(f != NULL, "m26-open");
        int skipped = -1;
        int okw = f ? lea_idem_save_to_file(&t26, f, &skipped) : 0;
        if (f) fclose(f);
        CHECK(okw && skipped == 0, "m26-save-to-file");
        long fsz = 0;
        {
            FILE *fr = fopen(path26, "rb");
            if (fr) { fseek(fr, 0, SEEK_END); fsz = ftell(fr); fclose(fr); }
        }
        CHECK(fsz > 4 * 1024 * 1024, "m26-file-over-4mb");
        /* 逐行加载回表：条数与终态结果完整。 */
        lea_idem_init(&t26b);
        {
            FILE *fr = fopen(path26, "r");
            CHECK(fr != NULL, "m26-reopen");
            char line[LEA_IDEM_RESULT_MAX + 512];
            while (fr && fgets(line, sizeof(line), fr)) {
                size_t len = strlen(line);
                while (len > 0 && (line[len - 1] == '\n' || line[len - 1] == '\r'))
                    line[--len] = '\0';
                if (len) lea_idem_load_line(&t26b, line);
            }
            if (fr) fclose(fr);
        }
        CHECK(t26b.count == 700, "m26-load-count-700");
        {
            lea_idem_entry_t *e = lea_idem_lookup(&t26b, "node-1", "alice", "key-0699");
            CHECK(e != NULL && e->status == LEA_IDEM_SUCCEEDED &&
                  strcmp(e->result, big_result) == 0, "m26-load-result-intact");
        }
        /* 坏行隔离：load_line 拒坏行、不改表。 */
        {
            int before = t26b.count;
            CHECK(!lea_idem_load_line(&t26b, "{\"device_id\":broken"), "m26-load-line-bad");
            CHECK(t26b.count == before, "m26-load-line-bad-keeps-table");
        }
        remove(path26);
    }

    /* ---------- 时间窗 #20：接收窗 = TTL 60s（不再是 30s） ---------- */
    {
        lea_envelope_t w;
        memset(&w, 0, sizeof(w));
        /* 签发 45s 前、TTL 60s：旧实现 skew 45 > 30 即拒，新实现放行。 */
        w.issued_at = now - 45; w.expires_at = now + 15;
        CHECK(lea_check_time_window(&w, now, NULL, 0), "tw20-45s-accepted");
        /* 签发 59s 前、TTL 60s：边界内放行。 */
        w.issued_at = now - 59; w.expires_at = now + 1;
        CHECK(lea_check_time_window(&w, now, NULL, 0), "tw20-59s-accepted");
        /* 签发 30s 后（时钟超前容限内）放行；31s 后拒绝。 */
        w.issued_at = now + 30; w.expires_at = now + 90;
        CHECK(lea_check_time_window(&w, now, NULL, 0), "tw20-future-30s-accepted");
        w.issued_at = now + 31; w.expires_at = now + 91;
        CHECK(!lea_check_time_window(&w, now, NULL, 0), "tw20-future-31s-rejected");
        /* 过期 31s（超 expires+30 容限）拒绝；过期 30s 内仍放行（旧口径）。 */
        w.issued_at = now - 61; w.expires_at = now - 31;
        CHECK(!lea_check_time_window(&w, now, NULL, 0), "tw20-expired-31s-rejected");
        w.issued_at = now - 60; w.expires_at = now - 30;
        CHECK(lea_check_time_window(&w, now, NULL, 0), "tw20-expired-30s-accepted");
        /* TTL 超 60s／为 0 拒绝。 */
        w.issued_at = now; w.expires_at = now + 61;
        CHECK(!lea_check_time_window(&w, now, NULL, 0), "tw20-ttl-61s-rejected");
        w.issued_at = now; w.expires_at = now;
        CHECK(!lea_check_time_window(&w, now, NULL, 0), "tw20-ttl-0-rejected");
        /* 端到端：信封解析层同样放行签发 45s 前的信封（旧实现解析即拒）。 */
        char env45[8192];
        make_envelope(env45, sizeof(env45), now - 45, "sys.info", "{}", 3,
                      "node-1", "alice", "idem-tw20", "nonce-tw20", "req-tw20",
                      "TEST-UNSIGNED");
        lea_envelope_t parsed;
        CHECK(lea_parse_envelope(env45, now, &parsed), "tw20-parse-45s-accepted");
    }

    /* ---------- 审计 #18：放不下即整行失败，不越界 ---------- */
    {
        lea_audit_event_t ev;
        memset(&ev, 0, sizeof(ev));
        ev.event = "execute";
        ev.trace_id = "trace-1";
        ev.request_id = "req-1";
        ev.account_id = "alice";
        ev.device_id = "node-1";
        ev.api_key_id = "key-abc12345";
        ev.key_prefix_redacted = "";
        ev.binding_epoch = 3;
        ev.command = "script.run";
        ev.params_hash = "deadbeef";
        ev.idempotency_key = "idem-1";
        ev.nonce = "nonce-1";
        ev.result = "ok";
        ev.error_code = "";
        ev.duration_ms = 12;
        ev.detail = "";
        char line[8192];
        CHECK(lea_audit_format_line(&ev, "2026-11-10T12:00:00+08:00", line, sizeof(line)),
              "audit18-normal-line-ok");
        /* 超长 detail（8000 字节）进 8192 缓冲：放不下，返回 0（旧实现
         * off 照涨、末尾 out[off] 写越界）。 */
        static char big_detail[8001];
        memset(big_detail, 'A', 8000);
        big_detail[8000] = '\0';
        ev.detail = big_detail;
        CHECK(!lea_audit_format_line(&ev, "2026-11-10T12:00:00+08:00", line, sizeof(line)),
              "audit18-oversize-detail-rejected");
        /* 小缓冲（256 字节下限）＋长字段：返回 0。 */
        static char big_account[301];
        memset(big_account, 'B', 300);
        big_account[300] = '\0';
        ev.detail = "";
        ev.account_id = big_account;
        char small[256];
        CHECK(!lea_audit_format_line(&ev, "2026-11-10T12:00:00+08:00", small, sizeof(small)),
              "audit18-small-buffer-rejected");
        /* 转义放大：detail 全是 '"'（转义后 2 倍），4096 缓冲放不下也须返回 0。 */
        static char quotes[4001];
        memset(quotes, '"', 4000);
        quotes[4000] = '\0';
        ev.account_id = "alice";
        ev.detail = quotes;
        char mid[4096];
        CHECK(!lea_audit_format_line(&ev, "2026-11-10T12:00:00+08:00", mid, sizeof(mid)),
              "audit18-escape-expansion-rejected");
        /* lea_json_escape_into 入口防线：off 已到顶时直接失败（空串也
         * 不得走到末尾 buf[o]='\0' 越界写 1 字节）。 */
        char escbuf[8] = "1234567";
        size_t eoff = 8;
        CHECK(!lea_json_escape_into(escbuf, sizeof(escbuf), &eoff, ""), "audit18-escape-off-at-end-rejected");
        CHECK(eoff == 8, "audit18-escape-off-unchanged");
    }

    /* ---------- 流式 SHA-256 #21② ---------- */
    {
        char hex[65];
        lea_sha256_ctx_t ctx;
        lea_sha256_init(&ctx);
        lea_sha256_update(&ctx, (const unsigned char *)"a", 1);
        lea_sha256_update(&ctx, (const unsigned char *)"bc", 2);
        lea_sha256_final_hex(&ctx, hex);
        CHECK_STR_EQ(hex, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", "sha256-stream-abc");
        lea_sha256_init(&ctx);
        lea_sha256_final_hex(&ctx, hex);
        CHECK_STR_EQ(hex, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", "sha256-stream-empty");
        lea_sha256_init(&ctx);
        lea_sha256_update(&ctx, (const unsigned char *)"abcdbcdecdefdefgefghfghighijhijkijkljklm", 40);
        lea_sha256_update(&ctx, (const unsigned char *)"klmnlmnomnopnopq", 16);
        lea_sha256_final_hex(&ctx, hex);
        CHECK_STR_EQ(hex, "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1", "sha256-stream-56byte");
    }

    /* ---------- r10 ui.tree 帧定界（LEA 侧②改良版） ---------- */
    /* 判定谓词：ush_forward 新逻辑每收一块即判“累计内容为完整 JSON
     * 文档且末字节为帧尾 '\n'”才停。以下用 lea_json_is_valid（与
     * 读循环同一谓词）＋ lea_ush_response_ok（终判）覆盖。 */
    {
        /* 忠实于 ush_uia.c 输出形态＋r9 实测头：head 以 "tree":\n 结尾，
         * 节点间 "\n"＋缩进，末尾 "]}}\n"（根节点闭合＋data 闭合＋外层闭合）。 */
        const char *tree_multi =
            "{\"ok\":true,\"code\":\"done\",\"request_id\":\"r9-mwchlw6g9d8c31\","
            "\"duration_ms\":218,\"data\":{\"truncated\":false,\"nodes\":45,\"tree\":\n"
            "{\"name\":\"Program Manager\",\"control_type\":\"Pane\",\"control_type_id\":50033,"
            "\"automation_id\":\"\",\"class_name\":\"Progman\",\"rect\":[0,0,1024,768],"
            "\"enabled\":true,\"children\":[\n"
            "  {\"name\":\"Desktop\",\"control_type\":\"Pane\",\"control_type_id\":50033,"
            "\"automation_id\":\"\",\"class_name\":\"SHELLDLL_DefView\",\"rect\":[0,0,1024,768],"
            "\"enabled\":true,\"children\":[\n"
            "    {\"name\":\"Recycle Bin\",\"control_type\":\"ListItem\",\"control_type_id\":50007,"
            "\"automation_id\":\"\",\"class_name\":\"\",\"rect\":[10,10,80,90],"
            "\"enabled\":true,\"children\":[]}\n"
            "  ]},\n"
            "  {\"name\":\"Taskbar\",\"control_type\":\"ToolBar\",\"control_type_id\":50015,"
            "\"automation_id\":\"\",\"class_name\":\"Shell_TrayWnd\",\"rect\":[0,728,1024,40],"
            "\"enabled\":true,\"children\":[]}\n"
            "]}}}\n";
        int uok = 0;
        CHECK(lea_json_is_valid(tree_multi), "r10-tree-multiline-valid");
        CHECK(lea_ush_response_ok(tree_multi, &uok) && uok == 1, "r10-tree-multiline-ok-true");
        /* 旧逻辑输出：截断在首个 '\n'（即 "tree": 之后），r9 实测半行。 */
        const char *tree_trunc =
            "{\"ok\":true,\"code\":\"done\",\"request_id\":\"r9-mwchlw6g9d8c31\","
            "\"duration_ms\":218,\"data\":{\"truncated\":false,\"nodes\":45,\"tree\":";
        CHECK(!lea_json_is_valid(tree_trunc), "r10-tree-truncated-invalid");
        CHECK(!lea_ush_response_ok(tree_trunc, &uok), "r10-tree-truncated-no-ok");
        /* 块边界恰停在 '}' 后、无帧尾 '\n'：谓词虽判完整，读循环仍须
         * 等帧尾（末字节非 '\n' 即继续读），防前缀完整提前停。 */
        static char tree_noeol[4096];
        size_t tl = strlen(tree_multi);
        CHECK(tl > 1 && tl < sizeof(tree_noeol), "r10-tree-fixture-size");
        memcpy(tree_noeol, tree_multi, tl - 1); /* 去掉末尾 '\n' */
        tree_noeol[tl - 1] = '\0';
        CHECK(lea_json_is_valid(tree_noeol), "r10-tree-noeol-still-valid");
        CHECK(tree_noeol[tl - 2] != '\n', "r10-tree-noeol-last-byte-not-nl");
        /* 单行快照响应：旧逻辑与新逻辑均一次通过（回归）。 */
        const char *snap_single =
            "{\"ok\":true,\"code\":\"done\",\"request_id\":\"r9-snap\","
            "\"duration_ms\":120,\"data\":{\"path\":\"ush-20261112-030259-681-12028.png\"}}\n";
        CHECK(lea_json_is_valid(snap_single), "r10-snap-single-valid");
        CHECK(lea_ush_response_ok(snap_single, &uok) && uok == 1, "r10-snap-single-ok-true");
        /* 非法输入一律不完整：垃圾／空／串内裸换行（控制符）／
         * 截断在值中间。 */
        CHECK(!lea_json_is_valid("not json\n"), "r10-garbage-invalid");
        CHECK(!lea_json_is_valid(""), "r10-empty-invalid");
        CHECK(!lea_json_is_valid("{\"ok\":true,\"code\":\"do\nne\"}\n"), "r10-raw-lf-in-string-invalid");
        CHECK(lea_json_is_valid("{\"ok\":true,\"code\":\"do\\nne\"}\n"), "r10-escaped-lf-in-string-valid");
        CHECK(!lea_json_is_valid("{\"ok\":true,\"code\":\"done\",\"data\":{\"a\":[1,2,"), "r10-mid-value-truncated-invalid");
        /* 12 层嵌套 children：tree max_depth 10 的实际嵌套（约 23 层）
         * 远在解析器 64 层上限内。 */
        static char deep[4096];
        size_t doff = 0;
        doff += (size_t)snprintf(deep + doff, sizeof(deep) - doff, "{\"ok\":true,\"data\":");
        for (int i = 0; i < 12; i++)
            doff += (size_t)snprintf(deep + doff, sizeof(deep) - doff, "{\"children\":[");
        doff += (size_t)snprintf(deep + doff, sizeof(deep) - doff, "{}");
        for (int i = 0; i < 12; i++)
            doff += (size_t)snprintf(deep + doff, sizeof(deep) - doff, "]}");
        doff += (size_t)snprintf(deep + doff, sizeof(deep) - doff, "}\n");
        CHECK(doff < sizeof(deep), "r10-deep-fixture-size");
        CHECK(lea_json_is_valid(deep), "r10-deep-12-valid");
    }

    /* ---------- A1：首装服务子命令纯函数（lea_install.c） ---------- */
    {
        /* 版本比较：升级判据（包内 version.txt vs 注册表版本）。 */
        CHECK(lea_version_compare("3.0.0", "3.0.0") == 0, "a1-ver-eq");
        CHECK(lea_version_compare("3.0.1", "3.0.0") > 0, "a1-ver-newer");
        CHECK(lea_version_compare("3.0.0", "3.0.1") < 0, "a1-ver-older");
        CHECK(lea_version_compare("3.0.0", "3.0") == 0, "a1-ver-trailing-zero");
        CHECK(lea_version_compare("3.0.0.1", "3.0.0") > 0, "a1-ver-extra-seg");
        CHECK(lea_version_compare("3.0", "3.0.0.1") < 0, "a1-ver-missing-seg");
        CHECK(lea_version_compare("0.1.0", "0.1.0") == 0, "a1-ver-lea-010");
        CHECK(lea_version_compare(NULL, "0.1.0") < 0, "a1-ver-null-is-zero");
        CHECK(lea_version_compare("", "") == 0, "a1-ver-empty-eq");
        CHECK(lea_version_compare("10.0.0", "9.9.9") > 0, "a1-ver-numeric-not-lexical");

        /* 清单行解析（sha256sum 格式）。 */
        char mh[65] = { 0 }, mp[1024] = { 0 };
        const char *good = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855  QFRLEA.exe";
        CHECK(lea_parse_manifest_line(good, mh, sizeof(mh), mp, sizeof(mp)) == 1, "a1-manifest-good");
        CHECK_STR_EQ(mh, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", "a1-manifest-hash");
        CHECK_STR_EQ(mp, "QFRLEA.exe", "a1-manifest-path");
        CHECK(lea_parse_manifest_line(
            "E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855  LEA/QFRLEA.exe",
            mh, sizeof(mh), mp, sizeof(mp)) == 1, "a1-manifest-upper-hex-slash");
        CHECK_STR_EQ(mh, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", "a1-manifest-hash-lowercased");
        CHECK_STR_EQ(mp, "LEA/QFRLEA.exe", "a1-manifest-subdir");
        CHECK(lea_parse_manifest_line(
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 *QFRemote.exe",
            mh, sizeof(mh), mp, sizeof(mp)) == 1, "a1-manifest-star-marker");
        CHECK(!lea_parse_manifest_line("e3b0c44298fc1c149afbf4c8996fb924  QFRLEA.exe", mh, sizeof(mh), mp, sizeof(mp)), "a1-manifest-short-hash");
        CHECK(!lea_parse_manifest_line("zzzzc44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855  QFRLEA.exe", mh, sizeof(mh), mp, sizeof(mp)), "a1-manifest-nonhex");
        CHECK(!lea_parse_manifest_line("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855  /etc/passwd", mh, sizeof(mh), mp, sizeof(mp)), "a1-manifest-absolute-path");
        CHECK(!lea_parse_manifest_line("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855  ../evil.exe", mh, sizeof(mh), mp, sizeof(mp)), "a1-manifest-dotdot");
        CHECK(!lea_parse_manifest_line("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855  LEA/../../evil.exe", mh, sizeof(mh), mp, sizeof(mp)), "a1-manifest-dotdot-mid");
        CHECK(!lea_parse_manifest_line("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", mh, sizeof(mh), mp, sizeof(mp)), "a1-manifest-no-path");
        CHECK(!lea_parse_manifest_line("", mh, sizeof(mh), mp, sizeof(mp)), "a1-manifest-empty");
        CHECK(!lea_parse_manifest_line("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855  C:\\evil.exe", mh, sizeof(mh), mp, sizeof(mp)), "a1-manifest-drive-path");

        /* 子命令集合封闭：只有这四个是服务子命令，其余一律不是
         *（防以后有人把 --install-service 顺手挂进别的分发）。 */
        CHECK(lea_is_service_subcommand("--install-service"), "a1-subcmd-install");
        CHECK(lea_is_service_subcommand("--repair"), "a1-subcmd-repair");
        CHECK(lea_is_service_subcommand("--uninstall-service"), "a1-subcmd-uninstall");
        CHECK(lea_is_service_subcommand("--verify-manifest"), "a1-subcmd-verify");
        CHECK(!lea_is_service_subcommand("debug"), "a1-subcmd-debug-not-service");
        CHECK(!lea_is_service_subcommand("--internal"), "a1-subcmd-internal-not-service");
        CHECK(!lea_is_service_subcommand(NULL), "a1-subcmd-null-not-service");
        CHECK(!lea_is_service_subcommand(""), "a1-subcmd-empty-not-service");
    }

    /* ---------- B1：通道自愈（PLAN §2 B1） ---------- */
    {
        /* 命令分级：L0 控制／健康、L1 普通、L2 长／危险；未知 -1。 */
        CHECK(lea_command_tier("sys.info") == 0, "b1-tier-sys-info-0");
        CHECK(lea_command_tier("sys.ping") == 0, "b1-tier-sys-ping-0");
        CHECK(lea_command_tier("sys.reset") == 0, "b1-tier-sys-reset-0");
        CHECK(lea_command_tier("app.open") == 1, "b1-tier-app-open-1");
        CHECK(lea_command_tier("app.close") == 1, "b1-tier-app-close-1");
        CHECK(lea_command_tier("ui.click") == 1, "b1-tier-ui-click-1");
        CHECK(lea_command_tier("ui.input") == 1, "b1-tier-ui-input-1");
        CHECK(lea_command_tier("ui.snapshot") == 1, "b1-tier-ui-snapshot-1");
        CHECK(lea_command_tier("ui.tree") == 1, "b1-tier-ui-tree-1");
        CHECK(lea_command_tier("file.read") == 1, "b1-tier-file-read-1");
        CHECK(lea_command_tier("script.run") == 2, "b1-tier-script-run-2");
        CHECK(lea_command_tier("file.write") == 2, "b1-tier-file-write-2");
        CHECK(lea_command_tier("rm.everything") == -1, "b1-tier-unknown-minus-1");
        CHECK(lea_command_tier(NULL) == -1, "b1-tier-null-minus-1");

        /* sys.ping／sys.reset 进命令表：内联执行、非危险、默认 5s／上限 8s。 */
        {
            const lea_command_spec_t *sp = lea_command_spec("sys.ping");
            CHECK(sp && sp->executor == LEA_EXEC_INLINE, "b1-spec-ping-inline");
            CHECK(sp && sp->default_timeout_ms == 5000, "b1-spec-ping-timeout-5s");
            CHECK(sp && sp->max_timeout_ms == 8000, "b1-spec-ping-max-8s");
            CHECK(sp && !sp->dangerous, "b1-spec-ping-not-dangerous");
            CHECK(sp && sp->tier == 0, "b1-spec-ping-tier-0");
            sp = lea_command_spec("sys.reset");
            CHECK(sp && sp->executor == LEA_EXEC_INLINE, "b1-spec-reset-inline");
            CHECK(sp && !sp->dangerous, "b1-spec-reset-not-dangerous");
            CHECK(sp && sp->tier == 0, "b1-spec-reset-tier-0");
        }

        /* job 强杀 deadline = min(有效超时, 本级上限)。 */
        {
            lea_envelope_t e = { 0 };
            snprintf(e.command, sizeof(e.command), "sys.info");
            e.timeout_ms = 5000; e.has_timeout = 1;
            CHECK(lea_job_deadline_ms(&e) == 5000, "b1-deadline-l0-min");
            snprintf(e.command, sizeof(e.command), "ui.click");
            e.timeout_ms = 15000; e.has_timeout = 1;
            CHECK(lea_job_deadline_ms(&e) == 8000, "b1-deadline-l1-capped-8s");
            snprintf(e.command, sizeof(e.command), "script.run");
            e.timeout_ms = 300000; e.has_timeout = 1;
            CHECK(lea_job_deadline_ms(&e) == 120000, "b1-deadline-l2-capped-120s");
            e.timeout_ms = 5000; e.has_timeout = 1;
            CHECK(lea_job_deadline_ms(&e) == 5000, "b1-deadline-l2-not-raised");
            snprintf(e.command, sizeof(e.command), "rm.everything");
            e.timeout_ms = 5000; e.has_timeout = 1;
            CHECK(lea_job_deadline_ms(&e) == 5000, "b1-deadline-unknown-5s");
            /* deadline_ms 提示值：取 min(提示, 超时) 后再夹 tier 上限。 */
            snprintf(e.command, sizeof(e.command), "ui.click");
            e.timeout_ms = 15000; e.has_timeout = 1;
            e.deadline_ms = 3000; e.has_deadline = 1;
            CHECK(lea_job_deadline_ms(&e) == 3000, "b1-deadline-hint-shorter-wins");
            e.deadline_ms = 120000; e.has_deadline = 1;
            CHECK(lea_job_deadline_ms(&e) == 8000, "b1-deadline-hint-capped-by-tier");
            e.has_deadline = 0; e.deadline_ms = 0;
            CHECK(lea_job_deadline_ms(&e) == 8000, "b1-deadline-no-hint-falls-back");
        }

        /* 队列准入：深度 <8 放行，≥8 拒绝。 */
        CHECK(lea_queue_admit_ok(0), "b1-admit-depth-0");
        CHECK(lea_queue_admit_ok(7), "b1-admit-depth-7");
        CHECK(!lea_queue_admit_ok(8), "b1-admit-depth-8-full");
        CHECK(!lea_queue_admit_ok(100), "b1-admit-depth-100-full");
        CHECK(LEA_B1_QUEUE_MAX == 8, "b1-const-queue-max-8");
        CHECK(LEA_B1_TIER0_DEADLINE_MAX_MS == 8000, "b1-const-tier0-8s");
        CHECK(LEA_B1_TIER1_DEADLINE_MAX_MS == 8000, "b1-const-tier1-8s");
        CHECK(LEA_B1_TIER2_DEADLINE_MAX_MS == 120000, "b1-const-tier2-120s");
        CHECK(LEA_MAX_JOB_OUTPUT_BYTES == 262144, "b1-const-output-256k");

        /* params 布尔键判定（file.read recursive 拒绝用）。 */
        CHECK(lea_params_has_true("{\"recursive\":true}", "recursive"), "b1-params-recursive-true");
        CHECK(!lea_params_has_true("{\"recursive\":false}", "recursive"), "b1-params-recursive-false");
        CHECK(!lea_params_has_true("{}", "recursive"), "b1-params-recursive-missing");
        CHECK(!lea_params_has_true("{\"recursive\":\"true\"}", "recursive"), "b1-params-recursive-string");
        CHECK(!lea_params_has_true(NULL, "recursive"), "b1-params-null");
        CHECK(!lea_params_has_true("{\"other\":true}", "recursive"), "b1-params-other-key");

        /* RESET 可重试；TIMEOUT 不可重试（与旧口径一致）。 */
        CHECK(lea_error_retryable("QFR_LEA_RESET"), "b1-reset-retryable");
        CHECK(lea_error_retryable("QFR_LEA_BINDING_PENDING"), "b1-binding-pending-retryable");
        CHECK(!lea_error_retryable("QFR_LEA_TIMEOUT"), "b1-timeout-not-retryable");
        CHECK(!lea_error_retryable(NULL), "b1-retryable-null");

        /* 信封 B1 字段解析：job_id／mode／deadline_ms。 */
        {
            char b1env[8192];
            snprintf(b1env, sizeof(b1env),
                     "{\"version\":2,\"request_id\":\"req-b1-0001\",\"batch_id\":\"batch-0001\","
                     "\"seq\":1,\"device_id\":\"node-1\",\"account_id\":\"alice\","
                     "\"api_key_id\":\"key-abc12345\",\"binding_epoch\":3,\"grant_epoch\":1,"
                     "\"nonce\":\"nonce-b1-001\",\"issued_at\":%lld,\"expires_at\":%lld,"
                     "\"idempotency_key\":\"idem-b1-0001\",\"command\":\"sys.info\",\"params\":{},"
                     "\"timeout_ms\":5000,\"job_id\":\"job_b1test00001\",\"mode\":\"sync\","
                     "\"deadline_ms\":5000,\"signature\":\"TEST-UNSIGNED\"}",
                     now, now + 60);
            CHECK(lea_parse_envelope(b1env, now, &env), "b1-parse-fields-ok");
            CHECK_STR_EQ(env.job_id, "job_b1test00001", "b1-parse-job-id");
            CHECK_STR_EQ(env.mode, "sync", "b1-parse-mode-sync");
            CHECK(env.deadline_ms == 5000 && env.has_deadline, "b1-parse-deadline");
            /* async 模式同样通过。 */
            snprintf(b1env, sizeof(b1env),
                     "{\"version\":2,\"request_id\":\"req-b1-0002\",\"batch_id\":\"batch-0001\","
                     "\"seq\":1,\"device_id\":\"node-1\",\"account_id\":\"alice\","
                     "\"api_key_id\":\"key-abc12345\",\"binding_epoch\":3,\"grant_epoch\":1,"
                     "\"nonce\":\"nonce-b1-002\",\"issued_at\":%lld,\"expires_at\":%lld,"
                     "\"idempotency_key\":\"idem-b1-0002\",\"command\":\"script.run\",\"params\":{},"
                     "\"timeout_ms\":30000,\"job_id\":\"job_b1test00002\",\"mode\":\"async\","
                     "\"deadline_ms\":60000,\"signature\":\"TEST-UNSIGNED\"}",
                     now, now + 60);
            CHECK(lea_parse_envelope(b1env, now, &env), "b1-parse-async-ok");
            CHECK_STR_EQ(env.mode, "async", "b1-parse-mode-async");
            CHECK(env.deadline_ms == 60000 && env.has_deadline, "b1-parse-deadline-60s");
            /* mode 非法即整单拒绝。 */
            snprintf(b1env, sizeof(b1env),
                     "{\"version\":2,\"request_id\":\"req-b1-0003\",\"batch_id\":\"batch-0001\","
                     "\"seq\":1,\"device_id\":\"node-1\",\"account_id\":\"alice\","
                     "\"api_key_id\":\"key-abc12345\",\"binding_epoch\":3,\"grant_epoch\":1,"
                     "\"nonce\":\"nonce-b1-003\",\"issued_at\":%lld,\"expires_at\":%lld,"
                     "\"idempotency_key\":\"idem-b1-0003\",\"command\":\"sys.info\",\"params\":{},"
                     "\"timeout_ms\":5000,\"mode\":\"weird\",\"signature\":\"TEST-UNSIGNED\"}",
                     now, now + 60);
            CHECK(!lea_parse_envelope(b1env, now, &env), "b1-parse-mode-bad-rejected");
            /* deadline_ms 越界（0／>120000）即整单拒绝。 */
            snprintf(b1env, sizeof(b1env),
                     "{\"version\":2,\"request_id\":\"req-b1-0004\",\"batch_id\":\"batch-0001\","
                     "\"seq\":1,\"device_id\":\"node-1\",\"account_id\":\"alice\","
                     "\"api_key_id\":\"key-abc12345\",\"binding_epoch\":3,\"grant_epoch\":1,"
                     "\"nonce\":\"nonce-b1-004\",\"issued_at\":%lld,\"expires_at\":%lld,"
                     "\"idempotency_key\":\"idem-b1-0004\",\"command\":\"sys.info\",\"params\":{},"
                     "\"timeout_ms\":5000,\"deadline_ms\":0,\"signature\":\"TEST-UNSIGNED\"}",
                     now, now + 60);
            CHECK(!lea_parse_envelope(b1env, now, &env), "b1-parse-deadline-0-rejected");
            snprintf(b1env, sizeof(b1env),
                     "{\"version\":2,\"request_id\":\"req-b1-0005\",\"batch_id\":\"batch-0001\","
                     "\"seq\":1,\"device_id\":\"node-1\",\"account_id\":\"alice\","
                     "\"api_key_id\":\"key-abc12345\",\"binding_epoch\":3,\"grant_epoch\":1,"
                     "\"nonce\":\"nonce-b1-005\",\"issued_at\":%lld,\"expires_at\":%lld,"
                     "\"idempotency_key\":\"idem-b1-0005\",\"command\":\"sys.info\",\"params\":{},"
                     "\"timeout_ms\":5000,\"deadline_ms\":120001,\"signature\":\"TEST-UNSIGNED\"}",
                     now, now + 60);
            CHECK(!lea_parse_envelope(b1env, now, &env), "b1-parse-deadline-over-rejected");
            /* job_id 含非法字符即整单拒绝。 */
            snprintf(b1env, sizeof(b1env),
                     "{\"version\":2,\"request_id\":\"req-b1-0006\",\"batch_id\":\"batch-0001\","
                     "\"seq\":1,\"device_id\":\"node-1\",\"account_id\":\"alice\","
                     "\"api_key_id\":\"key-abc12345\",\"binding_epoch\":3,\"grant_epoch\":1,"
                     "\"nonce\":\"nonce-b1-006\",\"issued_at\":%lld,\"expires_at\":%lld,"
                     "\"idempotency_key\":\"idem-b1-0006\",\"command\":\"sys.info\",\"params\":{},"
                     "\"timeout_ms\":5000,\"job_id\":\"job bad!\",\"signature\":\"TEST-UNSIGNED\"}",
                     now, now + 60);
            CHECK(!lea_parse_envelope(b1env, now, &env), "b1-parse-job-id-bad-rejected");
            /* 不带 B1 字段的老信封仍通过（向后兼容）。 */
            make_envelope(b1env, sizeof(b1env), now, "sys.info", "{}", 3, "node-1",
                          "alice", "idem-b1-0007", "nonce-b1-007", "req-b1-0007", "TEST-UNSIGNED");
            CHECK(lea_parse_envelope(b1env, now, &env), "b1-parse-legacy-ok");
            CHECK(env.job_id[0] == '\0' && env.mode[0] == '\0' && !env.has_deadline,
                  "b1-parse-legacy-defaults");
        }
    }

    /* ---------- S-022：取消状态机＋可取消性＋队列取消＋job 查询 ---------- */
    {
        /* 状态名往返 */
        CHECK_STR_EQ(lea_idem_status_name(LEA_IDEM_CANCEL_REQUESTED), "CANCEL_REQUESTED",
                     "s022-name-cancel-requested");
        CHECK_STR_EQ(lea_idem_status_name(LEA_IDEM_CANCELLING), "CANCELLING",
                     "s022-name-cancelling");
        CHECK_STR_EQ(lea_idem_status_name(LEA_IDEM_CANCELLED), "CANCELLED",
                     "s022-name-cancelled");
        CHECK(lea_idem_status_from_name("CANCEL_REQUESTED") == LEA_IDEM_CANCEL_REQUESTED,
              "s022-from-name-cancel-requested");
        CHECK(lea_idem_status_from_name("CANCELLING") == LEA_IDEM_CANCELLING,
              "s022-from-name-cancelling");
        CHECK(lea_idem_status_from_name("CANCELLED") == LEA_IDEM_CANCELLED,
              "s022-from-name-cancelled");
        /* 迁移表 */
        CHECK(lea_idem_transition_ok(LEA_IDEM_RECEIVED, LEA_IDEM_CANCELLED),
              "s022-trans-received-cancelled");
        CHECK(lea_idem_transition_ok(LEA_IDEM_RUNNING, LEA_IDEM_CANCEL_REQUESTED),
              "s022-trans-running-request");
        CHECK(lea_idem_transition_ok(LEA_IDEM_CANCEL_REQUESTED, LEA_IDEM_CANCELLING),
              "s022-trans-requested-cancelling");
        CHECK(lea_idem_transition_ok(LEA_IDEM_CANCELLING, LEA_IDEM_CANCELLED),
              "s022-trans-cancelling-cancelled");
        CHECK(lea_idem_transition_ok(LEA_IDEM_CANCEL_REQUESTED, LEA_IDEM_SUCCEEDED),
              "s022-trans-requested-natural-complete");
        CHECK(!lea_idem_transition_ok(LEA_IDEM_RUNNING, LEA_IDEM_CANCELLING),
              "s022-trans-running-cancelling-illegal");
        CHECK(!lea_idem_transition_ok(LEA_IDEM_SUCCEEDED, LEA_IDEM_CANCELLED),
              "s022-trans-succeeded-cancelled-illegal");
        CHECK(!lea_idem_transition_ok(LEA_IDEM_CANCELLED, LEA_IDEM_RUNNING),
              "s022-trans-cancelled-terminal");
        CHECK(!lea_idem_transition_ok(LEA_IDEM_FAILED, LEA_IDEM_CANCEL_REQUESTED),
              "s022-trans-failed-request-illegal");
        /* 取消三步 */
        static lea_idem_t tc;
        lea_idem_init(&tc);
        lea_idem_entry_t *ec = lea_idem_get_or_create(&tc, "node-1", "alice", "k-cancel-1", 0, now);
        CHECK(!lea_idem_request_cancel(&tc, ec, now),
              "s022-request-cancel-from-received-illegal");
        lea_idem_set_status(&tc, ec, LEA_IDEM_RUNNING, NULL, now);
        CHECK(lea_idem_request_cancel(&tc, ec, now) && ec->status == LEA_IDEM_CANCEL_REQUESTED,
              "s022-request-cancel-running-ok");
        CHECK(!lea_idem_request_cancel(&tc, ec, now),
              "s022-request-cancel-twice-illegal");
        CHECK(lea_idem_mark_cancelling(&tc, ec, now) && ec->status == LEA_IDEM_CANCELLING,
              "s022-mark-cancelling-ok");
        CHECK(lea_idem_mark_cancelled(&tc, ec, "{\"ok\":false,\"code\":\"QFR_LEA_CANCELLED\"}", now) &&
              ec->status == LEA_IDEM_CANCELLED,
              "s022-mark-cancelled-ok");
        CHECK(!lea_idem_mark_cancelled(&tc, ec, NULL, now),
              "s022-mark-cancelled-twice-illegal");
        CHECK(!lea_idem_request_cancel(&tc, ec, now),
              "s022-request-cancel-terminal-illegal");
        /* 排队取消路径：RUNNING 直接记 CANCELLED */
        lea_idem_entry_t *ec2 = lea_idem_get_or_create(&tc, "node-1", "alice", "k-cancel-2", 0, now);
        lea_idem_set_status(&tc, ec2, LEA_IDEM_RUNNING, NULL, now);
        CHECK(lea_idem_mark_cancelled(&tc, ec2, NULL, now) && ec2->status == LEA_IDEM_CANCELLED,
              "s022-mark-cancelled-from-running-ok");
        /* 崩溃恢复：取消未完成 → UNKNOWN；已取消不动 */
        lea_idem_entry_t *ec3 = lea_idem_get_or_create(&tc, "node-1", "alice", "k-cancel-3", 0, now);
        lea_idem_set_status(&tc, ec3, LEA_IDEM_RUNNING, NULL, now);
        lea_idem_request_cancel(&tc, ec3, now);
        lea_idem_entry_t *ec4 = lea_idem_get_or_create(&tc, "node-1", "alice", "k-cancel-4", 0, now);
        lea_idem_set_status(&tc, ec4, LEA_IDEM_RUNNING, NULL, now);
        lea_idem_request_cancel(&tc, ec4, now);
        lea_idem_mark_cancelling(&tc, ec4, now);
        CHECK(lea_idem_mark_crashed_unknown(&tc, now) == 2,
              "s022-crash-unknown-counts-cancel-states");
        CHECK(ec3->status == LEA_IDEM_UNKNOWN && ec4->status == LEA_IDEM_UNKNOWN,
              "s022-crash-unknown-cancel-states");
        CHECK(ec->status == LEA_IDEM_CANCELLED, "s022-crash-keeps-cancelled");
        /* CANCELLED 是终态，可被 prune 清理 */
        ec->updated_at = now - (31L * 86400);
        CHECK(lea_idem_prune(&tc, now) >= 1, "s022-prune-cancelled-terminal");
        /* 可取消性表 */
        CHECK(!lea_command_is_cancellable(&(lea_envelope_t){ .command = "script.run", .params_raw = "{}" }),
              "s022-script-run-not-cancellable");
        CHECK(!lea_command_is_cancellable(&(lea_envelope_t){ .command = "file.write", .params_raw = "{}" }),
              "s022-file-write-not-cancellable");
        CHECK(lea_command_is_cancellable(&(lea_envelope_t){ .command = "ui.click", .params_raw = "{}" }),
              "s022-ui-click-cancellable");
        CHECK(!lea_command_is_cancellable(&(lea_envelope_t){ .command = "ui.click", .params_raw = "{\"dangerous\":true}" }),
              "s022-ui-click-dangerous-not-cancellable");
        CHECK(!lea_command_is_cancellable(&(lea_envelope_t){ .command = "ui.input", .params_raw = "{\"dangerous\":true}" }),
              "s022-ui-input-dangerous-not-cancellable");
        CHECK(lea_command_is_cancellable(&(lea_envelope_t){ .command = "file.read", .params_raw = "{}" }),
              "s022-file-read-cancellable");
        CHECK(lea_command_is_cancellable(&(lea_envelope_t){ .command = "ui.snapshot", .params_raw = "{}" }),
              "s022-ui-snapshot-cancellable");
        CHECK(lea_command_is_cancellable(&(lea_envelope_t){ .command = "app.open", .params_raw = "{}" }),
              "s022-app-open-cancellable");
        CHECK(!lea_command_is_cancellable(&(lea_envelope_t){ .command = "sys.info", .params_raw = "{}" }),
              "s022-sys-info-inline-not-cancellable");
        CHECK(!lea_command_is_cancellable(&(lea_envelope_t){ .command = "sys.ping", .params_raw = "{}" }),
              "s022-sys-ping-inline-not-cancellable");
        CHECK(!lea_command_is_cancellable(&(lea_envelope_t){ .command = "no.such", .params_raw = "{}" }),
              "s022-unknown-not-cancellable");
        /* 队列按 job 查找与摘除 */
        static lea_queue_t qc;
        lea_queue_init(&qc);
        static lea_queue_item_t qi[3];
        memset(qi, 0, sizeof(qi));
        snprintf(qi[0].env.request_id, sizeof(qi[0].env.request_id), "%s", "req-s022-a");
        snprintf(qi[0].env.job_id, sizeof(qi[0].env.job_id), "%s", "job-s022-a");
        snprintf(qi[0].env.command, sizeof(qi[0].env.command), "%s", "ui.snapshot");
        qi[0].dangerous = 0;
        snprintf(qi[1].env.request_id, sizeof(qi[1].env.request_id), "%s", "req-s022-b");
        snprintf(qi[1].env.job_id, sizeof(qi[1].env.job_id), "%s", "job-s022-b");
        snprintf(qi[1].env.command, sizeof(qi[1].env.command), "%s", "script.run");
        qi[1].dangerous = 1;
        snprintf(qi[2].env.request_id, sizeof(qi[2].env.request_id), "%s", "req-s022-c");
        snprintf(qi[2].env.job_id, sizeof(qi[2].env.job_id), "%s", "");
        snprintf(qi[2].env.command, sizeof(qi[2].env.command), "%s", "file.read");
        qi[2].dangerous = 0;
        char qerr[64] = { 0 };
        CHECK(lea_queue_enqueue(&qc, &qi[0], qerr, sizeof(qerr)), "s022-enqueue-a");
        CHECK(lea_queue_enqueue(&qc, &qi[1], qerr, sizeof(qerr)), "s022-enqueue-b");
        CHECK(lea_queue_enqueue(&qc, &qi[2], qerr, sizeof(qerr)), "s022-enqueue-c");
        CHECK(lea_queue_find_by_request_id(&qc, "job-s022-a") == &qi[0],
              "s022-find-by-job-id");
        CHECK(lea_queue_find_by_request_id(&qc, "req-s022-c") == &qi[2],
              "s022-find-by-request-id-fallback");
        CHECK(lea_queue_find_by_request_id(&qc, "job-nope") == NULL,
              "s022-find-missing-null");
        CHECK(lea_queue_find_by_request_id(&qc, "") == NULL,
              "s022-find-empty-null");
        lea_queue_item_t *got = lea_queue_cancel_by_request_id(&qc, "job-s022-b");
        CHECK(got == &qi[1], "s022-cancel-danger-lane-item");
        CHECK(lea_queue_total(&qc) == 2, "s022-cancel-total-2");
        CHECK(lea_queue_dequeue(&qc) == &qi[0], "s022-dequeue-after-cancel-a");
        CHECK(lea_queue_dequeue(&qc) == &qi[2], "s022-dequeue-after-cancel-c");
        CHECK(lea_queue_cancel_by_request_id(&qc, "job-s022-a") == NULL,
              "s022-cancel-already-gone-null");
        /* 幂等 job 字段持久化往返＋旧行兼容 */
        static lea_idem_t tj, tj2;
        lea_idem_init(&tj);
        lea_idem_entry_t *ej = lea_idem_get_or_create(&tj, "node-1", "alice", "k-job-1", 0, now);
        snprintf(ej->request_id, sizeof(ej->request_id), "%s", "req-job-1");
        snprintf(ej->job_id, sizeof(ej->job_id), "%s", "job-1");
        snprintf(ej->command, sizeof(ej->command), "%s", "ui.snapshot");
        lea_idem_set_status(&tj, ej, LEA_IDEM_SUCCEEDED, "{\"ok\":true,\"code\":\"done\"}", now);
        static char jsaved[65536];
        CHECK(lea_idem_save_text(&tj, jsaved, sizeof(jsaved)), "s022-job-save-text");
        CHECK(strstr(jsaved, "\"job_id\":\"job-1\"") != NULL, "s022-job-saved-has-job-id");
        CHECK(strstr(jsaved, "\"command\":\"ui.snapshot\"") != NULL, "s022-job-saved-has-command");
        CHECK(lea_idem_load_text(&tj2, jsaved), "s022-job-load-text");
        lea_idem_entry_t *ej2 = lea_idem_lookup_by_job(&tj2, "job-1");
        CHECK(ej2 != NULL && strcmp(ej2->request_id, "req-job-1") == 0 &&
              strcmp(ej2->command, "ui.snapshot") == 0, "s022-lookup-by-job-id");
        CHECK(lea_idem_lookup_by_job(&tj2, "req-job-1") == ej2,
              "s022-lookup-by-request-id");
        CHECK(lea_idem_lookup_by_job(&tj2, "job-nope") == NULL,
              "s022-lookup-by-job-missing");
        CHECK(lea_idem_lookup_by_job(&tj2, "") == NULL, "s022-lookup-by-job-empty");
        /* 旧行（无三字段）仍能加载，字段留空 */
        static lea_idem_t tj3;
        CHECK(lea_idem_load_line(&tj3, "{\"device_id\":\"node-1\",\"account_id\":\"alice\",\"key\":\"k-old\",\"status\":\"SUCCEEDED\",\"dangerous\":0,\"created_at\":1700000000,\"updated_at\":1700000000,\"result\":null}"),
              "s022-old-line-loads");
        lea_idem_entry_t *ej3 = lea_idem_lookup(&tj3, "node-1", "alice", "k-old");
        CHECK(ej3 != NULL && ej3->request_id[0] == '\0' && ej3->job_id[0] == '\0' &&
              ej3->command[0] == '\0', "s022-old-line-fields-empty");
        CHECK(lea_idem_lookup_by_job(&tj3, "job-1") == NULL,
              "s022-old-line-lookup-miss");
    }


    /* Completeness review: exercise rejection boundaries against real parsers,
     * not source-shape assertions. */
    {
        char field[256] = {0};
        long long number = 0;
        int flag = 0;
        CHECK(lea_json_string("{\"nested\":{\"path\":\"wrong\"},\"path\":\"right\"}", "path", field, sizeof(field)) &&
              strcmp(field, "right") == 0, "m070-top-level-string-not-shadowed");
        CHECK(!lea_json_string("{\"path\":\"a\",\"path\":\"b\"}", "path", field, sizeof(field)), "m070-duplicate-field-rejected");
        CHECK(!lea_json_long("{\"n\":12oops}", "n", &number), "m070-invalid-number-tail-rejected");
        CHECK(lea_json_long("{\"nested\":{\"n\":4},\"n\":12}", "n", &number) && number == 12, "m070-top-level-number-not-shadowed");
        CHECK(!lea_json_bool("{\"nested\":{\"dangerous\":true}}", "dangerous", &flag), "m071-nested-dangerous-not-authoritative");
        CHECK(!lea_json_bool("{\"dangerous\":trueX}", "dangerous", &flag), "m071-invalid-boolean-tail-rejected");
        char args[2][512];
        CHECK(lea_params_string_array("{\"nested\":{\"args\":[\"bad\"]},\"args\":[\"good\"]}", "args", args, 2) == 1 &&
              strcmp(args[0], "good") == 0, "m071-array-not-shadowed");
        CHECK(lea_params_string_array("{\"args\":[\"a\",]}", "args", args, 2) < 0, "m071-array-trailing-comma-rejected");
        CHECK(!lea_json_is_valid("{\"s\":\"\xc0\xaf\"}"), "m072-overlong-utf8-rejected");
        CHECK(!lea_json_is_valid("{\"s\":\"\xed\xa0\x80\"}"), "m072-raw-surrogate-rejected");
        CHECK(!lea_json_is_valid("{\"s\":\"\xf4\x90\x80\x80\"}"), "m072-utf8-above-unicode-rejected");
        CHECK(!lea_json_is_valid("{\"s\":\"\\uD800\"}"), "m072-lone-high-surrogate-rejected");
        CHECK(!lea_json_is_valid("{\"s\":\"\\uDC00\"}"), "m072-lone-low-surrogate-rejected");
        CHECK(lea_json_string("{\"s\":\"\\uD83D\\uDE00\"}", "s", field, sizeof(field)) &&
              strcmp(field, "\xf0\x9f\x98\x80") == 0, "m072-surrogate-pair-decodes");
        CHECK(lea_json_insert_string_field("{}", "token", "abc", field, sizeof(field)) &&
              lea_json_is_valid(field) && strcmp(field, "{\"token\":\"abc\"}") == 0, "m073-empty-object-insertion-valid");
        CHECK(!lea_json_insert_string_field("{\"token\":\"old\"}", "token", "new", field, sizeof(field)), "m073-insertion-duplicate-rejected");
        unsigned char decoded[16];
        CHECK(lea_b64_decode("Zg==", decoded, sizeof(decoded)) == 1 && decoded[0] == 'f', "m068-base64-canonical-accepted");
        CHECK(lea_b64_decode("Zh==", decoded, sizeof(decoded)) < 0, "m068-base64-tail-bits-rejected");
        CHECK(lea_b64_decode("Zm9=", decoded, sizeof(decoded)) < 0, "m068-base64-two-byte-tail-bits-rejected");
        CHECK(lea_b64_decode("Zg===", decoded, sizeof(decoded)) < 0, "m068-base64-extra-padding-rejected");
        char tiny[3] = {'x','x','x'};
        lea_redact_key_prefix("synthetic-prefix", tiny, sizeof(tiny));
        CHECK(tiny[0] == 0, "m069-short-redaction-buffer-cleared");
        char digest[65] = "not-a-digest";
        CHECK(!lea_sha256_file_hex("/tmp", digest) && digest[0] == 0, "m067-directory-read-error-not-valid-hash");
        char quoted[128];
        CHECK(lea_quote_arg("a b", quoted, sizeof(quoted)) && strcmp(quoted, "\"a b\"") == 0, "m085-quote-spaces");
        CHECK(lea_quote_arg("a\\", quoted, sizeof(quoted)) && strcmp(quoted, "\"a\\\\\"") == 0, "m085-quote-trailing-backslash");
        CHECK(!lea_quote_arg("too-long", tiny, sizeof(tiny)) && tiny[0] == 0, "m085-quote-overflow-rejected-cleared");
        wchar_t command[12] = L"\"app\"";
        CHECK(!lea_wide_arg_append(command, 12, L"\"oversized\"") && wcscmp(command, L"\"app\"") == 0,
              "m011-command-overflow-keeps-executable");
        CHECK(lea_wide_arg_append(command, 12, L"\"x\"") && wcscmp(command, L"\"app\" \"x\"") == 0,
              "m011-command-checked-append");
        char long_a[129], long_b[129];
        memset(long_a, 'a', 128); long_a[128] = 0;
        memcpy(long_b, long_a, sizeof(long_b)); long_b[127] = 'b';
        static lea_replay_t lr;
        lea_replay_init(&lr);
        CHECK(lea_replay_check_and_add(&lr, long_a, "nonce-long-a", now), "m079-replay-long-request-first");
        CHECK(!lea_replay_check_and_add(&lr, long_a, "nonce-long-b", now), "m079-replay-long-request-duplicate");
        CHECK(lea_replay_check_and_add(&lr, long_b, "nonce-long-c", now), "m079-replay-distinct-long-request");
        static lea_idem_t li;
        lea_idem_init(&li);
        CHECK(lea_idem_get_or_create(&li, "node-1", "alice", long_a, 0, now) != NULL &&
              lea_idem_lookup(&li, "node-1", "alice", long_a) != NULL, "m079-idempotency-long-key-roundtrip");
        char rev_json[256], rev_ids[1][129], rev_path[128];
        snprintf(rev_json, sizeof(rev_json), "{\"key_ids\":[\"%s\"]}", long_a);
        CHECK(lea_json_top_level_string_array(rev_json, "key_ids", rev_ids, 1) == 1 &&
              strcmp(rev_ids[0], long_a) == 0, "m012-revocation-sync-128-byte-key");
        snprintf(rev_path, sizeof(rev_path), "/tmp/lea-long-revoked-%ld", (long)getpid());
        const char *keys[] = {long_a};
        CHECK(lea_revoked_write(rev_path, keys, 1), "m012-revocation-long-key-write");
        CHECK(lea_revoked_check(rev_path, long_a, 0, 0, NULL) == LEA_REVOCATION_REVOKED, "m012-revocation-long-key-enforced");
        remove(rev_path);
    }

    printf("\n==== LEA core tests: %d passed, %d failed ====\n", g_pass, g_fail);
    return g_fail ? 1 : 0;
}
