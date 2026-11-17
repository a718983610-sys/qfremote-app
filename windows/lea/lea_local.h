/* lea_local.h — LEA 本机控制状态（S-021，2026-11-15）
 * =================================================================
 * 设备本机 LEA 状态入口：暂停／危险授权／一键撤销／状态查询。
 * 纯 C，无 Windows 依赖，可在 Linux 单测里跑（见 test/test_lea.c 的
 * S-021 组）；QFRLEA.c（Windows 服务）与 QFRLEA.exe CLI 共用。
 *
 * 状态文件（全部落在 %ProgramData%\QFR\LEA 下，即 base_dir）：
 *   lea-paused            存在即已暂停（内容为暂停时刻 unix 秒）
 *   dangerous-consent.json {"consented":bool,"at":unix}（危险 scope 本机授权）
 *   revoke-all.json        {"revoked":true,"at":unix}（一键撤销所有 Key）
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
 *     且绝不改状态。底层状态读写函数与管道侧 handle_internal 的
 *     改状态命令不受影响；识别集合仍含这 5 个名字，只为让它们进到
 *     CLI 入口拿明确的拒绝错误，而不是落到 main() 的服务启动分支。
 *   - 状态 JSON 只含账号／设备／命令名／结果码／时间戳，不含 Key、
 *     票据、签名等秘密。
 */
#ifndef QFRLEA_LOCAL_H
#define QFRLEA_LOCAL_H

#include <stddef.h>

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
 * clear 删文件（登录换号时清除，见 QFRLEA.c session.login_changed）。 */
int lea_local_has_revoke_all(const char *base_dir);
int lea_local_set_revoke_all(const char *base_dir, int revoked);
int lea_local_clear_revoke_all(const char *base_dir);

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
