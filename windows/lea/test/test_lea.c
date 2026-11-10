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
        /* 文件 hash：qf-agent-heal.ps1（与 whitelist.h 一致）。 */
        char fhex[65] = { 0 };
        const char *heal = "../../qf-agent-heal.ps1";
        if (access(heal, R_OK) == 0) {
            CHECK(lea_sha256_file_hex(heal, fhex), "sha256-file-readable");
            CHECK_STR_EQ(fhex, "96b4efbe9685ff1998dc80c8c59acdce32af4325611a6edd1cc3cf8896641257",
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
        CHECK(!lea_binding_confirm(&b, 99, 1, 1, "muse.execute", "lease-1", now + 3600, now),
              "bind-confirm-wrong-epoch");
        CHECK(lea_binding_confirm(&b, 1, 1, 1, "muse.execute", "lease-1", now + 3600, now) &&
              b.state == LEA_BIND_ACTIVE, "bind-confirm-active");
        CHECK(lea_binding_has_scope(&b, "muse.execute"), "bind-scope-hit");
        CHECK(!lea_binding_has_scope(&b, "muse.execute.dangerous"), "bind-scope-miss");
        long long e2 = lea_binding_on_login(&b, "bob", "node-1", now);
        CHECK(e2 == 2 && b.state == LEA_BIND_PENDING && b.grant_muse_execute == 0,
              "bind-relogin-revokes-old-epoch-plus-1");
        lea_binding_revoke(&b, now);
        CHECK(b.state == LEA_BIND_UNBOUND && b.epoch == 3, "bind-revoke-unbound-epoch-plus-1");
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

    printf("\n==== LEA core tests: %d passed, %d failed ====\n", g_pass, g_fail);
    return g_fail ? 1 : 0;
}
