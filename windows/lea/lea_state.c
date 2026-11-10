/* 见 lea_state.h */
#include "lea_state.h"
#include "lea_crypto.h"
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* ---------------- 绑定 ---------------- */
const char *lea_bind_state_name(lea_bind_state_t s) {
    switch (s) {
        case LEA_BIND_UNBOUND: return "UNBOUND";
        case LEA_BIND_PENDING: return "PENDING";
        case LEA_BIND_ACTIVE: return "ACTIVE";
        case LEA_BIND_REVOKING: return "REVOKING";
        default: return "UNKNOWN";
    }
}

void lea_binding_init(lea_binding_t *b) {
    memset(b, 0, sizeof(*b));
    b->state = LEA_BIND_UNBOUND;
    b->epoch = 0;
    b->grant_epoch = 0;
}

int lea_binding_has_scope(const lea_binding_t *b, const char *scope) {
    if (!b || !scope || scope[0] == '\0') return 0;
    /* scopes 为逗号分隔；精确匹配整段。 */
    const char *p = b->scopes;
    size_t slen = strlen(scope);
    while (*p) {
        while (*p == ' ' || *p == ',') p++;
        if (*p == '\0') break;
        const char *start = p;
        while (*p && *p != ',') p++;
        size_t n = (size_t)(p - start);
        while (n > 0 && start[n - 1] == ' ') n--;
        if (n == slen && strncmp(start, scope, n) == 0) return 1;
    }
    return 0;
}

long long lea_binding_on_login(lea_binding_t *b, const char *account_id,
                               const char *device_id, long long now_unix) {
    /* H07  epoch 协调：同账号重登（ACTIVE/PENDING 态下同一 account_id，
     * 如应用重启／静默重登）不升 epoch——服务端同账号换绑同样不升 epoch，
     * 两端 epoch 保持一致，已生成的 Key 继续可用。换号／未绑定时 epoch+1，
     * 旧绑定立即作废。两种情况都进 PENDING、清空授权等票据确认重填。 */
    int same_account = (b->state == LEA_BIND_ACTIVE || b->state == LEA_BIND_PENDING) &&
        account_id && account_id[0] && b->account_id[0] &&
        strcmp(b->account_id, account_id) == 0;
    if (!same_account)
        b->epoch += 1;
    b->state = LEA_BIND_PENDING;
    snprintf(b->account_id, sizeof(b->account_id), "%s", account_id ? account_id : "");
    snprintf(b->device_id, sizeof(b->device_id), "%s", device_id ? device_id : "");
    b->grant_epoch = 0;
    b->grant_muse_execute = 0;
    b->scopes[0] = '\0';
    b->expires_at = 0;
    b->lease_id[0] = '\0';
    b->ticket_signature[0] = '\0';
    b->updated_at = now_unix;
    return b->epoch;
}

int lea_binding_confirm(lea_binding_t *b, long long epoch, long long grant_epoch,
                        long long grant_muse_execute, const char *scopes,
                        const char *lease_id, long long expires_at,
                        const char *ticket_signature,
                        long long now_unix) {
    if (b->state != LEA_BIND_PENDING) return 0;
    if (epoch != b->epoch) return 0;
    if (expires_at > 0 && expires_at <= now_unix) return 0;
    b->grant_epoch = grant_epoch;
    b->grant_muse_execute = (int)grant_muse_execute; /* 调用点已验签保证 0/1 */
    snprintf(b->scopes, sizeof(b->scopes), "%s", scopes ? scopes : "");
    snprintf(b->lease_id, sizeof(b->lease_id), "%s", lease_id ? lease_id : "");
    snprintf(b->ticket_signature, sizeof(b->ticket_signature), "%s",
             ticket_signature ? ticket_signature : "");
    b->expires_at = expires_at;
    b->state = LEA_BIND_ACTIVE;
    b->updated_at = now_unix;
    return 1;
}

int lea_binding_verify_ticket(const lea_binding_t *b) {
    if (!b || b->ticket_signature[0] == '\0') return 0;
    char canonical[1024];
    if (!lea_ticket_canonical(b->account_id, b->device_id, b->epoch, b->grant_epoch,
                              b->grant_muse_execute, b->scopes, b->lease_id, b->expires_at,
                              canonical, sizeof(canonical)))
        return 0;
    char reason[128] = { 0 };
    return lea_verify_ticket_signature(b->ticket_signature, canonical, reason, sizeof(reason));
}

void lea_binding_revoke(lea_binding_t *b, long long now_unix) {
    /* REVOKING 为瞬时中间态：直接落 UNBOUND，但 epoch+1 使旧 epoch 作废。 */
    b->state = LEA_BIND_REVOKING;
    b->epoch += 1;
    b->grant_muse_execute = 0;
    b->scopes[0] = '\0';
    b->lease_id[0] = '\0';
    b->ticket_signature[0] = '\0';
    b->expires_at = 0;
    b->state = LEA_BIND_UNBOUND;
    b->updated_at = now_unix;
}

int lea_binding_expired(const lea_binding_t *b, long long now_unix) {
    return b->state == LEA_BIND_ACTIVE && b->expires_at > 0 &&
           b->expires_at <= now_unix;
}

