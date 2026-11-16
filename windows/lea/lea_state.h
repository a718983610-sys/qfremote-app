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
#include <stdio.h>
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
    /* 低项 3（2026-11-15）：scopes／lease_id 缓冲须与票据 lea_ticket_t
     * 同宽（lea_protocol.h:296-297：scopes[257]、lease_id[128]）。旧值
     * scopes[256]／lease_id[64] 会把服务端签发的超长字段静默截断，
     * 重启后 binding.dat（JSON 文本，字段级读写，改宽无迁移问题）与
     * 内存绑定不一致、票据重验 canonical 对不上即丢绑定。
     * 现行服务端值很短（scopes 约 35 字符），属边缘条件，改宽为防御。 */
    char scopes[257];       /* 逗号分隔，如 "muse.execute,muse.execute.dangerous" */
    long long expires_at;   /* 绑定票据过期（unix 秒，0=不过期） */
    char lease_id[128];
    char ticket_signature[512]; /* H02：服务端票据签名原文；binding.dat 持久化
                                 * 并在加载时重验（lea_binding_verify_ticket），
                                 * 签名缺失／不通过即丢弃绑定（UNBOUND）。 */
    long long updated_at;
} lea_binding_t;

void lea_binding_init(lea_binding_t *b);
int lea_binding_has_scope(const lea_binding_t *b, const char *scope);
/* 登录事件：旧绑定立即作废，epoch+1，进 PENDING。返回新 epoch。 */
long long lea_binding_on_login(lea_binding_t *b, const char *account_id,
                               const char *device_id, long long now_unix);
/* 服务端票据确认：epoch 须与 PENDING 态一致且未过期 → ACTIVE。
 * grant_muse_execute 收 long long：调用点已验签保证为 0/1，入参不再窄化。
 * ticket_signature 为验签通过的票据签名原文，原样存入绑定态，随
 * binding.dat 持久化（H02：加载时重验，见 lea_binding_verify_ticket）。
 * F-05（GPT 第二轮审计 F-05，P2，严格阻断项）：票据身份须与本机
 * PENDING 绑定一致才接受——account_id 精确比对（与 lea_admit 第 5 步
 * 同口径）；device_id 用 lea_device_id_matches 归一后比对（票据
 * device_id 可能是全形 "node//..."，本机绑定存裸形）。一张有效签名
 * 但属于别的账号／设备的票据（epoch 相同）此前会被接受并激活绑定，
 * 属跨设备票据混用，本函数内同一锁（调用点持 g_lock）下比对堵住。
 * 租约窗口：expires_at 须 > now 且 ≤ now＋LEA_BINDING_TICKET_MAX_TTL_SEC；
 * expires_at==0／负数／已过期／超长一律拒绝——0 值永不过期的票据
 * 不得再进入 ACTIVE 态。 */
/* 绑定票据最大租约（秒）：服务端签发 nowSec()＋24h（lea-core.js
 * TICKET_TTL_S = 24*3600），另加 5 分钟时钟偏差容限。取 24h＋5min
 * 而不是只取 24h 的理由：服务端与本机时钟可能有偏差，票据从签发到
 * 送达 confirm 还有 rebind 回包＋主程序转发的在途时间，卡死 24h 会
 * 把时钟略快／在途略久的合法票据误拒；5 分钟容限足够覆盖合理偏差
 * 与在途延迟，又足够小——任何声称租约超过 24h05m 的票据都不可能是
 * 服务端签发的真票据。 */
#define LEA_BINDING_TICKET_MAX_TTL_SEC (24 * 3600 + 300)
int lea_binding_confirm(lea_binding_t *b, const char *account_id, const char *device_id,
                        long long epoch, long long grant_epoch,
                        long long grant_muse_execute, const char *scopes,
                        const char *lease_id, long long expires_at,
                        const char *ticket_signature,
                        long long now_unix);
