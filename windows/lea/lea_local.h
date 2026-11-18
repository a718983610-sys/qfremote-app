/* lea_local.h — LEA 本机控制状态（S-021，2026-11-15）
 * =================================================================
 * 设备本机 LEA 状态入口：暂停／危险授权／一键撤销／状态查询。
 * 纯 C，无 Windows 依赖，可在 Linux 单测里跑（见 test/test_lea.c 的
 * S-021 组）；QFRLEA.c（Windows 服务）与 QFRLEA.exe CLI 共用。
 *
 * 状态文件（全部落在 %ProgramData%\QFR\LEA 下，即 base_dir）：
 *   lea-paused            存在即已暂停（内容为暂停时刻 unix 秒）
 *   dangerous-consent.json {"consented":bool,"at":unix}（危险 scope 本机授权）
 *   revoke-all.json        {"revoked":true,"at":unix,"grant_epoch":n,
 *                           "expires_at":n}（一键撤销所有 Key；后两字段为
 *                           撤销时绑定的服务端单调量，供恢复判定用，旧格式
 *                           无此二字段即按 0 计）
 *   emergency-stop.json    紧急停控显式状态（见 lea_emergency_stop_t；
 *                           stopped 字段＋stop_seq 单调＋cleared_by_*；
 *                           清除不删文件，只写 stopped:false）
 *   recovery-tickets-used.json 已用恢复票据记录（JSONL，每行一票；
 *                           status=consumed_pending_clear|recovered|superseded）
 *   lea-status.json        状态快照（见 lea_local_status_t；原子写 tmp+rename）
 * 缺失文件即默认态（未暂停／未授权／未撤销／空绑定字段），绝不因
 * 文件缺失而拒绝查询——查询永远有答案。
 *
 * 安全边界：
 *   - 本模块只读写本机状态文件，不验签名、不改绑定、不执行命令；
 *     暂停／撤销只影响本机准入（QFRLEA.c handle_envelope 的 4.4 门
 *     与 key_revocation_check），不碰服务端。
 *   - CLI（lea_local_cli）只认本地命令行 argv，绝不经命名管道／
 *     LEA API 远程调用（QFRLEA.c main() 在服务启动前分流）。
 *   - v6 裁决（2026-11-17，站长）：正式版 CLI 只保留 --status 只读
 *     查询；--pause／--resume／--revoke-all-keys／
 *     --authorize-dangerous／--revoke-dangerous-consent 在
 *     lea_local_cli 入口显式拒绝（unsupported-command，返回 2），
 *     且绝不改状态。识别集合仍含这 5 个名字，只为让它们进到
 *     CLI 入口拿明确的拒绝错误，而不是落到 main() 的服务启动分支。
 *   - A7（2026-11-18，GPT 裁决）：管道侧（--internal）5 个改状态
 *     命令同样一律拒绝（见 lea_internal_state_command），改状态只
 *     能走已签名已审计的信封通路（QFRLEA.c handle_envelope 内联
 *     lea.* 命令）；正式撤销另走服务端控制台 API。底层状态读写
 *     函数本身仍保留（供信封通路调用），拒绝只发生在入口分发层。
 *   - 状态 JSON 只含账号／设备／命令名／结果码／时间戳，不含 Key、
 *     票据、签名等秘密。
 */
#ifndef QFRLEA_LOCAL_H
#define QFRLEA_LOCAL_H

#include <stddef.h>
#include "lea_protocol.h" /* lea_recovery_ticket_t（恢复判定用） */