int lea_admit(const lea_envelope_t *env, const lea_binding_t *bind,
              const char *const *revoked_key_ids, int n_revoked,
              char *err_code, size_t err_size) {
    if (!env || !bind || !err_code) return 0;
    /* 1. 绑定态 */
    if (bind->state == LEA_BIND_UNBOUND || bind->state == LEA_BIND_REVOKING) {
        snprintf(err_code, err_size, "%s", LEA_ERR_NOT_BOUND);
        return 0;
    }
    if (bind->state == LEA_BIND_PENDING) {
        snprintf(err_code, err_size, "%s", LEA_ERR_BINDING_PENDING);
        return 0;
    }
    if (lea_binding_expired(bind, env->issued_at)) {
        snprintf(err_code, err_size, "%s", LEA_ERR_BINDING_PENDING);
        return 0;
    }
    /* 2. 设备：信封 device_id 须与本机绑定 device_id 一致（白名单即绑定设备）。 */
    if (strcmp(env->device_id, bind->device_id) != 0) {
        snprintf(err_code, err_size, "%s", LEA_ERR_DEVICE_NOT_WHITELISTED);
        return 0;
    }
    /* 3. binding_epoch 匹配当前代次。 */
    if (env->binding_epoch != bind->epoch) {
        snprintf(err_code, err_size, "%s", LEA_ERR_BINDING_CHANGED);
        return 0;
    }
    /* 4. 账号一致（信封账号须是当前绑定账号）。 */
    if (strcmp(env->account_id, bind->account_id) != 0) {
        snprintf(err_code, err_size, "%s", LEA_ERR_BINDING_CHANGED);
        return 0;
    }
    /* 5. muse.execute 授权。 */
    if (!bind->grant_muse_execute) {
        snprintf(err_code, err_size, "%s", LEA_ERR_NOT_AUTHORIZED);
        return 0;
    }
    /* 6. API Key 归属／吊销：本地吊销表命中即拒绝。 */
    for (int i = 0; i < n_revoked; i++) {
        if (revoked_key_ids[i] && strcmp(env->api_key_id, revoked_key_ids[i]) == 0) {
            snprintf(err_code, err_size, "%s", LEA_ERR_KEY_REVOKED);
            return 0;
        }
    }
    /* 7. scope：危险命令另需 muse.execute.dangerous。 */
    const lea_command_spec_t *spec = lea_command_spec(env->command);
    if (spec && spec->required_scope &&
        !lea_binding_has_scope(bind, spec->required_scope)) {
        snprintf(err_code, err_size, "%s", LEA_ERR_SCOPE_DENIED);
        return 0;
    }
    if (lea_command_is_dangerous(env) &&
        !lea_binding_has_scope(bind, "muse.execute.dangerous")) {
        snprintf(err_code, err_size, "%s", LEA_ERR_SCOPE_DENIED);
        return 0;
    }
    return 1;
}

/* ---------------- 重放表 ---------------- */
void lea_replay_init(lea_replay_t *r) {
    memset(r, 0, sizeof(*r));
}

void lea_replay_prune(lea_replay_t *r, long long now_unix) {
    int w = 0;
    for (int i = 0; i < r->count; i++) {
        if (r->entries[i].expires_at > now_unix) {
            if (w != i) r->entries[w] = r->entries[i];
            w++;
        }
    }
    r->count = w;
}

int lea_replay_check_and_add(lea_replay_t *r, const char *request_id,
                             const char *nonce, long long now_unix) {
    lea_replay_prune(r, now_unix);
    for (int i = 0; i < r->count; i++) {
        if (strcmp(r->entries[i].request_id, request_id) == 0 ||
            strcmp(r->entries[i].nonce, nonce) == 0)
            return 0; /* 重放 */
    }
    if (r->count >= LEA_REPLAY_MAX) lea_replay_prune(r, now_unix);
    if (r->count >= LEA_REPLAY_MAX) return 0; /* 表满时 fail-closed */
    lea_replay_entry_t *e = &r->entries[r->count++];
    snprintf(e->request_id, sizeof(e->request_id), "%s", request_id);
    snprintf(e->nonce, sizeof(e->nonce), "%s", nonce);
    e->expires_at = now_unix + LEA_NONCE_TTL_SEC;
    e->used = 1;
    return 1;
}

/* ---------------- 吊销表写入（#17） ---------------- */
/* C 侧吊销表写入方：lea_revoked_write（全量替换 revoked_keys.txt）。
 * 任一 id 非法（非 token 字符集）即整单拒绝，不写残集；去重＋排序后
 * 原子 tmp+rename 写入（与服务端全集格式一致，一行一个 id）。
 * n_key_ids == 0 表示清空（写空文件）；上限 LEA_REVOKED_MAX_IDS。 */
int lea_revoked_write(const char *path, const char *const *key_ids, int n_key_ids);

int lea_revoked_write(const char *path, const char *const *key_ids, int n_key_ids) {
    if (!path || path[0] == '\0' || n_key_ids < 0 || n_key_ids > LEA_REVOKED_MAX_IDS) return 0;
    for (int i = 0; i < n_key_ids; i++)
        if (!key_ids[i] || !lea_validate_token(key_ids[i])) return 0;
    /* 排序指针数组（插入排序，n ≤ 512）＋去重；写出顺序与服务端全集一致。 */
    const char **sorted = NULL;
    if (n_key_ids > 0) {
        sorted = (const char **)malloc(sizeof(char *) * (size_t)n_key_ids);
        if (!sorted) return 0;
        for (int i = 0; i < n_key_ids; i++) sorted[i] = key_ids[i];
        for (int i = 1; i < n_key_ids; i++) {
            const char *v = sorted[i];
            int j = i - 1;
            while (j >= 0 && strcmp(sorted[j], v) > 0) { sorted[j + 1] = sorted[j]; j--; }
            sorted[j + 1] = v;
        }
    }
    size_t plen = strlen(path);
    char *tmp = (char *)malloc(plen + 5);
    if (!tmp) { free(sorted); return 0; }
    snprintf(tmp, plen + 5, "%s.tmp", path);
    FILE *f = fopen(tmp, "w");
    if (!f) { free(tmp); free(sorted); return 0; }
    int ok = 1;
    const char *prev = NULL;
    for (int i = 0; i < n_key_ids && ok; i++) {
        if (prev && strcmp(prev, sorted[i]) == 0) continue; /* 去重 */
        prev = sorted[i];
        if (fputs(sorted[i], f) == EOF || fputc('\n', f) == EOF) ok = 0;
    }
    if (ok && fflush(f) != 0) ok = 0;
    if (fclose(f) != 0) ok = 0;
    if (ok) {
        remove(path);
        if (rename(tmp, path) != 0) ok = 0;
    }
    if (!ok) remove(tmp);
    free(tmp);
    free(sorted);
    return ok;
}