/* 登出／撤销：经 REVOKING 回 UNBOUND，epoch+1（旧 epoch 立即作废）。 */
void lea_binding_revoke(lea_binding_t *b, long long now_unix);
/* H02：重验内存绑定态的票据签名。按票据规范串 v1（9 行）从绑定态字段
 * 重建 canonical 并验签；签名缺失／规范串非法／验签失败一律返回 0。
 * 调用方（QFRLEA.c binding_load）在 state==ACTIVE 时用：不通过即丢弃
 * 绑定。注意：未接入真实公钥的严格构建下验签恒失败——与 binding.confirm
 * 的 fail-closed 口径一致（无公钥时本就建不成 ACTIVE 绑定）。 */
int lea_binding_verify_ticket(const lea_binding_t *b);
/* 绑定票据过期检查：ACTIVE 且 expires_at 已过 → 降级为 PENDING（需续租）。 */
int lea_binding_expired(const lea_binding_t *b, long long now_unix);

/* 设备 id 归一（与服务端 lea-core.js／lea-channel.js 的 bareNodeId 同口径）：
 * 去掉且仅去掉一层 "node//" 前缀；NULL 视为空串。
 * 注意：仅去一层——"node//node//x" 归一为 "node//x"，与服务端单次
 * slice(6) 一致，两端须同口径，不得多去。 */
const char *lea_bare_node_id(const char *id);
/* 归一后比对：裸形相等且非空才命中；空／退化 id（""／"node//"）永不命中
 *（与服务端 isWhitelisted 的空 want 拒绝口径一致，防空白名单误放行）。 */
int lea_device_id_matches(const char *a, const char *b);

/* 准入校验（DESIGN §6.2 顺序：绑定态 → 设备 → epoch → 授权 → Key → scope）。
 * 通过返回 1；拒绝返回 0 并在 err_code 写错误码。
 * revoked_key_ids: 本地吊销 Key ID 表（服务端吊销的本地镜像），可为 NULL。 */
int lea_admit(const lea_envelope_t *env, const lea_binding_t *bind,
              const char *const *revoked_key_ids, int n_revoked,
              char *err_code, size_t err_size);

