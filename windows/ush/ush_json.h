/* ush_json.h — USH 纯逻辑协议层（无 Windows 依赖，可在 Linux 上单测）。
 *
 * 职责：解析 LEA 转来的一行 JSON 请求、取字段、转义/构造响应 JSON、
 * Base64、点击重试间隔、定位策略顺序。Windows 相关（UIA/管道/截图/
 * 日志落盘）一律不在此文件。
 *
 * 请求（LEA 已校验签名与准入后转来；USH 只信 LEA，不做准入）：
 *   {"version":1,"request_id":"<uuid>","trace_id":"...","batch_id":"...",
 *    "seq":1,"device_id":"...","account_id":"...","command":"ui.click",
 *    "params":{...},"timeout_ms":5000,"idempotency_key":"...",
 *    "dangerous":false}
 * 响应（一行 JSON）：
 *   {"ok":true,"code":"done","request_id":"...","duration_ms":12,"data":{...}}
 *   {"ok":false,"code":"QFR_USH_ELEMENT_NOT_FOUND","request_id":"...",
 *    "duration_ms":12,"error":"..."}
 */
#ifndef QFR_USH_JSON_H
#define QFR_USH_JSON_H

#include <stddef.h>

#define USH_MAX_REQUEST 65536
#define USH_MAX_PARAMS 32768
#define USH_MAX_RESPONSE (16 * 1024 * 1024) /* 内联截图上限 16MB 一行响应 */
#define USH_DEFAULT_TIMEOUT_MS 5000
#define USH_MAX_TIMEOUT_MS 300000

/* USH 命令枚举 */
#define USH_CMD_PING 0
#define USH_CMD_CLICK 1
#define USH_CMD_INPUT 2
#define USH_CMD_SNAPSHOT 3
#define USH_CMD_TREE 4
/* C1：自助绑定（桌面一键链接本机助手）。这四条不做 UI、不进会话门
 * （锁屏也能链接／吊销／续期），但仍须过 H03 token 门（LEA 来路）。
 * 凭据明文只进 USH 内存＋DPAPI 文件，永不经 QFRLEA／主进程。 */
#define USH_CMD_SELFBIND 5          /* selfbind.deliver-ticket：签名调 complete 换凭据 */
#define USH_CMD_SELFBIND_CLEAR 6    /* selfbind.clear-credential：删本机凭据＋元数据 */
#define USH_CMD_SELFBIND_STATUS 7   /* selfbind.status：读元数据报链接态（不含凭据） */
#define USH_CMD_SELFBIND_RENEW 8    /* selfbind.renew：静默续期（Bearer Key＋设备签名） */

/* 错误码（与 DESIGN.md §4.5 同前缀风格；LEA 侧按 code 透传） */
#define USH_ERR_BAD_REQUEST "bad-request"
#define USH_ERR_UNKNOWN_COMMAND "unknown-command"
#define USH_ERR_UNAUTHORIZED "QFR_USH_UNAUTHORIZED" /* H03：LEA→USH token 缺失／不匹配 */
#define USH_ERR_CALLER_NOT_ALLOWED "QFR_USH_CALLER_NOT_ALLOWED" /* H03：管道调用方不是已安装的 QFRLEA.exe／QFUserHelper.exe */
#define USH_ERR_SESSION_LOCKED "QFR_USH_SESSION_LOCKED"
#define USH_ERR_NO_SESSION "QFR_USH_NO_INTERACTIVE_SESSION"
#define USH_ERR_NOT_FOUND "QFR_USH_ELEMENT_NOT_FOUND"
#define USH_ERR_NOT_CONFIRMED "QFR_USH_NOT_CONFIRMED"
#define USH_ERR_TIMEOUT "QFR_USH_TIMEOUT"
#define USH_ERR_NOT_SUPPORTED "QFR_USH_UNSUPPORTED"
#define USH_ERR_FAILED "QFR_USH_FAILED"
#define USH_ERR_TOO_LARGE "QFR_USH_SNAPSHOT_TOO_LARGE"
/* C1 自助绑定错误码（LEA 侧按 code 透传；明文凭据永不进 error 文本） */
#define USH_ERR_SELFBIND_NO_KEY "QFR_USH_SELFBIND_NO_KEY"             /* 本机无凭据（未链接／已清除） */
#define USH_ERR_SELFBIND_BAD_TICKET "QFR_USH_SELFBIND_BAD_TICKET"     /* 票据字段缺失／非法 */
#define USH_ERR_SELFBIND_SERVER "QFR_USH_SELFBIND_SERVER"             /* 服务端拒绝（complete/renew 非 200） */
#define USH_ERR_SELFBIND_NETWORK "QFR_USH_SELFBIND_NETWORK"           /* 连不上服务端 */
#define USH_ERR_SELFBIND_KEYSTORE "QFR_USH_SELFBIND_KEYSTORE"         /* 设备密钥库（CNG）失败 */
#define USH_ERR_SELFBIND_STORE "QFR_USH_SELFBIND_STORE"               /* 凭据存取（DPAPI）失败 */