/* 吊销表并集合并（#17 第二轮，R4 修订）：keys.sync-revoked 的实际写入方。
 * 背景：revoked_keys.txt 有两个全量替换写入方——服务端 H21 下发前推送
 * （直接写文件）与本命令（rebind 快照）。两方到达顺序无保证，陈旧
 * 快照全量替换会缩表（丢新吊销项，陈旧空集还会清表）。服务端台账
 * revocations.json 只增不减，故本命令改为并集合并：读出现有表，与
 * 传入 id 取并集后经 lea_revoked_write 原子写回；陈旧快照至多无操作，
 * 永不缩表。H21 直写仍是唯一可缩表的路径（它写实时台账全集）。
 * 空集是真 no-op：n_key_ids == 0 时短路成功，不读盘不写盘。
 * 读盘失败只认确证不存在（ENOENT）为空表；其他失败（不可读／ACL／
 * 路径是目录／读中出错）即整单拒绝，不把现有表当空表覆盖。
 * 写前重读（CAS）＋写后校验＋有界重试（最多 3 次）：写盘前重读文件，
 * 与本轮基线不一致即不写、下一轮以累积期望集重合并——否则 H21 在
 * 读-写之间新增的 id 会被本次写回覆盖，而只验期望集的写后校验发现
 * 不了。写后重读确认期望集（传入＋各轮读到的现有表，累积只增）全在
 * 表内。仍拦不住重读通过后那一瞬的交错，但窗口已缩到一次重读到写盘
 * 之间，且失败时诚实报失败（下次 H21 下发会重推，admit 仍是第一层控制）。
 * 现有行非法／行超长／并集超上限即整单拒绝、原文件不动。 */
static int revoked_read_ids(const char *path, char out[][129], int *n_out) {
    FILE *f = fopen(path, "r");
    if (!f) {
        if (errno == ENOENT) { *n_out = 0; return 1; }
        return 0;
    }
    int n = 0;
    int rc = 1;
    for (;;) {
        /* 整行累积：fgets 分块读，读满缓冲仍无换行且未到 EOF 即扩容续读；
         * 单行超约 64KB 即拒绝（按原始行长计，尾随空白再多也受此上限约束）。读完先 trim 行尾空白（空格／tab／\r／\n）
         * 再按 token 校验，合法 token＋再多尾随空白也不误拒。 */
        size_t cap = 1024, len = 0;
        char *line = (char *)malloc(cap);
        if (!line) { rc = 0; break; }
        int done = 0, toolong = 0;
        for (;;) {
            if (len + 1024 > cap) {
                if (cap >= 65536) { toolong = 1; break; }
                size_t ncap = cap * 2;
                char *nl = (char *)realloc(line, ncap);
                if (!nl) { toolong = 1; break; }
                line = nl; cap = ncap;
            }
            if (!fgets(line + len, (int)(cap - len), f)) { done = 1; break; }
            len += strlen(line + len);
            if (len > 0 && line[len - 1] == '\n') { done = 1; break; }
            if (feof(f)) { done = 1; break; }
        }
        if (toolong) { free(line); rc = 0; break; }
        if (len == 0 && done) { free(line); break; } /* EOF，无更多行 */
        while (len > 0 && (line[len - 1] == '\n' || line[len - 1] == '\r' ||
                           line[len - 1] == ' ' || line[len - 1] == '\t'))
            line[--len] = '\0';
        if (len == 0) { free(line); continue; }
        if (len > 128 || !lea_validate_token(line)) { free(line); rc = 0; break; }
        /* 去重后再计上限：重复行不占名额。先拷贝再 free，禁 use-after-free。 */
        int dup = 0;
        for (int i = 0; i < n; i++)
            if (strcmp(out[i], line) == 0) { dup = 1; break; }
        if (!dup) {
            if (n >= LEA_REVOKED_MAX_IDS) { free(line); rc = 0; break; }
            memcpy(out[n], line, len);
            out[n][len] = '\0';
            n++;
        }
        free(line);
    }
    if (rc && ferror(f)) rc = 0;
    fclose(f);
    if (!rc) return 0;
    *n_out = n;
    return 1;
}

static int revoked_has_id(const char ids[][129], int n, const char *id) {
    for (int i = 0; i < n; i++)
        if (strcmp(ids[i], id) == 0) return 1;
    return 0;
}

/* 两组 id 是否同一集合（均已去重；只比成员，不比顺序）。 */
static int revoked_sets_equal(const char a[][129], int na, const char b[][129], int nb) {
    if (na != nb) return 0;
    for (int i = 0; i < na; i++)
        if (!revoked_has_id(b, nb, a[i])) return 0;
    return 1;
}

/* 测试钩子：merge 每轮基线读后、写前重读前调用一次（若已设置），
 * 世代合并（lea_revoked_merge_with_generation）在世代推进后、最终重读
 * 前亦调用一次（同一钩子）——确定性模拟 H21 直写落在读-写之间或写盘
 * 与世代推进之间。仅单测用，测试专用编译隔离：只在定义
 * LEA_TEST_HOOKS 时编译（run_tests.sh 的两路单测构建定义它；生产
 * 构建／mingw 交叉编译不定义，符号不存在）。生产代码永不设置。
 * 本文件所有 g_merge_pre_write_hook 引用必须在 #ifdef LEA_TEST_HOOKS
 * 内，否则生产构建链接失败。 */
#ifdef LEA_TEST_HOOKS
static void (*g_merge_pre_write_hook)(const char *path) = NULL;
void lea_revoked_merge_set_pre_write_hook(void (*hook)(const char *path)) {
    g_merge_pre_write_hook = hook;
}
#endif

/* 并集合并内层：lea_revoked_merge 与 lea_revoked_merge_with_generation
 * 共用。expected/n_expected 为调用方提供的累积期望集（in/out）：先把
 * 传入 id 并入（去重），每轮再把读到的现有表并入，只增不减；成功时
 * *n_expected 为最终期望集大小。写前重读 CAS＋写后校验期望集＋有界
 * 重试（最多 3 次），语义与 R6 审定版一致。 */