/* ---------------- 重放表 ---------------- */
#define LEA_REPLAY_MAX 4096
typedef struct {
    char request_id[129];
    char nonce[129];
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
/* M-076: durable replay snapshot; caller atomically replaces its protected file.
 * Loading is all-or-nothing: malformed/truncated snapshots fail closed. */
int lea_replay_save_to_file(const lea_replay_t *r, FILE *f, long long now_unix);
int lea_replay_load_file(lea_replay_t *r, FILE *f, long long now_unix);

/* ---------------- 幂等表 ---------------- */
/* S-022 取消状态机：取消只对“排队未执行”的 job 生效，终态为 CANCELLED；
 * 运行中 job 的取消请求只记 CANCEL_REQUESTED（job 仍跑到自然终态，
 * 不谎报已取消——副作用是否发生必须有终态交代）。
 * 合法迁移（lea_idem_transition_ok 强制）：
 *   RECEIVED → RUNNING／CANCELLED／EXPIRED／UNKNOWN
 *   RUNNING → SUCCEEDED／FAILED／UNKNOWN／CANCEL_REQUESTED／CANCELLED
 *     （→CANCELLED 仅排队取消路径：入队时幂等已置 RUNNING，但项尚未执行）
 *   CANCEL_REQUESTED → CANCELLING／SUCCEEDED／FAILED／UNKNOWN
 *     （自然终态覆盖取消请求；CANCELLING 为取消执行中的中间态）
 *   CANCELLING → CANCELLED／UNKNOWN
 *   SUCCEEDED／FAILED／UNKNOWN／EXPIRED／CANCELLED 为终态，不再迁移。
 * 崩溃恢复（lea_idem_mark_crashed_unknown）：RECEIVED／RUNNING／
 * CANCEL_REQUESTED／CANCELLING → UNKNOWN（取消未完成即结果未知）。 */
typedef enum {
    LEA_IDEM_RECEIVED = 0,
    LEA_IDEM_RUNNING = 1,
    LEA_IDEM_SUCCEEDED = 2,
    LEA_IDEM_FAILED = 3,
    LEA_IDEM_UNKNOWN = 4,
    LEA_IDEM_EXPIRED = 5,
    LEA_IDEM_CANCEL_REQUESTED = 6,
    LEA_IDEM_CANCELLING = 7,
    LEA_IDEM_CANCELLED = 8
} lea_idem_status_t;

const char *lea_idem_status_name(lea_idem_status_t s);
lea_idem_status_t lea_idem_status_from_name(const char *name);
/* S-022：迁移合法性（纯函数）。 */
int lea_idem_transition_ok(lea_idem_status_t from, lea_idem_status_t to);

#define LEA_IDEM_MAX 2048
#define LEA_IDEM_RESULT_MAX 8192
typedef struct {
    char device_id[128];
    char account_id[128];
    char key[129]; /* idempotency_key */
    lea_idem_status_t status;
    int dangerous;
    long long created_at;
    long long updated_at;
    char result[LEA_IDEM_RESULT_MAX]; /* 缓存的响应 JSON（成功/失败终态） */
    /* S-022：job 查询用（job_id 缺省等同 request_id；旧文件无此二字段时
     * 加载为空串，job 查询对旧条目回 not-found，不破坏旧文件加载）。 */
    char request_id[129];
    char job_id[129];
    char command[32];
} lea_idem_entry_t;

typedef struct {
    lea_idem_entry_t entries[LEA_IDEM_MAX];
    int count;
} lea_idem_t;

void lea_idem_init(lea_idem_t *t);
lea_idem_entry_t *lea_idem_lookup(lea_idem_t *t, const char *device_id,
                                 const char *account_id, const char *key);
/* S-022：按 job_id／request_id 查条目（job.query 用；job_id 优先，
 * job_id 为空时按 request_id 比对；无匹配返回 NULL）。 */
lea_idem_entry_t *lea_idem_lookup_by_job(lea_idem_t *t, const char *job_id);
/* 不存在则新建 RECEIVED 并返回；表满返回 NULL。 */
lea_idem_entry_t *lea_idem_get_or_create(lea_idem_t *t, const char *device_id,
                                         const char *account_id, const char *key,
                                         int dangerous, long long now_unix);
void lea_idem_set_status(lea_idem_t *t, lea_idem_entry_t *e,
                         lea_idem_status_t status, const char *result,
                         long long now_unix);
/* S-022：取消三步（非法迁移返回 0 且不改表；合法返回 1）。
 * request_cancel：RUNNING→CANCEL_REQUESTED（运行中 job 记请求，不停执行）。
 * mark_cancelling：CANCEL_REQUESTED→CANCELLING。
 * mark_cancelled：RECEIVED／RUNNING／CANCEL_REQUESTED／CANCELLING→CANCELLED
 *   （终态；result 可为 NULL，不传即保留原缓存）。 */
int lea_idem_request_cancel(lea_idem_t *t, lea_idem_entry_t *e, long long now_unix);
int lea_idem_mark_cancelling(lea_idem_t *t, lea_idem_entry_t *e, long long now_unix);
int lea_idem_mark_cancelled(lea_idem_t *t, lea_idem_entry_t *e,
                            const char *result, long long now_unix);
/* 保留期清理：普通 >7 天、危险 >30 天的终态条目删除；返回删除数。 */
int lea_idem_prune(lea_idem_t *t, long long now_unix);
/* 启动恢复：崩溃残留的 RUNNING/RECEIVED 标记为 UNKNOWN（不自动重试）。 */
int lea_idem_mark_crashed_unknown(lea_idem_t *t, long long now_unix);

/* 序列化／反序列化（JSONL 文本；调用方负责文件读写）。
 * H09：save 时逐行校验，非法行跳过不写（不得写出毒化整表的非法行）；
 * load 时坏行隔离跳过，不清空整表。
 * #26：save_to_file 直接逐行写文件流，不再要求整表先装进一块内存缓冲
 * （旧 4MB static 缓冲超了即不持久化）；load_line 逐行解析，供调用方
 * 流式读文件时用，同样不再要求整文件先读进内存。 */
int lea_idem_save_text(const lea_idem_t *t, char *out, size_t out_size);
/* 同 save_text，另经 skipped 回跳过的非法行数（可为 NULL）。 */
int lea_idem_save_text_ex(const lea_idem_t *t, char *out, size_t out_size, int *skipped);
/* #26：把整表逐行写入已打开的文件流（fputs 行＋换行）；非法行跳过记数，
 * 写失败返回 0。调用方负责 tmp+rename 原子替换。 */
int lea_idem_save_to_file(const lea_idem_t *t, FILE *f, int *skipped);
int lea_idem_load_text(lea_idem_t *t, const char *text);
/* #26：解析单行（不含换行）并在合法时追加一条；坏行／超长行返回 0 且不
 * 改表（调用方直接跳过该行）。不清空表、不重置表——调用方先 lea_idem_init。 */
int lea_idem_load_line(lea_idem_t *t, const char *line);

/* ---------------- 吊销表写入（#17） ---------------- */
/* C 侧吊销表写入方：lea_revoked_write（全量替换 revoked_keys.txt）。
 * 主路径仍是服务端下发前推送（H21，lea-core.js syncRevocations，经
 * runcommands 写本机文件）；本函数是 C 侧的第二写入方——主程序在 rebind
 * 拿到 revoked_key_ids 后经内部命令 keys.sync-revoked 调入（见 QFRLEA.c
 * handle_internal），使本地 key_is_revoked 的检查不再是“只读不写”的
 * 死机制。任一 id 非法（非 token 字符集）即整单拒绝，不写残集；
 * 原子 tmp+rename；去重＋排序（与服务端全集格式一致）。
 * 上限 LEA_REVOKED_MAX_IDS 条；path 为空或 n_key_ids < 0 返回 0。 */
#define LEA_REVOKED_MAX_IDS 512
int lea_revoked_write(const char *path, const char *const *key_ids, int n_key_ids);
/* 吊销表并集合并（#17 第二轮）：keys.sync-revoked 的实际写入方。读出现有
 * 表，与传入 id 取并集后经 lea_revoked_write 原子写回；陈旧快照至多无
 * 操作，永不缩表（见 lea_state.c 注释：两个全量替换写入方无序到达时
 * 全量替换会丢新吊销项）。空集真 no-op（短路成功，不读盘不写盘）。
 * 读盘失败只认确证不存在（ENOENT）为空表，其他失败整单拒绝；写前
 * 重读比对基线（CAS），不一致即重合并；写后校验期望集（传入＋各轮
 * 读到的现有表，累积只增）全在表内，缺失则有界重试（最多 3 次）。
 * 现有行非法／并集超上限即整单拒绝、原文件不动。 */
int lea_revoked_merge(const char *path, const char *const *key_ids, int n_key_ids);
/* 吊销表世代 sidecar（#1 版本化）：revoked_keys.txt → revoked_keys.gen，
 * 与服务端 H21 推送脚本写同一文件。内容为十进制整数＋换行。
 * generation_read：缺失即 *out=0 返回 1；内容损坏／其他读失败返回 0。
 * generation_write：原子 tmp+rename 写盘，generation 为负返回 0。
 * generation_advance：只向前推进（当前已 ≥ generation 即无操作成功，
 * 绝不回退）；读失败返回 0。 */
int lea_revoked_gen_path(const char *path, char *out, size_t out_size);
int lea_revoked_generation_read(const char *gen_path, long long *out);
int lea_revoked_generation_write(const char *gen_path, long long generation);
int lea_revoked_generation_advance(const char *gen_path, long long generation);
/* 带世代的并集合并（#1 版本化）：keys.sync-revoked 带 generation 时的
 * 写入方。generation < 0 表示成员缺失（旧版回包），走无版本合并，不碰
 * 世代文件；generation ≥ 0 时陈旧判定只在首轮做一次（小于本机已接受
 * 的最大世代即陈旧，*out_stale 置 1 并返回 0，不写盘；重试轮不再重判，
 * 否则本函数自己推进的世代会让下一轮自判 stale），否则并集合并，成功
 * 后条件推进世代，再最终重读验累积期望集＋世代稳定性（写盘后世代被
 * 他方改动即重合并，最多 3 轮）。世代文件损坏即整单拒绝。out_stale
 * 可为 NULL。 */
int lea_revoked_merge_with_generation(const char *path, const char *const *key_ids, int n_key_ids,
                                      long long generation, int *out_stale);
/* ---------------- 吊销表读取（F-01 三态，fail-closed） ---------------- */
/* 本机吊销表（revoked_keys.txt）读取失败时旧实现直接当“未吊销”
 * （QFRLEA.c key_is_revoked fopen 失败 return 0），即 GPT 第二轮审计
 * F-01（P1）。本节改为三态：REVOKED / NOT_REVOKED / ERROR，ERROR 时
 * 两处调用点一律拒绝（见 lea_revocation_error_code）。
 * 快照格式（与写入方 lea_revoked_write／H21 推送一致）：LF 行尾、每行
 * 一个 token（[A-Za-z0-9_-]，8..128 字节）、末行带换行、排序去重、
 * 总数 ≤ LEA_REVOKED_MAX_IDS；世代见同目录 revoked_keys.gen sidecar。
 * 严格校验按“全有或全无”：任一结构性异常即整份 ERROR，不跳过异常行。 */
typedef enum {
    LEA_REVOCATION_NOT_REVOKED = 0,
    LEA_REVOCATION_REVOKED = 1,
    LEA_REVOCATION_ERROR = 2
} lea_revocation_status_t;

/* 三态 → 准入错误码（显式全映射）：仅 NOT_REVOKED 返回 NULL（放行）；
 * REVOKED → LEA_ERR_KEY_REVOKED；ERROR 与任何未知值 →
 * LEA_ERR_REVOCATION_UNAVAILABLE（fail-closed）。两处调用点（sys.*
 * 内联、普通信封）都调它，禁止手写 "== REVOKED" 的布尔判定。 */
static inline const char *lea_revocation_error_code(lea_revocation_status_t st) {
    switch (st) {
        case LEA_REVOCATION_NOT_REVOKED: return NULL;
        case LEA_REVOCATION_REVOKED: return LEA_ERR_KEY_REVOKED;
        case LEA_REVOCATION_ERROR: return LEA_ERR_REVOCATION_UNAVAILABLE;
        default: return LEA_ERR_REVOCATION_UNAVAILABLE;
    }
}

/* 吊销快照严格校验（全有或全无）：读世代 sidecar＋快照文件，任一结构
 * 性异常即返回 0（调用方按 ERROR 处理），不跳过异常行继续。
 * snapshot_gen_out 可为 NULL；非 NULL 时回填快照世代（sidecar 值；
 * 无 sidecar 的旧版快照回填 -1）。
 * max_accepted_generation：本机已接受的最大世代（调用方维护的高水位，
 * 只增）；快照世代更小即陈旧 → 0。
 * has_history：本机曾经有已接受世代或绑定历史（QFRLEA 启动时判定）；
 * 文件缺失时 has_history 为真即 0（突然缺失，不当空表），为假即视为
 * 合法空表（首次安装）。 */
int lea_revoked_validate_snapshot(const char *path, long long max_accepted_generation,
                                  int has_history, long long *snapshot_gen_out);
/* 三态吊销判定：先严格校验快照，再在合法快照内比对 api_key_id。
 * api_key_id 非法（NULL／空／非 token 字符集）即 ERROR——信封解析已
 * 先验过 id 格式，此处是防御性 fail-closed。 */
lea_revocation_status_t lea_revoked_check(const char *path, const char *api_key_id,
                                          long long max_accepted_generation, int has_history,
                                          long long *snapshot_gen_out);
/* 吊销迁移标记（.gen 缺失 fail-open 窗口，DS-Q4）：revoked_keys.txt →
 * revoked_keys.migrated，内容严格为 "1\n"（schema v1），含义“本安装的
 * 吊销世代状态已建立（首次安装初始化或旧版迁移）”。migrated_read：
 * 1=有效标记，0=不存在（ENOENT），-1=损坏／不可读／其他错误。
 * migrated_write：原子 tmp+rename 写 "1\n"，成功 1 失败 0。
 * migration_decision（纯函数）：snap>=0 → 0 放行；snap==-1 → -1 应
 * DEGRADED（X-01，站长 2026-11-15 亲令严格 fail-closed：取消自动迁移，
 * 无 .gen 的旧版快照一律 DEGRADED，须管理员跑显式迁移工具
 * QFRLEA.exe --migrate-revoked；have_gen／have_migrated 不再区分）。
 * （故意不用 have_binding 做参数：迁移前验证器已确认快照合法，迁移
 * 只写 .gen＋标记、不动表，无论有无绑定都安全。） */
int lea_revoked_migrated_path(const char *path, char *out, size_t out_size);
int lea_revoked_migrated_read(const char *mpath);
int lea_revoked_migrated_write(const char *mpath);
int lea_revoked_migration_decision(int have_gen, int have_migrated, long long snap);
/* 测试钩子（仅单测用，测试专用编译隔离：只在定义 LEA_TEST_HOOKS 时
 * 声明；生产构建不定义）：merge 每轮基线读后、写前重读前调用一次，
 * 世代合并在世代推进后、最终重读前亦调用一次（同一钩子），用于确定
 * 性模拟 H21 直写落在读-写之间或写盘与世代推进之间。生产代码永不设置。 */
#ifdef LEA_TEST_HOOKS
void lea_revoked_merge_set_pre_write_hook(void (*hook)(const char *path));
#endif
typedef struct lea_queue_item lea_queue_item_t;
struct lea_queue_item {
    lea_envelope_t env;
    int dangerous; /* 所在 lane */
    lea_idem_entry_t *idem; /* 关联幂等条目（服务层填写） */
    void *ctx;              /* 服务层私有：完成事件／结果缓冲 */
    /* B1：入队前 batch-seq 检查已记的 prev_seq（-1=该 batch 本次新建）。
     * 看门狗／sys.reset 清队列时，未执行的 batch 步须用它回滚，否则该
     * seq 被记为“已消费”，重试同步会被判重复拒绝（与队列满路径同款）。 */
    long long batch_prev_seq;
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
    char batch_id[129];
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
/* RC-02：按 api_key_id 摘除队列中全部待执行项（吊销踢出用）。返回摘下的
 * 链表头（调用方负责逐项完成＋释放），*removed_out 回填条数（可为 NULL）。
 * 危险 lane 与普通 lane 都摘；摘下的链表保持各 lane 内的原入队顺序。
 * api_key_id 为空即返回 NULL。 */
lea_queue_item_t *lea_queue_remove_key(lea_queue_t *q, const char *api_key_id, int *removed_out);
/* S-022：按 job_id 找排队项（只看不摘；job_id 缺省等同 request_id）。
 * 匹配 env.job_id 或 env.request_id；无匹配返回 NULL。 */
lea_queue_item_t *lea_queue_find_by_request_id(lea_queue_t *q, const char *job_id);
/* S-022：按 job_id 摘除排队项（job.cancel 用；调用方负责标记幂等终态、
 * batch seq 回滚、g_inflight 扣减、通知等待方与释放）。已在执行的项
 * 不在队列里，摘不到——调用方另查活动 job。job_id 为空返回 NULL。 */
lea_queue_item_t *lea_queue_cancel_by_request_id(lea_queue_t *q, const char *job_id);

#ifdef __cplusplus
}
#endif

#endif