typedef struct {
    int valid;               /* 1=解析通过 */
    int cmd;                 /* USH_CMD_* */
    char command[32];        /* 原始命令名，如 "ui.click" */
    char request_id[64];
    char trace_id[64];
    char batch_id[64];
    char idempotency_key[64];
    char account_id[64];
    char device_id[128];
    char api_key_id[32];     /* 仅记 key_id，不记明文（LEA 不传明文） */
    long binding_epoch;
    char nonce[64];
    long long seq;
    long timeout_ms;         /* 已夹取到 [1, USH_MAX_TIMEOUT_MS]，缺省 5000 */
    int dangerous;           /* 1=危险按钮：禁止自动重试 */
    char params_json[USH_MAX_PARAMS]; /* params 对象原文（含花括号），可能为空对象 */
    char ush_token[128];     /* H03：LEA 转发的每启动随机 token（LEA 读 USH
                              * 启动时写的 token 文件后随信封带来）；USH 验
                              * token，不匹配即拒绝（ui.ping 自探活除外）。 */
    char error[64];          /* valid=0 时的错误码 */
} ush_request_t;

/* ---------- JSON 取值（只读，不改原串；key 只匹配当前对象顶层字段） ---------- */
/* 取字符串字段：完整支持 \" \\ \/ \b \f \n \r \t \uXXXX（含代理对转 UTF-8）。
 * 找不到字段返回 0；字段存在但值不是字符串、转义非法或放不下返回 0。 */
int ush_json_get_string(const char *json, const char *key, char *out, size_t out_size);
/* 取整数 / 布尔字段；找不到或类型不对返回 0。 */
int ush_json_get_long(const char *json, const char *key, long *out);
int ush_json_get_bool(const char *json, const char *key, int *out);
/* 取 64 位整数字段（C1：expires_at 是毫秒时间戳，约 1.8e12，Windows
 * long 只有 32 位，strtol 会截断／钳制，必须走 strtoll）。 */
int ush_json_get_llong(const char *json, const char *key, long long *out);
/* #11：取 JSON 数字字段（如 rel_x:0.5）；字符串形式（"0.5"）不认，
 * 调用方另用 ush_json_get_string 兼容。值后须为 , } 空白或串尾，
 * 否则 0.5x 之类非法尾巴一律拒绝；inf/nan 不接受。 */
int ush_json_get_double(const char *json, const char *key, double *out);
/* 取子对象原文（含花括号），如 "target":{...} / "params":{...}；找不到返回 0。 */
int ush_json_get_object(const char *json, const char *key, char *out, size_t out_size);

/* JSON 字符串转义（" \ 与控制字符转 \u00XX）；放不下返回 0。 */
int ush_json_escape(const char *in, char *out, size_t out_size);

/* 解析一行请求；失败时 out->error 为错误码，valid=0。 */
int ush_parse_request(const char *text, ush_request_t *out);

/* H03：LEA→USH token 比对。expected 与 provided 都须非空且等长、逐字节
 * 相等（定长比对，不因首字节不同提前返回）；任一为空、长度不等、
 * 内容不等一律返回 0。 */
int ush_token_matches(const char *expected, const char *provided);

/* 构造一行响应。data_json 为已构造好的 JSON 片段（对象原文或 NULL）。
 * 成功：{"ok":true,"code":"done","request_id":"...","duration_ms":N,"data":{...}}
 * 失败：{"ok":false,"code":"<code>","request_id":"...","duration_ms":N,"error":"..."}
 * 放不下返回 0。 */
int ush_build_response(char *out, size_t out_size, int ok, const char *code,
                       const char *request_id, long duration_ms,
                       const char *data_json, const char *error_text);

/* ---------- Base64（标准字母表，带 = 填充） ---------- */
int ush_base64_encode(const unsigned char *in, size_t len, char *out, size_t out_size);
int ush_base64_decode(const char *in, unsigned char *out, size_t out_size, size_t *out_len);

/* ---------- 点击重试（DESIGN.md §5.1：普通点击最多 2 次重试） ---------- */
/* attempt: 0=第1次重试 → 200ms；1=第2次重试 → 500ms；>=2 → -1（不许再试）。
 * dangerous=1 时一律返回 -1（危险按钮不自动重试）。 */
int ush_click_retry_delay_ms(int dangerous, int attempt);

/* ---------- 定位策略顺序（DESIGN.md §5.1） ---------- */
/* 0=AutomationId, 1=Name+ControlType, 2=ClassName+Index, 3=窗口内相对坐标，
 * 4=图像模板（MVP 未实现：遇此策略返回 USH_ERR_NOT_SUPPORTED）。 */
int ush_locator_strategy_count(void);
const char *ush_locator_strategy_name(int index);

#endif /* QFR_USH_JSON_H */