static int revoked_merge_inner(const char *path, const char *const *key_ids, int n_key_ids,
                               char expected[][129], int *n_expected) {
    if (!path || path[0] == '\0' || n_key_ids < 0 || n_key_ids > LEA_REVOKED_MAX_IDS) return 0;
    if (n_key_ids > 0 && !key_ids) return 0; /* R2-2.6：显式禁解引用 NULL（与下行同义，双保险） */
    /* 空集真 no-op：不读盘、不写盘（缺失文件也不创建）。 */
    if (n_key_ids == 0) return 1;
    if (!key_ids) return 0;
    for (int i = 0; i < n_key_ids; i++)
        if (!key_ids[i] || !lea_validate_token(key_ids[i])) return 0;
    /* 期望集：本次调用见过的所有 id（传入＋各轮读到的现有表），去重。
     * 写后校验验整个期望集，不只验传入 id——否则重试时以陈旧表重算
     * 并集会把上轮见过的 id 丢了还验通过（R4 反例：现有 [A,B]、传入
     * [C]、H21 直写 [A] 后重试写回 [A,C] 即丢 B）。期望集只增不减，
     * 与服务端台账只增不减一致；超 512 即整单拒绝。 */
    for (int i = 0; i < n_key_ids; i++) {
        if (revoked_has_id(expected, *n_expected, key_ids[i])) continue;
        if (*n_expected >= LEA_REVOKED_MAX_IDS) return 0;
        /* token 已验（≤128），定长拷贝（snprintf 会报截断警告）。 */
        size_t kl = strlen(key_ids[i]);
        memcpy(expected[*n_expected], key_ids[i], kl);
        expected[*n_expected][kl] = '\0';
        (*n_expected)++;
    }
    for (int attempt = 0; attempt < 3; attempt++) {
        char existing[LEA_REVOKED_MAX_IDS][129];
        int n_existing = 0;
        if (!revoked_read_ids(path, existing, &n_existing)) return 0;
        for (int i = 0; i < n_existing; i++) {
            if (revoked_has_id(expected, *n_expected, existing[i])) continue;
            if (*n_expected >= LEA_REVOKED_MAX_IDS) return 0;
            /* 读盘时已验（≤128），定长拷贝。 */
            size_t el = strlen(existing[i]);
            memcpy(expected[*n_expected], existing[i], el);
            expected[*n_expected][el] = '\0';
            (*n_expected)++;
        }
        /* 测试钩子（仅单测设置）：模拟 H21 直写落在本轮基线读之后。 */
#ifdef LEA_TEST_HOOKS
        if (g_merge_pre_write_hook) g_merge_pre_write_hook(path);
#endif
        /* 写前重读（CAS）：文件若与本轮基线不一致，说明有其他写入方
         * 在读后写盘（例如 H21 新增了 id），不得直接覆盖——本轮不写，
         * 下一轮以累积的期望集重合并。只验期望集的写后校验发现不了
         * 这种“没见过的新 id 被自己覆盖”，故写前必须重读比较。 */
        char current[LEA_REVOKED_MAX_IDS][129];
        int n_current = 0;
        if (!revoked_read_ids(path, current, &n_current)) return 0;
        if (!revoked_sets_equal(existing, n_existing, current, n_current)) continue;
        /* 期望集即并集：lea_revoked_write 排序＋去重＋原子写回。 */
        const char *ptrs[LEA_REVOKED_MAX_IDS];
        for (int i = 0; i < *n_expected; i++) ptrs[i] = expected[i];
        if (!lea_revoked_write(path, ptrs, *n_expected)) return 0;
        /* 写后校验：重读确认期望集全在表内（H21 直写若落在读-改-写
         * 之间即在此发现，下一轮以累积的期望集重合并，不丢已见 id）。
         * R2-2.2 字面要求：同时验写前 CAS 读到的 current 集合仍在表内。
         * CAS 通过时 current == existing ⊆ expected，本是同一结论；
         * 此处显式再验一次（防御性不变量），防期望集累积逻辑未来回归。
         * 注意：它发现不了“写盘后才到达、从未见过的新 id”——那一窗口
         * 由世代合并外层的世代稳定性重验兜（见
         * lea_revoked_merge_with_generation），不是本处能验的。 */
        char verify[LEA_REVOKED_MAX_IDS][129];
        int n_verify = 0;
        if (!revoked_read_ids(path, verify, &n_verify)) return 0;
        int missing = 0;
        for (int i = 0; i < *n_expected; i++)
            if (!revoked_has_id(verify, n_verify, expected[i])) { missing = 1; break; }
        for (int i = 0; i < n_current && !missing; i++)
            if (!revoked_has_id(verify, n_verify, current[i])) { missing = 1; break; }
        if (!missing) return 1;
    }
    return 0;
}

int lea_revoked_merge(const char *path, const char *const *key_ids, int n_key_ids) {
    char expected[LEA_REVOKED_MAX_IDS][129];
    int n_expected = 0;
    return revoked_merge_inner(path, key_ids, n_key_ids, expected, &n_expected);
}

/* ---------------- 吊销表世代（#1 版本化） ---------------- */
/* 世代 sidecar 路径：revoked_keys.txt → revoked_keys.gen（与服务端 H21
 * 推送脚本写同一文件，见 lea-core.js leaRevocationsWriteCmd；无 .txt
 * 后缀时直接追加 .gen）。 */
int lea_revoked_gen_path(const char *path, char *out, size_t out_size) {
    if (!path || !path[0] || !out || out_size < 2) return 0;
    size_t len = strlen(path);
    int has_txt = 0;
    if (len >= 4) {
        const char *suf = path + len - 4;
        if (suf[0] == '.' && (suf[1] == 't' || suf[1] == 'T') &&
            (suf[2] == 'x' || suf[2] == 'X') && (suf[3] == 't' || suf[3] == 'T'))
            has_txt = 1;
    }
    size_t need = has_txt ? len + 1 : len + 5; /* ".gen" 替换 ".txt" 或追加＋'\0' */
    if (need > out_size) return 0;
    if (has_txt) {
        memcpy(out, path, len - 4);
        memcpy(out + len - 4, ".gen", 4);
        out[len] = '\0';
    } else {
        memcpy(out, path, len);
        memcpy(out + len, ".gen", 4);
        out[len + 4] = '\0';
    }
    return 1;
}

/* 世代文件内容：十进制整数＋换行。缺失即 0（未接受过任何世代）；内容
 * 非纯数字／空／超长／含多余内容／负数／溢出／其他读失败即返回 0
 * （fail-closed：调用方不得把损坏的世代当 0 推进）。 */