#ifdef __cplusplus
extern "C" {
#endif

/* 本机状态快照。account_id／device_id 取自状态文件里的绑定字段
 * （CLI 进程绑定为空时不覆盖文件里已有值，见 lea_local_refresh_status）。 */
typedef struct {
    int paused;                     /* lea-paused 标记在位 */
    int dangerous_consented;        /* 危险 scope 本机授权在位 */
    long long dangerous_consented_at;
    int revoked_all;                /* revoke-all 标记在位 */
    long long revoked_at;
    char account_id[128];           /* 已绑定账号（未知即空串） */
    char device_id[128];            /* 已绑定设备（未知即空串） */
    char last_command[32];          /* 最近执行命令类型（例 ui.click） */
    char last_result[64];           /* 最近结果："ok" 或错误码 */
    long long last_command_at;      /* 最近执行时刻 unix 秒 */
    int emergency_stopped;          /* emergency_stop 标记在位 */
    char emergency_stop_event_id[128]; /* 活动停控事件 ID（未停控即空串） */
    char emergency_sync_status[16]; /* "pending" / "synced"（未停控即空串） */
} lea_local_status_t;

void lea_local_status_init(lea_local_status_t *s);

/* base_dir 解析：传入非空即用；为空／NULL 时取默认
 * （Windows：%ProgramData%\QFR\LEA；其它平台：$LEA_LOCAL_DIR，
 * 未设即失败）。返回 1=已填出，0=解析不出（调用方 fail-closed：
 * 查询类返回默认态，写类返回失败）。 */
int lea_local_base_dir(const char *base_dir, char *out, size_t out_size);

/* 暂停标记：读／写／清。set_paused(base,1) 写标记，(base,0) 删标记。 */
int lea_local_is_paused(const char *base_dir);
int lea_local_set_paused(const char *base_dir, int paused);

/* 危险授权：读／写。set(...,0) 写 consented:false（留文件备查）。 */
int lea_local_has_dangerous_consent(const char *base_dir);
int lea_local_set_dangerous_consent(const char *base_dir, int consented);

/* 一键撤销：读／写／清。set(...,1) 写 revoke-all.json；
 * clear 删文件（登录换号时清除，见 QFRLEA.c session.login_changed）。
 * set_revoke_all_at 另记撤销时绑定的 grant_epoch／expires_at（服务端
 * 单调量），供 binding.confirm 恢复判定用；get_revoke_all 读回这两值
 * （旧格式标记无此二字段即按 0 计）。 */
int lea_local_has_revoke_all(const char *base_dir);
int lea_local_set_revoke_all(const char *base_dir, int revoked);
int lea_local_set_revoke_all_at(const char *base_dir, int revoked,
                                long long grant_epoch, long long expires_at);
int lea_local_get_revoke_all(const char *base_dir, long long *grant_epoch_out,
                             long long *expires_at_out);
int lea_local_clear_revoke_all(const char *base_dir);

/* A7：撤销恢复判定（纯函数）。标记值 vs 新票据值，任一新票据单调量
 * 更大即允许清除标记（旧票据重放不得清除）。 */
int lea_revoke_recovery_allowed(long long marker_grant_epoch,
                                long long marker_expires_at,
                                long long ticket_grant_epoch,
                                long long ticket_expires_at);

/* emergency_stop 本机紧急停控状态（GPT 2026-11-18 裁决问题 1＋六节，
 * 见 DESIGN.md §3）。状态文件 emergency-stop.json（显式 stopped 字段，
 * 不以"文件不存在"表示解锁）：
 *   {"stopped":bool,"stop_event_id":"estop-<seq>-<unix>","stop_seq":N,
 *    "account_id":"...","device_id":"...","scope":"device-control",
 *    "binding_epoch":N,"grant_epoch":N,"stopped_at":unix,
 *    "sync_status":"pending|synced","sync_receipt":"<receipt_id>",
 *    "last_recovery_epoch":N,"cleared_by_ticket_id":"...",
 *    "cleared_by_recovery_epoch":N,"cleared_at":unix}
 * 写盘一律走 lea_file_write_atomic（A9）；清除时不删文件，改为写
 * stopped:false＋cleared_by_*（大肥鱼 Q3：清除须原子记录 cleared_by，
 * 不能只删 boolean）。stop_seq 本机单调，清除后保留不清零。
 * 首次停控前文件不存在＝未停控；一旦停控过文件永久存在，此后文件
 * 缺失／损坏／不可解析一律按已停控处理（fail-closed，大肥鱼 Q1）。 */
typedef struct {
    int stopped;
    char stop_event_id[128];
    long long stop_seq;
    char account_id[128];
    char device_id[128];
    char scope[128];
    long long binding_epoch;
    long long grant_epoch;
    long long stopped_at;
    char sync_status[16];       /* "pending" / "synced" */
    char sync_receipt[128];     /* 服务端同步回执 receipt_id，未同步即空串 */
    long long last_recovery_epoch;
    char cleared_by_ticket_id[128];
    long long cleared_by_recovery_epoch;
    long long cleared_at;
} lea_emergency_stop_t;

void lea_emergency_stop_init(lea_emergency_stop_t *s);

/* 停控状态 JSON 编解码（from：缺失字段留默认；脏数据返回 0）。 */
int lea_emergency_stop_to_json(const lea_emergency_stop_t *s, char *out, size_t out_size);
int lea_emergency_stop_from_json(const char *text, lea_emergency_stop_t *out);

/* 读停控状态文件：1=读到有效状态（out 已填）；0=文件缺失（全新设备，
 * 未停控过）；-1=文件存在但损坏／不可解析（调用方按已停控处理）。 */
int lea_local_emergency_stop_read(const char *base_dir, lea_emergency_stop_t *out);

/* 原子写停控状态文件（lea_file_write_atomic；失败返回 0，旧文件不动）。
 * 注意：本函数只写文件，不设 ACL——Windows 服务层写后须调
 * set_stop_file_acl（SY／BA 写＋AU 读），失败即删文件 fail-closed
 * （见 QFRLEA.c；单测环境无 ACL 概念）。 */
int lea_local_emergency_stop_write(const char *base_dir, const lea_emergency_stop_t *s);

/* 快捷判定：1=已停控（文件称 stopped=true，或文件损坏）；0=未停控
 * （文件称 stopped=false，或文件缺失）。服务热路径（4.4 门）用此函数。 */
int lea_local_emergency_stopped(const char *base_dir);

/* 启动对账（fail-closed）：比对标记文件＋已用票据记录＋审计日志尾部。
 * logs_dir 为审计日志目录（含 lea-YYYY-MM-DD.jsonl），可为 NULL（无审计
 * 可对，只比标记与票据记录）。返回：0=一致无动作；1=按审计重建了丢失的
 * 标记（已停控）；2=修补了票据记录状态（标记已清是 ground truth）；
 * -1=出错（调用方按已停控处理＋告警）。审计 clear 事件永不删标记
 * （清除只能由服务端签发的恢复票据执行，大肥鱼 Q1）。 */
int lea_local_emergency_stop_reconcile(const char *base_dir, const char *logs_dir);

/* 已用恢复票据记录 recovery-tickets-used.json（JSONL，每行一票）：
 *   {"ticket_id":"...","stop_event_id":"...","recovery_epoch":N,
 *    "used_at":unix,"status":"consumed_pending_clear|recovered|superseded"}
 * consume：追加 consumed_pending_clear 记录（票据已在记录中即返回 0，
 * 防重放）；mark_recovered：把指定票据状态改写为 recovered；
 * max_epoch：全部记录的最大 recovery_epoch（无记录即 0）；
 * ticket_status：查指定票据，1=找到（status_out 填状态串、
 * recovery_epoch_out 填代次），0=未找到。全部原子写（全量重写文件）。 */
int lea_local_recovery_ticket_consume(const char *base_dir, const char *ticket_id,
                                      const char *stop_event_id, long long recovery_epoch);
int lea_local_recovery_ticket_mark_recovered(const char *base_dir, const char *ticket_id);
long long lea_local_recovery_max_epoch(const char *base_dir);
int lea_local_recovery_ticket_status(const char *base_dir, const char *ticket_id,
                                     char *status_out, size_t status_out_size,
                                     long long *recovery_epoch_out);

/* A7 同款纯函数：恢复判定。标记 stopped 且 stop_event_id 一致，且票据
 * recovery_epoch 严格大于已见最大代次（max_recovery_epoch 与标记的
 * last_recovery_epoch 取大者），且 grant_epoch 不小于标记的 grant_epoch，
 * 且账号／设备与标记一致，才允许清除。binding_epoch 与当前绑定的一致性、
 * 票据签名、有效期由调用方（QFRLEA.c）在此外另验。 */
int lea_emergency_stop_recovery_allowed(const lea_emergency_stop_t *marker,
                                        const lea_recovery_ticket_t *tk,
                                        long long max_recovery_epoch);

/* A7：管道侧改状态命令判定。5 个命令（lea.pause／lea.resume／
 * lea.revoke-all-keys／lea.authorize-dangerous／
 * lea.revoke-dangerous-consent）在 handle_internal 一律拒绝。 */
int lea_internal_state_command(const char *cmd);

/* A7-whitelist：内部命令显式白名单（GPT 问题 2：不批准整体禁用
 * internal 命令面，改为最小白名单＋强身份校验）。只有表内命令可在
 * handle_internal 执行；未知命令默认拒绝＋审计（unknown-internal-cmd）。
 * 5 个 S-021 改状态命令不在表内（入口处 lea_internal_state_command
 * 先以专用 detail 拒绝）。login_changed 的账户身份证明由 A1 线
 * （login_proof，服务端签发）负责，本表只管命令准入、不替它验身份。 */
int lea_internal_whitelist_command(const char *cmd);

/* 状态 JSON 编解码（from：缺失字段留默认，不报错；脏数据返回 0）。 */
int lea_local_status_to_json(const lea_local_status_t *s, char *out, size_t out_size);
int lea_local_status_from_json(const char *text, lea_local_status_t *out);

/* 快照：读 lea-status.json（有则保留其绑定／最近命令字段），再叠加
 * 三个标记文件的实时态。base 解析不出返回 0。 */
int lea_local_status_snapshot(const char *base_dir, lea_local_status_t *out);

/* 写快照：原子写（tmp+rename）。 */
int lea_local_write_status(const char *base_dir, const lea_local_status_t *s);

/* 刷新最近命令并写回：快照 → 更新 last_command／last_result／
 * last_command_at（at<=0 时取当前时间）→ 写盘。绑定字段只取文件
 * 里已有的值，调用方传空不覆盖（CLI 进程无绑定时不清空文件）。 */
int lea_local_refresh_status(const char *base_dir, const char *last_command,
                             const char *last_result, long long at);

/* 本机控制子命令集合（与 lea_install.h 的 lea_is_service_subcommand
 * 扩展项一致，供 QFRLEA.c main() 分流与单测断言“集合封闭”）：
 * --status／--pause／--resume／--revoke-all-keys／
 * --authorize-dangerous／--revoke-dangerous-consent。
 * 注意：集合“识别”不等于 CLI“执行”——v6 裁决后 5 个改状态子命令
 * 仍被集合识别（为分流进 CLI 入口拿明确拒绝），但 lea_local_cli
 * 在入口显式拒绝它们，只有 --status 真正执行。 */
int lea_is_local_control_subcommand(const char *arg);

/* CLI 入口：argv[1] 为上述 6 个子命令之一；base_dir 为 NULL／空时
 * 取默认。结果 JSON 打 stdout；返回 0=成功、1=执行失败、2=用法错误。
 * v6 裁决：--status 只读查询正常执行；5 个改状态子命令一律返回
 * {"ok":false,"error":"unsupported-command"} 且返回 2，不改状态。 */
int lea_local_cli(int argc, char **argv, const char *base_dir);

#ifdef __cplusplus
}
#endif

#endif /* QFRLEA_LOCAL_H */
