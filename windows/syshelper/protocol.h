/* QFSysHelper 协议层（纯 C，无 Windows 依赖，可在 Linux 上单测）。
 * 请求：一行 JSON，两种固定命令，别无其他：
 *   {"cmd":"heal-agent","path":"<qf-agent-heal.ps1 绝对路径>"}
 *   {"cmd":"install-lock","owner":"<登录账号>","path":"<Lock\\install.ps1 绝对路径>"}
 * path 只是定位符：服务端执行前必算 SHA-256 对白名单，hash 不对绝不执行，
 * 且 basename 必须与命令对应（heal-agent↔qf-agent-heal.ps1，
 * install-lock↔install.ps1），路径中不得含 ".."。
 * Owner：1–64 字符，只许字母/数字/_/@/./- 与 CJK（UTF-8 多字节按原样放行，
 * 但 ASCII 元字符一律拒绝）。
 */
#ifndef QFSYSHELPER_PROTOCOL_H
#define QFSYSHELPER_PROTOCOL_H

#define QF_CMD_HEAL "heal-agent"
#define QF_CMD_INSTALL_LOCK "install-lock"
#define QF_MAX_REQUEST 4096

typedef struct {
    int valid;          /* 1=解析通过 */
    int cmd;            /* 0=heal-agent, 1=install-lock */
    char owner[65];     /* install-lock 时有效 */
    char path[512];     /* 脚本绝对路径 */
    char error[64];     /* valid=0 时的错误码 */
} qf_request_t;

int qf_validate_owner(const char *owner);
int qf_parse_request(const char *text, qf_request_t *out);
const char *qf_expected_basename(int cmd);

#endif