int lea_revoked_generation_read(const char *gen_path, long long *out) {
    if (!gen_path || !gen_path[0] || !out) return 0;
    FILE *f = fopen(gen_path, "r");
    if (!f) {
        if (errno == ENOENT) { *out = 0; return 1; }
        return 0;
    }
    char buf[64];
    if (!fgets(buf, sizeof(buf), f)) { fclose(f); return 0; } /* 空文件即损坏 */
    /* 行须完整（无换行且未到 EOF 即超长）且其后无多余内容。 */
    size_t n = strlen(buf);
    int complete = (n > 0 && buf[n - 1] == '\n') || feof(f);
    if (!complete) { fclose(f); return 0; }
    if (fgetc(f) != EOF) { fclose(f); return 0; }
    while (n > 0 && (buf[n - 1] == '\n' || buf[n - 1] == '\r' ||
                     buf[n - 1] == ' ' || buf[n - 1] == '\t'))
        buf[--n] = '\0';
    if (n == 0) { fclose(f); return 0; }
    for (size_t i = 0; i < n; i++)
        if (buf[i] < '0' || buf[i] > '9') { fclose(f); return 0; }
    errno = 0;
    char *end = NULL;
    long long v = strtoll(buf, &end, 10);
    if (errno == ERANGE || !end || *end != '\0') { fclose(f); return 0; }
    fclose(f);
    *out = v;
    return 1;
}

/* 世代文件原子写（tmp+rename，与 lea_revoked_write 同范式）；generation
 * 为负即拒绝。 */
int lea_revoked_generation_write(const char *gen_path, long long generation) {
    if (!gen_path || !gen_path[0] || generation < 0) return 0;
    size_t plen = strlen(gen_path);
    char *tmp = (char *)malloc(plen + 5);
    if (!tmp) return 0;
    snprintf(tmp, plen + 5, "%s.tmp", gen_path);
    FILE *f = fopen(tmp, "w");
    if (!f) { free(tmp); return 0; }
    int ok = 1;
    if (fprintf(f, "%lld\n", generation) < 0) ok = 0;
    if (ok && fflush(f) != 0) ok = 0;
    if (fclose(f) != 0) ok = 0;
    if (ok) {
        remove(gen_path);
        if (rename(tmp, gen_path) != 0) ok = 0;
    }
    if (!ok) remove(tmp);
    free(tmp);
    return ok;
}

/* 只向前推进世代：当前已 ≥ generation 即成功无操作（不回退）；更小才
 * 写盘。读失败（损坏）即返回 0。 */
int lea_revoked_generation_advance(const char *gen_path, long long generation) {
    if (!gen_path || !gen_path[0] || generation < 0) return 0;
    long long cur = 0;
    if (!lea_revoked_generation_read(gen_path, &cur)) return 0;
    if (cur >= generation) return 1;
    return lea_revoked_generation_write(gen_path, generation);
}

/* 带世代的并集合并（#1 版本化）：keys.sync-revoked 带 generation 时的
 * 实际写入方；generation < 0 表示成员缺失（旧版回包），走无版本合并，
 * 不碰世代文件。generation ≥ 0 时：
 *   1. 读本机已接受的最大世代；损坏即整单拒绝（fail-closed）；
 *   2. 陈旧判定只做一次（首轮进入时）：generation 更小即陈旧快照，
 *      *out_stale 置 1 并返回 0，不写盘。R2-2.1：重试轮不再重判——
 *      首轮已通过检查后，本函数自己把世代推进到了 generation，若
 *      下一轮再判 `generation < cur`，会把自己刚写的世代当成“外部
 *      更新”而自废武功（表已被陈旧推送覆盖却不再重合并）。一旦开始
 *      合并，继续只会加 id（并集），永不删 id，所以继续总是安全的；
 *      世代在中途被他方推得更高，只说明有更新的推送在途，见第 5 步；
 *   3. 否则做并集合并（CAS＋期望集校验，与 lea_revoked_merge 同语义）；
 *   4. 合并成功后条件推进世代（已有更新世代在位即无操作，绝不回退）；
 *   5. 最终重读：确认累积期望集仍在表内——陈旧 H21 推送若恰在写盘与
 *      世代推进之间落地，会在此被发现并进下一轮重合并（期望集跨轮
 *      累积，不丢已见 id）；再重读世代文件做稳定性校验：写盘后世代
 *      若被他方改动（更新推送已到／陈旧推送回退了世代），本次写盘所
 *      依据的世代假设已失效，亦进下一轮重合并。R2-2.2 实质：只验
 *      期望集发现不了“写盘后才到达、从未见过的新 id”——但新 id 只会
 *      随一次世代推进到达（H21 推送先写世代、再写表），世代文件变动
 *      就是它的可见信号；三轮仍不稳定即诚实报失败（下次下发重推）。
 *      世代已推进且稳定后，陈旧推送过不了 H21 的世代门，故最后一轮
 *      重读通过即闭合（见 lea-core.js 注释的自愈链：服务端
 *      pushed_epoch 只在当前世代同步成功时才追上，陈旧推送误标不了
 *      已同步，下次下发会重推当前世代全集；admit 始终是第一层控制）。
 *      有界重试（最多 3 轮）；空集＋世代时只推进世代。
 * out_stale 可为 NULL。 */
int lea_revoked_merge_with_generation(const char *path, const char *const *key_ids, int n_key_ids,
                                      long long generation, int *out_stale) {
    if (out_stale) *out_stale = 0;
    if (generation < 0) return lea_revoked_merge(path, key_ids, n_key_ids);
    if (!path || path[0] == '\0' || n_key_ids < 0 || n_key_ids > LEA_REVOKED_MAX_IDS) return 0;
    if (n_key_ids > 0 && !key_ids) return 0;
    for (int i = 0; i < n_key_ids; i++)
        if (!key_ids[i] || !lea_validate_token(key_ids[i])) return 0;
    char gen_path[1024];
    if (!lea_revoked_gen_path(path, gen_path, sizeof(gen_path))) return 0;
    /* 期望集跨外层重试轮累积（与 inner 的 in/out 语义一致）。 */
    char expected[LEA_REVOKED_MAX_IDS][129];
    int n_expected = 0;
    for (int attempt = 0; attempt < 3; attempt++) {
        long long cur = 0;
        if (!lea_revoked_generation_read(gen_path, &cur)) return 0;
        /* R2-2.1：陈旧判定只在首轮做一次（见上注释第 2 步）。 */
        if (attempt == 0 && generation < cur) { if (out_stale) *out_stale = 1; return 0; }
        long long gen_at_start = cur;
        if (n_key_ids > 0) {
            if (!revoked_merge_inner(path, key_ids, n_key_ids, expected, &n_expected)) return 0;
        }
        if (!lea_revoked_generation_advance(gen_path, generation)) return 0;
        /* 测试钩子（仅单测设置）：模拟 H21 直写落在写盘与世代推进之间。 */
#ifdef LEA_TEST_HOOKS
        if (g_merge_pre_write_hook) g_merge_pre_write_hook(path);
#endif
        /* 最终重读：期望集须仍全在表内，否则下一轮以累积期望集重合并。 */
        char verify[LEA_REVOKED_MAX_IDS][129];
        int n_verify = 0;
        if (!revoked_read_ids(path, verify, &n_verify)) return 0;
        int missing = 0;
        for (int i = 0; i < n_expected; i++)
            if (!revoked_has_id(verify, n_verify, expected[i])) { missing = 1; break; }
        if (missing) continue;
        /* R2-2.2 世代稳定性：本次推进后世代文件应为 max(轮首世代,
         * generation)——即本函数自己的推进结果；若被他方改动（更新推
         * 送已到／陈旧推送回退了世代），本次写盘所依据的世代假设已
         * 失效，须再合并一轮（重读表吸入新到 id、重断世代）再验。 */
        long long expected_gen = gen_at_start > generation ? gen_at_start : generation;
        long long cur_after = 0;
        if (!lea_revoked_generation_read(gen_path, &cur_after)) return 0;
        if (cur_after != expected_gen) continue;
        return 1;
    }
    return 0;
}

