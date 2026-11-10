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
 * 判定（路径部分＋文件 hash）、队列超限、审计脱敏、SHA-256 向量。
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
                 "{\"version\":1,\"request_id\":\"req-0000002\",\"device_id\":\"node-1\","
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
                 "{\"version\":1,\"request_id\":\"req-0000004\",\"device_id\":\"node-1\","
                 "\"account_id\":\"alice\",\"api_key_id\":\"key-abc12345\","
                 "\"binding_epoch\":3,\"nonce\":\"nonce-00004\",\"issued_at\":%lld,"
                 "\"expires_at\":%lld,\"idempotency_key\":\"idem-key-0004\","
                 "\"command\":\"sys.info\",\"params\":{},\"signature\":\"TEST-UNSIGNED\"}",
                 now, now + 61);
        CHECK(!lea_parse_envelope(bad, now, &env) && strcmp(env.error, "QFR_REPLAY_DETECTED") == 0,
              "parse-expires-window-gt-60s");
        /* 过期信封 */
        snprintf(bad, sizeof(bad),
                 "{\"version\":1,\"request_id\":\"req-0000005\",\"device_id\":\"node-1\","
                 "\"account_id\":\"alice\",\"api_key_id\":\"key-abc12345\","
                 "\"binding_epoch\":3,\"nonce\":\"nonce-00005\",\"issued_at\":%lld,"
                 "\"expires_at\":%lld,\"idempotency_key\":\"idem-key-0005\","
                 "\"command\":\"sys.info\",\"params\":{},\"signature\":\"TEST-UNSIGNED\"}",
                 now - 120, now - 60);
        CHECK(!lea_parse_envelope(bad, now, &env), "parse-expired-envelope");
        /* timeout_ms 超上限（script.run 上限 300000） */
        snprintf(bad, sizeof(bad),
                 "{\"version\":1,\"request_id\":\"req-0000006\",\"device_id\":\"node-1\","
                 "\"account_id\":\"alice\",\"api_key_id\":\"key-abc12345\","
                 "\"binding_epoch\":3,\"nonce\":\"nonce-00006\",\"issued_at\":%lld,"
                 "\"expires_at\":%lld,\"idempotency_key\":\"idem-key-0006\","
                 "\"command\":\"script.run\",\"params\":{},\"timeout_ms\":999999,"
                 "\"signature\":\"TEST-UNSIGNED\"}", now, now + 60);
        CHECK(!lea_parse_envelope(bad, now, &env), "parse-timeout-over-max");
        /* 缺 idempotency_key */
        snprintf(bad, sizeof(bad),
                 "{\"version\":1,\"request_id\":\"req-0000007\",\"device_id\":\"node-1\","
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

    printf("\n==== LEA core tests: %d passed, %d failed ====\n", g_pass, g_fail);
    return g_fail ? 1 : 0;
}
