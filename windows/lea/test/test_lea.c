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
#include <time.h>
#include <unistd.h>
#include "../lea_protocol.h"
#include "../lea_crypto.h"
#include "../lea_state.h"
#include "../lea_audit.h"
#include "../whitelist.h" /* H16：app.open 白名单 hash（W_USH_EXE_SHA256）须与发版 USH 一致 */

static int g_pass = 0, g_fail = 0;
#define CHECK(cond, name) do { \
    if (cond) { g_pass++; printf("PASS %s\n", name); } \
    else { g_fail++; printf("FAIL %s\n", name); } \
} while (0)
#define CHECK_STR_EQ(a, b, name) CHECK(strcmp((a), (b)) == 0, name)

/* 构造一个有效信封（除可覆盖字段外均合法）。 */
static void make_envelope(char *out, size_t out_size, long long now,
                          const char *command, const char *params,
                          long long binding_epoch, const char *device_id,
                          const char *account_id, const char *idem_key,
                          const char *nonce, const char *request_id,
                          const char *signature) {
    snprintf(out, out_size,
             "{\"version\":1,\"request_id\":\"%s\",\"batch_id\":\"batch-0001\","
             "\"seq\":1,\"device_id\":\"%s\",\"account_id\":\"%s\","
             "\"api_key_id\":\"key-abc12345\",\"binding_epoch\":%lld,"
             "\"nonce\":\"%s\",\"issued_at\":%lld,\"expires_at\":%lld,"
             "\"idempotency_key\":\"%s\",\"command\":\"%s\",\"params\":%s,"
             "\"timeout_ms\":5000,\"signature\":\"%s\"}",
             request_id, device_id, account_id, binding_epoch,
             nonce, now, now + 60, idem_key, command,
             params ? params : "{}", signature);
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
                 "{\"version\":1,\"request_id\":\"req-0000002\",\"seq\":1,\"device_id\":\"node-1\","
                 "\"account_id\":\"alice\",\"api_key_id\":\"key-abc12345\","
                 "\"binding_epoch\":3,\"nonce\":\"nonce-00002\",\"issued_at\":%lld,"
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
        /* 版本错误 */
        snprintf(bad, sizeof(bad), "%s", env_buf);
        char *v = strstr(bad, "\"version\":1");
        if (v) v[10] = '2';
        CHECK(!lea_parse_envelope(bad, now, &env) && strcmp(env.error, "QFR_LEA_BAD_ENVELOPE") == 0,
              "parse-bad-version");
        /* 未知命令 */
        make_envelope(bad, sizeof(bad), now, "rm.everything", "{}", 3, "node-1",
                      "alice", "idem-key-0003", "nonce-00003", "req-0000003", "TEST-UNSIGNED");
        CHECK(!lea_parse_envelope(bad, now, &env), "parse-unknown-command");
        /* 时间窗超 60s */
        snprintf(bad, sizeof(bad),
                 "{\"version\":1,\"request_id\":\"req-0000004\",\"seq\":1,\"device_id\":\"node-1\","
                 "\"account_id\":\"alice\",\"api_key_id\":\"key-abc12345\","
                 "\"binding_epoch\":3,\"nonce\":\"nonce-00004\",\"issued_at\":%lld,"
                 "\"expires_at\":%lld,\"idempotency_key\":\"idem-key-0004\","
                 "\"command\":\"sys.info\",\"params\":{},\"signature\":\"TEST-UNSIGNED\"}",
                 now, now + 61);
        CHECK(!lea_parse_envelope(bad, now, &env) && strcmp(env.error, "QFR_REPLAY_DETECTED") == 0,
              "parse-expires-window-gt-60s");
        /* 过期信封 */
        snprintf(bad, sizeof(bad),
                 "{\"version\":1,\"request_id\":\"req-0000005\",\"seq\":1,\"device_id\":\"node-1\","
                 "\"account_id\":\"alice\",\"api_key_id\":\"key-abc12345\","
                 "\"binding_epoch\":3,\"nonce\":\"nonce-00005\",\"issued_at\":%lld,"
                 "\"expires_at\":%lld,\"idempotency_key\":\"idem-key-0005\","
                 "\"command\":\"sys.info\",\"params\":{},\"signature\":\"TEST-UNSIGNED\"}",
                 now - 120, now - 60);
        CHECK(!lea_parse_envelope(bad, now, &env), "parse-expired-envelope");
        /* timeout_ms 超上限（script.run 上限 300000） */
        snprintf(bad, sizeof(bad),
                 "{\"version\":1,\"request_id\":\"req-0000006\",\"seq\":1,\"device_id\":\"node-1\","
                 "\"account_id\":\"alice\",\"api_key_id\":\"key-abc12345\","
                 "\"binding_epoch\":3,\"nonce\":\"nonce-00006\",\"issued_at\":%lld,"
                 "\"expires_at\":%lld,\"idempotency_key\":\"idem-key-0006\","
                 "\"command\":\"script.run\",\"params\":{},\"timeout_ms\":999999,"
                 "\"signature\":\"TEST-UNSIGNED\"}", now, now + 60);
        CHECK(!lea_parse_envelope(bad, now, &env), "parse-timeout-over-max");
        /* 缺 idempotency_key */
        snprintf(bad, sizeof(bad),
                 "{\"version\":1,\"request_id\":\"req-0000007\",\"seq\":1,\"device_id\":\"node-1\","
                 "\"account_id\":\"alice\",\"api_key_id\":\"key-abc12345\","
                 "\"binding_epoch\":3,\"nonce\":\"nonce-00007\",\"issued_at\":%lld,"
                 "\"expires_at\":%lld,\"command\":\"sys.info\",\"params\":{},"
                 "\"signature\":\"TEST-UNSIGNED\"}", now, now + 60);
        CHECK(!lea_parse_envelope(bad, now, &env), "parse-missing-idempotency-key");
    }

    /* ---------- 签名验签占位 ---------- */
    {
        char reason[128] = { 0 };
        /* 格式错误的签名一律拒绝 */
        CHECK(!lea_verify_envelope_signature("short", "", reason, sizeof(reason)) &&
              strcmp(reason, "bad-signature-format") == 0, "sig-malformed-rejected");
        CHECK(!lea_sig_format_ok("short"), "sig-format-short");
        /* 64 字节签名的 base64url（86 字符）格式合理 */
        char sig86[92];
        memset(sig86, 'A', 86);
        sig86[86] = '\0';
        CHECK(lea_sig_format_ok(sig86), "sig-format-86-ok");
#ifdef LEA_TEST_UNSIGNED
        CHECK(lea_server_pubkey_hex() == NULL, "sig-pubkey-not-configured");
        CHECK(!lea_verify_envelope_signature(sig86, "canonical", reason, sizeof(reason)) &&
              strcmp(reason, "ed25519-pubkey-not-configured") == 0,
              "sig-wellformed-but-no-pubkey-fail-closed");
        CHECK(lea_verify_envelope_signature("TEST-UNSIGNED", "canonical", reason, sizeof(reason)) &&
              strcmp(reason, "test-only-unsigned-accepted") == 0,
              "sig-test-unsigned-accepted-in-test-build");
#else
        CHECK(!lea_verify_envelope_signature(sig86, "canonical", reason, sizeof(reason)) &&
              strcmp(reason, "ed25519-pubkey-not-configured") == 0,
              "sig-strict-fail-closed");
        CHECK(!lea_verify_envelope_signature("TEST-UNSIGNED", "canonical", reason, sizeof(reason)),
              "sig-test-unsigned-rejected-in-strict-build");
#endif
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
        CHECK(!lea_binding_confirm(&b, 99, 1, 1, "muse.execute", "lease-1", now + 3600, "TEST-UNSIGNED", now),
              "bind-confirm-wrong-epoch");
        CHECK(lea_binding_confirm(&b, 1, 1, 1, "muse.execute", "lease-1", now + 3600, "TEST-UNSIGNED", now) &&
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
        CHECK(lea_binding_confirm(&b, 1, 1, 1, "muse.execute", "lease-0123456789abcdef",
                                  now + 3600, "TEST-UNSIGNED", now) &&
              b.state == LEA_BIND_ACTIVE, "h07-same-account-setup-active");
        CHECK(strcmp(b.ticket_signature, "TEST-UNSIGNED") == 0, "h02-confirm-stores-signature");
        long long e2 = lea_binding_on_login(&b, "alice", "node-1", now);
        CHECK(e2 == e1 && b.state == LEA_BIND_PENDING, "h07-same-account-relogin-keeps-epoch");
        /* 同账号重登后仍可用同一票据确认（epoch 未变） */
        CHECK(lea_binding_confirm(&b, 1, 1, 1, "muse.execute", "lease-0123456789abcdef",
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

    /* ---------- H08：内部命令分流只认顶层 "cmd" ---------- */
    {
        char cmd[64] = { 0 };
        CHECK(lea_json_top_level_string("{\"cmd\":\"session.logout\"}", "cmd", cmd, sizeof(cmd)) &&
              strcmp(cmd, "session.logout") == 0, "h08-top-cmd-hit");
        /* params 内嵌套 "cmd" 不得命中（原全文查找会误判进 handle_internal） */
        CHECK(!lea_json_top_level_string(
                  "{\"version\":1,\"command\":\"ui.click\",\"params\":{\"cmd\":\"session.logout\"}}",
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

    /* ---------- 规范串 v1（S1/S2/S4；与 JS 单测同一向量） ---------- */
    {
        /* 信封向量：与 JS test-lea.js §7b 同一输入／同一期望串。 */
        static const char *vec_canonical =
            "qfr-lea-envelope-v1\n1\nreq-0000001\nbatch-0001\n1\nnode-1\nalice\n"
            "key-abc12345\n3\nnonce-00001\n1780000000\n1780000060\nidem-key-0001\n"
            "ui.click\n43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777\n5000";
        lea_envelope_t v;
        memset(&v, 0, sizeof(v));
        v.version = 1;
        snprintf(v.request_id, sizeof(v.request_id), "req-0000001");
        snprintf(v.batch_id, sizeof(v.batch_id), "batch-0001");
        v.seq = 1;
        snprintf(v.device_id, sizeof(v.device_id), "node-1");
        snprintf(v.account_id, sizeof(v.account_id), "alice");
        snprintf(v.api_key_id, sizeof(v.api_key_id), "key-abc12345");
        v.binding_epoch = 3;
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
                     "{\"version\":1,\"request_id\":\"req-0000001\",\"batch_id\":\"batch-0001\","
                     "\"seq\":1,\"device_id\":\"node-1\",\"account_id\":\"alice\","
                     "\"api_key_id\":\"key-abc12345\",\"binding_epoch\":3,"
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
        /* 篡改任一覆盖字段即改变规范串（params／account／timeout／seq／batch）。 */
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
            b.version = 2;
            CHECK(!lea_envelope_canonical(&b, canon, sizeof(canon)), "canonical-rejects-version-2");
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
                     "{\"version\":1,\"request_id\":\"req-0000009\",\"device_id\":\"node-1\","
                     "\"account_id\":\"alice\",\"api_key_id\":\"key-abc12345\","
                     "\"binding_epoch\":3,\"nonce\":\"nonce-00009\",\"issued_at\":%lld,"
                     "\"expires_at\":%lld,\"idempotency_key\":\"idem-key-0009\","
                     "\"command\":\"sys.info\",\"params\":{},\"signature\":\"TEST-UNSIGNED\"}",
                     now, now + 60);
            CHECK(!lea_parse_envelope(noseq, now, &env) &&
                  strcmp(env.error, "QFR_LEA_BAD_ENVELOPE") == 0, "parse-missing-seq-rejected");
            char seq0[4096];
            snprintf(seq0, sizeof(seq0),
                     "{\"version\":1,\"request_id\":\"req-0000010\",\"seq\":0,\"device_id\":\"node-1\","
                     "\"account_id\":\"alice\",\"api_key_id\":\"key-abc12345\","
                     "\"binding_epoch\":3,\"nonce\":\"nonce-00010\",\"issued_at\":%lld,"
                     "\"expires_at\":%lld,\"idempotency_key\":\"idem-key-0010\","
                     "\"command\":\"sys.info\",\"params\":{},\"signature\":\"TEST-UNSIGNED\"}",
                     now, now + 60);
            CHECK(!lea_parse_envelope(seq0, now, &env), "parse-seq-zero-rejected");
            char tmo0[4096];
            snprintf(tmo0, sizeof(tmo0),
                     "{\"version\":1,\"request_id\":\"req-0000011\",\"seq\":1,\"device_id\":\"node-1\","
                     "\"account_id\":\"alice\",\"api_key_id\":\"key-abc12345\","
                     "\"binding_epoch\":3,\"nonce\":\"nonce-00011\",\"issued_at\":%lld,"
                     "\"expires_at\":%lld,\"idempotency_key\":\"idem-key-0011\","
                     "\"command\":\"sys.info\",\"params\":{},\"timeout_ms\":0,"
                     "\"signature\":\"TEST-UNSIGNED\"}", now, now + 60);
            CHECK(!lea_parse_envelope(tmo0, now, &env), "parse-timeout-zero-rejected");
            /* timeout_ms: null 是显式非法值，不得当缺失回退默认。 */
            snprintf(tmo0, sizeof(tmo0),
                     "{\"version\":1,\"request_id\":\"req-0000011\",\"seq\":1,\"device_id\":\"node-1\","
                     "\"account_id\":\"alice\",\"api_key_id\":\"key-abc12345\","
                     "\"binding_epoch\":3,\"nonce\":\"nonce-00011\",\"issued_at\":%lld,"
                     "\"expires_at\":%lld,\"idempotency_key\":\"idem-key-0011\","
                     "\"command\":\"sys.info\",\"params\":{},\"timeout_ms\":null,"
                     "\"signature\":\"TEST-UNSIGNED\"}", now, now + 60);
            CHECK(!lea_parse_envelope(tmo0, now, &env), "parse-timeout-null-rejected");
            /* 嵌套遮蔽：params 含 "timeout_ms":5000 且顶层为 null → 必须拒绝，
             * 不得用全文查找命中嵌套值把顶层 null 洗成 5000。 */
            snprintf(tmo0, sizeof(tmo0),
                     "{\"version\":1,\"request_id\":\"req-0000011\",\"seq\":1,\"device_id\":\"node-1\","
                     "\"account_id\":\"alice\",\"api_key_id\":\"key-abc12345\","
                     "\"binding_epoch\":3,\"nonce\":\"nonce-00011\",\"issued_at\":%lld,"
                     "\"expires_at\":%lld,\"idempotency_key\":\"idem-key-0011\","
                     "\"command\":\"sys.info\",\"params\":{\"timeout_ms\":5000},\"timeout_ms\":null,"
                     "\"signature\":\"TEST-UNSIGNED\"}", now, now + 60);
            CHECK(!lea_parse_envelope(tmo0, now, &env), "parse-timeout-nested-shadow-null-rejected");
            /* 顶层胜出：params 嵌套 6000、顶层 5000 → 解析成功且取顶层值 5000。 */
            snprintf(tmo0, sizeof(tmo0),
                     "{\"version\":1,\"request_id\":\"req-0000011\",\"seq\":1,\"device_id\":\"node-1\","
                     "\"account_id\":\"alice\",\"api_key_id\":\"key-abc12345\","
                     "\"binding_epoch\":3,\"nonce\":\"nonce-00011\",\"issued_at\":%lld,"
                     "\"expires_at\":%lld,\"idempotency_key\":\"idem-key-0011\","
                     "\"command\":\"sys.info\",\"params\":{\"timeout_ms\":6000},\"timeout_ms\":5000,"
                     "\"signature\":\"TEST-UNSIGNED\"}", now, now + 60);
            CHECK(lea_parse_envelope(tmo0, now, &env) && env.has_timeout && env.timeout_ms == 5000,
                  "parse-timeout-top-level-wins-over-nested");
            /* 嵌套不被采纳：顶层缺失、params 嵌套 5000 → has_timeout 为 0，取命令默认值。 */
            snprintf(tmo0, sizeof(tmo0),
                     "{\"version\":1,\"request_id\":\"req-0000011\",\"seq\":1,\"device_id\":\"node-1\","
                     "\"account_id\":\"alice\",\"api_key_id\":\"key-abc12345\","
                     "\"binding_epoch\":3,\"nonce\":\"nonce-00011\",\"issued_at\":%lld,"
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
                     "{\"version\":1,\"request_id\":\"req-0000012\",\"seq\":4294967297,\"device_id\":\"node-1\","
                     "\"account_id\":\"alice\",\"api_key_id\":\"key-abc12345\","
                     "\"binding_epoch\":3,\"nonce\":\"nonce-00012\",\"issued_at\":%lld,"
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
                     "{\"version\":1,\"request_id\":\"req-0000013\",\"seq\":9999999999999999999999,\"device_id\":\"node-1\","
                     "\"account_id\":\"alice\",\"api_key_id\":\"key-abc12345\","
                     "\"binding_epoch\":3,\"nonce\":\"nonce-00013\",\"issued_at\":%lld,"
                     "\"expires_at\":%lld,\"idempotency_key\":\"idem-key-0013\","
                     "\"command\":\"sys.info\",\"params\":{},\"signature\":\"TEST-UNSIGNED\"}",
                     now, now + 60);
            CHECK(!lea_parse_envelope(ovf, now, &be), "parse-seq-overflow-rejected");
        }
        /* 解析层：含 DEL 的 account_id 拒绝。 */
        {
            char bad[4096];
            snprintf(bad, sizeof(bad),
                     "{\"version\":1,\"request_id\":\"req-0000008\",\"seq\":1,\"device_id\":\"node-1\","
                     "\"account_id\":\"al\x7f" "ice\",\"api_key_id\":\"key-abc12345\","
                     "\"binding_epoch\":3,\"nonce\":\"nonce-00008\",\"issued_at\":%lld,"
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
        e.version = 1;
        snprintf(e.request_id, sizeof(e.request_id), "req-0000009");
        snprintf(e.batch_id, sizeof(e.batch_id), "batch-0001");
        e.seq = 1;
        snprintf(e.device_id, sizeof(e.device_id), "no\\de-1");
        snprintf(e.account_id, sizeof(e.account_id), "al\"ice");
        snprintf(e.api_key_id, sizeof(e.api_key_id), "key-abc12345");
        e.binding_epoch = 3;
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
        /* 重建行可再解析，且字段原样回来（无注入、无断裂）。 */
        lea_envelope_t back;
        CHECK(lea_parse_envelope(line, now, &back), "rebuild-line-reparses");
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
            f.version = 1;
            snprintf(f.request_id, sizeof(f.request_id), "req-\"000010\"");
            f.seq = 1;
            snprintf(f.device_id, sizeof(f.device_id), "node-1");
            snprintf(f.account_id, sizeof(f.account_id), "alice");
            snprintf(f.api_key_id, sizeof(f.api_key_id), "key-abc12345");
            f.binding_epoch = 3;
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
            f2.version = 1;
            snprintf(f2.request_id, sizeof(f2.request_id), "req-0000010");
            snprintf(f2.batch_id, sizeof(f2.batch_id), "ba\"tch\\-0001");
            f2.seq = 1;
            snprintf(f2.device_id, sizeof(f2.device_id), "no\"de\\-1");
            snprintf(f2.account_id, sizeof(f2.account_id), "al\"ice\\x");
            snprintf(f2.api_key_id, sizeof(f2.api_key_id), "key-\"abc");
            f2.binding_epoch = 3;
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
                    "{\"version\":1,\"request_id\":\"req-m22a01\",\"batch_id\":\"batch-0001\","
                    "\"seq\":1,\"device_id\":\"node-1\",\"account_id\":\"alice\","
                    "\"api_key_id\":\"key-abc12345\",\"binding_epoch\":3,\"nonce\":\"nonce-m22a01\","
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
                    "{\"version\":1,\"request_id\":\"req-m22b01\",\"batch_id\":\"batch-0001\","
                    "\"seq\":1,\"device_id\":\"node-1\",\"account_id\":\"alice\","
                    "\"api_key_id\":\"key-abc12345\",\"binding_epoch\":3,\"nonce\":\"nonce-m22b01\","
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
                    "{\"version\":1,\"request_id\":\"req-m22c01\",\"batch_id\":\"batch-0001\","
                    "\"seq\":1,\"device_id\":\"node-1\",\"account_id\":\"alice\","
                    "\"api_key_id\":\"key-abc12345\",\"binding_epoch\":3,\"nonce\":\"nonce-m22c01\","
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
        char ids[8][128];
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

    printf("\n==== LEA core tests: %d passed, %d failed ====\n", g_pass, g_fail);
    return g_fail ? 1 : 0;
}