/* ---------------- 幂等表 ---------------- */
const char *lea_idem_status_name(lea_idem_status_t s) {
    switch (s) {
        case LEA_IDEM_RECEIVED: return "RECEIVED";
        case LEA_IDEM_RUNNING: return "RUNNING";
        case LEA_IDEM_SUCCEEDED: return "SUCCEEDED";
        case LEA_IDEM_FAILED: return "FAILED";
        case LEA_IDEM_UNKNOWN: return "UNKNOWN";
        case LEA_IDEM_EXPIRED: return "EXPIRED";
        default: return "UNKNOWN";
    }
}

lea_idem_status_t lea_idem_status_from_name(const char *name) {
    if (!name) return LEA_IDEM_UNKNOWN;
    if (strcmp(name, "RECEIVED") == 0) return LEA_IDEM_RECEIVED;
    if (strcmp(name, "RUNNING") == 0) return LEA_IDEM_RUNNING;
    if (strcmp(name, "SUCCEEDED") == 0) return LEA_IDEM_SUCCEEDED;
    if (strcmp(name, "FAILED") == 0) return LEA_IDEM_FAILED;
    if (strcmp(name, "EXPIRED") == 0) return LEA_IDEM_EXPIRED;
    return LEA_IDEM_UNKNOWN;
}

void lea_idem_init(lea_idem_t *t) {
    memset(t, 0, sizeof(*t));
}

lea_idem_entry_t *lea_idem_lookup(lea_idem_t *t, const char *device_id,
                                 const char *account_id, const char *key) {
    for (int i = 0; i < t->count; i++) {
        lea_idem_entry_t *e = &t->entries[i];
        if (strcmp(e->device_id, device_id) == 0 &&
            strcmp(e->account_id, account_id) == 0 &&
            strcmp(e->key, key) == 0)
            return e;
    }
    return NULL;
}

lea_idem_entry_t *lea_idem_get_or_create(lea_idem_t *t, const char *device_id,
                                         const char *account_id, const char *key,
                                         int dangerous, long long now_unix) {
    lea_idem_entry_t *e = lea_idem_lookup(t, device_id, account_id, key);
    if (e) return e;
    if (t->count >= LEA_IDEM_MAX) return NULL;
    e = &t->entries[t->count++];
    memset(e, 0, sizeof(*e));
    snprintf(e->device_id, sizeof(e->device_id), "%s", device_id);
    snprintf(e->account_id, sizeof(e->account_id), "%s", account_id);
    snprintf(e->key, sizeof(e->key), "%s", key);
    e->status = LEA_IDEM_RECEIVED;
    e->dangerous = dangerous;
    e->created_at = now_unix;
    e->updated_at = now_unix;
    return e;
}

void lea_idem_set_status(lea_idem_t *t, lea_idem_entry_t *e,
                         lea_idem_status_t status, const char *result,
                         long long now_unix) {
    (void)t;
    if (!e) return;
    e->status = status;
    e->updated_at = now_unix;
    if (result) {
        /* 缓存的响应是“一行 JSON”：去掉末尾换行，否则写入 JSONL 快照时会
         * 断行、加载时解析失败。 */
        size_t n = strlen(result);
        while (n > 0 && (result[n - 1] == '\n' || result[n - 1] == '\r')) n--;
        if (n >= sizeof(e->result)) {
            /* H09：超长响应不得截断成非法 JSON 片段写入（截断点可能落在
             * 字符串／转义中间，一次 file.read 32KB→约 43KB Base64 即可
             * 写出毒化行）。改为保留终态要义的短占位行：ok／code／
             * request_id 原样取自响应首部字段（响应由 lea_build_response
             * 构造，ok／code 在前，首次命中即顶层值），result 置 null。
             * 占位行恒为合法 JSON，可正常持久化与重放。 */
            int okv = 0;
            char code[64] = { 0 }, rid[128] = { 0 };
            char code_esc[128] = { 0 }, rid_esc[256] = { 0 };
            size_t off = 0;
            lea_json_bool(result, "ok", &okv);
            lea_json_string(result, "code", code, sizeof(code));
            lea_json_string(result, "request_id", rid, sizeof(rid));
            lea_json_escape_into(code_esc, sizeof(code_esc), &off, code);
            off = 0;
            lea_json_escape_into(rid_esc, sizeof(rid_esc), &off, rid);
            snprintf(e->result, sizeof(e->result),
                     "{\"ok\":%s,\"code\":\"%s\",\"request_id\":\"%s\","
                     "\"retryable\":false,\"detail\":\"result-truncated\",\"result\":null}",
                     okv ? "true" : "false", code_esc, rid_esc);
            return;
        }
        memcpy(e->result, result, n);
        e->result[n] = '\0';
    }
}

