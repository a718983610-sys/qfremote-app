/* 见 lea_state.h */
#include "lea_state.h"
#include "lea_crypto.h"
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

/* 序列化：每行一条 JSON。result 内不含换行（响应构造保证一行）。
 * H09：逐行组装后做严格 JSON 校验再写入输出；非法行跳过不写（skipped
 * 计数），绝不把毒化行写进快照。device_id／account_id／key 经 JSON 转义
 * 后拼接（id 字段可含 '"'，直拼会断行结构）。 */
int lea_idem_save_text_ex(const lea_idem_t *t, char *out, size_t out_size, int *skipped) {
    size_t off = 0;
    int nskipped = 0;
    char line[LEA_IDEM_RESULT_MAX + 1024];
    for (int i = 0; i < t->count; i++) {
        const lea_idem_entry_t *e = &t->entries[i];
        /* 三个 id 字段逐一转义后拼接（lea_json_escape_into 不含外层引号）。 */
        char dev_esc[256] = { 0 }, acc_esc[256] = { 0 }, key_esc[256] = { 0 };
        size_t eoff = 0;
        if (!lea_json_escape_into(dev_esc, sizeof(dev_esc), &eoff, e->device_id)) { nskipped++; continue; }
        eoff = 0;
        if (!lea_json_escape_into(acc_esc, sizeof(acc_esc), &eoff, e->account_id)) { nskipped++; continue; }
        eoff = 0;
        if (!lea_json_escape_into(key_esc, sizeof(key_esc), &eoff, e->key)) { nskipped++; continue; }
        int n = snprintf(line, sizeof(line),
                         "{\"device_id\":\"%s\",\"account_id\":\"%s\",\"key\":\"%s\","
                         "\"status\":\"%s\",\"dangerous\":%d,\"created_at\":%lld,"
                         "\"updated_at\":%lld,\"result\":%s}\n",
                         dev_esc, acc_esc, key_esc,
                         lea_idem_status_name(e->status), e->dangerous,
                         e->created_at, e->updated_at,
                         e->result[0] ? e->result : "null");
        if (n < 0 || (size_t)n >= sizeof(line)) { nskipped++; continue; }
        if (!lea_json_is_valid(line)) { nskipped++; continue; }
        if ((size_t)n >= out_size - off) return 0;
        memcpy(out + off, line, (size_t)n);
        off += (size_t)n;
    }
    if (off < out_size) out[off] = '\0';
    if (skipped) *skipped = nskipped;
    return 1;
}

int lea_idem_save_text(const lea_idem_t *t, char *out, size_t out_size) {
    return lea_idem_save_text_ex(t, out, out_size, NULL);
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
        lea_idem_entry_t e;
        memset(&e, 0, sizeof(e));
        char status[32] = { 0 };
        long long created = 0, updated = 0;
        long long dang = 0;
        if (!lea_json_string(line, "device_id", e.device_id, sizeof(e.device_id))) continue;
        if (!lea_json_string(line, "account_id", e.account_id, sizeof(e.account_id))) continue;
        if (!lea_json_string(line, "key", e.key, sizeof(e.key))) continue;
        if (!lea_json_string(line, "status", status, sizeof(status))) continue;
        if (!lea_json_long(line, "dangerous", &dang)) continue;
        if (!lea_json_long(line, "created_at", &created)) continue;
        if (!lea_json_long(line, "updated_at", &updated)) continue;
        /* result：取 "result": 后的原始 JSON 值（对象或 null）。
         * 注意行尾还有外层 idem 行的 }，必须用花括号配对提取，不能
         * 直接取到行尾。取出的值须过严格 JSON 校验，否则整行跳过。 */
        if (lea_json_object_raw(line, "result", e.result, sizeof(e.result))) {
            if (!lea_json_is_valid(e.result)) continue;
        } else {
            const char *rp = strstr(line, "\"result\":null");
            if (rp) snprintf(e.result, sizeof(e.result), "%s", "null");
            else continue;
        }
        e.status = lea_idem_status_from_name(status);
        e.dangerous = (int)dang;
        e.created_at = created;
        e.updated_at = updated;
        /* 表满时停止继续加载，但保留已加载的条目（返回 1，不清空）。 */
        if (t->count >= LEA_IDEM_MAX) break;
        t->entries[t->count++] = e;
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
