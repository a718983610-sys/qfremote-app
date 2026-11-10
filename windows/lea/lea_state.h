/* QFRLEA 状态层（纯 C，无 Windows 依赖，可在 Linux 上单测）。
 *
 * 三件状态：
 *   1. 绑定态（内存实时态，DESIGN §6.1 状态机）：
 *      UNBOUND -> PENDING -> ACTIVE -> REVOKING -> UNBOUND。
 *      换绑：旧绑定立即作废（epoch+1），不回滚；失败进 UNBOUND。
 *   2. 幂等去重表（DESIGN §4.2）：键 (device_id, account_id, idempotency_key)，
 *      状态 RECEIVED/RUNNING/SUCCEEDED/FAILED/UNKNOWN/EXPIRED，
 *      普通保留 ≥7 天、危险命令 30 天；持久化到 JSONL 快照文件。
 *   3. 重放表：nonce / request_id 去重，保留 ≥10 分钟（内存态）。
 *   4. 队列（DESIGN §5.3）：同一设备串行 FIFO，上限 100 条；危险命令单独
 *      串行 lane（独立 FIFO，执行顺序上优先于普通 lane，但同一 worker
 *      串行执行，全局仍串行；H10：危险 lane 连续出队配额 4，满额后轮转
 *      一条普通命令，防饿死）。
 *
 * 持久化文件格式（idempotency.jsonl，每行一条 JSON，服务负责文件 IO，
 * 本层只负责内存表与序列化）：
 *   {"device_id":"...","account_id":"...","key":"...","status":"...",
 *    "dangerous":0,"created_at":...,"updated_at":...,"result":"{...}"}
 * result 为缓存的响应 JSON（不含换行），重放时原样返回。
 */
#ifndef QFRLEA_STATE_H
#define QFRLEA_STATE_H

#include <stddef.h>
#include "lea_protocol.h"