int lea_idem_prune(lea_idem_t *t, long long now_unix) {
    int removed = 0;
    int w = 0;
    for (int i = 0; i < t->count; i++) {
        lea_idem_entry_t *e = &t->entries[i];
        long long retain = (long long)(e->dangerous
            ? LEA_IDEM_RETENTION_DANGEROUS_DAYS : LEA_IDEM_RETENTION_DAYS) * 86400;
        int terminal = e->status == LEA_IDEM_SUCCEEDED || e->status == LEA_IDEM_FAILED ||
                       e->status == LEA_IDEM_UNKNOWN || e->status == LEA_IDEM_EXPIRED;
        if (terminal && now_unix - e->updated_at > retain) {
            removed++;
            continue;
        }
        if (w != i) t->entries[w] = t->entries[i];
        w++;
    }
    t->count = w;
    return removed;
}

int lea_idem_mark_crashed_unknown(lea_idem_t *t, long long now_unix) {
    int n = 0;
    for (int i = 0; i < t->count; i++) {
        lea_idem_entry_t *e = &t->entries[i];
        if (e->status == LEA_IDEM_RECEIVED || e->status == LEA_IDEM_RUNNING) {
            e->status = LEA_IDEM_UNKNOWN;
            e->updated_at = now_unix;
            n++;
        }
    }
    return n;
}

/* 单条拼成一行 JSONL（含末尾换行）；非法（字段转义失败／行超长／行非法）
 * 返回 0。供 save_text_ex 与 save_to_file 共用（#26 流式写盘不再经
 * 4MB 内存缓冲）。 */
static int idem_format_line(const lea_idem_entry_t *e, char *line, size_t line_size) {
    char dev_esc[256] = { 0 }, acc_esc[256] = { 0 }, key_esc[256] = { 0 };
    size_t eoff = 0;
    if (!lea_json_escape_into(dev_esc, sizeof(dev_esc), &eoff, e->device_id)) return 0;
    eoff = 0;
    if (!lea_json_escape_into(acc_esc, sizeof(acc_esc), &eoff, e->account_id)) return 0;
    eoff = 0;
    if (!lea_json_escape_into(key_esc, sizeof(key_esc), &eoff, e->key)) return 0;
    int n = snprintf(line, line_size,
                     "{\"device_id\":\"%s\",\"account_id\":\"%s\",\"key\":\"%s\","
                     "\"status\":\"%s\",\"dangerous\":%d,\"created_at\":%lld,"
                     "\"updated_at\":%lld,\"result\":%s}\n",
                     dev_esc, acc_esc, key_esc,
                     lea_idem_status_name(e->status), e->dangerous,
                     e->created_at, e->updated_at,
                     e->result[0] ? e->result : "null");
    if (n < 0 || (size_t)n >= line_size) return 0;
    if (!lea_json_is_valid(line)) return 0;
    return 1;
}

int lea_idem_save_text_ex(const lea_idem_t *t, char *out, size_t out_size, int *skipped) {
    if (!t || !out || out_size < 1) return 0;
    size_t off = 0;
    int nskipped = 0;
    char line[LEA_IDEM_RESULT_MAX + 1024];
    for (int i = 0; i < t->count; i++) {
        if (!idem_format_line(&t->entries[i], line, sizeof(line))) { nskipped++; continue; }
        size_t n = strlen(line);
        if (off >= out_size || n >= out_size - off) return 0;
        memcpy(out + off, line, n);
        off += n;
    }
    if (off < out_size) out[off] = '\0';
    if (skipped) *skipped = nskipped;
    return 1;
}

int lea_idem_save_text(const lea_idem_t *t, char *out, size_t out_size) {
    return lea_idem_save_text_ex(t, out, out_size, NULL);
}

/* #26：逐行写文件流，不再要求整表先装进内存缓冲。 */
int lea_idem_save_to_file(const lea_idem_t *t, FILE *f, int *skipped) {
    if (!t || !f) return 0;
    int nskipped = 0;
    char line[LEA_IDEM_RESULT_MAX + 1024];
    for (int i = 0; i < t->count; i++) {
        if (!idem_format_line(&t->entries[i], line, sizeof(line))) { nskipped++; continue; }
        if (fputs(line, f) == EOF) {
            if (skipped) *skipped = nskipped;
            return 0;
        }
    }
    if (skipped) *skipped = nskipped;
    return 1;
}

/* #26：解析单行（不含换行）并在合法时追加一条。坏行／超长行／表满返回 0
 * 且不改表（调用方直接跳过该行）；不清空表——调用方先 lea_idem_init。 */
int lea_idem_load_line(lea_idem_t *t, const char *line) {
    if (!t || !line || line[0] == '\0') return 0;
    if (strlen(line) >= LEA_IDEM_RESULT_MAX + 512) return 0; /* 超长行跳过 */
    lea_idem_entry_t e;
    memset(&e, 0, sizeof(e));
    char status[32] = { 0 };
    long long created = 0, updated = 0;
    long long dang = 0;
    if (!lea_json_string(line, "device_id", e.device_id, sizeof(e.device_id))) return 0;
    if (!lea_json_string(line, "account_id", e.account_id, sizeof(e.account_id))) return 0;
    if (!lea_json_string(line, "key", e.key, sizeof(e.key))) return 0;
    if (!lea_json_string(line, "status", status, sizeof(status))) return 0;
    if (!lea_json_long(line, "dangerous", &dang)) return 0;
    if (!lea_json_long(line, "created_at", &created)) return 0;
    if (!lea_json_long(line, "updated_at", &updated)) return 0;
    /* result：取 "result": 后的原始 JSON 值（对象或 null）。
     * 注意行尾还有外层 idem 行的 }，必须用花括号配对提取，不能
     * 直接取到行尾。取出的值须过严格 JSON 校验，否则整行跳过。 */
    if (lea_json_object_raw(line, "result", e.result, sizeof(e.result))) {
        if (!lea_json_is_valid(e.result)) return 0;
    } else {
        const char *rp = strstr(line, "\"result\":null");
        if (rp) snprintf(e.result, sizeof(e.result), "%s", "null");
        else return 0;
    }
    e.status = lea_idem_status_from_name(status);
    e.dangerous = (int)dang;
    e.created_at = created;
    e.updated_at = updated;
    if (t->count >= LEA_IDEM_MAX) return 0;
    t->entries[t->count++] = e;
    return 1;
}

int lea_idem_load_text(lea_idem_t *t, const char *text) {
    if (!t || !text) return 0;
    lea_idem_init(t);
    const char *p = text;
    char line[LEA_IDEM_RESULT_MAX + 512];
    while (*p) {
        const char *nl = strchr(p, '\n');
        size_t len = nl ? (size_t)(nl - p) : strlen(p);
        if (len == 0) { p = nl ? nl + 1 : p + len; continue; }
        /* H09：坏行隔离跳过，不清空整表。超长行（单行超过缓冲）直接跳过。 */
        if (len >= sizeof(line)) { p = nl ? nl + 1 : p + len; continue; }
        memcpy(line, p, len);
        line[len] = '\0';
        p = nl ? nl + 1 : p + len;
        lea_idem_load_line(t, line);
        /* 表满时停止继续加载，但保留已加载的条目（返回 1，不清空）。 */
        if (t->count >= LEA_IDEM_MAX) break;
    }
    return 1;
}

/* ---------------- 队列 ---------------- */
void lea_queue_init(lea_queue_t *q) {
    memset(q, 0, sizeof(*q));
}

int lea_queue_total(const lea_queue_t *q) {
    return q->normal_count + q->danger_count;
}

int lea_queue_enqueue(lea_queue_t *q, lea_queue_item_t *item,
                      char *err, size_t err_size) {
    if (!q || !item) return 0;
    if (lea_queue_total(q) >= LEA_QUEUE_MAX) {
        if (err) snprintf(err, err_size, "%s", LEA_ERR_QUEUE_FULL);
        return 0;
    }
    item->next = NULL;
    if (item->dangerous) {
        if (q->danger_tail) q->danger_tail->next = item;
        else q->danger_head = item;
        q->danger_tail = item;
        q->danger_count++;
    } else {
        if (q->normal_tail) q->normal_tail->next = item;
        else q->normal_head = item;
        q->normal_tail = item;
        q->normal_count++;
    }
    return 1;
}

lea_queue_item_t *lea_queue_dequeue(lea_queue_t *q) {
    if (!q) return NULL;
    lea_queue_item_t *it = NULL;
    /* H10 防饿死：危险 lane 优先，但连续取满 LEA_DANGER_QUOTA 条后，
     * 若普通 lane 有等待项则必须取一条普通命令（轮转），再继续危险 lane；
     * 普通 lane 为空时危险 lane 不受配额限制。 */
    int take_danger = 0;
    if (q->danger_head) {
        if (!q->normal_head) take_danger = 1;
        else if (q->danger_streak < LEA_DANGER_QUOTA) take_danger = 1;
    }
    if (take_danger) {
        it = q->danger_head;
        q->danger_head = it->next;
        if (!q->danger_head) q->danger_tail = NULL;
        q->danger_count--;
        q->danger_streak++;
    } else if (q->normal_head) {
        it = q->normal_head;
        q->normal_head = it->next;
        if (!q->normal_head) q->normal_tail = NULL;
        q->normal_count--;
        q->danger_streak = 0;
    }
    if (it) it->next = NULL;
    return it;
}

void lea_queue_item_free(lea_queue_item_t *item) {
    free(item);
}

/* ---------------- 批量序号单调表（H10） ---------------- */
void lea_batch_seq_init(lea_batch_seq_t *t) {
    memset(t, 0, sizeof(*t));
}

int lea_batch_seq_check(lea_batch_seq_t *t, const char *device_id,
                        const char *account_id, const char *batch_id,
                        long long seq, long long now_unix, long long *prev_seq_out) {
    if (!t || !device_id || !account_id || seq < 1) return 0;
    /* 单条（无 batch_id）：seq 必须为 1（服务端单条固定 seq=1）。 */
    if (!batch_id || batch_id[0] == '\0') return seq == 1;
    for (int i = 0; i < t->count; i++) {
        lea_batch_seq_entry_t *e = &t->entries[i];
        if (strcmp(e->device_id, device_id) == 0 &&
            strcmp(e->account_id, account_id) == 0 &&
            strcmp(e->batch_id, batch_id) == 0) {
            if (seq <= e->last_seq) return 0; /* 乱序／重放步 */
            if (prev_seq_out) *prev_seq_out = e->last_seq;
            e->last_seq = seq;
            e->updated_at = now_unix;
            return 1;
        }
    }
    /* 首次见到的 batch：接受任意 seq>=1 并记录（不要求首步 seq==1：
     * 服务重启会清空内存表，重启后中途批次的首步 seq 可能 >1，拒掉会
     * 把合法续跑的批次整个打断；单调性仍由后续步保证）。 */
    if (t->count >= LEA_BATCH_SEQ_MAX) {
        /* 表满：淘汰最久未更新的一项（fail-open 于旧批，单调性仍由
         * 重放表＋签名兜底；不得因表满拒绝合法新批）。 */
        int oldest = 0;
        for (int i = 1; i < t->count; i++)
            if (t->entries[i].updated_at < t->entries[oldest].updated_at) oldest = i;
        t->entries[oldest] = t->entries[--t->count];
    }
    if (prev_seq_out) *prev_seq_out = -1; /* 新 batch，无前值 */
    lea_batch_seq_entry_t *e = &t->entries[t->count++];
    memset(e, 0, sizeof(*e));
    snprintf(e->device_id, sizeof(e->device_id), "%s", device_id);
    snprintf(e->account_id, sizeof(e->account_id), "%s", account_id);
    snprintf(e->batch_id, sizeof(e->batch_id), "%s", batch_id);
    e->last_seq = seq;
    e->updated_at = now_unix;
    return 1;
}

void lea_batch_seq_rollback(lea_batch_seq_t *t, const char *device_id,
                            const char *account_id, const char *batch_id,
                            long long seq, long long prev_seq) {
    if (!t || !device_id || !account_id || !batch_id || batch_id[0] == '\0') return;
    for (int i = 0; i < t->count; i++) {
        lea_batch_seq_entry_t *e = &t->entries[i];
        if (strcmp(e->device_id, device_id) == 0 &&
            strcmp(e->account_id, account_id) == 0 &&
            strcmp(e->batch_id, batch_id) == 0) {
            /* 只有本次检查仍是最后一次写入时才回滚；已被更大 seq 推进
             * 时不动（该步已被后续步超越，重试本就是乱序）。 */
            if (e->last_seq != seq) return;
            if (prev_seq < 0) {
                t->entries[i] = t->entries[--t->count];
            } else {
                e->last_seq = prev_seq;
            }
            return;
        }
    }
}