#ifdef __cplusplus
extern "C" {
#endif

/* ---------------- 绑定 ---------------- */
typedef enum {
    LEA_BIND_UNBOUND = 0,
    LEA_BIND_PENDING = 1,
    LEA_BIND_ACTIVE = 2,
    LEA_BIND_REVOKING = 3
} lea_bind_state_t;

const char *lea_bind_state_name(lea_bind_state_t s);

typedef struct {
    lea_bind_state_t state;
    char account_id[128];
    char device_id[128];
    long long epoch;        /* binding_epoch */
    long long grant_epoch;
    int grant_muse_execute; /* 1=账号已授 muse.execute */
    char scopes[256];       /* 逗号分隔，如 "muse.execute,muse.execute.dangerous" */
    long long expires_at;   /* 绑定票据过期（unix 秒，0=不过期） */
    char lease_id[64];
    long long updated_at;
} lea_binding_t;

void lea_binding_init(lea_binding_t *b);
int lea_binding_has_scope(const lea_binding_t *b, const char *scope);
/* 登录事件：旧绑定立即作废，epoch+1，进 PENDING。返回新 epoch。 */
long long lea_binding_on_login(lea_binding_t *b, const char *account_id,
                               const char *device_id, long long now_unix);
/* 服务端票据确认：epoch 须与 PENDING 态一致且未过期 → ACTIVE。
 * grant_muse_execute 收 long long：调用点已验签保证为 0/1，入参不再窄化。 */
int lea_binding_confirm(lea_binding_t *b, long long epoch, long long grant_epoch,
                        long long grant_muse_execute, const char *scopes,
                        const char *lease_id, long long expires_at,
                        long long now_unix);
/* 登出／撤销：经 REVOKING 回 UNBOUND，epoch+1（旧 epoch 立即作废）。 */
void lea_binding_revoke(lea_binding_t *b, long long now_unix);
/* 绑定票据过期检查：ACTIVE 且 expires_at 已过 → 降级为 PENDING（需续租）。 */
int lea_binding_expired(const lea_binding_t *b, long long now_unix);

/* 准入校验（DESIGN §6.2 顺序：绑定态 → 设备 → epoch → 授权 → Key → scope）。
 * 通过返回 1；拒绝返回 0 并在 err_code 写错误码。
 * revoked_key_ids: 本地吊销 Key ID 表（服务端吊销的本地镜像），可为 NULL。 */
int lea_admit(const lea_envelope_t *env, const lea_binding_t *bind,
              const char *const *revoked_key_ids, int n_revoked,
              char *err_code, size_t err_size);

/* ---------------- 重放表 ---------------- */
#define LEA_REPLAY_MAX 4096
typedef struct {
    char request_id[64];
    char nonce[128];
    long long expires_at; /* 保留到此时（issued+600s） */
    int used;
} lea_replay_entry_t;

typedef struct {
    lea_replay_entry_t entries[LEA_REPLAY_MAX];
    int count;
} lea_replay_t;

void lea_replay_init(lea_replay_t *r);
/* 命中已见 request_id 或 nonce 返回 0（重放）；否则记入并返回 1。 */
int lea_replay_check_and_add(lea_replay_t *r, const char *request_id,
                             const char *nonce, long long now_unix);
void lea_replay_prune(lea_replay_t *r, long long now_unix);

/* ---------------- 幂等表 ---------------- */
typedef enum {
    LEA_IDEM_RECEIVED = 0,
    LEA_IDEM_RUNNING = 1,
    LEA_IDEM_SUCCEEDED = 2,
    LEA_IDEM_FAILED = 3,
    LEA_IDEM_UNKNOWN = 4,
    LEA_IDEM_EXPIRED = 5
} lea_idem_status_t;

const char *lea_idem_status_name(lea_idem_status_t s);
lea_idem_status_t lea_idem_status_from_name(const char *name);

#define LEA_IDEM_MAX 2048
#define LEA_IDEM_RESULT_MAX 8192
typedef struct {
    char device_id[128];
    char account_id[128];
    char key[128]; /* idempotency_key */
    lea_idem_status_t status;
    int dangerous;
    long long created_at;
    long long updated_at;
    char result[LEA_IDEM_RESULT_MAX]; /* 缓存的响应 JSON（成功/失败终态） */
} lea_idem_entry_t;

typedef struct {
    lea_idem_entry_t entries[LEA_IDEM_MAX];
    int count;
} lea_idem_t;

void lea_idem_init(lea_idem_t *t);
lea_idem_entry_t *lea_idem_lookup(lea_idem_t *t, const char *device_id,
                                 const char *account_id, const char *key);
/* 不存在则新建 RECEIVED 并返回；表满返回 NULL。 */
lea_idem_entry_t *lea_idem_get_or_create(lea_idem_t *t, const char *device_id,
                                         const char *account_id, const char *key,
                                         int dangerous, long long now_unix);
void lea_idem_set_status(lea_idem_t *t, lea_idem_entry_t *e,
                         lea_idem_status_t status, const char *result,
                         long long now_unix);
/* 保留期清理：普通 >7 天、危险 >30 天的终态条目删除；返回删除数。 */
int lea_idem_prune(lea_idem_t *t, long long now_unix);
/* 启动恢复：崩溃残留的 RUNNING/RECEIVED 标记为 UNKNOWN（不自动重试）。 */
int lea_idem_mark_crashed_unknown(lea_idem_t *t, long long now_unix);

/* 序列化／反序列化（JSONL 文本；调用方负责文件读写）。
 * H09：save 时逐行校验，非法行跳过不写（不得写出毒化整表的非法行）；
 * load 时坏行隔离跳过，不清空整表。 */
int lea_idem_save_text(const lea_idem_t *t, char *out, size_t out_size);
/* 同 save_text，另经 skipped 回跳过的非法行数（可为 NULL）。 */
int lea_idem_save_text_ex(const lea_idem_t *t, char *out, size_t out_size, int *skipped);
int lea_idem_load_text(lea_idem_t *t, const char *text);

/* ---------------- 队列 ---------------- */
typedef struct lea_queue_item lea_queue_item_t;
struct lea_queue_item {
    lea_envelope_t env;
    int dangerous; /* 所在 lane */
    lea_idem_entry_t *idem; /* 关联幂等条目（服务层填写） */
    void *ctx;              /* 服务层私有：完成事件／结果缓冲 */
    lea_queue_item_t *next;
};

typedef struct {
    lea_queue_item_t *normal_head, *normal_tail;
    lea_queue_item_t *danger_head, *danger_tail;
    int normal_count;
    int danger_count;
    /* H10 防饿死：连续取危险 lane 的次数；取普通 lane 时清零。 */
    int danger_streak;
} lea_queue_t;

/* H10：危险 lane 连续出队配额——连续取满此数后，若普通 lane 有等待项
 * 则必须取一条普通命令（轮转），再继续取危险 lane。 */
#define LEA_DANGER_QUOTA 4

/* H10：批量序号单调表（内存态，随服务重启清空；重放表已先拦重复
 * request_id／nonce）。键 (device_id, account_id, batch_id)，记每批
 * 已见的最大 seq；同批 seq 必须严格递增，否则拒绝（乱序／重放步）。 */
#define LEA_BATCH_SEQ_MAX 128
typedef struct {
    char device_id[128];
    char account_id[128];
    char batch_id[64];
    long long last_seq;
    long long updated_at;
} lea_batch_seq_entry_t;

typedef struct {
    lea_batch_seq_entry_t entries[LEA_BATCH_SEQ_MAX];
    int count;
} lea_batch_seq_t;

void lea_batch_seq_init(lea_batch_seq_t *t);
/* 返回 1=接受并记录；0=拒绝。batch_id 为空（单条）时要求 seq==1；
 * 首次见到的 batch 接受任意 seq>=1 并记录；已见 batch 要求 seq 严格大于
 * 已记的最大值。seq<1 一律拒绝。
 * prev_seq_out（可为 NULL）：接受时回填本次记录前的 last_seq（新 batch
 * 为 -1）。调用方在“检查通过、但后续入队失败”时须用它调
 * lea_batch_seq_rollback 回滚，否则该 seq 会被记为“已消费”，重试同
 * 步会被判重复拒绝（DS 复查 H10 阻塞项：队列满可重试不得退化为永久卡死）。 */
int lea_batch_seq_check(lea_batch_seq_t *t, const char *device_id,
                        const char *account_id, const char *batch_id,
                        long long seq, long long now_unix, long long *prev_seq_out);
/* 回滚一次已记录的 seq：仅当该 batch 当前 last_seq 恰好等于 seq（即本次
 * 检查是最后一次写入）时恢复为 prev_seq（-1 表示该 batch 是本次新建的，
 * 直接删除条目）；last_seq 已被更大 seq 推进时不做任何事（该步已被后续
 * 步超越，重试本就是乱序，拒绝是正确的 fail-closed）。batch_id 为空时
 * 无记录可回滚，直接返回。 */
void lea_batch_seq_rollback(lea_batch_seq_t *t, const char *device_id,
                            const char *account_id, const char *batch_id,
                            long long seq, long long prev_seq);

void lea_queue_init(lea_queue_t *q);
int lea_queue_total(const lea_queue_t *q);
/* 入队：满（总数 ≥100）返回 0 并置 err=QFR_QUEUE_FULL；否则返回 1。 */
int lea_queue_enqueue(lea_queue_t *q, lea_queue_item_t *item,
                      char *err, size_t err_size);
/* 出队：危险 lane 优先（单独串行 lane）；无项返回 NULL。 */
lea_queue_item_t *lea_queue_dequeue(lea_queue_t *q);
void lea_queue_item_free(lea_queue_item_t *item);

#ifdef __cplusplus
}
#endif

#endif
